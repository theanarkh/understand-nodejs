# 第十九章 udp
## udp服务器
我们从一个使用例子开始看看udp模块的实现。
```c
const dgram = require('dgram');
// 创建一个socket对象
const server = dgram.createSocket('udp4');
// 监听udp数据的到来
server.on('message', (msg, rinfo) => {
  // 处理数据
});
// 绑定端口
server.bind(41234);
```
我们看到创建一个udp服务器很简单，首先申请一个socket对象，在nodejs中和操作系统中一样，socket是对网络通信的一个抽象，我们可以把他理解成对传输层的抽象，他可以代表tcp也可以代表udp。我们看一下createSocket做了什么。
```go
function createSocket(type, listener) {
  return new Socket(type, listener);
}
```

```go
function Socket(type, listener) {
  EventEmitter.call(this);
  let lookup;
  let recvBufferSize;
  let sendBufferSize;

  let options;
  if (type !== null && typeof type === 'object') {
    options = type;
    type = options.type;
    lookup = options.lookup;
    recvBufferSize = options.recvBufferSize;
    sendBufferSize = options.sendBufferSize;
  }
  const handle = newHandle(type, lookup); 
  this.type = type;
  if (typeof listener === 'function')
    this.on('message', listener);
    
  this[kStateSymbol] = {
    handle,
    receiving: false,
    bindState: BIND_STATE_UNBOUND,
    connectState: CONNECT_STATE_DISCONNECTED,
    queue: undefined,
    reuseAddr: options && options.reuseAddr, // Use UV_UDP_REUSEADDR if true.
    ipv6Only: options && options.ipv6Only,
    recvBufferSize,
    sendBufferSize
  };
}
```
我们看到一个socket对象是对handle的一个封装。我们看看handle是什么。

```go
function newHandle(type, lookup) {
  // 用于dns解析的函数，比如我们调send的时候，传的是一个域名
  if (lookup === undefined) {
    if (dns === undefined) {
      dns = require('dns');
    }

    lookup = dns.lookup;
  } 

  if (type === 'udp4') {
    const handle = new UDP();
    handle.lookup = lookup4.bind(handle, lookup);
    return handle;
  }
  // 忽略ipv6的处理
}
```
handle又是对UDP模块的封装，UDP是c++模块，我们看看该c++模块的定义。

```go
// 定义一个v8函数模块
Local<FunctionTemplate> t = env->NewFunctionTemplate(New);
  // t新建的对象需要额外拓展的内存
  t->InstanceTemplate()->SetInternalFieldCount(1);
  // 导出给js层使用的名字
  Local<String> udpString = FIXED_ONE_BYTE_STRING(env->isolate(), "UDP");
  t->SetClassName(udpString);
  // 属性的存取属性
  enum PropertyAttribute attributes =
      static_cast<PropertyAttribute>(ReadOnly | DontDelete);
  
  Local<Signature> signature = Signature::New(env->isolate(), t);
  // 新建一个函数模块
  Local<FunctionTemplate> get_fd_templ =
      FunctionTemplate::New(env->isolate(),
                            UDPWrap::GetFD,
                            env->as_callback_data(),
                            signature);
  // 设置一个访问器，访问fd属性的时候，执行get_fd_templ，从而执行UDPWrap::GetFD
  t->PrototypeTemplate()->SetAccessorProperty(env->fd_string(),
                                              get_fd_templ,
                                              Local<FunctionTemplate>(),
                                              attributes);
  // 导出的函数
  env->SetProtoMethod(t, "open", Open);
  // 忽略一系列函数
  // 导出给js层使用
  target->Set(env->context(),
              udpString,
              t->GetFunction(env->context()).ToLocalChecked()).Check();
```
在c++层通用逻辑中我们讲过相关的知识，这里就不详细讲述了，当我们在js层new UDP的时候，会新建一个c++对象。
```go
UDPWrap::UDPWrap(Environment* env, Local<Object> object)
    : HandleWrap(env,
                 object,
                 reinterpret_cast<uv_handle_t*>(&handle_),
                 AsyncWrap::PROVIDER_UDPWRAP) {
  int r = uv_udp_init(env->event_loop(), &handle_);
}
```
执行了uv_udp_init初始化udp对应的handle。我们看一下libuv的定义。

