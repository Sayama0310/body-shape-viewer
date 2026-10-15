import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadBodyModel, createShapeMapper } from './body-model.js';

// Anny のメッシュを身長・体重・性別に合わせて合成して表示する。

const STORAGE_KEY = 'body-shape-viewer:input';
const SEXES = ['male', 'female'];

const container = document.getElementById('viewer');
const statusEl = document.getElementById('viewer-status');
const heightRange = document.getElementById('height');
const weightRange = document.getElementById('weight');
const heightNumber = document.getElementById('height-num');
const weightNumber = document.getElementById('weight-num');
const sexInputs = document.querySelectorAll('input[name="sex"]');
const bmiOut = document.getElementById('bmi');
const bmiClassOut = document.getElementById('bmi-class');

// --- シーン ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e9ee);

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
camera.position.set(1.2, 1.2, 3.4);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a99, 1.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
keyLight.position.set(2, 4, 3);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 0.6);
rimLight.position.set(-2, 2, -3);
scene.add(rimLight);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.85, 0);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 1.0;
controls.maxDistance = 8;
controls.update();

// --- 体形 ---
const material = new THREE.MeshStandardMaterial({ color: 0xd9a988, roughness: 0.7 });
let body = null; // { model, mapShape, mesh, positions }

function showStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = !text;
}

async function initBody() {
  showStatus('体形データを読み込み中…');
  try {
    const model = await loadBodyModel();
    const positions = new THREE.BufferAttribute(new Float32Array(model.vertexCount * 3), 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', positions);
    geometry.setIndex(new THREE.BufferAttribute(model.index, 1));
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    body = { model, mapShape: createShapeMapper(model), mesh, positions };
    updateBody();
  } catch (err) {
    console.error(err);
    showStatus('体形データを読み込めませんでした。再読み込みしてください。');
  }
}

function updateBody() {
  if (!body) return;
  const { model, mapShape, mesh, positions } = body;
  const shape = mapShape({ sex: state.sex, heightCm: state.height, weightKg: state.weight });
  model.blend(shape.params, positions.array);
  const { minY } = model.measure(positions.array);
  mesh.position.y = -minY; // 足の裏を床（Y = 0）に合わせる
  positions.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
  showStatus(shape.inRange ? '' : 'モデルで表せる範囲を超えているため、近い体形を表示しています');
}

// 入力が続いても合成は1フレームに1回にする
let updateQueued = false;
function scheduleBodyUpdate() {
  if (updateQueued) return;
  updateQueued = true;
  requestAnimationFrame(() => {
    updateQueued = false;
    updateBody();
  });
}

// --- 入力 ---
// 値は state に持ち、スライダーと数値入力はどちらも state を更新する。
const fields = [
  { key: 'height', range: heightRange, number: heightNumber },
  { key: 'weight', range: weightRange, number: weightNumber },
];

const state = { height: 170, weight: 65, sex: 'male' };

function limits(field) {
  return { min: Number(field.range.min), max: Number(field.range.max) };
}

function isValid(field, value) {
  const { min, max } = limits(field);
  return Number.isFinite(value) && value >= min && value <= max;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// 日本肥満学会の判定基準
function bmiClass(bmi) {
  if (bmi < 18.5) return '低体重';
  if (bmi < 25) return '普通体重';
  if (bmi < 30) return '肥満（1度）';
  if (bmi < 35) return '肥満（2度）';
  if (bmi < 40) return '肥満（3度）';
  return '肥満（4度）';
}

function render({ syncNumbers = true } = {}) {
  for (const f of fields) {
    f.range.value = state[f.key];
    if (syncNumbers) f.number.value = state[f.key];
  }
  for (const input of sexInputs) input.checked = input.value === state.sex;

  const h = state.height / 100;
  const bmi = state.weight / (h * h);
  bmiOut.textContent = bmi.toFixed(1);
  bmiClassOut.textContent = bmiClass(bmi);

  scheduleBodyUpdate();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 保存できない環境（プライベートブラウズ等）では保存しない
  }
}

function restore() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return;
  }
  if (!saved || typeof saved !== 'object') return;
  for (const f of fields) {
    const v = Number(saved[f.key]);
    if (isValid(f, v)) state[f.key] = round1(v);
  }
  if (SEXES.includes(saved.sex)) state.sex = saved.sex;
}

for (const f of fields) {
  f.range.addEventListener('input', () => {
    state[f.key] = Number(f.range.value);
    render();
    save();
  });

  // 入力途中（空欄や範囲外）は反映せず、確定時に範囲内へ丸める
  f.number.addEventListener('input', () => {
    const v = f.number.valueAsNumber;
    if (!isValid(f, v)) return;
    state[f.key] = round1(v);
    render({ syncNumbers: false });
    save();
  });
  f.number.addEventListener('change', () => {
    const v = f.number.valueAsNumber;
    if (Number.isFinite(v)) {
      const { min, max } = limits(f);
      state[f.key] = round1(THREE.MathUtils.clamp(v, min, max));
      save();
    }
    render();
  });
}

for (const input of sexInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    state.sex = input.value;
    render();
    save();
  });
}

restore();
render();
initBody();

// --- 描画 ---
function resize() {
  const { clientWidth: w, clientHeight: h } = container;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(container);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
