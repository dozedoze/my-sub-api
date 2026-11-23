export class GatewayError extends Error {
  status: number;
  code: string;
  retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** 上游余额查询。secret 和 ${NAME} 都是环境变量名，值放 wrangler secret 或 .dev.vars。 */
export type QuotaQuery = {
  url: string;
  secret?: string;
  method?: "POST";
  body?: unknown;
  /** total.val 按美分换算。xAI prepaid balance 需要。 */
  cents?: boolean;
};

export type Provider = {
  id: string;
  baseUrl: string;
  apiKey: string;
  /** Claude /v1/messages 转发到这家上游时用的协议。不写则按地址猜测。 */
  messages?: "chat" | "responses" | "anthropic";
  /** Responses 上游是否托管 web_search。不写则只认 xAI / OpenAI。 */
  hostedSearch?: boolean;
  quota?: QuotaQuery;
  /** 空字符串表示 quota.secret 在环境里没有值。 */
  quotaKey?: string;
  quotaError?: string;
};

export type ProviderPublic = {
  id: string;
  baseUrl: string;
  configured: boolean;
  /** 配了额外付费地址时写原因，这种上游不会进入转发。 */
  note?: string;
};

export type ProviderConfig = {
  id: string;
  baseUrl: string;
  messages?: "chat" | "responses" | "anthropic";
  hostedSearch?: boolean;
  quota?: QuotaQuery;
};

export type KeyRecord = {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  enabled: boolean;
  createdAt: number;
  provider?: string;
  /** 0 = 不限额。缺省字段按 DEFAULT_QUOTA_TOKENS 处理。 */
  quotaTokens?: number;
  username?: string;
  passwordSalt?: string;
  passwordHash?: string;
};

export type KeyPublic = {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  createdAt: number;
  provider?: string;
  quotaTokens?: number;
  username?: string;
};

export type RecentCall = {
  at: number;
  model: string;
  provider: string;
  tokens: number;
};

export type Meter = {
  used: number;
  requests: number;
  /** 下游这次转发的模型和 token，最新在前，最多 10 条。内部分档计费不写这里。 */
  recent?: RecentCall[];
  /** 当前分钟窗口起点。限流字段，后台用量不展示。 */
  rpmAt?: number;
  rpm?: number;
  inflight?: number;
  gateAt?: number;
  /** 登录失败次数；只写在 login: IP 计量上。 */
  fails?: number;
  /** 登录锁定到期时间。 */
  lockedUntil?: number;
};

/** 给自己几个人用：挡住脚本刷，不挡 Cursor / Claude Code 多窗口连打。 */
export const GATE = {
  windowMs: 60_000,
  staleMs: 10 * 60_000,
  keyRpm: 480,
  keyInflight: 32,
  anonRpm: 60,
  /** 聊天页登录：每 IP 每分钟最多试几次。 */
  loginRpm: 8,
  /** 连续失败几次后锁 15 分钟。 */
  loginFails: 5,
  loginLockMs: 15 * 60_000,
  /** 只拦没登录成功的撞库，登录后不限。 */
  adminRpm: 40,
  /** 带用户 MCP 的聊天请求，每个用户每分钟最多几次（每次可能触发出站连接）。 */
  mcpRpm: 60,
  /** 「测试连接」会让网关向用户填的地址发请求，要卡得更紧。 */
  mcpTestRpm: 10,
  /** 用户配置的读写。 */
  configRpm: 60,
  maxBodyBytes: 8_000_000,
  maxFileBytes: 32_000_000,
  maxTokens: 131_072,
  maxN: 4,
  imageTokenFloor: 8_000,
} as const;

export type AdmitFail = { ok: false; status: number; code: string; message: string; retryAfter?: number };
export type AdmitHit = { ok: true; next: Meter } | AdmitFail;

export function applyAdmit(
  cur: Meter,
  now: number,
  opts: { quota: number; maxRpm: number; maxInflight: number; takeInflight: boolean },
): AdmitHit {
  let inflight = cur.inflight ?? 0;
  if (inflight > 0 && now - (cur.gateAt ?? 0) > GATE.staleMs) inflight = 0;
  let rpmAt = cur.rpmAt ?? now;
  let rpm = cur.rpm ?? 0;
  if (now - rpmAt >= GATE.windowMs) {
    rpmAt = now;
    rpm = 0;
  }
  if (opts.quota > 0 && cur.used >= opts.quota) {
    return {
      ok: false,
      status: 429,
      code: "insufficient_quota",
      message: `Token quota exceeded (${cur.used}/${opts.quota})`,
    };
  }
  if (rpm >= opts.maxRpm) {
    const retryAfter = Math.max(1, Math.ceil((GATE.windowMs - (now - rpmAt)) / 1000));
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      message: `Too many requests (${opts.maxRpm}/min)`,
      retryAfter,
    };
  }
  if (opts.takeInflight && inflight >= opts.maxInflight) {
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      message: `Too many concurrent requests (${opts.maxInflight})`,
    };
  }
  return {
    ok: true,
    next: {
      ...cur,
      rpmAt,
      rpm: rpm + 1,
      inflight: opts.takeInflight ? inflight + 1 : inflight,
      gateAt: now,
    },
  };
}

export function applyRelease(cur: Meter, now: number): Meter {
  let inflight = cur.inflight ?? 0;
  if (inflight > 0 && now - (cur.gateAt ?? 0) > GATE.staleMs) inflight = 0;
  return { ...cur, inflight: Math.max(0, inflight - 1), gateAt: now };
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "local";
}

export function clampGeneration(payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const p = payload as Record<string, unknown>;
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const n = p[key];
    if (typeof n === "number" && Number.isFinite(n) && n > GATE.maxTokens) p[key] = GATE.maxTokens;
  }
  if (typeof p.n === "number" && Number.isFinite(p.n) && p.n > GATE.maxN) p.n = GATE.maxN;
}

export function chargeEstimate(rest: string, payload: unknown): number {
  const n = estimateTokens(payload);
  return rest.startsWith("images/") ? Math.max(n, GATE.imageTokenFloor) : n;
}

export function throwIfAdmitFailed(hit: { ok: true } | AdmitFail): asserts hit is { ok: true } {
  if (!hit.ok) throw new GatewayError(hit.status, hit.code, hit.message, hit.retryAfter);
}

export function loginRetryAfter(cur: Meter, now: number): number | null {
  if (cur.lockedUntil && cur.lockedUntil > now) {
    return Math.max(1, Math.ceil((cur.lockedUntil - now) / 1000));
  }
  return null;
}

