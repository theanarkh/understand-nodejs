Node.js的DNS模块使用了cares库和Libuv的线程池实现。cares是一个异步DNS解析库，它自己实现了DNS协议的封包和解析，配合Libuv事件驱动机制，在Node.js中实现异步的DNS解析。另外通过IP查询域名或者域名查询IP是直接调用操作系统提供的接口实现的，因为这两个函数是阻塞式的API，所以Node.js是通过Libuv的线程池实现异步查询。除了提供直接的DNS查询外，Node.js还提供了设置DNS服务器、新建一个DNS解析实例（Resolver）等功能。这些功能是使用cares实现的。下面我们开始分析DNS模块的原理和实现。  

## 8.1 通过域名找IP
我们看一下在Node.js中如何查询一个域名对于的IP的信息

```js
    dns.lookup('www.a.com', function(err, address, family) {  
        console.log(address);  
    });  
```

DNS功能的JS层实现在dns.js中

```js
    const req = new GetAddrInfoReqWrap();  
    req.callback = callback;  
    req.family = family;  
    req.hostname = hostname;  
    req.oncomplete = all ? onlookupall : onlookup;  
      
    const err = cares.getaddrinfo(  
      req, toASCII(hostname), family, hints, verbatim  
    );  
```

Node.js设置了一些参数后，调用cares_wrap.cc的getaddrinfo方法，在care_wrap.cc的初始化函数中我们看到， getaddrinfo函数对应的函数是GetAddrInfo。

```cpp
    void Initialize(Local<Object> target,  
                    Local<Value> unused,  
                    Local<Context> context) {  
      Environment* env = Environment::GetCurrent(context); 
      env->SetMethod(target, "getaddrinfo", GetAddrInfo);  
      ...  
    }  
```

GetAddrInfo的主要逻辑如下

```cpp
    auto req_wrap = new GetAddrInfoReqWrap(env, req_wrap_obj, args[4]->IsTrue());  
      
    struct addrinfo hints;  
    memset(&hints, 0, sizeof(struct addrinfo));  
    hints.ai_family = family;  
    hints.ai_socktype = SOCK_STREAM;  
    hints.ai_flags = flags;  
      
    int err = uv_getaddrinfo(env->event_loop(),
                                req_wrap->req(), 
                                AfterGetAddrInfo,
                                *hostname,
                                nullptr,
                                &hints);  
```

GetAddrInfo是对uv_getaddrinfo的封装，回调函数是AfterGetAddrInfo

```cpp
    int uv_getaddrinfo(uv_loop_t* loop,  
                        // 上层传进来的req  
                       uv_getaddrinfo_t* req,  
                       // 解析完后的上层回调  
                       uv_getaddrinfo_cb cb,  
                       // 需要解析的名字  
                       const char* hostname,  
                       /* 
                               查询的过滤条件：服务名。比如
                                            http smtp。也可以是一个端口。
                                            见下面注释 
                                  */  
                       const char* service,  
                       // 其它查询过滤条件  
                       const struct addrinfo* hints) {  
       
      size_t hostname_len;  
      size_t service_len;  
      size_t hints_len;  
      size_t len;  
      char* buf;  
      
      hostname_len = hostname ? strlen(hostname) + 1 : 0;  
      service_len = service ? strlen(service) + 1 : 0;  
      hints_len = hints ? sizeof(*hints) : 0;  
      buf = uv__malloc(hostname_len + service_len + hints_len);  
      uv__req_init(loop, req, UV_GETADDRINFO);  
      req->loop = loop;  
      // 设置请求的回调  
      req->cb = cb;  
      req->addrinfo = NULL;  
      req->hints = NULL;  
      req->service = NULL;  
      req->hostname = NULL;  
      req->retcode = 0;  
      len = 0;  
      
      if (hints) {  
        req->hints = memcpy(buf + len, hints, sizeof(*hints));  
        len += sizeof(*hints);  
      }  
      
      if (service) {  
        req->service = memcpy(buf + len, service, service_len); 
        len += service_len;  
      }  
      
      if (hostname)  
        req->hostname = memcpy(buf + len, hostname, hostname_len);
      // 传了cb则是异步  
      if (cb) {  
        uv__work_submit(loop,  
                &req->work_req,  
                UV__WORK_SLOW_IO,  
                uv__getaddrinfo_work,  
                uv__getaddrinfo_done);  
        return 0;  
      } else {  
        // 阻塞式查询，然后执行回调  
        uv__getaddrinfo_work(&req->work_req);  
        uv__getaddrinfo_done(&req->work_req, 0);  
        return req->retcode;  
      }  
    }  
```

