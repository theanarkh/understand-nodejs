# 第三章 事件循环
Node.js属于单线程事件循环架构，该事件循环由Libuv的uv_run函数实现，在该函数中执行while循环，然后不断地处理各个阶段（phase）的事件回调。事件循环的处理相当于一个消费者，消费由各种代码产生的任务。Node.js初始化完成后就开始陷入该事件循环中，事件循环的结束也就意味着Node.js的结束。下面看一下事件循环的核心代码。

```cpp
    int uv_run(uv_loop_t* loop, uv_run_mode mode) {  
      int timeout;  
      int r;  
      int ran_pending;  
      // 在uv_run之前要先提交任务到loop  
      r = uv__loop_alive(loop);  
      // 事件循环没有任务执行，即将退出，设置一下当前循环的时间  
      if (!r)  
        uv__update_time(loop);  
      // 没有任务需要处理或者调用了uv_stop则退出事件循环   
      while (r != 0 && loop->stop_flag == 0) {  
        // 更新loop的time字段  
        uv__update_time(loop);  
        // 执行超时回调  
        uv__run_timers(loop);  
        /*
          执行pending回调，ran_pending代表pending队列是否为空，
           即没有节点可以执行  
         */
        ran_pending = uv__run_pending(loop);  
        // 继续执行各种队列  
        uv__run_idle(loop);  
        uv__run_prepare(loop);  
      
        timeout = 0;  
        /*
          执行模式是UV_RUN_ONCE时，如果没有pending节点，
          才会阻塞式Poll IO，默认模式也是  
        */
        if ((mode == UV_RUN_ONCE && !ran_pending) || 
              mode == UV_RUN_DEFAULT)  
          timeout = uv_backend_timeout(loop);  
        // Poll IO timeout是epoll_wait的超时时间  
        uv__io_poll(loop, timeout);  
         // 处理check阶段
        uv__run_check(loop);  
         // 处理close阶段
        uv__run_closing_handles(loop);  
        /*
          还有一次执行超时回调的机会，因为uv__io_poll可能是因为
          定时器超时返回的。  
        */
        if (mode == UV_RUN_ONCE) {  
          uv__update_time(loop);  
          uv__run_timers(loop);  
        }  
      
        r = uv__loop_alive(loop);  
        /*
          只执行一次，退出循环,UV_RUN_NOWAIT表示在Poll IO阶段
           不会阻塞并且循环只执行一次  
         */
        if (mode == UV_RUN_ONCE || mode == UV_RUN_NOWAIT)  
          break;  
      }  
      // 是因为调用了uv_stop退出的，重置flag  
      if (loop->stop_flag != 0)  
        loop->stop_flag = 0;  
      /*
        返回是否还有活跃的任务（handle或request），
        业务代表可以再次执行uv_run  
      */
      return r;  
    }  
```

Libuv分为几个阶段，下面从先到后，分别分析各个阶段的相关代码。
## 3.1 事件循环之定时器
Libuv中，定时器阶段是第一个被处理的阶段。定时器是以最小堆实现的，最快过期的节点是根节点。Libuv在每次事件循环开始的时候都会缓存当前的时间，在每一轮的事件循环中，使用的都是这个缓存的时间，必要的时候Libuv会显式更新这个时间，因为获取时间需要调用操作系统提供的接口，而频繁调用系统调用会带来一定的耗时，缓存时间可以减少操作系统的调用，提高性能。Libuv缓存了当前最新的时间后，就执行uv__run_timers，该函数就是遍历最小堆，找出当前超时的节点。因为堆的性质是父节点肯定比孩子小。并且根节点是最小的，所以如果一个根节点，它没有超时，则后面的节点也不会超时。对于超时的节点就执行它的回调。我们看一下具体的逻辑。

