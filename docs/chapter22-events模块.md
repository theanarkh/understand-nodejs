
events模块是Node.js中比较简单但是却非常核心的模块，Node.js中，很多模块都继承于events模块，events模块是发布、订阅模式的实现。我们首先看一个如果使用events模块。

```
1.	const { EventEmitter } = require('events');  
2.	class Events extends EventEmitter {}  
3.	const events = new Events();  
4.	events.on('demo', () => {  
5.	    console.log('emit demo event');  
6.	});  
7.	events.emit('demo');  
```

接下来我们看一下events模块的具体实现。
## 22.1 初始化
当new一个EventEmitter或者他的子类时，就会进入EventEmitter的逻辑。

```
1.	function EventEmitter(opts) {  
2.	  EventEmitter.init.call(this, opts);  
3.	}  
4.	  
5.	EventEmitter.init = function(opts) {  
6.	  // 如果是未初始化或者没有自定义_events，则初始化  
7.	  if (this._events === undefined ||  
8.	      this._events === ObjectGetPrototypeOf(this)._events) {  
9.	    this._events = ObjectCreate(null);  
10.	    this._eventsCount = 0;  
11.	  }  
12.	  // 初始化处理函数个数的阈值  
13.	  this._maxListeners = this._maxListeners || undefined;  
14.	  
15.	  // 是否开启捕获promise reject,默认false  
16.	  if (opts && opts.captureRejections) {  
17.	    this[kCapture] = Boolean(opts.captureRejections);  
18.	  } else {  
19.	    this[kCapture] = EventEmitter.prototype[kCapture];  
20.	  }  
21.	};  
```

EventEmitter的初始化主要是初始化了一些数据结构和属性。唯一支持的一个参数就是captureRejections，captureRejections表示当触发事件，执行处理函数时，EventEmitter是否捕获处理函数中的异常。后面我们会详细讲解。
## 22.2 订阅事件
初始化完EventEmitter之后，我们就可以开始使用订阅、发布的功能。我们可以通过addListener、prependListener、on、once订阅事件。addListener和on是等价的，prependListener的区别在于处理函数会被插入到队首，而默认是追加到队尾。once注册的处理函数，最多被执行一次。四个API都是通过_addListener函数实现的。下面我们看一下具体实现。

```
1.	function _addListener(target, type, listener, prepend) {  
2.	  let m;  
3.	  let events;  
4.	  let existing;  
5.	  events = target._events;  
6.	  // 还没有初始化_events则初始化  
7.	  if (events === undefined) {  
8.	    events = target._events = ObjectCreate(null);  
9.	    target._eventsCount = 0;  
10.	  } else {  
11.	    /* 
12.	      是否定义了newListener事件，是的话先触发,如果监听了newListener事件， 
13.	      每次注册其他事件时都会触发newListener，相当于钩子 
14.	    */  
15.	    if (events.newListener !== undefined) {  
16.	      target.emit('newListener', type,  
17.	                  listener.listener ? listener.listener : listener);  
18.	      // 可能会修改_events，这里重新赋值  
19.	      events = target._events;  
20.	    }  
21.	    // 判断是否已经存在处理函数  
22.	    existing = events[type];  
23.	  }  
24.	  // 不存在则以函数的形式存储，否则是数组  
25.	  if (existing === undefined) {  
26.	    events[type] = listener;  
27.	    ++target._eventsCount;  
28.	  } else {  
29.	    if (typeof existing === 'function') {  
30.	      existing = events[type] =  
31.	        prepend ? [listener, existing] : [existing, listener];  
32.	    } else if (prepend) {  
33.	      existing.unshift(listener);  
34.	    } else {  
35.	      existing.push(listener);  
36.	    }  
37.	  
38.	    // 处理告警，处理函数过多可能是因为之前的没有删除，造成内存泄漏  
39.	    m = _getMaxListeners(target);  
40.	    if (m > 0 && existing.length > m && !existing.warned) {  
41.	      existing.warned = true;  
42.	      const w = new Error('Possible EventEmitter memory leak detected. ' +  
43.	                          `${existing.length} ${String(type)} listeners ` +  
44.	                          `added to ${inspect(target, { depth: -1 })}. Use ` +  
45.	                          'emitter.setMaxListeners() to increase limit');  
46.	      w.name = 'MaxListenersExceededWarning';  
47.	      w.emitter = target;  
48.	      w.type = type;  
49.	      w.count = existing.length;  
50.	      process.emitWarning(w);  
51.	    }  
52.	  }  
53.	  
54.	  return target;  
55.	}  
```

