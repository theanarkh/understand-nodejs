

# 第二章 Libuv数据结构和nodejs的c++层通用逻辑
## 2.1 核心结构体uv_loop_s
uv_loop_s是Libuv的核心数据结构，每个一个Libuv实例对应一个uv_loop_s结构体。他记录了整个事件循环中的核心数据。
我们来分析每一个字段的意义。
```c
void* data;
这个是用户自定义数据的字段
unsigned int active_handles;
活跃的handle个数
void* handle_queue[2]; 
handle队列
union { void* unused[2];  unsigned int count;  } active_reqs;
request个数（主要用于文件操作）
unsigned int stop_flag;
事件循环是否结束的标记
unsigned long flags;  
libuv运行的一些标记，目前只有UV_LOOP_BLOCK_SIGPROF，主要是用于epoll_wait的时候屏蔽SIGPROF信号，提高性能，SIGPROF是调操作系统settimer函数设置从而触发的信号
int backend_fd;                    
epoll的fd                                         
void* pending_queue[2];          
pending阶段的队列                                   
void* watcher_queue[2];      
需要在epoll中注册的结构体队列，上下文是uv__io_t                       
uv__io_t** watchers;               
watcher_queue队列的节点中有一个fd字段，watchers以fd为索引，记录fd所在的uv__io_t结构体 
unsigned int nwatchers;
watchers相关的数量，在maybe_resize函数里设置
unsigned int nfds;              
watchers里fd个数，一般为watcher_queue队列的节点数
void* wq[2];               
线程池的线程处理完任务后把对应的结构体插入到wq队列
uv_mutex_t wq_mutex;    
控制wq队列互斥访问
uv_async_t wq_async;   
用于线程池和主线程通信
uv_rwlock_t cloexec_lock;  
用于读写锁的互斥变量                                       
uv_handle_t* closing_handles;       
closing阶段的队列。由uv_close产生                       
void* process_handles[2];    
fork出来的进程队列                                      
void* prepare_handles[2];        
libuv的prepare阶段对应的任务队列                          
void* check_handles[2];        
libuv的check阶段对应的任务队列
void* idle_handles[2];  
libuv的idle阶段对应的任务队列
void* async_handles[2];         
async_handles队列，在线程池中发送就绪信号给主线程的时候，主线程在poll io阶段执行uv__async_io中遍历async_handles队列处理里面pending为1的节点。
uv__io_t async_io_watcher;                      
保存了线程通信管道的读端和回调，用于接收线程池的消息，调用uv__async_io回调处理async_handle队列的节点
int async_wfd;          
用于保存线程池和主线程通信的写端fd
struct {  void* min;  unsigned int nelts;} timer_heap;        
保存定时器二叉堆结构
uint64_t timer_counter;      
管理定时器节点的id，不断叠加                                 
uint64_t time; 
当前时间，Libuv会在每次事件循环的开始和poll io阶段会更新当前时间，然后在后续的各个阶段使用，减少对系统调用  
int signal_pipefd[2];                 
用于fork出来的进程和主进程通信的管道，用于非主进程收到信号的时候通知主进程，然后主进程执行非主进程节点注册的回调                                      
uv__io_t signal_io_watcher; uv_signal_t child_watcher;  
类似async_handle，signal_io_watcher保存了管道读端fd和回调，然后注册到epoll中，在非主进程收到信号的时候，通过write写到管道，最后在poll io阶段执行回调。         
int emfile_fd;   
备用的fd 
```
### 2.1.1基类uv_handle_t
在Libuv中，uv_handle_t是一个基类，有很多子类继承于他（类似c++的继承）。handle代表生命周期比较长的对象。例如
	一个处于active状态的prepare handle，他的回调会在每次事件循环化的时候被执行。
	一个tcp handle在每次有连接到来时，执行他的回调。
