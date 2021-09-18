HTTP模块实现了HTTP服务器和客户端的功能，是Node.js的核心模块，也是我们使用得最多的模块。本章我们来分析HTTP模块，从中我们可以学习到一个HTTP服务器和客户端是怎么实现的，以及HTTP协议本身的一些原理和优化。
## 18.1 HTTP解析器
HTTP解析器是HTTP模块的核心，不管是作为服务器处理请求还是客户端处理响应都需要使用HTTP解析器解析HTTP协议。新版Node.js使用了新的HTTP解析器llhttp。根据官方说明llhttp比旧版的http_parser在性能上有了非常大的提高。本节我们分析分析llhttp的基础原理和使用。HTTP解析器是一个非常复杂的状态机，在解析数据的过程中，会不断触发钩子函数。下面是llhttp支持的钩子函数。如果用户定义了对应的钩子，在解析的过程中就会被回调。

```
1.	// 开始解析HTTP协议
2.	int llhttp__on_message_begin(llhttp_t* s, const char* p, const char* endp) {  
3.	  int err;  
4.	  CALLBACK_MAYBE(s, on_message_begin, s);  
5.	  return err;  
6.	}  
7.	  
8.	// 解析出请求url时的回调，最后拿到一个url
9.	int llhttp__on_url(llhttp_t* s, const char* p, const char* endp) {  
10.	  int err;  
11.	  CALLBACK_MAYBE(s, on_url, s, p, endp - p);  
12.	  return err;  
13.	}  
14.	  
15.	// 解析出HTTP响应状态的回调
16.	int llhttp__on_status(llhttp_t* s, const char* p, const char* endp) {  
17.	  int err;  
18.	  CALLBACK_MAYBE(s, on_status, s, p, endp - p);  
19.	  return err;  
20.	}  
21.	  
22.	// 解析出头部键时的回调
23.	int llhttp__on_header_field(llhttp_t* s, const char* p, const char* endp) {  
24.	  int err;  
25.	  CALLBACK_MAYBE(s, on_header_field, s, p, endp - p);  
26.	  return err;  
27.	}  
28.	  
29.	// 解析出头部值时的回调
30.	int llhttp__on_header_value(llhttp_t* s, const char* p, const char* endp) {  
31.	  int err;  
32.	  CALLBACK_MAYBE(s, on_header_value, s, p, endp - p);  
33.	  return err;  
34.	}  
35.	  
36.	// 解析HTTP头完成时的回调  
37.	int llhttp__on_headers_complete(llhttp_t* s, const char* p, const char* endp) {  
38.	  int err;  
39.	  CALLBACK_MAYBE(s, on_headers_complete, s);  
40.	  return err;  
41.	}  
42.	  
43.	// 解析完body的回调 
44.	int llhttp__on_message_complete(llhttp_t* s, const char* p, const char* endp) {  
45.	  int err;  
46.	  CALLBACK_MAYBE(s, on_message_complete, s);  
47.	  return err;  
48.	}  
49.	  
50.	// 解析body时的回调
51.	int llhttp__on_body(llhttp_t* s, const char* p, const char* endp) {  
52.	  int err;  
53.	  CALLBACK_MAYBE(s, on_body, s, p, endp - p);  
54.	  return err;  
55.	}  
56.	  
57.	 // 解析到一个chunk结构头时的回调 
58.	int llhttp__on_chunk_header(llhttp_t* s, const char* p, const char* endp) {  
59.	  int err;  
60.	  CALLBACK_MAYBE(s, on_chunk_header, s);  
61.	  return err;  
62.	}  
63.	  
64.	// 解析完一个chunk时的回调  
65.	int llhttp__on_chunk_complete(llhttp_t* s, const char* p, const char* endp) {  
66.	  int err;  
67.	  CALLBACK_MAYBE(s, on_chunk_complete, s);  
68.	  return err;  
69.	}  
```

Node.js在node_http_parser.cc中对llhttp进行了封装。该模块导出了一个HTTPParser。

```
1.	Local<FunctionTemplate> t=env->NewFunctionTemplate(Parser::New); 
2.	t->InstanceTemplate()->SetInternalFieldCount(1);  
3.	t->SetClassName(FIXED_ONE_BYTE_STRING(env->isolate(), 
4.	                  "HTTPParser"));  
5.	target->Set(env->context(),  
6.	  FIXED_ONE_BYTE_STRING(env->isolate(), "HTTPParser"),   
7.	  t->GetFunction(env->context()).ToLocalChecked()).Check();  
```

在Node.js中我们通过以下方式使用HTTPParser。

```
1.	  const parser = new HTTPParser();  
2.	  
3.	  cleanParser(parser);  
4.	  parser.onIncoming = null;  
5.	  parser[kOnHeaders] = parserOnHeaders;  
6.	  parser[kOnHeadersComplete] = parserOnHeadersComplete;  
7.	  parser[kOnBody] = parserOnBody;  
8.	  parser[kOnMessageComplete] = parserOnMessageComplete; 
9.	  // 初始化HTTP解析器处理的报文类型，这里是响应报文
10.	  parser.initialize(HTTPParser.RESPONSE,
11.	     new HTTPClientAsyncResource('HTTPINCOMINGMESSAGE', req),
12.	     req.maxHeaderSize || 0,
13.	     req.insecureHTTPParser === undefined ?
14.	     isLenient() : req.insecureHTTPParser); 
15.	  // 收到数据后传给解析器处理
16.	  const ret = parser.execute(data);
17.	}  
```

我们看一下initialize和execute的代码。Initialize函数用于初始化llhttp。

```
1.	static void Initialize(const FunctionCallbackInfo<Value>& args) {
2.	   Environment* env = Environment::GetCurrent(args);  
3.	   bool lenient = args[3]->IsTrue();  
4.	  
5.	   uint64_t max_http_header_size = 0;  
6.	   // 头部的最大大小  
7.	   if (args.Length() > 2) {  
8.	     max_http_header_size = args[2].As<Number>()->Value();  
9.	   }  
10.	   // 没有设置则取Node.js的默认值  
11.	   if (max_http_header_size == 0) {  
12.	     max_http_header_size=env->options()->max_http_header_size;
13.	   }  
14.	   // 解析的报文类型  
15.	   llhttp_type_t type =  
16.	       static_cast<llhttp_type_t>(args[0].As<Int32>()->Value());
17.	  
18.	   CHECK(type == HTTP_REQUEST || type == HTTP_RESPONSE);  
19.	   Parser* parser;  
20.	   ASSIGN_OR_RETURN_UNWRAP(&parser, args.Holder());  
21.	   parser->Init(type, max_http_header_size, lenient);  
22.	 }  
```

Initialize做了一些预处理后调用Init。

```
1.	void Init(llhttp_type_t type, uint64_t max_http_header_size, bool lenient) {  
2.	   // 初始化llhttp  
3.	   llhttp_init(&parser_, type, &settings);  
4.	   llhttp_set_lenient(&parser_, lenient);  
5.	   header_nread_ = 0;  
6.	   url_.Reset();  
7.	   status_message_.Reset();  
8.	   num_fields_ = 0;  
9.	   num_values_ = 0;  
10.	  have_flushed_ = false;  
11.	  got_exception_ = false;  
12.	  max_http_header_size_ = max_http_header_size;  
13.	}  
```

Init做了一些字段的初始化，最重要的是调用了llhttp_init对llhttp进行了初始化，另外kOn开头的属性是钩子函数，由node_http_parser.cc中的回调，而node_http_parser.cc也会定义钩子函数，由llhttp回调，我们看一下node_http_parser.cc钩子函数的定义和实现。

```
1.	const llhttp_settings_t Parser::settings = {  
2.	  Proxy<Call, &Parser::on_message_begin>::Raw,  
3.	  Proxy<DataCall, &Parser::on_url>::Raw,  
4.	  Proxy<DataCall, &Parser::on_status>::Raw,  
5.	  Proxy<DataCall, &Parser::on_header_field>::Raw,  
6.	  Proxy<DataCall, &Parser::on_header_value>::Raw,  
7.	  Proxy<Call, &Parser::on_headers_complete>::Raw,  
8.	  Proxy<DataCall, &Parser::on_body>::Raw,  
9.	  Proxy<Call, &Parser::on_message_complete>::Raw,  
10.	 Proxy<Call, &Parser::on_chunk_header>::Raw,  
11.	 Proxy<Call, &Parser::on_chunk_complete>::Raw,  
12.	};  
```

1 开始解析报文的回调

```
1.	  // 开始解析报文，一个TCP连接可能会有多个报文  
2.	  int on_message_begin() {  
3.	    num_fields_ = num_values_ = 0;  
4.	    url_.Reset();  
5.	    status_message_.Reset();  
6.	    return 0;  
7.	  }  
```

2 解析url时的回调

```
1.	int on_url(const char* at, size_t length) {  
2.	    int rv = TrackHeader(length);  
3.	    if (rv != 0) {  
4.	      return rv;  
5.	    }  
6.	  
7.	    url_.Update(at, length);  
8.	    return 0;  
9.	  }  
```

3解析HTTP响应时的回调

```
1.	int on_status(const char* at, size_t length) {  
2.	   int rv = TrackHeader(length);  
3.	   if (rv != 0) {  
4.	     return rv;  
5.	   }  
6.	  
7.	   status_message_.Update(at, length);  
8.	   return 0;  
9.	 }  
```

4解析到HTTP头的键时回调

```
1.	int on_header_field(const char* at, size_t length) {  
2.	    int rv = TrackHeader(length);  
3.	    if (rv != 0) {  
4.	      return rv;  
5.	    }  
6.	    // 相等说明键对值的解析是一一对应的  
7.	    if (num_fields_ == num_values_) {  
8.	      // start of new field name  
9.	      // 键的数加一  
10.	      num_fields_++;  
11.	      // 超过阈值则先回调js消费掉  
12.	      if (num_fields_ == kMaxHeaderFieldsCount) {  
13.	        // ran out of space - flush to javascript land  
14.	        Flush();  
15.	        // 重新开始  
16.	        num_fields_ = 1;  
17.	        num_values_ = 0;  
18.	      }  
19.	      // 初始化  
20.	      fields_[num_fields_ - 1].Reset();  
21.	    }  
22.	  
23.	    // 保存键  
24.	    fields_[num_fields_ - 1].Update(at, length);  
25.	  
26.	    return 0;  
27.	}  
```

当解析的头部个数达到阈值时，Node.js会先通过Flush函数回调JS层保存当前的一些数据。

```
1.	void Flush() {  
2.	    HandleScope scope(env()->isolate());  
3.	  
4.	    Local<Object> obj = object();  
5.	    // JS层的钩子  
6.	    Local<Value> cb = obj->Get(env()->context(), kOnHeaders).ToLocalChecked();  
7.	    if (!cb->IsFunction())  
8.	      return;  
9.	  
10.	    Local<Value> argv[2] = {  
11.	      CreateHeaders(),  
12.	      url_.ToString(env())  
13.	    };  
14.	  
15.	    MaybeLocal<Value> r = MakeCallback(cb.As<Function>(),  
16.	                                       arraysize(argv),  
17.	                                       argv);  
18.	    url_.Reset();  
19.	    have_flushed_ = true;  
20.	  } 
21.	
22.	Local<Array> CreateHeaders() {  
23.	   // HTTP头的个数乘以2，因为一个头由键和值组成  
24.	   Local<Value> headers_v[kMaxHeaderFieldsCount * 2];  
25.	   // 保存键和值到HTTP头  
26.	   for (size_t i = 0; i < num_values_; ++i) {  
27.	     headers_v[i * 2] = fields_[i].ToString(env());  
28.	     headers_v[i * 2 + 1] = values_[i].ToString(env());  
29.	   }  
30.	  
31.	   return Array::New(env()->isolate(), headers_v, num_values_ * 2);  
32.	 }  
33.	 
```

Flush会调用JS层的kOnHeaders钩子函数。

5解析到HTTP头的值时回调

```
1.	int on_header_value(const char* at, size_t length) {  
2.	   int rv = TrackHeader(length);  
3.	   if (rv != 0) {  
4.	     return rv;  
5.	   }  
6.	   /* 
7.	     值的个数不等于键的个数说明正解析到键对应的值，即一一对应。 
8.	     否则说明一个键存在多个值，则不更新值的个数，多个值累加到一个slot 
9.	   */  
10.	   if (num_values_ != num_fields_) {  
11.	     // start of new header value  
12.	     num_values_++;  
13.	     values_[num_values_ - 1].Reset();  
14.	   }  
15.	  
16.	   CHECK_LT(num_values_, arraysize(values_));  
17.	   CHECK_EQ(num_values_, num_fields_);  
18.	  
19.	   values_[num_values_ - 1].Update(at, length);  
20.	  
21.	   return 0;  
22.	 }  
```

6解析完HTTP头后的回调

