import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADMIN_SESSION_COOKIE,
  GatewayError,
  adminSessionClearCookie,
  adminSessionSetCookie,
  applyChatSseLine,
  assistantFromChatCompletion,
  applyAdmit,
  applyLoginFail,
  applyLoginOk,
  applyRelease,
  attachUsage,
  bodyTooLarge,
  chargeEstimate,
  clampGeneration,
  clientIp,
  defaultQuotaTokens,
  estimateTokens,
  effectiveQuota,
  GATE,
  joinUrl,
  keyPrefix,
  looksLikeFullHistory,
  mergeSessionMessages,
  claudeDiscoveryModels,
  exposeModels,
  exposeAutoModel,
  matchListedModel,
  failoverAction,
  modelFallback,
  parseProviders,
  parseJsonObject,
  parseModelsResponse,
  parseModelWindows,
  parseOpencodeBalance,
  parseOpencodeGoUsage,
  parseQuotaPayload,
  parseQuotaInput,
  resolveQuotaUrl,
  sumTokenUnits,
  xaiUsageBody,
  xaiUsageUrl,
  pickUpstream,
  extraPaidChannel,
  goAllowanceBlocks,
  quotaBlocks,
  modelAllowed,
  isGoSubscription,
  loadProviders,
  loginRetryAfter,
  mintAdminSession,
  isAdminShellPath,
  readCookie,
  resolveSessionId,
  verifyAdminSession,
  rotateFrom,
  stickyAccountId,
  applyUpstreamSticky,
  secretName,
  stripV1,
  tokensFromUsage,
  pushRecent,
  readRecent,
  trimSessionMessages,
  upstreamRestPath,
  proxyRoute,
  parseUsername,
  generatePassword,
  hashPassword,
  verifyPassword,
  mintChatSession,
  verifyChatSession,
  isChatOrigin,
  corsHeaders,
  vendorGroups,
  vendorPeers,
  type Provider,
} from "./lib.ts";
import {
  autoRouteFollowUp,
  autoRouteHint,
  autoRouterFallback,
  autoRouterTranscript,
  cheapRouterChain,
  easyServeChain,
  orderAutoTargets,
  parseAutoRoute,
  resolveAutoRoute,
  DEFAULT_AUTO_ROUTE,
  isAutoModel,
  parseAutoRouterReply,
  planAuto,
  stickAutoTier,
} from "./auto.ts";

function providers(...ids: string[]): Map<string, Provider> {
  return new Map(
    ids.map((id) => [id, { id, baseUrl: `https://${id}.example/v1`, apiKey: "k" }]),
  );
}

test("joinUrl and v1 stripping", () => {
  assert.equal(joinUrl("https://x/v1/", "/chat/completions"), "https://x/v1/chat/completions");
  assert.equal(stripV1("/v1/chat/completions"), "/chat/completions");
  assert.equal(stripV1("/v1/models/"), "/models");
  assert.equal(stripV1("/v1/v1/messages"), "/messages");
  assert.equal(upstreamRestPath("/v1/chat/completions"), "chat/completions");
  assert.equal(upstreamRestPath("/v1/v1/messages"), "messages");
  assert.equal(upstreamRestPath("/v1/models/opencode/qwen4-max"), "models/opencode/qwen4-max");
  assert.equal(upstreamRestPath("/v1/messages/count_tokens"), "messages/count_tokens");
  assert.equal(upstreamRestPath("/v1/admin"), null);
  assert.deepEqual(proxyRoute("/v1/chat/completions"), { rest: "chat/completions", skills: false });
  assert.deepEqual(proxyRoute("/anthropic/v1/messages"), { rest: "messages", skills: false });
  assert.deepEqual(proxyRoute("/v1/skill/messages"), { rest: "messages", skills: true });
  assert.deepEqual(proxyRoute("/anthropic/v1/skill/messages"), { rest: "messages", skills: true });
  assert.deepEqual(proxyRoute("/v1/skill/chat/completions"), { rest: "chat/completions", skills: true });
  assert.deepEqual(proxyRoute("/models"), { rest: "models", skills: false });
  assert.deepEqual(proxyRoute("/anthropic/v1/files"), { rest: "files", skills: false });
  assert.deepEqual(proxyRoute("/v1/tools/asr"), { rest: "tools/asr", skills: false });
  assert.equal(proxyRoute("/v1/skill/nope"), null);
  assert.equal(secretName("open-ai"), "OPEN_AI_API_KEY");
  assert.equal(keyPrefix("sk-abcdefghijklmnop"), "sk-abcdefgh");
});

