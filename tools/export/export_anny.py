"""Anny から体形データを書き出す。

年齢を若年成人に固定し、性別・筋肉量・体重・身長の各アンカー（角）の組み合わせごとに
腕を下ろした姿勢の頂点を計算して docs/data/ に書き出す。
Anny の形状はアンカー間の多重線形補間なので、JS 側では角の頂点を重み付き合成すれば
任意のパラメータの体形が得られる。形式は docs/data/README.md を参照。

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

FORMAT_VERSION = 1

# 書き出す次元とアンカー値（Anny のフェノタイプ値, 0〜1）。順序がバイナリ内の角の並び順になる
DIMS = {
    "gender": [0.0, 1.0],  # male, female
    "muscle": [0.0, 0.5, 1.0],  # min, average, max
    "weight": [0.0, 0.5, 1.0],  # min, average, max
    "height": [0.0, 1.0],  # min, max
}
# 固定するフェノタイプ
FIXED = {
    "age": 2 / 3,  # "young" アンカー（若年成人）
    "proportions": 0.5,
}
# Anny の静止姿勢（A ポーズ、肘が前に曲がる）から気をつけに近い姿勢へ回す角度（度）。
# 回転ベクトルは Anny の座標系（X 左右, Y 前後, Z 上下）で、左側（.L）の値。右側は X 以外の符号を反転する
POSE_DEG = {
    "upperarm01": (0.0, 32.0, 0.0),  # 腕を下ろす（太い体形で胴にめり込まない程度）
    "lowerarm01": (40.0, -8.0, 0.0),  # 肘を伸ばす
    "upperleg01": (0.0, 4.0, 0.0),  # 足を閉じる
}


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
    model = anny.Anny().to(dtype=torch.float64)  # 既定の anny トポロジ・リグ
    pose = build_pose(model)

    def vertices_for(phenotypes):
        kwargs = {k: torch.tensor([v], dtype=torch.float64) for k, v in phenotypes.items()}
        out = model(pose_parameters=pose, phenotype_kwargs=kwargs)
        return to_three(out["vertices"][0].numpy())

    combos = list(itertools.product(*DIMS.values()))
    corners = np.stack([vertices_for({**FIXED, **dict(zip(DIMS, c))}) for c in combos])

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

    args.out.mkdir(parents=True, exist_ok=True)
    blobs = [
        ("faces", faces.astype("<u2")),
        ("mean", mean.astype("<f4")),
        ("deltas", quantized),
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
        "fixed": FIXED,
        "poseDeg": POSE_DEG,
        "deltaScale": scale,
        "layout": layout,
    }
    (args.out / "anny-body.json").write_text(json.dumps(meta, indent=2) + "\n")

    print(f"corners: {len(combos)}, vertices: {vertex_count}, faces: {faces.shape[0]}")
    print(f"bin size: {offset / 1e6:.2f} MB, quantization error: {quant_error * 1000:.3f} mm")

    # 補間が Anny 本体の出力にどれだけ近いか（姿勢の回転が体形に依存するぶん厳密には一致しない）
    rng = np.random.default_rng(0)
    errors = []
    for _ in range(args.verify):
        values = rng.random(len(DIMS))
        exact = vertices_for({**FIXED, **dict(zip(DIMS, values))})
        errors.append(np.abs(interpolate(corners, values) - exact).max())
    if errors:
        print(f"interpolation error vs anny (max over {len(errors)} samples): {max(errors) * 1000:.2f} mm")


if __name__ == "__main__":
    main()
