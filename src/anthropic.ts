/** Claude 客户端走 /v1/messages，按上游协议改写，不按模型名分支。
 * responses：reasoning 放进 thinking.signature。chat：reasoning_content 放进 thinking 文本。
 * anthropic：思考块原样往返。工具结果里的图片丢掉，只留文本。
 * 客户端函数工具一律保留。服务端工具只在该上游真能执行时映射，否则丢掉，并改掉悬空的 tool_choice。
 */

export type MessagesWire = "anthropic" | "chat" | "responses";

const OPENCODE_ANTHROPIC = "https://opencode.ai/inference/go/anthropic/v1";
const OPENCODE_OPENAI = "https://opencode.ai/inference/go/openai/v1";
export const DEEPSEEK_ANTHROPIC = "https://api.deepseek.com/anthropic/v1";

type ChatMsg = {
  role: string;
  content: string | unknown[] | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  reasoning_content?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function modelName(model: string): string {
  const id = model.trim().toLowerCase();
  return id.slice(id.lastIndexOf("/") + 1);
}

function opencodeHost(host: string): boolean {
  return host === "opencode.ai" || host.endsWith(".opencode.ai");
}

/** 上游在配置里写了 messages 就用那个。没写才按地址猜：未知上游默认 chat。 */
export function messagesWire(baseUrl: string, model: string, declared?: MessagesWire): MessagesWire {
  if (declared) return declared;
  const host = hostOf(baseUrl);
  if (!host) return "chat";
  const name = modelName(model);
  if (host === "x.ai" || host.endsWith(".x.ai")) return "responses";
  if (host === "deepseek.com" || host.endsWith(".deepseek.com")) return "anthropic";
  if (host === "anthropic.com" || host.endsWith(".anthropic.com")) return "anthropic";
  if (host === "openai.com" || host.endsWith(".openai.com")) {
    if (name.startsWith("gpt-5") || name.startsWith("gpt-6") || /^o[1-9]/.test(name)) return "responses";
    return "chat";
  }
  if (opencodeHost(host)) {
    if (name.startsWith("grok") || name.startsWith("gpt")) return "responses";
    if (name.startsWith("qwen") || name.startsWith("claude")) return "anthropic";
    return "chat";
  }
  return "chat";
}

export function messagesTarget(baseUrl: string, wire: MessagesWire): { baseUrl: string; rest: string } {
  const opencode = opencodeHost(hostOf(baseUrl));
  if (wire === "responses") return { baseUrl: opencode ? OPENCODE_OPENAI : baseUrl, rest: "responses" };
  if (wire === "chat") return { baseUrl, rest: "chat/completions" };
  if (opencode) return { baseUrl: OPENCODE_ANTHROPIC, rest: "messages" };
  if (hostOf(baseUrl) === "deepseek.com" || hostOf(baseUrl).endsWith(".deepseek.com")) {
    return { baseUrl: DEEPSEEK_ANTHROPIC, rest: "messages" };
  }
  return { baseUrl, rest: "messages" };
}

/** DeepSeek 思考模式拒绝 required。千问的 messages 也不接受 any。 */
export function chatToolChoiceAny(baseUrl: string): "required" | "auto" {
  const host = hostOf(baseUrl);
  if (host === "deepseek.com" || host.endsWith(".deepseek.com")) return "auto";
  return "required";
}

export function relaxToolChoice(body: Record<string, unknown>): Record<string, unknown> {
  const choice = asRecord(body.tool_choice);
  if (choice?.type !== "any") return body;
  return { ...body, tool_choice: { type: "auto" } };
}

/** 客户端自己会执行的工具。带版本号的服务端工具、computer 这类没有函数 schema 的类型不算。 */
function isClientTool(tool: Record<string, unknown>): boolean {
  if (typeof tool.name !== "string" || !tool.name) return false;
  if (typeof tool.type !== "string") return true;
  return tool.type === "custom" || tool.type === "function";
}

function isDeepseekHostedTool(tool: Record<string, unknown>): boolean {
  return tool.name === "deepseek_web_search" || tool.name === "deepseek_read_url";
}

/** 非 Anthropic 官方的 messages 上游不托管服务端工具。滤掉之后不能留悬空的 tool_choice。 */
function withoutUnhosted(
  body: Record<string, unknown>,
  keep: (tool: Record<string, unknown>) => boolean = () => false,
): Record<string, unknown> {
  if (!Array.isArray(body.tools) && body.tool_choice === undefined) return body;
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter((tool) => {
    const rec = asRecord(tool);
    return rec != null && (isClientTool(rec) || keep(rec));
  });
  if (!tools.length) {
    const { tools: _tools, tool_choice: _choice, ...rest } = body;
    return rest;
  }
  const choice = asRecord(body.tool_choice);
  if (choice?.type === "tool" && !tools.some((tool) => asRecord(tool)?.name === choice.name)) {
    return { ...body, tools, tool_choice: { type: "auto" } };
  }
  return { ...body, tools };
}

function anthropicOfficial(baseUrl: string): boolean {
  const host = hostOf(baseUrl);
  return host === "anthropic.com" || host.endsWith(".anthropic.com");
}

export function prepareAnthropic(baseUrl: string, body: Record<string, unknown>): Record<string, unknown> {
  if (anthropicOfficial(baseUrl)) return withoutChatExtensions(body);
  const host = hostOf(baseUrl);
  const deepseek = host === "deepseek.com" || host.endsWith(".deepseek.com");
  const opencode = opencodeHost(host);
  let next = relaxToolChoice(deepseek ? body : withoutChatExtensions(body));
  if (opencode || deepseek) {
    const { output_config: _oc, context_management: _cm, ...rest } = next;
    next = rest;
  }
  next = withoutUnhosted(next, deepseek ? isDeepseekHostedTool : () => false);
  const thinking = asRecord(next.thinking);
  if (opencode && thinking?.type === "adaptive") {
    next = {
      ...next,
      thinking: {
        type: "enabled",
        ...(typeof thinking.budget_tokens === "number" ? { budget_tokens: thinking.budget_tokens } : {}),
      },
    };
  }
  const choice = asRecord(next.tool_choice);
  if (deepseek && choice?.type === "tool") return { ...next, thinking: { type: "disabled" } };
  return next;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (typeof part === "string") {
      out += part;
      continue;
    }
    const rec = asRecord(part);
    if (rec && (rec.type === "text" || rec.type === undefined) && typeof rec.text === "string") out += rec.text;
  }
  return out;
}

