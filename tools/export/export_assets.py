"""体に追従するアセット（服・髪）を書き出す。

MakeHuman のプロキシ（服・髪）は、各頂点を MakeHuman の基本メッシュの3頂点（補助頂点を含む）と
オフセットで表している。Anny の `anny` トポロジは補助頂点を持たないので、そのままでは使えない。
そこで、MakeHuman の基本メッシュ（`base.obj`、Anny に同梱）の上で、アセットの各頂点を
Anny の体の三角形にバインドし直す:

    頂点 = p0 + u (p1 - p0) + v (p2 - p0) + ox t + oy b + oz n

（p0, p1, p2 は体の三角形の頂点、t, b, n はその三角形の接線・従法線・法線）。
ブラウザでは、合成した体の頂点からこの式でアセットの頂点を計算する。体形や姿勢が変わっても、
三角形と一緒に動き・回るので追従する。

入力は2種類:
- npm の `makehuman-data`（MakeHuman のアセットを three.js の JSON 形式に変換したもの）。服に使う
- MakeHuman の公式のアセットパック（`.mhclo` + `.obj` + `.mhmat`）。髪に使う
ライセンスはアセットごとのファイルの記載を確認し、CC0 / CC BY のものだけを使う
（パックの一覧ページで CC0 とされていても、ファイル自体に別のライセンスが書かれているものは使わない）。

使い方:
    npm pack makehuman-data@0.0.2 && mkdir mh && tar xzf makehuman-data-0.0.2.tgz -C mh
    # https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html から
    # makehuman_system_assets_cc0.zip を取得して packs/ に展開する
    python tools/export/export_assets.py --source mh/package/public/data/proxies --packs packs
"""

import argparse
import json
import re
from pathlib import Path

import numpy as np
import torch
import trimesh
from PIL import Image

import anny

FORMAT_VERSION = 1
TEXTURE_SIZE = 512
# 体の頂点が服に覆われているとみなす距離（基本メッシュの単位 dm。0.6 = 6cm）
COVER_DISTANCE = 0.6
# 髪のとき（0.15 = 1.5cm）
HAIR_COVER_DISTANCE = 0.15

# 書き出すアセット。license は元データのメタデータの値（書き出し時に一致を確認する）
ASSETS = [
    {"id": "tank_top", "kind": "clothes", "slot": "top", "label": "タンクトップ", "source": "Tank_Top_01"},
    {"id": "short_jeans", "kind": "clothes", "slot": "bottom", "label": "ショートジーンズ", "source": "ShortJeans"},
]
# 自由に使えるライセンス（帰属表示は docs/licenses/ に置く）
ALLOWED_LICENSES = ("CC0", "CC BY")


def read_obj_vertices(path):
    return np.array([[float(x) for x in line.split()[1:4]] for line in open(path) if line.startswith("v ")])


def parse_threejs_faces(data):
    """three.js JSON（形式 3）の faces を、角ごとの (頂点, UV) の三角形の列にする。"""
    faces = data["faces"]
    uvs = np.array(data["uvs"][0]).reshape(-1, 2) if data["uvs"] and data["uvs"][0] else None
    tris = []
    i = 0
    while i < len(faces):
        t = faces[i]
        i += 1
        quad = t & 1
        n = 4 if quad else 3
        verts = faces[i : i + n]
        i += n
        if t & 2:  # material
            i += 1
        if t & 4:  # face uv
            i += 1
        corner_uv = [None] * n
        if t & 8:  # face vertex uvs
            corner_uv = faces[i : i + n]
            i += n
        if t & 16:  # face normal
            i += 1
        if t & 32:  # face vertex normals
            i += n
        if t & 64:  # face color
            i += 1
        if t & 128:  # face vertex colors
            i += n
        corners = list(zip(verts, corner_uv))
        tris.append(corners[:3])
        if quad:
            tris.append([corners[0], corners[2], corners[3]])
    return tris, uvs


def load_threejs(spec, source_dir):
    """makehuman-data（three.js JSON）のアセットを読む。"""
    src = source_dir / spec["kind"] / spec["source"]
    data = json.load(open(src / f"{spec['source']}.json"))
    meta = data["metadata"]
    lic = meta["license"]
    tris, uvs = parse_threejs_faces(data)
    mat = data["materials"][0]
    return {
        "ref": np.array(data["ref_vIdxs"]),
        "weights": np.array(data["weights"]),
        "offsets": np.array(data["offsets"]),
        "scale": np.ones(3),
        "tris": tris,
        "uvs": uvs,
        "license": {k: lic.get(k) for k in ("author", "license", "homepage", "copyright")},
        "delete": meta.get("deleteVerts", []),
        "diffuse": src / mat["mapDiffuse"] if mat.get("mapDiffuse") else None,
    }


