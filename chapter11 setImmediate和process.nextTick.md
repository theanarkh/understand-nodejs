# 第十一章 setImmediate和process.nextTick
setImmediate是对应libuv的check阶段。我们看一下在nodejs初始化的时候，设置了处理immediate任务的函数。
## 11.1 setImmediate生产任务
setImmediate产生的任务会在check阶段被执行

```c
1.function setImmediate(callback, arg1, arg2, arg3) {  
2.  let i, args;  
3.  switch (arguments.length) {  
4.    case 1:  
5.      break;  
6.    case 2:  
7.      args = [arg1];  
8.      break;  
9.    case 3:  
10.      args = [arg1, arg2];  
11.      break;  
12.    default:  
13.      args = [arg1, arg2, arg3];  
14.      for (i = 4; i < arguments.length; i++) {  
15.        args[i - 1] = arguments[i];  
16.      }  
17.      break;  
18.  }  
19.  
20.  return new Immediate(callback, args);  
21.}  	
```

setImmediate的代码比较简单，新建一个Immediate。我们看一下Immediate的类。 

```c
1.const Immediate = class Immediate {  
2.  constructor(callback, args) {  
3.    this._idleNext = null;  
4.    this._idlePrev = null;  
5.    this._onImmediate = callback;  
6.    this._argv = args;  
7.    this._destroyed = false;  
8.    this[kRefed] = false;    
9.    this.ref();  
10.    // Immediate链表的节点个数，包括ref和unref状态  
11.    immediateInfo[kCount]++;  
12.    // 加入链表中  
13.    immediateQueue.append(this);  
14.  }  
15.  // 打上ref标记，往libuv的idle链表插入一个节点，如果还没有的话  
16.  ref() {  
17.    if (this[kRefed] === false) {  
18.      this[kRefed] = true;  
19.      if (immediateInfo[kRefCount]++ === 0)  
20.        toggleImmediateRef(true);  
21.    }  
22.    return this;  
23.  }  
24.  // 和上面相反  
25.  unref() {  
26.    if (this[kRefed] === true) {  
27.      this[kRefed] = false;  
28.      if (--immediateInfo[kRefCount] === 0)  
29.        toggleImmediateRef(false);  
30.    }  
31.    return this;  
32.  }  
33.  
34.  hasRef() {  
35.    return !!this[kRefed];  
36.  }  
37.};  
```

Immediate类主要做了两个事情。 

**1 生成一个节点插入到链表。**

```c
1.const immediateQueue = new ImmediateList();  
2.  
3.// 双向非循环的链表  
4.function ImmediateList() {  
5.  this.head = null;  
6.  this.tail = null;  
7.}  
8.ImmediateList.prototype.append = function(item) {  
9.  // 尾指针非空，说明链表非空，直接追加在尾节点后面  
10.  if (this.tail !== null) {  
11.    this.tail._idleNext = item;  
12.    item._idlePrev = this.tail;  
13.  } else {  
14.    // 尾指针是空说明链表是空的，头尾指针都指向item  
15.    this.head = item;  
16.  }  
17.  this.tail = item;  
18.};  
19.  
20.ImmediateList.prototype.remove = function(item) {  
21.  // 如果item在中间则自己全身而退，前后两个节点连上  
22.  if (item._idleNext !== null) {  
23.    item._idleNext._idlePrev = item._idlePrev;  
24.  }  
25.  
26.  if (item._idlePrev !== null) {  
27.    item._idlePrev._idleNext = item._idleNext;  
28.  }  
29.  // 是头指针，则需要更新头指针指向item的下一个，因为item被删除了，尾指针同理  
30.  if (item === this.head)  
31.    this.head = item._idleNext;  
32.  if (item === this.tail)  
33.    this.tail = item._idlePrev;  
34.  // 重置前后指针  
35.  item._idleNext = null;  
36.  item._idlePrev = null;  
37.};  
```

**2 然后如果还没有往libuv的idle链表里插入节点的话，则插入一个。**