test("parse config JSON", () => {
  assert.deepEqual(parseProviders(""), []);
  assert.deepEqual(parseProviders(undefined), []);
  assert.deepEqual(parseProviders([]), []);
  assert.deepEqual(parseProviders('[{"id":" openai ","baseUrl":" https://api.openai.com/v1 "}]'), [
    { id: "openai", baseUrl: "https://api.openai.com/v1" },
  ]);
  assert.deepEqual(parseProviders([{ id: " grok ", baseUrl: " https://api.x.ai/v1 " }]), [
    { id: "grok", baseUrl: "https://api.x.ai/v1" },
  ]);
  assert.deepEqual(
    parseProviders([
      {
        id: "grok",
        baseUrl: "https://api.x.ai/v1",
        quota: { url: " https://management-api.x.ai/v1/x ", secret: " GROK_MANAGEMENT_KEY ", cents: true, method: "get" },
      },
    ]),
    [
      {
        id: "grok",
        baseUrl: "https://api.x.ai/v1",
        quota: { url: "https://management-api.x.ai/v1/x", secret: "GROK_MANAGEMENT_KEY", cents: true },
      },
    ],
  );
  assert.deepEqual(parseProviders([{ id: "deepseek", baseUrl: "https://api.deepseek.com/v1", quota: { secret: "X" } }]), [
    { id: "deepseek", baseUrl: "https://api.deepseek.com/v1" },
  ]);
  assert.deepEqual(
    parseProviders([{ id: "m", baseUrl: "https://api.example.com/v1", messages: "responses", hostedSearch: true }]),
    [{ id: "m", baseUrl: "https://api.example.com/v1", messages: "responses", hostedSearch: true }],
  );
  assert.deepEqual(parseProviders([{ id: "m", baseUrl: "https://api.example.com/v1", messages: "nope", hostedSearch: "yes" }]), [
    { id: "m", baseUrl: "https://api.example.com/v1" },
  ]);
  assert.deepEqual(parseJsonObject('{"gpt-4":"opencode/gpt-5.4"}'), { "gpt-4": "opencode/gpt-5.4" });
  assert.deepEqual(parseJsonObject({ "gpt-4": "opencode/gpt-5.4" }), { "gpt-4": "opencode/gpt-5.4" });
  assert.throws(
    () => parseProviders({ id: "grok" }),
    (err: unknown) => err instanceof GatewayError && err.code === "config_error",
  );
});

test("providers come only from PROVIDERS", () => {
  const none = loadProviders({ PROVIDERS: [], OPENCODE_API_KEY: "k" });
  assert.deepEqual(none.publicList, []);
  assert.deepEqual(none.live, []);

  const extras = loadProviders({
    PROVIDERS: [
      { id: "grok", baseUrl: "https://api.x.ai/v1" },
      { id: "opencode", baseUrl: "https://opencode.ai/zen/v1" },
    ],
    GROK_API_KEY: "g",
  });
  assert.deepEqual(extras.publicList.map((p) => p.id), ["grok", "opencode"]);
  assert.deepEqual(extras.live.map((p) => p.id), ["grok"]);

  const quota = loadProviders({
    PROVIDERS: [
      {
        id: "grok",
        baseUrl: "https://api.x.ai/v1/",
        quota: {
          url: "https://management-api.x.ai/v1/billing/teams/${GROK_TEAM_ID}/prepaid/balance",
          secret: "GROK_MANAGEMENT_KEY",
          cents: true,
        },
      },
      { id: "deepseek", baseUrl: "https://api.deepseek.com/v1", quota: { url: "/user/balance" } },
    ],
    GROK_API_KEY: "g",
    GROK_MANAGEMENT_KEY: " mk ",
    GROK_TEAM_ID: "team-1",
    DEEPSEEK_API_KEY: "d",
  });
  assert.equal(quota.live[0].baseUrl, "https://api.x.ai/v1");
  assert.equal(quota.live[0].quotaKey, "mk");
  assert.equal(quota.live[0].apiKey, "g");
  assert.equal(
    quota.live[0].quota?.url,
    "https://management-api.x.ai/v1/billing/teams/team-1/prepaid/balance",
  );
  assert.equal(quota.live[1].quotaKey, "d");
  assert.equal(resolveQuotaUrl(quota.live[1].baseUrl, quota.live[1].quota?.url ?? ""), "https://api.deepseek.com/user/balance");
  assert.equal("apiKey" in quota.publicList[0], false);

  const missing = loadProviders({
    PROVIDERS: [
      {
        id: "grok",
        baseUrl: "https://api.x.ai/v1",
        quota: { url: "https://management-api.x.ai/v1/billing/teams/${GROK_TEAM_ID}/prepaid/balance", secret: "GROK_MANAGEMENT_KEY" },
      },
    ],
    GROK_API_KEY: "g",
  });
  assert.equal(missing.live[0].quotaKey, "");
  assert.equal(missing.live[0].quotaError, "额度地址缺少 GROK_TEAM_ID");
});

