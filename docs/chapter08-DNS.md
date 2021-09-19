Node.js的DNS模块使用了cares库和Libuv的线程池实现。cares是一个异步DNS解析库，它自己实现了DNS协议的封包和解析，配合Libuv事件驱动机制，在Node.js中实现异步的DNS解析。另外通过IP查询域名或者域名查询IP是直接调用操作系统提供的接口实现的，因为这两个函数是阻塞式的API，所以Node.js是通过Libuv的线程池实现异步查询。除了提供直接的DNS查询外，Node.js还提供了设置DNS服务器、新建一个DNS解析实例（Resolver）等功能。这些功能是使用cares实现的。下面我们开始分析DNS模块的原理和实现。  

## 8.1 通过域名找IP
我们看一下在Node.js中如何查询一个域名对于的IP的信息

```
1.	dns.lookup('www.a.com', function(err, address, family) {  
2.	    console.log(address);  
3.	});  
```

DNS功能的JS层实现在dns.js中

```
1.	const req = new GetAddrInfoReqWrap();  
2.	req.callback = callback;  
3.	req.family = family;  
4.	req.hostname = hostname;  
5.	req.oncomplete = all ? onlookupall : onlookup;  
6.	  
7.	const err = cares.getaddrinfo(  
8.	  req, toASCII(hostname), family, hints, verbatim  
9.	);  
```

Node.js设置了一些参数后，调用cares_wrap.cc的getaddrinfo方法，在care_wrap.cc的初始化函数中我们看到， getaddrinfo函数对应的函数是GetAddrInfo。

```
1.	void Initialize(Local<Object> target,  
2.	                Local<Value> unused,  
3.	                Local<Context> context) {  
4.	  Environment* env = Environment::GetCurrent(context); 
5.	  env->SetMethod(target, "getaddrinfo", GetAddrInfo);  
6.	  ...  
7.	}  
```

GetAddrInfo的主要逻辑如下

```
1.	auto req_wrap = new GetAddrInfoReqWrap(env, req_wrap_obj, args[4]->IsTrue());  
2.	  
3.	struct addrinfo hints;  
4.	memset(&hints, 0, sizeof(struct addrinfo));  
5.	hints.ai_family = family;  
6.	hints.ai_socktype = SOCK_STREAM;  
7.	hints.ai_flags = flags;  
8.	  
9.	int err = uv_getaddrinfo(env->event_loop(),
10.	                            req_wrap->req(), 
11.	                            AfterGetAddrInfo,
12.	                            *hostname,
13.	                            nullptr,
14.	                            &hints);  
```

GetAddrInfo是对uv_getaddrinfo的封装，回调函数是AfterGetAddrInfo

```
1.	int uv_getaddrinfo(uv_loop_t* loop,  
2.	                    // 上层传进来的req  
3.	                   uv_getaddrinfo_t* req,  
4.	                   // 解析完后的上层回调  
5.	                   uv_getaddrinfo_cb cb,  
6.	                   // 需要解析的名字  
7.	                   const char* hostname,  
8.	                   /* 
9.	                           查询的过滤条件：服务名。比如
10.	                                        http smtp。也可以是一个端口。
11.	                                        见下面注释 
12.	                              */  
13.	                   const char* service,  
14.	                   // 其它查询过滤条件  
15.	                   const struct addrinfo* hints) {  
16.	   
17.	  size_t hostname_len;  
18.	  size_t service_len;  
19.	  size_t hints_len;  
20.	  size_t len;  
21.	  char* buf;  
22.	  
23.	  hostname_len = hostname ? strlen(hostname) + 1 : 0;  
24.	  service_len = service ? strlen(service) + 1 : 0;  
25.	  hints_len = hints ? sizeof(*hints) : 0;  
26.	  buf = uv__malloc(hostname_len + service_len + hints_len);  
27.	  uv__req_init(loop, req, UV_GETADDRINFO);  
28.	  req->loop = loop;  
29.	  // 设置请求的回调  
30.	  req->cb = cb;  
31.	  req->addrinfo = NULL;  
32.	  req->hints = NULL;  
33.	  req->service = NULL;  
34.	  req->hostname = NULL;  
35.	  req->retcode = 0;  
36.	  len = 0;  
37.	  
38.	  if (hints) {  
39.	    req->hints = memcpy(buf + len, hints, sizeof(*hints));  
40.	    len += sizeof(*hints);  
41.	  }  
42.	  
43.	  if (service) {  
44.	    req->service = memcpy(buf + len, service, service_len); 
45.	    len += service_len;  
46.	  }  
47.	  
48.	  if (hostname)  
49.	    req->hostname = memcpy(buf + len, hostname, hostname_len);
50.	  // 传了cb则是异步  
51.	  if (cb) {  
52.	    uv__work_submit(loop,  
53.	            &req->work_req,  
54.	            UV__WORK_SLOW_IO,  
55.	            uv__getaddrinfo_work,  
56.	            uv__getaddrinfo_done);  
57.	    return 0;  
58.	  } else {  
59.	    // 阻塞式查询，然后执行回调  
60.	    uv__getaddrinfo_work(&req->work_req);  
61.	    uv__getaddrinfo_done(&req->work_req, 0);  
62.	    return req->retcode;  
63.	  }  
64.	}  
```

