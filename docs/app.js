import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadBodyData, loadShapeBuffer, BodyModel, createShapeMapper, GIRTHS, DEFAULT_AGE } from './body-model.js';
import { loadAssetCatalog, Attachment, visibleBodyIndex } from './attachments.js';

// Anny のメッシュを身長・体重・性別などに合わせて合成して表示する。最大2人を並べて表示できる。

const STORAGE_KEY = 'body-shape-viewer:input';
const SEXES = ['male', 'female'];
const MAX_PEOPLE = 2;
const PERSON_GAP = 0.25; // 2人の間のすき間（m）

const container = document.getElementById('viewer');
const statusEl = document.getElementById('viewer-status');
const bmiOut = document.getElementById('bmi');
const bmiClassOut = document.getElementById('bmi-class');
const girthSummary = document.getElementById('girth-summary');
const sexInputs = document.querySelectorAll('input[name="sex"]');
const nameInput = document.getElementById('person-name');
const tabsEl = document.getElementById('people-tabs');
const labelsEl = document.getElementById('person-labels');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
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

// 表示中の人（Person）。最大 MAX_PEOPLE 人
const people = [];

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

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
// 2本指: ピンチで中点に向かって寄る・ドラッグで平行移動
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.zoomToCursor = true;
controls.minDistance = 0.3;
controls.maxDistance = 8;
controls.maxPolarAngle = Math.PI * 0.55; // 床の下には回り込まない

// --- 視点 ---
// 全員の大きさに合わせて注視点と距離を決める。ボタンで正面・横・後ろへ回り込む
const VIEWS = { front: 0, side: Math.PI / 2, back: Math.PI };
const VIEW_ELEVATION = THREE.MathUtils.degToRad(6);
let bodyHeight = 1.7; // 表示中の人のうち最も高い身長（m）
let groupWidth = 0.6; // 表示中の人全員の横幅（m）
let tween = null;

function fitDistance() {
  const halfFov = THREE.MathUtils.degToRad(FOV / 2);
  // 2人のときは頭の上の名前も入るよう上下に少し余裕を持たせる
  const vertical = (bodyHeight * (people.length > 1 ? 0.7 : 0.62)) / Math.tan(halfFov);
  // 縦長の表示では横幅でも収まるようにする
  const horizontal = ((groupWidth * 0.5 + 0.25) / Math.tan(halfFov)) / Math.min(camera.aspect || 1, 1);
  return Math.max(vertical, horizontal);
}

function sphericalOf(position) {
  return new THREE.Spherical().setFromVector3(position.clone().sub(controls.target));
}

// 全員が収まる注視点
function fullTarget() {
  return new THREE.Vector3(0, bodyHeight * 0.5, 0);
}

// 注視点 target とカメラの向き・距離 sph へなめらかに移す
function moveCamera(target, sph, { animate = true } = {}) {
  if (!animate || reduceMotion.matches) {
    tween = null;
    controls.target.copy(target);
    camera.position.setFromSpherical(sph).add(target);
    controls.update();
    return;
  }
  const from = sphericalOf(camera.position);
  // 近い向きに回る
  let dTheta = sph.theta - from.theta;
  dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
  tween = {
    from,
    to: new THREE.Spherical(sph.radius, sph.phi, from.theta + dTheta),
    fromTarget: controls.target.clone(),
    toTarget: target.clone(),
    start: performance.now(),
    duration: 450,
  };
}

// name: front / side / back は全身をその向きから、full は今の向きのまま全身に戻す
function setView(name, { animate = true } = {}) {
  focused = false;
  const theta = name === 'full' ? sphericalOf(camera.position).theta : VIEWS[name];
  moveCamera(fullTarget(), new THREE.Spherical(fitDistance(), Math.PI / 2 - VIEW_ELEVATION, theta), { animate });
}

function stepTween(now) {
  if (!tween) return;
  const t = Math.min((now - tween.start) / tween.duration, 1);
  const e = ease(t);
  const { from, to } = tween;
  controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
  const s = new THREE.Spherical(
    from.radius + (to.radius - from.radius) * e,
    from.phi + (to.phi - from.phi) * e,
    from.theta + (to.theta - from.theta) * e,
  );
  camera.position.setFromSpherical(s).add(controls.target);
  if (t >= 1) tween = null;
}

