Node.js的模块分为用户JS模块、Node.js原生JS模块、Node.js内置C++模块。本章介绍这些模块加载的原理以及Node.js中模块加载器的类型和原理。
下面我们以一个例子为开始，分析Node.js中模块加载的原理。假设我们有一个文件demo.js，代码如下

```
1.	const myjs= require(‘myjs); 
2.	const net = require(‘net’); 
```

其中myjs的代码如下

```
1.	exports.hello = ‘world’;
```

我们看一下执行node demo.js的时候，过程是怎样的。在Node.js启动章节我们分析过，Node.js启动的时候，会执行以下代码。
require('internal/modules/cjs/loader').Module.runMain(process.argv[1]) 
其中runMain函数在pre_execution.js的initializeCJSLoader中挂载

```
1.	function initializeCJSLoader() {  
2.	  const CJSLoader = require('internal/modules/cjs/loader');  
3.	  CJSLoader.Module._initPaths();  
4.	  CJSLoader.Module.runMain =  
5.	    require('internal/modules/run_main').executeUserEntryPoint;  
6.	}  
```

我们看到runMain是run_main.js导出的函数。继续往下看

```
1.	const CJSLoader = require('internal/modules/cjs/loader');
2.	const { Module } = CJSLoader;
3.	function executeUserEntryPoint(main = process.argv[1]) {  
4.	  const resolvedMain = resolveMainPath(main);  
5.	  const useESMLoader = shouldUseESMLoader(resolvedMain);  
6.	  if (useESMLoader) {  
7.	    runMainESM(resolvedMain || main);  
8.	  } else {  
9.	    Module._load(main, null, true);  
10.	  }  
11.	}  
12.	  
13.	module.exports = {  
14.	  executeUserEntryPoint  
15.	};  
```

process.argv[1]就是我们要执行的JS文件。最后通过cjs/loader.js的Module._load加载了我们的JS。下面我们看一下具体的处理逻辑。

```
1.	Module._load = function(request, parent, isMain) {  
2.	  const filename = Module._resolveFilename(request, parent, isMain);  
3.	  
4.	  const cachedModule = Module._cache[filename];  
5.	  // 有缓存则直接返回  
6.	  if (cachedModule !== undefined) {  
7.	    updateChildren(parent, cachedModule, true);  
8.	    if (!cachedModule.loaded)  
9.	      return getExportsForCircularRequire(cachedModule);  
10.	    return cachedModule.exports;  
11.	  }  
12.	  // 是否是可访问的原生JS模块，是则返回  
13.	  const mod = loadNativeModule(filename, request);  
14.	  if (mod && mod.canBeRequiredByUsers) return mod.exports;  
15.	  // 非原生JS模块，则新建一个Module表示加载的模块  
16.	  const module = new Module(filename, parent);  
17.	  // 缓存  
18.	  Module._cache[filename] = module;  
19.	  // 加载
20.	  module.load(filename);  
21.	  // 调用方拿到的是module.exports的值
22.	  return module.exports;  
23.	};  
```

_load函数主要是三个逻辑  
1 判断是否有缓存，有则返回。  
2 没有缓存，则判断是否是原生JS模块，是则交给原生模块处理。  
1	不是原生模块，则新建一个Module表示用户的JS模块，然后执行load函数加载。  
这里我们只需要关注3的逻辑，在Node.js中，用户定义的模块使用Module表示。

```
1.	function Module(id = '', parent) {  
2.	  // 模块对应的文件路径  
3.	  this.id = id;  
4.	  this.path = path.dirname(id);  
5.	  // 在模块里使用的exports变量  
6.	  this.exports = {};  
7.	  this.parent = parent;  
8.	  // 加入父模块的children队列  
9.	  updateChildren(parent, this, false);  
10.	  this.filename = null;  
11.	  // 是否已经加载  
12.	  this.loaded = false;  
13.	  this.children = [];  
14.	}  
```

