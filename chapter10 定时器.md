# 第十章 定时器
14.0.0的nodejs对定时器模块进行了重构，之前版本的实现是用一个map，以超时时间为键，每个键对应一个队列。即有同样超时时间的节点在同一个队列。每个队列对应一个底层的一个节点（二叉堆里的节点），nodejs在时间循环的timer阶段会从二叉堆里找出超时的节点，然后执行回调，回调里会遍历队列，哪个节点超时了。14.0.0重构后，只使用了一个二叉堆的节点。我们看一下他的实现。
我们先看下定时器模块的组织结构。


![在这里插入图片描述](https://img-blog.csdnimg.cn/20200902001403918.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L2h1aWh1b3hxYw==,size_16,color_FFFFFF,t_70#pic_center)


[定时器模块的组织结构图](https://img-blog.csdnimg.cn/20200902001403918.png)



下面我们继续看一下定时器模块的几个重要的数据结构。
## 10.1 核心数据结构
### 10.1.1 TimersList  
超时时间一样的会被放到同一个队列，这个队列就是由TimersList来管理。对应图中的list那个方框。

```c
1.// expiry是超时时间的绝对值。用来记录队列中最快到期的节点的时间，msecs是超时时间的相对值（相对插入时的当前时间）   
2.function TimersList(expiry, msecs) {  
3.  // 用于链表  
4.  this._idleNext = this;   
5.  this._idlePrev = this;   
6.  this.expiry = expiry;  
7.  this.id = timerListId++;  
8.  this.msecs = msecs;  
9.  // 在优先队列里的位置  
10.  this.priorityQueuePosition = null;  
11.}  
```

### 10.1.2 优先队列
const timerListQueue = new PriorityQueue(compareTimersLists, setPosition)  
nodejs用优先队列对所有1中的链表进行管理，优先队列本质是一个二叉堆（小根堆），每个链表在二叉堆里对应一个节点。根据1中，我们知道每个链表都保存链表中最快到期的节点的过期时间。二叉堆以该事件为依据，即最快到期的list对应二叉堆中的根节点。我们判断根节点是否超时，如果没有超时，说明整个二叉堆的节点都没有超时。如果超时了，就需要不断遍历堆中的节点。
3 超时时间和链表的映射 1中已经提到，超时时间一样的节点，会排在同一个链表中个，nodejs中用一个map保存了超时时间到链表的映射关系。 了解完定时器整体的组织和基础数据结构，我们可以开始进入真正的源码分析了。 
## 10.2 设置定时器处理函数
nodejs在初始化的时候对定时器进行了初始化工作。
setupTimers(processImmediate, processTimers);  
setupTimers对应的c++函数是  

```c
1.void SetupTimers(const FunctionCallbackInfo<Value>& args) {  
2.  auto env = Environment::GetCurrent(args);  
3.  env->set_immediate_callback_function(args[0].As<Function>());  
4.  env->set_timers_callback_function(args[1].As<Function>());  
5.} 
```

在env中保存了一个函数，后续需要
## 10.3 设置定时器

```c
1.function setTimeout(callback, after, arg1, arg2, arg3) {  
2.  if (typeof callback !== 'function') {  
3.    throw new ERR_INVALID_CALLBACK(callback);  
4.  }  
5.  
6.  let i, args;  
7.  switch (arguments.length) {  
8.    // fast cases  
9.    case 1:  
10.    case 2:  
11.      break;  
12.    case 3:  
13.      args = [arg1];  
14.      break;  
15.    case 4:  
16.      args = [arg1, arg2];  
17.      break;  
18.    default:  
19.      args = [arg1, arg2, arg3];  
20.      for (i = 5; i < arguments.length; i++) {  
21.        // Extend array dynamically, makes .apply run much faster in v6.0.0  
22.        args[i - 2] = arguments[i];  
23.      }  
24.      break;  
25.  }  
26.  
27.  const timeout = new Timeout(callback, after, args, false, true);  
28.  insert(timeout, timeout._idleTimeout);  
29.  return timeout;  
30.}  
```

两个主要操作，new Timeout和insert。我们一个个来。 

```c
1.function Timeout(callback, after, args, isRepeat, isRefed) {  
2.  after *= 1; // Coalesce to number or NaN  
3.  if (!(after >= 1 && after <= TIMEOUT_MAX)) {  
4.    if (after > TIMEOUT_MAX) {  
5.      process.emitWarning(`${after} does not fit into` +  
6.                          ' a 32-bit signed integer.' +  
7.                          '\nTimeout duration was set to 1.',  
8.                          'TimeoutOverflowWarning');  
9.    }  
10.    after = 1; // Schedule on next tick, follows browser behavior  
11.  }  
12.  // 超时时间相对值  
13.  this._idleTimeout = after;  
14.  // 前后指针，用于链表  
15.  this._idlePrev = this;  
16.  this._idleNext = this;  
17.  // 定时器的开始时间  
18.  this._idleStart = null;  
19.  // This must be set to null first to avoid function tracking  
20.  // on the hidden class, revisit in V8 versions after 6.2  
21.  // 超时回调  
22.  this._onTimeout = null;  
23.  this._onTimeout = callback;  
24.  // 执行回调时传入的参数  
25.  this._timerArgs = args;  
26.  // 是否定期执行回调，用于setInterval  
27.  this._repeat = isRepeat ? after : null;  
28.  this._destroyed = false;  
29.  // 激活底层的定时器节点（二叉堆的节点），说明有定时节点需要处理  
30.  if (isRefed)  
31.    incRefCount();  
32.  this[kRefed] = isRefed;  
33.  
34.  initAsyncResource(this, 'Timeout');  
35.}  
```

Timeout主要是新建一个对象记录一些定时器的上下文信息。  
insert（对照上面的图理解）  

```c
1.let nextExpiry = Infinity;
2.function insert(item, msecs, start = getLibuvNow()) {  
3.  msecs = MathTrunc(msecs);  
4.  // 记录定时器的开始时间，见Timeout函数的定义  
5.  item._idleStart = start;  
6.  // 该超时时间是否已经存在对应的链表  
7.  let list = timerListMap[msecs];  
8.  // 还没有  
9.  if (list === undefined) {  
10.      // 算出绝对超时时间  
11.    const expiry = start + msecs;  
12.    // 新建一个链表  
13.    timerListMap[msecs] = list = new TimersList(expiry, msecs);  
14.    // 插入优先队列  
15.    timerListQueue.insert(list);  
16.    // 算出下一次超时的时间，即最快到期的时间  
17.    if (nextExpiry > expiry) {  
18.      // 设置底层的最后超时时间，这样保证可以尽量按时执行  
19.      scheduleTimer(msecs);  
20.      nextExpiry = expiry;  
21.    }  
22.  }  
23.  // 把当前节点加到队列里  
24.  L.append(list, item);  
25.}  
```

## 10.4 处理定时器
前面我们讲到了设置定时器处理函数和设置一个定时器，但是我们在哪里触发这个处理定时器的函数呢？答案在scheduleTimer函数。Nodejs的实现中，所有js层设置的定时器对应libuv的一个定时器节点，nodejs维护了js层所有定时器的超时最小值。在设置一个定时器的时候，如果新设置的定时器比当前的最小值小，则会通过scheduleTimer修改超时时间。超时的时候，就会执行回调。scheduleTimer函数是对c++函数的封装。  

```c
1.void ScheduleTimer(const FunctionCallbackInfo<Value>& args) {  
2.  auto env = Environment::GetCurrent(args);  
3.  env->ScheduleTimer(args[0]->IntegerValue(env->context()).FromJust());  
4.}  
5.  
6.void Environment::ScheduleTimer(int64_t duration_ms) {  
7.  if (started_cleanup_) return;  
8.  uv_timer_start(timer_handle(), RunTimers, duration_ms, 0);  
9.}  
```

uv_timer_start就是开启底层计时，即往libuv的二叉堆插入一个节点（如果该handle已经存在二叉堆，则先删除）。。超时时间是duration_ms，就是最快到期的时间，在timer阶段会判断是否过期。是的话执行RunTimers函数。我们先看一下该函数的主要代码。

```c
1.Local<Function> cb = env->timers_callback_function();  
2.ret = cb->Call(env->context(), process, 1, &arg);  
```

RunTimers会执行timers_callback_function。timers_callback_function是在nodejs初始化的时候设置的processTimers函数。现在我们知道了nodejs是如何设置超时的处理函数，也知道了什么时候会执行该回调。那我们就来看一下回调时具体处理逻辑。 

```c
1.void Environment::RunTimers(uv_timer_t* handle) {  
2.  Local<Function> cb = env->timers_callback_function();  
3.  MaybeLocal<Value> ret;  
4.  Local<Value> arg = env->GetNow();  
5.  
6.  do {  
7.    // 执行js回调，即下面的processTimers函数  
8.    ret = cb->Call(env->context(), process, 1, &arg);  
9.  } while (ret.IsEmpty() && env->can_call_into_js());  
10.  
11.  // 是否执行了所有的节点 ，即所有节点已经超时
12.  if (ret.IsEmpty())  
13.    return;  
14.  // ret为第一个未超时的节点的超时时间
15.  int64_t expiry_ms = ret.ToLocalChecked()->IntegerValue(env->context()).FromJust();  
16.  
17.  uv_handle_t* h = reinterpret_cast<uv_handle_t*>(handle);  
18.  // 还有超时节点，开块超时时间是expiry_ms ，需要重新插入底层的二叉堆。  
19.  if (expiry_ms != 0) {  
20.    // 算出下次超时的相对值int64_t duration_ms =  
21.        llabs(expiry_ms) - (uv_now(env->event_loop()) - env->timer_base());  
22.    // 重新把handle插入libuv的二叉堆  
23.    env->ScheduleTimer(duration_ms > 0 ? duration_ms : 1);  
24.  
25.  }  
26.}  
```

该函数主要是执行回调，然后如果还有没超时的节点，重新设置libuv定时器的时间。看看js层面。  

```c
1. function processTimers(now) {  
2.    nextExpiry = Infinity;  
3.  
4.    let list;  
5.    let ranAtLeastOneList = false;  
6.    // 取出优先队列的根节点，即最快到期的节点  
7.    while (list = timerListQueue.peek()) {  
8.      // 还没过期，  
9.      if (list.expiry > now) {  
10.        nextExpiry = list.expiry;  
11.        // 返回下一次过期的时间  
12.        return refCount > 0 ? nextExpiry : -nextExpiry;  
13.      }  
14.  
15.      listOnTimeout(list, now);  
16.    }  
17.    return 0;  
18.  }  
19.  
20.  function listOnTimeout(list, now) {  
21.    const msecs = list.msecs;  
22.  
23.    debug('timeout callback %d', msecs);  
24.  
25.    let ranAtLeastOneTimer = false;  
26.    let timer;  
27.    // 遍历具有统一相对过期时间的队列  
28.    while (timer = L.peek(list)) {  
29.      // 算出已经过去的时间  
30.      const diff = now - timer._idleStart;  
31.      // 过期的时间比超时时间小，还没过期  
32.      if (diff < msecs) {  
33.        // 整个链表节点的最快过期时间等于当前还没过期节点的值，链表是有序的  
34.        list.expiry = MathMax(timer._idleStart + msecs, now + 1);  
35.        // 更新id，用于决定在优先队列里的位置  
36.        list.id = timerListId++;  
37.        // 调整过期时间后，当前链表对应的节点不一定是优先队列里的根节点了，可能有他更快到期，即当前链表需要往下沉  
38.        timerListQueue.percolateDown(1);  
39.        return;  
40.      }  
41.  
42.      // 准备执行用户设置的回调，删除这个节点  
43.      L.remove(timer);  
44.  
45.      let start;  
46.      if (timer._repeat)  
47.        start = getLibuvNow();  
48.  
49.      try {  
50.        const args = timer._timerArgs;  
51.        // 执行用户设置的回调  
52.        if (args === undefined)  
53.          timer._onTimeout();  
54.        else  
55.          timer._onTimeout(...args);  
56.      } finally {  
57.        // 设置了重复执行回调，即来自setInterval。则需要重新加入链表。  
58.        if (timer._repeat && timer._idleTimeout !== -1) {  
59.          // 更新超时时间，一样的时间间隔  
60.          timer._idleTimeout = timer._repeat;  
61.          // 重新插入链表  
62.          insert(timer, timer._idleTimeout, start);  
63.        } else if (!timer._idleNext && !timer._idlePrev && !timer._destroyed) {  
64.          timer._destroyed = true;  
65.          if (timer[kRefed])  
66.            refCount--;  
67.    }  
68.    // 为空则删除  
69.    if (list === timerListMap[msecs]) {  
70.      delete timerListMap[msecs];  
71.      timerListQueue.shift();  
72.    }  
73.  }  
```

上面的代码主要是遍历优先队列，如果当前节点超时，即遍历他对应的链表。否则重新计算出最快超时时间，修改底层libuv的节点。即更新超时时间。遍历链表的时候如果遇到超时的则执行，如果没有超时的说明后面的节点也不会超时了。因为链表是有序的。修改链表的最快超时时间的值，调整他在优先队列的位置。因为超时时间变了。可能需要调整。另外setInterval是类似的。
## 10.5 libuv的实现
Libuv中使用二叉堆实现了定时器。
### 10.5.1 libuv中维护定时器的数据结构

```c
1.// 取出loop中的计时器堆指针  
2.static struct heap *timer_heap(const uv_loop_t* loop) {  
3.#ifdef _WIN32  
4.  return (struct heap*) loop->timer_heap;  
5.#else  
6.  return (struct heap*) &loop->timer_heap;  
7.#endif  
8.}  
```

### 10.5.2 比较函数
因为libuv使用二叉堆实现定时器，这就涉及到节点插入堆的时候的规则。

```c
9.static int timer_less_than(const struct heap_node* ha,  
10.                           const struct heap_node* hb) {  
11.  const uv_timer_t* a;  
12.  const uv_timer_t* b;  
13.  // 通过结构体成员找到结构体首地址  
14.  a = container_of(ha, uv_timer_t, heap_node);  
15.  b = container_of(hb, uv_timer_t, heap_node);  
16.  // 比较两个结构体中的超时时间  
17.  if (a->timeout < b->timeout)  
18.    return 1;  
19.  if (b->timeout < a->timeout)  
20.    return 0;  
21.  
22.  /* Compare start_id when both have the same timeout. start_id is 
23.   * allocated with loop->timer_counter in uv_timer_start(). 
24.   */  
25.  // 超时时间一样的话，看谁先创建  
26.  if (a->start_id < b->start_id)  
27.    return 1;  
28.  if (b->start_id < a->start_id)  
29.    return 0;  
30.  
31.  return 0;  
}
```

### 10.5.3 初始化定时器结构体
如果需要使用定时器，首先要对定时器的结构体进行初始化。

```c
1.// 初始化uv_timer_t结构体  
2.int uv_timer_init(uv_loop_t* loop, uv_timer_t* handle) {  
3.  uv__handle_init(loop, (uv_handle_t*)handle, UV_TIMER);  
4.  handle->timer_cb = NULL;  
5.  handle->repeat = 0;  
6.  return 0;  
7.}
```

### 10.5.4 插入一个定时器

```c
1.// 启动一个计时器  
2.int uv_timer_start(uv_timer_t* handle,  
3.                   uv_timer_cb cb,  
4.                   uint64_t timeout,  
5.                   uint64_t repeat) {  
6.  uint64_t clamped_timeout;  
7.  
8.  if (cb == NULL)  
9.    return UV_EINVAL;  
10.  // 重新执行start的时候先把之前的停掉  
11.  if (uv__is_active(handle))  
12.    uv_timer_stop(handle);  
13.  // 超时时间，为绝对值  
14.  clamped_timeout = handle->loop->time + timeout;  
15.  if (clamped_timeout < timeout)  
16.    clamped_timeout = (uint64_t) -1;  
17.  // 初始化回调，超时时间，是否重复计时，赋予一个独立无二的id  
18.  handle->timer_cb = cb;  
19.  handle->timeout = clamped_timeout;  
20.  handle->repeat = repeat;  
21.  /* start_id is the second index to be compared in uv__timer_cmp() */  
22.  handle->start_id = handle->loop->timer_counter++;  
23.  // 插入最小堆  
24.  heap_insert(timer_heap(handle->loop),  
25.              (struct heap_node*) &handle->heap_node,  
26.              timer_less_than);  
27.  // 激活该handle  
28.  uv__handle_start(handle);  
29.  
30.  return 0;  
31.}
```

### 10.5.5 停止一个定时器

```c
1.// 停止一个计时器  
2.int uv_timer_stop(uv_timer_t* handle) {  
3.  if (!uv__is_active(handle))  
4.    return 0;  
5.  // 从最小堆中移除该计时器节点  
6.  heap_remove(timer_heap(handle->loop),  
7.              (struct heap_node*) &handle->heap_node,  
8.              timer_less_than);  
9.  // 清除激活状态和handle的active数减一  
10.  uv__handle_stop(handle);  
11.  
12.  return 0;  
13.}
```

### 10.5.6 重新设置定时器
重新设置定时器类似插入一个定时器，他首先需要把之前的定时器从二叉堆中移除，然后重新插入二叉堆。

```c
1.// 重新启动一个计时器，需要设置repeat标记   
2.int uv_timer_again(uv_timer_t* handle) {  
3.  if (handle->timer_cb == NULL)  
4.    return UV_EINVAL;  
5.  // 如果设置了repeat标记说明计时器是需要重复触发的  
6.  if (handle->repeat) {  
7.    // 先把旧的计时器节点从最小堆中移除，然后再重新开启一个计时器  
8.    uv_timer_stop(handle);  
9.    uv_timer_start(handle, handle->timer_cb, handle->repeat, handle->repeat);  
10.  }  
11.  
12.  return 0; 
13.}
```

### 10.5.7 计算二叉堆中超时时间最小值
超时时间最小值，主要用于判断poll io节点是阻塞的最长时间。

```c
1.// 计算最小堆中最小节点的超时时间，即最小的超时时间  
2.int uv__next_timeout(const uv_loop_t* loop) {  
3.  const struct heap_node* heap_node;  
4.  const uv_timer_t* handle;  
5.  uint64_t diff;  
6.  // 取出堆的根节点，即超时时间最小的  
7.  heap_node = heap_min(timer_heap(loop));  
8.  if (heap_node == NULL)  
9.    return -1; /* block indefinitely */  
10.    
11.  handle = container_of(heap_node, uv_timer_t, heap_node);  
12.  // 如果最小的超时时间小于当前时间，则返回0，说明已经超时  
13.  if (handle->timeout <= loop->time)  
14.    return 0;  
15.  // 否则计算还有多久超时，返回给epoll，epoll的timeout不能大于diff  
16.  diff = handle->timeout - loop->time;  
17.  if (diff > INT_MAX)  
18.    diff = INT_MAX;  
19.  
20.  return diff;  
21.}  
```

### 10.5.8 处理定时器
处理超时定时器就是遍历二叉堆，判断哪个节点超时了。

```c
1.// 找出已经超时的节点，并且执行里面的回调  
2.void uv__run_timers(uv_loop_t* loop) {  
3.  struct heap_node* heap_node;  
4.  uv_timer_t* handle;  
5.  
6.  for (;;) {  
7.    heap_node = heap_min(timer_heap(loop));  
8.    if (heap_node == NULL)  
9.      break;  
10.  
11.    handle = container_of(heap_node, uv_timer_t, heap_node);  
12.    // 如果当前节点的时间大于当前时间则返回，说明后面的节点也没有超时  
13.    if (handle->timeout > loop->time)  
14.      break;  
15.    // 移除该计时器节点，重新插入最小堆，如果设置了repeat的话  
16.    uv_timer_stop(handle);  
17.    uv_timer_again(handle);  
18.    // 执行超时回调  
19.    handle->timer_cb(handle);  
20.  }  
21.}  
```