// 平行移動しても体から大きく離れないよう、注視点を全員のまわりの箱に収める（カメラも同じだけ戻す）
controls.addEventListener('change', () => {
  const t = controls.target;
  const halfX = groupWidth * 0.5 + 0.3;
  const clamped = new THREE.Vector3(
    THREE.MathUtils.clamp(t.x, -halfX, halfX),
    THREE.MathUtils.clamp(t.y, 0.05, bodyHeight * 1.02),
    THREE.MathUtils.clamp(t.z, -0.5, 0.5),
  );
  if (!clamped.equals(t)) {
    camera.position.add(clamped.clone().sub(t));
    t.copy(clamped);
  }
});

// ダブルタップ: 体の当たった部位に寄る（その人を入力中にする）。寄っているときにもう一度ダブルタップすると全身に戻る
const FOCUS_DISTANCE = 0.7;
let focused = false;
let lastTap = null;
const raycaster = new THREE.Raycaster();
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!e.isPrimary) return;
  const now = performance.now();
  const near = lastTap && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30;
  if (lastTap && now - lastTap.t < 320 && near) {
    lastTap = null;
    onDoubleTap(e);
  } else {
    lastTap = { t: now, x: e.clientX, y: e.clientY };
  }
});
// 2本目の指が触れたらタップとして数えない
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary) lastTap = null;
});

function onDoubleTap(e) {
  if (focused) {
    setView('full');
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const figures = people.filter((p) => p.figure).map((p) => p.figure);
  const hit = raycaster.intersectObjects(figures, true)[0];
  if (!hit) return;
  const owner = people.find((p) => p.figure && hit.object.parent === p.figure);
  if (owner && owner !== activePerson()) selectPerson(people.indexOf(owner));
  const sph = sphericalOf(camera.position);
  sph.radius = Math.min(sph.radius, FOCUS_DISTANCE);
  moveCamera(hit.point, sph);
  focused = true;
}

// 指で回し始めたら視点の移動をやめる
controls.addEventListener('start', () => (tween = null));

// 全員の身長・横幅が変わったら、注視点の高さを身長の変化に合わせて動かす（カメラも同じだけ動かす）。
// 全身表示なら体の中ほどのまま、部位に寄っていれば寄った部位の近くのままになる
function setGroupSize(height, width) {
  const dy = (height - bodyHeight) * (controls.target.y / bodyHeight);
  bodyHeight = height;
  groupWidth = width;
  controls.target.y += dy;
  camera.position.y += dy;
  if (tween) {
    tween.fromTarget.y += dy;
    tween.toTarget.y += dy;
  }
  // 影を落とす範囲と床の円も全員が収まる大きさにする
  const half = Math.max(1, width * 0.5 + 0.5);
  Object.assign(keyLight.shadow.camera, { left: -half, right: half });
  keyLight.shadow.camera.updateProjectionMatrix();
  floor.scale.setScalar(Math.max(1, (width * 0.5 + 0.45) / 0.9));
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
// 体の材質（肌の色は人ごとに変えるので、人ごとに複製して色を付ける）
const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0 });

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

function showStatus(text) {
  if (text) statusEl.textContent = text; // 消すときは文字を残したままフェードアウトさせる
  statusEl.classList.toggle('is-shown', Boolean(text));
  statusEl.setAttribute('aria-hidden', String(!text));
}

// 全員で共有するデータ（体形データの共通部分・服の一覧）
let shared = null;
let catalog = [];
const loadedAssets = new Map(); // id -> Promise<Attachment>（人ごとに別のメッシュを作るので、読み込んだデータだけ共有）
const SLOTS = ['top', 'bottom'];

function defaultState(index) {
  return {
    name: '',
    height: index === 0 ? 170 : 158,
    weight: index === 0 ? 65 : 52,
    age: DEFAULT_AGE,
    muscle: null, // 0〜100。自動なら null
    sex: index === 0 ? 'male' : 'female',
    ...Object.fromEntries(GIRTHS.map((g) => [g, null])), // 周囲長は未入力なら null
    top: null, // 服装（アセットの id、なしなら null）
    bottom: null,
    skin: DEFAULT_SKIN, // 肌の色（SKIN_TONES の番号）
    variant: 'standard', // 体格の傾向（data の shapes のキー）
  };
}

