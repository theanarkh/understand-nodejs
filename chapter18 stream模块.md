# 第十八章 stream模块

流是对数据生产和消费的抽象，生产者把数据填充到流中，流中的数据会在某种情况下流向消费者。Nodejs中的流分为可读、可写、可读写、转换流。
## 18.1 流基类

```c
1.const EE = require('events');  
2.const util = require('util');  
3.// 流的基类  
4.function Stream() {  
5.  EE.call(this);  
6.}  
7.// 继承事件订阅分发的能力  
8.util.inherits(Stream, EE);  
```

流的基类只提供了一个函数就是pipe。用于实现管道化。这个方法代码比较多，分开说。
### 18.1.1处理数据事件

```c
1.function ondata(chunk) {  
2.    // 源流有数据到达，并且目的流可写  
3.    if (dest.writable) {  
4.      // 目的流过载并且源流实现了pause方法，那就暂停可读流的读取操作，等待目的流触发drain事件  
5.      if (false === dest.write(chunk) && source.pause) {  
6.        source.pause();  
7.      }  
8.    }  
9. }  
10.  // 监听data事件，可读流有数据的时候，会触发data事件  
11.  source.on('data', ondata);  
12.  
13.  function ondrain() {  
14.    // 目的流可写了，并且可读流可读，切换成自动读取模式  
15.    if (source.readable && source.resume) {  
16.      source.resume();  
17.    }  
18.  }  
19.  // 监听drain事件，目的流可以消费数据了就会触发该事件  
20.  dest.on('drain', ondrain);  
```

这是管道化时流控实现的地方，主要是利用了write返回值和drain事件。  
### 18.1.2流关闭/结束处理  

```c
1.// 目的流不是标准输出或标准错误，并且end不等于false  
2.  if (!dest._isStdio && (!options || options.end !== false)) {  
3.    // 源流没有数据可读了，执行end回调，告诉目的流，没有数据可读了  
4.    source.on('end', onend);  
5.    // 源流关闭了，执行close回调  
6.    source.on('close', onclose);  
7.  }  
8.  // 两个函数只会执行一次，也只会执行一个  
9.  var didOnEnd = false;  
10.  function onend() {  
11.    if (didOnEnd) return;  
12.    didOnEnd = true;  
13.    // 执行目的流的end函数，说明写数据完毕  
14.    dest.end();  
15.  }  
16.  
17.  function onclose() {  
18.    if (didOnEnd) return;  
19.    didOnEnd = true;  
20.    // 销毁目的流  
21.    if (typeof dest.destroy === 'function') dest.destroy();  
22.  }  
```

这里是处理源流结束和关闭后，通知目的流的逻辑。
### 18.1.3错误处理和事件清除  

```c
1.// remove all the event listeners that were added.  
2.  function cleanup() {  
3.    source.removeListener('data', ondata);  
4.    dest.removeListener('drain', ondrain);  
5.  
6.    source.removeListener('end', onend);  
7.    source.removeListener('close', onclose);  
8.  
9.    source.removeListener('error', onerror);  
10.    dest.removeListener('error', onerror);  
11.  
12.    source.removeListener('end', cleanup);  
13.    source.removeListener('close', cleanup);  
14.  
15.    dest.removeListener('close', cleanup);  
16.  }  
17.  
18.  function onerror(er) {  
19.    // 出错了，清除注册的事件，包括正在执行的onerror函数  
20.    cleanup();  
21.    // 如果用户没有监听流的error事件，则抛出错误，所以我们业务代码需要监听error事件  
22.    if (EE.listenerCount(this, 'error') === 0) {  
23.      throw er; // Unhandled stream error in pipe.  
24.    }  
25.  }  
26.  // 监听流的error事件  
27.  source.on('error', onerror);  
28.  dest.on('error', onerror);  
29.  // 源流关闭或者没有数据可读时，清除注册的事件  
30.  source.on('end', cleanup);  
31.  source.on('close', cleanup);  
32.  // 目的流关闭了也清除他注册的事件  
33.  dest.on('close', cleanup);  
```

