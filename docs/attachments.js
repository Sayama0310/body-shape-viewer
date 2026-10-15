// 体に追従するアセット（服・髪）。data/assets/README.md の形式を読み込み、
// 合成した体の頂点からアセットの頂点を計算する:
//   頂点 = p0 + u (p1 - p0) + v (p2 - p0) + ox t + oy b + oz n
// （p0, p1, p2 はバインド先の体の三角形、t, b, n はその接線・従法線・法線）

import * as THREE from 'three';

const BASE_URL = new URL('./data/assets/', import.meta.url);
const FORMAT_VERSION = 1;

export async function loadAssetCatalog() {
  const res = await fetch(new URL('index.json', BASE_URL));
  if (!res.ok) throw new Error(`アセットの一覧を読み込めませんでした（${res.status}）`);
  const catalog = await res.json();
  if (catalog.formatVersion !== FORMAT_VERSION) throw new Error('未対応のアセット形式です');
  return catalog.assets;
}

function view(buffer, block, Type) {
  return new Type(buffer, block.offset, block.byteLength / Type.BYTES_PER_ELEMENT);
}

export class Attachment {
  // 読み込んだデータ（バインドとテクスチャ）は人ごとのメッシュで共有できるので、読み込みとメッシュ作りを分ける
  static async loadData(info) {
    const res = await fetch(new URL(info.file, BASE_URL));
    if (!res.ok) throw new Error(`${info.label} を読み込めませんでした（${res.status}）`);
    const buffer = await res.arrayBuffer();
    const texture = info.texture ? await new THREE.TextureLoader().loadAsync(new URL(info.texture, BASE_URL).href) : null;
    if (texture) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = true;
      texture.anisotropy = 4;
    }
    return { info, buffer, texture };
  }

  static fromLoaded({ info, buffer, texture }) {
    return new Attachment(info, buffer, texture);
  }

  static async load(info) {
    return Attachment.fromLoaded(await Attachment.loadData(info));
  }

  constructor(info, buffer, texture) {
    this.info = info;
    this.bind = view(buffer, info.layout.bind, Uint16Array);
    this.bary = view(buffer, info.layout.bary, Float32Array);
    this.offset = view(buffer, info.layout.offset, Float32Array);
    this.hiddenFaces = view(buffer, info.layout.hiddenFaces, Uint16Array);

    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(info.vertexCount * 3), 3);
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('uv', new THREE.BufferAttribute(view(buffer, info.layout.uv, Float32Array), 2));
    geometry.setIndex(new THREE.BufferAttribute(view(buffer, info.layout.index, Uint16Array), 1));

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.85,
      side: THREE.DoubleSide, // 袖口・裾から内側が見えても抜けないように
      alphaTest: 0.5, // 透過部分は切り抜き（半透明の並べ替えをしない）
      // 体と重なる部分で服を手前に。上の服は下の服（ジーンズの腰など）よりさらに手前にする
      polygonOffset: true,
      polygonOffsetFactor: info.slot === 'top' ? -4 : -1,
      polygonOffsetUnits: info.slot === 'top' ? -4 : -1,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = true;
    this.neighbors = neighborLists(geometry.index.array, weldGroups(this.bind, this.bary, this.offset, info.vertexCount));
    this.smoothed = new Float32Array(info.vertexCount * 3);
  }

  // body: 合成した体の頂点（Float32Array, xyz）
  update(body) {
    const out = this.positions.array;
    const { bind, bary, offset } = this;
    const n = this.info.vertexCount;
    for (let i = 0; i < n; i++) {
      const a = bind[i * 3] * 3;
      const b = bind[i * 3 + 1] * 3;
      const c = bind[i * 3 + 2] * 3;
      const e1x = body[b] - body[a], e1y = body[b + 1] - body[a + 1], e1z = body[b + 2] - body[a + 2];
      const e2x = body[c] - body[a], e2y = body[c + 1] - body[a + 1], e2z = body[c + 2] - body[a + 2];
      // 法線 n = e1 × e2、接線 t = e1、従法線 b = n × t（いずれも正規化）
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const tl = Math.hypot(e1x, e1y, e1z) || 1;
      const tx = e1x / tl, ty = e1y / tl, tz = e1z / tl;
      const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      const u = bary[i * 2];
      const v = bary[i * 2 + 1];
      const ox = offset[i * 3], oy = offset[i * 3 + 1], oz = offset[i * 3 + 2];
      out[i * 3] = body[a] + u * e1x + v * e2x + ox * tx + oy * bx + oz * nx;
      out[i * 3 + 1] = body[a + 1] + u * e1y + v * e2y + ox * ty + oy * by + oz * ny;
      out[i * 3 + 2] = body[a + 2] + u * e1z + v * e2z + ox * tz + oy * bz + oz * nz;
    }
    // 体のしわ・折れ込み（太った体形の胸の下など）をそのままなぞると布が段になったり、
    // 三角形が伸びて糸のようになったりするので、少しならす
    smooth(out, this.neighbors, this.smoothed, SMOOTH_ITERATIONS, SMOOTH_FACTOR);
    this.positions.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
  }
}