接下来我们看一下once的实现，对比其他几种api，once的实现相对比较难，因为我们要控制处理函数最多执行一次，所以我们需要坚持用户定义的函数，保证在事件触发的时候，执行用户定义函数的同时，还需要删除注册的事件。

```
1.	EventEmitter.prototype.once = function once(type, listener) {  
2.	  this.on(type, _onceWrap(this, type, listener));  
3.	  return this;  
4.	};  
5.	  
6.	function onceWrapper() {  
7.	  // 还没有触发过  
8.	  if (!this.fired) {  
9.	    // 删除他  
10.	    this.target.removeListener(this.type, this.wrapFn);  
11.	    // 触发了  
12.	    this.fired = true;  
13.	    // 执行  
14.	    if (arguments.length === 0)  
15.	      return this.listener.call(this.target);  
16.	    return this.listener.apply(this.target, arguments);  
17.	  }  
18.	}  
19.	// 支持once api  
20.	function _onceWrap(target, type, listener) {  
21.	  // fired是否已执行处理函数，wrapFn包裹listener的函数  
22.	  const state = { fired: false, wrapFn: undefined, target, type, listener };  
23.	  // 生成一个包裹listener的函数  
24.	  const wrapped = onceWrapper.bind(state);  
25.	  // 把原函数listener也挂到包裹函数中，用于事件没有触发前，用户主动删除，见removeListener  
26.	  wrapped.listener = listener;  
27.	  // 保存包裹函数，用于执行完后删除，见onceWrapper  
28.	  state.wrapFn = wrapped;  
29.	  return wrapped;  
30.	}  
```

## 22.3 触发事件
分析完事件的订阅，接着我们看一下事件的触发。

```
1.	EventEmitter.prototype.emit = function emit(type, ...args) {  
2.	  // 触发的事件是否是error，error事件需要特殊处理  
3.	  let doError = (type === 'error');  
4.	  
5.	  const events = this._events;  
6.	  // 定义了处理函数（不一定是type事件的处理函数）  
7.	  if (events !== undefined) {  
8.	    // 如果触发的事件是error，并且监听了kErrorMonitor事件则触发kErrorMonitor事件  
9.	    if (doError && events[kErrorMonitor] !== undefined)  
10.	      this.emit(kErrorMonitor, ...args);  
11.	    // 触发的是error事件但是没有定义处理函数  
12.	    doError = (doError && events.error === undefined);  
13.	  } else if (!doError) // 没有定义处理函数并且触发的不是error事件则不需要处理，  
14.	    return false;  
15.	  
16.	  // If there is no 'error' event listener then throw.  
17.	  // 触发的是error事件，但是没有定义处理error事件的函数，则报错  
18.	  if (doError) {  
19.	    let er;  
20.	    if (args.length > 0)  
21.	      er = args[0];  
22.	    // 第一个入参是Error的实例  
23.	    if (er instanceof Error) {  
24.	      try {  
25.	        const capture = {};  
26.	        /* 
27.	          给capture对象注入stack属性，stack的值是执行Error.captureStackTrace 
28.	          语句的当前栈信息，但是不包括emit的部分 
29.	        */  
30.	        Error.captureStackTrace(capture, EventEmitter.prototype.emit);  
31.	        ObjectDefineProperty(er, kEnhanceStackBeforeInspector, {  
32.	          value: enhanceStackTrace.bind(this, er, capture),  
33.	          configurable: true  
34.	        });  
35.	      } catch {}  
36.	      throw er; // Unhandled 'error' event  
37.	    }  
38.	  
39.	    let stringifiedEr;  
40.	    const { inspect } = require('internal/util/inspect');  
41.	    try {  
42.	      stringifiedEr = inspect(er);  
43.	    } catch {  
44.	      stringifiedEr = er;  
45.	    }  
46.	    const err = new ERR_UNHANDLED_ERROR(stringifiedEr);  
47.	    err.context = er;  
48.	    throw err; // Unhandled 'error' event  
49.	  }  
50.	  // 获取type事件对应的处理函数  
51.	  const handler = events[type];  
52.	  // 没有则不处理  
53.	  if (handler === undefined)  
54.	    return false;  
55.	  // 等于函数说明只有一个  
56.	  if (typeof handler === 'function') {  
57.	    // 直接执行  
58.	    const result = ReflectApply(handler, this, args);  
59.	    // 非空判断是不是promise并且是否需要处理，见addCatch  
60.	    if (result !== undefined && result !== null) {  
61.	      addCatch(this, result, type, args);  
62.	    }  
63.	  } else {  
64.	    // 多个处理函数，同上  
65.	    const len = handler.length;  
66.	    const listeners = arrayClone(handler, len);  
67.	    for (let i = 0; i < len; ++i) {  
68.	      const result = ReflectApply(listeners[i], this, args);  
69.	      if (result !== undefined && result !== null) {  
70.	        addCatch(this, result, type, args);  
71.	      }  
72.	    }  
73.	  }  
74.	  
75.	  return true;  
76.	}  
```

