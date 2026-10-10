/**
 * Three.js 场景：厂房、灯光、开场镜头、选中描边、告警光环、设备名牌。
 *
 * 依赖 import map：three @0.160.0 与 three/addons/。
 * RoomEnvironment、后处理、CSS2D 都是动态 import，缺文件时降级，页面仍能渲染。
 *
 * 设备动画由 devices.js 挂在 scene.onBeforeRender 上，并串联当时已有的回调。
 * 这里不要覆盖这个钩子，否则传送带 / 机械臂会停。EffectComposer 一帧里会多次
 * render，从而多次触发 onBeforeRender，devices 侧用帧间隔消化，可以接受。
 *
 * 导出：createScene（含 focusOn；可额外带内部状态，原有字段行为不变）
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { subscribe, subscribeSelection } from './data.js';
import * as devicesApi from './devices.js';

/** 推近结束后的默认机位。focus 之外的静止视角与改前一致。 */
const DEFAULT_CAM = new THREE.Vector3(10, 8, 12);
const DEFAULT_TARGET = new THREE.Vector3(0, 1, 0);
/** 开场：高空斜俯视，再在 2.6 秒内推到默认机位。 */
const INTRO_FROM_CAM = new THREE.Vector3(13, 22, 17);
const INTRO_FROM_TARGET = new THREE.Vector3(0, 0.4, 0);
const INTRO_MS = 2600;

/** 厂房外包尺寸（米）。设备落在 x∈[-4,5]、z∈[-3,2.5]，四周留出走道。 */
const HALL = {
  halfX: 8,
  halfZ: 6,
  wallH: 4.55,
  eaveY: 5.05,
  ridgeY: 6.3,
  floorW: 20,
  floorD: 16,
};

const COLOR = {
  sky: 0x101820,
  floor: 0x1a2330,
  steel: 0x8e99a6,
  steelDark: 0x4e5966,
  concrete: 0x3c4450,
  glass: 0xb9cadd,
  safety: 0xf5c518,
  coolant: 0x3c7f9a,
  pipe: 0xc6a15a,
  alarm: 0xff3b3b,
  outline: 0xffc857,
  outlineHidden: 0x6e4b16,
  skylight: 0xd7e8ff,
};

const _box = new THREE.Box3();
const _vec = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

/**
 * @param {HTMLElement} containerEl
 * @returns {{ scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, controls: OrbitControls, render: () => void, resize: () => void, focusOn: (position: {x:number,y:number,z:number}, opts?: {duration?: number}) => void }}
 */