test("extra paid channels stay offline", () => {
  assert.equal(extraPaidChannel("https://opencode.ai/zen/go/v1"), null);
  assert.equal(extraPaidChannel("https://api.x.ai/v1"), null);
  assert.equal(extraPaidChannel("https://api.deepseek.com/v1"), null);
  assert.equal(isGoSubscription("https://opencode.ai/zen/go/v1"), true);
  assert.equal(isGoSubscription("https://opencode.ai/zen/v1"), false);
  assert.match(extraPaidChannel("https://opencode.ai/zen/v1") ?? "", /按量/);
  assert.match(extraPaidChannel("https://us.api.x.ai/v1") ?? "", /美国/);
  assert.equal(goAllowanceBlocks({ usage: { monthly: { percent: 100 } } }, "glm-5.3"), true);
  assert.equal(goAllowanceBlocks({ usage: { monthly: { percent: 100 } } }, "hy4-flash-free"), false);
  assert.equal(goAllowanceBlocks({ usage: { monthly: { percent: 40 } } }, "glm-5.3"), false);
  assert.equal(
    goAllowanceBlocks({ usage: { rolling: { percent: 20, status: "rate-limited" } } }, "qwen3.7-plus"),
    true,
  );
  const opencode = { id: "opencode", baseUrl: "https://opencode.ai/zen/go/v1" };
  const grok = { id: "grok", baseUrl: "https://api.x.ai/v1" };
  for (const id of ["grok-4.6", "grok-4.7", "qwen3.7-plus", "qwen3.8-flash", "qwen4-max", "kimi-k3"]) {
    assert.equal(modelAllowed(opencode, id), true, id);
  }
  for (const id of ["grok-4.5", "qwen3.8-max", "qwen3.6-plus", "kimi-k3.1-pro", "glm-5.3", "kimi-k2.7-code"]) {
    assert.equal(modelAllowed(opencode, id), false, id);
  }
  assert.equal(modelAllowed(grok, "grok-4.7"), true);
  assert.equal(modelAllowed(grok, "grok-4.6-fast"), true);
  assert.equal(modelAllowed(grok, "grok-4"), false);
  assert.equal(modelAllowed({ id: "deepseek", baseUrl: "https://api.deepseek.com/v1" }, "deepseek-chat"), true);
  const detail = parseOpencodeGoUsage({
    usage: {
      rolling: { percent: 10, status: "ok", resetsAt: "2026-11-19T07:03:00.000Z" },
      monthly: { percent: 40, status: "rate-limited", resetsAt: "2026-12-01T00:00:00.000Z" },
    },
  });
  assert.deepEqual(detail?.detail, [
    "5 小时：已用 10%，剩余 90%，正常，重置 2026-11-19 15:03",
    "本月：已用 40%，剩余 60%，已限流，重置 2026-12-01 08:00",
  ]);
  assert.deepEqual(
    parseQuotaPayload({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
    })?.detail,
    ["CNY 总额 ¥110.00", "CNY 赠送 ¥10.00", "CNY 充值 ¥100.00"],
  );

  const got = loadProviders({
    PROVIDERS: [
      { id: "opencode", baseUrl: "https://opencode.ai/zen/v1" },
      { id: "grok-us", baseUrl: "https://us.api.x.ai/v1" },
      { id: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" },
    ],
    OPENCODE_API_KEY: "a",
    GROK_US_API_KEY: "b",
    OPENCODE_GO_API_KEY: "c",
  });
  assert.deepEqual(got.live.map((p) => p.id), ["opencode-go"]);
  assert.equal(got.publicList[0].configured, false);
  assert.match(got.publicList[0].note ?? "", /按量/);
});

test("pickUpstream default + prefix + alias", () => {
  const map = providers("opencode", "cursor");

  assert.deepEqual(
    pickUpstream({
      requestedModel: "glm-5.2",
      aliases: {},
      defaultProvider: "opencode",
      providers: map,
    }),
    { provider: map.get("opencode")!, model: "glm-5.2" },
  );

  assert.equal(
    pickUpstream({
      requestedModel: "cursor/composer-2.5",
      aliases: {},
      defaultProvider: "opencode",
      providers: map,
    }).provider.id,
    "cursor",
  );

  assert.equal(
    pickUpstream({
      requestedModel: "gpt-4",
      aliases: { "gpt-4": "cursor/composer-2.5" },
      defaultProvider: "opencode",
      providers: map,
    }).model,
    "composer-2.5",
  );
});

test("pickUpstream routes Claude Code ids to the unique OpenCode model", () => {
  const map = new Map<string, Provider>([
    ["grok", { id: "grok", baseUrl: "https://api.x.ai/v1", apiKey: "k" }],
    ["deepseek", { id: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" }],
    ["opencode", { id: "opencode", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "k" }],
  ]);
  const qwen = pickUpstream({
    requestedModel: "qwen4-max",
    aliases: {},
    defaultProvider: "grok",
    providers: map,
  });
  assert.equal(qwen.provider.id, "opencode");
  assert.equal(qwen.model, "qwen4-max");
  const prefixed = pickUpstream({
    requestedModel: "claude/opencode/qwen4-max",
    aliases: {},
    defaultProvider: "grok",
    providers: map,
  });
  assert.equal(prefixed.provider.id, "opencode");
  assert.equal(prefixed.model, "qwen4-max");
  const grok = pickUpstream({
    requestedModel: "grok-4.6",
    aliases: {},
    defaultProvider: "grok",
    providers: map,
  });
  assert.equal(grok.provider.id, "grok");
  assert.equal(isAutoModel("claude/auto"), true);
  assert.equal(isAutoModel("auto"), true);
  const listed = exposeModels([
    { providerId: "grok", models: ["grok-4.6"] },
    { providerId: "opencode", models: ["qwen4-max"] },
  ]);
  assert.equal(matchListedModel(listed, "opencode/qwen4-max")?.id, "opencode/qwen4-max");
  assert.equal(matchListedModel(listed, "qwen4-max")?.id, "opencode/qwen4-max");
  assert.equal(matchListedModel(listed, "claude/opencode/qwen4-max")?.id, "opencode/qwen4-max");
  assert.equal(claudeDiscoveryModels(listed)[1].id, "claude/opencode/qwen4-max");
});

test("pickUpstream falls back when default provider is not live", () => {
  const map = providers("openai");
  const got = pickUpstream({
    requestedModel: "gpt-4o",
    aliases: {},
    defaultProvider: "opencode",
    providers: map,
  });
  assert.equal(got.provider.id, "openai");
  assert.equal(got.model, "gpt-4o");
});

test("exposeModels prefixes only when multiple upstreams", () => {
  assert.deepEqual(
    exposeModels([{ providerId: "openai", models: ["gpt-4o", "o3"] }]).map((m) => m.id),
    ["gpt-4o", "o3"],
  );
  assert.deepEqual(
    exposeModels([
      { providerId: "openai", models: ["gpt-4o"] },
      { providerId: "opencode", models: ["glm-5.2"] },
    ]).map((m) => m.id),
    ["openai/gpt-4o", "opencode/glm-5.2"],
  );
  assert.deepEqual(parseModelsResponse({ data: [{ id: " a " }, { id: "" }, {}] }), ["a"]);
  assert.deepEqual(parseModelsResponse({ models: ["gpt-4o", { id: "o3" }] }), ["gpt-4o", "o3"]);
  assert.equal(exposeAutoModel([{ id: "gpt-4o", object: "model", created: 0, owned_by: "openai" }])[0].id, "auto");
  assert.equal(parseAutoRoute(undefined), null);
  assert.equal(parseAutoRoute({}), null);
  assert.deepEqual(resolveAutoRoute(null), { route: DEFAULT_AUTO_ROUTE, saved: false });
  assert.deepEqual(resolveAutoRoute({}), { route: DEFAULT_AUTO_ROUTE, saved: false });
  assert.equal(resolveAutoRoute({ easy: "a", hard: ["b"] }).saved, true);
  assert.deepEqual(parseAutoRoute({ easy: " opencode/qwen3.8-flash ", hard: "opencode/grok-4.7" }), {
    easy: "opencode/qwen3.8-flash",
    hard: ["opencode/grok-4.7"],
  });
  assert.deepEqual(
    parseAutoRoute({ easy: "opencode/qwen3.8-flash", hard: [" grok/grok-4.7 ", "opencode/grok-4.7"] }).hard,
    ["grok/grok-4.7", "opencode/grok-4.7"],
  );
  assert.throws(
    () => parseAutoRoute({ easy: "only-one" }),
    (err: unknown) => err instanceof GatewayError && err.code === "config_error",
  );
});

test("auto route asks the cheap model except for a bare greeting", () => {
  assert.equal(autoRouteHint([{ role: "user", content: "你好" }]), "easy");
  assert.equal(
    autoRouteHint([
      { role: "system", content: "你是编程助手".repeat(40) },
      { role: "user", content: "hi" },
    ]),
    "easy",
  );
  assert.equal(autoRouteHint([{ role: "user", content: "帮我看看这个接口为什么 500" }]), "ask");
  assert.equal(autoRouteHint([{ role: "user", content: "把这段话润色得礼貌一点" }]), "easy");
  assert.equal(autoRouteHint([{ role: "user", content: "翻译这段报错：connection reset" }]), "easy");
  assert.equal(autoRouteHint([{ role: "user", content: "证明一下勾股定理" }]), "hard");
  assert.equal(
    autoRouteHint([{ role: "user", content: "这段报错怎么改\n```\nError: boom\n```" }]),
    "hard",
  );
  assert.equal(
    autoRouteHint([
      { role: "user", content: "上一问" },
      { role: "assistant", content: "答错了" },
      { role: "user", content: "不对" },
    ]),
    "hard",
  );
  assert.equal(
    autoRouteHint([
      { role: "user", content: "查一下" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "search" } }] },
      { role: "tool", content: "Error: timeout" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "search" } }] },
      { role: "tool", content: "又失败了" },
    ]),
    "hard",
  );
  const follow = [
    { role: "user", content: "帮我把这个状态机改成可恢复的" },
    { role: "assistant", content: "好" },
    { role: "user", content: "继续" },
  ];
  assert.equal(autoRouteHint(follow), "ask");
  assert.equal(autoRouteFollowUp(follow), true);
  assert.equal(autoRouteFollowUp([{ role: "user", content: "翻译一下" }]), false);

  const transcript = autoRouterTranscript([
    { role: "system", content: "巨大的人设不要带进去" },
    { role: "user", content: "看下这段" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file" } }] },
    { role: "tool", content: "Error: boom" },
  ]);
  assert.equal(transcript.includes("巨大的人设"), false);
  assert.match(transcript, /调用 read_file/);
  assert.match(transcript, /工具：Error: boom/);
  assert.equal(parseAutoRouterReply("Hard"), "hard");
  assert.equal(parseAutoRouterReply("easy."), "easy");
  assert.equal(parseAutoRouterReply("简单，这是寒暄"), "easy");
  assert.equal(parseAutoRouterReply("难"), "hard");
  assert.equal(parseAutoRouterReply("maybe"), null);
  assert.equal(autoRouterFallback("x".repeat(500)), "easy");
  assert.equal(autoRouterFallback("Traceback (most recent call last):"), "hard");
  assert.equal(autoRouterFallback("今天星期几"), "easy");
  assert.equal(
    autoRouteHint([
      { role: "user", content: [{ type: "image", source: { type: "base64", data: "xx" } }] },
    ]),
    "ask",
  );
  assert.equal(stickAutoTier("easy", "hard", true), "hard");
  assert.equal(stickAutoTier("hard", "easy", true), "hard");
  assert.equal(stickAutoTier("hard", "easy", false), "easy");
  assert.deepEqual(cheapRouterChain(["opencode", "deepseek"]), [
    "opencode/qwen3.8-flash",
    "opencode/qwen3.7-plus",
    "deepseek/deepseek-chat",
  ]);
  assert.deepEqual(cheapRouterChain(["grok"]), []);
  assert.deepEqual(easyServeChain("opencode/qwen3.8-flash", ["opencode", "deepseek"]), [
    "opencode/qwen3.8-flash",
    "opencode/qwen3.7-plus",
    "deepseek/deepseek-chat",
  ]);
  assert.equal(quotaBlocks({ is_available: false, balance_infos: [{ total_balance: "3" }] }), true);
  assert.equal(quotaBlocks({ balance_infos: [{ currency: "CNY", total_balance: "0" }] }), true);
  assert.equal(quotaBlocks({ balance_infos: [{ total_balance: "12.5" }] }), false);
  assert.equal(quotaBlocks({ total: { val: "0" } }), true);
  assert.equal(quotaBlocks({ total: { val: "250" } }), false);
  assert.equal(quotaBlocks({ usage: { monthly: { percent: 100 } } }), false);
  const chain = ["grok/grok-4.7", "opencode/grok-4.7", "opencode/kimi-k3"];
  assert.deepEqual(orderAutoTargets(chain, null), chain);
  assert.deepEqual(orderAutoTargets(chain, "opencode/grok-4.7"), [
    "opencode/grok-4.7",
    "opencode/kimi-k3",
    "grok/grok-4.7",
  ]);
  assert.equal(modelFallback(429), true);
  assert.equal(modelFallback(404), true);
  assert.equal(modelFallback(400), false);
});

