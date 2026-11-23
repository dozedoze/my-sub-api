import assert from "node:assert/strict";
import { test } from "node:test";
import { planAuto, DEFAULT_AUTO_ROUTE } from "./auto.ts";
import type { Provider } from "./lib.ts";
import {
  effortFor,
  preferThinkers,
  shapeAnthropicThinking,
  shapeResponsesThinking,
  specThinkingMode,
  thinkingControllable,
  thinkingIntent,
  thinkingMode,
} from "./thinking.ts";

test("thinkingMode classifies by model name first, wire second", () => {
  assert.equal(thinkingMode("grok-4.7", "responses"), "always");
  assert.equal(thinkingMode("grok-4-fast-non-reasoning", "responses"), "none");
  assert.equal(thinkingMode("grok-3-mini", "responses"), "effort");
  assert.equal(thinkingMode("grok-3", "responses"), "none");
  assert.equal(thinkingMode("gpt-5.4", "responses"), "effort");
  assert.equal(thinkingMode("gpt-4o", "chat"), "none");
  assert.equal(thinkingMode("deepseek-reasoner", "anthropic"), "always");
  assert.equal(thinkingMode("qwen3-235b-thinking", "anthropic"), "always");
  assert.equal(thinkingMode("qwen4-max", "anthropic"), "toggle");
  assert.equal(thinkingMode("opencode/qwen3.8-flash", "anthropic"), "toggle");
  assert.equal(thinkingMode("kimi-k3", "chat"), "unknown");
  assert.equal(thinkingMode("some-new-model", "responses"), "unknown");
});

test("only toggle and effort get a switch", () => {
  assert.equal(thinkingControllable("toggle"), true);
  assert.equal(thinkingControllable("effort"), true);
  for (const mode of ["always", "none", "unknown"] as const) assert.equal(thinkingControllable(mode), false);
});

test("thinkingIntent reads the messages body and leaves absence alone", () => {
  assert.equal(thinkingIntent({ thinking: { type: "enabled" } }), "on");
  assert.equal(thinkingIntent({ thinking: { type: "adaptive" } }), "on");
  assert.equal(thinkingIntent({ thinking: { type: "disabled" } }), "off");
  assert.equal(thinkingIntent({}), null);
  assert.equal(thinkingIntent(null), null);
});

test("anthropic wire keeps thinking only for toggle models", () => {
  const body = { model: "m", thinking: { type: "enabled" } };
  assert.deepEqual(shapeAnthropicThinking(body, "toggle"), body);
  for (const mode of ["always", "none", "unknown", "effort"] as const) {
    assert.equal("thinking" in shapeAnthropicThinking(body, mode), false);
  }
});

test("responses wire writes reasoning effort only for effort models", () => {
  const out = { model: "m", input: [] };
  assert.deepEqual(shapeResponsesThinking({ thinking: { type: "enabled" } }, out, "effort"), {
    ...out,
    reasoning: { effort: "high" },
  });
  assert.deepEqual(shapeResponsesThinking({ thinking: { type: "disabled" } }, out, "effort"), {
    ...out,
    reasoning: { effort: "low" },
  });
  assert.equal(shapeResponsesThinking({ thinking: { type: "enabled" } }, out, "always"), out);
  assert.equal(shapeResponsesThinking({ thinking: { type: "enabled" } }, out, "unknown"), out);
  assert.equal(shapeResponsesThinking({}, out, "effort"), out);
  assert.equal(effortFor("on", 2000), "low");
  assert.equal(effortFor("on", 8000), "medium");
  assert.equal(effortFor("on", 32000), "high");
});

function providers(): Map<string, Provider> {
  return new Map<string, Provider>([
    ["opencode", { id: "opencode", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "k" }],
    ["grok", { id: "grok", baseUrl: "https://api.x.ai/v1", apiKey: "k" }],
  ]);
}

test("specThinkingMode resolves provider/model specs", () => {
  const map = providers();
  assert.equal(specThinkingMode("grok/grok-4.7", map, "opencode"), "always");
  assert.equal(specThinkingMode("opencode/qwen4-max", map, "opencode"), "toggle");
  assert.equal(specThinkingMode("opencode/kimi-k3", map, "opencode"), "unknown");
  assert.equal(specThinkingMode("qwen4-max", map, "opencode"), "toggle");
  assert.equal(specThinkingMode("x/y", new Map(), "opencode"), "unknown");
});

test("preferThinkers is stable and puts non-reasoning models last", () => {
  const modes: Record<string, "toggle" | "always" | "unknown" | "none"> = {
    a: "unknown",
    b: "none",
    c: "toggle",
    d: "always",
  };
  assert.deepEqual(preferThinkers(["a", "b", "c", "d"], (s) => modes[s]), ["c", "d", "a", "b"]);
});

test("auto with thinking on goes straight to the hard tier with thinkers first", async () => {
  const opts = {
    rest: "messages",
    route: DEFAULT_AUTO_ROUTE,
    messages: [{ role: "user", content: "你好" }],
    providers: providers(),
    blocked: new Set<string>(),
    aliases: {},
    defaultProvider: "opencode",
    charge: async () => ({}),
  };
  const plain = await planAuto(opts);
  assert.equal(plain.tier, "easy");
  const off = await planAuto({ ...opts, thinking: "off" });
  assert.equal(off.tier, "easy");
  const on = await planAuto({ ...opts, thinking: "on" });
  assert.equal(on.tier, "hard");
  assert.equal(on.via, "think");
  assert.deepEqual(on.chain, ["grok/grok-4.7", "opencode/grok-4.7", "opencode/qwen4-max", "opencode/kimi-k3"]);
});

test("auto with thinking on drops a pinned model that cannot think", async () => {
  const opts = {
    rest: "messages",
    route: { easy: "opencode/qwen3.8-flash", hard: ["opencode/qwen4-max", "opencode/kimi-k3", "grok/grok-3"] },
    messages: [{ role: "user", content: "hi" }],
    providers: providers(),
    blocked: new Set<string>(),
    aliases: {},
    defaultProvider: "opencode",
    charge: async () => ({}),
    thinking: "on" as const,
    session: {
      loadAuto: async () => null,
      saveAuto: async () => {},
      loadAutoModel: async () => "grok/grok-3",
    },
  };
  const plan = await planAuto(opts);
  assert.deepEqual(plan.chain, ["opencode/qwen4-max", "opencode/kimi-k3", "grok/grok-3"]);
});