export function createScene(containerEl) {
  if (!containerEl) throw new Error('createScene requires a container element');

  const forceLowFx = new URLSearchParams(window.location.search).get('lowfx') === '1';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLOR.sky);
  // 近处厂房保持清楚，远处轻轻淡出。
  scene.fog = new THREE.Fog(COLOR.sky, 26, 62);

  const width = containerEl.clientWidth || window.innerWidth;
  const height = containerEl.clientHeight || window.innerHeight;

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 200);
  camera.position.copy(INTRO_FROM_CAM);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  containerEl.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.copy(INTRO_FROM_TARGET);
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 3;
  controls.maxDistance = 40;

  addLights(scene);
  buildHall(scene, renderer);

  const zoneRoot = new THREE.Group();
  zoneRoot.name = 'zones';
  const pipeRoot = new THREE.Group();
  pipeRoot.name = 'pipes';
  scene.add(zoneRoot);
  scene.add(pipeRoot);

  /** @type {string} */
  let layoutKey = '';
  /** @type {string|null} */
  let selectedId = null;
  /** @type {THREE.EffectComposer | null} */
  let composer = null;
  /** @type {THREE.Object3D | null} */
  let outlinePass = null;
  /** @type {{ render: Function, setSize: Function, domElement: HTMLElement } | null} */
  let labelRenderer = null;
  /** @type {typeof import('three/addons/renderers/CSS2DRenderer.js').CSS2DObject | null} */
  let CSS2DObjectClass = null;
  /** @type {Map<string, { obj: THREE.Object3D, dot: HTMLElement, name: HTMLElement }>} */
  const labels = new Map();
  /** @type {Map<string, THREE.Group>} */
  const alarms = new Map();
  let outlinedKey = '';

  /** @type {{ start: number, duration: number, fromCam: THREE.Vector3, toCam: THREE.Vector3, fromTarget: THREE.Vector3, toTarget: THREE.Vector3 } | null} */
  let intro = {
    start: performance.now(),
    duration: INTRO_MS,
    fromCam: INTRO_FROM_CAM.clone(),
    toCam: DEFAULT_CAM.clone(),
    fromTarget: INTRO_FROM_TARGET.clone(),
    toTarget: DEFAULT_TARGET.clone(),
  };

  /** @type {{ start: number, duration: number, fromCam: THREE.Vector3, toCam: THREE.Vector3, fromTarget: THREE.Vector3, toTarget: THREE.Vector3 } | null} */
  let focusAnim = null;

  // 用户一开始拖拽 / 滚轮就停掉开场，把相机交回 OrbitControls。
  controls.addEventListener('start', () => {
    intro = null;
  });

  const safetyMat = new THREE.MeshStandardMaterial({
    color: COLOR.safety,
    roughness: 0.42,
    metalness: 0.08,
    emissive: 0x5a4308,
    emissiveIntensity: 0.35,
  });
  const coolantMat = new THREE.MeshStandardMaterial({
    color: COLOR.coolant,
    roughness: 0.28,
    metalness: 0.72,
    envMapIntensity: 1.1,
  });
  const serviceMat = new THREE.MeshStandardMaterial({
    color: COLOR.pipe,
    roughness: 0.38,
    metalness: 0.62,
    envMapIntensity: 1,
  });

  function resize() {
    const w = containerEl.clientWidth || window.innerWidth;
    const h = containerEl.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (composer) composer.setSize(w, h);
    if (labelRenderer) labelRenderer.setSize(w, h);
  }

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function stepCamera(now) {
    // 定位飞行优先于开场。focusOn 会先清掉 intro，这里再挡一层。
    if (focusAnim) {
      intro = null;
      const u = Math.min(1, (now - focusAnim.start) / focusAnim.duration);
      const e = easeInOut(u);
      camera.position.lerpVectors(focusAnim.fromCam, focusAnim.toCam, e);
      controls.target.lerpVectors(focusAnim.fromTarget, focusAnim.toTarget, e);
      if (u >= 1) focusAnim = null;
      return;
    }
    if (!intro) return;
    const u = Math.min(1, (now - intro.start) / intro.duration);
    const e = easeInOut(u);
    camera.position.lerpVectors(intro.fromCam, intro.toCam, e);
    controls.target.lerpVectors(intro.fromTarget, intro.toTarget, e);
    if (u >= 1) intro = null;
  }

  function renderScene() {
    if (!composer) {
      renderer.render(scene, camera);
      return;
    }
    try {
      composer.render();
    } catch (err) {
      console.error('[scene] 后处理渲染失败，改用直接渲染', err);
      composer = null;
      outlinePass = null;
      renderer.render(scene, camera);
    }
  }

  function render() {
    const now = performance.now();
    stepCamera(now);
    // 告警圈和描边目标在画出这一帧之前对齐；名牌世界坐标等设备动画跑完再贴。
    syncAlarmsAndOutline(now);
    controls.update();
    renderScene();
    refreshLabelAnchors();
    if (labelRenderer) labelRenderer.render(scene, camera);
    trackFps(now);
  }

  /**
   * 平滑飞向目标点。相机停在目标斜上方，OrbitControls.target 对准目标。
   * @param {{ x: number, y?: number, z: number }} position
   * @param {{ duration?: number }} [opts]
   */
  function focusOn(position, opts = {}) {
    if (!position) return;
    intro = null;
    const target = new THREE.Vector3(position.x ?? 0, position.y ?? 0, position.z ?? 0);
    const offset = new THREE.Vector3(4.5, 3.5, 4.5);
    focusAnim = {
      start: performance.now(),
      duration: opts.duration ?? 600,
      fromCam: camera.position.clone(),
      toCam: target.clone().add(offset),
      fromTarget: controls.target.clone(),
      toTarget: target,
    };
  }

  // --- 设备区域框 / 管道（只取 x、z，高度自己定） ---

  subscribe((snapshot) => {
    const devices = Array.isArray(snapshot?.devices) ? snapshot.devices : [];
    const key = devices
      .map((device) => `${device && device.id}:${device && device.position ? device.position.x : ''}:${device && device.position ? device.position.z : ''}:${device && device.type}`)
      .join('|');
    if (key === layoutKey) return;
    layoutKey = key;
    rebuildZones(zoneRoot, devices, safetyMat);
    rebuildPipes(pipeRoot, devices, coolantMat, serviceMat);
  });

  subscribeSelection((device) => {
    selectedId = device && device.id != null ? device.id : null;
    outlinedKey = '';
  });

  // --- 环境反射 / 描边 / 名牌，缺文件就跳过 ---

  setupEnvironment(renderer, scene);
  if (forceLowFx) {
    console.info('[scene] lowfx=1，跳过 OutlinePass，选中只用地面选中环');
  } else {
    setupPost(renderer, scene, camera, width, height, (next) => {
      composer = next.composer;
      outlinePass = next.outlinePass;
      outlinedKey = '';
    });
  }
  setupLabels(containerEl, width, height, (api) => {
    labelRenderer = api.renderer;
    CSS2DObjectClass = api.CSS2DObject;
  });

  const fxWarmupUntil = performance.now() + 4000;
  let fpsWindowStart = 0;
  let fpsFrames = 0;
  let slowSince = 0;

  function trackFps(now) {
    if (forceLowFx || !outlinePass || outlinePass.enabled === false) return;
    // 着色器编译和开场那几秒不计入，避免误降级。
    if (now < fxWarmupUntil) return;
    if (!fpsWindowStart) fpsWindowStart = now;
    fpsFrames += 1;
    const span = now - fpsWindowStart;
    if (span < 500) return;
    const fps = (fpsFrames * 1000) / span;
    fpsFrames = 0;
    fpsWindowStart = now;
    if (fps < 40) {
      if (!slowSince) slowSince = now;
      else if (now - slowSince >= 3000) disableOutline('连续低于 40fps');
    } else {
      slowSince = 0;
    }
  }

  function disableOutline(reason) {
    if (!outlinePass || outlinePass.enabled === false) return;
    outlinePass.enabled = false;
    outlinePass.selectedObjects = [];
    console.warn(`[scene] 已关闭 OutlinePass（${reason}），选中退回地面选中环`);
  }

  function deviceGroups() {
    return typeof devicesApi.getDeviceGroups === 'function' ? devicesApi.getDeviceGroups() : [];
  }

  function syncAlarmsAndOutline(now) {
    const groups = deviceGroups();
    const alive = new Set();
    for (const group of groups) {
      const id = group.userData.deviceId;
      if (id == null) continue;
      const key = String(id);
      const status = group.userData.status || (group.userData.device && group.userData.device.status);
      if (status === 'alarm') {
        alive.add(key);
        let ring = alarms.get(key);
        if (!ring) {
          ring = makeAlarmRing();
          alarms.set(key, ring);
          scene.add(ring);
        }
        // 根 Group 的 y 固定为 0，光环贴地，不用 twin 里的 position.y。
        ring.position.set(group.position.x, 0.05, group.position.z);
        const wave = 0.5 + 0.5 * Math.sin(now * 0.0034);
        ring.scale.setScalar(1 + wave * 0.22);
        const inner = ring.children[0];
        const outer = ring.children[1];
        if (inner && inner.material) inner.material.opacity = 0.28 + wave * 0.45;
        if (outer && outer.material) {
          outer.material.opacity = 0.08 + (1 - wave) * 0.28;
          outer.scale.setScalar(1.15 + wave * 0.55);
        }
      }
    }
    for (const [key, ring] of alarms) {
      if (alive.has(key)) continue;
      scene.remove(ring);
      disposeAlarm(ring);
      alarms.delete(key);
    }
    // 选中设备还没挂上 Group 时先不锁 key，下一帧再试。
    applyOutline(groups);
    ensureLabels(groups);
  }

  function applyOutline(groups) {
    if (!outlinePass || outlinePass.enabled === false) return;
    const id = selectedId;
    const group = id != null && typeof devicesApi.getDeviceGroup === 'function'
      ? devicesApi.getDeviceGroup(id)
      : null;
    if (id != null && !group) return;
    const key = group ? `${id}:${group.uuid}:${groups.length}` : '';
    if (key === outlinedKey) return;
    outlinedKey = key;
    const meshes = [];
    if (group) {
      group.traverse((obj) => {
        // 贴地选中环留给降级方案，描边不要把它也勾一圈。
        if (obj.isMesh && obj.userData.isSelectionRing !== true) meshes.push(obj);
      });
    }
    outlinePass.selectedObjects = meshes;
  }

  function ensureLabels(groups) {
    if (!CSS2DObjectClass) return;
    const alive = new Set();
    for (const group of groups) {
      const id = group.userData.deviceId;
      if (id == null) continue;
      const key = String(id);
      alive.add(key);
      let entry = labels.get(key);
      if (!entry) {
        entry = createLabel(CSS2DObjectClass, group);
        labels.set(key, entry);
        scene.add(entry.obj);
      }
      const device = group.userData.device || {};
      const status = group.userData.status || device.status || 'normal';
      const nextName = device.name || key;
      if (entry.name.textContent !== nextName) entry.name.textContent = nextName;
      if (entry.dot.dataset.status !== status) entry.dot.dataset.status = status;
    }
    for (const [key, entry] of labels) {
      if (alive.has(key)) continue;
      scene.remove(entry.obj);
      labels.delete(key);
    }
  }

  function refreshLabelAnchors() {
    if (!labels.size) return;
    const groups = deviceGroups();
    for (const group of groups) {
      const id = group.userData.deviceId;
      if (id == null) continue;
      const entry = labels.get(String(id));
      if (!entry) continue;
      placeLabel(entry.obj, group);
    }
  }

  window.addEventListener('resize', resize);

  return { scene, camera, renderer, controls, render, resize, focusOn };
}

