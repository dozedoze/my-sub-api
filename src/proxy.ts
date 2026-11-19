import {
  chatErrorToAnthropic,
  chatSseToAnthropic,
  chatToMessage,
  chatToolChoiceAny,
  messagesTarget,
  messagesToChat,
  messagesToResponses,
  messagesWire,
  prepareAnthropic,
  responsesSseToAnthropic,
  responsesToMessage,
  type MessagesWire,
} from "./anthropic";
import { currentAuto, isAutoModel, planAuto } from "./auto";
import { quotaBoard, type ChatSession, type QuotaBoard } from "./durable";
import { banUpstream, loadUpstreamBans, lookupByPlaintext } from "./keys";
import {
  applyChatSseLine,
  applyUpstreamSticky,
  assistantFromChatCompletion,
  anthropicModelCard,
  claudeDiscoveryModels,
  corsHeaders,
  defaultQuotaTokens,
  effectiveQuota,
  estimateTokens,
  exposeAutoModel,
  exposeModels,
  matchListedModel,
  extractToken,
  failoverAction,
  GatewayError,
  goAllowanceBlocks,
  isGoSubscription,
  joinUrl,
  loadProviders,
  looksLikeFullHistory,
  mergeSessionMessages,
  modelAllowed,
  modelFallback,
  parseJsonObject,
  pickUpstream,
  resolveSessionId,
  rotateFrom,
  stickyAccountId,
  tokensFromUsage,
  vendorGroups,
  vendorPeers,
  type ChatMessage,
  type Provider,
} from "./lib";
import { fetchJsonSilent, fetchUpstreamModels } from "./upstream";

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

