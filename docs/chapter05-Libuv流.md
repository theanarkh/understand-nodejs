# 第五章 Libuv流
流的实现在Libuv里占了很大的篇幅，是非常核心的逻辑。流的本质是封装了对文件描述符的操作，例如读、写，连接、监听。我们首先看看数据结构，流在Libuv里用uv_stream_s表示，继承于uv_handle_s。

```cpp
	struct uv_stream_s {  
        // uv_handle_s的字段  
        void* data;          
        // 所属事件循环     
        uv_loop_t* loop;    
        // handle类型      
        uv_handle_type type;    
        // 关闭handle时的回调  
        uv_close_cb close_cb;   
        // 用于插入事件循环的handle队列  
        void* handle_queue[2];  
        union {                 
            int fd;               
            void* reserved[4];    
        } u;        
        // 用于插入事件循环的closing阶段  
        uv_handle_t* next_closing;   
        // 各种标记   
        unsigned int flags;  
        // 流拓展的字段  
        /*
            户写入流的字节大小，流缓存用户的输入，
            然后等到可写的时候才执行真正的写 
            */ 
        size_t write_queue_size;   
        // 分配内存的函数，内存由用户定义，用来保存读取的数据
        uv_alloc_cb alloc_cb;    
        // 读回调                   
        uv_read_cb read_cb;   
        // 连接请求对应的结构体  
        uv_connect_t *connect_req;   
        /*
            关闭写端的时候，发送完缓存的数据，
            执行shutdown_req的回调（shutdown_req在uv_shutdown的时候赋值） 
            */     
        uv_shutdown_t *shutdown_req;  
        /*
            流对应的IO观察者
            */
        uv__io_t io_watcher;    
        // 缓存待写的数据，该字段用于插入队列           
        void* write_queue[2];         
        // 已经完成了数据写入的队列，该字段用于插入队列     
        void* write_completed_queue[2];  
        // 有连接到来并且完成三次握手后，执行的回调  
        uv_connection_cb connection_cb;  
        // 操作流时出错码  
        int delayed_error;    
        // accept返回的通信socket对应的文件描述    
            int accepted_fd;      
        // 同上，用于IPC时，缓存多个传递的文件描述符
        void* queued_fds;  
	}  
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
	void uv__stream_init(uv_loop_t* loop,
	                      uv_stream_t* stream, 
	                      uv_handle_type type) {  
        int err;  
        // 记录handle的类型  
        uv__handle_init(loop, (uv_handle_t*)stream, type);  
        stream->read_cb = NULL;  
        stream->alloc_cb = NULL;  
        stream->close_cb = NULL;  
        stream->connection_cb = NULL;  
        stream->connect_req = NULL;  
        stream->shutdown_req = NULL;  
        stream->accepted_fd = -1;  
        stream->queued_fds = NULL;  
        stream->delayed_error = 0;  
        QUEUE_INIT(&stream->write_queue);  
        QUEUE_INIT(&stream->write_completed_queue);  
        stream->write_queue_size = 0;  
        /* 
            初始化IO观察者，把文件描述符（这里还没有，所以是-1）和
            回调uv__stream_io记录在io_watcher上，fd的事件触发时，统一
            由uv__stream_io函数处理，但也会有特殊情况（下面会讲到）  
            */
        uv__io_init(&stream->io_watcher, uv__stream_io, -1);  
	}  
```

初始化一个流的逻辑很简单明了，就是初始化相关的字段，需要注意的是初始化IO观察者时，设置的处理函数是uv__stream_io，后面我们会分析这个函数的具体逻辑。
## 5.2 打开流 

```cpp
	int uv__stream_open(uv_stream_t* stream, int fd, int flags) {  
        // 还没有设置fd或者设置的同一个fd则继续，否则返回UV_EBUSY
        if (!(stream->io_watcher.fd == -1 || 
                stream->io_watcher.fd == fd))  
            return UV_EBUSY;  
        // 设置流的标记  
        stream->flags |= flags;  
        // 是TCP流则可以设置下面的属性
        if (stream->type == UV_TCP) {  
        // 关闭nagle算法  
        if ((stream->flags & UV_HANDLE_TCP_NODELAY) && 
                uv__tcp_nodelay(fd, 1))  
        return UV__ERR(errno); 
        /* 
            开启keepalive机制
            */
        if ((stream->flags & UV_HANDLE_TCP_KEEPALIVE) &&  
        uv__tcp_keepalive(fd, 1, 60)) {  
        return UV__ERR(errno);  
        }  
        }  
        /*
        保存socket对应的文件描述符到IO观察者中，Libuv会在
        Poll IO阶段监听该文件描述符  
        */
        stream->io_watcher.fd = fd;  
        return 0;  
	}  
```

打开一个流，本质上就是给这个流关联一个文件描述符，后续的操作的时候都是基于这个文件描述符的，另外还有一些属性的设置。
## 5.3 读流
我们在一个流上执行uv_read_start后，流的数据（如果有的话）就会通过read_cb回调源源不断地流向调用方。

```cpp
	int uv_read_start(uv_stream_t* stream, 
	                   uv_alloc_cb alloc_cb, 
	                   uv_read_cb read_cb) {  
        // 流已经关闭，不能读  
        if (stream->flags & UV_HANDLE_CLOSING)  
            return UV_EINVAL;  
        // 流不可读，说明可能是只写流  
        if (!(stream->flags & UV_HANDLE_READABLE))  
            return -ENOTCONN;  
        // 标记正在读  
        stream->flags |= UV_HANDLE_READING;  
        // 记录读回调，有数据的时候会执行这个回调  
        stream->read_cb = read_cb;  
        // 分配内存函数，用于存储读取的数据  
        stream->alloc_cb = alloc_cb;  
        // 注册等待读事件  
        uv__io_start(stream->loop, &stream->io_watcher, POLLIN);  
        // 激活handle，有激活的handle，事件循环不会退出  
        uv__handle_start(stream);  
        return 0;  
	}  
```

执行uv_read_start本质上是给流对应的文件描述符在epoll中注册了一个等待可读事件，并记录相应的上下文，比如读回调函数，分配内存的函数。接着打上正在做读取操作的标记。当可读事件触发的时候，读回调就会被执行，除了读取数据，还有一个读操作就是停止读取。对应的函数是uv_read_stop。

```cpp
	int uv_read_stop(uv_stream_t* stream) {  
        // 是否正在执行读取操作，如果不是，则没有必要停止  
        if (!(stream->flags & UV_HANDLE_READING))  
            return 0;  
        // 清除正在读取的标记  
        stream->flags &= ~UV_HANDLE_READING;  
        // 撤销等待读事件  
        uv__io_stop(stream->loop, &stream->io_watcher, POLLIN);  
        // 对写事件也不感兴趣，停掉handle。允许事件循环退出  
        if (!uv__io_active(&stream->io_watcher, POLLOUT))  
            uv__handle_stop(stream);  
        stream->read_cb = NULL;  
        stream->alloc_cb = NULL;  
        return 0;  
	}  
```

