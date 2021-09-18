
拓展Node.js从宏观来说，有几种方式，包括直接修改Node.js内核重新编译分发、提供npm包。npm包又可以分为JS和C++拓展。本章主要是介绍修改Node.js内核和写C++插件。
## 20.1 修改Node.js内核
修改Node.js内核的方式也有很多种，我们可以修改JS层、C++、C语言层的代码，也可以新增一些功能或模块。本节分别介绍如何新增一个Node.js的C++模块和修改Node.js内核。相比修改Node.js内核代码，新增一个Node.js内置模块需要了解更多的知识。
### 20.1.1 新增一个内置C++模块
1.首先在src文件夹下新增两个文件。
cyb.h

```
1.	#ifndef SRC_CYB_H_  
2.	#define SRC_CYB_H_  
3.	#include "v8.h"  
4.	  
5.	namespace node {  
6.	class Environment; 
7.	class Cyb {  
8.	 public:  
9.	    static void Initialize(v8::Local<v8::Object> target,  
10.	                 v8::Local<v8::Value> unused,  
11.	                 v8::Local<v8::Context> context,  
12.	                 void* priv);  
13.	  private:  
14.	  static void Console(const v8::FunctionCallbackInfo<v8::Value>& args);  
15.	};  
16.	}  // namespace node  
17.	#endif  
```

cyb.cc

```
1.	#include "cyb.h"  
2.	#include "env-inl.h"  
3.	#include "util-inl.h"  
4.	#include "node_internals.h"  
5.	  
6.	namespace node {  
7.	using v8::Context;  
8.	using v8::Function;  
9.	using v8::FunctionCallbackInfo;  
10.	using v8::FunctionTemplate;  
11.	using v8::Local;  
12.	using v8::Object;  
13.	using v8::String;  
14.	using v8::Value;  
15.	  
16.	void Cyb::Initialize(Local<Object> target,  
17.	           Local<Value> unused,  
18.	           Local<Context> context,  
19.	           void* priv) {  
20.	  Environment* env = Environment::GetCurrent(context);  
21.	  // 申请一个函数模块，模板函数是Console  
22.	  Local<FunctionTemplate> t = env->NewFunctionTemplate(Console); 
23.	  // 申请一个字符串  
24.	  Local<String> str = FIXED_ONE_BYTE_STRING(env->isolate(), 
25.	                                                 "console");  
26.	  // 设置函数名  
27.	  t->SetClassName(str);  
28.	  // 导出函数，target即exports  
29.	  target->Set(env->context(),  
30.	              str,  
31.	              t->GetFunction(env->context()).ToLocalChecke
32.	    d()).Check();  
33.	}  
34.	  
35.	void Cyb::Console(const FunctionCallbackInfo<Value>& args) {  
36.	  v8::Isolate* isolate = args.GetIsolate();  
37.	  v8::Local<String> str = String::NewFromUtf8(isolate, 
38.	                                                   "hello world");  
39.	  args.GetReturnValue().Set(str);  
40.	}  
41.	  
42.	}  // namespace node  
43.	// 声明该模块  
44.	NODE_MODULE_CONTEXT_AWARE_INTERNAL(cyb_wrap, node::Cyb::Initialize)  
```

我们新定义一个模块，是不能自动添加到Node.js内核的，我们还需要额外的操作。  
1 首先我们需要修改node.gyp文件。把我们新增的文件加到配置里，否则编译的时候，不会编译这个新增的模块。我们可以在node.gyp文件中找到src/tcp_wrap.cc,然后在它后面加入我们的文件就行。  

```
1.	src/cyb_wrap.cc  
2.	src/cyb_wrap.h  
```

这时候Node.js会编译我们的代码了。但是Node.js的内置模块有一定的机制，我们的代码加入了Node.js内核，不代表就可以使用了。Node.js在初始化的时候会调用RegisterBuiltinModules函数注册所有的内置C++模块。

```
1.	void RegisterBuiltinModules() {  
2.	#define V(modname) _register_##modname();  
3.	  NODE_BUILTIN_MODULES(V)  
4.	#undef V  
5.	}  
```

我们看到该函数只有一个宏。我们看看这个宏。

```
1.	void RegisterBuiltinModules() {  
2.	#define V(modname) _register_##modname();  
3.	  NODE_BUILTIN_MODULES(V)  
4.	#undef V  
5.	}
6.	#define NODE_BUILTIN_MODULES(V)  \  
7.	  NODE_BUILTIN_STANDARD_MODULES(V)  \  
8.	  NODE_BUILTIN_OPENSSL_MODULES(V)  \  
9.	  NODE_BUILTIN_ICU_MODULES(V)   \  
10.	  NODE_BUILTIN_REPORT_MODULES(V) \  
11.	  NODE_BUILTIN_PROFILER_MODULES(V) \  
12.	  NODE_BUILTIN_DTRACE_MODULES(V)     
```