function imagePart(block: Record<string, unknown>): { type: "image_url"; image_url: { url: string } } | null {
  const source = asRecord(block.source);
  if (!source) return null;
  if (source.type === "base64" && typeof source.data === "string") {
    const media = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { type: "image_url", image_url: { url: `data:${media};base64,${source.data}` } };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

export type InlinedFile = { mediaType: string; data: string; filename?: string };

export function collectFileIds(payload: unknown): string[] {
  const ids = new Set<string>();
  const rec = asRecord(payload);
  const messages = rec && Array.isArray(rec.messages) ? rec.messages : [];
  for (const message of messages) {
    const content = asRecord(message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const source = asRecord(asRecord(block)?.source);
      if (source?.type === "file" && typeof source.file_id === "string" && source.file_id.trim()) {
        ids.add(source.file_id.trim());
      }
    }
  }
  return [...ids];
}

function rewriteFileSource(source: Record<string, unknown>, files: Map<string, InlinedFile>): Record<string, unknown> {
  if (source.type !== "file" || typeof source.file_id !== "string") return source;
  const file = files.get(source.file_id.trim());
  if (!file) return source;
  return {
    type: "base64",
    media_type: file.mediaType,
    data: file.data,
    ...(file.filename ? { filename: file.filename } : {}),
  };
}

/** DeepSeek Files API 的 file_id 只有 DS 认识。转 chat/responses 或其它 anthropic 上游前，换成 base64。 */
export function inlineFileIds(payload: Record<string, unknown>, files: Map<string, InlinedFile>): Record<string, unknown> {
  if (!files.size || !Array.isArray(payload.messages)) return payload;
  const messages = payload.messages.map((message) => {
    const rec = asRecord(message);
    if (!rec || !Array.isArray(rec.content)) return message;
    const content = rec.content.map((block) => {
      const item = asRecord(block);
      const source = asRecord(item?.source);
      if (!item || !source) return block;
      const next = rewriteFileSource(source, files);
      return next === source ? block : { ...item, source: next };
    });
    return { ...rec, content };
  });
  return { ...payload, messages };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function latestReminder(messages: unknown): string {
  let last = "";
  if (!Array.isArray(messages)) return last;
  for (const message of messages) {
    const rec = asRecord(message);
    if (rec?.role === "latest_reminder" && typeof rec.content === "string" && rec.content.trim()) {
      last = rec.content.trim();
    }
  }
  return last;
}

function clientMessages(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter((message) => {
    const rec = asRecord(message);
    return rec?.role === "user" || rec?.role === "assistant";
  });
}

function mergeSystem(system: unknown, extra: string): unknown {
  if (!extra) return system;
  if (typeof system === "string") return system ? `${system}\n${extra}` : extra;
  if (Array.isArray(system)) return [...system, { type: "text", text: extra }];
  return extra;
}

/** Chat Engine 的 latest_reminder 只有 DeepSeek 认识。其余上游并进 system，并丢掉未知角色。 */
function withoutChatExtensions(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  const reminder = latestReminder(body.messages);
  const messages = clientMessages(body.messages);
  if (messages.length === body.messages.length && !reminder) return body;
  return { ...body, messages, system: mergeSystem(body.system, reminder) };
}

function decodeBase64Text(data: string): string {
  try {
    const bin = atob(data);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function documentText(block: Record<string, unknown>): string {
  const source = asRecord(block.source);
  if (!source) return "";
  if (source.type === "base64" && typeof source.data === "string") {
    const media = typeof source.media_type === "string" ? source.media_type : "";
    if (media.startsWith("text/") || media === "application/json" || media === "application/xml") {
      return decodeBase64Text(source.data);
    }
  }
  const name = typeof source.filename === "string" && source.filename ? source.filename : "document";
  return `[attached ${name}]`;
}

function userMessages(content: unknown): ChatMsg[] {
  if (typeof content === "string") return [{ role: "user", content }];
  if (!Array.isArray(content)) return [{ role: "user", content: textOf(content) }];
  const out: ChatMsg[] = [];
  let parts: unknown[] = [];
  const flush = () => {
    if (!parts.length) return;
    const texts = parts.every((p) => asRecord(p)?.type === "text");
    out.push({ role: "user", content: texts ? textOf(parts) : parts });
    parts = [];
  };
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;
    if (rec.type === "tool_result") {
      flush();
      out.push({ role: "tool", tool_call_id: String(rec.tool_use_id ?? ""), content: textOf(rec.content) });
      continue;
    }
    if (rec.type === "image") {
      const img = imagePart(rec);
      if (img) parts.push(img);
      continue;
    }
    if (rec.type === "document") {
      const text = documentText(rec);
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (rec.type === "text") parts.push({ type: "text", text: typeof rec.text === "string" ? rec.text : "" });
  }
  flush();
  return out.length ? out : [{ role: "user", content: "" }];
}

function plainThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec || rec.type !== "thinking" || typeof rec.thinking !== "string") continue;
    if (typeof rec.signature === "string" && rec.signature.startsWith("grok1.")) continue;
    out += rec.thinking;
  }
  return out;
}

function assistantMessage(content: unknown): ChatMsg[] {
  if (typeof content === "string") return content ? [{ role: "assistant", content }] : [];
  if (!Array.isArray(content)) return [];
  let text = "";
  const toolCalls: unknown[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;
    if (rec.type === "text" && typeof rec.text === "string") text += rec.text;
    if (rec.type !== "tool_use") continue;
    const input = rec.input;
    toolCalls.push({
      id: String(rec.id ?? ""),
      type: "function",
      function: {
        name: String(rec.name ?? ""),
        arguments: typeof input === "string" ? input : JSON.stringify(input ?? {}),
      },
    });
  }
  const thought = plainThinking(content);
  if (!text && !toolCalls.length) {
    return thought ? [{ role: "assistant", content: "", reasoning_content: thought }] : [];
  }
  const msg: ChatMsg = { role: "assistant", content: text };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  if (thought) msg.reasoning_content = thought;
  return [msg];
}

function convertTools(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  const out: unknown[] = [];
  for (const tool of tools) {
    const rec = asRecord(tool);
    if (!rec || !isClientTool(rec)) continue;
    const schema = asRecord(rec.input_schema);
    out.push({
      type: "function",
      function: {
        name: rec.name,
        description: typeof rec.description === "string" ? rec.description : "",
        parameters: schema ?? { type: "object", properties: {} },
      },
    });
  }
  return out;
}

function convertToolChoice(choice: unknown, anyAs: "required" | "auto"): unknown {
  const rec = asRecord(choice);
  if (!rec) return undefined;
  if (rec.type === "auto" || rec.type === "none") return rec.type;
  if (rec.type === "any") return anyAs;
  if (rec.type === "tool" && typeof rec.name === "string") {
    return { type: "function", function: { name: rec.name } };
  }
  return undefined;
}

export function messagesToChat(
  body: Record<string, unknown>,
  anyToolChoice: "required" | "auto" = "required",
): Record<string, unknown> {
  const cleaned = withoutChatExtensions(body);
  const messages: ChatMsg[] = [];
  const system = textOf(cleaned.system);
  if (system) messages.push({ role: "system", content: system });
  if (Array.isArray(cleaned.messages)) {
    for (const message of cleaned.messages) {
      const rec = asRecord(message);
      if (!rec) continue;
      if (rec.role === "assistant") messages.push(...assistantMessage(rec.content));
      else if (rec.role === "user") messages.push(...userMessages(rec.content));
    }
  }
  const out: Record<string, unknown> = { model: cleaned.model, messages };
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;
  const tools = convertTools(body.tools);
  if (tools.length) out.tools = tools;
  const choice = keptChoice(body.tool_choice, tools, anyToolChoice);
  if (choice !== undefined) out.tool_choice = choice;
  const meta = asRecord(body.metadata);
  if (meta && typeof meta.user_id === "string" && meta.user_id) out.user = meta.user_id;
  return out;
}

function isServerWebSearch(tool: Record<string, unknown>): boolean {
  return tool.name === "web_search" && typeof tool.type === "string" && /^web_search_\d{8}$/.test(tool.type);
}

function domainList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item) continue;
    out.push(item);
    if (out.length === 5) break;
  }
  return out;
}

