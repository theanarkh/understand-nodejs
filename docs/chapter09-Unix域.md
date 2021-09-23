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
    int uv_pipe_init(uv_loop_t* loop, uv_pipe_t* handle, int ipc) { 
      uv__stream_init(loop, (uv_stream_t*)handle, UV_NAMED_PIPE);  
      handle->shutdown_req = NULL;  
      handle->connect_req = NULL;  
      handle->pipe_fname = NULL;  
      handle->ipc = ipc;  
      return 0;  
    }  
```

uv_pipe_init逻辑很简单，就是初始化uv_pipe_t结构体的一些字段。uv_pipe_t继承于stream，uv__stream_init就是初始化stream（父类）的字段。uv_pipe_t中有一个字段ipc，该字段标记了是否允许在该Unix域通信中传递文件描述符。
### 9.1.2 绑定Unix域路径
开头说过，Unix域的实现类似TCP的实现。遵循网络socket编程那一套流程。服务端使用bind，listen等函数启动服务。

```
    // name是unix路径名称  
    int uv_pipe_bind(uv_pipe_t* handle, const char* name) {  
      struct sockaddr_un saddr;  
      const char* pipe_fname;  
      int sockfd;  
      int err;  
      pipe_fname = NULL; 
      pipe_fname = uv__strdup(name);  
      name = NULL;  
      // 流式Unix域套接字  
      sockfd = uv__socket(AF_UNIX, SOCK_STREAM, 0);  
      memset(&saddr, 0, sizeof saddr);  
      strncpy(saddr.sun_path, pipe_fname, sizeof(saddr.sun_path) - 1);
      saddr.sun_path[sizeof(saddr.sun_path) - 1] = '\0';  
      saddr.sun_family = AF_UNIX;  
      // 绑定到路径，TCP是绑定到IP和端口  
      if (bind(sockfd, (struct sockaddr*)&saddr, sizeof saddr)) { 
       // ...  
      }  
      
      // 设置绑定成功标记  
      handle->flags |= UV_HANDLE_BOUND;
        // Unix域的路径  
      handle->pipe_fname = pipe_fname;   
      // 保存socket对应的fd  
      handle->io_watcher.fd = sockfd;  
      return 0;  
    }  
```

uv_pipe_bind函数首先申请一个socket，然后调用操作系统的bind函数把Unix域路径保存到socket中。最后标记已经绑定标记，并且保存Unix域的路径和socket对应的fd到handle中，后续需要使用。我们看到Node.js中Unix域的类型是SOCK_STREAM。Unix域支持两种数据模式。  
1	流式（ SOCK_STREAM），类似TCP，数据为字节流，需要应用层处理粘包问题。  
2	数据报模式（ SOCK_DGRAM ），类似UDP，不需要处理粘包问题。  
通过Unix域虽然可以实现进程间的通信，但是我们拿到的数据可能是"乱的"，这是为什么呢？一般情况下，客户端给服务器发送1个字节，然后服务器处理，如果是基于这种场景，那么数据就不会是乱的。因为每次就是一个需要处理的数据单位。但是如果客户端给服务器发送1个字节，服务器还没来得及处理，客户端又发送了一个字节，那么这时候服务器再处理的时候，就会有问题。因为两个字节混一起了。就好比在一个TCP连接上先后发送两个HTTP请求一样，如果服务器没有办法判断两个请求的数据边界，那么处理就会有问题。所以这时候，我们需要定义一个应用层协议，并且实现封包解包的逻辑，才能真正完成进程间通信。
### 9.1.3 启动服务
绑定了路径后，就可以调用listen函数使得socket处于监听状态。

```
    int uv_pipe_listen(uv_pipe_t* handle, int backlog, uv_connection_cb cb) {  
      // uv__stream_fd(handle)得到bind函数中获取的socket  
      if (listen(uv__stream_fd(handle), backlog))  
        return UV__ERR(errno);  
      // 保存回调，有进程调用connect的时候时触发，由uv__server_io函数触发  
      handle->connection_cb = cb;  
      // IO观察者的回调  
      handle->io_watcher.cb = uv__server_io;  
      // 注册IO观察者到Libuv，等待连接，即读事件到来  
      uv__io_start(handle->loop, &handle->io_watcher, POLLIN);  
      return 0;  
    }  
