# DSH 指令文件（AGENTS.md / CLAUDE.md）加载机制与全局配置说明

> 本文对下述说法进行逐项核查，并给出完整的加载机制说明与全局配置方法：
>
> > 指令加载有显式配置：`DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']`，
> > 可配置字节预算或整体关闭（`packages/examples/acp-demo/src/index.ts`）。
>
> 核查基于对 deepseek-harness 仓库源码的实地勘察（2026-08）。

---

## 目录

- [一、结论摘要](#一结论摘要)
- [二、加载机制全景](#二加载机制全景)
  - [1. 插件归属与挂载](#1-插件归属与挂载)
  - [2. 指令来源链：全局 → 项目根 → 嵌套目录](#2-指令来源链全局--项目根--嵌套目录)
  - [3. 候选发现顺序与内容去重](#3-候选发现顺序与内容去重)
  - [4. 渲染与字节预算](#4-渲染与字节预算)
  - [5. 注入时机与生命周期](#5-注入时机与生命周期)
- [三、说法逐项核实](#三说法逐项核实)
  - [1. 常量定义位置：说法引用错误](#1-常量定义位置说法引用错误)
  - [2. "可配置字节预算"：属实](#2-可配置字节预算属实)
  - [3. "或整体关闭"：属实，三条途径](#3-或整体关闭属实三条途径)
- [四、配置项全集](#四配置项全集)
- [五、全局配置方法](#五全局配置方法)
  - [A. 全局指令内容：`$DSH_HOME/AGENTS.md`](#a-全局指令内容dsh_homeagentsmd)
  - [B. 全局行为配置：cordis patch 层](#b-全局行为配置cordis-patch-层)
  - [完整示例](#完整示例)
- [六、注意事项](#六注意事项)
- [七、关键文件索引](#七关键文件索引)
- [八、原分析文档勘误建议](#八原分析文档勘误建议)

---

## 一、结论摘要

| 说法条目 | 结论 | 证据 |
|---|---|---|
| `DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']` 存在 | ✅ 值与语义正确 | `packages/context/agent-instructions/src/config.ts:12` |
| 常量定义在 `packages/examples/acp-demo/src/index.ts` | ❌ 引用错误 | acp-demo 内无此常量，仅为转发方（见 [三.1](#1-常量定义位置说法引用错误)） |
| 可配置字节预算 | ✅ 属实 | `maxBytes`（必填）+ `maxSourceBytes`（单文件上限） |
| 可整体关闭 | ✅ 属实 | 三条途径：`maxBytes ≤ 0`、`workspaceContext: false`、loader 行 `disabled: true` |

一句话版本：**说法方向正确、值正确，唯一定位错误——常量真正定义在 `@deepseek-ai/dsh-agent-instructions` 包中，`acp-demo` 只是把配置转发给该插件的消费方之一。**

---

## 二、加载机制全景

### 1. 插件归属与挂载

指令加载由独立插件 **`@deepseek-ai/dsh-agent-instructions`**（`packages/context/agent-instructions/`）实现，插件名 `agent-instructions`（`src/state.ts:34`）。它是一个**函数插件**：`apply(ctx, config)` 挂载，无默认导出、无 `inject`，通过 `ctx.on('agent/pre-step')` 与 `ctx.on('tools/result')` 两个事件缝注入指令。

挂载位置有两条路径：

- **独立行挂载**（dsh 官方 profile 的默认形态）：`packages/bundle/base/cordis.patch.yml` 中有一行
  ```yaml
  - id: agent-instructions
    name: '@deepseek-ai/dsh-agent-instructions'
    config:
      maxBytes: 65536
  ```
  所有 dsh profile（web / headless）都继承 dsh-base 的这一行，即**出厂默认预算 64 KiB**。
- **bundle 内组装**（`acp-demo` / `agent-spine-demo` 示例包）：把配置字段 `workspaceContext` 整体转发，`false` 则不挂载：
  ```ts
  // packages/examples/agent-spine-demo/src/index.ts:254-255
  if (config.workspaceContext !== false) {
    ctx.plugin(workspaceContext, config.workspaceContext)
  }
  ```

插件对 `ctx.fs`（文件系统 provider）采用可选读取：无 provider 的产品挂载后为 no-op（`src/index.ts:6-7`）。

### 2. 指令来源链：全局 → 项目根 → 嵌套目录

加载顺序（`packages/context/agent-instructions/README.md:9`）：

1. **`$DSH_HOME/AGENTS.md`**（默认 `~/.dsh/AGENTS.md`，可经 `dshHome` 配置项换位置）——用户级全局指令，任何项目、任何会话都先读到它；
2. 从**项目根目录**（由 `projectRootMarkers` 识别，默认 `['.git']`，从会话 cwd 向上找）到 `agent.session.header.cwd` 的**每一层目录**：先读该目录下所有现存的基础候选（`instructionFileCandidates`），再读所有现存的本地 overlay 候选（`localInstructionFileCandidates`）。

因此 agent 在编辑某个嵌套目录下的文件时，会自动收到「全局铁律 → 工作区根 → 嵌套子目录」的作用域链，越具体（越深）的目录规则与越具体的文件越靠后、越优先。

### 3. 候选发现顺序与内容去重

默认候选（`src/config.ts:11-15`）：

```ts
const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const
const DEFAULT_MAX_SOURCE_BYTES = 1_048_576   // 1 MiB
```

- 每个目录中**所有现存候选都加载**（不是只取第一个）；
- **每目录按内容去重**：候选文件去除首尾空白后字节完全一致则折叠到配置顺序中最早的候选。因此 `CLAUDE.md` 若只是复制/符号链接了同级 `AGENTS.md`（本仓库正是这样：`CLAUDE.md` 符号链接到 `AGENTS.md`），只渲染一次（以 `AGENTS.md` 名义）；真正内容不同的同级文件则同时生效；
- 候选必须是**同目录文件名**：空串、`.`、`..`、含 `/` 或 `\` 的条目会被忽略（`src/config.ts:119-123`）；
- 本地 overlay（`AGENTS.local.md` / `CLAUDE.local.md`）渲染在基础文件之后；空列表关闭 overlay。

### 4. 渲染与字节预算

- 渲染**优先保留最具体的指令文件**：先整体丢弃较宽泛的文件，再截断最具体的文件；渲染结果**绝不超过 `maxBytes`**，超限时输出可见的 `Workspace instruction budget ...` 通知，指名被省略与截断的路径（`README.md:76`）；
- `maxBytes` 是**必填项**（schema 层 `z.number().required()`），每个部署必须显式选择预算；`maxSourceBytes` 限制单个源文件（默认 1 MiB，超限文件被忽略）；
- 渲染后的基线以 `<system-reminder>` 形式（用户消息、`source.kind === 'agent-instructions'`）注入模型对话。

### 5. 注入时机与生命周期

- **基线（baseline）**：每个实时会话第一次符合条件的 `agent/pre-step` 组合基线；当下游决策让非空的第一步批次进入时，基线折入最终批次、**紧随已领取的直接提示词之后**（`src/index.ts:322-348`），使「直接提示词 → 持久基线 → 驱动方追加的运行时上下文」成为第一次请求的内容；
- **增量投影（projection）**：`read` / `write` / `edit` 工具的成功执行会 touch 目标路径，插件把该项目文件**变更/新增/移除**的指令投影进 agent 的 `next-step` inbox（`src/index.ts:350-366`），并在后续步骤进入时合并；待处理上下文只会保留一条（删除并替换，不累积重复）；
- **会话恢复兼容**：`workspaceBaselineIdentity`（`src/config.ts:69-82`）把「项目根、root markers、maxBytes、maxSourceBytes、两类候选列表」序列化为身份串。恢复的会话保留兼容的可见基线、只追加当前文件转换；身份变化则折入一条明确取代旧基线的完整基线；
- **负例保障**：预算为 0/负数时不注入空消息（测试 `agent-instructions.spec.ts:2372` "does not inject an empty agent-instructions message when maxBytes is negative"）。

---

## 三、说法逐项核实

### 1. 常量定义位置：说法引用错误

真实定义在 **`packages/context/agent-instructions/src/config.ts:12`**（模块 `@deepseek-ai/dsh-agent-instructions/config`）：

```ts
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
```

它只是 `instructionFileCandidates` 配置项的**默认值**（`config.ts:44`），即项目目录内指令文件的发现顺序。

`packages/examples/acp-demo/src/index.ts` 中**没有**这个常量。该文件只有一处相关 JSDoc 与 schema 转发（第 62-63、94 行）：

```ts
/** Controls automatic AGENTS.md/CLAUDE.md loading; configure a byte budget or set `false`. */
workspaceContext: agentCore.Config['workspaceContext']
// ...
workspaceContext: z.union([z.const(false), workspaceContext.Config]).required(),
```

`acp-demo`（以及 `agent-spine-demo`）只是**消费方**：声明 `workspaceContext` 配置并把整块转发给 `dsh-agent-instructions` 插件。**"常量定义在 acp-demo"是把「消费方」误当成了「定义方」。**

### 2. "可配置字节预算"：属实

- **`maxBytes`**：整体预算，必填。非正数或非有限值 = 禁用加载（`src/config.ts:23`），运行时强制于 `src/index.ts:113`：
  ```ts
  if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes)) {
    return undefined
  }
  ```
- **`maxSourceBytes`**：单文件上限，默认 1 MiB，超限文件忽略。

### 3. "或整体关闭"：属实，三条途径

| 途径 | 层级 | 写法 | 效果 |
|---|---|---|---|
| 预算归零 | 插件配置 | `maxBytes: 0`（负数/非有限亦可） | 插件仍挂载但永不注入指令 |
| 组装层关闭 | bundle 配置 | `workspaceContext: false`（acp-demo / agent-spine-demo） | 整个插件不挂载（`agent-spine-demo/src/index.ts:254-255`） |
| 行级禁用 | loader 配置 | patch 该行 `disabled: true` | 该 entry 不参与装配 |

---

## 四、配置项全集

`Config` 接口（`packages/context/agent-instructions/src/config.ts:18-46`）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dshHome` | `string` | `$DSH_HOME` 或 `~/.dsh` | 含用户级全局 `AGENTS.md` 的 harness home |
| `projectRootMarkers` | `string[]` | `['.git']` | 向上识别项目根目录的标记 |
| `maxBytes` | `number` | **必填，无默认** | 一份渲染基线/动态批次的 UTF-8 字节上限；非正数或非有限 = 禁用加载 |
| `maxSourceBytes` | `number` | `1048576` | 单个源文件读取上限，超限文件忽略 |
| `instructionFileCandidates` | `string[]` | `['AGENTS.md', 'CLAUDE.md']` | 每目录基础候选（有序，全部现存候选加载，内容相同者折叠） |
| `localInstructionFileCandidates` | `string[]` | `['AGENTS.local.md', 'CLAUDE.local.md']` | 每目录本地 overlay 候选；空列表关闭 overlay |

schema 层约束：候选条目必须为同目录文件名（空串/`.`/`..`/含路径分隔符者忽略）；`maxSourceBytes` 需 `>= 1` 的整数。

---

## 五、全局配置方法

"全局配置"分两个截然不同的层面，不要混淆：

### A. 全局指令内容：`$DSH_HOME/AGENTS.md`

把想对所有项目、所有会话生效的指令写进 **`~/.dsh/AGENTS.md`**（`$DSH_HOME` 默认即 `~/.dsh`）。loader 第一个读的就是它，早于项目目录链。**本会话开头的 `Instructions from: ~/.dsh/AGENTS.md` 正是这条全局文件在生效。**

注意：**全局层只有 `AGENTS.md`**（不是 `CLAUDE.md`）；`CLAUDE.md` 候选只作用于项目目录内。如需把 home 放到别处，用 `dshHome` 配置项。

### B. 全局行为配置：cordis patch 层

行为（预算、候选列表、开关）属于**部署配置**，通过 cordis 加载器的 patch 层修改（`packages/boot/app-boot/README.md:43`），按优先级从低到高：

1. bundle 层：`dsh-base` 的 `cordis.patch.yml`（出厂行，`agent-instructions` + `maxBytes: 65536`）；
2. **profile 层**：`~/.dsh/profiles/<profile>/cordis.patch.yml`；
3. **home 级**：`~/.dsh/cordis.patch.yml`（**压过 profile 层**）；
4. `--patch` 命令行 overlay。

patch 文件是**顶层 YAML 数组**，元素为 loader 的 `PatchOptions`（`vendor/include/src/index.ts:145-156`，支持 `id` / `insert` / `name` / `config` / `disabled` 等）。按 `id` 定位目标行：**整块替换该行的 `config`（不做深合并，保留的字段要一并写全）**；`disabled: true` 禁用该行。patch 命名了不存在的 id 只会 stderr 警告。

生效方式：dsh-base 挂载了 `cordis-plugin-hmr`（`root: ['.']`），它会监听 include 配置文件变更并调用 `include.refresh()` 事务性热刷新（`vendor/hmr/src/index.ts:250-252`），因此**保存 patch 文件通常无需重启**；未启用 hmr 的部署则重启生效。

### 完整示例

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml（或 ~/.dsh/cordis.patch.yml，后者优先级更高）
# 示例 1：调预算 + 改候选（整块替换 config，保留字段需写全）
- id: agent-instructions
  config:
    maxBytes: 131072
    maxSourceBytes: 1048576
    instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md']
    localInstructionFileCandidates: ['AGENTS.local.md', 'CLAUDE.local.md']

# 示例 2：整体关闭（两种写法二选一）
- id: agent-instructions
  disabled: true
# - id: agent-instructions
#   config:
#     maxBytes: 0
```

---

## 六、注意事项

1. **patch 是整块替换，不是合并**：覆盖 `maxBytes` 时若不写 `instructionFileCandidates` 等字段，它们会退回 schema 默认值（而非保留 bundle 层的设定）。bundle 层 `agent-instructions` 行只设了 `maxBytes`，其余字段本身就是默认值，所以常规覆盖只需写 `maxBytes`。
2. **`maxBytes` 在插件 schema 层必填**：`z.number().required()`——不能在配置里"不写就算关闭"，关闭必须显式（`0` / `false` / `disabled`）。
3. **全局层只有 `AGENTS.md`**；home 级不读 `CLAUDE.md`。
4. **预算超限是"丢宽保窄"**：先整体丢弃较宽泛文件、再截断最具体文件，并有可见的 `Workspace instruction budget ...` 通知——不会静默截断。
5. **`settings.yaml` 不管这个插件**：用户设置文档（`$DSH_HOME/settings.yaml`）走 `dsh-settings-file`，覆盖的是 LLM 适配器等条目；`agent-instructions` 是 loader 行配置，走 patch 层。
6. **CLAUDE.md 与 AGENTS.md 内容相同的去重是按目录的**：符号链接或复制都折叠为一次渲染；真正不同的实体副本会全部加载。
7. **卸载/禁用后残留**：禁用行只影响新装配；已注入到会话历史中的基线按会话恢复语义处理（身份变化会折入取代性基线）。

---

## 七、关键文件索引

| 文件 | 作用 |
|---|---|
| `packages/context/agent-instructions/src/config.ts` | 配置 schema、默认常量（含 `DEFAULT_INSTRUCTION_FILE_CANDIDATES`）、identity |
| `packages/context/agent-instructions/src/index.ts` | 插件 `apply`：pre-step 注入、fs touch 投影、预算强制 |
| `packages/context/agent-instructions/src/files.ts` | 发现与加载（home → 项目根 → cwd 链） |
| `packages/context/agent-instructions/src/render.ts` | 渲染、截断、去重 |
| `packages/context/agent-instructions/src/state.ts` | 插件名、状态机、workspaceContext 消息构造 |
| `packages/context/agent-instructions/README.md` | 行为文档（中文版 `README.zh.md`） |
| `packages/bundle/base/cordis.patch.yml` | 出厂行：`agent-instructions` + `maxBytes: 65536` |
| `packages/examples/acp-demo/src/index.ts` | 消费方：`workspaceContext` 转发（无常量定义） |
| `packages/examples/agent-spine-demo/src/index.ts` | 消费方：`workspaceContext !== false` 才挂载 |
| `vendor/include/src/index.ts` | `PatchOptions` 与 `applyEntryPatches`（patch 语义） |
| `packages/boot/app-boot/README.md` | patch 层优先级说明 |
| `vendor/hmr/src/index.ts` | include 配置文件热刷新 |
| `docs/cordis-primer.md` | cordis 加载器/`!!js` 表达式语义 |

---

## 八、原分析文档勘误建议

`docs-cqz/code-agent-friendly-architecture-analysis.md` 第 61-62 行：

> 指令加载有显式配置：`DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']`，
> 可配置字节预算或整体关闭（`packages/examples/acp-demo/src/index.ts`）。

建议将引用改为：

> （`packages/context/agent-instructions/src/config.ts`，经 `acp-demo` / `agent-spine-demo` 的 `workspaceContext` 配置转发）