/** xAI / OpenAI 的 Responses 托管搜索。ponytail: 允许名单和排除名单不能同时给，各最多 5 个；两边都有时留允许名单。 */
function hostedWebSearch(tool: Record<string, unknown>): Record<string, unknown> {
  const allowed = domainList(tool.allowed_domains);
  const excluded = domainList(tool.blocked_domains);
  const filters: Record<string, string[]> = {};
  if (allowed.length) filters.allowed_domains = allowed;
  else if (excluded.length) filters.excluded_domains = excluded;
  return Object.keys(filters).length ? { type: "web_search", filters } : { type: "web_search" };
}

function responsesHostedSearch(baseUrl: string, declared?: boolean): boolean {
  if (declared != null) return declared;
  const host = hostOf(baseUrl);
  return host === "x.ai" || host.endsWith(".x.ai") || host === "openai.com" || host.endsWith(".openai.com");
}

function responseTools(tools: unknown, hostedSearch: boolean): unknown[] {
  const out: unknown[] = [];
  if (hostedSearch && Array.isArray(tools)) {
    for (const tool of tools) {
      const rec = asRecord(tool);
      if (rec && isServerWebSearch(rec)) out.push(hostedWebSearch(rec));
    }
  }
  for (const tool of convertTools(tools)) {
    const fn = asRecord(asRecord(tool)?.function);
    if (!fn || typeof fn.name !== "string") continue;
    out.push({
      type: "function",
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    });
  }
  return out;
}

