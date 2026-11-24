import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatErrorToAnthropic,
  chatSseToAnthropic,
  chatToMessage,
  collectFileIds,
  inlineFileIds,
  messagesTarget,
  messagesToChat,
  messagesToResponses,
  messagesWire,
  prepareAnthropic,
  pumpSse,
  relaxToolChoice,
  responsesSseToAnthropic,
  responsesToMessage,
} from "./anthropic.ts";

test("unknown upstreams follow the declared wire, otherwise chat", () => {
  assert.equal(messagesWire("https://api.example.com/v1", "any-model", "responses"), "responses");
  assert.equal(messagesWire("https://api.example.com/v1", "claude-x"), "chat");
  assert.equal(messagesWire("", "claude-x"), "chat");
  const forced = messagesToResponses(
    {
      model: "m",
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "auto" },
    },
    "https://api.example.com/v1",
    true,
  );
  assert.equal((forced.tools as { type: string }[])[0].type, "web_search");
  const off = messagesToResponses(
    {
      model: "m",
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "tool", name: "web_search" },
    },
    "https://api.x.ai/v1",
    false,
  );
  assert.equal(off.tools, undefined);
  assert.equal(off.tool_choice, undefined);
  const other = prepareAnthropic("https://api.example.com/v1", {
    tools: [
      { name: "Bash", input_schema: { type: "object" } },
      { type: "web_fetch_20250910", name: "web_fetch" },
    ],
    tool_choice: { type: "tool", name: "web_fetch" },
  });
  assert.equal((other.tools as { name: string }[])[0].name, "Bash");
  assert.deepEqual(other.tool_choice, { type: "auto" });
});

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
    prepareAnthropic("https://api.deepseek.com/v1", {
      tool_choice: { type: "tool", name: "bash" },
      tools: [{ name: "bash", input_schema: { type: "object" } }],
    }).thinking,
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

test("messagesToChat folds latest_reminder and keeps images", () => {
  const chat = messagesToChat({
    model: "auto",
    system: "You are a helpful assistant.",
    messages: [
      { role: "latest_reminder", content: "2026-11-23,Monday,Web,zh-CN" },
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } },
          { type: "text", text: "这是什么" },
        ],
      },
    ],
  });
  assert.deepEqual(chat.messages, [
    { role: "system", content: "You are a helpful assistant.\n2026-11-23,Monday,Web,zh-CN" },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } },
        { type: "text", text: "这是什么" },
      ],
    },
  ]);
  const responses = messagesToResponses(
    {
      model: "grok-4.7",
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } }],
        },
      ],
    },
    "https://api.x.ai/v1",
  );
  assert.deepEqual(responses.input, [
    {
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,QQ==" }],
    },
  ]);
  const native = prepareAnthropic("https://opencode.ai/zen/go/v1", {
    model: "qwen3.8-flash",
    system: "sys",
    messages: [
      { role: "latest_reminder", content: "today" },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(native.system, "sys\ntoday");
  assert.deepEqual(native.messages, [{ role: "user", content: "hi" }]);
  const deepseek = prepareAnthropic("https://api.deepseek.com/v1", {
    messages: [
      { role: "latest_reminder", content: "today" },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal((deepseek.messages as { role: string }[])[0].role, "latest_reminder");
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
  assert.equal(
    messagesToChat(
      { model: "deepseek-v4-pro", tool_choice: { type: "any" }, tools: [{ name: "bash", input_schema: { type: "object" } }] },
      "auto",
    ).tool_choice,
    "auto",
  );
  assert.equal(messagesToChat({ model: "deepseek-v4-pro", tool_choice: { type: "any" } }, "auto").tool_choice, undefined);
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

test("pumpSse pings while upstream is silent and stops cleanly", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await gate;
      controller.close();
    },
  });
  const reader = pumpSse(source, { line() {}, end() {} }, 10).getReader();
  const dec = new TextDecoder();
  const first = await reader.read();
  assert.match(dec.decode(first.value), /^event: ping\n/);
  release();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
});

test("pumpSse cancel propagates to upstream", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const reader = pumpSse(source, { line() {}, end() {} }, 1000).getReader();
  await reader.cancel();
  assert.equal(cancelled, true);
});

test("pumpSse turns an upstream failure into an anthropic error event", async () => {
  const source = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error("boom");
    },
  });
  const reader = pumpSse(source, { line() {}, end() {} }, 1000).getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  assert.match(out, /event: error/);
  assert.match(out, /boom/);
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
  // 上游的用量在最后一块才到，message_start 里是 0，所以收尾的 message_delta 必须带上输入量。
  assert.equal((events[7].data?.usage as { input_tokens: number }).input_tokens, 2);
});

