本章介绍Node.js中C++层的一些核心模块的原理和实现，这些模块是Node.js中很多模块都会使用的。理解这些模块的原理，才能更好地理解在Node.js中，JS是如何通过C++层调用Libuv，又是如何从Libuv返回的。

## 6.1 BaseObject
BaseObject是C++层大多数类的基类。
```c
1.	class BaseObject : public MemoryRetainer {  
2.	 public:  
3.	 // …
4.	 private:  
5.	  v8::Local<v8::Object> WrappedObject() const override;
6.	  // 指向封装的对象  
7.	  v8::Global<v8::Object> persistent_handle_;  
8.	  Environment* env_;  
9.	};  
```
BaseObject的实现很复杂，这里只介绍常用的一些实现。
### 6.1.1 构造函数

```c
1.	// 把对象存储到persistent_handle_中，必要的时候通过object()取出来  
2.	BaseObject::BaseObject(Environment* env, 
3.	                         v8::Local<v8::Object> object) 
4.	: persistent_handle_(env->isolate(), object), 
5.	  env_(env) {  
6.	  // 把this存到object中  
7.	  object->SetAlignedPointerInInternalField(0, static_cast<void*>(this));    
8.	}  
```

构造函数用于保存对象间的关系（JS使用的对象和与其关系的C++层对象，下图中的对象即我们平时在JS层使用C++模块创建的对象，比如new TCP()）。后面我们可以看到用处，关系如图6-1所示。  
![](https://img-blog.csdnimg.cn/c732bcd047c349adbb9f5d4a501a1345.png)  
图6-1

### 6.1.2 获取封装的对象
```c
1.	v8::Local<v8::Object> BaseObject::object() const {  
2.	  return PersistentToLocal::Default(env()->isolate(), 
3.	                                        persistent_handle_);  
4.	}  
```
### 6.1.3 从对象中获取保存的BaseObject对象
```c
1.	// 通过obj取出里面保存的BaseObject对象  
2.	BaseObject* BaseObject::FromJSObject(v8::Local<v8::Object> obj) {
3.	  return static_cast<BaseObject*>(obj->GetAlignedPointerFromInternalField(0));  
4.	}  
5.	  
6.	template <typename T>  
7.	T* BaseObject::FromJSObject(v8::Local<v8::Object> object) {  
8.	  return static_cast<T*>(FromJSObject(object));  
9.	}  
```

### 6.1.4 解包

```c
1.	// 从obj中取出对应的BaseObject对象  
2.	template <typename T>  
3.	inline T* Unwrap(v8::Local<v8::Object> obj) {  
4.	  return BaseObject::FromJSObject<T>(obj);  
5.	}  
6.	  
7.	// 从obj中获取对应的BaseObject对象，如果为空则返回第三个参数的值（默认值）  
8.	#define ASSIGN_OR_RETURN_UNWRAP(ptr, obj, ...) \  
9.	  do {       \  
10.	    *ptr = static_cast<typename std::remove_reference<decltype(*ptr)>::type>( \  
11.	        BaseObject::FromJSObject(obj));   \  
12.	    if (*ptr == nullptr)  \  
13.	      return __VA_ARGS__; \  
14.	  } while (0)  
```

## 6.2 AsyncWrap
AsyncWrap实现async_hook的模块，不过这里我们只关注它回调JS的功能。

```c
1.	inline v8::MaybeLocal<v8::Value> AsyncWrap::MakeCallback(  
2.	    const v8::Local<v8::Name> symbol,  
3.	    int argc,  
4.	    v8::Local<v8::Value>* argv) {  
5.	  v8::Local<v8::Value> cb_v;  
6.	  // 根据字符串表示的属性值，从对象中取出该属性对应的值。是个函数  
7.	  if (!object()->Get(env()->context(), symbol).ToLocal(&cb_v))  
8.	    return v8::MaybeLocal<v8::Value>();  
9.	  // 是个函数  
10.	  if (!cb_v->IsFunction()) {  
11.	    return v8::MaybeLocal<v8::Value>();  
12.	  }  
13.	  // 回调,见async_wrap.cc  
14.	  return MakeCallback(cb_v.As<v8::Function>(), argc, argv);  
15.	}  
```

以上只是入口函数，我们看看真正的实现。

```
1.	MaybeLocal<Value> AsyncWrap::MakeCallback(const Local<Function> cb,  
2.	                                          int argc,  
3.	                                          Local<Value>* argv) {  
4.	  
5.	  MaybeLocal<Value> ret = InternalMakeCallback(env(), object(), cb, argc, argv, context);  
6.	  return ret;  
7.	}  
```

接着看一下InternalMakeCallback

```
1.	MaybeLocal<Value> InternalMakeCallback(Environment* env,  
2.	                                       Local<Object> recv,  
3.	                                       const Local<Function> callback,  
4.	                                       int argc,  
5.	                                       Local<Value> argv[],  
6.	                                       async_context asyncContext) {  
7.	  // …省略其他代码
8.	  // 执行回调  
9.	  callback->Call(env->context(), recv, argc, argv);}  
```

## 6.3 HandleWrap
HandleWrap是对Libuv uv_handle_t的封装,也是很多C++类的基类。

```
1.	class HandleWrap : public AsyncWrap {  
2.	 public:  
3.	  // 操作和判断handle状态函数，见Libuv  
4.	  static void Close(const v8::FunctionCallbackInfo<v8::Value>& args);  
5.	  static void Ref(const v8::FunctionCallbackInfo<v8::Value>& args);  
6.	  static void Unref(const v8::FunctionCallbackInfo<v8::Value>& args);  
7.	  static void HasRef(const v8::FunctionCallbackInfo<v8::Value>& args);  
8.	  static inline bool IsAlive(const HandleWrap* wrap) {  
9.	    return wrap != nullptr && wrap->state_ != kClosed;  
10.	  }  
11.	  
12.	  static inline bool HasRef(const HandleWrap* wrap) {  
13.	    return IsAlive(wrap) && uv_has_ref(wrap->GetHandle());  
14.	  }  
15.	  // 获取封装的handle  
16.	  inline uv_handle_t* GetHandle() const { return handle_; }  
17.	  // 关闭handle，关闭成功后执行回调  
18.	  virtual void Close(  
19.	      v8::Local<v8::Value> close_callback = 
20.	       v8::Local<v8::Value>());  
21.	  
22.	  static v8::Local<v8::FunctionTemplate> GetConstructorTemplate(
23.	  Environment* env);  
24.	  
25.	 protected:  
26.	  HandleWrap(Environment* env,  
27.	             v8::Local<v8::Object> object,  
28.	             uv_handle_t* handle,  
29.	             AsyncWrap::ProviderType provider);  
30.	  virtual void OnClose() {}  
31.	  // handle状态  
32.	  inline bool IsHandleClosing() const {  
33.	    return state_ == kClosing || state_ == kClosed;  
34.	  }  
35.	  
36.	 private:  
37.	  friend class Environment;  
38.	  friend void GetActiveHandles(const v8::FunctionCallbackInfo<v8::Value>&);  
39.	  static void OnClose(uv_handle_t* handle);  
40.	  
41.	  // handle队列  
42.	  ListNode<HandleWrap> handle_wrap_queue_;  
43.	  // handle的状态  
44.	  enum { kInitialized, kClosing, kClosed } state_;  
45.	  // 所有handle的基类  
46.	  uv_handle_t* const handle_;  
47.	};  
```

### 6.3.1 新建handle和初始化

```
1.	Local<FunctionTemplate> HandleWrap::GetConstructorTemplate(Environment* env) {  
2.	  Local<FunctionTemplate> tmpl = env->handle_wrap_ctor_template();  
3.	  if (tmpl.IsEmpty()) {  
4.	    tmpl = env->NewFunctionTemplate(nullptr);  
5.	    tmpl->SetClassName(FIXED_ONE_BYTE_STRING(env->isolate(), 
6.	                         "HandleWrap"));  
7.	    tmpl->Inherit(AsyncWrap::GetConstructorTemplate(env));  
8.	    env->SetProtoMethod(tmpl, "close", HandleWrap::Close);  
9.	    env->SetProtoMethodNoSideEffect(tmpl, 
10.	                                        "hasRef", 
11.	                                       HandleWrap::HasRef);  
12.	    env->SetProtoMethod(tmpl, "ref", HandleWrap::Ref);  
13.	    env->SetProtoMethod(tmpl, "unref", HandleWrap::Unref);  
14.	    env->set_handle_wrap_ctor_template(tmpl);  
15.	  }  
16.	  return tmpl;  
17.	}  
18.	/* 
19.	  object为C++层为JS层提供的对象 
20.	  handle为子类具体的handle类型，不同模块不一样 
21.	*/  
22.	HandleWrap::HandleWrap(Environment* env,  
23.	                       Local<Object> object,  
24.	                       uv_handle_t* handle,  
25.	                       AsyncWrap::ProviderType provider)  
26.	    : AsyncWrap(env, object, provider),  
27.	      state_(kInitialized),  
28.	      handle_(handle) {  
29.	  // 保存Libuv handle和C++对象的关系  
30.	  handle_->data = this;  
31.	  HandleScope scope(env->isolate());  
32.	  CHECK(env->has_run_bootstrapping_code());  
33.	  // 插入handle队列  
34.	  env->handle_wrap_queue()->PushBack(this);  
35.	}  
```

HandleWrap继承BaseObject类，初始化后关系图如图6-2所示。  
 ![](https://img-blog.csdnimg.cn/96428743f6c44b1980d2d59c3ac2c513.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-2
### 6.3.2 判断和操作handle状态

```
1.	// 修改handle为活跃状态  
2.	void HandleWrap::Ref(const FunctionCallbackInfo<Value>& args) {  
3.	  HandleWrap* wrap;  
4.	  ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
5.	  
6.	  if (IsAlive(wrap))  
7.	    uv_ref(wrap->GetHandle());  
8.	}  
9.	  
10.	// 修改hande为不活跃状态  
11.	void HandleWrap::Unref(const FunctionCallbackInfo<Value>& args) {  
12.	  HandleWrap* wrap;  
13.	  ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
14.	  
15.	  if (IsAlive(wrap))  
16.	    uv_unref(wrap->GetHandle());  
17.	}  
18.	  
19.	// 判断handle是否处于活跃状态  
20.	void HandleWrap::HasRef(const FunctionCallbackInfo<Value>& args) {  
21.	  HandleWrap* wrap;  
22.	  ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
23.	  args.GetReturnValue().Set(HasRef(wrap));  
24.	}  
```

### 6.3.3 关闭handle

```
1.	// 关闭handle（JS层调用），成功后执行回调  
2.	void HandleWrap::Close(const FunctionCallbackInfo<Value>& args) {  
3.	  HandleWrap* wrap;  
4.	  ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
5.	  // 传入回调  
6.	  wrap->Close(args[0]);  
7.	}  
8.	// 真正关闭handle的函数  
9.	void HandleWrap::Close(Local<Value> close_callback) {  
10.	  // 正在关闭或已经关闭  
11.	  if (state_ != kInitialized)  
12.	    return;  
13.	  // 调用Libuv函数  
14.	  uv_close(handle_, OnClose);  
15.	  // 关闭中  
16.	  state_ = kClosing;  
17.	  // 传了回调则保存起来  
18.	  if (!close_callback.IsEmpty() && 
19.	       close_callback->IsFunction() &&  
20.	      !persistent().IsEmpty()) {  
21.	    object()->Set(env()->context(),  
22.	                  env()->handle_onclose_symbol(),  
23.	                  close_callback).Check();  
24.	  }  
25.	}  
26.	  
27.	// 关闭handle成功后回调  
28.	void HandleWrap::OnClose(uv_handle_t* handle) {  
29.	  BaseObjectPtr<HandleWrap> wrap { 
30.	     static_cast<HandleWrap*>(handle->data) 
31.	  };  
32.	  wrap->Detach();  
33.	  
34.	  Environment* env = wrap->env();  
35.	  HandleScope scope(env->isolate());  
36.	  Context::Scope context_scope(env->context());  
37.	  wrap->state_ = kClosed;  
38.	  
39.	  wrap->OnClose();  
40.	  wrap->handle_wrap_queue_.Remove();  
41.	  // 有onclose回调则执行  
42.	  if (!wrap->persistent().IsEmpty() &&  
43.	      wrap->object()->Has(env->context(), 
44.	                             env->handle_onclose_symbol())  
45.	      .FromMaybe(false)) {  
46.	    wrap->MakeCallback(env->handle_onclose_symbol(), 
47.	                         0, 
48.	                         nullptr);  
49.	  }  
50.	}  
```

## 6.4 ReqWrap
ReqWrap表示通过Libuv对handle的一次请求。
### 6.4.1 ReqWrapBase 

```
1.	class ReqWrapBase {  
2.	 public:  
3.	  explicit inline ReqWrapBase(Environment* env);  
4.	  virtual ~ReqWrapBase() = default;  
5.	  virtual void Cancel() = 0;  
6.	  virtual AsyncWrap* GetAsyncWrap() = 0;  
7.	  
8.	 private:  
9.	  // 一个带前后指针的节点  
10.	  ListNode<ReqWrapBase> req_wrap_queue_;  
11.	};  
```

ReqWrapBase主要是定义接口的协议。我们看一下ReqWrapBase的实现

```
1.	ReqWrapBase::ReqWrapBase(Environment* env) {  
2.	  env->req_wrap_queue()->PushBack(this);  
3.	}  
```

ReqWrapBase初始化的时候，会把自己加到env对象的req队列中。
### 6.4.2 ReqWrap

```
1.	template <typename T>  
2.	class ReqWrap : public AsyncWrap, public ReqWrapBase {  
3.	 public:  
4.	  inline ReqWrap(Environment* env,  
5.	                 v8::Local<v8::Object> object,  
6.	                 AsyncWrap::ProviderType provider);  
7.	  inline ~ReqWrap() override;  
8.	  inline void Dispatched();  
9.	  inline void Reset();  
10.	  T* req() { return &req_; }  
11.	  inline void Cancel() final;  
12.	  inline AsyncWrap* GetAsyncWrap() override;  
13.	  static ReqWrap* from_req(T* req);  
14.	  template <typename LibuvFunction, typename... Args>  
15.	  // 调用Libuv
16.	  inline int Dispatch(LibuvFunction fn, Args... args);  
17.	   
18.	 public:  
19.	  typedef void (*callback_t)();  
20.	  callback_t original_callback_ = nullptr;  
21.	  
22.	 protected:  
23.	  T req_;  
24.	};  
25.	  
26.	}   
```

我们看一下实现

```
1.	template <typename T>  
2.	ReqWrap<T>::ReqWrap(Environment* env,  
3.	                    v8::Local<v8::Object> object,  
4.	                    AsyncWrap::ProviderType provider)  
5.	    : AsyncWrap(env, object, provider),  
6.	      ReqWrapBase(env) {  
7.	  // 初始化状态  
8.	  Reset();  
9.	}  
10.	  
11.	// 保存libuv数据结构和ReqWrap实例的关系  
12.	template <typename T>  
13.	void ReqWrap<T>::Dispatched() {  
14.	  req_.data = this;  
15.	}  
16.	  
17.	// 重置字段  
18.	template <typename T>  
19.	void ReqWrap<T>::Reset() {  
20.	  original_callback_ = nullptr;  
21.	  req_.data = nullptr;  
22.	}  
23.	  
24.	// 通过req成员找所属对象的地址  
25.	template <typename T>  
26.	ReqWrap<T>* ReqWrap<T>::from_req(T* req) {  
27.	  return ContainerOf(&ReqWrap<T>::req_, req);  
28.	}  
29.	  
30.	// 取消线程池中的请求  
31.	template <typename T>  
32.	void ReqWrap<T>::Cancel() {  
33.	  if (req_.data == this)  
34.	    uv_cancel(reinterpret_cast<uv_req_t*>(&req_));  
35.	}  
36.	
37.	template <typename T>
38.	AsyncWrap* ReqWrap<T>::GetAsyncWrap() {
39.	  return this;
40.	}
41.	// 调用Libuv函数  
42.	template <typename T>  
43.	template <typename LibuvFunction, typename... Args>  
44.	int ReqWrap<T>::Dispatch(LibuvFunction fn, Args... args) {  
45.	  Dispatched();  
46.	  int err = CallLibuvFunction<T, LibuvFunction>::Call(  
47.	      // Libuv函数
48.	      fn,  
49.	      env()->event_loop(),  
50.	      req(),  
51.	      MakeLibuvRequestCallback<T, Args>::For(this, args)...);  
52.	  if (err >= 0)  
53.	    env()->IncreaseWaitingRequestCounter();  
54.	  return err;  
55.	}  
```

我们看到ReqWrap抽象了请求Libuv的过程，具体设计的数据结构由子类实现。我们看一下某个子类的实现。

```
1.	// 请求Libuv时，数据结构是uv_connect_t，表示一次连接请求  
2.	class ConnectWrap : public ReqWrap<uv_connect_t> {  
3.	 public:  
4.	  ConnectWrap(Environment* env,  
5.	              v8::Local<v8::Object> req_wrap_obj,  
6.	              AsyncWrap::ProviderType provider);  
7.	};  
```

## 6.5 JS如何使用C++
JS调用C++模块是V8提供的能力，Node.js是使用了这个能力。这样我们只需要面对JS，剩下的事情交给Node.js就行。本文首先讲一下利用V8如何实现JS调用C++，然后再讲一下Node.js是怎么做的。

1 JS调用C++
首先介绍一下V8中两个非常核心的类FunctionTemplate和ObjectTemplate。顾名思义，这两个类是定义模板的，好比建房子时的设计图一样，通过设计图，我们就可以造出对应的房子。V8也是，定义某种模板，就可以通过这个模板创建出对应的实例。下面介绍一下这些概念（为了方便，下面都是伪代码)。

1.1 定义一个函数模板

```
1.	Local<FunctionTemplate> functionTemplate = v8::FunctionTemplate::New(isolate(), New);  
2.	// 定义函数的名字    
3.	functionTemplate->SetClassName(‘TCP’)  
```

首先定义一个FunctionTemplate对象。我们看到FunctionTemplate的第二个入参是一个函数，当我们执行由FunctionTemplate创建的函数时，v8就会执行New函数。当然我们也可以不传。
1.2 定义函数模板的prototype内容
prototype就是JS里的function.prototype。如果你理解JS里的知识，就很容易理解C++的代码。

```
1.	v8::Local<v8::FunctionTemplate> t = v8::FunctionTemplate::New(isolate(), callback);    
2.	t->SetClassName('test');     
3.	// 在prototype上定义一个属性        
4.	t->PrototypeTemplate()->Set('hello', 'world');  
```

1.3 定义函数模板对应的实例模板的内容
实例模板就是一个ObjectTemplate对象。它定义了，当以new的方式执行由函数模板创建出来的函数时，返回值所具有的属性。

```
1.	function A() {    
2.	    this.a = 1;    
3.	    this.b = 2;    
4.	}    
5.	new A();    
```

实例模板类似上面代码中A函数里面的代码。我们看看在V8里怎么定义。

```
1.	t->InstanceTemplate()->Set(key, val);  
2.	t->InstanceTemplate()->SetInternalFieldCount(1);  
```

InstanceTemplate返回的是一个ObjectTemplate对象。SetInternalFieldCount这个函数比较特殊，也是比较重要的一个地方，我们知道对象就是一块内存，对象有它自己的内存布局，我们知道在C++里，我们定义一个类，也就定义了对象的布局。比如我们有以下定义。

```
1.	class demo    
2.	{    
3.	 private:    
4.	  int a;    
5.	  int b;    
6.	};  
```

在内存中布局如图6-3所示。  
 ![](https://img-blog.csdnimg.cn/8c925548ae8e49f3922a4d988607a989.png)  
图6-3  
上面这种方式有个问题，就是类定义之后，内存布局就固定了。而V8是自己去控制对象的内存布局的。当我们在V8中定义一个类的时候，是没有任何属性的。我们看一下V8中HeapObject类的定义。

```
1.	class HeapObject: public Object {    
2.	  static const int kMapOffset = Object::kSize; // Object::kSize是0    
3.	  static const int kSize = kMapOffset + kPointerSize;    
4.	};   
```

这时候的内存布局如下。  
 ![](https://img-blog.csdnimg.cn/2081c70b06b247bf8b6d3996f40f7d03.png)  
然后我们再看一下HeapObject子类HeapNumber的定义。

```
1.	class HeapNumber: public HeapObject {    
2.	  // kSize之前的空间存储map对象的指针    
3.	  static const int kValueOffset = HeapObject::kSize;    
4.	  // kValueOffset - kSize之间存储数字的值    
5.	  static const int kSize = kValueOffset + kDoubleSize;    
6.	};  
```

  
内存布局如图6-4所示。  
![](https://img-blog.csdnimg.cn/cc0c9b621ac8485faed34d94c73d2462.png)  
图6-4

我们发现这些类只有几个类变量，类变量是不保存在对象内存空间的。这些类变量就是定义了对象每个域所占内存空间的信息，当我们定义一个HeapObject对象的时候，V8首先申请一块内存，然后把这块内存首地址强行转成对应对象的指针。然后通过类变量对属性的内存进行存取。我们看看在V8里如何申请一个HeapNumber对象

```
1.	Object* Heap::AllocateHeapNumber(double value, PretenureFlag pretenure) {    
2.	  // 在哪个空间分配内存，比如新生代，老生代    
3.	  AllocationSpace space = (pretenure == TENURED) ? CODE_SPACE : NEW_SPACE;    
4.	  // 在space上分配一个HeapNumber对象大小的内存    
5.	  Object* result = AllocateRaw(HeapNumber::kSize, space);    
6.	  /*  
7.	      转成HeapObect，设置map属性，map属性是表示对象类型、大小等信息的  
8.	  */    
9.	  HeapObject::cast(result)->set_map(heap_number_map());    
10.	  // 转成HeapNumber对象    
11.	  HeapNumber::cast(result)->set_value(value);    
12.	  return result;    
13.	}   
```

回到对象模板的问题。我们看一下对象模板的定义。

```
1.	class TemplateInfo: public Struct {    
2.	  static const int kTagOffset          = HeapObject::kSize;    
3.	  static const int kPropertyListOffset = kTagOffset + kPointerSize;    
4.	  static const int kHeaderSize         = kPropertyListOffset + kPointerSize;    
5.	};    
6.	    
7.	class ObjectTemplateInfo: public TemplateInfo {    
8.	  static const int kConstructorOffset = TemplateInfo::kHeaderSize;    
9.	  static const int kInternalFieldCountOffset = kConstructorOffset + kPointerSize;    
10.	  static const int kSize = kInternalFieldCountOffset + kHeaderSize;    
11.	};   
```

内存布局如图6-5所示。  
![](https://img-blog.csdnimg.cn/9cfde2c74ac24d529350ffda1bc6c2ac.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-5

回到对象模板的问题，我们看看Set(key, val)做了什么。

```
1.	void Template::Set(v8::Handle<String> name, v8::Handle<Data> value,    
2.	                   v8::PropertyAttribute attribute) {    
3.	  // ...    
4.	  i::Handle<i::Object> list(Utils::OpenHandle(this)->property_list());    
5.	  NeanderArray array(list);    
6.	  array.add(Utils::OpenHandle(*name));    
7.	  array.add(Utils::OpenHandle(*value));    
8.	  array.add(Utils::OpenHandle(*v8::Integer::New(attribute)));    
9.	}    
```

上面的代码大致就是给一个list后面追加一些内容。我们看看这个list是怎么来的，即property_list函数的实现。

```
1.	// 读取对象中某个属性的值    
2.	#define READ_FIELD(p, offset) (*reinterpret_cast<Object**>(FIELD_ADDR(p, offset))    
3.	    
4.	static Object* cast(Object* value) {     
5.	    return value;    
6.	}    
7.	    
8.	Object* TemplateInfo::property_list() {     
9.	    return Object::cast(READ_FIELD(this, kPropertyListOffset));     
10.	}    
```

从上面代码中我们知道，内部布局如图6-6所示。  
 ![](https://img-blog.csdnimg.cn/10abb0324ce54c9eba3743e8f4e61cc2.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-6

根据内存布局，我们知道property_list的值是list指向的值。所以Set(key, val)操作的内存并不是对象本身的内存，对象利用一个指针指向一块内存保存Set(key, val)的值。SetInternalFieldCount函数就不一样了，它会影响（扩张）对象本身的内存。我们来看一下它的实现。

```
1.	void ObjectTemplate::SetInternalFieldCount(int value) {    
2.	  // 修改的是kInternalFieldCountOffset对应的内存的值    
3.	  Utils::OpenHandle(this)->set_internal_field_count(i::Smi::FromInt(value));    
4.	}    
```

我们看到SetInternalFieldCount函数的实现很简单，就是在对象本身的内存中保存一个数字。接下来我们看看这个字段的使用。后面会详细介绍它的用处。

```
1.	Handle<JSFunction> Factory::CreateApiFunction(    
2.	    Handle<FunctionTemplateInfo> obj,    
3.	    bool is_global) {    
4.	     
5.	  int internal_field_count = 0;    
6.	  if (!obj->instance_template()->IsUndefined()) {    
7.	    // 获取函数模板的实例模板    
8.	    Handle<ObjectTemplateInfo> instance_template = Handle<ObjectTemplateInfo>(ObjectTemplateInfo::cast(obj->instance_template()));    
9.	    // 获取实例模板的internal_field_count字段的值（通过SetInternalFieldCount设置的那个值）    
10.	    internal_field_count = Smi::cast(instance_template->internal_field_count())->value();    
11.	  }    
12.	  // 计算新建对象需要的空间，如果    
13.	  int instance_size = kPointerSize * internal_field_count;    
14.	  if (is_global) {    
15.	    instance_size += JSGlobalObject::kSize;    
16.	  } else {    
17.	    instance_size += JSObject::kHeaderSize;    
18.	  }    
19.	    
20.	  InstanceType type = is_global ? JS_GLOBAL_OBJECT_TYPE : JS_OBJECT_TYPE;    
21.	  // 新建一个函数对象    
22.	  Handle<JSFunction> result =    
23.	      Factory::NewFunction(Factory::empty_symbol(), type, instance_size,    
24.	                           code, true);    
25.	}    
```

我们看到internal_field_count的值的意义是，会扩张对象的内存，比如一个对象本身只有n字节，如果定义internal_field_count的值是1，对象的内存就会变成n+internal_field_count * 一个指针的字节数。内存布局如图6-7所示。  
 ![](https://img-blog.csdnimg.cn/e3ac46175f034690a3cda19d2e61969d.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)   
图6-7  
1.4 通过函数模板创建一个函数
1.	Local<FunctionTemplate> functionTemplate = v8::FunctionTemplate::New(isolate(), New);  
2.	global->Set('demo', functionTemplate ->GetFunction());  
这样我们就可以在JS里直接调用demo这个变量，然后对应的函数就会被执行。这就是JS调用C++的原理。

2 Node.js是如何处理JS调用C++问题的
我们以TCP模块为例。

```
1.	constant { TCP } = process.binding('tcp_wrap');    
2.	new TCP(...);   
```

 
Node.js通过定义一个全局变量process统一处理C++模块的调用，具体参考模块加载章节的内容。在Node.js中，C++模块（类）一般只会定义对应的Libuv结构体和一系列类函数，然后创建一个函数模版，并传入一个回调，接着把这些类函数挂载到函数模板中,最后通过函数模板返回一个函数F给JS层使用，翻译成JS大致如下

```
1.	// Libuv  
2.	function uv_tcp_connect(uv_tcp_t, addr,cb) { cb(); }    
3.	      
4.	// C++  
5.	class TCPWrap {    
6.	  
7.	  uv_tcp_t = {};    
8.	  
9.	  static Connect(cb) {    
10.	  
11.	    const tcpWrap = this[0];    
12.	  
13.	    uv_tcp_connect(  
14.	  
15.	      tcpWrap.uv_tcp_t,  
16.	  
17.	      {ip: '127.0.0.1', port: 80},  
18.	  
19.	     () => { cb(); }  
20.	  
21.	    );    
22.	  
23.	 }    
24.	  
25.	}    
26.	  
27.	function FunctionTemplate(cb) {    
28.	   function Tmp() {  
29.	    Object.assign(this, map);  
30.	    cb(this);  
31.	   }  
32.	   const map = {};  
33.	   return {  
34.	    PrototypeTemplate: function() {  
35.	        return {  
36.	            set: function(k, v) {  
37.	                Tmp.prototype[k] = v;  
38.	            }  
39.	        }  
40.	    },  
41.	    InstanceTemplate: function() {  
42.	        return {  
43.	            set: function(k, v) {  
44.	                map[k] = v;  
45.	            }  
46.	        }  
47.	    },  
48.	    GetFunction() {  
49.	        return Tmp;  
50.	    }  
51.	   }   
52.	  
53.	}    
54.	  
55.	const TCPFunctionTemplate = FunctionTemplate((target) => { target[0] = new TCPWrap(); })    
56.	  
57.	TCPFunctionTemplate.PrototypeTemplate().set('connect', TCPWrap.Connect);  
58.	TCPFunctionTemplate.InstanceTemplate().set('name', 'hi');  
59.	const TCP = TCPFunctionTemplate.GetFunction();  
60.	  
61.	// js  
62.	const tcp = new TCP();  
63.	tcp.connect(() => { console.log('连接成功'); });    
64.	tcp.name;  
```

我们从C++的层面分析执行new TCP()的逻辑，然后再分析connect的逻辑，这两个逻辑涉及的机制是其它C++模块也会使用到的。因为TCP对应的函数是Initialize函数里的t->GetFunction()对应的值。所以new TCP()的时候，V8首先会创建一个C++对象，然后执行New函数。

```
1.	void TCPWrap::New(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	  
4.	  int type_value = args[0].As<Int32>()->Value();  
5.	  TCPWrap::SocketType type = static_cast<TCPWrap::SocketType>(type_value);  
6.	  
7.	  ProviderType provider;  
8.	  switch (type) {  
9.	    case SOCKET:  
10.	      provider = PROVIDER_TCPWRAP;  
11.	      break;  
12.	    case SERVER:  
13.	      provider = PROVIDER_TCPSERVERWRAP;  
14.	      break;  
15.	    default:  
16.	      UNREACHABLE();  
17.	  }  
18.	  /*  
19.	    args.This()为v8提供的一个C++对象（由Initialize函数定义的模块创建的）  
20.	    调用该C++对象的SetAlignedPointerInInternalField(0,this)关联this（new TCPWrap()）,  
21.	    见HandleWrap  
22.	  */   
23.	  
24.	  new TCPWrap(env, args.This(), provider);  
25.	}  
```

我们沿着TCPWrap的继承关系，一直到HandleWrap

```
1.	HandleWrap::HandleWrap(Environment* env,  
2.	                       Local<Object> object,  
3.	                       uv_handle_t* handle,  
4.	                       AsyncWrap::ProviderType provider)  
5.	    : AsyncWrap(env, object, provider),  
6.	      state_(kInitialized),  
7.	      handle_(handle) {  
8.	  // 保存Libuv handle和C++对象的关系  
9.	  handle_->data = this;  
10.	  HandleScope scope(env->isolate());    
11.	  // 插入handle队列  
12.	  env->handle_wrap_queue()->PushBack(this);  
13.	}  
```

HandleWrap首先保存了Libuv结构体和C++对象的关系。然后我们继续沿着AsyncWrap分析，AsyncWrap继承BaseObject，我们直接看BaseObject。

```
1.	// 把对象存储到persistent_handle_中，必要的时候通过object()取出来  
2.	BaseObject::BaseObject(Environment* env, v8::Local<v8::Object> object)  
3.	    : persistent_handle_(env->isolate(), object), env_(env) {  
4.	  // 把this存到object中  
5.	  object->SetAlignedPointerInInternalField(0, static_cast<void*>(this));  
6.	  env->AddCleanupHook(DeleteMe, static_cast<void*>(this));  
7.	  env->modify_base_object_count(1);  
8.	}  
```

我们看SetAlignedPointerInInternalField。

```
1.	void v8::Object::SetAlignedPointerInInternalField(int index, void* value) {    
2.	  i::Handle<i::JSReceiver> obj = Utils::OpenHandle(this);    
3.	  i::Handle<i::JSObject>::cast(obj)->SetEmbedderField(    
4.	      index, EncodeAlignedAsSmi(value, location));    
5.	}    
6.	    
7.	void JSObject::SetEmbedderField(int index, Smi* value) {    
8.	  // GetHeaderSize为对象固定布局的大小，kPointerSize * index为拓展的内存大小，根据索引找到对应位置    
9.	  int offset = GetHeaderSize() + (kPointerSize * index);    
10.	  // 写对应位置的内存，即保存对应的内容到内存    
11.	  WRITE_FIELD(this, offset, value);    
12.	}   
```

SetAlignedPointerInInternalField函数展开后，做的事情就是把一个值保存到V8 C++对象的内存里。那保存的这个值是啥呢？BaseObject的入参object是由函数模板创建的对象，this是一个TCPWrap对象。所以SetAlignedPointerInInternalField函数做的事情就是把一个TCPWrap对象保存到一个函数模板创建的对象里，如图6-8所示。
 ![](https://img-blog.csdnimg.cn/cead0241ca5a4f02b38727ae85145fcc.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-8

这有啥用呢？我们继续分析。这时候new TCP就执行完毕了。我们看看这时候执行tcp.connect()函数的逻辑。

```
1.	template <typename T>  
2.	void TCPWrap::Connect(const FunctionCallbackInfo<Value>& args,  
3.	    std::function<int(const char* ip_address, T* addr)> uv_ip_addr) {  
4.	  Environment* env = Environment::GetCurrent(args);  
5.	  
6.	  TCPWrap* wrap;  
7.	  ASSIGN_OR_RETURN_UNWRAP(&wrap,  
8.	                          args.Holder(),  
9.	                          args.GetReturnValue().Set(UV_EBADF));  
10.	  // 省略部分不相关代码
11.	  
12.	  args.GetReturnValue().Set(err);  
13.	}  
```

我们只需看一下ASSIGN_OR_RETURN_UNWRAP宏的逻辑。其中args.Holder()表示Connect函数的属主，根据前面的分析我们知道属主是Initialize函数定义的函数模板创建出来的对象。这个对象保存了一个TCPWrap对象。ASSIGN_OR_RETURN_UNWRAP主要的逻辑是把在C++对象中保存的那个TCPWrap对象取出来。然后就可以使用TCPWrap对象的handle去请求Libuv了。
## 6.7 C++层调用Libuv
刚才我们分析了JS调用C++层时是如何串起来的，接着我们看一下C++调用Libuv和Libuv回调C++层又是如何串起来的。我们通过TCP模块的connect函数继续分析该过程。

```
1.	template <typename T>  
2.	void TCPWrap::Connect(const FunctionCallbackInfo<Value>& args,  
3.	    std::function<int(const char* ip_address, T* addr)> uv_ip_addr) {  
4.	  Environment* env = Environment::GetCurrent(args);  
5.	  
6.	  TCPWrap* wrap;  
7.	  ASSIGN_OR_RETURN_UNWRAP(&wrap,  
8.	                          args.Holder(),  
9.	                          args.GetReturnValue().Set(UV_EBADF));  
10.	  
11.	  // 第一个参数是TCPConnectWrap对象，见net模块  
12.	  Local<Object> req_wrap_obj = args[0].As<Object>();  
13.	  // 第二个是ip地址  
14.	  node::Utf8Value ip_address(env->isolate(), args[1]);  
15.	  
16.	  T addr;  
17.	  // 把端口，IP设置到addr上，端口信息在uv_ip_addr上下文里了  
18.	  int err = uv_ip_addr(*ip_address, &addr);  
19.	  
20.	  if (err == 0) {  
21.	    ConnectWrap* req_wrap =  
22.	        new ConnectWrap(env, 
23.	                          req_wrap_obj, 
24.	                          AsyncWrap::PROVIDER_TCPCONNECTWRAP);  
25.	    err = req_wrap->Dispatch(uv_tcp_connect,  
26.	                             &wrap->handle_,  
27.	                             reinterpret_cast<const sockaddr*>(&addr),  
28.	                             AfterConnect);  
29.	    if (err)  
30.	      delete req_wrap;  
31.	  }  
32.	  
33.	  args.GetReturnValue().Set(err);  
34.	}  
```

我们首先看一下ConnectWrap。我们知道ConnectWrap是ReqWrap的子类。req_wrap_obj是JS层使用的对象。New ConnectWrap后结构如图6-9所示。  
![](https://img-blog.csdnimg.cn/f3635e1bc9314a99ba9bf39fc5c8f235.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
 图6-9  

接着我们看一下Dispatch。

```
1.	// 调用Libuv函数  
2.	template <typename T>  
3.	template <typename LibuvFunction, typename... Args>  
4.	int ReqWrap<T>::Dispatch(LibuvFunction fn, Args... args) {  
5.	  // 保存Libuv结构体和C++层对象ConnectWrap的关系    
6.	  req_.data = this;    
7.	  int err = CallLibuvFunction<T, LibuvFunction>::Call(  
8.	      fn,  
9.	      env()->event_loop(),  
10.	      req(),  
11.	      MakeLibuvRequestCallback<T, Args>::For(this, args)...);  
12.	  if (err >= 0)  
13.	    env()->IncreaseWaitingRequestCounter();  
14.	  return err;  
15.	}  
```

调用Libuv之前的结构如图6-10所示。  
![](https://img-blog.csdnimg.cn/cc0b84c5f6314236b6994344d68ae762.png)  
图6-10

接下来我们分析调用Libuv的具体过程。我们看到Dispatch函数是一个函数模板。
首先看一下CallLibuvFunction的实现。

```
1.	template <typename ReqT, typename T>  
2.	struct CallLibuvFunction;  
3.	  
4.	// Detect `int uv_foo(uv_loop_t* loop, uv_req_t* request, ...);`.  
5.	template <typename ReqT, typename... Args>  
6.	struct CallLibuvFunction<ReqT, int(*)(uv_loop_t*, ReqT*, Args...)> {  
7.	  using T = int(*)(uv_loop_t*, ReqT*, Args...);  
8.	  template <typename... PassedArgs>  
9.	  static int Call(T fn, uv_loop_t* loop, ReqT* req, PassedArgs... args) {  
10.	    return fn(loop, req, args...);  
11.	  }  
12.	};  
13.	  
14.	// Detect `int uv_foo(uv_req_t* request, ...);`.  
15.	template <typename ReqT, typename... Args>  
16.	struct CallLibuvFunction<ReqT, int(*)(ReqT*, Args...)> {  
17.	  using T = int(*)(ReqT*, Args...);  
18.	  template <typename... PassedArgs>  
19.	  static int Call(T fn, uv_loop_t* loop, ReqT* req, PassedArgs... args) {  
20.	    return fn(req, args...);  
21.	  }  
22.	};  
23.	  
24.	// Detect `void uv_foo(uv_req_t* request, ...);`.  
25.	template <typename ReqT, typename... Args>  
26.	struct CallLibuvFunction<ReqT, void(*)(ReqT*, Args...)> {  
27.	  using T = void(*)(ReqT*, Args...);  
28.	  template <typename... PassedArgs>  
29.	  static int Call(T fn, uv_loop_t* loop, ReqT* req, PassedArgs... args) {  
30.	    fn(req, args...);  
31.	    return 0;  
32.	  }  
33.	};  
```

CallLibuvFunction的实现看起来非常复杂，那是因为用了大量的模板参数，CallLibuvFunction本质上是一个struct，在C++里和类作用类似，里面只有一个类函数Call，Node.js为了适配Libuv层各种类型函数的调用，所以实现了三种类型的CallLibuvFunction,并且使用了大量的模板参数。我们只需要分析一种就可以了。我们根据TCP的connect函数开始分析。我们首先具体下Dispatch函数的模板参数。

```
1.	template <typename T>  
2.	template <typename LibuvFunction, typename... Args>  
```

T对应ReqWrap的类型，LibuvFunction对应Libuv的函数类型，这里是int uv_tcp_connect(uv_connect_t* req, ...)，所以是对应LibuvFunction的第二种情况，Args是执行Dispatch时除了第一个实参外的剩余参数。下面我们具体化Dispatch。

```
1.	int ReqWrap<uv_connect_t>::Dispatch(int(*)(uv_connect_t*, Args...), Args... args) {  
2.	  req_.data = this;  
3.	  int err = CallLibuvFunction<uv_connect_t, int(*)(uv_connect_t*, Args...)>::Call(  
4.	      fn,  
5.	      env()->event_loop(),  
6.	      req(),  
7.	      MakeLibuvRequestCallback<T, Args>::For(this, args)...);  
8.	  
9.	  return err;  
10.	}  
```

接着我们看一下MakeLibuvRequestCallback的实现。

```
1.	// 透传参数给Libuv  
2.	template <typename ReqT, typename T>  
3.	struct MakeLibuvRequestCallback {  
4.	  static T For(ReqWrap<ReqT>* req_wrap, T v) {  
5.	    static_assert(!is_callable<T>::value,  
6.	                  "MakeLibuvRequestCallback missed a callback");  
7.	    return v;  
8.	  }  
9.	};  
10.	  
11.	template <typename ReqT, typename... Args>   
12.	struct MakeLibuvRequestCallback<ReqT, void(*)(ReqT*, Args...)> {  
13.	  using F = void(*)(ReqT* req, Args... args);  
14.	  // Libuv回调  
15.	  static void Wrapper(ReqT* req, Args... args) {  
16.	    // 通过Libuv结构体拿到对应的C++对象  
17.	    ReqWrap<ReqT>* req_wrap = ReqWrap<ReqT>::from_req(req);  
18.	    req_wrap->env()->DecreaseWaitingRequestCounter();  
19.	    // 拿到原始的回调执行  
20.	    F original_callback = reinterpret_cast<F>(req_wrap->original_callback_);  
21.	    original_callback(req, args...);  
22.	  }  
23.	  
24.	  static F For(ReqWrap<ReqT>* req_wrap, F v) {  
25.	    // 保存原来的函数  
26.	    CHECK_NULL(req_wrap->original_callback_);  
27.	    req_wrap->original_callback_ =  
28.	        reinterpret_cast<typename ReqWrap<ReqT>::callback_t>(v);  
29.	    // 返回包裹函数  
30.	    return Wrapper;  
31.	  }  
32.	};  
```

MakeLibuvRequestCallback的实现有两种情况，模版参数的第一个一般是ReqWrap子类，第二个一般是handle，初始化ReqWrap类的时候，env中会记录ReqWrap实例的个数，从而知道有多少个请求正在被Libuv处理，模板参数的第二个如果是函数则说明没有使用ReqWrap请求Libuv，则使用第二种实现，劫持回调从而记录正在被Libuv处理的请求数（如GetAddrInfo的实现）。所以我们这里是适配第一种实现。透传C++层参数给Libuv。我们再来看一下
Dispatch

```
1.	int ReqWrap<uv_connect_t>::Dispatch(int(*)(uv_connect_t*, Args...), Args... args) {    
2.	      req_.data = this;    
3.	      int err = CallLibuvFunction<uv_connect_t, int(*)(uv_connect_t*, Args...)>::Call(    
4.	          fn,    
5.	          env()->event_loop(),    
6.	          req(),    
7.	          args...);    
8.	        
9.	      return err;    
10.	  }    
```

再进一步展开。

```
1.	static int Call(int(*fn)(uv_connect_t*, Args...), uv_loop_t* loop, uv_connect_t* req, PassedArgs... args) {  
2.	    return fn(req, args...);  
3.	}  
```

最后展开

```
1.	static int Call(int(*fn)(uv_connect_t*, Args...), uv_loop_t* loop, uv_connect_t* req, PassedArgs... args) {  
2.	    return fn(req, args...);  
3.	}  
4.	  
5.	Call(  
6.	  uv_tcp_connect,  
7.	  env()->event_loop(),  
8.	  req(),  
9.	  &wrap->handle_,  
10.	  AfterConnec  
11.	)  
12.	  
13.	uv_tcp_connect(  
14.	  env()->event_loop(),  
15.	  req(),  
16.	  &wrap->handle_,  
17.	  AfterConnect  
18.	);  
```

接着我们看看uv_tcp_connect做了什么。

```
1.	int uv_tcp_connect(uv_connect_t* req,  
2.	                   uv_tcp_t* handle,  
3.	                   const struct sockaddr* addr,  
4.	                   uv_connect_cb cb) {  
5.	  // ...  
6.	  return uv__tcp_connect(req, handle, addr, addrlen, cb);  
7.	}  
8.	  
9.	int uv__tcp_connect(uv_connect_t* req,  
10.	                    uv_tcp_t* handle,  
11.	                    const struct sockaddr* addr,  
12.	                    unsigned int addrlen,  
13.	                    uv_connect_cb cb) {  
14.	  int err;  
15.	  int r;  
16.	  
17.	  // 关联起来  
18.	  req->handle = (uv_stream_t*) handle;  
19.	  // ...  
20.	}  
```

Libuv中把req和handle做了关联，如图6-11所示。  
 ![](https://img-blog.csdnimg.cn/370e8bb01b1b44ecafa6679f5b32d7e3.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-11

分析完C++调用Libuv后，我们看看Libuv回调C++和C++回调JS的过程。当Libuv处理完请求后会执行AfterConnect  。

```
1.	template <typename WrapType, typename UVType>  
2.	void ConnectionWrap<WrapType, UVType>::AfterConnect(uv_connect_t* req,  
3.	                                                    int status) {  
4.	  // 从Libuv结构体拿到C++的请求对象  
5.	  std::unique_ptr<ConnectWrap> req_wrap  
6.	    (static_cast<ConnectWrap*>(req->data));  
7.	  // 从C++层请求对象拿到对应的handle结构体（Libuv里关联起来的），再通过handle拿到对应的C++层handle对象（HandleWrap关联的）  
8.	  WrapType* wrap = static_cast<WrapType*>(req->handle->data);  
9.	  Environment* env = wrap->env();  
10.	  ...  
11.	  Local<Value> argv[5] = {  
12.	    Integer::New(env->isolate(), status),  
13.	    wrap->object(),  
14.	    req_wrap->object(),  
15.	    Boolean::New(env->isolate(), readable),  
16.	    Boolean::New(env->isolate(), writable)  
17.	  };  
18.	  // 回调JS层oncomplete  
19.	  req_wrap->MakeCallback(env->oncomplete_string(), 
20.	                           arraysize(argv), 
21.	                           argv);  
22.	}    
```

## 6.8 流封装
Node.js在C++层对流进行了非常多的封装，很多模块都依赖C++层流的机制，流机制的设计中，主要有三个概念 
1 资源，这是流机制的核心（StreamResource）,
2 对流进行操作（StreamReq）
3 流事件的监听者，当对流进行操作或流本身有事件触发时，会把事件和相关的上下文传递给监听者，监听者处理完后，再通知流（StreamListener）。
通过继承的模式，基类定义接口，子类实现接口的方式。对流的操作进行了抽象和封装。三者的类关系如图6-12所示。  
 ![](https://img-blog.csdnimg.cn/f9e8ba87c5034c5bb9c987120c0d4591.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-12

我们看一下读一个流的数据的过程，如图6-13所示。  
![](https://img-blog.csdnimg.cn/3289a56f13a141d88b8069c3432e9f8f.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-13

再看一下写的过程，如图6-14所示。  
 ![](https://img-blog.csdnimg.cn/808c9e3d738f41bab6f40377cec51508.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-14

### 6.8.1 StreamResource
StreamResource定义操作流的通用逻辑和操作结束后触发的回调。但是StreamResource不定义流的类型，流的类型由子类定义，我们可以在StreamResource上注册listener，表示对流感兴趣，当流上有数据可读或者事件发生时，就会通知listener。 

```
1.	class StreamResource {  
2.	 public:  
3.	  virtual ~StreamResource();   
4.	  // 注册/注销等待流可读事件  
5.	  virtual int ReadStart() = 0;  
6.	  virtual int ReadStop() = 0;  
7.	  // 关闭流  
8.	  virtual int DoShutdown(ShutdownWrap* req_wrap) = 0;  
9.	  // 写入流  
10.	  virtual int DoTryWrite(uv_buf_t** bufs, size_t* count);  
11.	  virtual int DoWrite(WriteWrap* w,  
12.	                      uv_buf_t* bufs,  
13.	                      size_t count,  
14.	                      uv_stream_t* send_handle) = 0;  
15.	  // ...忽略一些  
16.	  // 给流增加或删除监听者  
17.	  void PushStreamListener(StreamListener* listener);  
18.	  void RemoveStreamListener(StreamListener* listener);  
19.	  
20.	 protected:  
21.	  uv_buf_t EmitAlloc(size_t suggested_size);  
22.	  void EmitRead(ssize_t nread, 
23.	                  const uv_buf_t& buf = uv_buf_init(nullptr, 0));
24.	  // 流的监听者，即数据消费者  
25.	  StreamListener* listener_ = nullptr;  
26.	  uint64_t bytes_read_ = 0;  
27.	  uint64_t bytes_written_ = 0;  
28.	  friend class StreamListener;  
29.	};  
```

StreamResource是一个基类，其中有一个成员是StreamListener类的实例，我们后面分析。我们看一下StreamResource的实现。
1增加一个listener

```
1.	// 增加一个listener  
2.	inline void StreamResource::PushStreamListener(StreamListener* listener) {  
3.	  // 头插法   
4.	  listener->previous_listener_ = listener_;  
5.	  listener->stream_ = this;  
6.	  listener_ = listener;  
7.	}  
```

我们可以在一个流上注册多个listener，流的listener_字段维护了流上所有的listener队列。关系图如图6-15所示。
 ![](https://img-blog.csdnimg.cn/1147406f206a481f9fc8ad8192592d06.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-15  
2删除listener

```
1.	inline void StreamResource::RemoveStreamListener(StreamListener* listener) {  
2.	  StreamListener* previous;  
3.	  StreamListener* current;  
4.	  
5.	  // 遍历单链表  
6.	  for (current = listener_, previous = nullptr;  
7.	       /* No loop condition because we want a crash if listener is not found */  
8.	       ; previous = current, current = current->previous_listener_) {  
9.	    if (current == listener) {  
10.	      // 非空说明需要删除的不是第一个节点  
11.	      if (previous != nullptr)  
12.	        previous->previous_listener_ = current->previous_listener_;  
13.	      else  
14.	        // 删除的是第一个节点，更新头指针就行  
15.	        listener_ = listener->previous_listener_;  
16.	      break;  
17.	    }  
18.	  }  
19.	  // 重置被删除listener的字段 
20.	  listener->stream_ = nullptr;  
21.	  listener->previous_listener_ = nullptr;  
22.	}  
```

3 申请存储数据

```
1.	// 申请一块内存  
2.	inline uv_buf_t StreamResource::EmitAlloc(size_t suggested_size) {  
3.	  DebugSealHandleScope handle_scope(v8::Isolate::GetCurrent());  
4.	  return listener_->OnStreamAlloc(suggested_size);  
5.	}  
```

StreamResource只是定义了操作流的通用逻辑，数据存储和消费由listener定义。
4 数据可读

```
1.	inline void StreamResource::EmitRead(ssize_t nread, const uv_buf_t& buf) {  
2.	  if (nread > 0)  
3.	    // 记录从流中读取的数据的字节大小
4.	    bytes_read_ += static_cast<uint64_t>(nread);  
5.	  listener_->OnStreamRead(nread, buf);  
6.	}  
```

5 写回调

```
1.	inline void StreamResource::EmitAfterWrite(WriteWrap* w, int status) {  
2.	  DebugSealHandleScope handle_scope(v8::Isolate::GetCurrent());  
3.	  listener_->OnStreamAfterWrite(w, status);  
4.	}  
```

6 关闭流回调

```
1.	inline void StreamResource::EmitAfterShutdown(ShutdownWrap* w, int status) {  
2.	  DebugSealHandleScope handle_scope(v8::Isolate::GetCurrent());  
3.	  listener_->OnStreamAfterShutdown(w, status);  
4.	}  
```

7 流销毁回调

```
1.	inline StreamResource::~StreamResource() {  
2.	  while (listener_ != nullptr) {  
3.	    StreamListener* listener = listener_;  
4.	    listener->OnStreamDestroy();  
5.	    if (listener == listener_)  
6.	      RemoveStreamListener(listener_);  
7.	  }  
8.	}  
```

流销毁后需要通知listener，并且解除关系。
### 6.8.2 StreamBase
StreamBase是StreamResource的子类，拓展了StreamResource的功能。

```
1.	class StreamBase : public StreamResource {  
2.	 public:  
3.	  static constexpr int kStreamBaseField = 1;  
4.	  static constexpr int kOnReadFunctionField = 2;  
5.	  static constexpr int kStreamBaseFieldCount = 3;  
6.	  // 定义一些统一的逻辑  
7.	  static void AddMethods(Environment* env,  
8.	                         v8::Local<v8::FunctionTemplate> target);
9.	  
10.	  virtual bool IsAlive() = 0;  
11.	  virtual bool IsClosing() = 0;  
12.	  virtual bool IsIPCPipe();  
13.	  virtual int GetFD();  
14.	  
15.	  // 执行JS回调  
16.	  v8::MaybeLocal<v8::Value> CallJSOnreadMethod(  
17.	      ssize_t nread,  
18.	      v8::Local<v8::ArrayBuffer> ab,  
19.	      size_t offset = 0,  
20.	      StreamBaseJSChecks checks = DONT_SKIP_NREAD_CHECKS);  
21.	  
22.	  Environment* stream_env() const;  
23.	  // 关闭流  
24.	  int Shutdown(v8::Local<v8::Object> req_wrap_obj = v8::Local<v8::Object>());  
25.	  // 写入流  
26.	  StreamWriteResult Write(  
27.	      uv_buf_t* bufs,  
28.	      size_t count,  
29.	      uv_stream_t* send_handle = nullptr,  
30.	      v8::Local<v8::Object> req_wrap_obj = v8::Local<v8::Object>());  
31.	  // 创建一个关闭请求  
32.	  virtual ShutdownWrap* CreateShutdownWrap(v8::Local<v8::Object> object);  
33.	  // 创建一个写请求  
34.	  virtual WriteWrap* CreateWriteWrap(v8::Local<v8::Object> object);  
35.	  
36.	  virtual AsyncWrap* GetAsyncWrap() = 0;  
37.	  virtual v8::Local<v8::Object> GetObject();  
38.	  static StreamBase* FromObject(v8::Local<v8::Object> obj);  
39.	  
40.	 protected:  
41.	  explicit StreamBase(Environment* env);  
42.	  
43.	  // JS Methods  
44.	  int ReadStartJS(const v8::FunctionCallbackInfo<v8::Value>& args);  
45.	  // 省略系列方法
46.	  void AttachToObject(v8::Local<v8::Object> obj);  
47.	  
48.	  template <int (StreamBase::*Method)(  
49.	      const v8::FunctionCallbackInfo<v8::Value>& args)>  
50.	  static void JSMethod(const v8::FunctionCallbackInfo<v8::Value>& args);  
51.	    
52.	 private:  
53.	  Environment* env_;  
54.	  EmitToJSStreamListener default_listener_;  
55.	  
56.	  void SetWriteResult(const StreamWriteResult& res);  
57.	  static void AddMethod(Environment* env,  
58.	                        v8::Local<v8::Signature> sig,  
59.	                        enum v8::PropertyAttribute attributes,  
60.	                        v8::Local<v8::FunctionTemplate> t,  
61.	                        JSMethodFunction* stream_method,  
62.	                        v8::Local<v8::String> str);   
63.	};  
```

1 初始化

```
1.	inline StreamBase::StreamBase(Environment* env) : env_(env) {  
2.	  PushStreamListener(&default_listener_);  
3.	}  
```

StreamBase初始化的时候会默认设置一个listener。
2 关闭流

```
1.	// 关闭一个流，req_wrap_obj是JS层传进来的对象  
2.	inline int StreamBase::Shutdown(v8::Local<v8::Object> req_wrap_obj) {  
3.	  Environment* env = stream_env();  
4.	  HandleScope handle_scope(env->isolate());  
5.	  AsyncHooks::DefaultTriggerAsyncIdScope trigger_scope(GetAsyncWrap());  
6.	  // 创建一个用于请求Libuv的数据结构  
7.	  ShutdownWrap* req_wrap = CreateShutdownWrap(req_wrap_obj); 
8.	  // 子类实现，不同流关闭的逻辑不一样 
9.	  int err = DoShutdown(req_wrap);  
10.	  // 执行出错则销毁JS层对象  
11.	  if (err != 0 && req_wrap != nullptr) {  
12.	    req_wrap->Dispose();  
13.	  }  
14.	  
15.	  const char* msg = Error();  
16.	  if (msg != nullptr) {  
17.	    req_wrap_obj->Set(  
18.	        env->context(),  
19.	        env->error_string(), 
20.	         OneByteString(env->isolate(), msg)).Check();  
21.	    ClearError();  
22.	  }  
23.	  
24.	  return err;  
25.	}  
```

3 写

```
1.	// 写Buffer，支持发送文件描述符  
2.	int StreamBase::WriteBuffer(const FunctionCallbackInfo<Value>& args) {  
3.	  Environment* env = Environment::GetCurrent(args);  
4.	   
5.	  Local<Object> req_wrap_obj = args[0].As<Object>();  
6.	  uv_buf_t buf;  
7.	  // 数据内容和长度  
8.	  buf.base = Buffer::Data(args[1]);  
9.	  buf.len = Buffer::Length(args[1]);  
10.	  
11.	  uv_stream_t* send_handle = nullptr;  
12.	  // 是对象并且流支持发送文件描述符  
13.	  if (args[2]->IsObject() && IsIPCPipe()) {  
14.	    Local<Object> send_handle_obj = args[2].As<Object>();  
15.	  
16.	    HandleWrap* wrap;  
17.	    // 从返回js的对象中获取internalField中指向的C++层对象  
18.	    ASSIGN_OR_RETURN_UNWRAP(&wrap, send_handle_obj, UV_EINVAL);  
19.	    // 拿到Libuv层的handle  
20.	    send_handle = reinterpret_cast<uv_stream_t*>(wrap->GetHandle());  
21.	    // Reference LibuvStreamWrap instance to prevent it from being garbage  
22.	    // collected before `AfterWrite` is called.  
23.	    // 设置到JS层请求对象中  
24.	    req_wrap_obj->Set(env->context(),  
25.	                      env->handle_string(),  
26.	                      send_handle_obj).Check();  
27.	  }  
28.	  
29.	  StreamWriteResult res = Write(&buf, 1, send_handle, req_wrap_obj);  
30.	  SetWriteResult(res);  
31.	  
32.	  return res.err;  
33.	}  
```

```
1.	inline StreamWriteResult StreamBase::Write(  
2.	    uv_buf_t* bufs,  
3.	    size_t count,  
4.	    uv_stream_t* send_handle,  
5.	    v8::Local<v8::Object> req_wrap_obj) {  
6.	  Environment* env = stream_env();  
7.	  int err;  
8.	  
9.	  size_t total_bytes = 0;  
10.	  // 计算需要写入的数据大小  
11.	  for (size_t i = 0; i < count; ++i)  
12.	    total_bytes += bufs[i].len;  
13.	  // 同上  
14.	  bytes_written_ += total_bytes;  
15.	  // 是否需要发送文件描述符，不需要则直接写  
16.	  if (send_handle == nullptr) {  
17.	    err = DoTryWrite(&bufs, &count);  
18.	    if (err != 0 || count == 0) {  
19.	      return StreamWriteResult { false, err, nullptr, total_bytes };  
20.	    }  
21.	  }  
22.	  
23.	  HandleScope handle_scope(env->isolate());  
24.	  
25.	  AsyncHooks::DefaultTriggerAsyncIdScope trigger_scope(GetAsyncWrap());  
26.	  // 创建一个用于请求Libuv的写请求对象  
27.	  WriteWrap* req_wrap = CreateWriteWrap(req_wrap_obj);  
28.	  // 执行写，子类实现，不同流写操作不一样  
29.	  err = DoWrite(req_wrap, bufs, count, send_handle);  
30.	  
31.	  const char* msg = Error();  
32.	  if (msg != nullptr) {  
33.	    req_wrap_obj->Set(env->context(),  
34.	                      env->error_string(),  
35.	                      OneByteString(env->isolate(), msg)).Check();  
36.	    ClearError();  
37.	  }  
38.	  
39.	  return StreamWriteResult { async, err, req_wrap, total_bytes };  
40.	}  
```

4 读

```
1.	// 操作流，启动读取  
2.	int StreamBase::ReadStartJS(const FunctionCallbackInfo<Value>& args) {  
3.	  return ReadStart();  
4.	}  
5.	  
6.	// 操作流，停止读取  
7.	int StreamBase::ReadStopJS(const FunctionCallbackInfo<Value>& args) {  
8.	  return ReadStop();  
9.	}  
10.	  
11.	// 触发流事件，有数据可读  
12.	MaybeLocal<Value> StreamBase::CallJSOnreadMethod(ssize_t nread, 
13.	                                                  Local<ArrayBuffer> ab,  
14.	                                                 size_t offset, 
15.	                                                 StreamBaseJSChecks checks) {  
16.	  Environment* env = env_;  
17.	  env->stream_base_state()[kReadBytesOrError] = nread;  
18.	  env->stream_base_state()[kArrayBufferOffset] = offset;  
19.	  
20.	  Local<Value> argv[] = {  
21.	    ab.IsEmpty() ? Undefined(env->isolate()).As<Value>() : ab.As<Value>()  
22.	  };  
23.	  // GetAsyncWrap在StreamBase子类实现，拿到StreamBase类对象  
24.	  AsyncWrap* wrap = GetAsyncWrap();  
25.	  // 获取回调执行  
26.	  Local<Value> onread = wrap->object()->GetInternalField(kOnReadFunctionField);   
27.	  return wrap->MakeCallback(onread.As<Function>(), arraysize(argv), argv);  
28.	}  
```

4 流通用方法

```
1.	void StreamBase::AddMethod(Environment* env,  
2.	                           Local<Signature> signature,  
3.	                           enum PropertyAttribute attributes,  
4.	                           Local<FunctionTemplate> t,  
5.	                           JSMethodFunction* stream_method,  
6.	                           Local<String> string) {  
7.	  // 新建一个函数模板                             
8.	  Local<FunctionTemplate> templ =  
9.	      env->NewFunctionTemplate(stream_method,  
10.	                               signature,  
11.	                               v8::ConstructorBehavior::kThrow,  
12.	                               v8::SideEffectType::kHasNoSideEffect);  
13.	  // 设置原型属性  
14.	  t->PrototypeTemplate()->SetAccessorProperty(  
15.	      string, templ, Local<FunctionTemplate>(), attributes);  
16.	}  
17.	  
18.	void StreamBase::AddMethods(Environment* env, Local<FunctionTemplate> t) {  
19.	  HandleScope scope(env->isolate());  
20.	  
21.	  enum PropertyAttribute attributes =  
22.	      static_cast<PropertyAttribute>(ReadOnly | DontDelete | DontEnum);  
23.	  Local<Signature> sig = Signature::New(env->isolate(), t);  
24.	  // 设置原型属性  
25.	  AddMethod(env, sig, attributes, t, GetFD, env->fd_string());  
26.	  // 忽略部分
27.	  env->SetProtoMethod(t, "readStart", JSMethod<&StreamBase::ReadStartJS>);  
28.	  env->SetProtoMethod(t, "readStop", JSMethod<&StreamBase::ReadStopJS>);  
29.	  env->SetProtoMethod(t, "shutdown", JSMethod<&StreamBase::Shutdown>);  
30.	  env->SetProtoMethod(t, "writev", JSMethod<&StreamBase::Writev>);  
31.	  env->SetProtoMethod(t, "writeBuffer", JSMethod<&StreamBase::WriteBuffer>);  
32.	  env->SetProtoMethod(  
33.	      t, "writeAsciiString", JSMethod<&StreamBase::WriteString<ASCII>>);  
34.	  env->SetProtoMethod(  
35.	      t, "writeUtf8String", JSMethod<&StreamBase::WriteString<UTF8>>);  
36.	  t->PrototypeTemplate()->Set(FIXED_ONE_BYTE_STRING(env->isolate(),  
37.	                                                    "isStreamBase"),  
38.	                              True(env->isolate()));  
39.	  // 设置访问器                              
40.	  t->PrototypeTemplate()->SetAccessor(  
41.	      // 键名  
42.	      FIXED_ONE_BYTE_STRING(env->isolate(), "onread"),  
43.	      // getter  
44.	      BaseObject::InternalFieldGet<kOnReadFunctionField>,  
45.	      // setter，Value::IsFunction是set之前的校验函数，见InternalFieldSet（模板函数）定义  
46.	      BaseObject::InternalFieldSet<kOnReadFunctionField, &Value::IsFunction>);  
47.	}  
```

5 其它函数

```
1.	// 默认false，子类重写  
2.	bool StreamBase::IsIPCPipe() {  
3.	  return false;  
4.	}  
5.	  
6.	// 子类重写  
7.	int StreamBase::GetFD() {  
8.	  return -1;  
9.	}  
10.	  
11.	Local<Object> StreamBase::GetObject() {  
12.	  return GetAsyncWrap()->object();  
13.	}  
14.	  
15.	// 工具函数和实例this无关，和入参有关  
16.	void StreamBase::GetFD(const FunctionCallbackInfo<Value>& args) {  
17.	  // Mimic implementation of StreamBase::GetFD() and UDPWrap::GetFD().  
18.	  // 从JS层对象获取它关联的C++对象，不一定是this  
19.	  StreamBase* wrap = StreamBase::FromObject(args.This().As<Object>());  
20.	  if (wrap == nullptr) return args.GetReturnValue().Set(UV_EINVAL);  
21.	  
22.	  if (!wrap->IsAlive()) return args.GetReturnValue().Set(UV_EINVAL);  
23.	  
24.	  args.GetReturnValue().Set(wrap->GetFD());  
25.	}  
26.	  
27.	void StreamBase::GetBytesRead(const FunctionCallbackInfo<Value>& args) {  
28.	  StreamBase* wrap = StreamBase::FromObject(args.This().As<Object>());  
29.	  if (wrap == nullptr) return args.GetReturnValue().Set(0);  
30.	  
31.	  // uint64_t -> double. 53bits is enough for all real cases.  
32.	  args.GetReturnValue().Set(static_cast<double>(wrap->bytes_read_));  
33.	}  
```

### 6.8.3 LibuvStreamWrap
LibuvStreamWrap是StreamBase的子类。实现了父类的接口，也拓展了流的能力。

```
1.	class LibuvStreamWrap : public HandleWrap, public StreamBase {  
2.	 public:  
3.	  static void Initialize(v8::Local<v8::Object> target,  
4.	                         v8::Local<v8::Value> unused,  
5.	                         v8::Local<v8::Context> context,  
6.	                         void* priv);  
7.	  
8.	  int GetFD() override;  
9.	  bool IsAlive() override;  
10.	 bool IsClosing() override;  
11.	 bool IsIPCPipe() override;  
12.	  
13.	 // JavaScript functions  
14.	 int ReadStart() override;  
15.	 int ReadStop() override;  
16.	  
17.	 // Resource implementation  
18.	 int DoShutdown(ShutdownWrap* req_wrap) override;  
19.	 int DoTryWrite(uv_buf_t** bufs, size_t* count) override;  
20.	 int DoWrite(WriteWrap* w,  
21.	             uv_buf_t* bufs,  
22.	             size_t count,  
23.	             uv_stream_t* send_handle) override;  
24.	  
25.	 inline uv_stream_t* stream() const {  
26.	   return stream_;  
27.	 }  
28.	 // 是否是Unix域或命名管道  
29.	 inline bool is_named_pipe() const {  
30.	   return stream()->type == UV_NAMED_PIPE;  
31.	 }  
32.	 // 是否是Unix域并且支持传递文件描述符  
33.	 inline bool is_named_pipe_ipc() const {  
34.	   return is_named_pipe() &&  
35.	          reinterpret_cast<const uv_pipe_t*>(stream())->ipc != 0;  
36.	 }  
37.	  
38.	 inline bool is_tcp() const {  
39.	   return stream()->type == UV_TCP;  
40.	 }  
41.	 // 创建请求Libuv的对象  
42.	 ShutdownWrap* CreateShutdownWrap(v8::Local<v8::Object> object) override;  
43.	 WriteWrap* CreateWriteWrap(v8::Local<v8::Object> object) override;  
44.	 // 从JS层对象获取对于的C++对象  
45.	 static LibuvStreamWrap* From(Environment* env, v8::Local<v8::Object> object);  
46.	  
47.	protected:  
48.	 LibuvStreamWrap(Environment* env,  
49.	                 v8::Local<v8::Object> object,  
50.	                 uv_stream_t* stream,  
51.	                 AsyncWrap::ProviderType provider);  
52.	  
53.	 AsyncWrap* GetAsyncWrap() override;  
54.	  
55.	 static v8::Local<v8::FunctionTemplate> GetConstructorTemplate( 
56.	     Environment* env);  
57.	  
58.	private:  
59.	 static void GetWriteQueueSize(  
60.	     const v8::FunctionCallbackInfo<v8::Value>& info);  
61.	 static void SetBlocking(const v8::FunctionCallbackInfo<v8::Value>& args);  
62.	  
63.	 // Callbacks for libuv  
64.	 void OnUvAlloc(size_t suggested_size, uv_buf_t* buf);  
65.	 void OnUvRead(ssize_t nread, const uv_buf_t* buf);  
66.	 
67.	 static void AfterUvWrite(uv_write_t* req, int status);  
68.	 static void AfterUvShutdown(uv_shutdown_t* req, int status);  
69.	  
70.	 uv_stream_t* const stream_;  
71.	};  
```

1 初始化

```
1.	LibuvStreamWrap::LibuvStreamWrap(Environment* env,  
2.	                                 Local<Object> object,  
3.	                                 uv_stream_t* stream,  
4.	                                 AsyncWrap::ProviderType provider)  
5.	    : HandleWrap(env,  
6.	                 object,  
7.	                 reinterpret_cast<uv_handle_t*>(stream),  
8.	                 provider),  
9.	      StreamBase(env),  
10.	      stream_(stream) {  
11.	  StreamBase::AttachToObject(object);  
12.	}  
```

LibuvStreamWrap初始化的时候，会把JS层使用的对象的内部指针指向自己，见HandleWrap。
2 写操作

```
1.	// 工具函数，获取待写数据字节的大小  
2.	void LibuvStreamWrap::GetWriteQueueSize(  
3.	    const FunctionCallbackInfo<Value>& info) {  
4.	  LibuvStreamWrap* wrap;  
5.	  ASSIGN_OR_RETURN_UNWRAP(&wrap, info.This());  
6.	  uint32_t write_queue_size = wrap->stream()->write_queue_size;  
7.	  info.GetReturnValue().Set(write_queue_size);  
8.	}  
9.	  
10.	// 设置非阻塞  
11.	void LibuvStreamWrap::SetBlocking(const FunctionCallbackInfo<Value>& args) {  
12.	  LibuvStreamWrap* wrap;  
13.	  ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());
14.	  bool enable = args[0]->IsTrue();  
15.	  args.GetReturnValue().Set(uv_stream_set_blocking(wrap->stream(), enable));  
16.	}  
17.	// 定义一个关闭的请求  
18.	typedef SimpleShutdownWrap<ReqWrap<uv_shutdown_t>> LibuvShutdownWrap;  
19.	// 定义一个写请求  
20.	typedef SimpleWriteWrap<ReqWrap<uv_write_t>> LibuvWriteWrap;  
21.	  
22.	ShutdownWrap* LibuvStreamWrap::CreateShutdownWrap(Local<Object> object) {  
23.	  return new LibuvShutdownWrap(this, object);  
24.	}  
25.	  
26.	WriteWrap* LibuvStreamWrap::CreateWriteWrap(Local<Object> object) {  
27.	  return new LibuvWriteWrap(this, object);  
28.	}  
29.	  
30.	// 发起关闭请求，由父类调用，req_wrap是C++层创建的对象  
31.	int LibuvStreamWrap::DoShutdown(ShutdownWrap* req_wrap_) {  
32.	  LibuvShutdownWrap* req_wrap = static_cast<LibuvShutdownWrap*>(req_wrap_);  
33.	  return req_wrap->Dispatch(uv_shutdown, stream(), AfterUvShutdown);  
34.	}  
35.	  
36.	// 关闭请求结束后执行请求的通用回调Done  
37.	void LibuvStreamWrap::AfterUvShutdown(uv_shutdown_t* req, int status) {  
38.	  LibuvShutdownWrap* req_wrap = static_cast<LibuvShutdownWrap*>(
39.	      LibuvShutdownWrap::from_req(req));   
40.	  HandleScope scope(req_wrap->env()->isolate());  
41.	  Context::Scope context_scope(req_wrap->env()->context());  
42.	  req_wrap->Done(status);  
43.	}  
44.	  
45.	int LibuvStreamWrap::DoTryWrite(uv_buf_t** bufs, size_t* count) {  
46.	  int err;  
47.	  size_t written;  
48.	  uv_buf_t* vbufs = *bufs;  
49.	  size_t vcount = *count;  
50.	  
51.	  err = uv_try_write(stream(), vbufs, vcount);  
52.	  if (err == UV_ENOSYS || err == UV_EAGAIN)  
53.	    return 0;  
54.	  if (err < 0)  
55.	    return err;  
56.	  // 写成功的字节数，更新数据  
57.	  written = err;  
58.	  for (; vcount > 0; vbufs++, vcount--) {  
59.	    // Slice  
60.	    if (vbufs[0].len > written) {  
61.	      vbufs[0].base += written;  
62.	      vbufs[0].len -= written;  
63.	      written = 0;  
64.	      break;  
65.	  
66.	    // Discard  
67.	    } else {  
68.	      written -= vbufs[0].len;  
69.	    }  
70.	  }  
71.	  
72.	  *bufs = vbufs;  
73.	  *count = vcount;  
74.	  
75.	  return 0;  
76.	}  
77.	  
78.	  
79.	int LibuvStreamWrap::DoWrite(WriteWrap* req_wrap,  
80.	                             uv_buf_t* bufs,  
81.	                             size_t count,  
82.	                             uv_stream_t* send_handle) {  
83.	  LibuvWriteWrap* w = static_cast<LibuvWriteWrap*>(req_wrap);  
84.	  return w->Dispatch(uv_write2,  
85.	                     stream(),  
86.	                     bufs,  
87.	                     count,  
88.	                     send_handle,  
89.	                     AfterUvWrite);  
90.	}  
91.	  
92.	  
93.	  
94.	void LibuvStreamWrap::AfterUvWrite(uv_write_t* req, int status) {  
95.	  LibuvWriteWrap* req_wrap = static_cast<LibuvWriteWrap*>(  
96.	      LibuvWriteWrap::from_req(req));    
97.	  HandleScope scope(req_wrap->env()->isolate());  
98.	  Context::Scope context_scope(req_wrap->env()->context());  
99.	  req_wrap->Done(status);  
100.	}  
```

3 读操作

```
1.	// 调用Libuv实现启动读逻辑  
2.	int LibuvStreamWrap::ReadStart() {  
3.	  return uv_read_start(stream(), [](uv_handle_t* handle,  
4.	                                    size_t suggested_size,  
5.	                                    uv_buf_t* buf) {  
6.	    static_cast<LibuvStreamWrap*>(handle->data)->OnUvAlloc(suggested_size, buf);  
7.	  }, [](uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {  
8.	    static_cast<LibuvStreamWrap*>(stream->data)->OnUvRead(nread, buf);  
9.	  });  
10.	}  
11.	  
12.	// 实现停止读逻辑  
13.	int LibuvStreamWrap::ReadStop() {  
14.	  return uv_read_stop(stream());  
15.	}  
16.	  
17.	// 需要分配内存时的回调，由Libuv回调，具体分配内存逻辑由listener实现  
18.	void LibuvStreamWrap::OnUvAlloc(size_t suggested_size, uv_buf_t* buf) {  
19.	  HandleScope scope(env()->isolate());  
20.	  Context::Scope context_scope(env()->context());  
21.	  
22.	  *buf = EmitAlloc(suggested_size);  
23.	}  
24.	// 处理传递的文件描述符  
25.	template <class WrapType>  
26.	static MaybeLocal<Object> AcceptHandle(Environment* env,  
27.	                                       LibuvStreamWrap* parent) {    
28.	  EscapableHandleScope scope(env->isolate());  
29.	  Local<Object> wrap_obj;  
30.	  // 根据类型创建一个表示客户端的对象，然后把文件描述符保存其中  
31.	  if (!WrapType::Instantiate(env, parent, WrapType::SOCKET).ToLocal(&wrap_obj))  
32.	    return Local<Object>();  
33.	  // 解出C++层对象  
34.	  HandleWrap* wrap = Unwrap<HandleWrap>(wrap_obj);  
35.	  CHECK_NOT_NULL(wrap);  
36.	  // 拿到C++对象中封装的handle  
37.	  uv_stream_t* stream = reinterpret_cast<uv_stream_t*>(wrap->GetHandle());   
38.	  // 从服务器流中摘下一个fd保存到steam  
39.	  if (uv_accept(parent->stream(), stream))  
40.	    ABORT();  
41.	  
42.	  return scope.Escape(wrap_obj);  
43.	}  
44.	  
45.	// 实现OnUvRead，流中有数据或读到结尾时由Libuv回调  
46.	void LibuvStreamWrap::OnUvRead(ssize_t nread, const uv_buf_t* buf) {  
47.	  HandleScope scope(env()->isolate());  
48.	  Context::Scope context_scope(env()->context());  
49.	  uv_handle_type type = UV_UNKNOWN_HANDLE;  
50.	  // 是否支持传递文件描述符并且有待处理的文件描述符，则判断文件描述符类型  
51.	  if (is_named_pipe_ipc() &&  
52.	      uv_pipe_pending_count(reinterpret_cast<uv_pipe_t*>(stream())) > 0) {  
53.	    type = uv_pipe_pending_type(reinterpret_cast<uv_pipe_t*>(stream()));  
54.	  }  
55.	 
56.	  // 读取成功  
57.	  if (nread > 0) {  
58.	    MaybeLocal<Object> pending_obj;  
59.	    // 根据类型创建一个新的C++对象表示客户端，并且从服务器中摘下一个fd保存到客户端  
60.	    if (type == UV_TCP) {  
61.	      pending_obj = AcceptHandle<TCPWrap>(env(), this);  
62.	    } else if (type == UV_NAMED_PIPE) {  
63.	      pending_obj = AcceptHandle<PipeWrap>(env(), this);  
64.	    } else if (type == UV_UDP) {  
65.	      pending_obj = AcceptHandle<UDPWrap>(env(), this);  
66.	    } else {  
67.	      CHECK_EQ(type, UV_UNKNOWN_HANDLE);  
68.	    }  
69.	    // 有需要处理的文件描述符则设置到JS层对象中，JS层使用  
70.	    if (!pending_obj.IsEmpty()) {  
71.	      object()  
72.	          ->Set(env()->context(),  
73.	                env()->pending_handle_string(),  
74.	                pending_obj.ToLocalChecked())  
75.	          .Check();  
76.	    }  
77.	  }  
78.	  // 触发读事件，listener实现  
79.	  EmitRead(nread, *buf);  
80.	}  
```

读操作不仅支持读取一般的数据，还可以读取文件描述符，C++层会新建一个流对象表示该文件描述符。在JS层可以使用。
### 6.8.4 ConnectionWrap
ConnectionWrap是LibuvStreamWrap子类，拓展了连接的接口。适用于带有连接属性的流，比如Unix域和TCP。

```
1.	// WrapType是C++层的类，UVType是Libuv的类型  
2.	template <typename WrapType, typename UVType>  
3.	class ConnectionWrap : public LibuvStreamWrap {  
4.	 public:  
5.	  static void OnConnection(uv_stream_t* handle, int status);  
6.	  static void AfterConnect(uv_connect_t* req, int status);  
7.	  
8.	 protected:  
9.	  ConnectionWrap(Environment* env,  
10.	                 v8::Local<v8::Object> object,  
11.	                 ProviderType provider);  
12.	  
13.	  UVType handle_;  
14.	};  
```

1 发起连接后的回调

```
1.	template <typename WrapType, typename UVType>  
2.	void ConnectionWrap<WrapType, UVType>::AfterConnect(uv_connect_t* req,  
3.	                                                    int status) {  
4.	  // 通过Libuv结构体拿到对应的C++对象     
5.	  std::unique_ptr<ConnectWrap> req_wrap =
6.	    (static_cast<ConnectWrap*>(req->data));  
7.	  WrapType* wrap = static_cast<WrapType*>(req->handle->data);  
8.	  Environment* env = wrap->env();  
9.	  
10.	  HandleScope handle_scope(env->isolate());  
11.	  Context::Scope context_scope(env->context());  
12.	  
13.	  bool readable, writable;  
14.	  // 连接结果  
15.	  if (status) {  
16.	    readable = writable = false;  
17.	  } else {  
18.	    readable = uv_is_readable(req->handle) != 0;  
19.	    writable = uv_is_writable(req->handle) != 0;  
20.	  }  
21.	  
22.	  Local<Value> argv[5] = {  
23.	    Integer::New(env->isolate(), status),  
24.	    wrap->object(),  
25.	    req_wrap->object(),  
26.	    Boolean::New(env->isolate(), readable),  
27.	    Boolean::New(env->isolate(), writable)  
28.	  };  
29.	  // 回调js  
30.	  req_wrap->MakeCallback(env->oncomplete_string(), 
31.	                            arraysize(argv), 
32.	                            argv);  
33.	}  
```

2 连接到来时回调

```
1.	// 有连接时触发的回调  
2.	template <typename WrapType, typename UVType>  
3.	void ConnectionWrap<WrapType, UVType>::OnConnection(uv_stream_t* handle,  
4.	                                                    int status) {  
5.	  // 拿到Libuv结构体对应的C++层对象                               
6.	  WrapType* wrap_data = static_cast<WrapType*>(handle->data);  
7.	  Environment* env = wrap_data->env();  
8.	  HandleScope handle_scope(env->isolate());  
9.	  Context::Scope context_scope(env->context());  
10.	  
11.	  // 和客户端通信的对象  
12.	  Local<Value> client_handle;  
13.	  
14.	  if (status == 0) {  
15.	    // Instantiate the client javascript object and handle.  
16.	    // 新建一个JS层使用对象  
17.	    Local<Object> client_obj;  
18.	    if (!WrapType::Instantiate(env, wrap_data, WrapType::SOCKET)
19.	             .ToLocal(&client_obj))  
20.	      return;  
21.	  
22.	    // Unwrap the client javascript object.  
23.	    WrapType* wrap;  
24.	    // 把JS层使用的对象client_obj所对应的C++层对象存到wrap中  
25.	    ASSIGN_OR_RETURN_UNWRAP(&wrap, client_obj);  
26.	    // 拿到对应的handle  
27.	    uv_stream_t* client = reinterpret_cast<uv_stream_t*>(&wrap->handle_);  
28.	     
29.	    // 从handleaccpet到的fd中拿一个保存到client，client就可以和客户端通信了  
30.	    if (uv_accept(handle, client))  
31.	      return;  
32.	      client_handle = client_obj;  
33.	  } else {  
34.	    client_handle = Undefined(env->isolate());  
35.	  }  
36.	  // 回调JS，client_handle相当于在JS层执行new TCP  
37.	  Local<Value> argv[] = { 
38.	                             Integer::New(env->isolate(), status), 
39.	                             client_handle 
40.	                           };  
41.	  wrap_data->MakeCallback(env->onconnection_string(), 
42.	                             arraysize(argv), 
43.	                             argv);  
44.	}  
```

我们看一下TCP的Instantiate。

```
1.	MaybeLocal<Object> TCPWrap::Instantiate(Environment* env,  
2.	                                        AsyncWrap* parent,  
3.	                                        TCPWrap::SocketType type) {  
4.	  EscapableHandleScope handle_scope(env->isolate());  
5.	  AsyncHooks::DefaultTriggerAsyncIdScope trigger_scope(parent); 
6.	
7.	  // 拿到导出到JS层的TCP构造函数，缓存在env中  
8.	  Local<Function> constructor = env->tcp_constructor_template()  
9.	                                    ->GetFunction(env->context())
10.	                                    .ToLocalChecked();  
11.	  Local<Value> type_value = Int32::New(env->isolate(), type);  
12.	  // 相当于我们在JS层调用new TCP()时拿到的对象  
13.	  return handle_scope.EscapeMaybe(  
14.	      constructor->NewInstance(env->context(), 1, &type_value));  
15.	}  
```

### 6.8.5 StreamReq
StreamReq表示操作流的一次请求。主要保存了请求上下文和操作结束后的通用逻辑。

```
1.	// 请求Libuv的基类  
2.	class StreamReq {  
3.	 public:  
4.	 // JS层传进来的对象的internalField[1]保存了StreamReq类对象  
5.	  static constexpr int kStreamReqField = 1;  
6.	  // stream为所操作的流，req_wrap_obj为JS层传进来的对象  
7.	  explicit StreamReq(StreamBase* stream,  
8.	                     v8::Local<v8::Object> req_wrap_obj) : stream_(stream) {  
9.	    // JS层对象指向当前StreamReq对象                     
10.	    AttachToObject(req_wrap_obj);  
11.	  }   
12.	  // 子类定义  
13.	  virtual AsyncWrap* GetAsyncWrap() = 0;  
14.	  // 获取相关联的原始js对象  
15.	  v8::Local<v8::Object> object();  
16.	  // 请求结束后的回调，会执行子类的onDone，onDone由子类实现  
17.	  void Done(int status, const char* error_str = nullptr);  
18.	  // JS层对象不再执行StreamReq实例  
19.	  void Dispose();  
20.	  // 获取所操作的流  
21.	  inline StreamBase* stream() const { return stream_; }  
22.	  // 从JS层对象获取StreamReq对象  
23.	  static StreamReq* FromObject(v8::Local<v8::Object> req_wrap_obj);  
24.	  // 请求JS层对象的internalField所有指向  
25.	  static inline void ResetObject(v8::Local<v8::Object> req_wrap_obj);  
26.	  
27.	 protected:  
28.	  // 请求结束后回调
29.	  virtual void OnDone(int status) = 0;  
30.	  void AttachToObject(v8::Local<v8::Object> req_wrap_obj);  
31.	  
32.	 private:  
33.	  StreamBase* const stream_;  
34.	};  
```

StreamReq有一个成员为stream_，表示StreamReq请求中操作的流。下面我们看一下实现。
1 JS层请求上下文和StreamReq的关系管理。

```
1.	inline void StreamReq::AttachToObject(v8::Local<v8::Object> req_wrap_obj) {   
2.	  req_wrap_obj->SetAlignedPointerInInternalField(kStreamReqField,                                                      this);  
3.	}  
4.	  
5.	inline StreamReq* StreamReq::FromObject(v8::Local<v8::Object> req_wrap_obj) {  
6.	  return static_cast<StreamReq*>(  
7.	      req_wrap_obj->GetAlignedPointerFromInternalField(kStreamReqField));  
8.	}  
9.	  
10.	inline void StreamReq::Dispose() {  
11.	  object()->SetAlignedPointerInInternalField(kStreamReqField, nullptr);  
12.	  delete this;  
13.	}  
14.	  
15.	inline void StreamReq::ResetObject(v8::Local<v8::Object> obj) { 
16.	  obj->SetAlignedPointerInInternalField(0, nullptr); // BaseObject field.  
17.	  obj->SetAlignedPointerInInternalField(StreamReq::kStreamReqField, nullptr);  
18.	}  
```

2 获取原始JS层请求对象

```
1.	// 获取和该请求相关联的原始js对象  
2.	inline v8::Local<v8::Object> StreamReq::object() {  
3.	  return GetAsyncWrap()->object();  
4.	}  
```

3 请求结束回调

```
1.	inline void StreamReq::Done(int status, const char* error_str) {  
2.	  AsyncWrap* async_wrap = GetAsyncWrap();  
3.	  Environment* env = async_wrap->env();  
4.	  if (error_str != nullptr) {  
5.	    async_wrap->object()->Set(env->context(),  
6.	                              env->error_string(),  
7.	                              OneByteString(env->isolate(), 
8.	                                                 error_str))  
9.	                              .Check();  
10.	  }  
11.	  // 执行子类的OnDone  
12.	  OnDone(status);  
13.	}  
```

流操作请求结束后会统一执行Done，Done会执行子类实现的OnDone函数。
### 6.8.6 ShutdownWrap
ShutdownWrap是StreamReq的子类，表示一次关闭流请求。

```
1.	class ShutdownWrap : public StreamReq {  
2.	 public:  
3.	  ShutdownWrap(StreamBase* stream,  
4.	               v8::Local<v8::Object> req_wrap_obj)  
5.	    : StreamReq(stream, req_wrap_obj) { }  
6.	  
7.	  void OnDone(int status) override;  
8.	};  
```

ShutdownWrap实现了OnDone接口，在关闭流结束后被基类执行。

```
1.	/* 
2.	  关闭结束时回调，由请求类（ShutdownWrap）调用Libuv， 
3.	  所以Libuv操作完成后，首先执行请求类的回调，请求类通知流，流触发 
4.	  对应的事件，进一步通知listener 
5.	*/  
6.	inline void ShutdownWrap::OnDone(int status) {  
7.	  stream()->EmitAfterShutdown(this, status);  
8.	  Dispose();  
9.	}  
```

### 6.8.7 SimpleShutdownWrap
SimpleShutdownWrap是ShutdownWrap的子类。实现了GetAsyncWrap接口。OtherBase可以是ReqWrap或者AsyncWrap。

```
1.	template <typename OtherBase>  
2.	class SimpleShutdownWrap : public ShutdownWrap, public OtherBase {  
3.	 public:  
4.	  SimpleShutdownWrap(StreamBase* stream,  
5.	                     v8::Local<v8::Object> req_wrap_obj);  
6.	  
7.	  AsyncWrap* GetAsyncWrap() override { return this; }
8.	};  
```

### 6.8.8 WriteWrap
WriteWrap是StreamReq的子类，表示一次往流写入数据的请求。

```
1.	class WriteWrap : public StreamReq {  
2.	 public:  
3.	  void SetAllocatedStorage(AllocatedBuffer&& storage);  
4.	  
5.	  WriteWrap(StreamBase* stream,  
6.	            v8::Local<v8::Object> req_wrap_obj)  
7.	    : StreamReq(stream, req_wrap_obj) { }  
8.	  
9.	  void OnDone(int status) override;  
10.	  
11.	 private:  
12.	  AllocatedBuffer storage_;  
13.	};  
```

WriteWrap实现了OnDone接口，在写结束时被基类执行。

```
1.	inline void WriteWrap::OnDone(int status) {  
2.	  stream()->EmitAfterWrite(this, status);  
3.	  Dispose();  
4.	}  
```

请求结束后调用流的接口通知流写结束了，流会通知listener，listener会调用流的接口通知JS层。
### 6.8.9 SimpleWriteWrap
SimpleWriteWrap是WriteWrap的子类。实现了GetAsyncWrap接口。和SimpleShutdownWrap类型。

```
1.	template <typename OtherBase>  
2.	class SimpleWriteWrap : public WriteWrap, public OtherBase {  
3.	 public:  
4.	  SimpleWriteWrap(StreamBase* stream,  
5.	                  v8::Local<v8::Object> req_wrap_obj);  
6.	  
7.	  AsyncWrap* GetAsyncWrap() override { return this; }  
8.	};  
```

### 6.8.10 StreamListener

```
1.	class StreamListener {  
2.	 public:  
3.	  virtual ~StreamListener();  
4.	  // 分配存储数据的内存  
5.	  virtual uv_buf_t OnStreamAlloc(size_t suggested_size) = 0;  
6.	  // 有数据可读时回调，消费数据的函数  
7.	  virtual void OnStreamRead(ssize_t nread, const uv_buf_t& buf) = 0;  
8.	  // 流销毁时回调  
9.	  virtual void OnStreamDestroy() {}  
10.	  // 监听者所属流  
11.	  inline StreamResource* stream() { return stream_; }  
12.	  
13.	 protected:  
14.	  // 流是监听者是一条链表，该函数把结构传递给下一个节点  
15.	  void PassReadErrorToPreviousListener(ssize_t nread);  
16.	  // 监听者所属流  
17.	  StreamResource* stream_ = nullptr;  
18.	  // 下一个节点，形成链表  
19.	  StreamListener* previous_listener_ = nullptr;  
20.	  friend class StreamResource;  
21.	};  
```

StreamListener是类似一个订阅者，它会对流的状态感兴趣，比如数据可读、可写、流关闭等。一个流可以注册多个listener，多个listener形成一个链表。

```
1.	// 从listen所属的流的listener队列中删除自己  
2.	inline StreamListener::~StreamListener() {  
3.	  if (stream_ != nullptr)  
4.	    stream_->RemoveStreamListener(this);  
5.	}  
6.	// 读出错，把信息传递给前一个listener  
7.	inline void StreamListener::PassReadErrorToPreviousListener(ssize_t nread) {  
8.	  CHECK_NOT_NULL(previous_listener_);  
9.	  previous_listener_->OnStreamRead(nread, uv_buf_init(nullptr, 0));  
10.	}  
11.	// 实现流关闭时的处理逻辑  
12.	inline void StreamListener::OnStreamAfterShutdown(ShutdownWrap* w, int status) {    
13.	  previous_listener_->OnStreamAfterShutdown(w, status);  
14.	}  
15.	// 实现写结束时的处理逻辑  
16.	inline void StreamListener::OnStreamAfterWrite(WriteWrap* w, int status) {    
17.	  previous_listener_->OnStreamAfterWrite(w, status);  
18.	}  
```

StreamListener的逻辑不多，具体的实现在子类。
### 6.8.11 ReportWritesToJSStreamListener
ReportWritesToJSStreamListener是StreamListener的子类。覆盖了部分接口和拓展了一些功能。

```
1.	class ReportWritesToJSStreamListener : public StreamListener {  
2.	 public:  
3.	  // 实现父类的这两个接口
4.	  void OnStreamAfterWrite(WriteWrap* w, int status) override;  
5.	  void OnStreamAfterShutdown(ShutdownWrap* w, int status) override;  
6.	  
7.	 private:  
8.	  void OnStreamAfterReqFinished(StreamReq* req_wrap, int status);  
9.	};  
```

1 OnStreamAfterReqFinished
OnStreamAfterReqFinished是请求操作流结束后的统一的回调。

```
1.	void ReportWritesToJSStreamListener::OnStreamAfterWrite(  
2.	    WriteWrap* req_wrap, int status) {  
3.	  OnStreamAfterReqFinished(req_wrap, status);  
4.	}  
5.	  
6.	void ReportWritesToJSStreamListener::OnStreamAfterShutdown(  
7.	    ShutdownWrap* req_wrap, int status) {  
8.	  OnStreamAfterReqFinished(req_wrap, status);  
9.	}  
```

我们看一下具体实现

```
1.	void ReportWritesToJSStreamListener::OnStreamAfterReqFinished(  
2.	    StreamReq* req_wrap, int status) {  
3.	  // 请求所操作的流  
4.	  StreamBase* stream = static_cast<StreamBase*>(stream_);  
5.	  Environment* env = stream->stream_env();  
6.	  AsyncWrap* async_wrap = req_wrap->GetAsyncWrap();  
7.	  HandleScope handle_scope(env->isolate());  
8.	  Context::Scope context_scope(env->context());  
9.	  // 获取原始的JS层对象  
10.	  Local<Object> req_wrap_obj = async_wrap->object();  
11.	  
12.	  Local<Value> argv[] = {  
13.	    Integer::New(env->isolate(), status),  
14.	    stream->GetObject(),  
15.	    Undefined(env->isolate())  
16.	  };  
17.	  
18.	  const char* msg = stream->Error();  
19.	  if (msg != nullptr) {  
20.	    argv[2] = OneByteString(env->isolate(), msg);  
21.	    stream->ClearError();  
22.	  }  
23.	  // 回调JS层  
24.	  if (req_wrap_obj->Has(env->context(), env->oncomplete_string()).FromJust())  
25.	    async_wrap->MakeCallback(env->oncomplete_string(), arraysize(argv), argv);  
26.	}  
```

OnStreamAfterReqFinished会回调JS层。
6.8.12 EmitToJSStreamListener
EmitToJSStreamListener是ReportWritesToJSStreamListener的子类

```
1.	class EmitToJSStreamListener : public ReportWritesToJSStreamListener {  
2.	 public:  
3.	  uv_buf_t OnStreamAlloc(size_t suggested_size) override;  
4.	  void OnStreamRead(ssize_t nread, const uv_buf_t& buf) override;  
5.	};  
```

我们看一下实现

```
1.	// 分配一块内存  
2.	uv_buf_t EmitToJSStreamListener::OnStreamAlloc(size_t suggested_size) {   
3.	  Environment* env = static_cast<StreamBase*>(stream_)->stream_env();  
4.	  return env->AllocateManaged(suggested_size).release();  
5.	}  
6.	// 读取数据结束后回调   
7.	void EmitToJSStreamListener::OnStreamRead(ssize_t nread, const uv_buf_t& buf_) {   
8.	    StreamBase* stream = static_cast<StreamBase*>(stream_);  
9.	  Environment* env = stream->stream_env();  
10.	  HandleScope handle_scope(env->isolate());  
11.	  Context::Scope context_scope(env->context());  
12.	  AllocatedBuffer buf(env, buf_);  
13.	  // 读取失败  
14.	  if (nread <= 0)  {  
15.	    if (nread < 0)  
16.	      stream->CallJSOnreadMethod(nread, Local<ArrayBuffer>());  
17.	    return;  
18.	  }  
19.	    
20.	  buf.Resize(nread);  
21.	  // 读取成功回调JS层  
22.	  stream->CallJSOnreadMethod(nread, buf.ToArrayBuffer());  
23.	}  
```

我们看到listener处理完数据后又会回调流的接口，具体的逻辑由子类实现。我们来看一个子类的实现（流默认的listener）。

```
1.	class EmitToJSStreamListener : public ReportWritesToJSStreamListener {  
2.	 public:  
3.	  uv_buf_t OnStreamAlloc(size_t suggested_size) override;  
4.	  void OnStreamRead(ssize_t nread, const uv_buf_t& buf) override;
5.	};  
```

EmitToJSStreamListener会实现OnStreamRead等方法，接着我们看一下创建一个C++层的TCP对象是怎样的。下面是TCPWrap的继承关系。

```
1.	class TCPWrap : public ConnectionWrap<TCPWrap, uv_tcp_t>{}  
2.	// ConnectionWrap拓展了建立TCP连接时的逻辑  
3.	class ConnectionWrap : public LibuvStreamWrap{}  
4.	class LibuvStreamWrap : public HandleWrap, public StreamBase{}  
5.	class StreamBase : public StreamResource {}  
```

我们看到TCP流是继承于StreamResource的。新建一个TCP的C++的对象时（tcp_wrap.cc），会不断往上调用父类的构造函数，其中在StreamBase中有一个关键的操作。

```
1.	inline StreamBase::StreamBase(Environment* env) : env_(env) {  
2.	  PushStreamListener(&default_listener_);  
3.	}  
4.	  
5.	EmitToJSStreamListener default_listener_;  
```

StreamBase会默认给流注册一个listener。我们看下EmitToJSStreamListener 具体的定义。

```
1.	class ReportWritesToJSStreamListener : public StreamListener {  
2.	 public:  
3.	  void OnStreamAfterWrite(WriteWrap* w, int status) override;  
4.	  void OnStreamAfterShutdown(ShutdownWrap* w, int status) override;  
5.	  
6.	 private:  
7.	  void OnStreamAfterReqFinished(StreamReq* req_wrap, int status);  
8.	};  
9.	  
10.	class EmitToJSStreamListener : public ReportWritesToJSStreamListener {  
11.	 public:  
12.	  uv_buf_t OnStreamAlloc(size_t suggested_size) override;  
13.	  void OnStreamRead(ssize_t nread, const uv_buf_t& buf) override;  
14.	};  
```

EmitToJSStreamListener继承StreamListener ，定义了分配内存和读取接收数据的函数。接着我们看一下PushStreamListener做了什么事情。

```
1.	inline void StreamResource::PushStreamListener(StreamListener* listener) {  
2.	  // 头插法   
3.	  listener->previous_listener_ = listener_;  
4.	  listener->stream_ = this;  
5.	  listener_ = listener;  
6.	}  
```

PushStreamListener就是构造出一个listener链表结构。然后我们看一下对于流来说，读取数据的整个链路。首先是JS层调用readStart

```
1.	function tryReadStart(socket) {  
2.	  socket._handle.reading = true;  
3.	  const err = socket._handle.readStart();  
4.	  if (err)  
5.	    socket.destroy(errnoException(err, 'read'));  
6.	}  
7.	  
8.	// 注册等待读事件  
9.	Socket.prototype._read = function(n) {  
10.	  tryReadStart(this);  
11.	};  
```

我们看看readStart

```
1.	int LibuvStreamWrap::ReadStart() {  
2.	  return uv_read_start(stream(), [](uv_handle_t* handle,  
3.	                                    size_t suggested_size,  
4.	                                    uv_buf_t* buf) {  
5.	    static_cast<LibuvStreamWrap*>(handle->data)->OnUvAlloc(suggested_size, buf);  
6.	  }, [](uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {  
7.	    static_cast<LibuvStreamWrap*>(stream->data)->OnUvRead(nread, buf);  
8.	  });  
9.	}  
```

ReadStart调用Libuv的uv_read_start注册等待可读事件，并且注册了两个回调函数OnUvAlloc和OnUvRead。

```
1.	void LibuvStreamWrap::OnUvRead(ssize_t nread, const uv_buf_t* buf) {  
2.	   EmitRead(nread, *buf);  
3.	}  
4.	  
5.	inline void StreamResource::EmitRead(ssize_t nread, const uv_buf_t& buf) {  
6.	  // bytes_read_表示已读的字节数  
7.	  if (nread > 0)  
8.	    bytes_read_ += static_cast<uint64_t>(nread);  
9.	  listener_->OnStreamRead(nread, buf);  
10.	}  
```

通过层层调用最后会调用listener_的OnStreamRead。我们看看TCP的OnStreamRead

```
1.	void EmitToJSStreamListener::OnStreamRead(ssize_t nread, const uv_buf_t& buf_) {  
2.	  StreamBase* stream = static_cast<StreamBase*>(stream_);  
3.	  Environment* env = stream->stream_env();  
4.	  HandleScope handle_scope(env->isolate());  
5.	  Context::Scope context_scope(env->context());  
6.	  AllocatedBuffer buf(env, buf_);  
7.	  stream->CallJSOnreadMethod(nread, buf.ToArrayBuffer());  
8.	}  
```

继续回调CallJSOnreadMethod

```
1.	MaybeLocal<Value> StreamBase::CallJSOnreadMethod(ssize_t nread,  
2.	                                                 Local<ArrayBuffer> ab,  
3.	                                                 size_t offset,  
4.	                                                 StreamBaseJSChecks checks) {  
5.	  Environment* env = env_;  
6.	  // ...  
7.	  AsyncWrap* wrap = GetAsyncWrap();  
8.	  CHECK_NOT_NULL(wrap);  
9.	  Local<Value> onread = wrap->object()->GetInternalField(kOnReadFunctionField);  
10.	  CHECK(onread->IsFunction());  
11.	  return wrap->MakeCallback(onread.As<Function>(), arraysize(argv), argv);  
12.	}  
```

CallJSOnreadMethod会回调JS层的onread回调函数。onread会把数据push到流中，然后触发data事件。
