/**
 * 侧栏：左侧设备名单（搜索 / 点选 / 告警标记），右侧详情与历史走势。
 *
 * 对接（缺导出时只降级，不假设一定存在）：
 * - 名单点选 → devices.setSelected(id)
 * - 选中态 → data.subscribeSelection(listener)，回调 device|null
 * - 走势 → data.getHistory(id)，形状 [{ t, metrics }, ...]
 * - 定位 → devices.focusDevice(id)
 * - status：normal | warn | alarm
 */

const STATUS_LABEL = {
  normal: "正常",
  warn: "警告",
  alarm: "告警",
};

const TYPE_LABEL = {
  pump: "泵",
  tank: "储罐",
  conveyor: "传送带",
  robot: "机器人",
};

const METRIC_LABEL = {
  temperature: "温度",
  power: "功率",
  flow: "流量",
  level: "液位",
  speed: "速度",
  load: "负载",
};

/** 走势折线颜色。越限时改用警告色 / 告警色，平时用固定序列色。 */
const SERIES_COLOR = {
  temperature: "#ef8b6a",
  power: "#7eb6ff",
  flow: "#3dbe7a",
  level: "#7fdbd4",
  speed: "#c4a2ff",
  load: "#e2a23b",
};

const SPARK_W = 240;
const SPARK_H = 64;

let listEl = null;
let detailEl = null;
let searchEl = null;
/** @type {string|number|null} */
let selectedId = null;
/** subscribeSelection 传来的对象；快照里暂时找不到时用来兜底。 */
let selectedFallback = null;
/** @type {{ devices?: unknown[] } | null} */
let snapshot = null;
let query = "";
/** @type {Array<{ t: number, metrics: Record<string, number> }>} */
let history = [];
/** @type {"ready"|"missing"|"error"} */
let historyState = "ready";
/** subscribeSelection 未导出时，名单点选只能改侧栏本地选中态。 */
let selectionSyncMissing = false;
/**
 * 名单外壳："boot" | "empty" | "ready"。
 * 2 秒快照只改文案和 class，不换按钮节点，避免点「定位」/名单时赶上 innerHTML 点空。
 */
let listShell = "";
/** 当前名单按钮对应的设备 id 序列。搜索或设备集合变了才重建按钮。 */
let listIdsKey = "";
/** 详情结构签名。选中设备、指标键、走势形态变了才重建详情。 */
let detailKey = "";

/** 运行时注入，避免静态具名导入在缺导出时把整页打垮。 */
const api = {
  setSelected: null,
  focusDevice: null,
  getHistory: null,
};

/**
 * 绑定左右侧栏和搜索框。main 在启动时调用一次。
 * @param {{ listEl: HTMLElement, detailEl: HTMLElement, searchEl?: HTMLElement|null }} roots
 */
export function initPanel(roots) {
  listEl = roots.listEl;
  detailEl = roots.detailEl;
  searchEl = roots.searchEl || null;

  if (searchEl) {
    searchEl.addEventListener("input", () => {
      query = searchEl.value.trim();
      // 过滤只影响名单，不改选中，避免输入时把详情和走势清掉。
      renderList();
    });
  }

  // 点击委托在稳定根节点上。名单项和定位按钮在 2 秒刷新时不会被换掉。
  listEl?.addEventListener("click", onListClick);
  detailEl?.addEventListener("click", onDetailClick);
  render();
}

/**
 * 注入场景 / 数据侧的可选接口。任一缺失都保持页面可操作。
 * @param {{ setSelected?: Function, focusDevice?: Function, getHistory?: Function }} actions
 */
export function bindActions(actions) {
  api.setSelected = typeof actions?.setSelected === "function" ? actions.setSelected : null;
  api.focusDevice = typeof actions?.focusDevice === "function" ? actions.focusDevice : null;
  api.getHistory = typeof actions?.getHistory === "function" ? actions.getHistory : null;

  if (!api.setSelected) console.warn("[panel] setSelected 不可用，名单点选无法同步到场景");
  if (!api.focusDevice) console.warn("[panel] focusDevice 不可用，定位按钮将禁用");
  if (!api.getHistory) console.warn("[panel] getHistory 不可用，走势无法绘制");
  historyState = api.getHistory ? "ready" : "missing";
}

