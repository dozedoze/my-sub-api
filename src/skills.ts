import { loadSkills, type HostedSkillId, type SkillsConfig } from "./keys.ts";
import { corsHeaders, GatewayError } from "./lib.ts";

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function envSecret(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

export function searchConfigured(env: Env): boolean {
  return Boolean(envSecret(env, "TAVILY_API_KEY") || envSecret(env, "BRAVE_API_KEY"));
}

export function liveSkillIds(config: SkillsConfig, env: Env): HostedSkillId[] {
  return config.enabled.filter((id) => id !== "web_search" || searchConfigured(env));
}

/** Anthropic 形状的工具声明；chat/completions 时再包成 function。 */
export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

type SkillTool = ToolDef & { name: HostedSkillId };

const SEARCH_TOOL: SkillTool = {
  name: "web_search",
  description: "Search the web. Use for current events, facts, or anything that may have changed.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  },
};

const FETCH_TOOL: SkillTool = {
  name: "fetch_url",
  description: "Fetch a public http(s) page and return extracted text.",
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "https URL to read" } },
    required: ["url"],
  },
};

const ANTHROPIC_TOOLS: Record<HostedSkillId, SkillTool> = {
  web_search: SEARCH_TOOL,
  fetch_url: FETCH_TOOL,
};

function openaiTool(skill: ToolDef) {
  return {
    type: "function",
    function: {
      name: skill.name,
      description: skill.description,
      parameters: skill.input_schema,
    },
  };
}

function existingNames(tools: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(tools)) return names;
  for (const tool of tools) {
    const rec = asRecord(tool);
    if (!rec) continue;
    if (typeof rec.name === "string") names.add(rec.name);
    const fn = asRecord(rec.function);
    if (typeof fn?.name === "string") names.add(fn.name);
  }
  return names;
}

/**
 * 挂上托管工具，以及用户自己的 MCP / Skill 工具。客户端已经有同名工具就不挂。
 * @returns 实际挂上的 extra 工具名，只有这些名字的调用才由网关接手。
 */
export function injectHostedSkills(
  body: Record<string, unknown>,
  rest: string,
  enabled: HostedSkillId[],
  userTools: ToolDef[] = [],
): string[] {
  const names = existingNames(body.tools);
  // DeepSeek 自带搜索时不重复挂 web_search
  if (names.has("deepseek_web_search") || names.has("deepseek_read_url")) {
    enabled = enabled.filter((id) => id !== "web_search" && id !== "fetch_url");
  }
  const hosted: ToolDef[] = enabled.filter((id) => !names.has(id)).map((id) => ANTHROPIC_TOOLS[id]);
  const mine = userTools.filter((tool) => !names.has(tool.name));
  const extra = [...hosted, ...mine];
  if (!extra.length) return [];
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  if (rest === "chat/completions" || rest === "completions") {
    tools.push(...extra.map(openaiTool));
  } else {
    tools.push(...extra);
  }
  body.tools = tools;
  return mine.map((tool) => tool.name);
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return asRecord(parsed) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(raw) ?? {};
}

export function extractHostedCalls(json: unknown, rest: string, enabled: readonly string[]): ToolCall[] {
  const allow = new Set(enabled);
  const out: ToolCall[] = [];
  const rec = asRecord(json);
  if (!rec) return out;
  if (rest === "messages") {
    const content = rec.content;
    if (!Array.isArray(content)) return out;
    for (const block of content) {
      const b = asRecord(block);
      if (!b || b.type !== "tool_use" || typeof b.id !== "string" || typeof b.name !== "string") continue;
      if (!allow.has(b.name)) continue;
      out.push({ id: b.id, name: b.name, input: parseArgs(b.input) });
    }
    return out;
  }
  const choices = rec.choices;
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : null;
  const message = asRecord(choice?.message);
  const calls = message?.tool_calls;
  if (!Array.isArray(calls)) return out;
  for (const call of calls) {
    const c = asRecord(call);
    const fn = asRecord(c?.function);
    if (!c || typeof c.id !== "string" || typeof fn?.name !== "string") continue;
    if (!allow.has(fn.name)) continue;
    out.push({ id: c.id, name: fn.name, input: parseArgs(fn.arguments) });
  }
  return out;
}

