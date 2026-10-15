# Anny 体形データ

`tools/export/export_anny.py` が Anny 0.6.1 から書き出したデータ。
ライセンスと元モデルからの変更点は [`../licenses/README.md`](../licenses/README.md) を参照。

| ファイル | 中身 |
|---|---|
| `anny-body.json` | メタデータ（頂点数・次元・量子化スケール・周囲長の計測断面・バイナリ内の配置） |
| `anny-body.bin` | 三角形・平均形状・各体形との差分・年齢の差分・局所変形と顔の肉付きの差分（約 4.9MB） |

`formatVersion` は 4。
- 3 からの変更: 周囲長を8項目に増やした。局所変形を疎な形式（`localIndex` + `localDeltas`、`localChanges[k].start` / `count`）にし、
  差分を静止姿勢で取ってスキニングの回転で姿勢側に回すようにした。周囲長の計測を頂点の帯から断面（`measurements.<name>.a` / `b` / `t`）に変えた
- 2 からの変更: 年齢の次元（`age`, `ageDeltas`）と顔の肉付き（`faceFat`, `faceFatIndex`, `faceFatDeltas`）を追加。基準の年齢を16歳相当（`age = 2/3`）から30歳に変更
- 1 からの変更: 局所変形 `localDeltas` と周囲長の計測頂点 `measurements` を追加（3 時点の形式）

## 体形の表し方

Anny の形状は、フェノタイプ（0〜1 の値）ごとに決まったアンカー間の多重線形補間になっている。
このデータは `proportions = 0.5` に固定したうえで、次の4次元のアンカーの全組み合わせ（2×3×3×2 = 36体形、以下「角」）の頂点を、
年齢の2つのアンカー（"young" と "old"）について持つ。

| 次元（`dims[i].name`） | アンカー（`dims[i].anchors`） | 意味 |
|---|---|---|
| `gender` | 0, 1 | 0 = 男性, 1 = 女性 |
| `muscle` | 0, 0.5, 1 | 筋肉量 最小 / 平均 / 最大 |
| `weight` | 0, 0.5, 1 | 体重（脂肪量） 最小 / 平均 / 最大 |
| `height` | 0, 1 | 身長 最小 / 最大 |

年齢（`age.anchors`）は Anny の `age` で 2/3（"young"）と 1（"old"）。
Anny の定義（`shape_calibration` の `morphological_age_mapping`、`age.yearsToAnny` に同じ値を入れてある）では、
歳 → `age` は区分線形で 16歳 = 0.67, 18歳 = 0.77, 64歳 = 0.83, 110歳 = 1.0。20〜80歳は 0.773〜0.889 で、この2つのアンカーの間に入る。

`weight` や `height` は Anny の内部パラメータで、kg や cm ではない。
実際の身長は頂点の Y 方向の幅から、体重はメッシュの体積 × 密度から求める（Anny の `anthropometry.py` は密度 980 kg/m³ を使っている）。

### 任意のパラメータの頂点を求める

1. 各次元について、値 `x` を挟む2つのアンカー `a[i-1] ≤ x ≤ a[i]` を探し、重み `1 - t` と `t`（`t = (x - a[i-1]) / (a[i] - a[i-1])`）を割り当てる。範囲外の値はアンカーの範囲に丸める
2. 角ごとの重み = 4次元の重みの積。0 でない角は最大 16 個
3. 年齢の重み `s = (age - 2/3) / (1 - 2/3)` を求める（0〜1 に丸める）
4. 頂点 = `mean + Σ 角の重み × (delta[角] × deltaScale + s × ageDelta[角] × age.deltaScale)`（角の重みの合計は 1）

`mean` と `delta` は "young" の角、`ageDelta` は "old" の角と "young" の角の差（8bit、量子化誤差 最大 1mm 程度）。

角の並び順は `dims` の順の多重ループ（最後の次元 `height` が最も内側）。
角の番号 `c = ((g × 3 + m) × 3 + w) × 2 + h`（g, m, w, h は各次元のアンカー番号）。

補間結果と Anny 本体の出力の差は最大 9mm 程度（腕を下ろす回転が体形によって少し変わるため）。

### 局所変形（周囲長の調整）

`localChanges` に並ぶ Anny の局所変形（`annyLabel`）を、値 `v`（-1〜1）で足せる。

| `name` | Anny のラベル | 効く部位 |
|---|---|---|
| `chest` | `measure-bust-circ-incr` | 胸囲 |
| `underbust` | `measure-underbust-circ-incr` | アンダーバスト |
| `waist` | `measure-waist-circ-incr` | ウエスト |
| `hip` | `measure-hips-circ-incr` | ヒップ |
| `upperarm` | `measure-upperarm-circ-incr` | 二の腕（左右とも） |
| `thigh` | `measure-thigh-circ-incr` | 太もも（左右とも） |
| `calf` | `measure-calf-circ-incr` | ふくらはぎ（左右とも） |
| `ankle` | `measure-ankle-circ-incr` | 足首（左右とも） |