/**
 * 订阅数据快照。已加载时会立刻回调一次。
 * 每次快照到达后，对当前选中设备再拉一次 getHistory，让走势跟着仿真走。
 * @param {(listener: (snapshot: object) => void) => (() => void)} subscribe
 * @returns {() => void}
 */
export function bindSubscribe(subscribe) {
  if (typeof subscribe !== "function") {
    console.warn("[panel] subscribe 不可用，侧栏数字不会自动刷新");
    return () => {};
  }

  return subscribe((next) => {
    snapshot = next && typeof next === "object" ? next : { devices: [] };
    refreshHistory();
    render();
  });
}

/**
 * 订阅统一选中态。场景点选和名单点选最终都从这里回到侧栏。
 * 已有选中时 data 会立刻回调一次。
 * @param {(listener: (device: object|null) => void) => (() => void)} subscribeSelection
 * @returns {() => void}
 */
export function bindSelection(subscribeSelection) {
  if (typeof subscribeSelection !== "function") {
    selectionSyncMissing = true;
    console.warn("[panel] subscribeSelection 不可用，侧栏选中态无法跟随场景点选");
    return () => {};
  }

  selectionSyncMissing = false;
  return subscribeSelection((device) => {
    applySelection(device);
    // 选中变化时先拉一次历史，不必等下一次仿真快照。
    refreshHistory();
    render();
  });
}

function onListClick(event) {
  const item = event.target.closest("[data-device-id]");
  if (!item || !listEl || !listEl.contains(item)) return;
  const id = item.getAttribute("data-device-id");
  if (!id) return;

  if (typeof api.setSelected === "function") {
    // 只调 devices.setSelected。它内部会 selectDevice，再经 subscribeSelection 回写侧栏。
    api.setSelected(id);
    if (selectionSyncMissing) {
      const device = readDevices().find((entry) => sameId(entry && entry.id, id)) || { id };
      applySelection(device);
      refreshHistory();
      render();
    }
    return;
  }

  console.warn("[panel] setSelected 不可用，仅更新侧栏选中态");
  const device = readDevices().find((entry) => sameId(entry && entry.id, id)) || { id };
  applySelection(device);
  refreshHistory();
  render();
}

function onDetailClick(event) {
  const button = event.target.closest("[data-action='focus']");
  if (!button || button.disabled || !detailEl || !detailEl.contains(button)) return;
  if (selectedId == null) return;
  if (typeof api.focusDevice !== "function") return;
  // focusDevice 接收设备 id 字符串，并负责飞相机。
  api.focusDevice(String(selectedId));
}

function applySelection(device) {
  if (!device) {
    selectedId = null;
    selectedFallback = null;
    history = [];
    return;
  }
  selectedId = device.id;
  selectedFallback = device;
}

/** 按当前 selectedId 读历史。接口缺失或抛错时留下状态，详情里给出提示。 */
function refreshHistory() {
  if (selectedId == null) {
    history = [];
    return;
  }
  if (typeof api.getHistory !== "function") {
    history = [];
    historyState = "missing";
    return;
  }
  try {
    const series = api.getHistory(selectedId);
    history = Array.isArray(series) ? series : [];
    historyState = "ready";
  } catch (err) {
    console.warn("[panel] getHistory 失败", err);
    history = [];
    historyState = "error";
  }
}

function render() {
  renderList();
  renderDetail();
}

function renderList() {
  if (!listEl) return;
  const devices = readDevices();

  if (!snapshot) {
    ensureListShell("boot");
    return;
  }
  if (devices.length === 0) {
    ensureListShell("empty");
    return;
  }

  const scroll = listEl.scrollTop;
  ensureListShell("ready");
  const filtered = devices.filter((device) => matchesQuery(device, query));
  // 只按过滤后的 id 序列决定要不要换按钮。状态、告警不进这个 key。
  const idsKey = filtered.map((device) => (device && device.id != null ? String(device.id) : "")).join("\0");
  if (idsKey !== listIdsKey) {
    rebuildListButtons(filtered);
    listIdsKey = idsKey;
    listEl.scrollTop = scroll;
  }
  patchListSummary(devices, filtered);
  patchListButtons(devices);
}