```
1.	int on_headers_complete() {  
2.	    header_nread_ = 0;   
3.	    enum on_headers_complete_arg_index {  
4.	       A_VERSION_MAJOR = 0,  
5.	       A_VERSION_MINOR,  
6.	       A_HEADERS,  
7.	       A_METHOD,  
8.	       A_URL,  
9.	       A_STATUS_CODE,  
10.	      A_STATUS_MESSAGE,  
11.	      A_UPGRADE,  
12.	      A_SHOULD_KEEP_ALIVE,  
13.	      A_MAX  
14.	    };  
15.	  
16.	    Local<Value> argv[A_MAX];  
17.	    Local<Object> obj = object();  
18.	    Local<Value> cb = obj->Get(env()->context(),  
19.	                               kOnHeadersComplete).ToLocalChecked();  
20.	  
21.	    Local<Value> undefined = Undefined(env()->isolate());  
22.	    for (size_t i = 0; i < arraysize(argv); i++)  
23.	      argv[i] = undefined;  
24.	    // 之前flush过，则继续flush到JS层，否则返回全部头给js  
25.	    if (have_flushed_) {  
26.	      // Slow case, flush remaining headers.  
27.	      Flush();  
28.	    } else {  
29.	      // Fast case, pass headers and URL to JS land.  
30.	      argv[A_HEADERS] = CreateHeaders();  
31.	      if (parser_.type == HTTP_REQUEST)  
32.	        argv[A_URL] = url_.ToString(env());  
33.	    }  
34.	  
35.	    num_fields_ = 0;  
36.	    num_values_ = 0;  
37.	  
38.	    // METHOD  
39.	    if (parser_.type == HTTP_REQUEST) {  
40.	      argv[A_METHOD] =  
41.	          Uint32::NewFromUnsigned(env()->isolate(), parser_.method);  
42.	    }  
43.	  
44.	    // STATUS  
45.	    if (parser_.type == HTTP_RESPONSE) {  
46.	      argv[A_STATUS_CODE] =  
47.	          Integer::New(env()->isolate(), parser_.status_code);  
48.	      argv[A_STATUS_MESSAGE] = status_message_.ToString(env());  
49.	    }  
50.	  
51.	    // VERSION  
52.	    argv[A_VERSION_MAJOR] = Integer::New(env()->isolate(), parser_.http_major);  
53.	    argv[A_VERSION_MINOR] = Integer::New(env()->isolate(), parser_.http_minor);  
54.	  
55.	    bool should_keep_alive;  
56.	    // 是否定义了keepalive头  
57.	    should_keep_alive = llhttp_should_keep_alive(&parser_);  
58.	  
59.	    argv[A_SHOULD_KEEP_ALIVE] =  
60.	        Boolean::New(env()->isolate(), should_keep_alive);  
61.	    // 是否是升级协议  
62.	    argv[A_UPGRADE] = Boolean::New(env()->isolate(), parser_.upgrade);  
63.	  
64.	    MaybeLocal<Value> head_response;  
65.	    {  
66.	      InternalCallbackScope callback_scope(  
67.	          this, InternalCallbackScope::kSkipTaskQueues);  
68.	      head_response = cb.As<Function>()->Call(  
69.	          env()->context(), object(), arraysize(argv), argv);  
70.	    }  
71.	  
72.	    int64_t val;  
73.	  
74.	    if (head_response.IsEmpty() || !head_response.ToLocalChecked()  
75.	                                        ->IntegerValue(env()->context())  
76.	                                        .To(&val)) {  
77.	      got_exception_ = true;  
78.	      return -1;  
79.	    }  
80.	  
81.	    return val;  
82.	  }  
```

on_headers_complete会执行JS层的kOnHeadersComplete钩子。

7 解析body时的回调

```
1.	int on_body(const char* at, size_t length) {  
2.	   EscapableHandleScope scope(env()->isolate());  
3.	  
4.	   Local<Object> obj = object();  
5.	   Local<Value> cb = obj->Get(env()->context(), kOnBody).ToLocalChecked();  
6.	  
7.	   // We came from consumed stream  
8.	   if (current_buffer_.IsEmpty()) {  
9.	     // Make sure Buffer will be in parent HandleScope  
10.	     current_buffer_ = scope.Escape(Buffer::Copy(  
11.	         env()->isolate(),  
12.	         current_buffer_data_,  
13.	         current_buffer_len_).ToLocalChecked());  
14.	   }  
15.	  
16.	   Local<Value> argv[3] = {  
17.	     // 当前解析中的数据  
18.	     current_buffer_,  
19.	     // body开始的位置  
20.	     Integer::NewFromUnsigned(env()->isolate(), at - current_buffer_data_),  
21.	     // body当前长度  
22.	     Integer::NewFromUnsigned(env()->isolate(), length)  
23.	   };  
24.	  
25.	   MaybeLocal<Value> r = MakeCallback(cb.As<Function>(),  
26.	                                      arraysize(argv),  
27.	                                      argv);   
28.	  
29.	   return 0;  
30.	 }  
```

Node.js中并不是每次解析HTTP报文的时候就新建一个HTTP解析器，Node.js使用FreeList数据结构对HTTP解析器实例进行了管理。

```
1.	class FreeList {  
2.	  constructor(name, max, ctor) {  
3.	    this.name = name;  
4.	    // 构造函数  
5.	    this.ctor = ctor;  
6.	    // 节点的最大值  
7.	    this.max = max;  
8.	    // 实例列表  
9.	    this.list = [];  
10.	  }  
11.	  // 分配一个实例  
12.	  alloc() {  
13.	    // 有空闲的则直接返回，否则新建一个  
14.	    return this.list.length > 0 ?  
15.	      this.list.pop() :  
16.	      ReflectApply(this.ctor, this, arguments);  
17.	  }  
18.	  // 释放实例  
19.	  free(obj) {  
20.	    // 小于阈值则放到空闲列表，否则释放（调用方负责释放）  
21.	    if (this.list.length < this.max) {  
22.	      this.list.push(obj);  
23.	      return true;  
24.	    }  
25.	    return false;  
26.	  }  
27.	}  
```

我们看一下在Node.js中对FreeList的使用。。

```
1.	const parsers = new FreeList('parsers', 1000, function parsersCb() {  
2.	  const parser = new HTTPParser();  
3.	  // 初始化字段  
4.	  cleanParser(parser);  
5.	  // 设置钩子  
6.	  parser.onIncoming = null;  
7.	  parser[kOnHeaders] = parserOnHeaders;  
8.	  parser[kOnHeadersComplete] = parserOnHeadersComplete;  
9.	  parser[kOnBody] = parserOnBody;  
10.	  parser[kOnMessageComplete] = parserOnMessageComplete;  
11.	  
12.	  return parser;  
13.	});  
```

HTTP解析器的使用

```
1.	var HTTPParser = process.binding('http_parser').HTTPParser;  
2.	var parser = new HTTPParser(HTTPParser.REQUEST);  
3.	  
4.	const kOnHeaders = HTTPParser.kOnHeaders;  
5.	const kOnHeadersComplete = HTTPParser.kOnHeadersComplete;  
6.	const kOnBody = HTTPParser.kOnBody;  
7.	const kOnMessageComplete = HTTPParser.kOnMessageComplete;  
8.	const kOnExecute = HTTPParser.kOnExecute;  
9.	  
10.	parser[kOnHeaders] = function(headers, url) {  
11.	    console.log('kOnHeaders', headers.length, url);  
12.	}  
13.	parser[kOnHeadersComplete] = function(versionMajor, versionMinor, headers, method,  
14.	         url, statusCode, statusMessage, upgrade, shouldKeepAlive) {  
15.	    console.log('kOnHeadersComplete', headers);  
16.	}  
17.	  
18.	parser[kOnBody] = function(b, start, len) {  
19.	    console.log('kOnBody', b.slice(start).toString('utf-8'));  
20.	}  
21.	parser[kOnMessageComplete] = function() {  
22.	    console.log('kOnMessageComplete');  
23.	}  
24.	parser[kOnExecute] = function() {  
25.	    console.log('kOnExecute');  
26.	}  
27.	  
28.	parser.execute(Buffer.from(  
29.	    'GET / HTTP/1.1\r\n' +  
30.	    'Host: http://localhost\r\n\r\n'   
31.	));  
```

以上代码的输出

```
1.	kOnHeadersComplete [ 'Host', 'http://localhost' ]  
2.	kOnMessageComplete  
```

我们看到只执行了kOnHeadersComplete和 kOnMessageComplete。那其它几个回调什么时候会执行呢？我们接着看。我们把输入改一下。

```
1.	parser.execute(Buffer.from(  
2.	    'GET / HTTP/1.1\r\n' +  
3.	    'Host: http://localhost\r\n' +  
4.	    'content-length: 1\r\n\r\n'+  
5.	    '1'  
6.	));  
```

上面代码的输出

```
1.	kOnHeadersComplete [ 'Host', 'http://localhost', 'content-length', '1' ]  
2.	kOnBody 1  
3.	kOnMessageComplete  
```

我们看到多了一个回调kOnBody，因为我们加了一个HTTP头content-length指示有body，所以HTTP解析器解析到body的时候就会回调kOnBody。那kOnHeaders什么时候会执行呢？我们继续修改代码。

```
1.	parser.execute(Buffer.from(  
2.	    'GET / HTTP/1.1\r\n' +  
3.	    'Host: http://localhost\r\n' +  
4.	    'a: b\r\n'+  
5.	     // 很多'a: b\r\n'+
6.	    'content-length: 1\r\n\r\n'+  
7.	    '1'  
8.	));  
```

以上代码的输出

```
1.	kOnHeaders 62 /  
2.	kOnHeaders 22  
3.	kOnHeadersComplete undefined  
4.	kOnBody 1  
5.	kOnMessageComplete  
```

我们看到kOnHeaders被执行了，并且执行了两次。因为如果HTTP头的个数达到阈值，在解析HTTP头部的过程中，就先flush到JS层（如果多次达到阈值，则回调多次），并且在解析完所有HTTP头后，会在kOnHeadersComplet回调之前再次回调kOnHeaders（如果还有的话）。最后我们看一下kOnExecute如何触发。

```
1.	var HTTPParser = process.binding('http_parser').HTTPParser;  
2.	var parser = new HTTPParser(HTTPParser.REQUEST);  
3.	var net = require('net');  
4.	  
5.	const kOnHeaders = HTTPParser.kOnHeaders;  
6.	const kOnHeadersComplete = HTTPParser.kOnHeadersComplete;  
7.	const kOnBody = HTTPParser.kOnBody;  
8.	const kOnMessageComplete = HTTPParser.kOnMessageComplete;  
9.	const kOnExecute = HTTPParser.kOnExecute;  
10.	  
11.	parser[kOnHeaders] = function(headers, url) {  
12.	    console.log('kOnHeaders', headers.length, url);  
13.	}  
14.	parser[kOnHeadersComplete] = function(versionMajor, versionMinor, headers, method,  
15.	         url, statusCode, statusMessage, upgrade, shouldKeepAlive) {  
16.	    console.log('kOnHeadersComplete', headers);  
17.	}  
18.	  
19.	parser[kOnBody] = function(b, start, len) {  
20.	    console.log('kOnBody', b.slice(start).toString('utf-8'));  
21.	}  
22.	parser[kOnMessageComplete] = function() {  
23.	    console.log('kOnMessageComplete');  
24.	}  
25.	parser[kOnExecute] = function(a,b) {  
26.	    console.log('kOnExecute,解析的字节数：',a);  
27.	}  
28.	// 启动一个服务器  
29.	net.createServer((socket) => {  
30.	  parser.consume(socket._handle);  
31.	}).listen(80);  
32.	  
33.	// 启动一个客户端  
34.	setTimeout(() => {  
35.	  var socket = net.connect({port: 80});  
36.	  socket.end('GET / HTTP/1.1\r\n' +  
37.	    'Host: http://localhost\r\n' +  
38.	    'content-length: 1\r\n\r\n'+  
39.	    '1');  
40.	}, 1000);  
```

我们需要调用parser.consume方法并且传入一个isStreamBase的流（stream_base.cc定义），才会触发kOnExecute。因为kOnExecute是在StreamBase流可读时触发的。
## 18.2 HTTP客户端
我们首先看一下使用Node.js作为客户端的例子。

```
1.	const data = querystring.stringify({  
2.	  'msg': 'hi'  
3.	});  
4.	  
5.	const options = {  
6.	  hostname: 'your domain',  
7.	  path: '/',  
8.	  method: 'POST',  
9.	  headers: {  
10.	    'Content-Type': 'application/x-www-form-urlencoded',  
11.	    'Content-Length': Buffer.byteLength(data)  
12.	  }  
13.	};  
14.	  
15.	const req = http.request(options, (res) => {  
16.	  res.setEncoding('utf8');  
17.	  res.on('data', (chunk) => {  
18.	    console.log(`${chunk}`);  
19.	  });  
20.	  res.on('end', () => {  
21.	    console.log('end');  
22.	  });  
23.	});  
24.	  
25.	req.on('error', (e) => {  
26.	  console.error(`${e.message}`);  
27.	});  
28.	// 发送请求的数据  
29.	req.write(data);  
30.	// 设置请求结束  
31.	req.end();  
```

我们看一下http.request的实现。

```
1.	function request(url, options, cb) {  
2.	  return new ClientRequest(url, options, cb);  
3.	}  
```