test("auto plans chat completions and anthropic messages", async () => {
  const map = new Map<string, Provider>([
    ["opencode", { id: "opencode", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "k" }],
  ]);
  const opts = {
    route: DEFAULT_AUTO_ROUTE,
    messages: [{ role: "user", content: "你好" }],
    providers: map,
    blocked: new Set<string>(),
    aliases: {},
    defaultProvider: "opencode",
    charge: async () => ({}),
  };
  const chat = await planAuto({ ...opts, rest: "chat/completions" });
  assert.equal(chat.tier, "easy");
  const messages = await planAuto({ ...opts, rest: "messages" });
  assert.equal(messages.tier, "easy");
  await assert.rejects(
    () => planAuto({ ...opts, rest: "responses" }),
    (err: unknown) => err instanceof GatewayError && err.status === 400,
  );
});

test("pickUpstream skips blacklisted upstreams", () => {
  const map = providers("opencode", "openai");
  const blocked = new Set(["opencode"]);
  const got = pickUpstream({
    requestedModel: "gpt-4o",
    aliases: {},
    defaultProvider: "opencode",
    providers: map,
    blocked,
  });
  assert.equal(got.provider.id, "openai");

  assert.throws(
    () =>
      pickUpstream({
        requestedModel: "opencode/glm-5.2",
        aliases: {},
        defaultProvider: "openai",
        providers: map,
        blocked,
      }),
    (err: unknown) => err instanceof GatewayError && err.status === 503,
  );

  assert.throws(
    () =>
      pickUpstream({
        requestedModel: "gpt-4o",
        aliases: {},
        keyProvider: "opencode",
        defaultProvider: "opencode",
        providers: map,
        blocked,
      }),
    (err: unknown) => err instanceof GatewayError && err.status === 503,
  );
});