const SMOOTH_ITERATIONS = 2;
const SMOOTH_FACTOR = 0.5;

// UV の継ぎ目などで同じ位置に重なっている頂点（バインドが同じもの）をまとめる。返り値は頂点ごとのまとまりの番号
function weldGroups(bind, bary, offset, vertexCount) {
  const groups = new Uint32Array(vertexCount);
  const seen = new Map();
  for (let i = 0; i < vertexCount; i++) {
    const key = [
      bind[i * 3], bind[i * 3 + 1], bind[i * 3 + 2],
      ...[bary[i * 2], bary[i * 2 + 1], offset[i * 3], offset[i * 3 + 1], offset[i * 3 + 2]].map((v) => v.toFixed(5)),
    ].join(',');
    if (!seen.has(key)) seen.set(key, seen.size);
    groups[i] = seen.get(key);
  }
  return groups;
}

// まとまりごとの隣のまとまり（三角形の辺でつながるもの）と、まとまりに属する頂点。
// start[g]〜start[g+1] が まとまり g の隣、members の memberStart[g]〜memberStart[g+1] がその頂点
function neighborLists(index, groups) {
  const count = Math.max(...groups) + 1;
  const sets = Array.from({ length: count }, () => new Set());
  for (let f = 0; f < index.length; f += 3) {
    const a = groups[index[f]], b = groups[index[f + 1]], c = groups[index[f + 2]];
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      if (x === y) continue;
      sets[x].add(y);
      sets[y].add(x);
    }
  }
  const start = new Uint32Array(count + 1);
  for (let g = 0; g < count; g++) start[g + 1] = start[g] + sets[g].size;
  const list = new Uint32Array(start[count]);
  sets.forEach((set, g) => list.set([...set], start[g]));
  const memberStart = new Uint32Array(count + 1);
  for (const g of groups) memberStart[g + 1]++;
  for (let g = 0; g < count; g++) memberStart[g + 1] += memberStart[g];
  const members = new Uint32Array(groups.length);
  const fill = memberStart.slice(0, count);
  groups.forEach((g, i) => (members[fill[g]++] = i));
  return { start, list, memberStart, members };
}

// ラプラシアン平滑化: 各まとまりを隣のまとまりの平均へ factor だけ寄せる（iterations 回）。
// まとまりの位置は代表の頂点（最初の頂点）で持ち、最後に同じまとまりの頂点へ写す
function smooth(pos, { start, list, memberStart, members }, tmp, iterations, factor) {
  const count = start.length - 1;
  const rep = (g) => members[memberStart[g]] * 3;
  for (let it = 0; it < iterations; it++) {
    tmp.set(pos);
    for (let g = 0; g < count; g++) {
      const s = start[g], e = start[g + 1];
      if (e === s) continue;
      let x = 0, y = 0, z = 0;
      for (let k = s; k < e; k++) {
        const j = rep(list[k]);
        x += tmp[j]; y += tmp[j + 1]; z += tmp[j + 2];
      }
      const inv = 1 / (e - s);
      const i = rep(g);
      pos[i] += factor * (x * inv - tmp[i]);
      pos[i + 1] += factor * (y * inv - tmp[i + 1]);
      pos[i + 2] += factor * (z * inv - tmp[i + 2]);
    }
  }
  for (let g = 0; g < count; g++) {
    const i = rep(g);
    for (let k = memberStart[g] + 1; k < memberStart[g + 1]; k++) {
      const j = members[k] * 3;
      pos[j] = pos[i]; pos[j + 1] = pos[i + 1]; pos[j + 2] = pos[i + 2];
    }
  }
}

// 体の三角形のうち、着ているアセットが隠すものを除いた index を作る
export function visibleBodyIndex(fullIndex, attachments) {
  const hidden = new Set();
  for (const a of attachments) for (const f of a.hiddenFaces) hidden.add(f);
  if (hidden.size === 0) return fullIndex;
  const out = new Uint16Array(fullIndex.length - hidden.size * 3);
  let k = 0;
  for (let f = 0; f < fullIndex.length / 3; f++) {
    if (hidden.has(f)) continue;
    out[k++] = fullIndex[f * 3];
    out[k++] = fullIndex[f * 3 + 1];
    out[k++] = fullIndex[f * 3 + 2];
  }
  return out;
}