// ---------------------------------------------------------------------------
// 灯光
// ---------------------------------------------------------------------------

function addLights(scene) {
  // 物理单位灯光：方向光大约是改前强度乘 π，用来压出地面阴影。
  const hemi = new THREE.HemisphereLight(0xc5d4ea, 0x2a261c, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff3dd, 3.1);
  sun.position.set(7, 14, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.025;
  const cam = sun.shadow.camera;
  cam.near = 1;
  cam.far = 36;
  cam.left = -14;
  cam.right = 14;
  cam.top = 14;
  cam.bottom = -14;
  scene.add(sun);
  scene.add(sun.target);

  // 天窗方向的补光，不另开阴影。
  const sky = new THREE.DirectionalLight(COLOR.skylight, 1.15);
  sky.position.set(0, 12, 1.5);
  scene.add(sky);

  scene.add(new THREE.AmbientLight(0x93a4be, 0.18));
}

// ---------------------------------------------------------------------------
// 厂房
// ---------------------------------------------------------------------------

function buildHall(scene, renderer) {
  const hall = new THREE.Group();
  hall.name = 'factory';

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(HALL.floorW, HALL.floorD),
    makeEpoxyMaterial(renderer),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  hall.add(floor);

  const steel = new THREE.MeshStandardMaterial({
    color: COLOR.steel,
    metalness: 0.86,
    roughness: 0.32,
    envMapIntensity: 1.15,
  });
  const steelDark = new THREE.MeshStandardMaterial({
    color: COLOR.steelDark,
    metalness: 0.7,
    roughness: 0.45,
    envMapIntensity: 0.9,
  });
  const concrete = new THREE.MeshStandardMaterial({
    color: COLOR.concrete,
    metalness: 0.04,
    roughness: 0.88,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: COLOR.glass,
    metalness: 0.04,
    roughness: 0.08,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 0.8,
  });
  // 朝向默认机位（+x / +z）的两面更透，避免把设备糊住。
  const glassFront = glass.clone();
  glassFront.opacity = 0.1;

  addWalls(hall, glass, glassFront, concrete);
  addColumns(hall, steelDark);
  addTruss(hall, steel);
  addSkylight(hall);
  addPerimeterLines(hall);

  scene.add(hall);
}

function makeEpoxyMaterial(renderer) {
  const map = makeEpoxyTexture();
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return new THREE.MeshStandardMaterial({
    map,
    roughness: 0.42,
    metalness: 0.16,
    envMapIntensity: 1.05,
  });
}

/** 程序化环氧地坪：深色底、颗粒、分仓缝，不读外部贴图。 */
function makeEpoxyTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a2330';
  ctx.fillRect(0, 0, size, size);

  const image = ctx.getImageData(0, 0, size, size);
  const pixels = image.data;
  for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
    const n = (hash(p) - 0.5) * 22;
    pixels[i] = clamp8(pixels[i] + n);
    pixels[i + 1] = clamp8(pixels[i + 1] + n * 0.95);
    pixels[i + 2] = clamp8(pixels[i + 2] + n * 0.8 + 6);
  }
  ctx.putImageData(image, 0, 0);

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.38)';
  ctx.lineWidth = 2;
  const cell = 128;
  for (let x = 0; x <= size; x += cell) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, size);
    ctx.stroke();
  }
  for (let y = 0; y <= size; y += cell) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(size, y + 0.5);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 3.2);
  return texture;
}

