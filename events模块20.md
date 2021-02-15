events模块是Node.js中比较简单但是却非常核心的模块，Node.js中，很多模块都继承于events模块，events模块是发布、订阅模式的实现。我们首先看一下如何使用events模块。

```cpp
1.  const { EventEmitter } = require('events');  
2.  class Events extends EventEmitter {}  
3.  const events = new Events();  
4.  events.on('demo', () => {  
5.      console.log('emit demo event');  
6.  });  
7.  events.emit('demo');  
```

接下来我们看一下events模块的具体实现。
1 初始化
当new一个EventEmitter或者它的子类时，就会进入EventEmitter的逻辑。

```cpp
1.  function EventEmitter(opts) {  
2.    EventEmitter.init.call(this, opts);  
3.  }  
4.    
5.  EventEmitter.init = function(opts) {  
6.    // 如果是未初始化或者没有自定义_events，则初始化  
7.    if (this._events === undefined ||  
8.        this._events === ObjectGetPrototypeOf(this)._events) {  
9.       this._events = ObjectCreate(null);  
10.     this._eventsCount = 0;  
11.   }  
12.   /*
13.     初始化一类事件的处理函数个数的阈值
14.     我们可以通过setMaxListeners接口设置，
15.     如果没有显示设置，阈值则为defaultMaxListeners的值（10），
16.     可通过getMaxListeners接口获取
17.   */  
18.   this._maxListeners = this._maxListeners || undefined;  
19.   
20.   // 是否开启捕获promise reject,默认false  
21.   if (opts && opts.captureRejections) {  
22.     this[kCapture] = Boolean(opts.captureRejections);  
23.   } else {  
24.     this[kCapture] = EventEmitter.prototype[kCapture];  
25.   }  
26. };  
```

EventEmitter的初始化主要是初始化了一些数据结构和属性。唯一支持的一个参数就是captureRejections，captureRejections表示当触发事件，执行处理函数时，EventEmitter是否捕获处理函数中的异常。后面我们会详细讲解。
2 订阅事件
初始化完EventEmitter之后，我们就可以开始使用订阅、发布的功能。我们可以通过addListener、prependListener、on、once订阅事件。addListener和on是等价的，prependListener的区别在于处理函数会被插入到队首，而默认是追加到队尾。once注册的处理函数，最多被执行一次。四个api都是通过_addListener函数实现的。下面我们看一下具体实现。

```cpp
1.  function _addListener(target, type, listener, prepend) {  
2.    let m;  
3.    let events;  
4.    let existing;  
5.    events = target._events;  
6.    // 还没有初始化_events则初始化，_eventsCount为事件类型个数  
7.    if (events === undefined) {  
8.      events = target._events = ObjectCreate(null);  
9.      target._eventsCount = 0;  
10.   } else {  
11.     /* 
12.       已经注册过事件，则判断是否定义了newListener事件，
13.        是的话先触发,如果监听了newListener事件，每次注册
14.        其它事件时都会触发newListener，相当于钩子 
15.     */  
16.     if (events.newListener !== undefined) {  
17.       target.emit('newListener', 
18.                     type,  
19.                   listener.listener ? 
20.                     listener.listener : 
21.                     listener);  
22.       // newListener处理函数可能会修改_events，这里重新赋值  
23.       events = target._events;  
24.     }  
25.     // 判断是否已经存在处理函数  
26.     existing = events[type];  
27.   }  
28.   // 不存在则以函数的形式存储，否则以数组形式存储  
29.   if (existing === undefined) {  
30.     events[type] = listener;  
31.     // 新增一个事件类型，事件类型个数加一
32.     ++target._eventsCount;  
33.   } else {  
34.     /* 
35.        existing是函数说明之前注册过该事件一次，
36.        否则说明existing为数组，则直接插入相应位置
37.     */
38.     if (typeof existing === 'function') {  
39.       existing = events[type] =  
40.         prepend ? [listener, existing] : [existing, listener];  
41.     } else if (prepend) {  
42.       existing.unshift(listener);  
43.     } else {  
44.       existing.push(listener);  
45.     }  
46.   
47.     // 处理告警，处理函数过多可能是因为之前的没有删除，造成内存泄漏  
48.     m = _getMaxListeners(target);  
49.     // 该事件处理函数达到阈值并且还没有提示过警告信息则提示
50.     if (m > 0 && existing.length > m && !existing.warned) {  
51.       existing.warned = true;  
52.       const w = new Error('错误信息…');  
53.       w.name = 'MaxListenersExceededWarning';  
54.       w.emitter = target;  
55.       w.type = type;  
56.       w.count = existing.length;  
57.       process.emitWarning(w);  
58.     }  
59.   }  
60.   
61.   return target;  
62. }  
```

