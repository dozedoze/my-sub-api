import { loadLiveSkills } from "./skills.ts";
import {
  appendSkillResults,
  assertJsonBody,
  copyJsonRequest,
  extractHostedCalls,
  injectHostedSkills,
  runHostedSkill,
  skillFinalResponse,
  type ToolCall,
} from "./skills.ts";
import { streamSkillRounds } from "./skill-stream.ts";
import { proxy } from "./proxy.ts";
import { GatewayError, bodyTooLarge, corsHeaders } from "./lib.ts";
import { loadMcpPolicy } from "./keys.ts";
import { loadPublicSkill, publicSkillText, publicSkillTriggered, recentUserText } from "./public-skill.ts";
import { loadUserTools, resolveCaller } from "./user-tools.ts";
import { appendSystemText } from "./user-skills.ts";

export async function proxySkills(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  rest: string,
): Promise<Response> {
  if (request.method !== "POST") throw new GatewayError(405, "method_not_allowed", "Method not allowed");
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new GatewayError(400, "invalid_request", "Content-Type must be application/json");
  }
  if (bodyTooLarge(request, undefined)) throw new GatewayError(413, "invalid_request", "Request body too large");
  const payload = await request.json().catch(() => null);
  const body = assertJsonBody(payload);
  const { config, enabled } = await loadLiveSkills(env);
  const caller = rest === "messages" || rest === "chat/completions" ? await resolveCaller(request, env) : null;
  const user = await loadUserTools(request, env, rest, caller);
  /** 流式响应接管了 user 的收尾，这里的 finally 不能再关。 */
  let handedOff = false;
  try {
    if (caller) {
      const publicConfig = await loadPublicSkill(env.KEYS);
      const userText = recentUserText(body);
      const scope = publicConfig[caller.surface];
      const needsPolicy = caller.surface === "frontend" && scope.enabled && publicSkillTriggered(scope, userText);
      const mcpEnabled = needsPolicy ? (await loadMcpPolicy(env.KEYS)).enabled : true;
      const text = publicSkillText(publicConfig, caller.surface, { mcpEnabled, userText });
      if (text) appendSystemText(body, rest, text);
    }
    const mine = new Set(injectHostedSkills(body, rest, enabled, user?.tools ?? []));
    if (user?.catalog && mine.has("load_skill")) appendSystemText(body, rest, user.catalog);
    const allow = [...enabled, ...mine];
    const wantStream = body.stream === true;
    const runCalls = (calls: ToolCall[]) =>
      Promise.all(
        calls.map(async (call) => ({
          id: call.id,
          name: call.name,
          content: user && mine.has(call.name) ? await user.run(call) : await runHostedSkill(env, call),
        })),
      );
    let current: Record<string, unknown> = { ...body, stream: false };
    // /messages 逐轮流式请求上游，思考与正文边生成边下发；其余路径仍等整轮结束。
    let pending: Response | null = null;
    if (wantStream && rest === "messages") {
      current = { ...body, stream: true };
      const first = await proxy(copyJsonRequest(request, current), env, ctx, rest);
      if (first.ok && first.body && (first.headers.get("content-type") || "").includes("text/event-stream")) {
        const headers = new Headers(first.headers);
        headers.delete("content-length");
        headers.set("content-type", "text/event-stream; charset=utf-8");
        headers.set("cache-control", "no-cache");
        // 工具往返可能很久；收尾交给流结束时，不能在这里关。
        handedOff = true;
        const stream = streamSkillRounds({
          first,
          current,
          maxRounds: config.maxRounds,
          allow: new Set(allow),
          nextRound: (next) => proxy(copyJsonRequest(request, next), env, ctx, rest),
          runCalls,
          done: () => {
            if (user) ctx.waitUntil(user.close().catch(() => undefined));
          },
        });
        return new Response(stream, { status: 200, headers });
      }
      // 失败或上游没按流返回：沿用下面整轮处理。
      pending = first;
      current = { ...body, stream: false };
    }
    let lastJson: unknown = null;
    let lastStatus = 200;
    for (let round = 0; round < config.maxRounds; round++) {
      const res: Response = pending ?? (await proxy(copyJsonRequest(request, current), env, ctx, rest));
      pending = null;
      const text = await res.text();
      let json: unknown = text;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        return new Response(text, { status: res.status, headers: corsHeaders(request) });
      }
      lastJson = json;
      lastStatus = res.status;
      if (!res.ok) {
        return new Response(text, { status: res.status, headers: { ...corsHeaders(request), "content-type": "application/json" } });
      }
      const calls = extractHostedCalls(json, rest, allow);
      if (!calls.length) break;
      const results = await runCalls(calls);
      current = appendSkillResults(current, json, results, rest);
      current.stream = false;
    }
    if (lastJson == null) throw new GatewayError(502, "upstream_error", "Empty skill response");
    return skillFinalResponse(lastJson, rest, wantStream, request, lastStatus);
  } finally {
    // 会话结束的 DELETE 不必让用户等。
    if (user && !handedOff) ctx.waitUntil(user.close().catch(() => undefined));
  }
}
