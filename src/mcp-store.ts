import { userConfig } from "./durable.ts";
import type { CachedTools, McpStore } from "./mcp.ts";
import { decryptSecret } from "./secrets.ts";

const MAX_CACHE_CHARS = 600_000;

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
    async putTools(id, cached) {
      const json = JSON.stringify(cached);
      // Durable Object 单个值上限 2 MiB。工具定义特别大的 server 不缓存，下次重新列，别因为写不进去把整个 server 判成失败。
      if (json.length > MAX_CACHE_CHARS) return;
      await stub.putToolsJson(id, json);
    },
    putStatus: (id, status) => stub.putStatus(id, status),
  };
}
