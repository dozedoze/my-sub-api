import assert from "node:assert/strict";
import { test } from "node:test";
import { describeUserConfig, SKILL_PREVIEW_CHARS } from "./admin-users.ts";
import type { UserConfigDoc } from "./user-config.ts";

const doc: UserConfigDoc = {
  version: 3,
  updatedAt: 1700000000000,
  mcpServers: [
    {
      id: "docs",
      name: "docs",
      url: "https://mcp.example.com/sse?api_key=${secret:DOCS_KEY}",
      transport: "auto",
      headers: { Authorization: "Bearer ${secret:DOCS_TOKEN}", "X-Team": "red" },
      enabled: true,
      allowWrite: false,
    },
  ],
  skills: [{ id: "s1", name: "review", description: "code review", body: "x".repeat(SKILL_PREVIEW_CHARS + 500), enabled: true }],
};

test("describeUserConfig 不带查询串，密钥只给名字，并标出没保存的密钥", () => {
  const view = describeUserConfig(doc, ["DOCS_KEY"], { docs: { ok: false, at: 1, toolCount: 0, error: "timeout" } });
  const server = view.mcpServers[0];
  assert.equal(server.url, "https://mcp.example.com/sse");
  assert.deepEqual(server.secretNames.sort(), ["DOCS_KEY", "DOCS_TOKEN"]);
  assert.deepEqual(server.missingSecrets, ["DOCS_TOKEN"]);
  assert.equal(server.status?.error, "timeout");
  assert.deepEqual(view.secretNames, ["DOCS_KEY"]);
  assert.ok(!JSON.stringify(view).includes("api_key"));
});

test("describeUserConfig 的 Skill 正文只给开头一段", () => {
  const skill = describeUserConfig(doc, [], {}).skills[0];
  assert.equal(skill.bodyChars, SKILL_PREVIEW_CHARS + 500);
  assert.equal(skill.preview.length, SKILL_PREVIEW_CHARS);
});

test("没连接过的 server 状态是 null", () => {
  assert.equal(describeUserConfig(doc, [], {}).mcpServers[0].status, null);
});
