
本章我们主要看一下Node.js中对TCP的封装，我们首先看一下在网络编程中，是如何编写一个服务器和客户端的（伪代码）。
服务器

```
1.	const fd = socket();  
2.	bind(fd, ip, port);  
3.	listen(fd);  
4.	const acceptedFd = accept(fd);  
5.	handle(acceptedFd);  
```

我们看一下这几个函数的作用
1 socket：socket函数用于从操作系统申请一个socket结构体，Linux中万物皆文件，所以最后操作系统会返回一个fd，fd在操作系统中类似数据库的id，操作系统底层维护了fd对应的资源，比如网络、文件、管道等，后续就可以通过该fd去操作对应的资源。
2 bind：bind函数用于给fd对应的socket设置地址（IP和端口），后续需要用到。
3 listen：listen函数用于修改fd对应的socket的状态和监听状态。只有监听状态的socket可以接受客户端的连接。socket我们可以理解有两种，一种是监听型的，一种是通信型的，监听型的socket只负责处理三次握手，建立连接，通信型的负责和客户端通信。
4 accept：accept函数默认会阻塞进程，直到有有连接到来并完成三次握手。
执行完以上代码，就完成了一个服务器的启动。这时候关系图如图17-1所示。    
![](https://img-blog.csdnimg.cn/e6592d4fb16d460180ec478a9d0def2a.png)  
图17-1  
客户端

```
1.	const fd = socket();  
2.	const connectRet = connect(fd, ip, port);  
3.	write(fd, 'hello');  
```

客户端比服务器稍微简单一点，我们看看这几个函数的作用。  
1 socket：和服务器一样，客户端也需要申请一个socket用于和服务器通信。  
2 connect：connect会开始三次握手过程，默认情况下会阻塞进程，直到连接有结果，连接结果通过返回值告诉调用方，如果三次握手完成，那么我们就可以开始发送数据了。  
3 write：write用于给服务器发送数据，不过并不是直接发送，这些数据只是保存到socket的发送缓冲区，底层会根据TCP协议决定什么时候发送数据。

我们看一下当客户端发送第一个握手的syn包时，socket处于syn发送状态，我们看看这时候的服务器是怎样的，如图17-2所示。  
![](https://img-blog.csdnimg.cn/81aa03be472d4923b127be501c0055c3.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图17-2  
我们看到这时候，服务器对应的socket中，会新建一个socket用于后续通信（socket结构体有一个字段指向该队列）。并且标记该socket的状态为收到syn，然后发送ack，即第二次握手，等到客户端回复第三次握手的数据包时，就完成了连接的建立。不同的操作系统版本实现不一样，有的版本实现中，已完成连接和正在建立连接的socket是在一个队列中的，有的版本实现中，已完成连接和正在建立连接的socket是分为两个队列维护的。
当客户端和服务器完成了TCP连接后，就可以进行数据通信了，这时候服务器的accept就会从阻塞中被唤醒，并从连接队列中摘下一个已完成连接的socket结点，然后生成一个新的fd。后续就可以在该fd上和对端通信。那么当客户端发送一个TCP数据包过来的时候，操作系统是如何处理的呢？  
1 操作系统首先根据TCP报文的源IP、源端口、目的IP、目的端口等信息从socket池中找到对应的socket。  
2 操作系统判断读缓冲区是否还有足够的空间，如果空间不够，则丢弃TCP报文，否则把报文对应的数据结构挂载到socket的数据队列，等待读取。  

了解了TCP通信的大致过程后，我们看一下Node.js中是如何封装底层的能力的。
## 17.1 TCP客户端
### 17.1.1 建立连接
net.connect是Node.js中发起TCP连接的API。本质上是对底层TCP connect函数的封装。connect返回一个表示客户端的Socket对象。我们看一下Node.js中的具体实现。我们首先看一下connect函数的入口定义。

```
1.	function connect(...args) {  
2.	  // 处理参数  
3.	  var normalized = normalizeArgs(args);  
4.	  var options = normalized[0];  
5.	  // 申请一个socket表示一个客户端  
6.	  var socket = new Socket(options);  
7.	  // 设置超时，超时后会触发timeout，用户可以自定义处理超时逻辑
8.	  if (options.timeout) {  
9.	    socket.setTimeout(options.timeout);  
10.	  }  
11.	  // 调用socket的connect  
12.	  return Socket.prototype.connect.call(socket, normalized);  
13.	}  
```

从代码中可以看到，connect函数是对Socket对象的封装。Socket表示一个TCP客户端。我们分成三部分分析。
 
```
1 new Socket 
2 setTimeout 
3 Socket的connect
```

1 new Socket  
我们看看新建一个Socket对象，做了什么事情。  

```
1.	function Socket(options) {  
2.	  // 是否正在建立连接，即三次握手中  
3.	  this.connecting = false;  
4.	  // 触发close事件时，该字段标记是否由于错误导致了close  
5.	  this._hadError = false;  
6.	  // 对应的底层handle，比如tcp_wrap  
7.	  this._handle = null;  
8.	  // 定时器id  
9.	  this[kTimeout] = null;  
10.	  options = options || {};  
11.	  // socket是双向流  
12.	  stream.Duplex.call(this, options);  
13.	  // 还不能读写，先设置成false，连接成功后再重新设置    
14.	  this.readable = this.writable = false;  
15.	    // 注册写端关闭的回调
16.	  this.on('finish', onSocketFinish); 
17.	    // 注册读端关闭的回调 
18.	  this.on('_socketEnd', onSocketEnd);  
19.	  // 是否允许半开关，默认不允许  
20.	  this.allowHalfOpen = options && options.allowHalfOpen||false; 
21.	}  
```

Socket是对C++模块tcp_wrap的封装。主要是初始化了一些属性和监听一些事件。
2 setTimeout 	

```
1.	Socket.prototype.setTimeout = function(msecs, callback) {  
2.	  // 清除之前的，如果有的话  
3.	  clearTimeout(this[kTimeout]);  
4.	  // 0代表清除  
5.	  if (msecs === 0) {  
6.	    if (callback) {  
7.	      this.removeListener('timeout', callback);  
8.	    }  
9.	  } else {  
10.	    // 开启一个定时器，超时时间是msecs，超时回调是_onTimeout  
11.	    this[kTimeout] = setUnrefTimeout(this._onTimeout.bind(this), msecs);  
12.	    /*
13.	          监听timeout事件，定时器超时时，底层会调用Node.js的回调，
14.	          Node.js会调用用户的回调callback  
15.	        */
16.	    if (callback) {  
17.	      this.once('timeout', callback);  
18.	    }  
19.	  }  
20.	  return this;  
21.	};  
```

setTimeout做的事情就是设置一个超时时间，这个时间用于检测socket的活跃情况（比如有数据通信），当socket活跃时，Node.js会重置该定时器，如果socket一直不活跃则超时会触发timeout事件，从而执行Node.js的_onTimeout回调，在回调里再触发用户传入的回调。我们看一下超时处理函数_onTimeout。 

```
1.	Socket.prototype._onTimeout = function() {  
2.	  this.emit('timeout');  
3.	};
```

直接触发timeout函数，回调用户的函数。我们看到setTimeout只是设置了一个定时器，然后触发timeout事件，Node.js并没有帮我们做额外的操作，所以我们需要自己处理，比如关闭socket。

```
1.	socket.setTimeout(10000);  
2.	socket.on('timeout', () => {  
3.	  socket.close();  
4.	});  
```

另外我们看到这里是使用setUnrefTimeout设置的定时器，因为这一类定时器不应该阻止事件循环的退出。
3 connect函数 
在第一步我们已经创建了一个socket，接着我们调用该socket的connect函数开始发起连接。 

```
1.	// 建立连接，即三次握手  
2.	Socket.prototype.connect = function(...args) {  
3.	  let normalized;  
4.	  /* 忽略参数处理 */  
5.	  var options = normalized[0];  
6.	  var cb = normalized[1]; 
7.	    // TCP在tcp_wrap.cc中定义   
8.	  this._handle = new TCP(TCPConstants.SOCKET); 
9.	    // 有数据可读时的回调 
10.	  this._handle.onread = onread;  
11.	  // 连接成功时执行的回调  
12.	  if (cb !== null) {  
13.	    this.once('connect', cb);  
14.	  }  
15.	  // 正在连接  
16.	  this.connecting = true;  
17.	  this.writable = true;  
18.	    // 重置定时器
19.	    this._unrefTimer();
20.	  // 可能需要DNS解析，解析成功再发起连接  
21.	  lookupAndConnect(this, options);  
22.	  return this;  
23.	};  
```

connect 函数主要是三个逻辑  
1 首先通过new TCP()创建一个底层的handle，比如我们这里是TCP（对应tcp_wrap.cc的实现）。   
2 设置一些回调   
3 做DNS解析（如果需要的话），然后发起三次握手。  
我们看一下new TCP意味着什么，我们看tcp_wrap.cc的实现  
```
1.	void TCPWrap::New(const FunctionCallbackInfo<Value>& args) {  
2.	  // 要以new TCP的形式调用  
3.	  CHECK(args.IsConstructCall());  
4.	  // 第一个入参是数字  
5.	  CHECK(args[0]->IsInt32());  
6.	  Environment* env = Environment::GetCurrent(args);  
7.	  // 作为客户端还是服务器  
8.	  int type_value = args[0].As<Int32>()->Value();  
9.	  TCPWrap::SocketType type = static_cast<TCPWrap::SocketType>(type_value);  
10.	  
11.	  ProviderType provider;  
12.	  switch (type) {  
13.	    // 作为客户端，即发起连接方  
14.	    case SOCKET:  
15.	      provider = PROVIDER_TCPWRAP;  
16.	      break;  
17.	    // 作为服务器  
18.	    case SERVER:  
19.	      provider = PROVIDER_TCPSERVERWRAP;  
20.	      break;  
21.	    default:  
22.	      UNREACHABLE();  
23.	  }  
24.	  new TCPWrap(env, args.This(), provider);  
25.	}  
```

new TCP对应到C++层，就是创建一个TCPWrap对象。并初始化对象中的handle_字段

```
1.	TCPWrap::TCPWrap(Environment* env, 
2.	                 Local<Object> object, 
3.	                 ProviderType provider)  
4.	    : ConnectionWrap(env, object, provider) {  
5.	  int r = uv_tcp_init(env->event_loop(), &handle_);  
6.	}  
```

初始化完底层的数据结构后，我们继续看lookupAndConnect，lookupAndConnect主要是对参数进行校验，然后进行DNS解析（如果传的是域名的话），DNS解析成功后执行internalConnect

```
1.	function internalConnect(  
2.	  self,   
3.	  // 需要连接的远端IP、端口  
4.	  address,   
5.	  port,   
6.	  addressType,   
7.	  /*
8.	      用于和对端连接的本地IP、端口（如果不设置，
9.	      则操作系统自己决定）  
10.	    */
11.	  localAddress,   
12.	  localPort) {  
13.	  var err;  
14.	  /*
15.	      如果传了本地的地址或端口，则TCP连接中的源IP
16.	      和端口就是传的，否则由操作系统自己选
17.	    */  
18.	  if (localAddress || localPort) {  
19.	      // IP v4  
20.	    if (addressType === 4) {  
21.	      localAddress = localAddress || '0.0.0.0';  
22.	      // 绑定地址和端口到handle
23.	      err = self._handle.bind(localAddress, localPort);  
24.	    } else if (addressType === 6) {  
25.	      localAddress = localAddress || '::';  
26.	      err = self._handle.bind6(localAddress, localPort);  
27.	    }  
28.	  
29.	    // 绑定是否成功  
30.	    err = checkBindError(err, localPort, self._handle);  
31.	    if (err) {  
32.	      const ex = exceptionWithHostPort(err,
33.	                                                'bind', 
34.	                                                localAddress, 
35.	                                                localPort);  
36.	      self.destroy(ex);  
37.	      return;  
38.	    }  
39.	  }  
40.	    // 对端的地址信息
41.	  if (addressType === 6 || addressType === 4) {  
42.	    // 新建一个请求对象，C++层定义  
43.	    const req = new TCPConnectWrap();  
44.	    // 设置一些列属性  
45.	    req.oncomplete = afterConnect;  
46.	    req.address = address;  
47.	    req.port = port;  
48.	    req.localAddress = localAddress;  
49.	    req.localPort = localPort;  
50.	    // 调用底层对应的函数  
51.	    if (addressType === 4)  
52.	      err = self._handle.connect(req, address, port);  
53.	    else  
54.	      err = self._handle.connect6(req, address, port);  
55.	  }  
56.	  /*
57.	     非阻塞调用，可能在还没发起三次握手之前就报错了，
58.	      而不是三次握手出错，这里进行出错处理  
59.	    */
60.	  if (err) {  
61.	    // 获取socket对应的底层IP端口信息  
62.	    var sockname = self._getsockname();  
63.	    var details;  
64.	  
65.	    if (sockname) {  
66.	      details = sockname.address + ':' + sockname.port;  
67.	    }  
68.	      // 构造错误信息，销魂socket并触发error事件
69.	    const ex = exceptionWithHostPort(err, 
70.	                                            'connect', 
71.	                                            address, 
72.	                                            port, 
73.	                                            details);  
74.	    self.destroy(ex);  
75.	  }  
76.	}  
```

这里的代码比较多，除了错误处理外，主要的逻辑是bind和connect。bind函数的逻辑很简单（即使是底层的bind），它就是在底层的一个结构体上设置了两个字段的值。所以我们主要来分析connect。我们把关于connect的这段逻辑拎出来。  

```
1.	       const req = new TCPConnectWrap();  
2.	    // 设置一些列属性  
3.	    req.oncomplete = afterConnect;  
4.	    req.address = address;  
5.	    req.port = port;  
6.	    req.localAddress = localAddress;  
7.	    req.localPort = localPort;  
8.	    // 调用底层对应的函数  
9.	    self._handle.connect(req, address, port); 
```

 
TCPConnectWrap是C++层提供的类，connect对应C++层的Conenct，
前面的章节我们已经分析过，不再具体分析。连接完成后，回调函数是uv__stream_io。在uv__stream_io里会调用connect_req中的回调。假设连接建立，这时候就会执行C++层的AfterConnect。AfterConnect会执行JS层的afterConnect。 

```
1.	// 连接后执行的回调，成功或失败  
2.	function afterConnect(status, handle, req, readable, writable) {   // handle关联的socket  
3.	  var self = handle.owner;  
4.	  // 连接过程中执行了socket被销毁了，则不需要继续处理  
5.	  if (self.destroyed) {  
6.	    return;  
7.	  }  
8.	  
9.	  handle = self._handle;
10.	 self.connecting = false;  
11.	 self._sockname = null;  
12.	 // 连接成功  
13.	 if (status === 0) {  
14.	    // 设置读写属性  
15.	    self.readable = readable;  
16.	    self.writable = writable;  
17.	    // socket当前活跃，重置定时器  
18.	    self._unrefTimer();  
19.	    // 触发连接成功事件  
20.	    self.emit('connect');  
21.	    // socket可读并且没有设置暂停模式，则开启读  
22.	    if (readable && !self.isPaused())  
23.	      self.read(0);  
24.	 } else {  
25.	    // 连接失败，报错并销毁socket  
26.	    self.connecting = false;  
27.	    var details;  
28.	    // 提示出错信息  
29.	    if (req.localAddress && req.localPort) {  
30.	      details = req.localAddress + ':' + req.localPort;  
31.	    }  
32.	    var ex = exceptionWithHostPort(status,  
33.	                                   'connect',  
34.	                                   req.address,  
35.	                                   req.port,  
36.	                                   details);  
37.	    if (details) {  
38.	      ex.localAddress = req.localAddress;  
39.	      ex.localPort = req.localPort;  
40.	    }  
41.	    // 销毁socket  
42.	    self.destroy(ex);  
43.	  }  
44.	}  
```

一般情况下，连接成功后，JS层调用self.read(0)注册等待可读事件。
### 17.1.2 读操作
我们看一下socket的读操作逻辑，在连接成功后，socket会通过read函数在底层注册等待可读事件，等待底层事件驱动模块通知有数据可读。

```
1.	Socket.prototype.read = function(n) {  
2.	  if (n === 0)  
3.	    return stream.Readable.prototype.read.call(this, n);  
4.	  
5.	  this.read = stream.Readable.prototype.read;  
6.	  this._consuming = true;  
7.	  return this.read(n);  
8.	};  
```

这里会执行Readable模块的read函数，从而执行_read函数，_read函数是由子类实现。所以我们看Socket的_read

```
1.	Socket.prototype._read = function(n) {  
2.	  // 还没建立连接，则建立后再执行  
3.	  if (this.connecting || !this._handle) {  
4.	    this.once('connect', () => this._read(n));  
5.	  } else if (!this._handle.reading) {  
6.	    this._handle.reading = true;  
7.	    // 执行底层的readStart注册等待可读事件  
8.	    var err = this._handle.readStart();  
9.	    if (err)  
10.	      this.destroy(errnoException(err, 'read'));  
11.	  }  
12.	};  
```

但是我们发现tcp_wrap.cc没有readStart函数。一路往父类找，最终在stream_wrap.cc找到了该函数。

```
1.	// 注册读事件  
2.	int LibuvStreamWrap::ReadStart() {  
3.	  return uv_read_start(stream(), 
4.	   [](uv_handle_t* handle,  
5.	   size_t suggested_size,  
6.	   uv_buf_t* buf) {  
7.	  // 分配存储数据的内存  
8.	  static_cast<LibuvStreamWrap*>(handle->data)->OnUvAlloc(suggested_size, buf);  
9.	  },
10.	  [](uv_stream_t* stream,ssize_t nread,const uv_buf_t* buf) {
11.	   // 读取数据成功的回调  
12.	   static_cast<LibuvStreamWrap*>(stream->data)->OnUvRead(nread, buf);  
13.	  });  
14.	}  
```

uv_read_start函数在流章节已经分析过，作用就是注册等待可读事件，这里就不再深入。OnUvAlloc是分配存储数据的函数，我们可以不关注，我们看一下OnUvRead，当可读事件触发时会执行OnUvRead

```
1.	void LibuvStreamWrap::OnUvRead(ssize_t nread, const uv_buf_t* buf) {  
2.	  HandleScope scope(env()->isolate());  
3.	  Context::Scope context_scope(env()->context());  
4.	  // 触发onread事件  
5.	  EmitRead(nread, *buf);  
6.	}  
```

OnUvRead函数触发onread回调。

```
1.	function onread(nread, buffer) {  
2.	  var handle = this;  
3.	    // handle关联的socket
4.	  var self = handle.owner; 
5.	    // socket有数据到来，处于活跃状态，重置定时器 
6.	    self._unrefTimer(); 
7.	  // 成功读取数据  
8.	  if (nread > 0) {  
9.	    // push到流中  
10.	    var ret = self.push(buffer);  
11.	    /*
12.	          push返回false，说明缓存的数据已经达到阈值，
13.	          不能再触发读，需要注销等待可读事件  
14.	        */
15.	    if (handle.reading && !ret) {  
16.	      handle.reading = false;  
17.	      var err = handle.readStop();  
18.	      if (err)  
19.	        self.destroy(errnoException(err, 'read'));  
20.	    }  
21.	    return;  
22.	  }  
23.	  
24.	  // 没有数据，忽略 
25.	  if (nread === 0) {  
26.	    debug('not any data, keep waiting');  
27.	    return;  
28.	  }  
29.	  // 不等于结束，则读出错，销毁流  
30.	  if (nread !== UV_EOF) {  
31.	    return self.destroy(errnoException(nread, 'read'));  
32.	  }  
33.	  // 流结束了，没有数据读了  
34.	  self.push(null);  
35.	  /*
36.	      也没有缓存的数据了，可能需要销毁流，比如是只读流，
37.	      或者可读写流，写端也没有数据了，参考maybeDestroy  
38.	    */
39.	  if (self.readableLength === 0) {  
40.	    self.readable = false;  
41.	    maybeDestroy(self);  
42.	  }  
43.	  // 触发事件  
44.	  self.emit('_socketEnd');  
45.	}  
```

socket可读事件触发时大概有下面几种情况  
1 有有效数据可读，push到流中，触发ondata事件通知用户。  
2 没有有效数据可读，忽略。  
3 读出错，销毁流  
4 读结束。  
我们分析一下4。在新建一个socket的时候注册了流结束的处理函数onSocketEnd。

```
1.	// 读结束后执行的函数  
2.	function onSocketEnd() {  
3.	  // 读结束标记  
4.	  this._readableState.ended = true;  
5.	  /* 
6.	    已经触发过end事件，则判断是否需要销毁，可能还有写端 
7.	  */
8.	  if (this._readableState.endEmitted) {  
9.	    this.readable = false;  
10.	   maybeDestroy(this);  
11.	 } else {  
12.	   // 还没有触发end则等待触发end事件再执行下一步操作  
13.	   this.once('end', function end() {  
14.	     this.readable = false;  
15.	     maybeDestroy(this);  
16.	   });  
17.	   /*
18.	     执行read，如果流中没有缓存的数据则会触发end事件，
19.	     否则等待消费完后再触发  
20.	   */
21.	   this.read(0);  
22.	 }  
23.	 /*
24.	   1 读结束后，如果不允许半开关，则关闭写端，如果还有数据还没有发送
25.	   完毕，则先发送完再关闭
26.	   2 重置写函数，后续执行写的时候报错  
27.	 */
28.	 if (!this.allowHalfOpen) {  
29.	   this.write = writeAfterFIN;  
30.	   this.destroySoon();  
31.	 }  
32.	}  
```

当socket的读端结束时，socket的状态变更分为几种情况  
1 如果可读流中还有缓存的数据，则等待读取。  
2 如果写端也结束了，则销毁流。  
3 如果写端没有结束，则判断allowHalfOpen是否允许半开关，不允许并且写端数据已经发送完毕则关闭写端。  
### 17.1.3 写操作
接着我们看一下在一个流上写的时候，逻辑是怎样的。Socket实现了单个写和批量写接口。

```
1.	// 批量写  
2.	Socket.prototype._writev = function(chunks, cb) {  
3.	  this._writeGeneric(true, chunks, '', cb);  
4.	};  
5.	  
6.	// 单个写  
7.	Socket.prototype._write = function(data, encoding, cb) {  
8.	  this._writeGeneric(false, data, encoding, cb);  
9.	};  
```

 _writeGeneric

```
1.	Socket.prototype._writeGeneric = function(writev, data, encoding, cb) {  
2.	  /*  
3.	     正在连接，则先保存待写的数据，因为stream模块是串行写的， 
4.	     所以第一次写没完成，不会执行第二次写操作（_write）， 
5.	     所以这里用一个字段而不是一个数组或队列保存数据和编码， 
6.	     因为有pendingData时_writeGeneric 不会被执行第二次，这里缓存 
7.	     pendingData不是为了后续写入，而是为了统计写入的数据总数 
8.	  */  
9.	  if (this.connecting) {  
10.	    this._pendingData = data;  
11.	    this._pendingEncoding = encoding;  
12.	    this.once('connect', function connect() {  
13.	      this._writeGeneric(writev, data, encoding, cb);  
14.	    });  
15.	    return;  
16.	  }  
17.	  // 开始写，则清空之前缓存的数据  
18.	  this._pendingData = null;  
19.	  this._pendingEncoding = '';  
20.	  // 写操作，有数据通信，刷新定时器  
21.	  this._unrefTimer();  
22.	  // 已经关闭，则销毁socket  
23.	  if (!this._handle) {  
24.	    this.destroy(new errors.Error('ERR_SOCKET_CLOSED'), cb);  
25.	    return false;  
26.	  }  
27.	  // 新建一个写请求  
28.	  var req = new WriteWrap();  
29.	  req.handle = this._handle;  
30.	  req.oncomplete = afterWrite;  
31.	  // 是否同步执行写完成回调，取决于底层是同步写入，然后执行回调还是异步写入  
32.	  req.async = false;  
33.	  var err;  
34.	  // 是否批量写  
35.	  if (writev) {  
36.	    // 所有数据都是buffer类型，则直接堆起来，否则需要保存编码类型  
37.	    var allBuffers = data.allBuffers;  
38.	    var chunks;  
39.	    var i;  
40.	    if (allBuffers) {  
41.	      chunks = data;  
42.	      for (i = 0; i < data.length; i++)  
43.	        data[i] = data[i].chunk;  
44.	    } else {  
45.	      // 申请double个大小的数组  
46.	      chunks = new Array(data.length << 1);  
47.	      for (i = 0; i < data.length; i++) {  
48.	        var entry = data[i];  
49.	        chunks[i * 2] = entry.chunk;  
50.	        chunks[i * 2 + 1] = entry.encoding;  
51.	      }  
52.	    }  
53.	    err = this._handle.writev(req, chunks, allBuffers);  
54.	  
55.	    // Retain chunks  
56.	    if (err === 0) req._chunks = chunks;  
57.	  } else {  
58.	    var enc;  
59.	    if (data instanceof Buffer) {  
60.	      enc = 'buffer';  
61.	    } else {  
62.	      enc = encoding;  
63.	    }  
64.	    err = createWriteReq(req, this._handle, data, enc);  
65.	  }  
66.	  
67.	  if (err)  
68.	    return this.destroy(errnoException(err, 'write', req.error), cb);  
69.	  // 请求写入底层的数据字节长度  
70.	  this._bytesDispatched += req.bytes;  
71.	  // 在stream_base.cc中req_wrap_obj->Set(env->async(), True(env->isolate()));设置  
72.	  if (!req.async) {  
73.	    cb();  
74.	    return;  
75.	  }  
76.	  
77.	  req.cb = cb;  
78.	  // 最后一次请求写数据的字节长度  
79.	  this[kLastWriteQueueSize] = req.bytes;  
80.	};  
```

上面的代码很多，但是逻辑并不复杂，具体实现在stream_base.cc和stream_wrap.cc，这里不再展开分析，主要是执行writev和createWriteReq函数进行写操作。它们底层调用的都是uv_write2（需要传递文件描述符）或uv_write（不需要传递文件描述符）或者uv_try_write函数进行写操作。这里只分析一下async的意义，async默认是false，它表示的意义是执行底层写入时，底层是否同步执行回调，async为false说明写入完成回调是同步执行的。在stream_base.cc的写函数中有相关的逻辑。

```
1.	err = DoWrite(req_wrap, buf_list, count, nullptr);  
2.	req_wrap_obj->Set(env->async(), True(env->isolate()));  
```

当执行DoWrite的时候，req_wrap中保存的回调可能会被Libuv同步执行，从而执行JS代码，这时候async是false（默认值），说明回调是被同步执行的，如果DoWrite没有同步执行回调。则说明是异步执行回调。设置async为true，再执行JS代码。
### 17.1.4 关闭写操作
当我们发送完数据后，我们可以通过调用socket对象的end函数关闭流的写端。我们看一下end的逻辑。

```
1.	Socket.prototype.end = function(data, encoding, callback) {  
2.	  stream.Duplex.prototype.end.call(this, 
3.	                                       data, 
4.	                                       encoding, 
5.	                                       callback);  
6.	  return this;  
7.	};  
```

Socket的end是调用的Duplex的end，而Duplex的end是继承于Writable的end。Writable的end最终会触发finish事件，socket在初始化的时候监听了该事件。

```
1.	this.on('finish', onSocketFinish); 
```
我们看看onSocketFinish。
```
1.	// 执行了end，并且数据发送完毕，则关闭写端  
2.	function onSocketFinish() {  
3.	  // 还没连接成功就执行了end  
4.	  if (this.connecting) {  
5.	    return this.once('connect', onSocketFinish);  
6.	  }  
7.	  // 写结束了，如果也不能读或者读结束了，则销毁socket  
8.	  if (!this.readable || this._readableState.ended) {  
9.	    return this.destroy();  
10.	  }  
11.	  // 不支持shutdown则直接销毁  
12.	  if (!this._handle || !this._handle.shutdown)  
13.	    return this.destroy();  
14.	  // 支持shutdown则执行关闭，并设置回调  
15.	  var err = defaultTriggerAsyncIdScope(  
16.	    this[async_id_symbol], shutdownSocket, this, afterShutdown  
17.	  );  
18.	  // 执行shutdown失败则直接销毁  
19.	  if (err)  
20.	    return this.destroy(errnoException(err, 'shutdown'));  
21.	}  
22.	
23.	// 发送关闭写端的请求  
24.	function shutdownSocket(self, callback) {  
25.	  var req = new ShutdownWrap();  
26.	  req.oncomplete = callback;  
27.	  req.handle = self._handle;  
28.	  return self._handle.shutdown(req);  
29.	}  
```

Shutdown函数在stream_base.cc中定义，最终调用uv_shutdown关闭流的写端，在Libuv流章节我们已经分析过。接着我们看一下关闭写端后，回调函数的逻辑。

```
1.	// 关闭写端成功后的回调  
2.	function afterShutdown(status, handle, req) {  
3.	  // handle关联的socket  
4.	  var self = handle.owner;  
5.	  // 已经销毁了，则不需要往下走了，否则执行销毁操作  
6.	  if (self.destroyed)  
7.	    return;  
8.	  // 写关闭成功，并且读也结束了，则销毁socket，否则等待读结束再执行销毁  
9.	  if (self._readableState.ended) {  
10.	    self.destroy();  
11.	  } else {  
12.	    self.once('_socketEnd', self.destroy);  
13.	  }  
14.	}  
```

### 17.1.5 销毁
当一个socket不可读也不可写的时候、被关闭、发生错误的时候，就会被销毁。销毁一个流就是销毁流的读端、写端。然后执行流子类的_destory函数。我们看一下socket的_destroy函数

```
1.	// 销毁时执行的钩子函数，exception代表是否因为错误导致的销毁  
2.	Socket.prototype._destroy = function(exception, cb) {  
3.	  this.connecting = false;  
4.	  this.readable = this.writable = false;  
5.	  // 清除定时器  
6.	  for (var s = this; s !== null; s = s._parent) {  
7.	    clearTimeout(s[kTimeout]);  
8.	  }  
9.	  
10.	  if (this._handle) {  
11.	    // 是否因为出错导致销毁流  
12.	    var isException = exception ? true : false;    
13.	    // 关闭底层handle  
14.	    this._handle.close(() => {  
15.	      // close事件的入参，表示是否因为错误导致的关闭  
16.	      this.emit('close', isException);  
17.	    });  
18.	    this._handle.onread = noop;  
19.	    this._handle = null;  
20.	    this._sockname = null;  
21.	  }  
22.	  // 执行回调  
23.	  cb(exception);  
24.	  // socket所属的server，作为客户端时是null  
25.	  if (this._server) {  
26.	    // server下的连接数减一  
27.	    this._server._connections--;  
28.	    /*
29.	      是否需要触发server的close事件，
30.	      当所有的连接（socket）都关闭时才触发server的是close事件  
31.	    */
32.	    if (this._server._emitCloseIfDrained) {  
33.	      this._server._emitCloseIfDrained();  
34.	    }  
35.	  }  
36.	};  
```
_stream_writable.js中的destroy函数只是修改读写流的状态和标记，子类需要定义_destroy函数销毁相关的资源，socket通过调用close关闭底层关联的资源，关闭后触发socket的close事件（回调函数的第一个参数是boolean类型，说明是否因为错误导致socket关闭）。最后判断该socket是否来自服务器创建的，是的话该服务器的连接数减一，如果服务器执行了close并且当前连接数为0，则关闭服务器。
## 17.2 TCP 服务器
net模块提供了createServer函数创建一个TCP服务器。

```
1.	function createServer(options, connectionListener) {  
2.	  return new Server(options, connectionListener);  
3.	}  
4.	  
5.	function Server(options, connectionListener) {  
6.	  EventEmitter.call(this);  
7.	  // 注册连接到来时执行的回调  
8.	  if (typeof options === 'function') {  
9.	    connectionListener = options;  
10.	    options = {};  
11.	    this.on('connection', connectionListener);  
12.	  } else if (options == null || typeof options === 'object') {  
13.	    options = options || {};  
14.	    if (typeof connectionListener === 'function') {  
15.	      this.on('connection', connectionListener);  
16.	    }  
17.	  } else {  
18.	    throw new errors.TypeError('ERR_INVALID_ARG_TYPE',  
19.	                               'options',  
20.	                               'Object',  
21.	                               options);  
22.	  }  
23.	  // 服务器建立的连接数  
24.	  this._connections = 0;  
25.	  this._handle = null;  
26.	  this._unref = false;  
27.	  // 服务器下的所有连接是否允许半连接  
28.	  this.allowHalfOpen = options.allowHalfOpen || false;  
29.	  // 有连接时是否注册读事件  
30.	  this.pauseOnConnect = !!options.pauseOnConnect;  
31.	}  
```

createServer返回的就是一个一般的JS对象，接着调用listen函数监听端口。看一下listen函数的逻辑

```
1.	Server.prototype.listen = function(...args) {  
2.	  /*
3.	     处理入参，根据文档我们知道listen可以接收好几个参数，
4.	      假设我们这里是只传了端口号9297  
5.	    */
6.	  var normalized = normalizeArgs(args);  
7.	  //  normalized = [{port: 9297}, null];  
8.	  var options = normalized[0];  
9.	  var cb = normalized[1];  
10.	  // 第一次listen的时候会创建，如果非空说明已经listen过  
11.	  if (this._handle) {  
12.	    throw new errors.Error('ERR_SERVER_ALREADY_LISTEN');  
13.	  }  
14.	  // listen成功后执行的回调  
15.	  var hasCallback = (cb !== null);  
16.	  if (hasCallback) {  
17.	    // listen成功的回调  
18.	    this.once('listening', cb);  
19.	  }  
20.	    
21.	  options = options._handle || options.handle || options;  
22.	  // 第一种情况，传进来的是一个TCP服务器，而不是需要创建一个服务器  
23.	  if (options instanceof TCP) {  
24.	    this._handle = options;  
25.	    this[async_id_symbol] = this._handle.getAsyncId();  
26.	    listenIncluster(this, null, -1, -1, backlogFromArgs);  
27.	    return this;  
28.	  }  
29.	  // 第二种，传进来一个对象，并且带了fd  
30.	  if (typeof options.fd === 'number' && options.fd >= 0) {  
31.	    listenIncluster(this, 
32.	                        null, 
33.	                        null, 
34.	                        null, 
35.	                        backlogFromArgs, 
36.	                        options.fd);  
37.	    return this;  
38.	  }  
39.	  // 创建一个tcp服务器  
40.	  var backlog;  
41.	  if (typeof options.port === 'number' || 
42.	         typeof options.port === 'string') {  
43.	    backlog = options.backlog || backlogFromArgs;  
44.	    // 第三种 启动一个TCP服务器，传了host则先进行DNS解析
45.	    if (options.host) {  
46.	          lookupAndListen(this,
47.	                          options.port | 0, 
48.	                          options.host, 
49.	                          backlog,
50.	                          options.exclusive);  
51.	    } else {
52.	      listenIncluster(this, 
53.	                            null, 
54.	                            options.port | 0, 
55.	                            4,      
56.	                            backlog, 
57.	                            undefined, 
58.	                            options.exclusive);  
59.	    }  
60.	    return this;  
61.	  }  
62.	};  
```

我们看到有三种情况，分别是传了一个服务器、传了一个fd、传了端口（或者host），但是我们发现，这几种情况最后都是调用了listenIncluster（lookupAndListen是先DNS解析后再执行listenIncluster），只是入参不一样，所以我们直接看listenIncluster。
```
1.	function listenIncluster(server, 
2.	                          address, 
3.	                          port, 
4.	                          addressType,      
5.	                          backlog, 
6.	                          fd, 
7.	                          exclusive) {  
8.	  exclusive = !!exclusive;  
9.	  if (cluster === null) cluster = require('cluster'); 
10.	  if (cluster.isMaster || exclusive) {  
11.	    server._listen2(address, port, addressType, backlog, fd);
12.	    return;  
13.	  }  
14.	}  
```
因为我们是在主进程，所以直接执行_listen2，子进程的在cluster模块分析。_listen对应的函数是setupListenHandle

```
1.	function setupListenHandle(address, port, addressType, backlog, fd) {  
2.	  // 有handle则不需要创建了，否则创建一个底层的handle  
3.	  if (this._handle) {  
4.	      
5.	  } else {  
6.	    var rval = null;  
7.	    // 没有传fd，则说明是监听端口和IP  
8.	    if (!address && typeof fd !== 'number') {  
9.	      rval = createServerHandle('::', port, 6, fd);  
10.	      /*
11.	               返回number说明bind IPv6版本的handle失败，
12.	               回退到v4，否则说明支持IPv6  
13.	            */
14.	      if (typeof rval === 'number') {  
15.	        // 赋值为null，才能走下面的createServerHandle  
16.	        rval = null;  
17.	        address = '0.0.0.0';  
18.	        addressType = 4;  
19.	      } else {  
20.	        address = '::';  
21.	        addressType = 6;  
22.	      }  
23.	    }  
24.	    // 创建失败则继续创建  
25.	    if (rval === null)  
26.	      rval = createServerHandle(address, 
27.	                                        port, 
28.	                                        addressType, 
29.	                                        fd);  
30.	    // 还报错则说明创建服务器失败，报错  
31.	    if (typeof rval === 'number') {  
32.	      var error = exceptionWithHostPort(rval, 
33.	                                                 'listen', 
34.	                                                 address, 
35.	                                                 port);  
36.	      process.nextTick(emitErrorNT, this, error);  
37.	      return;  
38.	    }  
39.	    this._handle = rval;  
40.	  }  
41.	  
42.	  // 有完成三次握手的连接时执行的回调  
43.	  this._handle.onconnection = onconnection;  
44.	  this._handle.owner = this;  
45.	  // 执行C++层listen  
46.	  var err = this._handle.listen(backlog || 511);  
47.	  // 出错则报错  
48.	  if (err) {  
49.	    var ex = exceptionWithHostPort(err, 
50.	                                          'listen', 
51.	                                          address, 
52.	                                          port);  
53.	    this._handle.close();  
54.	    this._handle = null;  
55.	    nextTick(this[async_id_symbol], emitErrorNT, this, ex);  
56.	    return;  
57.	  } 
58.	  // 触发listen回调  
59.	  nextTick(this[async_id_symbol], emitListeningNT, this);  
60.	}  
```

主要是调用createServerHandle创建一个handle，然后调用listen函数监听。我们先看createServerHandle

```
1.	function createServerHandle(address, port, addressType, fd) {  
2.	  var err = 0;  
3.	  var handle;  
4.	  
5.	  var isTCP = false;  
6.	  // 传了fd则根据fd创建一个handle  
7.	  if (typeof fd === 'number' && fd >= 0) {  
8.	    try {  
9.	      handle = createHandle(fd, true);  
10.	    } catch (e) {  
11.	      return UV_EINVAL;  
12.	    }  
13.	    // 把fd存到handle中  
14.	    handle.open(fd);  
15.	    handle.readable = true;  
16.	    handle.writable = true;  
17.	    assert(!address && !port);  
18.	    // 管道  
19.	  } else if (port === -1 && addressType === -1) {  
20.	    // 创建一个Unix域服务器  
21.	    handle = new Pipe(PipeConstants.SERVER);  
22.	  } else {  
23.	    // 创建一个TCP服务器  
24.	    handle = new TCP(TCPConstants.SERVER);  
25.	    isTCP = true;  
26.	  }  
27.	  /*
28.	      有地址或者IP说明是通过IP端口创建的TCP服务器，
29.	       需要调bind绑定地址 
30.	    */ 
31.	  if (address || port || isTCP) {  
32.	    // 没有地址，则优先绑定IPv6版本的本地地址  
33.	    if (!address) {  
34.	      // Try binding to IPv6 first  
35.	      err = handle.bind6('::', port);  
36.	      // 失败则绑定v4的  
37.	      if (err) {  
38.	        handle.close();  
39.	        // Fallback to IPv4  
40.	        return createServerHandle('0.0.0.0', port);  
41.	      }  
42.	    } else if (addressType === 6) { // IPv6或v4  
43.	      err = handle.bind6(address, port);  
44.	    } else {  
45.	      err = handle.bind(address, port);  
46.	    }  
47.	  }  
48.	  
49.	  if (err) {  
50.	    handle.close();  
51.	    return err;  
52.	  }  
53.	  
54.	  return handle;  
55.	}  
```

createServerHandle主要是调用createHandle创建一个handle然后执行bind函数。创建handle的方式有几种，直接调用C++层的函数或者通过fd创建。调用createHandle可以通过fd创建一个handle

```
1.		// 通过fd创建一个handle，作为客户端或者服务器  
2.	function createHandle(fd, is_server) {  
3.	  // 判断fd对应的类型  
4.	  const type = TTYWrap.guessHandleType(fd);  
5.	  // Unix域  
6.	  if (type === 'PIPE') {  
7.	    return new Pipe(  
8.	      is_server ? PipeConstants.SERVER : PipeConstants.SOCKET      );  
9.	  }  
10.	  // tcp  
11.	  if (type === 'TCP') {  
12.	    return new TCP(  
13.	      is_server ? TCPConstants.SERVER : TCPConstants.SOCKET  
14.	    );  
15.	  }  
16.	  
17.	  throw new errors.TypeError('ERR_INVALID_FD_TYPE', type);  
18.	}  
```

接着我们看一下bind函数的逻辑，

```
1.	int uv__tcp_bind(uv_tcp_t* tcp,  
2.	                 const struct sockaddr* addr,  
3.	                 unsigned int addrlen,  
4.	                 unsigned int flags) {  
5.	  int err;  
6.	  int on;  
7.	  // 如果没有socket则创建一个，有判断是否设置了UV_HANDLE_BOUND，是则执行bind，否则不执行bind  
8.	  err = maybe_new_socket(tcp, addr->sa_family, 0);  
9.	  if (err)  
10.	    return err;  
11.	  
12.	  on = 1;  
13.	  // 设置在断开连接的2 msl内可以重用端口，所以Node.js服务器可以快速重启  
14.	  if (setsockopt(tcp->io_watcher.fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on)))  
15.	    return UV__ERR(errno);  
16.	  errno = 0;  
17.	  // 执行bind  
18.	  if (bind(tcp->io_watcher.fd, addr, addrlen) && errno != EADDRINUSE) {  
19.	    if (errno == EAFNOSUPPORT)  
20.	      return UV_EINVAL;  
21.	    return UV__ERR(errno);  
22.	  }  
23.	  // bind是否出错  
24.	  tcp->delayed_error = UV__ERR(errno);  
25.	  // 打上已经执行了bind的标记  
26.	  tcp->flags |= UV_HANDLE_BOUND;  
27.	  if (addr->sa_family == AF_INET6)  
28.	    tcp->flags |= UV_HANDLE_IPV6;  
29.	  
30.	  return 0;  
31.	}  
```

执行完bind后，会继续执行listen，我们接着看listen函数做了什么。我们直接看tcp_wrap.cc的Listen。

```
1.	void TCPWrap::Listen(const FunctionCallbackInfo<Value>& args) {  
2.	  TCPWrap* wrap;  
3.	  ASSIGN_OR_RETURN_UNWRAP(&wrap,  
4.	              args.Holder(),  
5.	              args.GetReturnValue().Set(UV_EBADF));  
6.	  int backlog = args[0]->Int32Value();  
7.	  int err = uv_listen(reinterpret_cast<uv_stream_t*>(&wrap->handle_),  
8.	              backlog,  
9.	              OnConnection);  
10.	  args.GetReturnValue().Set(err);  
11.	}  
```

C++层几乎是透传到Libuv，Libuv的内容我们不再具体展开，当有三次握手的连接完成时，会执行OnConnection

```
1.	template <typename WrapType, typename UVType>  
2.	void ConnectionWrap<WrapType, UVType>::OnConnection(uv_stream_t* handle, int status) {  
3.	  // TCPWrap                   
4.	  WrapType* wrap_data = static_cast<WrapType*>(handle->data);  
5.	  Environment* env = wrap_data->env();  
6.	  HandleScope handle_scope(env->isolate());  
7.	  Context::Scope context_scope(env->context());  
8.	  Local<Value> argv[] = {  
9.	    Integer::New(env->isolate(), status),  
10.	    Undefined(env->isolate())  
11.	  };  
12.	  
13.	  if (status == 0) { 
14.	    // 新建一个表示和客户端通信的对象,必填TCPWrap对象  
15.	    Local<Object> client_obj = WrapType::Instantiate(env,wrap_data,WrapType::SOCKET);  
16.	    WrapType* wrap;  
17.	    // 解包出一个TCPWrap对象存到wrap  
18.	    ASSIGN_OR_RETURN_UNWRAP(&wrap, client_obj);  
19.	    uv_stream_t* client_handle = reinterpret_cast<uv_stream_t*>(&wrap->handle_);  
20.	    // 把通信fd存储到client_handle中  
21.	    if (uv_accept(handle, client_handle))  
22.	      return;  
23.	    argv[1] = client_obj;  
24.	  }  
25.	  // 回调上层的onconnection函数  
26.	  wrap_data->MakeCallback(env->onconnection_string(), arraysize(argv), argv);  
27.	}  
```

当建立了新连接时，操作系统会新建一个socket表示，同样，在Node.js层，也会新建一个对应的对象表示和客户端的通信，接着我们看JS层回调。

```
1.	// clientHandle代表一个和客户端建立TCP连接的实体  
2.	function onconnection(err, clientHandle) {  
3.	  var handle = this;  
4.	  var self = handle.owner;  
5.	  // 错误则触发错误事件  
6.	  if (err) {  
7.	    self.emit('error', errnoException(err, 'accept'));  
8.	    return;  
9.	  }  
10.	  // 建立过多，关掉  
11.	  if (self.maxConnections && self._connections >= self.maxConnections) {  
12.	    clientHandle.close();  
13.	    return;  
14.	  }  
15.	  //新建一个socket用于通信  
16.	  var socket = new Socket({  
17.	    handle: clientHandle,  
18.	    allowHalfOpen: self.allowHalfOpen,  
19.	    pauseOnCreate: self.pauseOnConnect  
20.	  });  
21.	  socket.readable = socket.writable = true;  
22.	  // 服务器的连接数加一  
23.	  self._connections++;  
24.	  socket.server = self;  
25.	  socket._server = self;  
26.	  // 触发用户层连接事件  
27.	  self.emit('connection', socket); 
28.	} 
```

在JS层也会封装一个Socket对象用于管理和客户端的通信，接着触发connection事件。剩下的事情就是应用层处理了。
## 17.3 keepalive
本节分析基于TCP层的长连接问题，相比应用层HTTP协议的长连接，TCP层提供的功能更多。TCP层定义了三个配置。  
1 多久没有收到数据包，则开始发送探测包。  
2 每隔多久，再次发送探测包。  
3 发送多少个探测包后，就断开连接。  
我们看Linux内核代码里提供的配置。

```
1.	// 多久没有收到数据就发起探测包  
2.	#define TCP_KEEPALIVE_TIME  (120*60*HZ) /* two hours */  
3.	// 探测次数  
4.	#define TCP_KEEPALIVE_PROBES  9   /* Max of 9 keepalive probes*/  
5.	// 每隔多久探测一次  
6.	#define TCP_KEEPALIVE_INTVL (75*HZ)  
```

这是Linux提供的默认值。下面再看看阈值

```
1.	#define MAX_TCP_KEEPIDLE    32767  
2.	#define MAX_TCP_KEEPINTVL   32767  
3.	#define MAX_TCP_KEEPCNT     127  
```

这三个配置和上面三个一一对应。是上面三个配置的阈值。我们看一下Node.js中keep-alive的使用。
socket.setKeepAlive([enable][, initialDelay])  
enable：是否开启keep-alive，Linux下默认是不开启的。
initialDelay：多久没有收到数据包就开始发送探测包。
接着我们看看这个API在Libuv中的实现。

```
1.	int uv__tcp_keepalive(int fd, int on, unsigned int delay) {    
2.	    if (setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &on, sizeof(on)))   
3.	      return UV__ERR(errno);    
4.	    // Linux定义了这个宏    
5.	    #ifdef TCP_KEEPIDLE    
6.	      /*  
7.	          on是1才会设置，所以如果我们先开启keep-alive，并且设置delay，  
8.	          然后关闭keep-alive的时候，是不会修改之前修改过的配置的。  
9.	          因为这个配置在keep-alive关闭的时候是没用的  
10.	      */    
11.	      if (on && setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &delay, sizeof(delay)))    
12.	        return UV__ERR(errno);    
13.	    #endif    
14.	    
15.	    return 0;    
16.	}    
```

我们看到Libuv调用了同一个系统函数两次。我们分别看一下这个函数的意义。参考Linux2.6.13.1的代码。

```
1.	// net\socket.c    
2.	asmlinkage long sys_setsockopt(int fd, int level, int optname, char __user *optval, int optlen)    
3.	{    
4.	    int err;    
5.	    struct socket *sock;    
6.	  
7.	    if ((sock = sockfd_lookup(fd, &err))!=NULL)    
8.	    {    
9.	        ...    
10.	        if (level == SOL_SOCKET)    
11.	            err=sock_setsockopt(sock,level,optname,optval,optlen);    
12.	        else    
13.	          err=sock->ops->setsockopt(sock, level, optname, optval, optlen);    
14.	        sockfd_put(sock);    
15.	    }    
16.	    return err;    
17.	}    
```

当level是SOL_SOCKET代表修改的socket层面的配置。IPPROTO_TCP是修改TCP层的配置（该版本代码里是SOL_TCP）。我们先看SOL_SOCKET层面的。

```
1.	// net\socket.c -> net\core\sock.c -> net\ipv4\tcp_timer.c    
2.	int sock_setsockopt(struct socket *sock, int level, int optname,    
3.	            char __user *optval, int optlen) {    
4.	    ...    
5.	    case SO_KEEPALIVE:    
6.	    
7.	            if (sk->sk_protocol == IPPROTO_TCP)    
8.	                tcp_set_keepalive(sk, valbool);    
9.	            // 设置SOCK_KEEPOPEN标记位1    
10.	            sock_valbool_flag(sk, SOCK_KEEPOPEN, valbool);    
11.	            break;    
12.	    ...    
13.	}   
```

sock_setcsockopt首先调用了tcp_set_keepalive函数，然后给对应socket的SOCK_KEEPOPEN字段打上标记（0或者1表示开启还是关闭）。接下来我们看tcp_set_keepalive  

```
1.	void tcp_set_keepalive(struct sock *sk, int val)    
2.	{    
3.	    if ((1 << sk->sk_state) & (TCPF_CLOSE | TCPF_LISTEN))    
4.	        return;    
5.	    /*  
6.	        如果val是1并且之前是0（没开启）那么就开启计时，超时后发送探测包，  
7.	        如果之前是1，val又是1，则忽略，所以重复设置是无害的  
8.	    */    
9.	    if (val && !sock_flag(sk, SOCK_KEEPOPEN))    
10.	        tcp_reset_keepalive_timer(sk, keepalive_time_when(tcp_sk(sk)));    
11.	    else if (!val)    
12.	        // val是0表示关闭，则清除定时器，就不发送探测包了    
13.	        tcp_delete_keepalive_timer(sk);    
14.	}   
```

我们看看超时后的逻辑。  

```
1.	// 多久没有收到数据包则发送第一个探测包      
2.	static inline int keepalive_time_when(const struct tcp_sock *tp)      
3.	{      
4.	    // 用户设置的（TCP_KEEPIDLE）和系统默认的      
5.	    return tp->keepalive_time ? : sysctl_tcp_keepalive_time;      
6.	}      
7.	// 隔多久发送一个探测包      
8.	static inline int keepalive_intvl_when(const struct tcp_sock *tp)      
9.	{      
10.	    return tp->keepalive_intvl ? : sysctl_tcp_keepalive_intvl;      
11.	}      
12.	      
13.	static void tcp_keepalive_timer (unsigned long data)      
14.	{      
15.	...      
16.	// 多久没有收到数据包了      
17.	elapsed = tcp_time_stamp - tp->rcv_tstamp;      
18.	    // 是否超过了阈值      
19.	    if (elapsed >= keepalive_time_when(tp)) {      
20.	        // 发送的探测包个数达到阈值，发送重置包      
21.	        if ((!tp->keepalive_probes && tp->probes_out >= sysctl_tcp_keepalive_probes) ||      
22.	             (tp->keepalive_probes && tp->probes_out >= tp->keepalive_probes)) {      
23.	            tcp_send_active_reset(sk, GFP_ATOMIC);      
24.	            tcp_write_err(sk);      
25.	            goto out;      
26.	        }      
27.	        // 发送探测包，并计算下一个探测包的发送时间（超时时间）      
28.	        tcp_write_wakeup(sk)      
29.	            tp->probes_out++;      
30.	            elapsed = keepalive_intvl_when(tp);      
31.	    } else {      
32.	        /*   
33.	            还没到期则重新计算到期时间，收到数据包的时候应该会重置定时器，   
34.	            所以执行该函数说明的确是超时了，按理说不会进入这里。   
35.	        */      
36.	        elapsed = keepalive_time_when(tp) - elapsed;      
37.	    }      
38.	      
39.	    TCP_CHECK_TIMER(sk);      
40.	    sk_stream_mem_reclaim(sk);      
41.	      
42.	resched:      
43.	    // 重新设置定时器      
44.	    tcp_reset_keepalive_timer (sk, elapsed);      
45.	...     
```

所以在SOL_SOCKET层面是设置是否开启keep-alive机制。如果开启了，就会设置定时器，超时的时候就会发送探测包。但是我们发现，SOL_SOCKET只是设置了是否开启探测机制，并没有定义上面三个配置的值，所以系统会使用默认值进行心跳机制（如果我们设置了开启keep-alive的话）。这就是为什么Libuv调了两次setsockopt函数。第二次的调用设置了就是上面三个配置中的第一个（后面两个也可以设置，不过Libuv没有提供接口，可以自己调用setsockopt设置）。那么我们来看一下Libuv的第二次调用setsockopt是做了什么。我们直接看TCP层的实现。

```
1.	// net\ipv4\tcp.c    
2.	int tcp_setsockopt(struct sock *sk, int level, int optname, char __user *optval,int optlen)    
3.	{    
4.	    ...    
5.	    case TCP_KEEPIDLE:    
6.	        // 修改多久没有收到数据包则发送探测包的配置    
7.	        tp->keepalive_time = val * HZ;    
8.	            // 是否开启了keep-alive机制    
9.	            if (sock_flag(sk, SOCK_KEEPOPEN) &&    
10.	                !((1 << sk->sk_state) &    
11.	                  (TCPF_CLOSE | TCPF_LISTEN))) {    
12.	                // 当前时间减去上次收到数据包的时候，即多久没有收到数据包了    
13.	                __u32 elapsed = tcp_time_stamp - tp->rcv_tstamp;    
14.	                // 算出还要多久可以发送探测包，还是可以直接发（已经触发了）    
15.	                if (tp->keepalive_time > elapsed)    
16.	                    elapsed = tp->keepalive_time - elapsed;    
17.	                else    
18.	                    elapsed = 0;    
19.	                // 设置定时器    
20.	                tcp_reset_keepalive_timer(sk, elapsed);    
21.	            }       
22.	        ...    
23.	}    
```

该函数首先修改配置，然后判断是否开启了keep-alive的机制，如果开启了，则重新设置定时器，超时的时候就会发送探测包。但是有一个问题是，心跳机制并不是什么时候都好使，如果两端都没有数据来往时，心跳机制能很好地工作，但是一旦本端有数据发送的时候，它就会抑制心跳机制。我们看一下Linux内核5.7.7的一段相关代码，如图17-3所示。  
![](https://img-blog.csdnimg.cn/3a9bf6abbf7c4035b774ee2e1396a254.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图17-3  
上面这一段是心跳机制中，定时器超时时，执行的一段逻辑，我们只需要关注红色框里的代码。一般来说，心跳定时器超时，操作系统会发送一个新的心跳包，但是如果发送队列里还有数据没有发送，那么操作系统会优先发送。或者发送出去的没有ack，也会优先触发重传。这时候心跳机制就失效了。对于这个问题，Linux提供了另一个属性TCP_USER_TIMEOUT。这个属性的功能是，发送了数据，多久没有收到ack后，操作系统就认为这个连接断开了。看一下相关代码，如图17-4所示。  
![](https://img-blog.csdnimg.cn/39db257731f74caaad5da6449fc46f8e.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图17-4  
下面是设置阈值的代码，如图17-5所示。  
![](https://img-blog.csdnimg.cn/1930c077bc48463f9539d353c7c3bbc6.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图17-5  
这是超时时判断是否断开连接的代码。我们看到有两个情况下操作系统会认为连接断开了。  
1 设置了TCP_USER_TIMEOUT时，如果发送包数量大于1并且当前时间距离上次收到包的时间间隔已经达到阈值。  
2 没有设置TCP_USER_TIMEOUT，但是心跳包发送数量达到阈值。  
所以我们可以同时设置这两个属性。保证心跳机制可以正常运行， Node.js的keep-alive有两个层面的内容，第一个是是否开启，第二个是开启后，使用的配置。Node.js的setKeepAlive就是做了这两件事情。只不过它只支持修改一个配置。Node.js只支持TCP_KEEPALIVE_TIME。另外我们可以通过一下代码判断配置的值。

```
1.	include <stdio.h>    
2.	#include <netinet/tcp.h>         
3.	    
4.	int main(int argc, const char *argv[])    
5.	{    
6.	    int sockfd;    
7.	    int optval;    
8.	    socklen_t optlen = sizeof(optval);    
9.	    
10.	    sockfd = socket(AF_INET, SOCK_STREAM, 0);    
11.	    getsockopt(sockfd, SOL_SOCKET, SO_KEEPALIVE, &optval, &optlen);    
12.	    printf("默认是否开启keep-alive：%d \n", optval);    
13.	    
14.	    getsockopt(sockfd, SOL_TCP, TCP_KEEPIDLE, &optval, &optlen);    
15.	    printf("多久没有收到数据包则发送探测包：%d seconds \n", optval);    
16.	    
17.	    getsockopt(sockfd, SOL_TCP, TCP_KEEPINTVL, &optval, &optlen);    
18.	    printf("多久发送一次探测包：%d seconds \n", optval);    
19.	    
20.	    getsockopt(sockfd, SOL_TCP, TCP_KEEPCNT, &optval, &optlen);    
21.	    printf("最多发送几个探测包就断开连接：%d \n", optval);    
22.	       
23.	    return 0;    
24.	}
```

输出如图17-6所示。  
![](https://img-blog.csdnimg.cn/f77f51efb0614a4ab743a97f6a4f92d9.png)  
图17-6
再看一下wireshark下的keepalive包，如图17-7所示。  
![](https://img-blog.csdnimg.cn/1bcd7cfe674642ec97dd6625a7d74612.png)  
图17-7  
## 17.4 allowHalfOpen
我们知道TCP连接在正常断开的时候，会走四次挥手的流程，在Node.js中，当收到对端发送过来的fin包时，回复ack后，默认会发送fin包给对端，以完成四次挥手。但是我们可能会有这样的场景，客户端发送完数据后，发送fin包表示自己没有数据可写了，只需要等待服务器返回。这时候如果服务器在收到fin包后，也回复fin，那就会有问题。在Node.js中提供了allowHalfOpen选项支持半关闭，我们知道TCP是全双工的，两端可以同时互相发送数据，allowHalfOpen相当于把一端关闭了，允许数据单向传输。我们看一下allowHalfOpen的实现。allowHalfOpen是属于Socket的选项。我们从Node.js收到一个fin包开始分析整个流程。首先在新建Socket对象的时候，注册对应事件。
socket.on('_socketEnd', onSocketEnd);  
当操作系统收到fin包的时候，会触发socket的可读事件，执行Node.js的读回调。Node.js执行读取的时候发现，读取已结束，因为对端发送了fin包。这时候会触发_socketEnd事件。我们看一下相关代码。

```
1.	function onSocketEnd() {  
2.	  // ...  
3.	  if (!this.allowHalfOpen) {  
4.	    this.write = writeAfterFIN;  
5.	    this.destroySoon();  
6.	  }  
7.	}  
```

allowHalfOpen默认是false。onSocketEnd首先设置write函数为writeAfterFIN，我们看看这时候如果我们写会怎样。我们会收到一个错误。

```
1.	function writeAfterFIN(chunk, encoding, cb) {  
2.	  var er = new Error('This socket has been ended by the other party');  
3.	  er.code = 'EPIPE';  
4.	  this.emit('error', er);  
5.	  if (typeof cb === 'function') {  
6.	    nextTick(this[async_id_symbol], cb, er);  
7.	  }  
8.	}  
```

设置完write后，接着Node.js会发送fin包。

```
1.	Socket.prototype.destroySoon = function() {  
2.	  // 关闭写流  
3.	  if (this.writable)  
4.	    this.end();  
5.	  // 关闭成功后销毁流  
6.	  if (this._writableState.finished)  
7.	    this.destroy();  
8.	  else  
9.	    this.once('finish', this.destroy);  
10.	};  
```

首先关闭写流，然后执行destroy函数销毁流。在destroy中会执行_destroy。_destroy会执行具体的关闭操作，即发送fin包。

```
1.	this._handle.close(() => {   
2.	  this.emit('close', isException);  
3.	});  
```

我们看到C++层的close。

```
1.	void HandleWrap::Close(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	  
4.	  HandleWrap* wrap;  
5.	  ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
6.	  // 关闭handle  
7.	  uv_close(wrap->handle_, OnClose);  
8.	  wrap->state_ = kClosing;  
9.	  // 执行回调，触发close事件  
10.	  if (args[0]->IsFunction()) {  
11.	    wrap->object()->Set(env->onclose_string(), args[0]);  
12.	    wrap->state_ = kClosingWithCallback;  
13.	  }  
14.	}  
```

我们继续往Libuv看。

```
1.	void uv_close(uv_handle_t* handle, uv_close_cb cb) {  
2.	  uv_loop_t* loop = handle->loop;  
3.	  
4.	  handle->close_cb = cb;  
5.	  switch (handle->type) {  
6.	    case UV_TCP:  
7.	      uv_tcp_close(loop, (uv_tcp_t*)handle);  
8.	      return;  
9.	  
10.	     // ...  
11.	  }  
12.	}  
```

uv_tcp_close会对close的封装，我们看tcp close的大致实现。

```
1.	static void tcp_close(struct sock *sk, int timeout)  
2.	{  
3.	      
4.	    // 监听型的socket要关闭建立的连接  
5.	    if(sk->state == TCP_LISTEN)  
6.	    {  
7.	        /* Special case */  
8.	        tcp_set_state(sk, TCP_CLOSE);  
9.	        // 关闭已经建立的连接  
10.	        tcp_close_pending(sk);  
11.	        release_sock(sk);  
12.	        return;  
13.	    }  
14.	  
15.	    struct sk_buff *skb;  
16.	    // 销毁接收队列中未处理的数据   
17.	    while((skb=skb_dequeue(&sk->receive_queue))!=NULL)  
18.	        kfree_skb(skb, FREE_READ);  
19.	    // 发送fin包
20.	    tcp_send_fin(sk);  
21.	    release_sock(sk);  
22.	}  
```

以上是Node.js中socket收到fin包时的默认处理流程，当我们设置allowHalfOpen为true的时候，就可以修改这个默认的行为，允许半关闭状态的连接。
## 17.5 server close
调用close可以关闭一个服务器，首先我们看一下Node.js文档关于close函数的解释
>Stops the server from accepting new connections and keeps existing connections. This function is asynchronous, the server is finally closed when all connections are ended and the server emits a 'close' event. The optional callback will be called once the 'close' event occurs. Unlike that event, it will be called with an Error as its only argument if the server was not open when it was closed.  

在Node.js中 ，当我们使用close关闭一个server时，server会等所有的连接关闭后才会触发close事件。我们看close的实现，一探究竟。

```
1.	Server.prototype.close = function(cb) {  
2.	  // 触发回调  
3.	  if (typeof cb === 'function') {  
4.	    if (!this._handle) {  
5.	      this.once('close', function close() {  
6.	        cb(new errors.Error('ERR_SERVER_NOT_RUNNING'));  
7.	      });  
8.	    } else {  
9.	      this.once('close', cb);  
10.	    }  
11.	  }  
12.	  // 关闭底层资源  
13.	  if (this._handle) {  
14.	    this._handle.close();  
15.	    this._handle = null;  
16.	  }  
17.	  // 判断是否需要立刻触发close事件  
18.	  this._emitCloseIfDrained();  
19.	  return this;  
20.	};  
```

close的代码比较简单，首先监听close事件，然后关闭server对应的handle，所以server不会再接收新的请求了。最后调用_emitCloseIfDrained，我们看一下这个函数是干嘛的。

```
1.	Server.prototype._emitCloseIfDrained = function() {  
2.	  // 还有连接或者handle非空说明handle还没有关闭，则先不触发close事件  
3.	  if (this._handle || this._connections) {  
4.	    return;  
5.	  }  
6.	  // 触发close事件  
7.	  const asyncId = this._handle ? this[async_id_symbol] : null;  
8.	  nextTick(asyncId, emitCloseNT, this);  
9.	};  
10.	  
11.	  
12.	function emitCloseNT(self) {  
13.	  self.emit('close');  
14.	}  
```

_emitCloseIfDrained中有一个拦截的判断，handle非空或者连接数非0。由之前的代码我们已经知道handle是null，但是如果这时候连接数非0，也不会触发close事件。那什么时候才会触发close事件呢？在socket的_destroy函数中我们找到修改连接数的逻辑。

```
1.	Socket.prototype._destroy = function(exception, cb) {  
2.	  ...  
3.	  // socket所属的server  
4.	  if (this._server) {  
5.	    // server下的连接数减一  
6.	    this._server._connections--;  
7.	    // 是否需要触发server的close事件，当所有的连接（socket）都关闭时才触发server的是close事件  
8.	    if (this._server._emitCloseIfDrained) {  
9.	      this._server._emitCloseIfDrained();  
10.	    }  
11.	  }  
12.	};  
```

我们看到每一个连接关闭的时候，都会导致连接数减一，直到为0的时候才会触发close事件。假设我们启动了一个服务器，接收到了一些客户端的请求，这时候，如果我们想修改一个代码发布，需要重启服务器，怎么办？假设我们有以下代码。
server.js

```
1.	const net = require('net');  
2.	const server = net.createServer().listen(80);  
```

client.js

```
1.	const net = require('net');  
2.	net.connect({port:80})  
```

如果我们直接杀死进程，那么存量的请求就会无法正常被处理。这会影响我们的服务质量。我们看一下Node.js如何在重启时优雅地退出，所谓优雅，即让Node.js进程处理完存量请求后再退出。Server的close的实现给了我们一些思路。我们可以监听server的close事件，等到触发close事件后才退出进程。

```
1.	const net = require('net');  
2.	const server = net.createServer().listen(80);  
3.	server.on('close', () => {  
4.	  process.exit();  
5.	});  
6.	// 防止进程提前挂掉  
7.	process.on('uncaughtException', () => {  
8.	  
9.	});  
10.	process.on('SIGINT', function() {  
11.	  server.close();  
12.	})  
```

我们首先监听SIGINT信号，当我们使用SIGINT信号杀死进程时，首先调用server.close，等到所有的连接断开，触发close时候时，再退出进程。我们首先开启服务器，然后开启两个客户端。接着按下ctrl+c，我们发现这时候服务器不会退出，然后我们关闭两个客户端，这时候server就会优雅地退出。