这里主要是处理了error事件和流关闭/结束/出错时清除订阅的事件。这就是流基类的所有逻辑。  
## 18.2 可读流
可读流是对数据消费的抽象，nodejs中可读流有两种工作模式：流式和暂停式，流式就是有数据的时候就会触发回调，并且把数据传给回调，暂停式就是需要用户自己手动执行读取的操作。下面几种操作会使得流变成流模式。

 1.  监听data事件（移除data事件不会变成暂停模式）
 2.  执行resume函数 
 3. 执行pipe

下面几种操作会使得流变成暂停模式（不会停止数据的读取，但是不会触发流式事件）

 1. 执行pause函数（如果是使用了pipe技术，则如果目的流需要更多数据时，暂停模式可能会失效） 
 2. 通过unpipe移除所有的可写流
 3. 监听readable事件（在触发readable事件时，调用方调用read函数读取数据，移除readable事件，如果监听了data事件，则会变成流模式）

如果流处于流模式但是没有消费者，则数据会丢失。
我们通过源码去了解一下可读流实现的一些逻辑。因为实现的代码比较多，逻辑也比较绕，本文只分析一些主要的逻辑，有兴趣的可以参考文档或者自行深入看源码了解细节。我们先看一下ReadableState，这个对象是表示可读流的一些状态和属性的。

```c
1.function ReadableState(options, stream) {  
2.  options = options || {};  
3.  // 是否是双向流  
4.  var isDuplex = stream instanceof Stream.Duplex;  
5.  // 数据模式  
6.  this.objectMode = !!options.objectMode;  
7.  // 双向流的时候，设置读端的模式  
8.  if (isDuplex)  
9.    this.objectMode = this.objectMode || !!options.readableObjectMode;  
10.  // 读到highWaterMark个字节则停止，对象模式的话则是16个对象  
11.  this.highWaterMark = getHighWaterMark(this,   
12.                                          options,   
13.                                          'readableHighWaterMark',  
14.                                        isDuplex);  
15.  // 存储数据的缓冲区  
16.  this.buffer = new BufferList();  
17.  // 可读数据的长度  
18.  this.length = 0;  
19.  // 管道的目的源和个数  
20.  this.pipes = null;  
21.  this.pipesCount = 0;  
22.  // 工作模式  
23.  this.flowing = null;  
24.  // 流是否已经结束  
25.  this.ended = false;  
26.  // 是否触发过end事件了  
27.  this.endEmitted = false;  
28.  // 是否正在读取数据  
29.  this.reading = false;  
30.  
31.  // 是否同步执行事件  
32.  this.sync = true;  
33.  
34.  // 是否需要触发readable事件  
35.  this.needReadable = false;  
36.  // 是否触发了readable事件  
37.  this.emittedReadable = false;  
38.  // 是否监听了readable事件  
39.  this.readableListening = false;  
40.  // 是否正在执行resume的过程  
41.  this.resumeScheduled = false;  
42.  
43.  // has it been destroyed  
44.  // 流是否已销毁  
45.  this.destroyed = false;  
46.  
47.  // 数据编码格式  
48.  this.defaultEncoding = options.defaultEncoding || 'utf8';  
49.  
50.  // 在管道化中，有多少个写者已经达到阈值，需要等待触发drain事件,awaitDrain记录达到阈值的写者个数  
51.  this.awaitDrain = 0;  
52.  
53.  // 执行maybeReadMore函数的时候，设置为true  
54.  this.readingMore = false;  
55.  
56.  this.decoder = null;  
57.  this.encoding = null;  
58.  // 编码解码器  
59.  if (options.encoding) {  
60.    if (!StringDecoder)  
61.      StringDecoder = require('string_decoder').StringDecoder;  
62.    this.decoder = new StringDecoder(options.encoding);  
63.    this.encoding = options.encoding;  
64.  }  
65.}  
```