/** 外壳三种互斥。ready 之后一直复用同一套摘要节点。 */
function ensureListShell(mode) {
  if (listShell === mode) return;
  listShell = mode;
  listIdsKey = "";
  if (mode === "boot") {
    listEl.innerHTML = '<p class="boot-note">等待数据模块接入。接入后这里会列出场景中的设备。</p>';
    return;
  }
  if (mode === "empty") {
    listEl.innerHTML = '<p class="placeholder">当前快照里没有设备。</p>';
    return;
  }

  listEl.replaceChildren();
  const summary = document.createElement("p");
  summary.className = "list-summary";
  for (const field of ["total", "shown", "alarm", "warn"]) {
    const span = document.createElement("span");
    span.dataset.field = field;
    if (field === "alarm") span.className = "summary-alarm";
    if (field === "warn") span.className = "summary-warn";
    if (field !== "total") span.hidden = true;
    summary.append(span);
  }
  const note = document.createElement("p");
  note.className = "filter-note";
  note.dataset.field = "hidden-note";
  note.hidden = true;
  note.textContent = "已选设备被当前搜索隐藏，清空搜索后可在名单里看到。";
  const empty = document.createElement("p");
  empty.className = "placeholder";
  empty.dataset.field = "empty-filter";
  empty.hidden = true;
  const items = document.createElement("div");
  items.dataset.field = "items";
  listEl.append(summary, note, empty, items);
}

function rebuildListButtons(filtered) {
  const host = listEl.querySelector("[data-field='items']");
  if (!host) return;
  host.replaceChildren();
  for (const device of filtered) host.append(createDeviceButton(device));
}

function createDeviceButton(device) {
  const id = device && device.id != null ? String(device.id) : "";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "device-item";
  btn.dataset.deviceId = id;

  const top = document.createElement("span");
  top.className = "device-item-top";
  const name = document.createElement("span");
  name.className = "device-item-name";
  name.dataset.field = "name";
  const flag = document.createElement("span");
  flag.dataset.field = "flag";
  flag.hidden = true;
  top.append(name, flag);

  const meta = document.createElement("span");
  meta.className = "device-item-meta";
  const sub = document.createElement("span");
  sub.className = "device-item-sub";
  sub.dataset.field = "sub";
  const status = document.createElement("span");
  status.dataset.field = "status";
  meta.append(sub, status);

  btn.append(top, meta);
  paintDeviceButton(btn, device);
  return btn;
}

function patchListButtons(devices) {
  const host = listEl.querySelector("[data-field='items']");
  if (!host) return;
  const byId = new Map(devices.filter((device) => device && device.id != null).map((device) => [String(device.id), device]));
  for (const btn of host.querySelectorAll(".device-item")) {
    const device = byId.get(btn.dataset.deviceId || "");
    if (device) paintDeviceButton(btn, device);
  }
}

/** 就地改选中态、告警 class、状态文案和标记，不换 button 节点。 */
function paintDeviceButton(btn, device) {
  const id = device && device.id != null ? String(device.id) : "";
  const status = typeof device.status === "string" ? device.status : "";
  const selected = sameId(device && device.id, selectedId);
  btn.classList.toggle("is-selected", selected);
  btn.classList.toggle("is-alarm", status === "alarm");
  btn.classList.toggle("is-warn", status === "warn");
  if (selected) btn.setAttribute("aria-current", "true");
  else btn.removeAttribute("aria-current");

  const name = btn.querySelector("[data-field='name']");
  if (name) name.textContent = device.name || id || "未命名设备";
  const typeText = device.type ? labelOf(TYPE_LABEL, device.type) : "";
  const sub = btn.querySelector("[data-field='sub']");
  if (sub) sub.textContent = [typeText, id].filter(Boolean).join(" · ");
  paintFlag(btn.querySelector("[data-field='flag']"), status);
  paintStatus(btn.querySelector("[data-field='status']"), status);
}

function paintFlag(el, status) {
  if (!el) return;
  if (status === "alarm") {
    el.hidden = false;
    el.className = "flag flag-alarm";
    el.textContent = "告警";
    return;
  }
  if (status === "warn") {
    el.hidden = false;
    el.className = "flag flag-warn";
    el.textContent = "警告";
    return;
  }
  el.hidden = true;
  el.className = "flag";
  el.textContent = "";
}

function paintStatus(el, status) {
  if (!el) return;
  const key = typeof status === "string" ? status : "";
  const label = STATUS_LABEL[key] || (key ? key : "未知");
  el.className = STATUS_LABEL[key] ? `status status-${key}` : "status status-unknown";
  el.textContent = label;
}

