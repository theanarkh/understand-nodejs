# 第四章 事件循环
事件循环由libuv的uv_run函数实现。在该函数中执行while循环，然后处理各种阶段（phase）的事件回调。事件循环的处理相当于一个消费者，消费由各业务代码生产的任务。下面看一下代码。

```c
1.	int uv_run(uv_loop_t* loop, uv_run_mode mode) {  
2.	  int timeout;  
3.	  int r;  
4.	  int ran_pending;  
5.	  
6.	  r = uv__loop_alive(loop);  
7.	  if (!r)  
8.	    uv__update_time(loop);  
9.	  
10.	  while (r != 0 && loop->stop_flag == 0) {  
11.	    // 更新loop的time字段  
12.	    uv__update_time(loop);  
13.	    // 执行超时回调  
14.	    uv__run_timers(loop);  
15.	    // 执行pending回调，ran_pending代表pending队列是否为空，即没有节点可以执行  
16.	    ran_pending = uv__run_pending(loop);  
17.	    // 继续执行各种队列  
18.	    uv__run_idle(loop);  
19.	    uv__run_prepare(loop);  
20.	  
21.	    timeout = 0;  
22.	    // UV_RUN_ONCE并且有pending节点的时候，会阻塞式poll io，默认模式也是  
23.	    if ((mode == UV_RUN_ONCE && !ran_pending) || mode == UV_RUN_DEFAULT)  
24.	      timeout = uv_backend_timeout(loop);  
25.	    // poll io timeout是epoll_wait的超时时间  
26.	    uv__io_poll(loop, timeout);  
27.	    uv__run_check(loop);  
28.	    uv__run_closing_handles(loop);  
29.	    // 还有一次执行超时回调的机会  
30.	    if (mode == UV_RUN_ONCE) {  
31.	      uv__update_time(loop);  
32.	      uv__run_timers(loop);  
33.	    }  
34.	  
35.	    r = uv__loop_alive(loop);  
36.	    if (mode == UV_RUN_ONCE || mode == UV_RUN_NOWAIT)  
37.	      break;  
38.	  }  
39.	  if (loop->stop_flag != 0)  
40.	    loop->stop_flag = 0;  
41.	  return r;  
42.	}  
```

libuv分为几个阶段，下面分别分析各个阶段的相关代码（timer阶段见定时器章节）。
## 4.1 事件循环之close
close是libuv每轮事件循环中最后的一个阶段。我们看看怎么使用。我们知道对于一个handle，他的使用一般是init，start，stop。但是如果我们在stop一个handle之后，还有些事情需要处理怎么办？这时候就可以使用close阶段。close阶段可以用来关闭一个handle，并且执行一个回调。比如用于释放动态申请的内存。close阶段的任务由uv_close产生。

```c
1.	void uv_close(uv_handle_t* handle, uv_close_cb close_cb) {  
2.	  // 正在关闭，但是还没执行回调等后置操作  
3.	  handle->flags |= UV_HANDLE_CLOSING;  
4.	  handle->close_cb = close_cb;  
5.	  
6.	  switch (handle->type) {  
7.	  
8.	  case UV_PREPARE:  
9.	    uv__prepare_close((uv_prepare_t*)handle);  
10.	    break;  
11.	  
12.	  case UV_CHECK:  
13.	    uv__check_close((uv_check_t*)handle);  
14.	    break;  
15.	    ...  
16.	  default:  
17.	    assert(0);  
18.	  }  
19.	  
20.	  uv__make_close_pending(handle);  
21.	}  
```

uv_close设置回调和状态，然后根据handle类型调对应的close函数，一般就是stop这个handle。比如prepare的close函数。

```c
1.	void uv__prepare_close(uv_prepare_t* handle) {                             
2.	    uv_prepare_stop(handle);                                                   
3.	}  
```

接着执行uv__make_close_pending往close队列追加节点。

```c
1.	// 头插法插入closing队列，在closing阶段被执行  
2.	void uv__make_close_pending(uv_handle_t* handle) {  
3.	  handle->next_closing = handle->loop->closing_handles;  
4.	  handle->loop->closing_handles = handle;  
5.	}  
```

产生的节点在closing_handles队列中保存，然后在close节点逐个处理。

