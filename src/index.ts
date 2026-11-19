import { DurableObject } from "cloudflare:workers";
import { adminHtml } from "./admin-ui";
import {
  ADMIN_SESSION_COOKIE,
  adminSessionClearCookie,
  adminSessionSetCookie,
  applyChatSseLine,
  assistantFromChatCompletion,
  attachUsage,
  corsHeaders,
  defaultQuotaTokens,
  effectiveQuota,
  estimateTokens,
  extractToken,
  GatewayError,
  goAllowanceBlocks,
  isGoSubscription,
  joinUrl,
  mintAdminSession,
  loadProviders,
  looksLikeFullHistory,
  mergeSessionMessages,
  openaiError,
  exposeModels,
  failoverAction,
  parseJsonObject,
  modelAllowed,
  parseModelsResponse,
  parseOpencodeBalance,
  parseOpencodeGoUsage,
  parseQuotaPayload,
  parseQuotaInput,
  resolveQuotaUrl,
  sumTokenUnits,
  xaiUsageBody,
  xaiUsageUrl,
  pickUpstream,
  readCookie,
  resolveSessionId,
  rotateFrom,
  timingSafeEqualString,
  verifyAdminSession,
  tokensFromUsage,
  trimSessionMessages,
  upstreamRestPath,
  vendorGroups,
  vendorPeers,
  type ChatMessage,
  type Meter,
  type Provider,
  type UpstreamProbe,
} from "./lib";
import {
  banUpstream,
  createIssuedKey,
  deleteIssuedKey,
  listIssuedKeys,
  loadUpstreamBans,
  lookupByPlaintext,
  patchIssuedKey,
  unbanUpstream,
} from "./keys";

export class ChatSession extends DurableObject<Env> {
  async load(): Promise<ChatMessage[]> {
    return (await this.ctx.storage.get<ChatMessage[]>("messages")) ?? [];
  }

  async save(messages: ChatMessage[]): Promise<void> {
    await this.ctx.storage.put("messages", trimSessionMessages(messages));
  }
}

export class QuotaBoard extends DurableObject<Env> {
  async snapshot(): Promise<{ keys: Record<string, Meter>; providers: Record<string, Meter> }> {
    const keys: Record<string, Meter> = {};
    const providers: Record<string, Meter> = {};
    for (const [name, value] of await this.ctx.storage.list<Meter>()) {
      if (name.startsWith("k:")) keys[name.slice(2)] = value;
      else if (name.startsWith("p:")) providers[name.slice(2)] = value;
    }
    return { keys, providers };
  }

  async peek(keyId: string): Promise<Meter> {
    return (await this.ctx.storage.get<Meter>(`k:${keyId}`)) ?? { used: 0, requests: 0 };
  }

  async add(keyId: string, providerId: string, tokens: number): Promise<Meter> {
    const n = Math.max(0, Math.floor(tokens));
    const cur = await this.peek(keyId);
    const next = { used: cur.used + n, requests: cur.requests + 1 };
    await this.ctx.storage.put(`k:${keyId}`, next);
    const p = (await this.ctx.storage.get<Meter>(`p:${providerId}`)) ?? { used: 0, requests: 0 };
    await this.ctx.storage.put(`p:${providerId}`, { used: p.used + n, requests: p.requests + 1 });
    return next;
  }

  async reset(keyId: string): Promise<void> {
    await this.ctx.storage.delete(`k:${keyId}`);
  }

  async takeRoundRobin(group: string, ids: string[]): Promise<string> {
    if (ids.length === 0) throw new Error("no ids");
    if (ids.length === 1) return ids[0];
    const key = `rr:${group}`;
    const n = (await this.ctx.storage.get<number>(key)) ?? 0;
    const id = ids[n % ids.length];
    await this.ctx.storage.put(key, n + 1);
    return id;
  }
}

function quotaBoard(env: Env): DurableObjectStub<QuotaBoard> {
  return env.QUOTAS.get(env.QUOTAS.idFromName("board"));
}

