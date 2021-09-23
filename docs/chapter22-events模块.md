
events模块是Node.js中比较简单但是却非常核心的模块，Node.js中，很多模块都继承于events模块，events模块是发布、订阅模式的实现。我们首先看一个如果使用events模块。

```js
    const { EventEmitter } = require('events');  
    class Events extends EventEmitter {}  
    const events = new Events();  
    events.on('demo', () => {  
        console.log('emit demo event');  
    });  
    events.emit('demo');  
```

接下来我们看一下events模块的具体实现。
## 22.1 初始化
当new一个EventEmitter或者他的子类时，就会进入EventEmitter的逻辑。

```js
    function EventEmitter(opts) {  
      EventEmitter.init.call(this, opts);  
    }  
      
    EventEmitter.init = function(opts) {  
      // 如果是未初始化或者没有自定义_events，则初始化  
      if (this._events === undefined ||  
          this._events === ObjectGetPrototypeOf(this)._events) {  
        this._events = ObjectCreate(null);  
        this._eventsCount = 0;  
      }  
      // 初始化处理函数个数的阈值  
      this._maxListeners = this._maxListeners || undefined;  
      
      // 是否开启捕获promise reject,默认false  
      if (opts && opts.captureRejections) {  
        this[kCapture] = Boolean(opts.captureRejections);  
      } else {  
        this[kCapture] = EventEmitter.prototype[kCapture];  
      }  
    };  
```

EventEmitter的初始化主要是初始化了一些数据结构和属性。唯一支持的一个参数就是captureRejections，captureRejections表示当触发事件，执行处理函数时，EventEmitter是否捕获处理函数中的异常。后面我们会详细讲解。
## 22.2 订阅事件
初始化完EventEmitter之后，我们就可以开始使用订阅、发布的功能。我们可以通过addListener、prependListener、on、once订阅事件。addListener和on是等价的，prependListener的区别在于处理函数会被插入到队首，而默认是追加到队尾。once注册的处理函数，最多被执行一次。四个API都是通过_addListener函数实现的。下面我们看一下具体实现。

```js
    function _addListener(target, type, listener, prepend) {  
      let m;  
      let events;  
      let existing;  
      events = target._events;  
      // 还没有初始化_events则初始化  
      if (events === undefined) {  
        events = target._events = ObjectCreate(null);  
        target._eventsCount = 0;  
      } else {  
        /* 
          是否定义了newListener事件，是的话先触发,如果监听了newListener事件， 
          每次注册其他事件时都会触发newListener，相当于钩子 
        */  
        if (events.newListener !== undefined) {  
          target.emit('newListener', type,  
                      listener.listener ? listener.listener : listener);  
          // 可能会修改_events，这里重新赋值  
          events = target._events;  
        }  
        // 判断是否已经存在处理函数  
        existing = events[type];  
      }  
      // 不存在则以函数的形式存储，否则是数组  
      if (existing === undefined) {  
        events[type] = listener;  
        ++target._eventsCount;  
      } else {  
        if (typeof existing === 'function') {  
          existing = events[type] =  
            prepend ? [listener, existing] : [existing, listener];  
        } else if (prepend) {  
          existing.unshift(listener);  
        } else {  
          existing.push(listener);  
        }  
      
        // 处理告警，处理函数过多可能是因为之前的没有删除，造成内存泄漏  
        m = _getMaxListeners(target);  
        if (m > 0 && existing.length > m && !existing.warned) {  
          existing.warned = true;  
          const w = new Error('Possible EventEmitter memory leak detected. ' +  
                              `${existing.length} ${String(type)} listeners ` +  
                              `added to ${inspect(target, { depth: -1 })}. Use ` +  
                              'emitter.setMaxListeners() to increase limit');  
          w.name = 'MaxListenersExceededWarning';  
          w.emitter = target;  
          w.type = type;  
          w.count = existing.length;  
          process.emitWarning(w);  
        }  
      }  
      
      return target;  
    }  
```

接下来我们看一下once的实现，对比其他几种api，once的实现相对比较难，因为我们要控制处理函数最多执行一次，所以我们需要坚持用户定义的函数，保证在事件触发的时候，执行用户定义函数的同时，还需要删除注册的事件。

