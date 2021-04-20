# 第二章Libuv数据结构和通用逻辑
## 2.1 核心结构体uv_loop_s
uv_loop_s是Libuv的核心数据结构，每一个事件循环对应一个uv_loop_s结构体。它记录了整个事件循环中的核心数据。我们来分析每一个字段的意义。

```cpp
1 用户自定义数据的字段
void* data;

2活跃的handle个数，会影响使用循环的退出
unsigned int active_handles;

3 handle队列，包括活跃和非活跃的
void* handle_queue[2]; 

4 request个数，会影响事件循环的退出
union { void* unused[2];  unsigned int count; } active_reqs;

5事件循环是否结束的标记
unsigned int stop_flag;

6 Libuv运行的一些标记，目前只有UV_LOOP_BLOCK_SIGPROF，主要是用于epoll_wait的时候屏蔽SIGPROF信号，提高性能，SIGPROF是调操作系统settimer函数设置从而触发的信号
unsigned long flags; 

7 epoll的fd
int backend_fd;                    
   
8 pending阶段的队列                   
void* pending_queue[2];          
           
9指向需要在epoll中注册事件的uv__io_t结构体队列            
void* watcher_queue[2];      

10 watcher_queue队列的节点中有一个fd字段，watchers以fd为索引，记录fd所在的uv__io_t结构体                       
uv__io_t** watchers;               

11 watchers相关的数量，在maybe_resize函数里设置
unsigned int nwatchers;

12 watchers里fd个数，一般为watcher_queue队列的节点数
unsigned int nfds;      

13线程池的子线程处理完任务后把对应的结构体插入到wq队列        
void* wq[2];               

14控制wq队列互斥访问，否则多个子线程同时访问会有问题
uv_mutex_t wq_mutex;

15用于线程池的子线程和主线程通信    
uv_async_t wq_async;   

16用于读写锁的互斥变量
uv_rwlock_t cloexec_lock;  

17 事件循环close阶段的队列，由uv_close产生
uv_handle_t* closing_handles;       

18 fork出来的进程队列                 
void* process_handles[2];    
           
19 事件循环的prepare阶段对应的任务队列                   
void* prepare_handles[2];        
            
20 事件循环的check阶段对应的任务队列              
void* check_handles[2];        

21 事件循环的idle阶段对应的任务队列
void* idle_handles[2];  

21 async_handles队列，Poll IO阶段执行uv__async_io中遍历async_handles队列处理里面pending为1的节点
void* async_handles[2];         

22用于监听是否有async handle任务需要处理
uv__io_t async_io_watcher;  

23用于保存子线程和主线程通信的写端fd                    
int async_wfd;   

24保存定时器二叉堆结构       
struct {
void* min; 
unsigned int nelts;
} timer_heap; 
       
25 管理定时器节点的id，不断叠加
uint64_t timer_counter;      
  
26当前时间，Libuv会在每次事件循环的开始和Poll IO阶段更新当前时间，然后在后续的各个阶段使用，减少对系统调用                      
uint64_t time; 
  
27用于fork出来的进程和主进程通信的管道，用于子进程收到信号的时候通知主进程，然后主进程执行子进程节点注册的回调
int signal_pipefd[2];                 

28类似async_io_watcher，signal_io_watcher保存了管道读端fd和回调，然后注册到epoll中，在子进程收到信号的时候，通过write写到管道，最后在Poll IO阶段执行回调
uv__io_t signal_io_watcher;
29 用于管理子进程退出信号的handle
uv_signal_t child_watcher;  
  
30备用的fd       
int emfile_fd;   
```

 
## 2.2 uv_handle_t
在Libuv中，uv_handle_t类似C++中的基类，有很多子类继承于它，Libuv主要通过控制内存的布局得到继承的效果。handle代表生命周期比较长的对象。例如
>1 一个处于active状态的prepare handle，它的回调会在每次事件循环化的时候被执行。
2 一个TCP handle在每次有连接到来时，执行它的回调。

我们看一下uv_handle_t的定义

