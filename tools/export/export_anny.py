"""Anny から体形データを書き出す。

性別・筋肉量・体重・身長の各アンカー（角）の組み合わせごとに、年齢の2つのアンカー
（"young" と "old"）で腕を下ろした姿勢の頂点を計算して docs/data/ に書き出す。
Anny の形状はアンカー間の多重線形補間なので、JS 側では角の頂点を重み付き合成すれば
任意のパラメータの体形が得られる。
あわせて、周囲長（胸囲・ウエスト・ヒップ）を調整する局所変形の差分、
周囲長を測るための頂点の集合、顔の肉付きの差分も書き出す。形式は docs/data/README.md を参照。

使い方:
    pip install -r tools/export/requirements.txt
    python tools/export/export_anny.py
"""

import argparse
import itertools
import json
import math
from pathlib import Path

import numpy as np
import roma
import torch

import anny
from anny.anthropometry import BASE_MESH_WAIST_VERTICES

FORMAT_VERSION = 3

# 書き出す次元とアンカー値（Anny のフェノタイプ値, 0〜1）。順序がバイナリ内の角の並び順になる
DIMS = {
    "gender": [0.0, 1.0],  # male, female
    "muscle": [0.0, 0.5, 1.0],  # min, average, max
    "weight": [0.0, 0.5, 1.0],  # min, average, max
    "height": [0.0, 1.0],  # min, max
}
# 年齢のアンカー（Anny の age）。"young"（16歳相当）と "old"（110歳相当）で 20〜80歳をカバーする
AGE_ANCHORS = [2 / 3, 1.0]
# 固定するフェノタイプ
FIXED = {
    "proportions": 0.5,
}
# 局所変形・計測頂点を決める基準の年齢（歳）
REFERENCE_AGE_YEARS = 30
# Anny の静止姿勢（A ポーズ、肘が前に曲がる）から気をつけに近い姿勢へ回す角度（度）。
# 回転ベクトルは Anny の座標系（X 左右, Y 前後, Z 上下）で、左側（.L）の値。右側は X 以外の符号を反転する
POSE_DEG = {
    "upperarm01": (0.0, 32.0, 0.0),  # 腕を下ろす（太い体形で胴にめり込まない程度）
    "lowerarm01": (40.0, -8.0, 0.0),  # 肘を伸ばす
    "upperleg01": (0.0, 4.0, 0.0),  # 足を閉じる
}

# 周囲長を調整する Anny の局所変形（値 -1〜1。正で incr、負で decr のターゲットが効く）
LOCAL_CHANGES = {
    "chest": "measure-bust-circ-incr",
    "waist": "measure-waist-circ-incr",
    "hip": "measure-hips-circ-incr",
}
# 顔の肉付き（頭・頬・二重あご）。値 +1 / -1 のときに足す Anny の局所変形とその量
FACE_FAT = {
    1.0: {"head-fat-incr": 1.0, "l-cheek-volume-incr": 0.6, "r-cheek-volume-incr": 0.6, "neck-double-incr": 0.6},
    -1.0: {"head-fat-incr": -1.0, "l-cheek-volume-incr": -0.5, "r-cheek-volume-incr": -0.5},
}
# 疎な差分に含める頂点のしきい値（m）
SPARSE_EPS = 5e-5
# 局所変形の差分・計測頂点を取る基準の体形（平均的な成人, 身長 約170cm。年齢は REFERENCE_AGE_YEARS）
REFERENCE_SHAPE = {**FIXED, "gender": 0.5, "muscle": 0.5, "weight": 0.5, "height": 0.3}
# 周囲長を測る帯の半幅（m）
BAND = 0.008
# 腕・手のボーン（周囲長の計測から外す）
ARM_BONE_KEYWORDS = ("upperarm", "lowerarm", "wrist", "finger", "thumb", "metacarpal", "hand")