function addWalls(parent, glass, glassFront, concrete) {
  const { halfX, halfZ, wallH } = HALL;
  const t = 0.08;
  const y = wallH / 2;
  // 四面半透明墙板。背墙稍实，朝相机的两面更透。
  addBox(parent, glass, 0, y, -halfZ, halfX * 2, wallH, t, false);
  addBox(parent, glassFront, 0, y, halfZ, halfX * 2, wallH, t, false);
  addBox(parent, glass, -halfX, y, 0, t, wallH, halfZ * 2, false);
  addBox(parent, glassFront, halfX, y, 0, t, wallH, halfZ * 2, false);

  const curbH = 0.18;
  const curbT = 0.22;
  addBox(parent, concrete, 0, curbH / 2, -halfZ, halfX * 2, curbH, curbT, false);
  addBox(parent, concrete, 0, curbH / 2, halfZ, halfX * 2, curbH, curbT, false);
  addBox(parent, concrete, -halfX, curbH / 2, 0, curbT, curbH, halfZ * 2, false);
  addBox(parent, concrete, halfX, curbH / 2, 0, curbT, curbH, halfZ * 2, false);
}

function addColumns(parent, material) {
  const xs = [-7.72, -3.86, 0, 3.86, 7.72];
  const zs = [-5.72, 5.72];
  const height = HALL.eaveY;
  for (const x of xs) {
    for (const z of zs) addColumn(parent, material, x, z, height);
  }
  for (const z of [-2.4, 2.4]) {
    addColumn(parent, material, -7.72, z, height);
    addColumn(parent, material, 7.72, z, height);
  }
}

