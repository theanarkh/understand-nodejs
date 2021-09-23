

Node.js V14对定时器模块进行了重构，之前版本的实现是用一个map，以超时时间为键，每个键对应一个队列。即有同样超时时间的节点在同一个队列。每个队列对应一个底层的一个节点（二叉堆里的节点），Node.js在事件循环的timer阶段会从二叉堆里找出超时的节点，然后执行回调，回调里会遍历队列，判断哪个节点超时了。14重构后，只使用了一个二叉堆的节点。我们看一下它的实现，首先看下定时器模块的整体关系图，如图10-1所示。  
![](https://img-blog.csdnimg.cn/2834e17d10244f93861a062f659afa28.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图10-1

下面我们先看一下定时器模块的几个重要的数据结构。
## 10.1 Libuv的实现
Libuv中使用二叉堆实现了定时器。最快到期的节点是根节点。
### 10.1.1 Libuv中维护定时器的数据结构

```cpp
    // 取出loop中的计时器堆指针  
    static struct heap *timer_heap(const uv_loop_t* loop) {  
      return (struct heap*) &loop->timer_heap;   
    }  
```

### 10.1.2 比较函数
因为Libuv使用二叉堆实现定时器，这就涉及到节点插入堆的时候的规则。

```cpp
    static int timer_less_than(const struct heap_node* ha,  
                   const struct heap_node* hb) {  
      const uv_timer_t* a;  
      const uv_timer_t* b;  
      // 通过结构体成员找到结构体首地址  
      a = container_of(ha, uv_timer_t, heap_node);  
      b = container_of(hb, uv_timer_t, heap_node);  
      // 比较两个结构体中的超时时间  
      if (a->timeout < b->timeout)  
        return 1;  
      if (b->timeout < a->timeout)  
        return 0;  
      // 超时时间一样的话，看谁先创建  
      if (a->start_id < b->start_id)  
        return 1;  
      if (b->start_id < a->start_id)  
        return 0;  
      
      return 0; 
    } 
```

### 10.1.3 初始化定时器结构体
如果需要使用定时器，首先要对定时器的结构体进行初始化。

```cpp
    // 初始化uv_timer_t结构体  
    int uv_timer_init(uv_loop_t* loop, uv_timer_t* handle) {  
      uv__handle_init(loop, (uv_handle_t*)handle, UV_TIMER);  
      handle->timer_cb = NULL;  
      handle->repeat = 0;  
      return 0;  
    }
```

### 10.1.4 插入一个定时器

```cpp
    // 启动一个计时器  
    int uv_timer_start(uv_timer_t* handle,  
                       uv_timer_cb cb,  
                       uint64_t timeout,  
                       uint64_t repeat) {  
      uint64_t clamped_timeout;  
      
      if (cb == NULL)  
        return UV_EINVAL;  
      // 重新执行start的时候先把之前的停掉  
      if (uv__is_active(handle))  
        uv_timer_stop(handle);  
      // 超时时间，为绝对值  
      clamped_timeout = handle->loop->time + timeout;  
      if (clamped_timeout < timeout)  
        clamped_timeout = (uint64_t) -1;  
      // 初始化回调，超时时间，是否重复计时，赋予一个独立无二的id  
      handle->timer_cb = cb;  
      handle->timeout = clamped_timeout;  
      handle->repeat = repeat;  
      // 用于超时时间一样的时候，比较定时器在二叉堆的位置，见cmp函数  
      handle->start_id = handle->loop->timer_counter++;  
      // 插入最小堆  
      heap_insert(timer_heap(handle->loop),  
                  (struct heap_node*) &handle->heap_node, 
                  timer_less_than);  
      // 激活该handle  
      uv__handle_start(handle);  
      
      return 0;  
    }
```

### 10.1.5 停止一个定时器

```cpp
    // 停止一个计时器  
    int uv_timer_stop(uv_timer_t* handle) {  
      if (!uv__is_active(handle))  
        return 0;  
      // 从最小堆中移除该计时器节点  
      heap_remove(timer_heap(handle->loop),  
                  (struct heap_node*) &handle->heap_node, 
                  timer_less_than);  
      // 清除激活状态和handle的active数减一  
      uv__handle_stop(handle);  
      
      return 0;  
    }
```

### 10.1.6 重新设置定时器
重新设置定时器类似插入一个定时器，它首先需要把之前的定时器从二叉堆中移除，然后重新插入二叉堆。

```cpp
    // 重新启动一个计时器，需要设置repeat标记   
    int uv_timer_again(uv_timer_t* handle) {  
      if (handle->timer_cb == NULL)  
        return UV_EINVAL;  
      // 如果设置了repeat标记说明计时器是需要重复触发的  
      if (handle->repeat) {  
        // 先把旧的节点从最小堆中移除，然后再重新开启一个计时器  
        uv_timer_stop(handle);  
        uv_timer_start(handle, 
                           handle->timer_cb, 
                           handle->repeat, 
                           handle->repeat);  
      }  
      
      return 0; 
    }
```

### 10.1.7 计算二叉堆中超时时间最小值
超时时间最小值，主要用于判断Poll IO节点是阻塞的最长时间。

```cpp
    // 计算最小堆中最小节点的超时时间，即最小的超时时间  
    int uv__next_timeout(const uv_loop_t* loop) {  
      const struct heap_node* heap_node;  
      const uv_timer_t* handle;  
      uint64_t diff;  
      // 取出堆的根节点，即超时时间最小的  
      heap_node = heap_min(timer_heap(loop));  
      if (heap_node == NULL)  
        return -1; /* block indefinitely */  
        
      handle = container_of(heap_node, uv_timer_t, heap_node);  
      // 如果最小的超时时间小于当前时间，则返回0，说明已经超时  
      if (handle->timeout <= loop->time)  
        return 0;  
      // 否则计算还有多久超时，返回给epoll，epoll的timeout不能大于diff  
      diff = handle->timeout - loop->time;  
      if (diff > INT_MAX)  
        diff = INT_MAX;  
      
      return diff;  
    }  
```

### 10.1.8 处理定时器
处理超时定时器就是遍历二叉堆，判断哪个节点超时了。

```cpp
    // 找出已经超时的节点，并且执行里面的回调  
    void uv__run_timers(uv_loop_t* loop) {  
      struct heap_node* heap_node;  
      uv_timer_t* handle;  
      
      for (;;) {  
        heap_node = heap_min(timer_heap(loop));  
        if (heap_node == NULL)  
          break;  
      
        handle = container_of(heap_node, uv_timer_t, heap_node);  
        // 如果当前节点的时间大于当前时间则返回，说明后面的节点也没有超时  
        if (handle->timeout > loop->time)  
          break;  
        // 移除该计时器节点，重新插入最小堆，如果设置了repeat的话  
        uv_timer_stop(handle);  
        uv_timer_again(handle);  
        // 执行超时回调  
        handle->timer_cb(handle);  
      }  
    }  
```

## 10.2 核心数据结构
### 10.2.1 TimersList  
相对超时时间一样的定时器会被放到同一个队列，比如当前执行setTimeout(()=>{}, 10000})和5秒后执行setTimeout(()=>{}, 10000})，这两个任务就会在同一个List中，这个队列由TimersList来管理。对应图1中的List那个队列。

