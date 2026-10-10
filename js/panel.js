/**
 * 侧栏面板：左侧设备概览，右侧选中详情。
 *
 * 字段名以 js/data.js / js/devices.js 实际导出为准，对接时对齐。
 * 当前按已确认契约读取：
 * - snapshot: { devices: Device[] }
 * - Device: { id, name, type, status, metrics, position }
 * - status: "running" | "idle" | "alarm" | "offline"
 * - metrics: 值为 number 的普通对象
 *
 * 设备网格变色由 devices.js 负责，这里只展示文字和状态标签。
 */

const STATUS_LABEL = {
  running: "运行中",
  idle: "空闲",
  alarm: "告警",
  offline: "离线",
};

/** 与 data/twin.json、devices.js 里出现的 type 对齐；未知类型原样显示。 */
const TYPE_LABEL = {
  pump: "泵",
  tank: "储罐",
  conveyor: "传送带",
  robot: "机器人",
};

/** 与 data.js 仿真会抖动的 metrics 字段对齐；新字段原样显示键名。 */
const METRIC_LABEL = {
  temperature: "温度",
  power: "功率",
  flow: "流量",
  level: "液位",
  speed: "速度",
  load: "负载",
};

let listEl = null;
let detailEl = null;
/** @type {string|number|null} */
let selectedId = null;
/** onSelect 传来的对象；快照尚未包含该 id 时用来兜底展示。 */
let selectedFallback = null;
/** @type {{ devices?: unknown[] } | null} */
let snapshot = null;

/**
 * 绑定左右侧栏根节点。main 在启动时调用一次。
 * @param {{ listEl: HTMLElement, detailEl: HTMLElement }} roots
 */
export function initPanel(roots) {
  listEl = roots.listEl;
  detailEl = roots.detailEl;
  render();
}

/**
 * 设置当前选中设备。传入 null 时回到占位文案。
 * @param {object|null} device
 */
export function setSelected(device) {
  if (!device) {
    selectedId = null;
    selectedFallback = null;
  } else {
    selectedId = device.id;
    selectedFallback = device;
  }
  render();
}

/**
 * 订阅数据快照。listener 收到与 loadTwin 相同形状的 snapshot。
 * subscribe 在已加载时会立刻回调一次，因此这里不另做首屏拉取。
 * @param {(listener: (snapshot: object) => void) => (() => void)} subscribe
 * @returns {() => void} 取消订阅
 */
export function bindSubscribe(subscribe) {
  if (typeof subscribe !== "function") {
    console.warn("[panel] subscribe 不可用，侧栏数字不会自动刷新");
    return () => {};
  }

  // 数据模块每约 2 秒抖动 metrics；用同一 id 去快照里取最新设备。
  return subscribe((next) => {
    snapshot = next && typeof next === "object" ? next : { devices: [] };
    render();
  });
}

function render() {
  renderList();
  renderDetail();
}

function renderList() {
  if (!listEl) return;
  const devices = readDevices();

  if (!snapshot) {
    listEl.innerHTML = '<p class="boot-note">等待数据模块接入。接入后这里会列出场景中的设备。</p>';
    return;
  }

  if (devices.length === 0) {
    listEl.innerHTML = '<p class="placeholder">当前快照里没有设备。</p>';
    return;
  }

  const items = devices.map((device) => {
    const selected = sameId(device.id, selectedId);
    return (
      `<article class="device-item${selected ? " is-selected" : ""}">` +
      `<span class="device-item-name">${escapeHtml(device.name || device.id)}</span>` +
      `<span class="device-item-meta">${statusMarkup(device.status)}</span>` +
      `</article>`
    );
  });
  listEl.innerHTML = items.join("");
}

function renderDetail() {
  if (!detailEl) return;
  const device = resolveSelected();

  if (!device) {
    detailEl.innerHTML =
      '<p class="placeholder">未选中设备。在场景中点选一台设备后，这里会显示名称、状态和指标。</p>';
    return;
  }

  const typeRow = device.type
    ? `<p class="detail-row"><span>类型</span><strong>${escapeHtml(labelOf(TYPE_LABEL, device.type))}</strong></p>`
    : "";

  detailEl.innerHTML =
    `<h3 class="detail-name">${escapeHtml(device.name || "未命名设备")}</h3>` +
    `<p class="detail-row"><span>状态</span><strong>${statusMarkup(device.status)}</strong></p>` +
    typeRow +
    `<p class="section-label">指标</p>` +
    renderMetrics(device.metrics);
}

/** 优先用快照里的同 id 设备，这样 metrics 会跟着仿真更新。 */
function resolveSelected() {
  if (selectedId == null && !selectedFallback) return null;
  const devices = readDevices();
  const fresh = devices.find((device) => sameId(device && device.id, selectedId));
  return fresh || selectedFallback;
}

function readDevices() {
  const devices = snapshot && snapshot.devices;
  return Array.isArray(devices) ? devices : [];
}

function renderMetrics(metrics) {
  if (!metrics || typeof metrics !== "object") {
    return '<p class="placeholder">暂无指标</p>';
  }

  const rows = Object.entries(metrics);
  if (rows.length === 0) {
    return '<p class="placeholder">暂无指标</p>';
  }

  const items = rows.map(([key, value]) => {
    return (
      `<li><span class="metric-key">${escapeHtml(labelOf(METRIC_LABEL, key))}</span>` +
      `<span class="metric-value">${escapeHtml(formatMetric(value))}</span></li>`
    );
  });
  return `<ul class="metrics">${items.join("")}</ul>`;
}

function labelOf(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
}

function statusMarkup(status) {
  const key = typeof status === "string" ? status : "";
  const label = STATUS_LABEL[key] || (key ? key : "未知");
  const className = STATUS_LABEL[key] ? `status status-${key}` : "status status-offline";
  return `<span class="${className}">${escapeHtml(label)}</span>`;
}

function formatMetric(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
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
