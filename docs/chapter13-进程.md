进程是操作系统里非常重要的概念，也是不容易理解的概念，但是看起来很复杂的进程，其实在操作系统的代码里，也只是一些数据结构和算法，只不过它比一般的数据结构和算法更复杂。进程在操作系统里，是用一个task_struct结构体表示的。因为操作系统是大部分是用C语言实现的，没有对象这个概念。如果我们用JS来理解的话，每个进程就是一个对象，每次新建一个进程，就是新建一个对象。task_struct结构体里保存了一个进程所需要的一些信息，包括执行状态、执行上下文、打开的文件、根目录、工作目录、收到的信号、信号处理函数、代码段、数据段的信息、进程id、执行时间、退出码等等。本章将会介绍Node.js进程模块的原理和实现。
## 13.1 Node.js主进程
当我们执行node index.js的时候，操作系统就会创建一个Node.js进程，我们的代码就是在这个Node.js进程中执行。从代码角度来说，我们在Node.js中感知进程的方式是通过process对象。本节我们分析一下这个对象。
### 13.1.1 创建process对象
Node.js启动的时候会执行以下代码创建process对象（env.cc）。

```
1.	Local<Object> process_object = node::CreateProcessObject(this).FromMaybe(Local<Object>());   
2.	set_process_object(process_object);   
process对象通过CreateProcessObject创建，然后保存到env对象中。我们看一下CreateProcessObject。
1.	MaybeLocal<Object> CreateProcessObject(Environment* env) {  
2.	  Isolate* isolate = env->isolate();  
3.	  EscapableHandleScope scope(isolate);  
4.	  Local<Context> context = env->context();  
5.	  
6.	  Local<FunctionTemplate> process_template = FunctionTemplate::New(isolate);  
7.	  process_template->SetClassName(env->process_string());  
8.	  Local<Function> process_ctor;  
9.	  Local<Object> process;  
10.	    // 新建process对象
11.	  if (!process_template->GetFunction(context).ToLocal(&process_ctor)    || !process_ctor->NewInstance(context).ToLocal(&process)) {  
12.	    return MaybeLocal<Object>();  
13.	  } 
14.	    // 设置一系列属性，这就是我们平时通过process对象访问的属性 
15.	  // Node.js的版本  
16.	  READONLY_PROPERTY(process,"version",
17.	                      FIXED_ONE_BYTE_STRING(env->isolate(), 
18.	                      NODE_VERSION)); 
19.	   // 忽略其他属性
20.	      
21.	  return scope.Escape(process);  
22.	}  
```

这是使用V8创建一个对象的典型例子，并且设置了一些属性。Node.js启动过程中，很多地方都会给process挂载属性。下面我们看我们常用的process.env是怎么挂载的。
### 13.1.2 挂载env属性
```
1.	Local<String> env_string = FIXED_ONE_BYTE_STRING(isolate_, "env");
2.	Local<Object> env_var_proxy;  
3.	// 设置process的env属性
4.	if (!CreateEnvVarProxy(context(), 
5.	                        isolate_,
6.	                        as_callback_data())
7.	     .ToLocal(&env_var_proxy) ||  
8.	  process_object()->Set(context(),
9.	                          env_string, 
10.	                          env_var_proxy).IsNothing()) {  
11.	  return MaybeLocal<Value>();  
12.	}  
```

上面的代码通过CreateEnvVarProxy创建了一个对象，然后保存到env_var_proxy中，最后给process挂载了env属性。它的值是CreateEnvVarProxy创建的对象。

```
1.	MaybeLocal<Object> CreateEnvVarProxy(Local<Context> context,  
2.	                    Isolate* isolate,  
3.	                   Local<Object> data) {  
4.	  EscapableHandleScope scope(isolate);  
5.	  Local<ObjectTemplate> env_proxy_template = ObjectTemplate::New(isolate);  
6.	  env_proxy_template->SetHandler(NamedPropertyHandlerConfiguration(
7.	      EnvGetter,
8.	            EnvSetter, 
9.	            EnvQuery, 
10.	            EnvDeleter, 
11.	            EnvEnumerator, 
12.	            data,  
13.	      PropertyHandlerFlags::kHasNoSideEffect));  
14.	  return scope.EscapeMaybe(env_proxy_template->NewInstance(context));
15.	}  
```

CreateEnvVarProxy首先申请一个对象模板，然后设置通过该对象模板创建的对象的访问描述符。我们看一下getter描述符（EnvGetter）的实现，getter描述符和我们在JS里使用的类似。

```
1.	static void EnvGetter(Local<Name> property,  
2.	            const PropertyCallbackInfo<Value>& info) { 
3.	  Environment* env = Environment::GetCurrent(info);  
4.	  MaybeLocal<String> value_string = env->env_vars()->Get(env->isolate(), property.As<String>());  
5.	  if (!value_string.IsEmpty()) {  
6.	    info.GetReturnValue().Set(value_string.ToLocalChecked());  
7.	  }  
8.	}  
```

我们看到getter是从env->env_vars()中获取数据，那么env->env_vars()又是什么呢？env_vars是一个kv存储系统，其实就是一个map。它只在Node.js初始化的时候设置（创建env对象时）。

```
set_env_vars(per_process::system_environment); 
```

 
那么per_process::system_environment又是什么呢？我们继续往下看，

```
std::shared_ptr<KVStore> system_environment = std::make_shared<RealEnvStore>();  
```

我们看到system_environment是一个RealEnvStore对象。我们看一下RealEnvStore类的实现。

```
1.	class RealEnvStore final : public KVStore {  
2.	 public:  
3.	  MaybeLocal<String> Get(Isolate* isolate, Local<String> key) const override;  
4.	  void Set(Isolate* isolate, Local<String> key, Local<String> value) override;  
5.	  int32_t Query(Isolate* isolate, Local<String> key) const override;  
6.	  void Delete(Isolate* isolate, Local<String> key) override;  
7.	  Local<Array> Enumerate(Isolate* isolate) const override;  
8.	};  
```

比较简单，就是增删改查，我们看一下查询Get的实现。

```
1.	MaybeLocal<String> RealEnvStore::Get(Isolate* isolate,  
2.	                                     Local<String> property) const {  
3.	  Mutex::ScopedLock lock(per_process::env_var_mutex);  
4.	  
5.	  node::Utf8Value key(isolate, property);  
6.	  size_t init_sz = 256;  
7.	  MaybeStackBuffer<char, 256> val;  
8.	  int ret = uv_os_getenv(*key, *val, &init_sz);  
9.	  if (ret >= 0) {  // Env key value fetch success.  
10.	    MaybeLocal<String> value_string =  
11.	        String::NewFromUtf8(isolate, 
12.	                                    *val,
13.	                                    NewStringType::kNormal, 
14.	                                    init_sz);  
15.	    return value_string;  
16.	  }  
17.	  
18.	  return MaybeLocal<String>();  
19.	}  
```