export async function proxy(request: Request, env: Env, ctx: ExecutionContext, rest: string): Promise<Response> {
  const token = extractToken(request);
  if (!token) throw new GatewayError(401, "invalid_api_key", "Missing API key");
  const issued = await lookupByPlaintext(env.KEYS, token);
  if (!issued) throw new GatewayError(401, "invalid_api_key", "Invalid API key");

  const { live } = loadProviders(env);
  const map = new Map(live.map((p) => [p.id, p]));
  const [bans, picked] = await Promise.all([loadUpstreamBans(env.KEYS), currentAuto(env.KEYS)]);
  const blocked = new Set(Object.keys(bans));
  const aliases = parseJsonObject(env.MODEL_ALIASES);
  const autoRoute = picked.route;
  const defaultProvider = live[0]?.id ?? "";

  if ((rest === "models" || rest.startsWith("models/")) && request.method === "GET") {
    if (issued.provider && blocked.has(issued.provider)) {
      throw new GatewayError(503, "provider_blacklisted", `Upstream '${issued.provider}' is blacklisted`);
    }
    const targets = (issued.provider ? [map.get(issued.provider)] : live).filter(
      (p): p is Provider => p != null && !blocked.has(p.id),
    );
    return listModels(targets, Boolean(autoRoute), request, rest);
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
  if (rest === "messages/count_tokens") {
    return Response.json({ input_tokens: estimateTokens(payload) }, { headers: corsHeaders() });
  }

  const conversational =
    rest === "chat/completions" || rest === "completions" || rest === "responses" || rest === "messages";
  let sessionId: string | undefined;
  let sessionStub: DurableObjectStub<ChatSession> | undefined;
  let forwardedMessages: ChatMessage[] | undefined;
  if (conversational) {
    sessionId = resolveSessionId({
      header: (name) => request.headers.get(name),
      payload: payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null,
      keyId: issued.id,
    });
  }
  if (
    sessionId &&
    rest === "chat/completions" &&
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { messages?: unknown }).messages)
  ) {
    const incoming = (payload as { messages: ChatMessage[] }).messages;
    sessionStub = env.SESSIONS.get(env.SESSIONS.idFromName(`${issued.id}:${sessionId}`));
    const merged = looksLikeFullHistory(incoming)
      ? incoming
      : mergeSessionMessages(await sessionStub.load(), incoming);
    (payload as { messages: ChatMessage[] }).messages = merged;
    forwardedMessages = merged;
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

  let autoTierName: "easy" | "hard" | undefined;
  let autoVia: "pin" | "hint" | "model" | "fallback" | undefined;
  let modelChain: string[] | undefined;
  let pinnedHard: string | null = null;
  if (isAutoModel(model)) {
    const plan = await planAuto({
      rest,
      route: autoRoute,
      messages: forwardedMessages ?? [],
      session: sessionStub,
      providers: map,
      blocked,
      aliases,
      keyProvider: issued.provider,
      defaultProvider,
      charge: (providerId, tokens) => board.add(issued.id, providerId, tokens),
    });
    autoTierName = plan.tier;
    autoVia = plan.via;
    modelChain = plan.chain;
    if (plan.tier === "hard" && sessionStub) pinnedHard = await sessionStub.loadAutoModel();
  }

  if (rest === "chat/completions" && payload && typeof payload === "object") {
    const p = payload as { stream?: unknown; stream_options?: Record<string, unknown> };
    if (p.stream === true) {
      p.stream_options = { ...p.stream_options, include_usage: true };
    }
  }

  const specs = modelChain ?? [model];
  let lastFailure: GatewayError | null = null;
  targets: for (let s = 0; s < specs.length; s++) {
    const spec = specs[s];
    const moreModels = modelChain != null && s < specs.length - 1;
    let picked;
    try {
      picked = pickUpstream({
        requestedModel: spec,
        aliases,
        keyProvider: issued.provider,
        defaultProvider,
        providers: map,
        blocked,
      });
    } catch (err) {
      if (moreModels && err instanceof GatewayError) {
        lastFailure = err;
        continue;
      }
      throw err;
    }
    if (payload && typeof payload === "object" && picked.model) {
      (payload as { model: string }).model = picked.model;
    }
    // 下游直连仍走 modelAllowed。auto 档位是管理员选的，可以用上游有、但没开放给下游的模型。
    if (modelChain == null && picked.model && !modelAllowed(picked.provider, picked.model)) {
      if (moreModels) {
        lastFailure = new GatewayError(400, "model_not_allowed", `Model '${picked.model}' is not enabled on this upstream`);
        continue;
      }
      throw new GatewayError(400, "model_not_allowed", `Model '${picked.model}' is not enabled on this upstream`);
    }

    let peers = vendorPeers(map, picked.provider.id, blocked);
    if (issued.provider) peers = peers.filter((p) => p.id === issued.provider);
    if (!peers.length) {
      if (moreModels) {
        lastFailure = new GatewayError(503, "provider_blacklisted", `Upstream '${picked.provider.id}' is blacklisted`);
        continue;
      }
      throw new GatewayError(503, "provider_blacklisted", `Upstream '${picked.provider.id}' is blacklisted`);
    }
    const peerIds = peers.map((p) => p.id);
    const startId = sessionId
      ? stickyAccountId(peerIds, sessionId)
      : await board.takeRoundRobin(picked.provider.baseUrl, peerIds);
    const ordered = rotateFrom(peers, startId);

    for (let i = 0; i < ordered.length; i++) {
      const account = ordered[i];
      const bodyRec = payload != null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
      const wire: MessagesWire | null = rest === "messages" && bodyRec ? messagesWire(account.baseUrl, picked.model) : null;
      const target = wire ? messagesTarget(account.baseUrl, wire) : null;
      let outbound: unknown = payload;
      if (wire === "chat" && bodyRec) outbound = messagesToChat(bodyRec, chatToolChoiceAny(account.baseUrl));
      else if (wire === "responses" && bodyRec) outbound = messagesToResponses(bodyRec);
      else if (wire === "anthropic" && bodyRec && target && target.baseUrl !== account.baseUrl) {
        outbound = prepareAnthropic(account.baseUrl, bodyRec);
      }
      const upstreamBase = target?.baseUrl ?? account.baseUrl;
      const upstreamRest = target?.rest ?? rest;
      const headers = new Headers();
      request.headers.forEach((value, key) => {
        if (!HOP.has(key.toLowerCase())) headers.set(key, value);
      });
      headers.set("authorization", `Bearer ${account.apiKey}`);
      if (rest === "messages" && wire !== "chat" && wire !== "responses") headers.set("x-api-key", account.apiKey);
      if (wire === "chat" || wire === "responses") {
        headers.delete("anthropic-version");
        headers.delete("anthropic-beta");
      }
      applyUpstreamSticky(headers, outbound, account.baseUrl, sessionId, upstreamRest);
      const body = request.method === "GET" ? undefined : JSON.stringify(outbound);
      const more = i < ordered.length - 1;
      if (isGoSubscription(account.baseUrl)) {
        const usage = await fetchJsonSilent(joinUrl(account.baseUrl, "usage"), account.apiKey);
        if (goAllowanceBlocks(usage, picked.model)) {
          if (more) continue;
          const exhausted = new GatewayError(
            429,
            "allowance_exhausted",
            "OpenCode Go allowance is exhausted; refused so this request is not billed as extra usage",
          );
          if (moreModels) {
            lastFailure = exhausted;
            continue targets;
          }
          throw exhausted;
        }
      }
      console.log(
        JSON.stringify({
          message: "proxy",
          keyId: issued.id,
          provider: account.id,
          model: picked.model || null,
          auto: autoTierName || null,
          autoVia: autoVia || null,
          path: rest,
          via: wire ?? undefined,
          sessionId: sessionId || null,
          messages: forwardedMessages?.length ?? null,
          attempt: i + 1,
          pool: ordered.length,
          modelTry: s + 1,
        }),
      );
      let upstream: Response;
      try {
        upstream = await fetch(joinUrl(upstreamBase, upstreamRest), {
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
        const failed = new GatewayError(502, "upstream_error", "Failed to reach upstream provider");
        if (moreModels) {
          lastFailure = failed;
          continue targets;
        }
        throw failed;
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
        try { await upstream.body?.cancel(); } catch { /* ignore */ }
        if (moreModels) {
          lastFailure = new GatewayError(502, "upstream_error", "Upstream provider authentication failed");
          continue targets;
        }
        throw new GatewayError(502, "upstream_error", "Upstream provider authentication failed");
      }
      if (moreModels && modelFallback(upstream.status)) {
        try { await upstream.body?.cancel(); } catch { /* ignore */ }
        lastFailure = new GatewayError(upstream.status, "upstream_error", `Upstream '${picked.provider.id}' rejected model '${picked.model}'`);
        continue targets;
      }
      if (autoTierName === "hard" && sessionStub && spec && upstream.status < 400 && spec !== pinnedHard) {
        await sessionStub.saveAutoModel(spec);
      }
      const handed = {
        sessionId,
        sessionStub,
        autoTier: autoTierName,
        prior: forwardedMessages,
        meter: {
          board,
          keyId: issued.id,
          providerId: account.id,
          model: picked.model,
          estimate: estimateTokens(payload ?? rest),
        },
      };
      if (wire === "chat" || wire === "responses") return anthropicFromChat(upstream, ctx, handed, wire);
      return passthrough(upstream, ctx, handed);
    }
  }
  throw lastFailure ?? new GatewayError(502, "upstream_error", "Failed to reach upstream provider");
}

async function fetchGroupModels(members: Provider[]): Promise<string[]> {
  for (const p of members) {
    const ids = (await fetchUpstreamModels(p)).filter((id) => modelAllowed(p, id));
    if (ids.length) return ids;
  }
  return [];
}

async function listModels(
  providers: Provider[],
  includeAuto: boolean,
  request: Request,
  rest: string,
): Promise<Response> {
  const groups = await Promise.all(
    vendorGroups(providers).map(async (g) => ({ providerId: g.id, models: await fetchGroupModels(g.members) })),
  );
  const listed = includeAuto ? exposeAutoModel(exposeModels(groups)) : exposeModels(groups);
  if (rest.startsWith("models/")) {
    const want = decodeURIComponent(rest.slice("models/".length));
    const found = matchListedModel(listed, want);
    if (!found) throw new GatewayError(404, "not_found", `Model '${want}' not found`);
    return Response.json(anthropicModelCard(found, want), { headers: corsHeaders() });
  }
  const data = request.headers.has("anthropic-version") ? claudeDiscoveryModels(listed) : listed;
  return Response.json({ object: "list", data }, { headers: corsHeaders() });
}

type Handed = {
  sessionId?: string;
  sessionStub?: DurableObjectStub<ChatSession>;
  autoTier?: "easy" | "hard";
  prior?: ChatMessage[];
  meter: {
    board: DurableObjectStub<QuotaBoard>;
    keyId: string;
    providerId: string;
    model: string;
    estimate: number;
  };
};

function clientHeaders(upstream: Response | null, session: Handed): Headers {
  const headers = new Headers(corsHeaders());
  if (upstream) {
    for (const name of ["content-type", "cache-control", "x-request-id"]) {
      const v = upstream.headers.get(name);
      if (v) headers.set(name, v);
    }
  }
  if (session.sessionId) {
    headers.set("x-session-id", session.sessionId);
    headers.set("x-opencode-session", session.sessionId);
  }
  if (session.autoTier) headers.set("x-auto-tier", session.autoTier);
  return headers;
}

async function anthropicFromChat(
  upstream: Response,
  ctx: ExecutionContext,
  session: Handed,
  wire: "chat" | "responses",
): Promise<Response> {
  if (!upstream.body || upstream.status >= 400) {
    const text = upstream.body ? await upstream.text() : "";
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        /* keep text */
      }
    }
    const headers = clientHeaders(null, session);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(chatErrorToAnthropic(upstream.status || 502, parsed)), {
      status: upstream.status || 502,
      headers,
    });
  }

  const headers = clientHeaders(upstream, session);
  const ct = upstream.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const [toClient, toParse] = upstream.body.tee();
    ctx.waitUntil(consumeSse(toParse, session.sessionStub, session.prior, session.meter));
    headers.set("content-type", "text/event-stream; charset=utf-8");
    headers.set("cache-control", "no-cache");
    return new Response((wire === "responses" ? responsesSseToAnthropic : chatSseToAnthropic)(toClient, session.meter.model), {
      status: upstream.status,
      headers,
    });
  }

  const text = await upstream.text();
  const { meter } = session;
  try {
    const json = JSON.parse(text) as unknown;
    if (session.sessionStub && session.prior) {
      const assistant = assistantFromChatCompletion(json);
      if (assistant) await session.sessionStub.save([...session.prior, assistant]);
    }
    await meter.board.add(meter.keyId, meter.providerId, tokensFromUsage(json) ?? meter.estimate, meter.model);
    const translated = wire === "responses" ? responsesToMessage(json, meter.model) : chatToMessage(json, meter.model);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(translated), { status: upstream.status, headers });
  } catch (err) {
    console.error(JSON.stringify({ message: "anthropic_json", error: err instanceof Error ? err.message : String(err) }));
    try {
      await meter.board.add(meter.keyId, meter.providerId, meter.estimate, meter.model);
    } catch {
      /* ignore meter failure */
    }
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(chatErrorToAnthropic(502, "Bad upstream response")), { status: 502, headers });
  }
}