```go
int uv_udp_init_ex(uv_loop_t* loop, uv_udp_t* handle, unsigned int flags) {
  int domain;
  int err;
  int fd;

  /* Use the lower 8 bits for the domain */
  domain = flags & 0xFF;
  // 申请一个socket，返回一个fd
  fd = uv__socket(domain, SOCK_DGRAM, 0);
  uv__handle_init(loop, (uv_handle_t*)handle, UV_UDP);
  handle->alloc_cb = NULL;
  handle->recv_cb = NULL;
  handle->send_queue_size = 0;
  handle->send_queue_count = 0;
  // 初始化io观察者（还没有注册到事件循环的poll io阶段），监听的文件描述符是fd，回调是uv__udp_io
  uv__io_init(&handle->io_watcher, uv__udp_io, fd);
  // 初始化写队列
  QUEUE_INIT(&handle->write_queue);
  QUEUE_INIT(&handle->write_completed_queue);
  return 0;
}
```
到这里，就是我们在js层执行dgram.createSocket('udp4')的时候，在nodejs中主要的执行过程。回到最开始的例子，我们看一下执行bind的时候的逻辑。

```go
Socket.prototype.bind = function(port_, address_ /* , callback */) {
  let port = port_;
  // socket的状态
  const state = this[kStateSymbol];
  // 已经绑定过了则报错
  if (state.bindState !== BIND_STATE_UNBOUND)
    throw new ERR_SOCKET_ALREADY_BOUND();
  // 否则标记已经绑定了
  state.bindState = BIND_STATE_BINDING;
  // 没传地址则默认绑定所有地址
  if (!address) {
    if (this.type === 'udp4')
      address = '0.0.0.0';
    else
      address = '::';
  }
  // dns解析后在绑定，如果需要的话
  state.handle.lookup(address, (err, ip) => {
    if (err) {
      state.bindState = BIND_STATE_UNBOUND;
      this.emit('error', err);
      return;
    }
	const err = state.handle.bind(ip, port || 0, flags);
    if (err) {
       const ex = exceptionWithHostPort(err, 'bind', ip, port);
       state.bindState = BIND_STATE_UNBOUND;
       this.emit('error', ex);
       // Todo: close?
       return;
     }

     startListening(this);
  return this;
}
```
bind函数主要的逻辑是handle.bind和startListening。我们一个个看。我们看一下c++层的bind。