```

uv_pipe_listen执行操作系统的listen函数使得socket成为监听型的套接字。然后把socket对应的文件描述符和回调封装成IO观察者。注册到Libuv中。等到有读事件到来（有连接到来）。就会执行uv__server_io函数，摘下对应的客户端节点。最后执行connection_cb回调。
### 9.1.4 发起连接
这时候，我们已经成功启动了一个Unix域服务。接下来就是看客户端的逻辑。

```
    void uv_pipe_connect(uv_connect_t* req, 
                          uv_pipe_t* handle, 
                          const char* name, 
                          uv_connect_cb cb) {  
      struct sockaddr_un saddr;  
      int new_sock;  
      int err;  
      int r;  
      // 判断是否已经有socket了，没有的话需要申请一个，见下面  
      new_sock = (uv__stream_fd(handle) == -1);  
      // 客户端还没有对应的socket fd  
      if (new_sock) {  
        handle->io_watcher.fd= uv__socket(AF_UNIX, 
                                               SOCK_STREAM, 
                                               0);  
      }  
      // 需要连接的服务器信息。主要是Unix域路径信息  
      memset(&saddr, 0, sizeof saddr);  
      strncpy(saddr.sun_path, name, sizeof(saddr.sun_path) - 1);  
      saddr.sun_path[sizeof(saddr.sun_path) - 1] = '\0';  
      saddr.sun_family = AF_UNIX;  
      // 非阻塞式连接服务器，Unix域路径是name  
      do {  
        r = connect(uv__stream_fd(handle),
                          (struct sockaddr*)&saddr, sizeof saddr);  
      }  
      while (r == -1 && errno == EINTR);  
      // 忽略错误处理逻辑  
      err = 0;  
      // 设置socket的可读写属性  
      if (new_sock) {  
        err = uv__stream_open((uv_stream_t*)handle,  
                      uv__stream_fd(handle),  
                     UV_HANDLE_READABLE | UV_HANDLE_WRITABLE);  
      }  
      // 把IO观察者注册到Libuv，等到连接成功或者可以发送请求  
      if (err == 0)  
        uv__io_start(handle->loop, 
                         &handle->io_watcher, 
                         POLLIN | POLLOUT);  
      
    out:  
      // 记录错误码，如果有的话  
      handle->delayed_error = err;  
      // 保存调用者信息  
      handle->connect_req = req; 
      uv__req_init(handle->loop, req, UV_CONNECT);  
      req->handle = (uv_stream_t*)handle;  
      req->cb = cb;  
      QUEUE_INIT(&req->queue);  
      /*
         如果连接出错，在pending阶段会执行uv__stream_io，
          从而执行req对应的回调。错误码是delayed_error 
        */ 
      if (err)  
        uv__io_feed(handle->loop, &handle->io_watcher);  
    }  
```

uv_pipe_connect函数首先以非阻塞的方式调用操作系统的connect函数，调用connect后操作系统把客户端对应的socket直接插入服务器socket的待处理socket队列中，等待服务器处理。这时候socket是处于连接中的状态，当服务器调用accept函数处理连接时，会修改连接状态为已连接（这和TCP不一样，TCP是完成三次握手后就会修改为连接状态，而不是accept的时候），并且会触发客户端socket的可写事件。事件驱动模块就会执行相应的回调（uv__stream_io），从而执行C++和JS的回调。
### 9.1.5 关闭Unix域
我们可以通过uv_close关闭一个Unix域handle。uv_close中会调用uv__pipe_close。

```
    void uv__pipe_close(uv_pipe_t* handle) {  
      // 如果是Unix域服务器则需要删除Unix域路径并删除指向的堆内存  
      if (handle->pipe_fname) {  
        unlink(handle->pipe_fname);  
        uv__free((void*)handle->pipe_fname);  
        handle->pipe_fname = NULL;  
      }  
      // 关闭流相关的内容  
      uv__stream_close((uv_stream_t*)handle);  
    }  
```

关闭Unix域handle时，Libuv会自动删除Unix域路径对应的文件。但是如果进程异常退出时，该文件可能不会被删除，这样会导致下次监听的时候报错listen EADDRINUSE，所以安全起见，我们可以在进程退出或者监听之前判断该文件是否存在，存在的话则删除。另外还有一个问题是，如果两个不相关的进程使用了同一个文件则会导致误删，所以Unix域对应的文件，我们需要小心处理，最好能保证唯一性。

Unix域大致的流程和网络编程一样。分为服务端和客户端两面。Libuv在操作系统提供的API的基础上。和Libuv的异步非阻塞结合。在Libuv中为进程间提供了一种通信方式。下面看一下在Node.js中是如何使用Libuv提供的功能的。
## 9.2 Unix域在Node.js中的使用
### 9.2.1 Unix域服务器
在Node.js中，我们可以通过以下代码创建一个Unix域服务器

```
    const server = net.createServer((client) => {  
      // 处理client  
    });  
    server.listen('/tmp/test.sock', () => {  
      console.log(`bind uinx domain success`);  
    });  
