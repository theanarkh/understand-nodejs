setImmediate对应Libuv的check阶段。所提交的任务会在Libuv事件循环的check阶段被执行，check阶段的任务会在每一轮事件循环中被执行，但是setImmediate提交的任务只会执行一次，下面我们会看到Node.js是怎么处理的，我们看一下具体的实现。
## 11.1 setImmediate
### 11.1.1设置处理immediate任务的函数
在Node.js初始化的时候，设置了处理immediate任务的函数

```
1.	// runNextTicks用于处理nextTick产生的任务，这里不关注  
2.	const { processImmediate, processTimers } = getTimerCallbacks(runNextTicks);  
3.	setupTimers(processImmediate, processTimers); 
```

 
我们先看看一下setupTimers（timer.cc）的逻辑。

```
1.	void SetupTimers(const FunctionCallbackInfo<Value>& args) {  
2.	  auto env = Environment::GetCurrent(args);  
3.	  env->set_immediate_callback_function(args[0].As<Function>());  
4.	  env->set_timers_callback_function(args[1].As<Function>());  
5.	}  
```

SetupTimers在env中保存了两个函数processImmediate, processTimers，processImmediate是处理immediate任务的，processTimers是处理定时器任务的，在定时器章节我们已经分析过。
### 11.1.2 注册check阶段的回调
在Node.js初始化的时候，同时初始化了immediate任务相关的数据结构和逻辑。

```
1.	void Environment::InitializeLibuv(bool start_profiler_idle_notifier) { 
2.	  // 初始化immediate相关的handle 
3.	  uv_check_init(event_loop(), immediate_check_handle());  
4.	  // 修改状态为unref，避免没有任务的时候，影响事件循环的退出  
5.	  uv_unref(reinterpret_cast<uv_handle_t*>(immediate_check_handle()));  
6.	  // 激活handle，设置回调
7.	  uv_check_start(immediate_check_handle(), CheckImmediate);  
8.	  // 在idle阶段也插入一个相关的节点  
9.	  uv_idle_init(event_loop(), immediate_idle_handle());  
10.	}  
```

Node.js默认会往check阶段插入一个节点，并设置回调为CheckImmediate，但是初始化状态是unref的，所以如果没有immediate任务的话，不会影响事件循环的退出。我们看一下CheckImmediate函数

```
1.	void Environment::CheckImmediate(uv_check_t* handle) {  
2.	  // 省略部分代码  
3.	  // 没有Immediate节点需要处理  
4.	  if (env->immediate_info()->count() == 0 || 
5.	         !env->can_call_into_js())  
6.	    return;  
7.	  do {  
8.	    // 执行JS层回调immediate_callback_function  
9.	    MakeCallback(env->isolate(),  
10.	                 env->process_object(),  
11.	                 env->immediate_callback_function(), 
12.	                 0,  
13.	                 nullptr,  
14.	                 {0, 0}).ToLocalChecked();  
15.	  } while (env->immediate_info()->has_outstanding() && 
16.	               env->can_call_into_js());  
17.	  /* 
18.	        所有immediate节点都处理完了，置idle阶段对应节点为非激活状态，
19.	        允许Poll IO阶段阻塞和事件循环退出  
20.	    */
21.	  if (env->immediate_info()->ref_count() == 0)  
22.	    env->ToggleImmediateRef(false);  
23.	}  
```

我们看到每一轮事件循环时，CheckImmediate都会被执行，但是如果没有需要处理的任务则直接返回。如果有任务，CheckImmediate函数执行immediate_callback_function函数，这正是Node.js初始化的时候设置的函数processImmediate。看完初始化和处理immediate任务的逻辑后，我们看一下如何产生一个immediate任务。
### 11.1.3 setImmediate生成任务
我们可以通过setImmediate生成一个任务。

