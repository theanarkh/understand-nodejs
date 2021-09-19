流是对生产数据和消费数据过程的抽象，流本身不生产和消费数据，它只是定义了数据处理的流程。可读流是对数据源流向其它地方的过程抽象，属于生产者，可读流是对数据流向某一目的地的过程的抽象。Node.js中的流分为可读、可写、可读写、转换流。下面我先看一下流的基类。
## 21.1 流基类和流通用逻辑

```
1.	const EE = require('events');  
2.	const util = require('util');  
3.	// 流的基类  
4.	function Stream() {  
5.	  EE.call(this);  
6.	}  
7.	// 继承事件订阅分发的能力  
8.	util.inherits(Stream, EE);  
```

流的基类只提供了一个函数就是pipe。用于实现管道化。管道化是对数据从一个地方流向另一个地方的抽象。这个方法代码比较多，分开说。
### 21.1.1处理数据事件

```
1.	// 数据源对象  
2.	var source = this;  
3.	  
4.	// 监听data事件，可读流有数据的时候，会触发data事件  
5.	source.on('data', ondata);  
6.	function ondata(chunk) {  
7.	  // 源流有数据到达，并且目的流可写  
8.	  if (dest.writable) {  
9.	     /* 
10.	      目的流过载并且源流实现了pause方法，
11.	      那就暂停可读流的读取操作，等待目的流触发drain事件
12.	    */  
13.	    if (false === dest.write(chunk) && source.pause) {  
14.	      source.pause();  
15.	    }  
16.	  }  
17.	}  
18.	  
19.	// 监听drain事件，目的流可以消费数据了就会触发该事件  
20.	dest.on('drain', ondrain);  
21.	function ondrain() {  
22.	  // 目的流可继续写了，并且可读流可读，切换成自动读取模式  
23.	  if (source.readable && source.resume) {  
24.	    source.resume();  
25.	  }  
26.	}  
```

这是管道化时流控实现的地方，主要是利用了write返回值和drain事件。  
### 21.1.2流关闭/结束处理  

```
1.	/* 
2.	  1 dest._isStdio是true表示目的流是标准输出或标准错误（见
3.	    process/stdio.js）， 
4.	  2 配置的end字段代表可读流触发end或close事件时，是否自动关闭可写
5.	    流，默认是自动关闭。如果配置了end是false，则可读流这两个事件触发
6.	    时，我们需要自己关闭可写流。 
7.	  3 我们看到可读流的error事件触发时，可写流是不会被自动关闭的，需要我   
8.	    们自己监听可读流的error事件，然后手动关闭可写流。所以if的判断意思
9.	    是不是标准输出或标准错误流，并且没有配置end是false的时候，会自动
10.	   关闭可写流。而标准输出和标准错误流是在进程退出的时候才被关闭的。 
11.	*/  
12.	if (!dest._isStdio && (!options || options.end !== false)) {  
13.	  // 源流没有数据可读了，执行end回调  
14.	  source.on('end', onend);  
15.	  // 源流关闭了，执行close回调  
16.	  source.on('close', onclose);  
17.	}  
18.	  
19.	var didOnEnd = false;  
20.	function onend() {  
21.	  if (didOnEnd) return;  
22.	  didOnEnd = true;  
23.	// 执行目的流的end，说明写数据完毕  
24.	  dest.end();  
25.	}  
26.	  
27.	function onclose() {  
28.	  if (didOnEnd) return;  
29.	  didOnEnd = true;  
30.	  // 销毁目的流  
31.	  if (typeof dest.destroy === 'function') dest.destroy();  
32.	}  
```

上面是可读源流结束或关闭后，如何处理可写流的逻辑。默认情况下，我们只需要监听可读流的error事件，然后执行可写流的关闭操作。
### 21.1.3 错误处理  

```
1.	// 可读流或者可写流出错的时候都需要停止数据的处理  
2.	source.on('error', onerror);  
3.	dest.on('error', onerror);  
4.	// 可读流或者可写流触发error事件时的处理逻辑  
5.	function onerror(er) {  
6.	  // 出错了，清除注册的事件，包括正在执行的onerror函数  
7.	  cleanup();  
8.	  /*
9.	    如果用户没有监听流的error事件，则抛出错误，
10.	   所以我们业务代码需要监听error事件  
11.	  */
12.	  if (EE.listenerCount(this, 'error') === 0) {  
13.	    throw er; // Unhandled stream error in pipe.  
14.	  }  
15.	}  
```

在error事件的处理函数中，通过cleanup函数清除了Node.js本身注册的error事件，所以这时候如果用户没有注册error事件，则error事件的处理函数个数为0,，所以我们需要注册error事件。下面我们再分析cleanup函数的逻辑。
### 21.1.4 清除注册的事件 

```
1.	// 保证源流关闭、数据读完、目的流关闭时清除注册的事件  
2.	source.on('end', cleanup);  
3.	source.on('close', cleanup);  
4.	dest.on('close', cleanup);   
5.	// 清除所有可能会绑定的事件，如果没有绑定，执行清除也是无害的
6.	function cleanup() {  
7.	  source.removeListener('data', ondata);  
8.	  dest.removeListener('drain', ondrain);  
9.	  
10.	  source.removeListener('end', onend);  
11.	  source.removeListener('close', onclose);  
12.	  
13.	  source.removeListener('error', onerror);  
14.	  dest.removeListener('error', onerror);  
15.	  
16.	  source.removeListener('end', cleanup);  
17.	  source.removeListener('close', cleanup);  
18.	  
19.	  dest.removeListener('close', cleanup);  
20.	}  
21.	  
22.	// 触发目的流的pipe事件  
23.	dest.emit('pipe', source); 
24.	// 支持连续的管道化A.pipe(B).pipe(C)  
25.	return dest;  
```

### 21.1.5 流的阈值
通过getHighWaterMark（lib\internal\streams\state.js）函数可以计算出流的阈值，阈值用于控制用户读写数据的速度。我们看看这个函数的实现。

