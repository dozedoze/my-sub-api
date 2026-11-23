import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultPublicSkill,
  frontendDefaultText,
  parsePublicSkill,
  publicSkillText,
  publicSkillView,
} from "./public-skill.ts";
import { appendSystemText } from "./user-skills.ts";

test("default: frontend on with built-in text, api key off", () => {
  const config = defaultPublicSkill();
  const text = publicSkillText(config, "frontend", { mcpEnabled: true });
  assert.ok(text?.includes("网页聊天"));
  assert.ok(text?.includes("${secret:"));
  assert.ok(text?.includes("load_skill"));
  assert.equal(publicSkillText(config, "apikey", { mcpEnabled: true }), null);
});

test("api key scope only speaks when enabled and has text", () => {
  const on = parsePublicSkill({ frontend: { enabled: false }, apikey: { enabled: true, text: "  简短回答  " } });
  assert.equal(publicSkillText(on, "frontend", { mcpEnabled: true }), null);
  assert.equal(publicSkillText(on, "apikey", { mcpEnabled: true }), "简短回答");
  const empty = parsePublicSkill({ frontend: { enabled: true }, apikey: { enabled: true, text: "" } });
  assert.equal(publicSkillText(empty, "apikey", { mcpEnabled: true }), null);
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
  const text = publicSkillText(defaultPublicSkill(), "frontend", { mcpEnabled: false });
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