我们看到在Node.js中，对于error事件是特殊处理的，如果用户没有注册error事件的处理函数，可能会导致程序挂掉，另外我们看到有一个addCatch的逻辑，addCatch是为了支持事件处理函数为异步模式的情况，比如async函数或者返回Promise的函数。

```
1.	function addCatch(that, promise, type, args) {  
2.	  // 没有开启捕获则不需要处理  
3.	  if (!that[kCapture]) {  
4.	    return;  
5.	  }  
6.	  // that throws on second use.  
7.	  try {  
8.	    const then = promise.then;  
9.	  
10.	    if (typeof then === 'function') {  
11.	      // 注册reject的处理函数  
12.	      then.call(promise, undefined, function(err) {  
13.	        process.nextTick(emitUnhandledRejectionOrErr, that, err, type, args);  
14.	      });  
15.	    }  
16.	  } catch (err) {  
17.	    that.emit('error', err);  
18.	  }  
19.	}  
20.	  
21.	function emitUnhandledRejectionOrErr(ee, err, type, args) {  
22.	  // 用户实现了kRejection则执行  
23.	  if (typeof ee[kRejection] === 'function') {  
24.	    ee[kRejection](err, type, ...args);  
25.	  } else {  
26.	    // 保存当前值  
27.	    const prev = ee[kCapture];  
28.	    try {  
29.	      /* 
30.	        关闭然后触发error事件，意义 
31.	        1 防止error事件处理函数也抛出error，导致死循环 
32.	        2 如果用户处理了error，则进程不会退出，所以需要恢复kCapture的值 
33.	          如果用户没有处理error，则nodejs会触发uncaughtException，如果用户 
34.	          处理了uncaughtException则需要灰度kCapture的值 
35.	      */  
36.	      ee[kCapture] = false;  
37.	      ee.emit('error', err);  
38.	    } finally {  
39.	      ee[kCapture] = prev;  
40.	    }  
41.	  }  
42.	}  
```

## 22.4 取消订阅
我们接着看一下删除事件处理函数的逻辑。

