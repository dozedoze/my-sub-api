import { GatewayError } from "./lib.ts";
import { assertPublicHttpsUrl, type McpPolicy } from "./net-guard.ts";

/** 每个用户自己的 MCP server 和 Skill。服务器按 Key id 存，聊天页和 /v1/skill/* 的 API 客户端共用。 */

export const LIMITS = {
  servers: 8,
  headersPerServer: 8,
  headerValueChars: 2048,
  skills: 20,
  skillBodyChars: 32_000,
  skillTotalChars: 200_000,
  skillDescriptionChars: 500,
  secrets: 32,
  secretValueChars: 4096,
  nameChars: 40,
} as const;

export type McpTransport = "auto" | "http" | "sse";

export type McpServerConfig = {
  id: string;
  name: string;
  url: string;
  transport: McpTransport;
  /** 值里可以带 ${secret:NAME}。敏感头必须带占位符，不接受明文。 */
  headers: Record<string, string>;
  enabled: boolean;
  /** 默认只暴露声明了 readOnlyHint 的工具；打开后暴露全部。 */
  allowWrite: boolean;
};

export type SkillConfig = {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
};

export type UserConfigDoc = {
  version: number;
  mcpServers: McpServerConfig[];
  skills: SkillConfig[];
  updatedAt: number;
};

export const EMPTY_DOC: UserConfigDoc = { version: 0, mcpServers: [], skills: [], updatedAt: 0 };

export const SECRET_REF = /\$\{secret:([A-Za-z0-9_]{1,64})\}/g;

const SENSITIVE_NAME = /(key|token|secret|auth|password|passwd|cookie|credential|signature|sig)/i;
const FORBIDDEN_HEADER =
  /^(host|content-length|content-type|accept|transfer-encoding|connection|keep-alive|upgrade|te|trailer|expect|origin|referer|mcp-session-id|mcp-protocol-version|last-event-id|x-forwarded-.*|x-real-ip|cf-.*|sec-.*|proxy-.*)$/i;

function bad(message: string): never {
  throw new GatewayError(400, "invalid_request", message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function slugify(raw: string, max = 32): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "item";
}

export function newId(prefix = ""): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export function parseSecretName(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(raw)) {
    bad("secret name must be 1-64 letters, digits or underscores");
  }
  return raw;
}

export function parseSecretValue(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) bad("secret value is required");
  if (raw.length > LIMITS.secretValueChars) bad(`secret value is longer than ${LIMITS.secretValueChars} characters`);
  if (/[\r\n\0]/.test(raw)) bad("secret value must not contain line breaks");
  return raw;
}

