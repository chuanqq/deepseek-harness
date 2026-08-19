# Session 分支（Fork）上下文管理详解

> 基于 deepseek-harness 当前仓库源码整理，说明“从一次会话的某个 turn 结果切出一个新对话分支”时，上下文如何被选择、复制、隔离与持久化。

## 一、一句话结论

- **分支点不是“你点击的那条消息本身”，而是包含该消息的那个已完成 turn 的 `turn/end`。**
- 新分支只包含从会话开头到该 `turn/end`（含）的完整历史，以及该 turn 结束后、下一个 `turn/start` 之前的独立事件（如标题、注入类事件）。
- 新分支**不包含**该 turn 之后的所有后续对话：后续 turn、后续用户/助手消息、后续工具调用都不会进入新分支。
- 新分支是一个**独立的新 Session**，与父会话后续内容互不影响。

## 二、核心概念

### 2.1 Session 是事件溯源日志

- `Session` 的权威数据是仅追加的 `SessionEvent` 日志（`session.events`）。
- LLM 看到的对话历史不是单独存的，而是由日志中的 surface 事件**派生**出来的（`session.deriveMessages()`）。
- 典型事件：`turn/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`。

### 2.2 稳定边界

- `turn/start` 与 `turn/end` 包围一个完整 turn。
- 一个“可分支前缀”必须满足：所选事件前缀的最后一个 turn 边界不是未闭合的 `turn/start`。
- 换句话说，分支点必须落在：
  - `turn/end` 上，或
  - 某个已完成 turn 之后、下一个 `turn/start` 之前的 standalone 事件上。
- 如果边界落在开放 turn 内部（例如只有 `turn/start`、`user/message`、`assistant/message` 还没有 `turn/end`），底层会拒绝，API 层会返回 `fork-unavailable`，**不会静默剪到更早的 turn**。

### 2.3 子会话的谱系元数据

- `parentSession`：父会话 id。
- `seedLength`：继承的事件条数（不包含子会话自己追加的 `session/end-seed` 标记）。
- `session/end-seed`：子会话构造时追加的内部标记，标识“从这里开始是本会话自己产生的 live 事件”。
- `firstLiveSeq`：本进程中第一个真正 live 追加的 seq，等于 seed 长度。

## 三、完整调用链

```
用户点击某条 turn 的分支按钮
  → TurnTailNodeView.forkAt(closing.finalNode.seq)
  → client sessions.fork({ sessionId, atSeq: seq })
  → Host RPC sessions.fork
  → readSessionState(sessionId) 读取父会话事件
  → 计算真正边界（第一个 turn/end >= atSeq）
  → cut = turn/end.seq + 1，再向后扩展到下一个 turn/start 前
  → seed = events.slice(0, cut)
  → ctx.agents.create({ sessionId: childId, seed, meta: { parentSession, seedLength, ... } })
  → 打开新子会话
```

## 四、底层 `SessionStore.fork`

位置：`packages/core/session/src/index.ts`

### 4.1 签名

```ts
fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session
```

- `source`：实时会话对象或 id。
- `boundary`：**包含式**源事件 seq。省略时默认取源会话当前最后一个事件；空会话省略时 fork 出空子会话。
- `childSessionId`：可选子会话 id；省略时由 `SessionStore` 的 id 策略生成。

### 4.2 校验

`_forkSeed()` 会检查：

1. `boundary` 必须是安全非负整数。
2. `boundary` 必须存在于 `session.events` 中，且 `events[boundary].seq === boundary`（连续性）。
3. 所选前缀 `events.slice(0, boundary + 1)` 的最后一个 turn 边界不能是未闭合的 `turn/start`，否则抛 `OPEN_TURN`。

### 4.3 复制方式

```ts
return events.slice(0, boundary + 1)
```

- 这段事件会作为子会话的 `seed`。
- `Session` 构造时会逐条做 JSON 校验、深拷贝/深冻结，再重建 surface。
- 子会话拿到的是**独立副本**，不是父会话日志的引用；修改子会话 seed 中的对象不会影响父会话。

### 4.4 子会话 header

```ts
meta: {
  ...(source.header.cwd !== undefined ? { cwd: source.header.cwd } : {}),
  parentSession: source.id,
  seedLength: seed.length,
}
```

即子会话继承父会话 `cwd`，并记录 `parentSession` 与 `seedLength`。