const HOP = new Set([
  "authorization",
  "cookie",
  "connection",
  "content-length",
  "content-encoding",
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "x-api-key",
  "api-key",
]);

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      if (err instanceof GatewayError) return openaiError(err.status, err.code, err.message);
      console.error(JSON.stringify({ message: "unhandled", error: err instanceof Error ? err.message : String(err) }));
      return openaiError(500, "internal_error", "Internal server error");
    }
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "GET" && path === "/health") {
    return Response.json({ ok: true }, { headers: corsHeaders() });
  }
  if (request.method === "GET" && path === "/") {
    return new Response(landing(url.origin), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (request.method === "GET" && path === "/admin") {
    return new Response(adminHtml(url.origin), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (path.startsWith("/admin/api")) {
    if (request.method === "POST" && path === "/admin/api/logout") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          ...corsHeaders(),
          "content-type": "application/json",
          "set-cookie": adminSessionClearCookie(request.url),
        },
      });
    }
    const viaBearer = await requireAdmin(request, env);
    const res = await adminApi(request, env, path);
    if (!viaBearer) return res;
    const headers = new Headers(res.headers);
    headers.append("set-cookie", adminSessionSetCookie(await mintAdminSession(env.ADMIN_TOKEN.trim()), request.url));
    return new Response(res.body, { status: res.status, headers });
  }

  const rest = upstreamRestPath(path);
  if (!rest) return openaiError(404, "not_found", "Not found");
  if (request.method !== "GET" && request.method !== "POST") {
    return openaiError(405, "method_not_allowed", "Method not allowed");
  }
  return proxy(request, env, ctx, rest);
}

function landing(origin: string): string {
  return `<!DOCTYPE html><meta charset="utf-8"><title>my-sub-api</title>
<body style="font:16px/1.5 system-ui;background:#0b0d12;color:#e8edf7;padding:48px">
<h1>my-sub-api</h1>
<p>OpenAI 兼容 API 中转。使用者 Base URL：<code>${origin}/v1</code></p>
<p><a href="/admin" style="color:#6ee7b7">管理后台</a>（签发 Key）</p>
</body>`;
}

/** @returns true if auth was the raw ADMIN_TOKEN (mint a session cookie). */
async function requireAdmin(request: Request, env: Env): Promise<boolean> {
  const token = env.ADMIN_TOKEN?.trim();
  if (!token) throw new GatewayError(503, "admin_unconfigured", "ADMIN_TOKEN is not set");
  const got = extractToken(request);
  if (got) {
    if (await timingSafeEqualString(got, token)) return true;
    throw new GatewayError(401, "unauthorized", "Invalid admin token");
  }
  const cookie = readCookie(request.headers.get("cookie"), ADMIN_SESSION_COOKIE);
  if (cookie && (await verifyAdminSession(token, cookie))) return false;
  throw new GatewayError(401, "unauthorized", "Invalid admin token");
}

