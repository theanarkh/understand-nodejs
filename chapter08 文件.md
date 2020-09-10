# 第八章 文件
文件操作是我们使用nodejs时，经常会用到的模块。文件模块的api，几乎都提供了同步和异步的版本，同步的api就是直接在主线程中调用操作系统提供的接口。异步api则是在libuv提供的线程池中执行同步api实现的。这样就不会导致主线程阻塞。不同于网络io，文件io由于兼容性问题，无法像网络io一样利用操作系统提供的能力直接实现异步，在Libuv中，文件操作是以线程池实现的，操作文件的时候，会阻塞在某个线程。所以这种异步只是对用户而言。文件模块虽然提供的接口非常多，源码也几千行，但是很多逻辑都是类似的，所以我们只讲解不同的地方。
## 8.1 文件的概念
相信大家都了解unix、linux下一切皆文件的说法。不过这里讲的文件指的是一般的文件，也就是存在硬盘里的文件。文件系统中重要的概念有大概有超级块、inode、file、文件描述符、文件缓存系统、目录。下面我们逐个说一下。
### 8.1.1 超级块
超级块是负责管理整个文件系统，他记录了文件系统的元数据。从数据结构中我们可以看到他记录了文件系统的inode数量、文件系统在硬盘中占据的扇区数、inode位图、数据块位图、文件系统在硬盘中第一块的块号、该文件系统中文件大小的最大值。我们看一下超级块对应的结构体。

```c
1.// 超级块在硬盘的结构  
2.struct d_super_block {  
3.  // inode节点数量  
4.  unsigned short s_ninodes;  
5.  // 硬盘块数量  
6.  unsigned short s_nzones;  
7.  // inode位图块数量  
8.  unsigned short s_imap_blocks;  
9.  // 数据块位图数量  
10.  unsigned short s_zmap_blocks;  
11.  // 文件系统的第一块块号，不是数据块第一块块号  
12.  unsigned short s_firstdatazone;  
13.  // 参考上面  
14.  unsigned short s_log_zone_size;  
15.  // 最大文件长度  
16.  unsigned long s_max_size;  
17.  // 判断是否是超级块的标记  
18.  unsigned short s_magic;  
19.};  
```

