
# 第十四章 多线程
这一章以nodejs为背景，不分析libuv的线程实现，因为他本质是对系统线程库的封装，可以参考后面提供的资料，直接看线程的源码。
nodejs支持了进程之后，又支持了线程。类似浏览器端的web worker。因为nodejs是单线程的，虽然底层的libuv实现了一个线程池，但是这个线程池只能执行c、c++层定义的任务。如果我们想自定义一些耗时的操作，比如分析大量文件的内容，那就只能在c++层处理，然后暴露接口给js层调用，这个成本是非常高的，在早期的nodejs版本里，我们可以用进程去实现这样的需求。但是进程太重了，在新版的nodejs中，nodejs为我们提供了多线程的功能。	Nodejs中，线程的实现也非常复杂。虽然底层只是对线程库的封装，但是把它和nodejs原本的架构结合起来似乎就变得麻烦起来。
## 14.1 使用多线程
对于加解密、压缩、解压、文件操作等，nodejs使用了内置的线程池支持了异步。但是一些纯js的消耗cpu的操作。我们就不能在主线程里处理了，这时候就不得不使用线程。nodejs底层也提供了一个线程池，但是是给nodejs自己使用的。对于cpu密集型的逻辑，如果可以通过nodejs交给底层的线程池处理，那就不需要开启子线程。比如nodejs内置的加解密、压缩解压。否则，就应该创建子线程去执行。比如大量的计算操作。因为子线程和nodejs主线程共享一个libuv线程池(worker_thread模块本质上是在线程里执行一个新的事件循环)，所以如果在子线程里有文件、压缩等异步操作就会和主线程竞争libuv线程池，我们可以使用同步api或者在子线程里尽量不要执行非cpu型的操作。我们看一下在nodejs中如何使用线程。

```c
1.const { Worker, isMainThread, parentPort } = require('worker_threads');  
2.if (isMainThread) {  
3.  const worker = new Worker(__filename);  
4.  worker.once('message', (message) => {  
5.    ...  
6.  });  
7.  worker.postMessage('Hello, world!');  
8.} else {  
9.  // 做点耗时的事情  
10.  parentPort.once('message', (message) => {  
11.    parentPort.postMessage(message);  
12.  });  
13.}  
```

上面这段代码会被执行两次，一次是在主线程，一次在子线程。所以首先通过isMainThread判断当前是主线程还是子线程。主线程的话，就创建一个子线程，然后监听子线程发过来的消息。子线程的话，首先执行业务相关的代码，还可以监听主线程传过来的消息。我们在子线程中可以做一些耗时或者阻塞性的操作，不会影响主线程的执行。我们也可以把这两个逻辑拆分到两个文件。
主线程

```c
1.const { Worker, isMainThread, parentPort } = require('worker_threads');  
2.const worker = new Worker(__filename);  
3.worker.once('message', (message) => {  
4.  ...  
5.});  
6.worker.postMessage('Hello, world!');  
子线程
1.const { Worker, isMainThread, parentPort } = require('worker_threads');  
2.parentPort.once('message', (message) => {  
3.  parentPort.postMessage(message);  
4.});  
```

## 14.2 多线程的实现
首先我们从worker_threads模块开始分析。这是一个c++模块。我们看一下他导出的功能。require("work_threads")的时候就是引用了InitWorker函数导出的功能。

```c
1.void InitWorker(Local<Object> target,  
2.                Local<Value> unused,  
3.                Local<Context> context,  
4.                void* priv) {  
5.  Environment* env = Environment::GetCurrent(context);  
6.  
7.  {  
8.    // 执行下面的方法时，入参都是w->GetFunction() new出来的对象  
9.    // 新建一个函数模板，Worker::New是对w->GetFunction()执行new的时候会执行的回调  
10.    Local<FunctionTemplate> w = env->NewFunctionTemplate(Worker::New);  
11.    // 设置需要拓展的内存，因为c++对象的内存是固定的  
12.    w->InstanceTemplate()->SetInternalFieldCount(1);  
13.    w->Inherit(AsyncWrap::GetConstructorTemplate(env));  
14.    // 设置一系列原型方法，就不一一列举  
15.    env->SetProtoMethod(w, "setEnvVars", Worker::SetEnvVars);  
16.    // 一系列原型方法  
17.    // 导出函数模块对应的函数，即我们代码中const { Worker } = require("worker_threads");中的Worker  
18.    Local<String> workerString =  
19.        FIXED_ONE_BYTE_STRING(env->isolate(), "Worker");  
20.    w->SetClassName(workerString);  
21.    target->Set(env->context(),  
22.                workerString,  
23.                w->GetFunction(env->context()).ToLocalChecked()).Check();  
24.  }  
25.  // 导出getEnvMessagePort方法，const { getEnvMessagePort } = require("worker_threads");  
26.  env->SetMethod(target, "getEnvMessagePort", GetEnvMessagePort);  
27.  /* 
28.      线程id，这个不是操作系统分配的那个，而是nodejs分配的,在新开线程的时候设置 
29.      const { threadId } = require("worker_threads"); 
30.  */  
31.  target  
32.      ->Set(env->context(),  
33.            env->thread_id_string(),  
34.            Number::New(env->isolate(), static_cast<double>(env->thread_id())))  
35.      .Check();  
36.  /* 
37.      是否是主线程，const { isMainThread } = require("worker_threads"); 
38.      这边变量在nodejs启动的时候设置为true，新开子线程的时候，没有设置，所以是false 
39.  */  
40.  target  
41.      ->Set(env->context(),  
42.            FIXED_ONE_BYTE_STRING(env->isolate(), "isMainThread"),  
43.            Boolean::New(env->isolate(), env->is_main_thread()))  
44.      .Check();  
45.  /* 
46.      如果不是主线程，导出资源限制的配置， 
47.      即在子线程中调用const { resourceLimits } = require("worker_threads"); 
48.  */  
49.  if (!env->is_main_thread()) {  
50.    target  
51.        ->Set(env->context(),  
52.              FIXED_ONE_BYTE_STRING(env->isolate(), "resourceLimits"),  
53.              env->worker_context()->GetResourceLimits(env->isolate()))  
54.        .Check();  
55.  }  
56.  // 导出几个常量  
57.  NODE_DEFINE_CONSTANT(target, kMaxYoungGenerationSizeMb);  
58.  NODE_DEFINE_CONSTANT(target, kMaxOldGenerationSizeMb);  
59.  NODE_DEFINE_CONSTANT(target, kCodeRangeSizeMb);  
60.  NODE_DEFINE_CONSTANT(target, kTotalResourceLimitCount);  
61.}  
```

