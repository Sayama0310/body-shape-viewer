# 体に追従するアセット（服・髪）

`tools/export/export_assets.py` が書き出したデータ。ブラウザ側は `docs/attachments.js` が読む。
ライセンスと出典は [`../../licenses/README.md`](../../licenses/README.md) を参照。

## 仕組み

MakeHuman のプロキシ（服・髪）は、各頂点を「MakeHuman の基本メッシュの3頂点の重み付き和 + オフセット」で表す（`.mhclo`）。
参照する頂点には、Anny の `anny` トポロジにはない補助頂点（タイツ・スカート用のヘルパー）も含まれるので、そのままでは使えない。

そこで書き出し時に次のように変換する。

1. MakeHuman の基本メッシュ（Anny に同梱の `data/mpfb2/3dobjs/base.obj`）の上で、`.mhclo` の式どおりにアセットの頂点の位置を求める
   （元の `.obj` の座標は基本メッシュに合っていないものがあるので使わない）
2. 各頂点を、`anny` トポロジの体の三角形のうち最も近いものにバインドし直す。
   バインドは三角形の頂点番号 `(a, b, c)`、重心座標 `(u, v)`、三角形の向きに沿ったオフセット `(ox, oy, oz)`（メートル）
3. 服の下に隠れる体の三角形を求める。
   `.mhclo` の `delete_verts` に加えて、体の頂点から法線方向に出した光線が 6cm 以内で服の不透明な部分（テクスチャの α > 0.5）に当たる頂点を「覆われている」とし、
   3頂点とも覆われた三角形を隠す

ブラウザでは、合成した体の頂点から毎回次の式でアセットの頂点を計算する（`Attachment.update`）。

    頂点 = p_a + u (p_b - p_a) + v (p_c - p_a) + ox t + oy b + oz n

`t` は辺 a→b の向き、`n` は三角形の法線、`b = n × t`。体形・年齢・姿勢が変わっても、三角形と一緒に動き・回るので追従する。
服の下に隠れる体の三角形は描かない（体形を変えても服は体の三角形と一緒に動くので、覆われた部分は覆われたまま）。

## ファイル

| ファイル | 中身 |
|---|---|
| `index.json` | アセットの一覧（`id`, `kind`, `slot`, `label`, 出典・ライセンス、`<id>.bin` 内の配置） |
| `<id>.bin` | バインドとメッシュ（下表） |
| `<id>.png` | テクスチャ（512px に縮小、α 付き） |

`<id>.bin` はリトルエンディアンで、各ブロックの位置は `index.json` の `layout.<名前>.offset` / `byteLength`。

| `layout` の名前 | 型 | 要素数 | 中身 |
|---|---|---|---|
| `bind` | Uint16 | `vertexCount × 3` | バインド先の体の三角形の頂点番号 a, b, c |
| `bary` | Float32 | `vertexCount × 2` | 重心座標 u（b の重み）, v（c の重み） |
| `offset` | Float32 | `vertexCount × 3` | 三角形の t, b, n 方向のオフセット（m） |
| `uv` | Float32 | `vertexCount × 2` | テクスチャ座標（UV の継ぎ目で頂点を分けてある） |
| `index` | Uint16 | `indexCount` | 三角形 |
| `hiddenFaces` | Uint16 | `hiddenFaceCount` | 着ているときに描かない体の三角形の番号 |

## 検討の結果（タスク11）

- 入手先: MakeHuman のサイト・GitHub はこの開発環境のネットワーク方針で取得できなかったので、
  npm の [`makehuman-data`](https://www.npmjs.com/package/makehuman-data)（MakeHuman 1.1 のアセットを three.js の JSON に変換したもの）を使った。
  アセットごとのメタデータにライセンスが入っている
- ライセンス: このパッケージのメタデータでは、MakeHuman 本体付属の服・髪の多くが AGPL3 になっている。
  方針（自由に使えるものだけ）に合わせ、CC0 と CC BY のものだけを使う（`export_assets.py` の `ALLOWED_LICENSES` で確認）
- 追従: 体形（BMI 15〜40）・性別・年齢を変えても服は体の表面に沿って動く。体の三角形にバインドしているので、腕を下ろす姿勢でもずれない
- 突き抜け: 服の下の体を隠すことで、体形を変えても体が服を突き抜けて見えない。
  ただし、服の端の近く（隠さない三角形）や、細い紐・薄い布の部分では、体形によって少し食い込みが見えることがある
- サイズと負荷: 1点あたり 1,000〜1,500 頂点、データ 40〜60kB ＋ テクスチャ 30〜330kB。
  頂点の計算は体の合成のたびに数千頂点ぶんだけで、体の合成（約 13,700 頂点）に比べて軽い
- 見送ったこと: 服どうしの重なり（上の服を下の服の外に出す等）の調整、法線マップ、MakeHuman の `.mhclo` の `x_scale` などによるオフセットの拡大縮小（体の三角形の向きに沿ったオフセットで代わりにしている）

## アセットを増やす手順

1. `makehuman-data` のメタデータ（`metadata.license`）で、ライセンスが CC0 / CC BY であることを確認する
2. `tools/export/export_assets.py` の `ASSETS` に追加する（`kind` は `clothes`、`slot` は `top` / `bottom`）。アプリは一覧の服を常にすべて着る
3. `python tools/export/export_assets.py --source <makehuman-data>/public/data/proxies` を実行する
4. `docs/licenses/README.md` に出典（作者・ライセンス）を追記し、`node tools/update-sw.mjs` を実行する