```cpp
1 自定义数据，用于关联一些上下文,Node.js中用于关联handle所属的C++对象  
void* data;  
     
2 所属的事件循环     
uv_loop_t* loop;
   
3 handle类型   
uv_handle_type type;
  
4 handle调用uv_close后，在closing阶段被执行的回调
uv_close_cb close_cb; 

5 用于组织handle队列的前置后置指针
void* handle_queue[2];

6 文件描述符 
union {               
int fd;             
 void* reserved[4];  
} u;  

7 当handle在close队列时，该字段指向下一个close节点     
uv_handle_t* next_closing; 
 
8 handle的状态和标记
unsigned int flags;
```

### 2.2.1 uv_stream_s
uv_stream_s是表示流的结构体。除了继承uv_handle_t的字段外，它额外定义下面字段

```cpp
1 等待发送的字节数
size_t write_queue_size;
         
2 分配内存的函数       
uv_alloc_cb alloc_cb; 
       
3 读取数据成功时执行的回调            
uv_read_cb read_cb; 

4 发起连接对应的结构体
uv_connect_t *connect_req; 
    
5 关闭写端对应的结构体
uv_shutdown_t *shutdown_req;   

6 用于插入epoll，注册读写事件
uv__io_t io_watcher;           

7 待发送队列
void* write_queue[2];     

8 发送完成的队列     
void* write_completed_queue[2];

9 收到连接时执行的回调
uv_connection_cb connection_cb;

10 socket操作失败的错误码
int delayed_error;             

11 accept返回的fd
int accepted_fd;               

12 已经accept了一个fd，又有新的fd，暂存起来
void* queued_fds;
```

### 2.2.2 uv_async_s
uv_async_s是Libuv中实现异步通信的结构体。继承于uv_handle_t，并额外定义了以下字段。

```cpp
1 异步事件触发时执行的回调
uv_async_cb async_cb; 

2 用于插入async-handles队列
void* queue[2]; 

3 async_handles队列中的节点pending字段为1说明对应的事件触发了
int pending;  
```

### 2.2.3 uv_tcp_s
uv_tcp_s继承uv_handle_s和uv_stream_s。
### 2.2.4 uv_udp_s

```cpp
1 发送字节数
size_t send_queue_size;

2 写队列节点的个数
size_t send_queue_count;

3 分配接收数据的内存
uv_alloc_cb alloc_cb;  

4 接收完数据后执行的回调
uv_udp_recv_cb recv_cb;

5 插入epoll里的IO观察者，实现数据读写
uv__io_t io_watcher;   
6 待发送队列
void* write_queue[2];  

7 发送完成的队列（发送成功或失败），和待发送队列相关
void* write_completed_queue[2];  
```

### 2.2.5 uv_tty_s
uv_tty_s继承于uv_handle_t和uv_stream_t。额外定义了下面字段。

```cpp
1 终端的参数 
struct termios orig_termios; 

2 终端的工作模式
int mode;
```

### 2.2.6 uv_pipe_s 
uv_pipe_s继承于uv_handle_t和uv_stream_t。额外定义了下面字段。

```cpp
1 标记管道是否可用于传递文件描述符
int ipc; 

2 用于Unix域通信的文件路径
const char* pipe_fname; 
```

### 2.2.7 uv_prepare_s、uv_check_s、uv_idle_s
上面三个结构体定义是类似的，它们都继承uv_handle_t，额外定义了两个字段。

```cpp
1 prepare、check、idle阶段回调
uv_xxx_cb xxx_cb; 

2 用于插入prepare、check、idle队列
void* queue[2];   
```

### 2.2.8 uv_timer_s
uv_timer_s继承uv_handle_t，额外定义了下面几个字段。

```cpp
1 超时回调 
uv_timer_cb timer_cb; 

2 插入二叉堆的字段
void* heap_node[3];

3 超时时间
uint64_t timeout; 

4 超时后是否继续开始重新计时，是的话重新插入二叉堆
uint64_t repeat; 

5 id标记，用于插入二叉堆的时候对比
uint64_t start_id
```

### 2.2.9 uv_process_s
uv_process_s继承uv_handle_t，额外定义了

```cpp
1 进程退出时执行的回调
uv_exit_cb exit_cb;

2 进程id
int pid;

3 用于插入队列，进程队列或者pending队列
void* queue[2];

4 退出码，进程退出时设置
int status;  
```

