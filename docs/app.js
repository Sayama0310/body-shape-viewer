import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadBodyModel, createShapeMapper, GIRTHS, DEFAULT_AGE } from './body-model.js';
import { loadAssetCatalog, Attachment, visibleBodyIndex } from './attachments.js';

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
const GIRTH_LABELS = {
  chest: '胸囲',
  underbust: 'アンダーバスト',
  waist: 'ウエスト',
  hip: 'ヒップ',
  upperarm: '二の腕',
  thigh: '太もも',
  calf: 'ふくらはぎ',
  ankle: '足首',
};
// 折りたたんだ欄の見出しに出す項目
const SUMMARY_GIRTHS = ['chest', 'waist', 'hip'];

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
// 開くときは表示してから is-open を付けてフェード・スライドさせ、閉じるときは逆にしてから閉じる
const helpDialog = document.getElementById('help');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function openHelp() {
  helpDialog.showModal();
  requestAnimationFrame(() => helpDialog.classList.add('is-open'));
}
function closeHelp() {
  helpDialog.classList.remove('is-open');
  if (reduceMotion.matches) return helpDialog.close();
  setTimeout(() => helpDialog.close(), 300);
}
document.getElementById('help-button').addEventListener('click', openHelp);
document.getElementById('help-close').addEventListener('click', closeHelp);
helpDialog.addEventListener('click', (e) => {
  if (e.target === helpDialog) closeHelp(); // 外側を押したら閉じる
});
helpDialog.addEventListener('cancel', (e) => {
  e.preventDefault(); // Esc でもアニメーションして閉じる
  closeHelp();
});

// --- 体形 ---
// 肌の色は頂点色で塗る（唇・爪などの部位ごとに少し色を変える）
const material = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.62, metalness: 0 });

// 肌の色のプリセット（明るい → 暗い）。4 番目がこれまでの色
const SKIN_TONES = [
  { hex: '#f7e1d3', label: 'とても明るい' },
  { hex: '#efcbb0', label: '明るい' },
  { hex: '#e2b28f', label: 'やや明るい' },
  { hex: '#d8a585', label: '中間' },
  { hex: '#c18760', label: 'やや濃い' },
  { hex: '#a0673f', label: '濃い' },
  { hex: '#7a4a2e', label: 'とても濃い' },
  { hex: '#553222', label: '最も濃い' },
];
const DEFAULT_SKIN = 3;

async function loadSkinRegions() {
  try {
    const [meta, bin] = await Promise.all([
      fetch(new URL('./data/skin-regions.json', import.meta.url)).then((r) => r.json()),
      fetch(new URL('./data/skin-regions.bin', import.meta.url)).then((r) => r.arrayBuffer()),
    ]);
    return { channels: meta.channels, weights: new Uint8Array(bin) };
  } catch (err) {
    console.error(err);
    return null; // 塗り分けなしで続ける
  }
}

// 部位ごとの色: 肌の色に掛ける係数（線形の色空間）か、混ぜる色
const REGION_TINTS = {
  lips: (c) => c.clone().multiply(new THREE.Color(0.82, 0.52, 0.52)),
  nails: (c) => c.clone().lerp(new THREE.Color(1, 0.86, 0.84), 0.45),
  areolae: (c) => c.clone().multiply(new THREE.Color(0.72, 0.56, 0.52)),
  eyelids: (c) => c.clone().multiplyScalar(0.88),
};

