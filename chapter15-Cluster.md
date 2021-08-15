
Node.js是单进程单线程的应用，这种架构带来的缺点是不能很好地利用多核的能力，因为一个线程同时只能在一个核上执行。child_process模块一定程度地解决了这个问题，child_process模块使得Node.js应用可以在多个核上执行，而cluster模块在child_process模块的基础上使得多个进程可以监听的同一个端口，实现服务器的多进程架构。本章分析cluster模块的使用和原理。

## 15.1 cluster使用例子
我们首先看一下cluster的一个使用例子。

```
1.	const cluster = require('cluster');  
2.	const http = require('http');  
3.	const numCPUs = require('os').cpus().length;  
4.	  
5.	if (cluster.isMaster) {  
6.	  for (let i = 0; i < numCPUs; i++) {  
7.	    cluster.fork();  
8.	  }  
9.	} else {  
10.	  http.createServer((req, res) => {  
11.	    res.writeHead(200);  
12.	    res.end('hello world\n');  
13.	  }).listen(8888);  
14.	}  
```

以上代码在第一次执行的时候，cluster.isMaster为true，说明是主进程，然后通过fork调用创建一个子进程，在子进程里同样执行以上代码，但是cluster.isMaster为false，从而执行else的逻辑，我们看到每个子进程都会监听8888这个端口但是又不会引起EADDRINUSE错误。下面我们来分析一下具体的实现。
## 15.2 主进程初始化
我们先看主进程时的逻辑。我们看一下require(‘cluster’)的时候，Node.js是怎么处理的。

```
1.	const childOrMaster = 'NODE_UNIQUE_ID' in process.env ? 'child' : 'master';  
2.	module.exports = require(`internal/cluster/${childOrMaster}`)  
```

我们看到Node.js会根据当前环境变量的值加载不同的模块，后面我们会看到NODE_UNIQUE_ID是主进程给子进程设置的，在主进程中，NODE_UNIQUE_ID是不存在的，所以主进程时，会加载master模块。

```
1.	cluster.isWorker = false;  
2.	cluster.isMaster = true; 
3.	// 调度策略  
4.	cluster.SCHED_NONE = SCHED_NONE;    
5.	cluster.SCHED_RR = SCHED_RR;     
6.	// 调度策略的选择   
7.	let schedulingPolicy = {  
8.	  'none': SCHED_NONE,  
9.	  'rr': SCHED_RR  
10.	}[process.env.NODE_CLUSTER_SCHED_POLICY];  
11.	  
12.	if (schedulingPolicy === undefined) {  
13.	  schedulingPolicy = (process.platform === 'win32') ? 
14.	                       SCHED_NONE : SCHED_RR;  
15.	}  
16.	  
17.	cluster.schedulingPolicy = schedulingPolicy;  
18.	// 创建子进程  
19.	cluster.fork = function(env) {  
20.	  // 参数处理
21.	  cluster.setupMaster();  
22.	  const id = ++ids;  
23.	  // 调用child_process模块的fork
24.	  const workerProcess = createWorkerProcess(id, env);  
25.	  const worker = new Worker({  
26.	    id: id,  
27.	    process: workerProcess  
28.	  });  
29.	  // ...  
30.	  worker.process.on('internalMessage', internal(worker, onmessage));  
31.	  process.nextTick(emitForkNT, worker);  
32.	  cluster.workers[worker.id] = worker;  
33.	  return worker;  
34.	};  
35.	  
36.	  
```

cluster.fork是对child_process模块fork的封装，每次cluster.fork的时候，就会新建一个子进程，所以cluster下面会有多个子进程，Node.js提供的工作模式有轮询和共享两种，下面会具体介绍。Worker是对子进程的封装，通过process持有子进程的实例，并通过监听internalMessage和message事件完成主进程和子进程的通信，internalMessage这是Node.js定义的内部通信事件，处理函数是internal(worker, onmessage)。我们先看一下internal。

```
1.	const callbacks = new Map();  
2.	let seq = 0;  
3.	  
4.	function internal(worker, cb) {  
5.	  return function onInternalMessage(message, handle) {  
6.	    if (message.cmd !== 'NODE_CLUSTER')  
7.	      return;  
8.	  
9.	    let fn = cb;  
10.	  
11.	    if (message.ack !== undefined) {  
12.	      const callback = callbacks.get(message.ack);  
13.	  
14.	      if (callback !== undefined) {  
15.	        fn = callback;  
16.	        callbacks.delete(message.ack);  
17.	      }  
18.	    }  
19.	  
20.	    fn.apply(worker, arguments);  
21.	  };  
22.	}  
```