// 1人分の体（入力・合成した頂点・メッシュ・服）
class Person {
  constructor(state) {
    this.state = state;
    this.autoMuscle = 50;
    this.girths = null;
    this.inRange = true;
    this.worn = [];
    this.morph = null;
    this.request = { outfit: 0, variant: 0 };
    this.x = 0; // 並べたときの位置（目標）
    this.label = document.createElement('div');
    this.label.className = 'person-label';
    labelsEl.append(this.label);
  }

  async init() {
    const { meta, shared: buffer } = shared.body;
    const model = new BodyModel(meta, buffer);
    const variant = this.state.variant in meta.shapes ? this.state.variant : 'standard';
    model.setShape(variant, await loadShapeBuffer(meta, variant));
    this.state.variant = variant; // 読めなかった傾向は標準に戻る
    this.model = model;
    this.mapShape = createShapeMapper(model);
    this.positions = new THREE.BufferAttribute(new Float32Array(model.vertexCount * 3), 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.positions);
    this.fullIndex = new THREE.BufferAttribute(model.index, 1);
    this.visibleIndex = this.fullIndex;
    geometry.setIndex(this.fullIndex);
    this.mesh = new THREE.Mesh(geometry, bodyMaterial.clone());
    this.mesh.castShadow = true;
    // 体と、体に追従するアセット（服・髪）をまとめて接地させる
    this.figure = new THREE.Group();
    this.figure.add(this.mesh);
    scene.add(this.figure);
    this.applySkin();
    this.update();
    this.applyOutfit();
  }

  dispose() {
    if (this.figure) {
      scene.remove(this.figure);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      for (const a of this.worn) a.mesh.geometry.dispose();
    }
    this.label.remove();
  }

  applySkin() {
    if (!this.model) return;
    this.mesh.material.color.set(SKIN_TONES[this.state.skin].hex);
  }

  // 入力から体形を合成する。quick: スライダー操作中（周囲長の調整は前回のまま身長・体重だけ合わせる）
  update({ quick = false } = {}) {
    if (!this.model) return;
    const s = this.state;
    const girthsCm = Object.fromEntries(GIRTHS.map((g) => [g, s[g] ?? NaN]));
    const shape = this.mapShape(
      {
        sex: s.sex,
        ageYears: s.age,
        heightCm: s.height,
        weightKg: s.weight,
        muscle: s.muscle == null ? null : s.muscle / 100,
        girthsCm,
      },
      { quick },
    );
    this.morph = null; // 入力が変わったら、途中の切り替えアニメーションは終わりにして新しい形にする
    this.model.blend(shape.params, this.positions.array);
    this.autoMuscle = Math.round(shape.params.muscle * 100);
    const { minY, girths, height } = this.model.measure(this.positions.array);
    this.girths = girths;
    this.height = height;
    this.inRange = shape.inRange;
    this.figure.position.y = -minY; // 足の裏を床（Y = 0）に合わせる
    this.refreshGeometry();
  }

  // 頂点を書き換えた後の更新（法線・横幅・服の追従）
  refreshGeometry() {
    const { mesh, positions } = this;
    positions.needsUpdate = true;
    // 法線は隠した三角形も含めて計算する（服を脱いだときに隠れていた部分の法線が古くならないように）
    mesh.geometry.setIndex(this.fullIndex);
    mesh.geometry.computeVertexNormals();
    mesh.geometry.setIndex(this.visibleIndex);
    mesh.geometry.computeBoundingSphere();
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    this.width = box.max.x - box.min.x;
    this.centerX = (box.max.x + box.min.x) / 2;
    for (const a of this.worn) a.update(positions.array);
  }

  async applyOutfit() {
    if (!this.model || !catalog.length) return;
    const request = ++this.request.outfit;
    const ids = SLOTS.map((slot) => this.state[slot]).filter(Boolean);
    let next;
    try {
      next = await Promise.all(ids.map(async (id) => this.worn.find((a) => a.info.id === id) ?? Attachment.fromLoaded(await loadAssetData(id))));
    } catch (err) {
      console.error(err);
      showStatus('服のデータを読み込めませんでした');
      return;
    }
    if (request !== this.request.outfit) return; // 読み込み中に選び直された
    for (const a of this.worn) {
      if (!next.includes(a)) {
        this.figure.remove(a.mesh);
        a.mesh.geometry.dispose();
      }
    }
    for (const a of next) if (!this.worn.includes(a)) this.figure.add(a.mesh);
    this.worn = next;
    // 服の下に隠れる体の三角形を描かない（法線は全部の三角形から計算する）
    this.visibleIndex = new THREE.BufferAttribute(visibleBodyIndex(this.model.index, this.worn), 1);
    this.mesh.geometry.setIndex(this.visibleIndex);
    for (const a of this.worn) a.update(this.positions.array);
  }

