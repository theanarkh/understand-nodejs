# 第一章 nodejs组成和原理

## 1.1 nodejs简介
nodejs主要由v8、libuv，还有一些其他的第三方模块组成（cares异步dns解析库、http解析器、http2解析器，压缩库等）。
### 1.1.1 js引擎v8
 nodejs是基于v8的js运行时，他利用v8提供的能力，极大地拓展了js的能力。这种拓展不是为js增加了新的语言特性，而是拓展了功能模块，比如在前端，我们可以使用Date这个函数。但是我们不能使用TCP这个函数，因为js中并没有内置这个函数。而在nodejs中，我们可以使用TCP。这就是nodejs做的事情。让用户可以使用js中本来不存在的功能，比如文件、网络。nodejs中最核心的部分是libuv和v8。v8不仅负责执行js，还支持自定义的拓展，实现了js调用c++和c++调用js的能力。比如我们可以写一个c++模块，然后在js调用。Nodejs正是利用了这个能力，完成了功能的拓展。所有c、c++模块和js的调用都是通过v8来完成。
### 1.1.2 libuv
Libuv是nodejs底层的异步io库。但他提供的功能不仅仅是io，还包括进程、线程、信号、定时器、进程间通信等，而且libuv抹平了各个操作系统之间的差异。Libuv提供的功能大概如下<br/>
•	Full-featured event loop backed by epoll, kqueue, IOCP, event ports.<br/>
•	Asynchronous TCP and UDP sockets<br/>
•	Asynchronous DNS resolution<br/>
•	Asynchronous file and file system operations<br/>
•	File system events<br/>
•	ANSI escape code controlled TTY<br/>
•	IPC with socket sharing, using Unix domain sockets or named pipes (Windows)<br/>
•	Child processes<br/>
•	Thread pool<br/>
•	Signal handling<br/>
•	High resolution clock<br/>
•	Threading and synchronization primitives<br/>
libuv的实现是一个经典的生产者-消费者模型。libuv在整个生命周期中，每一轮循环都会处理每个阶段（phase）维护的任务队列。然后逐个执行任务队列中节点的回调，在回调中，不断生产新的任务，从而不断驱动libuv。下面是Libuv的整体执行流程
<img src="https://img-blog.csdnimg.cn/20200831233502707.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center" />
从上图中我们大致了解到，Libuv分为几个阶段，然后在一个循环里不断执行每个阶段里的任务。下面我们具体看一下每个阶段。
1 更新当前时间，在每次事件循环开始的时候，libuv会更新当前时间到变量中，这一轮循环的剩下操作可以使用这个变量获取当前时间，避免过多的系统调用影响性能。额外的影响就是时间不是那么精确。但是在一轮事件循环中，libuv在必要的时候，会主动更新这个时间，比如在epoll中阻塞了timeout时间后返回时，会再次更新当前时间变量。

2 如果时间循环是处于alive状态，则开始处理事件循环的每个阶段。否则退出这个事件循环。alive状态是什么意思呢？如果有active和ref状态的handle，active状态的request或者closing状态的handle则认为事件循环是alive的（具体的后续会讲到）。

3 timer阶段：判断最小堆中的节点哪个节点超时了，执行他的回调。

4 pending阶段：执行pending回调。一般来说，所有的io回调（网络，文件，dns）都会在poll io阶段执行。但是有的情况下，poll io阶段的回调会延迟到下一次循环执行，那么这种回调就是在pending阶段执行的。

5 idle阶段：如果节点处理avtive状态，注入每次事件循环都会被执行（idle不是说事件循环空闲的时候才执行）。

6 prepare阶段：和idle阶段一样。

7 poll io阶段：计算最长等待时间timeout，计算规则：
		如果时间循环是以UV_RUN_NOWAIT模式运行的，则timeout是0。
		如果时间循环即将退出（调用了uv_stop），则timeout是0。
		如果没有active状态的handle或者request，timeout是0。
		如果有dile阶段的队列里有节点，则timeout是0。
		如果有handle等待被关闭的（即调了uv_close），timeout是0。
		如果上面的都不满足，则取timer阶段中最快超时的节点作为timeout，
		如果没有则timeout等于-1，即永远阻塞，直到满足条件。
		
8 poll io阶段：调用各平台提供的io多路复用接口，最多等待timeout时间。返回的时候，执行对应的回调。（比如linux下就是epoll模式）

9 check阶段：和idle prepare一样。

10 closing阶段：处理调用了uv_close函数的handle的回调。