```js
    function TimersList(expiry, msecs) {  
      // 用于链表  
      this._idleNext = this;   
      this._idlePrev = this;   
      this.expiry = expiry;  
      this.id = timerListId++;  
      this.msecs = msecs;  
      // 在优先队列里的位置  
      this.priorityQueuePosition = null;  
    }  
```

expiry记录的是链表中最快超时的节点的绝对时间。每次执行定时器阶段时会动态更新，msecs是超时时间的相对值（相对插入时的当前时间）。用于计算该链表中的节点是否超时。后续我们会看到具体的用处。
### 10.2.2 优先队列

```js
    const timerListQueue = new PriorityQueue(compareTimersLists, setPosition)  
```

Node.js用优先队列对所有TimersList链表进行管理，优先队列本质是一个二叉堆（小根堆），每个TimersList链表在二叉堆里对应一个节点。根据TimersList的结构，我们知道每个链表都保存链表中最快到期的节点的过期时间。二叉堆以该时间为依据，即最快到期的list对应二叉堆中的根节点。根节点的到期时间就是整个Node.js定时器最快到期的时间，Node.js把Libuv中定时器节点的超时时间设置为该值，在事件循环的定时器阶段就会处理定时的节点，并且不断遍历优先队列，判断当前节点是否超时，如果超时了，就需要处理，如果没有超时，说明整个二叉堆的节点都没有超时。然后重新设置Libuv定时器节点新的到期时间。  