test("same-vendor pool: peers, rotate, failover, prefix falls to sibling", () => {
  assert.equal(failoverAction(429), "next");
  assert.equal(failoverAction(401), "ban-next");
  assert.equal(failoverAction(200), "stop");

  const pool = new Map<string, Provider>([
    ["oa", { id: "oa", baseUrl: "https://api.openai.com/v1", apiKey: "a" }],
    ["oa2", { id: "oa2", baseUrl: "https://api.openai.com/v1", apiKey: "b" }],
    ["oc", { id: "oc", baseUrl: "https://opencode.ai/zen/v1", apiKey: "c" }],
  ]);
  assert.deepEqual(vendorPeers(pool, "oa").map((p) => p.id), ["oa", "oa2"]);
  assert.deepEqual(vendorPeers(pool, "oa", new Set(["oa"])).map((p) => p.id), ["oa2"]);
  assert.deepEqual(rotateFrom(vendorPeers(pool, "oa"), "oa2").map((p) => p.id), ["oa2", "oa"]);
  assert.deepEqual(vendorGroups([...pool.values()]).map((g) => g.id), ["oa", "oc"]);

  const got = pickUpstream({
    requestedModel: "oa/gpt-4o",
    aliases: {},
    defaultProvider: "oc",
    providers: pool,
    blocked: new Set(["oa"]),
  });
  assert.equal(got.provider.id, "oa2");
  assert.equal(got.model, "gpt-4o");
});

test("pickUpstream respects per-key provider lock", () => {
  const map = providers("opencode", "cursor");
  assert.throws(
    () =>
      pickUpstream({
        requestedModel: "cursor/composer-2.5",
        aliases: {},
        keyProvider: "opencode",
        defaultProvider: "opencode",
        providers: map,
      }),
    (err: unknown) => err instanceof GatewayError && err.status === 403,
  );

  const ok = pickUpstream({
    requestedModel: "opencode/glm-5.2",
    aliases: {},
    keyProvider: "opencode",
    defaultProvider: "cursor",
    providers: map,
  });
  assert.equal(ok.provider.id, "opencode");
  assert.equal(ok.model, "glm-5.2");
});

test("session merge keeps client history and fills in single-turn", () => {
  const stored = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好，有什么事" },
  ];
  const full = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好，有什么事" },
    { role: "user", content: "再问一句" },
  ];
  assert.equal(looksLikeFullHistory(full), true);
  assert.deepEqual(mergeSessionMessages(stored, full), full);

  const onlyNew = [{ role: "user", content: "再问一句" }];
  assert.equal(looksLikeFullHistory(onlyNew), false);
  assert.deepEqual(mergeSessionMessages(stored, onlyNew), [...stored, ...onlyNew]);
});