接着看一下load函数的逻辑。

```
1.	Module.prototype.load = function(filename) {  
2.	  this.filename = filename;  
3.	  // 拓展名  
4.	  const extension = findLongestRegisteredExtension(filename);  
5.	  // 根据拓展名使用不同的加载方式  
6.	  Module._extensions[extension](this, filename);  
7.	  this.loaded = true;  
8.	};  
```

Node.js会根据不同的文件拓展名使用不同的函数处理。
## 19.1 加载用户模块
在Node.js中_extensions有三种，分别是js、json、node。
### 19.1.1 加载JSON模块
加载JSON模块是比较简单的

```
1.	Module._extensions['.json'] = function(module, filename) {  
2.	  const content = fs.readFileSync(filename, 'utf8');  
3.	  
4.	  try {  
5.	    module.exports = JSONParse(stripBOM(content));  
6.	  } catch (err) {  
7.	    err.message = filename + ': ' + err.message;  
8.	    throw err;  
9.	  }  
10.	};  
```

直接读取JSON文件的内容，然后解析成对象就行。
### 19.1.2 加载JS模块

```
1.	Module._extensions['.js'] = function(module, filename) {  
2.	  const content = fs.readFileSync(filename, 'utf8');  
3.	  module._compile(content, filename);  
4.	};  
```

读完文件的内容，然后执行_compile

```
1.	Module.prototype._compile = function(content, filename) {  
2.	  // 生成一个函数  
3.	  const compiledWrapper = wrapSafe(filename, content, this);  
4.	  const dirname = path.dirname(filename);  
5.	  // require是对_load函数的封装 
6.	  const require = (path) => {
7.	      return this.require(path);
8.	    };
9.	  let result;  
10.	    // 我们平时使用的exports变量
11.	  const exports = this.exports;  
12.	  const thisValue = exports; 
13.	    // 我们平时使用的module变量 
14.	  const module = this;  
15.	  // 执行函数  
16.	  result = compiledWrapper.call(thisValue,
17.	                                    exports, 
18.	                                    require, 
19.	                                    module, 
20.	                                    filename, 
21.	                                    dirname);  
22.	  return result;  
23.	}  
```

_compile里面包括了几个重要的逻辑
1 wrapSafe：包裹我们的代码并生成一个函数
2 require：支持在模块内加载其他模块
3 执行模块代码
我们看一下这三个逻辑。
1 wrapSafe

```
1.	function wrapSafe(filename, content, cjsModuleInstance) {    
2.	    const wrapper = Module.wrap(content);    
3.	    return vm.runInThisContext(wrapper, {    
4.	      filename,    
5.	      lineOffset: 0,    
6.	      ...    
7.	    });    
8.	}    
9.	    
10.	const wrapper = [    
11.	  '(function (exports, require, module, __filename, __dirname) { ',    
12.	  '\n});'    
13.	];    
14.	    
15.	Module.wrap = function(script) {    
16.	  return Module.wrapper[0] + script + Module.wrapper[1];    
17.	};  
```

vm.runInThisContext的第一个参数是”(function() {})”的时候，会返回一个函数。所以执行Module.wrap后会返回一个字符串，内容如下

```
2.	(function (exports, require, module, __filename, __dirname) { 
3.	  // 
4.	});   
```

接着我们看一下require函数，即我们平时在代码中使用的require。
2 require

```
1.	Module.prototype.require = function(id) {  
2.	  requireDepth++;  
3.	  try {  
4.	    return Module._load(id, this, /* isMain */ false);  
5.	  } finally {  
6.	    requireDepth--;  
7.	  }  
8.	};  
```

require是对Module._load的封装，Module._load会把模块导出的变量通过module.exports属性返回给require调用方。因为Module._load只会从原生JS模块和用户JS模块中查找用户需要加载的模块，所以是无法访问C++模块的，访问C++模块可用process.bindng或internalBinding。
3 执行代码
我们回到_compile函数。看一下执行vm.runInThisContext返回的函数。

