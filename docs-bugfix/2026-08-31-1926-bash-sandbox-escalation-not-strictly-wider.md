# bash 工具频繁报 "sandbox escalation ... is not strictly wider" 的原因与修复

## 现象

agent 调用 bash 时频繁出现如下错误,命令完全不执行,浪费一整轮工具调用:

```
Error: sandbox escalation to "danger-full-access" is not strictly wider than
this call's current "danger-full-access" mode
```

典型触发调用(只读命令也中招):

```json
{
  "command": "pwd && git status --short --branch",
  "description": "Check workspace and git state",
  "justification": "Confirm the active repository and worktree before editing.",
  "sandbox_permissions": "danger-full-access",
  "workdir": "/Users/chuanq/dev_workspace/baidu/im-ds/budget-combine"
}
```

## 根因分析

错误抛出点: `packages/sandbox/sandbox/src/escalation.ts` 的 `approveEscalation()`,
严格更宽检查在一切执行与审批之前完成(fail-closed):

```ts
if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode as SandboxMode)) {
  throw new Error(`sandbox escalation to "${mode}" is not strictly wider than ...`)
}
```

完整因果链:

1. **会话生效模式已是 `danger-full-access`(阶梯顶端)**。本机
   `~/.dsh/settings.yaml` 配置了 `permission.defaultPreset: danger-full-access`,
   会话创建时 preset 应用到 sandbox mode,因此每个新会话的 effective mode
   都是 `danger-full-access`。
2. **`WIDER_MODES` 没有为 `danger-full-access` 定义任何更宽目标**
   (`read-only → [workspace-write, danger-full-access]`,
   `workspace-write → [danger-full-access]`)。顶端之上无模式,任何
   `sandbox_permissions` 请求都必然命中这个 throw。
3. **bash 工具 schema 仍然广播 `sandbox_permissions` 字段**
   (`packages/shell/tool-bash/src/index.ts`)。只要挂载了沙箱执行器
   (`ctx.shell.sandboxMode !== undefined`),enum
   `[workspace-write, danger-full-access]` 就完整暴露——这是刻意设计:
   schema 是注册表全局的,而 effective mode 是逐会话的;按部署默认裁剪 enum
   会让运行中被切窄的会话失去升宽通道。副作用是顶端会话里的模型永远看得见
   一个"永远不可能合法"的字段。
4. **模型投机性填写该字段**。工具描述要求"仅在对真实 denial 的一次性重试时
   合法",但模型(GLM-5.3 等)把它误读成 Claude Code 风格的"本命令权限声明":
   workdir 不在会话 workspace 内时尤其倾向预填 `danger-full-access` 保险。
   `danger-full-access` 下不存在真实 denial(沙箱不限制任何文件操作),模型
   也就无从学到"不该升权",于是反复复发。
5. 严格更宽检查先于审批检查、先于命令执行,所以命令**完全没跑**就直接报错。

安全上无害(fail-closed 闸门按设计工作,没有任何越权),但每次报错浪费一轮
工具调用,体验上就是"频繁报错"。

## 修复内容

两处模型可见文案的修改,让模型在两个决策点上都能一步自纠:

### 1. 运行时上下文提前声明升级天花板

`packages/sandbox/sandbox-policy/src/index.ts` — `renderPolicyContext()` 的
`danger-full-access` 分支,在策略陈述后追加一句:

```
Current DSH file policy: danger-full-access. The DSH file sandbox does not
restrict file modifications by available operations. This is the widest sandbox
mode: a sandbox_permissions request can never be strictly wider than it — do
not set sandbox_permissions.
```

模型在每个 danger-full-access 会话的首次请求前就会看到"本会话设置
sandbox_permissions 必然失败"的事实,从源头阻止投机填写。措辞刻意复用错误
文本里的 "not strictly wider" 词汇,让上下文与模型实际看到的报错相互印证。

### 2. 错误文本自带纠正指引

`packages/sandbox/sandbox/src/escalation.ts` — 非更宽请求的报错追加纠正方式:

```
sandbox escalation to "<mode>" is not strictly wider than this call's current
"<effectiveMode>" mode; "<effectiveMode>" already grants at least "<mode>" —
resend the same <command|operation> without sandbox_permissions
```

该错误只在"请求模式 ≤ 当前生效模式"时触发(相等或更窄),因此
"去掉字段重发"在所有触发场景下都是正确动作。已经中招的模型读一次报错
即可自纠,不再需要猜测。

### 随附同步更新

- `packages/sandbox/sandbox-policy/tests/policy.spec.ts`、
  `packages/sandbox/sandbox/tests/escalation.spec.ts`:逐字固定新文案。
- `packages/sandbox/sandbox-policy/README.md` / `README.zh.md`、
  `packages/sandbox/sandbox/README.md`、`packages/shell/tool-bash/README.md`:
  引用文案与升权契约段落同步。
- Agent Notes 三篇(2026-07-06-sandbox、2026-07-30-current-sandbox-policy-context、
  2026-07-31-capability-neutral-sandbox-policy-context,各含中英对):
  shipped 事实按当前文本就地更新。
- 录制会话快照:`DSH_SNAPSHOT=refresh` 走 `test:snapshot:refresh` 与
  `test:expected:refresh` 再生(`snapshots/session`、`snapshots/acp`、
  `snapshots/web/permission-policy-context`、`apps/cli/tests/profiles/**`);
  `apps/web/tests/permission-policy-context.e2e.ts` 增加对新句子的断言。
- Python SDK 快照(`scripts/snapshots/python-sdk-single-exe/`,
  advanced + restart 共 20 处):句子级确定性替换(本地未构建 python
  single-exe 运行场景重录;替换与重录输出逐字节一致)。

## 验证

- `pnpm exec vitest run packages/sandbox/sandbox-policy/tests/policy.spec.ts
  packages/sandbox/sandbox/tests/escalation.spec.ts` — 29 passed
- `pnpm exec vitest run packages/shell/tool-bash/tests/tools.spec.ts
  packages/shell/tool-pwsh/tests/tools.spec.ts packages/fs/tool-fs/tests/tools.spec.ts`
  — 220 passed
- `pnpm run test:snapshot:refresh` — 110 passed | 2 skipped
- `pnpm run test:snapshot`(replay 复验)— 110 passed | 2 skipped
- `pnpm run test:expected:refresh` — 27 passed
- `DSH_SNAPSHOT=replay vitest --config vitest.web.config.ts
  apps/web/tests/permission-policy-context.e2e.ts` — 3 passed(host lib 重建后)

## 未改动的设计取舍

- `ESCALATION_TARGETS` 仍在顶端会话广播完整 enum(支持运行中切窄的会话),
  接受"字段可见但必然失败"的组合,靠上述两处文案把失败概率与失败成本压到
  最低。
- 若仍观察到个别模型持续误填,后续可在 `approveEscalation` 之前按
  effective mode 静默剥离等值/更窄的 `sandbox_permissions`(视为 no-op 而非
  错误),但那会弱化"escalation is never speculative"的教学信号,本次不采用。
