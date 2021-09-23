Node.js的模块分为用户JS模块、Node.js原生JS模块、Node.js内置C++模块。本章介绍这些模块加载的原理以及Node.js中模块加载器的类型和原理。
下面我们以一个例子为开始，分析Node.js中模块加载的原理。假设我们有一个文件demo.js，代码如下

```
    const myjs= require(‘myjs); 
    const net = require(‘net’); 
```

其中myjs的代码如下

```
    exports.hello = ‘world’;
```

我们看一下执行node demo.js的时候，过程是怎样的。在Node.js启动章节我们分析过，Node.js启动的时候，会执行以下代码。
require('internal/modules/cjs/loader').Module.runMain(process.argv[1]) 
其中runMain函数在pre_execution.js的initializeCJSLoader中挂载

```
    function initializeCJSLoader() {  
      const CJSLoader = require('internal/modules/cjs/loader');  
      CJSLoader.Module._initPaths();  
      CJSLoader.Module.runMain =  
        require('internal/modules/run_main').executeUserEntryPoint;  
    }  
```

我们看到runMain是run_main.js导出的函数。继续往下看

```
    const CJSLoader = require('internal/modules/cjs/loader');
    const { Module } = CJSLoader;
    function executeUserEntryPoint(main = process.argv[1]) {  
      const resolvedMain = resolveMainPath(main);  
      const useESMLoader = shouldUseESMLoader(resolvedMain);  
      if (useESMLoader) {  
        runMainESM(resolvedMain || main);  
      } else {  
        Module._load(main, null, true);  
      }  
    }  
      
    module.exports = {  
      executeUserEntryPoint  
    };  
```

process.argv[1]就是我们要执行的JS文件。最后通过cjs/loader.js的Module._load加载了我们的JS。下面我们看一下具体的处理逻辑。

```
    Module._load = function(request, parent, isMain) {  
      const filename = Module._resolveFilename(request, parent, isMain);  
      
      const cachedModule = Module._cache[filename];  
      // 有缓存则直接返回  
      if (cachedModule !== undefined) {  
        updateChildren(parent, cachedModule, true);  
        if (!cachedModule.loaded)  
          return getExportsForCircularRequire(cachedModule);  
        return cachedModule.exports;  
      }  
      // 是否是可访问的原生JS模块，是则返回  
      const mod = loadNativeModule(filename, request);  
      if (mod && mod.canBeRequiredByUsers) return mod.exports;  
      // 非原生JS模块，则新建一个Module表示加载的模块  
      const module = new Module(filename, parent);  
      // 缓存  
      Module._cache[filename] = module;  
      // 加载
      module.load(filename);  
      // 调用方拿到的是module.exports的值
      return module.exports;  
    };  
```

_load函数主要是三个逻辑  
1 判断是否有缓存，有则返回。  
2 没有缓存，则判断是否是原生JS模块，是则交给原生模块处理。  
1	不是原生模块，则新建一个Module表示用户的JS模块，然后执行load函数加载。  
这里我们只需要关注3的逻辑，在Node.js中，用户定义的模块使用Module表示。

```
    function Module(id = '', parent) {  
      // 模块对应的文件路径  
      this.id = id;  
      this.path = path.dirname(id);  
      // 在模块里使用的exports变量  
      this.exports = {};  
      this.parent = parent;  
      // 加入父模块的children队列  
      updateChildren(parent, this, false);  
      this.filename = null;  
      // 是否已经加载  
      this.loaded = false;  
      this.children = [];  
    }  
```

接着看一下load函数的逻辑。

```
    Module.prototype.load = function(filename) {  
      this.filename = filename;  
      // 拓展名  
      const extension = findLongestRegisteredExtension(filename);  
      // 根据拓展名使用不同的加载方式  
      Module._extensions[extension](this, filename);  
      this.loaded = true;  
    };  
```

Node.js会根据不同的文件拓展名使用不同的函数处理。
## 19.1 加载用户模块
在Node.js中_extensions有三种，分别是js、json、node。
### 19.1.1 加载JSON模块
加载JSON模块是比较简单的

```
    Module._extensions['.json'] = function(module, filename) {  
      const content = fs.readFileSync(filename, 'utf8');  
      
      try {  
        module.exports = JSONParse(stripBOM(content));  
      } catch (err) {  
        err.message = filename + ': ' + err.message;  
        throw err;  
      }  
    };  
```

直接读取JSON文件的内容，然后解析成对象就行。
### 19.1.2 加载JS模块

