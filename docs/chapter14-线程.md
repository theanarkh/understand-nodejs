
线程是操作系统的最小调度单位，它本质上是进程中的一个执行流，我们知道，进程有代码段，线程其实就是进程代码段中的其中一段代码。线程的一种实现是作为进程来实现的（pthread线程库），通过调用clone，新建一个进程，然后执行父进程代码段里的一个代码片段，其中文件描述符、内存等信息都是共享的。因为内存是共享的，所以线程不能共享栈，否则访问栈的地址的时候，会映射到相同的物理地址，那样就会互相影响，所以每个线程会有自己独立的栈。在调用clone函数的时候会设置栈的范围，比如在堆上分配一块内存用于做线程的栈，并且支持设置子线程和主线程共享哪些资源。具体可以参考clone系统调用。

由于Node.js是单线程的，虽然底层的Libuv实现了一个线程池，但是这个线程池只能执行C、C++层定义的任务。如果我们想自定义一些耗时的操作，那就只能在C++层处理，然后暴露接口给JS层调用，这个成本是非常高的，在早期的Node.js版本里，我们可以用进程去实现这样的需求。但是进程太重了，在新版的Node.js中，Node.js为我们提供了多线程的功能。这一章以Node.js多线程模块为背景，分析Node.js中多线程的原理，但是不分析Libuv的线程实现，它本质是对线程库的简单封装。Node.js中，线程的实现也非常复杂。虽然底层只是对线程库的封装，但是把它和Node.js原本的架构结合起来变得复杂起来。

