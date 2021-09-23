
本章我们主要看一下Node.js中对TCP的封装，我们首先看一下在网络编程中，是如何编写一个服务器和客户端的（伪代码）。
服务器

```js
    const fd = socket();  
    bind(fd, ip, port);  
    listen(fd);  
    const acceptedFd = accept(fd);  
    handle(acceptedFd);  
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

```js
    const fd = socket();  
    const connectRet = connect(fd, ip, port);  
    write(fd, 'hello');  
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

```js
    function connect(...args) {  
      // 处理参数  
      var normalized = normalizeArgs(args);  
      var options = normalized[0];  
      // 申请一个socket表示一个客户端  
      var socket = new Socket(options);  
      // 设置超时，超时后会触发timeout，用户可以自定义处理超时逻辑
      if (options.timeout) {  
        socket.setTimeout(options.timeout);  
      }  
      // 调用socket的connect  
      return Socket.prototype.connect.call(socket, normalized);  
    }  
```

从代码中可以看到，connect函数是对Socket对象的封装。Socket表示一个TCP客户端。我们分成三部分分析。
 
```js
1 new Socket 
2 setTimeout 
3 Socket的connect
```

1 new Socket  
我们看看新建一个Socket对象，做了什么事情。  

```js
    function Socket(options) {  
      // 是否正在建立连接，即三次握手中  
      this.connecting = false;  
      // 触发close事件时，该字段标记是否由于错误导致了close  
      this._hadError = false;  
      // 对应的底层handle，比如tcp_wrap  
      this._handle = null;  
      // 定时器id  
      this[kTimeout] = null;  
      options = options || {};  
      // socket是双向流  
      stream.Duplex.call(this, options);  
      // 还不能读写，先设置成false，连接成功后再重新设置    
      this.readable = this.writable = false;  
        // 注册写端关闭的回调
      this.on('finish', onSocketFinish); 
        // 注册读端关闭的回调 
      this.on('_socketEnd', onSocketEnd);  
      // 是否允许半开关，默认不允许  
      this.allowHalfOpen = options && options.allowHalfOpen||false; 
    }  
```

Socket是对C++模块tcp_wrap的封装。主要是初始化了一些属性和监听一些事件。
2 setTimeout 	

```js
    Socket.prototype.setTimeout = function(msecs, callback) {  
      // 清除之前的，如果有的话  
      clearTimeout(this[kTimeout]);  
      // 0代表清除  
      if (msecs === 0) {  
        if (callback) {  
          this.removeListener('timeout', callback);  
        }  
      } else {  
        // 开启一个定时器，超时时间是msecs，超时回调是_onTimeout  
        this[kTimeout] = setUnrefTimeout(this._onTimeout.bind(this), msecs);  
        /*
              监听timeout事件，定时器超时时，底层会调用Node.js的回调，
              Node.js会调用用户的回调callback  
            */
        if (callback) {  
          this.once('timeout', callback);  
        }  
      }  
      return this;  
    };  
```

setTimeout做的事情就是设置一个超时时间，这个时间用于检测socket的活跃情况（比如有数据通信），当socket活跃时，Node.js会重置该定时器，如果socket一直不活跃则超时会触发timeout事件，从而执行Node.js的_onTimeout回调，在回调里再触发用户传入的回调。我们看一下超时处理函数_onTimeout。 

```js
    Socket.prototype._onTimeout = function() {  
      this.emit('timeout');  
    };
```

直接触发timeout函数，回调用户的函数。我们看到setTimeout只是设置了一个定时器，然后触发timeout事件，Node.js并没有帮我们做额外的操作，所以我们需要自己处理，比如关闭socket。

```js
    socket.setTimeout(10000);  
    socket.on('timeout', () => {  
      socket.close();  
    });  
```

另外我们看到这里是使用setUnrefTimeout设置的定时器，因为这一类定时器不应该阻止事件循环的退出。
3 connect函数 
在第一步我们已经创建了一个socket，接着我们调用该socket的connect函数开始发起连接。 

```js
    // 建立连接，即三次握手  
    Socket.prototype.connect = function(...args) {  
      let normalized;  
      /* 忽略参数处理 */  
      var options = normalized[0];  
      var cb = normalized[1]; 
        // TCP在tcp_wrap.cc中定义   
      this._handle = new TCP(TCPConstants.SOCKET); 
        // 有数据可读时的回调 
      this._handle.onread = onread;  
      // 连接成功时执行的回调  
      if (cb !== null) {  
        this.once('connect', cb);  
      }  
      // 正在连接  
      this.connecting = true;  
      this.writable = true;  
        // 重置定时器
        this._unrefTimer();
      // 可能需要DNS解析，解析成功再发起连接  
      lookupAndConnect(this, options);  
      return this;  
    };  
```

connect 函数主要是三个逻辑  
1 首先通过new TCP()创建一个底层的handle，比如我们这里是TCP（对应tcp_wrap.cc的实现）。   
2 设置一些回调   
3 做DNS解析（如果需要的话），然后发起三次握手。  
我们看一下new TCP意味着什么，我们看tcp_wrap.cc的实现  
```cpp
    void TCPWrap::New(const FunctionCallbackInfo<Value>& args) {  
      // 要以new TCP的形式调用  
      CHECK(args.IsConstructCall());  
      // 第一个入参是数字  
      CHECK(args[0]->IsInt32());  
      Environment* env = Environment::GetCurrent(args);  
      // 作为客户端还是服务器  
      int type_value = args[0].As<Int32>()->Value();  
      TCPWrap::SocketType type = static_cast<TCPWrap::SocketType>(type_value);  
      
      ProviderType provider;  
      switch (type) {  
        // 作为客户端，即发起连接方  
        case SOCKET:  
          provider = PROVIDER_TCPWRAP;  
          break;  
        // 作为服务器  
        case SERVER:  
          provider = PROVIDER_TCPSERVERWRAP;  
          break;  
        default:  
          UNREACHABLE();  
      }  
      new TCPWrap(env, args.This(), provider);  
    }  
```

new TCP对应到C++层，就是创建一个TCPWrap对象。并初始化对象中的handle_字段

```cpp
    TCPWrap::TCPWrap(Environment* env, 
                     Local<Object> object, 
                     ProviderType provider)  
        : ConnectionWrap(env, object, provider) {  
      int r = uv_tcp_init(env->event_loop(), &handle_);  
    }  
```

初始化完底层的数据结构后，我们继续看lookupAndConnect，lookupAndConnect主要是对参数进行校验，然后进行DNS解析（如果传的是域名的话），DNS解析成功后执行internalConnect

