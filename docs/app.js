import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadBodyModel, createShapeMapper, GIRTHS, DEFAULT_AGE } from './body-model.js';

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
const girthSummary = document.getElementById('girth-summary');
const GIRTH_LABELS = { chest: '胸囲', waist: 'ウエスト', hip: 'ヒップ' };

// --- シーン ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const FOV = 35;
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x8a8a99, 1.3);
scene.add(hemiLight);
// 主光源（影を落とす）・補助光・輪郭を出す逆光
const keyLight = new THREE.DirectionalLight(0xfff3e6, 2.2);
keyLight.position.set(1.5, 4, 2.5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
Object.assign(keyLight.shadow.camera, { left: -1, right: 1, top: 2.4, bottom: -0.2, near: 0.5, far: 10 });
keyLight.shadow.bias = -0.0005;
keyLight.shadow.normalBias = 0.02;
keyLight.shadow.radius = 4;
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xe6eeff, 0.6);
fillLight.position.set(-2.5, 1.5, 1.5);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 0.9);
rimLight.position.set(-1, 2.5, -3);
scene.add(rimLight);

// 床: 外へ向かって消える円と、体の影
// 円の色は material.color、ぼかしは alphaMap（白→黒の放射グラデーション）で付ける
function makeFadeTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, '#fff');
  g.addColorStop(0.6, '#fff');
  g.addColorStop(1, '#000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(0.9, 64),
  new THREE.MeshBasicMaterial({ alphaMap: makeFadeTexture(), transparent: true, depthWrite: false, toneMapped: false }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.ShadowMaterial({ opacity: 0.22 }));
shadowFloor.rotation.x = -Math.PI / 2;
shadowFloor.position.y = 0.001;
shadowFloor.receiveShadow = true;
scene.add(shadowFloor);

// 背景と床の色は CSS の変数から取る（ダークモードに追従する）
function applyTheme() {
  const css = getComputedStyle(document.documentElement);
  scene.background = new THREE.Color(css.getPropertyValue('--scene-bg').trim());
  floor.material.color.set(css.getPropertyValue('--floor').trim());
  const shadowOpacity = parseFloat(css.getPropertyValue('--shadow-opacity'));
  shadowFloor.material.opacity = Number.isFinite(shadowOpacity) ? shadowOpacity : 0.22;
}
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 0.8;
controls.maxDistance = 8;
controls.maxPolarAngle = Math.PI * 0.55; // 床の下には回り込まない

// --- 視点 ---
// 体の高さに合わせて注視点と距離を決める。ボタンで正面・横・後ろへ回り込む
const VIEWS = { front: 0, side: Math.PI / 2, back: Math.PI };
const VIEW_ELEVATION = THREE.MathUtils.degToRad(6);
let bodyHeight = 1.7;
let tween = null;

function fitDistance() {
  const halfFov = THREE.MathUtils.degToRad(FOV / 2);
  const vertical = (bodyHeight * 0.62) / Math.tan(halfFov);
  // 横長でない（縦長の）表示では横幅でも収まるようにする
  const horizontal = (0.5 / Math.tan(halfFov)) / Math.min(camera.aspect || 1, 1);
  return Math.max(vertical, horizontal);
}

function sphericalOf(position) {
  return new THREE.Spherical().setFromVector3(position.clone().sub(controls.target));
}

function setView(name, { animate = true } = {}) {
  const to = new THREE.Spherical(fitDistance(), Math.PI / 2 - VIEW_ELEVATION, VIEWS[name]);
  if (!animate) {
    camera.position.setFromSpherical(to).add(controls.target);
    controls.update();
    return;
  }
  const from = sphericalOf(camera.position);
  // 近い向きに回る
  let dTheta = to.theta - from.theta;
  dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
  tween = { from, to: new THREE.Spherical(to.radius, to.phi, from.theta + dTheta), start: performance.now(), duration: 450 };
}

function stepTween(now) {
  if (!tween) return;
  const t = Math.min((now - tween.start) / tween.duration, 1);
  const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease-in-out
  const { from, to } = tween;
  const s = new THREE.Spherical(
    from.radius + (to.radius - from.radius) * e,
    from.phi + (to.phi - from.phi) * e,
    from.theta + (to.theta - from.theta) * e,
  );
  camera.position.setFromSpherical(s).add(controls.target);
  if (t >= 1) tween = null;
}

// 指で回し始めたら視点の移動をやめる
controls.addEventListener('start', () => (tween = null));

// 身長が変わったら注視点の高さを体の中ほどに合わせる（カメラも同じだけ動かす）
function setBodyHeight(h) {
  const dy = h * 0.5 - controls.target.y;
  bodyHeight = h;
  controls.target.y += dy;
  camera.position.y += dy;
}

// 最初は少し斜め前から見る
controls.target.set(0, bodyHeight * 0.5, 0);
camera.position.setFromSpherical(new THREE.Spherical(fitDistance(), Math.PI / 2 - VIEW_ELEVATION, THREE.MathUtils.degToRad(20))).add(controls.target);
controls.update();

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => setView(button.dataset.view));
}

