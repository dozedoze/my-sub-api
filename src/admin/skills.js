function fillSkills(status) {
  const cfg = status.skills || { enabled: [], maxRounds: 3 };
  const enabled = new Set(cfg.enabled || []);
  document.getElementById("skill-web_search").checked = enabled.has("web_search");
  document.getElementById("skill-fetch_url").checked = enabled.has("fetch_url");
  document.getElementById("skill-rounds").value = String(cfg.maxRounds || 3);
  const hint = document.getElementById("skills-search-hint");
  hint.textContent = status.searchConfigured
    ? "搜索服务已配置，联网搜索可用。"
    : "还没配搜索服务的密钥（TAVILY_API_KEY 或 BRAVE_API_KEY），联网搜索暂时不会生效。";
  fillMcpPolicy(status.mcpPolicy);
  fillPublicSkill(status.publicSkill);
}

let publicDefaults = { frontend: "", apikey: "" };

function fillPublicSkill(view) {
  if (!view) return;
  publicDefaults = view.defaults || publicDefaults;
  document.getElementById("pub-frontend-enabled").checked = view.frontend.enabled;
  document.getElementById("pub-frontend-text").value = view.frontend.text;
  document.getElementById("pub-apikey-enabled").checked = view.apikey.enabled;
  document.getElementById("pub-apikey-text").value = view.apikey.text;
  document.getElementById("pub-frontend-text").maxLength = view.maxChars || 8000;
  document.getElementById("pub-apikey-text").maxLength = view.maxChars || 8000;
  document.getElementById("pub-hint").textContent = view.frontend.isDefault
    ? "前台现在用的是内置默认内容。"
    : "前台现在用的是你改过的内容。";
}

async function savePublicSkill() {
  const body = {
    frontend: {
      enabled: document.getElementById("pub-frontend-enabled").checked,
      text: document.getElementById("pub-frontend-text").value,
    },
    apikey: {
      enabled: document.getElementById("pub-apikey-enabled").checked,
      text: document.getElementById("pub-apikey-text").value,
    },
  };
  fillPublicSkill(await api("/admin/api/public-skill", { method: "PUT", body: JSON.stringify(body) }));
}

document.getElementById("pub-frontend-reset").onclick = () => {
  document.getElementById("pub-frontend-text").value = publicDefaults.frontend;
};

document.getElementById("pub-save").onclick = async () => {
  const btn = document.getElementById("pub-save");
  await withBusy(btn, async () => {
    const err = document.getElementById("pub-err");
    err.textContent = "";
    try {
      await savePublicSkill();
    } catch (e) {
      err.textContent = e.message || String(e);
    }
  });
};

function fillMcpPolicy(policy) {
  if (!policy) return;
  document.getElementById("mcp-enabled").checked = policy.enabled !== false;
  document.getElementById("mcp-allow").value = (policy.allowDomains || []).join("\n");
  document.getElementById("mcp-deny").value = (policy.denyDomains || []).join("\n");
  document.getElementById("mcp-secrets-hint").textContent = policy.secretsConfigured
    ? "加密主密钥已设置，用户可以保存 MCP 密钥（加密存储）。"
    : "还没设置加密主密钥，用户没法保存带密钥的 MCP（不会明文存）。在终端执行 wrangler secret put USER_SECRETS_KEY 设置。";
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
