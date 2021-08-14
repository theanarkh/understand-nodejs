Unix域一种进程间通信的方式，Unix域不仅支持没有继承关系的进程间进行通信，而且支持进程间传递文件描述符。Unix域是Node.js中核心的功能，它是进程间通信的底层基础，child_process和cluster模块都依赖Unix域的能力。从实现和使用上来看，Unix域类似TCP，但是因为它是基于同主机进程的，不像TCP需要面临复杂的网络的问题，所以实现也没有TCP那么复杂。Unix域和传统的socket通信一样，遵循网络编程的那一套流程，由于在同主机内，就不必要使用IP和端口的方式。Node.js中，Unix域采用的是一个文件作为标记。大致原理如下。  
1 服务器首先拿到一个socket。  
2 服务器bind一个文件，类似bind一个IP和端口一样，对于操作系统来说，就是新建一个文件（不一定是在硬盘中创建，可以设置抽象路径名），然后把文件路径信息存在socket中。  
3 调用listen修改socket状态为监听状态。  
4 客户端通过同样的文件路径调用connect去连接服务器。这时候用于表示客户端的结构体插入服务器的连接队列，等待处理。  
5 服务器调用accept摘取队列的节点，然后新建一个通信socket和客户端进行通信。  
Unix域通信本质还是基于内存之间的通信，客户端和服务器都维护一块内存，这块内存分为读缓冲区和写缓冲区。从而实现全双工通信，而Unix域的文件路径，只不过是为了让客户端进程可以找到服务端进程，后续就可以互相往对方维护的内存里写数据，从而实现进程间通信。
## 9.1 Unix域在Libuv中的使用
接下来我们看一下在Libuv中关于Unix域的实现和使用。
### 9.1.1 初始化
Unix域使用uv_pipe_t结构体表示，使用之前首先需要初始化uv_pipe_t。下面看一下它的实现逻辑。

```
1.	int uv_pipe_init(uv_loop_t* loop, uv_pipe_t* handle, int ipc) { 
2.	  uv__stream_init(loop, (uv_stream_t*)handle, UV_NAMED_PIPE);  
3.	  handle->shutdown_req = NULL;  
4.	  handle->connect_req = NULL;  
5.	  handle->pipe_fname = NULL;  
6.	  handle->ipc = ipc;  
7.	  return 0;  
8.	}  
```

uv_pipe_init逻辑很简单，就是初始化uv_pipe_t结构体的一些字段。uv_pipe_t继承于stream，uv__stream_init就是初始化stream（父类）的字段。uv_pipe_t中有一个字段ipc，该字段标记了是否允许在该Unix域通信中传递文件描述符。
### 9.1.2 绑定Unix域路径
开头说过，Unix域的实现类似TCP的实现。遵循网络socket编程那一套流程。服务端使用bind，listen等函数启动服务。

```
1.	// name是unix路径名称  
2.	int uv_pipe_bind(uv_pipe_t* handle, const char* name) {  
3.	  struct sockaddr_un saddr;  
4.	  const char* pipe_fname;  
5.	  int sockfd;  
6.	  int err;  
7.	  pipe_fname = NULL; 
8.	  pipe_fname = uv__strdup(name);  
9.	  name = NULL;  
10.	  // 流式Unix域套接字  
11.	  sockfd = uv__socket(AF_UNIX, SOCK_STREAM, 0);  
12.	  memset(&saddr, 0, sizeof saddr);  
13.	  strncpy(saddr.sun_path, pipe_fname, sizeof(saddr.sun_path) - 1);
14.	  saddr.sun_path[sizeof(saddr.sun_path) - 1] = '\0';  
15.	  saddr.sun_family = AF_UNIX;  
16.	  // 绑定到路径，TCP是绑定到IP和端口  
17.	  if (bind(sockfd, (struct sockaddr*)&saddr, sizeof saddr)) { 
18.	   // ...  
19.	  }  
20.	  
21.	  // 设置绑定成功标记  
22.	  handle->flags |= UV_HANDLE_BOUND;
23.	    // Unix域的路径  
24.	  handle->pipe_fname = pipe_fname;   
25.	  // 保存socket对应的fd  
26.	  handle->io_watcher.fd = sockfd;  
27.	  return 0;  
28.	}  
```