ReadableState里包含了一大堆字段，我们可以先不管他，等待用到的时候，再回头看。接着我们开始看可读流的实现。  

```c
1.function Readable(options) {  
2.  if (!(this instanceof Readable))  
3.    return new Readable(options);  
4.  
5.  this._readableState = new ReadableState(options, this);  
6.  // 可读  
7.  this.readable = true;  
8.  // 用户实现的两个函数  
9.  if (options) {  
10.    if (typeof options.read === 'function')  
11.      this._read = options.read;  
12.  
13.    if (typeof options.destroy === 'function')  
14.      this._destroy = options.destroy;  
15.  }  
16.  // 初始化父类  
17.  Stream.call(this);  
18.}  
```

上面的逻辑不多，需要关注的是read和destroy这两个函数，如果我们是直接使用Readable使用可读流，那在options里是必须传read函数的，destroy是可选的。如果我们是以继承的方式使用Readable，那必须实现_read函数。nodejs只是抽象了流的逻辑，具体的操作（比如可读流就是读取数据）是由用户自己实现的，因为读取操作是业务相关的。下面我们分析一下可读流的操作。 
### 18.2.1 可读流从底层资源获取数据
对用户来说，可读流是用户获取数据的地方，但是对可读流来说，他提供数据给用户的前提是他自己有数据，所以可读流首先需要生产数据。生产数据的逻辑由_read函数实现。_read函数的逻辑大概是  
1.const data = getSomeData();  
2.readableStream.push(data);  
  通过push函数，往可读流里写入数据，然后就可以为用户提供数据，我们看看push的实现，只列出主要逻辑。  

```c
1.Readable.prototype.push = function(chunk, encoding) {  
2.  // 省略了编码处理的代码  
3.  return readableAddChunk(this, chunk, encoding, false, skipChunkCheck);  
4.};  
5.  
6.function readableAddChunk(stream, chunk, encoding, addToFront, skipChunkCheck) {  
7.  var state = stream._readableState;  
8.  // push null代表流结束  
9.  if (chunk === null) {  
10.    state.reading = false;  
11.    onEofChunk(stream, state);  
12.  } else {  
13.      addChunk(stream, state, chunk, false);  
14.  }  
15.  // 返回是否还可以读取更多数据  
16.  return needMoreData(state);  
17.}  
18.  
19.function addChunk(stream, state, chunk, addToFront) {  
20.  // 是流模式并且没有缓存的数据，则直接触发data事件  
21.  if (state.flowing && state.length === 0 && !state.sync) {  
22.    stream.emit('data', chunk);  
23.  } else {  
24.    // 否则先把数据缓存起来  
25.    state.length += state.objectMode ? 1 : chunk.length;  
26.    if (addToFront)  
27.      state.buffer.unshift(chunk);  
28.    else  
29.      state.buffer.push(chunk);  
30.    // 监听了readable事件，则触发readable事件  
31.    if (state.needReadable)  
32.      emitReadable(stream);  
33.  }  
34.  // 继续读取数据，如果可以的话  
35.  maybeReadMore(stream, state);  
36.}  
```

总的来说，可读流首先要从某个地方获取数据，根据当前的工作模式，直接交付给用户，或者先缓存起来。并可以的情况下，继续获取数据。
### 18.2.2 用户从可读流获取数据  
用户可以通过read函数或者监听data事件来从可读流中获取数据  

```c
1.Readable.prototype.read = function(n) {  
2.  n = parseInt(n, 10);  
3.  var state = this._readableState;  
4.  // 计算可读的大小  
5.  n = howMuchToRead(n, state);  
6.  var ret;  
7.  // 需要读取的大于0，则取读取数据到ret返回  
8.  if (n > 0)  
9.    ret = fromList(n, state);  
10.  else  
11.    ret = null;  
12.  // 减去刚读取的长度  
13.  state.length -= n;  
14.  // 如果缓存里没有数据或者读完后小于阈值了，则可读流可以继续从底层资源里获取数据  
15.  if (state.length === 0 || state.length - n < state.highWaterMark) {  
16.     this._read(state.highWaterMark);  
17.  }  
18.  // 触发data事件  
19.  if (ret !== null)  
20.    this.emit('data', ret);  
21.  
22.  return ret;  
23.};  
```

