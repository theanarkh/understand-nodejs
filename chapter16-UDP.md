本章介绍Node.js中的UDP模块，UDP是传输层非面向连接的不可靠协议，使用UDP时,不需要建立连接就可以往对端直接发送数据，减少了三次握手带来的时延，但是UDP的不可靠可能会导致数据丢失，所以比较适合要求时延低，少量丢包不影响整体功能的场景，另外UDP支持多播、端口复用，可以实现一次给多个主机的多个进程发送数据。下面我们开始分析一下UDP的相关内容。
## 16.1 在C语言中使用UDP
我们首先看一下在C语言中如何使用UDP功能，这是Node.js的底层基础。
### 16.1.1 服务器流程（伪代码）

```
1.	// 申请一个socket    
2.	int fd = socket(...);    
3.	// 绑定一个众所周知的地址，像TCP一样    
4.	bind(fd, ip， port);    
5.	// 直接阻塞等待消息的到来，UDP不需要listen    
6.	recvmsg()；  
```

### 16.1.2 客户端流程
客户端的流程有多种方式，原因在于源IP、端口和目的IP、端口可以有多种设置方式。不像服务器一样，服务器端口是需要对外公布的，否则客户端就无法找到目的地进行通信。这就意味着服务器的端口是需要用户显式指定的，而客户端则不然，客户端的IP和端口，用户可以自己指定，也可以由操作系统决定，下面我们看看各种使用方式。
#### 16.1.2.1 显式指定源IP和端口

```
1.	// 申请一个socket  
2.	int fd = socket(...);  
3.	// 绑定一个客户端的地址  
4.	bind(fd, ip， port);  
5.	// 给服务器发送数据  
6.	sendto(fd, 服务器ip,服务器端口, data);  
```

因为UDP不是面向连接的，所以使用UDP时，不需要调用connect建立连接，只要我们知道服务器的地址，直接给服务器发送数据即可。而面向连接的TCP，首先需要通过connect发起三次握手建立连接，建立连接的本质是在客户端和服务器记录对端的信息，这是后面通信的通行证。
#### 16.1.2.2 由操作系统决定源ip和端口

```
1.	// 申请一个socket  
2.	int fd = socket(...);  
3.	// 给服务器发送数据  
4.	sendto(fd, 服务器ip,服务器端口, data)  
```

我们看到这里没有绑定客户端的源ip和端口，而是直接就给服务器发送数据。如果用户不指定ip和端口，则操作系统会提供默认的源ip和端口。对于ip，如果是多宿主主机，每次调用sendto的时候，操作系统会动态选择源ip。对于端口，操作系统会在第一次调用sendto的时候随机选择一个端口，并且不能修改。另外还有一种使用方式。

```
1.	// 申请一个socket  
2.	int fd = socket(...);  
3.	connect(fd, 服务器ip，服务器端口);  
4.	/*
5.	  给服务器发送数据,或者sendto(fd, null,null, data)，
6.	  调用sendto则不需要再指定服务器ip和端口  
7.	*/
8.	write(fd, data);  
```

我们可以先调用connect绑定服务器ip和端口到fd，然后直接调用write发送数据。 虽然使用方式很多，但是归根到底还是对四元组设置的管理。bind是绑定源ip端口到fd，connect是绑定服务器ip端口到fd。对于源ip和端口，我们可以主动设置，也可以让操作系统随机选择。对于目的ip和端口，我们可以在发送数据前设置，也可以在发送数据时设置。这就形成了多种使用方式。
### 16.1.3 发送数据
我们刚才看到使用UDP之前都需要调用socket函数申请一个socket，虽然调用socket函数返回的是一个fd，但是在操作系统中，的确是新建了一个socket结构体，fd只是一个索引，操作这个fd的时候，操作系统会根据这个fd找到对应的socket。socket是一个非常复杂的结构体，我们可以理解为一个对象。这个对象中有两个属性，一个是读缓冲区大小，一个是写缓冲区大小。当我们发送数据的时候，虽然理论上可以发送任意大小的数据，但是因为受限于发送缓冲区的大小，如果需要发送的数据比当前缓冲区大小大则会导致一些问题，我们分情况分析一下。   
1 发送的数据大小比当前缓冲区大，如果设置了非阻塞模式，则返回EAGAIN，如果是阻塞模式，则会引起进程的阻塞。   
2 如果发送的数据大小比缓冲区的最大值还大，则会导致报错EMSGSIZE，这时候我们需要分包发送。我们可能会想到修改缓冲区最大值的大小，但是这个大小也是有限制的。 讲完一些边界情况，我们再来看看正常的流程，我们看看发送一个数据包的流程   
1 首先在socket的写缓冲区申请一块内存用于数据发送。   
2 调用IP层发送接口，如果数据包大小超过了IP层的限制，则需要分包。  
3 继续调用底层的接口把数据发到网络上。  
因为UDP不是可靠的，所以不需要缓存这个数据包（TCP协议则需要缓存这个数据包，用于超时重传）。 这就是UDP发送数据的流程。
### 16.1.4 接收数据
当收到一个UDP数据包的时候，操作系统首先会把这个数据包缓存到socket的缓冲区，如果收到的数据包比当前缓冲区大小大，则丢弃数据包，否则把数据包挂载到接收队列，等用户来读取的时候，就逐个摘下接收队列的节点。UDP和TCP不一样，虽然它们都有一个缓存了消息的队列，但是当用户读取数据时，UDP每次只会返回一个UDP数据包，而TCP是会根据用户设置的大小返回一个或多个包里的数据。因为TCP是面向字节流的，而UDP是面向数据包的。
## 16.2 UDP模块在Node.js中的实现
了解了UDP的一些基础和使用后，我们开始分析在Node.js中是如何使用UDP的，Node.js又是如何实现UDP模块的。
### 16.2.1 服务器
我们从一个使用例子开始看看UDP模块的使用。

```
1.	const dgram = require('dgram');  
2.	// 创建一个UDP服务器  
3.	const server = dgram.createSocket('udp4');  
4.	// 监听UDP数据的到来  
5.	server.on('message', (msg, rinfo) => {  
6.	  // 处理数据  
7.	});  
8.	// 绑定端口  
9.	server.bind(41234);  
```

我们看到创建一个UDP服务器很简单，首先申请一个socket对象，在Node.js中和操作系统中一样，socket是对网络通信的一个抽象，我们可以把它理解成对传输层的抽象，它可以代表TCP也可以代表UDP。我们看一下createSocket做了什么。

```
1.	function createSocket(type, listener) {  
2.	  return new Socket(type, listener);  
3.	}  
4.	function Socket(type, listener) {  
5.	  EventEmitter.call(this);  
6.	  let lookup;  
7.	  let recvBufferSize;  
8.	  let sendBufferSize;  
9.	  
10.	  let options;  
11.	  if (type !== null && typeof type === 'object') {  
12.	    options = type;  
13.	    type = options.type;  
14.	    lookup = options.lookup;  
15.	    recvBufferSize = options.recvBufferSize;  
16.	    sendBufferSize = options.sendBufferSize;  
17.	  }  
18.	  const handle = newHandle(type, lookup);   
19.	  this.type = type;  
20.	  if (typeof listener === 'function')  
21.	    this.on('message', listener);  
22.	  // 保存上下文
23.	  this[kStateSymbol] = {  
24.	    handle,  
25.	    receiving: false,  
26.	    // 还没有执行bind
27.	    bindState: BIND_STATE_UNBOUND,  
28.	    connectState: CONNECT_STATE_DISCONNECTED,  
29.	    queue: undefined,  
30.	    // 端口复用，只使于多播   
31.	    reuseAddr: options && options.reuseAddr, 
32.	    ipv6Only: options && options.ipv6Only,  
33.	    // 发送缓冲区和接收缓冲区大小
34.	    recvBufferSize,  
35.	    sendBufferSize  
36.	  };  
37.	}  
```

我们看到一个socket对象是对handle的一个封装。我们看看handle是什么。

```
1.	function newHandle(type, lookup) {  
2.	  // 用于dns解析的函数，比如我们调send的时候，传的是一个域名  
3.	  if (lookup === undefined) {  
4.	    if (dns === undefined) {  
5.	      dns = require('dns');  
6.	    }  
7.	    lookup = dns.lookup;  
8.	  }   
9.	  
10.	  if (type === 'udp4') {  
11.	    const handle = new UDP();  
12.	    handle.lookup = lookup4.bind(handle, lookup);  
13.	    return handle;  
14.	  }  
15.	  // 忽略ipv6的处理  
16.	}  
```

handle又是对UDP模块的封装，UDP是C++模块，在之前章节中我们讲过相关的知识，这里就不详细讲述了，当我们在JS层new UDP的时候，会新建一个C++对象。

```
1.	UDPWrap::UDPWrap(Environment* env, Local<Object> object)  
2.	    : HandleWrap(env,  
3.	                 object,  
4.	                 reinterpret_cast<uv_handle_t*>(&handle_),  
5.	                 AsyncWrap::PROVIDER_UDPWRAP) {  
6.	  int r = uv_udp_init(env->event_loop(), &handle_);  
7.	}  
```

执行了uv_udp_init初始化udp对应的handle（uv_udp_t）。我们看一下Libuv的定义。

```
1.	int uv_udp_init_ex(uv_loop_t* loop, uv_udp_t* handle, unsigned int flags) {  
2.	  int domain;  
3.	  int err;  
4.	  int fd;  
5.	  
6.	  /* Use the lower 8 bits for the domain */  
7.	  domain = flags & 0xFF;  
8.	  // 申请一个socket，返回一个fd  
9.	  fd = uv__socket(domain, SOCK_DGRAM, 0);  
10.	  uv__handle_init(loop, (uv_handle_t*)handle, UV_UDP);  
11.	  handle->alloc_cb = NULL;  
12.	  handle->recv_cb = NULL;  
13.	  handle->send_queue_size = 0;  
14.	  handle->send_queue_count = 0;  
15.	  /*
16.	   初始化IO观察者（还没有注册到事件循环的Poll IO阶段），
17.	   监听的文件描述符是fd，回调是uv__udp_io  
18.	  */
19.	  uv__io_init(&handle->io_watcher, uv__udp_io, fd);  
20.	  // 初始化写队列  
21.	  QUEUE_INIT(&handle->write_queue);  
22.	  QUEUE_INIT(&handle->write_completed_queue);  
23.	  return 0;  
24.	}  
```

就是我们在JS层执行dgram.createSocket('udp4')的时候，在Node.js中主要的执行过程。回到最开始的例子，我们看一下执行bind的时候的逻辑。

