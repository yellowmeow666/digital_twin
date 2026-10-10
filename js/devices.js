/**
 * 设备外观与动画（迭代 3）。
 *
 * - 每台设备是一个根 Group（userData.deviceId / device / labelAnchor），射线点选命中任意子网格。
 * - 状态色只作用在局部指示件（状态灯或环带）的 emissive 上，不再整机染色。
 * - 选中时地面出现黄色选中环。
 * - 所有动画挂在 scene.onBeforeRender 上，跟随页面已有的唯一一个 requestAnimationFrame。
 *
 * 导出：mountDevices、onSelect、setSelected、focusDevice、getDeviceGroup、getDeviceGroups
 */

import * as THREE from 'three';
import { getDevice, selectDevice, subscribe, subscribeSelection } from './data.js';

// ---------------------------------------------------------------------------
// 状态色与共享材质
// ---------------------------------------------------------------------------

const STATUS_COLOR = {
  normal: 0x22c55e,
  warn: 0xf59e0b,
  alarm: 0xef4444,
  // 兼容旧值
  running: 0x22c55e,
  idle: 0x38bdf8,
  offline: 0x64748b,
};

function colorForStatus(status) {
  return STATUS_COLOR[status] ?? 0x94a3b8;
}

/** 共享材质：金属度 / 粗糙度分档，所有设备复用，减少 draw 状态切换。 */
const MAT = {
  // 涂装钢板：中等金属度、半哑光
  paintBlue: new THREE.MeshStandardMaterial({ color: 0x2f5d8a, metalness: 0.35, roughness: 0.5 }),
  paintGray: new THREE.MeshStandardMaterial({ color: 0xc7ccd3, metalness: 0.55, roughness: 0.38 }),
  paintOrange: new THREE.MeshStandardMaterial({ color: 0xe8792b, metalness: 0.3, roughness: 0.45 }),
  paintYellow: new THREE.MeshStandardMaterial({ color: 0xd9b23a, metalness: 0.3, roughness: 0.5 }),
  // 光亮钢件：高金属度、低粗糙度
  steel: new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.92, roughness: 0.22 }),
  // 铸铁 / 底座：中金属度、高粗糙度
  iron: new THREE.MeshStandardMaterial({ color: 0x3b4048, metalness: 0.55, roughness: 0.75 }),
  // 橡胶 / 黑色件：无金属、很粗糙
  rubber: new THREE.MeshStandardMaterial({ color: 0x1b1d21, metalness: 0.0, roughness: 0.92 }),
  // 纸箱
  cardboard: new THREE.MeshStandardMaterial({ color: 0xb98a55, metalness: 0.0, roughness: 0.88 }),
  // 观察窗玻璃
  glass: new THREE.MeshStandardMaterial({
    color: 0xa5d8ff,
    metalness: 0.0,
    roughness: 0.05,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  }),
  // 液体
  liquid: new THREE.MeshStandardMaterial({
    color: 0x1e88e5,
    metalness: 0.1,
    roughness: 0.25,
    emissive: 0x0b3d70,
    emissiveIntensity: 0.35,
  }),
  // 灯罩外壳
  lampHousing: new THREE.MeshStandardMaterial({ color: 0x24272c, metalness: 0.6, roughness: 0.5 }),
};

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------

/** @type {((device: object | null) => void) | null} */
let selectHandler = null;
/** @type {string | null} */
let selectedId = null;
/** @type {Map<string, THREE.Group>} */
const groups = new Map();
/** @type {THREE.Group | null} */
let root = null;
/** @type {{ scene: THREE.Scene, camera: THREE.Camera, renderer: THREE.WebGLRenderer, focusOn?: Function } | null} */
let ctxRef = null;
let pickingBound = false;
let animationBound = false;
let unsubData = null;
let unsubSel = null;
let lastFrame = 0;
let elapsed = 0;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tmpBox = new THREE.Box3();
const tmpVec = new THREE.Vector3();

// ---------------------------------------------------------------------------
// 通用小部件
// ---------------------------------------------------------------------------

