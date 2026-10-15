# Anny 体形データ

`tools/export/export_anny.py` が Anny 0.6.1 から書き出したデータ。
ライセンスと元モデルからの変更点は [`../licenses/README.md`](../licenses/README.md) を参照。

| ファイル | 中身 |
|---|---|
| `anny-body.json` | メタデータ（頂点数・次元・量子化スケール・バイナリ内の配置） |
| `anny-body.bin` | 三角形・平均形状・各体形との差分（約 3.3MB） |

## 体形の表し方

Anny の形状は、フェノタイプ（0〜1 の値）ごとに決まったアンカー間の多重線形補間になっている。
このデータは、年齢を若年成人（`age = 2/3`、Anny の "young" アンカー）、
`proportions = 0.5` に固定したうえで、次の4次元のアンカーの全組み合わせ（2×3×3×2 = 36体形、以下「角」）の頂点を持つ。

| 次元（`dims[i].name`） | アンカー（`dims[i].anchors`） | 意味 |
|---|---|---|
| `gender` | 0, 1 | 0 = 男性, 1 = 女性 |
| `muscle` | 0, 0.5, 1 | 筋肉量 最小 / 平均 / 最大 |
| `weight` | 0, 0.5, 1 | 体重（脂肪量） 最小 / 平均 / 最大 |
| `height` | 0, 1 | 身長 最小 / 最大 |

`weight` や `height` は Anny の内部パラメータで、kg や cm ではない。
実際の身長は頂点の Y 方向の幅から、体重はメッシュの体積 × 密度から求める（Anny の `anthropometry.py` は密度 980 kg/m³ を使っている）。

### 任意のパラメータの頂点を求める

1. 各次元について、値 `x` を挟む2つのアンカー `a[i-1] ≤ x ≤ a[i]` を探し、重み `1 - t` と `t`（`t = (x - a[i-1]) / (a[i] - a[i-1])`）を割り当てる。範囲外の値はアンカーの範囲に丸める
2. 角ごとの重み = 4次元の重みの積。0 でない角は最大 16 個
3. 頂点 = `mean + Σ 角の重み × delta[角] × deltaScale`（重みの合計は 1）

角の並び順は `dims` の順の多重ループ（最後の次元 `height` が最も内側）。
角の番号 `c = ((g × 3 + m) × 3 + w) × 2 + h`（g, m, w, h は各次元のアンカー番号）。

補間結果と Anny 本体の出力の差は最大 6〜7mm 程度（腕を下ろす回転が体形によって少し変わるため）。

## 座標系・姿勢

- 単位はメートル。three.js と同じ右手系で Y が上、+Z が体の正面、+X が体の左側
- 原点は Anny のルートボーン（骨盤）付近。足の裏が Y = 0 とは限らないので、表示時に最小 Y で接地させる
- 姿勢は Anny の静止姿勢（A ポーズ）から、上腕を下ろし、肘を伸ばし、脚を閉じた立ち姿勢（角度は `poseDeg`）
- 三角形は反時計回りが表面

## `anny-body.bin` の配置

リトルエンディアン。各ブロックの位置は `anny-body.json` の `layout.<名前>.offset`（バイト）と `byteLength` に書いてある。
各ブロックの先頭は 4 バイト境界に揃えている。

| `layout` の名前 | 型 | 要素数 | 中身 |
|---|---|---|---|
| `faces` | Uint16 | `faceCount × 3` | 三角形の頂点番号 |
| `mean` | Float32 | `vertexCount × 3` | 36体形の平均の頂点座標（x, y, z の順） |
| `deltas` | Int16 | `36 × vertexCount × 3` | 角ごとの平均からの差分。`deltaScale` を掛けるとメートルになる |

量子化の誤差は 0.01mm 未満。

## 書き出し直す

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r tools/export/requirements.txt
python tools/export/export_anny.py   # docs/data/ に上書きする
```

初回は Anny がアセットを解析してキャッシュを作るため数分かかる（キャッシュ先は `ANNY_CACHE_DIR`、既定は `~/.cache/anny/`）。
フォーマットを変えたら `anny-body.json` の `formatVersion` を上げ、このファイルを更新する。