test("chat usage is reported the Anthropic way: cached tokens split out of input", () => {
  const msg = chatToMessage(
    {
      id: "c1",
      model: "gpt-5",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } },
    },
    "gpt-5",
  );
  assert.deepEqual(msg.usage, {
    input_tokens: 40,
    output_tokens: 7,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 60,
  });
});

test("usage already in Anthropic terms is not subtracted twice", () => {
  const msg = chatToMessage(
    {
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 },
    },
    "m",
  );
  assert.deepEqual(msg.usage, {
    input_tokens: 10,
    output_tokens: 3,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 50,
  });
});

test("server tools survive only on an upstream that can run them", () => {
  const body = {
    model: "m",
    tool_choice: { type: "tool" as const, name: "web_fetch" },
    tools: [
      { name: "Bash", description: "run", input_schema: { type: "object" } },
      { type: "web_search_20250305", name: "web_search" },
      { type: "web_fetch_20250910", name: "web_fetch" },
      { type: "code_execution_20250522", name: "code_execution" },
      { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      { type: "computer_20250124", name: "computer" },
    ],
  };
  const names = (tools: unknown) =>
    (tools as { name?: string; function?: { name?: string } }[]).map((tool) => tool.name ?? tool.function?.name);

  const xai = messagesToResponses(body, "https://api.x.ai/v1");
  assert.deepEqual(names(xai.tools), [undefined, "Bash"]);
  assert.equal((xai.tools as { type: string }[])[0].type, "web_search");
  assert.equal(xai.tool_choice, "auto");

  const openai = messagesToResponses(body, "https://api.openai.com/v1");
  assert.equal((openai.tools as { type: string }[])[0].type, "web_search");
  assert.equal(openai.tool_choice, "auto");

  for (const base of ["https://opencode.ai/zen/go/v1", "https://api.deepseek.com/v1"]) {
    const res = messagesToResponses(body, base);
    assert.deepEqual(names(res.tools), ["Bash"]);
    assert.equal(res.tool_choice, "auto");
  }
  const chat = messagesToChat(body);
  assert.deepEqual(names(chat.tools), ["Bash"]);
  assert.equal(chat.tool_choice, "auto");

  for (const base of ["https://api.deepseek.com/v1", "https://opencode.ai/zen/go/v1"]) {
    const native = prepareAnthropic(base, body);
    assert.deepEqual(names(native.tools), ["Bash"]);
    assert.deepEqual(native.tool_choice, { type: "auto" });
  }
  const official = prepareAnthropic("https://api.anthropic.com/v1", body);
  assert.equal((official.tools as unknown[]).length, body.tools.length);
  assert.deepEqual(official.tool_choice, body.tool_choice);

  const dsSearch = prepareAnthropic("https://api.deepseek.com/v1", {
    model: "deepseek-flash",
    tools: [
      { type: "deepseek_web_search", name: "deepseek_web_search" },
      { type: "deepseek_read_url", name: "deepseek_read_url" },
      { name: "Bash", description: "run", input_schema: { type: "object" } },
    ],
  });
  assert.deepEqual(names(dsSearch.tools), ["deepseek_web_search", "deepseek_read_url", "Bash"]);

  const fetchOnly = {
    model: "m",
    tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
    tool_choice: { type: "tool" as const, name: "web_fetch" },
  };
  for (const converted of [
    messagesToResponses(fetchOnly, "https://api.x.ai/v1"),
    messagesToResponses(fetchOnly, "https://opencode.ai/zen/go/v1"),
    messagesToChat(fetchOnly),
    prepareAnthropic("https://api.deepseek.com/v1", fetchOnly),
  ]) {
    assert.equal(converted.tools, undefined);
    assert.equal(converted.tool_choice, undefined);
  }
});

test("server web search becomes hosted search only on xAI and OpenAI", () => {
  const tools = [
    { name: "bash", description: "run", input_schema: { type: "object" } },
    {
      type: "web_search_20250305",
      name: "web_search",
      allowed_domains: ["a.com", "", "b.com", "c.com", "d.com", "e.com", "f.com"],
      blocked_domains: ["spam.example"],
    },
    { type: "computer_20250124", name: "computer" },
  ];
  const xai = messagesToResponses(
    { model: "grok-4.7", tools, tool_choice: { type: "tool", name: "web_search" } },
    "https://api.x.ai/v1",
  );
  assert.deepEqual(xai.tools, [
    { type: "web_search", filters: { allowed_domains: ["a.com", "b.com", "c.com", "d.com", "e.com"] } },
    { type: "function", name: "bash", description: "run", parameters: { type: "object" } },
  ]);
  assert.equal(xai.tool_choice, "auto");
  const only = messagesToResponses(
    {
      model: "grok-4.7",
      tools: [{ type: "web_search_20250305", name: "web_search", blocked_domains: ["spam.example"] }],
      tool_choice: { type: "tool", name: "web_search" },
    },
    "https://api.openai.com/v1",
  );
  assert.deepEqual(only.tools, [{ type: "web_search", filters: { excluded_domains: ["spam.example"] } }]);
  assert.equal(only.tool_choice, "required");
  const custom = messagesToResponses(
    {
      model: "grok-4.7",
      tools: [{ type: "custom", name: "web_search", description: "mine", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "web_search" },
    },
    "https://api.x.ai/v1",
  );
  assert.equal((custom.tools as { type: string }[])[0].type, "function");
  assert.deepEqual(custom.tool_choice, { type: "function", name: "web_search" });
});

test("upstreams without hosted search drop the tool and the dangling choice", () => {
  const gone = messagesToResponses(
    {
      model: "grok-4.7",
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "tool", name: "web_search" },
    },
    "https://opencode.ai/zen/go/v1",
  );
  assert.equal(gone.tools, undefined);
  assert.equal(gone.tool_choice, undefined);
  const chat = messagesToChat({
    model: "kimi-k3",
    tool_choice: { type: "any" },
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });
  assert.equal(chat.tools, undefined);
  assert.equal(chat.tool_choice, undefined);
  const mixed = messagesToResponses(
    {
      model: "grok-4.7",
      tools: [
        { name: "bash", description: "run", input_schema: { type: "object" } },
        { type: "web_search_20250305", name: "web_search" },
      ],
      tool_choice: { type: "tool", name: "web_search" },
    },
    "https://opencode.ai/zen/go/v1",
  );
  assert.equal((mixed.tools as unknown[]).length, 1);
  assert.equal(mixed.tool_choice, "auto");
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

async function collectResponsesSse(raw: string): Promise<{ event: string; data: Record<string, unknown> }[]> {
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
  return out
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "";
      const data = JSON.parse(lines.find((line) => line.startsWith("data:"))?.slice(5) ?? "{}") as Record<string, unknown>;
      return { event, data };
    });
}

test("responses reasoning streams as a thinking block before the text", async () => {
  const item = { type: "reasoning", id: "rs_1", encrypted_content: "cipher", summary: [{ type: "summary_text", text: "想一想" }] };
  const raw = [
    'data: {"type":"response.created","response":{"id":"r1","model":"grok-4.7"}}\n\n',
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}\n\n',
    'data: {"type":"response.reasoning_summary_text.delta","summary_index":0,"delta":"想"}\n\n',
    'data: {"type":"response.reasoning_summary_text.delta","summary_index":0,"delta":"一想"}\n\n',
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`,
    'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 2 } } })}\n\n`,
  ].join("");
  const events = await collectResponsesSse(raw);
  const blocks = events
    .filter((e) => e.event === "content_block_start")
    .map((e) => (e.data.content_block as { type: string }).type);
  assert.deepEqual(blocks, ["thinking", "text"]);
  const deltas = events.filter((e) => e.event === "content_block_delta").map((e) => (e.data.delta as { type: string }).type);
  assert.deepEqual(deltas, ["thinking_delta", "thinking_delta", "signature_delta", "text_delta"]);
  assert.equal(events.filter((e) => e.event === "content_block_start").length, 2);
  assert.equal(events.at(-1)?.event, "message_stop");
});