function mesh(geometry, material, opts = {}) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = opts.castShadow ?? true;
  m.receiveShadow = opts.receiveShadow ?? true;
  return m;
}

/** 沿 X 轴放置的圆柱几何（默认圆柱沿 Y）。 */
function cylX(rTop, rBottom, length, seg = 20) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, length, seg);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** 沿 Z 轴放置的圆柱几何。 */
function cylZ(r, length, seg = 16) {
  const g = new THREE.CylinderGeometry(r, r, length, seg);
  g.rotateX(Math.PI / 2);
  return g;
}

/** 状态灯：灯杆 + 灯罩 + 发光灯泡。返回 { object, lampMaterial }。 */
function makeStatusLamp(height = 0.6) {
  const g = new THREE.Group();
  const pole = mesh(new THREE.CylinderGeometry(0.025, 0.025, height, 10), MAT.steel);
  pole.position.y = height / 2;
  g.add(pole);

  const housing = mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 16), MAT.lampHousing);
  housing.position.y = height + 0.025;
  g.add(housing);

  const lampMaterial = new THREE.MeshStandardMaterial({
    color: 0x222222,
    metalness: 0.1,
    roughness: 0.3,
    emissive: 0x22c55e,
    emissiveIntensity: 1.4,
  });
  const bulb = mesh(new THREE.SphereGeometry(0.07, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), lampMaterial, {
    castShadow: false,
  });
  bulb.position.y = height + 0.05;
  g.add(bulb);
  return { object: g, lampMaterial };
}

/** 选中环（贴地）。 */
function makeSelectionRing(radius) {
  const material = new THREE.MeshBasicMaterial({
    color: 0xfbbf24,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.9, radius, 48), material);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ring.visible = false;
  ring.castShadow = false;
  ring.receiveShadow = false;
  ring.userData.isSelectionRing = true;
  return ring;
}

// ---------------------------------------------------------------------------
// 设备模型
// ---------------------------------------------------------------------------

/** 离心泵：底座、电机、联轴器、泵壳、进出口短管与法兰。 */
function buildPump() {
  const g = new THREE.Group();
  const anim = {};

  const base = mesh(new THREE.BoxGeometry(1.9, 0.14, 0.8), MAT.iron);
  base.position.y = 0.07;
  g.add(base);

  const axisY = 0.5;

  // 电机：机身 + 散热筋 + 端盖 + 机脚
  const motor = new THREE.Group();
  motor.position.set(-0.45, axisY, 0);
  const motorBody = mesh(cylX(0.27, 0.27, 0.78, 28), MAT.paintBlue);
  motor.add(motorBody);
  for (let i = 0; i < 6; i++) {
    const fin = mesh(cylX(0.3, 0.3, 0.025, 28), MAT.paintBlue);
    fin.position.x = -0.3 + i * 0.12;
    motor.add(fin);
  }
  const endCap = mesh(cylX(0.22, 0.27, 0.08, 28), MAT.iron);
  endCap.position.x = -0.43;
  motor.add(endCap);
  const motorFoot = mesh(new THREE.BoxGeometry(0.6, 0.2, 0.5), MAT.iron);
  motorFoot.position.y = -0.27;
  motor.add(motorFoot);
  g.add(motor);

  // 联轴器（转动件）
  const coupling = new THREE.Group();
  coupling.position.set(0.06, axisY, 0);
  const hubA = mesh(cylX(0.11, 0.11, 0.09, 20), MAT.steel);
  hubA.position.x = -0.05;
  const hubB = mesh(cylX(0.11, 0.11, 0.09, 20), MAT.steel);
  hubB.position.x = 0.05;
  const boltBar = mesh(new THREE.BoxGeometry(0.2, 0.04, 0.04), MAT.iron);
  boltBar.position.y = 0.08;
  coupling.add(hubA, hubB, boltBar);
  g.add(coupling);
  anim.coupling = coupling;

  // 泵壳（蜗壳）+ 泵脚
  const casing = mesh(cylX(0.34, 0.34, 0.32, 32), MAT.paintBlue);
  casing.position.set(0.42, axisY, 0);
  g.add(casing);
  const casingCover = mesh(cylX(0.26, 0.3, 0.06, 32), MAT.iron);
  casingCover.position.set(0.61, axisY, 0);
  g.add(casingCover);
  const pumpFoot = mesh(new THREE.BoxGeometry(0.4, 0.1, 0.5), MAT.iron);
  pumpFoot.position.set(0.42, 0.19, 0);
  g.add(pumpFoot);

  // 进口：沿 +X 的短管 + 法兰
  const inlet = mesh(cylX(0.1, 0.1, 0.3, 20), MAT.steel);
  inlet.position.set(0.78, axisY, 0);
  g.add(inlet);
  const inletFlange = mesh(cylX(0.17, 0.17, 0.04, 24), MAT.iron);
  inletFlange.position.set(0.94, axisY, 0);
  g.add(inletFlange);

  // 出口：向上的短管 + 法兰
  const outlet = mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.34, 20), MAT.steel);
  outlet.position.set(0.42, axisY + 0.34 + 0.17, 0);
  g.add(outlet);
  const outletFlange = mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.04, 24), MAT.iron);
  outletFlange.position.set(0.42, axisY + 0.34 + 0.36, 0);
  g.add(outletFlange);

  const lamp = makeStatusLamp(0.55);
  lamp.object.position.set(-0.85, 0.14, 0.32);
  g.add(lamp.object);

  return { group: g, lampMaterial: lamp.lampMaterial, ringRadius: 1.15, anim };
}

