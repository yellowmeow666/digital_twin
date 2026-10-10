/**
 * 组装启动。只消费场景侧已经导出的命名接口：
 * - js/data.js：loadTwin()、subscribe(listener)
 * - js/scene.js：createScene(container) → { render, resize, ... }
 * - js/devices.js：mountDevices(ctx, twin)、onSelect(handler)
 */

import { loadTwin, subscribe } from "./data.js";
import { createScene } from "./scene.js";
import { mountDevices, onSelect } from "./devices.js";
import { bindSubscribe, initPanel, setSelected } from "./panel.js";

const viewport = document.querySelector("#viewport");
const placeholder = document.querySelector("#viewport-placeholder");

initPanel({
  listEl: document.querySelector("#device-list"),
  detailEl: document.querySelector("#device-detail"),
});

boot().catch((error) => {
  console.error("[main] 启动失败", error);
  setViewportMessage(error instanceof Error ? error.message : "页面启动失败");
});

async function boot() {
  // 顺序固定：数据 → 场景 → 设备挂载 → 选中与刷新接到侧栏。
  const twin = await loadTwin();
  const ctx = createScene(viewport);
  mountDevices(ctx, twin);

  onSelect((device) => {
    setSelected(device ?? null);
  });
  // subscribe 在 twin 已加载时会立刻回放一次，侧栏列表不用再手动拉。
  bindSubscribe(subscribe);

  hideViewportMessage();
  // 占位层隐藏后再量一次容器，避免首帧用到尚未撑开的尺寸。
  ctx.resize();
  startRenderLoop(ctx);

  window.addEventListener("resize", () => {
    ctx.resize();
  });
}

function startRenderLoop(ctx) {
  const tick = () => {
    ctx.render();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function setViewportMessage(text) {
  if (!placeholder) return;
  placeholder.hidden = false;
  placeholder.textContent = text;
}

function hideViewportMessage() {
  if (!placeholder) return;
  placeholder.hidden = true;
}