export function applyLoginFail(cur: Meter, now: number): Meter {
  const unlocked = !cur.lockedUntil || cur.lockedUntil <= now;
  const prev = unlocked && cur.lockedUntil ? 0 : (cur.fails ?? 0);
  const fails = prev + 1;
  return {
    ...cur,
    fails,
    lockedUntil: fails >= GATE.loginFails ? now + GATE.loginLockMs : undefined,
  };
}

export function applyLoginOk(cur: Meter): Meter {
  return { ...cur, fails: 0, lockedUntil: undefined };
}

export const RECENT_CALL_LIMIT = 10;

export function pushRecent(prev: RecentCall[] | undefined, call: RecentCall): RecentCall[] {
  return [call, ...(prev ?? [])].slice(0, RECENT_CALL_LIMIT);
}

export function readRecent(raw: unknown): RecentCall[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const tokens = nonNegInt(rec.tokens);
    const at = nonNegInt(rec.at);
    if (tokens == null || at == null) continue;
    out.push({
      at,
      model: typeof rec.model === "string" ? rec.model : "",
      provider: typeof rec.provider === "string" ? rec.provider : "",
      tokens,
    });
    if (out.length >= RECENT_CALL_LIMIT) break;
  }
  return out;
}

export type KeyView = KeyPublic & {
  quotaTokens: number;
  usedTokens: number;
  requestCount: number;
  remainingTokens: number | null;
  recent: RecentCall[];
};

export const FALLBACK_QUOTA_TOKENS = 1_000_000;

const PROXY_PATHS = new Set([
  "chat/completions",
  "completions",
  "responses",
  "messages",
  "messages/count_tokens",
  "models",
  "embeddings",
  "images/generations",
  "images/edits",
]);

const SKILL_RESTS = new Set(["messages", "chat/completions", "responses"]);

export type ProxyRoute = { rest: string; skills: boolean };

function dropAnthropicPrefix(pathname: string): string {
  if (pathname === "/anthropic") return "/";
  if (pathname.startsWith("/anthropic/")) return pathname.slice("/anthropic".length) || "/";
  return pathname;
}

export function proxyRoute(pathname: string): ProxyRoute | null {
  let path = dropAnthropicPrefix(pathname.replace(/\/+$/, "") || "/");
  if (path === "/models" || path.startsWith("/models/")) return { rest: path.slice(1), skills: false };
  const stripped = stripV1(path).replace(/^\//, "");
  if (stripped.startsWith("skill/")) {
    const rest = stripped.slice("skill/".length);
    if (SKILL_RESTS.has(rest)) return { rest, skills: true };
    return null;
  }
  if (PROXY_PATHS.has(stripped)) return { rest: stripped, skills: false };
  if (stripped.startsWith("models/") && stripped.length > "models/".length) return { rest: stripped, skills: false };
  if (stripped === "files" || stripped.startsWith("files/")) return { rest: stripped, skills: false };
  if (stripped === "tools/asr" || stripped === "tools/tts") return { rest: stripped, skills: false };
  return null;
}

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  return `${b}/${p}`;
}

export function stripV1(pathname: string): string {
  return pathname.replace(/\/+$/, "").replace(/^(\/v1)+(?=\/|$)/, "") || "/";
}

export function upstreamRestPath(pathname: string): string | null {
  return proxyRoute(pathname)?.rest ?? null;
}

/** wrangler vars 可以是 JSON 绑定，也可以是旧的 JSON 字符串。 */
function decodeJsonVar(raw: unknown): unknown {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    const s = raw.trim();
    return s ? JSON.parse(s) : undefined;
  }
  return raw;
}

export function parseJsonObject(raw: unknown): Record<string, string> {
  const value = decodeJsonVar(raw);
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(500, "config_error", "MODEL_ALIASES must be a JSON object");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** 限流、鉴权、没有这个模型、5xx 可以换下一个模型。400 是请求本身的问题。 */
export function modelFallback(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
}

export function parseProviders(raw: unknown): ProviderConfig[] {
  const value = decodeJsonVar(raw);
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new GatewayError(500, "config_error", "PROVIDERS must be a JSON array");
  }
  const out: ProviderConfig[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || typeof rec.baseUrl !== "string") continue;
    const id = rec.id.trim();
    const baseUrl = rec.baseUrl.trim();
    if (!id || !baseUrl) continue;
    const quota = parseQuota(rec.quota);
    const messages = rec.messages === "chat" || rec.messages === "responses" || rec.messages === "anthropic" ? rec.messages : undefined;
    const hostedSearch = rec.hostedSearch === true ? true : rec.hostedSearch === false ? false : undefined;
    out.push({
      id,
      baseUrl,
      ...(quota ? { quota } : {}),
      ...(messages ? { messages } : {}),
      ...(hostedSearch !== undefined ? { hostedSearch } : {}),
    });
  }
  return out;
}

function parseQuota(raw: unknown): QuotaQuery | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.url !== "string" || !rec.url.trim()) return undefined;
  const quota: QuotaQuery = { url: rec.url.trim() };
  if (typeof rec.secret === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(rec.secret.trim())) {
    quota.secret = rec.secret.trim();
  }
  if (typeof rec.method === "string" && rec.method.trim().toUpperCase() === "POST") {
    quota.method = "POST";
    if (rec.body !== undefined) quota.body = rec.body;
  }
  if (rec.cents === true) quota.cents = true;
  return quota;
}

