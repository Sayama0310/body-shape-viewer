// Anny から書き出した体形データ（data/README.md）を読み込み、
// パラメータに応じて角の頂点を重み付き合成する。

const DATA_URL = new URL('./data/anny-body.json', import.meta.url);
const FORMAT_VERSION = 1;

// 体重の換算に使う密度（Anny の anthropometry.py と同じ値）
export const BODY_DENSITY = 980; // kg/m³

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

export class BodyModel {
  constructor(meta, buffer) {
    this.vertexCount = meta.vertexCount;
    this.dims = meta.dims;
    this.index = view(buffer, meta.layout.faces, Uint16Array);
    this.mean = view(buffer, meta.layout.mean, Float32Array);
    this.deltas = view(buffer, meta.layout.deltas, Int16Array);
    this.deltaScale = meta.deltaScale;
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

  // params（{gender, muscle, weight, height}, 各 0〜1）の頂点を out に書き込む
  blend(params, out = new Float32Array(this.cornerSize)) {
    const size = this.cornerSize;
    const { mean, deltas } = this;
    out.set(mean);
    for (const { corner, weight } of this.cornerWeights(params)) {
      const w = weight * this.deltaScale;
      const base = corner * size;
      for (let j = 0; j < size; j++) out[j] += w * deltas[base + j];
    }
    return out;
  }

  // 頂点から身長（m）・体重（kg）・足裏の高さ（最小 Y）を測る
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
    return { height: maxY - minY, mass: (Math.abs(vol6) / 6) * BODY_DENSITY, minY };
  }

  // 身長（m）・体重（kg）に合う Anny の height / weight を求める。
  // start は前回の解（あれば反復が少なくて済む）
  fit({ gender, muscle, heightM, massKg }, start) {
    const scratch = this._scratch ?? (this._scratch = new Float32Array(this.cornerSize));
    const evalAt = (h, w) => this.measure(this.blend({ gender, muscle, height: h, weight: w }, scratch));
    const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

    let h = start?.height ?? 0.5;
    let w = start?.weight ?? 0.5;
    const eps = 1e-3;
    for (let iter = 0; iter < 12; iter++) {
      const m0 = evalAt(h, w);
      const rH = m0.height - heightM;
      const rM = m0.mass - massKg;
      if (Math.abs(rH) < 5e-4 && Math.abs(rM) < 0.05) break;
      // 有限差分のヤコビアン（境界では内側へ差分を取る）
      const dh = h + eps > 1 ? -eps : eps;
      const dw = w + eps > 1 ? -eps : eps;
      const mh = evalAt(h + dh, w);
      const mw = evalAt(h, w + dw);
      const a = (mh.height - m0.height) / dh;
      const b = (mw.height - m0.height) / dw;
      const c = (mh.mass - m0.mass) / dh;
      const d = (mw.mass - m0.mass) / dw;
      const det = a * d - b * c;
      if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
      const stepH = (d * rH - b * rM) / det;
      const stepW = (a * rM - c * rH) / det;
      const nh = clamp01(h - stepH);
      const nw = clamp01(w - stepW);
      if (Math.abs(nh - h) < 1e-6 && Math.abs(nw - w) < 1e-6) break; // 境界に張り付いた
      h = nh;
      w = nw;
    }
    const m = evalAt(h, w);
    return { height: h, weight: w, measured: { height: m.height, mass: m.mass } };
  }
}

// 入力（性別・身長 cm・体重 kg）から Anny のパラメータを決める。
// Anny の weight は筋肉量が平均のときは効きが小さい（BMI で ±2 程度）ため、
// BMI が性別ごとの標準から離れるほど muscle を下げて、太さの幅を広げる。
export function createShapeMapper(model) {
  const centerBmi = {};
  for (const [sex, gender] of Object.entries(GENDER)) {
    const r = model.measure(model.blend({ gender, muscle: 0.5, height: 0.3, weight: 0.5 }));
    centerBmi[sex] = r.mass / (r.height * r.height);
  }
  let prev = null;

  return function map({ sex, heightCm, weightKg }) {
    const gender = GENDER[sex];
    const heightM = heightCm / 100;
    const bmi = weightKg / (heightM * heightM);
    const off = Math.abs(bmi - centerBmi[sex]);
    const muscle = 0.5 * Math.min(Math.max(1 - (off - 1) / 5, 0), 1);
    const start = prev && prev.gender === gender ? prev : null;
    const fit = model.fit({ gender, muscle, heightM, massKg: weightKg }, start);
    prev = { gender, ...fit };
    const params = { gender, muscle, height: fit.height, weight: fit.weight };
    // 表示用の誤差（Anny の範囲外だと入力値に届かない）
    const inRange = Math.abs(fit.measured.height - heightM) < 0.005 && Math.abs(fit.measured.mass - weightKg) < 0.5;
    return { params, measured: fit.measured, inRange };
  };
}

const GENDER = { male: 0, female: 1 };