/** 立式储罐：支腿、罐体、球形封头、爬梯、液位观察窗。 */
function buildTank() {
  const g = new THREE.Group();
  const anim = {};

  const R = 0.7;
  const shellH = 1.8;
  const shellBottom = 0.5;
  const shellCenter = shellBottom + shellH / 2;
  const shellTop = shellBottom + shellH;

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = mesh(new THREE.CylinderGeometry(0.05, 0.06, shellBottom + 0.05, 12), MAT.iron);
    leg.position.set(Math.cos(a) * (R - 0.12), (shellBottom + 0.05) / 2, Math.sin(a) * (R - 0.12));
    g.add(leg);
  }

  const shell = mesh(new THREE.CylinderGeometry(R, R, shellH, 40), MAT.paintGray);
  shell.position.y = shellCenter;
  g.add(shell);

  // 封头：半球压扁成椭圆封头
  const topHead = mesh(new THREE.SphereGeometry(R, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), MAT.paintGray);
  topHead.position.y = shellTop;
  topHead.scale.y = 0.45;
  g.add(topHead);
  const bottomHead = mesh(
    new THREE.SphereGeometry(R, 40, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    MAT.paintGray,
  );
  bottomHead.position.y = shellBottom;
  bottomHead.scale.y = 0.4;
  g.add(bottomHead);

  // 环向焊缝 / 加强圈
  for (const y of [shellBottom + 0.05, shellCenter, shellTop - 0.05]) {
    const band = mesh(new THREE.TorusGeometry(R + 0.005, 0.018, 8, 48), MAT.steel);
    band.rotation.x = Math.PI / 2;
    band.position.y = y;
    g.add(band);
  }

  // 顶部人孔 / 接管
  const nozzle = mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.25, 20), MAT.steel);
  nozzle.position.set(0.15, shellTop + R * 0.45 - 0.02, 0.1);
  g.add(nozzle);
  const nozzleFlange = mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.04, 20), MAT.iron);
  nozzleFlange.position.set(0.15, shellTop + R * 0.45 + 0.12, 0.1);
  g.add(nozzleFlange);

  // 爬梯（+X 侧）
  const ladder = new THREE.Group();
  const ladderBottom = 0.05;
  const ladderTop = shellTop + 0.2;
  const ladderH = ladderTop - ladderBottom;
  for (const dz of [-0.17, 0.17]) {
    const rail = mesh(new THREE.BoxGeometry(0.035, ladderH, 0.035), MAT.paintYellow);
    rail.position.set(0, ladderBottom + ladderH / 2, dz);
    ladder.add(rail);
  }
  for (let y = ladderBottom + 0.2; y < ladderTop - 0.05; y += 0.25) {
    const rung = mesh(new THREE.BoxGeometry(0.03, 0.03, 0.34), MAT.paintYellow);
    rung.position.set(0, y, 0);
    ladder.add(rung);
  }
  // 支撑脚
  for (const y of [0.6, shellTop - 0.2]) {
    const stay = mesh(new THREE.BoxGeometry(0.12, 0.03, 0.03), MAT.steel);
    stay.position.set(-0.06, y, 0);
    ladder.add(stay);
  }
  ladder.position.set(R + 0.1, 0, 0);
  g.add(ladder);

  // 液位观察窗（+Z 侧）：框 + 玻璃 + 液柱
  const winH = 1.4;
  const winBottom = shellCenter - winH / 2;
  const frame = mesh(new THREE.BoxGeometry(0.18, winH + 0.08, 0.05), MAT.iron);
  frame.position.set(0, shellCenter, R + 0.01);
  g.add(frame);

  const liquidGeo = new THREE.BoxGeometry(0.09, 1, 0.03);
  liquidGeo.translate(0, 0.5, 0); // 原点在底部，方便按液位缩放
  const liquid = mesh(liquidGeo, MAT.liquid, { castShadow: false });
  liquid.position.set(0, winBottom, R + 0.04);
  liquid.scale.y = winH * 0.6;
  g.add(liquid);

  const glass = mesh(new THREE.BoxGeometry(0.11, winH, 0.02), MAT.glass, { castShadow: false });
  glass.position.set(0, shellCenter, R + 0.06);
  g.add(glass);

  // 刻度
  for (let i = 1; i < 5; i++) {
    const tick = mesh(new THREE.BoxGeometry(0.05, 0.008, 0.01), MAT.steel, { castShadow: false });
    tick.position.set(0.075, winBottom + (winH * i) / 5, R + 0.07);
    g.add(tick);
  }

  anim.liquid = liquid;
  anim.liquidMaxH = winH;
  anim.levelCurrent = 0.6;

  const lamp = makeStatusLamp(0.35);
  lamp.object.position.set(-0.25, shellTop + R * 0.45 - 0.05, -0.15);
  g.add(lamp.object);

  return { group: g, lampMaterial: lamp.lampMaterial, ringRadius: 1.05, anim };
}