```
1.	function setImmediate(callback, arg1, arg2, arg3) {  
2.	  let i, args;  
3.	  switch (arguments.length) {  
4.	    case 1:  
5.	      break;  
6.	    case 2:  
7.	      args = [arg1];  
8.	      break;  
9.	    case 3:  
10.	      args = [arg1, arg2];  
11.	      break;  
12.	    default:  
13.	      args = [arg1, arg2, arg3];  
14.	      for (i = 4; i < arguments.length; i++) {  
15.	        args[i - 1] = arguments[i];  
16.	      }  
17.	      break;  
18.	  }  
19.	  
20.	  return new Immediate(callback, args);  
21.	}  	
```

setImmediate的代码比较简单，新建一个Immediate。我们看一下Immediate的类。 

```
1.	const Immediate = class Immediate {  
2.	  constructor(callback, args) {  
3.	    this._idleNext = null;  
4.	    this._idlePrev = null;  
5.	    this._onImmediate = callback;  
6.	    this._argv = args;  
7.	    this._destroyed = false;  
8.	    this[kRefed] = false;    
9.	    this.ref();  
10.	    // Immediate链表的节点个数，包括ref和unref状态  
11.	    immediateInfo[kCount]++;  
12.	    // 加入链表中  
13.	    immediateQueue.append(this);  
14.	  }  
15.	  // 打上ref标记，往Libuv的idle链表插入一个激活状态的节点，如果还没有的话  
16.	  ref() {  
17.	    if (this[kRefed] === false) {  
18.	      this[kRefed] = true;  
19.	      if (immediateInfo[kRefCount]++ === 0)  
20.	        toggleImmediateRef(true);  
21.	    }  
22.	    return this;  
23.	  }  
24.	  // 和上面相反  
25.	  unref() {  
26.	    if (this[kRefed] === true) {  
27.	      this[kRefed] = false;  
28.	      if (--immediateInfo[kRefCount] === 0)  
29.	        toggleImmediateRef(false);  
30.	    }  
31.	    return this;  
32.	  }  
33.	  
34.	  hasRef() {  
35.	    return !!this[kRefed];  
36.	  }  
37.	};  
```

Immediate类主要做了两个事情。 

1 生成一个节点插入到链表。

```
1.	const immediateQueue = new ImmediateList();  
2.	  
3.	// 双向非循环的链表  
4.	function ImmediateList() {  
5.	  this.head = null;  
6.	  this.tail = null;  
7.	}  
8.	ImmediateList.prototype.append = function(item) {  
9.	  // 尾指针非空，说明链表非空，直接追加在尾节点后面  
10.	  if (this.tail !== null) {  
11.	    this.tail._idleNext = item;  
12.	    item._idlePrev = this.tail;  
13.	  } else {  
14.	    // 尾指针是空说明链表是空的，头尾指针都指向item  
15.	    this.head = item;  
16.	  }  
17.	  this.tail = item;  
18.	};  
19.	  
20.	ImmediateList.prototype.remove = function(item) {  
21.	  // 如果item在中间则自己全身而退，前后两个节点连上  
22.	  if (item._idleNext !== null) {  
23.	    item._idleNext._idlePrev = item._idlePrev;  
24.	  }  
25.	  
26.	  if (item._idlePrev !== null) {  
27.	    item._idlePrev._idleNext = item._idleNext;  
28.	  }  
29.	  // 是头指针，则需要更新头指针指向item的下一个，因为item被删除了，尾指针同理  
30.	  if (item === this.head)  
31.	    this.head = item._idleNext;  
32.	  if (item === this.tail)  
33.	    this.tail = item._idlePrev;  
34.	  // 重置前后指针  
35.	  item._idleNext = null;  
36.	  item._idlePrev = null;  
37.	};  
```