  // 選んだ傾向の形状データを読み込み（初めてならネットワークから）、今の体形から新しい体形へなめらかに変える
  async applyVariant() {
    if (!this.model || this.model.variant === this.state.variant) return;
    const request = ++this.request.variant;
    const from = { positions: this.positions.array.slice(), y: this.figure.position.y };
    try {
      showStatus('体格の傾向のデータを読み込み中…');
      await this.model.loadShape(this.state.variant);
    } catch (err) {
      console.error(err);
      showStatus('データを読み込めませんでした（オフラインでは、一度選んだことのある傾向だけ使えます）');
      return;
    }
    if (request !== this.request.variant) return;
    this.mapShape = createShapeMapper(this.model);
    this.update();
    afterUpdate(this);
    if (reduceMotion.matches) return;
    this.morph = {
      from,
      to: { positions: this.positions.array.slice(), y: this.figure.position.y },
      start: performance.now(),
      duration: 600,
    };
    this.stepMorph(performance.now());
  }

  stepMorph(now) {
    const m = this.morph;
    if (!m) return;
    const t = Math.min((now - m.start) / m.duration, 1);
    const e = ease(t);
    const out = this.positions.array;
    for (let i = 0; i < out.length; i++) out[i] = m.from.positions[i] + (m.to.positions[i] - m.from.positions[i]) * e;
    this.figure.position.y = m.from.y + (m.to.y - m.from.y) * e;
    this.refreshGeometry();
    if (t >= 1) this.morph = null;
  }

  displayName(index) {
    return this.state.name.trim() || `${index + 1}人目`;
  }
}

function loadAssetData(id) {
  if (!loadedAssets.has(id)) {
    const p = Attachment.loadData(catalog.find((a) => a.id === id));
    p.catch(() => loadedAssets.delete(id));
    loadedAssets.set(id, p);
  }
  return loadedAssets.get(id);
}

// --- 人の一覧 ---
let active = 0;
const activePerson = () => people[active];
let state = null; // 入力中の人の state（入力欄はこれを読み書きする）

// 並べ方: 横幅に合わせて間隔を決め、全体の中心を原点にする
function layoutPeople({ animate = true } = {}) {
  const ready = people.filter((p) => p.model);
  if (!ready.length) return;
  const total = ready.reduce((sum, p) => sum + p.width, 0) + PERSON_GAP * (ready.length - 1);
  let x = -total / 2;
  for (const p of ready) {
    p.x = x + p.width / 2 - p.centerX;
    x += p.width + PERSON_GAP;
    if (!animate || reduceMotion.matches || p.placed !== true) {
      p.figure.position.x = p.x;
      p.placed = true;
    }
  }
  setGroupSize(Math.max(...ready.map((p) => p.height)), total);
}

// 並べた位置へなめらかに動かす
function stepLayout(dt) {
  const k = 1 - Math.exp(-dt / 120);
  for (const p of people) {
    if (!p.figure) continue;
    p.figure.position.x += (p.x - p.figure.position.x) * k;
  }
}

// 体形を更新した後に、その人の表示と並べ方を更新する
function afterUpdate(person) {
  if (person === activePerson()) {
    showGirths(person.girths);
    if (person.state.muscle == null) showAutoMuscle(person.autoMuscle);
    showStatus(person.inRange ? '' : 'モデルで表せる範囲を超えているため、近い体形を表示しています');
  }
  layoutPeople();
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
    const person = activePerson();
    if (!person?.model) return;
    person.update(opts);
    afterUpdate(person);
  });
}

// メッシュから測った周囲長を表示する
function showGirths(girths) {
  if (!girths) return;
  const cm = (g) => (girths[g] * 100).toFixed(1);
  for (const g of GIRTHS) document.getElementById(`${g}-measured`).textContent = cm(g);
  girthSummary.textContent = SUMMARY_GIRTHS.map((g) => `${GIRTH_LABELS[g]} ${cm(g)}`).join('・');
}