/** 条纹贴图（皮带流动感）。 */
function makeBeltTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const c = canvas.getContext('2d');
  c.fillStyle = '#1f2226';
  c.fillRect(0, 0, 128, 32);
  c.fillStyle = '#3a3f46';
  for (let x = 0; x < 128; x += 32) c.fillRect(x, 0, 10, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 皮带输送机：机架、滚筒、皮带（贴图滚动）、货箱、驱动电机。 */
function buildConveyor() {
  const g = new THREE.Group();
  const anim = {};

  const L = 3.2;
  const W = 0.7;
  const beltY = 0.78;

  // 机架
  for (const z of [-(W / 2 + 0.06), W / 2 + 0.06]) {
    const rail = mesh(new THREE.BoxGeometry(L + 0.2, 0.14, 0.06), MAT.paintYellow);
    rail.position.set(0, beltY - 0.05, z);
    g.add(rail);
  }
  for (const x of [-L / 2 + 0.1, 0, L / 2 - 0.1]) {
    for (const z of [-(W / 2 + 0.06), W / 2 + 0.06]) {
      const leg = mesh(new THREE.BoxGeometry(0.07, beltY - 0.12, 0.07), MAT.iron);
      leg.position.set(x, (beltY - 0.12) / 2, z);
      g.add(leg);
    }
    const brace = mesh(new THREE.BoxGeometry(0.05, 0.05, W + 0.12), MAT.iron);
    brace.position.set(x, 0.25, 0);
    g.add(brace);
  }

  // 滚筒（转动件）
  const rollers = [];
  const rollerR = 0.065;
  const rollerGeo = cylZ(rollerR, W + 0.04, 18);
  for (let x = -L / 2 + 0.05; x <= L / 2 - 0.05 + 1e-6; x += 0.25) {
    const roller = mesh(rollerGeo, MAT.steel);
    roller.position.set(x, beltY - rollerR - 0.012, 0);
    g.add(roller);
    rollers.push(roller);
  }
  // 两端大滚筒
  const drumGeo = cylZ(0.1, W + 0.06, 24);
  for (const x of [-L / 2 - 0.02, L / 2 + 0.02]) {
    const drum = mesh(drumGeo, MAT.steel);
    drum.position.set(x, beltY - 0.1, 0);
    g.add(drum);
    rollers.push(drum);
  }

  // 皮带（上表面带条纹贴图）
  const beltTex = makeBeltTexture();
  beltTex.repeat.set(10, 1);
  const beltMat = new THREE.MeshStandardMaterial({ map: beltTex, metalness: 0.0, roughness: 0.85 });
  const belt = mesh(new THREE.BoxGeometry(L + 0.1, 0.02, W), beltMat);
  belt.position.set(0, beltY, 0);
  g.add(belt);

  // 货箱
  const crates = [];
  const crateGeo = new THREE.BoxGeometry(0.34, 0.3, 0.34);
  const tapeGeo = new THREE.BoxGeometry(0.345, 0.305, 0.06);
  const tapeMat = new THREE.MeshStandardMaterial({ color: 0xd8c8a0, metalness: 0, roughness: 0.6 });
  for (let i = 0; i < 3; i++) {
    const crate = new THREE.Group();
    crate.add(mesh(crateGeo, MAT.cardboard));
    crate.add(mesh(tapeGeo, tapeMat, { castShadow: false }));
    crate.position.set(-L / 2 + 0.3 + i * (L / 3), beltY + 0.01 + 0.15, (i - 1) * 0.08);
    crate.rotation.y = (i - 1) * 0.15;
    g.add(crate);
    crates.push(crate);
  }

  // 驱动电机
  const drive = mesh(cylZ(0.14, 0.32, 20), MAT.paintBlue);
  drive.position.set(L / 2 + 0.02, beltY - 0.1, W / 2 + 0.3);
  g.add(drive);
  const gearbox = mesh(new THREE.BoxGeometry(0.24, 0.24, 0.16), MAT.iron);
  gearbox.position.set(L / 2 + 0.02, beltY - 0.1, W / 2 + 0.1);
  g.add(gearbox);

  anim.rollers = rollers;
  anim.rollerR = rollerR;
  anim.belt = beltTex;
  anim.beltLen = L + 0.1;
  anim.crates = crates;
  anim.crateMin = -L / 2 + 0.15;
  anim.crateMax = L / 2 - 0.15;

  const lamp = makeStatusLamp(0.5);
  lamp.object.position.set(-L / 2 - 0.05, beltY + 0.02, -(W / 2 + 0.06));
  g.add(lamp.object);

  return { group: g, lampMaterial: lamp.lampMaterial, ringRadius: 2.0, anim };
}

/** 关节机器人：底座 + 转台 + 大臂 + 小臂 + 腕 + 夹爪；底座环带指示状态。 */
function buildRobot() {
  const g = new THREE.Group();
  const anim = {};

  const base = mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.22, 32), MAT.iron);
  base.position.y = 0.11;
  g.add(base);

  // 状态环带
  const bandMaterial = new THREE.MeshStandardMaterial({
    color: 0x222222,
    metalness: 0.2,
    roughness: 0.3,
    emissive: 0x22c55e,
    emissiveIntensity: 1.4,
  });
  const band = mesh(new THREE.TorusGeometry(0.455, 0.025, 10, 48), bandMaterial, { castShadow: false });
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.2;
  g.add(band);

  // 关节 1：转台（绕 Y）
  const turret = new THREE.Group();
  turret.position.y = 0.22;
  const turretBody = mesh(new THREE.CylinderGeometry(0.32, 0.38, 0.22, 32), MAT.paintOrange);
  turretBody.position.y = 0.11;
  turret.add(turretBody);
  g.add(turret);

  // 关节 2：肩（绕 Z）
  const shoulder = new THREE.Group();
  shoulder.position.y = 0.32;
  const shoulderJoint = mesh(cylZ(0.15, 0.32, 24), MAT.iron);
  shoulder.add(shoulderJoint);
  const upperArm = mesh(new THREE.BoxGeometry(0.2, 0.85, 0.22), MAT.paintOrange);
  upperArm.position.y = 0.425;
  shoulder.add(upperArm);
  turret.add(shoulder);

  // 关节 3：肘（绕 Z）
  const elbow = new THREE.Group();
  elbow.position.y = 0.85;
  const elbowJoint = mesh(cylZ(0.12, 0.28, 24), MAT.iron);
  elbow.add(elbowJoint);
  const foreArm = mesh(new THREE.BoxGeometry(0.16, 0.7, 0.17), MAT.paintOrange);
  foreArm.position.y = 0.35;
  elbow.add(foreArm);
  shoulder.add(elbow);

  // 关节 4：腕（绕 Z）
  const wrist = new THREE.Group();
  wrist.position.y = 0.7;
  const wristJoint = mesh(cylZ(0.085, 0.2, 20), MAT.iron);
  wrist.add(wristJoint);
  const wristLink = mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.2, 20), MAT.steel);
  wristLink.position.y = 0.1;
  wrist.add(wristLink);
  elbow.add(wrist);

  // 夹爪
  const gripper = new THREE.Group();
  gripper.position.y = 0.22;
  const palm = mesh(new THREE.BoxGeometry(0.26, 0.05, 0.12), MAT.iron);
  gripper.add(palm);
  const fingerGeo = new THREE.BoxGeometry(0.035, 0.17, 0.09);
  const fingerL = mesh(fingerGeo, MAT.steel);
  const fingerR = mesh(fingerGeo, MAT.steel);
  fingerL.position.set(-0.08, 0.1, 0);
  fingerR.position.set(0.08, 0.1, 0);
  gripper.add(fingerL, fingerR);
  wrist.add(gripper);

  anim.turret = turret;
  anim.shoulder = shoulder;
  anim.elbow = elbow;
  anim.wrist = wrist;
  anim.fingerL = fingerL;
  anim.fingerR = fingerR;
  anim.phase = Math.random() * Math.PI * 2;

  return { group: g, lampMaterial: bandMaterial, ringRadius: 0.95, anim };
}