11 如果libuv是以UV_RUN_ONCE模式运行的，那事件循环即将退出。但是有一种情况是，poll io阶段的timeout的值是timer阶段的节点的值。并且poll io阶段是因为超时返回的，即没有任何事件发生，也没有执行任何io回调。这时候需要在执行一次timer阶段。因为有节点超时了。

12 一轮事件循环结束，如果libuv以UV_RUN_NOWAIT 或 UV_RUN_ONCE模式运行的，则退出事件循环。如果是以UV_RUN_DEFAULT模式运行的并且状态是alive，则开始下一轮循环。否则退出事件循环。

下面是事件循环的代码。
```c
1.	while (r != 0 && loop->stop_flag == 0) {  
2.	   uv__update_time(loop);  
3.	   uv__run_timers(loop);  
4.	   ran_pending = uv__run_pending(loop);  
5.	   uv__run_idle(loop);  
6.	   uv__run_prepare(loop);  
7.	  
8.	   timeout = 0;  
9.	   if ((mode == UV_RUN_ONCE && !ran_pending) || mode == UV_RUN_DEFAULT)  
10.	     timeout = uv_backend_timeout(loop);  
11.	  
12.	   uv__io_poll(loop, timeout);  
13.	   uv__run_check(loop);  
14.	   uv__run_closing_handles(loop);  
15.	  
16.	   if (mode == UV_RUN_ONCE) {  
17.	     uv__update_time(loop);  
18.	     uv__run_timers(loop);  
19.	   }  
20.	  
21.	   r = uv__loop_alive(loop);  
22.	   if (mode == UV_RUN_ONCE || mode == UV_RUN_NOWAIT)  
23.	     break;  
24.	 }  
```
下面是使用libuv的一个例子
```c
1.	#include <stdio.h>  
2.	#include <uv.h>  
3.	  
4.	int64_t counter = 0;  
5.	  
6.	void wait_for_a_while(uv_idle_t* handle) {  
7.	    counter++;  
8.	    if (counter >= 10e6)  
9.	        uv_idle_stop(handle);  
10.	}  
11.	  
12.	int main() {  
13.	    uv_idle_t idler;  
14.	     // 获取事件循环的核心结构体。并初始化一个idler  
15.	    uv_idle_init(uv_default_loop(), &idler);  
16.	    // 往事件循环的idle节点插入一个任务  
17.	    uv_idle_start(&idler, wait_for_a_while);  
18.	    // 启动事件循环  
19.	    uv_run(uv_default_loop(), UV_RUN_DEFAULT);  
20.	    // 销毁libuv的相关数据  
21.	    uv_loop_close(uv_default_loop());  
22.	    return 0;  
23.	}  
```
### 1.1.3 其他第三方库
nodejs中第三方库包括异步dns解析（cares）、http解析器（旧版使用http_parser，新版使用llhttp）、http2解析器（nghttp2）、解压压缩库(zlib)等等，不一一介绍。
## 1.2 nodejs工作原理
### 1.2.1 Nodejs是如何拓展js功能的？
利用v8提供的接口，v8提供了一套机制，使得我们可以在js层调用c++、c语言模块提供的功能。Nodejs在底层做了大量的事情，实现了很多功能，然后在js层暴露接口给用户使用，降低了用户成本，也提高了开发效率。
### 1.2.2如何在v8新增一个自定义的功能？
```c
1.	// c++里定义  
2.	Handle<FunctionTemplate> Test = FunctionTemplate::New(cb);      
3.	global->Set(String::New(“Test"), Test);  
4.	  
5.	// js里使用    
6.	var test = new Test();  
```
我们先有一个感性的认识，在后面的章节中，会具体讲解如何使用v8拓展js的功能。
### 1.2.3 nodejs是如何实现拓展的?
Nodejs并不是给每个功能拓展一个对象，而是拓展一个process对象，再通过process.binding拓展js功能。Nodejs定义了一个js对象process，映射到一个c++对象process，底层维护了一个c++模块的链表，js通过调用js层的process.binding，访问到c++的process对象，从而访问c++模块(类似访问js的Object、Date等)。不过nodejs 14版本已经改成internalBinding的方式。通过internalBinding就可以访问c++模块，原理类似。
## 1.3 nodejs启动过程
下面是nodejs启动的主流程图
<img src="https://img-blog.csdnimg.cn/20200831233827398.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center" />
 我们从上往下，看一下每个过程都做了些什么事情。
### 1.3.1 注册c++模块 