```
    Module._extensions['.js'] = function(module, filename) {  
      const content = fs.readFileSync(filename, 'utf8');  
      module._compile(content, filename);  
    };  
```

读完文件的内容，然后执行_compile

```
    Module.prototype._compile = function(content, filename) {  
      // 生成一个函数  
      const compiledWrapper = wrapSafe(filename, content, this);  
      const dirname = path.dirname(filename);  
      // require是对_load函数的封装 
      const require = (path) => {
          return this.require(path);
        };
      let result;  
        // 我们平时使用的exports变量
      const exports = this.exports;  
      const thisValue = exports; 
        // 我们平时使用的module变量 
      const module = this;  
      // 执行函数  
      result = compiledWrapper.call(thisValue,
                                        exports, 
                                        require, 
                                        module, 
                                        filename, 
                                        dirname);  
      return result;  
    }  
```

_compile里面包括了几个重要的逻辑
1 wrapSafe：包裹我们的代码并生成一个函数
2 require：支持在模块内加载其他模块
3 执行模块代码
我们看一下这三个逻辑。
1 wrapSafe

```
    function wrapSafe(filename, content, cjsModuleInstance) {    
        const wrapper = Module.wrap(content);    
        return vm.runInThisContext(wrapper, {    
          filename,    
          lineOffset: 0,    
          ...    
        });    
    }    
        
    const wrapper = [    
      '(function (exports, require, module, __filename, __dirname) { ',    
      '\n});'    
    ];    
        
    Module.wrap = function(script) {    
      return Module.wrapper[0] + script + Module.wrapper[1];    
    };  
```

vm.runInThisContext的第一个参数是”(function() {})”的时候，会返回一个函数。所以执行Module.wrap后会返回一个字符串，内容如下

```
    (function (exports, require, module, __filename, __dirname) { 
      // 
    });   
```

接着我们看一下require函数，即我们平时在代码中使用的require。
2 require

```
    Module.prototype.require = function(id) {  
      requireDepth++;  
      try {  
        return Module._load(id, this, /* isMain */ false);  
      } finally {  
        requireDepth--;  
      }  
    };  
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
    (function (exports, require, module, __filename, __dirname) {  
      const myjs= require(‘myjs);
      const net = require(‘net’);
    });   
```

至此，Node.js开始执行用户的JS代码。刚才我们我们已经分析过require是对Module._load的封装，当执行require加载用户模块时，又回到了我们正在分析的这个过程。
### 19.1.3 加载node模块
Node拓展的模块本质上是动态链接库，我们看require一个.node模块的时候的过程。我们从加载.node模块的源码开始。

```
    Module._extensions['.node'] = function(module, filename) {  
      // ...  
      return process.dlopen(module, path.toNamespacedPath(filename)); 
    };  
```

直接调了process.dlopen，该函数在node.js里定义。  

```
    const rawMethods = internalBinding('process_methods');  
    process.dlopen = rawMethods.dlopen;  
```

找到process_methods模块对应的是node_process_methods.cc。  

```
env->SetMethod(target, "dlopen", binding::DLOpen);  
```

之前说过，Node.js的拓展模块其实是动态链接库，那么我们先看看一个动态链接库我们是如何使用的。以下是示例代码。  

```
    #include <stdio.h>  
    #include <stdlib.h>  
    #include <dlfcn.h>  
    int main(){  
        // 打开一个动态链接库，拿到一个handler  
        handler = dlopen('xxx.so',RTLD_LAZY);  
        // 取出动态链接库里的函数add  
        add = dlsym(handler,"add");  
        // 执行  
        printf("%d",add(1,1));  
        dlclose(handler);  
        return 0;  
    }  
```

了解动态链接库的使用，我们继续分析刚才看到的DLOpen函数。  

```
    void DLOpen(const FunctionCallbackInfo<Value>& args) {  
      
      int32_t flags = DLib::kDefaultFlags;
      node::Utf8Value filename(env->isolate(), args[1]);  // Cast  
      env->TryLoadAddon(*filename, flags, [&](DLib* dlib) {  
        const bool is_opened = dlib->Open(); 
        node_module* mp = thread_local_modpending;  
        thread_local_modpending = nullptr;  
        // 省略部分代码  
        if (mp->nm_context_register_func != nullptr) {  
          mp->nm_context_register_func(exports, 
                                             module, 
                                             context, 
                                             mp->nm_priv);  
        } else if (mp->nm_register_func != nullptr) {  
          mp->nm_register_func(exports, module, mp->nm_priv);  
        }   
        return true;  
      });  
    }  
```