function choiceName(choice: unknown): string {
  const rec = asRecord(choice);
  const fn = asRecord(rec?.function);
  if (typeof fn?.name === "string") return fn.name;
  return rec?.type === "function" && typeof rec.name === "string" ? rec.name : "";
}

function hasToolName(tools: unknown[], name: string): boolean {
  return tools.some((tool) => {
    const item = asRecord(tool);
    return item?.name === name || asRecord(item?.function)?.name === name;
  });
}

/** 点名的工具被滤掉时，不要把这个 tool_choice 原样发出去。 */
function keptChoice(choice: unknown, tools: unknown[], anyAs: "required" | "auto"): unknown {
  if (!tools.length) return undefined;
  const picked = convertToolChoice(choice, anyAs);
  if (picked === undefined) return undefined;
  const name = choiceName(picked);
  if (!name || hasToolName(tools, name)) return picked;
  const hostedOnly = tools.every((tool) => asRecord(tool)?.type === "web_search");
  return hostedOnly ? "required" : "auto";
}

function responseToolChoice(choice: unknown, tools: unknown[]): unknown {
  const picked = keptChoice(choice, tools, "required");
  const fn = asRecord(asRecord(picked)?.function);
  if (fn && typeof fn.name === "string") return { type: "function", name: fn.name };
  return picked;
}

const REASONING_MARK = "grok1.";

function packReasoning(items: Record<string, unknown>[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(items));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return REASONING_MARK + btoa(bin);
}

function unpackReasoning(signature: unknown): Record<string, unknown>[] {
  if (typeof signature !== "string" || !signature.startsWith(REASONING_MARK)) return [];
  try {
    const bin = atob(signature.slice(REASONING_MARK.length));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return reasoningFromOutput(parsed);
  } catch {
    return [];
  }
}

function reasoningFromOutput(output: unknown): Record<string, unknown>[] {
  if (!Array.isArray(output)) return [];
  const items: Record<string, unknown>[] = [];
  for (const item of output) {
    const rec = asRecord(item);
    if (rec?.type === "reasoning") items.push(rec);
  }
  return items;
}

