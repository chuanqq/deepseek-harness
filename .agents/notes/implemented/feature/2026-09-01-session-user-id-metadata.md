# Agent Note: Opt-in session naming through Anthropic metadata.user_id

Status: implemented

English | [中文](2026-09-01-session-user-id-metadata.zh.md)

## Problem

A gateway sitting in front of an Anthropic-compatible endpoint may bind each conversation to one upstream account and refuse a request that names no conversation. The internally hosted OneAPI gateway does exactly that for its Kimi K3 channel: an identical request succeeds or fails by which upstream relay serves it, and the failing relays answer `400` with `code: SESSION_REQUIRED` — "A stable client session is required for /v1/messages."

`llm-pi-ai` could not answer that requirement from configuration. Its `anthropic-messages` routes send `GenerateOptions.sessionId` into pi-ai, but pi-ai turns that into the `x-session-affinity` header only when `compat.sendSessionAffinityHeaders` is true, and this package's [compat gate](../architecture/2026-08-03-pi-ai-declared-provider-catalog.md) withholds that field from hand-declared routes. Measurement against the gateway showed the header route answers nothing anyway: `x-session-affinity`, `x-session-id`, and `session_id` all kept failing at the same rate as no identifier at all, while a request body carrying `metadata.user_id` with a `session_` member passed every attempt. Nothing in the profile schema could put a field in the request body, so the only workarounds were to abandon the model or to make a 400 retryable.

## Decision

A profile field, `sendSessionUserId`, sends the request's session identity as the Anthropic `metadata.user_id` field, spelled `session_` plus `GenerateOptions.sessionId`. `src/adapter.ts` owns one `sessionOptions()` helper that produces pi-ai's session vocabulary for a request: `sessionId` always travels, because pi-ai routes that read it use it for caching or affinity and the rest ignore it, and `metadata.user_id` travels only where the route asked for it. A request the loop stamped with no session adds neither.

The field is off by default because it discloses the harness session id to the endpoint — the one thing [mandatory app attribution](../architecture/2026-06-21-mandatory-app-attribution-headers.md) deliberately keeps out of what every request sends. The seam already permits the mapping: `GenerateOptions.sessionId` is documented as identity "adapters may map to model-hidden transport metadata."

`session_` is a fixed wire token, not a tunable. Claude Code spells its own `metadata.user_id` with a `session_<uuid>` member, and gateways match that token; probing confirmed the match is on the token alone (a bare uuid failed, `session_x` passed). The harness session id stays opaque behind it — it is never parsed, split, or reformatted.

`resolveProfiles()` refuses the switch on a route whose materialized models speak no `anthropic-messages`, naming the route: pi-ai reads `metadata.user_id` on that protocol alone, so elsewhere the field would send nothing while reading as configured. This is the rule the compat gate already applies to a switch no model on the route could read.

## Alternatives considered

**Offer `compat.sendSessionAffinityHeaders` instead.** Flipping that gate entry from `withhold` to `offer` would expose pi-ai's existing session-affinity path with no new field. It was measured against the gateway and rejected on evidence: the header does not satisfy this requirement, and offering it would present a control that looks like the answer and is not.

**Send `metadata.user_id` unconditionally.** One line, no configuration, and every gateway with this requirement served. Rejected because it would disclose session identity to every Anthropic-compatible endpoint a deployment reaches, including public providers, for the benefit of the gateways that ask.

**Make `SESSION_REQUIRED` retryable in `dsh-llm-retry`.** Roughly half the requests succeed, so a retry would eventually get through. Rejected: it spends a failed request per attempt to work around a client contract the request can satisfy outright, and it would file a gateway's validation refusal under transient failure.

**Reproduce Claude Code's full `user_<hex>_account_<uuid>_session_<uuid>` value.** It is what a real client sends, so it is guaranteed to match anything matching on shape. Rejected: the `user_` and `account_` members would be invented values with no harness meaning, and probing showed the token alone decides.

**A configurable value template.** A format string would serve a gateway wanting some other spelling. Rejected for want of a consumer: no such gateway is known, and a template would have to be validated for the token the current one needs anyway.

## Consequences

A deployment behind a conversation-binding gateway sets one boolean per route, and a session that reaches such a gateway becomes a stable identity the upstream can bind to — which is also what lets that upstream reuse prompt cache across the session's requests.

The value ties one harness session to one upstream account for as long as the session lives. That is the point, and it is also the cost: the endpoint learns that these requests belong together, and a deployment that considers session correlation itself sensitive leaves the field off.

The refusal on a non-`anthropic-messages` route is decided from the route's materialized models, so a route that later replaces its models with a different protocol fails at the next settings write rather than silently going quiet.

`tests/sdk-options.spec.ts` pins the behavior at the wire: a hand-declared `anthropic-messages` route runs against the local mock endpoint through the real protocol implementation, and the recorded request body carries `metadata.user_id` only for a configured route with a session, plus the refusal for a route that cannot read the field.