我们看到重点是TryLoadAddon函数，该函数的逻辑就是执行它的第三个参数。我们发现第三个参数是一个函数，入参是DLib对象。所以我们先看看这个类。 

```
    class DLib {  
     public:  
      static const int kDefaultFlags = RTLD_LAZY;  
      DLib(const char* filename, int flags);  
      
      bool Open();  
      void Close();  
      const std::string filename_;  
      const int flags_;  
      std::string errmsg_;  
      void* handle_;  
      uv_lib_t lib_;  
    };  
```

再看一下实现。  

```
    bool DLib::Open() {  
      handle_ = dlopen(filename_.c_str(), flags_);  
      if (handle_ != nullptr) return true;  
      errmsg_ = dlerror();  
      return false;  
    }  
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
    #define NAPI_MODULE(modname, regfunc) \    
      NAPI_MODULE_X(modname, regfunc, NULL, 0)    
     #define NAPI_MODULE_X(modname, regfunc, priv, flags)                  \    
        static napi_module _module = \    
        {                  \    
          NAPI_MODULE_VERSION, \    
          flags,          \    
          __FILE__,        \    
          regfunc,        \    
          #modname,        \    
          priv,            \    
          {0},            \    
        };                \    
        static void _register_modname(void) __attribute__((constructor)); \    
          static void _register_modname(void)      {    \    
          napi_module_register(&_module);  \    
        }      
```

所以一个node扩展就是定义了一个napi_module模块和一个register_modname（modname是我们定义的）函数。__attribute((constructor))是代表该函数会先执行的意思，具体可以查阅文档。看到这里我们知道，当我们打开一个动态链接库的时候，会执行_register_modname函数，该函数执行的是  

```
napi_module_register(&_module);    
```

我们继续展开。

```
      
    // Registers a NAPI module.  
    void napi_module_register(napi_module* mod) {  
      node::node_module* nm = new node::node_module {  
        -1,  
        mod->nm_flags | NM_F_DELETEME,  
        nullptr,  
        mod->nm_filename,  
        nullptr,  
        napi_module_register_cb,  
        mod->nm_modname,  
        mod,  // priv  
        nullptr,  
      };  
      node::node_module_register(nm);  
    }  
```

Node.js把napi模块转成node_module。最后调用node_module_register。 

```
      
    extern "C" void node_module_register(void* m) {  
      struct node_module* mp = reinterpret_cast<struct node_module*>(m);  
      
      if (mp->nm_flags & NM_F_INTERNAL) {  
        mp->nm_link = modlist_internal;  
        modlist_internal = mp;  
      } else if (!node_is_initialized) {  
        mp->nm_flags = NM_F_LINKED;  
        mp->nm_link = modlist_linked;  
        modlist_linked = mp;  
      } else {  
        thread_local_modpending = mp;  
      }  
    }  
```

napi模块不是NM_F_INTERNAL模块，node_is_initialized是在Node.js初始化时设置的变量，这时候已经是true。所以注册napi模块时，会执行thread_local_modpending = mp。thread_local_modpending 类似一个全局变量，保存当前加载的模块。分析到这，我们回到DLOpen函数。 

```
    node_module* mp = thread_local_modpending;  
    thread_local_modpending = nullptr;  
```

这时候我们就知道刚才那个变量thread_local_modpending的作用了。node_module* mp = thread_local_modpending后我们拿到了我们刚才定义的napi模块的信息。接着执行node_module的函数nm_register_func。  

```
    if (mp->nm_context_register_func != nullptr) {  
      mp->nm_context_register_func(exports, 
                                     module, 
                                     context, 
                                     mp->nm_priv);  
     } else if (mp->nm_register_func != nullptr) {  
       mp->nm_register_func(exports, module, mp->nm_priv);  
     }  
```

从刚才的node_module定义中我们看到函数是napi_module_register_cb。  

```
    static void napi_module_register_cb(v8::Local<v8::Object> exports,  
                                      v8::Local<v8::Value> module,  
                                      v8::Local<v8::Context> context,  
                                      void* priv) {  
      napi_module_register_by_symbol(exports, module, context,  
          static_cast<napi_module*>(priv)->nm_register_func);  
    }  
```

该函数调用napi_module_register_by_symbol函数，并传入napi_module的nm_register_func函数。 