读取数据的操作就是计算缓存里有多少数据可以读，和用户需要的数据大小，取小的，然后返回给用户，并触发data事件。如果数据还没有达到阈值，则触发可读流从底层资源中获取数据。
### 18.2.3销毁流  

```c
1.function destroy(err, cb) {  
2.  // 设置已销毁标记  
3.  if (this._readableState) {  
4.    this._readableState.destroyed = true;  
5.  }  
6.  // 执行_destroy钩子函数，用户可以重写这个函数  
7.  this._destroy(err || null, (err) => {  
8.    // 出错，但是没有设置回调，则执行触发error事件  
9.    if (!cb && err) {  
10.      process.nextTick(() => {  
11.        this.emit('error', err);  
12.      }, this, err);  
13.    } else if (cb) {  
14.      // 有回调则执行  
15.      cb(err);  
16.    }  
17.  });  
18.  
19.  return this;  
20.}  
```

我们看一下Readable提供的默认_destroy函数。

```c
1.Readable.prototype._destroy = function(err, cb) {  
2.  this.push(null);  
3.  cb(err);  
4.};  
```

刚才分析push函数时已经看到this.push(null)表示流结束了。销毁流意味着关闭流对应的底层资源，不再提供数据服务。 
## 18.3 可写流

```c
1.function WritableState(options, stream) {  
2.  options = options || {};  
3.  var isDuplex = stream instanceof Stream.Duplex;  
4.  // 数据模式  
5.  this.objectMode = !!options.objectMode;  
6.  // 全双工的流默认共享objectMode配置，用户可以自己配置成非共享  
7.  if (isDuplex)  
8.    this.objectMode = this.objectMode || !!options.writableObjectMode;  
9.  // 写入的数据超时这个阈值，则需要缓存到写流中国  
10.  this.highWaterMark = getHighWaterMark(this, options, 'writableHighWaterMark',  
11.                                        isDuplex);  
12.  // _final函数是否被调用了  
13.  this.finalCalled = false;  
14.  //是否需要触发drain事件，重新驱动生产者  
15.  this.needDrain = false;  
16.  // 正在执行end流程  
17.  this.ending = false;  
18.  // 是否执行完end流程  
19.  this.ended = false;  
20.  // 是否触发了finish事件  
21.  this.finished = false;  
22.  
23.  // 流是否销毁  
24.  this.destroyed = false;  
25.  var noDecode = options.decodeStrings === false;  
26.  this.decodeStrings = !noDecode;  
27.  this.defaultEncoding = options.defaultEncoding || 'utf8';  
28.  // 待写入的数据长度或对象数  
29.  this.length = 0;  
30.  // 正在往底层写  
31.  this.writing = false;  
32.  // 加塞，缓存生产者的数据，停止往底层写入  
33.  this.corked = 0;  
34.  this.sync = true;  // 用户定义的_write或者_writev是同步还是异步调用可写流的回调函数onwrite
35.  // 是否正在处理缓存的数据  
36.  this.bufferProcessing = false;  
37.  // 往底层写完成（成功或失败）时执行的回调  
38.  this.onwrite = onwrite.bind(undefined, stream);  
39.  // 每次执行写入时对应的回调  
40.  this.writecb = null;  
41.  // 执行write的时候，本次写入的数据长度或对象是数  
42.  this.writelen = 0;  
43.  // 第一个缓存的buffer  
44.  this.bufferedRequest = null;  
45.  // 最后一个缓存的buffer  
46.  this.lastBufferedRequest = null;  
47.  // 待执行的回调函数个数，在finish前需要执行回调  
48.  this.pendingcb = 0;  
49.  // 是否已经触发过prefinished事件  
50.  this.prefinished = false;  
51.  // 是否已经触发过error事件  
52.  this.errorEmitted = false;  
53.  // 缓存的buffer数  
54.  this.bufferedRequestCount = 0;  
55.  var corkReq = { next: null, entry: null, finish: undefined };  
56.  corkReq.finish = onCorkedFinish.bind(undefined, corkReq, this);  
57.  // 空闲的节点，可用于缓存数据  
58.  this.corkedRequestsFree = corkReq;  
59.}  
```