internal函数对异步消息通信做了一层封装，因为进程间通信是异步的，当我们发送多个消息后，如果收到一个回复，我们无法辨别出该回复是针对哪一个请求的，Node.js通过seq的方式对每一个请求和响应做了一个编号，从而区分响应对应的请求。接着我们看一下message的实现。

```
1.	function onmessage(message, handle) {  
2.	  const worker = this;  
3.	  
4.	  if (message.act === 'online')  
5.	    online(worker);  
6.	  else if (message.act === 'queryServer')  
7.	    queryServer(worker, message);  
8.	  else if (message.act === 'listening')  
9.	    listening(worker, message);  
10.	  else if (message.act === 'exitedAfterDisconnect')  
11.	    exitedAfterDisconnect(worker, message);  
12.	  else if (message.act === 'close')  
13.	    close(worker, message);  
14.	}  
```

onmessage根据收到消息的不同类型进行相应的处理。后面我们再具体分析。至此，主进程的逻辑就分析完了。
## 15.3 子进程初始化
我们来看一下子进程的逻辑。当执行子进程时，会加载child模块。

```
1.	const cluster = new EventEmitter();  
2.	const handles = new Map();  
3.	const indexes = new Map();  
4.	const noop = () => {};  
5.	  
6.	module.exports = cluster;  
7.	  
8.	cluster.isWorker = true;  
9.	cluster.isMaster = false;  
10.	cluster.worker = null;  
11.	cluster.Worker = Worker;  
12.	  
13.	cluster._setupWorker = function() {  
14.	  const worker = new Worker({  
15.	    id: +process.env.NODE_UNIQUE_ID | 0,  
16.	    process: process,  
17.	    state: 'online'  
18.	  });  
19.	  
20.	  cluster.worker = worker;  
21.	  
22.	  process.on('internalMessage', internal(worker, onmessage));  
23.	  // 通知主进程子进程启动成功  
24.	  send({ act: 'online' });  
25.	  
26.	  function onmessage(message, handle) {  
27.	    if (message.act === 'newconn')  
28.	      onconnection(message, handle);  
29.	    else if (message.act === 'disconnect')  
30.	      _disconnect.call(worker, true);  
31.	  }  
32.	};  
```

_setupWorker函数在子进程初始化时被执行，和主进程类似，子进程的逻辑也不多，监听internalMessage事件，并且通知主线程自己启动成功。
## 15.4 http.createServer的处理
主进程和子进程执行完初始化代码后，子进程开始执行业务代码http.createServer，在HTTP模块章节我们已经分析过http.createServer的过程，这里就不具体分析，我们知道http.createServer最后会调用net模块的listen，然后调用listenIncluster。我们从该函数开始分析。

```
1.	function listenIncluster(server, address, port, addressType,  
2.	                         backlog, fd, exclusive, flags) {  
3.	    
4.	  const serverQuery = {  
5.	    address: address,  
6.	    port: port,  
7.	    addressType: addressType,  
8.	    fd: fd,  
9.	    flags,  
10.	  };  
11.	  
12.	  cluster._getServer(server, serverQuery, listenOnMasterHandle);    
13.	  function listenOnMasterHandle(err, handle) {  
14.	    err = checkBindError(err, port, handle);  
15.	  
16.	    if (err) {  
17.	      const ex = exceptionWithHostPort(err,
18.	                                           'bind', 
19.	                                           address, 
20.	                                           port);  
21.	      return server.emit('error', ex);  
22.	    }  
23.	   
24.	    server._handle = handle;  
25.	    server._listen2(address,
26.	                      port, 
27.	                      addressType, 
28.	                      backlog, 
29.	                      fd, 
30.	                      flags);  
31.	  }  
32.	}  
```

listenIncluster函数会调用子进程cluster模块的_getServer。

