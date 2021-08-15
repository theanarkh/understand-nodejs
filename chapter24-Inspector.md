**前言：Node.js提供的Inspector不仅可以用来调试Node.js代码，还可以实时收集Node.js进程的内存，CPU等数据，同时支持静态、动态开启，是一个非常强大的工具，本文从使用和原理详细讲解Inspector**

Node.js的文档中对inspector的描述很少，但是如果深入探索，其实里面的内容还是挺多的。我们先看一下Inspector的使用。
# 1 Inspector的使用
## 1.1 本地调试
我们先从一个例子开始。下面是一个http服务器。
```c
const http = require('http');
http.createServer((req, res) => {
    res.end('ok');
}).listen(80);
```
然后我们以node --inspect httpServer.js的方式启动。我们可以看到以下输出。
```c
Debugger listening on ws://127.0.0.1:9229/fbbd9d8f-e088-48cc-b1e0-e16bfe58db44
For help, see: https://nodejs.org/en/docs/inspector
```
9229端口是Node.js默认选择的端口，当然我们也可以自定义，具体可参考文档。这时候我们去浏览器打开开发者工具，菜单栏多了一个调试Node.js的按钮。  
![](https://img-blog.csdnimg.cn/a3aa0f6cf82948d78fe879132f356541.png)  
点击这个按钮。我们可以看到以下界面。  
![](https://img-blog.csdnimg.cn/ee5c29e6a5214a6baef45978971c98cc.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
我们可以选择某一行代码打断点，比如我在第三行，这时候我们访问80端口，开发者工具就会停留在断点处。这时候我们可以看到一些执行上下文。  
![](https://img-blog.csdnimg.cn/4fcb62b0906346ddbc507f97478ad54e.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
## 1.2 远程调试
但很多时候我们可能需要远程调试。比如我在一台云服务器上部署以上服务器代码。然后执行
```c
node --inspect=0.0.0.0:8888 httpServer.js 
```
不过这时候我们打开开发者工具就会发现按钮置灰或者找不到我们远程服务器的信息。这时候我们需要用另一种方式。通过在浏览器url输入框输入devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws={host}:{port}/{path}的方式（替换{}里面的内容为你执行Node.js时输出的信息），浏览器就会去连接你输入的地址，比如1.1.1.1:9229/abc。这种比较适合于对于通用的场景。
## 1.3 自动探测
如果是我们自己调试的话，这种方式看起来就有点麻烦，我们可以使用浏览器提供的自动探测功能。  
1 url输入框输入chrome://inspect/#devices我们会看到以下界面  
![](https://img-blog.csdnimg.cn/c28b13111617457ab607fac072ae5764.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
2 点击configure按钮，在弹出的弹框里输入你远程服务器的地址  
![](https://img-blog.csdnimg.cn/cd4fa92ba2b149f6a3bdfecd8178e9d9.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
3 配置完毕后，我们会看到界面变成这样了，或者打开新的tab，我们看到开发者工具的调试按钮也变亮了。  
![](https://img-blog.csdnimg.cn/d5a4588a38804398ab5fc2d4dce631b7.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
4 这时候我们点击inspect按钮、Open dedicated DevTools for Node按钮或者打开新tab的开发者工具，就可以开始调试。而且还可以调试Node.js的原生js模块。  
![](https://img-blog.csdnimg.cn/5e53c295f9cc43629c68fa8f085c8533.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
![](https://img-blog.csdnimg.cn/6eaf33a029f44965a14d735b5829cb01.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
# 2 Inspector调试的原理
下面以通过url的方式调试（可以看到network），来看看调试的时候都发生了什么，浏览器和远程服务器建立连接后，是通过websocket协议通信的。  
![](https://img-blog.csdnimg.cn/11a497acf12446dbb0e10207601e6156.png)  
我们看一下这命令是什么意思，首先看Debugger.scriptParsed。
> Debugger.scriptParsed #
Fired when virtual machine parses script. This event is also fired for all known and uncollected scripts upon enabling debugger.

从说明中我们看到，当V8解析脚本的时候就会触发这个事件，那就会告诉浏览器这个信息。  
![](https://img-blog.csdnimg.cn/efa33802109846adba1979453cd4c7af.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
我们发现返回的都是一些元数据，没有脚本的具体代码内容，这时候浏览器会再次发起请求，  
![](https://img-blog.csdnimg.cn/6bc75a477f744831a9f5a2f0d4711164.png)  
我们看到这个脚本的scriptId是103。所以请求里带了这个scriptId。对应的请求id是11。接着看一下响应。  
![](https://img-blog.csdnimg.cn/a37cb981f27b4b4ba80146bf11fb993c.png)  
至此，我们了解了获取脚本内容的过程，然后我们看看调试的时候是怎样的过程。当我们在浏览器上点击某一行设置断点的时候，浏览器就会发送一个请求。  
![](https://img-blog.csdnimg.cn/be2f40f975a14e1db47095d462ec4f48.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
这个命令的意义顾名思义，我们看一下具体定义。

> Debugger.setBreakpointByUrl #
Sets JavaScript breakpoint at given location specified either by URL or URL regex. Once this command is issued, all existing parsed scripts will have breakpoints resolved and returned in locations property. Further matching script parsing will result in subsequent breakpointResolved events issued. This logical breakpoint will survive page reloads.

接着服务返回响应。  
![](https://img-blog.csdnimg.cn/194ff0ee9e0d42f69058bc3a280f67f9.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
这时候我们从另外一个tab访问80端口。服务器就会在我们设置的断点处停留，并且通知浏览器。  
![](https://img-blog.csdnimg.cn/2723627cae1c407e93d57f800f21c2e9.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
我们看一下这个命令的意思。  
![](https://img-blog.csdnimg.cn/ba3558f0d6bb4ee6aa03252bfa4c5065.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
这个命令就是当服务器执行到断点时通知浏览器，并且返回执行的一些上下文，比如是哪个执行到哪个断点停留了。这时候浏览器侧也会停留在对应的地方，当我们hover某个变量时，就会看到对应的上下文。这些都是通过具体的命令获取的数据。就不一一分析了，可以参考具体文档。  
![](https://img-blog.csdnimg.cn/9272c43a84c940bd862f9c8279af6026.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
# 3 Inspector的实现
大致了解了浏览器和服务器的交互过程和协议后，我们再来深入了解一下关于inspector的一些实现。当然这里不是分析V8中Inspector的实现，而是分析如何使用V8的Inspector以及Node.js中关于Inspector的实现部分。
## 3.1 开源实现
因为Node.js的实现比较复杂，这里先以一个简单版的调试工具源码来分析inspector的原理。我们先看一下初始化代码。
```c
inspector = std::unique_ptr<Inspector>(new Inspector(v8Platform, context, port));
inspector->startAgent();
```
首先新建一个Inspector。然后启动它。接下来看看Inspector里的逻辑。
```c
Inspector::Inspector(
        const std::unique_ptr<v8::Platform> &platform,
        const v8::Local<v8::Context> &context,
        const int webSocketPort) {
        
    context_ = context;
    // 新建一个websocket server用于和客户端通信
    websocket_server_ = std::unique_ptr<WebSocketServer>(
            new WebSocketServer(
                    webSocketPort,
                    // 收到客户的的消息后执行onMessage回调
                    std::bind(&Inspector::onMessage, this, std::placeholders::_1)
                )
            );
    // 新建一个inspector client和V8通信
    inspector_client_ = std::unique_ptr<V8InspectorClientImpl>(
            new V8InspectorClientImpl(
                    platform,
                    context_,
                    // 收到V8的消息后调用sendMessage回复给客户的
                    std::bind(&Inspector::sendMessage, this, std::placeholders::_1),
                    std::bind(&Inspector::waitForFrontendMessage, this)
                )
            );
}
```
代码看起来很复杂，不过我们不需要深究。主要是两个部分，一个是新建一个websocket服务器，一个是新建一个inspector客户端（用于和V8 Inspector通信），整体架构如下。  
![](https://img-blog.csdnimg.cn/32d794aae6754010a953223530043d8e.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
接下来分别看一下websocket服务器和inspector客户端的实现。首先看一下websocket服务器的构造函数。
```c
WebSocketServer::WebSocketServer(int port, std::function<void(std::string)> onMessage)
{
    port_ = port;
    onMessage_ = std::move(onMessage);
}
```
WebSocketServer构造函数的实现很简单，只是初始化一些字段。接着看inspector客户端的实现。
```c
V8InspectorClientImpl:: V8InspectorClientImpl(const std::unique_ptr<v8::Platform> &platform, const v8::Local<v8::Context> &context, const std::function<void(std::string)> &onResponse, const std::function<int(void)> &onWaitFrontendMessageOnPause) {

    platform_ = platform.get();
    context_ = context;
    onWaitFrontendMessageOnPause_ = onWaitFrontendMessageOnPause;
    isolate_ = context_->GetIsolate();
    // 创建一个channel和inspector通信，收到V8消息时会执行onResponse
    channel_.reset(new V8InspectorChannelImp(isolate_, onResponse));
    // 新建一个V8提供的inspector
    inspector_ = v8_inspector::V8Inspector::create(isolate_, this);
    // 创建一个和inspector通信的session。
    session_ = inspector_->connect(kContextGroupId, channel_.get(), v8_inspector::StringView());
    context_->SetAlignedPointerInEmbedderData(1, this);
    v8_inspector::StringView contextName = convertToStringView("inspector");
    inspector_->contextCreated(v8_inspector::V8ContextInfo(context, kContextGroupId, contextName));
    terminated_ = true;
    run_nested_loop_ = false;
}
```
上面代码很多，主要是根据V8提供的API来就行。这里主要有三个概念  
1 V8Inspector是V8提供的类。  
2 session表示和V8 inspector通信的会话。  
3 channel用于和V8 inspector通信，从API来看，channel只能从V8获取数据，写入数据是另外的API。  
这时候的架构如下  
![](https://img-blog.csdnimg.cn/f33f37f845c744d8bf0b4a86d245c3be.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
至此，websocket服务器和inspector客户端就分析完毕了，回到最开始的代码，初始化完毕后会执行startAgent。
```c
void Inspector::startAgent() {
    websocket_server_->run();
}
// 启动websocket服务器
void WebSocketServer::run() {
    auto const address = net::ip::make_address("127.0.0.1");
    net::io_context ioc{1};
    tcp::acceptor acceptor{ioc, {address, static_cast<unsigned short>(port_)}};
    tcp::socket socket{ioc};
    acceptor.accept(socket);
    ws_ = std::unique_ptr<websocket::stream<tcp::socket>>(new websocket::stream<tcp::socket>(std::move(socket)));
    startListening();
}
// 等待连接
void WebSocketServer::startListening()
{
   ws_->accept();
   while (true) {
       waitFrontendMessage();
   }
}
// 读取连接中的消息
void WebSocketServer::waitFrontendMessage()
{
    beast::flat_buffer buffer;
    ws_->read(buffer);
    std::string message = boost::beast::buffers_to_string(buffer.data());
    onMessage_(std::move(message));
}
```
startAgent的逻辑就是启动websocket服务器。启动完毕后就等待客户的连接。连接成功后执行onMessage_。我们看一下onMessage的实现。
```c
void Inspector::onMessage(const std::string& message) {
    std::cout << "CDT message: " << message << std::endl;
    // StringView是V8要求的格式
    v8_inspector::StringView protocolMessage = convertToStringView(message);
    // 通知V8 Inspector
    inspector_client_->dispatchProtocolMessage(protocolMessage);
}
```
onMessage通过Inspector客户端把消息交给V8 Inspector处理。V8 Inspector处理完后，通过channel通知Inspector客户端，对应的函数是sendResponse。V8InspectorChannelImp是继承V8提供的Channel，sendResponse是一个纯虚函数，由V8InspectorChannelImp实现。
```c
void V8InspectorChannelImp::sendResponse(int callId, std::unique_ptr<v8_inspector::StringBuffer> message) {
    const std::string response = convertToString(isolate_, message->string());
    onResponse_(response);
}
```
onResponse_是在Chnnel初始化时设置的，对应函数是inspector客户端的sendMessage。
```c
void Inspector::sendMessage(const std::string& message) {
    websocket_server_->sendMessage(message);
}
```
sendMessage通过websocket服务器把V8 Inspector返回的消息返回给客户的。至此，整个通信流程就完成了。

## 3.2 Node.js的实现(v14)
Node.js的实现非常复杂并且很绕，也无法通俗易懂地介绍和分析，只能按照我自己的思路大致讲解一下流程，有兴趣的同学可以自行阅读源码。当我们以以下方式执行我们的应用时
```c
node --inspect app.js
```
### 3.2.1 初始化
Node.js在启动的过程中，就会初始化Inspector相关的逻辑。
```c
inspector_agent_ = std::make_unique<inspector::Agent>(this);
```
Agent是负责和V8 Inspector通信的对象。创建完后接着执行env->InitializeInspector({})启动Agent。
```c
inspector_agent_->Start(...);
```
Start继续执行Agent::StartIoThread。
```c
bool Agent::StartIoThread() {
  io_ = InspectorIo::Start(client_->getThreadHandle(), ...);
  return true;
}
```
StartIoThread中的client_->getThreadHandle()是重要的逻辑，我们先来分析该函数。
```c
  std::shared_ptr<MainThreadHandle> getThreadHandle() {
    if (!interface_) {
      interface_ = std::make_shared<MainThreadInterface>(env_->inspector_agent(), ...);
    }
    return interface_->GetHandle();
  }
```
getThreadHandle首先创建来一个MainThreadInterface对象，接着又调用了他的GetHandle方法，我们看一下该方法的逻辑。
```c
std::shared_ptr<MainThreadHandle> MainThreadInterface::GetHandle() {
  if (handle_ == nullptr)
    handle_ = std::make_shared<MainThreadHandle>(this);
  return handle_;
}
```
GetHandlei了创建了一个MainThreadHandle对象，最终结构如下所示。  
![](https://img-blog.csdnimg.cn/2db9591e808048029abcffde4ecfc591.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
分析完后我们继续看Agent::StartIoThread中InspectorIo::Start的逻辑。

```c
std::unique_ptr<InspectorIo> InspectorIo::Start(std::shared_ptr<MainThreadHandle> main_thread, ...) {
  auto io = std::unique_ptr<InspectorIo>(new InspectorIo(main_thread, ...));
  return io;
}
```
InspectorIo::Star里新建了一个InspectorIo对象，我们看看InspectorIo构造函数的逻辑。

```c
InspectorIo::InspectorIo(std::shared_ptr<MainThreadHandle> main_thread, ...)
    : 
    // 初始化main_thread_
    main_thread_(main_thread)) {
  // 新建一个子线程，子线程中执行InspectorIo::ThreadMain
  uv_thread_create(&thread_, InspectorIo::ThreadMain, this);
}
```
这时候结构如下。  
![](https://img-blog.csdnimg.cn/c0fbe74e8a164f028ea3848194d256df.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
Inspector在子线程里启动的原因主要有两个。  
1 如果在主线程里运行，那么当我们断点调试的时候，Node.js主线程就会被停住，也就无法处理客户端发过来的调试指令。  
2 如果主线程陷入死循环，我们就无法实时抓取进程的profile数据来分析原因。  
接着继续看一下子线程里执行InspectorIo::ThreadMain的逻辑。

```c
void InspectorIo::ThreadMain(void* io) {
  static_cast<InspectorIo*>(io)->ThreadMain();
}

void InspectorIo::ThreadMain() {
  uv_loop_t loop;
  loop.data = nullptr;
  // 在子线程开启一个新的事件循环
  int err = uv_loop_init(&loop);
  std::shared_ptr<RequestQueueData> queue(new RequestQueueData(&loop), ...);
  // 新建一个delegate，用于处理请求
  std::unique_ptr<InspectorIoDelegate> delegate(
  	new InspectorIoDelegate(queue, main_thread_, ...)
  );
  InspectorSocketServer server(std::move(delegate), ...);
  server.Start()
  uv_run(&loop, UV_RUN_DEFAULT);
}
```
ThreadMain里主要三个逻辑  
1 创建一个delegate对象，该对象是核心的对象，后面我们会看到有什么作用。  
2 创建一个服务器并启动。  
3 开启事件循环。  
接下来看一下服务器的逻辑，首先看一下创建服务器的逻辑。
```c
InspectorSocketServer::InspectorSocketServer(std::unique_ptr<SocketServerDelegate> delegate, ...)
    : 
      // 保存delegate
      delegate_(std::move(delegate)),
      // 初始化sessionId
      next_session_id_(0) {
  // 设置delegate的server为当前服务器
  delegate_->AssignServer(this);
}
```
执行完后形成以下结构。  
![](https://img-blog.csdnimg.cn/36f2215207b642ae89f52e445717b8de.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
接着我们看启动服务器的逻辑。
```c
bool InspectorSocketServer::Start() {
  // DNS解析,比如输入的是localhost
  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_flags = AI_NUMERICSERV;
  hints.ai_socktype = SOCK_STREAM;
  uv_getaddrinfo_t req;
  const std::string port_string = std::to_string(port_);
  uv_getaddrinfo(loop_, &req, nullptr, host_.c_str(),
                           port_string.c_str(), &hints);
  // 监听解析到的ip列表                 
  for (addrinfo* address = req.addrinfo; 
  	   address != nullptr;
       address = address->ai_next) {
       
    auto server_socket = ServerSocketPtr(new ServerSocket(this));
    err = server_socket->Listen(address->ai_addr, loop_);
    if (err == 0)
      server_sockets_.push_back(std::move(server_socket));
      
  }

  return true;
}
```
首先根据参数做一个DNS解析，然后根据拿到的ip列表（通常是一个），创建对应个数的ServerSocket对象，并执行他的Listen方法。ServerSocket表示一个监听socket。看一下ServerSocket的构造函数。
```c
ServerSocket(InspectorSocketServer* server)
            : tcp_socket_(uv_tcp_t()), server_(server) {}
```
执行完后结构如下。  
![](https://img-blog.csdnimg.cn/085c4f5baa7e4c73a22951893c81f4c6.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
接着看一下ServerSocket的Listen方法。

```c
int ServerSocket::Listen(sockaddr* addr, uv_loop_t* loop) {
  uv_tcp_t* server = &tcp_socket_;
  uv_tcp_init(loop, server)
  uv_tcp_bind(server, addr, 0);
  uv_listen(reinterpret_cast<uv_stream_t*>(server), 
  					511,
                    ServerSocket::SocketConnectedCallback);
}
```
Listen调用Libuv的接口完成服务器的启动。至此，Inspector提供的Weboscket服务器启动了。
### 3.2.2 处理连接
从刚才分析中可以看到，当有连接到来时执行回调ServerSocket::SocketConnectedCallback。
```c
void ServerSocket::SocketConnectedCallback(uv_stream_t* tcp_socket,
                                           int status) {
  if (status == 0) {
    // 根据Libuv handle找到对应的ServerSocket对象
    ServerSocket* server_socket = ServerSocket::FromTcpSocket(tcp_socket);
    // Socket对象的server_字段保存了所在的InspectorSocketServer
    server_socket->server_->Accept(server_socket->port_, tcp_socket);
  }
}
```
接着看InspectorSocketServer的Accept是如何处理连接的。
```c
void InspectorSocketServer::Accept(int server_port,
                                   uv_stream_t* server_socket) {
                                   
  std::unique_ptr<SocketSession> session(
      new SocketSession(this, next_session_id_++, server_port)
  );

  InspectorSocket::DelegatePointer delegate =
      InspectorSocket::DelegatePointer(
          new SocketSession::Delegate(this, session->id())
      );

  InspectorSocket::Pointer inspector =
      InspectorSocket::Accept(server_socket, std::move(delegate));
      
  if (inspector) {
    session->Own(std::move(inspector));
    connected_sessions_[session->id()].second = std::move(session);
  }
}
```
Accept的首先创建里一个SocketSession和SocketSession::Delegate对象。然后调用InspectorSocket::Accept，从代码中可以看到InspectorSocket::Accept会返回一个InspectorSocket对象。InspectorSocket是对通信socket的封装（和客户端通信的socket，区别于服务器的监听socket）。然后记录session对象对应的InspectorSocket对象，同时记录sessionId和session的映射关系。结构如下图所示。  
![](https://img-blog.csdnimg.cn/5b5137ecb7284b78959388fced80e0e9.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
接着看一下InspectorSocket::Accept返回InspectorSocket的逻辑。
```c
InspectorSocket::Pointer InspectorSocket::Accept(uv_stream_t* server,
                                                 DelegatePointer delegate) {
  auto tcp = TcpHolder::Accept(server, std::move(delegate));
  InspectorSocket* inspector = new InspectorSocket();
  inspector->SwitchProtocol(new HttpHandler(inspector, std::move(tcp)));
  return InspectorSocket::Pointer(inspector);
}
```
InspectorSocket::Accept的代码不多，但是逻辑还是挺多的。
1 InspectorSocket::Accept再次调用TcpHolder::Accept获得一个TcpHolder对象。
```c
TcpHolder::Pointer TcpHolder::Accept(
    uv_stream_t* server,
    InspectorSocket::DelegatePointer delegate) {
  // 新建一个TcpHolder对象，TcpHolder是对uv_tcp_t和delegate的封装
  TcpHolder* result = new TcpHolder(std::move(delegate));
  // 拿到TcpHolder对象的uv_tcp_t结构体
  uv_stream_t* tcp = reinterpret_cast<uv_stream_t*>(&result->tcp_);
  // 初始化
  int err = uv_tcp_init(server->loop, &result->tcp_);
  // 摘取一个TCP连接对应的fd保存到TcpHolder的uv_tcp_t结构体中（即第二个参数的tcp字段）
  uv_accept(server, tcp);
  // 注册等待可读事件，有数据时执行OnDataReceivedCb回调
  uv_read_start(tcp, allocate_buffer, OnDataReceivedCb);
  return TcpHolder::Pointer(result);
}
```
2  新建一个HttpHandler对象。
```c
explicit HttpHandler(InspectorSocket* inspector, TcpHolder::Pointer tcp)
                     : ProtocolHandler(inspector, std::move(tcp)){
                         
  llhttp_init(&parser_, HTTP_REQUEST, &parser_settings);
  llhttp_settings_init(&parser_settings);
  parser_settings.on_header_field = OnHeaderField;
  parser_settings.on_header_value = OnHeaderValue;
  parser_settings.on_message_complete = OnMessageComplete;
  parser_settings.on_url = OnPath;
}
ProtocolHandler::ProtocolHandler(InspectorSocket* inspector,
                                 TcpHolder::Pointer tcp)
                                 : inspector_(inspector), tcp_(std::move(tcp)) {
  // 设置TCP数据的handler，TCP是只负责传输，数据的解析交给handler处理                               
  tcp_->SetHandler(this);
}
```
HttpHandler是对uv_tcp_t的封装，主要通过HTTP解析器llhttp对HTTP协议进行解析。  
3 调用inspector->SwitchProtocol()切换当前协议为HTTP，建立TCP连接后，首先要经过一个HTTP请求从HTTP协议升级到WebSocket协议，升级成功后就使用Websocket协议进行通信。  
我们看一下这时候的结构图。  
![](https://img-blog.csdnimg.cn/64e87dc3a91b4e1496957e454b30aceb.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
至此，就完成了连接处理的分析。
###  3.2.3 协议升级
完成了TCP连接的处理后，接下来要完成协议升级，因为Inspector是通过WebSocket协议和客户端通信的，所以需要通过一个HTTP请求来完成HTTP到WebSocekt协议的升级。从刚才的分析中看当有数据到来时会执行OnDataReceivedCb回调。
```c
void TcpHolder::OnDataReceivedCb(uv_stream_t* tcp, ssize_t nread,
                                 const uv_buf_t* buf) {
  TcpHolder* holder = From(tcp);
  holder->ReclaimUvBuf(buf, nread);
  // 调用handler的onData，目前handler是HTTP协议
  holder->handler_->OnData(&holder->buffer);
}
```
TCP层收到数据后交给应用层解析，直接调用上层的OnData回调。

```c
void OnData(std::vector<char>* data) override {
    // 解析HTTP协议
    llhttp_execute(&parser_, data->data(), data->size());
    // 解析完并且是升级协议的请求则调用delegate的回调OnSocketUpgrade
    delegate()->OnSocketUpgrade(event.host, event.path, event.ws_key);
}
```
OnData可能会被多次回调，并通过llhttp_execute解析收到的HTTP报文，当发现是一个协议升级的请求后，就调用OnSocketUpgrade回调。delegate是TCP层保存的SocketSession::Delegate对象。来看一下该对象的OnSocketUpgrade方法。

```c
void SocketSession::Delegate::OnSocketUpgrade(const std::string& host,
                                              const std::string& path,
                                              const std::string& ws_key) {
  std::string id = path.empty() ? path : path.substr(1);
  server_->SessionStarted(session_id_, id, ws_key);
}
```
OnSocketUpgrade又调用来server_（InspectorSocketServer对象）的SessionStarted。
```c
void InspectorSocketServer::SessionStarted(int session_id,
                                           const std::string& id,
                                           const std::string& ws_key) {
  // 找到对应的session对象                                           
  SocketSession* session = Session(session_id);
  connected_sessions_[session_id].first = id;
  session->Accept(ws_key);
  delegate_->StartSession(session_id, id);
}
```
首先通过session_id找到建立TCP连接时分配的SocketSession对象。
1 执行session->Accept(ws_key);回复客户端同意协议升级。
```c
void Accept(const std::string& ws_key) {
  ws_socket_->AcceptUpgrade(ws_key);
}
```
从结构图我们可以看到ws_socket_是一个InspectorSocket对象。
```c
void AcceptUpgrade(const std::string& accept_key) override {
    char accept_string[ACCEPT_KEY_LENGTH];
    generate_accept_string(accept_key, &accept_string);
    const char accept_ws_prefix[] = "HTTP/1.1 101 Switching Protocols\r\n"
                                    "Upgrade: websocket\r\n"
                                    "Connection: Upgrade\r\n"
                                    "Sec-WebSocket-Accept: ";
    const char accept_ws_suffix[] = "\r\n\r\n";
    std::vector<char> reply(accept_ws_prefix,
                            accept_ws_prefix + sizeof(accept_ws_prefix) - 1);
    reply.insert(reply.end(), accept_string,
                 accept_string + sizeof(accept_string));
    reply.insert(reply.end(), accept_ws_suffix,
                 accept_ws_suffix + sizeof(accept_ws_suffix) - 1);
    // 回复101给客户端             
    WriteRaw(reply, WriteRequest::Cleanup);
    // 切换handler为WebSocket handler
    inspector_->SwitchProtocol(new WsHandler(inspector_, std::move(tcp_)));
}
```
AcceptUpgradeh首先回复客户端101表示同意升级道WebSocket协议，然后切换数据处理器为WsHandler，即后续的数据按照WebSocket协议处理。
2 执行delegate_->StartSession(session_id, id)建立和V8 Inspector的会话。delegate_是InspectorIoDelegate对象。
```c
void InspectorIoDelegate::StartSession(int session_id,
                                       const std::string& target_id) {
  auto session = main_thread_->Connect(
      std::unique_ptr<InspectorSessionDelegate>(
          new IoSessionDelegate(request_queue_->handle(), session_id)
      ), 
      true);
  if (session) {
    sessions_[session_id] = std::move(session);
    fprintf(stderr, "Debugger attached.\n");
  }
}
```
首先通过main_thread_->Connect拿到一个session，并在InspectorIoDelegate中记录映射关系。结构图如下。  
![](https://img-blog.csdnimg.cn/a1f20d470ab94e65b40a2a851be9be67.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
接下来看一下main_thread_->Connect的逻辑（main_thread_是MainThreadHandle对象）。
```c
std::unique_ptr<InspectorSession> MainThreadHandle::Connect(
    std::unique_ptr<InspectorSessionDelegate> delegate,
    bool prevent_shutdown) {
    
  return std::unique_ptr<InspectorSession>(
      new CrossThreadInspectorSession(++next_session_id_,
                                      shared_from_this(),
                                      std::move(delegate),
                                      prevent_shutdown));
}
```
Connect函数新建了一个CrossThreadInspectorSession对象。
```c
 CrossThreadInspectorSession(
      int id,
      std::shared_ptr<MainThreadHandle> thread,
      std::unique_ptr<InspectorSessionDelegate> delegate,
      bool prevent_shutdown)
      // 创建一个MainThreadSessionState对象
      : state_(thread, std::bind(MainThreadSessionState::Create,
                                 std::placeholders::_1,
                                 prevent_shutdown)) {
    // 执行MainThreadSessionState::Connect                             
    state_.Call(&MainThreadSessionState::Connect, std::move(delegate));
  }
```
继续看MainThreadSessionState::Connect。
```c
void Connect(std::unique_ptr<InspectorSessionDelegate> delegate) {
    Agent* agent = thread_->inspector_agent();
    session_ = agent->Connect(std::move(delegate), prevent_shutdown_);
}
```
继续调agent->Connect。
```c
std::unique_ptr<InspectorSession> Agent::Connect(
    std::unique_ptr<InspectorSessionDelegate> delegate,
    bool prevent_shutdown) {
    
  int session_id = client_->connectFrontend(std::move(delegate),
                                            prevent_shutdown);
  return std::unique_ptr<InspectorSession>(
      new SameThreadInspectorSession(session_id, client_));
}
```
继续调connectFrontend
```c
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
connectFrontend创建了一个ChannelImpl并且在channels_中保存了映射关系。看看ChannelImpl的构造函数。
```c
explicit ChannelImpl(Environment* env,
                     const std::unique_ptr<V8Inspector>& inspector,
                     std::unique_ptr<InspectorSessionDelegate> delegate, ...)
      : delegate_(std::move(delegate)) {
      
    session_ = inspector->connect(CONTEXT_GROUP_ID, this, StringView());
}
```
ChannelImpl调用inspector->connect建立了一个和V8 Inspector的会话。结构图大致如下。  
![](https://img-blog.csdnimg.cn/3265bafd385c49beb345a604aa77ebc2.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
###  3.2.4 客户端到V8 Inspector的数据处理
TCP连接建立了，协议升级也完成了，接下来就可以开始处理业务数据。从前面的分析中我们已经知道数据到来时会执行TcpHoldler的handler_->OnData回调。因为已经完成了协议升级，所以这时候的handler变成了WeSocket handler。
```c
  void OnData(std::vector<char>* data) override {
    // 1. Parse.
    int processed = 0;
    do {
      processed = ParseWsFrames(*data);
      // 2. Fix the data size & length
      if (processed > 0) {
        remove_from_beginning(data, processed);
      }
    } while (processed > 0 && !data->empty());
  }
```
OnData通过ParseWsFrames解析WebSocket协议。
```c
int ParseWsFrames(const std::vector<char>& buffer) {
    int bytes_consumed = 0;
    std::vector<char> output;
    bool compressed = false;
	// 解析WebSocket协议
    ws_decode_result r =  decode_frame_hybi17(buffer,
                                              true /* client_frame */,
                                              &bytes_consumed, &output,
                                              &compressed);
    // 执行delegate的回调                                        
    delegate()->OnWsFrame(output);
    return bytes_consumed;
  }
```
前面已经分析过delegate是TcpHoldler的delegate，即SocketSession::Delegate对象。
```c
void SocketSession::Delegate::OnWsFrame(const std::vector<char>& data) {
  server_->MessageReceived(session_id_,
                           std::string(data.data(), 
                           data.size()));
}
```
继续回调server_->MessageReceived。从结构图可以看到server_是InspectorSocketServer对象。
```c
void MessageReceived(int session_id, const std::string& message) {
  delegate_->MessageReceived(session_id, message);
}
```
继续回调delegate_->MessageReceived。InspectorSocketServer的delegate_是InspectorIoDelegate对象。
```c
void InspectorIoDelegate::MessageReceived(int session_id,
                                          const std::string& message) {
  auto session = sessions_.find(session_id);
  if (session != sessions_.end())
    session->second->Dispatch(Utf8ToStringView(message)->string());
}
```
首先通过session_id找到对应的session。session是一个CrossThreadInspectorSession对象。看看他的Dispatch方法。
```c
 void Dispatch(const StringView& message) override {
    state_.Call(&MainThreadSessionState::Dispatch,
                StringBuffer::create(message));
  }
```
执行MainThreadSessionState::Dispatch。
```c
void Dispatch(std::unique_ptr<StringBuffer> message) {
  session_->Dispatch(message->string());
}
```
session_是SameThreadInspectorSession对象。
```c
void SameThreadInspectorSession::Dispatch(
    const v8_inspector::StringView& message) {
  auto client = client_.lock();
  if (client)
    client->dispatchMessageFromFrontend(session_id_, message);
}
```
继续调client->dispatchMessageFromFrontend。

```c
 void dispatchMessageFromFrontend(int session_id, const StringView& message) {
   channels_[session_id]->dispatchProtocolMessage(message);
 }
```
通过session_id找到对应的ChannelImpl，继续调ChannelImpl的dispatchProtocolMessage。

```c
 voiddispatchProtocolMessage(const StringView& message) {
   session_->dispatchProtocolMessage(message);
 }
```
最终调用和V8 Inspector的会话对象把数据发送给V8。至此客户端到V8 Inspector的通信过程就完成了。
###  3.2.5 V8 Inspector到客户端的数据处理
接着看从V8 inspector到客户端的数据传递逻辑。V8 inspector是通过channel的sendResponse函数传递给客户端的。
```c
 void sendResponse(
      int callId,
      std::unique_ptr<v8_inspector::StringBuffer> message) override {
      
    sendMessageToFrontend(message->string());
  }
  
 void sendMessageToFrontend(const StringView& message) {
    delegate_->SendMessageToFrontend(message);
 }
```
delegate_是IoSessionDelegate对象。
```c
void SendMessageToFrontend(const v8_inspector::StringView& message) override {
    request_queue_->Post(id_, TransportAction::kSendMessage,
                         StringBuffer::create(message));
  }
```
request_queue_是RequestQueueData对象。
```c
 void Post(int session_id,
            TransportAction action,
            std::unique_ptr<StringBuffer> message) {
            
    Mutex::ScopedLock scoped_lock(state_lock_);
    bool notify = messages_.empty();
    messages_.emplace_back(action, session_id, std::move(message));
    if (notify) {
      CHECK_EQ(0, uv_async_send(&async_));
      incoming_message_cond_.Broadcast(scoped_lock);
    }
  }
```
Post首先把消息入队，然后通过异步的方式通知async_接着看async_的处理函数（在子线程的事件循环里执行）。
```c
uv_async_init(loop, &async_, [](uv_async_t* async) {
   // 拿到async对应的上下文
   RequestQueueData* wrapper = node::ContainerOf(&RequestQueueData::async_, async);
   // 执行RequestQueueData的DoDispatch
   wrapper->DoDispatch();
});
```

```c
  void DoDispatch() {
    for (const auto& request : GetMessages()) {
      request.Dispatch(server_);
    }
  }
```
request是RequestToServer对象。
```c
  void Dispatch(InspectorSocketServer* server) const {
    switch (action_) {
      case TransportAction::kSendMessage:
        server->Send(
            session_id_,
            protocol::StringUtil::StringViewToUtf8(message_->string()));
        break;
    }
  }
```
接着看InspectorSocketServer的Send。
```c
void InspectorSocketServer::Send(int session_id, const std::string& message) {
  SocketSession* session = Session(session_id);
  if (session != nullptr) {
    session->Send(message);
  }
}
```
session代表可客户端的一个连接。
```c
void SocketSession::Send(const std::string& message) {
  ws_socket_->Write(message.data(), message.length());
}
```
接着调用WebSocket handler的Write。
```c

  void Write(const std::vector<char> data) override {
    std::vector<char> output = encode_frame_hybi17(data);
    WriteRaw(output, WriteRequest::Cleanup);
  }
```
WriteRaw是基类ProtocolHandler实现的。
```c
int ProtocolHandler::WriteRaw(const std::vector<char>& buffer,
                              uv_write_cb write_cb) {
  return tcp_->WriteRaw(buffer, write_cb);
}
```
最终是通过TCP连接返回给客户端。
```c
int TcpHolder::WriteRaw(const std::vector<char>& buffer, uv_write_cb write_cb) {
  // Freed in write_request_cleanup
  WriteRequest* wr = new WriteRequest(handler_, buffer);
  uv_stream_t* stream = reinterpret_cast<uv_stream_t*>(&tcp_);
  int err = uv_write(&wr->req, stream, &wr->buf, 1, write_cb);
  if (err < 0)
    delete wr;
  return err < 0;
}
```
新建一个写请求，socket可写的时候发送数据给客户端。

**后记：Node.js Inspector的原理虽然不复杂的，但是实现实在太绕了。**

# 4 动态开启Inspector
默认打开Inspector能力是不安全的，这意味着能连上websocket服务器的客户端都能通过协议控制Node.js进程，通常我们是在Node.js进程出现问题的时候，动态开启Inspector。
```c
const http = require('http');
const inspector = require('inspector');
const fs = require('fs');

http.createServer((req, res) => {
	if (req.url == 'debug') {
		  const session = new inspector.Session();
		  session.connect();
		  session.post('Profiler.enable', () => {
		  session.post('Profiler.start', () => {
		    session.post('Profiler.stop', (err, { profile }) => {
		      if (!err) {
		        fs.writeFileSync('./profile.cpuprofile', JSON.stringify(profile));
		      }
		      session.disconnect();
		      res.end('ok');
		    });
		  });
		});
	} else {
		res.end('ok');
	}
}).listen(80);
```
我们可以通过url参数控制Inspector的能力，本地调试时可以在vscode里可以直接看到数据。  
![在这里插入图片描述](https://img-blog.csdnimg.cn/30b87bb430074f8e973c987c8df06cef.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  

# 5 收集数据
V8 inspector是一个非常强大的工具，调试只是它其中一个能力，他还可以获取内存、CPU等数据，具体能力请参考文档。  
![](https://img-blog.csdnimg.cn/ad5cbee01d1c47ce9da3d4af534e7f79.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  

**后记：Node.js的inspector是在Node.js额外线程里开启的一个非常强大的工具，通过Node.js作为中间人，完成客户端和V8 inspector的通信（调试、收集数据），是我们调试和诊断Node.js进程非常好的方式。**

参考内容：  
1 [Debugging Guide](https://nodejs.org/en/docs/guides/debugging-getting-started)  
2 [inspector](https://nodejs.org/dist/latest-v16.x/docs/api/inspector.html)  
3 [开源的inspector agent实现](https://github.com/ahmadov/v8_inspector_example)  
4 [inpector协议文档](https://chromedevtools.github.io/devtools-protocol/v8/Debugger/)  
5 [Debugging Node.js with Chrome DevTools](https://medium.com/@paul_irish/debugging-node-js-nightlies-with-chrome-devtools-7c4a1b95ae27)  