// --- 使い方 ---
const helpDialog = document.getElementById('help');
document.getElementById('help-button').addEventListener('click', () => helpDialog.showModal());
document.getElementById('help-close').addEventListener('click', () => helpDialog.close());
helpDialog.addEventListener('click', (e) => {
  if (e.target === helpDialog) helpDialog.close(); // 外側を押したら閉じる
});

// --- 体形 ---
const material = new THREE.MeshStandardMaterial({ color: 0xd8a585, roughness: 0.62, metalness: 0 });
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
    mesh.castShadow = true;
    scene.add(mesh);
    body = { model, mapShape: createShapeMapper(model), mesh, positions };
    updateBody();
  } catch (err) {
    console.error(err);
    showStatus('体形データを読み込めませんでした。再読み込みしてください。');
  }
}

// quick: スライダー操作中。周囲長の調整は前回のまま身長・体重だけ合わせる（指を離したら全体を合わせ直す）
function updateBody({ quick = false } = {}) {
  if (!body) return;
  const { model, mapShape, mesh, positions } = body;
  const girthsCm = Object.fromEntries(GIRTHS.map((g) => [g, state[g] ?? NaN]));
  const shape = mapShape(
    {
      sex: state.sex,
      ageYears: state.age,
      heightCm: state.height,
      weightKg: state.weight,
      muscle: state.muscle == null ? null : state.muscle / 100,
      girthsCm,
    },
    { quick },
  );
  model.blend(shape.params, positions.array);
  if (state.muscle == null) showAutoMuscle(Math.round(shape.params.muscle * 100));
  const { minY, girths, height } = model.measure(positions.array);
  showGirths(girths);
  setBodyHeight(height);
  mesh.position.y = -minY; // 足の裏を床（Y = 0）に合わせる
  positions.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
  showStatus(shape.inRange ? '' : 'モデルで表せる範囲を超えているため、近い体形を表示しています');
}

// メッシュから測った周囲長を表示する
function showGirths(girths) {
  const cm = (g) => (girths[g] * 100).toFixed(1);
  for (const g of GIRTHS) document.getElementById(`${g}-measured`).textContent = cm(g);
  girthSummary.textContent = GIRTHS.map((g) => `${GIRTH_LABELS[g]} ${cm(g)}`).join('・');
}

// 入力が続いても合成は1フレームに1回にする（1回でも通常の更新が頼まれていれば通常の更新にする）
let queued = null;
function scheduleBodyUpdate({ quick = false } = {}) {
  if (queued) {
    queued.quick &&= quick;
    return;
  }
  queued = { quick };
  requestAnimationFrame(() => {
    const opts = queued;
    queued = null;
    updateBody(opts);
  });
}