function buildGeneric() {
  const g = new THREE.Group();
  const body = mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), MAT.paintGray);
  body.position.y = 0.45;
  g.add(body);
  const lamp = makeStatusLamp(0.3);
  lamp.object.position.set(0, 0.9, 0);
  g.add(lamp.object);
  return { group: g, lampMaterial: lamp.lampMaterial, ringRadius: 0.9, anim: {} };
}

const BUILDERS = {
  pump: buildPump,
  tank: buildTank,
  conveyor: buildConveyor,
  robot: buildRobot,
};

// ---------------------------------------------------------------------------
// 构建 / 同步
// ---------------------------------------------------------------------------

function createDeviceGroup(device) {
  const build = BUILDERS[device.type] ?? buildGeneric;
  const { group, lampMaterial, ringRadius, anim } = build();

  group.traverse((obj) => {
    if (obj.isMesh && !obj.userData.isSelectionRing) {
      obj.castShadow = obj.castShadow !== false;
      obj.receiveShadow = true;
    }
  });

  const ring = makeSelectionRing(ringRadius);
  group.add(ring);

  group.name = `device:${device.id}`;
  group.userData.deviceId = device.id;
  group.userData.deviceType = device.type;
  group.userData.lampMaterial = lampMaterial;
  group.userData.selectionRing = ring;
  group.userData.anim = anim;
  group.userData.labelAnchor = new THREE.Vector3();
  return group;
}

