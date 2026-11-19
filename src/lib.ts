export class GatewayError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
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
  quota?: QuotaQuery;
  /** 空字符串表示 quota.secret 在环境里没有值。 */
  quotaKey?: string;
  quotaError?: string;
};

export type ProviderPublic = {
  id: string;
  baseUrl: string;
  configured: boolean;
};

export type ProviderConfig = {
  id: string;
  baseUrl: string;
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
};

export type KeyPublic = {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  createdAt: number;
  provider?: string;
  quotaTokens?: number;
};

export type Meter = {
  used: number;
  requests: number;
};

export type KeyView = KeyPublic & {
  quotaTokens: number;
  usedTokens: number;
  requestCount: number;
  remainingTokens: number | null;
};

export const FALLBACK_QUOTA_TOKENS = 1_000_000;

const PROXY_PATHS = new Set([
  "chat/completions",
  "completions",
  "responses",
  "messages",
  "models",
  "embeddings",
  "images/generations",
  "images/edits",
]);

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  return `${b}/${p}`;
}

export function stripV1(pathname: string): string {
  return pathname.replace(/\/+$/, "").replace(/^\/v1(?=\/|$)/, "") || "/";
}

export function upstreamRestPath(pathname: string): string | null {
  const rest = stripV1(pathname).replace(/^\//, "");
  if (!PROXY_PATHS.has(rest)) return null;
  return rest;
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
    out.push(quota ? { id, baseUrl, quota } : { id, baseUrl });
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

export function loadProviders(env: object & { PROVIDERS?: unknown }): {
  live: Provider[];
  publicList: ProviderPublic[];
} {
  const live: Provider[] = [];
  const publicList: ProviderPublic[] = [];
  for (const cfg of providerConfigs(env)) {
    const apiKey = providerSecret(env, cfg.id);
    publicList.push({ id: cfg.id, baseUrl: cfg.baseUrl, configured: Boolean(apiKey) });
    if (apiKey) live.push({ ...cfg, apiKey, ...bindQuota(env, cfg.quota, apiKey) });
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

export type UpstreamWindow = {
  name: string;
  percent: number;
  remainingPercent: number;
  resetsAt?: string;
};

export type UpstreamProbe = {
  ok: boolean;
  source?: string;
  note: string;
  /** 后台直接展示的余额文案。 */
  label?: string;
  windows?: UpstreamWindow[];
  balanceUsd?: number;
};

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
    });
  }
  if (!windows.length) return null;
  return {
    ok: true,
    source: "opencode_go",
    note: "OpenCode Go 套餐用量（不是 Zen 预付钱包）。",
    windows,
    label: windowsLabel(windows),
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
  };
}

function usdLabel(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function windowsLabel(windows: UpstreamWindow[]): string {
  return windows.map((w) => `${w.name}剩 ${Math.round(w.remainingPercent)}%`).join(" · ");
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
  };
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
  return {
    ok: true,
    source: "generic",
    label: hits
      .map((h) => (h.key === "usd" ? currencyLabel("USD", h.n) : `${h.key} ${currencyLabel("", h.n)}`))
      .join(" · "),
    note: `上游余额（${hits.map((h) => h.key).join(", ")}）。`,
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

export function openaiError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { message, type: status === 401 ? "invalid_request_error" : "api_error", code } },
    { status, headers: corsHeaders() },
  );
}

export function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "Authorization, Content-Type, x-api-key, api-key, anthropic-version, openai-beta, x-stainless-timeout, x-session-id, x-conversation-id, x-opencode-session",
    "access-control-expose-headers": "x-session-id, x-opencode-session",
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
    opts.header("x-opencode-session");
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
    const json = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] };
    const chunk = json.choices?.[0]?.delta?.content;
    if (typeof chunk === "string") acc.content += chunk;
    const n = tokensFromUsage(json);
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

export function exposeModels(groups: { providerId: string; models: string[] }[]): {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}[] {
  const prefix = groups.length > 1;
  const seen = new Set<string>();
  const out: { id: string; object: "model"; created: number; owned_by: string }[] = [];
  for (const g of groups) {
    for (const raw of g.models) {
      const id = prefix ? `${g.providerId}/${raw}` : raw;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, object: "model", created: 0, owned_by: g.providerId });
    }
  }
  return out;
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

  if (opts.keyProvider && blocked.has(opts.keyProvider)) {
    throw new GatewayError(503, "provider_blacklisted", `Upstream '${opts.keyProvider}' is blacklisted`);
  }

  const firstLive = [...opts.providers.keys()].find((id) => usable(id));
  if (!firstLive) {
    throw new GatewayError(503, "provider_blacklisted", "All upstream providers are blacklisted");
  }

  let providerId = opts.keyProvider || (usable(opts.defaultProvider) ? opts.defaultProvider : firstLive);
  const slash = model.indexOf("/");
  if (slash > 0) {
    const maybe = model.slice(0, slash);
    const named = opts.providers.get(maybe);
    if (named || blocked.has(maybe)) {
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

  if (blocked.has(providerId)) {
    throw new GatewayError(503, "provider_blacklisted", `Upstream '${providerId}' is blacklisted`);
  }

  const provider = opts.providers.get(providerId);
  if (!provider) {
    throw new GatewayError(400, "unknown_provider", `Unknown or unconfigured provider '${providerId}'`);
  }
  return { provider, model };
}