```c
1.  
2.void ToggleImmediateRef(const FunctionCallbackInfo<Value>& args) {  
3.  Environment::GetCurrent(args)->ToggleImmediateRef(args[0]->IsTrue());  
4.}  
5.  
6.void Environment::ToggleImmediateRef(bool ref) {  
7.  if (started_cleanup_) return;  
8.  // 往idle链表插入/删除一个节点，插入节点是防止在poll io阶段阻塞  
9.  if (ref) {  
10.    // Idle handle is needed only to stop the event loop from blocking in poll.  
11.    uv_idle_start(immediate_idle_handle(), [](uv_idle_t*){ });  
12.  } else {  
13.    uv_idle_stop(immediate_idle_handle());  
14.  }  
15.}  
```

这是setImmediate函数的整个过程，他是一个生产者。
## 11.2 设置处理immediate任务的函数
在nodejs初始化的时候，设置了处理immediate任务的函数

```c
1.// runNextTicks用于处理nextTick产生的任务，这里不关注  
2.const { processImmediate, processTimers } = getTimerCallbacks(runNextTicks);  
3.setupTimers(processImmediate, processTimers);  
我们先看看一下setupTimers（timer.cc）的逻辑。
1.void SetupTimers(const FunctionCallbackInfo<Value>& args) {  
2.  auto env = Environment::GetCurrent(args);  
3.  env->set_immediate_callback_function(args[0].As<Function>());  
4.  env->set_timers_callback_function(args[1].As<Function>());  
5.}  
```

SetupTimers在env中保存了两个函数，后续会用到。
## 11.3 注册check阶段的回调
上一步设置了处理immediate任务的函数，那这个函数由谁触发调用呢？因为nodejs中，setImmediate对应了check节点，所以这时候需要往check阶段插入一个节点（env.cc）
uv_check_start(immediate_check_handle(), CheckImmediate);   
我们看一下CheckImmediate函数

```c
1.void Environment::CheckImmediate(uv_check_t* handle) {  
2.  
3.  // 省略部分代码  
4.  // 没有Immediate节点需要处理  
5.  if (env->immediate_info()->count() == 0 || !env->can_call_into_js())  
6.    return;  
7.  
8.  do {  
9.      // 执行js层回调immediate_callback_function  
10.    MakeCallback(env->isolate(),  
11.                 env->process_object(),  
12.                 env->immediate_callback_function(),  
13.                 0,  
14.                 nullptr,  
15.                 {0, 0}).ToLocalChecked();  
16.  } while (env->immediate_info()->has_outstanding() && env->can_call_into_js());  
17.  // 所有的immediate节点都处理完了，删除idle链表的那个节点，即允许poll io阶段阻塞  
18.  if (env->immediate_info()->ref_count() == 0)  
19.    env->ToggleImmediateRef(false);  
20.}  
```

CheckImmediate函数执行了immediate_callback_function函数，这正是nodejs初始化的时候设置的函数。值是processImmediate。
## 11.4 处理setImmediate产生的任务
processImmediate函数是处理immediate任务的函数，来自getTimerCallbacks（internal/timer.js）。

```c
1.function processImmediate() {  
2.   /*
3.       上次执行processImmediate的时候如果由未捕获的异常，
4.       则outstandingQueue保存了未执行的节点，下次执行processImmediate的时候，
5.       优先执行outstandingQueue队列的节点  
6.   */
7.   const queue = outstandingQueue.head !== null ?  
8.     outstandingQueue : immediateQueue;  
9.   let immediate = queue.head;  
10.   /* 
11.     在执行immediateQueue队列的话，先置空队列，避免执行回调
12.     的时候一直往队列加节点，死循环。 所以新加的接口会插入新的队列，
13.     不会在本次被执行。并打一个标记,全部immediateQueue节点都被执
14.     行则清空，否则会再执行processImmediate一次，见Environment::CheckImmediate 
15.   */  
16.   if (queue !== outstandingQueue) {  
17.     queue.head = queue.tail = null;  
18.     immediateInfo[kHasOutstanding] = 1;  
19.   }  
20.  
21.   let prevImmediate;  
22.   let ranAtLeastOneImmediate = false;  
23.   while (immediate !== null) {  
24.     // 执行宏任务  
25.     if (ranAtLeastOneImmediate)  
26.       runNextTicks();  
27.     else  
28.       ranAtLeastOneImmediate = true;  
29.  
30.     // 宏任务把该节点删除了，则不需要指向他的回调了，继续下一个  
31.     if (immediate._destroyed) {  
32.       outstandingQueue.head = immediate = prevImmediate._idleNext;  
33.       continue;  
34.     }  
35.  
36.     immediate._destroyed = true;  
37.     // 执行完要修改个数  
38.     immediateInfo[kCount]--;  
39.     if (immediate[kRefed])  
40.       immediateInfo[kRefCount]--;  
41.     immediate[kRefed] = null;  
42.     // 见上面if (immediate._destroyed)的注释  
43.     prevImmediate = immediate;  
44.     // 执行回调，指向下一个节点  
45.     try {  
46.       const argv = immediate._argv;  
47.       if (!argv)  
48.         immediate._onImmediate();  
49.       else  
50.         immediate._onImmediate(...argv);  
51.     } finally {  
52.       immediate._onImmediate = null;  
53.       outstandingQueue.head = immediate = immediate._idleNext;  
54.     }  
55.   }  
56.   // 当前执行的是outstandingQueue的话则把他清空  
57.   if (queue === outstandingQueue)  
58.     outstandingQueue.head = null;  
59.   // 全部节点执行完  
60.   immediateInfo[kHasOutstanding] = 0;  
61. }  
```

