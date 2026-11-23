import { quotaBoard, userConfig } from "./durable.ts";
import { loadMcpPolicy } from "./keys.ts";
import {
  bodyTooLarge,
  corsHeaders,
  GATE,
  GatewayError,
  isChatOrigin,
  throwIfAdmitFailed,
  type KeyRecord,
} from "./lib.ts";
import { McpHub, visibleTools } from "./mcp.ts";
import { encryptSecret, secretsConfigured } from "./secrets.ts";
import {
  LIMITS,
  normalizeImport,
  newId,
  parseSecretName,
  parseSecretValue,
  SECRET_REF,
  validateConfig,
  validateServer,
  slugify,
  type McpServerConfig,
} from "./user-config.ts";
import { mcpStore } from "./mcp-store.ts";

const BASE = "/chat/api/config";
const MAX_BODY = 500_000;

function bad(message: string): never {
  throw new GatewayError(400, "invalid_request", message);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") || "").includes("application/json")) {
    bad("Content-Type must be application/json");
  }
  if (bodyTooLarge(request, undefined, MAX_BODY)) throw new GatewayError(413, "invalid_request", "Request body too large");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new GatewayError(413, "invalid_request", "Request body too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    bad("Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) bad("Body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function expectVersion(body: Record<string, unknown>): number {
  if (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 0) {
    bad("version is required; fetch the config first");
  }
  return body.version;
}

function conflict(doc: unknown, headers: HeadersInit): Response {
  return Response.json(
    { error: { code: "version_conflict", message: "The config changed elsewhere; reload and try again" }, current: doc },
    { status: 409, headers },
  );
}

/**
 * 登录用户的 MCP / Skill 配置。只认聊天 cookie；写操作还要求请求来自聊天页的 Origin，
 * 防止别的站点借 cookie 改配置。任何响应都不含密钥值。
 */
