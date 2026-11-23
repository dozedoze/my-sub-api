function fillSkills(status) {
  const cfg = status.skills || { enabled: [], maxRounds: 3 };
  const enabled = new Set(cfg.enabled || []);
  document.getElementById("skill-web_search").checked = enabled.has("web_search");
  document.getElementById("skill-fetch_url").checked = enabled.has("fetch_url");
  document.getElementById("skill-rounds").value = String(cfg.maxRounds || 3);
  const hint = document.getElementById("skills-search-hint");
  hint.textContent = status.searchConfigured
    ? "web_search 已配置搜索密钥。"
    : "未配置 TAVILY_API_KEY / BRAVE_API_KEY 时，web_search 不会注入。";
  fillMcpPolicy(status.mcpPolicy);
}

function fillMcpPolicy(policy) {
  if (!policy) return;
  document.getElementById("mcp-enabled").checked = policy.enabled !== false;
  document.getElementById("mcp-allow").value = (policy.allowDomains || []).join("\n");
  document.getElementById("mcp-deny").value = (policy.denyDomains || []).join("\n");
  document.getElementById("mcp-secrets-hint").textContent = policy.secretsConfigured
    ? "USER_SECRETS_KEY 已配置，用户可以保存 MCP 密钥。"
    : "未配置 USER_SECRETS_KEY：用户无法保存 MCP 密钥（不会明文存储）。用 wrangler secret put USER_SECRETS_KEY 设置。";
}

async function saveSkills() {
  const err = document.getElementById("skills-err");
  err.textContent = "";
  const enabled = [];
  if (document.getElementById("skill-web_search").checked) enabled.push("web_search");
  if (document.getElementById("skill-fetch_url").checked) enabled.push("fetch_url");
  const maxRounds = Number(document.getElementById("skill-rounds").value);
  await api("/admin/api/skills", { method: "PUT", body: JSON.stringify({ enabled, maxRounds }) });
}

function domainLines(id) {
  return document
    .getElementById(id)
    .value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function saveMcpPolicy() {
  const body = {
    enabled: document.getElementById("mcp-enabled").checked,
    allowDomains: domainLines("mcp-allow"),
    denyDomains: domainLines("mcp-deny"),
  };
  fillMcpPolicy(await api("/admin/api/mcp-policy", { method: "PUT", body: JSON.stringify(body) }));
}

document.getElementById("skills-save").onclick = async () => {
  const btn = document.getElementById("skills-save");
  await withBusy(btn, async () => {
    try {
      await saveSkills();
    } catch (e) {
      document.getElementById("skills-err").textContent = e.message || String(e);
    }
  });
};

document.getElementById("mcp-save").onclick = async () => {
  const btn = document.getElementById("mcp-save");
  await withBusy(btn, async () => {
    const err = document.getElementById("mcp-err");
    err.textContent = "";
    try {
      await saveMcpPolicy();
    } catch (e) {
      err.textContent = e.message || String(e);
    }
  });
};
