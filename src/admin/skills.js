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