function patchListSummary(devices, filtered) {
  const alarmCount = devices.filter((device) => device && device.status === "alarm").length;
  const warnCount = devices.filter((device) => device && device.status === "warn").length;
  const selectedHidden =
    selectedId != null &&
    devices.some((device) => sameId(device && device.id, selectedId)) &&
    !filtered.some((device) => sameId(device && device.id, selectedId));

  const total = listEl.querySelector("[data-field='total']");
  const shown = listEl.querySelector("[data-field='shown']");
  const alarm = listEl.querySelector("[data-field='alarm']");
  const warn = listEl.querySelector("[data-field='warn']");
  const note = listEl.querySelector("[data-field='hidden-note']");
  const empty = listEl.querySelector("[data-field='empty-filter']");
  if (total) total.textContent = `共 ${devices.length} 台`;
  if (shown) {
    shown.hidden = !query;
    shown.textContent = `显示 ${filtered.length}`;
  }
  if (alarm) {
    alarm.hidden = alarmCount === 0;
    alarm.textContent = `告警 ${alarmCount}`;
  }
  if (warn) {
    warn.hidden = warnCount === 0;
    warn.textContent = `警告 ${warnCount}`;
  }
  if (note) note.hidden = !selectedHidden;
  if (empty) {
    empty.hidden = filtered.length !== 0;
    empty.textContent = `没有匹配「${query}」的设备。`;
  }
}

function renderDetail() {
  if (!detailEl) return;
  const device = resolveSelected();
  const nextKey = detailStructureKey(device);
  if (nextKey !== detailKey) {
    const scroll = detailEl.scrollTop;
    detailEl.innerHTML = device ? buildDetailMarkup(device) : (
      '<p class="placeholder">未选中设备。在左侧名单或场景中点选一台设备后，这里会显示状态、指标和走势。</p>'
    );
    detailKey = nextKey;
    detailEl.scrollTop = scroll;
  }
  if (device) patchDetail(device);
}

/**
 * 选中设备换了、指标/阈值键变了、走势从无到有或报错，才算结构变化。
 * 数值抖动和采样变长不进 key。
 */
function detailStructureKey(device) {
  if (!device) return "none";
  const metricKeys = device.metrics && typeof device.metrics === "object" ? Object.keys(device.metrics) : [];
  const thresholdKeys = device.thresholds && typeof device.thresholds === "object"
    ? Object.keys(device.thresholds).filter((key) => device.thresholds[key] && typeof device.thresholds[key] === "object")
    : [];
  const historyKeys = historyState === "ready" && history.length > 0 ? collectMetricKeys(history) : [];
  return [
    String(device.id),
    historyState,
    history.length === 0 ? "empty" : "points",
    historyKeys.join(","),
    metricKeys.join(","),
    thresholdKeys.join(","),
    device.type ? "type" : "",
    device.area ? "area" : "",
    device.id != null ? "id" : "",
  ].join("|");
}

function buildDetailMarkup(device) {
  const rows = [
    `<p class="detail-row"><span>状态</span><strong data-field="status-slot">${statusMarkup(device.status)}</strong></p>`,
  ];
  if (device.type) {
    rows.push(
      `<p class="detail-row"><span>类型</span><strong>${escapeHtml(labelOf(TYPE_LABEL, device.type))}</strong></p>`,
    );
  }
  if (device.area) {
    rows.push(`<p class="detail-row"><span>区域</span><strong>${escapeHtml(device.area)}</strong></p>`);
  }
  if (device.id != null) {
    rows.push(`<p class="detail-row"><span>编号</span><strong>${escapeHtml(device.id)}</strong></p>`);
  }

  return (
    `<h3 class="detail-name">${escapeHtml(device.name || "未命名设备")}</h3>` +
    renderFocusButton() +
    rows.join("") +
    `<p class="section-label">指标</p>` +
    renderMetrics(device) +
    renderThresholds(device.thresholds) +
    renderHistory(device)
  );
}

