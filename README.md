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
- 聊天页登录：`POST /chat/api/login` 按 IP 限速，连续失败会锁一段时间；`GET /chat/api/usage` 返回当前账号已用 / 额度 / 百分比
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
| 管理后台 | auto 简单档 / 复杂档 | 简单档一个模型，复杂档按顺序回退。没配则用内置档：简单档 `opencode/qwen3.8-flash`，复杂档 `grok/grok-4.7` → `opencode/grok-4.7` → `opencode/kimi-k3` → `opencode/qwen4-max` |
| 代码 | `src/thinking.ts` 的 `NAME_RULES` | 深度思考能力表，按模型名认（toggle / effort / always / none / unknown）。新模型认不出就加一行。`/v1/models` 每项带 `thinking` 字段，前端据此决定显示不显示开关；`auto` 开启深度思考时直接走复杂档，并把能思考的模型排前面 |
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
| 模型 | `auto`，或上游真实 ID，或 `opencode/<模型>` |

`auto` 用于 `POST /v1/chat/completions` 和 `POST /v1/messages`（含 `/anthropic/v1/skill/messages`），按日常使用来分。寒暄、翻译、润色、摘要、解释，以及一眼能定的简单请求，直接走便宜模型。排错、证明、用户在纠正上一轮，直接走难档。其余把最近几轮原文（不含客户端塞来的 system 人设）交给分档模型，只让它回答 `easy` 或 `hard`，拿不准算 easy。分档不使用对外的 easy 名字，按 `qwen3.8-flash`、同套餐的 `qwen3.7-plus`、再 `deepseek-chat` 的顺序，跳过套餐用满或余额为 0 的账号；都问失败才看本地规则，默认 easy，只有对话里已经是堆栈才算 hard。短跟进（继续、改一下、为什么）沿用上一档；换了一件明确的易事可以降回来。日常回答先用后台配的简单档，没配就用内置的 `opencode/qwen3.8-flash`；它没钱或没有这个模型时按同一条便宜链换。复杂档按后台配的顺序从前往后试，没配就用内置顺序，前面的限流、鉴权失败、没有这个模型、套餐用满或 5xx 才换下一个，并钉住这次成功的那个难模型。分档花掉的 token 记在这把 Key 上。响应头 `x-auto-tier` 是这次的档。锁死到某一个上游的 Key，链上不属于它的模型会被跳过。

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
4. 同一会话钉在同厂商的同一把上游账号上。429 仍会临时换号，下一跳还是先打原来那把。出站标记按厂商写，客户端已经带的不覆盖：
   - OpenCode：`x-opencode-session`
   - xAI：Chat Completions 用 `x-grok-conv-id`，Responses 用 `prompt_cache_key`
   - DeepSeek：`user_id`（他们用这个隔离 KV 缓存）
   - OpenAI：`prompt_cache_key`
   - Anthropic `/v1/messages`：顶层 `cache_control: { type: "ephemeral" }`

同一把 Key 开两个窗口且都不带头时，会共用默认会话。要隔离就让客户端加 `x-session-id`。chat 前端每条补全都会带上当前对话的 `x-session-id`。

## 文件

`POST /anthropic/v1/files` 仍按 DeepSeek Files API 存（Anthropic 形状的 `file_id`）。发到 DeepSeek 时 `file_id` 原样转发。发到 Grok / OpenAI 等 chat 或 responses 上游时，中转会把 `file_id` 拉成 base64，再写成该协议的图片字段（`image_url` / `input_image`）。没有 DeepSeek 上游、或文件拉不下来时返回 400，让客户端改走 base64。chat 前端现在默认把附件内联成 base64，不依赖这条 Files API。

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

## 用户自带 MCP 与 Skill

登录用户可以在聊天页「扩展」里配置自己的 MCP server 和 Skill，按 Key id 存在每个用户自己的 Durable Object（`UserConfig`）里。只在 `/v1/skill/*`、`/anthropic/v1/skill/*` 的 `messages` 和 `chat/completions` 上生效，默认 `/v1` 仍然纯转发。

- **MCP 由网关代连**：支持 Streamable HTTP 和旧版 HTTP+SSE（`transport: auto` 先试前者，POST 不被接受再回退）。协议版本 `2025-11-25` 到 `2024-11-05` 都能协商。工具名统一成 `mcp__{server}__{tool}`，schema 做归一，结果包成「不可信数据」再给模型。stdio 类 server 网关跑不了，导入时会跳过并提示。
- **默认只暴露只读工具**：只有声明了 `readOnlyHint` 的工具才会给模型。用户对某个 server 打开「允许写操作」后才暴露全部。很多 server 不写 annotations，会因此一个工具都不暴露。
- **密钥不明文存**：Authorization 等敏感头和 URL 里的 token 只能写成 `${secret:NAME}`，明文会被拒绝。密钥用 AES-256-GCM 加密，主密钥是 Worker secret `USER_SECRETS_KEY`，密文绑定用户和名字。接口永远不回传密钥值。没配置主密钥时拒绝保存密钥。
- **导入兼容各家 mcp.json**：Cursor、Claude Desktop / Code、VS Code（`servers`、`${input:x}`）、opencode、Anthropic API 的 `mcp_servers`。明文 token 会自动抽成密钥，`${env:X}` 会换成 `${secret:X}`。
- **Skill 只做指令包**：名称、描述常驻 system，正文由模型调用 `load_skill` 按需读取。不执行脚本。
- **管理员开关**：后台「通用 Skill」页可以整体关闭用户 MCP，并设置域名白名单、黑名单。关掉后用户的 Skill 仍然生效。

接口（聊天 cookie 登录，写操作要求 Origin 是聊天页）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/chat/api/config` | 配置、密钥名（不含值）、各 server 状态、限制 |
| PUT | `/chat/api/config` | 整份保存，带 `version`，冲突返回 409 |
| PUT / DELETE | `/chat/api/config/secrets/{NAME}` | 写入或删除密钥，`{"value": "..."}` |
| POST | `/chat/api/config/import` | 导入 mcp.json；`apply: false` 只预览 |
| POST | `/chat/api/config/mcp/{id}/test` | 连接并列出工具，每分钟 10 次 |

上线前要设置主密钥，并且只设一次（换了会让已存的用户密钥全部失效）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put USER_SECRETS_KEY
```

## 安全

- 上游 Key、`ADMIN_TOKEN` 只放在 `wrangler secret` 或本地 `.dev.vars`
- `.gitignore` 已忽略 `.dev.vars`、`.env`、`secrets.json`
- 日志只记签发 Key 的 id / 模型 / 路径，不记明文
- 上游 401/403 会收成统一的 502，避免把上游报错直接甩给使用者
- 管理接口必须带 `Authorization: Bearer <ADMIN_TOKEN>`
- 用户 MCP 的出站请求只允许 https 域名 + 443，拒绝 IP、内网和保留后缀、本站域名；重定向逐跳重新校验，跨源时丢掉用户配置的请求头；响应大小、连接时间、每次请求的调用次数都有上限
