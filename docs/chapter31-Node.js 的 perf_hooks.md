前言：perf_hooks 是 Node.js 中用于收集性能数据的模块，Node.js 本身基于 perf_hooks 提供了性能数据，同时也提供了机制给用户上报性能数据。文本介绍一下 perk_hooks。

# 1 使用
首先看一下 perf_hooks 的基本使用。
```c
const { PerformanceObserver } = require('perf_hooks');
const obs = new PerformanceObserver((items) => {
  // 
};

obs.observe({ type: 'http' });
```
通过 PerformanceObserver 可以创建一个观察者，然后调用 observe 可以订阅对哪种类型的性能数据感兴趣。

下面看一下 C++ 层的实现，C++ 层的实现首先是为了支持 C++ 层的代码进行数据的上报，同时也为了支持 JS 层的功能。
# 2 C++ 层实现
## 2.1 PerformanceEntry
PerformanceEntry 是 perf_hooks 里的一个核心数据结构，PerformanceEntry 代表一次性能数据。下面来看一下它的定义。
```c
template <typename Traits>
struct PerformanceEntry {
  using Details = typename Traits::Details;
  std::string name;
  double start_time;
  double duration;
  Details details;

  static v8::MaybeLocal<v8::Object> GetDetails(
      Environment* env,
      const PerformanceEntry<Traits>& entry) {
    return Traits::GetDetails(env, entry);
  }
};
```
PerformanceEntry 里面记录了一次性能数据的信息，从定义中可以看到，里面记录了类型，开始时间，持续时间，比如一个 HTTP 请求的开始时间，处理耗时。除了这些信息之外，性能数据还包括一些额外的信息，由 details 字段保存，比如 HTTP 请求的 url，不过目前还不支持这个能力，不同的性能数据会包括不同的额外信息，所以 PerformanceEntry 是一个类模版，具体的 details 由具体的性能数据生产者实现。下面我们看一个具体的例子。
```c
struct GCPerformanceEntryTraits {
  static constexpr PerformanceEntryType kType = NODE_PERFORMANCE_ENTRY_TYPE_GC;
  struct Details {
    PerformanceGCKind kind;
    PerformanceGCFlags flags;

    Details(PerformanceGCKind kind_, PerformanceGCFlags flags_)
        : kind(kind_), flags(flags_) {}
  };

  static v8::MaybeLocal<v8::Object> GetDetails(
      Environment* env,
      const PerformanceEntry<GCPerformanceEntryTraits>& entry);
};

using GCPerformanceEntry = PerformanceEntry<GCPerformanceEntryTraits>;
```
这是关于 gc 性能数据的实现，我们看到它的 details 里包括了 kind 和 flags。接下来看一下 perf_hooks 是如何收集 gc 的性能数据的。首先通过 InstallGarbageCollectionTracking 注册 gc 钩子。
```c
static void InstallGarbageCollectionTracking(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);

  env->isolate()->AddGCPrologueCallback(MarkGarbageCollectionStart,
                                        static_cast<void*>(env));
  env->isolate()->AddGCEpilogueCallback(MarkGarbageCollectionEnd,
                                        static_cast<void*>(env));
  env->AddCleanupHook(GarbageCollectionCleanupHook, env);
}
```
InstallGarbageCollectionTracking 主要是使用了 V8 提供的两个函数注册了 gc 开始和 gc 结束阶段的钩子。我们看一下这两个钩子的逻辑。
```c
void MarkGarbageCollectionStart(
    Isolate* isolate,
    GCType type,
    GCCallbackFlags flags,
    void* data) {
  Environment* env = static_cast<Environment*>(data);
  env->performance_state()->performance_last_gc_start_mark = PERFORMANCE_NOW();
}
```
MarkGarbageCollectionStart 在开始 gc 时被执行，逻辑很简单，主要是记录了 gc 的开始时间。接着看 MarkGarbageCollectionEnd。
```c
void MarkGarbageCollectionEnd(
    Isolate* isolate,
    GCType type,
    GCCallbackFlags flags,
    void* data) {
  Environment* env = static_cast<Environment*>(data);
  PerformanceState* state = env->performance_state();

  double start_time = state->performance_last_gc_start_mark / 1e6;
  double duration = (PERFORMANCE_NOW() / 1e6) - start_time;

  std::unique_ptr<GCPerformanceEntry> entry =
      std::make_unique<GCPerformanceEntry>(
          "gc",
          start_time,
          duration,
          GCPerformanceEntry::Details(
            static_cast<PerformanceGCKind>(type),
            static_cast<PerformanceGCFlags>(flags)));

  env->SetImmediate([entry = std::move(entry)](Environment* env) {
    entry->Notify(env);
  }, CallbackFlags::kUnrefed);
}
```
MarkGarbageCollectionEnd 根据刚才记录 gc 开始时间，计算出 gc 的持续时间。然后产生一个性能数据 GCPerformanceEntry。然后在事件循环的 check 阶段通过 Notify 进行上报。
```c
void Notify(Environment* env) {
    v8::Local<v8::Object> detail;
    if (!Traits::GetDetails(env, *this).ToLocal(&detail)) {
      // TODO(@jasnell): Handle the error here
      return;
    }

    v8::Local<v8::Value> argv[] = {
      OneByteString(env->isolate(), name.c_str()),
      OneByteString(env->isolate(), GetPerformanceEntryTypeName(Traits::kType)),
      v8::Number::New(env->isolate(), start_time),
      v8::Number::New(env->isolate(), duration),
      detail
    };

    node::MakeSyncCallback(
        env->isolate(),
        env->context()->Global(),
        env->performance_entry_callback(),
        arraysize(argv),
        argv);
  }
};
```
Notify 进行进一步的处理，然后执行 JS 的回调进行数据的上报。env->performance_entry_callback() 对应的回调在 JS 设置。

