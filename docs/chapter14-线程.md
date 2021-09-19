
线程是操作系统的最小调度单位，它本质上是进程中的一个执行流，我们知道，进程有代码段，线程其实就是进程代码段中的其中一段代码。线程的一种实现是作为进程来实现的（pthread线程库），通过调用clone，新建一个进程，然后执行父进程代码段里的一个代码片段，其中文件描述符、内存等信息都是共享的。因为内存是共享的，所以线程不能共享栈，否则访问栈的地址的时候，会映射到相同的物理地址，那样就会互相影响，所以每个线程会有自己独立的栈。在调用clone函数的时候会设置栈的范围，比如在堆上分配一块内存用于做线程的栈，并且支持设置子线程和主线程共享哪些资源。具体可以参考clone系统调用。

由于Node.js是单线程的，虽然底层的Libuv实现了一个线程池，但是这个线程池只能执行C、C++层定义的任务。如果我们想自定义一些耗时的操作，那就只能在C++层处理，然后暴露接口给JS层调用，这个成本是非常高的，在早期的Node.js版本里，我们可以用进程去实现这样的需求。但是进程太重了，在新版的Node.js中，Node.js为我们提供了多线程的功能。这一章以Node.js多线程模块为背景，分析Node.js中多线程的原理，但是不分析Libuv的线程实现，它本质是对线程库的简单封装。Node.js中，线程的实现也非常复杂。虽然底层只是对线程库的封装，但是把它和Node.js原本的架构结合起来变得复杂起来。

