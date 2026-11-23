const PAGES = ["keys", "users", "upstream", "skills", "guide"];
const PAGE_TITLE = { keys: "分发账号管理", users: "用户配置", upstream: "上游账号", skills: "公共 Skill 与 MCP", guide: "接入指南" };
const PAGE_FROM_SLUG = {
  keys: "keys", users: "users", upstream: "upstream", skills: "skills", guide: "guide",
  密钥: "keys", 用户: "users", 上游: "upstream", 接入: "guide",
};

function decodeSeg(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function pageUrl(id) {
  return "/admin/" + id;
}

function currentPage() {
  const fromHash = decodeSeg(location.hash.replace(/^#\/?/, ""));
  if (PAGE_FROM_SLUG[fromHash]) return PAGE_FROM_SLUG[fromHash];
  const seg = decodeSeg(location.pathname.replace(/^\/admin\/?/, "").split("/").filter(Boolean)[0] || "");
  return PAGE_FROM_SLUG[seg] || "keys";
}

{
  const id = currentPage();
  const url = pageUrl(id);
  if (location.hash || (location.pathname !== "/admin" && decodeSeg(location.pathname) !== url)) {
    history.replaceState(null, "", url);
  }
}

function applyPage(id) {
  for (const el of document.querySelectorAll("[data-page]")) el.hidden = el.dataset.page !== id;
  for (const el of document.querySelectorAll("[data-nav]")) {
    const on = el.dataset.nav === id;
    el.classList.toggle("on", on);
    if (on) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
  document.title = (PAGE_TITLE[id] || "分发账号管理") + " · API 分发";
  if (id === "guide") renderGuide();
  if (id === "users") loadUsers();
}

function showPage(id, replace) {
  const url = pageUrl(id);
  if (decodeSeg(location.pathname) !== url || location.hash) {
    history[replace ? "replaceState" : "pushState"](null, "", url);
  }
  applyPage(id);
}

window.addEventListener("popstate", () => {
  if (document.getElementById("shell").hidden) return;
  applyPage(currentPage());
});

document.querySelector("aside nav").addEventListener("click", (e) => {
  const a = e.target.closest("a[data-nav]");
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const id = a.dataset.nav;
  if (!PAGES.includes(id)) return;
  showPage(id, false);
});

async function enter(status, afterLogin) {
  tokenEl.value = "";
  document.getElementById("login-err").textContent = "";
  show(document.getElementById("login-wrap"), false);
  show(document.getElementById("shell"), true);
  showPage(afterLogin ? "keys" : currentPage(), true);
  renderStatus(status);
  fillSkills(status);
  await reload();
}

document.getElementById("login-card").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("login-err");
  err.textContent = "";
  await withBusy(document.getElementById("login"), async () => {
    try {
      await enter(await api("/admin/api/status"), true);
    } catch (e) {
      err.textContent = e.message || String(e);
    }
  });
});

api("/admin/api/status").then(enter).catch(() => {});

document.getElementById("logout").onclick = async () => {
  const btn = document.getElementById("logout");
  await withBusy(btn, async () => {
    try { await api("/admin/api/logout", { method: "POST" }); } catch { /* ignore */ }
  });
  tokenEl.value = "";
  document.title = "API 分发";
  show(document.getElementById("shell"), false);
  show(document.getElementById("login-wrap"), true);
  tokenEl.focus();
};
