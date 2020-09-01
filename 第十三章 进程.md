# 第十三章 进程
## 13.1 进程的概念
进程和线程是操作系统里很重要的概念，但是所有的东西都会落实到代码。看起来很复杂的进程线程，其实在操作系统的代码里。也只是一些数据结构和算法。只不过他比一般的数据结构和算法可能复杂点。进程在操作系统里，是用一个task_struct结构体表示的。因为操作系统是大部分是用c语言实现的，没有对象这个概念。如果我们用高级语言来理解的话，每个进程就是一个对象。每次新建一个进程，就是新建一个对象。task_struct结构体可以说是类的定义。task_struct结构体里保持了一个进程所需要的一些信息，包括执行状态，执行上下文tss，打开的文件、根目录、工作目录、收到的信号、信号处理函数、代码段、数据段的位置，进程id，执行时间、退出码等等。我们具体看一下这些数据结构的作用。
### 13.1.1 执行上下文
tss_struct和desc_struct结构体记录了进程执行的上下文，每次进程切换的时候，如果是被调度执行，则上下文加载到cpu和对应的硬件中，如果是被挂起，则cpu和硬件的信息保存到上下文。下次执行的时候恢复。
以上就是一个进程所具有的一些属性。我们发现，进程也没有那么难以理解，好比我们平时定义一个人，他有名字，身高，年龄属性一样。每个对象，他都有属于自己的一些属性。
简单了解了一些进程的一些概念后，我们看看nodejs的进程，我们知道nodejs是单进程（单线程）的，但是nodejs也为用户实现了多进程的能力，我们从nodejs主进程和子进程的角度来看一下nodejs的进程。
### 13.1.2 进程的管理
操作系统里会维护一个task_struct数组或者链表来记录当前系统中所有的进程。每次新建一个进程的时候，就会往里面追加一个task_struct结构体，每次销毁一个进程的时候，该进程的父进程会删除对应的task_struct。
### 13.1.3 进程的调度
操作系统的运作，很大程度上是由时钟驱动的，电脑中会有一个硬件间歇性地产生时钟中断。中断间隔是由操作系统初始化该硬件时决定的（定时器也是由该硬件驱动的，我们在应用层使用的定时器功能，归根到底还是使用系统的定时器去实现的）。每次时钟中断的时候如果当前执行的进程时间片已到，则会发生进程调度。另外进程阻塞的时候，也会发送进程调度。被调度到的进程，系统就会把task_struct里的tss信息加载到cpu。包括当前执行的代码位置，各种寄存器的值。然后就完成了进程的切换。
### 13.1.4 进程的执行时间
每次时钟中断的时候，时钟中断处理程序都会累加当前进程的执行时间，我们平时查看的进程的执行时间，这些数据就是由这些字段记录的。一个进程在内核态和用户态下执行的时间，是分开计算的。
### 13.1.5 信号
task_struct中用三个字段实现了信号相关的功能，一个是signal，记录了进程收到的信号，按位计算。blocked就是记录当前进程不接收哪些信号。sigaction则是记录每个信号对应的处理函数，和signal一一对应。每次我们调用kill的时候，其实就是修改signal字段的值。然后在某些时机下，系统会执行sigaction里对应的函数。这些时机包括系统调用返回，时钟中断处理程序返回、还有其他的硬件中断返回等等。
### 13.1.6 状态
task_struct用一个字段state记录了进程当前的状态，exit_code记录进程退出时的退出码。
### 13.1.7 文件系统相关
当前进程的根目录、工作目录。我们平时在进程里打开一个文件的时候，如果没有写明绝对路径，系统就会以工作目录为基础，加上我们传的相对路径拼出绝对路径。从而找到文件。另外filp字段是维护进程打开的文件信息。我们平时拿到的文件描述符就是filp字段的索引。他会逐步找到底层对应的文件或者socket。executable是保存进程对应的二进制文件所在的文件信息。我们都知道程序加载到内存变成进程。executable保存的就是程序对应的文件的信息。
### 13.1.8 权限
task_struct里用uid、euid、gid、egid等字段记录进程的权限信息。
### 13.1.9 进程关系信息
pid字段记录了当前进程的id，father记录了父进程的id。pgrp,session,leader分别是组id，会话id，是不是会话leader。多个进程组成一个组，多个组组成一个会话。如果一个进程是这个组或者会话的leader，则他的id会成为组或者会话的id，比如
组1有进程a的id是1（组leader、会话leader）进程b的id是2。
组2有进程c的id是3（组leader），进程d的id是4。
所有进程在一个会话，则组1的所有进程的组id和会话id都是1。组2所有进程的组id是3，会话id是1。

