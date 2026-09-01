# OneAPI 网关 Kimi K3 报 SESSION_REQUIRED 的原因与修复

## 现象

在 Web GUI 中把模型切到 `OneApiMessages`（settings 路由 `one-api-anthropic-messages`）的 Kimi K3 后，请求间歇性失败：

```
400 {"error":{"message":"A stable client session is required for /v1/messages. Start a new client conversation or include a stable session identifier. (request_id=req_v2-green-7_1cfu5_mtcccjpc_36g9r2_mtiarxa8_8zvf kind=validation code=SESSION_REQUIRED) (request id: 2026090114394737141034617559263)","type":"invalid_request_error","param":"","code":"SESSION_REQUIRED"}}
```

同一路由上的 Opus 4.8 不受影响。

## 根因分析

错误由网关（`https://oneapi-comate.baidu-int.com`）产生，不是模型侧、也不是 DSH 抛出的。用该路由的凭据对 `/v1/messages` 发送最小探针请求（约 130 次、每次 8 output tokens）实测：

1. **失败是间歇的，且由上游中继决定。** 完全相同的 K3 请求 16 次里 6 成功 10 失败；失败响应的 `request_id` 形如 `req_v2-blue-4`、`req_v2-green-8`（用户那条是 `req_v2-green-7`），成功响应只带 OneAPI 自己的数字 `x-oneapi-request-id`。K3 通道后面是一个中继/账号池，只有部分节点强制校验会话标识。
2. **只有请求体 `metadata.user_id` 能满足它，请求头一律无效。** 每组 10 次：不带任何标识 4/10；`x-session-affinity` 3/10；`x-session-id` 4/10；`session_id` 5/10；`metadata.user_id` 为裸 uuid 2/10；`metadata.user_id` 为 Claude Code 形态 `user_<hex>_account_<uuid>_session_<uuid>` **10/10**。
3. **判定标准是 `user_id` 中是否含 `session_` 这个 token。** 6–8 次/组：`session_abc123` 全过、`dsh_session_abc123` 全过、`session_x` 全过、去掉下划线的 `sessionabc123` 仅 3/6。取值本身不校验 uuid 格式。
4. **DSH 侧从不发送 `metadata`。** `packages/llm/llm-pi-ai/src/adapter.ts` 只把 `GenerateOptions.sessionId` 传给 pi-ai；pi-ai 的 `dist/api/anthropic-messages.js` 只在模型 compat 的 `sendSessionAffinityHeaders === true` 时把它变成 `x-session-affinity` 请求头，而 `src/catalog.ts` 的 `ANTHROPIC_COMPAT_GATE` 对该字段标记 `withhold`，手工声明路由无法在 settings.yaml 里打开——而且按第 2 点，请求头即使打开也没用。
5. 因此 settings.yaml 层面不存在绕过办法：`headers` 只能加请求头，`metadata` 不可配。

安全上无影响；后果是 K3 约半数请求被网关直接拒绝。

## 修复内容

### 1. 新增按路由 opt-in 的 profile 字段

`packages/llm/llm-pi-ai/src/config.ts` — `PiAiProviderProfile` 新增 `sendSessionUserId?: boolean`（schema 同步加 `z.boolean()`）。启用时以 Anthropic `metadata.user_id` 发送会话身份，拼写为 `session_` 加 `GenerateOptions.sessionId`。

默认关闭：它会把 harness 会话 id 透给端点，而这正是 `packages/llm/llm/src/attribution.ts` 刻意排除在每请求必发内容之外的东西。seam 本身允许该映射——`GenerateOptions.sessionId` 的 JSDoc 已写明适配器可以把它映射为模型不可见的传输元数据。

`resolveProfiles()` 在物化模型都不使用 `anthropic-messages` 时拒绝该开关并点名路由（`USER_ID_METADATA_API` 常量导出自 `src/catalog.ts`），与兼容闸门对"路由上没有模型能读取的开关"已有的规则一致。

### 2. 适配器统一产出会话词汇

`packages/llm/llm-pi-ai/src/adapter.ts` — 新增 `sessionOptions()` 助手替换原先单独的 `sessionId` 透传：`sessionId` 始终发送（读取它的 pi-ai 路由用于缓存/亲和，其余忽略），`metadata.user_id` 只在路由要求时发送；循环未标记会话的请求两者都不发。`session_` 作为固定过线 token 记为 `SESSION_USER_ID_PREFIX`，会话 id 在其后保持不透明（不解析、不切分）。

### 3. 用法

```yaml
llm-pi-ai:
  providers:
    one-api-anthropic-messages:
      api: anthropic-messages
      baseURL: https://oneapi-comate.baidu-int.com
      sendSessionUserId: true
      models:
        - id: Kimi K3
```

### 随附同步更新

- `packages/llm/llm-pi-ai/tests/sdk-options.spec.ts`：新增 4 个用例，以真实 `anthropic-messages` 协议实现请求本地 mock 端点，断言记录到的**请求体**。
- `packages/llm/llm-pi-ai/README.md` / `README.zh.md`：字段表新增一行，并新增"向网关声明会话"小节。
- `docs/config-catalog.md` / `.zh.md`：`pnpm run gen-config-catalog` 再生（同时修正了上一次 sandbox 改动遗留的 `sandbox-policy/src/index.ts` 行号漂移）。
- Agent Note：`.agents/notes/implemented/feature/2026-09-01-session-user-id-metadata.md`（含中文对与 i18n 记录）。

## 验证

- 真实网关端到端（临时 spec 走 `PiAiAdapter` → pi-ai → 网关，验证后已删除）：`sendSessionUserId: true` 连续 8 次全部 `ok`；同一路由关闭该字段 8 次中 4 次 `SESSION_REQUIRED`。
- `npx vitest run packages/llm/llm-pi-ai/tests/sdk-options.spec.ts` — 6 passed
- `npx vitest run packages/llm/llm-pi-ai` — 276 passed (11 files)
- `npx vitest run --coverage packages/llm/llm-pi-ai` — `adapter.ts`、`config.ts`、`catalog.ts` 均 100%（其余包因过滤未跑而报阈值，与本次改动无关）
- `pnpm run typecheck` — 通过
- `pnpm run lint` — 0 warnings, 0 errors
- `pnpm run test:docs` — 15 passed, 0 failed
- `pnpm run verify-config-catalog` — up to date
- `pnpm run verify-export-jsdoc` — 通过

## 未改动的设计取舍

- 未把 `compat.sendSessionAffinityHeaders` 从 `withhold` 翻为 `offer`：实测该请求头满足不了本要求，开放它等于提供一个看似是答案的无效控制项。
- 未无条件发送 `metadata.user_id`：那会把会话身份透给所有 Anthropic 兼容端点，包括公共提供方。
- 未把 `SESSION_REQUIRED` 加入 `dsh-llm-retry` 的可重试集合：重试能"蒙对"，但每次尝试烧掉一个失败请求，且把网关的校验拒绝错归为暂时性失败。
- 未复刻 Claude Code 完整的 `user_<hex>_account_<uuid>_session_<uuid>` 取值：`user_`/`account_` 段在 harness 中没有含义，而探测表明只有 `session_` token 起作用。