```c
1.	// 执行closing阶段的的回调  
2.	static void uv__run_closing_handles(uv_loop_t* loop) {  
3.	  uv_handle_t* p;  
4.	  uv_handle_t* q;  
5.	  
6.	  p = loop->closing_handles;  
7.	  loop->closing_handles = NULL;  
8.	  
9.	  while (p) {  
10.	    q = p->next_closing;  
11.	    uv__finish_close(p);  
12.	    p = q;  
13.	  }  
14.	}  
15.	  
16.	// 执行closing阶段的回调  
17.	static void uv__finish_close(uv_handle_t* handle) {  
18.	  handle->flags |= UV_HANDLE_CLOSED;  
19.	  ...  
20.	  uv__handle_unref(handle);  
21.	  QUEUE_REMOVE(&handle->handle_queue);  
22.	  if (handle->close_cb) {  
23.	    handle->close_cb(handle);  
24.	  }  
25.	}  
```

逐个执行回调，close和stop有一点不同的是，stop一个handle，他不会从事件循环中被移除，但是close一个handle，他会从事件循环的handle队列中移除。
我们看一个使用了uv_close的例子（省略部分代码）。

```c
1.	int uv_fs_poll_start(uv_fs_poll_t* handle,  
2.	                     uv_fs_poll_cb cb,  
3.	                     const char* path,  
4.	                     unsigned int interval) {  
5.	  struct poll_ctx* ctx;  
6.	  // 分配一块堆内存存上下文结构体和path对应的字符串  
7.	  ctx = uv__calloc(1, sizeof(*ctx) + len);  
8.	  // 挂载上下文到handle  
9.	  handle->poll_ctx = ctx;  
10.	  
11.	}  
```

uv_fs_poll_start是用于监听文件是否有改变的函数。他在handle里挂载了一个基于堆结构体。当结束监听的时候，他需要释放掉这块内存。

```c
1.	// 停止poll  
2.	int uv_fs_poll_stop(uv_fs_poll_t* handle) {  
3.	  struct poll_ctx* ctx;  
4.	  ctx = handle->poll_ctx;  
5.	  handle->poll_ctx = NULL;  
6.	  uv_close((uv_handle_t*)&ctx->timer_handle, timer_close_cb);  
7.	}  
```

uv_fs_poll_stop通过uv_close函数关闭handle，传的回调是timer_close_cb。

```c
1.	// 释放上下文结构体的内存  
2.	static void timer_close_cb(uv_handle_t* handle) {  
3.	  uv__free(container_of(handle, struct poll_ctx, timer_handle));  
4.	}  
```

所以在close阶段就会释放这块内存。
## 4.2 事件循环之poll io
poll io是libuv非常重要的一个阶段，文件io、网络io、信号处理等都在这个阶段处理。这也是最复杂的一个阶段。处理逻辑在uv__io_poll这个函数。这个函数比较复杂，我们分开分析。
开始说poll io之前，先了解一下他相关的一些数据结构。<br/>
1 io观察者uv__io_t。这个结构体是poll io阶段核心结构体。他主要是保存了io相关的文件描述符、回调、感兴趣的事件等信息。<br/>
2 watcher_queue观察者队列。所有需要libuv处理的io观察者都挂载在这个队列里。libuv会逐个处理。<br/>
下面我们开始分析poll io阶段。先看第一段逻辑。

```c
1.	 // 没有io观察者，则直接返回  
2.	 if (loop->nfds == 0) {  
3.	    assert(QUEUE_EMPTY(&loop->watcher_queue));  
4.	    return;  
5.	  }  
6.	  // 遍历io观察者队列  
7.	  while (!QUEUE_EMPTY(&loop->watcher_queue)) {  
8.	      // 取出当前头节点  
9.	    q = QUEUE_HEAD(&loop->watcher_queue);  
10.	    // 脱离队列  
11.	    QUEUE_REMOVE(q);  
12.	    // 初始化（重置）节点的前后指针  
13.	    QUEUE_INIT(q);  
14.	    // 通过结构体成功获取结构体首地址  
15.	    w = QUEUE_DATA(q, uv__io_t, watcher_queue);  
16.	    // 设置当前感兴趣的事件  
17.	    e.events = w->pevents;  
18.	    // 这里使用了fd字段，事件触发后再通过fd从watchs字段里找到对应的io观察者，没有使用ptr指向io观察者的方案  
19.	    e.data.fd = w->fd;  
20.	    // w->events初始化的时候为0，则新增，否则修改  
21.	    if (w->events == 0)  
22.	      op = EPOLL_CTL_ADD;  
23.	    else  
24.	      op = EPOLL_CTL_MOD;  
25.	    // 修改epoll的数据  
26.	    epoll_ctl(loop->backend_fd, op, w->fd, &e)  
27.	    // 记录当前加到epoll时的状态   
28.	    w->events = w->pevents;  
29.	  }  
```