## 13.2 nodejs主进程
当我们执行node index.js的时候，操作系统就会创建一个nodejs进程。我们的代码就是在这个nodejs中执行，从代码角度来说，我们感知进程的方式是通过process对象。本节我们分析一下这个对象。
### 13.2.1 创建process对象

```c
1.Local<Object> process_object = node::CreateProcessObject(this).FromMaybe(Local<Object>());  
2.set_process_object(process_object);  
```

process对象通过CreateProcessObject创建，然后保存到env对象中。我们看一下CreateProcessObject。

```c
1.MaybeLocal<Object> CreateProcessObject(Environment* env) {  
2.  Isolate* isolate = env->isolate();  
3.  EscapableHandleScope scope(isolate);  
4.  Local<Context> context = env->context();  
5.  
6.  Local<FunctionTemplate> process_template = FunctionTemplate::New(isolate);  
7.  process_template->SetClassName(env->process_string());  
8.  Local<Function> process_ctor;  
9.  Local<Object> process;  
10.  if (!process_template->GetFunction(context).ToLocal(&process_ctor) ||  
11.      !process_ctor->NewInstance(context).ToLocal(&process)) {  
12.    return MaybeLocal<Object>();  
13.  }  
14.  // nodejs的版本  
15.  READONLY_PROPERTY(process,"version", FIXED_ONE_BYTE_STRING(env->isolate(), NODE_VERSION));  
16.  // 设置一系列属性  
17.  return scope.Escape(process);  
18.}  
19. 
```

这是使用v8创建一个对象的典型例子，并且设置了一些属性。Nodejs启动过程中，很多地方都会给process挂载属性。下面我们看我们常用的process.env是怎么挂载的。
### 13.2.2 挂载env属性

```c
1.Local<String> env_string = FIXED_ONE_BYTE_STRING(isolate_, "env");  
2.Local<Object> env_var_proxy;  
3.if (!CreateEnvVarProxy(context(), isolate_, as_callback_data())  
4.         .ToLocal(&env_var_proxy) ||  
5.    process_object()->Set(context(), env_string, env_var_proxy).IsNothing()) {  
6.  return MaybeLocal<Value>();  
7.}  
```

上面的代码给process挂载了env属性。他的值是CreateEnvVarProxy创建的对象。

```c
1.MaybeLocal<Object> CreateEnvVarProxy(Local<Context> context,  
2.                                     Isolate* isolate,  
3.                                     Local<Object> data) {  
4.  EscapableHandleScope scope(isolate);  
5.  Local<ObjectTemplate> env_proxy_template = ObjectTemplate::New(isolate);  
6.  env_proxy_template->SetHandler(NamedPropertyHandlerConfiguration(  
7.      EnvGetter, EnvSetter, EnvQuery, EnvDeleter, EnvEnumerator, data,  
8.      PropertyHandlerFlags::kHasNoSideEffect));  
9.  return scope.EscapeMaybe(env_proxy_template->NewInstance(context));  
10.}  
```

首先申请一个c++对象（v8对象），然后设置该对象的访问描述符。我们看一下getter描述符（EnvGetter）的实现，getter描述符和我们在js里使用的类似。

```c
1.static void EnvGetter(Local<Name> property,  
2.                      const PropertyCallbackInfo<Value>& info) {  
3.  Environment* env = Environment::GetCurrent(info);  
4.  MaybeLocal<String> value_string = env->env_vars()->Get(env->isolate(), property.As<String>());  
5.  if (!value_string.IsEmpty()) {  
6.    info.GetReturnValue().Set(value_string.ToLocalChecked());  
7.  }  
8.}  
```

我们看到getter是从env->env_vars()中获取数据，那么env->env_vars()又是什么呢。env_vars是一个kv系统，其实就是一个map。他只在nodejs初始化的时候设置（创建env对象时）。
set_env_vars(per_process::system_environment);  
那么per_process::system_environment又是什么呢？继续看，
std::shared_ptr<KVStore> system_environment = std::make_shared<RealEnvStore>();  
我们看到system_environment是一个RealEnvStore对象。我们看一下RealEnvStore类的实现。

```c
1.class RealEnvStore final : public KVStore {  
2. public:  
3.  MaybeLocal<String> Get(Isolate* isolate, Local<String> key) const override;  
4.  void Set(Isolate* isolate, Local<String> key, Local<String> value) override;  
5.  int32_t Query(Isolate* isolate, Local<String> key) const override;  
6.  void Delete(Isolate* isolate, Local<String> key) override;  
7.  Local<Array> Enumerate(Isolate* isolate) const override;  
8.};  
```