宏里面又是一堆宏。我们要做的就是修改这个宏。因为我们是自定义的内置模块，所以我们可以增加一个宏。

```
1.	#define NODE_BUILTIN_EXTEND_MODULES(V)  \  
2.	  V(cyb_wrap)   
```
然后把这个宏追加到那一堆宏后面。
```
1.	#define NODE_BUILTIN_MODULES(V)  \  
2.	  NODE_BUILTIN_STANDARD_MODULES(V)  \  
3.	  NODE_BUILTIN_OPENSSL_MODULES(V)  \  
4.	  NODE_BUILTIN_ICU_MODULES(V)   \  
5.	  NODE_BUILTIN_REPORT_MODULES(V) \  
6.	  NODE_BUILTIN_PROFILER_MODULES(V)  \  
7.	  NODE_BUILTIN_DTRACE_MODULES(V) \  
8.	  NODE_BUILTIN_EXTEND_MODULES(V)  
```

这时候，Node.js不仅可以编译我们的代码，还会把我们代码中定义的模块注册到内置C++模块里了，接下来就是如何使用C++模块了。  
2 在lib文件夹新建一个cyb.js，作为Node.js原生模块  

```
1.	const cyb = internalBinding('cyb_wrap');   
2.	module.exports = cyb;  
```

新增原生模块，我们也需要修改node.gyp文件，否则代码也不会被编译进node内核。我们找到node.gyp文件的lib/net.js，在后面追加lib/cyb.js。该配置下的文件是给js2c.py使用的，如果不修改，我们在require的时候，就会找不到该模块。最后我们在lib/internal/bootstrap/loader文件里找到internalBindingWhitelist变量，在数组最后增加cyb_wrap，这个配置是给process.binding函数使用的，如果不修改这个配置，通过process.binding就找不到我们的模块。process.binding是可以在用户JS里使用的。至此，我们完成了所有的修改工作，重新编译Node.js。然后编写测试程序。  
3 新建一个测试文件testcyb.js

```
1.	// const cyb = process.binding('cyb_wrap');  
2.	const cyb = require('cyb');   
3.	console.log(cyb.console())  
```

可以看到，会输出hello world。
### 20.1.2 修改Node.js内核
本节介绍如何修改Node.js内核。修改的部分主要是为了完善Node.js的TCP keepalive功能。目前Node.js的keepalive只支持设置开关以及空闲多久后发送探测包。在新版Linux内核中，TCP keepalive包括以下配置。

```
1 多久没有通信数据包，则开始发送探测包。
2 每隔多久，再次发送探测包。
3 发送多少个探测包后，就认为连接断开。
4 TCP_USER_TIMEOUT，发送了数据，多久没有收到ack后，认为连接断开。
```

Node.js只支持第一条，所以我们的目的是支持2,3,4。因为这个功能是操作系统提供的，所以首先需要修改Libuv的代码。  
1 修改src/unix/tcp.c  
在tcp.c加入以下代码

