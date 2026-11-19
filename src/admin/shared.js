const ORIGIN = __ORIGIN__;
const tokenEl = document.getElementById("token");
sessionStorage.removeItem("admin_token");
let defaultQuota = 1000000;
let modelHint = "auto";
const goneIds = new Set();
const pendingKeys = new Map();
let lastKeys = [];

function fmtTokens(n) {
  if (n == null) return "不限";
  if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 ? 1 : 0) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + "k";
  return String(n);
}

function describeQuota(raw, emptyText) {
  const s = String(raw ?? "").trim();
  if (s === "") return emptyText || "空";
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return "无效";
  if (n === 0) return "0 · 不限额";
  const grouped = Math.floor(n).toLocaleString("en-US");
  const short = fmtTokens(n);
  return grouped === short ? grouped + " token" : grouped + " · " + short;
}

function bindQuotaLive(input, label, emptyText) {
  const paint = () => { label.textContent = describeQuota(input.value, emptyText()); };
  input.addEventListener("input", paint);
  paint();
  return paint;
}

function headers() {
  const h = { "content-type": "application/json" };
  const t = tokenEl.value.trim();
  if (t) h.authorization = "Bearer " + t;
  return h;
}

async function api(path, opt) {
  const res = await fetch(path, { ...opt, credentials: "same-origin", headers: { ...headers(), ...(opt && opt.headers) } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (res.status === 401 && !document.getElementById("shell").hidden) {
    show(document.getElementById("shell"), false);
    show(document.getElementById("login-wrap"), true);
    document.title = "API 分发";
    throw new Error("登录已过期，请重新输入口令");
  }
  if (!res.ok) throw new Error((data && data.error && data.error.message) || data.error || res.statusText);
  return data;
}

function show(el, on) { el.hidden = !on; }

async function withBusy(btn, run) {
  const group = btn.parentElement ? [...btn.parentElement.querySelectorAll("button")] : [btn];
  const started = Date.now();
  group.forEach((b) => { b.disabled = true; });
  btn.classList.add(btn.querySelector(".ico") ? "spinning" : "busy");
  try {
    await run();
  } finally {
    const wait = 420 - (Date.now() - started);
    if (wait > 0 && btn.isConnected) await new Promise((r) => setTimeout(r, wait));
    btn.classList.remove("busy", "spinning");
    group.forEach((b) => { b.disabled = false; });
  }
}

function bindCopyField(btn, getText) {
  btn.addEventListener("click", async () => {
    const tip = btn.querySelector(".copy-field-tip") || btn;
    const orig = tip.dataset.label || (tip === btn ? "点击复制" : tip.textContent.trim()) || "点击复制";
    tip.dataset.label = orig;
    try {
      const text = getText();
      if (!text) throw new Error("empty");
      await navigator.clipboard.writeText(text);
      btn.classList.add("copied");
      tip.textContent = "已复制 ✓";
      clearTimeout(btn._flash);
      btn._flash = setTimeout(() => {
        btn.classList.remove("copied");
        tip.textContent = orig;
      }, 2200);
    } catch {
      btn.classList.remove("copied");
      tip.textContent = "复制失败";
    }
  });
}

function publicModelId(providerId, raw, multi) {
  return multi ? providerId + "/" + raw : raw;
}
