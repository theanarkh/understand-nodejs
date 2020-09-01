
# 第九章 信号处理
信号是进程间通信的一种简单的方式，在操作系统内核的实现中，每个进程对应一个数据结构（pcb），pcb中有一个字段记录了进程收到的信号（32比特），和信号对应的处理函数。我们看一下libuv中关于信号的使用。
## 9.1 信号处理的初始化
libuv初始化的时候会初始化信号处理相关的逻辑。uv_default_loop-> uv_loop_init-> uv__signal_global_once_init

```c
1.	// 保证只执行uv__signal_global_init一次  
2.	void uv__signal_global_once_init(void) {  
3.	  uv_once(&uv__signal_global_init_guard, uv__signal_global_init);  
4.	}  
5.	  
6.	static void uv__signal_global_init(void) {  
7.	  if (uv__signal_lock_pipefd[0] == -1)  
8.	  // 注册fork之后，在子进程执行的函数  
9.	  if (pthread_atfork(NULL, NULL, &uv__signal_global_reinit))  
10.	      abort();  
11.	  uv__signal_global_reinit();  
12.	}   
```

初始化的时候，libuv调用pthread_atfork函数。
int pthread_atfork(void (*prepare)(void), void (*parent)(void), void (*child)(void));  
该函数的三个参数分别是在调用fork函数前执行的函数，声明如下在fork后，父进程里执行的函数，在fork后，子进程里执行的函数。我们看一下fork的一般用法。

```c
1.	pid_t pid=fork();  
2.	if ( pid < 0 ) {  
3.	    // fork出错;  
4.	} else if( pid == 0 ) {  
5.	    // 子进程  
6.	    exit(0);  
7.	} else {  
8.	   // 父进程  
9.	}  
```

我们再看一下调用pthread_atfork后的逻辑。

```c
1.	prepare();  
2.	pid_t pid=fork();  
3.	if ( pid < 0 ) {  
4.	    // fork出错;  
5.	} else if( pid == 0 ) {  
6.	    child();  
7.	    // 子进程  
8.	    exit(0);  
9.	} else {  
10.	   parent();  
11.	   // 父进程  
12.	}  
```

这里调用的fork不再是操作系统提供的系统调用，而是pthread库自己实现的fork。该fork类似劫持了操作系统的fork。使得用户调用fork的时候，可以先执行一些钩子函数，然后再执行操作系统的fork。分析完钩子函数后，我们继续看一下uv__signal_global_reinit

```c
1.	static void uv__signal_global_reinit(void) {  
2.	  // 清除原来的（如果有的话）  
3.	  uv__signal_global_fini();  
4.	  // 新建一个管道用于互斥控制  
5.	  if (uv__make_pipe(uv__signal_lock_pipefd, 0))  
6.	    abort();  
7.	  // 先往管道写入数据，即解锁。后续才能顺利lock，unlock配对使用  
8.	  if (uv__signal_unlock())  
9.	    abort();  
10.	}  
```

Libuv中定义了int uv__signal_lock_pipefd[2]。用于保存管道的读端和写端。首先关闭旧的文件描述符 

```c
1.	UV_DESTRUCTOR(static void uv__signal_global_fini(void)) {  
2.	  if (uv__signal_lock_pipefd[0] != -1) {  
3.	    uv__close(uv__signal_lock_pipefd[0]);  
4.	    uv__signal_lock_pipefd[0] = -1;  
5.	  }  
6.	  
7.	  if (uv__signal_lock_pipefd[1] != -1) {  
8.	    uv__close(uv__signal_lock_pipefd[1]);  
9.	    uv__signal_lock_pipefd[1] = -1;  
10.	  }  
11.	}
```

然后申请一个管道，对应两个新的文件描述符，表示读端和写端。最后往写端写入一个数据。
## 9.2 信号结构体的初始化
Libuv中信号使用uv_signal_t表示。在注册第一个信号的时候，libuv还会做一些初始化的工作。

