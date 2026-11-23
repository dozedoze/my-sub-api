import {
  generateApiKey,
  generatePassword,
  GatewayError,
  hashPassword,
  keyPrefix,
  parseUsername,
  sha256hex,
  toPublicKey,
  type KeyPublic,
  type KeyRecord,
} from "./lib.ts";
import { DEFAULT_MCP_POLICY, parseMcpPolicy, type McpPolicy } from "./net-guard.ts";

const ID_PREFIX = "id:";
const HASH_PREFIX = "hash:";
const USER_PREFIX = "user:";
const SKILLS_KEY = "hosted_skills";

function idKey(id: string): string {
  return `${ID_PREFIX}${id}`;
}

function hashKey(hash: string): string {
  return `${HASH_PREFIX}${hash}`;
}

function userKey(username: string): string {
  return `${USER_PREFIX}${username}`;
}

async function writeRecord(kv: KVNamespace, record: KeyRecord): Promise<void> {
  const body = JSON.stringify(record);
  const metadata = toPublicKey(record);
  await kv.put(idKey(record.id), body, { metadata });
  await kv.put(hashKey(record.hash), body);
  if (record.username) await kv.put(userKey(record.username), record.id);
}

export async function createIssuedKey(
  kv: KVNamespace,
  input: { name: string; provider?: string; quotaTokens: number; username?: string; password?: string },
): Promise<{ plaintext: string; password?: string; record: KeyPublic }> {
  const username = parseUsername(input.username);
  let password: string | undefined;
  let passwordSalt: string | undefined;
  let passwordHash: string | undefined;
  if (username) {
    const taken = await kv.get(userKey(username));
    if (taken) throw new GatewayError(409, "username_taken", "username is already in use");
    const raw = typeof input.password === "string" ? input.password : "";
    if (raw && raw.length < 8) throw new GatewayError(400, "invalid_request", "password must be at least 8 characters");
    password = raw || generatePassword();
    const hashed = await hashPassword(password);
    passwordSalt = hashed.salt;
    passwordHash = hashed.hash;
  } else if (typeof input.password === "string" && input.password) {
    throw new GatewayError(400, "invalid_request", "username is required when setting a password");
  }

  const plaintext = generateApiKey();
  const record: KeyRecord = {
    id: crypto.randomUUID(),
    name: input.name.trim() || "unnamed",
    prefix: keyPrefix(plaintext),
    hash: await sha256hex(plaintext),
    enabled: true,
    createdAt: Date.now(),
    provider: input.provider?.trim() || undefined,
    quotaTokens: input.quotaTokens,
    username,
    passwordSalt,
    passwordHash,
  };
  await writeRecord(kv, record);
  return { plaintext, password, record: toPublicKey(record) };
}

export async function lookupByPlaintext(kv: KVNamespace, plaintext: string): Promise<KeyRecord | null> {
  const hash = await sha256hex(plaintext);
  const record = await kv.get<KeyRecord>(hashKey(hash), "json");
  if (!record || !record.enabled) return null;
  return record;
}

export async function lookupById(kv: KVNamespace, id: string): Promise<KeyRecord | null> {
  const record = await kv.get<KeyRecord>(idKey(id), "json");
  if (!record || !record.enabled) return null;
  return record;
}

