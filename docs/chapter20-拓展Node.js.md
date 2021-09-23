
拓展Node.js从宏观来说，有几种方式，包括直接修改Node.js内核重新编译分发、提供npm包。npm包又可以分为JS和C++拓展。本章主要是介绍修改Node.js内核和写C++插件。
## 20.1 修改Node.js内核
修改Node.js内核的方式也有很多种，我们可以修改JS层、C++、C语言层的代码，也可以新增一些功能或模块。本节分别介绍如何新增一个Node.js的C++模块和修改Node.js内核。相比修改Node.js内核代码，新增一个Node.js内置模块需要了解更多的知识。
### 20.1.1 新增一个内置C++模块
1.首先在src文件夹下新增两个文件。
cyb.h

```cpp
    #ifndef SRC_CYB_H_  
    #define SRC_CYB_H_  
    #include "v8.h"  
      
    namespace node {  
    class Environment; 
    class Cyb {  
     public:  
        static void Initialize(v8::Local<v8::Object> target,  
                     v8::Local<v8::Value> unused,  
                     v8::Local<v8::Context> context,  
                     void* priv);  
      private:  
      static void Console(const v8::FunctionCallbackInfo<v8::Value>& args);  
    };  
    }  // namespace node  
    #endif  
```

cyb.cc

```cpp
    #include "cyb.h"  
    #include "env-inl.h"  
    #include "util-inl.h"  
    #include "node_internals.h"  
      
    namespace node {  
    using v8::Context;  
    using v8::Function;  
    using v8::FunctionCallbackInfo;  
    using v8::FunctionTemplate;  
    using v8::Local;  
    using v8::Object;  
    using v8::String;  
    using v8::Value;  
      
    void Cyb::Initialize(Local<Object> target,  
               Local<Value> unused,  
               Local<Context> context,  
               void* priv) {  
      Environment* env = Environment::GetCurrent(context);  
      // 申请一个函数模块，模板函数是Console  
      Local<FunctionTemplate> t = env->NewFunctionTemplate(Console); 
      // 申请一个字符串  
      Local<String> str = FIXED_ONE_BYTE_STRING(env->isolate(), 
                                                     "console");  
      // 设置函数名  
      t->SetClassName(str);  
      // 导出函数，target即exports  
      target->Set(env->context(),  
                  str,  
                  t->GetFunction(env->context()).ToLocalChecke
        d()).Check();  
    }  
      
    void Cyb::Console(const FunctionCallbackInfo<Value>& args) {  
      v8::Isolate* isolate = args.GetIsolate();  
      v8::Local<String> str = String::NewFromUtf8(isolate, 
                                                       "hello world");  
      args.GetReturnValue().Set(str);  
    }  
      
    }  // namespace node  
    // 声明该模块  
    NODE_MODULE_CONTEXT_AWARE_INTERNAL(cyb_wrap, node::Cyb::Initialize)  
```

我们新定义一个模块，是不能自动添加到Node.js内核的，我们还需要额外的操作。  
1 首先我们需要修改node.gyp文件。把我们新增的文件加到配置里，否则编译的时候，不会编译这个新增的模块。我们可以在node.gyp文件中找到src/tcp_wrap.cc,然后在它后面加入我们的文件就行。  

```text
    src/cyb_wrap.cc  
    src/cyb_wrap.h  
```

这时候Node.js会编译我们的代码了。但是Node.js的内置模块有一定的机制，我们的代码加入了Node.js内核，不代表就可以使用了。Node.js在初始化的时候会调用RegisterBuiltinModules函数注册所有的内置C++模块。

```cpp
    void RegisterBuiltinModules() {  
    #define V(modname) _register_##modname();  
      NODE_BUILTIN_MODULES(V)  
    #undef V  
    }  
```

我们看到该函数只有一个宏。我们看看这个宏。

