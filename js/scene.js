/**
 * Three.js 场景：灯光、地面、简易厂房框、PerspectiveCamera、OrbitControls。
 * 依赖页面 import map：three @0.160.0 与 three/addons/
 * 导出：createScene
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * @param {HTMLElement} containerEl
 * @returns {{ scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, controls: OrbitControls, render: () => void, resize: () => void }}
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

  function resize() {
    const w = containerEl.clientWidth || window.innerWidth;
    const h = containerEl.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function render() {
    controls.update();
    renderer.render(scene, camera);
  }

  window.addEventListener('resize', resize);

  return { scene, camera, renderer, controls, render, resize };
}