比较简单，就是增删改查，我们看一下查询Get的实现。

```c
1.MaybeLocal<String> RealEnvStore::Get(Isolate* isolate,  
2.                                     Local<String> property) const {  
3.  Mutex::ScopedLock lock(per_process::env_var_mutex);  
4.  
5.  node::Utf8Value key(isolate, property);  
6.  size_t init_sz = 256;  
7.  MaybeStackBuffer<char, 256> val;  
8.  int ret = uv_os_getenv(*key, *val, &init_sz);  
9.  if (ret >= 0) {  // Env key value fetch success.  
10.    MaybeLocal<String> value_string =  
11.        String::NewFromUtf8(isolate, *val, NewStringType::kNormal, init_sz);  
12.    return value_string;  
13.  }  
14.  
15.  return MaybeLocal<String>();  
16.}  
```

我们看到是通过uv_os_getenv获取的数据。uv_os_getenv是对getenv函数的封装，进程的内存布局中，有一部分是用于存储环境变量的，getenv就是从那一块内存中把数据读取出来。我们执行execve的时候可以设置环境变量。具体的我们在子进程章节会看到。
### 13.2.3 挂载其他属性
在nodejs的起点过程中会不断地挂载属性到process。主要在bootstrap/node.js中。

```c
1.const rawMethods = internalBinding('process_methods');
2.process.dlopen = rawMethods.dlopen;  
3.process.uptime = rawMethods.uptime;  
4.process.reallyExit = rawMethods.reallyExit;  
5.process._kill = rawMethods._kill;  
```

下面是process_methods模块导出的属性，主列出常用的。

```c
1.env->SetMethod(target, "abort", Abort);  
2.env->SetMethod(target, "chdir", Chdir);  
3.env->SetMethod(target, "memoryUsage", MemoryUsage);  
4.env->SetMethod(target, "cpuUsage", CPUUsage);  
5.env->SetMethod(target, "hrtime", Hrtime);  
6.env->SetMethod(target, "hrtimeBigInt", HrtimeBigInt);  
7.env->SetMethod(target, "resourceUsage", ResourceUsage);  
8.env->SetMethod(target, "_kill", Kill);  
9.env->SetMethodNoSideEffect(target, "cwd", Cwd);  
10.env->SetMethod(target, "dlopen", binding::DLOpen);  
11.env->SetMethod(target, "reallyExit", ReallyExit);  
12.env->SetMethodNoSideEffect(target, "uptime", Uptime);  
13.env->SetMethod(target, "patchProcessObject", PatchProcessObject);  
```

我们看到在js层访问process属性的时候，访问的是对应的c++层的这些方法，大部分也只是对libuv的封装。另外PatchProcessObject函数会挂载一些额外的属性给process。

```c
1.// process.argv  
2.process->Set(context,  
3.             FIXED_ONE_BYTE_STRING(isolate, "argv"),  
4.             ToV8Value(context, env->argv()).ToLocalChecked()).Check();  
5.  
6.// process.execArgv  
7.process->Set(context,  
8.             FIXED_ONE_BYTE_STRING(isolate, "execArgv"),  
9.             ToV8Value(context, env->exec_argv())  
10.                 .ToLocalChecked()).Check();  
11.  
12.READONLY_PROPERTY(process, "pid",  
13.                  Integer::New(isolate, uv_os_getpid()));  
14.  
15.CHECK(process->SetAccessor(context,  
16.                           FIXED_ONE_BYTE_STRING(isolate, "ppid"),  
17.                           GetParentProcessId).FromJust())  
```

因为nodejs支持多线程，所以针对线程的情况，有一些特殊的处理。

```c
1.const perThreadSetup = require('internal/process/per_thread');  
2.// rawMethods来自process_methods模块导出的属性
3.const wrapped = perThreadSetup.wrapProcessMethods(rawMethods);  
4.process._rawDebug = wrapped._rawDebug;  
5.process.hrtime = wrapped.hrtime;  
6.process.hrtime.bigint = wrapped.hrtimeBigInt;  
7.process.cpuUsage = wrapped.cpuUsage;  
8.process.resourceUsage = wrapped.resourceUsage;  
9.process.memoryUsage = wrapped.memoryUsage;  
10.process.kill = wrapped.kill;  
11.process.exit = wrapped.exit;  
```

大部分函数都是对process_methods模块的封装。但是有一个属性我们需要关注一下，就是exit，因为在线程中调用process.exit的时候，只会退出单个线程，而不是整个进程。