我们看到这个函数首先是对一个request进行初始化，然后根据是否传了回调，决定走异步还是同步的模式。同步的方式比较简单，就是直接阻塞Libuv事件循环，直到解析完成。如果是异步，则给线程池提交一个慢IO的任务。其中工作函数是uv__getaddrinfo_work。回调是uv__getaddrinfo_done。我们看一下这两个函数。

```
1.	// 解析的工作函数  
2.	static void uv__getaddrinfo_work(struct uv__work* w) {  
3.	  uv_getaddrinfo_t* req;  
4.	  int err;  
5.	  // 根据结构体的字段获取结构体首地址  
6.	  req = container_of(w, uv_getaddrinfo_t, work_req);  
7.	  // 阻塞在这  
8.	  err = getaddrinfo(req->hostname, 
9.	                        req->service, 
10.	                        req->hints, 
11.	                        &req->addrinfo);  
12.	  req->retcode = uv__getaddrinfo_translate_error(err);  
13.	}  
```

uv__getaddrinfo_work函数主要是调用了系统提供的getaddrinfo去做解析。该函数会导致进程阻塞。结果返回后，执行uv__getaddrinfo_done。

```
1.	static void uv__getaddrinfo_done(struct uv__work* w, int status) {  
2.	  uv_getaddrinfo_t* req;  
3.	  
4.	  req = container_of(w, uv_getaddrinfo_t, work_req);  
5.	  uv__req_unregister(req->loop, req);  
6.	  // 释放初始化时申请的内存  
7.	  if (req->hints)  
8.	    uv__free(req->hints);  
9.	  else if (req->service)  
10.	    uv__free(req->service);  
11.	  else if (req->hostname)  
12.	    uv__free(req->hostname);  
13.	  else  
14.	    assert(0);  
15.	  
16.	  req->hints = NULL;  
17.	  req->service = NULL;  
18.	  req->hostname = NULL;  
19.	  // 解析请求被用户取消了  
20.	  if (status == UV_ECANCELED) {  
21.	    assert(req->retcode == 0);  
22.	    req->retcode = UV_EAI_CANCELED;  
23.	  }  
24.	  // 执行上层回调  
25.	  if (req->cb)  
26.	    req->cb(req, req->retcode, req->addrinfo);  
27.	  
28.	}  
```

uv__getaddrinfo_done会执行C++层的回调，从而执行JS层的回调。
## 8.2 cares
除了通过IP查询域名和域名查询IP外，其余的DNS功能都由cares实现，我们看一下cares的基本用法。
### 8.2.1 cares使用和原理