```
compiledWrapper.call(exports,
                     exports,
                     require,
                     module,
                     filename,
                     dirname);  
```

相当于执行以下代码

```
1.	(function (exports, require, module, __filename, __dirname) {  
2.	  const myjs= require(‘myjs);
3.	  const net = require(‘net’);
4.	});   
```

至此，Node.js开始执行用户的JS代码。刚才我们我们已经分析过require是对Module._load的封装，当执行require加载用户模块时，又回到了我们正在分析的这个过程。
### 19.1.3 加载node模块
Node拓展的模块本质上是动态链接库，我们看require一个.node模块的时候的过程。我们从加载.node模块的源码开始。

```
1.	Module._extensions['.node'] = function(module, filename) {  
2.	  // ...  
3.	  return process.dlopen(module, path.toNamespacedPath(filename)); 
4.	};  
```

直接调了process.dlopen，该函数在node.js里定义。  

```
1.	const rawMethods = internalBinding('process_methods');  
2.	process.dlopen = rawMethods.dlopen;  
```

找到process_methods模块对应的是node_process_methods.cc。  

```
env->SetMethod(target, "dlopen", binding::DLOpen);  
```

之前说过，Node.js的拓展模块其实是动态链接库，那么我们先看看一个动态链接库我们是如何使用的。以下是示例代码。  

```
1.	#include <stdio.h>  
2.	#include <stdlib.h>  
3.	#include <dlfcn.h>  
4.	int main(){  
5.	    // 打开一个动态链接库，拿到一个handler  
6.	    handler = dlopen('xxx.so',RTLD_LAZY);  
7.	    // 取出动态链接库里的函数add  
8.	    add = dlsym(handler,"add");  
9.	    // 执行  
10.	    printf("%d",add(1,1));  
11.	    dlclose(handler);  
12.	    return 0;  
13.	}  
```

了解动态链接库的使用，我们继续分析刚才看到的DLOpen函数。  

```
1.	void DLOpen(const FunctionCallbackInfo<Value>& args) {  
2.	  
3.	  int32_t flags = DLib::kDefaultFlags;
4.	  node::Utf8Value filename(env->isolate(), args[1]);  // Cast  
5.	  env->TryLoadAddon(*filename, flags, [&](DLib* dlib) {  
6.	    const bool is_opened = dlib->Open(); 
7.	    node_module* mp = thread_local_modpending;  
8.	    thread_local_modpending = nullptr;  
9.	    // 省略部分代码  
10.	    if (mp->nm_context_register_func != nullptr) {  
11.	      mp->nm_context_register_func(exports, 
12.	                                         module, 
13.	                                         context, 
14.	                                         mp->nm_priv);  
15.	    } else if (mp->nm_register_func != nullptr) {  
16.	      mp->nm_register_func(exports, module, mp->nm_priv);  
17.	    }   
18.	    return true;  
19.	  });  
20.	}  
```

我们看到重点是TryLoadAddon函数，该函数的逻辑就是执行它的第三个参数。我们发现第三个参数是一个函数，入参是DLib对象。所以我们先看看这个类。 

```
1.	class DLib {  
2.	 public:  
3.	  static const int kDefaultFlags = RTLD_LAZY;  
4.	  DLib(const char* filename, int flags);  
5.	  
6.	  bool Open();  
7.	  void Close();  
8.	  const std::string filename_;  
9.	  const int flags_;  
10.	  std::string errmsg_;  
11.	  void* handle_;  
12.	  uv_lib_t lib_;  
13.	};  
```

再看一下实现。  

```
1.	bool DLib::Open() {  
2.	  handle_ = dlopen(filename_.c_str(), flags_);  
3.	  if (handle_ != nullptr) return true;  
4.	  errmsg_ = dlerror();  
5.	  return false;  
6.	}  
```

