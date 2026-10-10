/**
 * Three.js 场景：灯光、地面、简易厂房框、PerspectiveCamera、OrbitControls。
 * 依赖 import map：three @0.160.0 与 three/addons/（或页面约定的 vendor）。
 * 导出：createScene（含 focusOn）
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * @param {HTMLElement} containerEl
 * @returns {{ scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, controls: OrbitControls, render: () => void, resize: () => void, focusOn: (position: {x:number,y:number,z:number}, opts?: {duration?: number}) => void }}
 */
export function createScene(containerEl) {
  if (!containerEl) throw new Error('createScene requires a container element');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);

  const width = containerEl.clientWidth || window.innerWidth;
  const height = containerEl.clientHeight || window.innerHeight;

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 200);
  camera.position.set(10, 8, 12);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  containerEl.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 1, 0);
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 3;
  controls.maxDistance = 40;

  const hemi = new THREE.HemisphereLight(0xb1c5ff, 0x444444, 0.7);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(8, 14, 6);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  scene.add(dir);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9, metalness: 0.05 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const frameGeo = new THREE.BoxGeometry(18, 6, 14);
  const edges = new THREE.EdgesGeometry(frameGeo);
  const frame = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x64748b }));
  frame.position.y = 3;
  scene.add(frame);

  const grid = new THREE.GridHelper(24, 24, 0x334155, 0x1e293b);
  grid.position.y = 0.01;
  scene.add(grid);

  /** @type {{ start: number, duration: number, fromCam: THREE.Vector3, toCam: THREE.Vector3, fromTarget: THREE.Vector3, toTarget: THREE.Vector3 } | null} */
  let focusAnim = null;

  function resize() {
    const w = containerEl.clientWidth || window.innerWidth;
    const h = containerEl.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function render() {
    if (focusAnim) {
      const u = Math.min(1, (performance.now() - focusAnim.start) / focusAnim.duration);
      const e = easeInOut(u);
      camera.position.lerpVectors(focusAnim.fromCam, focusAnim.toCam, e);
      controls.target.lerpVectors(focusAnim.fromTarget, focusAnim.toTarget, e);
      if (u >= 1) focusAnim = null;
    }
    controls.update();
    renderer.render(scene, camera);
  }

  /**
   * 平滑飞向目标点。相机停在目标斜上方，OrbitControls.target 对准目标。
   * @param {{ x: number, y?: number, z: number }} position
   * @param {{ duration?: number }} [opts]
   */
  function focusOn(position, opts = {}) {
    if (!position) return;
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

  window.addEventListener('resize', resize);

  return { scene, camera, renderer, controls, render, resize, focusOn };
}