第一步首先遍历io观察者，修改epoll的数据，即感兴趣的事件。然后准备进入等待，如果设置了UV_LOOP_BLOCK_SIGPROF的话。libuv会做一个优化。如果调setitimer(ITIMER_PROF,…)设置了定时触发SIGPROF信号，则到期后，并且每隔一段时间后会触发SIGPROF信号，这里如果设置了UV_LOOP_BLOCK_SIGPROF救护屏蔽这个信号。否则会提前唤醒epoll_wait。

```c
1.	psigset = NULL;  
2.	 if (loop->flags & UV_LOOP_BLOCK_SIGPROF) {  
3.	   sigemptyset(&sigset);  
4.	   sigaddset(&sigset, SIGPROF);  
5.	   psigset = &sigset;  
6.	 }  
7.	   /* 
8.	     http://man7.org/linux/man-pages/man2/epoll_wait.2.html 
9.	     pthread_sigmask(SIG_SETMASK, &sigmask, &origmask); 
10.	     ready = epoll_wait(epfd, &events, maxevents, timeout); 
11.	     pthread_sigmask(SIG_SETMASK, &origmask, NULL); 
12.	     即屏蔽SIGPROF信号，避免SIGPROF信号唤醒epoll_wait，但是却没有就绪的事件 
13.	   */  
14.	   nfds = epoll_pwait(loop->backend_fd,  
15.	                      events,  
16.	                      ARRAY_SIZE(events),  
17.	                      timeout,  
18.	                      psigset);  
19.	   // epoll可能阻塞，这里需要更新事件循环的时间  
20.	   uv__update_time(loop)   
```

  在epoll_wait可能会引起主线程阻塞，具体要根据libuv当前的情况。所以wait返回后需要更新当前的时间，否则在使用的时候时间差会比较大。因为libuv会在每轮时间循环开始的时候缓存当前时间这个值。其他地方直接使用，而不是每次都去获取。下面我们接着看epoll返回后的处理（假设有事件触发）。

```c
1.	// 保存epoll_wait返回的一些数据，maybe_resize申请空间的时候+2了  
2.	   loop->watchers[loop->nwatchers] = (void*) events;  
3.	   loop->watchers[loop->nwatchers + 1] = (void*) (uintptr_t) nfds;  
4.	   for (i = 0; i < nfds; i++) {  
5.	     // 触发的事件和文件描述符  
6.	     pe = events + i;  
7.	     fd = pe->data.fd;  
8.	     // 根据fd获取io观察者，见上面的图  
9.	     w = loop->watchers[fd];  
10.	     // 会其他回调里被删除了，则从epoll中删除  
11.	     if (w == NULL) {  
12.	       epoll_ctl(loop->backend_fd, EPOLL_CTL_DEL, fd, pe);  
13.	       continue;  
14.	     }  
15.	     if (pe->events != 0) {  
16.	       // 用于信号处理的io观察者感兴趣的事件触发了，即有信号发生。  
17.	       if (w == &loop->signal_io_watcher)  
18.	         have_signals = 1;  
19.	       else  
20.	         // 一般的io观察者指向回调  
21.	         w->cb(loop, w, pe->events);  
22.	       nevents++;  
23.	     }  
24.	   }  
25.	   // 有信号发生，触发回调  
26.	   if (have_signals != 0)  
27.	     loop->signal_io_watcher.cb(loop, &loop->signal_io_watcher, POLLIN); 
```

 
这里开始处理io事件，执行io观察者里保存的回调。但是有一个特殊的地方就是信号处理的io观察者需要单独判断。他是一个全局的io观察者，和一般动态申请和销毁的io观察者不一样，他是存在于libuv运行的整个生命周期。async io也是。这就是poll io的整个过程。最后看一下epoll_wait阻塞时间的计算规则。

```c
1.	// 计算epoll使用的timeout  
2.	int uv_backend_timeout(const uv_loop_t* loop) {  
3.	  // 下面几种情况下返回0，即不阻塞在epoll_wait   
4.	  if (loop->stop_flag != 0)  
5.	    return 0;  
6.	  // 没有东西需要处理，则不需要阻塞poll io阶段  
7.	  if (!uv__has_active_handles(loop) && !uv__has_active_reqs(loop))  
8.	    return 0;  
9.	  // idle阶段有任务，不阻塞，尽快返回直接idle任务  
10.	  if (!QUEUE_EMPTY(&loop->idle_handles))  
11.	    return 0;  
12.	  // 同上  
13.	  if (!QUEUE_EMPTY(&loop->pending_queue))  
14.	    return 0;  
15.	  // 同上  
16.	  if (loop->closing_handles)  
17.	    return 0;  
18.	  // 返回下一个最早过期的时间，即最早超时的节点  
19.	  return uv__next_timeout(loop);  
20.	}  
```