```
    void napi_module_register_by_symbol(v8::Local<v8::Object> exports,  
                                      v8::Local<v8::Value> module,  
                                      v8::Local<v8::Context> context,  
                                      napi_addon_register_func init) {  
      
      // Create a new napi_env for this specific module.  
      napi_env env = v8impl::NewEnv(context);  
      
      napi_value _exports;  
      env->CallIntoModuleThrow([&](napi_env env) {  
        _exports = init(env, v8impl::JsValueFromV8LocalValue(exports));  
      });  
      
      if (_exports != nullptr &&  
          _exports != v8impl::JsValueFromV8LocalValue(exports)) { 
        napi_value _module = v8impl::JsValueFromV8LocalValue(module);  
        napi_set_named_property(env, _module, "exports", _exports);  
      }  
    }  
```

init就是我们定义的函数。入参是env和exports，可以对比我们定义的函数的入参。最后我们修改exports变量。即设置导出的内容。最后在JS里，我们就拿到了C++层定义的内容。  
## 19.2 加载原生JS模块
上一节我们了解了Node.js执行node demo.js的过程，其中我们在demo.js中使用require加载net模块。net是原生JS模块。这时候就会进入原生模块的处理逻辑。
原生模块是Node.js内部实现的JS模块。使用NativeModule来表示。

```
    class NativeModule {  
      // 原生JS模块的map  
      static map = new Map(moduleIds.map((id) => [id, new NativeModule(id)]));  
      
      constructor(id) {  
        this.filename = `${id}.js`;  
        this.id = id;  
        this.canBeRequiredByUsers = !id.startsWith('internal/');  
        this.exports = {};  
        this.loaded = false;  
        this.loading = false;  
        this.module = undefined;  
        this.exportKeys = undefined;  
      }  
    } 
```

 
当我们执行require(‘net’)时，就会进入_load函数。_load函数判断要加载的模块是原生JS模块后，会通过loadNativeModule函数加载原生JS模块。我们看这个函数的定义。

```
    function loadNativeModule(filename, request) {  
      const mod = NativeModule.map.get(filename);  
      if (mod) {  
        mod.compileForPublicLoader();  
        return mod;  
      }  
    }  
```

在Node.js启动过程中我们分析过，mod是一个NativeModule对象，接着看compileForPublicLoader。

```
    compileForPublicLoader() {  
        this.compileForInternalLoader();  
        return this.exports;  
    }  
      
    compileForInternalLoader() {  
        if (this.loaded || this.loading) {  
          return this.exports;  
        }  
        // id就是我们要加载的模块，比如net 
        const id = this.id;  
        this.loading = true;  
        try {  
          const fn = compileFunction(id);  
          fn(this.exports, 
                   // 加载原生JS模块的加载器
                   nativeModuleRequire, 
                   this, 
                   process, 
                   // 加载C++模块的加载器
                   internalBinding, 
                   primordials);  
          this.loaded = true;  
        } finally {  
          this.loading = false;  
        }  
        return this.exports;  
      }  
```

我们重点看compileFunction这里的逻辑。该函数是node_native_module_env.cc模块导出的函数。具体的代码就不贴了，通过层层查找，最后到node_native_module.cc 的NativeModuleLoader::CompileAsModule

```
    MaybeLocal<Function> NativeModuleLoader::CompileAsModule(  
        Local<Context> context,  
        const char* id,  
        NativeModuleLoader::Result* result) {  
      
      Isolate* isolate = context->GetIsolate();  
      // 函数的形参  
      std::vector<Local<String>> parameters = {  
          FIXED_ONE_BYTE_STRING(isolate, "exports"),  
          FIXED_ONE_BYTE_STRING(isolate, "require"),  
          FIXED_ONE_BYTE_STRING(isolate, "module"),  
          FIXED_ONE_BYTE_STRING(isolate, "process"),  
          FIXED_ONE_BYTE_STRING(isolate, "internalBinding"),  
          FIXED_ONE_BYTE_STRING(isolate, "primordials")};  
      // 编译出一个函数  
      return LookupAndCompile(context, id, &parameters, result);  
    }  
```

我们继续看LookupAndCompile。