HTTP客户端通过_http_client.js的ClientRequest实现，ClientRequest的代码非常多，我们只分析核心的流程。我们看初始化一个请求的逻辑。

```
1.	function ClientRequest(input, options, cb) {  
2.	  // 继承OutgoingMessage  
3.	  OutgoingMessage.call(this);  
4.	  // 是否使用agent  
5.	  let agent = options.agent;   
6.	  // 忽略agent的处理，具体参考_http_agent.js，主要用于复用TCP连接  
7.	  this.agent = agent;  
8.	  // 建立连接的超时时间  
9.	  if (options.timeout !== undefined)  
10.	    this.timeout = getTimerDuration(options.timeout, 'timeout');  
11.	  // HTTP头个数的阈值  
12.	  const maxHeaderSize = options.maxHeaderSize;  
13.	  this.maxHeaderSize = maxHeaderSize;  
14.	  // 监听响应事件  
15.	  if (cb) {  
16.	    this.once('response', cb);  
17.	  }  
18.	  // 忽略设置http协议的请求行或请求头的逻辑
19.	  // 建立TCP连接后的回调  
20.	  const oncreate = (err, socket) => {  
21.	    if (called)  
22.	      return;  
23.	    called = true;  
24.	    if (err) {  
25.	      process.nextTick(() => this.emit('error', err));  
26.	      return;  
27.	    }  
28.	    // 建立连接成功，执行回调  
29.	    this.onSocket(socket);  
30.	    // 连接成功后发送数据  
31.	    this._deferToConnect(null, null, () => this._flush());  
32.	  };  
33.	  
34.	  // 使用agent时，socket由agent提供，否则自己创建socket  
35.	  if (this.agent) {  
36.	    this.agent.addRequest(this, options);  
37.	  } else {  
38.	    // 不使用agent则每次创建一个socket，默认使用net模块的接口
39.	    if (typeof options.createConnection === 'function') {  
40.	      const newSocket = options.createConnection(options, 
41.	                                                      oncreate);  
42.	      if (newSocket && !called) {  
43.	        called = true;  
44.	        this.onSocket(newSocket);  
45.	      } else {  
46.	        return;  
47.	      }  
48.	    } else {  
49.	      this.onSocket(net.createConnection(options));  
50.	    }  
51.	  }  
52.	  // 连接成功后发送待缓存的数据  
53.	  this._deferToConnect(null, null, () => this._flush());  
54.	}  
```

获取一个ClientRequest实例后，不管是通过agent还是自己创建一个TCP连接，在连接成功后都会执行onSocket。

```
1.	// socket可用时的回调  
2.	ClientRequest.prototype.onSocket = function onSocket(socket) {  
3.	  process.nextTick(onSocketNT, this, socket);  
4.	};  
5.	  
6.	function onSocketNT(req, socket) {  
7.	  // 申请socket过程中，请求已经终止  
8.	  if (req.aborted) {
9.	    // 不使用agent，直接销毁socekt  
10.	    if (!req.agent) {  
11.	      socket.destroy();  
12.	    } else {  
13.	      // 使用agent触发free事件，由agent处理socekt  
14.	      req.emit('close');  
15.	      socket.emit('free');  
16.	    }  
17.	  } else {  
18.	    // 处理socket  
19.	    tickOnSocket(req, socket);  
20.	  }  
21.	}  
```

我们继续看tickOnSocket

```
1.	// 初始化HTTP解析器和注册data事件等，等待响应  
2.	function tickOnSocket(req, socket) {  
3.	  // 分配一个HTTP解析器  
4.	  const parser = parsers.alloc();  
5.	  req.socket = socket;  
6.	  // 初始化，处理响应报文  
7.	  parser.initialize(HTTPParser.RESPONSE,  
8.	         new HTTPClientAsyncResource('HTTPINCOMINGMESSAGE', req),          req.maxHeaderSize || 0,  
9.	         req.insecureHTTPParser === undefined ?  
10.	        isLenient() : req.insecureHTTPParser);  
11.	  parser.socket = socket;  
12.	  parser.outgoing = req;  
13.	  req.parser = parser;  
14.	  
15.	  socket.parser = parser;  
16.	  // socket正处理的请求  
17.	  socket._httpMessage = req;  
18.	  
19.	  // Propagate headers limit from request object to parser  
20.	  if (typeof req.maxHeadersCount === 'number') {  
21.	    parser.maxHeaderPairs = req.maxHeadersCount << 1;  
22.	  }  
23.	  // 解析完HTTP头部的回调  
24.	  parser.onIncoming = parserOnIncomingClient;  
25.	  socket.removeListener('error', freeSocketErrorListener);  
26.	  socket.on('error', socketErrorListener);  
27.	  socket.on('data', socketOnData);  
28.	  socket.on('end', socketOnEnd);  
29.	  socket.on('close', socketCloseListener);  
30.	  socket.on('drain', ondrain);  
31.	  
32.	  if (  
33.	    req.timeout !== undefined ||  
34.	    (req.agent && req.agent.options && 
35.	     req.agent.options.timeout)  
36.	  ) {  
37.	    // 处理超时时间  
38.	    listenSocketTimeout(req);  
39.	  }  
40.	  req.emit('socket', socket);  
41.	}  
```

拿到一个socket后，就开始监听socket上http报文的到来。并且申请一个HTTP解析器准备解析http报文，我们主要分析超时时间的处理和data事件的处理逻辑。  
1 超时时间的处理

```
1.	function listenSocketTimeout(req) {  
2.	  // 设置过了则返回  
3.	  if (req.timeoutCb) {  
4.	    return;  
5.	  }  
6.	  // 超时回调  
7.	  req.timeoutCb = emitRequestTimeout;  
8.	  // Delegate socket timeout event.  
9.	  // 设置socket的超时时间，即socket上一定时间后没有响应则触发超时  
10.	  if (req.socket) {  
11.	    req.socket.once('timeout', emitRequestTimeout);  
12.	  } else {  
13.	    req.on('socket', (socket) => {  
14.	      socket.once('timeout', emitRequestTimeout);  
15.	    });  
16.	  }  
17.	}  
18.	  
19.	function emitRequestTimeout() {  
20.	  const req = this._httpMessage;  
21.	  if (req) {  
22.	    req.emit('timeout');  
23.	  }  
24.	}  
```

2 处理响应数据

```
1.	function socketOnData(d) {  
2.	  const socket = this;  
3.	  const req = this._httpMessage;  
4.	  const parser = this.parser;  
5.	  // 交给HTTP解析器处理  
6.	  const ret = parser.execute(d);  
7.	  // ...  
8.	}  
```

当Node.js收到响应报文时，会把数据交给HTTP解析器处理。http解析在解析的过程中会不断触发钩子函数。我们看一下JS层各个钩子函数的逻辑。  
1 解析头部过程中执行的回调

```
1.	function parserOnHeaders(headers, url) {  
2.	  // 保存头和url  
3.	  if (this.maxHeaderPairs <= 0 ||  
4.	      this._headers.length < this.maxHeaderPairs) {  
5.	    this._headers = this._headers.concat(headers);  
6.	  }  
7.	  this._url += url;
8.	}  
```

2 解析完头部的回调

```
1.	function parserOnHeadersComplete(versionMajor, 
2.	                                    versionMinor, 
3.	                                    headers, 
4.	                                    method,  
5.	                                 url, 
6.	                                    statusCode, 
7.	                                    statusMessage, 
8.	                                    upgrade,  
9.	                                 shouldKeepAlive) {  
10.	  const parser = this;  
11.	  const { socket } = parser;  
12.	  // 剩下的HTTP头  
13.	  if (headers === undefined) {  
14.	    headers = parser._headers;  
15.	    parser._headers = [];  
16.	  }  
17.	    
18.	  if (url === undefined) {  
19.	    url = parser._url;  
20.	    parser._url = '';  
21.	  }  
22.	  
23.	  // Parser is also used by http client  
24.	  // IncomingMessage  
25.	  const ParserIncomingMessage=(socket && 
26.	                                  socket.server &&  
27.	                               socket.server[kIncomingMessage]
28.	                                  ) ||                                 
29.	                                  IncomingMessage;  
30.	  // 新建一个IncomingMessage对象  
31.	  const incoming = parser.incoming = new ParserIncomingMessage(socket);  
32.	  incoming.httpVersionMajor = versionMajor;  
33.	  incoming.httpVersionMinor = versionMinor;  
34.	  incoming.httpVersion = `${versionMajor}.${versionMinor}`;  
35.	  incoming.url = url;  
36.	  incoming.upgrade = upgrade;  
37.	  
38.	  let n = headers.length;  
39.	  // If parser.maxHeaderPairs <= 0 assume that there's no limit.
40.	  if (parser.maxHeaderPairs > 0)  
41.	    n = MathMin(n, parser.maxHeaderPairs);  
42.	  // 更新到保存HTTP头的对象   
43.	  incoming._addHeaderLines(headers, n);  
44.	  // 请求方法或响应行信息  
45.	  if (typeof method === 'number') {  
46.	    // server only  
47.	    incoming.method = methods[method];  
48.	  } else {  
49.	    // client only  
50.	    incoming.statusCode = statusCode;  
51.	    incoming.statusMessage = statusMessage;  
52.	  }  
53.	  // 执行回调  
54.	  return parser.onIncoming(incoming, shouldKeepAlive);  
55.	}  
```

我们看到解析完头部后会执行另一个回调onIncoming，并传入IncomingMessage实例，这就是我们平时使用的res。在前面分析过，onIncoming设置的值是parserOnIncomingClient。

```
1.	function parserOnIncomingClient(res, shouldKeepAlive) {  
2.	  const socket = this.socket;  
3.	  // 请求对象  
4.	  const req = socket._httpMessage;  
5.	  // 服务器发送了多个响应  
6.	  if (req.res) {  
7.	    socket.destroy();  
8.	    return 0;    
9.	  }  
10.	  req.res = res;  
11.	  
12.	  if (statusIsInformational(res.statusCode)) {  
13.	    req.res = null;   
14.	    // 请求时设置了expect头，则响应码为100，可以继续发送数据  
15.	    if (res.statusCode === 100) {  
16.	      req.emit('continue');  
17.	    }  
18.	    return 1;   
19.	  }  
20.	  
21.	  req.res = res;  
22.	  res.req = req;  
23.	  
24.	  // 等待响应结束，响应结束后会清除定时器  
25.	  res.on('end', responseOnEnd);  
26.	  // 请求终止了或触发response事件，返回false说明没有监听response事件，则丢弃数据  
27.	  if (req.aborted || !req.emit('response', res))  
28.	    res._dump();  
29.	  
30.	}  
```

从源码中我们看出在解析完HTTP响应头时，就执行了http.request设置的回调函数。例如下面代码中的回调。

```
1.	http. request('domain', { agent }, (res) => {  
2.	    // 解析body
3.	    res.on('data', (data) => {  
4.	      //   
5.	    });
6.	     // 解析body结束，响应结束
7.	     res.on('end', (data) => {  
8.	      //   
9.	    });  
10.	});  
11.	// ...
```

在回调里我们可以把res作为一个流使用，在解析完HTTP头后，HTTP解析器会继续解析HTTP body。我们看一下HTTP解析器在解析body过程中执行的回调。

```
1.	function parserOnBody(b, start, len) {  
2.	  const stream = this.incoming;  
3.	  if (len > 0 && !stream._dumped) {  
4.	    const slice = b.slice(start, start + len);  
5.	    // 把数据push到流中，流会触发data事件  
6.	    const ret = stream.push(slice);  
7.	    // 数据过载，暂停接收  
8.	    if (!ret)  
9.	      readStop(this.socket);  
10.	  }  
11.	}  
```

最后我们再看一下解析完body时HTTP解析器执行的回调。

```
1.	function parserOnMessageComplete() {  
2.	  const parser = this;  
3.	  const stream = parser.incoming;  
4.	  
5.	  if (stream !== null) {  
6.	    // body解析完了  
7.	    stream.complete = true;  
8.	    // 在body后可能有trailer头，保存下来  
9.	    const headers = parser._headers;  
10.	    if (headers.length) {  
11.	      stream._addHeaderLines(headers, headers.length);  
12.	      parser._headers = [];  
13.	      parser._url = '';  
14.	    }  
15.	    // 流结束  
16.	    stream.push(null);  
17.	  }  
18.	  
19.	  // 读取下一个响应，如果有的话  
20.	  readStart(parser.socket);  
21.	}  
```

我们看到在解析body过程中会不断往流中push数据，从而不断触发res的data事件，最后解析body结束后，通过push(null)通知流结束，从而触发res.end事件。我们沿着onSocket函数分析完处理响应后我们再来分析请求的过程。执行完http.request后我们会得到一个标记请求的实例。然后执行它的write方法发送数据。

