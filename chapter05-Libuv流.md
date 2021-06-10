# 第五章 Libuv流
流的实现在Libuv里占了很大的篇幅，是非常核心的逻辑。流的本质是封装了对文件描述符的操作，例如读、写，连接、监听。我们首先看看数据结构，流在Libuv里用uv_stream_s表示，继承于uv_handle_s。

```cpp
1.	struct uv_stream_s {  
2.	  // uv_handle_s的字段  
3.	  void* data;          
4.	  // 所属事件循环     
5.	  uv_loop_t* loop;    
6.	  // handle类型      
7.	  uv_handle_type type;    
8.	  // 关闭handle时的回调  
9.	  uv_close_cb close_cb;   
10.	  // 用于插入事件循环的handle队列  
11.	  void* handle_queue[2];  
12.	  union {                 
13.	    int fd;               
14.	    void* reserved[4];    
15.	  } u;        
16.	  // 用于插入事件循环的closing阶段  
17.	  uv_handle_t* next_closing;   
18.	  // 各种标记   
19.	  unsigned int flags;  
20.	  // 流拓展的字段  
21.	  /*
22.	      户写入流的字节大小，流缓存用户的输入，
23.	      然后等到可写的时候才执行真正的写 
24.	    */ 
25.	  size_t write_queue_size;   
26.	  // 分配内存的函数，内存由用户定义，用来保存读取的数据
27.	  uv_alloc_cb alloc_cb;    
28.	  // 读回调                   
29.	  uv_read_cb read_cb;   
30.	  // 连接请求对应的结构体  
31.	  uv_connect_t *connect_req;   
32.	  /*
33.	      关闭写端的时候，发送完缓存的数据，
34.	      执行shutdown_req的回调（shutdown_req在uv_shutdown的时候赋值） 
35.	    */     
36.	  uv_shutdown_t *shutdown_req;  
37.	  /*
38.	     流对应的IO观察者
39.	    */
40.	  uv__io_t io_watcher;    
41.	  // 缓存待写的数据，该字段用于插入队列           
42.	  void* write_queue[2];         
43.	  // 已经完成了数据写入的队列，该字段用于插入队列     
44.	  void* write_completed_queue[2];  
45.	  // 有连接到来并且完成三次握手后，执行的回调  
46.	  uv_connection_cb connection_cb;  
47.	  // 操作流时出错码  
48.	  int delayed_error;    
49.	  // accept返回的通信socket对应的文件描述    
50.	    int accepted_fd;      
51.	  // 同上，用于IPC时，缓存多个传递的文件描述符
52.	  void* queued_fds;  
53.	}  
```

流的实现中，最核心的字段是IO观察者，其余的字段是和流的性质相关的。IO观察者封装了流对应的文件描述符和文件描述符事件触发时的回调。比如读一个流、写一个流、关闭一个流、连接一个流、监听一个流，在uv_stream_s中都有对应的字段去支持。但是本质上是靠IO观察者去驱动的。

1 读一个流，就是IO观察者中的文件描述符的可读事件触发时，执行用户的读回调。</br>
2 写一个流，先把数据写到流中，等到IO观察者中的文件描述符可写事件触发时，执行真正的写入，并执行用户的写结束回调。</br>
3 关闭一个流，就是IO观察者中的文件描述符可写事件触发时，就会执行关闭流的写端。如果流中还有数据没有写完，则先写完（比如发送）后再执行关闭操作，接着执行用户的回调。</br>
4 连接流，比如作为客户端去连接服务器。就是IO观察者中的文件描述符可读事件触发时（比如建立三次握手成功），执行用户的回调。</br>
5 监听流，就是IO观察者中的文件描述符可读事件触发时（比如有完成三次握手的连接），执行用户的回调。</br>

下面我们看一下流的具体实现
## 5.1 初始化流
在使用uv_stream_t之前需要首先初始化，我们看一下如何初始化一个流。

```cpp
1.	void uv__stream_init(uv_loop_t* loop,
2.	                      uv_stream_t* stream, 
3.	                      uv_handle_type type) {  
4.	  int err;  
5.	  // 记录handle的类型  
6.	  uv__handle_init(loop, (uv_handle_t*)stream, type);  
7.	  stream->read_cb = NULL;  
8.	  stream->alloc_cb = NULL;  
9.	  stream->close_cb = NULL;  
10.	  stream->connection_cb = NULL;  
11.	  stream->connect_req = NULL;  
12.	  stream->shutdown_req = NULL;  
13.	  stream->accepted_fd = -1;  
14.	  stream->queued_fds = NULL;  
15.	  stream->delayed_error = 0;  
16.	  QUEUE_INIT(&stream->write_queue);  
17.	  QUEUE_INIT(&stream->write_completed_queue);  
18.	  stream->write_queue_size = 0;  
19.	  /* 
20.	      初始化IO观察者，把文件描述符（这里还没有，所以是-1）和
21.	      回调uv__stream_io记录在io_watcher上，fd的事件触发时，统一
22.	      由uv__stream_io函数处理，但也会有特殊情况（下面会讲到）  
23.	    */
24.	  uv__io_init(&stream->io_watcher, uv__stream_io, -1);  
25.	}  
```

初始化一个流的逻辑很简单明了，就是初始化相关的字段，需要注意的是初始化IO观察者时，设置的处理函数是uv__stream_io，后面我们会分析这个函数的具体逻辑。
## 5.2 打开流 

```cpp
26.	int uv__stream_open(uv_stream_t* stream, int fd, int flags) {  
27.	  // 还没有设置fd或者设置的同一个fd则继续，否则返回UV_EBUSY
28.	  if (!(stream->io_watcher.fd == -1 || 
29.	           stream->io_watcher.fd == fd))  
30.	    return UV_EBUSY;  
31.	  // 设置流的标记  
32.	  stream->flags |= flags;  
33.	  // 是TCP流则可以设置下面的属性
34.	    if (stream->type == UV_TCP) {  
35.	    // 关闭nagle算法  
36.	    if ((stream->flags & UV_HANDLE_TCP_NODELAY) && 
37.	              uv__tcp_nodelay(fd, 1))  
38.	      return UV__ERR(errno); 
39.	    /* 
40.	          开启keepalive机制
41.	        */
42.	    if ((stream->flags & UV_HANDLE_TCP_KEEPALIVE) &&  
43.	       uv__tcp_keepalive(fd, 1, 60)) {  
44.	      return UV__ERR(errno);  
45.	    }  
46.	  }  
47.	  /*
48.	     保存socket对应的文件描述符到IO观察者中，Libuv会在
49.	     Poll IO阶段监听该文件描述符  
50.	    */
51.	  stream->io_watcher.fd = fd;  
52.	  return 0;  
53.	}  
```

打开一个流，本质上就是给这个流关联一个文件描述符，后续的操作的时候都是基于这个文件描述符的，另外还有一些属性的设置。
## 5.3 读流
我们在一个流上执行uv_read_start后，流的数据（如果有的话）就会通过read_cb回调源源不断地流向调用方。

```cpp
1.	int uv_read_start(uv_stream_t* stream, 
2.	                   uv_alloc_cb alloc_cb, 
3.	                   uv_read_cb read_cb) {  
4.	  // 流已经关闭，不能读  
5.	  if (stream->flags & UV_HANDLE_CLOSING)  
6.	    return UV_EINVAL;  
7.	  // 流不可读，说明可能是只写流  
8.	  if (!(stream->flags & UV_HANDLE_READABLE))  
9.	    return -ENOTCONN;  
10.	  // 标记正在读  
11.	  stream->flags |= UV_HANDLE_READING;  
12.	  // 记录读回调，有数据的时候会执行这个回调  
13.	  stream->read_cb = read_cb;  
14.	  // 分配内存函数，用于存储读取的数据  
15.	  stream->alloc_cb = alloc_cb;  
16.	  // 注册等待读事件  
17.	  uv__io_start(stream->loop, &stream->io_watcher, POLLIN);  
18.	  // 激活handle，有激活的handle，事件循环不会退出  
19.	  uv__handle_start(stream);  
20.	  return 0;  
21.	}  
```

