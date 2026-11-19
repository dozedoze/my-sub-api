/** Claude Code 走 /v1/messages。按上游实际协议改写：
 * Grok 走 responses，reasoning 项放进 thinking.signature，下一轮原样带回。
 * DeepSeek、OpenCode 千问走各自的 Anthropic messages，思考块原样往返。
 * Kimi 等 chat 模型把 reasoning_content 放进 thinking 文本，下一轮写回该字段。
 * 工具结果里的图片丢掉，只留文本。
 */

export type MessagesWire = "anthropic" | "chat" | "responses";

const OPENCODE_ANTHROPIC = "https://opencode.ai/inference/go/anthropic/v1";
const OPENCODE_OPENAI = "https://opencode.ai/inference/go/openai/v1";
const DEEPSEEK_ANTHROPIC = "https://api.deepseek.com/anthropic/v1";

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

/** 目录来自 https://opencode.ai/zen/go/v1/models 的 api 字段。
 * OpenCode：Grok/GPT 走 responses，千问/Claude 走 messages，GLM 等走 chat。
 * 独立上游：xAI responses，DeepSeek/Anthropic messages，OpenAI 的 gpt-5+/o 系列 responses。 */
export function messagesWire(baseUrl: string, model: string): MessagesWire {
  const host = hostOf(baseUrl);
  if (!host) return "anthropic";
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

export function prepareAnthropic(baseUrl: string, body: Record<string, unknown>): Record<string, unknown> {
  const host = hostOf(baseUrl);
  const deepseek = host === "deepseek.com" || host.endsWith(".deepseek.com");
  if (!opencodeHost(host) && !deepseek) return body;
  const next = relaxToolChoice(body);
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
    if (!rec || typeof rec.name !== "string" || !rec.name) continue;
    if (typeof rec.type === "string" && rec.type !== "custom" && rec.type !== "function") continue;
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
  const messages: ChatMsg[] = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: "system", content: system });
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const rec = asRecord(message);
      if (!rec) continue;
      if (rec.role === "assistant") messages.push(...assistantMessage(rec.content));
      else if (rec.role === "user") messages.push(...userMessages(rec.content));
    }
  }
  const out: Record<string, unknown> = { model: body.model, messages };
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
  const choice = convertToolChoice(body.tool_choice, anyToolChoice);
  if (choice !== undefined) out.tool_choice = choice;
  const meta = asRecord(body.metadata);
  if (meta && typeof meta.user_id === "string" && meta.user_id) out.user = meta.user_id;
  return out;
}

function responseTools(tools: unknown): unknown[] {
  const out: unknown[] = [];
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

function responseToolChoice(choice: unknown): unknown {
  const picked = convertToolChoice(choice, "required");
  const rec = asRecord(picked);
  const fn = asRecord(rec?.function);
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

export function messagesToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  const system = textOf(body.system);
  if (system) input.push({ role: "system", content: system });
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
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
        const text = typeof part.content === "string" ? part.content : textOf(part.content);
        if (text) input.push({ role: "user", content: text });
      }
    }
  }
  const out: Record<string, unknown> = {
    model: body.model,
    input,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  if (typeof body.max_tokens === "number") out.max_output_tokens = body.max_tokens;
  if (body.stream === true) out.stream = true;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  const tools = responseTools(body.tools);
  if (tools.length) out.tools = tools;
  const choice = responseToolChoice(body.tool_choice);
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

function usageFields(rec: Record<string, unknown>): Record<string, unknown> {
  const usage = asRecord(rec.usage) ?? {};
  return {
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
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
};

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
          usage: {
            input_tokens: state.input,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
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
        usage: { output_tokens: state.output },
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
    if (usage) {
      state.input = num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? state.input;
      state.output = num(usage.completion_tokens) ?? num(usage.output_tokens) ?? state.output;
    }
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
          usage: {
            input_tokens: state.input,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
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
        usage: { output_tokens: state.output },
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
      if (usage) {
        state.input = num(usage.input_tokens) ?? state.input;
        state.output = num(usage.output_tokens) ?? state.output;
      }
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
