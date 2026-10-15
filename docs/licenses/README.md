# サードパーティのライセンス

このアプリが同梱・利用しているもの。

| 対象 | 置き場所 | ライセンス | 全文 |
|---|---|---|---|
| three.js r170 | `vendor/three/` | MIT | [`vendor/three/LICENSE`](../vendor/three/LICENSE) |
| Anny 0.6.1（NAVER LABS Europe） | `data/anny-body.*` | Apache License 2.0 | [`anny-LICENSE.txt`](anny-LICENSE.txt) |
| MakeHuman / MPFB2 のアセット（Anny が利用） | `data/anny-body.*` に含まれる形状、`data/skin-regions.*`（MPFB2 の肌の領域マスクから作った頂点ごとの重み） | CC0 1.0 | [`makehuman-mpfb2-CC0.md`](makehuman-mpfb2-CC0.md) |
| MakeHuman の服（下の「服・髪」を参照） | `data/assets/` | CC0 1.0 / CC BY 3.0 / CC BY 4.0 | 各ライセンスの公式ページ |

## Anny について

`data/anny-body.bin` / `data/anny-body.json` は Anny（Copyright (C) 2025 NAVER Corporation）の
モデルから書き出した派生データ。Apache License 2.0 に従って配布する。

元のモデルからの変更点:
- 既定の `anny` トポロジ・リグだけを使い、プロポーションを中間値に固定した。年齢は "young" と "old" の2つのアンカーだけを書き出した
- 顔の肉付き（`head-fat` / `cheek-volume` / `neck-double`）の差分を頭部の頂点だけ書き出した
- 性別・筋肉量・体重・身長のアンカーの組み合わせ（36体形 × 年齢2）について、腕を下ろした姿勢の頂点を計算して書き出した
- 周囲長を調整する局所変形（`measure-bust-circ` / `-underbust-circ` / `-waist-circ` / `-hips-circ` / `-upperarm-circ` / `-thigh-circ` / `-calf-circ` / `-ankle-circ`）の差分を、平均的な体形の上で動く頂点だけ書き出した
- 座標系を three.js 向け（Y 上, +Z 前）に変換し、頂点を 16bit に量子化した

書き出しスクリプトは `tools/export/export_anny.py`（リポジトリ内）。
Anny 本体: https://github.com/naver/anny ／ 論文: https://arxiv.org/abs/2511.03589

`anny[smpl]` などの非商用アセットや `smplx` / `smpl` トポロジは使っていない。
Anny のパッケージに NOTICE ファイルは含まれていない（0.6.1 時点）。

## 服・髪（`data/assets/`）

MakeHuman のアセット（npm の `makehuman-data` 0.0.2 に含まれる MakeHuman 1.1 のプロキシ）を、
`tools/export/export_assets.py` で Anny の体にバインドし直して書き出した派生データ。
変更点: 頂点を Anny の体の三角形にバインドし直した、テクスチャを 512px に縮小した、服の下で隠す体の三角形を求めて追加した。

| 本アプリでの名前 | 元のアセット | 作者 | ライセンス |
|---|---|---|---|
| タンクトップ（`tank_top`） | Tank_Top_01 | Mindfront (Sweden) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| トップス（`top`） | female_top_01 | wolgade | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| ショートジーンズ（`short_jeans`） | ShortJeans | punkduck | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| ショーツ（`shorts`） | female_panties_01 | wolgade | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

いずれも元データの表記は「(c) MakeHuman.org 2001-2015」。
