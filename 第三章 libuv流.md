第三章 libuv流

流的实现在libuv里占了很大篇幅。首先看数据结构。流在libuv里用uv_stream_s表示，他属于handle族。继承于uv_handle_s。

```c
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
16.	  // 用于插入事件循环的closing阶段对应的队列  
17.	  uv_handle_t* next_closing;   
18.	  // 各种标记   
19.	  unsigned int flags;  
20.	  // 流拓展的字段  
21.	  // 用户写入流的字节大小，流缓存用户的输入，然后等到可写的时候才做真正的写  
22.	  size_t write_queue_size;   
23.	  // 分配内存的函数，内存由用户定义，主要用来保存读取的数据                 
24.	  uv_alloc_cb alloc_cb;    
25.	  // 读取数据的回调                   
26.	  uv_read_cb read_cb;   
27.	  // 连接成功后，执行connect_req的回调（connect_req在uv__xxx_connect中赋值）  
28.	  uv_connect_t *connect_req;   
29.	  /*
30.	    关闭写端的时候，发送完缓存的数据，
31.	    执行shutdown_req的回调（shutdown_req在uv_shutdown的时候赋值） 
32.	  */     
33.	  uv_shutdown_t *shutdown_req;  
34.	  // 流对应的io观察者，即文件描述符+一个文件描述符事件触发时执行的回调     
35.	  uv__io_t io_watcher;    
36.	  // 流缓存下来的，待写的数据           
37.	  void* write_queue[2];         
38.	  // 已经完成了数据写入的队列     
39.	  void* write_completed_queue[2];  
40.	  // 完成三次握手后，执行的回调  
41.	  uv_connection_cb connection_cb;  
42.	  // 操作流时出错码  
43.	  int delayed_error;    
44.	  // accept返回的通信socket对应的文件描述符             
45.	  int accepted_fd;      
46.	  // 同上，用于缓存更多的通信socket对应的文件描述符             
47.	  void* queued_fds;  
48.	}  
```

流的实现中，最核心的字段是io观察者，其余的字段是和流的性质相关的。io观察者封装了流对应的文件描述符和文件描述符事件触发时的回调。比如读一个流，写一个流，关闭一个流，连接一个流，监听一个流，在uv_stream_s中都有对应的字段去支持。但是本质上是靠io观察者去驱动的。
1 读一个流，就是io观察者中的文件描述符的可读事件触发时，执行用户的读回调。
2 写一个流，先把数据写到流中，等到io观察者中的文件描述符可写事件触发时，执行真正的写入，并执行用户的写完成回调。
3 关闭一个流，就是io观察者中的文件描述符可写事件触发时，就会执行关闭流的写端。如果流中还有数据没有写完，则先写完（比如发送）后再执行关闭操作，接着执行用户的回调。
4 连接流，比如作为客户端去连接服务器。就是io观察者中的文件描述符。可读事件触发时（建立三次握手成功），执行用户的回调。
5 监听流，就是io观察者中的文件描述符。可读事件触发时（有完成三次握手的连接），执行用户的回调。
### 3.1.1 初始化流
我们看一下如何初始化一个流。

```c
1.	void uv__stream_init(uv_loop_t* loop,  
2.	                     uv_stream_t* stream,  
3.	                     uv_handle_type type) {  
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
20.	     初始化io观察者，把文件描述符（这里还没有，所以是-1）和
21.	     回调uv__stream_io记录在io_watcher上  
22.	  */
23.	  uv__io_init(&stream->io_watcher, uv__stream_io, -1);  
24.	}  
```

### 3.1.2 打开流 

```c
25.	// 关闭nagle，开启长连接，保存fd   
26.	int uv__stream_open(uv_stream_t* stream, int fd, int flags) {  
27.	  
28.	  // 还没有设置fd或者设置的同一个fd则继续，否则返回busy  
29.	  if (!(stream->io_watcher.fd == -1 || stream->io_watcher.fd == fd))  
30.	    return UV_EBUSY;  
31.	  
32.	  // 设置流的标记  
33.	  stream->flags |= flags;  
34.	  
35.	  // 是tcp流则可以设置下面的属性
36.	  if (stream->type == UV_TCP) {  
37.	    // 关闭nagle算法  
38.	    if ((stream->flags & UV_HANDLE_TCP_NODELAY) && uv__tcp_nodelay(fd, 1))  
39.	      return UV__ERR(errno);  
40.	  
41.	    // 开启SO_KEEPALIVE，使用tcp长连接，一定时间后没有收到数据包会发送心跳包  
42.	    if ((stream->flags & UV_HANDLE_TCP_KEEPALIVE) &&  
43.	        uv__tcp_keepalive(fd, 1, 60)) {  
44.	      return UV__ERR(errno);  
45.	    }  
46.	  }  
47.	   // 保存socket对应的文件描述符到io观察者中，libuv会在io poll阶段监听该文件描述符  
48.	  stream->io_watcher.fd = fd;  
49.	  
50.	  return 0;  
51.	}  
```

打开一个流，本质上就是给这个流关联一个文件描述符。还有一些属性的设置。有了文件描述符，后续就可以操作这个流了。
### 3.1.3 读流
我们在一个流上执行uv_read_start。流的数据（如果有的话）就会源源不断地流向调用方。