```cpp
    void RegisterBuiltinModules() {  
    #define V(modname) _register_##modname();  
      NODE_BUILTIN_MODULES(V)  
    #undef V  
    }
    #define NODE_BUILTIN_MODULES(V)  \  
      NODE_BUILTIN_STANDARD_MODULES(V)  \  
      NODE_BUILTIN_OPENSSL_MODULES(V)  \  
      NODE_BUILTIN_ICU_MODULES(V)   \  
      NODE_BUILTIN_REPORT_MODULES(V) \  
      NODE_BUILTIN_PROFILER_MODULES(V) \  
      NODE_BUILTIN_DTRACE_MODULES(V)     
```

宏里面又是一堆宏。我们要做的就是修改这个宏。因为我们是自定义的内置模块，所以我们可以增加一个宏。

```cpp
    #define NODE_BUILTIN_EXTEND_MODULES(V)  \  
      V(cyb_wrap)   
```
然后把这个宏追加到那一堆宏后面。
```cpp
    #define NODE_BUILTIN_MODULES(V)  \  
      NODE_BUILTIN_STANDARD_MODULES(V)  \  
      NODE_BUILTIN_OPENSSL_MODULES(V)  \  
      NODE_BUILTIN_ICU_MODULES(V)   \  
      NODE_BUILTIN_REPORT_MODULES(V) \  
      NODE_BUILTIN_PROFILER_MODULES(V)  \  
      NODE_BUILTIN_DTRACE_MODULES(V) \  
      NODE_BUILTIN_EXTEND_MODULES(V)  
```

这时候，Node.js不仅可以编译我们的代码，还会把我们代码中定义的模块注册到内置C++模块里了，接下来就是如何使用C++模块了。  
2 在lib文件夹新建一个cyb.js，作为Node.js原生模块  

```js
    const cyb = internalBinding('cyb_wrap');   
    module.exports = cyb;  
```

新增原生模块，我们也需要修改node.gyp文件，否则代码也不会被编译进node内核。我们找到node.gyp文件的lib/net.js，在后面追加lib/cyb.js。该配置下的文件是给js2c.py使用的，如果不修改，我们在require的时候，就会找不到该模块。最后我们在lib/internal/bootstrap/loader文件里找到internalBindingWhitelist变量，在数组最后增加cyb_wrap，这个配置是给process.binding函数使用的，如果不修改这个配置，通过process.binding就找不到我们的模块。process.binding是可以在用户JS里使用的。至此，我们完成了所有的修改工作，重新编译Node.js。然后编写测试程序。  
3 新建一个测试文件testcyb.js

```js
    // const cyb = process.binding('cyb_wrap');  
    const cyb = require('cyb');   
    console.log(cyb.console())  
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

```js
    int uv_tcp_keepalive_ex(uv_tcp_t* handle,  
                            int on,  
                            unsigned int delay,  
                            unsigned int interval,  
                            unsigned int count) {  
      int err;  
      
      if (uv__stream_fd(handle) != -1) {  
        err =uv__tcp_keepalive_ex(uv__stream_fd(handle),  
                                  on,  
                                  delay,  
                                  interval,  
                                  count);  
        if (err)  
          return err;  
      }  
      
      if (on)  
        handle->flags |= UV_HANDLE_TCP_KEEPALIVE;  
      else  
        handle->flags &= ~UV_HANDLE_TCP_KEEPALIVE;  
     return 0;  
    }  
      
    int uv_tcp_timeout(uv_tcp_t* handle, unsigned int timeout) {  
      #ifdef TCP_USER_TIMEOUT  
        int fd = uv__stream_fd(handle);  
        if (fd != -1 && setsockopt(fd,  
                                   IPPROTO_TCP,  
                                   TCP_USER_TIMEOUT,  
                                   &timeout,  
                                   sizeof(timeout))) {  
          return UV__ERR(errno);   
        }  
      #endif  
        return 0;  
    }   
      
    int uv__tcp_keepalive_ex(int fd,  
                             int on,   
                             unsigned int delay,  
                             unsigned int interval,  
                             unsigned int count) {  
      if (setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &on, sizeof(on)))  
        return UV__ERR(errno);  
      
    #ifdef TCP_KEEPIDLE  
        if (on && delay &&setsockopt(fd,  
                                     IPPROTO_TCP,  
                                     TCP_KEEPIDLE,  
                                     &delay,  
                                     sizeof(delay)))  
          return UV__ERR(errno);  
    #endif  
    #ifdef TCP_KEEPINTVL  
        if (on && interval && setsockopt(fd,  
                                         IPPROTO_TCP,  
                                         TCP_KEEPINTVL,  
                                         &interval,  
                                         sizeof(interval)))  
          return UV__ERR(errno);  
    #endif  
    #ifdef TCP_KEEPCNT  
        if (on && count && setsockopt(fd,  
                                      IPPROTO_TCP,  
                                      TCP_KEEPCNT,  
                                      &count,  
                                      sizeof(count)))  
          return UV__ERR(errno);  
    #endif  
      /* Solaris/SmartOS, if you don't support keep-alive, 
       * then don't advertise it in your system headers... 
       */  
      /* FIXME(bnoordhuis) That's possibly because sizeof(delay) should be 1. */  
    #if defined(TCP_KEEPALIVE) && !defined(__sun)  
      if (on && setsockopt(fd, IPPROTO_TCP, TCP_KEEPALIVE, &delay, sizeof(delay)))  
        return UV__ERR(errno);  
    #endif  
      
      return 0;  
    }  