```
1.	// channel是cares的核心结构体
2.	ares_channel channel;  
3.	struct ares_options options;  
4.	// 初始化channel
5.	status = ares_init_options(&channel, &options, optmask);  
6.	// 把 argv的数据存到addr
7.	ares_inet_pton(AF_INET, *argv, &addr4);
8.	// 把addr数据存到channel并发起DNS查询
9.	ares_gethostbyaddr(channel, 
10.	                   &addr4, 
11.	                   sizeof(addr4), 
12.	                   AF_INET, 
13.	                   callback,*argv);  
14.	for (;;)  
15.	    {  
16.	      int res;  
17.	      FD_ZERO(&read_fds);  
18.	      FD_ZERO(&write_fds);  
19.	      // 把channel对应的fd存到read_fd和write_fds  
20.	      nfds = ares_fds(channel, &read_fds, &write_fds);  
21.	      if (nfds == 0)  
22.	        break;  
23.	      // 设置超时时间  
24.	      tvp = ares_timeout(channel, NULL, &tv);  
25.	      // 阻塞在select，等待DNS回包  
26.	      res = select(nfds, &read_fds, &write_fds, NULL, tvp);
27.	      if (-1 == res)  
28.	        break;  
29.	      // 处理DNS相应  
30.	      ares_process(channel, &read_fds, &write_fds);  
31.	    }  
```

