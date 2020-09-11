# 第十九章 udp
udp不是面向连接的协议，所以使用上会比tcp简单，但是作为传输层的协议，udp虽然没有tcp那么复杂，但是他和tcp一样，使用四元组来标记通信的双方（单播的情况下）。我们看看udp作为服务器和客户端的时候的流程。
#  1 在c语言中使用udp
## 1.1 服务器流程（伪代码）
```
// 申请一个socket
int fd = socket(...);
// 绑定一个众所周知的地址，像tcp一样
bind(fd, ip， port);
// 直接阻塞等待消息的到来，因为udp不是面向连接的，所以不需要listen
recvmsg()；
```
## 1.2 客户端流程
客户端的流程有多种方式，原因在于源ip和端口可以有多种设置方式，不像服务器一样，服务器的ip和端口是需要对外公布的，否则客户端就无法找到目的地进行通信。这就意味着服务器的ip端口是需要用户显式指定的，而客户端则不然，客户端的ip端口是随意选择的，用户可以自己指定，也可以由操作系统决定，下面我们看看各种使用方式。<br />
1.2.1 显式指定ip端口
```c
// 申请一个socket
int fd = socket(...);
// 绑定一个客户端的地址
bind(fd, ip， port);
// 给服务器发送数据
sendto(fd, 服务器ip,服务器端口, data);
```
1.2.2 由操作系统决定源ip和端口
```c
// 申请一个socket
int fd = socket(...);
// 给服务器发送数据
sendto(fd, 服务器ip,服务器端口, data)
```
我们看到这里直接就给服务器发送数据，如果用户不指定ip和端口，则操作系统会提供默认的源ip和端口，不过端口是在第一个调用sendto的时候就设置了，并且不能修改，但是如果是多宿主主机，每次调用sendto的时候，操作系统会动态选择源ip。另外还有另外一种使用方式。
```c
// 申请一个socket
int fd = socket(...);
connect(fd, 服务器ip，服务器端口);
// 给服务器发送数据,或者sendto(fd, null,null, data)，调用sendto则不需要再指定服务器ip和端口
write(fd, data);
```
我们可以先调用connect绑定服务器ip和端口到fd，然后直接调用write发送数据。
虽然使用方式很多，但是归根到底还是对四元组设置的管理。bind是绑定源ip端口到fd，connect是绑定服务器ip端口到fd。我们可以主动调用他们来对fd进行设置，也可以让操作系统随机选择。
## 1.3 发送数据
我们刚才看到使用udp之前都需要调用socket函数申请一个socket，虽然调用socket函数返回的是一个fd，但是在操作系统中，的确是新建了一个socket对象，fd只是一个索引，操作这个fd的时候，操作系统会根据这个fd找到对应的socket。socket是一个非常复杂的结构体，我们可以理解为一个对象。这个对象中有两个属性，一个是读缓冲区大小，一个是写缓冲区大小。当我们发送数据的时候，虽然理论上可以发送任意大小的数据，但是因为受限于发送缓冲区的大小，如果需要发送的数据比当前缓冲区大小大则会导致一些问题，我们分情况分析一下。
1 发送的数据大小比当前缓冲区大，如果设置了非阻塞模式，则返回EAGAIN，如果是阻塞模式，则会引起进程的阻塞。
2 如果发送的数据大小比缓冲区的最大值还大，则会导致一直阻塞或者返回EAGAIN。我们可能会想到修改缓冲区最大值的大小，但是这个大小也是有限制的。
讲完一些边界情况，我们再来看看正常的流程，我们看看发送一个数据包的流程
1 首先在socket的写缓冲区申请一块内存用于数据发送。
2 调用ip层发送接口，如果数据包大小超过了ip层的限制，则需要分包。因为udp不是可靠的，所以不需要缓存这个数据包。
这就是udp发送数据的流程。

## 1.4 接收数据
当收到一个udp数据包的时候，操作系统首先会把这个数据包缓存到socket的缓冲区，如果收到的数据包比当前缓冲区大小大，则丢弃数据包（关于大小的限制可以参考1.3章节），否则把数据包挂载到接收队列，等用户来读取的时候，就逐个摘下接收队列的节点。

# 2 在nodejs中使用udp
## 2.1 udp服务器
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

