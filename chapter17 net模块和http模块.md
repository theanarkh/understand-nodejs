# 第十七章 net模块和http模块
Net模块是对tcp和unix域的抽象。
## 17.1 tcp客户端
### 17.1.1 建立连接
connect是发起tcp连接的api。本质上是对底层tcp协议connect函数的封装。我们看一下nodejs里做了什么事情。我们首先看一下connect函数的入口定义。

```c
1.// connect(options, [cb])  
2.// connect(port, [host], [cb])  
3.// connect(path, [cb]);  
4.// 对socket connect的封装  
5.function connect(...args) {  
6.  // 处理参数  
7.  var normalized = normalizeArgs(args);  
8.  var options = normalized[0];  
9.  // 申请一个socket表示一个连接  
10.  var socket = new Socket(options);  
11.  // 设置连接超时时间  
12.  if (options.timeout) {  
13.    socket.setTimeout(options.timeout);  
14.  }  
15.  // 调用socket的connect  
16.  return Socket.prototype.connect.call(socket, normalized);  
17.}  
```

从代码中可以发现，connect函数是对Socket对象的封装。Socket表示一个tcp连接。我们分成三部分分析。 

 1. new Socket  
 2. setTimeout  
 3. Socket的connect

**1 new Socket**  

我们看看新建一个Socket对象，做了什么事情。  

```c
1.function Socket(options) {  
2.  if (!(this instanceof Socket)) return new Socket(options);  
3.  // 是否正在建立连接，即三次握手中  
4.  this.connecting = false;  
5.  // 触发close事件时，该字段标记是否由于错误导致了close事件  
6.  this._hadError = false;  
7.  // 对应的底层handle，比如tcp  
8.  this._handle = null;  
9.  // 定时器id  
10.  this[kTimeout] = null;  
11.  options = options || {};  
12.  // 双工  
13.  stream.Duplex.call(this, options);  
14.  // 还不能读写，先设置成false  
15.  // these will be set once there is a connection  
16.  this.readable = this.writable = false;  
17.  this.on('finish', onSocketFinish);  
18.  this.on('_socketEnd', onSocketEnd);  
19.  // 是否允许单工  
20.  this.allowHalfOpen = options && options.allowHalfOpen || false;  
21.}  
```

其实也没有做太多的事情，就是初始化一些属性。

**2 setTimeout** 	

```c
1.Socket.prototype.setTimeout = function(msecs, callback) {  
2.  // 清除之前的，如果有的话  
3.  clearTimeout(this[kTimeout]);  
4.  // 0代表清除  
5.  if (msecs === 0) {  
6.    if (callback) {  
7.      this.removeListener('timeout', callback);  
8.    }  
9.  } else {  
10.    // 开启一个定时器，超时时间是msecs，超时回调是_onTimeout  
11.    this[kTimeout] = setUnrefTimeout(this._onTimeout.bind(this), msecs);  
12.    // 监听timeout事件，定时器超时时，底层会调用nodejs的回调，nodejs会调用用户的回调callback  
13.    if (callback) {  
14.      this.once('timeout', callback);  
15.    }  
16.  }  
17.  return this;  
18.};  
```

setTimeout做的事情就是设置一个超时时间，如果超时则执行回调，在回调里再触发用户传入的回调。我们看一下超时处理函数_onTimeout。 

```c
1.Socket.prototype._onTimeout = function() {  
2.  this.emit('timeout');  
3.};
```

直接触发timeout函数，回调用户的函数。  

**3 connect函数**  

```c
1.// 建立连接，即三次握手  
2.Socket.prototype.connect = function(...args) {  
3.  let normalized;  
4.  /* 忽略参数处理 */  
5.  var options = normalized[0];  
6.  var cb = normalized[1];  
7.  
8.  if (this.write !== Socket.prototype.write)  
9.    this.write = Socket.prototype.write;  
10.  
11.  this._handle = new TCP(TCPConstants.SOCKET);  
12.  this._handle.onread = onread;  
13.  // 连接成功，执行的回调  
14.  if (cb !== null) {  
15.    this.once('connect', cb);  
16.  }  
17.  // 正在连接  
18.  this.connecting = true;  
19.  this.writable = true;  
20.  // 可能需要dns解析，解析成功再发起连接  
21.  lookupAndConnect(this, options);  
22.  return this;  
23.};  
```

connect 函数主要是三个逻辑 

 1. 首先创建一个底层的handle，比如我们这里是tcp（对应tcp_wrap.cc的实现）。
 2. 设置一些回调 
 3. 做dns解析（如果需要的话），然后发起三次握手。

我们看一下new TCP意味着什么，我们看tcp_wrap.cc的实现

```c
1.void TCPWrap::New(const FunctionCallbackInfo<Value>& args) {  
2.  // 要以new TCP的形式调用  
3.  CHECK(args.IsConstructCall());  
4.  // 第一个入参是数字  
5.  CHECK(args[0]->IsInt32());  
6.  Environment* env = Environment::GetCurrent(args);  
7.  // 作为客户端还是服务器  
8.  int type_value = args[0].As<Int32>()->Value();  
9.  TCPWrap::SocketType type = static_cast<TCPWrap::SocketType>(type_value);  
10.  
11.  ProviderType provider;  
12.  switch (type) {  
13.    // 作为客户端，即发起连接方  
14.    case SOCKET:  
15.      provider = PROVIDER_TCPWRAP;  
16.      break;  
17.    // 作为服务器  
18.    case SERVER:  
19.      provider = PROVIDER_TCPSERVERWRAP;  
20.      break;  
21.    default:  
22.      UNREACHABLE();  
23.  }  
24.  
25.  new TCPWrap(env, args.This(), provider);  
26.}  
```

new TCP对应到c++层，就是创建一个TCPWrap对象。

```c
1.TCPWrap::TCPWrap(Environment* env, Local<Object> object, ProviderType provider)  
2.    : ConnectionWrap(env, object, provider) {  
3.  int r = uv_tcp_init(env->event_loop(), &handle_);  
4.}  
```

在执行基类构造函数时会使object的一个字段指向新建的TCPWrap对象。我们看到函数里还执行了uv_tcp_init

```c
1.int uv_tcp_init_ex(uv_loop_t* loop, uv_tcp_t* tcp, unsigned int flags) {  
2.  int domain;  
3.  domain = flags & 0xFF;  
4.  if (domain != AF_INET && domain != AF_INET6 && domain != AF_UNSPEC)  
5.    return -EINVAL;  
6.  
7.  if (flags & ~0xFF)  
8.    return -EINVAL;  
9.  // 初始化流的字段  
10.  uv__stream_init(loop, (uv_stream_t*)tcp, UV_TCP);  
11.  if (domain != AF_UNSPEC) {  
12.    // 新建一个socket，把fd保存到tcp  
13.    int err = maybe_new_socket(tcp, domain, 0);  
14.    if (err) {  
15.      QUEUE_REMOVE(&tcp->handle_queue);  
16.      return err;  
17.    }  
18.  }  
19.  return 0;  
20.}  
```

我们继续看lookupAndConnect，lookupAndConnect主要是对参数进行校验，然后进行dns解析（如果传的是域名的话），dns解析成功后执行internalConnect

```c
1.function internalConnect(  
2.  self,   
3.  // 需要连接的远端ip、端口  
4.  address,   
5.  port,   
6.  addressType,   
7.  // 用于和对端连接的本地ip、端口（如果不设置，则操作系统自己决定）  
8.  localAddress,   
9.  localPort) {  
10.  var err;  
11.  // 如果传了本地的地址或端口，则tcp连接中的源ip和端口就是传的，否则由操作系统自己选  
12.  if (localAddress || localPort) {  
13.      // ip v4  
14.    if (addressType === 4) {  
15.      localAddress = localAddress || '0.0.0.0';  
16.      // 绑定地址和端口到handle，类似设置handle对象的两个属性  
17.      err = self._handle.bind(localAddress, localPort);  
18.    } else if (addressType === 6) {  
19.      localAddress = localAddress || '::';  
20.      err = self._handle.bind6(localAddress, localPort);  
21.    }  
22.  
23.    // 绑定是否成功  
24.    err = checkBindError(err, localPort, self._handle);  
25.    if (err) {  
26.      const ex = exceptionWithHostPort(err, 'bind', localAddress, localPort);  
27.      self.destroy(ex);  
28.      return;  
29.    }  
30.  }  
31.  if (addressType === 6 || addressType === 4) {  
32.    // 新建一个请求对象，是一个c++对象  
33.    const req = new TCPConnectWrap();  
34.    // 设置一些列属性  
35.    req.oncomplete = afterConnect;  
36.    req.address = address;  
37.    req.port = port;  
38.    req.localAddress = localAddress;  
39.    req.localPort = localPort;  
40.    // 调用底层对应的函数  
41.    if (addressType === 4)  
42.      err = self._handle.connect(req, address, port);  
43.    else  
44.      err = self._handle.connect6(req, address, port);  
45.  }  
46.  // 非阻塞调用，可能在还没发起三次握手之前就报错了，而不是三次握手出错，这里进行出错处理  
47.  if (err) {  
48.    // 获取socket对应的底层ip端口信息  
49.    var sockname = self._getsockname();  
50.    var details;  
51.  
52.    if (sockname) {  
53.      details = sockname.address + ':' + sockname.port;  
54.    }  
55.  
56.    const ex = exceptionWithHostPort(err, 'connect', address, port, details);  
57.    self.destroy(ex);  
58.  }  
59.}  
```

这里的代码比较多，除了错误处理外，主要的逻辑是bind和connect。bind函数的逻辑很简单（即使是底层的bind），他就是在底层的一个对象上设置了两个字段的值。所以我们主要来分析connect。我们把关于connect的这段逻辑拎出来。  

```c
1.    const req = new TCPConnectWrap();  
2.    // 设置一些列属性  
3.    req.oncomplete = afterConnect;  
4.    req.address = address;  
5.    req.port = port;  
6.    req.localAddress = localAddress;  
7.    req.localPort = localPort;  
8.    // 调用底层对应的函数  
9.    self._handle.connect(req, address, port);  
```

TCPConnectWrap是c++层提供的类，我们可以把他当做一个空的c++对象。对应到js代码如下

```c
1.function TCPConnectWrap() {}  
2.const req = new TCPConnectWrap();  
```

接着我们看connect函数，对应c++层的Conenct

```c
1.  void TCPWrap::Connect(const FunctionCallbackInfo<Value>& args) {    
2.    Environment* env = Environment::GetCurrent(args);    
3.      
4.    TCPWrap* wrap;    
5.    ASSIGN_OR_RETURN_UNWRAP(&wrap,    
6.                            args.Holder(),    
7.                            args.GetReturnValue().Set(UV_EBADF));    
8.      
9.    CHECK(args[0]->IsObject());    
10.   CHECK(args[1]->IsString());    
11.   CHECK(args[2]->IsUint32());    
12.   Local<Object> req_wrap_obj = args[0].As<Object>();    
13.   // 要连接的ip和端口    
14.   node::Utf8Value ip_address(env->isolate(), args[1]);    
15.   int port = args[2]->Uint32Value();    
16.     
17.   sockaddr_in addr;    
18.   int err = uv_ip4_addr(*ip_address, port, &addr);    
19.     
20.   if (err == 0) {    
21.     // 新建一个request代表本次的connect操作    
22.     ConnectWrap* req_wrap =  new ConnectWrap(env,     
23.                              req_wrap_obj,     
24.                                AsyncWrap::PROVIDER_TCPCONNECTWRAP);    
25.     err = uv_tcp_connect(req_wrap->req(),    
26.                          &wrap->handle_,    
27.                          reinterpret_cast<const sockaddr*>(&addr), 
28.                          AfterConnect);  
29.         // this.req_.data = this,通过req可以拿到封装了该req的c++对象
30.     req_wrap->Dispatched();    
31.     if (err)    
32.       delete req_wrap;    
33.   }    
34.     
35.   args.GetReturnValue().Set(err);    
36.}    
```

