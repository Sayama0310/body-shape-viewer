// 入力のボトムシートとグループの開閉。
// - シートは「たたむ（要約だけ）/ 半分 / 全開」の3段階。つまみ部分のドラッグに追従し、離すと最寄りの段階へ収まる
// - シートの上端は CSS 変数 --sheet-top に入れる（3D 表示のカメラは app.js が毎フレーム追従させる）
// - 開閉の状態は端末内に保存する（表示の好みなので失われても困らない）

const sheet = document.getElementById('sheet');
const grip = document.getElementById('sheet-grip');
const toggle = document.getElementById('sheet-toggle');
const body = document.getElementById('sheet-body');
const groups = [...document.querySelectorAll('.group')];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const STORAGE_KEY = 'body-shape-viewer:ui';

function loadUi() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveUi() {
  try {
    const open = groups.filter((g) => g.classList.contains('is-open')).map((g) => g.dataset.group);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ snap: currentSnap, open }));
  } catch {
    // 保存できない環境では保存しない
  }
}

// --- 高さ ---
let snaps = { collapsed: 0, half: 0, full: 0 };
let currentSnap = 'collapsed';
let height = 0;
let anim = null;

function safeArea(side) {
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;visibility:hidden;padding-${side}:env(safe-area-inset-${side})`;
  document.body.appendChild(probe);
  const v = parseFloat(getComputedStyle(probe)[`padding${side[0].toUpperCase()}${side.slice(1)}`]) || 0;
  probe.remove();
  return v;
}

function computeSnaps() {
  const vh = window.innerHeight;
  const collapsed = grip.offsetHeight + safeArea('bottom');
  // 全開でも、上に視点ボタンと体の全身が小さく見える程度（画面の 22% 以上）は残す
  const full = Math.max(collapsed, vh - Math.max(safeArea('top') + 64, vh * 0.22));
  const half = Math.min(Math.max(collapsed + 120, vh * 0.5), full);
  snaps = { collapsed, half, full };
}

function setHeight(h) {
  height = h;
  sheet.style.height = `${h}px`;
  document.documentElement.style.setProperty('--sheet-top', `${window.innerHeight - h}px`);
  toggle.setAttribute('aria-expanded', String(h > snaps.collapsed + 8));
}

function animateTo(name) {
  currentSnap = name;
  saveUi();
  sheet.dispatchEvent(new CustomEvent('snap', { detail: name })); // app.js がたたんだときに数値を隠す
  const target = snaps[name];
  cancelAnimationFrame(anim?.raf);
  if (reduceMotion.matches) {
    setHeight(target);
    return;
  }
  const from = height;
  const start = performance.now();
  const duration = 320;
  const step = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const e = 1 - (1 - t) ** 3; // ease-out
    setHeight(from + (target - from) * e);
    if (t < 1) anim = { raf: requestAnimationFrame(step) };
    else anim = null;
  };
  anim = { raf: requestAnimationFrame(step) };
}

function nearestSnap(h) {
  return Object.entries(snaps).reduce((best, [name, v]) => (Math.abs(v - h) < Math.abs(snaps[best] - h) ? name : best), 'collapsed');
}

// --- ドラッグ ---
let drag = null;

grip.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.people-tabs, .privacy-toggle')) return; // 人の切り替え・数値の表示のボタンはドラッグに使わない
  cancelAnimationFrame(anim?.raf);
  anim = null;
  drag = { id: e.pointerId, y0: e.clientY, h0: height, moved: false, samples: [{ t: e.timeStamp, y: e.clientY }] };
  grip.setPointerCapture(e.pointerId);
});

grip.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dy = e.clientY - drag.y0;
  if (Math.abs(dy) > 6) drag.moved = true;
  let h = drag.h0 - dy;
  // 範囲の外はゴムのように重くする
  if (h > snaps.full) h = snaps.full + (h - snaps.full) * 0.3;
  if (h < snaps.collapsed) h = snaps.collapsed - (snaps.collapsed - h) * 0.3;
  setHeight(h);
  drag.samples.push({ t: e.timeStamp, y: e.clientY });
  if (drag.samples.length > 5) drag.samples.shift();
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { moved, samples } = drag;
  drag = null;
  if (!moved) {
    // タップ: たたんでいれば半分まで開き、開いていればたたむ
    animateTo(currentSnap === 'collapsed' ? 'half' : 'collapsed');
    return;
  }
  // 指を離した勢いの分だけ先の位置で最寄りの段階を選ぶ
  const first = samples[0];
  const last = samples[samples.length - 1];
  const velocity = last.t > first.t ? (first.y - last.y) / (last.t - first.t) : 0; // px/ms、上向きが正
  animateTo(nearestSnap(height + velocity * 180));
}

grip.addEventListener('pointerup', endDrag);
grip.addEventListener('pointercancel', endDrag);
// キーボード操作（Enter / Space）での開閉
toggle.addEventListener('click', (e) => {
  if (e.detail === 0) animateTo(currentSnap === 'collapsed' ? 'half' : 'collapsed');
});

// 入力欄にフォーカスしたら、たたんでいても見えるように開く
body.addEventListener('focusin', () => {
  if (currentSnap === 'collapsed') animateTo('half');
});

window.addEventListener('resize', () => {
  computeSnaps();
  if (!drag) setHeight(snaps[currentSnap]);
});

// --- グループ ---
function setGroupOpen(group, open) {
  group.classList.toggle('is-open', open);
  group.querySelector('.group-head').setAttribute('aria-expanded', String(open));
}

for (const group of groups) {
  group.querySelector('.group-head').addEventListener('click', () => {
    setGroupOpen(group, !group.classList.contains('is-open'));
    saveUi();
  });
}

// --- 初期状態 ---
const ui = loadUi();
const initiallyOpen = new Set(ui.open ?? ['basic']);
for (const group of groups) {
  // app.js が入力済みの項目があるグループに data-open を付ける
  setGroupOpen(group, initiallyOpen.has(group.dataset.group) || group.dataset.open === 'true');
}
computeSnaps();
currentSnap = ui.snap in snaps ? ui.snap : 'half';
setHeight(snaps[currentSnap]);