翻译成js大概是

```c
1.function c++Worker(object) {  
2.    // 关联起来，后续在js层调用c++层函数时，取出来，拿到c++层真正的worker对象   
3.    object[0] = this;  
4.    ...  
5.}  
6.function New(object) {  
7.    const worker = new c++Worker(object);  
8.}  
9.function Worker() {  
10.    New(this);  
11.}  
12.Worker.prototype = {  
13.    startThread,StartThread,  
14.    StopThread: StopThread,  
15.    ...  
16.}  
17.module.exports = {  
18.    Worker: Worker,  
19.    getEnvMessagePort: GetEnvMessagePort,  
20.    isMainThread: true | false  
21.    ...  
22.}  
```

了解work_threads模块导出的功能后，我们看new Worker的时候的逻辑。根据上面代码导出的逻辑，我们知道这时候首先会新建一个c++对象。对应上面的Worker函数中的this。然后执行New回调，并传入tihs。我们看New函数的逻辑。我们省略一系列的参数处理，主要代码如下。

```c
1.// args.This()就是我们刚才传进来的this  
2.Worker* worker = new Worker(env, args.This(),   
3.                            url, per_isolate_opts,  
4.                             std::move(exec_argv_out));  
```

我们再看Worker类。

```c
1.Worker::Worker(Environment* env,  
2.               Local<Object> wrap,...)  
3.    // 在父类构造函数中完成对象的Worker对象和args.This()对象的关联  
4.    : AsyncWrap(env, wrap, AsyncWrap::PROVIDER_WORKER),  
5.      ...  
6.      // 分配线程id  
7.      thread_id_(Environment::AllocateThreadId()),  
8.      env_vars_(env->env_vars()) {  
9.  
10.  // 新建一个端口和子线程通信  
11.  parent_port_ = MessagePort::New(env, env->context());  
12.  /* 
13.    关联起来，用于通信 
14.    const parent_port_ = {data: {sibling: null}}; 
15.    const child_port_data_  = {sibling: null}; 
16.    parent_port_.data.sibling = child_port_data_; 
17.    child_port_data_.sibling = parent_port_.data; 
18.  */  
19.  child_port_data_ = std::make_unique<MessagePortData>(nullptr);  
20.  MessagePort::Entangle(parent_port_, child_port_data_.get());  
21.  // 设置Worker对象的messagePort属性为parent_port_  
22.  object()->Set(env->context(),  
23.                env->message_port_string(),  
24.                parent_port_->object()).Check();  
25.  // 设置Worker对象的线程id，即threadId属性  
26.  object()->Set(env->context(),  
27.                env->thread_id_string(),  
28.                Number::New(env->isolate(), static_cast<double>(thread_id_)))  
29.      .Check();  
30.}  
```

新建一个Worker，结构如下