```c
1.function exit(code) {  
2.   if (code || code === 0)  
3.     process.exitCode = code;  
4.  
5.   if (!process._exiting) {  
6.     process._exiting = true;  
7.     process.emit('exit', process.exitCode || 0);  
8.   }  
9.   process.reallyExit(process.exitCode || 0);  
10. }  
```

我们继续看reallyExit

```c
1.static void ReallyExit(const FunctionCallbackInfo<Value>& args) {  
2.  Environment* env = Environment::GetCurrent(args);  
3.  RunAtExit(env);  
4.  int code = args[0]->Int32Value(env->context()).FromMaybe(0);  
5.  env->Exit(code);  
6.}  
```

调用了env的Exit。

```c
1.void Environment::Exit(int exit_code) {  
2.  if (is_main_thread()) {  
3.    stop_sub_worker_contexts();  
4.    DisposePlatform();  
5.    exit(exit_code);  
6.  } else {  
7.    worker_context_->Exit(exit_code);  
8.  }  
9.}  
```

这里我们看到了重点，根据当前是主线程还是子线程会做不同的处理。一个线程会对应一个env，env对象中的worker_context_保存就是线程对象（Worker）。我们先看子线程的逻辑。

```c
1.void Worker::Exit(int code) {  
2.  Mutex::ScopedLock lock(mutex_);  
3.  if (env_ != nullptr) {  
4.    exit_code_ = code;  
5.    Stop(env_);  
6.  } else {  
7.    stopped_ = true;  
8.  }  
9.}  
10.  
11.int Stop(Environment* env) {  
12.  env->ExitEnv();  
13.  return 0;  
14.}  
15.  
16.void Environment::ExitEnv() {  
17.  set_can_call_into_js(false);  
18.  set_stopping(true);  
19.  isolate_->TerminateExecution();  
20.  // 退出libuv事件循环  
21.  SetImmediateThreadsafe([](Environment* env) { uv_stop(env->event_loop()); });  
22.}  
```

我们看到子线程最后调用uv_stop提出了libuv事件循环，然后退出（为什么会退出可以参考子线程章节）。我们再来看主线程的退出逻辑。

```c
1.if (is_main_thread()) {  
2.  stop_sub_worker_contexts();  
3.  DisposePlatform();  
4.  exit(exit_code);  
5.}  
```

我们看到最后主进程中调用exit退出进程。但是退出前还有一些处理工作，我们看stop_sub_worker_contexts

```c
1.void Environment::stop_sub_worker_contexts() {  
2.  while (!sub_worker_contexts_.empty()) {  
3.    Worker* w = *sub_worker_contexts_.begin();  
4.    remove_sub_worker_context(w);  
5.    w->Exit(1);  
6.    w->JoinThread();  
7.  }  
8.}  
```

sub_worker_contexts保存的是Worker对象列表，每次创建一个线程的时候，就会往里追加一个元素。这里遍历这个列表，然后调用Exit函数，这个刚才我们已经分析过，就是退出libuv事件循环。主线程接着调JoinThread，JoinThread主要是为了阻塞等待子线程退出，因为子线程在退出的时候，可能会被操作系统挂起（执行时间片到了），这时候主线程被调度执行，但是这时候主线程还不能退出，所以这里使用join阻塞等待子线程退出。Nodejs的JoinThread除了对线程join函数的封装。还做了一些额外的事情，比如触发exit事件。
## 13.3 创建子进程
我们首先看一下在用c语言如何创建一个进程。

```c
1.#include<unistd.h>  
2.#include<stdlib.h>  
3.   
4.int main(int argc,char *argv[]){  
5.    pid_t pid = fork();  
6.    if ( pid < 0 ) {  
7.        // 错误  
8.    } else if( pid == 0 ) {  
9.        // 子进程，可以使用exec*系列函数执行新的文件
10.    } else {  
11.        // 父进程  
12.    }  
13.}  
```

fork函数的特点，我们听得最多的可能是执行一次返回两次，我们可能会疑惑，执行一个函数怎么可能返回了两次呢？之前我们讲过，进程是task_struct表示的一个实例，调用 fork的时候，操作系统会新建一个新的task_struct实例出来（变成两个进程），fork返回两次的意思其实是在在两个进程分别执行。执行的都是fork后面的一行代码。而操作系统根据当前进程是主进程还是子进程，设置了fork函数的返回值。所以不同的进程，fork返回值不一样，也就是我们代码中if else条件。但是fork只是复制主进程的内容。如何我们想执行另外一个程序，怎么办呢？这时候就需要用到exec*系列函数，该系列函数会覆盖旧进程（task_struct）的内容，重新加载新的程序内容。这也是nodejs中创建进程的底层原理。
nodejs虽然提供了很多种创建进程的方式，但是本质上是同步和异步两种方式。
### 13.3.1 异步创建进程
我们首先看一下异步的方式，异步创建方式最终是通过spawn函数。所以我们从这个函数开始，看一下整个流程。

