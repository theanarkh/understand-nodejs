
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
### 1.2.1 显式指定ip端口
```c
// 申请一个socket
int fd = socket(...);
// 绑定一个客户端的地址
bind(fd, ip， port);
// 给服务器发送数据
sendto(fd, 服务器ip,服务器端口, data);
```
### 1.2.2 由操作系统决定源ip和端口
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

# 2 udp模块在nodejs中的实现
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
最终通过操作系统调用recvmsg读取数据，操作系统收到一个udp数据包的时候，会挂载到socket的接收队列，如果满了则会丢弃，当用户调用recvmsg函数的时候，操作系统就把接收队列中节点逐个返回给用户。读取完后，libuv会回调c++层，然后c++层回调到js层，最后触发message事件，这就是对应开始那段代码的message事件。

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
2 对服务器地址进行dns解析（只能是本地的配的域名）。解析成功后执行afterDns，最后执行doConnect，并传入解析出来的ip。我们看看doConnect
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

## 2.3 发送数据
发送数据接口是sendto，他是对send的封装。
```
Socket.prototype.send = function(buffer,
                                 offset,
                                 length,
                                 port,
                                 address,
                                 callback) {

  let list;
  const state = this[kStateSymbol];
  const connected = state.connectState === CONNECT_STATE_CONNECTED;
  // 没有调用connect绑定过服务端地址，则需要传服务端地址信息
  if (!connected) {
    if (address || (port && typeof port !== 'function')) {
      buffer = sliceBuffer(buffer, offset, length);
    } else {
      callback = port;
      port = offset;
      address = length;
    }
  } else {
    if (typeof length === 'number') {
      buffer = sliceBuffer(buffer, offset, length);
      if (typeof port === 'function') {
        callback = port;
        port = null;
      }
    } else {
      callback = offset;
    }
    // 已经绑定了服务端地址，则不能再传了
    if (port || address)
      throw new ERR_SOCKET_DGRAM_IS_CONNECTED();
  }
  // 如果没有绑定服务器端口，则这里需要传，并且校验
  if (!connected)
    port = validatePort(port);
  // 忽略一些参数处理逻辑
  // 没有绑定客户端地址信息，则需要先绑定，值由操作系统决定
  if (state.bindState === BIND_STATE_UNBOUND)
    this.bind({ port: 0, exclusive: true }, null);
  // bind还没有完成，则先入队，等待bind完成再执行
  if (state.bindState !== BIND_STATE_BOUND) {
    enqueue(this, this.send.bind(this, list, port, address, callback));
    return;
  }
  // 已经绑定了，设置服务端地址后发送数据
  const afterDns = (ex, ip) => {
    defaultTriggerAsyncIdScope(
      this[async_id_symbol],
      doSend,
      ex, this, ip, list, address, port, callback
    );
  };
  // 传了地址则可能需要dns解析
  if (!connected) {
    state.handle.lookup(address, afterDns);
  } else {
    afterDns(null, null);
  }
}
```
我们继续看doSend函数。
```
function doSend(ex, self, ip, list, address, port, callback) {
  const state = self[kStateSymbol];
  // dns解析出错
  if (ex) {
    if (typeof callback === 'function') {
      process.nextTick(callback, ex);
      return;
    }
    process.nextTick(() => self.emit('error', ex));
    return;
  }
  // 定义一个请求对象
  const req = new SendWrap();
  req.list = list;  // Keep reference alive.
  req.address = address;
  req.port = port;
  // 设置nodejs和用户的回调，oncomplete由c++层调用，callback由oncomplete调用
  if (callback) {
    req.callback = callback;
    req.oncomplete = afterSend;
  }

  let err;
  // 根据是否需要设置服务端地址，调c++层函数
  if (port)
    err = state.handle.send(req, list, list.length, port, ip, !!callback);
  else
    err = state.handle.send(req, list, list.length, !!callback);
  // err大于等于1说明同步发送成功了，直接执行回调，否则等待异步回调
  if (err >= 1) {
    if (callback)
      process.nextTick(callback, null, err - 1);
    return;
  }
  // 发送失败
  if (err && callback) {
    // Don't emit as error, dgram_legacy.js compatibility
    const ex = exceptionWithHostPort(err, 'send', address, port);
    process.nextTick(callback, ex);
  }
}
```
我们穿过c++层，直接看libuv的代码。
```
int uv__udp_send(uv_udp_send_t* req,
                 uv_udp_t* handle,
                 const uv_buf_t bufs[],
                 unsigned int nbufs,
                 const struct sockaddr* addr,
                 unsigned int addrlen,
                 uv_udp_send_cb send_cb) {
  int err;
  int empty_queue;

  assert(nbufs > 0);
  // 还没有绑定服务端地址，则绑定
  if (addr) {
    err = uv__udp_maybe_deferred_bind(handle, addr->sa_family, 0);
    if (err)
      return err;
  }
  // 当前写队列是否为空
  empty_queue = (handle->send_queue_count == 0);
  // 初始化一个写请求
  uv__req_init(handle->loop, req, UV_UDP_SEND);
  if (addr == NULL)
    req->addr.ss_family = AF_UNSPEC;
  else
    memcpy(&req->addr, addr, addrlen);
  // 保存上下文
  req->send_cb = send_cb;
  req->handle = handle;
  req->nbufs = nbufs;
  // 初始化数据，预分配的内存不够，则分配新的堆内存
  req->bufs = req->bufsml;
  if (nbufs > ARRAY_SIZE(req->bufsml))
    req->bufs = uv__malloc(nbufs * sizeof(bufs[0]));
  // 复制过去堆中
  memcpy(req->bufs, bufs, nbufs * sizeof(bufs[0]));
  // 更新写队列数据
  handle->send_queue_size += uv__count_bufs(req->bufs, req->nbufs);
  handle->send_queue_count++;
  // 插入写队列，等待可写事件的发生
  QUEUE_INSERT_TAIL(&handle->write_queue, &req->queue);
  uv__handle_start(handle);
  // 当前写队列为空，则直接开始写，否则设置等待可写队列
  if (empty_queue && !(handle->flags & UV_HANDLE_UDP_PROCESSING)) {
    // 发送数据
    uv__udp_sendmsg(handle);
    // 写队列是否非空，则设置等待可写事件，可写的时候接着写
    if (!QUEUE_EMPTY(&handle->write_queue))
      uv__io_start(handle->loop, &handle->io_watcher, POLLOUT);
  } else {
    uv__io_start(handle->loop, &handle->io_watcher, POLLOUT);
  }
  return 0;
}

```
该函数把写请求插入写队列中等待可写事件的到来。然后注册等待可写事件。当可写事件触发的时候，执行的函数是uv__udp_io。
```
static void uv__udp_io(uv_loop_t* loop, uv__io_t* w, unsigned int revents) {
  uv_udp_t* handle;
  if (revents & POLLOUT) {
    uv__udp_sendmsg(handle);
    uv__udp_run_completed(handle);
  }
}
```
我们先看uv__udp_sendmsg
```
static void uv__udp_sendmsg(uv_udp_t* handle) {
  uv_udp_send_t* req;
  QUEUE* q;
  struct msghdr h;
  ssize_t size;
  // 逐个节点发送
  while (!QUEUE_EMPTY(&handle->write_queue)) {
    q = QUEUE_HEAD(&handle->write_queue);
    req = QUEUE_DATA(q, uv_udp_send_t, queue);
    memset(&h, 0, sizeof h);
    // 忽略参数处理
    h.msg_iov = (struct iovec*) req->bufs;
    h.msg_iovlen = req->nbufs;

    do {
      size = sendmsg(handle->io_watcher.fd, &h, 0);
    } while (size == -1 && errno == EINTR);

    if (size == -1) {
      // 繁忙则先不发了，等到可写事件
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOBUFS)
        break;
    }
    // 记录发送结果
    req->status = (size == -1 ? UV__ERR(errno) : size);
    // 发送“完”移出写队列
    QUEUE_REMOVE(&req->queue);
    // 加入写完成队列
    QUEUE_INSERT_TAIL(&handle->write_completed_queue, &req->queue);
    // 有节点数据写完了，把io观察者插入pending队列，pending阶段执行回调uv__udp_io
    uv__io_feed(handle->loop, &handle->io_watcher);
  }
}
```
该函数遍历写队列，然后逐个发送节点中的数据，并记录发送结果，
1 如果写繁忙则结束写逻辑，等待下一次写事件触发。<br />
2 如果写成功则把节点插入写完成队列中，并且把io观察者插入pending队列，等待pending阶段执行回调uv__udp_io。
我们再次回到uv__udp_io中
```
if (revents & POLLOUT) {
    uv__udp_sendmsg(handle);
    uv__udp_run_completed(handle);
}
```
当写事件触发时，执行完数据发送的逻辑后还会处理写完成队列。我们看uv__udp_run_completed。
```
static void uv__udp_run_completed(uv_udp_t* handle) {
  uv_udp_send_t* req;
  QUEUE* q;
  handle->flags |= UV_HANDLE_UDP_PROCESSING;
  // 逐个节点处理
  while (!QUEUE_EMPTY(&handle->write_completed_queue)) {
    q = QUEUE_HEAD(&handle->write_completed_queue);
    QUEUE_REMOVE(q);
    req = QUEUE_DATA(q, uv_udp_send_t, queue);
    uv__req_unregister(handle->loop, req);
    // 更新待写数据大小
    handle->send_queue_size -= uv__count_bufs(req->bufs, req->nbufs);
    handle->send_queue_count--;
    // 如果重新申请了堆内存，则需要释放
    if (req->bufs != req->bufsml)
      uv__free(req->bufs);
    req->bufs = NULL;
    if (req->send_cb == NULL)
      continue;
    // 执行回调
    if (req->status >= 0)
      req->send_cb(req, 0);
    else
      req->send_cb(req, req->status);
  }
  // 写队列为空，则注销等待可写事件
  if (QUEUE_EMPTY(&handle->write_queue)) {
    uv__io_stop(handle->loop, &handle->io_watcher, POLLOUT);
    if (!uv__io_active(&handle->io_watcher, POLLIN))
      uv__handle_stop(handle);
  }
  handle->flags &= ~UV_HANDLE_UDP_PROCESSING;
}
```
这就是发送的逻辑，发送完后libuv会调用c++回调，最后回调js层回调。具体到操作系统也是类似的实现，操作系统首先判断数据的大小是否小于写缓冲区，是的话申请一块内存，然后构造udp协议数据包，再逐层往下调，最后发送出来，但是如果数据超过了底层的报文大小限制，则会被分片。

