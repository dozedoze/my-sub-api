import { GatewayError } from "./lib.ts";

/** 管理员对用户 MCP 地址的总策略，存在 KV。 */
export type McpPolicy = {
  enabled: boolean;
  /** 非空时，只允许这些域名及其子域名。 */
  allowDomains: string[];
  /** 永远拒绝。优先于 allowDomains。 */
  denyDomains: string[];
};

export const DEFAULT_MCP_POLICY: McpPolicy = { enabled: true, allowDomains: [], denyDomains: [] };

/** 网关自己的域名。用户 MCP 指回自己会形成回环。 */
const SELF_DOMAINS = ["aofahub.dev"];

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  ".intranet",
  ".corp",
  ".private",
  ".test",
  ".invalid",
  ".example",
  ".onion",
];

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 3;

function bad(message: string): never {
  throw new GatewayError(400, "invalid_request", message);
}

export function normalizeDomain(raw: unknown): string {
  if (typeof raw !== "string") bad("domain must be a string");
  const host = raw.trim().toLowerCase().replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.length > 253) bad(`invalid domain '${raw}'`);
  return host;
}

export function parseMcpPolicy(raw: unknown): McpPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("policy must be an object");
  const rec = raw as { enabled?: unknown; allowDomains?: unknown; denyDomains?: unknown };
  if (typeof rec.enabled !== "boolean") bad("enabled must be a boolean");
  const list = (value: unknown, label: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 200) bad(`${label} must be an array of at most 200 domains`);
    return [...new Set(value.map((item) => normalizeDomain(item)))];
  };
  return { enabled: rec.enabled, allowDomains: list(rec.allowDomains, "allowDomains"), denyDomains: list(rec.denyDomains, "denyDomains") };
}

function inDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * 校验用户给的 MCP 地址能不能由网关去连。只允许 https、域名、443，
 * 拒绝 IP 字面量、内网和保留后缀、网关自身。DNS 重绑定在 Workers 里无法控制，
 * 但 Workers 本身到不了私网地址；这里挡的是已知写法。
 */
export function assertPublicHttpsUrl(raw: string, policy: McpPolicy, selfHost?: string): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) bad("url is missing or too long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    bad("url is not valid");
  }
  if (url.protocol !== "https:") bad("only https urls are allowed");
  if (url.username || url.password) bad("urls must not contain credentials; use a secret placeholder instead");
  if (url.port && url.port !== "443") bad("only the default https port is allowed");
  if (url.hash) bad("url must not have a fragment");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) bad("url has no host");
  if (host.startsWith("[") || host.includes(":")) bad("ip addresses are not allowed; use a domain name");
  if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f.]+$/i.test(host)) bad("ip addresses are not allowed; use a domain name");
  if (!host.includes(".")) bad("single-label hosts are not allowed");
  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) bad("this host is not allowed");
  for (const self of SELF_DOMAINS) {
    if (inDomain(host, self)) bad("the gateway's own domain is not allowed");
  }
  if (selfHost && host === selfHost.toLowerCase()) bad("the gateway's own domain is not allowed");
  if (policy.denyDomains.some((domain) => inDomain(host, domain))) bad("this domain is blocked by the administrator");
  if (policy.allowDomains.length > 0 && !policy.allowDomains.some((domain) => inDomain(host, domain))) {
    bad("this domain is not on the administrator's allow list");
  }
  return url;
}

export type GuardedFetchOptions = {
  policy: McpPolicy;
  selfHost?: string;
  timeoutMs: number;
  /** 测试里注入。 */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

/**
 * 手动跟随重定向，每一跳都重新校验，跨源时丢掉用户配置的请求头（含 Authorization）。
 * 返回的 Response 由调用方负责读取。
 */
export async function guardedFetch(rawUrl: string, init: RequestInit, opts: GuardedFetchOptions): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  let url = assertPublicHttpsUrl(rawUrl, opts.policy, opts.selfHost);
  let headers = new Headers(init.headers);
  let method = init.method ?? "GET";
  let body = init.body;
  const origin = url.origin;
  const signals: AbortSignal[] = [AbortSignal.timeout(opts.timeoutMs)];
  if (opts.signal) signals.push(opts.signal);
  const signal = AbortSignal.any(signals);
  for (let hop = 0; ; hop++) {
    const res = await doFetch(url.toString(), { ...init, method, headers, body, redirect: "manual", signal });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (!location || hop >= MAX_REDIRECTS) throw new GatewayError(502, "mcp_error", "too many redirects from MCP server");
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new GatewayError(502, "mcp_error", "invalid redirect from MCP server");
    }
    url = assertPublicHttpsUrl(next.toString(), opts.policy, opts.selfHost);
    if (url.origin !== origin) headers = new Headers({ "content-type": headers.get("content-type") ?? "application/json" });
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
}

/** 读完整个响应体，超过上限就中止。 */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GatewayError(502, "mcp_error", "MCP response is too large");
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}
