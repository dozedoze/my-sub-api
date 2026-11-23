import { DurableObject } from "cloudflare:workers";
import {
  applyAdmit,
  applyLoginFail,
  applyLoginOk,
  applyRelease,
  pushRecent,
  trimSessionMessages,
  type AdmitFail,
  type ChatMessage,
  type Meter,
} from "./lib";
import type { ServerStatus } from "./mcp.ts";
import { EMPTY_DOC, type McpServerConfig, type SkillConfig, type UserConfigDoc } from "./user-config.ts";

function meterName(id: string): string {
  return /^(anon|admin|login|mcp|mcptest|config):/.test(id) ? `g:${id}` : `k:${id}`;
}

export class ChatSession extends DurableObject<Env> {
  async load(): Promise<ChatMessage[]> {
    return (await this.ctx.storage.get<ChatMessage[]>("messages")) ?? [];
  }

  async save(messages: ChatMessage[]): Promise<void> {
    await this.ctx.storage.put("messages", trimSessionMessages(messages));
  }

  async loadAuto(): Promise<"easy" | "hard" | null> {
    const tier = await this.ctx.storage.get<string>("auto");
    return tier === "easy" || tier === "hard" ? tier : null;
  }

  async saveAuto(tier: "easy" | "hard"): Promise<void> {
    await this.ctx.storage.put("auto", tier);
  }

  async loadAutoModel(): Promise<string | null> {
    const model = await this.ctx.storage.get<string>("autoModel");
    return typeof model === "string" && model.trim() ? model : null;
  }

  async saveAutoModel(model: string): Promise<void> {
    await this.ctx.storage.put("autoModel", model);
  }
}

/**
 * 每个用户一个：自己的 MCP server、Skill、加密后的密钥、连接状态和工具缓存。
 * 强一致，保存密钥后马上就能测试连接。密钥只存密文，主密钥不在这里。
 */
export class UserConfig extends DurableObject<Env> {
  async getDoc(): Promise<UserConfigDoc> {
    return (await this.ctx.storage.get<UserConfigDoc>("doc")) ?? EMPTY_DOC;
  }

  async putDoc(
    next: { mcpServers: McpServerConfig[]; skills: SkillConfig[] },
    expectedVersion: number,
  ): Promise<{ ok: true; doc: UserConfigDoc } | { ok: false; doc: UserConfigDoc }> {
    const cur = await this.getDoc();
    if (cur.version !== expectedVersion) return { ok: false, doc: cur };
    const doc: UserConfigDoc = { version: cur.version + 1, ...next, updatedAt: Date.now() };
    await this.ctx.storage.put("doc", doc);
    const live = new Set(next.mcpServers.map((s) => s.id));
    for (const old of cur.mcpServers) {
      if (!live.has(old.id)) await this.ctx.storage.delete([`status:${old.id}`, `tools:${old.id}`]);
    }
    return { ok: true, doc };
  }

  async listSecretNames(): Promise<string[]> {
    const names: string[] = [];
    for (const key of (await this.ctx.storage.list({ prefix: "secret:" })).keys()) names.push(key.slice("secret:".length));
    return names.sort();
  }

  async getSecretCiphers(names: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const name of names) {
      const value = await this.ctx.storage.get<string>(`secret:${name}`);
      if (typeof value === "string") out[name] = value;
    }
    return out;
  }

  async putSecrets(entries: { name: string; cipher: string }[], max: number): Promise<{ ok: boolean }> {
    const existing = new Set(await this.listSecretNames());
    for (const entry of entries) existing.add(entry.name);
    if (existing.size > max) return { ok: false };
    for (const entry of entries) await this.ctx.storage.put(`secret:${entry.name}`, entry.cipher);
    return { ok: true };
  }

  async deleteSecret(name: string): Promise<boolean> {
    return this.ctx.storage.delete(`secret:${name}`);
  }

  async getStatus(): Promise<Record<string, ServerStatus>> {
    const out: Record<string, ServerStatus> = {};
    for (const [key, value] of await this.ctx.storage.list<ServerStatus>({ prefix: "status:" })) {
      out[key.slice("status:".length)] = value;
    }
    return out;
  }

  /** 后台看用户配了什么：一次 RPC 取回配置、密钥名（不含值）和连接状态。 */
  async getAdminView(): Promise<{ doc: UserConfigDoc; secretNames: string[]; status: Record<string, ServerStatus> }> {
    const [doc, secretNames, status] = await Promise.all([this.getDoc(), this.listSecretNames(), this.getStatus()]);
    return { doc, secretNames, status };
  }

  async putStatus(serverId: string, status: ServerStatus): Promise<void> {
    await this.ctx.storage.put(`status:${serverId}`, status);
  }

  /** 工具缓存以 JSON 文本存取：第三方的 schema 是任意结构，不适合走 RPC 的类型推导。 */
  async getToolsJson(serverId: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`tools:${serverId}`)) ?? null;
  }

  async putToolsJson(serverId: string, json: string): Promise<void> {
    await this.ctx.storage.put(`tools:${serverId}`, json);
  }

  async clearAll(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export function userConfig(env: Env, userId: string): DurableObjectStub<UserConfig> {
  return env.USER_CONFIG.get(env.USER_CONFIG.idFromName(userId));
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
    const empty: Meter = { used: 0, requests: 0 };
    const cur = await this.ctx.storage.get<Meter>(meterName(keyId));
    if (cur) return cur;
    if (keyId.startsWith("login:")) {
      return (await this.ctx.storage.get<Meter>(`k:${keyId}`)) ?? empty;
    }
    return empty;
  }

  async noteLoginFail(id: string): Promise<Meter> {
    const next = applyLoginFail(await this.peek(id), Date.now());
    await this.ctx.storage.put(meterName(id), next);
    return next;
  }

  async noteLoginOk(id: string): Promise<void> {
    await this.ctx.storage.put(meterName(id), applyLoginOk(await this.peek(id)));
  }

  async admit(
    id: string,
    opts: { quota: number; maxRpm: number; maxInflight: number; takeInflight: boolean },
  ): Promise<{ ok: true } | AdmitFail> {
    const cur = await this.peek(id);
    const hit = applyAdmit(cur, Date.now(), opts);
    if (!hit.ok) return hit;
    await this.ctx.storage.put(meterName(id), hit.next);
    return { ok: true };
  }

  async release(id: string): Promise<void> {
    const cur = await this.peek(id);
    await this.ctx.storage.put(meterName(id), applyRelease(cur, Date.now()));
  }

  async add(keyId: string, providerId: string, tokens: number, model?: string): Promise<Meter> {
    const n = Math.max(0, Math.floor(tokens));
    const cur = await this.peek(keyId);
    const next: Meter = {
      used: cur.used + n,
      requests: cur.requests + 1,
      rpmAt: cur.rpmAt,
      rpm: cur.rpm,
      inflight: cur.inflight,
      gateAt: cur.gateAt,
    };
    // model 缺省是内部分档计费：只累加额度，最近调用原样保留。
    if (model !== undefined) {
      next.recent = pushRecent(cur.recent, { at: Date.now(), model, provider: providerId, tokens: n });
    } else if (cur.recent?.length) {
      next.recent = cur.recent;
    }
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

export function quotaBoard(env: Env): DurableObjectStub<QuotaBoard> {
  return env.QUOTAS.get(env.QUOTAS.idFromName("board"));
}