2 如果还没有往Libuv的idle链表里插入一个激活节点的话，则插入一个。从之前的分析，我们知道，Node.js在check阶段插入了一个unref节点，在每次check阶段都会执行该节点的回调，那么这个idle节点有什么用呢？答案在uv_backend_timeout函数中，uv_backend_timeout定义了Poll IO阻塞的时长，如果有ref状态的idle节点则Poll IO阶段不会阻塞（但是不会判断是否有check节点）。所以当有immediate任务时，Node.js会把这个idle插入idle阶段中，表示有任务处理，不能阻塞Poll IO阶段。没有immediate任务时，则移除idle节点。总的来说，idle节点的意义是标记是否有immediate任务需要处理，有的话就不能阻塞Poll IO阶段，并且不能退出事件循环。

```
1.	void ToggleImmediateRef(const FunctionCallbackInfo<Value>& args) { 
2.	  Environment::GetCurrent(args)->ToggleImmediateRef(args[0]->IsTrue())
3.	}  
4.	  
5.	void Environment::ToggleImmediateRef(bool ref) {  
6.	  if (started_cleanup_) return;  
7.	  // 改变handle的状态（激活或不激活），防止在Poll IO阶段阻塞  
8.	  if (ref) { 
9.	    uv_idle_start(immediate_idle_handle(), [](uv_idle_t*){ });  
10.	  } else {  
11.	        // 不阻塞Poll IO，允许事件循环退出
12.	    uv_idle_stop(immediate_idle_handle());  
13.	  }  
14.	}  
```

这是setImmediate函数的整个过程。和定时器一样，我们可以调用immediate任务的ref和unref函数，控制它对事件循环的影响。 
### 11.1.4 处理setImmediate产生的任务
最后我们看一下在check阶段时，是如何处理immediate任务的。由前面分析我们知道processImmediate函数是处理immediate任务的函数，来自getTimerCallbacks（internal/timer.js）。

```
1.	function processImmediate() {  
2.	   /*
3.	       上次执行processImmediate的时候如果由未捕获的异常，
4.	       则outstandingQueue保存了未执行的节点，下次执行processImmediate的时候，
5.	       优先执行outstandingQueue队列的节点  
6.	   */
7.	   const queue = outstandingQueue.head !== null ?  
8.	     outstandingQueue : immediateQueue;  
9.	   let immediate = queue.head;  
10.	   /* 
11.	     在执行immediateQueue队列的话，先置空队列，避免执行回调
12.	         的时候一直往队列加节点，死循环。 所以新加的接口会插入新的队列，
13.	         不会在本次被执行。并打一个标记,全部immediateQueue节点都被执
14.	         行则清空，否则会再执行processImmediate一次，见Environment::CheckImmediate 
15.	   */  
16.	   if (queue !== outstandingQueue) {  
17.	     queue.head = queue.tail = null;  
18.	     immediateInfo[kHasOutstanding] = 1;  
19.	   }  
20.	  
21.	   let prevImmediate;  
22.	   let ranAtLeastOneImmediate = false;  
23.	   while (immediate !== null) {  
24.	     // 执行微任务  
25.	     if (ranAtLeastOneImmediate)  
26.	       runNextTicks();  
27.	     else  
28.	       ranAtLeastOneImmediate = true;  
29.	  
30.	     // 微任务把该节点删除了，则不需要指向它的回调了，继续下一个  
31.	     if (immediate._destroyed) {  
32.	       outstandingQueue.head = immediate = prevImmediate._idleNext;  
33.	       continue;  
34.	     }  
35.	  
36.	     immediate._destroyed = true;  
37.	     // 执行完要修改个数  
38.	     immediateInfo[kCount]--;  
39.	     if (immediate[kRefed])  
40.	       immediateInfo[kRefCount]--;  
41.	     immediate[kRefed] = null;  
42.	     // 见上面if (immediate._destroyed)的注释  
43.	     prevImmediate = immediate;  
44.	     // 执行回调，指向下一个节点  
45.	     try {  
46.	       const argv = immediate._argv;  
47.	       if (!argv)  
48.	         immediate._onImmediate();  
49.	       else  
50.	         immediate._onImmediate(...argv);  
51.	     } finally {  
52.	       immediate._onImmediate = null;  
53.	       outstandingQueue.head = immediate = immediate._idleNext;  
54.	     }  
55.	   }  
56.	   // 当前执行的是outstandingQueue的话则把它清空  
57.	   if (queue === outstandingQueue)  
58.	     outstandingQueue.head = null;  
59.	   // 全部节点执行完  
60.	   immediateInfo[kHasOutstanding] = 0;  
61.	 }  
```

