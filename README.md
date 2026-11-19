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

Cursor **没有**公开的 Chat Completions 接口。官方 `crsr_` Key 走的是 Cloud Agents / 管理 API，不是 `POST /v1/chat/completions`。本项目**不会**去对接 Cursor 内部推理接口。

`CURSOR_API_KEY` 只用于你已经有的、**OpenAI 兼容**的 Cursor 中转地址（填 `CURSOR_BASE_URL`）。没有就把这两项留空，只用 OpenCode。

把 Cursor 当**客户端**连本站是可以的：覆盖 OpenAI Base URL 指向本 Worker。

## 本地

```bash
npm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars：ADMIN_TOKEN、OPENCODE_API_KEY、可选 CURSOR_API_KEY
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
npx wrangler secret put OPENCODE_API_KEY
npx wrangler secret put CURSOR_API_KEY   # 没有就跳过
```

改完非密钥配置后再 `npx wrangler deploy`。

## 配置

| 位置 | 名字 | 说明 |
| --- | --- | --- |
| Secret | `ADMIN_TOKEN` | 管理后台口令 |
| Secret | `OPENCODE_API_KEY` | OpenCode Zen / Console Key |
| Secret | `CURSOR_API_KEY` | OpenAI 兼容的 Cursor 上游 Key |
| Secret | `{ID}_API_KEY` | `EXTRA_PROVIDERS` 里每个 `id` 对应一把 Key |
| var | `OPENCODE_BASE_URL` | 默认 `https://opencode.ai/zen/v1` |
| var | `CURSOR_BASE_URL` | 你的 Cursor 兼容网关，没有就留空 |
| var | `DEFAULT_PROVIDER` | 没写模型前缀时走谁，默认 `opencode` |
| var | `EXTRA_PROVIDERS` | JSON 数组，加更多上游 |
| var | `MODEL_ALIASES` | JSON 对象，例如 `{"gpt-4":"opencode/gpt-5.4"}` |
| var | `DEFAULT_QUOTA_TOKENS` | 签发 Key 的默认 token 额度，默认 `1000000`；`0` 表示不限额 |

加一个 OpenAI 官方上游示例：

`wrangler.jsonc` 的 `EXTRA_PROVIDERS`：

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

**你自己配的上游 Key 还剩多少：** 大多数厂商（包括 OpenCode Zen 预付钱包）不让 API Key 查余额，只能打开对方网页控制台看。本站能做的是：

- 把经本站打出去的 token 按上游汇总，后台「本站已消耗」就是这个数
- 若这把 Key 其实是 OpenCode Go 订阅，会额外试 `GET /zen/go/v1/usage`，能返回就显示套餐窗口剩余百分比

这不是对方账户的实时钱包，只覆盖走过这个 Worker 的流量。

上下文存在 Durable Object 里（强一致）。超过约 80 条或体积过大时会丢掉最旧的非 system 轮。

## 安全

- 上游 Key、`ADMIN_TOKEN` 只放在 `wrangler secret` 或本地 `.dev.vars`
- `.gitignore` 已忽略 `.dev.vars`、`.env`、`secrets.json`
- 日志只记签发 Key 的 id / 模型 / 路径，不记明文
- 上游 401/403 会收成统一的 502，避免把上游报错直接甩给使用者
- 管理接口必须带 `Authorization: Bearer <ADMIN_TOKEN>`
