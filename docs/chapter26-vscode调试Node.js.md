前言：调试代码不管对于开发还是学习源码都是非常重要的技能，本文简单介绍vscode调试Node.js相关代码的调试技巧。
# 1 调试业务JS
调试业务JS可能是普遍的场景，随着Node.js和调试工具的成熟，调试也变得越来越简单。下面是vscode的lauch.json配置。
```c
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "node",
            "request": "attach",
            "name": "Attact Program",
            "port": 9229
        }
    ]
}
```
1 在JS里设置断点，执行node --inspect index.js 启动进程，会输出调试地址。
![](https://img-blog.csdnimg.cn/b1d67620b96c4c07a0b48b390ec940a6.png)
2 点击虫子，然后点击绿色的三角形。![在这里插入图片描述](https://img-blog.csdnimg.cn/2b64913e72c34405b903aaba3a3b1472.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L1RIRUFOQVJLSA==,size_16,color_FFFFFF,t_70)
3 vscode会连接Node.js的WebSocket服务。
4 开始调试（或者使用Chrome Dev Tools调试）。

# 2 调试Addon的C++
写Addon的场景可能不多，但是当你需要的时候，你就会需要调试它。下面的配置只可以调试C++代码。
```c
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Debug node C++ addon",
            "type": "lldb",
            "request": "launch",
            "program": "node",
            "args": ["${workspaceFolder}/node-addon-examples/1_hello_world/napi/hello.js"],
            "cwd": "${workspaceFolder}/node-addon-examples/1_hello_world/napi"
        },
    ]
}
```
1 在C++代码设置断点。
![](https://img-blog.csdnimg.cn/71b5921b90254b8a8cdcd809bd1d1135.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_Q1NETiBAdGhlYW5hcmto,size_49,color_FFFFFF,t_70,g_se,x_16)
2 执行node-gyp configure && node-gyp build --debug编译debug版本的Addon。
3 JS里加载debug版本的Addon。
![](https://img-blog.csdnimg.cn/2b5c8793e83342879a83f21499909283.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_Q1NETiBAdGhlYW5hcmto,size_57,color_FFFFFF,t_70,g_se,x_16)
4 点击小虫子开始调试。
![](https://img-blog.csdnimg.cn/4591a59721e74f5693c67d5d45d11bfa.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_Q1NETiBAdGhlYW5hcmto,size_52,color_FFFFFF,t_70,g_se,x_16)

# 3 调试Addon的C++和JS
Addon通常需要通过JS暴露出来使用，如果我们需要调试C++和JS，那么就可以使用以下配置。
```c
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Debug node C++ addon",
            "type": "node",
            "request": "launch",
            "program": "${workspaceFolder}/node-addon-examples/1_hello_world/napi/hello.js",
            "cwd": "${workspaceFolder}/node-addon-examples/1_hello_world/napi"
        },
        {
            "name": "Attach node C/C++ Addon",
            "type": "lldb",
            "request": "attach",
            "pid": "${command:pickMyProcess}"  
        }
    ]
}
```
和2的过程类似，点三角形开始调试，再选择Attach node C/C++ Addon，然后再次点击三角形。![在这里插入图片描述](https://img-blog.csdnimg.cn/c97b14f3fb724cb4bf8beb79e7e0f0c5.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_Q1NETiBAdGhlYW5hcmto,size_16,color_FFFFFF,t_70,g_se,x_16)
选择attach到hello.js中。
![](https://img-blog.csdnimg.cn/4e2fc471d1734cceb4f4e382057515d1.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_Q1NETiBAdGhlYW5hcmto,size_62,color_FFFFFF,t_70,g_se,x_16)
开始调试。

# 4 调试Node.js源码C++
我们不仅用Node.js，我们可能还会学习Node.js源码，学习源码的时候就少不了调试。可以通过下面的方式调试Node.js的C++源码。
```c
./configure --debug && make
```
使用以下配置
```c
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "(lldb) 启动",
            "type": "cppdbg",
            "request": "launch",
            "program": "${workspaceFolder}/out/Debug/node",
            "args": [],
            "stopAtEntry": false,
            "cwd": "${fileDirname}",
            "environment": [],
            "externalConsole": false,
            "MIMode": "lldb"
        }
    ]
}
```
在node_main.cc的main函数或任何C++代码里打断点，点击小虫子开始调试。

# 5 调试Node.js源码C++和JS代码
Node.js的源码不仅仅有C++，还有JS，如果我们想同时调试，那么就使用以下配置。
```c
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "(lldb) 启动",
            "type": "cppdbg",
            "request": "launch",
            "program": "${workspaceFolder}/out/Debug/node",
            "args": ["--inspect-brk", "${workspaceFolder}/out/Debug/index.js"],
            "stopAtEntry": false,
            "cwd": "${fileDirname}",
            "environment": [],
            "externalConsole": false,
            "MIMode": "lldb"
        }
    ]
}
```
1 点击调试。
![](https://img-blog.csdnimg.cn/674c5cfddfb64b04a98d532c7be09659.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_Q1NETiBAdGhlYW5hcmto,size_62,color_FFFFFF,t_70,g_se,x_16)
2 在vscode调试C++，执行完Node.js启动的流程后会输出调试JS的地址。
![](https://img-blog.csdnimg.cn/cbe5de2a0c1e47d68d9db1c35183b287.png)
3 在浏览器连接WebSocket服务调试JS。
![](https://img-blog.csdnimg.cn/5642810b42734b1bbea7d2aa981798cf.png)
![](https://img-blog.csdnimg.cn/8f3ae91621444e5885b8fe52de291738.png)