这里主要是申请一个请求对象，类型是ConnectWrap，ConnectWrap是对uv_connect_t类型结构体的封装，表示发起一个连接请求，然后针对该handle，进行connect操作（libuv中的handle和request）。我们看uv_tcp_connect。

```c
1.int uv_tcp_connect(uv_connect_t* req,  
2.                   uv_tcp_t* handle,  
3.                   const struct sockaddr* addr,  
4.                   uv_connect_cb cb) {  
5.  unsigned int addrlen;  
6.  
7.  if (handle->type != UV_TCP)  
8.    return UV_EINVAL;  
9.  
10.  if (addr->sa_family == AF_INET)  
11.    addrlen = sizeof(struct sockaddr_in);  
12.  else if (addr->sa_family == AF_INET6)  
13.    addrlen = sizeof(struct sockaddr_in6);  
14.  else  
15.    return UV_EINVAL;  
16.  return uv__tcp_connect(req, handle, addr, addrlen, cb);  
17.}  
```

做了一些参数处理，然后调uv__tcp_connect。

```c
1.int uv__tcp_connect(uv_connect_t* req,  
2.                    uv_tcp_t* handle,  
3.                    const struct sockaddr* addr,  
4.                    unsigned int addrlen,  
5.                    uv_connect_cb cb) {  
6.  int err;  
7.  int r;  
8.  // 新建一个socket，作为客户端  
9.  err = maybe_new_socket(handle,  
10.                         addr->sa_family,  
11.                         UV_STREAM_READABLE | UV_STREAM_WRITABLE);  
12.  if (err)  
13.    return err;  
14.  
15.  handle->delayed_error = 0;  
16.  
17.  do {  
18.    errno = 0;  
19.    // 非阻塞式发起连接  
20.    r = connect(uv__stream_fd(handle), addr, addrlen);  
21.  } while (r == -1 && errno == EINTR);  
22.  // 错误处理，EINPROGRESS说明还在连接中，不算错误，否则设置错误码  
23.  if (r == -1 && errno != 0) {  
24.    if (errno == EINPROGRESS)  
25.    else if (errno == ECONNREFUSED)  
26.      handle->delayed_error = -errno;  
27.    else  
28.      return -errno;  
29.  }  
30.  // 初始化一个请求，挂载到handle（stream）上，等待连接完成  
31.  uv__req_init(handle->loop, req, UV_CONNECT);  
32.  req->cb = cb;  
33.  req->handle = (uv_stream_t*) handle;  
34.  QUEUE_INIT(&req->queue);  
35.  // 设置该字段，在连接完成后使用  
36.  handle->connect_req = req;  
37.  // 注册等待可写事件，即连接建立时  
38.  uv__io_start(handle->loop, &handle->io_watcher, POLLOUT);  
39.  // 出错了，则插入pending队列，等待pending阶段执行回调  
40.  if (handle->delayed_error)  
41.    uv__io_feed(handle->loop, &handle->io_watcher);  
42.  
43.  return 0;  
44.}  
```

前面的流章节我们已经分析过，流注册的读写事件触发时，回调函数几乎都是uv_stream_io。在uv_stream_io里会调用connect_req中的回调。假设连接建立，这时候就会执行AfterConnect。

```c
1.// 主动发起连接，成功后的回调  
2.template <typename WrapType, typename UVType>  
3.void ConnectionWrap<WrapType, UVType>::AfterConnect(uv_connect_t* req,  
4.                                                    int status) {  
5.  // data字段指向了封装该结构体的c++对象                                                      
6.  ConnectWrap* req_wrap = static_cast<ConnectWrap*>(req->data);  
7.  // handle的data字段指向了封装该handle结构体的c++对象  
8.  WrapType* wrap = static_cast<WrapType*>(req->handle->data);  
9.  Environment* env = wrap->env();  
10.  HandleScope handle_scope(env->isolate());  
11.  Context::Scope context_scope(env->context());  
12.  bool readable, writable;  
13.  // 非0表示连接失败  
14.  if (status) {  
15.    readable = writable = 0;  
16.  } else {  
17.    // 读写属性  
18.    readable = uv_is_readable(req->handle) != 0;  
19.    writable = uv_is_writable(req->handle) != 0;  
20.  }  
21.  
22.  Local<Value> argv[5] = {  
23.    Integer::New(env->isolate(), status),  
24.    wrap->object(),  
25.    req_wrap->object(),  
26.    Boolean::New(env->isolate(), readable),  
27.    Boolean::New(env->isolate(), writable)  
28.  };  
29.  // 执行js层oncomplete  
30.  req_wrap->MakeCallback(env->oncomplete_string(), arraysize(argv), argv);  
31.  
32.  delete req_wrap;  
33.}  
```

oncomplete函数指向的是afterConnect。  

```c
1.function afterConnect(status, handle, req, readable, writable) {  
2.  var self = handle.owner;  
3.  
4.  handle = self._handle;  
5.  
6.  self.connecting = false;  
7.  self._sockname = null;  
8.  // 连接成功  
9.  if (status === 0) {  
10.    self.readable = readable;  
11.    self.writable = writable;  
12.    self.emit('connect');  
13.    if (readable && !self.isPaused())  
14.      self.read(0);  
15.    }  
16.  }  
17.  // 错误处理  
18.}  
```

连接成功后js层调用了self.read(0)注册等待可读事件
### 17.1.2 读操作

```c
1.Socket.prototype.read = function(n) {  
2.  if (n === 0)  
3.    return stream.Readable.prototype.read.call(this, n);  
4.  
5.  this.read = stream.Readable.prototype.read;  
6.  this._consuming = true;  
7.  return this.read(n);  
8.};  
```

这里会执行stream模块的read函数，从而执行_read函数，_read函数是由子类实现。所以我们看Socket的_read

```c
1.Socket.prototype._read = function(n) {  
2.  // 还没建立连接  
3.  if (this.connecting || !this._handle) {  
4.    this.once('connect', () => this._read(n));  
5.  } else if (!this._handle.reading) {  
6.    this._handle.reading = true;  
7.    // 执行底层的readStart  
8.    var err = this._handle.readStart();  
9.    if (err)  
10.      this.destroy(errnoException(err, 'read'));  
11.  }  
12.};  
```

但是我们发现tcp_wrap.cc没有readStart函数。一路往父类找，最终在stream_wrap.cc找到了该函数。

```c
1.// 注册读事件  
2.int LibuvStreamWrap::ReadStart() {  
3.  return uv_read_start(stream(), [](uv_handle_t* handle,  
4.                                    size_t suggested_size,  
5.                                    uv_buf_t* buf) {  
6.    // 分配存储数据的内存  
7.    static_cast<LibuvStreamWrap*>(handle->data)->OnUvAlloc(suggested_size, buf);  
8.  }, [](uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {  
9.    // 读取数据成功的回调  
10.    static_cast<LibuvStreamWrap*>(stream->data)->OnUvRead(nread, buf);  
11.  });  
12.}  
```

uv_read_start函数在流章节已经分析过，这里就不再深入。OnUvAlloc函数是分配存储数据的函数，我们可以不关注，我们看一下OnUvRead

```c
1.void LibuvStreamWrap::OnUvRead(ssize_t nread, const uv_buf_t* buf) {  
2.  HandleScope scope(env()->isolate());  
3.  Context::Scope context_scope(env()->context());  
4.  uv_handle_type type = UV_UNKNOWN_HANDLE;  
5.  // 是unix域，并且作为ipc使用，传递的文件描述符大于0，说明不仅有数据，还有传递过来文件描述符  
6.  if (is_named_pipe_ipc() &&  
7.      uv_pipe_pending_count(reinterpret_cast<uv_pipe_t*>(stream())) > 0) {  
8.    // 当前待读取的fd的类型  
9.    type = uv_pipe_pending_type(reinterpret_cast<uv_pipe_t*>(stream()));  
10.  }  
11.  
12.  // 成功读取  
13.  if (nread > 0) {  
14.    Local<Object> pending_obj;  
15.    // 传递的描述符的类型  
16.    if (type == UV_TCP) {  
17.      pending_obj = AcceptHandle<TCPWrap, uv_tcp_t>(env(), this);  
18.    } else if (type == UV_NAMED_PIPE) {  
19.      pending_obj = AcceptHandle<PipeWrap, uv_pipe_t>(env(), this);  
20.    } else if (type == UV_UDP) {  
21.      pending_obj = AcceptHandle<UDPWrap, uv_udp_t>(env(), this);  
22.    } else {  
23.      CHECK_EQ(type, UV_UNKNOWN_HANDLE);  
24.    }  
25.  
26.    if (!pending_obj.IsEmpty()) {  
27.      object()->Set(env()->context(),  
28.                    env()->pending_handle_string(),  
29.                    pending_obj).FromJust();  
30.    }  
31.  }  
32.  // 触发onread事件  
33.  EmitRead(nread, *buf);  
34.}  
```

OnUvRead函数不仅负责读取数据，还处理传递过来的文件描述符。我们看AcceptHandle函数。

```c
1.template <class WrapType, class UVType>  
2.static Local<Object> AcceptHandle(Environment* env, LibuvStreamWrap* parent) {  
3.  EscapableHandleScope scope(env->isolate());  
4.  Local<Object> wrap_obj;  
5.  UVType* handle;  
6.  // 新建一个c++对象。该c++对象关联了一个WrapType对象  
7.  wrap_obj = WrapType::Instantiate(env, parent, WrapType::SOCKET);  
8.  if (wrap_obj.IsEmpty())  
9.    return Local<Object>();  
10.  
11.  WrapType* wrap;  
12.  // 把WrapType对象解包出来，存到wrap  
13.  ASSIGN_OR_RETURN_UNWRAP(&wrap, wrap_obj, Local<Object>());  
14.  // 拿到WrapType对象的handle字段  
15.  handle = wrap->UVHandle();  
16.  // 把通信fd存到handle中  
17.  if (uv_accept(parent->stream(), reinterpret_cast<uv_stream_t*>(handle)))  
18.    ABORT();  
19.  
20.  return scope.Escape(wrap_obj);  
21.}  
```

首先新建一个c++对象。假设这里是TCPWrap。我们看一下TCPWrap:: Instantiate.

```c
1.// 新建一个c++对象，他关联一个TCPWrap对象  
2.Local<Object> TCPWrap::Instantiate(Environment* env,  
3.                                   AsyncWrap* parent,  
4.                                   TCPWrap::SocketType type) {  
5.  EscapableHandleScope handle_scope(env->isolate());  
6.  Local<Function> constructor = env->tcp_constructor_template()->GetFunction();  
7.  Local<Value> type_value = Int32::New(env->isolate(), type);  
8.  Local<Object> instance =  
9.      constructor->NewInstance(env->context(), 1, &type_value).ToLocalChecked();  
10.  return handle_scope.Escape(instance);  
11.}  
```

TCPWrap::Instantiate的逻辑和new TCP是一样的。即新建一个对象，他指向TCPWrap对象。回到AcceptHandle，通过解包TCPWrap::Instantiate的返回，得到一个TCPWrap对象。并且拿到该对象封装的handle，作为新的流，然后调用uv_accpt去消费parent->stream()对应的stream的accept_fd字段。并且存到新的流中，用于后续通信。最后AcceptHandle返回新建的c++对象。并设置到env中。

```c
1.object()->Set(env()->context(),  
2.                   env()->pending_handle_string(),  
3.                   pending_obj).FromJust();  
```

处理完传递的文件描述符后，触发onread事件。

