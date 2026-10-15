// Anny から書き出した体形データ（data/README.md）を読み込み、
// パラメータに応じて角の頂点と局所変形を重み付き合成する。

const DATA_URL = new URL('./data/anny-body.json', import.meta.url);
const FORMAT_VERSION = 6;

// 体重の換算に使う密度（Anny の anthropometry.py と同じ値）
export const BODY_DENSITY = 980; // kg/m³

// 周囲長の名前（data の measurements / localChanges の name と同じ）
export const GIRTHS = ['chest', 'underbust', 'waist', 'hip', 'upperarm', 'thigh', 'calf', 'ankle'];

// 体形データの共通部分（メタデータと anny-body.bin）を読み込む。形状は loadShapeBuffer で傾向ごとに読む
export async function loadBodyData() {
  const meta = await fetchJson(DATA_URL);
  if (meta.formatVersion !== FORMAT_VERSION) {
    throw new Error(`未対応のデータ形式です（formatVersion ${meta.formatVersion}）`);
  }
  const shared = await fetchBuffer(new URL('./anny-body.bin', DATA_URL));
  return { meta, shared };
}

// 傾向ごとの形状データ。複数の人で同じ傾向を使うときは1回だけ読む
const shapeCache = new Map();
export function loadShapeBuffer(meta, variant) {
  if (!shapeCache.has(variant)) {
    const p = fetchBuffer(new URL(meta.shapes[variant].file, DATA_URL));
    p.catch(() => shapeCache.delete(variant)); // 失敗したら次はやり直す
    shapeCache.set(variant, p);
  }
  return shapeCache.get(variant);
}

// variant: 体格の傾向（data の shapes のキー）。共通データとその傾向の形状を読み込んで BodyModel を作る
export async function loadBodyModel(variant = 'standard', data = null) {
  const { meta, shared } = data ?? (await loadBodyData());
  if (!(variant in meta.shapes)) variant = 'standard';
  const model = new BodyModel(meta, shared);
  model.setShape(variant, await loadShapeBuffer(meta, variant));
  return model;
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`体形データを読み込めませんでした（${res.status}）`);
  return res.arrayBuffer();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`体形データを読み込めませんでした（${res.status}）`);
  return res.json();
}

function view(buffer, block, Type) {
  return new Type(buffer, block.offset, block.byteLength / Type.BYTES_PER_ELEMENT);
}

// 体重（Anny の weight）だけは、アンカーの範囲（0〜1）の外へ延長してよい範囲。
// MakeHuman の「最大体重」でも BMI 30 前後までしか届かないため（Anny に忠実でない拡張）。
// 範囲外の分は、筋肉量によらず「筋肉量が最小のときの体重方向の変形」（脂肪がつく・落ちる方向）を延長する
export const WEIGHT_RANGE = [-0.25, 2];

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

// 疎な差分（動く頂点 index[start..start+count) と、その差分 [符号 +, -][頂点][xyz]）を value 倍して out に足す。
// value が正なら incr、負なら decr の差分を使う
function addSparse(out, index, deltas, start, count, value, scale) {
  const v = Math.min(Math.max(value ?? 0, -1), 1);
  if (v === 0) return;
  const base = (start * 2 + (v > 0 ? 0 : count)) * 3;
  const w = Math.abs(v) * scale;
  for (let i = 0; i < count; i++) {
    const o = index[start + i] * 3;
    const d = base + i * 3;
    out[o] += w * deltas[d];
    out[o + 1] += w * deltas[d + 1];
    out[o + 2] += w * deltas[d + 2];
  }
}