/** 2 秒刷新：状态、指标文字、走势 svg 都写回原节点。 */
function patchDetail(device) {
  const nameEl = detailEl.querySelector(".detail-name");
  if (nameEl) nameEl.textContent = device.name || "未命名设备";
  const statusSlot = detailEl.querySelector("[data-field='status-slot'] .status");
  paintStatus(statusSlot, device.status);

  const focusBtn = detailEl.querySelector("[data-action='focus']");
  if (focusBtn) focusBtn.disabled = typeof api.focusDevice !== "function";

  const metricList = detailEl.querySelector("[data-block='metrics']");
  if (metricList && device.metrics && typeof device.metrics === "object") {
    for (const li of metricList.querySelectorAll("li")) {
      const key = li.dataset.metric;
      if (!key || !Object.prototype.hasOwnProperty.call(device.metrics, key)) continue;
      const value = device.metrics[key];
      const level = metricLevel(device, key, value);
      li.className = level;
      const title = thresholdTitle(device.thresholds, key);
      if (title) li.title = title;
      else li.removeAttribute("title");
      const valueEl = li.querySelector("[data-field='value']");
      if (valueEl) valueEl.textContent = formatMetric(value);
    }
  }

  const thresholdList = detailEl.querySelector("[data-block='thresholds']");
  if (thresholdList && device.thresholds) {
    for (const li of thresholdList.querySelectorAll("li")) {
      const key = li.dataset.metric;
      const th = key && device.thresholds[key];
      if (!th) continue;
      const bits = [];
      if (typeof th.warn === "number") bits.push(`警告 ${formatMetric(th.warn)}`);
      if (typeof th.alarm === "number") bits.push(`告警 ${formatMetric(th.alarm)}`);
      const valueEl = li.querySelector("[data-field='value']");
      if (valueEl) valueEl.textContent = bits.join(" / ") || "—";
    }
  }

  const sparks = detailEl.querySelector("[data-block='sparks']");
  if (sparks) {
    for (const card of sparks.querySelectorAll(".spark-card")) {
      const key = card.dataset.metric;
      if (!key) continue;
      const threshold = device.thresholds && device.thresholds[key];
      const latest = latestMetric(key);
      const level = metricLevel(device, key, latest);
      card.classList.toggle("is-alarm", level === "is-alarm");
      card.classList.toggle("is-warn", level === "is-warn");
      const valueEl = card.querySelector("[data-field='value']");
      if (valueEl) valueEl.textContent = formatMetric(latest);
      const svg = card.querySelector("svg.sparkline");
      if (svg) paintSparkline(svg, key, threshold, level);
    }
  }
  const note = detailEl.querySelector(".history-note");
  if (note && historyState === "ready" && history.length > 0) {
    note.textContent = history.length < 2
      ? "采样点较少，走势会随刷新变长。"
      : `最近 ${history.length} 个采样点`;
  }
}

function renderFocusButton() {
  const ready = typeof api.focusDevice === "function";
  const disabled = ready ? "" : " disabled";
  const hint = ready
    ? ""
    : '<p class="focus-hint">定位接口未就绪，按钮已禁用。</p>';
  return (
    `<div class="detail-toolbar">` +
    `<button type="button" class="focus-btn" data-action="focus"${disabled}>定位</button>` +
    hint +
    `</div>`
  );
}

function renderMetrics(device) {
  const metrics = device.metrics;
  if (!metrics || typeof metrics !== "object") {
    return '<p class="placeholder">暂无指标</p>';
  }

  const rows = Object.entries(metrics);
  if (rows.length === 0) return '<p class="placeholder">暂无指标</p>';

  const items = rows.map(([key, value]) => {
    const level = metricLevel(device, key, value);
    const title = thresholdTitle(device.thresholds, key);
    return (
      `<li class="${level}" data-metric="${escapeHtml(key)}"${title ? ` title="${escapeHtml(title)}"` : ""}>` +
      `<span class="metric-key">${escapeHtml(labelOf(METRIC_LABEL, key))}</span>` +
      `<span class="metric-value" data-field="value">${escapeHtml(formatMetric(value))}</span>` +
      `</li>`
    );
  });
  return `<ul class="metrics" data-block="metrics">${items.join("")}</ul>`;
}

function renderThresholds(thresholds) {
  if (!thresholds || typeof thresholds !== "object") return "";
  const rows = Object.entries(thresholds).filter(([, th]) => th && typeof th === "object");
  if (rows.length === 0) return "";

  const items = rows.map(([key, th]) => {
    const bits = [];
    if (typeof th.warn === "number") bits.push(`警告 ${formatMetric(th.warn)}`);
    if (typeof th.alarm === "number") bits.push(`告警 ${formatMetric(th.alarm)}`);
    return (
      `<li data-metric="${escapeHtml(key)}"><span class="metric-key">${escapeHtml(labelOf(METRIC_LABEL, key))}</span>` +
      `<span class="metric-value" data-field="value">${escapeHtml(bits.join(" / ") || "—")}</span></li>`
    );
  });
  return `<p class="section-label">阈值</p><ul class="metrics" data-block="thresholds">${items.join("")}</ul>`;
}