```
1.	cluster._getServer = function(obj, options, cb) {  
2.	  let address = options.address;  
3.	   
4.	  // 忽略index的处理逻辑
5.	  
6.	  const message = {  
7.	    act: 'queryServer',  
8.	    index,  
9.	    data: null,  
10.	    ...options  
11.	  };  
12.	  
13.	  message.address = address;  
14.	  // 给主进程发送消息  
15.	  send(message, (reply, handle) => {  
16.	    // 根据不同模式做处理
17.	    if (handle)  
18.	      shared(reply, handle, indexesKey, cb);  
19.	    else  
20.	      rr(reply, indexesKey, cb);             
21.	  });  
22.	};  
```

_getServer会给主进程发送一个queryServer的请求。我们看一下send函数。

```
1.	function send(message, cb) {  
2.	  return sendHelper(process, message, null, cb);  
3.	}  
4.	  
5.	function sendHelper(proc, message, handle, cb) {  
6.	  if (!proc.connected)  
7.	    return false;  
8.	  
9.	  message = { cmd: 'NODE_CLUSTER', ...message, seq };  
10.	  
11.	 if (typeof cb === 'function')  
12.	   callbacks.set(seq, cb);  
13.	  
14.	 seq += 1;  
15.	 return proc.send(message, handle);  
16.	}  
```

send调用了sendHelper，sendHelper是对异步请求做了一个封装，我们看一下主进程是如何处理queryServer请求的。

```
1.	function queryServer(worker, message) {  
2.	  const key = `${message.address}:${message.port}:${message.addressType}:` +  `${message.fd}:${message.index}`;  
3.	  let handle = handles.get(key);  
4.	  
5.	  if (handle === undefined) {  
6.	    let address = message.address;  
7.	    let constructor = RoundRobinHandle;  
8.	    // 根据策略选取不同的构造函数  
9.	    if (schedulingPolicy !== SCHED_RR ||  
10.	        message.addressType === 'udp4' ||  
11.	        message.addressType === 'udp6') {  
12.	      constructor = SharedHandle;  
13.	    }  
14.	  
15.	    handle = new constructor(key,  
16.	                             address,  
17.	                             message.port,  
18.	                             message.addressType,  
19.	                             message.fd,  
20.	                             message.flags);  
21.	    handles.set(key, handle);  
22.	  }  
23.	  handle.add(worker, (errno, reply, handle) => {  
24.	    const { data } = handles.get(key);  
25.	  
26.	    send(worker, {  
27.	      errno,  
28.	      key,  
29.	      ack: message.seq,  
30.	      data,  
31.	      ...reply  
32.	    }, handle);  
33.	  });  
34.	}  
```

