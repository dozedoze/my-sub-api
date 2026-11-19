export function adminHtml(origin: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>my-sub-api 管理</title>
  <style>
    :root {
      --bg: #0b0d12;
      --card: #141821;
      --line: #232a38;
      --text: #e8edf7;
      --muted: #8b95a8;
      --accent: #6ee7b7;
      --danger: #fb7185;
      --warn: #fbbf24;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
      background: radial-gradient(1200px 600px at 10% -10%, #12201c, transparent), var(--bg);
      color: var(--text);
    }
    main { max-width: 1040px; margin: 0 auto; padding: 32px 20px 80px; }
    h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -.02em; }
    .sub { color: var(--muted); margin-bottom: 24px; }
    .card {
      background: var(--card); border: 1px solid var(--line);
      border-radius: 14px; padding: 18px; margin-bottom: 16px;
    }
    label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    input, select, button, textarea {
      font: inherit; color: var(--text);
    }
    input, select {
      width: 100%; background: #0d1118; border: 1px solid var(--line);
      border-radius: 10px; padding: 10px 12px; outline: none;
    }
    input:focus, select:focus { border-color: #2f9e75; }
    td input { width: 128px; padding: 6px 8px; }
    .quota-cell { min-width: 160px; }
    .quota-edit { display: flex; align-items: center; gap: 8px; }
    .quota-edit input:disabled { opacity: .7; cursor: wait; }
    .quota-status {
      display: inline-flex; align-items: center; justify-content: center;
      width: 16px; height: 16px; flex: 0 0 16px;
      color: var(--accent); font-size: 15px; font-weight: 700; line-height: 1;
      user-select: none;
    }
    .quota-status.loading {
      border: 2px solid #3a4456;
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin .55s linear infinite;
    }
    .quota-status.ok { animation: pop .28s ease; }
    .quota-live {
      color: var(--accent);
      font-variant-numeric: tabular-nums;
      font-size: 12px;
      margin-top: 6px;
    }
    td .quota-live { margin-top: 4px; font-size: 11px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    .row > * { flex: 1; min-width: 160px; }
    .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
    .toolbar strong { flex: 1; }
    .field { margin-bottom: 12px; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
    button {
      position: relative;
      background: var(--accent); color: #042016; border: 0; border-radius: 10px;
      padding: 10px 14px; font-weight: 650; cursor: pointer;
      transition: opacity .2s ease, transform .15s ease, border-color .2s ease, background-color .2s ease;
    }
    button:active:not(:disabled) { transform: scale(.97); }
    button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); }
    button.danger { background: transparent; color: var(--danger); border: 1px solid #3a2430; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    button.busy { color: transparent !important; pointer-events: none; }
    button.busy::after {
      content: "";
      position: absolute;
      width: 13px; height: 13px;
      top: 50%; left: 50%;
      margin: -6.5px 0 0 -6.5px;
      border: 2px solid #3a4456;
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin .55s linear infinite;
    }
    button.danger.busy::after { border-top-color: var(--danger); }
    .ico { display: inline-block; margin-right: 5px; }
    #refresh .ico { transition: transform .18s ease; }
    #refresh:hover:not(:disabled):not(.spinning) .ico { transform: rotate(90deg); }
    #refresh.spinning { pointer-events: none; opacity: 1; }
    #refresh.spinning .ico { animation: spin .55s linear infinite; }
    button.copied {
      background: #123328 !important;
      color: var(--accent) !important;
      border-color: #2f9e75 !important;
      animation: pop .28s ease;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pop { 50% { transform: scale(1.04); } }
    dialog {
      background: var(--card); color: var(--text); border: 1px solid var(--line);
      border-radius: 14px; padding: 20px; width: min(460px, 92vw);
    }
    #once-dlg { width: min(560px, 92vw); max-height: 86vh; overflow: auto; }
    dialog::backdrop { background: rgba(5, 8, 12, .72); }
    dialog h2 { margin: 0 0 14px; font-size: 16px; }
    .how { margin: 0 0 16px; }
    .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 10px; }
    button.tab {
      background: transparent; color: var(--muted); border: 1px solid var(--line);
      padding: 6px 10px; font-weight: 550; font-size: 12px;
    }
    button.tab.on { background: #123328; color: var(--accent); border-color: #2f9e75; }
    .tab-panel { font-size: 13px; }
    .tab-panel ol { margin: 0; padding-left: 18px; }
    .tab-panel li { margin: 0 0 6px; }
    .tab-panel pre { margin: 10px 0 0; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); }
    th { color: var(--muted); font-weight: 500; }
    #provider-usage table { table-layout: fixed; }
    #provider-usage td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #provider-usage td:last-child { overflow: visible; }
    .keys-wrap { overflow-x: auto; }
    .keys {
      table-layout: fixed;
      min-width: 920px;
      border-collapse: separate;
      border-spacing: 0;
    }
    .keys .c-name { width: 136px; }
    .keys .c-prefix { width: 108px; }
    .keys .c-prov { width: 64px; }
    .keys .c-used { width: 100px; }
    .keys .c-quota { width: 176px; }
    .keys .c-remain { width: 64px; }
    .keys .c-status { width: 68px; }
    .keys .c-actions { width: 152px; }
    .keys th, .keys td {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      background: var(--card);
      vertical-align: middle;
    }
    .keys .quota-cell { white-space: normal; overflow: visible; }
    .keys .col-actions { white-space: nowrap; overflow: visible; }
    .keys .col-actions button { padding: 6px 10px; }
    .keys .col-actions button + button { margin-left: 6px; }
    .keys th:first-child, .keys td:first-child {
      position: sticky; left: 0; z-index: 2;
      box-shadow: 1px 0 0 var(--line);
    }
    .keys th:last-child, .keys td:last-child {
      position: sticky; right: 0; z-index: 2;
      box-shadow: -1px 0 0 var(--line);
    }
    code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: #1c2433; color: var(--muted); }
    .pill.ok { background: #123328; color: var(--accent); }
    .pill.off { background: #2a1c16; color: var(--warn); }
    .model-block { margin-top: 12px; }
    .model-block .hint { margin-bottom: 6px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; max-height: 140px; overflow: auto; }
    button.chip {
      background: #1c2433; color: var(--text); border: 1px solid var(--line);
      padding: 4px 8px; font-weight: 500; font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .secret {
      background: #07150f; border: 1px dashed #2f9e75; border-radius: 10px;
      padding: 12px; word-break: break-all; margin: 0 0 16px;
    }
    .hint { color: var(--muted); font-size: 12px; }
    a { color: var(--accent); }
    pre {
      background: #0d1118; border: 1px solid var(--line); border-radius: 10px;
      padding: 12px; overflow: auto; font-size: 12px; color: #c9d4e6;
    }
    .err { color: var(--danger); min-height: 1.2em; }
  </style>
</head>
<body>
<main>
  <h1>my-sub-api</h1>
  <p class="sub">签发代理 Key。上游 API Key 只存在 Cloudflare Secrets 里，不会下发给使用者。</p>

  <section class="card" id="login-card">
    <label>管理员口令（ADMIN_TOKEN）</label>
    <div class="row">
      <input id="token" type="password" autocomplete="current-password" placeholder="登录成功后 7 天内不用再输" />
      <button type="button" id="login">进入</button>
    </div>
    <p class="hint" style="margin:8px 0 0">口令不会明文存在浏览器。登录后发 HttpOnly Cookie，有效期 7 天。</p>
    <p class="err" id="login-err"></p>
  </section>

  <div id="app" hidden>
    <section class="card">
      <div class="row" style="align-items:center">
        <div>
          <div class="hint">给客户端填的 Base URL</div>
          <div class="mono" id="base-url"></div>
        </div>
        <button class="ghost" type="button" id="copy-base">复制</button>
      </div>
      <p class="hint" id="providers" style="margin:12px 0 0"></p>
      <p class="hint">同一 Base URL 的多个上游账号会轮询。上游 429 换号；401 / 403 会拉黑该账号再换号。签发 Key 锁死的上游不参与轮询。</p>
      <div id="provider-usage" style="margin-top:12px;overflow:auto"></div>
    </section>

    <section class="card">
      <div class="toolbar">
        <strong>已签发</strong>
        <button type="button" id="open-create">新建使用者 Key</button>
        <button class="ghost" type="button" id="refresh"><span class="ico" aria-hidden="true">↻</span>刷新</button>
        <button class="ghost" type="button" id="logout">退出</button>
      </div>
      <div class="keys-wrap">
        <table class="keys">
          <colgroup>
            <col class="c-name" /><col class="c-prefix" /><col class="c-prov" /><col class="c-used" />
            <col class="c-quota" /><col class="c-remain" /><col class="c-status" /><col class="c-actions" />
          </colgroup>
          <thead><tr><th>备注</th><th>前缀</th><th>上游</th><th>已用</th><th>额度</th><th>剩余</th><th>状态</th><th></th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <strong>客户端怎么填</strong>
      <p class="hint">任何 OpenAI 兼容客户端都行。Base URL 填上面那个，Key 用签发出来的 sk-。模型名填请求里的 <code>model</code>，先 <code>GET /v1/models</code> 看当前上游有哪些；上面芯片点一下就能复制。多个上游时用 <code>上游id/模型id</code>，会路由到对应上游。</p>
      <p class="hint">WorkBuddy / Cherry Studio 等：协议选 OpenAI。OpenCode 客户端：provider 配 openai-compatible。Cursor 当<strong>客户端</strong>时覆盖 OpenAI Base URL 指向本站，不是去打 Cursor 内部推理。</p>
      <pre id="snippet"></pre>
    </section>
  </div>
</main>
<dialog id="create-dlg">
  <h2>新建使用者 Key</h2>
  <div class="field">
    <label for="name">备注</label>
    <input id="name" placeholder="例如 workbuddy-小王" />
  </div>
  <div class="field">
    <label for="provider">上游</label>
    <select id="provider"><option value="">全部上游（按模型前缀路由）</option></select>
  </div>
  <div class="field">
    <label for="quota">额度（token）</label>
    <input id="quota" type="number" min="0" step="1000" placeholder="空则用默认" />
    <div class="quota-live" id="quota-live"></div>
    <p class="hint" id="quota-hint" style="margin:8px 0 0">额度按上游返回的 token 计数。填 0 表示不限额。</p>
  </div>
  <p class="err" id="create-err"></p>
  <div class="actions">
    <button class="ghost" type="button" id="create-cancel">取消</button>
    <button type="button" id="create">签发</button>
  </div>
</dialog>
<dialog id="once-dlg">
  <h2>Key 只显示这一次</h2>
  <p class="hint">立刻复制发给对方。关掉之后明文找不回，KV 里只存 SHA-256。</p>
  <div class="secret mono" id="once-key"></div>
  <div class="how">
    <p class="hint" style="margin:0 0 8px">发给对方时可以连用法一起说。Base URL：<span class="mono" id="once-base"></span></p>
    <div class="tabs" id="how-tabs">
      <button type="button" class="tab on" data-tab="workbuddy">WorkBuddy</button>
      <button type="button" class="tab" data-tab="opencode">OpenCode</button>
      <button type="button" class="tab" data-tab="cursor">Cursor</button>
      <button type="button" class="tab" data-tab="generic">通用 OpenAI</button>
    </div>
    <div class="tab-panel" id="how-panel"></div>
  </div>
  <div class="actions">
    <button class="ghost" type="button" id="once-close">关闭</button>
    <button type="button" id="once-copy">复制 Key</button>
  </div>
</dialog>
<script>
const ORIGIN = ${JSON.stringify(origin)};
const tokenEl = document.getElementById("token");
sessionStorage.removeItem("admin_token");
let defaultQuota = 1000000;
let modelHint = "上游模型 ID";
const goneIds = new Set();

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
  if (res.status === 401 && !document.getElementById("app").hidden) {
    show(document.getElementById("app"), false);
    show(document.getElementById("login-card"), true);
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

function flashLabel(btn, label) {
  const orig = btn.dataset.label || btn.textContent.trim();
  btn.dataset.label = orig;
  btn.textContent = label;
  btn.classList.add("copied");
  clearTimeout(btn._flash);
  btn._flash = setTimeout(() => {
    btn.textContent = orig;
    btn.classList.remove("copied");
  }, 1400);
}

async function enter(status) {
  tokenEl.value = "";
  document.getElementById("login-err").textContent = "";
  show(document.getElementById("login-card"), false);
  show(document.getElementById("app"), true);
  renderStatus(status);
  await reload();
}

document.getElementById("login").onclick = async () => {
  const err = document.getElementById("login-err");
  err.textContent = "";
  try {
    await enter(await api("/admin/api/status"));
  } catch (e) {
    err.textContent = e.message || String(e);
  }
};

api("/admin/api/status").then(enter).catch(() => {});

document.getElementById("logout").onclick = async () => {
  const btn = document.getElementById("logout");
  await withBusy(btn, async () => {
    try { await api("/admin/api/logout", { method: "POST" }); } catch { /* ignore */ }
  });
  tokenEl.value = "";
  show(document.getElementById("app"), false);
  show(document.getElementById("login-card"), true);
  tokenEl.focus();
};

function publicModelId(providerId, raw, multi) {
  return multi ? providerId + "/" + raw : raw;
}

function renderStatus(status) {
  defaultQuota = status.defaultQuotaTokens || 1000000;
  document.getElementById("base-url").textContent = ORIGIN + "/v1";
  document.getElementById("quota").placeholder = "默认 " + fmtTokens(defaultQuota) + " token";
  document.getElementById("quota-hint").textContent =
    "默认额度 " + fmtTokens(defaultQuota) + " token，填 0 表示不限额。";
  const sel = document.getElementById("provider");
  sel.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部上游（按模型前缀路由）";
  sel.appendChild(all);
  const bits = (status.providers || []).map((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.blacklist ? p.id + "（已拉黑）" : p.configured ? p.id : p.id + "（未配置密钥）";
    opt.disabled = !p.configured || Boolean(p.blacklist);
    sel.appendChild(opt);
    return p.id + (p.blacklist ? " 拉黑" : p.configured ? " ✓" : " ✗") + "  " + p.baseUrl;
  });
  document.getElementById("providers").textContent = bits.join("  ·  ") || "还没有可用上游。配 {ID}_API_KEY，或 EXTRA_PROVIDERS 再配对应密钥。";
  renderProviderUsage(status.providers || []);
}

function renderProviderUsage(providers) {
  const box = document.getElementById("provider-usage");
  box.replaceChildren();
  if (!providers.length) return;
  const live = providers.filter((p) => p.configured && !p.blacklist);
  const multi = live.length > 1;
  const catalog = [];
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const h of ["上游", "本站已消耗", "请求", "余额", ""]) {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = document.createElement("tbody");
  for (const p of providers) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = p.id;
    if (p.blacklist) {
      const pill = document.createElement("span");
      pill.className = "pill off";
      pill.textContent = p.blacklist.auto ? "自动拉黑" : "已拉黑";
      pill.title = p.blacklist.reason || "";
      name.append(" ", pill);
    }
    const used = document.createElement("td");
    used.className = "mono";
    used.textContent = fmtTokens(p.localUsedTokens || 0);
    const req = document.createElement("td");
    req.className = "mono";
    req.textContent = String(p.localRequests || 0);
    const up = document.createElement("td");
    const u = p.upstream;
    if (p.blacklist) {
      up.className = "hint";
      up.textContent = p.blacklist.reason || "已拉黑";
      up.title = up.textContent;
    } else if (u && u.ok && typeof u.balanceUsd === "number") {
      up.textContent = "$" + u.balanceUsd.toFixed(2);
    } else if (u && u.ok && u.windows && u.windows.length) {
      up.textContent = u.windows.map((w) => w.name + "剩 " + Math.round(w.remainingPercent) + "%").join(" · ");
    } else {
      up.className = "hint";
      up.textContent = (u && u.note) || (p.configured ? "该上游没有余额查询接口" : "未配置密钥");
      up.title = up.textContent;
    }
    const act = document.createElement("td");
    if (p.configured) {
      const btn = document.createElement("button");
      btn.className = p.blacklist ? "ghost" : "danger";
      btn.textContent = p.blacklist ? "解除" : "拉黑";
      btn.onclick = () => withBusy(btn, async () => {
        const path = "/admin/api/providers/" + encodeURIComponent(p.id) + "/blacklist";
        if (p.blacklist) await api(path, { method: "DELETE" });
        else await api(path, { method: "POST", body: JSON.stringify({ reason: "manual" }) });
        renderStatus(await api("/admin/api/status"));
      });
      act.appendChild(btn);
    }
    tr.append(name, used, req, up, act);
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  box.appendChild(table);
  for (const p of live) {
    const block = document.createElement("div");
    block.className = "model-block";
    const label = document.createElement("p");
    label.className = "hint";
    const models = Array.isArray(p.models) ? p.models : [];
    label.textContent = models.length
      ? p.id + " · 点模型名复制给下游"
      : p.id + " · 模型列表拉不到，下游仍可直接填该上游认识的模型名";
    block.appendChild(label);
    if (models.length) {
      const chips = document.createElement("div");
      chips.className = "chips";
      for (const raw of models) {
        const id = publicModelId(p.id, raw, multi);
        catalog.push(id);
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = id;
        chip.title = "复制 " + id;
        chip.onclick = async () => {
          try {
            await navigator.clipboard.writeText(id);
            chip.classList.add("copied");
            clearTimeout(chip._flash);
            chip._flash = setTimeout(() => chip.classList.remove("copied"), 1200);
          } catch { /* ignore */ }
        };
        chips.appendChild(chip);
      }
      block.appendChild(chips);
    }
    box.appendChild(block);
  }
  modelHint = catalog[0] || "上游模型 ID";
  document.getElementById("snippet").textContent =
    "curl " + ORIGIN + "/v1/models \\\\\\n  -H 'Authorization: Bearer sk-你签发的key'";
}

document.getElementById("copy-base").onclick = async () => {
  const btn = document.getElementById("copy-base");
  try {
    await navigator.clipboard.writeText(ORIGIN + "/v1");
    flashLabel(btn, "已复制");
  } catch {
    flashLabel(btn, "复制失败");
  }
};

async function reload() {
  const [data, status] = await Promise.all([
    api("/admin/api/keys"),
    api("/admin/api/status"),
  ]);
  renderProviderUsage(status.providers || []);
  const tb = document.getElementById("rows");
  tb.replaceChildren();
  for (const k of data.keys || []) {
    if (goneIds.has(k.id)) continue;
    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    nameTd.textContent = k.name;
    nameTd.title = k.name;
    const prefixTd = document.createElement("td");
    prefixTd.className = "mono";
    prefixTd.textContent = k.prefix + "…";
    const provTd = document.createElement("td");
    provTd.textContent = k.provider || "全部";
    const usedTd = document.createElement("td");
    usedTd.className = "mono";
    usedTd.textContent = fmtTokens(k.usedTokens || 0) + (k.requestCount ? " / " + k.requestCount + "次" : "");
    const remainTd = document.createElement("td");
    remainTd.className = "mono";
    remainTd.textContent = fmtTokens(k.remainingTokens);
    if (k.quotaTokens > 0 && (k.remainingTokens || 0) / k.quotaTokens <= 0.1) remainTd.style.color = "var(--warn)";
    const quotaTd = document.createElement("td");
    quotaTd.className = "quota-cell";
    const quotaEdit = document.createElement("div");
    quotaEdit.className = "quota-edit";
    const quotaInp = document.createElement("input");
    quotaInp.type = "number";
    quotaInp.min = "0";
    quotaInp.step = "1000";
    quotaInp.value = String(k.quotaTokens ?? defaultQuota);
    quotaInp.title = "改完失焦或回车即保存，0 表示不限额";
    const quotaStatus = document.createElement("span");
    quotaStatus.className = "quota-status";
    quotaStatus.setAttribute("aria-hidden", "true");
    const quotaLive = document.createElement("div");
    quotaLive.className = "quota-live";
    bindQuotaLive(quotaInp, quotaLive, () => "空");
    const paintRemain = (quota) => {
      const remaining = quota === 0 ? null : Math.max(0, quota - (k.usedTokens || 0));
      remainTd.textContent = fmtTokens(remaining);
      remainTd.style.color = quota > 0 && (remaining || 0) / quota <= 0.1 ? "var(--warn)" : "";
    };
    const clearQuotaOk = () => {
      clearTimeout(quotaInp._okTimer);
      quotaStatus.className = "quota-status";
      quotaStatus.textContent = "";
    };
    quotaInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") quotaInp.blur();
    });
    quotaInp.addEventListener("focus", clearQuotaOk);
    quotaInp.onchange = async () => {
      const n = Number(quotaInp.value);
      if (!Number.isFinite(n) || n < 0 || quotaInp.disabled) return;
      clearQuotaOk();
      quotaInp.disabled = true;
      quotaStatus.className = "quota-status loading";
      const started = Date.now();
      try {
        await api("/admin/api/keys/" + k.id, { method: "POST", body: JSON.stringify({ quotaTokens: n }) });
        const wait = 320 - (Date.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        paintRemain(n);
        quotaLive.textContent = describeQuota(quotaInp.value, "空");
        quotaInp.disabled = false;
        quotaStatus.className = "quota-status ok";
        quotaStatus.textContent = "✓";
        quotaInp._okTimer = setTimeout(clearQuotaOk, 1800);
      } catch (e) {
        quotaInp.disabled = false;
        quotaStatus.className = "quota-status";
        quotaLive.textContent = "保存失败：" + (e.message || e);
      }
    };
    quotaEdit.append(quotaInp, quotaStatus);
    quotaTd.append(quotaEdit, quotaLive);
    const statusTd = document.createElement("td");
    const s = document.createElement("span");
    s.className = "pill " + (k.enabled ? "ok" : "off");
    s.textContent = k.enabled ? "有效" : "已吊销";
    statusTd.appendChild(s);
    const td = document.createElement("td");
    td.className = "col-actions";
    const rev = document.createElement("button");
    rev.className = "ghost";
    rev.textContent = k.enabled ? "吊销" : "恢复";
    rev.onclick = () => withBusy(rev, async () => {
      await api("/admin/api/keys/" + k.id, { method: "POST", body: JSON.stringify({ enabled: !k.enabled }) });
      await reload();
    });
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "删除";
    del.onclick = async () => {
      if (!confirm("删除后该 Key 立刻失效，且无法找回明文。")) return;
      await withBusy(del, async () => {
        await api("/admin/api/keys/" + k.id, { method: "DELETE" });
        goneIds.add(k.id);
        tr.remove();
      });
    };
    td.append(rev, del);
    tr.append(nameTd, prefixTd, provTd, usedTd, quotaTd, remainTd, statusTd, td);
    tb.appendChild(tr);
  }
}

document.getElementById("refresh").onclick = () => withBusy(document.getElementById("refresh"), reload);

const dlg = document.getElementById("create-dlg");
const onceDlg = document.getElementById("once-dlg");
let lastPlain = "";
const quotaEl = document.getElementById("quota");
const paintCreateQuota = bindQuotaLive(
  quotaEl,
  document.getElementById("quota-live"),
  () => "空则用默认 " + fmtTokens(defaultQuota) + "（" + defaultQuota.toLocaleString("en-US") + "）",
);
function resetCreateForm() {
  document.getElementById("create-err").textContent = "";
  document.getElementById("name").value = "";
  quotaEl.value = "";
  document.getElementById("provider").value = "";
  paintCreateQuota();
}
document.getElementById("open-create").onclick = () => {
  resetCreateForm();
  dlg.showModal();
  document.getElementById("name").focus();
};
document.getElementById("create-cancel").onclick = () => dlg.close();
document.getElementById("once-close").onclick = () => onceDlg.close();
document.getElementById("once-copy").onclick = async () => {
  if (!lastPlain) return;
  const btn = document.getElementById("once-copy");
  try {
    await navigator.clipboard.writeText(lastPlain);
    flashLabel(btn, "已复制");
  } catch {
    flashLabel(btn, "复制失败");
  }
};

function addHowText(panel, tag, text, className) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  n.textContent = text;
  panel.append(n);
  return n;
}

function renderHow(tab) {
  const panel = document.getElementById("how-panel");
  panel.replaceChildren();
  const base = ORIGIN + "/v1";
  const key = lastPlain || "sk-你签发的key";
  const steps = (items) => {
    const ol = document.createElement("ol");
    for (const t of items) {
      const li = document.createElement("li");
      li.textContent = t;
      ol.append(li);
    }
    panel.append(ol);
  };
  if (tab === "opencode") {
    steps([
      "把对方 OpenCode 的 provider 配成 openai-compatible",
      "baseURL 填 " + base,
      "apiKey 填刚签发的 Key",
      "模型名填 GET /v1/models 里的 id，例如 " + modelHint,
    ]);
    addHowText(panel, "pre", JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      providers: {
        mysub: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: base, apiKey: key },
          models: { [modelHint]: {} },
        },
      },
    }, null, 2));
    addHowText(panel, "p", "Key 建议让对方自己贴，不要把明文提交到 git。", "hint");
    return;
  }
  if (tab === "cursor") {
    steps([
      "Cursor Settings → Models → 打开 Override OpenAI Base URL",
      "Base URL 填 " + base,
      "API Key 填刚签发的 sk-",
      "模型填 GET /v1/models 里的 id，或在模型列表里自定义，例如 " + modelHint,
    ]);
    addHowText(panel, "p", "这是把 Cursor 当客户端连本站，只影响本地 Chat / Agent，不影响 Tab 补全。不是去打 Cursor 内部推理接口。", "hint");
    return;
  }
  if (tab === "generic") {
    steps([
      "任何 OpenAI 兼容客户端都可以：Cherry Studio、ChatBox、NextChat、LobeChat 等",
      "API 协议选 OpenAI",
      "Base URL / API Host 填 " + base + "（不要再拼一层 /v1）",
      "API Key 填刚签发的 sk-",
      "模型名填 GET /v1/models 返回的 id。多个上游时是 上游/模型",
    ]);
    addHowText(panel, "pre", [
      "curl " + base + "/chat/completions",
      "  -H 'Authorization: Bearer " + key + "'",
      "  -H 'Content-Type: application/json'",
      "  -d '" + JSON.stringify({ model: modelHint, messages: [{ role: "user", content: "hi" }] }) + "'",
    ].join("\\n"));
    return;
  }
  steps([
    "WorkBuddy → 设置 → 模型 → 自定义 / Custom",
    "协议选 OpenAI Chat Completions，Custom Protocol 关掉",
    "地址填 " + base,
    "API Key 填刚签发的 sk-",
    "模型名填 GET /v1/models 里的 id，例如 " + modelHint,
  ]);
  addHowText(panel, "p", "同一窗口会带完整 messages，上下文不会丢。若客户端只发最新一句，带上请求头 x-session-id 即可。", "hint");
}

document.getElementById("how-tabs").onclick = (e) => {
  const btn = e.target.closest("[data-tab]");
  if (!btn) return;
  for (const el of document.getElementById("how-tabs").querySelectorAll(".tab")) el.classList.toggle("on", el === btn);
  renderHow(btn.dataset.tab);
};

document.getElementById("create").onclick = async () => {
  const err = document.getElementById("create-err");
  const btn = document.getElementById("create");
  err.textContent = "";
  const q = document.getElementById("quota").value.trim();
  const body = {
    name: document.getElementById("name").value,
    provider: document.getElementById("provider").value || undefined,
    quotaTokens: q === "" ? undefined : Number(q),
  };
  btn.disabled = true;
  try {
    const data = await api("/admin/api/keys", { method: "POST", body: JSON.stringify(body) });
    lastPlain = data.key;
    document.getElementById("once-key").textContent = data.key;
    document.getElementById("once-base").textContent = ORIGIN + "/v1";
    for (const el of document.getElementById("how-tabs").querySelectorAll(".tab")) {
      el.classList.toggle("on", el.dataset.tab === "workbuddy");
    }
    renderHow("workbuddy");
    dlg.close();
    onceDlg.showModal();
    await reload();
  } catch (e) {
    err.textContent = e.message || String(e);
  } finally {
    btn.disabled = false;
  }
};
</script>
</body>
</html>`;
}