def age_mapping():
    """Anny の年齢（歳 ↔ age）の対応。Anny の shape_calibration に含まれる定義を使う。"""
    path = Path(anny.__file__).parent / "data" / "shape_calibration" / "boys.pth"
    mapping = torch.load(path, weights_only=True, map_location="cpu")["morphological_age_mapping"]
    return {"years": mapping["morphological_age_anchors"].tolist(), "anny": mapping["anny_age_anchors"].tolist()}


def years_to_anny_age(years, mapping):
    return float(np.interp(years, mapping["years"], mapping["anny"]))


def build_pose(model):
    pose = torch.eye(4, dtype=torch.float64)[None, None].repeat(1, model.bone_count, 1, 1)
    for bone, (x, y, z) in POSE_DEG.items():
        for side, sign in ((".L", 1.0), (".R", -1.0)):
            rotvec = torch.tensor([math.radians(x), sign * math.radians(y), sign * math.radians(z)], dtype=torch.float64)
            pose[0, model.bone_labels.index(bone + side), :3, :3] = roma.rotvec_to_rotmat(rotvec)
    return pose


def to_three(vertices):
    """Anny（Z 上, -Y 前）を three.js（Y 上, +Z 前）の座標系に変換する。"""
    x, y, z = vertices[:, 0], vertices[:, 1], vertices[:, 2]
    return np.stack([x, z, -y], axis=1)


def hull_perimeter(points):
    """XZ 平面に投影した点の凸包の周長（巻き尺で測る周囲長の近似）。JS 側と同じ計算。"""
    pts = sorted(set(map(tuple, np.round(points[:, [0, 2]], 6))))
    if len(pts) < 3:
        return 0.0

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = np.array(lower[:-1] + upper[:-1])
    return float(np.linalg.norm(hull - np.roll(hull, 1, axis=0), axis=1).sum())


def measurement_vertices(model, vertices_for):
    """周囲長を測る頂点の番号を、基準の体形の上で選ぶ（番号はどの体形でも同じ部位を指す）。"""
    weights = model.vertex_bone_weights.numpy()
    bones = model.vertex_bone_indices.numpy()
    dominant = bones[np.arange(len(bones)), weights.argmax(axis=1)]
    arm_bones = [i for i, b in enumerate(model.bone_labels) if any(k in b for k in ARM_BONE_KEYWORDS)]
    body = ~np.isin(dominant, arm_bones)

    def band(v, y):
        return np.flatnonzero(body & (np.abs(v[:, 1] - y) < BAND))

    # 胸囲: 女性の基準体形でバストの頂点（胴の最も前に出た点）の高さ
    female = vertices_for({**REFERENCE_SHAPE, "gender": 1.0})
    foot, top = female[:, 1].min(), female[:, 1].max()
    height = top - foot
    region = body & (female[:, 1] > foot + 0.62 * height) & (female[:, 1] < foot + 0.80 * height)
    chest_y = female[np.flatnonzero(region)[female[region, 2].argmax()], 1]
    chest = band(female, chest_y)

    # ウエスト: Anny の anthropometry.py が使うウエストのループ
    base = model.base_mesh_vertex_indices.numpy().tolist()
    waist = np.array([base.index(i) for i in BASE_MESH_WAIST_VERTICES])

    # ヒップ: 基準体形で周囲長が最大になる高さ
    ref = vertices_for(REFERENCE_SHAPE)
    foot, top = ref[:, 1].min(), ref[:, 1].max()
    height = top - foot
    levels = np.arange(foot + 0.42 * height, foot + 0.58 * height, 0.005)
    hip_y = max(levels, key=lambda y: hull_perimeter(ref[band(ref, y)]))
    hip = band(ref, hip_y)

    return {"chest": chest, "waist": waist, "hip": hip}