/** 名牌挂点：设备包围盒顶部上方 0.35，世界坐标。 */
function updateLabelAnchor(group) {
  group.updateWorldMatrix(true, true);
  tmpBox.makeEmpty();
  group.traverse((obj) => {
    if (obj.isMesh && !obj.userData.isSelectionRing) tmpBox.expandByObject(obj);
  });
  if (tmpBox.isEmpty()) {
    group.getWorldPosition(group.userData.labelAnchor);
    group.userData.labelAnchor.y += 1;
    return;
  }
  tmpBox.getCenter(tmpVec);
  group.userData.labelAnchor.set(tmpVec.x, tmpBox.max.y + 0.35, tmpVec.z);
  group.userData.focusCenter = tmpVec.clone();
}

function applyStatus(group, device) {
  const mat = group.userData.lampMaterial;
  if (mat) mat.emissive.setHex(colorForStatus(device.status));
  group.userData.status = device.status;
}

function applySelection(group, selected) {
  const ring = group.userData.selectionRing;
  if (ring) ring.visible = selected;
}

function upsertDevice(device) {
  if (!root || !device || device.id == null) return;
  let group = groups.get(device.id);
  const isNew = !group;
  if (isNew) {
    group = createDeviceGroup(device);
    groups.set(device.id, group);
    root.add(group);
  }

  const p = device.position || { x: 0, y: 0, z: 0 };
  // 模型自带落地高度，根节点放在地面上；只取 x / z。
  const moved = group.position.x !== (p.x ?? 0) || group.position.z !== (p.z ?? 0);
  group.position.set(p.x ?? 0, 0, p.z ?? 0);
  if (typeof device.rotationY === 'number') group.rotation.y = device.rotationY;

  group.userData.device = device;
  applyStatus(group, device);
  applySelection(group, device.id === selectedId);

  // 储罐液位目标
  const anim = group.userData.anim;
  if (anim?.liquid && typeof device.metrics?.level === 'number') {
    anim.levelTarget = THREE.MathUtils.clamp(device.metrics.level / 100, 0, 1);
    if (isNew) anim.levelCurrent = anim.levelTarget;
  }

  if (isNew || moved) updateLabelAnchor(group);
}

