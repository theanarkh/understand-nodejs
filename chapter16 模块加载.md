# 第十六章 模块加载
Nodejs的模块分为应用层js模块、nodejs原生js模块、nodejs内置c++模块。我们分别看一下这些模块加载的原理。在分析nodejs启动过程的章节，我们已经看到了c++模块和原生js模块在nodejs中是如何存取的，我们看在nodejs中是实际使用这些模块时是如何查找的。

我们以一个例子为开始。假设我们有一个文件demo.js

```c
const net = require('net');  
```

我们看一下执行node demo.js的时候，过程是怎样的。在nodejs启动章节我们分析过，nodejs启动的时候，会执行以下代码。

```c
require('internal/modules/cjs/loader').Module.runMain(process.argv[1])  
其中runMain函数在pre_execution.js的initializeCJSLoader中挂载
1.function initializeCJSLoader() {  
2.  const CJSLoader = require('internal/modules/cjs/loader');  
3.  CJSLoader.Module._initPaths();  
4.  CJSLoader.Module.runMain =  
5.    require('internal/modules/run_main').executeUserEntryPoint;  
6.}  
```

我们看到runMain是run_main.js导出的函数。继续往下看

```c
1.function executeUserEntryPoint(main = process.argv[1]) {  
2.  const resolvedMain = resolveMainPath(main);  
3.  const useESMLoader = shouldUseESMLoader(resolvedMain);  
4.  if (useESMLoader) {  
5.    runMainESM(resolvedMain || main);  
6.  } else {  
7.    Module._load(main, null, true);  
8.  }  
9.}  
10.  
11.module.exports = {  
12.  executeUserEntryPoint  
13.};  
```

process.argv[1]就是我们要执行的js。最后通过cjs/loader.js的Module._load执行我们的js。我们回到cjs/loader.js。

```c
1.Module._load = function(request, parent, isMain) {  
2.  // 解析出文件绝对路径  
3.  const filename = Module._resolveFilename(request, parent, isMain);  
4.  // 是否有缓存了  
5.  const cachedModule = Module._cache[filename];  
6.  // 有缓存  
7.  if (cachedModule !== undefined) {  
8.    updateChildren(parent, cachedModule, true);  
9.    // 返回缓存的  
10.    return cachedModule.exports;  
11.  }  
12.  // 是否是原生js模块  
13.  const mod = loadNativeModule(filename, request);  
14.  // 是并且可以暴露给用户使用的，直接返回  
15.  if (mod && mod.canBeRequiredByUsers) return mod.exports;  
16.  // 否则加载一个用户js模块  
17.  const module = new Module(filename, parent);  
18.  // 是否是启动模块  
19.  if (isMain) {  
20.    process.mainModule = module;  
21.    module.id = '.';  
22.  }  
23.  // 缓存  
24.  Module._cache[filename] = module;  
25.  module.load(filename);  
26.  return module.exports;  
27.};  
```

我们看到加载一个用户模块的时候，nodejs首先判断是否在缓存里，是则直接返回，否则判断是不是原生js模块，是则加载原生js模块，否则加载一般js模块。我们先看加载一般js模块的流程。
## 16.1 加载用户js模块
Module.load函数中核心代码如下
Module._extensions[extension](this, filename);  
在nodejs中_extensions有三种，分别是js、json、node。
### 16.1.1 加载json模块
加载json模块是比较简单的

```c
1.Module._extensions['.json'] = function(module, filename) {  
2.  const content = fs.readFileSync(filename, 'utf8');  
3.  
4.  try {  
5.    module.exports = JSONParse(stripBOM(content));  
6.  } catch (err) {  
7.    err.message = filename + ': ' + err.message;  
8.    throw err;  
9.  }  
10.};  
```

直接读取json文件的内容，然后解析成对象就行。
### 16.1.2 加载js模块

```c
1.Module._extensions['.js'] = function(module, filename) {  
2.  const content = fs.readFileSync(filename, 'utf8');  
3.  module._compile(content, filename);  
4.};  
```