```js
    EventEmitter.prototype.once = function once(type, listener) {  
      this.on(type, _onceWrap(this, type, listener));  
      return this;  
    };  
      
    function onceWrapper() {  
      // 还没有触发过  
      if (!this.fired) {  
        // 删除他  
        this.target.removeListener(this.type, this.wrapFn);  
        // 触发了  
        this.fired = true;  
        // 执行  
        if (arguments.length === 0)  
          return this.listener.call(this.target);  
        return this.listener.apply(this.target, arguments);  
      }  
    }  
    // 支持once api  
    function _onceWrap(target, type, listener) {  
      // fired是否已执行处理函数，wrapFn包裹listener的函数  
      const state = { fired: false, wrapFn: undefined, target, type, listener };  
      // 生成一个包裹listener的函数  
      const wrapped = onceWrapper.bind(state);  
      // 把原函数listener也挂到包裹函数中，用于事件没有触发前，用户主动删除，见removeListener  
      wrapped.listener = listener;  
      // 保存包裹函数，用于执行完后删除，见onceWrapper  
      state.wrapFn = wrapped;  
      return wrapped;  
    }  
```

## 22.3 触发事件
分析完事件的订阅，接着我们看一下事件的触发。

```js
    EventEmitter.prototype.emit = function emit(type, ...args) {  
      // 触发的事件是否是error，error事件需要特殊处理  
      let doError = (type === 'error');  
      
      const events = this._events;  
      // 定义了处理函数（不一定是type事件的处理函数）  
      if (events !== undefined) {  
        // 如果触发的事件是error，并且监听了kErrorMonitor事件则触发kErrorMonitor事件  
        if (doError && events[kErrorMonitor] !== undefined)  
          this.emit(kErrorMonitor, ...args);  
        // 触发的是error事件但是没有定义处理函数  
        doError = (doError && events.error === undefined);  
      } else if (!doError) // 没有定义处理函数并且触发的不是error事件则不需要处理，  
        return false;  
      
      // If there is no 'error' event listener then throw.  
      // 触发的是error事件，但是没有定义处理error事件的函数，则报错  
      if (doError) {  
        let er;  
        if (args.length > 0)  
          er = args[0];  
        // 第一个入参是Error的实例  
        if (er instanceof Error) {  
          try {  
            const capture = {};  
            /* 
              给capture对象注入stack属性，stack的值是执行Error.captureStackTrace 
              语句的当前栈信息，但是不包括emit的部分 
            */  
            Error.captureStackTrace(capture, EventEmitter.prototype.emit);  
            ObjectDefineProperty(er, kEnhanceStackBeforeInspector, {  
              value: enhanceStackTrace.bind(this, er, capture),  
              configurable: true  
            });  
          } catch {}  
          throw er; // Unhandled 'error' event  
        }  
      
        let stringifiedEr;  
        const { inspect } = require('internal/util/inspect');  
        try {  
          stringifiedEr = inspect(er);  
        } catch {  
          stringifiedEr = er;  
        }  
        const err = new ERR_UNHANDLED_ERROR(stringifiedEr);  
        err.context = er;  
        throw err; // Unhandled 'error' event  
      }  
      // 获取type事件对应的处理函数  
      const handler = events[type];  
      // 没有则不处理  
      if (handler === undefined)  
        return false;  
      // 等于函数说明只有一个  
      if (typeof handler === 'function') {  
        // 直接执行  
        const result = ReflectApply(handler, this, args);  
        // 非空判断是不是promise并且是否需要处理，见addCatch  
        if (result !== undefined && result !== null) {  
          addCatch(this, result, type, args);  
        }  
      } else {  
        // 多个处理函数，同上  
        const len = handler.length;  
        const listeners = arrayClone(handler, len);  
        for (let i = 0; i < len; ++i) {  
          const result = ReflectApply(listeners[i], this, args);  
          if (result !== undefined && result !== null) {  
            addCatch(this, result, type, args);  
          }  
        }  
      }  
      
      return true;  
    }  
```

我们看到在Node.js中，对于error事件是特殊处理的，如果用户没有注册error事件的处理函数，可能会导致程序挂掉，另外我们看到有一个addCatch的逻辑，addCatch是为了支持事件处理函数为异步模式的情况，比如async函数或者返回Promise的函数。

```js
    function addCatch(that, promise, type, args) {  
      // 没有开启捕获则不需要处理  
      if (!that[kCapture]) {  
        return;  
      }  
      // that throws on second use.  
      try {  
        const then = promise.then;  
      
        if (typeof then === 'function') {  
          // 注册reject的处理函数  
          then.call(promise, undefined, function(err) {  
            process.nextTick(emitUnhandledRejectionOrErr, that, err, type, args);  
          });  
        }  
      } catch (err) {  
        that.emit('error', err);  
      }  
    }  
      
    function emitUnhandledRejectionOrErr(ee, err, type, args) {  
      // 用户实现了kRejection则执行  
      if (typeof ee[kRejection] === 'function') {  
        ee[kRejection](err, type, ...args);  
      } else {  
        // 保存当前值  
        const prev = ee[kCapture];  
        try {  
          /* 
            关闭然后触发error事件，意义 
            1 防止error事件处理函数也抛出error，导致死循环 
            2 如果用户处理了error，则进程不会退出，所以需要恢复kCapture的值 
              如果用户没有处理error，则nodejs会触发uncaughtException，如果用户 
              处理了uncaughtException则需要灰度kCapture的值 
          */  
          ee[kCapture] = false;  
          ee.emit('error', err);  
        } finally {  
          ee[kCapture] = prev;  
        }  
      }  
    }  
```