我们看一下uv_handle_t的定义
```c
// 自定义的数据  
void* data;       
// 所属的事件循环     
  uv_loop_t* loop;   
 // handle类型   
  uv_handle_type type;  
 // handle被关闭后被执行的回调
  uv_close_cb close_cb; 
 // 用于组织handle队列的前置后置指针
  void* handle_queue[2];
// 文件描述符 
  union {               
    int fd;             
    void* reserved[4];  
  } u;  
 // 用于插入close阶段队列     
uv_handle_t* next_closing;  
// handle的状态和标记
unsigned int flags;
```
### 2.1.2 uv_handle_t族结构体之uv_stream_s
uv_stream_s是表示流的结构体。除了继承uv_handle_t的字段外，他额外定义下面字段
```c
// 等待发送的字节数
size_t write_queue_size;         
// 分配内存的函数       
  uv_alloc_cb alloc_cb;        
// 读取数据成功时执行的回调            
  uv_read_cb read_cb; 
 // 连接成功后，执行connect_req的回调（connect_req在uv__xxx_connect中赋值）
  uv_connect_t *connect_req;     
 // 关闭写端的时候，发送完缓存的数据，回调shutdown_req的回调（shutdown_req在uv_shutdown的时候赋值）
  uv_shutdown_t *shutdown_req;   
 // 用于插入epoll，注册读写事件
  uv__io_t io_watcher;           
 // 待发送队列
  void* write_queue[2];     
 // 发送完成的队列     
  void* write_completed_queue[2];
 // 收到连接，并且accept后执行connection_cb回调
  uv_connection_cb connection_cb;
 // socket操作失败的错误码
  int delayed_error;             
 // accept返回的fd
  int accepted_fd;               
 // 已经accept了一个fd，又有新的fd，暂存起来
  void* queued_fds;
```
### 2.1.3 uv_handle_t族结构体之uv_tcp_s
uv_tcp_s继承uv_handle_s和uv_stream_s。
###  2.1.4 uv_handle_t族结构体之uv_udp_s
```c
// 发送字节数
size_t send_queue_size;
// 写队列节点的个数
size_t send_queue_count;
// 分配接收数据的内存
uv_alloc_cb alloc_cb;  
// 接收完数据后执行的回调
uv_udp_recv_cb recv_cb;
// 插入epoll里的io观察者，实现数据读写
uv__io_t io_watcher;   
// 待发送队列
void* write_queue[2];  
// 发送完成的队列（发送成功或失败），和待发送队列相关
void* write_completed_queue[2];  
```
### 2.1.5 uv_handle_t族结构体之uv_tty_s
```c
uv_tty_s继承于uv_handle_t和uv_stream_t。额外定义了下面字段。
// 终端的参数 
struct termios orig_termios; 
// 终端的工作模式
int mode;
```
### 2.1.6 uv_handle_t族结构体之uv_pipe_s 
uv_pipe_s继承于uv_handle_t和uv_stream_t。额外定义了下面字段。
```c
// 标记管道是否能在进程间传递
int ipc; 
// 用于unix域通信的文件路径
const char* pipe_fname; 
```
### 2.1.2 uv_handle_t族结构体之uv_poll_s
uv_poll_s继承于uv_handle_t，额外定义了下面字段。
```c
// 监听的fd有感兴趣的事件时执行的回调
uv_poll_cb poll_cb;
// 保存了fd和回调的io观察者，注册到epoll中
uv__io_t io_watcher;
```
### 2.1.7 uv_handle_t族结构体之uv_prepare_s、uv_check_s、uv_idle_s
上面三个结构体定义是类似的，他们都继承uv_handle_t，额外定义了两个字段。
```c
//	prepare、check、idle阶段回调
uv_xxx_cb xxx_cb; 
// 用于插入prepare、check、idle队列
void* queue[2];   
```
### 2.1.8 uv_handle_t族结构体之uv_timer_s
uv_timer_s继承uv_handle_t，额外定义了下面几个字段。
```c
 // 超时回调 
uv_timer_cb timer_cb; 
// 插入二叉堆的字段
  void* heap_node[3];
 // 超时时间
  uint64_t timeout; 
 // 超时后是否继续开始重新计时，是的话重新插入二叉堆
  uint64_t repeat; 
 // id标记，用于插入二叉堆的时候对比
  uint64_t start_id
```
### 2.1.9 uv_handle_t族结构体之uv_process_s
uv_process_s继承uv_handle_t，额外定义了
```c
// 进程退出时执行的回调
uv_exit_cb exit_cb;
// 进程id
int pid;
// 用于插入队列，进程队列或者pending队列
void* queue[2];
// 退出码，进程退出时设置
int status;  
```
### 2.1.10 uv_handle_t族结构体之uv_fs_event_s
```c
uv_fs_event_s用于监听文件改动。uv_fs_event_s继承uv_handle_t，额外定义了
// 监听的文件路径(文件或目录)
char* path;
// 文件改变时执行的回调
uv_fs_event_cb cb;
```
### 2.1.11 uv_handle_t族结构体之uv_fs_poll_s
uv_fs_poll_s继承uv_handle_t，额外定义了
```c
poll_ctx指向一个结构体
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
### 2.1.12 uv_handle_t族结构体之uv_signal_s
uv_signal_s解除uv_handle_t，额外定义了以下字段
```c
//  收到信号时的回调
uv_signal_cb signal_cb;
// 注册的信号
int signum;
/*
用于插入红黑树，进程把感兴趣的信号和回调封装成uv_signal_s，然后插入到红黑树，信号到来时，进程在信号处理号中把通知写入管道，通知libuv。libuv在poll io阶段会执行进程对应的回调。
*/
struct {                         
  struct uv_signal_s* rbe_left;  
  struct uv_signal_s* rbe_right; 
  struct uv_signal_s* rbe_parent;
  int rbe_color;                 
} tree_entry; 
// 收到的信号个数
unsigned int caught_signals;     
// 已经处理的信号个数
unsigned int dispatched_signals;
```
### 2.1.13 uv_handle_t族结构体之uv_async_s
uv_async_s是Libuv中实现主进程和其他进程线程异步通信的结构体。继承于uv_handle_t，并额外定义了以下字段。
```c
// 异步事件触发时执行的回调
uv_async_cb async_cb; 
// 用于插入async-handles队列
void* queue[2]; 
/* 
async_handles队列中的节点pending字段为1说明对应的事件触发了，
主要用于线程池和主线程的通信
*/ 
int pending; 
```
### 2.1.14基类uv_req_s
在Libuv中，uv_req_s是一个基类，有很多子类继承于他，request代表生命周期比较短的请求。比如读写一个文件，读写socket，查询dns。任务完成后这个request就结束了。request可以和handle结合使用，比如在一个tcp服务器上（handle）写一个数据（request），也可以单独使用一个request，比如dns查询或者文件读写。
### 2.1.15 uv_req_s族结构体之uv_shutdown_s
额外定义的字段
```c
// 要关闭的流，比如tcp
uv_stream_t* handle;
// 关闭流的写端后执行的回调
uv_shutdown_cb cb;
```
### 2.1.16 uv_req_s族结构体之uv_write_s
```c
// 写完后的回调
uv_write_cb cb;
// 需要传递的文件描述符，在send_handle中
  uv_stream_t* send_handle; 
// 关联的handle
  uv_stream_t* handle;
 // 用于插入队列
  void* queue[2];     
// 保存需要写的数据相关的字段     
  unsigned int write_index;
  uv_buf_t* bufs;          
  unsigned int nbufs;                 
  uv_buf_t bufsml[4];
// 写出错的错误码 
  int error;    
```
### 2.1.17 uv_req_s族结构体之uv_connect_s
```c
// 连接成功后执行的回调
uv_connect_cb cb;
// 对应的流，比如tcp
uv_stream_t* handle;
// 用于插入队列
void* queue[2]; 
```
### 2.1.18 uv_req_s族结构体之uv_udp_send_s
```c
// 所属udp的handle，udp_send_s代表一次发送，需要对应一个udp handle
uv_udp_t* handle;
// 没用到
uv_udp_send_cb cb;
// 用于插入待发送队列
void* queue[2];              
// 发送的目的地址
struct sockaddr_storage addr;
// 保存了发送数据的缓冲区和个数
unsigned int nbufs;           
uv_buf_t* bufs;               
uv_buf_t bufsml[4];
// 发送状态或成功发送的字节数
ssize_t status;              
// 发送完执行的回调（发送成功或失败）
uv_udp_send_cb send_cb;    
```
### 2.1.19 uv_req_s族结构体之uv_getaddrinfo_s
```c
// 所属事件循环
uv_loop_t* loop;
// 用于异步dns解析时插入线程池任务队列的节点
struct uv__work work_req; 
// dns解析完后执行的回调
uv_getaddrinfo_cb cb;     
// dns查询的配置
struct addrinfo* hints;   
char* hostname;           
char* service;         
// dns解析结果   
struct addrinfo* addrinfo;
// dns解析的返回码
int retcode;
```
### 2.1.20 uv_req_s族结构体之uv_getnameinfo_s
```c
uv_loop_t* loop;
// 用于异步dns解析时插入线程池任务队列的节点
struct uv__work work_req;        
// socket转域名完成的回调
uv_getnameinfo_cb getnameinfo_cb;
// 需要转域名的socket结构体
struct sockaddr_storage storage; 
// 指示查询返回的信息
int flags;                       
// 查询返回的信息
char host[NI_MAXHOST];           
char service[NI_MAXSERV];        
// 查询返回码
int retcode;
```
### 2.1.21 uv_req_s族结构体之uv_work_s
```c
uv_loop_t* loop;
// 处理任务的函数
uv_work_cb work_cb;
// 处理完任务后执行的函数
uv_after_work_cb after_work_cb;
/*
 封装一个work插入到线程池队列，work_req的work和done函数是对上面work_cb和after_work_cb的封装
*/
struct uv__work work_req;
```
### 2.1.22 uv_req_s族结构体之uv_fs_s
```c
// 文件操作类型
uv_fs_type fs_type;
  uv_loop_t* loop;
 // 文件操作完成的回调
  uv_fs_cb cb;
 // 文件操作的返回码
  ssize_t result;
 // 文件操作返回的数据
  void* ptr;