```js
    function internalConnect(  
      self,   
      // 需要连接的远端IP、端口  
      address,   
      port,   
      addressType,   
      /*
          用于和对端连接的本地IP、端口（如果不设置，
          则操作系统自己决定）  
        */
      localAddress,   
      localPort) {  
      var err;  
      /*
          如果传了本地的地址或端口，则TCP连接中的源IP
          和端口就是传的，否则由操作系统自己选
        */  
      if (localAddress || localPort) {  
          // IP v4  
        if (addressType === 4) {  
          localAddress = localAddress || '0.0.0.0';  
          // 绑定地址和端口到handle
          err = self._handle.bind(localAddress, localPort);  
        } else if (addressType === 6) {  
          localAddress = localAddress || '::';  
          err = self._handle.bind6(localAddress, localPort);  
        }  
      
        // 绑定是否成功  
        err = checkBindError(err, localPort, self._handle);  
        if (err) {  
          const ex = exceptionWithHostPort(err,
                                                    'bind', 
                                                    localAddress, 
                                                    localPort);  
          self.destroy(ex);  
          return;  
        }  
      }  
        // 对端的地址信息
      if (addressType === 6 || addressType === 4) {  
        // 新建一个请求对象，C++层定义  
        const req = new TCPConnectWrap();  
        // 设置一些列属性  
        req.oncomplete = afterConnect;  
        req.address = address;  
        req.port = port;  
        req.localAddress = localAddress;  
        req.localPort = localPort;  
        // 调用底层对应的函数  
        if (addressType === 4)  
          err = self._handle.connect(req, address, port);  
        else  
          err = self._handle.connect6(req, address, port);  
      }  
      /*
         非阻塞调用，可能在还没发起三次握手之前就报错了，
          而不是三次握手出错，这里进行出错处理  
        */
      if (err) {  
        // 获取socket对应的底层IP端口信息  
        var sockname = self._getsockname();  
        var details;  
      
        if (sockname) {  
          details = sockname.address + ':' + sockname.port;  
        }  
          // 构造错误信息，销魂socket并触发error事件
        const ex = exceptionWithHostPort(err, 
                                                'connect', 
                                                address, 
                                                port, 
                                                details);  
        self.destroy(ex);  
      }  
    }  
```

这里的代码比较多，除了错误处理外，主要的逻辑是bind和connect。bind函数的逻辑很简单（即使是底层的bind），它就是在底层的一个结构体上设置了两个字段的值。所以我们主要来分析connect。我们把关于connect的这段逻辑拎出来。  

```js
        const req = new TCPConnectWrap();  
        // 设置一些列属性  
        req.oncomplete = afterConnect;  
        req.address = address;  
        req.port = port;  
        req.localAddress = localAddress;  
        req.localPort = localPort;  
        // 调用底层对应的函数  
        self._handle.connect(req, address, port); 
```

 
TCPConnectWrap是C++层提供的类，connect对应C++层的Conenct，
前面的章节我们已经分析过，不再具体分析。连接完成后，回调函数是uv__stream_io。在uv__stream_io里会调用connect_req中的回调。假设连接建立，这时候就会执行C++层的AfterConnect。AfterConnect会执行JS层的afterConnect。 

```js
    // 连接后执行的回调，成功或失败  
    function afterConnect(status, handle, req, readable, writable) {   // handle关联的socket  
      var self = handle.owner;  
      // 连接过程中执行了socket被销毁了，则不需要继续处理  
      if (self.destroyed) {  
        return;  
      }  
      
      handle = self._handle;
     self.connecting = false;  
     self._sockname = null;  
     // 连接成功  
     if (status === 0) {  
        // 设置读写属性  
        self.readable = readable;  
        self.writable = writable;  
        // socket当前活跃，重置定时器  
        self._unrefTimer();  
        // 触发连接成功事件  
        self.emit('connect');  
        // socket可读并且没有设置暂停模式，则开启读  
        if (readable && !self.isPaused())  
          self.read(0);  
     } else {  
        // 连接失败，报错并销毁socket  
        self.connecting = false;  
        var details;  
        // 提示出错信息  
        if (req.localAddress && req.localPort) {  
          details = req.localAddress + ':' + req.localPort;  
        }  
        var ex = exceptionWithHostPort(status,  
                                       'connect',  
                                       req.address,  
                                       req.port,  
                                       details);  
        if (details) {  
          ex.localAddress = req.localAddress;  
          ex.localPort = req.localPort;  
        }  
        // 销毁socket  
        self.destroy(ex);  
      }  
    }  
```

一般情况下，连接成功后，JS层调用self.read(0)注册等待可读事件。
### 17.1.2 读操作
我们看一下socket的读操作逻辑，在连接成功后，socket会通过read函数在底层注册等待可读事件，等待底层事件驱动模块通知有数据可读。

```js
    Socket.prototype.read = function(n) {  
      if (n === 0)  
        return stream.Readable.prototype.read.call(this, n);  
      
      this.read = stream.Readable.prototype.read;  
      this._consuming = true;  
      return this.read(n);  
    };  
```

这里会执行Readable模块的read函数，从而执行_read函数，_read函数是由子类实现。所以我们看Socket的_read

```js
    Socket.prototype._read = function(n) {  
      // 还没建立连接，则建立后再执行  
      if (this.connecting || !this._handle) {  
        this.once('connect', () => this._read(n));  
      } else if (!this._handle.reading) {  
        this._handle.reading = true;  
        // 执行底层的readStart注册等待可读事件  
        var err = this._handle.readStart();  
        if (err)  
          this.destroy(errnoException(err, 'read'));  
      }  
    };  
```

但是我们发现tcp_wrap.cc没有readStart函数。一路往父类找，最终在stream_wrap.cc找到了该函数。

```cpp
    // 注册读事件  
    int LibuvStreamWrap::ReadStart() {  
      return uv_read_start(stream(), 
       [](uv_handle_t* handle,  
       size_t suggested_size,  
       uv_buf_t* buf) {  
      // 分配存储数据的内存  
      static_cast<LibuvStreamWrap*>(handle->data)->OnUvAlloc(suggested_size, buf);  
      },
      [](uv_stream_t* stream,ssize_t nread,const uv_buf_t* buf) {
       // 读取数据成功的回调  
       static_cast<LibuvStreamWrap*>(stream->data)->OnUvRead(nread, buf);  
      });  
    }  
```

uv_read_start函数在流章节已经分析过，作用就是注册等待可读事件，这里就不再深入。OnUvAlloc是分配存储数据的函数，我们可以不关注，我们看一下OnUvRead，当可读事件触发时会执行OnUvRead

```cpp
    void LibuvStreamWrap::OnUvRead(ssize_t nread, const uv_buf_t* buf) {  
      HandleScope scope(env()->isolate());  
      Context::Scope context_scope(env()->context());  
      // 触发onread事件  
      EmitRead(nread, *buf);  
    }  
```

OnUvRead函数触发onread回调。