function reasoningFromContent(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  const items: Record<string, unknown>[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec || (rec.type !== "thinking" && rec.type !== "redacted_thinking")) continue;
    items.push(...unpackReasoning(rec.signature));
  }
  return items;
}

function thinkingText(items: Record<string, unknown>[]): string {
  for (const item of items) {
    if (typeof item.summary === "string" && item.summary) return item.summary;
    if (!Array.isArray(item.summary)) continue;
    let text = "";
    for (const part of item.summary) {
      const rec = asRecord(part);
      if (typeof rec?.text === "string") text += rec.text;
    }
    if (text) return text;
  }
  return " ";
}

function responsesUserContent(content: unknown): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  if (typeof content === "string") {
    if (content) parts.push({ type: "input_text", text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  for (const item of content) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (rec.type === "text" && typeof rec.text === "string" && rec.text) {
      parts.push({ type: "input_text", text: rec.text });
    }
    if (rec.type === "image_url") {
      const url = asRecord(rec.image_url)?.url;
      if (typeof url === "string" && url) parts.push({ type: "input_image", image_url: url });
    }
  }
  return parts;
}

export function messagesToResponses(body: Record<string, unknown>, baseUrl = "", hostedSearch?: boolean): Record<string, unknown> {
  const cleaned = withoutChatExtensions(body);
  const input: Record<string, unknown>[] = [];
  const system = textOf(cleaned.system);
  if (system) input.push({ role: "system", content: system });
  if (Array.isArray(cleaned.messages)) {
    for (const message of cleaned.messages) {
      const rec = asRecord(message);
      if (!rec) continue;
      if (rec.role === "assistant") {
        for (const item of reasoningFromContent(rec.content)) input.push(item);
        for (const part of assistantMessage(rec.content)) {
          if (typeof part.content === "string" && part.content) input.push({ role: "assistant", content: part.content });
          for (const call of part.tool_calls ?? []) {
            const item = asRecord(call);
            const fn = asRecord(item?.function);
            input.push({
              type: "function_call",
              call_id: String(item?.id ?? ""),
              name: String(fn?.name ?? ""),
              arguments: String(fn?.arguments ?? "{}"),
            });
          }
        }
        continue;
      }
      if (rec.role !== "user") continue;
      for (const part of userMessages(rec.content)) {
        if (part.role === "tool") {
          input.push({
            type: "function_call_output",
            call_id: part.tool_call_id ?? "",
            output: typeof part.content === "string" ? part.content : "",
          });
          continue;
        }
        if (typeof part.content === "string") {
          if (part.content) input.push({ role: "user", content: part.content });
          continue;
        }
        const content = responsesUserContent(part.content);
        if (content.length) input.push({ role: "user", content });
      }
    }
  }
  const out: Record<string, unknown> = {
    model: cleaned.model,
    input,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  if (typeof body.max_tokens === "number") out.max_output_tokens = body.max_tokens;
  if (body.stream === true) out.stream = true;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  const tools = responseTools(body.tools, responsesHostedSearch(baseUrl, hostedSearch));
  if (tools.length) out.tools = tools;
  const choice = responseToolChoice(body.tool_choice, tools);
  if (choice !== undefined) out.tool_choice = choice;
  return out;
}

function parsedInput(raw: unknown): unknown {
  if (typeof raw !== "string") return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value !== null && typeof value === "object" ? value : { raw };
  } catch {
    return raw ? { raw } : {};
  }
}

function stopReason(finish: unknown, hadTools: boolean): string {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls" || hadTools) return "tool_use";
  return "end_turn";
}

export function chatToMessage(json: unknown, fallbackModel = ""): Record<string, unknown> {
  const rec = asRecord(json) ?? {};
  const choice = asRecord(Array.isArray(rec.choices) ? rec.choices[0] : null) ?? {};
  const msg = asRecord(choice.message) ?? {};
  const content: Record<string, unknown>[] = [];
  const text = textOf(msg.content);
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
    content.push({ type: "thinking", thinking: msg.reasoning_content });
  }
  if (text) content.push({ type: "text", text });
  if (Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) {
      const item = asRecord(call);
      const fn = asRecord(item?.function);
      if (!item || !fn) continue;
      content.push({
        type: "tool_use",
        id: String(item.id ?? ""),
        name: String(fn.name ?? ""),
        input: parsedInput(fn.arguments),
      });
    }
  }
  return {
    id: typeof rec.id === "string" ? rec.id : "msg",
    type: "message",
    role: "assistant",
    model: typeof rec.model === "string" ? rec.model : fallbackModel,
    content,
    stop_reason: stopReason(choice.finish_reason, content.some((block) => block.type === "tool_use")),
    stop_sequence: null,
    usage: usageFields(rec),
  };
}