## 2.2 PerformanceState
PerformanceState 是 perf_hooks 的另一个核心数据结构，负责管理 perf_hooks 模块的一些公共数据。
```c
class PerformanceState {
 public:
  explicit PerformanceState(v8::Isolate* isolate, const SerializeInfo* info);
  AliasedUint8Array root;
  AliasedFloat64Array milestones;
  AliasedUint32Array observers;

  uint64_t performance_last_gc_start_mark = 0;

  void Mark(enum PerformanceMilestone milestone,uint64_t ts = PERFORMANCE_NOW());

 private:
  struct performance_state_internal {
  	// Node.js 初始化时的性能数据
    double milestones[NODE_PERFORMANCE_MILESTONE_INVALID];
    // 记录对不同类型性能数据感兴趣的观察者个数
    uint32_t observers[NODE_PERFORMANCE_ENTRY_TYPE_INVALID];
  };
};
```
PerformanceState 主要是记录了 Node.js 初始化时的性能数据，比如 Node.js 初始化完毕的时间，事件循环的开始时间等。还有就是记录了观察者的数据结构，比如对 HTTP 性能数据感兴趣的观察者，主要用于控制要不要上报相关类型的性能数据。比如如果没有观察者的话，那么就不需要上报这个数据。

# 3 JS 层实现
接下来看一下 JS 的实现。首先看一下观察者的实现。