上面是一个典型的事件驱动模型，首先初始化一些信息，然后发起一个非阻塞的请求，接着阻塞在多路复用API，该API返回后，执行触发了事件的回调。
### 8.2.2 cares_wrap.cc的通用逻辑
在Node.js中，Node.js和cares的整体交互如图8-1所示。    
![](https://img-blog.csdnimg.cn/cf528843e4ac4b1c8ce03407f502083d.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图8-1. 

我们通过cares_wrap.cc分析其中的原理。我们从DNS模块提供的resolveCname函数开始。resolveCname函数由以下代码导出（dns.js）。
```
bindDefaultResolver(module.exports, getDefaultResolver())  
```
我们看一下这两个函数（dns/utils.js）。

```
1.	class Resolver {  
2.	  constructor() {  
3.	    this._handle = new ChannelWrap();  
4.	  }  
5.	  // ...  
6.	}  
7.	  
8.	let defaultResolver = new Resolver();  
9.	  
10.	function getDefaultResolver() {  
11.	  return defaultResolver;  
12.	}  
13.	  
14.	function resolver(bindingName) {  
15.	  function query(name, /* options, */ callback) {  
16.	    let options;  
17.	    const req = new QueryReqWrap();  
18.	    req.bindingName = bindingName;  
19.	    req.callback = callback;  
20.	    req.hostname = name;  
21.	    req.oncomplete = onresolve;  
22.	    req.ttl = !!(options && options.ttl);  
23.	    const err = this._handle[bindingName](req, toASCII(name));  
24.	    if (err) throw dnsException(err, bindingName, name);  
25.	    return req;  
26.	  }  
27.	  ObjectDefineProperty(query, 'name', { value: bindingName });  
28.	  return query;  
29.	}  
30.	// 给原型链注入一个新的属性，defaultResolver中也生效  
31.	Resolver.prototype.resolveCname = resolveMap.CNAME = resolver('queryCname');  
```

getDefaultResolver导出的是一个Resolve对象，里面有resolveCname等一系列方法。接着看一下bindDefaultResolver，我们一会再看ChannelWrap。

```
1.	const resolverKeys = [ 
2.	  'resolveCname ',  
3.	  // …
4.	]  
5.	function bindDefaultResolver(target, source) {  
6.	  resolverKeys.forEach((key) => {  
7.	    target[key] = source[key].bind(defaultResolver);  
8.	  });  
9.	}  
```

看起来很绕，其实就是把Resolve对象的方法导出到DNS模块。这样用户就可以使用了。我们看到resolveCname是由resolver函数生成的，resolver函数对cares系列函数进行了封装，最终调用的是this._handle.queryCname函数。我们来看一下这个handle（ChannelWrap类对象）的实现（cares_wrap.cc）。我们先看一下cares_wrap.cc模块导出的API。

```
1.	Local<FunctionTemplate> channel_wrap = env->NewFunctionTemplate(ChannelWrap::New);  
2.	channel_wrap->InstanceTemplate()->SetInternalFieldCount(1);  
3.	channel_wrap->Inherit(AsyncWrap::GetConstructorTemplate(env));  
4.	// Query是C++函数模板
5.	env->SetProtoMethod(channel_wrap, 
6.	                      "queryCname", 
7.	                      Query<QueryCnameWrap>);  
8.	// ...  
9.	Local<String> channelWrapString = FIXED_ONE_BYTE_STRING(env->isolate(), "ChannelWrap");  
10.	channel_wrap->SetClassName(channelWrapString);  
11.	target->Set(env->context(), 
12.	channelWrapString,channel_wrap->GetFunction(context).ToLocalChecked()).Check();  
```

handle对应的就是以上代码导出的对象。当我们在JS层执行new ChannelWrap的时候。
最终会调用C++层创建一个对象，并且执行ChannelWrap::New。

```
1.	void ChannelWrap::New(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	  new ChannelWrap(env, args.This());  
4.	}  
```

我们看一下类ChannelWrap的定义。

```
1.	class ChannelWrap : public AsyncWrap {  
2.	 public:  
3.	  // ...  
4.	  
5.	 private:  
6.	  // 超时管理  
7.	  uv_timer_t* timer_handle_;  
8.	  // cares数据类型  
9.	  ares_channel channel_;  
10.	  // 标记查询结果  
11.	  bool query_last_ok_;  
12.	  // 使用的DNS服务器  
13.	  bool is_servers_default_;  
14.	  // 是否已经初始化cares库  
15.	  bool library_inited_;  
16.	  // 正在发起的查询个数  
17.	  int active_query_count_;  
18.	  // 发起查询的任务队列  
19.	  node_ares_task_list task_list_;  
20.	};  
```

接着我们看看ChannelWrap构造函数的代码。

```
1.	ChannelWrap::ChannelWrap(...) {  
2.	  Setup();  
3.	}  
```

ChannelWrap里直接调用了Setup

```
1.	void ChannelWrap::Setup() {  
2.	  struct ares_options options;  
3.	  memset(&options, 0, sizeof(options));  
4.	  options.flags = ARES_FLAG_NOCHECKRESP;   
5.	  /*
6.	    caresd socket状态（读写）发生变更时，执行的函数，
7.	    第一个入参是sock_state_cb_data
8.	  */
9.	  options.sock_state_cb = ares_sockstate_cb;  
10.	 options.sock_state_cb_data = this;  
11.	  
12.	 // 还没初始化则初始化 
13.	 if (!library_inited_) {  
14.	   Mutex::ScopedLock lock(ares_library_mutex);  
15.	   // 初始化cares库  
16.	   ares_library_init(ARES_LIB_INIT_ALL);  
17.	 }  
18.	 // 设置使用cares的配置  
19.	 ares_init_options(&channel_,  
20.	                       &options,  
21.	                       ARES_OPT_FLAGS | ARES_OPT_SOCK_STATE_CB);
22.	 library_inited_ = true;  
23.	}  
```

我们看到，Node.js在这里初始化cares相关的逻辑。其中最重要的就是设置了cares socket状态变更时执行的回调ares_sockstate_cb（比如socket需要读取数据或者写入数据）。前面的cares使用例子中讲到了cares和事件驱动模块的配合使用，那么cares和Libuv是如何配合的呢？cares提供了一种机制，就是socket状态变更时通知事件驱动模块。DNS解析本质上也是网络IO，所以发起一个DNS查询也就是对应一个socket。DNS查询是由cares发起的，这就意味着socket是在cares中维护的，那Libuv怎么知道呢？正是cares提供的通知机制，使得Libuv知道发起DNS查询对应的socket，从而注册到Libuv中，等到事件触发后，再通知cares。下面我们看一下具体的实现。我们从发起一个cname查询开始分析。首先回顾一下cares_wrap模块导出的cname查询函数，
env->SetProtoMethod(channel_wrap, "queryCname", Query<QueryCnameWrap>);Query是C++模板函数，QueryCnameWrap是C++类

```
1.	template <class Wrap>  
2.	static void Query(const FunctionCallbackInfo<Value>& args) {  
3.	  Environment* env = Environment::GetCurrent(args);  
4.	  ChannelWrap* channel;  
5.	    // Holder中保存了ChannelWrap对象，解包出来
6.	  ASSIGN_OR_RETURN_UNWRAP(&channel, args.Holder());  
7.	  Local<Object> req_wrap_obj = args[0].As<Object>();  
8.	  Local<String> string = args[1].As<String>();  
9.	    /*
10.	      根据参数新建一个对象，这里是QueryCnameWrap，
11.	      并且保存对应的ChannelWrap对象和操作相关的对象
12.	    */
13.	  Wrap* wrap = new Wrap(channel, req_wrap_obj);  
14.	  
15.	  node::Utf8Value name(env->isolate(), string);
16.	    // 发起请求数加一  
17.	  channel->ModifyActivityQueryCount(1);  
18.	    // 调用Send函数发起查询
19.	  int err = wrap->Send(*name);  
20.	  if (err) {  
21.	    channel->ModifyActivityQueryCount(-1);  
22.	    delete wrap;  
23.	  }  
24.	  
25.	  args.GetReturnValue().Set(err);  
26.	}  
```

Query只实现了一些通用的逻辑，然后调用Send函数，具体的Send函数逻辑由各个具体的类实现。
### 8.2.3 具体实现
我们看一下QueryCnameWrap类。

```
1.	class QueryCnameWrap: public QueryWrap {  
2.	 public:  
3.	  QueryCnameWrap(ChannelWrap* channel, 
4.	                   Local<Object> req_wrap_obj)  
5.	      : QueryWrap(channel, req_wrap_obj, "resolveCname") {  
6.	  }  
7.	  
8.	  int Send(const char* name) override {  
9.	     AresQuery(name, ns_c_in, ns_t_cname);  
10.	    return 0;  
11.	  }  
12.	  
13.	 protected:  
14.	  void Parse(unsigned char* buf, int len) override {  
15.	    HandleScope handle_scope(env()->isolate());  
16.	    Context::Scope context_scope(env()->context());  
17.	  
18.	    Local<Array> ret = Array::New(env()->isolate());  
19.	    int type = ns_t_cname;  
20.	    int status = ParseGeneralReply(env(), buf, len, &type, ret);  
21.	    if (status != ARES_SUCCESS) {  
22.	      ParseError(status);  
23.	      return;  
24.	    }  
25.	  
26.	    this->CallOnComplete(ret);  
27.	  }  
28.	};  
```

我们看到QueryCnameWrap类的实现非常简单，主要定义Send和Parse的实现，最终还是会调用基类对应的函数。我们看一下基类QueryWrap中AresQuery的实现。

```
1.	void AresQuery(const char* name,  
2.	        int dnsclass,  
3.	        int type) {  
4.	    ares_query(channel_->cares_channel(), 
5.	                   name, 
6.	                   dnsclass, 
7.	                   type, 
8.	                   Callback,  
9.	          static_cast<void*>(this));  
10.	  }  
```

AresQuery函数提供统一发送查询操作。查询完成后执行Callback回调。接下来就涉及到cares和Node.js的具体交互了。Node.js把一个任务交给cares后，cares会新建一个socket，接着cares会通过Node.js设置的回调ares_sockstate_cb通知Node.js。我们看一下ares_query的关键逻辑。

```
1.	void ares_query(ares_channel channel, const char *name, int dnsclass,  
2.	                int type, ares_callback callback, void *arg)  
3.	{  
4.	  struct qquery *qquery;  
5.	  unsigned char *qbuf;  
6.	  int qlen, rd, status;  
7.	  
8.	  qquery = ares_malloc(sizeof(struct qquery));  
9.	  // 保存Node.js的回调，查询完成时回调  
10.	  qquery->callback = callback;  
11.	  qquery->arg = arg;  
12.	  ares_send(channel, qbuf, qlen, qcallback, qquery);  
13.	}  
14.	
15.	static void qcallback(void *arg, int status, int timeouts, unsigned char *abuf, int alen)  
16.	{  
17.	  struct qquery *qquery = (struct qquery *) arg;  
18.	  unsigned int ancount;  
19.	  int rcode;  
20.	  
21.	  if (status != ARES_SUCCESS)  
22.	    qquery->callback(qquery->arg, status, timeouts, abuf, alen);
23.	  else  
24.	    {  
25.	      // ...  
26.	      // 执行Node.js回调  
27.	      qquery->callback(qquery->arg, 
28.	                          status,
29.	                          timeouts, 
30.	                          abuf, 
31.	                          alen);  
32.	    }  
33.	  ares_free(qquery);  
34.	}  
35.	
```

ares_query保存了Node.js的回调，并且设置回调qcallback，查询成功后会回调qcallback，qcallback再回调Node.js。接着执行ares_send，ares_send会调用ares__send_query。

```
1.	void ares__send_query(ares_channel channel, 
2.	                        struct query *query,  
3.	                      struct timeval *now)  
4.	{  
5.	    struct server_state *server = &channel->servers[query->server];  
6.	    if (server->udp_socket == ARES_SOCKET_BAD)  
7.	        {  
8.	          // 申请一个socket  
9.	          if (open_udp_socket(channel, server) == -1)  
10.	            {  
11.	              skip_server(channel, query, query->server);  
12.	              next_server(channel, query, now);  
13.	              return;  
14.	            }  
15.	        }  
16.	      // 发送DNS查询  
17.	      if (socket_write(channel, server->udp_socket, query->qbuf, query->qlen) == -1)  
18.	        {  
19.	          skip_server(channel, query, query->server);  
20.	          next_server(channel, query, now);  
21.	          return;  
22.	        }  
23.	}  
```

ares__send_query首先申请一个socket，然后发送数据。因为UDP不是面向连接的，可以直接发送。我们看一下open_udp_socket。

```
1.	static int open_udp_socket(ares_channel channel, struct server_state *server)  
2.	{  
3.	  ares_socket_t s;  
4.	  ares_socklen_t salen;  
5.	  union {  
6.	    struct sockaddr_in  sa4;  
7.	    struct sockaddr_in6 sa6;  
8.	  } saddr;  
9.	  struct sockaddr *sa;  
10.	  
11.	  // 申请一个socket  
12.	  s = open_socket(channel, server->addr.family, SOCK_DGRAM, 0); 
13.	  // 绑定服务器地址  
14.	  connect_socket(channel, s, sa, salen)  
15.	    
16.	  // 通知Node.js，1,0表示对socket的读事件感兴趣，因为发送了请求，等待响应  
17.	  SOCK_STATE_CALLBACK(channel, s, 1, 0);  
18.	  // 保存socket
19.	  server->udp_socket = s;  
20.	  return 0;  
21.	}  
22.	
23.	#define SOCK_STATE_CALLBACK(c, s, r, w)                                 \  
24.	  do {                                                                  \  
25.	    if ((c)->sock_state_cb)                                             \  
26.	      (c)->sock_state_cb((c)->sock_state_cb_data, (s), (r), (w));       \  
27.	  } WHILE_FALSE  
28.	
```

ares__send_query函数做了三件事
1 申请了socket，
2 通知Node.js
3 发送了DNS查询请求
这时候流程走到了Node.js，我们看一下cares回调Node.js的时候，Node.js怎么处理的

```
1.	struct node_ares_task : public MemoryRetainer {  
2.	  ChannelWrap* channel;  
3.	  // 关联的socket  
4.	  ares_socket_t sock;  
5.	  // IO观察者和回调  
6.	  uv_poll_t poll_watcher;  
7.	};  
8.	  
9.	void ares_sockstate_cb(void* data,  
10.	                       ares_socket_t sock,  
11.	                       int read,  
12.	                       int write) {  
13.	  ChannelWrap* channel = static_cast<ChannelWrap*>(data);  
14.	  node_ares_task* task;  
15.	  // 任务  
16.	  node_ares_task lookup_task;  
17.	  lookup_task.sock = sock;  
18.	  // 该任务是否已经存在  
19.	  auto it = channel->task_list()->find(&lookup_task);  
20.	  
21.	  task = (it == channel->task_list()->end()) ? nullptr : *it;  
22.	  
23.	  if (read || write) {  
24.	    if (!task) {  
25.	      // 开启定时器，超时后通知cares  
26.	      channel->StartTimer();  
27.	      // 创建一个任务  
28.	      task = ares_task_create(channel, sock);  
29.	      // 保存到任务列表  
30.	      channel->task_list()->insert(task);  
31.	    }  
32.	    // 注册IO观察者到epoll，感兴趣的事件根据cares传的进行设置，有事件触发后执行回调ares_poll_cb  
33.	    uv_poll_start(&task->poll_watcher,  
34.	                  (read ? UV_READABLE : 0) | (write ? UV_WRITABLE : 0),  
35.	                  ares_poll_cb);  
36.	  
37.	  } else {  
38.	    // socket关闭了，删除任务  
39.	    channel->task_list()->erase(it);  
40.	    // 关闭该任务对应观察者io，然后删除删除该任务  
41.	    channel->env()->CloseHandle(&task->poll_watcher, ares_poll_close_cb);  
42.	    // 没有任务了，关闭定时器  
43.	    if (channel->task_list()->empty()) {  
44.	      channel->CloseTimer();  
45.	    }  
46.	  }  
47.	}  
```

每一个DNS查询的任务，在Node.js中用node_ares_task 管理。它封装了请求对应的channel、查询请求对应的socket和uv_poll_t。我们看一下ares_task_create

```
1.	node_ares_task* ares_task_create(ChannelWrap* channel, ares_socket_t sock) {  
2.	  auto task = new node_ares_task();  
3.	  
4.	  task->channel = channel;  
5.	  task->sock = sock;  
6.	  // 初始化uv_poll_t，保存文件描述符sock到uv_poll_t  
7.	  if (uv_poll_init_socket(channel->env()->event_loop(),&task->poll_watcher, sock) < 0) {  
8.	    delete task;  
9.	    return nullptr;  
10.	  }  
11.	  
12.	  return task;  
13.	}  
```

首先创建一个node_ares_task对象。然后初始化uv_poll_t并且把文件描述符保存到uv_poll_t。uv_poll_t是对文件描述符、回调、IO观察者的封装。文件描述符的事件触发时，会执行IO观察者的回调，从而执行uv_poll_t保存的回调。我们继续回到ares_sockstate_cb，当cares通知Node.js socket状态变更的时候，Node.js就会修改epoll节点的配置（感兴趣的事件）。当事件触发的时候，会执行ares_poll_cb。我们看一下该函数。

```
1.	void ares_poll_cb(uv_poll_t* watcher, int status, int events) {  
2.	  node_ares_task* task = ContainerOf(&node_ares_task::poll_watcher, watcher);  
3.	  ChannelWrap* channel = task->channel;  
4.	  
5.	  // 有事件触发，重置超时时间  
6.	  uv_timer_again(channel->timer_handle());  
7.	  
8.	  // 通知cares处理响应  
9.	  ares_process_fd(channel->cares_channel(),  
10.	                  events & UV_READABLE ? task->sock : ARES_SOCKET_BAD,  
11.	                  events & UV_WRITABLE ? task->sock : ARES_SOCKET_BAD);  
12.	}  
```

当socket上感兴趣的事件触发时，Node.js调ares_process_fd处理。真正的处理函数是processfds。

```
1.	static void processfds(ares_channel channel,  
2.	                       fd_set *read_fds, ares_socket_t read_fd,  
3.	                       fd_set *write_fds, ares_socket_t write_fd)  
4.	{  
5.	  struct timeval now = ares__tvnow();  
6.	  
7.	  write_tcp_data(channel, write_fds, write_fd, &now);  
8.	  read_tcp_data(channel, read_fds, read_fd, &now);  
9.	  read_udp_packets(channel, read_fds, read_fd, &now);  
10.	 process_timeouts(channel, &now);  
11.	 process_broken_connections(channel, &now);  
12.	}  
```

processfds是统一的处理函数，在各自函数内会做相应的判断和处理。我们这里是收到了UDP响应。则会执行read_udp_packets

```
1.	static void read_udp_packets(ares_channel channel, fd_set *read_fds,  
2.	                             ares_socket_t read_fd, struct timeval *now){  
3.	// 读取响应  
4.	count = socket_recvfrom(channel, server->udp_socket, (void *)buf, sizeof(buf), 0, &from.sa, &fromlen);  
5.	// 处理响应，最终调用query->callback回调Node.js  
6.	process_answer(channel, buf, (int)count, i, 0, now);  
7.	}  
```

Cares读取响应然后解析响应，最后回调Node.js。Node.js设置的回调函数是Callback

```
1.	static void Callback(void* arg, int status, int timeouts,  
2.	                       unsigned char* answer_buf, int answer_len) {  
3.	    QueryWrap* wrap = FromCallbackPointer(arg);  
4.	    unsigned char* buf_copy = nullptr;  
5.	    if (status == ARES_SUCCESS) {  
6.	      buf_copy = node::Malloc<unsigned char>(answer_len);  
7.	      memcpy(buf_copy, answer_buf, answer_len);  
8.	    }  
9.	  
10.	    wrap->response_data_ = std::make_unique<ResponseData>();  
11.	    ResponseData* data = wrap->response_data_.get();  
12.	    data->status = status;  
13.	    data->is_host = false;  
14.	    data->buf = MallocedBuffer<unsigned char>(buf_copy, answer_len);  
15.	    // 执行QueueResponseCallback
16.	    wrap->QueueResponseCallback(status);  
17.	}  
18.	  
19.	void QueueResponseCallback(int status) {  
20.	    BaseObjectPtr<QueryWrap> strong_ref{this};  
21.	    // 产生一个native immediate任务，在check阶段执行  
22.	    env()->SetImmediate([this, strong_ref](Environment*) {  
23.	       // check阶段执行
24.	      AfterResponse(); 
25.	      // Delete once strong_ref goes out of scope.  
26.	      Detach();  
27.	    });  
28.	  
29.	    channel_->set_query_last_ok(status != ARES_ECONNREFUSED);  
30.	    channel_->ModifyActivityQueryCount(-1);  
31.	}  
32.	  
33.	  void AfterResponse() {  
34.	    const int status = response_data_->status;  
35.	    // 调用对应的子类的Parse  
36.	    if (status != ARES_SUCCESS) {  
37.	      ParseError(status);  
38.	    } else if (!response_data_->is_host) {  
39.	      Parse(response_data_->buf.data, response_data_->buf.size);
40.	    } else {  
41.	      Parse(response_data_->host.get());  
42.	    }  
43.	  }  
```

任务完成后，Node.js会在check阶段（Node.js v10是使用async handle通知Libuv）加入一个节点，然后check阶段的时候执行对应子类的Parse函数，这里以QueryCnameWrap的Parse为例。

```
1.	void Parse(unsigned char* buf, int len) override {  
2.	    HandleScope handle_scope(env()->isolate());  
3.	    Context::Scope context_scope(env()->context());  
4.	  
5.	    Local<Array> ret = Array::New(env()->isolate());  
6.	    int type = ns_t_cname;  
7.	    int status = ParseGeneralReply(env(), buf, len, &type, ret);  
8.	    if (status != ARES_SUCCESS) {  
9.	      ParseError(status);  
10.	      return;  
11.	    }  
12.	  
13.	    this->CallOnComplete(ret);  
14.	  }  
```

收到DNS回复后，调用ParseGeneralReply解析回包，然后执行JS层DNS模块的回调。从而执行用户的回调。

```
1.	void CallOnComplete(Local<Value> answer,  
2.	                    Local<Value> extra = Local<Value>()) {  
3.	  HandleScope handle_scope(env()->isolate());  
4.	  Context::Scope context_scope(env()->context());  
5.	  Local<Value> argv[] = {  
6.	    Integer::New(env()->isolate(), 0),  
7.	    answer,  
8.	    extra  
9.	  };  
10.	  const int argc = arraysize(argv) - extra.IsEmpty();  
11.	  MakeCallback(env()->oncomplete_string(), argc, argv);  
12.	}  
```