### 2.2.10 uv_fs_event_s
uv_fs_event_s用于监听文件改动。uv_fs_event_s继承uv_handle_t，额外定义了

```cpp
1 监听的文件路径(文件或目录)
char* path;

2 文件改变时执行的回调
uv_fs_event_cb cb;
```

### 2.2.11 uv_fs_poll_s
uv_fs_poll_s继承uv_handle_t，额外定义了

```cpp
1 poll_ctx指向poll_ctx结构体
void* poll_ctx;

struct poll_ctx {
// 对应的handle
uv_fs_poll_t* parent_handle; 
// 标记是否开始轮询和轮询时的失败原因
int busy_polling;
// 多久检测一次文件内容是否改变
unsigned int interval;
// 每一轮轮询时的开始时间
uint64_t start_time;
// 所属事件循环
uv_loop_t* loop;
// 文件改变时回调
uv_fs_poll_cb poll_cb;
// 定时器，用于定时超时后轮询
uv_timer_t timer_handle;
// 记录轮询的一下上下文信息，文件路径、回调等
uv_fs_t fs_req; 
// 轮询时保存操作系统返回的文件信息
uv_stat_t statbuf;
 // 监听的文件路径，字符串的值追加在结构体后面
char path[1]; /* variable length */
};
```

### 2.2.12 uv_poll_s
uv_poll_s继承于uv_handle_t，额外定义了下面字段。

```cpp
1 监听的fd有感兴趣的事件时执行的回调
uv_poll_cb poll_cb;

2 保存了fd和回调的IO观察者，注册到epoll中
uv__io_t io_watcher;
```

### 2.1.13 uv_signal_s
uv_signal_s继承uv_handle_t，额外定义了以下字段

```cpp
1 收到信号时的回调
uv_signal_cb signal_cb;

2 注册的信号
int signum;

3 用于插入红黑树，进程把感兴趣的信号和回调封装成uv_signal_s，然后插入到红黑树，信号到来时，进程在信号处理号中把通知写入管道，通知Libuv。Libuv在Poll IO阶段会执行进程对应的回调。红黑树节点的定义如下
struct {                         
struct uv_signal_s* rbe_left;  
struct uv_signal_s* rbe_right; 
struct uv_signal_s* rbe_parent;
int rbe_color;                 
} tree_entry; 

4 收到的信号个数
unsigned int caught_signals;     

5 已经处理的信号个数
unsigned int dispatched_signals;
```

## 2.3 uv_req_s
在Libuv中，uv_req_s也类似C++基类的作用，有很多子类继承于它，request代表一次请求，比如读写一个文件，读写socket，查询DNS。任务完成后这个request就结束了。request可以和handle结合使用，比如在一个TCP服务器上（handle）写一个数据（request），也可以单独使用一个request，比如DNS查询或者文件读写。我们看一下uv_req_s的定义。

```cpp
1 自定义数据
void* data; 
 
2 request类型
uv_req_type type;  
 
3 保留字段 
void* reserved[6];
```

### 2.3.1 uv_shutdown_s
uv_shutdown_s用于关闭流的写端，额外定义的字段

```cpp
1 要关闭的流，比如TCP
uv_stream_t* handle;

2 关闭流的写端后执行的回调
uv_shutdown_cb cb;
```

### 2.3.2 uv_write_s
uv_write_s表示一次写请求，比如在TCP流上发送数据，额外定义的字段

```cpp
1 写完后的回调
uv_write_cb cb;

2 需要传递的文件描述符，在send_handle中
uv_stream_t* send_handle; 

3 关联的handle
uv_stream_t* handle;

4 用于插入队列
void* queue[2];     

5 保存需要写的数据相关的字段（写入的buffer个数，当前写成功的位置等）     
unsigned int write_index;
uv_buf_t* bufs;          
unsigned int nbufs;                 
uv_buf_t bufsml[4];

6 写出错的错误码 
int error;    
```

### 2.3.3 uv_connect_s
uv_connect_s表示发起连接请求，比如TCP连接，额外定义的字段

