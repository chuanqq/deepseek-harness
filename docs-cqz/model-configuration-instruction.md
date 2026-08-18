有的，这部分文档相当完整。我分「参考文档在哪」和「具体怎么配」两部分回答。

## 一、参考文档

| 文档 | 内容 |
|---|---|
| `docs/user/guide/providers.md`（中文版 `providers.zh.md`） | **用户向主文档**：Web UI 里怎么配 DeepSeek 官方 key、加目录内 provider（Anthropic/OpenAI 等）、加自定义 provider、选模型、排错 |
| `packages/llm/llm-pi-ai/README.md` | **开发者/高级配置权威参考**：通用多 provider 适配器（基于 `@earendil-works/pi-ai`），`settings.yaml` 直写、catalog 解析、推理等级、上下文容量全在这里 |
| `docs/config-catalog.md` | 生成文档，列出所有插件支持的配置字段和默认值 |

模型能力适配走的是 capability seam：`core` 的 `ctx.llm` 是 Service Definition，`dsh-llm-pi-ai`（多 provider 通用）和 `dsh-llm-deepseek`（DeepSeek 直连）是 Provider。

## 二、配置自定义 API 端点

**方式 1（推荐，Web UI）**：Settings → Models → **Add a custom provider**，填 Provider ID（小写、永久不可改）、base URL、API 协议、API key、至少一个模型。表单里 **Fetch available models** 会用当前填的 baseURL+key 去请求 OpenAI 兼容的 `GET /models` 拉模型清单（不发网络请求就不落库，选中才进草稿）。端点不支持 `GET /models` 就手动录入。改动**下一次请求即生效，不用重启**。

**方式 2（直写 `$DSH_HOME/settings.yaml`）**，一个典型的自建网关：

```yaml
llm-pi-ai:
  providers:
    acme-gateway:                      # 路由 key，自定
      displayName: Acme Gateway
      apiKeyEnv: ACME_GATEWAY_API_KEY  # 凭证引用，密钥不进此文件
      api: openai-completions          # 线协议
      baseURL: https://gateway.acme.example/v1
      models:
        - id: acme-large
          contextWindow: 65536
          maxTokens: 4096
```

注意：`apiKeyEnv` 是**凭证引用**（环境变量名 / credential seam 引用），不是密钥本身；引用解析不到会以 `MISSING_CREDENTIAL` 失败。如果端点是目录内已有的 provider（如 openai），直接以它作 route key，端点/协议/模型目录全部继承，逐字段覆盖即可。

## 三、模型拉取后的思考等级（reasoning efforts）配置

- **目录内模型**：pi-ai 自带的 catalog 已经记录了每个模型支持的思考等级，无需配置。
- **手动声明的模型**：默认**不具备推理能力**（不会展示等级选择器）。需要在模型条目上显式声明 `reasoningEfforts`：

```yaml
        - id: acme-think
          contextWindow: 262144
          maxTokens: 32768
          reasoningEfforts:
            off:            # 空值 = 支持"关"，选择时线上不发参数
            high: high      # key = 选择器展示的等级，value = 线上实际拼写
            max: ultra      # 可改名：网关用 "ultra"，UI 显示 "max"
```

  - key 只能取自 pi-ai 的等级集：`off / minimal / low / medium / high / xhigh / max`；没声明的等级就不提供。
  - `reasoningEfforts: false` 表示显式声明"非推理模型"（用于从目录模型上剥掉推理能力）；省略则保持目录原状。
- **方言问题**：思考参数怎么上线（`reasoning_effort` 还是 DeepSeek 的 `thinking: {type}` 等）由 pi-ai 按 URL 猜。私有网关 URL 猜不出来，用 `compat.thinkingFormat` 纠正，如 `compat: { thinkingFormat: deepseek }`（仅 `openai-completions` 协议有效）。
- **默认值**：路由级 `reasoning: high` 设部署默认；请求级 `GenerateOptions.reasoningEffort` 优先；请求了一个该模型不支持的等级会在发网络请求**之前**以 `UNSUPPORTED_REASONING_EFFORT` 失败，而不是被静默降级。

## 四、上下文窗口 / 输出上限配置

按模型条目逐字段配，解析顺序是 **模型条目 → 安装目录 → 路由默认**：

```yaml
    acme-gateway:
      defaultContextWindow: 262144     # 路由级兜底（模型和目录都没写时）
      defaultMaxTokens: 32768
      models:
        - id: acme-large
          contextWindow: 65536         # 上下文窗口
          maxTokens: 4096              # 单次输出上限（配置值会变成请求默认值）
```

两个要点：

1. `defaultContextWindow`（默认 262144）和 `defaultMaxTokens`（默认 32768）是**路由字段**而非隐藏常量——`GET /models` 只返回 id、不返回容量时，整个路由靠这一对兜底；网关上模型实际更小就在这里改一次。
2. 模型条目里**配置的** `maxTokens` 会成为 seam 的 `defaultMaxTokens`（请求不写就用它）；从目录继承的只是"能力上限"，不会自动变成请求默认值。

另外目录模型可以用 `modelOverrides` 只改一个模型而保留其余几十个；`models` 列表则是**整体替换**目录，写了就必须列全要保留的模型。查询侧：`ctx.llm.resolveModelInfo(provider, model)` 返回上下文窗口、输出上限和可选思考等级，UI 的模型选择器就走它。

中文对应文档是 `docs/user/guide/providers.zh.md` 和 `packages/llm/llm-pi-ai/README.zh.md`。需要的话我可以给你看 `resolveModelInfo` 或 settings 动态合并（改配置免重启）的具体实现。