```c
class PerformanceObserver {
  constructor(callback) {
  	// 性能数据
    this[kBuffer] = [];
    // 观察者订阅的性能数据类型
    this[kEntryTypes] = new SafeSet();
    // 观察者对一个还是多个性能数据类型感兴趣
    this[kType] = undefined;
    // 观察者回调
    this[kCallback] = callback;
  }

  observe(options = {}) {
    const {
      entryTypes,
      type,
      buffered,
    } = { ...options };
    // 清除之前的数据
    maybeDecrementObserverCounts(this[kEntryTypes]);
    this[kEntryTypes].clear();
    // 重新订阅当前设置的类型
    for (let n = 0; n < entryTypes.length; n++) {
      if (ArrayPrototypeIncludes(kSupportedEntryTypes, entryTypes[n])) {
        this[kEntryTypes].add(entryTypes[n]);
        maybeIncrementObserverCount(entryTypes[n]);
      }
    }
	// 插入观察者队列
    kObservers.add(this);
  }
  
  takeRecords() {
    const list = this[kBuffer];
    this[kBuffer] = [];
    return list;
  }

  static get supportedEntryTypes() {
    return kSupportedEntryTypes;
  }
  // 产生性能数据时被执行的函数
  [kMaybeBuffer](entry) {
    if (!this[kEntryTypes].has(entry.entryType))
      return;
    // 保存性能数据，迟点上报
    ArrayPrototypePush(this[kBuffer], entry);
    // 插入待上报队列
    kPending.add(this);
    if (kPending.size)
      queuePending();
  }
   // 执行观察者回调
  [kDispatch]() {
    this[kCallback](new PerformanceObserverEntryList(this.takeRecords()),
                    this);
  }
}
```
观察者的实现比较简单，首先有一个全局的变量记录了所有的观察者，然后每个观察者记录了自己订阅的类型。当产生性能数据时，生产者就会通知观察者，接着观察者执行回调。这里需要额外介绍的一个是 maybeDecrementObserverCounts 和 maybeIncrementObserverCount。
```c
function getObserverType(type) {
  switch (type) {
    case 'gc': return NODE_PERFORMANCE_ENTRY_TYPE_GC;
    case 'http2': return NODE_PERFORMANCE_ENTRY_TYPE_HTTP2;
    case 'http': return NODE_PERFORMANCE_ENTRY_TYPE_HTTP;
  }
}

function maybeDecrementObserverCounts(entryTypes) {
  for (const type of entryTypes) {
    const observerType = getObserverType(type);

    if (observerType !== undefined) {
      observerCounts[observerType]--;

      if (observerType === NODE_PERFORMANCE_ENTRY_TYPE_GC &&
          observerCounts[observerType] === 0) {
        removeGarbageCollectionTracking();
        gcTrackingInstalled = false;
      }
    }
  }
}
```
maybeDecrementObserverCounts 主要用于操作 C++ 层的逻辑，首先根据订阅类型判断是不是 C++ 层支持的类型，因为 perf_hooks 在 C++ 和 JS 层都定义了不同的性能类型，如果是涉及到底层的类型，就会操作 observerCounts 记录当前类型的观察者数量，observerCounts 就是刚才分析 C++ 层的 observers 变量，它是一个数组，每个索引对应一个类型，数组元素的值是观察者的个数。另外如果订阅的是 gc 类型，并且是第一个订阅者，那就 JS 层就会操作 C++ 层往 V8 里注册 gc 回调。