export function secretName(providerId: string): string {
  return `${providerId.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

export function providerSecret(env: object, id: string): string | undefined {
  const value = Reflect.get(env, secretName(id));
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function providerConfigs(env: { PROVIDERS?: unknown }): ProviderConfig[] {
  return parseProviders(env.PROVIDERS).map((p) => ({
    ...p,
    baseUrl: p.baseUrl.replace(/\/+$/, ""),
  }));
}

/** 比套餐价 / 全球价多扣钱的地址。返回 null 表示可以走。 */
export function extraPaidChannel(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (host === "us.api.x.ai") return "美国区域端点比全球价贵 10%，已停用";
  if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
    if (path.startsWith("/zen/go") || path.startsWith("/inference/go")) return null;
    if (path.startsWith("/zen") || path.startsWith("/inference")) {
      return "这是按量付费地址，已停用。订阅用 https://opencode.ai/zen/go/v1";
    }
  }
  return null;
}

export function isGoSubscription(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "opencode.ai" && !host.endsWith(".opencode.ai")) return false;
  const path = url.pathname.replace(/\/+$/, "");
  return path.startsWith("/zen/go") || path.startsWith("/inference/go");
}

const OPENCODE_MODEL_KEEP = [
  /^grok-4\.6(?:$|[-_])/,
  /^grok-4\.7(?:$|[-_])/,
  /^qwen3\.7(?:$|[-_.])/,
  /^qwen-3\.7(?:$|[-_.])/,
  /^qwen3\.8-flash(?:$|[-_])/,
  /^qwen-3\.8-flash(?:$|[-_])/,
  /^qwen4-max(?:$|[-_])/,
  /^qwen-4-max(?:$|[-_])/,
  /^kimi-k3(?:$|[-_])/,
  /^k3(?:$|[-_])/,
];

function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** OpenCode 只放行 grok 4.6/4.7、千问 3.7、千问 3.8 flash、qwen4-max、kimi-k3。xAI 只放行 4.6/4.7。 */
export function modelAllowed(provider: { id: string; baseUrl: string }, model: string): boolean {
  const host = providerHost(provider.baseUrl);
  const opencode = host === "opencode.ai" || host.endsWith(".opencode.ai");
  const xai = provider.id === "grok" || host === "x.ai" || host.endsWith(".x.ai");
  if (!opencode && !xai) return true;
  const id = model.trim().toLowerCase();
  if (!id) return true;
  const tail = id.slice(id.lastIndexOf("/") + 1);
  if (opencode) return OPENCODE_MODEL_KEEP.some((re) => re.test(tail));
  return /(?:^|[^0-9])4\.6(?:[^0-9]|$)/.test(tail) || /(?:^|[^0-9])4\.7(?:[^0-9]|$)/.test(tail);
}

/** Go 套餐窗口已满时，付费模型再打就会落到 Extra Usage。免费模型不占额度。 */
export function goAllowanceBlocks(json: unknown, model: string): boolean {
  if (/(^|[-_/])free($|[-_/])/i.test(model)) return false;
  const parsed = parseOpencodeGoUsage(json);
  return Boolean(parsed?.windows?.some((w) => w.percent >= 100 || w.status === "rate-limited"));
}

/** 预付余额用尽。认不出的响应不当成没钱，交给真正的请求去试。 */
export function quotaBlocks(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const rec = json as Record<string, unknown>;
  if (rec.is_available === false) return true;
  if (Array.isArray(rec.balance_infos)) {
    const totals: number[] = [];
    for (const item of rec.balance_infos) {
      if (!item || typeof item !== "object") continue;
      const n = asNumberish((item as Record<string, unknown>).total_balance);
      if (n != null) totals.push(n);
    }
    if (totals.length > 0 && totals.every((n) => n <= 0)) return true;
  }
  const total = rec.total;
  if (total && typeof total === "object" && !Array.isArray(total)) {
    const n = asNumberish((total as Record<string, unknown>).val);
    if (n != null && n <= 0) return true;
  }
  return false;
}

export function loadProviders(env: object & { PROVIDERS?: unknown }): {
  live: Provider[];
  publicList: ProviderPublic[];
} {
  const live: Provider[] = [];
  const publicList: ProviderPublic[] = [];
  for (const cfg of providerConfigs(env)) {
    const apiKey = providerSecret(env, cfg.id);
    const surcharge = extraPaidChannel(cfg.baseUrl);
    publicList.push({
      id: cfg.id,
      baseUrl: cfg.baseUrl,
      configured: Boolean(apiKey) && !surcharge,
      ...(surcharge ? { note: surcharge } : {}),
    });
    if (apiKey && !surcharge) live.push({ ...cfg, apiKey, ...bindQuota(env, cfg.quota, apiKey) });
  }
  return { live, publicList };
}

function bindQuota(
  env: object,
  quota: QuotaQuery | undefined,
  apiKey: string,
): Pick<Provider, "quota" | "quotaKey" | "quotaError"> {
  if (!quota) return {};
  const quotaKey = quota.secret ? readEnvString(env, quota.secret) ?? "" : apiKey;
  const filled = expandQuotaUrl(quota.url, env);
  if ("error" in filled) return { quota, quotaKey, quotaError: filled.error };
  return { quota: { ...quota, url: filled.url }, quotaKey };
}

function readEnvString(env: object, name: string): string | undefined {
  const value = Reflect.get(env, name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** url 里的 ${NAME} 从 env 取值。只接受路径安全的字符，避免把密钥拼进 URL。 */
function expandQuotaUrl(url: string, env: object): { url: string } | { error: string } {
  const missing: string[] = [];
  const invalid: string[] = [];
  const filled = url.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = readEnvString(env, name);
    if (!value) {
      missing.push(name);
      return "";
    }
    if (!/^[A-Za-z0-9._~-]+$/.test(value)) {
      invalid.push(name);
      return "";
    }
    return value;
  });
  if (missing.length) return { error: `额度地址缺少 ${missing.join(", ")}` };
  if (invalid.length) return { error: `额度地址参数无效：${invalid.join(", ")}` };
  return { url: filled };
}

export function resolveQuotaUrl(baseUrl: string, raw: string): string | null {
  try {
    const url = raw.startsWith("/") ? new URL(raw, new URL(baseUrl).origin) : new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function extractToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }
  const alt = request.headers.get("x-api-key") || request.headers.get("api-key");
  return alt?.trim() || null;
}

export const ADMIN_SESSION_COOKIE = "admin_session";
export const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CHAT_SESSION_COOKIE = "chat_session";
export const CHAT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PBKDF2_ITERATIONS = 100_000;

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function mintAdminSession(secret: string, now = Date.now()): Promise<string> {
  const exp = Math.floor((now + ADMIN_SESSION_TTL_MS) / 1000);
  const sig = await hmacHex(secret, `admin-session:v1:${exp}`);
  return `${exp}.${sig}`;
}

export async function verifyAdminSession(secret: string, value: string, now = Date.now()): Promise<boolean> {
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const expStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^[0-9]{1,12}$/.test(expStr) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const exp = Number(expStr);
  const nowSec = Math.floor(now / 1000);
  if (exp <= nowSec) return false;
  if (exp > nowSec + ADMIN_SESSION_TTL_MS / 1000 + 60) return false;
  const expect = await hmacHex(secret, `admin-session:v1:${exp}`);
  return timingSafeEqualString(sig, expect);
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    return part.slice(i + 1).trim() || null;
  }
  return null;
}

export function adminSessionSetCookie(value: string, requestUrl: string, maxAgeSec = ADMIN_SESSION_TTL_MS / 1000): string {
  const secure = new URL(requestUrl).protocol === "https:";
  return [
    `${ADMIN_SESSION_COOKIE}=${value}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeSec)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function adminSessionClearCookie(requestUrl: string): string {
  return adminSessionSetCookie("deleted", requestUrl, 0);
}

