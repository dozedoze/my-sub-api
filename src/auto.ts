import {
  estimateTokens,
  GatewayError,
  goAllowanceBlocks,
  isGoSubscription,
  joinUrl,
  modelAllowed,
  pickUpstream,
  quotaBlocks,
  resolveQuotaUrl,
  tokensFromUsage,
  vendorPeers,
  type ChatMessage,
  type Provider,
} from "./lib.ts";
import { loadAutoModels } from "./keys.ts";

export type AutoRoute = { easy: string; hard: string[] };
export type AutoTier = "easy" | "hard";
export type AutoVia = "pin" | "hint" | "model" | "fallback";

export type AutoPlan = {
  tier: AutoTier;
  via: AutoVia;
  chain: string[];
};

type AutoMemory = {
  loadAuto(): Promise<AutoTier | null>;
  saveAuto(tier: AutoTier): Promise<void>;
  loadAutoModel(): Promise<string | null>;
};

function decodeJsonVar(raw: unknown): unknown {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    const s = raw.trim();
    return s ? JSON.parse(s) : undefined;
  }
  return raw;
}

function modelList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
  }
  return out;
}

/** 后台没存过时用的档。简单档没钱时仍按便宜链换；复杂档按这个顺序回退。 */
export const DEFAULT_AUTO_ROUTE: AutoRoute = {
  easy: "opencode/qwen3.8-flash",
  hard: ["grok/grok-4.7", "opencode/grok-4.7", "opencode/kimi-k3", "opencode/qwen4-max"],
};

/** 空或空对象返回 null，交给 resolveAutoRoute 换成内置档。hard 按顺序回退，字符串也收。 */
export function parseAutoRoute(raw: unknown): AutoRoute | null {
  const value = decodeJsonVar(raw);
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(500, "config_error", "AUTO_MODELS must be a JSON object");
  }
  const rec = value as Record<string, unknown>;
  const easy = typeof rec.easy === "string" ? rec.easy.trim() : "";
  const hard = modelList(rec.hard);
  if (!easy && !hard.length) return null;
  if (!easy || !hard.length) {
    throw new GatewayError(500, "config_error", "AUTO_MODELS needs both easy and hard");
  }
  return { easy, hard };
}

/** KV 没有有效档位时用内置顺序，下游照样能选 auto。 */
export function resolveAutoRoute(stored: unknown): { route: AutoRoute; saved: boolean } {
  if (stored == null) return { route: DEFAULT_AUTO_ROUTE, saved: false };
  const route = parseAutoRoute(stored);
  if (!route) return { route: DEFAULT_AUTO_ROUTE, saved: false };
  return { route, saved: true };
}

/** 后台存过的档位；没存过就用内置顺序。 */
export async function currentAuto(kv: KVNamespace): Promise<{ route: AutoRoute; saved: boolean }> {
  return resolveAutoRoute(await loadAutoModels(kv));
}

/** 钉住的模型放最前。它失败再试后面的，最后才回头试更优先的。 */
export function orderAutoTargets(chain: string[], pinned: string | null): string[] {
  const i = pinned ? chain.indexOf(pinned) : -1;
  if (i <= 0) return chain;
  return [...chain.slice(i), ...chain.slice(0, i)];
}

export function isAutoModel(model: string | undefined): boolean {
  let id = (model ?? "").trim().toLowerCase();
  if (id.startsWith("claude/")) id = id.slice("claude/".length);
  return id === "auto";
}

const AUTO_ACK =
  /^(你好|您好|hi|hello|hey|在吗|谢谢|感谢|好的|好|ok|okay|嗯+|继续|thanks|thank you|got it)[!！.。?？\s]*$/i;

// ponytail: 只钉死日常里很稳的几类，改写过的说法交给分档模型。要更准就换分类器，不要再加词。
const AUTO_EASY_TASK =
  /^(?:请|麻烦|能|可以)?(?:帮我)?(?:把|将)?.{0,8}?(?:翻译|译成|润色|改写|缩写|扩写|总结|概括|摘要|解释一下|通俗地?解释|什么是|啥是|推荐一|写一封|写封|用一句话|简单说)/;