function responseText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    const rec = asRecord(part);
    if (!rec || typeof rec.text !== "string") continue;
    if (rec.type === "output_text" || rec.type === "text" || rec.type == null) out += rec.text;
  }
  return out;
}

type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * 上游用量换成 Anthropic 口径：input_tokens 不含缓存，缓存读写单列，三者相加才是整段输入。
 * OpenAI 系的 prompt_tokens 已含缓存命中，要减掉；上游本来就按 Anthropic 口径给的则原样用。
 */
function readTokenUsage(usage: Record<string, unknown> | null): TokenUsage {
  const u = usage ?? {};
  const details = asRecord(u.prompt_tokens_details) ?? asRecord(u.input_tokens_details) ?? {};
  const prompt = num(u.prompt_tokens) ?? num(u.input_tokens) ?? 0;
  const anthropicStyle = num(u.cache_read_input_tokens) !== null || num(u.cache_creation_input_tokens) !== null;
  const cacheRead =
    num(u.cache_read_input_tokens) ?? num(details.cached_tokens) ?? num(u.prompt_cache_hit_tokens) ?? 0;
  const cacheWrite = num(u.cache_creation_input_tokens) ?? num(details.cache_write_tokens) ?? 0;
  return {
    input: anthropicStyle ? prompt : Math.max(0, prompt - cacheRead - cacheWrite),
    output: num(u.completion_tokens) ?? num(u.output_tokens) ?? 0,
    cacheRead,
    cacheWrite,
  };
}

function usageFields(rec: Record<string, unknown>): Record<string, unknown> {
  const t = readTokenUsage(asRecord(rec.usage));
  return {
    input_tokens: t.input,
    output_tokens: t.output,
    cache_creation_input_tokens: t.cacheWrite,
    cache_read_input_tokens: t.cacheRead,
  };
}

export function responsesToMessage(json: unknown, fallbackModel = ""): Record<string, unknown> {
  const rec = asRecord(json) ?? {};
  const content: Record<string, unknown>[] = [];
  const reasoning = reasoningFromOutput(rec.output);
  if (reasoning.length) {
    content.push({ type: "thinking", thinking: thinkingText(reasoning), signature: packReasoning(reasoning) });
  }
  if (Array.isArray(rec.output)) {
    for (const item of rec.output) {
      const block = asRecord(item);
      if (!block) continue;
      if (block.type === "function_call") {
        content.push({
          type: "tool_use",
          id: String(block.call_id ?? block.id ?? ""),
          name: String(block.name ?? ""),
          input: parsedInput(block.arguments),
        });
        continue;
      }
      const text = responseText(block.content);
      if (text) content.push({ type: "text", text });
    }
  }
  return {
    id: typeof rec.id === "string" ? rec.id : "msg",
    type: "message",
    role: "assistant",
    model: typeof rec.model === "string" ? rec.model : fallbackModel,
    content,
    stop_reason: stopReason(rec.status === "incomplete" ? "length" : null, content.some((block) => block.type === "tool_use")),
    stop_sequence: null,
    usage: usageFields(rec),
  };
}

export function chatErrorToAnthropic(status: number, body: unknown): Record<string, unknown> {
  let message = "";
  const rec = asRecord(body);
  if (rec) {
    if (typeof rec.message === "string") message = rec.message;
    const err = rec.error;
    if (typeof err === "string") message = err;
    const errRec = asRecord(err);
    if (errRec && typeof errRec.message === "string") message = errRec.message;
  } else if (typeof body === "string") message = body.slice(0, 500);
  if (!message) message = `Upstream error (${status})`;
  const type =
    status === 404
      ? "not_found_error"
      : status === 429
        ? "rate_limit_error"
        : status === 401 || status === 403
          ? "authentication_error"
          : status === 400
            ? "invalid_request_error"
            : "api_error";
  return { type: "error", error: { type, message } };
}