```c
1.function onread(nread, buffer) {  
2.  var handle = this;  
3.  var self = handle.owner;  
4.  // 成功读取数据  
5.  if (nread > 0) {  
6.    // push到流中  
7.    var ret = self.push(buffer);  
8.    // push返回false，说明缓存的数据已经达到阈值，不能再触发读，需要注销等待可读事件  
9.    if (handle.reading && !ret) {  
10.      handle.reading = false;  
11.      var err = handle.readStop();  
12.      if (err)  
13.        self.destroy(errnoException(err, 'read'));  
14.    }  
15.    return;  
16.  }  
17.  
18.  // if we didn't get any bytes, that doesn't necessarily mean EOF.  
19.  // wait for the next one.  
20.  if (nread === 0) {  
21.    debug('not any data, keep waiting');  
22.    return;  
23.  }  
24.  // 不等于结束，则读出错，销毁流  
25.  if (nread !== UV_EOF) {  
26.    return self.destroy(errnoException(nread, 'read'));  
27.  }  
28.  // 流结束了，没有数据读了，push(null)  
29.  self.push(null);  
30.  // 也没有缓存的数据了，可能需要销毁流，比如是只读流，或者可读写流，写端也没有数据了  
31.  if (self.readableLength === 0) {  
32.    self.readable = false;  
33.    maybeDestroy(self);  
34.  }  
35.  // 触发事件  
36.  self.emit('_socketEnd');  
37.}  
```


接着我们看一下在一个流上写的时候，逻辑是怎样的。
### 17.1.3 写操作

```c
1.Socket.prototype._write = function(data, encoding, cb) {  
2.  this._writeGeneric(false, data, encoding, cb);  
3.};  
```

_writeGeneric

```c
1.Socket.prototype._writeGeneric = function(writev, data, encoding, cb) {  
2.  // 正在连接，则连接成功后再写  
3.  if (this.connecting) {  
4.    this.once('connect', function connect() {  
5.      this._writeGeneric(writev, data, encoding, cb);  
6.    });  
7.    return;  
8.  }  
9.  // 新建一个写请求  
10.  var req = new WriteWrap();  
11.  req.handle = this._handle;  
12.  req.oncomplete = afterWrite;  
13.  req.async = false;  
14.  var err;  
15.  // 批量写  
16.  if (writev) {  
17.    // 省略数据处理部分逻辑  
18.    err = this._handle.writev(req, chunks, allBuffers);  
19.    if (err === 0) req._chunks = chunks;  
20.  } else {  
21.    err = createWriteReq(req, this._handle, data, enc);  
22.  }  
23.  // 写出错销毁流，并执行回调  
24.  if (err)  
25.    return this.destroy(errnoException(err, 'write', req.error), cb);  
26.    
27.  this._bytesDispatched += req.bytes;  
28.  // 同步则直接执行回调  
29.  if (!req.async) {  
30.    cb();  
31.    return;  
32.  }  
33.  // 异步则先保存回调  
34.  req.cb = cb;  
35.  this[kLastWriteQueueSize] = req.bytes;  
36.};  
```

主要是执行writev和createWriteReq函数进行写操作。他们底层调用的都是uv_write2（需要传递文件描述符）或uv_write（不需要传递文件描述符）或者uv_try_write函数进行写操作。
## 17.2 tcp 服务器
Net模块提供了createServer函数创建一个tcp服务器。createServer返回的就是一个一般的js对象，接着调用listen函数监听端口。看一下listen函数的逻辑

```c
1.Server.prototype.listen = function(...args) {  
2.  // 处理入参，根据文档我们知道listen可以接收好几个参数，我们这里是只传了端口号9297  
3.  var normalized = normalizeArgs(args);  
4.  //  normalized = [{port: 9297}, null];  
5.  var options = normalized[0];  
6.  var cb = normalized[1];  
7.  // 第一次listen的时候会创建，如果非空说明已经listen过  
8.  if (this._handle) {  
9.    throw new errors.Error('ERR_SERVER_ALREADY_LISTEN');  
10.  }  
11.  // listen成功后执行的回调  
12.  var hasCallback = (cb !== null);  
13.  if (hasCallback) {  
14.    // listen成功的回调  
15.    this.once('listening', cb);  
16.  }  
17.    
18.  options = options._handle || options.handle || options;  
19.  // 第一种情况，传进来的是一个TCP服务器，而不是需要创建一个服务器  
20.  if (options instanceof TCP) {  
21.    this._handle = options;  
22.    this[async_id_symbol] = this._handle.getAsyncId();  
23.    listenInCluster(this, null, -1, -1, backlogFromArgs);  
24.    return this;  
25.  }  
26.  // 第二种，传进来一个对象，并且带了fd  
27.  if (typeof options.fd === 'number' && options.fd >= 0) {  
28.    listenInCluster(this, null, null, null, backlogFromArgs, options.fd);  
29.    return this;  
30.  }  
31.  // 创建一个tcp服务器  
32.  var backlog;  
33.  if (typeof options.port === 'number' || typeof options.port === 'string') {  
34.    backlog = options.backlog || backlogFromArgs;  
35.    // 第三种 启动一个tcp服务器，传了host则先进行dns解析  
36.    // start TCP server listening on host:port  
37.    if (options.host) {  
38.      	(this, options.port | 0, options.host, backlog,  
39.                      options.exclusive);  
40.    } else { // Undefined host, listens on unspecified address  
41.      // Default addressType 4 will be used to search for master server  
42.      listenInCluster(this, null, options.port | 0, 4,  
43.                      backlog, undefined, options.exclusive);  
44.    }  
45.    return this;  
46.  }  
47.};  
```

我们看到有三种情况，分别是传了一个服务器、传了一个fd、传了端口（或者host），但是我们发现，这几种情况最后都是调用了listenInCluster（lookupAndListen是先dns解析后再执行listenInCluster），只是入参不一样，所以我们直接看listenInCluster。

```c
1.function listenInCluster(server, address, port, addressType,  
2.                         backlog, fd, exclusive) {  
3.  exclusive = !!exclusive;  
4.  if (cluster === null) cluster = require('cluster'); 
5.  if (cluster.isMaster || exclusive) {  
6.    server._listen2(address, port, addressType, backlog, fd);  
7.    return;  
8.  }  
9.}  
```

因为我们是在主进程，所以直接执行_listen2，子进程的在子进程模块分析。_listen对应的函数是setupListenHandle

```c
1.function setupListenHandle(address, port, addressType, backlog, fd) {  
2.  // 有handle则不需要创建了，否则创建一个底层的handle  
3.  if (this._handle) {  
4.      
5.  } else {  
6.    var rval = null;  
7.    // 没有传fd，则说明是监听端口和ip  
8.    if (!address && typeof fd !== 'number') {  
9.      rval = createServerHandle('::', port, 6, fd);  
10.      // 返回number说明bindipv6版本的handle失败，回退到v4，否则说明支持ipv6  
11.      if (typeof rval === 'number') {  
12.        // 赋值为null，才能走下面的createServerHandle  
13.        rval = null;  
14.        address = '0.0.0.0';  
15.        addressType = 4;  
16.      } else {  
17.        address = '::';  
18.        addressType = 6;  
19.      }  
20.    }  
21.    // 创建失败则继续创建  
22.    if (rval === null)  
23.      rval = createServerHandle(address, port, addressType, fd);  
24.    // 还报错则说明创建服务器失败，报错  
25.    if (typeof rval === 'number') {  
26.      var error = exceptionWithHostPort(rval, 'listen', address, port);  
27.      process.nextTick(emitErrorNT, this, error);  
28.      return;  
29.    }  
30.    this._handle = rval;  
31.  }  
32.  
33.  // 有完成三次握手的连接时执行的回调  
34.  this._handle.onconnection = onconnection;  
35.  this._handle.owner = this;  
36.  // 执行c++层listen  
37.  var err = this._handle.listen(backlog || 511);  
38.  // 出错则报错  
39.  if (err) {  
40.    var ex = exceptionWithHostPort(err, 'listen', address, port);  
41.    this._handle.close();  
42.    this._handle = null;  
43.    nextTick(this[async_id_symbol], emitErrorNT, this, ex);  
44.    return;  
45.  }  
46.  
47.  // generate connection key, this should be unique to the connection  
48.  this._connectionKey = addressType + ':' + address + ':' + port;  
49.  
50.  // unref the handle if the server was unref'ed prior to listening  
51.  if (this._unref)  
52.    this.unref();  
53.  // 触发listen回调  
54.  nextTick(this[async_id_symbol], emitListeningNT, this);  
55.}  
```

主要是调用createServerHandle创建一个handle，然后调用listen函数监听。我们先看createServerHandle

```c
1.function createServerHandle(address, port, addressType, fd) {  
2.  var err = 0;  
3.  var handle;  
4.  
5.  var isTCP = false;  
6.  // 传了fd则根据fd创建一个handle，true说明是作为服务器  
7.  if (typeof fd === 'number' && fd >= 0) {  
8.    try {  
9.      handle = createHandle(fd, true);  
10.    } catch (e) {  
11.      return UV_EINVAL;  
12.    }  
13.    // 把fd存到handle中  
14.    handle.open(fd);  
15.    handle.readable = true;  
16.    handle.writable = true;  
17.    assert(!address && !port);  
18.    // 管道  
19.  } else if (port === -1 && addressType === -1) {  
20.    // 创建一个unix域服务器  
21.    handle = new Pipe(PipeConstants.SERVER);  
22.  } else {  
23.    // 创建一个tcp服务器  
24.    handle = new TCP(TCPConstants.SERVER);  
25.    isTCP = true;  
26.  }  
27.  // 有地址或者ip说明是通过ip端口创建的tcp服务器，需要调bind绑定地址  
28.  if (address || port || isTCP) {  
29.    // 没有地址，则优先绑定ipv6版本的本地地址  
30.    if (!address) {  
31.      // Try binding to ipv6 first  
32.      err = handle.bind6('::', port);  
33.      // 失败则绑定v4的  
34.      if (err) {  
35.        handle.close();  
36.        // Fallback to ipv4  
37.        return createServerHandle('0.0.0.0', port);  
38.      }  
39.    } else if (addressType === 6) { // ipv6或v4  
40.      err = handle.bind6(address, port);  
41.    } else {  
42.      err = handle.bind(address, port);  
43.    }  
44.  }  
45.  
46.  if (err) {  
47.    handle.close();  
48.    return err;  
49.  }  
50.  
51.  return handle;  
52.}  
```

createServerHandle主要是调用createHandle创建一个handle然后执行bind函数。创建handle的方式有几种，直接调用c++层的函数或者通过fd创建。调用createHandle可以通过fd创建一个handle

```c
1.	// 通过fd创建一个handle，作为客户端或者服务器  
2.function createHandle(fd, is_server) {  
3.  // 判断fd对应的类型  
4.  const type = TTYWrap.guessHandleType(fd);  
5.  // unix域  
6.  if (type === 'PIPE') {  
7.    return new Pipe(  
8.      is_server ? PipeConstants.SERVER : PipeConstants.SOCKET  
9.    );  
10.  }  
11.  // tcp  
12.  if (type === 'TCP') {  
13.    return new TCP(  
14.      is_server ? TCPConstants.SERVER : TCPConstants.SOCKET  
15.    );  
16.  }  
17.  
18.  throw new errors.TypeError('ERR_INVALID_FD_TYPE', type);  
19.}  
```

我们接着看listen函数做了什么。我们直接看tcp_wrap.cc的Listen。

```c
1.void TCPWrap::Listen(const FunctionCallbackInfo<Value>& args) {  
2.  TCPWrap* wrap;  
3.  ASSIGN_OR_RETURN_UNWRAP(&wrap,  
4.                          args.Holder(),  
5.                          args.GetReturnValue().Set(UV_EBADF));  
6.  int backlog = args[0]->Int32Value();  
7.  int err = uv_listen(reinterpret_cast<uv_stream_t*>(&wrap->handle_),  
8.                      backlog,  
9.                      OnConnection);  
10.  args.GetReturnValue().Set(err);  
11.}  
```

C++层几乎是透传到libuv，主要是设置了回调函数OnConnection，有完成三次握手的连接时会被执行。我们接着看libuv的实现。

```c
1.int uv_listen(uv_stream_t* stream, int backlog, uv_connection_cb cb) {  
2.  int err;  
3.  
4.  switch (stream->type) {  
5.  case UV_TCP:  
6.    err = uv_tcp_listen((uv_tcp_t*)stream, backlog, cb);  
7.    break;  
8.  
9.  case UV_NAMED_PIPE:  
10.    err = uv_pipe_listen((uv_pipe_t*)stream, backlog, cb);  
11.    break;  
12.  default:  
13.    err = -EINVAL;  
14.  }  
15.  if (err == 0)  
16.    uv__handle_start(stream);  
17.  return err;  
18.}  
```

