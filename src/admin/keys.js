function asKeyView(k) {
  const quota = typeof k.quotaTokens === "number" ? k.quotaTokens : defaultQuota;
  const used = k.usedTokens || 0;
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    enabled: k.enabled !== false,
    createdAt: k.createdAt || Date.now(),
    provider: k.provider,
    quotaTokens: quota,
    usedTokens: used,
    requestCount: k.requestCount || 0,
    remainingTokens: quota === 0 ? null : Math.max(0, quota - used),
    recent: Array.isArray(k.recent) ? k.recent : [],
  };
}

function fmtWhen(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function callName(c) {
  if (c.model && c.provider) return c.provider + "/" + c.model;
  return c.model || c.provider || "未指定";
}

function recentChevron() {
  const icon = document.createElement("span");
  icon.className = "chev";
  icon.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2.2 4.3 6 8.1l3.8-3.8");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  icon.append(svg);
  return icon;
}

function recentLine(time, model, tokens, head) {
  const tr = document.createElement("tr");
  tr.className = "recent-row" + (head ? " recent-head" : "");
  tr.hidden = true;
  const timeTd = document.createElement("td");
  timeTd.className = "c-time";
  timeTd.textContent = time;
  const modelTd = document.createElement("td");
  modelTd.className = "c-model";
  modelTd.colSpan = 2;
  modelTd.textContent = model;
  modelTd.title = model;
  const tokenTd = document.createElement("td");
  tokenTd.className = "c-tokens" + (head ? "" : " mono");
  tokenTd.colSpan = 2;
  tokenTd.textContent = tokens;
  const rest = document.createElement("td");
  rest.colSpan = 3;
  tr.append(timeTd, modelTd, tokenTd, rest);
  return tr;
}

function recentToggle(calls) {
  const list = Array.isArray(calls) ? calls.slice(0, 10) : [];
  if (!list.length) return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ghost";
  btn.append("最近", recentChevron());
  btn.title = callName(list[0]) + " · " + fmtTokens(list[0].tokens || 0);
  btn.setAttribute("aria-expanded", "false");
  const rows = [recentLine("时间", "模型", "token 使用量", true)];
  for (const c of list) rows.push(recentLine(fmtWhen(c.at), callName(c), fmtTokens(c.tokens || 0), false));
  btn.onclick = () => {
    const open = rows[0].hidden;
    for (const row of rows) row.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  return { btn, rows };
}

function withPending(listed) {
  const extra = [];
  for (const k of pendingKeys.values()) {
    if (!listed.some((x) => x.id === k.id) && !goneIds.has(k.id)) extra.push(k);
  }
  if (!extra.length) return listed;
  return [...extra, ...listed].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function reload() {
  const keysP = api("/admin/api/keys");
  const statusP = api("/admin/api/status");
  const listed = (await keysP).keys || [];
  for (const k of listed) pendingKeys.delete(k.id);
  paintKeyRows(withPending(listed));
  const status = await statusP;
  renderProviderUsage(status.providers || [], status.auto, status.autoSaved);
}

function paintKeyRows(keys) {
  lastKeys = keys;
  const tb = document.getElementById("rows");
  tb.replaceChildren();
  for (const k of keys) {
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
        pendingKeys.delete(k.id);
        tr.remove();
        for (const row of recent?.rows || []) row.remove();
      });
    };
    const recent = recentToggle(k.recent);
    td.append(rev, del);
    if (recent) td.append(recent.btn);
    tr.append(nameTd, prefixTd, provTd, usedTd, quotaTd, remainTd, statusTd, td);
    tb.append(tr);
    if (recent) tb.append(...recent.rows);
  }
}

for (const id of ["refresh", "refresh-upstream"]) {
  const btn = document.getElementById(id);
  btn.onclick = () => withBusy(btn, reload);
}

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
bindCopyField(document.getElementById("copy-once-key"), () => lastPlain);
bindCopyField(document.getElementById("copy-once-url"), () => ORIGIN + "/v1");
document.getElementById("create").onclick = async () => {
  const err = document.getElementById("create-err");
  err.textContent = "";
  const q = document.getElementById("quota").value.trim();
  const body = {
    name: document.getElementById("name").value,
    provider: document.getElementById("provider").value || undefined,
    quotaTokens: q === "" ? undefined : Number(q),
  };
  await withBusy(document.getElementById("create"), async () => {
    try {
      const data = await api("/admin/api/keys", { method: "POST", body: JSON.stringify(body) });
      lastPlain = data.key;
      document.getElementById("once-key").textContent = data.key;
      document.getElementById("once-base").textContent = ORIGIN + "/v1";
      for (const el of document.getElementById("how-tabs").querySelectorAll(".tab")) {
        el.classList.toggle("on", el.dataset.tab === "workbuddy");
      }
      renderHow(document.getElementById("how-panel"), "workbuddy", true);
      pendingKeys.set(data.id, asKeyView(data));
      paintKeyRows(withPending(lastKeys));
      dlg.close();
      onceDlg.showModal();
      await reload();
    } catch (e) {
      err.textContent = e.message || String(e);
    }
  });
};