async function adminApi(request: Request, env: Env, path: string): Promise<Response> {
  const { live, publicList } = loadProviders(env);
  const fallbackQuota = defaultQuotaTokens(env.DEFAULT_QUOTA_TOKENS);
  const board = quotaBoard(env);

  if (request.method === "GET" && path === "/admin/api/status") {
    const meters = await board.snapshot();
    const bans = await loadUpstreamBans(env.KEYS);
    const liveMap = new Map(live.map((p) => [p.id, p]));
    const providers = await Promise.all(
      publicList.map(async (p) => {
        const meter = meters.providers[p.id] ?? { used: 0, requests: 0 };
        const blacklist = bans[p.id] ?? null;
        const configured = liveMap.get(p.id);
        if (!configured || blacklist) {
          return {
            ...p,
            localUsedTokens: meter.used,
            localRequests: meter.requests,
            upstream: null,
            models: [] as string[],
            blacklist,
          };
        }
        const [upstream, models] = await Promise.all([probeUpstream(configured), fetchUpstreamModels(configured)]);
        return { ...p, localUsedTokens: meter.used, localRequests: meter.requests, upstream, models, blacklist };
      }),
    );
    return Response.json(
      { providers, defaultProvider: live[0]?.id, defaultQuotaTokens: fallbackQuota },
      { headers: corsHeaders() },
    );
  }

  if (request.method === "GET" && path === "/admin/api/keys") {
    const meters = await board.snapshot();
    return Response.json(
      { keys: attachUsage(await listIssuedKeys(env.KEYS), meters.keys, fallbackQuota) },
      { headers: corsHeaders() },
    );
  }

  if (request.method === "POST" && path === "/admin/api/keys") {
    const body = (await request.json().catch(() => ({}))) as { name?: string; provider?: string; quotaTokens?: unknown };
    const name = (body.name ?? "").trim();
    if (!name) throw new GatewayError(400, "invalid_request", "name is required");
    if (body.provider && !publicList.some((p) => p.id === body.provider && p.configured)) {
      throw new GatewayError(400, "invalid_request", `provider '${body.provider}' is not configured`);
    }
    if (body.provider && (await loadUpstreamBans(env.KEYS))[body.provider]) {
      throw new GatewayError(400, "invalid_request", `provider '${body.provider}' is blacklisted`);
    }
    const created = await createIssuedKey(env.KEYS, {
      name,
      provider: body.provider,
      quotaTokens: parseQuotaInput(body.quotaTokens, fallbackQuota),
    });
    return Response.json({ key: created.plaintext, ...created.record }, { headers: corsHeaders() });
  }

  const one = path.match(/^\/admin\/api\/keys\/([^/]+)$/);
  if (one) {
    const id = decodeURIComponent(one[1]);
    if (request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { enabled?: boolean; quotaTokens?: unknown };
      const patch: { enabled?: boolean; quotaTokens?: number } = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (body.quotaTokens !== undefined) patch.quotaTokens = parseQuotaInput(body.quotaTokens, fallbackQuota);
      if (patch.enabled === undefined && patch.quotaTokens === undefined) {
        throw new GatewayError(400, "invalid_request", "enabled or quotaTokens required");
      }
      const rec = await patchIssuedKey(env.KEYS, id, patch);
      if (!rec) throw new GatewayError(404, "not_found", "Key not found");
      return Response.json(rec, { headers: corsHeaders() });
    }
    if (request.method === "DELETE") {
      const ok = await deleteIssuedKey(env.KEYS, id);
      if (!ok) throw new GatewayError(404, "not_found", "Key not found");
      await board.reset(id);
      return Response.json({ deleted: true }, { headers: corsHeaders() });
    }
  }

  const bl = path.match(/^\/admin\/api\/providers\/([^/]+)\/blacklist$/);
  if (bl) {
    const id = decodeURIComponent(bl[1]);
    if (!publicList.some((p) => p.id === id)) {
      throw new GatewayError(404, "not_found", "Provider not found");
    }
    if (request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { reason?: string };
      const hit = await banUpstream(env.KEYS, id, typeof body.reason === "string" ? body.reason : "manual", false);
      return Response.json(hit, { headers: corsHeaders() });
    }
    if (request.method === "DELETE") {
      await unbanUpstream(env.KEYS, id);
      return Response.json({ deleted: true }, { headers: corsHeaders() });
    }
  }

  throw new GatewayError(404, "not_found", "Not found");
}

async function probeUpstream(provider: Provider): Promise<UpstreamProbe> {
  if (provider.quota) return probeConfiguredQuota(provider);
  const unavailable: UpstreamProbe = {
    ok: false,
    note: "该上游没有配置额度查询。在 PROVIDERS 里给它加 quota。下面数字是本站统计的已消耗 token。",
  };
  if (provider.id !== "opencode" && !/opencode\.ai/i.test(provider.baseUrl)) return unavailable;
  let origin: string;
  try {
    origin = new URL(provider.baseUrl).origin;
  } catch {
    return unavailable;
  }
  const [go, bal] = await Promise.all([
    fetchJsonSilent(`${origin}/zen/go/v1/usage`, provider.apiKey),
    // 订阅地址不查 Zen 钱包。那个余额是按量另扣的。
    isGoSubscription(provider.baseUrl)
      ? Promise.resolve(null)
      : fetchJsonSilent(`${origin}/zen/v1/balance`, provider.apiKey),
  ]);
  const parsedBal = parseOpencodeBalance(bal);
  const parsedGo = parseOpencodeGoUsage(go);
  if (parsedBal?.ok && parsedGo?.ok) {
    return {
      ...parsedBal,
      windows: parsedGo.windows,
      label: [parsedBal.label, parsedGo.label].filter(Boolean).join(" · "),
      note: "上游钱包余额 + Go 套餐用量。",
      detail: [...(parsedBal.detail ?? []), ...(parsedGo.detail ?? [])],
    };
  }
  if (parsedBal?.ok) return parsedBal;
  if (parsedGo?.ok) return parsedGo;
  return {
    ok: false,
    note: "OpenCode Zen 预付余额目前不能用 API Key 查询，只能看网页控制台。若这把 Key 是 Go 订阅，用量接口这次也没返回数据。",
  };
}