```
1.	Socket.prototype.bind = function(port_, address_ /* , callback */) {  
2.	  let port = port_;  
3.	  // socket的上下文  
4.	  const state = this[kStateSymbol];  
5.	  // 已经绑定过了则报错  
6.	  if (state.bindState !== BIND_STATE_UNBOUND)  
7.	    throw new ERR_SOCKET_ALREADY_BOUND();  
8.	  // 否则标记已经绑定了  
9.	  state.bindState = BIND_STATE_BINDING;  
10.	  // 没传地址则默认绑定所有地址  
11.	  if (!address) {  
12.	    if (this.type === 'udp4')  
13.	      address = '0.0.0.0';  
14.	    else  
15.	      address = '::';  
16.	  }  
17.	  // dns解析后在绑定，如果需要的话  
18.	  state.handle.lookup(address, (err, ip) => {  
19.	    if (err) {  
20.	      state.bindState = BIND_STATE_UNBOUND;  
21.	      this.emit('error', err);  
22.	      return;  
23.	    }  
24.	    const err = state.handle.bind(ip, port || 0, flags);  
25.	    if (err) {  
26.	       const ex = exceptionWithHostPort(err, 'bind', ip, port);
27.	       state.bindState = BIND_STATE_UNBOUND;  
28.	       this.emit('error', ex);  
29.	       // Todo: close?  
30.	       return;  
31.	     }  
32.	  
33.	     startListening(this);  
34.	  return this;  
35.	}  
```

bind函数主要的逻辑是handle.bind和startListening。我们一个个看。我们看一下C++层的bind。

```
1.	void UDPWrap::DoBind(const FunctionCallbackInfo<Value>& args, int family) {  
2.	  UDPWrap* wrap;  
3.	  ASSIGN_OR_RETURN_UNWRAP(&wrap,  
4.	                          args.Holder(),  
5.	                          args.GetReturnValue().Set(UV_EBADF));  
6.	  
7.	  // bind(ip, port, flags)  
8.	  CHECK_EQ(args.Length(), 3);  
9.	  node::Utf8Value address(args.GetIsolate(), args[0]);  
10.	  Local<Context> ctx = args.GetIsolate()->GetCurrentContext();  
11.	  uint32_t port, flags;  
12.	  struct sockaddr_storage addr_storage;  
13.	  int err = sockaddr_for_family(family, 
14.	                                   address.out(), 
15.	                                   port, 
16.	                                   &addr_storage);  
17.	  if (err == 0) {  
18.	    err = uv_udp_bind(&wrap->handle_,  
19.	                      reinterpret_cast<const sockaddr*>(&addr_storage),  
20.	                      flags);  
21.	  }  
22.	  
23.	  args.GetReturnValue().Set(err);  
24.	}  		
```

也没有太多逻辑，处理参数然后执行uv_udp_bind设置一些标记、属性和端口复用（端口复用后续会单独分析），然后执行操作系统bind的函数把本端的ip和端口保存到socket中。我们继续看startListening。

```
1.	function startListening(socket) {  
2.	  const state = socket[kStateSymbol];  
3.	  // 有数据时的回调，触发message事件  
4.	  state.handle.onmessage = onMessage;  
5.	  // 重点，开始监听数据  
6.	  state.handle.recvStart();  
7.	  state.receiving = true;  
8.	  state.bindState = BIND_STATE_BOUND;  
9.	   // 设置操作系统的接收和发送缓冲区大小
10.	  if (state.recvBufferSize)  
11.	    bufferSize(socket, state.recvBufferSize, RECV_BUFFER);  
12.	  
13.	  if (state.sendBufferSize)  
14.	    bufferSize(socket, state.sendBufferSize, SEND_BUFFER);  
15.	  
16.	  socket.emit('listening');  
17.	}  
```

重点是recvStart函数，我们看C++的实现。

```
1.	void UDPWrap::RecvStart(const FunctionCallbackInfo<Value>& args) {  
2.	  UDPWrap* wrap;  
3.	  ASSIGN_OR_RETURN_UNWRAP(&wrap,  
4.	                          args.Holder(),  
5.	                          args.GetReturnValue().Set(UV_EBADF));  
6.	  int err = uv_udp_recv_start(&wrap->handle_, OnAlloc, OnRecv);  
7.	  // UV_EALREADY means that the socket is already bound but that's okay  
8.	  if (err == UV_EALREADY)  
9.	    err = 0;  
10.	  args.GetReturnValue().Set(err);  
11.	}  
```

OnAlloc, OnRecv分别是分配内存接收数据的函数和数据到来时执行的回调。继续看Libuv

```
1.	int uv__udp_recv_start(uv_udp_t* handle,  
2.	                       uv_alloc_cb alloc_cb,  
3.	                       uv_udp_recv_cb recv_cb) {  
4.	  int err;  
5.	  
6.	  
7.	  err = uv__udp_maybe_deferred_bind(handle, AF_INET, 0);  
8.	  if (err)  
9.	    return err;  
10.	  // 保存一些上下文  
11.	  handle->alloc_cb = alloc_cb;  
12.	  handle->recv_cb = recv_cb;  
13.	  // 注册IO观察者到loop，如果事件到来，等到Poll IO阶段处理  
14.	  uv__io_start(handle->loop, &handle->io_watcher, POLLIN);  
15.	  uv__handle_start(handle);  
16.	  
17.	  return 0;  
18.	}  
```

uv__udp_recv_start主要是注册IO观察者到loop，等待事件到来的时候，到这，服务器就启动了。
### 16.2.2 客户端
接着我们看一下客户端的使用方式和流程

```
1.	const dgram = require('dgram');  
2.	const message = Buffer.from('Some bytes');  
3.	const client = dgram.createSocket('udp4');  
4.	client.connect(41234, 'localhost', (err) => {  
5.	  client.send(message, (err) => {  
6.	    client.close();  
7.	  });  
8.	});  
```

我们看到Node.js首先调用connect绑定服务器的地址，然后调用send发送信息，最后调用close。我们一个个分析。首先看connect。

```
1.	Socket.prototype.connect = function(port, address, callback) {  
2.	  port = validatePort(port);  
3.	  // 参数处理  
4.	  if (typeof address === 'function') {  
5.	    callback = address;  
6.	    address = '';  
7.	  } else if (address === undefined) {  
8.	    address = '';  
9.	  }  
10.	   
11.	  const state = this[kStateSymbol];  
12.	  // 不是初始化状态  
13.	  if (state.connectState !== CONNECT_STATE_DISCONNECTED)  
14.	    throw new ERR_SOCKET_DGRAM_IS_CONNECTED();  
15.	  // 设置socket状态  
16.	  state.connectState = CONNECT_STATE_CONNECTING;  
17.	  // 还没有绑定客户端地址信息，则先绑定随机地址（操作系统决定）  
18.	  if (state.bindState === BIND_STATE_UNBOUND)  
19.	    this.bind({ port: 0, exclusive: true }, null);  
20.	  // 执行bind的时候，state.bindState不是同步设置的  
21.	  if (state.bindState !== BIND_STATE_BOUND) {  
22.	    enqueue(this, _connect.bind(this, port, address, callback));
23.	    return;  
24.	  }  
25.	  
26.	  _connect.call(this, port, address, callback);  
27.	};  
```

这里分为两种情况，一种是在connect之前已经调用了bind，第二种是没有调用bind，如果没有调用bind，则在connect之前先要调用bind（因为bind中不仅仅绑定了ip端口，还有端口复用的处理）。这里只分析没有调用bind的情况，因为这是最长的路径。bind刚才我们分析过了，我们从以下代码继续分析

```
1.	if (state.bindState !== BIND_STATE_BOUND) {  
2.	    enqueue(this, _connect.bind(this, port, address, callback)); 
3.	    return;  
4.	  }  
```

enqueue把任务加入任务队列，并且监听了listening事件（该事件在bind成功后触发）。

```
1.	function enqueue(self, toEnqueue) {  
2.	  const state = self[kStateSymbol];  
3.	  if (state.queue === undefined) {  
4.	    state.queue = [];  
5.	    self.once('error', onListenError);  
6.	    self.once('listening', onListenSuccess);  
7.	  }  
8.	  state.queue.push(toEnqueue);  
9.	}  
```

这时候connect函数就执行完了，等待bind成功后（nextTick）会执行 startListening函数。

```
1.	function startListening(socket) {  
2.	  const state = socket[kStateSymbol];  
3.	  state.handle.onmessage = onMessage;  
4.	  // 注册等待可读事件  
5.	  state.handle.recvStart();  
6.	  state.receiving = true;  
7.	  // 标记已bind成功  
8.	  state.bindState = BIND_STATE_BOUND;  
9.	  // 设置读写缓冲区大小
10.	 if (state.recvBufferSize)  
11.	   bufferSize(socket, state.recvBufferSize, RECV_BUFFER);  
12.	  
13.	 if (state.sendBufferSize)  
14.	   bufferSize(socket, state.sendBufferSize, SEND_BUFFER);  
15.	 // 触发listening事件  
16.	 socket.emit('listening');  
17.	}  
```

我们看到startListening触发了listening事件，从而执行我们刚才入队的回调onListenSuccess。

```
1.	function onListenSuccess() {  
2.	  this.removeListener('error', onListenError);  
3.	  clearQueue.call(this);  
4.	}  
5.	  
6.	function clearQueue() {  
7.	  const state = this[kStateSymbol];  
8.	  const queue = state.queue;  
9.	  state.queue = undefined;  
10.	  
11.	  for (const queueEntry of queue)  
12.	    queueEntry();  
13.	}  
```

回调就是把队列中的回调执行一遍，connect函数设置的回调是_connect。

```
1.	function _connect(port, address, callback) {  
2.	  const state = this[kStateSymbol];  
3.	  if (callback)  
4.	    this.once('connect', callback);  
5.	  
6.	  const afterDns = (ex, ip) => {  
7.	    defaultTriggerAsyncIdScope(  
8.	      this[async_id_symbol],  
9.	      doConnect,  
10.	      ex, this, ip, address, port, callback  
11.	    );  
12.	  };  
13.	  
14.	  state.handle.lookup(address, afterDns);  
15.	}  
```

这里的address是服务器地址，_connect函数主要逻辑是
1 监听connect事件
2 对服务器地址进行dns解析（只能是本地的配的域名）。解析成功后执行afterDns，最后执行doConnect，并传入解析出来的ip。我们看看doConnect

