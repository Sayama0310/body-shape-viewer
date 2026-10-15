import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// 試作ビューア: プリミティブを組み合わせた簡易人型。
// 寸法は身長 170cm の体形を基準（メートル単位）にし、
// 身長で縦方向の位置・長さを、BMI で胴・手足の太さを変える。

const BASE_HEIGHT = 1.70;
const BASE_BMI = 22;

const container = document.getElementById('viewer');
const heightInput = document.getElementById('height');
const weightInput = document.getElementById('weight');
const heightOut = document.getElementById('height-out');
const weightOut = document.getElementById('weight-out');

// --- シーン ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e9ee);

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
camera.position.set(1.6, 1.3, 4.2);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a99, 1.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
keyLight.position.set(2, 4, 3);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 0.6);
rimLight.position.set(-2, 2, -3);
scene.add(rimLight);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.9, 0);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 1.2;
controls.maxDistance = 8;
controls.update();

// --- 人型 ---
const material = new THREE.MeshStandardMaterial({ color: 0xd9a988, roughness: 0.75 });
const figure = new THREE.Group();
scene.add(figure);

const UP = new THREE.Vector3(0, 1, 0);

function addMesh(geometry, position, scale) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  if (scale) mesh.scale.copy(scale);
  figure.add(mesh);
  return mesh;
}

// a から b へ伸びる半径 r のカプセル
function limb(a, b, r) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geometry = new THREE.CapsuleGeometry(r, Math.max(len - 2 * r, 0.001), 6, 16);
  const mesh = addMesh(geometry, new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  return mesh;
}

function clearFigure() {
  for (const child of figure.children) child.geometry.dispose();
  figure.clear();
}

function buildFigure(heightCm, weightKg) {
  clearFigure();

  const h = heightCm / 100;
  const bmi = weightKg / (h * h);
  const k = h / BASE_HEIGHT; // 縦方向の倍率
  const ratio = THREE.MathUtils.clamp(bmi / BASE_BMI, 0.6, 2.2);
  const limbW = Math.sqrt(ratio); // 手足の太さ
  const trunkW = Math.pow(ratio, 0.8); // 胴は手足より太りやすくする
  const y = (v) => v * k;
  const v3 = (x, yy, z) => new THREE.Vector3(x, yy, z);

  // 頭・首（太さは体重で変えない）
  addMesh(new THREE.SphereGeometry(0.105, 32, 24), v3(0, y(1.585), 0), v3(0.92, 1.12 * k, 1));
  limb(v3(0, y(1.36), 0), v3(0, y(1.52), 0), 0.05 * Math.pow(ratio, 0.3));

  // 胴（胸〜腹）と骨盤。前後方向は扁平にする
  const chestR = 0.15 * trunkW;
  const torsoTop = y(1.40);
  const torsoBottom = y(0.98);
  const torso = new THREE.CapsuleGeometry(chestR, Math.max(torsoTop - torsoBottom - 2 * chestR, 0.01), 8, 24);
  addMesh(torso, v3(0, (torsoTop + torsoBottom) / 2, 0), v3(1, 1, 0.68));

  // 腹のふくらみ（BMI が高いほど前に出る）
  const belly = 0.13 * Math.pow(ratio, 1.1);
  addMesh(new THREE.SphereGeometry(belly, 24, 16), v3(0, y(1.08), 0.02 + 0.03 * (ratio - 1)), v3(1.05, 1.0, 0.85));

  const pelvisR = 0.14 * trunkW;
  addMesh(new THREE.SphereGeometry(pelvisR, 24, 16), v3(0, y(0.92), 0), v3(1.05, 0.75, 0.75));

  // 脚
  const legX = Math.max(0.085, pelvisR * 0.6);
  const thighR = 0.068 * limbW;
  const shinR = 0.048 * limbW;
  for (const s of [-1, 1]) {
    const hip = v3(s * legX, y(0.9), 0);
    const knee = v3(s * legX * 0.95, y(0.48), 0.005);
    const ankle = v3(s * legX * 0.9, y(0.08), 0);
    limb(hip, knee, thighR);
    limb(knee, ankle, shinR);
    addMesh(new THREE.SphereGeometry((thighR + shinR) * 0.5, 16, 12), knee);
    // 足
    limb(v3(s * legX * 0.9, 0.04, -0.03), v3(s * legX * 0.92, 0.035, 0.15), 0.035);
  }

  // 腕（胴が太いほど肩の位置を外へ）
  const upperArmR = 0.042 * limbW;
  const foreArmR = 0.034 * limbW;
  const shoulderX = chestR * 0.95 + upperArmR * 0.7;
  for (const s of [-1, 1]) {
    const shoulder = v3(s * shoulderX, y(1.39), 0);
    const elbow = v3(s * (shoulderX + 0.04 + 0.03 * (ratio - 1)), y(1.1), -0.01);
    const wrist = v3(s * (shoulderX + 0.06 + 0.05 * (ratio - 1)), y(0.84), 0.02);
    addMesh(new THREE.SphereGeometry(upperArmR * 1.15, 16, 12), shoulder);
    limb(shoulder, elbow, upperArmR);
    limb(elbow, wrist, foreArmR);
    addMesh(new THREE.SphereGeometry((upperArmR + foreArmR) * 0.5, 16, 12), elbow);
    addMesh(new THREE.SphereGeometry(0.045, 16, 12), v3(wrist.x, wrist.y - 0.04, wrist.z), v3(0.6, 1.3, 1));
  }
}

// --- 入力 ---
function update() {
  const heightCm = Number(heightInput.value);
  const weightKg = Number(weightInput.value);
  heightOut.textContent = heightCm;
  weightOut.textContent = weightKg;
  buildFigure(heightCm, weightKg);
}

heightInput.addEventListener('input', update);
weightInput.addEventListener('input', update);
update();

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
