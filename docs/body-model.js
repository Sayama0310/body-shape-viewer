// Anny から書き出した体形データ（data/README.md）を読み込み、
// パラメータに応じて角の頂点と局所変形を重み付き合成する。

const DATA_URL = new URL('./data/anny-body.json', import.meta.url);
const FORMAT_VERSION = 2;

// 体重の換算に使う密度（Anny の anthropometry.py と同じ値）
export const BODY_DENSITY = 980; // kg/m³

// 周囲長の名前（data の measurements / localChanges の name と同じ）
export const GIRTHS = ['chest', 'waist', 'hip'];

export async function loadBodyModel() {
  const meta = await fetchJson(DATA_URL);
  if (meta.formatVersion !== FORMAT_VERSION) {
    throw new Error(`未対応のデータ形式です（formatVersion ${meta.formatVersion}）`);
  }
  const res = await fetch(new URL('./anny-body.bin', DATA_URL));
  if (!res.ok) throw new Error(`体形データを読み込めませんでした（${res.status}）`);
  return new BodyModel(meta, await res.arrayBuffer());
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`体形データを読み込めませんでした（${res.status}）`);
  return res.json();
}

function view(buffer, block, Type) {
  return new Type(buffer, block.offset, block.byteLength / Type.BYTES_PER_ELEMENT);
}

// アンカー列 anchors に対する値 x の補間重み [{index, weight}]（範囲外は端に丸める）
function anchorWeights(anchors, x) {
  const n = anchors.length;
  const v = Math.min(Math.max(x, anchors[0]), anchors[n - 1]);
  let i = 1;
  while (i < n - 1 && v > anchors[i]) i++;
  const t = (v - anchors[i - 1]) / (anchors[i] - anchors[i - 1]);
  return [
    { index: i - 1, weight: 1 - t },
    { index: i, weight: t },
  ].filter((e) => e.weight > 0);
}

// 点列（x, z の組）の凸包の周長。巻き尺で測る周囲長の近似
function hullPerimeter(xs, zs) {
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b] || zs[a] - zs[b]);
  const cross = (o, a, b) => (xs[a] - xs[o]) * (zs[b] - zs[o]) - (zs[a] - zs[o]) * (xs[b] - xs[o]);
  const half = (ids) => {
    const h = [];
    for (const p of ids) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  const hull = [...half(order), ...half([...order].reverse())];
  let len = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    len += Math.hypot(xs[a] - xs[b], zs[a] - zs[b]);
  }
  return len;
}

// 小さな連立一次方程式 A x = b（ガウスの消去法、部分ピボット）
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-15) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

export class BodyModel {
  constructor(meta, buffer) {
    this.vertexCount = meta.vertexCount;
    this.dims = meta.dims;
    this.index = view(buffer, meta.layout.faces, Uint16Array);
    this.mean = view(buffer, meta.layout.mean, Float32Array);
    this.deltas = view(buffer, meta.layout.deltas, Int16Array);
    this.deltaScale = meta.deltaScale;
    this.localDeltas = view(buffer, meta.layout.localDeltas, Int16Array);
    this.localDeltaScale = meta.localDeltaScale;
    this.localNames = meta.localChanges.map((c) => c.name);
    this.girthVertices = meta.measurements;
    this.cornerSize = this.vertexCount * 3;
  }

  // 0 でない重みを持つ角の [{corner, weight}]
  cornerWeights(params) {
    let list = [{ corner: 0, weight: 1 }];
    for (const dim of this.dims) {
      const ws = anchorWeights(dim.anchors, params[dim.name]);
      const next = [];
      for (const { corner, weight } of list) {
        for (const w of ws) next.push({ corner: corner * dim.anchors.length + w.index, weight: weight * w.weight });
      }
      list = next;
    }
    return list;
  }

  // params（{gender, muscle, weight, height} は 0〜1、local は {chest, waist, hip} で -1〜1）の
  // 頂点を out に書き込む
  blend(params, out = new Float32Array(this.cornerSize)) {
    const size = this.cornerSize;
    out.set(this.mean);
    const add = (src, base, w) => {
      for (let j = 0; j < size; j++) out[j] += w * src[base + j];
    };
    for (const { corner, weight } of this.cornerWeights(params)) {
      add(this.deltas, corner * size, weight * this.deltaScale);
    }
    this.localNames.forEach((name, k) => {
      const v = Math.min(Math.max(params.local?.[name] ?? 0, -1), 1);
      if (v === 0) return;
      // 正なら incr、負なら decr の差分を |v| 倍して足す
      add(this.localDeltas, (k * 2 + (v > 0 ? 0 : 1)) * size, Math.abs(v) * this.localDeltaScale);
    });
    return out;
  }

