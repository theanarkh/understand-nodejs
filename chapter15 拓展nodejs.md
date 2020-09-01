# 第十五章 拓展nodejs
拓展nodejs从宏观来说，有几种方式，包括直接修改nodejs内核重新编译分发、提供npm包。Npm包又可以分为js和c++拓展。本章主要是介绍修改nodejs内核和c++插件。
## 15.1 修改nodejs内核
修改nodejs内核的方式也有很多种，我们可以修改js层、c++、c语言层的代码。也可以新增一些功能或模块。本节介绍如果新增一个nodejs的c++模块。相比修改nodejs内核代码，新增一个nodejs内置模块需要了解更多的知识。下面我们开始。

**1 首先在src文件夹下新增两个文件。**

cyb.h

```c
1.#ifndef SRC_CYB_H_  
2.#define SRC_CYB_H_  
3.  
4.#include "v8.h"  
5.  
6.namespace node {  
7.  
8.class Environment; 
9.class Cyb {  
10. public:  
11.    static void Initialize(v8::Local<v8::Object> target,  
12.                         v8::Local<v8::Value> unused,  
13.                         v8::Local<v8::Context> context,  
14.                         void* priv);  
15.  private:  
16.  static void Console(const v8::FunctionCallbackInfo<v8::Value>& args);  
17.};  
18.}  // namespace node  
19.  
20.#endif  
```

cyb.cc

```c
1.#include "cyb.h"  
2.#include "env-inl.h"  
3.#include "util-inl.h"  
4.#include "node_internals.h"  
5.  
6.namespace node {  
7.  
8.using v8::Context;  
9.using v8::Function;  
10.using v8::FunctionCallbackInfo;  
11.using v8::FunctionTemplate;  
12.using v8::Local;  
13.using v8::Object;  
14.using v8::String;  
15.using v8::Value;  
16.  
17.void Cyb::Initialize(Local<Object> target,  
18.                         Local<Value> unused,  
19.                         Local<Context> context,  
20.                         void* priv) {  
21.  Environment* env = Environment::GetCurrent(context);  
22.  // 申请一个函数模块，模板函数是Console  
23.  Local<FunctionTemplate> t = env->NewFunctionTemplate(Console);  
24.  // 申请一个字符串  
25.  Local<String> str = FIXED_ONE_BYTE_STRING(env->isolate(), "console");  
26.  // 设置函数类名  
27.  t->SetClassName(str);  
28.  // 导出函数，target即exports  
29.  target->Set(env->context(),  
30.              str,  
31.              t->GetFunction(env->context()).ToLocalChecked()).Check();  
32.}  
33.  
34.void Cyb::Console(const FunctionCallbackInfo<Value>& args) {  
35.  v8::Isolate* isolate = args.GetIsolate();  
36.  v8::Local<String> str = String::NewFromUtf8(isolate, "hello world");  
37.  args.GetReturnValue().Set(str);  
38.}  
39.  
40.}  // namespace node  
41.// 声明该模块  
42.NODE_MODULE_CONTEXT_AWARE_INTERNAL(cyb_wrap, node::Cyb::Initialize)  
```

我们新定义一个模块，是不能自动添加到nodejs内核的。我们还需要额外的操作。我们需要修改node.gyp文件。把我们新增的文件加到配置里，否则编译的时候，不会编译这个新增的模块。我们可以在node.gyp文件中找到src/tcp_wrap.cc,然后在他后面加入我们的文件就行。

```c
1.src/cyb_wrap.cc  
2.src/cyb_wrap.h  
```

这时候nodejs会编译我们的代码了。但是nodejs的内置模块有一定的机制，我们的代码加入了nodejs内核，不代表就可以使用了。我们看一下nodejs对内置++
模块的机制。nodejs在初始化的时候会调用RegisterBuiltinModules函数注册所有的内置c++模块。

```c
1.void RegisterBuiltinModules() {  
2.#define V(modname) _register_##modname();  
3.  NODE_BUILTIN_MODULES(V)  
4.#undef V  
5.}  
```

我们看到该函数只有一个宏。我们看看这个宏。

```c
1.void RegisterBuiltinModules() {  
2.#define V(modname) _register_##modname();  
3.  NODE_BUILTIN_MODULES(V)  
4.#undef V  
5.}#define NODE_BUILTIN_MODULES(V)  \  
6.  NODE_BUILTIN_STANDARD_MODULES(V)  \  
7.  NODE_BUILTIN_OPENSSL_MODULES(V)  \  
8.  NODE_BUILTIN_ICU_MODULES(V)   \  
9.  NODE_BUILTIN_REPORT_MODULES(V) \  
10.  NODE_BUILTIN_PROFILER_MODULES(V) \  
11.  NODE_BUILTIN_DTRACE_MODULES(V)     
```

宏里面又是一堆宏，本文不是源码解析，所以不深入讲解，可以参考之前的文章。我们要做的就是修改这个宏。因为我们是自定义的内置模块，所以我们可以增加一个宏。