## 22.4 取消订阅
我们接着看一下删除事件处理函数的逻辑。

```js
    function removeAllListeners(type) {  
          const events = this._events;  
          if (events === undefined)  
            return this;  
      
          // 没有注册removeListener事件，则只需要删除数据，否则还需要触发removeListener事件  
          if (events.removeListener === undefined) {  
            // 等于0说明是删除全部  
            if (arguments.length === 0) {  
              this._events = ObjectCreate(null);  
              this._eventsCount = 0;  
            } else if (events[type] !== undefined) { // 否则是删除某个类型的事件，  
              // 是唯一一个处理函数，则重置_events，否则删除对应的事件类型  
              if (--this._eventsCount === 0)  
                this._events = ObjectCreate(null);  
              else  
                delete events[type];  
            }  
            return this;  
          }  
      
          // 说明注册了removeListener事件，arguments.length === 0说明删除所有类型的事件  
          if (arguments.length === 0) {  
            // 逐个删除，除了removeListener事件，这里删除了非removeListener事件  
            for (const key of ObjectKeys(events)) {  
              if (key === 'removeListener') continue;  
              this.removeAllListeners(key);  
            }  
            // 这里删除removeListener事件，见下面的逻辑  
            this.removeAllListeners('removeListener');  
            // 重置数据结构  
            this._events = ObjectCreate(null);  
            this._eventsCount = 0;  
            return this;  
          }  
          // 删除某类型事件  
          const listeners = events[type];  
      
          if (typeof listeners === 'function') {  
            this.removeListener(type, listeners);  
          } else if (listeners !== undefined) {  
            // LIFO order  
            for (let i = listeners.length - 1; i >= 0; i--) {  
              this.removeListener(type, listeners[i]);  
            }  
          }  
      
          return this;  
        }  
```

removeAllListeners函数主要的逻辑有两点，第一个是removeListener事件需要特殊处理，这类似一个钩子，每次用户删除事件处理函数的时候都会触发该事件。第二是removeListener函数。removeListener是真正删除事件处理函数的实现。removeAllListeners是封装了removeListener的逻辑。

```js
    function removeListener(type, listener) {  
       let originalListener;  
       const events = this._events;  
       // 没有东西可删除  
       if (events === undefined)  
         return this;  
      
       const list = events[type];  
       // 同上  
       if (list === undefined)  
         return this;  
       // list是函数说明只有一个处理函数，否则是数组,如果list.listener === listener说明是once注册的  
       if (list === listener || list.listener === listener) {  
         // type类型的处理函数就一个，并且也没有注册其他类型的事件，则初始化_events  
         if (--this._eventsCount === 0)  
           this._events = ObjectCreate(null);  
         else {  
           // 就一个执行完删除type对应的属性  
           delete events[type];  
           // 注册了removeListener事件，则先注册removeListener事件  
           if (events.removeListener)  
             this.emit('removeListener', type, list.listener || listener);  
         }  
       } else if (typeof list !== 'function') {  
         // 多个处理函数  
         let position = -1;  
         // 找出需要删除的函数  
         for (let i = list.length - 1; i >= 0; i--) {  
           if (list[i] === listener || list[i].listener === listener) {  
             // 保存原处理函数，如果有的话  
             originalListener = list[i].listener;  
             position = i;  
             break;  
           }  
         }  
      
         if (position < 0)  
           return this;  
         // 第一个则出队，否则删除一个  
         if (position === 0)  
           list.shift();  
         else {  
           if (spliceOne === undefined)  
             spliceOne = require('internal/util').spliceOne;  
           spliceOne(list, position);  
         }  
         // 如果只剩下一个，则值改成函数类型  
         if (list.length === 1)  
           events[type] = list[0];  
         // 触发removeListener  
         if (events.removeListener !== undefined)  
           this.emit('removeListener', type, originalListener || listener);  
       }  
      
       return this;  
     };  
```

以上就是events模块的核心逻辑，另外还有一些工具函数就不一一分析。
