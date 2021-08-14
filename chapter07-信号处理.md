## 7.1 信号的概念和实现原理
信号是进程间通信的一种简单的方式，我们首先了解一下信号的概念和在操作系统中的实现原理。在操作系统内核的实现中，每个进程对应一个task_struct结构体（PCB），PCB中有一个字段记录了进程收到的信号（每一个比特代表一种信号）和信号对应的处理函数。这个和订阅者/发布者模式非常相似，我们看一下PCB中信号对应的数据结构。

```
1.	struct task_struct {  
2.	    // 收到的信号  
3.	    long signal;  
4.	    // 处理信号过程中屏蔽的信息  
5.	    long blocked;  
6.	    // 信号对应的处理函数  
7.	    struct sigaction sigaction[32];  
8.	       ...  
9.	};  
10.	  
11.	struct sigaction {  
12.	    // 信号处理函数  
13.	    void (*sa_handler)(int);  
14.	    // 处理信号时屏蔽哪些信息，和PCB的block字段对应  
15.	    sigset_t sa_mask;  
16.	    // 一些标记，比如处理函数只执行一次，类似events模块的once  
17.	    int sa_flags;  
18.	    // 清除调用栈信息，glibc使用  
19.	    void (*sa_restorer)(void);  
20.	};  
```

Linux下支持多种信号，进程收到信号时，操作系统提供了默认处理，我们也可以显式注册处理信号的函数，但是有些信号会导致进程退出，这是我们无法控制的。我们来看一下在Linux下信号使用的例子。

```
1.	#include <stdio.h>  
2.	#include <unistd.h>  
3.	#include <stdlib.h>  
4.	#include <signal.h>  
5.	  
6.	void handler(int);  
7.	  
8.	int main()  
9.	{  
10.	   signal(SIGINT, handler);  
11.	   while(1);  
12.	   return(0);  
13.	}  
14.	  
15.	void sighandler(int signum)  
16.	{  
17.	   printf("收到信号%d", signum);  
18.	}  
```