uv_pipe_bind函数首先申请一个socket，然后调用操作系统的bind函数把Unix域路径保存到socket中。最后标记已经绑定标记，并且保存Unix域的路径和socket对应的fd到handle中，后续需要使用。我们看到Node.js中Unix域的类型是SOCK_STREAM。Unix域支持两种数据模式。  
1	流式（ SOCK_STREAM），类似TCP，数据为字节流，需要应用层处理粘包问题。  
2	数据报模式（ SOCK_DGRAM ），类似UDP，不需要处理粘包问题。  
通过Unix域虽然可以实现进程间的通信，但是我们拿到的数据可能是"乱的"，这是为什么呢？一般情况下，客户端给服务器发送1个字节，然后服务器处理，如果是基于这种场景，那么数据就不会是乱的。因为每次就是一个需要处理的数据单位。但是如果客户端给服务器发送1个字节，服务器还没来得及处理，客户端又发送了一个字节，那么这时候服务器再处理的时候，就会有问题。因为两个字节混一起了。就好比在一个TCP连接上先后发送两个HTTP请求一样，如果服务器没有办法判断两个请求的数据边界，那么处理就会有问题。所以这时候，我们需要定义一个应用层协议，并且实现封包解包的逻辑，才能真正完成进程间通信。
### 9.1.3 启动服务
绑定了路径后，就可以调用listen函数使得socket处于监听状态。

```
1.	int uv_pipe_listen(uv_pipe_t* handle, int backlog, uv_connection_cb cb) {  
2.	  // uv__stream_fd(handle)得到bind函数中获取的socket  
3.	  if (listen(uv__stream_fd(handle), backlog))  
4.	    return UV__ERR(errno);  
5.	  // 保存回调，有进程调用connect的时候时触发，由uv__server_io函数触发  
6.	  handle->connection_cb = cb;  
7.	  // IO观察者的回调  
8.	  handle->io_watcher.cb = uv__server_io;  
9.	  // 注册IO观察者到Libuv，等待连接，即读事件到来  
10.	  uv__io_start(handle->loop, &handle->io_watcher, POLLIN);  
11.	  return 0;  
12.	}  
```

uv_pipe_listen执行操作系统的listen函数使得socket成为监听型的套接字。然后把socket对应的文件描述符和回调封装成IO观察者。注册到Libuv中。等到有读事件到来（有连接到来）。就会执行uv__server_io函数，摘下对应的客户端节点。最后执行connection_cb回调。
### 9.1.4 发起连接
这时候，我们已经成功启动了一个Unix域服务。接下来就是看客户端的逻辑。

```
1.	void uv_pipe_connect(uv_connect_t* req, 
2.	                      uv_pipe_t* handle, 
3.	                      const char* name, 
4.	                      uv_connect_cb cb) {  
5.	  struct sockaddr_un saddr;  
6.	  int new_sock;  
7.	  int err;  
8.	  int r;  
9.	  // 判断是否已经有socket了，没有的话需要申请一个，见下面  
10.	  new_sock = (uv__stream_fd(handle) == -1);  
11.	  // 客户端还没有对应的socket fd  
12.	  if (new_sock) {  
13.	    handle->io_watcher.fd= uv__socket(AF_UNIX, 
14.	                                           SOCK_STREAM, 
15.	                                           0);  
16.	  }  
17.	  // 需要连接的服务器信息。主要是Unix域路径信息  
18.	  memset(&saddr, 0, sizeof saddr);  
19.	  strncpy(saddr.sun_path, name, sizeof(saddr.sun_path) - 1);  
20.	  saddr.sun_path[sizeof(saddr.sun_path) - 1] = '\0';  
21.	  saddr.sun_family = AF_UNIX;  
22.	  // 非阻塞式连接服务器，Unix域路径是name  
23.	  do {  
24.	    r = connect(uv__stream_fd(handle),
25.	                      (struct sockaddr*)&saddr, sizeof saddr);  
26.	  }  
27.	  while (r == -1 && errno == EINTR);  
28.	  // 忽略错误处理逻辑  
29.	  err = 0;  
30.	  // 设置socket的可读写属性  
31.	  if (new_sock) {  
32.	    err = uv__stream_open((uv_stream_t*)handle,  
33.	                  uv__stream_fd(handle),  
34.	                 UV_HANDLE_READABLE | UV_HANDLE_WRITABLE);  
35.	  }  
36.	  // 把IO观察者注册到Libuv，等到连接成功或者可以发送请求  
37.	  if (err == 0)  
38.	    uv__io_start(handle->loop, 
39.	                     &handle->io_watcher, 
40.	                     POLLIN | POLLOUT);  
41.	  
42.	out:  
43.	  // 记录错误码，如果有的话  
44.	  handle->delayed_error = err;  
45.	  // 保存调用者信息  
46.	  handle->connect_req = req; 
47.	  uv__req_init(handle->loop, req, UV_CONNECT);  
48.	  req->handle = (uv_stream_t*)handle;  
49.	  req->cb = cb;  
50.	  QUEUE_INIT(&req->queue);  
51.	  /*
52.	     如果连接出错，在pending阶段会执行uv__stream_io，
53.	      从而执行req对应的回调。错误码是delayed_error 
54.	    */ 
55.	  if (err)  
56.	    uv__io_feed(handle->loop, &handle->io_watcher);  
57.	}  
```