export class BodyModel {
  constructor(meta, buffer) {
    this.vertexCount = meta.vertexCount;
    this.meta = meta;
    this.dims = meta.dims;
    this.index = view(buffer, meta.layout.faces, Uint16Array);
    this.ageAnchors = meta.age.anchors;
    this.yearsToAnny = meta.age.yearsToAnny;
    this.faceFatIndex = view(buffer, meta.layout.faceFatIndex, Uint16Array);
    this.faceFatDeltas = view(buffer, meta.layout.faceFatDeltas, Int16Array);
    this.faceFatScale = meta.faceFat.deltaScale;
    this.localIndex = view(buffer, meta.layout.localIndex, Uint16Array);
    this.localDeltas = view(buffer, meta.layout.localDeltas, Int16Array);
    this.localDeltaScale = meta.localDeltaScale;
    this.localChanges = meta.localChanges; // [{name, start, count}]
    this.girthSections = meta.measurements; // {name: {a, b, t}}
    this.cornerSize = this.vertexCount * 3;
  }

  // 体格の傾向の形状（角の頂点）を差し替える。buffer は loadShapeBuffer で読み込んだもの
  setShape(variant, buffer) {
    const shape = this.meta.shapes[variant];
    this.variant = variant;
    this.mean = view(buffer, shape.layout.mean, Float32Array);
    this.deltas = view(buffer, shape.layout.deltas, Int16Array);
    this.deltaScale = shape.deltaScale;
    this.ageDeltas = view(buffer, shape.layout.ageDeltas, Int8Array);
    this.ageDeltaScale = shape.ageDeltaScale;
  }

  async loadShape(variant) {
    this.setShape(variant, await loadShapeBuffer(this.meta, variant));
  }

  // 0 でない重みを持つ角の [{corner, weight}]
  cornerWeights(params) {
    const weight = params.weight;
    const inside = Math.min(Math.max(weight, 0), 1);
    const list = this.anchorCombination({ ...params, weight: inside });
    if (weight !== inside) {
      // 範囲外の分: 筋肉量 0 の角で、体重の端の区間の差（端 − 中央）を延長量だけ足す
      const edge = weight > 1 ? 1 : 0;
      const k = Math.abs(weight - inside) / 0.5;
      for (const e of this.anchorCombination({ ...params, muscle: 0, weight: edge })) list.push({ ...e, weight: e.weight * k });
      for (const e of this.anchorCombination({ ...params, muscle: 0, weight: 0.5 })) list.push({ ...e, weight: -e.weight * k });
    }
    return list;
  }

  anchorCombination(params) {
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

  // 歳を Anny の age（0〜1）に変換する。Anny の定義（age.yearsToAnny）では 18〜64歳が 0.77〜0.83 に詰まっていて
  // 20〜80歳の差がほとんど出ないので、独自に AGE_YEARS の2つの歳を "young" / "old" のアンカーに当て、間を線形にする
  annyAge(years) {
    const [y0, y1] = AGE_YEARS;
    const [a0, a1] = this.ageAnchors;
    const t = Math.min(Math.max((years - y0) / (y1 - y0), 0), 1);
    return a0 + t * (a1 - a0);
  }

  // params の頂点を out に書き込む。
  // gender, muscle, weight, height は 0〜1、age は Anny の age（annyAge で変換した値）、
  // local は {chest, waist, hip} で -1〜1、faceFat は顔の肉付き -1〜1
  blend(params, out = new Float32Array(this.cornerSize)) {
    const size = this.cornerSize;
    out.set(this.mean);
    const add = (src, base, w) => {
      for (let j = 0; j < size; j++) out[j] += w * src[base + j];
    };
    const [a0, a1] = this.ageAnchors;
    const t = Math.min(Math.max(((params.age ?? a0) - a0) / (a1 - a0), 0), 1);
    for (const { corner, weight } of this.cornerWeights(params)) {
      add(this.deltas, corner * size, weight * this.deltaScale);
      // 年齢: "old" の角との差を t の割合で足す
      if (t > 0) add(this.ageDeltas, corner * size, weight * t * this.ageDeltaScale);
    }
    addSparse(out, this.faceFatIndex, this.faceFatDeltas, 0, this.faceFatIndex.length, params.faceFat, this.faceFatScale);
    for (const { name } of this.localChanges) this.addLocal(out, name, params.local?.[name]);
    return out;
  }

  // 局所変形 name を値 value（-1〜1）で out に足す（sign = -1 なら引く）
  addLocal(out, name, value, sign = 1) {
    const c = this.localChanges.find((l) => l.name === name);
    addSparse(out, this.localIndex, this.localDeltas, c.start, c.count, value, this.localDeltaScale * sign);
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
      // 断面: 基準体形で水平面と交わった辺 (a, b) を内分比 t で分けた点
      const { a, b, t } = this.girthSections[name];
      const xs = a.map((ai, k) => pos[ai * 3] + t[k] * (pos[b[k] * 3] - pos[ai * 3]));
      const zs = a.map((ai, k) => pos[ai * 3 + 2] + t[k] * (pos[b[k] * 3 + 2] - pos[ai * 3 + 2]));
      girths[name] = hullPerimeter(xs, zs);
    }
    return { height: maxY - minY, mass: (Math.abs(vol6) / 6) * BODY_DENSITY, minY, girths };
  }

