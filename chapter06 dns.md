
# 第六章 dns
Nodejs的dns模块使用了cares库和libuv的线程池实现。Cares是一个异步dns解析库，他自己实现了dns协议的封包和解析。配合事件驱动机制，就可以实现异步的dns解析。对于通过ip查询域名或者域名查询ip，因为查询函数是操作系统阻塞式的api。所以nodejs是通过libuv的线程池实现异步查询。除了提供直接的dns查询外，nodejs还提供了设置dns服务器、新建一个dns解析实例（Resolver）等功能。
## 6.1 通过域名找ip

```c
1.	dns.lookup('www.a.com', function(err, address, family) {  
2.	        console.log(address);  
3.	});  
Dns的js层实现在dns.js中
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

nodejs设置了一些参数后，调用cares模块（cares_wrap.cc）的getaddrinfo方法，在care_wrap.cc的初始化函数中我们看到， getaddrinfo函数对应的函数是GetAddrInfo。

```c
1.	void Initialize(Local<Object> target,  
2.	                Local<Value> unused,  
3.	                Local<Context> context) {  
4.	  Environment* env = Environment::GetCurrent(context);  
5.	  
6.	  env->SetMethod(target, "getaddrinfo", GetAddrInfo);  
7.	  ...  
8.	}  
```

GetAddrInfo的主要逻辑如下

```c
1.	auto req_wrap = new GetAddrInfoReqWrap(env, req_wrap_obj, args[4]->IsTrue());  
2.	  
3.	struct addrinfo hints;  
4.	memset(&hints, 0, sizeof(struct addrinfo));  
5.	hints.ai_family = family;  
6.	hints.ai_socktype = SOCK_STREAM;  
7.	hints.ai_flags = flags;  
8.	  
9.	int err = uv_getaddrinfo(env->event_loop(),req_wrap->req(), AfterGetAddrInfo,*hostname,nullptr,&hints);  
```

GetAddrInfo是对uv_getaddrinfo的封装，回调函数是AfterGetAddrInfo

```c
1.	int uv_getaddrinfo(uv_loop_t* loop,  
2.	                  // 上层传进来的req  
3.	                   uv_getaddrinfo_t* req,  
4.	                   // 解析完后的上层回调  
5.	                   uv_getaddrinfo_cb cb,  
6.	                   // 需要解析的名字  
7.	                   const char* hostname,  
8.	                   /* 
9.	             查询的过滤条件：服务名。比如http smtp。 
10.	        也可以是一个端口。见下面注释 
11.	        */  
12.	                   const char* service,  
13.	                   // 其他查询过滤条件  
14.	                   const struct addrinfo* hints) {  
15.	   
16.	  size_t hostname_len;  
17.	  size_t service_len;  
18.	  size_t hints_len;  
19.	  size_t len;  
20.	  char* buf;  
21.	  
22.	  hostname_len = hostname ? strlen(hostname) + 1 : 0;  
23.	  service_len = service ? strlen(service) + 1 : 0;  
24.	  hints_len = hints ? sizeof(*hints) : 0;  
25.	  buf = uv__malloc(hostname_len + service_len + hints_len);  
26.	  uv__req_init(loop, req, UV_GETADDRINFO);  
27.	  req->loop = loop;  
28.	  // 设置请求的回调  
29.	  req->cb = cb;  
30.	  req->addrinfo = NULL;  
31.	  req->hints = NULL;  
32.	  req->service = NULL;  
33.	  req->hostname = NULL;  
34.	  req->retcode = 0;  
35.	  len = 0;  
36.	  
37.	  if (hints) {  
38.	    req->hints = memcpy(buf + len, hints, sizeof(*hints));  
39.	    len += sizeof(*hints);  
40.	  }  
41.	  
42.	  if (service) {  
43.	    req->service = memcpy(buf + len, service, service_len);  
44.	    len += service_len;  
45.	  }  
46.	  
47.	  if (hostname)  
48.	    req->hostname = memcpy(buf + len, hostname, hostname_len);  
49.	  // 传了cb是异步  
50.	  if (cb) {  
51.	    uv__work_submit(loop,  
52.	                    &req->work_req,  
53.	                    UV__WORK_SLOW_IO,  
54.	                    uv__getaddrinfo_work,  
55.	                    uv__getaddrinfo_done);  
56.	    return 0;  
57.	  } else {  
58.	    // 阻塞式查询，然后执行回调  
59.	    uv__getaddrinfo_work(&req->work_req);  
60.	    uv__getaddrinfo_done(&req->work_req, 0);  
61.	    return req->retcode;  
62.	  }  
63.	}  
```

我们看到这个函数首先是对一个request进行初始化，然后根据是否传了回调，决定走异步还是同步的模式。同步的方式比较简单，就是直接阻塞libuv事件循环，直到解析完成。如果是异步，则给线程池提交一个慢io的任务。其中工作函数是uv__getaddrinfo_work。回调是uv__getaddrinfo_done。我们看一下这两个函数。

```c
1.	// 解析的工作函数  
2.	static void uv__getaddrinfo_work(struct uv__work* w) {  
3.	  uv_getaddrinfo_t* req;  
4.	  int err;  
5.	  // 根据结构体的字段获取结构体首地址  
6.	  req = container_of(w, uv_getaddrinfo_t, work_req);  
7.	  // 阻塞在这  
8.	  err = getaddrinfo(req->hostname, req->service, req->hints, &req->addrinfo);  
9.	  req->retcode = uv__getaddrinfo_translate_error(err);  
10.	}  
```

工作函数主要是调用了操作系统提供的getaddrinfo去做解析。然后会导致阻塞。结果返回后，执行uv__getaddrinfo_done。

```c
2.	static void uv__getaddrinfo_done(struct uv__work* w, int status) {  
3.	  uv_getaddrinfo_t* req;  
4.	  
5.	  req = container_of(w, uv_getaddrinfo_t, work_req);  
6.	  uv__req_unregister(req->loop, req);  
7.	  // 释放初始化时申请的内存  
8.	  if (req->hints)  
9.	    uv__free(req->hints);  
10.	  else if (req->service)  
11.	    uv__free(req->service);  
12.	  else if (req->hostname)  
13.	    uv__free(req->hostname);  
14.	  else  
15.	    assert(0);  
16.	  
17.	  req->hints = NULL;  
18.	  req->service = NULL;  
19.	  req->hostname = NULL;  
20.	  // 解析请求被用户取消了  
21.	  if (status == UV_ECANCELED) {  
22.	    assert(req->retcode == 0);  
23.	    req->retcode = UV_EAI_CANCELED;  
24.	  }  
25.	  // 执行上层回调  
26.	  if (req->cb)  
27.	    req->cb(req, req->retcode, req->addrinfo);  
28.	  
29.	}  
```

uv__getaddrinfo_done会执行c++层的回调，从而执行js层的回调。
## 6.2 cares
除了通过ip查询域名和域名查询ip外，其余的dns功能都由cares实现，我们看一下cares的基本用法。
### 6.2.1 Cares使用和原理

```c
1.	// channel是cares的核心结构体
2.	ares_channel channel;  
3.	struct ares_options options;  
4.	// 初始化channel
5.	status = ares_init_options(&channel, &options, optmask);  
6.	// 把 argv的数据存到addr
7.	ares_inet_pton(AF_INET, *argv, &addr4);
8.	// 把addr数据存到channel并发起dns查询
9.	ares_gethostbyaddr(channel, &addr4, sizeof(addr4), AF_INET, callback,*argv);  
10.	for (;;)  
11.	    {  
12.	      int res;  
13.	      FD_ZERO(&read_fds);  
14.	      FD_ZERO(&write_fds);  
15.	      // 把channel对应的fd存到read_fd和write_fds  
16.	      nfds = ares_fds(channel, &read_fds, &write_fds);  
17.	      if (nfds == 0)  
18.	        break;  
19.	      // 设置超时时间  
20.	      tvp = ares_timeout(channel, NULL, &tv);  
21.	      // 阻塞在select，等待dns回包  
22.	      res = select(nfds, &read_fds, &write_fds, NULL, tvp);  
23.	      if (-1 == res)  
24.	        break;  
25.	      // 处理dns相应  
26.	      ares_process(channel, &read_fds, &write_fds);  
27.	    }  
```

上面是一个典型的事件驱动模型，首先初始化一些信息，然后发起一个非阻塞的请求，接着阻塞在多路复用api，该api返回后，执行触发了事件的回调。
### 6.2.2 cares_wrap.cc的通用逻辑
在nodejs中，这部分的实现使用了c++模板。

```c
1.	env->SetProtoMethod(channel_wrap, "queryAny", Query<QueryAnyWrap>);  
2.	env->SetProtoMethod(channel_wrap, "queryA", Query<QueryAWrap>);  
3.	env->SetProtoMethod(channel_wrap, "queryAaaa", Query<QueryAaaaWrap>);  
```

Query是c++模板类

```c
1.	template <class Wrap>  
2.	static void Query(const FunctionCallbackInfo<Value>& args) {  
3.	  Environment* env = Environment::GetCurrent(args);  
4.	  ChannelWrap* channel;  
5.	  ASSIGN_OR_RETURN_UNWRAP(&channel, args.Holder());  
6.	  
7.	  CHECK_EQ(false, args.IsConstructCall());  
8.	  CHECK(args[0]->IsObject());  
9.	  CHECK(args[1]->IsString());  
10.	  
11.	  Local<Object> req_wrap_obj = args[0].As<Object>();  
12.	  Local<String> string = args[1].As<String>();  
13.	  Wrap* wrap = new Wrap(channel, req_wrap_obj);  
14.	  
15.	  node::Utf8Value name(env->isolate(), string);  
16.	  channel->ModifyActivityQueryCount(1);  
17.	  int err = wrap->Send(*name);  
18.	  if (err) {  
19.	    channel->ModifyActivityQueryCount(-1);  
20.	    delete wrap;  
21.	  }  
22.	  
23.	  args.GetReturnValue().Set(err);  
24.	}  
```

Query只实现了一些通用的逻辑，然后调用Send函数，具体的Send函数逻辑由各个具体的类实现。
### 6.2.3 cares_wrap.cc基类QueryWrap
QueryWrap是dns模块查询的基类。我们通过queryA函数来分析cares_wrap.cc的实现。queryA对应的类是QueryAWrap。

```c
1.	class QueryAWrap: public QueryWrap {  
2.	 public:  
3.	  QueryAWrap(ChannelWrap* channel, Local<Object> req_wrap_obj)  
4.	      : QueryWrap(channel, req_wrap_obj) {  
5.	  }  
6.	  
7.	  int Send(const char* name) override {  
8.	    AresQuery(name, ns_c_in, ns_t_a);  
9.	    return 0;  
10.	  }  
11.	  
12.	 protected:  
13.	  void Parse(unsigned char* buf, int len) override {  
14.	    // 忽略一些解析逻辑  
15.	    CallOnComplete(ret, ttls);  
16.	  }  
17.	};  
```

我们看到QueryWrap基类的实现非常简单，主要定义Send和Parse的实现。剩下的由基类去处理就可以了，我们看一下基类QueryWrap的实现。

```c
1.	void AresQuery(const char* name,  
2.	                 int dnsclass,  
3.	                 int type) {  
4.	    ares_query(channel_->cares_channel(), name, dnsclass, type, Callback,  
5.	               static_cast<void*>(this));  
6.	  }  
```

AresQuery函数提供统一发送查询操作。查询完成后执行Callback回调。

```c
1.	// cares执行查询完成后，执行的回调  
2.	  static void Callback(void *arg, int status, int timeouts,  
3.	                       unsigned char* answer_buf, int answer_len) {  
4.	    QueryWrap* wrap = static_cast<QueryWrap*>(arg);  
5.	    unsigned char* buf_copy = nullptr;  
6.	    if (status == ARES_SUCCESS) {  
7.	      buf_copy = node::Malloc<unsigned char>(answer_len);  
8.	      memcpy(buf_copy, answer_buf, answer_len);  
9.	    }  
10.	  
11.	    CaresAsyncData* data = new CaresAsyncData();  
12.	    data->status = status;  
13.	    data->wrap = wrap;  
14.	    data->is_host = false;  
15.	    data->data.buf = buf_copy;  
16.	    data->len = answer_len;  
17.	  
18.	    uv_async_t* async_handle = &data->async_handle;  
19.	    CHECK_EQ(0, uv_async_init(wrap->env()->event_loop(),  
20.	                              async_handle,  
21.	                              CaresAsyncCb));  
22.	  
23.	    wrap->channel_->set_query_last_ok(status != ARES_ECONNREFUSED);  
24.	    wrap->channel_->ModifyActivityQueryCount(-1);  
25.	    async_handle->data = data;  
26.	    uv_async_send(async_handle);  
27.	  }  
```

初始化一个async handle和主线程通信。并设置回调为CaresAsyncCb

```c
1.	  // 查询成功后执行的业务回调，解析回包  
2.	  static void CaresAsyncCb(uv_async_t* handle) {  
3.	    auto data = static_cast<struct CaresAsyncData*>(handle->data);  
4.	    QueryWrap* wrap = data->wrap;  
5.	    int status = data->status;  
6.	    wrap->Parse(buf, data->len);  
7.	    uv_close(reinterpret_cast<uv_handle_t*>(handle), CaresAsyncClose);  
8.	  }  	
```

CaresAsyncCb会调用各个子类的Parse方法，这里以QueryAWrap为例。

```c
1.	void Parse(unsigned char* buf, int len) override {  
2.	    HandleScope handle_scope(env()->isolate());  
3.	    Context::Scope context_scope(env()->context());  
4.	  
5.	    ares_addr6ttl addrttls[256];  
6.	    int naddrttls = arraysize(addrttls), status;  
7.	    Local<Array> ret = Array::New(env()->isolate());  
8.	   
9.	    int type = ns_t_aaaa;  
10.	    // 处理回包  
11.	    status = ParseGeneralReply(env(),  
12.	                               buf,  
13.	                               len,  
14.	                               &type,  
15.	                               ret,  
16.	                               addrttls,  
17.	                               &naddrttls);  
18.	    if (status != ARES_SUCCESS) {  
19.	      ParseError(status);  
20.	      return;  
21.	    }  
22.	 	   // 执行oncomplete回调  
23.	  
24.	    CallOnComplete(ret, ttls);  
25.	  }
```

  
收到dns回复后，解析回包，然后执行js层的回调。

```c
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