#### 8.1.1.1 inode数量
文件系统中每个文件对应一个inode，文件的内容需要占据存储空间，而inode本身也需要存储空间，inode数量决定的了文件系统的可存储文件的个数。
#### 8.1.1.2 文件系统位置
一个硬盘分为很多个扇区，可以同时存在多个文件系统，所以每个文件系统需要记录他在硬盘中的首块号和块数。
#### 8.1.1.3 inode位图、数据块位图
inode位图是标记文件系统中，哪些inode节点已经被使用了，数据块位图则是标记哪些数据块被使用了。
一个文件系统在硬盘中的布局如下。
![文件系统在硬盘的布局](https://img-blog.csdnimg.cn/20200902002320869.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L2h1aWh1b3hxYw==,size_16,color_FFFFFF,t_70#pic_center)




[文件系统在硬盘的布局](https://img-blog.csdnimg.cn/20200902002320869.png)


### 8.1.2 inode节点
文件系统中，每个文件对应一个inode节点，inode节点记录了文件的元数据。比如创建者、创建时间、文件大小、权限、数据块信息等。inode节点是文件系统中非常重要的概念，unix/linux系统万物皆文件的实现和inode有很大的关系。inode节点屏蔽了不同类型文件的细节，为上层提供抽象的接口。

```c
1.// 文件系统在硬盘里的inode节点结构  
2.struct d_inode {  
3.  // 各种标记位，读写执行等，我们ls时看到的  
4.  unsigned short i_mode;  
5.  // 文件的用户id  
6.  unsigned short i_uid;  
7.  // 文件大小  
8.  unsigned long i_size;  
9.  unsigned long i_time;  
10.  // 文件的用户组id  
11.  unsigned char i_gid;  
12.  // 文件入度，即有多少个目录指向他  
13.  unsigned char i_nlinks;  
14.  // 存储文件内容对应的硬盘块号  
15.  unsigned short i_zone[9];  
16.};  
```

### 8.1.3 file结构体
file结构体是实现多个进程操作文件的结构体。他指向一个inode节点。因为inode保存的是文件的元数据。他对每个进程来说都是一样的。但是一个文件，在每个进程的视角下，有些属性是不一样的，比如文件偏移，文件的打开标记（可读可写可执行）。这些是每个进程独立的信息。

```c
1.struct file {  
2.  unsigned short f_mode;  
3.  unsigned short f_flags;  
4.  unsigned short f_count;  
5.  struct m_inode * f_inode;  
6.  off_t f_pos;  
7.};  
```

### 8.1.4 文件描述符
文件描述符本质是一个数字索引。他主要是用于进程中。进程进行通过文件描述符可以找到对应的文件。他的作用类似数据库表的id一样，我们通过这个id，就可以找到对应的资源，不管他是socket还是管道还是文件。
### 8.1.5 文件缓存系统
相对内存读写而言，读写硬盘的速度是非常慢的，如果每次读写都要和硬盘打交道，那无疑是很低效的。所以文件系统中加了一层缓存。缓存系统管理着文件数据的有效性。减少对硬盘的操作。缓存系统主要是处理应用层和硬件层来往的数据，目的是减少这种数据的来回读写。比如读的时候，如果缓存系统的数据有效，就直接返回，不需要操作硬盘。写的时候，先写到缓存系统，系统会定期刷到硬盘。
为了避免每次对文件的读写都操作硬盘，操作系统实现了一个缓存系统。以此减少和硬盘的交互。缓存系统是在内存里开辟一块空间做缓存。必要的时候，他会请求底层，他的下一层是io调度层，读写都是发请求给底层的调度层，由调度层进行请求的调度，然后调用硬盘驱动层去完成真正的硬盘读写操作。完成后通知缓存层。再通知调用方。
### 8.1.6 目录
我们知道操作系统中的文件其实是一棵树，而目录就是用来实现这棵树的重要数据结构。因为在文件树中，文件就是叶子节点。目录则是非叶子节点。目录本质也是文件。他和一般文件的区别是，一般文件存储的是用户的数据，目录存储的则是文件的信息。

```c
1.// 目录项结构  
2.struct dir_entry {  
3.  // inode号  
4.  unsigned short inode;  
5.  // 文件名  
6.  char name[NAME_LEN];  
7.};  
```

## 8.2 文件系统的结构
文件系统的结构大概分为2个部分。分别是在硬盘中的结构、在内存中的结构。


![文件系统在硬盘中的结构](https://img-blog.csdnimg.cn/20200902002621576.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L2h1aWh1b3hxYw==,size_16,color_FFFFFF,t_70#pic_center)


[文件系统在硬盘中的结构](https://img-blog.csdnimg.cn/20191103145513683.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)


内存中的结构


![在这里插入图片描述](https://img-blog.csdnimg.cn/20200902002635200.png#pic_center)


[文件系统在内存中的结构](https://img-blog.csdnimg.cn/20200902002635200.png)
[文件系统在内存中的结构](https://www.processon.com/view/link/5bcad5aae4b015327b10e605)
[文件系统总览](https://www.processon.com/view/link/5c431493e4b025fe7c83c014)


## 8.3 操作文件
文件的操作大概有如下几种
### 8.3.1 打开文件
我们操作一个文件之前，首先需要打开一个文件，那么打开一个文件，意味着什么呢？打开一个文件，1 我们要先根据文件路径找到文件对应的inode节点。假设是个绝对路径。文件路径是/a/b/c.txt。系统初始化的时候我们已经拿到了根目录对应的inode。从inode的结构体结构中，我们知道inode有一个字段保存了文件的内容。所以这时候就把根目录文件的文件内容读进来，是一系列的dir_entry结构体。然后逐个遍历，比较文件名是不是等于a，最后得到一个目录a对应的dir_entry。
2 根据dir_entry结构体我们知道，里面不仅保存了文件名，还保存了对应的inode号。我们根据inode号把a目录文件的内容也读取进来。以此类推。最后得到c对应的dir_entry。
3 再根据c对应的dir_entry的inode号，从硬盘把inode的内容读进来。发现他是一个普通文件。至此，我们找到了这个文件对应的inode节点。完成fd->file结构体->inode结构体的赋值。最后返回一个文件描述符fd。
### 8.3.2 文件读写
打开文件后，我们就会得到一个fd。当我们开始读取文件的内容。根据fd我们找到对应的inode节点。根据file结构体的pos字段，我们知道需要读取的数据在文件中的偏移。根据这个偏移，我们就可以根据inode里的信息算出我们要读取的数据在硬盘的数据块位置。然后把这个数据块从硬盘读取进来。返回给用户。
## 8.4 同步api
在nodejs中，同步api的本质是直接在主线程里调用操作系统提供的系统调用。下面以readFileSync为例，看一下整体的流程。


![在这里插入图片描述](https://img-blog.csdnimg.cn/20200902003201374.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L2h1aWh1b3hxYw==,size_16,color_FFFFFF,t_70#pic_center)


[同步api流程图](https://img-blog.csdnimg.cn/20200902003201374.png)



下面我们看一下具体的代码

```c
1.function readFileSync(path, options) {  
2.  options = getOptions(options, { flag: 'r' });  
3.  // 传的是fd还是文件路径  
4.  const isUserFd = isFd(path);   
5.  // 传的是路径，则先同步打开文件  
6.  const fd = isUserFd ? path : fs.openSync(path, options.flag, 0o666);  
7.  // 查看文件的stat信息，拿到文件的大小  
8.  const stats = tryStatSync(fd, isUserFd);  
9.  // 是否是一般文件  
10.  const size = isFileType(stats, S_IFREG) ? stats[8] : 0;  
11.  let pos = 0;  
12.  let buffer; 
13.  let buffers;  
14.  // 文件大小是0或者不是一般文件，size则为0  
15.  if (size === 0) {  
16.    buffers = [];  
17.  } else {  
18.    // 一般文件且有大小，则分配一个大小为size的buffer，size需要小于2G  
19.    buffer = tryCreateBuffer(size, fd, isUserFd);  
20.  }  
21.  
22.  let bytesRead;  
23.  // 不断地同步读文件内容  
24.  if (size !== 0) {  
25.    do {  
26.      bytesRead = tryReadSync(fd, isUserFd, buffer, pos, size - pos);  
27.      pos += bytesRead;  
28.    } while (bytesRead !== 0 && pos < size);  
29.  } else {  
30.    do {  
31.      /* 
32.        文件大小为0，或者不是一般文件，也尝试去读， 
33.        但是因为不知道大小，所以只能分配一个一定大小的buffer, 
34.        每次读取一定大小的内容，如果有的话 
35.      */  
36.      buffer = Buffer.allocUnsafe(8192);  
37.      bytesRead = tryReadSync(fd, isUserFd, buffer, 0, 8192);  
38.      // 把读取到的内容放到buffers里  
39.      if (bytesRead !== 0) {  
40.        buffers.push(buffer.slice(0, bytesRead));  
41.      }  
42.      // 记录读取到的数据长度  
43.      pos += bytesRead;  
44.    } while (bytesRead !== 0);  
45.  }  
46.  // 用户传的是文件路径，nodejs自己打开了文件，所以需要自己关闭  
47.  if (!isUserFd)  
48.    fs.closeSync(fd);  
49.  // 文件大小是0或者非一般文件的话，如果读到了内容  
50.  if (size === 0) {  
51.    // 把读取到的所有内容放到buffer中  
52.    buffer = Buffer.concat(buffers, pos);  
53.  } else if (pos < size) {  
54.    buffer = buffer.slice(0, pos);  
55.  }  
56.  // 编码
57.  if (options.encoding) buffer = buffer.toString(options.encoding);  
58.  return buffer;  
59.}  
```

tryReadSync调用的是fs. readSync，然后到binding.read(node_file.cc中定义的Read函数)。Read函数主要逻辑如下

```c
1.FSReqWrapSync req_wrap_sync;  
2.const int bytesRead = SyncCall(env, args[6], &req_wrap_sync, "read",uv_fs_read, fd, &uvbuf, 1, pos);  
```

我们看一下SyncCall的实现

```c
1.int SyncCall(Environment* env, v8::Local<v8::Value> ctx,  
2.             FSReqWrapSync* req_wrap, const char* syscall,  
3.             Func fn, Args... args) {  
4.  // req_wrap->req是一个uv_fs_t结构体，属于request类，管理一次文件操作的请求  
5.  int err = fn(env->event_loop(), &(req_wrap->req), args..., nullptr);  
6.  // 出错则设置两个字段到context，context为js层传入的对象  
7.  if (err < 0) {  
8.    v8::Local<v8::Context> context = env->context();  
9.    v8::Local<v8::Object> ctx_obj = ctx.As<v8::Object>();  
10.    v8::Isolate* isolate = env->isolate();  
11.    ctx_obj->Set(context,  
12.                 env->errno_string(),  
13.                 v8::Integer::New(isolate, err)).Check();  
14.    ctx_obj->Set(context,  
15.                 env->syscall_string(),  
16.                 OneByteString(isolate, syscall)).Check();  
17.  }  
18.  return err;  
19.}  
```

我们看到最终调用的是libuv的uv_fs_read，并使用uv_fs_t管理本次请求。因为是阻塞式调用，所以libuv会直接调用操作系统的系统调用read函数。这是nodejs中同步api的过程。
## 8.5 异步api
文件系统的api中，异步的实现是依赖于libuv的线程池的。Nodejs把任务放到线程池，然后返回主线程继续处理其他事，等到条件满足时，就会执行回调。我们以readFile为例讲解这个过程。异步读取文件的流程图


![在这里插入图片描述](https://img-blog.csdnimg.cn/20200902003319497.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L2h1aWh1b3hxYw==,size_16,color_FFFFFF,t_70#pic_center)


[异步读取文件流程图](https://img-blog.csdnimg.cn/20200902003319497.png)


下面我们看具体的实现

```c
1.function readFile(path, options, callback) {  
2.  callback = maybeCallback(callback || options);  
3.  options = getOptions(options, { flag: 'r' });  
4.  // 管理文件读的对象  
5.  if (!ReadFileContext)  
6.    ReadFileContext = require('internal/fs/read_file_context');  
7.  const context = new ReadFileContext(callback, options.encoding);  
8.  // 传的是文件路径还是fd  
9.  context.isUserFd = isFd(path); // File descriptor ownership  
10.  // c++层的对象，封装了uv_fs_t结构体，管理一次文件读请求  
11.  const req = new FSReqCallback();  
12.  req.context = context;  
13.  // 设置回调，打开文件后，执行  
14.  req.oncomplete = readFileAfterOpen;  
15.  // 传的是fd，则不需要打开文件，下一个tick直接执行回调读取文件  
16.  if (context.isUserFd) {  
17.    process.nextTick(function tick() {  
18.      req.oncomplete(null, path);  
19.    });  
20.    return;  
21.  }  
22.  
23.  path = getValidatedPath(path);  
24.  const flagsNumber = stringToFlags(options.flags);  
25.  // 调用c++层open打开文件  
26.  binding.open(pathModule.toNamespacedPath(path),  
27.               flagsNumber,  
28.               0o666,  
29.               req);  
30.}  
```

ReadFileContext对象用于管理文件读操作整个过程，FSReqCallback是对uv_fs_t的封装，每次读操作对于libuv来说就是一次请求，该请求的上下文就是使用uv_fs_t表示。请求完成后，会执行FSReqCallback对象的oncomplete函数。所以我们继续看readFileAfterOpen。

```c
1.function readFileAfterOpen(err, fd) {  
2.  const context = this.context;  
3.  // 打开出错则直接执行用户回调，传入err  
4.  if (err) {  
5.    context.callback(err);  
6.    return;  
7.  }  
8.  // 保存打开文件的fd  
9.  context.fd = fd;  
10.  // 新建一个FSReqCallback对象管理下一个异步请求和回调  
11.  const req = new FSReqCallback();  
12.  req.oncomplete = readFileAfterStat;  
13.  req.context = context;  
14.  // 获取文件的元数据，拿到文件大小  
15.  binding.fstat(fd, false, req);  
16.}  
```

拿到文件的元数据后，执行readFileAfterStat，这段逻辑和同步的类似，根据元数据中记录的文件大小，分配一个buffer用于后续读取文件内容。然后执行读操作。

```c
1.read() {  
2.    let buffer;  
3.    let offset;  
4.    let length;  
5.
6.    // 省略部分buffer处理的逻辑  
7.    const req = new FSReqCallback();  
8.    req.oncomplete = readFileAfterRead;  
9.    req.context = this;  
10.  
11.    read(this.fd, buffer, offset, length, -1, req);  
12.  }  
```

再次新建一个FSReqCallback对象管理异步读取操作和回调。我们看一下c++层read函数的实现。

```c
1.// 拿到c++层的FSReqCallback对象  
2.FSReqBase* req_wrap_async = GetReqWrap(env, args[5]);  
3.// 异步调用uv_fs_read  
4.AsyncCall(env, req_wrap_async, args, "read", UTF8, AfterInteger,uv_fs_read, fd, &uvbuf, 1, pos);  
```

AsyncCall最后调用libuv的uv_fs_read函数。我们看一下这个函数的关键逻辑。

```c
1.do {                        \  
2.    if (cb != NULL) {          \  
3.      uv__req_register(loop, req);  \  
4.      uv__work_submit(loop,    \  
5.                &req->work_req, \  
6.                UV__WORK_FAST_IO, \  
7.                uv__fs_work, \  
8.                uv__fs_done); \  
9.      return 0;               \  
10.    }                          \  
11.    else {                    \  
12.      uv__fs_work(&req->work_req); \  
13.      return req->result;     \  
14.    }                           \  
15.  }                            \  
16.  while (0)  
```

uv__work_submit是给线程池提交一个任务，当子线程执行这个任务时，就会执行uv__fs_work，uv__fs_work会调用操作系统的系统调用read，如果数据还不可读，可能会导致阻塞。读取成功后执行uv__fs_done。uv__fs_done会执行c++层的回调，从而执行js层的回调。Js层的回调是readFileAfterRead，这里就不具体展开，readFileAfterRead的逻辑是判断是否读取完毕，是的话执行用户回调，否则继续发起读取操作。
## 8.6 文件监听
文件监听是非常常用的功能，我们修改了文件后webpack重新打包代码或者nodejs服务重启都用到了文件监听的功能，Nodejs提供了两套文件监听的机制。
### 8.6.1 基于轮询的文件监听机制
基于轮询机制的文件监听api是watchFile。流程如下


![在这里插入图片描述](https://img-blog.csdnimg.cn/20200902003551286.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L2h1aWh1b3hxYw==,size_16,color_FFFFFF,t_70#pic_center)


[文件监听流程图](https://img-blog.csdnimg.cn/20200902003551286.png)



我们看一下具体实现。

```c
1.function watchFile(filename, options, listener) {  
2.  filename = getValidatedPath(filename);  
3.  filename = pathModule.resolve(filename);  
4.  let stat;  
5.  // 省略部分参数处理逻辑  
6.  options = {  
7.    interval: 5007,  
8.    // 一直轮询  
9.    persistent: true,  
10.    ...options  
11.  };  
12.  
13.  // 缓存处理，filename是否已经开启过监听  
14.  stat = statWatchers.get(filename);  
15.  
16.  if (stat === undefined) {  
17.    if (!watchers)  
18.      watchers = require('internal/fs/watchers');  
19.    stat = new watchers.StatWatcher(options.bigint);  
20.    // 开启监听  
21.    stat[watchers.kFSStatWatcherStart](filename,  
22.                                       options.persistent, options.interval);  
23.    // 更新缓存                                     
24.    statWatchers.set(filename, stat);  
25.  }  
26.    
27.  stat.addListener('change', listener);  
28.  return stat;  
29.}  
```

StatWatcher是管理文件监听的类，我们看一下watchers.kFSStatWatcherStart方法的实现。

```c
1.StatWatcher.prototype[kFSStatWatcherStart] = function(filename,  
2.                                                      persistent,  
3.                                                      interval) {  
4.  this._handle = new _StatWatcher(this[kUseBigint]);  
5.  this._handle.onchange = onchange;  
6.  filename = getValidatedPath(filename, 'filename'); 
7.  const err = this._handle.start(toNamespacedPath(filename), interval);  
8.}  
```

新建一个_StatWatcher对象，_StatWatcher是c++模块提供的功能（node_stat_watcher.cc），然后执行他的start方法。Start方法执行libuv的uv_fs_poll_start开始监听文件

```c
1.int uv_fs_poll_start(uv_fs_poll_t* handle,  
2.                     uv_fs_poll_cb cb,  
3.                     const char* path,  
4.                     unsigned int interval) {  
5.  // 管理文件监听的数据结构  
6.  struct poll_ctx* ctx;  
7.  uv_loop_t* loop;  
8.  size_t len;  
9.  int err;  
10.  
11.  loop = handle->loop;  
12.  len = strlen(path);  
13.  // calloc会把内存初始化为0
14.  ctx = uv__calloc(1, sizeof(*ctx) + len);  
15.  ctx->loop = loop;  
16.  // c++层回调
17.  ctx->poll_cb = cb;  
18.  // 多久轮询一次  
19.  ctx->interval = interval ? interval : 1;  
20.  ctx->start_time = uv_now(loop);  
21.  // 关联的handle  
22.  ctx->parent_handle = handle;  
23.  // 监听的文件路径  
24.  memcpy(ctx->path, path, len + 1);  
25.  // 初始化定时器结构体  
26.  err = uv_timer_init(loop, &ctx->timer_handle);  
27.  // 异步查询文件元数据  
28.  err = uv_fs_stat(loop, &ctx->fs_req, ctx->path, poll_cb);  
29.    
30.  if (handle->poll_ctx != NULL)  
31.    ctx->previous = handle->poll_ctx;  
32.  // 关联负责管理轮询的对象  
33.  handle->poll_ctx = ctx;  
34.  uv__handle_start(handle);  
35.  return 0;  
36.}  
```

Start函数初始化一个poll_ctx结构体，用于管理文件监听，然后发起异步请求文件元数据的请求，获取元数据后，执行poll_cb回调。

```c
1.static void poll_cb(uv_fs_t* req) {  
2.  uv_stat_t* statbuf;  
3.  struct poll_ctx* ctx;  
4.  uint64_t interval;  
5.  // 通过结构体字段获取结构体首地址  
6.  ctx = container_of(req, struct poll_ctx, fs_req);  
7.  statbuf = &req->statbuf;  
8.  /* 
9.   第一次不执行回调，因为没有可对比的元数据，第二次及后续的操作才可能执行回调， 
10.   busy_polling初始化的时候为0，第一次执行的时候置busy_polling=1 
11.  */  
12.  if (ctx->busy_polling != 0)  
13.    // 出错或者stat发生了变化则执行回调  
14.    if (ctx->busy_polling < 0 || !statbuf_eq(&ctx->statbuf, statbuf))  
15.      ctx->poll_cb(ctx->parent_handle, 0, &ctx->statbuf, statbuf);  
16.  // 保存当前获取到的stat信息，置1  
17.  ctx->statbuf = *statbuf;  
18.  ctx->busy_polling = 1;  
19.  
20.out:  
21.  uv_fs_req_cleanup(req);  
22.  
23.  if (ctx->parent_handle == NULL) { /* handle has been stopped by callback */  
24.    uv_close((uv_handle_t*)&ctx->timer_handle, timer_close_cb);  
25.    return;  
26.  }  
27.  /* 
28.    假设在开始时间点为1，interval为10的情况下执行了stat，stat完成执行并执行poll_cb回调的时间点是 
29.    3，那么定时器的超时时间则为10-3=7，即7个单位后就要触发超时，而不是10，是因为stat阻塞消耗了3个单位的 
30.    时间，所以下次执行超时回调函数时说明从start时间点开始算，已经经历了x单位各interval，然后超时回调里又 
31.    执行了stat函数，再到执行stat回调，这个时间点即now=start+x单位个interval+stat消耗的时间。得出now-start 
32.    为interval的x倍+stat消耗，即对interval取余可得到stat消耗，所以 
33.    当前轮，定时器的超时时间为interval - ((now-start) % interval) 
34.  */  
35.  interval = ctx->interval;  
36.  interval -= (uv_now(ctx->loop) - ctx->start_time) % interval;  
37.  
38.  if (uv_timer_start(&ctx->timer_handle, timer_cb, interval, 0))  
39.    abort();  
40.}  
```

基于轮询的监听文件机制本质上是不断轮询文件的元数据，然后和上一次的元数据进行对比，如果有不一致的就认为文件变化了，因为第一次获取元数据时，还没有可以对比的数据，所以不认为是文件变化，这时候开启一个定时器。隔一段时间再去获取文件的元数据，如此反复。直到用户调stop函数停止这个行为。下面是libuv关于文件变化的定义。

```c
1.static int statbuf_eq(const uv_stat_t* a, const uv_stat_t* b) {  
2.  return a->st_ctim.tv_nsec == b->st_ctim.tv_nsec  
3.      && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec  
4.      && a->st_birthtim.tv_nsec == b->st_birthtim.tv_nsec  
5.      && a->st_ctim.tv_sec == b->st_ctim.tv_sec  
6.      && a->st_mtim.tv_sec == b->st_mtim.tv_sec  
7.      && a->st_birthtim.tv_sec == b->st_birthtim.tv_sec  
8.      && a->st_size == b->st_size  
9.      && a->st_mode == b->st_mode  
10.      && a->st_uid == b->st_uid  
11.      && a->st_gid == b->st_gid  
12.      && a->st_ino == b->st_ino  
13.      && a->st_dev == b->st_dev  
14.      && a->st_flags == b->st_flags  
15.      && a->st_gen == b->st_gen;  
16.}  
```

### 8.6.2基于inotify的文件监听机制
我们看到基于轮询的监听其实效率是很低的，因为需要我们不断去轮询文件的元数据，如果文件大部分时间里都没有变化，那就会白白浪费cpu。如果文件改变了会主动通知我们那就好了，这就是基于inotify机制的文件监听。Nodejs提供的接口是watch。watch的实现和watchFile的比较类似。

```c
1.function watch(filename, options, listener) {  
2.  // Don't make changes directly on options object  
3.  options = copyObject(options);  
4.  // 是否持续监听
5.  if (options.persistent === undefined) options.persistent = true;  
6.  // 如果是目录，是否监听所有子目录和文件的变化
7.  if (options.recursive === undefined) options.recursive = false;  
8.  // 有些平台不支持
9.  if (options.recursive && !(isOSX || isWindows))  
10.    throw new ERR_FEATURE_UNAVAILABLE_ON_PLATFORM('watch recursively');  
11.  if (!watchers)  
12.    watchers = require('internal/fs/watchers');  
13.  // 新建一个FSWatcher对象管理文件监听，然后开启监听
14.  const watcher = new watchers.FSWatcher();  
15.  watcher[watchers.kFSWatchStart](filename,  
16.                      options.persistent,  
17.                      options.recursive,  
18.                      options.encoding);  
19.  
20.  if (listener) {  
21.    watcher.addListener('change', listener);  
22.  }  
23.  
24.  return watcher;  
25.}  
```

FSWatcher函数是对c++层FSEvent模块的封装。我们来看一下start函数的逻辑，start函数透过c++层调用了libuv的uv_fs_event_start函数。在讲解uv_fs_event_start函数前，我们先了解一下inotify的原理和他在libuv中的实现。inotify是linux系统提供用于监听文件系统的机制。inotify机制的逻辑大致是

 1. init_inotify创建一个inotify机制的实例，返回一个文件描述符。类似epoll。
 2. inotify_add_watch往inotify实例注册一个需监听的文件（inotify_rm_watch是移除）。 
 3. read((inotify实例对应的文件描述符, &buf, sizeof(buf)))，如果没有事件触发，则阻塞（除非设置了非阻塞）。否则返回待读取的数据长度。buf就是保存了触发事件的信息。

libuv在inotify机制的基础上做了一层封装。我们看一下inotify在libuv的架构图


![在这里插入图片描述](https://img-blog.csdnimg.cn/20200902004135359.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L2h1aWh1b3hxYw==,size_16,color_FFFFFF,t_70#pic_center)


[inotify架构图](https://img-blog.csdnimg.cn/20200902004135359.png)


我们再来看一下libuv中的实现。我们从一个使用例子开始。

```c
1.int main(int argc, char **argv) {  
2.    // 实现循环核心结构体loop  
3.    loop = uv_default_loop();   
4.    uv_fs_event_t *fs_event_req = malloc(sizeof(uv_fs_event_t));  
5.    // 初始化fs_event_req结构体的类型为UV_FS_EVENT  
6.    uv_fs_event_init(loop, fs_event_req);  
7.    /* 
8.      argv[argc]是文件路径，
9.      uv_fs_event_start 向底层注册监听文件argv[argc],
10.      cb是事件触发时的回调 
11.    */  
12.    uv_fs_event_start(fs_event_req, cb, argv[argc], UV_FS_EVENT_RECURSIVE);  
13.    // 开启事件循环  
14.    return uv_run(loop, UV_RUN_DEFAULT);  
15.}  
```

libuv在第一次监听文件的时候(调用uv_fs_event_start的时候)，会创建一个inotify实例。

```c
1.static int init_inotify(uv_loop_t* loop) {  
2.  int err;  
3.  // 初始化过了则直接返回       
4.  if (loop->inotify_fd != -1)  
5.    return 0;  
6.  /*
7.    调用操作系统的inotify_init函数申请一个inotify实例，
8.    并设置UV__IN_NONBLOCK，UV__IN_CLOEXEC标记  
9.  */
10.  err = new_inotify_fd();  
11.  if (err < 0)  
12.    return err;  
13.  // 记录inotify实例对应的文件描述符,一个事件循环一个inotify实例  
14.  loop->inotify_fd = err;  
15.  /*
16.    inotify_read_watcher是一个io观察者，
17.    uv__io_init设置io观察者的文件描述符（待观察的文件）和回调  
18.  */
19.  uv__io_init(&loop->inotify_read_watcher, uv__inotify_read, loop->inotify_fd);  
20.  // 往libuv中注册该io观察者，感兴趣的事件为可读  
21.  uv__io_start(loop, &loop->inotify_read_watcher, POLLIN);  
22.  
23.  return 0;  
24.}  
```

Libuv往把inotify实例对应的fd通过uv__io_start注册到epoll中，当有文件变化的时候，就会执行回调uv__inotify_read。分析完libuv申请inotify实例的逻辑，我们回到main函数看看uv_fs_event_start函数。用户使用uv_fs_event_start函数来往libuv注册一个待监听的文件。我们看看实现。

```c
1.int uv_fs_event_start(uv_fs_event_t* handle,  
2.                      uv_fs_event_cb cb,  
3.                      const char* path,  
4.                      unsigned int flags) {  
5.  struct watcher_list* w;  
6.  int events;  
7.  int err;  
8.  int wd;  
9.  
10.  if (uv__is_active(handle))  
11.    return UV_EINVAL;  
12.  // 申请一个inotify实例  
13.  err = init_inotify(handle->loop);  
14.  if (err)  
15.    return err;  
16.  // 监听的事件  
17.  events = UV__IN_ATTRIB  
18.         | UV__IN_CREATE  
19.         | UV__IN_MODIFY  
20.         | UV__IN_DELETE  
21.         | UV__IN_DELETE_SELF  
22.         | UV__IN_MOVE_SELF  
23.         | UV__IN_MOVED_FROM  
24.         | UV__IN_MOVED_TO;  
25.  // 调用操作系统的函数注册一个待监听的文件，返回一个对应于该文件的id  
26.  wd = uv__inotify_add_watch(handle->loop->inotify_fd, path, events);  
27.  if (wd == -1)  
28.    return UV__ERR(errno);  
29.  // 判断该文件是不是已经注册过了  
30.  w = find_watcher(handle->loop, wd);  
31.  // 已经注册过则跳过插入的逻辑  
32.  if (w)  
33.    goto no_insert;  
34.  // 还没有注册过则插入libuv维护的红黑树  
35.  w = uv__malloc(sizeof(*w) + strlen(path) + 1);  
36.  if (w == NULL)  
37.    return UV_ENOMEM;  
38.  
39.  w->wd = wd;  
40.  w->path = strcpy((char*)(w + 1), path);  
41.  QUEUE_INIT(&w->watchers);  
42.  w->iterating = 0;  
43.  // 插入libuv维护的红黑树,inotify_watchers是根节点  
44.  RB_INSERT(watcher_root, CAST(&handle->loop->inotify_watchers), w);  
45.  
46.no_insert:  
47.  // 激活该handle  
48.  uv__handle_start(handle);  
49.  // 同一个文件可能注册了很多个回调，w对应一个文件，注册在用一个文件的回调排成队  
50.  QUEUE_INSERT_TAIL(&w->watchers, &handle->watchers);  
51.  // 保存信息和回调  
52.  handle->path = w->path;  
53.  handle->cb = cb;  
54.  handle->wd = wd;  
55.  
56.  return 0;  
57.}  
```

下面我们逐步分析上面的函数逻辑。

 1. 如果是首次调用该函数则新建一个inotify实例。并且往libuv插入一个观察者io，libuv会在poll io阶段注册到epoll中。
 2. 往操作系统注册一个待监听的文件。返回一个id。
 3. libuv判断该id是不是在自己维护的红黑树中。不在红黑树中，则插入红黑树。返回一个红黑树中对应的节点。把本次请求的信息封装到handle中（回调时需要）。然后把handle插入刚才返回的节点的队列中。见上图。
这时候注册过程就完成了。libuv在poll io阶段如果检测到有文件发生变化，则会执行回调uv__inotify_read。

```c
1.static void uv__inotify_read(uv_loop_t* loop,  
2.                             uv__io_t* dummy,  
3.                             unsigned int events) {  
4.  const struct uv__inotify_event* e;  
5.  struct watcher_list* w;  
6.  uv_fs_event_t* h;  
7.  QUEUE queue;  
8.  QUEUE* q;  
9.  const char* path;  
10.  ssize_t size;  
11.  const char *p;  
12.  /* needs to be large enough for sizeof(inotify_event) + strlen(path) */  
13.  char buf[4096];  
14.  // 一次可能没有读完  
15.  while (1) {  
16.    do  
17.      // 读取触发的事件信息，size是数据大小，buffer保存数据  
18.      size = read(loop->inotify_fd, buf, sizeof(buf));  
19.    while (size == -1 && errno == EINTR);  
20.    // 没有数据可取了  
21.    if (size == -1) {  
22.      assert(errno == EAGAIN || errno == EWOULDBLOCK);  
23.      break;  
24.    }  
25.    // 处理buffer的信息  
26.    for (p = buf; p < buf + size; p += sizeof(*e) + e->len) {  
27.      // buffer里是多个uv__inotify_event结构体，里面保存了事件信息和文件对应的id（wd字段）  
28.      e = (const struct uv__inotify_event*)p;  
29.  
30.      events = 0;  
31.      if (e->mask & (UV__IN_ATTRIB|UV__IN_MODIFY))  
32.        events |= UV_CHANGE;  
33.      if (e->mask & ~(UV__IN_ATTRIB|UV__IN_MODIFY))  
34.        events |= UV_RENAME;  
35.      // 通过文件对应的id（wd字段）从红黑树中找到对应的节点  
36.      w = find_watcher(loop, e->wd);  
37.  
38.      path = e->len ? (const char*) (e + 1) : uv__basename_r(w->path);  
39.      w->iterating = 1;  
40.      // 把红黑树中，wd对应节点的handle队列移到queue变量，准备处理  
41.      QUEUE_MOVE(&w->watchers, &queue);  
42.      while (!QUEUE_EMPTY(&queue)) {  
43.          // 头结点  
44.        q = QUEUE_HEAD(&queue);  
45.        // 通过结构体偏移拿到首地址  
46.        h = QUEUE_DATA(q, uv_fs_event_t, watchers);  
47.        // 从处理队列中移除  
48.        QUEUE_REMOVE(q);  
49.        // 放回原队列  
50.        QUEUE_INSERT_TAIL(&w->watchers, q);  
51.        // 执行回调  
52.        h->cb(h, path, events, 0);  
53.      }  
54.    }  
55.  }  
56.}  
```

uv__inotify_read函数的逻辑就是从操作系统中把数据读取出来，这些数据中保存了哪些文件触发了用户感兴趣的事件。然后遍历每个触发了事件的文件。从红黑树中找到该文件对应的红黑树节点。再取出红黑树节点中维护的一个handle队列，最后执行handle队列中每个节点的回调。
