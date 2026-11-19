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
    opt.textContent = p.blacklist ? p.id + "（已拉黑）" : p.note ? p.id + "（已停用）" : p.configured ? p.id : p.id + "（未配置密钥）";
    opt.disabled = !p.configured || Boolean(p.blacklist);
    sel.appendChild(opt);
    return p.id + (p.blacklist ? " 拉黑" : p.note ? " 停用 " + p.note : p.configured ? " ✓" : " ✗") + "  " + p.baseUrl;
  });
  document.getElementById("providers").textContent = bits.join("  ·  ") || "暂无可用上游。请在 PROVIDERS 中添加账号，并配置对应的 {ID}_API_KEY。";
  renderProviderUsage(status.providers || [], status.auto, status.autoSaved);
}

function balanceLines(u, text) {
  const lines = [];
  if (u && Array.isArray(u.detail)) {
    for (const line of u.detail) if (line) lines.push(line);
  } else if (u && u.label && u.label !== text) {
    lines.push(u.label);
  }
  if (u && u.windows && !lines.length) {
    for (const w of u.windows) {
      let line = w.name + " 已用 " + Math.round(w.percent) + "% · 剩余 " + Math.round(w.remainingPercent) + "%";
      if (w.resetsAt) line += " · 重置 " + w.resetsAt;
      if (w.status && w.status !== "ok") line += " · " + w.status;
      lines.push(line);
    }
  }
  if (u && typeof u.usedTokens === "number") {
    lines.push("账单累计 " + fmtTokens(u.usedTokens) + (u.usageIncomplete ? "（未拉全，含未经过本站的调用）" : "（含未经过本站的调用）"));
  }
  if (u && u.note && lines.indexOf(u.note) < 0) lines.push(u.note);
  if (!lines.length && text) lines.push(text);
  return lines;
}

function autoChoices(providers, current) {
  const seen = new Set();
  const out = [];
  const add = (id) => {
    const s = String(id || "").trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const p of providers || []) {
    if (!p.configured || p.blacklist) continue;
    const raws = Array.isArray(p.catalog) ? p.catalog : (p.models || []);
    for (const raw of raws) add(p.id + "/" + raw);
  }
  for (const id of current) add(id);
  return out;
}

function modelButton(id, tip) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "auto-current";
  const name = document.createElement("span");
  name.className = "mono";
  const slash = String(id || "").indexOf("/");
  if (slash > 0) {
    const prov = document.createElement("span");
    prov.className = "auto-prov";
    prov.textContent = id.slice(0, slash);
    name.append(prov, document.createTextNode("/" + id.slice(slash + 1)));
  } else {
    name.textContent = id || "未选择";
  }
  const mark = document.createElement("span");
  mark.className = "auto-current-tip";
  mark.textContent = tip;
  btn.append(name, mark);
  return btn;
}

const autoDlg = document.getElementById("auto-dlg");
const autoQ = document.getElementById("auto-q");
const autoList = document.getElementById("auto-list");
const autoErr = document.getElementById("auto-err");
let autoPickJob = null;
let autoSaving = false;

async function commitAuto(route) {
  if (autoSaving) throw new Error("正在保存");
  autoSaving = true;
  try {
    await api("/admin/api/auto", {
      method: "POST",
      body: JSON.stringify({ easy: route.easy, hard: route.hard }),
    });
    renderStatus(await api("/admin/api/status"));
  } finally {
    autoSaving = false;
  }
}

function paintAutoPick() {
  if (!autoPickJob) return;
  const job = autoPickJob;
  const q = autoQ.value.trim().toLowerCase();
  autoList.replaceChildren();
  const groups = new Map();
  let skipped = 0;
  for (const id of job.choices) {
    if (job.exclude.indexOf(id) >= 0) {
      skipped += 1;
      continue;
    }
    if (q && id.toLowerCase().indexOf(q) < 0) continue;
    const slash = id.indexOf("/");
    const provider = slash > 0 ? id.slice(0, slash) : "其他";
    const model = slash > 0 ? id.slice(slash + 1) : id;
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push({ id, model });
  }
  if (!groups.size) {
    const empty = document.createElement("p");
    empty.className = "hint auto-empty";
    empty.textContent = q ? "没有匹配的模型" : skipped ? "都已在复杂档里" : "暂无模型";
    autoList.appendChild(empty);
    return;
  }
  for (const [provider, items] of groups) {
    const group = document.createElement("div");
    const head = document.createElement("div");
    head.className = "auto-group-name";
    head.textContent = provider;
    group.appendChild(head);
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "auto-opt" + (item.id === job.current ? " on" : "");
      btn.textContent = item.model;
      btn.title = item.id;
      btn.onclick = () => applyAutoPick(item.id, btn);
      group.appendChild(btn);
    }
    autoList.appendChild(group);
  }
}