读完文件的内容，然后执行_compile

```c
1.Module.prototype._compile = function(content, filename) {  
2.  // 生成一个函数  
3.  const compiledWrapper = wrapSafe(filename, content, this);  
4.  const dirname = path.dirname(filename);  
5.  // require是对_load函数的封装 
6.  const require = (path) => {
7.      return this.require(path);
8.  };
9.  let result;  
10.  const exports = this.exports;  
11.  const thisValue = exports;  
12.  const module = this;  
13.  // 执行函数  
14.  result = compiledWrapper.call(thisValue, exports, require, module, filename, dirname);  
15.  return result;  
16.}  
```

我们主要关注wrapSafe的逻辑。

```c
1.function wrapSafe(filename, content, cjsModuleInstance) {  
2.    const wrapper = Module.wrap(content);  
3.    return vm.runInThisContext(wrapper, {  
4.      filename,  
5.      lineOffset: 0,  
6.      ...  
7.    });  
8.}  
9.  
10.const wrapper = [  
11.  '(function (exports, require, module, __filename, __dirname) { ',  
12.  '\n});'  
13.];  
14.  
15.Module.wrap = function(script) {  
16.  return Module.wrapper[0] + script + Module.wrapper[1];  
17.};  
```

vm.runInThisContext的第一个参数是”(function() {})”的时候，会返回一个里面包裹的函数。我们回到_compile函数。我们看执行vm.runInThisContext返回的函数时传入的参数。
compiledWrapper.call(exports, exports, require, module, filename, dirname);  
这就是我们平时在.js文件中使用的module,exports和require函数。Exports是module的一个属性。所以我们使用exports.name = value的时候可以导出，但是使用exports = {}就无法导出了。因为nodejs最后加载后，导出的内容是从module.exports里获取的。
### 16.1.3 加载node模块
Node拓展的模块本质上是动态链接库，我们看require一个node模块的时候的过程。我们从加载.node模块的源码开始。

```c
1.、Module._extensions['.node'] = function(module, filename) {  
2.  // ...  
3.  return process.dlopen(module, path.toNamespacedPath(filename));  
4.};  
```

直接调了process.dlopen，该函数在node.js里定义。  

```c
1.const rawMethods = internalBinding('process_methods');  
2.process.dlopen = rawMethods.dlopen;  
```

找到process_methods模块对应的是node_process_methods.cc。  
env->SetMethod(target, "dlopen", binding::DLOpen);  
之前说过，node的拓展模块其实是动态链接库，那么我们先看看一个动态链接库我们是如何使用的。以下是示例代码。  

```c
1.#include <stdio.h>  
2.#include <stdlib.h>  
3.#include <dlfcn.h>  
4.int main(){  
5.    // 打开一个动态链接库，拿到一个handler  
6.    handler = dlopen('xxx.so',RTLD_LAZY);  
7.    // 取出动态链接库里的函数add  
8.    add = dlsym(handler,"add");  
9.    // 执行  
10.    printf("%d",add (1,1));  
11.    dlclose(handler);  
12.    return 0;  
13.}  
```

了解动态链接库的使用，我们继续分析刚才看到的DLOpen函数。  

```c
1.void DLOpen(const FunctionCallbackInfo<Value>& args) {  
2.  
3.  int32_t flags = DLib::kDefaultFlags;  
4.  
5.  node::Utf8Value filename(env->isolate(), args[1]);  // Cast  
6.  env->TryLoadAddon(*filename, flags, [&](DLib* dlib) {  
7.  
8.    const bool is_opened = dlib->Open();  
9.  
10.    node_module* mp = thread_local_modpending;  
11.    thread_local_modpending = nullptr;  
12.    // 省略部分代码  
13.    if (mp->nm_context_register_func != nullptr) {  
14.      mp->nm_context_register_func(exports, module, context, mp->nm_priv);  
15.    } else if (mp->nm_register_func != nullptr) {  
16.      mp->nm_register_func(exports, module, mp->nm_priv);  
17.    }   
18.    return true;  
19.  });  
20.}  
```