```

我们从listen函数开始分析这个过程。

```
    Server.prototype.listen = function(...args) {  
      const normalized = normalizeArgs(args);  
      let options = normalized[0];  
      const cb = normalized[1];  
      // 调用底层的listen函数成功后执行的回调  
      if (cb !== null) {  
        this.once('listening', cb);  
      }  
      if (options.path && isPipeName(options.path)) {  
        const pipeName = this._pipeName = options.path;  
        backlog = options.backlog || backlogFromArgs;  
        listenIncluster(this, pipeName, -1, -1, backlog, undefined, 
                          options.exclusive);  
        /*
          Unix域使用文件实现的，客户端需要访问该文件的权限才能通信，
          这里做权限控制 
         */ 
        let mode = 0;  
        if (options.readableAll === true)  
          mode |= PipeConstants.UV_READABLE;  
        if (options.writableAll === true)  
          mode |= PipeConstants.UV_WRITABLE;  
        if (mode !== 0) {  
          // 修改文件的访问属性  
          const err = this._handle.fchmod(mode);  
          if (err) {  
            this._handle.close();  
            this._handle = null;  
            throw errnoException(err, 'uv_pipe_chmod');  
          }  
        }  
        return this;  
      }  
    }  
```

这段代码中最主要的是listenIncluster函数。我们看一下该函数的逻辑。

```
    function listenIncluster(server, address, port, addressType,  
                             backlog, fd, exclusive, flags) {  
      exclusive = !!exclusive; 
      if (cluster === undefined) cluster = require('cluster');  
      if (cluster.isMaster || exclusive) {  
        server._listen2(address, port, addressType, backlog, fd, flags);  
        return;  
      }  
    }  
```

直接调用_listen2（isMaster只有在cluster.fork创建的进程中才是false，其余情况都是true，包括child_process模块创建的子进程）。我们继续看listen函数。

```
    Server.prototype._listen2 = setupListenHandle;
    
    function setupListenHandle(address, 
                                  port, 
                                  addressType, 
                                  backlog, 
                                  fd, 
                                  flags) {  
      this._handle = createServerHandle(address, 
                                           port, 
                                           addressType, 
                                           fd, 
                                           flags);  
      // 有完成连接完成时触发  
      this._handle.onconnection = onconnection;  
      const err = this._handle.listen(backlog || 511);  
      if (err) {  
        // 触发error事件
      }  
      // 下一个tick触发listen回调  
      defaultTriggerAsyncIdScope(this[async_id_symbol],  
                                 process.nextTick,  
                                 emitListeningNT,  
                                 this);  
    } 
首先调用createServerHandle创建一个handle，然后执行listen函数。我们首先看一下createServerHandle。
    function createServerHandle(address, 
                                   port, 
                                   addressType, 
                                   fd, 
                                   flags) {  
      let handle = new Pipe(PipeConstants.SERVER);  
      handle.bind(address, port);  
      return handle;  
    }  
```

创建了一个Pipe对象，然后调用它的bind和listen函数，我们看new Pipe的逻辑，从pipe_wrap.cc的导出逻辑，我们知道，这时候会新建一个C++对象，然后执行New函数，并且把新建的C++对象等信息作为入参。

```
    void PipeWrap::New(const FunctionCallbackInfo<Value>& args) {  
      Environment* env = Environment::GetCurrent(args);  
      // 类型  
      int type_value = args[0].As<Int32>()->Value();  
      PipeWrap::SocketType type = static_cast<PipeWrap::SocketType>(type_value);  
      // 是否是用于IPC
      bool ipc;  
      ProviderType provider;  
      switch (type) {  
        case SOCKET:  
          provider = PROVIDER_PIPEWRAP;  
          ipc = false;  
          break;  
        case SERVER:  
          provider = PROVIDER_PIPESERVERWRAP;  
          ipc = false;  
          break;  
        case IPC:  
          provider = PROVIDER_PIPEWRAP;  
          ipc = true;  
          break;  
        default:  
          UNREACHABLE();  
      }  
      
      new PipeWrap(env, args.This(), provider, ipc);  
    }  
```

New函数处理了参数，然后执行了new PipeWrap创建一个对象。
```
    PipeWrap::PipeWrap(Environment* env,  
                       Local<Object> object,  
                       ProviderType provider,  
                       bool ipc)  
        : ConnectionWrap(env, object, provider) {  
      int r = uv_pipe_init(env->event_loop(), &handle_, ipc);  
    }