function addColumn(parent, material, x, z, height) {
  addBox(parent, material, x, height / 2, z, 0.24, height, 0.24, true);
  addBox(parent, material, x, 0.03, z, 0.46, 0.06, 0.46, true);
  addBox(parent, material, x, height - 0.04, z, 0.4, 0.08, 0.4, true);
}

function addTruss(parent, material) {
  const xs = [-6, -2, 2, 6];
  const z0 = -5.7;
  const z1 = 5.7;
  for (const x of xs) addTrussFrame(parent, material, x, z0, z1);

  // 檐口和屋脊的纵向钢梁，把榀桁架连成屋顶。
  const eave = HALL.eaveY;
  const ridge = HALL.ridgeY;
  beam(parent, material, new THREE.Vector3(-7.7, eave, z0), new THREE.Vector3(7.7, eave, z0), 0.1);
  beam(parent, material, new THREE.Vector3(-7.7, eave, z1), new THREE.Vector3(7.7, eave, z1), 0.1);
  beam(parent, material, new THREE.Vector3(-7.7, ridge, 0), new THREE.Vector3(7.7, ridge, 0), 0.1);
  beam(parent, material, new THREE.Vector3(-7.7, eave, z0), new THREE.Vector3(-7.7, eave, z1), 0.1);
  beam(parent, material, new THREE.Vector3(7.7, eave, z0), new THREE.Vector3(7.7, eave, z1), 0.1);

  for (const z of [-2.85, 2.85]) {
    const y = (eave + ridge) / 2;
    beam(parent, material, new THREE.Vector3(-6, y, z), new THREE.Vector3(6, y, z), 0.06);
  }
}