另外，Node.js中用一个map保存了超时时间到TimersList链表的映射关系。 这样就可以根据相对超时时间快速找到对应的列表，利用空间换时间。了解完定时器整体的组织和核心数据结构，我们可以开始进入真正的源码分析了。 
## 10.3 设置定时器处理函数
Node.js在初始化的时候设置了处理定时器的函数。
setupTimers(processImmediate, processTimers);  
setupTimers对应的C++函数是  

```cpp
    void SetupTimers(const FunctionCallbackInfo<Value>& args) {  
      auto env = Environment::GetCurrent(args);  
      env->set_immediate_callback_function(args[0].As<Function>());  
      env->set_timers_callback_function(args[1].As<Function>());  
    } 
```

SetupTimers在env中保存了两个函数，processImmediate是处理setImmediate的，processTimers是处理定时器的。当有节点超时时，Node.js会执行该函数处理超时的节点，后续会看到该函数的具体处理逻辑。下面我们看一下如何设置一个定时器。
## 10.4 设置定时器

```js
    function setTimeout(callback, after, arg1, arg2, arg3) {  
      // 忽略处理参数args逻辑
        // 新建一个Timeout对象
      const timeout = new Timeout(callback, 
                                        after, 
                                        args, 
                                        false, 
                                        true);  
      insert(timeout, timeout._idleTimeout);  
      return timeout;  
    }  
```

setTimeout主要包含两个操作，new Timeout和insert。我们逐个分析一下。
1 setTimeout

```js
    function Timeout(callback, after, args, isRepeat, isRefed) {  
      after *= 1; // Coalesce to number or NaN  
        // 关于setTimeout的超时时间为0的问题在这里可以揭开迷雾
      if (!(after >= 1 && after <= TIMEOUT_MAX)) { 
        after = 1; 
      }  
      // 超时时间相对值  
      this._idleTimeout = after;  
      // 前后指针，用于链表  
      this._idlePrev = this;  
      this._idleNext = this;  
      // 定时器的开始时间  
      this._idleStart = null; 
      // 超时回调    
      this._onTimeout = callback;  
      // 执行回调时传入的参数  
      this._timerArgs = args;  
      // 是否定期触发超时，用于setInterval  
      this._repeat = isRepeat ? after : null;  
      this._destroyed = false;  
        // this._idleStart = now();
      // 激活底层的定时器节点（二叉堆的节点），说明有定时节点需要处理  
      if (isRefed)  
        incRefCount(); 
        // 记录状态 
      this[kRefed] = isRefed;  
     }  
```

Timeout主要是新建一个对象记录一些定时器的相对超时时间（用于支持setInterval，重新插入队列时找到所属队列）、开始时间（用于计算定时器是否超时）等上下文信息。这里有一个关键的逻辑是isRefed的值。Node.js支持ref和unref状态的定时器（setTimeout 和setUnrefTimeout），unref状态的定时器，不会影响事件循环的退出。即当只有unref状态的定时器时，事件循环会结束。当isRefed为true时会执行incRefCount();

```cpp
    function incRefCount() {  
      if (refCount++ === 0)  
        toggleTimerRef(true);  
    }  
      
    void ToggleTimerRef(const FunctionCallbackInfo<Value>& args) {  
      Environment::GetCurrent(args)->ToggleTimerRef(args[0]->IsTrue());  
    }  
      
    void Environment::ToggleTimerRef(bool ref) {  
      if (started_cleanup_) return;  
      // 打上ref标记，  
      if (ref) {  
        uv_ref(reinterpret_cast<uv_handle_t*>(timer_handle()));  
      } else {  
        uv_unref(reinterpret_cast<uv_handle_t*>(timer_handle()));  
      }  
    }  
```

我们看到最终会调用Libuv的uv_ref或uv_unref修改定时器相关handle的状态，因为Node.js只会在Libuv中注册一个定时器handle并且是常驻的，如果JS层当前没有设置定时器，则需要修改定时器handle的状态为unref，否则会影响事件循环的退出。refCount值便是记录JS层ref状态的定时器个数的。所以当我们第一次执行setTimeout的时候，Node.js会激活Libuv的定时器节点。接着我们看一下insert。

