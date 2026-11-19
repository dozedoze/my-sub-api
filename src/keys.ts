import {
  generateApiKey,
  keyPrefix,
  sha256hex,
  toPublicKey,
  type KeyPublic,
  type KeyRecord,
} from "./lib.ts";

const ID_PREFIX = "id:";
const HASH_PREFIX = "hash:";

function idKey(id: string): string {
  return `${ID_PREFIX}${id}`;
}

function hashKey(hash: string): string {
  return `${HASH_PREFIX}${hash}`;
}

async function writeRecord(kv: KVNamespace, record: KeyRecord): Promise<void> {
  const body = JSON.stringify(record);
  const metadata = toPublicKey(record);
  await kv.put(idKey(record.id), body, { metadata });
  await kv.put(hashKey(record.hash), body);
}

export async function createIssuedKey(
  kv: KVNamespace,
  input: { name: string; provider?: string; quotaTokens: number },
): Promise<{ plaintext: string; record: KeyPublic }> {
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
  };
  await writeRecord(kv, record);
  return { plaintext, record: toPublicKey(record) };
}

export async function lookupByPlaintext(kv: KVNamespace, plaintext: string): Promise<KeyRecord | null> {
  const hash = await sha256hex(plaintext);
  const record = await kv.get<KeyRecord>(hashKey(hash), "json");
  if (!record || !record.enabled) return null;
  return record;
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

export async function deleteIssuedKey(kv: KVNamespace, id: string): Promise<boolean> {
  const rec = await kv.get<KeyRecord>(idKey(id), "json");
  if (!rec) return false;
  await kv.delete(idKey(id));
  await kv.delete(hashKey(rec.hash));
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