```js
    function onread(nread, buffer) {  
      var handle = this;  
        // handle关联的socket
      var self = handle.owner; 
        // socket有数据到来，处于活跃状态，重置定时器 
        self._unrefTimer(); 
      // 成功读取数据  
      if (nread > 0) {  
        // push到流中  
        var ret = self.push(buffer);  
        /*
              push返回false，说明缓存的数据已经达到阈值，
              不能再触发读，需要注销等待可读事件  
            */
        if (handle.reading && !ret) {  
          handle.reading = false;  
          var err = handle.readStop();  
          if (err)  
            self.destroy(errnoException(err, 'read'));  
        }  
        return;  
      }  
      
      // 没有数据，忽略 
      if (nread === 0) {  
        debug('not any data, keep waiting');  
        return;  
      }  
      // 不等于结束，则读出错，销毁流  
      if (nread !== UV_EOF) {  
        return self.destroy(errnoException(nread, 'read'));  
      }  
      // 流结束了，没有数据读了  
      self.push(null);  
      /*
          也没有缓存的数据了，可能需要销毁流，比如是只读流，
          或者可读写流，写端也没有数据了，参考maybeDestroy  
        */
      if (self.readableLength === 0) {  
        self.readable = false;  
        maybeDestroy(self);  
      }  
      // 触发事件  
      self.emit('_socketEnd');  
    }  
```

socket可读事件触发时大概有下面几种情况  
1 有有效数据可读，push到流中，触发ondata事件通知用户。  
2 没有有效数据可读，忽略。  
3 读出错，销毁流  
4 读结束。  
我们分析一下4。在新建一个socket的时候注册了流结束的处理函数onSocketEnd。

```js
    // 读结束后执行的函数  
    function onSocketEnd() {  
      // 读结束标记  
      this._readableState.ended = true;  
      /* 
        已经触发过end事件，则判断是否需要销毁，可能还有写端 
      */
      if (this._readableState.endEmitted) {  
        this.readable = false;  
       maybeDestroy(this);  
     } else {  
       // 还没有触发end则等待触发end事件再执行下一步操作  
       this.once('end', function end() {  
         this.readable = false;  
         maybeDestroy(this);  
       });  
       /*
         执行read，如果流中没有缓存的数据则会触发end事件，
         否则等待消费完后再触发  
       */
       this.read(0);  
     }  
     /*
       1 读结束后，如果不允许半开关，则关闭写端，如果还有数据还没有发送
       完毕，则先发送完再关闭
       2 重置写函数，后续执行写的时候报错  
     */
     if (!this.allowHalfOpen) {  
       this.write = writeAfterFIN;  
       this.destroySoon();  
     }  
    }  
```

当socket的读端结束时，socket的状态变更分为几种情况  
1 如果可读流中还有缓存的数据，则等待读取。  
2 如果写端也结束了，则销毁流。  
3 如果写端没有结束，则判断allowHalfOpen是否允许半开关，不允许并且写端数据已经发送完毕则关闭写端。  
### 17.1.3 写操作
接着我们看一下在一个流上写的时候，逻辑是怎样的。Socket实现了单个写和批量写接口。

```js
    // 批量写  
    Socket.prototype._writev = function(chunks, cb) {  
      this._writeGeneric(true, chunks, '', cb);  
    };  
      
    // 单个写  
    Socket.prototype._write = function(data, encoding, cb) {  
      this._writeGeneric(false, data, encoding, cb);  
    };  
```

 _writeGeneric

```js
    Socket.prototype._writeGeneric = function(writev, data, encoding, cb) {  
      /*  
         正在连接，则先保存待写的数据，因为stream模块是串行写的， 
         所以第一次写没完成，不会执行第二次写操作（_write）， 
         所以这里用一个字段而不是一个数组或队列保存数据和编码， 
         因为有pendingData时_writeGeneric 不会被执行第二次，这里缓存 
         pendingData不是为了后续写入，而是为了统计写入的数据总数 
      */  
      if (this.connecting) {  
        this._pendingData = data;  
        this._pendingEncoding = encoding;  
        this.once('connect', function connect() {  
          this._writeGeneric(writev, data, encoding, cb);  
        });  
        return;  
      }  
      // 开始写，则清空之前缓存的数据  
      this._pendingData = null;  
      this._pendingEncoding = '';  
      // 写操作，有数据通信，刷新定时器  
      this._unrefTimer();  
      // 已经关闭，则销毁socket  
      if (!this._handle) {  
        this.destroy(new errors.Error('ERR_SOCKET_CLOSED'), cb);  
        return false;  
      }  
      // 新建一个写请求  
      var req = new WriteWrap();  
      req.handle = this._handle;  
      req.oncomplete = afterWrite;  
      // 是否同步执行写完成回调，取决于底层是同步写入，然后执行回调还是异步写入  
      req.async = false;  
      var err;  
      // 是否批量写  
      if (writev) {  
        // 所有数据都是buffer类型，则直接堆起来，否则需要保存编码类型  
        var allBuffers = data.allBuffers;  
        var chunks;  
        var i;  
        if (allBuffers) {  
          chunks = data;  
          for (i = 0; i < data.length; i++)  
            data[i] = data[i].chunk;  
        } else {  
          // 申请double个大小的数组  
          chunks = new Array(data.length << 1);  
          for (i = 0; i < data.length; i++) {  
            var entry = data[i];  
            chunks[i * 2] = entry.chunk;  
            chunks[i * 2 + 1] = entry.encoding;  
          }  
        }  
        err = this._handle.writev(req, chunks, allBuffers);  
      
        // Retain chunks  
        if (err === 0) req._chunks = chunks;  
      } else {  
        var enc;  
        if (data instanceof Buffer) {  
          enc = 'buffer';  
        } else {  
          enc = encoding;  
        }  
        err = createWriteReq(req, this._handle, data, enc);  
      }  
      
      if (err)  
        return this.destroy(errnoException(err, 'write', req.error), cb);  
      // 请求写入底层的数据字节长度  
      this._bytesDispatched += req.bytes;  
      // 在stream_base.cc中req_wrap_obj->Set(env->async(), True(env->isolate()));设置  
      if (!req.async) {  
        cb();  
        return;  
      }  
      
      req.cb = cb;  
      // 最后一次请求写数据的字节长度  
      this[kLastWriteQueueSize] = req.bytes;  
    };  
```

上面的代码很多，但是逻辑并不复杂，具体实现在stream_base.cc和stream_wrap.cc，这里不再展开分析，主要是执行writev和createWriteReq函数进行写操作。它们底层调用的都是uv_write2（需要传递文件描述符）或uv_write（不需要传递文件描述符）或者uv_try_write函数进行写操作。这里只分析一下async的意义，async默认是false，它表示的意义是执行底层写入时，底层是否同步执行回调，async为false说明写入完成回调是同步执行的。在stream_base.cc的写函数中有相关的逻辑。