我们看到重点是TryLoadAddon函数，该函数的逻辑就是执行他的第三个参数。我们发现第三个参数是一个函数，入参是DLib对象。所以我们先看看这个类。 

```c
1.class DLib {  
2. public:  
3.  static const int kDefaultFlags = RTLD_LAZY;  
4.  DLib(const char* filename, int flags);  
5.  
6.  bool Open();  
7.  void Close();  
8.  const std::string filename_;  
9.  const int flags_;  
10.  std::string errmsg_;  
11.  void* handle_;  
12.  uv_lib_t lib_;  
13.};  
```

再看一下实现。  

```c
1.bool DLib::Open() {  
2.  handle_ = dlopen(filename_.c_str(), flags_);  
3.  if (handle_ != nullptr) return true;  
4.  errmsg_ = dlerror();  
5.  return false;  
6.} 
```

 
DLib就是对动态链接库的一个封装，他封装了动态链接库的文件名和操作。TryLoadAddon函数首先根据require传入的文件名，构造一个DLib，然后执行  
const bool is_opened = dlib->Open();  
Open函数打开了一个动态链接库，这时候我们要先了解一下打开一个动态链接库究竟发生了什么。首先我们一般c++插件最后一句代码的定义。
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)  
这是个宏定义。  

```c
1.#define NAPI_MODULE(modname, regfunc) \  
2.  NAPI_MODULE_X(modname, regfunc, NULL, 0)  
```

```c
1. #define NAPI_MODULE_X(modname, regfunc, priv, flags)                  \  
2.    static napi_module _module = \  
3.    {                  \  
4.      NAPI_MODULE_VERSION, \  
5.      flags,          \  
6.      __FILE__,        \  
7.      regfunc,        \  
8.      #modname,        \  
9.      priv,            \  
10.      {0},            \  
11.    };                \  
12.    static void _register_modname(void) __attribute__((constructor)); \  
13.      static void _register_modname(void)      {    \  
14.      napi_module_register(&_module);  \  
15.    }   
```

 
所以一个node扩展就是定义了一个napi_module 模块和一个register_modname（modname是我们定义的）函数。我们貌似定义了两个函数，其实一个带attribute_((constructor))。__attribute((constructor))是代表该函数会先执行的意思，具体可以查阅文档。看到这里我们知道，当我们打开一个动态链接库的时候，会执行_register_modname函数，该函数执行的是  
napi_module_register(&_module);    
我们继续展开。

```c
1.  
2.// Registers a NAPI module.  
3.void napi_module_register(napi_module* mod) {  
4.  node::node_module* nm = new node::node_module {  
5.    -1,  
6.    mod->nm_flags | NM_F_DELETEME,  
7.    nullptr,  
8.    mod->nm_filename,  
9.    nullptr,  
10.    napi_module_register_cb,  
11.    mod->nm_modname,  
12.    mod,  // priv  
13.    nullptr,  
14.  };  
15.  node::node_module_register(nm);  
16.}  
```

nodejs把napi模块转成node_module。最后调用node_module_register。 

```c
1.  
2.extern "C" void node_module_register(void* m) {  
3.  struct node_module* mp = reinterpret_cast<struct node_module*>(m);  
4.  
5.  if (mp->nm_flags & NM_F_INTERNAL) {  
6.    mp->nm_link = modlist_internal;  
7.    modlist_internal = mp;  
8.  } else if (!node_is_initialized) {  
9.    mp->nm_flags = NM_F_LINKED;  
10.    mp->nm_link = modlist_linked;  
11.    modlist_linked = mp;  
12.  } else {  
13.    thread_local_modpending = mp;  
14.  }  
15.}  
```

 napi模块不是NM_F_INTERNAL模块，node_is_initialized是在nodejs初始化时设置的变量，这时候已经是true。所以注册napi模块时，会执行thread_local_modpending = mp。thread_local_modpending 类似一个全局变量，保存当前加载的模块。分析到这，我们回到DLOpen函数。 