DLib就是对动态链接库的一个封装，它封装了动态链接库的文件名和操作。TryLoadAddon函数首先根据require传入的文件名，构造一个DLib，然后执行  

```
const bool is_opened = dlib->Open();  
```

Open函数打开了一个动态链接库，这时候我们要先了解一下打开一个动态链接库究竟发生了什么。首先我们一般C++插件最后一句代码的定义。

```
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)  
```

这是个宏定义。 

```
1.	#define NAPI_MODULE(modname, regfunc) \    
2.	  NAPI_MODULE_X(modname, regfunc, NULL, 0)    
3.	 #define NAPI_MODULE_X(modname, regfunc, priv, flags)                  \    
4.	    static napi_module _module = \    
5.	    {                  \    
6.	      NAPI_MODULE_VERSION, \    
7.	      flags,          \    
8.	      __FILE__,        \    
9.	      regfunc,        \    
10.	      #modname,        \    
11.	      priv,            \    
12.	      {0},            \    
13.	    };                \    
14.	    static void _register_modname(void) __attribute__((constructor)); \    
15.	      static void _register_modname(void)      {    \    
16.	      napi_module_register(&_module);  \    
17.	    }      
```

所以一个node扩展就是定义了一个napi_module模块和一个register_modname（modname是我们定义的）函数。__attribute((constructor))是代表该函数会先执行的意思，具体可以查阅文档。看到这里我们知道，当我们打开一个动态链接库的时候，会执行_register_modname函数，该函数执行的是  

```
napi_module_register(&_module);    
```

我们继续展开。

```
1.	  
2.	// Registers a NAPI module.  
3.	void napi_module_register(napi_module* mod) {  
4.	  node::node_module* nm = new node::node_module {  
5.	    -1,  
6.	    mod->nm_flags | NM_F_DELETEME,  
7.	    nullptr,  
8.	    mod->nm_filename,  
9.	    nullptr,  
10.	    napi_module_register_cb,  
11.	    mod->nm_modname,  
12.	    mod,  // priv  
13.	    nullptr,  
14.	  };  
15.	  node::node_module_register(nm);  
16.	}  
```

Node.js把napi模块转成node_module。最后调用node_module_register。 

```
1.	  
2.	extern "C" void node_module_register(void* m) {  
3.	  struct node_module* mp = reinterpret_cast<struct node_module*>(m);  
4.	  
5.	  if (mp->nm_flags & NM_F_INTERNAL) {  
6.	    mp->nm_link = modlist_internal;  
7.	    modlist_internal = mp;  
8.	  } else if (!node_is_initialized) {  
9.	    mp->nm_flags = NM_F_LINKED;  
10.	    mp->nm_link = modlist_linked;  
11.	    modlist_linked = mp;  
12.	  } else {  
13.	    thread_local_modpending = mp;  
14.	  }  
15.	}  
```

napi模块不是NM_F_INTERNAL模块，node_is_initialized是在Node.js初始化时设置的变量，这时候已经是true。所以注册napi模块时，会执行thread_local_modpending = mp。thread_local_modpending 类似一个全局变量，保存当前加载的模块。分析到这，我们回到DLOpen函数。 

```
1.	node_module* mp = thread_local_modpending;  
2.	thread_local_modpending = nullptr;  
```

这时候我们就知道刚才那个变量thread_local_modpending的作用了。node_module* mp = thread_local_modpending后我们拿到了我们刚才定义的napi模块的信息。接着执行node_module的函数nm_register_func。  

```
1.	if (mp->nm_context_register_func != nullptr) {  
2.	  mp->nm_context_register_func(exports, 
3.	                                 module, 
4.	                                 context, 
5.	                                 mp->nm_priv);  
6.	 } else if (mp->nm_register_func != nullptr) {  
7.	   mp->nm_register_func(exports, module, mp->nm_priv);  
8.	 }  
```

从刚才的node_module定义中我们看到函数是napi_module_register_cb。  