## 4.3 事件循环之定时器
libuv中，定时器是以最小堆实现的。即最快过期的节点是根节点。libuv在每次事件循环开始的时候都会缓存当前的时间，在整个一轮的事件循环中，使用的都是这个缓存的时间。缓存了当前最新的时间后，就执行uv__run_timers，该函数就是遍历最小堆，找出当前超时的节点。因为堆的性质是父节点肯定比孩子小。所以如果找到一个节点，他没有超时，则后面的节点也不会超时。对于超时的节点就执行他的回调。执行完回调后，还有两个关键的操作。第一就是stop，第二就是again。

```c
1.	// 停止一个计时器  
2.	int uv_timer_stop(uv_timer_t* handle) {  
3.	  if (!uv__is_active(handle))  
4.	    return 0;  
5.	  // 从最小堆中移除该计时器节点  
6.	  heap_remove(timer_heap(handle->loop),  
7.	              (struct heap_node*) &handle->heap_node,  
8.	              timer_less_than);  
9.	  // 清除激活状态和handle的active数减一  
10.	  uv__handle_stop(handle);  
11.	  return 0;  
12.	}  
```

stop的逻辑很简单，其实就是把handle从二叉堆中删除。并且取消激活状态。那么again又是什么呢？again是为了支持setInterval这种场景。

```c
1.	// 重新启动一个计时器，需要设置repeat标记   
2.	int uv_timer_again(uv_timer_t* handle) {  
3.	  // 如果设置了repeat标记说明计时器是需要重复触发的  
4.	  if (handle->repeat) {  
5.	    // 先把旧的计时器节点从最小堆中移除，然后再重新开启一个计时器  
6.	    uv_timer_stop(handle);  
7.	    uv_timer_start(handle, handle->timer_cb, handle->repeat, handle->repeat);  
8.	  }  
9.	  
10.	  return 0;  
11.	}  
```

如果handle设置了repeat标记，则该handle在超时后，每repeat的时间后，就会继续执行超时回调。对于setInterval，就是超时时间是x，每x的时间后，执行回调。这就是nodejs里定时器的底层原理。但nodejs不是每次调setTimeout的时候都往最小堆插入一个节点。nodejs里，只有一个关于uv_timer_s的handle。他在js层维护了一个数据结构，每次计算出最早到期的节点，然后修改handle的超时时间。
 	timer阶段和poll io阶段也有一些联系，因为poll io可能会导致主线程阻塞，为了保证主线程可以尽快执行定时器的回调，poll io不能一直阻塞，所以这时候，阻塞的时长就是最快到期的定时器节点的时长。定时器的实现在后面的章节再详细分析。
## 4.4 事件循环之prepare,check,idle
prepare是libuv事件循环中属于比较简单的一个阶段。我们知道libuv中分为handle和request。而prepare阶段的任务是属于handle。下面我们看看怎么使用它

```c
1.	void prep_cb(uv_prepare_t *handle) {  
2.	    printf("Prep callback\n");  
3.	}  
4.	  
5.	int main() {  
6.	    uv_prepare_t prep;  
7.	    // uv_default_loop是libuv事件循环的核心结构体  
8.	    uv_prepare_init(uv_default_loop(), &prep);  
9.	    uv_prepare_start(&prep, prep_cb);  
10.	    uv_run(uv_default_loop(), UV_RUN_DEFAULT);  
11.	    return 0;  
12.	}  
```

执行main函数，libuv就会在prepare阶段执行回调prep_cb。我们分析一下这个过程。

```c
1.	int uv_prepare_init(uv_loop_t* loop, uv_prepare_t* handle) {                
2.	    uv__handle_init(loop, (uv_handle_t*)handle, UV_PREPARE);                     
3.	    handle->prepare_cb = NULL;                                                   
4.	    return 0;                                                                   
5.	  }   
```
init函数主要是做一些初始化操作。我们继续要看start函数。