## 2.2 客户端
udp客户端的流程是<br />
1 调用bind绑定客户端的地址信息<br />
2 调用connect绑定服务器的地址信息<br />
3 调用sendmsg和recvmsg进行数据通信<br />
我们看一下nodejs里的流程
```go
const dgram = require('dgram');
const message = Buffer.from('Some bytes');
const client = dgram.createSocket('udp4');
client.connect(41234, 'localhost', (err) => {
  client.send(message, (err) => {
    client.close();
  });
});
```
我们看到nodejs首先调用connect绑定服务器的地址，然后调用send发送信息，最后调用close。我们一个个分析。首先看connect。
```go
Socket.prototype.connect = function(port, address, callback) {
  port = validatePort(port);
  // 参数处理
  if (typeof address === 'function') {
    callback = address;
    address = '';
  } else if (address === undefined) {
    address = '';
  }

  validateString(address, 'address');
  const state = this[kStateSymbol];
  // 不是初始化状态
  if (state.connectState !== CONNECT_STATE_DISCONNECTED)
    throw new ERR_SOCKET_DGRAM_IS_CONNECTED();
  // 设置socket状态
  state.connectState = CONNECT_STATE_CONNECTING;
  // 还没有绑定客户端地址信息，则先绑定随机地址（操作系统决定）
  if (state.bindState === BIND_STATE_UNBOUND)
    this.bind({ port: 0, exclusive: true }, null);
  // 执行bind的时候，state.bindState不是同步设置的
  if (state.bindState !== BIND_STATE_BOUND) {
    enqueue(this, _connect.bind(this, port, address, callback));
    return;
  }

  _connect.call(this, port, address, callback);
};
```
这里分为两种情况，一种是在connect之前已经调用了bind，第二种是没有调用bind，如果没有调用bind，则在connect之前先要调用bind。我们只分析没有调用bind的情况，因为这是最长的链路。我们看一下bind的逻辑。
```go
// port = {posrt: 0, exclusive : true}, address_ = null
Socket.prototype.bind = function(port_, address_ /* , callback */) {
  let port = port_;
  const state = this[kStateSymbol];
  state.bindState = BIND_STATE_BINDING;

  let address;
  let exclusive;
  // 修正参数，这里的port是0，address是null
  if (port !== null && typeof port === 'object') {
    address = port.address || '';
    exclusive = !!port.exclusive;
    port = port.port;
  } else {
    address = typeof address_ === 'function' ? '' : address_;
    exclusive = false;
  }
  // 没传地址默认取全部ip
  if (!address) {
    if (this.type === 'udp4')
      address = '0.0.0.0';
    else
      address = '::';
  }
  // 这里的地址是ip地址，所以不需要dns解析，但是lookup会在nexttick的时候执行回调
  state.handle.lookup(address, (err, ip) => {
      const err = state.handle.bind(ip, port || 0, flags);
      startListening(this);
  });
  return this;
};
```
因为bind函数中的lookup不是同步执行传入的callback，所以这时候会先返回到connect函数。从而connect函数执行以下代码。

```go
if (state.bindState !== BIND_STATE_BOUND) {
    enqueue(this, _connect.bind(this, port, address, callback));
    return;
  }
```
connect函数先把回调加入队列。
```go

function enqueue(self, toEnqueue) {
  const state = self[kStateSymbol];
  if (state.queue === undefined) {
    state.queue = [];
    self.once('error', onListenError);
    self.once('listening', onListenSuccess);
  }
  state.queue.push(toEnqueue);
}
```
enqueue把回调加入队列，并且监听了listening事件，该事件在bind成功后触发。这时候connect函数就执行完了，等待bind成功后（nexttick）会执行 startListening(this)。
```go
function startListening(socket) {
  const state = socket[kStateSymbol];
  state.handle.onmessage = onMessage;
  // 注册等待可读事件
  state.handle.recvStart();
  state.receiving = true;
  // 标记已bind成功
  state.bindState = BIND_STATE_BOUND;

  if (state.recvBufferSize)
    bufferSize(socket, state.recvBufferSize, RECV_BUFFER);

  if (state.sendBufferSize)
    bufferSize(socket, state.sendBufferSize, SEND_BUFFER);
  // 触发listening事件
  socket.emit('listening');
}
```
我们看到这里（bind成功后）触发了listening事件，从而执行我们刚才入队的回调onListenSuccess。

```go
function onListenSuccess() {
  this.removeListener('error', onListenError);
  clearQueue.call(this);
}

function clearQueue() {
  const state = this[kStateSymbol];
  const queue = state.queue;
  state.queue = undefined;

  for (const queueEntry of queue)
    queueEntry();
}

```
回调就是把队列中的回调执行一遍，connect函数设置的回调是_connect。
```go
function _connect(port, address, callback) {
  const state = this[kStateSymbol];
  if (callback)
    this.once('connect', callback);

  const afterDns = (ex, ip) => {
    defaultTriggerAsyncIdScope(
      this[async_id_symbol],
      doConnect,
      ex, this, ip, address, port, callback
    );
  };

  state.handle.lookup(address, afterDns);
}
```
这里的address是服务器地址，_connect函数主要逻辑是<br />
1 监听connect事件<br />
2 对服务器地址进行dns解析（如果需要的话）。解析成功后执行afterDns，最后执行doConnect，并传入解析出来的ip。我们看看doConnect
```go
function doConnect(ex, self, ip, address, port, callback) {
  const state = self[kStateSymbol];
  // dns解析成功，执行底层的connect
  if (!ex) {
    const err = state.handle.connect(ip, port);
    if (err) {
      ex = exceptionWithHostPort(err, 'connect', address, port);
    }
  }

  // connect成功，触发connect事件
  state.connectState = CONNECT_STATE_CONNECTED;
  process.nextTick(() => self.emit('connect'));
}
```
connect函数通过c++层，然后调用libuv，到操作系统的connect。作用是把服务器地址保存到socket中。connect的流程就走完了。接下来我们就可以调用send和recv发送和接收数据。

