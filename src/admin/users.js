// 「用户配置」页：每个前台用户自己配了哪些 MCP 和 Skill。只读。
let ucUsers = [];
let ucQuery = "";
let ucOnlyConfigured = true;
let ucLoaded = false;
let ucMeta = null;

function ucEl(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ucPill(text, kind) {
  return ucEl("span", "pill" + (kind ? " " + kind : ""), text);
}

function ucWhen(at) {
  return at ? fmtWhen(at) : "从未修改";
}

function ucCounts(cfg) {
  if (!cfg) return { mcp: 0, skills: 0, secrets: 0, broken: 0 };
  return {
    mcp: cfg.mcpServers.length,
    skills: cfg.skills.length,
    secrets: cfg.secretNames.length,
    broken: cfg.mcpServers.filter((s) => s.enabled && s.status && !s.status.ok).length,
  };
}

function ucHasAny(cfg) {
  const c = ucCounts(cfg);
  return c.mcp + c.skills + c.secrets > 0;
}

function ucRow(label, valueNode) {
  const row = ucEl("div", "uc-row");
  row.append(ucEl("span", "uc-k", label));
  const v = ucEl("div", "uc-v");
  v.append(valueNode);
  row.append(v);
  return row;
}

function ucText(text, cls) {
  return ucEl("span", cls || "", text);
}

function ucServerStatus(s) {
  if (!s.enabled) return ucPill("已停用", "off");
  if (!s.status) return ucPill("还没连接过");
  if (s.status.ok) return ucPill("连接正常 · " + s.status.toolCount + " 个工具", "ok");
  return ucPill("连接失败", "bad");
}

function ucServerCard(s) {
  const card = ucEl("div", "uc-item");
  const head = ucEl("div", "uc-item-head");
  head.append(ucEl("strong", "", s.name), ucServerStatus(s));
  card.append(head);
  card.append(ucRow("地址", ucText(s.url, "mono")));
  card.append(ucRow("协议", ucText(s.transport === "auto" ? "自动判断" : s.transport === "http" ? "Streamable HTTP" : "SSE")));
  card.append(ucRow("允许的工具", ucText(s.allowWrite ? "全部工具（含会修改数据的）" : "只读工具")));
  const headerNames = Object.keys(s.headers || {});
  if (headerNames.length) {
    const box = ucEl("div", "uc-lines");
    for (const name of headerNames) box.append(ucText(name + ": " + s.headers[name], "mono"));
    card.append(ucRow("请求头", box));
  }
  if (s.secretNames.length) {
    const box = ucEl("div", "uc-chips");
    for (const name of s.secretNames) {
      const missing = s.missingSecrets.includes(name);
      box.append(ucPill(missing ? name + "（未保存）" : name, missing ? "bad" : ""));
    }
    card.append(ucRow("用到的密钥", box));
  }
  if (s.status) card.append(ucRow("最近连接", ucText(fmtWhen(s.status.at))));
  if (s.status && !s.status.ok && s.status.error) {
    card.append(ucRow("失败原因", ucText(s.status.error, "uc-error")));
  }
  return card;
}

function ucSkillCard(s) {
  const card = ucEl("div", "uc-item");
  const head = ucEl("div", "uc-item-head");
  head.append(ucEl("strong", "", s.name), ucPill(s.enabled ? "已启用" : "已停用", s.enabled ? "ok" : "off"));
  card.append(head);
  card.append(ucRow("描述", ucText(s.description)));
  card.append(ucRow("正文长度", ucText(s.bodyChars.toLocaleString("en-US") + " 字")));
  const more = document.createElement("details");
  more.className = "uc-more";
  more.append(ucEl("summary", "", "看正文开头"));
  const pre = ucEl("pre", "", s.preview + (s.bodyChars > s.preview.length ? "\n…（后面省略）" : ""));
  more.append(pre);
  card.append(more);
  return card;
}

function ucSection(title, hint, items) {
  const sec = ucEl("div", "uc-sec");
  sec.append(ucEl("h3", "", title));
  if (!items.length) {
    sec.append(ucEl("p", "hint", hint));
    return sec;
  }
  for (const item of items) sec.append(item);
  return sec;
}

function ucUserCard(u) {
  const cfg = u.config;
  const c = ucCounts(cfg);
  const box = document.createElement("details");
  box.className = "card uc-user" + (u.enabled ? "" : " uc-disabled");
  const sum = document.createElement("summary");
  const who = ucEl("div", "uc-who");
  who.append(ucEl("strong", "", u.name), ucEl("span", "mono uc-username", u.username || ""));
  if (!u.enabled) who.append(ucPill("账号已吊销", "off"));
  const tags = ucEl("div", "uc-tags");
  if (!cfg) {
    tags.append(ucPill("读取失败", "bad"));
  } else if (!ucHasAny(cfg)) {
    tags.append(ucEl("span", "hint", "没配置任何东西"));
  } else {
    tags.append(ucPill("MCP " + c.mcp, c.mcp ? "ok" : ""), ucPill("Skill " + c.skills, c.skills ? "ok" : ""));
    if (c.secrets) tags.append(ucPill("密钥 " + c.secrets));
    if (c.broken) tags.append(ucPill(c.broken + " 个连不上", "bad"));
  }
  const when = ucEl("span", "hint uc-when", cfg ? "修改于 " + ucWhen(cfg.updatedAt) : "");
  sum.append(who, tags, when);
  box.append(sum);
  if (!cfg) {
    box.append(ucEl("p", "hint", "这个用户的配置暂时读不出来，稍后刷新再试。"));
    return box;
  }
  const body = ucEl("div", "uc-body");
  body.append(
    ucSection("MCP 服务", "没有添加 MCP 服务。", cfg.mcpServers.map(ucServerCard)),
    ucSection("Skill", "没有添加 Skill。", cfg.skills.map(ucSkillCard)),
  );
  if (cfg.secretNames.length) {
    const names = ucEl("div", "uc-chips");
    for (const n of cfg.secretNames) names.append(ucPill(n));
    const sec = ucEl("div", "uc-sec");
    sec.append(ucEl("h3", "", "已保存的密钥（只显示名字）"), names);
    body.append(sec);
  }
  box.append(body);
  return box;
}

function ucVisible() {
  const q = ucQuery.trim().toLowerCase();
  return ucUsers.filter((u) => {
    if (ucOnlyConfigured && !ucHasAny(u.config) && u.config) return false;
    if (!q) return true;
    const cfg = u.config;
    const hay = [u.name, u.username];
    if (cfg) {
      for (const s of cfg.mcpServers) hay.push(s.name, s.url);
      for (const s of cfg.skills) hay.push(s.name, s.description);
    }
    return hay.filter(Boolean).join(" ").toLowerCase().includes(q);
  });
}

function ucPaint() {
  const meta = ucMeta;
  const list = document.getElementById("uc-list");
  list.replaceChildren();
  const configured = ucUsers.filter((u) => ucHasAny(u.config)).length;
  const mcpTotal = ucUsers.reduce((n, u) => n + ucCounts(u.config).mcp, 0);
  const skillTotal = ucUsers.reduce((n, u) => n + ucCounts(u.config).skills, 0);
  const broken = ucUsers.reduce((n, u) => n + ucCounts(u.config).broken, 0);
  document.getElementById("uc-summary").textContent =
    "共 " + (meta ? meta.total : ucUsers.length) + " 个前台用户，" + configured + " 个配置过扩展；合计 " +
    mcpTotal + " 个 MCP、" + skillTotal + " 个 Skill" + (broken ? "，其中 " + broken + " 个 MCP 连不上" : "") + "。" +
    (meta && meta.truncated ? "（只显示最新的 " + ucUsers.length + " 个用户）" : "");
  const shown = ucVisible();
  if (!shown.length) {
    list.append(ucEl("p", "hint uc-empty", ucUsers.length ? "没有符合条件的用户。" : "还没有前台用户。在「分发账号」里创建时填上聊天用户名，就是前台用户。"));
    return;
  }
  for (const u of shown) list.append(ucUserCard(u));
}

async function loadUsers() {
  const err = document.getElementById("uc-err");
  err.textContent = "";
  try {
    const data = await api("/admin/api/users-config");
    ucUsers = data.users || [];
    ucMeta = { total: data.total, truncated: data.truncated };
    ucLoaded = true;
    ucPaint();
  } catch (e) {
    err.textContent = e.message || String(e);
  }
}

document.getElementById("uc-refresh").onclick = () => withBusy(document.getElementById("uc-refresh"), loadUsers);
document.getElementById("uc-q").addEventListener("input", (e) => {
  ucQuery = e.target.value;
  if (ucLoaded) ucPaint();
});
document.getElementById("uc-only").addEventListener("change", (e) => {
  ucOnlyConfigured = e.target.checked;
  if (ucLoaded) ucPaint();
});