接下来我们看一下once的实现，对比其它几种api，once的实现相对比较复杂，因为我们要控制处理函数最多执行一次，所以我们需要保证在事件触发的时候，执行用户定义函数的同时，还需要删除注册的事件。

```cpp
1.  EventEmitter.prototype.once = function once(type, listener) {  
2.    this.on(type, _onceWrap(this, type, listener));  
3.    return this;  
4.  };  
5.    
6.  function onceWrapper() {  
7.    // 还没有触发过  
8.    if (!this.fired) {  
9.      // 删除它  
10.     this.target.removeListener(this.type, this.wrapFn);  
11.     // 触发了  
12.     this.fired = true;  
13.     // 执行  
14.     if (arguments.length === 0)  
15.       return this.listener.call(this.target);  
16.     return this.listener.apply(this.target, arguments);  
17.   }  
18. }  
19. // 支持once api  
20. function _onceWrap(target, type, listener) {  
21.   // fired是否已执行处理函数，wrapFn包裹listener的函数  
22.   const state = { fired: false, wrapFn: undefined, target, type, listener };  
23.   // 生成一个包裹listener的函数  
24.   const wrapped = onceWrapper.bind(state);  
25.   /*
26.     把原函数listener也挂到包裹函数中，用于事件没有触发前，
27.     用户主动删除，见removeListener  
28.   */
29.   wrapped.listener = listener;  
30.   // 保存包裹函数，用于执行完后删除，见onceWrapper  
31.   state.wrapFn = wrapped;  
32.   return wrapped;  
33. }  
```

Once函数构造一个上下文（state）保存用户处理函数和执行状态等信息，然后通过bind返回一个带有该上下文（state）的函数wrapped注册到事件系统。当事件触发时，在wrapped函数中首先移除wrapped，然后执行用户的函数。Wrapped起到了劫持的作用。另外还需要在wrapped上保存用户传进来的函数，当用户在事件触发前删除该事件时或解除该函数时，在遍历该类事件的处理函数过程中，可以通过wrapped.listener找到对应的项进行删除。
3 触发事件
分析完事件的订阅，接着我们看一下事件的触发。

