# my-sub-api

跑在 Cloudflare Worker 上的 **AI API Key 中转站**。

你把 Cursor / OpenCode 等**上游密钥**放进 Cloudflare Secrets。这个 Worker 再签发若干 `sk-` 代理 Key 给别人。对方用 WorkBuddy、OpenCode、Cursor（自定义 Base URL）等 C 端，只拿得到代理 Key，拿不到上游密钥。

```
WorkBuddy / OpenCode / Cursor
        │  sk-（你签发的）
        ▼
   Cloudflare Worker  ←  ADMIN_TOKEN、上游 Key 都在 Secrets
        │  换成上游 Key
        ▼
   OpenCode Zen / 其它 OpenAI 兼容上游
```

## 它做什么

- OpenAI 兼容：`POST /v1/chat/completions`（含流式）、`GET /v1/models`，以及透传 `/v1/responses`、`/v1/messages`、`/v1/embeddings`
- 管理后台 `/admin`：用 `ADMIN_TOKEN` 登录，签发 / 吊销 / 删除使用者 Key，看每人用量和额度
- 使用者 Key 只在创建时显示一次；KV 里存 SHA-256，明文不落盘
- 模型可写成 `opencode/glm-5.2` 或 `cursor/composer-2.5` 来选上游；Key 也可锁死到某一个上游

## 它不做什么

Cursor **没有**公开的 Chat Completions 接口。官方 `crsr_` Key 走的是 Cloud Agents / 管理 API，不是 `POST /v1/chat/completions`。本项目**不会**去对接 Cursor 内部推理接口。把 Cursor 当**客户端**连本站可以：覆盖 OpenAI Base URL 指向本 Worker。上游若要用 OpenAI 兼容的 Cursor 中转，写进 `PROVIDERS` 即可。

## 本地

```bash
npm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars：ADMIN_TOKEN，以及 PROVIDERS 里每个 id 的 {ID}_API_KEY
npx wrangler types
npm run check
npm run dev
```

打开 http://localhost:8787/admin

`.dev.vars` 已被 gitignore。不要提交。

## 部署到 Cloudflare

```bash
npx wrangler login
npx wrangler deploy
```

`wrangler.jsonc` 里 KV 没写 id，首次 deploy 会自动建命名空间。

密钥用交互式写入（不要把值写在命令行、不要 echo、不要写进 wrangler.jsonc）：

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GROK_API_KEY
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put OPENCODE_API_KEY
```

改完非密钥配置后再 `npx wrangler deploy`。

## 配置

| 位置 | 名字 | 说明 |
| --- | --- | --- |
| Secret | `ADMIN_TOKEN` | 管理后台口令 |
| Secret | `{ID}_API_KEY` | `PROVIDERS` 里每个 `id` 对应一把 Key |
| var | `PROVIDERS` | JSON 数组，上游账号列表。没写模型前缀时走第一个配了密钥的。每项可加 `quota` 声明余额查询 |
| var | `MODEL_ALIASES` | JSON 对象，例如 `{"gpt-4":"opencode/gpt-5.4"}` |
| var | `DEFAULT_QUOTA_TOKENS` | 签发 Key 的默认 token 额度，默认 `1000000`；`0` 表示不限额 |

加一个 OpenAI 官方上游示例：

`wrangler.jsonc` 的 `PROVIDERS`：

```json
[{"id":"openai","baseUrl":"https://api.openai.com/v1"}]
```

然后 `npx wrangler secret put OPENAI_API_KEY`。

## 给别人用

1. 打开 `https://<你的 worker>/admin`，用 `ADMIN_TOKEN` 登录
2. 填备注（可改额度，默认 100 万 token），签发 Key，**立刻复制**（只显示一次）
3. 把下面三项发给对方

| 项 | 值 |
| --- | --- |
| Base URL | `https://<你的 worker>/v1` |
| API Key | `sk-...` |
| 模型 | 上游真实 ID，或 `opencode/<模型>` |

### WorkBuddy

设置 → 模型 → 自定义 / Custom：