```
    MaybeLocal<Function> NativeModuleLoader::LookupAndCompile(  
        Local<Context> context,  
        const char* id,  
        std::vector<Local<String>>* parameters,  
        NativeModuleLoader::Result* result) {  
      
      Isolate* isolate = context->GetIsolate();  
      EscapableHandleScope scope(isolate);  
      
      Local<String> source;  
      // 找到原生JS模块内容所在的内存地址  
      if (!LoadBuiltinModuleSource(isolate, id).ToLocal(&source)) {  
        return {};  
      }  
      // ‘net’ + ‘.js’
      std::string filename_s = id + std::string(".js");  
      Local<String> filename =  
          OneByteString(isolate, 
                filename_s.c_str(), 
                filename_s.size());  
      // 省略一些参数处理  
      // 脚本源码  
      ScriptCompiler::Source script_source(source, origin, cached_data);  
      // 编译出一个函数  
      MaybeLocal<Function> maybe_fun =  
          ScriptCompiler::CompileFunctionInContext(context,  
                                                      &script_source,  
                               parameters->size(),
                               parameters->data(),
                               0,  
                               nullptr,  
                               options);  
      Local<Function> fun = maybe_fun.ToLocalChecked();  
      return scope.Escape(fun);  
    }  
```

LookupAndCompile函数首先找到加载模块的源码，然后编译出一个函数。我们看一下LoadBuiltinModuleSource如何查找模块源码的。

```
    MaybeLocal<String> NativeModuleLoader::LoadBuiltinModuleSource(Isolate* isolate, const char* id) {  
      const auto source_it = source_.find(id);  
      return source_it->second.ToStringChecked(isolate);  
    }  
```

这里是id是net，通过该id从_source中找到对应的数据，那么_source是什么呢？因为Node.js为了提高效率，把原生JS模块的源码字符串直接转成ASCII码存到内存里。这样加载这些模块的时候，就不需要硬盘IO了。直接从内存读取就行。我们看一下_source的定义（在编译Node.js源码或者执行js2c.py生成的node_javascript.cc中）。

```
    source_.emplace("net", UnionBytes{net_raw, 46682});  
    source_.emplace("cyb", UnionBytes{cyb_raw, 63});  
    source_.emplace("os", UnionBytes{os_raw, 7548});  
```

cyb是我增加的测试模块。我们可以看一下该模块的内容。

```
    static const uint8_t cyb_raw[] = {  
     99,111,110,115,116, 32, 99,121, 98, 32, 61, 32,105,110,116,101,114,110, 97,108, 66,105,110,100,105,110,103, 40, 39, 99,  
    121, 98, 95,119,114, 97,112, 39, 41, 59, 32, 10,109,111,100,117,108,101, 46,101,120,112,111,114,116,115, 32, 61, 32, 99,  
    121, 98, 59  
    };  
```

我们转成字符串看一下是什么

```
    Buffer.from([99,111,110,115,116, 32, 99,121, 98, 32, 61, 32,105,110,116,101,114,110, 97,108, 66,105,110,100,105,110,103, 40, 39, 99,
    121, 98, 95,119,114, 97,112, 39, 41, 59, 32, 10,109,111,100,117,108,101, 46,101,120,112,111,114,116,115, 32, 61, 32, 99,    
    121, 98, 59].join(',').split(',')).toString('utf-8')  
```

输出

```
    const cyb = internalBinding('cyb_wrap');   
    module.exports = cyb;  
```

所以我们执行require('net')时，通过NativeModule的compileForInternalLoader，最终会在_source中找到net模块对应的源码字符串，然后编译成一个函数。

```
    const fn = compileFunction(id);  
    fn(this.exports, 
       // 加载原生JS模块的加载器
       nativeModuleRequire, 
       this, 
       process, 
       // 加载C++模块的加载器
       internalBinding, 
       primordials);   
```

由fn的入参可以知道，我们在net（或其它原生JS模块中）只能加载原生JS模块和内置的C++模块。当fn执行完毕后，原生模块加载器就会把mod.exports的值返回给调用方。
19.3 加载内置C++模块
在原生JS模块中我们一般会加载一些内置的C++模块，这是Node.js拓展JS功能的关键之处。比如我们require(‘net’)的时候，net模块会加载tcp_wrap模块。

```
    const {  
      TCP,  
      TCPConnectWrap,  
      constants: TCPConstants  
    } = internalBinding('tcp_wrap')  
```

C++模块加载器也是在internal/bootstrap/loaders.js中定义的，分为三种。  
1 internalBinding：不暴露给用户的访问的接口，只能在Node.js代码中访问，比如原生JS模块（flag为NM_F_INTERNAL）。