```
new Pipe执行完后，就会通过该C++对象调用Libuv的bind和listen完成服务器的启动，就不再展开分析。
### 9.2.2 Unix域客户端
接着我们看一下Unix域作为客户端使用时的过程。

```
    Socket.prototype.connect = function(...args) {  
      const path = options.path;  
      // Unix域路径  
      var pipe = !!path;  
      if (!this._handle) {  
        // 创建一个C++层handle，即pipe_wrap.cc导出的Pipe类  
        this._handle = pipe ?  
          new Pipe(PipeConstants.SOCKET) :  
          new TCP(TCPConstants.SOCKET);  
        // 挂载onread方法到this中  
        initSocketHandle(this);  
      }  
      
      if (cb !== null) {  
        this.once('connect', cb);  
      }  
      // 执行internalConnect  
      defaultTriggerAsyncIdScope(  
          this[async_id_symbol], internalConnect, this, path  
      );  
      return this;  
    };  
```

首先新建一个handle，值是new Pipe。接着执行了internalConnect，internalConnect函数的主要逻辑如下

```
    const req = new PipeConnectWrap();  
    // address为Unix域路径
    req.address = address;  
    req.oncomplete = afterConnect;  
    // 调用C++层connect
    err = self._handle.connect(req, address, afterConnect);  
我们看C++层的connect函数，
    void PipeWrap::Connect(const FunctionCallbackInfo<Value>& args) {  
      Environment* env = Environment::GetCurrent(args);  
      
      PipeWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
      // PipeConnectWrap对象  
      Local<Object> req_wrap_obj = args[0].As<Object>();  
      // Unix域路径  
      node::Utf8Value name(env->isolate(), args[1]);  
      /*
          新建一个ConnectWrap对象，ConnectWrap是对handle进行一次连接请求
           的封装，内部维护一个uv_connect_t结构体， req_wrap_obj的一个字段
           指向ConnectWrap对象，用于保存对应的请求上下文  
        */
      ConnectWrap* req_wrap =  
          new ConnectWrap(env, 
                                 req_wrap_obj, 
                                 AsyncWrap::PROVIDER_PIPECONNECTWRAP);  
      // 调用Libuv的connect函数  
      uv_pipe_connect(req_wrap->req(),  
                      &wrap->handle_,  
                      *name,  
                      AfterConnect);  
        // req_wrap->req_.data = req_wrap;关联起来
      req_wrap->Dispatched();  
      // uv_pipe_connect() doesn't return errors.  
      args.GetReturnValue().Set(0);  
    }  
```

uv_pipe_connect函数，第一个参数是uv_connect_t结构体（request），第二个是一个uv_pipe_t结构体（handle），handle是对Unix域客户端的封装，request是请求的封装，它表示基于handle发起一次连接请求。连接成功后会执行AfterConnect。由前面分析我们知道，当连接成功时，首先会执行回调Libuv的uv__stream_io，然后执行C++层的AfterConnect。

```
    // 主动发起连接，成功/失败后的回调  
    template <typename WrapType,typename UVType> = PipeWrap, uv_pipe_t
    void ConnectionWrap<WrapType, UVType>::AfterConnect(uv_connect_t* req        
                                                          ,int status) { 
      // 在Connect函数里关联起来的  
      ConnectWrap* req_wrap = static_cast<ConnectWrap*>(req->data);  
      // 在uv_pipe_connect中完成关联的  
      WrapType* wrap = static_cast<WrapType*>(req->handle->data);  
      Environment* env = wrap->env();  
      
      HandleScope handle_scope(env->isolate());  
      Context::Scope context_scope(env->context());  
      
      bool readable, writable;  
      // 是否连接成功  
      if (status) {  
        readable = writable = 0;  
      } else {  
        readable = uv_is_readable(req->handle) != 0;  
        writable = uv_is_writable(req->handle) != 0;  
      }  
      
      Local<Value> argv[5] = {  
        Integer::New(env->isolate(), status),  
        wrap->object(),  
        req_wrap->object(),  
        Boolean::New(env->isolate(), readable),  
        Boolean::New(env->isolate(), writable)  
      };  
      // 执行JS层的oncomplete回调  
      req_wrap->MakeCallback(env->oncomplete_string(), 
                               arraysize(argv), 
                               argv);  
      
      delete req_wrap;  
    }  
```

我们再回到JS层的afterConnect

```
    function afterConnect(status, handle, req, readable, writable) { 
      var self = handle.owner;  
      handle = self._handle;  
      if (status === 0) {  
        self.readable = readable;  
        self.writable = writable;  
        self._unrefTimer();  
        // 触发connect事件  
        self.emit('connect');  
        // 可读并且没有处于暂停模式，则注册等待可读事件  
        if (readable && !self.isPaused())  
          self.read(0);  
      }  
    }  
```

至此，作为客户端对服务器的连接就完成了。后续就可以进行通信。
