bindCopyField(document.getElementById("copy-base"), () => ORIGIN + "/v1");
bindCopyField(document.getElementById("copy-snippet"), () => document.getElementById("snippet").textContent);

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function addHowText(panel, tag, text, className) {
  const n = el(tag, className, text);
  panel.append(n);
  return n;
}

function addNote(panel, text, kind) {
  addHowText(panel, "p", text, kind === "warn" ? "guide-note warn" : "guide-note");
}

function addDocs(panel, href, label) {
  const p = el("p", "guide-docs");
  p.append("对照官方文档：");
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = label;
  p.append(a);
  panel.append(p);
}

function addSteps(panel, items) {
  const ol = el("ol", "guide-steps");
  for (const item of items) {
    const li = document.createElement("li");
    const wrap = el("div", "guide-step-content");
    if (typeof item === "string") {
      wrap.append(el("div", "guide-step-title", item));
    } else {
      wrap.append(el("div", "guide-step-title", item.title));
      if (item.body) wrap.append(el("div", "guide-step-body", item.body));
    }
    li.append(wrap);
    ol.append(li);
  }
  panel.append(ol);
}

function addKv(panel, rows) {
  const box = el("div", "guide-kv");
  for (const [k, v] of rows) {
    box.append(el("div", "guide-kv-k", k), el("div", "guide-kv-v", v));
  }
  panel.append(box);
}

function addCopyPre(panel, text) {
  const wrap = el("div", "copy-pre");
  const btn = el("button", "copy-pre-btn");
  btn.type = "button";
  btn.append(el("span", "copy-field-tip", "点击复制"));
  wrap.append(btn, el("pre", "", text));
  panel.append(wrap);
  bindCopyField(btn, () => text);
}