/** 一榀三角桁架：下弦、两侧上弦、竖杆和斜腹杆。 */
function addTrussFrame(parent, material, x, z0, z1) {
  const eave = HALL.eaveY;
  const ridge = HALL.ridgeY;
  const bottom = eave - 0.62;
  const zMid = (z0 + z1) / 2;
  beam(parent, material, new THREE.Vector3(x, bottom, z0), new THREE.Vector3(x, bottom, z1), 0.07);
  beam(parent, material, new THREE.Vector3(x, eave, z0), new THREE.Vector3(x, ridge, zMid), 0.07);
  beam(parent, material, new THREE.Vector3(x, eave, z1), new THREE.Vector3(x, ridge, zMid), 0.07);
  beam(parent, material, new THREE.Vector3(x, bottom, zMid), new THREE.Vector3(x, ridge, zMid), 0.05);

  const splits = [z0, z0 + (zMid - z0) * 0.5, zMid, zMid + (z1 - zMid) * 0.5, z1];
  for (let i = 0; i < splits.length; i += 1) {
    const z = splits[i];
    const topY = z <= zMid
      ? THREE.MathUtils.lerp(eave, ridge, (z - z0) / (zMid - z0))
      : THREE.MathUtils.lerp(ridge, eave, (z - zMid) / (z1 - zMid));
    beam(parent, material, new THREE.Vector3(x, bottom, z), new THREE.Vector3(x, topY, z), 0.04);
    if (i < splits.length - 1) {
      const zNext = splits[i + 1];
      beam(
        parent,
        material,
        new THREE.Vector3(x, bottom, z),
        new THREE.Vector3(x, i + 1 <= 2
          ? THREE.MathUtils.lerp(eave, ridge, (zNext - z0) / (zMid - z0))
          : THREE.MathUtils.lerp(ridge, eave, (zNext - zMid) / (z1 - zMid)), zNext),
        0.035,
      );
    }
  }
}

function addSkylight(parent) {
  const glow = new THREE.MeshStandardMaterial({
    color: 0xeff5ff,
    emissive: COLOR.skylight,
    emissiveIntensity: 2.4,
    roughness: 0.18,
    metalness: 0.0,
    transparent: true,
    opacity: 0.92,
  });
  const frame = new THREE.MeshStandardMaterial({
    color: COLOR.steelDark,
    metalness: 0.7,
    roughness: 0.4,
  });
  // 屋脊光带：长条发光板 + 两侧边框。
  addBox(parent, glow, 0, HALL.ridgeY - 0.02, 0, 13.2, 0.06, 1.15, false);
  addBox(parent, frame, 0, HALL.ridgeY, -0.62, 13.4, 0.08, 0.06, false);
  addBox(parent, frame, 0, HALL.ridgeY, 0.62, 13.4, 0.08, 0.06, false);
}

function addPerimeterLines(parent) {
  const mat = new THREE.MeshStandardMaterial({
    color: COLOR.safety,
    roughness: 0.4,
    metalness: 0.06,
    emissive: 0x5a4308,
    emissiveIntensity: 0.4,
  });
  const x = 7.15;
  const z = 5.15;
  addSafetyBar(parent, mat, 0, -z, x * 2, 0.08);
  addSafetyBar(parent, mat, 0, z, x * 2, 0.08);
  addSafetyBar(parent, mat, -x, 0, 0.08, z * 2);
  addSafetyBar(parent, mat, x, 0, 0.08, z * 2);
  // 纵向主通道
  addSafetyBar(parent, mat, 0, 0, 0.07, z * 2 - 0.4);
}

const ZONE_SIZE = {
  pump: { w: 2.7, d: 1.8 },
  tank: { w: 2.3, d: 2.3 },
  conveyor: { w: 4.3, d: 1.9 },
  robot: { w: 2.3, d: 2.3 },
};

function rebuildZones(root, devices, material) {
  clearGroup(root);
  for (const device of devices) {
    const pos = device && device.position;
    if (!pos) continue;
    const size = ZONE_SIZE[device.type] || { w: 2.2, d: 2.2 };
    const x = pos.x || 0;
    const z = pos.z || 0;
    const w = size.w;
    const d = size.d;
    addSafetyBar(root, material, x, z - d / 2, w, 0.06);
    addSafetyBar(root, material, x, z + d / 2, w, 0.06);
    addSafetyBar(root, material, x - w / 2, z, 0.06, d);
    addSafetyBar(root, material, x + w / 2, z, 0.06, d);
  }
}

function addSafetyBar(parent, material, x, z, lenX, lenZ) {
  const h = 0.022;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(lenX, h, lenZ), material);
  mesh.position.set(x, 0.012 + h / 2, z);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  parent.add(mesh);
}

/**
 * 设备之间的工艺管。高度不跟设备 position.y，避免和模型落地高度缠在一起。
 * 冷却管：泵 → 罐；工艺管：罐 → 传送带；屋架下再拉一根公用管并在泵附近落下。
 */