```c
1.	int uv_prepare_start(uv_prepare_t* handle, uv_prepare_cb cb) {             
2.	      // 如果已经执行过start函数则直接返回  
3.	   if (uv__is_active(handle)) return 0;                                        
4.	   if (cb == NULL) return UV_EINVAL;                                           
5.	   QUEUE_INSERT_HEAD(&handle->loop->prepare_handles, &handle->queue);           
6.	   handle->prepare_cb = cb;                                                     
7.	   uv__handle_start(handle);                                                   
8.	   return 0;                                                                   
9.	 }   
```
1 设置回调，把handle插入loop中的prepare_handles队列，prepare_handles保存prepare阶段的任务。在事件循环的prepare阶段会逐个执行里面的节点的回调。
2 设置UV_HANDLE_ACTIVE标记位，如果这handle还打了UV_HANDLE_REF标记（在init阶段设置的），则事件循环中的活handle数加一。UV_HANDLE_ACTIVE标记这个handle是活的，影响事件循环的退出和poll io阶段超时时间的计算。有活的handle的话，libuv如果运行在默认模式下，则不会退出，如果是其他模式，会退出。执行完start函数，我们看看libuv在事件循环的prepare阶段是如何处理的。

```c
1.	void uv__run_prepare(uv_loop_t* loop) {                                        
2.	    uv_prepare_t* h;                                                           
3.	    QUEUE queue;                                                                
4.	    QUEUE* q;                                                                   
5.	  
6.	    /* 
7.	        把该类型对应的队列中所有节点摘下来挂载到queue变量， 
8.	        相当于清空prepare_handles队列，因为如果直接遍历 
9.	    prepare_handles队列，在执行回调的时候一直往prepare_handles 
10.	    队列加节点，会导致下面的while循环无法退出。 
11.	        先移除的话，新插入的节点在下一轮事件循环才会被处理。 
12.	    */                              
13.	     QUEUE_MOVE(&loop->prepare_handles, &queue);      
14.	    // 遍历队列，执行每个节点里面的函数  
15.	    while (!QUEUE_EMPTY(&queue)) {                                              
16.	      // 取下当前待处理的节点，即队列的头  
17.	      q = QUEUE_HEAD(&queue);                                                   
18.	      /* 
19.	取得该节点对应的整个结构体的基地址， 
20.	即通过结构体成员取得结构体首地址 
21.	*/  
22.	      h = QUEUE_DATA(q, uv_prepare_t, queue);                                  
23.	      // 把该节点移出当前队列  
24.	      QUEUE_REMOVE(q);                                                          
25.	     // 重新插入原来的队列  
26.	      QUEUE_INSERT_TAIL(&loop->prepare_handles, q);                              
27.	     // 执行回调函数  
28.	      h->prepare_cb(h);                                                          
29.	    }                                                                           
30.	  }  
```

节点。我们回顾一开始的测试代码。因为他设置了libuv的运行模式是默认模式。又因为有或者的handle（prepare节点），所以他是不会退出的。他会一直执行回调。那如果我们要退出怎么办呢？或者说不要执行prepare队列的某个节点了。我们只需要stop一下就可以了。

```c
1.	int uv_prepare_stop(uv_prepare_t* handle) {                                 
2.	    if (!uv__is_active(handle)) return 0;                                       
3.	    // 把handle从prepare队列中移除，但是还挂载到handle_queue中  
4.	    QUEUE_REMOVE(&handle->queue);                                               
5.	   // 清除active标记位并且减去loop中handle的active数  
6.	    uv__handle_stop(handle);                                                    
7.	    return 0;                                                                   
8.	  }   
```

stop函数和start函数是相反的作用，就不分析了。这就是nodejs中prepare阶段的过程。

## 4.5 pending阶段
官网解释是在上一轮的poll io阶段没有执行的io回调，会在下一轮循环的pending阶段被执行。我们先看pending阶段的处理。

```c
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
    // 重置一下prev和next指针，因为这时候这两个指针是指向队列中的两个节点
    QUEUE_INIT(q);
    w = QUEUE_DATA(q, uv__io_t, pending_queue);
    w->cb(loop, w, POLLOUT);
  }

  return 1;
}
```
就是把pending队列了的节点逐个执行。然后我们看一下pending队列的节点是如何生产出来的。

```c
void uv__io_feed(uv_loop_t* loop, uv__io_t* w) {
  if (QUEUE_EMPTY(&w->pending_queue))
    QUEUE_INSERT_TAIL(&loop->pending_queue, &w->pending_queue);
}
```
libuv通过uv__io_feed函数生产pending任务，从libuv的代码中我们看到io错误的时候会调这个函数（还有其他情况）。

```c
if (handle->delayed_error)
    uv__io_feed(handle->loop, &handle->io_watcher);
```
最后io关闭的时候会从pending队列移除对应的节点。

```c
void uv__io_close(uv_loop_t* loop, uv__io_t* w) {
  uv__io_stop(loop, w, POLLIN | POLLOUT | UV__POLLRDHUP | UV__POLLPRI);
  QUEUE_REMOVE(&w->pending_queue);
  uv__platform_invalidate_fd(loop, w->fd);
}
```