执行uv_read_start本质上是给流对应的文件描述符在epoll中注册了一个等待可读事件，并记录相应的上下文，比如读回调函数，分配内存的函数。接着打上正在做读取操作的标记。当可读事件触发的时候，读回调就会被执行，除了读取数据，还有一个读操作就是停止读取。对应的函数是uv_read_stop。

```cpp
1.	int uv_read_stop(uv_stream_t* stream) {  
2.	  // 是否正在执行读取操作，如果不是，则没有必要停止  
3.	  if (!(stream->flags & UV_HANDLE_READING))  
4.	    return 0;  
5.	  // 清除正在读取的标记  
6.	  stream->flags &= ~UV_HANDLE_READING;  
7.	  // 撤销等待读事件  
8.	  uv__io_stop(stream->loop, &stream->io_watcher, POLLIN);  
9.	  // 对写事件也不感兴趣，停掉handle。允许事件循环退出  
10.	  if (!uv__io_active(&stream->io_watcher, POLLOUT))  
11.	    uv__handle_stop(stream);  
12.	  stream->read_cb = NULL;  
13.	  stream->alloc_cb = NULL;  
14.	  return 0;  
15.	}  
```

另外还有一个辅助函数，判断流是否设置了可读属性。

```cpp
1.	int uv_is_readable(const uv_stream_t* stream) {  
2.	  return !!(stream->flags & UV_HANDLE_READABLE);  
3.	}  
```

上面的函数只是注册和注销读事件，如果可读事件触发的时候，我们还需要自己去读取数据，我们看一下真正的读逻辑

```cpp
1.	static void uv__read(uv_stream_t* stream) {  
2.	  uv_buf_t buf;  
3.	  ssize_t nread;  
4.	  struct msghdr msg;  
5.	  char cmsg_space[CMSG_SPACE(UV__CMSG_FD_SIZE)];  
6.	  int count;  
7.	  int err;  
8.	  int is_ipc;  
9.	  // 清除读取部分标记  
10.	  stream->flags &= ~UV_STREAM_READ_PARTIAL;  
11.	  count = 32;  
12.	  /*
13.	      流是Unix域类型并且用于IPC，Unix域不一定用于IPC，
14.	      用作IPC可以支持传递文件描述符  
15.	    */
16.	  is_ipc = stream->type == UV_NAMED_PIPE && 
17.	                                ((uv_pipe_t*) stream)->ipc;  
18.	  // 设置了读回调，正在读，count大于0  
19.	  while (stream->read_cb  
20.	      && (stream->flags & UV_STREAM_READING)  
21.	      && (count-- > 0)) {  
22.	    buf = uv_buf_init(NULL, 0);  
23.	    // 调用调用方提供的分配内存函数，分配内存承载数据  
24.	    stream->alloc_cb((uv_handle_t*)stream, 64 * 1024, &buf);  
25.	    /*
26.	         不是IPC则直接读取数据到buf，否则用recvmsg读取数据                       
27.	          和传递的文件描述符（如果有的话）
28.	        */  
29.	    if (!is_ipc) {  
30.	      do {  
31.	        nread = read(uv__stream_fd(stream), 
32.	                                            buf.base, 
33.	                                            buf.len);  
34.	      }  
35.	      while (nread < 0 && errno == EINTR);  
36.	    } else {  
37.	      /* ipc uses recvmsg */  
38.	      msg.msg_flags = 0;  
39.	      msg.msg_iov = (struct iovec*) &buf;  
40.	      msg.msg_iovlen = 1;  
41.	      msg.msg_name = NULL;  
42.	      msg.msg_namelen = 0;  
43.	      msg.msg_controllen = sizeof(cmsg_space);  
44.	      msg.msg_control = cmsg_space; 
45.	      do {  
46.	        nread = uv__recvmsg(uv__stream_fd(stream), &msg, 0);
47.	      }  
48.	      while (nread < 0 && errno == EINTR);  
49.	    }  
50.	    // 读失败  
51.	    if (nread < 0) { 
52.	      // 读繁忙  
53.	      if (errno == EAGAIN || errno == EWOULDBLOCK) {  
54.	        // 执行读回调  
55.	        stream->read_cb(stream, 0, &buf);  
56.	      } else {  
57.	        /* Error. User should call uv_close(). */  
58.	        // 读失败  
59.	        stream->read_cb(stream, -errno, &buf);  
60.	      }  
61.	      return;  
62.	    } else if (nread == 0) {  
63.	      // 读到结尾了  
64.	      uv__stream_eof(stream, &buf);  
65.	      return;  
66.	    } else {   
67.	      // 读成功，读取数据的长度  
68.	      ssize_t buflen = buf.len;  
69.	      /*
70.	                是IPC则解析读取的数据，把文件描述符解析出来，
71.	                放到stream的accepted_fd和queued_fds字段  
72.	            */
73.	      if (is_ipc) {  
74.	        err = uv__stream_recv_cmsg(stream, &msg);  
75.	        if (err != 0) {  
76.	          stream->read_cb(stream, err, &buf);  
77.	          return;  
78.	        }  
79.	      }  
80.	      // 执行读回调  
81.	      stream->read_cb(stream, nread, &buf);  
82.	    }  
83.	  }  
84.	}  
```