另外还有一个辅助函数，判断流是否设置了可读属性。

```cpp
	int uv_is_readable(const uv_stream_t* stream) {  
	  return !!(stream->flags & UV_HANDLE_READABLE);  
	}  
```

上面的函数只是注册和注销读事件，如果可读事件触发的时候，我们还需要自己去读取数据，我们看一下真正的读逻辑

```cpp
	static void uv__read(uv_stream_t* stream) {  
	  uv_buf_t buf;  
	  ssize_t nread;  
	  struct msghdr msg;  
	  char cmsg_space[CMSG_SPACE(UV__CMSG_FD_SIZE)];  
	  int count;  
	  int err;  
	  int is_ipc;  
	  // 清除读取部分标记  
	  stream->flags &= ~UV_STREAM_READ_PARTIAL;  
	  count = 32;  
	  /*
	      流是Unix域类型并且用于IPC，Unix域不一定用于IPC，
	      用作IPC可以支持传递文件描述符  
	    */
	  is_ipc = stream->type == UV_NAMED_PIPE && 
	                                ((uv_pipe_t*) stream)->ipc;  
	  // 设置了读回调，正在读，count大于0  
	  while (stream->read_cb  
	      && (stream->flags & UV_STREAM_READING)  
	      && (count-- > 0)) {  
	    buf = uv_buf_init(NULL, 0);  
	    // 调用调用方提供的分配内存函数，分配内存承载数据  
	    stream->alloc_cb((uv_handle_t*)stream, 64 * 1024, &buf);  
	    /*
	         不是IPC则直接读取数据到buf，否则用recvmsg读取数据                       
	          和传递的文件描述符（如果有的话）
	        */  
	    if (!is_ipc) {  
	      do {  
	        nread = read(uv__stream_fd(stream), 
	                                            buf.base, 
	                                            buf.len);  
	      }  
	      while (nread < 0 && errno == EINTR);  
	    } else {  
	      /* ipc uses recvmsg */  
	      msg.msg_flags = 0;  
	      msg.msg_iov = (struct iovec*) &buf;  
	      msg.msg_iovlen = 1;  
	      msg.msg_name = NULL;  
	      msg.msg_namelen = 0;  
	      msg.msg_controllen = sizeof(cmsg_space);  
	      msg.msg_control = cmsg_space; 
	      do {  
	        nread = uv__recvmsg(uv__stream_fd(stream), &msg, 0);
	      }  
	      while (nread < 0 && errno == EINTR);  
	    }  
	    // 读失败  
	    if (nread < 0) { 
	      // 读繁忙  
	      if (errno == EAGAIN || errno == EWOULDBLOCK) {  
	        // 执行读回调  
	        stream->read_cb(stream, 0, &buf);  
	      } else {  
	        /* Error. User should call uv_close(). */  
	        // 读失败  
	        stream->read_cb(stream, -errno, &buf);  
	      }  
	      return;  
	    } else if (nread == 0) {  
	      // 读到结尾了  
	      uv__stream_eof(stream, &buf);  
	      return;  
	    } else {   
	      // 读成功，读取数据的长度  
	      ssize_t buflen = buf.len;  
	      /*
	                是IPC则解析读取的数据，把文件描述符解析出来，
	                放到stream的accepted_fd和queued_fds字段  
	            */
	      if (is_ipc) {  
	        err = uv__stream_recv_cmsg(stream, &msg);  
	        if (err != 0) {  
	          stream->read_cb(stream, err, &buf);  
	          return;  
	        }  
	      }  
	      // 执行读回调  
	      stream->read_cb(stream, nread, &buf);  
	    }  
	  }  
	}  
```

