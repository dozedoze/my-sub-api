import { loadLiveSkills } from "./skills.ts";
import {
  appendSkillResults,
  assertJsonBody,
  copyJsonRequest,
  extractHostedCalls,
  injectHostedSkills,
  runHostedSkill,
  skillFinalResponse,
} from "./skills.ts";
import { proxy } from "./proxy.ts";
import { GatewayError, bodyTooLarge, corsHeaders } from "./lib.ts";

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
  injectHostedSkills(body, rest, enabled);
  const wantStream = body.stream === true;
  let current: Record<string, unknown> = { ...body, stream: false };
  let lastJson: unknown = null;
  let lastStatus = 200;
  for (let round = 0; round < config.maxRounds; round++) {
    const inner = copyJsonRequest(request, current);
    const res = await proxy(inner, env, ctx, rest);
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
    const calls = extractHostedCalls(json, rest, enabled);
    if (!calls.length) break;
    const results = await Promise.all(
      calls.map(async (call) => ({
        id: call.id,
        name: call.name,
        content: await runHostedSkill(env, call),
      })),
    );
    current = appendSkillResults(current, json, results, rest);
    current.stream = false;
  }
  if (lastJson == null) throw new GatewayError(502, "upstream_error", "Empty skill response");
  return skillFinalResponse(lastJson, rest, wantStream, request, lastStatus);
}