```c
1.var spawn = exports.spawn = function(/*file, args, options*/) {  
2.  
3.  var opts = normalizeSpawnArguments.apply(null, arguments);  
4.  var options = opts.options;  
5.  var child = new ChildProcess();  
6.   
7.  child.spawn({  
8.    file: opts.file,  
9.    args: opts.args,  
10.    cwd: options.cwd,  
11.    windowsHide: !!options.windowsHide,  
12.    windowsVerbatimArguments: !!options.windowsVerbatimArguments,  
13.    detached: !!options.detached,  
14.    envPairs: opts.envPairs,  
15.    stdio: options.stdio,  
16.    uid: options.uid,  
17.    gid: options.gid  
18.  });  
19.  
20.  return child;  
21.};  
```

我们看到spawn函数只是对ChildProcess函数的封装。然后调用他的spawn函数（只列出核心代码）。

```c
1.const { Process } = process.binding('process_wrap');  
2.  
3.function ChildProcess() {  
4.  EventEmitter.call(this);  
5.  this._handle = new Process();  
6.}  
7.  
8.ChildProcess.prototype.spawn = function(options) {  
9.    this._handle.spawn(options);  
10.}  
```

ChildProcess也是对Process的封装。Nodejs中，创建进程支持的参数非常多，我们不打算一一分析，我们只分析两个常用的，环境变量和进程间通信。Process在c++层也没有太多逻辑，进行参数的处理然后调用libuv的uv_spawn。我们通过uv_spawn来到了c语言层。

```c
1.int uv_spawn(uv_loop_t* loop,  
2.             uv_process_t* process,  
3.             const uv_process_options_t* options) {  
4.  int signal_pipe[2] = { -1, -1 };  
5.  int pipes_storage[8][2];  
6.  int (*pipes)[2];  
7.  int stdio_count;  
8.  ssize_t r;  
9.  pid_t pid;  
10.  int err;  
11.  int exec_errorno;  
12.  int i;  
13.  int status;  
14.  // 初始化process类handle  
15.  uv__handle_init(loop, (uv_handle_t*)process, UV_PROCESS);  
16.  QUEUE_INIT(&process->queue);  
17.  // 省略处理文件描述符逻辑  
18.  // 申请一个管道通信  
19.  err = uv__make_pipe(signal_pipe, 0);  
20.  // 监听SIGCHLD信号，处理函数是uv__chld  
21.  uv_signal_start(&loop->child_watcher, uv__chld, SIGCHLD);  
22.  uv_rwlock_wrlock(&loop->cloexec_lock);  
23.  // 新建一个进程  
24.  pid = fork();  
25.  // 子进程  
26.  if (pid == 0) {  
27.    uv__process_child_init(options, stdio_count, pipes, signal_pipe[1]);  
28.    // 不会执行到这  
29.    abort();  
30.  }  
31.  uv_rwlock_wrunlock(&loop->cloexec_lock);  
32.  // 关闭不需要的一端  
33.  uv__close(signal_pipe[1]);  
34.  // 进程退出码  
35.  process->status = 0;  
36.  exec_errorno = 0;  
37.  // 等待子进程执行成功  
38.  do  
39.    r = read(signal_pipe[0], &exec_errorno, sizeof(exec_errorno));  
40.  while (r == -1 && errno == EINTR); 
41.  // 子进程执行成功，返回0
42.  if (r == 0)
43.    ; /* okay, EOF */
44.  else if (r == sizeof(exec_errorno)) {
45.    do
46.      err = waitpid(pid, &status, 0); /* okay, read errorno */
47.    while (err == -1 && errno == EINTR);
48.  } else if (r == -1 && errno == EPIPE) {
49.    do
50.      err = waitpid(pid, &status, 0); /* okay, got EPIPE */
51.    while (err == -1 && errno == EINTR);
52.    assert(err == pid);
53.  } else
54.    abort();
55.  // 插入libuv的process_handle队列  
56.  if (exec_errorno == 0) {  
57.    QUEUE_INSERT_TAIL(&loop->process_handles, &process->queue);  
58.    uv__handle_start(process);  
59.  }  
60.  // 进程id和退出时执行的回调  
61.  process->pid = pid;  
62.  process->exit_cb = options->exit_cb;  
63.  return exec_errorno;  
64.}  
```

主进程fork创建子进程后，会通过read阻塞等待子进程的消息。这是libuv的架构


