# Agent Note: Opt-in session naming through Anthropic metadata.user_id

Status: implemented

[English](2026-09-01-session-user-id-metadata.md) | 中文

## Problem

位于 Anthropic 兼容端点之前的网关，可能把每个会话绑定到一个上游账号，并拒绝不声明会话的请求。内部自建的 OneAPI 网关在其 Kimi K3 通道上正是如此：完全相同的请求成功与否取决于由哪个上游中继服务，会校验的中继以 `400` 与 `code: SESSION_REQUIRED` 回答——"A stable client session is required for /v1/messages."

`llm-pi-ai` 无法从配置回答该要求。它的 `anthropic-messages` 路由把 `GenerateOptions.sessionId` 传给 pi-ai，但 pi-ai 只在 `compat.sendSessionAffinityHeaders` 为真时才把它变成 `x-session-affinity` 请求头，而本包的[兼容开关闸门](../architecture/2026-08-03-pi-ai-declared-provider-catalog.zh.md)对手工声明路由扣留该字段。针对该网关的实测显示请求头路线本身也回答不了：`x-session-affinity`、`x-session-id` 与 `session_id` 的失败率与完全不带标识相同，而请求体中携带含 `session_` 成员的 `metadata.user_id` 则每次都通过。profile schema 中没有任何字段能写入请求体，因此此前只剩两条出路：放弃该模型，或把一个 400 当作可重试。

## Decision

新增 profile 字段 `sendSessionUserId`，以 Anthropic `metadata.user_id` 字段发送请求的会话身份，拼写为 `session_` 加 `GenerateOptions.sessionId`。`src/adapter.ts` 用唯一的 `sessionOptions()` 助手产出一次请求的 pi-ai 会话词汇：`sessionId` 始终发送，因为读取它的 pi-ai 路由把它用于缓存或亲和、其余路由忽略它；`metadata.user_id` 只在路由要求时发送。循环未标记会话的请求两者都不发。

该字段默认关闭，因为它会把 harness 会话 id 透给端点——正是[强制应用归属](../architecture/2026-06-21-mandatory-app-attribution-headers.zh.md)刻意排除在每个请求必发内容之外的东西。seam 本身已允许该映射：`GenerateOptions.sessionId` 的文档说明适配器"可以把它映射为模型不可见的传输元数据"。

`session_` 是固定的过线 token，不是可调参数。Claude Code 自己的 `metadata.user_id` 就以 `session_<uuid>` 成员拼写，网关匹配的正是该 token；探测确认匹配只看该 token（裸 uuid 失败，`session_x` 通过）。harness 会话 id 在其后保持不透明——从不被解析、切分或改写。

`resolveProfiles()` 会拒绝把该开关设在物化模型都不使用 `anthropic-messages` 的路由上，并点名该路由：pi-ai 仅在该协议上读取 `metadata.user_id`，放在别处该字段什么也不发送却读起来像已配置。这与兼容闸门对"路由上没有模型能读取的开关"已采用的规则一致。

## Alternatives considered

**改为开放 `compat.sendSessionAffinityHeaders`。** 把该闸门条目从 `withhold` 翻为 `offer`，就能暴露 pi-ai 已有的会话亲和路径而无需新字段。它经实测后按证据否决：该请求头满足不了这项要求，开放它等于提供一个看起来是答案、实际不是的控制项。

**无条件发送 `metadata.user_id`。** 一行代码、无需配置，所有有此要求的网关都能被服务。否决原因：这会把会话身份透给部署可达的每个 Anthropic 兼容端点（包括公共提供方），只为了那些确实要求它的网关。

**在 `dsh-llm-retry` 中把 `SESSION_REQUIRED` 列为可重试。** 大约一半请求会成功，重试终会通过。否决：这用每次尝试烧掉一个失败请求，去绕开请求本可直接满足的客户端契约，还会把网关的校验拒绝归入暂时性失败。

**复刻 Claude Code 完整的 `user_<hex>_account_<uuid>_session_<uuid>` 取值。** 那是真实客户端发送的内容，因此对任何按形状匹配的实现都必然匹配。否决：`user_` 与 `account_` 成员会是与 harness 无关的编造值，而探测已表明只有 token 起决定作用。

**可配置的取值模板。** 格式字符串能服务想要其他拼写的网关。因缺少消费方而否决：目前不存在这样的网关，而模板无论如何仍要校验当前网关所需的那个 token。

## Consequences

位于会话绑定网关之后的部署只需为每个路由设一个布尔值；到达这类网关的会话成为上游可绑定的稳定身份——这同样让上游得以在该会话的多次请求间复用 prompt cache。

该取值在会话存续期间把一个 harness 会话与一个上游账号绑定。这既是目的也是代价：端点因此知道这些请求属于同一组，把会话相关性本身视为敏感的部署应让该字段保持关闭。

非 `anthropic-messages` 路由上的拒绝由路由的物化模型决定，因此路由日后把模型换成另一种协议时，会在下一次设置写入即失败，而不是静默失声。

`tests/sdk-options.spec.ts` 在过线层面固定该行为：手工声明的 `anthropic-messages` 路由经真实协议实现请求本地 mock 端点，记录到的请求体只在已配置且带会话时携带 `metadata.user_id`，并覆盖无法读取该字段的路由被拒绝的情形。
