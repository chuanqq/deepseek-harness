基于项目自身文档，给你一份开发者快速导览。

## 一、这个项目是什么

**DeepSeek Harness (`dsh`)** 是 DeepSeek 开源的 agent 运行时（harness），核心思想一句话：**everything is a plugin** —— 模型适配器、工具注册表、会话日志、甚至 agent loop 本身都是插件，挂载在 vendored 的 [Cordis](https://github.com/cordiverse/cordis) 框架上（`vendor/` 下锁定的源码副本）。没有"特权核心"可打补丁：扩展方式就是往旁边再挂一个插件，注册全部是 effect，插件卸载时自动回滚。目前处于 developer preview，允许破坏性变更。

## 二、架构的心智模型（按理解顺序）

1. **Cordis 底座**：插件向共享 context 贡献 service、typed event、可逆 effect。先读 `docs/cordis-primer.md`（尤其是 waterfall 语义——listener 必须调 `next()`）。
2. **Profile 与 Bundle 的分层组合**：一次 `dsh` 运行 = 按序叠加的插件树。Profile（如 `web`/`headless`）列出它叠的 bundle；bundle 是 Cordis 配置行 + 代码的分发格式；之上还有 profile 级、home 级的 `cordis.patch.yml` 和 `--patch` overlay。`dsh --profile web --dump-config` 可打印实际启动的树。
3. **核心包**（`packages/core/`）：`session`（append-only `SessionEvent` 日志，是唯一事实源）、`system-prompt`、`tools`、`agent` / `agent-loop`（默认驱动器）。铁律：**model-visible ⟺ logged** —— 凡是进入模型请求的内容必须能从会话日志重建。
4. **Turn 流**：`turn/start → step → agent/request → llm/stream → assistant/* → tool/call → tools/execute → step/end`，细节在 `docs/agent-lifecycle.md` 和 `docs/tool-execution-pipeline.md`。
5. **Capability seam**：新增能力的标准三角色 = Service Definition（接口）+ Service Provider（实现）+ Consumer（通常是模型可见工具）。换 provider（如把 fs/subprocess 指向远程沙箱）整个产品的 Bash/PTY/LSP 跟着走。
6. **新行为挂哪**：`docs/architecture.md` 末尾的"Where new behavior goes"表格是最常用的一页——加模型 provider 挂 `ctx.llm`，加工具挂 `ctx.tools`，拦截请求用 `agent/*` / `tools/*` 事件，等等。

仓库布局速记：`vendor/`（Cordis）、`packages/<group>/<pkg>/`（47+ 个包按 capability 分组，包名一律 `@deepseek-ai/dsh-*`，ESM strict）、`python/`、`native/`、`examples/`、`docs/`、`scripts/`（各类 gate）、`.agents/`（skills + Agent Notes）。每个包还有 `./invariant` 运行时不变量检查。

## 三、文档分三类读者

### 🤖 给 code agent 的（规则 + 决策记录）

| 文档 | 作用 |
|---|---|
| 根 `AGENTS.md`（`CLAUDE.md` 是它的 symlink） | agent 每会话必读的"standing orders"：约定、防御模式、测试策略，每条 1–3 行并链接到归属文档 |
| `packages/AGENTS.md`、`docs/AGENTS.md`、`examples/AGENTS.md` | 各子树的专属规则（如插件导出形式、文档分层与字数预算） |
| `.agents/notes/`（Agent Notes） | **决策记录**：为什么这么设计、放弃了什么、需要的验证；`implemented/` 用现在时描述已落地现实，archived 是冻结历史 |
| `.agents/skills/` | 可复用工作流（如 `dsh-pre-push-checks`、`dsh-code-review`、`dsh-prose-standard`） |
| `docs/postmortem/` | 事故复盘，唯一允许"讲故事"的地方 |

### 🛠 给开发者（contributor）的

| 文档 | 作用 |
|---|---|
| `docs/development.md` | 环境搭建、日常流程、CI 概览、TS 工程布局（入门第一站） |
| `docs/architecture.md` | **改 `packages/` 前必读**：组合机制、核心包、事件域、turn 流、seam、扩展点地图 |
| `docs/cordis-primer.md` | Cordis 概念速成 |
| `docs/subsystems/` | 每个子系统一页参考：类型定义、语义、生成的 Cordis API |
| `docs/cookbook/` | 步骤化 how-to（如 adding-a-package、adding-a-tool，含编号验证步骤） |
| `docs/testing.md`、`docs/defensive-patterns.md` | 测试策略（覆盖率门禁、快照测试）；生命周期/并发/子进程/拆除工作前必读 |
| 各包 README | 单包契约：config、语义、限制、扩展点、Model Experience |
| 生成类参考（勿手改） | `tool-catalog.md`、`config-catalog.md`、`persistence-catalog.md`、`module-graph.md`、`event-producer-consumer.md` 等，由脚本从源码再生成 |
| `docs/glossary.md`、`docs/rescope.md` | 术语表；vendor 包重命名映射 |

### 👤 给最终用户的

| 文档 | 作用 |
|---|---|
| `README.md` | 安装与 `npx @deepseek-ai/dsh web` 快速开始 |
| `docs/user/` | 产品使用指南（如 Web UI guide），经 `website/` 的 VitePress 投影发布到文档站 |

注意两点贯穿约定：绝大多数文档是中英双语对（`*.md` + `*.zh.md`，须同步更新）；每个事实只有一个"家"，其他地方只做链接。

## 四、建议的上手路径

1. `README.md` → 跑起来：`pnpm install && pnpm run build && pnpm dsh web`
2. `docs/development.md` + `docs/cordis-primer.md` → 建立框架语感
3. `docs/architecture.md` 全文 → 配合 `dsh --profile web --dump-config` 看真实插件树
4. 挑一个简单包（如 `packages/todo/`）通读：源码 + README + 它的 invariant，感受 seam 三角色和 effect 注册的写法
5. 动手前对照根 `AGENTS.md` 约定 + `docs/defensive-patterns.md`，提交前跑 `.agents/skills/dsh-pre-push-checks` 选择最小检查集

需要的话，我可以带你深入某个具体子系统（比如 agent-loop 的 turn 流实现，或某个 seam 的三角色代码长什么样）。