```
1.	OutgoingMessage.prototype.write = function write(chunk, encoding, callback) {  
2.	  const ret = write_(this, chunk, encoding, callback, false);  
3.	  // 返回false说明需要等待drain事件  
4.	  if (!ret)  
5.	    this[kNeedDrain] = true;  
6.	  return ret;  
7.	};  
8.	  
9.	function write_(msg, chunk, encoding, callback, fromEnd) {  
10.	    
11.	  // 还没有设置this._header字段，则把请求行和HTTP头拼接到this._header字段  
12.	  if (!msg._header) {  
13.	    msg._implicitHeader();  
14.	  }  
15.	    
16.	  let ret;  
17.	  // chunk模式则需要额外加一下字段，否则直接发送  
18.	  if (msg.chunkedEncoding && chunk.length !== 0) {  
19.	    let len;  
20.	    if (typeof chunk === 'string')  
21.	      len = Buffer.byteLength(chunk, encoding);  
22.	    else  
23.	      len = chunk.length;  
24.	    /* 
25.	      chunk模式时，http报文的格式如下 
26.	      chunk长度 回车换行 
27.	      数据 回车换行 
28.	    */  
29.	    msg._send(len.toString(16), 'latin1', null);  
30.	    msg._send(crlf_buf, null, null);  
31.	    msg._send(chunk, encoding, null);  
32.	    ret = msg._send(crlf_buf, null, callback);  
33.	  } else {  
34.	    ret = msg._send(chunk, encoding, callback);  
35.	  }  
36.	  
37.	  return ret;  
38.	}  
```

我们接着看_send函数

```
1.	OutgoingMessage.prototype._send = function _send(data, encoding, callback) {  
2.	  // 头部还没有发送  
3.	  if (!this._headerSent) {  
4.	    // 是字符串则追加到头部，this._header保存了HTTP请求行和HTTP头  
5.	    if (typeof data === 'string' &&  
6.	        (encoding === 'utf8' || 
7.	         encoding === 'latin1' || 
8.	         !encoding)) {  
9.	      data = this._header + data;  
10.	    } else {  
11.	      // 否则缓存起来  
12.	      const header = this._header;  
13.	      // HTTP头需要放到最前面  
14.	      if (this.outputData.length === 0) {  
15.	        this.outputData = [{  
16.	          data: header,  
17.	          encoding: 'latin1',  
18.	          callback: null  
19.	        }];  
20.	      } else {  
21.	        this.outputData.unshift({  
22.	          data: header,  
23.	          encoding: 'latin1',  
24.	          callback: null  
25.	        });  
26.	      }  
27.	      // 更新缓存大小  
28.	      this.outputSize += header.length;  
29.	      this._onPendingData(header.length);  
30.	    }  
31.	    // 已经在排队等待发送了，不能修改  
32.	    this._headerSent = true;  
33.	  }  
34.	  return this._writeRaw(data, encoding, callback);  
35.	};  
```

我们继续看_writeRaw

```
1.	OutgoingMessage.prototype._writeRaw = function _writeRaw(data, encoding, callback) {  
2.	    
3.	  // 可写的时候直接发送  
4.	  if (conn && conn._httpMessage === this && conn.writable) {  
5.	    // There might be pending data in the this.output buffer.  
6.	    // 如果有缓存的数据则先发送缓存的数据  
7.	    if (this.outputData.length) {  
8.	      this._flushOutput(conn);  
9.	    }  
10.	    // 接着发送当前需要发送的  
11.	    return conn.write(data, encoding, callback);  
12.	  }  
13.	  // 否先缓存  
14.	  this.outputData.push({ data, encoding, callback });  
15.	  this.outputSize += data.length;  
16.	  this._onPendingData(data.length);  
17.	  return this.outputSize < HIGH_WATER_MARK;  
18.	}  
19.	  
20.	OutgoingMessage.prototype._flushOutput = function _flushOutput(socket) {  
21.	  // 之前设置了加塞，则操作socket先积攒数据  
22.	  while (this[kCorked]) {  
23.	    this[kCorked]--;  
24.	    socket.cork();  
25.	  }  
26.	  
27.	  const outputLength = this.outputData.length;  
28.	  if (outputLength <= 0)  
29.	    return undefined;  
30.	  
31.	  const outputData = this.outputData;  
32.	  socket.cork();  
33.	  // 把缓存的数据写到socket  
34.	  let ret;  
35.	  for (let i = 0; i < outputLength; i++) {  
36.	    const { data, encoding, callback } = outputData[i];  
37.	    ret = socket.write(data, encoding, callback);  
38.	  }  
39.	  socket.uncork();  
40.	  
41.	  this.outputData = [];  
42.	  this._onPendingData(-this.outputSize);  
43.	  this.outputSize = 0;  
44.	  
45.	  return ret;  
46.	};  
```

写完数据后，我们还需要执行end函数标记HTTP请求的结束。

```
1.	OutgoingMessage.prototype.end = function end(chunk, encoding, callback) {  
2.	  // 还没结束  
3.	  // 加塞  
4.	  if (this.socket) {  
5.	    this.socket.cork();  
6.	  }  
7.	  
8.	  // 流结束后回调  
9.	  if (typeof callback === 'function')  
10.	    this.once('finish', callback);  
11.	  // 数据写入底层后的回调  
12.	  const finish = onFinish.bind(undefined, this);  
13.	  // chunk模式后面需要发送一个0\r\n结束标记，否则不需要结束标记  
14.	  if (this._hasBody && this.chunkedEncoding) {  
15.	    this._send('0\r\n' + 
16.	                this._trailer + '\r\n', 'latin1', finish);  
17.	  } else {  
18.	    this._send('', 'latin1', finish);  
19.	  }  
20.	  // uncork解除塞子，发送数据  
21.	  if (this.socket) {  
22.	    // Fully uncork connection on end().  
23.	    this.socket._writableState.corked = 1;  
24.	    this.socket.uncork();  
25.	  }  
26.	  this[kCorked] = 0;  
27.	  // 标记执行了end  
28.	  this.finished = true;  
29.	  // 数据发完了  
30.	  if (this.outputData.length === 0 &&  
31.	      this.socket &&  
32.	      this.socket._httpMessage === this) {  
33.	    this._finish();  
34.	  }  
35.	  
36.	  return this;  
37.	};  
```

## 18.3 HTTP服务器
本节我们来分析使用Node.js作为服务器的例子。

```
1.	const http = require('http');  
2.	http.createServer((req, res) => {  
3.	  res.write('hello');  
4.	  res.end();  
5.	})  
6.	.listen(3000);  
```

接着我们沿着createServer分析Node.js作为服务器的原理。

```
1.	function createServer(opts, requestListener) {  
2.	  return new Server(opts, requestListener);  
3.	}  
```

我们看Server的实现

```
1.	function Server(options, requestListener) {  
2.	  // 可以自定义表示请求的对象和响应的对象  
3.	  this[kIncomingMessage] = options.IncomingMessage || IncomingMessage;  
4.	  this[kServerResponse] = options.ServerResponse || ServerResponse;  
5.	  // HTTP头个数的阈值  
6.	  const maxHeaderSize = options.maxHeaderSize;  
7.	  this.maxHeaderSize = maxHeaderSize;  
8.	  // 允许半关闭  
9.	  net.Server.call(this, { allowHalfOpen: true });  
10.	  // 有请求时的回调  
11.	  if (requestListener) {  
12.	    this.on('request', requestListener);  
13.	  }  
14.	  // 服务器socket读端关闭时是否允许继续处理队列里的响应（tcp上有多个请求，管道化）  
15.	  this.httpAllowHalfOpen = false;  
16.	  // 有连接时的回调，由net模块触发  
17.	  this.on('connection', connectionListener);  
18.	  // 服务器下所有请求和响应的超时时间  
19.	  this.timeout = 0;  
20.	  // 同一个TCP连接上，两个请求之前最多间隔的时间   
21.	  this.keepAliveTimeout = 5000;  
22.	  this.maxHeadersCount = null;  
23.	  // 解析头部的超时时间，防止ddos  
24.	  this.headersTimeout = 60 * 1000; // 60 seconds  
25.	}  
```

接着调用listen函数，因为HTTP Server继承于net.Server，net.Server的listen函数前面我们已经分析过，就不再分析。当有请求到来时，会触发connection事件。从而执行connectionListener。

```
1.	function connectionListener(socket) {  
2.	  defaultTriggerAsyncIdScope(  
3.	    getOrSetAsyncId(socket), connectionListenerInternal, this, socket  
4.	  );  
5.	}  
6.	  
7.	// socket表示新连接  
8.	function connectionListenerInternal(server, socket) {  
9.	  // socket所属server  
10.	  socket.server = server;  
11.	  // 设置连接的超时时间，超时处理函数为socketOnTimeout  
12.	  if (server.timeout && typeof socket.setTimeout === 'function')     socket.setTimeout(server.timeout);  
13.	  socket.on('timeout', socketOnTimeout);  
14.	  // 分配一个HTTP解析器  
15.	  const parser = parsers.alloc();  
16.	  // 解析请求报文  
17.	  parser.initialize(  
18.	    HTTPParser.REQUEST,  
19.	    new HTTPServerAsyncResource('HTTPINCOMINGMESSAGE', socket), 
20.	    server.maxHeaderSize || 0,  
21.	    server.insecureHTTPParser === undefined ?  
22.	      isLenient() : server.insecureHTTPParser,  
23.	  );  
24.	  parser.socket = socket;  
25.	  // 记录开始解析头部的开始时间  
26.	  parser.parsingHeadersStart = nowDate();  
27.	  socket.parser = parser;  
28.	  if (typeof server.maxHeadersCount === 'number') {  
29.	    parser.maxHeaderPairs = server.maxHeadersCount << 1;  
30.	  }  
31.	  
32.	  const state = {  
33.	    onData: null,  
34.	    onEnd: null,  
35.	    onClose: null,  
36.	    onDrain: null,  
37.	    // 同一TCP连接上，请求和响应的的队列，线头阻塞的原理  
38.	    outgoing: [],  
39.	    incoming: [],  
40.	    // 待发送的字节数，如果超过阈值，则先暂停接收请求的数据  
41.	    outgoingData: 0,  
42.	    /*
43.	      是否重新设置了timeout，用于响应一个请求时，
44.	      标记是否重新设置超时时间的标记  
45.	    */
46.	    keepAliveTimeoutSet: false  
47.	  };  
48.	  // 监听tcp上的数据，开始解析http报文  
49.	  state.onData = socketOnData.bind(undefined, 
50.	                                      server, 
51.	                                      socket, 
52.	                                      parser, 
53.	                                      state);  
54.	  state.onEnd = socketOnEnd.bind(undefined,
55.	                                    server, 
56.	                                    socket, 
57.	                                    parser, 
58.	                                    state);  
59.	  state.onClose = socketOnClose.bind(undefined, socket, state);  
60.	  state.onDrain = socketOnDrain.bind(undefined, socket, state);  
61.	  socket.on('data', state.onData);  
62.	  socket.on('error', socketOnError);  
63.	  socket.on('end', state.onEnd);  
64.	  socket.on('close', state.onClose);  
65.	  socket.on('drain', state.onDrain);  
66.	  // 解析HTTP头部完成后执行的回调  
67.	  parser.onIncoming = parserOnIncoming.bind(undefined, 
68.	                                                server, 
69.	                                                socket, 
70.	                                                state);  
71.	  socket.on('resume', onSocketResume);  
72.	  socket.on('pause', onSocketPause);  
73.	  
74.	  /*
75.	    如果handle是继承StreamBase的流则执行consume消费http
76.	    请求报文，而不是上面的onData，tcp模块的isStreamBase为true 
77.	  */
78.	  if (socket._handle && socket._handle.isStreamBase &&  
79.	      !socket._handle._consumed) {  
80.	    parser._consumed = true;  
81.	    socket._handle._consumed = true;  
82.	    parser.consume(socket._handle);  
83.	  }  
84.	  parser[kOnExecute] =  
85.	    onParserExecute.bind(undefined, 
86.	                           server, 
87.	                           socket, 
88.	                           parser, 
89.	                           state);  
90.	  
91.	  socket._paused = false;  
92.	}  
```

执行完connectionListener后就开始等待tcp上数据的到来，即HTTP请求报文。上面代码中Node.js监听了socket的data事件，同时注册了钩子kOnExecute。data事件我们都知道是流上有数据到来时触发的事件。我们看一下socketOnData做了什么事情。

```
1.	function socketOnData(server, socket, parser, state, d) {  
2.	  // 交给HTTP解析器处理，返回已经解析的字节数  
3.	  const ret = parser.execute(d);  
4.	  onParserExecuteCommon(server, socket, parser, state, ret, d);  
5.	}  
```

socketOnData的处理逻辑是当socket上有数据，然后交给HTTP解析器处理。这看起来没什么问题，那么kOnExecute是做什么的呢？kOnExecute钩子函数的值是onParserExecute，这个看起来也是解析tcp上的数据的，看起来和onSocketData是一样的作用，难道tcp上的数据有两个消费者？我们看一下kOnExecute什么时候被回调的。

```
1.	void OnStreamRead(ssize_t nread, const uv_buf_t& buf) override {  
2.	     
3.	    Local<Value> ret = Execute(buf.base, nread);  
4.	    Local<Value> cb =  
5.	        object()->Get(env()->context(), kOnExecute).ToLocalChecked();  
6.	    MakeCallback(cb.As<Function>(), 1, &ret);  
7.	  }  
```