export async function userConfigApi(request: Request, env: Env, path: string, user: KeyRecord): Promise<Response> {
  const headers = { ...corsHeaders(request), "content-type": "application/json", "cache-control": "no-store" };
  const sub = path.slice(BASE.length);
  const mutating = request.method !== "GET" && request.method !== "HEAD";
  if (mutating) {
    const origin = request.headers.get("origin")?.trim() || "";
    if (!origin || !isChatOrigin(origin)) throw new GatewayError(403, "forbidden", "Cross-origin writes are not allowed");
  }
  const board = quotaBoard(env);
  throwIfAdmitFailed(
    await board.admit(`config:${user.id}`, {
      quota: 0,
      maxRpm: GATE.configRpm,
      maxInflight: GATE.keyInflight,
      takeInflight: false,
    }),
  );
  const stub = userConfig(env, user.id);
  const policy = await loadMcpPolicy(env.KEYS);
  const selfHost = new URL(request.url).hostname;

  if (sub === "" && request.method === "GET") {
    const [doc, secrets, status] = await Promise.all([stub.getDoc(), stub.listSecretNames(), stub.getStatus()]);
    return Response.json(
      {
        ok: true,
        version: doc.version,
        updatedAt: doc.updatedAt,
        mcpServers: doc.mcpServers,
        skills: doc.skills,
        secrets,
        status,
        secretsEnabled: secretsConfigured(env),
        mcpEnabled: policy.enabled,
        allowDomains: policy.allowDomains,
        limits: LIMITS,
      },
      { headers },
    );
  }

  if (sub === "" && request.method === "PUT") {
    const body = await readJson(request);
    const version = expectVersion(body);
    const next = validateConfig(body, policy, selfHost);
    const saved = await stub.putDoc(next, version);
    if (!saved.ok) return conflict(saved.doc, headers);
    return Response.json({ ok: true, version: saved.doc.version, updatedAt: saved.doc.updatedAt }, { headers });
  }

  const secretRoute = /^\/secrets\/([^/]+)$/.exec(sub);
  if (secretRoute) {
    let name: string;
    try {
      name = parseSecretName(decodeURIComponent(secretRoute[1]));
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      return bad("invalid secret name");
    }
    if (request.method === "PUT") {
      const body = await readJson(request);
      const value = parseSecretValue(body.value);
      const cipher = await encryptSecret(env, user.id, name, value);
      const stored = await stub.putSecrets([{ name, cipher }], LIMITS.secrets);
      if (!stored.ok) bad(`at most ${LIMITS.secrets} secrets`);
      return Response.json({ ok: true, name }, { headers });
    }
    if (request.method === "DELETE") {
      await stub.deleteSecret(name);
      return Response.json({ ok: true }, { headers });
    }
  }

  if (sub === "/import" && request.method === "POST") {
    const body = await readJson(request);
    const imported = normalizeImport(body.config);
    const skipped = [...imported.skipped];
    const valid: McpServerConfig[] = [];
    for (const server of imported.servers) {
      try {
        valid.push(validateServer(server, policy, selfHost));
      } catch (err) {
        skipped.push({ name: server.name, reason: err instanceof GatewayError ? err.message : "invalid server" });
      }
    }
    const used = new Set(valid.flatMap((s) => [s.url, ...Object.values(s.headers)].flatMap((t) => [...t.matchAll(SECRET_REF)].map((m) => m[1]))));
    const secrets = imported.secrets.filter((s) => used.has(s.name));
    if (body.apply !== true) {
      return Response.json(
        {
          ok: true,
          applied: false,
          servers: valid.map((s) => ({ name: s.name, url: s.url, transport: s.transport, headerNames: Object.keys(s.headers) })),
          skipped,
          secretsToCreate: secrets.map((s) => s.name),
          secretsNeeded: imported.secretsNeeded,
          secretsEnabled: secretsConfigured(env),
        },
        { headers },
      );
    }
    const version = expectVersion(body);
    if (secrets.length && !secretsConfigured(env)) {
      throw new GatewayError(503, "secrets_unconfigured", "Secret storage is not configured on this gateway");
    }
    const doc = await stub.getDoc();
    const existingSecrets = new Set(await stub.listSecretNames());
    const byName = new Map(doc.mcpServers.map((s) => [s.name.toLowerCase(), s]));
    const merged = [...doc.mcpServers];
    const added: string[] = [];
    const updated: string[] = [];
    const rename = new Map<string, string>();
    const toStore: { name: string; value: string }[] = [];
    for (const server of valid) {
      const prior = byName.get(server.name.toLowerCase());
      // 只有同名 server 自己已经在用的密钥名才允许覆盖，别的一律改名，避免冲掉别的 server 的密钥。
      const owned = new Set<string>(
        prior ? [prior.url, ...Object.values(prior.headers)].flatMap((t) => [...t.matchAll(SECRET_REF)].map((m) => m[1])) : [],
      );
      let json = JSON.stringify(server);
      for (const secret of secrets) {
        if (!json.includes(`\${secret:${secret.name}}`)) continue;
        let finalName = rename.get(`${server.name}\0${secret.name}`) ?? secret.name;
        if (existingSecrets.has(finalName) && !owned.has(finalName)) {
          for (let n = 2; existingSecrets.has(finalName) || toStore.some((t) => t.name === finalName); n++) {
            finalName = `${secret.name}_${n}`.slice(0, 64);
          }
        }
        rename.set(`${server.name}\0${secret.name}`, finalName);
        if (finalName !== secret.name) json = json.split(`\${secret:${secret.name}}`).join(`\${secret:${finalName}}`);
        if (!toStore.some((t) => t.name === finalName)) toStore.push({ name: finalName, value: secret.value });
      }
      const final = JSON.parse(json) as McpServerConfig;
      if (prior) {
        const at = merged.findIndex((s) => s.id === prior.id);
        merged[at] = { ...final, id: prior.id, allowWrite: prior.allowWrite };
        updated.push(final.name);
      } else {
        const ids = new Set(merged.map((s) => s.id));
        let id = final.id || slugify(final.name, 24);
        for (let n = 2; ids.has(id); n++) id = `${slugify(final.name, 24)}-${n}`.slice(0, 32);
        merged.push({ ...final, id: id || newId("m") });
        added.push(final.name);
      }
    }
    const next = validateConfig({ mcpServers: merged, skills: doc.skills }, policy, selfHost);
    const encrypted = await Promise.all(
      toStore.map(async (s) => ({ name: s.name, cipher: await encryptSecret(env, user.id, s.name, parseSecretValue(s.value)) })),
    );
    if (encrypted.length) {
      const stored = await stub.putSecrets(encrypted, LIMITS.secrets);
      if (!stored.ok) bad(`at most ${LIMITS.secrets} secrets`);
    }
    const saved = await stub.putDoc(next, version);
    if (!saved.ok) return conflict(saved.doc, headers);
    const created = new Set(toStore.map((s) => s.name));
    const stillNeeded = imported.secretsNeeded.filter((n) => !existingSecrets.has(n) && !created.has(n));
    return Response.json(
      {
        ok: true,
        applied: true,
        version: saved.doc.version,
        added,
        updated,
        skipped,
        secretsCreated: [...created],
        secretsNeeded: stillNeeded,
      },
      { headers },
    );
  }

  const testRoute = /^\/mcp\/([a-z0-9-]{1,32})\/test$/.exec(sub);
  if (testRoute && request.method === "POST") {
    if (!policy.enabled) throw new GatewayError(403, "mcp_disabled", "MCP is disabled by the administrator");
    throwIfAdmitFailed(
      await board.admit(`mcptest:${user.id}`, {
        quota: 0,
        maxRpm: GATE.mcpTestRpm,
        maxInflight: GATE.keyInflight,
        takeInflight: false,
      }),
    );
    const doc = await stub.getDoc();
    const server = doc.mcpServers.find((s) => s.id === testRoute[1]);
    if (!server) throw new GatewayError(404, "not_found", "MCP server not found");
    const hub = new McpHub([{ ...server, enabled: true }], mcpStore(env, user.id), { policy, selfHost });
    try {
      const prepared = await hub.prepare(true);
      if (prepared.warnings.length) {
        const status = (await stub.getStatus())[server.id];
        return Response.json({ ok: false, error: status?.error ?? "connection failed" }, { headers });
      }
      const all = (await mcpStore(env, user.id).getTools(server.id))?.tools ?? [];
      const exposed = new Set(visibleTools(server, all).map((t) => t.name));
      return Response.json(
        {
          ok: true,
          tools: all.map((t) => ({
            name: t.name,
            description: (t.description ?? "").slice(0, 300),
            readOnly: t.annotations?.readOnlyHint === true,
            destructive: t.annotations?.destructiveHint === true,
            exposed: exposed.has(t.name),
          })),
        },
        { headers },
      );
    } finally {
      await hub.close();
    }
  }

  throw new GatewayError(404, "not_found", "Not found");
}