```c
1.	int uv_signal_init(uv_loop_t* loop, uv_signal_t* handle) {  
2.	  int err;  
3.	  // 申请和libuv的通信管道并且注册io观察者  
4.	  err = uv__signal_loop_once_init(loop);  
5.	  if (err)  
6.	    return err;  
7.	  
8.	  uv__handle_init(loop, (uv_handle_t*) handle, UV_SIGNAL);  
9.	  handle->signum = 0;  
10.	  handle->caught_signals = 0;  
11.	  handle->dispatched_signals = 0;  
12.	  
13.	  return 0;  
14.	}   
```

上面的代码主要的工作有两个
1 初始化uv_signal_t结构体的一些字段。
2 执行uv__signal_loop_once_init
我们看一下uv__signal_loop_once_init

```c
1.	static int uv__signal_loop_once_init(uv_loop_t* loop) {  
2.	  int err;  
3.	  // 初始化过了  
4.	  if (loop->signal_pipefd[0] != -1)  
5.	    return 0;  
6.	  // 申请一个管道，用于其他进程和libuv主进程通信，并设置非阻塞标记  
7.	  err = uv__make_pipe(loop->signal_pipefd, UV__F_NONBLOCK);  
8.	  if (err)  
9.	    return err;  
10.	  /* 
11.	      设置信号io观察者的处理函数和文件描述符， 
12.	      libuv在poll io时，发现管道读端loop->signal_pipefd[0]可读， 
13.	      则执行uv__signal_event 
14.	  */  
15.	  uv__io_init(&loop->signal_io_watcher,  
16.	              uv__signal_event,  
17.	              loop->signal_pipefd[0]);  
18.	  /* 
19.	      插入libuv的io观察者队列，并注册感兴趣的事件，即可读的时候， 
20.	      执行uv__signal_event 
21.	  */  
22.	  uv__io_start(loop, &loop->signal_io_watcher, POLLIN);  
23.	  
24.	  return 0;  
} 
```

