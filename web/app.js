const PAGES = ["overview", "chat", "models", "accounts"];
const KEYS = {
  apiKey: "cursor2api.console.apiKey",
  model: "cursor2api.console.model",
  system: "cursor2api.console.system",
  tools: "cursor2api.console.tools",
  stream: "cursor2api.console.stream",
  chat: "cursor2api.console.chat",
};

const SAMPLE_TOOL = `[
  {
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get the current weather for a city",
      "parameters": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }
  }
]`;

const FAMILY_ORDER = ["auto", "composer", "claude", "gpt", "gemini", "grok", "cursor"];
const FAMILY_LABEL = {
  auto: "Auto",
  composer: "Composer",
  claude: "Claude",
  gpt: "GPT",
  gemini: "Gemini",
  grok: "Grok",
  cursor: "Cursor",
};

const state = {
  page: "overview",
  health: null,
  healthError: "",
  status: null,
  statusError: "",
  authError: false,
  loading: true,
  models: [],
  update: null,
  modelsError: "",
  modelsLoading: false,
  modelQuery: "",
  chat: [],
  streaming: false,
  abort: null,
  stick: true,
  apiKey: localStorage.getItem(KEYS.apiKey) || "",
  login: null,
  loginTimer: 0,
};

const $ = (id) => document.getElementById(id);

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "value" && "value" in node) node.value = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer = 0;
function toast(text) {
  const node = $("toast");
  node.textContent = text;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch {
    toast("复制失败");
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function authHeaders(extra) {
  const headers = new Headers(extra || {});
  if (state.apiKey) headers.set("authorization", `Bearer ${state.apiKey}`);
  return headers;
}

async function errorMessage(res) {
  try {
    const body = await res.json();
    const message = body.error?.message || `${res.status} ${res.statusText}`;
    return body.cursor2api_account ? `${message}（账号 ${body.cursor2api_account}）` : message;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function setPage(page, updateHash = true) {
  const next = PAGES.includes(page) ? page : "overview";
  state.page = next;
  if (updateHash && location.hash.replace("#", "") !== next) location.hash = next;
  for (const name of PAGES) {
    const section = $(`page-${name}`);
    section.hidden = name !== next;
    document.querySelector(`nav [data-page="${name}"]`).classList.toggle("active", name === next);
  }
  if (next === "chat") $("composer-input").focus();
}

function renderConnection() {
  const dot = $("connection-dot");
  const label = $("connection-label");
  dot.className = "dot";
  if (state.loading) {
    label.textContent = "正在连接…";
    return;
  }
  if (state.healthError) {
    dot.classList.add("bad");
    label.textContent = "无法连接";
    return;
  }
  if (state.authError) {
    dot.classList.add("warn");
    label.textContent = "需要密钥";
    return;
  }
  dot.classList.add("ok");
  const healthy = state.status?.accounts.healthy ?? state.health?.accounts ?? 0;
  const total = state.status?.accounts.total;
  label.textContent = total == null ? `在线 · ${healthy} 个账号` : `在线 · ${healthy}/${total} 个账号`;
  $("nav-accounts").textContent = total == null ? "" : String(healthy);
}

function renderBanner() {
  const banner = $("banner");
  banner.replaceChildren();
  if (state.healthError) {
    banner.hidden = false;
    banner.append(
      h("span", {}, state.healthError),
      h("button", { type: "button", class: "ghost", onclick: () => refresh() }, "重试"),
    );
    return;
  }
  if (state.status && state.status.config.apiKeyRequired === false) {
    banner.hidden = false;
    banner.append(
      h("span", {}, "还没有调用密钥。第三方平台现在不能调模型。"),
      h("button", { type: "button", class: "ghost", onclick: () => openSettings() }, "去设置"),
    );
    return;
  }
  banner.hidden = true;
}

function formatDuration(sec) {
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分`;
  return `${sec} 秒`;
}

function formatWhen(iso) {
  if (!iso) return "未知";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const absolute = new Date(time).toLocaleString("zh-CN", { hour12: false });
  const delta = time - Date.now();
  let relative = "已过期";
  if (delta > 86400000) relative = `还有 ${Math.round(delta / 86400000)} 天`;
  else if (delta > 3600000) relative = `还有 ${Math.round(delta / 3600000)} 小时`;
  else if (delta > 0) relative = `还有 ${Math.max(1, Math.round(delta / 60000))} 分钟`;
  return `${absolute} · ${relative}`;
}

function shellQuote(json) {
  return `'${json.replaceAll("'", `'\\''`)}'`;
}

function sampleCurl() {
  const prefix = state.status?.config.modelPrefix ?? "cursor-";
  const model = state.models.find((item) => item.id.includes("sonnet"))?.id || `${prefix}auto`;
  const payload = { model, messages: [{ role: "user", content: "hi" }] };
  const lines = [`curl ${location.origin}/v1/chat/completions \\`, `  -H 'content-type: application/json' \\`];
  if (state.status?.config.apiKeyRequired) lines.push(`  -H "authorization: Bearer $CURSOR_DIRECT_API_KEY" \\`);
  lines.push(`  -d ${shellQuote(JSON.stringify(payload))}`);
  return lines.join("\n");
}

function renderOverview() {
  const root = $("overview-body");
  root.replaceChildren();
  if (state.healthError) {
    root.append(h("div", { class: "callout bad" }, h("p", {}, state.healthError)));
    return;
  }
  const status = state.status;
  const healthy = status?.accounts.healthy ?? state.health?.accounts ?? "—";
  const total = status?.accounts.total;
  const config = status?.config;
  root.append(
    h("div", { class: "metrics" }, [
      metric("可用账号", healthy, total == null ? "健康检查里的数量" : `池中共 ${total} 个`),
      metric("模型", state.modelsLoading ? "…" : state.models.length || "—", state.modelsError || "当前账号能直接调用的"),
      metric("已运行", status ? formatDuration(status.uptimeSec) : "—", location.host),
    ]),
  );
  if (status && status.accounts.total === 0) {
    root.append(
      h("div", { class: "callout" }, [
        h("p", {}, "账号池是空的。到「账号」页贴入 token，或在终端运行 npm run login。"),
      ]),
    );
  }
  if (state.statusError) root.append(h("div", { class: "callout bad" }, h("p", {}, state.statusError)));

  const base = `${location.origin}/v1`;
  root.append(
    h("div", { class: "split" }, [
      h("section", { class: "panel" }, [
        h("h2", {}, "接入地址"),
        endpoint("Base", base),
        endpoint("模型", `${base}/models`),
        endpoint("对话", `${base}/chat/completions`),
        h("div", { class: "stack" }, [
          h("div", { class: "dialog-head" }, [
            h("span", { class: "hint" }, "最小请求"),
            h("button", { type: "button", class: "ghost", onclick: () => copyText(sampleCurl()) }, "复制"),
          ]),
          h("pre", {}, sampleCurl()),
        ]),
      ]),
      h("section", { class: "panel" }, [
        h("h2", {}, "运行配置"),
        config
          ? h("dl", {}, [
              kv("模型前缀", config.modelPrefix || "（无）"),
              kv("原生工具", config.nativeToolsOpen ? "全部保留" : config.allowedNativeTools.join(", ") || "（无）"),
              kv("上游", config.upstream),
              kv("客户端版本", config.clientVersion),
              kv("超时", `${Math.round(config.timeoutMs / 1000)} 秒`),
              kv("代理", config.proxyEnabled ? "SOCKS5 已配置" : "直连"),
              kv("system 消息", config.systemAsHistory ? "改写成开场对话" : "原样发送"),
              kv("调用密钥", config.apiKeyRequired ? "已设置，第三方平台必须携带" : "未设置，模型接口已关闭"),
            ])
          : h("p", { class: "hint" }, "还没有读到进程配置。"),
        state.update
          ? h("p", { class: "hint" }, `在线更新：${state.update.message}`)
          : h("p", { class: "hint" }, "在线更新可以在设置里检查。"),
      ]),
    ]),
  );
}

function metric(label, value, sub) {
  return h("article", { class: "metric" }, [
    h("div", { class: "label" }, label),
    h("div", { class: "value" }, String(value)),
    h("div", { class: "sub" }, sub),
  ]);
}

function endpoint(label, value) {
  return h("div", { class: "endpoint" }, [
    h("span", {}, label),
    h("code", {}, value),
    h("button", { type: "button", class: "ghost", onclick: () => copyText(value) }, "复制"),
  ]);
}

function kv(label, value) {
  return h("div", { class: "kv" }, [h("dt", {}, label), h("dd", { class: "mono" }, value)]);
}

function accountBadge(item) {
  if (item.schedulable === false) return h("span", { class: "tag bad" }, "停用");
  if (!item.healthy) return h("span", { class: "tag bad" }, "冷却中");
  if (item.label === state.status?.accounts.nextLabel) return h("span", { class: "tag ok" }, "下一个");
  return h("span", { class: "tag ok" }, "轮询中");
}

function renderAccounts() {
  const root = $("accounts-body");
  root.replaceChildren();
  if (state.statusError) {
    root.append(h("div", { class: "callout bad" }, h("p", {}, state.statusError)));
    return;
  }
  const next = state.status?.accounts.nextLabel;
  root.append(
    h("p", { class: "hint account-lead" }, next ? `下一请求使用 ${next}。成功后计数加一，再换下一个可用账号。` : "当前没有可调度的账号。"),
  );
  root.append(loginCard(), manualAccount());
  if (state.accountError) root.append(h("div", { class: "callout bad" }, h("p", {}, state.accountError)));
  const items = state.status?.accounts.items ?? [];
  if (!state.status) {
    root.append(h("p", { class: "hint" }, state.statusError || "正在读取账号池…"));
    return;
  }
  if (items.length === 0) {
    root.append(h("div", { class: "callout" }, h("p", {}, "还没有账号。在上面贴入 access token，或在终端用 npm run login -- --merge 追加。")));
    return;
  }
  const table = h("table", { class: "accounts" }, [
    h("thead", {}, h("tr", {}, ["顺序", "标签", "状态", "请求", "最近使用", "到期", "操作"].map((name) => h("th", {}, name)))),
    h(
      "tbody",
      {},
      items.map((item, index) =>
        h("tr", {}, [
          h("td", {}, String(index + 1)),
          h("td", { class: "mono" }, item.label),
          h("td", {}, accountBadge(item)),
          h("td", {}, String(item.requestCount ?? 0)),
          h("td", {}, item.lastUsedAt ? formatWhen(item.lastUsedAt) : "—"),
          h("td", {}, formatWhen(item.expiresAt)),
          h("td", {}, accountActions(item)),
        ]),
      ),
    ),
  ]);
  root.append(table, h("p", { class: "hint" }, "令牌只在添加时提交，列表里不会再显示。停用或冷却中的账号会被跳过。"));
}

function loginCard() {
  const pending = state.login?.status === "pending";
  const failed = state.login && state.login.status !== "pending";
  return h("section", { class: "panel login-card" }, [
    h("h2", {}, "用 Cursor 登录"),
    h("p", { class: "hint" }, "生成授权链接，在浏览器里点确认。确认后这个号自动进入轮询，页面上看不到 token。"),
    pending
      ? h("div", { class: "login-pending" }, [
          h("a", { class: "primary link-btn", href: state.login.url, target: "_blank", rel: "noopener noreferrer" }, "打开授权页面"),
          h("button", { type: "button", class: "ghost", onclick: () => copyText(state.login.url) }, "复制链接"),
          h("p", { class: "hint" }, "正在等待确认，确认后列表会自己更新。"),
          h("button", { type: "button", class: "ghost", onclick: cancelLogin }, "取消"),
        ])
      : h("div", { class: "login-start" }, [
          h("label", { class: "field" }, [
            "标签，可选",
            h("input", { id: "login-label", value: state.login?.label || "", autocomplete: "off", spellcheck: "false", placeholder: "不填就用登录邮箱" }),
          ]),
          h("button", { type: "button", class: "primary", onclick: startLogin }, "生成授权链接"),
        ]),
    failed ? h("p", { class: "msg-error" }, state.login.error || "登录没有完成") : null,
    failed ? h("button", { type: "button", class: "ghost", onclick: resetLogin }, "重试") : null,
  ]);
}

function manualAccount() {
  return h("details", { class: "manual-account" }, [
    h("summary", {}, "已经有 token，直接贴入"),
    accountForm(),
  ]);
}

async function startLogin() {
  stopLoginPoll();
  state.accountError = "";
  const label = $("login-label")?.value.trim() || "";
  try {
    const started = await accountApi("/console/api/accounts/login", {
      method: "POST",
      body: JSON.stringify({ label }),
    });
    state.login = { id: started.id, url: started.url, status: "pending", label };
    renderAccounts();
    state.loginTimer = setTimeout(pollLogin, 1500);
  } catch (err) {
    state.accountError = err.message || "无法生成登录链接";
    renderAccounts();
  }
}

async function pollLogin() {
  const current = state.login;
  if (!current?.id || current.status !== "pending") return;
  try {
    const body = await accountApi(`/console/api/accounts/login/${current.id}`, { method: "GET" });
    if (state.login?.id !== current.id) return;
    if (body.status === "ready") {
      stopLoginPoll();
      toast(`${body.replaced ? "已更新" : "已加入"} ${body.label}`);
      state.login = null;
      await refresh();
      return;
    }
    if (body.status === "expired" || body.status === "error") {
      stopLoginPoll();
      state.login = { ...current, status: body.status, error: body.error || "登录没有完成" };
      renderAccounts();
      return;
    }
    state.loginTimer = setTimeout(pollLogin, 2000);
  } catch (err) {
    if (state.login?.id !== current.id) return;
    stopLoginPoll();
    state.login = { ...current, status: "error", error: err.message || "登录状态查询失败" };
    renderAccounts();
  }
}

function cancelLogin() {
  stopLoginPoll();
  state.login = null;
  renderAccounts();
}

function resetLogin() {
  state.login = null;
  renderAccounts();
}

function stopLoginPoll() {
  if (state.loginTimer) clearTimeout(state.loginTimer);
  state.loginTimer = 0;
}

function accountForm() {
  return h("form", { class: "account-form", onsubmit: submitAccount }, [
    h("label", { class: "field" }, [
      "标签",
      h("input", { id: "account-label", autocomplete: "off", spellcheck: "false", placeholder: "例如 desk-2" }),
    ]),
    h("label", { class: "field" }, [
      "Access token",
      h("input", { id: "account-access", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "access token" }),
    ]),
    h("label", { class: "field" }, [
      "Refresh token",
      h("input", { id: "account-refresh", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "可选" }),
    ]),
    h("button", { type: "submit", class: "primary" }, "加入轮询"),
  ]);
}

function accountActions(item) {
  const buttons = [];
  if (item.schedulable === false) {
    buttons.push(h("button", { type: "button", class: "ghost", onclick: () => setSchedulable(item, true) }, "启用"));
  } else {
    buttons.push(h("button", { type: "button", class: "ghost", onclick: () => setSchedulable(item, false) }, "停用"));
    if (!item.healthy) buttons.push(h("button", { type: "button", class: "ghost", onclick: () => clearCooldown(item) }, "解除冷却"));
  }
  buttons.push(h("button", { type: "button", class: "ghost", onclick: () => removeAccount(item) }, "移除"));
  return h("div", { class: "row-actions" }, buttons);
}

async function submitAccount(event) {
  event.preventDefault();
  const label = $("account-label").value.trim();
  const accessToken = $("account-access").value.trim();
  const refreshToken = $("account-refresh").value.trim();
  state.accountError = "";
  try {
    await accountApi("/console/api/accounts", {
      method: "POST",
      body: JSON.stringify({ label, accessToken, ...(refreshToken ? { refreshToken } : {}) }),
    });
    $("account-access").value = "";
    $("account-refresh").value = "";
    toast(`已加入 ${label}`);
    await refresh();
  } catch (err) {
    state.accountError = err.message || "添加失败";
    renderAccounts();
  }
}

async function setSchedulable(item, schedulable) {
  try {
    await accountApi(`/console/api/accounts/${encodeURIComponent(item.label)}/schedulable`, {
      method: "POST",
      body: JSON.stringify({ schedulable }),
    });
    await refresh();
  } catch (err) {
    toast(err.message || "更新失败");
  }
}

async function clearCooldown(item) {
  try {
    await accountApi(`/console/api/accounts/${encodeURIComponent(item.label)}/clear-cooldown`, { method: "POST", body: "{}" });
    await refresh();
  } catch (err) {
    toast(err.message || "解除失败");
  }
}

async function removeAccount(item) {
  if (!confirm(`把 ${item.label} 移出轮询？`)) return;
  try {
    await accountApi(`/console/api/accounts/${encodeURIComponent(item.label)}`, { method: "DELETE" });
    await refresh();
  } catch (err) {
    toast(err.message || "移除失败");
  }
}

async function accountApi(path, options) {
  const res = await fetch(path, { ...options, headers: authHeaders({ "content-type": "application/json" }) });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

function familyOf(id) {
  const prefix = state.status?.config.modelPrefix ?? "";
  const raw = prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
  return (raw.split("-")[0] || "other").toLowerCase();
}

function renderModels() {
  const meta = $("models-meta");
  const root = $("models-body");
  root.replaceChildren();
  if (state.modelsLoading) {
    meta.textContent = "正在从账号拉取模型…";
    root.append(h("p", { class: "hint" }, "上游模型列表通常要几秒。"));
    return;
  }
  if (state.modelsError) {
    meta.textContent = "拉取失败";
    root.append(h("div", { class: "callout bad" }, h("p", {}, state.modelsError)));
    return;
  }
  const query = state.modelQuery.trim().toLowerCase();
  const matched = state.models.filter((item) => item.id.toLowerCase().includes(query));
  meta.textContent = query ? `${matched.length} / ${state.models.length} 个模型` : `${state.models.length} 个模型`;
  if (state.models.length === 0) {
    root.append(h("p", { class: "hint" }, "还没有模型。有可用账号之后点重新拉取。"));
    return;
  }
  const groups = new Map();
  for (const item of matched) {
    const key = familyOf(item.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ai = FAMILY_ORDER.indexOf(a);
    const bi = FAMILY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  if (keys.length === 0) {
    root.append(h("p", { class: "hint" }, "没有匹配的模型。"));
    return;
  }
  for (const key of keys) {
    const cards = (groups.get(key) ?? []).map((item) =>
      h("button", { type: "button", class: "model-card", onclick: () => selectModel(item.id) }, [
        h("code", {}, item.id),
        h("span", { class: "use" }, "使用"),
      ]),
    );
    root.append(h("section", { class: "family" }, [h("h2", {}, FAMILY_LABEL[key] || key), h("div", { class: "model-grid" }, cards)]));
  }
}

function selectModel(id) {
  $("model-input").value = id;
  sessionStorage.setItem(KEYS.model, id);
  setPage("chat");
  toast(`已选中 ${id}`);
}

function fillModelList(ids) {
  const list = $("model-options");
  list.replaceChildren(...ids.map((id) => h("option", { value: id }, id)));
  if (!$("model-input").value.trim()) {
    const preferred = ids.find((id) => id.includes("sonnet")) || ids.find((id) => id.includes("composer")) || ids[0] || "";
    if (preferred) {
      $("model-input").value = preferred;
      sessionStorage.setItem(KEYS.model, preferred);
    }
  }
}

function prose(text) {
  const frag = document.createDocumentFragment();
  String(text || "").split("```").forEach((part, index) => {
    if (!part) return;
    if (index % 2 === 1) {
      const lines = part.split("\n");
      const body = lines[0] && !lines[0].includes(" ") && lines.length > 1 ? lines.slice(1).join("\n") : part;
      const pre = h("pre", {}, h("code", {}, body.replace(/\n$/, "")));
      frag.append(pre);
      return;
    }
    frag.append(document.createTextNode(part));
  });
  return frag;
}

function prettyJson(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return String(raw ?? "");
  }
}

function renderTranscript() {
  const root = $("transcript");
  root.replaceChildren();
  if (state.chat.length === 0) {
    root.append(
      h("div", { class: "empty" }, [
        h("p", {}, "从一条消息开始。"),
        h("p", { class: "hint" }, "工具调用会停在这一轮，等你把结果贴回来再继续。"),
        h("div", { class: "chips" }, [
          chip("一句话解释 HTTP/2"),
          chip("你现在能看到哪些工具？"),
        ]),
      ]),
    );
    return;
  }
  for (const message of state.chat) root.append(renderMessage(message));
  follow();
}

function chip(text) {
  return h("button", {
    type: "button",
    class: "ghost",
    onclick: () => {
      $("composer-input").value = text;
      $("composer-input").focus();
    },
  }, text);
}

function renderMessage(message) {
  if (message.role === "user") {
    return h("article", { class: "msg-user", "data-id": message.id }, h("div", { class: "prose" }, message.content));
  }
  if (message.role === "tool") {
    return h("article", { class: "msg-tool", "data-id": message.id }, [
      h("div", { class: "role" }, `工具结果 · ${message.name || message.toolCallId}`),
      h("pre", {}, message.content || "（空）"),
    ]);
  }
  const reasoning = h("details", { class: "reasoning" }, [
    h("summary", {}, "思考"),
    h("div", { class: "reasoning-body" }, message.reasoning || ""),
  ]);
  reasoning.hidden = !message.reasoning;
  if (message.reasoning) reasoning.open = true;
  const body = h("div", { class: "prose" });
  body.append(prose(message.content));
  const node = h("article", { class: "msg-assistant", "data-id": message.id }, [
    h("div", { class: "role" }, message.account ? `助手 · ${message.account}` : "助手"),
    reasoning,
    body,
  ]);
  if (message.pending && !message.content && !message.reasoning) {
    node.append(h("div", { class: "hint pending-label" }, [h("span", { class: "pending-dot" }), "正在生成…"]));
  }
  if (message.error) node.append(h("div", { class: "msg-error" }, message.error));
  if (message.stopped) node.append(h("div", { class: "hint" }, "已停止"));
  if (message.toolCalls?.length) {
    for (const call of message.toolCalls) {
      const answered = state.chat.some((item) => item.role === "tool" && item.toolCallId === call.id);
      const card = h("div", { class: "tool-call" }, [
        h("div", { class: "role" }, `调用 ${call.name}`),
        h("pre", {}, prettyJson(call.arguments)),
      ]);
      if (!answered && !message.pending) {
        const area = h("textarea", { rows: "3", placeholder: "把工具结果贴在这里，可以是 JSON 或纯文本" });
        area.dataset.callId = call.id;
        card.append(area);
      }
      node.append(card);
    }
    const pendingCalls = message.toolCalls.filter(
      (call) => !state.chat.some((item) => item.role === "tool" && item.toolCallId === call.id),
    );
    if (pendingCalls.length > 0 && !message.pending) {
      node.append(
        h("div", { class: "msg-actions" }, [
          h("button", { type: "button", class: "primary", onclick: () => submitToolResults(message, node) }, "回传并继续"),
        ]),
      );
    }
  }
  if (message.usage) {
    node.append(h("div", { class: "usage" }, `输出 ${message.usage.completion_tokens ?? 0} tokens`));
  }
  if (message.content && !message.pending) {
    node.append(
      h("div", { class: "msg-actions" }, [
        h("button", { type: "button", class: "ghost", onclick: () => copyText(message.content) }, "复制"),
      ]),
    );
  }
  return node;
}

function follow() {
  if (!state.stick) return;
  const box = $("transcript");
  box.scrollTop = box.scrollHeight;
}

function patchAssistant(message) {
  const node = document.querySelector(`[data-id="${CSS.escape(message.id)}"]`);
  if (!node) {
    renderTranscript();
    return;
  }
  const box = $("transcript");
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  node.querySelector(".pending-label")?.remove();
  const reasoning = node.querySelector(".reasoning");
  const body = node.querySelector(".reasoning-body");
  if (message.reasoning) {
    const first = !body.textContent;
    reasoning.hidden = false;
    body.textContent = message.reasoning;
    if (first) reasoning.open = true;
  }
  node.querySelector(".prose").replaceChildren(prose(message.content));
  if (near) box.scrollTop = box.scrollHeight;
}

function readTools() {
  const raw = $("tools-input").value.trim();
  if (!raw) return { tools: [], error: "" };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { tools: [], error: "工具需要是 JSON 数组" };
    return { tools: parsed, error: "" };
  } catch {
    return { tools: [], error: "工具 JSON 无法解析" };
  }
}

function showToolsError() {
  $("tools-error").textContent = readTools().error;
}

function openaiMessages() {
  const out = [];
  const system = $("system-input").value.trim();
  if (system) out.push({ role: "system", content: system });
  for (const message of state.chat) {
    if (message.pending) continue;
    if (message.error && !message.content && !(message.toolCalls?.length)) continue;
    if (message.role === "user") out.push({ role: "user", content: message.content });
    else if (message.role === "assistant") {
      if (!message.content && !(message.toolCalls?.length)) continue;
      const entry = { role: "assistant", content: message.content || null };
      if (message.toolCalls?.length) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      out.push(entry);
    } else if (message.role === "tool") {
      out.push({ role: "tool", tool_call_id: message.toolCallId, name: message.name, content: message.content });
    }
  }
  return out;
}

function requestPayload(messages) {
  const tools = readTools();
  const payload = {
    model: $("model-input").value.trim() || "auto",
    messages,
    stream: $("stream-input").checked,
  };
  if (tools.tools.length > 0) payload.tools = tools.tools;
  return payload;
}

function buildCurl() {
  const messages = openaiMessages();
  const payload = requestPayload(messages.length ? messages : [{ role: "user", content: "hi" }]);
  const lines = [`curl ${location.origin}/v1/chat/completions \\`, `  -H 'content-type: application/json' \\`];
  if (state.apiKey || state.status?.config.apiKeyRequired) {
    lines.push(`  -H "authorization: Bearer $CURSOR_DIRECT_API_KEY" \\`);
  }
  lines.push(`  -d ${shellQuote(JSON.stringify(payload))}`);
  return lines.join("\n");
}

function persistChat() {
  try {
    sessionStorage.setItem(KEYS.chat, JSON.stringify(state.chat.slice(-80)));
  } catch {
    /* sessionStorage can reject oversized transcripts; the live thread still works. */
  }
}

async function refresh() {
  state.loading = true;
  renderConnection();
  try {
    const healthRes = await fetch("/health");
    if (!healthRes.ok) throw new Error(`健康检查返回 ${healthRes.status}`);
    state.health = await healthRes.json();
    state.healthError = "";
    const statusRes = await fetch("/console/api/status", { headers: authHeaders() });
    if (!statusRes.ok) {
      state.authError = false;
      state.statusError = await errorMessage(statusRes);
      state.status = null;
    } else {
      state.authError = false;
      state.statusError = "";
      state.status = await statusRes.json();
      if (state.status?.config.apiKeyRequired) {
        const settingsRes = await fetch("/console/api/settings");
        if (settingsRes.ok) {
          const settings = await settingsRes.json();
          if (settings.apiKey) {
            state.apiKey = settings.apiKey;
            localStorage.setItem(KEYS.apiKey, settings.apiKey);
          }
        }
      }
      const updateRes = await fetch("/console/api/update");
      if (updateRes.ok) state.update = await updateRes.json();
    }
  } catch {
    state.health = null;
    state.status = null;
    state.healthError = "连不上 cursor2api。请确认服务已启动，并且是从它的 /console 打开这个页面。";
  }
  state.loading = false;
  renderConnection();
  renderBanner();
  renderOverview();
  renderAccounts();
  if (!state.authError && !state.healthError && (state.status?.accounts.healthy ?? 0) > 0 && state.models.length === 0) {
    loadModels();
  }
}

async function loadModels() {
  if (state.authError || state.healthError) {
    state.modelsError = state.authError ? "先填写 API Key。" : state.healthError;
    renderModels();
    return;
  }
  state.modelsLoading = true;
  state.modelsError = "";
  renderModels();
  renderOverview();
  try {
    const res = await fetch("/v1/models", { headers: authHeaders() });
    if (res.status === 401) {
      state.modelsError = await errorMessage(res);
      renderBanner();
      renderConnection();
      return;
    }
    if (!res.ok) throw new Error(await errorMessage(res));
    const body = await res.json();
    state.models = Array.isArray(body.data) ? body.data : [];
    fillModelList(state.models.map((item) => item.id));
  } catch (err) {
    state.models = [];
    state.modelsError = err.message || "模型列表拉取失败";
  } finally {
    state.modelsLoading = false;
    renderModels();
    renderOverview();
  }
}

async function complete() {
  const tools = readTools();
  if (tools.error) {
    showToolsError();
    toast(tools.error);
    return;
  }
  const model = $("model-input").value.trim();
  if (!model) {
    toast("先选一个模型");
    return;
  }
  const assistant = {
    id: uid(),
    role: "assistant",
    content: "",
    reasoning: "",
    toolCalls: [],
    usage: null,
    pending: true,
    error: "",
    stopped: false,
  };
  state.chat.push(assistant);
  state.streaming = true;
  state.stick = true;
  syncComposer();
  renderTranscript();
  const controller = new AbortController();
  state.abort = controller;
  try {
    const payload = requestPayload(openaiMessages());
    const res = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(await errorMessage(res));
    if (payload.stream) await readStream(res, assistant);
    else await readBuffered(res, assistant);
  } catch (err) {
    if (err.name === "AbortError") assistant.stopped = true;
    else assistant.error = err.message || "请求失败";
  } finally {
    assistant.pending = false;
    state.streaming = false;
    state.abort = null;
    if (!assistant.content && !assistant.reasoning && !assistant.toolCalls.length && !assistant.error && !assistant.stopped) {
      assistant.error = "上游没有返回内容";
    }
    persistChat();
    syncComposer();
    renderTranscript();
  }
}

async function readBuffered(res, assistant) {
  const body = await res.json();
  if (typeof body.cursor2api_account === "string") assistant.account = body.cursor2api_account;
  if (body.error?.message) throw new Error(body.error.message);
  const message = body.choices?.[0]?.message ?? {};
  assistant.content = message.content || "";
  assistant.reasoning = message.reasoning_content || "";
  assistant.toolCalls = (message.tool_calls || []).map(normalizeCall);
  assistant.usage = body.usage || null;
}

async function readStream(res, assistant) {
  if (!res.body) throw new Error("浏览器没有提供响应流");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) applySse(block, assistant);
  }
  if (buffer.trim()) applySse(buffer, assistant);
}

function applySse(block, assistant) {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return;
  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return;
  }
  if (typeof json.cursor2api_account === "string") assistant.account = json.cursor2api_account;
  if (json.error?.message) {
    assistant.error = json.error.message;
    return;
  }
  const choice = json.choices?.[0];
  const delta = choice?.delta ?? {};
  if (typeof delta.content === "string") assistant.content += delta.content;
  if (typeof delta.reasoning_content === "string") assistant.reasoning += delta.reasoning_content;
  for (const call of delta.tool_calls || []) assistant.toolCalls.push(normalizeCall(call));
  if (json.usage) assistant.usage = json.usage;
  patchAssistant(assistant);
}

function normalizeCall(call) {
  return {
    id: call.id || uid(),
    name: call.function?.name || "",
    arguments: call.function?.arguments || "{}",
  };
}

function submitToolResults(message, node) {
  const tools = readTools();
  if (tools.error) {
    showToolsError();
    toast(tools.error);
    return;
  }
  if (!$("model-input").value.trim()) {
    toast("先选一个模型");
    return;
  }
  const areas = [...node.querySelectorAll("textarea[data-call-id]")];
  if (areas.length === 0) return;
  for (const area of areas) {
    const call = message.toolCalls.find((item) => item.id === area.dataset.callId);
    state.chat.push({
      id: uid(),
      role: "tool",
      content: area.value,
      toolCallId: area.dataset.callId,
      name: call?.name || "",
    });
  }
  persistChat();
  complete();
}

function syncComposer() {
  $("send-chat").disabled = state.streaming;
  $("stop-chat").hidden = !state.streaming;
  $("composer-input").disabled = state.streaming;
}

function sendComposer(event) {
  event.preventDefault();
  if (state.streaming) return;
  const tools = readTools();
  if (tools.error) {
    showToolsError();
    toast(tools.error);
    return;
  }
  if (!$("model-input").value.trim()) {
    toast("先选一个模型");
    return;
  }
  const text = $("composer-input").value.trim();
  if (!text) return;
  state.chat.push({ id: uid(), role: "user", content: text });
  $("composer-input").value = "";
  persistChat();
  complete();
}

async function openSettings() {
  $("settings-base").textContent = `Base URL  ${location.origin}/v1`;
  $("api-key").value = state.apiKey;
  $("api-key").type = "password";
  $("api-key-toggle").textContent = "显示";
  renderUpdateMeta();
  $("settings-dialog").showModal();
  try {
    const res = await fetch("/console/api/settings");
    if (res.ok) {
      const body = await res.json();
      if (body.apiKey) $("api-key").value = body.apiKey;
    }
  } catch {
    /* the field keeps whatever the browser already stored */
  }
  checkUpdate();
}

function renderUpdateMeta() {
  const meta = $("update-meta");
  if (!meta) return;
  const update = state.update;
  if (!update) {
    meta.textContent = "还没有检查。";
    return;
  }
  const local = update.local ? update.local.slice(0, 7) : "未知";
  meta.textContent = `${update.message} 当前 ${local}`;
}

async function checkUpdate() {
  const meta = $("update-meta");
  if (meta) meta.textContent = "正在向 GitHub 查询…";
  try {
    const res = await fetch("/console/api/update");
    if (!res.ok) throw new Error(await errorMessage(res));
    state.update = await res.json();
  } catch (err) {
    state.update = { local: null, remote: null, state: "unknown", message: err.message || "检查失败" };
  }
  renderUpdateMeta();
  renderOverview();
}

async function saveCallerKey(event) {
  event.preventDefault();
  const apiKey = $("api-key").value.trim();
  const res = await fetch("/console/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    toast(await errorMessage(res));
    return;
  }
  const body = await res.json();
  state.apiKey = body.apiKey || apiKey;
  localStorage.setItem(KEYS.apiKey, state.apiKey);
  $("settings-dialog").close();
  toast("调用密钥已保存。第三方平台用这把密钥调模型。");
  refresh();
}

async function applyUpdate() {
  if (!confirm("拉取 GitHub 上的新版本并重启服务？")) return;
  const meta = $("update-meta");
  if (meta) meta.textContent = "正在更新…";
  const res = await fetch("/console/api/update", { method: "POST" });
  if (!res.ok) {
    toast(await errorMessage(res));
    checkUpdate();
    return;
  }
  toast("正在重启，几秒后刷新页面。");
  setTimeout(() => location.reload(), 1500);
}

function restoreDrafts() {
  $("model-input").value = sessionStorage.getItem(KEYS.model) || "";
  $("system-input").value = sessionStorage.getItem(KEYS.system) || "";
  $("tools-input").value = sessionStorage.getItem(KEYS.tools) || "";
  $("stream-input").checked = sessionStorage.getItem(KEYS.stream) !== "0";
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEYS.chat) || "[]");
    if (Array.isArray(saved)) {
      state.chat = saved
        .filter((message) => message && typeof message.role === "string")
        .map((message) => ({ ...message, pending: false, stopped: message.pending ? true : Boolean(message.stopped) }));
    }
  } catch {
    state.chat = [];
  }
}