test("responses reasoning without stream events is still sent once at the end", async () => {
  const raw = [
    'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","id":"rs_1","encrypted_content":"c"}]}}\n\n',
  ].join("");
  const events = await collectResponsesSse(raw);
  const blocks = events
    .filter((e) => e.event === "content_block_start")
    .map((e) => (e.data.content_block as { type: string }).type);
  assert.deepEqual(blocks, ["text", "thinking"]);
});

test("file_id is inlined to base64 then converted for chat and grok", () => {
  const body = {
    model: "grok-4.7",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "file", file_id: "file-api-1" } },
          { type: "text", text: "what" },
        ],
      },
    ],
  };
  assert.deepEqual(collectFileIds(body), ["file-api-1"]);
  const inlined = inlineFileIds(body, new Map([["file-api-1", { mediaType: "image/png", data: "QQ==", filename: "a.png" }]]));
  const chat = messagesToChat(inlined);
  assert.deepEqual(chat.messages, [
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } },
        { type: "text", text: "what" },
      ],
    },
  ]);
  const responses = messagesToResponses(inlined, "https://api.x.ai/v1");
  assert.deepEqual(responses.input, [
    {
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,QQ==" },
        { type: "input_text", text: "what" },
      ],
    },
  ]);
  const dropped = messagesToChat(body);
  assert.deepEqual(dropped.messages, [{ role: "user", content: "what" }]);
});
