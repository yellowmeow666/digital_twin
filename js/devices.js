/**
 * 按 twin 数据生成设备；raycaster 点选；选中高亮；数据更新时刷新外观。
 * 导出：mountDevices、onSelect
 */

import * as THREE from 'three';
import { subscribe } from './data.js';

const STATUS_COLOR = {
  running: 0x22c55e,
  idle: 0x38bdf8,
  alarm: 0xef4444,
  offline: 0x64748b,
};

const SELECTED_EMISSIVE = 0xfbbf24;

/** @type {((device: object | null) => void) | null} */
let selectHandler = null;
/** @type {string | null} */
let selectedId = null;
/** @type {Map<string, THREE.Mesh>} */
const meshes = new Map();
/** @type {THREE.Group | null} */
let root = null;
/** @type {{ scene: THREE.Scene, camera: THREE.Camera, renderer: THREE.WebGLRenderer } | null} */
let ctxRef = null;
let pickingBound = false;
let unsub = null;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function colorForStatus(status) {
  return STATUS_COLOR[status] ?? 0x94a3b8;
}

function makeGeometry(type) {
  switch (type) {
    case 'pump':
      return new THREE.CylinderGeometry(0.45, 0.55, 1.1, 16);
    case 'tank':
      return new THREE.CylinderGeometry(0.7, 0.7, 2.2, 20);
    case 'conveyor':
      return new THREE.BoxGeometry(3.2, 0.35, 0.9);
    case 'robot':
      return new THREE.BoxGeometry(0.9, 1.6, 0.9);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

function applyMaterial(mesh, device, selected) {
  const mat = mesh.material;
  mat.color.setHex(colorForStatus(device.status));
  mat.emissive.setHex(selected ? SELECTED_EMISSIVE : 0x000000);
  mat.emissiveIntensity = selected ? 0.45 : 0;
}

function upsertDevice(device) {
  if (!root) return;
  let mesh = meshes.get(device.id);
  if (!mesh) {
    const mat = new THREE.MeshStandardMaterial({
      color: colorForStatus(device.status),
      roughness: 0.45,
      metalness: 0.25,
    });
    mesh = new THREE.Mesh(makeGeometry(device.type), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.deviceId = device.id;
    meshes.set(device.id, mesh);
    root.add(mesh);
  }
  const p = device.position || { x: 0, y: 0, z: 0 };
  mesh.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
  mesh.userData.device = device;
  applyMaterial(mesh, device, device.id === selectedId);
}

function syncDevices(list) {
  const seen = new Set();
  for (const device of list) {
    seen.add(device.id);
    upsertDevice(device);
  }
  for (const [id, mesh] of meshes) {
    if (!seen.has(id)) {
      root?.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      meshes.delete(id);
      if (selectedId === id) emitSelect(null);
    }
  }
}

function emitSelect(device) {
  selectedId = device ? device.id : null;
  for (const [id, mesh] of meshes) {
    applyMaterial(mesh, mesh.userData.device || { status: 'idle' }, id === selectedId);
  }
  if (typeof selectHandler === 'function') selectHandler(device);
}

function onPointerDown(event) {
  if (!ctxRef) return;
  const { camera, renderer } = ctxRef;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([...meshes.values()], false);
  if (hits.length === 0) {
    emitSelect(null);
    return;
  }
  const device = hits[0].object.userData.device ?? null;
  emitSelect(device);
}

/**
 * 注册选中回调。点击设备时 handler(device)；点空白取消选中时 handler(null)。
 * @param {(device: object | null) => void} handler
 */
export function onSelect(handler) {
  selectHandler = typeof handler === 'function' ? handler : null;
}

/**
 * 把设备挂到场景。ctx 为 createScene 的返回值；twin 为 loadTwin 的返回值。
 * 内部会 subscribe 数据更新以刷新外观（status 变色等）。
 */
export function mountDevices(ctx, twin) {
  if (!ctx?.scene || !ctx?.camera || !ctx?.renderer) {
    throw new Error('mountDevices expects createScene() context');
  }
  ctxRef = ctx;

  if (!root) {
    root = new THREE.Group();
    root.name = 'devices';
    ctx.scene.add(root);
  }

  const list = Array.isArray(twin?.devices) ? twin.devices : [];
  syncDevices(list);

  if (!pickingBound) {
    ctx.renderer.domElement.addEventListener('pointerdown', onPointerDown);
    pickingBound = true;
  }

  if (unsub) unsub();
  unsub = subscribe((snapshot) => {
    syncDevices(snapshot.devices || []);
  });
}