const AUTO_FOLLOW =
  /^(继续|接着说?|然后呢?|下一步|再详细一点|再详细|详细一点|展开说说|展开|换个说法|换一种说法|改一下|再改改|还有呢|为什么|为啥|go on|continue)[!！.。?？\s]*$/i;
const AUTO_ESCALATE =
  /^(不对|你错了|答错了|错了|重新想|再想想)[!！.。?？\s]*$/i;

function contentSignal(content: unknown): { text: string; image: boolean } {
  if (typeof content === "string") return { text: content, image: false };
  if (!Array.isArray(content)) return { text: "", image: false };
  let image = false;
  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const rec = part as { type?: unknown; text?: unknown };
      if (rec.type === "image_url" || rec.type === "image" || rec.type === "input_image") image = true;
      return typeof rec.text === "string" ? rec.text : "";
    })
    .join("\n");
  return { text, image };
}

function toolNames(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const names: string[] = [];
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") continue;
    const rec = call as { name?: unknown; function?: { name?: unknown } };
    const name = typeof rec.function?.name === "string" ? rec.function.name : typeof rec.name === "string" ? rec.name : "";
    if (name) names.push(name);
  }
  return names;
}

function recentToolFailures(messages: ChatMessage[]): boolean {
  let bad = 0;
  for (const m of messages.filter((m) => m.role !== "system").slice(-6)) {
    if (m.role !== "tool") continue;
    if (/error|exception|traceback|报错|失败/i.test(contentSignal(m.content).text)) bad += 1;
  }
  return bad >= 2;
}

/** 寒暄和一眼能定的日常请求直接定档。其余交给便宜模型看原文。 */
export function autoRouteHint(messages: ChatMessage[]): "easy" | "hard" | "ask" {
  const users = messages.filter((m) => m.role === "user");
  const last = users.at(-1);
  if (!last) return messages.some((m) => m.role === "tool") ? "ask" : "easy";
  const signal = contentSignal(last.content);
  const text = signal.text.trim();
  const prior = users.slice(0, -1).some((m) => {
    const earlier = contentSignal(m.content).text.trim();
    return earlier.length > 0 && !AUTO_ACK.test(earlier);
  });
  const tools = messages.some((m) => m.role === "tool" || toolNames(m.tool_calls).length > 0);
  const priorAssistant = messages.some((m) => m.role === "assistant");
  if (recentToolFailures(messages)) return "hard";
  if (/```[\s\S]{0,500}(traceback|exception|\berror\b|报错|panic)/i.test(text)) return "hard";
  if (/traceback|stack trace|exception in thread|栈溢出/i.test(text)) return "hard";
  if (text.length <= 80 && /(证明|推导|逐步推理|step by step)/i.test(text)) return "hard";
  if (priorAssistant && AUTO_ESCALATE.test(text)) return "hard";
  if (!text && !signal.image && !tools) return "easy";
  if (!signal.image && !tools && !prior && AUTO_ACK.test(text)) return "easy";
  if (
    !signal.image &&
    text.length <= 400 &&
    AUTO_EASY_TASK.test(text) &&
    !/```|traceback|证明|推导|step by step/i.test(text)
  ) {
    return "easy";
  }
  return "ask";
}

/** 短跟进沿用上一档。换模型会让上游前缀缓存整段重算。 */
export function autoRouteFollowUp(messages: ChatMessage[]): boolean {
  const users = messages.filter((m) => m.role === "user");
  if (users.length < 2) return false;
  const text = contentSignal(users.at(-1)?.content).text.trim();
  return text.length > 0 && text.length <= 16 && AUTO_FOLLOW.test(text);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 丢掉 system（客户端的大段人设会把分档带偏）。只留最近几轮原文。 */
export function autoRouterTranscript(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages.filter((m) => m.role !== "system").slice(-8)) {
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "tool") continue;
    const signal = contentSignal(m.content);
    let text = signal.text;
    if (signal.image) text = text.trim() ? `${text} （含图片）` : "（一张图片）";
    const names = toolNames(m.tool_calls);
    if (names.length) text = `调用 ${names.join(", ")}。${text}`;
    text = clip(text, m.role === "user" ? 700 : 280);
    if (!text) continue;
    const label = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "工具";
    lines.push(`${label}：${text}`);
  }
  return lines.join("\n").slice(0, 3500);
}

