// wrangler types 会从 .dev.vars 带入这些名字；这里再声明一次，避免有人没跑 types 时 Env 缺字段。
declare namespace Cloudflare {
  interface Env {
    ADMIN_TOKEN: string;
    DEFAULT_QUOTA_TOKENS: string;
  }
}