processImmediate的逻辑就是逐个执行immediate任务队列的节点。Immediate分两个队列，正常情况下，插入的immediate节点插入到immediateQueue队列。如果执行的时候有异常，则未处理完的节点就会被插入到outstandingQueue队列，等下一次执行。另外我们看到runNextTicks。runNextTicks在每执行完immediate节点后，都先处理tick任务然后再处理下一个immediate节点。
### 11.1.5 Node.js的setTimeout(fn,0)和setImmediate谁先执行的问题
我们首先看一下下面这段代码

```
1.	setTimeout(()=>{ console.log('setTimeout'); },0)  
2.	setImmediate(()=>{ console.log('setImmedate');})  
```

我们执行上面这段代码，会发现输出是不确定的。下面来看一下为什么。Node.js的事件循环分为几个阶段(phase)。setTimeout是属于定时器阶段，setImmediate是属于check阶段。顺序上定时器阶段是比check更早被执行的。其中setTimeout的实现代码里有一个很重要的细节。

```
1.	after *= 1; // coalesce to number or NaN  
2.	  if (!(after >= 1 && after <= TIMEOUT_MAX)) {  
3.	    if (after > TIMEOUT_MAX) {  
4.	      process.emitWarning(`错误提示`);  
5.	    }  
6.	    after = 1; // schedule on next tick, follows browser behavior  
7.	  }  
```

我们发现虽然我们传的超时时间是0，但是0不是合法值，Node.js会把超时时间变成1。这就是导致上面的代码输出不确定的原因。我们分析一下这段代码的执行过程。Node.js启动的时候，会编译执行上面的代码，开始一个定时器，挂载一个setImmediate节点在队列。然后进入Libuv的事件循环，然后执行定时器阶段，Libuv判断从开启定时器到现在是否已经过去了1毫秒，是的话，执行定时器回调，否则执行下一个节点，执行完其它阶段后，会执行check阶段。这时候就会执行setImmediate的回调。所以，一开始的那段代码的输出结果是取决于启动定时器的时间到Libuv执行定时器阶段是否过去了1毫秒。
## 11.2 nextTick
nextTick用于异步执行一个回调函数，和setTimeout、setImmediate类似，不同的地方在于他们的执行时机，setTimeout和setImmediate的任务属于事件循环的一部分，但是nextTick的任务不属于事件循环的一部分，具体的执行时机我们会在本节分析。
### 11.2.1 初始化nextTick
nextTick函数是在Node.js启动过程中，在执行bootstrap/node.js时挂载到process对象中。

```
1.	const { nextTick, runNextTicks } = setupTaskQueue();  
2.	process.nextTick = nextTick;  
真正的定义在task_queues.js。
1.	setupTaskQueue() {   
2.	  setTickCallback(processTicksAndRejections);  
3.	  return {  
4.	    nextTick,  
5.	  };  
6.	},  
```

nextTick接下来会讲，setTickCallback是注册处理tick任务的函数，

```
1.	static void SetTickCallback(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	  CHECK(args[0]->IsFunction());  
4.	  env->set_tick_callback_function(args[0].As<Function>());  
5.	}  
```

只是简单地保存处理tick任务的函数。后续会用到
### 11.2.2 nextTick生产任务