  // 頂点から身長（m）・体重（kg）・足裏の高さ（最小 Y）・周囲長（m）を測る
  measure(pos) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (let j = 1; j < pos.length; j += 3) {
      const y = pos[j];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const idx = this.index;
    let vol6 = 0;
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f] * 3;
      const b = idx[f + 1] * 3;
      const c = idx[f + 2] * 3;
      const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
      const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
      const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
      vol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
    const girths = {};
    for (const name of GIRTHS) {
      const ids = this.girthVertices[name];
      girths[name] = hullPerimeter(ids.map((i) => pos[i * 3]), ids.map((i) => pos[i * 3 + 2]));
    }
    return { height: maxY - minY, mass: (Math.abs(vol6) / 6) * BODY_DENSITY, minY, girths };
  }

  // 身長（m）・体重（kg）と、指定された周囲長（m）に合うパラメータを求める（減衰付きガウス・ニュートン法）。
  // 未知数は Anny の height・weight、muscleRange を渡したときは muscle、
  // fitGirths が真なら周囲長を指定した部位の局所変形。
  // 固定する値は muscle（muscleRange がないとき）と fixedLocal（局所変形）で渡す。
  // start は初期値（前回の解を渡すと反復が少なくて済む）
  fit({ gender, heightM, massKg, girthsM = {}, muscle = 0.5, muscleRange = null, fitGirths = true, fixedLocal = {} }, start) {
    const scratch = this._scratch ?? (this._scratch = new Float32Array(this.cornerSize));
    const targets = fitGirths ? GIRTHS.filter((g) => Number.isFinite(girthsM[g])) : [];
    const freeMuscle = Boolean(muscleRange);
    const localAt = freeMuscle ? 3 : 2;
    // 未知数 x = [height, weight, (muscle), local...] とその範囲
    const lower = [0, 0, ...(freeMuscle ? [muscleRange[0]] : []), ...targets.map(() => -1)];
    const upper = [1, 1, ...(freeMuscle ? [muscleRange[1]] : []), ...targets.map(() => 1)];
    const toParams = (x) => ({
      gender,
      muscle: freeMuscle ? x[2] : muscle,
      height: x[0],
      weight: x[1],
      local: { ...fixedLocal, ...Object.fromEntries(targets.map((g, i) => [g, x[localAt + i]])) },
    });
    // 残差を許容誤差で割って揃える（身長 5mm, 体重 0.5kg, 周囲長 5mm）。
    // 全部は合わせられないときに身長・体重を優先するよう、その2つは重みを大きくする
    const PRIORITY = 10;
    const residuals = (m) => [
      ((m.height - heightM) / 0.005) * PRIORITY,
      ((m.mass - massKg) / 0.5) * PRIORITY,
      ...targets.map((g) => (m.girths[g] - girthsM[g]) / 0.005),
    ];
    const scaleBack = (res) => res.map((v, i) => (i < 2 ? v / PRIORITY : v));
    const evalAt = (x) => this.measure(this.blend(toParams(x), scratch));
    const clampX = (x) => x.map((v, i) => Math.min(Math.max(v, lower[i]), upper[i]));
    const cost = (r) => r.reduce((s, v) => s + v * v, 0);

    let x = clampX([
      start?.height ?? 0.5,
      start?.weight ?? 0.5,
      ...(freeMuscle ? [start?.muscle ?? muscle] : []),
      ...targets.map((g) => start?.local?.[g] ?? 0),
    ]);
    let m = evalAt(x);
    let r = residuals(m);
    let lambda = 1e-3;
    const eps = 1e-3;
    for (let iter = 0; iter < 12; iter++) {
      if (scaleBack(r).every((v) => Math.abs(v) < 0.1)) break;
      // 有限差分のヤコビアン。アンカー上（補間の折れ目）でも両側の傾きが平均されるよう中心差分にする
      const J = r.map(() => []);
      for (let i = 0; i < x.length; i++) {
        const xp = [...x];
        const xm = [...x];
        xp[i] = Math.min(x[i] + eps, upper[i]);
        xm[i] = Math.max(x[i] - eps, lower[i]);
        const rp = residuals(evalAt(xp));
        const rm = residuals(evalAt(xm));
        for (let k = 0; k < r.length; k++) J[k][i] = (rp[k] - rm[k]) / (xp[i] - xm[i]);
      }
      // (JᵀJ + λ diag) Δ = -Jᵀ r
      const n = x.length;
      const JtJ = Array.from({ length: n }, (_, a) =>
        Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)),
      );
      const Jtr = Array.from({ length: n }, (_, a) => J.reduce((s, row, k) => s + row[a] * r[k], 0));
      // 範囲の端にあって外へ出ようとする未知数は固定して解き直す（はみ出しを切り詰めると方向がずれるため）
      const solveFree = (lam) => {
        const free = x.map(() => true);
        for (let pass = 0; pass <= n; pass++) {
          const ids = free.flatMap((f, i) => (f ? [i] : []));
          const A = ids.map((a) => ids.map((b) => (a === b ? JtJ[a][b] * (1 + lam) + 1e-9 : JtJ[a][b])));
          const sub = ids.length ? solve(A, ids.map((a) => -Jtr[a])) : [];
          if (!sub) return null;
          const step = x.map(() => 0);
          ids.forEach((a, k) => (step[a] = sub[k]));
          let changed = false;
          ids.forEach((a) => {
            if ((x[a] <= lower[a] && step[a] < 0) || (x[a] >= upper[a] && step[a] > 0)) {
              free[a] = false;
              changed = true;
            }
          });
          if (!changed) return step;
        }
        return null;
      };
      let improved = false;
      for (let tries = 0; tries < 6; tries++) {
        const step = solveFree(lambda);
        if (!step) break;
        const nx = clampX(x.map((v, i) => v + step[i]));
        const nm = evalAt(nx);
        const nr = residuals(nm);
        if (cost(nr) < cost(r)) {
          const gain = 1 - cost(nr) / cost(r);
          x = nx;
          m = nm;
          r = nr;
          lambda = Math.max(lambda / 3, 1e-6);
          // ほとんど改善しなくなったら（届かない値を追っているとき）打ち切る
          improved = gain > 1e-3;
          break;
        }
        lambda *= 10;
      }
      if (!improved) break; // これ以上近づけない（範囲の端など）
    }
    return { ...toParams(x), measured: m, residuals: scaleBack(r), cost: cost(r) };
  }
}