看一下可写流这边的实现

```c
1.function Writable(options) {  
2.  this._writableState = new WritableState(options, this);  
3.  // 可写  
4.  this.writable = true;  
5.  // 支持用户自定义的钩子  
6.  if (options) {  
7.    if (typeof options.write === 'function')  
8.      this._write = options.write;  
9.  
10.    if (typeof options.writev === 'function')  
11.      this._writev = options.writev;  
12.  
13.    if (typeof options.destroy === 'function')  
14.      this._destroy = options.destroy;  
15.  
16.    if (typeof options.final === 'function')  
17.      this._final = options.final;  
18.  }  
19.  
20.  Stream.call(this);  
21.}  
```

我们接着看通过write函数实现数据写入的逻辑。写入有两种方式。一个是逐个写write，一个是批量写_writev。我们逐个看一下。

```c
1.Writable.prototype.write = function(chunk, encoding, cb) {  
2.  var state = this._writableState;  
3.  var ret = false;  
4.  var isBuf = !state.objectMode && Stream._isUint8Array(chunk);  
5.  // 转成buffer格式  
6.  if (isBuf && Object.getPrototypeOf(chunk) !== Buffer.prototype) {  
7.    chunk = Stream._uint8ArrayToBuffer(chunk);  
8.  }  
9.  // 参数处理，传了数据和回调，没有传编码类型  
10.  if (typeof encoding === 'function') {  
11.    cb = encoding;  
12.    encoding = null;  
13.  }  
14.  // 是buffer类型则设置成buffer，否则如果没传则取默认编码  
15.  if (isBuf)  
16.    encoding = 'buffer';  
17.  else if (!encoding)  
18.    encoding = state.defaultEncoding;  
19.  
20.  if (typeof cb !== 'function')  
21.    cb = nop;  
22.  // 正在执行end，再执行write，报错  
23.  if (state.ending)  
24.    writeAfterEnd(this, cb);  
25.  else if (isBuf || validChunk(this, state, chunk, cb)) {  
26.    // 待执行的回调数加一，即cb  
27.    state.pendingcb++;  
28.    // 写入或缓存，见该函数  
29.    ret = writeOrBuffer(this, state, isBuf, chunk, encoding, cb);  
30.  }  
31.  
32.  return ret;  
33.}  
```

我们继续看writeOrBuffer

```c
1.// 写入数据或缓存在buffer里  
2.function writeOrBuffer(stream, state, isBuf, chunk, encoding, cb) {  
3.  // 忽略编码处理  
4.  // 对象模式的算一个  
5.  var len = state.objectMode ? 1 : chunk.length;  
6.  // 更新待写入数据长度或对象个数  
7.  state.length += len;  
8.  // 待写入的长度超过了阈值  
9.  var ret = state.length < state.highWaterMark;  
10.  // 超过了阈值，则设置需要等待drain事件标记  
11.  if (!ret)  
12.    state.needDrain = true;  
13.  // 如果正在写或者设置了阻塞则先缓存数据  
14.  if (state.writing || state.corked) {  
15.    // 指向当前节点  
16.    var last = state.lastBufferedRequest;  
17.    // 插入新的头结点  
18.    state.lastBufferedRequest = {  
19.      chunk,  
20.      encoding,  
21.      isBuf,  
22.      callback: cb,  
23.      next: null  
24.    };  
25.    // 之前还有节点的话，新的头节点的next指针指向他，形成链表  
26.    if (last) {  
27.      last.next = state.lastBufferedRequest;  
28.    } else {  
29.      // 指向buffer链表，插入第一个buffer节点的时候执行到这  
30.      state.bufferedRequest = state.lastBufferedRequest;  
31.    }  
32.    // 缓存的buffer个数加一  
33.    state.bufferedRequestCount += 1;  
34.  } else {  
35.    // 直接写入  
36.    doWrite(stream, state, false, len, chunk, encoding, cb);  
37.  }  
38.  // 返回是否可以接着写  
39.  return ret;  
40.}  
```