```
1.	int uv_tcp_keepalive_ex(uv_tcp_t* handle,  
2.	                        int on,  
3.	                        unsigned int delay,  
4.	                        unsigned int interval,  
5.	                        unsigned int count) {  
6.	  int err;  
7.	  
8.	  if (uv__stream_fd(handle) != -1) {  
9.	    err =uv__tcp_keepalive_ex(uv__stream_fd(handle),  
10.	                              on,  
11.	                              delay,  
12.	                              interval,  
13.	                              count);  
14.	    if (err)  
15.	      return err;  
16.	  }  
17.	  
18.	  if (on)  
19.	    handle->flags |= UV_HANDLE_TCP_KEEPALIVE;  
20.	  else  
21.	    handle->flags &= ~UV_HANDLE_TCP_KEEPALIVE;  
22.	 return 0;  
23.	}  
24.	  
25.	int uv_tcp_timeout(uv_tcp_t* handle, unsigned int timeout) {  
26.	  #ifdef TCP_USER_TIMEOUT  
27.	    int fd = uv__stream_fd(handle);  
28.	    if (fd != -1 && setsockopt(fd,  
29.	                               IPPROTO_TCP,  
30.	                               TCP_USER_TIMEOUT,  
31.	                               &timeout,  
32.	                               sizeof(timeout))) {  
33.	      return UV__ERR(errno);   
34.	    }  
35.	  #endif  
36.	    return 0;  
37.	}   
38.	  
39.	int uv__tcp_keepalive_ex(int fd,  
40.	                         int on,   
41.	                         unsigned int delay,  
42.	                         unsigned int interval,  
43.	                         unsigned int count) {  
44.	  if (setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &on, sizeof(on)))  
45.	    return UV__ERR(errno);  
46.	  
47.	#ifdef TCP_KEEPIDLE  
48.	    if (on && delay &&setsockopt(fd,  
49.	                                 IPPROTO_TCP,  
50.	                                 TCP_KEEPIDLE,  
51.	                                 &delay,  
52.	                                 sizeof(delay)))  
53.	      return UV__ERR(errno);  
54.	#endif  
55.	#ifdef TCP_KEEPINTVL  
56.	    if (on && interval && setsockopt(fd,  
57.	                                     IPPROTO_TCP,  
58.	                                     TCP_KEEPINTVL,  
59.	                                     &interval,  
60.	                                     sizeof(interval)))  
61.	      return UV__ERR(errno);  
62.	#endif  
63.	#ifdef TCP_KEEPCNT  
64.	    if (on && count && setsockopt(fd,  
65.	                                  IPPROTO_TCP,  
66.	                                  TCP_KEEPCNT,  
67.	                                  &count,  
68.	                                  sizeof(count)))  
69.	      return UV__ERR(errno);  
70.	#endif  
71.	  /* Solaris/SmartOS, if you don't support keep-alive, 
72.	   * then don't advertise it in your system headers... 
73.	   */  
74.	  /* FIXME(bnoordhuis) That's possibly because sizeof(delay) should be 1. */  
75.	#if defined(TCP_KEEPALIVE) && !defined(__sun)  
76.	  if (on && setsockopt(fd, IPPROTO_TCP, TCP_KEEPALIVE, &delay, sizeof(delay)))  
77.	    return UV__ERR(errno);  
78.	#endif  
79.	  
80.	  return 0;  
81.	}  
```

2 修改include/uv.h   
把在tcp.c中加入的接口暴露出来。

```
1.	UV_EXTERN int uv_tcp_keepalive_ex(uv_tcp_t* handle,  
2.	                                  int enable,  
3.	                                  unsigned int delay,  
4.	                                  unsigned int interval,  
5.	                                  unsigned int count);  
6.	UV_EXTERN int uv_tcp_timeout(uv_tcp_t* handle, unsigned int timeout);  
```

至此，我们就修改完Libuv的代码，也对外暴露了设置的接口，接着我们修改上层的C++和JS代码，使得我们可以在JS层使用该功能。  
3 修改src/tcp_wrap.cc  
修改TCPWrap::Initialize函数的代码。

```
1.	env->SetProtoMethod(t, "setKeepAliveEx", SetKeepAliveEx);  
2.	env->SetProtoMethod(t, "setKeepAliveTimeout", SetKeepAliveTimeout);  
```

首先对JS层暴露两个新的API。我们看看这两个API的定义。

```
1.	void TCPWrap::SetKeepAliveEx(const FunctionCallbackInfo<Value>& args) {  
2.	  TCPWrap* wrap;  
3.	  ASSIGN_OR_RETURN_UNWRAP(&wrap,  
4.	                          args.Holder(),  
5.	                          args.GetReturnValue().Set(UV_EBADF));  
6.	  Environment* env = wrap->env();  
7.	  int enable;  
8.	  if (!args[0]->Int32Value(env->context()).To(&enable)) return;  
9.	  unsigned int delay = static_cast<unsigned int>(args[1].As<Uint32>()->Value());  
10.	  unsigned int detal = static_cast<unsigned int>(args[2].As<Uint32>()->Value());  
11.	  unsigned int count = static_cast<unsigned int>(args[3].As<Uint32>()->Value());  
12.	  int err = uv_tcp_keepalive_ex(&wrap->handle_, enable, delay, detal, count);  
13.	  args.GetReturnValue().Set(err);  
14.	}  
15.	  
16.	void TCPWrap::SetKeepAliveTimeout(const FunctionCallbackInfo<Value>& args) {  
17.	  TCPWrap* wrap;  
18.	  ASSIGN_OR_RETURN_UNWRAP(&wrap,  
19.	                          args.Holder(),  
20.	                          args.GetReturnValue().Set(UV_EBADF));  
21.	  unsigned int time = static_cast<unsigned int>(args[0].As<Uint32>()->Value());  
22.	  int err = uv_tcp_timeout(&wrap->handle_, time);  
23.	  args.GetReturnValue().Set(err);  
24.	}  
```

同时还需要在src/tcp_wrap.h中声明这两个函数。

