# 第七章 unix域
Unix域一种进程间通信的方式，他类似socket通信，但是他是基于单主机的。可以说是单机上的socket通信。因为在同一个主机内，所以就少了很多网络上的问题，那就减少了复杂度。unix域和传统的socket通信类型，服务器监听，客户端连接，由于在同主机，就不必要使用ip和端口的方式，浪费一个端口。unix域采用的是一个文件作为标记。大致原理如下。<br/>
1 服务器首先拿到一个socket结构体，和一个unix域相关的unix_proto_data结构体。<br/>
2 服务器bind一个文件。对于操作系统来说，就是新建一个文件，然后把文件路径信息存在unix_proto_data中。<br/>
3 listen<br/>
4 客户端通过同样的文件路径调用connect去连接服务器。这时候客户端的结构体插入服务器的连接队列，等待处理。<br/>
5 服务器调用accept摘取队列的节点，然后新建一个通信socket进行通信。<br/>
unix域通信本质还是基于内存之间的通信，客户端和服务器都维护一块内存，然后实现全双工通信，而unix域的文件路径，只不过是为了让客户端进程可以找到服务端进程。而通过connect和accept让客户端和服务器对应的结构体关联起来，后续就可以互相往对方维护的内存里写东西了。就可以实现进程间通信。下面我们来看一下他在操作系统的实现。
## 7.1 unix域在操作系统的实现
本章以早期linux内核源码分析一下unix域的实现，一者可以深入了解和理解unix域的原理，二者unix域的实现和socket的实现也有些相似之处，只不过unix是基于单机的进程间通信。下面是unix域实现的架构图。
 ![](https://img-blog.csdnimg.cn/20200901232449975.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70#pic_center)


### 7.1.1 unix域数据结构

```c
1.	struct unix_proto_data unix_datas[NSOCKETS_UNIX]  
2.	// unix_datas变量维护个数组，每个元素是unix_proto_data 结构。
3.	#define last_unix_data      (unix_datas + NSOCKETS_UNIX - 1) 
4.	struct unix_proto_data {  
5.	     int  refcnt; // 标记该结构是否已经被使用  
6.	     struct socket *socket; // 该节点对应的socket  
7.	     int  protocol;   
8.	     struct sockaddr_un sockaddr_un; // 协议簇和路径名  
9.	     short  sockaddr_len;  //  sock_addr_un的长度  
10.	     char  *buf; // 读写缓冲区，实现全双工  
11.	     int  bp_head, // 可写空间的头指针  
12.	     int  bp_tail; // 可写空间的尾指针  
13.	     struct inode *inode; // 路径名对应的文件的inode  
14.	     struct unix_proto_data *peerupd; // 对端的结构  
15.	     struct wait_queue *wait;  // 因为拿不到lock_flag被阻塞的队列   
16.	     int  lock_flag; // 互斥访问  
17.	};  
```

分配一个unix_proto_data结构

```c
1.	static struct unix_proto_data *  
2.	unix_data_alloc(void)  
3.	{  
4.	    struct unix_proto_data *upd;  
5.	  
6.	    cli();  
7.	    for(upd = unix_datas; upd <= last_unix_data; ++upd)   
8.	    {   // 没有被使用  
9.	        if (!upd->refcnt)   
10.	        {   // 初始化数据  
11.	            upd->refcnt = -1;   /* unix domain socket not yet initialised - bgm */  
12.	            sti();  
13.	            upd->socket = NULL;  
14.	            upd->sockaddr_len = 0;  
15.	            upd->sockaddr_un.sun_family = 0;  
16.	            upd->buf = NULL;  
17.	            upd->bp_head = upd->bp_tail = 0;  
18.	            upd->inode = NULL;  
19.	            upd->peerupd = NULL;  
20.	            return(upd);  
21.	        }  
22.	    }  
23.	    sti();  
24.	    return(NULL);  
25.	}  
```

查找

```c
1.		static struct unix_proto_data *  
2.	unix_data_lookup(struct sockaddr_un *sockun, int sockaddr_len,  
3.	         struct inode *inode)  
4.	{  
5.	     struct unix_proto_data *upd;  
6.	  
7.	     for(upd = unix_datas; upd <= last_unix_data; ++upd)   
8.	     {  
9.	        if (upd->refcnt > 0 && upd->socket &&  
10.	            upd->socket->state == SS_UNCONNECTED &&  
11.	            upd->sockaddr_un.sun_family == sockun->sun_family &&  
12.	            upd->inode == inode)   
13.	  
14.	            return(upd);  
15.	    }  
16.	    return(NULL);  
17.	}  
```

引用计数管理

```c
1.	static inline void unix_data_ref(struct unix_proto_data *upd)  
2.	{  
3.	    if (!upd)   
4.	    {  
5.	        return;  
6.	    }  
7.	    ++upd->refcnt;  
8.	}  
9.	  
10.	  
11.	static void unix_data_deref(struct unix_proto_data *upd)  
12.	{  
13.	    if (!upd)   
14.	    {  
15.	        return;  
16.	    }  
17.	    //引用数为1说明没人使用了，则释放该结构对应的内存  
18.	    if (upd->refcnt == 1)   
19.	    {  
20.	        if (upd->buf)   
21.	        {  
22.	            free_page((unsigned long)upd->buf);  
23.	            upd->buf = NULL;  
24.	            upd->bp_head = upd->bp_tail = 0;  
25.	        }  
26.	    }  
27.	    --upd->refcnt;  
28.	}  
```

### 7.1.2 unix域的实现
首先我们先要创建一个用于通信的结构unix_proto_data ，并初始化某些字段

```c
1.	static int unix_proto_create(struct socket *sock, int protocol)  
2.	{  
3.	    struct unix_proto_data *upd;  
4.	  
5.	    /* 
6.	     *  No funny SOCK_RAW stuff 
7.	     */  
8.	  
9.	    if (protocol != 0)   
10.	    {  
11.	        return(-EINVAL);  
12.	    }  
13.	    // 分配一个unix_proto_data结构体  
14.	    if (!(upd = unix_data_alloc()))   
15.	    {  
16.	        printk("UNIX: create: can't allocate buffer\n");  
17.	        return(-ENOMEM);  
18.	    }  
19.	    // 给unix_proto_data的buf字段分配一个页大小的内存  
20.	    if (!(upd->buf = (char*) get_free_page(GFP_USER)))   
21.	    {  
22.	        printk("UNIX: create: can't get page!\n");  
23.	        unix_data_deref(upd);  
24.	        return(-ENOMEM);  
25.	    }  
26.	    upd->protocol = protocol;  
27.	    // 关联unix_proto_data对应的socket结构  
28.	    upd->socket = sock;  
29.	    // socket的data字段指向unix_proto_data结构  
30.	    UN_DATA(sock) = upd;  
31.	    // 标记unix_proto_data已被使用  
32.	    upd->refcnt = 1;    /* Now it's complete - bgm */  
33.	    return(0);  
34.	}  
```

接着给这个结构绑定"地址信息"，一个文件路径。bind函数主要是根据传进来的路径创建一个文件，如果已经存在则报错。否则新建成功后把inode节点，路径名等信息存在unix_proto_data 结构

```c
1.	// 把sockaddr的内容存在unix_proto_data中，并创建一个文件  
2.	static int unix_proto_bind(struct socket *sock, struct sockaddr *umyaddr,  
3.	        int sockaddr_len)  
4.	{  
5.	    char fname[UNIX_PATH_MAX + 1];  
6.	    struct unix_proto_data *upd = UN_DATA(sock);  
7.	    unsigned long old_fs;  
8.	    int i;  
9.	  
10.	    if (sockaddr_len <= UN_PATH_OFFSET ||  
11.	        sockaddr_len > sizeof(struct sockaddr_un))   
12.	    {  
13.	        return(-EINVAL);  
14.	    }  
15.	    if (upd->sockaddr_len || upd->inode)   
16.	    {  
17.	        /*printk("UNIX: bind: already bound!\n");*/  
18.	        return(-EINVAL);  
19.	    }  
20.	    // sockaddr_un兼容sockaddr结构  
21.	    memcpy(&upd->sockaddr_un, umyaddr, sockaddr_len);  
22.	    /* 
23.	        UN_PATH_OFFSET为sun_path在sockaddr_un结构中的偏移， 
24.	        sockaddr_len-UN_PATH_OFFSET等于sun_path的最后一个字符+1的位置 
25.	    */  
26.	    upd->sockaddr_un.sun_path[sockaddr_len-UN_PATH_OFFSET] = '\0';  
27.	    if (upd->sockaddr_un.sun_family != AF_UNIX)   
28.	    {  
29.	        return(-EINVAL);  
30.	    }  
31.	    // 把sun_path的值放到fname中  
32.	    memcpy(fname, upd->sockaddr_un.sun_path, sockaddr_len-UN_PATH_OFFSET);  
33.	    fname[sockaddr_len-UN_PATH_OFFSET] = '\0';  
34.	    old_fs = get_fs();  
35.	    set_fs(get_ds());  
36.	    // 新建一个inode节点，文件名是fname，标记是一个socket类型  
37.	    i = do_mknod(fname, S_IFSOCK | S_IRWXUGO, 0);  
38.	  
39.	    if (i == 0)   
40.	        i = open_namei(fname, 0, S_IFSOCK, &upd->inode, NULL); // &upd->inode保存打开文件对应的inode节点  
41.	    set_fs(old_fs);  
42.	    if (i < 0)   
43.	    {  
44.	/*      printk("UNIX: bind: can't open socket %s\n", fname);*/  
45.	        if(i==-EEXIST)  
46.	            i=-EADDRINUSE;  
47.	        return(i);  
48.	    }  
49.	    upd->sockaddr_len = sockaddr_len;   /* now it's legal */  
50.	  
51.	    return(0);  
52.	} 
```

 
有了地址后，我们可以作为服务端或客户端，下面分开说，我们先说作为服务端 由于该版本没有支持listen函数。调用listen函数时没有对应的操作。所以我们可以直接调accept。调用accept函数的时候，首先创建了一个新的socket结构，然后在调用另一个函数dup。该函数主要是创建比socket结构还底层的一个结构，然后和socket结构关联起来。所以我们先看看unix域层的dup函数。

```c
1.	/*  
2.	    创建一个新的unix_proto_data结构和socket关联,newsock由上层新创建的，即首先创建了一个新的socket结构， 
3.	    根据oldsock的协议类型，创建了一个新的unix_proto_data和newsock关联 
4.	*/  
5.	static int unix_proto_dup(struct socket *newsock, struct socket *oldsock)  
6.	{  
7.	    struct unix_proto_data *upd = UN_DATA(oldsock);  
8.	    return(unix_proto_create(newsock, upd->protocol));  
9.	}  
```

接着调accept，该函数主要是从socket的连接队列上不断地摘取连接节点，然后唤醒客户端，如果没有连接则阻塞自己，等待有连接的时候被唤醒。unix域中建立连接的本质是客户端和服务端的数据结构互相关联。从而完成通信。

```c
1.	static int unix_proto_accept(struct socket *sock, struct socket *newsock, int flags)  
2.	{  
3.	    struct socket *clientsock;  
4.	  
5.	/* 
6.	 * If there aren't any sockets awaiting connection, 
7.	 * then wait for one, unless nonblocking. 
8.	 */  
9.	    // sock为服务端socket，iconn是连接队列，先判断是否有连接  
10.	    while(!(clientsock = sock->iconn))   
11.	    {     
12.	        // 为空并且设置了非阻塞直接返回  
13.	        if (flags & O_NONBLOCK)   
14.	            return(-EAGAIN);  
15.	        // 设置等待连接标记  
16.	        sock->flags |= SO_WAITDATA;  
17.	        // 阻塞，有有人connect的时候被唤醒  
18.	        interruptible_sleep_on(sock->wait);  
19.	        // 清除等待连接标记  
20.	        sock->flags &= ~SO_WAITDATA;  
21.	        if (current->signal & ~current->blocked)   
22.	        {  
23.	            return(-ERESTARTSYS);  
24.	        }  
25.	    }  
26.	/* 
27.	 * Great. Finish the connection relative to server and client, 
28.	 * wake up the client and return the new fd to the server. 
29.	 */  
30.	    // 更新服务端的连接队列，摘下了第一个节点  
31.	    sock->iconn = clientsock->next;  
32.	    clientsock->next = NULL;  
33.	    // 新生成的socket结构，对端指向客户端  
34.	    newsock->conn = clientsock;  
35.	    // 互相引用，设置状态为已连接  
36.	    clientsock->conn = newsock;  
37.	    clientsock->state = SS_CONNECTED;  
38.	    newsock->state = SS_CONNECTED;  
39.	    // unix_proto_data结构的引用数加1  
40.	    unix_data_ref(UN_DATA(clientsock));  
41.	    // 把unix_proto_data的数据复制到sock结构中，保存客户端的路径信息  
42.	    UN_DATA(newsock)->peerupd        = UN_DATA(clientsock);  
43.	    UN_DATA(newsock)->sockaddr_un        = UN_DATA(sock)->sockaddr_un;  
44.	    UN_DATA(newsock)->sockaddr_len       = UN_DATA(sock)->sockaddr_len;  
45.	    // 唤醒被阻塞的客户端队列  
46.	    wake_up_interruptible(clientsock->wait);  
47.	    sock_wake_async(clientsock, 0);  
48.	    return(0);  
49.	}  
```

接下来我们看connect函数，connect函数主要是把客户端追加到服务端的连接队列，阻塞自己，等待服务端进行处理，然后被唤醒。

```c
1.	    memcpy(fname, sockun.sun_path, sockaddr_len-UN_PATH_OFFSET);  
2.	    fname[sockaddr_len-UN_PATH_OFFSET] = '\0';  
3.	    old_fs = get_fs();  
4.	    set_fs(get_ds());  
5.	    // 根据传入的路径打开该文件，把inode存在inode变量里  
6.	    i = open_namei(fname, 2, S_IFSOCK, &inode, NULL);  
7.	    set_fs(old_fs);  
8.	    if (i < 0)   
9.	    {  
10.	        return(i);  
11.	    }  
12.	    // 从unix_proto_data表中找到服务端对应的unix_proto_data结构    
13.	    serv_upd = unix_data_lookup(&sockun, sockaddr_len, inode);  
14.	    iput(inode);  
15.	    // 没有则说明服务端不存在  
16.	    if (!serv_upd)   
17.	    {  
18.	        return(-EINVAL);  
19.	    }  
20.	    // 把客户端追加到服务端的连接队列，阻塞自己，等待服务器处理后唤醒  
21.	    if ((i = sock_awaitconn(sock, serv_upd->socket, flags)) < 0)   
22.	    {  
23.	        return(i);  
24.	    }  
25.	    // conn为服务端socket  
26.	    if (sock->conn)   
27.	    {   // 服务端unix_proto_data结构引用数加一，并指向服务端unix_proto_data结构  
28.	        unix_data_ref(UN_DATA(sock->conn));  
29.	        UN_DATA(sock)->peerupd = UN_DATA(sock->conn); /* ref server */  
30.	    }  
31.	    return(0);  
32.	}  
33.	// 把客户端socket追加到服务端的队列结尾，设置客户端的的对端是服务端的socket，唤醒服务端处理请求，当前进程阻塞，等待唤醒   
34.	int sock_awaitconn(struct socket *mysock, struct socket *servsock, int flags)  
35.	{  
36.	    struct socket *last;  
37.	  
38.	    /* 
39.	     *  We must be listening 
40.	     */  
41.	    // 调用listen的时候设置的  
42.	    if (!(servsock->flags & SO_ACCEPTCON))   
43.	    {  
44.	        return(-EINVAL);  
45.	    }  
46.	  
47.	    /* 
48.	     *  Put ourselves on the server's incomplete connection queue.  
49.	     */  
50.	  
51.	    mysock->next = NULL;  
52.	    cli();  
53.	    // 把客服端socket加到服务端的连接队列  
54.	    if (!(last = servsock->iconn)) // 队列为空，则当前客户端为第一个连接节点   
55.	        servsock->iconn = mysock;   
56.	    else   
57.	    {   // 找到队尾，然后追加到队尾  
58.	        while (last->next)   
59.	            last = last->next;  
60.	        last->next = mysock;  
61.	    }  
62.	    mysock->state = SS_CONNECTING;  
63.	    // 设置客户端的对端  
64.	    mysock->conn = servsock;  
65.	    sti();  
66.	  
67.	    /* 
68.	     * Wake up server, then await connection. server will set state to 
69.	     * SS_CONNECTED if we're connected. 
70.	     */  
71.	    // 有连接到来，唤醒服务端  
72.	    wake_up_interruptible(servsock->wait);  
73.	    sock_wake_async(servsock, 0);  
74.	  
75.	    if (mysock->state != SS_CONNECTED)   
76.	    {     
77.	        // 此时state为SS_CONNECTING，非阻塞则直接返回  
78.	        if (flags & O_NONBLOCK)  
79.	            return -EINPROGRESS;  
80.	        // 否则阻塞当前发起连接的进程，等待服务端处理连接，设置state为SS_CONNECTED，然后唤醒客户端  
81.	        interruptible_sleep_on(mysock->wait);  
82.	        // 状态不对，删除该客户端  
83.	        if (mysock->state != SS_CONNECTED &&  
84.	            mysock->state != SS_DISCONNECTING)   
85.	        {  
86.	        /* 
87.	         * if we're not connected we could have been 
88.	         * 1) interrupted, so we need to remove ourselves 
89.	         *    from the server list 
90.	         * 2) rejected (mysock->conn == NULL), and have 
91.	         *    already been removed from the list 
92.	         */  
93.	            if (mysock->conn == servsock)   
94.	            {  
95.	                cli();  
96.	                // 服务端连接队列只有一个节点  
97.	                if ((last = servsock->iconn) == mysock)  
98.	                    servsock->iconn = mysock->next;  
99.	                else   
100.	                {   // 找到mysock的前一个节点，删除mysock  
101.	                    while (last->next != mysock)   
102.	                        last = last->next;  
103.	                    last->next = mysock->next;  
104.	                }  
105.	                sti();  
106.	            }  
107.	            return(mysock->conn ? -EINTR : -EACCES);  
108.	        }  
109.	    }  
110.	    return(0);  
111.	}  
```

到这里，我们完成了建立连接的过程。接下来我们可以进行全双工的通信了。讲数据通信之前首先要讲一下可回环的缓冲区，他本质是一个一定大小的数组，数据写到最后一个索引后，如果前面的索引对应的元素是空，则可以往回开始写。unix域里主要是一个一页大小的字节数组作为通信的缓冲区。然后他有两个头尾指针，分别代码可写空间的起始索引和结束索引。当一端向另一端写数据的时候，直接写到对端的缓冲区去，然后对端就可以读了。初始化的时候head和tail都是0，可写空间是缓冲区大小，因为head要追上tail需要移动一页大小，当对端往里面写10个字节的时候，head往后移动10位，这时候可写字节数等于一页-10，而本端则通过tail指针可知道从哪里是可读的数据。head-tail知道还有多少空间可写，再和一页进行计算，就知道有多少空间可读，读指针是tail。

```c
1.	static int unix_proto_read(struct socket *sock, char *ubuf, int size, int nonblock)  
2.	{  
3.	    struct unix_proto_data *upd;  
4.	    int todo, avail;  
5.	  
6.	    if ((todo = size) <= 0)   
7.	        return(0);  
8.	  
9.	    upd = UN_DATA(sock);  
10.	    // 看buf中有多少数据可读  
11.	    while(!(avail = UN_BUF_AVAIL(upd)))   
12.	    {  
13.	        if (sock->state != SS_CONNECTED)   
14.	        {  
15.	            return((sock->state == SS_DISCONNECTING) ? 0 : -EINVAL);  
16.	        }  
17.	        // 没有数据，但是以非阻塞模式，直接返回  
18.	        if (nonblock)   
19.	            return(-EAGAIN);  
20.	        // 阻塞等待数据  
21.	        sock->flags |= SO_WAITDATA;  
22.	        interruptible_sleep_on(sock->wait);  
23.	        // 唤醒后清除等待标记位  
24.	        sock->flags &= ~SO_WAITDATA;  
25.	        if (current->signal & ~current->blocked)   
26.	        {  
27.	            return(-ERESTARTSYS);  
28.	        }  
29.	    }  
30.	  
31.	/* 
32.	 *  Copy from the read buffer into the user's buffer, 
33.	 *  watching for wraparound. Then we wake up the writer. 
34.	 */  
35.	    // 加锁  
36.	    unix_lock(upd);  
37.	    do   
38.	    {  
39.	        int part, cando;  
40.	  
41.	        if (avail <= 0)   
42.	        {  
43.	            printk("UNIX: read: AVAIL IS NEGATIVE!!!\n");  
44.	            send_sig(SIGKILL, current, 1);  
45.	            return(-EPIPE);  
46.	        }  
47.	        // 要读的比可读的多，则要读的为可读的数量  
48.	        if ((cando = todo) > avail)   
49.	            cando = avail;  
50.	        // 有一部分数据在队尾，一部分在队头，则先读队尾的,bp_tail表示可写空间的最后一个字节加1，即可读的第一个字节  
51.	        if (cando >(part = BUF_SIZE - upd->bp_tail))   
52.	            cando = part;  
53.	        memcpy_tofs(ubuf, upd->buf + upd->bp_tail, cando);  
54.	        // 更新bp_tail，可写空间增加  
55.	        upd->bp_tail =(upd->bp_tail + cando) &(BUF_SIZE-1);  
56.	        // 更新用户的buf指针  
57.	        ubuf += cando;  
58.	        // 还需要读的字节数  
59.	        todo -= cando;  
60.	        if (sock->state == SS_CONNECTED)  
61.	        {  
62.	            wake_up_interruptible(sock->conn->wait);  
63.	            sock_wake_async(sock->conn, 2);  
64.	        }  
65.	        avail = UN_BUF_AVAIL(upd);  
66.	    }   
67.	    while(todo && avail);// 还有数据并且还没读完则继续  
68.	    unix_unlock(upd);  
69.	    return(size - todo);// 要读的减去读了的  
70.	}  
71.	  
72.	  
73.	/* 
74.	 *  We write to our peer's buf. When we connected we ref'd this 
75.	 *  peer so we are safe that the buffer remains, even after the 
76.	 *  peer has disconnected, which we check other ways. 
77.	 */  
78.	  
79.	static int unix_proto_write(struct socket *sock, char *ubuf, int size, int nonblock)  
80.	{  
81.	    struct unix_proto_data *pupd;  
82.	    int todo, space;  
83.	  
84.	    if ((todo = size) <= 0)  
85.	        return(0);  
86.	    if (sock->state != SS_CONNECTED)   
87.	    {  
88.	        if (sock->state == SS_DISCONNECTING)   
89.	        {  
90.	            send_sig(SIGPIPE, current, 1);  
91.	            return(-EPIPE);  
92.	        }  
93.	        return(-EINVAL);  
94.	    }  
95.	    // 获取对端的unix_proto_data字段  
96.	    pupd = UN_DATA(sock)->peerupd;  /* safer than sock->conn */  
97.	    // 还有多少空间可写  
98.	    while(!(space = UN_BUF_SPACE(pupd)))   
99.	    {  
100.	        sock->flags |= SO_NOSPACE;  
101.	        if (nonblock)   
102.	            return(-EAGAIN);  
103.	        sock->flags &= ~SO_NOSPACE;  
104.	        interruptible_sleep_on(sock->wait);  
105.	        if (current->signal & ~current->blocked)   
106.	        {  
107.	            return(-ERESTARTSYS);  
108.	        }  
109.	        if (sock->state == SS_DISCONNECTING)   
110.	        {  
111.	            send_sig(SIGPIPE, current, 1);  
112.	            return(-EPIPE);  
113.	        }  
114.	    }  
115.	  
116.	/* 
117.	 *  Copy from the user's buffer to the write buffer, 
118.	 *  watching for wraparound. Then we wake up the reader. 
119.	 */  
120.	  
121.	    unix_lock(pupd);  
122.	  
123.	    do   
124.	    {  
125.	        int part, cando;  
126.	  
127.	        if (space <= 0)   
128.	        {  
129.	            printk("UNIX: write: SPACE IS NEGATIVE!!!\n");  
130.	            send_sig(SIGKILL, current, 1);  
131.	            return(-EPIPE);  
132.	        }  
133.	  
134.	        /* 
135.	         *  We may become disconnected inside this loop, so watch 
136.	         *  for it (peerupd is safe until we close). 
137.	         */  
138.	  
139.	        if (sock->state == SS_DISCONNECTING)   
140.	        {  
141.	            send_sig(SIGPIPE, current, 1);  
142.	            unix_unlock(pupd);  
143.	            return(-EPIPE);  
144.	        }  
145.	        // 需要写的比能写的多  
146.	        if ((cando = todo) > space)   
147.	            cando = space;  
148.	        // 可写空间一部分在队头一部分在队尾，则先写队尾的，再写队头的  
149.	        if (cando >(part = BUF_SIZE - pupd->bp_head))  
150.	            cando = part;  
151.	  
152.	        memcpy_fromfs(pupd->buf + pupd->bp_head, ubuf, cando);  
153.	        // 更新可写地址，可写空间减少，处理回环情况  
154.	        pupd->bp_head =(pupd->bp_head + cando) &(BUF_SIZE-1);  
155.	        // 更新用户的buf指针  
156.	        ubuf += cando;  
157.	        // 还需要写多少个字  
158.	        todo -= cando;  
159.	        if (sock->state == SS_CONNECTED)  
160.	        {  
161.	            wake_up_interruptible(sock->conn->wait);  
162.	            sock_wake_async(sock->conn, 1);  
163.	        }  
164.	        space = UN_BUF_SPACE(pupd);  
165.	    }  
166.	    while(todo && space);  
167.	  
168.	    unix_unlock(pupd);  
169.	    return(size - todo);  
170.	}  
```

## 7.2 unix域在libuv中的使用
### 7.2.1 数据结构
在libuv中，unix域用uv_pipe_t表示，首先初始化一个表示unix域的结构体uv_pipe_t。

```c
1.	struct uv_pipe_s {  
2.	  // uv_handle_s的字段  
3.	  void* data;          
4.	  // 所属事件循环     
5.	  uv_loop_t* loop;    
6.	  // handle类型      
7.	  uv_handle_type type;    
8.	  // 关闭handle时的回调  
9.	  uv_close_cb close_cb;   
10.	  // 用于插入事件循环的handle队列  
11.	  void* handle_queue[2];  
12.	  union {                 
13.	    int fd;               
14.	    void* reserved[4];    
15.	  } u;        
16.	  // 用于插入事件循环的closing阶段对应的队列  
17.	  uv_handle_t* next_closing;   
18.	  // 各种标记   
19.	  unsigned int flags;  
20.	  // 流拓展的字段  
21.	  // 用户写入流的字节大小，流缓存用户的输入，然后等到可写的时候才做真正的写  
22.	  size_t write_queue_size;   
23.	  // 分配内存的函数，内存由用户定义，主要用来保存读取的数据                 
24.	  uv_alloc_cb alloc_cb;    
25.	  // 读取数据的回调                   
26.	  uv_read_cb read_cb;   
27.	  // 连接成功后，执行connect_req的回调（connect_req在uv__xxx_connect中赋值）  
28.	  uv_connect_t *connect_req;   
29.	  /* 
30.	关闭写端的时候，发送完缓存的数据，执行 
31.	shutdown_req的回调（shutdown_req在uv_shutdown的时候赋值）    
32.	*/   
33.	  uv_shutdown_t *shutdown_req;  
34.	  // 流对应的io观察者，即文件描述符+一个文件描述符事件触发时执行的回调     
35.	  uv__io_t io_watcher;    
36.	  // 流缓存下来的，待写的数据           
37.	  void* write_queue[2];         
38.	  // 已经完成了数据写入的队列     
39.	  void* write_completed_queue[2];  
40.	  // 完成三次握手后，执行的回调  
41.	  uv_connection_cb connection_cb;  
42.	  // 操作流时出错码  
43.	  int delayed_error;    
44.	  // accept返回的通信socket对应的文件描述符             
45.	  int accepted_fd;      
46.	  // 同上，用于缓存更多的通信socket对应的文件描述符             
47.	  void* queued_fds;  
48.	  // 标记管道是否能在进程间传递  
49.	  int ipc;   
50.	  // 用于unix域通信的文件路径  
51.	  const char* pipe_fname;   
52.	}  
```

unix域继承域handle和stream。
### 7.2.2 初始化
下面看一下他的具体实现逻辑。

```c
1.	int uv_pipe_init(uv_loop_t* loop, uv_pipe_t* handle, int ipc) {  
2.	  uv__stream_init(loop, (uv_stream_t*)handle, UV_NAMED_PIPE);  
3.	  handle->shutdown_req = NULL;  
4.	  handle->connect_req = NULL;  
5.	  handle->pipe_fname = NULL;  
6.	  handle->ipc = ipc;  
7.	  return 0;  
8.	}  
```

uv_pipe_init逻辑很简单，就是初始化uv_pipe_t结构体。刚才已经见过uv_pipe_t继承于stream，uv__stream_init就是初始化stream（父类）的字段。开头说过，unix域的实现类似tcp的实现。遵循网络socket编程那一套。服务端使用bind，listen等函数启动服务。

```c
1.	// name是unix路径名称  
2.	int uv_pipe_bind(uv_pipe_t* handle, const char* name) {  
3.	  struct sockaddr_un saddr;  
4.	  const char* pipe_fname;  
5.	  int sockfd;  
6.	  int err;  
7.	  
8.	  pipe_fname = NULL;  
9.	  
10.	  pipe_fname = uv__strdup(name);  
11.	  name = NULL;  
12.	  // unix域套接字  
13.	  sockfd = uv__socket(AF_UNIX, SOCK_STREAM, 0);  
14.	  memset(&saddr, 0, sizeof saddr);  
15.	  strncpy(saddr.sun_path, pipe_fname, sizeof(saddr.sun_path) - 1);  
16.	  saddr.sun_path[sizeof(saddr.sun_path) - 1] = '\0';  
17.	  saddr.sun_family = AF_UNIX;  
18.	  // 绑定到路径，tcp是绑定到ip和端口  
19.	  if (bind(sockfd, (struct sockaddr*)&saddr, sizeof saddr)) {  
20.	   // ...  
21.	  }  
22.	  
23.	  // 已经绑定  
24.	  handle->flags |= UV_HANDLE_BOUND;  
25.	  handle->pipe_fname = pipe_fname;   
26.	  // 保存socket fd，用于后面监听  
27.	  handle->io_watcher.fd = sockfd;  
28.	  return 0;  
29.	}  
```

### 7.2.3 绑定unix域路径
uv_pipe_bind函数的逻辑也比较简单，就是类似tcp的bind行为。
1 申请一个socket套接字。
2 绑定unix域路径到socket中。
### 7.2.4 启动服务
绑定了路径后，就可以调用listen函数开始监听。

```c
1.	int uv_pipe_listen(uv_pipe_t* handle, int backlog, uv_connection_cb cb) {  
2.	  if (uv__stream_fd(handle) == -1)  
3.	    return UV_EINVAL;  
4.	  // uv__stream_fd(handle)得到bind函数中获取的socket  
5.	  if (listen(uv__stream_fd(handle), backlog))  
6.	    return UV__ERR(errno);  
7.	  // 保存回调，有进程调用connect的时候时触发，由uv__server_io函数触发  
8.	  handle->connection_cb = cb;  
9.	  // io观察者的回调，有进程调用connect的时候时触发（io观察者的fd在init函数里设置了）  
10.	  handle->io_watcher.cb = uv__server_io;  
11.	  // 注册io观察者到libuv，等待连接，即读事件到来  
12.	  uv__io_start(handle->loop, &handle->io_watcher, POLLIN);  
13.	  return 0;  
14.	}  
```

uv_pipe_listen执行listen函数使得socket成为监听型的套接字。然后把socket对应的文件描述符和回调封装成io观察者。注册到libuv。等到有读事件到来（有连接到来）。就会执行uv__server_io函数，摘下对应的客户端节点。最后执行connection_cb回调。
### 7.2.5 连接
这时候，使用unix域成功启动了一个服务。接下来就是看客户端的逻辑。

```c
1.	void uv_pipe_connect(uv_connect_t* req,  
2.	                    uv_pipe_t* handle,  
3.	                    const char* name,  
4.	                    uv_connect_cb cb) {  
5.	  struct sockaddr_un saddr;  
6.	  int new_sock;  
7.	  int err;  
8.	  int r;  
9.	  // 判断是否已经有socket了，没有的话需要申请一个，见下面  
10.	  new_sock = (uv__stream_fd(handle) == -1);  
11.	  // 客户端还没有对应的socket fd  
12.	  if (new_sock) {  
13.	    err = uv__socket(AF_UNIX, SOCK_STREAM, 0);  
14.	    if (err < 0)  
15.	      goto out;  
16.	    // 保存socket对应的文件描述符到io观察者  
17.	    handle->io_watcher.fd = err;  
18.	  }  
19.	  // 需要连接的服务器信息。主要是unix域路径信息  
20.	  memset(&saddr, 0, sizeof saddr);  
21.	  strncpy(saddr.sun_path, name, sizeof(saddr.sun_path) - 1);  
22.	  saddr.sun_path[sizeof(saddr.sun_path) - 1] = '\0';  
23.	  saddr.sun_family = AF_UNIX;  
24.	  // 连接服务器，unix域路径是name  
25.	  do {  
26.	    r = connect(uv__stream_fd(handle),(struct sockaddr*)&saddr, sizeof saddr);  
27.	  }  
28.	  while (r == -1 && errno == EINTR);  
29.	  // 忽略错误处理逻辑  
30.	  err = 0;  
31.	  // 设置socket的可读写属性  
32.	  if (new_sock) {  
33.	    err = uv__stream_open((uv_stream_t*)handle,  
34.	                          uv__stream_fd(handle),  
35.	                          UV_HANDLE_READABLE | UV_HANDLE_WRITABLE);  
36.	  }  
37.	  // 把io观察者注册到libuv，等到连接成功或者可以发送请求  
38.	  if (err == 0)  
39.	    uv__io_start(handle->loop, &handle->io_watcher, POLLIN | POLLOUT);  
40.	  
41.	out:  
42.	  // 记录错误码，如果有的话  
43.	  handle->delayed_error = err;  
44.	  // 连接成功时的回调  
45.	  handle->connect_req = req;  
46.	  
47.	  uv__req_init(handle->loop, req, UV_CONNECT);  
48.	  req->handle = (uv_stream_t*)handle;  
49.	  req->cb = cb;  
50.	  QUEUE_INIT(&req->queue);  
51.	  // 如果连接出错，在pending节点会执行req对应的回调。错误码是delayed_error  
52.	  if (err)  
53.	    uv__io_feed(handle->loop, &handle->io_watcher);  
54.	}  
```

Unix域大致的流程和网络编程一样。分为服务端和客户端两面。libuv在操作系统提供的api的基础上。和libuv的异步非阻塞结合。在libuv中为进程间提供了一种通信方式。下面看一下如何使用。
### 7.2.6 使用

```c
1.	void remove_sock(int sig) {  
2.	    uv_fs_t req;  
3.	    // 删除unix域对应的路径  
4.	    uv_fs_unlink(loop, &req, PIPENAME, NULL);  
5.	    // 退出进程  
6.	    exit(0);  
7.	}  
8.	int main() {  
9.	    loop = uv_default_loop();  
10.	    uv_pipe_t server;  
11.	    uv_pipe_init(loop, &server, 0);  
12.	    // 注册SIGINT信号的信号处理函数是remove_sock  
13.	    signal(SIGINT, remove_sock);  
14.	  
15.	    int r;  
16.	    // 绑定unix路径到socket  
17.	    if ((r = uv_pipe_bind(&server, PIPENAME))) {  
18.	        fprintf(stderr, "Bind error %s\n", uv_err_name(r));  
19.	        return 1;  
20.	    }  
21.	    /* 
22.	        把unix域对应的文件文件描述符设置为listen状态。 
23.	        开启监听请求的到来，连接的最大个数是128。有连接时的回调是on_new_connection 
24.	    */  
25.	    if ((r = uv_listen((uv_stream_t*) &server, 128, on_new_connection))) {  
26.	        fprintf(stderr, "Listen error %s\n", uv_err_name(r));  
27.	        return 2;  
28.	    }  
29.	    // 启动事件循环  
30.	    return uv_run(loop, UV_RUN_DEFAULT);  
31.	}  
```

对于了解网络编程的同学来说。上面的代码看起来会比较简单。所以就不具体分析。他执行完后就是启动了一个服务。同主机的进程可以访问（连接）他。之前说过unix域的实现和tcp的实现类似。都是基于连接的模式。服务器启动等待连接，客户端去连接。然后服务器逐个摘下连接的节点进行处理。我们从处理连接的函数on_new_connection开始分析整个流程。

```c
1.	// 有连接到来时的回调  
2.	void on_new_connection(uv_stream_t *server, int status) {  
3.	    // 有连接到来，申请一个结构体表示他  
4.	    uv_pipe_t *client = (uv_pipe_t*) malloc(sizeof(uv_pipe_t));  
5.	    uv_pipe_init(loop, client, 0);  
6.	    // 把accept返回的fd记录到client，client是用于和客户端通信的结构体  
7.	    if (uv_accept(server, (uv_stream_t*) client) == 0) {  
8.	        /* 
9.	            注册读事件，等待客户端发送信息过来, 
10.	            alloc_buffer分配内存保存客户端的发送过来的信息, 
11.	            echo_read是回调 
12.	        */  
13.	        uv_read_start((uv_stream_t*) client, alloc_buffer, echo_read);  
14.	    }  
15.	    else {  
16.	        uv_close((uv_handle_t*) client, NULL);  
17.	    }  
18.	}  
```

分析on_new_connection之前，我们先看一下该函数的执行时机。该函数是在uv__server_io函数中被执行，而uv__server_io是在监听的socket（即listen的那个）有可读事件时触发的回调。我们看看uv__server_io的部分逻辑。

```c
1.	// 有连接到来，进行accept  
2.	    err = uv__accept(uv__stream_fd(stream));  
3.	    // 保存通信socket对应的文件描述符  
4.	    stream->accepted_fd = err;  
5.	    /* 
6.	        有连接，执行上层回调，connection_cb一般会调用uv_accept消费accepted_fd。 
7.	        然后重新注册等待可读事件 
8.	    */  
9.	    stream->connection_cb(stream, 0);  
```

当有连接到来时，服务器调用uv__accept摘取一个连接节点（实现上，操作系统会返回一个文件描述符，作用类似一个id）。然后把文件描述符保存到accepted_fd字段，接着执行connection_cb回调。就是我们设置的on_new_connection。
uv__stream_fd(stream)是我们启动的服务器对应的文件描述符。stream就是表示服务器的结构体。在unix域里，他实际上是一个uv_pipe_s结构体。uv_stream_s是uv_pipe_s的父类。类似c++的继承。
我们回头看一下on_new_connection的代码。主要逻辑如下。
1 申请一个uv_pipe_t结构体用于保存和客户端通信的信息。
2 执行uv_accept
3 执行uv_read_start开始等待数据的到来，然后读取数据。
我们分析一下2和3。我们看一下uv_accept的主要逻辑。

```c
1.	switch (client->type) {  
2.	    case UV_NAMED_PIPE:  
3.	      // 设置流的标记，保存文件描述符到流上  
4.	      uv__stream_open(  
5.	          client,server->accepted_fd,  
6.	          UV_HANDLE_READABLE | UV_HANDLE_WRITABLE  
7.	      );  
8.	}  
```

uv_accept中把刚才accept到的文件描述符保存到client中。这样我们后续就可以通过client和客户端通信。echo_read在客户端给服务器发送信息时被触发。

```c
1.	void echo_read(uv_stream_t *client, ssize_t nread, const uv_buf_t *buf) {  
2.	    // 有数据，则回写  
3.	    if (nread > 0) {  
4.	        write_req_t *req = (write_req_t*) malloc(sizeof(write_req_t));  
5.	        // 指向客户端发送过来的数据  
6.	        req->buf = uv_buf_init(buf->base, nread);  
7.	        // 回写给客户端，echo_write是写成功后的回调  
8.	        uv_write((uv_write_t*) req, client, &req->buf, 1, echo_write);  
9.	        return;  
10.	    }  
11.	    // 没有数据了，关闭  
12.	    if (nread < 0) {  
13.	        if (nread != UV_EOF)  
14.	            fprintf(stderr, "Read error %s\n", uv_err_name(nread));  
15.	        // 销毁和客户端通信的结构体，即关闭通信  
16.	        uv_close((uv_handle_t*) client, NULL);  
17.	    }  
18.	  
19.	    free(buf->base);  
20.	}  
```

没有数据的时候，直接销毁和客户端通信的结构体和撤销结构体对应的读写事件。我们主要分析有数据时的处理逻辑。当有数据到来时，服务器调用uv_write对数据进行回写。我们看到uv_write的第二个参数是client。即往client对应的文件描述符中写数据。也就是往客户端写。uv_write的逻辑在stream中已经分析过，所以也不打算深入分析。主要逻辑就是在client对应的stream上写入数据，缓存起来，然后等待可写时，再写到对端。写完成后执行echo_write释放数据占据的内存。这就是使用unix域通信的整个过程。unix域还有一个复杂的应用是涉及到传递描述符。即uv_pipe_s的ipc字段，在流章节分析。
## 7.3 unix域在nodejs中的使用
Unix域对应的c++模块是pipe_wrap.cc。我们看这个模块导出的接口。
### 7.3.1 Pipe类

```c
1.	  Environment* env = Environment::GetCurrent(context);  
2.	  // 新建一个函数模板，执行该函数模板生成的函数时会执行New函数  
3.	  Local<FunctionTemplate> t = env->NewFunctionTemplate(New);  
4.	  // 暴露给js层的名称  
5.	  Local<String> pipeString = FIXED_ONE_BYTE_STRING(env->isolate(), "Pipe");  
6.	  // 函数名  
7.	  t->SetClassName(pipeString);  
8.	  // 对象布局中，需要额外拓展的内存  
9.	  t->InstanceTemplate()->SetInternalFieldCount(1);  
10.	  AsyncWrap::AddWrapMethods(env, t);  
11.	  // 原型方法  
12.	  env->SetProtoMethod(t, "close", HandleWrap::Close);  
13.	  env->SetProtoMethod(t, "unref", HandleWrap::Unref);  
14.	  env->SetProtoMethod(t, "ref", HandleWrap::Ref);  
15.	  env->SetProtoMethod(t, "hasRef", HandleWrap::HasRef);  
16.	  LibuvStreamWrap::AddMethods(env, t, StreamBase::kFlagHasWritev);  
17.	  env->SetProtoMethod(t, "bind", Bind);  
18.	  env->SetProtoMethod(t, "listen", Listen);  
19.	  env->SetProtoMethod(t, "connect", Connect);  
20.	  env->SetProtoMethod(t, "open", Open);  
21.	  // 导出  
22.	  target->Set(pipeString, t->GetFunction());  
23.	  // 缓存起来  
24.	  env->set_pipe_constructor_template(t);  
```

### 7.3.2 PipeConnectWrap类
PipeConnectWrap用于unix域作为客户端时使用。

```c
1.	auto constructor = [](const FunctionCallbackInfo<Value>& args) {  
2.	  CHECK(args.IsConstructCall());  
3.	  ClearWrap(args.This());  
4.	};  
5.	// 新建一个函数模板  
6.	auto cwt = FunctionTemplate::New(env->isolate(), constructor);  
7.	// 对象需要额外的内存  
8.	cwt->InstanceTemplate()->SetInternalFieldCount(1);  
9.	AsyncWrap::AddWrapMethods(env, cwt);  
10.	// 导出名称  
11.	Local<String> wrapString =  
12.	    FIXED_ONE_BYTE_STRING(env->isolate(), "PipeConnectWrap");  
13.	cwt->SetClassName(wrapString);  
14.	// 导出  
15.	target->Set(wrapString, cwt->GetFunction());  
```

### 7.3.3 常量

```c
1.	  // 新建一个对象  
2.	  Local<Object> constants = Object::New(env->isolate());  
3.	  // 定义并导出常量
4.	  // 作为客户端  
5.	  NODE_DEFINE_CONSTANT(constants, SOCKET);  
6.	  // 作为服务器
7.	  NODE_DEFINE_CONSTANT(constants, SERVER); 
8.	  // 作为进程间通信 
9.	  NODE_DEFINE_CONSTANT(constants, IPC);  
10.	  target->Set(context,  
11.	              FIXED_ONE_BYTE_STRING(env->isolate(), "constants"),  
12.	              constants).FromJust();  
```

我们看到unix域在c++层主要暴露了三个变量。我们看一下在js层是如何使用的。
### 7.3.4作为客户端使用
我们以Nodejs的net模块为例，从Socket类的connect开始，看一下unix域作为客户端使用时的过程。

```c
1.	Socket.prototype.connect = function(...args) {  
2.	  const path = options.path;  
3.	  // unix域路径  
4.	  var pipe = !!path;  
5.	  if (!this._handle) {  
6.	    // 创建一个c++层handle，即pipe_wrap.cc导出的Pipe类  
7.	    this._handle = pipe ?  
8.	      new Pipe(PipeConstants.SOCKET) :  
9.	      new TCP(TCPConstants.SOCKET);  
10.	    // 挂载onread方法到this中  
11.	    initSocketHandle(this);  
12.	  }  
13.	  
14.	  if (cb !== null) {  
15.	    this.once('connect', cb);  
16.	  }  
17.	  // 执行internalConnect  
18.	  defaultTriggerAsyncIdScope(  
19.	      this[async_id_symbol], internalConnect, this, path  
20.	    );  
21.	  return this;  
22.	};  
```

我们看new Pipe的逻辑，从pipe_wrap.cc的导出逻辑，我们知道，这时候会新建一个c++对象，然后执行New函数，并且把新建的c++对象等信息作为入参。

```c
1.	void PipeWrap::New(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	  // 类型，这里是客户端  
4.	  int type_value = args[0].As<Int32>()->Value();  
5.	  PipeWrap::SocketType type = static_cast<PipeWrap::SocketType>(type_value);  
6.	  // 是否是用于ipc，这里是作为客户端，所以不是ipc  
7.	  bool ipc;  
8.	  ProviderType provider;  
9.	  switch (type) {  
10.	    case SOCKET:  
11.	      provider = PROVIDER_PIPEWRAP;  
12.	      ipc = false;  
13.	      break;  
14.	    case SERVER:  
15.	      provider = PROVIDER_PIPESERVERWRAP;  
16.	      ipc = false;  
17.	      break;  
18.	    case IPC:  
19.	      provider = PROVIDER_PIPEWRAP;  
20.	      ipc = true;  
21.	      break;  
22.	    default:  
23.	      UNREACHABLE();  
24.	  }  
25.	  
26.	  new PipeWrap(env, args.This(), provider, ipc);  
27.	} 
```

 
New函数处理了参数，然后执行了new PipeWrap创建一个对象。

```c
1.	PipeWrap::PipeWrap(Environment* env,  
2.	                   Local<Object> object,  
3.	                   ProviderType provider,  
4.	                   bool ipc)  
5.	    : ConnectionWrap(env, object, provider) {  
6.	  int r = uv_pipe_init(env->event_loop(), &handle_, ipc);  
7.	}  
```

调用libuv的uv_pipe_init初始化handle，我们看一下uv_pipe_init的逻辑。

```c
1.	int uv_pipe_init(uv_loop_t* loop, uv_pipe_t* handle, int ipc) {  
2.	  uv__stream_init(loop, (uv_stream_t*)handle, UV_NAMED_PIPE);  
3.	  handle->shutdown_req = NULL;  
4.	  handle->connect_req = NULL;  
5.	  handle->pipe_fname = NULL;  
6.	  handle->ipc = ipc;  
7.	  return 0;  
8.	}  
```

我们继续看一下uv__stream_init

```c
1.	void uv__stream_init(uv_loop_t* loop,  
2.	                     uv_stream_t* stream,  
3.	                     uv_handle_type type) {  
4.	  int err;  
5.	  
6.	  uv__handle_init(loop, (uv_handle_t*)stream, type);  
7.	  stream->read_cb = NULL;  
8.	  stream->alloc_cb = NULL;  
9.	  stream->close_cb = NULL;  
10.	  stream->connection_cb = NULL;  
11.	  stream->connect_req = NULL;  
12.	  stream->shutdown_req = NULL;  
13.	  stream->accepted_fd = -1;  
14.	  stream->queued_fds = NULL;  
15.	  stream->delayed_error = 0;  
16.	  QUEUE_INIT(&stream->write_queue);  
17.	  QUEUE_INIT(&stream->write_completed_queue);  
18.	  stream->write_queue_size = 0;  
19.	  // 初始化流中io观察者的处理函数，即io观察者的事件触发时，执行的回调  
20.	  uv__io_init(&stream->io_watcher, uv__stream_io, -1);  
21.	}  
```

然后把args.This()对象的字段执行新建的PipeWrap对象。后续会用到。我们回到js层继续看，new Pipe执行完后，接着执行了internalConnect
internalConnect函数的主要逻辑如下

```c
1.	const req = new PipeConnectWrap();  
2.	// address为unix域路径
3.	req.address = address;  
4.	req.oncomplete = afterConnect;  
5.	// 调用c++层connect
6.	err = self._handle.connect(req, address, afterConnect);  
```

我们看c++层的connect函数，

```c
1.	void PipeWrap::Connect(const FunctionCallbackInfo<Value>& args) {  
2.	  Environment* env = Environment::GetCurrent(args);  
3.	  
4.	  PipeWrap* wrap;  
5.	  // 通过Connect方法的holder拿到一个PipeWrap对象，在new PipeWrap的时候关联的  
6.	  ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());  
7.	  // PipeConnectWrap对象  
8.	  Local<Object> req_wrap_obj = args[0].As<Object>();  
9.	  // unix域路径  
10.	  node::Utf8Value name(env->isolate(), args[1]);  
11.	  /*
12.	      ConnectWrap是对handle进行一次连接请求的封装，内部维护一个uv_connect_t结构体
13.	      新建一个ConnectWrap对象， req_wrap_obj的一个字段指向ConnectWrap对象  
14.	  */
15.	  ConnectWrap* req_wrap =  
16.	      new ConnectWrap(env, req_wrap_obj, AsyncWrap::PROVIDER_PIPECONNECTWRAP);  
17.	  // 调用libuv的connect函数  
18.	  uv_pipe_connect(req_wrap->req(),  
19.	                  &wrap->handle_,  
20.	                  *name,  
21.	                  AfterConnect);  
22.	  // req_wrap->req_.data = req_wrap;关联起来
23.	  req_wrap->Dispatched();  
24.	  
25.	  args.GetReturnValue().Set(0);  // uv_pipe_connect() doesn't return errors.  
26.	}  
```

uv_pipe_connect函数，第一个参数是uv_connect_t结构体（request），第二个是一个uv_pipe_t结构体（handle），handle是对unix域客户端的封装，他对发起连接的逻辑进行了封装。  
由uv_pipe_init我们知道，当io观察者的事件触发时，会执行回调uv__stream_io。

```c
1.	static void uv__stream_io(uv_loop_t* loop, uv__io_t* w, unsigned int events) {  
2.	  uv_stream_t* stream = container_of(w, uv_stream_t, io_watcher);  
3.	  if (stream->connect_req) {  
4.	    uv__stream_connect(stream);  
5.	    return;  
6.	  }  
7.	}  
```

connect_req是在uv_pipe_connect的时候设置的，我们继续看uv__stream_connect

```c
1.	static void uv__stream_connect(uv_stream_t* stream) {  
2.	  int error;  
3.	  uv_connect_t* req = stream->connect_req;  
4.	  socklen_t errorsize = sizeof(int);  
5.	  // 连接错误  
6.	  if (stream->delayed_error) {  
7.	    error = stream->delayed_error;  
8.	    stream->delayed_error = 0;  
9.	  } else {  
10.	    // 没有报错，还是得获取一下连接的错误码  
11.	    getsockopt(uv__stream_fd(stream),  
12.	               SOL_SOCKET,  
13.	               SO_ERROR,  
14.	               &error,  
15.	               &errorsize);  
16.	    error = -error;  
17.	  }  
18.	  stream->connect_req = NULL;  
19.	  uv__req_unregister(stream->loop, req);  
20.	  // 出错或者待发送队列为空，则清除等待可写事件  
21.	  if (error < 0 || QUEUE_EMPTY(&stream->write_queue)) {  
22.	    uv__io_stop(stream->loop, &stream->io_watcher, POLLOUT);  
23.	  }  
24.	  // 执行c++层回调  
25.	  if (req->cb)  
26.	    req->cb(req, error);  
27.	    
28.	}  
```

这里执行了c++层的回调，我们看看c++层

```c
1.	// 主动发起连接，成功后的回调  
2.	template <typename WrapType, typename UVType> = PipeWrap, uv_pipe_t  
3.	void ConnectionWrap<WrapType, UVType>::AfterConnect(uv_connect_t* req,  
4.	                                                    int status) {  
5.	  // 在Connect函数了关联的  
6.	  ConnectWrap* req_wrap = static_cast<ConnectWrap*>(req->data);  
7.	  // 在uv_pipe_connect中完成关联的  
8.	  WrapType* wrap = static_cast<WrapType*>(req->handle->data);  
9.	  Environment* env = wrap->env();  
10.	  
11.	  HandleScope handle_scope(env->isolate());  
12.	  Context::Scope context_scope(env->context());  
13.	  
14.	  bool readable, writable;  
15.	  // 是否连接成功  
16.	  if (status) {  
17.	    readable = writable = 0;  
18.	  } else {  
19.	    readable = uv_is_readable(req->handle) != 0;  
20.	    writable = uv_is_writable(req->handle) != 0;  
21.	  }  
22.	  
23.	  Local<Value> argv[5] = {  
24.	    Integer::New(env->isolate(), status),  
25.	    wrap->object(),  
26.	    req_wrap->object(),  
27.	    Boolean::New(env->isolate(), readable),  
28.	    Boolean::New(env->isolate(), writable)  
29.	  };  
30.	  // 执行js层的oncomplete回调  
31.	  req_wrap->MakeCallback(env->oncomplete_string(), arraysize(argv), argv);  
32.	  
33.	  delete req_wrap;  
34.	}  
```

我们再回到js层的afterConnect

```c
1.	function afterConnect(status, handle, req, readable, writable) {  
2.	  var self = handle.owner;  
3.	  handle = self._handle;  
4.	  if (status === 0) {  
5.	    self.readable = readable;  
6.	    self.writable = writable;  
7.	    self._unrefTimer();  
8.	    // 触发connect事件  
9.	    self.emit('connect');  
10.	    // 可读并且没有处于暂停模式，则注册等待可读事件  
11.	    if (readable && !self.isPaused())  
12.	      self.read(0);  
13.	  }  
14.	}  
```

至此，作为客户端对服务器的连接就完成了。

### 7.3.5 使用unix域实现兄弟进程通信
客户端
```go
const net = require('net');
const { EventEmitter } = require('events');

class Work extends EventEmitter {}

class UnixDomainClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
  }
  send(data) {
    const work = new Work();
    const socket = net.connect(this.options.path);
    socket.end(JSON.stringify(data));
    socket.on('error', (e) => {
      work.emit('error', e);
    });
    let res = null;
    socket.on('data', (chunk) => {
      res = res ? Buffer.concat([res, chunk]) : chunk;
    });
    socket.on('end', () => {
      work.emit('message', res && res.toString());
    });
    return work;
  }
}
const work = new UnixDomainClient({path: '/tmp/test.sock'}).send('hello');
work.on('message', function(res) {
  console.log(res);
})


```
服务器

```go
const fs = require('fs');
const net = require('net');
const constants = {
  UNIX_PATH: '/tmp/test.sock',
}
if (fs.existsSync(constants.UNIX_PATH)) {
  fs.unlinkSync(constants.UNIX_PATH);
}
const server = net.createServer({ allowHalfOpen: true }, (client) => {
  let data = null;
  client.on('data', (chunk) => {
    data = data ? Buffer.concat([data, chunk]) : chunk;
  });
  client.on('end', () => {
    console.log(`recive msg: ${data.toString()}`)
    client.end('world');
  });
});
server.listen(constants.UNIX_PATH, () => {
  console.log(`bind uinx path ${constants.UNIX_PATH}`);
});
server.on('error', (error) => {
  console.log(`unix domain server error ${error.toString()}`);
});
process.on('exit', () => {
  if (fs.existsSync(constants.UNIX_PATH)) {
    fs.unlinkSync(constants.UNIX_PATH);
  }
});
```

