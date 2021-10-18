前言：Buffer 模块是 Node.js 非常重要的模块，很多模块都依赖它，本文介绍一下 Buffer 模块底层的原理，包括 Buffer 的核心实现和 V8 堆外内存等内容。

# 1 Buffer 的实现
## 1.1 Buffer 的 JS 层实现
Buffer 模块的实现虽然非常复杂，代码也非常多，但是很多都是编码解码以及内存分配管理的逻辑，我们从常用的使用方式 Buffer.from 来看看 Buffer 的核心实现。
```c
Buffer.from = function from(value, encodingOrOffset, length) {
  return fromString(value, encodingOrOffset);
};

function fromString(string, encoding) {
  return fromStringFast(string, ops);
}

function fromStringFast(string, ops) {
  const length = ops.byteLength(string);
  // 长度太长，从 C++ 层分配
  if (length >= (Buffer.poolSize >>> 1))
    return createFromString(string, ops.encodingVal);
  // 剩下的不够了，扩容 
  if (length > (poolSize - poolOffset))
    createPool();
  // 从 allocPool （ArrayBuffer）中分配内存
  let b = new FastBuffer(allocPool, poolOffset, length);
  const actual = ops.write(b, string, 0, length);
  poolOffset += actual;
  alignPool();
  return b;
}
```
from 的逻辑如下：
1. 如果长度大于 Node.js 设置的阈值，则调用 createFromString 通过 C++ 层直接分配内存。
2. 否则判断之前剩下的内存是否足够，足够则直接分配。Node.js 初始化时会首先分配一大块内存由 JS 管理，每次从这块内存了切分一部分给使用方，如果不够则扩容。
我们看看 createPool。
```c
// 分配一个内存池
function createPool() {
  poolSize = Buffer.poolSize;
  // 拿到底层的 ArrayBuffer
  allocPool = createUnsafeBuffer(poolSize).buffer;
  poolOffset = 0;
}

function createUnsafeBuffer(size) {
  zeroFill[0] = 0;
  try {
    return new FastBuffer(size);
  } finally {
    zeroFill[0] = 1;
  }
}

class FastBuffer extends Uint8Array {}
```
我们看到最终调用 Uint8Array 实现了内存分配。
3. 通过 new FastBuffer(allocPool, poolOffset, length) 从内存池中分配一块内存。如下图所示。
![](https://img-blog.csdnimg.cn/926ba056c76f417d8a515dfbbe4bfe36.png)
## 1.2 Buffer 的 C++ 层实现
分析 C++ 层之前我们先看一下 V8 里下面几个对象的关系图。
![在这里插入图片描述](https://img-blog.csdnimg.cn/a50fdf50695b453e94fbba2a86802cd7.png)接着来看看通过 createFromString 直接从 C++ 申请内存的实现。
```c
void CreateFromString(const FunctionCallbackInfo<Value>& args) {
  enum encoding enc = static_cast<enum encoding>(args[1].As<Int32>()->Value());
  Local<Object> buf;
  if (New(args.GetIsolate(), args[0].As<String>(), enc).ToLocal(&buf))
    args.GetReturnValue().Set(buf);
}

MaybeLocal<Object> New(Isolate* isolate,
                       Local<String> string,
                       enum encoding enc) {
  EscapableHandleScope scope(isolate);

  size_t length;
  // 计算长度
  if (!StringBytes::Size(isolate, string, enc).To(&length))
    return Local<Object>();
  size_t actual = 0;
  char* data = nullptr;
  // 直接通过 realloc 在进程堆上申请一块内存
  data = UncheckedMalloc(length);
  // 按照编码转换数据
  actual = StringBytes::Write(isolate, data, length, string, enc);
  return scope.EscapeMaybe(New(isolate, data, actual));
}

MaybeLocal<Object> New(Isolate* isolate, char* data, size_t length) {
  EscapableHandleScope handle_scope(isolate);
  Environment* env = Environment::GetCurrent(isolate);
  Local<Object> obj;
  if (Buffer::New(env, data, length).ToLocal(&obj))
    return handle_scope.Escape(obj);
  return Local<Object>();
}

MaybeLocal<Object> New(Environment* env,
                       char* data,
                       size_t length) {
  // JS 层变量释放后使得这块内存没人用了，GC 时在回调里释放这块内存               
  auto free_callback = [](char* data, void* hint) { free(data); };
  return New(env, data, length, free_callback, nullptr);
}

MaybeLocal<Object> New(Environment* env,
                       char* data,
                       size_t length,
                       FreeCallback callback,
                       void* hint) {
  EscapableHandleScope scope(env->isolate());
  // 创建一个 ArrayBuffer
  Local<ArrayBuffer> ab =
      CallbackInfo::CreateTrackedArrayBuffer(env, data, length, callback, hint);
  /* 
  	创建一个 Uint8Array 
  	Buffer::New => Local<Uint8Array> ui = Uint8Array::New(ab, byte_offset, length)
  */
  MaybeLocal<Uint8Array> maybe_ui = Buffer::New(env, ab, 0, length);

  Local<Uint8Array> ui;
  if (!maybe_ui.ToLocal(&ui))
    return MaybeLocal<Object>();

  return scope.Escape(ui);
}
```
通过一系列的调用，最后通过 CreateTrackedArrayBuffer 创建了一个 ArrayBuffer，再通过 ArrayBuffer 创建了一个 Uint8Array。接着看一下 CreateTrackedArrayBuffer 的实现。
```c
Local<ArrayBuffer> CallbackInfo::CreateTrackedArrayBuffer(
    Environment* env,
    char* data,
    size_t length,
    FreeCallback callback,
    void* hint) {
  // 管理回调
  CallbackInfo* self = new CallbackInfo(env, callback, data, hint);
  // 用自己申请的内存创建一个 BackingStore，并设置 GC 回调
  std::unique_ptr<BackingStore> bs =
      ArrayBuffer::NewBackingStore(data, length, [](void*, size_t, void* arg) {
        static_cast<CallbackInfo*>(arg)->OnBackingStoreFree();
      }, self);
  // 通过 BackingStore 创建 ArrayBuffer
  Local<ArrayBuffer> ab = ArrayBuffer::New(env->isolate(), std::move(bs));
  return ab;
}
```
看一下 NewBackingStore 的实现。
```c
std::unique_ptr<v8::BackingStore> v8::ArrayBuffer::NewBackingStore(
    void* data, size_t byte_length, v8::BackingStore::DeleterCallback deleter,
    void* deleter_data) {
  std::unique_ptr<i::BackingStoreBase> backing_store = i::BackingStore::WrapAllocation(data, byte_length, deleter, deleter_data,
                                      i::SharedFlag::kNotShared);
  return std::unique_ptr<v8::BackingStore>(
      static_cast<v8::BackingStore*>(backing_store.release()));
}

std::unique_ptr<BackingStore> BackingStore::WrapAllocation(
    void* allocation_base, size_t allocation_length,
    v8::BackingStore::DeleterCallback deleter, void* deleter_data,
    SharedFlag shared) {
  bool is_empty_deleter = (deleter == v8::BackingStore::EmptyDeleter);
  // 新建一个 BackingStore 
  auto result = new BackingStore(allocation_base,    // start
                                 allocation_length,  // length
                                 allocation_length,  // capacity
                                 shared,             // shared
                                 false,              // is_wasm_memory
                                 true,               // free_on_destruct
                                 false,              // has_guard_regions
                                 // 说明释放内存由调用方执行
                                 true,               // custom_deleter
                                 is_empty_deleter);  // empty_deleter
  // 保存回调需要的信息                               
  result->type_specific_data_.deleter = {deleter, deleter_data};
  return std::unique_ptr<BackingStore>(result);
}
```
NewBackingStore 最终是创建了一个 BackingStore 对象。我们再看一下 GC 时 BackingStore 的析构函数里都做了什么。
```c
BackingStore::~BackingStore() {
  if (custom_deleter_) {
    type_specific_data_.deleter.callback(buffer_start_, byte_length_,
                                         type_specific_data_.deleter.data);
    Clear();
    return;
  }
}
```
析构的时候会执行创建 BackingStore 时保存的回调。我们看一下管理回调的 CallbackInfo 的实现。
```c
CallbackInfo::CallbackInfo(Environment* env,
                           FreeCallback callback,
                           char* data,
                           void* hint)
    : callback_(callback),
      data_(data),
      hint_(hint),
      env_(env) {
  env->AddCleanupHook(CleanupHook, this);
  env->isolate()->AdjustAmountOfExternalAllocatedMemory(sizeof(*this));
}
```
CallbackInfo 的实现很简单，主要的地方是 AdjustAmountOfExternalAllocatedMemory。该函数告诉 V8 堆外内存增加了多少个字节，V8 会根据内存的数据做适当的 GC。CallbackInfo 主要是保存了回调和内存地址。接着在 GC 的时候会回调 CallbackInfo 的 OnBackingStoreFree。
```c
void CallbackInfo::OnBackingStoreFree() {
  std::unique_ptr<CallbackInfo> self { this };
  Mutex::ScopedLock lock(mutex_);
  // check 阶段执行 CallAndResetCallback
  env_->SetImmediateThreadsafe([self = std::move(self)](Environment* env) {
    self->CallAndResetCallback();
  });
}

void CallbackInfo::CallAndResetCallback() {
  FreeCallback callback;
  {
    Mutex::ScopedLock lock(mutex_);
    callback = callback_;
    callback_ = nullptr;
  }
  if (callback != nullptr) {
  	// 堆外内存减少了这么多个字节
    int64_t change_in_bytes = -static_cast<int64_t>(sizeof(*this));
    env_->isolate()->AdjustAmountOfExternalAllocatedMemory(change_in_bytes);
	// 执行回调，通常是释放内存
    callback(data_, hint_);
  }
}
```
## 1.3 Buffer C++ 层的另一种实现
刚才介绍的 C++ 实现中内存是由自己分配并释放的，下面介绍另一种内存的分配和释放由 V8 管理的场景。以 Buffer 的提供的 EncodeUtf8String 函数为例，该函数实现字符串的编码。
```c
static void EncodeUtf8String(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  Isolate* isolate = env->isolate();
  // 被编码的字符串
  Local<String> str = args[0].As<String>();
  size_t length = str->Utf8Length(isolate);
  // 分配内存
  AllocatedBuffer buf = AllocatedBuffer::AllocateManaged(env, length);
  // 编码
  str->WriteUtf8(isolate,
                 buf.data(),
                 -1,  // We are certain that `data` is sufficiently large
                 nullptr,
                 String::NO_NULL_TERMINATION | String::REPLACE_INVALID_UTF8);
  // 基于上面申请的 buf 内存新建一个 Uint8Array              
  auto array = Uint8Array::New(buf.ToArrayBuffer(), 0, length);
  args.GetReturnValue().Set(array);
}
```
我们重点分析 AllocatedBuffer::AllocateManaged。
```c
AllocatedBuffer AllocatedBuffer::AllocateManaged(
    Environment* env,
    size_t size) {
  NoArrayBufferZeroFillScope no_zero_fill_scope(env->isolate_data());
  std::unique_ptr<v8::BackingStore> bs = v8::ArrayBuffer::NewBackingStore(env->isolate(), size);
  return AllocatedBuffer(env, std::move(bs));
}
```
AllocateManaged 调用 NewBackingStore 申请了内存。
```c
std::unique_ptr<v8::BackingStore> v8::ArrayBuffer::NewBackingStore(
    Isolate* isolate, size_t byte_length) {
    
  i::Isolate* i_isolate = reinterpret_cast<i::Isolate*>(isolate);
  std::unique_ptr<i::BackingStoreBase> backing_store =
      i::BackingStore::Allocate(i_isolate, byte_length,
                                i::SharedFlag::kNotShared,
                                i::InitializedFlag::kZeroInitialized);
                                
  return std::unique_ptr<v8::BackingStore>(
      static_cast<v8::BackingStore*>(backing_store.release()));
}
```
继续看 BackingStore::Allocate。
```c
std::unique_ptr<BackingStore> BackingStore::Allocate(
    Isolate* isolate, size_t byte_length, SharedFlag shared,
    InitializedFlag initialized) {
  void* buffer_start = nullptr;
  // ArrayBuffer 内存分配器，可以自定义，V8 默认提供的是使用平台相关的堆内存分析函数，比如 malloc
  auto allocator = isolate->array_buffer_allocator();
  if (byte_length != 0) {
    auto allocate_buffer = [allocator, initialized](size_t byte_length) {
      // 分配内存
      void* buffer_start = allocator->Allocate(byte_length);
      return buffer_start;
    };
	// 同步执行 allocate_buffer 分配内存
    buffer_start = isolate->heap()->AllocateExternalBackingStore(allocate_buffer, byte_length);
  }
  // 新建 BackingStore 管理内存
  auto result = new BackingStore(buffer_start,  // start
                                 byte_length,   // length
                                 byte_length,   // capacity
                                 shared,        // shared
                                 false,         // is_wasm_memory
                                 true,          // free_on_destruct
                                 false,         // has_guard_regions
                                 false,         // custom_deleter
                                 false);        // empty_deleter

  return std::unique_ptr<BackingStore>(result);
}

```
BackingStore::Allocate 分配一块内存并新建 BackingStore 对象管理这块内存，内存分配器是在初始化 V8 的时候设置的。这里我们再看一下 AllocateExternalBackingStore 函数的逻辑。
```c
void* Heap::AllocateExternalBackingStore(
    const std::function<void*(size_t)>& allocate, size_t byte_length) {
   // 可能需要触发 GC
   if (!always_allocate()) {
    size_t new_space_backing_store_bytes =
        new_space()->ExternalBackingStoreBytes();
    if (new_space_backing_store_bytes >= 2 * kMaxSemiSpaceSize &&
        new_space_backing_store_bytes >= byte_length) {
      CollectGarbage(NEW_SPACE,
                     GarbageCollectionReason::kExternalMemoryPressure);
    }
  }
  // 分配内存
  void* result = allocate(byte_length);
  // 成功则返回
  if (result) return result;
  // 失败则进行 GC
  if (!always_allocate()) {
    for (int i = 0; i < 2; i++) {
      CollectGarbage(OLD_SPACE,
                     GarbageCollectionReason::kExternalMemoryPressure);
      result = allocate(byte_length);
      if (result) return result;
    }
    isolate()->counters()->gc_last_resort_from_handles()->Increment();
    CollectAllAvailableGarbage(
        GarbageCollectionReason::kExternalMemoryPressure);
  }
  // 再次分配，失败则返回失败
  return allocate(byte_length);
}
```
我们看到通过 BackingStore 申请内存失败时会触发 GC 来腾出更多的可用内存。分配完内存后，最终以 BackingStore 对象为参数，返回一个 AllocatedBuffer 对象。
```c
AllocatedBuffer::AllocatedBuffer(
    Environment* env, std::unique_ptr<v8::BackingStore> bs)
    : env_(env), backing_store_(std::move(bs)) {}
```
接着把 AllocatedBuffer 对象转成 ArrayBuffer 对象。
```c
v8::Local<v8::ArrayBuffer> AllocatedBuffer::ToArrayBuffer() {
  return v8::ArrayBuffer::New(env_->isolate(), std::move(backing_store_));
}
```
最后把 ArrayBuffer 对象传入 Uint8Array 返回一个 Uint8Array 对象返回给调用方。
# 2 Uint8Array 的使用和实现
从前面的实现中可以看到 C++ 层的实现中，内存都是从进程的堆中分配的，那么 JS 层通过 Uint8Array 申请的内存是否也是在进程堆中申请的呢？下面我们看看 V8 中 Uint8Array 的实现。Uint8Array 有多种创建方式，我们只看 new Uint8Array(length) 的实现。
```c
transitioning macro ConstructByLength(implicit context: Context)(
    map: Map, lengthObj: JSAny,
    elementsInfo: typed_array::TypedArrayElementsInfo): JSTypedArray {
  try {
  	// 申请的内存大小
    const length: uintptr = ToIndex(lengthObj);
    // 拿到创建 ArrayBuffer 的函数
    const defaultConstructor: Constructor = GetArrayBufferFunction();
    const initialize: constexpr bool = true;
    return TypedArrayInitialize(
        initialize, map, length, elementsInfo, defaultConstructor)
        otherwise RangeError;
  }
}

transitioning macro TypedArrayInitialize(implicit context: Context)(
    initialize: constexpr bool, map: Map, length: uintptr,
    elementsInfo: typed_array::TypedArrayElementsInfo,
    bufferConstructor: JSReceiver): JSTypedArray labels IfRangeError {
    
  const byteLength = elementsInfo.CalculateByteLength(length);
  const byteLengthNum = Convert<Number>(byteLength);
  const defaultConstructor = GetArrayBufferFunction();
  const byteOffset: uintptr = 0;

  try {
    // 创建 JSArrayBuffer
    const buffer = AllocateEmptyOnHeapBuffer(byteLength);
    const isOnHeap: constexpr bool = true;
    // 通过 buffer 创建 TypedArray
    const typedArray = AllocateTypedArray(
        isOnHeap, map, buffer, byteOffset, byteLength, length);
	// 内存置 0
    if constexpr (initialize) {
      const backingStore = typedArray.data_ptr;
      typed_array::CallCMemset(backingStore, 0, byteLength);
    }

    return typedArray;
  }
}
```
主要逻辑分为两步，首先通过 AllocateEmptyOnHeapBuffer 申请一个 JSArrayBuffer，然后以 JSArrayBuffer 创建一个 TypedArray。我们先看一下 AllocateEmptyOnHeapBuffer。
```c
TNode<JSArrayBuffer> TypedArrayBuiltinsAssembler::AllocateEmptyOnHeapBuffer(
    TNode<Context> context, TNode<UintPtrT> byte_length) {
    
  TNode<NativeContext> native_context = LoadNativeContext(context);
  TNode<Map> map = CAST(LoadContextElement(native_context, Context::ARRAY_BUFFER_MAP_INDEX));
  TNode<FixedArray> empty_fixed_array = EmptyFixedArrayConstant();
  // 申请一个 JSArrayBuffer 对象所需要的内存
  TNode<JSArrayBuffer> buffer = UncheckedCast<JSArrayBuffer>(Allocate(JSArrayBuffer::kSizeWithEmbedderFields));
  // 初始化对象的属性
  StoreMapNoWriteBarrier(buffer, map);
  StoreObjectFieldNoWriteBarrier(buffer, JSArray::kPropertiesOrHashOffset, empty_fixed_array);
  StoreObjectFieldNoWriteBarrier(buffer, JSArray::kElementsOffset, empty_fixed_array);
  int32_t bitfield_value = (1 << JSArrayBuffer::IsExternalBit::kShift) |
                           (1 << JSArrayBuffer::IsDetachableBit::kShift);
  StoreObjectFieldNoWriteBarrier(buffer, JSArrayBuffer::kBitFieldOffset, Int32Constant(bitfield_value));
  StoreObjectFieldNoWriteBarrier(buffer, JSArrayBuffer::kByteLengthOffset, byte_length);
  // 设置 buffer 为 nullptr                               
  StoreJSArrayBufferBackingStore(buffer, EncodeExternalPointer(ReinterpretCast<RawPtrT>(IntPtrConstant(0))));
  StoreObjectFieldNoWriteBarrier(buffer, JSArrayBuffer::kExtensionOffset, IntPtrConstant(0));
  for (int offset = JSArrayBuffer::kHeaderSize; offset < JSArrayBuffer::kSizeWithEmbedderFields; offset += kTaggedSize) {
    StoreObjectFieldNoWriteBarrier(buffer, offset, SmiConstant(0));
  }
  return buffer;
}
```
AllocateEmptyOnHeapBuffer 申请了一个空的 JSArrayBuffer 对象，空的意思是说没有存储数据的内存。接着看基于 JSArrayBuffer 对象 通过 AllocateTypedArray 创建一个 TypedArray。
```c
transitioning macro AllocateTypedArray(implicit context: Context)(
    isOnHeap: constexpr bool, map: Map, buffer: JSArrayBuffer,
    byteOffset: uintptr, byteLength: uintptr, length: uintptr): JSTypedArray {
  // 从 V8 堆中申请存储数据的内存
  let elements: ByteArray = AllocateByteArray(byteLength);
  // 申请一个 JSTypedArray 对象
  const typedArray = UnsafeCast<JSTypedArray>(AllocateFastOrSlowJSObjectFromMap(map));
  // 初始化属性
  typedArray.elements = elements;
  typedArray.buffer = buffer;
  typedArray.byte_offset = byteOffset;
  typedArray.byte_length = byteLength;
  typedArray.length = length;
  typed_array::SetJSTypedArrayOnHeapDataPtr(typedArray, elements, byteOffset);
  SetupTypedArrayEmbedderFields(typedArray);
  return typedArray;
}
```
我们发现 Uint8Array 申请的内存是基于 V8 堆的，而不是 V8 的堆外内存，这难道和 C++ 层的实现不一样？Uint8Array 的内存的确是基于 V8 堆的，比如我像下面这样使用的时候。
```c
const arr = new Uint8Array(1);
arr[0] = 65;
```
但是如果我们使用 arr.buffer 的时候，情况就不一样了。我们看看具体的实现。
```c
BUILTIN(TypedArrayPrototypeBuffer) {
  HandleScope scope(isolate);
  CHECK_RECEIVER(JSTypedArray, typed_array,
                 "get %TypedArray%.prototype.buffer");
  return *typed_array->GetBuffer();
}
```
接着看 GetBuffer 的实现。
```c
Handle<JSArrayBuffer> JSTypedArray::GetBuffer() {
  Isolate* isolate = GetIsolate();
  Handle<JSTypedArray> self(*this, isolate);
  // 拿到 TypeArray 对应的 JSArrayBuffer 对象
  Handle<JSArrayBuffer> array_buffer(JSArrayBuffer::cast(self->buffer()), isolate);
  // 分配过了直接返回
  if (!is_on_heap()) {
   return array_buffer;
  }
  size_t byte_length = self->byte_length();
  // 申请 byte_length 字节内存存储数据
  auto backing_store = BackingStore::Allocate(isolate, byte_length, SharedFlag::kNotShared, InitializedFlag::kUninitialized);
  // 关联 backing_store 到 array_buffer
  array_buffer->Setup(SharedFlag::kNotShared, std::move(backing_store));
  return array_buffer;
}
```
我们看到当使用 buffer 的时候，V8 会在 V8 堆外申请内存来替代初始化 Uint8Array 时在 V8 堆内分配的内存，并且把原来的数据复制过来。看一下下面的例子。
```c
console.log(process.memoryUsage().arrayBuffers)
let a = new Uint8Array(10);
a[0] = 65;
console.log(process.memoryUsage().arrayBuffers)
```
我们会发现 arrayBuffers 的值是一样的，说明 Uint8Array 初始化时没有通过 arrayBuffers 申请堆外内存。接着再看下一个例子。
```c
console.log(process.memoryUsage().arrayBuffers)
let a = new Uint8Array(1);
a[0] = 65;
a.buffer
console.log(process.memoryUsage().arrayBuffers)
console.log(new Uint8Array(a.buffer))
```
我们看到输出的内存增加了一个字节，输出的 a.buffer 是 [ 65 ]（申请内存大于 64 字节会在堆外内存分配）。
# 3 堆外内存的管理
从之前的分析中我们看到，Node.js Buffer 是基于堆外内存实现的（自己申请进程堆内存或者使用 V8 默认的内存分配器），我们知道，平时使用的变量都是由 V8 负责管理内存的，那么 Buffer 所代表的堆外内存是怎么管理的呢？Buffer 的内存释放也是由 V8 跟踪的，不过释放的逻辑和堆内内存不太一样。我们通过一些例子来分析一下。
```c
function forceGC() {
    new ArrayBuffer(1024 * 1024 * 1024);
}
setTimeout(() => {
	/*
		从 C++ 层调用 V8 对象创建内存
		let a = process.binding('buffer').createFromString("你好", 1);
	*/ 
	/*
		直接使用 V8 内置对象
		let a = new ArrayBuffer(10);
	*/
	// 从 C++ 层自己管理内存
	let a = process.binding('buffer').encodeUtf8String("你好");
	// 置空等待 GC
	a = null;
	// 分配一块大内存触发 GC
	process.nextTick(forceGC);
}, 1000);
const net = require('net');
net.createServer((socket) => {}).listen()
```
在 V8 的代码打断点，然后调试以上代码。
![](https://img-blog.csdnimg.cn/325620e7d4764644a11fe23d514fecf3.png)
我们看到在超时回调里 V8 分配了一个 ArrayBufferExtension 对象并记录到 ArrayBufferSweeper 中。 接着看一下触发 GC 时的逻辑。
![](https://img-blog.csdnimg.cn/0a66808e50c94fd9a322cc8b2597a780.png?x-oss-process=image/watermark,type_ZHJvaWRzYW5zZmFsbGJhY2s,shadow_50,text_Q1NETiBAdGhlYW5hcmto,size_20,color_FFFFFF,t_70,g_se,x_16)
![](https://img-blog.csdnimg.cn/1e43fda36dc94892832758693bc761f4.png?x-oss-process=image/watermark,type_ZHJvaWRzYW5zZmFsbGJhY2s,shadow_50,text_Q1NETiBAdGhlYW5hcmto,size_20,color_FFFFFF,t_70,g_se,x_16)
V8 在 GC 中会调用 heap_->array_buffer_sweeper()->RequestSweepYoung() 回收堆外内存，另外 Node.js 本身似乎也使用线程去回收 堆外内存。我们再看一下自己管理内存的情况下回调的触发。
![](https://img-blog.csdnimg.cn/f0e63e78f0fe4ec7abdb50bf32c60997.png)
如果这样写是不会触发 BackingStore::~BackingStore 执行的，再次验证了 Uint8Array 初始化时没有使用 BackingStore。
```c
setTimeout(() => {
   let a = new Uint8Array(1);
   // a.buffer;
   a = null;
   process.nextTick(forceGC);
});
```
但是如果把注释打开就可以。

# 4 总结
Buffer 平时用起来可能比较简单，但是如果深入研究它的实现就会发现涉及的内容不仅多，而且还复杂，不过深入理解了它的底层实现后，会有种豁然开朗的感觉，另外 Buffer 的内存是堆外内存，如果我们发现进程的内存不断增长但是 V8 堆快照大小变化不大，那可能是 Buffer 变量没有释放，理解实现能帮助我们更好地思考问题和解决问题。