## 五、Host/API 层的 `atSeq` 语义

位置：`packages/host/apiproxy/src/api-proxy.ts`、`packages/host/apiproxy/src/api/sessions.ts`

### 5.1 为什么需要 `atSeq`

UI 消息按钮只能拿到“某条消息/事件的 seq”，而底层 fork 需要的是一个**已完成 turn 的边界**。因此 Host 层负责把消息 seq 映射成安全边界。

### 5.2 映射规则

```ts
const anchoredBoundary = events.find(e => e.type === 'turn/end' && e.seq >= atSeq)
```

- `atSeq` 是锚点，实际边界取**第一个 seq >= atSeq 的 `turn/end`**。
- 如果 `atSeq` 在一个已完成 turn 内，结果包含该 turn 的**完整尾部**（包括点击消息之后的 tool/result、后续 assistant 片段、`turn/end`）。
- 如果 `atSeq` 在一个尚未完成的 turn 内，返回 `fork-unavailable`，**不会回退到更早的已完成 turn**。
- 如果 `atSeq` 省略或超出日志末尾，回退到**最后一个已完成 turn**。

### 5.3 向后扩展 cut

找到 `turn/end` 后，不是简单在 `turn/end.seq + 1` 处截止：

```ts
let cut = boundary.seq + 1
while (cut < events.length && events[cut]?.type !== 'turn/start') cut++
seed = events.slice(0, cut)
```

也就是说，`turn/end` 之后到下一个 `turn/start` 之前的 standalone 事件（例如 `session/title`、注入类事件）也会被包含进 seed。这样子会话能继承紧跟在分支 turn 后面的标题/注入内容，同时保持前缀平衡。

### 5.4 子会话的组装

Host 层通过 `ctx.agents.create` 创建子会话：

- `seed`：上面算出的 `events.slice(0, cut)`。
- `meta`：继承 `cwd`，记录 `parentSession` 和 `seedLength`，并带上 `agentPreset`。
- 使用与父会话相同的 agent 组合（`composeAgent(resolveSessionPreset(source))`），保证子会话拥有和父会话一致的工具/系统提示词等。
- 子会话创建后附加到父会话所在 Workspace；如果父会话是 subagent，则附加到最近的 workspace 拥有者祖先。

### 5.5 错误语义

- 源会话不存在：`session-not-found`。
- 日志内锚点所在 turn 未完成：`fork-unavailable`（消息类似 `has not completed the turn containing event ...`）。
- 没有已完成 turn 可 fork：`fork-unavailable`。
- Workspace 附加失败：`workspace-attach-failed`，但子会话已经发布，客户端需要 reconcile。

## 六、UI 层如何暴露分支

位置：`packages/client/ui-conversation/src/client/conversation-nodes/turn-tail.ts`、`packages/client/ui-conversation/src/client/chat/TurnTailNodeView.tsx`、`packages/client/ui-conversation/src/client/apply.ts`

### 6.1 分支按钮只出现在 turn 尾部

- 分支按钮挂在 `turn-tail` 节点上，而不是每条 assistant 消息都展示。
- `TurnTailNodeView` 点击时调用：

```ts
onBranch={() => { forkAt(closing.finalNode.seq) }}
```

- `closing.finalNode.seq` 是该 turn 最后一条有文本的 final assistant 消息的**真实事件 seq**。

### 6.2 可用条件

```ts
branchUnavailable:
  closing === null ||
  latestTranscriptSeq !== closing.finalNode.seq ||
  hasLaterChatNode
```

含义：

- `closing === null`：该 turn 没有可作分支锚点的 final assistant 消息（例如纯错误/中断且没有文本）。
- `latestTranscriptSeq !== closing.finalNode.seq`：在该 final 消息之后还有 transcript 节点（工具结果、后续 assistant 等），说明它不是该 turn 的最终可见结果。
- `hasLaterChatNode`：当前 turn 不是会话中最后一个 chat 节点，即后面还有后续 turn。

因此 UI 通常只允许在**当前最后一个已完成 turn** 的尾部执行分支。

### 6.3 两种入口

- **Session 行/列表的分叉**：fork 到最后一个已完成 turn（`atSeq` 省略）。
- **消息上的 branch 操作**：传入该消息 seq（`atSeq`），Host 映射到包含它的整个已完成 turn。