```cpp
    err = DoWrite(req_wrap, buf_list, count, nullptr);  
    req_wrap_obj->Set(env->async(), True(env->isolate()));  
```

当执行DoWrite的时候，req_wrap中保存的回调可能会被Libuv同步执行，从而执行JS代码，这时候async是false（默认值），说明回调是被同步执行的，如果DoWrite没有同步执行回调。则说明是异步执行回调。设置async为true，再执行JS代码。
### 17.1.4 关闭写操作
当我们发送完数据后，我们可以通过调用socket对象的end函数关闭流的写端。我们看一下end的逻辑。

```js
    Socket.prototype.end = function(data, encoding, callback) {  
      stream.Duplex.prototype.end.call(this, 
                                           data, 
                                           encoding, 
                                           callback);  
      return this;  
    };  
```

Socket的end是调用的Duplex的end，而Duplex的end是继承于Writable的end。Writable的end最终会触发finish事件，socket在初始化的时候监听了该事件。

```js
    this.on('finish', onSocketFinish); 
```
我们看看onSocketFinish。
```js
    // 执行了end，并且数据发送完毕，则关闭写端  
    function onSocketFinish() {  
      // 还没连接成功就执行了end  
      if (this.connecting) {  
        return this.once('connect', onSocketFinish);  
      }  
      // 写结束了，如果也不能读或者读结束了，则销毁socket  
      if (!this.readable || this._readableState.ended) {  
        return this.destroy();  
      }  
      // 不支持shutdown则直接销毁  
      if (!this._handle || !this._handle.shutdown)  
        return this.destroy();  
      // 支持shutdown则执行关闭，并设置回调  
      var err = defaultTriggerAsyncIdScope(  
        this[async_id_symbol], shutdownSocket, this, afterShutdown  
      );  
      // 执行shutdown失败则直接销毁  
      if (err)  
        return this.destroy(errnoException(err, 'shutdown'));  
    }  
    
    // 发送关闭写端的请求  
    function shutdownSocket(self, callback) {  
      var req = new ShutdownWrap();  
      req.oncomplete = callback;  
      req.handle = self._handle;  
      return self._handle.shutdown(req);  
    }  
```

Shutdown函数在stream_base.cc中定义，最终调用uv_shutdown关闭流的写端，在Libuv流章节我们已经分析过。接着我们看一下关闭写端后，回调函数的逻辑。

```js
    // 关闭写端成功后的回调  
    function afterShutdown(status, handle, req) {  
      // handle关联的socket  
      var self = handle.owner;  
      // 已经销毁了，则不需要往下走了，否则执行销毁操作  
      if (self.destroyed)  
        return;  
      // 写关闭成功，并且读也结束了，则销毁socket，否则等待读结束再执行销毁  
      if (self._readableState.ended) {  
        self.destroy();  
      } else {  
        self.once('_socketEnd', self.destroy);  
      }  
    }  
```

### 17.1.5 销毁
当一个socket不可读也不可写的时候、被关闭、发生错误的时候，就会被销毁。销毁一个流就是销毁流的读端、写端。然后执行流子类的_destory函数。我们看一下socket的_destroy函数

```js
    // 销毁时执行的钩子函数，exception代表是否因为错误导致的销毁  
    Socket.prototype._destroy = function(exception, cb) {  
      this.connecting = false;  
      this.readable = this.writable = false;  
      // 清除定时器  
      for (var s = this; s !== null; s = s._parent) {  
        clearTimeout(s[kTimeout]);  
      }  
      
      if (this._handle) {  
        // 是否因为出错导致销毁流  
        var isException = exception ? true : false;    
        // 关闭底层handle  
        this._handle.close(() => {  
          // close事件的入参，表示是否因为错误导致的关闭  
          this.emit('close', isException);  
        });  
        this._handle.onread = noop;  
        this._handle = null;  
        this._sockname = null;  
      }  
      // 执行回调  
      cb(exception);  
      // socket所属的server，作为客户端时是null  
      if (this._server) {  
        // server下的连接数减一  
        this._server._connections--;  
        /*
          是否需要触发server的close事件，
          当所有的连接（socket）都关闭时才触发server的是close事件  
        */
        if (this._server._emitCloseIfDrained) {  
          this._server._emitCloseIfDrained();  
        }  
      }  
    };  
```
_stream_writable.js中的destroy函数只是修改读写流的状态和标记，子类需要定义_destroy函数销毁相关的资源，socket通过调用close关闭底层关联的资源，关闭后触发socket的close事件（回调函数的第一个参数是boolean类型，说明是否因为错误导致socket关闭）。最后判断该socket是否来自服务器创建的，是的话该服务器的连接数减一，如果服务器执行了close并且当前连接数为0，则关闭服务器。
## 17.2 TCP 服务器
net模块提供了createServer函数创建一个TCP服务器。

```js
    function createServer(options, connectionListener) {  
      return new Server(options, connectionListener);  
    }  
      
    function Server(options, connectionListener) {  
      EventEmitter.call(this);  
      // 注册连接到来时执行的回调  
      if (typeof options === 'function') {  
        connectionListener = options;  
        options = {};  
        this.on('connection', connectionListener);  
      } else if (options == null || typeof options === 'object') {  
        options = options || {};  
        if (typeof connectionListener === 'function') {  
          this.on('connection', connectionListener);  
        }  
      } else {  
        throw new errors.TypeError('ERR_INVALID_ARG_TYPE',  
                                   'options',  
                                   'Object',  
                                   options);  
      }  
      // 服务器建立的连接数  
      this._connections = 0;  
      this._handle = null;  
      this._unref = false;  
      // 服务器下的所有连接是否允许半连接  
      this.allowHalfOpen = options.allowHalfOpen || false;  
      // 有连接时是否注册读事件  
      this.pauseOnConnect = !!options.pauseOnConnect;  
    }  
```

createServer返回的就是一个一般的JS对象，接着调用listen函数监听端口。看一下listen函数的逻辑