```cpp
1 连接成功后执行的回调
uv_connect_cb cb;

2 对应的流，比如tcp
uv_stream_t* handle;

3 用于插入队列
void* queue[2]; 
```

### 2.3.4 uv_udp_send_s
uv_udp_send_s表示一次发送UDP数据的请求

```cpp
1 所属udp的handle，udp_send_s代表一次发送
uv_udp_t* handle;

2 回调
uv_udp_send_cb cb;

3 用于插入待发送队列
void* queue[2];              

4 发送的目的地址
struct sockaddr_storage addr;

5 保存了发送数据的缓冲区和个数
unsigned int nbufs;           
uv_buf_t* bufs;               
uv_buf_t bufsml[4];

6 发送状态或成功发送的字节数
ssize_t status;              

7 发送完执行的回调（发送成功或失败）
uv_udp_send_cb send_cb;  
```

  
### 2.3.5 uv_getaddrinfo_s
uv_getaddrinfo_s表示一次通过域名查询IP的DNS请求，额外定义的字段

```cpp
1 所属事件循环
uv_loop_t* loop;

2 用于异步DNS解析时插入线程池任务队列的节点
struct uv__work work_req; 

3 DNS解析完后执行的回调
uv_getaddrinfo_cb cb;     

4 DNS查询的配置
struct addrinfo* hints;   
char* hostname;           
char* service;         

5 DNS解析结果   
struct addrinfo* addrinfo;

6 DNS解析的返回码
int retcode;
```

### 2.3.6 uv_getnameinfo_s
uv_getnameinfo_s表示一次通过IP查询域名的DNS查询请求，额外定义的字段

```cpp
1 所属事件循环 
uv_loop_t* loop;

2 用于异步DNS解析时插入线程池任务队列的节点
struct uv__work work_req;        

3 socket转域名完成的回调
uv_getnameinfo_cb getnameinfo_cb;

4 需要转域名的socket结构体
struct sockaddr_storage storage; 

5 指示查询返回的信息
int flags;                       

6 查询返回的信息
char host[NI_MAXHOST];           
char service[NI_MAXSERV];        

7 查询返回码
int retcode;
```

### 2.3.7 uv_work_s
uv_work_s用于往线程池提交任务，额外定义的字段

```cpp
1 所属事件循环
uv_loop_t* loop;

2 处理任务的函数
uv_work_cb work_cb;

3 处理完任务后执行的函数
uv_after_work_cb after_work_cb;

4封装一个work插入到线程池队列，work_req的work和done函数是对上面work_cb和after_work_cb的封装
struct uv__work work_req;
```

### uv_fs_s
uv_fs_s表示一次文件操作请求，额外定义的字段

```cpp
1 文件操作类型
uv_fs_type fs_type;

2 所属事件循环
uv_loop_t* loop;

3文件操作完成的回调
uv_fs_cb cb;

4 文件操作的返回码
ssize_t result;

5 文件操作返回的数据
void* ptr;

6 文件操作路径
const char* path;

7 文件的stat信息
uv_stat_t statbuf;  

8 文件操作涉及到两个路径时，保存目的路径
const char *new_path;    

9 文件描述符
uv_file file;            

10 文件标记
int flags;               

11 操作模式
mode_t mode;      

12 写文件时传入的数据和个数       
unsigned int nbufs;      
uv_buf_t* bufs;          

13 文件偏移
off_t off;               

14 保存需要设置的uid和gid，例如chmod的时候
uv_uid_t uid;            
uv_gid_t gid;            

15 保存需要设置的文件修改、访问时间，例如fs.utimes的时候
double atime;            
double mtime;            

16 异步的时候用于插入任务队列，保存工作函数，回调函数
struct uv__work work_req;

17 保存读取数据或者长度。例如read和sendfile
uv_buf_t bufsml[4];  
```

## 2.4 IO观察者
IO观察者是Libuv中的核心概念和数据结构。我们看一下它的定义

```cpp
1.	struct uv__io_s {  
2.	  // 事件触发后的回调  
3.	  uv__io_cb cb;  
4.	  // 用于插入队列  
5.	  void* pending_queue[2];  
6.	  void* watcher_queue[2];  
7.	  // 保存本次感兴趣的事件，在插入IO观察者队列时设置  
8.	  unsigned int pevents; 
9.	  // 保存当前感兴趣的事件  
10.	  unsigned int events;   
11.	  int fd;  
12.	};  
```