export function appendSkillResults(
  body: Record<string, unknown>,
  modelJson: unknown,
  results: { id: string; name: string; content: string }[],
  rest: string,
): Record<string, unknown> {
  if (rest === "messages") {
    const messages = Array.isArray(body.messages) ? [...body.messages] : [];
    const rec = asRecord(modelJson);
    const content = Array.isArray(rec?.content) ? rec.content : [];
    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content })),
    });
    return { ...body, messages };
  }
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  const rec = asRecord(modelJson);
  const choices = rec?.choices;
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : null;
  const assistant = asRecord(choice?.message) ?? { role: "assistant", content: null };
  messages.push(assistant);
  for (const r of results) {
    messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }
  return { ...body, messages };
}

function urlAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
  return true;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function runWebSearch(env: Env, query: string): Promise<string> {
  const q = query.trim();
  if (!q) return "empty query";
  const tavily = envSecret(env, "TAVILY_API_KEY");
  if (tavily) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: tavily, query: q, max_results: 5, search_depth: "basic" }),
    });
    const text = await res.text();
    if (!res.ok) return `search failed (${res.status})`;
    return text.slice(0, 12_000);
  }
  const brave = envSecret(env, "BRAVE_API_KEY");
  if (brave) {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`, {
      headers: { Accept: "application/json", "X-Subscription-Token": brave },
    });
    const text = await res.text();
    if (!res.ok) return `search failed (${res.status})`;
    return text.slice(0, 12_000);
  }
  return "web_search is not configured";
}

async function runFetchUrl(raw: string): Promise<string> {
  if (!urlAllowed(raw)) return "url is not allowed";
  const res = await fetch(raw, { redirect: "follow", headers: { Accept: "text/html, text/plain;q=0.9" } });
  const text = await res.text();
  if (!res.ok) return `fetch failed (${res.status})`;
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("html") ? stripHtml(text) : text;
  return body.slice(0, 24_000) || "(empty)";
}

export async function runHostedSkill(env: Env, call: ToolCall): Promise<string> {
  if (call.name === "web_search") {
    return runWebSearch(env, typeof call.input.query === "string" ? call.input.query : "");
  }
  if (call.name === "fetch_url") {
    return runFetchUrl(typeof call.input.url === "string" ? call.input.url : "");
  }
  return `unknown skill ${call.name}`;
}

function sseFromAnthropic(json: Record<string, unknown>): string {
  const id = typeof json.id === "string" ? json.id : crypto.randomUUID();
  const model = typeof json.model === "string" ? json.model : "";
  const blocks = Array.isArray(json.content) ? json.content : [{ type: "text", text: "" }];
  const lines: string[] = [];
  const ev = (event: string, data: unknown) => {
    lines.push(`event: ${event}`);
    lines.push(`data: ${JSON.stringify(data)}`);
    lines.push("");
  };
  ev("message_start", { type: "message_start", message: { id, model, role: "assistant", content: [] } });
  let i = 0;
  for (const block of blocks) {
    const rec = asRecord(block);
    if (!rec || rec.type !== "text") continue;
    const text = typeof rec.text === "string" ? rec.text : "";
    ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
    if (text) ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text } });
    ev("content_block_stop", { type: "content_block_stop", index: i });
    i += 1;
  }
  if (i === 0) {
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
  }
  ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } });
  ev("message_stop", { type: "message_stop" });
  return lines.join("\n");
}

function sseFromChat(json: Record<string, unknown>): string {
  const id = typeof json.id === "string" ? json.id : "chatcmpl-skill";
  const model = typeof json.model === "string" ? json.model : "";
  const choices = json.choices;
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : null;
  const message = asRecord(choice?.message);
  const text = typeof message?.content === "string" ? message.content : "";
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  };
  const done = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`;
}

export function skillFinalResponse(json: unknown, rest: string, wantStream: boolean, request: Request, status: number): Response {
  const rec = asRecord(json) ?? {};
  const headers = new Headers(corsHeaders(request));
  if (!wantStream) {
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(json), { status, headers });
  }
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");
  const body = rest === "messages" ? sseFromAnthropic(rec) : sseFromChat(rec);
  return new Response(body, { status: 200, headers });
}

export async function loadLiveSkills(env: Env): Promise<{ config: SkillsConfig; enabled: HostedSkillId[] }> {
  const config = await loadSkills(env.KEYS);
  return { config, enabled: liveSkillIds(config, env) };
}

export function copyJsonRequest(request: Request, body: unknown): Request {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) });
}

export function assertJsonBody(payload: unknown): Record<string, unknown> {
  const rec = asRecord(payload);
  if (!rec) throw new GatewayError(400, "invalid_request", "Invalid JSON body");
  return rec;
}
