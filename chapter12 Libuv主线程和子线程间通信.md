# 第十二章 Libuv主线程和子线程间通信
libuv其他子线程和主线程的通信是使用uv_async_t结构体实现的。Libuv使用loop->async_handles记录所有的uv_async_t结构体，使用loop->async_io_watcher作为所有uv_async_t结构体的io观察者。即loop-> async_handles队列上所有的handle都是共享async_io_watcher这个io观察者。第一次插入一个uv_async_t结构体到async_handle队列时，会初始化io观察者。如果再次注册一个async_handle，只会在loop->async_handle队列和handle队列插入一个节点，而不是新增一个io观察者。
## 12.1 初始化
uv_async_t由uv_async_init初始化

```c
1.int uv_async_init(uv_loop_t* loop, uv_async_t* handle, uv_async_cb async_cb) {  
2.  int err;  
3.  // 给libuv注册一个观察者io，读端  
4.  err = uv__async_start(loop);  
5.  if (err)  
6.    return err;  
7.  // 设置相关字段，给libuv插入一个async_handle，写端  
8.  uv__handle_init(loop, (uv_handle_t*)handle, UV_ASYNC);  
9.  handle->async_cb = async_cb;  
10.  handle->pending = 0;  
11.  
12.  QUEUE_INSERT_TAIL(&loop->async_handles, &handle->queue);  
13.  uv__handle_start(handle);  
14.  
15.  return 0;  
16.}  
```

uv_async_init函数主要初始化结构体uv_async_t，保存回调函数。执行QUEUE_INSERT_TAIL给libuv的async_handles队列追加一个handle下。我们发现还有一个uv__async_start函数。我们看一下uv__async_start的实现。 

```c
1.static int uv__async_start(uv_loop_t* loop) {  
2.  int pipefd[2];  
3.  int err;  
4.  // 只需要初始化一次  
5.  if (loop->async_io_watcher.fd != -1)  
6.    return 0;  
7.  // 获取一个用于进程间通信的fd  
8.  err = uv__async_eventfd();  
9.  // 成功则保存起来，不支持则使用管道通信作为进程间通信  
10.  if (err >= 0) {  
11.    pipefd[0] = err;  
12.    pipefd[1] = -1;  
13.  }  
14.  else if (err == UV_ENOSYS) {  
15.      // 不支持eventfd则使用匿名管道  
16.    err = uv__make_pipe(pipefd, UV__F_NONBLOCK);  
17.#if defined(__linux__)  
18.    /* Save a file descriptor by opening one of the pipe descriptors as 
19.     * read/write through the procfs.  That file descriptor can then 
20.     * function as both ends of the pipe. 
21.     */  
22.    if (err == 0) {  
23.      char buf[32];  
24.      int fd;  
25.  
26.      snprintf(buf, sizeof(buf), "/proc/self/fd/%d", pipefd[0]);  
27.      // 通过fd就可以实现对管道的读写，高级用法  
28.      fd = uv__open_cloexec(buf, O_RDWR);  
29.      if (fd >= 0) {  
30.        // 关掉旧的  
31.        uv__close(pipefd[0]);  
32.        uv__close(pipefd[1]);  
33.        // 赋值新的  
34.        pipefd[0] = fd;  
35.        pipefd[1] = fd;  
36.      }  
37.    }  
38.#endif  
39.  }  
40.  // 拿到了通信的读写两端  
41.  if (err < 0)  
42.    return err;  
43.  // 初始化io观察者async_io_watcher  
44.  uv__io_init(&loop->async_io_watcher, uv__async_io, pipefd[0]);  
45.  // 注册io观察者到loop里，并注册需要监听的事件POLLIN，即可读  
46.  uv__io_start(loop, &loop->async_io_watcher, POLLIN);  
47.  loop->async_wfd = pipefd[1];  
48.  
49.  return 0;  
50.}  
```

uv__async_start只会执行一次，时机在第一次执行uv_async_init的时候。uv__async_start主要的逻辑是

 1. 获取通信描述符（通过eventfd生成一个通信的fd或者管道生成线程间通信的两个fd表示读端和写端）。
 2. 封装读端的io观察者然后追加到watcher_queue队列，在poll io阶段，libuv会注册到epoll里面。
 3. 保存写端描述符。

## 12.2 通知主线程
子线程设置这个handle的pending为1，然后再往管道写端写入标记。