我们看到是通过uv_os_getenv获取的数据。uv_os_getenv是对getenv函数的封装，进程的内存布局中，有一部分是用于存储环境变量的，getenv就是从那一块内存中把数据读取出来。我们执行execve的时候可以设置环境变量。具体的我们在子进程章节会看到。至此，我们知道process的env属性对应的值就是进程环境变量的内容。
### 13.1.3 挂载其它属性
在Node.js的启动过程中会不断地挂载属性到process。主要在bootstrap/node.js中。不一一列举。

```
1.	const rawMethods = internalBinding('process_methods');
2.	process.dlopen = rawMethods.dlopen;  
3.	process.uptime = rawMethods.uptime; 
4.	process.nextTick = nextTick; 
```

下面是process_methods模块导出的属性，主列出常用的。

```
1.	env->SetMethod(target, "memoryUsage", MemoryUsage);  
2.	env->SetMethod(target, "cpuUsage", CPUUsage);  
3.	env->SetMethod(target, "hrtime", Hrtime);    
4.	env->SetMethod(target, "dlopen", binding::DLOpen);  
5.	env->SetMethodNoSideEffect(target, "uptime", Uptime);    
```

我们看到在JS层访问process属性的时候，访问的是对应的C++层的这些方法，大部分也只是对Libuv的封装。另外在Node.js初始化的过程中会执行PatchProcessObject。PatchProcessObject函数会挂载一些额外的属性给process。

```
1.	// process.argv  
2.	process->Set(context,  
3.	       FIXED_ONE_BYTE_STRING(isolate, "argv"),  
4.	       ToV8Value(context, env->argv()).ToLocalChecked()).Check();
5.	  
6.	READONLY_PROPERTY(process, 
7.	                  "pid",  
8.	         Integer::New(isolate, uv_os_getpid()));  
9.	  
10.	CHECK(process->SetAccessor(context,  
11.	              FIXED_ONE_BYTE_STRING(isolate, "ppid"),  
12.	              GetParentProcessId).FromJust())  
```

在Node.js初始化的过程中，在多个地方都会给process对象挂载属性，这里只列出了一部分，有兴趣的同学可以从bootstrap/node.js的代码开始看都挂载了什么属性。因为Node.js支持多线程，所以针对线程的情况，有一些特殊的处理。

```
1.	const perThreadSetup = require('internal/process/per_thread');  
2.	// rawMethods来自process_methods模块导出的属性
3.	const wrapped = perThreadSetup.wrapProcessMethods(rawMethods);  
4.	process.hrtime = wrapped.hrtime;   
5.	process.cpuUsage = wrapped.cpuUsage;   
6.	process.memoryUsage = wrapped.memoryUsage;  
7.	process.kill = wrapped.kill;  
8.	process.exit = wrapped.exit;  
```

大部分函数都是对process_methods模块（node_process_methods.cc）的封装。但是有一个属性我们需要关注一下，就是exit，因为在线程中调用process.exit的时候，只会退出单个线程，而不是整个进程。

```
1.	function exit(code) {  
2.	   if (code || code === 0)  
3.	     process.exitCode = code;  
4.	  
5.	   if (!process._exiting) {  
6.	     process._exiting = true;  
7.	     process.emit('exit', process.exitCode || 0);  
8.	   }  
9.	   process.reallyExit(process.exitCode || 0);  
10.	 }  
```

我们继续看reallyExit

```
1.	static void ReallyExit(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	  RunAtExit(env);  
4.	  int code = args[0]->Int32Value(env->context()).FromMaybe(0);  
5.	  env->Exit(code);  
6.	}  
```

调用了env的Exit。

```
1.	void Environment::Exit(int exit_code) {  
2.	  if (is_main_thread()) {  
3.	    stop_sub_worker_contexts();  
4.	    DisposePlatform();  
5.	    exit(exit_code);  
6.	  } else {  
7.	    worker_context_->Exit(exit_code);  
8.	  }  
9.	}  
```

这里我们看到了重点，根据当前是主线程还是子线程会做不同的处理。一个线程会对应一个env，env对象中的worker_context_保存就是线程对象（Worker）。我们先看子线程的逻辑。

```
1.	void Worker::Exit(int code) {  
2.	  Mutex::ScopedLock lock(mutex_);  
3.	  if (env_ != nullptr) {  
4.	    exit_code_ = code;  
5.	    Stop(env_);  
6.	  } else {  
7.	    stopped_ = true;  
8.	  }  
9.	}  
10.	  
11.	int Stop(Environment* env) {  
12.	  env->ExitEnv();  
13.	  return 0;  
14.	}  
15.	  
16.	void Environment::ExitEnv() {  
17.	  set_can_call_into_js(false);  
18.	  set_stopping(true);  
19.	  isolate_->TerminateExecution();  
20.	  // 退出Libuv事件循环  
21.	  SetImmediateThreadsafe([](Environment* env) { uv_stop(env->event_loop()); });  
22.	}  
```

我们看到子线程最后调用uv_stop提出了Libuv事件循环，然后退出。我们再来看主线程的退出逻辑。

```
1.	if (is_main_thread()) {  
2.	  stop_sub_worker_contexts();  
3.	  DisposePlatform();  
4.	  exit(exit_code);  
5.	}  
```

我们看到最后主进程中调用exit退出进程。但是退出前还有一些处理工作，我们看stop_sub_worker_contexts

```
1.	void Environment::stop_sub_worker_contexts() {  
2.	  while (!sub_worker_contexts_.empty()) {  
3.	    Worker* w = *sub_worker_contexts_.begin();  
4.	    remove_sub_worker_context(w);  
5.	    w->Exit(1);  
6.	    w->JoinThread();  
7.	  }  
8.	}  
```

sub_worker_contexts保存的是Worker对象列表，每次创建一个线程的时候，就会往里追加一个元素。这里遍历这个列表，然后调用Exit函数，这个刚才我们已经分析过，就是退出Libuv事件循环。主线程接着调JoinThread，JoinThread主要是为了阻塞等待子线程退出，因为子线程在退出的时候，可能会被操作系统挂起（执行时间片到了），这时候主线程被调度执行，但是这时候主线程还不能退出，所以这里使用join阻塞等待子线程退出。Node.js的JoinThread除了对线程join函数的封装。还做了一些额外的事情，比如触发exit事件。
## 13.2 创建子进程
因为Node.js是单进程的，但有很多事情可能不适合在主进程里处理的，所以Node.js提供了子进程模块，我们可以创建子进程做一些额外任务的处理，另外，子进程的好处是，一旦子进程出问题挂掉不会影响主进程。我们首先看一下在用C语言如何创建一个进程。

```
1.	#include<unistd.h>  
2.	#include<stdlib.h>  
3.	   
4.	int main(int argc,char *argv[]){  
5.	    pid_t pid = fork();  
6.	    if (pid < 0) {  
7.	      // 错误  
8.	    } else if(pid == 0) {  
9.	     // 子进程，可以使用exec*系列函数执行新的程序
10.	    } else {  
11.	      // 父进程  
12.	    }  
13.	}  
```