## 14.1 使用多线程
对于同步文件操作、DNS解析等操作，Node.js使用了内置的线程池支持了异步。但是一些加解密、字符串运算、阻塞型API等操作。我们就不能在主线程里处理了，这时候就不得不使用线程，而且多线程还能利用多核的能力。Node.js的子线程本质上是一个新的事件循环，但是子线程和Node.js主线程共享一个Libuv线程池，所以如果在子线程里有文件、DNS等操作就会和主线程竞争Libuv线程池。如图14-1所示。  
![](https://img-blog.csdnimg.cn/7b5d3376155d4521800749ca4a455b57.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图14-1  
我们看一下在Node.js中如何使用线程。

```js
    const { Worker, isMainThread, parentPort } = require('worker_threads');  
    if (isMainThread) {  
      const worker = new Worker(__filename);  
      worker.once('message', (message) => {  
        ...  
      });  
      worker.postMessage('Hello, world!');  
    } else {  
      // 做点耗时的事情  
      parentPort.once('message', (message) => {  
        parentPort.postMessage(message);  
      });  
    }  
```

上面这段代码会被执行两次，一次是在主线程，一次在子线程。所以首先通过isMainThread判断当前是主线程还是子线程。主线程的话，就创建一个子线程，然后监听子线程发过来的消息。子线程的话，首先执行业务相关的代码，还可以监听主线程传过来的消息。我们在子线程中可以做一些耗时或者阻塞性的操作，不会影响主线程的执行。我们也可以把这两个逻辑拆分到两个文件。

主线程

```js
    const { Worker, isMainThread, parentPort } = require('worker_threads');  
    const worker = new Worker(‘子线程文件路径’);  
    worker.once('message', (message) => {  
      ...  
    });  
    worker.postMessage('Hello, world!');  
```

子线程

```js
    const { Worker, isMainThread, parentPort } = require('worker_threads');  
    parentPort.once('message', (message) => {  
      parentPort.postMessage(message);  
    });  
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

```cpp
    class Message : public MemoryRetainer {  
     public:  
      explicit Message(MallocedBuffer<char>&& payload = MallocedBuffer<char>());  
      // 是否是最后一条消息，空消息代表是最后一条消息  
      bool IsCloseMessage() const;  
      // 线程间通信的数据需要通过序列化和反序列化处理  
      v8::MaybeLocal<v8::Value> Deserialize(Environment* env,  
                                            v8::Local<v8::Context> context);  
      v8::Maybe<bool> Serialize(Environment* env,  
                                v8::Local<v8::Context> context,  
                                v8::Local<v8::Value> input,  
                                const TransferList& transfer_list,  
                                v8::Local<v8::Object> source_port =  
                                    v8::Local<v8::Object>());  
      
      // 传递SharedArrayBuffer型变量  
      void AddSharedArrayBuffer(std::shared_ptr<v8::BackingStore> backing_store);  
      // 传递MessagePort型变量  
      void AddMessagePort(std::unique_ptr<MessagePortData>&& data);  
      // 消息所属端口，端口是消息到达的地方  
      const std::vector<std::unique_ptr<MessagePortData>>& message_ports() const {  
        return message_ports_;  
      }  
      
     private:  
      // 保存消息的内容  
      MallocedBuffer<char> main_message_buf_;  
      std::vector<std::shared_ptr<v8::BackingStore>> array_buffers_;  
      std::vector<std::shared_ptr<v8::BackingStore>> shared_array_buffers_;  
      std::vector<std::unique_ptr<MessagePortData>> message_ports_;  
      std::vector<v8::CompiledWasmModule> wasm_modules_;  
    };  
```

### 14.2.2 MessagePortData
MessagePortData是管理消息发送和接收的类。 

```cpp
    class MessagePortData : public MemoryRetainer {  
     public:  
      explicit MessagePortData(MessagePort* owner);  
      ~MessagePortData() override;  
      // 新增一个消息  
      void AddToIncomingQueue(Message&& message);  
      // 关联/解关联通信两端的端口  
      static void Entangle(MessagePortData* a, MessagePortData* b);  
      void Disentangle();  
        
     private:  
      // 用于多线程往对端消息队列插入消息时的互斥变量  
      mutable Mutex mutex_;  
      std::list<Message> incoming_messages_;  
      // 所属端口  
      MessagePort* owner_ = nullptr;  
      // 用于多线程访问对端sibling_属性时的互斥变量  
      std::shared_ptr<Mutex> sibling_mutex_ = std::make_shared<Mutex>();  
      // 指向通信对端的指针  
      MessagePortData* sibling_ = nullptr;  
    };  
```

我们看一下实现。

```cpp
    MessagePortData::MessagePortData(MessagePort* owner) : owner_(owner) { }  
      
    MessagePortData::~MessagePortData() {  
      // 析构时解除和对端的关系  
      Disentangle();  
    }  
      
    // 插入一个message  
    void MessagePortData::AddToIncomingQueue(Message&& message) {  
      // 先加锁，保证多线程安全，互斥访问  
      Mutex::ScopedLock lock(mutex_);  
      // 插入消息队列  
      incoming_messages_.emplace_back(std::move(message));  
      // 通知owner  
      if (owner_ != nullptr) {  
        owner_->TriggerAsync();  
      }  
    }  
      
    // 关联通信的对端，并保持对端的互斥变量，访问对端时需要使用  
    void MessagePortData::Entangle(MessagePortData* a, MessagePortData* b) {  
      a->sibling_ = b;  
      b->sibling_ = a;  
      a->sibling_mutex_ = b->sibling_mutex_;  
    }  
      
    // 解除关联   
    void MessagePortData::Disentangle() {  
      // 加锁操作对端的sibling字段  
      std::shared_ptr<Mutex> sibling_mutex = sibling_mutex_;  
      Mutex::ScopedLock sibling_lock(*sibling_mutex);  
      sibling_mutex_ = std::make_shared<Mutex>();  
      // 对端  
      MessagePortData* sibling = sibling_;  
      // 对端非空，则把对端的sibling也指向空，自己也指向空  
      if (sibling_ != nullptr) {  
        sibling_->sibling_ = nullptr;  
        sibling_ = nullptr;  
      }  
      
      // 插入一个空的消息通知对端和本端  
      AddToIncomingQueue(Message());  
      if (sibling != nullptr) {  
        sibling->AddToIncomingQueue(Message());  
      }  
    }  
```

### 14.2.3 MessagePort
MessagePort表示的是通信的一端。

```cpp
    class MessagePort : public HandleWrap {  
     public:  
      MessagePort(Environment* env,  
                  v8::Local<v8::Context> context,  
                  v8::Local<v8::Object> wrap);  
      ~MessagePort() override;  
      
       static MessagePort* New(Environment* env,  
                               v8::Local<v8::Context> context,  
                               std::unique_ptr<MessagePortData> data = nullptr);  
      // 发送消息  
      v8::Maybe<bool> PostMessage(Environment* env,  
                                  v8::Local<v8::Value> message,  
                                  const TransferList& transfer);  
      
      // 开启/关闭接收消息  
      void Start();  
      void Stop();  
      
      static void New(const v8::FunctionCallbackInfo<v8::Value>& args);  
      // 提供JS层使用的方法  
      static void PostMessage(const v8::FunctionCallbackInfo<v8::Value>& args);  
      static void Start(const v8::FunctionCallbackInfo<v8::Value>& args);  
      static void Stop(const v8::FunctionCallbackInfo<v8::Value>& args);  
      static void Drain(const v8::FunctionCallbackInfo<v8::Value>& args);  
      static void ReceiveMessage(const v8::FunctionCallbackInfo<v8::Value>& args);  
      // 关联对端  
      static void Entangle(MessagePort* a, MessagePort* b);  
      static void Entangle(MessagePort* a, MessagePortData* b);  
      
      // 解除MessagePortData和端口的关系  
      std::unique_ptr<MessagePortData> Detach();  
      // 关闭端口  
      void Close(  
          v8::Local<v8::Value> close_callback = v8::Local<v8::Value>()) override;  
      
      inline bool IsDetached() const;  
     private:  
      void OnClose() override;  
      void OnMessage();  
      void TriggerAsync();  
      v8::MaybeLocal<v8::Value> ReceiveMessage(v8::Local<v8::Context> context,  
                                               bool only_if_receiving);  
      // MessagePortData用于管理消息的发送和接收  
      std::unique_ptr<MessagePortData> data_ = nullptr;  
      // 是否开启接收消息标记  
      bool receiving_messages_ = false;  
      // 用于收到消息时通知事件循环，事件循环执行回调处理消息  
      uv_async_t async_;  
    };  
```

我们看一下实现，只列出部分函数。

```cpp
    // 端口是否不接收消息了  
    bool MessagePort::IsDetached() const {  
      return data_ == nullptr || IsHandleClosing();  
    }  
      
    // 有消息到达，通知事件循环执行回调  
    void MessagePort::TriggerAsync() {  
      if (IsHandleClosing()) return;  
      CHECK_EQ(uv_async_send(&async_), 0);  
    }  
      
    // 关闭接收消息的端口  
    void MessagePort::Close(v8::Local<v8::Value> close_callback) {  
      if (data_) {  
        // 持有锁，防止再接收消息  
        Mutex::ScopedLock sibling_lock(data_->mutex_);  
        HandleWrap::Close(close_callback);  
      } else {  
        HandleWrap::Close(close_callback);  
      }  
    }  
      
    // 新建一个端口，并且可以挂载一个MessagePortData  
    MessagePort* MessagePort::New(  
        Environment* env,  
        Local<Context> context,  
        std::unique_ptr<MessagePortData> data) {  
      Context::Scope context_scope(context);  
      Local<FunctionTemplate> ctor_templ = GetMessagePortConstructorTemplate(env);  
      
      Local<Object> instance;  
      // JS层使用的对象  
      if (!ctor_templ->InstanceTemplate()->NewInstance(context).ToLocal(&instance))  
        return nullptr;  
      // 新建一个消息端口  
      MessagePort* port = new MessagePort(env, context, instance);  
      
      // 需要挂载MessagePortData  
      if (data) {  
        port->Detach();  
        port->data_ = std::move(data);  
        Mutex::ScopedLock lock(port->data_->mutex_);  
        // 修改data的owner为当前消息端口  
        port->data_->owner_ = port;  
        // data中可能有消息  
        port->TriggerAsync();  
      }  
      return port;  
    }  
      
    // 开始接收消息  
    void MessagePort::Start() {  
      Debug(this, "Start receiving messages");  
      receiving_messages_ = true;  
      Mutex::ScopedLock lock(data_->mutex_);  
      // 有缓存的消息，通知上层  
      if (!data_->incoming_messages_.empty())  
        TriggerAsync();  
    }  
      
    // 停止接收消息  
    void MessagePort::Stop() {  
      Debug(this, "Stop receiving messages");  
      receiving_messages_ = false;  
    }  
    // JS层调用
    void MessagePort::Start(const FunctionCallbackInfo<Value>& args) {  
      MessagePort* port;  
      ASSIGN_OR_RETURN_UNWRAP(&port, args.This());  
      if (!port->data_) {  
        return;  
      }  
      port->Start();  
    }  
      
    void MessagePort::Stop(const FunctionCallbackInfo<Value>& args) {  
      MessagePort* port;  
      CHECK(args[0]->IsObject());  
      ASSIGN_OR_RETURN_UNWRAP(&port, args[0].As<Object>());  
      if (!port->data_) {  
        return;  
      }  
      port->Stop();  
    }  
      
    // 读取消息  
    void MessagePort::Drain(const FunctionCallbackInfo<Value>& args) {  
      MessagePort* port;  
      ASSIGN_OR_RETURN_UNWRAP(&port, args[0].As<Object>());  
      port->OnMessage();  
    }  
      
    // 获取某个端口的消息  
    void MessagePort::ReceiveMessage(const FunctionCallbackInfo<Value>& args) {  
      CHECK(args[0]->IsObject());  
      // 第一个参数是端口  
      MessagePort* port = Unwrap<MessagePort>(args[0].As<Object>());  
      // 调用对象的ReceiverMessage方法  
      MaybeLocal<Value> payload =  
          port->ReceiveMessage(port->object()->CreationContext(), false);  
      if (!payload.IsEmpty())  
        args.GetReturnValue().Set(payload.ToLocalChecked());  
    }  
      
    // 关联两个端口  
    void MessagePort::Entangle(MessagePort* a, MessagePort* b) {  
      Entangle(a, b->data_.get());  
    }  
      
    void MessagePort::Entangle(MessagePort* a, MessagePortData* b) {  
      MessagePortData::Entangle(a->data_.get(), b);  
    }  
```

### 14.2.4 MessageChannel
MessageChannel表示线程间通信的两个端。

```cpp
    static void MessageChannel(const FunctionCallbackInfo<Value>& args) {  
      Environment* env = Environment::GetCurrent(args);  
       
      Local<Context> context = args.This()->CreationContext();  
      Context::Scope context_scope(context);  
      
      MessagePort* port1 = MessagePort::New(env, context);  
      MessagePort* port2 = MessagePort::New(env, context);  
      MessagePort::Entangle(port1, port2);  
      // port1->object()拿到JS层使用的对象，它关联了MessagePort对象
      args.This()->Set(context, env->port1_string(), port1->object())  
          .Check();  
      args.This()->Set(context, env->port2_string(), port2->object())  
          .Check();  
    }  
```

MessageChannel的逻辑比较简单，新建两个消息端口，并且关联起来，后续就可以基于这两个端口进行通信了。
Message、MessagePortData、MessagePort和MessageChannel的关系图如图14-2所示。  
![](https://img-blog.csdnimg.cn/db442278f4b54e89ad6ba365e2646b57.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图14-2  
最后我们看一下线程间通信模块导出的一些功能。

```cpp
    static void InitMessaging(Local<Object> target,  
                              Local<Value> unused,  
                              Local<Context> context,  
                              void* priv) {  
      Environment* env = Environment::GetCurrent(context);  
      
      {  
        // 线程间通信的通道  
        Local<String> message_channel_string = FIXED_ONE_BYTE_STRING(env->isolate(), 
                                                                           "MessageChannel");  
        Local<FunctionTemplate> templ = env->NewFunctionTemplate(MessageChannel);  
        templ->SetClassName(message_channel_string);  
        target->Set(context,  
                    message_channel_string,  
                    templ->GetFunction(context).ToLocalChecked()).Check();  
      }  
      // 新建消息端口的构造函数  
      target->Set(context,  
                  env->message_port_constructor_string(),  
                  GetMessagePortConstructorTemplate(env)  
                      ->GetFunction(context).ToLocalChecked()).Check();  
      
      env->SetMethod(target, "stopMessagePort", MessagePort::Stop);  
      env->SetMethod(target, "drainMessagePort", MessagePort::Drain);  
      env->SetMethod(target, "receiveMessageOnPort", MessagePort::ReceiveMessage);  
      env->SetMethod(target, "moveMessagePortToContext",  
                     MessagePort::MoveToContext);  
    }  
```

## 14.3 多线程的实现
本节我们从worker_threads模块开始分析多线程的实现。这是一个C++模块。我们看一下它导出的功能。require("work_threads")的时候就是引用了InitWorker函数导出的功能。

```cpp
    void InitWorker(Local<Object> target,    
                    Local<Value> unused,    
                    Local<Context> context,    
                    void* priv) {    
      Environment* env = Environment::GetCurrent(context);    
        
      {      
        Local<FunctionTemplate> w = env->NewFunctionTemplate(Worker::New);    
        w->InstanceTemplate()->SetInternalFieldCount(1);    
        w->Inherit(AsyncWrap::GetConstructorTemplate(env));    
        // 设置一系列原型方法，就不一一列举    
        env->SetProtoMethod(w, "setEnvVars", Worker::SetEnvVars);    
        // 一系列原型方法    
        /*  
         导出函数模块对应的函数，即我们代码中 
         const { Worker } = require("worker_threads");中的Worker  
        */   
        Local<String> workerString = FIXED_ONE_BYTE_STRING(env->isolate(), "Worker");    
        w->SetClassName(workerString);    
        target->Set(env->context(),    
                    workerString,    
                    w->GetFunction(env->context()).ToLocalChecked()).Check();    
         
         /*  
           导出getEnvMessagePort方法，获取线程接收消息的端口     
           const {getEnvMessagePort} = require("worker_threads"); 
         */  
         env->SetMethod(target, "getEnvMessagePort", GetEnvMessagePort);    
         /*  
           线程id，这个不是操作系统分配的那个，而是Node.js分配的, 
           在创建线程的时候设置  
           const { threadId } = require("worker_threads");  
         */    
        target->Set(env->context(),  
                      env->thread_id_string(),    
                      Number::New(env->isolate(),  
                      static_cast<double>(env->thread_id())))    
            .Check();    
        /*  
         是否是主线程， 
         const { isMainThread } = require("worker_threads");  
         这边变量在Node.js启动的时候设置为true，新开子线程的时候，没有设 
         置，所以是false  
        */    
        target->Set(env->context(),    
                    FIXED_ONE_BYTE_STRING(env->isolate(), "isMainThread"),   
                    Boolean::New(env->isolate(), env->is_main_thread()))  
                    .Check();    
        /*  
         如果不是主线程，导出资源限制的配置，  
         即在子线程中调用 
          const { resourceLimits } = require("worker_threads");  
        */    
        if (!env->is_main_thread()) {    
          target->Set(env->context(),    
                FIXED_ONE_BYTE_STRING(env->isolate(),   
                          "resourceLimits"),    
                env->worker_context()->GetResourceLimits(env->isolate())).Check();    
        }    
        // 导出几个常量    
        NODE_DEFINE_CONSTANT(target, kMaxYoungGenerationSizeMb);    
        NODE_DEFINE_CONSTANT(target, kMaxOldGenerationSizeMb);    
        NODE_DEFINE_CONSTANT(target, kCodeRangeSizeMb);    
        NODE_DEFINE_CONSTANT(target, kTotalResourceLimitCount);    
    }   
```

了解work_threads模块导出的功能后，我们看在JS层执行new Worker的时候的逻辑。根据上面代码导出的逻辑，我们知道这时候首先会新建一个C++对象。然后执行New回调，并传入新建的C++对象。我们看New函数的逻辑。我们省略一系列的参数处理，主要代码如下。

```cpp
    // args.This()就是我们刚才传进来的this  
    Worker* worker = new Worker(env, args.This(),   
                    url, per_isolate_opts,  
                    std::move(exec_argv_out));  
```

我们再看Worker类的声明。

```cpp
    class Worker : public AsyncWrap {  
     public:  
      // 函数声明  
      
     private:  
      
      std::shared_ptr<PerIsolateOptions> per_isolate_opts_;  
      std::vector<std::string> exec_argv_;  
      std::vector<std::string> argv_;  
      MultiIsolatePlatform* platform_;  
      v8::Isolate* isolate_ = nullptr;  
      bool start_profiler_idle_notifier_;  
      // 真正的线程id，底层返回的  
      uv_thread_t tid_;  
      
      // This mutex protects access to all variables listed below it.  
      mutable Mutex mutex_;  
      
      bool thread_joined_ = true;  
      const char* custom_error_ = nullptr;  
      int exit_code_ = 0;  
      // 线程id，Node.js分配，不是底层返回的  
      uint64_t thread_id_ = -1;  
      uintptr_t stack_base_ = 0;  
      
      // 线程资源限制配置  
      double resource_limits_[kTotalResourceLimitCount];  
      void UpdateResourceConstraints(v8::ResourceConstraints* constraints);  
      
      // 栈信息  
      static constexpr size_t kStackSize = 4 * 1024 * 1024;  
      static constexpr size_t kStackBufferSize = 192 * 1024;  
      
      std::unique_ptr<MessagePortData> child_port_data_;  
      std::shared_ptr<KVStore> env_vars_;  
      // 用于线程间通信  
      MessagePort* child_port_ = nullptr;  
      MessagePort* parent_port_ = nullptr;  
      // 线程状态  
      bool stopped_ = true;  
      // 是否影响事件循环退出  
      bool has_ref_ = true;  
      // 子线程执行时的环境变量，基类也定义了  
      Environment* env_ = nullptr;  
    };  
```

这里只讲一下env_的定义，因为这是一个非常重要的地方。我们看到Worker类继承AsyncWrap，AsyncWrap继承了BaseObject。BaseObject中也定义了env_属性。我们看一下在C++中如果子类父类都定义了一个属性时是怎样的。我们来看一个例子

```cpp
    #include <iostream>  
    using namespace std;  
      
    class A  
    {  
    public:  
        int value;  
        A()  
        {  
            value=1;  
        }  
        void console()  
        {  
            cout<<value<<endl;  
        }  
       
    };  
    class B: public A  
    {  
       public:  
           int value;  
        B():A()  
        {  
            value=2;  
        }  
    };  
    int main()  
    {  
        B b;  
        // b.value = 3;只会修改子类的，不会修改父类的  
        b.console();  
        cout<<b.value<<endl<<"内存大小："<<sizeof(b)<<endl;  
        return 0;  
    }  
```

以上代码执行时输出
    1  
    2  
    内存大小：8  
由输出结果我们可以知道，b内存大小是8个字节。即两个int。所以b的内存布局中两个a属性都分配了内存。当我们通过b.console输出value时，因为console是在A上定义的，所以输出1，但是我们通过b.value访问时，输出的是2。因为访问的是B中定义的value，同理如果我们在B中定义console，输出也会是2。Worker中定义的env_我们后续会看到它的作用。接着我们看一下Worker类的初始化逻辑。

```cpp
    Worker::Worker(Environment* env,    
                   Local<Object> wrap,...)    
        : AsyncWrap(env, wrap, AsyncWrap::PROVIDER_WORKER),    
          ...    
          // 分配线程id    
          thread_id_(Environment::AllocateThreadId()),   
          // 继承主线程的环境变量   
          env_vars_(env->env_vars()) {    
        
      // 新建一个端口和子线程通信    
      parent_port_ = MessagePort::New(env, env->context());    
      /*  
        关联起来，用于通信  
        const parent_port_ = {data: {sibling: null}};  
        const child_port_data_  = {sibling: null};  
        parent_port_.data.sibling = child_port_data_;  
        child_port_data_.sibling = parent_port_.data;  
      */    
      child_port_data_ = std::make_unique<MessagePortData>(nullptr);    
      MessagePort::Entangle(parent_port_, child_port_data_.get());    
      // 设置JS层Worker对象的messagePort属性为parent_port_    
      object()->Set(env->context(),    
                    env->message_port_string(),    
                    parent_port_->object()).Check();    
      // 设置Worker对象的线程id，即threadId属性    
      object()->Set(env->context(),    
                    env->thread_id_string(),    
                    Number::New(env->isolate(), static_cast<double>(thread_id_)))    
          .Check();    
    }   
```

新建一个Worker，结构如图14-3所示。  
![](https://img-blog.csdnimg.cn/ec2cdce5275d4cf4b5c4ab5586f993c2.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图14-3

了解了new Worker的逻辑后，我们看在JS层是如何使用的。我们看JS层Worker类的构造函数。

```js
    constructor(filename, options = {}) {  
        super();  
        // 忽略一系列参数处理，new Worker就是上面提到的C++层的  
        this[kHandle] = new Worker(url, options.execArgv, parseResourceLimits(options.resourceLimits));  
        // messagePort指向_parent_port  
        this[kPort] = this[kHandle].messagePort;  
        this[kPort].on('message', (data) => this[kOnMessage](data));
        // 开始接收消息  
        this[kPort].start();  
        // 申请一个通信通道，两个端口  
        const { port1, port2 } = new MessageChannel();  
        this[kPublicPort] = port1;  
        this[kPublicPort].on('message', (message) => this.emit('message', message));  
        // 向另一端发送消息  
        this[kPort].postMessage({  
          argv,  
          type: messageTypes.LOAD_SCRIPT,  
          filename,  
          doEval: !!options.eval,  
          cwdCounter: cwdCounter || workerIo.sharedCwdCounter,  
          workerData: options.workerData,  
          publicPort: port2,  
          manifestSrc: getOptionValue('--experimental-policy') ?  
            require('internal/process/policy').src :  
            null,  
          hasStdin: !!options.stdin  
        }, [port2]);  
        // 开启线程  
        this[kHandle].startThread();  
      }  
```

上面的代码主要逻辑如下  
1 保存messagePort，监听该端口的message事件，然后给messagePort的对端发送消息，但是这时候还没有接收端口，所以消息会缓存到MessagePortData，即child_port_data_ 中。另外我们看到主线程把通信端口port2发送给了子线程。  
2 申请一个通信通道port1和port2，用于主线程和子线程通信。_parent_port和child_port是给Node.js使用的，新申请的端口是给用户使用的。  
3 创建子线程。  
我们看创建线程的时候，做了什么。

```cpp
    void Worker::StartThread(const FunctionCallbackInfo<Value>& args) {  
      Worker* w;  
      ASSIGN_OR_RETURN_UNWRAP(&w, args.This());  
      Mutex::ScopedLock lock(w->mutex_);  
      
      // The object now owns the created thread and should not be garbage collected  
      // until that finishes.  
      w->ClearWeak();  
      // 加入主线程维护的子线程数据结构  
      w->env()->add_sub_worker_context(w);  
      w->stopped_ = false;  
      w->thread_joined_ = false;  
      // 是否需要阻塞事件循环退出，默认true  
      if (w->has_ref_)  
        w->env()->add_refs(1);  
      // 是否需要栈和栈大小  
      uv_thread_options_t thread_options;  
      thread_options.flags = UV_THREAD_HAS_STACK_SIZE;  
      thread_options.stack_size = kStackSize;  
      // 创建线程  
      CHECK_EQ(uv_thread_create_ex(&w->tid_, &thread_options, [](void* arg) {  
    
        Worker* w = static_cast<Worker*>(arg);  
        const uintptr_t stack_top = reinterpret_cast<uintptr_t>(&arg);  
        w->stack_base_ = stack_top - (kStackSize - kStackBufferSize);  
        // 执行主逻辑  
        w->Run();  
      
        Mutex::ScopedLock lock(w->mutex_);  
        // 给主线程提交一个任务，通知主线程子线程执行完毕，因为主线程不能直接执行join阻塞自己  
        w->env()->SetImmediateThreadsafe(  
            [w = std::unique_ptr<Worker>(w)](Environment* env) {  
              if (w->has_ref_)  
                env->add_refs(-1);  
              w->JoinThread();  
              // implicitly delete w  
            });  
      }, static_cast<void*>(w)), 0);  
    }  
```

StartThread新建了一个子线程，然后在子线程中执行Run，我们继续看Run

```cpp
    void Worker::Run() {  
      // 线程执行所需要的数据结构，比如loop，isolate，和主线程独立  
      WorkerThreadData data(this);  
       
      {  
        Locker locker(isolate_);  
        Isolate::Scope isolate_scope(isolate_);  
        SealHandleScope outer_seal(isolate_);  
        // std::unique_ptr<Environment, FreeEnvironment> env_;  
        DeleteFnPtr<Environment, FreeEnvironment> env_;  
        // 线程执行完后执行的清除函数  
        auto cleanup_env = OnScopeLeave([&]() {  
        // ...  
        });  
      
        {  
          HandleScope handle_scope(isolate_);  
          Local<Context> context;  
          // 新建一个context，和主线程独立  
          context = NewContext(isolate_);  
          Context::Scope context_scope(context);  
          {  
            // 新建一个env并初始化，env中会和新的context关联  
            env_.reset(new Environment(data.isolate_data_.get(),  
                                       context,  
                                       std::move(argv_),  
                                       std::move(exec_argv_),  
                                       Environment::kNoFlags,  
                                       thread_id_));  
            env_->set_env_vars(std::move(env_vars_));  
            env_->set_abort_on_uncaught_exception(false);  
            env_->set_worker_context(this);  
      
            env_->InitializeLibuv(start_profiler_idle_notifier_);  
          }  
          {  
            Mutex::ScopedLock lock(mutex_);  
            // 更新子线程所属的env  
            this->env_ = env_.get();  
          }  
            
          {  
            if (!env_->RunBootstrapping().IsEmpty()) {  
              CreateEnvMessagePort(env_.get());  
              USE(StartExecution(env_.get(), "internal/main/worker_thread"));  
            }  
          }  
      
          {  
            SealHandleScope seal(isolate_);  
            bool more;  
            // 开始事件循环  
            do {  
              if (is_stopped()) break;  
              uv_run(&data.loop_, UV_RUN_DEFAULT);  
              if (is_stopped()) break;  
      
              platform_->DrainTasks(isolate_);  
      
              more = uv_loop_alive(&data.loop_);  
              if (more && !is_stopped()) continue;  
      
              EmitBeforeExit(env_.get());  
      
              more = uv_loop_alive(&data.loop_);  
            } while (more == true && !is_stopped());  
          }  
        }  
    }  
```

 我们分步骤分析上面的代码
1 新建Isolate、context和Environment，子线程在独立的环境执行。然后初始化Environment。这个在Node.js启动过程章节已经分析过，不再分析。  
2 更新子线程的env_。刚才已经分析过，Worker类中定义了env_属性，所以这里通过this.env_更新时，是不会影响基类（BaseObject）中的值的。因为子线程是在新的环境执行的，所以在新环境中使用该Worker实例时，需要使用新的环境变量。而在主线程使用该Worker实例时，是通过BaseObject的env()访问的。从而获取的是主线程的环境。因为Worker实例是在主线程和子线程之间共享的，Node.js在Worker类中重新定义了一个env_属性正是为了解决这个问题。  
3 CreateEnvMessagePort

```cpp
    void Worker::CreateEnvMessagePort(Environment* env) {  
      child_port_ = MessagePort::New(env,
                                         env->context(),  
                       std::move(child_port_data_));  
      if (child_port_ != nullptr)  
        env->set_message_port(child_port_->object(isolate_));  
    }  
```

child_port_data_这个变量刚才我们已经看到过，在这里首先申请一个新的端口。并且和child_port_data_互相关联起来。然后在env缓存起来。后续会使用。这时候的关系图如图14-4所示。  
![](https://img-blog.csdnimg.cn/04b747f85beb41048a588146806d16b4.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图14-4

4 执行internal/main/worker_thread.js

```js
    // 设置process对象  
    patchProcessObject();  
    // 获取刚才缓存的端口child_port_  
    onst port = getEnvMessagePort();  
    port.on('message', (message) => {  
      // 加载脚本  
      if (message.type === LOAD_SCRIPT) {  
        const {  
          argv,  
          cwdCounter,  
          filename,  
          doEval,  
          workerData,  
          publicPort,  
          manifestSrc,  
          manifestURL,  
          hasStdin  
        } = message;  
      
        const CJSLoader = require('internal/modules/cjs/loader');  
        loadPreloadModules();  
        /* 
         由主线程申请的MessageChannel中某一端的端口， 
         主线程传递过来的，保存用于和主线程通信 
        */  
        publicWorker.parentPort = publicPort;  
        // 执行时使用的数据  
        publicWorker.workerData = workerData;  
        // 通知主线程，正在执行脚本  
        port.postMessage({ type: UP_AND_RUNNING });  
        // 执行new Worker(filename)时传入的文件  
        CJSLoader.Module.runMain(filename);  
    })  
    // 开始接收消息  
    port.start()  
```

我们看到worker_thread.js中通过runMain完成了子线程的代码执行，然后开始事件循环。
我们看一下当事件循环结束时，Node.js的逻辑。

```cpp
    // 给主线程提交一个任务，通知主线程子线程执行完毕，因为主线程不能直接执行join阻塞自己    
    w->env()->SetImmediateThreadsafe(    
        [w = std::unique_ptr<Worker>(w)](Environment* env) {    
          if (w->has_ref_)    
            env->add_refs(-1);    
          w->JoinThread();    
          // implicitly delete w    
        });    
    }, static_cast<void*>(w)), 0);    
```

通过w->env()获取的是主线程的执行环境。我们看一下SetImmediateThreadsafe。

```cpp
    template <typename Fn>  
    void Environment::SetImmediateThreadsafe(Fn&& cb) {  
      auto callback = std::make_unique<NativeImmediateCallbackImpl<Fn>>(  
          std::move(cb), false);  
      {  
        Mutex::ScopedLock lock(native_immediates_threadsafe_mutex_);  
        native_immediates_threadsafe_.Push(std::move(callback));  
      }  
      uv_async_send(&task_queues_async_);  
    }  
```

SetImmediateThreadsafe用于通知执行环境所在的事件循环有异步任务完成。并且是线程安全的。因为可能有多个线程会操作native_immediates_threadsafe_。在主线程事件循环的Poll IO阶段就会执行task_queues_async_回调。我们看一下task_queues_async_对应的回调。

```cpp
    uv_async_init(  
         event_loop(),  
         &task_queues_async_,  
         [](uv_async_t* async) {  
           Environment* env = ContainerOf(  
               &Environment::task_queues_async_, async);  
           env->CleanupFinalizationGroups();  
           env->RunAndClearNativeImmediates();  
         });  
```

所以在Poll IO阶段执行的回调是RunAndClearNativeImmediates

```cpp
    void Environment::RunAndClearNativeImmediates(bool only_refed) {  
      TraceEventScope trace_scope(TRACING_CATEGORY_NODE1(environment),  
                                  "RunAndClearNativeImmediates", this);  
      size_t ref_count = 0;  
       
      if (native_immediates_threadsafe_.size() > 0) {  
        Mutex::ScopedLock lock(native_immediates_threadsafe_mutex_);  
        native_immediates_.ConcatMove(std::move(native_immediates_threadsafe_));  
      }  
      
      auto drain_list = [&]() {  
        TryCatchScope try_catch(this);  
        DebugSealHandleScope seal_handle_scope(isolate());  
        while (std::unique_ptr<NativeImmediateCallback> head =  
                   native_immediates_.Shift()) {  
          if (head->is_refed())  
            ref_count++;  
      
          if (head->is_refed() || !only_refed)  
            // 执行回调  
            head->Call(this);  
      
          head.reset();   
      };  
    }  
```

RunAndClearNativeImmediates会执行队列里的回调。对应Worker的JoinThread

```cpp
    void Worker::JoinThread() {  
      // 阻塞等待子线程结束，执行到这子线程已经结束了  
      CHECK_EQ(uv_thread_join(&tid_), 0);  
      thread_joined_ = true;  
      // 从主线程数据结构中删除该线程对应的实例  
      env()->remove_sub_worker_context(this);  
      
      {  
        HandleScope handle_scope(env()->isolate());  
        Context::Scope context_scope(env()->context());  
      
        // Reset the parent port as we're closing it now anyway.  
        object()->Set(env()->context(),  
                      env()->message_port_string(),  
                      Undefined(env()->isolate())).Check();  
        // 子线程退出码  
        Local<Value> args[] = {  
          Integer::New(env()->isolate(), exit_code_),  
          custom_error_ != nullptr ?  
              OneByteString(env()->isolate(), custom_error_).As<Value>() :  
              Null(env()->isolate()).As<Value>(),  
        };  
        // 执行JS层回调，触发exit事件  
        MakeCallback(env()->onexit_string(), arraysize(args), args);  
      }  
    }  
```

最后我们看一下如果结束正在执行的子线程。在JS中我能可以通过terminate函数终止线程的执行。

```cpp
    terminate(callback) {  
        this[kHandle].stopThread();  
    }  
Terminate是对C++模块stopThread的封装。
    void Worker::StopThread(const FunctionCallbackInfo<Value>& args) {  
      Worker* w;  
      ASSIGN_OR_RETURN_UNWRAP(&w, args.This());  
      w->Exit(1);  
    }  
      
    void Worker::Exit(int code) {  
      Mutex::ScopedLock lock(mutex_);  
      // env_是子线程执行的env 
      if (env_ != nullptr) {  
        exit_code_ = code;  
        Stop(env_);  
      } else {  
        stopped_ = true;  
      }  
    }  
      
      
    int Stop(Environment* env) {  
      env->ExitEnv();  
      return 0;  
    }  
      
    void Environment::ExitEnv() {  
      set_can_call_into_js(false);  
      set_stopping(true);  
      isolate_->TerminateExecution();  
      SetImmediateThreadsafe([](Environment* env) { uv_stop(env->event_loop()); });  
    }  
```

我们看到主线程最终通过SetImmediateThreadsafe给子线程所属的env提交了一个任务。子线程在Poll IO阶段会设置停止事件循环的标记，等到下一次事件循环开始的时候，就会跳出事件循环从而结束子线程的执行。
## 14.4 线程间通信
本节我们看一下线程间通信的过程。

```js
    const { Worker, isMainThread, parentPort } = require('worker_threads');  
    if (isMainThread) {  
      const worker = new Worker(__filename);  
      worker.once('message', (message) => {  
        ...  
      });  
      worker.postMessage('Hello, world!');  
    } else {  
      // 做点耗时的事情  
      parentPort.once('message', (message) => {  
        parentPort.postMessage(message);  
      });  
    }  
```

我们知道isMainThread在子线程里是false，parentPort就是messageChannel中的一端。用于和主线程通信，所以parentPort.postMessage给对端发送消息，就是给主线程发送消息，我们再看看worker.postMessage('Hello, world!')。

```js
    postMessage(...args) {  
       this[kPublicPort].postMessage(...args);  
    }  
```

kPublicPort指向的就是messageChannel的一端。this[kPublicPort].postMessage(...args)即给另一端发送消息。我们看一下postMessage的实现。

```cpp
    void MessagePort::PostMessage(const FunctionCallbackInfo<Value>& args) {  
      Environment* env = Environment::GetCurrent(args);  
      Local<Object> obj = args.This();  
      Local<Context> context = obj->CreationContext();  
      
      TransferList transfer_list;  
      if (args[1]->IsObject()) {  
        // 处理transfer_list  
      }  
      // 拿到JS层使用的对象所关联的MessagePort  
      MessagePort* port = Unwrap<MessagePort>(args.This());  
      
      port->PostMessage(env, args[0], transfer_list);  
    }  
```

我们接着看port->PostMessage

```cpp
    Maybe<bool> MessagePort::PostMessage(Environment* env,  
                                         Local<Value> message_v,  
                                         const TransferList& transfer_v) {  
      Isolate* isolate = env->isolate();  
      Local<Object> obj = object(isolate);  
      Local<Context> context = obj->CreationContext();  
      
      Message msg;  
      
      // 序列化  
      Maybe<bool> serialization_maybe =  
          msg.Serialize(env, context, message_v, transfer_v, obj);  
      // 拿到操作对端sibling的锁  
      Mutex::ScopedLock lock(*data_->sibling_mutex_);  
        
      // 把消息插入到对端队列  
      data_->sibling_->AddToIncomingQueue(std::move(msg));  
      return Just(true);  
    }  
```

PostMessage通过AddToIncomingQueue把消息插入对端的消息队列我们看一下AddToIncomingQueue

```cpp
    void MessagePortData::AddToIncomingQueue(Message&& message) {  
      // 加锁操作消息队列  
      Mutex::ScopedLock lock(mutex_);  
      incoming_messages_.emplace_back(std::move(message));  
      // 通知owner  
      if (owner_ != nullptr) {  
        owner_->TriggerAsync();  
      }  
    }  
```

插入消息队列后，如果有关联的端口，则会通知Libuv。我们继续看TriggerAsync。

```cpp
    void MessagePort::TriggerAsync() {  
      if (IsHandleClosing()) return;  
      CHECK_EQ(uv_async_send(&async_), 0);  
    }  
```

Libuv在Poll IO阶段就会执行对应的回调。回调是在new MessagePort时设置的。

```cpp
    auto onmessage = [](uv_async_t* handle) {  
      MessagePort* channel = ContainerOf(&MessagePort::async_, handle);  
      channel->OnMessage();  
    };  
    // 初始化async结构体，实现异步通信  
    CHECK_EQ(uv_async_init(env->event_loop(),  
                           &async_,  
                           onmessage), 0);  
```

我们继续看OnMessage。

```cpp
    void MessagePort::OnMessage() {  
      HandleScope handle_scope(env()->isolate());  
      Local<Context> context = object(env()->isolate())->CreationContext();  
      // 接收消息条数的阈值  
      size_t processing_limit;  
      {   
        // 加锁操作消息队列  
        Mutex::ScopedLock(data_->mutex_);  
        processing_limit = std::max(data_->incoming_messages_.size(),  
                                    static_cast<size_t>(1000));  
      }  
      while (data_) {  
        // 读取的条数达到阈值，通知Libuv下一轮Poll IO阶段继续读  
        if (processing_limit-- == 0) {  
          // 通知事件循环  
          TriggerAsync();  
          return;  
        }  
      
        HandleScope handle_scope(env()->isolate());  
        Context::Scope context_scope(context);  
      
        Local<Value> payload;  
        // 读取消息  
        if (!ReceiveMessage(context, true).ToLocal(&payload)) break;  
        // 没有了  
        if (payload == env()->no_message_symbol()) break;  
      
        Local<Object> event;  
        Local<Value> cb_args[1];  
        // 新建一个MessageEvent对象，回调onmessage事件  
        if (!env()->message_event_object_template()->NewInstance(context)  
                .ToLocal(&event) ||  
            event->Set(context, env()->data_string(), payload).IsNothing() ||  
            event->Set(context, env()->target_string(), object()).IsNothing() ||  
            (cb_args[0] = event, false) ||  
            MakeCallback(env()->onmessage_string(),  
                         arraysize(cb_args),  
                         cb_args).IsEmpty()) {  
          // 如果回调失败，通知Libuv下次继续读  
          if (data_)  
            TriggerAsync();  
          return;  
        }  
      }  
    }  
```

我们看到这里会不断地调用ReceiveMessage读取数据，然后回调JS层。直到达到阈值或者回调失败。我们看一下ReceiveMessage的逻辑。

```cpp
    MaybeLocal<Value> MessagePort::ReceiveMessage(Local<Context> context,  
                                                  bool only_if_receiving) {  
      Message received;  
      {  
        // Get the head of the message queue.  
        // 互斥访问消息队列  
        Mutex::ScopedLock lock(data_->mutex_);  
      
        bool wants_message = receiving_messages_ || !only_if_receiving;  
        // 没有消息、不需要接收消息、消息是关闭消息  
        if (data_->incoming_messages_.empty() ||  
            (!wants_message &&  
             !data_->incoming_messages_.front().IsCloseMessage())) {  
          return env()->no_message_symbol();  
        }  
        // 获取队列第一个消息  
        received = std::move(data_->incoming_messages_.front());  
        data_->incoming_messages_.pop_front();  
      }  
      // 是关闭消息则关闭端口  
      if (received.IsCloseMessage()) {  
        Close();  
        return env()->no_message_symbol();  
      }  
      
      // 反序列化后返回  
      return received.Deserialize(env(), context);  
    }  
```

ReceiveMessage会消息进行反序列化返回。以上就是线程间通信的整个过程。具体步骤如图14-5所示。  
 ![](https://img-blog.csdnimg.cn/56ef57375522428e92f3d53649fe3265.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图14-5