function rebuildPipes(root, devices, coolantMat, serviceMat) {
  clearGroup(root);
  const pump = findDevice(devices, 'pump');
  const tank = findDevice(devices, 'tank');
  const conveyor = findDevice(devices, 'conveyor');

  if (pump && tank) {
    const x1 = pump.position.x + 0.95;
    const z1 = pump.position.z;
    const x2 = tank.position.x;
    const z2 = tank.position.z + 0.9;
    addPipe(root, coolantMat, 0.055, [
      [x1, 0.55, z1],
      [x1, 1.32, z1],
      [x2, 1.32, z1],
      [x2, 1.32, z2],
      [x2, 1.55, z2],
    ]);
  }

  if (tank && conveyor) {
    const x1 = tank.position.x + 0.95;
    const z1 = tank.position.z - 0.15;
    const x2 = conveyor.position.x - 1.15;
    const z2 = conveyor.position.z - 0.75;
    addPipe(root, serviceMat, 0.05, [
      [x1, 1.85, z1],
      [x1, 1.85, z2],
      [x2, 1.85, z2],
      [x2, 0.95, z2],
    ]);
  }

  addPipe(root, serviceMat, 0.07, [
    [-6.4, 3.35, -4.6],
    [6.4, 3.35, -4.6],
  ]);
  if (pump) {
    const x = pump.position.x - 0.35;
    addPipe(root, serviceMat, 0.055, [
      [x, 3.35, -4.6],
      [x, 3.35, pump.position.z + 0.2],
      [x, 1.32, pump.position.z + 0.2],
    ]);
  }
}

function findDevice(devices, type) {
  return devices.find((device) => device && device.type === type && device.position) || null;
}

function addPipe(parent, material, radius, points) {
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = new THREE.Vector3(points[i][0], points[i][1], points[i][2]);
    const b = new THREE.Vector3(points[i + 1][0], points[i + 1][1], points[i + 1][2]);
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-3) continue;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 12), material);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(_yAxis, dir.normalize());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
  for (let i = 1; i < points.length - 1; i += 1) {
    const joint = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.25, 10, 8), material);
    joint.position.set(points[i][0], points[i][1], points[i][2]);
    joint.castShadow = true;
    parent.add(joint);
  }
}

function addBox(parent, material, x, y, z, sx, sy, sz, cast) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = cast;
  mesh.receiveShadow = !cast;
  parent.add(mesh);
  return mesh;
}

function beam(parent, material, a, b, thickness) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-3) return;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(thickness, len, thickness), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(_yAxis, dir.normalize());
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  parent.add(mesh);
}

// ---------------------------------------------------------------------------
// 告警光环 / 名牌挂点
// ---------------------------------------------------------------------------

