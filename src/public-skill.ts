import { GatewayError } from "./lib.ts";
import { LIMITS } from "./user-config.ts";

/**
 * 公共 Skill：管理员写的一段 system 提示，所有人共用，分两个层级。
 * - frontend：聊天页（cookie 登录）。默认有内容，告诉模型现在是网页对话，以及怎么帮用户配 MCP / Skill。
 * - apikey：拿 Key 直接调 /v1/skill 的客户端。这类调用方自己带 system，默认关闭、没有内容。
 * 只在 /v1/skill/* 的 messages 和 chat/completions 上生效。
 */

export type PublicSkillSurface = "frontend" | "apikey";

export type PublicSkillScope = {
  enabled: boolean;
  /** 空字符串表示用内置默认内容。 */
  text: string;
};

export type PublicSkillConfig = Record<PublicSkillSurface, PublicSkillScope>;

export const PUBLIC_SKILL_MAX_CHARS = 8000;

export function frontendDefaultText(): string {
  return [
    "你现在运行在网页聊天界面里：用户通过浏览器里的聊天页和你对话，不是命令行，也不是代码编辑器。",
    "- 你看不到用户的屏幕、文件和本机环境，也不能运行本地命令。需要这些信息时，请用户直接粘贴文字或链接。",
    "- 回复用 Markdown，页面会渲染它；代码放进带语言标记的代码块。不要假设能弹窗、打开文件或执行脚本。",
    "- 联网搜索、读取网页，以及用户自己接的 MCP 工具，都会出现在你的工具列表里。列表里没有的就是当前不可用，不要编造调用结果。",
    "",
    "## 帮用户配置 MCP 和 Skill",
    "你自己没有权限改用户的配置。用户想接 MCP 或写 Skill 时，由用户在聊天页的「扩展」里操作；你负责讲清步骤，并把要填的内容写好，让用户复制粘贴。",
    "",
    "MCP（给你接外部工具，比如查文档、查数据库）：",
    "1. 只支持远程 MCP，地址必须是公网 https 域名。靠本机命令启动的（stdio，例如 npx 跑起来的）网关跑不了；IP、内网地址和本站地址也不行。",
    "2. 在「扩展」里添加：名称、地址、传输方式。传输方式一般选 auto；服务端文档明确说是 SSE 才选 sse。",
    "3. 需要密钥（Authorization、API key 等）时，先在「扩展」里保存一个密钥，再在请求头或地址参数里写 ${secret:密钥名}，例如 Authorization 填 Bearer ${secret:GITHUB_TOKEN}。明文 token 会被拒绝。不要让用户把密钥发给你。",
    "4. 也可以直接导入：把 Cursor、Claude Desktop、VS Code 等的 mcp.json 粘贴进去，明文 token 会自动转成密钥，stdio 条目会被跳过。",
    "5. 默认只给你暴露声明了只读的工具。很多服务不声明，会一个工具都看不到；用户确认信任这个服务后，可以对它打开「允许写操作」。",
    "6. 添加后先测试连接，确认能列出工具。",
    `7. 每人最多 ${LIMITS.servers} 个 MCP。`,
    "",
    "Skill（一份写给你的指令说明，不执行代码）：",
    "1. 名称：小写字母、数字和连字符，例如 weekly-report。",
    "2. 描述：一两句话，写清楚什么场景该用它。每次对话你只会看到名称和描述，正文要调用 load_skill 才会读到，所以描述要写触发场景，别写空话。",
    `3. 正文：Markdown，写步骤、输出格式和注意事项，最多 ${LIMITS.skillBodyChars} 字符；最多 ${LIMITS.skills} 个 Skill。`,
    "4. 用户让你帮忙写 Skill 时，直接分成名称、描述、正文三块给出，方便复制。",
  ].join("\n");
}

export function defaultText(surface: PublicSkillSurface): string {
  return surface === "frontend" ? frontendDefaultText() : "";
}

export function defaultPublicSkill(): PublicSkillConfig {
  return {
    frontend: { enabled: true, text: "" },
    apikey: { enabled: false, text: "" },
  };
}

function parseScope(raw: unknown, label: string, surface: PublicSkillSurface): PublicSkillScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GatewayError(400, "invalid_request", `${label} must be an object`);
  }
  const rec = raw as { enabled?: unknown; text?: unknown };
  if (typeof rec.enabled !== "boolean") throw new GatewayError(400, "invalid_request", `${label}.enabled must be a boolean`);
  const text = rec.text === undefined ? "" : rec.text;
  if (typeof text !== "string") throw new GatewayError(400, "invalid_request", `${label}.text must be a string`);
  if (text.length > PUBLIC_SKILL_MAX_CHARS) {
    throw new GatewayError(400, "invalid_request", `${label}.text is longer than ${PUBLIC_SKILL_MAX_CHARS} characters`);
  }
  if (text.includes("\0")) throw new GatewayError(400, "invalid_request", `${label}.text must not contain NUL characters`);
  const trimmed = text.trim();
  // 和内置默认一样就不存，这样默认内容以后改进了，没改过的站点自动跟上。
  return { enabled: rec.enabled, text: trimmed === defaultText(surface).trim() ? "" : trimmed };
}

export function parsePublicSkill(raw: unknown): PublicSkillConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GatewayError(400, "invalid_request", "public skill must be an object");
  }
  const rec = raw as { frontend?: unknown; apikey?: unknown };
  return {
    frontend: parseScope(rec.frontend, "frontend", "frontend"),
    apikey: parseScope(rec.apikey, "apikey", "apikey"),
  };
}

const PUBLIC_SKILL_KEY = "public_skill";

export async function loadPublicSkill(kv: KVNamespace): Promise<PublicSkillConfig> {
  const raw = await kv.get<unknown>(PUBLIC_SKILL_KEY, "json");
  if (raw == null) return defaultPublicSkill();
  try {
    return parsePublicSkill(raw);
  } catch {
    return defaultPublicSkill();
  }
}

export async function savePublicSkill(kv: KVNamespace, config: PublicSkillConfig): Promise<void> {
  await kv.put(PUBLIC_SKILL_KEY, JSON.stringify(config));
}

/** 后台用：存的值、生效的值、内置默认。 */
export function publicSkillView(config: PublicSkillConfig) {
  const view = (surface: PublicSkillSurface) => ({
    enabled: config[surface].enabled,
    text: config[surface].text || defaultText(surface),
    isDefault: !config[surface].text,
  });
  return {
    frontend: view("frontend"),
    apikey: view("apikey"),
    defaults: { frontend: defaultText("frontend"), apikey: defaultText("apikey") },
    maxChars: PUBLIC_SKILL_MAX_CHARS,
  };
}

/** 这次请求要追加到 system 的公共 Skill；没有就返回 null。 */
export function publicSkillText(
  config: PublicSkillConfig,
  surface: PublicSkillSurface,
  state: { mcpEnabled: boolean },
): string | null {
  const scope = config[surface];
  if (!scope.enabled) return null;
  const text = (scope.text || defaultText(surface)).trim();
  if (!text) return null;
  if (surface === "frontend" && !state.mcpEnabled) {
    return `${text}\n\n（管理员目前关闭了 MCP，用户暂时不能添加或使用。用户问起时如实说明，不要引导他去配置 MCP；Skill 不受影响。）`;
  }
  return text;
}
