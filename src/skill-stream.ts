import { appendSkillResults, type ToolCall } from "./skills.ts";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

type SseFrame = { event: string; data: string };

/** 逐个产出 SSE 帧；调用方提前退出或 signal 中止时会取消上游读取。 */
export async function* readSse(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  const take = (): SseFrame | null => {
    const frame = data.length ? { event, data: data.join("\n") } : null;
    event = "";
    data = [];
    return frame;
  };
  const feed = (line: string): SseFrame | null => {
    if (line === "") return take();
    if (line.startsWith(":")) return null;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    return null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        const frame = feed(line);
        if (frame) yield frame;
      }
    }
    buf += decoder.decode();
    if (buf) {
      const frame = feed(buf.replace(/\r$/, ""));
      if (frame) yield frame;
    }
    const last = take();
    if (last) yield last;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

const encoder = new TextEncoder();

function frame(type: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 一路上游内容块在本轮的累积结果，用来还原这一轮的 assistant 内容。 */
type Acc = {
  /** 输出给客户端的索引；网关自己接手的工具调用不下发，为 null */
  out: number | null;
  block: Json;
  text: string;
  thinking: string;
  signature: string;
  json: string;
  hosted: boolean;
};

function toBlock(acc: Acc): Json | null {
  const type = acc.block.type;
  if (type === "text") return acc.text ? { type: "text", text: acc.text } : null;
  if (type === "thinking") {
    return acc.thinking || acc.signature
      ? { type: "thinking", thinking: acc.thinking, ...(acc.signature ? { signature: acc.signature } : {}) }
      : null;
  }
  if (type === "tool_use") return { ...acc.block, input: toolInput(acc) };
  return acc.block;
}

function toolInput(acc: Acc): Json {
  if (acc.json) {
    try {
      return asRecord(JSON.parse(acc.json)) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(acc.block.input) ?? {};
}

function failureMessage(text: string, status: number): string {
  try {
    const message = asRecord(asRecord(JSON.parse(text))?.error)?.message;
    if (typeof message === "string" && message) return message;
  } catch {
    /* 不是 JSON，原文展示 */
  }
  return text || `HTTP ${status}`;
}

/** 工具执行期间没有上游数据，隔一会儿发一帧 ping，防止连接被当成空闲断掉。 */
const PING_MS = 10_000;

export type SkillStreamOptions = {
  /** 已确认成功且是 SSE 的第一轮上游响应 */
  first: Response;
  /** 第一轮用的请求体，后续轮次在它后面追加工具往返 */
  current: Record<string, unknown>;
  maxRounds: number;
  /** 由网关接手执行的工具名，这些调用不下发给客户端 */
  allow: ReadonlySet<string>;
  /** 带着新请求体发起下一轮（stream: true） */
  nextRound: (body: Record<string, unknown>) => Promise<Response>;
  runCalls: (calls: ToolCall[]) => Promise<{ id: string; name: string; content: string }[]>;
  /** 流结束（含客户端取消）后收尾 */
  done: () => void;
};

/**
 * /messages 的托管工具循环，边收边发：
 * 每一轮都以流式请求上游，思考与正文增量立刻转给客户端；
 * 本轮结束后若有网关接手的工具调用，就执行并带着结果开下一轮，所有轮次接在同一条 SSE 里。
 * 只发一个 message_start，块索引跨轮次顺延，只发最后一轮的 message_delta 与 message_stop。
 */
export function streamSkillRounds(options: SkillStreamOptions): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (type: string, data: unknown) => {
        if (cancelled) return;
        try {
          controller.enqueue(frame(type, data));
        } catch {
          cancelled = true;
        }
      };
      let started = false;
      let next = 0;
      const ensureStarted = () => {
        if (started) return;
        started = true;
        send("message_start", {
          type: "message_start",
          message: {
            id: crypto.randomUUID(),
            type: "message",
            role: "assistant",
            model: "",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
      };

      type Outcome = { content: Json[]; calls: ToolCall[]; delta: Json | null; stopped: boolean; errored: boolean };
      const pump = async (res: Response): Promise<Outcome> => {
        const accs = new Map<number, Acc>();
        const order: Acc[] = [];
        let delta: Json | null = null;
        let stopped = false;
        let errored = false;
        if (!res.body) return { content: [], calls: [], delta, stopped, errored };
        for await (const raw of readSse(res.body, abort.signal)) {
          let ev: Json | null = null;
          try {
            ev = asRecord(JSON.parse(raw.data));
          } catch {
            continue;
          }
          if (!ev) continue;
          const index = typeof ev.index === "number" ? ev.index : -1;
          if (ev.type === "message_start") {
            if (!started) {
              started = true;
              send("message_start", ev);
            }
          } else if (ev.type === "content_block_start") {
            const block = asRecord(ev.content_block);
            if (!block || index < 0) continue;
            const hosted = block.type === "tool_use" && typeof block.name === "string" && options.allow.has(block.name);
            const acc: Acc = { out: null, block, text: "", thinking: "", signature: "", json: "", hosted };
            if (typeof block.text === "string") acc.text = block.text;
            if (typeof block.thinking === "string") acc.thinking = block.thinking;
            if (!hosted) {
              ensureStarted();
              acc.out = next++;
              send("content_block_start", { ...ev, index: acc.out });
            }
            accs.set(index, acc);
            order.push(acc);
          } else if (ev.type === "content_block_delta") {
            const acc = accs.get(index);
            const part = asRecord(ev.delta);
            if (!acc || !part) continue;
            if (part.type === "text_delta" && typeof part.text === "string") acc.text += part.text;
            else if (part.type === "thinking_delta" && typeof part.thinking === "string") acc.thinking += part.thinking;
            else if (part.type === "signature_delta" && typeof part.signature === "string") acc.signature += part.signature;
            else if (part.type === "input_json_delta" && typeof part.partial_json === "string") acc.json += part.partial_json;
            if (acc.out !== null) send("content_block_delta", { ...ev, index: acc.out });
          } else if (ev.type === "content_block_stop") {
            const acc = accs.get(index);
            if (acc && acc.out !== null) send("content_block_stop", { ...ev, index: acc.out });
          } else if (ev.type === "message_delta") {
            delta = ev;
          } else if (ev.type === "message_stop") {
            stopped = true;
            break;
          } else if (ev.type === "error") {
            send("error", ev);
            errored = true;
            break;
          }
          if (cancelled) break;
        }
        const content = order.flatMap((acc) => {
          const block = toBlock(acc);
          return block ? [block] : [];
        });
        const calls = order
          .filter((acc) => acc.hosted)
          .map((acc) => ({ id: String(acc.block.id ?? ""), name: String(acc.block.name), input: toolInput(acc) }));
        return { content, calls, delta, stopped, errored };
      };

      const fail = (message: string, type = "api_error") => {
        ensureStarted();
        send("error", { type: "error", error: { type, message } });
      };

      // 上游思考或工具执行期间可能很久没有数据，整条流存活期间定时发 ping，防止被当成空闲断掉。
      const keepAlive = setInterval(() => send("ping", { type: "ping" }), PING_MS);
      try {
        let res = options.first;
        let current = options.current;
        for (let round = 0; !cancelled; round++) {
          const outcome = await pump(res);
          if (outcome.errored || cancelled) return;
          // 已经收到 message_delta 说明这一轮其实完整了，只是缺 message_stop，照常收尾。
          // 连 message_delta 都没有就是上游中途断了：回 error 事件，否则前端只会显示「已停止」，看不出原因。
          if (!outcome.stopped && !outcome.delta) {
            // overloaded_error 是 Anthropic 约定的「可重试」类型，客户端据此可自动重发。
            fail("Upstream stream ended before the response completed", "overloaded_error");
            return;
          }
          const last = round + 1 >= options.maxRounds;
          if (!outcome.calls.length || last) {
            ensureStarted();
            const base = outcome.delta ?? {
              type: "message_delta",
              delta: { stop_sequence: null },
              usage: { output_tokens: 0 },
            };
            const inner = asRecord(base.delta) ?? {};
            // 工具调用没有下发，轮次用尽时不能再说"等待工具结果"。
            const stop = outcome.calls.length ? "end_turn" : (inner.stop_reason ?? "end_turn");
            send("message_delta", { ...base, delta: { ...inner, stop_reason: stop } });
            send("message_stop", { type: "message_stop" });
            return;
          }
          send("ping", { type: "ping" });
          const results = await options.runCalls(outcome.calls);
          if (cancelled) return;
          current = {
            ...appendSkillResults(current, { content: outcome.content }, results, "messages"),
            stream: true,
          };
          try {
            res = await options.nextRound(current);
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
            return;
          }
          const ct = res.headers.get("content-type") || "";
          if (!res.ok || !ct.includes("text/event-stream")) {
            const text = await res.text().catch(() => "");
            fail(res.ok ? "Upstream returned a non-streaming response" : failureMessage(text, res.status));
            return;
          }
        }
      } catch (err) {
        if (!cancelled) {
          console.error(JSON.stringify({ message: "skill_stream", error: err instanceof Error ? err.message : String(err) }));
          fail(err instanceof Error ? err.message : String(err), "overloaded_error");
        }
      } finally {
        clearInterval(keepAlive);
        try {
          options.done();
        } finally {
          if (!cancelled) {
            try {
              controller.close();
            } catch {
              /* 已关闭 */
            }
          }
        }
      }
    },
    cancel() {
      cancelled = true;
      abort.abort();
    },
  });
}