test("upstream sticky follows the vendor and pins the account", () => {
  const ids = ["a", "b", "c"];
  assert.equal(stickyAccountId(ids, "win-A"), stickyAccountId(ids, "win-A"));
  assert.equal(stickyAccountId(["only"], "win-A"), "only");
  assert.ok(ids.includes(stickyAccountId(ids, "win-A")));

  const leaked = new Headers({ "x-opencode-session": "leak", "x-session-id": "leak", "x-grok-conv-id": "leak" });
  const xai: Record<string, unknown> = { model: "grok-4.7" };
  applyUpstreamSticky(leaked, xai, "https://api.x.ai/v1", "conv-1", "chat/completions");
  assert.equal(leaked.get("x-grok-conv-id"), "conv-1");
  assert.equal(leaked.get("x-opencode-session"), null);
  assert.equal(leaked.get("x-session-id"), null);
  assert.equal(xai.prompt_cache_key, undefined);

  const xaiResponses: Record<string, unknown> = {};
  const xaiHeaders = new Headers();
  applyUpstreamSticky(xaiHeaders, xaiResponses, "https://api.x.ai/v1", "conv-1", "responses");
  assert.equal(xaiResponses.prompt_cache_key, "conv-1");
  assert.equal(xaiHeaders.get("x-grok-conv-id"), null);

  const oc = new Headers({ "x-grok-conv-id": "nope" });
  const ocBody: Record<string, unknown> = {};
  applyUpstreamSticky(oc, ocBody, "https://opencode.ai/zen/go/v1", "key:abc", "chat/completions");
  assert.equal(oc.get("x-opencode-session"), "key:abc");
  assert.equal(oc.get("x-grok-conv-id"), null);
  assert.equal(ocBody.user_id, undefined);

  const ds: Record<string, unknown> = {};
  applyUpstreamSticky(new Headers(), ds, "https://api.deepseek.com/v1", "key:abc", "chat/completions");
  assert.equal(ds.user_id, "key_abc");
  const dsKept: Record<string, unknown> = { user_id: "mine" };
  applyUpstreamSticky(new Headers(), dsKept, "https://api.deepseek.com/v1", "key:abc", "chat/completions");
  assert.equal(dsKept.user_id, "mine");

  const oai: Record<string, unknown> = { prompt_cache_key: "keep" };
  applyUpstreamSticky(new Headers(), oai, "https://api.openai.com/v1", "s", "chat/completions");
  assert.equal(oai.prompt_cache_key, "keep");

  const ant: Record<string, unknown> = { messages: [{ role: "user", content: "hi" }] };
  applyUpstreamSticky(new Headers(), ant, "https://api.anthropic.com/v1", "s", "messages");
  assert.deepEqual(ant.cache_control, { type: "ephemeral" });
  const antKept: Record<string, unknown> = {
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
  };
  applyUpstreamSticky(new Headers(), antKept, "https://api.anthropic.com/v1", "s", "messages");
  assert.equal(antKept.cache_control, undefined);
});

test("session id prefers header then falls back to key", () => {
  const headers = new Headers({ "x-session-id": "win-A" });
  assert.equal(
    resolveSessionId({ header: (n) => headers.get(n), payload: {}, keyId: "abc" }),
    "win-A",
  );
  assert.equal(
    resolveSessionId({ header: () => null, payload: { conversation_id: "c1" }, keyId: "abc" }),
    "c1",
  );
  assert.equal(
    resolveSessionId({ header: () => null, payload: {}, keyId: "abc" }),
    "key:abc",
  );
});

test("sse delta and assistant json parse", () => {
  const acc = { content: "" };
  applyChatSseLine(acc, 'data: {"choices":[{"delta":{"content":"你"}}]}');
  applyChatSseLine(acc, 'data: {"choices":[{"delta":{"content":"好"}}]}');
  applyChatSseLine(acc, "data: [DONE]");
  assert.equal(acc.content, "你好");
  const msg = assistantFromChatCompletion({
    choices: [{ message: { role: "assistant", content: "答" } }],
  });
  assert.equal(msg?.content, "答");
  const trimmed = trimSessionMessages(
    Array.from({ length: 90 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: String(i) })),
  );
  assert.equal(trimmed.length, 80);
});