OnStreamRead是node_http_parser.cc实现的函数，所以kOnExecute在node_http_parser.cc中的OnStreamRead中被回调，那么OnStreamRead又是什么时候被回调的呢？在C++层章节我们分析过，OnStreamRead是Node.js中C++层流操作的通用函数，当流有数据的时候就会执行该回调。而且OnStreamRead中也会把数据交给HTTP解析器解析。这看起来真的有两个消费者？这就很奇怪，为什么一份数据会交给HTTP解析器处理两次？ 

```
1.	if (socket._handle && socket._handle.isStreamBase && !socket._handle._consumed) {  
2.	  parser._consumed = true;  
3.	  socket._handle._consumed = true;  
4.	  parser.consume(socket._handle);  
5.	}  
```

因为TCP流是继承StreamBase类的，所以if成立。我们看一下consume的实现。

```
1.	static void Consume(const FunctionCallbackInfo<Value>& args) {  
2.	  Parser* parser;  
3.	  ASSIGN_OR_RETURN_UNWRAP(&parser, args.Holder());  
4.	  CHECK(args[0]->IsObject());  
5.	  StreamBase* stream = StreamBase::FromObjject(args[0].As<Object>());  
6.	  CHECK_NOT_NULL(stream);  
7.	  stream->PushStreamListener(parser);  
8.	}  
```

HTTP解析器把自己注册为TCP stream的一个listener。这会使得TCP流上的数据由node_http_parser.cc的OnStreamRead直接消费，而不是触发onData事件。在OnStreamRead中会源源不断地把数据交给HTTP解析器处理，在解析的过程中，会不断触发对应的钩子函数，直到解析完HTTP头部后执行parserOnIncoming。

```
1.	function parserOnIncoming(server, socket, state, req, keepAlive) {  
2.	  // 需要重置定时器  
3.	  resetSocketTimeout(server, socket, state);  
4.	  // 设置了keepAlive则响应后需要重置一些状态  
5.	  if (server.keepAliveTimeout > 0) {  
6.	    req.on('end', resetHeadersTimeoutOnReqEnd);  
7.	  }  
8.	  
9.	  // 标记头部解析完毕  
10.	  socket.parser.parsingHeadersStart = 0;  
11.	  
12.	  // 请求入队（待处理的请求队列）  
13.	  state.incoming.push(req);  
14.	  
15.	  if (!socket._paused) {  
16.	    const ws = socket._writableState;  
17.	    // 待发送的数据过多，先暂停接收请求数据  
18.	    if (ws.needDrain || 
19.	        state.outgoingData >= socket.writableHighWaterMark) {  
20.	      socket._paused = true;  
21.	      socket.pause();  
22.	    }  
23.	  }  
24.	  // 新建一个表示响应的对象  
25.	  const res = new server[kServerResponse](req);  
26.	  // 设置数据写入待发送队列时触发的回调，见OutgoingMessage  
27.	  res._onPendingData = updateOutgoingData.bind(undefined, 
28.	                                                    socket, 
29.	                                                    state);  
30.	  // 根据请求的HTTP头设置是否支持keepalive（管道化）  
31.	  res.shouldKeepAlive = keepAlive;  
32.	  /*
33.	     socket当前已经在处理其它请求的响应，则先排队，
34.	     否则挂载响应对象到socket，作为当前处理的响应  
35.	  */
36.	  if (socket._httpMessage) {  
37.	    state.outgoing.push(res);  
38.	  } else {  
39.	    res.assignSocket(socket);  
40.	  }  
41.	  
42.	  // 响应处理完毕后，需要做一些处理  
43.	  res.on('finish',  
44.	         resOnFinish.bind(undefined, 
45.	                            req, 
46.	                            res, 
47.	                            socket, 
48.	                            state, 
49.	                            server));  
50.	  // 有expect请求头，并且是http1.1  
51.	  if (req.headers.expect !== undefined &&  
52.	      (req.httpVersionMajor === 1 && 
53.	       req.httpVersionMinor === 1)
54.	     ) {  
55.	    // Expect头的值是否是100-continue  
56.	    if (continueExpression.test(req.headers.expect)) {  
57.	      res._expect_continue = true;  
58.	      /*
59.	        监听了checkContinue事件则触发，
60.	        否则直接返回允许继续请求并触发request事件
61.	       */  
62.	      if (server.listenerCount('checkContinue') > 0) {  
63.	        server.emit('checkContinue', req, res);  
64.	      } else {  
65.	        res.writeContinue();  
66.	        server.emit('request', req, res);  
67.	      }  
68.	    } else if (server.listenerCount('checkExpectation') > 0) {  
69.	      /*
70.	        值异常，监听了checkExpectation事件，
71.	        则触发，否则返回417拒绝请求 
72.	       */ 
73.	      server.emit('checkExpectation', req, res);  
74.	    } else {  
75.	      res.writeHead(417);  
76.	      res.end();  
77.	    }  
78.	  } else {  
79.	    // 触发request事件说明有请求到来  
80.	    server.emit('request', req, res);  
81.	  }  
82.	  return 0;  // No special treatment.  
83.	}  
```

我们看到这里会触发request事件通知用户有新请求到来，用户就可以处理请求了。我们看到Node.js解析头部的时候就会执行上层回调，通知有新请求到来，并传入request和response作为参数，分别对应的是表示请求和响应的对象。另外Node.js本身是不会解析body部分的，我们可以通过以下方式获取body的数据。

```
1.	const server = http.createServer((request, response) => {  
2.	  request.on('data', (chunk) => {  
3.	   // 处理body  
4.	  });  
5.	  request.on('end', () => {  
6.	   // body结束  
7.	  });  
8.	})  
```