```go
void UDPWrap::DoBind(const FunctionCallbackInfo<Value>& args, int family) {
  UDPWrap* wrap;
  ASSIGN_OR_RETURN_UNWRAP(&wrap,
                          args.Holder(),
                          args.GetReturnValue().Set(UV_EBADF));

  // bind(ip, port, flags)
  CHECK_EQ(args.Length(), 3);
  node::Utf8Value address(args.GetIsolate(), args[0]);
  Local<Context> ctx = args.GetIsolate()->GetCurrentContext();
  uint32_t port, flags;
  if (!args[1]->Uint32Value(ctx).To(&port) ||
      !args[2]->Uint32Value(ctx).To(&flags))
    return;
  struct sockaddr_storage addr_storage;
  int err = sockaddr_for_family(family, address.out(), port, &addr_storage);
  if (err == 0) {
    err = uv_udp_bind(&wrap->handle_,
                      reinterpret_cast<const sockaddr*>(&addr_storage),
                      flags);
  }

  args.GetReturnValue().Set(err);
}
```
也没有太多逻辑，处理参数然后执行uv_udp_bind，uv_udp_bind就不具体展开了，和tcp类似，设置一些标记和属性，然后执行操作系统bind的函数把本端的ip和端口保存到socket中。我们继续看startListening。
```go
function startListening(socket) {
  const state = socket[kStateSymbol];
  // 有数据时的回调，触发message事件
  state.handle.onmessage = onMessage;
  // 重点，开始监听数据
  state.handle.recvStart();
  state.receiving = true;
  state.bindState = BIND_STATE_BOUND;

  if (state.recvBufferSize)
    bufferSize(socket, state.recvBufferSize, RECV_BUFFER);

  if (state.sendBufferSize)
    bufferSize(socket, state.sendBufferSize, SEND_BUFFER);

  socket.emit('listening');
}
```
重点是recvStart函数，我们到c++的实现。
```go
void UDPWrap::RecvStart(const FunctionCallbackInfo<Value>& args) {
  UDPWrap* wrap;
  ASSIGN_OR_RETURN_UNWRAP(&wrap,
                          args.Holder(),
                          args.GetReturnValue().Set(UV_EBADF));
  int err = uv_udp_recv_start(&wrap->handle_, OnAlloc, OnRecv);
  // UV_EALREADY means that the socket is already bound but that's okay
  if (err == UV_EALREADY)
    err = 0;
  args.GetReturnValue().Set(err);
}
```
OnAlloc, OnRecv分别是分配内存接收数据的函数和数据到来时执行的回调。继续看libuv
```go
int uv__udp_recv_start(uv_udp_t* handle,
                       uv_alloc_cb alloc_cb,
                       uv_udp_recv_cb recv_cb) {
  int err;


  err = uv__udp_maybe_deferred_bind(handle, AF_INET, 0);
  if (err)
    return err;
  // 保存一些上下文
  handle->alloc_cb = alloc_cb;
  handle->recv_cb = recv_cb;
  // 注册io观察者到loop，如果事件到来，等到poll io阶段处理
  uv__io_start(handle->loop, &handle->io_watcher, POLLIN);
  uv__handle_start(handle);

  return 0;
}
```
uv__udp_recv_start主要是注册io观察者到loop，等待事件到来的时候，在poll io阶段处理。前面我们讲过，回调函数是uv__udp_io。我们看一下事件触发的时候，该函数怎么处理的。
```go
static void uv__udp_io(uv_loop_t* loop, uv__io_t* w, unsigned int revents) {
  uv_udp_t* handle;

  handle = container_of(w, uv_udp_t, io_watcher);
  // 可读事件触发
  if (revents & POLLIN)
    uv__udp_recvmsg(handle);
  // 可写事件触发
  if (revents & POLLOUT) {
    uv__udp_sendmsg(handle);
    uv__udp_run_completed(handle);
  }
}
```
我们这里先分析可读事件的逻辑。我们看uv__udp_recvmsg。

```go
static void uv__udp_recvmsg(uv_udp_t* handle) {
  struct sockaddr_storage peer;
  struct msghdr h;
  ssize_t nread;
  uv_buf_t buf;
  int flags;
  int count;

  count = 32;

  do {
    // 分配内存接收数据，c++层设置的
    buf = uv_buf_init(NULL, 0);
    handle->alloc_cb((uv_handle_t*) handle, 64 * 1024, &buf);
    memset(&h, 0, sizeof(h));
    memset(&peer, 0, sizeof(peer));
    h.msg_name = &peer;
    h.msg_namelen = sizeof(peer);
    h.msg_iov = (void*) &buf;
    h.msg_iovlen = 1;
    // 调操作系统的函数读取数据
    do {
      nread = recvmsg(handle->io_watcher.fd, &h, 0);
    }
    while (nread == -1 && errno == EINTR);
    // 调用c++层回调
    handle->recv_cb(handle, nread, &buf, (const struct sockaddr*) &peer, flags);
  }
}
```
libuv会回调c++层，然后c++层回调到js层，最后触发message事件，这就是对应开始那段代码的message事件。