```

2 修改include/uv.h   
把在tcp.c中加入的接口暴露出来。

```cpp
    UV_EXTERN int uv_tcp_keepalive_ex(uv_tcp_t* handle,  
                                      int enable,  
                                      unsigned int delay,  
                                      unsigned int interval,  
                                      unsigned int count);  
    UV_EXTERN int uv_tcp_timeout(uv_tcp_t* handle, unsigned int timeout);  
```

至此，我们就修改完Libuv的代码，也对外暴露了设置的接口，接着我们修改上层的C++和JS代码，使得我们可以在JS层使用该功能。  
3 修改src/tcp_wrap.cc  
修改TCPWrap::Initialize函数的代码。

```cpp
    env->SetProtoMethod(t, "setKeepAliveEx", SetKeepAliveEx);  
    env->SetProtoMethod(t, "setKeepAliveTimeout", SetKeepAliveTimeout);  
```

首先对JS层暴露两个新的API。我们看看这两个API的定义。

```cpp
    void TCPWrap::SetKeepAliveEx(const FunctionCallbackInfo<Value>& args) {  
      TCPWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap,  
                              args.Holder(),  
                              args.GetReturnValue().Set(UV_EBADF));  
      Environment* env = wrap->env();  
      int enable;  
      if (!args[0]->Int32Value(env->context()).To(&enable)) return;  
      unsigned int delay = static_cast<unsigned int>(args[1].As<Uint32>()->Value());  
      unsigned int detal = static_cast<unsigned int>(args[2].As<Uint32>()->Value());  
      unsigned int count = static_cast<unsigned int>(args[3].As<Uint32>()->Value());  
      int err = uv_tcp_keepalive_ex(&wrap->handle_, enable, delay, detal, count);  
      args.GetReturnValue().Set(err);  
    }  
      
    void TCPWrap::SetKeepAliveTimeout(const FunctionCallbackInfo<Value>& args) {  
      TCPWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap,  
                              args.Holder(),  
                              args.GetReturnValue().Set(UV_EBADF));  
      unsigned int time = static_cast<unsigned int>(args[0].As<Uint32>()->Value());  
      int err = uv_tcp_timeout(&wrap->handle_, time);  
      args.GetReturnValue().Set(err);  
    }  
```

同时还需要在src/tcp_wrap.h中声明这两个函数。

```cpp
    static void SetKeepAliveEx(const v8::FunctionCallbackInfo<v8::Value>& args);  
    static void SetKeepAliveTimeout(const v8::FunctionCallbackInfo<v8::Value>& args);  