function disposeGroup(group) {
  const shared = new Set(Object.values(MAT));
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.geometry?.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m || shared.has(m)) continue;
      m.map?.dispose();
      m.dispose();
    }
  });
}

function syncDevices(list) {
  const seen = new Set();
  for (const device of list) {
    seen.add(device.id);
    upsertDevice(device);
  }
  for (const [id, group] of groups) {
    if (!seen.has(id)) {
      root?.remove(group);
      disposeGroup(group);
      groups.delete(id);
    }
  }
}

function paintSelection() {
  for (const [id, group] of groups) applySelection(group, id === selectedId);
}

// ---------------------------------------------------------------------------
// 动画（跟随页面唯一的 rAF：scene.onBeforeRender）
// ---------------------------------------------------------------------------

function animateDevice(group, dt, t) {
  const anim = group.userData.anim || {};
  const device = group.userData.device || {};
  const metrics = device.metrics || {};
  const type = group.userData.deviceType;

  // 状态灯：告警闪烁，警告缓慢呼吸，正常常亮
  const lamp = group.userData.lampMaterial;
  if (lamp) {
    const status = group.userData.status;
    if (status === 'alarm') lamp.emissiveIntensity = Math.sin(t * 8) > 0 ? 2.2 : 0.25;
    else if (status === 'warn') lamp.emissiveIntensity = 1.0 + 0.6 * Math.sin(t * 3);
    else lamp.emissiveIntensity = 1.4;
  }

  // 选中环呼吸
  const ring = group.userData.selectionRing;
  if (ring?.visible) ring.material.opacity = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t * 4));

  if (type === 'pump' && anim.coupling) {
    const flow = typeof metrics.flow === 'number' ? metrics.flow : 30;
    const omega = THREE.MathUtils.clamp(flow / 36, 0.2, 2) * 14; // rad/s
    anim.coupling.rotation.x += omega * dt;
  }

  if (type === 'tank' && anim.liquid) {
    const target = anim.levelTarget ?? anim.levelCurrent ?? 0.6;
    anim.levelCurrent += (target - anim.levelCurrent) * Math.min(1, dt * 2.5);
    anim.liquid.scale.y = Math.max(0.001, anim.levelCurrent * anim.liquidMaxH);
  }

  if (type === 'conveyor' && anim.belt) {
    const speed = typeof metrics.speed === 'number' ? metrics.speed : 1.2;
    const v = THREE.MathUtils.clamp(speed, 0, 3) * 0.35; // 场景单位 / 秒
    // 贴图向 +X 流动
    anim.belt.offset.x -= (v * dt * anim.belt.repeat.x) / anim.beltLen;
    const omega = v / anim.rollerR;
    for (const r of anim.rollers) r.rotation.z -= omega * dt;
    const span = anim.crateMax - anim.crateMin;
    for (const crate of anim.crates) {
      crate.position.x += v * dt;
      if (crate.position.x > anim.crateMax) crate.position.x -= span;
    }
  }

  if (type === 'robot' && anim.turret) {
    const s = t * 0.5 + anim.phase;
    anim.turret.rotation.y = Math.sin(s * 0.6) * 0.9;
    anim.shoulder.rotation.z = -0.35 + Math.sin(s) * 0.25;
    anim.elbow.rotation.z = 1.0 + Math.sin(s + 1.2) * 0.35;
    anim.wrist.rotation.z = 0.5 + Math.sin(s * 1.3 + 0.4) * 0.35;
    const open = 0.045 + 0.04 * (0.5 + 0.5 * Math.sin(s * 1.6));
    anim.fingerL.position.x = -open - 0.02;
    anim.fingerR.position.x = open + 0.02;
  }
}