  // 身長（m）・体重（kg）と、指定された周囲長（m）に合うパラメータを求める（減衰付きガウス・ニュートン法）。
  // 未知数は Anny の height・weight、muscleRange を渡したときは muscle、
  // fitGirths が真なら周囲長を指定した部位の局所変形。
  // 固定する値は muscle（muscleRange がないとき）と fixedLocal（局所変形）で渡す。
  // start は初期値（前回の解を渡すと反復が少なくて済む）
  fit(
    { gender, age, faceFat = 0, heightM, massKg, girthsM = {}, muscle = 0.5, muscleRange = null, fitGirths = true, fixedLocal = {} },
    start,
  ) {
    const scratch = this._scratch ?? (this._scratch = new Float32Array(this.cornerSize));
    const baseScratch = this._baseScratch ?? (this._baseScratch = new Float32Array(this.cornerSize));
    const work = this._work ?? (this._work = new Float32Array(this.cornerSize));
    const targets = fitGirths ? GIRTHS.filter((g) => Number.isFinite(girthsM[g])) : [];
    const freeMuscle = Boolean(muscleRange);
    const localAt = freeMuscle ? 3 : 2;
    // 未知数 x = [height, weight, (muscle), local...] とその範囲
    const lower = [0, WEIGHT_RANGE[0], ...(freeMuscle ? [muscleRange[0]] : []), ...targets.map(() => -1)];
    const upper = [1, WEIGHT_RANGE[1], ...(freeMuscle ? [muscleRange[1]] : []), ...targets.map(() => 1)];
    const toParams = (x) => ({
      gender,
      age,
      faceFat,
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
      // 有限差分のヤコビアン。アンカー上（補間の折れ目）でも両側の傾きが平均されるよう中心差分にする。
      // 局所変形の列は、今の頂点に疎な差分を足し引きするだけで求める（全頂点を合成し直さない）
      const J = r.map(() => []);
      const basePos = this.blend(toParams(x), baseScratch);
      for (let i = 0; i < x.length; i++) {
        const lo = Math.max(x[i] - eps, lower[i]);
        const hi = Math.min(x[i] + eps, upper[i]);
        let rp;
        let rm;
        if (i >= localAt) {
          const name = targets[i - localAt];
          const at = (v) => {
            work.set(basePos);
            this.addLocal(work, name, x[i], -1);
            this.addLocal(work, name, v);
            return residuals(this.measure(work));
          };
          rp = at(hi);
          rm = at(lo);
        } else {
          const xp = [...x];
          const xm = [...x];
          xp[i] = hi;
          xm[i] = lo;
          rp = residuals(evalAt(xp));
          rm = residuals(evalAt(xm));
        }
        for (let k = 0; k < r.length; k++) J[k][i] = (rp[k] - rm[k]) / (hi - lo);
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

// 入力（性別・年齢・身長 cm・体重 kg・任意の筋肉量と周囲長 cm）から Anny のパラメータを決める。
// 筋肉量（0〜1）を指定しないときは平均（0.5）にする。
// 筋肉量を指定せずに周囲長を指定したときは muscle も未知数にする。muscle は 0.5 を境に効き方が折れ曲がるので、
// 0〜0.5 と 0.5〜1 の区間ごとに解いて良い方を選ぶ。
// 顔の肉付きは BMI に連動させる（Anny の weight は頭の形をほとんど変えないため）。
// quick が真なら、周囲長の局所変形と muscle を前回の値のまま身長・体重だけ合わせる（スライダー操作中用）
export const DEFAULT_AGE = 30;
// 年齢のアンカー（"young", "old"）に当てる歳（data/README.md の「年齢」）
export const AGE_YEARS = [25, 90];

export function createShapeMapper(model) {
  const centerBmi = {};
  for (const [sex, gender] of Object.entries(GENDER)) {
    const age = model.annyAge(DEFAULT_AGE);
    const r = model.measure(model.blend({ gender, age, muscle: 0.5, height: 0.3, weight: 0.5 }));
    centerBmi[sex] = r.mass / (r.height * r.height);
  }
  let prev = null;

  return function map({ sex, ageYears = DEFAULT_AGE, heightCm, weightKg, muscle = null, girthsCm = {} }, { quick = false } = {}) {
    const gender = GENDER[sex];
    const age = model.annyAge(ageYears);
    const heightM = heightCm / 100;
    const bmi = weightKg / (heightM * heightM);
    const diff = bmi - centerBmi[sex];
    // 筋肉量を指定しないときは平均（0.5）。体重の範囲は書き出しの補正と外挿で確保している
    const autoMuscle = 0.5;
    const faceFat = Math.min(Math.max(diff / 10, -0.6), 1);
    const girthsM = {};
    for (const g of GIRTHS) if (Number.isFinite(girthsCm[g])) girthsM[g] = girthsCm[g] / 100;
    const hasGirths = Object.keys(girthsM).length > 0;
    const manualMuscle = Number.isFinite(muscle);
    const start = prev && prev.gender === gender ? prev : null;
    const base = { gender, age, faceFat, heightM, massKg: weightKg, girthsM };

    let fit;
    if (manualMuscle) {
      if (quick && start && hasGirths) {
        const fixedLocal = Object.fromEntries(Object.keys(girthsM).map((g) => [g, start.local?.[g] ?? 0]));
        fit = model.fit({ ...base, muscle, fitGirths: false, fixedLocal }, start);
      } else {
        fit = model.fit({ ...base, muscle }, start);
      }
    } else if (!hasGirths) {
      fit = model.fit({ ...base, muscle: autoMuscle }, start);
    } else if (quick && start) {
      const fixedLocal = Object.fromEntries(Object.keys(girthsM).map((g) => [g, start.local?.[g] ?? 0]));
      fit = model.fit({ ...base, muscle: start.muscle, fitGirths: false, fixedLocal }, start);
    } else {
      fit = null;
      for (const range of [[0, 0.5], [0.5, 1]]) {
        const s = { ...start, muscle: Math.min(Math.max(start?.muscle ?? autoMuscle, range[0]), range[1]) };
        const f = model.fit({ ...base, muscleRange: range }, s);
        if (!fit || f.cost < fit.cost) fit = f;
      }
    }
    prev = fit;
    const { measured, residuals, cost, ...params } = fit;
    // 残差は許容誤差で割ってあるので、1 を超えたら入力値に届いていない（Anny の範囲外）
    const inRange = residuals.every((v) => Math.abs(v) <= 1);
    return { params, measured, inRange };
  };
}

const GENDER = { male: 0, female: 1 };