// --- 入力 ---
// 値は state に持ち、スライダーと数値入力はどちらも state を更新する。
const fields = [
  { key: 'height', range: heightRange, number: heightNumber },
  { key: 'weight', range: weightRange, number: weightNumber },
  { key: 'age', range: document.getElementById('age'), number: document.getElementById('age-num') },
  { key: 'muscle', range: document.getElementById('muscle'), number: document.getElementById('muscle-num') },
];
const muscleField = fields[3];
const muscleAuto = document.getElementById('muscle-auto');
const muscleFieldEl = document.getElementById('muscle-field');

// 筋肉量が自動のときは、自動で決めた値をスライダーと数値に表示する
let autoMuscle = 50;
function showAutoMuscle(value) {
  autoMuscle = value;
  muscleField.range.value = value;
  if (document.activeElement !== muscleField.number) muscleField.number.value = value;
}

const girthFields = GIRTHS.map((key) => ({ key, number: document.getElementById(`${key}-num`) }));

// 筋肉量（0〜100）は自動なら null、周囲長は未入力なら null
const state = {
  height: 170,
  weight: 65,
  age: DEFAULT_AGE,
  muscle: null,
  sex: 'male',
  chest: null,
  waist: null,
  hip: null,
};

function limits(field) {
  const el = field.range ?? field.number;
  return { min: Number(el.min), max: Number(el.max) };
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

function render({ syncNumbers = true, quick = false } = {}) {
  for (const f of fields) {
    const value = state[f.key] ?? autoMuscle; // null になるのは筋肉量（自動）だけ
    f.range.value = value;
    if (syncNumbers) f.number.value = value;
  }
  muscleAuto.checked = state.muscle == null;
  muscleFieldEl.classList.toggle('is-auto', state.muscle == null);
  if (syncNumbers) for (const f of girthFields) f.number.value = state[f.key] ?? '';
  for (const input of sexInputs) input.checked = input.value === state.sex;

  const h = state.height / 100;
  const bmi = state.weight / (h * h);
  bmiOut.textContent = bmi.toFixed(1);
  bmiClassOut.textContent = bmiClass(bmi);

  scheduleBodyUpdate({ quick });
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
    if (saved[f.key] != null && isValid(f, v)) state[f.key] = round1(v);
  }
  if (SEXES.includes(saved.sex)) state.sex = saved.sex;
  for (const f of girthFields) {
    const v = Number(saved[f.key]);
    if (saved[f.key] != null && isValid(f, v)) state[f.key] = round1(v);
  }
}

for (const f of fields) {
  f.range.addEventListener('input', () => {
    state[f.key] = Number(f.range.value);
    render({ quick: true });
    save();
  });
  // 指を離したら周囲長も含めて合わせ直す
  f.range.addEventListener('change', () => render());

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

for (const f of girthFields) {
  // 空欄にしたら未入力に戻す。入力途中の範囲外の値は反映しない
  f.number.addEventListener('input', () => {
    const v = f.number.valueAsNumber;
    if (f.number.value === '') state[f.key] = null;
    else if (isValid(f, v)) state[f.key] = round1(v);
    else return;
    render({ syncNumbers: false });
    save();
  });
  f.number.addEventListener('change', () => {
    const v = f.number.valueAsNumber;
    if (f.number.value === '' || !Number.isFinite(v)) {
      state[f.key] = null;
    } else {
      const { min, max } = limits(f);
      state[f.key] = round1(THREE.MathUtils.clamp(v, min, max));
    }
    save();
    render();
  });
}

// 自動にすると筋肉量の指定を外す。外すと今の自動の値から手動で調整できる
muscleAuto.addEventListener('change', () => {
  state.muscle = muscleAuto.checked ? null : autoMuscle;
  render();
  save();
});

for (const input of sexInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    state.sex = input.value;
    render();
    save();
  });
}

restore();
// 周囲長を入力済みなら、その欄を開いた状態で始める
if (girthFields.some((f) => state[f.key] != null)) document.getElementById('girths').open = true;
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

renderer.setAnimationLoop((now) => {
  stepTween(now);
  controls.update();
  renderer.render(scene, camera);
});
