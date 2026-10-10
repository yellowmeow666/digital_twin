/**
 * twin 数据：加载、阈值驱动 status、环形历史、选中状态。
 * 导出：loadTwin、subscribe、getTwin、getDevice、getHistory、
 *       selectDevice、getSelectedId、subscribeSelection、
 *       startSimulation、stopSimulation
 */

const TWIN_URL = new URL('../data/twin.json', import.meta.url);
const HISTORY_LIMIT = 30;

/** @type {{ devices: Array<Record<string, unknown>> } | null} */
let twin = null;
/** @type {Map<string, Array<{ t: number, metrics: Record<string, number> }>>} */
const historyMap = new Map();
/** @type {Set<(snapshot: { devices: Array<Record<string, unknown>> }) => void>} */
const listeners = new Set();
/** @type {Set<(device: object | null) => void>} */
const selectionListeners = new Set();
/** @type {string | null} */
let selectedId = null;
let timerId = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneTwin() {
  return twin ? clone(twin) : { devices: [] };
}

function notify() {
  const snapshot = cloneTwin();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch (err) {
      console.error('[data] subscriber error', err);
    }
  }
}

function notifySelection() {
  const device = selectedId ? getDevice(selectedId) : null;
  for (const fn of selectionListeners) {
    try {
      fn(device);
    } catch (err) {
      console.error('[data] selection subscriber error', err);
    }
  }
}

function jitter(value, span) {
  return Math.round((value + (Math.random() * 2 - 1) * span) * 10) / 10;
}

/**
 * 按 thresholds 计算 status：任一指标 ≥ alarm → alarm；否则 ≥ warn → warn；否则 normal。
 * 阈值形如 { temperature: { warn, alarm }, ... }，只对 metrics 里存在的键生效。
 */
export function computeStatus(device) {
  const metrics = device.metrics || {};
  const thresholds = device.thresholds || {};
  let level = 'normal';
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value !== 'number') continue;
    const th = thresholds[key];
    if (!th || typeof th !== 'object') continue;
    if (typeof th.alarm === 'number' && value >= th.alarm) return 'alarm';
    if (typeof th.warn === 'number' && value >= th.warn) level = 'warn';
  }
  return level;
}

function pushHistory(device) {
  const id = device.id;
  if (!id) return;
  let series = historyMap.get(id);
  if (!series) {
    series = [];
    historyMap.set(id, series);
  }
  series.push({ t: Date.now(), metrics: clone(device.metrics || {}) });
  if (series.length > HISTORY_LIMIT) series.splice(0, series.length - HISTORY_LIMIT);
}

function refreshDeviceDerived(device) {
  device.status = computeStatus(device);
  pushHistory(device);
}

function simulateTick() {
  if (!twin) return;
  for (const device of twin.devices) {
    const m = device.metrics;
    if (!m || typeof m !== 'object') continue;
    if (typeof m.temperature === 'number') m.temperature = jitter(m.temperature, 0.8);
    if (typeof m.power === 'number') m.power = Math.max(0, jitter(m.power, 0.4));
    if (typeof m.flow === 'number') m.flow = Math.max(0, jitter(m.flow, 1.2));
    if (typeof m.level === 'number') m.level = Math.min(100, Math.max(0, jitter(m.level, 1.5)));
    if (typeof m.speed === 'number') m.speed = Math.max(0, jitter(m.speed, 0.08));
    if (typeof m.load === 'number') m.load = Math.min(100, Math.max(0, jitter(m.load, 2)));
    refreshDeviceDerived(device);
  }
  notify();
  if (selectedId) notifySelection();
}

export async function loadTwin() {
  const res = await fetch(TWIN_URL);
  if (!res.ok) throw new Error(`Failed to load twin.json: ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.devices)) {
    throw new Error('twin.json must contain a devices array');
  }
  twin = data;
  historyMap.clear();
  for (const device of twin.devices) refreshDeviceDerived(device);
  notify();
  startSimulation(2000);
  return cloneTwin();
}

export function getTwin() {
  return cloneTwin();
}

export function getDevice(id) {
  if (!twin || id == null) return null;
  const found = twin.devices.find((d) => d.id === id);
  return found ? clone(found) : null;
}

/** 返回约 30 点环形历史副本：[{ t, metrics }, ...] */
export function getHistory(id) {
  const series = historyMap.get(id);
  return series ? clone(series) : [];
}

export function subscribe(listener) {
  if (typeof listener !== 'function') throw new TypeError('subscribe expects a function');
  listeners.add(listener);
  if (twin) listener(cloneTwin());
  return () => listeners.delete(listener);
}

/** 统一选中状态。id 为 null 时取消选中。 */
export function selectDevice(id) {
  const next = id == null || id === '' ? null : String(id);
  if (next && twin && !twin.devices.some((d) => d.id === next)) {
    console.warn('[data] selectDevice unknown id', next);
  }
  selectedId = next;
  notifySelection();
  return getDevice(selectedId);
}

export function getSelectedId() {
  return selectedId;
}

/** 订阅选中变化；已有选中时立刻回调一次。返回取消函数。 */
export function subscribeSelection(listener) {
  if (typeof listener !== 'function') throw new TypeError('subscribeSelection expects a function');
  selectionListeners.add(listener);
  listener(selectedId ? getDevice(selectedId) : null);
  return () => selectionListeners.delete(listener);
}

export function startSimulation(intervalMs = 2000) {
  stopSimulation();
  timerId = setInterval(simulateTick, intervalMs);
}

export function stopSimulation() {
  if (timerId != null) {
    clearInterval(timerId);
    timerId = null;
  }
}
