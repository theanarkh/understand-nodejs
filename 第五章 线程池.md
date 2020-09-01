# 第五章 线程池
Libuv是基于事件驱动的异步io库。对于耗时的操作。如果在Libuv的主循环里执行的话，就会阻塞后面的任务执行。所以Libuv里维护了一个线程池。他负责处理Libuv中耗时或者导致阻塞的操作，比如文件io、dns、加解密、用户自定义的耗时任务。
## 5.1 线程池的初始化
线程池是懒初始化的。Nodejs启动的时候，并没有创建子线程，在提交第一个任务给线程池时，线程池才开始初始化。我们先看线程池的初始化，然后再看他的使用。

```c
1.	static void init_threads(void) {  
2.	  unsigned int i;  
3.	  const char* val;  
4.	  uv_sem_t sem;  
5.	  // 默认线程数4个，static uv_thread_t default_threads[4];  
6.	  nthreads = ARRAY_SIZE(default_threads);  
7.	  // 判断用户是否在环境变量中设置了线程数，是的话取用户定义的  
8.	  val = getenv("UV_THREADPOOL_SIZE");  
9.	  if (val != NULL)  
10.	    nthreads = atoi(val);  
11.	  if (nthreads == 0)  
12.	    nthreads = 1;  
13.	  // #define MAX_THREADPOOL_SIZE 128最多128个线程  
14.	  if (nthreads > MAX_THREADPOOL_SIZE)  
15.	    nthreads = MAX_THREADPOOL_SIZE;  
16.	    
17.	  threads = default_threads;  
18.	  // 超过默认大小，重新分配内存  
19.	  if (nthreads > ARRAY_SIZE(default_threads)) {  
20.	    threads = uv__malloc(nthreads * sizeof(threads[0]));  
21.	    // 分配内存失败，回退到默认  
22.	    if (threads == NULL) {  
23.	      nthreads = ARRAY_SIZE(default_threads);  
24.	      threads = default_threads;  
25.	    }  
26.	  }  
27.	  // 初始化条件变量，用于有任务时唤醒子线程，没有任务时挂起子线程  
28.	  if (uv_cond_init(&cond))  
29.	    abort();  
30.	  // 初始化互斥变量，用于多个子线程互斥访问任务队列  
31.	  if (uv_mutex_init(&mutex))  
32.	    abort();  
33.	  
34.	  // 初始化三个队列  
35.	  QUEUE_INIT(&wq);  
36.	  QUEUE_INIT(&slow_io_pending_wq);  
37.	  QUEUE_INIT(&run_slow_work_message);  
38.	  
39.	  // 初始化信号量变量，值为0  
40.	  if (uv_sem_init(&sem, 0))  
41.	    abort();  
42.	  // 创建多个线程，工作函数为worker，sem为worker入参  
43.	  for (i = 0; i < nthreads; i++)  
44.	    if (uv_thread_create(threads + i, worker, &sem))  
45.	      abort();  
46.	  // 为0则阻塞，非0则减一，这里等待所有线程启动成功再往下执行  
47.	  for (i = 0; i < nthreads; i++)  
48.	    uv_sem_wait(&sem);  
49.	  
50.	  uv_sem_destroy(&sem);  
51.	}  
```

线程池初始化时，会根据配置的子线程数创建对应数量的线程。默认是4个，最大128个子线程（不同版本的libuv可能会不一样）。我们也可以通过环境变量设置自定义的大小。
export UV_THREADPOOL_SIZE=10  
线程池的初始化主要是初始化一些数据结构，然后创建多个线程。接着在每个线程里执行worker函数。worker是消费者。
## 5.2 提交任务到线程池

```c
1.	// 给线程池提交一个任务  
2.	void uv__work_submit(uv_loop_t* loop,  
3.	                     struct uv__work* w,  
4.	                     enum uv__work_kind kind,  
5.	                     void (*work)(struct uv__work* w),  
6.	                     void (*done)(struct uv__work* w, int status)) {  
7.	 /* 
8.	    保证已经初始化线程，并只执行一次，所以线程池是在提交第一个 
9.	    任务的时候才被初始化 
10.	*/  
11.	  uv_once(&once, init_once);  
12.	  w->loop = loop;  
13.	  w->work = work;  
14.	  w->done = done;  
15.	  post(&w->wq, kind);  
16.	}  
```