```cpp
    void uv__run_timers(uv_loop_t* loop) {  
      struct heap_node* heap_node;  
      uv_timer_t* handle;  
      // 遍历二叉堆  
      for (;;) {  
        // 找出最小的节点  
        heap_node = heap_min(timer_heap(loop));  
        // 没有则退出  
        if (heap_node == NULL)  
          break;  
        // 通过结构体字段找到结构体首地址  
        handle = container_of(heap_node, uv_timer_t, heap_node);  
        // 最小的节点都没有超市，则后面的节点也不会超时  
        if (handle->timeout > loop->time)  
          break;  
        // 删除该节点  
        uv_timer_stop(handle);  
        /*
          重试插入二叉堆，如果需要的话（设置了repeat，比如
          setInterval） 
        */ 
        uv_timer_again(handle);  
        // 执行回调  
        handle->timer_cb(handle);  
      }  
    }  
```

执行完回调后，还有两个关键的操作，第一就是stop，第二就是again。stop的逻辑很简单，就是把handle从二叉堆中删除，并且修改handle的状态。那么again又是什么呢？again是为了支持setInterval这种场景，如果handle设置了repeat标记，则该handle在超时后，每repeat的时间后，就会继续执行超时回调。对于setInterval，就是超时时间是x，每x的时间后，执行回调。这就是Node.js里定时器的底层原理。但Node.js不是每次调setTimeout/setInterval的时候都往最小堆插入一个节点，Node.js里，只有一个关于uv_timer_s的handle，它在JS层维护了一个数据结构，每次计算出最早到期的节点，然后修改handle的超时时间，具体在定时器章节讲解。
&nbsp;&nbsp;&nbsp;&nbsp;另外timer阶段和Poll IO阶段也有一些联系，因为Poll IO可能会导致主线程阻塞，为了保证主线程可以尽快执行定时器的回调，Poll IO不能一直阻塞，所以这时候，阻塞的时长就是最快到期的定时器节点的时长（具体可参考libuv core.c中的uv_backend_timeout函数）。
## 3.2 pending阶段
官网对pending阶段的解释是在上一轮的Poll IO阶段没有执行的IO回调，会在下一轮循环的pending阶段被执行。从源码来看，Poll IO阶段处理任务时，在某些情况下，如果当前执行的操作失败需要执行回调通知调用方一些信息，该回调函数不会立刻执行，而是在下一轮事件循环的pending阶段执行（比如写入数据成功，或者TCP连接失败时回调C++层），我们先看pending阶段的处理。

```cpp
    static int uv__run_pending(uv_loop_t* loop) {  
      QUEUE* q;  
      QUEUE pq;  
      uv__io_t* w;  
      
      if (QUEUE_EMPTY(&loop->pending_queue))  
        return 0;  
      // 把pending_queue队列的节点移到pq，即清空了pending_queue  
      QUEUE_MOVE(&loop->pending_queue, &pq);  
      
      // 遍历pq队列  
      while (!QUEUE_EMPTY(&pq)) {  
        // 取出当前第一个需要处理的节点，即pq.next  
        q = QUEUE_HEAD(&pq);  
        // 把当前需要处理的节点移出队列  
        QUEUE_REMOVE(q);  
        /*
          重置一下prev和next指针，因为这时候这两个指针是
          指向队列中的两个节点  
         */
        QUEUE_INIT(q);  
        w = QUEUE_DATA(q, uv__io_t, pending_queue);  
        w->cb(loop, w, POLLOUT);  
      }  
      
      return 1;  
    }  
```

pending阶段的处理逻辑就是把pending队列里的节点逐个执行。我们看一下pending队列的节点是如何生产出来的。

```cpp
    void uv__io_feed(uv_loop_t* loop, uv__io_t* w) {  
      if (QUEUE_EMPTY(&w->pending_queue))  
        QUEUE_INSERT_TAIL(&loop->pending_queue, &w->pending_queue);  
    }  
```