```
1.	function removeAllListeners(type) {  
2.	      const events = this._events;  
3.	      if (events === undefined)  
4.	        return this;  
5.	  
6.	      // 没有注册removeListener事件，则只需要删除数据，否则还需要触发removeListener事件  
7.	      if (events.removeListener === undefined) {  
8.	        // 等于0说明是删除全部  
9.	        if (arguments.length === 0) {  
10.	          this._events = ObjectCreate(null);  
11.	          this._eventsCount = 0;  
12.	        } else if (events[type] !== undefined) { // 否则是删除某个类型的事件，  
13.	          // 是唯一一个处理函数，则重置_events，否则删除对应的事件类型  
14.	          if (--this._eventsCount === 0)  
15.	            this._events = ObjectCreate(null);  
16.	          else  
17.	            delete events[type];  
18.	        }  
19.	        return this;  
20.	      }  
21.	  
22.	      // 说明注册了removeListener事件，arguments.length === 0说明删除所有类型的事件  
23.	      if (arguments.length === 0) {  
24.	        // 逐个删除，除了removeListener事件，这里删除了非removeListener事件  
25.	        for (const key of ObjectKeys(events)) {  
26.	          if (key === 'removeListener') continue;  
27.	          this.removeAllListeners(key);  
28.	        }  
29.	        // 这里删除removeListener事件，见下面的逻辑  
30.	        this.removeAllListeners('removeListener');  
31.	        // 重置数据结构  
32.	        this._events = ObjectCreate(null);  
33.	        this._eventsCount = 0;  
34.	        return this;  
35.	      }  
36.	      // 删除某类型事件  
37.	      const listeners = events[type];  
38.	  
39.	      if (typeof listeners === 'function') {  
40.	        this.removeListener(type, listeners);  
41.	      } else if (listeners !== undefined) {  
42.	        // LIFO order  
43.	        for (let i = listeners.length - 1; i >= 0; i--) {  
44.	          this.removeListener(type, listeners[i]);  
45.	        }  
46.	      }  
47.	  
48.	      return this;  
49.	    }  
```

removeAllListeners函数主要的逻辑有两点，第一个是removeListener事件需要特殊处理，这类似一个钩子，每次用户删除事件处理函数的时候都会触发该事件。第二是removeListener函数。removeListener是真正删除事件处理函数的实现。removeAllListeners是封装了removeListener的逻辑。

```
1.	function removeListener(type, listener) {  
2.	   let originalListener;  
3.	   const events = this._events;  
4.	   // 没有东西可删除  
5.	   if (events === undefined)  
6.	     return this;  
7.	  
8.	   const list = events[type];  
9.	   // 同上  
10.	   if (list === undefined)  
11.	     return this;  
12.	   // list是函数说明只有一个处理函数，否则是数组,如果list.listener === listener说明是once注册的  
13.	   if (list === listener || list.listener === listener) {  
14.	     // type类型的处理函数就一个，并且也没有注册其他类型的事件，则初始化_events  
15.	     if (--this._eventsCount === 0)  
16.	       this._events = ObjectCreate(null);  
17.	     else {  
18.	       // 就一个执行完删除type对应的属性  
19.	       delete events[type];  
20.	       // 注册了removeListener事件，则先注册removeListener事件  
21.	       if (events.removeListener)  
22.	         this.emit('removeListener', type, list.listener || listener);  
23.	     }  
24.	   } else if (typeof list !== 'function') {  
25.	     // 多个处理函数  
26.	     let position = -1;  
27.	     // 找出需要删除的函数  
28.	     for (let i = list.length - 1; i >= 0; i--) {  
29.	       if (list[i] === listener || list[i].listener === listener) {  
30.	         // 保存原处理函数，如果有的话  
31.	         originalListener = list[i].listener;  
32.	         position = i;  
33.	         break;  
34.	       }  
35.	     }  
36.	  
37.	     if (position < 0)  
38.	       return this;  
39.	     // 第一个则出队，否则删除一个  
40.	     if (position === 0)  
41.	       list.shift();  
42.	     else {  
43.	       if (spliceOne === undefined)  
44.	         spliceOne = require('internal/util').spliceOne;  
45.	       spliceOne(list, position);  
46.	     }  
47.	     // 如果只剩下一个，则值改成函数类型  
48.	     if (list.length === 1)  
49.	       events[type] = list[0];  
50.	     // 触发removeListener  
51.	     if (events.removeListener !== undefined)  
52.	       this.emit('removeListener', type, originalListener || listener);  
53.	   }  
54.	  
55.	   return this;  
56.	 };  
```

以上就是events模块的核心逻辑，另外还有一些工具函数就不一一分析。