type SseState = {
  started: boolean;
  closed: boolean;
  id: string;
  model: string;
  next: number;
  textIndex: number;
  tools: Map<number, number>;
  hadTools: boolean;
  finish: unknown;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

function hasTokenCounts(u: Record<string, unknown>): boolean {
  return ["prompt_tokens", "input_tokens", "completion_tokens", "output_tokens"].some((k) => num(u[k]) !== null);
}

function applyUsage(t: TokenUsage): Pick<SseState, "input" | "output" | "cacheRead" | "cacheWrite"> {
  return { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite };
}

/** message_start 发出时上游的用量往往还没到，所以收尾的 message_delta 要把完整用量再带一遍。 */
function finalUsage(state: SseState): Record<string, number> {
  return {
    input_tokens: state.input,
    output_tokens: state.output,
    cache_creation_input_tokens: state.cacheWrite,
    cache_read_input_tokens: state.cacheRead,
  };
}

function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function chatSseToAnthropic(stream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const state: SseState = {
    started: false,
    closed: false,
    id: "msg",
    model,
    next: 0,
    textIndex: -1,
    tools: new Map(),
    hadTools: false,
    finish: null,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const decoder = new TextDecoder();
  let buf = "";
  let thoughtIndex = -1;

  const closeThought = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (thoughtIndex < 0) return;
    controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: thoughtIndex }));
    thoughtIndex = -1;
  };

  const ensureStart = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (state.started) return;
    state.started = true;
    controller.enqueue(
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: state.id,
          type: "message",
          role: "assistant",
          model: state.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...finalUsage(state), output_tokens: 0 },
        },
      }),
    );
  };

  const closeText = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (state.textIndex < 0) return;
    controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: state.textIndex }));
    state.textIndex = -1;
  };

  const finish = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (state.closed) return;
    ensureStart(controller);
    closeThought(controller);
    closeText(controller);
    for (const index of state.tools.values()) {
      controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index }));
    }
    state.tools.clear();
    controller.enqueue(
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason(state.finish, state.hadTools), stop_sequence: null },
        usage: finalUsage(state),
      }),
    );
    controller.enqueue(sseEvent("message_stop", { type: "message_stop" }));
    state.closed = true;
  };

  const onData = (controller: ReadableStreamDefaultController<Uint8Array>, data: string) => {
    if (state.closed) return;
    if (data === "[DONE]") {
      finish(controller);
      return;
    }
    let json: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data) as unknown;
      const rec = asRecord(parsed);
      if (!rec) return;
      json = rec;
    } catch {
      return;
    }
    if (typeof json.id === "string") state.id = json.id;
    if (typeof json.model === "string") state.model = json.model;
    const usage = asRecord(json.usage);
    if (usage && hasTokenCounts(usage)) Object.assign(state, applyUsage(readTokenUsage(usage)));
    const choice = asRecord(Array.isArray(json.choices) ? json.choices[0] : null);
    if (!choice) return;
    if (choice.finish_reason != null) state.finish = choice.finish_reason;
    const delta = asRecord(choice.delta);
    if (!delta) return;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      ensureStart(controller);
      if (thoughtIndex < 0) {
        thoughtIndex = state.next++;
        controller.enqueue(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: thoughtIndex,
            content_block: { type: "thinking", thinking: "" },
          }),
        );
      }
      controller.enqueue(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: thoughtIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        }),
      );
    }
    if (typeof delta.content === "string" && delta.content) {
      ensureStart(controller);
      closeThought(controller);
      if (state.textIndex < 0) {
        state.textIndex = state.next++;
        controller.enqueue(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: state.textIndex,
            content_block: { type: "text", text: "" },
          }),
        );
      }
      controller.enqueue(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.textIndex,
          delta: { type: "text_delta", text: delta.content },
        }),
      );
    }
    if (!Array.isArray(delta.tool_calls)) return;
    ensureStart(controller);
    closeThought(controller);
    closeText(controller);
    for (const call of delta.tool_calls) {
      const item = asRecord(call);
      if (!item) continue;
      const toolIndex = num(item.index) ?? 0;
      const fn = asRecord(item.function);
      let block = state.tools.get(toolIndex);
      if (block == null) {
        block = state.next++;
        state.tools.set(toolIndex, block);
        state.hadTools = true;
        controller.enqueue(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: block,
            content_block: {
              type: "tool_use",
              id: typeof item.id === "string" && item.id ? item.id : `tool_${toolIndex}`,
              name: typeof fn?.name === "string" ? fn.name : "",
              input: {},
            },
          }),
        );
      }
      if (typeof fn?.arguments === "string" && fn.arguments) {
        controller.enqueue(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: block,
            delta: { type: "input_json_delta", partial_json: fn.arguments },
          }),
        );
      }
    }
  };

  const onLine = (controller: ReadableStreamDefaultController<Uint8Array>, line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    onData(controller, trimmed.slice(5).trim());
  };

  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) onLine(controller, line);
        }
        if (buf) onLine(controller, buf);
        finish(controller);
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export function responsesSseToAnthropic(stream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const state: SseState = {
    started: false,
    closed: false,
    id: "msg",
    model,
    next: 0,
    textIndex: -1,
    tools: new Map(),
    hadTools: false,
    finish: null,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const decoder = new TextDecoder();
  let buf = "";
  let lastTool = -1;
  let reasoningItems: Record<string, unknown>[] = [];
  let reasoningSent = false;

  const rememberReasoning = (item: Record<string, unknown> | null) => {
    if (!item || item.type !== "reasoning") return;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) {
      reasoningItems.push(item);
      return;
    }
    const at = reasoningItems.findIndex((entry) => entry.id === id);
    if (at >= 0) reasoningItems[at] = item;
    else reasoningItems.push(item);
  };

  const ensureStart = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (state.started) return;
    state.started = true;
    controller.enqueue(
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: state.id,
          type: "message",
          role: "assistant",
          model: state.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...finalUsage(state), output_tokens: 0 },
        },
      }),
    );
  };
  const closeText = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (state.textIndex < 0) return;
    controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: state.textIndex }));
    state.textIndex = -1;
  };
  const emitReasoning = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (reasoningSent || !reasoningItems.length) return;
    reasoningSent = true;
    const index = state.next++;
    controller.enqueue(
      sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: thinkingText(reasoningItems) },
      }),
    );
    controller.enqueue(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: packReasoning(reasoningItems) },
      }),
    );
    controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index }));
  };
  const finish = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (state.closed) return;
    ensureStart(controller);
    closeText(controller);
    for (const index of state.tools.values()) {
      controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index }));
    }
    state.tools.clear();
    emitReasoning(controller);
    controller.enqueue(
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason(state.finish, state.hadTools), stop_sequence: null },
        usage: finalUsage(state),
      }),
    );
    controller.enqueue(sseEvent("message_stop", { type: "message_stop" }));
    state.closed = true;
  };
  const onData = (controller: ReadableStreamDefaultController<Uint8Array>, data: string) => {
    if (state.closed || data === "[DONE]") {
      if (data === "[DONE]") finish(controller);
      return;
    }
    let json: Record<string, unknown>;
    try {
      const rec = asRecord(JSON.parse(data) as unknown);
      if (!rec) return;
      json = rec;
    } catch {
      return;
    }
    const response = asRecord(json.response);
    if (response) {
      if (typeof response.id === "string") state.id = response.id;
      if (typeof response.model === "string") state.model = response.model;
      const usage = asRecord(response.usage);
      if (usage && hasTokenCounts(usage)) Object.assign(state, applyUsage(readTokenUsage(usage)));
      if (response.status === "incomplete") state.finish = "length";
      const found = reasoningFromOutput(response.output);
      if (found.length) reasoningItems = found;
    }
    if (json.type === "response.output_item.added" || json.type === "response.output_item.done") {
      rememberReasoning(asRecord(json.item));
    }
    if (json.type === "response.output_text.delta" && typeof json.delta === "string" && json.delta) {
      ensureStart(controller);
      if (state.textIndex < 0) {
        state.textIndex = state.next++;
        controller.enqueue(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: state.textIndex,
            content_block: { type: "text", text: "" },
          }),
        );
      }
      controller.enqueue(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.textIndex,
          delta: { type: "text_delta", text: json.delta },
        }),
      );
      return;
    }
    if (json.type === "response.output_item.added") {
      const item = asRecord(json.item);
      if (item?.type !== "function_call") return;
      ensureStart(controller);
      closeText(controller);
      const toolIndex = num(json.output_index) ?? state.next;
      const block = state.next++;
      state.tools.set(toolIndex, block);
      lastTool = toolIndex;
      state.hadTools = true;
      controller.enqueue(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: block,
          content_block: {
            type: "tool_use",
            id: typeof item.call_id === "string" && item.call_id ? item.call_id : `tool_${toolIndex}`,
            name: typeof item.name === "string" ? item.name : "",
            input: {},
          },
        }),
      );
      if (typeof item.arguments === "string" && item.arguments) {
        controller.enqueue(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: block,
            delta: { type: "input_json_delta", partial_json: item.arguments },
          }),
        );
      }
      return;
    }
    if (json.type === "response.function_call_arguments.delta" && typeof json.delta === "string" && json.delta) {
      const toolIndex = num(json.output_index) ?? lastTool;
      const block = state.tools.get(toolIndex);
      if (block == null) return;
      controller.enqueue(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: block,
          delta: { type: "input_json_delta", partial_json: json.delta },
        }),
      );
      return;
    }
    if (json.type === "response.completed" || json.type === "response.incomplete" || json.type === "response.failed") {
      finish(controller);
    }
  };
  const onLine = (controller: ReadableStreamDefaultController<Uint8Array>, line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    onData(controller, trimmed.slice(5).trim());
  };
  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) onLine(controller, line);
        }
        if (buf) onLine(controller, buf);
        finish(controller);
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