## 2.4 多播
udp支持多播，tcp则不支持，因为tcp是基于连接和可靠的，多播则会带来过多的连接和流量。多播分为局域网多播和广域网多播，我们知道在局域网内发生一个数据，是会以广播的形式发送到各个主机的，主机根据目的地址判断是否需要处理该数据包。如果udp是单播的模式，则只会有一个主机会处理该数据包。如果udp是多播的模式，则有多个主机处理该数据包。多播的时候，存在一个多播组的概念，只有加入这个组的主机才能处理该组的数据包。假设有以下局域网
![](https://img-blog.csdnimg.cn/2020091201131651.png#pic_center)
当主机1给多播组1发送数据的时候，主机2，4可以收到，主机3则无法收到。我们再来看看广域网的多播。广域网的多播需要路由器的支持，多个路由器之间会使用多播路由协议交换多播组的信息。假设有以下广域网。
![](https://img-blog.csdnimg.cn/20200912012350687.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center)
当主机1给多播组1发送数据的时候，路由器1会给路由器2发送一份数据（通过多播路由协议交换了信息，路由1知道路由器2的主机4在多播组1中），但是路由器2不会给路由器3发送数据，因为他知道路由器3对应的网络中没有主机在多播组1。以上是多播的一些概念。nodejs中关于多播的实现，基本是对操作系统api的封装，所以就不打算讲解，我们直接看操作系统中对于多播的实现。
### 2.4.1 加入一个多播组
可以通过以下代码加入一个多播组。
```go
setsockopt(fd,
           IPPROTO_IP,
           IP_ADD_MEMBERSHIP,
           &mreq, // device对应的ip和加入多播组的ip
           sizeof(mreq));
```
mreq的结构体定义如下
```go
struct ip_mreq 
{
	struct in_addr imr_multiaddr;	/* IP multicast address of group */
	struct in_addr imr_interface;	/* local IP address of interface */
};
```
我们看一下setsockopt的实现（只列出相关部分代码）
```go
	case IP_ADD_MEMBERSHIP: 
		{
			struct ip_mreq mreq;
			static struct options optmem;
			unsigned long route_src;
			struct rtable *rt;
			struct device *dev=NULL;
			err=verify_area(VERIFY_READ, optval, sizeof(mreq));
			memcpy_fromfs(&mreq,optval,sizeof(mreq));
 			// 没有设置device则根据多播组ip选择一个device
			if(mreq.imr_interface.s_addr==INADDR_ANY) 
			{
				if((rt=ip_rt_route(mreq.imr_multiaddr.s_addr,&optmem, &route_src))!=NULL)
				{
					dev=rt->rt_dev;
					rt->rt_use--;
				}
			}
			else
			{
				// 根据device ip找到，找到对应的device
				for(dev = dev_base; dev; dev = dev->next)
				{
					// 在工作状态、支持多播，ip一样
					if((dev->flags&IFF_UP)&&(dev->flags&IFF_MULTICAST)&&
						(dev->pa_addr==mreq.imr_interface.s_addr))
						break;
				}
			}
			// 加入多播组
			return ip_mc_join_group(sk,dev,mreq.imr_multiaddr.s_addr);
		}
		
```
拿到加入的多播组ip和device后，调用ip_mc_join_group，在socket结构体中，有一个字段维护了该socket加入的多播组信息。
![](https://img-blog.csdnimg.cn/20200913012214847.png#pic_center)
```go
int ip_mc_join_group(struct sock *sk , struct device *dev, unsigned long addr)
{
	int unused= -1;
	int i;
	// 还没有加入过多播组
	if(sk->ip_mc_list==NULL)
	{
		if((sk->ip_mc_list=(struct ip_mc_socklist *)kmalloc(sizeof(*sk->ip_mc_list), GFP_KERNEL))==NULL)
			return -ENOMEM;
		memset(sk->ip_mc_list,'\0',sizeof(*sk->ip_mc_list));
	}
	// 遍历加入的多播组队列，判断是否已经加入过
	for(i=0;i<IP_MAX_MEMBERSHIPS;i++)
	{
		if(sk->ip_mc_list->multiaddr[i]==addr && sk->ip_mc_list->multidev[i]==dev)
			return -EADDRINUSE;
		if(sk->ip_mc_list->multidev[i]==NULL)
			unused=i;
	}
	// 到这说明没有加入过当前设置的多播组，则记录并且加入
	if(unused==-1)
		return -ENOBUFS;
	sk->ip_mc_list->multiaddr[unused]=addr;
	sk->ip_mc_list->multidev[unused]=dev;
	// addr为多播组ip
	ip_mc_inc_group(dev,addr);
	return 0;
}
```
ip_mc_join_group函数的主要逻辑是把socket想加入的多播组信息记录到socket的ip_mc_list字段中（如果还没有加入过该多播组的话）。接着调ip_mc_inc_group往下走。device层维护了主机中使用了该device的多播组信息。![](https://img-blog.csdnimg.cn/20200913025353172.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center)
```go
static void ip_mc_inc_group(struct device *dev, unsigned long addr)
{
	struct ip_mc_list *i;
	// 遍历该设置维护的多播组队列，判断是否已经有socket加入过该多播组，是则引用数加一
	for(i=dev->ip_mc_list;i!=NULL;i=i->next)
	{
		if(i->multiaddr==addr)
		{
			i->users++;
			return;
		}
	}
	// 到这说明，还没有socket加入过当前多播组，则记录并加入
	i=(struct ip_mc_list *)kmalloc(sizeof(*i), GFP_KERNEL);
	if(!i)
		return;
	i->users=1;
	i->interface=dev;
	i->multiaddr=addr;
	i->next=dev->ip_mc_list;
	// 通过igmp通知其他方
	igmp_group_added(i);
	dev->ip_mc_list=i;
}
```
ip_mc_inc_group函数的主要逻辑是判断socket想要加入的多播组是不是已经存在于当前device中，如果不是则新增一个节点。继续调用igmp_group_added
```go
static void igmp_group_added(struct ip_mc_list *im)
{
	// 初始化定时器
	igmp_init_timer(im);
	// 发送一个igmp数据包，同步多播组信息（socket加入了一个新的多播组）
	igmp_send_report(im->interface, im->multiaddr, IGMP_HOST_MEMBERSHIP_REPORT);
	// 转换多播组ip到多播mac地址，并记录到device中
	ip_mc_filter_add(im->interface, im->multiaddr);
}
```
我们看看igmp_send_report和ip_mc_filter_add的具体逻辑。
```go
static void igmp_send_report(struct device *dev, unsigned long address, int type)
{
	// 申请一个skb表示一个数据包
	struct sk_buff *skb=alloc_skb(MAX_IGMP_SIZE, GFP_ATOMIC);
	int tmp;
	struct igmphdr *igh;
	// 构建ip头，ip协议头的源ip是INADDR_ANY，即随机选择一个本机的，目的ip为多播组ip（address）
	tmp=ip_build_header(skb, INADDR_ANY, address, &dev, IPPROTO_IGMP, NULL,
				skb->mem_len, 0, 1);
	// data表示所有的数据部分，tmp表示ip头大小，所以igh就是ip协议的数据部分，即igmp报文的内容
	igh=(struct igmphdr *)(skb->data+tmp);
	skb->len=tmp+sizeof(*igh);
	igh->csum=0;
	igh->unused=0;
	igh->type=type;
	igh->group=address;
	igh->csum=ip_compute_csum((void *)igh,sizeof(*igh));
	// 调用ip层发送出去
	ip_queue_xmit(NULL,dev,skb,1);
}
```
igmp_send_report其实就是构造一个igmp协议数据包，然后发送出去，igmp的协议格式如下
```go
struct igmphdr
{
	// 类型
	unsigned char type;
	unsigned char unused;
	// 校验和
	unsigned short csum;
	// igmp的数据部分，比如加入多播组的时候，group表示多播组ip
	unsigned long group;
};
```
接着我们看ip_mc_filter_add
```go
void ip_mc_filter_add(struct device *dev, unsigned long addr)
{
	char buf[6];
	// 把多播组ip转成mac多播地址
	addr=ntohl(addr);
	buf[0]=0x01;
	buf[1]=0x00;
	buf[2]=0x5e;
	buf[5]=addr&0xFF;
	addr>>=8;
	buf[4]=addr&0xFF;
	addr>>=8;
	buf[3]=addr&0x7F;
	dev_mc_add(dev,buf,ETH_ALEN,0);
}
```
我们知道ip地址是32位，mac地址是48位，但是IANA规定，ipv4组播MAC地址的高24位是0x01005E，第25位是0，低23位是ipv4组播地址的低23位。而多播的ip地址高四位固定是1110。另外低23位被映射到mac多播地址的23位，所以多播ip地址中，有5位是可以随机组合的。这就意味着，每32个多播ip地址，映射到一个mac地址。这会带来一些问题，假设主机x加入了多播组a，主机y加入了多播组b，而a和b对应的mac多播地址是一样的。当主机z给多播组a发送一个数据包的时候，这时候主机x和y的网卡都会处理该数据包，并上报到上层，但是多播组a对应的mac多播地址和多播组b是一样的。我们拿到一个多播组ip的时候，可以计算出他的多播mac地址，但是反过来就不行，因为一个多播mac地址对应了32个多播ip地址。那主机x和y怎么判断是不是发给自己的数据包？因为device维护了一个本device上的多播ip列表，操作系统根据收到的数据包中的ip目的地址和device的多播ip列表对比。如果在列表中，则说明是发给自己的。最后我们看看dev_mc_add。device中维护了当前的mac多播地址列表，他会把这个列表信息同步到网卡中，使得网卡可以处理该列表中多播mac地址的数据包。
![](https://img-blog.csdnimg.cn/20200913025632652.png#pic_center)
```go
void dev_mc_add(struct device *dev, void *addr, int alen, int newonly)
{
	struct dev_mc_list *dmi;
	// device维护的多播mac地址列表
	for(dmi=dev->mc_list;dmi!=NULL;dmi=dmi->next)
	{
		// 已存在，则引用计数加一
		if(memcmp(dmi->dmi_addr,addr,dmi->dmi_addrlen)==0 && dmi->dmi_addrlen==alen)
		{
			if(!newonly)
				dmi->dmi_users++;
			return;
		}
	}
	// 不存在则新增一个项到device列表中
	dmi=(struct dev_mc_list *)kmalloc(sizeof(*dmi),GFP_KERNEL);
	memcpy(dmi->dmi_addr, addr, alen);
	dmi->dmi_addrlen=alen;
	dmi->next=dev->mc_list;
	dmi->dmi_users=1;
	dev->mc_list=dmi;
	dev->mc_count++;
	// 通知网卡需要处理该多播mac地址
	dev_mc_upload(dev);
}
```
网卡的工作模式有几种，分别是正常模式（只接收发给自己的数据包）、混杂模式（接收所有数据包）、多播模式（接收一般数据包和多播数据包）。网卡默认是只处理发给自己的数据包，所以当我们加入一个多播组的时候，我们需要告诉网卡，当收到该多播组的数据包时，需要处理，而不是忽略。dev_mc_upload函数就是通知网卡。

```go
void dev_mc_upload(struct device *dev)
{
	struct dev_mc_list *dmi;
	char *data, *tmp;
	// 不工作了
	if(!(dev->flags&IFF_UP))
		return;
	// 当前是混杂模式，则不需要设置多播了，因为网卡会处理所有收到的数据，不管是不是发给自己的
	if(dev->flags&IFF_PROMISC)
	{
		dev->set_multicast_list(dev, -1, NULL);
		return;
	}
	// 多播地址个数，为0，则设置网卡工作模式为正常模式，因为不需要处理多播了
	if(dev->mc_count==0)
	{
		dev->set_multicast_list(dev,0,NULL);
		return;
	}
	
	data=kmalloc(dev->mc_count*dev->addr_len, GFP_KERNEL);
	// 复制所有的多播mac地址信息
	for(tmp = data, dmi=dev->mc_list;dmi!=NULL;dmi=dmi->next)
	{
		memcpy(tmp,dmi->dmi_addr, dmi->dmi_addrlen);
		tmp+=dev->addr_len;
	}
	// 告诉网卡
	dev->set_multicast_list(dev,dev->mc_count,data);
	kfree(data);
}
```
最后我们看一下set_multicast_list
```go
static void
set_multicast_list(struct device *dev, int num_addrs, void *addrs)
{
    int ioaddr = dev->base_addr;
	// 多播模式
    if (num_addrs > 0) {
	outb(RX_MULT, RX_CMD);
	inb(RX_STATUS);		/* Clear status. */
    } else if (num_addrs < 0) { // 混杂模式
	outb(RX_PROM, RX_CMD);
	inb(RX_STATUS);
    } else { // 正常模式
	outb(RX_NORM, RX_CMD);
	inb(RX_STATUS);
    }
}
```
set_multicast_list就是设置网卡工作模式的函数。至此，我们就成功加入了一个多播组。离开一个多播组也是类似的过程。

### 2.4.2 开启多播
udp的多播能力是需要用户主动开启的，原因是防止用户发送udp数据包的时候，误传了一个多播地址，但其实用户是想发送一个单播的数据包。我们可以通过setBroadcast开启多播能力。我们看libuv的代码。
```
int uv_udp_set_broadcast(uv_udp_t* handle, int on) {
  if (setsockopt(handle->io_watcher.fd,
                 SOL_SOCKET,
                 SO_BROADCAST,
                 &on,
                 sizeof(on))) {
    return UV__ERR(errno);
  }

  return 0;
}
```
再看看操作系统的实现。
```
int sock_setsockopt(struct sock *sk, int level, int optname,
		char *optval, int optlen){
	...
	case SO_BROADCAST:
		sk->broadcast=val?1:0;
}
```
我们看到实现很简单，就是设置一个标记位。当我们发送消息的时候，如果目的地址是多播地址，但是又没有设置这个标记，则会报错。
```
if(!sk->broadcast && ip_chk_addr(sin.sin_addr.s_addr)==IS_BROADCAST)
	  return -EACCES;	
```
上面代码来自调用udp的发送函数（例如sendto）时，进行的校验，如果发送的目的ip是多播地址，但是没有设置多播标记，则报错。
### 2.4.3 其他功能<br />
udp模块还提供了其他一些功能<br />
1 获取本端地址address<br />
如果用户没有显示调用bind绑定自己设置的ip和端口，那么操作系统就会随机选择。通过address函数就可以获取操作系统选择的源ip和端口。<br />
2 获取对端的地址<br />
通过remoteAddress函数可以获取对端地址。该地址由用户调用connect或sendto函数时设置。<br />
3 获取/设置缓冲区大小get/setRecvBufferSize，get/setSendBufferSize<br />
4 setMulticastLoopback<br />
发送多播数据包的时候，如果多播ip在出口设备的多播列表中，则给回环设备也发一份。<br />
5 setMulticastInterface<br />
设置多播数据的出口设备<br />
6 加入或退出多播组addMembership/dropMembership <br />
7 addSourceSpecificMembership/dropSourceSpecificMembership<br />
这两个函数是设置本端只接收特性源（主机）的多播数据包。<br />
8 setTTL<br />
单播ttl（单播的时候，ip协议头中的ttl字段）。<br />
9 setMulticastTTL<br />
多播ttl（多播的时候，ip协议的ttl字段）。<br />
10 ref/unref<br />
这两个函数设置如果nodejs主进程中只有udp对应的handle时，是否允许nodejs退出。nodejs事件循环的退出的条件之一是是否还有ref状态的handle。
这些都是对操作系统api的封装，就不一一分析。

# 3 具体例子
局域网中有两个局域网ip，分别是192.168.8.164和192.168.8.226
## 单播
### 服务器端
```
const dgram = require('dgram');
const udp = dgram.createSocket('udp4');
udp.bind(1234);
udp.on('message', (msg, remoteInfo) => {
    console.log(`receive msg: ${msg} from ${remoteInfo.address}:${remoteInfo.port}`);
});
```
### 客户端
```
const dgram = require('dgram');
const udp = dgram.createSocket('udp4');
udp.bind(1234);
udp.send('test', 1234, '192.168.8.226'); 
```
我们会看到服务端会显示receive msg test from 192.168.8.164:1234。
## 多播
### 服务器
```
const dgram = require('dgram');
const udp = dgram.createSocket('udp4');

udp.bind(1234, () => {
    // 局域网多播地址（224.0.0.0~224.0.0.255，该范围的多播数据包，路由器不会转发）
    udp.addMembership('224.0.0.114');
});

udp.on('message', (msg, rinfo) => {
    console.log(`receive msg: ${msg} from ${rinfo.address}:${rinfo.port}`);
});
```
服务器绑定1234端口后，加入多播组224.0.0.114，然后等待多播数据的到来。
### 客户端
```
const dgram = require('dgram');
const udp = dgram.createSocket('udp4');
udp.bind(1234, () => {
    udp.addMembership('224.0.0.114');
});
udp.send('test', 1234, '224.0.0.114', (err) => {}); 
```
客户端绑定1234端口后，也加入了多播组224.0.0.114，然后发送数据，但是发现服务端没有收到数据，客户端打印了receive msg test from 169.254.167.41:1234。这怎么多了一个ip出来？原来我主机有两个局域网地址。当我们加入多播组的时候，不仅可以设置加入哪个多播组，还能设置出口的设备和ip。当我们调用udp.addMembership('224.0.0.114')的时候，我们只是设置了我们加入的多播组，没有设置出口。这时候操作系统会为我们选择一个。根据输出，我们发现操作系统选择的是169.254.167.41（子网掩码是255.255.0.0）。因为这个ip和192开头的那个不是同一子网，但是我们加入的是局域网的多播ip，所有服务端无法收到客户端发出的数据包。下面是nodejs文档的解释。
```
Tells the kernel to join a multicast group at the given multicastAddress and multicastInterface using the IP_ADD_MEMBERSHIP socket option. If the multicastInterface argument is not specified, the operating system will choose one interface and will add membership to it. To add membership to every available interface, call addMembership multiple times, once per interface.
```
我们看一下操作系统的相关逻辑。
```
if(MULTICAST(daddr) && *dev==NULL && skb->sk && *skb->sk->ip_mc_name)
		*dev=dev_get(skb->sk->ip_mc_name);
```
上面的代码来自操作系统发送ip数据包时的逻辑，如果目的ip似乎多播地址并且ip_mc_name非空（即我们通过addMembership第二个参数设置的值），则出口设备就是我们设置的值。否则操作系统自己选。所以我们需要显示指定这个出口，把代码改成udp.addMembership('224.0.0.114', '192.168.8.164');重新执行发现客户端和服务器都显示了receive msg test from 192.168.8.164:1234。为什么客户端自己也会收到呢？原来操作系统发送多播数据的时候，也会给自己发送一份。我们看看相关逻辑
```
// 目的地是多播地址，并且不是回环设备 
if (MULTICAST(iph->daddr) && !(dev->flags&IFF_LOOPBACK))
{
	// 是否需要给自己一份，默认为true
	if(sk==NULL || sk->ip_mc_loop)
	{	
		// 给所有多播组的所有主机的数据包，则直接给自己一份
		if(iph->daddr==IGMP_ALL_HOSTS)
			ip_loopback(dev,skb);
		else
		{	
			// 判断目的ip是否在当前设备的多播ip列表中，是的回传一份
			struct ip_mc_list *imc=dev->ip_mc_list;
			while(imc!=NULL)
			{
				if(imc->multiaddr==iph->daddr)
				{
					ip_loopback(dev,skb);
					break;
				}
				imc=imc->next;
			}
		}
	}
}
```
以上代码来自ip层发送数据包时的逻辑。如果我们设置了sk->ip_mc_loop字段为1，并且数据包的目的ip在出口设备的多播列表中，则需要给自己回传一份。那么我们如何关闭这个特性呢？调用udp.setMulticastLoopback(false)就可以了。<br />
更多参考<br/>
1 [通过源码理解IGMP v1的实现（基于linux1.2.13）](https://mp.weixin.qq.com/s?__biz=MzUyNDE2OTAwNw==&mid=2247485002&idx=1&sn=9ee8601567844376326c40edff61edb0&chksm=fa303c0acd47b51cadb4d5a50e967b20d5824792605cdee3181fad721c767c8c15f011ee8ad1&token=1727487227&lang=zh_CN#rd)<br />
2 [UDP协议源码解析之接收](https://blog.csdn.net/THEANARKH/article/details/87489084)<br/>
3 [UDP协议源码解析之发送](https://blog.csdn.net/theanarkh/article/details/87488106)