IO观察者封装了文件描述符、事件和回调，然后插入到loop维护的IO观察者队列，在Poll IO阶段，Libuv会根据IO观察者描述的信息，往底层的事件驱动模块注册文件描述符感兴趣的事件。当注册的事件触发的时候，IO观察者的回调就会被执行。我们看如何初IO观察者的一些逻辑。
### 2.4.1 初始化IO观察者

```cpp
1.	void uv__io_init(uv__io_t* w, uv__io_cb cb, int fd) {  
2.	  // 初始化队列，回调，需要监听的fd  
3.	  QUEUE_INIT(&w->pending_queue);  
4.	  QUEUE_INIT(&w->watcher_queue);  
5.	  w->cb = cb;  
6.	  w->fd = fd;  
7.	  // 上次加入epoll时感兴趣的事件，在执行完epoll操作函数后设置  
8.	  w->events = 0;  
9.	  // 当前感兴趣的事件，在再次执行epoll函数之前设置  
10.	  w->pevents = 0;  
11.	}  
```

### 2.4.2注册一个IO观察者到Libuv。

```cpp
1.	void uv__io_start(uv_loop_t* loop, uv__io_t* w, unsigned int events) {  
2.	  // 设置当前感兴趣的事件  
3.	  w->pevents |= events;  
4.	  // 可能需要扩容  
5.	  maybe_resize(loop, w->fd + 1); 
6.	    // 事件没有变化则直接返回 
7.	  if (w->events == w->pevents)  
8.	    return;  
9.	  // IO观察者没有挂载在其它地方则插入Libuv的IO观察者队列  
10.	  if (QUEUE_EMPTY(&w->watcher_queue))  
11.	    QUEUE_INSERT_TAIL(&loop->watcher_queue, &w->watcher_queue);  
12.	  // 保存映射关系  
13.	  if (loop->watchers[w->fd] == NULL) {  
14.	    loop->watchers[w->fd] = w;  
15.	    loop->nfds++;  
16.	  }  
17.	}  
```

uv__io_start函数就是把一个IO观察者插入到Libuv的观察者队列中，并且在watchers数组中保存一个映射关系。Libuv在Poll IO阶段会处理IO观察者队列。

### 2.4.3 撤销IO观察者或者事件
uv__io_stop修改IO观察者感兴趣的事件，如果还有感兴趣的事件的话，IO观察者还会在队列里，否则移出

```cpp
1.	void uv__io_stop(uv_loop_t* loop, 
2.	                  uv__io_t* w, 
3.	                  unsigned int events) {  
4.	  if (w->fd == -1)  
5.	    return;  
6.	  assert(w->fd >= 0);  
7.	  if ((unsigned) w->fd >= loop->nwatchers)  
8.	    return;  
9.	  // 清除之前注册的事件，保存在pevents里，表示当前感兴趣的事件  
10.	  w->pevents &= ~events;  
11.	  // 对所有事件都不感兴趣了  
12.	  if (w->pevents == 0) {  
13.	    // 移出IO观察者队列  
14.	    QUEUE_REMOVE(&w->watcher_queue);  
15.	    // 重置  
16.	    QUEUE_INIT(&w->watcher_queue);  
17.	    // 重置  
18.	    if (loop->watchers[w->fd] != NULL) {  
19.	      assert(loop->watchers[w->fd] == w);  
20.	      assert(loop->nfds > 0);  
21.	      loop->watchers[w->fd] = NULL;  
22.	      loop->nfds--;  
23.	      w->events = 0;  
24.	    }  
25.	  }  
26.	  /* 
27.	    之前还没有插入IO观察者队列，则插入， 
28.	    等到Poll IO时处理，否则不需要处理 
29.	    */  
30.	  else if (QUEUE_EMPTY(&w->watcher_queue))  
31.	    QUEUE_INSERT_TAIL(&loop->watcher_queue, &w->watcher_queue);  
32.	}  
```

## 2.5 Libuv通用逻辑
### 2.5.1   uv__handle_init
uv__handle_init初始化handle的类型，设置REF标记，插入handle队列。