```js
    Server.prototype.listen = function(...args) {  
      /*
         处理入参，根据文档我们知道listen可以接收好几个参数，
          假设我们这里是只传了端口号9297  
        */
      var normalized = normalizeArgs(args);  
      //  normalized = [{port: 9297}, null];  
      var options = normalized[0];  
      var cb = normalized[1];  
      // 第一次listen的时候会创建，如果非空说明已经listen过  
      if (this._handle) {  
        throw new errors.Error('ERR_SERVER_ALREADY_LISTEN');  
      }  
      // listen成功后执行的回调  
      var hasCallback = (cb !== null);  
      if (hasCallback) {  
        // listen成功的回调  
        this.once('listening', cb);  
      }  
        
      options = options._handle || options.handle || options;  
      // 第一种情况，传进来的是一个TCP服务器，而不是需要创建一个服务器  
      if (options instanceof TCP) {  
        this._handle = options;  
        this[async_id_symbol] = this._handle.getAsyncId();  
        listenIncluster(this, null, -1, -1, backlogFromArgs);  
        return this;  
      }  
      // 第二种，传进来一个对象，并且带了fd  
      if (typeof options.fd === 'number' && options.fd >= 0) {  
        listenIncluster(this, 
                            null, 
                            null, 
                            null, 
                            backlogFromArgs, 
                            options.fd);  
        return this;  
      }  
      // 创建一个tcp服务器  
      var backlog;  
      if (typeof options.port === 'number' || 
             typeof options.port === 'string') {  
        backlog = options.backlog || backlogFromArgs;  
        // 第三种 启动一个TCP服务器，传了host则先进行DNS解析
        if (options.host) {  
              lookupAndListen(this,
                              options.port | 0, 
                              options.host, 
                              backlog,
                              options.exclusive);  
        } else {
          listenIncluster(this, 
                                null, 
                                options.port | 0, 
                                4,      
                                backlog, 
                                undefined, 
                                options.exclusive);  
        }  
        return this;  
      }  
    };  
```

我们看到有三种情况，分别是传了一个服务器、传了一个fd、传了端口（或者host），但是我们发现，这几种情况最后都是调用了listenIncluster（lookupAndListen是先DNS解析后再执行listenIncluster），只是入参不一样，所以我们直接看listenIncluster。
```js
    function listenIncluster(server, 
                              address, 
                              port, 
                              addressType,      
                              backlog, 
                              fd, 
                              exclusive) {  
      exclusive = !!exclusive;  
      if (cluster === null) cluster = require('cluster'); 
      if (cluster.isMaster || exclusive) {  
        server._listen2(address, port, addressType, backlog, fd);
        return;  
      }  
    }  
```
因为我们是在主进程，所以直接执行_listen2，子进程的在cluster模块分析。_listen对应的函数是setupListenHandle

```js
    function setupListenHandle(address, port, addressType, backlog, fd) {  
      // 有handle则不需要创建了，否则创建一个底层的handle  
      if (this._handle) {  
          
      } else {  
        var rval = null;  
        // 没有传fd，则说明是监听端口和IP  
        if (!address && typeof fd !== 'number') {  
          rval = createServerHandle('::', port, 6, fd);  
          /*
                   返回number说明bind IPv6版本的handle失败，
                   回退到v4，否则说明支持IPv6  
                */
          if (typeof rval === 'number') {  
            // 赋值为null，才能走下面的createServerHandle  
            rval = null;  
            address = '0.0.0.0';  
            addressType = 4;  
          } else {  
            address = '::';  
            addressType = 6;  
          }  
        }  
        // 创建失败则继续创建  
        if (rval === null)  
          rval = createServerHandle(address, 
                                            port, 
                                            addressType, 
                                            fd);  
        // 还报错则说明创建服务器失败，报错  
        if (typeof rval === 'number') {  
          var error = exceptionWithHostPort(rval, 
                                                     'listen', 
                                                     address, 
                                                     port);  
          process.nextTick(emitErrorNT, this, error);  
          return;  
        }  
        this._handle = rval;  
      }  
      
      // 有完成三次握手的连接时执行的回调  
      this._handle.onconnection = onconnection;  
      this._handle.owner = this;  
      // 执行C++层listen  
      var err = this._handle.listen(backlog || 511);  
      // 出错则报错  
      if (err) {  
        var ex = exceptionWithHostPort(err, 
                                              'listen', 
                                              address, 
                                              port);  
        this._handle.close();  
        this._handle = null;  
        nextTick(this[async_id_symbol], emitErrorNT, this, ex);  
        return;  
      } 
      // 触发listen回调  
      nextTick(this[async_id_symbol], emitListeningNT, this);  
    }  
```

主要是调用createServerHandle创建一个handle，然后调用listen函数监听。我们先看createServerHandle

```js
    function createServerHandle(address, port, addressType, fd) {  
      var err = 0;  
      var handle;  
      
      var isTCP = false;  
      // 传了fd则根据fd创建一个handle  
      if (typeof fd === 'number' && fd >= 0) {  
        try {  
          handle = createHandle(fd, true);  
        } catch (e) {  
          return UV_EINVAL;  
        }  
        // 把fd存到handle中  
        handle.open(fd);  
        handle.readable = true;  
        handle.writable = true;  
        assert(!address && !port);  
        // 管道  
      } else if (port === -1 && addressType === -1) {  
        // 创建一个Unix域服务器  
        handle = new Pipe(PipeConstants.SERVER);  
      } else {  
        // 创建一个TCP服务器  
        handle = new TCP(TCPConstants.SERVER);  
        isTCP = true;  
      }  
      /*
          有地址或者IP说明是通过IP端口创建的TCP服务器，
           需要调bind绑定地址 
        */ 
      if (address || port || isTCP) {  
        // 没有地址，则优先绑定IPv6版本的本地地址  
        if (!address) {  
          // Try binding to IPv6 first  
          err = handle.bind6('::', port);  
          // 失败则绑定v4的  
          if (err) {  
            handle.close();  
            // Fallback to IPv4  
            return createServerHandle('0.0.0.0', port);  
          }  
        } else if (addressType === 6) { // IPv6或v4  
          err = handle.bind6(address, port);  
        } else {  
          err = handle.bind(address, port);  
        }  
      }  
      
      if (err) {  
        handle.close();  
        return err;  
      }  
      
      return handle;  
    }  
```

createServerHandle主要是调用createHandle创建一个handle然后执行bind函数。创建handle的方式有几种，直接调用C++层的函数或者通过fd创建。调用createHandle可以通过fd创建一个handle

```js
    // 通过fd创建一个handle，作为客户端或者服务器  
    function createHandle(fd, is_server) {  
      // 判断fd对应的类型  
      const type = TTYWrap.guessHandleType(fd);  
      // Unix域  
      if (type === 'PIPE') {  
        return new Pipe(  
          is_server ? PipeConstants.SERVER : PipeConstants.SOCKET      );  
      }  
      // tcp  
      if (type === 'TCP') {  
        return new TCP(  
          is_server ? TCPConstants.SERVER : TCPConstants.SOCKET  
        );  
      }  
      
      throw new errors.TypeError('ERR_INVALID_FD_TYPE', type);  
    }  
```

接着我们看一下bind函数的逻辑，