test("quota helpers and usage parse", () => {
  assert.equal(defaultQuotaTokens(undefined), 1_000_000);
  assert.equal(defaultQuotaTokens("500000"), 500000);
  assert.equal(parseQuotaInput(undefined, 1000), 1000);
  assert.equal(parseQuotaInput(0, 1000), 0);
  assert.equal(parseQuotaInput("25000", 1000), 25000);
  assert.equal(effectiveQuota({}, 9), 9);
  assert.equal(effectiveQuota({ quotaTokens: 0 }, 9), 0);
  assert.equal(tokensFromUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), 15);
  assert.equal(tokensFromUsage({ usage: { total_tokens: 42 } }), 42);
  assert.equal(tokensFromUsage({ usage: { input_tokens: 3, output_tokens: 4 } }), 7);
  assert.equal(estimateTokens("abcd"), 2);
  const views = attachUsage(
    [{ id: "a", name: "n", prefix: "sk-a", enabled: true, createdAt: 1, quotaTokens: 100 }],
    { a: { used: 40, requests: 2 } },
    1_000_000,
  );
  assert.equal(views[0].usedTokens, 40);
  assert.equal(views[0].remainingTokens, 60);
  assert.deepEqual(views[0].recent, []);
  let recent;
  for (let i = 0; i < 12; i++) {
    recent = pushRecent(recent, { at: i + 1, model: "m" + i, provider: "p", tokens: i });
  }
  assert.equal(recent.length, 10);
  assert.equal(recent[0].model, "m11");
  assert.equal(recent[9].model, "m2");
  const withRecent = attachUsage(
    [{ id: "a", name: "n", prefix: "sk-a", enabled: true, createdAt: 1, quotaTokens: 100 }],
    { a: { used: 40, requests: 2, recent } },
    1_000_000,
  );
  assert.equal(withRecent[0].recent[0].model, "m11");
  assert.equal(withRecent[0].recent.length, 10);
  assert.deepEqual(readRecent([{ model: "x" }, { at: 1, model: "ok", provider: "p", tokens: 3 }, null]), [
    { at: 1, model: "ok", provider: "p", tokens: 3 },
  ]);
  const acc = { content: "" };
  applyChatSseLine(acc, 'data: {"choices":[{"delta":{"content":"x"}}],"usage":{"total_tokens":9}}');
  assert.equal(acc.content, "x");
  assert.equal(acc.tokens, 9);
  const go = parseOpencodeGoUsage({
    usage: { monthly: { percent: 40, resetsAt: "t" }, rolling: { percent: 10 } },
  });
  assert.equal(go?.ok, true);
  assert.equal(go?.windows?.find((w) => w.name === "monthly")?.remainingPercent, 60);
  assert.equal(parseOpencodeBalance({ balance: { usd: 4.1 } })?.balanceUsd, 4.1);
  assert.equal(
    parseQuotaPayload({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
    })?.label,
    "¥110.00",
  );
  assert.equal(parseQuotaPayload({ is_available: false, balance_infos: [{ currency: "USD", total_balance: "0" }] })?.label, "$0.00（不可用）");
  assert.equal(parseQuotaPayload({ total: { val: "1000" }, changes: [] })?.label, "$10.00");
  assert.equal(parseQuotaPayload({ total: { val: "250" } }, { cents: true })?.balanceUsd, 2.5);
  assert.equal(parseQuotaPayload({ total: { val: "250" } }), null);
  assert.equal(parseQuotaPayload({ balance: { usd: 4.1 } })?.label, "$4.10");
  assert.equal(
    parseQuotaPayload({ usage: { monthly: { percent: 40 }, rolling: { percent: 10 } } })?.label,
    "rolling剩 90% · monthly剩 60%",
  );
  assert.equal(parseQuotaPayload({ account: { credit: "8.5" } })?.label, "credit 8.50");
  assert.equal(parseQuotaPayload({ nope: true }), null);
  assert.equal(
    xaiUsageUrl("https://management-api.x.ai/v1/billing/teams/team_1/prepaid/balance"),
    "https://management-api.x.ai/v1/billing/teams/team_1/usage",
  );
  assert.equal(xaiUsageUrl("https://api.deepseek.com/user/balance"), null);
  const usageBody = xaiUsageBody(new Date("2026-11-19T08:00:00Z")) as {
    analyticsRequest: { timeRange: { endTime: string }; timeUnit: string };
  };
  assert.equal(usageBody.analyticsRequest.timeUnit, "TIME_UNIT_NONE");
  assert.equal(usageBody.analyticsRequest.timeRange.endTime, "2026-11-20 00:00:00");
  assert.deepEqual(
    sumTokenUnits({
      timeSeries: [
        { group: ["Prompt text tokens"], dataPoints: [{ values: [100] }, { values: [25.4] }] },
        { group: ["Completion text tokens"], dataPoints: [{ values: [10] }] },
        { group: ["Images"], dataPoints: [{ values: [999] }] },
      ],
    }),
    { tokens: 135, incomplete: false },
  );
  assert.deepEqual(sumTokenUnits({ timeSeries: [], limitReached: true }), { tokens: 0, incomplete: true });
  assert.equal(sumTokenUnits({ usage: { monthly: { percent: 1 } } }), null);
  assert.equal(resolveQuotaUrl("https://api.deepseek.com/v1", "/user/balance"), "https://api.deepseek.com/user/balance");
  assert.equal(resolveQuotaUrl("https://api.deepseek.com/v1", "file:///etc/passwd"), null);
});

test("admin session cookie is signed, expiring, not the raw token", async () => {
  const secret = "admin-token-secret";
  const now = 1_700_000_000_000;
  const value = await mintAdminSession(secret, now);
  assert.equal(value.includes(secret), false);
  assert.equal(await verifyAdminSession(secret, value, now), true);
  assert.equal(await verifyAdminSession("other", value, now), false);
  assert.equal(await verifyAdminSession(secret, value.replace(/\.[0-9a-f]+$/, "." + "0".repeat(64)), now), false);
  assert.equal(await verifyAdminSession(secret, value, now + 7 * 24 * 60 * 60 * 1000 + 1000), false);

  const https = adminSessionSetCookie(value, "https://aofahub.dev/admin");
  assert.match(https, new RegExp(`^${ADMIN_SESSION_COOKIE}=`));
  assert.match(https, /HttpOnly/);
  assert.match(https, /SameSite=Strict/);
  assert.match(https, /Path=\/admin/);
  assert.match(https, /Secure/);
  assert.equal(adminSessionSetCookie(value, "http://127.0.0.1:8787/admin").includes("Secure"), false);
  assert.match(adminSessionClearCookie("https://aofahub.dev/admin"), /Max-Age=0/);
  assert.equal(readCookie(`a=1; ${ADMIN_SESSION_COOKIE}=${value}; b=2`, ADMIN_SESSION_COOKIE), value);
});

test("chat session binds key id and is not an admin session", async () => {
  const secret = "admin-token-secret";
  const keyId = "11111111-1111-1111-1111-111111111111";
  const now = 1_700_000_000_000;
  const value = await mintChatSession(secret, keyId, now);
  assert.equal(await verifyChatSession(secret, value, now), keyId);
  assert.equal(await verifyChatSession("other", value, now), null);
  assert.equal(await verifyAdminSession(secret, value, now), false);
  const cookie = (await import("./lib.ts")).chatSessionSetCookie(value, "https://aofahub.dev/chat/api/login");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Domain=\.aofahub.dev/);
  assert.match(cookie, /Path=\//);
  assert.equal((await import("./lib.ts")).chatSessionSetCookie(value, "http://localhost:8787/").includes("Domain="), false);
});