我们看到这个函数首先是对一个request进行初始化，然后根据是否传了回调，决定走异步还是同步的模式。同步的方式比较简单，就是直接阻塞Libuv事件循环，直到解析完成。如果是异步，则给线程池提交一个慢IO的任务。其中工作函数是uv__getaddrinfo_work。回调是uv__getaddrinfo_done。我们看一下这两个函数。

```cpp
    // 解析的工作函数  
    static void uv__getaddrinfo_work(struct uv__work* w) {  
      uv_getaddrinfo_t* req;  
      int err;  
      // 根据结构体的字段获取结构体首地址  
      req = container_of(w, uv_getaddrinfo_t, work_req);  
      // 阻塞在这  
      err = getaddrinfo(req->hostname, 
                            req->service, 
                            req->hints, 
                            &req->addrinfo);  
      req->retcode = uv__getaddrinfo_translate_error(err);  
    }  
```

uv__getaddrinfo_work函数主要是调用了系统提供的getaddrinfo去做解析。该函数会导致进程阻塞。结果返回后，执行uv__getaddrinfo_done。

```cpp
    static void uv__getaddrinfo_done(struct uv__work* w, int status) {  
      uv_getaddrinfo_t* req;  
      
      req = container_of(w, uv_getaddrinfo_t, work_req);  
      uv__req_unregister(req->loop, req);  
      // 释放初始化时申请的内存  
      if (req->hints)  
        uv__free(req->hints);  
      else if (req->service)  
        uv__free(req->service);  
      else if (req->hostname)  
        uv__free(req->hostname);  
      else  
        assert(0);  
      
      req->hints = NULL;  
      req->service = NULL;  
      req->hostname = NULL;  
      // 解析请求被用户取消了  
      if (status == UV_ECANCELED) {  
        assert(req->retcode == 0);  
        req->retcode = UV_EAI_CANCELED;  
      }  
      // 执行上层回调  
      if (req->cb)  
        req->cb(req, req->retcode, req->addrinfo);  
      
    }  
```

uv__getaddrinfo_done会执行C++层的回调，从而执行JS层的回调。
## 8.2 cares
除了通过IP查询域名和域名查询IP外，其余的DNS功能都由cares实现，我们看一下cares的基本用法。
### 8.2.1 cares使用和原理

```cpp
    // channel是cares的核心结构体
    ares_channel channel;  
    struct ares_options options;  
    // 初始化channel
    status = ares_init_options(&channel, &options, optmask);  
    // 把 argv的数据存到addr
    ares_inet_pton(AF_INET, *argv, &addr4);
    // 把addr数据存到channel并发起DNS查询
    ares_gethostbyaddr(channel, 
                       &addr4, 
                       sizeof(addr4), 
                       AF_INET, 
                       callback,*argv);  
    for (;;)  
        {  
          int res;  
          FD_ZERO(&read_fds);  
          FD_ZERO(&write_fds);  
          // 把channel对应的fd存到read_fd和write_fds  
          nfds = ares_fds(channel, &read_fds, &write_fds);  
          if (nfds == 0)  
            break;  
          // 设置超时时间  
          tvp = ares_timeout(channel, NULL, &tv);  
          // 阻塞在select，等待DNS回包  
          res = select(nfds, &read_fds, &write_fds, NULL, tvp);
          if (-1 == res)  
            break;  
          // 处理DNS相应  
          ares_process(channel, &read_fds, &write_fds);  
        }  
```

