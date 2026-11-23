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

function meterName(id: string): string {
  return id.startsWith("anon:") || id.startsWith("admin:") || id.startsWith("login:") ? `g:${id}` : `k:${id}`;
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
