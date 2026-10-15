"""肌の塗り分け用の領域（唇・爪・乳輪・まぶた）を、体の頂点ごとの重みとして書き出す。

Anny に同梱の MPFB2 のテクスチャ（data/mpfb2/textures/mpfb_*.jpg, CC0）は、
MPFB の肌シェーダーが部位を塗り分けるための領域マスク（白 = その部位）になっている。
各頂点の UV でマスクを読み取り、0〜255 の重みにする。ブラウザでは肌の色から部位ごとの色を作り、
この重みで混ぜて頂点色にする（テクスチャを描画に使わないので軽い）。

使い方:
    python tools/export/export_skin.py
"""

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageFilter

import anny

FORMAT_VERSION = 1
# 重みのチャンネル: マスクのファイル（複数なら最大値）
REGIONS = {
    "lips": ["mpfb_lips.jpg"],
    "nails": ["mpfb_fingernails.jpg", "mpfb_toenails.jpg"],
    "areolae": ["mpfb_aureolae.jpg"],
    "eyelids": ["mpfb_eyelids.jpg"],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "docs" / "data")
    args = parser.parse_args()

    torch.set_grad_enabled(False)
    model = anny.Anny()
    uv = model.texture_coordinates.numpy()
    faces = model.faces.numpy()
    face_uv = model.face_texture_coordinate_indices.numpy()
    vertex_count = model.template_vertices.shape[0]

    # 頂点ごとに、その頂点を使う三角形の角の UV を集める（UV の継ぎ目では複数ある）
    corners_v = faces.reshape(-1)
    corners_uv = uv[face_uv.reshape(-1)]

    textures = Path(anny.__file__).parent / "data" / "mpfb2" / "textures"
    weights = np.zeros((vertex_count, len(REGIONS)), dtype=np.float64)
    for k, files in enumerate(REGIONS.values()):
        mask = None
        for name in files:
            # 少しぼかして、頂点の間隔より細い境界でも拾えるようにする
            img = Image.open(textures / name).convert("L").filter(ImageFilter.GaussianBlur(4))
            a = np.asarray(img, dtype=np.float64) / 255
            mask = a if mask is None else np.maximum(mask, a)
        h, w = mask.shape
        px = np.clip((corners_uv[:, 0] % 1) * (w - 1), 0, w - 1).astype(int)
        py = np.clip((1 - corners_uv[:, 1] % 1) * (h - 1), 0, h - 1).astype(int)
        sampled = mask[py, px]
        np.maximum.at(weights[:, k], corners_v, sampled)

    out = np.round(np.clip(weights, 0, 1) * 255).astype(np.uint8)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "skin-regions.bin").write_bytes(out.tobytes())
    meta = {
        "formatVersion": FORMAT_VERSION,
        "vertexCount": int(vertex_count),
        "channels": list(REGIONS),
        "source": {name: files for name, files in REGIONS.items()},
    }
    (args.out / "skin-regions.json").write_text(json.dumps(meta, indent=2) + "\n")
    for k, name in enumerate(REGIONS):
        print(f"{name}: {(out[:, k] > 64).sum()} vertices")


if __name__ == "__main__":
    main()