```
1.	static void napi_module_register_cb(v8::Local<v8::Object> exports,  
2.	                                  v8::Local<v8::Value> module,  
3.	                                  v8::Local<v8::Context> context,  
4.	                                  void* priv) {  
5.	  napi_module_register_by_symbol(exports, module, context,  
6.	      static_cast<napi_module*>(priv)->nm_register_func);  
7.	}  
```

该函数调用napi_module_register_by_symbol函数，并传入napi_module的nm_register_func函数。 

```
1.	void napi_module_register_by_symbol(v8::Local<v8::Object> exports,  
2.	                                  v8::Local<v8::Value> module,  
3.	                                  v8::Local<v8::Context> context,  
4.	                                  napi_addon_register_func init) {  
5.	  
6.	  // Create a new napi_env for this specific module.  
7.	  napi_env env = v8impl::NewEnv(context);  
8.	  
9.	  napi_value _exports;  
10.	  env->CallIntoModuleThrow([&](napi_env env) {  
11.	    _exports = init(env, v8impl::JsValueFromV8LocalValue(exports));  
12.	  });  
13.	  
14.	  if (_exports != nullptr &&  
15.	      _exports != v8impl::JsValueFromV8LocalValue(exports)) { 
16.	    napi_value _module = v8impl::JsValueFromV8LocalValue(module);  
17.	    napi_set_named_property(env, _module, "exports", _exports);  
18.	  }  
19.	}  
```

init就是我们定义的函数。入参是env和exports，可以对比我们定义的函数的入参。最后我们修改exports变量。即设置导出的内容。最后在JS里，我们就拿到了C++层定义的内容。  
## 19.2 加载原生JS模块
上一节我们了解了Node.js执行node demo.js的过程，其中我们在demo.js中使用require加载net模块。net是原生JS模块。这时候就会进入原生模块的处理逻辑。
原生模块是Node.js内部实现的JS模块。使用NativeModule来表示。

```
1.	class NativeModule {  
2.	  // 原生JS模块的map  
3.	  static map = new Map(moduleIds.map((id) => [id, new NativeModule(id)]));  
4.	  
5.	  constructor(id) {  
6.	    this.filename = `${id}.js`;  
7.	    this.id = id;  
8.	    this.canBeRequiredByUsers = !id.startsWith('internal/');  
9.	    this.exports = {};  
10.	    this.loaded = false;  
11.	    this.loading = false;  
12.	    this.module = undefined;  
13.	    this.exportKeys = undefined;  
14.	  }  
15.	} 
```

 
当我们执行require(‘net’)时，就会进入_load函数。_load函数判断要加载的模块是原生JS模块后，会通过loadNativeModule函数加载原生JS模块。我们看这个函数的定义。

```
1.	function loadNativeModule(filename, request) {  
2.	  const mod = NativeModule.map.get(filename);  
3.	  if (mod) {  
4.	    mod.compileForPublicLoader();  
5.	    return mod;  
6.	  }  
7.	}  
```

在Node.js启动过程中我们分析过，mod是一个NativeModule对象，接着看compileForPublicLoader。

```
1.	compileForPublicLoader() {  
2.	    this.compileForInternalLoader();  
3.	    return this.exports;  
4.	}  
5.	  
6.	compileForInternalLoader() {  
7.	    if (this.loaded || this.loading) {  
8.	      return this.exports;  
9.	    }  
10.	    // id就是我们要加载的模块，比如net 
11.	    const id = this.id;  
12.	    this.loading = true;  
13.	    try {  
14.	      const fn = compileFunction(id);  
15.	      fn(this.exports, 
16.	               // 加载原生JS模块的加载器
17.	               nativeModuleRequire, 
18.	               this, 
19.	               process, 
20.	               // 加载C++模块的加载器
21.	               internalBinding, 
22.	               primordials);  
23.	      this.loaded = true;  
24.	    } finally {  
25.	      this.loading = false;  
26.	    }  
27.	    return this.exports;  
28.	  }  
```