```c
1.int uv_async_send(uv_async_t* handle) {  
2.  /* Do a cheap read first. */  
3.  if (ACCESS_ONCE(int, handle->pending) != 0)  
4.    return 0;  
5.  // 如pending是0，则设置为1，返回0，如果是1则返回1，所以如果多次调用该函数是会被合并的  
6.  if (cmpxchgi(&handle->pending, 0, 1) == 0)  
7.    uv__async_send(handle->loop);  
8.  
9.  return 0;  
10.}  
11.  
12.static void uv__async_send(uv_loop_t* loop) {  
13.  const void* buf;  
14.  ssize_t len;  
15.  int fd;  
16.  int r;  
17.  
18.  buf = "";  
19.  len = 1;  
20.  fd = loop->async_wfd;  
21.  
22.#if defined(__linux__)  
23.  // 说明用的是eventfd而不是管道  
24.  if (fd == -1) {  
25.    static const uint64_t val = 1;  
26.    buf = &val;  
27.    len = sizeof(val);  
28.    // 见uv__async_start  
29.    fd = loop->async_io_watcher.fd;  /* eventfd */  
30.  }  
31.#endif  
32.  // 通知读端  
33.  do  
34.    r = write(fd, buf, len);  
35.  while (r == -1 && errno == EINTR);  
36.  
37.  if (r == len)  
38.    return;  
39.  
40.  if (r == -1)  
41.    if (errno == EAGAIN || errno == EWOULDBLOCK)  
42.      return;  
43.  
44.  abort();  
45.}  
```

重点是write函数，这个fd就是我们前面讲到的管道的写端。此时，往管道的写端写入数据。有写则必然有读。读的逻辑是在uv__io_poll中实现的。uv__io_poll函数即libuv中poll io阶段执行的函数。在uv__io_poll中会发现管道可读，然后执行对应的回调uv__async_io。
## 12.3 处理回调

```c
1.static void uv__async_io(uv_loop_t* loop, uv__io_t* w, unsigned int events) {  
2.  char buf[1024];  
3.  ssize_t r;  
4.  QUEUE queue;  
5.  QUEUE* q;  
6.  uv_async_t* h;  
7.  
8.  assert(w == &loop->async_io_watcher);  
9.  
10.  for (;;) {  
11.    // 判断通信内容  
12.    r = read(w->fd, buf, sizeof(buf));  
13.  
14.    if (r == sizeof(buf))  
15.      continue;  
16.  
17.    if (r != -1)  
18.      break;  
19.  
20.    if (errno == EAGAIN || errno == EWOULDBLOCK)  
21.      break;  
22.  
23.    if (errno == EINTR)  
24.      continue;  
25.  
26.    abort();  
27.  }  
28.  // 把async_handles队列里的所有节点都移到queue变量中  
29.  QUEUE_MOVE(&loop->async_handles, &queue);  
30.  while (!QUEUE_EMPTY(&queue)) {  
31.    // 逐个取出节点  
32.    q = QUEUE_HEAD(&queue);  
33.    // 根据结构体字段获取结构体首地址  
34.    h = QUEUE_DATA(q, uv_async_t, queue);  
35.    // 从队列中移除该节点  
36.    QUEUE_REMOVE(q);  
37.    // 重新插入async_handles队列，等待下次事件  
38.    QUEUE_INSERT_TAIL(&loop->async_handles, q);  
39.    /* 
40.      将第一个参数和第二个参数进行比较，如果相等， 
41.      则将第三参数写入第一个参数，返回第二个参数的值， 
42.      如果不相等，则返回第一个参数的值。 
43.    */  
44.    /*
45.        判断哪些async被触发了。pending在uv_async_send里设置成1，
46.        如果pending等于1，则清0，返回1.如果pending等于0，则返回0  
47.    */
48.    if (cmpxchgi(&h->pending, 1, 0) == 0)  
49.      continue;  
50.  
51.    if (h->async_cb == NULL)  
52.      continue;  
53.    // 执行上层回调  
54.    h->async_cb(h);  
55.  }  
56.}  
```

uv__async_io会遍历async_handles队列，pending等于1的话会执行对应的回调。就这样完成了子线程和主线程的通信。
## 12.4 使用

```c
1.#include <stdio.h>
2.#include <stdlib.h>
3.#include <unistd.h>
4.#include <uv.h>
5.
6.uv_loop_t *loop;
7.uv_async_t async;
8.
9.void work(uv_work_t *req) {  
10.     sleep(1);  
11.     uv_async_send(&async);  
12.}  
13.  
14.void after(uv_work_t *req, int status) {  
15.    uv_close((uv_handle_t*) &async, NULL);  
16.} 
17. 
18.void print(uv_async_t *handle) {  
19.    fprintf(stderr, "done");  
20.}  
21.
22.int main() {  
23.    loop = uv_default_loop();  
24.  
25.    uv_work_t req;  
26.    int size = 10240;  
27.    req.data = (void*) &size;  
28.  
29.    uv_async_init(loop, &async, print_progress);  
30.    uv_queue_work(loop, &req, work, after);  
31.  
32.    return uv_run(loop, UV_RUN_DEFAULT);  
33.}  
```