test("password is hashed, username is normalized", async () => {
  const { salt, hash } = await hashPassword("s3cret-pass");
  assert.equal(await verifyPassword("s3cret-pass", salt, hash), true);
  assert.equal(await verifyPassword("wrong", salt, hash), false);
  assert.equal(parseUsername("Alice_01"), "alice_01");
  assert.equal(generatePassword().length, 16);
  assert.equal(isChatOrigin("https://chat.aofahub.dev"), true);
  assert.equal(isChatOrigin("http://localhost:8090"), true);
  assert.equal(isChatOrigin("https://evil.example"), false);
  const cred = corsHeaders(new Request("https://aofahub.dev/v1/models", { headers: { origin: "https://chat.aofahub.dev" } }));
  assert.equal(cred["access-control-allow-origin"], "https://chat.aofahub.dev");
  assert.equal(cred["access-control-allow-credentials"], "true");
  const star = corsHeaders();
  assert.equal(star["access-control-allow-origin"], "*");
});

test("admit gate blocks rpm and inflight, not a few sequential calls", () => {
  const empty = { used: 0, requests: 0 };
  const now = 1_000_000;
  const opts = { quota: 1000, maxRpm: 3, maxInflight: 2, takeInflight: true };
  const a = applyAdmit(empty, now, opts);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  const b = applyAdmit(a.next, now + 10, opts);
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const full = applyAdmit(b.next, now + 20, opts);
  assert.equal(full.ok, false);
  if (full.ok) return;
  assert.equal(full.code, "rate_limited");
  assert.match(full.message, /concurrent/);

  const rpmOpts = { quota: 0, maxRpm: 2, maxInflight: 99, takeInflight: false };
  const r1 = applyAdmit(empty, now, rpmOpts);
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  const r2 = applyAdmit(r1.next, now + 1, rpmOpts);
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  const r3 = applyAdmit(r2.next, now + 2, rpmOpts);
  assert.equal(r3.ok, false);
  if (r3.ok) return;
  assert.match(r3.message, /\/min/);
  assert.equal(typeof r3.retryAfter, "number");
  const r4 = applyAdmit(r2.next, now + GATE.windowMs, rpmOpts);
  assert.equal(r4.ok, true);

  const over = applyAdmit({ used: 100, requests: 1 }, now, { ...opts, quota: 100, takeInflight: false });
  assert.equal(over.ok, false);
  if (over.ok) return;
  assert.equal(over.code, "insufficient_quota");

  const stale = applyRelease({ used: 0, requests: 0, inflight: 9, gateAt: now - GATE.staleMs - 1 }, now);
  assert.equal(stale.inflight, 0);
});

test("generation clamp, image floor, body cap, client ip", () => {
  const body = { max_tokens: 200_000, n: 12, max_output_tokens: 200_000 };
  clampGeneration(body);
  assert.equal(body.max_tokens, GATE.maxTokens);
  assert.equal(body.n, GATE.maxN);
  assert.equal(body.max_output_tokens, GATE.maxTokens);
  const small = { max_tokens: 1024, n: 1 };
  clampGeneration(small);
  assert.equal(small.max_tokens, 1024);
  assert.equal(chargeEstimate("images/generations", { prompt: "hi" }) >= GATE.imageTokenFloor, true);
  assert.equal(chargeEstimate("chat/completions", { prompt: "hi" }) < GATE.imageTokenFloor, true);
  const big = new Request("https://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-length": String(GATE.maxBodyBytes + 1) },
  });
  assert.equal(bodyTooLarge(big, undefined), true);
  assert.equal(bodyTooLarge(new Request("https://x"), { a: 1 }), false);
  assert.equal(clientIp(new Request("https://x", { headers: { "cf-connecting-ip": "1.2.3.4" } })), "1.2.3.4");
  assert.equal(clientIp(new Request("https://x")), "local");
});

test("admin shell paths are not API", () => {
  assert.equal(isAdminShellPath("/admin"), true);
  assert.equal(isAdminShellPath("/admin/keys"), true);
  assert.equal(isAdminShellPath("/admin/upstream"), true);
  assert.equal(isAdminShellPath("/admin/guide"), true);
  assert.equal(isAdminShellPath("/admin/api"), false);
  assert.equal(isAdminShellPath("/admin/api/status"), false);
  assert.equal(isAdminShellPath("/administration"), false);
  assert.equal(isAdminShellPath("/"), false);
});

test("login fails lock after GATE.loginFails", () => {
  const now = 2_000_000;
  let cur = { used: 0, requests: 0 };
  for (let i = 0; i < GATE.loginFails - 1; i++) {
    cur = applyLoginFail(cur, now);
    assert.equal(loginRetryAfter(cur, now), null);
  }
  cur = applyLoginFail(cur, now);
  assert.equal(loginRetryAfter(cur, now), Math.ceil(GATE.loginLockMs / 1000));
  assert.equal(loginRetryAfter(cur, now + GATE.loginLockMs + 1), null);
  const afterExpiry = applyLoginFail(cur, now + GATE.loginLockMs + 1);
  assert.equal(afterExpiry.fails, 1);
  assert.equal(loginRetryAfter(afterExpiry, now + GATE.loginLockMs + 1), null);
  const cleared = applyLoginOk(cur);
  assert.equal(cleared.fails, 0);
  assert.equal(loginRetryAfter(cleared, now), null);
});

test("model windows pass through only when the upstream states them", () => {
  const json = {
    data: [
      { id: "a", context_length: 131072 },
      { id: "b", max_input_tokens: 200000.9 },
      { id: "c" },
      { id: "d", context_length: 0 },
      { id: "e", context_window: "big" },
    ],
  };
  assert.deepEqual(parseModelWindows(json), { a: 131072, b: 200000 });
  assert.deepEqual(parseModelWindows(null), {});
  const listed = exposeModels([{ providerId: "p", models: ["a", "c"], windows: { a: 131072 } }]);
  assert.equal(listed[0].context_length, 131072);
  assert.equal("context_length" in listed[1], false);
});