```cpp
    int uv__tcp_bind(uv_tcp_t* tcp,  
                     const struct sockaddr* addr,  
                     unsigned int addrlen,  
                     unsigned int flags) {  
      int err;  
      int on;  
      // 如果没有socket则创建一个，有判断是否设置了UV_HANDLE_BOUND，是则执行bind，否则不执行bind  
      err = maybe_new_socket(tcp, addr->sa_family, 0);  
      if (err)  
        return err;  
      
      on = 1;  
      // 设置在断开连接的2 msl内可以重用端口，所以Node.js服务器可以快速重启  
      if (setsockopt(tcp->io_watcher.fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on)))  
        return UV__ERR(errno);  
      errno = 0;  
      // 执行bind  
      if (bind(tcp->io_watcher.fd, addr, addrlen) && errno != EADDRINUSE) {  
        if (errno == EAFNOSUPPORT)  
          return UV_EINVAL;  
        return UV__ERR(errno);  
      }  
      // bind是否出错  
      tcp->delayed_error = UV__ERR(errno);  
      // 打上已经执行了bind的标记  
      tcp->flags |= UV_HANDLE_BOUND;  
      if (addr->sa_family == AF_INET6)  
        tcp->flags |= UV_HANDLE_IPV6;  
      
      return 0;  
    }  
```

执行完bind后，会继续执行listen，我们接着看listen函数做了什么。我们直接看tcp_wrap.cc的Listen。

```cpp
    void TCPWrap::Listen(const FunctionCallbackInfo<Value>& args) {  
      TCPWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap,  
                  args.Holder(),  
                  args.GetReturnValue().Set(UV_EBADF));  
      int backlog = args[0]->Int32Value();  
      int err = uv_listen(reinterpret_cast<uv_stream_t*>(&wrap->handle_),  
                  backlog,  
                  OnConnection);  
      args.GetReturnValue().Set(err);  
    }  
```

C++层几乎是透传到Libuv，Libuv的内容我们不再具体展开，当有三次握手的连接完成时，会执行OnConnection

```cpp
    template <typename WrapType, typename UVType>  
    void ConnectionWrap<WrapType, UVType>::OnConnection(uv_stream_t* handle, int status) {  
      // TCPWrap                   
      WrapType* wrap_data = static_cast<WrapType*>(handle->data);  
      Environment* env = wrap_data->env();  
      HandleScope handle_scope(env->isolate());  
      Context::Scope context_scope(env->context());  
      Local<Value> argv[] = {  
        Integer::New(env->isolate(), status),  
        Undefined(env->isolate())  
      };  
      
      if (status == 0) { 
        // 新建一个表示和客户端通信的对象,必填TCPWrap对象  
        Local<Object> client_obj = WrapType::Instantiate(env,wrap_data,WrapType::SOCKET);  
        WrapType* wrap;  
        // 解包出一个TCPWrap对象存到wrap  
        ASSIGN_OR_RETURN_UNWRAP(&wrap, client_obj);  
        uv_stream_t* client_handle = reinterpret_cast<uv_stream_t*>(&wrap->handle_);  
        // 把通信fd存储到client_handle中  
        if (uv_accept(handle, client_handle))  
          return;  
        argv[1] = client_obj;  
      }  
      // 回调上层的onconnection函数  
      wrap_data->MakeCallback(env->onconnection_string(), arraysize(argv), argv);  
    }  
```

当建立了新连接时，操作系统会新建一个socket表示，同样，在Node.js层，也会新建一个对应的对象表示和客户端的通信，接着我们看JS层回调。

```js
    // clientHandle代表一个和客户端建立TCP连接的实体  
    function onconnection(err, clientHandle) {  
      var handle = this;  
      var self = handle.owner;  
      // 错误则触发错误事件  
      if (err) {  
        self.emit('error', errnoException(err, 'accept'));  
        return;  
      }  
      // 建立过多，关掉  
      if (self.maxConnections && self._connections >= self.maxConnections) {  
        clientHandle.close();  
        return;  
      }  
      //新建一个socket用于通信  
      var socket = new Socket({  
        handle: clientHandle,  
        allowHalfOpen: self.allowHalfOpen,  
        pauseOnCreate: self.pauseOnConnect  
      });  
      socket.readable = socket.writable = true;  
      // 服务器的连接数加一  
      self._connections++;  
      socket.server = self;  
      socket._server = self;  
      // 触发用户层连接事件  
      self.emit('connection', socket); 
    } 
```

在JS层也会封装一个Socket对象用于管理和客户端的通信，接着触发connection事件。剩下的事情就是应用层处理了。
## 17.3 keepalive
本节分析基于TCP层的长连接问题，相比应用层HTTP协议的长连接，TCP层提供的功能更多。TCP层定义了三个配置。  
1 多久没有收到数据包，则开始发送探测包。  
2 每隔多久，再次发送探测包。  
3 发送多少个探测包后，就断开连接。  
我们看Linux内核代码里提供的配置。

```cpp
    // 多久没有收到数据就发起探测包  
    #define TCP_KEEPALIVE_TIME  (120*60*HZ) /* two hours */  
    // 探测次数  
    #define TCP_KEEPALIVE_PROBES  9   /* Max of 9 keepalive probes*/  
    // 每隔多久探测一次  
    #define TCP_KEEPALIVE_INTVL (75*HZ)  
```

这是Linux提供的默认值。下面再看看阈值

```cpp
    #define MAX_TCP_KEEPIDLE    32767  
    #define MAX_TCP_KEEPINTVL   32767  
    #define MAX_TCP_KEEPCNT     127  
```

这三个配置和上面三个一一对应。是上面三个配置的阈值。我们看一下Node.js中keep-alive的使用。
socket.setKeepAlive([enable][, initialDelay])  
enable：是否开启keep-alive，Linux下默认是不开启的。
initialDelay：多久没有收到数据包就开始发送探测包。
接着我们看看这个API在Libuv中的实现。

```cpp
    int uv__tcp_keepalive(int fd, int on, unsigned int delay) {    
        if (setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &on, sizeof(on)))   
          return UV__ERR(errno);    
        // Linux定义了这个宏    
        #ifdef TCP_KEEPIDLE    
          /*  
              on是1才会设置，所以如果我们先开启keep-alive，并且设置delay，  
              然后关闭keep-alive的时候，是不会修改之前修改过的配置的。  
              因为这个配置在keep-alive关闭的时候是没用的  
          */    
          if (on && setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &delay, sizeof(delay)))    
            return UV__ERR(errno);    
        #endif    
        
        return 0;    
    }    
```

我们看到Libuv调用了同一个系统函数两次。我们分别看一下这个函数的意义。参考Linux2.6.13.1的代码。

```c
    // net\socket.c    
    asmlinkage long sys_setsockopt(int fd, int level, int optname, char __user *optval, int optlen)    
    {    
        int err;    
        struct socket *sock;    
      
        if ((sock = sockfd_lookup(fd, &err))!=NULL)    
        {    
            ...    
            if (level == SOL_SOCKET)    
                err=sock_setsockopt(sock,level,optname,optval,optlen);    
            else    
              err=sock->ops->setsockopt(sock, level, optname, optval, optlen);    
            sockfd_put(sock);    
        }    
        return err;    
    }    
```