processImmediate的逻辑就是逐个执行immediate任务队列的节点。Immediate分两个队列，正常情况下，插入的immediate节点插入到immediateQueue队列。如果执行的时候有异常，则未处理完的节点就会被插入到outstandingQueue队列，等下一次执行。另外我们看到runNextTicks。runNextTicks在每执行完immediate节点后，都先处理tick任务然后再处理下一个immediate节点。
## 11.5 nodejs的setTimeout(fn,0)和setImmediate谁先执行的问题
我们首先看一下下面这段代码

 1. setTimeout(()=>{ console.log('setTimeout'); },0)  
 2. setImmediate(()=>{ console.log('setImmedate');})

我们执行上面这段代码，会发现输出是不确定的。下面来看一下为什么。nodejs的事件循环分为几个阶段(phase)。setTimeout是属于定时器阶段，setImmediate是属于check阶段。顺序上定时器阶段是比check更早被执行的。其中setTimeout的实现代码里有一个很重要的细节。

```c
1.after *= 1; // coalesce to number or NaN  
2.  if (!(after >= 1 && after <= TIMEOUT_MAX)) {  
3.    if (after > TIMEOUT_MAX) {  
4.      process.emitWarning(`${after} does not fit into` +  
5.                          ' a 32-bit signed integer.' +  
6.                          '\nTimeout duration was set to 1.',  
7.                          'TimeoutOverflowWarning');  
8.    }  
9.    after = 1; // schedule on next tick, follows browser behavior  
10.  }  
```

我们发现虽然我们传的超时时间是0，但是0不是合法值，nodejs会把超时时间变成1。这就是导致上面的代码输出不确定的原因。我们分析一下这段代码的执行过程。nodejs启动的时候，会编译执行上面的代码，开始一个定时器，挂载一个setImmediate节点在队列。然后进入libuv的事件循环，然后执行定时器阶段，libuv判断从开启定时器到现在是否已经过去了1毫秒，是的话，执行定时器回调，否则执行下一个节点，执行完其他阶段后，会执行check阶段。这时候就会执行setImmediate的回调。所以，一开始的那段代码的输出结果是取决于启动定时器的时间到libuv执行定时器阶段是否过去了1毫秒。
## 11.6 初始化nextTick
nextTick在bootstrap/node.js中挂载到process中。

```c
1.const { nextTick, runNextTicks } = setupTaskQueue();  
2.process.nextTick = nextTick;  
真正的定义在task_queues.js。
1.setupTaskQueue() {   
2.  setTickCallback(processTicksAndRejections);  
3.  return {  
4.    nextTick,  
5.  };  
6.},  
```

setTickCallback是注册处理tick任务的函数，

```c
1.static void SetTickCallback(const FunctionCallbackInfo<Value>& args) {  
2.  Environment* env = Environment::GetCurrent(args);  
3.  CHECK(args[0]->IsFunction());  
4.  env->set_tick_callback_function(args[0].As<Function>());  
5.}  
```