Libuv通过uv__io_feed函数生产pending任务，从Libuv的代码中我们看到IO错误的时候会调这个函数（如tcp.c的uv__tcp_connect函数）。

```cpp
    if (handle->delayed_error)  
        uv__io_feed(handle->loop, &handle->io_watcher);  
```

在写入数据成功后（比如TCP、UDP），也会往pending队列插入一个节点，等待回调。比如发送数据成功后执行的代码（udp.c的uv__udp_sendmsg函数）

```cpp
    // 发送完移出写队列  
    QUEUE_REMOVE(&req->queue);  
    // 加入写完成队列  
    QUEUE_INSERT_TAIL(&handle->write_completed_queue, &req->queue);  
    /*
      有节点数据写完了，把IO观察者插入pending队列，
      pending阶段执行回调
    */  
    uv__io_feed(handle->loop, &handle->io_watcher);  
```

最后关闭IO的时候（如关闭一个TCP连接）会从pending队列移除对应的节点，因为已经关闭了，自然就不需要执行回调。

```cpp
    void uv__io_close(uv_loop_t* loop, uv__io_t* w) {  
      uv__io_stop(loop, 
                    w, 
                    POLLIN | POLLOUT | UV__POLLRDHUP | UV__POLLPRI);  
      QUEUE_REMOVE(&w->pending_queue);   
    }  
```

## 3.3 事件循环之prepare,check,idle
prepare,check,idle是Libuv事件循环中属于比较简单的一个阶段，它们的实现是一样的（见loop-watcher.c）。本节只讲解prepare阶段，我们知道Libuv中分为handle和request，而prepare阶段的任务是属于handle类型。这意味着除非我们显式移除，否则prepare阶段的节点在每次事件循环中都会被执行。下面我们先看看怎么使用它。

```cpp
    void prep_cb(uv_prepare_t *handle) {  
        printf("Prep callback\n");  
    }  
      
    int main() {  
        uv_prepare_t prep;  
        // 初始化一个handle，uv_default_loop是事件循环的核心结构体  
        uv_prepare_init(uv_default_loop(), &prep); 
            // 注册handle的回调 
        uv_prepare_start(&prep, prep_cb);
            // 开始事件循环  
        uv_run(uv_default_loop(), UV_RUN_DEFAULT);  
        return 0;  
    }  
```

执行main函数，Libuv就会在prepare阶段执行回调prep_cb。我们分析一下这个过程。

```cpp
    int uv_prepare_init(uv_loop_t* loop, uv_prepare_t* handle) {
        uv__handle_init(loop, (uv_handle_t*)handle, UV_PREPARE);  
        handle->prepare_cb = NULL;    
        return 0;                   
    }   
```

init函数主要是做一些初始化操作。我们继续要看start函数。

```cpp
    int uv_prepare_start(uv_prepare_t* handle, uv_prepare_cb cb) { 
       // 如果已经执行过start函数则直接返回  
       if (uv__is_active(handle)) return 0;  
       if (cb == NULL) return UV_EINVAL;
       QUEUE_INSERT_HEAD(&handle->loop->prepare_handles, 
                            &handle->queue);           
       handle->prepare_cb = cb;     
       uv__handle_start(handle);    
       return 0;    
     }   
```

uv_prepare_start函数主要的逻辑主要是设置回调，把handle插入loop的prepare_handles队列，prepare_handles队列保存了prepare阶段的任务。在事件循环的prepare阶段会逐个执行里面的节点的回调。然后我们看看Libuv在事件循环的prepare阶段是如何处理的。