// 入力（性別・身長 cm・体重 kg・任意の周囲長 cm）から Anny のパラメータを決める。
// Anny の weight は筋肉量が平均のときは効きが小さい（BMI で ±2 程度）ため、
// BMI が性別ごとの標準から離れるほど muscle を下げて、太さの幅を広げる。
// 周囲長を指定したときは muscle も未知数にする。muscle は 0.5 を境に効き方が折れ曲がるので、
// 0〜0.5 と 0.5〜1 の区間ごとに解いて良い方を選ぶ。
// quick が真なら、周囲長の局所変形と muscle を前回の値のまま身長・体重だけ合わせる（スライダー操作中用）
export function createShapeMapper(model) {
  const centerBmi = {};
  for (const [sex, gender] of Object.entries(GENDER)) {
    const r = model.measure(model.blend({ gender, muscle: 0.5, height: 0.3, weight: 0.5 }));
    centerBmi[sex] = r.mass / (r.height * r.height);
  }
  let prev = null;

  return function map({ sex, heightCm, weightKg, girthsCm = {} }, { quick = false } = {}) {
    const gender = GENDER[sex];
    const heightM = heightCm / 100;
    const bmi = weightKg / (heightM * heightM);
    const off = Math.abs(bmi - centerBmi[sex]);
    const defaultMuscle = 0.5 * Math.min(Math.max(1 - (off - 1) / 5, 0), 1);
    const girthsM = {};
    for (const g of GIRTHS) if (Number.isFinite(girthsCm[g])) girthsM[g] = girthsCm[g] / 100;
    const hasGirths = Object.keys(girthsM).length > 0;
    const start = prev && prev.gender === gender ? prev : null;
    const base = { gender, heightM, massKg: weightKg, girthsM };

    let fit;
    if (!hasGirths) {
      fit = model.fit({ ...base, muscle: defaultMuscle }, start);
    } else if (quick && start) {
      const fixedLocal = Object.fromEntries(Object.keys(girthsM).map((g) => [g, start.local?.[g] ?? 0]));
      fit = model.fit({ ...base, muscle: start.muscle, fitGirths: false, fixedLocal }, start);
    } else {
      fit = null;
      for (const range of [[0, 0.5], [0.5, 1]]) {
        const s = { ...start, muscle: Math.min(Math.max(start?.muscle ?? defaultMuscle, range[0]), range[1]) };
        const f = model.fit({ ...base, muscleRange: range }, s);
        if (!fit || f.cost < fit.cost) fit = f;
      }
    }
    prev = fit;
    const params = { gender, muscle: fit.muscle, height: fit.height, weight: fit.weight, local: fit.local };
    // 残差は許容誤差で割ってあるので、1 を超えたら入力値に届いていない（Anny の範囲外）
    const inRange = fit.residuals.every((v) => Math.abs(v) <= 1);
    return { params, measured: fit.measured, inRange };
  };
}

const GENDER = { male: 0, female: 1 };
