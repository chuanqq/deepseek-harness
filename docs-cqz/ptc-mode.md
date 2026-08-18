# PTC 模式（Code Mode）详解

> 本文档基于 deepseek-harness 仓库源码整理，说明 DSH Web GUI「Agent 预设」中的 **PTC 模式** 到底是什么、如何工作、何时选用。

## 一、一句话定义

**PTC 模式 = DSH 里 `code` 这个 agent 预设的用户可见名字，它把工具以 Code Mode（代码模式）SDK 的形式呈现给模型：模型不再一次调一个工具，而是写一段 TypeScript 程序，用生成好的 API 组合调用多个工具、循环、分支、后处理，由 `run_code` 一次执行。**

- 界面里的显示名（`packages/client/ui-agent-preset/src/client/locales.ts`）：
  - 中文：`PTC 模式`
  - 英文：`PTC mode`
- 界面里的描述：
  > 具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作。
  > (All Standard mode capabilities, with tools exposed through the Code Mode SDK so the model can combine multi-step operations in one TypeScript program.)

「PTC」是这套「用程序来调工具」范式的对外称呼（Programmatic Tool Calling，程序化工具调用）。**在仓库代码里，实现层面统一叫 `Code Mode`**；「PTC 模式」只是它在 GUI 预设选择器中的展示名。二者是同一个东西的两个名字。

## 二、为什么要有它（解决什么问题）

来源：`.agents/notes/implemented/feature/2026-06-15-code-mode.md`（Code Mode 的奠基性 Agent Note）。

在默认的 **native（原生）** 呈现下：

1. 工具注册表把每个可见能力都当成一份 JSON-Schema function definition 塞进系统提示词；
2. 模型每一步只发一个 `tool-call`；
3. **每一个中间 `tool-result` 都会在下一次请求时重新回灌进模型上下文**，无论模型是否真的需要它。

对「多步工具编排」来说这既费 token 又串行：模型想「遍历一个结果集 / 按中间值分支 / 扇出并发 / 对结果做后处理」，每一步都要一次完整的模型往返，且每次往返都把整份中间结果拖回上下文。

