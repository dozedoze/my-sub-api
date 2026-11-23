// wrangler types 会从 .dev.vars 带入这些名字；这里再声明一次，避免有人没跑 types 时 Env 缺字段。
declare namespace Cloudflare {
  interface Env {
    ADMIN_TOKEN: string;
    DEFAULT_QUOTA_TOKENS: string;
    TAVILY_API_KEY?: string;
    BRAVE_API_KEY?: string;
    /** 32 字节主密钥，base64url 或 64 位十六进制。加密用户的 MCP 密钥。没配置就拒绝保存密钥。 */
    USER_SECRETS_KEY?: string;
  }
}

interface Env {
  USER_SECRETS_KEY?: string;
}