uv_pipe_connect函数首先以非阻塞的方式调用操作系统的connect函数，调用connect后操作系统把客户端对应的socket直接插入服务器socket的待处理socket队列中，等待服务器处理。这时候socket是处于连接中的状态，当服务器调用accept函数处理连接时，会修改连接状态为已连接（这和TCP不一样，TCP是完成三次握手后就会修改为连接状态，而不是accept的时候），并且会触发客户端socket的可写事件。事件驱动模块就会执行相应的回调（uv__stream_io），从而执行C++和JS的回调。
### 9.1.5 关闭Unix域
我们可以通过uv_close关闭一个Unix域handle。uv_close中会调用uv__pipe_close。

```
1.	void uv__pipe_close(uv_pipe_t* handle) {  
2.	  // 如果是Unix域服务器则需要删除Unix域路径并删除指向的堆内存  
3.	  if (handle->pipe_fname) {  
4.	    unlink(handle->pipe_fname);  
5.	    uv__free((void*)handle->pipe_fname);  
6.	    handle->pipe_fname = NULL;  
7.	  }  
8.	  // 关闭流相关的内容  
9.	  uv__stream_close((uv_stream_t*)handle);  
10.	}  
```

关闭Unix域handle时，Libuv会自动删除Unix域路径对应的文件。但是如果进程异常退出时，该文件可能不会被删除，这样会导致下次监听的时候报错listen EADDRINUSE，所以安全起见，我们可以在进程退出或者监听之前判断该文件是否存在，存在的话则删除。另外还有一个问题是，如果两个不相关的进程使用了同一个文件则会导致误删，所以Unix域对应的文件，我们需要小心处理，最好能保证唯一性。

Unix域大致的流程和网络编程一样。分为服务端和客户端两面。Libuv在操作系统提供的API的基础上。和Libuv的异步非阻塞结合。在Libuv中为进程间提供了一种通信方式。下面看一下在Node.js中是如何使用Libuv提供的功能的。
## 9.2 Unix域在Node.js中的使用
### 9.2.1 Unix域服务器
在Node.js中，我们可以通过以下代码创建一个Unix域服务器

```
1.	const server = net.createServer((client) => {  
2.	  // 处理client  
3.	});  
4.	server.listen('/tmp/test.sock', () => {  
5.	  console.log(`bind uinx domain success`);  
6.	});  
```

我们从listen函数开始分析这个过程。

```
1.	Server.prototype.listen = function(...args) {  
2.	  const normalized = normalizeArgs(args);  
3.	  let options = normalized[0];  
4.	  const cb = normalized[1];  
5.	  // 调用底层的listen函数成功后执行的回调  
6.	  if (cb !== null) {  
7.	    this.once('listening', cb);  
8.	  }  
9.	  if (options.path && isPipeName(options.path)) {  
10.	    const pipeName = this._pipeName = options.path;  
11.	    backlog = options.backlog || backlogFromArgs;  
12.	    listenIncluster(this, pipeName, -1, -1, backlog, undefined, 
13.	                      options.exclusive);  
14.	    /*
15.	      Unix域使用文件实现的，客户端需要访问该文件的权限才能通信，
16.	      这里做权限控制 
17.	     */ 
18.	    let mode = 0;  
19.	    if (options.readableAll === true)  
20.	      mode |= PipeConstants.UV_READABLE;  
21.	    if (options.writableAll === true)  
22.	      mode |= PipeConstants.UV_WRITABLE;  
23.	    if (mode !== 0) {  
24.	      // 修改文件的访问属性  
25.	      const err = this._handle.fchmod(mode);  
26.	      if (err) {  
27.	        this._handle.close();  
28.	        this._handle = null;  
29.	        throw errnoException(err, 'uv_pipe_chmod');  
30.	      }  
31.	    }  
32.	    return this;  
33.	  }  
34.	}  
```

这段代码中最主要的是listenIncluster函数。我们看一下该函数的逻辑。