只是简单地保存处理tick任务的函数。后续会用到
## 11.7 nextTick生产任务

```c
1.function nextTick(callback) {  
2.  let args;  
3.  switch (arguments.length) {  
4.    case 1: break;  
5.    case 2: args = [arguments[1]]; break;  
6.    case 3: args = [arguments[1], arguments[2]]; break;  
7.    case 4: args = [arguments[1], arguments[2], arguments[3]]; break;  
8.    default:  
9.      args = new Array(arguments.length - 1);  
10.      for (let i = 1; i < arguments.length; i++)  
11.        args[i - 1] = arguments[i];  
12.  }  
13.  // 第一个任务，开启tick处理逻辑  
14.  if (queue.isEmpty())  
15.    setHasTickScheduled(true);  
16.  const asyncId = newAsyncId();  
17.  const triggerAsyncId = getDefaultTriggerAsyncId();  
18.  const tickObject = {  
19.    [async_id_symbol]: asyncId,  
20.    [trigger_async_id_symbol]: triggerAsyncId,  
21.    callback,  
22.    args  
23.  };  
24.  // 插入队列  
25.  queue.push(tickObject);  
26.}  
```

这就是我们执行nextTick时的逻辑。
## 11.8 处理tick任务
我们再看一下处理的逻辑。Nodejs在初始化时，通过执行setTickCallback(processTicksAndRejections)注册了处理tick任务的函数。Nodejs在初始化时把处理tick任务的函数保存到env中。我们看一下nodejs什么时候会调用这个函数。在nodejs中，使用TickInfo 类管理tick的逻辑。

```c
1.class TickInfo : public MemoryRetainer {  
2. public:  
3.  inline AliasedUint8Array& fields();  
4.  inline bool has_tick_scheduled() const;  
5.  inline bool has_rejection_to_warn() const;  
6. private:  
7.  inline explicit TickInfo(v8::Isolate* isolate);  
8.  enum Fields { kHasTickScheduled = 0, kHasRejectionToWarn, kFieldsCount };  
9.  
10.  AliasedUint8Array fields_;  
11.};  
```

TickInfo主要是有两个标记位。然后通过InternalCallbackScope类的对象方法Close函数执行tick_callback_function。当nodejs底层需要支持一个js回调时，会调用AsyncWrap的MakeCallback。MakeCallback里面调用了InternalMakeCallback。

```c
1.MaybeLocal<Value> InternalMakeCallback(Environment* env,  
2.                                       Local<Object> recv,  
3.                                       const Local<Function> callback,  
4.                                       int argc,  
5.                                       Local<Value> argv[],  
6.                                       async_context asyncContext) {  
7.    
8.  
9.  InternalCallbackScope scope(env, recv, asyncContext);  
10.  // 执行用户层js回调  
11.  scope.Close();  
12.  
13.  return ret;  
14.}  
```

我们看InternalCallbackScope 的Close

```c
1.void InternalCallbackScope::Close() {  
2.  // 省略部分代码  
3.  TickInfo* tick_info = env_->tick_info();  
4.  // 没有tick任务则不需要往下走，在插入tick任务的时候会设置这个为true，没有任务时变成false  
5.  if (!tick_info->has_tick_scheduled() && !tick_info->has_rejection_to_warn()) {  
6.    return;  
7.  }  
8.  
9.  HandleScope handle_scope(env_->isolate());  
10.  Local<Object> process = env_->process_object();  
11.  
12.  if (!env_->can_call_into_js()) return;  
13.  // 处理tick的函数  
14.  Local<Function> tick_callback = env_->tick_callback_function();  
15.  // 处理tick任务  
16.  if (tick_callback->Call(env_->context(), process, 0, nullptr).IsEmpty()) {  
17.    failed_ = true;  
18.  }  
19.}  
```

我们看到每次执行js层的回调的时候，就会处理tick任务。Close函数可以主动调用，或者在InternalCallbackScope对象析构的时候被调用。除了执行js回调时是主动调用Close外，一般处理tick任务的时间点就是在InternalCallbackScope对象被析构的时候。所以在定义了InternalCallbackScope对象的时候，一般就会在对象析构的时候，进行tick任务的处理。另外一种就是在执行的js回调里，调用runNextTicks处理tick任务。比如setImmediate。
