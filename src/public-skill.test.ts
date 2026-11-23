import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultPublicSkill,
  frontendDefaultText,
  parsePublicSkill,
  publicSkillText,
  publicSkillTriggered,
  publicSkillView,
  recentUserText,
} from "./public-skill.ts";
import { appendSystemText } from "./user-skills.ts";

test("default: frontend on with built-in text, api key off", () => {
  const config = defaultPublicSkill();
  const text = publicSkillText(config, "frontend", { mcpEnabled: true, userText: "怎么配置 MCP" });
  assert.ok(text?.includes("网页聊天"));
  assert.ok(text?.includes("${secret:"));
  assert.ok(text?.includes("load_skill"));
  assert.equal(publicSkillText(config, "apikey", { mcpEnabled: true, userText: "怎么配置 MCP" }), null);
});

test("api key scope only speaks when enabled and has text", () => {
  const on = parsePublicSkill({ frontend: { enabled: false }, apikey: { enabled: true, text: "  简短回答  " } });
  assert.equal(publicSkillText(on, "frontend", { mcpEnabled: true, userText: "怎么配置 MCP" }), null);
  assert.equal(publicSkillText(on, "apikey", { mcpEnabled: true, userText: "怎么配置 MCP" }), "简短回答");
  const empty = parsePublicSkill({ frontend: { enabled: true }, apikey: { enabled: true, text: "" } });
  assert.equal(publicSkillText(empty, "apikey", { mcpEnabled: true, userText: "怎么配置 MCP" }), null);
});

test("text equal to the default is stored as empty", () => {
  const parsed = parsePublicSkill({
    frontend: { enabled: true, text: `${frontendDefaultText()}\n` },
    apikey: { enabled: false, text: "" },
  });
  assert.equal(parsed.frontend.text, "");
  assert.equal(publicSkillView(parsed).frontend.isDefault, true);
  assert.equal(publicSkillView(parsed).frontend.text, frontendDefaultText());
});

test("frontend text tells the model when MCP is off", () => {
  const text = publicSkillText(defaultPublicSkill(), "frontend", { mcpEnabled: false, userText: "mcp" });
  assert.ok(text?.includes("管理员目前关闭了 MCP"));
});

test("parsePublicSkill rejects bad input", () => {
  assert.throws(() => parsePublicSkill(null));
  assert.throws(() => parsePublicSkill({ frontend: { enabled: "yes" }, apikey: { enabled: false } }));
  assert.throws(() => parsePublicSkill({ frontend: { enabled: true, text: "x".repeat(8001) }, apikey: { enabled: false } }));
  assert.throws(() => parsePublicSkill({ frontend: { enabled: true } }));
});

test("public text is appended after the client's own system prompt", () => {
  const body: Record<string, unknown> = { system: "客户端人设", messages: [] };
  appendSystemText(body, "messages", "公共提示");
  assert.equal(body.system, "客户端人设\n\n公共提示");
});

test("frontend default only injects when a trigger keyword shows up", () => {
  const config = defaultPublicSkill();
  assert.equal(publicSkillText(config, "frontend", { mcpEnabled: true, userText: "帮我写首诗" }), null);
  assert.ok(publicSkillText(config, "frontend", { mcpEnabled: true, userText: "How do I add an MCP server?" }));
  assert.ok(publicSkillText(config, "frontend", { mcpEnabled: true, userText: "我想写个技能" }));
});

test("empty triggers means always inject; old config without triggers gets defaults", () => {
  const always = parsePublicSkill({ frontend: { enabled: true, triggers: [] }, apikey: { enabled: false } });
  assert.deepEqual(always.frontend.triggers, []);
  assert.ok(publicSkillTriggered(always.frontend, "随便聊聊"));
  const old = parsePublicSkill({ frontend: { enabled: true }, apikey: { enabled: false } });
  assert.ok(old.frontend.triggers.length > 0);
  assert.equal(publicSkillTriggered(old.frontend, "随便聊聊"), false);
});

test("triggers are trimmed, deduped and validated", () => {
  const parsed = parsePublicSkill({
    frontend: { enabled: true, triggers: [" MCP ", "mcp", "", "天气"] },
    apikey: { enabled: false },
  });
  assert.deepEqual(parsed.frontend.triggers, ["MCP", "天气"]);
  assert.throws(() => parsePublicSkill({ frontend: { enabled: true, triggers: "mcp" }, apikey: { enabled: false } }));
  assert.throws(() => parsePublicSkill({ frontend: { enabled: true, triggers: [1] }, apikey: { enabled: false } }));
  assert.throws(() => parsePublicSkill({ frontend: { enabled: true, triggers: ["x".repeat(65)] }, apikey: { enabled: false } }));
});

test("recentUserText looks at the last few user messages, text only", () => {
  const body = {
    messages: [
      { role: "user", content: "很早以前聊过 mcp" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "第二条" },
      { role: "user", content: [{ type: "text", text: "第三条" }, { type: "image", source: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "mcp" }] },
      { role: "user", content: "最新一条" },
    ],
  };
  const text = recentUserText(body);
  assert.ok(text.includes("最新一条") && text.includes("第三条") && text.includes("第二条"));
  assert.ok(!text.includes("mcp"));
});