```cpp
1.  EventEmitter.prototype.emit = function emit(type, ...args) {  
2.    // 触发的事件是否是error，error事件需要特殊处理  
3.    let doError = (type === 'error');  
4.    
5.    const events = this._events;  
6.    // 定义了处理函数（不一定是type事件的处理函数）  
7.    if (events !== undefined) {  
8.       /*
9.        如果触发的事件是error，并且监听了kErrorMonitor
10.      事件则触发kErrorMonitor事件
11.     */  
12.     if (doError && events[kErrorMonitor] !== undefined)  
13.       this.emit(kErrorMonitor, ...args);  
14.     // 触发的是error事件但是没有定义处理函数  
15.     doError = (doError && events.error === undefined);  
16.   } else if (!doError) 
17.     // 没有定义处理函数并且触发的不是error事件则不需要处理，  
18.     return false;  
19.   
20.   // If there is no 'error' event listener then throw.  
21.   // 触发的是error事件，但是没有定义处理error事件的函数，则报错  
22.   if (doError) {  
23.     let er;  
24.     if (args.length > 0)  
25.       er = args[0];  
26.     // 第一个入参是Error的实例  
27.     if (er instanceof Error) {  
28.       try {  
29.         const capture = {};  
30.         /* 
31.           给capture对象注入stack属性，stack的值是执行    
32.            Error.captureStackTrace语句的当前栈信息，但是
33.            不包括emit的部分 
34.         */  
35.         Error.captureStackTrace(capture, EventEmitter.prototype.emit);  
36.         ObjectDefineProperty(er, kEnhanceStackBeforeInspector, {  
37.           value: enhanceStackTrace.bind(this, er, capture),  
38.           configurable: true  
39.         });  
40.       } catch {}  
41.       throw er; // Unhandled 'error' event  
42.     }  
43.   
44.     let stringifiedEr;  
45.     const { inspect } = require('internal/util/inspect');  
46.     try {  
47.       stringifiedEr = inspect(er);  
48.     } catch {  
49.       stringifiedEr = er;  
50.     }  
51.     const err = new ERR_UNHANDLED_ERROR(stringifiedEr);  
52.     err.context = er;  
53.     throw err; // Unhandled 'error' event  
54.   }  
55.   // 获取type事件对应的处理函数  
56.   const handler = events[type];  
57.   // 没有则不处理  
58.   if (handler === undefined)  
59.     return false;  
60.   // 等于函数说明只有一个  
61.   if (typeof handler === 'function') {  
62.     // 直接执行  
63.     const result = ReflectApply(handler, this, args);  
64.     // 非空判断是不是promise并且是否需要处理，见addCatch  
65.     if (result !== undefined && result !== null) {  
66.       addCatch(this, result, type, args);  
67.     }  
68.   } else {  
69.     // 多个处理函数，同上  
70.     const len = handler.length;  
71.     const listeners = arrayClone(handler, len);  
72.     for (let i = 0; i < len; ++i) {  
73.       const result = ReflectApply(listeners[i], this, args);  
74.       if (result !== undefined && result !== null) {  
75.         addCatch(this, result, type, args);  
76.       }  
77.     }  
78.   }  
79.   
80.   return true;  
81. }  
```

我们看到在Node.js中，对于error事件是特殊处理的，如果用户没有注册error事件的处理函数，可能会导致程序挂掉，另外我们看到有一个addCatch的逻辑，addCatch是为了支持事件处理函数为异步模式的情况，比如async函数或者返回Promise的函数。

```cpp
1.  function addCatch(that, promise, type, args) {  
2.    // 没有开启捕获则不需要处理  
3.    if (!that[kCapture]) {  
4.      return;  
5.    }  
6.    // that throws on second use.  
7.    try {  
8.      const then = promise.then;  
9.    
10.     if (typeof then === 'function') {  
11.       // 注册reject的处理函数  
12.       then.call(promise, undefined, function(err) {  
13.         process.nextTick(emitUnhandledRejectionOrErr, that, err, type, args);  
14.       });  
15.     }  
16.   } catch (err) {  
17.     that.emit('error', err);  
18.   }  
19. }  
20.   
21. function emitUnhandledRejectionOrErr(ee, err, type, args) {  
22.   // 用户实现了kRejection则执行  
23.   if (typeof ee[kRejection] === 'function') {  
24.     ee[kRejection](err, type, ...args);  
25.   } else {  
26.     // 保存当前值  
27.     const prev = ee[kCapture];  
28.     try {  
29.       /* 
30.         关闭然后触发error事件，意义 
31.         1 防止error事件处理函数也抛出error，导致死循环 
32.         2 如果用户处理了error，则进程不会退出，所以需要恢复
33.            kCapture的值如果用户没有处理error，则Node.js会触发
34.            uncaughtException，如果用户处理了uncaughtException
35.            则需要恢复kCapture的值 
36.       */  
37.       ee[kCapture] = false;  
38.       ee.emit('error', err);  
39.     } finally {  
40.       ee[kCapture] = prev;  
41.     }  
42.   }  
43. }  
```

4 取消订阅
我们接着看一下删除事件处理函数的逻辑。