```
1.	function getHighWaterMark(state, options, duplexKey, isDuplex) {   // 用户定义的阈值  
2.	  let hwm = options.highWaterMark;  
3.	  // 用户定义了，则校验是否合法  
4.	  if (hwm != null) {  
5.	    if (typeof hwm !== 'number' || !(hwm >= 0))  
6.	      throw new errors.TypeError('ERR_INVALID_OPT_VALUE', 
7.	                                   'highWaterMark', 
8.	                                   hwm);  
9.	    return Math.floor(hwm);  
10.	  } else if (isDuplex) {
11.	    // 用户没有定义公共的阈值，即读写流公用的阈值  
12.	    // 用户是否定义了流单独的阈值，比如读流的阈值或者写流的阈值  
13.	    hwm = options[duplexKey];  
14.	    // 用户有定义  
15.	    if (hwm != null) {  
16.	      if (typeof hwm !== 'number' || !(hwm >= 0))  
17.	        throw new errors.TypeError('ERR_INVALID_OPT_VALUE', 
18.	                                      duplexKey, 
19.	                                      hwm);  
20.	      return Math.floor(hwm);  
21.	    }  
22.	  }  
23.	  
24.	  // 默认值，对象是16个，buffer是16KB  
25.	  return state.objectMode ? 16 : 16 * 1024;  
26.	}  
```

getHighWaterMark函数逻辑如下  
1 用户定义了合法的阈值，则取用户定义的（可读流、可写流、双向流）。  
2 如果是双向流，并且用户没有可读流可写流共享的定义阈值，根据当前是可读流还是可写流，判断用户是否设置对应流的阈值。有则取用户设置的值作为阈值。  
3 如果不满足1,2，则返回默认值。  
### 21.1.6 销毁流
通过调用destroy函数可以销毁一个流，包括可读流和可写流。并且可以实现_ destroy函数自定义销毁的行为。我们看看可写流的destroy函数定义。

```
1.	function destroy(err, cb) {  
2.	  // 读流、写流、双向流  
3.	  const readableDestroyed = this._readableState &&  
4.	    this._readableState.destroyed;  
5.	  const writableDestroyed = this._writableState &&  
6.	    this._writableState.destroyed;  
7.	  // 流是否已经销毁，是则直接执行回调  
8.	  if (readableDestroyed || writableDestroyed) {  
9.	    // 传了cb，则执行，可选地传入err，用户定义的err  
10.	    if (cb) {  
11.	      cb(err);  
12.	    } else if (err &&  
13.	               (!this._writableState || 
14.	                 !this._writableState.errorEmitted)) {  
15.	      /*
          传了err，是读流或者没有触发过error事件的写流，
16.	         则触发error事件
17.	       */  
18.	      process.nextTick(emitErrorNT, this, err);  
19.	    }  
20.	    return this;  
21.	  }  
22.	  
23.	  // 还没有销毁则开始销毁流程  
24.	  if (this._readableState) {  
25.	    this._readableState.destroyed = true;  
26.	  }  
27.	  
28.	  if (this._writableState) {  
29.	    this._writableState.destroyed = true;  
30.	  }  
31.	  // 用户可以自定义_destroy函数  
32.	  this._destroy(err || null, (err) => {  
33.	    // 没有cb但是有error，则触发error事件  
34.	    if (!cb && err) {  
35.	      process.nextTick(emitErrorNT, this, err);  
36.	      // 可写流则标记已经触发过error事件  
37.	      if (this._writableState) {  
38.	        this._writableState.errorEmitted = true;  
39.	      }  
40.	    } else if (cb) { // 有cb或者没有err  
41.	      cb(err);  
42.	    }  
43.	  });  
44.	  
45.	  return this;  
46.	}  
```

destroy函数销毁流的通用逻辑。其中_destroy函数不同的流不一样，下面分别是可读流和可写流的实现。
1 可读流

```
1.	Readable.prototype._destroy = function(err, cb) {  
2.	  this.push(null);  
3.	  cb(err);  
4.	};  
```

2 可写流

```
1.	Writable.prototype._destroy = function(err, cb) {  
2.	  this.end();  
3.	  cb(err);  
4.	};  
```

## 21.2 可读流
Node.js中可读流有两种工作模式：流式和暂停式，流式就是有数据的时候就会触发回调，并且把数据传给回调，暂停式就是需要用户自己手动执行读取的操作。我们通过源码去了解一下可读流实现的一些逻辑。因为实现的代码比较多，逻辑也比较绕，本文只分析一些主要的逻辑。我们先看一下ReadableState，这个对象是表示可读流的一些状态和属性的。

```
1.	function ReadableState(options, stream) {  
2.	  options = options || {};  
3.	  // 是否是双向流  
4.	  var isDuplex = stream instanceof Stream.Duplex;  
5.	  // 数据模式  
6.	  this.objectMode = !!options.objectMode;  
7.	  // 双向流的时候，设置读端的模式  
8.	  if (isDuplex)  
9.	    this.objectMode = this.objectMode || 
10.	                            !!options.readableObjectMode;  
11.	  // 读到highWaterMark个字节则停止，对象模式的话则是16个对象  
12.	  this.highWaterMark = getHighWaterMark(this, 
13.	                       options,                                'readableHighWaterMark',  
14.	                      isDuplex);  
15.	  // 存储数据的缓冲区  
16.	  this.buffer = new BufferList();  
17.	  // 可读数据的长度  
18.	  this.length = 0;  
19.	  // 管道的目的源和个数  
20.	  this.pipes = null;  
21.	  this.pipesCount = 0;  
22.	  // 工作模式  
23.	  this.flowing = null;  
24.	  // 流是否已经结束  
25.	  this.ended = false;  
26.	  // 是否触发过end事件了  
27.	  this.endEmitted = false;  
28.	  // 是否正在读取数据  
29.	  this.reading = false; 
30.	  // 是否同步执行事件  
31.	  this.sync = true;  
32.	  // 是否需要触发readable事件  
33.	  this.needReadable = false;  
34.	  // 是否触发了readable事件  
35.	  this.emittedReadable = false;  
36.	  // 是否监听了readable事件  
37.	  this.readableListening = false;  
38.	  // 是否正在执行resume的过程  
39.	  this.resumeScheduled = false;
40.	  // 流是否已销毁  
41.	  this.destroyed = false;  
42.	  // 数据编码格式  
43.	  this.defaultEncoding = options.defaultEncoding || 'utf8'; 
44.	  /*
45.	      在管道化中，有多少个写者已经达到阈值，
46.	      需要等待触发drain事件,awaitDrain记录达到阈值的写者个数
47.	    */  
48.	  this.awaitDrain = 0;  
49.	  // 执行maybeReadMore函数的时候，设置为true  
50.	  this.readingMore = false; 
51.	  this.decoder = null;  
52.	  this.encoding = null;  
53.	  // 编码解码器  
54.	  if (options.encoding) {  
55.	    if (!StringDecoder)  
56.	      StringDecoder = require('string_decoder').StringDecoder;
57.	    this.decoder = new StringDecoder(options.encoding);  
58.	    this.encoding = options.encoding;  
59.	  }  
60.	}  
```

