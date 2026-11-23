import { sessionUser } from "./chat-api.ts";
import { quotaBoard, userConfig } from "./durable.ts";
import { loadMcpPolicy, lookupByPlaintext } from "./keys.ts";
import { extractToken, GATE, throwIfAdmitFailed } from "./lib.ts";
import { McpHub } from "./mcp.ts";
import { mcpStore } from "./mcp-store.ts";
import type { ToolCall, ToolDef } from "./skills.ts";
import type { SkillConfig } from "./user-config.ts";
import { LOAD_SKILL_TOOL, loadSkillTool, runLoadSkill, skillCatalogText } from "./user-skills.ts";

/** 一次请求里挂给模型的用户自有工具：MCP 工具和 load_skill。 */
export type UserTools = {
  tools: ToolDef[];
  catalog: string | null;
  run(call: ToolCall): Promise<string>;
  close(): Promise<void>;
};

export async function resolveCaller(request: Request, env: Env): Promise<{ id: string } | null> {
  const token = extractToken(request);
  const found = token ? await lookupByPlaintext(env.KEYS, token) : await sessionUser(request, env);
  return found ? { id: found.id } : null;
}

/**
 * 只在 messages 和 chat/completions 上生效；别的协议保持原样。
 * 没有可用配置、管理员关了 MCP、或者调用方不是已登录用户时返回 null。
 */
export async function loadUserTools(request: Request, env: Env, rest: string): Promise<UserTools | null> {
  if (rest !== "messages" && rest !== "chat/completions") return null;
  const caller = await resolveCaller(request, env);
  if (!caller) return null;
  const doc = await userConfig(env, caller.id).getDoc();
  const policy = await loadMcpPolicy(env.KEYS);
  const servers = policy.enabled ? doc.mcpServers.filter((s) => s.enabled) : [];
  const skills: SkillConfig[] = doc.skills.filter((s) => s.enabled);
  if (!servers.length && !skills.length) return null;

  let hub: McpHub | null = null;
  const tools: ToolDef[] = [];
  if (servers.length) {
    throwIfAdmitFailed(
      await quotaBoard(env).admit(`mcp:${caller.id}`, {
        quota: 0,
        maxRpm: GATE.mcpRpm,
        maxInflight: GATE.keyInflight,
        takeInflight: false,
      }),
    );
    hub = new McpHub(servers, mcpStore(env, caller.id), { policy, selfHost: new URL(request.url).hostname });
    const prepared = await hub.prepare();
    for (const entry of prepared.tools) {
      tools.push({ name: entry.exposed, description: entry.description, input_schema: entry.schema });
    }
    for (const warning of prepared.warnings) {
      console.warn(JSON.stringify({ message: "mcp_server_unavailable", user: caller.id, warning: warning.slice(0, 200) }));
    }
  }
  if (skills.length) tools.push(loadSkillTool(skills));

  const activeHub = hub;
  return {
    tools,
    catalog: skills.length ? skillCatalogText(skills) : null,
    async run(call) {
      if (call.name === LOAD_SKILL_TOOL) return runLoadSkill(skills, call.input);
      if (activeHub?.has(call.name)) return activeHub.call(call.name, call.input);
      return `unknown tool ${call.name}`;
    },
    async close() {
      await activeHub?.close();
    },
  };
}