## 七、上下文管理细节

### 7.1 子会话“看到”什么

- 事件日志：从 seq 0 到 cut-1 的父会话事件副本。
- 派生消息历史：由这些 seed 事件重建 surface 后，`deriveMessages()` 只产生截至分支点的消息。
- 工具/系统提示词：通过继承的 `agentPreset` 和 agent 组合获得与父会话一致的执行环境。
- 工作目录/Workspace：继承父会话 `cwd`，并附加到对应 Workspace。
- 标题：如果标题事件位于 cut 之前，会随 seed 继承；fork 子会话不会因“首条消息”自动重新生成标题。

### 7.2 子会话“看不到”什么

- 父会话在 cut 之后追加的所有事件。
- 父会话后续 turn 的用户消息、助手回复、工具调用、错误等。
- 父会话后续的标题修订（除非子会话自己后续触发全消息节奏重命名）。

### 7.3 独立性

- 子会话不是父会话的“视图”或“指针”，而是**深拷贝的独立 Session**。
- 创建后：
  - 父会话继续 append 不会影响子会话。
  - 子会话继续 append 不会影响父会话。
- 两者只是通过 `parentSession` / `seedLength` 保留谱系关系。

### 7.4 持久化

- 子会话以自己独立的 session id 持久化。
- fork seed 在 `session/created` 时持久化一次，恢复时不会重复 append。
- `session/end-seed` 标记让持久化/遥测知道哪些事件是继承的、哪些是本会话 live 产生的。
- 遥测流中，fork 子会话的前缀位于父会话的流中，接收端通过 `parentSession` + `seedLength` 拼接。

### 7.5 与“树结构”的关系

- 当前存储**没有 pi 风格的事件条目树**，只有基于边界的 `fork()` 和谱系元数据。
- README 中明确写：**Session branching/tree 暂缓**，除非未来需要超越基于边界的 `fork()` 能力。

## 八、边界与限制

| 限制 | 说明 |
|---|---|
| 只能在稳定边界 fork | 前缀必须结束在 `turn/end` 或其后 standalone 事件，不能结束在开放 turn 内 |
| 不能静默裁剪 | 锚点 turn 未完成时返回 `fork-unavailable`，不会偷偷 fork 到更早 turn |
| 底层仅限 live session | `SessionStore.fork` 要求源会话在 live store 中；Host API 层可额外通过持久化检查读取未加载会话 |
| 没有完整树结构 | 只记录单层 `parentSession`/`seedLength` 谱系，不做通用分支树 |
| 模型可见性 | 子会话继承的 agent 组合与父会话一致，避免已携带的 tool call 因工具集合不同而失效 |

## 九、典型示例

假设父会话事件序列（seq 递增）：

```
0  turn/start (turn 1)
1  user/message  "你好"
2  assistant/message "这是回复"
3  tool/result   (工具结果)
4  turn/end (turn 1, completed)
5  session/title "你好"
6  turn/start (turn 2)
7  user/message  "继续"
...
```

- 用户在 turn 1 的 assistant 消息（seq 2）上点击分支。
- Host 找到第一个 `turn/end >= 2`：seq 4。
- `cut = 4 + 1 = 5`；seq 5 是 `session/title`，不是 `turn/start`，所以继续扩展到 `cut = 6`。
- 子会话 seed = `events.slice(0, 6)`，即 seq 0–5。
- 子会话**不包含** seq 6 之后的 turn 2 内容。

## 十、相关源码位置

| 内容 | 位置 |
|---|---|
| 底层 `SessionStore.fork` / `_forkSeed` | `packages/core/session/src/index.ts` |
| Host RPC `sessions.fork` | `packages/host/apiproxy/src/api-proxy.ts` |
| API 文档与 `atSeq` 语义 | `packages/host/apiproxy/src/api/sessions.ts` |
| UI 分支按钮调用 | `packages/client/ui-conversation/src/client/apply.ts` |
| turn-tail 可用性计算 | `packages/client/ui-conversation/src/client/conversation-nodes/turn-tail.ts` |
| turn-tail 渲染与点击 | `packages/client/ui-conversation/src/client/chat/TurnTailNodeView.tsx` |
| fork API 设计决策 | `.agents/notes/implemented/feature/2026-06-30-session-store-fork-api.md` |
| session 包 README | `packages/core/session/README.zh.md` |