def read_license_line(text):
    """.mhclo の冒頭のコメントからライセンスを読む。"""
    head = "\n".join(line for line in text.splitlines()[:40] if line.startswith("#"))
    if re.search(r"AGPL|GPL", head):
        return "AGPL"
    if re.search(r"released as CC0|\bCC-?0\b", head):
        return "CC0 1.0"
    m = re.search(r"license[: ]+(CC[ _-]?BY[^\n]*)", head, re.I)
    if m:
        return "CC BY " + (re.search(r"\d\.\d", m.group(1)).group(0) if re.search(r"\d\.\d", m.group(1)) else "")
    m = re.search(r"license[: ]+([^\n]+)", head, re.I)
    return m.group(1).strip() if m else "unknown"


def load_mhclo(spec, packs_dir):
    """MakeHuman の .mhclo（+ .obj + .mhmat）を読む。

    .mhclo の verts は「基本メッシュの3頂点の番号, 重み3つ, オフセット3つ」（1つの番号だけの行はその頂点そのもの）。
    オフセットは x_scale / y_scale / z_scale（基本メッシュの2頂点の距離 / 基準の長さ）を掛けて使う
    """
    src = packs_dir / spec["source"]
    clo_path = next(src.glob("*.mhclo"))
    text = clo_path.read_text(errors="replace")
    ref, weights, offsets, delete, scales = [], [], [], [], {}
    obj_file, material, author = None, None, None
    section = None
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if parts[0] in ("verts", "delete_verts"):
            section = parts[0]
            continue
        if section == "verts" and re.fullmatch(r"-?\d+", parts[0]):
            if len(parts) == 1:
                ref.append([int(parts[0])] * 3)
                weights.append([1.0, 0.0, 0.0])
                offsets.append([0.0, 0.0, 0.0])
            else:
                ref.append([int(x) for x in parts[0:3]])
                weights.append([float(x) for x in parts[3:6]])
                offsets.append([float(x) for x in parts[6:9]])
            continue
        if section == "delete_verts" and re.fullmatch(r"[\d -]+", line):
            # 「861 - 862 878」のように、範囲は「-」をはさんで書かれる
            tokens = line.replace("-", " - ").split()
            i = 0
            while i < len(tokens):
                if i + 2 < len(tokens) and tokens[i + 1] == "-":
                    delete.extend(range(int(tokens[i]), int(tokens[i + 2]) + 1))
                    i += 3
                else:
                    delete.append(int(tokens[i]))
                    i += 1
            continue
        # verts の途中にも material などの行が入ることがあるので、数字以外の行では区切らない
        if parts[0] in ("x_scale", "y_scale", "z_scale"):
            scales[parts[0][0]] = (int(parts[1]), int(parts[2]), float(parts[3]))
        elif parts[0] == "obj_file":
            obj_file = parts[1]
        elif parts[0] == "material":
            material = parts[1]
        elif parts[0] == "author":
            author = " ".join(parts[1:])
    m = re.search(r"#\s*(?:author[: ]+)?([^\n#]*?)\s*-\s*CC0", text)
    author = author or (m.group(1).strip() if m else None)

    # obj: 頂点（使わない。位置は基本メッシュから求める）、UV、面（多角形は扇に分ける）
    vts, tris = [], []
    for line in open(src / obj_file):
        if line.startswith("vt "):
            vts.append([float(x) for x in line.split()[1:3]])
        elif line.startswith("f "):
            corners = []
            for c in line.split()[1:]:
                v, _, rest = c.partition("/")
                vt = rest.split("/")[0] if rest else ""
                corners.append((int(v) - 1, int(vt) - 1 if vt else None))
            for k in range(1, len(corners) - 1):
                tris.append([corners[0], corners[k], corners[k + 1]])

    diffuse = None
    if material and (src / material).exists():
        for line in (src / material).read_text(errors="replace").splitlines():
            if line.startswith("diffuseTexture"):
                diffuse = src / Path(line.split(None, 1)[1].strip()).name
    return {
        "ref": np.array(ref),
        "weights": np.array(weights),
        "offsets": np.array(offsets),
        "scale_spec": scales,
        "tris": tris,
        "uvs": np.array(vts) if vts else None,
        "license": {"author": author, "license": read_license_line(text), "homepage": None, "copyright": None},
        "delete": delete,
        "diffuse": diffuse,
    }