### 18.3.1 HTTP管道化的原理和实现
HTTP1.0的时候，不支持管道化，客户端发送一个请求的时候，首先建立TCP连接，然后服务器返回一个响应，最后断开TCP连接，这种是最简单的实现方式，但是每次发送请求都需要走三次握手显然会带来一定的时间损耗，所以HTTP1.1的时候，支持了管道化。管道化的意思就是可以在一个TCP连接上发送多个请求，这样服务器就可以同时处理多个请求，但是由于HTTP1.1的限制，多个请求的响应需要按序返回。因为在HTTP1.1中，没有标记请求和响应的对应关系。所以HTTP客户端会假设第一个返回的响应是对应第一个请求的。如果乱序返回，就会导致问题，如图18-2所示。  
![](https://img-blog.csdnimg.cn/e7bc0bded22c414cb3214d4022425dfb.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图18-2  
而在HTTP 2.0中，每个请求会分配一个id，响应中也会返回对应的id，这样就算乱序返回，HTTP客户端也可以知道响应所对应的请求。在HTTP 1.1这种情况下，HTTP服务器的实现就会变得复杂，服务器可以以串行的方式处理请求，当前面请求的响应返回到客户端后，再继续处理下一个请求，这种实现方式是相对简单的，但是很明显，这种方式相对来说还是比较低效的，另一种实现方式是并行处理请求，串行返回，这样可以让请求得到尽快的处理，比如两个请求都访问数据库，那并行处理两个请求就会比串行快得多，但是这种实现方式相对比较复杂，Node.js就是属于这种方式，下面我们来看一下Node.js中是如何实现的。前面分析过，Node.js在解析完HTTP头部的时候会执行parserOnIncoming。

```
1.	function parserOnIncoming(server, socket, state, req, keepAlive) {  
2.	  // 标记头部解析完毕  
3.	  socket.parser.parsingHeadersStart = 0;  
4.	  // 请求入队  
5.	  state.incoming.push(req);  
6.	  // 新建一个表示响应的对象，一般是ServerResponse  
7.	  const res = new server[kServerResponse](req);  
8.	  /*
9.	    socket当前已经在处理其它请求的响应，则先排队，
10.	   否则挂载响应对象到socket，作为当前处理的响应
11.	  */  
12.	  if (socket._httpMessage) {  
13.	    state.outgoing.push(res);  
14.	  } else {  
15.	    res.assignSocket(socket); // socket._httpMessage = res;  
16.	  }  
17.	  // 响应处理完毕后，需要做一些处理  
18.	  res.on('finish', resOnFinish.bind(undefined, 
19.	                                        req, 
20.	                                        res, 
21.	                                        socket, 
22.	                                        state, 
23.	                                        server));  
24.	  // 触发request事件说明有请求到来  
25.	  server.emit('request', req, res);  
26.	  return 0;  
27.	}  
```

当Node.js解析HTTP请求头完成后，就会创建一个ServerResponse对象表示响应。然后判断当前是否有正在处理的响应，如果有则排队等待处理，否则把新建的ServerResponse对象作为当前需要处理的响应。最后触发request事件通知用户层。用户就可以进行请求的处理了。我们看到Node.js维护了两个队列，分别是请求和响应队列，如图18-3所示。  
![](https://img-blog.csdnimg.cn/a99cf25b0c094f07b193a7d996535ce0.png)  
图18-3  
当前处理的请求在请求队列的队首，该请求对应的响应会挂载到socket的_httpMessage属性上。但是我们看到Node.js会触发request事件通知用户有新请求到来，所有在管道化的情况下，Node.js会并行处理多个请求（如果是cpu密集型的请求则实际上还是会变成串行，这和Node.js的单线程相关）。那Node.js是如何控制响应的顺序的呢？我们知道每次触发request事件的时候，我们都会执行一个函数。比如下面的代码。

```
1.	 http.createServer((req, res) => {  
2.	  // 一些网络IO  
3.	  res.writeHead(200, { 'Content-Type': 'text/plain' });  
4.	  res.end('okay');  
5.	});  
```

我们看到每个请求的处理是独立的。假设每个请求都去操作数据库，如果请求2比请求1先完成数据库的操作，从而请求2先执行res.write和res.end。那岂不是请求2先返回？我们看一下ServerResponse和OutgoingMessage的实现，揭开迷雾。ServerResponse是OutgoingMessage的子类。write函数是在OutgoingMessage中实现的，write的调用链路很长，我们不层层分析，直接看最后的节点。

```
1.	function _writeRaw(data, encoding, callback) {  
2.	  const conn = this.socket;  
3.	  // socket对应的响应是自己并且可写  
4.	  if (conn && conn._httpMessage === this && conn.writable) {  
5.	    // 如果有缓存的数据则先发送缓存的数据  
6.	    if (this.outputData.length) {  
7.	      this._flushOutput(conn);  
8.	    }  
9.	    // 接着发送当前需要发送的  
10.	    return conn.write(data, encoding, callback);  
11.	  }  
12.	  // socket当前处理的响应对象不是自己，则先缓存数据。  
13.	  this.outputData.push({ data, encoding, callback });  
14.	  this.outputSize += data.length;  
15.	  this._onPendingData(data.length);  
16.	  return this.outputSize < HIGH_WATER_MARK;  
17.	}  
```

我们看到我们调用res.write的时候，Node.js会首先判断，res是不是属于当前处理中响应，如果是才会真正发送数据，否则会先把数据缓存起来。分析到这里，相信大家已经差不多明白Node.js是如何控制响应按序返回的。最后我们看一下这些缓存的数据什么时候会被发送出去。前面代码已经贴过，当一个响应结束的时候，Node.js会做一些处理。

```
1.	res.on('finish', resOnFinish.bind(undefined, 
2.	                                     req, 
3.	                                     res, 
4.	                                     socket, 
5.	                                     state, 
6.	                                     server));  
```

我们看看resOnFinish

```
1.	function resOnFinish(req, res, socket, state, server) {  
2.	  // 删除响应对应的请求  
3.	  state.incoming.shift();  
4.	  clearIncoming(req);  
5.	  // 解除socket上挂载的响应对象  
6.	  res.detachSocket(socket);  
7.	  req.emit('close');  
8.	  process.nextTick(emitCloseNT, res);  
9.	  // 是不是最后一个响应  
10.	  if (res._last) {  
11.	    // 是则销毁socket  
12.	    if (typeof socket.destroySoon === 'function') {  
13.	      socket.destroySoon();  
14.	    } else {  
15.	      socket.end();  
16.	    }  
17.	  } else if (state.outgoing.length === 0) {  
18.	    /*
19.	      没有待处理的响应了，则重新设置超时时间，
20.	      等待请求的到来，一定时间内没有请求则触发timeout事件
21.	    */  
22.	    if (server.keepAliveTimeout && 
23.	         typeof socket.setTimeout === 'function') {  
24.	      socket.setTimeout(server.keepAliveTimeout);  
25.	      state.keepAliveTimeoutSet = true;  
26.	    }  
27.	  } else {  
28.	    // 获取下一个要处理的响应  
29.	    const m = state.outgoing.shift();  
30.	    // 挂载到socket作为当前处理的响应  
31.	    if (m) {  
32.	      m.assignSocket(socket);  
33.	    }  
34.	  }  
35.	}  
```

我们看到，Node.js处理完一个响应后，会做一些判断。分别有三种情况，我们分开分析。  
1 是否是最后一个响应  
什么情况下，会被认为是最后一个响应的？因为响应和请求是一一对应的，最后一个响应就意味着最后一个请求了，那么什么时候被认为是最后一个请求呢？当非管道化的情况下，一个请求一个响应，然后关闭TCP连接，所以非管道化的情况下，tcp上的第一个也是唯一一个请求就是最后一个请求。在管道化的情况下，理论上就没有所谓的最后一个响应。但是实现上会做一些限制。在管道化的情况下，每一个响应可以通过设置HTTP响应头connection来定义是否发送该响应后就断开连接，我们看一下Node.js的实现。

```
1.	// 是否显示删除过connection头，是则响应后断开连接，并标记当前响应是最后一个  
2.	 if (this._removedConnection) {  
3.	   this._last = true;  
4.	   this.shouldKeepAlive = false;  
5.	 } else if (!state.connection) {  
6.	   /* 
7.	    没有显示设置了connection头，则取默认行为 
8.	    1 Node.js的shouldKeepAlive默认为true，也可以根据请求报文里
9.	      的connection头定义
10.	   2 设置content-length或使用chunk模式才能区分响应报文编边界，
11.	      才能支持keepalive 
12.	   3 使用了代理，代理是复用TCP连接的，支持keepalive 
13.	   */  
14.	   const shouldSendKeepAlive = this.shouldKeepAlive &&  
15.	       (state.contLen || 
16.	         this.useChunkedEncodingByDefault || 
17.	         this.agent);  
18.	   if (shouldSendKeepAlive) {  
19.	     header += 'Connection: keep-alive\r\n';  
20.	   } else {  
21.	     this._last = true;  
22.	     header += 'Connection: close\r\n';  
23.	   }  
24.	 }  
```

另外当读端关闭的时候，也被认为是最后一个请求，毕竟不会再发送请求了。我们看一下读端关闭的逻辑。

```
1.	function socketOnEnd(server, socket, parser, state) {  
2.	  const ret = parser.finish();  
3.	  
4.	  if (ret instanceof Error) {  
5.	    socketOnError.call(socket, ret);  
6.	    return;  
7.	  }  
8.	  // 不允许半开关则终止请求的处理，不响应，关闭写端  
9.	  if (!server.httpAllowHalfOpen) {  
10.	    abortIncoming(state.incoming);  
11.	    if (socket.writable) socket.end();  
12.	  } else if (state.outgoing.length) {  
13.	    /*
14.	      允许半开关，并且还有响应需要处理，
15.	      标记响应队列最后一个节点为最后的响应，
16.	      处理完就关闭socket写端
17.	    */  
18.	    state.outgoing[state.outgoing.length - 1]._last = true;  
19.	  } else if (socket._httpMessage) {  
20.	    /*
21.	      没有等待处理的响应了，但是还有正在处理的响应，
22.	      则标记为最后一个响应
23.	     */  
24.	    socket._httpMessage._last = true;  
25.	  } else if (socket.writable) {  
26.	    // 否则关闭socket写端  
27.	    socket.end();  
28.	  }  
29.	}  
```

以上就是Node.js中判断是否是最后一个响应的情况，如果一个响应被认为是最后一个响应，那么发送响应后就会关闭连接。  
2 响应队列为空  
我们继续看一下如果不是最后一个响应的时候，Node.js又是怎么处理的。如果当前的待处理响应队列为空，说明当前处理的响应是目前最后一个需要处理的，但是不是TCP连接上最后一个响应，这时候，Node.js会设置超时时间，如果超时还没有新的请求，则Node.js会关闭连接。  
3 响应队列非空  
如果当前待处理队列非空，处理完当前请求后会继续处理下一个响应。并从队列中删除该响应。我们看一下Node.js是如何处理下一个响应的。
```
1.	// 把响应对象挂载到socket，标记socket当前正在处理的响应  
2.	ServerResponse.prototype.assignSocket = function assignSocket(socket) {  
3.	  // 挂载到socket上，标记是当前处理的响应  
4.	  socket._httpMessage = this;  
5.	  socket.on('close', onServerResponseClose);  
6.	  this.socket = socket;  
7.	  this.emit('socket', socket);  
8.	  this._flush();  
9.	};  
```

我们看到Node.js是通过_httpMessage标记当前处理的响应的，配合响应队列来实现响应的按序返回。标记完后执行_flush发送响应的数据（如果这时候请求已经被处理完成）

```
1.	OutgoingMessage.prototype._flush = function _flush() {  
2.	  const socket = this.socket;  
3.	  if (socket && socket.writable) {  
4.	    const ret = this._flushOutput(socket);  
5.	};  
6.	  
7.	OutgoingMessage.prototype._flushOutput = function _flushOutput(socket) {  
8.	  // 之前设置了加塞，则操作socket先积攒数据  
9.	  while (this[kCorked]) {  
10.	    this[kCorked]--;  
11.	    socket.cork();  
12.	  }  
13.	  
14.	  const outputLength = this.outputData.length;  
15.	  // 没有数据需要发送  
16.	  if (outputLength <= 0)  
17.	    return undefined;  
18.	  
19.	  const outputData = this.outputData;  
20.	  // 加塞，让数据一起发送出去  
21.	  socket.cork();  
22.	  // 把缓存的数据写到socket  
23.	  let ret;  
24.	  for (let i = 0; i < outputLength; i++) {  
25.	    const { data, encoding, callback } = outputData[i];  
26.	    ret = socket.write(data, encoding, callback);  
27.	  }  
28.	  socket.uncork();  
29.	  
30.	  this.outputData = [];  
31.	  this._onPendingData(-this.outputSize);  
32.	  this.outputSize = 0;  
33.	  
34.	  return ret;  
35.	}  
```

以上就是Node.js中对于管道化的实现。
### 18.3.2 HTTP Connect方法的原理和实现
分析HTTP Connect实现之前我们首先看一下为什么需要HTTP Connect方法或者说它出现的背景。Connect方法主要用于代理服务器的请求转发。我们看一下传统HTTP服务器的工作原理，如图18-4所示。  
![](https://img-blog.csdnimg.cn/11224eaeaafc4b03b65f211698f29895.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图18-4  
1 客户端和代理服务器建立TCP连接  
2 客户端发送HTTP请求给代理服务器  
3 代理服务器解析HTTP协议，根据配置拿到业务服务器的地址  
4 代理服务器和业务服务器建立TCP连接，通过HTTP协议或者其它协议转发请求  
5 业务服务器返回数据，代理服务器回复HTTP报文给客户端。  

接着我们看一下HTTPS服务器的原理。  
1 客户端和服务器建立TCP连接  
2 服务器通过TLS报文返回证书信息，并和客户端完成后续的TLS通信。  
3 完成TLS通信后，后续发送的HTTP报文会经过TLS层加密解密后再传输。  

那么如果我们想实现一个HTTPS的代理服务器怎么做呢？因为客户端只管和直接相连的服务器进行HTTPS的通信，如果我们的业务服务器前面还有代理服务器，那么代理服务器就必须要有证书才能和客户端完成TLS握手，从而进行HTTPS通信。代理服务器和业务服务器使用HTTP或者HTTPS还是其它协议都可以。这样就意味着我们所有的服务的证书都需要放到代理服务器上，这种场景的限制是，代理服务器和业务服务器都由我们自己管理或者公司统一管理。如果我们想加一个代理对业务服务器不感知那怎么办呢（比如写一个代理服务器用于开发调试）？有一种方式就是为我们的代理服务器申请一个证书，这样客户端和代理服务器就可以完成正常的HTTPS通信了。从而也就可以完成代理的功能。另外一种方式就是HTTP Connect方法。HTTP Connect方法的作用是指示服务器帮忙建立一条TCP连接到真正的业务服务器，并且透传后续的数据，这样不申请证书也可以完成代理的功能，如图18-5所示。  
![](https://img-blog.csdnimg.cn/31581e8d188e43c19402b00f6a635727.png)  
图18-5  
这时候代理服务器只负责透传两端的数据，不像传统的方式一样解析请求然后再转发。这样客户端和业务服务器就可以自己完成TLS握手和HTTPS通信。代理服务器就像不存在一样。了解了Connect的原理后看一下来自Node.js官方的一个例子。

```
1.	const http = require('http');  
2.	const net = require('net');  
3.	const { URL } = require('url');  
4.	// 创建一个HTTP服务器作为代理服务器  
5.	const proxy = http.createServer((req, res) => {  
6.	  res.writeHead(200, { 'Content-Type': 'text/plain' });  
7.	  res.end('okay');  
8.	});  
9.	// 监听connect事件，有http connect请求时触发  
10.	proxy.on('connect', (req, clientSocket, head) => {  
11.	  // 获取真正要连接的服务器地址并发起连接  
12.	  const { port, hostname } = new URL(`http://${req.url}`);  
13.	  const serverSocket = net.connect(port || 80, hostname, () => {  
14.	    // 连接成功告诉客户端  
15.	    clientSocket.write('HTTP/1.1 200 Connection Established\r\n' +  
16.	                    'Proxy-agent: Node.js-Proxy\r\n' +  
17.	                    '\r\n');  
18.	    // 透传客户端和服务器的数据    
19.	    serverSocket.write(head);              
20.	    serverSocket.pipe(clientSocket);  
21.	    clientSocket.pipe(serverSocket);  
22.	  });  
23.	});  
24.	  
25.	proxy.listen(1337, '127.0.0.1', () => {  
26.	  
27.	  const options = {  
28.	    port: 1337,  
29.	    // 连接的代理服务器地址  
30.	    host: '127.0.0.1',  
31.	    method: 'CONNECT',  
32.	    // 我们需要真正想访问的服务器地址  
33.	    path: 'www.baidu.com',  
34.	  };  
35.	  // 发起http connect请求  
36.	  const req = http.request(options);  
37.	  req.end();  
38.	  // connect请求成功后触发  
39.	  req.on('connect', (res, socket, head) => {  
40.	    // 发送真正的请求  
41.	    socket.write('GET / HTTP/1.1\r\n' +  
42.	                 'Host: www.baidu.com\r\n' +  
43.	                 'Connection: close\r\n' +  
44.	                 '\r\n');  
45.	    socket.on('data', (chunk) => {  
46.	      console.log(chunk.toString());  
47.	    });  
48.	    socket.on('end', () => {  
49.	      proxy.close();  
50.	    });  
51.	  });  
52.	});  
```

官网的这个例子很好地说明了Connect的原理，如图18-6所示。  
![](https://img-blog.csdnimg.cn/d0485b3ab36a46a9b549efa0992406fb.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图18-6  
下面我们看一下Node.js中Connect的实现。我们从HTTP Connect请求开始。之前已经分析过，客户端和Node.js服务器建立TCP连接后，Node.js收到数据的时候会交给HTTP解析器处理，

```
1.	// 连接上有数据到来  
2.	function socketOnData(server, socket, parser, state, d) {  
3.	  // 交给HTTP解析器处理，返回已经解析的字节数  
4.	  const ret = parser.execute(d);  
5.	  onParserExecuteCommon(server, socket, parser, state, ret, d);  
6.	}  
```

HTTP解析数据的过程中会不断回调Node.js的回调，然后执行onParserExecuteCommon。我们这里只关注当Node.js解析完所有HTTP请求头后执行parserOnHeadersComplete。

```
1.	function parserOnHeadersComplete(versionMajor, versionMinor, headers, method,  
2.	                                 url, statusCode, statusMessage, upgrade,  
3.	                                 shouldKeepAlive) {  
4.	  const parser = this;  
5.	  const { socket } = parser;  
6.	  
7.	  // IncomingMessage  
8.	  const ParserIncomingMessage = (socket && socket.server &&  
9.	                                 socket.server[kIncomingMessage]) ||  
10.	                                 IncomingMessage;  
11.	  // 新建一个IncomingMessage对象  
12.	  const incoming = parser.incoming = new ParserIncomingMessage(socket);  
13.	  incoming.httpVersionMajor = versionMajor;  
14.	  incoming.httpVersionMinor = versionMinor;  
15.	  incoming.httpVersion = `${versionMajor}.${versionMinor}`;  
16.	  incoming.url = url;  
17.	  // 是否是connect请求或者upgrade请求  
18.	  incoming.upgrade = upgrade;  
19.	  
20.	  // 执行回调  
21.	  return parser.onIncoming(incoming, shouldKeepAlive);  
22.	}  
```

我们看到解析完HTTP头后，Node.js会创建一个表示请求的对象IncomingMessage，然后回调onIncoming。

```
1.	function parserOnIncoming(server, socket, state, req, keepAlive) {  
2.	  // 请求是否是connect或者upgrade  
3.	  if (req.upgrade) {  
4.	    req.upgrade = req.method === 'CONNECT' ||  
5.	                  server.listenerCount('upgrade') > 0;  
6.	    if (req.upgrade)  
7.	      return 2;  
8.	  }  
9.	 // ...  
10.	}  
```

Node.js解析完头部并且执行了响应的钩子函数后，会执行onParserExecuteCommon。

```
1.	function onParserExecuteCommon(server, socket, parser, state, ret, d) {  
2.	  if (ret instanceof Error) {  
3.	    prepareError(ret, parser, d);  
4.	    ret.rawPacket = d || parser.getCurrentBuffer();  
5.	    socketOnError.call(socket, ret);  
6.	  } else if (parser.incoming && parser.incoming.upgrade) {  
7.	    // 处理Upgrade或者CONNECT请求  
8.	    const req = parser.incoming;  
9.	    const eventName = req.method === 'CONNECT' ? 
10.	                       'connect' : 'upgrade';  
11.	    // 监听了对应的事件则处理，否则关闭连接  
12.	    if (eventName === 'upgrade' || 
13.	        server.listenerCount(eventName) > 0) {  
14.	      // 还没有解析的数据  
15.	      const bodyHead = d.slice(ret, d.length);  
16.	      socket.readableFlowing = null;  
17.	      server.emit(eventName, req, socket, bodyHead);  
18.	    } else {  
19.	      socket.destroy();  
20.	    }  
21.	  }  
22.	}  
```

这时候Node.js会判断请求是不是Connect或者协议升级的upgrade请求，是的话继续判断是否有处理该事件的函数，没有则关闭连接，否则触发对应的事件进行处理。所以这时候Node.js会触发Connect方法。Connect事件的处理逻辑正如我们开始给出的例子中那样。我们首先和真正的服务器建立TCP连接，然后返回响应头给客户端，后续客户就可以和真正的服务器真正进行TLS握手和HTTPS通信了。这就是Node.js中Connect的原理和实现。

不过在代码中我们发现一个好玩的地方。那就是在触发connect事件的时候，Node.js给回调函数传入的参数。

```
1.	server.emit('connect', req, socket, bodyHead);  
```

第一第二个参数没什么特别的，但是第三个参数就有意思了，bodyHead代表的是HTTP Connect请求中除了请求行和HTTP头之外的数据。因为Node.js解析完HTTP头后就不继续处理了。把剩下的数据交给了用户。我们来做一些好玩的事情。

```
1.	const http = require('http');  
2.	const net = require('net');  
3.	const { URL } = require('url');  
4.	  
5.	const proxy = http.createServer((req, res) => {  
6.	  res.writeHead(200, { 'Content-Type': 'text/plain' });  
7.	  res.end('okay');  
8.	});  
9.	proxy.on('connect', (req, clientSocket, head) => {  
10.	  const { port, hostname } = new URL(`http://${req.url}`);  
11.	  const serverSocket = net.connect(port || 80, hostname, () => {  
12.	    clientSocket.write('HTTP/1.1 200 Connection Established\r\n' +  
13.	                    'Proxy-agent: Node.js-Proxy\r\n' +  
14.	                    '\r\n');  
15.	    // 把connect请求剩下的数据转发给服务器                 
16.	    serverSocket.write(head);  
17.	    serverSocket.pipe(clientSocket);  
18.	    clientSocket.pipe(serverSocket);  
19.	  });  
20.	});  
21.	  
22.	proxy.listen(1337, '127.0.0.1', () => {  
23.	  const net = require('net');  
24.	  const body = 'GET http://www.baidu.com:80 HTTP/1.1\r\n\r\n';  
25.	  const length = body.length;  
26.	  const socket = net.connect({host: '127.0.0.1', port: 1337});  
27.	  socket.write(`CONNECT www.baidu.com:80 HTTP/1.1\r\n\r\n${body}`);  
28.	  socket.setEncoding('utf-8');  
29.	  socket.on('data', (chunk) => {  
30.	   console.log(chunk)  
31.	  });  
32.	});  
```

我们新建一个socket，然后自己构造HTTP Connect报文，并且在HTTP行后面加一个额外的字符串，这个字符串是两一个HTTP请求。当Node.js服务器收到Connect请求后，我们在connect事件的处理函数中，把Connect请求多余的那一部分数据传给真正的服务器。这样就节省了发送一个请求的时间。
### 18.3.3 超时管理
在解析HTTP协议或者支持长连接的时候，Node.js需要设置一些超时的机制，否则会造成攻击或者资源浪费。下面我们看一下HTTP服务器中涉及到超时的一些逻辑。
1 解析HTTP头部超时  
当收到一个HTTP请求报文时，会从HTTP请求行，HTTP头，HTTP body的顺序进行解析，如果用户构造请求，只发送HTTP头的一部分。那么HTTP解析器就会一直在等待后续数据的到来。这会导致DDOS攻击，所以Node.js中设置了解析HTTP头的超时时间，阈值是60秒。如果60秒内没有解析完HTTP头部，则会触发timeout事件。如果用户不处理，则Node.js会自动关闭连接。我们看一下Node.js的实现。Node.js在初始化的时候会设置超时时间。

```
1.	this.headersTimeout = 60 * 1000; // 60 seconds  
Node.js在建立TCP连接成功后初始化解析HTTP头的开始时间。
1.	function connectionListenerInternal(server, socket) {  
2.	  parser.parsingHeadersStart = nowDate();  
3.	}  
```

然后在每次收到数据的时候判断HTTP头部是否解析完成，如果没有解析完成并且超时了则会触发timeout事件。

```
1.	function onParserExecute(server, socket, parser, state, ret) {  
2.	  socket._unrefTimer();  
3.	  const start = parser.parsingHeadersStart;  
4.	  // start等于0，说明HTTP头已经解析完毕，否则说明正在解析头，然后再判断解析时间是否超时了  
5.	  if (start !== 0 && nowDate() - start > server.headersTimeout) {  
6.	    // 触发timeout，如果没有监听timeout，则默认会销毁socket，即关闭连接  
7.	    const serverTimeout = server.emit('timeout', socket);  
8.	  
9.	    if (!serverTimeout)  
10.	      socket.destroy();  
11.	    return;  
12.	  }  
13.	  
14.	  onParserExecuteCommon(server, socket, parser, state, ret, undefined);  
15.	}  
```

如果在超时之前解析HTTP头完成，则把parsingHeadersStart置为0表示解析完成。

```
1.	function parserOnIncoming(server, socket, state, req, keepAlive) {  
2.	  // 设置了keepAlive则响应后需要重置一些状态  
3.	  if (server.keepAliveTimeout > 0) {  
4.	    req.on('end', resetHeadersTimeoutOnReqEnd);  
5.	  }  
6.	  
7.	  // 标记头部解析完毕  
8.	  socket.parser.parsingHeadersStart = 0;  
9.	}  
10.	  
11.	function resetHeadersTimeoutOnReqEnd() {  
12.	  if (parser) {  
13.	    parser.parsingHeadersStart = nowDate();  
14.	  }  
15.	}  
```

另外如果支持长连接，即一个TCP连接上可以发送多个请求。则在每个响应结束之后，需要重新初始化解析HTTP头的开始时间。当下一个请求数据到来时再次判断解析HTTP头部是否超时。这里是响应结束后就开始计算。而不是下一个请求到来时。
2 支持管道化的情况下，多个请求的时间间隔  
Node.js支持在一个TCP连接上发送多个HTTP请求，所以需要设置一个定时器，如果超时都没有新的请求到来，则触发超时事件。这里涉及定时器的设置和重置。

```
1.	// 是不是最后一个响应  
2.	  if (res._last) {  
3.	    // 是则销毁socket  
4.	    if (typeof socket.destroySoon === 'function') {  
5.	      socket.destroySoon();  
6.	    } else {  
7.	      socket.end();  
8.	    }  
9.	  } else if (state.outgoing.length === 0) {  
10.	    // 没有待处理的响应了，则重新设置超时时间，等待请求的到来，一定时间内没有请求则触发timeout事件  
11.	    if (server.keepAliveTimeout && typeof socket.setTimeout === 'function') {  
12.	      socket.setTimeout(server.keepAliveTimeout);  
13.	      state.keepAliveTimeoutSet = true;  
14.	    }  
15.	  }  
```

每次响应结束的时候，Node.js首先会判断当前响应是不是最后一个，例如读端不可读了，说明不会又请求到来了，也不会有响应了，那么就不需要保持这个TCP连接。如果当前响应不是最后一个，则Node.js会根据keepAliveTimeout的值做下一步判断，如果keepAliveTimeout 非空，则设置定时器，如果keepAliveTimeout 时间内都没有新的请求则触发timeout事件。那么如果有新请求到来，则需要重置这个定时器。Node.js在收到新请求的第一个请求包中，重置该定时器。

```
1.	function onParserExecuteCommon(server, socket, parser, state, ret, d) {  
2.	  resetSocketTimeout(server, socket, state);  
3.	}  
4.	  
5.	function resetSocketTimeout(server, socket, state) {  
6.	  if (!state.keepAliveTimeoutSet)  
7.	    return;  
8.	  
9.	  socket.setTimeout(server.timeout || 0);  
10.	  state.keepAliveTimeoutSet = false;  
11.	}  
```

onParserExecuteCommon会在每次收到数据时执行，然后Node.js会重置定时器为server.timeout的值。
## 18.4 Agent
本节我们先分析Agent模块的实现，Agent对TCP连接进行了池化管理。简单的情况下，客户端发送一个HTTP请求之前，首先建立一个TCP连接，收到响应后会立刻关闭TCP连接。但是我们知道TCP的三次握手是比较耗时的。所以如果我们能复用TCP连接，在一个TCP连接上发送多个HTTP请求和接收多个HTTP响应，那么在性能上面就会得到很大的提升。Agent的作用就是复用TCP连接。不过Agent的模式是在一个TCP连接上串行地发送请求和接收响应，不支持HTTP PipeLine模式。下面我们看一下Agent模块的具体实现。看它是如何实现TCP连接复用的。

```
1.	function Agent(options) {  
2.	  if (!(this instanceof Agent))  
3.	    return new Agent(options);  
4.	  EventEmitter.call(this);  
5.	  this.defaultPort = 80;  
6.	  this.protocol = 'http:';  
7.	  this.options = { ...options };  
8.	  // path字段表示是本机的进程间通信时使用的路径，比如Unix域路径  
9.	  this.options.path = null;  
10.	  // socket个数达到阈值后，等待空闲socket的请求  
11.	  this.requests = {};  
12.	  // 正在使用的socket  
13.	  this.sockets = {};  
14.	  // 空闲socket  
15.	  this.freeSockets = {};  
16.	  // 空闲socket的存活时间  
17.	  this.keepAliveMsecs = this.options.keepAliveMsecs || 1000;  
18.	  /* 
19.	    用完的socket是否放到空闲队列， 
20.	      开启keepalive才会放到空闲队列， 
21.	      不开启keepalive 
22.	        还有等待socket的请求则复用socket 
23.	        没有等待socket的请求则直接销毁socket 
24.	  */  
25.	  this.keepAlive = this.options.keepAlive || false;  
26.	  // 最大的socket个数，包括正在使用的和空闲的socket  
27.	  this.maxSockets = this.options.maxSockets 
28.	                      || Agent.defaultMaxSockets;  
29.	  // 最大的空闲socket个数  
30.	  this.maxFreeSockets = this.options.maxFreeSockets || 256;  
31.	}  
```

Agent维护了几个数据结构，分别是等待socket的请求、正在使用的socket、空闲socket。每一个数据结构是一个对象，对象的key是根据HTTP请求参数计算的。对象的值是一个队列。具体结构如图18-7所示。  
![](https://img-blog.csdnimg.cn/d3f53aba26e24269bcdff71ef824994d.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)  
图18-7  
下面我们看一下Agent模块的具体实现。
### 18.4.1 key的计算
key的计算是池化管理的核心。正确地设计key的计算规则，才能更好地利用池化带来的好处。

```
1.	// 一个请求对应的key  
2.	Agent.prototype.getName = function getName(options) {  
3.	  let name = options.host || 'localhost'; 
4.	  name += ':';  
5.	  if (options.port)  
6.	    name += options.port;  
7.	  name += ':';  
8.	  if (options.localAddress)  
9.	    name += options.localAddress;  
10.	  if (options.family === 4 || options.family === 6)  
11.	    name += `:${options.family}`;  
12.	  if (options.socketPath)  
13.	    name += `:${options.socketPath}`; 
14.	  return name;  
15.	};  
```

我们看到key由host、port、本地地址、地址簇类型、unix路径计算而来。所以不同的请求只有这些因子都一样的情况下才能复用连接。另外我们看到Agent支持Unix域。
### 18.4.2 创建一个socket

```
1.	function createSocket(req, options, cb) {  
2.	  options = { ...options, ...this.options };  
3.	  // 计算key
4.	  const name = this.getName(options);  
5.	  options._agentKey = name;  
6.	  options.encoding = null;  
7.	  let called = false;  
8.	  // 创建socket完毕后执行的回调
9.	  const oncreate = (err, s) => {  
10.	    if (called)  
11.	      return;  
12.	    called = true;  
13.	    if (err)  
14.	      return cb(err);  
15.	    if (!this.sockets[name]) {  
16.	      this.sockets[name] = [];  
17.	    }  
18.	    // 插入正在使用的socket队列  
19.	    this.sockets[name].push(s); 
20.	     // 监听socket的一些事件，用于回收socket 
21.	    installListeners(this, s, options); 
22.	    // 有可用socket，通知调用方 
23.	    cb(null, s);  
24.	  };  
25.	  // 创建一个新的socket，使用net.createConnection  
26.	  const newSocket = this.createConnection(options, oncreate);  
27.	  if (newSocket)  
28.	    oncreate(null, newSocket);  
29.	}  
30.	  
31.	function installListeners(agent, s, options) {  
32.	  /*
33.	    socket触发空闲事件的处理函数，告诉agent该socket空闲了，
34.	    agent会回收该socket到空闲队列  
35.	  */
36.	  function onFree() {  
37.	    agent.emit('free', s, options);  
38.	  }  
39.	  /* 
40.	    监听socket空闲事件，调用方使用完socket后触发，
41.	    通知agent socket用完了 
42.	  */ 
43.	  s.on('free', onFree);  
44.	  
45.	  function onClose(err) {  
46.	    agent.removeSocket(s, options);  
47.	  }  
48.	  // socket关闭则agent会从socket队列中删除它  
49.	  s.on('close', onClose);  
50.	  
51.	  function onRemove() {  
52.	    agent.removeSocket(s, options);  
53.	    s.removeListener('close', onClose);  
54.	    s.removeListener('free', onFree);  
55.	    s.removeListener('agentRemove', onRemove);  
56.	  }  
57.	  // agent被移除  
58.	  s.on('agentRemove', onRemove);  
59.	  
60.	}  
```

创建socket的主要逻辑如下  
1 调用net模块创建一个socket（TCP或者Unix域），然后插入使用中的socket队列，最后通知调用方socket创建成功。  
2 监听socket的close、free事件和agentRemove事件，触发时从队列中删除socket。  
### 18.4.3 删除socket

```
1.	// 把socket从正在使用队列或者空闲队列中移出  
2.	function removeSocket(s, options) {  
3.	  const name = this.getName(options);  
4.	  const sets = [this.sockets];  
5.	  /*
6.	    socket不可写了，则有可能是存在空闲的队列中，
7.	    所以需要遍历空闲队列，因为removeSocket只会在
8.	    使用完socket或者socket关闭的时候被调用，前者只有在
9.	    可写状态时会调用，后者是不可写的
10.	  */
11.	  if (!s.writable)  
12.	    sets.push(this.freeSockets);  
13.	  // 从队列中删除对应的socket  
14.	  for (const sockets of sets) {  
15.	    if (sockets[name]) {  
16.	      const index = sockets[name].indexOf(s);  
17.	      if (index !== -1) {  
18.	        sockets[name].splice(index, 1);  
19.	        // Don't leak  
20.	        if (sockets[name].length === 0)  
21.	          delete sockets[name];  
22.	      }  
23.	    }  
24.	  }  
25.	  /* 
26.	    如果还有在等待socekt的请求，则创建socket去处理它， 
27.	    因为socket数已经减一了，说明socket个数还没有达到阈值
28.	    但是这里应该先判断是否还有空闲的socket，有则可以复用，
29.	    没有则创建新的socket 
30.	  */  
31.	  if (this.requests[name] && this.requests[name].length) {  
32.	    const req = this.requests[name][0];  
33.	    const socketCreationHandler = handleSocketCreation(this, 
34.	                                                            req,            
35.	                                                            false);  
36.	    this.createSocket(req, options, socketCreationHandler);  
37.	  }  
38.	};  
```

前面已经分析过，Agent维护了两个socket队列，删除socket就是从这两个队列中找到对应的socket，然后移除它。移除后需要判断一下是否还有等待socket的请求队列，有的话就新建一个socket去处理它。因为移除了一个socket，就说明可以新增一个socket。
### 18.4.4 设置socket keepalive
当socket被使用完并且被插入空闲队列后，需要重新设置socket的keepalive值。等到超时会自动关闭socket。在一个socket上调用一次setKeepAlive就可以了，这里可能会导致多次调用setKeepAlive，不过也没有影响。

```
1.	function keepSocketAlive(socket) {  
2.	  socket.setKeepAlive(true, this.keepAliveMsecs);  
3.	  socket.unref();  
4.	  return true;  
5.	};  
```

另外需要设置ref标记，防止该socket阻止事件循环的退出，因为该socket是空闲的，不应该影响事件循环的退出。
### 18.4.5 复用socket

```
1.	function reuseSocket(socket, req) {  
2.	  req.reusedSocket = true;  
3.	  socket.ref();  
4.	};  
```

重新使用该socket，需要修改ref标记，阻止事件循环退出，并标记请求使用的是复用socket。
### 18.4.6 销毁Agent

```
1.	function destroy() {  
2.	  for (const set of [this.freeSockets, this.sockets]) {  
3.	    for (const key of ObjectKeys(set)) {  
4.	      for (const setName of set[key]) {  
5.	        setName.destroy();  
6.	      }  
7.	    }  
8.	  }  
9.	};  
```

因为Agent本质上是一个socket池，销毁Agent即销毁池里维护的所有socket。
### 18.4.7 使用连接池
我们看一下如何使用Agent。

```
1.	function addRequest(req, options, port, localAddress) {  
2.	  // 参数处理  
3.	  if (typeof options === 'string') {  
4.	    options = {  
5.	      host: options,  
6.	      port,  
7.	      localAddress  
8.	    };  
9.	  }  
10.	  
11.	  options = { ...options, ...this.options };  
12.	  if (options.socketPath)  
13.	    options.path = options.socketPath;  
14.	  
15.	  if (!options.servername && options.servername !== '')  
16.	    options.servername = calculateServerName(options, req);  
17.	  // 拿到请求对应的key  
18.	  const name = this.getName(options);  
19.	  // 该key还没有在使用的socekt则初始化数据结构  
20.	  if (!this.sockets[name]) {  
21.	    this.sockets[name] = [];  
22.	  }  
23.	  // 该key对应的空闲socket列表  
24.	  const freeLen = this.freeSockets[name] ? 
25.	                    this.freeSockets[name].length : 0;  
26.	  // 该key对应的所有socket个数  
27.	  const sockLen = freeLen + this.sockets[name].length;  
28.	  // 该key有对应的空闲socekt  
29.	  if (freeLen) {    
30.	    // 获取一个该key对应的空闲socket  
31.	    const socket = this.freeSockets[name].shift();  
32.	    // 取完了删除，防止内存泄漏  
33.	    if (!this.freeSockets[name].length)  
34.	      delete this.freeSockets[name];  
35.	    // 设置ref标记，因为正在使用该socket  
36.	    this.reuseSocket(socket, req);  
37.	    // 设置请求对应的socket  
38.	    setRequestSocket(this, req, socket);  
39.	    // 插入正在使用的socket队列  
40.	    this.sockets[name].push(socket);  
41.	  } else if (sockLen < this.maxSockets) {   
42.	    /* 
43.	      如果该key没有对应的空闲socket并且使用的 
44.	      socket个数还没有得到阈值，则继续创建 
45.	    */  
46.	    this.createSocket(req,
47.	                        options, 
48.	                        handleSocketCreation(this, req, true));  
49.	  } else {  
50.	    // 等待该key下有空闲的socket  
51.	    if (!this.requests[name]) {  
52.	      this.requests[name] = [];  
53.	    }  
54.	    this.requests[name].push(req);  
55.	  }  
56.	}  
```

当我们需要发送一个HTTP请求的时候，我们可以通过Agent的addRequest方法把请求托管到Agent中，当有可用的socket时，Agent会通知我们。addRequest的代码很长，主要分为三种情况。
1 有空闲socket，则直接复用，并插入正在使用的socket队列中  
我们主要看一下setRequestSocket函数

```
1.	function setRequestSocket(agent, req, socket) {  
2.	  // 通知请求socket创建成功  
3.	  req.onSocket(socket);  
4.	  const agentTimeout = agent.options.timeout || 0;  
5.	  if (req.timeout === undefined || req.timeout === agentTimeout) 
6.	  {  
7.	    return;  
8.	  }  
9.	  // 开启一个定时器，过期后触发timeout事件  
10.	  socket.setTimeout(req.timeout);  
11.	  /*
12.	    监听响应事件，响应结束后需要重新设置超时时间，
13.	    开启下一个请求的超时计算，否则会提前过期 
14.	  */ 
15.	  req.once('response', (res) => {  
16.	    res.once('end', () => {  
17.	      if (socket.timeout !== agentTimeout) {  
18.	        socket.setTimeout(agentTimeout);  
19.	      }  
20.	    });  
21.	  });  
22.	}  
```

setRequestSocket函数通过req.onSocket(socket)通知调用方有可用socket。然后如果请求设置了超时时间则设置socket的超时时间，即请求的超时时间。最后监听响应结束事件，重新设置超时时间。
2 没有空闲socket，但是使用的socket个数还没有达到阈值，则创建新的socket。  
我们主要分析创建socket后的回调handleSocketCreation。

```
1.	function handleSocketCreation(agent, request, informRequest) {  
2.	  return function handleSocketCreation_Inner(err, socket) {  
3.	    if (err) {  
4.	      process.nextTick(emitErrorNT, request, err);  
5.	      return;  
6.	    }  
7.	    /* 
8.	     是否需要直接通知请求方，这时候request不是来自等待
9.	      socket的requests队列， 而是来自调用方，见addRequest 
10.	    */  
11.	    if (informRequest)  
12.	      setRequestSocket(agent, request, socket);  
13.	    else  
14.	      /*
15.	        不直接通知，先告诉agent有空闲的socket，
16.	        agent会判断是否有正在等待socket的请求，有则处理  
17.	       */
18.	      socket.emit('free');  
19.	  };  
20.	}  
```

3 不满足1,2，则把请求插入等待socket队列。  
插入等待socket队列后，当有socket空闲时会触发free事件，我们看一下该事件的处理逻辑。

```
1.	// 监听socket空闲事件  
2.	 this.on('free', (socket, options) => {  
3.	   const name = this.getName(options);
4.	   // socket还可写并且还有等待socket的请求，则复用socket  
5.	   if (socket.writable &&  
6.	       this.requests[name] && this.requests[name].length) {  
7.	     // 拿到一个等待socket的请求，然后通知它有socket可用  
8.	     const req = this.requests[name].shift();  
9.	     setRequestSocket(this, req, socket);  
10.	     // 没有等待socket的请求则删除，防止内存泄漏  
11.	     if (this.requests[name].length === 0) {  
12.	       // don't leak  
13.	       delete this.requests[name];  
14.	     }  
15.	   } else {  
16.	     // socket不可用写或者没有等待socket的请求了  
17.	     const req = socket._httpMessage;  
18.	     // socket可写并且请求设置了允许使用复用的socket  
19.	     if (req &&  
20.	         req.shouldKeepAlive &&  
21.	         socket.writable &&  
22.	         this.keepAlive) {  
23.	       let freeSockets = this.freeSockets[name];  
24.	       // 该key下当前的空闲socket个数  
25.	       const freeLen = freeSockets ? freeSockets.length : 0;  
26.	       let count = freeLen;  
27.	       // 正在使用的socket个数  
28.	       if (this.sockets[name])  
29.	         count += this.sockets[name].length;  
30.	       /*
31.	           该key使用的socket个数达到阈值或者空闲socket达到阈值，
32.	           则不复用socket，直接销毁socket  
33.	        */
34.	       if (count > this.maxSockets || 
             freeLen >= this.maxFreeSockets) {  
35.	         socket.destroy();  
36.	       } else if (this.keepSocketAlive(socket)) {   
37.	         /*
38.	            重新设置socket的存活时间，设置失败说明无法重新设置存活时
39.	            间，则说明可能不支持复用  
40.	          */
41.	         freeSockets = freeSockets || [];  
42.	         this.freeSockets[name] = freeSockets;  
43.	         socket[async_id_symbol] = -1;  
44.	         socket._httpMessage = null;  
45.	         // 把socket从正在使用队列中移除  
46.	         this.removeSocket(socket, options);  
47.	         // 插入socket空闲队列  
48.	         freeSockets.push(socket);  
49.	       } else {  
50.	         // 不复用则直接销毁  
51.	         socket.destroy();  
52.	       }  
53.	     } else {  
54.	       socket.destroy();  
55.	     }  
56.	   }  
57.	 });  
```

当有socket空闲时，分为以下几种情况  
1 如果有等待socket的请求，则直接复用socket。  
2 如果没有等待socket的请求，允许复用并且socket个数没有达到阈值则插入空闲队列。  
3 直接销毁
### 18.4.8 测试例子
客户端

```
1.	const http = require('http');  
2.	const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });  
3.	const options = {port: 10000, method: 'GET',  host: '127.0.0.1',}  
4.	options.agent = keepAliveAgent;  
5.	http.get(options, () => {});  
6.	http.get(options, () => {});  
7.	console.log(options.agent.requests)  
```

服务器

```
1.	let i =0;  
2.	const net = require('net');  
3.	net.createServer((socket) => {  
4.	  console.log(++i);  
5.	}).listen(10000);  
```

在例子中，首先创建了一个tcp服务器。然后在客户端使用agent。但是maxSocket的值为1，代表最多只能有一个socket，而这时候客户端发送两个请求，所以有一个请求就会在排队。服务器也只收到了一个连接。