这里把业务相关的函数和任务完成后的回调函数封装到uv__work结构体中。uv__work结构定义如下。
![](https://img-blog.csdnimg.cn/20200901134804178.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center)

```c
1.	struct uv__work {  
2.	  void (*work)(struct uv__work *w);  
3.	  void (*done)(struct uv__work *w, int status);  
4.	  struct uv_loop_s* loop;  
5.	  void* wq[2];  
6.	};  
```

然后调post往线程池的队列中加入一个新的任务。Libuv把任务分为三种类型，慢io（dns解析）、快io（文件操作）、cpu密集型等，kind就是说明任务的类型的。我们接着看post函数。

```c
1.	static void post(QUEUE* q, enum uv__work_kind kind) {  
2.	  // 加锁访问任务队列，因为这个队列是线程池共享的  
3.	  uv_mutex_lock(&mutex);  
4.	  // 类型是慢IO  
5.	  if (kind == UV__WORK_SLOW_IO) {  
6.	  /*  
7.	    插入慢IO对应的队列，llibuv这个版本把任务分为几种类型， 
8.	    对于慢io类型的任务，libuv是往任务队列里面插入一个特殊的节点 
9.	    run_slow_work_message，然后用slow_io_pending_wq维护了一个慢io任务的队列， 
10.	    当处理到run_slow_work_message这个节点的时候，libuv会从slow_io_pending_wq 
11.	    队列里逐个取出任务节点来执行。  
12.	  */  
13.	    QUEUE_INSERT_TAIL(&slow_io_pending_wq, q);  
14.	    /* 
15.	      有慢IO任务的时候，需要给主队列wq插入一个消息节点run_slow_work_message, 
16.	      说明有慢IO任务，所以如果run_slow_work_message是空，说明还没有插入主队列。 
17.	      需要进行q = &run_slow_work_message;赋值，然后把run_slow_work_message插入 
18.	      主队列。如果run_slow_work_message非空，说明已经插入线程池的任务队列了。 
19.	      解锁然后直接返回。 
20.	    */  
21.	    if (!QUEUE_EMPTY(&run_slow_work_message)) {  
22.	      uv_mutex_unlock(&mutex);  
23.	      return;  
24.	  }  
25.	  // 说明run_slow_work_message还没有插入队列，准备插入队列  
26.	    q = &run_slow_work_message;  
27.	  }  
28.	  // 把节点插入主队列，可能是慢IO消息节点或者一般任务  
29.	  QUEUE_INSERT_TAIL(&wq, q);  
30.	  // 有空闲线程则唤醒他，如果大家都在忙，则等到他忙完后就会重新判断是否还有新任务  
31.	  if (idle_threads > 0)  
32.	    uv_cond_signal(&cond); 
33.	  // 操作完队列，解锁 
34.	  uv_mutex_unlock(&mutex);  
35.	}  
```

这就是libuv中线程池的生产者逻辑。任务队列的架构如下。
 
除了上面提到的，libuv还提供了另外一种生产方式。即uv_queue_work函数。他只针对cpu密集型的。下面我们看uv_queue_work的实现。

```c
1.	int uv_queue_work(uv_loop_t* loop,  
2.	                  uv_work_t* req,  
3.	                  uv_work_cb work_cb,  
4.	                  uv_after_work_cb after_work_cb) {  
5.	  if (work_cb == NULL)  
6.	    return UV_EINVAL;  
7.	  
8.	  uv__req_init(loop, req, UV_WORK);  
9.	  req->loop = loop;  
10.	  req->work_cb = work_cb;  
11.	  req->after_work_cb = after_work_cb;  
12.	  uv__work_submit(loop,  
13.	                  &req->work_req,  
14.	                  UV__WORK_CPU,  
15.	                  uv__queue_work,  
16.	                  uv__queue_done);  
17.	  return 0;  
18.	}  
```

uv_queue_work函数其实也没有太多的逻辑，他保存用户的工作函数和回调到request中。然后提交任务，然后把uv__queue_work和uv__queue_done封装到uv__work中，接着提交任务。所以当这个任务被执行的时候。他会执行工作函数uv__queue_work。

```c
1.	static void uv__queue_work(struct uv__work* w) {  
2.	  // 通过结构体某字段拿到结构体地址  
3.	  uv_work_t* req = container_of(w, uv_work_t, work_req);  
4.	  req->work_cb(req);  
5.	}  
```

我们看到uv__queue_work其实就是对用户定义的任务函数进行了封装。这时候我们可以猜到，uv__queue_done也只是对用户回调的简单封装，即他会执行用户的回调。
## 5.3 处理任务
worker函数负责处理任务。

```c
1.	static void worker(void* arg) {  
2.	  struct uv__work* w;  
3.	  QUEUE* q;  
4.	  int is_slow_work;  
5.	  // 线程启动成功  
6.	  uv_sem_post((uv_sem_t*) arg);  
7.	  arg = NULL;  
8.	  // 加锁互斥访问任务队列  
9.	  uv_mutex_lock(&mutex);  
10.	  for (;;) {  
11.	    /* 
12.	      1 队列为空， 
13.	      2 队列不为空，但是队列里只有慢IO任务且正在执行的慢IO任务个数达到阈值 
14.	        则空闲线程加一，防止慢IO占用过多线程，导致其他快的任务无法得到执行 
15.	    */  
16.	    while (QUEUE_EMPTY(&wq) ||  
17.	           (QUEUE_HEAD(&wq) == &run_slow_work_message &&  
18.	            QUEUE_NEXT(&run_slow_work_message) == &wq &&  
19.	            slow_io_work_running >= slow_work_thread_threshold())) {  
20.	      idle_threads += 1;  
21.	      // 阻塞，等待唤醒  
22.	      uv_cond_wait(&cond, &mutex);  
23.	      // 被唤醒，开始干活，空闲线程数减一   
24.	      idle_threads -= 1;  
25.	    }  
26.	    // 取出头结点，头指点可能是退出消息、慢IO，一般请求  
27.	    q = QUEUE_HEAD(&wq);  
28.	   // 如果头结点是退出消息，则结束线程  
29.	   if (q == &exit_message) {  
30.	      // 唤醒其他因为没有任务正阻塞等待任务的线程，告诉他们准备退出  
31.	      uv_cond_signal(&cond);  
32.	      uv_mutex_unlock(&mutex);  
33.	      break;  
34.	    }  
35.	    // 移除节点   
36.	    QUEUE_REMOVE(q);  
37.	    // 重置前后指针  
38.	    QUEUE_INIT(q);    
39.	    is_slow_work = 0;  
40.	     /*  
41.	        如果当前节点等于慢IO节点，上面的while只判断了是不是只有慢io任务且达到 
42.	        阈值，这里是任务队列里肯定有非慢io任务，可能有慢io，如果有慢io并且正在 
43.	        执行的个数达到阈值，则先不处理该慢io任务，继续判断是否还有非慢io任务可 
44.	        执行。 
45.	     */  
46.	    if (q == &run_slow_work_message) {   
47.	      // 遇到阈值，重新入队   
48.	      if (slow_io_work_running >= slow_work_thread_threshold()) {  
49.	        QUEUE_INSERT_TAIL(&wq, q);  
50.	        continue;  
51.	      }  
52.	      // 没有慢IO任务则继续  
53.	      if (QUEUE_EMPTY(&slow_io_pending_wq))  
54.	        continue;  
55.	      // 有慢io，开始处理慢IO任务  
56.	      is_slow_work = 1;  
57.	      // 正在处理慢IO任务的个数累加，用于其他线程判断慢IO任务个数是否达到阈值  
58.	      slow_io_work_running++;  
59.	      // 摘下一个慢io任务  
60.	      q = QUEUE_HEAD(&slow_io_pending_wq);  
61.	      QUEUE_REMOVE(q);  
62.	      QUEUE_INIT(q);  
63.	      /* 
64.	          取出一个任务后，如果还有慢IO任务则把慢IO标记节点重新入队， 
65.	          表示还有慢IO任务，因为上面把该标记节点出队了  
66.	      */  
67.	      if (!QUEUE_EMPTY(&slow_io_pending_wq)) {  
68.	        QUEUE_INSERT_TAIL(&wq, &run_slow_work_message);  
69.	        // 有空闲线程则唤醒他，因为还有任务处理  
70.	        if (idle_threads > 0)  
71.	          uv_cond_signal(&cond);  
72.	      }  
73.	    }  
74.	    // 不需要操作队列了，尽快释放锁  
75.	    uv_mutex_unlock(&mutex);  
76.	    // q是慢IO或者一般任务  
77.	    w = QUEUE_DATA(q, struct uv__work, wq);  
78.	    // 执行业务的任务函数，该函数一般会阻塞  
79.	    w->work(w);  
80.	    // 准备操作loop的任务完成队列，加锁  
81.	    uv_mutex_lock(&w->loop->wq_mutex);  
82.	    // 置空说明指向完了，不能被取消了，见cancel逻辑  
83.	    w->work = NULL;    
84.	    // 执行完任务,插入到loop的wq队列,在uv__work_done的时候会执行该队列的节点  
85.	    QUEUE_INSERT_TAIL(&w->loop->wq, &w->wq);  
86.	    // 通知loop的wq_async节点  
87.	    uv_async_send(&w->loop->wq_async);  
88.	    uv_mutex_unlock(&w->loop->wq_mutex);  
89.	    // 为下一轮操作任务队列加锁  
90.	    uv_mutex_lock(&mutex);  
91.	    // 执行完慢IO任务，记录正在执行的慢IO个数变量减1，上面加锁保证了互斥访问这个变量  
92.	    if (is_slow_work) {  
93.	      slow_io_work_running--;  
94.	    }  
95.	  }  
96.	}  
```

我们看到消费者的逻辑似乎比较复杂，主要是把任务分为三种。并且对于慢io类型的任务，还限制了线程数。其余的逻辑和一般的线程池类型，就是互斥访问任务队列，然后取出节点执行，最后执行回调。
## 5.4 通知主线程
线程执行完任务后，并不是直接执行用户回调，而是通知主线程，由主线程处理，我们看一下这块的逻辑。一切要从libuv的初始化开始
uv_default_loop() ;-> uv_loop_init(); -> uv_async_init(loop, &loop->wq_async, uv__work_done);  
wq_async是用于线程池和主线程通信的async handle。他对应的回调是uv__work_done。所以当一个线程池的线程任务完成时，通过uv_async_send(&w->loop->wq_async)设置loop->wq_async.pending = 1，然后通知io观察者。Libuv在poll io阶段就会执行该handle对应的回调。该io观察者的回调是uv__work_done函数。那么我们就看看这个函数的逻辑。

```c
1.	void uv__work_done(uv_async_t* handle) {  
2.	  struct uv__work* w;  
3.	  uv_loop_t* loop;  
4.	  QUEUE* q;  
5.	  QUEUE wq;  
6.	  int err;  
7.	  // 通过结构体字段获得结构体首地址  
8.	  loop = container_of(handle, uv_loop_t, wq_async);  
9.	  // 准备处理队列，加锁  
10.	  uv_mutex_lock(&loop->wq_mutex);  
11.	  /*   
12.	    loop->wq是已完成的任务队列。把loop->wq队列的节点全部移到wp变量中，
13.	     这样一来可以尽快释放锁  
14.	  */  
15.	  QUEUE_MOVE(&loop->wq, &wq);  
16.	  // 不需要使用了，解锁  
17.	  uv_mutex_unlock(&loop->wq_mutex);  
18.	  // wq队列的节点来源是在线程的worker里插入  
19.	  while (!QUEUE_EMPTY(&wq)) {  
20.	    q = QUEUE_HEAD(&wq);  
21.	    QUEUE_REMOVE(q);  
22.	  
23.	    w = container_of(q, struct uv__work, wq); 
24.	    // 等于uv__canceled说明这个任务被取消了，不需要处理 
25.	    err = (w->work == uv__cancelled) ? UV_ECANCELED : 0;  
26.	    // 执行回调  
27.	    w->done(w, err);  
28.	  }  
29.	}  
```

逐个处理已完成的任务节点，执行回调。这就是整个消费者的逻辑。最后顺带提一下w->work == uv__cancelled。这个处理的用处是为了支持取消一个任务。Libuv提供了uv__work_cancel函数支持用户取消提交的任务。我们看一下他的逻辑。 

```c
1.	static int uv__work_cancel(uv_loop_t* loop, uv_req_t* req, struct uv__work* w) {  
2.	  int cancelled;  
3.	  // 加锁，为了把节点移出队列  
4.	  uv_mutex_lock(&mutex);  
5.	  // 加锁，为了判断w->wq是否为空  
6.	  uv_mutex_lock(&w->loop->wq_mutex);  
7.	  /* 
8.	    w在在任务队列中并且任务函数work不为空，则可取消， 
9.	    在work函数中，如果执行完了任务，会把work置NULL， 
10.	    所以一个任务可以取消的前提是他还没执行完。或者说还没执行过 
11.	  */  
12.	  cancelled = !QUEUE_EMPTY(&w->wq) && w->work != NULL;  
13.	  // 从任务队列中删除该节点  
14.	  if (cancelled)  
15.	    QUEUE_REMOVE(&w->wq);  
16.	  
17.	  uv_mutex_unlock(&w->loop->wq_mutex);  
18.	  uv_mutex_unlock(&mutex);  
19.	  // 不能取消  
20.	  if (!cancelled)  
21.	    return UV_EBUSY;  
22.	  // 重置回调函数  
23.	  w->work = uv__cancelled;  
24.	   
25.	  uv_mutex_lock(&loop->wq_mutex);  
26.	   /* 
27.	     插入loop的wq队列，对于取消的动作，libuv认为是任务执行完了。 
28.	     所以插入已完成的队列，不过他的回调是uv__cancelled函数， 
29.	     而不是用户设置的回调 
30.	   */  
31.	  QUEUE_INSERT_TAIL(&loop->wq, &w->wq);  
32.	  // 通知主线程有任务完成  
33.	  uv_async_send(&loop->wq_async);  
34.	  uv_mutex_unlock(&loop->wq_mutex);  
35.	  
36.	  return 0;  
37.	}  
```

我们看到这个函数定义前面加了一个static，说明这个函数是只在本文件内使用的，libuv对外提供的取消任务的接口是uv_cancel。