```
    let internalBinding;  
    {  
      const bindingObj = ObjectCreate(null);   
      internalBinding = function internalBinding(module) {  
        let mod = bindingObj[module];  
        if (typeof mod !== 'object') {  
          mod = bindingObj[module] = getInternalBinding(module);  
          moduleLoadList.push(`Internal Binding ${module}`);  
        }  
        return mod;  
      };  
    }  
```

internalBinding是在getInternalBinding函数基础上加了缓存功能。getInternalBinding是C++层定义的函数对JS暴露的接口名。它的作用是从C++模块链表中找到对应的模块。  
2 process.binding：暴露给用户调用C++模块的接口，但是只能访问部分C++模块（flag为NM_F_BUILTIN的C++模块）。

```
    process.binding = function binding(module) {  
      module = String(module);  
      if (internalBindingWhitelist.has(module)) {  
        return internalBinding(module);  
      }  
      throw new Error(`No such module: ${module}`);  
    };  
```

binding是在internalBinding的基础上加了白名单的逻辑，只对外暴露部分模块。

```
    const internalBindingWhitelist = new SafeSet([  
      'async_wrap',  
      'buffer',  
      'cares_wrap',  
      'config',  
      'constants',  
      'contextify',  
      'crypto',  
      'fs',  
      'fs_event_wrap',  
      'http_parser',  
      'icu',  
      'inspector',  
      'js_stream',  
      'natives',  
      'os',  
      'pipe_wrap',  
      'process_wrap',  
      'signal_wrap',  
      'spawn_sync',  
      'stream_wrap',  
      'tcp_wrap',  
      'tls_wrap',  
      'tty_wrap',  
      'udp_wrap',  
      'url',  
      'util',  
      'uv',  
      'v8',  
      'zlib'  
    ]);  
```

3 process._linkedBinding: 暴露给用户访问C++模块的接口，用于访问用户自己添加的但是没有加到内置模块的C++模块（flag为NM_F_LINKED）。

```
    const bindingObj = ObjectCreate(null);  
    process._linkedBinding = function _linkedBinding(module) {  
      module = String(module);  
      let mod = bindingObj[module];  
      if (typeof mod !== 'object')  
        mod = bindingObj[module] = getLinkedBinding(module);  
      return mod;  
    };  
```

_linkedBinding是在getLinkedBinding函数基础上加了缓存功能，getLinkedBinding是C++层定义的函数对外暴露的名字。getLinkedBinding从另一个C++模块链表中查找对应的模块。
上一节已经分析过，internalBinding是加载原生JS模块时传入的实参。internalBinding是对getInternalBinding的封装。getInternalBinding对应的是binding::GetInternalBinding（node_binding.cc）。

```
    // 根据模块名查找对应的模块  
    void GetInternalBinding(const FunctionCallbackInfo<Value>& args) {  
      Environment* env = Environment::GetCurrent(args);  
      // 模块名  
      Local<String> module = args[0].As<String>();  
      node::Utf8Value module_v(env->isolate(), module);  
      Local<Object> exports;  
      // 从C++内部模块找  
      node_module* mod = FindModule(modlist_internal, 
                                         *module_v, 
                                         NM_F_INTERNAL);  
      // 找到则初始化  
      if (mod != nullptr) {  
        exports = InitModule(env, mod, module);  
      } else {  
         // 省略  
      }  
      
      args.GetReturnValue().Set(exports);  
    }  
```

modlist_internal是一条链表，在Node.js启动过程的时候，由各个C++模块连成的链表。通过模块名找到对应的C++模块后，执行InitModule初始化模块。

```
    // 初始化一个模块，即执行它里面的注册函数  
    static Local<Object> InitModule(Environment* env,  
                     node_module* mod,  
                     Local<String> module) {  
      Local<Object> exports = Object::New(env->isolate());  
      Local<Value> unused = Undefined(env->isolate());  
      mod->nm_context_register_func(exports, unused, env->context(), mod->nm_priv);  
      return exports;  
    }  
```

执行C++模块的nm_context_register_func指向的函数。这个函数就是在C++模块最后一行定义的Initialize函数。Initialize会设置导出的对象。我们从JS可以访问Initialize导出的对象。V8中，JS调用C++函数的规则是函数入参const FunctionCallbackInfo<Value>& args（拿到JS传过来的内容）和设置返回值args.GetReturnValue().Set(给JS返回的内容), GetInternalBinding函数的逻辑就是执行对应模块的钩子函数，并传一个exports变量进去，然后钩子函数会修改exports的值，该exports的值就是JS层能拿到的值。