```
1.	function doConnect(ex, self, ip, address, port, callback) {  
2.	  const state = self[kStateSymbol];  
3.	  // dns解析成功，执行底层的connect  
4.	  if (!ex) {  
5.	    const err = state.handle.connect(ip, port);  
6.	    if (err) {  
7.	      ex = exceptionWithHostPort(err, 'connect', address, port); 
8.	    }  
9.	  }  
10.	  
11.	  // connect成功，触发connect事件  
12.	  state.connectState = CONNECT_STATE_CONNECTED;  
13.	  process.nextTick(() => self.emit('connect'));  
14.	}  
```

connect函数通过C++层，然后调用Libuv，到操作系统的connect。作用是把服务器地址保存到socket中。connect的流程就走完了。接下来我们就可以调用send和recv发送和接收数据。
### 16.2.3 发送数据
发送数据接口是sendto，它是对send的封装。

```
1.	Socket.prototype.send = function(buffer,  
2.	                                 offset,  
3.	                                 length,  
4.	                                 port,  
5.	                                 address,  
6.	                                 callback) {  
7.	  
8.	  let list;  
9.	  const state = this[kStateSymbol];  
10.	  const connected = state.connectState === CONNECT_STATE_CONNECTED;  
11.	  // 没有调用connect绑定过服务端地址，则需要传服务端地址信息  
12.	  if (!connected) {  
13.	    if (address || (port && typeof port !== 'function')) {  
14.	      buffer = sliceBuffer(buffer, offset, length);  
15.	    } else {  
16.	      callback = port;  
17.	      port = offset;  
18.	      address = length;  
19.	    }  
20.	  } else {  
21.	    if (typeof length === 'number') {  
22.	      buffer = sliceBuffer(buffer, offset, length);  
23.	      if (typeof port === 'function') {  
24.	        callback = port;  
25.	        port = null;  
26.	      }  
27.	    } else {  
28.	      callback = offset;  
29.	    }  
30.	    // 已经绑定了服务端地址，则不能再传了  
31.	    if (port || address)  
32.	      throw new ERR_SOCKET_DGRAM_IS_CONNECTED();  
33.	  }  
34.	  // 如果没有绑定服务器端口，则这里需要传，并且校验  
35.	  if (!connected)  
36.	    port = validatePort(port);  
37.	  // 忽略一些参数处理逻辑  
38.	  // 没有绑定客户端地址信息，则需要先绑定，值由操作系统决定  
39.	  if (state.bindState === BIND_STATE_UNBOUND)  
40.	    this.bind({ port: 0, exclusive: true }, null);  
41.	  // bind还没有完成，则先入队，等待bind完成再执行  
42.	  if (state.bindState !== BIND_STATE_BOUND) {  
43.	    enqueue(this, this.send.bind(this, 
44.	                                    list, 
45.	                                    port, 
46.	                                    address, 
47.	                                    callback));  
48.	    return;  
49.	  }  
50.	  // 已经绑定了，设置服务端地址后发送数据  
51.	  const afterDns = (ex, ip) => {  
52.	    defaultTriggerAsyncIdScope(  
53.	      this[async_id_symbol],  
54.	      doSend,  
55.	      ex, this, ip, list, address, port, callback  
56.	    );  
57.	  };  
58.	  // 传了地址则可能需要dns解析  
59.	  if (!connected) {  
60.	    state.handle.lookup(address, afterDns);  
61.	  } else {  
62.	    afterDns(null, null);  
63.	  }  
64.	}  
```

我们继续看doSend函数。

```
1.	function doSend(ex, self, ip, list, address, port, callback) {  
2.	  const state = self[kStateSymbol];  
3.	  // dns解析出错  
4.	  if (ex) {  
5.	    if (typeof callback === 'function') {  
6.	      process.nextTick(callback, ex);  
7.	      return;  
8.	    }  
9.	    process.nextTick(() => self.emit('error', ex));  
10.	    return;  
11.	  }  
12.	  // 定义一个请求对象  
13.	  const req = new SendWrap();  
14.	  req.list = list;  // Keep reference alive.  
15.	  req.address = address;  
16.	  req.port = port;  
17.	  /*
18.	    设置Node.js和用户的回调，oncomplete由C++层调用，
19.	    callback由oncomplete调用 
20.	  */ 
21.	  if (callback) {  
22.	    req.callback = callback;  
23.	    req.oncomplete = afterSend;  
24.	  }  
25.	  
26.	  let err;  
27.	  // 根据是否需要设置服务端地址，调C++层函数  
28.	  if (port)  
29.	    err = state.handle.send(req, list, list.length, port, ip, !!callback);  
30.	  else  
31.	    err = state.handle.send(req, list, list.length, !!callback);  
32.	  /*
33.	    err大于等于1说明同步发送成功了，直接执行回调，
34.	    否则等待异步回调 
35.	  */ 
36.	  if (err >= 1) {  
37.	    if (callback)  
38.	      process.nextTick(callback, null, err - 1);  
39.	    return;  
40.	  }  
41.	  // 发送失败  
42.	  if (err && callback) {   
43.	    const ex=exceptionWithHostPort(err, 'send', address, port); 
44.	    process.nextTick(callback, ex);  
45.	  }  
46.	}  
```

我们穿过C++层，直接看Libuv的代码。

```
1.	int uv__udp_send(uv_udp_send_t* req,  
2.	                 uv_udp_t* handle,  
3.	                 const uv_buf_t bufs[],  
4.	                 unsigned int nbufs,  
5.	                 const struct sockaddr* addr,  
6.	                 unsigned int addrlen,  
7.	                 uv_udp_send_cb send_cb) {  
8.	  int err;  
9.	  int empty_queue;  
10.	  
11.	  assert(nbufs > 0);  
12.	  // 还没有绑定服务端地址，则绑定  
13.	  if (addr) {  
14.	    err = uv__udp_maybe_deferred_bind(handle, 
15.	                                          addr->sa_family, 
16.	                                          0);  
17.	    if (err)  
18.	      return err;  
19.	  }  
20.	  // 当前写队列是否为空  
21.	  empty_queue = (handle->send_queue_count == 0);  
22.	  // 初始化一个写请求  
23.	  uv__req_init(handle->loop, req, UV_UDP_SEND);  
24.	  if (addr == NULL)  
25.	    req->addr.ss_family = AF_UNSPEC;  
26.	  else  
27.	    memcpy(&req->addr, addr, addrlen);  
28.	  // 保存上下文  
29.	  req->send_cb = send_cb;  
30.	  req->handle = handle;  
31.	  req->nbufs = nbufs;  
32.	  // 初始化数据，预分配的内存不够，则分配新的堆内存  
33.	  req->bufs = req->bufsml;  
34.	  if (nbufs > ARRAY_SIZE(req->bufsml))  
35.	    req->bufs = uv__malloc(nbufs * sizeof(bufs[0]));  
36.	  // 复制过去堆中  
37.	  memcpy(req->bufs, bufs, nbufs * sizeof(bufs[0]));  
38.	  // 更新写队列数据  
39.	  handle->send_queue_size += uv__count_bufs(req->bufs, 
40.	                                                req->nbufs);  
41.	  handle->send_queue_count++;  
42.	  // 插入写队列，等待可写事件的发生  
43.	  QUEUE_INSERT_TAIL(&handle->write_queue, &req->queue);  
44.	  uv__handle_start(handle);  
45.	  // 当前写队列为空，则直接开始写，否则设置等待可写队列  
46.	  if (empty_queue && 
47.	      !(handle->flags & UV_HANDLE_UDP_PROCESSING)) {  
48.	    // 发送数据  
49.	    uv__udp_sendmsg(handle);  
50.	    // 写队列是否非空，则设置等待可写事件，可写的时候接着写  
51.	    if (!QUEUE_EMPTY(&handle->write_queue))  
52.	      uv__io_start(handle->loop, &handle->io_watcher, POLLOUT);
53.	  } else {  
54.	    uv__io_start(handle->loop, &handle->io_watcher, POLLOUT);  
55.	  }  
56.	  return 0;  
57.	}  
```

该函数首先记录写请求的上下文，然后把写请求插入写队列中，当待写队列为空，则直接执行uv__udp_sendmsg进行写操作，否则等待可写事件的到来，当可写事件触发的时候，执行的函数是uv__udp_io。

```
1.	static void uv__udp_io(uv_loop_t* loop, uv__io_t* w, unsigned int revents) {  
2.	  uv_udp_t* handle;  
3.	  if (revents & POLLOUT) {  
4.	    uv__udp_sendmsg(handle);  
5.	    uv__udp_run_completed(handle);  
6.	  }  
7.	}  
```

我们先看uv__udp_sendmsg

```
1.	static void uv__udp_sendmsg(uv_udp_t* handle) {  
2.	  uv_udp_send_t* req;  
3.	  QUEUE* q;  
4.	  struct msghdr h;  
5.	  ssize_t size;  
6.	  // 逐个节点发送  
7.	  while (!QUEUE_EMPTY(&handle->write_queue)) {  
8.	    q = QUEUE_HEAD(&handle->write_queue);  
9.	    req = QUEUE_DATA(q, uv_udp_send_t, queue);  
10.	    memset(&h, 0, sizeof h);  
11.	    // 忽略参数处理  
12.	    h.msg_iov = (struct iovec*) req->bufs;  
13.	    h.msg_iovlen = req->nbufs;  
14.	  
15.	    do {  
16.	      size = sendmsg(handle->io_watcher.fd, &h, 0);  
17.	    } while (size == -1 && errno == EINTR);  
18.	  
19.	    if (size == -1) {  
20.	      // 繁忙则先不发了，等到可写事件  
21.	      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOBUFS)  
22.	        break;  
23.	    }  
24.	    // 记录发送结果  
25.	    req->status = (size == -1 ? UV__ERR(errno) : size);  
26.	    // 发送“完”移出写队列  
27.	    QUEUE_REMOVE(&req->queue);  
28.	    // 加入写完成队列  
29.	    QUEUE_INSERT_TAIL(&handle->write_completed_queue, &req->queue);  
30.	    /*
31.	      有节点数据写完了，把IO观察者插入pending队列，
32.	      pending阶段执行回调uv__udp_io  
33.	    */
34.	    uv__io_feed(handle->loop, &handle->io_watcher);  
35.	  }  
36.	}  
```

该函数遍历写队列，然后逐个发送节点中的数据，并记录发送结果。   
1 如果写繁忙则结束写逻辑，等待下一次写事件触发。  
2 如果写成功则把节点插入写完成队列中，并且把IO观察者插入pending队列。  
等待pending阶段执行回调时，执行的函数是uv__udp_io。 我们再次回到uv__udp_io中