```
1.	function listenIncluster(server, address, port, addressType,  
2.	                         backlog, fd, exclusive, flags) {  
3.	  exclusive = !!exclusive; 
4.	  if (cluster === undefined) cluster = require('cluster');  
5.	  if (cluster.isMaster || exclusive) {  
6.	    server._listen2(address, port, addressType, backlog, fd, flags);  
7.	    return;  
8.	  }  
9.	}  
```

直接调用_listen2（isMaster只有在cluster.fork创建的进程中才是false，其余情况都是true，包括child_process模块创建的子进程）。我们继续看listen函数。

```
1.	Server.prototype._listen2 = setupListenHandle;
2.	
3.	function setupListenHandle(address, 
4.	                              port, 
5.	                              addressType, 
6.	                              backlog, 
7.	                              fd, 
8.	                              flags) {  
9.	  this._handle = createServerHandle(address, 
10.	                                       port, 
11.	                                       addressType, 
12.	                                       fd, 
13.	                                       flags);  
14.	  // 有完成连接完成时触发  
15.	  this._handle.onconnection = onconnection;  
16.	  const err = this._handle.listen(backlog || 511);  
17.	  if (err) {  
18.	    // 触发error事件
19.	  }  
20.	  // 下一个tick触发listen回调  
21.	  defaultTriggerAsyncIdScope(this[async_id_symbol],  
22.	                             process.nextTick,  
23.	                             emitListeningNT,  
24.	                             this);  
25.	} 
首先调用createServerHandle创建一个handle，然后执行listen函数。我们首先看一下createServerHandle。
26.	function createServerHandle(address, 
27.	                               port, 
28.	                               addressType, 
29.	                               fd, 
30.	                               flags) {  
31.	  let handle = new Pipe(PipeConstants.SERVER);  
32.	  handle.bind(address, port);  
33.	  return handle;  
34.	}  
```

创建了一个Pipe对象，然后调用它的bind和listen函数，我们看new Pipe的逻辑，从pipe_wrap.cc的导出逻辑，我们知道，这时候会新建一个C++对象，然后执行New函数，并且把新建的C++对象等信息作为入参。

```
1.	void PipeWrap::New(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	  // 类型  
4.	  int type_value = args[0].As<Int32>()->Value();  
5.	  PipeWrap::SocketType type = static_cast<PipeWrap::SocketType>(type_value);  
6.	  // 是否是用于IPC
7.	  bool ipc;  
8.	  ProviderType provider;  
9.	  switch (type) {  
10.	    case SOCKET:  
11.	      provider = PROVIDER_PIPEWRAP;  
12.	      ipc = false;  
13.	      break;  
14.	    case SERVER:  
15.	      provider = PROVIDER_PIPESERVERWRAP;  
16.	      ipc = false;  
17.	      break;  
18.	    case IPC:  
19.	      provider = PROVIDER_PIPEWRAP;  
20.	      ipc = true;  
21.	      break;  
22.	    default:  
23.	      UNREACHABLE();  
24.	  }  
25.	  
26.	  new PipeWrap(env, args.This(), provider, ipc);  
27.	}  
```

New函数处理了参数，然后执行了new PipeWrap创建一个对象。
```
1.	PipeWrap::PipeWrap(Environment* env,  
2.	                   Local<Object> object,  
3.	                   ProviderType provider,  
4.	                   bool ipc)  
5.	    : ConnectionWrap(env, object, provider) {  
6.	  int r = uv_pipe_init(env->event_loop(), &handle_, ipc);  
7.	}
```
new Pipe执行完后，就会通过该C++对象调用Libuv的bind和listen完成服务器的启动，就不再展开分析。
### 9.2.2 Unix域客户端
接着我们看一下Unix域作为客户端使用时的过程。

```
1.	Socket.prototype.connect = function(...args) {  
2.	  const path = options.path;  
3.	  // Unix域路径  
4.	  var pipe = !!path;  
5.	  if (!this._handle) {  
6.	    // 创建一个C++层handle，即pipe_wrap.cc导出的Pipe类  
7.	    this._handle = pipe ?  
8.	      new Pipe(PipeConstants.SOCKET) :  
9.	      new TCP(TCPConstants.SOCKET);  
10.	    // 挂载onread方法到this中  
11.	    initSocketHandle(this);  
12.	  }  
13.	  
14.	  if (cb !== null) {  
15.	    this.once('connect', cb);  
16.	  }  
17.	  // 执行internalConnect  
18.	  defaultTriggerAsyncIdScope(  
19.	      this[async_id_symbol], internalConnect, this, path  
20.	  );  
21.	  return this;  
22.	};  
```