- 协议：OpenAI Chat Completions
- 地址：`https://<worker>/v1`（不要自己再拼一层密钥）
- API Key：签发的 `sk-`
- 模型名：例如 `glm-5.2` 或 `opencode/glm-5.2`
- Custom Protocol：关

### OpenCode

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "mysub": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://<worker>/v1",
        "apiKey": "{env:MY_SUB_API_KEY}"
      },
      "models": {
        "glm-5.2": {}
      }
    }
  }
}
```

### Cursor（当客户端）

Settings → Models → 打开 Override OpenAI Base URL → 填 `https://<worker>/v1` 和签发 Key。只影响本地 Chat / Agent，不影响 Tab。

## 多轮对话 / 会话缓存

默认 **不丢上下文**：

1. WorkBuddy / OpenCode / Cursor 同一窗口通常每次把完整 `messages` 送来。中转只改 `model`，历史原样转给上游。
2. 若某个 C 端只发最新一句，Worker 会按会话把前面的轮次补回去。会话 ID 优先级：
   - 请求头 `x-session-id` / `x-conversation-id` / `x-opencode-session`
   - JSON 里的 `session_id` / `conversation_id`
   - 都没有则用这把签发 Key 自己的默认会话（`key:<id>`）
3. 响应会带回 `x-session-id`。同一窗口下次带上这个头，就不会和别的窗口串台。
4. 同时会把 `x-opencode-session` 传给上游，方便 OpenCode 做前缀缓存。

同一把 Key 开两个窗口且都不带头时，会共用默认会话。要隔离就让客户端加 `x-session-id`。

## 额度与用量

签发 Key 时可以设 token 上限，不填就用 `DEFAULT_QUOTA_TOKENS`（默认 100 万）。后台列表能看到每人已用 / 额度 / 剩余，超了会返回 `429 insufficient_quota`。

计数来源：上游响应里的 `usage.total_tokens`（流式会补 `stream_options.include_usage`）。上游不回头条时，按请求体大约 4 字符 = 1 token 估。

**上游还剩多少：** 在对应 provider 上加 `quota`。后台打开时用这个请求去查，认出余额就显示在「余额」列。没配 `quota` 的上游只显示本站自己累计的消耗。

```jsonc
{
  "id": "deepseek",
  "baseUrl": "https://api.deepseek.com/v1",
  "quota": { "url": "https://api.deepseek.com/user/balance" }
}
```

`url` 可以写完整地址，或以 `/` 开头（拼到 `baseUrl` 的源站，不含 `/v1`）。不写 `secret` 就用这把上游的 `{ID}_API_KEY`。要另一把钥匙（例如 xAI management key）时，`secret` 填环境变量名，值用 `wrangler secret put`，不要写进 jsonc。路径里的账号 id 用 `${ENV_NAME}`，同样从环境变量读。`cents: true` 表示响应里的 `total.val` 是美分。`method: "POST"` 时可带 `body`。

能认出的响应：DeepSeek `balance_infos`、xAI `total.val`（美分）、OpenCode Go 的套餐窗口百分比，以及常见的 `balance` / `credit` / `usd` 数字。OpenCode 只接 `https://opencode.ai/zen/go/v1`（订阅）。`https://opencode.ai/zen/v1` 是按量另扣，配了也不会转发。Grok 用 `https://api.x.ai/v1`，`https://us.api.x.ai/v1` 贵 10%，同样停用。套餐窗口用满后，付费模型会被拒绝，避免落到 Extra Usage。

上下文存在 Durable Object 里（强一致）。超过约 80 条或体积过大时会丢掉最旧的非 system 轮。

## 安全

- 上游 Key、`ADMIN_TOKEN` 只放在 `wrangler secret` 或本地 `.dev.vars`
- `.gitignore` 已忽略 `.dev.vars`、`.env`、`secrets.json`
- 日志只记签发 Key 的 id / 模型 / 路径，不记明文
- 上游 401/403 会收成统一的 502，避免把上游报错直接甩给使用者
- 管理接口必须带 `Authorization: Bearer <ADMIN_TOKEN>`
