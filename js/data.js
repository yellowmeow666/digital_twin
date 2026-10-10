/**
 * 加载 twin.json；每 2 秒抖动 metrics；订阅推送。
 * 导出：loadTwin、subscribe、getTwin、startSimulation、stopSimulation
 */

const TWIN_URL = new URL('../data/twin.json', import.meta.url);

/** @type {{ devices: Array<Record<string, unknown>> } | null} */
let twin = null;
/** @type {Set<(snapshot: { devices: Array<Record<string, unknown>> }) => void>} */
const listeners = new Set();
let timerId = null;

function cloneTwin() {
  return twin ? JSON.parse(JSON.stringify(twin)) : { devices: [] };
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

function jitter(value, span) {
  return Math.round((value + (Math.random() * 2 - 1) * span) * 10) / 10;
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
  }
  notify();
}

/** 读取 data/twin.json，返回 twin 数据对象；成功后自动开始每 2 秒模拟更新。 */
export async function loadTwin() {
  const res = await fetch(TWIN_URL);
  if (!res.ok) throw new Error(`Failed to load twin.json: ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.devices)) {
    throw new Error('twin.json must contain a devices array');
  }
  twin = data;
  notify();
  startSimulation(2000);
  return cloneTwin();
}

export function getTwin() {
  return cloneTwin();
}

/**
 * 订阅后续数据更新。listener(snapshot)，snapshot 形如 { devices: [...] }。
 * 若已加载，会立刻回调一次当前快照。返回取消订阅函数。
 */
export function subscribe(listener) {
  if (typeof listener !== 'function') throw new TypeError('subscribe expects a function');
  listeners.add(listener);
  if (twin) listener(cloneTwin());
  return () => listeners.delete(listener);
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
