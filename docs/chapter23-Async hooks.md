**前言：虽然Async hooks至此还是实验性API，但是他的确可以解决应用中的一些问题，比如日志和调用栈跟踪。本文从应用和原理方便介绍一下Node.js的Async hooks。**

# 1 env中的AsyncHooks
在Node.js的env对象中有一个AsyncHooks对象，负责Node.js进程中async_hooks的管理。我们看一下定义。
## 1.1 类定义
```cpp
class AsyncHooks : public MemoryRetainer {
 public:
  
  enum Fields {
  	// 五种钩子
    kInit,
    kBefore,
    kAfter,
    kDestroy,
    kPromiseResolve,
    // 钩子总数
    kTotals,
    // async_hooks开启的个数
    kCheck,
    // 记录栈的top指针
    kStackLength,
    // 数组大小
    kFieldsCount,
  };

  enum UidFields {
    kExecutionAsyncId,
    kTriggerAsyncId,
    // 当前async id的值
    kAsyncIdCounter,
    kDefaultTriggerAsyncId,
    kUidFieldsCount,
  };
  
 private:
  inline AsyncHooks();
  // 异步资源的类型
  std::array<v8::Eternal<v8::String>, AsyncWrap::PROVIDERS_LENGTH> providers_;
  // 栈
  AliasedFloat64Array async_ids_stack_;
  // 整形数组，每个元素值的意义和Fields对应
  AliasedUint32Array fields_;
  // 整形数组，每个元素值的意义和UidFields对应
  AliasedFloat64Array async_id_fields_;
};
```
结构图如下
![](https://img-blog.csdnimg.cn/e1a0a333c0224c51867bffd4cf7236f3.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
接下来看一下env的AsyncHooks对象提供了哪些API，这些API是上层的基础。
## 1.2 读API
我们看一下env对象中获取AsyncHooks对象对应字段的API。
```cpp
// 获取对应的字段
inline AliasedUint32Array& AsyncHooks::fields() {
  return fields_;
}

inline AliasedFloat64Array& AsyncHooks::async_id_fields() {
  return async_id_fields_;
}

inline AliasedFloat64Array& AsyncHooks::async_ids_stack() {
  return async_ids_stack_;
}

// 获取资源类型
inline v8::Local<v8::String> AsyncHooks::provider_string(int idx) {
  return providers_[idx].Get(env()->isolate());
}

// 新建资源的时候，获取新的async id
inline double Environment::new_async_id() {
  async_hooks()->async_id_fields()[AsyncHooks::kAsyncIdCounter] += 1;
  return async_hooks()->async_id_fields()[AsyncHooks::kAsyncIdCounter];
}

// 获取当前async id
inline double Environment::execution_async_id() {
  return async_hooks()->async_id_fields()[AsyncHooks::kExecutionAsyncId];
}

// 获取当前trigger async id
inline double Environment::trigger_async_id() {
  return async_hooks()->async_id_fields()[AsyncHooks::kTriggerAsyncId];
}

// 获取默认的trigger async id，如果没有设置，则获取当前的async id
inline double Environment::get_default_trigger_async_id() {
  double default_trigger_async_id = async_hooks()->async_id_fields()[AsyncHooks::kDefaultTriggerAsyncId];
  // If defaultTriggerAsyncId isn't set, use the executionAsyncId
  if (default_trigger_async_id < 0)
    default_trigger_async_id = execution_async_id();
  return default_trigger_async_id;
}
```
## 1.3 写API
```cpp
inline void AsyncHooks::push_async_ids(double async_id,
                                       double trigger_async_id) {
  // 获取当前栈顶指针
  uint32_t offset = fields_[kStackLength];
  // 不够则扩容
  if (offset * 2 >= async_ids_stack_.Length())
    grow_async_ids_stack();
  // 把旧的上下文压栈  
  async_ids_stack_[2 * offset] = async_id_fields_[kExecutionAsyncId];
  async_ids_stack_[2 * offset + 1] = async_id_fields_[kTriggerAsyncId];
  // 栈指针加一
  fields_[kStackLength] += 1;
  // 记录当前上下文
  async_id_fields_[kExecutionAsyncId] = async_id;
  async_id_fields_[kTriggerAsyncId] = trigger_async_id;
}
// 和上面的逻辑相反
inline bool AsyncHooks::pop_async_id(double async_id) {

  if (fields_[kStackLength] == 0) return false;
  uint32_t offset = fields_[kStackLength] - 1;
  async_id_fields_[kExecutionAsyncId] = async_ids_stack_[2 * offset];
  async_id_fields_[kTriggerAsyncId] = async_ids_stack_[2 * offset + 1];
  fields_[kStackLength] = offset;

  return fields_[kStackLength] > 0;
}
```
# 2 底层资源封装类 - AsyncWrap
接着看一下异步资源的基类AsyncWrap。所有依赖于C、C++层实现的资源（比如TCP、UDP）都会继承AsyncWrap。看看该类的定义。
```cpp
class AsyncWrap : public BaseObject {
 private:
  ProviderType provider_type_ = PROVIDER_NONE;
  double async_id_ = kInvalidAsyncId;
  double trigger_async_id_;
};
```
我们看到每个AsyncWrap对象都有async_id_、trigger_async_id_和provider_type_属性，这正是在init回调里拿到的数据。我们看看AsyncWrap的构造函数。接下来看一下新建一个资源（AsyncWrap）时的逻辑。
## 2.1 资源初始化
```cpp
AsyncWrap::AsyncWrap(Environment* env,
                     Local<Object> object,
                     ProviderType provider,
                     double execution_async_id,
                     bool silent)
    : AsyncWrap(env, object) {
  // 资源类型
  provider_type_ = provider;
  AsyncReset(execution_async_id, silent);
}

void AsyncWrap::AsyncReset(Local<Object> resource, double execution_async_id,
                           bool silent) {
  // 获取一个新的async id，execution_async_id默认是kInvalidAsyncId
  async_id_ = execution_async_id == kInvalidAsyncId ? env()->new_async_id()
                                                     : execution_async_id;
  // 获取trigger async id                                                   
  trigger_async_id_ = env()->get_default_trigger_async_id();
  // 执行init钩子
  EmitAsyncInit(env(), resource,
                env()->async_hooks()->provider_string(provider_type()),
                async_id_, trigger_async_id_);
}
```
接着看EmitAsyncInit
```cpp
void AsyncWrap::EmitAsyncInit(Environment* env,
                              Local<Object> object,
                              Local<String> type,
                              double async_id,
                              double trigger_async_id) {
  AsyncHooks* async_hooks = env->async_hooks();
  HandleScope scope(env->isolate());
  Local<Function> init_fn = env->async_hooks_init_function();

  Local<Value> argv[] = {
    Number::New(env->isolate(), async_id),
    type,
    Number::New(env->isolate(), trigger_async_id),
    object,
  };

  TryCatchScope try_catch(env, TryCatchScope::CatchMode::kFatal);
  // 执行init回调
  USE(init_fn->Call(env->context(), object, arraysize(argv), argv));
}
```
那么env->async_hooks_init_function()的值是什么呢？这是在Node.js初始化时设置的。
```js
const { nativeHooks } = require('internal/async_hooks');
internalBinding('async_wrap').setupHooks(nativeHooks);
```
SetupHooks的实现如下
```cpp
static void SetupHooks(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  Local<Object> fn_obj = args[0].As<Object>();

#define SET_HOOK_FN(name)                                                      \
  do {                                                                         \
    Local<Value> v =                                                           \
        fn_obj->Get(env->context(),                                            \
                    FIXED_ONE_BYTE_STRING(env->isolate(), #name))              \
            .ToLocalChecked();                                                 \
    CHECK(v->IsFunction());                                                    \
    env->set_async_hooks_##name##_function(v.As<Function>());                  \
  } while (0)
  // 保存到env中
  SET_HOOK_FN(init);
  SET_HOOK_FN(before);
  SET_HOOK_FN(after);
  SET_HOOK_FN(destroy);
  SET_HOOK_FN(promise_resolve);
#undef SET_HOOK_FN
}
```
nativeHooks的实现如下
```js
nativeHooks: {
  init: emitInitNative,
  before: emitBeforeNative,
  after: emitAfterNative,
  destroy: emitDestroyNative,
  promise_resolve: emitPromiseResolveNative
}
```
这些Hooks会执行对应的回调，比如emitInitNative
```js
function emitInitNative(asyncId, type, triggerAsyncId, resource) {
  for (var i = 0; i < active_hooks.array.length; i++) {
	  if (typeof active_hooks.array[i][init_symbol] === 'function') {
	    active_hooks.array[i][init_symbol](
	      asyncId, type, triggerAsyncId,
	      resource
	    );
  	  }
  }
}
```
active_hooks.array的值就是我们在业务代码里设置的钩子，每次调研createHooks的时候就对应数组的一个元素。
## 2.2 执行资源回调
当业务代码异步请求底层API，并且底层满足条件时，就会执行上层的回调，比如监听一个socket时，有连接到来。Node.js就会调用MakeCallback函数执行回调。
```cpp
MaybeLocal<Value> AsyncWrap::MakeCallback(const Local<Function> cb,
                                          int argc,
                                          Local<Value>* argv) {
  // 当前AsyncWrap对象对应的执行上下文                             
  ProviderType provider = provider_type();
  async_context context { get_async_id(), get_trigger_async_id() };
  MaybeLocal<Value> ret = InternalMakeCallback(env(), object(), cb, argc, argv, context);

  return ret;
}
```
MakeCallback中会调用InternalMakeCallback。
```cpp
MaybeLocal<Value> InternalMakeCallback(Environment* env,
                                       Local<Object> recv,
                                       const Local<Function> callback,
                                       int argc,
                                       Local<Value> argv[],
                                       async_context asyncContext) {
  // 新建一个scope                                     
  InternalCallbackScope scope(env, recv, asyncContext);
  // 执行回调
  callback->Call(env->context(), recv, argc, argv);
  // 关闭scope
  scope.Close();
}
```
我们看看新建和关闭scope都做了什么事情。
```cpp
InternalCallbackScope::InternalCallbackScope(Environment* env,
                                             Local<Object> object,
                                             const async_context& asyncContext,
                                             int flags)
  : env_(env),
    async_context_(asyncContext),
    object_(object),
    skip_hooks_(flags & kSkipAsyncHooks),
    skip_task_queues_(flags & kSkipTaskQueues) {
  // v14版本中，是先触发before再push上下文，顺序是不对的，v16已经改过来。
  // 当前执行上下文入栈
  env->async_hooks()->push_async_ids(async_context_.async_id,
                               async_context_.trigger_async_id);
  // 触发before钩子
  if (asyncContext.async_id != 0 && !skip_hooks_) {
    AsyncWrap::EmitBefore(env, asyncContext.async_id);
  }
  
  pushed_ids_ = true;
}	
```
在scope里会把当前AsyncWrap对象的执行上下文作为当前执行上下文，并且触发before钩子，然后执行业务回调，所以我们在回调里获取当前执行上下文时就拿到了AsyncWrap对应的值（ 调用executionAsyncId），接着看Close
```cpp
void InternalCallbackScope::Close() {
  // 执行
  if (pushed_ids_)
    env_->async_hooks()->pop_async_id(async_context_.async_id);

  if (async_context_.async_id != 0 && !skip_hooks_) {
    AsyncWrap::EmitAfter(env_, async_context_.async_id);
  }
}
```
Close在执行回调后被调用，主要是恢复当前执行上下文并且触发after钩子。
# 3 上层资源的封装 - Timeout、TickObjecd等
并不是所有的异步资源都是底层实现的，比如定时器，tick也被定义为异步资源，因为他们都是和回调相关。这种异步资源是在JS层实现的，这里只分析Timeout。
## 3.1 创建资源
我们看一下执行setTimeout时的核心逻辑。
```js
function setTimeout(callback, after, arg1, arg2, arg3) {
  const timeout = new Timeout(callback, after, args, false, true);
  return timeout;
}

function Timeout(callback, after, args, isRepeat, isRefed) {
  initAsyncResource(this, 'Timeout');
}

function initAsyncResource(resource, type) {
  // 获取新的async id
  const asyncId = resource[async_id_symbol] = newAsyncId();
  const triggerAsyncId = resource[trigger_async_id_symbol] = getDefaultTriggerAsyncId();
  // 是否设置了init钩子，是则触发回调
  if (initHooksExist())
    emitInit(asyncId, type, triggerAsyncId, resource);
}
```
执行setTimeout时，Node.js会创建一个Timeout对象，设置async_hooks相关的上下文并记录到Timeout对象中。然后触发init钩子。
```js
function emitInitScript(asyncId, type, triggerAsyncId, resource) {
  emitInitNative(asyncId, type, triggerAsyncId, resource);
}
```
以上代码会执行每个async_hooks对象的init回调(通常我们只有一个async_hooks对象)。
## 3.1 执行回调
当定时器到期时，会执行回调，我们看看相关的逻辑。
```js
// 触发before钩子
emitBefore(asyncId, timer[trigger_async_id_symbol]);
// 执行回调
timer._onTimeout();
// 触发after回调
emitAfter(asyncId);
```
我们看到执行超时回调的前后会触发对应的钩子。
```js
function emitBeforeScript(asyncId, triggerAsyncId) {
  // 和底层的push_async_ids逻辑一样
  pushAsyncIds(asyncId, triggerAsyncId);
  // 如果有回调则执行
  if (async_hook_fields[kBefore] > 0)
    emitBeforeNative(asyncId);
}

function emitAfterScript(asyncId) {
  // 设置了after回调则emit
  if (async_hook_fields[kAfter] > 0)
    emitAfterNative(asyncId);
  // 和底层的pop_async_ids逻辑一样
  popAsyncIds(asyncId);
}
```
JS层的实现和底层是保持一致的。如果我们在setTimeout回调里新建一个资源，比如再次执行setTimeout，这时候trigger async id就是第一个setTimeout对应的async id，所以就连起来了，后面我们会看到具体的例子。
# 4 DefaultTriggerAsyncIdScope
Node.js为了避免过多通过参数传递的方式传递async id，就设计了DefaultTriggerAsyncIdScope。DefaultTriggerAsyncIdScope的作用类似在多个函数外维护一个变量，多个函数都可以通过DefaultTriggerAsyncIdScope获得trigger async id，而不需要通过层层传递的方式，他的实现非常简单。
```cpp
class DefaultTriggerAsyncIdScope {
   private:
    AsyncHooks* async_hooks_;
    double old_default_trigger_async_id_;
};

inline AsyncHooks::DefaultTriggerAsyncIdScope ::DefaultTriggerAsyncIdScope(
    Environment* env, double default_trigger_async_id)
    : async_hooks_(env->async_hooks()) {
  // 记录旧的id，设置新的id
  old_default_trigger_async_id_ =
    async_hooks_->async_id_fields()[AsyncHooks::kDefaultTriggerAsyncId];
  async_hooks_->async_id_fields()[AsyncHooks::kDefaultTriggerAsyncId] =
    default_trigger_async_id;
}
// 恢复
inline AsyncHooks::DefaultTriggerAsyncIdScope ::~DefaultTriggerAsyncIdScope() {
  async_hooks_->async_id_fields()[AsyncHooks::kDefaultTriggerAsyncId] =
    old_default_trigger_async_id_;
}
```
DefaultTriggerAsyncIdScope主要是记录旧的id，然后把新的id设置到env中，当其他函数调用get_default_trigger_async_id时就可以获取设置的async id。同样JS层也实现了类似的API。
```js
function defaultTriggerAsyncIdScope(triggerAsyncId, block, ...args) {
  const oldDefaultTriggerAsyncId = async_id_fields[kDefaultTriggerAsyncId];
  async_id_fields[kDefaultTriggerAsyncId] = triggerAsyncId;

  try {
    return block(...args);
  } finally {
    async_id_fields[kDefaultTriggerAsyncId] = oldDefaultTriggerAsyncId;
  }
}
```
在执行block函数时，可以获取到设置的值，而不需要传递，执行完block后恢复。我们看看如何使用。下面摘自net模块的代码。
```js
// 获取handle里的async id
this[async_id_symbol] = getNewAsyncId(this._handle);
defaultTriggerAsyncIdScope(this[async_id_symbol],
                             process.nextTick,
                             emitListeningNT,
                             this);
```
我们看一下这里具体的情况。在defaultTriggerAsyncIdScope中会以emitListeningNT为入参执行process.nextTick。我们看看nextTick的实现。
```js
function nextTick(callback) {
  // 获取新的async id
  const asyncId = newAsyncId();
  // 获取默认的trigger async id，即刚才设置的
  const triggerAsyncId = getDefaultTriggerAsyncId();
  const tickObject = {
    [async_id_symbol]: asyncId,
    [trigger_async_id_symbol]: triggerAsyncId,
    callback,
    args
  };
  if (initHooksExist())
  	// 创建了新的资源，触发init钩子
    emitInit(asyncId, 'TickObject', triggerAsyncId, tickObject);
  queue.push(tickObject);
}
```
我们看到在nextTick中通过getDefaultTriggerAsyncId拿到了trigger async id。
```js
function getDefaultTriggerAsyncId() {
  const defaultTriggerAsyncId = async_id_fields[kDefaultTriggerAsyncId];
  if (defaultTriggerAsyncId < 0)
    return async_id_fields[kExecutionAsyncId];
  return defaultTriggerAsyncId;
}
```
getDefaultTriggerAsyncId返回的就是刚才通过defaultTriggerAsyncIdScope设置的async id。所以在触发TickObject的init钩子时用户就可以拿到对应的id。不过更重要的时，在异步执行nextTick的任务时，还可以拿到原始的trigger async id。因为该id记录在tickObject中。我们看看执行tick任务时的逻辑。
```js
function processTicksAndRejections() {
  let tock;
  do {
    while (tock = queue.shift()) {
      // 拿到对应的async 上下文
      const asyncId = tock[async_id_symbol];
      emitBefore(asyncId, tock[trigger_async_id_symbol]);
      try {
        const callback = tock.callback;
        callback();
      } finally {
        if (destroyHooksExist())
          emitDestroy(asyncId);
      }
      emitAfter(asyncId);
    }
  } while (!queue.isEmpty() || processPromiseRejections());
}
```
# 5 资源销毁
资源销毁的时候也会触发对应的钩子，不过不同的是这个钩子是异步触发的。无论是JS还是好C++层触发销毁钩子的时候，逻辑都是一致的。
```cpp
void AsyncWrap::EmitDestroy(Environment* env, double async_id) {
  // 之前为空则设置回调
  if (env->destroy_async_id_list()->empty()) {
    env->SetUnrefImmediate(&DestroyAsyncIdsCallback);
  }
  // async id入队
  env->destroy_async_id_list()->push_back(async_id);
}

template <typename Fn>
void Environment::SetUnrefImmediate(Fn&& cb) {
  CreateImmediate(std::move(cb), false);
}

template <typename Fn>
void Environment::CreateImmediate(Fn&& cb, bool ref) {
  auto callback = std::make_unique<NativeImmediateCallbackImpl<Fn>>(
      std::move(cb), ref);
  // 加入任务队列    
  native_immediates_.Push(std::move(callback));
}
```
在事件循环的check阶段就会执行里面的任务，从而执行回调DestroyAsyncIdsCallback。
```cpp
void AsyncWrap::DestroyAsyncIdsCallback(Environment* env) {
  Local<Function> fn = env->async_hooks_destroy_function();
  do {
    std::vector<double> destroy_async_id_list;
    destroy_async_id_list.swap(*env->destroy_async_id_list());
    // 遍历销毁的async id
    for (auto async_id : destroy_async_id_list) {
      HandleScope scope(env->isolate());
      Local<Value> async_id_value = Number::New(env->isolate(), async_id);
      // 执行JS层回调
      MaybeLocal<Value> ret = fn->Call(env->context(), Undefined(env->isolate()), 1, &async_id_value);
    }
  } while (!env->destroy_async_id_list()->empty());
}
```
# 6 Async hooks的使用
我们通常以以下方式使用Async hooks
```js
const async_hooks = require('async_hooks');
async_hooks.createHook({
  init(asyncId, type, triggerAsyncId) {},
  before(asyncId) {},
  after(asyncId) {},
  destroy(asyncId) {},
  promiseResolve(asyncId),
})
.enable();
```
async_hooks是对资源生命周期的抽象，资源就是操作对象和回调的抽象。async_hooks定义了五个生命周期钩子，当资源的状态到达某个周期节点时，async_hooks就会触发对应的钩子。下面我们看一下具体的实现。我们首先看一下createHook。
```js
function createHook(fns) {
  return new AsyncHook(fns);
}
```
createHook是对AsyncHook的封装
```js
class AsyncHook {
  constructor({ init, before, after, destroy, promiseResolve }) {
  	// 记录回调
    this[init_symbol] = init;
    this[before_symbol] = before;
    this[after_symbol] = after;
    this[destroy_symbol] = destroy;
    this[promise_resolve_symbol] = promiseResolve;
  }
}
```
AsyncHook的初始化很简单，创建一个AsyncHook对象记录回调函数。创建了AsyncHook之后，我们需要调用AsyncHook的enable函数手动开启。
```js
class AsyncHook {
  enable() {
    // 获取一个AsyncHook对象数组和一个整形数组
    const [hooks_array, hook_fields] = getHookArrays();
	// 执行过enable了则不需要再执行
    if (hooks_array.includes(this))
      return this;
	// 做些统计
    const prev_kTotals = hook_fields[kTotals];
    hook_fields[kTotals] = hook_fields[kInit] += +!!this[init_symbol];
    hook_fields[kTotals] += hook_fields[kBefore] += +!!this[before_symbol];
    hook_fields[kTotals] += hook_fields[kAfter] += +!!this[after_symbol];
    hook_fields[kTotals] += hook_fields[kDestroy] += +!!this[destroy_symbol];
    hook_fields[kTotals] +=
        hook_fields[kPromiseResolve] += +!!this[promise_resolve_symbol];
    // 当前对象插入数组中
    hooks_array.push(this);
	// 如果之前的数量是0，本次操作后大于0则开启底层的逻辑
    if (prev_kTotals === 0 && hook_fields[kTotals] > 0) {
      enableHooks();
    }

    return this;
  }
}
```
1 hooks_array：是一个AsyncHook对象数组，主要用于记录用户创建了哪些AsyncHook对象，然后哪些AsyncHook对象里都设置了哪些钩子，在回调的时候就会遍历这个对象数组，执行里面的回调。
2 hook_fields：对应底层的async_hook_fields。
3 enableHooks： 
```js
function enableHooks() {
  // 记录async_hooks的开启个数
  async_hook_fields[kCheck] += 1;
}
```
至此，async_hooks的初始化就完成了，我们发现逻辑非常简单。下面我们看一下他是如何串起来的。下面我们以TCP模块为例。
```js
const { createHook, executionAsyncId } = require('async_hooks');
const fs = require('fs');
const net = require('net');

createHook({
  init(asyncId, type, triggerAsyncId) {
    fs.writeSync(
      1,
      `${type}(${asyncId}): trigger: ${triggerAsyncId} execution: ${executionAsyncId()}\n`);
  }
}).enable();
net.createServer((conn) => {}).listen(8080);
```
以上代码输出
```text
init: type: TCPSERVERWRAP asyncId: 2 trigger id: 1 executionAsyncId(): 1 triggerAsyncId(): 0
init: type: TickObject asyncId: 3 trigger id: 2 executionAsyncId(): 1 triggerAsyncId(): 0
before: asyncId: 3 executionAsyncId(): 3 triggerAsyncId(): 2
after: asyncId: 3 executionAsyncId(): 3 triggerAsyncId(): 2
```
下面我们来分析具体过程。我们知道创建资源的时候会执行init回调，具体逻辑在listen函数中，在listen函数中，通过层层调用会执行new TCP新建一个对象，表示服务器。TCP是C++层导出的类，刚才我们说过，TCP会继承AsyncWrap，新建AsyncWrap对象的时候会触发init钩子，结构图如下。
![](https://img-blog.csdnimg.cn/9278bab03a714155b75a50341cad2b9c.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
对应输出

```text
init: type: TCPSERVERWRAP asyncId: 2 trigger id: 1 executionAsyncId(): 1 triggerAsyncId(): 0
```
那TickObject是怎么来的呢？我们接着看listen里的另一段逻辑。
```js
this[async_id_symbol] = getNewAsyncId(this._handle);
defaultTriggerAsyncIdScope(this[async_id_symbol],
                           process.nextTick,
                           emitListeningNT,
                           this);
```
上面的代码我们刚才已经分析过，在执行process.nextTick的时候会创建一个TickObject对象封装执行上下文和回调。
```js
const asyncId = newAsyncId();
const triggerAsyncId = getDefaultTriggerAsyncId();
const tickObject = {
  [async_id_symbol]: asyncId,
  [trigger_async_id_symbol]: triggerAsyncId,
  callback,
  args
};
emitInit(asyncId, 'TickObject', triggerAsyncId, tickObject);
```
这次再次触发了init钩子，结构如下（nextTick通过getDefaultTriggerAsyncId获取的id是defaultTriggerAsyncIdScope设置的id）。
![](https://img-blog.csdnimg.cn/cfbb1aa23e0f4f1f9c482e220234da29.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
对应输出
```text
init: type: TickObject asyncId: 3 trigger id: 2 executionAsyncId(): 1 triggerAsyncId(): 0
```
接着执行tick任务。

```js
const asyncId = tock[async_id_symbol];
emitBefore(asyncId, tock[trigger_async_id_symbol]);
try {
  tock.callback();
} finally {
  if (destroyHooksExist())
    emitDestroy(asyncId);
}
emitAfter(asyncId);
```
emitBefore时，结构图如下。
![](https://img-blog.csdnimg.cn/7c0ae3440d1a47ea9d75e3f7ee0f87eb.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
对应输出
```text
before: asyncId: 3 executionAsyncId(): 3 triggerAsyncId(): 2
after: asyncId: 3 executionAsyncId(): 3 triggerAsyncId(): 2
```
执行完我们的JS代码后，所有入栈的上下文都会被清空，结构图如下。
![](https://img-blog.csdnimg.cn/00cb54acd1d344d28e7a5da0ab9b8e9f.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
如果这时候有一个连接建立会输出什么呢？当有连接建立时，会执行C++层的OnConnection。
OnConnection会创建一个新的TCP对象表示和客户端通信的对象。
```cpp
MaybeLocal<Object> TCPWrap::Instantiate(Environment* env,
                                        AsyncWrap* parent,
                                        TCPWrap::SocketType type) {
  EscapableHandleScope handle_scope(env->isolate());
  AsyncHooks::DefaultTriggerAsyncIdScope trigger_scope(parent); 
  return handle_scope.EscapeMaybe(
      constructor->NewInstance(env->context(), 1, &type_value));
}
```
首先定义了一个AsyncHooks::DefaultTriggerAsyncIdScope。DefaultTriggerAsyncIdScope用于设置默认default_trigger_async_id为parent的async id（值是2），执行Instantiate时会执行析构函数恢复原来状态。接着NewInstance的时候就会新建一个TCPWrap对象，从而创建一个AsyncWrap对象。然后触发init钩子，结构图如下。
![](https://img-blog.csdnimg.cn/4732aabf2bda4a53875c570f0ba713e7.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
对应输出
```text
init: type: TCPWRAP asyncId: 4 trigger id: 2 executionAsyncId(): 0 triggerAsyncId(): 0
```
创建完对象后，通过AsyncWrap::MakeCallback回调JS层，刚才我们已经分析过AsyncWrap::MakeCallback会触发before和after钩子，触发before钩子时，结构图如下。
![](https://img-blog.csdnimg.cn/a680fd236f1e4aa5b1986dce327e4422.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
对应输出
```text
before: asyncId: 2 executionAsyncId(): 2 triggerAsyncId(): 1
```
同样，在回调函数里执行executionAsyncId和triggerAsyncId拿到的内容是一样的。触发after后再恢复上下文，所以输出也是一样的。
```text
after: asyncId: 2 executionAsyncId(): 2 triggerAsyncId(): 1
```

# 7 AsyncResource
异步资源并不是Node.js内置的，Node.js只是提供了一套机制，业务层也可以使用。Node.js也提供了一个类给业务使用，核心代码如下。
```js
class AsyncResource {
  constructor(type, opts = {}) {
    let triggerAsyncId = opts;
    let requireManualDestroy = false;
    if (typeof opts !== 'number') {
      triggerAsyncId = opts.triggerAsyncId === undefined ?
        getDefaultTriggerAsyncId() : opts.triggerAsyncId;
      requireManualDestroy = !!opts.requireManualDestroy;
    }
    const asyncId = newAsyncId();
    this[async_id_symbol] = asyncId;
    this[trigger_async_id_symbol] = triggerAsyncId;

    if (initHooksExist()) {
      emitInit(asyncId, type, triggerAsyncId, this);
    }
  }

  runInAsyncScope(fn, thisArg, ...args) {
    const asyncId = this[async_id_symbol];
    emitBefore(asyncId, this[trigger_async_id_symbol]);

    const ret = thisArg === undefined ?
      fn(...args) :
      ReflectApply(fn, thisArg, args);

    emitAfter(asyncId);
    return ret;
  }

  emitDestroy() {
    if (this[destroyedSymbol] !== undefined) {
      this[destroyedSymbol].destroyed = true;
    }
    emitDestroy(this[async_id_symbol]);
    return this;
  }

  asyncId() {
    return this[async_id_symbol];
  }

  triggerAsyncId() {
    return this[trigger_async_id_symbol];
  }
}
```
使用方式如下。
```js
const { AsyncResource, executionAsyncId,triggerAsyncId } = require('async_hooks');
const asyncResource = new AsyncResource('Demo');
asyncResource.runInAsyncScope(() => {
  console.log(executionAsyncId(), triggerAsyncId())
});
```
runInAsyncScope中会把asyncResource的执行上下文设置为当前执行上下文，async id是2，trigger async id是1，所以在回调里执行executionAsyncId输出的是2，triggerAsyncId输出的是1。
# 8 AsyncLocalStorage
AsyncLocalStorage是基于AsyncResource实现的一个维护异步逻辑中公共上下文的类。我们可以把他理解为Redis。我们看一下怎么使用。
## 8.1 使用
```js
const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();
function logWithId(msg) {
  const id = asyncLocalStorage.getStore();
  console.log(`${id !== undefined ? id : '-'}:`, msg);
}

asyncLocalStorage.run(1, () => {
	logWithId('start');
	setImmediate(() => {
	  logWithId('finish');
	});
 });
```
执行上面代码会输出

```text
1: start
1: finish
```
run的时候初始化公共的上下文，然后在run里执行的异步代码也可以拿得到这个公共上下文，这个在记录日志traceId时就会很有用，否则我们就需要把traceId传遍代码每个需要的地方。下面我们看一下实现。
## 8.2 实现
我们先看一下创建AsyncLocalStorage的逻辑
```js
class AsyncLocalStorage {
  constructor() {
    this.kResourceStore = Symbol('kResourceStore');
    this.enabled = false;
  }
}
```
创建AsyncLocalStorage的时候很简单，主要是置状态为false，并且设置kResourceStore的值为Symbol('kResourceStore')。设置为Symbol('kResourceStore')而不是‘kResourceStore‘很重要，我们后面会看到。继续看一下执行AsyncLocalStorage.run的逻辑。
```js
 run(store, callback, ...args) {
	// 新建一个AsyncResource
    const resource = new AsyncResource('AsyncLocalStorage', defaultAlsResourceOpts);
	// 通过runInAsyncScope把resource的执行上下文设置完当前的执行上下文
    return resource.emitDestroy().runInAsyncScope(() => {
      this.enterWith(store);
      return ReflectApply(callback, null, args);
    });
  }
```
设置完上下文之后执行runInAsyncScope的回调，回调里首先执行里enterWith。
```js
enterWith(store) {
	// 修改AsyncLocalStorage状态
   this._enable();
   // 获得当前执行上下文对于多资源，也就是run里创建的resource
   const resource = executionAsyncResource();
   // 把公共上下文挂载到对象上
   resource[this.kResourceStore] = store;
}

_enable() {
   if (!this.enabled) {
     this.enabled = true;
     ArrayPrototypePush(storageList, this);
     storageHook.enable();
   }
}
```
挂载完公共上下文后，就执行业务回调。回调里可以通过asyncLocalStorage.getStore()获得设置的公共上下文。
```js
getStore() {
  if(this.enabled) {
    const resource = executionAsyncResource();
    return resource[this.kResourceStore];
  }
}
```
getStore的原理很简单，就是首先拿到当前执行上下文对应的资源，然后根据AsyncLocalStorage的kResourceStore的值从resource中拿到公共上下文。如果是同步执行getStore，那么executionAsyncResource返回的就是我们在run的时候创建的AsyncResource，但是如果是异步getStore那么怎么办呢？因为这时候executionAsyncResource返回的不再是我们创建的AsyncResource，也就拿不到他挂载的公共上下文。为了解决这个问题，Node.js对公共上下文进行了传递。
```js
const storageList = []; // AsyncLocalStorage对象数组
const storageHook = createHook({
  init(asyncId, type, triggerAsyncId, resource) {
    const currentResource = executionAsyncResource();
    for (let i = 0; i < storageList.length; ++i) {
      storageList[i]._propagate(resource, currentResource);
    }
  }
});

 _propagate(resource, triggerResource) {
    const store = triggerResource[this.kResourceStore];
    if (this.enabled) {
      resource[this.kResourceStore] = store;
    }
  }
```
我们看到Node.js内部创建了一个Hooks，在每次资源创建的时候，Node.js会把当前执行上下文对应的资源中的一个或多个key（根据storageList里对象的this.kResourceStore字段）对应的值挂载到新创建的资源中。所以在asyncLocalStorage.getStore()时即使不是我们在执行run时创建的资源对象，也可以获得具体asyncLocalStorage对象所设置的资源，我们再来看一个例子。
```js
const { AsyncLocalStorage } = require('async_hooks');
  
const asyncLocalStorage = new AsyncLocalStorage();
const asyncLocalStorage2 = new AsyncLocalStorage();
function logWithId(msg) {
  console.log(asyncLocalStorage2.getStore());
  const id = asyncLocalStorage.getStore();
  console.log(`${id !== undefined ? id : '-'}:`, msg);
}
asyncLocalStorage.run(0, () => {
	asyncLocalStorage2.enterWith({hello: "world"});
	logWithId('start');
	setImmediate(() => {
	   logWithId('finish');
	});
});
```
除了通过asyncLocalStorage.run设置上下文，我们通过asyncLocalStorage2.enterWith也给对象上下文的资源对象挂载一个新属性，key是Symbol('kResourceStore')，值是{hello: "world"}，然后在logWithId中输出asyncLocalStorage2.getStore()。从输出中可以看到成功从资源中获得挂载的所有上下文。
```text
{ hello: 'world' }
0: start
{ hello: 'world' }
0: finish
```
我们也可以修改源码验证
```c
Immediate {
  _idleNext: null,
  _idlePrev: null,
  _onImmediate: [Function (anonymous)],
  _argv: undefined,
  _destroyed: true,
  [Symbol(refed)]: null,
  [Symbol(asyncId)]: 6,
  [Symbol(triggerId)]: 2,
  [Symbol(kResourceStore)]: 0,
  [Symbol(kResourceStore)]: { hello: 'world' }
}
```
可以看到资源对象挂载里两个key为Symbol(kResourceStore)的属性。
# 9 初始化时的Async hooks
```js
const async_hooks = require('async_hooks');
const eid = async_hooks.executionAsyncId();
const tid = async_hooks.triggerAsyncId();
console.log(eid, tid);
```
以上代码中,输出1和0。对应的API实现如下。
```js
// 获取当前的async id
function executionAsyncId() {
  return async_id_fields[kExecutionAsyncId];
}
// 获取当前的trigger async id，即触发当前代码的async id
function triggerAsyncId() {
  return async_id_fields[kTriggerAsyncId];
}
```
那么async_id_fields的初始化是什么呢？从env.h定义中可以看到async_id_fields_（async_id_fields是上层使用的名称，对应底层的async_id_fields_）是AliasedFloat64Array类型。
```c
AliasedFloat64Array async_id_fields_;
```
AliasedFloat64Array是个类型别名。
```cpp
typedef AliasedBufferBase<double, v8::Float64Array> AliasedFloat64Array;
```
AliasedBufferBase的构造函数如下
```cpp
  AliasedBufferBase(v8::Isolate* isolate, const size_t count)
      : isolate_(isolate), count_(count), byte_offset_(0) {
   
    const v8::HandleScope handle_scope(isolate_);
    const size_t size_in_bytes = MultiplyWithOverflowCheck(sizeof(NativeT), count);
    v8::Local<v8::ArrayBuffer> ab = v8::ArrayBuffer::New(isolate_, size_in_bytes);
    // ...
  }
```
底层是一个ArrayBuffer。
```cpp
Local<ArrayBuffer> v8::ArrayBuffer::New(Isolate* isolate, size_t byte_length) {
  i::Isolate* i_isolate = reinterpret_cast<i::Isolate*>(isolate);
  LOG_API(i_isolate, ArrayBuffer, New);
  ENTER_V8_NO_SCRIPT_NO_EXCEPTION(i_isolate);
  i::MaybeHandle<i::JSArrayBuffer> result =
      i_isolate->factory()->NewJSArrayBufferAndBackingStore(
          byte_length, i::InitializedFlag::kZeroInitialized);
  // ...
}
```
ArrayBuffer::New在申请内存时传入了i::InitializedFlag::kZeroInitialized。从V8定义中可以看到会初始化内存的内容为0。
```c
// Whether the backing store memory is initialied to zero or not.
enum class InitializedFlag : uint8_t { kUninitialized, kZeroInitialized };
```
回到例子中，为什么输出会是1和0而不是0和0呢？答案在Node.js启动时的这段代码。
```cpp
{
      InternalCallbackScope callback_scope(
          env.get(),
          Local<Object>(),
          // async id和trigger async id
          { 1, 0 },
          InternalCallbackScope::kAllowEmptyResource |
              InternalCallbackScope::kSkipAsyncHooks);
      // 执行我们的js        
      LoadEnvironment(env.get());
}
```
InternalCallbackScope刚才已经分析过，他会把1和0设置为当前的执行上下文。然后在LoadEnvironment里执行我的JS代码时获取到的值就是1和0。那么如果我们改成以下代码会输出什么呢？
```js
const async_hooks = require('async_hooks');
Promise.resolve().then(() => {
  const eid = async_hooks.executionAsyncId();
  const tid = async_hooks.triggerAsyncId();
  console.log(eid, tid);
})
```
以上代码会输出0和。因为执行完我们的JS代码后，InternalCallbackScope就被析构了，从而恢复为0和0。