```cpp
    void uv__run_prepare(uv_loop_t* loop) {           
        uv_prepare_t* h;               
        QUEUE queue;               
        QUEUE* q;  
        /* 
          把该类型对应的队列中所有节点摘下来挂载到queue变量， 
          相当于清空prepare_handles队列，因为如果直接遍历 
          prepare_handles队列，在执行回调的时候一直往prepare_handles 
          队列加节点，会导致下面的while循环无法退出。 
          先移除的话，新插入的节点在下一轮事件循环才会被处理。 
        */                              
         QUEUE_MOVE(&loop->prepare_handles, &queue);      
        // 遍历队列，执行每个节点里面的函数  
        while (!QUEUE_EMPTY(&queue)) {             
          // 取下当前待处理的节点，即队列的头  
          q = QUEUE_HEAD(&queue);        
          /* 
                  取得该节点对应的整个结构体的基地址， 
                  即通过结构体成员取得结构体首地址 
                */  
          h = QUEUE_DATA(q, uv_prepare_t, queue); 
          // 把该节点移出当前队列  
          QUEUE_REMOVE(q);          
           // 重新插入原来的队列  
          QUEUE_INSERT_TAIL(&loop->prepare_handles, q);
           // 执行回调函数  
          h->prepare_cb(h);           
        }                           
      }   
```

uv__run_prepare函数的逻辑很简单，但是有一个重点的地方就是执行完每一个节点，Libuv会把该节点重新插入队列中，所以prepare（包括idle、check）阶段的节点在每一轮事件循环中都会被执行。而像定时器、pending、closing阶段的节点是一次性的，被执行后就会从队列里删除。
&nbsp;&nbsp;&nbsp;&nbsp;我们回顾一开始的测试代码。因为它设置了Libuv的运行模式是默认模式。而prepare队列又一直有一个handle节点，所以它是不会退出的。它会一直执行回调。那如果我们要退出怎么办呢？或者说不要执行prepare队列的某个节点了。我们只需要stop一下就可以了。

```cpp
       int uv_prepare_stop(uv_prepare_t* handle) {
        if (!uv__is_active(handle)) return 0;
        // 把handle从prepare队列中移除，但还挂载到handle_queue中  
        QUEUE_REMOVE(&handle->queue);  
         // 清除active标记位并且减去loop中handle的active数  
        uv__handle_stop(handle);     
        return 0;                    
      }   
```

stop函数和start函数是相反的作用，这就是Node.js中prepare、check、idle阶段的原理。
## 3.4 事件循环之Poll IO
Poll IO是Libuv非常重要的一个阶段，文件IO、网络IO、信号处理等都在这个阶段处理，这也是最复杂的一个阶段。处理逻辑在core.c的uv__io_poll这个函数，这个函数比较复杂，我们分开分析。在开始分析Poll IO之前，先了解一下它相关的一些数据结构。</br>
1 IO观察者uv__io_t。这个结构体是Poll IO阶段核心结构体。它主要是保存了IO相关的文件描述符、回   调、感兴趣的事件等信息。</br>
2 watcher_queue观察者队列。所有需要Libuv处理的IO观察者都挂载在这个队列里，Libuv在Poll IO阶段会逐个处理。

下面我们开始分析Poll IO阶段。先看第一段逻辑。

```cpp
     // 没有IO观察者，则直接返回  
     if (loop->nfds == 0) {  
        assert(QUEUE_EMPTY(&loop->watcher_queue));  
        return;  
      }  
      // 遍历IO观察者队列  
      while (!QUEUE_EMPTY(&loop->watcher_queue)) {  
          // 取出当前头节点  
        q = QUEUE_HEAD(&loop->watcher_queue);  
        // 脱离队列  
        QUEUE_REMOVE(q);  
        // 初始化（重置）节点的前后指针  
        QUEUE_INIT(q);  
        // 通过结构体成功获取结构体首地址  
        w = QUEUE_DATA(q, uv__io_t, watcher_queue);  
        // 设置当前感兴趣的事件  
        e.events = w->pevents;  
        /* 
              这里使用了fd字段，事件触发后再通过fd从watchs
              字段里找到对应的IO观察者，没有使用ptr指向IO观察者的方案  
            */
        e.data.fd = w->fd;  
        // 如果w->events初始化的时候为0，则新增，否则修改  
        if (w->events == 0)  
          op = EPOLL_CTL_ADD;  
        else  
          op = EPOLL_CTL_MOD;  
        // 修改epoll的数据  
        epoll_ctl(loop->backend_fd, op, w->fd, &e)  
        // 记录当前加到epoll时的状态   
        w->events = w->pevents;  
      }  
```