![libuv架构图](https://img-blog.csdnimg.cn/20200901233434451.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L2h1aWh1b3hxYw==,size_16,color_FFFFFF,t_70#pic_center)




[libuv架构图](https://img-blog.csdnimg.cn/20200901233434451.png)


我们看一下子进程的逻辑。

```c
1.static void uv__process_child_init(const uv_process_options_t* options,  
2.                                   int stdio_count,  
3.                                   int (*pipes)[2],  
4.                                   int error_fd) {  
5.  sigset_t set;  
6.  int close_fd;  
7.  int use_fd;  
8.  int err;  
9.  int fd;  
10.  int n;  
11.  // 省略处理文件描述符等参数逻辑  
12.  // 处理环境变量  
13.  if (options->env != NULL) {  
14.    environ = options->env;  
15.  }  
16.  // 处理信号  
17.  for (n = 1; n < 32; n += 1) {  
18.    // 这两个信号触发时，默认行为是进程退出且不能自定义  
19.    if (n == SIGKILL || n == SIGSTOP)  
20.      continue;  /* Can't be changed. */  
21.    // 设置为默认处理方式  
22.    if (SIG_ERR != signal(n, SIG_DFL))  
23.      continue;  
24.    // 出错则通知主进程  
25.    uv__write_int(error_fd, UV__ERR(errno));  
26.    _exit(127);  
27.  }  
28.  // 加载新的执行文件  
29.  execvp(options->file, options->args);  
30.  // 加载成功则不会走到这，走到这说明加载执行文件失败  
31.  uv__write_int(error_fd, UV__ERR(errno));  
32.  _exit(127);  
33.}  
```

子进程的逻辑主要有处理文件描述符、信号、设置环境变量等。然后加载新的执行文件。因为主进程和子进程通信的管道对应的文件描述符设置了cloexec标记。所有当子进程加载新的执行文件时，就会关闭用于和主进程通信的管道文件描述符，从而导致主进程读取的时候返回0，这样主进程就知道子进程成功执行了。我们从内核的角度看一下这个的原理。首先看一下操作系统是如何创建一个管道的。

```c
1.asmlinkage int sys_pipe(unsigned long * fildes)  
2.{  
3.    struct inode * inode;  
4.    struct file * f[2];  
5.    int fd[2];  
6.    int i,j;  
7.        // 申请两个fd作为管道两端  
8.    for(j=0 ; j<2 ; j++)  
9.        if (!(f[j] = get_empty_filp()))  
10.            break;  
11.    // 申请一个inode，inode管理着一块内存，用于管道读写，实现通信  
12.    inode=get_pipe_inode()  
13.    f[0]->f_inode = f[1]->f_inode = inode;  
14.    f[0]->f_pos = f[1]->f_pos = 0;  
15.    f[0]->f_flags = O_RDONLY;  
16.        // 读端的操作函数集  
17.    f[0]->f_op = &read_pipe_fops;  
18.    f[0]->f_mode = 1;        /* read */  
19.    f[1]->f_flags = O_WRONLY;  
20.        // 写端的操作函数集  
21.    f[1]->f_op = &write_pipe_fops;  
22.    f[1]->f_mode = 2;        /* write */  
23.    put_fs_long(fd[0],0+fildes);  
24.    put_fs_long(fd[1],1+fildes);  
25.    return 0;  
26.}  
```

接着我们看一下对管道读端执行阻塞式读但是没有数据可读时是怎样的。

```c
1.static int pipe_read(struct inode * inode, struct file * filp, char * buf, int count)  
2.{  
3.  if (PIPE_EMPTY(*inode) || PIPE_LOCK(*inode)) {  
4.    if (PIPE_EMPTY(*inode)) {  
5.      if (!PIPE_WRITERS(*inode))  
6.        return 0;  
7.    }  
8.    interruptible_sleep_on(&PIPE_WAIT(*inode));  
9.}   
```

     
我们看到，当管道没有数据可读且还有写者时，进程会被阻塞。这时候子进程执行execvp时会导致管道的写端被关闭（因为设置了close_on_exec标记）。下面是execvp的部分代码。

```c
1.for (i=0 ; i<NR_OPEN ; i++)  
2.   if (FD_ISSET(i,¤t->files->close_on_exec))  
3.    sys_close(i)  
```

我们看到操作系统会关闭设置了close_on_exec标记的文件名描述符。我们看close做了什么。

```c
1.asmlinkage int sys_close(unsigned int fd)  
2.{     
3.    struct file * filp;  
4.        // 关闭fd和file结构体的关联关系  
5.    filp = current->files->fd[fd];  
6.    current->files->fd[fd] = NULL;  
7.        // "关闭"file结构体  
8.    return (close_fp (filp));  
9.}  
10.  
11.int close_fp(struct file *filp)  
12.{  
13.    struct inode *inode;  
14.    inode = filp->f_inode;  
15.    // 如果还有fd指向该file结构体，则引用用减一即可  
16.    if (filp->f_count > 1) {  
17.        filp->f_count--;  
18.        return 0;  
19.    }  
20.        // 执行钩子函数release  
21.    if (filp->f_op && filp->f_op->release)  
22.        filp->f_op->release(inode,filp);  
23.        // 引用数减一，等于0  
24.    filp->f_count--;  
25.        // 解除file和inode的关联关系  
26.    filp->f_inode = NULL;  
27.    return 0;  
28.}  
```

重点是release函数，创建管道的时候，对于读端和写端都设置了一个操作函数集，当我们关闭写端的时候，就会执行写端对应操作函数集中的release函数。

```c
1.static void pipe_write_release(struct inode * inode, struct file * filp)  
2.{  
3.    PIPE_WRITERS(*inode)--;  
4.    wake_up_interruptible(&PIPE_WAIT(*inode));  
5.} 
```

 
我们看到这时候写者数量减一，管道只有一个写端，所以减一后等于0。然后唤醒等待的进程，即我们的主进程。当主进程被调度执行时，会继续阻塞式执行read函数。这时候因为没有写者，说明read函数返回0。
#### 13.3.1.1 处理子进程退出
主进程在创建子进程之前，会注册SIGCHLD信号。对应的处理函数是uv__chld。
当进程退出的时候。nodejs主进程会收到SIGCHLD信号。然后执行uv__chld。该函数遍历libuv进程队列中的节点，通过waitpid判断该节点对应的进程是否已经退出后，从而收集已退出的节点，然后移出libuv队列，最后执行已退出进程的回调。

```c
1.static void uv__chld(uv_signal_t* handle, int signum) {  
2.  uv_process_t* process;  
3.  uv_loop_t* loop;  
4.  int exit_status;  
5.  int term_signal;  
6.  int status;  
7.  pid_t pid;  
8.  QUEUE pending;  
9.  QUEUE* q;  
10.  QUEUE* h;  
11.  // 保存进程（已退出的状态）的队列  
12.  QUEUE_INIT(&pending);  
13.  loop = handle->loop;  
14.  
15.  h = &loop->process_handles;  
16.  q = QUEUE_HEAD(h);  
17.  //  收集已退出的进程  
18.  while (q != h) {  
19.    process = QUEUE_DATA(q, uv_process_t, queue);  
20.    q = QUEUE_NEXT(q);  
21.  
22.    do  
23.      // WNOHANG非阻塞等待子进程退出，其实就是看哪个子进程退出了，没有的话就直接返回，而不是阻塞   
24.      pid = waitpid(process->pid, &status, WNOHANG);  
25.    while (pid == -1 && errno == EINTR);  
26.  
27.    if (pid == 0)  
28.      continue;  
29.    // 进程退出了，保存退出状态，移出队列，插入peding队列，等待处理  
30.    process->status = status;  
31.    QUEUE_REMOVE(&process->queue);  
32.    QUEUE_INSERT_TAIL(&pending, &process->queue);  
33.  }  
34.  
35.  h = &pending;  
36.  q = QUEUE_HEAD(h);  
37.  // 是否有退出的进程  
38.  while (q != h) {  
39.    process = QUEUE_DATA(q, uv_process_t, queue);  
40.    q = QUEUE_NEXT(q);  
41.    QUEUE_REMOVE(&process->queue);  
42.    QUEUE_INIT(&process->queue);  
43.    uv__handle_stop(process);  
44.  
45.    if (process->exit_cb == NULL)  
46.      continue;  
47.  
48.    exit_status = 0;  
49.    // 获取退出信息，执行上传回调  
50.    if (WIFEXITED(process->status))  
51.      exit_status = WEXITSTATUS(process->status);  
52.  
53.    term_signal = 0;  
54.    if (WIFSIGNALED(process->status))  
55.      term_signal = WTERMSIG(process->status);  
56.  
57.    process->exit_cb(process, exit_status, term_signal);  
58.  }  
59.}  
```

### 13.3.2 同步创建进程
接下来看看如何以同步的方式创建进程。入口函数是spawnSync。对应的c++模块是spawn_sync。过程就不详细说明了，直接看核心代码。

```c
1.Maybe<bool> SyncProcessRunner::TryInitializeAndRunLoop(Local<Value> options) {  
2.  int r;  
3.    
4.  lifecycle_ = kInitialized;  
5.  
6.  uv_loop_ = new uv_loop_t;  
7.  if (!ParseOptions(options).To(&r)) return Nothing<bool>();  
8.  if (r < 0) {  
9.    SetError(r);  
10.    return Just(false);  
11.  }  
12.  // 设置子进程执行的时间  
13.  if (timeout_ > 0) {  
14.    r = uv_timer_init(uv_loop_, &uv_timer_);  
15.    if (r < 0) {  
16.      SetError(r);  
17.      return Just(false);  
18.    }  
19.  
20.    uv_unref(reinterpret_cast<uv_handle_t*>(&uv_timer_));  
21.  
22.    uv_timer_.data = this;  
23.    kill_timer_initialized_ = true;  
24.    // 开启一个定时器，超时执行KillTimerCallback  
25.    r = uv_timer_start(&uv_timer_, KillTimerCallback, timeout_, 0);  
26.  }  
27.  // 子进程退出时处理函数  
28.  uv_process_options_.exit_cb = ExitCallback;  
29.  r = uv_spawn(uv_loop_, &uv_process_, &uv_process_options_);  
30.  uv_process_.data = this;  
31.  
32.  for (const auto& pipe : stdio_pipes_) {  
33.    if (pipe != nullptr) {  
34.      r = pipe->Start();  
35.      if (r < 0) {  
36.        SetPipeError(r);  
37.        return Just(false);  
38.      }  
39.    }  
40.  }  
41.  // 开启一个新的事件循环  
42.  r = uv_run(uv_loop_, UV_RUN_DEFAULT);  
43.  return Just(true);  
44.}  
```

对于同步创建进程，nodejs没有使用waitpid这种方式阻塞自己，从而等待子进程退出。而是重新开启了一个事件循环。我们知道uv_run是一个”死”循环，所以这时候，nodejs主进程会阻塞在上面的uv_run。uv_run结束，子进程才会退出循环，从而执行结束，再次回到nodejs原来的事件循环。主进程和子进程的通信方式是unix域。我们分几步分析一下以上代码
#### 13.3.2.1 执行时间
因为同步方式创建子进程会导致nodejs主进程阻塞，为了避免子进程有问题，从而影响主进程，nodejs支持可配置子进程的最大执行时间。我们看到，nodejs开启了一个定时器，并设置了回调KillTimerCallback。

```c
1.void SyncProcessRunner::KillTimerCallback(uv_timer_t* handle) {  
2.  SyncProcessRunner* self = reinterpret_cast<SyncProcessRunner*>(handle->data);  
3.  self->OnKillTimerTimeout();  
4.}  
5.  
6.void SyncProcessRunner::OnKillTimerTimeout() {  
7.  SetError(UV_ETIMEDOUT);  
8.  Kill();  
9.}  
10.  
11.void SyncProcessRunner::Kill() {  
12.  if (killed_)  
13.    return;  
14.  killed_ = true;  
15.  if (exit_status_ < 0) {  
16.    // kill_signal_为用户自定义发送的杀死进程的信号  
17.    int r = uv_process_kill(&uv_process_, kill_signal_);   
18.    // 不支持用户传的信号  
19.    if (r < 0 && r != UV_ESRCH) {  
20.      SetError(r);  
21.      // 回退使用SIGKILL信号杀死进程  
22.      r = uv_process_kill(&uv_process_, SIGKILL);  
23.      CHECK(r >= 0 || r == UV_ESRCH);  
24.    }  
25.  }  
26.  
27.  // Close all stdio pipes.  
28.  CloseStdioPipes();  
29.  
30.  // 清除定时器  
31.  CloseKillTimer();  
32.}  
```

当执行时间到达设置的阈值，nodejs主进程会给子进程发送一个信号，默认是杀死子进程。
#### 13.3.2.2 子进程退出处理

```c
1.void SyncProcessRunner::ExitCallback(uv_process_t* handle,  
2.                                     int64_t exit_status,  
3.                                     int term_signal) {  
4.  SyncProcessRunner* self = reinterpret_cast<SyncProcessRunner*>(handle->data);  
5.  uv_close(reinterpret_cast<uv_handle_t*>(handle), nullptr);  
6.  self->OnExit(exit_status, term_signal);  
7.}  
8.  
9.void SyncProcessRunner::OnExit(int64_t exit_status, int term_signal) {  
10.  if (exit_status < 0)  
11.    return SetError(static_cast<int>(exit_status));  
12.  
13.  exit_status_ = exit_status;  
14.  term_signal_ = term_signal;  
15.}  
```

退出处理主要是记录子进程退出时的错误码和被哪个信号杀死的（如果有的话）。