async function addPerson(personState, { init = true } = {}) {
  const person = new Person(personState);
  people.push(person);
  if (init && shared) await initPerson(person);
  return person;
}

async function initPerson(person) {
  try {
    await person.init();
  } catch (err) {
    console.error(err);
    showStatus('体形データを読み込めませんでした。再読み込みしてください。');
    return;
  }
  afterUpdate(person);
}

function removePerson(index) {
  const [person] = people.splice(index, 1);
  person.dispose();
  selectPerson(Math.min(active, people.length - 1));
  layoutPeople();
  setView('full');
  save();
}

// 入力欄をその人の値に切り替える（再計算はしない）
function selectPerson(index) {
  active = index;
  state = people[active].state;
  renderTabs();
  render({ update: false });
  const person = activePerson();
  if (person.model) afterUpdate(person);
  save();
}

function renderTabs() {
  tabsEl.replaceChildren();
  if (people.length > 1) {
    people.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.role = 'tab';
      b.textContent = p.displayName(i);
      b.setAttribute('aria-selected', String(i === active));
      b.addEventListener('click', () => selectPerson(i));
      tabsEl.append(b);
    });
  }
  const action = document.createElement('button');
  action.type = 'button';
  if (people.length < MAX_PEOPLE) {
    action.className = 'tab-add';
    action.textContent = '＋ 2人目を追加';
    action.addEventListener('click', async () => {
      const person = await addPerson(defaultState(people.length));
      selectPerson(people.indexOf(person));
      setView('full');
    });
  } else {
    action.className = 'tab-remove';
    action.textContent = `${people[active].displayName(active)}を削除`;
    action.addEventListener('click', () => removePerson(active));
  }
  tabsEl.append(action);
}

// 3D 表示上の名前: 頭の上に出す（2人のとき、または名前があるとき）
const labelPos = new THREE.Vector3();
function updateLabels() {
  const rect = renderer.domElement.getBoundingClientRect();
  people.forEach((p, i) => {
    const show = p.model && (people.length > 1 || p.state.name.trim());
    p.label.style.opacity = show ? '1' : '0';
    if (!show) return;
    p.label.textContent = p.displayName(i);
    p.label.classList.toggle('is-active', people.length > 1 && i === active);
    labelPos.set(p.figure.position.x + p.centerX, p.figure.position.y + (p.positions ? p.mesh.geometry.boundingBox.max.y : 0) + 0.08, 0);
    labelPos.project(camera);
    const x = ((labelPos.x + 1) / 2) * rect.width;
    const y = ((1 - labelPos.y) / 2) * rect.height;
    p.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
  });
}

async function initScene() {
  showStatus('体形データを読み込み中…');
  try {
    shared = { body: await loadBodyData() };
  } catch (err) {
    console.error(err);
    showStatus('体形データを読み込めませんでした。再読み込みしてください。');
    return;
  }
  for (const person of people) await initPerson(person);
  setView('full', { animate: false }); // 読み込んだ体の大きさに合わせる（向きは最初の斜め前のまま）
  initWardrobe();
}

// --- 服装（体に追従するアセット） ---
// 選択肢は data/assets/index.json から作る。アセット本体は選ばれたときに読み込む
const slotSelects = Object.fromEntries(SLOTS.map((slot) => [slot, document.getElementById(`outfit-${slot}`)]));

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
    for (const p of people) if (!catalog.some((a) => a.id === p.state[slot])) p.state[slot] = null;
    select.value = state[slot] ?? '';
    select.addEventListener('change', () => {
      state[slot] = select.value || null;
      save();
      updateSummaries();
      activePerson().applyOutfit();
    });
  }
  updateSummaries();
  for (const p of people) p.applyOutfit();
}

// --- 入力 ---
// 値は state（入力中の人）に持ち、スライダーと数値入力はどちらも state を更新する。
const fields = [
  { key: 'height', range: document.getElementById('height'), number: document.getElementById('height-num') },
  { key: 'weight', range: document.getElementById('weight'), number: document.getElementById('weight-num') },
  { key: 'age', range: document.getElementById('age'), number: document.getElementById('age-num') },
  { key: 'muscle', range: document.getElementById('muscle'), number: document.getElementById('muscle-num') },
];
const muscleField = fields[3];
const muscleAuto = document.getElementById('muscle-auto');
const muscleFieldEl = document.getElementById('muscle-field');
const variantSelect = document.getElementById('variant');
const skinPicker = document.getElementById('skin-picker');

