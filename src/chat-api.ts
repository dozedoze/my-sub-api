import { lookupById, lookupByUsername } from "./keys.ts";
import {
  CHAT_SESSION_COOKIE,
  chatSessionClearCookie,
  chatSessionSetCookie,
  corsHeaders,
  GatewayError,
  hashPassword,
  mintChatSession,
  readCookie,
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

  if (request.method === "POST" && path === "/chat/api/login") {
    const token = env.ADMIN_TOKEN?.trim();
    if (!token) throw new GatewayError(503, "admin_unconfigured", "ADMIN_TOKEN is not set");
    const body = (await request.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const rec = await lookupByUsername(env.KEYS, username);
    const salt = rec?.passwordSalt || DUMMY_SALT;
    const hash = rec?.passwordHash || (await dummyPasswordHash());
    const ok = password ? await verifyPassword(password, salt, hash) : false;
    if (!rec?.enabled || !rec.username || !rec.passwordHash || !ok) {
      throw new GatewayError(401, "unauthorized", LOGIN_FAIL);
    }
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