function makeAlarmRing() {
  const group = new THREE.Group();
  group.name = 'alarm-ring';
  const inner = new THREE.Mesh(
    new THREE.RingGeometry(0.95, 1.18, 48),
    new THREE.MeshBasicMaterial({
      color: COLOR.alarm,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  inner.rotation.x = -Math.PI / 2;
  const outer = new THREE.Mesh(
    new THREE.RingGeometry(1.15, 1.32, 48),
    new THREE.MeshBasicMaterial({
      color: COLOR.alarm,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  outer.rotation.x = -Math.PI / 2;
  group.add(inner);
  group.add(outer);
  return group;
}

function createLabel(CSS2DObject, group) {
  const el = document.createElement('div');
  el.className = 'device-label';
  // 名牌层整体也是 pointer-events: none；这里再挡一次，避免盖住 canvas 的 pointerdown。
  el.style.pointerEvents = 'none';
  const dot = document.createElement('span');
  dot.className = 'device-label-dot';
  dot.dataset.status = 'normal';
  const name = document.createElement('span');
  name.className = 'device-label-name';
  el.append(dot, name);
  const obj = new CSS2DObject(el);
  // (0.5, 0) 把名牌底边中心压在挂点上，文字浮在设备头顶。
  obj.center.set(0.5, 0);
  obj.name = `label:${group.userData.deviceId}`;
  placeLabel(obj, group);
  return { obj, dot, name };
}

/**
 * labelAnchor 优先。小杨给的是世界坐标 Vector3；
 * Object3D 取世界位置，普通 {x,y,z} 当成本地偏移再变到世界。
 * 都没有就用包围盒顶部中心往上 0.35。名牌挂在 scene 上，所以写世界坐标。
 */
function placeLabel(obj, group) {
  const anchor = group.userData.labelAnchor;
  if (anchor && anchor.isVector3) {
    obj.position.copy(anchor);
    return;
  }
  if (anchor && anchor.isObject3D) {
    anchor.getWorldPosition(obj.position);
    return;
  }
  if (anchor && typeof anchor.x === 'number') {
    _vec.set(anchor.x, anchor.y || 0, anchor.z || 0);
    group.localToWorld(_vec);
    obj.position.copy(_vec);
    return;
  }
  _box.makeEmpty();
  group.traverse((child) => {
    if (child.isMesh && child.userData.isSelectionRing !== true) _box.expandByObject(child);
  });
  if (_box.isEmpty()) {
    group.getWorldPosition(obj.position);
    obj.position.y += 1;
    return;
  }
  _box.getCenter(_vec);
  obj.position.set(_vec.x, _box.max.y + 0.35, _vec.z);
}

// ---------------------------------------------------------------------------
// 可选 addon
// ---------------------------------------------------------------------------

async function loadOptional(specifier) {
  try {
    return await import(specifier);
  } catch (err) {
    console.warn(`[scene] 可选模块加载失败 ${specifier}`, err);
    return null;
  }
}

async function setupEnvironment(renderer, scene) {
  const mod = await loadOptional('three/addons/environments/RoomEnvironment.js');
  if (!mod || typeof mod.RoomEnvironment !== 'function') {
    console.warn('[scene] RoomEnvironment 不可用，金属反射退回纯灯光');
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    return;
  }
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new mod.RoomEnvironment(renderer);
    const target = pmrem.fromScene(envScene, 0.04);
    scene.environment = target.texture;
    envScene.dispose();
    pmrem.dispose();
    // target 要留着，environment 贴图还指着它。
    scene.userData.envTarget = target;
  } catch (err) {
    console.warn('[scene] 环境贴图生成失败', err);
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  }
}

async function setupPost(renderer, scene, camera, width, height, onReady) {
  const [composerMod, renderMod, outlineMod, outputMod] = await Promise.all([
    loadOptional('three/addons/postprocessing/EffectComposer.js'),
    loadOptional('three/addons/postprocessing/RenderPass.js'),
    loadOptional('three/addons/postprocessing/OutlinePass.js'),
    loadOptional('three/addons/postprocessing/OutputPass.js'),
  ]);
  if (!composerMod || !renderMod || !outlineMod || !outputMod) {
    console.warn('[scene] 后处理模块不齐，选中只用地面选中环');
    return;
  }
  try {
    const composer = new composerMod.EffectComposer(renderer);
    composer.addPass(new renderMod.RenderPass(scene, camera));
    const outlinePass = new outlineMod.OutlinePass(new THREE.Vector2(width, height), scene, camera);
    outlinePass.edgeStrength = 6.5;
    outlinePass.edgeGlow = 1.35;
    outlinePass.edgeThickness = 2.2;
    outlinePass.pulsePeriod = 2.4;
    outlinePass.visibleEdgeColor.setHex(COLOR.outline);
    outlinePass.hiddenEdgeColor.setHex(COLOR.outlineHidden);
    composer.addPass(outlinePass);
    composer.addPass(new outputMod.OutputPass());
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(width, height);
    onReady({ composer, outlinePass });
    console.info('[scene] OutlinePass 已启用');
  } catch (err) {
    console.warn('[scene] 后处理初始化失败', err);
  }
}

async function setupLabels(containerEl, width, height, onReady) {
  const mod = await loadOptional('three/addons/renderers/CSS2DRenderer.js');
  if (!mod || typeof mod.CSS2DRenderer !== 'function' || typeof mod.CSS2DObject !== 'function') {
    console.warn('[scene] CSS2DRenderer 不可用，设备名牌已跳过');
    return;
  }
  const labelRenderer = new mod.CSS2DRenderer();
  labelRenderer.setSize(width, height);
  labelRenderer.domElement.className = 'label-layer';
  // 这层盖在 canvas 上。不关掉指针事件的话，devices 绑在 canvas 上的 pointerdown 收不到。
  labelRenderer.domElement.style.pointerEvents = 'none';
  containerEl.appendChild(labelRenderer.domElement);
  onReady({ renderer: labelRenderer, CSS2DObject: mod.CSS2DObject });
}

function clearGroup(group) {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}

function disposeObject(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    // 区域线和管道共用材质，几何体用完即弃，材质留给下一次重建。
  });
}

function disposeAlarm(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    child.material?.dispose();
  });
}

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function clamp8(value) {
  return Math.max(0, Math.min(255, value));
}
