import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatErrorToAnthropic,
  chatSseToAnthropic,
  chatToMessage,
  messagesTarget,
  messagesToChat,
  messagesToResponses,
  messagesWire,
  prepareAnthropic,
  relaxToolChoice,
  responsesSseToAnthropic,
  responsesToMessage,
} from "./anthropic.ts";

test("messagesWire follows the upstream protocol", () => {
  assert.equal(messagesWire("https://api.x.ai/v1", "grok-4.6"), "responses");
  assert.equal(messagesWire("https://api.deepseek.com/v1", "deepseek-v4-pro"), "anthropic");
  assert.equal(messagesWire("https://opencode.ai/zen/go/v1", "kimi-k3"), "chat");
  assert.equal(messagesWire("https://opencode.ai/zen/go/v1", "glm-5.3"), "chat");
  assert.equal(messagesWire("https://opencode.ai/zen/go/v1", "grok-4.7"), "responses");
  assert.equal(messagesWire("https://opencode.ai/zen/go/v1", "gpt-5.6-luna"), "responses");
  assert.equal(messagesWire("https://opencode.ai/zen/go/v1", "qwen3.8-flash"), "anthropic");
  assert.equal(messagesWire("https://opencode.ai/zen/go/v1", "qwen4-max"), "anthropic");
  assert.equal(messagesWire("https://opencode.ai/zen/go/v1", "claude-haiku-5-5"), "anthropic");
  assert.equal(messagesWire("https://api.anthropic.com/v1", "claude-sonnet-5"), "anthropic");
  assert.equal(messagesWire("https://api.openai.com/v1", "gpt-4o"), "chat");
  assert.equal(messagesWire("https://api.openai.com/v1", "gpt-5.4"), "responses");
  assert.equal(messagesWire("https://api.openai.com/v1", "o3"), "responses");
  assert.deepEqual(messagesTarget("https://api.x.ai/v1", "responses"), {
    baseUrl: "https://api.x.ai/v1",
    rest: "responses",
  });
  assert.deepEqual(messagesTarget("https://opencode.ai/zen/go/v1", "responses"), {
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    rest: "responses",
  });
  assert.deepEqual(messagesTarget("https://opencode.ai/zen/go/v1", "anthropic"), {
    baseUrl: "https://opencode.ai/inference/go/anthropic/v1",
    rest: "messages",
  });
  assert.deepEqual(messagesTarget("https://api.deepseek.com/v1", "anthropic"), {
    baseUrl: "https://api.deepseek.com/anthropic/v1",
    rest: "messages",
  });
  assert.equal(relaxToolChoice({ model: "qwen4-max", tool_choice: { type: "any" } }).tool_choice.type, "auto");
  assert.deepEqual(
    prepareAnthropic("https://api.deepseek.com/v1", { tool_choice: { type: "tool", name: "bash" } }).thinking,
    { type: "disabled" },
  );
  assert.deepEqual(
    prepareAnthropic("https://opencode.ai/zen/go/v1", {
      thinking: { type: "adaptive", budget_tokens: 8 },
      output_config: { effort: "high" },
    }).thinking,
    { type: "enabled", budget_tokens: 8 },
  );
  assert.equal(
    "output_config" in
      prepareAnthropic("https://opencode.ai/zen/go/v1", { thinking: { type: "enabled" }, output_config: { effort: "high" } }),
    false,
  );
});

test("messagesToChat rewrites tools and tool results", () => {
  const chat = messagesToChat({
    model: "grok-4.6",
    max_tokens: 32,
    stream: true,
    system: [{ type: "text", text: "sys" }],
    tool_choice: { type: "any" },
    tools: [
      { name: "bash", description: "run", input_schema: { type: "object", properties: { cmd: { type: "string" } } } },
      { type: "computer_20250124", name: "computer" },
    ],
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "ok" },
          { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file" }] },
    ],
  });
  assert.equal(chat.model, "grok-4.6");
  assert.equal(chat.max_tokens, 32);
  assert.equal(chat.stream, true);
  assert.deepEqual((chat.stream_options as { include_usage: boolean }).include_usage, true);
  assert.equal(chat.tool_choice, "required");
  assert.equal(messagesToChat({ model: "deepseek-v4-pro", tool_choice: { type: "any" } }, "auto").tool_choice, "auto");
  assert.equal((chat.tools as unknown[]).length, 1);
  assert.deepEqual(chat.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "ok",
      reasoning_content: "secret",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "file" },
  ]);
});