function chatCookieDomain(requestUrl: string): string | undefined {
  const host = new URL(requestUrl).hostname.toLowerCase();
  if (host === "aofahub.dev" || host.endsWith(".aofahub.dev")) return ".aofahub.dev";
  return undefined;
}

export async function mintChatSession(secret: string, keyId: string, now = Date.now()): Promise<string> {
  const exp = Math.floor((now + CHAT_SESSION_TTL_MS) / 1000);
  const sig = await hmacHex(secret, `chat-session:v1:${keyId}:${exp}`);
  return `${keyId}.${exp}.${sig}`;
}

export async function verifyChatSession(secret: string, value: string, now = Date.now()): Promise<string | null> {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [keyId, expStr, sig] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(keyId) || !/^[0-9]{1,12}$/.test(expStr) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const exp = Number(expStr);
  const nowSec = Math.floor(now / 1000);
  if (exp <= nowSec) return null;
  if (exp > nowSec + CHAT_SESSION_TTL_MS / 1000 + 60) return null;
  const expect = await hmacHex(secret, `chat-session:v1:${keyId}:${exp}`);
  if (!(await timingSafeEqualString(sig, expect))) return null;
  return keyId;
}

export function chatSessionSetCookie(value: string, requestUrl: string, maxAgeSec = CHAT_SESSION_TTL_MS / 1000): string {
  const secure = new URL(requestUrl).protocol === "https:";
  const domain = chatCookieDomain(requestUrl);
  return [
    `${CHAT_SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeSec)}`,
    ...(domain ? [`Domain=${domain}`] : []),
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function chatSessionClearCookie(requestUrl: string): string {
  return chatSessionSetCookie("deleted", requestUrl, 0);
}

export function isChatOrigin(origin: string): boolean {
  if (origin === "https://chat.aofahub.dev") return true;
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function parseUsername(raw: unknown): string | undefined {
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string") throw new GatewayError(400, "invalid_request", "username must be a string");
  const u = raw.trim().toLowerCase();
  if (!u) return undefined;
  if (!/^[a-z0-9._-]{2,32}$/.test(u)) {
    throw new GatewayError(400, "invalid_request", "username must be 2-32 letters, digits, dot, underscore or hyphen");
  }
  return u;
}

export async function hashPassword(password: string, saltHex?: string): Promise<{ salt: string; hash: string }> {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { salt: bytesToHex(salt), hash: bytesToHex(new Uint8Array(bits)) };
}

export async function verifyPassword(password: string, salt: string, hash: string): Promise<boolean> {
  if (!/^[0-9a-f]+$/i.test(salt) || !/^[0-9a-f]+$/i.test(hash) || salt.length % 2 || hash.length % 2) return false;
  const got = await hashPassword(password, salt);
  return timingSafeEqualString(got.hash, hash);
}

/** GET 后台页。`/admin/api` 是接口，不走这里。 */
export function isAdminShellPath(path: string): boolean {
  return path === "/admin" || (path.startsWith("/admin/") && !path.startsWith("/admin/api"));
}

export async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const raw = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `sk-${raw}`;
}

export function keyPrefix(plaintext: string): string {
  return plaintext.slice(0, 11);
}

export function toPublicKey(record: KeyRecord): KeyPublic {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    enabled: record.enabled,
    createdAt: record.createdAt,
    provider: record.provider,
    quotaTokens: record.quotaTokens,
    ...(record.username ? { username: record.username } : {}),
  };
}

export function defaultQuotaTokens(raw: string | undefined): number {
  if (!raw?.trim()) return FALLBACK_QUOTA_TOKENS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return FALLBACK_QUOTA_TOKENS;
  return Math.floor(n);
}

export function parseQuotaInput(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new GatewayError(400, "invalid_request", "quotaTokens must be >= 0 (0 = unlimited)");
  }
  return Math.floor(n);
}

export function effectiveQuota(record: { quotaTokens?: number }, fallback: number): number {
  return typeof record.quotaTokens === "number" ? record.quotaTokens : fallback;
}

export function attachUsage(
  keys: KeyPublic[],
  meters: Record<string, Meter>,
  fallbackQuota: number,
): KeyView[] {
  return keys.map((k) => {
    const quotaTokens = effectiveQuota(k, fallbackQuota);
    const usedTokens = meters[k.id]?.used ?? 0;
    const requestCount = meters[k.id]?.requests ?? 0;
    return {
      ...k,
      quotaTokens,
      usedTokens,
      requestCount,
      remainingTokens: quotaTokens === 0 ? null : Math.max(0, quotaTokens - usedTokens),
      recent: readRecent(meters[k.id]?.recent),
    };
  });
}

function nonNegInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function tokensFromUsage(json: unknown): number | null {
  if (!json || typeof json !== "object") return null;
  const rec = json as Record<string, unknown>;
  const usage = rec.usage && typeof rec.usage === "object" ? (rec.usage as Record<string, unknown>) : rec;
  const total = nonNegInt(usage.total_tokens);
  if (total != null) return total;
  const prompt = nonNegInt(usage.prompt_tokens) ?? nonNegInt(usage.input_tokens) ?? 0;
  const completion = nonNegInt(usage.completion_tokens) ?? nonNegInt(usage.output_tokens) ?? 0;
  const n = prompt + completion;
  return n > 0 ? n : null;
}

export function estimateTokens(payload: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(payload ?? "").length / 4));
}

export function bodyTooLarge(request: Request, payload: unknown, max: number = GATE.maxBodyBytes): boolean {
  const len = Number(request.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) return true;
  if (payload === undefined) return false;
  try {
    return JSON.stringify(payload ?? "").length > max;
  } catch {
    return true;
  }
}

export type UpstreamWindow = {
  name: string;
  percent: number;
  remainingPercent: number;
  resetsAt?: string;
  /** 上游原样状态，例如 ok、rate-limited。 */
  status?: string;
};

export type UpstreamProbe = {
  ok: boolean;
  source?: string;
  note: string;
  /** 后台直接展示的余额文案。 */
  label?: string;
  /** 悬浮层逐行展示。表格单元格仍只用 label。 */
  detail?: string[];
  windows?: UpstreamWindow[];
  balanceUsd?: number;
  /** xAI 账单里的 token 合计，含没经过本站的调用。 */
  usedTokens?: number;
  usageIncomplete?: boolean;
};

