# DeepSeek Harness 的 Code-Agent-Friendly 架构分析

> 本文分析 deepseek-harness 仓库如何通过工程化手段实现 "code agent 友好"，
> 解剖 `.agents/` 目录的核心作用，并提炼可迁移到一般 vibe coding 项目的
> 开发经验与项目模式设计。
>
> 分析基于对仓库的实地勘察（2026-08）：`.agents/` 下 2104 个文件、
> 37 个 `verify-*` 门禁脚本、15+ 个分层 AGENTS.md、指令注入插件源码。

---

## 目录

- [一、项目如何做到 code agent 友好](#一项目如何做到-code-agent-友好)
  - [1. 分层指令注入：AGENTS.md 即「作用域化的法律」](#1-分层指令注入agentsmd-即作用域化的法律)
  - [2. 规则必须可机械执行：37 个 verify-* 门禁](#2-规则必须可机械执行37-个-verify--门禁)
  - [3. 上下文工程：让 agent 低成本找到正确信息](#3-上下文工程让-agent-低成本找到正确信息)
  - [4. 自指能力：agent 可以修改自己的运行时](#4-自指能力agent-可以修改自己的运行时)
- [二、`.agents` 目录的核心作用](#二agents-目录的核心作用)
  - [1. 定位：agent 写的 RFC 库，对抗跨会话失忆](#1-定位agent-写的-rfc-库对抗跨会话失忆)
  - [2. 实测规模](#2-实测规模)
  - [3. 核心设计：路径即状态机](#3-核心设计路径即状态机)
  - [4. 它是强制工作流，不是可选文档](#4-它是强制工作流不是可选文档)
  - [5. `.agents/skills/`：按需加载的程序性知识](#5-agentsskills按需加载的程序性知识)
  - [6. 三种知识的分层架构](#6-三种知识的分层架构)
- [三、可迁移到 vibe coding 项目的经验与模式](#三可迁移到-vibe-coding-项目的经验与模式)
  - [模式 1：指令分层 + 单一事实来源](#模式-1指令分层--单一事实来源)
  - [模式 2：规约门禁化——「别相信 agent，相信 gate」](#模式-2规约门禁化别相信-agent相信-gate)
  - [模式 3：决策记录的路径状态机](#模式-3决策记录的路径状态机)
  - [模式 4：为 agent 的验证闭环优化测试基础设施](#模式-4为-agent-的验证闭环优化测试基础设施)
  - [模式 5：把「自我修改」收编进扩展点](#模式-5把自我修改收编进扩展点)
  - [模式 6：双语文档的机器校验](#模式-6双语文档的机器校验)
  - [模式 7：写作纪律即上下文卫生](#模式-7写作纪律即上下文卫生)
- [四、总结：一套「机构记忆」体系](#四总结一套机构记忆体系)
- [附录 A：关键参考文件清单](#附录-a关键参考文件清单)
- [附录 B：Agent Note 文件格式规范](#附录-bagent-note-文件格式规范)

---

## 一、项目如何做到 code agent 友好

这个仓库本质上是一个**由 agent 长期主力开发、并为 agent 持续开发而优化**的项目。
它的 agent 友好性不是偶然形成的，而是四层机制叠加的产物。

### 1. 分层指令注入：AGENTS.md 即「作用域化的法律」

项目中存在 **15+ 个分层 AGENTS.md** 文件，分布在根目录、`packages/`、`examples/`、
`docs/`、`scripts/`、`.agents/notes/`、`.agents/notes/implemented/`、
`packages/web/`、`packages/client/` 等位置。每一层只声明该目录下的局部规则，
形成「全局铁律 → 目录局部规则」的作用域链。

关键点是：这些文件**不是静态文档，而是被运行时真正注入的指令**：

- `packages/context/agent-instructions` 是一个专门的指令加载插件。它按 cwd 和
  目标文件路径解析指令来源链：全局（`~/.dsh/AGENTS.md`，即 `$DSH_HOME`）→
  工作区根 → 嵌套子目录，附带字节预算控制，最终以 `<system-reminder>` 形式
  注入模型对话。agent 在编辑某个目录下的文件时，会自动收到该层级的专属规则。
- **`CLAUDE.md` 全部是指向 `AGENTS.md` 的符号链接**（根、`packages/`、
  `examples/` 三处）。这保证了单一事实来源：规则只维护一份，同时兼容
  Claude Code、Codex 等多种读取不同文件名的 agent 工具，零额外维护成本。
- 指令加载有显式配置：`DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']`，
  可配置字节预算或整体关闭（`packages/examples/acp-demo/src/index.ts`）。

**核心经验**：指令是代码，不是 wiki。它有作用域、有加载机制、有预算控制，
还有测试——`agent-core.spec.ts` 中专门有 "must not be injected" 的负例测试，
确保不该注入的指令不会泄漏进上下文。

### 2. 规则必须可机械执行：37 个 verify-* 门禁

AGENTS.md 中的规约几乎都挂着对应的强制脚本，形成「规则文本 → 门禁脚本 →
git hook / CI」的完整执法链：

| AGENTS.md 规则 | 对应门禁 |
|---|---|
| 每个导出要有 JSDoc 契约 | `verify-export-jsdoc` |
| 文件结尾恰好一个换行 | pre-commit + `git diff --cached --check` |
| Agent Note 格式统一 | `verify-agent-note-format` |
| Agent Note 分类目录封闭 | `scripts/agent-note-tree.ts`（权威集合） |
| 文档字数预算 | `verify-doc-budgets`（`doc-budgets.manifest.json`） |
| cordis.yml 裸插件必须声明依赖 | `verify-cordis-config` |
| 归档 notes 永久冻结 | `verify-archived-agent-notes`（哈希清单） |
| 归档三件套完整性 | 同上（sidecar 哈希 + append-only manifest） |

AGENTS.md 中的核心原则原文：

> "Wire mechanically checkable invariants into an executed top-level gate and
> prove each changed acceptance path rejects an invalid case."
> （能被机器检查的不变量，必须接入一个被执行的顶层门禁，并证明每个被改动的
> 验收路径确实能拒绝非法输入。）

这是对 LLM 不可靠性的工程化对冲：**agent 会忘、会漂移，但 gate 不会**。
此外，门禁的报错信息里直接引用规则文档（例如 `cordis-catalog.ts` 的违规提示
附带 "see AGENTS.md"），让 agent 在失败现场就能获得修复指引——错误消息本身就是
agent 的高价值上下文。

反面同样重要：对于静态类型已保证的同进程边界，项目明确**禁止**添加运行时校验、
fallback 行为和敌意输入测试（"Trust TypeScript at typed same-process boundaries"），
只在 parser/config、model/tool JSON、durable/file、worker、process、wire 这些
真实边界上做校验。这避免了防御性代码的熵增。

### 3. 上下文工程：让 agent 低成本找到正确信息

- **测试可无密钥回放**：`pnpm run test:snapshot` 使用录制好的 transcript 回放
  ACP/headless 会话。agent 修改 prompt、工具输出或模型可见行为后，无需 API key、
  无需真实模型调用即可在本地验证输出变化。`test:snapshot:record` 才需要真实密钥
  重新录制。
- **从源码直接跑**：`pnpm dsh --profile headless "task"` 一条命令从 TypeScript
  源码启动完整 agent（经 tsx 的 ESM-only hook），形成「改代码 → 立即用自己跑任务
  验证」的自举闭环。
- **证据匹配表面**：`dsh-pre-push-checks` skill 明确规定不允许无脑全量测试，
  而是按 diff 范围（`pnpm run change-scope --base <ref>`）选择最小验证集——
  包行为改包测试、文档改 doc-sync、模型可见输出改快照、provider 行为改 e2e。
  这是对 agent 上下文窗口和 CI 成本的显式优化。CI 才拥有全量覆盖和平台矩阵。
- **文档词汇纪律**：`dsh-prose-standard` 与 `dsh-trim-cot-leakage` 两个 skill
  专门清除「推理 transcript 泄漏」（如 "used to"、"decision 3"、"rejected in
  review"、控制流叙述等），因为这类文字会误导后来的 agent 读者。
- **拒绝索引文件**：`.agents/notes/` 故意不维护 INDEX.md（有专门 note 记录该决策），
  因为索引会过期，而 agent 用 grep/目录浏览检索更可靠。这是「为 agent 的检索方式
  设计信息架构」，而非为人类的浏览习惯设计。

### 4. 自指能力：agent 可以修改自己的运行时

- `packages/self-modification` 让 agent 检视、挂载自己的插件；
  `pnpm run demo:cordis` 直接演示 agent 修改自己的运行时。
- 插件化架构（everything is a plugin，基于 vendored Cordis）意味着 agent 改变
  系统行为时永远走「加插件」而非「改循环」。AGENTS.md 明确规定
  **"Plugins, not loop changes"**：新行为只能落在文档化的扩展点上；修改
  `agent-loop` 必须同步更新 `docs/architecture.md`。
- 这把 agent 修改的爆炸半径限制在扩展点上：能力接缝（capability seam）由
  Service Definition / Service Provider / Consumer 三个角色组成，结构完整、
  职责清晰，agent 可以安全地在 seam 内实现新 provider 而不触碰核心。

---

## 二、`.agents` 目录的核心作用

### 1. 定位：agent 写的 RFC 库，对抗跨会话失忆

`.agents/notes/AGENTS.md` 自己给出了定义：

> "Agent Notes are effectively RFCs written by agents: durable proposals and
> decision records that preserve rationale, alternatives, consequences, and
> required verification."

这个目录解决的是 code agent 最致命的结构性缺陷——**没有跨会话记忆，会反复
重新辩论已经定过的决策、重新提出已被否决的方案、重复踩已修过的坑**。
`.agents/` 就是项目的「机构记忆」（institutional memory）。

### 2. 实测规模

```
.agents/
├── notes/
│   ├── implemented/   514 篇  ← 已落地的决策记录
│   │   ├── architecture/    130
│   │   ├── feature/         172
│   │   ├── bug-fix/          82
│   │   ├── process/          69
│   │   ├── simplification/   48
│   │   └── testing/          13
│   ├── proposed/       25 篇  ← 待评审/未实现的提案
│   ├── rejected/       11 篇  ← 被否决的提案（负知识资产）
│   └── archived/      143 篇  ← 冻结的历史快照（permanently frozen）
└── skills/             11 个项目级技能
```

另有每篇 note 的中英双语三件套（`.md` + `.zh.md` + `.i18n.yaml` sidecar），
全目录共 2104 个文件。

### 3. 核心设计：路径即状态机

每篇 note 的两个正交属性**编码在路径里**而非正文里：

```
{lifecycle}/{class}/yyyy-mm-dd-topic-title.md
```

**Lifecycle（顶层目录）= 状态机**：

```
proposed/ ──实现──> implemented/ ──失去未来指导价值──> archived/（冻结）
    │                      │
    └──否决──> rejected/   └──被完全取代──> 合并入新 note 后删除（需保全全部 rationale）
```

- 状态迁移 = `git mv` + 同一变更内改写正文骨架：proposed 的 `## Proposal`
  必须改写为现在时的 `## Decision`，`## Acceptance criteria` / `## Risks`
  折叠进 `## Consequences`。门禁交叉校验 `Status:` 行与所在目录一致，
  不一致直接 fail。
- `implemented/` 的 note 必须**随代码同步更新**（路径、符号、默认值变了，
  同一个 PR 里改 note 的事实描述），但**不许改写决策本身**——决策反转必须开
  新 note 并交叉链接。已归档的文件永久冻结，连翻译、重格式化都禁止，由
  sidecar 哈希 + append-only manifest 强制。

**Class（二层目录）= 封闭分类集合**：

| Class | 覆盖范围 |
|---|---|
| `feature` | 新的用户可见或模型可见能力 |
| `bug-fix` | 修复缺陷、关闭 postmortem 暴露的缺口 |
| `simplification` | 删除代码/行为/表面积，不新增能力 |
| `architecture` | 关于**交付源码**的结构性决策 |
| `process` | 代码**周边**的工具链、策略、工作流 |
| `testing` | 测试基础设施与策略 |

分类集合的单一权威是 `scripts/agent-note-tree.ts`，分类门禁拒绝其他目录名。
**故意没有 `refactor`**——因为它与 simplification 的判别式（"可观察行为是否
变化？"）重叠。封闭词汇表防止 agent 随意发明分类导致熵增；想加新类必须改
权威脚本和文档，把「发明新词汇」变成显式成本。

**强制 `## Alternatives considered`**：

> "A decision recorded without what it beat invites re-litigation — the failure
> Agent Notes exist to prevent."
> （没有记录被否决方案的决策，必然招致重新辩论——这正是 Agent Notes 要防止的
> 失败。）

`rejected/` 目录的存在同理：一个被否决的提案本身就是负知识资产，它的存在
是为了阻止下一个会话的 agent 重新提出同一个方案。只有当否决理由不再能防止
「诱人的错误」时才允许删除。

### 4. 它是强制工作流，不是可选文档

根 AGENTS.md 的硬规则：

> "Non-trivial changes MUST include an Agent Note in the same PR."
> （非平凡变更必须在同一 PR 中包含 Agent Note。）

「非平凡」有明确判定标准：改变行为、架构、跨文件/跨包契约、流程/工具、测试
策略、磁盘/线路/配置格式，或任何维护者可能合理重新审视的决策。只有纯机械、
纯局部的编辑才豁免。

由此，**决策史与代码史在 git 里同构演化**：任何一个「为什么这样做」的问题，
都能通过目录浏览或 grep 找到带完整 rationale、备选方案、后果的记录，而且
因为 implemented note 随代码同步更新，记录与现实不会漂移。

新增 note 还会触发**取代检查**（supersession check）：`dsh-archive-agent-notes`
skill 负责把被完全取代的旧 note 归档进冻结树，保持活跃树的信噪比。

### 5. `.agents/skills/`：按需加载的程序性知识

11 个项目 skill 覆盖 agent 最常犯错的**程序性**场景：

| Skill | 触发场景 |
|---|---|
| `dsh-pre-push-checks` | 推送前选最小验证集 |
| `dsh-code-review` | PR 评审时对齐本仓库标准 |
| `dsh-doc-standards` | 写/审/审计文档 |
| `dsh-doc-site-sync` | 文档站发布与投影链接 |
| `dsh-prose-standard` | 行文是否达到散文标准 |
| `dsh-trim-cot-leakage` | 清除推理过程泄漏进文档 |
| `dsh-find-simplifications` | 寻找非显然的简化候选 |
| `dsh-archive-agent-notes` | notes 的归档/修剪/恢复 |
| `dsh-merging-stacked-prs` | 落地 PR 栈 |
| `dsh-translate-docs` | 双语翻译流程（仅显式调用） |
| `record-browser-gif` | 为 PR 录制 GUI 演示 GIF |

skill 的 frontmatter `description` 就是触发条件，由 skill 注册表按来源分层发现
（`packages/skill/skill-filesystem/src/index.ts` 中 `.agents/skills` 是
`project-agents` 来源，低于全局 `~/.agents/skills` 的优先级设计）。
**常驻上下文只放触发条件摘要，完整指令按需加载**——这是 skill 机制对上下文
窗口经济性的核心贡献。

### 6. 三种知识的分层架构

`.agents/` 与 AGENTS.md 体系合在一起，构成一个精心分层的企业知识架构：

| 知识类型 | 载体 | 加载方式 | 类比 |
|---|---|---|---|
| 声明式规则（"必须/禁止"） | 分层 AGENTS.md | 常驻注入（带预算） | 法律 |
| 程序性知识（"怎么做某类任务"） | `.agents/skills/` | 按触发条件按需加载 | 操作规程 |
| 决策知识（"为什么这样定"） | `.agents/notes/` | 检索式（grep/浏览） | 判例法 |
| 机械不变量 | `scripts/verify-*` 门禁 | 执行时强制 | 执法机构 |

谁也不污染常驻上下文，各司其职。

---

## 三、可迁移到 vibe coding 项目的经验与模式

以下七个模式按「引入成本从低到高」排序，前三个可以今天就落地。

### 模式 1：指令分层 + 单一事实来源

**做法**：根 `AGENTS.md` 写全局铁律，子目录写局部规则；用符号链接兼容各
agent 工具（`CLAUDE.md -> AGENTS.md`）。

要点：

- 每条规则保持自包含，并链接到权威长文档，而不是把长文档复制进来。
- 规则总量设预算（本项目用 `verify-doc-budgets` 卡上限）——**指令越长，
  agent 遵守率越低**，指令文件本身也要接受「字数门禁」。
- 规则要写「可判定的行为」，不写「价值观宣言」。对比：
  - ❌ "保持代码整洁"
  - ✅ "每个导出要有 JSDoc 契约；`pnpm run verify-export-jsdoc` 强制"

### 模式 2：规约门禁化——「别相信 agent，相信 gate」

**做法**：凡是能用脚本检查的规则，当天就写脚本。三层执法：`verify-*` 脚本
（本地手动）→ git hook（commit/push 时）→ CI（全量）。

要点：

- 门禁报错信息里直接引用规则文档和修复方法，让 agent 在失败现场获得上下文。
  错误消息是 agent 最高价值的上下文之一。
- 反向约束同样重要：静态类型已保证的边界不要写运行时代偿，避免防御性代码
  熵增。把校验集中在真实边界：parser/config、model/tool JSON、持久化文件、
  worker、进程间、网络。
- 不要全局禁用规则来消音，用窄化的、带理由的例外。

### 模式 3：决策记录的路径状态机

这是本项目最值得借鉴的精华。最小可行版本：

```
.agents/notes/{proposed,implemented,rejected}/{feature,bug-fix,process}/yyyy-mm-dd-topic.md
```

关键洞察：

1. **状态放路径里**。目录列表就是工作清单；状态迁移有机械规则；gate 能交叉
   校验。纯正文 frontmatter 的方案 agent 会忘记更新，路径不会说谎。
2. **强制 "Alternatives considered" 和独立可读的 "Problem" 两节**。这是防止
   重新辩论（re-litigation）的核心机制。
3. **不建索引**，训练 agent 用搜索；**分类集合封闭**，发明新分类必须改权威
   脚本。
4. **implemented 记录随代码同步更新事实，但决策不可改写**——决策反转开新档、
   交叉链接。这让历史既可信赖又不会漂移。
5. **保留 rejected/**：被否决的方案是负知识资产，删除的唯一理由是它不再能
   防止一个「诱人的错误」。

### 模式 4：为 agent 的验证闭环优化测试基础设施

- **无密钥快照回放**：录制真实 transcript，agent 无需凭据即可验证
  model-visible 输出变更。这把「改 prompt/工具描述」的验证成本从一次真实
  API 调用降到一次本地回放。
- **证据匹配表面**：把「按 diff 范围选最小验证集」写成明确的决策树（放进
  skill），禁止默认全量跑。vibe coding 的成本大头就是 agent 反复跑重测试。
- **fixture 必须跨平台可重放**（"fix fixtures, not normalizers"）——
  normalizer 放水会让 agent 得到假阳性，进而做出错误的「测试通过」声明。
- **自举闭环**：提供一条命令让 agent 从源码启动自己跑真实任务，形成
  「改 → 跑 → 看结果」的最短回路。

### 模式 5：把「自我修改」收编进扩展点

- 用插件架构给 agent 划定安全的修改面：新行为只能长在文档化的扩展点上；
  改核心循环需要更高门槛（本项目要求同步改架构文档）。
- 能力接缝（Service Definition / Provider / Consumer 三角色）让 agent 可以
  安全地替换实现而不触碰编排逻辑。
- 这让 vibe coding 的「agent 自由发挥」变成「agent 在防爆半径内自由发挥」。

### 模式 6：双语文档的机器校验

如果团队需要多语文档：

- 机器可检 token 保持单一语言（本项目 note 的 `# Agent Note: ` 标题和
  `Status:` 行恒为英文，门禁只认英文 token）。
- 用 sidecar 一致性记录 + 配对 gate 校验双语同步，而不是靠人工纪律。
- **多语一致性是典型的人工守不住、机器易检查的规则**，必须门禁化。

### 模式 7：写作纪律即上下文卫生

`dsh-trim-cot-leakage` 针对的问题值得每个 vibe coding 项目警惕：agent 写的
注释和文档容易泄漏推理过程（"之前是 X"、"这个在 review 中被否"、"后面某个 PR
会处理"），这些对后续 agent 是**误导性上下文**——后来的 agent 会把已经过时
的历史叙述当成当前事实。

把「prose 标准」做成 skill 定期检查，相当于上下文卫生的除尘机制。规则示例：
注释和文档陈述完整契约与现状，不叙述控制流、不保留评审历史、不复述代码。

---

## 四、总结：一套「机构记忆」体系

这个项目的范式可以概括为一句话：

> **把 agent 当作一个会遗忘、会漂移、但可被工程约束围住的长期合作者。**

围绕这个定位，它构建了完整的配套体系：

- 用**分层注入的指令**（AGENTS.md 链）做「法律」——作用域化、有预算、有测试；
- 用 **37 个门禁脚本**做「执法」——能机器检查的规则绝不靠自觉；
- 用**路径编码的 RFC 库**（`.agents/notes/`）做「判例法」——状态机化、
  强制记录备选方案、随代码同步演化；
- 用**按需加载的 skill** 做「操作规程」——常驻上下文只放触发条件；
- 用**无密钥回放 + 最小验证集**给它低成本的验证闭环；
- 用**插件化扩展点**给它低爆炸半径的改造空间。

`.agents/` 的本质，是这套体系里**对抗 agent 跨会话失忆的机构记忆**：
它把「我们为什么这样做、试过什么、否决过什么」从人类的大脑和 Slack 聊天
记录里，搬进了 agent 可检索、门禁可校验、git 可追踪的仓库内部。

对 vibe coding 项目的最终启示：**agent 产出的质量上限，取决于你为它构建的
记忆与约束体系的下限。** 指令、门禁、决策记录、技能库，这四种基础设施的投入，
会以复利形式反映在每一次 agent 会话的产出质量上。

---

## 附录 A：关键参考文件清单

| 文件 | 作用 |
|---|---|
| `AGENTS.md`（根） | 全局铁律：仓库布局、命令、约定、防御模式 |
| `CLAUDE.md` → `AGENTS.md` | 符号链接，跨工具兼容的单一事实来源 |
| `.agents/notes/README.md` | Agent Notes 的完整规则：布局、分类、生命周期、格式 |
| `.agents/notes/AGENTS.md` | notes 目录的局部规则（取代检查） |
| `.agents/notes/implemented/AGENTS.md` | implemented 目录的局部规则（同步现实） |
| `.agents/skills/dsh-pre-push-checks/SKILL.md` | 最小验证集模式的样板 |
| `packages/context/agent-instructions/src/index.ts` | 指令注入插件实现 |
| `packages/skill/skill-filesystem/src/index.ts` | skill 分层发现（`.agents/skills` 来源） |
| `scripts/verify-agent-note-format.ts` | 规约门禁化的样板 |
| `scripts/agent-note-tree.ts` | 分类封闭集合的单一权威 |
| `scripts/verify-archived-agent-notes.ts` | 冻结归档的哈希校验 |
| `docs/architecture.md` | 架构权威文档（改 agent-loop 必须同步） |
| `docs/testing.md` | 测试策略权威文档 |
| `docs/defensive-patterns.md` | 生命周期/并发/子进程防御模式 |

## 附录 B：Agent Note 文件格式规范

每篇活跃 Agent Note 遵循统一格式（`pnpm run verify-agent-note-format` 强制，
属于 `doc-sync` 门禁的一部分）。

**头部块**（前三行，恰好如此）：

```markdown
# Agent Note: <title>

Status: <status>
```

`Status:` 只能是三种形式之一，且必须与所在 lifecycle 目录一致：

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <一句话原因>`

**正文骨架**：

- 所有 note 以 `## Problem` 开头——动机必须独立于解决方案可读懂。
- `proposed/`：`## Problem → ## Proposal → … → ## Alternatives considered →
  ## Acceptance criteria → ## Risks`
- `implemented/`：`## Problem → ## Decision → … → ## Alternatives considered →
  ## Consequences`（现在时描述已交付现实；禁止出现 `## Proposal`、
  `## Plan`、`## Acceptance criteria` 等提案期标题）
- `rejected/`：保留提案期原样冻结，判决在 `Status:` 行。

**强制节**：每篇必须带 `## Alternatives considered`——每个被认真考虑过的
备选方案一段，说明它为什么输了。2026-07-05 之前无法重建备选方案的历史文件
使用固定的豁免注释占位。

**命名与交叉引用**：文件名日期是首次提出日期（以 git 历史为准）；note 之间
的交叉引用必须使用相对 markdown 链接（可机械检查、能经受目录迁移），禁止
裸文字或编号指代。