```cpp
1.  function removeAllListeners(type) {  
2.        const events = this._events;  
3.        if (events === undefined)  
4.          return this;  
5.    
6.        /*
7.          没有注册removeListener事件，则只需要删除数据，
8.          否则还需要触发removeListener事件  
9.         */
10.       if (events.removeListener === undefined) {  
11.         // 等于0说明是删除全部  
12.         if (arguments.length === 0) {  
13.           this._events = ObjectCreate(null);  
14.           this._eventsCount = 0;  
15.         } else if (events[type] !== undefined) { 
16.            /*
17.              否则是删除某个类型的事件，是唯一一个处理函数，
18.              则重置_events，否则删除对应的事件类型         
19.            */
20.           if (--this._eventsCount === 0)  
21.             this._events = ObjectCreate(null);  
22.           else  
23.             delete events[type];  
24.         }  
25.         return this;  
26.       }  
27.   
28.       /*
29.         说明注册了removeListener事件，arguments.length === 0
30.         说明删除所有类型的事件  
31.        */
32.       if (arguments.length === 0) {  
33.         /* 
34.           逐个删除，除了removeListener事件，
35.           这里删除了非removeListener事件
36.          */  
37.         for (const key of ObjectKeys(events)) {  
38.           if (key === 'removeListener') continue;  
39.           this.removeAllListeners(key);  
40.         }  
41.         // 这里删除removeListener事件，见下面的逻辑  
42.         this.removeAllListeners('removeListener');  
43.         // 重置数据结构  
44.         this._events = ObjectCreate(null);  
45.         this._eventsCount = 0;  
46.         return this;  
47.       }  
48.       // 删除某类型事件  
49.       const listeners = events[type];  
50.   
51.       if (typeof listeners === 'function') {  
52.         this.removeListener(type, listeners);  
53.       } else if (listeners !== undefined) {  
54.         // LIFO order  
55.         for (let i = listeners.length - 1; i >= 0; i--) {  
56.           this.removeListener(type, listeners[i]);  
57.         }  
58.       }  
59.   
60.       return this;  
61.     }  
```

removeAllListeners函数主要的逻辑有两点，第一个是removeListener事件需要特殊处理，这类似一个钩子，每次用户删除事件处理函数的时候都会触发该事件。第二是removeListener函数。removeListener是真正删除事件处理函数的实现。removeAllListeners是封装了removeListener的逻辑。

```cpp
1.  function removeListener(type, listener) {  
2.     let originalListener;  
3.     const events = this._events;  
4.     // 没有东西可删除  
5.     if (events === undefined)  
6.       return this;  
7.    
8.     const list = events[type];  
9.     // 同上  
10.    if (list === undefined)  
11.      return this;  
12.    // list是函数说明只有一个处理函数，否则是数组,如果list.listener === listener说明是once注册的  
13.    if (list === listener || list.listener === listener) {  
14.      // type类型的处理函数就一个，并且也没有注册其它类型的事件，则初始化_events  
15.      if (--this._eventsCount === 0)  
16.        this._events = ObjectCreate(null);  
17.      else {  
18.        // 就一个执行完删除type对应的属性  
19.        delete events[type];  
20.        // 注册了removeListener事件，则先注册removeListener事件  
21.        if (events.removeListener)  
22.          this.emit('removeListener',
23.                      type,
24.                      list.listener || listener);  
25.      }  
26.    } else if (typeof list !== 'function') {  
27.      // 多个处理函数  
28.      let position = -1;  
29.      // 找出需要删除的函数  
30.      for (let i = list.length - 1; i >= 0; i--) {  
31.        if (list[i] === listener || 
32.             list[i].listener === listener) {  
33.          // 保存原处理函数，如果有的话  
34.          originalListener = list[i].listener;  
35.          position = i;  
36.          break;  
37.        }  
38.      }  
39.   
40.      if (position < 0)  
41.        return this;  
42.      // 第一个则出队，否则删除一个  
43.      if (position === 0)  
44.        list.shift();  
45.      else {  
46.        if (spliceOne === undefined)  
47.          spliceOne = require('internal/util').spliceOne;  
48.        spliceOne(list, position);  
49.      }  
50.      // 如果只剩下一个，则值改成函数类型  
51.      if (list.length === 1)  
52.        events[type] = list[0];  
53.      // 触发removeListener  
54.      if (events.removeListener !== undefined)  
55.        this.emit('removeListener', 
56.                    type,
57.                    originalListener || listener);  
58.    }  
59.   
60.    return this;  
61.  };  
```

以上就是events模块的核心逻辑，另外还有一些工具函数就不一一分析。