/** 预付余额地址换成同团队的用量统计。其它上游没有这个接口。 */
export function xaiUsageUrl(balanceUrl: string): string | null {
  try {
    const url = new URL(balanceUrl);
    if (url.hostname !== "management-api.x.ai") return null;
    if (!url.pathname.endsWith("/prepaid/balance")) return null;
    url.pathname = url.pathname.replace(/\/prepaid\/balance$/, "/usage");
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

function gmtDay(d: Date): string {
  return d.toISOString().slice(0, 10) + " 00:00:00";
}

/** 从 2024-01-01 到明天 0 点，整段合成一个桶。ponytail: 起点写死，要改窗口再加配置。 */
export function xaiUsageBody(now = new Date(), timeUnit = "TIME_UNIT_NONE"): Record<string, unknown> {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return {
    analyticsRequest: {
      timeRange: {
        startTime: "2024-01-01 00:00:00",
        endTime: gmtDay(end),
        timezone: "Etc/GMT",
      },
      timeUnit,
      values: [{ name: "units", aggregation: "AGGREGATION_SUM" }],
      groupBy: ["unit_type"],
      filters: [],
    },
  };
}

/** 把用量时间序列里的 token 单位加总。有 token 分组时忽略图片、音频这类单位。 */
export function sumTokenUnits(json: unknown): { tokens: number; incomplete: boolean } | null {
  if (!json || typeof json !== "object") return null;
  const rec = json as Record<string, unknown>;
  const series = rec.timeSeries ?? rec.time_series;
  if (!Array.isArray(series)) return null;
  const rows = series.filter((row) => row && typeof row === "object") as Record<string, unknown>[];
  const tokenRows = rows.filter((row) => {
    const group = Array.isArray(row.group) ? row.group : [];
    return group.some((g) => typeof g === "string" && /token/i.test(g));
  });
  let total = 0;
  for (const row of tokenRows.length ? tokenRows : rows) {
    const points = row.dataPoints ?? row.data_points;
    if (!Array.isArray(points)) continue;
    for (const pt of points) {
      if (!pt || typeof pt !== "object") continue;
      const values = (pt as { values?: unknown }).values;
      const n = Array.isArray(values) ? values[0] : undefined;
      if (typeof n === "number" && Number.isFinite(n) && n > 0) total += n;
    }
  }
  return {
    tokens: Math.round(total),
    incomplete: rec.limitReached === true || rec.limit_reached === true,
  };
}

function asPercent(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.min(100, n);
}

function asMoney(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function parseOpencodeGoUsage(json: unknown): UpstreamProbe | null {
  if (!json || typeof json !== "object") return null;
  const usage = (json as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const windows: UpstreamWindow[] = [];
  for (const name of ["rolling", "weekly", "monthly"] as const) {
    const w = (usage as Record<string, unknown>)[name];
    if (!w || typeof w !== "object") continue;
    const rec = w as Record<string, unknown>;
    const percent = asPercent(rec.percent);
    if (percent == null) continue;
    windows.push({
      name,
      percent,
      remainingPercent: Math.max(0, 100 - percent),
      resetsAt: typeof rec.resetsAt === "string" ? rec.resetsAt : undefined,
      status: typeof rec.status === "string" ? rec.status : undefined,
    });
  }
  if (!windows.length) return null;
  return {
    ok: true,
    source: "opencode_go",
    note: "OpenCode Go 套餐用量（不是 Zen 预付钱包）。",
    windows,
    label: windowsLabel(windows),
    detail: windows.map(windowDetail),
  };
}

export function parseOpencodeBalance(json: unknown): UpstreamProbe | null {
  if (!json || typeof json !== "object") return null;
  const rec = json as Record<string, unknown>;
  const nested = rec.balance && typeof rec.balance === "object" ? (rec.balance as Record<string, unknown>) : null;
  const usd = asMoney(rec.usd) ?? asMoney(nested?.usd) ?? asMoney(rec.balanceUsd);
  if (usd == null) return null;
  return {
    ok: true,
    source: "opencode_balance",
    note: "上游返回的钱包余额。",
    balanceUsd: usd,
    label: usdLabel(usd),
    detail: [`钱包余额 ${usdLabel(usd)}`],
  };
}

function usdLabel(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function windowsLabel(windows: UpstreamWindow[]): string {
  return windows.map((w) => `${w.name}剩 ${Math.round(w.remainingPercent)}%`).join(" · ");
}

const WINDOW_LABEL: Record<string, string> = {
  rolling: "5 小时",
  weekly: "7 天",
  monthly: "本月",
};

function fmtPct(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/** ponytail: 后台按东八区显示。要跟随浏览器时区再改到前端格式化。 */
function formatReset(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function windowDetail(w: UpstreamWindow): string {
  const name = WINDOW_LABEL[w.name] ?? w.name;
  const status = w.status === "rate-limited" ? "已限流" : !w.status || w.status === "ok" ? "正常" : w.status;
  const reset = w.resetsAt ? `，重置 ${formatReset(w.resetsAt)}` : "";
  return `${name}：已用 ${fmtPct(w.percent)}%，剩余 ${fmtPct(w.remainingPercent)}%，${status}${reset}`;
}

function asNumberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function currencyLabel(currency: string, n: number): string {
  const text = n.toFixed(2);
  if (currency === "USD") return `$${text}`;
  if (currency === "CNY") return `¥${text}`;
  return currency ? `${currency} ${text}` : text;
}

/** 各家余额响应形状不一样，按能认出的字段收成一行文案。 */
export function parseQuotaPayload(json: unknown, opts?: { cents?: boolean }): UpstreamProbe | null {
  const bal = parseOpencodeBalance(json);
  const go = parseOpencodeGoUsage(json);
  if (bal?.ok && go?.ok) {
    return {
      ...bal,
      windows: go.windows,
      label: [bal.label, go.label].filter(Boolean).join(" · "),
      note: "上游钱包余额 + Go 套餐用量。",
      detail: [...(bal.detail ?? []), ...(go.detail ?? [])],
    };
  }
  if (bal?.ok) return bal;
  if (go?.ok) return go;
  return parseAccountBalance(json) ?? parsePrepaidCents(json, opts?.cents === true) ?? parseGenericBalance(json);
}

function parseAccountBalance(json: unknown): UpstreamProbe | null {
  if (!json || typeof json !== "object") return null;
  const infos = (json as { balance_infos?: unknown }).balance_infos;
  if (!Array.isArray(infos)) return null;
  const parts: string[] = [];
  for (const item of infos) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const n = asNumberish(row.total_balance);
    if (n == null) continue;
    const currency = typeof row.currency === "string" ? row.currency.trim().toUpperCase() : "";
    parts.push(currencyLabel(currency, n));
  }
  if (!parts.length) return null;
  const dead = (json as { is_available?: unknown }).is_available === false;
  return {
    ok: true,
    source: "account_balance",
    label: parts.join(" · ") + (dead ? "（不可用）" : ""),
    note: "上游账户余额。",
    detail: accountDetail(infos, dead),
  };
}

const BALANCE_FIELD: Record<string, string> = {
  total_balance: "总额",
  granted_balance: "赠送",
  topped_up_balance: "充值",
};

function accountDetail(infos: unknown[], dead: boolean): string[] {
  const lines: string[] = [];
  for (const item of infos) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const currency = typeof row.currency === "string" ? row.currency.trim().toUpperCase() : "";
    for (const key of ["total_balance", "granted_balance", "topped_up_balance"]) {
      const n = asNumberish(row[key]);
      if (n == null) continue;
      lines.push(`${currency ? currency + " " : ""}${BALANCE_FIELD[key]} ${currencyLabel(currency, n)}`);
    }
  }
  if (dead) lines.push("账户不可用");
  return lines;
}

function parsePrepaidCents(json: unknown, cents: boolean): UpstreamProbe | null {
  if (!json || typeof json !== "object") return null;
  const rec = json as Record<string, unknown>;
  const total = rec.total;
  if (!total || typeof total !== "object" || Array.isArray(total)) return null;
  const n = asNumberish((total as Record<string, unknown>).val);
  if (n == null) return null;
  if (!cents && !Array.isArray(rec.changes)) return null;
  const usd = n / 100;
  return {
    ok: true,
    source: "prepaid",
    balanceUsd: usd,
    label: usdLabel(usd),
    note: "上游预付余额。",
    detail: [`预付余额 ${usdLabel(usd)}`],
  };
}

const BALANCE_KEYS = new Set([
  "balance",
  "total_balance",
  "remaining_balance",
  "available_balance",
  "credit",
  "credits",
  "quota",
  "usd",
  "amount",
]);
const SKIP_WALK = new Set(["usage", "changes", "balance_infos"]);

function parseGenericBalance(json: unknown): UpstreamProbe | null {
  const hits: { key: string; n: number }[] = [];
  walkBalance(json, 0, hits);
  if (!hits.length) return null;
  const lines = hits.map((h) => (h.key === "usd" ? currencyLabel("USD", h.n) : `${h.key} ${currencyLabel("", h.n)}`));
  return {
    ok: true,
    source: "generic",
    label: lines.join(" · "),
    note: `上游余额（${hits.map((h) => h.key).join(", ")}）。`,
    detail: lines,
    ...(hits.length === 1 && hits[0].key === "usd" ? { balanceUsd: hits[0].n } : {}),
  };
}

function walkBalance(node: unknown, depth: number, hits: { key: string; n: number }[]): void {
  if (!node || typeof node !== "object" || Array.isArray(node) || hits.length >= 3) return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (hits.length >= 3) return;
    const key = k.toLowerCase();
    if (SKIP_WALK.has(key)) continue;
    if (BALANCE_KEYS.has(key)) {
      const n = asNumberish(v);
      if (n != null) {
        hits.push({ key, n });
        continue;
      }
    }
    if (depth < 2 && v && typeof v === "object" && !Array.isArray(v)) walkBalance(v, depth + 1, hits);
  }
}

export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(aa.length, bb.length, 32);
  const xa = new Uint8Array(len);
  const xb = new Uint8Array(len);
  xa.set(aa);
  xb.set(bb);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: BufferSource, y: BufferSource) => boolean;
  };
  const sameBytes = subtle.timingSafeEqual
    ? subtle.timingSafeEqual(xa, xb)
    : xa.every((byte, i) => byte === xb[i]);
  return sameBytes && aa.length === bb.length;
}

export function openaiError(
  status: number,
  code: string,
  message: string,
  request?: Request,
  retryAfter?: number,
): Response {
  const headers = new Headers(corsHeaders(request));
  if (retryAfter && retryAfter > 0) headers.set("retry-after", String(retryAfter));
  return Response.json(
    {
      error: {
        message,
        type: status === 401 ? "invalid_request_error" : "api_error",
        code,
        ...(retryAfter && retryAfter > 0 ? { retry_after: retryAfter } : {}),
      },
    },
    { status, headers },
  );
}

export function corsHeaders(request?: Request): HeadersInit {
  const origin = request?.headers.get("origin")?.trim() || "";
  const cred = origin !== "" && isChatOrigin(origin);
  return {
    "access-control-allow-origin": cred ? origin : "*",
    ...(cred ? { "access-control-allow-credentials": "true", vary: "Origin" } : {}),
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers":
      "Authorization, Content-Type, x-api-key, api-key, anthropic-version, anthropic-beta, openai-beta, x-stainless-timeout, x-session-id, x-conversation-id, x-opencode-session, x-grok-conv-id",
    "access-control-expose-headers": "x-session-id, x-opencode-session, x-auto-tier",
    "access-control-max-age": "86400",
  };
}

export type ChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
};