```
1.	static void SetKeepAliveEx(const v8::FunctionCallbackInfo<v8::Value>& args);  
2.	static void SetKeepAliveTimeout(const v8::FunctionCallbackInfo<v8::Value>& args);  
4 修改lib/net.js
1.	Socket.prototype.setKeepAliveEx = function(setting,  
2.	                                           secs,  
3.	                                           interval,  
4.	                                           count) {  
5.	  if (!this._handle) {  
6.	    this.once('connect', () => this.setKeepAliveEx(setting,  
7.	                                                   secs,  
8.	                                                   interval,  
9.	                                                   count));  
10.	    return this;  
11.	  }  
12.	  
13.	  if (this._handle.setKeepAliveEx)  
14.	    this._handle.setKeepAliveEx(setting,  
15.	                                ~~secs > 0 ? ~~secs : 0,  
16.	                                ~~interval > 0 ? ~~interval : 0,  
17.	                                ~~count > 0 ? ~~count : 0);  
18.	  
19.	  return this;  
20.	};  
21.	  
22.	Socket.prototype.setKeepAliveTimeout = function(timeout) {  
23.	  if (!this._handle) {  
24.	    this.once('connect', () => this.setKeepAliveTimeout(timeout));  
25.	    return this;  
26.	  }  
27.	  
28.	  if (this._handle.setKeepAliveTimeout)  
29.	    this._handle.setKeepAliveTimeout(~~timeout > 0 ? ~~timeout : 0);  
30.	  
31.	  return this;  
32.	};  
```

重新编译Node.js，我们就可以使用这两个新的API更灵活地控制TCP的keepalive了。

```
1.	const net = require('net');  
2.	net.createServer((socket) => {  
3.	  socket.setKeepAliveEx(true, 1,2,3);  
4.	  // socket.setKeepAliveTimeout(4);  
5.	}).listen(1101);  
```

## 20.2 使用N-API编写C++插件
本小节介绍使用N_API编写C++插件知识。Node.js C++插件本质是一个动态链接库，写完编译后，生成一个.node文件。我们在Node.js里直接require使用，Node.js会为我们处理一切。
首先建立一个test.cc文件

```
1.	// hello.cc using N-API  
2.	#include <node_api.h>  
3.	  
4.	namespace demo {  
5.	  
6.	napi_value Method(napi_env env, napi_callback_info args) {  
7.	  napi_value greeting;  
8.	  napi_status status;  
9.	  
10.	  status = napi_create_string_utf8(env, "world", NAPI_AUTO_LENGTH, &greeting);  
11.	  if (status != napi_ok) return nullptr;  
12.	  return greeting;  
13.	}  
14.	  
15.	napi_value init(napi_env env, napi_value exports) {  
16.	  napi_status status;  
17.	  napi_value fn;  
18.	  
19.	  status = napi_create_function(env, nullptr, 0, Method, nullptr, &fn);  
20.	  if (status != napi_ok) return nullptr;  
21.	  
22.	  status = napi_set_named_property(env, exports, "hello", fn);  
23.	  if (status != napi_ok) return nullptr;  
24.	  return exports;  
25.	}  
26.	  
27.	NAPI_MODULE(NODE_GYP_MODULE_NAME, init)  
28.	  
29.	}  // namespace demo  
```

我们不需要具体了解代码的意思，但是从代码中我们大致知道它做了什么事情。剩下的就是阅读N-API的API文档就可以。接着我们新建一个binding.gyp文件。gyp文件是node-gyp的配置文件。node-gyp可以帮助我们针对不同平台生产不同的编译配置文件。比如Linux下的makefile。

```
1.	{  
2.	  "targets": [  
3.	    {  
4.	      "target_name": "test",  
5.	      "sources": [ "./test.cc" ]  
6.	    }  
7.	  ]  
8.	}  
```

语法和makefile有点像，就是定义我们编译后的目前文件名，依赖哪些源文件。然后我们安装node-gyp。

```
npm install node-gyp -g  
```

Node.js源码中也有一个node-gyp，它是帮助npm安装拓展模块时，就地编译用的。我们安装的node-gyp是帮助我们生成配置文件并编译用的，具体可以参考Node.js文档。一切准备就绪。我们开始编译。直接执行

```
node-gyp configure
node-gyp build  
```

在路径./build/Release/下生成了test.node文件。这就是我们的拓展模块。我们编写测试程序app.js。

```
1.	var addon = require("./build/Release/test");  
2.	console.log(addon.hello());  
```

执行
 

```
Node.js app.js  
```

我们看到输出world。我们已经学会了如何编写一个Node.js的拓展模块。剩下的就是阅读N-API文档，根据自己的需求编写不同的模块。
