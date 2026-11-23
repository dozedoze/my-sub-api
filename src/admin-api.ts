import { describeUserConfig } from "./admin-users.ts";
import { currentAuto, parseAutoRoute, type AutoRoute } from "./auto";
import { quotaBoard, userConfig } from "./durable";
import { parseMcpPolicy } from "./net-guard.ts";
import { loadPublicSkill, parsePublicSkill, publicSkillView, savePublicSkill } from "./public-skill.ts";
import { secretsConfigured } from "./secrets.ts";
import {
  banUpstream,
  clearAutoModels,
  createIssuedKey,
  deleteIssuedKey,
  HOSTED_SKILL_IDS,
  listIssuedKeys,
  loadMcpPolicy,
  loadSkills,
  loadUpstreamBans,
  parseSkillsConfig,
  patchIssuedKey,
  resetIssuedPassword,
  saveAutoModels,
  saveMcpPolicy,
  saveSkills,
  unbanUpstream,
} from "./keys";
import { searchConfigured } from "./skills";
import {
  ADMIN_SESSION_COOKIE,
  attachUsage,
  corsHeaders,
  defaultQuotaTokens,
  extractToken,
  GatewayError,
  loadProviders,
  modelAllowed,
  parseQuotaInput,
  parseUsername,
  readCookie,
  timingSafeEqualString,
  verifyAdminSession,
} from "./lib";
import { fetchUpstreamModels, probeUpstream } from "./upstream";

/** 每个用户一次 Durable Object 调用，一次请求的子请求数有上限，所以只看前 N 个。 */
const USERS_CONFIG_MAX = 100;