const SESSION_MAX_MESSAGES = 80;
const SESSION_MAX_BYTES = 400_000;

export function resolveSessionId(opts: {
  header: (name: string) => string | null;
  payload: Record<string, unknown> | null;
  keyId: string;
}): string {
  const fromHeader =
    opts.header("x-session-id") ||
    opts.header("x-conversation-id") ||
    opts.header("x-opencode-session") ||
    opts.header("x-grok-conv-id");
  const body = opts.payload;
  const fromBody =
    (typeof body?.session_id === "string" && body.session_id) ||
    (typeof body?.conversation_id === "string" && body.conversation_id) ||
    "";
  const raw = (fromHeader || fromBody || `key:${opts.keyId}`).trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 128);
  return cleaned || `key:${opts.keyId}`;
}

export function looksLikeFullHistory(incoming: ChatMessage[]): boolean {
  if (incoming.length >= 2) return true;
  return incoming.some((m) => m.role === "assistant" || m.role === "tool");
}

function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function mergeSessionMessages(stored: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (!incoming.length) return stored;
  if (!stored.length || looksLikeFullHistory(incoming)) return incoming;
  const last = stored[stored.length - 1];
  const first = incoming[0];
  if (last && first && last.role === first.role && sameContent(last.content, first.content)) {
    return [...stored, ...incoming.slice(1)];
  }
  return [...stored, ...incoming];
}