fork函数的特点，我们听得最多的可能是执行一次返回两次，我们可能会疑惑，执行一个函数怎么可能返回了两次呢？之前我们讲过，进程是task_struct表示的一个实例，调用 fork的时候，操作系统会新建一个新的task_struct实例出来（变成两个进程），fork返回两次的意思其实是在在两个进程分别返回一次，执行的都是fork后面的一行代码。而操作系统根据当前进程是主进程还是子进程，设置了fork函数的返回值。所以不同的进程，fork返回值不一样，也就是我们代码中if else条件。但是fork只是复制主进程的内容，如果我们想执行另外一个程序，怎么办呢？这时候就需要用到exec*系列函数，该系列函数会覆盖旧进程（task_struct）的部分内容，重新加载新的程序内容。这也是Node.js中创建子进程的底层原理。Node.js虽然提供了很多种创建进程的方式，但是本质上是同步和异步两种方式。
### 13.2.1 异步创建进程
我们首先看一下异步方式创建进程时的关系图如图13-1所示。  
![](https://img-blog.csdnimg.cn/b90243d1708f4167b3ad18dd442a3ed2.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图13-1  
我们从fork这个函数开始，看一下整个流程。

```
1.	function fork(modulePath /* , args, options */) {  
2.	  // 一系列参数处理  
3.	  return spawn(options.execPath, args, options);  
4.	}  
```

我们接着看spawn

```
1.	var spawn = exports.spawn = function(/*file, args, options*/) {  var opts = normalizeSpawnArguments.apply(null, arguments);  
2.	  var options = opts.options;  
3.	  var child = new ChildProcess();  
4.	   
5.	  child.spawn({  
6.	    file: opts.file,  
7.	    args: opts.args,  
8.	    cwd: options.cwd,  
9.	    windowsHide: !!options.windowsHide,  
10.	    windowsVerbatimArguments: !!options.windowsVerbatimArguments, 
11.	    detached: !!options.detached,  
12.	    envPairs: opts.envPairs,  
13.	    stdio: options.stdio,  
14.	    uid: options.uid,  
15.	    gid: options.gid  
16.	  });  
17.	  
18.	  return child;  
19.	};  
```

我们看到spawn函数只是对ChildProcess的封装。然后调用它的spawn函数。我们看看ChildProcess。

```
1.	function ChildProcess() {  
2.	  // C++层定义  
3.	  this._handle = new Process();  
4.	}  
5.	
6.	ChildProcess.prototype.spawn = function(options) {  
7.	  // 创建进程  
8.	  const err = this._handle.spawn(options);  
9.	}  
10.	
```

ChildProcess是对C++层的封装，不过Process在C++层也没有太多逻辑，进行参数的处理然后调用Libuv的uv_spawn。我们通过uv_spawn来到了C语言层。我们看看uv_spawn的整体流程。

```
1.	int uv_spawn(uv_loop_t* loop,  
2.	             uv_process_t* process,  
3.	             const uv_process_options_t* options) {  
4.	  
5.	  uv__handle_init(loop, (uv_handle_t*)process, UV_PROCESS);  
6.	  QUEUE_INIT(&process->queue);  
7.	  // 处理进程间通信  
8.	  for (i = 0; i < options->stdio_count; i++) {  
9.	    err = uv__process_init_stdio(options->stdio + i, pipes[i]);  
10.	    if (err)  
11.	      goto error;  
12.	  }  
13.	  /*
14.	   创建一个管道用于创建进程期间的父进程子通信，
15.	   设置UV__O_CLOEXEC标记，子进程执行execvp
16.	   的时候管道的一端会被关闭  
17.	  */
18.	  err = uv__make_pipe(signal_pipe, 0);  
19.	  // 注册子进程退出信号的处理函数  
20.	  uv_signal_start(&loop->child_watcher, uv__chld, SIGCHLD);  
21.	  
22.	  uv_rwlock_wrlock(&loop->cloexec_lock);  
23.	  // 创建子进程  
24.	  pid = fork();  
25.	  // 子进程  
26.	  if (pid == 0) {  
27.	    uv__process_child_init(options, 
28.	                              stdio_count, 
29.	                              pipes, 
30.	                              signal_pipe[1]);  
31.	    abort();  
32.	  }  
33.	  // 父进程  
34.	  uv_rwlock_wrunlock(&loop->cloexec_lock);  
35.	  // 关闭管道写端，等待子进程写  
36.	  uv__close(signal_pipe[1]);  
37.	  
38.	  process->status = 0;  
39.	  exec_errorno = 0;  
40.	  // 判断子进程是否执行成功  
41.	  do  
42.	    r = read(signal_pipe[0],&exec_errorno,sizeof(exec_errorno));
43.	  while (r == -1 && errno == EINTR);  
44.	  // 忽略处理r的逻辑 
45.	  // 保存通信的文件描述符到对应的数据结构  
46.	  for (i = 0; i < options->stdio_count; i++) {  
47.	    uv__process_open_stream(options->stdio + i, pipes[i]);
48.	  }  
49.	  
50.	  // 插入Libuv事件循环的结构体  
51.	  if (exec_errorno == 0) {  
52.	    QUEUE_INSERT_TAIL(&loop->process_handles, &process->queue); 
53.	    uv__handle_start(process);  
54.	  }  
55.	  
56.	  process->pid = pid;  
57.	  process->exit_cb = options->exit_cb;  
58.	  
59.	  return exec_errorno;  
60.	}  
```

uv_spawn的逻辑大致分为下面几个  
1 处理进程间通信  
2 注册子进程退出处理函数  
3 创建子进程  
4 插入Libuv事件循环的process_handles对象，保存状态码和回调等。  
我们分析2,3，进程间通信我们单独分析。  
1 处理子进程退出  
主进程在创建子进程之前，会注册SIGCHLD信号。对应的处理函数是uv__chld。当进程退出的时候。Node.js主进程会收到SIGCHLD信号。然后执行uv__chld。该函数遍历Libuv进程队列中的节点，通过waitpid判断该节点对应的进程是否已经退出后，从而处理已退出的节点，然后移出Libuv队列，最后执行已退出进程的回调。

```
1.	static void uv__chld(uv_signal_t* handle, int signum) {  
2.	  uv_process_t* process;  
3.	  uv_loop_t* loop;  
4.	  int exit_status;  
5.	  int term_signal;  
6.	  int status;  
7.	  pid_t pid;  
8.	  QUEUE pending;  
9.	  QUEUE* q;  
10.	  QUEUE* h;  
11.	  // 保存进程（已退出的状态）的队列  
12.	  QUEUE_INIT(&pending);  
13.	  loop = handle->loop;  
14.	  
15.	  h = &loop->process_handles;  
16.	  q = QUEUE_HEAD(h);  
17.	  //  收集已退出的进程  
18.	  while (q != h) {  
19.	    process = QUEUE_DATA(q, uv_process_t, queue);  
20.	    q = QUEUE_NEXT(q);  
21.	  
22.	    do  
23.	      /*
24.	             WNOHANG非阻塞等待子进程退出，其实就是看子进程是否退出了，
25.	              没有的话就直接返回，而不是阻塞
26.	            */   
27.	      pid = waitpid(process->pid, &status, WNOHANG);  
28.	    while (pid == -1 && errno == EINTR);  
29.	  
30.	    if (pid == 0)  
31.	      continue;  
32.	    /*
33.	          进程退出了，保存退出状态，移出队列，
34.	          插入peding队列，等待处理  
35.	        */
36.	    process->status = status;  
37.	    QUEUE_REMOVE(&process->queue);  
38.	    QUEUE_INSERT_TAIL(&pending, &process->queue);  
39.	  }  
40.	  
41.	  h = &pending;  
42.	  q = QUEUE_HEAD(h);  
43.	  // 是否有退出的进程  
44.	  while (q != h) {  
45.	    process = QUEUE_DATA(q, uv_process_t, queue);  
46.	    q = QUEUE_NEXT(q);  
47.	    QUEUE_REMOVE(&process->queue);  
48.	    QUEUE_INIT(&process->queue);  
49.	    uv__handle_stop(process);  
50.	  
51.	    if (process->exit_cb == NULL)  
52.	      continue;  
53.	  
54.	    exit_status = 0;  
55.	    // 获取退出信息，执行上传回调  
56.	    if (WIFEXITED(process->status))  
57.	      exit_status = WEXITSTATUS(process->status);  
58.	      // 是否因为信号而退出
59.	    term_signal = 0;  
60.	    if (WIFSIGNALED(process->status))  
61.	      term_signal = WTERMSIG(process->status);  
62.	  
63.	    process->exit_cb(process, exit_status, term_signal);  
64.	  }  
65.	}  
```

当主进程下的子进程退出时，父进程主要负责收集子进程退出状态和原因等信息，然后执行上层回调。

2 创建子进程（uv__process_child_init）  
主进程首先使用uv__make_pipe申请一个匿名管道用于主进程和子进程通信，匿名管道是进程间通信中比较简单的一种，它只用于有继承关系的进程，因为匿名，非继承关系的进程无法找到这个管道，也就无法完成通信，而有继承关系的进程，是通过fork出来的，父子进程可以获得得到管道。进一步来说，子进程可以使用继承于父进程的资源，管道通信的原理如图13-2所示。  
![](https://img-blog.csdnimg.cn/3ccd1855afa740a69ce0f83abc0e7589.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图13-2  
主进程和子进程通过共享file和inode结构体，实现对同一块内存的读写。主进程fork创建子进程后，会通过read阻塞等待子进程的消息。我们看一下子进程的逻辑。

```
1.	static void uv__process_child_init(const uv_process_options_t* options,
2.	                                     int stdio_count,  
3.	                   int (*pipes)[2],  
4.	                   int error_fd) {  
5.	  sigset_t set;  
6.	  int close_fd;  
7.	  int use_fd;  
8.	  int err;  
9.	  int fd;  
10.	  int n;  
11.	  // 省略处理文件描述符等参数逻辑  
12.	  // 处理环境变量  
13.	  if (options->env != NULL) {  
14.	    environ = options->env;  
15.	  }  
16.	  // 处理信号  
17.	  for (n = 1; n < 32; n += 1) {  
18.	    // 这两个信号触发时，默认行为是进程退出且不能阻止的  
19.	    if (n == SIGKILL || n == SIGSTOP)  
20.	      continue;  /* Can't be changed. */  
21.	    // 设置为默认处理方式  
22.	    if (SIG_ERR != signal(n, SIG_DFL))  
23.	      continue;  
24.	    // 出错则通知主进程  
25.	    uv__write_int(error_fd, UV__ERR(errno));  
26.	    _exit(127);  
27.	  }  
28.	  // 加载新的执行文件  
29.	  execvp(options->file, options->args);  
30.	  // 加载成功则不会走到这，走到这说明加载执行文件失败  
31.	  uv__write_int(error_fd, UV__ERR(errno));  
32.	  _exit(127);  
33.	}  
```

子进程的逻辑主要是处理文件描述符、信号、设置环境变量等。然后加载新的执行文件。因为主进程和子进程通信的管道对应的文件描述符设置了cloexec标记。所以当子进程加载新的执行文件时，就会关闭用于和主进程通信的管道文件描述符，从而导致主进程读取管道读端的时候返回0，这样主进程就知道子进程成功执行了。
### 13.2.2 同步创建进程
同步方式创建的进程，主进程会等待子进程退出后才能继续执行。接下来看看如何以同步的方式创建进程。JS层入口函数是spawnSync。spawnSync调用C++模块spawn_sync的spawn函数创建进程，我们看一下对应的C++模块spawn_sync导出的属性。

```
1.	void SyncProcessRunner::Initialize(Local<Object> target,  
2.	                                   Local<Value> unused,  
3.	                                   Local<Context> context,  
4.	                                   void* priv) {  
5.	  Environment* env = Environment::GetCurrent(context);  
6.	  env->SetMethod(target, "spawn", Spawn);  
7.	}  
```

该模块值导出了一个属性spawn，当我们调用spawn的时候，执行的是C++的Spawn。

```
1.	void SyncProcessRunner::Spawn(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	  env->PrintSyncTrace();  
4.	  SyncProcessRunner p(env);  
5.	  Local<Value> result;  
6.	  if (!p.Run(args[0]).ToLocal(&result)) return;  
7.	  args.GetReturnValue().Set(result);  
8.	}  
```

Spawn中主要是新建了一个SyncProcessRunner对象并且执行Run方法。我们看一下SyncProcessRunner的Run做了什么。

```
1.	MaybeLocal<Object> SyncProcessRunner::Run(Local<Value> options) {  
2.	  EscapableHandleScope scope(env()->isolate());  
3.	  Maybe<bool> r = TryInitializeAndRunLoop(options);   
4.	  Local<Object> result = BuildResultObject();  
5.	  return scope.Escape(result);  
6.	}  
```

执行了TryInitializeAndRunLoop。  

```
1.	Maybe<bool> SyncProcessRunner::TryInitializeAndRunLoop(Local<Value> options) {
2.	    int r;  
3.	    
4.	  lifecycle_ = kInitialized;  
5.	  // 新建一个事件循环
6.	  uv_loop_ = new uv_loop_t;  
7.	  if (!ParseOptions(options).To(&r)) return Nothing<bool>();  
8.	  if (r < 0) {  
9.	    SetError(r);  
10.	    return Just(false);  
11.	  }  
12.	  // 设置子进程执行的时间  
13.	  if (timeout_ > 0) {  
14.	    r = uv_timer_init(uv_loop_, &uv_timer_);
15.	    uv_unref(reinterpret_cast<uv_handle_t*>(&uv_timer_));
16.	    uv_timer_.data = this;  
17.	    kill_timer_initialized_ = true;  
18.	    // 开启一个定时器，超时执行KillTimerCallback  
19.	    r = uv_timer_start(&uv_timer_, 
20.	                             KillTimerCallback, 
21.	                             timeout_, 
22.	                             0);  
23.	  }  
24.	  // 子进程退出时处理函数  
25.	  uv_process_options_.exit_cb = ExitCallback;
26.	    // 传进去新的loop而不是主进程本身的loop  
27.	  r = uv_spawn(uv_loop_, &uv_process_, &uv_process_options_);  
28.	  uv_process_.data = this;  
29.	  
30.	  for (const auto& pipe : stdio_pipes_) {  
31.	    if (pipe != nullptr) {  
32.	      r = pipe->Start();  
33.	      if (r < 0) {  
34.	        SetPipeError(r);  
35.	        return Just(false);  
36.	      }  
37.	    }  
38.	  }  
39.	  // 开启一个新的事件循环  
40.	  r = uv_run(uv_loop_, UV_RUN_DEFAULT);  
41.	  return Just(true);  
42.	}  
```

从上面的代码中，我们可以了解到Node.js是如何实现同步创建进程的。同步创建进程时，Node.js重新开启了一个事件循环，然后新建一个子进程，并且把表示子进程结构体的handle插入到新创建的事件循环中，接着Libuv一直处于事件循环中，因为一直有一个uv_process_t（handle），所以新创建的uv_run会一直在执行，所以这时候，Node.js主进程会”阻塞”在该uv_run。直到子进程退出，主进程收到信号后，删除新创建的事件循环中的uv_process_t。然后执行回调ExitCallback。接着事件循环退出，再次回到Node.js原来的事件循环。如图所示13-3。  
![](https://img-blog.csdnimg.cn/9a906c8949e549eb932c950f658eef59.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图13-3  
这就是同步的本质和原因。我们分几步分析一下以上代码
#### 13.2.2.1 执行时间
因为同步方式创建子进程会导致Node.js主进程阻塞，为了避免子进程有问题，从而影响主进程的执行，Node.js支持可配置子进程的最大执行时间。我们看到，Node.js开启了一个定时器，并设置了回调KillTimerCallback。

```
1.	void SyncProcessRunner::KillTimerCallback(uv_timer_t* handle) {  
2.	  SyncProcessRunner* self = reinterpret_cast<SyncProcessRunner*>(handle->data);  
3.	  self->OnKillTimerTimeout();  
4.	}  
5.	  
6.	void SyncProcessRunner::OnKillTimerTimeout() {  
7.	  SetError(UV_ETIMEDOUT);  
8.	  Kill();  
9.	}  
10.	  
11.	void SyncProcessRunner::Kill() {  
12.	  if (killed_)  
13.	    return;  
14.	  killed_ = true;  
15.	  if (exit_status_ < 0) {  
16.	    // kill_signal_为用户自定义发送的杀死进程的信号  
17.	    int r = uv_process_kill(&uv_process_, kill_signal_);   
18.	    // 不支持用户传的信号  
19.	    if (r < 0 && r != UV_ESRCH) {  
20.	      SetError(r);  
21.	      // 回退使用SIGKILL信号杀死进程  
22.	      r = uv_process_kill(&uv_process_, SIGKILL);  
23.	      CHECK(r >= 0 || r == UV_ESRCH);  
24.	    }  
25.	  }  
26.	  
27.	  // Close all stdio pipes.  
28.	  CloseStdioPipes();  
29.	  
30.	  // 清除定时器  
31.	  CloseKillTimer();  
32.	}  
```

当执行时间到达设置的阈值，Node.js主进程会给子进程发送一个信号，默认是杀死子进程。
#### 13.2.2.2 子进程退出处理
退出处理主要是记录子进程退出时的错误码和被哪个信号杀死的（如果有的话）。

```
1.	void SyncProcessRunner::ExitCallback(uv_process_t* handle,  
2.	                                     int64_t exit_status,  
3.	                                     int term_signal) {  
4.	  SyncProcessRunner* self = reinterpret_cast<SyncProcessRunner*>(handle->data);  
5.	  uv_close(reinterpret_cast<uv_handle_t*>(handle), nullptr);  
6.	  self->OnExit(exit_status, term_signal);  
7.	}  
8.	  
9.	void SyncProcessRunner::OnExit(int64_t exit_status, int term_signal) {  
10.	  if (exit_status < 0)  
11.	    return SetError(static_cast<int>(exit_status));  
12.	  
13.	  exit_status_ = exit_status;  
14.	  term_signal_ = term_signal;  
15.	}  
```

## 13.3 进程间通信
进程间通信是多进程系统中非常重要的功能，否则进程就像孤岛一样，不能交流信息。因为进程间的内存是隔离的，如果进程间想通信，就需要一个公共的地方，让多个进程都可以访问，完成信息的传递。在Linux中，同主机的进程间通信方式有很多，但是基本都是使用独立于进程的额外内存作为信息承载的地方，然后在通过某种方式让多个进程都可以访问到这块公共内存，比如管道、共享内存、Unix域、消息队列等等。不过还有另外一种进程间通信的方式，是不属于以上情况的，那就是信号。信号作为一种简单的进程间通信方式，操作系统提供了接口让进程可以直接修改另一个进程的数据（PCB），以此达到通信目的。本节介绍Node.js中进程间通信的原理和实现。
### 13.3.1 创建通信通道
我们从fork函数开始分析Node.js中进程间通信的逻辑。

```
1.	function fork(modulePath) {  
2.	 // 忽略options参数处理  
3.	 if (typeof options.stdio === 'string') {  
4.	    options.stdio = stdioStringToArray(options.stdio, 'ipc');  
5.	  } else if (!ArrayIsArray(options.stdio)) {  
6.	    // silent为true则是管道形式和主进程通信，否则是继承  
7.	    options.stdio = stdioStringToArray(  
8.	      options.silent ? 'pipe' : 'inherit',  
9.	      'ipc');  
10.	  } else if (!options.stdio.includes('ipc')) {  
11.	    // 必须要IPC，支持进程间通信  
12.	    throw new ERR_CHILD_PROCESS_IPC_REQUIRED('options.stdio');  
13.	  }  
14.	  
15.	  return spawn(options.execPath, args, options);  
16.	}  
```

我们看一下stdioStringToArray的处理。

```
1.	function stdioStringToArray(stdio, channel) {  
2.	  const options = [];  
3.	  
4.	  switch (stdio) {  
5.	    case 'ignore':  
6.	    case 'pipe': options.push(stdio, stdio, stdio); break;  
7.	    case 'inherit': options.push(0, 1, 2); break;  
8.	    default:  
9.	      throw new ERR_INVALID_OPT_VALUE('stdio', stdio);  
10.	  }  
11.	  
12.	  if (channel) options.push(channel);  
13.	  
14.	  return options;  
15.	}  
```

stdioStringToArray会返回一个数组，比如['pipe', 'pipe', 'pipe', 'ipc']或[0, 1, 2, 'ipc']，ipc代表需要创建一个进程间通信的通道，并且支持文件描述传递。我们接着看spawn。

```
1.	ChildProcess.prototype.spawn = function(options) {  
2.	  let i = 0;  
3.	  // 预处理进程间通信的数据结构  
4.	  stdio = getValidStdio(stdio, false);  
5.	  const ipc = stdio.ipc;  
6.	  // IPC文件描述符  
7.	  const ipcFd = stdio.ipcFd;  
8.	  stdio = options.stdio = stdio.stdio;  
9.	  // 通过环境变量告诉子进程IPC文件描述符和数据处理模式  
10.	  if (ipc !== undefined) {  
11.	    options.envPairs.push(`NODE_CHANNEL_FD=${ipcFd}`);  
12.	    options.envPairs.push(`NODE_CHANNEL_SERIALIZATION_MODE=${serialization}`);  
13.	  } 
14.	  // 创建子进程
15.	  const err = this._handle.spawn(options);
16.	  this.pid = this._handle.pid;  
17.	  // 处理IPC通信  
18.	  if (ipc !== undefined) setupChannel(this, ipc, serialization);  
19.	  return err;  
20.	}  
```

Spawn中会执行getValidStdio预处理进程间通信的数据结构。我们只关注ipc的。

```
1.	function getValidStdio(stdio, sync) {  
2.	  let ipc;  
3.	  let ipcFd;  
4.	  
5.	  stdio = stdio.reduce((acc, stdio, i) => {  
6.	    if (stdio === 'ipc') {  
7.	      ipc = new Pipe(PipeConstants.IPC);  
8.	      ipcFd = i;  
9.	      acc.push({  
10.	        type: 'pipe',  
11.	        handle: ipc,  
12.	        ipc: true  
13.	      });  
14.	    } else {  
15.	      // 其它类型的处理  
16.	    }  
17.	    return acc;  
18.	  }, []);  
19.	  
20.	  return { stdio, ipc, ipcFd };  
21.	}  
```

我们看到这里会new Pipe(PipeConstants.IPC);创建一个Unix域用于进程间通信，但是这里只是定义了一个C++对象，还没有可用的文件描述符。我们接着往下看C++层的spawn中关于进程间通信的处理。C++层首先处理参数，

```
1.	static void ParseStdioOptions(Environment* env,  
2.	                                Local<Object> js_options,  
3.	                                uv_process_options_t* options) {  
4.	    Local<Context> context = env->context();  
5.	    Local<String> stdio_key = env->stdio_string();  
6.	    // 拿到JS层stdio的值  
7.	    Local<Array> stdios =  
8.	        js_options->Get(context, stdio_key).ToLocalChecked().As<Array>();  
9.	  
10.	    uint32_t len = stdios->Length();  
11.	    options->stdio = new uv_stdio_container_t[len];  
12.	    options->stdio_count = len;  
13.	    // 遍历stdio，stdio是一个对象数组  
14.	    for (uint32_t i = 0; i < len; i++) {  
15.	      Local<Object> stdio =  
16.	          stdios->Get(context, i).ToLocalChecked().As<Object>();  
17.	      // 拿到stdio的类型  
18.	      Local<Value> type =  
19.	          stdio->Get(context, env->type_string()).ToLocalChecked();  
20.	      // 创建IPC通道  
21.	      if (type->StrictEquals(env->pipe_string())) {  
22.	        options->stdio[i].flags = static_cast<uv_stdio_flags>(  
23.	            UV_CREATE_PIPE | UV_READABLE_PIPE | UV_WRITABLE_PIPE);  
24.	        // 拿到对应的stream      
25.	        options->stdio[i].data.stream = StreamForWrap(env, stdio);  
26.	      }  
27.	    }  
28.	  }  
```

这里会把StreamForWrap的结果保存到stream中，我们看看StreamForWrap的逻辑

```
1.	 static uv_stream_t* StreamForWrap(Environment* env, Local<Object> stdio) {  
2.	   Local<String> handle_key = env->handle_string();  
3.	   /*
4.	     获取对象中的key为handle的值，即刚才JS层的
5.	     new Pipe(SOCKET.IPC);
6.	   */  
7.	   Local<Object> handle =  
8.	       stdio->Get(env->context(), handle_key).ToLocalChecked().As<Object>();  
9.	   // 获取JS层使用对象所对应的C++对象中的stream  
10.	   uv_stream_t* stream = LibuvStreamWrap::From(env, handle)->stream();  
11.	   CHECK_NOT_NULL(stream);  
12.	   return stream;  
13.	 }  
14.	  
15.	// 从JS层使用的object中获取关联的C++对象  
16.	ibuvStreamWrap* LibuvStreamWrap::From(Environment* env, Local<Object> object) {  
17.	 return Unwrap<LibuvStreamWrap>(object);  
18.	}
```

以上代码获取了IPC对应的stream结构体。在Libuv中会把文件描述符保存到stream中。我们接着看C++层调用Libuv的uv_spawn。

```
1.	int uv_spawn(uv_loop_t* loop,  
2.	             uv_process_t* process,  
3.	             const uv_process_options_t* options) {  
4.	  
5.	  int pipes_storage[8][2];  
6.	  int (*pipes)[2];  
7.	  int stdio_count;  
8.	  // 初始化进程间通信的数据结构  
9.	  stdio_count = options->stdio_count;  
10.	  if (stdio_count < 3)  
11.	    stdio_count = 3;  
12.	  
13.	  for (i = 0; i < stdio_count; i++) {  
14.	    pipes[i][0] = -1;  
15.	    pipes[i][1] = -1;  
16.	  }  
17.	  // 创建进程间通信的文件描述符  
18.	  for (i = 0; i < options->stdio_count; i++) {  
19.	    err = uv__process_init_stdio(options->stdio + i, pipes[i]); 
20.	    if (err)  
21.	      goto error;  
22.	  }  
23.	    
24.	  // 设置进程间通信文件描述符到对应的数据结构
25.	  for (i = 0; i < options->stdio_count; i++) {  
26.	    uv__process_open_stream(options->stdio + i, pipes[i]);  
27.	      
28.	  }  
29.	  
30.	}  
```

Libuv中会创建用于进程间通信的文件描述符，然后设置到对应的数据结构中。

```
1.	static int uv__process_open_stream(uv_stdio_container_t* container,  
2.	                                   int pipefds[2]) {  
3.	  int flags;  
4.	  int err;  
5.	  
6.	  if (!(container->flags & UV_CREATE_PIPE) || pipefds[0] < 0)  
7.	    return 0;  
8.	  
9.	  err = uv__close(pipefds[1]);  
10.	  if (err != 0)  
11.	    abort();  
12.	  
13.	  pipefds[1] = -1;  
14.	  uv__nonblock(pipefds[0], 1);  
15.	  
16.	  flags = 0;  
17.	  if (container->flags & UV_WRITABLE_PIPE)  
18.	    flags |= UV_HANDLE_READABLE;  
19.	  if (container->flags & UV_READABLE_PIPE)  
20.	    flags |= UV_HANDLE_WRITABLE;  
21.	  
22.	  return uv__stream_open(container->data.stream, pipefds[0], flags);  
23.	}  
```

执行完uv__process_open_stream，用于IPC的文件描述符就保存到new Pipe(SOCKET.IPC)中了。有了IPC通道的文件描述符，进程还需要进一步处理。我们看到JS层执行完spawn后，主进程通过setupChannel对进程间通信进行了进一步处理。我们看一下主进程setupChannel中关于进程间通信的处理。
### 13.3.2 主进程处理通信通道
1 读端

```
1.	function setupChannel(target, channel, serializationMode) {    
2.	  // channel是new Pipe(PipeConstants.IPC);  
3.	  const control = new Control(channel);    
4.	  target.channel = control;    
5.	  // …  
6.	  channel.pendingHandle = null;    
7.	  // 注册处理数据的函数    
8.	  channel.onread = function(arrayBuffer) {    
9.	    // 收到的文件描述符    
10.	    const recvHandle = channel.pendingHandle;    
11.	    channel.pendingHandle = null;    
12.	    if (arrayBuffer) {    
13.	      const nread = streamBaseState[kReadBytesOrError];    
14.	      const offset = streamBaseState[kArrayBufferOffset];    
15.	      const pool = new Uint8Array(arrayBuffer, offset, nread);    
16.	      if (recvHandle)    
17.	        pendingHandle = recvHandle;    
18.	      // 解析收到的消息    
19.	      for (const message of parseChannelMessages(channel, pool))   {    
20.	        // 是否是内部通信事件    
21.	        if (isInternal(message)) {   
22.	           // 收到handle   
23.	          if (message.cmd === 'NODE_HANDLE') {    
24.	            handleMessage(message, pendingHandle, true);    
25.	            pendingHandle = null;    
26.	          } else {    
27.	            handleMessage(message, undefined, true);    
28.	          }    
29.	        } else {    
30.	          handleMessage(message, undefined, false);    
31.	        }    
32.	      }    
33.	    }  
34.	    
35.	  };    
36.	    
37.	  function handleMessage(message, handle, internal) {    
38.	    const eventName = (internal ? 'internalMessage' : 'message');    
39.	    process.nextTick(emit, eventName, message, handle);    
40.	  }    
41.	  // 开启读    
42.	  channel.readStart();    
43.	  return control;    
44.	}    
```

onread处理完后会触发internalMessage或message事件，message是用户使用的。 
2写端

```
1.	target._send = function(message, handle, options, callback) {  
2.	   let obj;  
3.	   const req = new WriteWrap();  
4.	   // 发送给对端  
5.	   const err = writeChannelMessage(channel, req, message,handle);
6.	     
7.	   return channel.writeQueueSize < (65536 * 2);  
8.	 }  
```

我们看看writeChannelMessage

```
1.	writeChannelMessage(channel, req, message, handle) {  
2.	  const ser = new ChildProcessSerializer();  
3.	  ser.writeHeader();  
4.	  ser.writeValue(message);  
5.	  const serializedMessage = ser.releaseBuffer();  
6.	  const sizeBuffer = Buffer.allocUnsafe(4);  
7.	  sizeBuffer.writeUInt32BE(serializedMessage.length);  
8.	  // channel是封装了Unix域的对象
9.	  return channel.writeBuffer(req, Buffer.concat([  
10.	    sizeBuffer,  
11.	    serializedMessage  
12.	  ]), handle);  
13.	},  
```

 channel.writeBuffer通过刚才创建的IPC通道完成数据的发送，并且支持发送文件描述符。
### 13.3.3 子进程处理通信通道
接着我们看看子进程的逻辑，Node.js在创建子进程的时候，主进程会通过环境变量NODE_CHANNEL_FD告诉子进程Unix域通信对应的文件描述符。在执行子进程的时候，会处理这个文件描述符。具体实现在setupChildProcessIpcChannel函数中。

```
1.	function setupChildProcessIpcChannel() {  
2.	  // 主进程通过环境变量设置该值
3.	  if (process.env.NODE_CHANNEL_FD) {  
4.	    const fd = parseInt(process.env.NODE_CHANNEL_FD, 10);  
5.	    delete process.env.NODE_CHANNEL_FD;   
6.	    require('child_process')._forkChild(fd, serializationMode);  
7.	  }  
8.	}  
```

接着执行_forkChild函数。

```
1.	function _forkChild(fd, serializationMode) {  
2.	  const p = new Pipe(PipeConstants.IPC);  
3.	  p.open(fd);  
4.	  const control = setupChannel(process, p, serializationMode);  
5.	}  
```

该函数创建一个Pipe对象，然后把主进程传过来的fd保存到该Pipe对象。对该Pipe对象的读写，就是地对fd进行读写。最后执行setupChannel。setupChannel主要是完成了Unix域通信的封装，包括处理接收的消息、发送消息、处理文件描述符传递等，刚才已经分析过，不再具体分析。最后通过在process对象中挂载函数和监听事件，使得子进程具有和主进程通信的能力。所有的通信都是基于主进程通过环境变量NODE_CHANNEL_FD传递过来的fd进行的。
## 13.4 文件描述符传递
前面我们已经介绍过传递文件描述符的原理，下面我们看看Node.js是如何处理文件描述符传递的。
### 13.4.1 发送文件描述符
我们看进程间通信的发送函数send的实现

```
1.	process.send = function(message, handle, options, callback) {  
2.	    return this._send(message, handle, options, callback);  
3.	};  
4.	  
5.	  target._send = function(message, handle, options, callback) {  
6.	    // Support legacy function signature  
7.	    if (typeof options === 'boolean') {  
8.	      options = { swallowErrors: options };  
9.	    }  
10.	  
11.	    let obj;  
12.	  
13.	    // 发送文件描述符，handle是文件描述符的封装  
14.	    if (handle) {  
15.	      message = {  
16.	        cmd: 'NODE_HANDLE',  
17.	        type: null,  
18.	        msg: message  
19.	      };  
20.	      // handle的类型  
21.	      if (handle instanceof net.Socket) {  
22.	        message.type = 'net.Socket';  
23.	      } else if (handle instanceof net.Server) {  
24.	        message.type = 'net.Server';  
25.	      } else if (handle instanceof TCP || handle instanceof Pipe) {  
26.	        message.type = 'net.Native';  
27.	      } else if (handle instanceof dgram.Socket) {  
28.	        message.type = 'dgram.Socket';  
29.	      } else if (handle instanceof UDP) {  
30.	        message.type = 'dgram.Native';  
31.	      } else {  
32.	        throw new ERR_INVALID_HANDLE_TYPE();  
33.	      }  
34.	      // 根据类型转换对象  
35.	      obj = handleConversion[message.type];  
36.	  
37.	      // 把JS层使用的对象转成C++层对象  
38.	      handle=handleConversion[message.type].send.call(target, 
39.	                                                      message,
40.	                                                      handle, 
41.	                                                      options);  
42.	    }  
43.	    // 发送  
44.	    const req = new WriteWrap();  
45.	    // 发送给对端  
46.	    const err = writeChannelMessage(channel, req, message, handle);  
47.	      
48.	  }  
```

Node.js在发送一个封装了文件描述符的对象之前，首先会把JS层使用的对象转成C++层使用的对象。如TCP

```
1.	send(message, server, options) {  
2.	      return server._handle;  
3.	} 
```

我们接着看writeChannelMessage。

```
1.	// channel是new Pipe(PipeConstants.IPC);  
2.	writeChannelMessage(channel, req, message, handle) {  
3.	    const string = JSONStringify(message) + '\n';
4.	    return channel.writeUtf8String(req, string, handle); 
5.	}
```

我们看一下writeUtf8String

```
1.	template <enum encoding enc>  
2.	int StreamBase::WriteString(const FunctionCallbackInfo<Value>& args) {  
3.	  Environment* env = Environment::GetCurrent(args);  
4.	  // new WriteWrap()  
5.	  Local<Object> req_wrap_obj = args[0].As<Object>();  
6.	  Local<String> string = args[1].As<String>();  
7.	  Local<Object> send_handle_obj;  
8.	  // 需要发送文件描述符，C++层对象  
9.	  if (args[2]->IsObject())  
10.	    send_handle_obj = args[2].As<Object>();  
11.	  
12.	  uv_stream_t* send_handle = nullptr;  
13.	  // 是Unix域并且支持传递文件描述符  
14.	  if (IsIPCPipe() && !send_handle_obj.IsEmpty()) {  
15.	    HandleWrap* wrap;  
16.	    /* 
17.	      send_handle_obj是由C++层创建在JS层使用的对象，
18.	      解包出真正在C++层使用的对象  
19.	     */
20.	    ASSIGN_OR_RETURN_UNWRAP(&wrap, send_handle_obj, UV_EINVAL);  
21.	    // 拿到Libuv层的handle结构体
22.	    send_handle = reinterpret_cast<uv_stream_t*>(wrap->GetHandle());  
23.	    /*
24.	      Reference LibuvStreamWrap instance to prevent it 
25.	      from being garbage，collected before`AfterWrite` is
26.	      called.  
27.	    */
28.	    req_wrap_obj->Set(env->context(),  
29.	                      env->handle_string(),  
30.	                      send_handle_obj).Check();  
31.	  }  
32.	  
33.	  Write(&buf, 1, send_handle, req_wrap_obj);  
34.	}  
```

Write会调用Libuv的uv__write，uv__write会把Libuv层的handle中的fd取出来，使用sendmsg传递到其它进程。整个发送的过程本质是从JS层到Libuv层层层揭开要发送的对象，最后拿到一个文件描述符，然后通过操作系统提供的API把文件描述符传递给另一个进程，如图13-4所示。  
![](https://img-blog.csdnimg.cn/21cecfca8d244b33810f151860327058.png)  
图13-4
### 13.4.2 接收文件描述符
分析完发送，我们再看一下接收的逻辑。前面我们分析过，当文件描述符收到数据时，会把文件文件描述符封装成对应的对象。

```
1.	void LibuvStreamWrap::OnUvRead(ssize_t nread, const uv_buf_t* buf) {  
2.	  HandleScope scope(env()->isolate());  
3.	  Context::Scope context_scope(env()->context());  
4.	  uv_handle_type type = UV_UNKNOWN_HANDLE;  
5.	  // 是否支持传递文件描述符并且有待处理的文件描述符，则判断文件描述符类型  
6.	  if (is_named_pipe_ipc() &&  
7.	      uv_pipe_pending_count(reinterpret_cast<uv_pipe_t*>(stream())) > 0) {  
8.	    type = uv_pipe_pending_type(reinterpret_cast<uv_pipe_t*>(stream()));  
9.	  }  
10.	  
11.	  // 读取成功  
12.	  if (nread > 0) {  
13.	    MaybeLocal<Object> pending_obj;  
14.	    // 根据类型创建一个新的C++对象表示客户端，并且从服务器中摘下一个fd保存到客户端  
15.	    if (type == UV_TCP) {  
16.	      pending_obj = AcceptHandle<TCPWrap>(env(), this);  
17.	    } else if (type == UV_NAMED_PIPE) {  
18.	      pending_obj = AcceptHandle<PipeWrap>(env(), this);  
19.	    } else if (type == UV_UDP) {  
20.	      pending_obj = AcceptHandle<UDPWrap>(env(), this);  
21.	    } else {  
22.	      CHECK_EQ(type, UV_UNKNOWN_HANDLE);  
23.	    }  
24.	    // 保存到JS层使用的对象中，键是pendingHandle  
25.	    if (!pending_obj.IsEmpty()) {  
26.	      object()  
27.	          ->Set(env()->context(),  
28.	                env()->pending_handle_string(),  
29.	                pending_obj.ToLocalChecked())  
30.	          .Check();  
31.	    }  
32.	  }  
33.	  
34.	  EmitRead(nread, *buf);  
35.	}  
```

接着我们看看JS层的处理。

```
1.	channel.onread = function(arrayBuffer) {  
2.	  // 收到的文件描述符  
3.	  const recvHandle = channel.pendingHandle;  
4.	  channel.pendingHandle = null;  
5.	  if (arrayBuffer) {  
6.	    const nread = streamBaseState[kReadBytesOrError];  
7.	    const offset = streamBaseState[kArrayBufferOffset];  
8.	    const pool = new Uint8Array(arrayBuffer, offset, nread);  
9.	    if (recvHandle)  
10.	      pendingHandle = recvHandle;  
11.	    // 解析收到的消息  
12.	    for (const message of parseChannelMessages(channel, pool)) {       // 是否是内部通信事件  
13.	      if (isInternal(message)) {  
14.	        if (message.cmd === 'NODE_HANDLE') {  
15.	          handleMessage(message, pendingHandle, true);  
16.	          pendingHandle = null;  
17.	        } else {  
18.	          handleMessage(message, undefined, true);  
19.	        }  
20.	      } else {  
21.	        handleMessage(message, undefined, false);  
22.	      }  
23.	    }  
24.	  }  
25.	};  
```

这里会触发内部事件internalMessage

```
1.	target.on('internalMessage', function(message, handle) {  
2.	  // 是否收到了handle  
3.	  if (message.cmd !== 'NODE_HANDLE') return;  
4.	  
5.	  // 成功收到，发送ACK  
6.	  target._send({ cmd: 'NODE_HANDLE_ACK' }, null, true);  
7.	    
8.	  const obj = handleConversion[message.type];  
9.	  
10.	  /*
11.	    C++对象转成JS层使用的对象。转完之后再根据里层的字段
12.	    message.msg进一步处理，或者触发message事件传给用户  
13.	  */
14.	  obj.got.call(this, message, handle, (handle) => {   
15.	    handleMessage(message.msg, handle, isInternal(message.msg));   });  
16.	})  
```

我们看到这里会把C++层的对象转成JS层使用的对象。如TCP

```
1.	got(message, handle, emit) {  
2.	    const server = new net.Server();  
3.	    server.listen(handle, () => {  
4.	      emit(server);  
5.	    });  
6.	}  
```

这就是文件描述符传递在Node.js中的处理流程，传递文件描述符是一个非常有用的能力，比如一个进程可以把一个TCP连接所对应的文件描述符直接发送给另一个进程处理。这也是cluser模块的原理。后续我们会看到。在Node.js中，整体的处理流程就是，发送的时候把一个JS层使用的对象一层层地剥开，变成C++对象，然后再变成fd，最后通过底层API传递给另一个进程。接收的时候就是把一个fd一层层地包裹，变成一个JS层使用的对象。