ReadableState里包含了一大堆字段，我们可以先不管它，等待用到的时候，再回头看。接着我们开始看可读流的实现。  

```
1.	function Readable(options) {  
2.	  if (!(this instanceof Readable))  
3.	    return new Readable(options);  
4.	  
5.	  this._readableState = new ReadableState(options, this);  
6.	  // 可读  
7.	  this.readable = true;  
8.	  // 用户实现的两个函数  
9.	  if (options) {  
10.	    if (typeof options.read === 'function')  
11.	      this._read = options.read;  
12.	    if (typeof options.destroy === 'function')  
13.	      this._destroy = options.destroy;  
14.	  }  
15.	  // 初始化父类  
16.	  Stream.call(this);  
17.	}  
```

上面的逻辑不多，需要关注的是read和destroy这两个函数，如果我们是直接使用Readable使用可读流，那在options里是必须传read函数的，destroy是可选的。如果我们是以继承的方式使用Readable，那必须实现_read函数。Node.js只是抽象了流的逻辑，具体的操作（比如可读流就是读取数据）是由用户自己实现的，因为读取操作是业务相关的。下面我们分析一下可读流的操作。 
### 21.2.1 可读流从底层资源获取数据
对用户来说，可读流是用户获取数据的地方，但是对可读流来说，它提供数据给用户的前提是它自己有数据，所以可读流首先需要生产数据。生产数据的逻辑由_read函数实现。_read函数的逻辑大概是  

```
1.	const data = getSomeData();  
2.	readableStream.push(data);  
```

通过push函数，往可读流里写入数据，然后就可以为用户提供数据，我们看看push的实现，只列出主要逻辑。  
1.	Read

```
able.prototype.push = function(chunk, encoding) {  
2.	  // 省略了编码处理的代码  
3.	  return readableAddChunk(this, 
4.	                             chunk, 
5.	                             encoding, 
6.	                             false, 
7.	                             skipChunkCheck);  
8.	};  
9.	  
10.	function readableAddChunk(stream, 
11.	                           chunk, 
12.	                           encoding, 
13.	                           addToFront, 
14.	                           skipChunkCheck) {  
15.	  var state = stream._readableState;  
16.	  // push null代表流结束  
17.	  if (chunk === null) {  
18.	    state.reading = false;  
19.	    onEofChunk(stream, state);  
20.	  } else {  
21.	    addChunk(stream, state, chunk, false);  
22.	  }  
23.	  // 返回是否还可以读取更多数据  
24.	  return needMoreData(state);  
25.	}  
26.	  
27.	function addChunk(stream, state, chunk, addToFront) {  
28.	  // 是流模式并且没有缓存的数据，则直接触发data事件  
29.	  if (state.flowing && state.length === 0 && !state.sync) { 
30.	    stream.emit('data', chunk);  
31.	  } else {  
32.	    // 否则先把数据缓存起来  
33.	    state.length += state.objectMode ? 1 : chunk.length;  
34.	    if (addToFront)  
35.	      state.buffer.unshift(chunk);  
36.	    else  
37.	      state.buffer.push(chunk);  
38.	    // 监听了readable事件则触发readable事件，通过read主动读取  
39.	    if (state.needReadable)  
40.	      emitReadable(stream);  
41.	  }  
42.	  // 继续读取数据，如果可以的话  
43.	  maybeReadMore(stream, state);  
44.	}  
```

总的来说，可读流首先要从某个地方获取数据，根据当前的工作模式，直接交付给用户，或者先缓存起来。可以的情况下，继续获取数据。
## 21.2.2 用户从可读流获取数据  
用户可以通过read函数或者监听data事件来从可读流中获取数据  

```
1.	Readable.prototype.read = function(n) {  
2.	  n = parseInt(n, 10);  
3.	  var state = this._readableState;  
4.	  // 计算可读的大小  
5.	  n = howMuchToRead(n, state);  
6.	  var ret;  
7.	  // 需要读取的大于0，则取读取数据到ret返回  
8.	  if (n > 0)  
9.	    ret = fromList(n, state);  
10.	  else  
11.	    ret = null;  
12.	  // 减去刚读取的长度  
13.	  state.length -= n;  
14.	  /*
15.	     如果缓存里没有数据或者读完后小于阈值了，
16.	      则可读流可以继续从底层资源里获取数据  
17.	    */
18.	  if (state.length === 0 || 
19.	         state.length - n < state.highWaterMark) {  
20.	     this._read(state.highWaterMark);  
21.	  }  
22.	  // 触发data事件  
23.	  if (ret !== null)  
24.	    this.emit('data', ret); 
25.	  return ret;  
26.	};  
```