def frames(p0, p1, p2):
    e1, e2 = p1 - p0, p2 - p0
    n = np.cross(e1, e2)
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    t = e1 / np.linalg.norm(e1, axis=1, keepdims=True)
    b = np.cross(n, t)
    return t, b, n


def export_asset(spec, dirs, body_mesh, body_faces, base_to_anny, base_obj, out_dir):
    data = load_mhclo(spec, dirs["packs"]) if spec.get("format") == "mhclo" else load_threejs(spec, dirs["source"])
    lic = data["license"]
    if not (lic.get("license") or "").startswith(ALLOWED_LICENSES):
        raise ValueError(f"{spec['source']}: ライセンスが対象外です ({lic.get('license')})")

    # アセットの頂点の位置: MakeHuman と同じく、基本メッシュの3頂点の重み付き和 + オフセット
    # （元の obj の座標は基本メッシュに合っていないものがあるので使わない）
    ref, weights = data["ref"], data["weights"]
    scale = np.ones(3)
    for axis, (a, b, den) in data.get("scale_spec", {}).items():
        k = "xyz".index(axis)
        scale[k] = abs(base_obj[a, k] - base_obj[b, k]) / den
    positions = (base_obj[ref] * weights[..., None]).sum(axis=1) + data["offsets"] * scale
    tris, uvs = data["tris"], data["uvs"]

    # UV の継ぎ目で頂点を分ける（(頂点, UV) の組ごとに1頂点）
    key_to_index, verts, vuv, index = {}, [], [], []
    for tri in tris:
        for v, uv in tri:
            key = (v, uv)
            if key not in key_to_index:
                key_to_index[key] = len(verts)
                verts.append(v)
                vuv.append(uvs[uv] if uv is not None else (0.0, 0.0))
            index.append(key_to_index[key])
    verts = np.array(verts)
    points = positions[verts]

    # 体の三角形へのバインド（MakeHuman の基本メッシュの座標、単位 dm）
    closest, _, tri_id = trimesh.proximity.closest_point(body_mesh, points)
    tri_v = body_faces[tri_id]
    p0, p1, p2 = (body_mesh.vertices[tri_v[:, k]] for k in range(3))
    bary = trimesh.triangles.points_to_barycentric(np.stack([p0, p1, p2], axis=1), closest)
    t, b, n = frames(p0, p1, p2)
    d = points - closest
    offset = np.stack([(d * t).sum(1), (d * b).sum(1), (d * n).sum(1)], axis=1) * 0.1  # dm → m

    # 服の下で隠す体の三角形:
    # (1) MakeHuman の deleteVerts のどれかを含む三角形
    # (2) 体の頂点から法線方向に出した光線が COVER_DISTANCE 以内で服に当たる頂点（服に覆われている）だけでできた三角形
    #     （体形を変えても服は体の三角形と一緒に動くので、覆われた部分は覆われたまま。突き抜けを見せないために隠す）
    delete = np.array(data["delete"], dtype=np.int64)
    delete_anny = base_to_anny[delete[(delete < len(base_to_anny))]]
    delete_anny = delete_anny[delete_anny >= 0]
    cloth_mesh = trimesh.Trimesh(vertices=points, faces=np.array(index).reshape(-1, 3), process=False)
    origins = body_mesh.vertices
    normals = body_mesh.vertex_normals
    hit_ray = np.zeros(len(origins), dtype=bool)
    locations, ray_idx, hit_tri = cloth_mesh.ray.intersects_location(origins, normals, multiple_hits=False)
    dist = np.linalg.norm(locations - origins[ray_idx], axis=1)
    # テクスチャの透明な部分（切り抜き）に当たったものは覆われていない
    opaque = np.ones(len(ray_idx), dtype=bool)
    if data["diffuse"]:
        alpha = np.asarray(Image.open(data["diffuse"]).convert("RGBA"))[..., 3]
        tri_uv = np.array(vuv)[np.array(index).reshape(-1, 3)[hit_tri]]
        w = trimesh.triangles.points_to_barycentric(cloth_mesh.triangles[hit_tri], locations)
        uv = (tri_uv * w[..., None]).sum(axis=1)
        h, wid = alpha.shape
        px = np.clip((uv[:, 0] % 1) * (wid - 1), 0, wid - 1).astype(int)
        py = np.clip((1 - uv[:, 1] % 1) * (h - 1), 0, h - 1).astype(int)
        opaque = alpha[py, px] > 127
    # 髪は毛先のすき間から下が見えるので、頭皮のすぐ上で覆っている部分だけを隠す（離れた首まわりを隠すと穴が見える）
    cover = spec.get("coverDistance", HAIR_COVER_DISTANCE if spec["kind"] == "hair" else COVER_DISTANCE)
    hit_ray[ray_idx[(dist < cover) & opaque]] = True
    covered = hit_ray
    hidden = np.flatnonzero(np.isin(body_faces, delete_anny).any(axis=1) | covered[body_faces].all(axis=1))

    # テクスチャ（縮小して PNG）
    texture = None
    if data["diffuse"]:
        img = Image.open(data["diffuse"]).convert("RGBA")
        size = spec.get("textureSize", TEXTURE_SIZE)
        img.thumbnail((size, size), Image.LANCZOS)
        texture = f"{spec['id']}.png"
        img.save(out_dir / texture, optimize=True)

    blobs = [
        ("bind", tri_v.astype("<u2")),
        ("bary", bary[:, 1:].astype("<f4")),  # p1, p2 の重み（p0 は 1 - u - v）
        ("offset", offset.astype("<f4")),
        ("uv", np.array(vuv).astype("<f4")),
        ("index", np.array(index).astype("<u2")),
        ("hiddenFaces", hidden.astype("<u2")),
    ]
    layout, chunks, offset_bytes = {}, [], 0
    for name, arr in blobs:
        raw = arr.tobytes()
        layout[name] = {"offset": offset_bytes, "byteLength": len(raw)}
        pad = (-len(raw)) % 4
        chunks += [raw, b"\0" * pad]
        offset_bytes += len(raw) + pad
    (out_dir / f"{spec['id']}.bin").write_bytes(b"".join(chunks))

    return {
        **{k: spec[k] for k in ("id", "kind", "slot", "label")},
        "file": f"{spec['id']}.bin",
        "texture": texture,
        "vertexCount": int(len(verts)),
        "indexCount": int(len(index)),
        "hiddenFaceCount": int(len(hidden)),
        "layout": layout,
        "source": {
            "name": spec["source"],
            "author": lic.get("author"),
            "license": lic.get("license"),
            "homepage": lic.get("homepage"),
            "copyright": lic.get("copyright"),
        },
        "bindDistanceMax": float(np.linalg.norm(offset, axis=1).max()),
        "bytes": offset_bytes + ((out_dir / texture).stat().st_size if texture else 0),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, required=True, help="makehuman-data の public/data/proxies")
    parser.add_argument("--packs", type=Path, help="MakeHuman のアセットパックを展開したディレクトリ（髪に使う）")
    parser.add_argument("--only", help="書き出すアセットの id（カンマ区切り。確認用）")
    parser.add_argument("--extra", type=Path, help="ASSETS に加える仕様の JSON（候補の比較用）")
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "docs" / "data" / "assets")
    args = parser.parse_args()

    torch.set_grad_enabled(False)
    model = anny.Anny()
    base_idx = model.base_mesh_vertex_indices.numpy()
    body_faces = model.faces.numpy()
    base_obj = read_obj_vertices(Path(anny.__file__).parent / "data" / "mpfb2" / "3dobjs" / "base.obj")
    body_mesh = trimesh.Trimesh(vertices=base_obj[base_idx], faces=body_faces, process=False)
    base_to_anny = np.full(len(base_obj), -1, dtype=np.int64)
    base_to_anny[base_idx] = np.arange(len(base_idx))

    args.out.mkdir(parents=True, exist_ok=True)
    specs = ASSETS + (json.loads(args.extra.read_text()) if args.extra else [])
    if args.only:
        specs = [s for s in specs if s["id"] in args.only.split(",")]
    dirs = {"source": args.source, "packs": args.packs}
    catalog = [export_asset(spec, dirs, body_mesh, body_faces, base_to_anny, base_obj, args.out) for spec in specs]
    index = {"formatVersion": FORMAT_VERSION, "bodyVertexCount": int(len(base_idx)), "assets": catalog}
    (args.out / "index.json").write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    for a in catalog:
        print(f"{a['id']}: {a['vertexCount']} vertices, hides {a['hiddenFaceCount']} body faces, "
              f"max offset {a['bindDistanceMax'] * 1000:.1f} mm, {a['bytes'] / 1e3:.0f} kB ({a['source']['license']})")


if __name__ == "__main__":
    main()
