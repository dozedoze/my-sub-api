import type { ServerStatus } from "./mcp.ts";
import { serverSecretNames, type UserConfigDoc } from "./user-config.ts";

/**
 * 后台「用户配置」页的数据：每个前台用户配了哪些 MCP 和 Skill。
 * 只给管理员看「配了什么」，永远不含密钥的值：密钥只列名字，URL 去掉查询串，Skill 正文只给开头一段。
 */

export const SKILL_PREVIEW_CHARS = 1500;

export type AdminServerView = {
  id: string;
  name: string;
  /** 不含查询串。查询串里只会有 ${secret:X} 占位符，也不展示。 */
  url: string;
  transport: string;
  enabled: boolean;
  allowWrite: boolean;
  /** 请求头原样展示。敏感头只允许占位符，所以这里不会有明文密钥。 */
  headers: Record<string, string>;
  secretNames: string[];
  /** 引用了但用户还没保存的密钥名。 */
  missingSecrets: string[];
  status: ServerStatus | null;
};

export type AdminSkillView = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  bodyChars: number;
  preview: string;
};

export type AdminConfigView = {
  version: number;
  updatedAt: number;
  mcpServers: AdminServerView[];
  skills: AdminSkillView[];
  secretNames: string[];
};

function stripQuery(raw: string): string {
  const q = raw.indexOf("?");
  return q < 0 ? raw : raw.slice(0, q);
}

export function describeUserConfig(
  doc: UserConfigDoc,
  secretNames: string[],
  status: Record<string, ServerStatus>,
): AdminConfigView {
  const have = new Set(secretNames);
  return {
    version: doc.version,
    updatedAt: doc.updatedAt,
    secretNames,
    mcpServers: doc.mcpServers.map((s) => {
      const used = serverSecretNames(s);
      return {
        id: s.id,
        name: s.name,
        url: stripQuery(s.url),
        transport: s.transport,
        enabled: s.enabled,
        allowWrite: s.allowWrite,
        headers: s.headers,
        secretNames: used,
        missingSecrets: used.filter((n) => !have.has(n)),
        status: status[s.id] ?? null,
      };
    }),
    skills: doc.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      enabled: s.enabled,
      bodyChars: s.body.length,
      preview: s.body.slice(0, SKILL_PREVIEW_CHARS),
    })),
  };
}
