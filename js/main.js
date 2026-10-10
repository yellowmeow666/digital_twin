/**
 * 组装启动。新接口用命名空间导入后再判断是否存在，
 * 缺导出时页面仍能起来，对应能力禁用或只更新侧栏。
 *
 * 名单点选只调 devices.setSelected(id)。
 * 场景点选由 devices 内部处理，侧栏通过 data.subscribeSelection 跟上。
 * 走势读 data.getHistory(id)，定位按钮调 devices.focusDevice(id)。
 */

import * as dataApi from "./data.js";
import * as sceneApi from "./scene.js";
import * as devicesApi from "./devices.js";
import { bindActions, bindSelection, bindSubscribe, initPanel } from "./panel.js";

const viewport = document.querySelector("#viewport");
const placeholder = document.querySelector("#viewport-placeholder");

initPanel({
  listEl: document.querySelector("#device-list"),
  detailEl: document.querySelector("#device-detail"),
  searchEl: document.querySelector("#device-search"),
});

bindActions({
  setSelected: devicesApi.setSelected,
  focusDevice: devicesApi.focusDevice,
  getHistory: dataApi.getHistory,
});

boot().catch((error) => {
  console.error("[main] 启动失败", error);
  setViewportMessage(error instanceof Error ? error.message : "页面启动失败");
});

async function boot() {
  if (typeof dataApi.loadTwin !== "function") {
    throw new Error("loadTwin 不可用");
  }
  if (typeof sceneApi.createScene !== "function") {
    throw new Error("createScene 不可用");
  }
  if (typeof devicesApi.mountDevices !== "function") {
    throw new Error("mountDevices 不可用");
  }

  // 顺序固定：数据 → 场景 → 设备挂载 → 选中订阅与快照订阅。
  const twin = await dataApi.loadTwin();
  const ctx = sceneApi.createScene(viewport);
  devicesApi.mountDevices(ctx, twin);

  // 不走 onSelect。场景点击已经会 selectDevice，和名单的 setSelected 汇合到同一条选中订阅。
  bindSelection(dataApi.subscribeSelection);
  bindSubscribe(dataApi.subscribe);

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