async function passthrough(upstream: Response, ctx: ExecutionContext, session: Handed): Promise<Response> {
  const headers = clientHeaders(upstream, session);

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
  meter: { board: DurableObjectStub<QuotaBoard>; keyId: string; providerId: string; model: string; estimate: number },
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
    await meter.board.add(meter.keyId, meter.providerId, tokens, meter.model);
  } catch (err) {
    console.error(JSON.stringify({ message: "session_sse_save", error: err instanceof Error ? err.message : String(err) }));
  }
}

async function respondJsonAndSave(
  upstream: Response,
  headers: Headers,
  stub: DurableObjectStub<ChatSession> | undefined,
  prior: ChatMessage[] | undefined,
  meter: { board: DurableObjectStub<QuotaBoard>; keyId: string; providerId: string; model: string; estimate: number },
): Promise<Response> {
  const text = await upstream.text();
  try {
    const json = JSON.parse(text) as unknown;
    if (stub && prior) {
      const assistant = assistantFromChatCompletion(json);
      if (assistant) await stub.save([...prior, assistant]);
    }
    await meter.board.add(meter.keyId, meter.providerId, tokensFromUsage(json) ?? meter.estimate, meter.model);
  } catch (err) {
    console.error(JSON.stringify({ message: "session_json_save", error: err instanceof Error ? err.message : String(err) }));
    try {
      await meter.board.add(meter.keyId, meter.providerId, meter.estimate, meter.model);
    } catch {
      /* ignore meter failure */
    }
  }
  return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers });
}