我们这里只关注uv_tcp_listen

```c
1.int uv_tcp_listen(uv_tcp_t* tcp, int backlog, uv_connection_cb cb) {  
2.  static int single_accept = -1;  
3.  unsigned long flags;  
4.  int err;  
5.  if (tcp->delayed_error)  
6.    return tcp->delayed_error;  
7.  // 是否accept后，等待一段时间再accept，否则就是连续accept  
8.  if (single_accept == -1) {  
9.    const char* val = getenv("UV_TCP_SINGLE_ACCEPT");  
10.    single_accept = (val != NULL && atoi(val) != 0);  /* Off by default. */  
11.  }  
12.  if (single_accept)  
13.    tcp->flags |= UV_TCP_SINGLE_ACCEPT; 
14.  flags = UV_STREAM_READABLE;  
15.  // 新建一个socket或者bind，一般不需要  
16.  err = maybe_new_socket(tcp, AF_INET, flags);  
17.  if (err)  
18.    return err;  
19.  // 设置socket为监听状态  
20.  if (listen(tcp->io_watcher.fd, backlog))  
21.    return -errno;  
22.  // 设置有连接完成时的回调  
23.  tcp->connection_cb = cb;  
24.  tcp->flags |= UV_HANDLE_BOUND;  
25.  // 有连接到来时libuv层的回调，connection_cb为业务回调，被libuv调用  
26.  tcp->io_watcher.cb = uv__server_io;  
27.  // 注册io观察者到事件循环的io观察者队列，设置等待读事件  
28.  uv__io_start(tcp->loop, &tcp->io_watcher, POLLIN);  
29.  
30.  return 0;  
31.}  
```

有三次握手的连接完成时，会执行OnConnection

```c
1.template <typename WrapType, typename UVType>  
2.void ConnectionWrap<WrapType, UVType>::OnConnection(uv_stream_t* handle, int status) {  
3.  // TCPWrap                                                      
4.  WrapType* wrap_data = static_cast<WrapType*>(handle->data);  
5.  Environment* env = wrap_data->env();  
6.  HandleScope handle_scope(env->isolate());  
7.  Context::Scope context_scope(env->context());  
8.  Local<Value> argv[] = {  
9.    Integer::New(env->isolate(), status),  
10.    Undefined(env->isolate())  
11.  };  
12.  
13.  if (status == 0) {  
14.    // Instantiate the client javascript object and handle.  
15.    // 新建一个表示和客户端通信的对象,必填TCPWrap对象  
16.    Local<Object> client_obj = WrapType::Instantiate(env,wrap_data,WrapType::SOCKET);  
17.    WrapType* wrap;  
18.    // 解包出一个TCPWrap对象存到wrap  
19.    ASSIGN_OR_RETURN_UNWRAP(&wrap, client_obj);  
20.    uv_stream_t* client_handle = reinterpret_cast<uv_stream_t*>(&wrap->handle_);  
21.    // 把通信fd存储到client_handle中  
22.    if (uv_accept(handle, client_handle))  
23.      return;  
24.    argv[1] = client_obj;  
25.  }  
26.  // 回调上层的onconnection函数  
27.  wrap_data->MakeCallback(env->onconnection_string(), arraysize(argv), argv);  
28.}  
29.// clientHandle代表一个和客户端建立tcp连接的实体  
30.function onconnection(err, clientHandle) {  
31.  var handle = this;  
32.  var self = handle.owner;  
33.  // 错误则触发错误事件  
34.  if (err) {  
35.    self.emit('error', errnoException(err, 'accept'));  
36.    return;  
37.  }  
38.  // 建立过多，关掉  
39.  if (self.maxConnections && self._connections >= self.maxConnections) {  
40.    clientHandle.close();  
41.    return;  
42.  }  
43.  //新建一个socket用于通信  
44.  var socket = new Socket({  
45.    handle: clientHandle,  
46.    allowHalfOpen: self.allowHalfOpen,  
47.    pauseOnCreate: self.pauseOnConnect  
48.  });  
49.  socket.readable = socket.writable = true;  
50.  // 服务器的连接数加一  
51.  self._connections++;  
52.  socket.server = self;  
53.  socket._server = self;  
54.  // 触发用户层连接事件  
55.  self.emit('connection', socket);  
56.}  
```

我们看到这里会新建一个socket表示一个tcp连接。然后触发connection事件。剩下的事情就是应用层处理了。
## 17.3 http.createServer
下面是nodejs创建一个服务器的代码。接下来我们一起分析这个过程。

```c
1.var http = require('http');  
2.http.createServer(function (request, response) {  
3.    response.end('Hello World\n');  
4.}).listen(9297);  
```

首先我们去到lib/http.js模块看一下这个函数的代码。  

```c
1.function createServer(requestListener) {  
2.  return new Server(requestListener);  
3.}  
```

只是对_http_server.js做了些封装。我们继续往下看。  

```c
1.  function Server(requestListener) {  
2.  if (!(this instanceof Server)) return new Server(requestListener);  
3.  net.Server.call(this, { allowHalfOpen: true });  
4.  // 收到http请求时执行的回调  
5.  if (requestListener) {  
6.    this.on('request', requestListener);  
7.  }  
8.  
9.  this.httpAllowHalfOpen = false;  
10.  // 建立tcp连接的回调  
11.  this.on('connection', connectionListener);  
12.  
13.  this.timeout = 2 * 60 * 1000;  
14.  this.keepAliveTimeout = 5000;  
15.  this._pendingResponseData = 0;  
16.  this.maxHeadersCount = null;  
17.}  
18.util.inherits(Server, net.Server);  
```

发现_http_server.js也没有太多逻辑，继续看lib/net.js下的代码。 

```c
1.function Server(options, connectionListener) {  
2.  if (!(this instanceof Server))  
3.    return new Server(options, connectionListener);  
4.  
5.  EventEmitter.call(this);  
6.  // connectionListener在http.js处理过了  
7.  if (typeof options === 'function') {  
8.    connectionListener = options;  
9.    options = {};  
10.    this.on('connection', connectionListener);  
11.  } else if (options == null || typeof options === 'object') {  
12.    options = options || {};  
13.  
14.    if (typeof connectionListener === 'function') {  
15.      this.on('connection', connectionListener);  
16.    }  
17.  } else {  
18.    throw new errors.TypeError('ERR_INVALID_ARG_TYPE',  
19.                               'options',  
20.                               'Object',  
21.                               options);  
22.  }  
23.  
24.  this._connections = 0;  
25.  ......  
26.  this[async_id_symbol] = -1;  
27.  this._handle = null;  
28.  this._usingWorkers = false;  
29.  this._workers = [];  
30.  this._unref = false;  
31.  
32.  this.allowHalfOpen = options.allowHalfOpen || false;  
33.  this.pauseOnConnect = !!options.pauseOnConnect;  
34.}  
```

至此http.createServer就执行结束了，我们发现这个过程还没有涉及到很多逻辑，并且还是停留到js层面。接下来我们继续分析listen函数的过程。该函数是net模块提供的。我们只看关键的代码。

```c
1.Server.prototype.listen = function(...args) {  
2.  // 处理入参，根据文档我们知道listen可以接收好几个参数，我们这里是只传了端口号9297  
3.  var normalized = normalizeArgs(args);  
4.  //  normalized = [{port: 9297}, null];  
5.  var options = normalized[0];  
6.  var cb = normalized[1];  
7.  // 第一次listen的时候会创建，如果非空说明已经listen过  
8.  if (this._handle) {  
9.    throw new errors.Error('ERR_SERVER_ALREADY_LISTEN');  
10.  }  
11.  ......  
12.  listenInCluster(this, null, options.port | 0, 4,  
13.                      backlog, undefined, options.exclusive);  
14.}  
15.function listenInCluster() {  
16.    ...  
17.    server._listen2(address, port, addressType, backlog, fd);  
18.}  
19.  
20._listen2 = setupListenHandle = function() {  
21.    ......  
22.    this._handle = createServerHandle(...);  
23.    this._handle.listen(backlog || 511);  
24.}  
25.function createServerHandle() {  
26.    handle = new TCP(TCPConstants.SERVER);  
27.    handle.bind(address, port);  
28.}  
```

到这我们终于看到了tcp连接的内容，每一个服务器新建一个handle并且保存他，该handle是一个TCP对象。然后执行bind和listen函数。接下来我们就看一下TCP类的代码。TCP是C++提供的类。对应的文件是tcp_wrap.cc。我们看看new TCP的时候发生了什么。 

```c
1.void TCPWrap::New(const FunctionCallbackInfo<Value>& args) {  
2.  // This constructor should not be exposed to public javascript.  
3.  // Therefore we assert that we are not trying to call this as a  
4.  // normal function.  
5.  CHECK(args.IsConstructCall());  
6.  CHECK(args[0]->IsInt32());  
7.  Environment* env = Environment::GetCurrent(args);  
8.  
9.  int type_value = args[0].As<Int32>()->Value();  
10.  TCPWrap::SocketType type = static_cast<TCPWrap::SocketType>(type_value);  
11.  
12.  ProviderType provider;  
13.  switch (type) {  
14.    case SOCKET:  
15.      provider = PROVIDER_TCPWRAP;  
16.      break;  
17.    case SERVER:  
18.      provider = PROVIDER_TCPSERVERWRAP;  
19.      break;  
20.    default:  
21.      UNREACHABLE();  
22.  }  
23.  
24.  new TCPWrap(env, args.This(), provider);  
25.}  
26.  
27.  
28.TCPWrap::TCPWrap(Environment* env, Local<Object> object, ProviderType provider)  
29.    : ConnectionWrap(env, object, provider) {  
30.  int r = uv_tcp_init(env->event_loop(), &handle_);  
31.  CHECK_EQ(r, 0);    
32.}  
```

我们看到，new TCP的时候其实是执行libuv的uv_tcp_init函数，初始化一个uv_tcp_t的结构体。首先我们先看一下uv_tcp_t结构体的结构。