如果正在写入或者阻塞了写入，则把数据缓存起来，否则直接写入

```c
1.function doWrite(stream, state, writev, len, chunk, encoding, cb) {  
2.  // 本次写入的数据长度  
3.  state.writelen = len;  
4.  // 写入后执行的回调  
5.  state.writecb = cb;  
6.  // 正在写入  
7.  state.writing = true;  
8.  // 同步写入的标记  
9.  state.sync = true;  
10.  if (writev)  
11.    // chunk为缓存待写入的buffer节点数组  
12.    stream._writev(chunk, state.onwrite);  
13.  else  
14.    // 执行用户定义的写函数，onwrite是nodejs定义的，在初始化的时候设置了该函数，即下面的onwrite函数  
15.    stream._write(chunk, encoding, state.onwrite);  
16.  state.sync = false;  
17.}  
```

我们看到如果写入的数据比阈值大，可写流还是会执行写入操作，但是会返回false告诉用户些不要写入了，如果调用方继续写入的话，也是没问题的。真正的写入操作由调用方实现，当写入成功，会执行onwrite函数。

```c
1.// 写完时执行的回调  
2.function onwrite(stream, er) {  
3.  var state = stream._writableState;  
4.  var sync = state.sync;  
5.  // 本次写完时执行的回调  
6.  var cb = state.writecb;  
7.  // 重置内部字段的值  
8.  // 写完了，重置回调，还有多少单位的数据没有写入，数据写完，重置本次待写入的数据数为0  
9.  state.writing = false;  
10.  state.writecb = null;  
11.  state.length -= state.writelen;  
12.  state.writelen = 0;  
13.  
14.  if (er)  
15.    onwriteError(stream, state, sync, er, cb);  
16.  else {  
17.    // Check if we're actually ready to finish, but don't emit yet  
18.    // 是否需要触发finish事件  
19.    var finished = needFinish(stat);  
20.    // 还不需要触发finish事件，并且没有设置阻塞标记，也不在处理buffer，并且有待处理的buffer，则处理buffer，进行写入  
21.    if (!finished &&  
22.        !state.corked &&  
23.        !state.bufferProcessing &&  
24.        state.bufferedRequest) {  
25.      clearBuffer(stream, state);  
26.    }  
27.    // 执行afterWrite  
28.    if (sync) {  
29.      process.nextTick(afterWrite, stream, state, finished, cb);  
30.    } else {  
31.      afterWrite(stream, state, finished, cb);  
32.    }  
33.  }  
34.}  
```

更新一些流的字段后，执行afterWrite

```c
1.function afterWrite(stream, state, finished, cb) {  
2.  // 还没结束，看是否需要触发drain事件  
3.  if (!finished)  
4.    onwriteDrain(stream, state);  
5.  // 准备执行用户回调，待执行的回调减一  
6.  state.pendingcb--;  
7.  cb();  
8.  finishMaybe(stream, state);  
9.}  
10.  
11.function onwriteDrain(stream, state) {  
12.  // 没有需要需要写了，并且流在阻塞中等待drain事件  
13.  if (state.length === 0 && state.needDrain) {  
14.    // 触发drain事件然后清空标记  
15.    state.needDrain = false;  
16.    stream.emit('drain');  
17.  }  
18.}  
```

