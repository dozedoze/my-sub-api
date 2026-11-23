import {
  bytesToBase64,
  chatErrorToAnthropic,
  chatSseToAnthropic,
  chatToMessage,
  chatToolChoiceAny,
  collectFileIds,
  DEEPSEEK_ANTHROPIC,
  inlineFileIds,
  messagesTarget,
  messagesToChat,
  messagesToResponses,
  messagesWire,
  prepareAnthropic,
  responsesSseToAnthropic,
  responsesToMessage,
  type InlinedFile,
  type MessagesWire,
} from "./anthropic";
import { currentAuto, isAutoModel, planAuto, type AutoVia } from "./auto";
import {
  shapeAnthropicThinking,
  shapeResponsesThinking,
  thinkingIntent,
  thinkingMode,
  type ThinkingMode,
} from "./thinking";
import { quotaBoard, type ChatSession, type QuotaBoard } from "./durable";
import { sessionUser } from "./chat-api";
import { banUpstream, loadUpstreamBans, lookupByPlaintext } from "./keys";
import {
  applyChatSseLine,
  applyUpstreamSticky,
  assistantFromChatCompletion,
  anthropicModelCard,
  bodyTooLarge,
  chargeEstimate,
  clampGeneration,
  claudeDiscoveryModels,
  clientIp,
  corsHeaders,
  defaultQuotaTokens,
  effectiveQuota,
  estimateTokens,
  exposeAutoModel,
  exposeModels,
  matchListedModel,
  extractToken,
  failoverAction,
  GATE,
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
  throwIfAdmitFailed,
  tokensFromUsage,
  vendorGroups,
  vendorPeers,
  type ChatMessage,
  type Provider,
} from "./lib";
import { fetchJsonSilent, fetchUpstreamCatalog } from "./upstream";

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

async function rejectAnon(board: DurableObjectStub<QuotaBoard>, ip: string, message: string): Promise<never> {
  throwIfAdmitFailed(
    await board.admit(`anon:${ip}`, {
      quota: 0,
      maxRpm: GATE.anonRpm,
      maxInflight: GATE.keyInflight,
      takeInflight: false,
    }),
  );
  throw new GatewayError(401, "invalid_api_key", message);
}

export async function proxy(request: Request, env: Env, ctx: ExecutionContext, rest: string): Promise<Response> {
  const board = quotaBoard(env);
  const ip = clientIp(request);
  const token = extractToken(request);
  const found = token ? await lookupByPlaintext(env.KEYS, token) : await sessionUser(request, env);
  if (!found) {
    await rejectAnon(board, ip, token ? "Invalid API key" : "Missing API key");
  }
  const issued = found as NonNullable<typeof found>;

  const { live } = loadProviders(env);
  const map = new Map(live.map((p) => [p.id, p]));
  const [bans, picked] = await Promise.all([loadUpstreamBans(env.KEYS), currentAuto(env.KEYS)]);
  const blocked = new Set(Object.keys(bans));
  const aliases = parseJsonObject(env.MODEL_ALIASES);
  const autoRoute = picked.route;
  const defaultProvider = live[0]?.id ?? "";
  const fallbackQuota = defaultQuotaTokens(env.DEFAULT_QUOTA_TOKENS);
  const quota = effectiveQuota(issued, fallbackQuota);
  throwIfAdmitFailed(
    await board.admit(issued.id, {
      quota: request.method === "GET" ? 0 : quota,
      maxRpm: GATE.keyRpm,
      maxInflight: GATE.keyInflight,
      takeInflight: true,
    }),
  );
  const hold = { inflight: true };
  try {
    return await proxyAfterGate(request, env, ctx, rest, {
      issued,
      live,
      map,
      blocked,
      aliases,
      autoRoute,
      defaultProvider,
      board,
      hold,
    });
  } finally {
    if (hold.inflight) {
      try {
        await board.release(issued.id);
      } catch {
        /* ignore */
      }
    }
  }
}

type Issued = Awaited<ReturnType<typeof lookupByPlaintext>>;