// 文件操作路径
  const char* path;
 // 文件的stat信息
  uv_stat_t statbuf;  
// 文件操作涉及到两个路径时，保存目的路径
const char *new_path;    
// 文件描述符
uv_file file;            
// 文件标记
int flags;               
// 操作模式
mode_t mode;      
// 写文件时传入的数据和个数       
unsigned int nbufs;      
uv_buf_t* bufs;          
// 文件偏移
off_t off;               
// 保存需要设置的uid和gid，例如chmod的时候
uv_uid_t uid;            
uv_gid_t gid;            
// 保存需要设置的文件修改、访问时间，例如fs.utimes的时候
double atime;            
double mtime;            
// 异步的时候用于插入任务队列，保存工作函数，回调函数
struct uv__work work_req;
// 保存读取数据或者长度。例如read和sendfile
uv_buf_t bufsml[4];  
```
## 2.2 queue
Libuv中的queue实现非常复杂。队列在Libuv中到处可见，所以理解队列的实现，才能更容易读懂Libuv其他代码。因为他是Libuv中的一个非常通用的数据结构。首先我们看一下他的定义。
typedef void *QUEUE[2];
这个是c语言中定义类型别名的一种方式。比如我们定义一个变量
QUEUE q相当于void *q[2];
即一个数组，他每个元素是void型的指针。  


 ![](https://img-blog.csdnimg.cn/20200831234557153.png#pic_center)  


下面我们接着分析四个举足轻重的宏定义，理解他们就相当于理解了libuv的队列。在分析之前，我们先来回顾一下数组指针和二维数组的知识。
```c
int a[2][2];
// 数组指针
int (*p)[2] = a;
// *(*(p+0)+1)取元素的值
```
二维数组
```c
int a[2][2];
```
我们知道二维数组在内存中的布局是一维。  


 ![](https://img-blog.csdnimg.cn/20200831234610392.png#pic_center)  


但是为了方便理解我们画成二维的。  


 ![](https://img-blog.csdnimg.cn/20200831234617284.png#pic_center)  


1. &a代表二维数组的首地址。类型是int (*)[2][2]，他是一个指针，他指向的元素是一个二维数组。假设int是四个字节。数组首地址是0，那么&a + 1等于16.
2.  a代表第一行的首地址，类型是int (*)[2]，他是一个指针，指向的元素是一个一维数组。a+1等于8。
3. a[0]也是第一行的首地址，类型是int *。
4. &a[0]也是第一行的首地址，类型是int (*)[2];
5. 如果int (p) = &a[0]，那么我们想取数组某个值的时候，可以使用((p+i) + j)的方式。(p+i)即把范围固定到第一行（这时候的指针类型是init ）,(*(p+i) + j)即在第一行的范围内定位到某一列，然后通过解引用取得内存的值。
下面开始分析libuv的具体实现
### 2.2.1 QUEUE_NEXT
#define QUEUE_NEXT(q)       (*(QUEUE **) &((*(q))[0]))  
QUEUE_NEXT看起来是获取当前节点的next字段的地址。但是他的实现非常巧妙。我们逐步分析这个宏定义。首先我们先看一下QUEUE_NEXT是怎么使用的。
1.	 void *p[2][2];  
2.	 QUEUE* q = &p[0]; // void *(*q)[2] = &p[0];  
3.	 QUEUE_NEXT(q);  
我们看到QUEUE_NEXT的参数是一个指针，他指向一个大小为2的数组，数组里的每个元素是void 。内存布局如下。  


![](https://img-blog.csdnimg.cn/20200831234632286.png#pic_center)  


因为libuv的数组只有两个元素。相当于p[2][2]变成了*p[2][1]。所以上面的代码简化为。
```c
1.	void *p[2];  
2.	QUEUE* q = &p; // void *(*q)[2] = &p;  
3.	QUEUE_NEXT(q);  
```


![](https://img-blog.csdnimg.cn/20200831234718343.png#pic_center)  


根据上面的代码我们逐步展开宏定义。
q指向整个数组p的首地址，*(q)还指向数组第一行的首地址（这时候指针类型为void *，见上面二维数组的分析5）。
(*(q))[0]即把指针定位到第一行第一列的内存地址（这时候指针类型还是void *，见上面二维数组的分析5）。
&((*(q))[0])把2中的结果（即void *）转成二级指针（void **），然后强制转换类型(QUEUE **) 。为什么需要强制转成等于QUEUE **呢？因为需要保持类型。转成QUEUE **后（即void * (**)[2]）。说明他是一个二级指针，他指向一个指针数组，每个元素指向一个大小为2的数组。这个大小为2的数组就是下一个节点的地址。  
 
 ![](https://img-blog.csdnimg.cn/20200831234730867.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center)  


在libuv中如下  


 ![在这里插入图片描述](https://img-blog.csdnimg.cn/20200831234738833.png#pic_center)  


*(QUEUE *) &(((q))[0])解引用取得q下一个节点的地址（作为右值），或者修改当前节点的next域内存里的值（作为左值）,类型是void (*)[2]。
### 2.2.2 QUEUE_PREV
#define QUEUE_PREV(q)       (*(QUEUE **) &((*(q))[1])  
prev的宏和next是类似的，区别是prev得到的是当前节点的上一个节点的地址。不再分析。
### 2.2.3 QUEUE_PREV_NEXT、QUEUE_NEXT_PREV
1.	#define QUEUE_PREV_NEXT(q)  (QUEUE_NEXT(QUEUE_PREV(q))  
2.	#define QUEUE_NEXT_PREV(q)  (QUEUE_PREV(QUEUE_NEXT(q))  
这两个宏就是取当前节点的前一个节点的下一个节点和取当前节点的后一个节点的前一个节点。那不就是自己吗？这就是libuv队列的亮点了。下面我们看一下这些宏的使用。
### 2.2.4 删除节点QUEUE_REMOVE
```c
1.	#define QUEUE_REMOVE(q)       \  
2.	  do {                         \  
3.	    QUEUE_PREV_NEXT(q) = QUEUE_NEXT(q);    \  
4.	    QUEUE_NEXT_PREV(q) = QUEUE_PREV(q);   \  
5.	  }                             \  
6.	  while (0)  
```


![](https://img-blog.csdnimg.cn/20200831234756392.png#pic_center)  


1 QUEUE_NEXT(q); 拿到q下一个节点的地址，即p
2 QUEUE_PREV_NEXT(q)分为两步，第一步拿到q前一个节点的地址。即o。然后再执行QUEUE_NEXT(o),分析之前我们先看一下关于指针变量作为左值和右值的问题。
```c
int zym = 9297;
int *cyb = &zym;
int hello = *cyb; // hello等于9297
int *cyb = 1101;
```
我们看到一个指针变量，如果他在右边，对他解引用（p）的时候，得到的值是他指向内存里的值。而如果他在左边的时候，p就是修改他自己内存里的值。我们回顾对QUEUE_NEXT宏的分析。他返回的是一个指针void (*)[2]。所以 QUEUE_PREV_NEXT(q) = QUEUE_NEXT(q); 的效果其实是修改q的前置节点（o）的next指针的内存。让他指向q的下一个节点（p），就这样完成了q的删除。
### 2.2.5 插入队列QUEUE_INSERT_TAIL
```c
1.	// q插入h，h是头节点  
2.	#define QUEUE_INSERT_TAIL(h, q)                                                 
3.	  do {                                                                          
4.	    QUEUE_NEXT(q) = (h);                                                       
5.	    QUEUE_PREV(q) = QUEUE_PREV(h);                                              
6.	    QUEUE_PREV_NEXT(q) = (q);                                                   
7.	    QUEUE_PREV(h) = (q);                                                        
8.	  }                                                                             
9.	  while (0)  
```


![](https://img-blog.csdnimg.cn/202008312348129.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center)  


## 2.3 io观察者
io观察者是Libuv中的核心概念和数据结构。我们看一下他的定义
```c
1.	struct uv__io_s {  
2.	  // 事件触发后的回调  
3.	  uv__io_cb cb;  
4.	  // 用于插入队列  
5.	  void* pending_queue[2];  
6.	  void* watcher_queue[2];  
7.	  // 保存本次感兴趣的事件，在插入io观察者队列时设置  
8.	  unsigned int pevents; /* Pending event mask i.e. mask at next tick. */  
9.	  // 保存当前感兴趣的事件  
10.	  unsigned int events;  /* Current event mask. */  
11.	  int fd;  
12.	};  
```
io观察者就是封装了事件和回调的结构体，然后插入到loop维护的io观察者队列，在poll io阶段，libuv会根据io观察者描述的信息，往底层的事件驱动模块注册相应的信息。当注册的事件触发的时候，io观察者的回调就会被执行。我们看如何初io观察者的一些逻辑。
1 初始化io观察者
```c
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
2 注册一个io观察到libuv。
```c
1.	void uv__io_start(uv_loop_t* loop, uv__io_t* w, unsigned int events) {  
2.	  // 设置当前感兴趣的事件  
3.	  w->pevents |= events;  
4.	  // 可能需要扩容  
5.	  maybe_resize(loop, w->fd + 1);  
6.	  if (w->events == w->pevents)  
7.	    return;  
8.	  // io观察者没有挂载在其他地方则插入libuv的io观察者队列  
9.	  if (QUEUE_EMPTY(&w->watcher_queue))  
10.	    QUEUE_INSERT_TAIL(&loop->watcher_queue, &w->watcher_queue);  
11.	  // 保存映射关系  
12.	  if (loop->watchers[w->fd] == NULL) {  
13.	    loop->watchers[w->fd] = w;  
14.	    loop->nfds++;  
15.	  }  
16.	}  
```
uv__io_start函数就是把一个io观察者插入到libuv的观察者队列中，并且在watchers数组中保存一个映射关系。libuv在poll io阶段会处理io观察者队列。
3 撤销io观察者或者事件
uv__io_stop修改io观察者感兴趣的事件，如果还有感兴趣的事件的话，io观察者还会在队列里，否则移出
```c
1.	void uv__io_stop(uv_loop_t* loop, uv__io_t* w, unsigned int events) {  
2.	  assert(0 == (events & ~(POLLIN | POLLOUT | UV__POLLRDHUP | UV__POLLPRI)));  
3.	  assert(0 != events);  
4.	  if (w->fd == -1)  
5.	    return;  
6.	  assert(w->fd >= 0);  
7.	  
8.	  /* Happens when uv__io_stop() is called on a handle that was never started. */  
9.	  if ((unsigned) w->fd >= loop->nwatchers)  
10.	    return;  
11.	  // 清除之前注册的事件，保存在pevents里，表示当前感兴趣的事件  
12.	  w->pevents &= ~events;  
13.	  // 对所有事件都不感兴趣了  
14.	  if (w->pevents == 0) {  
15.	    // 移出io观察者队列  
16.	    QUEUE_REMOVE(&w->watcher_queue);  
17.	    // 重置  
18.	    QUEUE_INIT(&w->watcher_queue);  
19.	    // 重置  
20.	    if (loop->watchers[w->fd] != NULL) {  
21.	      assert(loop->watchers[w->fd] == w);  
22.	      assert(loop->nfds > 0);  
23.	      loop->watchers[w->fd] = NULL;  
24.	      loop->nfds--;  
25.	      w->events = 0;  
26.	    }  
27.	  }  
28.	  /* 
29.	    之前还没有插入io观察者队列，则插入， 
30.	    等到poll io时处理，否则不需要处理 
31.	*/  
32.	  else if (QUEUE_EMPTY(&w->watcher_queue))  
33.	    QUEUE_INSERT_TAIL(&loop->watcher_queue, &w->watcher_queue);  
34.	}  
```
## 2.4 通用逻辑 
### 2.4.1 c++层的通用逻辑
我们知道nodejs分为js、c++、c三层，本节以tcp_wrap.cc为例子分析c++层实现的一些通用逻辑。直接从tcp模块导出的功能开始分析（Initialize函数）。
```c
1.	void TCPWrap::Initialize(Local<Object> target,  
2.	                         Local<Value> unused,  
3.	                         Local<Context> context) {  
4.	                         Environment* env = Environment::GetCurrent(context);  
5.	  /* 
6.	    new TCP时，v8会新建一个c++对象（根据InstanceTemplate()模板创建的对象），
7.	    然后传进New函数，接着执行New函数，New函数的入参args的args.This()就是新建的c++对象 
8.	  */  
9.	  // 新建一个函数模板  
10.	  Local<FunctionTemplate> t = env->NewFunctionTemplate(New);  
11.	  // 设置函数名称  
12.	  Local<String> tcpString = FIXED_ONE_BYTE_STRING(env->isolate(), "TCP");  
13.	  t->SetClassName(tcpString);  
14.	  /* 
15.	      ObjectTemplateInfo对象的kDataOffset偏移保存了这个字段的值， 
16.	      用于声明ObjectTemplateInfo创建的对象额外申请的内存大小 
17.	  */  
18.	  t->InstanceTemplate()->SetInternalFieldCount(1);  
19.	  
20.	  /*
21.	      设置对象模板创建的对象的属性。
22.	      ObjectTemplateInfo对象的kPropertyListOffset偏移保存了下面这些值
23.	  */  
24.	  t->InstanceTemplate()->Set(FIXED_ONE_BYTE_STRING(env->isolate(), "reading"),  
25.	                               Boolean::New(env->isolate(), false));  
26.	  
27.	  // 在t的原型上增加属性  
28.	  env->SetProtoMethod(t, "bind", Bind);  
29.	  env->SetProtoMethod(t, "connect", Connect);  
30.	  // 在target中注册该函数  
31.	  target->Set(tcpString, t->GetFunction());  
```
这里只摘取了部分的代码 ，因为我们只关注原理，这里分别涉及到函数模板对象模板和函数原型等内容。上面的代码以js来表示如下：
```c
1.	function TCP() {  
2.	    this.reading = false;  
3.	    // 对应SetInternalFieldCount(1)  
4.	    this.point = null;  
5.	    // 对应env->NewFunctionTemplate(New);  
6.	    New({  
7.	        Holder: this,   
8.	        This: this,  
9.	        returnValue: {},  
10.	        ...  
11.	    });  
12.	}  
13.	TCP.prototype.bind = Bind;  
14.	TCP.prototype.connect = Connect;  
```
通过上面的定义，完成了c++模块功能的导出，借助nodejs的机制，我们就可以在js层调用TCP函数。
 