了解了 perf_hooks 提供的机制后，我们来看一个具体的性能数据上报例子。这里以 HTTP Server 处理请求的耗时为例。
```c
function emitStatistics(statistics) {
  const startTime = statistics.startTime;
  const diff = process.hrtime(startTime);
  const entry = new InternalPerformanceEntry(
    statistics.type,
    'http',
    startTime[0] * 1000 + startTime[1] / 1e6,
    diff[0] * 1000 + diff[1] / 1e6,
    undefined,
  );
  enqueue(entry);
}
```
下面是 HTTP Server 处理完一个请求时上报性能数据的逻辑。首先创建一个 InternalPerformanceEntry 对象，这个和刚才介绍的 C++ 对象是一样的，是表示一个性能数据的对象。接着调用 enqueue 函数。
```c
function enqueue(entry) {
  // 通知观察者有性能数据，观察者自己判断是否订阅了这个类型的数据
  for (const obs of kObservers) {
    obs[kMaybeBuffer](entry);
  }
  // 如果是 mark 或 measure 类型，则插入一个全局队列。
  const entryType = entry.entryType;
  let buffer;
  if (entryType === 'mark') {
    buffer = markEntryBuffer; // mark 性能数据队列
  } else if (entryType === 'measure') {
    buffer = measureEntryBuffer; // measure 性能数据队列
  } else {
    return;
  }

  ArrayPrototypePush(buffer, entry);
}
```
enqueue 会把性能数据上报到观察者，然后观察者如果订阅这个类型的数据则执行用户回调通知用户。我们看一下 obs[kMaybeBuffer] 的逻辑。
```c
[kMaybeBuffer](entry) {
    if (!this[kEntryTypes].has(entry.entryType))
      return;
    ArrayPrototypePush(this[kBuffer], entry);
    // this 是观察者实例
    kPending.add(this);
    if (kPending.size)
      queuePending();
}


function queuePending() {
  if (isPending) return;
  isPending = true;
  setImmediate(() => {
    isPending = false;
    const pendings = ArrayFrom(kPending.values());
    kPending.clear();
    // 遍历观察者队列，执行 kDispatch
    for (const pending of pendings)
      pending[kDispatch]();
  });
}
// 下面是观察者中的逻辑，观察者把当前保存的数据上报给用户
[kDispatch]() {
  this[kCallback](new PerformanceObserverEntryList(this.takeRecords()),this);
}
```
另外 mark 和 measure 类型的性能数据比较特殊，它不仅会通知观察者，还会插入到全局的一个队列中。所以对于其他类型的性能数据，如果没有观察者的话就会被丢弃（通常在调用 enqueue 之前会先判断是否有观察者），对于 mark 和 measure 类型的性能数据，不管有没有观察者都会被保存下来，所以我们需要显式清除。

# 4 总结
以上就是 perf_hooks 中核心的实现，除此之外，perf_hooks 还提供了其他的功能，本文就先不介绍了。可以看到 perf_hooks 的实现是一个订阅发布的模式，看起来貌似没什么特别的。但是它的强大之处在于是由 Node.js 内置实现的， 这样 Node.js 的其他模块就可以基于 perf_hooks 这个框架上报各种类型的性能数据。相比来说虽然我们也能在用户层实现这样的逻辑，但是我们拿不到或者没有办法优雅地方法拿到 Node.js 内核里面的数据，比如我们想拿到 gc 的性能数据，我们只能写 addon 实现。又比如我们想拿到 HTTP Server 处理请求的耗时，虽然可以通过监听 reqeust 或者 response 对象的事件实现，但是这样一来我们就会耦合到业务代码里，每个开发者都需要处理这样的逻辑，如果我们想收拢这个逻辑，就只能劫持 HTTP 模块来实现，这些不是优雅但是是不得已的解决方案。有了 perf_hooks 机制，我们就可以以一种结耦的方式来收集这些性能数据，实现写一个 SDK，大家只需要简单引入就行。

最近在研究 perf_hooks 代码的时候发现目前 perf_hooks 的功能还不算完善，很多性能数据并没有上报，目前只支持 HTTP Server 的请求耗时、HTTP 2 和 gc 耗时这些性能数据。所以最近提交了两个 PR 支持了更多性能数据的上报。第一个 PR 是用于支持收集 HTTP Client 的耗时，第二个 PR 是用于支持收集 TCP 连接和 DNS 解析的耗时。在第二个 PR 里，实现了两个通用的方法，方便后续其他模块做性能上报。另外后续有时间的话，希望可以去不断完善 perf_hooks 机制和性能数据收集这块的能力。在从事 Node.js 调试和诊断这个方向的这段时间里，深感到应用层能力的局限，因为我们不是业务方，而是基础能力的提供者，就像前面提到的，哪怕想提供一个收集 HTTP 请求耗时的数据都是非常困难的，而作为基础能力的提供者，我们一直希望我们的能力对业务来说是无感知，无侵入并且是稳定可靠的。所以我们需要不断深入地了解 Node.js 在这方面提供的能力，如果 Node.js 没有提供我们想要的功能，我们只能写 addon 或者尝试给社区提交 PR 来解决。另外我们也在慢慢了解和学习 ebpf，希望能利用 ebpf 从另外一个层面帮助我们解决所碰到的问题。