我们重点看compileFunction这里的逻辑。该函数是node_native_module_env.cc模块导出的函数。具体的代码就不贴了，通过层层查找，最后到node_native_module.cc 的NativeModuleLoader::CompileAsModule

```
1.	MaybeLocal<Function> NativeModuleLoader::CompileAsModule(  
2.	    Local<Context> context,  
3.	    const char* id,  
4.	    NativeModuleLoader::Result* result) {  
5.	  
6.	  Isolate* isolate = context->GetIsolate();  
7.	  // 函数的形参  
8.	  std::vector<Local<String>> parameters = {  
9.	      FIXED_ONE_BYTE_STRING(isolate, "exports"),  
10.	      FIXED_ONE_BYTE_STRING(isolate, "require"),  
11.	      FIXED_ONE_BYTE_STRING(isolate, "module"),  
12.	      FIXED_ONE_BYTE_STRING(isolate, "process"),  
13.	      FIXED_ONE_BYTE_STRING(isolate, "internalBinding"),  
14.	      FIXED_ONE_BYTE_STRING(isolate, "primordials")};  
15.	  // 编译出一个函数  
16.	  return LookupAndCompile(context, id, &parameters, result);  
17.	}  
```

我们继续看LookupAndCompile。

```
1.	MaybeLocal<Function> NativeModuleLoader::LookupAndCompile(  
2.	    Local<Context> context,  
3.	    const char* id,  
4.	    std::vector<Local<String>>* parameters,  
5.	    NativeModuleLoader::Result* result) {  
6.	  
7.	  Isolate* isolate = context->GetIsolate();  
8.	  EscapableHandleScope scope(isolate);  
9.	  
10.	  Local<String> source;  
11.	  // 找到原生JS模块内容所在的内存地址  
12.	  if (!LoadBuiltinModuleSource(isolate, id).ToLocal(&source)) {  
13.	    return {};  
14.	  }  
15.	  // ‘net’ + ‘.js’
16.	  std::string filename_s = id + std::string(".js");  
17.	  Local<String> filename =  
18.	      OneByteString(isolate, 
19.	            filename_s.c_str(), 
20.	            filename_s.size());  
21.	  // 省略一些参数处理  
22.	  // 脚本源码  
23.	  ScriptCompiler::Source script_source(source, origin, cached_data);  
24.	  // 编译出一个函数  
25.	  MaybeLocal<Function> maybe_fun =  
26.	      ScriptCompiler::CompileFunctionInContext(context,  
27.	                                                  &script_source,  
28.	                           parameters->size(),
29.	                           parameters->data(),
30.	                           0,  
31.	                           nullptr,  
32.	                           options);  
33.	  Local<Function> fun = maybe_fun.ToLocalChecked();  
34.	  return scope.Escape(fun);  
35.	}  
```

LookupAndCompile函数首先找到加载模块的源码，然后编译出一个函数。我们看一下LoadBuiltinModuleSource如何查找模块源码的。

```
1.	MaybeLocal<String> NativeModuleLoader::LoadBuiltinModuleSource(Isolate* isolate, const char* id) {  
2.	  const auto source_it = source_.find(id);  
3.	  return source_it->second.ToStringChecked(isolate);  
4.	}  
```

这里是id是net，通过该id从_source中找到对应的数据，那么_source是什么呢？因为Node.js为了提高效率，把原生JS模块的源码字符串直接转成ASCII码存到内存里。这样加载这些模块的时候，就不需要硬盘IO了。直接从内存读取就行。我们看一下_source的定义（在编译Node.js源码或者执行js2c.py生成的node_javascript.cc中）。

```
1.	source_.emplace("net", UnionBytes{net_raw, 46682});  
2.	source_.emplace("cyb", UnionBytes{cyb_raw, 63});  
3.	source_.emplace("os", UnionBytes{os_raw, 7548});  
```