uv_read除了可以读取一般的数据外，还支持读取传递的文件描述符。我们看一下描述符传递的原理。我们知道，父进程fork出子进程的时候，子进程是继承父进程的文件描述符列表的。我们看一下进程和文件描述符的关系。
fork之前如图5-1所示。

 ![](https://img-blog.csdnimg.cn/20210420235737186.png)

我们再看一下fork之后的结构如图5-2所示。

![](https://img-blog.csdnimg.cn/20210420235751592.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)

如果父进程或者子进程在fork之后创建了新的文件描述符，那父子进程间就不能共享了，假设父进程要把一个文件描述符传给子进程，那怎么办呢？根据进程和文件描述符的关系。传递文件描述符要做的事情，不仅仅是在子进程中新建一个fd，还要建立起fd->file->inode的关联，不过我们不需要关注这些，因为操作系统都帮我们处理了，我们只需要通过sendmsg把想传递的文件描述符发送给Unix域的另一端。Unix域另一端就可以通过recvmsg把文件描述符从数据中读取出来。接着使用uv__stream_recv_cmsg函数保存数据里解析出来的文件描述符。

```cpp
1.	static int uv__stream_recv_cmsg(uv_stream_t* stream, 
2.	                                   struct msghdr* msg) {  
3.	  struct cmsghdr* cmsg;  
4.	  // 遍历msg  
5.	  for (cmsg = CMSG_FIRSTHDR(msg); 
6.	        cmsg != NULL; 
7.	        cmsg = CMSG_NXTHDR(msg, cmsg)) {  
8.	     char* start;  
9.	     char* end;  
10.	    int err;  
11.	    void* pv;  
12.	    int* pi;  
13.	    unsigned int i;  
14.	    unsigned int count;  
15.	  
16.	    pv = CMSG_DATA(cmsg);  
17.	    pi = pv;  
18.	    start = (char*) cmsg;  
19.	    end = (char*) cmsg + cmsg->cmsg_len;  
20.	    count = 0;  
21.	    while (start + CMSG_LEN(count * sizeof(*pi)) < end)  
22.	      count++;  
23.	    for (i = 0; i < count; i++) {  
24.	      /* 
25.	        accepted_fd代表当前待处理的文件描述符， 
26.	        如果已经有值则剩余描述符就通过uv__stream_queue_fd排队 
27.	        如果还没有值则先赋值 
28.	      */  
29.	      if (stream->accepted_fd != -1) {  
30.	        err = uv__stream_queue_fd(stream, pi[i]);  
31.	      } else {  
32.	        stream->accepted_fd = pi[i];  
33.	      }  
34.	    }  
35.	  }  
36.	  
37.	  return 0;  
38.	}  
```

uv__stream_recv_cmsg会从数据中解析出一个个文件描述符存到stream中，第一个文件描述符保存在accepted_fd，剩下的使用uv__stream_queue_fd处理。

```cpp
1.	struct uv__stream_queued_fds_s {  
2.	  unsigned int size;  
3.	  unsigned int offset;  
4.	  int fds[1];  
5.	};  
6.	  
7.	static int uv__stream_queue_fd(uv_stream_t* stream, int fd) {  
8.	  uv__stream_queued_fds_t* queued_fds;  
9.	  unsigned int queue_size;  
10.	  // 原来的内存  
11.	  queued_fds = stream->queued_fds;  
12.	  // 没有内存，则分配  
13.	  if (queued_fds == NULL) {  
14.	    // 默认8个  
15.	    queue_size = 8;  
16.	    /* 
17.	      一个元数据内存+多个fd的内存
18.	      （前面加*代表解引用后的值的类型所占的内存大小，
19.	      减一是因为uv__stream_queued_fds_t
20.	      结构体本身有一个空间）
21.	    */
22.	    queued_fds = uv__malloc((queue_size - 1) * 
23.	                               sizeof(*queued_fds->fds) +  
24.	                            sizeof(*queued_fds));  
25.	    if (queued_fds == NULL)  
26.	      return UV_ENOMEM;  
27.	    // 容量  
28.	    queued_fds->size = queue_size;  
29.	    // 已使用个数  
30.	    queued_fds->offset = 0;  
31.	    // 指向可用的内存  
32.	    stream->queued_fds = queued_fds;  
33.	  // 之前的内存用完了，扩容  
34.	  } else if (queued_fds->size == queued_fds->offset) {  
35.	    // 每次加8个  
36.	    queue_size = queued_fds->size + 8;  
37.	    queued_fds = uv__realloc(queued_fds,  
38.	                             (queue_size - 1) * sizeof(*queued_fds->fds) + sizeof(*queued_fds));  
39.	  
40.	    if (queued_fds == NULL)  
41.	      return UV_ENOMEM;  
42.	    // 更新容量大小  
43.	    queued_fds->size = queue_size;  
44.	    // 保存新的内存  
45.	    stream->queued_fds = queued_fds;  
46.	  }  
47.	  
48.	  /* Put fd in a queue */  
49.	  // 保存fd  
50.	  queued_fds->fds[queued_fds->offset++] = fd;  
51.	  
52.	  return 0;  
53.	}  
```

内存结构如图5-3所示。

 ![](https://img-blog.csdnimg.cn/20210420235824605.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)

最后我们看一下读结束后的处理，

```cpp
1.	static void uv__stream_eof(uv_stream_t* stream, 
2.	                             const uv_buf_t* buf) {  
3.	  // 打上读结束标记  
4.	  stream->flags |= UV_STREAM_READ_EOF;  
5.	  // 注销等待可读事件  
6.	  uv__io_stop(stream->loop, &stream->io_watcher, POLLIN);  
7.	  // 没有注册等待可写事件则停掉handle，否则会影响事件循环的退出  
8.	  if (!uv__io_active(&stream->io_watcher, POLLOUT))  
9.	    uv__handle_stop(stream);  
10.	  uv__stream_osx_interrupt_select(stream);  
11.	  // 执行读回调  
12.	  stream->read_cb(stream, UV_EOF, buf);  
13.	  // 清除正在读标记   
14.	  stream->flags &= ~UV_STREAM_READING;  
15.	}  
```

我们看到，流结束的时候，首先注销等待可读事件，然后通过回调通知上层。
## 5.4 写流
我们在流上执行uv_write就可以往流中写入数据。

```cpp
1.	int uv_write(  
2.	        /* 
3.	              一个写请求，记录了需要写入的数据和信息。
4.	               数据来自下面的const uv_buf_t bufs[]  
5.	             */
6.	       uv_write_t* req,  
7.	       // 往哪个流写  
8.	       uv_stream_t* handle,  
9.	       // 需要写入的数据  
10.	       const uv_buf_t bufs[],  
11.	       // uv_buf_t个数  
12.	       unsigned int nbufs,  
13.	       // 写完后执行的回调  
14.	       uv_write_cb cb  
15.	) {  
16.	  return uv_write2(req, handle, bufs, nbufs, NULL, cb);  
17.	}
```

uv_write是直接调用uv_write2。第四个参数是NULL。代表是一般的写数据，不传递文件描述符。

```cpp
1.	int uv_write2(uv_write_t* req,  
2.	              uv_stream_t* stream,  
3.	              const uv_buf_t bufs[],  
4.	              unsigned int nbufs,  
5.	              uv_stream_t* send_handle,  
6.	              uv_write_cb cb) {  
7.	  int empty_queue; 
8.	  // 待发送队列是否为空  
9.	  empty_queue = (stream->write_queue_size == 0);  
10.	  // 构造一个写请求  
11.	  uv__req_init(stream->loop, req, UV_WRITE);  
12.	    // 写请求对应的回调
13.	  req->cb = cb; 
14.	    // 写请求对应的流 
15.	  req->handle = stream;  
16.	  req->error = 0;  
17.	    // 需要发送的文件描述符，也可以是NULL说明不需要发送文件描述符
18.	  req->send_handle = send_handle;  
19.	  QUEUE_INIT(&req->queue);  
20.	  // bufs指向待写的数据  
21.	  req->bufs = req->bufsml;  
22.	  // 复制调用方的数据过来  
23.	  memcpy(req->bufs, bufs, nbufs * sizeof(bufs[0]));  
24.	  // buf个数  
25.	  req->nbufs = nbufs;  
26.	  // 当前写成功的buf索引，针对bufs数组  
27.	  req->write_index = 0;  
28.	  // 待写的数据大小 = 之前的大小 + 本次大小  
29.	  stream->write_queue_size += uv__count_bufs(bufs, nbufs);  
30.	  // 插入待写队列  
31.	  QUEUE_INSERT_TAIL(&stream->write_queue, &req->queue);  
32.	  // 非空说明正在连接，还不能写，比如TCP流  
33.	  if (stream->connect_req) {  
34.	    /* Still connecting, do nothing. */  
35.	  }  
36.	  else if (empty_queue) { // 当前待写队列为空，直接写  
37.	    uv__write(stream);  
38.	  }  
39.	  else {  
40.	    // 还有数据没有写完，注册等待写事件  
41.	    uv__io_start(stream->loop, &stream->io_watcher, POLLOUT);  
42.	    uv__stream_osx_interrupt_select(stream);  
43.	  }  
44.	  return 0;  
45.	}  
```

uv_write2的主要逻辑就是封装一个写请求，插入到流的待写队列。然后根据当前流的情况。看是直接写入还是等待会再写入。关系图大致如图5-4所示。

 ![](https://img-blog.csdnimg.cn/202104202359054.png)

uv_write2只是对写请求进行一些预处理，真正执行写的函数是uv__write 

```cpp
1.	static void uv__write(uv_stream_t* stream) {  
2.	  struct iovec* iov;  
3.	  QUEUE* q;  
4.	  uv_write_t* req;  
5.	  int iovmax;  
6.	  int iovcnt;  
7.	  ssize_t n;  
8.	  int err;  
9.	  
10.	start:  
11.	  // 没有数据需要写
12.	  if (QUEUE_EMPTY(&stream->write_queue))  
13.	    return;  
14.	  q = QUEUE_HEAD(&stream->write_queue);  
15.	  req = QUEUE_DATA(q, uv_write_t, queue); 
16.	  // 从哪里开始写  
17.	  iov = (struct iovec*) &(req->bufs[req->write_index]);  
18.	  // 还有多少没写  
19.	  iovcnt = req->nbufs - req->write_index;  
20.	  // 最多可以写多少  
21.	  iovmax = uv__getiovmax();  
22.	  // 取最小值  
23.	  if (iovcnt > iovmax)  
24.	    iovcnt = iovmax;  
25.	  // 需要传递文件描述符  
26.	  if (req->send_handle) {  
27.	    int fd_to_send;  
28.	    struct msghdr msg;  
29.	    struct cmsghdr *cmsg;  
30.	    union {  
31.	      char data[64];  
32.	      struct cmsghdr alias;  
33.	    } scratch;  
34.	  
35.	    if (uv__is_closing(req->send_handle)) {  
36.	      err = -EBADF;  
37.	      goto error;  
38.	    }  
39.	    // 待发送的文件描述符  
40.	    fd_to_send = uv__handle_fd((uv_handle_t*) req->send_handle);
41.	    memset(&scratch, 0, sizeof(scratch));  
42.	  
43.	    msg.msg_name = NULL;  
44.	    msg.msg_namelen = 0;  
45.	    msg.msg_iov = iov;  
46.	    msg.msg_iovlen = iovcnt;  
47.	    msg.msg_flags = 0;  
48.	  
49.	    msg.msg_control = &scratch.alias;  
50.	    msg.msg_controllen = CMSG_SPACE(sizeof(fd_to_send));  
51.	  
52.	    cmsg = CMSG_FIRSTHDR(&msg);  
53.	    cmsg->cmsg_level = SOL_SOCKET;  
54.	    cmsg->cmsg_type = SCM_RIGHTS;  
55.	    cmsg->cmsg_len = CMSG_LEN(sizeof(fd_to_send));  
56.	  
57.	    {  
58.	      void* pv = CMSG_DATA(cmsg);  
59.	      int* pi = pv;  
60.	      *pi = fd_to_send;  
61.	    }  
62.	  
63.	    do {  
64.	      // 使用sendmsg函数发送文件描述符  
65.	      n = sendmsg(uv__stream_fd(stream), &msg, 0);  
66.	    }  
67.	    while (n == -1 && errno == EINTR);  
68.	  } else {  
69.	    do {  
70.	      // 写一个或者写批量写  
71.	      if (iovcnt == 1) {  
72.	        n = write(uv__stream_fd(stream), 
73.	                            iov[0].iov_base, 
74.	                            iov[0].iov_len);  
75.	      } else {  
76.	        n = writev(uv__stream_fd(stream), iov, iovcnt);  
77.	      }  
78.	    }  
79.	    while (n == -1 && errno == EINTR);  
80.	  }  
81.	  // 写失败  
82.	  if (n < 0) {  
83.	    /*
84.	        不是写繁忙，则报错，
85.	         否则如果设置了同步写标记，则继续尝试写
86.	        */  
87.	    if (errno != EAGAIN && 
88.	             errno != EWOULDBLOCK && 
89.	             errno != ENOBUFS) {  
90.	      err = -errno;  
91.	      goto error;  
92.	    } else if (stream->flags & UV_STREAM_BLOCKING) {  
93.	      /* If this is a blocking stream, try again. */  
94.	      goto start;  
95.	    }  
96.	  } else {  
97.	    // 写成功  
98.	    while (n >= 0) {  
99.	      // 当前buf首地址  
100.	      uv_buf_t* buf = &(req->bufs[req->write_index]);  
101.	      // 当前buf的数据长度  
102.	      size_t len = buf->len;  
103.	      // 小于说明当前buf还没有写完（还没有被消费完）  
104.	      if ((size_t)n < len) {  
105.	        // 更新待写的首地址  
106.	        buf->base += n;  
107.	        // 更新待写的数据长度  
108.	        buf->len -= n;  
109.	        /*
110.	                 更新待写队列的长度，这个队列是待写数据的
111.	                  总长度，等于多个buf的和
112.	                */  
113.	        stream->write_queue_size -= n;  
114.	        n = 0;  
115.	        /*
116.	                  还没写完，设置了同步写，则继续尝试写，
117.	                  否则退出，注册待写事件
118.	                */  
119.	        if (stream->flags & UV_STREAM_BLOCKING) {  
120.	          goto start;  
121.	        } else {  
122.	          break;  
123.	        } 
124.	      } else {  
125.	        /* 
126.	                  当前buf的数据都写完了，则更新待写数据的的首
127.	                  地址，即下一个buf，因为当前buf写完了  
128.	                */
129.	        req->write_index++;  
130.	        // 更新n，用于下一个循环的计算  
131.	        n -= len;  
132.	        // 更新待写队列的长度  
133.	        stream->write_queue_size -= len;  
134.	        /*
135.	                 等于最后一个buf了，说明待写队列的数据
136.	                  都写完了
137.	                */  
138.	        if (req->write_index == req->nbufs) { 
139.	          /* 
140.	                      释放buf对应的内存，并把请求插入写完成
141.	                      队列，然后准备触发写完成回调  
142.	                    */
143.	          uv__write_req_finish(req);  
144.	          return;  
145.	        }  
146.	      }  
147.	    }  
148.	  }  
149.	  /*
150.	      写成功，但是还没有写完，注册待写事件，
151.	      等待可写的时候继续写  
152.	    */
153.	  uv__io_start(stream->loop, &stream->io_watcher, POLLOUT);  
154.	  uv__stream_osx_interrupt_select(stream);  
155.	  
156.	  return;  
157.	// 写出错  
158.	error:  
159.	  // 记录错误  
160.	  req->error = err;  
161.	  /*
162.	     释放内存，丢弃数据，插入写完成队列，
163.	      把IO观察者插入pending队列，等待pending阶段执行回调 
164.	    */ 
165.	  uv__write_req_finish(req);  
166.	  // 注销待写事件  
167.	  uv__io_stop(stream->loop, &stream->io_watcher, POLLOUT);  
168.	  // 如果也没有注册等待可读事件，则把handle关闭  
169.	  if (!uv__io_active(&stream->io_watcher, POLLIN))  
170.	    uv__handle_stop(stream);  
171.	  uv__stream_osx_interrupt_select(stream);  
172.	}  
```

我们看一下一个写请求结束后（成功或者失败），Libuv如何处理的。逻辑在uv__write_req_finish函数。

```cpp
1.	static void uv__write_req_finish(uv_write_t* req) {  
2.	  uv_stream_t* stream = req->handle;
3.	    // 从待写队列中移除  
4.	  QUEUE_REMOVE(&req->queue);  
5.	    // 写成功，并且分配了额外的堆内存，则需要释放，见uv__write
6.	  if (req->error == 0) {  
7.	    if (req->bufs != req->bufsml)  
8.	      uv__free(req->bufs);  
9.	    req->bufs = NULL;  
10.	  }  
11.	    // 插入写完成队列
12.	  QUEUE_INSERT_TAIL(&stream->write_completed_queue, &req->queue); 
13.	    /*
14.	      把IO观察者插入pending队列，Libuv在处理pending阶段时,
15.	      会触发IO观察者的写事件
16.	    */
17.	  uv__io_feed(stream->loop, &stream->io_watcher);  
18.	}  
```

uv__write_req_finish的逻辑比较简单

1把节点从待写队列中移除
2 req->bufs != req->bufsml不相等说明分配了堆内存，需要自己释放
3并把请求插入写完成队列，把IO观察者插入pending队列，等待pending阶段执行回调，在pending节点会执行IO观察者的回调（uv__stream_io）。

我们看一下uv__stream_io如何处理的，下面是具体的处理逻辑。

```cpp
1.	// 可写事件触发  
2.	if (events & (POLLOUT | POLLERR | POLLHUP)) {  
3.	    // 继续执行写  
4.	    uv__write(stream);  
5.	    // 处理写成功回调  
6.	    uv__write_callbacks(stream);
7.	    // 待写队列空，注销等待可写事件，即不需要写了  
8.	    if (QUEUE_EMPTY(&stream->write_queue))  
9.	      uv__drain(stream);  
10.	}  
```

我们只关注uv__write_callbacks。

```cpp
1.	static void uv__write_callbacks(uv_stream_t* stream) {  
2.	  uv_write_t* req;  
3.	  QUEUE* q;  
4.	  // 写完成队列非空  
5.	  while (!QUEUE_EMPTY(&stream->write_completed_queue)) {  
6.	    q = QUEUE_HEAD(&stream->write_completed_queue);  
7.	    req = QUEUE_DATA(q, uv_write_t, queue);  
8.	    QUEUE_REMOVE(q);  
9.	    uv__req_unregister(stream->loop, req);  
10.	    // bufs的内存还没有被释放  
11.	    if (req->bufs != NULL) {  
12.	      // 更新待写队列的大小，即减去req对应的所有数据的大小  
13.	      stream->write_queue_size -= uv__write_req_size(req);  
14.	      /*
15.	             bufs默认指向bufsml，超过默认大小时，
16.	              bufs指向新申请的堆内存，所以需要释放 
17.	             */ 
18.	      if (req->bufs != req->bufsml)  
19.	        uv__free(req->bufs);  
20.	      req->bufs = NULL;  
21.	    }  
22.	    // 执行回调  
23.	    if (req->cb)  
24.	      req->cb(req, req->error);  
25.	  }    
26.	}
```

uv__write_callbacks负责更新流的待写队列大小、释放额外申请的堆内存、执行每个写请求的回调。
## 5.5 关闭流的写端

```cpp
1.	// 关闭流的写端  
2.	int uv_shutdown(uv_shutdown_t* req, 
3.	                 uv_stream_t* stream, 
4.	                 uv_shutdown_cb cb) {    
5.	  // 初始化一个关闭请求，关联的handle是stream  
6.	  uv__req_init(stream->loop, req, UV_SHUTDOWN);  
7.	  req->handle = stream;  
8.	  // 关闭后执行的回调  
9.	  req->cb = cb;  
10.	  stream->shutdown_req = req;  
11.	  // 设置正在关闭的标记  
12.	  stream->flags |= UV_HANDLE_SHUTTING;  
13.	  // 注册等待可写事件  
14.	  uv__io_start(stream->loop, &stream->io_watcher, POLLOUT);  
15.	  return 0;  
16.	}  
```

关闭流的写端就是相当于给流发送一个关闭请求，把请求挂载到流中，然后注册等待可写事件，在可写事件触发的时候就会执行关闭操作。在分析写流的章节中我们提到，可写事件触发的时候，会执行uv__drain注销等待可写事件，除此之外，uv__drain还做了一个事情，就是关闭流的写端。我们看看具体的逻辑。

```cpp
1.	static void uv__drain(uv_stream_t* stream) {  
2.	  uv_shutdown_t* req;  
3.	  int err;  
4.	  // 撤销等待可写事件，因为没有数据需要写入了  
5.	  uv__io_stop(stream->loop, &stream->io_watcher, POLLOUT);  
6.	  uv__stream_osx_interrupt_select(stream);  
7.	  
8.	  // 设置了关闭写端，但是还没有关闭，则执行关闭写端  
9.	  if ((stream->flags & UV_HANDLE_SHUTTING) &&  
10.	      !(stream->flags & UV_HANDLE_CLOSING) &&  
11.	      !(stream->flags & UV_HANDLE_SHUT)) {  
12.	    req = stream->shutdown_req;  
13.	    stream->shutdown_req = NULL;  
14.	    // 清除标记  
15.	    stream->flags &= ~UV_HANDLE_SHUTTING;  
16.	    uv__req_unregister(stream->loop, req);  
17.	  
18.	    err = 0;  
19.	    // 关闭写端  
20.	    if (shutdown(uv__stream_fd(stream), SHUT_WR))  
21.	      err = UV__ERR(errno);  
22.	    // 标记已关闭写端  
23.	    if (err == 0)  
24.	      stream->flags |= UV_HANDLE_SHUT;  
25.	    // 执行回调  
26.	    if (req->cb != NULL)  
27.	      req->cb(req, err);  
28.	  }  
29.	}  
```

通过调用shutdown关闭流的写端，比如TCP流发送完数据后可以关闭写端。但是仍然可以读。
## 5.6 关闭流

```cpp
1.	void uv__stream_close(uv_stream_t* handle) {  
2.	  unsigned int i;  
3.	  uv__stream_queued_fds_t* queued_fds;  
4.	  // 从事件循环中删除IO观察者，移出pending队列  
5.	  uv__io_close(handle->loop, &handle->io_watcher);  
6.	  // 停止读  
7.	  uv_read_stop(handle);  
8.	  // 停掉handle  
9.	  uv__handle_stop(handle);  
10.	  // 不可读、写  
11.	  handle->flags &= ~(UV_HANDLE_READABLE | UV_HANDLE_WRITABLE);  
12.	  // 关闭非标准流的文件描述符  
13.	  if (handle->io_watcher.fd != -1) {  
14.	    /* 
15.	          Don't close stdio file descriptors.  
16.	          Nothing good comes from it. 
17.	         */  
18.	    if (handle->io_watcher.fd > STDERR_FILENO)  
19.	      uv__close(handle->io_watcher.fd);  
20.	    handle->io_watcher.fd = -1;  
21.	  }  
22.	  // 关闭通信socket对应的文件描述符  
23.	  if (handle->accepted_fd != -1) {  
24.	    uv__close(handle->accepted_fd);  
25.	    handle->accepted_fd = -1;  
26.	  }  
27.	  // 同上，这是在排队等待处理的文件描述符  
28.	  if (handle->queued_fds != NULL) {  
29.	    queued_fds = handle->queued_fds;  
30.	    for (i = 0; i < queued_fds->offset; i++)  
31.	      uv__close(queued_fds->fds[i]);  
32.	    uv__free(handle->queued_fds);  
33.	    handle->queued_fds = NULL;  
34.	  }  
35.	}  
```

关闭流就是把流注册在epoll的事件注销，关闭所持有的文件描述符。
## 5.7 连接流
连接流是针对TCP和Unix域的，所以我们首先介绍一下一些网络编程相关的内容，首先我们先要有一个socket。我们看Libuv中如何新建一个socket。

```cpp
1.	int uv__socket(int domain, int type, int protocol) {  
2.	  int sockfd;  
3.	  int err;  
4.	  // 新建一个socket，并设置非阻塞和LOEXEC标记  
5.	  sockfd = socket(domain, type | SOCK_NONBLOCK | SOCK_CLOEXEC, protocol);  
6.	  // 不触发SIGPIPE信号，比如对端已经关闭，本端又执行写  
7.	#if defined(SO_NOSIGPIPE)  
8.	  {  
9.	    int on = 1;  
10.	    setsockopt(sockfd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));  
11.	  }  
12.	#endif  
13.	  
14.	  return sockfd;  
15.	}  
```

在Libuv中，socket的模式都是非阻塞的，uv__socket是Libuv中申请socket的函数，不过Libuv不直接调用该函数，而是封装了一下。

```cpp
1.	/* 
2.	  1 获取一个新的socket fd 
3.	  2 把fd保存到handle里，并根据flag进行相关设置 
4.	  3 绑定到本机随意的地址（如果设置了该标记的话） 
5.	*/  
6.	static int new_socket(uv_tcp_t* handle, 
7.	                        int domain, 
8.	                        unsigned long flags) {  
9.	  struct sockaddr_storage saddr;  
10.	  socklen_t slen;  
11.	  int sockfd;   
12.	  // 获取一个socket  
13.	  sockfd = uv__socket(domain, SOCK_STREAM, 0); 
14.	  
15.	  // 设置选项和保存socket的文件描述符到IO观察者中  
16.	  uv__stream_open((uv_stream_t*) handle, sockfd, flags);  
17.	  // 设置了需要绑定标记UV_HANDLE_BOUND      
18.	  if (flags & UV_HANDLE_BOUND) {  
19.	    slen = sizeof(saddr);  
20.	    memset(&saddr, 0, sizeof(saddr));  
21.	    // 获取fd对应的socket信息，比如IP，端口，可能没有  
22.	    getsockname(uv__stream_fd(handle), 
23.	                    (struct sockaddr*) &saddr, 
24.	                    &slen);
25.	 
26.	    // 绑定到socket中，如果没有则绑定到系统随机选择的地址  
27.	    bind(uv__stream_fd(handle),(struct sockaddr*) &saddr, slen);
28.	 }  
29.	  
30.	  return 0;  
31.	}  
```

上面的代码就是在Libuv申请一个socket的逻辑，另外它还支持新建的socket，可以绑定到一个用户设置的，或者操作系统随机选择的地址。不过Libuv并不直接使用这个函数。而是又封装了一层。

```cpp
1.	// 如果流还没有对应的fd，则申请一个新的，如果有则修改流的配置  
2.	static int maybe_new_socket(uv_tcp_t* handle, 
3.	                              int domain, 
4.	                              unsigned long flags) {  
5.	  struct sockaddr_storage saddr;  
6.	  socklen_t slen;  
7.	  
8.	  // 已经有fd了  
9.	  if (uv__stream_fd(handle) != -1) {  
10.	    // 该流需要绑定到一个地址  
11.	    if (flags & UV_HANDLE_BOUND) {  
12.	      /* 
13.	        流是否已经绑定到一个地址了。handle的flag是在
14.	              new_socket里设置的，如果有这个标记说明已经执行过绑定了，
15.	              直接更新flags就行。 
16.	      */  
17.	      if (handle->flags & UV_HANDLE_BOUND) {  
18.	        handle->flags |= flags;  
19.	        return 0;  
20.	      }  
21.	      // 有fd，但是可能还没绑定到一个地址  
22.	      slen = sizeof(saddr);  
23.	      memset(&saddr, 0, sizeof(saddr));  
24.	      // 获取socket绑定到的地址  
25.	      if (getsockname(uv__stream_fd(handle), 
26.	                             (struct sockaddr*) &saddr, 
27.	                             &slen))  
28.	        return UV__ERR(errno);  
29.	      // 绑定过了socket地址，则更新flags就行  
30.	      if ((saddr.ss_family == AF_INET6 &&  
31.	        ((struct sockaddr_in6*) &saddr)->sin6_port != 0) ||
32.	        (saddr.ss_family == AF_INET &&  
33.	        ((struct sockaddr_in*) &saddr)->sin_port != 0)) { 
34.	        handle->flags |= flags;  
35.	        return 0;  
36.	      }  
37.	      // 没绑定则绑定到随机地址，bind中实现  
38.	      if (bind(uv__stream_fd(handle), 
39.	                      (struct sockaddr*) &saddr, 
40.	                      slen))  
41.	        return UV__ERR(errno);  
42.	    }  
43.	  
44.	    handle->flags |= flags;  
45.	    return 0;  
46.	  }  
47.	  // 申请一个新的fd关联到流  
48.	  return new_socket(handle, domain, flags);  
49.	}  
```

maybe_new_socket函数的逻辑分支很多，主要如下
1 如果流还没有关联到fd，则申请一个新的fd关联到流上
2 如果流已经关联了一个fd。
&nbsp;&nbsp;&nbsp;&nbsp;如果流设置了绑定地址的标记，但是已经通过Libuv绑定了一个地址（Libuv会设置UV_HANDLE_BOUND标记，用户也可能是直接调bind函数绑定了）。则不需要再次绑定，更新flags就行。
&nbsp;&nbsp;&nbsp;&nbsp;如果流设置了绑定地址的标记，但是还没有通过Libuv绑定一个地址，这时候通过getsocketname判断用户是否自己通过bind函数绑定了一个地址，是的话则不需要再次执行绑定操作。否则随机绑定到一个地址。

以上两个函数的逻辑主要是申请一个socket和给socket绑定一个地址。下面我们开看一下连接流的实现。

```cpp
1.	int uv__tcp_connect(uv_connect_t* req,  
2.	           uv_tcp_t* handle,  
3.	           const struct sockaddr* addr,  
4.	           unsigned int addrlen,  
5.	           uv_connect_cb cb) {  
6.	  int err;  
7.	  int r;  
8.	  
9.	  // 已经发起了connect了  
10.	  if (handle->connect_req != NULL)  
11.	    return UV_EALREADY;    
12.	  // 申请一个socket和绑定一个地址，如果还没有的话  
13.	  err = maybe_new_socket(handle, addr->sa_family,  
14.	               UV_HANDLE_READABLE | UV_HANDLE_WRITABLE 
15.	    if (err)  
16.	    return err;  
17.	  handle->delayed_error = 0;  
18.	  
19.	  do {  
20.	    // 清除全局错误变量的值  
21.	    errno = 0;  
22.	    // 非阻塞发起三次握手  
23.	    r = connect(uv__stream_fd(handle), addr, addrlen);  
24.	  } while (r == -1 && errno == EINTR);  
25.	  
26.	  if (r == -1 && errno != 0) {  
27.	    // 三次握手还没有完成  
28.	    if (errno == EINPROGRESS)  
29.	      ; /* not an error */  
30.	    else if (errno == ECONNREFUSED)  
31.	      // 对方拒绝建立连接，延迟报错  
32.	      handle->delayed_error = UV__ERR(errno);  
33.	    else  
34.	      // 直接报错  
35.	      return UV__ERR(errno);  
36.	  }  
37.	  // 初始化一个连接型request，并设置某些字段  
38.	  uv__req_init(handle->loop, req, UV_CONNECT);  
39.	  req->cb = cb;  
40.	  req->handle = (uv_stream_t*) handle;  
41.	  QUEUE_INIT(&req->queue);
42.	    // 连接请求  
43.	  handle->connect_req = req;  
44.	  // 注册到Libuv观察者队列  
45.	  uv__io_start(handle->loop, &handle->io_watcher, POLLOUT);  
46.	  // 连接出错，插入pending队尾  
47.	  if (handle->delayed_error)  
48.	    uv__io_feed(handle->loop, &handle->io_watcher);  
49.	  
50.	  return 0;  
51.	}  
```

连接流的逻辑，大致如下
1 申请一个socket，绑定一个地址。
2 根据给定的服务器地址，发起三次握手，非阻塞的，会直接返回继续执行，不会等到三次握手完成。
3 往流上挂载一个connect型的请求。
4 设置IO观察者感兴趣的事件为可写。然后把IO观察者插入事件循环的IO观察者队列。等待可写的时候时候（完成三次握手），就会执行cb回调。

可写事件触发时，会执行uv__stream_io，我们看一下具体的逻辑。

```cpp
1.	if (stream->connect_req) {  
2.	    uv__stream_connect(stream);  
3.	    return;  
4.	}  
```

我们继续看uv__stream_connect。

```cpp
1.	static void uv__stream_connect(uv_stream_t* stream) {  
2.	  int error;  
3.	  uv_connect_t* req = stream->connect_req;  
4.	  socklen_t errorsize = sizeof(int);  
5.	  // 连接出错  
6.	  if (stream->delayed_error) {  
7.	    error = stream->delayed_error;  
8.	    stream->delayed_error = 0;  
9.	  } else {  
10.	    // 还是需要判断一下是不是出错了  
11.	    getsockopt(uv__stream_fd(stream),  
12.	               SOL_SOCKET,  
13.	               SO_ERROR,  
14.	               &error,  
15.	               &errorsize);  
16.	    error = UV__ERR(error);  
17.	  }  
18.	  // 还没连接成功，先返回，等待下次可写事件的触发  
19.	  if (error == UV__ERR(EINPROGRESS))  
20.	    return;  
21.	  // 清空  
22.	  stream->connect_req = NULL;  
23.	  uv__req_unregister(stream->loop, req);  
24.	  /* 
25.	   连接出错则注销之前注册的等待可写队列， 
26.	   连接成功如果待写队列为空，也注销事件，有数据需要写的时候再注册 
27.	  */  
28.	  if (error < 0 || QUEUE_EMPTY(&stream->write_queue)) {  
29.	    uv__io_stop(stream->loop, &stream->io_watcher, POLLOUT);  
30.	  }  
31.	  // 执行回调，通知上层连接结果  
32.	  if (req->cb)  
33.	    req->cb(req, error);  
34.	  
35.	  if (uv__stream_fd(stream) == -1)  
36.	    return;  
37.	  // 连接失败，清空待写的数据和执行写请求的回调（如果有的话）  
38.	  if (error < 0) {  
39.	    uv__stream_flush_write_queue(stream, UV_ECANCELED);  
40.	    uv__write_callbacks(stream);  
41.	  }  
42.	}  
```

连接流的逻辑是
1发起非阻塞式连接
2 注册等待可写事件
3 可写事件触发时，把连接结果告诉调用方
4 连接成功则发送写队列的数据，连接失败则清除写队列的数据并执行每个写请求的回调（有的话）。
## 5.8 监听流
监听流是针对TCP或Unix域的，主要是把一个socket变成listen状态。并且设置一些属性。

```cpp
1.	int uv_tcp_listen(uv_tcp_t* tcp, int backlog, uv_connection_cb cb) {  
2.	  static int single_accept = -1;  
3.	  unsigned long flags;  
4.	  int err;  
5.	  
6.	  if (tcp->delayed_error)  
7.	    return tcp->delayed_error;  
8.	  // 是否设置了不连续accept。默认是连续accept。  
9.	  if (single_accept == -1) {  
10.	    const char* val = getenv("UV_TCP_SINGLE_ACCEPT");  
11.	    single_accept = (val != NULL && atoi(val) != 0);  
12.	  }  
13.	  // 设置不连续accept  
14.	  if (single_accept)  
15.	    tcp->flags |= UV_HANDLE_TCP_SINGLE_ACCEPT;  
16.	  
17.	  flags = 0;  
18.	  /* 
19.	    可能还没有用于listen的fd，socket地址等。 
20.	    这里申请一个socket和绑定到一个地址
21.	       （如果调listen之前没有调bind则绑定到随机地址） 
22.	  */  
23.	  err = maybe_new_socket(tcp, AF_INET, flags);  
24.	  if (err)  
25.	    return err;  
26.	  // 设置fd为listen状态  
27.	  if (listen(tcp->io_watcher.fd, backlog))  
28.	    return UV__ERR(errno);  
29.	  // 建立连接后的业务回调  
30.	  tcp->connection_cb = cb;  
31.	  tcp->flags |= UV_HANDLE_BOUND;  
32.	  //  设置io观察者的回调，由epoll监听到连接到来时执行  
33.	  tcp->io_watcher.cb = uv__server_io;  
34.	  /*
35.	      插入观察者队列，这时候还没有增加到epoll，
36.	      Poll IO阶段再遍历观察者队列进行处理（epoll_ctl）
37.	    */  
38.	  uv__io_start(tcp->loop, &tcp->io_watcher, POLLIN);  
39.	  
40.	  return 0;  
41.	}  
```

监听流的逻辑看起来很多，但是主要的逻辑是把流对的fd改成listen状态，这样流就可以接收连接请求了。接着设置连接到来时执行的回调。最后注册IO观察者到事件循环。等待连接到来。就会执行uv__server_io。uv__server_io再执行connection_cb。监听流和其它流有一个区别是，当IO观察者的事件触发时，监听流执行的回调是uv__server_io函数。而其它流是在uv__stream_io里统一处理。我们看一下连接到来或者Unix域上有数据到来时的处理逻辑。  

```cpp
1.	void uv__server_io(uv_loop_t* loop, uv__io_t* w, unsigned int events) {  
2.	  uv_stream_t* stream;  
3.	  int err;  
4.	  stream = container_of(w, uv_stream_t, io_watcher);   
5.	  // 注册等待可读事件  
6.	  uv__io_start(stream->loop, &stream->io_watcher, POLLIN);  
7.	  while (uv__stream_fd(stream) != -1) {  
8.	    /*
9.	          通过accept拿到和客户端通信的fd，我们看到这个
10.	          fd和服务器的fd是不一样的 
11.	        */ 
12.	    err = uv__accept(uv__stream_fd(stream));
13.	        // 错误处理 
14.	    if (err < 0) { 
15.	            /* 
16.	               uv__stream_fd(stream)对应的fd是非阻塞的，
17.	               返回这个错说明没有连接可用accept了，直接返回
18.	            */  
19.	      if (err == -EAGAIN || err == -EWOULDBLOCK)  
20.	        return;  /* Not an error. */  
21.	      if (err == -ECONNABORTED)  
22.	        continue;  
23.	            // 进程的打开的文件描述符个数达到阈值，看是否有备用的
24.	      if (err == -EMFILE || err == -ENFILE) {  
25.	        err = uv__emfile_trick(loop, uv__stream_fd(stream));
26.	        if (err == -EAGAIN || err == -EWOULDBLOCK)  
27.	          break;  
28.	      }  
29.	      // 发生错误，执行回调  
30.	      stream->connection_cb(stream, err);  
31.	      continue;  
32.	    }   
33.	    // 记录拿到的通信socket对应的fd  
34.	    stream->accepted_fd = err;  
35.	    // 执行上传回调  
36.	    stream->connection_cb(stream, 0);  
37.	    /*
38.	          stream->accepted_fd为-1说明在回调connection_cb里已经消费
39.	          了 accepted_fd，否则先注销服务器在epoll中的fd的读事件，等
40.	          待消费后再注册，即不再处理请求了        
41.	        */  
42.	    if (stream->accepted_fd != -1) {  
43.	      /* 
44.	              The user hasn't yet accepted called uv_accept() 
45.	            */  
46.	      uv__io_stop(loop, &stream->io_watcher, POLLIN);  
47.	      return;  
48.	    }  
49.	    /* 
50.	      是TCP类型的流并且设置每次只accpet一个连接，则定时阻塞，
51.	          被唤醒后再accept，否则一直accept（如果用户在connect回
52.	          调里消费了accept_fd的话），定时阻塞用于多进程竞争处理连接 
53.	    */  
54.	    if (stream->type == UV_TCP && 
55.	             (stream->flags & UV_TCP_SINGLE_ACCEPT)) { 
56.	      struct timespec timeout = { 0, 1 };  
57.	      nanosleep(&timeout, NULL);  
58.	    }  
59.	  }  
60.	}  
```

我们看到连接到来时，Libuv会从已完成连接的队列中摘下一个节点，然后执行connection_cb回调。在connection_cb回调里，需要uv_accept消费accpet_fd。

```cpp
1.	int uv_accept(uv_stream_t* server, uv_stream_t* client) {  
2.	  int err;  
3.	  switch (client->type) {  
4.	    case UV_NAMED_PIPE:  
5.	    case UV_TCP:  
6.	      // 把文件描述符保存到client  
7.	      err = uv__stream_open(client,
8.	                                    server->accepted_fd,
9.	                                    UV_STREAM_READABLE 
10.	                                    | UV_STREAM_WRITABLE);  
11.	      if (err) {  
12.	        uv__close(server->accepted_fd);  
13.	        goto done;  
14.	      }  
15.	      break;  
16.	  
17.	    case UV_UDP:  
18.	      err = uv_udp_open((uv_udp_t*) client, 
19.	                                server->accepted_fd);  
20.	      if (err) {  
21.	        uv__close(server->accepted_fd);  
22.	        goto done;  
23.	      }  
24.	      break; 
25.	    default:  
26.	      return -EINVAL;  
27.	  }  
28.	  client->flags |= UV_HANDLE_BOUND;  
29.	  
30.	done:  
31.	  // 非空则继续放一个到accpet_fd中等待accept,用于文件描述符传递  
32.	  if (server->queued_fds != NULL) {  
33.	    uv__stream_queued_fds_t* queued_fds;  
34.	    queued_fds = server->queued_fds;  
35.	    // 把第一个赋值到accept_fd  
36.	    server->accepted_fd = queued_fds->fds[0];  
37.	    /*
38.	         offset减去一个单位，如果没有了，则释放内存，
39.	          否则需要把后面的往前挪，offset执行最后一个
40.	        */  
41.	    if (--queued_fds->offset == 0) {  
42.	      uv__free(queued_fds);  
43.	      server->queued_fds = NULL;  
44.	    } else {   
45.	      memmove(queued_fds->fds,  
46.	              queued_fds->fds + 1,  
47.	              queued_fds->offset * sizeof(*queued_fds->fds));  
48.	    }  
49.	  } else {  
50.	    // 没有排队的fd了，则注册等待可读事件，等待accept新的fd  
51.	    server->accepted_fd = -1;  
52.	    if (err == 0)  
53.	      uv__io_start(server->loop, &server->io_watcher, POLLIN); 
54.	  }  
55.	  return err;  
56.	}  
```

client是用于和客户端进行通信的流，accept就是把accept_fd保存到client中，client就可以通过fd和对端进行通信了。消费完accept_fd后，如果还有待处理的fd的话，需要补充一个到accept_fd（针对Unix域），其它的继续排队等待处理，如果没有待处理的fd则注册等待可读事件，继续处理新的连接。
## 5.9 销毁流
当我们不再需要一个流的时候，我们会首先调用uv_close关闭这个流，关闭流只是注销了事件和释放了文件描述符，调用uv_close之后，流对应的结构体就会被加入到closing队列，在closing阶段的时候，才会执行销毁流的操作，比如丢弃还没有写完成的数据，执行对应流的回调，我们看看销毁流的函数uv__stream_destroy。

```cpp
1.	void uv__stream_destroy(uv_stream_t* stream) {  
2.	  // 正在连接，则执行回调  
3.	  if (stream->connect_req) {  
4.	    uv__req_unregister(stream->loop, stream->connect_req);  
5.	    stream->connect_req->cb(stream->connect_req, -ECANCELED);  
6.	    stream->connect_req = NULL;  
7.	  }  
8.	  // 丢弃待写的数据，如果有的话  
9.	  uv__stream_flush_write_queue(stream, -ECANCELED);  
10.	  // 处理写完成队列，这里是处理被丢弃的数据  
11.	  uv__write_callbacks(stream);  
12.	  // 正在关闭流，直接回调  
13.	  if (stream->shutdown_req) {  
14.	    uv__req_unregister(stream->loop, stream->shutdown_req);  
15.	    stream->shutdown_req->cb(stream->shutdown_req, -ECANCELED);  
16.	    stream->shutdown_req = NULL;  
17.	  }  
18.	}  
```

我们看到，销毁流的时候，如果流中还有待写的数据，则会丢弃。我们看一下uv__stream_flush_write_queue和uv__write_callbacks。

```cpp
1.	void uv__stream_flush_write_queue(uv_stream_t* stream, int error) {
2.	  uv_write_t* req;  
3.	  QUEUE* q;  
4.	  while (!QUEUE_EMPTY(&stream->write_queue)) {  
5.	    q = QUEUE_HEAD(&stream->write_queue);  
6.	    QUEUE_REMOVE(q); 
7.	    req = QUEUE_DATA(q, uv_write_t, queue);  
8.	    // 把错误写到每个请求中  
9.	    req->error = error; 
10.	    QUEUE_INSERT_TAIL(&stream->write_completed_queue, &req->queue);
11.	  }  
12.	}  
```

uv__stream_flush_write_queue丢弃待写队列中的请求，并直接插入写完成队列中。uv__write_callbacks是写完或者写出错时执行的函数，它逐个处理写完成队列中的节点，每个节点是一个写请求，执行它的回调，如何分配了堆内存，则释放内存。在写流章节已经分析，不再具体展开。
## 5.10 事件触发的处理
在流的实现中，读写等操作都只是注册事件到epoll，事件触发的时候，会执行统一的回调函数uv__stream_io。下面列一下该函数的代码，具体实现在其它章节已经分析。

```cpp
1.	static void uv__stream_io(uv_loop_t* loop, 
2.	                            uv__io_t* w, 
3.	                            unsigned int events) {  
4.	  uv_stream_t* stream;  
5.	  stream = container_of(w, uv_stream_t, io_watcher); 
6.	  // 是连接流，则执行连接处理函数  
7.	  if (stream->connect_req) {  
8.	    uv__stream_connect(stream);  
9.	    return;  
10.	  }    
11.	  /*
12.	      Ignore POLLHUP here. Even it it's set, 
13.	      there may still be data to read. 
14.	    */  
15.	  // 可读是触发，则执行读处理  
16.	  if (events & (POLLIN | POLLERR | POLLHUP))  
17.	    uv__read(stream);  
18.	  // 读回调关闭了流  
19.	  if (uv__stream_fd(stream) == -1)  
20.	    return;  /* read_cb closed stream. */  
21.	  /* ¬¬
22.	     POLLHUP说明对端关闭了，即不会发生数据过来了。
23.	          如果流的模式是持续读， 
24.	      1 如果只读取了部分（设置UV_STREAM_READ_PARTIAL），
25.	              并且没有读到结尾(没有设置UV_STREAM_READ_EOF)， 
26.	       则直接作读结束处理， 
27.	      2 如果只读取了部分，上面的读回调执行了读结束操作，
28.	              则这里就不需要处理了 
29.	      3 如果没有设置只读了部分，还没有执行读结束操作，
30.	              则不能作读结束操作，因为对端虽然关闭了，但是之
31.	              前的传过来的数据可能还没有被消费完 
32.	      4 如果没有设置只读了部分，执行了读结束操作，那这
33.	              里也不需要处理 
34.	  */  
35.	  if ((events & POLLHUP) &&  
36.	      (stream->flags & UV_STREAM_READING) &&  
37.	      (stream->flags & UV_STREAM_READ_PARTIAL) &&  
38.	      !(stream->flags & UV_STREAM_READ_EOF)) {  
39.	    uv_buf_t buf = { NULL, 0 };  
40.	    uv__stream_eof(stream, &buf);  
41.	  }  
42.	  
43.	  if (uv__stream_fd(stream) == -1)  
44.	    return;  /* read_cb closed stream. */  
45.	  // 可写事件触发  
46.	  if (events & (POLLOUT | POLLERR | POLLHUP)) {  
47.	    // 写数据  
48.	    uv__write(stream);  
49.	    // 写完后做后置处理，释放内存，执行回调等  
50.	    uv__write_callbacks(stream); 
51.	    // 待写队列为空，则注销等待写事件  
52.	    if (QUEUE_EMPTY(&stream->write_queue))  
53.	      uv__drain(stream);  
54.	  }  
55.	}  
```