申请一个管道，用于其他进程（libuv进程或fork出来的进程）和libuv进程通信。然后往libuv的io观察者队列注册一个观察者，libuv在poll io阶段会把观察者加到epoll中。io观察者里保存了管道读端的文件描述符loop->signal_pipefd[0]和回调函数uv__signal_event。uv__signal_event是任意信号触发时的回调，他会继续根据触发的信号进行逻辑分发。
执行完的内容架构为
 ![](https://img-blog.csdnimg.cn/20200901135343558.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center)

libuv用黑红树维护信号是数据，插入的规则是根据信号的大小和flags等信息。
 ![](https://img-blog.csdnimg.cn/20200901135352985.png#pic_center)

## 9.3 信号处理的注册
通过uv_signal_start注册一个信号处理函数。我们看看这个函数的逻辑

```c
1.	static int uv__signal_start(uv_signal_t* handle,  
2.	                            uv_signal_cb signal_cb,  
3.	                            int signum,  
4.	                            int oneshot) {  
5.	  sigset_t saved_sigmask;  
6.	  int err;  
7.	  uv_signal_t* first_handle;  
8.	  if (signum == 0)  
9.	    return UV_EINVAL;  
10.	  // 注册过了，重新设置处理函数就行  
11.	  if (signum == handle->signum) {  
12.	    handle->signal_cb = signal_cb;  
13.	    return 0;  
14.	  }  
15.	  // 这个handle之前已经设置了其他信号和处理函数，则先解除  
16.	  if (handle->signum != 0) {  
17.	    uv__signal_stop(handle);  
18.	  }  
19.	  // 屏蔽所有信号  
20.	  uv__signal_block_and_lock(&saved_sigmask);  
21.	  /* 
22.	      注册了该信号的第一个handle， 
23.	      优先返回设置了UV_SIGNAL_ONE_SHOT flag的， 
24.	      见compare函数 
25.	  */  
26.	  first_handle = uv__signal_first_handle(signum);  
27.	  /*  
28.	      1 之前没有注册过该信号的处理函数则直接设置 
29.	      2 之前设置过，但是是one shot，但是现在需要 
30.	        设置的规则不是one shot，需要修改。否则第 
31.	        二次不会不会触发。因为一个信号只能对应一 
32.	        个信号处理函数，所以，以规则宽的为准备，在回调 
33.	        里再根据flags判断是不是真的需要执行 
34.	      3 如果注册过信号和处理函数，则直接插入红黑树就行。 
35.	*/    
36.	if (  
37.	first_handle == NULL ||  
38.	      (!oneshot && (first_handle->flags & UV_SIGNAL_ONE_SHOT))  
39.	) {  
40.	    // 注册信号和处理函数  
41.	    err = uv__signal_register_handler(signum, oneshot);  
42.	    if (err) {  
43.	      uv__signal_unlock_and_unblock(&saved_sigmask);  
44.	      return err;  
45.	    }  
46.	  }  
47.	  // 记录感兴趣的信号  
48.	  handle->signum = signum;  
49.	  // 只处理一次该信号  
50.	  if (oneshot)  
51.	    handle->flags |= UV_SIGNAL_ONE_SHOT;  
52.	  // 插入红黑树  
53.	  RB_INSERT(uv__signal_tree_s, &uv__signal_tree, handle);  
54.	  
55.	  uv__signal_unlock_and_unblock(&saved_sigmask);  
56.	  
57.	  // 信号触发时的业务层回调  
58.	  handle->signal_cb = signal_cb;  
59.	  uv__handle_start(handle);  
60.	  
61.	  return 0;  
62.	}  
```

上面的代码比较多，大致的逻辑如下
1 给进程注册一个信号和信号处理函数。主要是调用操作系统的函数来处理的，代码如下

```c
1.	// 给当前进程注册信号处理函数，会覆盖之前设置的signum对应的处理函数  
2.	static int uv__signal_register_handler(int signum, int oneshot) {  
3.	  struct sigaction sa;  
4.	  
5.	  memset(&sa, 0, sizeof(sa));  
6.	  // 全置一，说明收到signum信号的时候，暂时屏蔽其他信号  
7.	  if (sigfillset(&sa.sa_mask))  
8.	abort();  
9.	  // 所有信号都由该函数处理  
10.	  sa.sa_handler = uv__signal_handler;  
11.	  sa.sa_flags = SA_RESTART;  
12.	  // 设置了oneshot，说明信号处理函数只执行一次，然后被恢复为系统的默认处理函数  
13.	  if (oneshot)  
14.	    sa.sa_flags |= SA_RESETHAND;  
15.	  
16.	  // 注册  
17.	  if (sigaction(signum, &sa, NULL))  
18.	    return UV__ERR(errno);  
19.	  
20.	  return 0;  
21.	}  
```

2 进程注册的信号和回调是在一棵红黑树管理的，每次注册的时候会往红黑树插入一个节点。
## 9.4 信号的处理
我们发现，在uv__signal_register_handler函数中有这样一句代码。
sa.sa_handler = uv__signal_handler;  
我们发现，不管注册什么信号，他的处理函数都是这个。我们自己的业务回调函数，是保存在handle里的。那么当任意信号到来的时候。uv__signal_handler就会被调用。下面我们看看uv__signal_handler函数。

```c
1.	/* 
2.	信号处理函数，signum为收到的信号， 
3.	每个子进程收到信号的时候都由该函数处理， 
4.	然后通过管道通知libuv 
5.	*/  
6.	static void uv__signal_handler(int signum) {  
7.	  uv__signal_msg_t msg;  
8.	  uv_signal_t* handle;  
9.	  int saved_errno;  
10.	  // 保持上一个系统调用的错误码  
11.	  saved_errno = errno;  
12.	  memset(&msg, 0, sizeof msg);  
13.	  
14.	  if (uv__signal_lock()) {  
15.	    errno = saved_errno;  
16.	    return;  
17.	  }  
18.	  
19.	  for (handle = uv__signal_first_handle(signum);  
20.	       handle != NULL && handle->signum == signum;  
21.	       handle = RB_NEXT(uv__signal_tree_s, &uv__signal_tree, handle)) {  
22.	    int r;  
23.	  
24.	    msg.signum = signum;  
25.	    msg.handle = handle;  
26.	  
27.	    do {  
28.	      // 通知libuv，哪些handle需要处理该信号，在poll io阶段处理  
29.	      r = write(handle->loop->signal_pipefd[1], &msg, sizeof msg);  
30.	    } while (r == -1 && errno == EINTR);  
31.	  
32.	    // 该handle收到信号的次数  
33.	    if (r != -1)  
34.	      handle->caught_signals++;  
35.	  }  
36.	  
37.	  uv__signal_unlock();  
38.	  errno = saved_errno;  
39.	}  
```

该函数遍历红黑树，找到注册了该信号的handle，然后封装一个msg写入管道（即可libuv通信的管道）。信号的处理就完成了。接下来在libuv的poll io阶段才做真正的处理。我们知道在poll io阶段。epoll会检测到管道loop->signal_pipefd[0]可读，然后会执行uv__signal_event函数。我们看看这个函数的代码。

```c
1.	// 如果收到信号,libuv poll io阶段,会执行该函数  
2.	static void uv__signal_event(uv_loop_t* loop,  
3.	                             uv__io_t* w,  
4.	                             unsigned int events) {  
5.	  uv__signal_msg_t* msg;  
6.	  uv_signal_t* handle;  
7.	  char buf[sizeof(uv__signal_msg_t) * 32];  
8.	  size_t bytes, end, i;  
9.	  int r;  
10.	  
11.	  bytes = 0;  
12.	  end = 0;  
13.	  
14.	  do {  
15.	    // 读出所有的uv__signal_msg_t  
16.	    r = read(loop->signal_pipefd[0], buf + bytes, sizeof(buf) - bytes);  
17.	  
18.	    if (r == -1 && errno == EINTR)  
19.	      continue;  
20.	  
21.	    if (r == -1 && (errno == EAGAIN || errno == EWOULDBLOCK)) {  
22.	      if (bytes > 0)  
23.	        continue;  
24.	      return;  
25.	    }  
26.	  
27.	    if (r == -1)  
28.	      abort();  
29.	  
30.	    bytes += r;  
31.	  
32.	    /* `end` is rounded down to a multiple of sizeof(uv__signal_msg_t). */  
33.	    end = (bytes / sizeof(uv__signal_msg_t)) * sizeof(uv__signal_msg_t);  
34.	  
35.	    for (i = 0; i < end; i += sizeof(uv__signal_msg_t)) {  
36.	      msg = (uv__signal_msg_t*) (buf + i);  
37.	      handle = msg->handle;  
38.	      // 收到的信号和handle感兴趣的信号一致，执行回调  
39.	      if (msg->signum == handle->signum) {  
40.	        assert(!(handle->flags & UV_HANDLE_CLOSING));  
41.	        handle->signal_cb(handle, handle->signum);  
42.	      }  
43.	      // 处理信号个数  
44.	      handle->dispatched_signals++;  
45.	      // 只执行一次，恢复系统默认的处理函数  
46.	      if (handle->flags & UV_SIGNAL_ONE_SHOT)  
47.	        uv__signal_stop(handle);  
48.	  
49.	      // 处理完了关闭  
50.	      if ((handle->flags & UV_HANDLE_CLOSING) &&  
51.	          (handle->caught_signals == handle->dispatched_signals)) {  
52.	        uv__make_close_pending((uv_handle_t*) handle);  
53.	      }  
54.	    }  
55.	  
56.	    bytes -= end;  
57.	  
58.	    if (bytes) {  
59.	      memmove(buf, buf + end, bytes);  
60.	      continue;  
61.	    }  
62.	  } while (end == sizeof buf);  
63.	}  
```

分支逻辑很多，我们只需要关注主要的。该函数从管道读出刚才写入的一个个msg。从msg中取出handle，然后执行里面保存的回调函数（即我们设置的回调函数）。至此。整个信号注册和处理的流程就完成了。整个流程总结如下：

1 libuv初始化的时候，申请一个管道，用于互斥控制，然后执行往里面写一个数据，保存后续的lock和unlock可以顺利执行。
2 执行uv_signal_init的时候，初始化handle的字段。如果是第一次调用，则申请一个管道，然后把管道的读端fd和回调封装成一个观察者oi，插入libuv的观察者队列。libuv会在poll io阶段往epoll里插入。
3 执行uv_signal_start的时候，给进程注册一个信号和处理函数（固定是uv__signal_handler）。往红黑树插入一个节点，或者修改里面的节点。
4 如果收到信号，在uv__signal_handler函数中会往管道（和libuv通信的）写入数据，即哪些handle注册的信号触发了。
5 在libuv的poll io阶段，从管道读端读出数据，遍历数据，是一个个msg，取出msg里的handle，然后取出handle里的回调函数执行。