function bind() {
  document.querySelector("nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-page]");
    if (button) setPage(button.dataset.page);
  });
  window.addEventListener("hashchange", () => setPage(location.hash.replace("#", ""), false));
  $("connection").addEventListener("click", () => refresh());
  $("refresh-status").addEventListener("click", () => refresh());
  $("refresh-accounts").addEventListener("click", () => refresh());
  $("open-settings").addEventListener("click", () => openSettings());
  $("settings-close").addEventListener("click", () => $("settings-dialog").close());
  $("settings-form").addEventListener("submit", saveCallerKey);
  $("api-key-generate").addEventListener("click", () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const key = `c2a_${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
    $("api-key").value = key;
    $("api-key").type = "text";
    $("api-key-toggle").textContent = "隐藏";
  });
  $("api-key-copy").addEventListener("click", () => {
    const key = $("api-key").value.trim();
    if (!key) {
      toast("还没有密钥");
      return;
    }
    copyText(`${location.origin}/v1\n${key}`);
  });
  $("api-key-toggle").addEventListener("click", () => {
    const input = $("api-key");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("api-key-toggle").textContent = show ? "隐藏" : "显示";
  });
  $("update-check").addEventListener("click", () => checkUpdate());
  $("update-apply").addEventListener("click", () => applyUpdate());
  $("reload-models").addEventListener("click", () => loadModels());
  $("model-search").addEventListener("input", (event) => {
    state.modelQuery = event.target.value;
    renderModels();
  });
  $("model-input").addEventListener("change", () => sessionStorage.setItem(KEYS.model, $("model-input").value.trim()));
  $("system-input").addEventListener("input", () => sessionStorage.setItem(KEYS.system, $("system-input").value));
  $("tools-input").addEventListener("input", () => {
    sessionStorage.setItem(KEYS.tools, $("tools-input").value);
    showToolsError();
  });
  $("stream-input").addEventListener("change", () => {
    sessionStorage.setItem(KEYS.stream, $("stream-input").checked ? "1" : "0");
  });
  $("insert-tool").addEventListener("click", () => {
    $("tools-input").value = SAMPLE_TOOL;
    sessionStorage.setItem(KEYS.tools, SAMPLE_TOOL);
    showToolsError();
  });
  $("composer").addEventListener("submit", sendComposer);
  $("composer-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("stop-chat").addEventListener("click", () => state.abort?.abort());
  $("clear-chat").addEventListener("click", () => {
    if (state.chat.length && !confirm("清空当前对话？")) return;
    if (state.streaming) state.abort?.abort();
    state.chat = [];
    persistChat();
    renderTranscript();
  });
  $("copy-curl").addEventListener("click", () => {
    if (readTools().error) {
      toast(readTools().error);
      return;
    }
    copyText(buildCurl());
  });
  $("transcript").addEventListener("scroll", () => {
    const box = $("transcript");
    state.stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  });
  document.addEventListener("keydown", (event) => {
    const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (event.key === "/" && state.page === "models" && !typing) {
      event.preventDefault();
      $("model-search").focus();
    }
  });
}

restoreDrafts();
bind();
setPage(location.hash.replace("#", "") || "overview", false);
renderTranscript();
showToolsError();
syncComposer();
refresh();