export async function lookupByUsername(kv: KVNamespace, username: string): Promise<KeyRecord | null> {
  let parsed: string | undefined;
  try {
    parsed = parseUsername(username);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const id = await kv.get(userKey(parsed));
  if (!id) return null;
  return kv.get<KeyRecord>(idKey(id), "json");
}

export async function listIssuedKeys(kv: KVNamespace): Promise<KeyPublic[]> {
  const out: KeyPublic[] = [];
  let cursor: string | undefined;
  // ponytail: KV list 最终一致，元数据会脏。GET 同一 colo 马上看到删改；签发后别的 POP 最多约 60s 才进 list。要强一致再换 D1。
  do {
    const page = await kv.list({ prefix: ID_PREFIX, cursor });
    for (const entry of page.keys) {
      const rec = await kv.get<KeyRecord>(entry.name, "json");
      if (rec) out.push(toPublicKey(rec));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function patchIssuedKey(
  kv: KVNamespace,
  id: string,
  patch: { enabled?: boolean; quotaTokens?: number },
): Promise<KeyPublic | null> {
  const rec = await kv.get<KeyRecord>(idKey(id), "json");
  if (!rec) return null;
  if (typeof patch.enabled === "boolean") rec.enabled = patch.enabled;
  if (typeof patch.quotaTokens === "number") rec.quotaTokens = patch.quotaTokens;
  await writeRecord(kv, rec);
  return toPublicKey(rec);
}

export async function resetIssuedPassword(
  kv: KVNamespace,
  id: string,
  password?: string,
): Promise<{ record: KeyPublic; password: string } | null> {
  const rec = await kv.get<KeyRecord>(idKey(id), "json");
  if (!rec) return null;
  if (!rec.username) throw new GatewayError(400, "invalid_request", "this key has no chat username");
  const raw = password?.trim() ?? "";
  if (raw && raw.length < 8) throw new GatewayError(400, "invalid_request", "password must be at least 8 characters");
  const next = raw || generatePassword();
  const hashed = await hashPassword(next);
  rec.passwordSalt = hashed.salt;
  rec.passwordHash = hashed.hash;
  await writeRecord(kv, rec);
  return { record: toPublicKey(rec), password: next };
}

export async function deleteIssuedKey(kv: KVNamespace, id: string): Promise<boolean> {
  const rec = await kv.get<KeyRecord>(idKey(id), "json");
  if (!rec) return false;
  await kv.delete(idKey(id));
  await kv.delete(hashKey(rec.hash));
  if (rec.username) await kv.delete(userKey(rec.username));
  return true;
}

const BL_KEY = "upstream_blacklist";
const AUTO_KEY = "auto_models";

export async function loadAutoModels(kv: KVNamespace): Promise<unknown | null> {
  return (await kv.get(AUTO_KEY, "json")) ?? null;
}

export async function saveAutoModels(
  kv: KVNamespace,
  route: { easy: string; hard: string[] },
): Promise<void> {
  await kv.put(AUTO_KEY, JSON.stringify({ easy: route.easy, hard: route.hard }));
}

export async function clearAutoModels(kv: KVNamespace): Promise<void> {
  await kv.delete(AUTO_KEY);
}

export const HOSTED_SKILL_IDS = ["web_search", "fetch_url"] as const;
export type HostedSkillId = (typeof HOSTED_SKILL_IDS)[number];

export type SkillsConfig = {
  enabled: HostedSkillId[];
  maxRounds: number;
};

export const DEFAULT_SKILLS: SkillsConfig = { enabled: ["web_search", "fetch_url"], maxRounds: 3 };

export function parseSkillsConfig(raw: unknown): SkillsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GatewayError(400, "invalid_request", "skills must be an object");
  }
  const rec = raw as { enabled?: unknown; maxRounds?: unknown };
  if (!Array.isArray(rec.enabled)) throw new GatewayError(400, "invalid_request", "enabled must be an array");
  const enabled: HostedSkillId[] = [];
  for (const item of rec.enabled) {
    if (item === "web_search" || item === "fetch_url") {
      if (!enabled.includes(item)) enabled.push(item);
      continue;
    }
    throw new GatewayError(400, "invalid_request", `unknown skill '${String(item)}'`);
  }
  let maxRounds = DEFAULT_SKILLS.maxRounds;
  if (rec.maxRounds !== undefined) {
    if (typeof rec.maxRounds !== "number" || !Number.isFinite(rec.maxRounds) || rec.maxRounds < 1 || rec.maxRounds > 8) {
      throw new GatewayError(400, "invalid_request", "maxRounds must be 1-8");
    }
    maxRounds = Math.floor(rec.maxRounds);
  }
  return { enabled, maxRounds };
}

export async function loadSkills(kv: KVNamespace): Promise<SkillsConfig> {
  const raw = await kv.get<unknown>(SKILLS_KEY, "json");
  if (raw == null) return { ...DEFAULT_SKILLS, enabled: [...DEFAULT_SKILLS.enabled] };
  try {
    return parseSkillsConfig(raw);
  } catch {
    return { ...DEFAULT_SKILLS, enabled: [...DEFAULT_SKILLS.enabled] };
  }
}

export async function saveSkills(kv: KVNamespace, config: SkillsConfig): Promise<void> {
  await kv.put(SKILLS_KEY, JSON.stringify(config));
}

const MCP_POLICY_KEY = "mcp_policy";

export async function loadMcpPolicy(kv: KVNamespace): Promise<McpPolicy> {
  const raw = await kv.get<unknown>(MCP_POLICY_KEY, "json");
  if (raw == null) return { ...DEFAULT_MCP_POLICY };
  try {
    return parseMcpPolicy(raw);
  } catch {
    // 配置坏了就按最严的处理：关闭，而不是放开。
    return { enabled: false, allowDomains: [], denyDomains: [] };
  }
}

export async function saveMcpPolicy(kv: KVNamespace, policy: McpPolicy): Promise<void> {
  await kv.put(MCP_POLICY_KEY, JSON.stringify(policy));
}

export type UpstreamBan = {
  providerId: string;
  reason: string;
  createdAt: number;
  auto: boolean;
};

export async function loadUpstreamBans(kv: KVNamespace): Promise<Record<string, UpstreamBan>> {
  const raw = await kv.get<Record<string, UpstreamBan>>(BL_KEY, "json");
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export async function banUpstream(
  kv: KVNamespace,
  providerId: string,
  reason: string,
  auto = false,
): Promise<UpstreamBan> {
  const id = providerId.trim();
  const all = await loadUpstreamBans(kv);
  if (auto && all[id]) return all[id];
  const hit: UpstreamBan = {
    providerId: id,
    reason: reason.trim() || (auto ? "upstream 401/403" : "manual"),
    createdAt: Date.now(),
    auto,
  };
  all[id] = hit;
  await kv.put(BL_KEY, JSON.stringify(all));
  return hit;
}

export async function unbanUpstream(kv: KVNamespace, providerId: string): Promise<boolean> {
  const all = await loadUpstreamBans(kv);
  if (!all[providerId]) return false;
  delete all[providerId];
  await kv.put(BL_KEY, JSON.stringify(all));
  return true;
}