```c
1.node_module* mp = thread_local_modpending;  
2.thread_local_modpending = nullptr;  
```

这时候我们就知道刚才那个变量thread_local_modpending的作用了。node_module* mp = thread_local_modpending后我们拿到了我们刚才定义的napi模块的信息。接着执行node_module的函数nm_register_func。  

```c
1.if (mp->nm_context_register_func != nullptr) {  
2.  mp->nm_context_register_func(exports, module, context, mp->nm_priv);  
3. } else if (mp->nm_register_func != nullptr) {  
4.   mp->nm_register_func(exports, module, mp->nm_priv);  
5. }  
```

从刚才的node_module定义中我们看到函数是napi_module_register_cb。  

```c
1.static void napi_module_register_cb(v8::Local<v8::Object> exports,  
2.                                  v8::Local<v8::Value> module,  
3.                                  v8::Local<v8::Context> context,  
4.                                  void* priv) {  
5.  napi_module_register_by_symbol(exports, module, context,  
6.      static_cast<napi_module*>(priv)->nm_register_func);  
7.}  
```

该函数调用napi_module_register_by_symbol函数，并传入napi_module的nm_register_func函数。 

```c
1.void napi_module_register_by_symbol(v8::Local<v8::Object> exports,  
2.                                  v8::Local<v8::Value> module,  
3.                                  v8::Local<v8::Context> context,  
4.                                  napi_addon_register_func init) {  
5.  
6.  // Create a new napi_env for this specific module.  
7.  napi_env env = v8impl::NewEnv(context);  
8.  
9.  napi_value _exports;  
10.  env->CallIntoModuleThrow([&](napi_env env) {  
11.    _exports = init(env, v8impl::JsValueFromV8LocalValue(exports));  
12.  });  
13.  
14.  if (_exports != nullptr &&  
15.      _exports != v8impl::JsValueFromV8LocalValue(exports)) {  
16.    napi_value _module = v8impl::JsValueFromV8LocalValue(module);  
17.    napi_set_named_property(env, _module, "exports", _exports);  
18.  }  
19.}  
```

init就是我们定义的函数。入参是env和exports，可以对比我们定义的函数的入参。最后我们修改exports变量。即设置导出的内容。最后在js里，我们就拿到了c++层定义的内容。  
## 16.2 加载原生js模块
上一节我们了解了如何加载一个用户的js模块，回到demo.js。当我们在在demo.js模块里使用require加载net模块的时候。因为net是原生js模块，这时候会使用loadNativeModule函数加载net模块。我们看这个函数的定义

```c
1.function loadNativeModule(filename, request) {  
2.  // 是不是在原生js模块中  ，NativeModule在bootstrap/loader.js中定义
3.  const mod = NativeModule.map.get(filename);  
4.  if (mod) {  
5.    mod.compileForPublicLoader();  
6.    return mod;  
7.  }  
8.}  
```

在nodejs启动过程中我们分析过，mod是一个NativeModule对象

```c
1.compileForPublicLoader() {  
2.    this.compileForInternalLoader();  
3.    return this.exports;  
4.}  
5.  
6.compileForInternalLoader() {  
7.    if (this.loaded || this.loading) {  
8.      return this.exports;  
9.    }  
10.    // id就是我们要加载的模块，比如net 
11.    const id = this.id;  
12.    this.loading = true;  
13.  
14.    try {  
15.      const fn = compileFunction(id);  
16.      fn(this.exports, nativeModuleRequire, this, process, internalBinding, primordials);  
17.      this.loaded = true;  
18.    } finally {  
19.      this.loading = false;  
20.    }  
21.    return this.exports;  
22.  }  
```