首先新建一个handle，值是new Pipe。接着执行了internalConnect，internalConnect函数的主要逻辑如下

```
1.	const req = new PipeConnectWrap();  
2.	// address为Unix域路径
3.	req.address = address;  
4.	req.oncomplete = afterConnect;  
5.	// 调用C++层connect
6.	err = self._handle.connect(req, address, afterConnect);  
我们看C++层的connect函数，
1.	void PipeWrap::Connect(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	  
4.	  PipeWrap* wrap;  
5.	  ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
6.	  // PipeConnectWrap对象  
7.	  Local<Object> req_wrap_obj = args[0].As<Object>();  
8.	  // Unix域路径  
9.	  node::Utf8Value name(env->isolate(), args[1]);  
10.	  /*
11.	      新建一个ConnectWrap对象，ConnectWrap是对handle进行一次连接请求
12.	       的封装，内部维护一个uv_connect_t结构体， req_wrap_obj的一个字段
13.	       指向ConnectWrap对象，用于保存对应的请求上下文  
14.	    */
15.	  ConnectWrap* req_wrap =  
16.	      new ConnectWrap(env, 
17.	                             req_wrap_obj, 
18.	                             AsyncWrap::PROVIDER_PIPECONNECTWRAP);  
19.	  // 调用Libuv的connect函数  
20.	  uv_pipe_connect(req_wrap->req(),  
21.	                  &wrap->handle_,  
22.	                  *name,  
23.	                  AfterConnect);  
24.	    // req_wrap->req_.data = req_wrap;关联起来
25.	  req_wrap->Dispatched();  
26.	  // uv_pipe_connect() doesn't return errors.  
27.	  args.GetReturnValue().Set(0);  
28.	}  
```

uv_pipe_connect函数，第一个参数是uv_connect_t结构体（request），第二个是一个uv_pipe_t结构体（handle），handle是对Unix域客户端的封装，request是请求的封装，它表示基于handle发起一次连接请求。连接成功后会执行AfterConnect。由前面分析我们知道，当连接成功时，首先会执行回调Libuv的uv__stream_io，然后执行C++层的AfterConnect。

```
1.	// 主动发起连接，成功/失败后的回调  
2.	template <typename WrapType,typename UVType> = PipeWrap, uv_pipe_t
3.	void ConnectionWrap<WrapType, UVType>::AfterConnect(uv_connect_t* req        
4.	                                                      ,int status) { 
5.	  // 在Connect函数里关联起来的  
6.	  ConnectWrap* req_wrap = static_cast<ConnectWrap*>(req->data);  
7.	  // 在uv_pipe_connect中完成关联的  
8.	  WrapType* wrap = static_cast<WrapType*>(req->handle->data);  
9.	  Environment* env = wrap->env();  
10.	  
11.	  HandleScope handle_scope(env->isolate());  
12.	  Context::Scope context_scope(env->context());  
13.	  
14.	  bool readable, writable;  
15.	  // 是否连接成功  
16.	  if (status) {  
17.	    readable = writable = 0;  
18.	  } else {  
19.	    readable = uv_is_readable(req->handle) != 0;  
20.	    writable = uv_is_writable(req->handle) != 0;  
21.	  }  
22.	  
23.	  Local<Value> argv[5] = {  
24.	    Integer::New(env->isolate(), status),  
25.	    wrap->object(),  
26.	    req_wrap->object(),  
27.	    Boolean::New(env->isolate(), readable),  
28.	    Boolean::New(env->isolate(), writable)  
29.	  };  
30.	  // 执行JS层的oncomplete回调  
31.	  req_wrap->MakeCallback(env->oncomplete_string(), 
32.	                           arraysize(argv), 
33.	                           argv);  
34.	  
35.	  delete req_wrap;  
36.	}  
```

我们再回到JS层的afterConnect

```
1.	function afterConnect(status, handle, req, readable, writable) { 
2.	  var self = handle.owner;  
3.	  handle = self._handle;  
4.	  if (status === 0) {  
5.	    self.readable = readable;  
6.	    self.writable = writable;  
7.	    self._unrefTimer();  
8.	    // 触发connect事件  
9.	    self.emit('connect');  
10.	    // 可读并且没有处于暂停模式，则注册等待可读事件  
11.	    if (readable && !self.isPaused())  
12.	      self.read(0);  
13.	  }  
14.	}  
```

至此，作为客户端对服务器的连接就完成了。后续就可以进行通信。
