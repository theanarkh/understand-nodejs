调试、诊断子线程最直接的方式就是像调试、诊断主线程一样，但是无论是动态开启还是静态开启，子线程都不可避免地需要内置一些相关的非业务代码，本文介绍另外一种对子线程代码无侵入的调试方式，另外也介绍一下通过子线程调试主线程的方式。

# 1 初始化子线程的Inspector
在Node.js启动子线程的时候，会初始化Inspector。
```cpp
env_->InitializeInspector(std::move(inspector_parent_handle_));
```
在分析InitializeInspector之前，我们先看一下inspector_parent_handle_。
```cpp
std::unique_ptr<inspector::ParentInspectorHandle> inspector_parent_handle_;
```
inspector_parent_handle_是一个ParentInspectorHandle对象，这个对象是子线程和主线程通信的桥梁。我们看一下他的初始化逻辑（在主线程里执行）。
```cpp
inspector_parent_handle_ = env->inspector_agent()->GetParentHandle(thread_id_, url);
```
调用agent的GetParentHandle获取一个ParentInspectorHandle对象。
```cpp
std::unique_ptr<ParentInspectorHandle> Agent::GetParentHandle(int thread_id, const std::string& url) {
 return client_->getWorkerManager()->NewParentHandle(thread_id, url);
}
```
内部其实是通过client_->getWorkerManager()对象的NewParentHandle方法获取ParentInspectorHandle对象，接下来我们看一下WorkerManager的NewParentHandle。
```cpp
std::unique_ptr<ParentInspectorHandle> WorkerManager::NewParentHandle(int thread_id, const std::string& url) {
  bool wait = !delegates_waiting_on_start_.empty();
  return std::make_unique<ParentInspectorHandle>(thread_id, url, thread_, wait);
}

ParentInspectorHandle::ParentInspectorHandle(
    int id, const std::string& url,
    std::shared_ptr<MainThreadHandle> parent_thread, 
    bool wait_for_connect
)
    : id_(id), 
      url_(url), 
      parent_thread_(parent_thread),
      wait_(wait_for_connect) {}
```
最终的架构图如下入所示。
![](https://img-blog.csdnimg.cn/bcd42b781c5446919df9cc16b9f04ebf.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
分析完ParentInspectorHandle后继续看一下env_->InitializeInspector(std::move(inspector_parent_handle_))的逻辑（在子线程里执行）。
```cpp
int Environment::InitializeInspector(
    std::unique_ptr<inspector::ParentInspectorHandle> parent_handle) {
  
  std::string inspector_path;
  inspector_path = parent_handle->url();
  inspector_agent_->SetParentHandle(std::move(parent_handle));
  inspector_agent_->Start(inspector_path,
                          options_->debug_options(),
                          inspector_host_port(),
                          is_main_thread());
}
```
首先把ParentInspectorHandle对象保存到agent中，然后调用agent的Start方法。
```cpp
bool Agent::Start(...) {
	// 新建client对象
   client_ = std::make_shared<NodeInspectorClient>(parent_env_, is_main);
   // 调用agent中保存的ParentInspectorHandle对象的WorkerStarted
   parent_handle_->WorkerStarted(client_->getThreadHandle(), ...);
}
```
Agent::Start创建了一个client对象，然后调用ParentInspectorHandle对象的WorkerStarted方法（刚才SetParentHandle的时候保存的），我们看一下这时候的架构图。
![](https://img-blog.csdnimg.cn/6a355ff65a934af7a728824968ea3afc.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
接着看parent_handle_->WorkerStarted。
```cpp
void ParentInspectorHandle::WorkerStarted(
    std::shared_ptr<MainThreadHandle> worker_thread, bool waiting) {
  std::unique_ptr<Request> request(
      new WorkerStartedRequest(id_, url_, worker_thread, waiting));
  parent_thread_->Post(std::move(request));
}
```
WorkerStarted创建了一个WorkerStartedRequest请求，然后通过parent_thread_->Post提交，parent_thread_是MainThreadInterface对象。
```cpp
void MainThreadInterface::Post(std::unique_ptr<Request> request) {
  Mutex::ScopedLock scoped_lock(requests_lock_);
  // 之前是空则需要唤醒消费者
  bool needs_notify = requests_.empty();
  // 消息入队
  requests_.push_back(std::move(request));
  if (needs_notify) {
  	   // 获取当前对象的一个弱引用
  	   std::weak_ptr<MainThreadInterface>* interface_ptr = new std::weak_ptr<MainThreadInterface>(shared_from_this());
  	  // 请求V8执行RequestInterrupt入参对应的回调
      isolate_->RequestInterrupt([](v8::Isolate* isolate, void* opaque) {
      	// 把执行时传入的参数转成MainThreadInterface
        std::unique_ptr<std::weak_ptr<MainThreadInterface>> interface_ptr {
          static_cast<std::weak_ptr<MainThreadInterface>*>(opaque) 
        };
        // 判断对象是否还有效，是则调用DispatchMessages
        if (auto iface = interface_ptr->lock()) iface->DispatchMessages();
        
      }, static_cast<void*>(interface_ptr));
  }
  // 唤醒消费者
  incoming_message_cond_.Broadcast(scoped_lock);
}
```
我们看看这时候的架构图。
![](https://img-blog.csdnimg.cn/58c87d7fa58d448693147af38566a4e2.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
接着看回调里执行MainThreadInterface对象DispatchMessages方法的逻辑。
```cpp
void MainThreadInterface::DispatchMessages() {
  // 遍历请求队列
  requests_.swap(dispatching_message_queue_);
  while (!dispatching_message_queue_.empty()) {
    MessageQueue::value_type task;
    std::swap(dispatching_message_queue_.front(), task);
    dispatching_message_queue_.pop_front();
	// 执行任务函数
    task->Call(this);
  }
}
```
task是WorkerStartedRequest对象，看一下Call方法的代码。
```cpp
void Call(MainThreadInterface* thread) override {
  auto manager = thread->inspector_agent()->GetWorkerManager();
  manager->WorkerStarted(id_, info_, waiting_);
}
```
接着调用agent的WorkerManager的WorkerStarted。
```cpp
void WorkerManager::WorkerStarted(int session_id,
                                  const WorkerInfo& info,
                                  bool waiting) {
  children_.emplace(session_id, info);
  for (const auto& delegate : delegates_) {
    Report(delegate.second, info, waiting);
  }
}
```
WorkerStarted记录了一个id和上下文，因为delegates_初始化的时候是空的，所以不会执行。至此，子线程Inspector初始化的逻辑就分析完了，结构图如下。
![](https://img-blog.csdnimg.cn/2e92c9a37fb145fdbe49e615e9fdd465.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
我们发现，和主线程不一样，主线程会启动一个WebSocket服务器接收客户端的连接请求，而子线程只是初始化了一些数据结构。下面我们看一下基于这些数据结构，主线程是如何动态开启调试子线程的。
# 2 主线程开启调试子线程的能力
我们可以以以下方式开启对子线程的调试。
```js
const { Worker, workerData } = require('worker_threads');
const { Session } = require('inspector');
// 新建一个新的通信通道
const session = new Session();
session.connect();
// 创建子线程
const worker = new Worker('./httpServer.js', {workerData: {port: 80}}); 
// 子线程启动成功后开启调试子线程的能力
worker.on('online', () => {
    session.post("NodeWorker.enable",
    			 {waitForDebuggerOnStart: false},  
    			 (err) => {  
    				err && console.log("NodeWorker.enable", err);
    			 });
});
// 防止主线程退出
setInterval(() => {}, 100000);
```
我们先来分析一下connect函数的逻辑。
```js
 connect() {
    this[connectionSymbol] = new Connection((message) => this[onMessageSymbol](message));
  }
```
新建了一个Connection对象并传入一个回调函数，该回调函数在收到消息时被回调。Connection是C++层导出的对象，由模版类JSBindingsConnection实现。
```cpp
template <typename ConnectionType>
class JSBindingsConnection {}
```
我们看看导出的路逻辑。
```cpp
JSBindingsConnection<Connection>::Bind(env, target);
```
接着看Bind。
```cpp
static void Bind(Environment* env, Local<Object> target) {
	// class_name是Connection
    Local<String> class_name = ConnectionType::GetClassName(env);
    Local<FunctionTemplate> tmpl = env->NewFunctionTemplate(JSBindingsConnection::New);
    tmpl->InstanceTemplate()->SetInternalFieldCount(1);
    tmpl->SetClassName(class_name);
    tmpl->Inherit(AsyncWrap::GetConstructorTemplate(env));
    env->SetProtoMethod(tmpl, "dispatch", JSBindingsConnection::Dispatch);
    env->SetProtoMethod(tmpl, "disconnect", JSBindingsConnection::Disconnect);
    target->Set(env->context(),
                class_name,
                tmpl->GetFunction(env->context()).ToLocalChecked())
        .ToChecked();
  }
```
当我们在JS层执行new Connection的时候，就会执行JSBindingsConnection::New。
```cpp
 static void New(const FunctionCallbackInfo<Value>& info) {
   Environment* env = Environment::GetCurrent(info);
   Local<Function> callback = info[0].As<Function>();
   new JSBindingsConnection(env, info.This(), callback);
 }
```
我们看看新建一个JSBindingsConnection对象时的逻辑。
```cpp
JSBindingsConnection(Environment* env,
                       Local<Object> wrap,
                       Local<Function> callback)
                       : AsyncWrap(env, wrap, PROVIDER_INSPECTORJSBINDING),
                         callback_(env->isolate(), callback) {
    Agent* inspector = env->inspector_agent();
    session_ = LocalConnection::Connect(
        inspector, std::make_unique<JSBindingsSessionDelegate>(env, this)
    );
}

static std::unique_ptr<InspectorSession> Connect(
      Agent* inspector, 
      std::unique_ptr<InspectorSessionDelegate> delegate
) {
    return inspector->Connect(std::move(delegate), false);
}
```
最终是传入了一个JSBindingsSessionDelegate对象调用Agent的Connect方法。
```cpp
std::unique_ptr<InspectorSession> Agent::Connect(
    std::unique_ptr<InspectorSessionDelegate> delegate,
    bool prevent_shutdown) {
  int session_id = client_->connectFrontend(std::move(delegate),
                                            prevent_shutdown);
  // JSBindingsConnection对象的session_字段指向的对象                                         
  return std::unique_ptr<InspectorSession>(
      new SameThreadInspectorSession(session_id, client_)
  );
}
```
Agent的Connect方法继续调用client_->connectFrontend。
```cpp
int connectFrontend(std::unique_ptr<InspectorSessionDelegate> delegate,
                      bool prevent_shutdown) {
    int session_id = next_session_id_++;
    channels_[session_id] = std::make_unique<ChannelImpl>(env_,
                                                          client_,
                                                          getWorkerManager(),
                                                          std::move(delegate),
                                                          getThreadHandle(),
                                                          prevent_shutdown);
    return session_id;
  }
```
connectFrontend新建了一个ChannelImpl对象，在新建ChannelImpl时，会初始化子线程处理的逻辑。
```cpp
 explicit ChannelImpl(Environment* env,
                       const std::unique_ptr<V8Inspector>& inspector,
                       std::shared_ptr<WorkerManager> worker_manager,
                       std::unique_ptr<InspectorSessionDelegate> delegate,
                       std::shared_ptr<MainThreadHandle> main_thread_,
                       bool prevent_shutdown)
      : delegate_(std::move(delegate)), prevent_shutdown_(prevent_shutdown),
        retaining_context_(false) {
    session_ = inspector->connect(CONTEXT_GROUP_ID, this, StringView());
    // Node.js拓展命令的处理分发器
    node_dispatcher_ = std::make_unique<protocol::UberDispatcher>(this);
    // trace相关
    tracing_agent_ = std::make_unique<protocol::TracingAgent>(env, main_thread_);
    tracing_agent_->Wire(node_dispatcher_.get());
    // 处理子线程相关
    if (worker_manager) {
      worker_agent_ = std::make_unique<protocol::WorkerAgent>(worker_manager);
      worker_agent_->Wire(node_dispatcher_.get());
    }
    // 处理runtime
    runtime_agent_ = std::make_unique<protocol::RuntimeAgent>();
    runtime_agent_->Wire(node_dispatcher_.get());
}
```
我们这里只关注处理子线程相关的逻辑。看一下 worker_agent_->Wire。
```cpp
void WorkerAgent::Wire(UberDispatcher* dispatcher) {
  frontend_.reset(new NodeWorker::Frontend(dispatcher->channel()));
  NodeWorker::Dispatcher::wire(dispatcher, this);
  auto manager = manager_.lock();
  workers_ = std::make_shared<NodeWorkers>(frontend_, manager->MainThread());
}
```
这时候的架构图如下
![](https://img-blog.csdnimg.cn/b2be97e0e6c44f69a77178e8912cccfe.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
接着看一下NodeWorker::Dispatcher::wire(dispatcher, this)的逻辑。
```cpp
void Dispatcher::wire(UberDispatcher* uber, Backend* backend)
{
    std::unique_ptr<DispatcherImpl> dispatcher(new DispatcherImpl(uber->channel(), backend));
    uber->setupRedirects(dispatcher->redirects());
    uber->registerBackend("NodeWorker", std::move(dispatcher));
}
```
首先新建了一个DispatcherImpl对象。
```cpp
DispatcherImpl(FrontendChannel* frontendChannel, Backend* backend)
        : DispatcherBase(frontendChannel)
        , m_backend(backend) {
        m_dispatchMap["NodeWorker.sendMessageToWorker"] = &DispatcherImpl::sendMessageToWorker;
        m_dispatchMap["NodeWorker.enable"] = &DispatcherImpl::enable;
        m_dispatchMap["NodeWorker.disable"] = &DispatcherImpl::disable;
        m_dispatchMap["NodeWorker.detach"] = &DispatcherImpl::detach;
    }
```
除了初始化一些字段，另外了一个kv数据结构，这个是一个路由配置，后面我们会看到它的作用。新建完DispatcherImpl后又调用了uber->registerBackend("NodeWorker", std::move(dispatcher))注册该对象。
```cpp
void UberDispatcher::registerBackend(const String& name, std::unique_ptr<protocol::DispatcherBase> dispatcher)
{
    m_dispatchers[name] = std::move(dispatcher);
}
```
这时候的架构图如下。
![](https://img-blog.csdnimg.cn/f03fc092481a48a3bb8538a2fc645340.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
我们看到这里其实是建立了一个路由体系，后面收到命令时就会根据这些路由配置进行转发，类似Node.js Express框架路由机制。这时候可以通过session的post给主线程发送NodeWorker.enable命令来开启子线程的调试。我们分析这个过程。
```js
post(method, params, callback) {
    // 忽略参数处理
    // 保存请求对应的回调
    if (callback) {
      this[messageCallbacksSymbol].set(id, callback);
    }
    // 调用C++的dispatch
    this[connectionSymbol].dispatch(JSONStringify(message));
}
```
this[connectionSymbol]对应的是JSBindingsConnection对象。
```cpp
static void Dispatch(const FunctionCallbackInfo<Value>& info) {
    Environment* env = Environment::GetCurrent(info);
    JSBindingsConnection* session;
    ASSIGN_OR_RETURN_UNWRAP(&session, info.Holder());
    if (session->session_) {
      session->session_->Dispatch(
          ToProtocolString(env->isolate(), info[0])->string());
    }
}
```
session_是一个SameThreadInspectorSession对象。
```cpp
void SameThreadInspectorSession::Dispatch(
    const v8_inspector::StringView& message) {
  auto client = client_.lock();
  client->dispatchMessageFromFrontend(session_id_, message);
}

void dispatchMessageFromFrontend(int session_id, const StringView& message) {
    channels_[session_id]->dispatchProtocolMessage(message);
}
```
最终调用了ChannelImpl的dispatchProtocolMessage。
```cpp
void dispatchProtocolMessage(const StringView& message) {
    std::string raw_message = protocol::StringUtil::StringViewToUtf8(message);
    std::unique_ptr<protocol::DictionaryValue> value =
        protocol::DictionaryValue::cast(protocol::StringUtil::parseMessage(
            raw_message, false));
    int call_id;
    std::string method;
    // 解析命令
    node_dispatcher_->parseCommand(value.get(), &call_id, &method);
    // 判断命令是V8内置命令还是Node.js拓展的命令
    if (v8_inspector::V8InspectorSession::canDispatchMethod(
            Utf8ToStringView(method)->string())) {
      session_->dispatchProtocolMessage(message);
    } else {
      node_dispatcher_->dispatch(call_id, method, std::move(value),
                                 raw_message);
    }
  }
```
因为NodeWorker.enable是Node.js拓展的命令，所以会走到else里面的逻辑。根据路由配置找到该命令对应的处理逻辑（NodeWorker.enable以.切分，对应两级路由）。
```cpp
void UberDispatcher::dispatch(int callId, const String& in_method, std::unique_ptr<Value> parsedMessage, const ProtocolMessage& rawMessage)
{
    // 找到一级路由配置
    protocol::DispatcherBase* dispatcher = findDispatcher(method);
    std::unique_ptr<protocol::DictionaryValue> messageObject = DictionaryValue::cast(std::move(parsedMessage));
    // 交给一级路由处理器处理
    dispatcher->dispatch(callId, method, rawMessage, std::move(messageObject));
}
```
NodeWorker.enable对应的路由处理器代码如下
```cpp
void DispatcherImpl::dispatch(int callId, const String& method, const ProtocolMessage& message, std::unique_ptr<protocol::DictionaryValue> messageObject)
{
	// 查找二级路由
    std::unordered_map<String, CallHandler>::iterator it = m_dispatchMap.find(method);
    protocol::ErrorSupport errors;
    // 找到处理函数
    (this->*(it->second))(callId, method, message, std::move(messageObject), &errors);
}
```
dispatch继续寻找命令对应的处理函数，最终找到NodeWorker.enable命令的处理函数为DispatcherImpl::enable。
```cpp
void DispatcherImpl::enable(...)
{
    std::unique_ptr<DispatcherBase::WeakPtr> weak = weakPtr();
    DispatchResponse response = m_backend->enable(...);
    // 返回响应给命令（类似请求/响应模式）
    weak->get()->sendResponse(callId, response);
}
```
根据架构图可以知道m_backend是WorkerAgent对象。
```cpp
DispatchResponse WorkerAgent::enable(bool waitForDebuggerOnStart) {
  auto manager = manager_.lock();
  std::unique_ptr<AgentWorkerInspectorDelegate> delegate(new AgentWorkerInspectorDelegate(workers_));
  event_handle_ = manager->SetAutoAttach(std::move(delegate));
  return DispatchResponse::OK();
}
```
继续调用WorkerManager的SetAutoAttach方法。
```cpp
std::unique_ptr<WorkerManagerEventHandle> WorkerManager::SetAutoAttach(
    std::unique_ptr<WorkerDelegate> attach_delegate) {
  int id = ++next_delegate_id_;
  // 保存delegate
  delegates_[id] = std::move(attach_delegate);
  const auto& delegate = delegates_[id];
  // 通知子线程
  for (const auto& worker : children_) {
    Report(delegate, worker.second, false);
  }
  ...
}
```
SetAutoAttach遍历子线程。
```cpp
void Report(const std::unique_ptr<WorkerDelegate>& delegate,
            const WorkerInfo& info, bool waiting) {
  if (info.worker_thread)
    delegate->WorkerCreated(info.title, info.url, waiting, info.worker_thread);
}
```
info是一个WorkerInfo对象，该对象是子线程初始化和主线程建立关系的数据结构。delegate是AgentWorkerInspectorDelegate对象。
```cpp
void WorkerCreated(const std::string& title,
                     const std::string& url,
                     bool waiting,
                     std::shared_ptr<MainThreadHandle> target) override {
    workers_->WorkerCreated(title, url, waiting, target);
}
```
workers_是一个NodeWorkers对象。
```cpp
void NodeWorkers::WorkerCreated(const std::string& title,
                                const std::string& url,
                                bool waiting,
                                std::shared_ptr<MainThreadHandle> target) {
  auto frontend = frontend_.lock();
  std::string id = std::to_string(++next_target_id_);
  // 处理数据通信的delegate
  auto delegate = thread_->MakeDelegateThreadSafe(
      std::unique_ptr<InspectorSessionDelegate>(
          new ParentInspectorSessionDelegate(id, shared_from_this())
      )
  );
  // 建立和子线程V8 Inspector的通信通道
  sessions_[id] = target->Connect(std::move(delegate), true);
  frontend->attachedToWorker(id, WorkerInfo(id, title, url), waiting);
}
```
WorkerCreated建立了一条和子线程通信的通道，然后通知命令的发送方通道建立成功。这时候架构图如下。
![](https://img-blog.csdnimg.cn/3ecfcb9115a64a119fc0677ee7c159e9.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
接着看attachedToWorker。
```cpp
void Frontend::attachedToWorker(const String& sessionId, std::unique_ptr<protocol::NodeWorker::WorkerInfo> workerInfo, bool waitingForDebugger)
{
    std::unique_ptr<AttachedToWorkerNotification> messageData = AttachedToWorkerNotification::create()
        .setSessionId(sessionId)
        .setWorkerInfo(std::move(workerInfo))
        .setWaitingForDebugger(waitingForDebugger)
        .build();
    // 触发NodeWorker.attachedToWorker
    m_frontendChannel->sendProtocolNotification(InternalResponse::createNotification("NodeWorker.attachedToWorker", std::move(messageData)));
}
```
继续看sendProtocolNotification
```cpp
 void sendProtocolNotification(
      std::unique_ptr<Serializable> message) override {
    sendMessageToFrontend(message->serializeToJSON());
 }
  
 void sendMessageToFrontend(const StringView& message) {
    delegate_->SendMessageToFrontend(message);
 }
```
这里的delegate_是一个JSBindingsSessionDelegate对象。
```cpp
   void SendMessageToFrontend(const v8_inspector::StringView& message)
        override {
      Isolate* isolate = env_->isolate();
      HandleScope handle_scope(isolate);
      Context::Scope context_scope(env_->context());
      MaybeLocal<String> v8string = String::NewFromTwoByte(isolate,
			                                   message.characters16(),
			                                   NewStringType::kNormal, message.length()
      );
      Local<Value> argument = v8string.ToLocalChecked().As<Value>();
      // 收到消息执行回调
      connection_->OnMessage(argument);
}
// 执行JS层回调
void OnMessage(Local<Value> value) {
   MakeCallback(callback_.Get(env()->isolate()), 1, &value);
}
```
JS层回调逻辑如下。
```js
[onMessageSymbol](message) {
    const parsed = JSONParse(message);
    // 收到的消息如果是某个请求的响应，则有个id字段记录了请求对应的id，否则则触发事件
    if (parsed.id) {
       const callback = this[messageCallbacksSymbol].get(parsed.id);
       this[messageCallbacksSymbol].delete(parsed.id);
       if (callback) {
         callback(null, parsed.result);
       }
     } else {
       this.emit(parsed.method, parsed);
       this.emit('inspectorNotification', parsed);
     }
  }
```
主线程拿到Worker Session对一个的id，后续就可以通过命令NodeWorker.sendMessageToWorker加上该id和子线程通信。大致原理如下，主线程通过自己的channel和子线程的channel进行通信，从而达到控制子线程的目的。
![](https://img-blog.csdnimg.cn/658f975ad0664dc1b08b7a59d30db786.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
我们分析一下NodeWorker.sendMessageToWorker命令的逻辑，对应处理函数为DispatcherImpl::sendMessageToWorker。
```cpp
void DispatcherImpl::sendMessageToWorker(...)
{
    std::unique_ptr<DispatcherBase::WeakPtr> weak = weakPtr();
    DispatchResponse response = m_backend->sendMessageToWorker(in_message, in_sessionId);
    // 响应
    weak->get()->sendResponse(callId, response);
    return;
}

```
继续分析m_backend->sendMessageToWorker。
```cpp
DispatchResponse WorkerAgent::sendMessageToWorker(const String& message,
                                                  const String& sessionId) {
  workers_->Receive(sessionId, message);
  return DispatchResponse::OK();
}

void NodeWorkers::Receive(const std::string& id, const std::string& message) {
  auto it = sessions_.find(id);
  it->second->Dispatch(Utf8ToStringView(message)->string());
}
```
sessions_对应的是和子线程的通信的数据结构CrossThreadInspectorSession。看一下该对象的Dispatch方法。
```cpp
void Dispatch(const StringView& message) override {
    state_.Call(&MainThreadSessionState::Dispatch,
                StringBuffer::create(message));
}
```
再次调了MainThreadSessionState::Dispatch

```cpp
void Dispatch(std::unique_ptr<StringBuffer> message) {
    session_->Dispatch(message->string());
}
```
session_是SameThreadInspectorSession对象。继续看它的Dispatch方法。

```cpp
void SameThreadInspectorSession::Dispatch(
    const v8_inspector::StringView& message) {
  auto client = client_.lock();
  client->dispatchMessageFromFrontend(session_id_, message);
}

void dispatchMessageFromFrontend(int session_id, const StringView& message) {
    channels_[session_id]->dispatchProtocolMessage(message);
}
```
通过层层调用，最终拿到了一个合子线程通信的channel，dispatchProtocolMessage方法刚才已经分析过，该方法会根据命令做不同的处理，因为我们这里发送的是V8内置的命令，所以会交给V8 Inspector处理。当V8 Inspector处理完后，会通过ChannelImpl的sendResponse返回结果。
```cpp
void sendResponse(
      int callId,
      std::unique_ptr<v8_inspector::StringBuffer> message) override {
    sendMessageToFrontend(message->string());
}

 void sendMessageToFrontend(const StringView& message) {
    delegate_->SendMessageToFrontend(message);
  }
```
这里的delegate_是ParentInspectorSessionDelegate对象。
```c
void SendMessageToFrontend(const v8_inspector::StringView& msg) override {
  std::string message = protocol::StringUtil::StringViewToUtf8(msg);
  workers_->Send(id_, message);
}

void NodeWorkers::Send(const std::string& id, const std::string& message) {
  auto frontend = frontend_.lock();
  if (frontend)
    frontend->receivedMessageFromWorker(id, message);
}

void Frontend::receivedMessageFromWorker(const String& sessionId, const String& message)
{
    std::unique_ptr<ReceivedMessageFromWorkerNotification> messageData = ReceivedMessageFromWorkerNotification::create()
        .setSessionId(sessionId)
        .setMessage(message)
        .build();
 // 触发NodeWorker.receivedMessageFromWorker       
    m_frontendChannel->sendProtocolNotification(InternalResponse::createNotification("NodeWorker.receivedMessageFromWorker", std::move(messageData)));
}
```
m_frontendChannel是主线程的ChannelImpl对象。
```cpp
void sendProtocolNotification(
    std::unique_ptr<Serializable> message) override {
    sendMessageToFrontend(message->serializeToJSON());
}
  
void sendMessageToFrontend(const StringView& message) {
    delegate_->SendMessageToFrontend(message);
}
```
delegate_是C++层传入的JSBindingsSessionDelegate对象。最终通过JSBindingsSessionDelegate对象回调JS层，之前已经分析过就不再赘述。至此，主线程就具备了控制子线程的能力，但是控制方式有很多种。

## 2.1 使用通用的V8命令
通过下面代码收集子线程的CPU Profile信息。
```js
const { Worker, workerData } = require('worker_threads');
const { Session } = require('inspector');
const session = new Session();
session.connect();
let id = 1;
function post(sessionId, method, params, callback) {
    session.post('NodeWorker.sendMessageToWorker', {
        sessionId,
        message: JSON.stringify({ id: id++, method, params })
    }, callback);
}
session.on('NodeWorker.attachedToWorker', (data) => {
	post(data.params.sessionId, 'Profiler.enable');
    post(data.params.sessionId, 'Profiler.start');
    // 收集一段时间后提交停止收集命令
    setTimeout(() => {
        post(data.params.sessionId, 'Profiler.stop');
    }, 10000)
});
session.on('NodeWorker.receivedMessageFromWorker', ({ params: { message }}) => { 
    const data = JSON.parse(message);
    console.log(data);
});

const worker = new Worker('./httpServer.js', {workerData: {port: 80}}); 
worker.on('online', () => {
    session.post("NodeWorker.enable",{waitForDebuggerOnStart: false},  (err) => {  console.log(err, "NodeWorker.enable");});
});
setInterval(() => {}, 100000);
```
通过这种方式可以通过命令控制子线程的调试和数据收集。
## 2.2 在子线程中动态执行脚本
可以通过执行脚本开启子线程的WebSocket服务，像调试主线程一样。
```js
const { Worker, workerData } = require('worker_threads');
const { Session } = require('inspector');
const session = new Session();
session.connect();
let workerSessionId;
let id = 1;
function post(method, params) {
    session.post('NodeWorker.sendMessageToWorker', {
        sessionId: workerSessionId,
        message: JSON.stringify({ id: id++, method, params })
    });
}
session.on('NodeWorker.receivedMessageFromWorker', ({ params: { message }}) => { 
    const data = JSON.parse(message);
    console.log(data);
});

session.on('NodeWorker.attachedToWorker', (data) => {
    workerSessionId = data.params.sessionId;
    post("Runtime.evaluate", {
        includeCommandLineAPI: true, 
        expression: `const inspector = process.binding('inspector');
                    inspector.open();
                    inspector.url();
                    `
        } 
    );
});

const worker = new Worker('./httpServer.js', {workerData: {port: 80}}); 
worker.on('online', () => {
    session.post("NodeWorker.enable",{waitForDebuggerOnStart: false},  (err) => {  err && console.log("NodeWorker.enable", err);});
});

setInterval(() => {}, 100000);
```
执行上面的代码就拿到以下输出
```js
{
  id: 1,
  result: {
    result: {
      type: 'string',
      value: 'ws://127.0.0.1:9229/c0ca16c8-55aa-4651-9776-fca1b27fc718'
    }
  }
}
```
通过该地址，客户端就可以对子线程进行调试了。上面代码里使用process.binding而不是require加载inspector，因为刚才通过NodeWorker.enable命令为子线程创建了一个到子线程Inspector的channel，而JS模块里判断如果channel非空则报错Inspector已经打开。所以这里需要绕过这个限制，直接加载C++模块开启WebSocket服务器。
# 3 子线程调试主线程
不仅可以通过主线程调试子线程，还可以通过子线程调试主线程。Node.js在子线程暴露了connectToMainThread方法连接到主线程的Inspector（只能在work_threads中使用），实现的原理和之前分析的类似，主要是子线程连接到主线程的V8 Inspector，通过和该Inspector完成对主线程的控制。看下面一个例子。
主线程代码
```js
const { Worker, workerData } = require('worker_threads');
const http = require('http');

const worker = new Worker('./worker.js', {workerData: {port: 80}});

http.createServer((_, res) => {
    res.end('main');
}).listen(8000);
```
worker.js代码如下
```js
const fs = require('fs');
const { workerData: { port } } = require('worker_threads');
const { Session } = require('inspector');
const session = new Session();
session.connectToMainThread();
session.post('Profiler.enable');
session.post('Profiler.start');
setTimeout(() => {
    session.post('Profiler.stop', (err, data) => {
        if (data.profile) {
            fs.writeFileSync('./profile.cpuprofile', JSON.stringify(data.profile));
        }
    });
}, 5000)
```
