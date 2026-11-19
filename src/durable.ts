import { DurableObject } from "cloudflare:workers";
import { pushRecent, trimSessionMessages, type ChatMessage, type Meter } from "./lib";

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

  async add(keyId: string, providerId: string, tokens: number, model?: string): Promise<Meter> {
    const n = Math.max(0, Math.floor(tokens));
    const cur = await this.peek(keyId);
    const next: Meter = { used: cur.used + n, requests: cur.requests + 1 };
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