async function applyAutoPick(id, btn) {
  const job = autoPickJob;
  if (!job || btn.disabled) return;
  if (id === job.current) {
    autoDlg.close();
    return;
  }
  autoErr.textContent = "";
  const buttons = [...autoDlg.querySelectorAll("button")];
  buttons.forEach((b) => { b.disabled = true; });
  btn.classList.add("busy");
  try {
    await job.onPick(id);
    autoDlg.close();
  } catch (e) {
    autoErr.textContent = e.message || String(e);
  } finally {
    if (btn.isConnected) btn.classList.remove("busy");
    buttons.forEach((b) => { if (b.isConnected) b.disabled = false; });
  }
}

function openAutoPick(job) {
  autoPickJob = job;
  document.getElementById("auto-title").textContent = job.title;
  document.getElementById("auto-hint").textContent = job.hint;
  autoErr.textContent = "";
  autoQ.value = "";
  paintAutoPick();
  autoDlg.showModal();
  const current = autoList.querySelector(".auto-opt.on");
  if (current) current.scrollIntoView({ block: "center" });
  autoQ.focus();
}

autoQ.addEventListener("input", paintAutoPick);
document.getElementById("auto-cancel").onclick = () => autoDlg.close();
autoDlg.addEventListener("close", () => { autoPickJob = null; });