```js
    let nextExpiry = Infinity;
    function insert(item, msecs, start = getLibuvNow()) {  
      msecs = MathTrunc(msecs);  
      // 记录定时器的开始时间，见Timeout函数的定义  
      item._idleStart = start;  
      // 该相对超时时间是否已经存在对应的链表  
      let list = timerListMap[msecs];  
      // 还没有  
      if (list === undefined) {  
        // 算出绝对超时时间，第一个节点是该链表中最早到期的节点  
        const expiry = start + msecs;  
        // 新建一个链表  
        timerListMap[msecs] = list = new TimersList(expiry, msecs);  
        // 插入优先队列  
        timerListQueue.insert(list);  
        /*
              nextExpiry记录所有超时节点中最快到期的节点，
              如果有更快到期的，则修改底层定时器节点的过期时间  
            */
        if (nextExpiry > expiry) {  
          // 修改底层超时节点的超时时间  
          scheduleTimer(msecs);  
          nextExpiry = expiry;  
        }  
      }  
      // 把当前节点加到链表里  
      L.append(list, item);  
    }  
```

Insert的主要逻辑如下  
1 如果该超时时间还没有对应的链表，则新建一个链表，每个链表都会记录该链表中最快到期的节点的值，即第一个插入的值。然后把链表插入优先队列，优先队列会根据该链表的最快过期时间的值，把链表对应的节点调整到相应的位置。  
2 如果当前设置的定时器，比之前所有的定时器都快到期，则需要修改底层的定时器节点，使得更快触发超时。  
3 把当前的定时器节点插入对应的链表尾部。即该链表中最久超时的节点。  
假设我们在0s的时候插入一个节点，下面是插入第一个节点时的结构图如图10-2所示。
 ![](https://img-blog.csdnimg.cn/8088834776f84585a4d5ef050c73fbee.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)

图10-2

下面我们看一下多个节点的情况。假设0s的时候插入两个节点10s过期和11s过期。如图10-3所示。
 ![在这里插入图片描述](https://img-blog.csdnimg.cn/0e5e072cd20f40ba9ef60780d254ca7b.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)

图10-3

然后在1s的时候，插入一个新的11s过期的节点，9s的时候插入一个新的10s过期节点。我们看一下这时候的关系图如图10-4所示。
![](https://img-blog.csdnimg.cn/d32f8c30193b4123b7cd8415caee82bc.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)

图10-4

我们看到优先队列中，每一个节点是一个链表，父节点对应的链表的第一个元素是比子节点链表的第一个元素先超时的，但是链表中后续节点的超时就不一定。比如子节点1s开始的节点就比父节点9s开始的节点先超时。因为同一队列，只是相对超时时间一样，而还有一个重要的因素是开始的时间。虽然某节点的相对超时时间长，但是如果它比另一个节点开始的早，那么就有可能比它先超时。后续我们会看到具体是怎么实现的。
## 10.5 处理定时器
前面我们讲到了设置定时器处理函数和设置一个定时器，但是在哪里触发这个处理定时器的函数呢？答案在scheduleTimer函数。Node.js的实现中，所有JS层设置的定时器对应Libuv的一个定时器节点，Node.js维护了JS层所有定时器的超时最小值。在第一个设置定时器或者设置一个新的定时器时，如果新设置的定时器比当前的最小值小，则会通过scheduleTimer修改超时时间。超时的时候，就会执行回调。scheduleTimer函数是对C++函数的封装。  

```cpp
    void ScheduleTimer(const FunctionCallbackInfo<Value>& args) {  
      auto env = Environment::GetCurrent(args);  
      env->ScheduleTimer(args[0]->IntegerValue(env->context()).FromJust());  
    }  
      
    void Environment::ScheduleTimer(int64_t duration_ms) {  
      if (started_cleanup_) return;  
      uv_timer_start(timer_handle(), RunTimers, duration_ms, 0);  
    }  
```

uv_timer_start就是开启底层计时，即往Libuv的二叉堆插入一个节点（如果该handle已经存在二叉堆，则先删除）。超时时间是duration_ms，就是最快到期的时间，超时回调是RunTimers，在timer阶段会判断是否过期。是的话执行RunTimers函数。我们先看一下RunTimers函数的主要代码。

```cpp
    Local<Function> cb = env->timers_callback_function();  
    ret = cb->Call(env->context(), process, 1, &arg);  
```

RunTimers会执行timers_callback_function。timers_callback_function是在Node.js初始化的时候设置的processTimers函数。现在我们知道了Node.js是如何设置超时的处理函数，也知道了什么时候会执行该回调。那我们就来看一下回调时具体处理逻辑。 

```cpp
    void Environment::RunTimers(uv_timer_t* handle) {  
      Local<Function> cb = env->timers_callback_function();  
      MaybeLocal<Value> ret;  
      Local<Value> arg = env->GetNow();  
      
      do {  
        // 执行js回调processTimers函数  
        ret = cb->Call(env->context(), process, 1, &arg);  
      } while (ret.IsEmpty() && env->can_call_into_js());  
        
      // 如果还有未超时的节点，则ret为第一个未超时的节点的超时时间
      int64_t expiry_ms = ret.ToLocalChecked()->IntegerValue(env->context()).FromJust();  
      uv_handle_t* h = reinterpret_cast<uv_handle_t*>(handle);  
      
        /*  
          1 等于0说明所有节点都执行完了，但是定时器节点还是在Libuv中， 
              不过改成非激活状态，即不会影响Libuv退出，因为当前没有需要处理的节点了（handle）， 
          2 不等于0说明没有还要节点需要处理，这种情况又分为两种 
            1 还有激活状态的定时器，即不允许事件循环退出 
            2 定时器都是非激活状态的，允许事件循环退出 
          具体见Timeout的unref和ref方法 
        */  
        if (expiry_ms != 0) {  
            // 算出下次超时的相对值  
            int64_t duration_ms =  
                llabs(expiry_ms) - (uv_now(env->event_loop()) - env->timer_base());  
            // 重新把handle插入Libuv的二叉堆  
            env->ScheduleTimer(duration_ms > 0 ? duration_ms : 1);  
            /* 
              见internal/timer.js的processTimers 
              1 大于0说明还有节点没超时，并且不允许事件循环退出， 
                需要保持定时器的激活状态（如果之前是激活状态则不影响）， 
              2 小于0说明定时器不影响Libuv的事件循环的结束，改成非激活状态 
            */  
            if (expiry_ms > 0)  
              uv_ref(h);  
            else  
              uv_unref(h);  
          } else {  
            uv_unref(h);  
          }  
    }
```

该函数主要是执行回调，然后如果还有没超时的节点，重新设置Libuv定时器的时间。看看JS层面。  

```js
     function processTimers(now) {  
        nextExpiry = Infinity;  
        let list;  
        let ranAtLeastOneList = false;  
        // 取出优先队列的根节点，即最快到期的节点  
        while (list = timerListQueue.peek()) {  
          // 还没过期，则取得下次到期的时间，重新设置超时时间  
          if (list.expiry > now) {  
            nextExpiry = list.expiry;  
            // 返回下一次过期的时间，负的说明允许事件循环退出  
            return refCount > 0 ? nextExpiry : -nextExpiry;  
          }  
      
             // 处理超时节点
                   listOnTimeout(list, now);  
        }  
            // 所有节点都处理完了
        return 0;  
      }  
      
      function listOnTimeout(list, now) {  
        const msecs = list.msecs;  
        let ranAtLeastOneTimer = false;  
        let timer;  
        // 遍历具有统一相对过期时间的队列  
        while (timer = L.peek(list)) {  
          // 算出已经过去的时间  
          const diff = now - timer._idleStart;  
          // 过期的时间比超时时间小，还没过期  
          if (diff < msecs) {  
            /* 
                        整个链表节点的最快过期时间等于当前
                        还没过期节点的值，链表是有序的  
                    */
            list.expiry = MathMax(timer._idleStart + msecs, 
                                            now + 1);  
            // 更新id，用于决定在优先队列里的位置  
            list.id = timerListId++;  
            /*
                     调整过期时间后，当前链表对应的节点不一定是优先队列
                      里的根节点了，可能有它更快到期，即当前链表对应的节
                      点可能需要往下沉
                    */  
            timerListQueue.percolateDown(1);  
            return;  
          }  
      
          // 准备执行用户设置的回调，删除这个节点  
          L.remove(timer);  
      
          let start;  
          if (timer._repeat)  
            start = getLibuvNow(); 
          try {  
            const args = timer._timerArgs;  
            // 执行用户设置的回调  
            if (args === undefined)  
              timer._onTimeout();  
            else  
              timer._onTimeout(...args);  
          } finally {  
            /* 
                        设置了重复执行回调，即来自setInterval。
                        则需要重新加入链表。  
                    */
            if (timer._repeat && 
                         timer._idleTimeout !== -1) {  
              // 更新超时时间，一样的时间间隔  
              timer._idleTimeout = timer._repeat;  
              // 重新插入链表  
              insert(timer, timer._idleTimeout, start);  
            } else if (!timer._idleNext && 
                                  !timer._idlePrev && 
                                  !timer._destroyed) {          
                        timer._destroyed = true;
                        // 是ref类型，则减去一个，防止阻止事件循环退出  
              if (timer[kRefed])  
                refCount--;  
        }  
        // 为空则删除  
        if (list === timerListMap[msecs]) {  
          delete timerListMap[msecs];  
                // 从优先队列中删除该节点，并调整队列结构
          timerListQueue.shift();  
        }  
      }  
```

上面的代码主要是遍历优先队列  
1 如果当前节点超时，则遍历它对应的链表。遍历链表的时候如果遇到超时的节点则执行。如果遇到没有超时的节点，则说明后面的节点也不会超时了，因为链表是有序的，接着重新计算出最快超时时间，修改链表的expiry字段。调整在优先队列的位置。因为修改后的expiry可能会导致位置发生变化。如果链表的节点全部都超时了，则从优先队列中删除链表对应的节点。重新调整优先队列的节点。  
2 如果当前节点没有超时则说明后面的节点也不会超时了。因为当前节点是优先队列中最快到期（最小的）的节点。接着设置Libuv的定时器时间为当前节点的时间。等待下一次超时处理。
## 10.6 ref和unref
setTimeout返回的是一个Timeout对象，该提供了ref和unref接口，刚才提到了关于定时器影响事件循环退出的内容，我们看一下这个原理。刚才说到Node.js定时器模块在Libuv中只对应一个定时器节点。在Node.js初始化的时候，初始化了该节点。

```cpp
    void Environment::InitializeLibuv(bool start_profiler_idle_notifier) {  
      // 初始化定时器  
      CHECK_EQ(0, uv_timer_init(event_loop(), timer_handle()));  
      // 置unref状态
      uv_unref(reinterpret_cast<uv_handle_t*>(timer_handle()));  
    }  
```

我们看到底层定时器节点默认是unref状态的，所以不会影响事件循环的退出。因为初始化时JS层没有定时节点。可以通过Node.js提供的接口修改该状态。Node.js支持ref状态的Timeout（setTimeout）和unref状态的Timeout（setUnrefTimeout）。

```js
    function Timeout(callback, after, args, isRepeat, isRefed) {  
      if (isRefed)  
        incRefCount();  
      this[kRefed] = isRefed;  
    }  
```

最后一个参数就是控制ref还是unref的。我们继续看一下如果isRefed为true的时候的逻辑

```js
    function incRefCount() {  
      if (refCount++ === 0)  
        toggleTimerRef(true);  
    }  
```

refCount初始化的时候是1，所以在新加第一个Timeout的时候，if成立。我们接着看toggleTimerRef，该函数对应的代码如下

```cpp
    void Environment::ToggleTimerRef(bool ref) {  
      // 打上ref标记，  
      if (ref) {  
        uv_ref(reinterpret_cast<uv_handle_t*>(timer_handle()));  
      } else {  
        uv_unref(reinterpret_cast<uv_handle_t*>(timer_handle()));  
      }  
    }  
```

该函数正是给定时器对应的handle设置状态的。setTimeout的时候，isRefed的值是true的，Node.js还提供了另外一个函数setUnrefTimeout。

```js
    function setUnrefTimeout(callback, after) {  
      const timer = new Timeout(callback, after, undefined, false, false);  
      insert(timer, timer._idleTimeout);  
      return timer;  
    }  
```

该函数和setTimeout最主要的区别是new Timeout的时候，最后一个参数是false（isRefed变量的值），所以setUnrefTimeout设置的定时器是不会影响Libuv事件循环退出的。另外除了Node.js直接提供的api后。我们还可以通过Timeout对象提供的ref和unref手动控制这个状态。
现在通过一个例子具体来看一下。

```js
    const timeout = setTimeout(() => {  
        console.log(1)  
    }, 10000);  
    timeout.unref();  
    // timeout.ref(); 加这一句会输出1  
```

上面的代码中，1是不会输出，除非把注释去掉。Unref和ref是相反的参数，即把定时器模块对应的Libuv handle改成unref状态。