function cleanLine(raw: unknown, label: string, max: number): string {
  if (typeof raw !== "string") bad(`${label} must be a string`);
  const text = raw.trim();
  if (!text) bad(`${label} is required`);
  if (text.length > max) bad(`${label} is longer than ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(text)) bad(`${label} must not contain control characters`);
  return text;
}

export function referencedSecrets(text: string): string[] {
  return [...new Set([...text.matchAll(SECRET_REF)].map((m) => m[1]))];
}

export function serverSecretNames(server: McpServerConfig): string[] {
  const names = new Set<string>(referencedSecrets(server.url));
  for (const value of Object.values(server.headers)) for (const name of referencedSecrets(value)) names.add(name);
  return [...names];
}

function hasRef(text: string): boolean {
  return new RegExp(SECRET_REF.source).test(text);
}

/** 去掉占位符后，剩下的文字里不应该出现长得像密钥的串。 */
function looksLikeInlineSecret(text: string): boolean {
  const rest = text.replace(SECRET_REF, " ");
  return /[A-Za-z0-9_\-./+=]{16,}/.test(rest);
}

/** 检查 URL 查询参数里没有明文密钥；占位符只允许出现在查询串里。 */
function checkUrlSecrets(raw: string): void {
  const q = raw.indexOf("?");
  const base = q < 0 ? raw : raw.slice(0, q);
  if (base.includes("${")) bad("secret placeholders are only allowed in the url query string");
  if (q < 0) return;
  for (const pair of raw.slice(q + 1).split("&")) {
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    let decoded = key;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      // 保持原样
    }
    if (SENSITIVE_NAME.test(decoded) && value && !hasRef(value)) {
      bad(`query parameter '${decoded}' looks like a credential; use a \${secret:NAME} placeholder instead of the value`);
    }
    if (hasRef(value) && looksLikeInlineSecret(value)) bad(`query parameter '${decoded}' mixes a secret with other text`);
  }
}

export function validateServer(raw: unknown, policy: McpPolicy, selfHost?: string): McpServerConfig {
  const rec = asRecord(raw);
  if (!rec) bad("each MCP server must be an object");
  const id = typeof rec.id === "string" && rec.id ? rec.id : newId("m");
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) bad("server id must be 1-32 lowercase letters, digits or dashes");
  const name = cleanLine(rec.name, "server name", LIMITS.nameChars);
  const url = cleanLine(rec.url, "server url", 2048);
  checkUrlSecrets(url);
  assertPublicHttpsUrl(url.replace(SECRET_REF, "x"), policy, selfHost);
  const transport = rec.transport === undefined ? "auto" : rec.transport;
  if (transport !== "auto" && transport !== "http" && transport !== "sse") bad("transport must be auto, http or sse");
  const headers: Record<string, string> = {};
  const rawHeaders = rec.headers === undefined ? {} : asRecord(rec.headers);
  if (!rawHeaders) bad("headers must be an object");
  const entries = Object.entries(rawHeaders);
  if (entries.length > LIMITS.headersPerServer) bad(`at most ${LIMITS.headersPerServer} headers per server`);
  for (const [hname, hvalue] of entries) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(hname)) bad(`invalid header name '${hname}'`);
    if (FORBIDDEN_HEADER.test(hname)) bad(`header '${hname}' cannot be set`);
    if (typeof hvalue !== "string" || hvalue.length > LIMITS.headerValueChars || /[\r\n\0]/.test(hvalue)) {
      bad(`invalid value for header '${hname}'`);
    }
    if (SENSITIVE_NAME.test(hname)) {
      if (!hasRef(hvalue)) {
        bad(`header '${hname}' looks like a credential; store it as a secret and use a \${secret:NAME} placeholder`);
      }
      if (looksLikeInlineSecret(hvalue)) bad(`header '${hname}' mixes a secret with other text`);
    }
    if (Object.keys(headers).some((k) => k.toLowerCase() === hname.toLowerCase())) bad(`duplicate header '${hname}'`);
    headers[hname] = hvalue;
  }
  return {
    id,
    name,
    url,
    transport,
    headers,
    enabled: rec.enabled === undefined ? true : rec.enabled === true,
    allowWrite: rec.allowWrite === true,
  };
}

export function validateSkill(raw: unknown): SkillConfig {
  const rec = asRecord(raw);
  if (!rec) bad("each skill must be an object");
  const id = typeof rec.id === "string" && rec.id ? rec.id : newId("s");
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) bad("skill id must be 1-32 lowercase letters, digits or dashes");
  const name = cleanLine(rec.name, "skill name", 63);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) bad("skill name must be lowercase letters, digits and dashes");
  const description = cleanLine(rec.description, "skill description", LIMITS.skillDescriptionChars);
  if (typeof rec.body !== "string" || !rec.body.trim()) bad("skill body is required");
  if (rec.body.length > LIMITS.skillBodyChars) bad(`skill body is longer than ${LIMITS.skillBodyChars} characters`);
  if (rec.body.includes("\0")) bad("skill body must not contain NUL characters");
  return { id, name, description, body: rec.body, enabled: rec.enabled === undefined ? true : rec.enabled === true };
}

export function validateConfig(
  raw: unknown,
  policy: McpPolicy,
  selfHost?: string,
): { mcpServers: McpServerConfig[]; skills: SkillConfig[] } {
  const rec = asRecord(raw);
  if (!rec) bad("config must be an object");
  const rawServers = rec.mcpServers === undefined ? [] : rec.mcpServers;
  const rawSkills = rec.skills === undefined ? [] : rec.skills;
  if (!Array.isArray(rawServers) || !Array.isArray(rawSkills)) bad("mcpServers and skills must be arrays");
  if (rawServers.length > LIMITS.servers) bad(`at most ${LIMITS.servers} MCP servers`);
  if (rawSkills.length > LIMITS.skills) bad(`at most ${LIMITS.skills} skills`);
  const mcpServers = rawServers.map((item) => validateServer(item, policy, selfHost));
  const skills = rawSkills.map((item) => validateSkill(item));
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const server of mcpServers) {
    const lower = server.name.toLowerCase();
    if (ids.has(server.id) || names.has(lower)) bad(`duplicate MCP server '${server.name}'`);
    ids.add(server.id);
    names.add(lower);
  }
  const sids = new Set<string>();
  const snames = new Set<string>();
  let total = 0;
  for (const skill of skills) {
    if (sids.has(skill.id) || snames.has(skill.name)) bad(`duplicate skill '${skill.name}'`);
    sids.add(skill.id);
    snames.add(skill.name);
    total += skill.body.length;
  }
  if (total > LIMITS.skillTotalChars) bad(`skills are larger than ${LIMITS.skillTotalChars} characters in total`);
  return { mcpServers, skills };
}

// ---------- 导入：兼容各家 mcp.json ----------

export type ImportResult = {
  servers: McpServerConfig[];
  skipped: { name: string; reason: string }[];
  /** 从明文里抽出来、需要加密保存的密钥。只在服务端使用，不回给前端。 */
  secrets: { name: string; value: string }[];
  /** 配置里引用了、但导入文件里没给值的密钥名。 */
  secretsNeeded: string[];
};

const FOREIGN_REF = /\$\{(?:env|input|secret|var|envvar):([^}]+)\}/g;

function secretSafe(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return s || "SECRET";
}

function stripComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseImportText(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) bad("import content is empty");
  if (text.length > 200_000) bad("import content is too large");
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripComments(text));
    } catch {
      return bad("import content is not valid JSON");
    }
  }
}

type RawEntry = { name: string; value: Record<string, unknown> };

function collectEntries(root: unknown): RawEntry[] {
  if (Array.isArray(root)) {
    // Anthropic API 的 mcp_servers 数组
    return root.flatMap((item, i) => {
      const rec = asRecord(item);
      return rec ? [{ name: typeof rec.name === "string" ? rec.name : `server-${i + 1}`, value: rec }] : [];
    });
  }
  const rec = asRecord(root);
  if (!rec) return [];
  const fromMap = (map: unknown): RawEntry[] => {
    const m = asRecord(map);
    if (!m) return [];
    return Object.entries(m).flatMap(([name, value]) => {
      const entry = asRecord(value);
      return entry ? [{ name, value: entry }] : [];
    });
  };
  for (const key of ["mcpServers", "servers", "context_servers", "mcp_servers"]) {
    if (key in rec) {
      return Array.isArray(rec[key]) ? collectEntries(rec[key]) : fromMap(rec[key]);
    }
  }
  const nested = asRecord(rec.mcp);
  if (nested) {
    const inner = asRecord(nested.servers) ? nested.servers : nested;
    return fromMap(inner);
  }
  // 顶层直接是 name -> 配置
  const direct = fromMap(rec);
  if (direct.length && direct.every((e) => "url" in e.value || "command" in e.value || "serverUrl" in e.value || "httpUrl" in e.value)) {
    return direct;
  }
  // 单个 server
  if ("url" in rec || "serverUrl" in rec || "httpUrl" in rec) {
    return [{ name: typeof rec.name === "string" ? rec.name : "server", value: rec }];
  }
  return [];
}

export function normalizeImport(raw: unknown): ImportResult {
  const entries = collectEntries(parseImportText(raw));
  if (entries.length === 0) bad("no MCP servers found in the import content");
  const result: ImportResult = { servers: [], skipped: [], secrets: [], secretsNeeded: [] };
  const secretNames = new Set<string>();
  const needed = new Set<string>();
  const usedNames = new Set<string>();

  const takeSecretName = (base: string): string => {
    let name = secretSafe(base).toUpperCase();
    for (let n = 2; secretNames.has(name); n++) name = `${secretSafe(base).toUpperCase()}_${n}`.slice(0, 64);
    secretNames.add(name);
    return name;
  };

  /** 把别家的 ${env:X} / ${input:x} 换成 ${secret:X}，并把明文敏感值抽成新密钥。 */
  const convert = (text: string, label: string, sensitive: boolean, keepPrefix: boolean): string => {
    let out = text.replace(FOREIGN_REF, (_m, name: string) => {
      const secret = secretSafe(name);
      needed.add(secret);
      return `\${secret:${secret}}`;
    });
    if (sensitive && !hasRef(out) && out) {
      let prefix = "";
      let value = out;
      if (keepPrefix) {
        const m = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(out);
        if (m) {
          prefix = `${m[1]} `;
          value = m[2];
        }
      }
      const name = takeSecretName(label);
      result.secrets.push({ name, value });
      out = `${prefix}\${secret:${name}}`;
    }
    return out;
  };

  for (const { name: rawName, value } of entries) {
    const display = rawName.trim().slice(0, LIMITS.nameChars) || "server";
    const url = [value.url, value.serverUrl, value.httpUrl, value.endpoint].find((v) => typeof v === "string" && v) as
      | string
      | undefined;
    const type = String(value.type ?? value.transport ?? "").toLowerCase();
    if (!url) {
      const kind = typeof value.command === "string" || type === "stdio" || type === "local" ? "stdio" : "unknown";
      result.skipped.push({
        name: display,
        reason:
          kind === "stdio"
            ? "stdio (local command) servers cannot run on the gateway; only remote https servers are supported"
            : "no url found",
      });
      continue;
    }
    let lower = display.toLowerCase();
    for (let n = 2; usedNames.has(lower); n++) lower = `${display.toLowerCase()}-${n}`;
    usedNames.add(lower);
    const finalName = lower === display.toLowerCase() ? display : lower;
    const serverSlug = slugify(finalName, 24).toUpperCase().replace(/-/g, "_");

    const headers: Record<string, string> = {};
    const rawHeaders = asRecord(value.headers) ?? {};
    for (const [hname, hvalue] of Object.entries(rawHeaders)) {
      if (typeof hvalue !== "string") continue;
      if (FORBIDDEN_HEADER.test(hname)) continue;
      headers[hname] = convert(hvalue, `${serverSlug}_${hname}`, SENSITIVE_NAME.test(hname), true);
    }
    const token = value.authorization_token ?? value.authorizationToken;
    if (typeof token === "string" && token && !Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) {
      headers.Authorization = convert(`Bearer ${token}`, `${serverSlug}_AUTHORIZATION`, true, true);
    }

    let convertedUrl = url.replace(FOREIGN_REF, (_m, n: string) => {
      const secret = secretSafe(n);
      needed.add(secret);
      return `\${secret:${secret}}`;
    });
    const q = convertedUrl.indexOf("?");
    if (q >= 0) {
      const query = convertedUrl
        .slice(q + 1)
        .split("&")
        .map((pair) => {
          const eq = pair.indexOf("=");
          if (eq < 0) return pair;
          const key = pair.slice(0, eq);
          const v = pair.slice(eq + 1);
          let decoded = key;
          try {
            decoded = decodeURIComponent(key);
          } catch {
            // 保持原样
          }
          if (SENSITIVE_NAME.test(decoded) && v && !hasRef(v)) {
            let plain = v;
            try {
              plain = decodeURIComponent(v);
            } catch {
              // 保持原样
            }
            const secret = takeSecretName(`${serverSlug}_${decoded}`);
            result.secrets.push({ name: secret, value: plain });
            return `${key}=\${secret:${secret}}`;
          }
          return pair;
        })
        .join("&");
      convertedUrl = `${convertedUrl.slice(0, q)}?${query}`;
    }

    result.servers.push({
      id: slugify(finalName, 24),
      name: finalName,
      url: convertedUrl,
      transport: type.includes("sse") ? "sse" : type.includes("http") || type.includes("streamable") ? "http" : "auto",
      headers,
      enabled: value.disabled === true || value.enabled === false ? false : true,
      allowWrite: false,
    });
  }
  const made = new Set(result.secrets.map((s) => s.name));
  result.secretsNeeded = [...needed].filter((n) => !made.has(n));
  return result;
}