function renderHistory(device) {
  if (historyState === "missing") {
    return `<p class="section-label">历史走势</p><p class="placeholder">历史接口未就绪，走势暂不可用。</p>`;
  }
  if (historyState === "error") {
    return `<p class="section-label">历史走势</p><p class="placeholder">历史读取失败。</p>`;
  }
  if (history.length === 0) {
    return `<p class="section-label">历史走势</p><p class="placeholder">暂无历史采样。</p>`;
  }

  const keys = collectMetricKeys(history);
  if (keys.length === 0) {
    return `<p class="section-label">历史走势</p><p class="placeholder">历史里没有可绘制的数值指标。</p>`;
  }

  const cards = keys.map((key) => renderSparkCard(device, key)).join("");
  const waiting = history.length < 2
    ? "采样点较少，走势会随刷新变长。"
    : `最近 ${history.length} 个采样点`;
  return `<p class="section-label">历史走势</p><div class="sparklines" data-block="sparks">${cards}</div><p class="history-note">${escapeHtml(waiting)}</p>`;
}

function renderSparkCard(device, key) {
  const threshold = device.thresholds && device.thresholds[key];
  const level = metricLevel(device, key, latestMetric(key));
  const latest = latestMetric(key);
  const scale = thresholdScaleText(threshold);
  return (
    `<section class="spark-card ${level}" data-metric="${escapeHtml(key)}">` +
    `<div class="spark-head">` +
    `<span class="metric-key">${escapeHtml(labelOf(METRIC_LABEL, key))}</span>` +
    `<span class="metric-value" data-field="value">${escapeHtml(formatMetric(latest))}</span>` +
    `</div>` +
    `<svg class="sparkline" viewBox="0 0 ${SPARK_W} ${SPARK_H}" role="img" aria-label="${escapeHtml(labelOf(METRIC_LABEL, key))}走势">${sparklineInner(key, threshold, level)}</svg>` +
    (scale ? `<p class="spark-scale">${escapeHtml(scale)}</p>` : "") +
    `</section>`
  );
}

/** 折线画进已有的 svg，不换 svg 节点。 */
function paintSparkline(svg, key, threshold, level) {
  svg.setAttribute("aria-label", `${labelOf(METRIC_LABEL, key)}走势`);
  svg.innerHTML = sparklineInner(key, threshold, level);
}

/**
 * 把单个指标的历史画成简易折线。每个指标用自己的纵轴，
 * 并把 warn / alarm 阈值扩进范围，虚线才能落在图内。
 */
function sparklineInner(key, threshold, level) {
  const samples = [];
  for (const point of history) {
    const value = point && point.metrics ? point.metrics[key] : undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    samples.push(value);
  }
  if (samples.length === 0) return "";

  const { min, max } = sparkDomain(samples, threshold);
  const padL = 6;
  const padR = 6;
  const padT = 8;
  const padB = 8;
  const plotW = SPARK_W - padL - padR;
  const plotH = SPARK_H - padT - padB;
  const yOf = (value) => {
    const ratio = (value - min) / (max - min);
    return padT + (1 - ratio) * plotH;
  };
  const xOf = (index) => {
    if (samples.length === 1) return padL + plotW / 2;
    return padL + (plotW * index) / (samples.length - 1);
  };

  const coords = samples.map((value, index) => `${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`);
  const guides = [];
  if (threshold && typeof threshold.warn === "number") {
    const y = yOf(threshold.warn).toFixed(1);
    guides.push(
      `<line x1="${padL}" y1="${y}" x2="${SPARK_W - padR}" y2="${y}" stroke="#e2a23b" stroke-dasharray="3 2" stroke-width="1" />`,
    );
  }
  if (threshold && typeof threshold.alarm === "number") {
    const y = yOf(threshold.alarm).toFixed(1);
    guides.push(
      `<line x1="${padL}" y1="${y}" x2="${SPARK_W - padR}" y2="${y}" stroke="#ef5b5b" stroke-dasharray="3 2" stroke-width="1" />`,
    );
  }

  const stroke = level === "is-alarm"
    ? "#ff7b7b"
    : level === "is-warn"
      ? "#f0b429"
      : (SERIES_COLOR[key] || "#8ec8ff");
  const lastX = xOf(samples.length - 1).toFixed(1);
  const lastY = yOf(samples[samples.length - 1]).toFixed(1);
  let area = "";
  if (samples.length > 1) {
    const floor = (SPARK_H - padB).toFixed(1);
    const areaPoints = `${padL},${floor} ${coords.join(" ")} ${(SPARK_W - padR).toFixed(1)},${floor}`;
    area = `<polygon points="${areaPoints}" fill="${stroke}" fill-opacity="0.16" stroke="none" />`;
  }

  return (
    area +
    guides.join("") +
    `<polyline points="${coords.join(" ")}" fill="none" stroke="${stroke}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />` +
    `<circle cx="${lastX}" cy="${lastY}" r="2.6" fill="#e7eef6" />`
  );
}

