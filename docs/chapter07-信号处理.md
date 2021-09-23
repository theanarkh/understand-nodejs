## 7.1 信号的概念和实现原理
信号是进程间通信的一种简单的方式，我们首先了解一下信号的概念和在操作系统中的实现原理。在操作系统内核的实现中，每个进程对应一个task_struct结构体（PCB），PCB中有一个字段记录了进程收到的信号（每一个比特代表一种信号）和信号对应的处理函数。这个和订阅者/发布者模式非常相似，我们看一下PCB中信号对应的数据结构。

```cpp
    struct task_struct {  
        // 收到的信号  
        long signal;  
        // 处理信号过程中屏蔽的信息  
        long blocked;  
        // 信号对应的处理函数  
        struct sigaction sigaction[32];  
           ...  
    };  
      
    struct sigaction {  
        // 信号处理函数  
        void (*sa_handler)(int);  
        // 处理信号时屏蔽哪些信息，和PCB的block字段对应  
        sigset_t sa_mask;  
        // 一些标记，比如处理函数只执行一次，类似events模块的once  
        int sa_flags;  
        // 清除调用栈信息，glibc使用  
        void (*sa_restorer)(void);  
    };  
```

Linux下支持多种信号，进程收到信号时，操作系统提供了默认处理，我们也可以显式注册处理信号的函数，但是有些信号会导致进程退出，这是我们无法控制的。我们来看一下在Linux下信号使用的例子。

```cpp
    #include <stdio.h>  
    #include <unistd.h>  
    #include <stdlib.h>  
    #include <signal.h>  
      
    void handler(int);  
      
    int main()  
    {  
       signal(SIGINT, handler);  
       while(1);  
       return(0);  
    }  
      
    void sighandler(int signum)  
    {  
       printf("收到信号%d", signum);  
    }  
```