async function probeConfiguredQuota(provider: Provider): Promise<UpstreamProbe> {
  const quota = provider.quota;
  if (!quota) return { ok: false, note: "该上游没有配置额度查询。" };
  if (provider.quotaError) {
    const secretNote = quota.secret && !provider.quotaKey ? `；密钥未配置（${quota.secret}）` : "";
    return { ok: false, note: provider.quotaError + secretNote };
  }
  if (!provider.quotaKey) {
    return { ok: false, note: `额度查询密钥未配置（${quota.secret}）` };
  }
  const url = resolveQuotaUrl(provider.baseUrl, quota.url);
  if (!url) return { ok: false, note: "额度查询地址无效" };
  const res = await fetchQuota(url, provider.quotaKey, quota.method ?? "GET", quota.body);
  const probe = !res.ok
    ? res.status
      ? { ok: false as const, note: `额度接口返回 HTTP ${res.status}` }
      : { ok: false as const, note: "额度接口请求失败" }
    : (parseQuotaPayload(res.json, { cents: quota.cents }) ?? {
        ok: false as const,
        note: "额度接口有响应，但没有认出余额字段",
      });
  if (!res.ok && res.status) {
    console.error(JSON.stringify({ message: "quota_probe", provider: provider.id, status: res.status }));
  }
  return attachXaiTokenSum(provider, url, probe);
}

async function attachXaiTokenSum(provider: Provider, balanceUrl: string, probe: UpstreamProbe): Promise<UpstreamProbe> {
  const usageUrl = xaiUsageUrl(balanceUrl);
  if (!usageUrl || !provider.quotaKey) return probe;
  let res = await fetchQuota(usageUrl, provider.quotaKey, "POST", xaiUsageBody());
  if (!res.ok && res.status === 400) {
    res = await fetchQuota(usageUrl, provider.quotaKey, "POST", xaiUsageBody(new Date(), "TIME_UNIT_MONTH"));
  }
  if (!res.ok) {
    if (res.status) {
      console.error(JSON.stringify({ message: "usage_probe", provider: provider.id, status: res.status }));
    }
    return probe;
  }
  const sum = sumTokenUnits(res.json);
  if (!sum) return probe;
  const incomplete = sum.incomplete ? "累计可能不完整。" : "";
  return {
    ...probe,
    usedTokens: sum.tokens,
    ...(sum.incomplete ? { usageIncomplete: true } : {}),
    note: `${probe.note} 累计 token 来自 xAI 账单，包含没经过本站的调用。${incomplete}`.trim(),
  };
}

async function fetchQuota(
  url: string,
  apiKey: string,
  method: string,
  body: unknown,
): Promise<{ ok: true; json: unknown } | { ok: false; status?: number }> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status };
    }
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false };
  }
}