async function proxyAfterGate(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  rest: string,
  ctxp: {
    issued: NonNullable<Issued>;
    live: Provider[];
    map: Map<string, Provider>;
    blocked: Set<string>;
    aliases: Record<string, string>;
    autoRoute: Awaited<ReturnType<typeof currentAuto>>["route"];
    defaultProvider: string;
    board: DurableObjectStub<QuotaBoard>;
    hold: { inflight: boolean };
  },
): Promise<Response> {
  const { issued, live, map, blocked, aliases, autoRoute, defaultProvider, board, hold } = ctxp;
  const fileCache = new Map<string, InlinedFile>();

  if (isRawRest(rest)) {
    return rawUpstream(request, env, rest, { issued, live, map, blocked, board, hold });
  }

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
    if (bodyTooLarge(request, undefined)) {
      throw new GatewayError(413, "invalid_request", "Request body too large");
    }
    payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      throw new GatewayError(400, "invalid_request", "Invalid JSON body");
    }
    if (bodyTooLarge(request, payload)) {
      throw new GatewayError(413, "invalid_request", "Request body too large");
    }
    clampGeneration(payload);
    if ("model" in payload && typeof payload.model === "string") model = payload.model;
  }
  if (rest === "messages/count_tokens") {
    return Response.json({ input_tokens: estimateTokens(payload) }, { headers: corsHeaders(request) });
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

  let autoMessages = forwardedMessages ?? [];
  if (isAutoModel(model) && rest === "messages" && payload && typeof payload === "object") {
    const incoming = (payload as { messages?: unknown }).messages;
    autoMessages = Array.isArray(incoming) ? (incoming as ChatMessage[]) : [];
    if (sessionId) {
      sessionStub ??= env.SESSIONS.get(env.SESSIONS.idFromName(`${issued.id}:${sessionId}`));
    }
  }

  let autoTierName: "easy" | "hard" | undefined;
  let autoVia: AutoVia | undefined;
  let modelChain: string[] | undefined;
  let pinnedHard: string | null = null;
  if (isAutoModel(model)) {
    const plan = await planAuto({
      rest,
      route: autoRoute,
      messages: autoMessages,
      session: sessionStub,
      providers: map,
      blocked,
      aliases,
      keyProvider: issued.provider,
      defaultProvider,
      thinking: rest === "messages" ? thinkingIntent(payload) : null,
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
      const wire: MessagesWire | null =
        rest === "messages" && bodyRec ? messagesWire(account.baseUrl, picked.model, account.messages) : null;
      const target = wire ? messagesTarget(account.baseUrl, wire) : null;
      let outbound: unknown = payload;
      const ready =
        rest === "messages" && bodyRec && wire
          ? await filesForUpstream(bodyRec, account, live, blocked, fileCache)
          : bodyRec;
      const mode: ThinkingMode = wire ? thinkingMode(picked.model, wire) : "unknown";
      if (wire === "chat" && ready) outbound = messagesToChat(ready, chatToolChoiceAny(account.baseUrl));
      else if (wire === "responses" && ready) {
        outbound = shapeResponsesThinking(
          ready,
          messagesToResponses(ready, account.baseUrl, account.hostedSearch),
          mode,
        );
      } else if (wire === "anthropic" && ready) {
        outbound = prepareAnthropic(account.baseUrl, shapeAnthropicThinking(ready, mode));
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
      const handed: Handed = {
        request,
        sessionId,
        sessionStub,
        autoTier: autoTierName,
        prior: forwardedMessages,
        hold,
        meter: {
          board,
          keyId: issued.id,
          providerId: account.id,
          model: picked.model,
          estimate: chargeEstimate(rest, payload ?? rest),
        },
      };
      if (wire === "chat" || wire === "responses") return anthropicFromChat(upstream, ctx, handed, wire);
      return passthrough(upstream, ctx, handed);
    }
  }
  throw lastFailure ?? new GatewayError(502, "upstream_error", "Failed to reach upstream provider");
}

async function fetchGroupModels(members: Provider[]): Promise<{ models: string[]; windows: Record<string, number> }> {
  for (const p of members) {
    const { ids, windows } = await fetchUpstreamCatalog(p);
    const models = ids.filter((id) => modelAllowed(p, id));
    if (models.length) return { models, windows };
  }
  return { models: [], windows: {} };
}

/** auto 的开关意义是「走复杂档」，所以单独标出来。其余按上游和模型名认。 */
function listedThinking(
  model: { id: string; owned_by: string },
  heads: Map<string, Provider>,
): ThinkingMode | "auto" {
  if (model.id === "auto") return "auto";
  const head = heads.get(model.owned_by);
  if (!head) return "unknown";
  const prefix = `${model.owned_by}/`;
  const bare = model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id;
  return thinkingMode(bare, messagesWire(head.baseUrl, bare, head.messages));
}

async function listModels(
  providers: Provider[],
  includeAuto: boolean,
  request: Request,
  rest: string,
): Promise<Response> {
  const groups = await Promise.all(
    vendorGroups(providers).map(async (g) => ({ providerId: g.id, ...(await fetchGroupModels(g.members)) })),
  );
  const heads = new Map(vendorGroups(providers).map((g) => [g.id, g.members[0]]));
  const listed = (includeAuto ? exposeAutoModel(exposeModels(groups)) : exposeModels(groups)).map((m) => ({
    ...m,
    thinking: listedThinking(m, heads),
  }));
  if (rest.startsWith("models/")) {
    const want = decodeURIComponent(rest.slice("models/".length));
    const found = matchListedModel(listed, want);
    if (!found) throw new GatewayError(404, "not_found", `Model '${want}' not found`);
    return Response.json(anthropicModelCard(found, want), { headers: corsHeaders(request) });
  }
  const data = request.headers.has("anthropic-version") ? claudeDiscoveryModels(listed) : listed;
  return Response.json({ object: "list", data }, { headers: corsHeaders(request) });
}

type Handed = {
  request: Request;
  sessionId?: string;
  sessionStub?: DurableObjectStub<ChatSession>;
  autoTier?: "easy" | "hard";
  prior?: ChatMessage[];
  hold: { inflight: boolean };
  meter: {
    board: DurableObjectStub<QuotaBoard>;
    keyId: string;
    providerId: string;
    model: string;
    estimate: number;
  };
};

function clientHeaders(upstream: Response | null, session: Handed): Headers {
  const headers = new Headers(corsHeaders(session.request));
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
    session.hold.inflight = false;
    ctx.waitUntil(consumeSse(toParse, session.sessionStub, session.prior, session.meter, true));
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
    session.hold.inflight = false;
    ctx.waitUntil(consumeSse(toParse, stub, prior, meter, true));
    return new Response(toClient, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  return respondJsonAndSave(upstream, headers, stub, prior, meter);
}

async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  stub: DurableObjectStub<ChatSession> | undefined,
  prior: ChatMessage[] | undefined,
  meter: { board: DurableObjectStub<QuotaBoard>; keyId: string; providerId: string; model: string; estimate: number },
  release: boolean,
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
    try {
      await meter.board.add(meter.keyId, meter.providerId, meter.estimate, meter.model);
    } catch {
      /* ignore meter failure */
    }
  } finally {
    if (release) {
      try {
        await meter.board.release(meter.keyId);
      } catch {
        /* ignore */
      }
    }
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

function isRawRest(rest: string): boolean {
  return rest === "files" || rest.startsWith("files/") || rest === "tools/asr" || rest === "tools/tts";
}

function isDeepseek(p: Provider): boolean {
  try {
    const host = new URL(p.baseUrl).hostname.toLowerCase();
    return host === "deepseek.com" || host.endsWith(".deepseek.com");
  } catch {
    return false;
  }
}

function deepseekAccount(live: Provider[], blocked: Set<string>): Provider | undefined {
  return live.find((p) => !blocked.has(p.id) && isDeepseek(p));
}

/** DeepSeek 的 Files API 当仓库。非 DS 上游把 file_id 拉成 base64，再走该协议的图片/文档字段。 */
async function filesForUpstream(
  body: Record<string, unknown>,
  account: Provider,
  live: Provider[],
  blocked: Set<string>,
  cache: Map<string, InlinedFile>,
): Promise<Record<string, unknown>> {
  const ids = collectFileIds(body);
  if (!ids.length || isDeepseek(account)) return body;
  const store = deepseekAccount(live, blocked);
  if (!store) {
    throw new GatewayError(
      400,
      "invalid_request",
      "file_id is not supported on this upstream; send base64 image or document sources",
    );
  }
  const missing = ids.filter((id) => !cache.has(id));
  await Promise.all(
    missing.map(async (id) => {
      try {
        const file = await fetchDeepseekFile(store, id);
        if (file) cache.set(id, file);
      } catch {
        /* 拉不到就当缺失，下面统一 400 */
      }
    }),
  );
  const unresolved = ids.filter((id) => !cache.has(id));
  if (unresolved.length) {
    throw new GatewayError(400, "invalid_request", `file_id cannot be used with this model: ${unresolved.join(", ")}`);
  }
  const files = new Map(ids.map((id) => [id, cache.get(id)!]));
  return inlineFileIds(body, files);
}

async function fetchDeepseekFile(account: Provider, fileId: string): Promise<InlinedFile | null> {
  const auth = { authorization: `Bearer ${account.apiKey}`, "x-api-key": account.apiKey };
  const metaRes = await fetch(joinUrl(DEEPSEEK_ANTHROPIC, `files/${encodeURIComponent(fileId)}`), { headers: auth });
  if (!metaRes.ok) return null;
  const meta = (await metaRes.json().catch(() => null)) as {
    mime_type?: unknown;
    filename?: unknown;
    size_bytes?: unknown;
  } | null;
  const size = typeof meta?.size_bytes === "number" ? meta.size_bytes : 0;
  if (size > GATE.maxBodyBytes) return null;
  const contentRes = await fetch(joinUrl(DEEPSEEK_ANTHROPIC, `files/${encodeURIComponent(fileId)}/content`), {
    headers: auth,
  });
  if (!contentRes.ok) return null;
  const bytes = new Uint8Array(await contentRes.arrayBuffer());
  if (bytes.byteLength > GATE.maxBodyBytes) return null;
  const mediaType =
    typeof meta?.mime_type === "string" && meta.mime_type
      ? meta.mime_type
      : contentRes.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  return {
    mediaType,
    data: bytesToBase64(bytes),
    filename: typeof meta?.filename === "string" ? meta.filename : undefined,
  };
}

async function rawUpstream(
  request: Request,
  _env: Env,
  rest: string,
  ctxp: {
    issued: NonNullable<Issued>;
    live: Provider[];
    map: Map<string, Provider>;
    blocked: Set<string>;
    board: DurableObjectStub<QuotaBoard>;
    hold: { inflight: boolean };
  },
): Promise<Response> {
  const { issued, live, map, blocked, board, hold } = ctxp;
  if (issued.provider && blocked.has(issued.provider)) {
    throw new GatewayError(503, "provider_blacklisted", `Upstream '${issued.provider}' is blacklisted`);
  }
  const pool = (issued.provider ? [map.get(issued.provider)] : live).filter(
    (p): p is Provider => p != null && !blocked.has(p.id) && isDeepseek(p),
  );
  const account = pool[0];
  if (!account) throw new GatewayError(400, "invalid_request", "DeepSeek upstream is required for this path");
  if (bodyTooLarge(request, undefined, GATE.maxFileBytes)) {
    throw new GatewayError(413, "invalid_request", "Request body too large");
  }
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("authorization", `Bearer ${account.apiKey}`);
  if (rest === "files" || rest.startsWith("files/")) headers.set("x-api-key", account.apiKey);
  const base = rest.startsWith("tools/") ? account.baseUrl : DEEPSEEK_ANTHROPIC;
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const upstream = await fetch(joinUrl(base, rest), { method: request.method, headers, body });
  hold.inflight = false;
  try {
    await board.add(issued.id, account.id, chargeEstimate(rest, rest), rest);
  } catch {
    /* ignore meter failure */
  }
  try {
    await board.release(issued.id);
  } catch {
    /* ignore */
  }
  const out = new Headers(corsHeaders(request));
  for (const name of ["content-type", "cache-control", "x-request-id"]) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