/** @returns true if auth was the raw ADMIN_TOKEN (mint a session cookie). */
export async function requireAdmin(request: Request, env: Env): Promise<boolean> {
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

function readAutoInput(body: unknown): AutoRoute {
  let route: AutoRoute | null;
  try {
    route = parseAutoRoute(body);
  } catch (err) {
    if (err instanceof GatewayError) throw new GatewayError(400, "invalid_request", "简单档和复杂档都需要填写");
    throw err;
  }
  if (!route) throw new GatewayError(400, "invalid_request", "简单档和复杂档都需要填写");
  return route;
}

export async function adminApi(request: Request, env: Env, path: string): Promise<Response> {
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
            catalog: [] as string[],
            blacklist,
          };
        }
        const [upstream, catalog] = await Promise.all([probeUpstream(configured), fetchUpstreamModels(configured)]);
        const models = catalog.filter((id) => modelAllowed(configured, id));
        return { ...p, localUsedTokens: meter.used, localRequests: meter.requests, upstream, models, catalog, blacklist };
      }),
    );
    const picked = await currentAuto(env.KEYS);
    return Response.json(
      {
        providers,
        defaultProvider: live[0]?.id,
        defaultQuotaTokens: fallbackQuota,
        auto: picked.route,
        autoSaved: picked.saved,
        skills: await loadSkills(env.KEYS),
        skillsCatalog: [...HOSTED_SKILL_IDS],
        searchConfigured: searchConfigured(env),
        mcpPolicy: { ...(await loadMcpPolicy(env.KEYS)), secretsConfigured: secretsConfigured(env) },
        publicSkill: publicSkillView(await loadPublicSkill(env.KEYS)),
      },
      { headers: corsHeaders(request) },
    );
  }

  if (request.method === "GET" && path === "/admin/api/keys") {
    const meters = await board.snapshot();
    return Response.json(
      { keys: attachUsage(await listIssuedKeys(env.KEYS), meters.keys, fallbackQuota) },
      { headers: corsHeaders(request) },
    );
  }

  if (request.method === "POST" && path === "/admin/api/keys") {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      provider?: string;
      quotaTokens?: unknown;
      username?: unknown;
      password?: unknown;
    };
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
      username: parseUsername(body.username),
      password: typeof body.password === "string" ? body.password : undefined,
    });
    return Response.json(
      { key: created.plaintext, password: created.password, ...created.record },
      { headers: corsHeaders(request) },
    );
  }

  const one = path.match(/^\/admin\/api\/keys\/([^/]+)$/);
  if (one) {
    const id = decodeURIComponent(one[1]);
    if (request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        enabled?: boolean;
        quotaTokens?: unknown;
        resetPassword?: boolean;
        password?: string;
      };
      if (body.resetPassword) {
        const reset = await resetIssuedPassword(env.KEYS, id, typeof body.password === "string" ? body.password : undefined);
        if (!reset) throw new GatewayError(404, "not_found", "Key not found");
        return Response.json({ password: reset.password, ...reset.record }, { headers: corsHeaders(request) });
      }
      const patch: { enabled?: boolean; quotaTokens?: number } = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (body.quotaTokens !== undefined) patch.quotaTokens = parseQuotaInput(body.quotaTokens, fallbackQuota);
      if (patch.enabled === undefined && patch.quotaTokens === undefined) {
        throw new GatewayError(400, "invalid_request", "enabled or quotaTokens required");
      }
      const rec = await patchIssuedKey(env.KEYS, id, patch);
      if (!rec) throw new GatewayError(404, "not_found", "Key not found");
      return Response.json(rec, { headers: corsHeaders(request) });
    }
    if (request.method === "DELETE") {
      const ok = await deleteIssuedKey(env.KEYS, id);
      if (!ok) throw new GatewayError(404, "not_found", "Key not found");
      await board.reset(id);
      // 用户删了，他的 MCP 配置和加密密钥一并清掉。
      await userConfig(env, id).clearAll();
      return Response.json({ deleted: true }, { headers: corsHeaders(request) });
    }
  }

  // 每个前台用户自己配的 MCP / Skill。只有带用户名的账号能登录聊天页，所以只看这些。
  if (request.method === "GET" && path === "/admin/api/users-config") {
    const chatKeys = (await listIssuedKeys(env.KEYS)).filter((k) => k.username);
    const shown = chatKeys.slice(0, USERS_CONFIG_MAX);
    const users = await Promise.all(
      shown.map(async (k) => {
        const who = { id: k.id, name: k.name, username: k.username, enabled: k.enabled };
        try {
          const view = await userConfig(env, k.id).getAdminView();
          return { ...who, config: describeUserConfig(view.doc, view.secretNames, view.status) };
        } catch {
          return { ...who, config: null };
        }
      }),
    );
    return Response.json(
      { users, total: chatKeys.length, truncated: chatKeys.length > shown.length },
      { headers: { ...corsHeaders(request), "cache-control": "no-store" } },
    );
  }

  if (path === "/admin/api/skills") {
    if (request.method === "GET") {
      return Response.json(
        { ...await loadSkills(env.KEYS), catalog: [...HOSTED_SKILL_IDS], searchConfigured: searchConfigured(env) },
        { headers: corsHeaders(request) },
      );
    }
    if (request.method === "PUT" || request.method === "POST") {
      const body = await request.json().catch(() => null);
      const config = parseSkillsConfig(body);
      await saveSkills(env.KEYS, config);
      return Response.json({ ...config, saved: true, searchConfigured: searchConfigured(env) }, { headers: corsHeaders(request) });
    }
  }

  if (path === "/admin/api/public-skill") {
    if (request.method === "GET") {
      return Response.json(publicSkillView(await loadPublicSkill(env.KEYS)), { headers: corsHeaders(request) });
    }
    if (request.method === "PUT" || request.method === "POST") {
      const config = parsePublicSkill(await request.json().catch(() => null));
      await savePublicSkill(env.KEYS, config);
      return Response.json({ ...publicSkillView(config), saved: true }, { headers: corsHeaders(request) });
    }
  }

  if (path === "/admin/api/mcp-policy") {
    if (request.method === "GET") {
      return Response.json(
        { ...(await loadMcpPolicy(env.KEYS)), secretsConfigured: secretsConfigured(env) },
        { headers: corsHeaders(request) },
      );
    }
    if (request.method === "PUT" || request.method === "POST") {
      const policy = parseMcpPolicy(await request.json().catch(() => null));
      await saveMcpPolicy(env.KEYS, policy);
      return Response.json({ ...policy, saved: true, secretsConfigured: secretsConfigured(env) }, { headers: corsHeaders(request) });
    }
  }

  if (path === "/admin/api/auto") {
    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      const route = readAutoInput(body);
      await saveAutoModels(env.KEYS, route);
      return Response.json({ ...route, saved: true }, { headers: corsHeaders(request) });
    }
    if (request.method === "DELETE") {
      await clearAutoModels(env.KEYS);
      return Response.json({ saved: false }, { headers: corsHeaders(request) });
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
      return Response.json(hit, { headers: corsHeaders(request) });
    }
    if (request.method === "DELETE") {
      await unbanUpstream(env.KEYS, id);
      return Response.json({ deleted: true }, { headers: corsHeaders(request) });
    }
  }

  throw new GatewayError(404, "not_found", "Not found");
}
