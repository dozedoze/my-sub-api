import assert from "node:assert/strict";
import { test } from "node:test";
import { streamSkillRounds } from "./skill-stream.ts";

const encoder = new TextEncoder();

function sse(...events: Record<string, unknown>[]): string {
  return events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join("");
}

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const start = { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [] } };
const stop = { type: "message_stop" };
const delta = (reason: string) => ({ type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 3 } });
const open = (index: number, block: Record<string, unknown>) => ({ type: "content_block_start", index, content_block: block });
const close = (index: number) => ({ type: "content_block_stop", index });
const part = (index: number, d: Record<string, unknown>) => ({ type: "content_block_delta", index, delta: d });

function frames(text: string): Record<string, any>[] {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => JSON.parse(chunk.split("\n").find((line) => line.startsWith("data:"))!.slice(5)));
}

const base = { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] };
const noCalls = async () => [];

test("没有托管工具调用时思考与正文原样逐段下发", async () => {
  const first = sseResponse(
    sse(
      start,
      open(0, { type: "thinking", thinking: "" }),
      part(0, { type: "thinking_delta", thinking: "先" }),
      part(0, { type: "thinking_delta", thinking: "想" }),
      close(0),
      open(1, { type: "text", text: "" }),
      part(1, { type: "text_delta", text: "答案" }),
      close(1),
      delta("end_turn"),
      stop,
    ),
  );
  const out = await new Response(
    streamSkillRounds({
      first,
      current: base,
      maxRounds: 3,
      allow: new Set(["web_search"]),
      nextRound: async () => assert.fail("不应发起下一轮"),
      runCalls: noCalls,
      done: () => undefined,
    }),
  ).text();
  const list = frames(out);
  assert.deepEqual(
    list.map((ev) => ev.type),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  assert.equal(list[2].delta.thinking, "先");
  assert.equal(list[3].delta.thinking, "想");
  assert.equal(list[8].delta.stop_reason, "end_turn");
});

test("上游一发出思考增量，客户端立刻就能读到", async () => {
  let push!: (text: string) => void;
  let end!: () => void;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => controller.enqueue(encoder.encode(text));
      end = () => controller.close();
    },
  });
  const out = streamSkillRounds({
    first: new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    current: base,
    maxRounds: 3,
    allow: new Set(["web_search"]),
    nextRound: async () => assert.fail("不应发起下一轮"),
    runCalls: noCalls,
    done: () => undefined,
  });
  const reader = out.getReader();
  const decoder = new TextDecoder();
  push(sse(start, open(0, { type: "thinking", thinking: "" }), part(0, { type: "thinking_delta", thinking: "第一段" })));
  let seen = "";
  while (!seen.includes("第一段")) {
    const { done, value } = await reader.read();
    assert.ok(!done, "上游还没结束，流不应关闭");
    seen += decoder.decode(value, { stream: true });
  }
  push(sse(close(0), delta("end_turn"), stop));
  end();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  assert.match(seen, /message_stop/);
});

test("托管工具调用不下发，工具结果带进下一轮，块索引跨轮顺延", async () => {
  const first = sseResponse(
    sse(
      start,
      open(0, { type: "thinking", thinking: "" }),
      part(0, { type: "thinking_delta", thinking: "要搜一下" }),
      part(0, { type: "signature_delta", signature: "sig" }),
      close(0),
      open(1, { type: "tool_use", id: "t1", name: "web_search", input: {} }),
      part(1, { type: "input_json_delta", partial_json: '{"query":' }),
      part(1, { type: "input_json_delta", partial_json: '"天气"}' }),
      close(1),
      delta("tool_use"),
      stop,
    ),
  );
  const second = sseResponse(
    sse(
      start,
      open(0, { type: "text", text: "" }),
      part(0, { type: "text_delta", text: "晴天" }),
      close(0),
      delta("end_turn"),
      stop,
    ),
  );
  let received: Record<string, any> | null = null;
  let closed = 0;
  const out = await new Response(
    streamSkillRounds({
      first,
      current: base,
      maxRounds: 3,
      allow: new Set(["web_search"]),
      nextRound: async (body) => {
        received = body;
        return second;
      },
      runCalls: async (calls) => {
        assert.deepEqual(calls, [{ id: "t1", name: "web_search", input: { query: "天气" } }]);
        return [{ id: "t1", name: "web_search", content: "多云转晴" }];
      },
      done: () => {
        closed += 1;
      },
    }),
  ).text();

  const list = frames(out);
  assert.equal(list.filter((ev) => ev.type === "message_start").length, 1);
  assert.equal(list.filter((ev) => ev.type === "message_stop").length, 1);
  assert.equal(list.filter((ev) => ev.type === "message_delta").length, 1);
  assert.ok(!list.some((ev) => ev.content_block?.type === "tool_use"), "托管工具调用不能下发给客户端");
  const starts = list.filter((ev) => ev.type === "content_block_start");
  assert.deepEqual(
    starts.map((ev) => [ev.index, ev.content_block.type]),
    [
      [0, "thinking"],
      [1, "text"],
    ],
  );
  assert.equal(list.find((ev) => ev.delta?.type === "text_delta")?.index, 1);
  assert.equal(list.find((ev) => ev.type === "message_delta")?.delta.stop_reason, "end_turn");
  assert.equal(closed, 1);

  const messages = (received as unknown as { messages: Record<string, any>[]; stream: boolean }).messages;
  assert.equal((received as unknown as { stream: boolean }).stream, true);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1], {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "要搜一下", signature: "sig" },
      { type: "tool_use", id: "t1", name: "web_search", input: { query: "天气" } },
    ],
  });
  assert.deepEqual(messages[2], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "多云转晴" }],
  });
});