async function fetchJsonSilent(url: string, apiKey: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function proxy(request: Request, env: Env, ctx: ExecutionContext, rest: string): Promise<Response> {
  const token = extractToken(request);
  if (!token) throw new GatewayError(401, "invalid_api_key", "Missing API key");
  const issued = await lookupByPlaintext(env.KEYS, token);
  if (!issued) throw new GatewayError(401, "invalid_api_key", "Invalid API key");

  const { live } = loadProviders(env);
  const map = new Map(live.map((p) => [p.id, p]));
  const blocked = new Set(Object.keys(await loadUpstreamBans(env.KEYS)));
  const aliases = parseJsonObject(env.MODEL_ALIASES);
  const defaultProvider = live[0]?.id ?? "";

  if (rest === "models" && request.method === "GET") {
    if (issued.provider && blocked.has(issued.provider)) {
      throw new GatewayError(503, "provider_blacklisted", `Upstream '${issued.provider}' is blacklisted`);
    }
    const targets = (issued.provider ? [map.get(issued.provider)] : live).filter(
      (p): p is Provider => p != null && !blocked.has(p.id),
    );
    return listModels(targets);
  }

  let model: string | undefined;
  let payload: unknown;
  if (request.method !== "GET") {
    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      throw new GatewayError(400, "invalid_request", "Content-Type must be application/json");
    }
    payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      throw new GatewayError(400, "invalid_request", "Invalid JSON body");
    }
    if ("model" in payload && typeof payload.model === "string") model = payload.model;
  }

  const picked = pickUpstream({
    requestedModel: model,
    aliases,
    keyProvider: issued.provider,
    defaultProvider,
    providers: map,
    blocked,
  });

  if (payload && typeof payload === "object" && picked.model) {
    (payload as { model: string }).model = picked.model;
  }
  if (picked.model && !modelAllowed(picked.provider, picked.model)) {
    throw new GatewayError(400, "model_not_allowed", `Model '${picked.model}' is not enabled on this upstream`);
  }

  const fallbackQuota = defaultQuotaTokens(env.DEFAULT_QUOTA_TOKENS);
  const quota = effectiveQuota(issued, fallbackQuota);
  const board = quotaBoard(env);
  if (request.method !== "GET") {
    // ponytail: 先 peek 再打上游，并发最后几下可能略超额度。要卡死就改成 DO 里 reserve。
    const meter = await board.peek(issued.id);
    if (quota > 0 && meter.used >= quota) {
      throw new GatewayError(
        429,
        "insufficient_quota",
        `Token quota exceeded (${meter.used}/${quota})`,
      );
    }
  }

  if (rest === "chat/completions" && payload && typeof payload === "object") {
    const p = payload as { stream?: unknown; stream_options?: Record<string, unknown> };
    if (p.stream === true) {
      p.stream_options = { ...p.stream_options, include_usage: true };
    }
  }

  let sessionId: string | undefined;
  let sessionStub: DurableObjectStub<ChatSession> | undefined;
  let forwardedMessages: ChatMessage[] | undefined;
  if (rest === "chat/completions" && payload && typeof payload === "object" && Array.isArray((payload as { messages?: unknown }).messages)) {
    const incoming = (payload as { messages: ChatMessage[] }).messages;
    sessionId = resolveSessionId({
      header: (name) => request.headers.get(name),
      payload: payload as Record<string, unknown>,
      keyId: issued.id,
    });
    sessionStub = env.SESSIONS.get(env.SESSIONS.idFromName(`${issued.id}:${sessionId}`));
    const merged = looksLikeFullHistory(incoming)
      ? incoming
      : mergeSessionMessages(await sessionStub.load(), incoming);
    (payload as { messages: ChatMessage[] }).messages = merged;
    forwardedMessages = merged;
  }

  let peers = vendorPeers(map, picked.provider.id, blocked);
  if (issued.provider) peers = peers.filter((p) => p.id === issued.provider);
  if (!peers.length) {
    throw new GatewayError(503, "provider_blacklisted", `Upstream '${picked.provider.id}' is blacklisted`);
  }
  const startId = await board.takeRoundRobin(picked.provider.baseUrl, peers.map((p) => p.id));
  const ordered = rotateFrom(peers, startId);
  const body = request.method === "GET" ? undefined : JSON.stringify(payload);

  for (let i = 0; i < ordered.length; i++) {
    const account = ordered[i];
    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!HOP.has(key.toLowerCase())) headers.set(key, value);
    });
    headers.set("authorization", `Bearer ${account.apiKey}`);
    if (rest === "messages") headers.set("x-api-key", account.apiKey);
    if (sessionId) {
      headers.set("x-session-id", sessionId);
      headers.set("x-opencode-session", sessionId);
    }
    const more = i < ordered.length - 1;
    if (isGoSubscription(account.baseUrl)) {
      const usage = await fetchJsonSilent(joinUrl(account.baseUrl, "usage"), account.apiKey);
      if (goAllowanceBlocks(usage, picked.model)) {
        if (more) continue;
        throw new GatewayError(
          429,
          "allowance_exhausted",
          "OpenCode Go allowance is exhausted; refused so this request is not billed as extra usage",
        );
      }
    }
    console.log(
      JSON.stringify({
        message: "proxy",
        keyId: issued.id,
        provider: account.id,
        model: picked.model || null,
        path: rest,
        sessionId: sessionId || null,
        messages: forwardedMessages?.length ?? null,
        attempt: i + 1,
        pool: ordered.length,
      }),
    );
    let upstream: Response;
    try {
      upstream = await fetch(joinUrl(account.baseUrl, rest), {
        method: request.method,
        headers,
        body,
      });
    } catch (err) {
      console.error(JSON.stringify({
        message: "upstream_fetch",
        provider: account.id,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (more) continue;
      throw new GatewayError(502, "upstream_error", "Failed to reach upstream provider");
    }
    const action = failoverAction(upstream.status);
    if (action !== "stop" && more) {
      if (action === "ban-next") {
        console.error(JSON.stringify({ message: "upstream_auth", provider: account.id, status: upstream.status }));
        ctx.waitUntil(banUpstream(env.KEYS, account.id, `upstream HTTP ${upstream.status}`, true));
      }
      try { await upstream.body?.cancel(); } catch { /* ignore */ }
      continue;
    }
    if (action === "ban-next") {
      console.error(JSON.stringify({ message: "upstream_auth", provider: account.id, status: upstream.status }));
      ctx.waitUntil(banUpstream(env.KEYS, account.id, `upstream HTTP ${upstream.status}`, true));
      throw new GatewayError(502, "upstream_error", "Upstream provider authentication failed");
    }
    return passthrough(upstream, ctx, {
      sessionId,
      sessionStub,
      prior: forwardedMessages,
      meter: {
        board,
        keyId: issued.id,
        providerId: account.id,
        estimate: estimateTokens(payload ?? rest),
      },
    });
  }
  throw new GatewayError(502, "upstream_error", "Failed to reach upstream provider");
}

async function fetchUpstreamModels(provider: Provider): Promise<string[]> {
  try {
    const res = await fetch(joinUrl(provider.baseUrl, "models"), {
      headers: { authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return parseModelsResponse(await res.json()).filter((id) => modelAllowed(provider, id));
  } catch {
    return [];
  }
}

async function fetchGroupModels(members: Provider[]): Promise<string[]> {
  for (const p of members) {
    const ids = await fetchUpstreamModels(p);
    if (ids.length) return ids;
  }
  return [];
}

async function listModels(providers: Provider[]): Promise<Response> {
  const groups = await Promise.all(
    vendorGroups(providers).map(async (g) => ({ providerId: g.id, models: await fetchGroupModels(g.members) })),
  );
  return Response.json({ object: "list", data: exposeModels(groups) }, { headers: corsHeaders() });
}

async function passthrough(
  upstream: Response,
  ctx: ExecutionContext,
  session: {
    sessionId?: string;
    sessionStub?: DurableObjectStub<ChatSession>;
    prior?: ChatMessage[];
    meter: {
      board: DurableObjectStub<QuotaBoard>;
      keyId: string;
      providerId: string;
      estimate: number;
    };
  },
): Promise<Response> {
  const headers = new Headers(corsHeaders());
  for (const name of ["content-type", "cache-control", "x-request-id"]) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  if (session.sessionId) {
    headers.set("x-session-id", session.sessionId);
    headers.set("x-opencode-session", session.sessionId);
  }

  if (!upstream.body || upstream.status >= 400) {
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  const ct = upstream.headers.get("content-type") || "";
  const stub = session.sessionStub;
  const prior = session.prior;
  const { meter } = session;

  if (ct.includes("text/event-stream")) {
    const [toClient, toParse] = upstream.body.tee();
    ctx.waitUntil(consumeSse(toParse, stub, prior, meter));
    return new Response(toClient, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  return respondJsonAndSave(upstream, headers, stub, prior, meter);
}

async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  stub: DurableObjectStub<ChatSession> | undefined,
  prior: ChatMessage[] | undefined,
  meter: { board: DurableObjectStub<QuotaBoard>; keyId: string; providerId: string; estimate: number },
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const acc: { content: string; tokens?: number } = { content: "" };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) applyChatSseLine(acc, line);
    }
    if (buf) applyChatSseLine(acc, buf);
    if (stub && prior && acc.content) await stub.save([...prior, { role: "assistant", content: acc.content }]);
    const tokens = acc.tokens ?? meter.estimate + Math.ceil(acc.content.length / 4);
    await meter.board.add(meter.keyId, meter.providerId, tokens);
  } catch (err) {
    console.error(JSON.stringify({ message: "session_sse_save", error: err instanceof Error ? err.message : String(err) }));
  }
}

async function respondJsonAndSave(
  upstream: Response,
  headers: Headers,
  stub: DurableObjectStub<ChatSession> | undefined,
  prior: ChatMessage[] | undefined,
  meter: { board: DurableObjectStub<QuotaBoard>; keyId: string; providerId: string; estimate: number },
): Promise<Response> {
  const text = await upstream.text();
  try {
    const json = JSON.parse(text) as unknown;
    if (stub && prior) {
      const assistant = assistantFromChatCompletion(json);
      if (assistant) await stub.save([...prior, assistant]);
    }
    await meter.board.add(meter.keyId, meter.providerId, tokensFromUsage(json) ?? meter.estimate);
  } catch (err) {
    console.error(JSON.stringify({ message: "session_json_save", error: err instanceof Error ? err.message : String(err) }));
    try {
      await meter.board.add(meter.keyId, meter.providerId, meter.estimate);
    } catch {
      /* ignore meter failure */
    }
  }
  return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers });
}