当写完数据后，会判断流是否已经结束（比如在回调了执行了end）

```c
1.function finishMaybe(stream, state) {  
2.  // 流是否已经结束  
3.  var need = needFinish(state);  
4.  // 是则先处理prefinish事件  
5.  if (need) {  
6.    prefinish(stream, state);  
7.    // 如果没有待执行的回调，则触发finish事件  
8.    if (state.pendingcb === 0) {  
9.      state.finished = true;  
10.      stream.emit('finish');  
11.    }  
12.  }  
13.  return need;  
14.}  
```

我们看到会先触发prefinish事件，

```c
1.function prefinish(stream, state) {  
2.  // 还没触发prefinish并且没有执行finalcall  
3.  if (!state.prefinished && !state.finalCalled) {  
4.    // 用户传了final函数则，待执行回调数加一，即callFinal，否则直接触发prefinish  
5.    if (typeof stream._final === 'function') {  
6.      state.pendingcb++;  
7.      state.finalCalled = true;  
8.      process.nextTick(callFinal, stream, state);  
9.    } else {  
10.      state.prefinished = true;  
11.      stream.emit('prefinish');  
12.    }  
13.  }  
14.}  
```

Prefinish事件的处理中，如果用户自定义_final函数，则先执行callFinal

```c
1.function callFinal(stream, state) {  
2.  // 执行用户的final函数  
3.  stream._final((err) => {  
4.    // 执行了callFinal函数，cb减一  
5.    state.pendingcb--;  
6.    if (err) {  
7.      stream.emit('error', err);  
8.    }  
9.    // 执行prefinish  
10.    state.prefinished = true;  
11.    stream.emit('prefinish');  
12.    // 是否可以触发finish事件  
13.    finishMaybe(stream, state);  
14.  });  
15.}  
```

callFinal处理完后会触发prefinish，最后触发finish事件。
## 18.4 双向流
双向流是继承可读、可写的流。

```c
1.function Duplex(options) {  
2.  if (!(this instanceof Duplex))  
3.    return new Duplex(options);  
4.  
5.  Readable.call(this, options);  
6.  Writable.call(this, options);  
7.  // 双向流默认可读  
8.  if (options && options.readable === false)  
9.    this.readable = false;  
10.  // 双向流默认可写  
11.  if (options && options.writable === false)  
12.    this.writable = false;  
13.  // 默认允许半开关  
14.  this.allowHalfOpen = true;  
15.  if (options && options.allowHalfOpen === false)  
16.    this.allowHalfOpen = false;  
17.  
18.  this.once('end', onend);  
19.}  
```

双向流实现了以下功能
### 18.4.1 销毁 
如果读写两端都销毁，则双向流销毁。

```c
1.Object.defineProperty(Duplex.prototype, 'destroyed', {  
2.  enumerable: false,  
3.  get() {  
4.    if (this._readableState === undefined ||  
5.        this._writableState === undefined) {  
6.      return false;  
7.    }  
8.    return this._readableState.destroyed && this._writableState.destroyed;  
9.  }  
10.} 
```

 
我们看如果销毁一个双向流。

```c
1.Duplex.prototype._destroy = function(err, cb) {  
2.  // 关闭读端  
3.  this.push(null);  
4.  // 关闭写端  
5.  this.end();  
6.  
7.  process.nextTick(cb, err);  
8.};  
```

还可以单独关闭写端。

```c
1.// 关闭写流  
2.function onend() {  
3.  // 允许半开关则直接返回，写流已经结束则返回  
4.  if (this.allowHalfOpen || this._writableState.ended)  
5.    return;  
6.  // 下一个tick再关闭写流，执行完这段代码，用户还可以写  
7.  process.nextTick(onEndNT, this);  
8.}  
9.  
10.function onEndNT(self) {  
11.  // 调用写端的end函数  
12.  self.end();  
13.}  
```

更多阅读：[nodejs源码解析之可写流](https://zhuanlan.zhihu.com/p/354682694)
