文件操作是我们使用Node.js时经常会用到的功能。Node.js中，文件模块的API几乎都提供了同步和异步的版本。同步的API直接在主线程中调用操作系统提供的接口，它会导致主线程阻塞。异步API则是在Libuv提供的线程池中执行阻塞式API实现的。这样就不会导致主线程阻塞。文件IO不同于网络IO，文件IO由于兼容性问题，无法像网络IO一样利用操作系统提供的能力直接实现异步。在Libuv中，文件操作是以线程池实现的，操作文件的时候，会阻塞在某个线程。所以这种异步只是对用户而言。文件模块虽然提供的接口非常多，源码也几千行，但是很多逻辑都是类似的，所以我们只讲解不同的地方。介绍文件模块之前先介绍一下Linux操作系统中的文件。

Linux系统中万物皆文件，从应用层来看，我们拿到都是一个文件描述符，我们操作的也是这个文件描述符。使用起来非常简单，那是因为操作系统帮我们做了很多事情。简单来说，文件描述符只是一个索引。它的底层可以对应各种各样的资源，包括普通文件，网络，内存等。当我们操作一个资源之前，我们首先会调用操作系统的接口拿到一个文件描述符，操作系统也记录了这个文件描述符底层对应的资源、属性、操作函数等。当我们后续操作这个文件描述符的时候，操作系统就会执行对应的操作。比如我们在write的时候，传的文件描述符是普通文件和网络socket，底层所做的操作是不一样的。但是我们一般不需要关注这些。我们只需要从抽象的角度去使用它。本章介绍Node.js中关于文件模块的原理和实现。
## 12.1 同步API
在Node.js中，同步API的本质是直接在主线程里调用操作系统提供的系统调用。下面以readFileSync为例，看一下整体的流程，如图12-1所示。  
![](https://img-blog.csdnimg.cn/30843926b91a40f28cf763d9b0656e74.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图12-1

下面我们看一下具体的代码

```
1.	function readFileSync(path, options) {  
2.	  options = getOptions(options, { flag: 'r' });  
3.	  // 传的是fd还是文件路径  
4.	  const isUserFd = isFd(path);   
5.	  // 传的是路径，则先同步打开文件  
6.	  const fd = isUserFd ? path : fs.openSync(path, options.flag, 0o666);  
7.	  // 查看文件的stat信息，拿到文件的大小  
8.	  const stats = tryStatSync(fd, isUserFd);  
9.	  // 是否是一般文件  
10.	  const size = isFileType(stats, S_IFREG) ? stats[8] : 0;  
11.	  let pos = 0;  
12.	  let buffer; 
13.	  let buffers;  
14.	  // 文件大小是0或者不是一般文件，size则为0  
15.	  if (size === 0) {  
16.	    buffers = [];  
17.	  } else {  
18.	    // 一般文件且有大小，则分配一个大小为size的buffer，size需要小于2G  
19.	    buffer = tryCreateBuffer(size, fd, isUserFd);  
20.	  }  
21.	  
22.	  let bytesRead;  
23.	  // 不断地同步读文件内容  
24.	  if (size !== 0) {  
25.	    do {  
26.	      bytesRead = tryReadSync(fd, isUserFd, buffer, pos, size - pos);  
27.	      pos += bytesRead;  
28.	    } while (bytesRead !== 0 && pos < size);  
29.	  } else {  
30.	    do {  
31.	      /* 
32.	        文件大小为0，或者不是一般文件，也尝试去读， 
33.	        但是因为不知道大小，所以只能分配一个一定大小的buffer, 
34.	        每次读取一定大小的内容 
35.	      */  
36.	      buffer = Buffer.allocUnsafe(8192);  
37.	      bytesRead = tryReadSync(fd, isUserFd, buffer, 0, 8192);  
38.	      // 把读取到的内容放到buffers里  
39.	      if (bytesRead !== 0) {  
40.	        buffers.push(buffer.slice(0, bytesRead));  
41.	      }  
42.	      // 记录读取到的数据长度  
43.	      pos += bytesRead;  
44.	    } while (bytesRead !== 0);  
45.	  }  
46.	  // 用户传的是文件路径，Node.js自己打开了文件，所以需要自己关闭  
47.	  if (!isUserFd)  
48.	    fs.closeSync(fd);  
49.	  // 文件大小是0或者非一般文件的话，如果读到了内容  
50.	  if (size === 0) {  
51.	    // 把读取到的所有内容放到buffer中  
52.	    buffer = Buffer.concat(buffers, pos);  
53.	  } else if (pos < size) {  
54.	    buffer = buffer.slice(0, pos);  
55.	  }  
56.	  // 编码
57.	  if (options.encoding) buffer = buffer.toString(options.encoding);  
58.	  return buffer;  
59.	}  
```

tryReadSync调用的是fs.readSync，然后到binding.read(node_file.cc中定义的Read函数)。Read函数主要逻辑如下

```
1.	FSReqWrapSync req_wrap_sync;  
2.	const int bytesRead = SyncCall(env, 
3.	                                   args[6], 
4.	                                   &req_wrap_sync, 
5.	                                   "read",
6.	                                   uv_fs_read, 
7.	                                   fd, 
8.	                                   &uvbuf, 
9.	                                   1, 
10.	                                   pos);  
```

我们看一下SyncCall的实现

```
1.	int SyncCall(Environment* env, 
2.	              v8::Local<v8::Value> ctx,  
3.	       FSReqWrapSync* req_wrap, 
4.	              const char* syscall,  
5.	       Func fn, 
6.	              Args... args) {  
7.	  /*
8.	     req_wrap->req是一个uv_fs_t结构体，属于request类，
9.	      管理一次文件操作的请求  
10.	    */
11.	  int err = fn(env->event_loop(), 
12.	                    &(req_wrap->req), 
13.	                    args..., 
14.	                    nullptr);  
15.	  // 忽略出错处理
16.	  return err;  
17.	}  
```

我们看到最终调用的是Libuv的uv_fs_read，并使用uv_fs_t管理本次请求。因为是阻塞式调用，所以Libuv会直接调用操作系统的系统调用read函数。这是Node.js中同步API的过程。 
## 12.2 异步API
文件系统的API中，异步的实现是依赖于Libuv的线程池的。Node.js把任务放到线程池，然后返回主线程继续处理其它事情，等到条件满足时，就会执行回调。我们以readFile为例讲解这个过程。异步读取文件的流程图，如图12-2所示。  
![](https://img-blog.csdnimg.cn/e85ea13f393c4e93aaa43f02512dab91.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图12-2

下面我们看具体的实现

```
1.	function readFile(path, options, callback) {  
2.	  callback = maybeCallback(callback || options);  
3.	  options = getOptions(options, { flag: 'r' });  
4.	  // 管理文件读的对象  
5.	  if (!ReadFileContext)  
6.	    ReadFileContext = require('internal/fs/read_file_context'); 
7.	  const context = new ReadFileContext(callback, options.encoding)
8.	  // 传的是文件路径还是fd  
9.	  context.isUserFd = isFd(path); // File descriptor ownership  
10.	  // C++层的对象，封装了uv_fs_t结构体，管理一次文件读请求  
11.	  const req = new FSReqCallback();  
12.	  req.context = context;  
13.	  // 设置回调，打开文件后，执行  
14.	  req.oncomplete = readFileAfterOpen;  
15.	  // 传的是fd，则不需要打开文件，下一个tick直接执行回调读取文件  
16.	  if (context.isUserFd) {  
17.	    process.nextTick(function tick() {  
18.	      req.oncomplete(null, path);  
19.	    });  
20.	    return;  
21.	  }  
22.	  
23.	  path = getValidatedPath(path);  
24.	  const flagsNumber = stringToFlags(options.flags);  
25.	  // 调用C++层open打开文件  
26.	  binding.open(pathModule.toNamespacedPath(path),  
27.	        flagsNumber,  
28.	        0o666,  
29.	        req);  
30.	}  
```

ReadFileContext对象用于管理文件读操作整个过程，FSReqCallback是对uv_fs_t的封装，每次读操作对于Libuv来说就是一次请求，该请求的上下文就是使用uv_fs_t表示。请求完成后，会执行FSReqCallback对象的oncomplete函数。所以我们继续看readFileAfterOpen。

```
1.	function readFileAfterOpen(err, fd) {  
2.	  const context = this.context;  
3.	  // 打开出错则直接执行用户回调，传入err  
4.	  if (err) {  
5.	    context.callback(err);  
6.	    return;  
7.	  }  
8.	  // 保存打开文件的fd  
9.	  context.fd = fd;  
10.	  // 新建一个FSReqCallback对象管理下一个异步请求和回调  
11.	  const req = new FSReqCallback();  
12.	  req.oncomplete = readFileAfterStat;  
13.	  req.context = context;  
14.	  // 获取文件的元数据，拿到文件大小  
15.	  binding.fstat(fd, false, req);  
16.	}  
```

拿到文件的元数据后，执行readFileAfterStat，这段逻辑和同步的类似，根据元数据中记录的文件大小，分配一个buffer用于后续读取文件内容。然后执行读操作。

```
1.	read() {  
2.	    let buffer;  
3.	    let offset;  
4.	    let length;  
5.	
6.	    // 省略部分buffer处理的逻辑  
7.	    const req = new FSReqCallback();  
8.	    req.oncomplete = readFileAfterRead;  
9.	    req.context = this;  
10.	
11.	    read(this.fd, buffer, offset, length, -1, req);  
12.	  }  
```

再次新建一个FSReqCallback对象管理异步读取操作和回调。我们看一下C++层read函数的实现。

```
1.	// 拿到C++层的FSReqCallback对象  
2.	FSReqBase* req_wrap_async = GetReqWrap(env, args[5]);  
3.	// 异步调用uv_fs_read  
4.	AsyncCall(env, req_wrap_async, args, "read", UTF8, AfterInteger,uv_fs_read, fd, &uvbuf, 1, pos);  
```

AsyncCall最后调用Libuv的uv_fs_read函数。我们看一下这个函数的关键逻辑。

```
1.	do {                        \  
2.	    if (cb != NULL) {          \  
3.	      uv__req_register(loop, req);  \  
4.	      uv__work_submit(loop,    \  
5.	                &req->work_req, \  
6.	                UV__WORK_FAST_IO, \  
7.	                uv__fs_work, \  
8.	                uv__fs_done); \  
9.	      return 0;               \  
10.	    }                          \  
11.	    else {                    \  
12.	      uv__fs_work(&req->work_req); \  
13.	      return req->result;     \  
14.	    }                           \  
15.	  }                            \  
16.	  while (0)  
```

uv__work_submit是给线程池提交一个任务，当子线程执行这个任务时，就会执行uv__fs_work，uv__fs_work会调用操作系统的系统调用read，可能会导致阻塞。等到读取成功后执行uv__fs_done。uv__fs_done会执行C++层的回调，从而执行JS层的回调。JS层的回调是readFileAfterRead，这里就不具体展开，readFileAfterRead的逻辑是判断是否读取完毕，是的话执行用户回调，否则继续发起读取操作。
## 12.3 文件监听
文件监听是非常常用的功能，比如我们修改了文件后webpack重新打包代码或者Node.js服务重启，都用到了文件监听的功能，Node.js提供了两套文件监听的机制。
### 12.3.1 基于轮询的文件监听机制
基于轮询机制的文件监听API是watchFile。流程如图12-3所示。  
![](https://img-blog.csdnimg.cn/94d2f921ebb44750be527e4b9abf5623.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图12-3

我们看一下具体实现。

```
1.	function watchFile(filename, options, listener) {  
2.	  filename = getValidatedPath(filename);  
3.	  filename = pathModule.resolve(filename);  
4.	  let stat;  
5.	  // 省略部分参数处理逻辑  
6.	  options = {  
7.	    interval: 5007,  
8.	    // 一直轮询  
9.	    persistent: true,  
10.	    ...options  
11.	  };  
12.	  
13.	  // 缓存处理，filename是否已经开启过监听  
14.	  stat = statWatchers.get(filename);  
15.	  
16.	  if (stat === undefined) {  
17.	    if (!watchers)  
18.	      watchers = require('internal/fs/watchers');  
19.	    stat = new watchers.StatWatcher(options.bigint);  
20.	    // 开启监听  
21.	    stat[watchers.kFSStatWatcherStart](filename,        
22.	                                           options.persistent, 
23.	                                           options.interval);  
24.	    // 更新缓存            
25.	    statWatchers.set(filename, stat);  
26.	  }  
27.	    
28.	  stat.addListener('change', listener);  
29.	  return stat;  
30.	}  
```

StatWatcher是管理文件监听的类，我们看一下watchers.kFSStatWatcherStart方法的实现。

```
1.	StatWatcher.prototype[kFSStatWatcherStart] = function(filename,persistent, interval) {  
2.	  this._handle = new _StatWatcher(this[kUseBigint]);  
3.	  this._handle.onchange = onchange;  
4.	  filename = getValidatedPath(filename, 'filename'); 
5.	  const err = this._handle.start(toNamespacedPath(filename), 
6.	                                      interval);  
7.	}  
```

新建一个_StatWatcher对象，_StatWatcher是C++模块提供的功能（node_stat_watcher.cc），然后执行它的start方法。Start方法执行Libuv的uv_fs_poll_start开始监听文件。

```
1.	int uv_fs_poll_start(uv_fs_poll_t* handle,uv_fs_poll_cb cb,  
2.	const char* path, unsigned int interval) {  
3.	  // 管理文件监听的数据结构  
4.	  struct poll_ctx* ctx;  
5.	  uv_loop_t* loop;  
6.	  size_t len;  
7.	  int err;  
8.	  
9.	  loop = handle->loop;  
10.	  len = strlen(path);  
11.	    // calloc会把内存初始化为0
12.	  ctx = uv__calloc(1, sizeof(*ctx) + len);  
13.	  ctx->loop = loop;  
14.	    // C++层回调
15.	  ctx->poll_cb = cb;  
16.	  // 多久轮询一次  
17.	  ctx->interval = interval ? interval : 1;  
18.	  ctx->start_time = uv_now(loop);  
19.	  // 关联的handle  
20.	  ctx->parent_handle = handle;  
21.	  // 监听的文件路径  
22.	  memcpy(ctx->path, path, len + 1);  
23.	  // 初始化定时器结构体  
24.	  err = uv_timer_init(loop, &ctx->timer_handle);  
25.	  // 异步查询文件元数据  
26.	  err = uv_fs_stat(loop, &ctx->fs_req, ctx->path, poll_cb);  
27.	    
28.	  if (handle->poll_ctx != NULL)  
29.	    ctx->previous = handle->poll_ctx;  
30.	  // 关联负责管理轮询的对象  
31.	  handle->poll_ctx = ctx;  
32.	  uv__handle_start(handle);  
33.	  return 0;  
34.	}  
```

Start函数初始化一个poll_ctx结构体，用于管理文件监听，然后发起异步请求文件元数据的请求，获取元数据后，执行poll_cb回调。

```
1.	static void poll_cb(uv_fs_t* req) {  
2.	  uv_stat_t* statbuf;  
3.	  struct poll_ctx* ctx;  
4.	  uint64_t interval;  
5.	  // 通过结构体字段获取结构体首地址  
6.	  ctx = container_of(req, struct poll_ctx, fs_req);  
7.	  statbuf = &req->statbuf;  
8.	  /* 
9.	   第一次不执行回调，因为没有可对比的元数据，第二次及后续的操作才可能
10.	      执行回调，busy_polling初始化的时候为0，第一次执行的时候置
11.	      busy_polling=1 
12.	  */  
13.	  if (ctx->busy_polling != 0)  
14.	    // 出错或者stat发生了变化则执行回调  
15.	    if (ctx->busy_polling < 0 || 
16.	             !statbuf_eq(&ctx->statbuf, statbuf))  
17.	      ctx->poll_cb(ctx->parent_handle, 
18.	                         0,
19.	                        &ctx->statbuf, 
20.	                         statbuf);  
21.	  // 保存当前获取到的stat信息，置1  
22.	  ctx->statbuf = *statbuf;  
23.	  ctx->busy_polling = 1;  
24.	  
25.	out:  
26.	  uv_fs_req_cleanup(req);  
27.	  
28.	  if (ctx->parent_handle == NULL) { 
29.	    uv_close((uv_handle_t*)&ctx->timer_handle, timer_close_cb);  
30.	    return;  
31.	  }  
32.	  /* 
33.	    假设在开始时间点为1，interval为10的情况下执行了stat，stat
34.	        完成执行并执行poll_cb回调的时间点是3，那么定时器的超时时间
35.	        则为10-3=7，即7个单位后就要触发超时，而不是10，是因为stat
36.	        阻塞消耗了3个单位的时间，所以下次执行超时回调函数时说明从
37.	        start时间点开始算，已经经历了x单位各interval，然后超时回调里
38.	        又执行了stat函数，再到执行stat回调，这个时间点即now=start+x
39.	        单位个interval+stat消耗的时间。得出now-start为interval的
40.	        x倍+stat消耗，即对interval取余可得到stat消耗，所以当前轮，
41.	        定时器的超时时间为interval - ((now-start) % interval) 
42.	  */  
43.	  interval = ctx->interval;  
44.	  interval = (uv_now(ctx->loop) - ctx->start_time) % interval; 
45.	  
46.	  if (uv_timer_start(&ctx->timer_handle, timer_cb, interval, 0)) 
47.	    abort();  
48.	}  
```

基于轮询的监听文件机制本质上是不断轮询文件的元数据，然后和上一次的元数据进行对比，如果有不一致的就认为文件变化了，因为第一次获取元数据时，还没有可以对比的数据，所以不认为是文件变化，这时候开启一个定时器。隔一段时间再去获取文件的元数据，如此反复，直到用户调stop函数停止这个行为。下面是Libuv关于文件变化的定义。

```
1.	static int statbuf_eq(const uv_stat_t* a, const uv_stat_t* b) {
2.	  return a->st_ctim.tv_nsec == b->st_ctim.tv_nsec  
3.	      && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec  
4.	      && a->st_birthtim.tv_nsec == b->st_birthtim.tv_nsec  
5.	      && a->st_ctim.tv_sec == b->st_ctim.tv_sec  
6.	      && a->st_mtim.tv_sec == b->st_mtim.tv_sec  
7.	      && a->st_birthtim.tv_sec == b->st_birthtim.tv_sec  
8.	      && a->st_size == b->st_size  
9.	      && a->st_mode == b->st_mode  
10.	      && a->st_uid == b->st_uid  
11.	      && a->st_gid == b->st_gid  
12.	      && a->st_ino == b->st_ino  
13.	      && a->st_dev == b->st_dev  
14.	      && a->st_flags == b->st_flags  
15.	      && a->st_gen == b->st_gen;  
16.	}  
```

### 12.3.2基于inotify的文件监听机制
我们看到基于轮询的监听其实效率是很低的，因为需要我们不断去轮询文件的元数据，如果文件大部分时间里都没有变化，那就会白白浪费CPU。如果文件改变了会主动通知我们那就好了，这就是基于inotify机制的文件监听。Node.js提供的接口是watch。watch的实现和watchFile的比较类似。

```
1.	function watch(filename, options, listener) {  
2.	  // Don't make changes directly on options object  
3.	  options = copyObject(options);  
4.	  // 是否持续监听
5.	  if (options.persistent === undefined) 
6.	      options.persistent = true;  
7.	    // 如果是目录，是否监听所有子目录和文件的变化
8.	  if (options.recursive === undefined) 
9.	      options.recursive = false;  
10.	    // 有些平台不支持
11.	  if (options.recursive && !(isOSX || isWindows))  
12.	    throw new ERR_FEATURE_UNAVAILABLE_ON_PLATFORM('watch recursively');  
13.	  if (!watchers)  
14.	    watchers = require('internal/fs/watchers');  
15.	    // 新建一个FSWatcher对象管理文件监听，然后开启监听
16.	  const watcher = new watchers.FSWatcher();  
17.	  watcher[watchers.kFSWatchStart](filename,  
18.	                  options.persistent,  
19.	                  options.recursive,  
20.	                  options.encoding);  
21.	  
22.	  if (listener) {  
23.	    watcher.addListener('change', listener);  
24.	  }  
25.	  
26.	  return watcher;  
27.	}  
```

FSWatcher函数是对C++层FSEvent模块的封装。我们来看一下start函数的逻辑，start函数透过C++层调用了Libuv的uv_fs_event_start函数。在讲解uv_fs_event_start函数前，我们先了解一下inotify的原理和它在Libuv中的实现。inotify是Linux系统提供用于监听文件系统的机制。inotify机制的逻辑大致是  
1 init_inotify创建一个inotify的实例，返回一个文件描述符。类似epoll。  
2 inotify_add_watch往inotify实例注册一个需监听的文件（inotify_rm_watch是移除）。  
3 read(inotify实例对应的文件描述符, &buf, sizeof(buf))，如果没有事件触发，则阻塞（除非设置了非阻塞）。否则返回待读取的数据长度。buf就是保存了触发事件的信息。  
Libuv在inotify机制的基础上做了一层封装。我们看一下inotify在Libuv的架构图如图12-4所示。  
![](https://img-blog.csdnimg.cn/2b745c9ea2884e0484c54e6facc39419.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图12-4

我们再来看一下Libuv中的实现。我们从一个使用例子开始。

```
1.	int main(int argc, char **argv) {  
2.	    // 实现循环核心结构体loop  
3.	    loop = uv_default_loop();   
4.	    uv_fs_event_t *fs_event_req = malloc(sizeof(uv_fs_event_t));
5.	    // 初始化fs_event_req结构体的类型为UV_FS_EVENT  
6.	    uv_fs_event_init(loop, fs_event_req);  
7.	        /* 
8.	          argv[argc]是文件路径，
9.	          uv_fs_event_start 向底层注册监听文件argv[argc],
10.	          cb是事件触发时的回调 
11.	        */  
12.	    uv_fs_event_start(fs_event_req, 
13.	                          cb, 
14.	                          argv[argc], 
15.	                          UV_FS_EVENT_RECURSIVE);  
16.	    // 开启事件循环  
17.	    return uv_run(loop, UV_RUN_DEFAULT);  
18.	}  
```

Libuv在第一次监听文件的时候(调用uv_fs_event_start的时候)，会创建一个inotify实例。

```
1.	static int init_inotify(uv_loop_t* loop) {  
2.	  int err;  
3.	  // 初始化过了则直接返回       
4.	  if (loop->inotify_fd != -1)  
5.	    return 0;  
6.	  /*
7.	      调用操作系统的inotify_init函数申请一个inotify实例，
8.	      并设置UV__IN_NONBLOCK，UV__IN_CLOEXEC标记  
9.	    */
10.	  err = new_inotify_fd();  
11.	  if (err < 0)  
12.	    return err;  
13.	  // 记录inotify实例对应的文件描述符,一个事件循环一个inotify实例  
14.	  loop->inotify_fd = err;  
15.	  /*
16.	      inotify_read_watcher是一个IO观察者，
17.	      uv__io_init设置IO观察者的文件描述符（待观察的文件）和回调  
18.	    */
19.	  uv__io_init(&loop->inotify_read_watcher, 
20.	                uv__inotify_read, 
21.	                loop->inotify_fd);  
22.	  // 往Libuv中注册该IO观察者，感兴趣的事件为可读  
23.	  uv__io_start(loop, &loop->inotify_read_watcher, POLLIN);  
24.	  
25.	  return 0;  
26.	}  
```

Libuv把inotify实例对应的fd通过uv__io_start注册到epoll中，当有文件变化的时候，就会执行回调uv__inotify_read。分析完Libuv申请inotify实例的逻辑，我们回到main函数看看uv_fs_event_start函数。用户使用uv_fs_event_start函数来往Libuv注册一个待监听的文件。我们看看实现。

```
1.	int uv_fs_event_start(uv_fs_event_t* handle,  
2.	                      uv_fs_event_cb cb,  
3.	                      const char* path,  
4.	                      unsigned int flags) {  
5.	  struct watcher_list* w;  
6.	  int events;  
7.	  int err;  
8.	  int wd;  
9.	  
10.	  if (uv__is_active(handle))  
11.	    return UV_EINVAL;  
12.	  // 申请一个inotify实例  
13.	  err = init_inotify(handle->loop);  
14.	  if (err)  
15.	    return err;  
16.	  // 监听的事件  
17.	  events = UV__IN_ATTRIB  
18.	         | UV__IN_CREATE  
19.	         | UV__IN_MODIFY  
20.	         | UV__IN_DELETE  
21.	         | UV__IN_DELETE_SELF  
22.	         | UV__IN_MOVE_SELF  
23.	         | UV__IN_MOVED_FROM  
24.	         | UV__IN_MOVED_TO;  
25.	  // 调用操作系统的函数注册一个待监听的文件，返回一个对应于该文件的id  
26.	  wd = uv__inotify_add_watch(handle->loop->inotify_fd, path, events);  
27.	  if (wd == -1)  
28.	    return UV__ERR(errno);  
29.	  // 判断该文件是不是已经注册过了  
30.	  w = find_watcher(handle->loop, wd);  
31.	  // 已经注册过则跳过插入的逻辑  
32.	  if (w)  
33.	    goto no_insert;  
34.	  // 还没有注册过则插入Libuv维护的红黑树  
35.	  w = uv__malloc(sizeof(*w) + strlen(path) + 1);  
36.	  if (w == NULL)  
37.	    return UV_ENOMEM;  
38.	  
39.	  w->wd = wd;  
40.	  w->path = strcpy((char*)(w + 1), path);  
41.	  QUEUE_INIT(&w->watchers);  
42.	  w->iterating = 0;  
43.	  // 插入Libuv维护的红黑树,inotify_watchers是根节点  
44.	  RB_INSERT(watcher_root, CAST(&handle->loop->inotify_watchers), w);  
45.	  
46.	no_insert:  
47.	  // 激活该handle  
48.	  uv__handle_start(handle);  
49.	  // 同一个文件可能注册了很多个回调，w对应一个文件，注册在用一个文件的回调排成队  
50.	  QUEUE_INSERT_TAIL(&w->watchers, &handle->watchers);  
51.	  // 保存信息和回调  
52.	  handle->path = w->path;  
53.	  handle->cb = cb;  
54.	  handle->wd = wd;  
55.	  
56.	  return 0;  
57.	}  
```

下面我们逐步分析上面的函数逻辑。  
1 如果是首次调用该函数则新建一个inotify实例。并且往Libuv插入一个观察者io，Libuv会在Poll IO阶段注册到epoll中。  
2 往操作系统注册一个待监听的文件。返回一个id。  
3 Libuv判断该id是不是在自己维护的红黑树中。不在红黑树中，则插入红黑树。返回一个红黑树中对应的节点。把本次请求的信息封装到handle中（回调时需要）。然后把handle插入刚才返回的节点的队列中。  
这时候注册过程就完成了。Libuv在Poll IO阶段如果检测到有文件发生变化，则会执行回调uv__inotify_read。

```
1.	static void uv__inotify_read(uv_loop_t* loop,  
2.	                             uv__io_t* dummy,  
3.	                             unsigned int events) {  
4.	  const struct uv__inotify_event* e;  
5.	  struct watcher_list* w;  
6.	  uv_fs_event_t* h;  
7.	  QUEUE queue;  
8.	  QUEUE* q;  
9.	  const char* path;  
10.	  ssize_t size;  
11.	  const char *p;  
12.	  /* needs to be large enough for sizeof(inotify_event) + strlen(path) */  
13.	  char buf[4096];  
14.	  // 一次可能没有读完  
15.	  while (1) {  
16.	    do  
17.	      // 读取触发的事件信息，size是数据大小，buffer保存数据  
18.	      size = read(loop->inotify_fd, buf, sizeof(buf));  
19.	    while (size == -1 && errno == EINTR);  
20.	    // 没有数据可取了  
21.	    if (size == -1) {  
22.	      assert(errno == EAGAIN || errno == EWOULDBLOCK);  
23.	      break;  
24.	    }  
25.	    // 处理buffer的信息  
26.	    for (p = buf; p < buf + size; p += sizeof(*e) + e->len) {  
27.	      // buffer里是多个uv__inotify_event结构体，里面保存了事件信息和文件对应的id（wd字段）  
28.	      e = (const struct uv__inotify_event*)p;  
29.	  
30.	      events = 0;  
31.	      if (e->mask & (UV__IN_ATTRIB|UV__IN_MODIFY))  
32.	        events |= UV_CHANGE;  
33.	      if (e->mask & ~(UV__IN_ATTRIB|UV__IN_MODIFY))  
34.	        events |= UV_RENAME;  
35.	      // 通过文件对应的id（wd字段）从红黑树中找到对应的节点  
36.	      w = find_watcher(loop, e->wd);  
37.	  
38.	      path = e->len ? (const char*) (e + 1) : uv__basename_r(w->path);  
39.	      w->iterating = 1;  
40.	      // 把红黑树中，wd对应节点的handle队列移到queue变量，准备处理  
41.	      QUEUE_MOVE(&w->watchers, &queue);  
42.	      while (!QUEUE_EMPTY(&queue)) {  
43.	          // 头结点  
44.	        q = QUEUE_HEAD(&queue);  
45.	        // 通过结构体偏移拿到首地址  
46.	        h = QUEUE_DATA(q, uv_fs_event_t, watchers);  
47.	        // 从处理队列中移除  
48.	        QUEUE_REMOVE(q);  
49.	        // 放回原队列  
50.	        QUEUE_INSERT_TAIL(&w->watchers, q);  
51.	        // 执行回调  
52.	        h->cb(h, path, events, 0);  
53.	      }  
54.	    }  
55.	  }  
56.	}  
```

uv__inotify_read函数的逻辑就是从操作系统中把数据读取出来，这些数据中保存了哪些文件触发了用户感兴趣的事件。然后遍历每个触发了事件的文件。从红黑树中找到该文件对应的红黑树节点。再取出红黑树节点中维护的一个handle队列，最后执行handle队列中每个节点的回调。
## 12.4 Promise化API
Node.js的API都是遵循callback模式的，比如我们要读取一个文件的内容。我们通常会这样写

```
1.	const fs = require('fs');  
2.	fs.readFile('filename', 'utf-8' ,(err,data) => {  
3.	  console.log(data)  
4.	})  
为了支持Promise模式，我们通常这样写
1.	const fs = require('fs');  
2.	function readFile(filename) {  
3.	    return new Promise((resolve, reject) => {  
4.	        fs.readFile(filename, 'utf-8' ,(err,data) => {  
5.	            err ?  reject(err) : resolve(data);  
6.	        });  
7.	    });  
8.	}  
```

但是在Node.js V14中，文件模块支持了Promise化的api。我们可以直接使用await进行文件操作。我们看一下使用例子。

```
1.	const { open, readFile } = require('fs').promises;  
2.	async function runDemo() {   
3.	  try {  
4.	    console.log(await readFile('11111.md', { encoding: 'utf-8' }));  
5.	  } catch (e){  
6.	  
7.	  }  
8.	}  
9.	runDemo();  
```

从例子中我们看到，和之前的API调用方式类似，不同的地方在于我们不用再写回调了，而是通过await的方式接收结果。这只是新版API的特性之一。在新版API之前，文件模块大部分API都是类似工具函数，比如readFile，writeFile，新版API中支持面向对象的调用方式。

```
1.	const { open, readFile } = require('fs').promises;  
2.	async function runDemo() {  
3.	  let filehandle;  
4.	  try {  
5.	    filehandle = await open('filename', 'r');  
6.	    // console.log(await readFile(filehandle, { encoding: 'utf-8' }));  
7.	    console.log(await filehandle.readFile({ encoding: 'utf-8' }));  
8.	  } finally {  
9.	    if (filehandle) {  
10.	        await filehandle.close();     
11.	    }  
12.	  }  
13.	}  
14.	runDemo();  
```

面向对象的模式中，我们首先需要通过open函数拿到一个FileHandle对象（对文件描述符的封装），然后就可以在该对象上调各种文件操作的函数。在使用面向对象模式的API时有一个需要注意的地方是Node.js不会为我们关闭文件描述符，即使文件操作出错，所以我们需要自己手动关闭文件描述符，否则会造成文件描述符泄漏，而在非面向对象模式中，在文件操作完毕后，不管成功还是失败，Node.js都会为我们关闭文件描述符。下面我们看一下具体的实现。首先介绍一个FileHandle类。该类是对文件描述符的封装，提供了面向对象的API。

```
1.	class FileHandle {  
2.	  constructor(filehandle) {  
3.	    // filehandle为C++对象  
4.	    this[kHandle] = filehandle;  
5.	    this[kFd] = filehandle.fd;  
6.	  }  
7.	  
8.	  get fd() {  
9.	    return this[kFd];  
10.	  }  
11.	  
12.	  readFile(options) {  
13.	    return readFile(this, options);  
14.	  }  
15.	  
16.	  close = () => {  
17.	    this[kFd] = -1;  
18.	    return this[kHandle].close();  
19.	  }  
20.	  // 省略部分操作文件的api  
21.	}  
```

FileHandle的逻辑比较简单，首先封装了一系列文件操作的API，然后实现了close函数用于关闭底层的文件描述符。
1 操作文件系统API
这里我们以readFile为例进行分析

```
1.	async function readFile(path, options) {  
2.	  options = getOptions(options, { flag: 'r' });  
3.	  const flag = options.flag || 'r';  
4.	  // 以面向对象的方式使用，这时候需要自己关闭文件描述符  
5.	  if (path instanceof FileHandle)  
6.	    return readFileHandle(path, options);  
7.	  // 直接调用，首先需要先打开文件描述符，读取完毕后Node.js会主动关闭文件描述符  
8.	  const fd = await open(path, flag, 0o666);  
9.	  return readFileHandle(fd, options).finally(fd.close);  
10.	}  
```

从readFile代码中我们看到不同调用方式下，Node.js的处理是不一样的，当FileHandle是我们维护时，关闭操作也是我们负责执行，当FileHandle是Node.js维护时，Node.js在文件操作完毕后，不管成功还是失败都会主动关闭文件描述符。接着我们看到readFileHandle的实现。

```
1.	async function readFileHandle(filehandle, options) {  
2.	  // 获取文件元信息  
3.	  const statFields = await binding.fstat(filehandle.fd, false, kUsePromises);  
4.	  
5.	  let size;  
6.	  // 是不是普通文件，根据文件类型获取对应大小  
7.	  if ((statFields[1/* mode */] & S_IFMT) === S_IFREG) {  
8.	    size = statFields[8/* size */];  
9.	  } else {  
10.	    size = 0;  
11.	  }  
12.	  // 太大了  
13.	  if (size > kIoMaxLength)  
14.	    throw new ERR_FS_FILE_TOO_LARGE(size);  
15.	  
16.	  const chunks = [];  
17.	  // 计算每次读取的大小  
18.	  const chunkSize = size === 0 ?  
19.	    kReadFileMaxChunkSize :  
20.	    MathMin(size, kReadFileMaxChunkSize);  
21.	  let endOfFile = false;  
22.	  do {  
23.	    // 分配内存承载数据  
24.	    const buf = Buffer.alloc(chunkSize);  
25.	    // 读取的数据和大小  
26.	    const { bytesRead, buffer } =  
27.	      await read(filehandle, buf, 0, chunkSize, -1);  
28.	    // 是否读完了  
29.	    endOfFile = bytesRead === 0;  
30.	    // 读取了有效数据则把有效数据部分存起来  
31.	    if (bytesRead > 0)  
32.	      chunks.push(buffer.slice(0, bytesRead));  
33.	  } while (!endOfFile);  
34.	  
35.	  const result = Buffer.concat(chunks);  
36.	  if (options.encoding) {  
37.	    return result.toString(options.encoding);  
38.	  } else {  
39.	    return result;  
40.	  }  
41.	}  
```

接着我们看read函数的实现

```
1.	async function read(handle, buffer, offset, length, position) {  
2.	  // ...  
3.	  const bytesRead = (await binding.read(handle.fd, buffer, offset, length, position, kUsePromises)) || 0;  
4.	  return { bytesRead, buffer };  
5.	}  
```

Read最终执行了node_file.cc 的Read。我们看一下Read函数的关键代码。

```
1.	static void Read(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	  // ...  
4.	  FSReqBase* req_wrap_async = GetReqWrap(env, args[5]);  
5.	  // 异步执行，有两种情况  
6.	  if (req_wrap_async != nullptr) {  
7.	    AsyncCall(env, req_wrap_async, args, "read", UTF8, AfterInteger,  
8.	              uv_fs_read, fd, &uvbuf, 1, pos);  
9.	  } else {  
10.	    // 同步执行，比如fs.readFileSync  
11.	    CHECK_EQ(argc, 7);  
12.	    FSReqWrapSync req_wrap_sync;  
13.	    FS_SYNC_TRACE_BEGIN(read);  
14.	    const int bytesRead = SyncCall(env, args[6], &req_wrap_sync, "read",  
15.	                                   uv_fs_read, fd, &uvbuf, 1, pos);  
16.	    FS_SYNC_TRACE_END(read, "bytesRead", bytesRead);  
17.	    args.GetReturnValue().Set(bytesRead);  
18.	  }  
19.	}  
```

Read函数分为三种情况，同步和异步，其中异步又分为两种，callback模式和Promise模式。我们看一下异步模式的实现。我们首先看一下这句代码。

```
1.	FSReqBase* req_wrap_async = GetReqWrap(env, args[5]);  
```

GetReqWrap根据第六个参数获取对应的值。

```
1.	FSReqBase* GetReqWrap(Environment* env, v8::Local<v8::Value> value,  
2.	                      bool use_bigint) {  
3.	  // 是对象说明是继承FSReqBase的对象,比如FSReqCallback（异步模式）                      
4.	  if (value->IsObject()) {  
5.	    return Unwrap<FSReqBase>(value.As<v8::Object>());  
6.	  } else if (value->StrictEquals(env->fs_use_promises_symbol())) {  
7.	    // Promise模式（异步模式）  
8.	    if (use_bigint) {  
9.	      return FSReqPromise<AliasedBigUint64Array>::New(env, use_bigint);  
10.	    } else {  
11.	      return FSReqPromise<AliasedFloat64Array>::New(env, use_bigint);  
12.	    }  
13.	  }  
14.	  // 同步模式  
15.	  return nullptr;  
16.	}  
```

这里我们只关注Promise模式。所以GetReqWrap返回的是一个FSReqPromise对象，我们回到Read函数。看到以下代码

```
1.	FSReqBase* req_wrap_async = GetReqWrap(env, args[5]);  
2.	AsyncCall(env, req_wrap_async, args, "read", UTF8, AfterInteger,  
3.	              uv_fs_read, fd, &uvbuf, 1, pos);  
继续看AsyncCall函数（node_file-inl.h）
1.	template <typename Func, typename... Args>  
2.	FSReqBase* AsyncCall(Environment* env,  
3.	                     FSReqBase* req_wrap,  
4.	                     const v8::FunctionCallbackInfo<v8::Value>& args,  
5.	                     const char* syscall, enum encoding enc,  
6.	                     uv_fs_cb after, Func fn, Args... fn_args) {  
7.	  return AsyncDestCall(env, req_wrap, args,  
8.	                       syscall, nullptr, 0, enc,  
9.	                       after, fn, fn_args...);  
10.	}  
```

AsyncCall是对AsyncDestCall的封装

```
1.	template <typename Func, typename... Args>  
2.	FSReqBase* AsyncDestCall(Environment* env, FSReqBase* req_wrap,  
3.	                         const v8::FunctionCallbackInfo<v8::Value>& args,  
4.	                         const char* syscall, const char* dest,  
5.	                         size_t len, enum encoding enc, uv_fs_cb after,  
6.	                         Func fn, Args... fn_args) {  
7.	  CHECK_NOT_NULL(req_wrap);  
8.	  req_wrap->Init(syscall, dest, len, enc);  
9.	  // 调用libuv函数  
10.	  int err = req_wrap->Dispatch(fn, fn_args..., after);  
11.	  // 失败则直接执行回调，否则返回一个Promise，见SetReturnValue函数  
12.	  if (err < 0) {  
13.	    uv_fs_t* uv_req = req_wrap->req();  
14.	    uv_req->result = err;  
15.	    uv_req->path = nullptr;  
16.	    after(uv_req);  // after may delete req_wrap if there is an error  
17.	    req_wrap = nullptr;  
18.	  } else {  
19.	    req_wrap->SetReturnValue(args);  
20.	  }  
21.	  
22.	  return req_wrap;  
23.	}  
```

AsyncDestCall函数主要做了两个操作，首先通过Dispatch调用底层Libuv的函数，比如这里是uv_fs_read。如果出错执行回调返回错误，否则执行req_wrap->SetReturnValue(args)。我们知道req_wrap是在GetReqWrap函数中由FSReqPromise<AliasedBigUint64Array>::New(env, use_bigint)创建。

```
1.	template <typename AliasedBufferT>  
2.	FSReqPromise<AliasedBufferT>*  
3.	FSReqPromise<AliasedBufferT>::New(Environment* env, bool use_bigint) {  
4.	  v8::Local<v8::Object> obj;  
5.	  // 创建一个C++对象存到obj中  
6.	  if (!env->fsreqpromise_constructor_template()  
7.	           ->NewInstance(env->context())  
8.	           .ToLocal(&obj)) {  
9.	    return nullptr;  
10.	  }  
11.	  // 设置一个promise属性，值是一个Promise::Resolver  
12.	  v8::Local<v8::Promise::Resolver> resolver;  
13.	  if (!v8::Promise::Resolver::New(env->context()).ToLocal(&resolver) ||  
14.	      obj->Set(env->context(), env->promise_string(), resolver).IsNothing()) {  
15.	    return nullptr;  
16.	  }  
17.	  // 返回另一个C++对象，里面保存了obj，obj也保存了指向FSReqPromise对象的指针  
18.	  return new FSReqPromise(env, obj, use_bigint);  
19.	}  
```

所以req_wrap是一个FSReqPromise对象。我们看一下FSReqPromise对象的SetReturnValue方法。

```
1.	template <typename AliasedBufferT>  
2.	void FSReqPromise<AliasedBufferT>::SetReturnValue(  
3.	    const v8::FunctionCallbackInfo<v8::Value>& args) {  
4.	  // 拿到Promise::Resolver对象  
5.	  v8::Local<v8::Value> val =  
6.	      object()->Get(env()->context(),  
7.	                    env()->promise_string()).ToLocalChecked();  
8.	  v8::Local<v8::Promise::Resolver> resolver = val.As<v8::Promise::Resolver>();  
9.	  // 拿到一个Promise作为返回值，即JS层拿到的值  
10.	  args.GetReturnValue().Set(resolver->GetPromise());  
11.	}  
```

至此我们看到了新版API实现的核心逻辑，正是这个Promise返回值。通过层层返回后，在JS层就拿到这个Promise，然后处于pending状态等待决议。我们继续看一下Promise决议的逻辑。在分析Read函数中我们看到执行Libuv的uv_fs_read函数时，设置的回调是AfterInteger。那么当读取文件成功后就会执行该函数。所以我们看看该函数的逻辑。

```
1.	void AfterInteger(uv_fs_t* req) {  
2.	  // 通过属性拿到对象的地址  
3.	  FSReqBase* req_wrap = FSReqBase::from_req(req);  
4.	  FSReqAfterScope after(req_wrap, req);  
5.	  
6.	  if (after.Proceed())  
7.	    req_wrap->Resolve(Integer::New(req_wrap->env()->isolate(), req->result));  
8.	}   
```

接着我们看一下Resolve

```
1.	template <typename AliasedBufferT>  
2.	void FSReqPromise<AliasedBufferT>::Resolve(v8::Local<v8::Value> value) {  
3.	  finished_ = true;  
4.	  v8::HandleScope scope(env()->isolate());  
5.	  InternalCallbackScope callback_scope(this);  
6.	  // 拿到保存的Promise对象，修改状态为resolve，并设置结果  
7.	  v8::Local<v8::Value> val =  
8.	      object()->Get(env()->context(),  
9.	                    env()->promise_string()).ToLocalChecked();  
10.	  v8::Local<v8::Promise::Resolver> resolver = val.As<v8::Promise::Resolver>();  
11.	  USE(resolver->Resolve(env()->context(), value).FromJust());  
12.	}
```

Resolve函数修改Promise的状态和设置返回值，从而JS层拿到这个决议的值。回到fs层

```
1.	const bytesRead = (await binding.read(handle.fd, 
2.	                                         buffer, 
3.	                                         offset, 
4.	                                         length,  
5.	                                      position, kUsePromises))|0;  
```

我们就拿到了返回值。
## 12.5 流式API
前面分析了Node.js中文件模块的多种文件操作的方式，不管是同步、异步还是Promise化的API，它们都有一个问题就是对于用户来说，文件操作都是一次性完成的，比如我们调用readFile读取一个文件时，Node.js会通过一次或多次调用操作系统的接口把所有的文件内容读到内存中，同样我们调用writeFile写一个文件时，Node.js会通过一次或多次调用操作系统接口把用户的数据写入硬盘，这对内存来说是非常有压力的。假设我们有这样的一个场景，我们需要读取一个文件的内容，然后返回给前端，如果我们直接读取整个文件内容，然后再执行写操作这无疑是非常消耗内存，也是非常低效的。

```
1.	const http = require('http');  
2.	const fs = require('fs');  
3.	const server = http.createServer((req, res) => {  
4.	  fs.readFile('11111.md', (err, data) => {  
5.	    res.end(data);  
6.	  })  
7.	}).listen(11111);  
```

这时候我们需要使用流式的API。

```
1.	const http = require('http');  
2.	const fs = require('fs');  
3.	const server = http.createServer((req, res) => {  
4.	  fs.createReadStream('11111.md').pipe(res);  
5.	}).listen(11111);  
```

流式API的好处在于文件的内容并不是一次性读取到内存的，而是部分读取，消费完后再继续读取。Node.js内部帮我们做了流量的控制，如图12-5所示。  
 ![](https://img-blog.csdnimg.cn/c062c8fc963e4416bf515e87d1c96260.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图12-5  
下面我们看一下Node.js流式API的具体实现。
### 12.5.1 可读文件流
可读文件流是对文件进行流式读取的抽象。我们可以通过fs.createReadStream创建一个文件可读流。文件可读流继承于可读流，所以我们可以以可读流的方式使用它。

```
1.	const fs = require('fs');  
2.	const { Writable } = require('stream');  
3.	class DemoWritable extends Writable {  
4.	  _write(data, encoding, cb) {  
5.	    console.log(data);  
6.	    cb(null);  
7.	  }  
8.	}  
9.	fs.createReadStream('11111.md').pipe(new DemoWritable);  
```

或者

```
1.	const fs = require('fs');  
2.	const readStream = fs.createReadStream('11111.md');  
3.	readStream.on('data', (data) => {  
4.	    console.log(data)  
5.	});  
```

我们看一下createReadStream的实现。

```
1.	fs.createReadStream = function(path, options) {  
2.	  return new ReadStream(path, options);  
3.	};  
```

CreateReadStream是对ReadStream的封装。

```
1.	function ReadStream(path, options) {  
2.	  if (!(this instanceof ReadStream))  
3.	    return new ReadStream(path, options);  
4.	  
5.	  options = copyObject(getOptions(options, {}));  
6.	  // 可读流的阈值  
7.	  if (options.highWaterMark === undefined)  
8.	    options.highWaterMark = 64 * 1024;  
9.	  
10.	  Readable.call(this, options);  
11.	  
12.	  handleError((this.path = getPathFromURL(path)));  
13.	  // 支持传文件路径或文件描述符  
14.	  this.fd = options.fd === undefined ? null : options.fd;  
15.	  this.flags = options.flags === undefined ? 'r' : options.flags;  
16.	  this.mode = options.mode === undefined ? 0o666 : options.mode;  
17.	  // 读取的开始和结束位置  
18.	  this.start = typeof this.fd !== 'number' && options.start === undefined ?  
19.	    0 : options.start;  
20.	  this.end = options.end;  
21.	  // 流出错或结束时是否自动销毁流  
22.	  this.autoClose = options.autoClose === undefined ? true : options.autoClose;  
23.	  this.pos = undefined;  
24.	  // 已读的字节数  
25.	  this.bytesRead = 0;  
26.	  // 流是否已经关闭  
27.	  this.closed = false;  
28.	  // 参数校验  
29.	  if (this.start !== undefined) {  
30.	    if (typeof this.start !== 'number') {  
31.	      throw new errors.TypeError('ERR_INVALID_ARG_TYPE',  
32.	                                 'start',  
33.	                                 'number',  
34.	                                 this.start);  
35.	    }  
36.	    // 默认读取全部内容  
37.	    if (this.end === undefined) {  
38.	      this.end = Infinity;  
39.	    } else if (typeof this.end !== 'number') {  
40.	      throw new errors.TypeError('ERR_INVALID_ARG_TYPE',  
41.	                                 'end',  
42.	                                 'number',  
43.	                                 this.end);  
44.	    }  
45.	  
46.	    // 从文件的哪个位置开始读，start是开始位置，pos是当前位置，初始化等于开始位置  
47.	    this.pos = this.start;  
48.	  }  
49.	  // 如果是根据一个文件名创建一个流，则首先打开这个文件  
50.	  if (typeof this.fd !== 'number')  
51.	    this.open();  
52.	  
53.	  this.on('end', function() {  
54.	    // 流结束时自动销毁流  
55.	    if (this.autoClose) {  
56.	      this.destroy();  
57.	    }  
58.	  });  
59.	}  
```

ReadStream初始化完后做了两个操作，首先调用open打开文件（如果需要的话），接着监听流结束事件，用户可以设置autoClose选项控制当流结束或者出错时是否销毁流，对于文件流来说，销毁流意味着关闭地方文件描述符。我们接着看一下open的实现

```
1.	// 打开文件  
2.	ReadStream.prototype.open = function() {  
3.	  var self = this;  
4.	  fs.open(this.path, this.flags, this.mode, function(er, fd) {  
5.	    if (er) {  
6.	      // 发生错误，是否需要自动销毁流  
7.	      if (self.autoClose) {  
8.	        self.destroy();  
9.	      }  
10.	      // 通知用户  
11.	      self.emit('error', er);  
12.	      return;  
13.	    }  
14.	  
15.	    self.fd = fd;  
16.	    // 触发open，一般用于Node.js内部逻辑  
17.	    self.emit('open', fd);  
18.	    // start the flow of data.  
19.	    // 打开成功后开始流式读取文件内容  
20.	    self.read();  
21.	  });  
22.	};  
```

open函数首先打开文件，打开成功后开启流式读取。从而文件内容就会源源不断地流向目的流。我们继续看一下读取操作的实现。

```
1.	// 实现可读流的钩子函数  
2.	ReadStream.prototype._read = function(n) {  
3.	  // 如果没有调用open而是直接调用该方法则先执行open  
4.	  if (typeof this.fd !== 'number') {  
5.	    return this.once('open', function() {  
6.	      this._read(n);  
7.	    });  
8.	  }  
9.	  // 流已经销毁则不处理  
10.	  if (this.destroyed)  
11.	    return;  
12.	  // 判断池子空间是否足够，不够则申请新的  
13.	  if (!pool || pool.length - pool.used < kMinPoolSpace) {  
14.	    // discard the old pool.  
15.	    allocNewPool(this.readableHighWaterMark);  
16.	  }  
17.	  
18.	  // 计算可读的最大数量  
19.	  var thisPool = pool;  
20.	  /* 
21.	    可读取的最大值,取可用内存大小和Node.js打算读取的大小 
22.	    中的小值,n不是用户想读取的大小，而是可读流内部的逻辑 
23.	    见_stream_readable.js的this._read(state.highWaterMark) 
24.	  */  
25.	  var toRead = Math.min(pool.length - pool.used, n);  
26.	  var start = pool.used;  
27.	  // 已经读取了部分了，则计算剩下读取的大小，和计算读取的toRead比较取小值  
28.	  if (this.pos !== undefined)  
29.	    toRead = Math.min(this.end - this.pos + 1, toRead);  
30.	  
31.	  // 读结束  
32.	  if (toRead <= 0)  
33.	    return this.push(null);  
34.	  
35.	  // pool.used是即将读取的数据存储在pool中的开始位置，this.pos是从文件的哪个位置开始读取  
36.	  fs.read(this.fd, pool, pool.used, toRead, this.pos, (er, bytesRead) => {  
37.	    if (er) {  
38.	      if (this.autoClose) {  
39.	        this.destroy();  
40.	      }  
41.	      this.emit('error', er);  
42.	    } else {  
43.	      var b = null;  
44.	      if (bytesRead > 0) {  
45.	        // 已读的字节数累加  
46.	        this.bytesRead += bytesRead;  
47.	        // 获取有效数据  
48.	        b = thisPool.slice(start, start + bytesRead);  
49.	      }  
50.	      // push到底层流的bufferList中，底层的push会触发data事件  
51.	      this.push(b);  
52.	    }  
53.	  });  
54.	  
55.	  // 重新设置已读指针的位置  
56.	  if (this.pos !== undefined)  
57.	    this.pos += toRead;  
58.	  pool.used += toRead;  
59.	};  
```

代码看起来很多，主要的逻辑是调用异步read函数读取文件的内容，然后放到可读流中，可读流会触发data事件通知用户有数据到来，然后继续执行read函数，从而不断驱动着数据的读取（可读流会根据当前情况判断是否继续执行read函数，以达到流量控制的目的）。最后我们看一下关闭和销毁一个文件流的实现。

```
1.	ReadStream.prototype.close = function(cb) {  
2.	  this.destroy(null, cb);  
3.	};  
```

当我们设置autoClose为false的时候，我们就需要自己手动调用close函数关闭可读文件流。关闭文件流很简单，就是正常地销毁流。我们看看销毁流的时候，Node.js做了什么。

```
1.	// 关闭底层文件  
2.	ReadStream.prototype._destroy = function(err, cb) {  
3.	  const isOpen = typeof this.fd !== 'number';  
4.	  if (isOpen) {  
5.	    this.once('open', closeFsStream.bind(null, this, cb, err));  
6.	    return;  
7.	  }  
8.	  
9.	  closeFsStream(this, cb);  
10.	  this.fd = null;  
11.	};  
12.	  
13.	function closeFsStream(stream, cb, err) {  
14.	  fs.close(stream.fd, (er) => {  
15.	    er = er || err;  
16.	    cb(er);  
17.	    stream.closed = true;  
18.	    if (!er)  
19.	      stream.emit('close');  
20.	  });  
21.	}  
```

销毁文件流就是关闭底层的文件描述符。另外如果是因为发生错误导致销毁或者关闭文件描述符错误则不会触发close事件。
### 12.5.2 可写文件流
可写文件流是对文件进行流式写入的抽象。我们可以通过fs.createWriteStream创建一个文件可写流。文件可些流继承于可写流，所以我们可以以可写流的方式使用它。

```
1.	const fs = require('fs');  
2.	const writeStream = fs.createWriteStream('123.md');
3.	writeStream.end('world');  
或者
1.	const fs = require('fs');  
2.	const { Readable } = require('stream');  
3.	  
4.	class DemoReadStream extends Readable {  
5.	    constructor() {  
6.	        super();  
7.	        this.i = 0;  
8.	    }  
9.	    _read(n) {  
10.	        this.i++;  
11.	        if (this.i > 10) {  
12.	            this.push(null);  
13.	        } else {  
14.	            this.push('1'.repeat(n));  
15.	        }  
16.	          
17.	    }  
18.	}  
19.	new DemoReadStream().pipe(fs.createWriteStream('123.md'));  
```

我们看一下createWriteStream的实现。

```
1.	fs.createWriteStream = function(path, options) {  
2.	  return new WriteStream(path, options);  
3.	};  
```

createWriteStream是对WriteStream的封装，我们看一下WriteStream的实现

```
1.	function WriteStream(path, options) {  
2.	  if (!(this instanceof WriteStream))  
3.	    return new WriteStream(path, options);  
4.	  options = copyObject(getOptions(options, {}));  
5.	  
6.	  Writable.call(this, options);  
7.	  
8.	  handleError((this.path = getPathFromURL(path)));  
9.	  this.fd = options.fd === undefined ? null : options.fd;  
10.	  this.flags = options.flags === undefined ? 'w' : options.flags;  
11.	  this.mode = options.mode === undefined ? 0o666 : options.mode;  
12.	  // 写入的开始位置  
13.	  this.start = options.start;  
14.	  // 流结束和触发错误的时候是否销毁流  
15.	  this.autoClose = options.autoClose === undefined ? true : !!options.autoClose;  
16.	  // 当前写入位置  
17.	  this.pos = undefined;  
18.	  // 写成功的字节数  
19.	  this.bytesWritten = 0;  
20.	  this.closed = false;  
21.	  
22.	  if (this.start !== undefined) {  
23.	    if (typeof this.start !== 'number') {  
24.	      throw new errors.TypeError('ERR_INVALID_ARG_TYPE',  
25.	                                 'start',  
26.	                                 'number',  
27.	                                 this.start);  
28.	    }  
29.	    if (this.start < 0) {  
30.	      const errVal = `{start: ${this.start}}`;  
31.	      throw new errors.RangeError('ERR_OUT_OF_RANGE',  
32.	                                  'start',  
33.	                                  '>= 0',  
34.	                                  errVal);  
35.	    }  
36.	    // 记录写入的开始位置  
37.	    this.pos = this.start;  
38.	  }  
39.	  
40.	  if (options.encoding)  
41.	    this.setDefaultEncoding(options.encoding);  
42.	  // 没有传文件描述符则打开一个新的文件  
43.	  if (typeof this.fd !== 'number')  
44.	    this.open();  
45.	  
46.	  // 监听可写流的finish事件，判断是否需要执行销毁操作  
47.	  this.once('finish', function() {  
48.	    if (this.autoClose) {  
49.	      this.destroy();  
50.	    }  
51.	  });  
52.	}  
```

WriteStream初始化了一系列字段后，如果传的是文件路径则打开文件，如果传的文件描述符则不需要再次打开文件。后续对文件可写流的操作就是对文件描述符的操作。我们首先看一下写入文件的逻辑。我们知道可写流只是实现了一些抽象的逻辑，具体的写逻辑是具体的流通过_write或者_writev实现的，我们看一下_write的实现。

```
1.	WriteStream.prototype._write = function(data, encoding, cb) {  
2.	  if (!(data instanceof Buffer)) {  
3.	    const err = new errors.TypeError('ERR_INVALID_ARG_TYPE',  
4.	                                     'data',  
5.	                                     'Buffer',  
6.	                                     data);  
7.	    return this.emit('error', err);  
8.	  }  
9.	  // 还没打开文件，则等待打开成功后再执行写操作  
10.	  if (typeof this.fd !== 'number') {  
11.	    return this.once('open', function() {  
12.	      this._write(data, encoding, cb);  
13.	    });  
14.	  }  
15.	  // 执行写操作,0代表从data的哪个位置开始写，这里是全部写入，所以是0，pos代表文件的位置  
16.	  fs.write(this.fd, data, 0, data.length, this.pos, (er, bytes) => {  
17.	    if (er) {  
18.	      if (this.autoClose) {  
19.	        this.destroy();  
20.	      }  
21.	      return cb(er);  
22.	    }  
23.	    // 写入成功的字节长度  
24.	    this.bytesWritten += bytes;  
25.	    cb();  
26.	  });  
27.	  // 下一个写入的位置  
28.	  if (this.pos !== undefined)  
29.	    this.pos += data.length;  
30.	};  
```

_write就是根据用户传入数据的大小，不断调用fs.write往底层写入数据，直到写完成或者出错。接着我们看一下批量写的逻辑。

```
1.	// 实现可写流批量写钩子  
2.	WriteStream.prototype._writev = function(data, cb) {  
3.	  if (typeof this.fd !== 'number') {  
4.	    return this.once('open', function() {  
5.	      this._writev(data, cb);  
6.	    });  
7.	  }  
8.	  
9.	  const self = this;  
10.	  const len = data.length;  
11.	  const chunks = new Array(len);  
12.	  var size = 0;  
13.	  // 计算待写入的出总大小，并且把数据保存到chunk数组中，准备写入  
14.	  for (var i = 0; i < len; i++) {  
15.	    var chunk = data[i].chunk;  
16.	  
17.	    chunks[i] = chunk;  
18.	    size += chunk.length;  
19.	  }  
20.	  // 执行批量写  
21.	  writev(this.fd, chunks, this.pos, function(er, bytes) {  
22.	    if (er) {  
23.	      self.destroy();  
24.	      return cb(er);  
25.	    }  
26.	    // 写成功的字节数，可能小于希望写入的字节数  
27.	    self.bytesWritten += bytes;  
28.	    cb();  
29.	  });  
30.	  /* 
31.	    更新下一个写入位置，如果写部分成功，计算下一个写入位置时 
32.	    也会包括没写成功的字节数，所以是假设size而不是bytes 
33.	  */  
34.	  if (this.pos !== undefined)  
35.	    this.pos += size;  
36.	};  
```

批量写入的逻辑和_write类似，只不过它调用的是不同的接口往底层写。接下来我们看关闭文件可写流的实现。

```
1.	WriteStream.prototype.close = function(cb) {  
2.	  // 关闭文件成功后执行的回调  
3.	  if (cb) {  
4.	    if (this.closed) {  
5.	      process.nextTick(cb);  
6.	      return;  
7.	    } else {  
8.	      this.on('close', cb);  
9.	    }  
10.	  }  
11.	  
12.	  /* 
13.	    如果autoClose是false，说明流结束触发finish事件时，不会销毁流，
14.	    见WriteStream初始化代码 以这里需要监听finish事件，保证可写流结束时可以关闭文件描述符 
15.	  */  
16.	  if (!this.autoClose) {  
17.	    this.on('finish', this.destroy.bind(this));  
18.	  }  
19.	  
20.	  // 结束流，会触发finish事件  
21.	  this.end();  
22.	};  
```

可写文件流和可读文件流不一样。默认情况下，可读流在读完文件内容后Node.js会自动销毁流（关闭文件描述符），而写入文件，在某些情况下Node.js是无法知道什么时候流结束的，这需要我们显式地通知Node.js。在下面的例子中，我们是不需要显式通知Node.js的
1.	fs.createReadStream('11111.md').pipe(fs.createWriteStream('123.md'));  
因为可读文件流在文件读完后会调用可写文件的end方法，从而关闭可读流和可写流对应的文件描述符。而在以下代码中情况就变得复杂。

```
1.	const stream = fs.createWriteStream('123.md');  
2.	stream.write('hello');  
3.	// stream.close 或 stream.end();
```

在默认情况，我们可以调用end或者close去通知Node.js流结束。但是如果我们设置了autoClose为false，那么我们只能调用close而不能调用end。否则会造成文件描述符泄漏。因为end只是关闭了流。但是没有触发销毁流的逻辑。而close会触发销毁流的逻辑。我们看一下具体的代码。

```
1.	const fs = require('fs');  
2.	const stream = fs.createWriteStream('123.md');  
3.	stream.write('hello');  
4.	// 防止进程退出  
5.	setInterval(() => {});  
```

以上代码会导致文件描述符泄漏，我们在Linux下执行以下代码，通过ps aux找到进程id，然后执行lsof -p pid就可以看到进程打开的所有文件描述符。输出如12-6所示。  
 ![](https://img-blog.csdnimg.cn/d2697f5c3b29454aa53e20fc064d17ef.png)  
图12-6

文件描述符17指向了123.md文件。所以文件描述符没有被关闭，引起文件描述符泄漏。我们修改一下代码。
```
1.	const fs = require('fs');  
2.	const stream = fs.createWriteStream('123.md');  
3.	stream.end('hello');  
4.	setInterval(() => {});  
```
下面是以上代码的输出，我们看到没有123.md对应的文件描述符，如图12-7所示。  
 ![](https://img-blog.csdnimg.cn/da6c69dde9424e5e9897b90462eeb300.png)  
图12-7  
我们继续修改代码
```
1.	const fs = require('fs');  
2.	const stream = fs.createWriteStream('123.md', {autoClose: false});  
3.	stream.end('hello');  
4.	setInterval(() => {});  
```
以上代码的输出如图12-8所示。  
 ![](https://img-blog.csdnimg.cn/459575d162e043f1a85c81797f413977.png)  
图12-8  
我们看到使用end也无法关闭文件描述符。继续修改。

```
1.	const fs = require('fs');  
2.	const stream = fs.createWriteStream('123.md', {autoClose: false})
3.	stream.close();  
4.	setInterval(() => {});  
```

以上代码的输出如图12-9所示。  
 ![](https://img-blog.csdnimg.cn/e4fbadd8aed043a49902148d8058485a.png)  
图12-9  
我们看到成功关闭了文件描述符。