cyb是我增加的测试模块。我们可以看一下该模块的内容。

```
1.	static const uint8_t cyb_raw[] = {  
2.	 99,111,110,115,116, 32, 99,121, 98, 32, 61, 32,105,110,116,101,114,110, 97,108, 66,105,110,100,105,110,103, 40, 39, 99,  
3.	121, 98, 95,119,114, 97,112, 39, 41, 59, 32, 10,109,111,100,117,108,101, 46,101,120,112,111,114,116,115, 32, 61, 32, 99,  
4.	121, 98, 59  
5.	};  
```

我们转成字符串看一下是什么

```
1.	Buffer.from([99,111,110,115,116, 32, 99,121, 98, 32, 61, 32,105,110,116,101,114,110, 97,108, 66,105,110,100,105,110,103, 40, 39, 99,
2.	121, 98, 95,119,114, 97,112, 39, 41, 59, 32, 10,109,111,100,117,108,101, 46,101,120,112,111,114,116,115, 32, 61, 32, 99,    
3.	121, 98, 59].join(',').split(',')).toString('utf-8')  
```

输出

```
1.	const cyb = internalBinding('cyb_wrap');   
2.	module.exports = cyb;  
```

所以我们执行require('net')时，通过NativeModule的compileForInternalLoader，最终会在_source中找到net模块对应的源码字符串，然后编译成一个函数。

```
1.	const fn = compileFunction(id);  
2.	fn(this.exports, 
3.	   // 加载原生JS模块的加载器
4.	   nativeModuleRequire, 
5.	   this, 
6.	   process, 
7.	   // 加载C++模块的加载器
8.	   internalBinding, 
9.	   primordials);   
```

由fn的入参可以知道，我们在net（或其它原生JS模块中）只能加载原生JS模块和内置的C++模块。当fn执行完毕后，原生模块加载器就会把mod.exports的值返回给调用方。
19.3 加载内置C++模块
在原生JS模块中我们一般会加载一些内置的C++模块，这是Node.js拓展JS功能的关键之处。比如我们require(‘net’)的时候，net模块会加载tcp_wrap模块。

```
1.	const {  
2.	  TCP,  
3.	  TCPConnectWrap,  
4.	  constants: TCPConstants  
5.	} = internalBinding('tcp_wrap')  
```

C++模块加载器也是在internal/bootstrap/loaders.js中定义的，分为三种。  
1 internalBinding：不暴露给用户的访问的接口，只能在Node.js代码中访问，比如原生JS模块（flag为NM_F_INTERNAL）。

```
1.	let internalBinding;  
2.	{  
3.	  const bindingObj = ObjectCreate(null);   
4.	  internalBinding = function internalBinding(module) {  
5.	    let mod = bindingObj[module];  
6.	    if (typeof mod !== 'object') {  
7.	      mod = bindingObj[module] = getInternalBinding(module);  
8.	      moduleLoadList.push(`Internal Binding ${module}`);  
9.	    }  
10.	    return mod;  
11.	  };  
12.	}  
```

internalBinding是在getInternalBinding函数基础上加了缓存功能。getInternalBinding是C++层定义的函数对JS暴露的接口名。它的作用是从C++模块链表中找到对应的模块。  
2 process.binding：暴露给用户调用C++模块的接口，但是只能访问部分C++模块（flag为NM_F_BUILTIN的C++模块）。

```
1.	process.binding = function binding(module) {  
2.	  module = String(module);  
3.	  if (internalBindingWhitelist.has(module)) {  
4.	    return internalBinding(module);  
5.	  }  
6.	  throw new Error(`No such module: ${module}`);  
7.	};  
```

binding是在internalBinding的基础上加了白名单的逻辑，只对外暴露部分模块。