当level是SOL_SOCKET代表修改的socket层面的配置。IPPROTO_TCP是修改TCP层的配置（该版本代码里是SOL_TCP）。我们先看SOL_SOCKET层面的。

```c
    // net\socket.c -> net\core\sock.c -> net\ipv4\tcp_timer.c    
    int sock_setsockopt(struct socket *sock, int level, int optname,    
                char __user *optval, int optlen) {    
        ...    
        case SO_KEEPALIVE:    
        
                if (sk->sk_protocol == IPPROTO_TCP)    
                    tcp_set_keepalive(sk, valbool);    
                // 设置SOCK_KEEPOPEN标记位1    
                sock_valbool_flag(sk, SOCK_KEEPOPEN, valbool);    
                break;    
        ...    
    }   
```

sock_setcsockopt首先调用了tcp_set_keepalive函数，然后给对应socket的SOCK_KEEPOPEN字段打上标记（0或者1表示开启还是关闭）。接下来我们看tcp_set_keepalive  

```c
    void tcp_set_keepalive(struct sock *sk, int val)    
    {    
        if ((1 << sk->sk_state) & (TCPF_CLOSE | TCPF_LISTEN))    
            return;    
        /*  
            如果val是1并且之前是0（没开启）那么就开启计时，超时后发送探测包，  
            如果之前是1，val又是1，则忽略，所以重复设置是无害的  
        */    
        if (val && !sock_flag(sk, SOCK_KEEPOPEN))    
            tcp_reset_keepalive_timer(sk, keepalive_time_when(tcp_sk(sk)));    
        else if (!val)    
            // val是0表示关闭，则清除定时器，就不发送探测包了    
            tcp_delete_keepalive_timer(sk);    
    }   
```

我们看看超时后的逻辑。  

```cpp
    // 多久没有收到数据包则发送第一个探测包      
    static inline int keepalive_time_when(const struct tcp_sock *tp)      
    {      
        // 用户设置的（TCP_KEEPIDLE）和系统默认的      
        return tp->keepalive_time ? : sysctl_tcp_keepalive_time;      
    }      
    // 隔多久发送一个探测包      
    static inline int keepalive_intvl_when(const struct tcp_sock *tp)      
    {      
        return tp->keepalive_intvl ? : sysctl_tcp_keepalive_intvl;      
    }      
          
    static void tcp_keepalive_timer (unsigned long data)      
    {      
    ...      
    // 多久没有收到数据包了      
    elapsed = tcp_time_stamp - tp->rcv_tstamp;      
        // 是否超过了阈值      
        if (elapsed >= keepalive_time_when(tp)) {      
            // 发送的探测包个数达到阈值，发送重置包      
            if ((!tp->keepalive_probes && tp->probes_out >= sysctl_tcp_keepalive_probes) ||      
                 (tp->keepalive_probes && tp->probes_out >= tp->keepalive_probes)) {      
                tcp_send_active_reset(sk, GFP_ATOMIC);      
                tcp_write_err(sk);      
                goto out;      
            }      
            // 发送探测包，并计算下一个探测包的发送时间（超时时间）      
            tcp_write_wakeup(sk)      
                tp->probes_out++;      
                elapsed = keepalive_intvl_when(tp);      
        } else {      
            /*   
                还没到期则重新计算到期时间，收到数据包的时候应该会重置定时器，   
                所以执行该函数说明的确是超时了，按理说不会进入这里。   
            */      
            elapsed = keepalive_time_when(tp) - elapsed;      
        }      
          
        TCP_CHECK_TIMER(sk);      
        sk_stream_mem_reclaim(sk);      
          
    resched:      
        // 重新设置定时器      
        tcp_reset_keepalive_timer (sk, elapsed);      
    ...     
```

所以在SOL_SOCKET层面是设置是否开启keep-alive机制。如果开启了，就会设置定时器，超时的时候就会发送探测包。但是我们发现，SOL_SOCKET只是设置了是否开启探测机制，并没有定义上面三个配置的值，所以系统会使用默认值进行心跳机制（如果我们设置了开启keep-alive的话）。这就是为什么Libuv调了两次setsockopt函数。第二次的调用设置了就是上面三个配置中的第一个（后面两个也可以设置，不过Libuv没有提供接口，可以自己调用setsockopt设置）。那么我们来看一下Libuv的第二次调用setsockopt是做了什么。我们直接看TCP层的实现。

```cpp
    // net\ipv4\tcp.c    
    int tcp_setsockopt(struct sock *sk, int level, int optname, char __user *optval,int optlen)    
    {    
        ...    
        case TCP_KEEPIDLE:    
            // 修改多久没有收到数据包则发送探测包的配置    
            tp->keepalive_time = val * HZ;    
                // 是否开启了keep-alive机制    
                if (sock_flag(sk, SOCK_KEEPOPEN) &&    
                    !((1 << sk->sk_state) &    
                      (TCPF_CLOSE | TCPF_LISTEN))) {    
                    // 当前时间减去上次收到数据包的时候，即多久没有收到数据包了    
                    __u32 elapsed = tcp_time_stamp - tp->rcv_tstamp;    
                    // 算出还要多久可以发送探测包，还是可以直接发（已经触发了）    
                    if (tp->keepalive_time > elapsed)    
                        elapsed = tp->keepalive_time - elapsed;    
                    else    
                        elapsed = 0;    
                    // 设置定时器    
                    tcp_reset_keepalive_timer(sk, elapsed);    
                }       
            ...    
    }    
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

```cpp
    include <stdio.h>    
    #include <netinet/tcp.h>         
        
    int main(int argc, const char *argv[])    
    {    
        int sockfd;    
        int optval;    
        socklen_t optlen = sizeof(optval);    
        
        sockfd = socket(AF_INET, SOCK_STREAM, 0);    
        getsockopt(sockfd, SOL_SOCKET, SO_KEEPALIVE, &optval, &optlen);    
        printf("默认是否开启keep-alive：%d \n", optval);    
        
        getsockopt(sockfd, SOL_TCP, TCP_KEEPIDLE, &optval, &optlen);    
        printf("多久没有收到数据包则发送探测包：%d seconds \n", optval);    
        
        getsockopt(sockfd, SOL_TCP, TCP_KEEPINTVL, &optval, &optlen);    
        printf("多久发送一次探测包：%d seconds \n", optval);    
        
        getsockopt(sockfd, SOL_TCP, TCP_KEEPCNT, &optval, &optlen);    
        printf("最多发送几个探测包就断开连接：%d \n", optval);    
           
        return 0;    
    }
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

```js
    function onSocketEnd() {  
      // ...  
      if (!this.allowHalfOpen) {  
        this.write = writeAfterFIN;  
        this.destroySoon();  
      }  
    }  
```