我们注册了一个信号对应的处理函数，然后进入while循环保证进程不会退出，这时候，如果我们给这个进程发送一个SIGINT信号（ctrl+c或者kill -2 pid）。则进程会执行对应的回调，然后输出：收到信号2。了解了信号的基本原理后，我们看一下Libuv中关于信号的设计和实现。
## 7.2 Libuv信号处理的设计思想
由于操作系统实现的限制，我们无法给一个信号注册多个处理函数，对于同一个信号，如果我们调用操作系统接口多次，后面的就会覆盖前面设置的值。想要实现一个信号被多个函数处理，我们只能在操作系统之上再封装一层，Libuv正是这样做的。Libuv中关于信号处理的封装和订阅者/发布者模式很相似。用户调用Libuv的接口注册信号处理函数，Libuv再向操作系统注册对应的处理函数，等待操作系统收到信号时，会触发Libuv的回调，Libuv的回调会通过管道通知事件循环收到的信号和对应的上下文，接着事件循环在Poll IO阶段就会处理收到所有信号以及对应的处理函数。整体架构如图7-1所示  
![](https://img-blog.csdnimg.cn/0e16d34a94b24fa194ae755589eea7c6.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图7-1

下面我们具体分析Libuv中信号处理的实现。
## 7.3 通信机制的实现
当进程收到信号的时候，信号处理函数需要通知Libuv事件循环，从而在事件循环中执行对应的回调，实现函数是uv__signal_loop_once_init，我们看一下uv__signal_loop_once_init的逻辑。

```cpp
    static int uv__signal_loop_once_init(uv_loop_t* loop) { 
      /* 
            申请一个管道用于和事件循环通信，通知事件循环是否收到信号，
            并设置非阻塞标记  
        */
      uv__make_pipe(loop->signal_pipefd, UV__F_NONBLOCK); 
      /* 
          设置信号IO观察者的处理函数和文件描述符， 
          Libuv在Poll IO时，发现管道读端loop->signal_pipefd[0]可读， 
          则执行uv__signal_event 
        */  
      uv__io_init(&loop->signal_io_watcher,  
                  uv__signal_event,  
                  loop->signal_pipefd[0]);  
      /* 
          插入Libuv的IO观察者队列，并注册感兴趣的事件为可读
        */  
      uv__io_start(loop, &loop->signal_io_watcher, POLLIN);  
      
      return 0; 
    } 
```

uv__signal_loop_once_init首先申请一个管道，用于通知事件循环是否收到信号。然后往Libuv的IO观察者队列注册一个观察者，Libuv在Poll IO阶段会把观察者加到epoll中。IO观察者里保存了管道读端的文件描述符loop->signal_pipefd[0]和回调函数uv__signal_event。uv__signal_event是收到任意信号时的回调，它会继续根据收到的信号进行逻辑分发。执行完的架构如图7-2所示。  
 ![](https://img-blog.csdnimg.cn/a33d83e422374f489c235f81ff7baddf.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图7-2

## 7.4 信号结构体的初始化
Libuv中信号使用uv_signal_t表示。

```cpp
    int uv_signal_init(uv_loop_t* loop, uv_signal_t* handle) { 
      // 申请和Libuv的通信管道并且注册IO观察者  
      uv__signal_loop_once_init(loop);  
      uv__handle_init(loop, (uv_handle_t*) handle, UV_SIGNAL);  
      handle->signum = 0;  
      handle->caught_signals = 0;  
      handle->dispatched_signals = 0;  
      
      return 0;  
    }   
```

上面的代码的逻辑比较简单，只是初始化uv_signal_t结构体的一些字段。
## 7.5 信号处理的注册
我们可以通过uv_signal_start注册一个信号处理函数。我们看看这个函数的逻辑

```cpp
    static int uv__signal_start(uv_signal_t* handle,  
                   uv_signal_cb signal_cb,  
                   int signum,  
                   int oneshot) {  
      sigset_t saved_sigmask;  
      int err;  
      uv_signal_t* first_handle;  
      // 注册过了，重新设置处理函数就行  
      if (signum == handle->signum) {  
        handle->signal_cb = signal_cb;  
        return 0;  
      }  
      // 这个handle之前已经设置了其它信号和处理函数，则先解除  
      if (handle->signum != 0) {  
        uv__signal_stop(handle);  
      }  
      // 屏蔽所有信号  
      uv__signal_block_and_lock(&saved_sigmask);  
      /* 
          查找注册了该信号的第一个handle， 
          优先返回设置了UV_SIGNAL_ONE_SHOT flag的， 
          见compare函数 
        */  
      first_handle = uv__signal_first_handle(signum);  
      /*  
          1 之前没有注册过该信号的处理函数则直接设置 
          2 之前设置过，但是是one shot，但是现在需要 
            设置的规则不是one shot，需要修改。否则第 
            二次不会不会触发。因为一个信号只能对应一 
            个信号处理函数，所以，以规则宽的为准，在回调 
            里再根据flags判断是不是真的需要执行 
          3 如果注册过信号和处理函数，则直接插入红黑树就行。 
        */    
        if (  
             first_handle == NULL ||  
         (!oneshot && (first_handle->flags & UV_SIGNAL_ONE_SHOT)) 
        ) {  
        // 注册信号和处理函数  
        err = uv__signal_register_handler(signum, oneshot);  
        if (err) {  
          uv__signal_unlock_and_unblock(&saved_sigmask);  
          return err;  
        }  
      }  
      // 记录感兴趣的信号  
      handle->signum = signum;  
      // 只处理该信号一次  
      if (oneshot)  
        handle->flags |= UV_SIGNAL_ONE_SHOT;  
      // 插入红黑树  
      RB_INSERT(uv__signal_tree_s, &uv__signal_tree, handle);  
      uv__signal_unlock_and_unblock(&saved_sigmask); 
      // 信号触发时的业务层回调  
        handle->signal_cb = signal_cb;  
      uv__handle_start(handle);  
      
      return 0;  
    } 
```

 
上面的代码比较多，大致的逻辑如下. 
1 判断是否需要向操作系统注册一个信号的处理函数。主要是调用操作系统的函数来处理的，代码如下  

```cpp
    // 给当前进程注册信号处理函数，会覆盖之前设置的signum的处理函数  
    static int uv__signal_register_handler(int signum, int oneshot) {
      struct sigaction sa;  
      
      memset(&sa, 0, sizeof(sa));  
      // 全置一，说明收到signum信号的时候，暂时屏蔽其它信号  
      if (sigfillset(&sa.sa_mask))  
          abort();  
      // 所有信号都由该函数处理  
      sa.sa_handler = uv__signal_handler;  
      sa.sa_flags = SA_RESTART;  
      // 设置了oneshot，说明信号处理函数只执行一次，然后被恢复为系统的默认处理函数  
      if (oneshot)  
        sa.sa_flags |= SA_RESETHAND;  
      
      // 注册  
      if (sigaction(signum, &sa, NULL))  
        return UV__ERR(errno);  
      
      return 0;  
    }  
```

我们看到所有信号的处理函数都是uv__signal_handler，我们一会会分析uv__signal_handler的实现。  
2进程注册的信号和回调是在一棵红黑树管理的，每次注册的时候会往红黑树插入一个节点。Libuv用黑红树维护信号的上下文，插入的规则是根据信号的大小和flags等信息。
RB_INSERT实现了往红黑树插入一个节点，红黑树中的节点是父节点的值比左孩子大，比右孩子小的。执行完RB_INSERT后的架构如图7-3所示。  
![](https://img-blog.csdnimg.cn/f986e8efd698465e8a5fa7cd384d25e5.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图7-3

我们看到，当我们每次插入不同的信号的时候，Libuv会在操作系统和红黑树中修改对应的数据结构。那么如果我们插入重复的信号呢？刚才我们已经分析过，插入重复的信号时，如果在操作系统注册过，并且当前插入的信号flags是one shot，而之前是非one shot时，Libuv会调用操作系统的接口去修改配置。那么对于红黑树来说，插入重复信号会如何处理呢？从刚才RB_INSERT的代码中我们看到每次插入红黑树时，红黑树会先判断是否存在相同值的节点，如果是的话直接返回，不进行插入。这么看起来我们无法给一个信号注册多个处理函数，但其实是可以的，重点在比较大小的函数。我们看看该函数的实现。

```cpp
    static int uv__signal_compare(uv_signal_t* w1, uv_signal_t* w2) {  
      int f1;  
      int f2;  
       
      // 返回信号值大的  
      if (w1->signum < w2->signum) return -1;  
      if (w1->signum > w2->signum) return 1;  
      
      // 设置了UV_SIGNAL_ONE_SHOT的大  
      f1 = w1->flags & UV_SIGNAL_ONE_SHOT;  
      f2 = w2->flags & UV_SIGNAL_ONE_SHOT;  
      if (f1 < f2) return -1;  
      if (f1 > f2) return 1;  
      
      // 地址大的值就大  
      if (w1->loop < w2->loop) return -1;  
      if (w1->loop > w2->loop) return 1;  
      
      if (w1 < w2) return -1;  
      if (w1 > w2) return 1;  
      
      return 0;  
    }  
```

我们看到Libuv比较的不仅是信号的大小，在信号一样的情况下，Libuv还会比较其它的因子，除非两个uv_signal_t指针指向的是同一个uv_signal_t结构体，否则它们是不会被认为重复的，所以红黑树中会存着信号一样的节点。假设我们按照1（flags为one shot），2（flags为非one shot）,3（flags为one shot）的顺序插入红黑树，并且节点3比节点1的地址大。所形成的结构如图7-4所示。  
![](https://img-blog.csdnimg.cn/e33fe52207444c97a7b2c950d6f5cb6f.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图7-4

## 7.6 信号的处理
我们上一节已经分析过，不管注册什么信号，它的处理函数都是这个uv__signal_handler函数。我们自己的业务回调函数，是保存在handle里的。而Libuv维护了一棵红黑树，记录了每个handle注册的信号和回调函数，那么当任意信号到来的时候。uv__signal_handler就会被调用。下面我们看看uv__signal_handler函数。

```cpp
    /* 
      信号处理函数，signum为收到的信号， 
      每个子进程收到信号的时候都由该函数处理， 
      然后通过管道通知Libuv 
    */  
    static void uv__signal_handler(int signum) {  
      uv__signal_msg_t msg;  
      uv_signal_t* handle;  
      int saved_errno;  
      // 保持上一个系统调用的错误码  
      saved_errno = errno;  
      memset(&msg, 0, sizeof msg);  
      
      if (uv__signal_lock()) {  
        errno = saved_errno;  
        return;  
      }  
      // 找到该信号对应的所有handle
      for (handle = uv__signal_first_handle(signum);  
           handle != NULL && handle->signum == signum;  
           handle = RB_NEXT(uv__signal_tree_s,
                                     &uv__signal_tree, 
                                     handle)) 
       {  
        int r;  
            // 记录上下文
        msg.signum = signum;  
        msg.handle = handle;  
        do {  
          // 通知Libuv，哪些handle需要处理该信号，
                 在Poll IO阶段处理  
          r = write(handle->loop->signal_pipefd[1], 
                            &msg, 
                            sizeof msg);  
        } while (r == -1 && errno == EINTR);  
        // 该handle收到信号的次数  
        if (r != -1)  
          handle->caught_signals++;  
      }  
      
      uv__signal_unlock();  
      errno = saved_errno;  
    }  
```

uv__signal_handler函数会调用uv__signal_first_handle遍历红黑树，找到注册了该信号的所有handle，我们看一下uv__signal_first_handle的实现。

```cpp
    static uv_signal_t* uv__signal_first_handle(int signum) {  
      uv_signal_t lookup;  
      uv_signal_t* handle;  
      
      lookup.signum = signum;  
      lookup.flags = 0;  
      lookup.loop = NULL;  
      
      handle = RB_NFIND(uv__signal_tree_s, 
                         &uv__signal_tree, 
                         &lookup);  
      
      if (handle != NULL && handle->signum == signum)  
        return handle;  
      return NULL;  
    }  
```

uv__signal_first_handle函数通过RB_NFIND实现红黑树的查找，RB_NFIND是一个宏。

```cpp
    #define RB_NFIND(name, x, y)    name##_RB_NFIND(x, y)  
```

我们看看name##_RB_NFIND即uv__signal_tree_s_RB_NFIND的实现

```cpp
    static struct uv_signal_t * uv__signal_tree_s_RB_NFIND(struct uv__signal_tree_s *head, struct uv_signal_t *elm)                            
    {                                    
      struct uv_signal_t *tmp = RB_ROOT(head);    
      struct uv_signal_t *res = NULL;    
      int comp;              
      while (tmp) {    
        comp = cmp(elm, tmp);     
         /* 
           elm小于当前节点则往左子树找，大于则往右子树找，
          等于则返回           
         */
        if (comp < 0) {            
          // 记录父节点
          res = tmp;  
          tmp = RB_LEFT(tmp, field);    
        }           
        else if (comp > 0)    
          tmp = RB_RIGHT(tmp, field); 
        else         
          return (tmp);  
      }             
      return (res); 
    }     
```

uv__signal_tree_s_RB_NFIND的逻辑就是根据红黑树的特点进行搜索，这里的重点是cmp函数。刚才我们已经分析过cmp的逻辑。这里会首先查找没有设置one shot标记的handle（因为它的值小），然后再查找设置了one shot的handle，一旦遇到设置了one shot的handle，则说明后面被匹配的handle也是设置了one shot标记的。每次找到一个handle，就会封装一个msg写入管道（即和Libuv通信的管道）。信号的处理就完成了。接下来在Libuv的Poll IO阶段才做真正的处理。我们知道在Poll IO阶段。epoll会检测到管道loop->signal_pipefd[0]可读，然后会执行uv__signal_event函数。我们看看这个函数的代码。

```cpp
    // 如果收到信号,Libuv Poll IO阶段,会执行该函数  
    static void uv__signal_event(uv_loop_t* loop, uv__io_t* w, 
    unsigned int events) {  
      uv__signal_msg_t* msg;  
      uv_signal_t* handle;  
      char buf[sizeof(uv__signal_msg_t) * 32];  
      size_t bytes, end, i;  
      int r;  
      
      bytes = 0;  
      end = 0;  
      // 计算出数据的大小
      do {  
        // 读出所有的uv__signal_msg_t  
        r = read(loop->signal_pipefd[0], 
                       buf + bytes, 
                       sizeof(buf) - bytes);  
        if (r == -1 && errno == EINTR)  
          continue;  
        if (r == -1 && 
                (errno == EAGAIN || 
                 errno == EWOULDBLOCK)) {  
          if (bytes > 0)  
            continue;  
          return;  
        }  
        if (r == -1)  
          abort();  
        bytes += r;  
        /*
              根据收到的字节数算出有多少个uv__signal_msg_t结构体，
              从而算出结束位置
            */ 
        end=(bytes/sizeof(uv__signal_msg_t))*sizeof(uv__signal_msg_t);
          // 循环处理每一个msg
        for (i = 0; i < end; i += sizeof(uv__signal_msg_t)) {
          msg = (uv__signal_msg_t*) (buf + i); 
                // 取出上下文 
          handle = msg->handle;  
          // 收到的信号和handle感兴趣的信号一致，执行回调  
          if (msg->signum == handle->signum) {    
            handle->signal_cb(handle, handle->signum);  
          }  
          // 处理信号个数，和收到的个数对应  
          handle->dispatched_signals++;  
          // 只执行一次，恢复系统默认的处理函数  
          if (handle->flags & UV_SIGNAL_ONE_SHOT)  
            uv__signal_stop(handle);  
          /* 
                  处理完所有收到的信号才能关闭uv_signal_t，
                  见uv_close或uv__signal_close 
                */ 
          if ((handle->flags & UV_HANDLE_CLOSING) &&  
            (handle->caught_signals==handle->dispatched_signals))          
               {  
            uv__make_close_pending((uv_handle_t*) handle);  
          }  
        }  
        bytes -= end; 
        if (bytes) {  
          memmove(buf, buf + end, bytes);  
          continue;  
        }  
      } while (end == sizeof buf);  
    }  
```

uv__signal_event函数的逻辑如下  
1 读出管道里的数据，计算出msg的个数。  
2 遍历收到的数据，解析出一个个msg。  
3 从msg中取出上下文（handle和信号），执行上层回调。  
4 如果handle设置了one shot则需要执行uv__signal_stop（我们接下来分析）。  
5 如果handle设置了closing标记，则判断所有收到的信号是否已经处理完。即收到的个数和处理的个数是否一致。需要处理完所有收到的信号才能关闭uv_signal_t。

## 7.7 取消/关闭信号处理
当一个信号对应的handle设置了one shot标记，在收到信号并且执行完回调后，Libuv会调用uv__signal_stop关闭该handle并且从红黑树中移除该handle。另外我们也可以显式地调用uv_close（会调用uv__signal_stop）关闭或取消信号的处理。下面我们看看uv__signal_stop的实现。

```cpp
    static void uv__signal_stop(uv_signal_t* handle) {  
      uv_signal_t* removed_handle;  
      sigset_t saved_sigmask;  
      uv_signal_t* first_handle;  
      int rem_oneshot;  
      int first_oneshot;  
      int ret;  
      
      /* If the watcher wasn't started, this is a no-op. */  
      // 没有注册过信号，则不需要处理  
      if (handle->signum == 0)  
        return;  
      // 屏蔽所有信号  
      uv__signal_block_and_lock(&saved_sigmask);  
      // 移出红黑树  
      removed_handle = RB_REMOVE(uv__signal_tree_s, &uv__signal_tree, handle);  
      // 判断该信号是否还有对应的handle  
      first_handle = uv__signal_first_handle(handle->signum);  
      // 为空说明没有handle会处理该信号了，解除该信号的设置  
      if (first_handle == NULL) {  
        uv__signal_unregister_handler(handle->signum);  
      } else {  
        // 被处理的handle是否设置了one shot  
        rem_oneshot = handle->flags & UV_SIGNAL_ONE_SHOT;  
        /*
          剩下的第一个handle是否设置了one shot，
          如果是则说明该信号对应的所有剩下的handle都是one shot  
        */ 
        first_oneshot = first_handle->flags & UV_SIGNAL_ONE_SHOT;  
        /* 
          被移除的handle没有设置oneshot但是当前的第一个handle设置了
           one shot，则需要修改该信号处理函数为one shot，防止收到多次信
           号，执行多次回调 
        */  
        if (first_oneshot && !rem_oneshot) {  
          ret = uv__signal_register_handler(handle->signum, 1);  
          assert(ret == 0);  
        }  
      }  
      
      uv__signal_unlock_and_unblock(&saved_sigmask);  
      
      handle->signum = 0;  
      uv__handle_stop(handle);  
    }  
```

## 7.8 信号在Node.js中的使用
分析完Libuv的实现后，我们看看Node.js上层是如何使用信号的，首先我们看一下C++层关于信号模块的实现。

```cpp
    static void Initialize(Local<Object> target,  
                             Local<Value> unused,  
                             Local<Context> context,  
                             void* priv) {  
        Environment* env = Environment::GetCurrent(context);  
        Local<FunctionTemplate> constructor = env->NewFunctionTemplate(New);  
        constructor->InstanceTemplate()->SetInternalFieldCount(1);  
        // 导出的类名  
        Local<String> signalString =  
            FIXED_ONE_BYTE_STRING(env->isolate(), "Signal");  
        constructor->SetClassName(signalString);  
        constructor->Inherit(HandleWrap::GetConstructorTemplate(env));  
        // 给Signal创建的对象注入两个函数  
        env->SetProtoMethod(constructor, "start", Start);  
        env->SetProtoMethod(constructor, "stop", Stop);  
      
        target->Set(env->context(), signalString,  
                    constructor->GetFunction(env->context()).ToLocalChecked()).Check();  
      }  
```

当我们在JS中new Signal的时候，首先会创建一个C++对象，然后作为入参执行New函数。

```cpp
    static void New(const FunctionCallbackInfo<Value>& args) {  
        CHECK(args.IsConstructCall());  
        Environment* env = Environment::GetCurrent(args);  
        new SignalWrap(env, args.This());  
    }  
```

当我们在JS层操作Signal实例的时候，就会执行C++层对应的方法。主要的方法是注册和删除信号。

```cpp
    static void Start(const FunctionCallbackInfo<Value>& args) {  
        SignalWrap* wrap;  
        ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
        Environment* env = wrap->env();  
        int signum;  
        if (!args[0]->Int32Value(env->context()).To(&signum)) return;  
        int err = uv_signal_start(  
            &wrap->handle_,  
            // 信号产生时执行的回调  
            [](uv_signal_t* handle, int signum) {  
              SignalWrap* wrap = ContainerOf(&SignalWrap::handle_, 
                                                 handle);  
              Environment* env = wrap->env();  
              HandleScope handle_scope(env->isolate());  
              Context::Scope context_scope(env->context());  
              Local<Value> arg = Integer::New(env->isolate(), 
                                                  signum);  
              // 触发JS层onsignal函数  
              wrap->MakeCallback(env->onsignal_string(), 1, &arg);  
            },  
            signum);  
      
        if (err == 0) {  
          CHECK(!wrap->active_);  
          wrap->active_ = true;  
          Mutex::ScopedLock lock(handled_signals_mutex);  
          handled_signals[signum]++;  
        }  
      
        args.GetReturnValue().Set(err);  
      }  
    
      static void Stop(const FunctionCallbackInfo<Value>& args) {
        SignalWrap* wrap;
        ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());
    
        if (wrap->active_)  {
          wrap->active_ = false;
          DecreaseSignalHandlerCount(wrap->handle_.signum);
        }
    
        int err = uv_signal_stop(&wrap->handle_);
        args.GetReturnValue().Set(err);
      }
```

接着我们看在JS层如何使用。Node.js在初始化的时候，在is_main_thread.js中执行了。

```js
    process.on('newListener', startListeningIfSignal);  
    process.on('removeListener', stopListeningIfSignal)  
```

newListener和removeListener事件在注册和删除事件的时候都会被触发。我们看一下这两个函数的实现

```js
    /* 
     { 
      SIGINT: 2, 
      ... 
     } 
    */  
    const { signals } = internalBinding('constants').os;  
      
    let Signal;  
    const signalWraps = new Map();  
      
    function isSignal(event) {  
      return typeof event === 'string' && signals[event] !== undefined;  
    }  
      
    function startListeningIfSignal(type) {  
      if (isSignal(type) && !signalWraps.has(type)) {  
        if (Signal === undefined)  
          Signal = internalBinding('signal_wrap').Signal;  
        const wrap = new Signal();  
        // 不影响事件循环的退出  
        wrap.unref();  
        // 挂载信号处理函数  
        wrap.onsignal = process.emit.bind(process, type, type);  
        // 通过字符拿到数字  
        const signum = signals[type];  
        // 注册信号  
        const err = wrap.start(signum);  
        if (err) {  
          wrap.close();  
          throw errnoException(err, 'uv_signal_start');  
        }  
        // 该信号已经注册，不需要往底层再注册了  
        signalWraps.set(type, wrap);  
      }  
    }  
```

startListeningIfSignal函数的逻辑分为一下几个
1 判断该信号是否注册过了，如果注册过了则不需要再注册。Libuv本身支持在同一个信号上注册多个处理函数，Node.js的JS层也做了这个处理。
2 调用unref，信号的注册不应该影响事件循环的退出
3 挂载事件处理函数，当信号触发的时候，执行对应的处理函数（一个或多个）。
4 往底层注册信号并设置该信号已经注册的标记
我们再来看一下stopListeningIfSignal。

```js
    function stopListeningIfSignal(type) {  
      const wrap = signalWraps.get(type);  
      if (wrap !== undefined && process.listenerCount(type) === 0) { 
        wrap.close();  
        signalWraps.delete(type);  
      }  
    }  
```

只有当信号被注册过并且事件处理函数个数为0，才做真正的删除。