```
1.	function nextTick(callback) {  
2.	  let args;  
3.	  switch (arguments.length) {  
4.	    case 1: break;  
5.	    case 2: args = [arguments[1]]; break;  
6.	    case 3: args = [arguments[1], arguments[2]]; break;  
7.	    case 4: args = [arguments[1], arguments[2], arguments[3]]; break;  
8.	    default:  
9.	      args = new Array(arguments.length - 1);  
10.	      for (let i = 1; i < arguments.length; i++)  
11.	        args[i - 1] = arguments[i];  
12.	  }  
13.	  // 第一个任务，开启tick处理逻辑  
14.	  if (queue.isEmpty())  
15.	    setHasTickScheduled(true);  
16.	  const asyncId = newAsyncId();  
17.	  const triggerAsyncId = getDefaultTriggerAsyncId();  
18.	  const tickObject = {  
19.	    [async_id_symbol]: asyncId,  
20.	    [trigger_async_id_symbol]: triggerAsyncId,  
21.	    callback,  
22.	    args  
23.	  };  
24.	  // 插入队列  
25.	  queue.push(tickObject);  
26.	}  
```

这就是我们执行nextTick时的逻辑。每次调用nextTick都会往队列中追加一个节点。
### 11.2.3 处理tick任务
我们再看一下处理的tick任务的逻辑。Nodejs在初始化时，通过执行setTickCallback(processTicksAndRejections)注册了处理tick任务的函数。Node.js在初始化时把处理tick任务的函数保存到env中。另外，Nodejs使用TickInfo类管理tick的逻辑。

```
1.	class TickInfo : public MemoryRetainer {  
2.	 public:  
3.	  inline AliasedUint8Array& fields();  
4.	  inline bool has_tick_scheduled() const;  
5.	  inline bool has_rejection_to_warn() const;  
6.	 private:  
7.	  inline explicit TickInfo(v8::Isolate* isolate);  
8.	  enum Fields { kHasTickScheduled = 0, kHasRejectionToWarn, kFieldsCount };  
9.	  
10.	  AliasedUint8Array fields_;  
11.	};  
```

TickInfo主要是有两个标记位，kHasTickScheduled标记是否有tick任务需要处理。然后通过InternalCallbackScope类的对象方法Close函数执行tick_callback_function。当Nodejs底层需要执行一个js回调时，会调用AsyncWrap的MakeCallback。MakeCallback里面调用了InternalMakeCallback。

```
1.	MaybeLocal<Value> InternalMakeCallback(Environment* env, Local<Object> recv, 
2.	const Local<Function> callback, int argc, Local<Value> argv[],
3.	async_context asyncContext) {  
4.	  InternalCallbackScope scope(env, recv, asyncContext);  
5.	  // 执行用户层js回调  
6.	  scope.Close();  
7.	  
8.	  return ret;  
9.	}  
```

我们看InternalCallbackScope 的Close

```
1.	void InternalCallbackScope::Close() {  
2.	  // 省略部分代码  
3.	  TickInfo* tick_info = env_->tick_info();  
4.	  // 没有tick任务则不需要往下走，在插入tick任务的时候会设置这个为true，没有任务时变成false  
5.	  if (!tick_info->has_tick_scheduled() && !tick_info->has_rejection_to_warn()) {  
6.	    return;  
7.	  }  
8.	  
9.	  HandleScope handle_scope(env_->isolate());  
10.	  Local<Object> process = env_->process_object();  
11.	  
12.	  if (!env_->can_call_into_js()) return;  
13.	  // 处理tick的函数  
14.	  Local<Function> tick_callback = env_->tick_callback_function();  
15.	  // 处理tick任务  
16.	  if (tick_callback->Call(env_->context(), process, 0, nullptr).IsEmpty()) {  
17.	    failed_ = true;  
18.	  }  
19.	}  
```