```
1.	if (revents & POLLOUT) {  
2.	    uv__udp_sendmsg(handle);  
3.	    uv__udp_run_completed(handle);  
4.	}  
```

我们看到这时候会继续执行数据发送的逻辑，然后处理写完成队列。我们看uv__udp_run_completed。

```
1.	static void uv__udp_run_completed(uv_udp_t* handle) {  
2.	  uv_udp_send_t* req;  
3.	  QUEUE* q;  
4.	  handle->flags |= UV_HANDLE_UDP_PROCESSING;  
5.	  // 逐个节点处理  
6.	  while (!QUEUE_EMPTY(&handle->write_completed_queue)) {  
7.	    q = QUEUE_HEAD(&handle->write_completed_queue);  
8.	    QUEUE_REMOVE(q);  
9.	    req = QUEUE_DATA(q, uv_udp_send_t, queue);  
10.	    uv__req_unregister(handle->loop, req);  
11.	    // 更新待写数据大小  
12.	    handle->send_queue_size -= uv__count_bufs(req->bufs, req->nbufs);  
13.	    handle->send_queue_count--;  
14.	    // 如果重新申请了堆内存，则需要释放  
15.	    if (req->bufs != req->bufsml)  
16.	      uv__free(req->bufs);  
17.	    req->bufs = NULL;  
18.	    if (req->send_cb == NULL)  
19.	      continue;  
20.	    // 执行回调  
21.	    if (req->status >= 0)  
22.	      req->send_cb(req, 0);  
23.	    else  
24.	      req->send_cb(req, req->status);  
25.	  }  
26.	  // 写队列为空，则注销等待可写事件  
27.	  if (QUEUE_EMPTY(&handle->write_queue)) {  
28.	    uv__io_stop(handle->loop, &handle->io_watcher, POLLOUT);  
29.	    if (!uv__io_active(&handle->io_watcher, POLLIN))  
30.	      uv__handle_stop(handle);  
31.	  }  
32.	  handle->flags &= ~UV_HANDLE_UDP_PROCESSING;  
33.	}  
```

这就是发送的逻辑，发送完后Libuv会调用C++回调，最后回调JS层回调。具体到操作系统也是类似的实现，操作系统首先判断数据的大小是否小于写缓冲区，是的话申请一块内存，然后构造UDP协议数据包，再逐层往下调，最后发送出来，但是如果数据超过了底层的报文大小限制，则会被分片。
### 16.2.4 接收数据
UDP服务器启动的时候，就注册了等待可读事件的发送，如果收到了数据，则在Poll IO阶段就会被处理。前面我们讲过，回调函数是uv__udp_io。我们看一下事件触发的时候，该函数怎么处理的。

```
1.	static void uv__udp_io(uv_loop_t* loop, uv__io_t* w, unsigned int revents) {  
2.	  uv_udp_t* handle;  
3.	  
4.	  handle = container_of(w, uv_udp_t, io_watcher);  
5.	  // 可读事件触发  
6.	  if (revents & POLLIN)  
7.	    uv__udp_recvmsg(handle);  
8.	}  
```

我们看uv__udp_recvmsg的逻辑。

```
1.	static void uv__udp_recvmsg(uv_udp_t* handle) {  
2.	  struct sockaddr_storage peer;  
3.	  struct msghdr h;  
4.	  ssize_t nread;  
5.	  uv_buf_t buf;  
6.	  int flags;  
7.	  int count;  
8.	  
9.	  count = 32;  
10.	  
11.	  do {  
12.	    // 分配内存接收数据，C++层设置的  
13.	    buf = uv_buf_init(NULL, 0);  
14.	    handle->alloc_cb((uv_handle_t*) handle, 64 * 1024, &buf);  
15.	    memset(&h, 0, sizeof(h));  
16.	    memset(&peer, 0, sizeof(peer));  
17.	    h.msg_name = &peer;  
18.	    h.msg_namelen = sizeof(peer);  
19.	    h.msg_iov = (void*) &buf;  
20.	    h.msg_iovlen = 1;  
21.	    // 调操作系统的函数读取数据  
22.	    do {  
23.	      nread = recvmsg(handle->io_watcher.fd, &h, 0);  
24.	    }  
25.	    while (nread == -1 && errno == EINTR);  
26.	    // 调用C++层回调  
27.	    handle->recv_cb(handle, 
28.	                      nread, 
29.	                      &buf, 
30.	                      (const struct sockaddr*) &peer, 
31.	                      flags);  
32.	  }  
33.	}  
```