第一步首先遍历IO观察者，修改epoll的数据。然后准备进入等待。

```cpp
      psigset = NULL;  
     if (loop->flags & UV_LOOP_BLOCK_SIGPROF) {  
       sigemptyset(&sigset);  
       sigaddset(&sigset, SIGPROF);  
       psigset = &sigset;  
     }  
       /* 
        http://man7.org/Linux/man-pages/man2/epoll_wait.2.html 
        pthread_sigmask(SIG_SETMASK, &sigmask, &origmask); 
        ready = epoll_wait(epfd, &events, maxevents, timeout); 
        pthread_sigmask(SIG_SETMASK, &origmask, NULL); 
        即屏蔽SIGPROF信号，避免SIGPROF信号唤醒epoll_wait，但是却没
            有就绪的事件 
       */  
       nfds = epoll_pwait(loop->backend_fd,  
                          events,  
                          ARRAY_SIZE(events),  
                          timeout,  
                          psigset);  
       // epoll可能阻塞，这里需要更新事件循环的时间  
       uv__update_time(loop)   ```
```
epoll_wait可能会引起主线程阻塞，所以wait返回后需要更新当前的时间，否则在使用的时候时间差会比较大，因为Libuv会在每轮时间循环开始的时候缓存当前时间这个值。其它地方直接使用，而不是每次都去获取。下面我们接着看epoll返回后的处理（假设有事件触发）。

```cpp
       // 保存epoll_wait返回的一些数据，maybe_resize申请空间的时候+2了
       loop->watchers[loop->nwatchers] = (void*) events;  
       loop->watchers[loop->nwatchers + 1] = (void*) (uintptr_t) nfds;  
       for (i = 0; i < nfds; i++) {  
         // 触发的事件和文件描述符  
         pe = events + i;  
         fd = pe->data.fd;  
         // 根据fd获取IO观察者，见上面的图  
         w = loop->watchers[fd];  
         // 会其它回调里被删除了，则从epoll中删除  
         if (w == NULL) {  
           epoll_ctl(loop->backend_fd, EPOLL_CTL_DEL, fd, pe);  
           continue;  
         }  
         if (pe->events != 0) {  
            /*
                用于信号处理的IO观察者感兴趣的事件触发了，
                即有信号发生。  
            */
           if (w == &loop->signal_io_watcher)  
             have_signals = 1;  
           else  
             // 一般的IO观察者则执行回调  
             w->cb(loop, w, pe->events);  
           nevents++;  
         }  
       }  
       // 有信号发生，触发回调  
       if (have_signals != 0)  
         loop->signal_io_watcher.cb(loop, 
                                    &loop->signal_io_watcher, 
                                    POLLIN);  
```

上面的代码处理IO事件并执行IO观察者里的回调，但是有一个特殊的地方就是信号处理的IO观察者需要单独判断，它是一个全局的IO观察者，和一般动态申请和销毁的IO观察者不一样，它是存在于Libuv运行的整个生命周期。这就是Poll IO的整个过程。
## 3.5 事件循环之close
close是Libuv每轮事件循环中最后的一个阶段。uv_close用于关闭一个handle，并且执行一个回调。uv_close产生的任务会插入到close阶段的队列，然后在close阶段被处理。我们看一下uv_close函数的实现。

```cpp
    void uv_close(uv_handle_t* handle, uv_close_cb close_cb) {  
      // 正在关闭，但是还没执行回调等后置操作  
      handle->flags |= UV_HANDLE_CLOSING;  
      handle->close_cb = close_cb;  
      
      switch (handle->type) { 
      case UV_PREPARE:  
        uv__prepare_close((uv_prepare_t*)handle);  
        break;  
      case UV_CHECK:  
        uv__check_close((uv_check_t*)handle);  
        break;  
        ...  
      default:  
        assert(0);  
      }  
      uv__make_close_pending(handle);  
    }  