![Worker结构](https://img-blog.csdnimg.cn/20200901230635161.png#pic_center)


了解了new Worker的逻辑后，我们看在js层是如何使用的。我们看js层Worker类的构造函数。

```c
1.constructor(filename, options = {}) {  
2.    super();  
3.    // 忽略一系列参数处理，new Worker就是上面提到的c++层的  
4.    this[kHandle] = new Worker(url, options.execArgv, parseResourceLimits(options.resourceLimits));  
5.    // messagePort就是上面图中的messagePort，指向_parent_port  
6.    this[kPort] = this[kHandle].messagePort;  
7.    this[kPort].on('message', (data) => this[kOnMessage](data));  
8.    // 开始接收消息，我们这里不深入messagePort，后续单独分析  
9.    this[kPort].start();  
10.    // 申请一个通信管道，两个端口  
11.    const { port1, port2 } = new MessageChannel();  
12.    this[kPublicPort] = port1;  
13.    this[kPublicPort].on('message', (message) => this.emit('message', message));  
14.    // 向另一端发送消息  
15.    this[kPort].postMessage({  
16.      argv,  
17.      type: messageTypes.LOAD_SCRIPT,  
18.      filename,  
19.      doEval: !!options.eval,  
20.      cwdCounter: cwdCounter || workerIo.sharedCwdCounter,  
21.      workerData: options.workerData,  
22.      publicPort: port2,  
23.      manifestSrc: getOptionValue('--experimental-policy') ?  
24.        require('internal/process/policy').src :  
25.        null,  
26.      hasStdin: !!options.stdin  
27.    }, [port2]);  
28.    // 开启线程  
29.    this[kHandle].startThread();  
30.  }  
```

上面的代码主要逻辑如下

 1. 保存messagePort，然后给messagePort的对端（看上面的图）发送消息，但是这时候还没有接收者，所以消息会缓存到MessagePortData，即child_port_data_中。
 2. 申请一个通信管道，用于主线程和子线程通信。_parent_port和child_port是给nodejs使用的，新申请的管道是给用户使用的。
 3. 创建子线程。

我们看创建线程的时候，做了什么。

```c
1.void Worker::StartThread(const FunctionCallbackInfo<Value>& args) {  
2.  Worker* w;  
3.  // 解包出对应的Worker对象  
4.  ASSIGN_OR_RETURN_UNWRAP(&w, args.This());  
5.  // 新建一个子线程，然后执行Run函数，从此在子线程里执行  
6.  uv_thread_create_ex(&w->tid_, &thread_options, [](void* arg) {  
7.    w->Run();  
8.  }, static_cast<void*>(w))  
9.}  
```

我们继续看Run

```c
1.void Worker::Run() {  
2.    {  
3.        // 新建一个env  
4.        env_.reset(new Environment(data.isolate_data_.get(),  
5.                                   context,  
6.                                   std::move(argv_),  
7.                                   std::move(exec_argv_),  
8.                                   Environment::kNoFlags,  
9.                                   thread_id_));  
10.        // 初始化libuv，往libuv注册  
11.        env_->InitializeLibuv(start_profiler_idle_notifier_);  
12.        // 创建一个MessagePort  
13.        CreateEnvMessagePort(env_.get());  
14.        // 执行internal/main/worker_thread.js  
15.        StartExecution(env_.get(), "internal/main/worker_thread");  
16.        // 开始事件循环  
17.        do {  
18.          uv_run(&data.loop_, UV_RUN_DEFAULT);  
19.          platform_->DrainTasks(isolate_);  
20.          more = uv_loop_alive(&data.loop_);  
21.          if (more && !is_stopped()) continue;  
22.          more = uv_loop_alive(&data.loop_);  
23.        } while (more == true && !is_stopped());  
24.     }  
25.}  
```

我们分步骤分析上面的代码

```c
1 CreateEnvMessagePort
1.void Worker::CreateEnvMessagePort(Environment* env) {  
2.  child_port_ = MessagePort::New(env,  
3.                                 env->context(),  
4.                                 std::move(child_port_data_));  
5.  
6.  if (child_port_ != nullptr)  
7.    env->set_message_port(child_port_->object(isolate_));  
8.}  
```

child_port_data_这个变量我们应该很熟悉，在这里首先申请一个新的端口。负责端口中数据管理的对象是child_port_data_。然后在env缓存起来。一会要用。


![在这里插入图片描述](https://img-blog.csdnimg.cn/20200901231136689.png#pic_center)




**2 执行internal/main/worker_thread.js**




```c
1.// 设置process对象  
2.patchProcessObject();  
3.// 获取刚才缓存的端口  
4.onst port = getEnvMessagePort();  
5.port.on('message', (message) => {  
6.  // 加载脚本  
7.  if (message.type === LOAD_SCRIPT) {  
8.    const {  
9.      argv,  
10.      cwdCounter,  
11.      filename,  
12.      doEval,  
13.      workerData,  
14.      publicPort,  
15.      manifestSrc,  
16.      manifestURL,  
17.      hasStdin  
18.    } = message;  
19.  
20.    const CJSLoader = require('internal/modules/cjs/loader');  
21.    loadPreloadModules();  
22.    /* 
23.        由主线程申请的MessageChannel管道中，某一端的端口， 
24.        设置publicWorker的parentPort字段，publicWorker就是worker_threads导出的对象，后面需要用 
25.    */  
26.    publicWorker.parentPort = publicPort;  
27.    // 执行时使用的数据  
28.    publicWorker.workerData = workerData;  
29.    // 通知主线程，正在执行脚本  
30.    port.postMessage({ type: UP_AND_RUNNING });  
31.    // 执行new Worker(filename)时传入的文件  
32.    CJSLoader.Module.runMain(filename);  
33.})  
34.// 开始接收消息  
35.port.start()  
```

这时候我们再回头看一下，我们调用new Worker(filename)，然后在子线程里执行我们的filename时的场景。我们再次回顾前面的代码。

```c
1.const { Worker, isMainThread, parentPort } = require('worker_threads');  
2.if (isMainThread) {  
3.  const worker = new Worker(__filename);  
4.  worker.once('message', (message) => {  
5.    ...  
6.  });  
7.  worker.postMessage('Hello, world!');  
8.} else {  
9.  // 做点耗时的事情  
10.  parentPort.once('message', (message) => {  
11.    parentPort.postMessage(message);  
12.  });  
13.}  
```

我们知道isMainThread在子线程里是false，parentPort 就是就是messageChannel中的一端。所以parentPort.postMessage给对端发送消息，就是给主线程发送消息，我们再看看worker.postMessage('Hello, world!')。

```c
1.postMessage(...args) {  
2.   this[kPublicPort].postMessage(...args);  
3.}  
```

kPublicPort指向的就是messageChannel的另一端。即给子线程发送消息。那么on('message')就是接收对端发过来的消息。
## 14.3 线程间通信
Nodejs中，线程间通信使用的是MessageChannel实现的，类似管道的机制。不过他是双工的，任意一端都可以随时发送信息。MessageChannel类似socket通信，他包括两个端点。定义一个MessageChannel相当于建立一个tcp连接，他首先申请两个端点（MessagePort），然后把他们关联起来。
架构图如下


![在这里插入图片描述](https://img-blog.csdnimg.cn/20200901231211421.png#pic_center)



 1. Message代表一个消息。
 2. MessagePortData是对Message操作的一个封装和对消息的承载。
 3. MessagePort是代表通信的端点。
## 14.4 如果更好地使用线程
nodejs虽然提供了多线程的能力，但是线程是一种系统的资源，我们不能无限度地创建，在实际的使用中，我们需要控制好线程的数量。使用多线程的时候，我们需要考虑几个问题
### 14.4.1 如何判断创建线程是否成功
nodejs文档里也没有提到如何捕获创建失败这种情况，当我们调用new Worker的时候，最后会调用c++层的StartThread函数真正创建一个线程。我们分析这个函数，看如何捕获创建线程失败这种情况。

```c
1.CHECK_EQ(uv_thread_create_ex(&w->tid_, &thread_options, [](void* arg) {  
2.    // ...  
3.}, static_cast<void*>(w)), 0);  
```

我们看uv_thread_create_ex的逻辑

```c
1.int uv_thread_create_ex(uv_thread_t* tid,  
2.                        const uv_thread_options_t* params,  
3.                        void (*entry)(void *arg),  
4.                        void *arg) {  
5.  // 忽略部分代码  
6.  err = pthread_create(tid, attr, f.out, arg);  
7.  return UV__ERR(err);  
8.}  
```

接着我们看一下pthread_create的返回值定义
On success, pthread_create() returns 0; on error, it returns an error
number, and the contents of *thread are undefined.
所以，如果uv_thread_create_ex返回非0，即pthread_create返回非0。表示报错。我们回头看一下返回非0时，c++的处理。我们对c++层的CHECK_EQ(uv_thread_create_ex(…), 0)进行宏展开。

```c
1.#define CHECK_EQ(a, b) CHECK((a) == (b))  
2.  
3.#define CHECK(expr)            \  
4.  do {                        \  
5.    if (UNLIKELY(!(expr))) {  \  
6.      ERROR_AND_ABORT(expr);  \  
7.    }                          \  
8.  } while (0)  
9.  
10.#define UNLIKELY(expr) expr  
```

通过一些列展开，最后变成

```c
1.do {                           
2.   if (!(返回值 == 0)) {      
3.     ERROR_AND_ABORT(expr);               
4.   }                            
5.} while (0)  
```

因为创建线程时返回非0，所以这里是true。我们继续看ERROR_AND_ABORT

```c
1.#define ERROR_AND_ABORT(expr)    
2.  do {                   
3.    static const node::AssertionInfo args = { \  
4.      __FILE__ ":" STRINGIFY(__LINE__), #expr, PRETTY_FUNCTION_NAME\  
5.    };                        \  
6.    node::Assert(args);        \  
7.  } while (0)  
```

拼接错误信息，然后执行node::Assert(args);

```c
1.[[noreturn]] void Assert(const AssertionInfo& info) {  
2.  char name[1024];  
3.  GetHumanReadableProcessName(&name);  
4.  
5.  fprintf(stderr,  
6.          "%s: %s:%s%s Assertion `%s' failed.\n",  
7.          name,  
8.          info.file_line,  
9.          info.function,  
10.          *info.function ? ":" : "",  
11.          info.message);  
12.  fflush(stderr);  
13.  
14.  Abort();  
15.}  
```

重点是Abort，

```c
1.[[noreturn]] void Abort() {  
2.  DumpBacktrace(stderr);  
3.  fflush(stderr);  
4.  ABORT_NO_BACKTRACE();  
5.}  
```

继续看ABORT_NO_BACKTRACE

```c
1.#ifdef _WIN32  
2.#define ABORT_NO_BACKTRACE() _exit(134)  
3.#else  
4.#define ABORT_NO_BACKTRACE() abort()  
5.#endif  
```

所以最终调用的是_exit或abort退出或者终止进程。我们讨论linux下的情况。我们看abort函数的说明
The abort() function first unblocks the SIGABRT signal, and then
raises that signal for the calling process (as though raise(3) was
called). This results in the abnormal termination of the process
unless the SIGABRT signal is caught and the signal handler does not
return (see longjmp(3)).
If the SIGABRT signal is ignored, or caught by a handler that
returns, the abort() function will still terminate the process. It
does this by restoring the default disposition for SIGABRT and then
raising the signal for a second time.
abort函数会给进程发送SIGABRT信号，我们可以注册函数处理这个信号，不过我们还是无法阻止进程的退出，因为他执行完我们的处理函数后，会把处理函数注册为系统的默认的，然后再次发送SIGABRT信号，而默认的行为就是终止进程。我们来个测试。

```c
1.const { Worker, threadId } = require('worker_threads');  
2.for (let i = 0; i < 1000; i++) {  
3.    const worker = new Worker('var a = 1;', { eval: true });  
4.}  
```

我们创建1000个线程。结果


![在这里插入图片描述](https://img-blog.csdnimg.cn/20200901231753368.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L2h1aWh1b3hxYw==,size_16,color_FFFFFF,t_70#pic_center)


在nodejs创建过多的线程可能会导致进程终止。而我们无法阻止这个行为。所以在nodejs里使用多线程的时候，我们需要注意的就是不要开启过多的线程，而在创建线程的时候，我们也不需要关注是否成功，因为只要进程不挂掉，那就是成功。对于业务错误我们可以注册error事件处理，在new Worker的时候，我们可以加try catch。可以捕获一下参数错误的情况。
### 14.4.2 如何控制线程的数量
刚才我们已经说到，创建线程过多会导致进程挂掉，所以我们需要考虑如何去控制线程的数量。从而尽可能保证nodejs进程不会因为创建过多线程而挂掉。成本比较低的方案就是在业务代码和创建线程之间增加一层。这一层是对nodejs worker_threads的封装。在worker_threads的基础上，加上流量控制功能，最多开启n个子线程，达到阈值，会先缓存任务，等到有子线程退出的时候，再次创建新的子线程。但是会有线程的创建和销毁，带有一定的开销。他只是用于控制系统中线程的数量。业务代码通过我们封装后的函数创建线程，而不是直接使用new Worker创建线程。我们看一下这个方案的实现。

```c
1.class ThreadGate {  
2.    constructor() {  
3.        // 任务队列  
4.        this._workQueue = [];  
5.        // 当前线程数  
6.        this._count = 0;  
7.    }  
8.  
9.    _newThread(...rest) {   
10.        const worker = new Worker(...rest);  
11.        this._count++;  
12.        worker.on('exit', () => {  
13.            this._count--;  
14.            // 有名额了并且有任务在等待  
15.            if (this._workQueue.length) {  
16.               const {  
17.                   resolve,  
18.                   reject,  
19.                   params,  
20.               } = this._workQueue.shift();  
21.               // 开启线程，并且通知用户  
22.               resolve(this._newThread(...params));  
23.            }  
24.        });  
25.        return worker;  
26.    }  
27.    // 提交一个任务  
28.    submit(...rest) {  
29.        return new Promise((resolve, reject) => {  
30.            // 还没有达到阈值，则新建线程，否则缓存起来  
31.            if (this._count < CONFIG.MAX_THREAD) {  
32.                resolve(this._newThread(...rest));  
33.            } else {  
34.                this._workQueue.push({resolve, reject, params: rest});  
35.            }  
36.        });  
37.    }  
38.}  
```

通过submit方法去提交一个创建线程的请求，如果线程数还没有达到阈值，则新建一个线程，否则把任务插入等到队列，当有线程退出的时候，我们从等待队列中取出一个节点，创建一个线程。然后通知调用方。虽然多加了一层，但是除了把创建线程的方式从new Worker变成await submit外，几乎是没有额外成本的，因为返回的是一个Worker对象，就像使用new Worker一样可以对返回的对象进行各种操作。
### 14.4.3 线程池
虽然增加一层可以缓解创建线程的问题，但是过多地动态创建、销毁线程，会带来大量的开销。另外一种解决方案就是线程池。我们在应用层维护一个nodejs线程池。不仅可以控制子线程的数量，还能减少线程的动态创建和销毁带来的开销。线程池的设计涉及到很多方面，对于纯cpu型的任务，线程数和cpu核数要相等才能达到最优的性能，否则过多的线程引起的上下文切换反而会导致性能下降。而对于io型的任务，更多的线程理论上是会更好，因为可以更早地给硬盘发出命令，磁盘会优化并持续地处理请求，想象一下，如果发出一个命令，硬盘处理一个，然后再发下一个命令，再处理一个，这样显然效率很低。当然，线程数也不是越多越好。线程过多会引起系统负载过高，过多上下文切换也会带来性能的下降。下面看一下线程池的实现方案。
#### 14.4.3.1 设计思路
首先根据配置创建多个线程（分为预创建和懒创建），然后对用户暴露提交任务的接口，由调度中心负责接收任务，然后根据策略选择处理该任务的线程。子线程一直在轮询是否有任务需要处理。处理完通知调度中心。
![在这里插入图片描述](https://img-blog.csdnimg.cn/20200901231850222.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L2h1aWh1b3hxYw==,size_16,color_FFFFFF,t_70#pic_center)

下面看一下具体的实现


**1和用户通信的数据结构**




```c
1.class UserWork extends EventEmitter {  
2.    constructor({ workId, threadId }) {  
3.        super();  
4.        this.workId = workId;  
5.        this.threadId = threadId;  
6.        workPool[workId] = this;  
7.    }  
8.}  
```

用户提交任务的时候，调度中心返回一个UserWork对象。用户可以使用该对象和调度中心通信。


**2调度中心的实现**


调度中心的实现大致分为以下几个逻辑。
初始化

```c
1.constructor(options = {}) {  
2.       this.options = options;  
3.       // 线程池总任务数  
4.       this.totalWork = 0;  
5.       // 子线程队列  
6.       this.workerQueue = [];  
7.       // 核心线程数  
8.       this.coreThreads = ~~options.coreThreads || config.CORE_THREADS;  
9.       // 线程池最大线程数，如果不支持动态扩容则最大线程数等于核心线程数  
10.       this.maxThreads = options.expansion !== false ? Math.max(this.coreThreads, config.MAX_THREADS) : this.coreThreads;  
11.       // 工作线程处理任务的模式  
12.       this.sync = options.sync !== false;  
13.       // 超过任务队列长度时的处理策略  
14.       this.discardPolicy = options.discardPolicy ? options.discardPolicy : DISCARD_POLICY.NOT_DISCARD;  
15.       // 是否预创建子线程  
16.       this.preCreate = options.preCreate === true;  
17.       this.maxIdleTime = ~~options.maxIdleTime || config.MAX_IDLE_TIME;  
18.       this.pollIntervalTime = ~~options.pollIntervalTime || config.POLL_INTERVAL_TIME;  
19.       this.maxWork = ~~options.maxWork || config.MAX_WORK;  
20.       // 是否预创建线程池  
21.       this.preCreate && this.preCreateThreads();  
22.   }  
```

从初始化代码中我们看到线程池大致支持的能力。

核心线程数
最大线程数
过载时的处理策略，和过载的阈值
子线程空闲退出的时间和轮询任务的时间
是否预创建线程池
是否支持动态扩容

核心线程数是任务数没有达到阈值时的工作线程集合。是处理任务的主力军。任务数达到阈值后，如果支持动态扩容（可配置）则会创建新的线程去处理更多的任务。一旦负载变低，线程空闲时间达到阈值则会自动退出。如果扩容的线程数达到阈值，还有新的任务到来，则根据丢弃策略进行相关的处理。
创建线程

```c
1.newThread() {  
2.        let { sync } = this;  
3.        const worker = new Worker(workerPath, {workerData: { sync, maxIdleTime: this.maxIdleTime, pollIntervalTime: this.pollIntervalTime, }});  
4.        const node = new Node({worker});  
5.        this.workerQueue.push(node);  
6.        const threadId = worker.threadId;  
7.        worker.on('exit', (status) => {  
8.            // 异常退出则补充线程，正常退出则不补充  
9.            if (status) {  
10.                this.newThread();  
11.            }  
12.            this.totalWork -= node.queueLength;  
13.            this.workerQueue = this.workerQueue.filter(({worker}) => {  
14.                return worker.threadId !== threadId;  
15.            });  
16.        });  
17.        // 和子线程通信  
18.        worker.on('message', (result) => {  
19.            const {  
20.                work,  
21.                event,  
22.            } = result;  
23.            const { data, error, workId } = work;  
24.            // 通过workId拿到对应的userWorker  
25.            const userWorker = workPool[workId];  
26.            delete workPool[workId];  
27.            // 任务数减一  
28.            node.queueLength--;  
29.            this.totalWork--;  
30.            switch(event) {  
31.                case 'done':  
32.                    // 通知用户，任务完成  
33.                    userWorker.emit('done', data);  
34.                    break;  
35.                case 'error':  
36.                    // 通知用户，任务出错  
37.                    if (EventEmitter.listenerCount(userWorker, 'error')) {  
38.                        userWorker.emit('error', error);  
39.                    }  
40.                    break;  
41.                default: break;  
42.            }  
43.        });  
44.        worker.on('error', (...rest) => {  
45.            console.log(...rest)  
46.        });  
47.        return node;  
48.    }  
```

创建线程主要是调用nodejs提供的模块进行创建。然后监听子线程的退出和message、error事件。如果是异常退出则补充线程。调度中心维护了一个子线程的队列。记录了每个子线程（worker）的实例和任务数。
选择执行任务的线程

```c
1.selectThead() {  
2.        let min = Number.MAX_SAFE_INTEGER;  
3.        let i = 0;  
4.        let index = 0;  
5.        // 找出任务数最少的线程，把任务交给他  
6.        for (; i < this.workerQueue.length; i++) {  
7.            const { queueLength } = this.workerQueue[i];  
8.            if (queueLength < min) {  
9.                index = i;  
10.                min = queueLength;  
11.            }  
12.        }  
13.        return this.workerQueue[index];  
14.    }  
```

选择策略目前是选择任务数最少的，本来还支持随机和轮询方式，但是貌似没有什么场景和必要，就去掉了。
暴露提交任务的接口

```c
1.submit(filename, options = {}) {  
2.        return new Promise(async (resolve, reject) => {  
3.            let thread;  
4.            // 没有线程则创建一个  
5.            if (this.workerQueue.length) {  
6.                thread = this.selectThead();  
7.                // 任务队列非空  
8.                if (thread.queueLength !== 0) {  
9.                    // 子线程个数还没有达到核心线程数，则新建线程处理  
10.                    if (this.workerQueue.length < this.coreThreads) {  
11.                        thread = this.newThread();  
12.                    } else if (this.totalWork + 1 > this.maxWork){  
13.                        // 总任务数已达到阈值，还没有达到线程数阈值，则创建  
14.                        if(this.workerQueue.length < this.maxThreads) {  
15.                            thread = this.newThread();  
16.                        } else {  
17.                            // 处理溢出的任务  
18.                            switch(this.discardPolicy) {  
19.                                case DISCARD_POLICY.ABORT:   
20.                                    return reject(new Error('queue overflow'));  
21.                                case DISCARD_POLICY.CALLER_RUNS:   
22.                                    const userWork =  new UserWork({workId: this.generateWorkId(), threadId});   
23.                                    try {  
24.                                        const asyncFunction = require(filename);  
25.                                        if (!isAsyncFunction(asyncFunction)) {  
26.                                            return reject(new Error('need export a async function'));  
27.                                        }  
28.                                        const result = await asyncFunction(options);  
29.                                        resolve(userWork);  
30.                                        setImmediate(() => {  
31.                                            userWork.emit('done', result);  
32.                                        });  
33.                                    } catch (error) {  
34.                                        resolve(userWork);  
35.                                        setImmediate(() => {  
36.                                            userWork.emit('error', error);  
37.                                        });  
38.                                    }  
39.                                    return;  
40.                                case DISCARD_POLICY.DISCARD_OLDEST:   
41.                                    thread.worker.postMessage({cmd: 'delete'});  
42.                                    break;  
43.                                case DISCARD_POLICY.DISCARD:  
44.                                    return reject(new Error('discard'));  
45.                                case DISCARD_POLICY.NOT_DISCARD:  
46.                                    break;  
47.                                default:   
48.                                    break;  
49.                            }  
50.                        }  
51.                    }  
52.                }  
53.            } else {  
54.                thread = this.newThread();  
55.            }  
56.            // 生成一个任务id  
57.            const workId = this.generateWorkId();  
58.            // 新建一个work，交给对应的子线程  
59.            const work = new Work({ workId, filename, options });  
60.            const userWork = new UserWork({workId, threadId: thread.worker.threadId});  
61.            thread.queueLength++;  
62.            this.totalWork++;  
63.            thread.worker.postMessage({cmd: 'add', work});  
64.            resolve(userWork);  
65.        })  
66.    }  
```

提交任务的函数比较复杂，提交一个任务的时候，调度中心会根据当前的负载情况和线程数，决定对一个任务做如何处理。如果可以处理，则把任务交给选中的子线程。最后给用户返回一个UserWorker对象。
调度中心和子线程的通信数据结构

```c
1.class Work {  
2.    constructor({workId, filename, options}) {  
3.        // 任务id  
4.        this.workId = workId;  
5.        // 文件名或者js代码字符串  
6.        this.filename = filename;  
7.        // 处理结果，由用户代码返回  
8.        this.data = null;  
9.        // 执行出错  
10.        this.error = null;  
11.        // 执行时入参  
12.        this.options = options;  
13.    }  
14.}  
```

子线程的实现
子线程的实现主要分为几个部分
监听调度中心分发的命令

```c
1.parentPort.on('message', ({cmd, work}) => {  
2.    switch(cmd) {  
3.        case 'delete':  
4.            return queue.shift();  
5.        case 'add':  
6.            return queue.push(work);  
7.    }  
8.});  
```

轮询是否有任务需要处理

```c
1.function poll() {  
2.    const now = Date.now();  
3.    if (now - lastWorkTime > maxIdleTime && !queue.length) {  
4.        process.exit(0);  
5.    }  
6.    setTimeout(async () => {  
7.        // 处理任务  
8.        poll();  
9.    }  
10.    }, pollIntervalTime);  
11.}  
12.// 轮询判断是否有任务  
13.poll();  
```

不断轮询是否有任务需要处理，如果没有并且空闲时间达到阈值则退出。
处理任务
处理任务模式分为同步和异步

```c
1.while(queue.length) {  
2.    const work = queue.shift();  
3.    try {  
4.        const { filename, options } = work;  
5.        let aFunction;  
6.        if (jsFileRegexp.test(filename)) {  
7.            aFunction = require(filename);  
8.        } else {  
9.            aFunction = vm.runInThisContext(`(${filename})`);  
10.        }  
11.          
12.        if (!isFunction(aFunction)) {  
13.            continue;  
14.        }  
15.        lastWorkTime = now;  
16.          
17.        const result = await aFunction(options);  
18.        work.data = result;  
19.        parentPort.postMessage({event: 'done', work});  
20.    } catch (error) {  
21.        work.error = error.toString();  
22.        parentPort.postMessage({event: 'error', work});  
23.    }  
24.}  
```

用户需要导出一个函数，使用这种方案主要是为了执行时可以给用户传入参数。处理完后通知调度中心。下面是异步处理方式，子线程不需要同步等待用户的代码结果。

```c
1.const arr = [];  
2.while(queue.length) {  
3.    const work = queue.shift();  
4.    try {  
5.        const { filename } = work;  
6.        const asyncFunction = require(filename);  
7.        if (!isAsyncFunction(asyncFunction)) {  
8.            return;  
9.        }  
10.        arr.push({asyncFunction, work});  
11.    } catch (error) {  
12.        work.error = error.toString();  
13.        parentPort.postMessage({event: 'error', work});  
14.    }  
15.}  
16.arr.map(async ({asyncFunction, work}) => {  
17.    try {  
18.        const { options } = work;  
19.        lastWorkTime = now;  
20.        const result = await asyncFunction(options);  
21.        work.data = result;  
22.        parentPort.postMessage({event: 'done', work});  
23.    } catch (e) {  
24.        work.error = error.toString();  
25.        parentPort.postMessage({event: 'done', work});  
26.    }  
27.})  
28.最后还有一些配置和定制化的功能。
29.module.exports = {  
30.    // 最大的线程数  
31.    MAX_THREADS: 50,  
32.    // 线程池最大任务数  
33.    MAX_WORK: Infinity,  
34.    // 默认核心线程数  
35.    CORE_THREADS: 10,  
36.    // 最大空闲时间  
37.    MAX_IDLE_TIME: 10 * 60 * 1000,  
38.    // 子线程轮询时间  
39.    POLL_INTERVAL_TIME: 10,  
40.};  
41.// 丢弃策略  
42.const DISCARD_POLICY = {  
43.    // 报错  
44.    ABORT: 1,  
45.    // 在主线程里执行  
46.    CALLER_RUNS: 2,  
47.    // 丢弃最老的的任务  
48.    DISCARD_OLDEST: 3,  
49.    // 丢弃  
50.    DISCARD: 4,  
51.    // 不丢弃  
52.    NOT_DISCARD: 5,  
53.};  
54.支持多个类型的线程池
55.class AsyncThreadPool extends ThreadPool {  
56.    constructor(options) {  
57.        super({...options, sync: false});  
58.    }  
59.}  
60.  
61.class SyncThreadPool extends ThreadPool {  
62.    constructor(options) {  
63.        super({...options, sync: true});  
64.    }  
65.}  
66.// cpu型任务的线程池，线程数和cpu核数一样，不支持动态扩容  
67.class CPUThreadPool extends ThreadPool {  
68.    constructor(options) {  
69.        super({...options, coreThreads: cores, expansion: false});  
70.    }  
71.}  
72.// 线程池只有一个线程，类似消息队列  
73.class SingleThreadPool extends ThreadPool {  
74.    constructor(options) {  
75.        super({...options, coreThreads: 1, expansion: false });  
76.    }  
77.}  
78.// 线程数固定的线程池，不支持动态扩容线程  
79.class FixedThreadPool extends ThreadPool {  
80.    constructor(options) {  
81.        super({ ...options, expansion: false });  
82.    }  
83.}  
```

测试

```c
1.module.exports = async function() {  
2.    let ret = 0;  
3.    let i = 0;  
4.    while(i++ < 10000) {  
5.        ret++;  
6.        Buffer.from(String(Math.random())).toString('base64');  
7.    }  
8.    return ret;  
9.}  
```

在服务器以单线程和多线程的方式执行以上代码，下面是MAX为10000和100000时，使用CPUThreadPool类型线程池的性能对比（具体代码参考https://github.com/theanarkh/nodejs-threadpool）。
10000
单线程 [ 358.35, 490.93, 705.23, 982.6, 1155.72 ]
多线程 [ 379.3, 230.35, 315.52, 429.4, 496.04 ]
100000
单线程 [ 2485.5, 4454.63, 6894.5, 9173.16, 11011.16 ]
多线程 [ 1791.75, 2787.15, 3275.08, 4093.39, 3674.91 ]
我们发现这个数据差别非常明显。并且随着处理时间的增长，性能差距越明显。
更多参考[如何解决nodejs中cpu密集型的任务](https://zhuanlan.zhihu.com/p/220478526) 