我们重点看compileFunction这里的逻辑。该函数是node_native_module_env.cc模块导出的函数。具体的代码就不贴了，通过层层查找，最后到node_native_module.cc 的NativeModuleLoader::CompileAsModule

```c
1.MaybeLocal<Function> NativeModuleLoader::CompileAsModule(  
2.    Local<Context> context,  
3.    const char* id,  
4.    NativeModuleLoader::Result* result) {  
5.  
6.  Isolate* isolate = context->GetIsolate();  
7.  // 函数的形参  
8.  std::vector<Local<String>> parameters = {  
9.      FIXED_ONE_BYTE_STRING(isolate, "exports"),  
10.      FIXED_ONE_BYTE_STRING(isolate, "require"),  
11.      FIXED_ONE_BYTE_STRING(isolate, "module"),  
12.      FIXED_ONE_BYTE_STRING(isolate, "process"),  
13.      FIXED_ONE_BYTE_STRING(isolate, "internalBinding"),  
14.      FIXED_ONE_BYTE_STRING(isolate, "primordials")};  
15.  // 编译出一个函数  
16.  return LookupAndCompile(context, id, ¶meters, result);  
17.}
```

  
我们继续看LookupAndCompile。

```c
1.MaybeLocal<Function> NativeModuleLoader::LookupAndCompile(  
2.    Local<Context> context,  
3.    const char* id,  
4.    std::vector<Local<String>>* parameters,  
5.    NativeModuleLoader::Result* result) {  
6.  
7.  Isolate* isolate = context->GetIsolate();  
8.  EscapableHandleScope scope(isolate);  
9.  
10.  Local<String> source;  
11.  // 找到原生js模块的地址  
12.  if (!LoadBuiltinModuleSource(isolate, id).ToLocal(&source)) {  
13.    return {};  
14.  }  
15.  // ‘net’ + ‘.js’
16.  std::string filename_s = id + std::string(".js");  
17.  Local<String> filename =  
18.      OneByteString(isolate, filename_s.c_str(), filename_s.size());  
19.  // 省略一些参数处理  
20.  // 脚本源码  
21.  ScriptCompiler::Source script_source(source, origin, cached_data);  
22.  // 编译出一个函数  
23.  MaybeLocal<Function> maybe_fun =  
24.      ScriptCompiler::CompileFunctionInContext(context,  
25.                                               &script_source,  
26.                                               parameters->size(),  
27.                                               parameters->data(),  
28.                                               0,  
29.                                               nullptr,  
30.                                               options);  
31.  
32.  Local<Function> fun = maybe_fun.ToLocalChecked();  
33.  return scope.Escape(fun);  
34.}  
```

LookupAndCompile函数首先找到加载模块的源码，然后编译出一个函数。我们看一下LoadBuiltinModuleSource如何查找模块源码的。

```c
1.MaybeLocal<String> NativeModuleLoader::LoadBuiltinModuleSource(Isolate* isolate, const char* id) {  
2.  const auto source_it = source_.find(id);  
3.  return source_it->second.ToStringChecked(isolate);  
4.}  
```

这里是id是net，通过该id从_source中找到对应的数据，那么_source是什么呢？因为nodejs为了提高效率，把原生js模块的源码字符串直接转成ascii码存到内存里。这样加载这些模块的时候，就不需要硬盘io了。直接从内存读取就行。我们看一下_source的定义（在node_javascript.cc里，编译nodejs源码或者执行js2c.py生成）。

```c
1.source_.emplace("net", UnionBytes{net_raw, 46682});  
2.source_.emplace("cyb", UnionBytes{cyb_raw, 63});  
3.source_.emplace("os", UnionBytes{os_raw, 7548});  
```

cyb是我增加的测试模块。我们可以看一下该模块的内容。