uv_read除了可以读取一般的数据外，还支持读取传递的文件描述符。我们看一下描述符传递的原理。我们知道，父进程fork出子进程的时候，子进程是继承父进程的文件描述符列表的。我们看一下进程和文件描述符的关系。
fork之前如图5-1所示。

 ![](https://img-blog.csdnimg.cn/20210420235737186.png)

我们再看一下fork之后的结构如图5-2所示。

![](https://img-blog.csdnimg.cn/20210420235751592.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)

如果父进程或者子进程在fork之后创建了新的文件描述符，那父子进程间就不能共享了，假设父进程要把一个文件描述符传给子进程，那怎么办呢？根据进程和文件描述符的关系。传递文件描述符要做的事情，不仅仅是在子进程中新建一个fd，还要建立起fd->file->inode的关联，不过我们不需要关注这些，因为操作系统都帮我们处理了，我们只需要通过sendmsg把想传递的文件描述符发送给Unix域的另一端。Unix域另一端就可以通过recvmsg把文件描述符从数据中读取出来。接着使用uv__stream_recv_cmsg函数保存数据里解析出来的文件描述符。

```cpp
	static int uv__stream_recv_cmsg(uv_stream_t* stream, 
	                                   struct msghdr* msg) {  
	  struct cmsghdr* cmsg;  
	  // 遍历msg  
	  for (cmsg = CMSG_FIRSTHDR(msg); 
	        cmsg != NULL; 
	        cmsg = CMSG_NXTHDR(msg, cmsg)) {  
	     char* start;  
	     char* end;  
	    int err;  
	    void* pv;  
	    int* pi;  
	    unsigned int i;  
	    unsigned int count;  
	  
	    pv = CMSG_DATA(cmsg);  
	    pi = pv;  
	    start = (char*) cmsg;  
	    end = (char*) cmsg + cmsg->cmsg_len;  
	    count = 0;  
	    while (start + CMSG_LEN(count * sizeof(*pi)) < end)  
	      count++;  
	    for (i = 0; i < count; i++) {  
	      /* 
	        accepted_fd代表当前待处理的文件描述符， 
	        如果已经有值则剩余描述符就通过uv__stream_queue_fd排队 
	        如果还没有值则先赋值 
	      */  
	      if (stream->accepted_fd != -1) {  
	        err = uv__stream_queue_fd(stream, pi[i]);  
	      } else {  
	        stream->accepted_fd = pi[i];  
	      }  
	    }  
	  }  
	  
	  return 0;  
	}  
```

uv__stream_recv_cmsg会从数据中解析出一个个文件描述符存到stream中，第一个文件描述符保存在accepted_fd，剩下的使用uv__stream_queue_fd处理。

```cpp
	struct uv__stream_queued_fds_s {  
	  unsigned int size;  
	  unsigned int offset;  
	  int fds[1];  
	};  
	  
	static int uv__stream_queue_fd(uv_stream_t* stream, int fd) {  
	  uv__stream_queued_fds_t* queued_fds;  
	  unsigned int queue_size;  
	  // 原来的内存  
	  queued_fds = stream->queued_fds;  
	  // 没有内存，则分配  
	  if (queued_fds == NULL) {  
	    // 默认8个  
	    queue_size = 8;  
	    /* 
	      一个元数据内存+多个fd的内存
	      （前面加*代表解引用后的值的类型所占的内存大小，
	      减一是因为uv__stream_queued_fds_t
	      结构体本身有一个空间）
	    */
	    queued_fds = uv__malloc((queue_size - 1) * 
	                               sizeof(*queued_fds->fds) +  
	                            sizeof(*queued_fds));  
	    if (queued_fds == NULL)  
	      return UV_ENOMEM;  
	    // 容量  
	    queued_fds->size = queue_size;  
	    // 已使用个数  
	    queued_fds->offset = 0;  
	    // 指向可用的内存  
	    stream->queued_fds = queued_fds;  
	  // 之前的内存用完了，扩容  
	  } else if (queued_fds->size == queued_fds->offset) {  
	    // 每次加8个  
	    queue_size = queued_fds->size + 8;  
	    queued_fds = uv__realloc(queued_fds,  
	                             (queue_size - 1) * sizeof(*queued_fds->fds) + sizeof(*queued_fds));  
	  
	    if (queued_fds == NULL)  
	      return UV_ENOMEM;  
	    // 更新容量大小  
	    queued_fds->size = queue_size;  
	    // 保存新的内存  
	    stream->queued_fds = queued_fds;  
	  }  
	  
	  /* Put fd in a queue */  
	  // 保存fd  
	  queued_fds->fds[queued_fds->offset++] = fd;  
	  
	  return 0;  
	}  
```

内存结构如图5-3所示。

 ![](https://img-blog.csdnimg.cn/20210420235824605.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)

最后我们看一下读结束后的处理，

```cpp
	static void uv__stream_eof(uv_stream_t* stream,
	                             const uv_buf_t* buf) {
	  // 打上读结束标记
	  stream->flags |= UV_STREAM_READ_EOF;
	  // 注销等待可读事件
	  uv__io_stop(stream->loop, &stream->io_watcher, POLLIN);
	  // 没有注册等待可写事件则停掉handle，否则会影响事件循环的退出
	  if (!uv__io_active(&stream->io_watcher, POLLOUT))
	    uv__handle_stop(stream);
	  uv__stream_osx_interrupt_select(stream);
	  // 执行读回调
	  stream->read_cb(stream, UV_EOF, buf);
	  // 清除正在读标记
	  stream->flags &= ~UV_STREAM_READING;
	}
```

我们看到，流结束的时候，首先注销等待可读事件，然后通过回调通知上层。
## 5.4 写流
我们在流上执行uv_write就可以往流中写入数据。

```cpp
	int uv_write(  
	        /* 
	              一个写请求，记录了需要写入的数据和信息。
	               数据来自下面的const uv_buf_t bufs[]  
	             */
	       uv_write_t* req,  
	       // 往哪个流写  
	       uv_stream_t* handle,  
	       // 需要写入的数据  
	       const uv_buf_t bufs[],  
	       // uv_buf_t个数  
	       unsigned int nbufs,  
	       // 写完后执行的回调  
	       uv_write_cb cb  
	) {  
	  return uv_write2(req, handle, bufs, nbufs, NULL, cb);  
	}
```

uv_write是直接调用uv_write2。第四个参数是NULL。代表是一般的写数据，不传递文件描述符。

```cpp
	int uv_write2(uv_write_t* req,  
	              uv_stream_t* stream,  
	              const uv_buf_t bufs[],  
	              unsigned int nbufs,  
	              uv_stream_t* send_handle,  
	              uv_write_cb cb) {  
	  int empty_queue; 
	  // 待发送队列是否为空  
	  empty_queue = (stream->write_queue_size == 0);  
	  // 构造一个写请求  
	  uv__req_init(stream->loop, req, UV_WRITE);  
	    // 写请求对应的回调
	  req->cb = cb; 
	    // 写请求对应的流 
	  req->handle = stream;  
	  req->error = 0;  
	    // 需要发送的文件描述符，也可以是NULL说明不需要发送文件描述符
	  req->send_handle = send_handle;  
	  QUEUE_INIT(&req->queue);  
	  // bufs指向待写的数据  
	  req->bufs = req->bufsml;  
	  // 复制调用方的数据过来  
	  memcpy(req->bufs, bufs, nbufs * sizeof(bufs[0]));  
	  // buf个数  
	  req->nbufs = nbufs;  
	  // 当前写成功的buf索引，针对bufs数组  
	  req->write_index = 0;  
	  // 待写的数据大小 = 之前的大小 + 本次大小  
	  stream->write_queue_size += uv__count_bufs(bufs, nbufs);  
	  // 插入待写队列  
	  QUEUE_INSERT_TAIL(&stream->write_queue, &req->queue);  
	  // 非空说明正在连接，还不能写，比如TCP流  
	  if (stream->connect_req) {  
	    /* Still connecting, do nothing. */  
	  }  
	  else if (empty_queue) { // 当前待写队列为空，直接写  
	    uv__write(stream);  
	  }  
	  else {  
	    // 还有数据没有写完，注册等待写事件  
	    uv__io_start(stream->loop, &stream->io_watcher, POLLOUT);  
	    uv__stream_osx_interrupt_select(stream);  
	  }  
	  return 0;  
	}  
```

uv_write2的主要逻辑就是封装一个写请求，插入到流的待写队列。然后根据当前流的情况。看是直接写入还是等待会再写入。关系图大致如图5-4所示。

 ![](https://img-blog.csdnimg.cn/202104202359054.png)

uv_write2只是对写请求进行一些预处理，真正执行写的函数是uv__write 

```cpp
	static void uv__write(uv_stream_t* stream) {  
	  struct iovec* iov;  
	  QUEUE* q;  
	  uv_write_t* req;  
	  int iovmax;  
	  int iovcnt;  
	  ssize_t n;  
	  int err;  
	  
	start:  
	  // 没有数据需要写
	  if (QUEUE_EMPTY(&stream->write_queue))  
	    return;  
	  q = QUEUE_HEAD(&stream->write_queue);  
	  req = QUEUE_DATA(q, uv_write_t, queue); 
	  // 从哪里开始写  
	  iov = (struct iovec*) &(req->bufs[req->write_index]);  
	  // 还有多少没写  
	  iovcnt = req->nbufs - req->write_index;  
	  // 最多可以写多少  
	  iovmax = uv__getiovmax();  
	  // 取最小值  
	  if (iovcnt > iovmax)  
	    iovcnt = iovmax;  
	  // 需要传递文件描述符  
	  if (req->send_handle) {  
	    int fd_to_send;  
	    struct msghdr msg;  
	    struct cmsghdr *cmsg;  
	    union {  
	      char data[64];  
	      struct cmsghdr alias;  
	    } scratch;  
	  
	    if (uv__is_closing(req->send_handle)) {  
	      err = -EBADF;  
	      goto error;  
	    }  
	    // 待发送的文件描述符  
	    fd_to_send = uv__handle_fd((uv_handle_t*) req->send_handle);
	    memset(&scratch, 0, sizeof(scratch));  
	  
	    msg.msg_name = NULL;  
	    msg.msg_namelen = 0;  
	    msg.msg_iov = iov;  
	    msg.msg_iovlen = iovcnt;  
	    msg.msg_flags = 0;  
	  
	    msg.msg_control = &scratch.alias;  
	    msg.msg_controllen = CMSG_SPACE(sizeof(fd_to_send));  
	  
	    cmsg = CMSG_FIRSTHDR(&msg);  
	    cmsg->cmsg_level = SOL_SOCKET;  
	    cmsg->cmsg_type = SCM_RIGHTS;  
	    cmsg->cmsg_len = CMSG_LEN(sizeof(fd_to_send));  
	  
	    {  
	      void* pv = CMSG_DATA(cmsg);  
	      int* pi = pv;  
	      *pi = fd_to_send;  
	    }  
	  
	    do {  
	      // 使用sendmsg函数发送文件描述符  
	      n = sendmsg(uv__stream_fd(stream), &msg, 0);  
	    }  
	    while (n == -1 && errno == EINTR);  
	  } else {  
	    do {  
	      // 写一个或者写批量写  
	      if (iovcnt == 1) {  
	        n = write(uv__stream_fd(stream), 
	                            iov[0].iov_base, 
	                            iov[0].iov_len);  
	      } else {  
	        n = writev(uv__stream_fd(stream), iov, iovcnt);  
	      }  
	    }  
	    while (n == -1 && errno == EINTR);  
	  }  
	  // 写失败  
	  if (n < 0) {  
	    /*
	        不是写繁忙，则报错，
	         否则如果设置了同步写标记，则继续尝试写
	        */  
	    if (errno != EAGAIN && 
	             errno != EWOULDBLOCK && 
	             errno != ENOBUFS) {  
	      err = -errno;  
	      goto error;  
	    } else if (stream->flags & UV_STREAM_BLOCKING) {  
	      /* If this is a blocking stream, try again. */  
	      goto start;  
	    }  
	  } else {  
	    // 写成功  
	    while (n >= 0) {  
	      // 当前buf首地址  
	      uv_buf_t* buf = &(req->bufs[req->write_index]);  
	      // 当前buf的数据长度  
	      size_t len = buf->len;  
	      // 小于说明当前buf还没有写完（还没有被消费完）  
	      if ((size_t)n < len) {  
	        // 更新待写的首地址  
	        buf->base += n;  
	        // 更新待写的数据长度  
	        buf->len -= n;  
	        /*
	                 更新待写队列的长度，这个队列是待写数据的
	                  总长度，等于多个buf的和
	                */  
	        stream->write_queue_size -= n;  
	        n = 0;  
	        /*
	                  还没写完，设置了同步写，则继续尝试写，
	                  否则退出，注册待写事件
	                */  
	        if (stream->flags & UV_STREAM_BLOCKING) {  
	          goto start;  
	        } else {  
	          break;  
	        } 
	      } else {  
	        /* 
	                  当前buf的数据都写完了，则更新待写数据的的首
	                  地址，即下一个buf，因为当前buf写完了  
	                */
	        req->write_index++;  
	        // 更新n，用于下一个循环的计算  
	        n -= len;  
	        // 更新待写队列的长度  
	        stream->write_queue_size -= len;  
	        /*
	                 等于最后一个buf了，说明待写队列的数据
	                  都写完了
	                */  
	        if (req->write_index == req->nbufs) { 
	          /* 
	                      释放buf对应的内存，并把请求插入写完成
	                      队列，然后准备触发写完成回调  
	                    */
	          uv__write_req_finish(req);  
	          return;  
	        }  
	      }  
	    }  
	  }  
	  /*
	      写成功，但是还没有写完，注册待写事件，
	      等待可写的时候继续写  
	    */
	  uv__io_start(stream->loop, &stream->io_watcher, POLLOUT);  
	  uv__stream_osx_interrupt_select(stream);  
	  
	  return;  
	// 写出错  
	error:  
	  // 记录错误  
	  req->error = err;  
	  /*
	     释放内存，丢弃数据，插入写完成队列，
	      把IO观察者插入pending队列，等待pending阶段执行回调 
	    */ 
	  uv__write_req_finish(req);  
	  // 注销待写事件  
	  uv__io_stop(stream->loop, &stream->io_watcher, POLLOUT);  
	  // 如果也没有注册等待可读事件，则把handle关闭  
	  if (!uv__io_active(&stream->io_watcher, POLLIN))  
	    uv__handle_stop(stream);  
	  uv__stream_osx_interrupt_select(stream);  
	}  
```

我们看一下一个写请求结束后（成功或者失败），Libuv如何处理的。逻辑在uv__write_req_finish函数。

```cpp
	static void uv__write_req_finish(uv_write_t* req) {  
	  uv_stream_t* stream = req->handle;
	    // 从待写队列中移除  
	  QUEUE_REMOVE(&req->queue);  
	    // 写成功，并且分配了额外的堆内存，则需要释放，见uv__write
	  if (req->error == 0) {  
	    if (req->bufs != req->bufsml)  
	      uv__free(req->bufs);  
	    req->bufs = NULL;  
      }  
        // 插入写完成队列
      QUEUE_INSERT_TAIL(&stream->write_completed_queue, &req->queue); 
        /*
          把IO观察者插入pending队列，Libuv在处理pending阶段时,
          会触发IO观察者的写事件
        */
      uv__io_feed(stream->loop, &stream->io_watcher);  
    }  
```

uv__write_req_finish的逻辑比较简单

1把节点从待写队列中移除
2 req->bufs != req->bufsml不相等说明分配了堆内存，需要自己释放
3并把请求插入写完成队列，把IO观察者插入pending队列，等待pending阶段执行回调，在pending节点会执行IO观察者的回调（uv__stream_io）。

我们看一下uv__stream_io如何处理的，下面是具体的处理逻辑。

```cpp
    // 可写事件触发  
    if (events & (POLLOUT | POLLERR | POLLHUP)) {  
        // 继续执行写  
        uv__write(stream);  
        // 处理写成功回调  
        uv__write_callbacks(stream);
        // 待写队列空，注销等待可写事件，即不需要写了  
        if (QUEUE_EMPTY(&stream->write_queue))  
          uv__drain(stream);  
    }  
```

我们只关注uv__write_callbacks。

```cpp
    static void uv__write_callbacks(uv_stream_t* stream) {  
      uv_write_t* req;  
      QUEUE* q;  
      // 写完成队列非空  
      while (!QUEUE_EMPTY(&stream->write_completed_queue)) {  
        q = QUEUE_HEAD(&stream->write_completed_queue);  
        req = QUEUE_DATA(q, uv_write_t, queue);  
        QUEUE_REMOVE(q);  
        uv__req_unregister(stream->loop, req);  
        // bufs的内存还没有被释放  
        if (req->bufs != NULL) {  
          // 更新待写队列的大小，即减去req对应的所有数据的大小  
          stream->write_queue_size -= uv__write_req_size(req);  
          /*
                 bufs默认指向bufsml，超过默认大小时，
                  bufs指向新申请的堆内存，所以需要释放 
                 */ 
          if (req->bufs != req->bufsml)  
            uv__free(req->bufs);  
          req->bufs = NULL;  
        }  
        // 执行回调  
        if (req->cb)  
          req->cb(req, req->error);  
      }    
    }
```

uv__write_callbacks负责更新流的待写队列大小、释放额外申请的堆内存、执行每个写请求的回调。
## 5.5 关闭流的写端

```cpp
    // 关闭流的写端  
    int uv_shutdown(uv_shutdown_t* req, 
                     uv_stream_t* stream, 
                     uv_shutdown_cb cb) {    
      // 初始化一个关闭请求，关联的handle是stream  
      uv__req_init(stream->loop, req, UV_SHUTDOWN);  
      req->handle = stream;  
      // 关闭后执行的回调  
      req->cb = cb;  
      stream->shutdown_req = req;  
      // 设置正在关闭的标记  
      stream->flags |= UV_HANDLE_SHUTTING;  
      // 注册等待可写事件  
      uv__io_start(stream->loop, &stream->io_watcher, POLLOUT);  
      return 0;  
    }  
```

关闭流的写端就是相当于给流发送一个关闭请求，把请求挂载到流中，然后注册等待可写事件，在可写事件触发的时候就会执行关闭操作。在分析写流的章节中我们提到，可写事件触发的时候，会执行uv__drain注销等待可写事件，除此之外，uv__drain还做了一个事情，就是关闭流的写端。我们看看具体的逻辑。

```cpp
    static void uv__drain(uv_stream_t* stream) {  
      uv_shutdown_t* req;  
      int err;  
      // 撤销等待可写事件，因为没有数据需要写入了  
      uv__io_stop(stream->loop, &stream->io_watcher, POLLOUT);  
      uv__stream_osx_interrupt_select(stream);  
      
      // 设置了关闭写端，但是还没有关闭，则执行关闭写端  
      if ((stream->flags & UV_HANDLE_SHUTTING) &&  
          !(stream->flags & UV_HANDLE_CLOSING) &&  
          !(stream->flags & UV_HANDLE_SHUT)) {  
        req = stream->shutdown_req;  
        stream->shutdown_req = NULL;  
        // 清除标记  
        stream->flags &= ~UV_HANDLE_SHUTTING;  
        uv__req_unregister(stream->loop, req);  
      
        err = 0;  
        // 关闭写端  
        if (shutdown(uv__stream_fd(stream), SHUT_WR))  
          err = UV__ERR(errno);  
        // 标记已关闭写端  
        if (err == 0)  
          stream->flags |= UV_HANDLE_SHUT;  
        // 执行回调  
        if (req->cb != NULL)  
          req->cb(req, err);  
      }  
    }  
```

通过调用shutdown关闭流的写端，比如TCP流发送完数据后可以关闭写端。但是仍然可以读。
## 5.6 关闭流

```cpp
    void uv__stream_close(uv_stream_t* handle) {  
      unsigned int i;  
      uv__stream_queued_fds_t* queued_fds;  
      // 从事件循环中删除IO观察者，移出pending队列  
      uv__io_close(handle->loop, &handle->io_watcher);  
      // 停止读  
      uv_read_stop(handle);  
      // 停掉handle  
      uv__handle_stop(handle);  
      // 不可读、写  
      handle->flags &= ~(UV_HANDLE_READABLE | UV_HANDLE_WRITABLE);  
      // 关闭非标准流的文件描述符  
      if (handle->io_watcher.fd != -1) {  
        /* 
              Don't close stdio file descriptors.  
              Nothing good comes from it. 
             */  
        if (handle->io_watcher.fd > STDERR_FILENO)  
          uv__close(handle->io_watcher.fd);  
        handle->io_watcher.fd = -1;  
      }  
      // 关闭通信socket对应的文件描述符  
      if (handle->accepted_fd != -1) {  
        uv__close(handle->accepted_fd);  
        handle->accepted_fd = -1;  
      }  
      // 同上，这是在排队等待处理的文件描述符  
      if (handle->queued_fds != NULL) {  
        queued_fds = handle->queued_fds;  
        for (i = 0; i < queued_fds->offset; i++)  
          uv__close(queued_fds->fds[i]);  
        uv__free(handle->queued_fds);  
        handle->queued_fds = NULL;  
      }  
    }  
```

关闭流就是把流注册在epoll的事件注销，关闭所持有的文件描述符。
## 5.7 连接流
连接流是针对TCP和Unix域的，所以我们首先介绍一下一些网络编程相关的内容，首先我们先要有一个socket。我们看Libuv中如何新建一个socket。

```cpp
    int uv__socket(int domain, int type, int protocol) {  
      int sockfd;  
      int err;  
      // 新建一个socket，并设置非阻塞和LOEXEC标记  
      sockfd = socket(domain, type | SOCK_NONBLOCK | SOCK_CLOEXEC, protocol);  
      // 不触发SIGPIPE信号，比如对端已经关闭，本端又执行写  
    #if defined(SO_NOSIGPIPE)  
      {  
        int on = 1;  
        setsockopt(sockfd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));  
      }  
    #endif  
      
      return sockfd;  
    }  
```

在Libuv中，socket的模式都是非阻塞的，uv__socket是Libuv中申请socket的函数，不过Libuv不直接调用该函数，而是封装了一下。

```cpp
    /* 
      1 获取一个新的socket fd 
      2 把fd保存到handle里，并根据flag进行相关设置 
      3 绑定到本机随意的地址（如果设置了该标记的话） 
    */  
    static int new_socket(uv_tcp_t* handle, 
                            int domain, 
                            unsigned long flags) {  
      struct sockaddr_storage saddr;  
      socklen_t slen;  
      int sockfd;   
      // 获取一个socket  
      sockfd = uv__socket(domain, SOCK_STREAM, 0); 
      
      // 设置选项和保存socket的文件描述符到IO观察者中  
      uv__stream_open((uv_stream_t*) handle, sockfd, flags);  
      // 设置了需要绑定标记UV_HANDLE_BOUND      
      if (flags & UV_HANDLE_BOUND) {  
        slen = sizeof(saddr);  
        memset(&saddr, 0, sizeof(saddr));  
        // 获取fd对应的socket信息，比如IP，端口，可能没有  
        getsockname(uv__stream_fd(handle), 
                        (struct sockaddr*) &saddr, 
                        &slen);
     
        // 绑定到socket中，如果没有则绑定到系统随机选择的地址  
        bind(uv__stream_fd(handle),(struct sockaddr*) &saddr, slen);
     }  
      
      return 0;  
    }  
```

上面的代码就是在Libuv申请一个socket的逻辑，另外它还支持新建的socket，可以绑定到一个用户设置的，或者操作系统随机选择的地址。不过Libuv并不直接使用这个函数。而是又封装了一层。

```cpp
    // 如果流还没有对应的fd，则申请一个新的，如果有则修改流的配置  
    static int maybe_new_socket(uv_tcp_t* handle, 
                                  int domain, 
                                  unsigned long flags) {  
      struct sockaddr_storage saddr;  
      socklen_t slen;  
      
      // 已经有fd了  
      if (uv__stream_fd(handle) != -1) {  
        // 该流需要绑定到一个地址  
        if (flags & UV_HANDLE_BOUND) {  
          /* 
            流是否已经绑定到一个地址了。handle的flag是在
                  new_socket里设置的，如果有这个标记说明已经执行过绑定了，
                  直接更新flags就行。 
          */  
          if (handle->flags & UV_HANDLE_BOUND) {  
            handle->flags |= flags;  
            return 0;  
          }  
          // 有fd，但是可能还没绑定到一个地址  
          slen = sizeof(saddr);  
          memset(&saddr, 0, sizeof(saddr));  
          // 获取socket绑定到的地址  
          if (getsockname(uv__stream_fd(handle), 
                                 (struct sockaddr*) &saddr, 
                                 &slen))  
            return UV__ERR(errno);  
          // 绑定过了socket地址，则更新flags就行  
          if ((saddr.ss_family == AF_INET6 &&  
            ((struct sockaddr_in6*) &saddr)->sin6_port != 0) ||
            (saddr.ss_family == AF_INET &&  
            ((struct sockaddr_in*) &saddr)->sin_port != 0)) { 
            handle->flags |= flags;  
            return 0;  
          }  
          // 没绑定则绑定到随机地址，bind中实现  
          if (bind(uv__stream_fd(handle), 
                          (struct sockaddr*) &saddr, 
                          slen))  
            return UV__ERR(errno);  
        }  
      
        handle->flags |= flags;  
        return 0;  
      }  
      // 申请一个新的fd关联到流  
      return new_socket(handle, domain, flags);  
    }  
```

maybe_new_socket函数的逻辑分支很多，主要如下
1 如果流还没有关联到fd，则申请一个新的fd关联到流上
2 如果流已经关联了一个fd。
&nbsp;&nbsp;&nbsp;&nbsp;如果流设置了绑定地址的标记，但是已经通过Libuv绑定了一个地址（Libuv会设置UV_HANDLE_BOUND标记，用户也可能是直接调bind函数绑定了）。则不需要再次绑定，更新flags就行。
&nbsp;&nbsp;&nbsp;&nbsp;如果流设置了绑定地址的标记，但是还没有通过Libuv绑定一个地址，这时候通过getsocketname判断用户是否自己通过bind函数绑定了一个地址，是的话则不需要再次执行绑定操作。否则随机绑定到一个地址。

以上两个函数的逻辑主要是申请一个socket和给socket绑定一个地址。下面我们开看一下连接流的实现。

```cpp
    int uv__tcp_connect(uv_connect_t* req,  
               uv_tcp_t* handle,  
               const struct sockaddr* addr,  
               unsigned int addrlen,  
               uv_connect_cb cb) {  
      int err;  
      int r;  
      
      // 已经发起了connect了  
      if (handle->connect_req != NULL)  
        return UV_EALREADY;    
      // 申请一个socket和绑定一个地址，如果还没有的话  
      err = maybe_new_socket(handle, addr->sa_family,  
                   UV_HANDLE_READABLE | UV_HANDLE_WRITABLE 
        if (err)  
        return err;  
      handle->delayed_error = 0;  
      
      do {  
        // 清除全局错误变量的值  
        errno = 0;  
        // 非阻塞发起三次握手  
        r = connect(uv__stream_fd(handle), addr, addrlen);  
      } while (r == -1 && errno == EINTR);  
      
      if (r == -1 && errno != 0) {  
        // 三次握手还没有完成  
        if (errno == EINPROGRESS)  
          ; /* not an error */  
        else if (errno == ECONNREFUSED)  
          // 对方拒绝建立连接，延迟报错  
          handle->delayed_error = UV__ERR(errno);  
        else  
          // 直接报错  
          return UV__ERR(errno);  
      }  
      // 初始化一个连接型request，并设置某些字段  
      uv__req_init(handle->loop, req, UV_CONNECT);  
      req->cb = cb;  
      req->handle = (uv_stream_t*) handle;  
      QUEUE_INIT(&req->queue);
        // 连接请求  
      handle->connect_req = req;  
      // 注册到Libuv观察者队列  
      uv__io_start(handle->loop, &handle->io_watcher, POLLOUT);  
      // 连接出错，插入pending队尾  
      if (handle->delayed_error)  
        uv__io_feed(handle->loop, &handle->io_watcher);  
      
      return 0;  
    }  
```

连接流的逻辑，大致如下
1 申请一个socket，绑定一个地址。
2 根据给定的服务器地址，发起三次握手，非阻塞的，会直接返回继续执行，不会等到三次握手完成。
3 往流上挂载一个connect型的请求。
4 设置IO观察者感兴趣的事件为可写。然后把IO观察者插入事件循环的IO观察者队列。等待可写的时候时候（完成三次握手），就会执行cb回调。

可写事件触发时，会执行uv__stream_io，我们看一下具体的逻辑。

```cpp
    if (stream->connect_req) {  
        uv__stream_connect(stream);  
        return;  
    }  
```

我们继续看uv__stream_connect。

```cpp
    static void uv__stream_connect(uv_stream_t* stream) {  
      int error;  
      uv_connect_t* req = stream->connect_req;  
      socklen_t errorsize = sizeof(int);  
      // 连接出错  
      if (stream->delayed_error) {  
        error = stream->delayed_error;  
        stream->delayed_error = 0;  
      } else {  
        // 还是需要判断一下是不是出错了  
        getsockopt(uv__stream_fd(stream),  
                   SOL_SOCKET,  
                   SO_ERROR,  
                   &error,  
                   &errorsize);  
        error = UV__ERR(error);  
      }  
      // 还没连接成功，先返回，等待下次可写事件的触发  
      if (error == UV__ERR(EINPROGRESS))  
        return;  
      // 清空  
      stream->connect_req = NULL;  
      uv__req_unregister(stream->loop, req);  
      /* 
       连接出错则注销之前注册的等待可写队列， 
       连接成功如果待写队列为空，也注销事件，有数据需要写的时候再注册 
      */  
      if (error < 0 || QUEUE_EMPTY(&stream->write_queue)) {  
        uv__io_stop(stream->loop, &stream->io_watcher, POLLOUT);  
      }  
      // 执行回调，通知上层连接结果  
      if (req->cb)  
        req->cb(req, error);  
      
      if (uv__stream_fd(stream) == -1)  
        return;  
      // 连接失败，清空待写的数据和执行写请求的回调（如果有的话）  
      if (error < 0) {  
        uv__stream_flush_write_queue(stream, UV_ECANCELED);  
        uv__write_callbacks(stream);  
      }  
    }  
```

连接流的逻辑是
1发起非阻塞式连接
2 注册等待可写事件
3 可写事件触发时，把连接结果告诉调用方
4 连接成功则发送写队列的数据，连接失败则清除写队列的数据并执行每个写请求的回调（有的话）。
## 5.8 监听流
监听流是针对TCP或Unix域的，主要是把一个socket变成listen状态。并且设置一些属性。

```cpp
    int uv_tcp_listen(uv_tcp_t* tcp, int backlog, uv_connection_cb cb) {  
      static int single_accept = -1;  
      unsigned long flags;  
      int err;  
      
      if (tcp->delayed_error)  
        return tcp->delayed_error;  
      // 是否设置了不连续accept。默认是连续accept。  
      if (single_accept == -1) {  
        const char* val = getenv("UV_TCP_SINGLE_ACCEPT");  
        single_accept = (val != NULL && atoi(val) != 0);  
      }  
      // 设置不连续accept  
      if (single_accept)  
        tcp->flags |= UV_HANDLE_TCP_SINGLE_ACCEPT;  
      
      flags = 0;  
      /* 
        可能还没有用于listen的fd，socket地址等。 
        这里申请一个socket和绑定到一个地址
           （如果调listen之前没有调bind则绑定到随机地址） 
      */  
      err = maybe_new_socket(tcp, AF_INET, flags);  
      if (err)  
        return err;  
      // 设置fd为listen状态  
      if (listen(tcp->io_watcher.fd, backlog))  
        return UV__ERR(errno);  
      // 建立连接后的业务回调  
      tcp->connection_cb = cb;  
      tcp->flags |= UV_HANDLE_BOUND;  
      //  设置io观察者的回调，由epoll监听到连接到来时执行  
      tcp->io_watcher.cb = uv__server_io;  
      /*
          插入观察者队列，这时候还没有增加到epoll，
          Poll IO阶段再遍历观察者队列进行处理（epoll_ctl）
        */  
      uv__io_start(tcp->loop, &tcp->io_watcher, POLLIN);  
      
      return 0;  
    }  
```

监听流的逻辑看起来很多，但是主要的逻辑是把流对的fd改成listen状态，这样流就可以接收连接请求了。接着设置连接到来时执行的回调。最后注册IO观察者到事件循环。等待连接到来。就会执行uv__server_io。uv__server_io再执行connection_cb。监听流和其它流有一个区别是，当IO观察者的事件触发时，监听流执行的回调是uv__server_io函数。而其它流是在uv__stream_io里统一处理。我们看一下连接到来或者Unix域上有数据到来时的处理逻辑。  

```cpp
    void uv__server_io(uv_loop_t* loop, uv__io_t* w, unsigned int events) {  
      uv_stream_t* stream;  
      int err;  
      stream = container_of(w, uv_stream_t, io_watcher);   
      // 注册等待可读事件  
      uv__io_start(stream->loop, &stream->io_watcher, POLLIN);  
      while (uv__stream_fd(stream) != -1) {  
        /*
              通过accept拿到和客户端通信的fd，我们看到这个
              fd和服务器的fd是不一样的 
            */ 
        err = uv__accept(uv__stream_fd(stream));
            // 错误处理 
        if (err < 0) { 
                /* 
                   uv__stream_fd(stream)对应的fd是非阻塞的，
                   返回这个错说明没有连接可用accept了，直接返回
                */  
          if (err == -EAGAIN || err == -EWOULDBLOCK)  
            return;  /* Not an error. */  
          if (err == -ECONNABORTED)  
            continue;  
                // 进程的打开的文件描述符个数达到阈值，看是否有备用的
          if (err == -EMFILE || err == -ENFILE) {  
            err = uv__emfile_trick(loop, uv__stream_fd(stream));
            if (err == -EAGAIN || err == -EWOULDBLOCK)  
              break;  
          }  
          // 发生错误，执行回调  
          stream->connection_cb(stream, err);  
          continue;  
        }   
        // 记录拿到的通信socket对应的fd  
        stream->accepted_fd = err;  
        // 执行上传回调  
        stream->connection_cb(stream, 0);  
        /*
              stream->accepted_fd为-1说明在回调connection_cb里已经消费
              了 accepted_fd，否则先注销服务器在epoll中的fd的读事件，等
              待消费后再注册，即不再处理请求了        
            */  
        if (stream->accepted_fd != -1) {  
          /* 
                  The user hasn't yet accepted called uv_accept() 
                */  
          uv__io_stop(loop, &stream->io_watcher, POLLIN);  
          return;  
        }  
        /* 
          是TCP类型的流并且设置每次只accpet一个连接，则定时阻塞，
              被唤醒后再accept，否则一直accept（如果用户在connect回
              调里消费了accept_fd的话），定时阻塞用于多进程竞争处理连接 
        */  
        if (stream->type == UV_TCP && 
                 (stream->flags & UV_TCP_SINGLE_ACCEPT)) { 
          struct timespec timeout = { 0, 1 };  
          nanosleep(&timeout, NULL);  
        }  
      }  
    }  
```

我们看到连接到来时，Libuv会从已完成连接的队列中摘下一个节点，然后执行connection_cb回调。在connection_cb回调里，需要uv_accept消费accpet_fd。

```cpp
    int uv_accept(uv_stream_t* server, uv_stream_t* client) {  
      int err;  
      switch (client->type) {  
        case UV_NAMED_PIPE:  
        case UV_TCP:  
          // 把文件描述符保存到client  
          err = uv__stream_open(client,
                                        server->accepted_fd,
                                        UV_STREAM_READABLE 
                                        | UV_STREAM_WRITABLE);  
          if (err) {  
            uv__close(server->accepted_fd);  
            goto done;  
          }  
          break;  
      
        case UV_UDP:  
          err = uv_udp_open((uv_udp_t*) client, 
                                    server->accepted_fd);  
          if (err) {  
            uv__close(server->accepted_fd);  
            goto done;  
          }  
          break; 
        default:  
          return -EINVAL;  
      }  
      client->flags |= UV_HANDLE_BOUND;  
      
    done:  
      // 非空则继续放一个到accpet_fd中等待accept,用于文件描述符传递  
      if (server->queued_fds != NULL) {  
        uv__stream_queued_fds_t* queued_fds;  
        queued_fds = server->queued_fds;  
        // 把第一个赋值到accept_fd  
        server->accepted_fd = queued_fds->fds[0];  
        /*
             offset减去一个单位，如果没有了，则释放内存，
              否则需要把后面的往前挪，offset执行最后一个
            */  
        if (--queued_fds->offset == 0) {  
          uv__free(queued_fds);  
          server->queued_fds = NULL;  
        } else {   
          memmove(queued_fds->fds,  
                  queued_fds->fds + 1,  
                  queued_fds->offset * sizeof(*queued_fds->fds));  
        }  
      } else {  
        // 没有排队的fd了，则注册等待可读事件，等待accept新的fd  
        server->accepted_fd = -1;  
        if (err == 0)  
          uv__io_start(server->loop, &server->io_watcher, POLLIN); 
      }  
      return err;  
    }  
```

client是用于和客户端进行通信的流，accept就是把accept_fd保存到client中，client就可以通过fd和对端进行通信了。消费完accept_fd后，如果还有待处理的fd的话，需要补充一个到accept_fd（针对Unix域），其它的继续排队等待处理，如果没有待处理的fd则注册等待可读事件，继续处理新的连接。
## 5.9 销毁流
当我们不再需要一个流的时候，我们会首先调用uv_close关闭这个流，关闭流只是注销了事件和释放了文件描述符，调用uv_close之后，流对应的结构体就会被加入到closing队列，在closing阶段的时候，才会执行销毁流的操作，比如丢弃还没有写完成的数据，执行对应流的回调，我们看看销毁流的函数uv__stream_destroy。

```cpp
    void uv__stream_destroy(uv_stream_t* stream) {  
      // 正在连接，则执行回调  
      if (stream->connect_req) {  
        uv__req_unregister(stream->loop, stream->connect_req);  
        stream->connect_req->cb(stream->connect_req, -ECANCELED);  
        stream->connect_req = NULL;  
      }  
      // 丢弃待写的数据，如果有的话  
      uv__stream_flush_write_queue(stream, -ECANCELED);  
      // 处理写完成队列，这里是处理被丢弃的数据  
      uv__write_callbacks(stream);  
      // 正在关闭流，直接回调  
      if (stream->shutdown_req) {  
        uv__req_unregister(stream->loop, stream->shutdown_req);  
        stream->shutdown_req->cb(stream->shutdown_req, -ECANCELED);  
        stream->shutdown_req = NULL;  
      }  
    }  
```

我们看到，销毁流的时候，如果流中还有待写的数据，则会丢弃。我们看一下uv__stream_flush_write_queue和uv__write_callbacks。

```cpp
    void uv__stream_flush_write_queue(uv_stream_t* stream, int error) {
      uv_write_t* req;  
      QUEUE* q;  
      while (!QUEUE_EMPTY(&stream->write_queue)) {  
        q = QUEUE_HEAD(&stream->write_queue);  
        QUEUE_REMOVE(q); 
        req = QUEUE_DATA(q, uv_write_t, queue);  
        // 把错误写到每个请求中  
        req->error = error; 
        QUEUE_INSERT_TAIL(&stream->write_completed_queue, &req->queue);
      }  
    }  
```

uv__stream_flush_write_queue丢弃待写队列中的请求，并直接插入写完成队列中。uv__write_callbacks是写完或者写出错时执行的函数，它逐个处理写完成队列中的节点，每个节点是一个写请求，执行它的回调，如何分配了堆内存，则释放内存。在写流章节已经分析，不再具体展开。
## 5.10 事件触发的处理
在流的实现中，读写等操作都只是注册事件到epoll，事件触发的时候，会执行统一的回调函数uv__stream_io。下面列一下该函数的代码，具体实现在其它章节已经分析。

```cpp
    static void uv__stream_io(uv_loop_t* loop, 
                                uv__io_t* w, 
                                unsigned int events) {  
      uv_stream_t* stream;  
      stream = container_of(w, uv_stream_t, io_watcher); 
      // 是连接流，则执行连接处理函数  
      if (stream->connect_req) {  
        uv__stream_connect(stream);  
        return;  
      }    
      /*
          Ignore POLLHUP here. Even it it's set, 
          there may still be data to read. 
        */  
      // 可读是触发，则执行读处理  
      if (events & (POLLIN | POLLERR | POLLHUP))  
        uv__read(stream);  
      // 读回调关闭了流  
      if (uv__stream_fd(stream) == -1)  
        return;  /* read_cb closed stream. */  
      /* ¬¬
         POLLHUP说明对端关闭了，即不会发生数据过来了。
              如果流的模式是持续读， 
          1 如果只读取了部分（设置UV_STREAM_READ_PARTIAL），
                  并且没有读到结尾(没有设置UV_STREAM_READ_EOF)， 
           则直接作读结束处理， 
          2 如果只读取了部分，上面的读回调执行了读结束操作，
                  则这里就不需要处理了 
          3 如果没有设置只读了部分，还没有执行读结束操作，
                  则不能作读结束操作，因为对端虽然关闭了，但是之
                  前的传过来的数据可能还没有被消费完 
          4 如果没有设置只读了部分，执行了读结束操作，那这
                  里也不需要处理 
      */  
      if ((events & POLLHUP) &&  
          (stream->flags & UV_STREAM_READING) &&  
          (stream->flags & UV_STREAM_READ_PARTIAL) &&  
          !(stream->flags & UV_STREAM_READ_EOF)) {  
        uv_buf_t buf = { NULL, 0 };  
        uv__stream_eof(stream, &buf);  
      }  
      
      if (uv__stream_fd(stream) == -1)  
        return;  /* read_cb closed stream. */  
      // 可写事件触发  
      if (events & (POLLOUT | POLLERR | POLLHUP)) {  
        // 写数据  
        uv__write(stream);  
        // 写完后做后置处理，释放内存，执行回调等  
        uv__write_callbacks(stream); 
        // 待写队列为空，则注销等待写事件  
        if (QUEUE_EMPTY(&stream->write_queue))  
          uv__drain(stream);  
      }  
    }  
```