最终通过操作系统调用recvmsg读取数据，操作系统收到一个udp数据包的时候，会挂载到socket的接收队列，如果接收队列满了则会丢弃，当用户调用recvmsg函数的时候，操作系统就把接收队列中节点逐个返回给用户。读取完后，Libuv会回调C++层，然后C++层回调到JS层，最后触发message事件，这就是对应开始那段代码的message事件。
### 16.2.5 多播
我们知道，TCP是基于连接和可靠的，多播则会带来过多的连接和流量，所以TCP是不支持多播的，而UDP则支持多播。多播分为局域网多播和广域网多播，我们知道在局域网内发生一个数据，是会以广播的形式发送到各个主机的，主机根据目的地址判断是否需要处理该数据包。如果UDP是单播的模式，则只会有一个主机会处理该数据包。如果UDP是多播的模式，则有多个主机处理该数据包。多播的时候，存在一个多播组的概念，这就是IGMP做的事情。它定义了组的概念。只有加入这个组的主机才能处理该组的数据包。假设有以下局域网，如图16-1所示。  
![](https://img-blog.csdnimg.cn/741142f6e75c45139e4c2a2c3b695cc0.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图16-1  
当主机1给多播组1发送数据的时候，主机4可以收到，主机2，3则无法收到。
我们再来看看广域网的多播。广域网的多播需要路由器的支持，多个路由器之间会使用多播路由协议交换多播组的信息。假设有以下广域网，如图16-2所示。  
![](https://img-blog.csdnimg.cn/f766d3aa280a41aa8222cac9064d0303.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图16-2  
当主机1给多播组1发送数据的时候，路由器1会给路由器2发送一份数据（通过多播路由协议交换了信息，路由1知道路由器2的主机7在多播组1中），但是路由器2不会给路由器3发送数据，因为它知道路由器3对应的网络中没有主机在多播组1。

以上是多播的一些概念。Node.js中关于多播的实现，基本是对操作系统API的封装，所以就不打算讲解，我们直接看操作系统中对于多播的实现。
#### 16.2.5.1 加入一个多播组
可以通过以下接口加入一个多播组。

```
1.	setsockopt(fd,  
2.	           IPPROTO_IP,  
3.	           IP_ADD_MEMBERSHIP,  
4.	           &mreq, // 记录出口ip和加入多播组的ip  
5.	           sizeof(mreq));  
```

mreq的结构体定义如下

```
1.	struct ip_mreq   
2.	{  
3.	    // 加入的多播组ip  
4.	    struct in_addr imr_multiaddr; 
5.	    // 出口ip  
6.	    struct in_addr imr_interface;   
7.	};  
```

我们看一下setsockopt的实现（只列出相关部分代码）

```
1.	case IP_ADD_MEMBERSHIP:   
2.	        {  
3.	            struct ip_mreq mreq;  
4.	            static struct options optmem;  
5.	            unsigned long route_src;  
6.	            struct rtable *rt;  
7.	            struct device *dev=NULL;  
8.	            err=verify_area(VERIFY_READ, optval, sizeof(mreq));  
9.	            memcpy_fromfs(&mreq,optval,sizeof(mreq));  
10.	            // 没有设置device则根据多播组ip选择一个device  
11.	            if(mreq.imr_interface.s_addr==INADDR_ANY)   
12.	            {  
13.	                if((rt=ip_rt_route(mreq.imr_multiaddr.s_addr,
14.	                                      &optmem, &route_src))!=NULL)  
15.	                {  
16.	                    dev=rt->rt_dev;  
17.	                    rt->rt_use--;  
18.	                }  
19.	            }  
20.	            else  
21.	            {  
22.	                // 根据设置的ip找到对应的device  
23.	                for(dev = dev_base; dev; dev = dev->next)  
24.	                {  
25.	                    // 在工作状态、支持多播，ip一样  
26.	                    if((dev->flags&IFF_UP)&&
27.	                          (dev->flags&IFF_MULTICAST)&&  
28.	                        (dev->pa_addr==mreq.imr_interface.s_addr
29.	                         ))  
30.	                        break;  
31.	                }  
32.	            }  
33.	            // 加入多播组  
34.	            return ip_mc_join_group(sk,
35.	                                       dev,
36.	                                       mreq.imr_multiaddr.s_addr);  
37.	        }  
38.	          
```

首先拿到加入的多播组IP和出口IP对应的device后，调用ip_mc_join_group，在socket结构体中，有一个字段维护了该socket加入的多播组信息，如图16-3所示。  
![](https://img-blog.csdnimg.cn/b468cd35ec9c4ea7a6852f684826d70c.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图16-3  
我们接着看一下ip_mc_join_group

```
1.	int ip_mc_join_group(struct sock *sk , 
2.	                       struct device *dev, 
3.	                       unsigned long addr)  
4.	{  
5.	    int unused= -1;  
6.	    int i;  
7.	    // 还没有加入过多播组则分配一个ip_mc_socklist结构体  
8.	    if(sk->ip_mc_list==NULL)  
9.	    {  
10.	        if((sk->ip_mc_list=(struct ip_mc_socklist *)kmalloc(sizeof(*sk->ip_mc_list), GFP_KERNEL))==NULL)  
11.	            return -ENOMEM;  
12.	        memset(sk->ip_mc_list,'\0',sizeof(*sk->ip_mc_list));  
13.	    }  
14.	    // 遍历加入的多播组队列，判断是否已经加入过  
15.	    for(i=0;i<IP_MAX_MEMBERSHIPS;i++)  
16.	    {  
17.	        if(sk->ip_mc_list->multiaddr[i]==addr && 
18.	            sk->ip_mc_list->multidev[i]==dev)  
19.	            return -EADDRINUSE;  
20.	        if(sk->ip_mc_list->multidev[i]==NULL) 
21.	             // 记录可用位置的索引 
22.	            unused=i;  
23.	    }  
24.	    // 到这说明没有加入过当前设置的多播组，则记录并且加入  
25.	    if(unused==-1)  
26.	        return -ENOBUFS;  
27.	    sk->ip_mc_list->multiaddr[unused]=addr;  
28.	    sk->ip_mc_list->multidev[unused]=dev;  
29.	    // addr为多播组ip  
30.	    ip_mc_inc_group(dev,addr);  
31.	    return 0;  
32.	}  
```

ip_mc_join_group函数的主要逻辑是把socket想加入的多播组信息记录到socket的ip_mc_list字段中（如果还没有加入过该多播组的话）。接着调ip_mc_inc_group往下走。device的ip_mc_list字段维护了主机中使用了该device的多播组信息，如图16-4所示。  
![](https://img-blog.csdnimg.cn/9022d2ade56b4fab8db1548a9db7ead9.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图16-4

```
1.	static void ip_mc_inc_group(struct device *dev,     
2.	                              unsigned long addr)  
3.	{  
4.	    struct ip_mc_list *i;  
5.	    /*
6.	      遍历该设备维护的多播组队列，
7.	      判断是否已经有socket加入过该多播组，是则引用数加一  
8.	    */
9.	    for(i=dev->ip_mc_list;i!=NULL;i=i->next)  
10.	    {  
11.	        if(i->multiaddr==addr)  
12.	        {  
13.	            i->users++;  
14.	            return;  
15.	        }  
16.	    }  
17.	    // 到这说明，还没有socket加入过当前多播组，则记录并加入  
18.	    i=(struct ip_mc_list *)kmalloc(sizeof(*i), GFP_KERNEL);  
19.	    if(!i)  
20.	        return;  
21.	    i->users=1;  
22.	    i->interface=dev;  
23.	    i->multiaddr=addr;  
24.	    i->next=dev->ip_mc_list;  
25.	    // 通过igmp通知其它方  
26.	    igmp_group_added(i);  
27.	    dev->ip_mc_list=i;  
28.	}  
```

ip_mc_inc_group函数的主要逻辑是判断socket想要加入的多播组是不是已经存在于当前device中，如果不是则新增一个节点。继续调用igmp_group_added

```
1.	static void igmp_group_added(struct ip_mc_list *im)  
2.	{  
3.	    // 初始化定时器  
4.	    igmp_init_timer(im);  
5.	    /*
6.	      发送一个igmp数据包，同步多播组信息（socket加入
7.	      了一个新的多播组）  
8.	     */
9.	    igmp_send_report(im->interface, 
10.	                      im->multiaddr, 
11.	                      IGMP_HOST_MEMBERSHIP_REPORT);  
12.	    // 转换多播组ip到多播mac地址，并记录到device中  
13.	    ip_mc_filter_add(im->interface, im->multiaddr);  
14.	}  
```

我们看看igmp_send_report和ip_mc_filter_add的具体逻辑。

```
1.	static void igmp_send_report(struct device *dev, 
2.	                                unsigned long address, 
3.	                                int type)  
4.	{  
5.	    // 申请一个skb表示一个数据包  
6.	    struct sk_buff *skb=alloc_skb(MAX_IGMP_SIZE, GFP_ATOMIC);  
7.	    int tmp;  
8.	    struct igmphdr *igh;  
9.	    /*
10.	     构建ip头，ip协议头的源ip是INADDR_ANY，
11.	     即随机选择一个本机的，目的ip为多播组ip（address）  
12.	    */
13.	    tmp=ip_build_header(skb, 
14.	                          INADDR_ANY, 
15.	                          address, 
16.	                          &dev, 
17.	                          IPPROTO_IGMP, 
18.	                          NULL,  
19.	                        skb->mem_len, 0, 1);  
20.	    /*
21.	      data表示所有的数据部分，tmp表示ip头大小，所以igh
22.	      就是ip协议的数据部分，即igmp报文的内容  
23.	    */
24.	    igh=(struct igmphdr *)(skb->data+tmp);  
25.	    skb->len=tmp+sizeof(*igh);  
26.	    igh->csum=0;  
27.	    igh->unused=0;  
28.	    igh->type=type;  
29.	    igh->group=address;  
30.	    igh->csum=ip_compute_csum((void *)igh,sizeof(*igh));  
31.	    // 调用ip层发送出去  
32.	    ip_queue_xmit(NULL,dev,skb,1);  
33.	}  
```

igmp_send_report其实就是构造一个IGMP协议数据包，然后发送出去，告诉路由器某个主机加入了多播组，IGMP的协议格式如下

```
1.	struct igmphdr  
2.	{  
3.	    // 类型  
4.	    unsigned char type;  
5.	    unsigned char unused;  
6.	    // 校验和  
7.	    unsigned short csum;  
8.	    // igmp的数据部分，比如加入多播组的时候，group表示多播组ip  
9.	    unsigned long group;  
10.	};  
```

接着我们看ip_mc_filter_add

```
1.	void ip_mc_filter_add(struct device *dev, unsigned long addr)  
2.	{  
3.	    char buf[6];  
4.	    // 把多播组ip转成mac多播地址  
5.	    addr=ntohl(addr);  
6.	    buf[0]=0x01;  
7.	    buf[1]=0x00;  
8.	    buf[2]=0x5e;  
9.	    buf[5]=addr&0xFF;  
10.	   addr>>=8;  
11.	   buf[4]=addr&0xFF;  
12.	   addr>>=8;  
13.	   buf[3]=addr&0x7F;  
14.	   dev_mc_add(dev,buf,ETH_ALEN,0);  
15.	}  
```

我们知道IP地址是32位，mac地址是48位，但是IANA规定，IP V4组播MAC地址的高24位是0x01005E，第25位是0，低23位是ipv4组播地址的低23位。而多播的IP地址高四位固定是1110。另外低23位被映射到MAC多播地址的23位，所以多播IP地址中，有5位是可以随机组合的。这就意味着，每32个多播IP地址，映射到一个MAC地址。这会带来一些问题，假设主机x加入了多播组a，主机y加入了多播组b，而a和b对应的mac多播地址是一样的。当主机z给多播组a发送一个数据包的时候，这时候主机x和y的网卡都会处理该数据包，并上报到上层，但是多播组a对应的MAC多播地址和多播组b是一样的。我们拿到一个多播组ip的时候，可以计算出它的多播MAC地址，但是反过来就不行，因为一个多播mac地址对应了32个多播ip地址。那主机x和y怎么判断是不是发给自己的数据包？因为device维护了一个本device上的多播IP列表，操作系统根据收到的数据包中的IP目的地址和device的多播IP列表对比。如果在列表中，则说明是发给自己的。最后我们看看dev_mc_add。device中维护了当前的mac多播地址列表，它会把这个列表信息同步到网卡中，使得网卡可以处理该列表中多播mac地址的数据包，如图16-5所示。  
![](https://img-blog.csdnimg.cn/22995cb766664137b1a6d78daae7a288.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图16-5

```
1.	void dev_mc_add(struct device *dev, void *addr, int alen, int newonly)  
2.	{  
3.	    struct dev_mc_list *dmi;  
4.	    // device维护的多播mac地址列表  
5.	    for(dmi=dev->mc_list;dmi!=NULL;dmi=dmi->next)  
6.	    {  
7.	        // 已存在，则引用计数加一  
8.	        if(memcmp(dmi->dmi_addr,addr,dmi->dmi_addrlen)==0 && 
9.	            dmi->dmi_addrlen==alen)  
10.	        {  
11.	            if(!newonly)  
12.	                dmi->dmi_users++;  
13.	            return;  
14.	        }  
15.	    }  
16.	    // 不存在则新增一个项到device列表中  
17.	    dmi=(struct dev_mc_list *)kmalloc(sizeof(*dmi),GFP_KERNEL); 
18.	    memcpy(dmi->dmi_addr, addr, alen);  
19.	    dmi->dmi_addrlen=alen;  
20.	    dmi->next=dev->mc_list;  
21.	    dmi->dmi_users=1;  
22.	    dev->mc_list=dmi;  
23.	    dev->mc_count++;  
24.	    // 通知网卡需要处理该多播mac地址  
25.	    dev_mc_upload(dev);  
26.	}  
```

网卡的工作模式有几种，分别是正常模式（只接收发给自己的数据包）、混杂模式（接收所有数据包）、多播模式（接收一般数据包和多播数据包）。网卡默认是只处理发给自己的数据包，所以当我们加入一个多播组的时候，我们需要告诉网卡，当收到该多播组的数据包时，需要处理，而不是忽略。dev_mc_upload函数就是通知网卡。

```
1.	void dev_mc_upload(struct device *dev)  
2.	{  
3.	    struct dev_mc_list *dmi;  
4.	    char *data, *tmp;  
5.	    // 不工作了  
6.	    if(!(dev->flags&IFF_UP))  
7.	        return;  
8.	    /*
9.	      当前是混杂模式，则不需要设置多播了，因为网卡会处理所有
10.	     收到的数据，不管是不是发给自己的  
11.	    */
12.	    if(dev->flags&IFF_PROMISC)  
13.	    {  
14.	        dev->set_multicast_list(dev, -1, NULL);  
15.	        return;  
16.	    }  
17.	    /*
18.	      多播地址个数，为0，则设置网卡工作模式为正常模式，
19.	      因为不需要处理多播了  
20.	    */
21.	    if(dev->mc_count==0)  
22.	    {  
23.	        dev->set_multicast_list(dev,0,NULL);  
24.	        return;  
25.	    }  
26.	      
27.	    data=kmalloc(dev->mc_count*dev->addr_len, GFP_KERNEL);  
28.	    // 复制所有的多播mac地址信息  
29.	    for(tmp = data, dmi=dev->mc_list;dmi!=NULL;dmi=dmi->next)  
30.	    {  
31.	        memcpy(tmp,dmi->dmi_addr, dmi->dmi_addrlen);  
32.	        tmp+=dev->addr_len;  
33.	    }  
34.	    // 告诉网卡  
35.	    dev->set_multicast_list(dev,dev->mc_count,data);  
36.	    kfree(data);  
37.	}  
```

最后我们看一下set_multicast_list

```
1.	static void set_multicast_list(struct device *dev, int num_addrs, void *addrs)  
2.	{  
3.	    int ioaddr = dev->base_addr;  
4.	    // 多播模式  
5.	    if (num_addrs > 0) {  
6.	      outb(RX_MULT, RX_CMD);  
7.	      inb(RX_STATUS);     /* Clear status. */  
8.	    } else if (num_addrs < 0) { // 混杂模式  
9.	      outb(RX_PROM, RX_CMD);  
10.	     inb(RX_STATUS);  
11.	   } else { // 正常模式  
12.	    outb(RX_NORM, RX_CMD);  
13.	    inb(RX_STATUS);  
14.	   }  
15.	}  
```

set_multicast_list就是设置网卡工作模式的函数。至此，我们就成功加入了一个多播组。离开一个多播组也是类似的过程。
#### 16.2.5.2 维护多播组信息
加入多播组后，我们可以主动退出多播组，但是如果主机挂了，就无法主动退出了，所以多播路由也会定期向所有多播组的所有主机发送探测报文，所以主机需要监听来自多播路由的探测报文。

```
1.	void ip_mc_allhost(struct device *dev)  
2.	{  
3.	    struct ip_mc_list *i;  
4.	    for(i=dev->ip_mc_list;i!=NULL;i=i->next)  
5.	        if(i->multiaddr==IGMP_ALL_HOSTS)  
6.	            return;  
7.	    i=(struct ip_mc_list *)kmalloc(sizeof(*i), GFP_KERNEL);  
8.	    if(!i)  
9.	        return;  
10.	    I	->users=1;  
11.	    i->interface=dev;  
12.	    i->multiaddr=IGMP_ALL_HOSTS;  
13.	    i->next=dev->ip_mc_list;  
14.	    dev->ip_mc_list=i;  
15.	    ip_mc_filter_add(i->interface, i->multiaddr);  
16.	}  
```

设备启动的时候，操作系统会设置网卡监听目的IP是224.0.0.1的报文，使得可以处理目的IP是224.0.0.1的多播消息。该类型的报文是多播路由用于查询局域网当前多播组情况的，比如查询哪些多播组已经没有成员了，如果没有成员则删除路由信息。我们看看如何处理某设备的IGMP报文。

```
1.	int igmp_rcv(struct sk_buff *skb, struct device *dev, struct options *opt,  
2.	    unsigned long daddr, unsigned short len, unsigned long saddr, int redo,  
3.	    struct inet_protocol *protocol)  
4.	{  
5.	    // IGMP报头  
6.	    struct igmphdr *igh=(struct igmphdr *)skb->h.raw;  
7.	    // 该数据包是发给所有多播主机的，用于查询本多播组中是否还有成员  
8.	    if(igh->type==IGMP_HOST_MEMBERSHIP_QUERY && daddr==IGMP_ALL_HOSTS)  
9.	        igmp_heard_query(dev);  
10.	    // 该数据包是其它成员对多播路由查询报文的回复，同多播组的主机也会收到  
11.	    if(igh->type==IGMP_HOST_MEMBERSHIP_REPORT && daddr==igh->group)  
12.	        igmp_heard_report(dev,igh->group);  
13.	    kfree_skb(skb, FREE_READ);  
14.	    return 0;  
15.	}  
```

IGMP V1只处理两种报文，分别是组成员查询报文（查询组是否有成员），其它成员回复多播路由的报告报文。组成员查询报文由多播路由发出，所有的多播组中的所有主机都可以收到。组成员查询报文的IP协议头的目的地址是224.0.0.1（IGMP_ALL_HOSTS），代表所有的组播主机都可以处理该报文。我们看一下这两种报文的具体实现。

```
1.	static void igmp_heard_query(struct device *dev)  
2.	{  
3.	    struct ip_mc_list *im;  
4.	    for(im=dev->ip_mc_list;im!=NULL;im=im->next)  
5.	        // IGMP_ALL_HOSTS表示所有组播主机  
6.	        if(!im->tm_running && im->multiaddr!=IGMP_ALL_HOSTS)  
7.	            igmp_start_timer(im);  
8.	}  
```

该函数用于处理组播路由的查询报文，dev->ip_mc_list是该设备对应的所有多播组信息，这里针对该设备中的每一个多播组，开启对应的定时器，超时后会发送回复报文给多播路由。我们看一下开启定时器的逻辑。

```
1.	// 开启一个定时器  
2.	static void igmp_start_timer(struct ip_mc_list *im)  
3.	{  
4.	    int tv;  
5.	    if(im->tm_running)  
6.	        return;  
7.	    tv=random()%(10*HZ);        /* Pick a number any number 8) */  
8.	    im->timer.expires=tv;  
9.	    im->tm_running=1;  
10.	    add_timer(&im->timer);  
11.	}  
```

随机选择一个超时时间，然后插入系统维护的定时器队列。为什么使用定时器，而不是立即回复呢？因为多播路由只需要知道某个多播组是否至少还有一个成员，如果有的话就保存该多播组信息，否则就删除路由项。如果某多播组在局域网中有多个成员，那么多个成员都会处理该报文，如果都立即响应，则会引起过多没有必要的流量，因为组播路由只需要收到一个响应就行。我们看看超时时的逻辑。

```
1.	static void igmp_init_timer(struct ip_mc_list *im)  
2.	{  
3.	    im->tm_running=0;  
4.	    init_timer(&im->timer);  
5.	    im->timer.data=(unsigned long)im;  
6.	    im->timer.function=&igmp_timer_expire;  
7.	}  
8.	  
9.	static void igmp_timer_expire(unsigned long data)  
10.	{  
11.	    struct ip_mc_list *im=(struct ip_mc_list *)data;  
12.	    igmp_stop_timer(im);  
13.	    igmp_send_report(im->interface, im->multiaddr, IGMP_HOST_MEMBERSHIP_REPORT);  
14.	}  
```

我们看到，超时后会执行igmp_send_report发送一个类型是IGMP_HOST_MEMBERSHIP_REPORT的IGMP、目的IP是多播组IP的报文，说明该多播组还有成员。该报文不仅会发送给多播路由，还会发给同多播组的所有主机。其它主机也是类似的逻辑，即开启一个定时器。所以最快到期的主机会先发送回复报文给多播路由和同多播组的成员，我们看一下其它同多播组的主机收到该类报文时的处理逻辑。

```
1.	// 成员报告报文并且多播组是当前设置关联的多播组  
2.	if(igh->type==IGMP_HOST_MEMBERSHIP_REPORT && daddr==igh->group)  
3.	        igmp_heard_report(dev,igh->group);  
```

当一个多播组的其它成员针对多播路由的查询报文作了响应，因为该响应报文的目的IP是多播组IP，所以该多播组的其它成员也能收到该报文。当某个主机收到该类型的报文的时候，就知道同多播组的其它成员已经回复了多播路由了，我们就不需要回复了。

```
1.	/* 
2.	    收到其它组成员，对于多播路由查询报文的回复，则自己就不用回复了， 
3.	    因为多播路由知道该组还有成员，不会删除路由信息，减少网络流量 
4.	*/  
5.	static void igmp_heard_report(struct device *dev, unsigned long address)  
6.	{  
7.	    struct ip_mc_list *im;  
8.	    for(im=dev->ip_mc_list;im!=NULL;im=im->next)  
9.	        if(im->multiaddr==address)  
10.	            igmp_stop_timer(im);  
11.	}  
```

我们看到，这里会删除定时器。即不会作为响应了。
2.3 其它 socket关闭， 退出它之前加入过的多播

```
1.	void ip_mc_drop_socket(struct sock *sk)  
2.	{  
3.	    int i;  
4.	  
5.	    if(sk->ip_mc_list==NULL)  
6.	        return;  
7.	  
8.	    for(i=0;i<IP_MAX_MEMBERSHIPS;i++)  
9.	    {  
10.	        if(sk->ip_mc_list->multidev[i])  
11.	        {  
12.	            ip_mc_dec_group(sk->ip_mc_list->multidev[i], sk->ip_mc_list->multiaddr[i]);  
13.	            sk->ip_mc_list->multidev[i]=NULL;  
14.	        }  
15.	    }  
16.	    kfree_s(sk->ip_mc_list,sizeof(*sk->ip_mc_list));  
17.	    sk->ip_mc_list=NULL;  
18.	}  
```

设备停止工作了，删除对应的多播信息

```
1.	void ip_mc_drop_device(struct device *dev)  
2.	{  
3.	    struct ip_mc_list *i;  
4.	    struct ip_mc_list *j;  
5.	    for(i=dev->ip_mc_list;i!=NULL;i=j)  
6.	    {  
7.	        j=i->next;  
8.	        kfree_s(i,sizeof(*i));  
9.	    }  
10.	    dev->ip_mc_list=NULL;  
11.	}  
```

以上是IGMP V1版本的实现，在后续V2 V3版本了又增加了很多功能，比如离开组报文，针对离开报文中的多播组，增加特定组查询报文，用于查询某个组中是否还有成员，另外还有路由选举，当局域网中有多个多播路由，多播路由之间通过协议选举出IP最小的路由为查询路由，定时给多播组发送探测报文。然后成为查询器的多播路由，会定期给其它多播路由同步心跳。否则其它多播路由会在定时器超时时认为当前查询路由已经挂了，重新选举。

#### 16.2.5.3 开启多播
UDP的多播能力是需要用户主动开启的，原因是防止用户发送UDP数据包的时候，误传了一个多播地址，但其实用户是想发送一个单播的数据包。我们可以通过setBroadcast开启多播能力。我们看Libuv的代码。

```
1.	int uv_udp_set_broadcast(uv_udp_t* handle, int on) {  
2.	  if (setsockopt(handle->io_watcher.fd,  
3.	                 SOL_SOCKET,  
4.	                 SO_BROADCAST,  
5.	                 &on,  
6.	                 sizeof(on))) {  
7.	    return UV__ERR(errno);  
8.	  }  
9.	  
10.	  return 0;  
11.	}  
```

再看看操作系统的实现。

```
1.	int sock_setsockopt(struct sock *sk, int level, int optname,  
2.	        char *optval, int optlen){  
3.	    ...  
4.	    case SO_BROADCAST:  
5.	        sk->broadcast=val?1:0;  
6.	}  
```

我们看到实现很简单，就是设置一个标记位。当我们发送消息的时候，如果目的地址是多播地址，但是又没有设置这个标记，则会报错。

```
1.	if(!sk->broadcast && ip_chk_addr(sin.sin_addr.s_addr)==IS_BROADCAST)  
2.	      return -EACCES;  
```

上面代码来自调用udp的发送函数（例如sendto）时，进行的校验，如果发送的目的ip是多播地址，但是没有设置多播标记，则报错。
#### 16.2.5.4 多播的问题
服务器

```
1.	const dgram = require('dgram');  
2.	const udp = dgram.createSocket('udp4');  
3.	  
4.	udp.bind(1234, () => {  
5.	    // 局域网多播地址（224.0.0.0~224.0.0.255，该范围的多播数据包，路由器不会转发）  
6.	    udp.addMembership('224.0.0.114');  
7.	});  
8.	  
9.	udp.on('message', (msg, rinfo) => {  
10.	    console.log(`receive msg: ${msg} from ${rinfo.address}:${rinfo.port}`);  
11.	});  
```

服务器绑定1234端口后，加入多播组224.0.0.114，然后等待多播数据的到来。
客户端

```
1.	const dgram = require('dgram');  
2.	const udp = dgram.createSocket('udp4');  
3.	udp.bind(1234, () => {  
4.	    udp.addMembership('224.0.0.114');  
5.	});  
6.	udp.send('test', 1234, '224.0.0.114', (err) => {});   
```

客户端绑定1234端口后，也加入了多播组224.0.0.114，然后发送数据，但是发现服务端没有收到数据，客户端打印了receive msg test from 169.254.167.41:1234。这怎么多了一个IP出来？原来我主机有两个局域网地址。当我们加入多播组的时候，不仅可以设置加入哪个多播组，还能设置出口的设备和IP。当我们调用udp.addMembership('224.0.0.114')的时候，我们只是设置了我们加入的多播组，没有设置出口。这时候操作系统会为我们选择一个。根据输出，我们发现操作系统选择的是169.254.167.41（子网掩码是255.255.0.0）。因为这个IP和192开头的那个不是同一子网，但是我们加入的是局域网的多播IP，所有服务端无法收到客户端发出的数据包。下面是Node.js文档的解释。
>Tells the kernel to join a multicast group at the given multicastAddress and multicastInterface using the IP_ADD_MEMBERSHIP socket option. If the multicastInterface argument is not specified, the operating system will choose one interface and will add membership to it. To add membership to every available interface, call addMembership multiple times, once per interface.
>
我们看一下操作系统的相关逻辑。

```
1.	if(MULTICAST(daddr) && *dev==NULL && skb->sk && *skb->sk->ip_mc_name)  
2.	        *dev=dev_get(skb->sk->ip_mc_name);  
```

上面的代码来自操作系统发送IP数据包时的逻辑，如果目的IP似乎多播地址并且ip_mc_name非空（即我们通过addMembership第二个参数设置的值），则出口设备就是我们设置的值。否则操作系统自己选。所以我们需要显示指定这个出口，把代码改成udp.addMembership('224.0.0.114', '192.168.8.164');重新执行发现客户端和服务器都显示了receive msg test from 192.168.8.164:1234。为什么客户端自己也会收到呢？原来操作系统发送多播数据的时候，也会给自己发送一份。我们看看相关逻辑

```
1.	// 目的地是多播地址，并且不是回环设备   
2.	if (MULTICAST(iph->daddr) && !(dev->flags&IFF_LOOPBACK))  
3.	{  
4.	    // 是否需要给自己一份，默认为true  
5.	    if(sk==NULL || sk->ip_mc_loop)  
6.	    {     
7.	        // 给所有多播组的所有主机的数据包，则直接给自己一份  
8.	        if(iph->daddr==IGMP_ALL_HOSTS)  
9.	            ip_loopback(dev,skb);  
10.	        else  
11.	        {     
12.	            // 判断目的ip是否在当前设备的多播ip列表中，是的回传一份  
13.	            struct ip_mc_list *imc=dev->ip_mc_list;  
14.	            while(imc!=NULL)  
15.	            {  
16.	                if(imc->multiaddr==iph->daddr)  
17.	                {  
18.	                    ip_loopback(dev,skb);  
19.	                    break;  
20.	                }  
21.	                imc=imc->next;  
22.	            }  
23.	        }  
24.	    }  
25.	}  
```

以上代码来自IP层发送数据包时的逻辑。如果我们设置了sk->ip_mc_loop字段为1，并且数据包的目的IP在出口设备的多播列表中，则需要给自己回传一份。那么我们如何关闭这个特性呢？调用udp.setMulticastLoopback(false)就可以了。

#### 16.2.5.5 其它功能
UDP模块还提供了其它一些功能  
1 获取本端地址address  
如果用户没有显示调用bind绑定自己设置的IP和端口，那么操作系统就会随机选择。通过address函数就可以获取操作系统选择的源IP和端口。  
2 获取对端的地址  
通过remoteAddress函数可以获取对端地址。该地址由用户调用connect或sendto函数时设置。  
3 获取/设置缓冲区大小get/setRecvBufferSize，get/setSendBufferSize  
4 setMulticastLoopback  
发送多播数据包的时候，如果多播IP在出口设备的多播列表中，则给回环设备也发一份。  
5 setMulticastInterface  
设置多播数据的出口设备  
6 加入或退出多播组addMembership/dropMembership  
7 addSourceSpecificMembership/dropSourceSpecificMembership  
这两个函数是设置本端只接收特性源（主机）的多播数据包。  
8 setTTL  
单播ttl（单播的时候，IP协议头中的ttl字段）。  
9 setMulticastTTL  
多播ttl（多播的时候，IP协议的ttl字段）。  
10 ref/unref  
这两个函数设置如果Node.js主进程中只有UDP对应的handle时，是否允许Node.js退出。Node.js事件循环的退出的条件之一是是否还有ref状态的handle。 这些都是对操作系统API的封装，就不一一分析。
### 16.2.6 端口复用
我们在网络编程中经常会遇到端口重复绑定的错误，根据到底是我们不能绑定到同一个端口和IP两次。但是在UDP中，这是允许的，这就是端口复用的功能，在TCP中，我们通过端口复用来解决服务器重启时重新绑定到同一个端口的问题，因为我们知道端口有一个2msl的等待时间，重启服务器重新绑定到这个端口时，默认会报错，但是如果我们设置了端口复用（Node.js自动帮我们设置了），则可以绕过这个限制。UDP中也支持端口复用的功能，但是功能、用途和TCP的不太一样。因为多个进程可以绑定同一个IP和端口。但是一般只用于多播的情况下。下面我们来分析一下udp端口复用的逻辑。在Node.js中，使用UDP的时候，可以通过reuseAddr选项使得进程可以复用端口，并且每一个想复用端口的socket都需要设置reuseAddr。我们看一下Node.js中关于reuseAddr的逻辑。

```
1.	Socket.prototype.bind = function(port_, address_ /* , callback */) {  
2.	  let flags = 0;  
3.	    if (state.reuseAddr)  
4.	      flags |= UV_UDP_REUSEADDR;  
5.	    state.handle.bind(ip, port || 0, flags);  
6.	};  
我们看到Node.js在bind的时候会处理reuseAddr字段。我们直接看Libuv的逻辑。
1.	int uv__udp_bind(uv_udp_t* handle,  
2.	                 const struct sockaddr* addr,  
3.	                 unsigned int addrlen,  
4.	                 unsigned int flags) {  
5.	  if (flags & UV_UDP_REUSEADDR) {  
6.	    err = uv__set_reuse(fd);  
7.	  }  
8.	  bind(fd, addr, addrlen))
9.	  return 0;  
10.	}  
11.	  
12.	static int uv__set_reuse(int fd) {  
13.	  int yes;  
14.	  yes = 1;  
15.	  
16.	  if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes)))  
17.	    return UV__ERR(errno);  
18.	  return 0;  
19.	}  
```

我们看到Libuv通过最终通过setsockopt设置了端口复用，并且是在bind之前。我们不妨再深入一点，看一下Linux内核的实现。

```
1.	asmlinkage long sys_setsockopt(int fd, int level, int optname, char __user *optval, int optlen)  
2.	{  
3.	    int err;  
4.	    struct socket *sock;  
5.	  
6.	    if (optlen < 0)  
7.	        return -EINVAL;  
8.	              
9.	    if ((sock = sockfd_lookup(fd, &err))!=NULL)  
10.	    {  
11.	        if (level == SOL_SOCKET)  
12.	            err=sock_setsockopt(sock,level,optname,optval,optlen);  
13.	        else  
14.	            err=sock->ops->setsockopt(sock, level, optname, optval, optlen);  
15.	        sockfd_put(sock);  
16.	    }  
17.	    return err;  
18.	}  
```

sys_setsockopt是setsockopt对应的系统调用，我们看到sys_setsockopt也只是个入口函数，具体函数是sock_setsockopt。

```
1.	int sock_setsockopt(struct socket *sock, int level, int optname,  
2.	            char __user *optval, int optlen)  
3.	{  
4.	    struct sock *sk=sock->sk;  
5.	    int val;  
6.	    int valbool;  
7.	    int ret = 0;  
8.	      
9.	    if (get_user(val, (int __user *)optval))  
10.	        return -EFAULT;  
11.	      
12.	    valbool = val?1:0;  
13.	  
14.	    lock_sock(sk);  
15.	  
16.	    switch(optname)   
17.	    {  
18.	        case SO_REUSEADDR:  
19.	            sk->sk_reuse = valbool;  
20.	            break;  
21.	        // ...  
22.	    release_sock(sk);  
23.	    return ret;  
24.	}  
```

操作系统的处理很简单，只是做了一个标记。接下来我们看一下bind的时候是怎么处理的，因为端口是否重复和能否复用是在bind的时候判断的。这也是为什么在TCP中，即使两个进程不能绑定到同一个IP和端口，但是如果我们在主进程里执行了bind之后，再fork函数时，是可以实现绑定同一个IP端口的。言归正传我们看一下UDP中执行bind时的逻辑。

```
1.	int inet_bind(struct socket *sock, struct sockaddr *uaddr, int addr_len)  
2.	{  
3.	    if (sk->sk_prot->get_port(sk, snum)) {  
4.	        inet->saddr = inet->rcv_saddr = 0;  
5.	        err = -EADDRINUSE;  
6.	        goto out_release_sock;  
7.	    }  
8.	  
9.	}  
```

每个协议都可以实现自己的get_port钩子函数。用来判断当前的端口是否允许被绑定。如果不允许则返回EADDRINUSE，我们看看UDP协议的实现。

```
1.	static int udp_v4_get_port(struct sock *sk, unsigned short snum)  
2.	{  
3.	    struct hlist_node *node;  
4.	    struct sock *sk2;  
5.	    struct inet_sock *inet = inet_sk(sk);  
6.	    // 通过端口找到对应的链表，然后遍历链表  
7.	    sk_for_each(sk2, node, &udp_hash[snum & (UDP_HTABLE_SIZE - 1)]) {  
8.	            struct inet_sock *inet2 = inet_sk(sk2);  
9.	             // 端口已使用，则判断是否可以复用  
10.	            if (inet2->num == snum &&  
11.	                sk2 != sk &&  
12.	                (!inet2->rcv_saddr ||  
13.	                 !inet->rcv_saddr ||  
14.	                 inet2->rcv_saddr == inet->rcv_saddr) &&  
15.	                // 每个socket都需要设置端口复用标记  
16.	                (!sk2->sk_reuse || !sk->sk_reuse))  
17.	                // 不可以复用，报错  
18.	                goto fail;  
19.	        }  
20.	    // 可以复用  
21.	    inet->num = snum;  
22.	    if (sk_unhashed(sk)) {  
23.	        // 找到端口对应的位置  
24.	        struct hlist_head *h = &udp_hash[snum & (UDP_HTABLE_SIZE - 1)];  
25.	        // 插入链表  
26.	        sk_add_node(sk, h);  
27.	        sock_prot_inc_use(sk->sk_prot);  
28.	    }  
29.	    return 0;  
30.	  
31.	fail:  
32.	    write_unlock_bh(&udp_hash_lock);  
33.	    return 1;  
34.	}  
```

分析之前我们先看一下操作系统的一些数据结构，UDP协议的实现中，会使用如下的数据结构记录每一个UDP socket，如图16-6所示。  
![](https://img-blog.csdnimg.cn/43a0277600b14ea9996ac7685c56576a.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图16-6

我们看到操作系统使用一个数组作为哈希表，每次操作一个socket的时候，首先会根据socket的源端口和哈希算法计算得到一个数组索引，然后把socket插入索引锁对应的链表中，即哈希冲突的解决方法是链地址法。回到代码的逻辑，当用户想绑定一个端口的时候，操作系统会根据端口拿到对应的socket链表，然后逐个判断是否有相等的端口，如果有则判断是否可以复用。例如两个socket都设置了复用标记则可以复用。最后把socket插入到链表中。

```
1.	static inline void hlist_add_head(struct hlist_node *n, struct hlist_head *h)  
2.	{         
3.	        // 头结点  
4.	    struct hlist_node *first = h->first;  
5.	    n->next = first;  
6.	    if (first)  
7.	        first->pprev = &n->next;  
8.	    h->first = n;  
9.	    n->pprev = &h->first;  
10.	}  
```

我们看到操作系统是以头插法的方式插入新节点的。接着我们看一下操作系统是如何使用这些数据结构的。
#### 16.2.6.1 多播
我们先看一个例子，我们在同主机上新建两个JS文件（客户端），代码如下

```
1.	const dgram = require('dgram');    
2.	const udp = dgram.createSocket({type: 'udp4', reuseAddr: true});    
3.	udp.bind(1234, ‘192.168.8.164‘, () => {    
4.	    udp.addMembership('224.0.0.114', '192.168.8.164');    
5.	});    
6.	udp.on('message', (msg) => {  
7.	  console.log(msg)  
8.	});  
```

上面代码使得两个进程都监听了同样的IP和端口。接下来我们写一个UDP服务器。

```
1.	const dgram = require('dgram');    
2.	const udp = dgram.createSocket({type: 'udp4'});    
3.	const socket = udp.bind(5678);    
4.	socket.send('hi', 1234, '224.0.0.114', (err) => {  
5.	  console.log(err)  
6.	});  
```

上面的代码给一个多播组发送了一个数据，执行上面的代码，我们可以看到两个客户端进程都收到了数据。我们看一下收到数据时，操作系统是如何把数据分发给每个监听了同样IP和端口的进程的。下面是操作系统收到一个UDP数据包时的逻辑。

```
1.	int udp_rcv(struct sk_buff *skb)  
2.	{  
3.	    struct sock *sk;  
4.	    struct udphdr *uh;  
5.	    unsigned short ulen;  
6.	    struct rtable *rt = (struct rtable*)skb->dst;
7.	    // ip头中记录的源ip和目的ip  
8.	    u32 saddr = skb->nh.iph->saddr;  
9.	    u32 daddr = skb->nh.iph->daddr;  
10.	    int len = skb->len;  
11.	    // udp协议头结构体  
12.	    uh = skb->h.uh;  
13.	    ulen = ntohs(uh->len);  
14.	    // 广播或多播包  
15.	    if(rt->rt_flags & (RTCF_BROADCAST|RTCF_MULTICAST))  
16.	        return udp_v4_mcast_deliver(skb, uh, saddr, daddr);  
17.	    // 单播  
18.	    sk = udp_v4_lookup(saddr, uh->source, daddr, uh->dest, skb->dev->ifindex);  
19.	    // 找到对应的socket  
20.	    if (sk != NULL) {  
21.	        // 把数据插到socket的消息队列  
22.	        int ret = udp_queue_rcv_skb(sk, skb);  
23.	        sock_put(sk);  
24.	        if (ret > 0)  
25.	            return -ret;  
26.	        return 0;  
27.	    }  
28.	    return(0);  
29.	}  
```

我们看到单播和非单播时处理逻辑是不一样的，我们先看一下非单播的情况

```
1.	static int udp_v4_mcast_deliver(struct sk_buff *skb, struct udphdr *uh,  
2.	                 u32 saddr, u32 daddr)  
3.	{  
4.	    struct sock *sk;  
5.	    int dif;  
6.	  
7.	    read_lock(&udp_hash_lock);  
8.	    // 通过端口找到对应的链表  
9.	    sk = sk_head(&udp_hash[ntohs(uh->dest) & (UDP_HTABLE_SIZE - 1)]);  
10.	    dif = skb->dev->ifindex;  
11.	    sk = udp_v4_mcast_next(sk, uh->dest, daddr, uh->source, saddr, dif);  
12.	    if (sk) {  
13.	        struct sock *sknext = NULL;  
14.	        // 遍历每一个需要处理该数据包的socket  
15.	        do {  
16.	            struct sk_buff *skb1 = skb;  
17.	            sknext = udp_v4_mcast_next(sk_next(sk), 
18.	                                           uh->dest, daddr,  
19.	                                        uh->source, 
20.	                                           saddr, 
21.	                                           dif);  
22.	            if(sknext)  
23.	                // 复制一份
24.	                 skb1 = skb_clone(skb, GFP_ATOMIC);  
25.	            // 插入每一个socket的数据包队列  
26.	            if(skb1) {  
27.	                int ret = udp_queue_rcv_skb(sk, skb1);  
28.	                if (ret > 0)  
29.	                  kfree_skb(skb1);  
30.	            }  
31.	            sk = sknext;  
32.	        } while(sknext);  
33.	    } else  
34.	        kfree_skb(skb);  
35.	    read_unlock(&udp_hash_lock);  
36.	    return 0;  
37.	}  
```

在非单播的情况下，操作系统会遍历链表找到每一个可以接收该数据包的socket，然后把数据包复制一份，挂载到socket的接收队列。这就解释了本节开头的例子，即两个客户端进程都会收到UDP数据包。
#### 16.2.6.2 单播
接着我们再来看一下单播的情况。首先我们看一个例子。我们同样新建两个JS文件用作客户端。

```
1.	const dgram = require('dgram');    
2.	const udp = dgram.createSocket({type: 'udp4', reuseAddr: true});    
3.	const socket = udp.bind(5678);    
4.	socket.on('message', (msg) => {  
5.	  console.log(msg)  
6.	})  
```

然后再新建一个JS文件用作服务器。

```
1.	const dgram = require('dgram');    
2.	const udp = dgram.createSocket({type: 'udp4'});    
3.	const socket = udp.bind(1234);    
4.	udp.send('hi', 5678)  
```

执行以上代码，首先执行客户端，再执行服务器，我们会发现只有一个进程会收到数据。下面我们分析具体的原因，单播时收到会调用udp_v4_lookup函数找到接收该UDP数据包的socket，然后把数据包挂载到socket的接收队列中。我们看看udp_v4_lookup。

```
1.	static __inline__ struct sock *udp_v4_lookup(u32 saddr, u16 sport,  
2.	                         u32 daddr, u16 dport, int dif)  
3.	{  
4.	    struct sock *sk;  
5.	    sk = udp_v4_lookup_longway(saddr, sport, daddr, dport, dif);  
6.	    return sk;  
7.	}  
8.	  
9.	static struct sock *udp_v4_lookup_longway(u32 saddr, u16 sport,  
10.	                      u32 daddr, u16 dport, int dif)  
11.	{  
12.	    struct sock *sk, *result = NULL;  
13.	    struct hlist_node *node;  
14.	    unsigned short hnum = ntohs(dport);  
15.	    int badness = -1;  
16.	        // 遍历端口对应的链表  
17.	    sk_for_each(sk, node, &udp_hash[hnum & (UDP_HTABLE_SIZE - 1)]) {  
18.	        struct inet_sock *inet = inet_sk(sk);  
19.	  
20.	        if (inet->num == hnum && !ipv6_only_sock(sk)) {  
21.	            int score = (sk->sk_family == PF_INET ? 1 : 0);  
22.	            if (inet->rcv_saddr) {  
23.	                if (inet->rcv_saddr != daddr)  
24.	                    continue;  
25.	                score+=2;  
26.	            }  
27.	            if (inet->daddr) {  
28.	                if (inet->daddr != saddr)  
29.	                    continue;  
30.	                score+=2;  
31.	            }  
32.	            if (inet->dport) {  
33.	                if (inet->dport != sport)  
34.	                    continue;  
35.	                score+=2;  
36.	            }  
37.	            if (sk->sk_bound_dev_if) {  
38.	                if (sk->sk_bound_dev_if != dif)  
39.	                    continue;  
40.	                score+=2;  
41.	            }  
42.	            // 全匹配，直接返回，否则记录当前最好的匹配结果  
43.	            if(score == 9) {  
44.	                result = sk;  
45.	                break;  
46.	            } else if(score > badness) {  
47.	                result = sk;  
48.	                badness = score;  
49.	            }  
50.	        }  
51.	    }  
52.	    return result;  
53.	}  
```

我们看到代码很多，但是逻辑并不复杂，操作系统收到根据端口从哈希表中拿到对应的链表，然后遍历该链表找出最匹配的socket。然后把数据挂载到socket上。但是有一个细节需要注意，如果有两个进程都监听了同一个IP和端口，那么哪一个进程会收到数据呢？这个取决于操作系统的实现，从Linux源码我们看到，插入socket的时候是使用头插法，查找的时候是从头开始找最匹配的socket。即后面插入的socket会先被搜索到。但是Windows下结构却相反，先监听了该IP端口的进程会收到数据。
第