function sparkDomain(values, threshold) {
  let min = Math.min(...values);
  let max = Math.max(...values);
  // 阈值纳入纵轴，虚线才不会画到图外，越限也看得出来。
  if (threshold && typeof threshold === "object") {
    if (typeof threshold.warn === "number") {
      min = Math.min(min, threshold.warn);
      max = Math.max(max, threshold.warn);
    }
    if (typeof threshold.alarm === "number") {
      min = Math.min(min, threshold.alarm);
      max = Math.max(max, threshold.alarm);
    }
  }
  if (!(max > min)) {
    const pad = Math.abs(min) * 0.08 || 1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

function collectMetricKeys(series) {
  const keys = [];
  const seen = new Set();
  for (const point of series) {
    const metrics = point && point.metrics;
    if (!metrics || typeof metrics !== "object") continue;
    for (const [key, value] of Object.entries(metrics)) {
      if (seen.has(key)) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function latestMetric(key) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const value = history[i] && history[i].metrics ? history[i].metrics[key] : undefined;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** 当前值相对 device.thresholds：到告警线返回 is-alarm，否则到警告线返回 is-warn。 */
function metricLevel(device, key, value) {
  if (typeof value !== "number" || !device || !device.thresholds) return "";
  const th = device.thresholds[key];
  if (!th || typeof th !== "object") return "";
  if (typeof th.alarm === "number" && value >= th.alarm) return "is-alarm";
  if (typeof th.warn === "number" && value >= th.warn) return "is-warn";
  return "";
}

function thresholdTitle(thresholds, key) {
  const th = thresholds && thresholds[key];
  if (!th || typeof th !== "object") return "";
  const bits = [];
  if (typeof th.warn === "number") bits.push(`警告 ${formatMetric(th.warn)}`);
  if (typeof th.alarm === "number") bits.push(`告警 ${formatMetric(th.alarm)}`);
  return bits.join(" / ");
}

function thresholdScaleText(threshold) {
  if (!threshold || typeof threshold !== "object") return "";
  const bits = [];
  if (typeof threshold.warn === "number") bits.push(`警告 ${formatMetric(threshold.warn)}`);
  if (typeof threshold.alarm === "number") bits.push(`告警 ${formatMetric(threshold.alarm)}`);
  return bits.length ? `阈值 ${bits.join(" / ")}` : "";
}

/** 名称、类型（含中文标签）、id 的子串匹配。空查询保留全部。 */
function matchesQuery(device, text) {
  if (!text) return true;
  if (!device || typeof device !== "object") return false;
  const typeLabel = device.type ? labelOf(TYPE_LABEL, device.type) : "";
  const haystack = [device.name, device.type, typeLabel, device.id]
    .filter((part) => part != null && part !== "")
    .join("\n")
    .toLowerCase();
  return haystack.includes(text.toLowerCase());
}

function resolveSelected() {
  if (selectedId == null && !selectedFallback) return null;
  const fresh = readDevices().find((device) => sameId(device && device.id, selectedId));
  return fresh || selectedFallback;
}

function readDevices() {
  const devices = snapshot && snapshot.devices;
  return Array.isArray(devices) ? devices : [];
}

function labelOf(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
}

function statusMarkup(status) {
  const key = typeof status === "string" ? status : "";
  const label = STATUS_LABEL[key] || (key ? key : "未知");
  const className = STATUS_LABEL[key] ? `status status-${key}` : "status status-unknown";
  return `<span class="${className}">${escapeHtml(label)}</span>`;
}

function formatMetric(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return value == null ? "—" : String(value);
  }
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