我们看到每次执行js层的回调的时候，就会处理tick任务。Close函数可以主动调用，或者在InternalCallbackScope对象析构的时候被调用。除了执行js回调时是主动调用Close外，一般处理tick任务的时间点就是在InternalCallbackScope对象被析构的时候。所以在定义了InternalCallbackScope对象的时候，一般就会在对象析构的时候，进行tick任务的处理。另外一种就是在执行的js回调里，调用runNextTicks处理tick任务。比如执行immediate任务的过程中。

```
1.	function runNextTicks() {  
2.	  if (!hasTickScheduled() && !hasRejectionToWarn())  
3.	    runMicrotasks();  
4.	  if (!hasTickScheduled() && !hasRejectionToWarn())  
5.	    return;  
6.	  processTicksAndRejections();  
7.	}  
```

我们看processTicksAndRejections是如何处理tick任务的。

```
1.	function processTicksAndRejections() {  
2.	  let tock;  
3.	  do {  
4.	    while (tock = queue.shift()) {  
5.	      const asyncId = tock[async_id_symbol];  
6.	      emitBefore(asyncId, tock[trigger_async_id_symbol]);  
7.	  
8.	      try {  
9.	        const callback = tock.callback;  
10.	        if (tock.args === undefined) {  
11.	          callback();  
12.	        } else {  
13.	          const args = tock.args;  
14.	          switch (args.length) {  
15.	            case 1: callback(args[0]); break;  
16.	            case 2: callback(args[0], args[1]); break;  
17.	            case 3: callback(args[0], args[1], args[2]); break;  
18.	            case 4: callback(args[0], args[1], args[2], args[3]); break;  
19.	            default: callback(...args);  
20.	          }  
21.	        }  
22.	      } finally {  
23.	        if (destroyHooksExist())  
24.	          emitDestroy(asyncId);  
25.	      }  
26.	  
27.	      emitAfter(asyncId);  
28.	    }  
29.	    runMicrotasks();  
30.	  } while (!queue.isEmpty() || processPromiseRejections());  
31.	  setHasTickScheduled(false);  
32.	  setHasRejectionToWarn(false);  
33.	}  
```

从processTicksAndRejections代码中，我们可以看到，Node.js是实时从任务队列里取节点执行的，所以如果我们在nextTick的回调里一直调用nextTick的话，就会导致死循环。

```
1.	function test() {  
2.	  process.nextTick(() => {  
3.	    console.log(1);  
4.	    test()  
5.	  });  
6.	}  
7.	test();  
8.	  
9.	setTimeout(() => {  
10.	 console.log(2)  
11.	}, 10)  
```

上面的代码中，会一直输出1，不会输出2。而在Nodejs源码的很多地方都处理了这个问题，首先把要执行的任务队列移到一个变量q2中，清空之前的队列q1。接着遍历q2指向的队列，如果执行回调的时候又新增了节点，只会加入到q1中。q2不会导致死循环。
### 11.2.4 nextTick的使用
我们知道nextTick可用于延迟执行一些逻辑，我们看一下哪些场景下可以使用nextTick。

```
1.	const { EventEmitter } = require('events');  
2.	class DemoEvents extends EventEmitter {  
3.	  constructor() {  
4.	    super();  
5.	    this.emit('start');  
6.	  }  
7.	}  
8.	  
9.	const demoEvents = new DemoEvents();  
10.	demoEvents.on('start', () => {  
11.	  console.log('start');  
12.	});  
```

以上代码在构造函数中会触发start事件，但是事件的注册却在构造函数之后执行，而在构造函数之前我们还没有拿到DemoEvents对象，无法完成事件的注册。这时候，我们就可以使用nextTick。

```
1.	const { EventEmitter } = require('events');  
2.	class DemoEvents extends EventEmitter {  
3.	  constructor() {  
4.	    super();  
5.	    process.nextTick(() => {  
6.	      this.emit('start');  
7.	    })  
8.	  }  
9.	}  
10.	  
11.	const demoEvents = new DemoEvents();  
12.	demoEvents.on('start', () => {  
13.	  console.log('start');  
14.	});  
```