![uv_tcp_t结构体](https://img-blog.csdnimg.cn/20200902005231582.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L2h1aWh1b3hxYw==,size_16,color_FFFFFF,t_70#pic_center)




[uv_tcp_t结构体](https://img-blog.csdnimg.cn/20200901000258106.png)

```c
   // 初始化一个tcp流的结构体  
1.int uv_tcp_init(uv_loop_t* loop, uv_tcp_t* tcp) {  
2.  // 未指定未指定协议  
3.  return uv_tcp_init_ex(loop, tcp, AF_UNSPEC);  
4.}  
5.  
6.int uv_tcp_init_ex(uv_loop_t* loop, uv_tcp_t* tcp, unsigned int flags) {  
7.  int domain;  
8.  
9.  /* Use the lower 8 bits for the domain */  
10.  // 低八位是domain  
11.  domain = flags & 0xFF;  
12.  if (domain != AF_INET && domain != AF_INET6 && domain != AF_UNSPEC)  
13.    return UV_EINVAL;  
14.  // 除了第八位的其他位是flags  
15.  if (flags & ~0xFF)  
16.    return UV_EINVAL;  
17.  
18.  uv__stream_init(loop, (uv_stream_t*)tcp, UV_TCP);  
19.  
20.  /* If anything fails beyond this point we need to remove the handle from 
21.   * the handle queue, since it was added by uv__handle_init in uv_stream_init. 
22.   */  
23.  
24.  if (domain != AF_UNSPEC) {  
25.    int err = maybe_new_socket(tcp, domain, 0);  
26.    if (err) {  
27.      // 出错则把该handle移除loop队列  
28.      QUEUE_REMOVE(&tcp->handle_queue);  
29.      return err;  
30.    }  
31.  }  
32.  
33.  return 0;  
34.} 
```

我们接着看uv__stream_init做了什么事情。

```c
1.void uv__stream_init(uv_loop_t* loop,  
2.                     uv_stream_t* stream,  
3.                     uv_handle_type type) {  
4.  int err;  
5.  
6.  uv__handle_init(loop, (uv_handle_t*)stream, type);  
7.  stream->read_cb = NULL;  
8.  stream->alloc_cb = NULL;  
9.  stream->close_cb = NULL;  
10.  stream->connection_cb = NULL;  
11.  stream->connect_req = NULL;  
12.  stream->shutdown_req = NULL;  
13.  stream->accepted_fd = -1;  
14.  stream->queued_fds = NULL;  
15.  stream->delayed_error = 0;  
16.  QUEUE_INIT(&stream->write_queue);  
17.  QUEUE_INIT(&stream->write_completed_queue);  
18.  stream->write_queue_size = 0;  
19.  
20.  if (loop->emfile_fd == -1) {  
21.    err = uv__open_cloexec("/dev/null", O_RDONLY);  
22.    if (err < 0)  
23.        /* In the rare case that "/dev/null" isn't mounted open "/" 
24.         * instead. 
25.         */  
26.        err = uv__open_cloexec("/", O_RDONLY);  
27.    if (err >= 0)  
28.      loop->emfile_fd = err;  
29.  }  
30.  
31.#if defined(__APPLE__)  
32.  stream->select = NULL;  
33.#endif /* defined(__APPLE_) */  
34.  // 初始化io观察者  
35.  uv__io_init(&stream->io_watcher, uv__stream_io, -1);  
36.}  
37.  
38.void uv__io_init(uv__io_t* w, uv__io_cb cb, int fd) {  
39.  assert(cb != NULL);  
40.  assert(fd >= -1);  
41.  // 初始化队列，回调，需要监听的fd  
42.  QUEUE_INIT(&w->pending_queue);  
43.  QUEUE_INIT(&w->watcher_queue);  
44.  w->cb = cb;  
45.  w->fd = fd;  
46.  w->events = 0;  
47.  w->pevents = 0;  
48.  
49.#if defined(UV_HAVE_KQUEUE)  
50.  w->rcount = 0;  
51.  w->wcount = 0;  
52.#endif /* defined(UV_HAVE_KQUEUE) */  
53.}  
```

从代码可以知道，只是对uv_tcp_t结构体做了一些初始化操作。到这，new TCP的逻辑就执行完毕了。接下来就是继续分类nodejs里调用bind和listen的逻辑。nodejs的bind对应libuv的函数是uv__tcp_bind，listen对应的是uv_tcp_listen。 先看一个bind的核心代码。

```c
1./* Cannot set IPv6-only mode on non-IPv6 socket. */  
2.  if ((flags & UV_TCP_IPV6ONLY) && addr->sa_family != AF_INET6)  
3.    return UV_EINVAL;  
4.  // 获取一个socket并且设置某些标记  
5.  err = maybe_new_socket(tcp, addr->sa_family, 0);  
6.  if (err)  
7.    return err;  
8.  
9.  on = 1;  
10.  // 设置在端口可重用  
11.  if (setsockopt(tcp->io_watcher.fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on)))  
12.    return UV__ERR(errno);  
13.  bind(tcp->io_watcher.fd, addr, addrlen) && errno != EADDRINUSE  
14.static int maybe_new_socket(uv_tcp_t* handle, int domain, unsigned long flags) {  
15.  struct sockaddr_storage saddr;  
16.  socklen_t slen;  
17.  
18.  if (domain == AF_UNSPEC) {  
19.    handle->flags |= flags;  
20.    return 0;  
21.  }  
22.  return new_socket(handle, domain, flags);  
23.}  
24.static int new_socket(uv_tcp_t* handle, int domain, unsigned long flags) {  
25.  struct sockaddr_storage saddr;  
26.  socklen_t slen;  
27.  int sockfd;  
28.  int err;  
29.  // 获取一个socket  
30.  err = uv__socket(domain, SOCK_STREAM, 0);  
31.  if (err < 0)  
32.    return err;  
33.  sockfd = err;  
34.  // 设置选项和保存socket的文件描述符到io观察者中  
35.  err = uv__stream_open((uv_stream_t*) handle, sockfd, flags);  
36.  if (err) {  
37.    uv__close(sockfd);  
38.    return err;  
39.  }  
40.  ...  
41.  return 0;  
42.}  
43.  
44.int uv__stream_open(uv_stream_t* stream, int fd, int flags) {  
45.  if (!(stream->io_watcher.fd == -1 || stream->io_watcher.fd == fd))  
46.    return UV_EBUSY;  
47.  
48.  assert(fd >= 0);  
49.  stream->flags |= flags;  
50.  
51.  if (stream->type == UV_TCP) {  
52.    if ((stream->flags & UV_HANDLE_TCP_NODELAY) && uv__tcp_nodelay(fd, 1))  
53.      return UV__ERR(errno);  
54.  
55.    /* TODO Use delay the user passed in. */  
56.    if ((stream->flags & UV_HANDLE_TCP_KEEPALIVE) &&  
57.        uv__tcp_keepalive(fd, 1, 60)) {  
58.      return UV__ERR(errno);  
59.    }  
60.  }  
61.  ...  
62.  // 保存socket对应的文件描述符到io观察者中，libuv会在io poll阶段监听该文件描述符  
63.  stream->io_watcher.fd = fd;  
64.  
65.  return 0;  
66.}  
```

上面的一系列操作主要是新建一个socket文件描述符，设置一些flag，然后把文件描述符保存到IO观察者中，libuv在poll IO阶段会监听该文件描述符，如果有事件到来，会执行设置的回调函数，该函数是在uvstream_init里设置的uvstream_io。最后执行bind函数进行绑定操作。最后我们来分析一下listen函数。首先看下tcp_wrap.cc的代码。

```c
1.void TCPWrap::Listen(const FunctionCallbackInfo<Value>& args) {  
2.  TCPWrap* wrap;  
3.  ASSIGN_OR_RETURN_UNWRAP(&wrap,  
4.                          args.Holder(),  
5.                          args.GetReturnValue().Set(UV_EBADF));  
6.  int backlog = args[0]->Int32Value();  
7.  int err = uv_listen(reinterpret_cast<uv_stream_t*>(&wrap->handle_),  
8.                      backlog,  
9.                      OnConnection);  
10.  args.GetReturnValue().Set(err);  
11.}  
```

代码中有个很重要的地方就是OnConnection函数，nodejs给listen函数设置了一个回调函数OnConnection，该函数在IO观察者里保存的文件描述符有连接到来时会被调用。OnConnection函数是在connection_wrap.cc定义的，tcp_wrapper继承了connection_wrap。下面我们先看一下uv_listen。该函数调用了uv_tcp_listen。该函数的核心代码如下。

```c
1.if (listen(tcp->io_watcher.fd, backlog))  
2.    return UV__ERR(errno);  
3.  // cb即OnConnection  
4.  tcp->connection_cb = cb;  
5.  tcp->flags |= UV_HANDLE_BOUND;  
6.  
7.  // 有连接到来时的libuv层回调，覆盖了uv_stream_init时设置的值  
8.  tcp->io_watcher.cb = uv__server_io;  
9.  // 注册事件  
10.  uv__io_start(tcp->loop, &tcp->io_watcher, POLLIN);  
```

在libuv的poll IO阶段，epoll_wait会监听到到来的连接，然后调用uv__server_io。下面是该函数的核心代码。  

```c
1.// 继续注册事件，等待连接  
2.  uv__io_start(stream->loop, &stream->io_watcher, POLLIN);  
3.  err = uv__accept(uv__stream_fd(stream));  
4.  // 保存连接对应的socket  
5.  stream->accepted_fd = err;  
6.  // 执行nodejs层回调  
7.  stream->connection_cb(stream, 0);  
```

libuv会摘下一个连接，得到对应的socket。然后执行nodejs层的回调，这时候我们来看一下OnConnection的代码。

```c
1.OnConnection(uv_stream_t* handle,int status)  
2.    if (status == 0) {  
3.        // 新建一个uv_tcp_t结构体  
4.        Local<Object> client_obj = WrapType::Instantiate(env, wrap_data, WrapType::SOCKET);  
5.        WrapType* wrap;  
6.        ASSIGN_OR_RETURN_UNWRAP(&wrap, client_obj);  
7.        uv_stream_t* client_handle = reinterpret_cast<uv_stream_t*>(&wrap->handle_);  
8.        // uv_accept返回0表示成功  
9.        if (uv_accept(handle, client_handle))  
10.          return;  
11.        argv[1] = client_obj;  
12.  }  
13.  // 执行上层的回调，该回调是net.js设置的onconnection  
14.  wrap_data->MakeCallback(env->onconnection_string(), arraysize(argv), argv);  
15.OnConnection新建了一个uv_tcp_t结构体。代表这个连接。然后调用uv_accept。  
16.  
17.int uv_accept(uv_stream_t* server, uv_stream_t* client) {  
18.    ...  
19.    // 新建的uv_tcp_t结构体关联accept_fd，注册读写事件  
20.    uv__stream_open(client, server->accepted_fd, UV_HANDLE_READABLE | UV_HANDLE_WRITABLE);  
21.    ...  
22.}  
```

最后执行nodejs的回调。

```c
1.function onconnection(err, clientHandle) {  
2.  var handle = this;  
3.  var self = handle.owner;  
4.  if (err) {  
5.    self.emit('error', errnoException(err, 'accept'));  
6.    return;  
7.  }  
8.  if (self.maxConnections && self._connections >= self.maxConnections) {  
9.    clientHandle.close();  
10.    return;  
11.  }  
12.  var socket = new Socket({  
13.    handle: clientHandle,  
14.    allowHalfOpen: self.allowHalfOpen,  
15.    pauseOnCreate: self.pauseOnConnect  
16.  });  
17.  socket.readable = socket.writable = true;  
18.  self._connections++;  
19.  socket.server = self;  
20.  socket._server = self;  
21.  DTRACE_NET_SERVER_CONNECTION(socket);  
22.  LTTNG_NET_SERVER_CONNECTION(socket);  
23.  COUNTER_NET_SERVER_CONNECTION(socket);  
24.  // 触发_http_server.js里设置的connectionListener回调  
25.  self.emit('connection', socket);  
26.}  
```

listen函数总体的逻辑就是把socket设置为可监听，然后注册事件，等待连接的到来，连接到来的时候，调用accept获取新建立的连接，tcp_wrap.cc的回调新建一个uv_tcp_t结构体，代表新的连接，然后设置可读写事件，并且设置回调为uvstream_io，等待数据的到来。最后执行net.js设置的onconnection。。我们看一下new Socket的核心逻辑。

```c
1.stream.Duplex.call(this, options);  
2. this._handle = options.handle;   
3. initSocketHandle(this);  
4. // 触发底层注册一些函数  
5. this.read(0);  
6.function initSocketHandle(self) {  
7.    if (self._handle) {  
8.        self._handle.owner = self;  
9.        // 这个函数在底层有数据时会回调  
10.        self._handle.onread = onread;  
11.        self[async_id_symbol] = getNewAsyncId(self._handle);  
12.    }  
13.}  
```

重点是read(0)这个函数的逻辑。

```c
1.Socket.prototype.read = function(n) {  
2.  if (n === 0)  
3.    return stream.Readable.prototype.read.call(this, n);  
4.  
5.  this.read = stream.Readable.prototype.read;  
6.  this._consuming = true;  
7.  return this.read(n);  
8.};  
```

在read里会执行_read
this._read(state.highWaterMark);  
而_read是由Socket函数实现的。因为Socket继承了ReadableStream。_read执行了一个很重要的操作。  
this._handle.readStart();  
_handle代表的是一个TCP对象，即tcp_wrap.cc里创建的。所以我们去看tcp_wrapper的代码。但是没找到该函数。原来该函数在tcp_wrapper的子类stream_wrap里实现的。

```c
1.int LibuvStreamWrap::ReadStart() {  
2.  return uv_read_start(stream(), [](uv_handle_t* handle,  
3.                                    size_t suggested_size,  
4.                                    uv_buf_t* buf) {  
5.    static_cast<LibuvStreamWrap*>(handle->data)->OnUvAlloc(suggested_size, buf);  
6.  }, [](uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {  
7.    static_cast<LibuvStreamWrap*>(stream->data)->OnUvRead(nread, buf);  
8.  });  
9.}  
```

其实就是调用了libuv的uv_read_start函数。该函数在stream.c里。我们继续往下看。 

```c
1.stream->read_cb = read_cb;  
2.stream->alloc_cb = alloc_cb;  
3.// 注册读事件  
4.uv__io_start(stream->loop, &stream->io_watcher, POLLIN);  
```

主要是注册读事件，回调函数是uv__stream_io。我们看一下uv__stream_io中处理读事件的逻辑。

```c
1.if (events & (POLLIN | POLLERR | POLLHUP))  
2.    uv__read(stream)  
```

  有读事件到来的时候，uv__stream_io会调uv_read函数。

```c
1.buf = uv_buf_init(NULL, 0);  
2.    stream->alloc_cb((uv_handle_t*)stream, 64 * 1024, &buf);  
3.   if (buf.base == NULL || buf.len == 0) {  
4.     /* User indicates it can't or won't handle the read. */  
5.     stream->read_cb(stream, UV_ENOBUFS, &buf);  
6.     return;  
7.   }  
```

这两个函数就是刚才注册的。我们再次回到nodejs的c++代码。看一下这两个函数做了什么。  

```c
1.void LibuvStreamWrap::OnUvRead(...) {  
2.    EmitRead(nread, *buf);  
3.}  
```

EmitRead在stream_base-inl.h里定义，他又是一个子类。

```c
1.inline void StreamResource::EmitRead(ssize_t nread, const uv_buf_t& buf) {  
2.  if (nread > 0)  
3.    bytes_read_ += static_cast<uint64_t>(nread);  
4.  listener_->OnStreamRead(nread, buf);  
5.}  
```

在stream_base.c定义  

```c
1.  
2.OnStreamRead() {  
3.     stream->CallJSOnreadMethod(nread, obj);  
4.}  
5.CallJSOnreadMethod() {  
6.    wrap->MakeCallback(env->onread_string(), arraysize(argv), argv);  
7.}  
```

在env.h里我们知道onread_string就是onread，所以这里就是执行js层的onread函数。该函数就是在new Socket的时候注册的。我们回到js的代码。 

```c
1.function onread() {  
2.        var ret = self.push(buffer);  
3.    } 
```

push函数是在readableStream里定义的。他经过一系列处理触发ondata事件。

```c
1.function addChunk(...) {  
2.    ...  
3.    stream.emit('data', chunk);  
4.    ...  
5.}  
```

那是谁监听了ondata事件呢，我们首先看一下nodejs在建立一个连接到再_http_server.js层做了什么处理。

```c
1.function Server(requestListener) {  
2.  if (!(this instanceof Server)) return new Server(requestListener);  
3.  net.Server.call(this, { allowHalfOpen: true });  
4.  // 收到http请求时执行的回调  
5.  if (requestListener) {  
6.    this.on('request', requestListener);  
7.  }  
8.  this.httpAllowHalfOpen = false;  
9.  // 建立tcp连接的回调  
10.  this.on('connection', connectionListener);  
11.  
12.  this.timeout = 2 * 60 * 1000;  
13.  this.keepAliveTimeout = 5000;  
14.  this._pendingResponseData = 0;  
15.  this.maxHeadersCount = null;  
16.}  
```

connectionListener代码如下。

```c
1.function connectionListener(socket) {  
2.  defaultTriggerAsyncIdScope(  
3.    getOrSetAsyncId(socket), connectionListenerInternal, this, socket  
4.  );  
5.}  
6.  
7.function connectionListenerInternal(server, socket) {  
8.   httpSocketSetup(socket);  
9.    if (socket.server === null)  
10.    socket.server = server;  
11.    if (server.timeout && typeof socket.setTimeout === 'function')  
12.    socket.setTimeout(server.timeout);  
13.  
14.  socket.on('timeout', socketOnTimeout);  
15.  var parser = parsers.alloc();  
16.  parser.reinitialize(HTTPParser.REQUEST);  
17.  parser.socket = socket;  
18.  socket.parser = parser;  
19.  parser.incoming = null;  
20.  
21.  // Propagate headers limit from server instance to parser  
22.  if (typeof server.maxHeadersCount === 'number') {  
23.    parser.maxHeaderPairs = server.maxHeadersCount << 1;  
24.  } else {  
25.    // Set default value because parser may be reused from FreeList  
26.    parser.maxHeaderPairs = 2000;  
27.  }  
28.  
29.  var state = {  
30.    onData: null,  
31.    onEnd: null,  
32.    onClose: null,  
33.    onDrain: null,  
34.    outgoing: [],  
35.    incoming: [],  
36.    outgoingData: 0,  
37.    keepAliveTimeoutSet: false  
38.  };  
39.  // 收到tcp连接中的数据时回调  
40.  state.onData = socketOnData.bind(undefined, server, socket, parser, state);  
41.  state.onEnd = socketOnEnd.bind(undefined, server, socket, parser, state);  
42.  state.onClose = socketOnClose.bind(undefined, socket, state);  
43.  state.onDrain = socketOnDrain.bind(undefined, socket, state);  
44.  socket.on('data', state.onData);  
45.  socket.on('error', socketOnError);  
46.  socket.on('end', state.onEnd);  
47.  socket.on('close', state.onClose);  
48.  socket.on('drain', state.onDrain);  
49.  parser.onIncoming = parserOnIncoming.bind(undefined, server, socket, state);  
50.  
51.  // We are consuming socket, so it won't get any actual data  
52.  socket.on('resume', onSocketResume);  
53.  socket.on('pause', onSocketPause);  
54.  
55.  // Override on to unconsume on `data`, `readable` listeners  
56.  socket.on = socketOnWrap;  
57.  
58.  // We only consume the socket if it has never been consumed before.  
59.  if (socket._handle) {  
60.    var external = socket._handle._externalStream;  
61.    if (!socket._handle._consumed && external) {  
62.      parser._consumed = true;  
63.      socket._handle._consumed = true;  
64.      parser.consume(external);  
65.    }  
66.  }  
67.  parser[kOnExecute] =  
68.    onParserExecute.bind(undefined, server, socket, parser, state);  
69.  
70.  socket._paused = false;  
71.}
```

主要是注册了一系列的回调函数，这些函数在收到数据或者解析数据时会被执行。所以收到数据后执行的函数是socketOnData。该函数就是把数据传进http解析器然后进行解析。  

```c
1.function socketOnData(server, socket, parser, state, d) {  
2.        ...  
3.        var ret = parser.execute(d);  
4.        onParserExecuteCommon(server, socket, parser, state, ret, d);  
5.    }  
```

我们先看一下parser是个什么。parser是在_http_server.js的onconnection回调里，parsers.alloc()分配的。而parsers又是个啥呢？他在_http_common.js里定义。  

```c
1.var parsers = new FreeList('parsers', 1000, function() {  
2.  var parser = new HTTPParser(HTTPParser.REQUEST);  
3.  
4.  parser._headers = [];  
5.  parser._url = '';  
6.  parser._consumed = false;  
7.  
8.  parser.socket = null;  
9.  parser.incoming = null;  
10.  parser.outgoing = null;  
11.  
12.  // Only called in the slow case where slow means  
13.  // that the request headers were either fragmented  
14.  // across multiple TCP packets or too large to be  
15.  // processed in a single run. This method is also  
16.  // called to process trailing HTTP headers.  
17.  parser[kOnHeaders] = parserOnHeaders;  
18.  parser[kOnHeadersComplete] = parserOnHeadersComplete;  
19.  parser[kOnBody] = parserOnBody;  
20.  parser[kOnMessageComplete] = parserOnMessageComplete;  
21.  parser[kOnExecute] = null;  
22.  
23.  return parser;  
24.});  
25.  
26.class FreeList {  
27.  constructor(name, max, ctor) {  
28.    this.name = name;  
29.    this.ctor = ctor;  
30.    this.max = max;  
31.    this.list = [];  
32.  }  
33.  
34.  alloc() {  
35.    return this.list.length ?  
36.      this.list.pop() :  
37.      this.ctor.apply(this, arguments);  
38.  }  
39.  
40.  free(obj) {  
41.    if (this.list.length < this.max) {  
42.      this.list.push(obj);  
43.      return true;  
44.    }  
45.    return false;  
46.  }  
47.}  
```

他其实是管理http解析器的。重点是HTTPParser，他定义在node_http_parser.cc是对http解析器的封装。真正的解析器在http_parser.c。回到刚才的地方。nodejs收到数据后执行 parser.execute(d);execute函数对应的是node_http_parser里的Execute。该函数进行了重载。入口是下面这个函数。

```c
1.static void Execute(const FunctionCallbackInfo<Value>& args) {  
2.    Local<Value> ret = parser->Execute(buffer_data, buffer_len);  
3.}  
4.Local<Value> Execute(char* data, size_t len) {  
5.      http_parser_execute(&parser_, &settings, data, len);  
6. }  
```

http_parser_execute函数定义在http_parser.c，该函数就是进行真正的http协议解析。它里面会有一些钩子函数。在解析的某个阶段会执行。例如解析完头部。  

```c
1.if (settings->on_headers_complete) {  
2.      switch (settings->on_headers_complete(parser)) {  
3.        ...  
4.      }  
5.}  
```

具体的定义在node_http_parser.cc

```c
1.const struct http_parser_settings Parser::settings = {  
2.  Proxy<Call, &Parser::on_message_begin>::Raw,  
3.  Proxy<DataCall, &Parser::on_url>::Raw,  
4.  Proxy<DataCall, &Parser::on_status>::Raw,  
5.  Proxy<DataCall, &Parser::on_header_field>::Raw,  
6.  Proxy<DataCall, &Parser::on_header_value>::Raw,  
7.  Proxy<Call, &Parser::on_headers_complete>::Raw,  
8.  Proxy<DataCall, &Parser::on_body>::Raw,  
9.  Proxy<Call, &Parser::on_message_complete>::Raw,  
10.  nullptr,  // on_chunk_header  
11.  nullptr   // on_chunk_complete  
12.};  
```

这里我们以on_header_complete钩子来分析。

```c
1.const uint32_t kOnHeadersComplete = 1  
2.int on_headers_complete() {  
3.    Local<Value> cb = obj->Get(kOnHeadersComplete);   
4.     MakeCallback(cb.As<Function>(), arraysize(argv), argv);  
5.} 
```

最后会执行kOnHeadersComplete这个函数。我们看到这个kOnHeadersComplete 等于1，其实这个是在js层复赋值的。在_http_common.js中的开头。
const kOnHeadersComplete = HTTPParser.kOnHeadersComplete | 0; 
然后在新建一个http解析器的函数注册了该函数。  
parser[kOnHeadersComplete] = parserOnHeadersComplete; 
所以当解析头部结束就会执行parserOnHeadersComplete。  

```c
1.function parserOnHeadersComplete(...) {  
2.    parser.incoming = new IncomingMessage(parser.socket);  
3.    ...  
4.    return parser.onIncoming(parser.incoming, shouldKeepAlive);  
5.} 
```

新建了一个IncomingMessage对象，然后执行_http_server.js注册的回调onIncoming 。该回调函数也是再建立tcp连接时注册的。 

```c
1.function parserOnIncoming() {  
2.    var res = new ServerResponse(req);  
3.    ...  
4.    server.emit('request', req, res);  
5.}  
```

生成一个ServerResponse对象，然后触发request事件。该函数是在我们执行http.createServer时传进行的函数。  

```c
1.function Server(requestListener) {  
2.  ...  
3.  // 收到http请求时执行的回调  
4.  if (requestListener) {  
5.    this.on('request', requestListener);  
6.  }  
7.}	
```

  
最后在我们的回调里就拿到了这两个对象。但是这时候只是解析完了头部，request对象里还拿不到body的数据。我们需要自己获取。  

```c
1.var str = "";      
2.req.on('data', (data) => {  
3.    str += data;     
4.});      
5.req.on('end',() => {})  
```

## 17.4 keepalive原理
我们先看一下nodejs中keep-alive的使用。
socket.setKeepAlive([enable][, initialDelay])
enable：是否开启keep-alive，linux下默认是不开启的。
initialDelay：多久没有收到数据包就开始发送探测包。
接着我们看看这个api在libuv中的实现。

```c
1.int uv__tcp_keepalive(int fd, int on, unsigned int delay) {  
2.  if (setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &on, sizeof(on)))  
3.    return UV__ERR(errno);  
4.// linux定义了这个宏  
5.#ifdef TCP_KEEPIDLE  
6.  /* 
7.      on是1才会设置，所以如果我们先开启keep-alive，并且设置delay， 
8.      然后关闭keep-alive的时候，是不会修改之前修改过的配置的。 
9.      因为这个配置在keep-alive关闭的时候是没用的 
10.  */  
11.  if (on && setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &delay, sizeof(delay)))  
12.    return UV__ERR(errno);  
13.#endif  
14.  
15.  return 0;  
16.}  
```

我们看到libuv调用了同一个系统函数两次。我们分别看一下这个函数的意义。参考linux2.6.13.1的代码。

```c
1.// net\socket.c  
2.asmlinkage long sys_setsockopt(int fd, int level, int optname, char __user *optval, int optlen)  
3.{  
4.    int err;  
5.    struct socket *sock;  
6.  
7.    if ((sock = sockfd_lookup(fd, &err))!=NULL)  
8.    {  
9.        ...  
10.        if (level == SOL_SOCKET)  
11.            err=sock_setsockopt(sock,level,optname,optval,optlen);  
12.        else  
13.            err=sock->ops->setsockopt(sock, level, optname, optval, optlen);  
14.        sockfd_put(sock);  
15.    }  
16.    return err;  
17.}  
```

当level是SOL_SOCKET代表修改的socket层面的配置。IPPROTO_TCP是修改tcp层的配置（该版本代码里是SOL_TCP）。我们先看SOL_SOCKET层面的。

```c
1.// net\socket.c -> net\core\sock.c -> net\ipv4\tcp_timer.c  
2.int sock_setsockopt(struct socket *sock, int level, int optname,  
3.            char __user *optval, int optlen) {  
4.    ...  
5.    case SO_KEEPALIVE:  
6.  
7.            if (sk->sk_protocol == IPPROTO_TCP)  
8.                tcp_set_keepalive(sk, valbool);  
9.            // 设置SOCK_KEEPOPEN标记位1  
10.            sock_valbool_flag(sk, SOCK_KEEPOPEN, valbool);  
11.            break;  
12.    ...  
13.}  
```

sock_setcsockopt首先调用了tcp_set_keepalive函数，然后给对应socket的SOCK_KEEPOPEN字段打上标记（0或者1表示开启还是关闭）。接下来我们看tcp_set_keepalive  

```c
1.void tcp_set_keepalive(struct sock *sk, int val)  
2.{  
3.    if ((1 << sk->sk_state) & (TCPF_CLOSE | TCPF_LISTEN))  
4.        return;  
5.    /* 
6.        如果val是1并且之前是0（没开启）那么就开启计时，超时后发送探测包， 
7.        如果之前是1，val又是1，则忽略，所以重复设置是无害的 
8.    */  
9.    if (val && !sock_flag(sk, SOCK_KEEPOPEN))  
10.        tcp_reset_keepalive_timer(sk, keepalive_time_when(tcp_sk(sk)));  
11.    else if (!val)  
12.        // val是0表示关闭，则清除定时器，就不发送探测包了  
13.        tcp_delete_keepalive_timer(sk);  
14.}  
```

我们看看超时后的逻辑。  

```c
1.// 多久没有收到数据包则发送第一个探测包  
2.static inline int keepalive_time_when(const struct tcp_sock *tp)  
3.{  
4.    // 用户设置的（TCP_KEEPIDLE）和系统默认的  
5.    return tp->keepalive_time ? : sysctl_tcp_keepalive_time;  
6.}  
7.// 隔多久发送一个探测包  
8.static inline int keepalive_intvl_when(const struct tcp_sock *tp)  
9.{  
10.    return tp->keepalive_intvl ? : sysctl_tcp_keepalive_intvl;  
11.}  
12.  
13.static void tcp_keepalive_timer (unsigned long data)  
14.{  
15....  
16.// 多久没有收到数据包了  
17.elapsed = tcp_time_stamp - tp->rcv_tstamp;  
18.    // 是否超过了阈值  
19.    if (elapsed >= keepalive_time_when(tp)) {  
20.        // 发送的探测包个数达到阈值，发送重置包  
21.        if ((!tp->keepalive_probes && tp->probes_out >= sysctl_tcp_keepalive_probes) ||  
22.             (tp->keepalive_probes && tp->probes_out >= tp->keepalive_probes)) {  
23.            tcp_send_active_reset(sk, GFP_ATOMIC);  
24.            tcp_write_err(sk);  
25.            goto out;  
26.        }  
27.        // 发送探测包，并计算下一个探测包的发送时间（超时时间）  
28.        tcp_write_wakeup(sk)  
29.            tp->probes_out++;  
30.            elapsed = keepalive_intvl_when(tp);  
31.    } else {  
32.        /* 
33.            还没到期则重新计算到期时间，收到数据包的时候应该会重置定时器， 
34.            所以执行该函数说明的确是超时了，按理说不会进入这里。 
35.        */  
36.        elapsed = keepalive_time_when(tp) - elapsed;  
37.    }  
38.  
39.    TCP_CHECK_TIMER(sk);  
40.    sk_stream_mem_reclaim(sk);  
41.  
42.resched:  
43.    // 重新设置定时器  
44.    tcp_reset_keepalive_timer (sk, elapsed);  
45....  
```

所以在SOL_SOCKET层面是设置是否开启keep-alive机制。如果开启了，就会设置定时器，超时的时候就会发送探测包。
对于定时发送探测包这个逻辑，tcp层定义了三个配置。 

 1. 多久没有收到数据包，则开始发送探测包。   
 2. 开始发送，探测包之前，如果还是没有收到数据（这里指的是有效数据，因为对端会回复ack给探测包），每隔多久，再次发送探测包。 
 3.  发送多少个探测包后，就断开连接。

 
但是我们发现，SOL_SOCKET只是设置了是否开启探测机制，并没有定义上面三个配置的值，所以系统会使用默认值进行心跳机制（如果我们设置了开启keep-alive的话）。这就是为什么libuv调了两次setsockopt函数。第二次的调用设置了就是上面三个配置中的第一个（后面两个也可以设置，不过libuv没有提供接口，可以自己调用setsockopt设置）。那么我们来看一下libuv的第二次调用setsockopt是做了什么。我们直接看tcp层的实现。

```c
1.// net\ipv4\tcp.c  
2.int tcp_setsockopt(struct sock *sk, int level, int optname, char __user *optval,int optlen)  
3.{  
4.    ...  
5.    case TCP_KEEPIDLE:  
6.        // 修改多久没有收到数据包则发送探测包的配置  
7.        tp->keepalive_time = val * HZ;  
8.            // 是否开启了keep-alive机制  
9.            if (sock_flag(sk, SOCK_KEEPOPEN) &&  
10.                !((1 << sk->sk_state) &  
11.                  (TCPF_CLOSE | TCPF_LISTEN))) {  
12.                // 当前时间减去上次收到数据包的时候，即多久没有收到数据包了  
13.                __u32 elapsed = tcp_time_stamp - tp->rcv_tstamp;  
14.                // 算出还要多久可以发送探测包，还是可以直接发（已经触发了）  
15.                if (tp->keepalive_time > elapsed)  
16.                    elapsed = tp->keepalive_time - elapsed;  
17.                else  
18.                    elapsed = 0;  
19.                // 设置定时器  
20.                tcp_reset_keepalive_timer(sk, elapsed);  
21.            }     
22.        ...  
23.}  
```

该函数首先修改配置，然后判断是否开启了keep-alive的机制，如果开启了，则重新设置定时器，超时的时候就会发送探测包。Nodejs的keep-alive有两个层面的内容，第一个是是否开启，第二个是开启后，使用的配置。nodejs的setKeepAlive就是做了这两件事情。只不过他只支持修改一个配置。另外测试发现，window下，调用setKeepAlive设置的initialDelay，会修改两个配置。分别是多久没有数据包就发送探测包，隔多久发送一次这两个配置。但是linux下只会修改多久没有数据包就发送探测包这个配置。（关于keepalive更多了解可以参考https://zhuanlan.zhihu.com/p/150664757）

# 17.5 http 管道化的实现
http1.0的时候，不支持pipeline，客户端发送一个请求的时候，首先建立tcp连接，然后服务器返回一个响应，最后断开tcp连接，这种是最简单的实现方式，但是每次发送请求都需要走三次握手显然会带来一定的时间损耗，所以http1.1的时候，支持了pipeline。pipeline的意思就是可以在一个tcp连接上发送多个请求，这样服务器就可以同时处理多个请求，但是由于http1.1的限制，多个请求的响应需要按序返回。因为在http1.1中，没有标记请求和响应的对应关系。所以http客户端会假设第一个返回的响应是对应第一个请求的。如果乱序返回，就会导致问题。
![](https://img-blog.csdnimg.cn/20201121111111582.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center)
在http2.0中，每个请求会分配一个id，响应中也会返回对应的id，这样就算乱序返回，http客户端也可以知道响应所对应的请求。在http1.1这种情况下，http服务器的实现就会变得复杂，服务器可以以串行的方式处理请求，当前面请求的响应返回到客户端后，再继续处理下一个请求，这种实现方式是相对简单的，但是很明显，这种方式相对来说还是比较低效的，另一种实现方式是并行处理请求，串行返回，这样可以让请求得到尽快的处理，比如两个请求都访问数据库，那并行处理两个请求就会比串行快得多，但是这种实现方式相对比较复杂，nodejs就是属于这种方式，下面我们来看一下nodejs中是如何实现的。首先我们看一下如何创建一个http服务器。
```go
function createServer(opts, requestListener) {  
  return new Server(opts, requestListener);  
}  
  
function Server(options, requestListener) {  
  // 可以自定义表示请求的对象和响应的对象  
  this[kIncomingMessage] = options.IncomingMessage || IncomingMessage;  
  this[kServerResponse] = options.ServerResponse || ServerResponse;  
  // 允许半关闭  
  net.Server.call(this, { allowHalfOpen: true });  
  // 有请求时的回调  
  if (requestListener) {  
    this.on('request', requestListener);  
  }  
  // 服务器socket读端关闭时是否允许继续处理队列里的响应（tcp上有多个请求，pipeline）   
  this.httpAllowHalfOpen = false;  
  // 有连接时的回调，由net模块触发  
  this.on('connection', connectionListener);  
  // 同一个tcp连接上，两个请求之前最多间隔的时间   
  this.keepAliveTimeout = 5000;  
  // 解析头部的超时时间，防止ddos  
  this.headersTimeout = 60 * 1000; // 60 seconds  
}  
```
nodejs监听了两个事件connection和request。分别表示在由新连接和新的http请求。我们主要看一下connect，因为发送http请求首先需要建立一个tcp连接。
```go
function connectionListener(socket) {
  defaultTriggerAsyncIdScope(
    getOrSetAsyncId(socket), connectionListenerInternal, this, socket
  );
}
function connectionListenerInternal(server, socket) {
  socket.server = server;
  // 分配一个http解析器
  const parser = parsers.alloc();
  // 解析请求报文
  parser.initialize(
    HTTPParser.REQUEST,
    new HTTPServerAsyncResource('HTTPINCOMINGMESSAGE', socket),
    server.maxHeaderSize || 0,
    server.insecureHTTPParser === undefined ?
      isLenient() : server.insecureHTTPParser,
  );
  parser.socket = socket;
  // 开始解析头部的开始时间
  parser.parsingHeadersStart = nowDate();
  socket.parser = parser;
  const state = {
    onData: null,
    onEnd: null,
    onClose: null,
    onDrain: null,
    // 同一tcp连接上，请求和响应的的队列
    outgoing: [],
    incoming: [],
    outgoingData: 0,
    keepAliveTimeoutSet: false
  };
  state.onData = socketOnData.bind(undefined, server, socket, parser, state);
  state.onEnd = socketOnEnd.bind(undefined, server, socket, parser, state);
  // tcp连接上有数据到来时的回调
  socket.on('data', state.onData);
  // tcp读端结束时的回调
  socket.on('end', state.onEnd);
  // 解析完http请求头时的回调
  parser.onIncoming = parserOnIncoming.bind(undefined, server, socket, state);
}
```
nodejs注册了事件等待tcp上数据的到来。我们看一下有数据到来时nodejs的处理。
```go
function socketOnData(server, socket, parser, state, d) {
  // 交给http解析器处理
  const ret = parser.execute(d);
  onParserExecuteCommon(server, socket, parser, state, ret, d);
}
```
我们看一下http解析器的一些逻辑。
```go
const parsers = new FreeList('parsers', 1000, function parsersCb() {
  const parser = new HTTPParser();
  cleanParser(parser);
  // 解析完头部的回调
  parser.onIncoming = null;
  // 解析http头时的回调，在http头个数达到阈值时回调，可能会回调多次
  parser[kOnHeaders] = parserOnHeaders;
  // 解析完http头时的回调，会执行onIncoming 
  parser[kOnHeadersComplete] = parserOnHeadersComplete;
  // 解析body时的回调
  parser[kOnBody] = parserOnBody;
  // 解析完http报文时的回调
  parser[kOnMessageComplete] = parserOnMessageComplete;
  return parser;
});
```
从上面的代码中我们可以知道，nodejs在tcp连接上接收到数据后，会交给http解析器处理，http是一个非常复杂的状态机，在解析数据的时候会回调nodejs设置的各种钩子。这里我们只需要关注kOnHeadersComplete钩子。
```go
function parserOnHeadersComplete(versionMajor, versionMinor, headers, method,
                                 url, statusCode, statusMessage, upgrade,
                                 shouldKeepAlive) {
  // 新建一个表示请求的对象，一般是IncomingMessage
  const ParserIncomingMessage = (socket && socket.server &&
                                 socket.server[kIncomingMessage]) ||
                                 IncomingMessage;
  // 新建一个IncomingMessage对象
  const incoming = parser.incoming = new ParserIncomingMessage(socket);
  incoming.httpVersionMajor = versionMajor;
  incoming.httpVersionMinor = versionMinor;
  incoming.httpVersion = `${versionMajor}.${versionMinor}`;
  incoming.url = url;
  incoming.upgrade = upgrade;
  // ...
  // 执行回调
  return parser.onIncoming(incoming, shouldKeepAlive);
}
```
我们刚才看到nodejs注册的onIncoming回调是parserOnIncoming。
```go
function parserOnIncoming(server, socket, state, req, keepAlive) {
  // 标记头部解析完毕
  socket.parser.parsingHeadersStart = 0;
  // 请求入队
  state.incoming.push(req);
  // 新建一个表示响应的对象，一般是ServerResponse
  const res = new server[kServerResponse](req);
  // socket当前已经在处理其他请求的响应，则先排队，否则挂载响应对象到socket，作为当前处理的响应
  if (socket._httpMessage) {
    state.outgoing.push(res);
  } else {
    res.assignSocket(socket); // socket._httpMessage = res;
  }
  // 响应处理完毕后，需要做一些处理
  res.on('finish', resOnFinish.bind(undefined, req, res, socket, state, server));
  // 触发request事件说明有请求到来
  server.emit('request', req, res);
  return 0;
}
```
当nodejs解析http请求头完成后，就会创建一个ServerResponse对象表示响应。然后判断当前是否有正在处理的响应，如果有则排队等待处理，否则把新建的ServerResponse对象作为当前需要处理的响应。最后触发request事件通知用户层。用户就可以进行请求的处理了。我们看到nodejs维护了两个队列，分别是请求和响应队列。
![](https://img-blog.csdnimg.cn/20201121110909139.png#pic_center)
当前处理的请求在请求队列的队首，该请求对应的响应会挂载到socket的_httpMessage属性上。但是我们看到nodejs会触发request事件通知用户有新请求到来，所有在pipeline的情况下，nodejs会并行处理多个请求（如果是cpu密集型的请求则实际上还是会变成串行，这和nodejs的单线程相关）。那nodejs是如何控制响应的顺序的呢？我们知道每次触发request事件的时候，我们都会执行一个函数。比如下面的代码。
```go
 http.createServer((req, res) => {
  // 一些网络io
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('okay');
});
```
我们看到每个请求的处理是独立的。假设每个请求都去操作数据库，如果请求2比请求1先完成数据库的操作，从而请求2先执行res.write和res.end。那岂不是请求2先返回？我们看一下ServerResponse和OutgoingMessage的实现，揭开迷雾。ServerResponse是OutgoingMessage的子类。write函数是在OutgoingMessage中实现的，write的调用链路很长，我们不层层分析，直接看最后的节点。
```go
function _writeRaw(data, encoding, callback) {
  const conn = this.socket;
  // socket对应的响应是自己并且可写
  if (conn && conn._httpMessage === this && conn.writable) {
    // 如果有缓存的数据则先发送缓存的数据
    if (this.outputData.length) {
      this._flushOutput(conn);
    }
    // 接着发送当前需要发送的
    return conn.write(data, encoding, callback);
  }
  // socket当前处理的响应对象不是自己，则先缓存数据。
  this.outputData.push({ data, encoding, callback });
  this.outputSize += data.length;
  this._onPendingData(data.length);
  return this.outputSize < HIGH_WATER_MARK;
}
```
我们看到我们调用res.write的时候，nodejs会首先判断，res是不是属于当前处理中响应，如果是才会真正发送数据，否则会先把数据缓存起来。分析到这里，相信大家已经差不多明白nodejs是如何控制响应按序返回的。最后我们看一下这些缓存的数据什么时候会被发送出去。前面代码已经贴过，当一个响应结束的时候，nodejs会做一些处理。
```go
res.on('finish', resOnFinish.bind(undefined, req, res, socket, state, server));
```
我们看看resOnFinish
```go
function resOnFinish(req, res, socket, state, server) {
  // 删除响应对应的请求
  state.incoming.shift();
  clearIncoming(req);
  // 解除socket上挂载的响应对象
  res.detachSocket(socket);
  req.emit('close');
  process.nextTick(emitCloseNT, res);
  // 是不是最后一个响应
  if (res._last) {
    // 是则销毁socket
    if (typeof socket.destroySoon === 'function') {
      socket.destroySoon();
    } else {
      socket.end();
    }
  } else if (state.outgoing.length === 0) {
    // 没有待处理的响应了，则重新设置超时时间，等待请求的到来，一定时间内没有请求则触发timeout事件
    if (server.keepAliveTimeout && typeof socket.setTimeout === 'function') {
      socket.setTimeout(server.keepAliveTimeout);
      state.keepAliveTimeoutSet = true;
    }
  } else {
    // 获取下一个要处理的响应
    const m = state.outgoing.shift();
    // 挂载到socket作为当前处理的响应
    if (m) {
      m.assignSocket(socket);
    }
  }
}
```
我们看到，nodejs处理完一个响应后，会做一些判断。分别有三种情况，我们分开分析。
1 是否是最后一个响应
什么情况下，会被认为是最后一个响应的？因为响应和请求是一一对应的，最后一个响应就意味着最后一个请求了，那么什么时候被认为是最后一个请求呢？当非pipeline的情况下，一个请求一个响应，然后关闭tcp连接，所以非pipeline的情况下，tcp上的第一个也是唯一一个请求就是最后一个请求。在pipeline的情况下，理论上就没有所谓的最后一个响应。但是实现上会做一些限制。在pipeline的情况下，每一个响应可以通过设置http响应头connection来定义是否发送该响应后就断开连接，我们看一下nodejs的实现。
```go
  // 是否显示删除过connection头，是则响应后断开连接，并标记当前响应是最后一个
  if (this._removedConnection) {
    this._last = true;
    this.shouldKeepAlive = false;
  } else if (!state.connection) {
    /*
      没有显示设置了connection头，则取默认行为
      1 shouldKeepAlive默认为true
      2 设置content-length或使用chunk模式才能区分响应报文编边界，才能支持keepalive
      3 使用了代理，代理是复用tcp连接的，支持keepalive
    */
    const shouldSendKeepAlive = this.shouldKeepAlive &&
        (state.contLen || this.useChunkedEncodingByDefault || this.agent);
    if (shouldSendKeepAlive) {
      header += 'Connection: keep-alive\r\n';
    } else {
      this._last = true;
      header += 'Connection: close\r\n';
    }
  }
```
另外当读端关闭的时候，也被认为是最后一个请求，毕竟不会再发送请求了。我们看一下读端关闭的逻辑。
```go
function socketOnEnd(server, socket, parser, state) {
  const ret = parser.finish();

  if (ret instanceof Error) {
    socketOnError.call(socket, ret);
    return;
  }
  // 不允许半开关则终止请求的处理，不响应，关闭写端
  if (!server.httpAllowHalfOpen) {
    abortIncoming(state.incoming);
    if (socket.writable) socket.end();
  } else if (state.outgoing.length) {
    // 允许半开关，并且还有响应需要处理，标记响应队列最后一个节点为最后的响应，处理完就关闭socket写端
    state.outgoing[state.outgoing.length - 1]._last = true;
  } else if (socket._httpMessage) {
    // 没有等待处理的响应了，但是还有正在处理的响应，则标记为最后一个响应
    socket._httpMessage._last = true;
  } else if (socket.writable) {
    // 否则关闭socket写端
    socket.end();
  }
}
```
以上就是nodejs中判断是否是最后一个响应的情况，如果一个响应被认为是最后一个响应，那么发送响应后就会关闭连接。
2 响应队列为空
我们继续看一下如果不是最后一个响应的时候，nodejs又是怎么处理的。如果当前的待处理响应队列为空，说明当前处理的响应是目前最后一个需要处理的，但是不是tcp连接上最后一个响应，这时候，nodejs会设置超时时间，如果超时还没有新的请求，则nodejs会关闭连接。
3 响应队列非空
如果当前待处理队列非空，处理完当前请求后会继续处理下一个响应。并从队列中删除该响应。我们看一下nodejs是如何处理下一个响应的。
```go
// 把响应对象挂载到socket，标记socket当前正在处理的响应
ServerResponse.prototype.assignSocket = function assignSocket(socket) {
  // 挂载到socket上，标记是当前处理的响应
  socket._httpMessage = this;
  socket.on('close', onServerResponseClose);
  this.socket = socket;
  this.emit('socket', socket);
  this._flush();
};
```
我们看到nodejs是通过_httpMessage标记当前处理的响应的，配合响应队列来实现响应的按序返回。标记完后执行_flush发送响应的数据（如果这时候请求已经被处理完成）

```go
OutgoingMessage.prototype._flush = function _flush() {
  const socket = this.socket;
  if (socket && socket.writable) {
    const ret = this._flushOutput(socket);
};

OutgoingMessage.prototype._flushOutput = function _flushOutput(socket) {
  // 之前设置了加塞，则操作socket先积攒数据
  while (this[kCorked]) {
    this[kCorked]--;
    socket.cork();
  }

  const outputLength = this.outputData.length;
  // 没有数据需要发送
  if (outputLength <= 0)
    return undefined;

  const outputData = this.outputData;
  // 加塞，让数据一起发送出去
  socket.cork();
  // 把缓存的数据写到socket
  let ret;
  for (let i = 0; i < outputLength; i++) {
    const { data, encoding, callback } = outputData[i];
    ret = socket.write(data, encoding, callback);
  }
  socket.uncork();

  this.outputData = [];
  this._onPendingData(-this.outputSize);
  this.outputSize = 0;

  return ret;
}
```
以上就是nodejs中对于pipeline的实现。