1.	const { TCP, constants: TCPConstants } = process.binding('tcp_wrap');  
2.	const instance = new TCP(...);  
3.	instance.bind(...);  
我们先分析执行new TCP()的逻辑，然后再分析bind的逻辑，因为这两个逻辑涉及的机制是其他c++模块也会使用到的。因为TCP对应的函数是Initialize函数里的t->GetFunction()对应的值。所以new TCP()的时候，v8首先会创建一个c++对象（内容由Initialize函数里定义的那些，也就是开头的那段代码的定义）。然后执行回调New函数。
```c
1.	// 执行new TCP时执行  
2.	void TCPWrap::New(const FunctionCallbackInfo<Value>& args) {  
3.	  // 是否以构造函数的方式执行，即new TCP  
4.	  CHECK(args.IsConstructCall());  
5.	  CHECK(args[0]->IsInt32());  
6.	  Environment* env = Environment::GetCurrent(args);  
7.	  
8.	  // 忽略一些不重要的逻辑  
9.	  
10.	  /* 
11.	    args.This()为v8提供的一个c++对象（由Initialize函数定义的模块创建的） 
12.	    调用该c++对象的SetAlignedPointerInInternalField(0,this)关联this（new TCPWrap()）, 
13.	    见HandleWrap 
14.	  */  
15.	  new TCPWrap(env, args.This(), provider);  
16.	}  
17.	TCPWrap::TCPWrap(Environment* env,   
18.	                Local<Object> object,   
19.	                ProviderType provider)  
20.	    : ConnectionWrap(env, object, provider) {  
21.	  int r = uv_tcp_init(env->event_loop(), &handle_);  
22.	}  
```
构造函数只有一句代码，该代码是初始化一个结构体，我们可以不关注，我们需要关注的是父类ConnectionWrap的逻辑。
```c
1.	template <typename WrapType, typename UVType>  
2.	ConnectionWrap<WrapType, UVType>::ConnectionWrap(Environment* env,  
3.	                                                 Local<Object> object,  
4.	                                                 ProviderType provider)  
5.	    : LibuvStreamWrap(env,  
6.	                      object,  
7.	                      reinterpret_cast<uv_stream_t*>(&handle_),  
8.	                      provider) {}  
```
我们发现ConnectionWrap也没有什么逻辑，继续看LibuvStreamWrap。
```c
1.	LibuvStreamWrap::LibuvStreamWrap(Environment* env,  
2.	                                 Local<Object> object,  
3.	                                 uv_stream_t* stream,  
4.	                                 AsyncWrap::ProviderType provider)  
5.	    : HandleWrap(env,  
6.	                 object,  
7.	                 reinterpret_cast<uv_handle_t*>(stream),  
8.	                 provider),  
9.	      StreamBase(env),  
10.	      stream_(stream) {  
11.	}  
```
继续做一些初始化，我们只关注HandleWrap
```c
1.	HandleWrap::HandleWrap(Environment* env,  
2.	                       Local<Object> object,  
3.	                       uv_handle_t* handle,  
4.	                       AsyncWrap::ProviderType provider)  
5.	    : AsyncWrap(env, object, provider),  
6.	      state_(kInitialized),  
7.	      handle_(handle) {  
8.	  // 把子类对象挂载到handle的data字段上  
9.	  handle_->data = this;  
10.	  HandleScope scope(env->isolate());  
11.	  // 关联object和this对象，后续通过unwrap使用  
12.	  Wrap(object, this);  
13.	  // 入队  
14.	  env->handle_wrap_queue()->PushBack(this);  
15.	}  
```
重点来了，就是Wrap函数。
```c
1.	template <typename TypeName>  
2.	void Wrap(v8::Local<v8::Object> object, TypeName* pointer) {  
3.	  object->SetAlignedPointerInInternalField(0, pointer);  
4.	}  
5.	  
6.	void v8::Object::SetAlignedPointerInInternalField(int index, void* value) {  
7.	  i::Handle<i::JSReceiver> obj = Utils::OpenHandle(this);  
8.	  i::Handle<i::JSObject>::cast(obj)->SetEmbedderField(  
9.	      index, EncodeAlignedAsSmi(value, location));  
10.	}  
11.	  
12.	void JSObject::SetEmbedderField(int index, Smi* value) {  
13.	  // GetHeaderSize为对象固定布局的大小，kPointerSize * index为拓展的内存大小，根据索引找到对应位置  
14.	  int offset = GetHeaderSize() + (kPointerSize * index);  
15.	  // 写对应位置的内存，即保存对应的内容到内存  
16.	  WRITE_FIELD(this, offset, value);  
17.	}  
```
wrap函数展开后，做的事情就是把一个值保存到v8 c++对象的内存里。那保存的这个值是啥呢？我们看Wrap函数的入参Wrap(object, this)。object是由函数模板创建的对象，this是一个TCPWrap对象。所以Wrap函数做的事情就是把一个TCPWrap对象保存到一个函数模板创建的对象里。这有啥用呢？我们继续分析。这时候new TCP就执行完毕了。我们看看这时候执行new TCP().bind()函数的逻辑。
```c
1.	void TCPWrap::Bind(const FunctionCallbackInfo<Value>& args) {  
2.	  TCPWrap* wrap;  
3.	  // 解包处理  
4.	  ASSIGN_OR_RETURN_UNWRAP(&wrap,  
5.	                          args.Holder(),  
6.	                          args.GetReturnValue().Set(UV_EBADF));  
7.	  node::Utf8Value ip_address(args.GetIsolate(), args[0]);  
8.	  int port = args[1]->Int32Value();  
9.	  sockaddr_in addr;  
10.	  int err = uv_ip4_addr(*ip_address, port, &addr);  
11.	  if (err == 0) {  
12.	    err = uv_tcp_bind(&wrap->handle_,  
13.	                      reinterpret_cast<const sockaddr*>(&addr),  
14.	                      0);  
15.	  }  
16.	  args.GetReturnValue().Set(err);  
17.	}  
```
我们只需关系ASSIGN_OR_RETURN_UNWRAP宏的逻辑。其中args.Holder()表示Bind函数的属主，根据前面的分析我们知道属主是Initialize函数定义的函数模板创建出来的对象。这个对象保存了一个TCPWrap对象。我们展开ASSIGN_OR_RETURN_UNWRAP看看。
```c
7.	#define ASSIGN_OR_RETURN_UNWRAP(ptr, obj, ...) \  
8.	  do {                         \  
9.	    *ptr =                    \  
10.	        Unwrap<typename node::remove_reference<decltype(**ptr)>::type>(obj);  \  
11.	    if (*ptr == nullptr)       \  
12.	      return __VA_ARGS__;     \  
13.	  } while (0)  
```
```c
3.	template <typename TypeName>  
4.	TypeName* Unwrap(v8::Local<v8::Object> object) {  
5.	  // 把调用SetAlignedPointerFromInternalField设置的值取出来  
6.	  void* pointer = object->GetAlignedPointerFromInternalField(0);  
7.	  return static_cast<TypeName*>(pointer);  
8.	}  
```