```cpp
1.	#define uv__handle_init(loop_, h, type_)  
2.	  do {                           
3.	    (h)->loop = (loop_);        
4.	    (h)->type = (type_);        
5.	    (h)->flags = UV_HANDLE_REF;                 
6.	    QUEUE_INSERT_TAIL(&(loop_)->handle_queue, &(h)->handle_queue);
7.	    (h)->next_closing = NULL 
8.	  }                              
9.	  while (0)  
```

### 2.5.2.  uv__handle_start
uv__handle_start设置标记handle为ACTIVE，如果设置了REF标记，则active handle的个数加一，active handle数会影响事件循环的退出。

```cpp
1.	#define uv__handle_start(h)           
2.	  do {                           
3.	    if (((h)->flags & UV_HANDLE_ACTIVE) != 0) break;                            
4.	    (h)->flags |= UV_HANDLE_ACTIVE;              
5.	    if (((h)->flags & UV_HANDLE_REF) != 0)   
6.	      (h)->loop->active_handles++;       
7.	  }                             
8.	  while (0)  
```

### 2.5.3.  uv__handle_stop
uv__handle_stop和uv__handle_start相反。

```cpp
1.	#define uv__handle_stop(h)           
2.	  do {                         
3.	    if (((h)->flags & UV_HANDLE_ACTIVE) == 0) break;    
4.	    (h)->flags &= ~UV_HANDLE_ACTIVE;  
5.	    if (((h)->flags & UV_HANDLE_REF) != 0) uv__active_handle_rm(h);  
6.	  }                              
7.	  while (0)  
```

Libuv中handle有REF和ACTIVE两个状态。当一个handle调用xxx_init函数的时候，它首先被打上REF标记，并且插入loop->handle队列。当handle调用xxx_start函数的时候，它被打上ACTIVE标记，并且记录active handle的个数加一。只有REF并且ACTIVE状态的handle才会影响事件循环的退出。

### 2.5.4.  uv__req_init
uv__req_init初始化请求的类型，记录请求的个数，会影响事件循环的退出。

```cpp
1.	#define uv__req_init(loop, req, typ) 
2.	  do {                          
3.	    (req)->type = (typ);      
4.	    (loop)->active_reqs.count++;
5.	  }                            
6.	  while (0) 
```

 
### 2.5.5.  uv__req_register
请求的个数加一

```cpp
1.	#define uv__req_register(loop, req)            
2.	  do {                           
3.	    (loop)->active_reqs.count++; 
4.	  }                            
5.	  while (0)  
```

### 2.5.6.  uv__req_unregister
请求个数减一

```cpp
1.	#define uv__req_unregister(loop, req) 
2.	  do {                          
3.	    assert(uv__has_active_reqs(loop)); 
4.	    (loop)->active_reqs.count--;
5.	   }                              
6.	  while (0)  
```

### 2.5.7.  uv__handle_ref
uv__handle_ref标记handle为REF状态，如果handle是ACTIVE状态，则active handle数加一

```cpp
1.	#define uv__handle_ref(h)             
2.	  do {                           
3.	    if (((h)->flags & UV_HANDLE_REF) != 0) break;         
4.	    (h)->flags |= UV_HANDLE_REF;     
5.	    if (((h)->flags & UV_HANDLE_CLOSING) != 0) break;   
6.	    if (((h)->flags & UV_HANDLE_ACTIVE) != 0) uv__active_handle_add(h);
7.	  }                              
8.	  while (0)  
9.  uv__handle_unref
```

uv__handle_unref去掉handle的REF状态，如果handle是ACTIVE状态，则active handle数减一

```cpp
1.	#define uv__handle_unref(h)               
2.	  do {                           
3.	    if (((h)->flags & UV_HANDLE_REF) == 0) break;  
4.	    (h)->flags &= ~UV_HANDLE_REF;  
5.	    if (((h)->flags & UV_HANDLE_CLOSING) != 0) break;
6.	    if (((h)->flags & UV_HANDLE_ACTIVE) != 0) uv__active_handle_rm(h); 
7.	  }                            
8.	  while (0)  
```