```c
1.static const uint8_t cyb_raw[] = {  
2. 99,111,110,115,116, 32, 99,121, 98, 32, 61, 32,105,110,116,101,114,110, 97,108, 66,105,110,100,105,110,103, 40, 39, 99,  
3.121, 98, 95,119,114, 97,112, 39, 41, 59, 32, 10,109,111,100,117,108,101, 46,101,120,112,111,114,116,115, 32, 61, 32, 99,  
4.121, 98, 59  
5.}; 
```

 
我们转成字符串看一下是什么

```c
1.Buffer.from([99,111,110,115,116, 32, 99,121, 98, 32, 61, 32,105,110,116,101,114,110, 97,108, 66,105,110,100,105,110,103, 40, 39, 99,    
2.121, 98, 95,119,114, 97,112, 39, 41, 59, 32, 10,109,111,100,117,108,101, 46,101,120,112,111,114,116,115, 32, 61, 32, 99,    
3.121, 98, 59].join(',').split(',')).toString('utf-8')  
```

输出

```c
1.const cyb = internalBinding('cyb_wrap');   
2.module.exports = cyb;  
```

所以我们最后编译代码的是这样的。回到demo.js。

```c
const net = require('net');
```

我们通过require加载net的时候，通过NativeModule的compileForInternalLoader，最终会在_source中找到对应的源码字符串，然后编译成一个函数。

```c
1.const fn = compileFunction(id);  
2.// nativeModuleRequire用于加载原生js模块，internalBinding用于加载c++模块  
3.fn(this.exports, nativeModuleRequire, this, process, internalBinding, primordials);  
```

由fn的入参可以知道，我们在net（或其他原生js模块中）只能加载原生js模块和内置的c++模块。但是在用户js中可以通过process.binding('tcp_wrap')加载c++模块直接使用。但是我们一般都是加载原生js模块，js模块加载c++内置模块。
## 16.3 加载内置c++模块
在原生js模块中我们一般会加载一些内置的c++模块，这是nodejs拓展js功能的关键之处。比如我们require(‘net’)的时候，net模块会加载tcp_wrap模块。

```c
1.const {  
2.  TCP,  
3.  TCPConnectWrap,  
4.  constants: TCPConstants  
5.} = internalBinding('tcp_wrap')  
```

上一节已经分析过，internalBinding是加载原生js模块（这里是net）时传入的实参。在分析nodejs启动过程的时候，了解到internalBinding是对getInternalBinding的封装。getInternalBinding对应的是binding::GetInternalBinding（node_binding.cc）。

```c
1.// 根据模块名查找对应的模块  
2.void GetInternalBinding(const FunctionCallbackInfo<Value>& args) {  
3.  Environment* env = Environment::GetCurrent(args);  
4.  // 模块名  
5.  Local<String> module = args[0].As<String>();  
6.  node::Utf8Value module_v(env->isolate(), module);  
7.  Local<Object> exports;  
8.  // 从c++内部模块找  
9.  node_module* mod = FindModule(modlist_internal, *module_v, NM_F_INTERNAL);  
10.  // 找到则初始化  
11.  if (mod != nullptr) {  
12.    exports = InitModule(env, mod, module);  
13.  } else {  
14.     // 省略  
15.  }  
16.  
17.  args.GetReturnValue().Set(exports);  
18.}  
```

modlist_internal是一条链表，在nodejs启动过程的时候，由各个c++模块连成的链表。通过模块名找到对应的c++模块后，执行InitModule初始化模块。

```c
1.// 初始化一个模块，即执行他里面的注册函数  
2.static Local<Object> InitModule(Environment* env,  
3.                                node_module* mod,  
4.                                Local<String> module) {  
5.  Local<Object> exports = Object::New(env->isolate());  
6.  Local<Value> unused = Undefined(env->isolate());  
7.  mod->nm_context_register_func(exports, unused, env->context(), mod->nm_priv);  
8.  return exports;  
9.} 
```

 
执行c++模块的nm_context_register_func指向的函数。这个函数就是在c++模块最后一行定义的Initialize函数。Initialize会设置导出的对象。我们从js可以访问Initialize导出的对象。