展开后我们看到，主要的逻辑是把在c++对象中保存的那个TCPWrap对象取出来。然后就可以使用TCPWrap对象了。
### 2.4.2 js调用c++
js调用c++模块是v8提供的能力，nodejs是使用了这个能力。这样我们只需要面对js，剩下的事情交给nodejs就行。本文首先讲一下利用v8如何实现js调用c++，然后再讲一下nodejs是怎么做的。

首先介绍一下v8中两个非常核心的类FunctionTemplate和ObjectTemplate。顾名思义，这两个类是定义模板的，好比建房子时的设计图一样，通过设计图，我们就可以造出对应的房子。v8也是，定义某种模板，就可以通过这个模板创建出对应的实例。下面介绍一下这些概念（为了方便，下面都是伪代码)。

#### 定义一个函数模板
```c
1.	Local<FunctionTemplate> exampleFunctionTemplate = v8::FunctionTemplate::New(isolate(), New);  
2.	// 定义函数的类名  
3.	exampleFunctionTemplate->SetClassName(‘TCP’)  
```
首先定义一个FunctionTemplate对象。我们看到FunctionTemplate的第二个入参是一个函数，当我们执行由FunctionTemplate创建的函数时，v8就会执行New函数。当然我们也可以不传。

#### 定义函数模板的prototype内容
prototype就是js里的function.prototype。如果你理解js里的知识，就很容易理解c++的代码。
```c
1.	v8::Local<v8::FunctionTemplate> t = v8::FunctionTemplate::New(isolate(), callback);  
2.	 t->SetClassName('test');   
3.	 // 在prototype上定义两个属性  
4.	 exampleFunctionTemplate->PrototypeTemplate()->Set('name', t);  
5.	 exampleFunctionTemplate->PrototypeTemplate()->Set('hello', 'world'); 
```