def interpolate(corners, values):
    """角の頂点を多重線形補間する（JS 側と同じ計算）。values は DIMS の順の値。"""
    per_dim = []
    for anchors, x in zip(DIMS.values(), values):
        a = np.asarray(anchors)
        i = int(np.clip(np.searchsorted(a, x), 1, len(a) - 1))
        t = (x - a[i - 1]) / (a[i] - a[i - 1])
        w = np.zeros(len(a))
        w[i - 1], w[i] = 1 - t, t
        per_dim.append(w)
    result = np.zeros(corners.shape[1:])
    for c, idx in enumerate(itertools.product(*[range(len(a)) for a in DIMS.values()])):
        w = np.prod([per_dim[d][k] for d, k in enumerate(idx)])
        if w:
            result += w * corners[c]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "docs" / "data")
    parser.add_argument("--verify", type=int, default=8, help="補間と Anny の出力を比べるランダム標本数")
    args = parser.parse_args()

    torch.set_grad_enabled(False)
    # 既定の anny トポロジ・リグに、使う局所変形だけを加える
    face_labels = sorted({label for parts in FACE_FAT.values() for label in parts})
    model = anny.Anny(local_changes=list(LOCAL_CHANGES.values()) + face_labels).to(dtype=torch.float64)
    pose = build_pose(model)
    ages = age_mapping()
    reference_phenotypes = {
        **FIXED, "age": years_to_anny_age(REFERENCE_AGE_YEARS, ages),
        "gender": 0.5, "muscle": 0.5, "weight": 0.5, "height": 0.3,
    }

    def vertices_for(phenotypes, local_changes=None):
        kwargs = {k: torch.tensor([v], dtype=torch.float64) for k, v in phenotypes.items()}
        local = {k: torch.tensor([v], dtype=torch.float64) for k, v in (local_changes or {}).items()}
        out = model(pose_parameters=pose, phenotype_kwargs=kwargs, local_changes_kwargs=local)
        return to_three(out["vertices"][0].numpy())

    combos = list(itertools.product(*DIMS.values()))
    corners_by_age = [
        np.stack([vertices_for({**FIXED, "age": age, **dict(zip(DIMS, c))}) for c in combos]) for age in AGE_ANCHORS
    ]
    corners = corners_by_age[0]

    # 三角形の向きは座標変換（右手系のまま）で変わらない
    faces = model.faces.numpy()
    vertex_count = corners.shape[1]
    if vertex_count > 65535:
        raise ValueError("頂点数が Uint16 の範囲を超えています")

    mean = corners.mean(axis=0)
    deltas = corners - mean
    scale = float(np.abs(deltas).max()) / 32767
    quantized = np.round(deltas / scale).astype("<i2")
    quant_error = float(np.abs(quantized * scale - deltas).max())

    # 年齢: "old" の角と "young" の角の差。差が小さい（最大 7cm 程度）ので 8bit にする
    age_deltas = corners_by_age[1] - corners_by_age[0]
    age_scale = float(np.abs(age_deltas).max()) / 127
    age_quantized = np.round(age_deltas / age_scale).astype("i1")
    age_quant_error = float(np.abs(age_quantized * age_scale - age_deltas).max())

    # 局所変形の差分（基準体形で +1 / -1 にしたときの変化）。並びは [変形][符号 +, -][頂点][xyz]
    reference = vertices_for(reference_phenotypes)
    local = np.stack([
        np.stack([vertices_for(reference_phenotypes, {label: sign}) - reference for sign in (1.0, -1.0)])
        for label in LOCAL_CHANGES.values()
    ])
    local_scale = float(np.abs(local).max()) / 32767
    local_quantized = np.round(local / local_scale).astype("<i2")

    # 顔の肉付き: 動く頂点（頭部）だけの疎な差分。並びは [符号 +, -][頂点][xyz]
    face = np.stack([vertices_for(reference_phenotypes, FACE_FAT[sign]) - reference for sign in (1.0, -1.0)])
    face_index = np.flatnonzero(np.abs(face).max(axis=(0, 2)) > SPARSE_EPS)
    face = face[:, face_index]
    face_scale = float(np.abs(face).max()) / 32767
    face_quantized = np.round(face / face_scale).astype("<i2")

    measurements = measurement_vertices(model, lambda ph: vertices_for({**ph, "age": reference_phenotypes["age"]}))

    args.out.mkdir(parents=True, exist_ok=True)
    blobs = [
        ("faces", faces.astype("<u2")),
        ("mean", mean.astype("<f4")),
        ("deltas", quantized),
        ("ageDeltas", age_quantized),
        ("localDeltas", local_quantized),
        ("faceFatIndex", face_index.astype("<u2")),
        ("faceFatDeltas", face_quantized),
    ]
    layout, offset, chunks = {}, 0, []
    for name, arr in blobs:
        data = arr.tobytes()
        layout[name] = {"offset": offset, "byteLength": len(data), "type": arr.dtype.name, "shape": list(arr.shape)}
        chunks.append(data)
        offset += len(data)
        offset += (-offset) % 4  # 次のブロックを 4 バイト境界に揃える
        chunks.append(b"\0" * ((-len(data)) % 4))
    (args.out / "anny-body.bin").write_bytes(b"".join(chunks))

    meta = {
        "formatVersion": FORMAT_VERSION,
        "source": f"anny {anny.__version__} (topology=anny, rig=anny)",
        "vertexCount": int(vertex_count),
        "faceCount": int(faces.shape[0]),
        "dims": [{"name": k, "anchors": v} for k, v in DIMS.items()],
        "age": {"anchors": AGE_ANCHORS, "deltaScale": age_scale, "yearsToAnny": ages},
        "fixed": FIXED,
        "poseDeg": POSE_DEG,
        "deltaScale": scale,
        "localChanges": [
            {"name": name, "annyLabel": label, "range": [-1, 1]} for name, label in LOCAL_CHANGES.items()
        ],
        "localDeltaScale": local_scale,
        "faceFat": {"annyLabels": {str(int(k)): v for k, v in FACE_FAT.items()}, "deltaScale": face_scale},
        "measurements": {name: idx.tolist() for name, idx in measurements.items()},
        "layout": layout,
    }
    (args.out / "anny-body.json").write_text(json.dumps(meta, indent=2) + "\n")

    print(f"corners: {len(combos)}, vertices: {vertex_count}, faces: {faces.shape[0]}")
    print(f"bin size: {offset / 1e6:.2f} MB, quantization error: {quant_error * 1000:.3f} mm, age {age_quant_error * 1000:.3f} mm")
    print(f"face fat: {len(face_index)} vertices")

    for name, idx in measurements.items():
        base_c = hull_perimeter(reference[idx])
        k = list(LOCAL_CHANGES).index(name)
        lo = hull_perimeter((reference + local[k, 1])[idx])
        hi = hull_perimeter((reference + local[k, 0])[idx])
        print(f"{name}: {len(idx)} vertices, reference {base_c * 100:.1f} cm (local change -1..+1: {lo * 100:.1f}..{hi * 100:.1f} cm)")

    # 補間が Anny 本体の出力にどれだけ近いか（姿勢の回転が体形に依存するぶん厳密には一致しない）
    rng = np.random.default_rng(0)
    errors = []
    for _ in range(args.verify):
        values = rng.random(len(DIMS))
        age = years_to_anny_age(rng.uniform(20, 80), ages)
        t = (age - AGE_ANCHORS[0]) / (AGE_ANCHORS[1] - AGE_ANCHORS[0])
        approx = (1 - t) * interpolate(corners_by_age[0], values) + t * interpolate(corners_by_age[1], values)
        exact = vertices_for({**FIXED, "age": age, **dict(zip(DIMS, values))})
        errors.append(np.abs(approx - exact).max())
    if errors:
        print(f"interpolation error vs anny (max over {len(errors)} samples): {max(errors) * 1000:.2f} mm")


if __name__ == "__main__":
    main()
