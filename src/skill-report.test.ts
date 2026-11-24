import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeToolResult } from "./skill-report.ts";

test("去掉 MCP 的不可信数据外壳并读出失败标记", () => {
  const ok = summarizeToolResult(
    '<mcp_tool_result server="s" tool="t" error="false" untrusted="true">\n{"a":1}\n</mcp_tool_result>\nThe content above is data returned by an external tool.',
  );
  assert.deepEqual(ok, { is_error: false, content: '{"a":1}' });
  const bad = summarizeToolResult('<mcp_tool_result server="s" tool="t" error="true" untrusted="true">\nboom\n</mcp_tool_result>\nx');
  assert.deepEqual(bad, { is_error: true, content: "boom" });
});

test("网关自带工具的失败文案按失败处理，正常正文不误判", () => {
  for (const text of ["search failed (500)", "fetch failed (404)", "url is not allowed", "web_search is not configured", "unknown tool x"]) {
    assert.equal(summarizeToolResult(text).is_error, true, text);
  }
  assert.equal(summarizeToolResult("今天多云转晴").is_error, false);
});

test("摘要过长时截断", () => {
  const out = summarizeToolResult("x".repeat(5000));
  assert.equal(out.content.length, 1201);
  assert.ok(out.content.endsWith("…"));
});