```c
1.	int uv_read_start(uv_stream_t* stream,  
2.	                  uv_alloc_cb alloc_cb,  
3.	                  uv_read_cb read_cb) {  
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

执行uv_read_start本质上是给流对应的文件描述符在epoll中注册了一个等待可读事件。并且给一些字段赋值，比如读回调函数，分配内存的函数。打上正在做读取操作的标记。然后在可读事件触发的时候，读回调就会被执行，除了开始读取数据，还有一个读操作就是停止读取。对应的函数是uv_read_stop。

```c
1.	int uv_read_stop(uv_stream_t* stream) {  
2.	  // 是否正在执行读取操作，如果不是，则没有必要停止  
3.	  if (!(stream->flags & UV_HANDLE_READING))  
4.	    return 0;  
5.	  // 清除 正在读取 的标记  
6.	  stream->flags &= ~UV_HANDLE_READING;  
7.	  // 撤销 等待读事件  
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

```c
1.	int uv_is_readable(const uv_stream_t* stream) {  
2.	  return !!(stream->flags & UV_HANDLE_READABLE);  
3.	}  
```

上面的函数只是注册和注销读事件，我们看一下真正的读逻辑

```c
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
12.	  // 是unix域类型并且用于rpc，unix域不一定用于rpc，可用作为客户端，服务器  
13.	  is_ipc = stream->type == UV_NAMED_PIPE && ((uv_pipe_t*) stream)->ipc;  
14.	  // 设置了读回调，正在读，count大于0  
15.	  while (stream->read_cb  
16.	      && (stream->flags & UV_STREAM_READING)  
17.	      && (count-- > 0)) {  
18.	    buf = uv_buf_init(NULL, 0);  
19.	    // 调用调用方提供的分配内存函数，分配内存承载数据  
20.	    stream->alloc_cb((uv_handle_t*)stream, 64 * 1024, &buf);  
21.	    // 分配失败，执行读回调  
22.	    if (buf.base == NULL || buf.len == 0) {  
23.	      stream->read_cb(stream, UV_ENOBUFS, &buf);  
24.	      return;  
25.	    }  
26.	    // 不是rpc则直接读取数据到buf，否则用recvmsg读取传递的文件描述符  
27.	    if (!is_ipc) {  
28.	      do {  
29.	        nread = read(uv__stream_fd(stream), buf.base, buf.len);  
30.	      }  
31.	      while (nread < 0 && errno == EINTR);  
32.	    } else {  
33.	      /* ipc uses recvmsg */  
34.	      msg.msg_flags = 0;  
35.	      msg.msg_iov = (struct iovec*) &buf;  
36.	      msg.msg_iovlen = 1;  
37.	      msg.msg_name = NULL;  
38.	      msg.msg_namelen = 0;  
39.	      /* Set up to receive a descriptor even if one isn't in the message */  
40.	      msg.msg_controllen = sizeof(cmsg_space);  
41.	      msg.msg_control = cmsg_space;  
42.	  
43.	      do {  
44.	        nread = uv__recvmsg(uv__stream_fd(stream), &msg, 0);  
45.	      }  
46.	      while (nread < 0 && errno == EINTR);  
47.	    }  
48.	    // 读失败  
49.	    if (nread < 0) {  
50.	      /* Error */  
51.	      // 读繁忙  
52.	      if (errno == EAGAIN || errno == EWOULDBLOCK) {  
53.	        /* Wait for the next one. */  
54.	        // 设置了流式读取，则注册等待可读事件，等待可读事件触发继续读  
55.	        if (stream->flags & UV_STREAM_READING) {  
56.	          uv__io_start(stream->loop, &stream->io_watcher, POLLIN);  
57.	          uv__stream_osx_interrupt_select(stream);  
58.	        }  
59.	        // 执行读回调  
60.	        stream->read_cb(stream, 0, &buf);  
61.	      } else {  
62.	        /* Error. User should call uv_close(). */  
63.	        // 读失败  
64.	        stream->read_cb(stream, -errno, &buf);  
65.	        // 设置了流式读，则清除  
66.	        if (stream->flags & UV_STREAM_READING) {  
67.	          stream->flags &= ~UV_STREAM_READING;  
68.	          // 注销等待读事件  
69.	          uv__io_stop(stream->loop, &stream->io_watcher, POLLIN);  
70.	          // 也没有注册等待写事件，则停掉handle  
71.	          if (!uv__io_active(&stream->io_watcher, POLLOUT))  
72.	            uv__handle_stop(stream);  
73.	          uv__stream_osx_interrupt_select(stream);  
74.	        }  
75.	      }  
76.	      return;  
77.	    } else if (nread == 0) {  
78.	      // 读到结尾了  
79.	      uv__stream_eof(stream, &buf);  
80.	      return;  
81.	    } else {  
82.	      /* Successful read */  
83.	      // 读成功，读取数据的长度  
84.	      ssize_t buflen = buf.len;  
85.	      // 是rpc则解析读取的数据，把文件描述符解析出来，放到stream里  
86.	      if (is_ipc) {  
87.	        err = uv__stream_recv_cmsg(stream, &msg);  
88.	        if (err != 0) {  
89.	          stream->read_cb(stream, err, &buf);  
90.	          return;  
91.	        }  
92.	      }  
93.	      // 执行读回调  
94.	      stream->read_cb(stream, nread, &buf);  
95.	      /* 
96.	        还没有填满buf，并且没读到结尾，说明还有数据可读， 
97.	        如果填满了buf，还没有读完结尾，则继续循环分配新的内存，接着读，设置只读了部分标记 
98.	      */  
99.	      if (nread < buflen) {  
100.	        stream->flags |= UV_STREAM_READ_PARTIAL;  
101.	        return;  
102.	      }  
103.	    }  
104.	  }  
105.	}  
```

最后我们看一下读结束后的处理，

```c
1.	static void uv__stream_eof(uv_stream_t* stream, const uv_buf_t* buf) {  
2.	  // 打上读结束标记  
3.	  stream->flags |= UV_STREAM_READ_EOF;  
4.	  // 注销等待可读事件  
5.	  uv__io_stop(stream->loop, &stream->io_watcher, POLLIN);  
6.	  // 没有注册等待可写事件则停掉handle，否则会影响事件循环的退出  
7.	  if (!uv__io_active(&stream->io_watcher, POLLOUT))  
8.	    uv__handle_stop(stream);  
9.	  uv__stream_osx_interrupt_select(stream);  
10.	  // 执行读回调  
11.	  stream->read_cb(stream, UV_EOF, buf);  
12.	  // 清除正在读标记   
13.	  stream->flags &= ~UV_STREAM_READING;  
14.	}  
```

### 3.1.4 写流
我们在流上执行uv_write就可以往流中写入数据。

```c
1.	int uv_write(  
2.	       // 一个写请求，记录了需要写入的数据和信息。数据来自下面的const uv_buf_t bufs[]  
3.	         uv_write_t* req,  
4.	         // 往哪个流写  
5.	       uv_stream_t* handle,  
6.	       // 需要写入的数据  
7.	       const uv_buf_t bufs[],  
8.	       // uv_buf_t个数  
9.	       unsigned int nbufs,  
10.	       // 写完后执行的回调  
11.	       uv_write_cb cb  
12.	) {  
13.	  return uv_write2(req, handle, bufs, nbufs, NULL, cb);  
14.	}
```

uv_write是直接调用uv_write2。第四个参数是NULL。代表是一般的写数据，不传递文件描述符。

```c
1.	int uv_write2(uv_write_t* req,  
2.	              uv_stream_t* stream,  
3.	              const uv_buf_t bufs[],  
4.	              unsigned int nbufs,  
5.	              uv_stream_t* send_handle,  
6.	              uv_write_cb cb) {  
7.	  int empty_queue;  
8.	  if (uv__stream_fd(stream) < 0)  
9.	    return -EBADF;  
10.	  // 需要传递文件描述符  
11.	  if (send_handle) {  
12.	    // 流不是unix域类型或者是unix类型但是不是用于rpc，则不能传递文件描述符  
13.	    if (stream->type != UV_NAMED_PIPE || !((uv_pipe_t*)stream)->ipc)  
14.	      return -EINVAL;  
15.	    // 文件描述符无效，见uv__handle_fd了解哪些是有效的  
16.	    if (uv__handle_fd((uv_handle_t*) send_handle) < 0)  
17.	      return -EBADF;  
18.	  
19.	  }  
20.	  // 待发送独队列为空  
21.	  empty_queue = (stream->write_queue_size == 0);  
22.	  // 构造一个请求  
23.	  uv__req_init(stream->loop, req, UV_WRITE);  
24.	  req->cb = cb;  
25.	  req->handle = stream;  
26.	  req->error = 0;  
27.	  req->send_handle = send_handle;  
28.	  QUEUE_INIT(&req->queue);  
29.	  // bufs指向待写的数据  
30.	  req->bufs = req->bufsml;  
31.	  // 大于默认的，则扩容  
32.	  if (nbufs > ARRAY_SIZE(req->bufsml))  
33.	    req->bufs = uv__malloc(nbufs * sizeof(bufs[0]));  
34.	  if (req->bufs == NULL)  
35.	    return -ENOMEM;  
36.	  // 复制调用方的数据过来  
37.	  memcpy(req->bufs, bufs, nbufs * sizeof(bufs[0]));  
38.	  // buf个数  
39.	  req->nbufs = nbufs;  
40.	  // 当前写成功的buf索引，针对bufs数组  
41.	  req->write_index = 0;  
42.	  // 待写的数据大小 = 之前的大小 + 本次大小  
43.	  stream->write_queue_size += uv__count_bufs(bufs, nbufs);  
44.	  // 插入待写队列  
45.	  QUEUE_INSERT_TAIL(&stream->write_queue, &req->queue);  
46.	  // 非空说明正在连接，还不能写  
47.	  if (stream->connect_req) {  
48.	    /* Still connecting, do nothing. */  
49.	  }  
50.	  else if (empty_queue) { // 当前待写队列为空，直接写  
51.	    uv__write(stream);  
52.	  }  
53.	  else {  
54.	    // 还有数据没有写完，注册等待写事件，以防其他地方没有注册  
55.	    uv__io_start(stream->loop, &stream->io_watcher, POLLOUT);  
56.	    uv__stream_osx_interrupt_select(stream);  
57.	  }  
58.	  return 0;  
59.	}  
```

uv_write2的主要逻辑就是封装一个写请求，插入到流的待写队列。然后根据当前流的情况。看是直接写入还是等待会再写入。架构大致如下。    
<img src="https://img-blog.csdnimg.cn/20200901000205800.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center" />    

[架构图](https://img-blog.csdnimg.cn/20200901000205800.png)


真正执行写的函数是uv__write 

```c
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
11.	  
12.	  if (QUEUE_EMPTY(&stream->write_queue))  
13.	    return;  
14.	  
15.	  q = QUEUE_HEAD(&stream->write_queue);  
16.	  req = QUEUE_DATA(q, uv_write_t, queue);  
17.	  assert(req->handle == stream);  
18.	  // 从哪里开始写  
19.	  iov = (struct iovec*) &(req->bufs[req->write_index]);  
20.	  // 还有多少没写  
21.	  iovcnt = req->nbufs - req->write_index;  
22.	  // 最多可以写多少  
23.	  iovmax = uv__getiovmax();  
24.	  // 取最小值  
25.	  if (iovcnt > iovmax)  
26.	    iovcnt = iovmax;  
27.	  // 需要传递文件描述符  
28.	  if (req->send_handle) {  
29.	    int fd_to_send;  
30.	    struct msghdr msg;  
31.	    struct cmsghdr *cmsg;  
32.	    union {  
33.	      char data[64];  
34.	      struct cmsghdr alias;  
35.	    } scratch;  
36.	  
37.	    if (uv__is_closing(req->send_handle)) {  
38.	      err = -EBADF;  
39.	      goto error;  
40.	    }  
41.	    // 待发送的文件描述符  
42.	    fd_to_send = uv__handle_fd((uv_handle_t*) req->send_handle);  
43.	  
44.	    memset(&scratch, 0, sizeof(scratch));  
45.	  
46.	    msg.msg_name = NULL;  
47.	    msg.msg_namelen = 0;  
48.	    msg.msg_iov = iov;  
49.	    msg.msg_iovlen = iovcnt;  
50.	    msg.msg_flags = 0;  
51.	  
52.	    msg.msg_control = &scratch.alias;  
53.	    msg.msg_controllen = CMSG_SPACE(sizeof(fd_to_send));  
54.	  
55.	    cmsg = CMSG_FIRSTHDR(&msg);  
56.	    cmsg->cmsg_level = SOL_SOCKET;  
57.	    cmsg->cmsg_type = SCM_RIGHTS;  
58.	    cmsg->cmsg_len = CMSG_LEN(sizeof(fd_to_send));  
59.	  
60.	    {  
61.	      void* pv = CMSG_DATA(cmsg);  
62.	      int* pi = pv;  
63.	      *pi = fd_to_send;  
64.	    }  
65.	  
66.	    do {  
67.	      // 使用sendmsg函数发送文件描述符  
68.	      n = sendmsg(uv__stream_fd(stream), &msg, 0);  
69.	    }  
70.	    while (n == -1 && errno == EINTR);  
71.	  } else {  
72.	    do {  
73.	      // 写一个或者写批量写  
74.	      if (iovcnt == 1) {  
75.	        n = write(uv__stream_fd(stream), iov[0].iov_base, iov[0].iov_len);  
76.	      } else {  
77.	        n = writev(uv__stream_fd(stream), iov, iovcnt);  
78.	      }  
79.	    }  
80.	    while (n == -1 && errno == EINTR);  
81.	  }  
82.	  // 写失败  
83.	  if (n < 0) {  
84.	    // 不是写繁忙，则报错，否则如果设置了同步写标记，则继续尝试写  
85.	    if (errno != EAGAIN && errno != EWOULDBLOCK && errno != ENOBUFS) {  
86.	      err = -errno;  
87.	      goto error;  
88.	    } else if (stream->flags & UV_STREAM_BLOCKING) {  
89.	      /* If this is a blocking stream, try again. */  
90.	      goto start;  
91.	    }  
92.	  } else {  
93.	    /* Successful write */  
94.	    // 写成功  
95.	    while (n >= 0) {  
96.	      // 当前buf首地址  
97.	      uv_buf_t* buf = &(req->bufs[req->write_index]);  
98.	      // 当前buf的数据长度  
99.	      size_t len = buf->len;  
100.	      // 小于说明当前buf还没有写完（还没有被消费完）  
101.	      if ((size_t)n < len) {  
102.	        // 更新待写的首地址  
103.	        buf->base += n;  
104.	        // 更新待写的数据长度  
105.	        buf->len -= n;  
106.	        // 更新待写队列的长度，这个队列是待写数据的总长度，等于多个buf的和  
107.	        stream->write_queue_size -= n;  
108.	        n = 0;  
109.	        // 还没写完，设置了同步写，则继续尝试写，否则退出，注册待写事件  
110.	        if (stream->flags & UV_STREAM_BLOCKING) {  
111.	          goto start;  
112.	        } else {  
113.	          /* Break loop and ensure the watcher is pending. */  
114.	          break;  
115.	        }  
116.	  
117.	      } else {  
118.	        // 当前buf的数据都写完了，则更新待写数据的的首地址，即下一个buf，因为当前buf写完了  
119.	        req->write_index++;  
120.	        // 更新n，用于下一个循环的计算  
121.	        n -= len;  
122.	        // 更新待写队列的长度  
123.	        stream->write_queue_size -= len;  
124.	        // 等于最后一个buf了，说明待写队列的数据都写完了  
125.	        if (req->write_index == req->nbufs) { 
126.	          // 释放buf对应的内存，并把请求插入写完成队列，然后准备触发写完成回调  
127.	          uv__write_req_finish(req);  
128.	          return;  
129.	        }  
130.	      }  
131.	    }  
132.	  }  
133.	  // 写成功，但是还没有写完，注册待写事件，等待可写的时候继续写  
134.	  uv__io_start(stream->loop, &stream->io_watcher, POLLOUT);  
135.	  uv__stream_osx_interrupt_select(stream);  
136.	  
137.	  return;  
138.	// 写出错  
139.	error:  
140.	  // 记录错误  
141.	  req->error = err;  
142.	  // 释放内存，丢弃数据，插入写完成队列，把io观察者插入pending队列，等待pending阶段执行回调  
143.	  uv__write_req_finish(req);  
144.	  // 注销待写事件  
145.	  uv__io_stop(stream->loop, &stream->io_watcher, POLLOUT);  
146.	  // 如果也没有注册等待可读事件，则把handle关闭  
147.	  if (!uv__io_active(&stream->io_watcher, POLLIN))  
148.	    uv__handle_stop(stream);  
149.	  uv__stream_osx_interrupt_select(stream);  
150.	}  
```

我们看一下写请求结束后（成功或者失败），libuv如何处理他。逻辑在uv__write_req_finish函数。

```c
1.	static void uv__write_req_finish(uv_write_t* req) {  
2.	  uv_stream_t* stream = req->handle;  
3.	  QUEUE_REMOVE(&req->queue);  
4.	  if (req->error == 0) {  
5.	    if (req->bufs != req->bufsml)  
6.	      uv__free(req->bufs);  
7.	    req->bufs = NULL;  
8.	  }  
9.	  QUEUE_INSERT_TAIL(&stream->write_completed_queue, &req->queue);  
10.	  uv__io_feed(stream->loop, &stream->io_watcher);  
11.	}  
```

uv__write_req_finish的逻辑比较简单
1把节点从待写队列中移除
2 req->bufs != req->bufsml不相等说明分配了堆内存，需要自己释放
3并把请求插入写完成队列，把io观察者插入pending队列，等待pending阶段执行回调，在pending节点会知道io观察者的回调（uv__stream_io）。
### 3.1.5 关闭流的写端

```c
1.	// 关闭流的写端  
2.	int uv_shutdown(uv_shutdown_t* req, uv_stream_t* stream, uv_shutdown_cb cb) {  
3.	  // 流是可写的，并且还没关闭写端，也不是处于正在关闭状态  
4.	  if (!(stream->flags & UV_HANDLE_WRITABLE) ||  
5.	      stream->flags & UV_HANDLE_SHUT ||  
6.	      stream->flags & UV_HANDLE_SHUTTING ||  
7.	      uv__is_closing(stream)) {  
8.	    return UV_ENOTCONN;  
9.	  }  
10.	  
11.	  // 初始化一个关闭请求，关联的handle是stream  
12.	  uv__req_init(stream->loop, req, UV_SHUTDOWN);  
13.	  req->handle = stream;  
14.	  // 关闭后执行的回调  
15.	  req->cb = cb;  
16.	  stream->shutdown_req = req;  
17.	  // 设置正在关闭的标记  
18.	  stream->flags |= UV_HANDLE_SHUTTING;  
19.	  // 注册等待可写事件  
20.	  uv__io_start(stream->loop, &stream->io_watcher, POLLOUT);  
21.	  
22.	  return 0;  
23.	}  
```

关闭流的写端就是相当于给流发送一个关闭请求，把请求挂载到流中，然后注册等待可写事件，在可写事件触发的时候就会执行关闭操作。
### 3.1.6 关闭流

```c
1.	void uv__stream_close(uv_stream_t* handle) {  
2.	  unsigned int i;  
3.	  uv__stream_queued_fds_t* queued_fds;  
4.	  // 从事件循环中删除io观察者，移出pending队列  
5.	  uv__io_close(handle->loop, &handle->io_watcher);  
6.	  // 停止读  
7.	  uv_read_stop(handle);  
8.	  // 停掉handle  
9.	  uv__handle_stop(handle);  
10.	  // 不可读、写  
11.	  handle->flags &= ~(UV_HANDLE_READABLE | UV_HANDLE_WRITABLE);  
12.	  // 关闭非标准流的文件描述符  
13.	  if (handle->io_watcher.fd != -1) {  
14.	    /* Don't close stdio file descriptors.  Nothing good comes from it. */  
15.	    if (handle->io_watcher.fd > STDERR_FILENO)  
16.	      uv__close(handle->io_watcher.fd);  
17.	    handle->io_watcher.fd = -1;  
18.	  }  
19.	  // 关闭通信socket对应的文件描述符  
20.	  if (handle->accepted_fd != -1) {  
21.	    uv__close(handle->accepted_fd);  
22.	    handle->accepted_fd = -1;  
23.	  }  
24.	  // 同上，这是在排队等待处理的通信socket  
25.	  if (handle->queued_fds != NULL) {  
26.	    queued_fds = handle->queued_fds;  
27.	    for (i = 0; i < queued_fds->offset; i++)  
28.	      uv__close(queued_fds->fds[i]);  
29.	    uv__free(handle->queued_fds);  
30.	    handle->queued_fds = NULL;  
31.	  }  
32.	}  
```

### 3.1.7 连接流
连接流是针对tcp的，连接即建立三次握手。所以我们首先介绍一下一些网络编程相关的内容。想要发起三次握手，首先我们先要有一个socket。我们看libuv中如何新建一个socket。

```c
1.	/* 
2.	1 获取一个新的socket fd 
3.	2 把fd保存到handle里，并根据flag进行相关设置 
4.	3 绑定到本机随意的地址（如果设置了该标记的话） 
5.	*/  
6.	static int new_socket(uv_tcp_t* handle, int domain, unsigned long flags) {  
7.	  struct sockaddr_storage saddr;  
8.	  socklen_t slen;  
9.	  int sockfd;  
10.	  int err;  
11.	  // 获取一个socket  
12.	  err = uv__socket(domain, SOCK_STREAM, 0);  
13.	  if (err < 0)  
14.	    return err;  
15.	  // 申请的fd  
16.	  sockfd = err;  
17.	  // 设置选项和保存socket的文件描述符到io观察者中  
18.	  err = uv__stream_open((uv_stream_t*) handle, sockfd, flags);  
19.	  if (err) {  
20.	    uv__close(sockfd);  
21.	    return err;  
22.	  }  
23.	  // 设置了需要绑定标记UV_HANDLE_BOUND      
24.	  if (flags & UV_HANDLE_BOUND) {  
25.	    slen = sizeof(saddr);  
26.	    memset(&saddr, 0, sizeof(saddr));  
27.	    // 获取fd对应的socket信息，比如ip，端口，可能没有  
28.	    if (getsockname(uv__stream_fd(handle), (struct sockaddr*) &saddr, &slen)) {  
29.	      uv__close(sockfd);  
30.	      return UV__ERR(errno);  
31.	    }  
32.	    // 绑定到socket中，如果没有则绑定到系统随机选择的地址  
33.	    if (bind(uv__stream_fd(handle), (struct sockaddr*) &saddr, slen)) {  
34.	      uv__close(sockfd);  
35.	      return UV__ERR(errno);  
36.	    }  
37.	  }  
38.	  
39.	  return 0;  
40.	}  
```

上面的代码就是在libuv申请一个socket的逻辑，他还支持新建的socket，可以绑定到一个用户设置的，或者操作系统随机选择的地址。不过libuv并不直接使用这个函数。而是又封装了一层。

```c
1.	// 如果流还没有对应的fd，则申请一个新的，如果有则修改流的配置  
2.	static int maybe_new_socket(uv_tcp_t* handle, int domain, unsigned long flags) {  
3.	  struct sockaddr_storage saddr;  
4.	  socklen_t slen;  
5.	  
6.	  if (domain == AF_UNSPEC) {  
7.	    handle->flags |= flags;  
8.	    return 0;  
9.	  }  
10.	  // 已经有socket fd了  
11.	  if (uv__stream_fd(handle) != -1) {  
12.	    // 该流需要绑定到一个地址  
13.	    if (flags & UV_HANDLE_BOUND) {  
14.	      /* 
15.	          流是否已经绑定到一个地址了。handle的flag是在new_socket里设置的， 
16.	          如果有这个标记说明已经执行过绑定了，直接更新flags就行。 
17.	      */  
18.	      if (handle->flags & UV_HANDLE_BOUND) {  
19.	        handle->flags |= flags;  
20.	        return 0;  
21.	      }  
22.	      // 有socket fd，但是可能还没绑定到一个地址  
23.	      slen = sizeof(saddr);  
24.	      memset(&saddr, 0, sizeof(saddr));  
25.	      // 获取socket绑定到的地址  
26.	      if (getsockname(uv__stream_fd(handle), (struct sockaddr*) &saddr, &slen))  
27.	        return UV__ERR(errno);  
28.	      // 绑定过了socket地址，则更新flags就行  
29.	      if ((saddr.ss_family == AF_INET6 &&  
30.	          ((struct sockaddr_in6*) &saddr)->sin6_port != 0) ||  
31.	          (saddr.ss_family == AF_INET &&  
32.	          ((struct sockaddr_in*) &saddr)->sin_port != 0)) {  
33.	        /* Handle is already bound to a port. */  
34.	        handle->flags |= flags;  
35.	        return 0;  
36.	      }  
37.	      // 没绑定则绑定到随机地址，bind中实现  
38.	      if (bind(uv__stream_fd(handle), (struct sockaddr*) &saddr, slen))  
39.	        return UV__ERR(errno);  
40.	    }  
41.	  
42.	    handle->flags |= flags;  
43.	    return 0;  
44.	  }  
45.	  // 申请一个新的fd关联到流  
46.	  return new_socket(handle, domain, flags);  
47.	}  
```

maybe_new_socket函数的逻辑分支很多
1 如果流还没有关联到fd，则申请一个新的fd关联到流上。如果设置了绑定标记，fd还会和一个地址进行绑定。
2 如果流已经关联了一个fd
1.	如果流设置了绑定地址的标记，但是已经通过libuv绑定了一个地址（Libuv会设置UV_HANDLE_BOUND标记，用户也可能是直接调bind函数绑定了）。则不需要再次绑定，更新flags就行。
2.	如果流设置了绑定地址的标记，但是还没有通过libuv绑定一个地址，这时候通过getsocketname判断用户是否自己通过bind函数绑定了一个地址，是的话则不需要再次执行绑定操作。否则随机绑定到一个地址。
以上两个函数的逻辑主要是申请一个socket和给socket绑定一个地址。下面我们开看一下连接流的实现。

```c
3.	int uv__tcp_connect(uv_connect_t* req,  
4.	                    uv_tcp_t* handle,  
5.	                    const struct sockaddr* addr,  
6.	                    unsigned int addrlen,  
7.	                    uv_connect_cb cb) {  
8.	  int err;  
9.	  int r;  
10.	  
11.	  // 已经发起了connect了  
12.	  if (handle->connect_req != NULL)  
13.	    return UV_EALREADY;    
14.	  // 申请一个socket和绑定一个地址，如果还没有的话  
15.	  err = maybe_new_socket(handle,  
16.	                         addr->sa_family,  
17.	                         UV_HANDLE_READABLE | UV_HANDLE_WRITABLE);  
18.	  if (err)  
19.	    return err;  
20.	  
21.	  handle->delayed_error = 0;  
22.	  
23.	  do {  
24.	    // 清除全局错误变量的值  
25.	    errno = 0;  
26.	    // 发起三次握手  
27.	    r = connect(uv__stream_fd(handle), addr, addrlen);  
28.	  } while (r == -1 && errno == EINTR);  
29.	  
30.	  if (r == -1 && errno != 0) {  
31.	    // 三次握手还没有完成  
32.	    if (errno == EINPROGRESS)  
33.	      ; /* not an error */  
34.	    else if (errno == ECONNREFUSED)  
35.	      // 对方拒绝建立连接，延迟报错  
36.	      handle->delayed_error = UV__ERR(errno);  
37.	    else  
38.	      // 直接报错  
39.	      return UV__ERR(errno);  
40.	  }  
41.	  // 初始化一个连接型request，并设置某些字段  
42.	  uv__req_init(handle->loop, req, UV_CONNECT);  
43.	  req->cb = cb;  
44.	  req->handle = (uv_stream_t*) handle;  
45.	  QUEUE_INIT(&req->queue);  
46.	  handle->connect_req = req;  
47.	  // 注册到libuv观察者队列  
48.	  uv__io_start(handle->loop, &handle->io_watcher, POLLOUT);  
49.	  // 连接出错，插入pending队尾  
50.	  if (handle->delayed_error)  
51.	    uv__io_feed(handle->loop, &handle->io_watcher);  
52.	  
53.	  return 0;  
54.	}  
```

连接流的逻辑，大致如下
1 申请一个socket，绑定一个地址。
2 根据给定的服务器地址，发起三次握手，非阻塞的，会直接返回继续执行，不会等到三次握手完成。
3 往流上挂载一个connect型的请求。
4 设置io观察者感兴趣的事件为可写。然后把io观察者插入事件循环的io观察者队列。等待可写的时候时候（完成三次握手），就会执行cb回调。
### 3.1.8 监听流

```c
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
11.	    single_accept = (val != NULL && atoi(val) != 0);  /* Off by default. */  
12.	  }  
13.	  // 设置不连续accept  
14.	  if (single_accept)  
15.	    tcp->flags |= UV_HANDLE_TCP_SINGLE_ACCEPT;  
16.	  
17.	  flags = 0;  
18.	  /* 
19.	    可能还没有用于listen的fd，socket地址等。 
20.	    这里申请一个socket和绑定到一个地址（如果调listen之前没有调bind则绑定到随机地址） 
21.	  */  
22.	  err = maybe_new_socket(tcp, AF_INET, flags);  
23.	  if (err)  
24.	    return err;  
25.	  // 设置fd为listen状态  
26.	  if (listen(tcp->io_watcher.fd, backlog))  
27.	    return UV__ERR(errno);  
28.	  // 建立连接后的业务回调  
29.	  tcp->connection_cb = cb;  
30.	  tcp->flags |= UV_HANDLE_BOUND;  
31.	  // 有连接到来时的libuv层回调  
32.	  tcp->io_watcher.cb = uv__server_io;  
33.	  // 注册读事件，等待连接到来  
34.	  uv__io_start(tcp->loop, &tcp->io_watcher, POLLIN);  
35.	  
36.	  return 0;  
37.	}  
```

监听流的逻辑看起来逻辑很多，但是主要的逻辑是把流对的fd改成listen状态，这样流就可以接收请求了。然后设置连接到来时执行的回调。最后注册io观察者到事件循环。等待连接到来。就会执行uv__server_io。uv__server_io再执行connection_cb。监听流和其他流的一个区别是，当io观察者的事件触发时，监听流执行的回调是uv__server_io函数。而其他流是在uv__stream_io里统一处理。

```c
1.	// 监听的端口有连接到来执行的函数（完成了三次握手）  
2.	void uv__server_io(uv_loop_t* loop, uv__io_t* w, unsigned int events) {  
3.	  uv_stream_t* stream;  
4.	  int err;  
5.	  
6.	  stream = container_of(w, uv_stream_t, io_watcher);   
7.	  // 注册等待可读事件  
8.	  uv__io_start(stream->loop, &stream->io_watcher, POLLIN);  
9.	  while (uv__stream_fd(stream) != -1) {  
10.	    // 摘下一个已完成三次握手的连接  
11.	    err = uv__accept(uv__stream_fd(stream));  
12.	    if (err < 0) {  
13.	      if (err == -EAGAIN || err == -EWOULDBLOCK)  
14.	        return;  /* Not an error. */  
15.	  
16.	      if (err == -ECONNABORTED)  
17.	        continue;  /* Ignore. Nothing we can do about that. */  
18.	  
19.	      if (err == -EMFILE || err == -ENFILE) {  
20.	        err = uv__emfile_trick(loop, uv__stream_fd(stream));  
21.	        if (err == -EAGAIN || err == -EWOULDBLOCK)  
22.	          break;  
23.	      }  
24.	      // 发生错误，执行回调  
25.	      stream->connection_cb(stream, err);  
26.	      continue;  
27.	    }  
28.	  
29.	    UV_DEC_BACKLOG(w)  
30.	    // 记录拿到的通信socket对应的fd  
31.	    stream->accepted_fd = err;  
32.	    // 执行上传回调  
33.	    stream->connection_cb(stream, 0);  
34.	    // accept成功，则等待用户消费accepted_fd再accept，这里注销事件  
35.	    if (stream->accepted_fd != -1) {  
36.	      /* The user hasn't yet accepted called uv_accept() */  
37.	      uv__io_stop(loop, &stream->io_watcher, POLLIN);  
38.	      return;  
39.	    }  
40.	    /* 
41.	      是tcp类型的流并且设置每次只accpet一个连接，则定时阻塞，被唤醒后再accept， 
42.	      否则一直accept，如果用户在connect回调里消费了accept_fd的话 
43.	    */  
44.	    if (stream->type == UV_TCP && (stream->flags & UV_TCP_SINGLE_ACCEPT)) {  
45.	      /* Give other processes a chance to accept connections. */  
46.	      struct timespec timeout = { 0, 1 };  
47.	      nanosleep(&timeout, NULL);  
48.	    }  
49.	  }  
50.	}  
```

我们看到连接到来时，libuv会从已完成连接的队列中摘下一个节点，然后执行connection_cb回调。在connection_cb回调里，需要uv_accept消费accpet_fd。

```c
1.	int uv_accept(uv_stream_t* server, uv_stream_t* client) {  
2.	  int err;  
3.	  switch (client->type) {  
4.	    case UV_NAMED_PIPE:  
5.	    case UV_TCP:  
6.	      // 把文件描述符保存到client  
7.	      err = uv__stream_open(client,  
8.	                            server->accepted_fd,  
9.	                            UV_STREAM_READABLE | UV_STREAM_WRITABLE);  
10.	      if (err) {  
11.	        uv__close(server->accepted_fd);  
12.	        goto done;  
13.	      }  
14.	      break;  
15.	  
16.	    case UV_UDP:  
17.	      err = uv_udp_open((uv_udp_t*) client, server->accepted_fd);  
18.	      if (err) {  
19.	        uv__close(server->accepted_fd);  
20.	        goto done;  
21.	      }  
22.	      break;  
23.	  
24.	    default:  
25.	      return -EINVAL;  
26.	  }  
27.	  
28.	  client->flags |= UV_HANDLE_BOUND;  
29.	  
30.	done:  
31.	  // 非空，则继续放一个到accpet_fd中等待accept  
32.	  if (server->queued_fds != NULL) {  
33.	    uv__stream_queued_fds_t* queued_fds;  
34.	    queued_fds = server->queued_fds;  
35.	    // 把第一个赋值到accept_fd  
36.	    server->accepted_fd = queued_fds->fds[0];  
37.	    // offset减去一个单位，如果没有了，则释放内存，否则需要把后面的往前挪，offset执行最后一个  
38.	    if (--queued_fds->offset == 0) {  
39.	      uv__free(queued_fds);  
40.	      server->queued_fds = NULL;  
41.	    } else {  
42.	      /* Shift rest */  
43.	      memmove(queued_fds->fds,  
44.	              queued_fds->fds + 1,  
45.	              queued_fds->offset * sizeof(*queued_fds->fds));  
46.	    }  
47.	  } else {  
48.	    // 没有排队的fd了，则注册等待可读事件，等待accept新的fd  
49.	    server->accepted_fd = -1;  
50.	    if (err == 0)  
51.	      uv__io_start(server->loop, &server->io_watcher, POLLIN);  
52.	  }  
53.	  return err;  
54.	}  
```

client是用于和客户端进行通信的流，accept就是把accept_fd保存到client中，client就可以和客户端进行通信了。消费完accept_fd后，如果还有待处理的fd的话，需要补充一个到accept_fd，其他的继续排队。
除了通过accept从tcp底层获取已完成连接的节点，还有一种方式。那就是描述符传递。我们看一下描述符传递的原理。我们知道，父进程fork出子进程的时候，子进程是继承父进程的文件描述符列表的。我们看一下进程和文件描述符的关系  
<img src="https://img-blog.csdnimg.cn/20200901000241760.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center" />

[关系图](https://img-blog.csdnimg.cn/20200901000241760.png)

如果父进程或者子进程在fork之后创建了新的文件描述符，那父子进程间就不能共享了，假设父进程要把一个文件描述符传给子进程，那怎么办呢？根据进程和文件描述符的关系。传递文件描述符要做的事情，不仅仅是在子进程中新建一个fd，还要建立起fd->file->inode的关联，我们看一下如何发送一个描述符。下面的代码摘自uv__write

```c
1.	int fd_to_send;  
2.	struct msghdr msg;  
3.	struct cmsghdr *cmsg;  
4.	union {  
5.	  char data[64];  
6.	  struct cmsghdr alias;  
7.	} scratch;  
8.	  
9.	if (uv__is_closing(req->send_handle)) {  
10.	  err = -EBADF;  
11.	  goto error;  
12.	}  
13.	// 待发送的文件描述符  
14.	fd_to_send = uv__handle_fd((uv_handle_t*) req->send_handle);  
15.	  
16.	memset(&scratch, 0, sizeof(scratch));  
17.	  
18.	assert(fd_to_send >= 0);  
19.	  
20.	msg.msg_name = NULL;  
21.	msg.msg_namelen = 0;  
22.	msg.msg_iov = iov;  
23.	msg.msg_iovlen = iovcnt;  
24.	msg.msg_flags = 0;  
25.	  
26.	msg.msg_control = &scratch.alias;  
27.	msg.msg_controllen = CMSG_SPACE(sizeof(fd_to_send));  
28.	  
29.	cmsg = CMSG_FIRSTHDR(&msg);  
30.	cmsg->cmsg_level = SOL_SOCKET;  
31.	cmsg->cmsg_type = SCM_RIGHTS;  
32.	cmsg->cmsg_len = CMSG_LEN(sizeof(fd_to_send));  
33.	  
34.	/* silence aliasing warning */  
35.	{  
36.	  void* pv = CMSG_DATA(cmsg);  
37.	  int* pi = pv;  
38.	  *pi = fd_to_send;  
39.	}  
40.	  
41.	do {  
42.	  // 使用sendmsg函数发送文件描述符  
43.	  n = sendmsg(uv__stream_fd(stream), &msg, 0);  
44.	} while(n == -1 && errno == EINTR)  
```

linux描述符传递涉及到进程间通信，Libuv中描述符传递是基于unix域的，客户端到write函数，以附带数据的方式，发送需要传递的描述符，服务器收到这样的数据后，操作系统会特殊处理这种数据。我们如何解析出传递的文件描述符。下面代码摘自uv_read

```c
1.	// 是rpc则解析读取的数据，把文件描述符解析出来，放到stream里  
2.	if (is_ipc) {  
3.	  err = uv__stream_recv_cmsg(stream, &msg);  
4.	  if (err != 0) {  
5.	    stream->read_cb(stream, err, &buf);  
6.	    return;  
7.	  }  
8.	}  
```

我们看uv__stream_recv_cmsg

```c
1.	// 接收传递过来的文件描述符  
2.	static int uv__stream_recv_cmsg(uv_stream_t* stream, struct msghdr* msg) {  
3.	  struct cmsghdr* cmsg;  
4.	  
5.	  for (cmsg = CMSG_FIRSTHDR(msg); cmsg != NULL; cmsg = CMSG_NXTHDR(msg, cmsg)) {  
6.	    char* start;  
7.	    char* end;  
8.	    int err;  
9.	    void* pv;  
10.	    int* pi;  
11.	    unsigned int i;  
12.	    unsigned int count;  
13.	  
14.	    if (cmsg->cmsg_type != SCM_RIGHTS) {  
15.	      fprintf(stderr, "ignoring non-SCM_RIGHTS ancillary data: %d\n",  
16.	          cmsg->cmsg_type);  
17.	      continue;  
18.	    }  
19.	  
20.	    /* silence aliasing warning */  
21.	    pv = CMSG_DATA(cmsg);  
22.	    pi = pv;  
23.	  
24.	    /* Count available fds */  
25.	    start = (char*) cmsg;  
26.	    end = (char*) cmsg + cmsg->cmsg_len;  
27.	    count = 0;  
28.	    while (start + CMSG_LEN(count * sizeof(*pi)) < end)  
29.	      count++;  
30.	    assert(start + CMSG_LEN(count * sizeof(*pi)) == end);  
31.	  
32.	    for (i = 0; i < count; i++) {  
33.	      /* Already has accepted fd, queue now */  
34.	      // 非空，则排队，否则先保存一个到accept_fd字段  
35.	      if (stream->accepted_fd != -1) {  
36.	        err = uv__stream_queue_fd(stream, pi[i]);  
37.	        if (err != 0) {  
38.	          /* Close rest */  
39.	          for (; i < count; i++)  
40.	            uv__close(pi[i]);  
41.	          return err;  
42.	        }  
43.	      } else {  
44.	        stream->accepted_fd = pi[i];  
45.	      }  
46.	    }  
47.	  }  
48.	  
49.	  return 0;  
50.	}  
```

我们看到解析出来的文件描述符会放到accept_fd或者待处理队列中。
### 3.1.9 销毁流

```c
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

销毁流的时候，如果流中还有待写的数据，则会丢弃。我们看一下uv__stream_flush_write_queue和uv__write_callbacks。

```c
1.	void uv__stream_flush_write_queue(uv_stream_t* stream, int error) {  
2.	  uv_write_t* req;  
3.	  QUEUE* q;  
4.	  while (!QUEUE_EMPTY(&stream->write_queue)) {  
5.	    q = QUEUE_HEAD(&stream->write_queue);  
6.	    QUEUE_REMOVE(q);  
7.	  
8.	    req = QUEUE_DATA(q, uv_write_t, queue);  
9.	    // 把错误写到每个请求中  
10.	    req->error = error;  
11.	  
12.	    QUEUE_INSERT_TAIL(&stream->write_completed_queue, &req->queue);  
13.	  }  
14.	}  
```

uv__stream_flush_write_queue丢弃待写队列中的请求，并直接插入写完成队列中。

```c
1.	static void uv__write_callbacks(uv_stream_t* stream) {  
2.	  uv_write_t* req;  
3.	  QUEUE* q;  
4.	  // 写完成队列非空  
5.	  while (!QUEUE_EMPTY(&stream->write_completed_queue)) {  
6.	    /* Pop a req off write_completed_queue. */  
7.	    q = QUEUE_HEAD(&stream->write_completed_queue);  
8.	    req = QUEUE_DATA(q, uv_write_t, queue);  
9.	    QUEUE_REMOVE(q);  
10.	    uv__req_unregister(stream->loop, req);  
11.	    // bufs的内存还没有被释放  
12.	    if (req->bufs != NULL) {  
13.	      // 更新待写队列的大小，即减去req对应的所有数据的大小  
14.	      stream->write_queue_size -= uv__write_req_size(req);  
15.	      // bufs默认指向bufsml，超过默认大小时，bufs指向新申请的堆内存，所以需要释放  
16.	      if (req->bufs != req->bufsml)  
17.	        uv__free(req->bufs);  
18.	      req->bufs = NULL;  
19.	    }  
20.	    // 指向回调  
21.	    if (req->cb)  
22.	      req->cb(req, req->error);  
23.	  }  
24.	  
25.	  assert(QUEUE_EMPTY(&stream->write_completed_queue));  
26.	} 
```
uv__write_callbacks是写完或者写出错时执行的函数，他逐个处理写完成队列中的节点，每个节点是一个写请求，执行他的回调，如何分配了堆内存，则释放内存。
流的类型分析得差不多了，最后分析一下监听流的处理函数uv__server_io，统一处理其他流的函数是uv__stream_io，这个下次分析。
刚才已经说到有连接到来的时候，libuv会执行uv__server_io，下面看一下他做了什么事情。

```c
1.	// 有tcp连接到来时执行该函数  
2.	void uv__server_io(uv_loop_t* loop, uv__io_t* w, unsigned int events) {  
3.	  uv_stream_t* stream;  
4.	  int err;  
5.	  // 拿到io观察者所在的流  
6.	  stream = container_of(w, uv_stream_t, io_watcher);  
7.	  // 继续注册事件,等待连接  
8.	  uv__io_start(stream->loop, &stream->io_watcher, POLLIN);  
9.	  
10.	  /* connection_cb can close the server socket while we're 
11.	   * in the loop so check it on each iteration. 
12.	   */  
13.	  while (uv__stream_fd(stream) != -1) {  
14.	    // 有连接到来，进行accept  
15.	    err = uv__accept(uv__stream_fd(stream));  
16.	    if (err < 0) {  
17.	      // 忽略出错处理  
18.	      // accept出错，触发回调  
19.	      stream->connection_cb(stream, err);  
20.	      continue;  
21.	    }  
22.	    // 保存通信socket对应的文件描述符  
23.	    stream->accepted_fd = err;  
24.	    /* 
25.	        有连接，执行上层回调，connection_cb一般会调用uv_accept消费accepted_fd。 
26.	        然后重新注册等待可读事件 
27.	    */  
28.	    stream->connection_cb(stream, 0);  
29.	    /* 
30.	        用户还没有消费accept_fd。先解除io的事件， 
31.	        等到用户调用uv_accept消费了accepted_fd再重新注册事件 
32.	    */  
33.	    if (stream->accepted_fd != -1) {  
34.	      uv__io_stop(loop, &stream->io_watcher, POLLIN);  
35.	      return;  
36.	    }  
37.	    // 定时睡眠一会（可被信号唤醒），分点给别的进程accept  
38.	    if (stream->type == UV_TCP &&  
39.	        (stream->flags & UV_HANDLE_TCP_SINGLE_ACCEPT)) {  
40.	      struct timespec timeout = { 0, 1 };  
41.	      nanosleep(&timeout, NULL);  
42.	    }  
43.	  }  
44.	}  
```

整个函数的逻辑如下
1 调用accept摘下一个完成了三次握手的节点。
2 然后执行上层回调。上层回调会调用uv_accept消费accept返回的fd。然后再次注册等待可读事件（当然也可以不消费）。
3 如果2没有消费调fd。则撤销等待可读事件，即处理完一个fd后，再accept下一个。如果2中消费了fd。再判断有没有设置UV_HANDLE_TCP_SINGLE_ACCEPT标记，如果有则休眠一会，分点给别的进程accept。否则继续accept。
### 3.1.10 事件触发的处理
在流的实现中，读写等操作都只是注册事件到epoll，事件触发的时候，会执行统一的回调函数uv__stream_io。

```c
1.	static void uv__stream_io(uv_loop_t* loop, uv__io_t* w, unsigned int events) {  
2.	  uv_stream_t* stream;  
3.	  
4.	  stream = container_of(w, uv_stream_t, io_watcher);  
5.	  
6.	  assert(stream->type == UV_TCP ||  
7.	         stream->type == UV_NAMED_PIPE ||  
8.	         stream->type == UV_TTY);  
9.	  assert(!(stream->flags & UV_CLOSING));  
10.	  // 是连接流，则执行连接处理函数  
11.	  if (stream->connect_req) {  
12.	    uv__stream_connect(stream);  
13.	    return;  
14.	  }  
15.	  
16.	  assert(uv__stream_fd(stream) >= 0);  
17.	  
18.	  /* Ignore POLLHUP here. Even it it's set, there may still be data to read. */  
19.	  // 可读是触发，则执行读处理  
20.	  if (events & (POLLIN | POLLERR | POLLHUP))  
21.	    uv__read(stream);  
22.	  // 读回调关闭了流  
23.	  if (uv__stream_fd(stream) == -1)  
24.	    return;  /* read_cb closed stream. */  
25.	  
26.	  /* Short-circuit iff POLLHUP is set, the user is still interested in read 
27.	   * events and uv__read() reported a partial read but not EOF. If the EOF 
28.	   * flag is set, uv__read() called read_cb with err=UV_EOF and we don't 
29.	   * have to do anything. If the partial read flag is not set, we can't 
30.	   * report the EOF yet because there is still data to read. 
31.	   */  
32.	  /* 
33.	    POLLHUP 
34.	      Hang up (only returned in revents; ignored in events).  Note 
35.	      that when reading from a channel such as a pipe or a stream 
36.	      socket, this event merely indicates that the peer closed its 
37.	      end of the channel.  Subsequent reads from the channel will 
38.	      return 0 (end of file) only after all outstanding data in the 
39.	      channel has been consumed. 
40.	       
41.	      POLLHUP说明对端关闭了，即不会发生数据过来了。如果流的模式是持续读， 
42.	        1 如果只读取了部分（设置UV_STREAM_READ_PARTIAL），并且没有读到结尾(没有设置UV_STREAM_READ_EOF)， 
43.	        则直接作读结束处理， 
44.	        2 如果只读取了部分，上面的读回调执行了读结束操作，则这里就不需要处理了 
45.	        3 如果没有设置只读了部分，还没有执行读结束操作，则不能作读结束操作，因为对端虽然关闭了， 
46.	        但是之前的传过来的数据可能还没有被消费完 
47.	        4 如果没有设置只读了部分，执行了读结束操作，那这里也不需要处理 
48.	  */  
49.	  if ((events & POLLHUP) &&  
50.	      (stream->flags & UV_STREAM_READING) &&  
51.	      (stream->flags & UV_STREAM_READ_PARTIAL) &&  
52.	      !(stream->flags & UV_STREAM_READ_EOF)) {  
53.	    uv_buf_t buf = { NULL, 0 };  
54.	    uv__stream_eof(stream, &buf);  
55.	  }  
56.	  
57.	  if (uv__stream_fd(stream) == -1)  
58.	    return;  /* read_cb closed stream. */  
59.	  // 可写事件触发  
60.	  if (events & (POLLOUT | POLLERR | POLLHUP)) {  
61.	    // 写数据  
62.	    uv__write(stream);  
63.	    // 写完后做后置处理，释放内存，执行回调等  
64.	    uv__write_callbacks(stream);  
65.	  
66.	    /* Write queue drained. */  
67.	    // 待写队列为空，则触发drain事件，可以继续写  
68.	    if (QUEUE_EMPTY(&stream->write_queue))  
69.	      uv__drain(stream);  
70.	  }  
71.	}  
```