test("chat reasoning_content round-trips as thinking", () => {
  const msg = chatToMessage({
    choices: [{ finish_reason: "stop", message: { content: "Hi", reasoning_content: "because" } }],
  });
  assert.deepEqual(msg.content, [
    { type: "thinking", thinking: "because" },
    { type: "text", text: "Hi" },
  ]);
  const chat = messagesToChat({
    model: "kimi-k3",
    messages: [
      { role: "assistant", content: msg.content },
      { role: "user", content: "next" },
    ],
  });
  assert.deepEqual(chat.messages, [
    { role: "assistant", content: "Hi", reasoning_content: "because" },
    { role: "user", content: "next" },
  ]);
});

test("chatToMessage maps tool calls", () => {
  const msg = chatToMessage({
    id: "c1",
    model: "grok-4.6",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "ok",
          tool_calls: [{ id: "call_1", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  });
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.content, [
    { type: "text", text: "ok" },
    { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } },
  ]);
  assert.deepEqual(msg.usage, {
    input_tokens: 3,
    output_tokens: 4,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
});

test("chatErrorToAnthropic keeps the upstream message", () => {
  const err = chatErrorToAnthropic(404, { error: { message: "model grok-4.6 not found" } });
  assert.deepEqual(err, { type: "error", error: { type: "not_found_error", message: "model grok-4.6 not found" } });
});

test("chat sse becomes anthropic events", async () => {
  const raw = [
    'data: {"id":"c1","model":"grok-4.6","choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":""}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":5}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < raw.length; i += 11) controller.enqueue(enc.encode(raw.slice(i, i + 11)));
      controller.close();
    },
  });
  const reader = chatSseToAnthropic(stream, "grok-4.6").getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  const events = out
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = block.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
      return { event, data: data ? (JSON.parse(data) as Record<string, unknown>) : null };
    });
  assert.deepEqual(
    events.map((e) => e.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  assert.equal((events[2].data?.delta as { text: string }).text, "Hi");
  assert.equal((events[4].data?.content_block as { name: string }).name, "bash");
  assert.equal((events[5].data?.delta as { partial_json: string }).partial_json, '{"a":1}');
  assert.equal((events[7].data?.delta as { stop_reason: string }).stop_reason, "tool_use");
  assert.equal((events[7].data?.usage as { output_tokens: number }).output_tokens, 5);
});

test("messagesToResponses keeps tool calls as response items", () => {
  const res = messagesToResponses({
    model: "grok-4.7",
    max_tokens: 8,
    stream: true,
    system: "sys",
    tools: [{ name: "bash", description: "run", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "bash" },
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file" }] },
    ],
  });
  assert.equal(res.store, false);
  assert.deepEqual(res.include, ["reasoning.encrypted_content"]);
  assert.equal(res.max_output_tokens, 8);
  assert.deepEqual(res.tool_choice, { type: "function", name: "bash" });
  assert.deepEqual(res.input, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
    { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"ls"}' },
    { type: "function_call_output", call_id: "call_1", output: "file" },
  ]);
  const msg = responsesToMessage({
    id: "r1",
    model: "grok-4.7",
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: "Hi" }] },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"a":1}' },
    ],
    usage: { input_tokens: 2, output_tokens: 5 },
  });
  assert.equal(msg.stop_reason, "tool_use");
  assert.equal((msg.content as { type: string }[])[0].type, "text");
});

test("reasoning items round-trip through thinking signature", () => {
  const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "cipher", status: "completed" };
  const msg = responsesToMessage({
    id: "r1",
    model: "grok-4.7",
    output: [reasoning, { type: "message", content: [{ type: "output_text", text: "Hi" }] }],
  });
  const again = messagesToResponses({
    model: "grok-4.7",
    messages: [
      { role: "assistant", content: msg.content },
      { role: "user", content: "next" },
    ],
  });
  assert.deepEqual(again.input, [
    reasoning,
    { role: "assistant", content: "Hi" },
    { role: "user", content: "next" },
  ]);
});

test("responses sse becomes anthropic events", async () => {
  const raw = [
    'data: {"type":"response.created","response":{"id":"r1","model":"grok-4.7"}}\n\n',
    'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
    'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"bash","arguments":""}}\n',
    'data: {"type":"response.function_call_arguments.delta","delta":"{\\"a\\":1}"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","id":"rs_1","encrypted_content":"cipher"}],"usage":{"input_tokens":2,"output_tokens":5}}}\n\n',
  ].join("");
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(raw));
      controller.close();
    },
  });
  const reader = responsesSseToAnthropic(stream, "grok-4.7").getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  const events = out
    .split("\n\n")
    .filter(Boolean)
    .map((block) => block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim());
  assert.deepEqual(events, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
});