function renderHow(panel, tab, compact) {
  panel.replaceChildren();
  const origin = ORIGIN;
  const base = ORIGIN + "/v1";
  const key = lastPlain || "sk-签发的Key";
  const model = modelHint || "auto";

  if (tab === "opencode") {
    addHowText(panel, "p", compact
      ? "在 opencode.jsonc 中添加一个 OpenAI 兼容 provider，package 使用 openai-compatible。"
      : "按 OpenCode 文档：目录中没有的服务，在 providers 下自行添加。协议为 Chat Completions 时，package 填 @opencode/ai/providers/openai-compatible。配置可放在项目根目录 opencode.jsonc，或 ~/.config/opencode/opencode.json。", "hint");
    addSteps(panel, compact ? [
      "package 填 @opencode/ai/providers/openai-compatible",
      "settings.baseURL 填 " + base + "（必须包含 /v1）",
      "凭证用 env 数组，不要把明文 Key 提交到 git",
      "models 的键与 GET /v1/models 的 id 一致，对话里选 mysub/" + model,
    ] : [
      { title: "建配置文件", body: "项目根目录新建 opencode.jsonc；全局则写 ~/.config/opencode/opencode.json。文件可先对照 $schema。" },
      { title: "声明兼容包", body: "providers.mysub.package 填 @opencode/ai/providers/openai-compatible。这是 Chat Completions 兼容运行时，不要用 anthropic 包。" },
      { title: "填接口地址", body: "settings.baseURL = " + base + "。必须包含 /v1，不要写到 /chat/completions，OpenCode 会自行拼接路径。" },
      { title: "填 Key", body: "env 写 [\"MY_SUB_API_KEY\"]，并在启动 OpenCode 的终端里 export。官方示例用环境变量名列表，不要把明文写进仓库。" },
      { title: "登记模型", body: "models 的键要和 GET /v1/models 的 id 一致。不一致时加 modelID 指向服务端真实名称。对话里选 mysub/" + model + "。" },
    ]);
    addCopyPre(panel, JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      providers: {
        mysub: {
          name: "API 分发",
          env: ["MY_SUB_API_KEY"],
          package: "@opencode/ai/providers/openai-compatible",
          settings: compact ? { baseURL: base, apiKey: key } : { baseURL: base },
          models: { [model]: { name: model } },
        },
      },
    }, null, 2));
    if (!compact) {
      addNote(panel, "环境变量未设置时请求会 401。OpenCode 若已有后台进程，需要在导出变量后重启，凭证才会进到服务进程。");
      addDocs(panel, "https://opencode.ai/docs/providers/", "opencode.ai/docs/providers");
    }
    return;
  }

  if (tab === "cursor") {
    addHowText(panel, "p", compact
      ? "Settings → Models：打开自备 OpenAI Key，并覆盖 Base URL。"
      : "按 Cursor 帮助文档：Settings → Models 里粘贴 OpenAI API Key。覆盖 Base URL 后，本地 Chat / Agent 会把 OpenAI 格式请求打到本站。请求仍经 Cursor 服务器发出。", "hint");
    addSteps(panel, compact ? [
      "Cursor Settings → Models → OpenAI API Key 填签发的 Key，打开 Use OpenAI API Key",
      "打开 Override OpenAI Base URL，填 " + base + "（带到 /v1，不要接到 /chat/completions）",
      "用 Add / search model 加入 auto 或上游账号页里的 id，再在 Chat / Agent 里选用",
    ] : [
      { title: "打开模型设置", body: "Cursor Settings（macOS ⌘⇧J，Windows / Linux Ctrl+Shift+J）→ Models → 展开 API Keys。" },
      { title: "填入分发账号 Key", body: "粘贴到 OpenAI API Key，打开 Use OpenAI API Key。只贴 Key 不打开开关不会生效。字段虽写 OpenAI，实际会打到你覆盖的地址。" },
      { title: "覆盖接口地址", body: "打开 Override OpenAI Base URL，填 " + base + "。要带 /v1；Cursor 会再拼 /chat/completions，不要写成完整聊天路径。" },
      { title: "添加模型", body: "用 Add / search model 加入 auto，或「上游账号」页中的 id。模型不会自动出现，需手动添加。然后在 Chat / Agent 选择器中选用。" },
    ]);
    if (!compact) {
      addKv(panel, [
        ["OpenAI API Key", "签发的分发账号 Key"],
        ["Base URL", base],
        ["模型", "手动添加 auto 或上游 id"],
      ]);
      addNote(panel, "只影响本地 Chat / Agent。Tab 补全、Auto、Cloud / Background Agent、Automations、Cursor CLI 仍走 Cursor 自己的模型。", "warn");
      addNote(panel, "自备 Key 会随每次请求发到 Cursor 后端做拼装，因此接口地址必须公网可达；填本机 localhost 通常连不上。覆盖打开后，Cursor 内置的 OpenAI 型号也会改走本站。");
      addDocs(panel, "https://cursor.com/help/models-and-usage/api-keys", "cursor.com/help · Bring your own API key");
    } else {
      addNote(panel, "只影响本地 Chat / Agent，不影响 Tab。接口需公网可达。", "warn");
    }
    return;
  }

  if (tab === "generic") {
    addHowText(panel, "p", compact
      ? "Cherry Studio：类型选 OpenAI，API 地址填根地址（不要 /v1）。其他客户端一般填到 /v1。"
      : "Cherry Studio 官方路径：设置 → 模型服务 → 添加服务商，类型选 OpenAI。官方说明：若完整接口是 …/v1/chat/completions，API 地址只填根地址，客户端会自动补路径。", "hint");
    addSteps(panel, compact ? [
      "类型选 OpenAI",
      "Cherry Studio 的 API 地址填 " + origin + "（不要 /v1，也不要 /chat/completions）",
      "其他客户端 Base URL 填 " + base,
      "API Key 填签发的分发账号 Key，模型填 auto",
    ] : [
      { title: "添加 OpenAI 服务商", body: "Cherry Studio：左侧设置 → 模型服务 → + 添加服务商，名称自定，类型选 OpenAI。ChatBox / NextChat / LobeChat 同类：新建 OpenAI 兼容渠道。" },
      { title: "填 API 地址", body: "Cherry Studio 填 " + origin + "，不要带 /v1，也不要带 /chat/completions，否则容易变成 /v1/v1/…。ChatBox 等多数客户端填 " + base + "。" },
      { title: "填 Key", body: "API Key 只粘贴签发出来的 sk-，不要加 Bearer。Cherry Studio 多个 Key 用英文逗号分隔。" },
      { title: "获取模型并启用", body: "可使用「获取模型列表」。仅将需要的模型加入列表。Cherry Studio 还需打开服务商右上角的启用开关，否则选择器中不可见。" },
      { title: "检测后再开对话", body: "点击「检测」并选择一个模型。失败时先确认是 401（Key）还是 404（地址重复拼接）。新对话中再选择该服务商和模型。" },
    ]);
    if (!compact) addKv(panel, [
      ["Cherry Studio 地址", origin],
      ["其他客户端", base],
      ["协议", "OpenAI / Chat Completions"],
      ["模型", model],
    ]);
    addCopyPre(panel, [
      "curl " + base + "/chat/completions \\",
      "  -H 'Authorization: Bearer " + key + "' \\",
      "  -H 'Content-Type: application/json' \\",
      "  -d '" + JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }) + "'",
    ].join("\n"));
    if (!compact) {
      addNote(panel, "Cherry Studio 仅当路径不是常规 /v1/chat/completions 时，才在完整地址末尾加 # 禁止再拼接。本站是常规路径，不要加 #。");
      addDocs(panel, "https://cherryai.com.cn/docs/zh-cn/pre-basic/settings/providers/", "Cherry Studio · 模型服务设置");
    }
    return;
  }

  addHowText(panel, "p", compact
    ? "设置 → 模型 → 自定义 / Custom。协议走 OpenAI Chat Completions。"
    : "按 WorkBuddy 文档：桌面端 头像 → 系统设置 → 模型。不在预设列表时选「自定义 / Custom」。自定义接入走 OpenAI 兼容的 Chat Completions，不是 Anthropic Messages。", "hint");
  addSteps(panel, compact ? [
    "头像 → 系统设置 → 模型 → 添加，提供商选自定义 / Custom",
    "地址填 " + base + "，自定义协议保持关闭（会自动补 /chat/completions）",
    "API Key 填签发的分发账号 Key",
    "模型名称填接口接受的 id，例如 auto，不要填自己起的展示名",
    "保存后先点击「测试连接」，再在对话中选用",
  ] : [
    { title: "打开模型配置", body: "头像 → 系统设置 → 模型。用添加 / 编辑维护，不必手改配置文件。" },
    { title: "选自定义", body: "提供商选「自定义 / Custom」。本站不在 OpenAI / DeepSeek 等预设里。预设只是填表模板，不代表已经开通。" },
    { title: "填接口地址", body: "填 " + base + "。自定义协议保持关闭：WorkBuddy 会把地址规范成以 /chat/completions 结尾。填 /v1 或 /v1/chat/completions 都可以。" },
    { title: "填 Key 和模型名", body: "API Key 用签发的分发账号。模型名称必须是接口接受的参数值（如 auto），不是自己起的展示名。" },
    { title: "能力开关按实际上游设置", body: "工具调用、图片输入、推理模式按模型实际能力开启。全部开启并不表示上游支持。图片输入不是图片生成。" },
    { title: "测试后再用", body: "保存不表示已连通，也不会自动切换当前会话。先点击「测试连接」，再在对话的模型选择器中选用。选择 Auto 只走服务端路由，不会纳入已添加的全部自定义模型。" },
  ]);
  if (!compact) {
    addKv(panel, [
      ["接口地址", base],
      ["协议", "OpenAI Chat Completions"],
      ["自定义协议", "关闭"],
      ["模型名", "auto 或上游账号页里的 id"],
    ]);
    addNote(panel, "配置默认写在 ~/.workbuddy-ai/models.json（Windows 为 %USERPROFILE%\\.workbuddy-ai\\models.json）。含 Key，不要传到公开仓库。");
    addDocs(panel, "https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model-Configuration", "WorkBuddy · 模型配置");
  } else {
    addNote(panel, "同一窗口会带完整 messages。若客户端只发最新一句，带上请求头 x-session-id。");
  }
}

function bindTabs(bar, panel, compact) {
  bar.onclick = (e) => {
    const btn = e.target.closest("[data-tab]");
    if (!btn || !bar.contains(btn)) return;
    for (const item of bar.querySelectorAll(".tab")) item.classList.toggle("on", item === btn);
    renderHow(panel, btn.dataset.tab, compact);
  };
}

function activeTab(bar) {
  return bar.querySelector(".tab.on")?.dataset.tab || "workbuddy";
}

function renderGuide() {
  const bar = document.getElementById("guide-tabs");
  renderHow(document.getElementById("guide-panel"), activeTab(bar), false);
}

function paintGuide() {
  const page = document.querySelector('[data-page="guide"]');
  if (page && !page.hidden) renderGuide();
}

bindTabs(document.getElementById("how-tabs"), document.getElementById("how-panel"), true);
bindTabs(document.getElementById("guide-tabs"), document.getElementById("guide-panel"), false);
