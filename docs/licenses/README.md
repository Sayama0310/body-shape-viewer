# サードパーティのライセンス

このアプリが同梱・利用しているもの。

| 対象 | 置き場所 | ライセンス | 全文 |
|---|---|---|---|
| three.js r170 | `vendor/three/` | MIT | [`vendor/three/LICENSE`](../vendor/three/LICENSE) |
| Anny 0.6.1（NAVER LABS Europe） | `data/anny-body.*` | Apache License 2.0 | [`anny-LICENSE.txt`](anny-LICENSE.txt) |
| MakeHuman / MPFB2 のアセット（Anny が利用） | `data/anny-body.*` に含まれる形状 | CC0 1.0 | [`makehuman-mpfb2-CC0.md`](makehuman-mpfb2-CC0.md) |

## Anny について

`data/anny-body.bin` / `data/anny-body.json` は Anny（Copyright (C) 2025 NAVER Corporation）の
モデルから書き出した派生データ。Apache License 2.0 に従って配布する。

元のモデルからの変更点:
- 既定の `anny` トポロジ・リグだけを使い、年齢を若年成人、プロポーションを中間値に固定した
- 性別・筋肉量・体重・身長のアンカーの組み合わせ（36体形）について、腕を下ろした姿勢の頂点を計算して書き出した
- 座標系を three.js 向け（Y 上, +Z 前）に変換し、頂点を 16bit に量子化した

書き出しスクリプトは `tools/export/export_anny.py`（リポジトリ内）。
Anny 本体: https://github.com/naver/anny ／ 論文: https://arxiv.org/abs/2511.03589

`anny[smpl]` などの非商用アセットや `smplx` / `smpl` トポロジは使っていない。
Anny のパッケージに NOTICE ファイルは含まれていない（0.6.1 時点）。
