import { quotaBoard } from "./durable.ts";
import { lookupById, lookupByUsername } from "./keys.ts";
import {
  CHAT_SESSION_COOKIE,
  chatSessionClearCookie,
  chatSessionSetCookie,
  clientIp,
  corsHeaders,
  defaultQuotaTokens,
  effectiveQuota,
  GATE,
  GatewayError,
  hashPassword,
  loginRetryAfter,
  mintChatSession,
  readCookie,
  throwIfAdmitFailed,
  verifyChatSession,
  verifyPassword,
} from "./lib.ts";

const DUMMY_SALT = "00".repeat(16);

let dummyHash: string | undefined;

async function dummyPasswordHash(): Promise<string> {
  dummyHash ??= (await hashPassword("invalid-login-dummy", DUMMY_SALT)).hash;
  return dummyHash;
}

const LOGIN_FAIL = "Invalid username or password";

function usageView(
  usedTokens: number,
  quotaTokens: number,
  requestCount: number,
): {
  usedTokens: number;
  quotaTokens: number;
  remainingTokens: number | null;
  requestCount: number;
  percent: number | null;
} {
  const remainingTokens = quotaTokens === 0 ? null : Math.max(0, quotaTokens - usedTokens);
  const percent = quotaTokens === 0 ? null : Math.min(100, Math.round((usedTokens / quotaTokens) * 1000) / 10);
  return { usedTokens, quotaTokens, remainingTokens, requestCount, percent };
}

export async function chatApi(request: Request, env: Env, path: string): Promise<Response> {
  const headers = { ...corsHeaders(request), "content-type": "application/json" };

  if (request.method === "POST" && path === "/chat/api/logout") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...headers, "set-cookie": chatSessionClearCookie(request.url) },
    });
  }

  if (request.method === "GET" && path === "/chat/api/me") {
    const rec = await sessionUser(request, env);
    if (!rec) throw new GatewayError(401, "unauthorized", "Not signed in");
    return Response.json({ ok: true, username: rec.username, name: rec.name }, { headers });
  }

  if (request.method === "GET" && path === "/chat/api/usage") {
    const rec = await sessionUser(request, env);
    if (!rec) throw new GatewayError(401, "unauthorized", "Not signed in");
    const fallback = defaultQuotaTokens(env.DEFAULT_QUOTA_TOKENS);
    const quotaTokens = effectiveQuota(rec, fallback);
    const meter = await quotaBoard(env).peek(rec.id);
    return Response.json(
      {
        ok: true,
        ...usageView(meter.used ?? 0, quotaTokens, meter.requests ?? 0),
        recent: meter.recent ?? [],
      },
      { headers },
    );
  }

  if (request.method === "POST" && path === "/chat/api/login") {
    const token = env.ADMIN_TOKEN?.trim();
    if (!token) throw new GatewayError(503, "admin_unconfigured", "ADMIN_TOKEN is not set");
    const board = quotaBoard(env);
    const gateId = `login:${clientIp(request)}`;
    const locked = loginRetryAfter(await board.peek(gateId), Date.now());
    if (locked != null) {
      throw new GatewayError(429, "rate_limited", `Too many login attempts. Try again in ${locked} seconds`, locked);
    }
    throwIfAdmitFailed(
      await board.admit(gateId, {
        quota: 0,
        maxRpm: GATE.loginRpm,
        maxInflight: GATE.keyInflight,
        takeInflight: false,
      }),
    );
    const body = (await request.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const rec = await lookupByUsername(env.KEYS, username);
    const salt = rec?.passwordSalt || DUMMY_SALT;
    const hash = rec?.passwordHash || (await dummyPasswordHash());
    const ok = password ? await verifyPassword(password, salt, hash) : false;
    if (!rec?.enabled || !rec.username || !rec.passwordHash || !ok) {
      const next = await board.noteLoginFail(gateId);
      const retry = loginRetryAfter(next, Date.now());
      if (retry != null) {
        throw new GatewayError(429, "rate_limited", `Too many login attempts. Try again in ${retry} seconds`, retry);
      }
      throw new GatewayError(401, "unauthorized", LOGIN_FAIL);
    }
    await board.noteLoginOk(gateId);
    const cookie = chatSessionSetCookie(await mintChatSession(token, rec.id), request.url);
    return new Response(JSON.stringify({ ok: true, username: rec.username }), {
      headers: { ...headers, "set-cookie": cookie },
    });
  }

  throw new GatewayError(404, "not_found", "Not found");
}

export async function sessionUser(request: Request, env: Env): Promise<Awaited<ReturnType<typeof lookupById>>> {
  const token = env.ADMIN_TOKEN?.trim();
  if (!token) return null;
  const cookie = readCookie(request.headers.get("cookie"), CHAT_SESSION_COOKIE);
  if (!cookie) return null;
  const keyId = await verifyChatSession(token, cookie);
  if (!keyId) return null;
  return lookupById(env.KEYS, keyId);
}