上面是一个典型的事件驱动模型，首先初始化一些信息，然后发起一个非阻塞的请求，接着阻塞在多路复用API，该API返回后，执行触发了事件的回调。
### 8.2.2 cares_wrap.cc的通用逻辑
在Node.js中，Node.js和cares的整体交互如图8-1所示。    
![](https://img-blog.csdnimg.cn/cf528843e4ac4b1c8ce03407f502083d.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图8-1. 

我们通过cares_wrap.cc分析其中的原理。我们从DNS模块提供的resolveCname函数开始。resolveCname函数由以下代码导出（dns.js）。
```js
bindDefaultResolver(module.exports, getDefaultResolver())  
```
我们看一下这两个函数（dns/utils.js）。

```js
    class Resolver {  
      constructor() {  
        this._handle = new ChannelWrap();  
      }  
      // ...  
    }  
      
    let defaultResolver = new Resolver();  
      
    function getDefaultResolver() {  
      return defaultResolver;  
    }  
      
    function resolver(bindingName) {  
      function query(name, /* options, */ callback) {  
        let options;  
        const req = new QueryReqWrap();  
        req.bindingName = bindingName;  
        req.callback = callback;  
        req.hostname = name;  
        req.oncomplete = onresolve;  
        req.ttl = !!(options && options.ttl);  
        const err = this._handle[bindingName](req, toASCII(name));  
        if (err) throw dnsException(err, bindingName, name);  
        return req;  
      }  
      ObjectDefineProperty(query, 'name', { value: bindingName });  
      return query;  
    }  
    // 给原型链注入一个新的属性，defaultResolver中也生效  
    Resolver.prototype.resolveCname = resolveMap.CNAME = resolver('queryCname');  
```

getDefaultResolver导出的是一个Resolve对象，里面有resolveCname等一系列方法。接着看一下bindDefaultResolver，我们一会再看ChannelWrap。

```js
    const resolverKeys = [ 
      'resolveCname ',  
      // …
    ]  
    function bindDefaultResolver(target, source) {  
      resolverKeys.forEach((key) => {  
        target[key] = source[key].bind(defaultResolver);  
      });  
    }  
```

看起来很绕，其实就是把Resolve对象的方法导出到DNS模块。这样用户就可以使用了。我们看到resolveCname是由resolver函数生成的，resolver函数对cares系列函数进行了封装，最终调用的是this._handle.queryCname函数。我们来看一下这个handle（ChannelWrap类对象）的实现（cares_wrap.cc）。我们先看一下cares_wrap.cc模块导出的API。

```cpp
    Local<FunctionTemplate> channel_wrap = env->NewFunctionTemplate(ChannelWrap::New);  
    channel_wrap->InstanceTemplate()->SetInternalFieldCount(1);  
    channel_wrap->Inherit(AsyncWrap::GetConstructorTemplate(env));  
    // Query是C++函数模板
    env->SetProtoMethod(channel_wrap, 
                          "queryCname", 
                          Query<QueryCnameWrap>);  
    // ...  
    Local<String> channelWrapString = FIXED_ONE_BYTE_STRING(env->isolate(), "ChannelWrap");  
    channel_wrap->SetClassName(channelWrapString);  
    target->Set(env->context(), 
    channelWrapString,channel_wrap->GetFunction(context).ToLocalChecked()).Check();  
```

handle对应的就是以上代码导出的对象。当我们在JS层执行new ChannelWrap的时候。
最终会调用C++层创建一个对象，并且执行ChannelWrap::New。

```cpp
    void ChannelWrap::New(const FunctionCallbackInfo<Value>& args) {  
      Environment* env = Environment::GetCurrent(args);  
      new ChannelWrap(env, args.This());  
    }  
```

我们看一下类ChannelWrap的定义。

```cpp
    class ChannelWrap : public AsyncWrap {  
     public:  
      // ...  
      
     private:  
      // 超时管理  
      uv_timer_t* timer_handle_;  
      // cares数据类型  
      ares_channel channel_;  
      // 标记查询结果  
      bool query_last_ok_;  
      // 使用的DNS服务器  
      bool is_servers_default_;  
      // 是否已经初始化cares库  
      bool library_inited_;  
      // 正在发起的查询个数  
      int active_query_count_;  
      // 发起查询的任务队列  
      node_ares_task_list task_list_;  
    };  
```

接着我们看看ChannelWrap构造函数的代码。

```cpp
    ChannelWrap::ChannelWrap(...) {  
      Setup();  
    }  
```

ChannelWrap里直接调用了Setup

```cpp
    void ChannelWrap::Setup() {  
      struct ares_options options;  
      memset(&options, 0, sizeof(options));  
      options.flags = ARES_FLAG_NOCHECKRESP;   
      /*
        caresd socket状态（读写）发生变更时，执行的函数，
        第一个入参是sock_state_cb_data
      */
      options.sock_state_cb = ares_sockstate_cb;  
     options.sock_state_cb_data = this;  
      
     // 还没初始化则初始化 
     if (!library_inited_) {  
       Mutex::ScopedLock lock(ares_library_mutex);  
       // 初始化cares库  
       ares_library_init(ARES_LIB_INIT_ALL);  
     }  
     // 设置使用cares的配置  
     ares_init_options(&channel_,  
                           &options,  
                           ARES_OPT_FLAGS | ARES_OPT_SOCK_STATE_CB);
     library_inited_ = true;  
    }  
```

我们看到，Node.js在这里初始化cares相关的逻辑。其中最重要的就是设置了cares socket状态变更时执行的回调ares_sockstate_cb（比如socket需要读取数据或者写入数据）。前面的cares使用例子中讲到了cares和事件驱动模块的配合使用，那么cares和Libuv是如何配合的呢？cares提供了一种机制，就是socket状态变更时通知事件驱动模块。DNS解析本质上也是网络IO，所以发起一个DNS查询也就是对应一个socket。DNS查询是由cares发起的，这就意味着socket是在cares中维护的，那Libuv怎么知道呢？正是cares提供的通知机制，使得Libuv知道发起DNS查询对应的socket，从而注册到Libuv中，等到事件触发后，再通知cares。下面我们看一下具体的实现。我们从发起一个cname查询开始分析。首先回顾一下cares_wrap模块导出的cname查询函数，
env->SetProtoMethod(channel_wrap, "queryCname", Query<QueryCnameWrap>);Query是C++模板函数，QueryCnameWrap是C++类

```cpp
    template <class Wrap>  
    static void Query(const FunctionCallbackInfo<Value>& args) {  
      Environment* env = Environment::GetCurrent(args);  
      ChannelWrap* channel;  
        // Holder中保存了ChannelWrap对象，解包出来
      ASSIGN_OR_RETURN_UNWRAP(&channel, args.Holder());  
      Local<Object> req_wrap_obj = args[0].As<Object>();  
      Local<String> string = args[1].As<String>();  
        /*
          根据参数新建一个对象，这里是QueryCnameWrap，
          并且保存对应的ChannelWrap对象和操作相关的对象
        */
      Wrap* wrap = new Wrap(channel, req_wrap_obj);  
      
      node::Utf8Value name(env->isolate(), string);
        // 发起请求数加一  
      channel->ModifyActivityQueryCount(1);  
        // 调用Send函数发起查询
      int err = wrap->Send(*name);  
      if (err) {  
        channel->ModifyActivityQueryCount(-1);  
        delete wrap;  
      }  
      
      args.GetReturnValue().Set(err);  
    }  
```

Query只实现了一些通用的逻辑，然后调用Send函数，具体的Send函数逻辑由各个具体的类实现。
### 8.2.3 具体实现
我们看一下QueryCnameWrap类。

```cpp
    class QueryCnameWrap: public QueryWrap {  
     public:  
      QueryCnameWrap(ChannelWrap* channel, 
                       Local<Object> req_wrap_obj)  
          : QueryWrap(channel, req_wrap_obj, "resolveCname") {  
      }  
      
      int Send(const char* name) override {  
         AresQuery(name, ns_c_in, ns_t_cname);  
        return 0;  
      }  
      
     protected:  
      void Parse(unsigned char* buf, int len) override {  
        HandleScope handle_scope(env()->isolate());  
        Context::Scope context_scope(env()->context());  
      
        Local<Array> ret = Array::New(env()->isolate());  
        int type = ns_t_cname;  
        int status = ParseGeneralReply(env(), buf, len, &type, ret);  
        if (status != ARES_SUCCESS) {  
          ParseError(status);  
          return;  
        }  
      
        this->CallOnComplete(ret);  
      }  
    };  
```

我们看到QueryCnameWrap类的实现非常简单，主要定义Send和Parse的实现，最终还是会调用基类对应的函数。我们看一下基类QueryWrap中AresQuery的实现。

```cpp
    void AresQuery(const char* name,  
            int dnsclass,  
            int type) {  
        ares_query(channel_->cares_channel(), 
                       name, 
                       dnsclass, 
                       type, 
                       Callback,  
              static_cast<void*>(this));  
      }  
```

AresQuery函数提供统一发送查询操作。查询完成后执行Callback回调。接下来就涉及到cares和Node.js的具体交互了。Node.js把一个任务交给cares后，cares会新建一个socket，接着cares会通过Node.js设置的回调ares_sockstate_cb通知Node.js。我们看一下ares_query的关键逻辑。

```cpp
    void ares_query(ares_channel channel, const char *name, int dnsclass,  
                    int type, ares_callback callback, void *arg)  
    {  
      struct qquery *qquery;  
      unsigned char *qbuf;  
      int qlen, rd, status;  
      
      qquery = ares_malloc(sizeof(struct qquery));  
      // 保存Node.js的回调，查询完成时回调  
      qquery->callback = callback;  
      qquery->arg = arg;  
      ares_send(channel, qbuf, qlen, qcallback, qquery);  
    }  
    
    static void qcallback(void *arg, int status, int timeouts, unsigned char *abuf, int alen)  
    {  
      struct qquery *qquery = (struct qquery *) arg;  
      unsigned int ancount;  
      int rcode;  
      
      if (status != ARES_SUCCESS)  
        qquery->callback(qquery->arg, status, timeouts, abuf, alen);
      else  
        {  
          // ...  
          // 执行Node.js回调  
          qquery->callback(qquery->arg, 
                              status,
                              timeouts, 
                              abuf, 
                              alen);  
        }  
      ares_free(qquery);  
    }  
    
```

ares_query保存了Node.js的回调，并且设置回调qcallback，查询成功后会回调qcallback，qcallback再回调Node.js。接着执行ares_send，ares_send会调用ares__send_query。

```cpp
    void ares__send_query(ares_channel channel, 
                            struct query *query,  
                          struct timeval *now)  
    {  
        struct server_state *server = &channel->servers[query->server];  
        if (server->udp_socket == ARES_SOCKET_BAD)  
            {  
              // 申请一个socket  
              if (open_udp_socket(channel, server) == -1)  
                {  
                  skip_server(channel, query, query->server);  
                  next_server(channel, query, now);  
                  return;  
                }  
            }  
          // 发送DNS查询  
          if (socket_write(channel, server->udp_socket, query->qbuf, query->qlen) == -1)  
            {  
              skip_server(channel, query, query->server);  
              next_server(channel, query, now);  
              return;  
            }  
    }  
```

ares__send_query首先申请一个socket，然后发送数据。因为UDP不是面向连接的，可以直接发送。我们看一下open_udp_socket。

```cpp
    static int open_udp_socket(ares_channel channel, struct server_state *server)  
    {  
      ares_socket_t s;  
      ares_socklen_t salen;  
      union {  
        struct sockaddr_in  sa4;  
        struct sockaddr_in6 sa6;  
      } saddr;  
      struct sockaddr *sa;  
      
      // 申请一个socket  
      s = open_socket(channel, server->addr.family, SOCK_DGRAM, 0); 
      // 绑定服务器地址  
      connect_socket(channel, s, sa, salen)  
        
      // 通知Node.js，1,0表示对socket的读事件感兴趣，因为发送了请求，等待响应  
      SOCK_STATE_CALLBACK(channel, s, 1, 0);  
      // 保存socket
      server->udp_socket = s;  
      return 0;  
    }  
    
    #define SOCK_STATE_CALLBACK(c, s, r, w)                                 \  
      do {                                                                  \  
        if ((c)->sock_state_cb)                                             \  
          (c)->sock_state_cb((c)->sock_state_cb_data, (s), (r), (w));       \  
      } WHILE_FALSE  
    
```

ares__send_query函数做了三件事
1 申请了socket，
2 通知Node.js
3 发送了DNS查询请求
这时候流程走到了Node.js，我们看一下cares回调Node.js的时候，Node.js怎么处理的

```cpp
    struct node_ares_task : public MemoryRetainer {  
      ChannelWrap* channel;  
      // 关联的socket  
      ares_socket_t sock;  
      // IO观察者和回调  
      uv_poll_t poll_watcher;  
    };  
      
    void ares_sockstate_cb(void* data,  
                           ares_socket_t sock,  
                           int read,  
                           int write) {  
      ChannelWrap* channel = static_cast<ChannelWrap*>(data);  
      node_ares_task* task;  
      // 任务  
      node_ares_task lookup_task;  
      lookup_task.sock = sock;  
      // 该任务是否已经存在  
      auto it = channel->task_list()->find(&lookup_task);  
      
      task = (it == channel->task_list()->end()) ? nullptr : *it;  
      
      if (read || write) {  
        if (!task) {  
          // 开启定时器，超时后通知cares  
          channel->StartTimer();  
          // 创建一个任务  
          task = ares_task_create(channel, sock);  
          // 保存到任务列表  
          channel->task_list()->insert(task);  
        }  
        // 注册IO观察者到epoll，感兴趣的事件根据cares传的进行设置，有事件触发后执行回调ares_poll_cb  
        uv_poll_start(&task->poll_watcher,  
                      (read ? UV_READABLE : 0) | (write ? UV_WRITABLE : 0),  
                      ares_poll_cb);  
      
      } else {  
        // socket关闭了，删除任务  
        channel->task_list()->erase(it);  
        // 关闭该任务对应观察者io，然后删除删除该任务  
        channel->env()->CloseHandle(&task->poll_watcher, ares_poll_close_cb);  
        // 没有任务了，关闭定时器  
        if (channel->task_list()->empty()) {  
          channel->CloseTimer();  
        }  
      }  
    }  
```

每一个DNS查询的任务，在Node.js中用node_ares_task 管理。它封装了请求对应的channel、查询请求对应的socket和uv_poll_t。我们看一下ares_task_create

```cpp
    node_ares_task* ares_task_create(ChannelWrap* channel, ares_socket_t sock) {  
      auto task = new node_ares_task();  
      
      task->channel = channel;  
      task->sock = sock;  
      // 初始化uv_poll_t，保存文件描述符sock到uv_poll_t  
      if (uv_poll_init_socket(channel->env()->event_loop(),&task->poll_watcher, sock) < 0) {  
        delete task;  
        return nullptr;  
      }  
      
      return task;  
    }  
```

首先创建一个node_ares_task对象。然后初始化uv_poll_t并且把文件描述符保存到uv_poll_t。uv_poll_t是对文件描述符、回调、IO观察者的封装。文件描述符的事件触发时，会执行IO观察者的回调，从而执行uv_poll_t保存的回调。我们继续回到ares_sockstate_cb，当cares通知Node.js socket状态变更的时候，Node.js就会修改epoll节点的配置（感兴趣的事件）。当事件触发的时候，会执行ares_poll_cb。我们看一下该函数。

```cpp
    void ares_poll_cb(uv_poll_t* watcher, int status, int events) {  
      node_ares_task* task = ContainerOf(&node_ares_task::poll_watcher, watcher);  
      ChannelWrap* channel = task->channel;  
      
      // 有事件触发，重置超时时间  
      uv_timer_again(channel->timer_handle());  
      
      // 通知cares处理响应  
      ares_process_fd(channel->cares_channel(),  
                      events & UV_READABLE ? task->sock : ARES_SOCKET_BAD,  
                      events & UV_WRITABLE ? task->sock : ARES_SOCKET_BAD);  
    }  
```

当socket上感兴趣的事件触发时，Node.js调ares_process_fd处理。真正的处理函数是processfds。

```cpp
    static void processfds(ares_channel channel,  
                           fd_set *read_fds, ares_socket_t read_fd,  
                           fd_set *write_fds, ares_socket_t write_fd)  
    {  
      struct timeval now = ares__tvnow();  
      
      write_tcp_data(channel, write_fds, write_fd, &now);  
      read_tcp_data(channel, read_fds, read_fd, &now);  
      read_udp_packets(channel, read_fds, read_fd, &now);  
     process_timeouts(channel, &now);  
     process_broken_connections(channel, &now);  
    }  
```

processfds是统一的处理函数，在各自函数内会做相应的判断和处理。我们这里是收到了UDP响应。则会执行read_udp_packets

```cpp
    static void read_udp_packets(ares_channel channel, fd_set *read_fds,  
                                 ares_socket_t read_fd, struct timeval *now){  
    // 读取响应  
    count = socket_recvfrom(channel, server->udp_socket, (void *)buf, sizeof(buf), 0, &from.sa, &fromlen);  
    // 处理响应，最终调用query->callback回调Node.js  
    process_answer(channel, buf, (int)count, i, 0, now);  
    }  
```

Cares读取响应然后解析响应，最后回调Node.js。Node.js设置的回调函数是Callback

```cpp
    static void Callback(void* arg, int status, int timeouts,  
                           unsigned char* answer_buf, int answer_len) {  
        QueryWrap* wrap = FromCallbackPointer(arg);  
        unsigned char* buf_copy = nullptr;  
        if (status == ARES_SUCCESS) {  
          buf_copy = node::Malloc<unsigned char>(answer_len);  
          memcpy(buf_copy, answer_buf, answer_len);  
        }  
      
        wrap->response_data_ = std::make_unique<ResponseData>();  
        ResponseData* data = wrap->response_data_.get();  
        data->status = status;  
        data->is_host = false;  
        data->buf = MallocedBuffer<unsigned char>(buf_copy, answer_len);  
        // 执行QueueResponseCallback
        wrap->QueueResponseCallback(status);  
    }  
      
    void QueueResponseCallback(int status) {  
        BaseObjectPtr<QueryWrap> strong_ref{this};  
        // 产生一个native immediate任务，在check阶段执行  
        env()->SetImmediate([this, strong_ref](Environment*) {  
           // check阶段执行
          AfterResponse(); 
          // Delete once strong_ref goes out of scope.  
          Detach();  
        });  
      
        channel_->set_query_last_ok(status != ARES_ECONNREFUSED);  
        channel_->ModifyActivityQueryCount(-1);  
    }  
      
      void AfterResponse() {  
        const int status = response_data_->status;  
        // 调用对应的子类的Parse  
        if (status != ARES_SUCCESS) {  
          ParseError(status);  
        } else if (!response_data_->is_host) {  
          Parse(response_data_->buf.data, response_data_->buf.size);
        } else {  
          Parse(response_data_->host.get());  
        }  
      }  
```

任务完成后，Node.js会在check阶段（Node.js v10是使用async handle通知Libuv）加入一个节点，然后check阶段的时候执行对应子类的Parse函数，这里以QueryCnameWrap的Parse为例。

```cpp
    void Parse(unsigned char* buf, int len) override {  
        HandleScope handle_scope(env()->isolate());  
        Context::Scope context_scope(env()->context());  
      
        Local<Array> ret = Array::New(env()->isolate());  
        int type = ns_t_cname;  
        int status = ParseGeneralReply(env(), buf, len, &type, ret);  
        if (status != ARES_SUCCESS) {  
          ParseError(status);  
          return;  
        }  
      
        this->CallOnComplete(ret);  
      }  
```

收到DNS回复后，调用ParseGeneralReply解析回包，然后执行JS层DNS模块的回调。从而执行用户的回调。

```cpp
    void CallOnComplete(Local<Value> answer,  
                        Local<Value> extra = Local<Value>()) {  
      HandleScope handle_scope(env()->isolate());  
      Context::Scope context_scope(env()->context());  
      Local<Value> argv[] = {  
        Integer::New(env()->isolate(), 0),  
        answer,  
        extra  
      };  
      const int argc = arraysize(argv) - extra.IsEmpty();  
      MakeCallback(env()->oncomplete_string(), argc, argv);  
    }  
```