// 筋肉量が自動のときは、自動で決めた値をスライダーと数値に表示する
function autoMuscle() {
  return activePerson()?.autoMuscle ?? 50;
}
function showAutoMuscle(value) {
  updateSummaries();
  muscleField.range.value = value;
  paintRange(muscleField.range);
  if (document.activeElement !== muscleField.number) muscleField.number.value = value;
}

const girthFields = GIRTHS.map((key) => ({ key, number: document.getElementById(`${key}-num`) }));

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

function render({ syncNumbers = true, quick = false, update = true } = {}) {
  for (const f of fields) {
    const value = state[f.key] ?? autoMuscle(); // null になるのは筋肉量（自動）だけ
    f.range.value = value;
    paintRange(f.range);
    if (syncNumbers) f.number.value = value;
  }
  muscleAuto.checked = state.muscle == null;
  muscleFieldEl.classList.toggle('is-auto', state.muscle == null);
  if (syncNumbers) for (const f of girthFields) f.number.value = state[f.key] ?? '';
  for (const input of sexInputs) input.checked = input.value === state.sex;
  variantSelect.value = state.variant;
  for (const input of skinPicker.querySelectorAll('input')) input.checked = Number(input.value) === state.skin;
  for (const slot of SLOTS) slotSelects[slot].value = state[slot] ?? '';
  if (document.activeElement !== nameInput) nameInput.value = state.name;

  const h = state.height / 100;
  const bmi = state.weight / (h * h);
  bmiOut.textContent = bmi.toFixed(1);
  bmiClassOut.textContent = bmiClass(bmi);
  updateSummaries();

  if (update) scheduleBodyUpdate({ quick });
}

// たたんだシートとグループの見出しに出す要約
const SEX_LABELS = { male: '男性', female: '女性' };
function updateSummaries() {
  const h = state.height / 100;
  const bmi = state.weight / (h * h);
  const basic = `${SEX_LABELS[state.sex]} · ${state.height} cm · ${state.weight} kg`;
  const who = people.length > 1 || state.name.trim() ? `${activePerson().displayName(active)}: ` : '';
  document.getElementById('sheet-summary-text').textContent = who + basic;
  document.getElementById('sheet-summary-bmi').textContent = `BMI ${bmi.toFixed(1)} ${bmiClass(bmi)}`;
  document.getElementById('basic-summary').textContent = basic;
  const muscle = state.muscle == null ? `自動 ${autoMuscle()}` : state.muscle;
  const variant = [...variantSelect.options].find((o) => o.value === state.variant)?.textContent ?? '';
  document.getElementById('body-summary').textContent = `${state.age} 歳 · 筋肉量 ${muscle} · ${variant}`;
  const label = (id) => catalog.find((a) => a.id === id)?.label;
  const outfit = SLOTS.map((slot) => label(state[slot])).filter(Boolean);
  document.getElementById('outfit-summary').textContent = outfit.length ? outfit.join(' · ') : 'なし';
  document.getElementById('look-summary').textContent = `肌 ${SKIN_TONES[state.skin].label}`;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, active, people: people.map((p) => p.state) }));
  } catch {
    // 保存できない環境（プライベートブラウズ等）では保存しない
  }
}

// 保存した1人分の値を検証して state に入れる
function restoreState(saved, index) {
  const s = defaultState(index);
  if (!saved || typeof saved !== 'object') return s;
  for (const f of fields) {
    const v = Number(saved[f.key]);
    if (saved[f.key] != null && isValid(f, v)) s[f.key] = round1(v);
  }
  if (SEXES.includes(saved.sex)) s.sex = saved.sex;
  if (typeof saved.name === 'string') s.name = saved.name.slice(0, 12);
  if (Number.isInteger(saved.skin) && saved.skin >= 0 && saved.skin < SKIN_TONES.length) s.skin = saved.skin;
  if ([...variantSelect.options].some((o) => o.value === saved.variant)) s.variant = saved.variant;
  // 服装は一覧を読み込んだ後に、存在する id か確かめる
  for (const slot of SLOTS) if (typeof saved[slot] === 'string') s[slot] = saved[slot];
  for (const f of girthFields) {
    const v = Number(saved[f.key]);
    if (saved[f.key] != null && isValid(f, v)) s[f.key] = round1(v);
  }
  return s;
}