```c
RegisterBuiltinModules函数（node_binding.cc）的作用是注册c++模块。
1.	void RegisterBuiltinModules() {  
2.	#define V(modname) _register_##modname();  
3.	  NODE_BUILTIN_MODULES(V)  
4.	#undef V  
5.	}  
```
NODE_BUILTIN_MODULES是一个c语言宏，宏展开后如下（省略类似逻辑）
```c
1.	void RegisterBuiltinModules() {  
2.	#define V(modname) _register_##modname();  
3.	  V(tcp_wrap)   
4.	  V(timers)  
5.	  ...其他模块  
6.	#undef V  
7.	}  
```
再一步展开如下
```c
1.	void RegisterBuiltinModules() {  
2.	  _register_tcp_wrap();  
3.	  _register_timers();  
4.	}  
```
执行了一系列_register开头的函数，但是我们在nodejs源码里找不到这些函数。因为这些函数是在每个c++模块定义的文件里通过宏定义的。以tcp_wrap模块为例。看看他是怎么做的。文件tcp_wrap.cc的最后一句代码
NODE_MODULE_CONTEXT_AWARE_INTERNAL(tcp_wrap, node::TCPWrap::Initialize)    
宏展开是
```c
1.	#define NODE_MODULE_CONTEXT_AWARE_INTERNAL(modname, regfunc)  \  
2.	NODE_MODULE_CONTEXT_AWARE_CPP(modname, regfunc, nullptr, NM_F_INTERNAL)  
```
继续展开
```c
3.	#define NODE_MODULE_CONTEXT_AWARE_CPP(modname, regfunc, priv, flags)           \  
4.	  static node::node_module _module = {   \  
5.	      NODE_MODULE_VERSION,      \  
6.	      flags,                   \  
7.	      nullptr,                  \  
8.	      __FILE__,                \  
9.	      nullptr,                  \  
10.	      (node::addon_context_register_func)(regfunc),   \  
11.	      NODE_STRINGIFY(modname),  \  
12.	      priv,                     \  
13.	      nullptr};                \  
14.	  void _register_tcp_wrap() { node_module_register(&_module); }  
```
我们看到每个c++模块底层都定义了一个_register开头的函数，在nodejs启动时，就会把这些函数逐个执行一遍。我们继续看一下这些函数都做了什么。在这之前，我们要先了解一下nodejs中表示c++模块的数据结构。
```c
1.	struct node_module {  
2.	  int nm_version;  
3.	  unsigned int nm_flags;  
4.	  void* nm_dso_handle;  
5.	  const char* nm_filename;  
6.	  node::addon_register_func nm_register_func;  
7.	  node::addon_context_register_func nm_context_register_func;  
8.	  const char* nm_modname;  
9.	  void* nm_priv;  
10.	  struct node_module* nm_link;  
11.	}; 
```
我们看到_register开头的函数调了node_module_register，并传入一个node_module数据结构。所以我们看一下node_module_register的实现
```c
1.	void node_module_register(void* m) {  
2.	  struct node_module* mp = reinterpret_cast<struct node_module*>(m);  
3.	  
4.	  if (mp->nm_flags & NM_F_INTERNAL) {  
5.	    mp->nm_link = modlist_internal;  
6.	    modlist_internal = mp;  
7.	  } else if (!node_is_initialized) {  
8.	    // "Linked" modules are included as part of the node project.  
9.	    // Like builtins they are registered *before* node::Init runs.  
10.	    mp->nm_flags = NM_F_LINKED;  
11.	    mp->nm_link = modlist_linked;  
12.	    modlist_linked = mp;  
13.	  } else {  
14.	    thread_local_modpending = mp;  
15.	  }  
16.	}  
```
C++内置模块的flag是NM_F_INTERNAL，所以会执行第一个if的逻辑。modlist_internal类似一个头指针。if里的逻辑就是头插法建立一个单链表。C++内置模块在nodejs里是非常重要的，很多功能都会调用。后续我们会看到。
### 1.3.2 CreateMainEnvironment
#### 1.3.2.1 创建Environment对象
Nodejs中Environment类（env.h）是一个很重要的类，nodejs中，很多数据由这个Environment的对象进行管理。
```c
1.	context = NewContext(isolate_);  
2.	std::unique_ptr<Environment> env = std::make_unique<Environment>(  
3.	      isolate_data_.get(),  
4.	      context,  
5.	      args_,  
6.	      exec_args_,  
7.	      static_cast<Environment::Flags>(Environment::kIsMainThread |  
8.	                                      Environment::kOwnsProcessState |  
9.	                                      Environment::kOwnsInspector));  
```
Isolate，Context是v8中的概念。kIsMainThread 说明当前运行的是主线程，用于区分nodejs中的worker_threads子线程。Environment类非常庞大，我们只看一下process对象的创建，其他的我们不展开。我们知道有一个对象，管理nodejs的数据就可以。后续用到的时候再具体分析。Nodejs通过在Environment 构造函数中通过CreateProcessObject函数创建了process对象。
```c
1.	Isolate* isolate = env->isolate();  
2.	 EscapableHandleScope scope(isolate);  
3.	 Local<Context> context = env->context();  
4.	 // 申请一个函数模板  
5.	 Local<FunctionTemplate> process_template = FunctionTemplate::New(isolate);  
6.	 process_template->SetClassName(env->process_string());  
7.	 // 保存函数模板生成的函数  
8.	 Local<Function> process_ctor;  
9.	 // 保存函数模块生成的函数所新建出来的对象  
10.	 Local<Object> process;  
11.	 if (!process_template->GetFunction(context).ToLocal(&process_ctor) ||  
12.	     !process_ctor->NewInstance(context).ToLocal(&process)) {  
13.	   return MaybeLocal<Object>();  
14.	 }  
```
Process所保存的对象就是我们在js层用使用的process对象。nodejs初始化的时候，还挂载了一些属性。
```c
1.	READONLY_PROPERTY(process, "version", FIXED_ONE_BYTE_STRING(env->isolate(), NODE_VERSION));  
2.	READONLY_STRING_PROPERTY(process, "arch", per_process::metadata.arch);  
3.	......
```
创建完process对象后，nodejs把process保存到env中。
```c
1.	Local<Object> process_object = node::CreateProcessObject(this).FromMaybe(Local<Object>());  
2.	set_process_object(process_object)  
```
#### 1.3.2.2 InitializeLibuv
InitializeLibuv函数是往libuv中提交任务。
```c
1.	void Environment::InitializeLibuv(bool start_profiler_idle_notifier) {  
2.	  HandleScope handle_scope(isolate());  
3.	  Context::Scope context_scope(context());  
4.	  CHECK_EQ(0, uv_timer_init(event_loop(), timer_handle()));  
5.	  uv_unref(reinterpret_cast<uv_handle_t*>(timer_handle()));  
6.	  uv_check_init(event_loop(), immediate_check_handle());  
7.	  uv_unref(reinterpret_cast<uv_handle_t*>(immediate_check_handle()));  
8.	  uv_idle_init(event_loop(), immediate_idle_handle());  
9.	  uv_check_start(immediate_check_handle(), CheckImmediate);  
10.	  uv_prepare_init(event_loop(), &idle_prepare_handle_);  
11.	  uv_check_init(event_loop(), &idle_check_handle_);  
12.	  uv_async_init(  
13.	      event_loop(),  
14.	      &task_queues_async_,  
15.	      [](uv_async_t* async) {  
16.	        Environment* env = ContainerOf(  
17.	            &Environment::task_queues_async_, async);  
18.	        env->CleanupFinalizationGroups();  
19.	        env->RunAndClearNativeImmediates();  
20.	      });  
21.	  uv_unref(reinterpret_cast<uv_handle_t*>(&idle_prepare_handle_));  
22.	  uv_unref(reinterpret_cast<uv_handle_t*>(&idle_check_handle_));  
23.	  uv_unref(reinterpret_cast<uv_handle_t*>(&task_queues_async_));  
24.	  RegisterHandleCleanups();  
25.	  if (start_profiler_idle_notifier) {  
26.	    StartProfilerIdleNotifier();  
27.	  }  
28.	  static uv_once_t init_once = UV_ONCE_INIT;  
29.	  uv_once(&init_once, InitThreadLocalOnce);  
30.	  uv_key_set(&thread_local_env, this);  
31.	}  
```
这些函数都是libuv提供的，分别是往libuv不同阶段插入任务节点，uv_unref是修改状态。
1 timer_handle是实现nodejs中定时器的数据结构，对应libuv的time阶段
2 immediate_check_handle是实现nodejs中setImmediate的数据结构，对应libuv的check阶段。
3 task_queues_async_用于子线程和主线程通信
#### 1.3.2.3 RunBootstrapping
RunBootstrapping里调用了BootstrapInternalLoaders和BootstrapNode函数，我们一个个分析。
1 BootstrapInternalLoaders
BootstrapInternalLoaders用于执行internal/bootstrap/loaders.js。我们看一下具体逻辑。首先定义一个变量，该变量是一个字符串数组，用于定义函数的形参列表。一会我们会看到他的作用。
```c
1.	    std::vector<Local<String>> loaders_params = {  
2.	      process_string(),  
3.	      FIXED_ONE_BYTE_STRING(isolate_, "getLinkedBinding"),  
4.	      FIXED_ONE_BYTE_STRING(isolate_, "getInternalBinding"),  
5.	      primordials_string()}; 
```
然后再定义一个变量，是一个对象数组，用作执行函数时的实参。
```c
1.	std::vector<Local<Value>> loaders_args = {  
2.	     process_object(),  
3.	     NewFunctionTemplate(binding::GetLinkedBinding)  
4.	         ->GetFunction(context())  
5.	         .ToLocalChecked(),  
6.	     NewFunctionTemplate(binding::GetInternalBinding)  
7.	         ->GetFunction(context())  
8.	         .ToLocalChecked(),  
9.	     primordials()};  
```
接着nodejs编译执行internal/bootstrap/loaders.js，这个过程链路非常长，最后到v8层，就不贴出具体的代码，具体的逻辑转成js如下。
```c
1.	function demo(process, getLinkedBinding, getInternalBinding, primordials) {  
2.	  // internal/bootstrap/loaders.js 的代码  
3.	}  
4.	const process = {};  
5.	function getLinkedBinding(){}  
6.	function getInternalBinding() {}  
7.	const primordials = {};  
8.	const export = demo(process, getLinkedBinding, getInternalBinding, primordials);  
```
v8把internal/bootstrap/loaders.js用一个函数包裹起来，形参就是loaders_params变量对应的四个字符串。然后执行这个函数，并且传入loaders_args里的那四个对象。internal/bootstrap/loaders.js会导出一个对象。在看internal/bootstrap/loaders.js代码之前，我们先看一下getLinkedBinding, getInternalBinding这两个函数，nodejs在c++层对外暴露了AddLinkedBinding方法注册模块，nodejs针对这种类型的模块，维护了一个单独的链表。getLinkedBinding就是根据模块名从这个链表中找到对应的模块，但是我们一般用不到这个，所以就不深入分析。前面我们看到对于c++内置模块，nodejs同样维护了一个链表，getInternalBinding就是根据模块名从这个链表中找到对应的模块。现在我们可以具体看一下internal/bootstrap/loaders.js的代码了。
```c
1.	let internalBinding;  
2.	{  
3.	  const bindingObj = ObjectCreate(null);  
4.	  internalBinding = function internalBinding(module) {  
5.	    let mod = bindingObj[module];  
6.	    if (typeof mod !== 'object') {  
7.	      mod = bindingObj[module] = getInternalBinding(module);  
8.	      moduleLoadList.push(`Internal Binding ${module}`);  
9.	    }  
10.	    return mod;  
11.	  };  
12.	}  
```
Nodejs在js对getInternalBinding进行了一个封装，主要是加了缓存处理。
```c
1.	const internalBindingWhitelist = new SafeSet([,  
2.	  'tcp_wrap',  
3.	  // 一系列c++内置模块名  
4.	]);  
5.	  
6.	{  
7.	  const bindingObj = ObjectCreate(null);  
8.	  
9.	  process.binding = function binding(module) {  
10.	    module = String(module);  
11.	    if (internalBindingWhitelist.has(module)) {  
12.	      return internalBinding(module);  
13.	    }  
14.	    throw new Error(`No such module: ${module}`);  
15.	  };  
16.	  
17.	  process._linkedBinding = function _linkedBinding(module) {  
18.	    module = String(module);  
19.	    let mod = bindingObj[module];  
20.	    if (typeof mod !== 'object')  
21.	      mod = bindingObj[module] = getLinkedBinding(module);  
22.	    return mod;  
23.	  };  
24.	}  
```
在process对象（就是我们平时使用的process对象）中挂载binding函数，这个函数主要用于内置 的js模块。后面我们会经常看到。binding的逻辑就是根据模块名查找对应的c++模块。_linkedBinding类似，不再赘述。
上面的处理是为了nodejs能在js层通过binding函数加载c++模块，我们知道nodejs中还有原生的js模块（lib文件夹下的js文件）。接下来我们看一下，对于加载原生js模块的处理。Nodejs定义了一个NativeModule类负责原生js模块的加载。还定义了一个变量保存了原生js模块的名称列表。
```c
static map = new Map(moduleIds.map((id) => [id, new NativeModule(id)]));  
```
NativeModule主要的逻辑如下
1 原生js模块的代码是转成字符存在node_javascript.cc文件的，NativeModule负责原生js模块的加载，即编译和执行。
2 提供一个require函数，加载原生js模块，对于文件路径以internal开头的模块，是不能被用户require使用的。
这是原生js模块加载的大概逻辑，具体的我们在nodejs模块加载章节具体分析。执行完internal/bootstrap/loaders.js，最后返回三个变量给c++层。
```c
1.	return {  
2.	  internalBinding,  
3.	  NativeModule,  
4.	  require: nativeModuleRequire  
5.	};  
```
C++层保存其中两个函数，分别用于加载内置c++模块和原生js模块的函数。
```c
1.	set_internal_binding_loader(internal_binding_loader.As<Function>());    
2.	set_native_module_require(require.As<Function>());   
```
至此，internal/bootstrap/loaders.js分析完了
2 BootstrapNode
设置全局对象
```c
1.	EscapableHandleScope scope(isolate_);  
2.	Local<Object> global = context()->Global();  
3.	global->Set(context(), FIXED_ONE_BYTE_STRING(isolate_, "global"), global).Check();  
```
在全局对象上设置一个global属性，这就是我们在nodejs中使用的global对象。
执行internal/bootstrap/node.js设置一些变量。
```c
1.	process.cpuUsage = wrapped.cpuUsage;  
2.	process.resourceUsage = wrapped.resourceUsage;  
3.	process.memoryUsage = wrapped.memoryUsage;  
4.	process.kill = wrapped.kill;  
5.	process.exit = wrapped.exit;  
```
设置全局变量
```c
1.	defineOperation(global, 'clearInterval', timers.clearInterval);  
2.	defineOperation(global, 'clearTimeout', timers.clearTimeout);  
3.	defineOperation(global, 'setInterval', timers.setInterval);  
4.	defineOperation(global, 'setTimeout', timers.setTimeout);  
5.	ObjectDefineProperty(global, 'process', {  
6.	  value: process,  
7.	  enumerable: false,  
8.	  writable: true,  
9.	  configurable: true  
10.	});  
```
### 1.3.3 StartMainThreadExecution
StartMainThreadExecution是进行一些初始化工作，然后执行用户js。
#### 1.3.3.1 给process对象挂载属性
执行patchProcessObject函数（在node_process_methods.cc中导出）给process对象挂载一些列属性。不一一列举。
```c
1.	// process.argv  
2.	process->Set(context,
3.	                    FIXED_ONE_BYTE_STRING(isolate, "argv"),  
4.	          ToV8Value(context, env->argv()).ToLocalChecked()).Check();  
5.	  
6.	// process.execArgv  
7.	process->Set(context,  
8.	          FIXED_ONE_BYTE_STRING(isolate, "execArgv"),  
9.	          ToV8Value(context, env->exec_argv())  
10.	          .ToLocalChecked()).Check();  
11.	  
12.	READONLY_PROPERTY(process, "pid",  
13.	                  Integer::New(isolate, uv_os_getpid()));  
14.	  
15.	CHECK(process->SetAccessor(context,  
16.	                 FIXED_ONE_BYTE_STRING(isolate, "ppid"),  
17.	                 GetParentProcessId).FromJust())  
```
因为nodejs增加了对线程的支持，有些属性需要hack一下，比如在线程里使用process.exit的时候，退出的是单个线程，而不是整个进程，exit等函数需要特殊处理。后面章节会详细讲解。
#### 1.3.3.2 处理进程间通信
```c
1.	function setupChildProcessIpcChannel() {  
2.	  if (process.env.NODE_CHANNEL_FD) {  
3.	    const fd = parseInt(process.env.NODE_CHANNEL_FD, 10);  
4.	    // Make sure it's not accidentally inherited by child processes.  
5.	    delete process.env.NODE_CHANNEL_FD;  
6.	    const serializationMode = 
7.	process.env.NODE_CHANNEL_SERIALIZATION_MODE || 'json';  
8.	    delete process.env.NODE_CHANNEL_SERIALIZATION_MODE;  
9.	    require('child_process')._forkChild(fd, serializationMode);  
10.	  }  
11.	}  
```
环境变量NODE_CHANNEL_FD是在新建进程的时候设置的，如果有说明当前启动的进程是子进程。处理进程间通信。
#### 1.3.3.3 处理cluster模块的进程间通信
```c
1.	function initializeClusterIPC() {  
2.	  if (process.argv[1] && process.env.NODE_UNIQUE_ID) {  
3.	    const cluster = require('cluster');  
4.	    cluster._setupWorker();  
5.	    // Make sure it's not accidentally inherited by child processes.  
6.	    delete process.env.NODE_UNIQUE_ID;  
7.	  }  
8.	}  
```
#### 1.3.3.4 执行用户js
```c
require('internal/modules/cjs/loader').Module.runMain(process.argv[1]);  
```
internal/modules/cjs/loader.js是负责加载用户js的模块，runMain函数在pre_execution.js被挂载。runMain做的事情是加载用户的js，然后执行。具体的过程在后面章节详细分析。
### 1.3.4 进入libuv事件循环
执行完所有的初始化后，nodejs执行了用户的js，用户的js会往libuv注册一些任务，比如创建一个服务器，最后nodejs进入libuv的事件循环中，开始一轮又一轮的事件循环处理。如果没有需要处理的任务，libuv会退出。从而nodejs退出。

