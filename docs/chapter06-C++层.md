本章介绍Node.js中C++层的一些核心模块的原理和实现，这些模块是Node.js中很多模块都会使用的。理解这些模块的原理，才能更好地理解在Node.js中，JS是如何通过C++层调用Libuv，又是如何从Libuv返回的。

## 6.1 BaseObject
BaseObject是C++层大多数类的基类。
```c
    class BaseObject : public MemoryRetainer {  
     public:  
     // …
     private:  
      v8::Local<v8::Object> WrappedObject() const override;
      // 指向封装的对象  
      v8::Global<v8::Object> persistent_handle_;  
      Environment* env_;  
    };  
```
BaseObject的实现很复杂，这里只介绍常用的一些实现。
### 6.1.1 构造函数

```c
    // 把对象存储到persistent_handle_中，必要的时候通过object()取出来  
    BaseObject::BaseObject(Environment* env, 
                             v8::Local<v8::Object> object) 
    : persistent_handle_(env->isolate(), object), 
      env_(env) {  
      // 把this存到object中  
      object->SetAlignedPointerInInternalField(0, static_cast<void*>(this));    
    }  
```

构造函数用于保存对象间的关系（JS使用的对象和与其关系的C++层对象，下图中的对象即我们平时在JS层使用C++模块创建的对象，比如new TCP()）。后面我们可以看到用处，关系如图6-1所示。  
![](https://img-blog.csdnimg.cn/c732bcd047c349adbb9f5d4a501a1345.png)  
图6-1

### 6.1.2 获取封装的对象
```c
    v8::Local<v8::Object> BaseObject::object() const {  
      return PersistentToLocal::Default(env()->isolate(), 
                                            persistent_handle_);  
    }  
```
### 6.1.3 从对象中获取保存的BaseObject对象
```c
    // 通过obj取出里面保存的BaseObject对象  
    BaseObject* BaseObject::FromJSObject(v8::Local<v8::Object> obj) {
      return static_cast<BaseObject*>(obj->GetAlignedPointerFromInternalField(0));  
    }  
      
    template <typename T>  
    T* BaseObject::FromJSObject(v8::Local<v8::Object> object) {  
      return static_cast<T*>(FromJSObject(object));  
    }  
```

### 6.1.4 解包

```c
    // 从obj中取出对应的BaseObject对象  
    template <typename T>  
    inline T* Unwrap(v8::Local<v8::Object> obj) {  
      return BaseObject::FromJSObject<T>(obj);  
    }  
      
    // 从obj中获取对应的BaseObject对象，如果为空则返回第三个参数的值（默认值）  
    #define ASSIGN_OR_RETURN_UNWRAP(ptr, obj, ...) \  
      do {       \  
        *ptr = static_cast<typename std::remove_reference<decltype(*ptr)>::type>( \  
            BaseObject::FromJSObject(obj));   \  
        if (*ptr == nullptr)  \  
          return __VA_ARGS__; \  
      } while (0)  
```

## 6.2 AsyncWrap
AsyncWrap实现async_hook的模块，不过这里我们只关注它回调JS的功能。

```c
    inline v8::MaybeLocal<v8::Value> AsyncWrap::MakeCallback(  
        const v8::Local<v8::Name> symbol,  
        int argc,  
        v8::Local<v8::Value>* argv) {  
      v8::Local<v8::Value> cb_v;  
      // 根据字符串表示的属性值，从对象中取出该属性对应的值。是个函数  
      if (!object()->Get(env()->context(), symbol).ToLocal(&cb_v))  
        return v8::MaybeLocal<v8::Value>();  
      // 是个函数  
      if (!cb_v->IsFunction()) {  
        return v8::MaybeLocal<v8::Value>();  
      }  
      // 回调,见async_wrap.cc  
      return MakeCallback(cb_v.As<v8::Function>(), argc, argv);  
    }  
```

以上只是入口函数，我们看看真正的实现。

```
    MaybeLocal<Value> AsyncWrap::MakeCallback(const Local<Function> cb,  
                                              int argc,  
                                              Local<Value>* argv) {  
      
      MaybeLocal<Value> ret = InternalMakeCallback(env(), object(), cb, argc, argv, context);  
      return ret;  
    }  
```

接着看一下InternalMakeCallback

```
    MaybeLocal<Value> InternalMakeCallback(Environment* env,  
                                           Local<Object> recv,  
                                           const Local<Function> callback,  
                                           int argc,  
                                           Local<Value> argv[],  
                                           async_context asyncContext) {  
      // …省略其他代码
      // 执行回调  
      callback->Call(env->context(), recv, argc, argv);}  
```

## 6.3 HandleWrap
HandleWrap是对Libuv uv_handle_t的封装,也是很多C++类的基类。

```cpp
    class HandleWrap : public AsyncWrap {  
     public:  
      // 操作和判断handle状态函数，见Libuv  
      static void Close(const v8::FunctionCallbackInfo<v8::Value>& args);  
      static void Ref(const v8::FunctionCallbackInfo<v8::Value>& args);  
      static void Unref(const v8::FunctionCallbackInfo<v8::Value>& args);  
      static void HasRef(const v8::FunctionCallbackInfo<v8::Value>& args);  
      static inline bool IsAlive(const HandleWrap* wrap) {  
        return wrap != nullptr && wrap->state_ != kClosed;  
      }  
      
      static inline bool HasRef(const HandleWrap* wrap) {  
        return IsAlive(wrap) && uv_has_ref(wrap->GetHandle());  
      }  
      // 获取封装的handle  
      inline uv_handle_t* GetHandle() const { return handle_; }  
      // 关闭handle，关闭成功后执行回调  
      virtual void Close(  
          v8::Local<v8::Value> close_callback = 
           v8::Local<v8::Value>());  
      
      static v8::Local<v8::FunctionTemplate> GetConstructorTemplate(
      Environment* env);  
      
     protected:  
      HandleWrap(Environment* env,  
                 v8::Local<v8::Object> object,  
                 uv_handle_t* handle,  
                 AsyncWrap::ProviderType provider);  
      virtual void OnClose() {}  
      // handle状态  
      inline bool IsHandleClosing() const {  
        return state_ == kClosing || state_ == kClosed;  
      }  
      
     private:  
      friend class Environment;  
      friend void GetActiveHandles(const v8::FunctionCallbackInfo<v8::Value>&);  
      static void OnClose(uv_handle_t* handle);  
      
      // handle队列  
      ListNode<HandleWrap> handle_wrap_queue_;  
      // handle的状态  
      enum { kInitialized, kClosing, kClosed } state_;  
      // 所有handle的基类  
      uv_handle_t* const handle_;  
    };  
```

### 6.3.1 新建handle和初始化

```cpp
    Local<FunctionTemplate> HandleWrap::GetConstructorTemplate(Environment* env) {  
      Local<FunctionTemplate> tmpl = env->handle_wrap_ctor_template();  
      if (tmpl.IsEmpty()) {  
        tmpl = env->NewFunctionTemplate(nullptr);  
        tmpl->SetClassName(FIXED_ONE_BYTE_STRING(env->isolate(), 
                             "HandleWrap"));  
        tmpl->Inherit(AsyncWrap::GetConstructorTemplate(env));  
        env->SetProtoMethod(tmpl, "close", HandleWrap::Close);  
        env->SetProtoMethodNoSideEffect(tmpl, 
                                            "hasRef", 
                                           HandleWrap::HasRef);  
        env->SetProtoMethod(tmpl, "ref", HandleWrap::Ref);  
        env->SetProtoMethod(tmpl, "unref", HandleWrap::Unref);  
        env->set_handle_wrap_ctor_template(tmpl);  
      }  
      return tmpl;  
    }  
    /* 
      object为C++层为JS层提供的对象 
      handle为子类具体的handle类型，不同模块不一样 
    */  
    HandleWrap::HandleWrap(Environment* env,  
                           Local<Object> object,  
                           uv_handle_t* handle,  
                           AsyncWrap::ProviderType provider)  
        : AsyncWrap(env, object, provider),  
          state_(kInitialized),  
          handle_(handle) {  
      // 保存Libuv handle和C++对象的关系  
      handle_->data = this;  
      HandleScope scope(env->isolate());  
      CHECK(env->has_run_bootstrapping_code());  
      // 插入handle队列  
      env->handle_wrap_queue()->PushBack(this);  
    }  
```

HandleWrap继承BaseObject类，初始化后关系图如图6-2所示。  
 ![](https://img-blog.csdnimg.cn/96428743f6c44b1980d2d59c3ac2c513.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-2
### 6.3.2 判断和操作handle状态

```cpp
    // 修改handle为活跃状态  
    void HandleWrap::Ref(const FunctionCallbackInfo<Value>& args) {  
      HandleWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
      
      if (IsAlive(wrap))  
        uv_ref(wrap->GetHandle());  
    }  
      
    // 修改hande为不活跃状态  
    void HandleWrap::Unref(const FunctionCallbackInfo<Value>& args) {  
      HandleWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
      
      if (IsAlive(wrap))  
        uv_unref(wrap->GetHandle());  
    }  
      
    // 判断handle是否处于活跃状态  
    void HandleWrap::HasRef(const FunctionCallbackInfo<Value>& args) {  
      HandleWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
      args.GetReturnValue().Set(HasRef(wrap));  
    }  
```

### 6.3.3 关闭handle

```cpp
    // 关闭handle（JS层调用），成功后执行回调  
    void HandleWrap::Close(const FunctionCallbackInfo<Value>& args) {  
      HandleWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
      // 传入回调  
      wrap->Close(args[0]);  
    }  
    // 真正关闭handle的函数  
    void HandleWrap::Close(Local<Value> close_callback) {  
      // 正在关闭或已经关闭  
      if (state_ != kInitialized)  
        return;  
      // 调用Libuv函数  
      uv_close(handle_, OnClose);  
      // 关闭中  
      state_ = kClosing;  
      // 传了回调则保存起来  
      if (!close_callback.IsEmpty() && 
           close_callback->IsFunction() &&  
          !persistent().IsEmpty()) {  
        object()->Set(env()->context(),  
                      env()->handle_onclose_symbol(),  
                      close_callback).Check();  
      }  
    }  
      
    // 关闭handle成功后回调  
    void HandleWrap::OnClose(uv_handle_t* handle) {  
      BaseObjectPtr<HandleWrap> wrap { 
         static_cast<HandleWrap*>(handle->data) 
      };  
      wrap->Detach();  
      
      Environment* env = wrap->env();  
      HandleScope scope(env->isolate());  
      Context::Scope context_scope(env->context());  
      wrap->state_ = kClosed;  
      
      wrap->OnClose();  
      wrap->handle_wrap_queue_.Remove();  
      // 有onclose回调则执行  
      if (!wrap->persistent().IsEmpty() &&  
          wrap->object()->Has(env->context(), 
                                 env->handle_onclose_symbol())  
          .FromMaybe(false)) {  
        wrap->MakeCallback(env->handle_onclose_symbol(), 
                             0, 
                             nullptr);  
      }  
    }  
```

## 6.4 ReqWrap
ReqWrap表示通过Libuv对handle的一次请求。
### 6.4.1 ReqWrapBase 

```cpp
    class ReqWrapBase {  
     public:  
      explicit inline ReqWrapBase(Environment* env);  
      virtual ~ReqWrapBase() = default;  
      virtual void Cancel() = 0;  
      virtual AsyncWrap* GetAsyncWrap() = 0;  
      
     private:  
      // 一个带前后指针的节点  
      ListNode<ReqWrapBase> req_wrap_queue_;  
    };  
```

ReqWrapBase主要是定义接口的协议。我们看一下ReqWrapBase的实现

```cpp
    ReqWrapBase::ReqWrapBase(Environment* env) {  
      env->req_wrap_queue()->PushBack(this);  
    }  
```

ReqWrapBase初始化的时候，会把自己加到env对象的req队列中。
### 6.4.2 ReqWrap

```cpp
    template <typename T>  
    class ReqWrap : public AsyncWrap, public ReqWrapBase {  
     public:  
      inline ReqWrap(Environment* env,  
                     v8::Local<v8::Object> object,  
                     AsyncWrap::ProviderType provider);  
      inline ~ReqWrap() override;  
      inline void Dispatched();  
      inline void Reset();  
      T* req() { return &req_; }  
      inline void Cancel() final;  
      inline AsyncWrap* GetAsyncWrap() override;  
      static ReqWrap* from_req(T* req);  
      template <typename LibuvFunction, typename... Args>  
      // 调用Libuv
      inline int Dispatch(LibuvFunction fn, Args... args);  
       
     public:  
      typedef void (*callback_t)();  
      callback_t original_callback_ = nullptr;  
      
     protected:  
      T req_;  
    };  
      
    }   
```

我们看一下实现

```cpp
    template <typename T>  
    ReqWrap<T>::ReqWrap(Environment* env,  
                        v8::Local<v8::Object> object,  
                        AsyncWrap::ProviderType provider)  
        : AsyncWrap(env, object, provider),  
          ReqWrapBase(env) {  
      // 初始化状态  
      Reset();  
    }  
      
    // 保存libuv数据结构和ReqWrap实例的关系  
    template <typename T>  
    void ReqWrap<T>::Dispatched() {  
      req_.data = this;  
    }  
      
    // 重置字段  
    template <typename T>  
    void ReqWrap<T>::Reset() {  
      original_callback_ = nullptr;  
      req_.data = nullptr;  
    }  
      
    // 通过req成员找所属对象的地址  
    template <typename T>  
    ReqWrap<T>* ReqWrap<T>::from_req(T* req) {  
      return ContainerOf(&ReqWrap<T>::req_, req);  
    }  
      
    // 取消线程池中的请求  
    template <typename T>  
    void ReqWrap<T>::Cancel() {  
      if (req_.data == this)  
        uv_cancel(reinterpret_cast<uv_req_t*>(&req_));  
    }  
    
    template <typename T>
    AsyncWrap* ReqWrap<T>::GetAsyncWrap() {
      return this;
    }
    // 调用Libuv函数  
    template <typename T>  
    template <typename LibuvFunction, typename... Args>  
    int ReqWrap<T>::Dispatch(LibuvFunction fn, Args... args) {  
      Dispatched();  
      int err = CallLibuvFunction<T, LibuvFunction>::Call(  
          // Libuv函数
          fn,  
          env()->event_loop(),  
          req(),  
          MakeLibuvRequestCallback<T, Args>::For(this, args)...);  
      if (err >= 0)  
        env()->IncreaseWaitingRequestCounter();  
      return err;  
    }  
```

我们看到ReqWrap抽象了请求Libuv的过程，具体设计的数据结构由子类实现。我们看一下某个子类的实现。

```cpp
    // 请求Libuv时，数据结构是uv_connect_t，表示一次连接请求  
    class ConnectWrap : public ReqWrap<uv_connect_t> {  
     public:  
      ConnectWrap(Environment* env,  
                  v8::Local<v8::Object> req_wrap_obj,  
                  AsyncWrap::ProviderType provider);  
    };  
```

## 6.5 JS如何使用C++
JS调用C++模块是V8提供的能力，Node.js是使用了这个能力。这样我们只需要面对JS，剩下的事情交给Node.js就行。本文首先讲一下利用V8如何实现JS调用C++，然后再讲一下Node.js是怎么做的。

1 JS调用C++
首先介绍一下V8中两个非常核心的类FunctionTemplate和ObjectTemplate。顾名思义，这两个类是定义模板的，好比建房子时的设计图一样，通过设计图，我们就可以造出对应的房子。V8也是，定义某种模板，就可以通过这个模板创建出对应的实例。下面介绍一下这些概念（为了方便，下面都是伪代码)。

1.1 定义一个函数模板

```cpp
    Local<FunctionTemplate> functionTemplate = v8::FunctionTemplate::New(isolate(), New);  
    // 定义函数的名字    
    functionTemplate->SetClassName(‘TCP’)  
```

首先定义一个FunctionTemplate对象。我们看到FunctionTemplate的第二个入参是一个函数，当我们执行由FunctionTemplate创建的函数时，v8就会执行New函数。当然我们也可以不传。
1.2 定义函数模板的prototype内容
prototype就是JS里的function.prototype。如果你理解JS里的知识，就很容易理解C++的代码。

```cpp
    v8::Local<v8::FunctionTemplate> t = v8::FunctionTemplate::New(isolate(), callback);    
    t->SetClassName('test');     
    // 在prototype上定义一个属性        
    t->PrototypeTemplate()->Set('hello', 'world');  
```

1.3 定义函数模板对应的实例模板的内容
实例模板就是一个ObjectTemplate对象。它定义了，当以new的方式执行由函数模板创建出来的函数时，返回值所具有的属性。

```js
    function A() {    
        this.a = 1;    
        this.b = 2;    
    }    
    new A();    
```

实例模板类似上面代码中A函数里面的代码。我们看看在V8里怎么定义。

```cpp
    t->InstanceTemplate()->Set(key, val);  
    t->InstanceTemplate()->SetInternalFieldCount(1);  
```

InstanceTemplate返回的是一个ObjectTemplate对象。SetInternalFieldCount这个函数比较特殊，也是比较重要的一个地方，我们知道对象就是一块内存，对象有它自己的内存布局，我们知道在C++里，我们定义一个类，也就定义了对象的布局。比如我们有以下定义。

```cpp
    class demo    
    {    
     private:    
      int a;    
      int b;    
    };  
```

在内存中布局如图6-3所示。  
 ![](https://img-blog.csdnimg.cn/8c925548ae8e49f3922a4d988607a989.png)  
图6-3  
上面这种方式有个问题，就是类定义之后，内存布局就固定了。而V8是自己去控制对象的内存布局的。当我们在V8中定义一个类的时候，是没有任何属性的。我们看一下V8中HeapObject类的定义。

```cpp
    class HeapObject: public Object {    
      static const int kMapOffset = Object::kSize; // Object::kSize是0    
      static const int kSize = kMapOffset + kPointerSize;    
    };   
```

这时候的内存布局如下。  
 ![](https://img-blog.csdnimg.cn/2081c70b06b247bf8b6d3996f40f7d03.png)  
然后我们再看一下HeapObject子类HeapNumber的定义。

```cpp
    class HeapNumber: public HeapObject {    
      // kSize之前的空间存储map对象的指针    
      static const int kValueOffset = HeapObject::kSize;    
      // kValueOffset - kSize之间存储数字的值    
      static const int kSize = kValueOffset + kDoubleSize;    
    };  
```

  
内存布局如图6-4所示。  
![](https://img-blog.csdnimg.cn/cc0c9b621ac8485faed34d94c73d2462.png)  
图6-4

我们发现这些类只有几个类变量，类变量是不保存在对象内存空间的。这些类变量就是定义了对象每个域所占内存空间的信息，当我们定义一个HeapObject对象的时候，V8首先申请一块内存，然后把这块内存首地址强行转成对应对象的指针。然后通过类变量对属性的内存进行存取。我们看看在V8里如何申请一个HeapNumber对象

```cpp
    Object* Heap::AllocateHeapNumber(double value, PretenureFlag pretenure) {    
      // 在哪个空间分配内存，比如新生代，老生代    
      AllocationSpace space = (pretenure == TENURED) ? CODE_SPACE : NEW_SPACE;    
      // 在space上分配一个HeapNumber对象大小的内存    
      Object* result = AllocateRaw(HeapNumber::kSize, space);    
      /*  
          转成HeapObect，设置map属性，map属性是表示对象类型、大小等信息的  
      */    
      HeapObject::cast(result)->set_map(heap_number_map());    
      // 转成HeapNumber对象    
      HeapNumber::cast(result)->set_value(value);    
      return result;    
    }   
```

回到对象模板的问题。我们看一下对象模板的定义。

```cpp
    class TemplateInfo: public Struct {    
      static const int kTagOffset          = HeapObject::kSize;    
      static const int kPropertyListOffset = kTagOffset + kPointerSize;    
      static const int kHeaderSize         = kPropertyListOffset + kPointerSize;    
    };    
        
    class ObjectTemplateInfo: public TemplateInfo {    
      static const int kConstructorOffset = TemplateInfo::kHeaderSize;    
      static const int kInternalFieldCountOffset = kConstructorOffset + kPointerSize;    
      static const int kSize = kInternalFieldCountOffset + kHeaderSize;    
    };   
```

内存布局如图6-5所示。  
![](https://img-blog.csdnimg.cn/9cfde2c74ac24d529350ffda1bc6c2ac.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-5

回到对象模板的问题，我们看看Set(key, val)做了什么。

```cpp
    void Template::Set(v8::Handle<String> name, v8::Handle<Data> value,    
                       v8::PropertyAttribute attribute) {    
      // ...    
      i::Handle<i::Object> list(Utils::OpenHandle(this)->property_list());    
      NeanderArray array(list);    
      array.add(Utils::OpenHandle(*name));    
      array.add(Utils::OpenHandle(*value));    
      array.add(Utils::OpenHandle(*v8::Integer::New(attribute)));    
    }    
```

上面的代码大致就是给一个list后面追加一些内容。我们看看这个list是怎么来的，即property_list函数的实现。

```cpp
    // 读取对象中某个属性的值    
    #define READ_FIELD(p, offset) (*reinterpret_cast<Object**>(FIELD_ADDR(p, offset))    
        
    static Object* cast(Object* value) {     
        return value;    
    }    
        
    Object* TemplateInfo::property_list() {     
        return Object::cast(READ_FIELD(this, kPropertyListOffset));     
    }    
```

从上面代码中我们知道，内部布局如图6-6所示。  
 ![](https://img-blog.csdnimg.cn/10abb0324ce54c9eba3743e8f4e61cc2.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-6

根据内存布局，我们知道property_list的值是list指向的值。所以Set(key, val)操作的内存并不是对象本身的内存，对象利用一个指针指向一块内存保存Set(key, val)的值。SetInternalFieldCount函数就不一样了，它会影响（扩张）对象本身的内存。我们来看一下它的实现。

```cpp
    void ObjectTemplate::SetInternalFieldCount(int value) {    
      // 修改的是kInternalFieldCountOffset对应的内存的值    
      Utils::OpenHandle(this)->set_internal_field_count(i::Smi::FromInt(value));    
    }    
```

我们看到SetInternalFieldCount函数的实现很简单，就是在对象本身的内存中保存一个数字。接下来我们看看这个字段的使用。后面会详细介绍它的用处。

```cpp
    Handle<JSFunction> Factory::CreateApiFunction(    
        Handle<FunctionTemplateInfo> obj,    
        bool is_global) {    
         
      int internal_field_count = 0;    
      if (!obj->instance_template()->IsUndefined()) {    
        // 获取函数模板的实例模板    
        Handle<ObjectTemplateInfo> instance_template = Handle<ObjectTemplateInfo>(ObjectTemplateInfo::cast(obj->instance_template()));    
        // 获取实例模板的internal_field_count字段的值（通过SetInternalFieldCount设置的那个值）    
        internal_field_count = Smi::cast(instance_template->internal_field_count())->value();    
      }    
      // 计算新建对象需要的空间，如果    
      int instance_size = kPointerSize * internal_field_count;    
      if (is_global) {    
        instance_size += JSGlobalObject::kSize;    
      } else {    
        instance_size += JSObject::kHeaderSize;    
      }    
        
      InstanceType type = is_global ? JS_GLOBAL_OBJECT_TYPE : JS_OBJECT_TYPE;    
      // 新建一个函数对象    
      Handle<JSFunction> result =    
          Factory::NewFunction(Factory::empty_symbol(), type, instance_size,    
                               code, true);    
    }    
```

我们看到internal_field_count的值的意义是，会扩张对象的内存，比如一个对象本身只有n字节，如果定义internal_field_count的值是1，对象的内存就会变成n+internal_field_count * 一个指针的字节数。内存布局如图6-7所示。  
 ![](https://img-blog.csdnimg.cn/e3ac46175f034690a3cda19d2e61969d.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)   
图6-7  
1.4 通过函数模板创建一个函数
    Local<FunctionTemplate> functionTemplate = v8::FunctionTemplate::New(isolate(), New);  
    global->Set('demo', functionTemplate ->GetFunction());  
这样我们就可以在JS里直接调用demo这个变量，然后对应的函数就会被执行。这就是JS调用C++的原理。

2 Node.js是如何处理JS调用C++问题的
我们以TCP模块为例。

```js
    const { TCP } = process.binding('tcp_wrap');    
    new TCP(...);   
```

 
Node.js通过定义一个全局变量process统一处理C++模块的调用，具体参考模块加载章节的内容。在Node.js中，C++模块（类）一般只会定义对应的Libuv结构体和一系列类函数，然后创建一个函数模版，并传入一个回调，接着把这些类函数挂载到函数模板中,最后通过函数模板返回一个函数F给JS层使用，翻译成JS大致如下

```js
    // Libuv  
    function uv_tcp_connect(uv_tcp_t, addr,cb) { cb(); }    
          
    // C++  
    class TCPWrap {    
      
      uv_tcp_t = {};    
      
      static Connect(cb) {    
      
        const tcpWrap = this[0];    
      
        uv_tcp_connect(  
      
          tcpWrap.uv_tcp_t,  
      
          {ip: '127.0.0.1', port: 80},  
      
         () => { cb(); }  
      
        );    
      
     }    
      
    }    
      
    function FunctionTemplate(cb) {    
       function Tmp() {  
        Object.assign(this, map);  
        cb(this);  
       }  
       const map = {};  
       return {  
        PrototypeTemplate: function() {  
            return {  
                set: function(k, v) {  
                    Tmp.prototype[k] = v;  
                }  
            }  
        },  
        InstanceTemplate: function() {  
            return {  
                set: function(k, v) {  
                    map[k] = v;  
                }  
            }  
        },  
        GetFunction() {  
            return Tmp;  
        }  
       }   
      
    }    
      
    const TCPFunctionTemplate = FunctionTemplate((target) => { target[0] = new TCPWrap(); })    
      
    TCPFunctionTemplate.PrototypeTemplate().set('connect', TCPWrap.Connect);  
    TCPFunctionTemplate.InstanceTemplate().set('name', 'hi');  
    const TCP = TCPFunctionTemplate.GetFunction();  
      
    // js  
    const tcp = new TCP();  
    tcp.connect(() => { console.log('连接成功'); });    
    tcp.name;  
```

我们从C++的层面分析执行new TCP()的逻辑，然后再分析connect的逻辑，这两个逻辑涉及的机制是其它C++模块也会使用到的。因为TCP对应的函数是Initialize函数里的t->GetFunction()对应的值。所以new TCP()的时候，V8首先会创建一个C++对象，然后执行New函数。

```cpp
    void TCPWrap::New(const FunctionCallbackInfo<Value>& args) {  
      Environment* env = Environment::GetCurrent(args);  
      
      int type_value = args[0].As<Int32>()->Value();  
      TCPWrap::SocketType type = static_cast<TCPWrap::SocketType>(type_value);  
      
      ProviderType provider;  
      switch (type) {  
        case SOCKET:  
          provider = PROVIDER_TCPWRAP;  
          break;  
        case SERVER:  
          provider = PROVIDER_TCPSERVERWRAP;  
          break;  
        default:  
          UNREACHABLE();  
      }  
      /*  
        args.This()为v8提供的一个C++对象（由Initialize函数定义的模块创建的）  
        调用该C++对象的SetAlignedPointerInInternalField(0,this)关联this（new TCPWrap()）,  
        见HandleWrap  
      */   
      
      new TCPWrap(env, args.This(), provider);  
    }  
```

我们沿着TCPWrap的继承关系，一直到HandleWrap

```cpp
    HandleWrap::HandleWrap(Environment* env,  
                           Local<Object> object,  
                           uv_handle_t* handle,  
                           AsyncWrap::ProviderType provider)  
        : AsyncWrap(env, object, provider),  
          state_(kInitialized),  
          handle_(handle) {  
      // 保存Libuv handle和C++对象的关系  
      handle_->data = this;  
      HandleScope scope(env->isolate());    
      // 插入handle队列  
      env->handle_wrap_queue()->PushBack(this);  
    }  
```

HandleWrap首先保存了Libuv结构体和C++对象的关系。然后我们继续沿着AsyncWrap分析，AsyncWrap继承BaseObject，我们直接看BaseObject。

```cpp
    // 把对象存储到persistent_handle_中，必要的时候通过object()取出来  
    BaseObject::BaseObject(Environment* env, v8::Local<v8::Object> object)  
        : persistent_handle_(env->isolate(), object), env_(env) {  
      // 把this存到object中  
      object->SetAlignedPointerInInternalField(0, static_cast<void*>(this));  
      env->AddCleanupHook(DeleteMe, static_cast<void*>(this));  
      env->modify_base_object_count(1);  
    }  
```

我们看SetAlignedPointerInInternalField。

```cpp
    void v8::Object::SetAlignedPointerInInternalField(int index, void* value) {    
      i::Handle<i::JSReceiver> obj = Utils::OpenHandle(this);    
      i::Handle<i::JSObject>::cast(obj)->SetEmbedderField(    
          index, EncodeAlignedAsSmi(value, location));    
    }    
        
    void JSObject::SetEmbedderField(int index, Smi* value) {    
      // GetHeaderSize为对象固定布局的大小，kPointerSize * index为拓展的内存大小，根据索引找到对应位置    
      int offset = GetHeaderSize() + (kPointerSize * index);    
      // 写对应位置的内存，即保存对应的内容到内存    
      WRITE_FIELD(this, offset, value);    
    }   
```

SetAlignedPointerInInternalField函数展开后，做的事情就是把一个值保存到V8 C++对象的内存里。那保存的这个值是啥呢？BaseObject的入参object是由函数模板创建的对象，this是一个TCPWrap对象。所以SetAlignedPointerInInternalField函数做的事情就是把一个TCPWrap对象保存到一个函数模板创建的对象里，如图6-8所示。
 ![](https://img-blog.csdnimg.cn/cead0241ca5a4f02b38727ae85145fcc.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-8

这有啥用呢？我们继续分析。这时候new TCP就执行完毕了。我们看看这时候执行tcp.connect()函数的逻辑。

```cpp
    template <typename T>  
    void TCPWrap::Connect(const FunctionCallbackInfo<Value>& args,  
        std::function<int(const char* ip_address, T* addr)> uv_ip_addr) {  
      Environment* env = Environment::GetCurrent(args);  
      
      TCPWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap,  
                              args.Holder(),  
                              args.GetReturnValue().Set(UV_EBADF));  
      // 省略部分不相关代码
      
      args.GetReturnValue().Set(err);  
    }  
```

我们只需看一下ASSIGN_OR_RETURN_UNWRAP宏的逻辑。其中args.Holder()表示Connect函数的属主，根据前面的分析我们知道属主是Initialize函数定义的函数模板创建出来的对象。这个对象保存了一个TCPWrap对象。ASSIGN_OR_RETURN_UNWRAP主要的逻辑是把在C++对象中保存的那个TCPWrap对象取出来。然后就可以使用TCPWrap对象的handle去请求Libuv了。
## 6.7 C++层调用Libuv
刚才我们分析了JS调用C++层时是如何串起来的，接着我们看一下C++调用Libuv和Libuv回调C++层又是如何串起来的。我们通过TCP模块的connect函数继续分析该过程。

```cpp
    template <typename T>  
    void TCPWrap::Connect(const FunctionCallbackInfo<Value>& args,  
        std::function<int(const char* ip_address, T* addr)> uv_ip_addr) {  
      Environment* env = Environment::GetCurrent(args);  
      
      TCPWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap,  
                              args.Holder(),  
                              args.GetReturnValue().Set(UV_EBADF));  
      
      // 第一个参数是TCPConnectWrap对象，见net模块  
      Local<Object> req_wrap_obj = args[0].As<Object>();  
      // 第二个是ip地址  
      node::Utf8Value ip_address(env->isolate(), args[1]);  
      
      T addr;  
      // 把端口，IP设置到addr上，端口信息在uv_ip_addr上下文里了  
      int err = uv_ip_addr(*ip_address, &addr);  
      
      if (err == 0) {  
        ConnectWrap* req_wrap =  
            new ConnectWrap(env, 
                              req_wrap_obj, 
                              AsyncWrap::PROVIDER_TCPCONNECTWRAP);  
        err = req_wrap->Dispatch(uv_tcp_connect,  
                                 &wrap->handle_,  
                                 reinterpret_cast<const sockaddr*>(&addr),  
                                 AfterConnect);  
        if (err)  
          delete req_wrap;  
      }  
      
      args.GetReturnValue().Set(err);  
    }  
```

我们首先看一下ConnectWrap。我们知道ConnectWrap是ReqWrap的子类。req_wrap_obj是JS层使用的对象。New ConnectWrap后结构如图6-9所示。  
![](https://img-blog.csdnimg.cn/f3635e1bc9314a99ba9bf39fc5c8f235.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
 图6-9  

接着我们看一下Dispatch。

```cpp
    // 调用Libuv函数  
    template <typename T>  
    template <typename LibuvFunction, typename... Args>  
    int ReqWrap<T>::Dispatch(LibuvFunction fn, Args... args) {  
      // 保存Libuv结构体和C++层对象ConnectWrap的关系    
      req_.data = this;    
      int err = CallLibuvFunction<T, LibuvFunction>::Call(  
          fn,  
          env()->event_loop(),  
          req(),  
          MakeLibuvRequestCallback<T, Args>::For(this, args)...);  
      if (err >= 0)  
        env()->IncreaseWaitingRequestCounter();  
      return err;  
    }  
```

调用Libuv之前的结构如图6-10所示。  
![](https://img-blog.csdnimg.cn/cc0b84c5f6314236b6994344d68ae762.png)  
图6-10

接下来我们分析调用Libuv的具体过程。我们看到Dispatch函数是一个函数模板。
首先看一下CallLibuvFunction的实现。

```cpp
    template <typename ReqT, typename T>  
    struct CallLibuvFunction;  
      
    // Detect `int uv_foo(uv_loop_t* loop, uv_req_t* request, ...);`.  
    template <typename ReqT, typename... Args>  
    struct CallLibuvFunction<ReqT, int(*)(uv_loop_t*, ReqT*, Args...)> {  
      using T = int(*)(uv_loop_t*, ReqT*, Args...);  
      template <typename... PassedArgs>  
      static int Call(T fn, uv_loop_t* loop, ReqT* req, PassedArgs... args) {  
        return fn(loop, req, args...);  
      }  
    };  
      
    // Detect `int uv_foo(uv_req_t* request, ...);`.  
    template <typename ReqT, typename... Args>  
    struct CallLibuvFunction<ReqT, int(*)(ReqT*, Args...)> {  
      using T = int(*)(ReqT*, Args...);  
      template <typename... PassedArgs>  
      static int Call(T fn, uv_loop_t* loop, ReqT* req, PassedArgs... args) {  
        return fn(req, args...);  
      }  
    };  
      
    // Detect `void uv_foo(uv_req_t* request, ...);`.  
    template <typename ReqT, typename... Args>  
    struct CallLibuvFunction<ReqT, void(*)(ReqT*, Args...)> {  
      using T = void(*)(ReqT*, Args...);  
      template <typename... PassedArgs>  
      static int Call(T fn, uv_loop_t* loop, ReqT* req, PassedArgs... args) {  
        fn(req, args...);  
        return 0;  
      }  
    };  
```

CallLibuvFunction的实现看起来非常复杂，那是因为用了大量的模板参数，CallLibuvFunction本质上是一个struct，在C++里和类作用类似，里面只有一个类函数Call，Node.js为了适配Libuv层各种类型函数的调用，所以实现了三种类型的CallLibuvFunction,并且使用了大量的模板参数。我们只需要分析一种就可以了。我们根据TCP的connect函数开始分析。我们首先具体下Dispatch函数的模板参数。

```
    template <typename T>  
    template <typename LibuvFunction, typename... Args>  
```

T对应ReqWrap的类型，LibuvFunction对应Libuv的函数类型，这里是int uv_tcp_connect(uv_connect_t* req, ...)，所以是对应LibuvFunction的第二种情况，Args是执行Dispatch时除了第一个实参外的剩余参数。下面我们具体化Dispatch。

```cpp
    int ReqWrap<uv_connect_t>::Dispatch(int(*)(uv_connect_t*, Args...), Args... args) {  
      req_.data = this;  
      int err = CallLibuvFunction<uv_connect_t, int(*)(uv_connect_t*, Args...)>::Call(  
          fn,  
          env()->event_loop(),  
          req(),  
          MakeLibuvRequestCallback<T, Args>::For(this, args)...);  
      
      return err;  
    }  
```

接着我们看一下MakeLibuvRequestCallback的实现。

```cpp
    // 透传参数给Libuv  
    template <typename ReqT, typename T>  
    struct MakeLibuvRequestCallback {  
      static T For(ReqWrap<ReqT>* req_wrap, T v) {  
        static_assert(!is_callable<T>::value,  
                      "MakeLibuvRequestCallback missed a callback");  
        return v;  
      }  
    };  
      
    template <typename ReqT, typename... Args>   
    struct MakeLibuvRequestCallback<ReqT, void(*)(ReqT*, Args...)> {  
      using F = void(*)(ReqT* req, Args... args);  
      // Libuv回调  
      static void Wrapper(ReqT* req, Args... args) {  
        // 通过Libuv结构体拿到对应的C++对象  
        ReqWrap<ReqT>* req_wrap = ReqWrap<ReqT>::from_req(req);  
        req_wrap->env()->DecreaseWaitingRequestCounter();  
        // 拿到原始的回调执行  
        F original_callback = reinterpret_cast<F>(req_wrap->original_callback_);  
        original_callback(req, args...);  
      }  
      
      static F For(ReqWrap<ReqT>* req_wrap, F v) {  
        // 保存原来的函数  
        CHECK_NULL(req_wrap->original_callback_);  
        req_wrap->original_callback_ =  
            reinterpret_cast<typename ReqWrap<ReqT>::callback_t>(v);  
        // 返回包裹函数  
        return Wrapper;  
      }  
    };  
```

MakeLibuvRequestCallback的实现有两种情况，模版参数的第一个一般是ReqWrap子类，第二个一般是handle，初始化ReqWrap类的时候，env中会记录ReqWrap实例的个数，从而知道有多少个请求正在被Libuv处理，模板参数的第二个如果是函数则说明没有使用ReqWrap请求Libuv，则使用第二种实现，劫持回调从而记录正在被Libuv处理的请求数（如GetAddrInfo的实现）。所以我们这里是适配第一种实现。透传C++层参数给Libuv。我们再来看一下
Dispatch

```cpp
    int ReqWrap<uv_connect_t>::Dispatch(int(*)(uv_connect_t*, Args...), Args... args) {    
          req_.data = this;    
          int err = CallLibuvFunction<uv_connect_t, int(*)(uv_connect_t*, Args...)>::Call(    
              fn,    
              env()->event_loop(),    
              req(),    
              args...);    
            
          return err;    
      }    
```

再进一步展开。

```cpp
    static int Call(int(*fn)(uv_connect_t*, Args...), uv_loop_t* loop, uv_connect_t* req, PassedArgs... args) {  
        return fn(req, args...);  
    }  
```

最后展开

```cpp
    static int Call(int(*fn)(uv_connect_t*, Args...), uv_loop_t* loop, uv_connect_t* req, PassedArgs... args) {  
        return fn(req, args...);  
    }  
      
    Call(  
      uv_tcp_connect,  
      env()->event_loop(),  
      req(),  
      &wrap->handle_,  
      AfterConnec  
    )  
      
    uv_tcp_connect(  
      env()->event_loop(),  
      req(),  
      &wrap->handle_,  
      AfterConnect  
    );  
```

接着我们看看uv_tcp_connect做了什么。

```cpp
    int uv_tcp_connect(uv_connect_t* req,  
                       uv_tcp_t* handle,  
                       const struct sockaddr* addr,  
                       uv_connect_cb cb) {  
      // ...  
      return uv__tcp_connect(req, handle, addr, addrlen, cb);  
    }  
      
    int uv__tcp_connect(uv_connect_t* req,  
                        uv_tcp_t* handle,  
                        const struct sockaddr* addr,  
                        unsigned int addrlen,  
                        uv_connect_cb cb) {  
      int err;  
      int r;  
      
      // 关联起来  
      req->handle = (uv_stream_t*) handle;  
      // ...  
    }  
```

Libuv中把req和handle做了关联，如图6-11所示。  
 ![](https://img-blog.csdnimg.cn/370e8bb01b1b44ecafa6679f5b32d7e3.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-11

分析完C++调用Libuv后，我们看看Libuv回调C++和C++回调JS的过程。当Libuv处理完请求后会执行AfterConnect  。

```cpp
    template <typename WrapType, typename UVType>  
    void ConnectionWrap<WrapType, UVType>::AfterConnect(uv_connect_t* req,  
                                                        int status) {  
      // 从Libuv结构体拿到C++的请求对象  
      std::unique_ptr<ConnectWrap> req_wrap  
        (static_cast<ConnectWrap*>(req->data));  
      // 从C++层请求对象拿到对应的handle结构体（Libuv里关联起来的），再通过handle拿到对应的C++层handle对象（HandleWrap关联的）  
      WrapType* wrap = static_cast<WrapType*>(req->handle->data);  
      Environment* env = wrap->env();  
      ...  
      Local<Value> argv[5] = {  
        Integer::New(env->isolate(), status),  
        wrap->object(),  
        req_wrap->object(),  
        Boolean::New(env->isolate(), readable),  
        Boolean::New(env->isolate(), writable)  
      };  
      // 回调JS层oncomplete  
      req_wrap->MakeCallback(env->oncomplete_string(), 
                               arraysize(argv), 
                               argv);  
    }    
```

## 6.8 流封装
Node.js在C++层对流进行了非常多的封装，很多模块都依赖C++层流的机制，流机制的设计中，主要有三个概念 
1 资源，这是流机制的核心（StreamResource）,
2 对流进行操作（StreamReq）
3 流事件的监听者，当对流进行操作或流本身有事件触发时，会把事件和相关的上下文传递给监听者，监听者处理完后，再通知流（StreamListener）。
通过继承的模式，基类定义接口，子类实现接口的方式。对流的操作进行了抽象和封装。三者的类关系如图6-12所示。  
 ![](https://img-blog.csdnimg.cn/f9e8ba87c5034c5bb9c987120c0d4591.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-12

我们看一下读一个流的数据的过程，如图6-13所示。  
![](https://img-blog.csdnimg.cn/3289a56f13a141d88b8069c3432e9f8f.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-13

再看一下写的过程，如图6-14所示。  
 ![](https://img-blog.csdnimg.cn/808c9e3d738f41bab6f40377cec51508.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-14

### 6.8.1 StreamResource
StreamResource定义操作流的通用逻辑和操作结束后触发的回调。但是StreamResource不定义流的类型，流的类型由子类定义，我们可以在StreamResource上注册listener，表示对流感兴趣，当流上有数据可读或者事件发生时，就会通知listener。 

```
    class StreamResource {  
     public:  
      virtual ~StreamResource();   
      // 注册/注销等待流可读事件  
      virtual int ReadStart() = 0;  
      virtual int ReadStop() = 0;  
      // 关闭流  
      virtual int DoShutdown(ShutdownWrap* req_wrap) = 0;  
      // 写入流  
      virtual int DoTryWrite(uv_buf_t** bufs, size_t* count);  
      virtual int DoWrite(WriteWrap* w,  
                          uv_buf_t* bufs,  
                          size_t count,  
                          uv_stream_t* send_handle) = 0;  
      // ...忽略一些  
      // 给流增加或删除监听者  
      void PushStreamListener(StreamListener* listener);  
      void RemoveStreamListener(StreamListener* listener);  
      
     protected:  
      uv_buf_t EmitAlloc(size_t suggested_size);  
      void EmitRead(ssize_t nread, 
                      const uv_buf_t& buf = uv_buf_init(nullptr, 0));
      // 流的监听者，即数据消费者  
      StreamListener* listener_ = nullptr;  
      uint64_t bytes_read_ = 0;  
      uint64_t bytes_written_ = 0;  
      friend class StreamListener;  
    };  
```

StreamResource是一个基类，其中有一个成员是StreamListener类的实例，我们后面分析。我们看一下StreamResource的实现。
1增加一个listener

```
    // 增加一个listener  
    inline void StreamResource::PushStreamListener(StreamListener* listener) {  
      // 头插法   
      listener->previous_listener_ = listener_;  
      listener->stream_ = this;  
      listener_ = listener;  
    }  
```

我们可以在一个流上注册多个listener，流的listener_字段维护了流上所有的listener队列。关系图如图6-15所示。
 ![](https://img-blog.csdnimg.cn/1147406f206a481f9fc8ad8192592d06.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图6-15  
2删除listener

```
    inline void StreamResource::RemoveStreamListener(StreamListener* listener) {  
      StreamListener* previous;  
      StreamListener* current;  
      
      // 遍历单链表  
      for (current = listener_, previous = nullptr;  
           /* No loop condition because we want a crash if listener is not found */  
           ; previous = current, current = current->previous_listener_) {  
        if (current == listener) {  
          // 非空说明需要删除的不是第一个节点  
          if (previous != nullptr)  
            previous->previous_listener_ = current->previous_listener_;  
          else  
            // 删除的是第一个节点，更新头指针就行  
            listener_ = listener->previous_listener_;  
          break;  
        }  
      }  
      // 重置被删除listener的字段 
      listener->stream_ = nullptr;  
      listener->previous_listener_ = nullptr;  
    }  
```

3 申请存储数据

```
    // 申请一块内存  
    inline uv_buf_t StreamResource::EmitAlloc(size_t suggested_size) {  
      DebugSealHandleScope handle_scope(v8::Isolate::GetCurrent());  
      return listener_->OnStreamAlloc(suggested_size);  
    }  
```

StreamResource只是定义了操作流的通用逻辑，数据存储和消费由listener定义。
4 数据可读

```
    inline void StreamResource::EmitRead(ssize_t nread, const uv_buf_t& buf) {  
      if (nread > 0)  
        // 记录从流中读取的数据的字节大小
        bytes_read_ += static_cast<uint64_t>(nread);  
      listener_->OnStreamRead(nread, buf);  
    }  
```

5 写回调

```
    inline void StreamResource::EmitAfterWrite(WriteWrap* w, int status) {  
      DebugSealHandleScope handle_scope(v8::Isolate::GetCurrent());  
      listener_->OnStreamAfterWrite(w, status);  
    }  
```

6 关闭流回调

```
    inline void StreamResource::EmitAfterShutdown(ShutdownWrap* w, int status) {  
      DebugSealHandleScope handle_scope(v8::Isolate::GetCurrent());  
      listener_->OnStreamAfterShutdown(w, status);  
    }  
```

7 流销毁回调

```
    inline StreamResource::~StreamResource() {  
      while (listener_ != nullptr) {  
        StreamListener* listener = listener_;  
        listener->OnStreamDestroy();  
        if (listener == listener_)  
          RemoveStreamListener(listener_);  
      }  
    }  
```

流销毁后需要通知listener，并且解除关系。
### 6.8.2 StreamBase
StreamBase是StreamResource的子类，拓展了StreamResource的功能。

```
    class StreamBase : public StreamResource {  
     public:  
      static constexpr int kStreamBaseField = 1;  
      static constexpr int kOnReadFunctionField = 2;  
      static constexpr int kStreamBaseFieldCount = 3;  
      // 定义一些统一的逻辑  
      static void AddMethods(Environment* env,  
                             v8::Local<v8::FunctionTemplate> target);
      
      virtual bool IsAlive() = 0;  
      virtual bool IsClosing() = 0;  
      virtual bool IsIPCPipe();  
      virtual int GetFD();  
      
      // 执行JS回调  
      v8::MaybeLocal<v8::Value> CallJSOnreadMethod(  
          ssize_t nread,  
          v8::Local<v8::ArrayBuffer> ab,  
          size_t offset = 0,  
          StreamBaseJSChecks checks = DONT_SKIP_NREAD_CHECKS);  
      
      Environment* stream_env() const;  
      // 关闭流  
      int Shutdown(v8::Local<v8::Object> req_wrap_obj = v8::Local<v8::Object>());  
      // 写入流  
      StreamWriteResult Write(  
          uv_buf_t* bufs,  
          size_t count,  
          uv_stream_t* send_handle = nullptr,  
          v8::Local<v8::Object> req_wrap_obj = v8::Local<v8::Object>());  
      // 创建一个关闭请求  
      virtual ShutdownWrap* CreateShutdownWrap(v8::Local<v8::Object> object);  
      // 创建一个写请求  
      virtual WriteWrap* CreateWriteWrap(v8::Local<v8::Object> object);  
      
      virtual AsyncWrap* GetAsyncWrap() = 0;  
      virtual v8::Local<v8::Object> GetObject();  
      static StreamBase* FromObject(v8::Local<v8::Object> obj);  
      
     protected:  
      explicit StreamBase(Environment* env);  
      
      // JS Methods  
      int ReadStartJS(const v8::FunctionCallbackInfo<v8::Value>& args);  
      // 省略系列方法
      void AttachToObject(v8::Local<v8::Object> obj);  
      
      template <int (StreamBase::*Method)(  
          const v8::FunctionCallbackInfo<v8::Value>& args)>  
      static void JSMethod(const v8::FunctionCallbackInfo<v8::Value>& args);  
        
     private:  
      Environment* env_;  
      EmitToJSStreamListener default_listener_;  
      
      void SetWriteResult(const StreamWriteResult& res);  
      static void AddMethod(Environment* env,  
                            v8::Local<v8::Signature> sig,  
                            enum v8::PropertyAttribute attributes,  
                            v8::Local<v8::FunctionTemplate> t,  
                            JSMethodFunction* stream_method,  
                            v8::Local<v8::String> str);   
    };  
```

1 初始化

```
    inline StreamBase::StreamBase(Environment* env) : env_(env) {  
      PushStreamListener(&default_listener_);  
    }  
```

StreamBase初始化的时候会默认设置一个listener。
2 关闭流

```
    // 关闭一个流，req_wrap_obj是JS层传进来的对象  
    inline int StreamBase::Shutdown(v8::Local<v8::Object> req_wrap_obj) {  
      Environment* env = stream_env();  
      HandleScope handle_scope(env->isolate());  
      AsyncHooks::DefaultTriggerAsyncIdScope trigger_scope(GetAsyncWrap());  
      // 创建一个用于请求Libuv的数据结构  
      ShutdownWrap* req_wrap = CreateShutdownWrap(req_wrap_obj); 
      // 子类实现，不同流关闭的逻辑不一样 
      int err = DoShutdown(req_wrap);  
      // 执行出错则销毁JS层对象  
      if (err != 0 && req_wrap != nullptr) {  
        req_wrap->Dispose();  
      }  
      
      const char* msg = Error();  
      if (msg != nullptr) {  
        req_wrap_obj->Set(  
            env->context(),  
            env->error_string(), 
             OneByteString(env->isolate(), msg)).Check();  
        ClearError();  
      }  
      
      return err;  
    }  
```

3 写

```
    // 写Buffer，支持发送文件描述符  
    int StreamBase::WriteBuffer(const FunctionCallbackInfo<Value>& args) {  
      Environment* env = Environment::GetCurrent(args);  
       
      Local<Object> req_wrap_obj = args[0].As<Object>();  
      uv_buf_t buf;  
      // 数据内容和长度  
      buf.base = Buffer::Data(args[1]);  
      buf.len = Buffer::Length(args[1]);  
      
      uv_stream_t* send_handle = nullptr;  
      // 是对象并且流支持发送文件描述符  
      if (args[2]->IsObject() && IsIPCPipe()) {  
        Local<Object> send_handle_obj = args[2].As<Object>();  
      
        HandleWrap* wrap;  
        // 从返回js的对象中获取internalField中指向的C++层对象  
        ASSIGN_OR_RETURN_UNWRAP(&wrap, send_handle_obj, UV_EINVAL);  
        // 拿到Libuv层的handle  
        send_handle = reinterpret_cast<uv_stream_t*>(wrap->GetHandle());  
        // Reference LibuvStreamWrap instance to prevent it from being garbage  
        // collected before `AfterWrite` is called.  
        // 设置到JS层请求对象中  
        req_wrap_obj->Set(env->context(),  
                          env->handle_string(),  
                          send_handle_obj).Check();  
      }  
      
      StreamWriteResult res = Write(&buf, 1, send_handle, req_wrap_obj);  
      SetWriteResult(res);  
      
      return res.err;  
    }  
```

```
    inline StreamWriteResult StreamBase::Write(  
        uv_buf_t* bufs,  
        size_t count,  
        uv_stream_t* send_handle,  
        v8::Local<v8::Object> req_wrap_obj) {  
      Environment* env = stream_env();  
      int err;  
      
      size_t total_bytes = 0;  
      // 计算需要写入的数据大小  
      for (size_t i = 0; i < count; ++i)  
        total_bytes += bufs[i].len;  
      // 同上  
      bytes_written_ += total_bytes;  
      // 是否需要发送文件描述符，不需要则直接写  
      if (send_handle == nullptr) {  
        err = DoTryWrite(&bufs, &count);  
        if (err != 0 || count == 0) {  
          return StreamWriteResult { false, err, nullptr, total_bytes };  
        }  
      }  
      
      HandleScope handle_scope(env->isolate());  
      
      AsyncHooks::DefaultTriggerAsyncIdScope trigger_scope(GetAsyncWrap());  
      // 创建一个用于请求Libuv的写请求对象  
      WriteWrap* req_wrap = CreateWriteWrap(req_wrap_obj);  
      // 执行写，子类实现，不同流写操作不一样  
      err = DoWrite(req_wrap, bufs, count, send_handle);  
      
      const char* msg = Error();  
      if (msg != nullptr) {  
        req_wrap_obj->Set(env->context(),  
                          env->error_string(),  
                          OneByteString(env->isolate(), msg)).Check();  
        ClearError();  
      }  
      
      return StreamWriteResult { async, err, req_wrap, total_bytes };  
    }  
```

4 读

```
    // 操作流，启动读取  
    int StreamBase::ReadStartJS(const FunctionCallbackInfo<Value>& args) {  
      return ReadStart();  
    }  
      
    // 操作流，停止读取  
    int StreamBase::ReadStopJS(const FunctionCallbackInfo<Value>& args) {  
      return ReadStop();  
    }  
      
    // 触发流事件，有数据可读  
    MaybeLocal<Value> StreamBase::CallJSOnreadMethod(ssize_t nread, 
                                                      Local<ArrayBuffer> ab,  
                                                     size_t offset, 
                                                     StreamBaseJSChecks checks) {  
      Environment* env = env_;  
      env->stream_base_state()[kReadBytesOrError] = nread;  
      env->stream_base_state()[kArrayBufferOffset] = offset;  
      
      Local<Value> argv[] = {  
        ab.IsEmpty() ? Undefined(env->isolate()).As<Value>() : ab.As<Value>()  
      };  
      // GetAsyncWrap在StreamBase子类实现，拿到StreamBase类对象  
      AsyncWrap* wrap = GetAsyncWrap();  
      // 获取回调执行  
      Local<Value> onread = wrap->object()->GetInternalField(kOnReadFunctionField);   
      return wrap->MakeCallback(onread.As<Function>(), arraysize(argv), argv);  
    }  
```

4 流通用方法

```
    void StreamBase::AddMethod(Environment* env,  
                               Local<Signature> signature,  
                               enum PropertyAttribute attributes,  
                               Local<FunctionTemplate> t,  
                               JSMethodFunction* stream_method,  
                               Local<String> string) {  
      // 新建一个函数模板                             
      Local<FunctionTemplate> templ =  
          env->NewFunctionTemplate(stream_method,  
                                   signature,  
                                   v8::ConstructorBehavior::kThrow,  
                                   v8::SideEffectType::kHasNoSideEffect);  
      // 设置原型属性  
      t->PrototypeTemplate()->SetAccessorProperty(  
          string, templ, Local<FunctionTemplate>(), attributes);  
    }  
      
    void StreamBase::AddMethods(Environment* env, Local<FunctionTemplate> t) {  
      HandleScope scope(env->isolate());  
      
      enum PropertyAttribute attributes =  
          static_cast<PropertyAttribute>(ReadOnly | DontDelete | DontEnum);  
      Local<Signature> sig = Signature::New(env->isolate(), t);  
      // 设置原型属性  
      AddMethod(env, sig, attributes, t, GetFD, env->fd_string());  
      // 忽略部分
      env->SetProtoMethod(t, "readStart", JSMethod<&StreamBase::ReadStartJS>);  
      env->SetProtoMethod(t, "readStop", JSMethod<&StreamBase::ReadStopJS>);  
      env->SetProtoMethod(t, "shutdown", JSMethod<&StreamBase::Shutdown>);  
      env->SetProtoMethod(t, "writev", JSMethod<&StreamBase::Writev>);  
      env->SetProtoMethod(t, "writeBuffer", JSMethod<&StreamBase::WriteBuffer>);  
      env->SetProtoMethod(  
          t, "writeAsciiString", JSMethod<&StreamBase::WriteString<ASCII>>);  
      env->SetProtoMethod(  
          t, "writeUtf8String", JSMethod<&StreamBase::WriteString<UTF8>>);  
      t->PrototypeTemplate()->Set(FIXED_ONE_BYTE_STRING(env->isolate(),  
                                                        "isStreamBase"),  
                                  True(env->isolate()));  
      // 设置访问器                              
      t->PrototypeTemplate()->SetAccessor(  
          // 键名  
          FIXED_ONE_BYTE_STRING(env->isolate(), "onread"),  
          // getter  
          BaseObject::InternalFieldGet<kOnReadFunctionField>,  
          // setter，Value::IsFunction是set之前的校验函数，见InternalFieldSet（模板函数）定义  
          BaseObject::InternalFieldSet<kOnReadFunctionField, &Value::IsFunction>);  
    }  
```

5 其它函数

```
    // 默认false，子类重写  
    bool StreamBase::IsIPCPipe() {  
      return false;  
    }  
      
    // 子类重写  
    int StreamBase::GetFD() {  
      return -1;  
    }  
      
    Local<Object> StreamBase::GetObject() {  
      return GetAsyncWrap()->object();  
    }  
      
    // 工具函数和实例this无关，和入参有关  
    void StreamBase::GetFD(const FunctionCallbackInfo<Value>& args) {  
      // Mimic implementation of StreamBase::GetFD() and UDPWrap::GetFD().  
      // 从JS层对象获取它关联的C++对象，不一定是this  
      StreamBase* wrap = StreamBase::FromObject(args.This().As<Object>());  
      if (wrap == nullptr) return args.GetReturnValue().Set(UV_EINVAL);  
      
      if (!wrap->IsAlive()) return args.GetReturnValue().Set(UV_EINVAL);  
      
      args.GetReturnValue().Set(wrap->GetFD());  
    }  
      
    void StreamBase::GetBytesRead(const FunctionCallbackInfo<Value>& args) {  
      StreamBase* wrap = StreamBase::FromObject(args.This().As<Object>());  
      if (wrap == nullptr) return args.GetReturnValue().Set(0);  
      
      // uint64_t -> double. 53bits is enough for all real cases.  
      args.GetReturnValue().Set(static_cast<double>(wrap->bytes_read_));  
    }  
```

### 6.8.3 LibuvStreamWrap
LibuvStreamWrap是StreamBase的子类。实现了父类的接口，也拓展了流的能力。

```
    class LibuvStreamWrap : public HandleWrap, public StreamBase {  
     public:  
      static void Initialize(v8::Local<v8::Object> target,  
                             v8::Local<v8::Value> unused,  
                             v8::Local<v8::Context> context,  
                             void* priv);  
      
      int GetFD() override;  
      bool IsAlive() override;  
     bool IsClosing() override;  
     bool IsIPCPipe() override;  
      
     // JavaScript functions  
     int ReadStart() override;  
     int ReadStop() override;  
      
     // Resource implementation  
     int DoShutdown(ShutdownWrap* req_wrap) override;  
     int DoTryWrite(uv_buf_t** bufs, size_t* count) override;  
     int DoWrite(WriteWrap* w,  
                 uv_buf_t* bufs,  
                 size_t count,  
                 uv_stream_t* send_handle) override;  
      
     inline uv_stream_t* stream() const {  
       return stream_;  
     }  
     // 是否是Unix域或命名管道  
     inline bool is_named_pipe() const {  
       return stream()->type == UV_NAMED_PIPE;  
     }  
     // 是否是Unix域并且支持传递文件描述符  
     inline bool is_named_pipe_ipc() const {  
       return is_named_pipe() &&  
              reinterpret_cast<const uv_pipe_t*>(stream())->ipc != 0;  
     }  
      
     inline bool is_tcp() const {  
       return stream()->type == UV_TCP;  
     }  
     // 创建请求Libuv的对象  
     ShutdownWrap* CreateShutdownWrap(v8::Local<v8::Object> object) override;  
     WriteWrap* CreateWriteWrap(v8::Local<v8::Object> object) override;  
     // 从JS层对象获取对于的C++对象  
     static LibuvStreamWrap* From(Environment* env, v8::Local<v8::Object> object);  
      
    protected:  
     LibuvStreamWrap(Environment* env,  
                     v8::Local<v8::Object> object,  
                     uv_stream_t* stream,  
                     AsyncWrap::ProviderType provider);  
      
     AsyncWrap* GetAsyncWrap() override;  
      
     static v8::Local<v8::FunctionTemplate> GetConstructorTemplate( 
         Environment* env);  
      
    private:  
     static void GetWriteQueueSize(  
         const v8::FunctionCallbackInfo<v8::Value>& info);  
     static void SetBlocking(const v8::FunctionCallbackInfo<v8::Value>& args);  
      
     // Callbacks for libuv  
     void OnUvAlloc(size_t suggested_size, uv_buf_t* buf);  
     void OnUvRead(ssize_t nread, const uv_buf_t* buf);  
     
     static void AfterUvWrite(uv_write_t* req, int status);  
     static void AfterUvShutdown(uv_shutdown_t* req, int status);  
      
     uv_stream_t* const stream_;  
    };  
```

1 初始化

```
    LibuvStreamWrap::LibuvStreamWrap(Environment* env,  
                                     Local<Object> object,  
                                     uv_stream_t* stream,  
                                     AsyncWrap::ProviderType provider)  
        : HandleWrap(env,  
                     object,  
                     reinterpret_cast<uv_handle_t*>(stream),  
                     provider),  
          StreamBase(env),  
          stream_(stream) {  
      StreamBase::AttachToObject(object);  
    }  
```

LibuvStreamWrap初始化的时候，会把JS层使用的对象的内部指针指向自己，见HandleWrap。
2 写操作

```
    // 工具函数，获取待写数据字节的大小  
    void LibuvStreamWrap::GetWriteQueueSize(  
        const FunctionCallbackInfo<Value>& info) {  
      LibuvStreamWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap, info.This());  
      uint32_t write_queue_size = wrap->stream()->write_queue_size;  
      info.GetReturnValue().Set(write_queue_size);  
    }  
      
    // 设置非阻塞  
    void LibuvStreamWrap::SetBlocking(const FunctionCallbackInfo<Value>& args) {  
      LibuvStreamWrap* wrap;  
      ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());
      bool enable = args[0]->IsTrue();  
      args.GetReturnValue().Set(uv_stream_set_blocking(wrap->stream(), enable));  
    }  
    // 定义一个关闭的请求  
    typedef SimpleShutdownWrap<ReqWrap<uv_shutdown_t>> LibuvShutdownWrap;  
    // 定义一个写请求  
    typedef SimpleWriteWrap<ReqWrap<uv_write_t>> LibuvWriteWrap;  
      
    ShutdownWrap* LibuvStreamWrap::CreateShutdownWrap(Local<Object> object) {  
      return new LibuvShutdownWrap(this, object);  
    }  
      
    WriteWrap* LibuvStreamWrap::CreateWriteWrap(Local<Object> object) {  
      return new LibuvWriteWrap(this, object);  
    }  
      
    // 发起关闭请求，由父类调用，req_wrap是C++层创建的对象  
    int LibuvStreamWrap::DoShutdown(ShutdownWrap* req_wrap_) {  
      LibuvShutdownWrap* req_wrap = static_cast<LibuvShutdownWrap*>(req_wrap_);  
      return req_wrap->Dispatch(uv_shutdown, stream(), AfterUvShutdown);  
    }  
      
    // 关闭请求结束后执行请求的通用回调Done  
    void LibuvStreamWrap::AfterUvShutdown(uv_shutdown_t* req, int status) {  
      LibuvShutdownWrap* req_wrap = static_cast<LibuvShutdownWrap*>(
          LibuvShutdownWrap::from_req(req));   
      HandleScope scope(req_wrap->env()->isolate());  
      Context::Scope context_scope(req_wrap->env()->context());  
      req_wrap->Done(status);  
    }  
      
    int LibuvStreamWrap::DoTryWrite(uv_buf_t** bufs, size_t* count) {  
      int err;  
      size_t written;  
      uv_buf_t* vbufs = *bufs;  
      size_t vcount = *count;  
      
      err = uv_try_write(stream(), vbufs, vcount);  
      if (err == UV_ENOSYS || err == UV_EAGAIN)  
        return 0;  
      if (err < 0)  
        return err;  
      // 写成功的字节数，更新数据  
      written = err;  
      for (; vcount > 0; vbufs++, vcount--) {  
        // Slice  
        if (vbufs[0].len > written) {  
          vbufs[0].base += written;  
          vbufs[0].len -= written;  
          written = 0;  
          break;  
      
        // Discard  
        } else {  
          written -= vbufs[0].len;  
        }  
      }  
      
      *bufs = vbufs;  
      *count = vcount;  
      
      return 0;  
    }  
      
      
    int LibuvStreamWrap::DoWrite(WriteWrap* req_wrap,  
                                 uv_buf_t* bufs,  
                                 size_t count,  
                                 uv_stream_t* send_handle) {  
      LibuvWriteWrap* w = static_cast<LibuvWriteWrap*>(req_wrap);  
      return w->Dispatch(uv_write2,  
                         stream(),  
                         bufs,  
                         count,  
                         send_handle,  
                         AfterUvWrite);  
    }  
      
      
      
    void LibuvStreamWrap::AfterUvWrite(uv_write_t* req, int status) {  
      LibuvWriteWrap* req_wrap = static_cast<LibuvWriteWrap*>(  
          LibuvWriteWrap::from_req(req));    
      HandleScope scope(req_wrap->env()->isolate());  
      Context::Scope context_scope(req_wrap->env()->context());  
      req_wrap->Done(status);  
    }  
```

3 读操作

```
    // 调用Libuv实现启动读逻辑  
    int LibuvStreamWrap::ReadStart() {  
      return uv_read_start(stream(), [](uv_handle_t* handle,  
                                        size_t suggested_size,  
                                        uv_buf_t* buf) {  
        static_cast<LibuvStreamWrap*>(handle->data)->OnUvAlloc(suggested_size, buf);  
      }, [](uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {  
        static_cast<LibuvStreamWrap*>(stream->data)->OnUvRead(nread, buf);  
      });  
    }  
      
    // 实现停止读逻辑  
    int LibuvStreamWrap::ReadStop() {  
      return uv_read_stop(stream());  
    }  
      
    // 需要分配内存时的回调，由Libuv回调，具体分配内存逻辑由listener实现  
    void LibuvStreamWrap::OnUvAlloc(size_t suggested_size, uv_buf_t* buf) {  
      HandleScope scope(env()->isolate());  
      Context::Scope context_scope(env()->context());  
      
      *buf = EmitAlloc(suggested_size);  
    }  
    // 处理传递的文件描述符  
    template <class WrapType>  
    static MaybeLocal<Object> AcceptHandle(Environment* env,  
                                           LibuvStreamWrap* parent) {    
      EscapableHandleScope scope(env->isolate());  
      Local<Object> wrap_obj;  
      // 根据类型创建一个表示客户端的对象，然后把文件描述符保存其中  
      if (!WrapType::Instantiate(env, parent, WrapType::SOCKET).ToLocal(&wrap_obj))  
        return Local<Object>();  
      // 解出C++层对象  
      HandleWrap* wrap = Unwrap<HandleWrap>(wrap_obj);  
      CHECK_NOT_NULL(wrap);  
      // 拿到C++对象中封装的handle  
      uv_stream_t* stream = reinterpret_cast<uv_stream_t*>(wrap->GetHandle());   
      // 从服务器流中摘下一个fd保存到steam  
      if (uv_accept(parent->stream(), stream))  
        ABORT();  
      
      return scope.Escape(wrap_obj);  
    }  
      
    // 实现OnUvRead，流中有数据或读到结尾时由Libuv回调  
    void LibuvStreamWrap::OnUvRead(ssize_t nread, const uv_buf_t* buf) {  
      HandleScope scope(env()->isolate());  
      Context::Scope context_scope(env()->context());  
      uv_handle_type type = UV_UNKNOWN_HANDLE;  
      // 是否支持传递文件描述符并且有待处理的文件描述符，则判断文件描述符类型  
      if (is_named_pipe_ipc() &&  
          uv_pipe_pending_count(reinterpret_cast<uv_pipe_t*>(stream())) > 0) {  
        type = uv_pipe_pending_type(reinterpret_cast<uv_pipe_t*>(stream()));  
      }  
     
      // 读取成功  
      if (nread > 0) {  
        MaybeLocal<Object> pending_obj;  
        // 根据类型创建一个新的C++对象表示客户端，并且从服务器中摘下一个fd保存到客户端  
        if (type == UV_TCP) {  
          pending_obj = AcceptHandle<TCPWrap>(env(), this);  
        } else if (type == UV_NAMED_PIPE) {  
          pending_obj = AcceptHandle<PipeWrap>(env(), this);  
        } else if (type == UV_UDP) {  
          pending_obj = AcceptHandle<UDPWrap>(env(), this);  
        } else {  
          CHECK_EQ(type, UV_UNKNOWN_HANDLE);  
        }  
        // 有需要处理的文件描述符则设置到JS层对象中，JS层使用  
        if (!pending_obj.IsEmpty()) {  
          object()  
              ->Set(env()->context(),  
                    env()->pending_handle_string(),  
                    pending_obj.ToLocalChecked())  
              .Check();  
        }  
      }  
      // 触发读事件，listener实现  
      EmitRead(nread, *buf);  
    }  
```

读操作不仅支持读取一般的数据，还可以读取文件描述符，C++层会新建一个流对象表示该文件描述符。在JS层可以使用。
### 6.8.4 ConnectionWrap
ConnectionWrap是LibuvStreamWrap子类，拓展了连接的接口。适用于带有连接属性的流，比如Unix域和TCP。

```
    // WrapType是C++层的类，UVType是Libuv的类型  
    template <typename WrapType, typename UVType>  
    class ConnectionWrap : public LibuvStreamWrap {  
     public:  
      static void OnConnection(uv_stream_t* handle, int status);  
      static void AfterConnect(uv_connect_t* req, int status);  
      
     protected:  
      ConnectionWrap(Environment* env,  
                     v8::Local<v8::Object> object,  
                     ProviderType provider);  
      
      UVType handle_;  
    };  
```

1 发起连接后的回调

```
    template <typename WrapType, typename UVType>  
    void ConnectionWrap<WrapType, UVType>::AfterConnect(uv_connect_t* req,  
                                                        int status) {  
      // 通过Libuv结构体拿到对应的C++对象     
      std::unique_ptr<ConnectWrap> req_wrap =
        (static_cast<ConnectWrap*>(req->data));  
      WrapType* wrap = static_cast<WrapType*>(req->handle->data);  
      Environment* env = wrap->env();  
      
      HandleScope handle_scope(env->isolate());  
      Context::Scope context_scope(env->context());  
      
      bool readable, writable;  
      // 连接结果  
      if (status) {  
        readable = writable = false;  
      } else {  
        readable = uv_is_readable(req->handle) != 0;  
        writable = uv_is_writable(req->handle) != 0;  
      }  
      
      Local<Value> argv[5] = {  
        Integer::New(env->isolate(), status),  
        wrap->object(),  
        req_wrap->object(),  
        Boolean::New(env->isolate(), readable),  
        Boolean::New(env->isolate(), writable)  
      };  
      // 回调js  
      req_wrap->MakeCallback(env->oncomplete_string(), 
                                arraysize(argv), 
                                argv);  
    }  
```

2 连接到来时回调

```
    // 有连接时触发的回调  
    template <typename WrapType, typename UVType>  
    void ConnectionWrap<WrapType, UVType>::OnConnection(uv_stream_t* handle,  
                                                        int status) {  
      // 拿到Libuv结构体对应的C++层对象                               
      WrapType* wrap_data = static_cast<WrapType*>(handle->data);  
      Environment* env = wrap_data->env();  
      HandleScope handle_scope(env->isolate());  
      Context::Scope context_scope(env->context());  
      
      // 和客户端通信的对象  
      Local<Value> client_handle;  
      
      if (status == 0) {  
        // Instantiate the client javascript object and handle.  
        // 新建一个JS层使用对象  
        Local<Object> client_obj;  
        if (!WrapType::Instantiate(env, wrap_data, WrapType::SOCKET)
                 .ToLocal(&client_obj))  
          return;  
      
        // Unwrap the client javascript object.  
        WrapType* wrap;  
        // 把JS层使用的对象client_obj所对应的C++层对象存到wrap中  
        ASSIGN_OR_RETURN_UNWRAP(&wrap, client_obj);  
        // 拿到对应的handle  
        uv_stream_t* client = reinterpret_cast<uv_stream_t*>(&wrap->handle_);  
         
        // 从handleaccpet到的fd中拿一个保存到client，client就可以和客户端通信了  
        if (uv_accept(handle, client))  
          return;  
          client_handle = client_obj;  
      } else {  
        client_handle = Undefined(env->isolate());  
      }  
      // 回调JS，client_handle相当于在JS层执行new TCP  
      Local<Value> argv[] = { 
                                 Integer::New(env->isolate(), status), 
                                 client_handle 
                               };  
      wrap_data->MakeCallback(env->onconnection_string(), 
                                 arraysize(argv), 
                                 argv);  
    }  
```

我们看一下TCP的Instantiate。

```
    MaybeLocal<Object> TCPWrap::Instantiate(Environment* env,  
                                            AsyncWrap* parent,  
                                            TCPWrap::SocketType type) {  
      EscapableHandleScope handle_scope(env->isolate());  
      AsyncHooks::DefaultTriggerAsyncIdScope trigger_scope(parent); 
    
      // 拿到导出到JS层的TCP构造函数，缓存在env中  
      Local<Function> constructor = env->tcp_constructor_template()  
                                        ->GetFunction(env->context())
                                        .ToLocalChecked();  
      Local<Value> type_value = Int32::New(env->isolate(), type);  
      // 相当于我们在JS层调用new TCP()时拿到的对象  
      return handle_scope.EscapeMaybe(  
          constructor->NewInstance(env->context(), 1, &type_value));  
    }  
```

### 6.8.5 StreamReq
StreamReq表示操作流的一次请求。主要保存了请求上下文和操作结束后的通用逻辑。

```
    // 请求Libuv的基类  
    class StreamReq {  
     public:  
     // JS层传进来的对象的internalField[1]保存了StreamReq类对象  
      static constexpr int kStreamReqField = 1;  
      // stream为所操作的流，req_wrap_obj为JS层传进来的对象  
      explicit StreamReq(StreamBase* stream,  
                         v8::Local<v8::Object> req_wrap_obj) : stream_(stream) {  
        // JS层对象指向当前StreamReq对象                     
        AttachToObject(req_wrap_obj);  
      }   
      // 子类定义  
      virtual AsyncWrap* GetAsyncWrap() = 0;  
      // 获取相关联的原始js对象  
      v8::Local<v8::Object> object();  
      // 请求结束后的回调，会执行子类的onDone，onDone由子类实现  
      void Done(int status, const char* error_str = nullptr);  
      // JS层对象不再执行StreamReq实例  
      void Dispose();  
      // 获取所操作的流  
      inline StreamBase* stream() const { return stream_; }  
      // 从JS层对象获取StreamReq对象  
      static StreamReq* FromObject(v8::Local<v8::Object> req_wrap_obj);  
      // 请求JS层对象的internalField所有指向  
      static inline void ResetObject(v8::Local<v8::Object> req_wrap_obj);  
      
     protected:  
      // 请求结束后回调
      virtual void OnDone(int status) = 0;  
      void AttachToObject(v8::Local<v8::Object> req_wrap_obj);  
      
     private:  
      StreamBase* const stream_;  
    };  
```

StreamReq有一个成员为stream_，表示StreamReq请求中操作的流。下面我们看一下实现。
1 JS层请求上下文和StreamReq的关系管理。

```
    inline void StreamReq::AttachToObject(v8::Local<v8::Object> req_wrap_obj) {   
      req_wrap_obj->SetAlignedPointerInInternalField(kStreamReqField,                                                      this);  
    }  
      
    inline StreamReq* StreamReq::FromObject(v8::Local<v8::Object> req_wrap_obj) {  
      return static_cast<StreamReq*>(  
          req_wrap_obj->GetAlignedPointerFromInternalField(kStreamReqField));  
    }  
      
    inline void StreamReq::Dispose() {  
      object()->SetAlignedPointerInInternalField(kStreamReqField, nullptr);  
      delete this;  
    }  
      
    inline void StreamReq::ResetObject(v8::Local<v8::Object> obj) { 
      obj->SetAlignedPointerInInternalField(0, nullptr); // BaseObject field.  
      obj->SetAlignedPointerInInternalField(StreamReq::kStreamReqField, nullptr);  
    }  
```

2 获取原始JS层请求对象

```
    // 获取和该请求相关联的原始js对象  
    inline v8::Local<v8::Object> StreamReq::object() {  
      return GetAsyncWrap()->object();  
    }  
```

3 请求结束回调

```
    inline void StreamReq::Done(int status, const char* error_str) {  
      AsyncWrap* async_wrap = GetAsyncWrap();  
      Environment* env = async_wrap->env();  
      if (error_str != nullptr) {  
        async_wrap->object()->Set(env->context(),  
                                  env->error_string(),  
                                  OneByteString(env->isolate(), 
                                                     error_str))  
                                  .Check();  
      }  
      // 执行子类的OnDone  
      OnDone(status);  
    }  
```

流操作请求结束后会统一执行Done，Done会执行子类实现的OnDone函数。
### 6.8.6 ShutdownWrap
ShutdownWrap是StreamReq的子类，表示一次关闭流请求。

```
    class ShutdownWrap : public StreamReq {  
     public:  
      ShutdownWrap(StreamBase* stream,  
                   v8::Local<v8::Object> req_wrap_obj)  
        : StreamReq(stream, req_wrap_obj) { }  
      
      void OnDone(int status) override;  
    };  
```

ShutdownWrap实现了OnDone接口，在关闭流结束后被基类执行。

```
    /* 
      关闭结束时回调，由请求类（ShutdownWrap）调用Libuv， 
      所以Libuv操作完成后，首先执行请求类的回调，请求类通知流，流触发 
      对应的事件，进一步通知listener 
    */  
    inline void ShutdownWrap::OnDone(int status) {  
      stream()->EmitAfterShutdown(this, status);  
      Dispose();  
    }  
```

### 6.8.7 SimpleShutdownWrap
SimpleShutdownWrap是ShutdownWrap的子类。实现了GetAsyncWrap接口。OtherBase可以是ReqWrap或者AsyncWrap。

```
    template <typename OtherBase>  
    class SimpleShutdownWrap : public ShutdownWrap, public OtherBase {  
     public:  
      SimpleShutdownWrap(StreamBase* stream,  
                         v8::Local<v8::Object> req_wrap_obj);  
      
      AsyncWrap* GetAsyncWrap() override { return this; }
    };  
```

### 6.8.8 WriteWrap
WriteWrap是StreamReq的子类，表示一次往流写入数据的请求。

```
    class WriteWrap : public StreamReq {  
     public:  
      void SetAllocatedStorage(AllocatedBuffer&& storage);  
      
      WriteWrap(StreamBase* stream,  
                v8::Local<v8::Object> req_wrap_obj)  
        : StreamReq(stream, req_wrap_obj) { }  
      
      void OnDone(int status) override;  
      
     private:  
      AllocatedBuffer storage_;  
    };  
```

WriteWrap实现了OnDone接口，在写结束时被基类执行。

```
    inline void WriteWrap::OnDone(int status) {  
      stream()->EmitAfterWrite(this, status);  
      Dispose();  
    }  
```

请求结束后调用流的接口通知流写结束了，流会通知listener，listener会调用流的接口通知JS层。
### 6.8.9 SimpleWriteWrap
SimpleWriteWrap是WriteWrap的子类。实现了GetAsyncWrap接口。和SimpleShutdownWrap类型。

```
    template <typename OtherBase>  
    class SimpleWriteWrap : public WriteWrap, public OtherBase {  
     public:  
      SimpleWriteWrap(StreamBase* stream,  
                      v8::Local<v8::Object> req_wrap_obj);  
      
      AsyncWrap* GetAsyncWrap() override { return this; }  
    };  
```

### 6.8.10 StreamListener

```
    class StreamListener {  
     public:  
      virtual ~StreamListener();  
      // 分配存储数据的内存  
      virtual uv_buf_t OnStreamAlloc(size_t suggested_size) = 0;  
      // 有数据可读时回调，消费数据的函数  
      virtual void OnStreamRead(ssize_t nread, const uv_buf_t& buf) = 0;  
      // 流销毁时回调  
      virtual void OnStreamDestroy() {}  
      // 监听者所属流  
      inline StreamResource* stream() { return stream_; }  
      
     protected:  
      // 流是监听者是一条链表，该函数把结构传递给下一个节点  
      void PassReadErrorToPreviousListener(ssize_t nread);  
      // 监听者所属流  
      StreamResource* stream_ = nullptr;  
      // 下一个节点，形成链表  
      StreamListener* previous_listener_ = nullptr;  
      friend class StreamResource;  
    };  
```

StreamListener是类似一个订阅者，它会对流的状态感兴趣，比如数据可读、可写、流关闭等。一个流可以注册多个listener，多个listener形成一个链表。

```
    // 从listen所属的流的listener队列中删除自己  
    inline StreamListener::~StreamListener() {  
      if (stream_ != nullptr)  
        stream_->RemoveStreamListener(this);  
    }  
    // 读出错，把信息传递给前一个listener  
    inline void StreamListener::PassReadErrorToPreviousListener(ssize_t nread) {  
      CHECK_NOT_NULL(previous_listener_);  
      previous_listener_->OnStreamRead(nread, uv_buf_init(nullptr, 0));  
    }  
    // 实现流关闭时的处理逻辑  
    inline void StreamListener::OnStreamAfterShutdown(ShutdownWrap* w, int status) {    
      previous_listener_->OnStreamAfterShutdown(w, status);  
    }  
    // 实现写结束时的处理逻辑  
    inline void StreamListener::OnStreamAfterWrite(WriteWrap* w, int status) {    
      previous_listener_->OnStreamAfterWrite(w, status);  
    }  
```

StreamListener的逻辑不多，具体的实现在子类。
### 6.8.11 ReportWritesToJSStreamListener
ReportWritesToJSStreamListener是StreamListener的子类。覆盖了部分接口和拓展了一些功能。

```
    class ReportWritesToJSStreamListener : public StreamListener {  
     public:  
      // 实现父类的这两个接口
      void OnStreamAfterWrite(WriteWrap* w, int status) override;  
      void OnStreamAfterShutdown(ShutdownWrap* w, int status) override;  
      
     private:  
      void OnStreamAfterReqFinished(StreamReq* req_wrap, int status);  
    };  
```

1 OnStreamAfterReqFinished
OnStreamAfterReqFinished是请求操作流结束后的统一的回调。

```
    void ReportWritesToJSStreamListener::OnStreamAfterWrite(  
        WriteWrap* req_wrap, int status) {  
      OnStreamAfterReqFinished(req_wrap, status);  
    }  
      
    void ReportWritesToJSStreamListener::OnStreamAfterShutdown(  
        ShutdownWrap* req_wrap, int status) {  
      OnStreamAfterReqFinished(req_wrap, status);  
    }  
```

我们看一下具体实现

```
    void ReportWritesToJSStreamListener::OnStreamAfterReqFinished(  
        StreamReq* req_wrap, int status) {  
      // 请求所操作的流  
      StreamBase* stream = static_cast<StreamBase*>(stream_);  
      Environment* env = stream->stream_env();  
      AsyncWrap* async_wrap = req_wrap->GetAsyncWrap();  
      HandleScope handle_scope(env->isolate());  
      Context::Scope context_scope(env->context());  
      // 获取原始的JS层对象  
      Local<Object> req_wrap_obj = async_wrap->object();  
      
      Local<Value> argv[] = {  
        Integer::New(env->isolate(), status),  
        stream->GetObject(),  
        Undefined(env->isolate())  
      };  
      
      const char* msg = stream->Error();  
      if (msg != nullptr) {  
        argv[2] = OneByteString(env->isolate(), msg);  
        stream->ClearError();  
      }  
      // 回调JS层  
      if (req_wrap_obj->Has(env->context(), env->oncomplete_string()).FromJust())  
        async_wrap->MakeCallback(env->oncomplete_string(), arraysize(argv), argv);  
    }  
```

OnStreamAfterReqFinished会回调JS层。
6.8.12 EmitToJSStreamListener
EmitToJSStreamListener是ReportWritesToJSStreamListener的子类

```
    class EmitToJSStreamListener : public ReportWritesToJSStreamListener {  
     public:  
      uv_buf_t OnStreamAlloc(size_t suggested_size) override;  
      void OnStreamRead(ssize_t nread, const uv_buf_t& buf) override;  
    };  
```

我们看一下实现

```
    // 分配一块内存  
    uv_buf_t EmitToJSStreamListener::OnStreamAlloc(size_t suggested_size) {   
      Environment* env = static_cast<StreamBase*>(stream_)->stream_env();  
      return env->AllocateManaged(suggested_size).release();  
    }  
    // 读取数据结束后回调   
    void EmitToJSStreamListener::OnStreamRead(ssize_t nread, const uv_buf_t& buf_) {   
        StreamBase* stream = static_cast<StreamBase*>(stream_);  
      Environment* env = stream->stream_env();  
      HandleScope handle_scope(env->isolate());  
      Context::Scope context_scope(env->context());  
      AllocatedBuffer buf(env, buf_);  
      // 读取失败  
      if (nread <= 0)  {  
        if (nread < 0)  
          stream->CallJSOnreadMethod(nread, Local<ArrayBuffer>());  
        return;  
      }  
        
      buf.Resize(nread);  
      // 读取成功回调JS层  
      stream->CallJSOnreadMethod(nread, buf.ToArrayBuffer());  
    }  
```

我们看到listener处理完数据后又会回调流的接口，具体的逻辑由子类实现。我们来看一个子类的实现（流默认的listener）。

```
    class EmitToJSStreamListener : public ReportWritesToJSStreamListener {  
     public:  
      uv_buf_t OnStreamAlloc(size_t suggested_size) override;  
      void OnStreamRead(ssize_t nread, const uv_buf_t& buf) override;
    };  
```

EmitToJSStreamListener会实现OnStreamRead等方法，接着我们看一下创建一个C++层的TCP对象是怎样的。下面是TCPWrap的继承关系。

```
    class TCPWrap : public ConnectionWrap<TCPWrap, uv_tcp_t>{}  
    // ConnectionWrap拓展了建立TCP连接时的逻辑  
    class ConnectionWrap : public LibuvStreamWrap{}  
    class LibuvStreamWrap : public HandleWrap, public StreamBase{}  
    class StreamBase : public StreamResource {}  
```

我们看到TCP流是继承于StreamResource的。新建一个TCP的C++的对象时（tcp_wrap.cc），会不断往上调用父类的构造函数，其中在StreamBase中有一个关键的操作。

```
    inline StreamBase::StreamBase(Environment* env) : env_(env) {  
      PushStreamListener(&default_listener_);  
    }  
      
    EmitToJSStreamListener default_listener_;  
```

StreamBase会默认给流注册一个listener。我们看下EmitToJSStreamListener 具体的定义。

```
    class ReportWritesToJSStreamListener : public StreamListener {  
     public:  
      void OnStreamAfterWrite(WriteWrap* w, int status) override;  
      void OnStreamAfterShutdown(ShutdownWrap* w, int status) override;  
      
     private:  
      void OnStreamAfterReqFinished(StreamReq* req_wrap, int status);  
    };  
      
    class EmitToJSStreamListener : public ReportWritesToJSStreamListener {  
     public:  
      uv_buf_t OnStreamAlloc(size_t suggested_size) override;  
      void OnStreamRead(ssize_t nread, const uv_buf_t& buf) override;  
    };  
```

EmitToJSStreamListener继承StreamListener ，定义了分配内存和读取接收数据的函数。接着我们看一下PushStreamListener做了什么事情。

```
    inline void StreamResource::PushStreamListener(StreamListener* listener) {  
      // 头插法   
      listener->previous_listener_ = listener_;  
      listener->stream_ = this;  
      listener_ = listener;  
    }  
```

PushStreamListener就是构造出一个listener链表结构。然后我们看一下对于流来说，读取数据的整个链路。首先是JS层调用readStart

```
    function tryReadStart(socket) {  
      socket._handle.reading = true;  
      const err = socket._handle.readStart();  
      if (err)  
        socket.destroy(errnoException(err, 'read'));  
    }  
      
    // 注册等待读事件  
    Socket.prototype._read = function(n) {  
      tryReadStart(this);  
    };  
```

我们看看readStart

```
    int LibuvStreamWrap::ReadStart() {  
      return uv_read_start(stream(), [](uv_handle_t* handle,  
                                        size_t suggested_size,  
                                        uv_buf_t* buf) {  
        static_cast<LibuvStreamWrap*>(handle->data)->OnUvAlloc(suggested_size, buf);  
      }, [](uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {  
        static_cast<LibuvStreamWrap*>(stream->data)->OnUvRead(nread, buf);  
      });  
    }  
```

ReadStart调用Libuv的uv_read_start注册等待可读事件，并且注册了两个回调函数OnUvAlloc和OnUvRead。

```
    void LibuvStreamWrap::OnUvRead(ssize_t nread, const uv_buf_t* buf) {  
       EmitRead(nread, *buf);  
    }  
      
    inline void StreamResource::EmitRead(ssize_t nread, const uv_buf_t& buf) {  
      // bytes_read_表示已读的字节数  
      if (nread > 0)  
        bytes_read_ += static_cast<uint64_t>(nread);  
      listener_->OnStreamRead(nread, buf);  
    }  
```

通过层层调用最后会调用listener_的OnStreamRead。我们看看TCP的OnStreamRead

```
    void EmitToJSStreamListener::OnStreamRead(ssize_t nread, const uv_buf_t& buf_) {  
      StreamBase* stream = static_cast<StreamBase*>(stream_);  
      Environment* env = stream->stream_env();  
      HandleScope handle_scope(env->isolate());  
      Context::Scope context_scope(env->context());  
      AllocatedBuffer buf(env, buf_);  
      stream->CallJSOnreadMethod(nread, buf.ToArrayBuffer());  
    }  
```

继续回调CallJSOnreadMethod

```
    MaybeLocal<Value> StreamBase::CallJSOnreadMethod(ssize_t nread,  
                                                     Local<ArrayBuffer> ab,  
                                                     size_t offset,  
                                                     StreamBaseJSChecks checks) {  
      Environment* env = env_;  
      // ...  
      AsyncWrap* wrap = GetAsyncWrap();  
      CHECK_NOT_NULL(wrap);  
      Local<Value> onread = wrap->object()->GetInternalField(kOnReadFunctionField);  
      CHECK(onread->IsFunction());  
      return wrap->MakeCallback(onread.As<Function>(), arraysize(argv), argv);  
    }  
```

CallJSOnreadMethod会回调JS层的onread回调函数。onread会把数据push到流中，然后触发data事件。