## 14.1 使用多线程
对于同步文件操作、DNS解析等操作，Node.js使用了内置的线程池支持了异步。但是一些加解密、字符串运算、阻塞型API等操作。我们就不能在主线程里处理了，这时候就不得不使用线程，而且多线程还能利用多核的能力。Node.js的子线程本质上是一个新的事件循环，但是子线程和Node.js主线程共享一个Libuv线程池，所以如果在子线程里有文件、DNS等操作就会和主线程竞争Libuv线程池。如图14-1所示。  
![](https://img-blog.csdnimg.cn/7b5d3376155d4521800749ca4a455b57.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图14-1  
我们看一下在Node.js中如何使用线程。

```
1.	const { Worker, isMainThread, parentPort } = require('worker_threads');  
2.	if (isMainThread) {  
3.	  const worker = new Worker(__filename);  
4.	  worker.once('message', (message) => {  
5.	    ...  
6.	  });  
7.	  worker.postMessage('Hello, world!');  
8.	} else {  
9.	  // 做点耗时的事情  
10.	  parentPort.once('message', (message) => {  
11.	    parentPort.postMessage(message);  
12.	  });  
13.	}  
```

上面这段代码会被执行两次，一次是在主线程，一次在子线程。所以首先通过isMainThread判断当前是主线程还是子线程。主线程的话，就创建一个子线程，然后监听子线程发过来的消息。子线程的话，首先执行业务相关的代码，还可以监听主线程传过来的消息。我们在子线程中可以做一些耗时或者阻塞性的操作，不会影响主线程的执行。我们也可以把这两个逻辑拆分到两个文件。

主线程

```
1.	const { Worker, isMainThread, parentPort } = require('worker_threads');  
2.	const worker = new Worker(‘子线程文件路径’);  
3.	worker.once('message', (message) => {  
4.	  ...  
5.	});  
6.	worker.postMessage('Hello, world!');  
```

子线程

```
1.	const { Worker, isMainThread, parentPort } = require('worker_threads');  
2.	parentPort.once('message', (message) => {  
3.	  parentPort.postMessage(message);  
4.	});  
```

## 14.2 线程间通信数据结构
进程间的通信一般需要借助操作系统提供公共的内存来完成。因为进程间的内存是独立的，和进程间通信不一样。多线程的内存是共享的，同个进程的内存，多个线程都可以访问，所以线程间通信可以基于进程内的内存来完成。在Node.js中，线程间通信使用的是MessageChannel实现的，它是全双工的，任意一端都可以随时发送信息。MessageChannel类似socket通信，它包括两个端点。定义一个MessageChannel相当于建立一个TCP连接，它首先申请两个端点（MessagePort），然后把它们关联起来。下面我们看一下线程间通信的实现中，比较重要的几个数据结构。  
1 Message代表一个消息。  
2 MessagePortData是对操作Message的封装和对消息的承载。  
3 MessagePort是代表通信的端点。  
4 MessageChannel是代表通信的两端，即两个MessagePort。  
下面我们看一下具体的实现。
14.2.1 Message
Message类代表的是子线程间通信的一条消息。

```
1.	class Message : public MemoryRetainer {  
2.	 public:  
3.	  explicit Message(MallocedBuffer<char>&& payload = MallocedBuffer<char>());  
4.	  // 是否是最后一条消息，空消息代表是最后一条消息  
5.	  bool IsCloseMessage() const;  
6.	  // 线程间通信的数据需要通过序列化和反序列化处理  
7.	  v8::MaybeLocal<v8::Value> Deserialize(Environment* env,  
8.	                                        v8::Local<v8::Context> context);  
9.	  v8::Maybe<bool> Serialize(Environment* env,  
10.	                            v8::Local<v8::Context> context,  
11.	                            v8::Local<v8::Value> input,  
12.	                            const TransferList& transfer_list,  
13.	                            v8::Local<v8::Object> source_port =  
14.	                                v8::Local<v8::Object>());  
15.	  
16.	  // 传递SharedArrayBuffer型变量  
17.	  void AddSharedArrayBuffer(std::shared_ptr<v8::BackingStore> backing_store);  
18.	  // 传递MessagePort型变量  
19.	  void AddMessagePort(std::unique_ptr<MessagePortData>&& data);  
20.	  // 消息所属端口，端口是消息到达的地方  
21.	  const std::vector<std::unique_ptr<MessagePortData>>& message_ports() const {  
22.	    return message_ports_;  
23.	  }  
24.	  
25.	 private:  
26.	  // 保存消息的内容  
27.	  MallocedBuffer<char> main_message_buf_;  
28.	  std::vector<std::shared_ptr<v8::BackingStore>> array_buffers_;  
29.	  std::vector<std::shared_ptr<v8::BackingStore>> shared_array_buffers_;  
30.	  std::vector<std::unique_ptr<MessagePortData>> message_ports_;  
31.	  std::vector<v8::CompiledWasmModule> wasm_modules_;  
32.	};  
```

### 14.2.2 MessagePortData
MessagePortData是管理消息发送和接收的类。 

```
1.	class MessagePortData : public MemoryRetainer {  
2.	 public:  
3.	  explicit MessagePortData(MessagePort* owner);  
4.	  ~MessagePortData() override;  
5.	  // 新增一个消息  
6.	  void AddToIncomingQueue(Message&& message);  
7.	  // 关联/解关联通信两端的端口  
8.	  static void Entangle(MessagePortData* a, MessagePortData* b);  
9.	  void Disentangle();  
10.	    
11.	 private:  
12.	  // 用于多线程往对端消息队列插入消息时的互斥变量  
13.	  mutable Mutex mutex_;  
14.	  std::list<Message> incoming_messages_;  
15.	  // 所属端口  
16.	  MessagePort* owner_ = nullptr;  
17.	  // 用于多线程访问对端sibling_属性时的互斥变量  
18.	  std::shared_ptr<Mutex> sibling_mutex_ = std::make_shared<Mutex>();  
19.	  // 指向通信对端的指针  
20.	  MessagePortData* sibling_ = nullptr;  
21.	};  
```

我们看一下实现。

```
1.	MessagePortData::MessagePortData(MessagePort* owner) : owner_(owner) { }  
2.	  
3.	MessagePortData::~MessagePortData() {  
4.	  // 析构时解除和对端的关系  
5.	  Disentangle();  
6.	}  
7.	  
8.	// 插入一个message  
9.	void MessagePortData::AddToIncomingQueue(Message&& message) {  
10.	  // 先加锁，保证多线程安全，互斥访问  
11.	  Mutex::ScopedLock lock(mutex_);  
12.	  // 插入消息队列  
13.	  incoming_messages_.emplace_back(std::move(message));  
14.	  // 通知owner  
15.	  if (owner_ != nullptr) {  
16.	    owner_->TriggerAsync();  
17.	  }  
18.	}  
19.	  
20.	// 关联通信的对端，并保持对端的互斥变量，访问对端时需要使用  
21.	void MessagePortData::Entangle(MessagePortData* a, MessagePortData* b) {  
22.	  a->sibling_ = b;  
23.	  b->sibling_ = a;  
24.	  a->sibling_mutex_ = b->sibling_mutex_;  
25.	}  
26.	  
27.	// 解除关联   
28.	void MessagePortData::Disentangle() {  
29.	  // 加锁操作对端的sibling字段  
30.	  std::shared_ptr<Mutex> sibling_mutex = sibling_mutex_;  
31.	  Mutex::ScopedLock sibling_lock(*sibling_mutex);  
32.	  sibling_mutex_ = std::make_shared<Mutex>();  
33.	  // 对端  
34.	  MessagePortData* sibling = sibling_;  
35.	  // 对端非空，则把对端的sibling也指向空，自己也指向空  
36.	  if (sibling_ != nullptr) {  
37.	    sibling_->sibling_ = nullptr;  
38.	    sibling_ = nullptr;  
39.	  }  
40.	  
41.	  // 插入一个空的消息通知对端和本端  
42.	  AddToIncomingQueue(Message());  
43.	  if (sibling != nullptr) {  
44.	    sibling->AddToIncomingQueue(Message());  
45.	  }  
46.	}  
```

### 14.2.3 MessagePort
MessagePort表示的是通信的一端。

```
1.	class MessagePort : public HandleWrap {  
2.	 public:  
3.	  MessagePort(Environment* env,  
4.	              v8::Local<v8::Context> context,  
5.	              v8::Local<v8::Object> wrap);  
6.	  ~MessagePort() override;  
7.	  
8.	   static MessagePort* New(Environment* env,  
9.	                           v8::Local<v8::Context> context,  
10.	                           std::unique_ptr<MessagePortData> data = nullptr);  
11.	  // 发送消息  
12.	  v8::Maybe<bool> PostMessage(Environment* env,  
13.	                              v8::Local<v8::Value> message,  
14.	                              const TransferList& transfer);  
15.	  
16.	  // 开启/关闭接收消息  
17.	  void Start();  
18.	  void Stop();  
19.	  
20.	  static void New(const v8::FunctionCallbackInfo<v8::Value>& args);  
21.	  // 提供JS层使用的方法  
22.	  static void PostMessage(const v8::FunctionCallbackInfo<v8::Value>& args);  
23.	  static void Start(const v8::FunctionCallbackInfo<v8::Value>& args);  
24.	  static void Stop(const v8::FunctionCallbackInfo<v8::Value>& args);  
25.	  static void Drain(const v8::FunctionCallbackInfo<v8::Value>& args);  
26.	  static void ReceiveMessage(const v8::FunctionCallbackInfo<v8::Value>& args);  
27.	  // 关联对端  
28.	  static void Entangle(MessagePort* a, MessagePort* b);  
29.	  static void Entangle(MessagePort* a, MessagePortData* b);  
30.	  
31.	  // 解除MessagePortData和端口的关系  
32.	  std::unique_ptr<MessagePortData> Detach();  
33.	  // 关闭端口  
34.	  void Close(  
35.	      v8::Local<v8::Value> close_callback = v8::Local<v8::Value>()) override;  
36.	  
37.	  inline bool IsDetached() const;  
38.	 private:  
39.	  void OnClose() override;  
40.	  void OnMessage();  
41.	  void TriggerAsync();  
42.	  v8::MaybeLocal<v8::Value> ReceiveMessage(v8::Local<v8::Context> context,  
43.	                                           bool only_if_receiving);  
44.	  // MessagePortData用于管理消息的发送和接收  
45.	  std::unique_ptr<MessagePortData> data_ = nullptr;  
46.	  // 是否开启接收消息标记  
47.	  bool receiving_messages_ = false;  
48.	  // 用于收到消息时通知事件循环，事件循环执行回调处理消息  
49.	  uv_async_t async_;  
50.	};  
```

我们看一下实现，只列出部分函数。

```
1.	// 端口是否不接收消息了  
2.	bool MessagePort::IsDetached() const {  
3.	  return data_ == nullptr || IsHandleClosing();  
4.	}  
5.	  
6.	// 有消息到达，通知事件循环执行回调  
7.	void MessagePort::TriggerAsync() {  
8.	  if (IsHandleClosing()) return;  
9.	  CHECK_EQ(uv_async_send(&async_), 0);  
10.	}  
11.	  
12.	// 关闭接收消息的端口  
13.	void MessagePort::Close(v8::Local<v8::Value> close_callback) {  
14.	  if (data_) {  
15.	    // 持有锁，防止再接收消息  
16.	    Mutex::ScopedLock sibling_lock(data_->mutex_);  
17.	    HandleWrap::Close(close_callback);  
18.	  } else {  
19.	    HandleWrap::Close(close_callback);  
20.	  }  
21.	}  
22.	  
23.	// 新建一个端口，并且可以挂载一个MessagePortData  
24.	MessagePort* MessagePort::New(  
25.	    Environment* env,  
26.	    Local<Context> context,  
27.	    std::unique_ptr<MessagePortData> data) {  
28.	  Context::Scope context_scope(context);  
29.	  Local<FunctionTemplate> ctor_templ = GetMessagePortConstructorTemplate(env);  
30.	  
31.	  Local<Object> instance;  
32.	  // JS层使用的对象  
33.	  if (!ctor_templ->InstanceTemplate()->NewInstance(context).ToLocal(&instance))  
34.	    return nullptr;  
35.	  // 新建一个消息端口  
36.	  MessagePort* port = new MessagePort(env, context, instance);  
37.	  
38.	  // 需要挂载MessagePortData  
39.	  if (data) {  
40.	    port->Detach();  
41.	    port->data_ = std::move(data);  
42.	    Mutex::ScopedLock lock(port->data_->mutex_);  
43.	    // 修改data的owner为当前消息端口  
44.	    port->data_->owner_ = port;  
45.	    // data中可能有消息  
46.	    port->TriggerAsync();  
47.	  }  
48.	  return port;  
49.	}  
50.	  
51.	// 开始接收消息  
52.	void MessagePort::Start() {  
53.	  Debug(this, "Start receiving messages");  
54.	  receiving_messages_ = true;  
55.	  Mutex::ScopedLock lock(data_->mutex_);  
56.	  // 有缓存的消息，通知上层  
57.	  if (!data_->incoming_messages_.empty())  
58.	    TriggerAsync();  
59.	}  
60.	  
61.	// 停止接收消息  
62.	void MessagePort::Stop() {  
63.	  Debug(this, "Stop receiving messages");  
64.	  receiving_messages_ = false;  
65.	}  
66.	// JS层调用
67.	void MessagePort::Start(const FunctionCallbackInfo<Value>& args) {  
68.	  MessagePort* port;  
69.	  ASSIGN_OR_RETURN_UNWRAP(&port, args.This());  
70.	  if (!port->data_) {  
71.	    return;  
72.	  }  
73.	  port->Start();  
74.	}  
75.	  
76.	void MessagePort::Stop(const FunctionCallbackInfo<Value>& args) {  
77.	  MessagePort* port;  
78.	  CHECK(args[0]->IsObject());  
79.	  ASSIGN_OR_RETURN_UNWRAP(&port, args[0].As<Object>());  
80.	  if (!port->data_) {  
81.	    return;  
82.	  }  
83.	  port->Stop();  
84.	}  
85.	  
86.	// 读取消息  
87.	void MessagePort::Drain(const FunctionCallbackInfo<Value>& args) {  
88.	  MessagePort* port;  
89.	  ASSIGN_OR_RETURN_UNWRAP(&port, args[0].As<Object>());  
90.	  port->OnMessage();  
91.	}  
92.	  
93.	// 获取某个端口的消息  
94.	void MessagePort::ReceiveMessage(const FunctionCallbackInfo<Value>& args) {  
95.	  CHECK(args[0]->IsObject());  
96.	  // 第一个参数是端口  
97.	  MessagePort* port = Unwrap<MessagePort>(args[0].As<Object>());  
98.	  // 调用对象的ReceiverMessage方法  
99.	  MaybeLocal<Value> payload =  
100.	      port->ReceiveMessage(port->object()->CreationContext(), false);  
101.	  if (!payload.IsEmpty())  
102.	    args.GetReturnValue().Set(payload.ToLocalChecked());  
103.	}  
104.	  
105.	// 关联两个端口  
106.	void MessagePort::Entangle(MessagePort* a, MessagePort* b) {  
107.	  Entangle(a, b->data_.get());  
108.	}  
109.	  
110.	void MessagePort::Entangle(MessagePort* a, MessagePortData* b) {  
111.	  MessagePortData::Entangle(a->data_.get(), b);  
112.	}  
```

### 14.2.4 MessageChannel
MessageChannel表示线程间通信的两个端。

```
1.	static void MessageChannel(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	   
4.	  Local<Context> context = args.This()->CreationContext();  
5.	  Context::Scope context_scope(context);  
6.	  
7.	  MessagePort* port1 = MessagePort::New(env, context);  
8.	  MessagePort* port2 = MessagePort::New(env, context);  
9.	  MessagePort::Entangle(port1, port2);  
10.	  // port1->object()拿到JS层使用的对象，它关联了MessagePort对象
11.	  args.This()->Set(context, env->port1_string(), port1->object())  
12.	      .Check();  
13.	  args.This()->Set(context, env->port2_string(), port2->object())  
14.	      .Check();  
15.	}  
```

MessageChannel的逻辑比较简单，新建两个消息端口，并且关联起来，后续就可以基于这两个端口进行通信了。
Message、MessagePortData、MessagePort和MessageChannel的关系图如图14-2所示。  
![](https://img-blog.csdnimg.cn/db442278f4b54e89ad6ba365e2646b57.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图14-2  
最后我们看一下线程间通信模块导出的一些功能。

```
1.	static void InitMessaging(Local<Object> target,  
2.	                          Local<Value> unused,  
3.	                          Local<Context> context,  
4.	                          void* priv) {  
5.	  Environment* env = Environment::GetCurrent(context);  
6.	  
7.	  {  
8.	    // 线程间通信的通道  
9.	    Local<String> message_channel_string = FIXED_ONE_BYTE_STRING(env->isolate(), 
10.	                                                                       "MessageChannel");  
11.	    Local<FunctionTemplate> templ = env->NewFunctionTemplate(MessageChannel);  
12.	    templ->SetClassName(message_channel_string);  
13.	    target->Set(context,  
14.	                message_channel_string,  
15.	                templ->GetFunction(context).ToLocalChecked()).Check();  
16.	  }  
17.	  // 新建消息端口的构造函数  
18.	  target->Set(context,  
19.	              env->message_port_constructor_string(),  
20.	              GetMessagePortConstructorTemplate(env)  
21.	                  ->GetFunction(context).ToLocalChecked()).Check();  
22.	  
23.	  env->SetMethod(target, "stopMessagePort", MessagePort::Stop);  
24.	  env->SetMethod(target, "drainMessagePort", MessagePort::Drain);  
25.	  env->SetMethod(target, "receiveMessageOnPort", MessagePort::ReceiveMessage);  
26.	  env->SetMethod(target, "moveMessagePortToContext",  
27.	                 MessagePort::MoveToContext);  
28.	}  
```

## 14.3 多线程的实现
本节我们从worker_threads模块开始分析多线程的实现。这是一个C++模块。我们看一下它导出的功能。require("work_threads")的时候就是引用了InitWorker函数导出的功能。

```
1.	void InitWorker(Local<Object> target,    
2.	                Local<Value> unused,    
3.	                Local<Context> context,    
4.	                void* priv) {    
5.	  Environment* env = Environment::GetCurrent(context);    
6.	    
7.	  {      
8.	    Local<FunctionTemplate> w = env->NewFunctionTemplate(Worker::New);    
9.	    w->InstanceTemplate()->SetInternalFieldCount(1);    
10.	    w->Inherit(AsyncWrap::GetConstructorTemplate(env));    
11.	    // 设置一系列原型方法，就不一一列举    
12.	    env->SetProtoMethod(w, "setEnvVars", Worker::SetEnvVars);    
13.	    // 一系列原型方法    
14.	    /*  
15.	     导出函数模块对应的函数，即我们代码中 
16.	     const { Worker } = require("worker_threads");中的Worker  
17.	    */   
18.	    Local<String> workerString = FIXED_ONE_BYTE_STRING(env->isolate(), "Worker");    
19.	    w->SetClassName(workerString);    
20.	    target->Set(env->context(),    
21.	                workerString,    
22.	                w->GetFunction(env->context()).ToLocalChecked()).Check();    
23.	     
24.	     /*  
25.	       导出getEnvMessagePort方法，获取线程接收消息的端口     
26.	       const {getEnvMessagePort} = require("worker_threads"); 
27.	     */  
28.	     env->SetMethod(target, "getEnvMessagePort", GetEnvMessagePort);    
29.	     /*  
30.	       线程id，这个不是操作系统分配的那个，而是Node.js分配的, 
31.	       在创建线程的时候设置  
32.	       const { threadId } = require("worker_threads");  
33.	     */    
34.	    target->Set(env->context(),  
35.	                  env->thread_id_string(),    
36.	                  Number::New(env->isolate(),  
37.	                  static_cast<double>(env->thread_id())))    
38.	        .Check();    
39.	    /*  
40.	     是否是主线程， 
41.	     const { isMainThread } = require("worker_threads");  
42.	     这边变量在Node.js启动的时候设置为true，新开子线程的时候，没有设 
43.	     置，所以是false  
44.	    */    
45.	    target->Set(env->context(),    
46.	                FIXED_ONE_BYTE_STRING(env->isolate(), "isMainThread"),   
47.	                Boolean::New(env->isolate(), env->is_main_thread()))  
48.	                .Check();    
49.	    /*  
50.	     如果不是主线程，导出资源限制的配置，  
51.	     即在子线程中调用 
52.	      const { resourceLimits } = require("worker_threads");  
53.	    */    
54.	    if (!env->is_main_thread()) {    
55.	      target->Set(env->context(),    
56.	            FIXED_ONE_BYTE_STRING(env->isolate(),   
57.	                      "resourceLimits"),    
58.	            env->worker_context()->GetResourceLimits(env->isolate())).Check();    
59.	    }    
60.	    // 导出几个常量    
61.	    NODE_DEFINE_CONSTANT(target, kMaxYoungGenerationSizeMb);    
62.	    NODE_DEFINE_CONSTANT(target, kMaxOldGenerationSizeMb);    
63.	    NODE_DEFINE_CONSTANT(target, kCodeRangeSizeMb);    
64.	    NODE_DEFINE_CONSTANT(target, kTotalResourceLimitCount);    
65.	}   
```

了解work_threads模块导出的功能后，我们看在JS层执行new Worker的时候的逻辑。根据上面代码导出的逻辑，我们知道这时候首先会新建一个C++对象。然后执行New回调，并传入新建的C++对象。我们看New函数的逻辑。我们省略一系列的参数处理，主要代码如下。

```
1.	// args.This()就是我们刚才传进来的this  
2.	Worker* worker = new Worker(env, args.This(),   
3.	                url, per_isolate_opts,  
4.	                std::move(exec_argv_out));  
```

我们再看Worker类的声明。

```
1.	class Worker : public AsyncWrap {  
2.	 public:  
3.	  // 函数声明  
4.	  
5.	 private:  
6.	  
7.	  std::shared_ptr<PerIsolateOptions> per_isolate_opts_;  
8.	  std::vector<std::string> exec_argv_;  
9.	  std::vector<std::string> argv_;  
10.	  MultiIsolatePlatform* platform_;  
11.	  v8::Isolate* isolate_ = nullptr;  
12.	  bool start_profiler_idle_notifier_;  
13.	  // 真正的线程id，底层返回的  
14.	  uv_thread_t tid_;  
15.	  
16.	  // This mutex protects access to all variables listed below it.  
17.	  mutable Mutex mutex_;  
18.	  
19.	  bool thread_joined_ = true;  
20.	  const char* custom_error_ = nullptr;  
21.	  int exit_code_ = 0;  
22.	  // 线程id，Node.js分配，不是底层返回的  
23.	  uint64_t thread_id_ = -1;  
24.	  uintptr_t stack_base_ = 0;  
25.	  
26.	  // 线程资源限制配置  
27.	  double resource_limits_[kTotalResourceLimitCount];  
28.	  void UpdateResourceConstraints(v8::ResourceConstraints* constraints);  
29.	  
30.	  // 栈信息  
31.	  static constexpr size_t kStackSize = 4 * 1024 * 1024;  
32.	  static constexpr size_t kStackBufferSize = 192 * 1024;  
33.	  
34.	  std::unique_ptr<MessagePortData> child_port_data_;  
35.	  std::shared_ptr<KVStore> env_vars_;  
36.	  // 用于线程间通信  
37.	  MessagePort* child_port_ = nullptr;  
38.	  MessagePort* parent_port_ = nullptr;  
39.	  // 线程状态  
40.	  bool stopped_ = true;  
41.	  // 是否影响事件循环退出  
42.	  bool has_ref_ = true;  
43.	  // 子线程执行时的环境变量，基类也定义了  
44.	  Environment* env_ = nullptr;  
45.	};  
```

这里只讲一下env_的定义，因为这是一个非常重要的地方。我们看到Worker类继承AsyncWrap，AsyncWrap继承了BaseObject。BaseObject中也定义了env_属性。我们看一下在C++中如果子类父类都定义了一个属性时是怎样的。我们来看一个例子

```
1.	#include <iostream>  
2.	using namespace std;  
3.	  
4.	class A  
5.	{  
6.	public:  
7.	    int value;  
8.	    A()  
9.	    {  
10.	        value=1;  
11.	    }  
12.	    void console()  
13.	    {  
14.	        cout<<value<<endl;  
15.	    }  
16.	   
17.	};  
18.	class B: public A  
19.	{  
20.	   public:  
21.	       int value;  
22.	    B():A()  
23.	    {  
24.	        value=2;  
25.	    }  
26.	};  
27.	int main()  
28.	{  
29.	    B b;  
30.	    // b.value = 3;只会修改子类的，不会修改父类的  
31.	    b.console();  
32.	    cout<<b.value<<endl<<"内存大小："<<sizeof(b)<<endl;  
33.	    return 0;  
34.	}  
```

以上代码执行时输出
1.	1  
2.	2  
3.	内存大小：8  
由输出结果我们可以知道，b内存大小是8个字节。即两个int。所以b的内存布局中两个a属性都分配了内存。当我们通过b.console输出value时，因为console是在A上定义的，所以输出1，但是我们通过b.value访问时，输出的是2。因为访问的是B中定义的value，同理如果我们在B中定义console，输出也会是2。Worker中定义的env_我们后续会看到它的作用。接着我们看一下Worker类的初始化逻辑。

```
1.	Worker::Worker(Environment* env,    
2.	               Local<Object> wrap,...)    
3.	    : AsyncWrap(env, wrap, AsyncWrap::PROVIDER_WORKER),    
4.	      ...    
5.	      // 分配线程id    
6.	      thread_id_(Environment::AllocateThreadId()),   
7.	      // 继承主线程的环境变量   
8.	      env_vars_(env->env_vars()) {    
9.	    
10.	  // 新建一个端口和子线程通信    
11.	  parent_port_ = MessagePort::New(env, env->context());    
12.	  /*  
13.	    关联起来，用于通信  
14.	    const parent_port_ = {data: {sibling: null}};  
15.	    const child_port_data_  = {sibling: null};  
16.	    parent_port_.data.sibling = child_port_data_;  
17.	    child_port_data_.sibling = parent_port_.data;  
18.	  */    
19.	  child_port_data_ = std::make_unique<MessagePortData>(nullptr);    
20.	  MessagePort::Entangle(parent_port_, child_port_data_.get());    
21.	  // 设置JS层Worker对象的messagePort属性为parent_port_    
22.	  object()->Set(env->context(),    
23.	                env->message_port_string(),    
24.	                parent_port_->object()).Check();    
25.	  // 设置Worker对象的线程id，即threadId属性    
26.	  object()->Set(env->context(),    
27.	                env->thread_id_string(),    
28.	                Number::New(env->isolate(), static_cast<double>(thread_id_)))    
29.	      .Check();    
30.	}   
```

新建一个Worker，结构如图14-3所示。  
![](https://img-blog.csdnimg.cn/ec2cdce5275d4cf4b5c4ab5586f993c2.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图14-3

了解了new Worker的逻辑后，我们看在JS层是如何使用的。我们看JS层Worker类的构造函数。

```
1.	constructor(filename, options = {}) {  
2.	    super();  
3.	    // 忽略一系列参数处理，new Worker就是上面提到的C++层的  
4.	    this[kHandle] = new Worker(url, options.execArgv, parseResourceLimits(options.resourceLimits));  
5.	    // messagePort指向_parent_port  
6.	    this[kPort] = this[kHandle].messagePort;  
7.	    this[kPort].on('message', (data) => this[kOnMessage](data));
8.	    // 开始接收消息  
9.	    this[kPort].start();  
10.	    // 申请一个通信通道，两个端口  
11.	    const { port1, port2 } = new MessageChannel();  
12.	    this[kPublicPort] = port1;  
13.	    this[kPublicPort].on('message', (message) => this.emit('message', message));  
14.	    // 向另一端发送消息  
15.	    this[kPort].postMessage({  
16.	      argv,  
17.	      type: messageTypes.LOAD_SCRIPT,  
18.	      filename,  
19.	      doEval: !!options.eval,  
20.	      cwdCounter: cwdCounter || workerIo.sharedCwdCounter,  
21.	      workerData: options.workerData,  
22.	      publicPort: port2,  
23.	      manifestSrc: getOptionValue('--experimental-policy') ?  
24.	        require('internal/process/policy').src :  
25.	        null,  
26.	      hasStdin: !!options.stdin  
27.	    }, [port2]);  
28.	    // 开启线程  
29.	    this[kHandle].startThread();  
30.	  }  
```

上面的代码主要逻辑如下  
1 保存messagePort，监听该端口的message事件，然后给messagePort的对端发送消息，但是这时候还没有接收端口，所以消息会缓存到MessagePortData，即child_port_data_ 中。另外我们看到主线程把通信端口port2发送给了子线程。  
2 申请一个通信通道port1和port2，用于主线程和子线程通信。_parent_port和child_port是给Node.js使用的，新申请的端口是给用户使用的。  
3 创建子线程。  
我们看创建线程的时候，做了什么。

```
1.	void Worker::StartThread(const FunctionCallbackInfo<Value>& args) {  
2.	  Worker* w;  
3.	  ASSIGN_OR_RETURN_UNWRAP(&w, args.This());  
4.	  Mutex::ScopedLock lock(w->mutex_);  
5.	  
6.	  // The object now owns the created thread and should not be garbage collected  
7.	  // until that finishes.  
8.	  w->ClearWeak();  
9.	  // 加入主线程维护的子线程数据结构  
10.	  w->env()->add_sub_worker_context(w);  
11.	  w->stopped_ = false;  
12.	  w->thread_joined_ = false;  
13.	  // 是否需要阻塞事件循环退出，默认true  
14.	  if (w->has_ref_)  
15.	    w->env()->add_refs(1);  
16.	  // 是否需要栈和栈大小  
17.	  uv_thread_options_t thread_options;  
18.	  thread_options.flags = UV_THREAD_HAS_STACK_SIZE;  
19.	  thread_options.stack_size = kStackSize;  
20.	  // 创建线程  
21.	  CHECK_EQ(uv_thread_create_ex(&w->tid_, &thread_options, [](void* arg) {  
22.	
23.	    Worker* w = static_cast<Worker*>(arg);  
24.	    const uintptr_t stack_top = reinterpret_cast<uintptr_t>(&arg);  
25.	    w->stack_base_ = stack_top - (kStackSize - kStackBufferSize);  
26.	    // 执行主逻辑  
27.	    w->Run();  
28.	  
29.	    Mutex::ScopedLock lock(w->mutex_);  
30.	    // 给主线程提交一个任务，通知主线程子线程执行完毕，因为主线程不能直接执行join阻塞自己  
31.	    w->env()->SetImmediateThreadsafe(  
32.	        [w = std::unique_ptr<Worker>(w)](Environment* env) {  
33.	          if (w->has_ref_)  
34.	            env->add_refs(-1);  
35.	          w->JoinThread();  
36.	          // implicitly delete w  
37.	        });  
38.	  }, static_cast<void*>(w)), 0);  
39.	}  
```

StartThread新建了一个子线程，然后在子线程中执行Run，我们继续看Run

```
1.	void Worker::Run() {  
2.	  // 线程执行所需要的数据结构，比如loop，isolate，和主线程独立  
3.	  WorkerThreadData data(this);  
4.	   
5.	  {  
6.	    Locker locker(isolate_);  
7.	    Isolate::Scope isolate_scope(isolate_);  
8.	    SealHandleScope outer_seal(isolate_);  
9.	    // std::unique_ptr<Environment, FreeEnvironment> env_;  
10.	    DeleteFnPtr<Environment, FreeEnvironment> env_;  
11.	    // 线程执行完后执行的清除函数  
12.	    auto cleanup_env = OnScopeLeave([&]() {  
13.	    // ...  
14.	    });  
15.	  
16.	    {  
17.	      HandleScope handle_scope(isolate_);  
18.	      Local<Context> context;  
19.	      // 新建一个context，和主线程独立  
20.	      context = NewContext(isolate_);  
21.	      Context::Scope context_scope(context);  
22.	      {  
23.	        // 新建一个env并初始化，env中会和新的context关联  
24.	        env_.reset(new Environment(data.isolate_data_.get(),  
25.	                                   context,  
26.	                                   std::move(argv_),  
27.	                                   std::move(exec_argv_),  
28.	                                   Environment::kNoFlags,  
29.	                                   thread_id_));  
30.	        env_->set_env_vars(std::move(env_vars_));  
31.	        env_->set_abort_on_uncaught_exception(false);  
32.	        env_->set_worker_context(this);  
33.	  
34.	        env_->InitializeLibuv(start_profiler_idle_notifier_);  
35.	      }  
36.	      {  
37.	        Mutex::ScopedLock lock(mutex_);  
38.	        // 更新子线程所属的env  
39.	        this->env_ = env_.get();  
40.	      }  
41.	        
42.	      {  
43.	        if (!env_->RunBootstrapping().IsEmpty()) {  
44.	          CreateEnvMessagePort(env_.get());  
45.	          USE(StartExecution(env_.get(), "internal/main/worker_thread"));  
46.	        }  
47.	      }  
48.	  
49.	      {  
50.	        SealHandleScope seal(isolate_);  
51.	        bool more;  
52.	        // 开始事件循环  
53.	        do {  
54.	          if (is_stopped()) break;  
55.	          uv_run(&data.loop_, UV_RUN_DEFAULT);  
56.	          if (is_stopped()) break;  
57.	  
58.	          platform_->DrainTasks(isolate_);  
59.	  
60.	          more = uv_loop_alive(&data.loop_);  
61.	          if (more && !is_stopped()) continue;  
62.	  
63.	          EmitBeforeExit(env_.get());  
64.	  
65.	          more = uv_loop_alive(&data.loop_);  
66.	        } while (more == true && !is_stopped());  
67.	      }  
68.	    }  
69.	}  
```

 我们分步骤分析上面的代码
1 新建Isolate、context和Environment，子线程在独立的环境执行。然后初始化Environment。这个在Node.js启动过程章节已经分析过，不再分析。  
2 更新子线程的env_。刚才已经分析过，Worker类中定义了env_属性，所以这里通过this.env_更新时，是不会影响基类（BaseObject）中的值的。因为子线程是在新的环境执行的，所以在新环境中使用该Worker实例时，需要使用新的环境变量。而在主线程使用该Worker实例时，是通过BaseObject的env()访问的。从而获取的是主线程的环境。因为Worker实例是在主线程和子线程之间共享的，Node.js在Worker类中重新定义了一个env_属性正是为了解决这个问题。  
3 CreateEnvMessagePort

```
1.	void Worker::CreateEnvMessagePort(Environment* env) {  
2.	  child_port_ = MessagePort::New(env,
3.	                                     env->context(),  
4.	                   std::move(child_port_data_));  
5.	  if (child_port_ != nullptr)  
6.	    env->set_message_port(child_port_->object(isolate_));  
7.	}  
```

child_port_data_这个变量刚才我们已经看到过，在这里首先申请一个新的端口。并且和child_port_data_互相关联起来。然后在env缓存起来。后续会使用。这时候的关系图如图14-4所示。  
![](https://img-blog.csdnimg.cn/04b747f85beb41048a588146806d16b4.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图14-4

4 执行internal/main/worker_thread.js

```
1.	// 设置process对象  
2.	patchProcessObject();  
3.	// 获取刚才缓存的端口child_port_  
4.	onst port = getEnvMessagePort();  
5.	port.on('message', (message) => {  
6.	  // 加载脚本  
7.	  if (message.type === LOAD_SCRIPT) {  
8.	    const {  
9.	      argv,  
10.	      cwdCounter,  
11.	      filename,  
12.	      doEval,  
13.	      workerData,  
14.	      publicPort,  
15.	      manifestSrc,  
16.	      manifestURL,  
17.	      hasStdin  
18.	    } = message;  
19.	  
20.	    const CJSLoader = require('internal/modules/cjs/loader');  
21.	    loadPreloadModules();  
22.	    /* 
23.	     由主线程申请的MessageChannel中某一端的端口， 
24.	     主线程传递过来的，保存用于和主线程通信 
25.	    */  
26.	    publicWorker.parentPort = publicPort;  
27.	    // 执行时使用的数据  
28.	    publicWorker.workerData = workerData;  
29.	    // 通知主线程，正在执行脚本  
30.	    port.postMessage({ type: UP_AND_RUNNING });  
31.	    // 执行new Worker(filename)时传入的文件  
32.	    CJSLoader.Module.runMain(filename);  
33.	})  
34.	// 开始接收消息  
35.	port.start()  
```

我们看到worker_thread.js中通过runMain完成了子线程的代码执行，然后开始事件循环。
我们看一下当事件循环结束时，Node.js的逻辑。

```
1.	// 给主线程提交一个任务，通知主线程子线程执行完毕，因为主线程不能直接执行join阻塞自己    
2.	w->env()->SetImmediateThreadsafe(    
3.	    [w = std::unique_ptr<Worker>(w)](Environment* env) {    
4.	      if (w->has_ref_)    
5.	        env->add_refs(-1);    
6.	      w->JoinThread();    
7.	      // implicitly delete w    
8.	    });    
9.	}, static_cast<void*>(w)), 0);    
```

通过w->env()获取的是主线程的执行环境。我们看一下SetImmediateThreadsafe。

```
1.	template <typename Fn>  
2.	void Environment::SetImmediateThreadsafe(Fn&& cb) {  
3.	  auto callback = std::make_unique<NativeImmediateCallbackImpl<Fn>>(  
4.	      std::move(cb), false);  
5.	  {  
6.	    Mutex::ScopedLock lock(native_immediates_threadsafe_mutex_);  
7.	    native_immediates_threadsafe_.Push(std::move(callback));  
8.	  }  
9.	  uv_async_send(&task_queues_async_);  
10.	}  
```

SetImmediateThreadsafe用于通知执行环境所在的事件循环有异步任务完成。并且是线程安全的。因为可能有多个线程会操作native_immediates_threadsafe_。在主线程事件循环的Poll IO阶段就会执行task_queues_async_回调。我们看一下task_queues_async_对应的回调。

```
1.	uv_async_init(  
2.	     event_loop(),  
3.	     &task_queues_async_,  
4.	     [](uv_async_t* async) {  
5.	       Environment* env = ContainerOf(  
6.	           &Environment::task_queues_async_, async);  
7.	       env->CleanupFinalizationGroups();  
8.	       env->RunAndClearNativeImmediates();  
9.	     });  
```

所以在Poll IO阶段执行的回调是RunAndClearNativeImmediates

```
1.	void Environment::RunAndClearNativeImmediates(bool only_refed) {  
2.	  TraceEventScope trace_scope(TRACING_CATEGORY_NODE1(environment),  
3.	                              "RunAndClearNativeImmediates", this);  
4.	  size_t ref_count = 0;  
5.	   
6.	  if (native_immediates_threadsafe_.size() > 0) {  
7.	    Mutex::ScopedLock lock(native_immediates_threadsafe_mutex_);  
8.	    native_immediates_.ConcatMove(std::move(native_immediates_threadsafe_));  
9.	  }  
10.	  
11.	  auto drain_list = [&]() {  
12.	    TryCatchScope try_catch(this);  
13.	    DebugSealHandleScope seal_handle_scope(isolate());  
14.	    while (std::unique_ptr<NativeImmediateCallback> head =  
15.	               native_immediates_.Shift()) {  
16.	      if (head->is_refed())  
17.	        ref_count++;  
18.	  
19.	      if (head->is_refed() || !only_refed)  
20.	        // 执行回调  
21.	        head->Call(this);  
22.	  
23.	      head.reset();   
24.	  };  
25.	}  
```

RunAndClearNativeImmediates会执行队列里的回调。对应Worker的JoinThread

```
1.	void Worker::JoinThread() {  
2.	  // 阻塞等待子线程结束，执行到这子线程已经结束了  
3.	  CHECK_EQ(uv_thread_join(&tid_), 0);  
4.	  thread_joined_ = true;  
5.	  // 从主线程数据结构中删除该线程对应的实例  
6.	  env()->remove_sub_worker_context(this);  
7.	  
8.	  {  
9.	    HandleScope handle_scope(env()->isolate());  
10.	    Context::Scope context_scope(env()->context());  
11.	  
12.	    // Reset the parent port as we're closing it now anyway.  
13.	    object()->Set(env()->context(),  
14.	                  env()->message_port_string(),  
15.	                  Undefined(env()->isolate())).Check();  
16.	    // 子线程退出码  
17.	    Local<Value> args[] = {  
18.	      Integer::New(env()->isolate(), exit_code_),  
19.	      custom_error_ != nullptr ?  
20.	          OneByteString(env()->isolate(), custom_error_).As<Value>() :  
21.	          Null(env()->isolate()).As<Value>(),  
22.	    };  
23.	    // 执行JS层回调，触发exit事件  
24.	    MakeCallback(env()->onexit_string(), arraysize(args), args);  
25.	  }  
26.	}  
```

最后我们看一下如果结束正在执行的子线程。在JS中我能可以通过terminate函数终止线程的执行。

```
1.	terminate(callback) {  
2.	    this[kHandle].stopThread();  
3.	}  
Terminate是对C++模块stopThread的封装。
1.	void Worker::StopThread(const FunctionCallbackInfo<Value>& args) {  
2.	  Worker* w;  
3.	  ASSIGN_OR_RETURN_UNWRAP(&w, args.This());  
4.	  w->Exit(1);  
5.	}  
6.	  
7.	void Worker::Exit(int code) {  
8.	  Mutex::ScopedLock lock(mutex_);  
9.	  // env_是子线程执行的env 
10.	  if (env_ != nullptr) {  
11.	    exit_code_ = code;  
12.	    Stop(env_);  
13.	  } else {  
14.	    stopped_ = true;  
15.	  }  
16.	}  
17.	  
18.	  
19.	int Stop(Environment* env) {  
20.	  env->ExitEnv();  
21.	  return 0;  
22.	}  
23.	  
24.	void Environment::ExitEnv() {  
25.	  set_can_call_into_js(false);  
26.	  set_stopping(true);  
27.	  isolate_->TerminateExecution();  
28.	  SetImmediateThreadsafe([](Environment* env) { uv_stop(env->event_loop()); });  
29.	}  
```

我们看到主线程最终通过SetImmediateThreadsafe给子线程所属的env提交了一个任务。子线程在Poll IO阶段会设置停止事件循环的标记，等到下一次事件循环开始的时候，就会跳出事件循环从而结束子线程的执行。
## 14.4 线程间通信
本节我们看一下线程间通信的过程。

```
1.	const { Worker, isMainThread, parentPort } = require('worker_threads');  
2.	if (isMainThread) {  
3.	  const worker = new Worker(__filename);  
4.	  worker.once('message', (message) => {  
5.	    ...  
6.	  });  
7.	  worker.postMessage('Hello, world!');  
8.	} else {  
9.	  // 做点耗时的事情  
10.	  parentPort.once('message', (message) => {  
11.	    parentPort.postMessage(message);  
12.	  });  
13.	}  
```

我们知道isMainThread在子线程里是false，parentPort就是messageChannel中的一端。用于和主线程通信，所以parentPort.postMessage给对端发送消息，就是给主线程发送消息，我们再看看worker.postMessage('Hello, world!')。

```
1.	postMessage(...args) {  
2.	   this[kPublicPort].postMessage(...args);  
3.	}  
```

kPublicPort指向的就是messageChannel的一端。this[kPublicPort].postMessage(...args)即给另一端发送消息。我们看一下postMessage的实现。

```
1.	void MessagePort::PostMessage(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	  Local<Object> obj = args.This();  
4.	  Local<Context> context = obj->CreationContext();  
5.	  
6.	  TransferList transfer_list;  
7.	  if (args[1]->IsObject()) {  
8.	    // 处理transfer_list  
9.	  }  
10.	  // 拿到JS层使用的对象所关联的MessagePort  
11.	  MessagePort* port = Unwrap<MessagePort>(args.This());  
12.	  
13.	  port->PostMessage(env, args[0], transfer_list);  
14.	}  
```

我们接着看port->PostMessage

```
1.	Maybe<bool> MessagePort::PostMessage(Environment* env,  
2.	                                     Local<Value> message_v,  
3.	                                     const TransferList& transfer_v) {  
4.	  Isolate* isolate = env->isolate();  
5.	  Local<Object> obj = object(isolate);  
6.	  Local<Context> context = obj->CreationContext();  
7.	  
8.	  Message msg;  
9.	  
10.	  // 序列化  
11.	  Maybe<bool> serialization_maybe =  
12.	      msg.Serialize(env, context, message_v, transfer_v, obj);  
13.	  // 拿到操作对端sibling的锁  
14.	  Mutex::ScopedLock lock(*data_->sibling_mutex_);  
15.	    
16.	  // 把消息插入到对端队列  
17.	  data_->sibling_->AddToIncomingQueue(std::move(msg));  
18.	  return Just(true);  
19.	}  
```

PostMessage通过AddToIncomingQueue把消息插入对端的消息队列我们看一下AddToIncomingQueue

```
1.	void MessagePortData::AddToIncomingQueue(Message&& message) {  
2.	  // 加锁操作消息队列  
3.	  Mutex::ScopedLock lock(mutex_);  
4.	  incoming_messages_.emplace_back(std::move(message));  
5.	  // 通知owner  
6.	  if (owner_ != nullptr) {  
7.	    owner_->TriggerAsync();  
8.	  }  
9.	}  
```

插入消息队列后，如果有关联的端口，则会通知Libuv。我们继续看TriggerAsync。

```
1.	void MessagePort::TriggerAsync() {  
2.	  if (IsHandleClosing()) return;  
3.	  CHECK_EQ(uv_async_send(&async_), 0);  
4.	}  
```

Libuv在Poll IO阶段就会执行对应的回调。回调是在new MessagePort时设置的。

```
1.	auto onmessage = [](uv_async_t* handle) {  
2.	  MessagePort* channel = ContainerOf(&MessagePort::async_, handle);  
3.	  channel->OnMessage();  
4.	};  
5.	// 初始化async结构体，实现异步通信  
6.	CHECK_EQ(uv_async_init(env->event_loop(),  
7.	                       &async_,  
8.	                       onmessage), 0);  
```

我们继续看OnMessage。

```
1.	void MessagePort::OnMessage() {  
2.	  HandleScope handle_scope(env()->isolate());  
3.	  Local<Context> context = object(env()->isolate())->CreationContext();  
4.	  // 接收消息条数的阈值  
5.	  size_t processing_limit;  
6.	  {   
7.	    // 加锁操作消息队列  
8.	    Mutex::ScopedLock(data_->mutex_);  
9.	    processing_limit = std::max(data_->incoming_messages_.size(),  
10.	                                static_cast<size_t>(1000));  
11.	  }  
12.	  while (data_) {  
13.	    // 读取的条数达到阈值，通知Libuv下一轮Poll IO阶段继续读  
14.	    if (processing_limit-- == 0) {  
15.	      // 通知事件循环  
16.	      TriggerAsync();  
17.	      return;  
18.	    }  
19.	  
20.	    HandleScope handle_scope(env()->isolate());  
21.	    Context::Scope context_scope(context);  
22.	  
23.	    Local<Value> payload;  
24.	    // 读取消息  
25.	    if (!ReceiveMessage(context, true).ToLocal(&payload)) break;  
26.	    // 没有了  
27.	    if (payload == env()->no_message_symbol()) break;  
28.	  
29.	    Local<Object> event;  
30.	    Local<Value> cb_args[1];  
31.	    // 新建一个MessageEvent对象，回调onmessage事件  
32.	    if (!env()->message_event_object_template()->NewInstance(context)  
33.	            .ToLocal(&event) ||  
34.	        event->Set(context, env()->data_string(), payload).IsNothing() ||  
35.	        event->Set(context, env()->target_string(), object()).IsNothing() ||  
36.	        (cb_args[0] = event, false) ||  
37.	        MakeCallback(env()->onmessage_string(),  
38.	                     arraysize(cb_args),  
39.	                     cb_args).IsEmpty()) {  
40.	      // 如果回调失败，通知Libuv下次继续读  
41.	      if (data_)  
42.	        TriggerAsync();  
43.	      return;  
44.	    }  
45.	  }  
46.	}  
```

我们看到这里会不断地调用ReceiveMessage读取数据，然后回调JS层。直到达到阈值或者回调失败。我们看一下ReceiveMessage的逻辑。

```
1.	MaybeLocal<Value> MessagePort::ReceiveMessage(Local<Context> context,  
2.	                                              bool only_if_receiving) {  
3.	  Message received;  
4.	  {  
5.	    // Get the head of the message queue.  
6.	    // 互斥访问消息队列  
7.	    Mutex::ScopedLock lock(data_->mutex_);  
8.	  
9.	    bool wants_message = receiving_messages_ || !only_if_receiving;  
10.	    // 没有消息、不需要接收消息、消息是关闭消息  
11.	    if (data_->incoming_messages_.empty() ||  
12.	        (!wants_message &&  
13.	         !data_->incoming_messages_.front().IsCloseMessage())) {  
14.	      return env()->no_message_symbol();  
15.	    }  
16.	    // 获取队列第一个消息  
17.	    received = std::move(data_->incoming_messages_.front());  
18.	    data_->incoming_messages_.pop_front();  
19.	  }  
20.	  // 是关闭消息则关闭端口  
21.	  if (received.IsCloseMessage()) {  
22.	    Close();  
23.	    return env()->no_message_symbol();  
24.	  }  
25.	  
26.	  // 反序列化后返回  
27.	  return received.Deserialize(env(), context);  
28.	}  
```

ReceiveMessage会消息进行反序列化返回。以上就是线程间通信的整个过程。具体步骤如图14-5所示。  
 ![](https://img-blog.csdnimg.cn/56ef57375522428e92f3d53649fe3265.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图14-5