function applySkin() {
  if (!body) return;
  const base = new THREE.Color(SKIN_TONES[state.skin].hex);
  const colors = body.colors.array;
  const regions = body.skinRegions;
  const tints = regions ? regions.channels.map((name) => REGION_TINTS[name]?.(base) ?? base) : [];
  const n = body.model.vertexCount;
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    c.copy(base);
    for (let k = 0; k < tints.length; k++) {
      const w = regions.weights[i * tints.length + k] / 255;
      if (w > 0) c.lerp(tints[k], w);
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  body.colors.needsUpdate = true;
}
let body = null; // { model, mapShape, mesh, positions }

function showStatus(text) {
  if (text) statusEl.textContent = text; // 消すときは文字を残したままフェードアウトさせる
  statusEl.classList.toggle('is-shown', Boolean(text));
  statusEl.setAttribute('aria-hidden', String(!text));
}

async function initBody() {
  showStatus('体形データを読み込み中…');
  try {
    const [model, skinRegions] = await Promise.all([loadBodyModel(state.variant), loadSkinRegions()]);
    state.variant = model.variant; // 読めなかった傾向は標準に戻る
    const positions = new THREE.BufferAttribute(new Float32Array(model.vertexCount * 3), 3);
    const colors = new THREE.BufferAttribute(new Float32Array(model.vertexCount * 3), 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', positions);
    geometry.setAttribute('color', colors);
    geometry.setIndex(new THREE.BufferAttribute(model.index, 1));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    // 体と、体に追従するアセット（服・髪）をまとめて接地させる
    const figure = new THREE.Group();
    figure.add(mesh);
    scene.add(figure);
    const fullIndex = geometry.index;
    body = { model, mapShape: createShapeMapper(model), mesh, positions, colors, skinRegions, figure, fullIndex, visibleIndex: fullIndex };
    applySkin();
    updateBody();
  } catch (err) {
    console.error(err);
    showStatus('体形データを読み込めませんでした。再読み込みしてください。');
    return;
  }
  initWardrobe();
}

// --- 服装（体に追従するアセット） ---
// 選択肢は data/assets/index.json から作る。アセット本体は選ばれたときに読み込む
const SLOTS = ['top', 'bottom'];
const slotSelects = Object.fromEntries(SLOTS.map((slot) => [slot, document.getElementById(`outfit-${slot}`)]));
let catalog = [];
const loadedAssets = new Map(); // id -> Promise<Attachment>
let worn = []; // 表示中の Attachment

async function initWardrobe() {
  try {
    catalog = await loadAssetCatalog();
  } catch (err) {
    console.error(err);
    return;
  }
  for (const slot of SLOTS) {
    const select = slotSelects[slot];
    for (const a of catalog.filter((x) => x.slot === slot)) select.add(new Option(a.label, a.id));
    if (!catalog.some((a) => a.id === state[slot])) state[slot] = null;
    select.value = state[slot] ?? '';
    select.addEventListener('change', () => {
      state[slot] = select.value || null;
      save();
      updateSummaries();
      applyOutfit();
    });
  }
  updateSummaries();
  applyOutfit();
}

function loadAsset(id) {
  if (!loadedAssets.has(id)) {
    loadedAssets.set(id, Attachment.load(catalog.find((a) => a.id === id)));
  }
  return loadedAssets.get(id);
}

let outfitRequest = 0;
async function applyOutfit() {
  if (!body) return;
  const request = ++outfitRequest;
  const ids = SLOTS.map((slot) => state[slot]).filter(Boolean);
  let next;
  try {
    next = await Promise.all(ids.map(loadAsset));
  } catch (err) {
    console.error(err);
    showStatus('服のデータを読み込めませんでした');
    return;
  }
  if (request !== outfitRequest) return; // 読み込み中に選び直された
  for (const a of worn) if (!next.includes(a)) body.figure.remove(a.mesh);
  for (const a of next) if (!worn.includes(a)) body.figure.add(a.mesh);
  worn = next;
  // 服の下に隠れる体の三角形を描かない（法線は updateBody で全部の三角形から計算する）
  body.visibleIndex = new THREE.BufferAttribute(visibleBodyIndex(body.model.index, worn), 1);
  body.mesh.geometry.setIndex(body.visibleIndex);
  for (const a of worn) a.update(body.positions.array);
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
  body.morph = null; // 入力が変わったら、途中の切り替えアニメーションは終わりにして新しい形にする
  model.blend(shape.params, positions.array);
  if (state.muscle == null) showAutoMuscle(Math.round(shape.params.muscle * 100));
  const { minY, girths, height } = model.measure(positions.array);
  showGirths(girths);
  setBodyHeight(height);
  body.figure.position.y = -minY; // 足の裏を床（Y = 0）に合わせる
  refreshGeometry();
  showStatus(shape.inRange ? '' : 'モデルで表せる範囲を超えているため、近い体形を表示しています');
}

// 頂点を書き換えた後の更新（法線・服の追従）
function refreshGeometry() {
  const { mesh, positions } = body;
  positions.needsUpdate = true;
  // 法線は隠した三角形も含めて計算する（服を脱いだときに隠れていた部分の法線が古くならないように）
  mesh.geometry.setIndex(body.fullIndex);
  mesh.geometry.computeVertexNormals();
  mesh.geometry.setIndex(body.visibleIndex);
  mesh.geometry.computeBoundingSphere();
  for (const a of worn) a.update(positions.array);
}

// --- 体格の傾向 ---
// 選んだ傾向の形状データを読み込み（初めてならネットワークから）、今の体形から新しい体形へなめらかに変える
const variantSelect = document.getElementById('variant');
let variantRequest = 0;
async function applyVariant() {
  if (!body || body.model.variant === state.variant) return;
  const request = ++variantRequest;
  const from = { positions: body.positions.array.slice(), y: body.figure.position.y };
  try {
    showStatus('体格の傾向のデータを読み込み中…');
    await body.model.loadShape(state.variant);
  } catch (err) {
    console.error(err);
    showStatus('データを読み込めませんでした（オフラインでは、一度選んだことのある傾向だけ使えます）');
    return;
  }
  if (request !== variantRequest) return;
  body.mapShape = createShapeMapper(body.model);
  updateBody();
  if (reduceMotion.matches) return;
  body.morph = {
    from,
    to: { positions: body.positions.array.slice(), y: body.figure.position.y },
    start: performance.now(),
    duration: 600,
  };
  stepMorph(performance.now());
}

function stepMorph(now) {
  const m = body?.morph;
  if (!m) return;
  const t = Math.min((now - m.start) / m.duration, 1);
  const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  const out = body.positions.array;
  for (let i = 0; i < out.length; i++) out[i] = m.from.positions[i] + (m.to.positions[i] - m.from.positions[i]) * e;
  body.figure.position.y = m.from.y + (m.to.y - m.from.y) * e;
  refreshGeometry();
  if (t >= 1) body.morph = null;
}

// メッシュから測った周囲長を表示する
function showGirths(girths) {
  const cm = (g) => (girths[g] * 100).toFixed(1);
  for (const g of GIRTHS) document.getElementById(`${g}-measured`).textContent = cm(g);
  girthSummary.textContent = SUMMARY_GIRTHS.map((g) => `${GIRTH_LABELS[g]} ${cm(g)}`).join('・');
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
  updateSummaries();
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
  ...Object.fromEntries(GIRTHS.map((g) => [g, null])),
  // 服装（アセットの id、なしなら null）
  top: null,
  bottom: null,
  // 肌の色（SKIN_TONES の番号）
  skin: DEFAULT_SKIN,
  // 体格の傾向（data の shapes のキー）
  variant: 'standard',
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
  variantSelect.value = state.variant;
  for (const input of skinPicker.querySelectorAll('input')) input.checked = Number(input.value) === state.skin;

  const h = state.height / 100;
  const bmi = state.weight / (h * h);
  bmiOut.textContent = bmi.toFixed(1);
  bmiClassOut.textContent = bmiClass(bmi);
  updateSummaries();

  scheduleBodyUpdate({ quick });
}

// たたんだシートとグループの見出しに出す要約
const SEX_LABELS = { male: '男性', female: '女性' };
function updateSummaries() {
  const h = state.height / 100;
  const bmi = state.weight / (h * h);
  const basic = `${SEX_LABELS[state.sex]} · ${state.height} cm · ${state.weight} kg`;
  document.getElementById('sheet-summary-text').textContent = basic;
  document.getElementById('sheet-summary-bmi').textContent = `BMI ${bmi.toFixed(1)} ${bmiClass(bmi)}`;
  document.getElementById('basic-summary').textContent = basic;
  const muscle = state.muscle == null ? `自動 ${autoMuscle}` : state.muscle;
  const variant = variantSelect.selectedOptions[0]?.textContent ?? '';
  document.getElementById('body-summary').textContent = `${state.age} 歳 · 筋肉量 ${muscle} · ${variant}`;
  const label = (id) => catalog.find((a) => a.id === id)?.label;
  const outfit = SLOTS.map((slot) => label(state[slot])).filter(Boolean);
  document.getElementById('outfit-summary').textContent = outfit.length ? outfit.join(' · ') : 'なし';
  document.getElementById('look-summary').textContent = `肌 ${SKIN_TONES[state.skin].label}`;
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
  if (Number.isInteger(saved.skin) && saved.skin >= 0 && saved.skin < SKIN_TONES.length) state.skin = saved.skin;
  if ([...variantSelect.options].some((o) => o.value === saved.variant)) state.variant = saved.variant;
  // 服装は一覧を読み込んだ後に、存在する id か確かめる
  for (const slot of ['top', 'bottom']) if (typeof saved[slot] === 'string') state[slot] = saved[slot];
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

variantSelect.addEventListener('change', () => {
  state.variant = variantSelect.value;
  updateSummaries();
  save();
  applyVariant();
});

// 肌の色の選択肢
const skinPicker = document.getElementById('skin-picker');
SKIN_TONES.forEach((tone, i) => {
  const label = document.createElement('label');
  label.className = 'swatch';
  label.title = tone.label;
  label.innerHTML = `<input type="radio" name="skin" value="${i}" aria-label="${tone.label}"><span style="background:${tone.hex}"></span>`;
  skinPicker.append(label);
});
for (const input of skinPicker.querySelectorAll('input')) {
  input.addEventListener('change', () => {
    state.skin = Number(input.value);
    applySkin();
    updateSummaries();
    save();
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
// 周囲長を入力済みなら、その欄を開いた状態で始める
if (girthFields.some((f) => state[f.key] != null)) document.getElementById('girths').dataset.open = 'true';
render();
initBody();

// --- 描画 ---
// canvas は全画面のまま、シートより上に見えている領域（幅 w × 高さ visible）を1枚の画面として投影する。
// シートを動かしても canvas の大きさは変えず、投影だけを毎フレーム連続的にずらす
const sheetEl = document.getElementById('sheet');
let viewKey = '';
function updateViewport() {
  const { clientWidth: w, clientHeight: h } = container;
  const visible = Math.min(Math.max(sheetEl.getBoundingClientRect().top - container.getBoundingClientRect().top, 120), h);
  const key = `${w}x${h}x${visible.toFixed(1)}`;
  if (key === viewKey) return;
  viewKey = key;
  camera.aspect = w / visible;
  camera.setViewOffset(w, visible, 0, 0, w, h);
  camera.updateProjectionMatrix();
}

function resize() {
  const { clientWidth: w, clientHeight: h } = container;
  renderer.setSize(w, h, false);
  viewKey = '';
  updateViewport();
}

new ResizeObserver(resize).observe(container);
resize();

renderer.setAnimationLoop((now) => {
  updateViewport();
  stepTween(now);
  stepMorph(now);
  controls.update();
  renderer.render(scene, camera);
});