export function trimSessionMessages(messages: ChatMessage[]): ChatMessage[] {
  let out = messages;
  if (out.length > SESSION_MAX_MESSAGES) {
    const sys = out[0]?.role === "system" ? [out[0]] : [];
    const rest = out.slice(sys.length);
    out = [...sys, ...rest.slice(-(SESSION_MAX_MESSAGES - sys.length))];
  }
  // ponytail: 超大上下文直接丢掉最旧的非 system 轮，避免 DO 存爆。要摘要压缩再另做。
  while (out.length > 2 && JSON.stringify(out).length > SESSION_MAX_BYTES) {
    const dropAt = out[0]?.role === "system" ? 1 : 0;
    out = [...out.slice(0, dropAt), ...out.slice(dropAt + 1)];
  }
  return out;
}

export function applyChatSseLine(acc: { content: string; tokens?: number }, line: string): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return;
  try {
    const json = JSON.parse(data) as {
      choices?: { delta?: { content?: unknown } }[];
      type?: string;
      response?: unknown;
    };
    const chunk = json.choices?.[0]?.delta?.content;
    if (typeof chunk === "string") acc.content += chunk;
    const usageSource =
      json.type === "response.completed" || json.type === "response.incomplete" ? (json.response ?? json) : json;
    const n = tokensFromUsage(usageSource);
    if (n != null) acc.tokens = n;
  } catch {
    /* ignore malformed sse line */
  }
}

export function assistantFromChatCompletion(json: unknown): ChatMessage | null {
  if (!json || typeof json !== "object") return null;
  const msg = (json as { choices?: { message?: ChatMessage }[] }).choices?.[0]?.message;
  if (!msg) return null;
  if (msg.role && msg.role !== "assistant") return null;
  return { ...msg, role: "assistant" };
}

export function parseModelsResponse(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const rec = json as { data?: unknown; models?: unknown };
  const raw = Array.isArray(rec.data) ? rec.data : Array.isArray(rec.models) ? rec.models : [];
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      ids.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  return ids;
}

const WINDOW_KEYS = ["context_length", "context_window", "max_input_tokens", "max_context_length"] as const;

/** 上游 /models 里带了上下文窗口的，按原始 id 收下；没带的不出现，由前端自己估。 */
export function parseModelWindows(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!json || typeof json !== "object") return out;
  const rec = json as { data?: unknown; models?: unknown };
  const raw = Array.isArray(rec.data) ? rec.data : Array.isArray(rec.models) ? rec.models : [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const card = item as Record<string, unknown>;
    if (typeof card.id !== "string" || !card.id.trim()) continue;
    for (const key of WINDOW_KEYS) {
      const value = card[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        out[card.id.trim()] = Math.floor(value);
        break;
      }
    }
  }
  return out;
}

type ExposedModel = { id: string; object: "model"; created: number; owned_by: string; context_length?: number };

export function exposeModels(
  groups: { providerId: string; models: string[]; windows?: Record<string, number> }[],
): ExposedModel[] {
  const prefix = groups.length > 1;
  const seen = new Set<string>();
  const out: ExposedModel[] = [];
  for (const g of groups) {
    for (const raw of g.models) {
      const id = prefix ? `${g.providerId}/${raw}` : raw;
      if (seen.has(id)) continue;
      seen.add(id);
      const window = g.windows?.[raw];
      out.push({ id, object: "model", created: 0, owned_by: g.providerId, ...(window ? { context_length: window } : {}) });
    }
  }
  return out;
}

/** contextLength 是 auto 两档所有候选里最小的窗口；算不出来就不给，由客户端按名字估。 */
export function exposeAutoModel(models: ExposedModel[], contextLength?: number): ExposedModel[] {
  if (models.some((m) => m.id === "auto")) return models;
  return [
    { id: "auto", object: "model", created: 0, owned_by: "auto", ...(contextLength ? { context_length: contextLength } : {}) },
    ...models,
  ];
}

export type ListedModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  display_name?: string;
  description?: string;
  /** 上游给了就透传；没有就不返回，由客户端按模型名估。 */
  context_length?: number;
  /** 深度思考能力：toggle / effort / always / none / unknown，auto 本身是 auto。 */
  thinking?: string;
};

/** Claude Code 发现模型时丢掉不含 claude/anthropic 的 id。加一层前缀让 /model 能看到千问。 */
export function claudeDiscoveryModels(models: ListedModel[]): ListedModel[] {
  return models.map((m) => {
    if (/claude|anthropic/i.test(m.id)) return m;
    return {
      ...m,
      id: `claude/${m.id}`,
      display_name: m.display_name ?? m.id,
      description: m.description ?? (m.id === "auto" ? "按对话难易自动选模型" : "From gateway"),
    };
  });
}

export function matchListedModel(models: ListedModel[], want: string): ListedModel | null {
  const raw = want.trim();
  if (!raw) return null;
  const bare = raw.replace(/^claude\//i, "");
  return (
    models.find((m) => m.id === raw) ||
    models.find((m) => m.id === bare) ||
    models.find((m) => m.id === `claude/${bare}`) ||
    models.find((m) => m.id.slice(m.id.lastIndexOf("/") + 1) === bare) ||
    null
  );
}

export function anthropicModelCard(model: ListedModel, requestedId = model.id): Record<string, unknown> {
  const display = model.display_name ?? model.id.replace(/^claude\//i, "");
  return {
    id: requestedId,
    type: "model",
    object: "model",
    display_name: display,
    created: model.created,
    created_at: new Date(model.created * 1000).toISOString(),
    owned_by: model.owned_by,
    ...(model.context_length ? { max_input_tokens: model.context_length, context_length: model.context_length } : {}),
  };
}

export function vendorPeers(
  providers: Map<string, Provider>,
  leadId: string,
  blocked: Set<string> = new Set(),
): Provider[] {
  const lead = providers.get(leadId);
  if (!lead) return [];
  return [...providers.values()].filter((p) => p.baseUrl === lead.baseUrl && !blocked.has(p.id));
}

export function vendorGroups(providers: Provider[]): { id: string; members: Provider[] }[] {
  const order: string[] = [];
  const byUrl = new Map<string, Provider[]>();
  for (const p of providers) {
    const cur = byUrl.get(p.baseUrl);
    if (cur) cur.push(p);
    else {
      order.push(p.baseUrl);
      byUrl.set(p.baseUrl, [p]);
    }
  }
  return order.map((url) => {
    const members = byUrl.get(url)!;
    return { id: members[0].id, members };
  });
}

/** 同一会话钉在账号池的固定一把上。ponytail: 账号增删会让取模错位，这一会话的缓存冷一次。要稳就改成一致性哈希。 */
export function stickyAccountId(ids: string[], sessionKey: string): string {
  if (ids.length <= 1) return ids[0] ?? "";
  let h = 2166136261;
  for (let i = 0; i < sessionKey.length; i++) {
    h ^= sessionKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ids[(h >>> 0) % ids.length];
}

const UPSTREAM_STICKY_HEADERS = ["x-opencode-session", "x-session-id", "x-conversation-id", "x-grok-conv-id"];

function hasCacheControl(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 8) return false;
  if (Array.isArray(value)) return value.some((item) => hasCacheControl(item, depth + 1));
  const rec = value as Record<string, unknown>;
  if (rec.cache_control) return true;
  return Object.values(rec).some((item) => hasCacheControl(item, depth + 1));
}

function deepseekUserId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 512);
}