function restore() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    saved = null;
  }
  // 1人だけだった以前の形式（値がそのまま並ぶ）も読む
  const list = saved?.version === 2 && Array.isArray(saved.people) ? saved.people : [saved];
  for (const [i, s] of list.slice(0, MAX_PEOPLE).entries()) addPerson(restoreState(s, i), { init: false });
  active = Math.min(Math.max(Number(saved?.active) || 0, 0), people.length - 1);
  state = people[active].state;
}

// スライダーの塗り（つまみより左）の割合を CSS 変数に入れる
function paintRange(range) {
  const min = Number(range.min);
  const max = Number(range.max);
  range.style.setProperty('--fill', `${((Number(range.value) - min) / (max - min)) * 100}%`);
}

// 指を離す瞬間の小さなずれを取り消す: 離す直前 RELEASE_WINDOW ms の間に動いた量が
// 2目盛り以下なら、その前に止めていた値を確定値にする
const RELEASE_WINDOW = 80;
function settleOnRelease(f) {
  const history = f.history ?? [];
  const now = performance.now();
  const before = [...history].reverse().find((h) => h.t <= now - RELEASE_WINDOW);
  const step = Number(f.range.step) || 1;
  const current = Number(f.range.value);
  if (before && before.v !== current && Math.abs(before.v - current) <= step * 2) {
    f.range.value = before.v;
    state[f.key] = before.v;
  }
  f.history = [];
}

for (const f of fields) {
  f.range.addEventListener('input', () => {
    state[f.key] = Number(f.range.value);
    (f.history ??= []).push({ t: performance.now(), v: state[f.key] });
    if (f.history.length > 30) f.history.shift();
    render({ quick: true });
    save();
  });
  // 指を離したら、離す瞬間のずれを取り消してから周囲長も含めて合わせ直す
  f.range.addEventListener('change', () => {
    settleOnRelease(f);
    save();
    render();
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

// −／＋ ボタン: 押すと1目盛り、長押しで連続して（だんだん速く）動かす。離したら全体を合わせ直す
const STEPS = { height: 0.5, weight: 0.5, age: 1, muscle: 1 };
for (const button of document.querySelectorAll('.stepper')) {
  const f = fields.find((x) => x.key === button.dataset.field);
  const dir = Number(button.dataset.dir);
  let timer = null;
  const bump = () => {
    const { min, max } = limits(f);
    const current = state[f.key] ?? autoMuscle();
    state[f.key] = round1(THREE.MathUtils.clamp(current + dir * STEPS[f.key], min, max));
    render({ quick: true });
  };
  const stop = () => {
    if (timer == null) return;
    clearTimeout(timer);
    timer = null;
    save();
    render();
  };
  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    bump();
    let delay = 400;
    const repeat = () => {
      bump();
      delay = Math.max(40, delay * 0.8);
      timer = setTimeout(repeat, delay);
    };
    timer = setTimeout(repeat, delay);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, stop);
  // キーボード操作（Enter / Space）
  button.addEventListener('click', (e) => {
    if (e.detail !== 0) return;
    bump();
    save();
    render();
  });
}

// 自動にすると筋肉量の指定を外す。外すと今の自動の値から手動で調整できる
muscleAuto.addEventListener('change', () => {
  state.muscle = muscleAuto.checked ? null : autoMuscle();
  render();
  save();
});

variantSelect.addEventListener('change', () => {
  state.variant = variantSelect.value;
  updateSummaries();
  save();
  activePerson().applyVariant();
});

// 肌の色の選択肢
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
    activePerson().applySkin();
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

nameInput.addEventListener('input', () => {
  state.name = nameInput.value.slice(0, 12);
  renderTabs();
  updateSummaries();
  save();
});

restore();
// 周囲長を入力済みなら、その欄を開いた状態で始める
if (girthFields.some((f) => state[f.key] != null)) document.getElementById('girths').dataset.open = 'true';
renderTabs();
render({ update: false });
initScene();

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

let lastFrame = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(now - lastFrame, 100);
  lastFrame = now;
  updateViewport();
  stepTween(now);
  for (const p of people) p.stepMorph(now);
  stepLayout(dt);
  controls.update();
  renderer.render(scene, camera);
  updateLabels();
});