## 1.4 nodejs和其他服务器的比较
服务器是现代软件中非常重要的一个组成。我们看服务器的设计模式都有哪些。首先我们先来了解，什么是服务器。顾名思义，服务器，重点是提供服务。那么既然提供服务，那就要为众人所知。不然大家怎么能找到服务呢。就像我们想去吃麦当劳一样，那我们首先得知道他在哪里。所以，服务器很重要的一个属性就是发布服务信息，服务信息包括提供的服务和服务地址。这样大家才能知道需要什么服务的时候，去哪里找。对应到计算机中，服务地址就是ip+端口。所以一个如果你想成为一个服务器，那么你就要首先公布你的ip和端口，但是ip和端口不容易记，不利于使用，所以又设计出DNS协议。这样我们就可以使用域名来访问一个服务，DNS服务会根据域名解析出ip。
一个基于tcp协议的服务器，基本的流程如下。
```cpp
// 拿到一个socket用于监听
var socketfd = socket();
// 监听本机的地址（ip+端口）
bind(socketfd， 监听地址)
// 标记该socket是监听型socket
listen(socketfd)
// 阻塞等待请求到来
var socketForCommunication = accept(socket);
```
执行完以上步骤，一个服务器正式开始服务。下面我们看一下基于上面的模型，分析各种各样的处理方法。

