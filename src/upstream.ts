import {
  isGoSubscription,
  joinUrl,
  parseModelsResponse,
  parseOpencodeBalance,
  parseOpencodeGoUsage,
  parseQuotaPayload,
  resolveQuotaUrl,
  sumTokenUnits,
  xaiUsageBody,
  xaiUsageUrl,
  type Provider,
  type UpstreamProbe,
} from "./lib";

export async function probeUpstream(provider: Provider): Promise<UpstreamProbe> {
  if (provider.quota) return probeConfiguredQuota(provider);
  const unavailable: UpstreamProbe = {
    ok: false,
    note: "该上游没有配置额度查询。在 PROVIDERS 里给它加 quota。下面数字是本站统计的已消耗 token。",
  };
  if (provider.id !== "opencode" && !/opencode\.ai/i.test(provider.baseUrl)) return unavailable;
  let origin: string;
  try {
    origin = new URL(provider.baseUrl).origin;
  } catch {
    return unavailable;
  }
  const [go, bal] = await Promise.all([
    fetchJsonSilent(`${origin}/zen/go/v1/usage`, provider.apiKey),
    // 订阅地址不查 Zen 钱包。那个余额是按量另扣的。
    isGoSubscription(provider.baseUrl)
      ? Promise.resolve(null)
      : fetchJsonSilent(`${origin}/zen/v1/balance`, provider.apiKey),
  ]);
  const parsedBal = parseOpencodeBalance(bal);
  const parsedGo = parseOpencodeGoUsage(go);
  if (parsedBal?.ok && parsedGo?.ok) {
    return {
      ...parsedBal,
      windows: parsedGo.windows,
      label: [parsedBal.label, parsedGo.label].filter(Boolean).join(" · "),
      note: "上游钱包余额 + Go 套餐用量。",
      detail: [...(parsedBal.detail ?? []), ...(parsedGo.detail ?? [])],
    };
  }
  if (parsedBal?.ok) return parsedBal;
  if (parsedGo?.ok) return parsedGo;
  return {
    ok: false,
    note: "OpenCode Zen 预付余额目前不能用 API Key 查询，只能看网页控制台。若这把 Key 是 Go 订阅，用量接口这次也没返回数据。",
  };
}

async function probeConfiguredQuota(provider: Provider): Promise<UpstreamProbe> {
  const quota = provider.quota;
  if (!quota) return { ok: false, note: "该上游没有配置额度查询。" };
  if (provider.quotaError) {
    const secretNote = quota.secret && !provider.quotaKey ? `；密钥未配置（${quota.secret}）` : "";
    return { ok: false, note: provider.quotaError + secretNote };
  }
  if (!provider.quotaKey) {
    return { ok: false, note: `额度查询密钥未配置（${quota.secret}）` };
  }
  const url = resolveQuotaUrl(provider.baseUrl, quota.url);
  if (!url) return { ok: false, note: "额度查询地址无效" };
  const res = await fetchQuota(url, provider.quotaKey, quota.method ?? "GET", quota.body);
  const probe = !res.ok
    ? res.status
      ? { ok: false as const, note: `额度接口返回 HTTP ${res.status}` }
      : { ok: false as const, note: "额度接口请求失败" }
    : (parseQuotaPayload(res.json, { cents: quota.cents }) ?? {
        ok: false as const,
        note: "额度接口有响应，但没有认出余额字段",
      });
  if (!res.ok && res.status) {
    console.error(JSON.stringify({ message: "quota_probe", provider: provider.id, status: res.status }));
  }
  return attachXaiTokenSum(provider, url, probe);
}

async function attachXaiTokenSum(provider: Provider, balanceUrl: string, probe: UpstreamProbe): Promise<UpstreamProbe> {
  const usageUrl = xaiUsageUrl(balanceUrl);
  if (!usageUrl || !provider.quotaKey) return probe;
  let res = await fetchQuota(usageUrl, provider.quotaKey, "POST", xaiUsageBody());
  if (!res.ok && res.status === 400) {
    res = await fetchQuota(usageUrl, provider.quotaKey, "POST", xaiUsageBody(new Date(), "TIME_UNIT_MONTH"));
  }
  if (!res.ok) {
    if (res.status) {
      console.error(JSON.stringify({ message: "usage_probe", provider: provider.id, status: res.status }));
    }
    return probe;
  }
  const sum = sumTokenUnits(res.json);
  if (!sum) return probe;
  const incomplete = sum.incomplete ? "累计可能不完整。" : "";
  return {
    ...probe,
    usedTokens: sum.tokens,
    ...(sum.incomplete ? { usageIncomplete: true } : {}),
    note: `${probe.note} 累计 token 来自 xAI 账单，包含没经过本站的调用。${incomplete}`.trim(),
  };
}

async function fetchQuota(
  url: string,
  apiKey: string,
  method: string,
  body: unknown,
): Promise<{ ok: true; json: unknown } | { ok: false; status?: number }> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status };
    }
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false };
  }
}

export async function fetchJsonSilent(url: string, apiKey: string): Promise<unknown | null> {
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

export async function fetchUpstreamModels(provider: Provider): Promise<string[]> {
  try {
    const res = await fetch(joinUrl(provider.baseUrl, "models"), {
      headers: { authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return parseModelsResponse(await res.json());
  } catch {
    return [];
  }
}