```

uv_close设置回调和状态，然后根据handle类型调对应的close函数，一般就是stop这个handle，解除IO观察者注册的事件，从事件循环的handle队列移除该handle等等，比如prepare的close函数只是把handle从队列中移除。

```cpp
    void uv__prepare_close(uv_prepare_t* handle) {   
        uv_prepare_stop(handle);       
    }
    int uv_prepare_stop(uv_prepare__t* handle) {                                  
       QUEUE_REMOVE(&handle->queue);                                             
       uv__handle_stop(handle);                                                  
       return 0;                                                                 
    }      
```

     
根据不同的handle做不同的处理后，接着执行uv__make_close_pending往close队列追加节点。

```cpp
    // 头插法插入closing队列，在closing阶段被执行  
    void uv__make_close_pending(uv_handle_t* handle) {  
      handle->next_closing = handle->loop->closing_handles;  
      handle->loop->closing_handles = handle;  
    }  
```

然后在close阶段逐个处理。我们看一下close阶段的处理逻辑

```cpp
    // 执行closing阶段的的回调  
    static void uv__run_closing_handles(uv_loop_t* loop) {  
      uv_handle_t* p;  
      uv_handle_t* q;  
      
      p = loop->closing_handles;  
      loop->closing_handles = NULL;  
      
      while (p) {  
        q = p->next_closing;  
        uv__finish_close(p);  
        p = q;  
      }  
    }  
      
    // 执行closing阶段的回调  
    static void uv__finish_close(uv_handle_t* handle) {  
      handle->flags |= UV_HANDLE_CLOSED;  
      ...  
      uv__handle_unref(handle); 
        // 从handle队列里移除 
      QUEUE_REMOVE(&handle->handle_queue);  
      if (handle->close_cb) {  
        handle->close_cb(handle);  
      }  
    }  
```

uv__run_closing_handles会逐个执行每个任务节点的回调。
## 3.6 控制事件循环
Libuv通过uv__loop_alive函数判断事件循环是否还需要继续执行。我们看看这个函数的定义。

```cpp
    static int uv__loop_alive(const uv_loop_t* loop) {  
      return uv__has_active_handles(loop) ||  
             uv__has_active_reqs(loop) ||  
             loop->closing_handles != NULL;  
    }  
```

为什么会有一个closing_handle的判断呢？从uv_run的代码来看，执行完close阶段后，会立刻执行uv__loop_alive，正常来说，close阶段的队列是空的，但是如果我们在close回调里又往close队列新增了一个节点，而该节点不会在本轮的close阶段被执行，这样会导致执行完close阶段，但是close队列依然有节点，如果直接退出，则无法执行对应的回调。
我们看到有三种情况，Libuv认为事件循环是存活的。如果我们控制这三种条件就可以控制事件循环的的退出。我们通过一个例子理解一下这个过程。

```cpp
    const timeout = setTimeout(() => {  
      console.log('never console')  
    }, 5000);  
    timeout.unref();  
```

上面的代码中，setTimeout的回调是不会执行的。除非超时时间非常短，短到第一轮事件循环的时候就到期了，否则在第一轮事件循环之后，由于unref的影响，事件循环直接退出了。unref影响的就是handle这个条件。这时候事件循环代码如下。

```cpp
    while (r != 0 && loop->stop_flag == 0) {  
        uv__update_time(loop);  
        uv__run_timers(loop);  
        // ...  
        // uv__loop_alive返回false，直接跳出while，从而退出事件循环  
        r = uv__loop_alive(loop);  
    }  
```