```
1.	const internalBindingWhitelist = new SafeSet([  
2.	  'async_wrap',  
3.	  'buffer',  
4.	  'cares_wrap',  
5.	  'config',  
6.	  'constants',  
7.	  'contextify',  
8.	  'crypto',  
9.	  'fs',  
10.	  'fs_event_wrap',  
11.	  'http_parser',  
12.	  'icu',  
13.	  'inspector',  
14.	  'js_stream',  
15.	  'natives',  
16.	  'os',  
17.	  'pipe_wrap',  
18.	  'process_wrap',  
19.	  'signal_wrap',  
20.	  'spawn_sync',  
21.	  'stream_wrap',  
22.	  'tcp_wrap',  
23.	  'tls_wrap',  
24.	  'tty_wrap',  
25.	  'udp_wrap',  
26.	  'url',  
27.	  'util',  
28.	  'uv',  
29.	  'v8',  
30.	  'zlib'  
31.	]);  
```

3 process._linkedBinding: 暴露给用户访问C++模块的接口，用于访问用户自己添加的但是没有加到内置模块的C++模块（flag为NM_F_LINKED）。

```
1.	const bindingObj = ObjectCreate(null);  
2.	process._linkedBinding = function _linkedBinding(module) {  
3.	  module = String(module);  
4.	  let mod = bindingObj[module];  
5.	  if (typeof mod !== 'object')  
6.	    mod = bindingObj[module] = getLinkedBinding(module);  
7.	  return mod;  
8.	};  
```

_linkedBinding是在getLinkedBinding函数基础上加了缓存功能，getLinkedBinding是C++层定义的函数对外暴露的名字。getLinkedBinding从另一个C++模块链表中查找对应的模块。
上一节已经分析过，internalBinding是加载原生JS模块时传入的实参。internalBinding是对getInternalBinding的封装。getInternalBinding对应的是binding::GetInternalBinding（node_binding.cc）。

```
1.	// 根据模块名查找对应的模块  
2.	void GetInternalBinding(const FunctionCallbackInfo<Value>& args) {  
3.	  Environment* env = Environment::GetCurrent(args);  
4.	  // 模块名  
5.	  Local<String> module = args[0].As<String>();  
6.	  node::Utf8Value module_v(env->isolate(), module);  
7.	  Local<Object> exports;  
8.	  // 从C++内部模块找  
9.	  node_module* mod = FindModule(modlist_internal, 
10.	                                     *module_v, 
11.	                                     NM_F_INTERNAL);  
12.	  // 找到则初始化  
13.	  if (mod != nullptr) {  
14.	    exports = InitModule(env, mod, module);  
15.	  } else {  
16.	     // 省略  
17.	  }  
18.	  
19.	  args.GetReturnValue().Set(exports);  
20.	}  
```

modlist_internal是一条链表，在Node.js启动过程的时候，由各个C++模块连成的链表。通过模块名找到对应的C++模块后，执行InitModule初始化模块。

```
1.	// 初始化一个模块，即执行它里面的注册函数  
2.	static Local<Object> InitModule(Environment* env,  
3.	                 node_module* mod,  
4.	                 Local<String> module) {  
5.	  Local<Object> exports = Object::New(env->isolate());  
6.	  Local<Value> unused = Undefined(env->isolate());  
7.	  mod->nm_context_register_func(exports, unused, env->context(), mod->nm_priv);  
8.	  return exports;  
9.	}  
```

执行C++模块的nm_context_register_func指向的函数。这个函数就是在C++模块最后一行定义的Initialize函数。Initialize会设置导出的对象。我们从JS可以访问Initialize导出的对象。V8中，JS调用C++函数的规则是函数入参const FunctionCallbackInfo<Value>& args（拿到JS传过来的内容）和设置返回值args.GetReturnValue().Set(给JS返回的内容), GetInternalBinding函数的逻辑就是执行对应模块的钩子函数，并传一个exports变量进去，然后钩子函数会修改exports的值，该exports的值就是JS层能拿到的值。