差分は動く頂点だけの疎な形式。変形 k の頂点番号は `localIndex[start .. start + count)`、
差分は `localDeltas` の `start × 6` 要素目から `[符号 +, -][count][xyz]` の順に並ぶ。

頂点[localIndex[start + i]] += `|v| × localDeltas[(start × 2 + s × count + i) × 3 + xyz] × localDeltaScale`（s は `v > 0` なら 0（incr）、`v < 0` なら 1（decr））

差分は平均的な成人（`gender = muscle = weight = 0.5`, `height = 0.3`, 30歳, 身長 約170cm）の静止姿勢で取り、
各頂点のスキニングの回転（ボーンの回転を重みで平均したもの）で姿勢側に回したもの。
姿勢をつけた頂点どうしの差を取ると、局所変形がボーンの位置を少し動かすぶん全身がずれるため、そうしていない。
ほかの体形にもそのまま足す（Anny 本体でも局所変形は体形によらない加算）。

### 顔の肉付き

Anny の `weight` は頭の形をほとんど変えないので、顔の肉付きを別に足す。値 `f`（-1〜1）に対して、
`faceFat.annyLabels` の組み合わせの局所変形（+1 側は頭・頬・二重あご、-1 側は頭・頬）を、基準体形の上で取った差分として持つ。
動く頭部の頂点だけの疎な差分で、`faceFatIndex` が頂点番号。

頂点[faceFatIndex[i]] += `|f| × faceFatDeltas[s][i] × faceFat.deltaScale`（s は `f > 0` なら 0、`f < 0` なら 1）

アプリでは BMI に連動させる（性別ごとの標準 BMI との差 ÷ 10 を -0.6〜1 に丸める）。

### 周囲長の測り方

`measurements.<name>` は周囲長を測る断面。基準体形を水平面で切ったときに交わる辺を `a[i]`, `b[i]`（頂点番号）と
内分比 `t[i]` で持ち、どの体形でも点 `v[a] + t × (v[b] - v[a])` を取る（体形が変わっても同じ部位を指す）。
これらの点を XZ 平面（水平面）に投影し、凸包の周長を周囲長とする（巻き尺を当てたときの長さの近似）。
胴の項目は腕・手の頂点を含まない。左右がある部位は左側（+X）の脚・腕だけで測る。

| `name` | 断面の高さ |
|---|---|
| `chest` | 女性の基準体形でバストの頂点（胴の最も前に出た点） |
| `underbust` | 女性の基準体形でバストの頂点の 3〜12cm 下の、周囲長が最小の高さ |
| `waist` | Anny の `anthropometry.py` がウエストに使う頂点のループ（`a = b`, `t = 0`） |
| `hip` | 基準体形で身長の 42〜58% の高さのうち周囲長が最大の高さ |
| `upperarm` | 上腕のボーンの頂点の高さの中ほど（肩と肘の中間） |
| `thigh` | 太もものボーンの頂点のうち、Anny の太ももの計測ターゲットで周囲長が最も変わる高さ |
| `calf` | すねのボーンの頂点の高さの 40〜85% のうち周囲長が最大の高さ |
| `ankle` | 床から 6〜16cm のうち周囲長が最小の高さ（すね・足のボーンの頂点） |

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
| `mean` | Float32 | `vertexCount × 3` | "young" の36体形の平均の頂点座標（x, y, z の順） |
| `deltas` | Int16 | `36 × vertexCount × 3` | "young" の角ごとの平均からの差分。`deltaScale` を掛けるとメートルになる |
| `ageDeltas` | Int8 | `36 × vertexCount × 3` | 角ごとの "old" − "young"。`age.deltaScale` を掛けるとメートルになる |
| `localIndex` | Uint16 | 各変形の `count` の合計 | 局所変形で動く頂点の番号（変形の順に連結） |
| `localDeltas` | Int16 | `Σ 2 × count × 3` | 局所変形の差分（変形ごとに incr, decr の順）。`localDeltaScale` を掛けるとメートルになる |
| `faceFatIndex` | Uint16 | 頭部の頂点数 | 顔の肉付きで動く頂点の番号 |
| `faceFatDeltas` | Int16 | `2 × 頭部の頂点数 × 3` | 顔の肉付きの差分（+1, -1 の順）。`faceFat.deltaScale` を掛けるとメートルになる |

量子化の誤差は、16bit のブロックで 0.01mm 未満、`ageDeltas`（8bit）で最大 1mm 程度。

## 書き出し直す

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r tools/export/requirements.txt
python tools/export/export_anny.py   # docs/data/ に上書きする
```

初回は Anny がアセットを解析してキャッシュを作るため数分かかる（キャッシュ先は `ANNY_CACHE_DIR`、既定は `~/.cache/anny/`）。
フォーマットを変えたら `anny-body.json` の `formatVersion` を上げ、このファイルを更新する。