function animateAll() {
  const now = performance.now();
  const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  elapsed += dt;
  for (const group of groups.values()) animateDevice(group, dt, elapsed);
}

function bindAnimation(scene) {
  if (animationBound) return;
  const prev = scene.onBeforeRender;
  scene.onBeforeRender = function onBeforeRender(...args) {
    animateAll();
    if (typeof prev === 'function') prev.apply(this, args);
  };
  animationBound = true;
}

// ---------------------------------------------------------------------------
// 点选
// ---------------------------------------------------------------------------

function findDeviceId(object) {
  let o = object;
  while (o) {
    if (o.userData && o.userData.deviceId != null && groups.has(o.userData.deviceId)) {
      return o.userData.deviceId;
    }
    o = o.parent;
  }
  return null;
}

function onPointerDown(event) {
  if (!ctxRef) return;
  const { camera, renderer } = ctxRef;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([...groups.values()], true);
  for (const hit of hits) {
    if (hit.object.userData.isSelectionRing) continue;
    const id = findDeviceId(hit.object);
    if (id != null) {
      selectDevice(id);
      return;
    }
  }
  selectDevice(null);
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export function onSelect(handler) {
  selectHandler = typeof handler === 'function' ? handler : null;
}

/** 从列表等外部设置选中；三维选中环跟随。传 null 取消。 */
export function setSelected(id) {
  selectDevice(id);
}

/** 选中并飞向设备。供「定位」按钮调用。 */
export function focusDevice(id) {
  if (id == null) return;
  selectDevice(id);
  const group = groups.get(id);
  let target = group?.userData.focusCenter ?? null;
  if (!target) {
    const device = getDevice(id);
    target = device?.position ?? null;
  }
  if (target && typeof ctxRef?.focusOn === 'function') {
    ctxRef.focusOn({ x: target.x, y: target.y, z: target.z });
  }
}

/** 某台设备的根 Group（userData 含 deviceId、device、labelAnchor）。 */
export function getDeviceGroup(id) {
  return groups.get(id) ?? null;
}

/** 全部设备根 Group。 */
export function getDeviceGroups() {
  return [...groups.values()];
}

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

  bindAnimation(ctx.scene);

  if (unsubData) unsubData();
  unsubData = subscribe((snapshot) => {
    syncDevices(snapshot.devices || []);
  });

  if (unsubSel) unsubSel();
  unsubSel = subscribeSelection((device) => {
    selectedId = device ? device.id : null;
    paintSelection();
    if (typeof selectHandler === 'function') selectHandler(device);
  });
}