```


```js
// 修改lib/net.js
    Socket.prototype.setKeepAliveEx = function(setting,  
                                               secs,  
                                               interval,  
                                               count) {  
      if (!this._handle) {  
        this.once('connect', () => this.setKeepAliveEx(setting,  
                                                       secs,  
                                                       interval,  
                                                       count));  
        return this;  
      }  
      
      if (this._handle.setKeepAliveEx)  
        this._handle.setKeepAliveEx(setting,  
                                    ~~secs > 0 ? ~~secs : 0,  
                                    ~~interval > 0 ? ~~interval : 0,  
                                    ~~count > 0 ? ~~count : 0);  
      
      return this;  
    };  
      
    Socket.prototype.setKeepAliveTimeout = function(timeout) {  
      if (!this._handle) {  
        this.once('connect', () => this.setKeepAliveTimeout(timeout));  
        return this;  
      }  
      
      if (this._handle.setKeepAliveTimeout)  
        this._handle.setKeepAliveTimeout(~~timeout > 0 ? ~~timeout : 0);  
      
      return this;  
    };  
```

重新编译Node.js，我们就可以使用这两个新的API更灵活地控制TCP的keepalive了。

```js
    const net = require('net');  
    net.createServer((socket) => {  
      socket.setKeepAliveEx(true, 1,2,3);  
      // socket.setKeepAliveTimeout(4);  
    }).listen(1101);  
```

## 20.2 使用N-API编写C++插件
本小节介绍使用N_API编写C++插件知识。Node.js C++插件本质是一个动态链接库，写完编译后，生成一个.node文件。我们在Node.js里直接require使用，Node.js会为我们处理一切。
首先建立一个test.cc文件

```cpp
    // hello.cc using N-API  
    #include <node_api.h>  
      
    namespace demo {  
      
    napi_value Method(napi_env env, napi_callback_info args) {  
      napi_value greeting;  
      napi_status status;  
      
      status = napi_create_string_utf8(env, "world", NAPI_AUTO_LENGTH, &greeting);  
      if (status != napi_ok) return nullptr;  
      return greeting;  
    }  
      
    napi_value init(napi_env env, napi_value exports) {  
      napi_status status;  
      napi_value fn;  
      
      status = napi_create_function(env, nullptr, 0, Method, nullptr, &fn);  
      if (status != napi_ok) return nullptr;  
      
      status = napi_set_named_property(env, exports, "hello", fn);  
      if (status != napi_ok) return nullptr;  
      return exports;  
    }  
      
    NAPI_MODULE(NODE_GYP_MODULE_NAME, init)  
      
    }  // namespace demo  
```

我们不需要具体了解代码的意思，但是从代码中我们大致知道它做了什么事情。剩下的就是阅读N-API的API文档就可以。接着我们新建一个binding.gyp文件。gyp文件是node-gyp的配置文件。node-gyp可以帮助我们针对不同平台生产不同的编译配置文件。比如Linux下的makefile。

```json
    {  
      "targets": [  
        {  
          "target_name": "test",  
          "sources": [ "./test.cc" ]  
        }  
      ]  
    }  
```

语法和makefile有点像，就是定义我们编译后的目前文件名，依赖哪些源文件。然后我们安装node-gyp。

```sh
npm install node-gyp -g  
```

Node.js源码中也有一个node-gyp，它是帮助npm安装拓展模块时，就地编译用的。我们安装的node-gyp是帮助我们生成配置文件并编译用的，具体可以参考Node.js文档。一切准备就绪。我们开始编译。直接执行

```sh
node-gyp configure
node-gyp build  
```

在路径./build/Release/下生成了test.node文件。这就是我们的拓展模块。我们编写测试程序app.js。

```js
    var addon = require("./build/Release/test");  
    console.log(addon.hello());  
```

执行
 

```text
node app.js  
```

我们看到输出world。我们已经学会了如何编写一个Node.js的拓展模块。剩下的就是阅读N-API文档，根据自己的需求编写不同的模块。