我们注册了一个信号对应的处理函数，然后进入while循环保证进程不会退出，这时候，如果我们给这个进程发送一个SIGINT信号（ctrl+c或者kill -2 pid）。则进程会执行对应的回调，然后输出：收到信号2。了解了信号的基本原理后，我们看一下Libuv中关于信号的设计和实现。
## 7.2 Libuv信号处理的设计思想
由于操作系统实现的限制，我们无法给一个信号注册多个处理函数，对于同一个信号，如果我们调用操作系统接口多次，后面的就会覆盖前面设置的值。想要实现一个信号被多个函数处理，我们只能在操作系统之上再封装一层，Libuv正是这样做的。Libuv中关于信号处理的封装和订阅者/发布者模式很相似。用户调用Libuv的接口注册信号处理函数，Libuv再向操作系统注册对应的处理函数，等待操作系统收到信号时，会触发Libuv的回调，Libuv的回调会通过管道通知事件循环收到的信号和对应的上下文，接着事件循环在Poll IO阶段就会处理收到所有信号以及对应的处理函数。整体架构如图7-1所示  
![](https://img-blog.csdnimg.cn/0e16d34a94b24fa194ae755589eea7c6.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图7-1

下面我们具体分析Libuv中信号处理的实现。
## 7.3 通信机制的实现
当进程收到信号的时候，信号处理函数需要通知Libuv事件循环，从而在事件循环中执行对应的回调，实现函数是uv__signal_loop_once_init，我们看一下uv__signal_loop_once_init的逻辑。

```
1.	static int uv__signal_loop_once_init(uv_loop_t* loop) { 
2.	  /* 
3.	        申请一个管道用于和事件循环通信，通知事件循环是否收到信号，
4.	        并设置非阻塞标记  
5.	    */
6.	  uv__make_pipe(loop->signal_pipefd, UV__F_NONBLOCK); 
7.	  /* 
8.	      设置信号IO观察者的处理函数和文件描述符， 
9.	      Libuv在Poll IO时，发现管道读端loop->signal_pipefd[0]可读， 
10.	      则执行uv__signal_event 
11.	    */  
12.	  uv__io_init(&loop->signal_io_watcher,  
13.	              uv__signal_event,  
14.	              loop->signal_pipefd[0]);  
15.	  /* 
16.	      插入Libuv的IO观察者队列，并注册感兴趣的事件为可读
17.	    */  
18.	  uv__io_start(loop, &loop->signal_io_watcher, POLLIN);  
19.	  
20.	  return 0; 
21.	} 
```

uv__signal_loop_once_init首先申请一个管道，用于通知事件循环是否收到信号。然后往Libuv的IO观察者队列注册一个观察者，Libuv在Poll IO阶段会把观察者加到epoll中。IO观察者里保存了管道读端的文件描述符loop->signal_pipefd[0]和回调函数uv__signal_event。uv__signal_event是收到任意信号时的回调，它会继续根据收到的信号进行逻辑分发。执行完的架构如图7-2所示。  
 ![](https://img-blog.csdnimg.cn/a33d83e422374f489c235f81ff7baddf.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图7-2

## 7.4 信号结构体的初始化
Libuv中信号使用uv_signal_t表示。

```
1.	int uv_signal_init(uv_loop_t* loop, uv_signal_t* handle) { 
2.	  // 申请和Libuv的通信管道并且注册IO观察者  
3.	  uv__signal_loop_once_init(loop);  
4.	  uv__handle_init(loop, (uv_handle_t*) handle, UV_SIGNAL);  
5.	  handle->signum = 0;  
6.	  handle->caught_signals = 0;  
7.	  handle->dispatched_signals = 0;  
8.	  
9.	  return 0;  
10.	}   
```

上面的代码的逻辑比较简单，只是初始化uv_signal_t结构体的一些字段。
## 7.5 信号处理的注册
我们可以通过uv_signal_start注册一个信号处理函数。我们看看这个函数的逻辑

```
1.	static int uv__signal_start(uv_signal_t* handle,  
2.	               uv_signal_cb signal_cb,  
3.	               int signum,  
4.	               int oneshot) {  
5.	  sigset_t saved_sigmask;  
6.	  int err;  
7.	  uv_signal_t* first_handle;  
8.	  // 注册过了，重新设置处理函数就行  
9.	  if (signum == handle->signum) {  
10.	    handle->signal_cb = signal_cb;  
11.	    return 0;  
12.	  }  
13.	  // 这个handle之前已经设置了其它信号和处理函数，则先解除  
14.	  if (handle->signum != 0) {  
15.	    uv__signal_stop(handle);  
16.	  }  
17.	  // 屏蔽所有信号  
18.	  uv__signal_block_and_lock(&saved_sigmask);  
19.	  /* 
20.	      查找注册了该信号的第一个handle， 
21.	      优先返回设置了UV_SIGNAL_ONE_SHOT flag的， 
22.	      见compare函数 
23.	    */  
24.	  first_handle = uv__signal_first_handle(signum);  
25.	  /*  
26.	      1 之前没有注册过该信号的处理函数则直接设置 
27.	      2 之前设置过，但是是one shot，但是现在需要 
28.	        设置的规则不是one shot，需要修改。否则第 
29.	        二次不会不会触发。因为一个信号只能对应一 
30.	        个信号处理函数，所以，以规则宽的为准，在回调 
31.	        里再根据flags判断是不是真的需要执行 
32.	      3 如果注册过信号和处理函数，则直接插入红黑树就行。 
33.	    */    
34.	    if (  
35.	         first_handle == NULL ||  
36.	     (!oneshot && (first_handle->flags & UV_SIGNAL_ONE_SHOT)) 
37.	    ) {  
38.	    // 注册信号和处理函数  
39.	    err = uv__signal_register_handler(signum, oneshot);  
40.	    if (err) {  
41.	      uv__signal_unlock_and_unblock(&saved_sigmask);  
42.	      return err;  
43.	    }  
44.	  }  
45.	  // 记录感兴趣的信号  
46.	  handle->signum = signum;  
47.	  // 只处理该信号一次  
48.	  if (oneshot)  
49.	    handle->flags |= UV_SIGNAL_ONE_SHOT;  
50.	  // 插入红黑树  
51.	  RB_INSERT(uv__signal_tree_s, &uv__signal_tree, handle);  
52.	  uv__signal_unlock_and_unblock(&saved_sigmask); 
53.	  // 信号触发时的业务层回调  
54.	    handle->signal_cb = signal_cb;  
55.	  uv__handle_start(handle);  
56.	  
57.	  return 0;  
58.	} 
```

 
上面的代码比较多，大致的逻辑如下. 
1 判断是否需要向操作系统注册一个信号的处理函数。主要是调用操作系统的函数来处理的，代码如下  

```
1.	// 给当前进程注册信号处理函数，会覆盖之前设置的signum的处理函数  
2.	static int uv__signal_register_handler(int signum, int oneshot) {
3.	  struct sigaction sa;  
4.	  
5.	  memset(&sa, 0, sizeof(sa));  
6.	  // 全置一，说明收到signum信号的时候，暂时屏蔽其它信号  
7.	  if (sigfillset(&sa.sa_mask))  
8.	      abort();  
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

我们看到所有信号的处理函数都是uv__signal_handler，我们一会会分析uv__signal_handler的实现。  
2进程注册的信号和回调是在一棵红黑树管理的，每次注册的时候会往红黑树插入一个节点。Libuv用黑红树维护信号的上下文，插入的规则是根据信号的大小和flags等信息。
RB_INSERT实现了往红黑树插入一个节点，红黑树中的节点是父节点的值比左孩子大，比右孩子小的。执行完RB_INSERT后的架构如图7-3所示。  
![](https://img-blog.csdnimg.cn/f986e8efd698465e8a5fa7cd384d25e5.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图7-3

我们看到，当我们每次插入不同的信号的时候，Libuv会在操作系统和红黑树中修改对应的数据结构。那么如果我们插入重复的信号呢？刚才我们已经分析过，插入重复的信号时，如果在操作系统注册过，并且当前插入的信号flags是one shot，而之前是非one shot时，Libuv会调用操作系统的接口去修改配置。那么对于红黑树来说，插入重复信号会如何处理呢？从刚才RB_INSERT的代码中我们看到每次插入红黑树时，红黑树会先判断是否存在相同值的节点，如果是的话直接返回，不进行插入。这么看起来我们无法给一个信号注册多个处理函数，但其实是可以的，重点在比较大小的函数。我们看看该函数的实现。

```
1.	static int uv__signal_compare(uv_signal_t* w1, uv_signal_t* w2) {  
2.	  int f1;  
3.	  int f2;  
4.	   
5.	  // 返回信号值大的  
6.	  if (w1->signum < w2->signum) return -1;  
7.	  if (w1->signum > w2->signum) return 1;  
8.	  
9.	  // 设置了UV_SIGNAL_ONE_SHOT的大  
10.	  f1 = w1->flags & UV_SIGNAL_ONE_SHOT;  
11.	  f2 = w2->flags & UV_SIGNAL_ONE_SHOT;  
12.	  if (f1 < f2) return -1;  
13.	  if (f1 > f2) return 1;  
14.	  
15.	  // 地址大的值就大  
16.	  if (w1->loop < w2->loop) return -1;  
17.	  if (w1->loop > w2->loop) return 1;  
18.	  
19.	  if (w1 < w2) return -1;  
20.	  if (w1 > w2) return 1;  
21.	  
22.	  return 0;  
23.	}  
```

我们看到Libuv比较的不仅是信号的大小，在信号一样的情况下，Libuv还会比较其它的因子，除非两个uv_signal_t指针指向的是同一个uv_signal_t结构体，否则它们是不会被认为重复的，所以红黑树中会存着信号一样的节点。假设我们按照1（flags为one shot），2（flags为非one shot）,3（flags为one shot）的顺序插入红黑树，并且节点3比节点1的地址大。所形成的结构如图7-4所示。  
![](https://img-blog.csdnimg.cn/e33fe52207444c97a7b2c950d6f5cb6f.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图7-4

## 7.6 信号的处理
我们上一节已经分析过，不管注册什么信号，它的处理函数都是这个uv__signal_handler函数。我们自己的业务回调函数，是保存在handle里的。而Libuv维护了一棵红黑树，记录了每个handle注册的信号和回调函数，那么当任意信号到来的时候。uv__signal_handler就会被调用。下面我们看看uv__signal_handler函数。

```
1.	/* 
2.	  信号处理函数，signum为收到的信号， 
3.	  每个子进程收到信号的时候都由该函数处理， 
4.	  然后通过管道通知Libuv 
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
18.	  // 找到该信号对应的所有handle
19.	  for (handle = uv__signal_first_handle(signum);  
20.	       handle != NULL && handle->signum == signum;  
21.	       handle = RB_NEXT(uv__signal_tree_s,
22.	                                 &uv__signal_tree, 
23.	                                 handle)) 
24.	   {  
25.	    int r;  
26.	        // 记录上下文
27.	    msg.signum = signum;  
28.	    msg.handle = handle;  
29.	    do {  
30.	      // 通知Libuv，哪些handle需要处理该信号，
31.	             在Poll IO阶段处理  
32.	      r = write(handle->loop->signal_pipefd[1], 
33.	                        &msg, 
34.	                        sizeof msg);  
35.	    } while (r == -1 && errno == EINTR);  
36.	    // 该handle收到信号的次数  
37.	    if (r != -1)  
38.	      handle->caught_signals++;  
39.	  }  
40.	  
41.	  uv__signal_unlock();  
42.	  errno = saved_errno;  
43.	}  
```

uv__signal_handler函数会调用uv__signal_first_handle遍历红黑树，找到注册了该信号的所有handle，我们看一下uv__signal_first_handle的实现。

```
1.	static uv_signal_t* uv__signal_first_handle(int signum) {  
2.	  uv_signal_t lookup;  
3.	  uv_signal_t* handle;  
4.	  
5.	  lookup.signum = signum;  
6.	  lookup.flags = 0;  
7.	  lookup.loop = NULL;  
8.	  
9.	  handle = RB_NFIND(uv__signal_tree_s, 
10.	                     &uv__signal_tree, 
11.	                     &lookup);  
12.	  
13.	  if (handle != NULL && handle->signum == signum)  
14.	    return handle;  
15.	  return NULL;  
16.	}  
```

uv__signal_first_handle函数通过RB_NFIND实现红黑树的查找，RB_NFIND是一个宏。

```
1.	#define RB_NFIND(name, x, y)    name##_RB_NFIND(x, y)  
```

我们看看name##_RB_NFIND即uv__signal_tree_s_RB_NFIND的实现

```
1.	static struct uv_signal_t * uv__signal_tree_s_RB_NFIND(struct uv__signal_tree_s *head, struct uv_signal_t *elm)                            
2.	{                                    
3.	  struct uv_signal_t *tmp = RB_ROOT(head);    
4.	  struct uv_signal_t *res = NULL;    
5.	  int comp;              
6.	  while (tmp) {    
7.	    comp = cmp(elm, tmp);     
8.	     /* 
9.	       elm小于当前节点则往左子树找，大于则往右子树找，
10.	      等于则返回           
11.	     */
12.	    if (comp < 0) {            
13.	      // 记录父节点
14.	      res = tmp;  
15.	      tmp = RB_LEFT(tmp, field);    
16.	    }           
17.	    else if (comp > 0)    
18.	      tmp = RB_RIGHT(tmp, field); 
19.	    else         
20.	      return (tmp);  
21.	  }             
22.	  return (res); 
23.	}     
```

uv__signal_tree_s_RB_NFIND的逻辑就是根据红黑树的特点进行搜索，这里的重点是cmp函数。刚才我们已经分析过cmp的逻辑。这里会首先查找没有设置one shot标记的handle（因为它的值小），然后再查找设置了one shot的handle，一旦遇到设置了one shot的handle，则说明后面被匹配的handle也是设置了one shot标记的。每次找到一个handle，就会封装一个msg写入管道（即和Libuv通信的管道）。信号的处理就完成了。接下来在Libuv的Poll IO阶段才做真正的处理。我们知道在Poll IO阶段。epoll会检测到管道loop->signal_pipefd[0]可读，然后会执行uv__signal_event函数。我们看看这个函数的代码。

```
1.	// 如果收到信号,Libuv Poll IO阶段,会执行该函数  
2.	static void uv__signal_event(uv_loop_t* loop, uv__io_t* w, 
3.	unsigned int events) {  
4.	  uv__signal_msg_t* msg;  
5.	  uv_signal_t* handle;  
6.	  char buf[sizeof(uv__signal_msg_t) * 32];  
7.	  size_t bytes, end, i;  
8.	  int r;  
9.	  
10.	  bytes = 0;  
11.	  end = 0;  
12.	  // 计算出数据的大小
13.	  do {  
14.	    // 读出所有的uv__signal_msg_t  
15.	    r = read(loop->signal_pipefd[0], 
16.	                   buf + bytes, 
17.	                   sizeof(buf) - bytes);  
18.	    if (r == -1 && errno == EINTR)  
19.	      continue;  
20.	    if (r == -1 && 
21.	            (errno == EAGAIN || 
22.	             errno == EWOULDBLOCK)) {  
23.	      if (bytes > 0)  
24.	        continue;  
25.	      return;  
26.	    }  
27.	    if (r == -1)  
28.	      abort();  
29.	    bytes += r;  
30.	    /*
31.	          根据收到的字节数算出有多少个uv__signal_msg_t结构体，
32.	          从而算出结束位置
33.	        */ 
34.	    end=(bytes/sizeof(uv__signal_msg_t))*sizeof(uv__signal_msg_t);
35.	      // 循环处理每一个msg
36.	    for (i = 0; i < end; i += sizeof(uv__signal_msg_t)) {
37.	      msg = (uv__signal_msg_t*) (buf + i); 
38.	            // 取出上下文 
39.	      handle = msg->handle;  
40.	      // 收到的信号和handle感兴趣的信号一致，执行回调  
41.	      if (msg->signum == handle->signum) {    
42.	        handle->signal_cb(handle, handle->signum);  
43.	      }  
44.	      // 处理信号个数，和收到的个数对应  
45.	      handle->dispatched_signals++;  
46.	      // 只执行一次，恢复系统默认的处理函数  
47.	      if (handle->flags & UV_SIGNAL_ONE_SHOT)  
48.	        uv__signal_stop(handle);  
49.	      /* 
50.	              处理完所有收到的信号才能关闭uv_signal_t，
51.	              见uv_close或uv__signal_close 
52.	            */ 
53.	      if ((handle->flags & UV_HANDLE_CLOSING) &&  
54.	        (handle->caught_signals==handle->dispatched_signals))          
55.	           {  
56.	        uv__make_close_pending((uv_handle_t*) handle);  
57.	      }  
58.	    }  
59.	    bytes -= end; 
60.	    if (bytes) {  
61.	      memmove(buf, buf + end, bytes);  
62.	      continue;  
63.	    }  
64.	  } while (end == sizeof buf);  
65.	}  
```

uv__signal_event函数的逻辑如下  
1 读出管道里的数据，计算出msg的个数。  
2 遍历收到的数据，解析出一个个msg。  
3 从msg中取出上下文（handle和信号），执行上层回调。  
4 如果handle设置了one shot则需要执行uv__signal_stop（我们接下来分析）。  
5 如果handle设置了closing标记，则判断所有收到的信号是否已经处理完。即收到的个数和处理的个数是否一致。需要处理完所有收到的信号才能关闭uv_signal_t。

## 7.7 取消/关闭信号处理
当一个信号对应的handle设置了one shot标记，在收到信号并且执行完回调后，Libuv会调用uv__signal_stop关闭该handle并且从红黑树中移除该handle。另外我们也可以显式地调用uv_close（会调用uv__signal_stop）关闭或取消信号的处理。下面我们看看uv__signal_stop的实现。

```
1.	static void uv__signal_stop(uv_signal_t* handle) {  
2.	  uv_signal_t* removed_handle;  
3.	  sigset_t saved_sigmask;  
4.	  uv_signal_t* first_handle;  
5.	  int rem_oneshot;  
6.	  int first_oneshot;  
7.	  int ret;  
8.	  
9.	  /* If the watcher wasn't started, this is a no-op. */  
10.	  // 没有注册过信号，则不需要处理  
11.	  if (handle->signum == 0)  
12.	    return;  
13.	  // 屏蔽所有信号  
14.	  uv__signal_block_and_lock(&saved_sigmask);  
15.	  // 移出红黑树  
16.	  removed_handle = RB_REMOVE(uv__signal_tree_s, &uv__signal_tree, handle);  
17.	  // 判断该信号是否还有对应的handle  
18.	  first_handle = uv__signal_first_handle(handle->signum);  
19.	  // 为空说明没有handle会处理该信号了，解除该信号的设置  
20.	  if (first_handle == NULL) {  
21.	    uv__signal_unregister_handler(handle->signum);  
22.	  } else {  
23.	    // 被处理的handle是否设置了one shot  
24.	    rem_oneshot = handle->flags & UV_SIGNAL_ONE_SHOT;  
25.	    /*
26.	      剩下的第一个handle是否设置了one shot，
27.	      如果是则说明该信号对应的所有剩下的handle都是one shot  
28.	    */ 
29.	    first_oneshot = first_handle->flags & UV_SIGNAL_ONE_SHOT;  
30.	    /* 
31.	      被移除的handle没有设置oneshot但是当前的第一个handle设置了
32.	       one shot，则需要修改该信号处理函数为one shot，防止收到多次信
33.	       号，执行多次回调 
34.	    */  
35.	    if (first_oneshot && !rem_oneshot) {  
36.	      ret = uv__signal_register_handler(handle->signum, 1);  
37.	      assert(ret == 0);  
38.	    }  
39.	  }  
40.	  
41.	  uv__signal_unlock_and_unblock(&saved_sigmask);  
42.	  
43.	  handle->signum = 0;  
44.	  uv__handle_stop(handle);  
45.	}  
```

## 7.8 信号在Node.js中的使用
分析完Libuv的实现后，我们看看Node.js上层是如何使用信号的，首先我们看一下C++层关于信号模块的实现。

```
1.	static void Initialize(Local<Object> target,  
2.	                         Local<Value> unused,  
3.	                         Local<Context> context,  
4.	                         void* priv) {  
5.	    Environment* env = Environment::GetCurrent(context);  
6.	    Local<FunctionTemplate> constructor = env->NewFunctionTemplate(New);  
7.	    constructor->InstanceTemplate()->SetInternalFieldCount(1);  
8.	    // 导出的类名  
9.	    Local<String> signalString =  
10.	        FIXED_ONE_BYTE_STRING(env->isolate(), "Signal");  
11.	    constructor->SetClassName(signalString);  
12.	    constructor->Inherit(HandleWrap::GetConstructorTemplate(env));  
13.	    // 给Signal创建的对象注入两个函数  
14.	    env->SetProtoMethod(constructor, "start", Start);  
15.	    env->SetProtoMethod(constructor, "stop", Stop);  
16.	  
17.	    target->Set(env->context(), signalString,  
18.	                constructor->GetFunction(env->context()).ToLocalChecked()).Check();  
19.	  }  
```

当我们在JS中new Signal的时候，首先会创建一个C++对象，然后作为入参执行New函数。

```
1.	static void New(const FunctionCallbackInfo<Value>& args) {  
2.	    CHECK(args.IsConstructCall());  
3.	    Environment* env = Environment::GetCurrent(args);  
4.	    new SignalWrap(env, args.This());  
5.	}  
```

当我们在JS层操作Signal实例的时候，就会执行C++层对应的方法。主要的方法是注册和删除信号。

```
1.	static void Start(const FunctionCallbackInfo<Value>& args) {  
2.	    SignalWrap* wrap;  
3.	    ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
4.	    Environment* env = wrap->env();  
5.	    int signum;  
6.	    if (!args[0]->Int32Value(env->context()).To(&signum)) return;  
7.	    int err = uv_signal_start(  
8.	        &wrap->handle_,  
9.	        // 信号产生时执行的回调  
10.	        [](uv_signal_t* handle, int signum) {  
11.	          SignalWrap* wrap = ContainerOf(&SignalWrap::handle_, 
12.	                                             handle);  
13.	          Environment* env = wrap->env();  
14.	          HandleScope handle_scope(env->isolate());  
15.	          Context::Scope context_scope(env->context());  
16.	          Local<Value> arg = Integer::New(env->isolate(), 
17.	                                              signum);  
18.	          // 触发JS层onsignal函数  
19.	          wrap->MakeCallback(env->onsignal_string(), 1, &arg);  
20.	        },  
21.	        signum);  
22.	  
23.	    if (err == 0) {  
24.	      CHECK(!wrap->active_);  
25.	      wrap->active_ = true;  
26.	      Mutex::ScopedLock lock(handled_signals_mutex);  
27.	      handled_signals[signum]++;  
28.	    }  
29.	  
30.	    args.GetReturnValue().Set(err);  
31.	  }  
32.	
33.	  static void Stop(const FunctionCallbackInfo<Value>& args) {
34.	    SignalWrap* wrap;
35.	    ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());
36.	
37.	    if (wrap->active_)  {
38.	      wrap->active_ = false;
39.	      DecreaseSignalHandlerCount(wrap->handle_.signum);
40.	    }
41.	
42.	    int err = uv_signal_stop(&wrap->handle_);
43.	    args.GetReturnValue().Set(err);
44.	  }
```

接着我们看在JS层如何使用。Node.js在初始化的时候，在is_main_thread.js中执行了。

```
1.	process.on('newListener', startListeningIfSignal);  
2.	process.on('removeListener', stopListeningIfSignal)  
```

newListener和removeListener事件在注册和删除事件的时候都会被触发。我们看一下这两个函数的实现

```
1.	/* 
2.	 { 
3.	  SIGINT: 2, 
4.	  ... 
5.	 } 
6.	*/  
7.	const { signals } = internalBinding('constants').os;  
8.	  
9.	let Signal;  
10.	const signalWraps = new Map();  
11.	  
12.	function isSignal(event) {  
13.	  return typeof event === 'string' && signals[event] !== undefined;  
14.	}  
15.	  
16.	function startListeningIfSignal(type) {  
17.	  if (isSignal(type) && !signalWraps.has(type)) {  
18.	    if (Signal === undefined)  
19.	      Signal = internalBinding('signal_wrap').Signal;  
20.	    const wrap = new Signal();  
21.	    // 不影响事件循环的退出  
22.	    wrap.unref();  
23.	    // 挂载信号处理函数  
24.	    wrap.onsignal = process.emit.bind(process, type, type);  
25.	    // 通过字符拿到数字  
26.	    const signum = signals[type];  
27.	    // 注册信号  
28.	    const err = wrap.start(signum);  
29.	    if (err) {  
30.	      wrap.close();  
31.	      throw errnoException(err, 'uv_signal_start');  
32.	    }  
33.	    // 该信号已经注册，不需要往底层再注册了  
34.	    signalWraps.set(type, wrap);  
35.	  }  
36.	}  
```

startListeningIfSignal函数的逻辑分为一下几个
1 判断该信号是否注册过了，如果注册过了则不需要再注册。Libuv本身支持在同一个信号上注册多个处理函数，Node.js的JS层也做了这个处理。
2 调用unref，信号的注册不应该影响事件循环的退出
3 挂载事件处理函数，当信号触发的时候，执行对应的处理函数（一个或多个）。
4 往底层注册信号并设置该信号已经注册的标记
我们再来看一下stopListeningIfSignal。

```
1.	function stopListeningIfSignal(type) {  
2.	  const wrap = signalWraps.get(type);  
3.	  if (wrap !== undefined && process.listenerCount(type) === 0) { 
4.	    wrap.close();  
5.	    signalWraps.delete(type);  
6.	  }  
7.	}  
```

只有当信号被注册过并且事件处理函数个数为0，才做真正的删除。