function renderAutoEditor(auto, autoSaved, providers) {
  const easyValue = auto && auto.easy ? auto.easy : "";
  const hardList = auto && Array.isArray(auto.hard) ? auto.hard.filter(Boolean) : [];
  const choices = autoChoices(providers, [easyValue, ...hardList]);
  const fromUpstream = (providers || []).some((p) => {
    if (!p.configured || p.blacklist) return false;
    const raws = Array.isArray(p.catalog) ? p.catalog : p.models;
    return raws && raws.length;
  });
  const pickHint = fromUpstream
    ? "点一下即生效。列表是上游自己的模型，不限于开放给下游的。"
    : "点一下即生效。上游模型列表暂不可用，只能选当前这几个。";
  const block = document.createElement("div");
  block.className = "model-block";
  const head = document.createElement("div");
  head.className = "auto-head";
  const label = document.createElement("p");
  label.className = "hint";
  label.textContent = autoSaved
    ? "auto · 已保存。在弹窗里点选即生效"
    : "auto · 当前是内置档位。点选后会覆盖内置档位";
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = "auto";
  chip.title = "复制 auto";
  chip.onclick = async () => {
    try {
      await navigator.clipboard.writeText("auto");
      chip.dataset.tip = "已复制";
      chip.classList.remove("fail");
      chip.classList.add("copied");
    } catch {
      chip.dataset.tip = "复制失败";
      chip.classList.remove("copied");
      chip.classList.add("fail");
    }
    clearTimeout(chip._flash);
    chip._flash = setTimeout(() => chip.classList.remove("copied", "fail"), 1400);
  };
  head.append(label, chip);
  const easyField = document.createElement("div");
  easyField.className = "field";
  const easyLabel = document.createElement("label");
  easyLabel.textContent = "简单档";
  const easyBtn = modelButton(easyValue, "更换");
  easyBtn.onclick = () => openAutoPick({
    title: "更换简单档",
    hint: pickHint,
    current: easyValue,
    choices,
    exclude: [],
    onPick: (id) => commitAuto({ easy: id, hard: hardList }),
  });
  easyField.append(easyLabel, easyBtn);
  const hardField = document.createElement("div");
  hardField.className = "field";
  const hardLabel = document.createElement("label");
  hardLabel.textContent = "复杂档，按顺序回退";
  const hardBox = document.createElement("div");
  const err = document.createElement("p");
  err.className = "err";
  function fail(e) {
    if (err.isConnected) err.textContent = e.message || String(e);
  }
  hardList.forEach((id, i) => {
    const row = document.createElement("div");
    row.className = "auto-row";
    const idx = document.createElement("span");
    idx.className = "auto-idx";
    idx.textContent = String(i + 1);
    const current = modelButton(id, "更换");
    current.onclick = () => openAutoPick({
      title: "更换复杂档",
      hint: pickHint,
      current: id,
      choices,
      exclude: hardList.filter((x) => x !== id),
      onPick: (picked) => {
        const next = hardList.slice();
        next[i] = picked;
        return commitAuto({ easy: easyValue, hard: next });
      },
    });
    const up = document.createElement("button");
    up.type = "button";
    up.className = "ghost";
    up.textContent = "上移";
    up.disabled = i === 0;
    up.onclick = () => withBusy(up, async () => {
      err.textContent = "";
      try {
        const next = hardList.slice();
        const prev = next[i - 1];
        next[i - 1] = next[i];
        next[i] = prev;
        await commitAuto({ easy: easyValue, hard: next });
      } catch (e) { fail(e); }
    });
    const down = document.createElement("button");
    down.type = "button";
    down.className = "ghost";
    down.textContent = "下移";
    down.disabled = i === hardList.length - 1;
    down.onclick = () => withBusy(down, async () => {
      err.textContent = "";
      try {
        const next = hardList.slice();
        const nxt = next[i + 1];
        next[i + 1] = next[i];
        next[i] = nxt;
        await commitAuto({ easy: easyValue, hard: next });
      } catch (e) { fail(e); }
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "移除";
    del.disabled = hardList.length === 1;
    del.title = hardList.length === 1 ? "至少留一个" : "";
    del.onclick = () => withBusy(del, async () => {
      err.textContent = "";
      try {
        const next = hardList.slice();
        next.splice(i, 1);
        await commitAuto({ easy: easyValue, hard: next });
      } catch (e) { fail(e); }
    });
    const ops = document.createElement("div");
    ops.className = "auto-ops";
    ops.append(up, down, del);
    row.append(idx, current, ops);
    hardBox.appendChild(row);
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "auto-add";
  add.textContent = "添加";
  add.onclick = () => openAutoPick({
    title: "添加复杂档",
    hint: pickHint,
    current: "",
    choices,
    exclude: hardList.slice(),
    onPick: (id) => commitAuto({ easy: easyValue, hard: hardList.concat(id) }),
  });
  hardField.append(hardLabel, hardBox, add);
  block.append(head, easyField, hardField, err);
  if (autoSaved) {
    const actions = document.createElement("div");
    actions.className = "actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "ghost";
    reset.textContent = "恢复默认";
    reset.onclick = () => withBusy(reset, async () => {
      if (autoSaving) return;
      autoSaving = true;
      err.textContent = "";
      try {
        await api("/admin/api/auto", { method: "DELETE" });
        renderStatus(await api("/admin/api/status"));
      } catch (e) {
        fail(e);
      } finally {
        autoSaving = false;
      }
    });
    actions.appendChild(reset);
    block.appendChild(actions);
  }
  return block;
}

function renderProviderUsage(providers, auto, autoSaved) {
  const box = document.getElementById("provider-usage");
  box.replaceChildren();
  if (!providers.length) {
    box.appendChild(renderAutoEditor(auto, autoSaved, providers));
    paintGuide();
    return;
  }
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
    let text = "";
    let muted = false;
    if (p.blacklist) {
      muted = true;
      text = p.blacklist.reason || "已拉黑";
    } else if (u && u.ok && u.label) {
      text = u.label;
    } else if (u && u.ok && typeof u.balanceUsd === "number") {
      text = "$" + u.balanceUsd.toFixed(2);
    } else if (u && u.ok && u.windows && u.windows.length) {
      text = u.windows.map((w) => w.name + "剩 " + Math.round(w.remainingPercent) + "%").join(" · ");
    } else {
      muted = true;
      text = (u && u.note) || (p.configured ? "该上游没有余额查询接口" : "未配置密钥");
    }
    if (!p.blacklist && u && typeof u.usedTokens === "number") {
      const bit = "累计 " + fmtTokens(u.usedTokens);
      if (muted) {
        muted = false;
        text = bit;
      } else if (text) {
        text += " · " + bit;
      } else {
        text = bit;
      }
    }
    up.className = muted ? "hint balance" : "balance";
    const clip = document.createElement("span");
    clip.className = "clip";
    clip.textContent = text;
    up.appendChild(clip);
    const lines = balanceLines(u, text);
    if (lines.length) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      for (const line of lines) {
        const row = document.createElement("div");
        row.textContent = line;
        bubble.appendChild(row);
      }
      up.appendChild(bubble);
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
  box.appendChild(renderAutoEditor(auto, autoSaved, providers));
  for (const p of live) {
    const block = document.createElement("div");
    block.className = "model-block";
    const label = document.createElement("p");
    label.className = "hint";
    const models = Array.isArray(p.models) ? p.models : [];
    const listed = Array.isArray(p.catalog) ? p.catalog : models;
    label.textContent = models.length
      ? p.id + " · 点击模型名复制。这是开放给下游的模型"
      : listed.length
        ? p.id + " · 上游有模型，但都没开放给下游"
        : p.id + " · 模型列表获取失败，仍可填写该上游支持的模型名";
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
            chip.dataset.tip = "已复制";
            chip.classList.remove("fail");
            chip.classList.add("copied");
          } catch {
            chip.dataset.tip = "复制失败";
            chip.classList.remove("copied");
            chip.classList.add("fail");
          }
          clearTimeout(chip._flash);
          chip._flash = setTimeout(() => chip.classList.remove("copied", "fail"), 1400);
        };
        chips.appendChild(chip);
      }
      block.appendChild(chips);
    }
    box.appendChild(block);
  }
  modelHint = catalog[0] || "auto";
  document.getElementById("snippet").textContent =
    "curl " + ORIGIN + "/v1/models \\\n  -H 'Authorization: Bearer sk-签发的Key'";
  paintGuide();
}