/**
 * 网关接手的工具调用，对聊天前端额外下发的两种展示用内容块：
 * gateway_tool_use（调用，含完整入参）和 gateway_tool_result（结果摘要）。
 * 它们只用于界面展示，不会回传给上游模型。
 */

/** 展示用的结果摘要长度上限 */
const PREVIEW_CHARS = 1_200;

const WRAPPER = /^<mcp_tool_result\b[^>]*\berror="(true|false)"[^>]*>\n?([\s\S]*?)\n?<\/mcp_tool_result>/;
const PLAIN_FAILURE = /^(search failed|fetch failed|url is not allowed|empty query|web_search is not configured|unknown (skill|tool)\b|skill not found)/i;

export type ToolReport = { is_error: boolean; content: string };

/** 把工具返回的文本整理成界面展示的摘要：去掉 MCP 的不可信数据外壳，判断是否失败，截断。 */
export function summarizeToolResult(content: string): ToolReport {
  const wrapped = WRAPPER.exec(content);
  const body = (wrapped ? wrapped[2] : content).trim();
  const failed = wrapped ? wrapped[1] === "true" : PLAIN_FAILURE.test(body);
  const text = body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…` : body;
  return { is_error: failed, content: text };
}