```c
1.#define NODE_BUILTIN_EXTEND_MODULES(V)  \  
2.  V(cyb_wrap)   
```

 然后把这个宏追加到那一堆宏后面。

```c
1.#define NODE_BUILTIN_MODULES(V)  \  
2.  NODE_BUILTIN_STANDARD_MODULES(V)  \  
3.  NODE_BUILTIN_OPENSSL_MODULES(V)  \  
4.  NODE_BUILTIN_ICU_MODULES(V)   \  
5.  NODE_BUILTIN_REPORT_MODULES(V) \  
6.  NODE_BUILTIN_PROFILER_MODULES(V)  \  
7.  NODE_BUILTIN_DTRACE_MODULES(V) \  
8.  NODE_BUILTIN_EXTEND_MODULES(V)  
```

这时候，nodejs不仅可以编译我们的代码，还把我们的代码定义的模块注册到内置c++模块里了。接下来就是如何使用c++模块了。

**2 在lib文件夹新建一个cyb.js，作为nodejs原生模块**

```c
1.const cyb = internalBinding('cyb_wrap');   
2.module.exports = cyb;  
```

internalBinding函数是在执行cyb.js，注入的函数。不能在用户js里使用。internalBinding函数就是根据模块名从内置模块里找到对应的模块, 即我们的cyb.cc。 新增原生模块，我们也需要修改node.gyp文件，否则代码也不会被编译进node内核。我们找到node.gyp文件的lib/net.js。在后面追加lib/cyb.js。该配置下的文件是给js2c.py使用的。如果不修改，我们在require的时候，就会找不到该模块。最后我们在lib/internal/bootstrap/loader文件里找到internalBindingWhitelist变量，在数组最后增加cyb_wrap。这个配置是给process.binding函数使用的，如果不修改这个配置，通过process.binding就找不到我们的模块。process.binding是可以在用户js里使用的。
到此，我们完成了所有的修改工作，重新编译nodejs。然后编写测试程序。

**3 新建一个测试文件**

testcyb.js

```c
1.// const cyb = process.binding('cyb_wrap');  
2.const cyb = require('cyb');   
3.console.log(cyb.console())  
```

输出hello world。
## 15.2 使用napi编写c++插件
nodejs拓展本质是一个动态链接库，写完编译后，生成一个.node文件。我们在nodejs里直接require使用，nodejs会为我们处理这一切
首先建立一个test.cc文件

```c
1.// hello.cc using N-API  
2.#include <node_api.h>  
3.  
4.namespace demo {  
5.  
6.napi_value Method(napi_env env, napi_callback_info args) {  
7.  napi_value greeting;  
8.  napi_status status;  
9.  
10.  status = napi_create_string_utf8(env, "world", NAPI_AUTO_LENGTH, &greeting);  
11.  if (status != napi_ok) return nullptr;  
12.  return greeting;  
13.}  
14.  
15.napi_value init(napi_env env, napi_value exports) {  
16.  napi_status status;  
17.  napi_value fn;  
18.  
19.  status = napi_create_function(env, nullptr, 0, Method, nullptr, &fn);  
20.  if (status != napi_ok) return nullptr;  
21.  
22.  status = napi_set_named_property(env, exports, "hello", fn);  
23.  if (status != napi_ok) return nullptr;  
24.  return exports;  
25.}  
26.  
27.NAPI_MODULE(NODE_GYP_MODULE_NAME, init)  
28.  
29.}  // namespace demo  
```

我们不需要具体了解代码的意思，但是从代码中我们大致知道他做了什么事情。剩下的就是阅读n-api的api文档就可以。接着我们新建一个binding.gyp文件。gyp文件是node-gyp的配置文件。node-gyp可以帮助我们针对不同平台生产不同的编译配置文件。比如linux下的makefile。

```c
1.{  
2.  "targets": [  
3.    {  
4.      "target_name": "test",  
5.      "sources": [ "./test.cc" ]  
6.    }  
7.  ]  
8.}  
```

语法和makefile有点像，就是定义我们编译后的目前文件名，依赖哪些源文件。然后我们安装node-gyp。

```c
npm install node-gyp -g  
```

nodejs源码中也有一个node-gyp，他是帮助npm安装拓展模块时，就地编译用的。我们安装的node-gyp是帮助我们生成配置文件并编译用的，具体可以参考nodejs文档。一切准备就绪。我们开始编译。直接执行

```c
node-gyp rebuild  
```

在路径./build/Release/下生成了test.node文件。这就是我们的拓展模块。我们编写测试程序。

```c
1.var addon = require("./build/Release/test");  
2.console.log(addon.hello());  
```

执行


```c
nodejs app.js  
```

我们看到输出world。我们已经学会了如何编写一个nodejs的拓展模块。剩下的就是阅读n-api文档，根据自己的需求编写不同的模块。