/** 去掉别家的粘性头，再按这家上游的协议写。body 就地改，调用方再序列化。客户端已写的字段不覆盖。 */
export function applyUpstreamSticky(
  headers: Headers,
  payload: unknown,
  baseUrl: string,
  sessionId: string | undefined,
  rest: string,
): void {
  for (const name of UPSTREAM_STICKY_HEADERS) headers.delete(name);
  if (!sessionId) return;
  const host = providerHost(baseUrl);
  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
    headers.set("x-opencode-session", sessionId);
    return;
  }
  if (host === "x.ai" || host.endsWith(".x.ai")) {
    if (rest === "responses") {
      if (body && typeof body.prompt_cache_key !== "string") body.prompt_cache_key = sessionId;
    } else {
      headers.set("x-grok-conv-id", sessionId);
    }
    return;
  }
  if ((host === "deepseek.com" || host.endsWith(".deepseek.com")) && rest === "chat/completions") {
    if (body && typeof body.user_id !== "string") {
      const id = deepseekUserId(sessionId);
      if (id) body.user_id = id;
    }
    return;
  }
  if ((host === "api.openai.com" || host === "openai.com") && (rest === "chat/completions" || rest === "responses")) {
    if (body && typeof body.prompt_cache_key !== "string") body.prompt_cache_key = sessionId;
    return;
  }
  if ((host === "anthropic.com" || host.endsWith(".anthropic.com")) && rest === "messages") {
    if (body && !hasCacheControl(body)) body.cache_control = { type: "ephemeral" };
  }
}

export function rotateFrom<T extends { id: string }>(items: T[], startId: string): T[] {
  if (items.length <= 1) return items;
  const i = items.findIndex((x) => x.id === startId);
  if (i <= 0) return items;
  return [...items.slice(i), ...items.slice(0, i)];
}

/** 429 换号；401/403 拉黑后换号；其它状态直接返回给客户端。 */
export function failoverAction(status: number): "next" | "ban-next" | "stop" {
  if (status === 429) return "next";
  if (status === 401 || status === 403) return "ban-next";
  return "stop";
}

function uniqueRestrictedProvider(
  model: string,
  providers: Map<string, Provider>,
  blocked: Set<string>,
): string | null {
  if (!model) return null;
  const hits: string[] = [];
  for (const p of providers.values()) {
    if (blocked.has(p.id)) continue;
    const host = providerHost(p.baseUrl);
    const restricted =
      host === "opencode.ai" ||
      host.endsWith(".opencode.ai") ||
      p.id === "grok" ||
      host === "x.ai" ||
      host.endsWith(".x.ai");
    if (!restricted) continue;
    if (modelAllowed(p, model)) hits.push(p.id);
  }
  return hits.length === 1 ? hits[0] : null;
}

export function pickUpstream(opts: {
  requestedModel: string | undefined;
  aliases: Record<string, string>;
  keyProvider?: string;
  defaultProvider: string;
  providers: Map<string, Provider>;
  blocked?: Set<string>;
}): { provider: Provider; model: string } {
  if (opts.providers.size === 0) {
    throw new GatewayError(503, "no_provider", "No upstream provider is configured");
  }

  const blocked = opts.blocked ?? new Set<string>();
  const usable = (id: string) => opts.providers.has(id) && !blocked.has(id);

  let model = (opts.requestedModel ?? "").trim();
  if (model && opts.aliases[model]) model = opts.aliases[model];
  if (/^claude\//i.test(model) && !opts.providers.has("claude")) {
    model = model.replace(/^claude\//i, "");
    if (model && opts.aliases[model]) model = opts.aliases[model];
  }

  if (opts.keyProvider && blocked.has(opts.keyProvider)) {
    throw new GatewayError(503, "provider_blacklisted", `Upstream '${opts.keyProvider}' is blacklisted`);
  }

  const firstLive = [...opts.providers.keys()].find((id) => usable(id));
  if (!firstLive) {
    throw new GatewayError(503, "provider_blacklisted", "All upstream providers are blacklisted");
  }

  let providerId = opts.keyProvider || (usable(opts.defaultProvider) ? opts.defaultProvider : firstLive);
  const slash = model.indexOf("/");
  let namedProvider = false;
  if (slash > 0) {
    const maybe = model.slice(0, slash);
    const named = opts.providers.get(maybe);
    if (named || blocked.has(maybe)) {
      namedProvider = true;
      if (opts.keyProvider && opts.keyProvider !== maybe) {
        throw new GatewayError(403, "provider_locked", `This key is locked to provider '${opts.keyProvider}'`);
      }
      if (blocked.has(maybe)) {
        const sibling = named ? vendorPeers(opts.providers, named.id, blocked)[0] : undefined;
        if (!sibling) {
          throw new GatewayError(503, "provider_blacklisted", `Upstream '${maybe}' is blacklisted`);
        }
        providerId = sibling.id;
      } else {
        providerId = maybe;
      }
      model = model.slice(slash + 1);
    }
  }
  if (!namedProvider && !opts.keyProvider) {
    const unique = uniqueRestrictedProvider(model, opts.providers, blocked);
    if (unique) providerId = unique;
  }

  if (blocked.has(providerId)) {
    throw new GatewayError(503, "provider_blacklisted", `Upstream '${providerId}' is blacklisted`);
  }

  const provider = opts.providers.get(providerId);
  if (!provider) {
    throw new GatewayError(400, "unknown_provider", `Unknown or unconfigured provider '${providerId}'`);
  }
  return { provider, model };
}