Code Mode 借鉴了 Cloudflare 的 [Code Mode](https://blog.cloudflare.com/code-mode/) 观察：**LLM 写代码比发工具调用更强**（它见过海量真实代码，却只见过很少的人造 tool-calling 轨迹）。于是让模型写一段 TypeScript 程序去调用「工具的生成式 API」，程序在沙箱运行时里执行，**只有模型 `return` 或 `console.log` 出来的内容才回灌上下文**，而不是每个中间结果都回灌。

## 三、三种工具呈现模式

由 `@deepseek-ai/dsh-tools` 的 `ToolRuntime` 配置字段 `mode` 决定（`packages/core/tools/README.md`）：

```yaml
tools:
  mode: native   # native（默认） | code | both
```

| mode | 模型看到什么 | 可直接调用什么 |
|---|---|---|
| `native`（默认） | 每个可见工具的完整 schema（name + description + JSON schema） | 每个可见工具 |
| `code` | 仅 `run_code` 传输 + 生成的 `tools:sdk` 段 + 「只有 `run_code` 可直呼」规则 | **仅 `run_code`**；直呼其他任何工具在创建执行时即被判为 `UNKNOWN_TOOL` |
| `both` | native schema **和** Code Mode 的 API 都给 | 二者皆可，native 调用照常执行 |

关键点：
- `run_code` 是**保留传输通道**，游离于注册 / 遮蔽 / 限制层之外，无法被注册、遮蔽、限制或移除；其名字在任何模式下都被保留（因为任意 agent 都可能给自己选 code 模式）。
- 非 native 模式需要一个 `ctx.codeRuntime`，且其 `language` 有已注册的 SDK 渲染器。TypeScript 经 `@deepseek-ai/dsh-code-runtime-worker-thread` 提供；Python 渲染器内置。没有匹配渲染器会**在提示词组装时大声失败**（misconfiguration fails loud），不是静默降级。

**PTC 预设选的是 `mode: code`。**

## 四、PTC 预设的组装（它到底装了哪些插件）

预设文件：
- `apps/cli/config/agent-presets/code/preset.yml`（元数据：名字 `PTC 模式`、描述、排序 `order: 2`）
- `apps/cli/config/agent-presets/code/agent.cordis.yml`（真正的组装）

PTC 预设 = **标准模式的全套能力 + 一行 presentation**。它包含标准编码 agent 的一切：

- 身份：`persona`、`agent-instructions`
- Shell：`tool-bash`（Windows 下换 `tool-pwsh`）
- 文件系统：`tool-fs`、`tool-fs-search`
- 后台任务：`tool-jobs`
- Skills：`skill-filesystem`、`tool-skill`
- 目标：`tool-goal`
- 计划模式：`plan-mode`
- 压缩：`compaction-basic`、`command-compact`、`tool-result-pruner`
- 委派与工作流：`tool-subagent` / `tool-subagent-fork` / `tool-subagent-control` / `tool-workflow` / `tool-ralph` 等
- 其余模型可见工具：`tool-ask-user`、`tool-todo`、`tool-web`

与「标准模式」**唯一的差别**是最后一行 presentation：

```yaml
# ── presentation ─────────────────────────────────────────────
# Code Mode for this agent alone. 该行等待 host 的 codeRuntime，
# 若部署未组装 TypeScript 运行时，则在挂载时（而非首次请求时）大声失败。
- id: tool-presentation
  name: '@deepseek-ai/dsh-agent-tool-presentation'
  config:
    mode: code
```

也就是说：**PTC = 标准模式，换一种工具呈现方式。** 能力集合完全一样，只是模型「看到」和「调用」工具的方式从原生函数调用变成了写程序。

### 呈现是 per-agent 的

`@deepseek-ai/dsh-agent-tool-presentation`（`packages/core/agent-tool-presentation`）通过 `ctx.tools.presentAs()` 只为挂载它的那个 agent 声明呈现方式。因此**一个进程里 Code Mode 会话可以和 native 会话并存**，各看各的目录。工具注册表本身留在 host 平面（agent-loop 的调度器、api-proxy 的 tool-card 渲染器、每个工具插件都是它的消费者），预设能拥有的只是「这个 registry 的呈现方式」。

## 五、运行机制（模型这一侧的体验）

### 1. 模型看到的 SDK

在 `code` / `both` 下，注册表为当前作用域生成一份确定性 SDK（按运行时语言，默认 TypeScript）：

- `JsonValue` 类型
- 精确的 `ToolArgsMap` / `ToolOutputMap`（每个可见工具的入参与规范输出类型）
- `ToolName`、`ToolCallError` 声明
- 一个映射化的 `tools` 命名空间（异名工具用带引号的键，如 `tools["my-tool"](args)`）
- 固定的使用说明

SDK 段（`tools:sdk`，order 150）按字典序排列工具、逐字节稳定（对 provider 前缀缓存友好）。

模型收到的使用说明大致是：

```markdown
## Writing code for run_code

`run_code` 有两个必填参数：`code`（一个 async TypeScript 函数体，只允许可擦除语法——
不能用 enum / namespace；类型注解只是建议，运行时会 type-strip 掉）和 `description`
（对程序做什么的简短说明）。程序内：

- 用 `await tools.name(args)` 调工具；异名用引号键 `tools["my-tool"](args)`。
  每次调用返回该工具的规范 JSON 值。参数必须是无损 JSON。
- 失败的工具调用会 reject 出 `ToolCallError`（带 `toolName` 和 `message`），
  用 try/catch 处理并继续。
- 独立只读调用可用 Promise.all 并发（安全调用可重叠；变更类调用单独按提交顺序执行）。
  有依赖的用 await 串行。
- 只有你 return 或 console.log 出来的东西才会回到你这里——中间工具结果不进对话，
  所以只提取你需要的部分。
```

### 2. dispatch 桥（`run_code` 的执行）

每个 SDK 绑定调用都会：

1. 把参数快照成**无损 JSON**（`undefined`、`BigInt`、循环引用、稀疏数组、`-0`、异常对象会让该次调用直接 reject）；
2. 进入一个 per-run 调度池，**复用 native 的并发契约**：调用严格按提交顺序开始；连续的 `isConcurrencySafe` 调用最多重叠到 `maxParallelSubCalls`（默认 10；设 1 恢复串行）；一个 exclusive 分类的调用会清空池、独占运行、并挡住之后的调用；
3. 带上外层执行的 opaque token 作为 `parent`；
4. **走完整的工具流水线**：`tools/pre-execute` → guards → `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result`——和 native 调用一模一样。所以权限插件能在程序运行前检查程序文本，最终结果观察者看到规范化后的外层结果。

成功返回工具的规范 JSON 值；失败在 worker 里变成程序可见的 `ToolCallError(toolName, message)`（**Native 内容和内部错误码不进入 Code 契约**）。

### 3. 可观测性

每个子调用会记两条日志事件（**不进模型历史**，但对持久化和 UI 可见）：
- `tool/code-dispatch-start`（进池时，确定性 id `<parent>:code:<n>`）
- `tool/code-dispatch`（结算时，携带完整的 `content`/`isError`，用的是 `tool/result` 那套词汇，所以 UI 会把子调用按 native 路径渲染）

### 4. 图片透传

当一个成功结算的子调用其最终 Native 内容含图片时，桥会把这段完整有序内容通过父结果 defer 出去，使图片不会因为「只有 JSON 的绑定」而丢失。

### 5. 结算纪律

桥持有一个 run-scoped abort（跟随外层信号，run 结算时触发）。预算到期会中断在途子工具而不是把它变孤儿；返回前先把队列 drain 干净，保证每个 `tool/code-dispatch` 都落在打开的 turn 内。失败的 run 抛 `CodeRunFailedError`（`code: 'CODE_RUN_FAILED'`），流水线转成结构化 `isError` 让模型自我纠正。

### 6. 结果大小

- 中间绑定值整体跨越 worker 进程，**没有 per-binding 字节上限**（结构化克隆开销和进程/worker 内存是实际约束）；
- `run_code` 返回规范 `{ logs: string[], result?: JsonValue }`；
- worker 的 `maxOutputBytes`（默认 64 MiB）**只**约束「外层日志数组 + 完成值 + 失败消息」的合并序列化载荷。

## 六、执行基座：code-runtime 能力 seam

Code Mode 的执行 substrate 是一个标准的 capability seam（`packages/code-runtime/`）：

- **Service Definition**：`@deepseek-ai/dsh-code-runtime`，只依赖 cordis，拥有 `ctx.codeRuntime`。运行时对工具一无所知：交给它一段程序和若干具名 async 绑定，它跑完报告 `{ value, logs, error? }`。语言和 substrate 是后端属性，所以未来的 Python / 容器后端是另一个 Provider 包，而非重设计。
- **Service Provider（已发货实现）**：`@deepseek-ai/dsh-code-runtime-worker-thread`，每次 run 起一个全新的 Node worker 线程：
  1. host 侧用 Node 内置 `stripTypeScriptTypes` type-strip（保留位置，报错行号对得上源码；`enum`/namespace 等非可擦除语法会被拒，作为 `exception` 返回让模型自纠）；
  2. 起一个全新 `Worker`，`env: {}`（真正空环境）、按配置设 `resourceLimits`、stdout/stderr 捕获进 logs；
  3. 无池化、无跨 run 状态——程序的世界随 worker 而亡，保证「每次 run 都能从日志重建」，状态泄漏不可表达；
  4. 绑定经 message port 桥接，端口协议按「敌对对端」设计（因为对端跑的是模型代码）；
  5. 独立预算：`computeMs`（worker 忙时）、`maxWallMs`（总时长）、`maxOutputBytes`（外层输出）；
  6. 释放到静止（terminate 在途 worker 并 await 其退出）。

### 信任姿态（重要）

**worker 运行时提供的是 containment（隔离容纳），不是安全边界。** 模型代码能触达 Node API，权限与 bash 工具相当。设计上就是「bash-等价」信任：不需要 unsafe-acknowledgement 标志，因为 DSH 本来就有 `dsh-bash-local`，执行任意模型写的 shell 命令、拥有的环境权限只多不少。Code Mode 用和 bash 相同的 `tools/pre-execute` 策略门禁，额外加了空环境、堆限制、独立 isolate、以及对程序本身的硬终止。**需要硬多租户边界的部署需要 container 级后端**（seam 的 `isolation` 描述符就是给它们区分用的）。

## 七、Token 与 KV Cache 影响

来源：`packages/core/tools/README.md` 的 Model Experience 段。

| 维度 | native | code / PTC |
|---|---|---|
| Token（每请求固定成本） | 正比于可见工具定义 | 用「生成的 SDK 文本 + 一个传输 schema」换掉「逐工具 schema」——**不承诺普遍减少**（`both` 下反而两份都带） |
| 中间结果 | 每个 `tool-result` 都回灌，直到压缩 | 只有程序 `return`/`console.log` 的内容回灌；中间子调用结果只在日志里 |
| KV Cache | 可见定义及其顺序不变则前缀稳定 | Code Mode 选择、生成的 SDK、传输 schema、可见工具集不变则前缀稳定；模式或过滤变更可能从首个变化 token 起失效 |

一句话权衡：**PTC 不是「一定更省 token」，而是「把多步编排折叠成一次往返、并让模型自己筛选回灌内容」。** 单发调用（`bash`/`read`/`edit`）在 native 下本就理想；多步组合、循环、扇出、后处理才是 PTC 的主场。

## 八、何时选 PTC 模式

**适合：**
- 需要遍历结果集、按中间值分支、并发扇出、对多个工具输出做聚合/后处理的任务；
- 中间结果很大、但模型只需要其中一小部分（避免整份回灌）；
- 想把「本该 5 次往返」的编排压成 1 次。

**不划算：**
- 大量单发的 `bash`/`read`/`edit`（native 更直接，SDK 前缀反而是额外成本）；
- 部署没有组装 TypeScript 运行时（此时选 PTC 预设会在**挂载时**直接失败并报出该 preset id）。

## 九、已知限制与遗留工作

来源：`packages/core/tools/README.md` 与奠基 Agent Note。

- **SDK 语言跟随唯一加载的运行时，呈现是 per-agent 而非 per-tool**：一个 agent 内不能「这个工具 native、那个工具 code-only」。
- **Code Mode 中间值是 execution-local 且不受字节约束**：这些规范化 typed 值**无法从会话回放重建**，可能耗尽进程/worker 内存；只有外层 `run_code` 输出有硬上限。（子调用的**日志副本**是有界的：spill policy 可把超大的 `tool/code-dispatch` 内容换成 preview + 定位符。）
- **`run_code` 每次运行状态全新**：MVP 明确拒绝持久 REPL 风格内核（跨调用状态对日志不可见，会破坏「每个请求都是日志的纯函数」这一可重建性保证）。
- **子调用重叠受工具自身安全声明约束、而非调用方**：`Promise.all` 只在工具自己声明为 concurrency-safe 的调用间买到并行；一串 exclusive 调用仍按序付往返成本。
- **worker 不是硬安全边界**（见「信任姿态」）：等价于既有 bash 工具的姿态；需要更强隔离需未来的 `isolation: 'container'` 后端。

## 十、快速上手

- 在 DSH Web GUI 的「Agent 预设」选择器里选 **PTC 模式** 即可为新会话启用（运行中的会话保持开始时的预设）。
- 命令行体验 Code Mode：`pnpm run demo:code-mode`。
- 想自定义：复制 PTC 预设目录，保留最后那行 `tool-presentation`（`mode: code`），按需增删工具行即可。

## 附：源码索引

| 主题 | 位置 |
|---|---|
| 预设元数据（名字/描述） | `apps/cli/config/agent-presets/code/preset.yml` |
| 预设组装 | `apps/cli/config/agent-presets/code/agent.cordis.yml` |
| GUI 显示名 `PTC 模式` / `PTC mode` | `packages/client/ui-agent-preset/src/client/locales.ts` |
| 工具注册表 + 三种模式 + Code Mode 说明 | `packages/core/tools/README.md`、`packages/core/tools/src/code-mode.ts` |
| per-agent 呈现选择 | `packages/core/agent-tool-presentation/README.md` |
| 执行 seam（定义/实现） | `packages/code-runtime/code-runtime/`、`packages/code-runtime/code-runtime-worker-thread/` |
| 奠基决策记录 | `.agents/notes/implemented/feature/2026-06-15-code-mode.md` |
| 类型化返回契约 | `.agents/notes/implemented/feature/2026-07-20-code-mode-typed-tool-returns.md` |
| 并发调度 | `.agents/notes/implemented/feature/2026-07-26-code-mode-live-parallel-dispatch.md` |
| 语言分发（TS/Python） | `.agents/notes/implemented/feature/2026-07-31-code-mode-language-dispatch.md` |
| 直呼收敛为 UNKNOWN_TOOL | `.agents/notes/implemented/bug-fix/2026-08-07-code-mode-executor-collapse.md` |