读取数据的操作就是计算缓存里有多少数据可以读，和用户需要的数据大小，取小的，然后返回给用户，并触发data事件。如果数据还没有达到阈值，则触发可读流从底层资源中获取数据。从而源源不断地生成数据。
## 21.3 可写流
可写流是对数据流向的抽象，用户调用可写流的接口，可写流负责控制数据的写入。流程如图21-1所示。  
![](https://img-blog.csdnimg.cn/df2b7ea696be4d1386b49a8d8d9712fd.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图21-1  
下面是可写流的代码逻辑图如图21-2所示。  
![](https://img-blog.csdnimg.cn/4ea9a8980c894973ae56fdbbbf8f6177.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图21-2  
我们看一下可写流的实现。
### 21.3.1 WritableState
WritableState是管理可写流配置的类。里面包含了非常的字段，具体含义我们会在后续分析的时候讲解。

```
1.	function WritableState(options, stream) {  
2.	  options = options || {};  
3.	  
4.	  // 是不是双向流  
5.	  var isDuplex = stream instanceof Stream.Duplex;  
6.	  
7.	  // 数据模式  
8.	  this.objectMode = !!options.objectMode;  
9.	  /*
10.	   双向流的流默认共享objectMode配置，
11.	   用户可以自己配置成非共享，即读流和写流的数据模式独立
12.	  */  
13.	  if (isDuplex)  
14.	    this.objectMode = this.objectMode || 
15.	                        !!options.writableObjectMode;  
16.	  
17.	  /*  
18.	    阈值，超过后说明需要暂停调用write，0代表每次调用write
19.	    的时候都返回false，用户等待drain事件触发后再执行write 
20.	  */  
21.	  this.highWaterMark = getHighWaterMark(this, 
22.	               options, 'writableHighWaterMark',isDuplex);  
23.	  
24.	  // 是否调用了_final函数  
25.	  this.finalCalled = false;  
26.	  
27.	  // 是否需要触发drain事件，重新驱动生产者  
28.	  this.needDrain = false;  
29.	   
30.	  // 正在执行end流程  
31.	  this.ending = false;  
32.	  
33.	  // 是否执行过end函数  
34.	  this.ended = false;  
35.	   
36.	  // 是否触发了finish事件  
37.	  this.finished = false;  
38.	  
39.	  // 流是否被销毁了  
40.	  this.destroyed = false;  
41.	  
42.	  var noDecode = options.decodeStrings === false;  
43.	  // 是否需要decode流数据后在执行写（调用用户定义的_write）  
44.	  this.decodeStrings = !noDecode;  
45.	  
46.	  // 编码类型  
47.	  this.defaultEncoding = options.defaultEncoding || 'utf8';  
48.	  
49.	  // 待写入的数据长度或对象数  
50.	  this.length = 0;  
51.	  
52.	  // 正在往底层写  
53.	  this.writing = false;  
54.	  
55.	  // 加塞，缓存生产者的数据，停止往底层写入  
56.	  this.corked = 0;  
57.	  
58.	  // 用户定义的_write或者_writev是同步还是异步调用可写流的回调函数onwrite  
59.	  this.sync = true;  
60.	  
61.	  // 是否正在处理缓存的数据  
62.	  this.bufferProcessing = false;  
63.	  
64.	  // 用户实现的钩子_write函数里需要执行的回调，告诉写流写完成了  
65.	  this.onwrite = onwrite.bind(undefined, stream);  
66.	  
67.	  // 当前写操作对应的回调  
68.	  this.writecb = null;  
69.	  
70.	  // 当前写操作的数据长度或对象数  
71.	  this.writelen = 0;  
72.	  
73.	  // 缓存的数据链表头指针  
74.	  this.bufferedRequest = null;  
75.	  
76.	  // 指向缓存的数据链表最后一个节点  
77.	  this.lastBufferedRequest = null;  
78.	  
79.	  // 待执行的回调函数个数  
80.	  this.pendingcb = 0;  
81.	  
82.	  // 是否已经触发过prefinished事件  
83.	  this.prefinished = false;  
84.	  
85.	  // 是否已经触发过error事件  
86.	  this.errorEmitted = false;  
87.	  
88.	  // count buffered requests  
89.	  // 缓存的buffer数  
90.	  this.bufferedRequestCount = 0;  
91.	  
92.	  /* 
93.	    空闲的节点链表，当把缓存数据写入底层时，corkReq保数据的上下文（如 
94.	    用户回调），因为这时候，缓存链表已经被清空，
95.	    this.corkedRequestsFree始终维护一个空闲节点，最多两个 
96.	  */  
97.	  var corkReq = { next: null, entry: null, finish: undefined };  
98.	  corkReq.finish = onCorkedFinish.bind(undefined, corkReq, this);  
99.	  this.corkedRequestsFree = corkReq;  
100.	}  
```

### 21.3.2 Writable
Writable是可写流的具体实现，我们可以直接使用Writable作为可写流来使用，也可以继承Writable实现自己的可写流。

```
1.	function Writable(options) {  
2.	  this._writableState = new WritableState(options, this);  
3.	  // 可写  
4.	  this.writable = true;  
5.	  // 支持用户自定义的钩子  
6.	  if (options) {  
7.	    if (typeof options.write === 'function')  
8.	      this._write = options.write;  
9.	  
10.	    if (typeof options.writev === 'function')  
11.	      this._writev = options.writev;  
12.	  
13.	    if (typeof options.destroy === 'function')  
14.	      this._destroy = options.destroy;  
15.	  
16.	    if (typeof options.final === 'function')  
17.	      this._final = options.final;  
18.	  }  
19.	  
20.	  Stream.call(this);  
21.	}  
```

可写流继承于流基类，提供几个钩子函数，用户可以自定义钩子函数实现自己的逻辑。如果用户是直接使用Writable类作为可写流，则options.write函数是必须传的，options.wirte函数控制数据往哪里写，并且通知可写流是否写完成了。如果用户是以继承Writable类的形式使用可写流，则_write函数是必须实现的，_write函数和options.write函数的作用是一样的。

### 21.3.3 数据写入
可写流提供write函数给用户实现数据的写入，写入有两种方式。一个是逐个写，一个是批量写，批量写是可选的，取决于用户的实现，如果用户直接使用Writable则需要传入writev，如果是继承方式使用Writable则实现_writev函数。我们先看一下write函数的实现

```
1.	Writable.prototype.write = function(chunk, encoding, cb) {  
2.	  var state = this._writableState;  
3.	  // 告诉用户是否还可以继续调用write  
4.	  var ret = false;  
5.	  // 数据格式  
6.	  var isBuf = !state.objectMode && Stream._isUint8Array(chunk);  
7.	  // 是否需要转成buffer格式  
8.	  if (isBuf && Object.getPrototypeOf(chunk) !== Buffer.prototype) {  
9.	    chunk = Stream._uint8ArrayToBuffer(chunk);  
10.	  }  
11.	  // 参数处理，传了数据和回调，没有传编码类型  
12.	  if (typeof encoding === 'function') {  
13.	    cb = encoding;  
14.	    encoding = null;  
15.	  }  
16.	  // 是buffer类型则设置成buffer，否则如果没传则取默认编码  
17.	  if (isBuf)  
18.	    encoding = 'buffer';  
19.	  else if (!encoding)  
20.	    encoding = state.defaultEncoding;  
21.	  
22.	  if (typeof cb !== 'function')  
23.	    cb = nop;  
24.	  // 正在执行end，再执行write，报错  
25.	  if (state.ending)  
26.	    writeAfterEnd(this, cb);  
27.	  else if (isBuf || validChunk(this, state, chunk, cb)) {  
28.	    // 待执行的回调数加一，即cb  
29.	    state.pendingcb++;  
30.	    // 写入或缓存，见该函数  
31.	    ret = writeOrBuffer(this, state, isBuf, chunk, encoding, cb);  
32.	  }  
33.	  /// 还能不能继续写  
34.	  return ret;  
35.	};  
```

write函数首先做了一些参数处理和数据转换，然后判断流是否已经结束了，如果流结束再执行写入，则会报错。如果流没有结束则执行写入或者缓存处理。最后通知用户是否还可以继续调用write写入数据（我们看到如果写入的数据比阈值大，可写流还是会执行写入操作，但是会返回false告诉用户些不要写入了，如果调用方继续写入的话，也是没会继续写入的，但是可能会导致写入端压力过大）。我们首先看一下writeAfterEnd的逻辑。然后再看writeOrBuffer。

```
1.	function writeAfterEnd(stream, cb) {  
2.	  var er = new errors.Error('ERR_STREAM_WRITE_AFTER_END');  
3.	  stream.emit('error', er);  
4.	  process.nextTick(cb, er);  
5.	}  
```

writeAfterEnd函数的逻辑比较简单，首先触发可写流的error事件，然后下一个tick的时候执行用户在调用write时传入的回调。接着我们看一下writeOrBuffer。writeOrBuffer函数会对数据进行缓存或者直接写入目的地（目的地可以是文件、socket、内存，取决于用户的实现），取决于当前可写流的状态。

```
1.	function writeOrBuffer(stream, state, isBuf, chunk, encoding, cb) {  
2.	  // 数据处理  
3.	  if (!isBuf) {  
4.	    var newChunk = decodeChunk(state, chunk, encoding);  
5.	    if (chunk !== newChunk) {  
6.	      isBuf = true;  
7.	      encoding = 'buffer';  
8.	      chunk = newChunk;  
9.	    }  
10.	  }  
11.	  // 对象模式的算一个  
12.	  var len = state.objectMode ? 1 : chunk.length;  
13.	  // 更新待写入数据长度或对象个数  
14.	  state.length += len;  
15.	  // 待写入的长度是否超过了阈值  
16.	  var ret = state.length < state.highWaterMark;  
17.	    
18.	  /*
19.	    超过了阈值，则设置需要等待drain事件标记，
20.	    这时候用户不应该再执行write，而是等待drain事件触发
21.	  */  
22.	  if (!ret)  
23.	    state.needDrain = true;  
24.	  // 如果正在写或者设置了阻塞则先缓存数据，否则直接写入  
25.	  if (state.writing || state.corked) {  
26.	    // 指向当前的尾节点  
27.	    var last = state.lastBufferedRequest;  
28.	    // 插入新的尾结点  
29.	    state.lastBufferedRequest = {  
30.	      chunk,  
31.	      encoding,  
32.	      isBuf,  
33.	      callback: cb,  
34.	      next: null  
35.	    };  
36.	    /*
37.	      之前还有节点的话，旧的尾节点的next指针指向新的尾节点，
38.	      形成链表
39.	     */  
40.	    if (last) {  
41.	      last.next = state.lastBufferedRequest;  
42.	    } else {  
43.	      /*
44.	        指向buffer链表，bufferedRequest相等于头指针，
45.	        插入第一个buffer节点的时候执行到这  
46.	       */
47.	      state.bufferedRequest = state.lastBufferedRequest;  
48.	    }  
49.	    // 缓存的buffer个数加一  
50.	    state.bufferedRequestCount += 1;  
51.	  } else {  
52.	    // 直接写入  
53.	    doWrite(stream, state, false, len, chunk, encoding, cb);  
54.	  }  
55.	  // 返回是否还可以继续执行wirte，如果没有达到阈值则可以继续写  
56.	  return ret;  
57.	}  
```

writeOrBuffer函数主要的逻辑如下  
1 更新待写入数据的长度，判断是否达到阈值，然后通知用户是否还可以执行write继续写入。  
2 判断当前是否正在写入或者处于cork模式。是的话把数据缓存起来，否则执行写操作。  
我们看一下缓存的逻辑和形成的数据结构。  
缓存第一个节点时，如图21-3所示。  
![](https://img-blog.csdnimg.cn/35526566ab84442a968e30ab4d990ac4.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图21-3  
缓存第二个节点时，如图21-4所示。  
![](https://img-blog.csdnimg.cn/6a001b770b4b4259bb1b75ae756ca5f9.png)  
图21-4  
缓存第三个节点时，如图21-5  
 ![](https://img-blog.csdnimg.cn/bafdb23abb5e455aa3f8aa4f9e2ce9e1.png)  
图21-5  
我们看到，函数的数据是以链表的形式管理的，其中bufferedRequest是链表头结点，lastBufferedRequest指向尾节点。假设当前可写流不处于写入或者cork状态。我们看一下写入的逻辑。

```
1.	function doWrite(stream, state, writev, len, chunk, encoding, cb) {  
2.	  // 本次写入的数据长度  
3.	  state.writelen = len;  
4.	  // 本次写完成后执行的回调  
5.	  state.writecb = cb;  
6.	  // 正在写入  
7.	  state.writing = true;  
8.	  // 假设用户定义的_writev或者_write函数是同步回调onwrite  
9.	  state.sync = true;  
10.	  if (writev)  
11.	    // chunk为缓存待写入的buffer节点数组  
12.	    stream._writev(chunk, state.onwrite);  
13.	  else  
14.	    // 执行用户定义的写函数，onwrite是Node.js定义的，在初始化的时候设置了该函数  
15.	    stream._write(chunk, encoding, state.onwrite);  
16.	  /*
17.	    如果用户是同步回调onwrite，则这句代码没有意义，
18.	    如果是异步回调onwrite，这句代码会在onwrite之前执行，
19.	    它标记用户是异步回调模式，在onwrite中需要判断回调模式，即sync的值
20.	  */
21.	  state.sync = false;  
22.	}  
```

doWrite函数记录了本次写入的上下文，比如长度，回调，然后设置正在写标记。最后执行写入。如果当前待写入的数据是缓存的数据并且用户实现了_writev函数，则调用_writev。否则调用_write。下面我们实现一个可写流的例子，把这里的逻辑串起来。

```
1.	const { Writable } = require('stream');  
2.	class DemoWritable extends Writable {  
3.	    constructor() {  
4.	         super();
5.	        this.data = null;  
6.	    }  
7.	    _write(chunk, encoding, cb) {  
8.	        // 保存数据  
9.	        this.data = this.data ? Buffer.concat([this.data, chunk]) : chunk;  
10.	        // 执行回调告诉可写流写完成了，false代表写成功，true代表写失败  
11.	        cb(null);  
12.	    }  
13.	}  
```

DemoWritable定义了数据流向的目的地，在用户调用write的时候，可写流会执行用户定义的_write，_write保存了数据，然后执行回调并传入参数，通知可写流数据写完成了，并通过参数标记写成功还是失败。这时候回到可写流侧。我们看到可写流设置的回调是onwrite，onwrite是在初始化可写流的时候设置的。

```
1.	this.onwrite = onwrite.bind(undefined, stream);  
```
我们接着看onwrite的实现。
```
1.	function onwrite(stream, er) {  
2.	  var state = stream._writableState;  
3.	  var sync = state.sync;  
4.	  // 本次写完时执行的回调  
5.	  var cb = state.writecb;  
6.	  // 重置内部字段的值  
7.	  // 写完了，重置回调，还有多少单位的数据没有写入，数据写完，重置本次待写入的数据数为0  
8.	  state.writing = false;  
9.	  state.writecb = null;  
10.	  state.length -= state.writelen;  
11.	  state.writelen = 0;  
12.	  // 写出错  
13.	  if (er)  
14.	    onwriteError(stream, state, sync, er, cb);  
15.	  else {  
16.	    // Check if we're actually ready to finish, but don't emit yet  
17.	    // 是否已经执行了end，并且数据也写完了（提交写操作和最后真正执行中间可能执行了end）  
18.	    var finished = needFinish(state);  
19.	    // 还没结束，并且没有设置阻塞标记，也不在处理buffer，并且有待处理的缓存数据，则进行写入  
20.	    if (!finished &&  
21.	        !state.corked &&  
22.	        !state.bufferProcessing &&  
23.	        state.bufferedRequest) {  
24.	      clearBuffer(stream, state);  
25.	    }  
26.	    // 用户同步回调onwrite则Node.js异步执行用户回调  
27.	    if (sync) {  
28.	      process.nextTick(afterWrite, stream, state, finished, cb);  
29.	    } else {  
30.	      afterWrite(stream, state, finished, cb);  
31.	    }  
32.	  }  
33.	}  
```

onwrite的逻辑如下  
1 更新可写流的状态和数据  
2 写出错则触发error事件和执行用户回调，写成功则判断是否满足继续执行写操作，是的话则继续写，否则执行用户回调。  
我们看一下clearBuffer函数的逻辑，该逻辑主要是把缓存的数据写到目的地。

```
1.	function clearBuffer(stream, state) {  
2.	  // 正在处理buffer  
3.	  state.bufferProcessing = true;  
4.	  // 指向头结点  
5.	  var entry = state.bufferedRequest;  
6.	  // 实现了_writev并且有两个以上的数据块，则批量写入，即一次把所有缓存的buffer都写入  
7.	  if (stream._writev && entry && entry.next) {  
8.	    // Fast case, write everything using _writev()  
9.	    var l = state.bufferedRequestCount;  
10.	    var buffer = new Array(l);  
11.	    var holder = state.corkedRequestsFree;  
12.	    // 指向待写入数据的链表  
13.	    holder.entry = entry;  
14.	  
15.	    var count = 0;  
16.	    // 数据是否全部都是buffer格式  
17.	    var allBuffers = true;  
18.	    // 把缓存的节点放到buffer数组中  
19.	    while (entry) {  
20.	      buffer[count] = entry;  
21.	      if (!entry.isBuf)  
22.	        allBuffers = false;  
23.	      entry = entry.next;  
24.	      count += 1;  
25.	    }  
26.	    buffer.allBuffers = allBuffers;  
27.	  
28.	    doWrite(stream, state, true, state.length, buffer, '', holder.finish);  
29.	  
30.	    // 待执行的cb加一，即holder.finish  
31.	    state.pendingcb++;  
32.	    // 清空缓存队列  
33.	    state.lastBufferedRequest = null;  
34.	    // 还有下一个节点则更新指针,下次使用  
35.	    if (holder.next) {  
36.	      state.corkedRequestsFree = holder.next;  
37.	      holder.next = null;  
38.	    } else {  
39.	      // 没有下一个节点则恢复值，见初始化时的设置  
40.	      var corkReq = { next: null, entry: null, finish: undefined };  
41.	      corkReq.finish = onCorkedFinish.bind(undefined, corkReq, state);  
42.	      state.corkedRequestsFree = corkReq;  
43.	    }  
44.	    state.bufferedRequestCount = 0;  
45.	  } else {  
46.	    // 慢慢写，即一个个buffer写，写完后等需要执行用户的cb，驱动下一个写  
47.	    // Slow case, write chunks one-by-one  
48.	    while (entry) {  
49.	      var chunk = entry.chunk;  
50.	      var encoding = entry.encoding;  
51.	      var cb = entry.callback;  
52.	      var len = state.objectMode ? 1 : chunk.length;  
53.	      // 执行写入  
54.	      doWrite(stream, state, false, len, chunk, encoding, cb);  
55.	      entry = entry.next;  
56.	      // 处理完一个，减一  
57.	      state.bufferedRequestCount--;  
58.	       
59.	      /* 
60.	        在onwrite里清除这个标记，onwrite依赖于用户执行，如果用户没调， 
61.	        或者不是同步调，则退出，等待执行onwrite的时候再继续写 
62.	      */  
63.	      if (state.writing) {  
64.	        break;  
65.	      }  
66.	    }  
67.	    // 写完了缓存的数据，则更新指针  
68.	    if (entry === null)  
69.	      state.lastBufferedRequest = null;  
70.	  }  
71.	  /* 
72.	    更新缓存数据链表的头结点指向， 
73.	    1 如果是批量写则entry为null 
74.	    2 如果单个写，则可能还有值（如果用户是异步调用onwrite的话） 
75.	  */  
76.	  state.bufferedRequest = entry;  
77.	  // 本轮处理完毕（处理完一个或全部）  
78.	  state.bufferProcessing = false;  
79.	}  
```

clearBuffer的逻辑看起来非常多，但是逻辑并不算很复杂。主要分为两个分支。
1 用户实现了批量写函数，则一次把缓存的时候写入目的地。首先把缓存的数据（链表）全部收集起来，然后执行执行写入，并设置回调是finish函数。corkedRequestsFree字段指向一个节点数最少为一，最多为二的链表，用于保存批量写的数据的上下文。批量写时的数据结构图如图21-6和21-7所示（两种场景）。  
![](https://img-blog.csdnimg.cn/a6c4092b0ed04bc689750af241cfc508.png)  
图21-6  
![](https://img-blog.csdnimg.cn/1e61f07f68754c4494a85cc794ef7134.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图21-7  
corkedRequestsFree保证最少有一个节点，用于一次批量写，当使用完的时候，会最多保存两个空闲节点。我们看一下批量写成功后，回调函数onCorkedFinish的逻辑。

```
1.	function onCorkedFinish(corkReq, state, err) {  
2.	  // corkReq.entry指向当前处理的buffer链表头结点  
3.	  var entry = corkReq.entry;  
4.	  corkReq.entry = null;  
5.	  // 遍历执行用户传入的回调回调  
6.	  while (entry) {  
7.	    var cb = entry.callback;  
8.	    state.pendingcb--;  
9.	    cb(err);  
10.	    entry = entry.next;  
11.	  }  
12.	  
13.	  // 回收corkReq，state.corkedRequestsFree这时候已经等于新的corkReq，指向刚用完的这个corkReq，共保存两个  
14.	  state.corkedRequestsFree.next = corkReq;  
15.	}  
```

onCorkedFinish首先从本次批量写的数据上下文取出回调，然后逐个执行。最后回收节点。corkedRequestsFree总是指向一个空闲节点，所以如果节点超过两个时，每次会把尾节点丢弃，如图21-8所示。  
![](https://img-blog.csdnimg.cn/58b8d89b2ebe4865a75f26b26fb44fef.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图21-8  

2 接着我们看单个写的场景  
单个写的时候，就是通过doWrite把数据逐个写到目的地，但是有一个地方需要注意的是，如果用户是异步执行可写流的回调onwrite（通过writing字段，因为onwrite会置writing为true，如果执行完doWrite，writing为false说明是异步回调），则写入一个数据后就不再执行doWrite进行写，而是需要等到onwrite回调被异步执行时，再执行下一次写，因为可写流是串行地执行写操作。
下面讲一下sync字段的作用。sync字段是用于标记执行用户自定义的write函数时，write函数是同步还是异步执行可写流的回调onwrite。主要用于控制是同步还是异步执行用户的回调。并且需要保证回调要按照定义的顺序执行。有两个地方涉及了这个逻辑，第一个是wirte的时候。我们看一下函数的调用关系，如图21-9所示。  
![](https://img-blog.csdnimg.cn/248dc5856ffe47f0abd79d4d0940b386.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图21-9  

如果用户是同步执行onwrite，则数据会被实时地消费，不存在缓存数据的情况，这时候Node.js异步并且有序地执行用户回调。如果用户连续两次调用了write写入数据，并且是以异步执行回调onwrite，则第一次执行onwrite的时候，会存在缓存的数据，这时候还没来得及执行用户回调，就会先发生第二次写入操作，同样，第二次写操作也是异步回调onwrite，所以接下来就会同步执行的用户回调。这样就保证了用户回调的顺序执行。第二种场景是uncork函数。我们看一下函数关系图，如图21-10所示。  
![](https://img-blog.csdnimg.cn/4af7646324f742059042e8e28e300009.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图21-10  

在uncork的执行流程中，如果onwrite是被同步回调，则在onwrite中不会再次调用clearBuffer，因为这时候的bufferProcessing为true。这时候会先把用户的回调入队，然后再次执行doWrite发起下一次写操作。如果onwrite是被异步执行，在执行clearBuffer中，第一次执行doWrite完毕后，clearBuffer就会退出，并且这时候bufferProcessing为false。等到onwrite被回调的时候，再次执行clearBuffer，同样执行完doWrite的时候退出，等待异步回调，这时候用户回调被执行。
我们继续分析onwrite的代码，onwrite最后会调用afterWrite函数。
```
1.	function afterWrite(stream, state, finished, cb) {  
2.	  // 还没结束，看是否需要触发drain事件  
3.	  if (!finished)  
4.	    onwriteDrain(stream, state);  
5.	  // 准备执行用户回调，待执行的回调减一  
6.	  state.pendingcb--;  
7.	  cb();  
8.	  finishMaybe(stream, state);  
9.	}  
10.	
11.	function onwriteDrain(stream, state) {  
12.	  // 没有数据需要写了，并且流在阻塞中等待drain事件  
13.	  if (state.length === 0 && state.needDrain) {  
14.	    // 触发drain事件然后清空标记  
15.	    state.needDrain = false;  
16.	    stream.emit('drain');  
17.	  }  
18.	}  
19.	
```

afterWrite主要是判断是否需要触发drain事件，然后执行用户回调。最后判断流是否已经结束（在异步回调onwrite的情况下，用户调用回调之前，可能执行了end）。流结束的逻辑我们后面章节单独分析。
### 21.3.4 cork和uncork
cork和uncork类似tcp中的negal算法，主要用于累积数据后一次性写入目的地。而不是有一块就实时写入。比如在tcp中，每次发送一个字节，而协议头远远大于一字节，有效数据占比非常低。使用cork的时候最好同时提供writev实现，否则最后cork就没有意义，因为最终还是需要一块块的数据进行写入。我们看看cork的代码。

```
1.	Writable.prototype.cork = function() {  
2.	  var state = this._writableState;  
3.	  state.corked++;  
4.	};  
```

cork的代码非常简单，这里使用一个整数而不是标记位，所以cork和uncork需要配对使用。我们看看uncork。
1.	

```
Writable.prototype.uncork = function() {  
2.	  var state = this._writableState;  
3.	  
4.	  if (state.corked) {  
5.	    state.corked--;  
6.	    /* 
7.	      没有在进行写操作（如果进行写操作则在写操作完成的回调里会执行clearBuffer）， 
8.	      corked=0， 
9.	      没有在处理缓存数据（writing为false已经说明）， 
10.	      有缓存的数据待处理 
11.	    */  
12.	    if (!state.writing &&  
13.	        !state.corked &&  
14.	        !state.bufferProcessing &&  
15.	        state.bufferedRequest)  
16.	      clearBuffer(this, state);  
17.	  }  
18.	};  
```

### 21.3.5 流结束
流结束首先会把当前缓存的数据写入目的地，并且允许再执行额外的一次写操作，然后把可写流置为不可写和结束状态，并且触发一系列事件。下面是结束一个可写流的函数关系图。如图21-11所示。  
![在这里插入图片描述](https://img-blog.csdnimg.cn/e9fcf54e7cbd4ac19a8286ede54111df.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图21-11  
通过end函数可以结束可写流，我们看看该函数的逻辑。

```
1.	Writable.prototype.end = function(chunk, encoding, cb) {  
2.	  var state = this._writableState;  
3.	  
4.	  if (typeof chunk === 'function') {  
5.	    cb = chunk;  
6.	    chunk = null;  
7.	    encoding = null;  
8.	  } else if (typeof encoding === 'function') {  
9.	    cb = encoding;  
10.	    encoding = null;  
11.	  }  
12.	  // 最后一次写入的机会，可能直接写入，也可以会被缓存（正在写护着处于corked状态）  
13.	  if (chunk !== null && chunk !== undefined)  
14.	    this.write(chunk, encoding);  
15.	  
16.	  // 如果处于corked状态，则上面的写操作会被缓存，uncork和write保存可以对剩余数据执行写操作  
17.	  if (state.corked) {  
18.	    // 置1，为了uncork能正确执行,可以有机会写入缓存的数据  
19.	    state.corked = 1;  
20.	    this.uncork();  
21.	  }  
22.	  
23.	  if (!state.ending)  
24.	    endWritable(this, state, cb);  
25.	};  
```

我们接着看endWritable函数

```
1.	function endWritable(stream, state, cb) {  
2.	  // 正在执行end函数  
3.	  state.ending = true;  
4.	  // 判断流是否可以结束了
5.	  finishMaybe(stream, state);  
6.	  if (cb) {  
7.	    // 已经触发了finish事件则下一个tick直接执行cb，否则等待finish事件  
8.	    if (state.finished)  
9.	      process.nextTick(cb);  
10.	    else  
11.	      stream.once('finish', cb);  
12.	  }  
13.	  // 流结束，流不可写  
14.	  state.ended = true;  
15.	  stream.writable = false;  
16.	}  
```

endWritable函数标记流不可写并且处于结束状态。但是只是代表不能再调用write写数据了，之前缓存的数据需要被写完后才能真正地结束流。我们看finishMaybe函数的逻辑。该函数用于判断流是否可以结束。

```
1.	function needFinish(state) {  
2.	  /* 
3.	    执行了end函数则设置ending=true， 
4.	    当前没有数据需要写入了， 
5.	    也没有缓存的数据， 
6.	    还没有触发finish事件， 
7.	    没有正在进行写入 
8.	  */  
9.	  return (state.ending &&  
10.	          state.length === 0 &&  
11.	          state.bufferedRequest === null &&  
12.	          !state.finished &&  
13.	          !state.writing);  
14.	}  
15.	  
16.	// 每次写完成的时候也会调用该函数  
17.	function finishMaybe(stream, state) {  
18.	  // 流是否可以结束  
19.	  var need = needFinish(state);  
20.	  // 是则先处理prefinish事件，否则先不管，等待写完成再调用该函数  
21.	  if (need) {  
22.	    prefinish(stream, state);  
23.	    // 如果没有待执行的回调，则触发finish事件  
24.	    if (state.pendingcb === 0) {  
25.	      state.finished = true;  
26.	      stream.emit('finish');  
27.	    }  
28.	  }  
29.	  return need;  
30.	}  
```

当可写流中所有数据和回调都执行了才能结束流，在结束流之前会先处理prefinish事件。
1.

```
	function callFinal(stream, state) {  
2.	  // 执行用户的final函数  
3.	  stream._final((err) => {  
4.	    // 执行了callFinal函数，cb减一  
5.	    state.pendingcb--;  
6.	    if (err) {  
7.	      stream.emit('error', err);  
8.	    }  
9.	    // 执行prefinish  
10.	    state.prefinished = true;  
11.	    stream.emit('prefinish');  
12.	    // 是否可以触发finish事件  
13.	    finishMaybe(stream, state);  
14.	  });  
15.	}  
16.	function prefinish(stream, state) {  
17.	  // 还没触发prefinish并且没有执行finalcall  
18.	  if (!state.prefinished && !state.finalCalled) {  
19.	    // 用户传了final函数则，待执行回调数加一，即callFinal，否则直接触发prefinish  
20.	    if (typeof stream._final === 'function') {  
21.	      state.pendingcb++;  
22.	      state.finalCalled = true;  
23.	      process.nextTick(callFinal, stream, state);  
24.	    } else {  
25.	      state.prefinished = true;  
26.	      stream.emit('prefinish');  
27.	    }  
28.	  }  
29.	}  
```

如果用户定义了_final函数，则先执行该函数（这时候会阻止finish事件的触发），执行完后触发prefinish，再触发finish。如果没有定义_final，则直接触发prefinish事件。最后触发finish事件。
# 21.4 双向流
双向流是继承可读、可写的流。

```
1.	util.inherits(Duplex, Readable);  
2.	  
3.	{  
4.	  // 把可写流中存在，并且在可读流和Duplex里都不存在的方法加入到Duplex  
5.	  const keys = Object.keys(Writable.prototype);  
6.	  for (var v = 0; v < keys.length; v++) {  
7.	    const method = keys[v];  
8.	    if (!Duplex.prototype[method])  
9.	      Duplex.prototype[method] = Writable.prototype[method];  
10.	  }  
11.	}  
```


```
1.	function Duplex(options) {  
2.	  if (!(this instanceof Duplex))  
3.	    return new Duplex(options);  
4.	  
5.	  Readable.call(this, options);  
6.	  Writable.call(this, options);  
7.	  // 双向流默认可读  
8.	  if (options && options.readable === false)  
9.	    this.readable = false;  
10.	  // 双向流默认可写  
11.	  if (options && options.writable === false)  
12.	    this.writable = false;  
13.	  // 默认允许半开关  
14.	  this.allowHalfOpen = true;  
15.	  if (options && options.allowHalfOpen === false)  
16.	    this.allowHalfOpen = false;  
17.	  
18.	  this.once('end', onend);  
19.	}  
```

双向流继承了可读流和可写流的能力。双向流实现了以下功能
### 21.4.1 销毁 
如果读写两端都销毁，则双向流销毁。

```
1.	Object.defineProperty(Duplex.prototype, 'destroyed', {  
2.	  enumerable: false,  
3.	  get() {  
4.	    if (this._readableState === undefined ||  
5.	        this._writableState === undefined) {  
6.	      return false;  
7.	    }  
8.	    return this._readableState.destroyed && this._writableState.destroyed;  
9.	  }  
10.	}  
```

我们看如何销毁一个双向流。

```
1.	Duplex.prototype._destroy = function(err, cb) {  
2.	  // 关闭读端  
3.	  this.push(null);  
4.	  // 关闭写端  
5.	  this.end();  
6.	  // 执行回调
7.	  process.nextTick(cb, err);  
8.	};  
```

双向流还有一个特性是是否允许半开关，即可读或可写。onend是读端关闭时执行的函数。我们看看实现。

```
1.	// 关闭写流  
2.	function onend() {  
3.	  // 允许半开关或写流已经结束则返回  
4.	  if (this.allowHalfOpen || this._writableState.ended)  
5.	    return;  
6.	  // 下一个tick再关闭写流，执行完这段代码，用户还可以写  
7.	  process.nextTick(onEndNT, this);  
8.	}  
9.	  
10.	function onEndNT(self) {  
11.	  // 调用写端的end函数  
12.	  self.end();  
13.	}  
```

当双向流允许半开关的情况下，可读流关闭时，可写流可以不关闭。