queryServer首先根据调度策略选择构造函数，然后执行对应的add方法并且传入一个回调。下面我们看看不同模式下的处理。
## 15.5 共享模式
下面我们首先看一下共享模式的处理，逻辑如图19-1所示。  
![](https://img-blog.csdnimg.cn/69f21946bfd04207b8c19324e9da84ac.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图19-1

```
1.	function SharedHandle(key, address, port, addressType, fd, flags) {  
2.	  this.key = key;  
3.	  this.workers = [];  
4.	  this.handle = null;  
5.	  this.errno = 0;  
6.	  
7.	  let rval;  
8.	  if (addressType === 'udp4' || addressType === 'udp6')  
9.	    rval = dgram._createSocketHandle(address, 
10.	                                        port, 
11.	                                        addressType, 
12.	                                        fd, 
13.	                                        flags);  
14.	  else  
15.	    rval = net._createServerHandle(address,  
16.	                                       port, 
17.	                                       addressType, 
18.	                                       fd, 
19.	                                       flags);  
20.	  
21.	  if (typeof rval === 'number')  
22.	    this.errno = rval;  
23.	  else  
24.	    this.handle = rval;  
25.	}  
```

SharedHandle是共享模式，即主进程创建好handle，交给子进程处理。

```
1.	SharedHandle.prototype.add = function(worker, send) {  
2.	  this.workers.push(worker);  
3.	  send(this.errno, null, this.handle);  
4.	};  
```

SharedHandle的add把SharedHandle中创建的handle返回给子进程，接着我们看看子进程拿到handle后的处理

```
1.	function shared(message, handle, indexesKey, cb) {  
2.	  const key = message.key;  
3.	    
4.	  const close = handle.close;  
5.	  
6.	  handle.close = function() {  
7.	    send({ act: 'close', key });  
8.	    handles.delete(key);  
9.	    indexes.delete(indexesKey);  
10.	    return close.apply(handle, arguments);  
11.	  };  
12.	  handles.set(key, handle); 
13.	  // 执行net模块的回调 
14.	  cb(message.errno, handle);  
15.	}  
```

Shared函数把接收到的handle再回传到调用方。即net模块。net模块会执行listen开始监听地址，但是有连接到来时，系统只会有一个进程拿到该连接。所以所有子进程存在竞争关系导致负载不均衡，这取决于操作系统的实现。
共享模式实现的核心逻辑主进程在_createServerHandle创建handle时执行bind绑定了地址（但没有listen），然后通过文件描述符传递的方式传给子进程，子进程执行listen的时候就不会报端口已经被监听的错误了。因为端口被监听的错误是执行bind的时候返回的。
## 15.6 轮询模式
接着我们看一下RoundRobinHandle的处理，逻辑如图19-2所示。  
![在这里插入图片描述](https://img-blog.csdnimg.cn/2743207004a149e1be5eb539ce19ae7f.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图19-2

```
1.	function RoundRobinHandle(key, address, port, addressType, fd, flags) {  
2.	  this.key = key;  
3.	  this.all = new Map();  
4.	  this.free = [];  
5.	  this.handles = [];  
6.	  this.handle = null;  
7.	  this.server = net.createServer(assert.fail);  
8.	  
9.	  if (fd >= 0)  
10.	    this.server.listen({ fd });  
11.	  else if (port >= 0) {  
12.	    this.server.listen({  
13.	      port,  
14.	      host: address,  
15.	      ipv6Only: Boolean(flags & constants.UV_TCP_IPV6ONLY),  
16.	    });  
17.	  } else  
18.	    this.server.listen(address);  // UNIX socket path.  
19.	  // 监听成功后，注册onconnection回调，有连接到来时执行  
20.	  this.server.once('listening', () => {  
21.	    this.handle = this.server._handle;  
22.	    this.handle.onconnection = (err, handle) => this.distribute(err, handle);  
23.	    this.server._handle = null;  
24.	    this.server = null;  
25.	  });  
26.	}  
```

RoundRobinHandle的工作模式是主进程负责监听，收到连接后分发给子进程。我们看一下RoundRobinHandle的add

```
1.	RoundRobinHandle.prototype.add = function(worker, send) {  
2.	   this.all.set(worker.id, worker);  
3.	  
4.	   const done = () => {  
5.	    if (this.handle.getsockname) {  
6.	      const out = {};  
7.	      this.handle.getsockname(out);  
8.	      send(null, { sockname: out }, null);  
9.	    } else {  
10.	      send(null, null, null);  // UNIX socket.  
11.	    }  
12.	  
13.	    // In case there are connections pending. 
14.	    this.handoff(worker);   
15.	  };  
16.	  // 说明listen成功了  
17.	  if (this.server === null)  
18.	    return done();  
19.	  // 否则等待listen成功后执行回调  
20.	  this.server.once('listening', done);  
21.	  this.server.once('error', (err) => {  
22.	    send(err.errno, null);  
23.	  });  
24.	};  
```

RoundRobinHandle会在listen成功后执行回调。我们回顾一下执行add函数时的回调。

```
1.	handle.add(worker, (errno, reply, handle) => {  
2.	  const { data } = handles.get(key);  
3.	  
4.	  send(worker, {  
5.	    errno,  
6.	    key,  
7.	    ack: message.seq,  
8.	    data,  
9.	    ...reply  
10.	  }, handle);  
11.	});  
```

回调函数会把handle等信息返回给子进程。但是在RoundRobinHandle和SharedHandle中返回的handle是不一样的。分别是null和net.createServer实例。接着我们回到子进程的上下文。看子进程是如何处理响应的。刚才我们讲过，不同的调度策略，返回的handle是不一样的，我们看轮询模式下的处理。

```
1.	function rr(message, indexesKey, cb) { 
2.	  let key = message.key;  
3.	  function listen(backlog) {  
4.	    return 0;  
5.	  }  
6.	  
7.	  function close() {  
8.	    // ...  
9.	  }  
10.	  
11.	  const handle = { close, listen, ref: noop, unref: noop };  
12.	  
13.	  if (message.sockname) {  
14.	    handle.getsockname = getsockname;  // TCP handles only.  
15.	  }  
16.	  
17.	  handles.set(key, handle); 
18.	  // 执行net模块的回调 
19.	  cb(0, handle);  
20.	}  
```

round-robin模式下，构造一个假的handle返回给调用方，因为调用方会调用这些函数。最后回到net模块。net模块首先保存handle，然后调用listen函数。当有请求到来时，round-bobin模块会执行distribute分发请求给子进程。

```
1.	RoundRobinHandle.prototype.distribute = function(err, handle) {  
2.	  // 首先保存handle到队列  
3.	  this.handles.push(handle);  
4.	  // 从空闲队列获取一个子进程  
5.	  const worker = this.free.shift();  
6.	  // 分发  
7.	  if (worker)  
8.	    this.handoff(worker);  
9.	};  
10.	  
11.	RoundRobinHandle.prototype.handoff = function(worker) {  
12.	  // 拿到一个handle  
13.	  const handle = this.handles.shift();  
14.	  // 没有handle，则子进程重新入队  
15.	  if (handle === undefined) {  
16.	    this.free.push(worker);  // Add to ready queue again.  
17.	    return;  
18.	  }  
19.	  // 通知子进程有新连接  
20.	  const message = { act: 'newconn', key: this.key };  
21.	  
22.	  sendHelper(worker.process, message, handle, (reply) => {  
23.	    // 接收成功  
24.	    if (reply.accepted)  
25.	      handle.close();  
26.	    else  
27.	      // 结束失败，则重新分发  
28.	      this.distribute(0, handle);  // Worker is shutting down. Send to another.  
29.	  
30.	    this.handoff(worker);  
31.	  });  
32.	};  
```

接着我们看一下子进程是怎么处理该请求的。

```
1.	function onmessage(message, handle) {  
2.	    if (message.act === 'newconn')  
3.	      onconnection(message, handle);  
4.	}  
5.	  
6.	function onconnection(message, handle) {  
7.	  const key = message.key;  
8.	  const server = handles.get(key);  
9.	  const accepted = server !== undefined;  
10.	  // 回复接收成功  
11.	  send({ ack: message.seq, accepted });  
12.	    
13.	  if (accepted)  
14.	     // 在net模块设置
15.	    server.onconnection(0, handle);  
16.	}  
```

我们看到子进程会执行server.onconnection，这个和我们分析net模块时触发onconnection事件是一样的。

## 15.7实现自己的cluster模块
Node.js的cluster在请求分发时是按照轮询的，无法根据进程当前情况做相应的处理。了解了cluster模块的原理后，我们自己来实现一个cluster模块。
### 15.7.1 轮询模式
整体架构如图15-3所示。  
![在这里插入图片描述](https://img-blog.csdnimg.cn/89432ffeb6b744c491a542a8974b9667.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图15-3  
Parent.js

```
1.	const childProcess = require('child_process');  
2.	const net = require('net');  
3.	const workers = [];  
4.	const workerNum = 10;  
5.	let index = 0;  
6.	for (let i = 0; i < workerNum; i++) {  
7.	  workers.push(childProcess.fork('child.js', {env: {index: i}}));
8.	}  
9.	  
10.	const server = net.createServer((client) => {  
11.	    workers[index].send(null, client);  
12.	    console.log('dispatch to', index);  
13.	    index = (index + 1) % workerNum;  
14.	});  
15.	server.listen(11111);  
```

child.js

```
1.	process.on('message', (message, client) => {  
2.	    console.log('receive connection from master');  
3.	});  
```

主进程负责监听请求，主进程收到请求后，按照一定的算法把请求通过文件描述符的方式传给worker进程，worker进程就可以处理连接了。在分发算法这里，我们可以根据自己的需求进行自定义，比如根据当前进程的负载，正在处理的连接数。
### 15.7.2 共享模式
整体架构如图15-4所示。  
![在这里插入图片描述](https://img-blog.csdnimg.cn/ea446640b87744c0803ada91305a694c.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图15-4  
Parent.js

```
1.	const childProcess = require('child_process');  
2.	const net = require('net');  
3.	const workers = [];  
4.	const workerNum = 10    ;  
5.	const handle = net._createServerHandle('127.0.0.1', 11111, 4);  
6.	  
7.	for (let i = 0; i < workerNum; i++) {  
8.	  const worker = childProcess.fork('child.js', {env: {index: i}});  
9.	    workers.push(worker);  
10.	   worker.send(null ,handle);  
11.	   /*
12.	     防止文件描述符泄漏，但是重新fork子进程的时候就无法
13.	     再传递了文件描述符了
14.	   */
15.	   handle.close();
16.	}  
```

Child.js

```
1.	const net = require('net');  
2.	process.on('message', (message, handle) => {  
3.	    net.createServer(() => {  
4.	        console.log(process.env.index, 'receive connection');  
5.	    }).listen({handle});  
6.	});  
```

我们看到主进程负责绑定端口，然后把handle传给worker进程，worker进程各自执行listen监听socket。当有连接到来的时候，操作系统会选择某一个worker进程处理该连接。我们看一下共享模式下操作系统中的架构，如图15-5所示。  
 ![](https://img-blog.csdnimg.cn/0b78713ccd3b4323a09d50ac46d560d2.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图15-5  
实现共享模式的重点在于理解EADDRINUSE错误是怎么来的。当主进程执行bind的时候，结构如图15-6所示。  
![](https://img-blog.csdnimg.cn/4d8f7f72fc92487693822e8bd239531d.png)  
图15-6  
如果其它进程也执行bind并且端口也一样，则操作系统会告诉我们端口已经被监听了（EADDRINUSE）。但是如果我们在子进程里不执行bind的话，就可以绕过这个限制。那么重点在于，如何在子进程中不执行bind，但是又可以绑定到同样的端口呢？有两种方式。
1 fork
我们知道fork的时候，子进程会继承主进程的文件描述符，如图15-7所示。  
![](https://img-blog.csdnimg.cn/41477efcf31341e48b2e0b19b14fc5c1.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图15-7  
这时候，主进程可以执行bind和listen，然后fork子进程，最后close掉自己的fd，让所有的连接都由子进程处理就行。但是在Node.js中，我们无法实现，所以这种方式不能满足需求。
2 文件描述符传递
Node.js的子进程是通过fork+exec模式创建的，并且Node.js文件描述符设置了close_on_exec标记，这就意味着，在Node.js中，创建子进程后，文件描述符的结构体如图15-8所示（有标准输入、标准输出、标准错误三个fd）。  
![](https://img-blog.csdnimg.cn/d8895df6489c426f9cfb35082e16bfdf.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图15-8  
这时候我们可以通过文件描述符传递的方式。把方式1中拿不到的fd传给子进程。因为在Node.js中，虽然我们拿不到fd，但是我们可以拿得到fd对应的handle，我们通过IPC传输handle的时候，Node.js会为我们处理fd的问题。最后通过操作系统对传递文件描述符的处理。结构如图15-9所示。  
![](https://img-blog.csdnimg.cn/400d28b0d1874bf6b204862d873e38f9.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图15-9  
通过这种方式，我们就绕过了bind同一个端口的问题。通过以上的例子，我们知道绕过bind的问题重点在于让主进程和子进程共享socket而不是单独执行bind。对于传递文件描述符，Node.js中支持很多种方式。上面的方式是子进程各自执行listen。还有另一种模式如下
parent.js

```
1.	const childProcess = require('child_process');  
2.	const net = require('net');  
3.	const workers = [];  
4.	const workerNum = 10;  
5.	const server = net.createServer(() => {  
6.	    console.log('master receive connection');  
7.	})  
8.	server.listen(11111);  
9.	for (let i = 0; i < workerNum; i++) {  
10.	    const worker = childProcess.fork('child.js', {env: {index: i}});  
11.	    workers.push(worker);  
12.	    worker.send(null, server);  
13.	}  
14.	 
```

child.js

```
1.	const net = require('net');  
2.	process.on('message', (message, server) => {  
3.	    server.on('connection', () => {  
4.	        console.log(process.env.index, 'receive connection');  
5.	    })  
6.	});  
```

上面的方式中，主进程完成了bind和listen。然后把server实例传给子进程，子进程就可以监听连接的到来了。这时候主进程和子进程都可以处理连接。
最后写一个客户端测试。
客户端

```
1.	const net = require('net');  
2.	for (let i = 0; i < 50; i++) {  
3.	    net.connect({port: 11111});  
4.	}  
```

执行client我们就可以看到多进程处理连接的情况。
