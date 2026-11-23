import { userConfig } from "./durable.ts";
import type { CachedTools, McpStore } from "./mcp.ts";
import { decryptSecret } from "./secrets.ts";

/** 把某个用户的 Durable Object 接成 McpHub 要用的存储；密钥在这里解密，只进内存。 */
export function mcpStore(env: Env, userId: string): McpStore {
  const stub = userConfig(env, userId);
  return {
    async secrets(names) {
      const ciphers = await stub.getSecretCiphers(names);
      const out: Record<string, string> = {};
      for (const [name, cipher] of Object.entries(ciphers)) out[name] = await decryptSecret(env, userId, name, cipher);
      return out;
    },
    async getTools(id) {
      const json = await stub.getToolsJson(id);
      if (!json) return null;
      try {
        return JSON.parse(json) as CachedTools;
      } catch {
        return null;
      }
    },
    putTools: (id, cached) => stub.putToolsJson(id, JSON.stringify(cached)),
    putStatus: (id, status) => stub.putStatus(id, status),
  };
}