#### 定义函数模板对应的实例模板的内容
实例模板就是一个ObjectTemplate对象。他定义了，当以new的方式执行由函数模板创建出来的函数时的返回值。
```c
1.	function A() {  
2.	    this.a = 1;  
3.	    this.b = 2;  
4.	}  
5.	new A();  
```
实例模板类似上面代码中A函数里面的代码。我们看看在v8里怎么定义。
```c
1.	t->InstanceTemplate()->Set(key, val);  
2.	t->InstanceTemplate()->SetInternalFieldCount(1);  
```
InstanceTemplate返回的是一个ObjectTemplate对象。SetInternalFieldCount这个函数比较特殊，也是比较重要的一个地方，我们知道对象就是一块内存，对象有他自己的内存布局，我们知道在c++里，我们定义一个类，也就定义了对象的布局。比如我们有以下定义。
```c
1.	class demo  
2.	{  
3.	    private:  
4.	    int a;  
5.	    int b;  
6.	}; 
```
在内存中布局如下。


 ![](https://img-blog.csdnimg.cn/20200831231926851.png#pic_center)


上面这种方式有个问题，就是类定义之后，内存布局就固定了。而v8是自己去控制对象的内存布局的。当我们在v8中定义一个类的时候，是没有任何属性的。我们看一下v8中HeapObject类的定义。
1.	class HeapObject: public Object {  
2.	  static const int kMapOffset = Object::kSize; // Object::kSize是0  
3.	  static const int kSize = kMapOffset + kPointerSize;  
4.	};  
这时候的内存布局如下。


 ![](https://img-blog.csdnimg.cn/20200831231938186.png#pic_center)

然后我们再看一下HeapObject子类HeapNumber的定义。
```c
1.	class HeapNumber: public HeapObject {  
2.	  // kSize之前的空间存储map对象的指针  
3.	  static const int kValueOffset = HeapObject::kSize;  
4.	  // kValueOffset - kSize之间存储数字的值  
5.	  static const int kSize = kValueOffset + kDoubleSize;  
6.	};  
```
内存布局如下


  ![](https://img-blog.csdnimg.cn/20200831231950160.png#pic_center)


我们发现这些类只有几个类变量，类变量是不保存在对象内存空间的。这些类变量就是定义了对象每个域所占内存空间的信息，当我们定义一个HeapObject对象的时候，v8首先申请一块内存，然后把这块内存首地址强行转成对应对象的指针。然后通过类变量对属性的内存进行存取。我们看看在v8里如何申请一个HeapNumber对象
```c
1.	Object* Heap::AllocateHeapNumber(double value, PretenureFlag pretenure) {  
2.	  // 在哪个空间分配内存，比如新生代，老生代  
3.	  AllocationSpace space = (pretenure == TENURED) ? CODE_SPACE : NEW_SPACE;  
4.	  // 在space上分配一个HeapNumber对象大小的内存  
5.	  Object* result = AllocateRaw(HeapNumber::kSize, space);  
6.	  /* 
7.	      转成HeapObect，设置map属性，map属性是表示对象类型、大小等信息的 
8.	  */  
9.	  HeapObject::cast(result)->set_map(heap_number_map());  
10.	  // 转成HeapNumber对象  
11.	  HeapNumber::cast(result)->set_value(value);  
12.	  return result;  
13.	}  
```
回到对象模板的问题。我们看一下对象模板的定义。
```c
1.	class TemplateInfo: public Struct {  
2.	  static const int kTagOffset          = HeapObject::kSize;  
3.	  static const int kPropertyListOffset = kTagOffset + kPointerSize;  
4.	  static const int kHeaderSize         = kPropertyListOffset + kPointerSize;  
5.	};  
6.	  
7.	class ObjectTemplateInfo: public TemplateInfo {  
8.	  static const int kConstructorOffset = TemplateInfo::kHeaderSize;  
9.	  static const int kInternalFieldCountOffset = kConstructorOffset + kPointerSize;  
10.	  static const int kSize = kInternalFieldCountOffset + kHeaderSize;  
11.	};  
```
内存布局如下
 ![](https://img-blog.csdnimg.cn/2020083123205278.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center)


回到对象模板的问题，我们看看Set(key, val)做了什么。
```c
1.	void Template::Set(v8::Handle<String> name, v8::Handle<Data> value,  
2.	                   v8::PropertyAttribute attribute) {  
3.	  // ...  
4.	  i::Handle<i::Object> list(Utils::OpenHandle(this)->property_list());  
5.	  NeanderArray array(list);  
6.	  array.add(Utils::OpenHandle(*name));  
7.	  array.add(Utils::OpenHandle(*value));  
8.	  array.add(Utils::OpenHandle(*v8::Integer::New(attribute)));  
9.	}  
```
上面的代码大致就是给一个list后面追加一些内容。我们看看这个list是怎么来的，即property_list函数的实现。
```c
1.	// 读取对象中某个属性的值  
2.	#define READ_FIELD(p, offset) (*reinterpret_cast<Object**>(FIELD_ADDR(p, offset))  
3.	  
4.	static Object* cast(Object* value) {   
5.	    return value;  
6.	}  
7.	  
8.	Object* TemplateInfo::property_list() {   
9.	    return Object::cast(READ_FIELD(this, kPropertyListOffset));   
10.	}  
```
从上面代码中我们知道，内部布局如下。
 
 ![](https://img-blog.csdnimg.cn/20200831232120315.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center)


根据内存布局，我们知道property_list的值是list指向的值。所以Set(key, val)操作的内存并不是对象本身的内存，对象利用一个指针指向一块内存保存Set(key, val)的值。SetInternalFieldCount函数就不一样了，他会影响（扩张）对象本身的内存。我们来看一下他的实现。
```c
1.	void ObjectTemplate::SetInternalFieldCount(int value) {  
2.	  // 修改的是kInternalFieldCountOffset对应的内存的值  
3.	  Utils::OpenHandle(this)->set_internal_field_count(i::Smi::FromInt(value));  
4.	}  
```
我们看到SetInternalFieldCount函数的实现很简单，就是在对象本身的内存中保存一个数字。接下来我们看看这个字段的使用。后面会详细介绍他的用处。
```c
1.	Handle<JSFunction> Factory::CreateApiFunction(  
2.	    Handle<FunctionTemplateInfo> obj,  
3.	    bool is_global) {  
4.	   
5.	  int internal_field_count = 0;  
6.	  if (!obj->instance_template()->IsUndefined()) {  
7.	    // 获取函数模板的实例模板  
8.	    Handle<ObjectTemplateInfo> instance_template = Handle<ObjectTemplateInfo>(ObjectTemplateInfo::cast(obj->instance_template()));  
9.	    // 获取实例模板的internal_field_count字段的值（通过SetInternalFieldCount设置的那个值）  
10.	    internal_field_count = Smi::cast(instance_template->internal_field_count())->value();  
11.	  }  
12.	  // 计算新建对象需要的空间，如果  
13.	  int instance_size = kPointerSize * internal_field_count;  
14.	  if (is_global) {  
15.	    instance_size += JSGlobalObject::kSize;  
16.	  } else {  
17.	    instance_size += JSObject::kHeaderSize;  
18.	  }  
19.	  
20.	  InstanceType type = is_global ? JS_GLOBAL_OBJECT_TYPE : JS_OBJECT_TYPE;  
21.	  // 新建一个函数对象  
22.	  Handle<JSFunction> result =  
23.	      Factory::NewFunction(Factory::empty_symbol(), type, instance_size,  
24.	                           code, true);  
25.	}   
```
我们看到internal_field_count的值的意义是，会扩张对象的内存，比如一个对象本身只有n字节，如果定义internal_field_count的值是1，对象的内存就会变成n+internal_field_count * 一个指针的字节数。内存布局如下。 


![](https://img-blog.csdnimg.cn/20200831232156395.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center)


#### 通过函数模板创建一个函数
```c
1.	global->Set('demo', AFunctionTemplate->GetFunction());  
```
这样我们就可以在js里直接调用demo这个变量，然后对应的函数就会被执行。这就是js调用c++的原理。

#### nodejs是如何处理js调用c++问题的
nodejs没有给每个功能定义一个全局变量，而是通过另外一种方式实现js调用c++。我们以tcp模块为例。在tcp_wrap.cc文件最后有一句代码
NODE_BUILTIN_MODULE_CONTEXT_AWARE(tcp_wrap, node::TCPWrap::Initialize)  
这是一个宏，展开后如下

```c
1.	#define NODE_BUILTIN_MODULE_CONTEXT_AWARE(modname, regfunc)                   \  
2.	  NODE_MODULE_CONTEXT_AWARE_CPP(modname, regfunc, nullptr, NM_F_BUILTIN)  
3.	  
4.	#define NODE_MODULE_CONTEXT_AWARE_CPP(modname, regfunc, priv, flags)          \    static node::node_module _module = { \  
5.	    NODE_MODULE_VERSION,       \  
6.	    flags,                    \  
7.	    nullptr,                  \  
8.	    __FILE__,                  \  
9.	    nullptr,                  \  
10.	    (node::addon_context_register_func) (regfunc),  \  
11.	    NODE_STRINGIFY(modname),   \  
12.	    priv,                      \  
13.	    nullptr                   \  
14.	  };                          \  
15.	  void _register_ ## modname() {  \  
16.	    node_module_register(&_module);  \  
17.	  }  
```

我们看到，宏展开后，首先定义了一个node_module 结构体。然后定义了一个_register_ xxx的函数。这个函数在nodejs初始化的时候会执行

```c
1.	void RegisterBuiltinModules() {  
2.	// 宏展开后就是执行一系列的_register_xxx函数  
3.	#define V(modname) _register_##modname();  
4.	  NODE_BUILTIN_MODULES(V)  
5.	#undef V  
6.	}  
```

我们看到_register_ xxx函数执行了

```c
node_module_register(&_module);  
```

node_module_register定义如下

```c
1.	extern "C" void node_module_register(void* m) {  
2.	  struct node_module* mp = reinterpret_cast<struct node_module*>(m);  
3.	  mp->nm_link = modlist_builtin;  
4.	  modlist_builtin = mp;  
5.	}  
```

就是把一个个node_module加入到链表中。完成了模块的注册。我们来看看如何使用这个模块。

```c
1.	constant { TCP } = process.binding('tcp_wrap');  
2.	new TCP(...);  
```

我们看到nodejs是通过process.binding来实现c++模块的调用的。nodejs通过定义一个全局变量process统一处理c++模块的调用，而不是定义一堆全局对象。下面我们看process.binding的实现，跳过nodejs的缓存处理，直接看c++的实现。

```c
1.	static Local<Object> InitModule(Environment* env,  
2.	                                 node_module* mod,  
3.	                                 Local<String> module) {  
4.	  Local<Object> exports = Object::New(env->isolate());  
5.	  Local<Value> unused = Undefined(env->isolate());  
6.	  // 执行nm_context_register_func函数，就是tcp_wrap.cc的Initialize函数  
7.	  mod->nm_context_register_func(exports,  
8.	                                unused,  
9.	                                env->context(),  
10.	                                mod->nm_priv);  
11.	  return exports;  
12.	}  
13.	  
14.	static void Binding(const FunctionCallbackInfo<Value>& args) {  
15.	  Environment* env = Environment::GetCurrent(args);  
16.	  Local<String> module = args[0].As<String>();  
17.	  node::Utf8Value module_v(env->isolate(), module);  
18.	  // 从模块链表中找到对应的模块  
19.	  node_module* mod = get_builtin_module(*module_v);  
20.	  Local<Object> exports = InitModule(env, mod, module);  
21.	  args.GetReturnValue().Set(exports);  
22.	}  
```

v8中，js调用c++函数的规则是函数入参const FunctionCallbackInfo<Value>& args（拿到js传过来的内容）和设置返回值args.GetReturnValue().Set(给js返回的内容);binding函数的逻辑就是执行对应的模块钩子函数，并有一个exports变量传进去，然后钩子函数会修改exports的值，该exports的值就是js层能拿到的值。最后我们来看看tcp_wrap.cc的Initialize。

```c
1.	void TCPWrap::Initialize(Local<Object> target,  
2.	                         Local<Value> unused,  
3.	                         Local<Context> context) {  
4.	  Environment* env = Environment::GetCurrent(context);  
5.	  /* 
6.	    new TCP时，v8会新建一个c++对象（根据InstanceTemplate()模板创建的对象），然后传进New函数， 
7.	    然后执行New函数，New函数的入参args的args.This()就是该c++对象 
8.	  */  
9.	  Local<FunctionTemplate> t = env->NewFunctionTemplate(New);  
10.	  Local<String> tcpString = FIXED_ONE_BYTE_STRING(env->isolate(), "TCP");  
11.	  t->SetClassName(tcpString);  
12.	  t->InstanceTemplate()->SetInternalFieldCount(1);  
13.	  t->InstanceTemplate()->Set(env->owner_string(), Null(env->isolate()));  
14.	  // ...  
15.	  // 在target（即exports对象）中注册该函数  
16.	  target->Set(tcpString, t->GetFunction());  
```

上面就定义了我们在js层可以拿到的值。
### 2.4.3 Libuv通用逻辑

**1 uv__handle_init**

uv__handle_init初始化handle的类型，设置REF标记，插入handle队列。

```c
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


**2.  uv__handle_start**


uv__handle_start设置标记handle为ACTIVE，如果设置了REF标记，则active handle的个数加一，active handle数会影响事件循环的退出。

```c
1.	#define uv__handle_start(h)                                                     
2.	  do {                                                                          
3.	    if (((h)->flags & UV_HANDLE_ACTIVE) != 0) break;                            
4.	    (h)->flags |= UV_HANDLE_ACTIVE;                                             
5.	    if (((h)->flags & UV_HANDLE_REF) != 0)                               
6.	      (h)->loop->active_handles++;                           
7.	  }                                                                             
8.	  while (0)  
```

**3.  uv__handle_stop**

uv__handle_stop和uv__handle_start相反。

```c
1.	#define uv__handle_stop(h)                                                      
2.	  do {                                                                        
3.	    if (((h)->flags & UV_HANDLE_ACTIVE) == 0) break;                           
4.	    (h)->flags &= ~UV_HANDLE_ACTIVE;                                      
5.	    if (((h)->flags & UV_HANDLE_REF) != 0) uv__active_handle_rm(h);             
6.	  }                                                                             
7.	  while (0)  
```

libuv中handle有REF和ACTIVE两个状态。当一个handle调用xxx_init函数的时候，他首先被打上REF标记，并且插入loop->handle队列。当handle调用xxx_start函数的时候，他首先被打上ACTIVE标记，并且记录active handle的个数加一。只有ACTIVE状态的handle才会影响事件循环的退出。


**4.  uv__req_init**


uv__req_init初始化请求的类型，记录请求的个数

```c
1.	#define uv__req_init(loop, req, typ)                                           
2.	  do {                                                                         
3.	    (req)->type = (typ);      
4.	    (loop)->active_reqs.count++;                                               
5.	  }                                                                            
6.	  while (0)  
5.  uv__req_register
```

**5. uv__req_register**

uv__req_register记录请求（request）的个数加一

```c
1.	#define uv__req_register(loop, req)                                             
2.	  do {                                                                          
3.	    (loop)->active_reqs.count++;                                                
4.	  }                                                                            
5.	  while (0)  
```

**6.  uv__req_unregister**

uv__req_unregister记录请求（request）的个数减一

```c
1.	#define uv__req_unregister(loop, req)                                           
2.	  do {                                                                          
3.	    assert(uv__has_active_reqs(loop));                                          
4.	    (loop)->active_reqs.count--;                                                
5.	  }                                                                             
6.	  while (0)  
```

**7.  uv__req_init**

uv_req_init初始化一个request类的handle

```c
1.	#define uv__req_init(loop, req, typ)                                            
2.	  do {                                                                          
3.	    UV_REQ_INIT(req, typ);                                                      
4.	    uv__req_register(loop, req);                                                
5.	  }                                                                            
6.	  while (0)  
```

**8.  uv__handle_ref**

uv__handle_ref标记handle为REF状态，如果handle是ACTIVE状态，则active handle数加一

```c
1.	#define uv__handle_ref(h)                                                       
2.	  do {                                                                          
3.	    if (((h)->flags & UV_HANDLE_REF) != 0) break;                               
4.	    (h)->flags |= UV_HANDLE_REF;                                                
5.	    if (((h)->flags & UV_HANDLE_CLOSING) != 0) break;                           
6.	    if (((h)->flags & UV_HANDLE_ACTIVE) != 0) uv__active_handle_add(h);         
7.	  }                                                                             
8.	  while (0)  
```

**9.  uv__handle_unref**

uv__handle_unref去掉handle的REF状态，如果handle是ACTIVE状态，则active handle数减一

```c
1.	#define uv__handle_unref(h)                                                     
2.	  do {                                                                          
3.	    if (((h)->flags & UV_HANDLE_REF) == 0) break;                               
4.	    (h)->flags &= ~UV_HANDLE_REF;                                               
5.	    if (((h)->flags & UV_HANDLE_CLOSING) != 0) break;                           
6.	    if (((h)->flags & UV_HANDLE_ACTIVE) != 0) uv__active_handle_rm(h);          
7.	  }                                                                            
8.	  while (0)  
```