allowHalfOpen默认是false。onSocketEnd首先设置write函数为writeAfterFIN，我们看看这时候如果我们写会怎样。我们会收到一个错误。

```js
    function writeAfterFIN(chunk, encoding, cb) {  
      var er = new Error('This socket has been ended by the other party');  
      er.code = 'EPIPE';  
      this.emit('error', er);  
      if (typeof cb === 'function') {  
        nextTick(this[async_id_symbol], cb, er);  
      }  
    }  
```

设置完write后，接着Node.js会发送fin包。

```js
    Socket.prototype.destroySoon = function() {  
      // 关闭写流  
      if (this.writable)  
        this.end();  
      // 关闭成功后销毁流  
      if (this._writableState.finished)  
        this.destroy();  
      else  
        this.once('finish', this.destroy);  
    };  
```

首先关闭写流，然后执行destroy函数销毁流。在destroy中会执行_destroy。_destroy会执行具体的关闭操作，即发送fin包。

```
    this._handle.close(() => {   
      this.emit('close', isException);  
    });  
```

我们看到C++层的close。

```cpp
    void HandleWrap::Close(const FunctionCallbackInfo<Value>& args) {  
      Environment* env = Environment::GetCurrent(args);  
      
      HandleWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
      // 关闭handle  
      uv_close(wrap->handle_, OnClose);  
      wrap->state_ = kClosing;  
      // 执行回调，触发close事件  
      if (args[0]->IsFunction()) {  
        wrap->object()->Set(env->onclose_string(), args[0]);  
        wrap->state_ = kClosingWithCallback;  
      }  
    }  
```

我们继续往Libuv看。

```cpp
    void uv_close(uv_handle_t* handle, uv_close_cb cb) {  
      uv_loop_t* loop = handle->loop;  
      
      handle->close_cb = cb;  
      switch (handle->type) {  
        case UV_TCP:  
          uv_tcp_close(loop, (uv_tcp_t*)handle);  
          return;  
      
         // ...  
      }  
    }  
```

uv_tcp_close会对close的封装，我们看tcp close的大致实现。

```cpp
    static void tcp_close(struct sock *sk, int timeout)  
    {  
          
        // 监听型的socket要关闭建立的连接  
        if(sk->state == TCP_LISTEN)  
        {  
            /* Special case */  
            tcp_set_state(sk, TCP_CLOSE);  
            // 关闭已经建立的连接  
            tcp_close_pending(sk);  
            release_sock(sk);  
            return;  
        }  
      
        struct sk_buff *skb;  
        // 销毁接收队列中未处理的数据   
        while((skb=skb_dequeue(&sk->receive_queue))!=NULL)  
            kfree_skb(skb, FREE_READ);  
        // 发送fin包
        tcp_send_fin(sk);  
        release_sock(sk);  
    }  
```

以上是Node.js中socket收到fin包时的默认处理流程，当我们设置allowHalfOpen为true的时候，就可以修改这个默认的行为，允许半关闭状态的连接。
## 17.5 server close
调用close可以关闭一个服务器，首先我们看一下Node.js文档关于close函数的解释
>Stops the server from accepting new connections and keeps existing connections. This function is asynchronous, the server is finally closed when all connections are ended and the server emits a 'close' event. The optional callback will be called once the 'close' event occurs. Unlike that event, it will be called with an Error as its only argument if the server was not open when it was closed.  

在Node.js中 ，当我们使用close关闭一个server时，server会等所有的连接关闭后才会触发close事件。我们看close的实现，一探究竟。

```js
    Server.prototype.close = function(cb) {  
      // 触发回调  
      if (typeof cb === 'function') {  
        if (!this._handle) {  
          this.once('close', function close() {  
            cb(new errors.Error('ERR_SERVER_NOT_RUNNING'));  
          });  
        } else {  
          this.once('close', cb);  
        }  
      }  
      // 关闭底层资源  
      if (this._handle) {  
        this._handle.close();  
        this._handle = null;  
      }  
      // 判断是否需要立刻触发close事件  
      this._emitCloseIfDrained();  
      return this;  
    };  
```

close的代码比较简单，首先监听close事件，然后关闭server对应的handle，所以server不会再接收新的请求了。最后调用_emitCloseIfDrained，我们看一下这个函数是干嘛的。

```js
    Server.prototype._emitCloseIfDrained = function() {  
      // 还有连接或者handle非空说明handle还没有关闭，则先不触发close事件  
      if (this._handle || this._connections) {  
        return;  
      }  
      // 触发close事件  
      const asyncId = this._handle ? this[async_id_symbol] : null;  
      nextTick(asyncId, emitCloseNT, this);  
    };  
      
      
    function emitCloseNT(self) {  
      self.emit('close');  
    }  
```

_emitCloseIfDrained中有一个拦截的判断，handle非空或者连接数非0。由之前的代码我们已经知道handle是null，但是如果这时候连接数非0，也不会触发close事件。那什么时候才会触发close事件呢？在socket的_destroy函数中我们找到修改连接数的逻辑。

```js
    Socket.prototype._destroy = function(exception, cb) {  
      ...  
      // socket所属的server  
      if (this._server) {  
        // server下的连接数减一  
        this._server._connections--;  
        // 是否需要触发server的close事件，当所有的连接（socket）都关闭时才触发server的是close事件  
        if (this._server._emitCloseIfDrained) {  
          this._server._emitCloseIfDrained();  
        }  
      }  
    };  
```

我们看到每一个连接关闭的时候，都会导致连接数减一，直到为0的时候才会触发close事件。假设我们启动了一个服务器，接收到了一些客户端的请求，这时候，如果我们想修改一个代码发布，需要重启服务器，怎么办？假设我们有以下代码。
server.js

```js
    const net = require('net');  
    const server = net.createServer().listen(80);  
```

client.js

```
    const net = require('net');  
    net.connect({port:80})  
```

如果我们直接杀死进程，那么存量的请求就会无法正常被处理。这会影响我们的服务质量。我们看一下Node.js如何在重启时优雅地退出，所谓优雅，即让Node.js进程处理完存量请求后再退出。Server的close的实现给了我们一些思路。我们可以监听server的close事件，等到触发close事件后才退出进程。

```js
    const net = require('net');  
    const server = net.createServer().listen(80);  
    server.on('close', () => {  
      process.exit();  
    });  
    // 防止进程提前挂掉  
    process.on('uncaughtException', () => {  
      
    });  
    process.on('SIGINT', function() {  
      server.close();  
    })  
```

我们首先监听SIGINT信号，当我们使用SIGINT信号杀死进程时，首先调用server.close，等到所有的连接断开，触发close时候时，再退出进程。我们首先开启服务器，然后开启两个客户端。接着按下ctrl+c，我们发现这时候服务器不会退出，然后我们关闭两个客户端，这时候server就会优雅地退出。