## 1 串行处理请求
```cpp
while(1) {
	var socketForCommunication = accept(socket);
	var data = read(socketForCommunication );
	handle(data);
	write(socketForCommunication, data );
}
```
我们看看这种模式的处理过程。假设有n个请求到来。那么socket的结构是。
![](https://img-blog.csdnimg.cn/20200418141942432.png)
这时候进程从accept中被唤醒。然后拿到一个新的socket用于通信。
![](https://img-blog.csdnimg.cn/20200418142113168.png)
这种模式就是从已完成三次握手的队列里摘下一个节点，然后处理。再摘下一个节点，再处理。如果处理的过程中有文件io，可想而知，效率是有多低。而且大并发的时候，socket对应的队列很快就会被占满。这是最简单的模式，虽然服务器的设计中肯定不会使用这种模式，但是他让我们了解了一个服务器处理请求的过程。

## 2 多进程模式
多进程式下又分为几种。<br/>
2.1 一个请求一个进程
```cpp
while(1) {
	var socketForCommunication = accept(socket);
	if (fork() > 0) {
		// 父进程负责accept
	} else {
		// 子进程
		handle(socketForCommunication);
	}
}
```
这种模式下，每次来一个请求，就会新建一个进程去处理他。这种模式比串行的稍微好了一点，每个请求独立处理，假设a请求阻塞在文件io，那么不会影响b请求的处理，尽可能地做到了并发。他的瓶颈就是系统的进程数有限，大量的请求，系统无法扛得住。再者，进程的开销很大。对于系统来说是一个沉重的负担。<br/>
 2.2 多进程accept
这种模式不是等到请求来的时候再创建进程。而是在服务器启动的时候，就会创建一个多个进程。然后多个进程分别调用accept。这种模式的架构如下。
![](https://img-blog.csdnimg.cn/20200418150224640.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)

```cpp
for (let i = 0 ; i < 进程个数; i++) {
	if (fork() > 0) {
		// 父进程负责监控子进程
	} else {
		// 子进程处理请求
		while(1) {
			var socketForCommunication = accept(socket);
			handle(socketForCommunication);
		}
	}
}
```
这种模式下多个子进程都阻塞在accept。如果这时候有一个请求到来，那么所有的子进程都会被唤醒，但是首先被调度的子进程会首先摘下这个请求节点。后续的进程被唤醒后发现并没有请求可以处理。又进入睡眠。这是著名的惊群现象。改进方式就是在accpet之前加锁，拿到锁之后才能进行accept。nginx就解决了这个问题。但是据说现代操作系统已经在内核层面解决了这个问题。<br/>

2.3 进程池模式
进程池模式就是服务器创建的时候，创建一定数量的进程，但是这些进程是worker进程。他不负责accept请求。他只负责处理请求。主进程负责accept，他把accept返回的socket放到一个任务队列中。worker进程互斥访问任务队列从中取出请求进行处理。主进程的模式如下
![](https://img-blog.csdnimg.cn/20200418152253179.png)
子进程的模式如下
![](https://img-blog.csdnimg.cn/20200418152309223.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
逻辑如下

```cpp
for (let i = 0 ; i < 进程个数; i++) {
	if (fork() > 0) {
		// 父进程
	} else {
		// 子进程处理请求
		while(1) {
			// 互斥从队列中获取任务节点
			var task = getTask(queue);
			handle(task);
		}
	}
}
for (;;) {
	var newSocket = accept(socket);
	insertTask(queue);
}
```
多进程的模式同样适合多线程。

## 3 事件驱动
现在很多服务器（nginx，nodejs）都开始使用事件驱动模式去设计。从2的设计模式中我们知道，为了应对大量的请求，服务器需要大量的进程/线程。这个是个非常大的开销。而事件驱动模式，一般是配合单进程（单线程），再多的请求，也是在一个进程里处理的。但是因为是单进程，所以不适合cpu密集型，因为一个任务一直在占据cpu的话，后续的任务就无法执行了。他更适合io密集的。而使用多进程/线程的时候，一个进程/线程是无法一直占据cpu的，执行一定时间后，操作系统会执行进程/线程调度。这样就不会出现饥饿情况。事件驱动在不同系统中实现不一样。所以一般都会有一层抽象层抹平这个差异。这里以linux的epoll为例子。

```cpp
// 创建一个epoll
var epollFD = epoll_create();
/*
 在epoll给某个文件描述符注册感兴趣的事件，这里是监听的socket，注册可读事件，即连接到来
 event = {
	event: 可读
	fd： 监听socket
	// 一些上下文
 }
*/
epoll_ctl(epollFD , EPOLL_CTL_ADD , socket, event);
while(1) {
	// 阻塞等待事件就绪，events保存就绪事件的信息，total是个数
	var total= epoll_wait(epollFD , 保存就绪事件的结构events, 事件个数, timeout);
	for (let i = 0; i < total; i++) {
		if (events[i].fd === socket) {
			var newSocket = accpet(socket);
			// 把新的socket也注册到epoll，等待可读，即可读取客户端数据
			epoll_ctl(epollFD , EPOLL_CTL_ADD , newSocket, 可读事件);
		} else {
			// 从events[i]中拿到一些上下文，执行相应的回调
		}
	}
}
```
这就是事件驱动模式的大致过程。本质上是一个订阅/发布模式。服务器通过注册文件描述符和事件到epoll中。等待epoll的返回，epoll返回的时候会告诉服务器哪些事件就绪了。这时候服务器遍历就绪事件，然后执行对应的回调，在回调里可以再次注册新的事件。就是这样不断驱动着。epoll的原理其实也类似事件驱动。epoll底层维护用户注册的事件和文件描述符。epoll本身也会在文件描述符对应的文件/socket/管道处注册一个回调。然后自身进入阻塞。等到别人通知epoll有事件就绪的时候，epoll就会把就绪的事件返回给用户。

```cpp
function epoll_wait() {
	for 事件个数
		// 调用文件系统的函数判断
		if (事件[i]中对应的文件描述符中有某个用户感兴趣的事件发生?) {
			插入就绪事件队列
		} else {
			在事件[i]中的文件描述符所对应的文件/socket/管道等indeo节点注册回调。即感兴趣的事件触发后回调epoll，回调epoll后，epoll把该event[i]插入就绪事件队列返回给用户
		}
}
```
以上就是服务器设计的一些基本介绍。现在的服务器还会涉及到协程。不过目前自己还没有看过具体的实现，所以还无法介绍。nodejs是基于单进程（单线程）的事件驱动模式。即epoll模式。这也是为什么nodejs擅长处理高并发io型任务而不擅长处理cpu型任务的原因。nginx、redis也是这种模式。nodejs是一个及web服务器和应用服务器于一身的服务器，像nginx这种属于web服务器，他们只处理http协议，不具备脚本语言来处理具体的业务逻辑。而nodejs不仅可以解析http协议，还可以处理具体的业务逻辑。
