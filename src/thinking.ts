/** 深度思考的统一层。
 * 前端只有一个开关。上游千差万别，这里按「模型能不能控制思考」分类，再按协议改写请求。
 * 认不出的模型一律 unknown：不改写请求、不给前端开关，宁可少做也不让上游 400。
 */
import { messagesWire, type MessagesWire } from "./anthropic.ts";
import type { Provider } from "./lib.ts";

/**
 * toggle  请求里能开关思考（anthropic 协议的 thinking 字段）
 * effort  只能调推理强度（OpenAI 系 responses 的 reasoning.effort）
 * always  永远在思考，请求控制不了
 * none    不是推理模型
 * unknown 认不出，不碰
 */
export type ThinkingMode = "toggle" | "effort" | "always" | "none" | "unknown";
export type ThinkingIntent = "on" | "off";

/** 按模型名认。顺序有意义：先挑出例外，再落到协议默认。新模型认不出就加一行，不要改下面的流程。 */
const NAME_RULES: [RegExp, ThinkingMode][] = [
  [/non-?reasoning|no-?think|instruct$/, "none"],
  [/thinking|reasoner|reasoning|qwq|(^|[-_])r1($|[-_])/, "always"],
  [/^(gpt-5|gpt-6|o[1-9])/, "effort"],
  [/^grok-3-mini/, "effort"],
  [/^grok-[0-3](?![\d.])/, "none"],
  [/^grok-/, "always"],
  [/^gpt-(3|4)/, "none"],
  [/embed|whisper|tts|rerank/, "none"],
];

function bareName(model: string): string {
  const id = model.trim().toLowerCase();
  return id.slice(id.lastIndexOf("/") + 1);
}

export function thinkingMode(model: string, wire: MessagesWire): ThinkingMode {
  const name = bareName(model);
  for (const [pattern, mode] of NAME_RULES) {
    if (pattern.test(name)) return mode;
  }
  // 协议本身带开关的才算 toggle：Anthropic 官方、DeepSeek、OpenCode 的 messages 通道（千问、claude）。
  if (wire === "anthropic") return "toggle";
  // 其余 chat / responses 上游各家参数不同，没有名字线索就不猜。
  return "unknown";
}

/** 前端该不该给开关。always / none / unknown 控制不了，开关没有意义。 */
export function thinkingControllable(mode: ThinkingMode): boolean {
  return mode === "toggle" || mode === "effort";
}

/** 思考能力强到值得在「开启深度思考」时优先用。数字越小越优先。 */
export function thinkingRank(mode: ThinkingMode): number {
  if (mode === "toggle" || mode === "effort" || mode === "always") return 0;
  return mode === "unknown" ? 1 : 2;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 从 /v1/messages 请求体读出用户意图。没写 thinking 就是没意图，不替用户做决定。 */
export function thinkingIntent(body: unknown): ThinkingIntent | null {
  const type = asRecord(asRecord(body)?.thinking)?.type;
  if (type === "enabled" || type === "adaptive") return "on";
  if (type === "disabled") return "off";
  return null;
}

function budgetOf(body: unknown): number | null {
  const budget = asRecord(asRecord(body)?.thinking)?.budget_tokens;
  return typeof budget === "number" && budget > 0 ? budget : null;
}

/** 关闭用 low 而不是 minimal / none：各代 OpenAI 模型都认 low。 */
export function effortFor(intent: ThinkingIntent, budget: number | null): "low" | "medium" | "high" {
  if (intent === "off") return "low";
  if (budget === null || budget >= 16000) return "high";
  return budget >= 4000 ? "medium" : "low";
}

/** anthropic 协议上游：只有 toggle 保留 thinking。其余留着会被拒或白烧 token。 */
export function shapeAnthropicThinking(body: Record<string, unknown>, mode: ThinkingMode): Record<string, unknown> {
  if (mode === "toggle" || body.thinking === undefined) return body;
  const { thinking: _thinking, ...rest } = body;
  return rest;
}

/** responses 协议上游：effort 档位的模型才写 reasoning。grok-4 之类写了会被拒，所以不碰。 */
export function shapeResponsesThinking(
  source: Record<string, unknown>,
  outbound: Record<string, unknown>,
  mode: ThinkingMode,
): Record<string, unknown> {
  if (mode !== "effort") return outbound;
  const intent = thinkingIntent(source);
  if (!intent) return outbound;
  return { ...outbound, reasoning: { effort: effortFor(intent, budgetOf(source)) } };
}

/** auto 链里一条 `provider/model` 的思考能力。认不出提供方就按默认上游算。 */
export function specThinkingMode(
  spec: string,
  providers: Map<string, Provider>,
  defaultProvider: string,
): ThinkingMode {
  const slash = spec.indexOf("/");
  const named = slash > 0 ? providers.get(spec.slice(0, slash)) : undefined;
  const provider = named ?? providers.get(defaultProvider);
  const model = named ? spec.slice(slash + 1) : spec;
  if (!provider) return "unknown";
  return thinkingMode(model, messagesWire(provider.baseUrl, model, provider.messages));
}

/** 用户明确开了深度思考：能思考的排前面，不是推理模型的排最后。同级保持原顺序。 */
export function preferThinkers(chain: string[], modeOf: (spec: string) => ThinkingMode): string[] {
  return chain
    .map((spec, index) => ({ spec, index, rank: thinkingRank(modeOf(spec)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.spec);
}
