import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkillsConfig } from "./keys.ts";
import { extractHostedCalls, injectHostedSkills } from "./skills.ts";

test("parseSkillsConfig keeps known ids", () => {
  assert.deepEqual(parseSkillsConfig({ enabled: ["web_search", "fetch_url", "web_search"], maxRounds: 2 }), {
    enabled: ["web_search", "fetch_url"],
    maxRounds: 2,
  });
  assert.throws(() => parseSkillsConfig({ enabled: ["nope"] }));
});

test("injectHostedSkills skips duplicates and DeepSeek search", () => {
  const body: Record<string, unknown> = { model: "auto", tools: [] };
  injectHostedSkills(body, "messages", ["web_search", "fetch_url"]);
  assert.equal((body.tools as unknown[]).length, 2);

  const ds: Record<string, unknown> = {
    tools: [{ type: "deepseek_web_search", name: "deepseek_web_search" }],
  };
  injectHostedSkills(ds, "messages", ["web_search", "fetch_url"]);
  assert.equal((ds.tools as unknown[]).length, 1);
});

test("extractHostedCalls reads anthropic tool_use", () => {
  const json = {
    content: [{ type: "tool_use", id: "1", name: "web_search", input: { query: "hi" } }],
  };
  const calls = extractHostedCalls(json, "messages", ["web_search"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.query, "hi");
});