test("客户端自己的工具调用照常下发并保留 tool_use 结束原因", async () => {
  const first = sseResponse(
    sse(
      start,
      open(0, { type: "tool_use", id: "c1", name: "client_tool", input: {} }),
      part(0, { type: "input_json_delta", partial_json: "{}" }),
      close(0),
      delta("tool_use"),
      stop,
    ),
  );
  const out = await new Response(
    streamSkillRounds({
      first,
      current: base,
      maxRounds: 3,
      allow: new Set(["web_search"]),
      nextRound: async () => assert.fail("不应发起下一轮"),
      runCalls: noCalls,
      done: () => undefined,
    }),
  ).text();
  const list = frames(out);
  assert.equal(list.find((ev) => ev.type === "content_block_start")?.content_block.name, "client_tool");
  assert.equal(list.find((ev) => ev.type === "message_delta")?.delta.stop_reason, "tool_use");
});

test("后续轮次请求失败时以 error 帧结束，不发 message_stop", async () => {
  const first = sseResponse(
    sse(start, open(0, { type: "tool_use", id: "t1", name: "web_search", input: { query: "q" } }), close(0), delta("tool_use"), stop),
  );
  const out = await new Response(
    streamSkillRounds({
      first,
      current: base,
      maxRounds: 3,
      allow: new Set(["web_search"]),
      nextRound: async () =>
        new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      runCalls: async () => [{ id: "t1", name: "web_search", content: "r" }],
      done: () => undefined,
    }),
  ).text();
  const list = frames(out);
  const last = list.at(-1)!;
  assert.equal(last.type, "error");
  assert.equal(last.error.message, "quota exceeded");
  assert.ok(!list.some((ev) => ev.type === "message_stop"));
});

test("轮次用尽时不再等待工具结果，以 end_turn 收尾", async () => {
  const first = sseResponse(
    sse(start, open(0, { type: "tool_use", id: "t1", name: "web_search", input: { query: "q" } }), close(0), delta("tool_use"), stop),
  );
  const out = await new Response(
    streamSkillRounds({
      first,
      current: base,
      maxRounds: 1,
      allow: new Set(["web_search"]),
      nextRound: async () => assert.fail("轮次已用尽"),
      runCalls: async () => assert.fail("轮次已用尽"),
      done: () => undefined,
    }),
  ).text();
  const list = frames(out);
  assert.equal(list.find((ev) => ev.type === "message_delta")?.delta.stop_reason, "end_turn");
  assert.equal(list.at(-1)?.type, "message_stop");
});

test("上游在 message_stop 之前断开且没有任何收尾时，回 error 事件而不是静默关流", async () => {
  const first = sseResponse(sse(start, open(0, { type: "text", text: "" }), part(0, { type: "text_delta", text: "半" })));
  const out = await new Response(
    streamSkillRounds({
      first,
      current: base,
      maxRounds: 3,
      allow: new Set(["web_search"]),
      nextRound: async () => assert.fail("不应发起下一轮"),
      runCalls: noCalls,
      done: () => undefined,
    }),
  ).text();
  const list = frames(out);
  assert.equal(list.at(-1)?.type, "error");
  assert.match(list.at(-1)?.error.message, /ended before/);
});

test("只缺 message_stop、已有 message_delta 时照常补上结束帧", async () => {
  const first = sseResponse(
    sse(start, open(0, { type: "text", text: "" }), part(0, { type: "text_delta", text: "好" }), close(0), delta("end_turn")),
  );
  const out = await new Response(
    streamSkillRounds({
      first,
      current: base,
      maxRounds: 3,
      allow: new Set(["web_search"]),
      nextRound: async () => assert.fail("不应发起下一轮"),
      runCalls: noCalls,
      done: () => undefined,
    }),
  ).text();
  assert.equal(frames(out).at(-1)?.type, "message_stop");
});