export function parseAutoRouterReply(text: string): AutoTier | null {
  const s = text.trim().slice(0, 32).toLowerCase();
  if (/^(hard|难)\b/.test(s) || s.startsWith("难")) return "hard";
  if (/^(easy|简单)\b/.test(s) || s.startsWith("简单")) return "easy";
  return null;
}

/** 分档请求失败时才用。日常默认 easy，对话里已经是堆栈才升。 */
export function autoRouterFallback(transcript: string): AutoTier {
  if (/```[\s\S]{0,500}(traceback|exception|\berror\b|报错)/i.test(transcript)) return "hard";
  if (/traceback|stack trace|exception in thread|栈溢出/i.test(transcript)) return "hard";
  return "easy";
}

/** 短跟进不降档。新的一问可以回到 easy，避免一句难题把后面的闲聊锁在贵模型上。 */
export function stickAutoTier(pinned: AutoTier | null, next: AutoTier, followUp: boolean): AutoTier {
  return pinned === "hard" && (next === "hard" || followUp) ? "hard" : next;
}

// 分档不跟对外的 easy 绑。允许列表里最小的是 qwen3.8-flash。
// 同套餐的 qwen3.7 只在 flash 这个模型不可用、额度还在时有用。Go 额度用尽后换 deepseek，那是另一份余额。
const CHEAP_ROUTER = ["opencode/qwen3.8-flash", "opencode/qwen3.7-plus", "deepseek/deepseek-chat"];

export function cheapRouterChain(providerIds: Iterable<string>): string[] {
  const live = new Set(providerIds);
  return CHEAP_ROUTER.filter((spec) => live.has(spec.slice(0, spec.indexOf("/"))));
}

/** 日常回答先用配置的 easy。它没钱或没有这个模型时，按便宜链继续。 */
export function easyServeChain(easy: string, providerIds: Iterable<string>): string[] {
  const out = [easy];
  for (const spec of cheapRouterChain(providerIds)) {
    if (spec !== easy) out.push(spec);
  }
  return out;
}

const AUTO_ROUTER_SYSTEM = [
  "你只负责给日常对话分档，只输出 easy 或 hard。",
  "easy：闲聊、翻译、润色、摘要、解释、写邮件、推荐、简单事实、看图识物、一两段就能写完的小代码。日常问题默认这一档。",
  "hard：调试报错、改一大段代码、架构取舍、数学证明、多步规划、用户在纠正上一轮、工具结果反复失败。弱模型会答错才用这一档。",
  "拿不准就输出 easy。",
].join("\n");

async function getJson(url: string, apiKey: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function purseBlocked(provider: Provider, model: string, seen: Map<string, boolean>): Promise<boolean> {
  const free = /(^|[-_/])free($|[-_/])/i.test(model);
  if (!free && seen.has(provider.id)) return seen.get(provider.id) === true;
  let blocked = false;
  if (isGoSubscription(provider.baseUrl)) {
    blocked = goAllowanceBlocks(await getJson(joinUrl(provider.baseUrl, "usage"), provider.apiKey), model);
  } else if (provider.quota?.url && provider.quotaKey && !provider.quotaError && (provider.quota.method ?? "GET") === "GET") {
    const url = resolveQuotaUrl(provider.baseUrl, provider.quota.url);
    if (url) blocked = quotaBlocks(await getJson(url, provider.quotaKey));
  }
  if (!free) seen.set(provider.id, blocked);
  return blocked;
}

async function askAutoTier(
  provider: Provider,
  model: string,
  transcript: string,
): Promise<{ tier: AutoTier | null; tokens: number }> {
  let res: Response;
  try {
    res = await fetch(joinUrl(provider.baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 8,
        stream: false,
        messages: [
          { role: "system", content: AUTO_ROUTER_SYSTEM },
          { role: "user", content: transcript },
        ],
      }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    return { tier: null, tokens: 0 };
  }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { tier: null, tokens: 0 };
  }
  try {
    const json = (await res.json()) as {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[];
    };
    const msg = json.choices?.[0]?.message;
    const text = [msg?.content, msg?.reasoning_content].filter((part): part is string => typeof part === "string").join("\n");
    return { tier: parseAutoRouterReply(text), tokens: tokensFromUsage(json) ?? estimateTokens(transcript) };
  } catch {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { tier: null, tokens: 0 };
  }
}

async function askCheapModel(
  transcript: string,
  opts: {
    providers: Map<string, Provider>;
    blocked: Set<string>;
    aliases: Record<string, string>;
    keyProvider?: string;
    defaultProvider: string;
    charge(providerId: string, tokens: number): Promise<unknown>;
  },
): Promise<AutoTier | null> {
  const purse = new Map<string, boolean>();
  for (const spec of cheapRouterChain(opts.providers.keys())) {
    let picked;
    try {
      picked = pickUpstream({
        requestedModel: spec,
        aliases: opts.aliases,
        keyProvider: opts.keyProvider,
        defaultProvider: opts.defaultProvider,
        providers: opts.providers,
        blocked: opts.blocked,
      });
    } catch (err) {
      if (err instanceof GatewayError) continue;
      throw err;
    }
    if (picked.model && !modelAllowed(picked.provider, picked.model)) continue;
    let peers = vendorPeers(opts.providers, picked.provider.id, opts.blocked);
    if (opts.keyProvider) peers = peers.filter((p) => p.id === opts.keyProvider);
    for (const account of peers) {
      if (await purseBlocked(account, picked.model, purse)) continue;
      const attempt = await askAutoTier(account, picked.model, transcript);
      if (attempt.tokens > 0) await opts.charge(account.id, attempt.tokens);
      if (!attempt.tier) continue;
      console.log(JSON.stringify({ message: "auto_router", provider: account.id, model: picked.model, tier: attempt.tier }));
      return attempt.tier;
    }
  }
  return null;
}

/** 决定这一跳用哪一档、哪条模型链。index 只负责把链发出去。 */
export async function planAuto(opts: {
  rest: string;
  route: AutoRoute | null;
  messages: ChatMessage[];
  session?: AutoMemory;
  providers: Map<string, Provider>;
  blocked: Set<string>;
  aliases: Record<string, string>;
  keyProvider?: string;
  defaultProvider: string;
  charge(providerId: string, tokens: number): Promise<unknown>;
}): Promise<AutoPlan> {
  if (opts.rest !== "chat/completions") {
    throw new GatewayError(400, "invalid_request", "Model 'auto' is only supported on /v1/chat/completions");
  }
  const route = opts.route ?? DEFAULT_AUTO_ROUTE;
  const pinned = opts.session ? await opts.session.loadAuto() : null;
  const hinted = autoRouteHint(opts.messages);
  const followUp = autoRouteFollowUp(opts.messages);
  let next: AutoTier;
  let via: AutoVia;
  if (pinned && followUp && hinted !== "hard") {
    next = pinned;
    via = "pin";
  } else if (hinted === "easy" || hinted === "hard") {
    next = hinted;
    via = "hint";
  } else {
    const transcript = autoRouterTranscript(opts.messages);
    const tier = await askCheapModel(transcript, opts);
    next = tier ?? autoRouterFallback(transcript);
    via = tier ? "model" : "fallback";
  }
  const tier = stickAutoTier(pinned, next, followUp);
  if (opts.session && tier !== pinned) await opts.session.saveAuto(tier);
  if (tier === "hard") {
    const pinnedHard = opts.session ? await opts.session.loadAutoModel() : null;
    return { tier, via, chain: orderAutoTargets(route.hard, pinnedHard) };
  }
  return { tier, via, chain: easyServeChain(route.easy, opts.providers.keys()) };
}
