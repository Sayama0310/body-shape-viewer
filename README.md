# body-shape-viewer（体形ビューア）

身長・体重などを入力すると、それに応じた体形を3Dで表示する個人用の Web アプリ。
iPhone の Safari で開き「ホーム画面に追加」して使う PWA で、オフラインでも動く。

公開URL: https://sayama0310.github.io/body-shape-viewer/

## インストール（iPhone）

1. Safari で上の公開URLを開く
2. 共有ボタン →「ホーム画面に追加」
3. ホーム画面のアイコンから開く（全画面で表示され、一度開けばオフラインでも使える）

新しい版が公開されると、画面上部に知らせが出る。「更新」を押すと新しい版に切り替わる。

## 使い方・できること

- **基本**: 性別・身長・体重をスライダー、数値入力、−／＋ボタンで入力すると体形が変わる。名前（任意）も付けられる
- **年齢・体格**: 年齢、筋肉量（自動または手動）、体格の傾向（標準・アフリカ系・アジア系・ヨーロッパ系）
- **見た目**: 肌の色
- **服装**: 上（タンクトップ・トップス）と下（ショートジーンズ・ショーツ）。服は体形に合わせて変形する
- **周囲長（任意）**: 胸囲・アンダーバスト・ウエスト・ヒップ・二の腕・太もも・ふくらはぎ・足首。入れた値に体形を近づける。空欄ならモデルの値を表示する
- **2人表示**: シート上部の「＋ 2人目を追加」で別の人を横に並べられる。タブで入力する人を切り替え、名前は頭の上に表示される
- **3D操作**: 1本指で回転、ピンチで指の間に向かって拡大・縮小、2本指ドラッグで平行移動。ダブルタップした部位に寄り、もう一度ダブルタップで全身に戻る。右上のボタンで正面・横・後ろ・全身に切り替え
- 入力パネルは下から引き出すシートで、閉じる・半分・全体の3段階
- モデルで表せない組み合わせのときは、近い体形を表示して注記を出す
- 画面右上の「?」に使い方とクレジットがある

## データの扱い

- 入力値はすべて端末内（ブラウザ）で計算する。サーバーへの送信、解析ツール、外部CDNの読み込みは一切ない
- 入力値は次回のために端末の `localStorage` にだけ保存する
- サーバー側の処理・データベースは持たない（GitHub Pages の静的サイト）

## 使っているモデル・素材とライセンス

| 対象 | ライセンス |
|---|---|
| 体形モデル [Anny](https://github.com/naver/anny) 0.6.1（NAVER LABS Europe）から書き出したデータ | Apache License 2.0 |
| MakeHuman / MPFB2 のアセット（Anny が利用する形状、肌の領域マスク） | CC0 1.0 |
| 服（MakeHuman のアセット。作者: Mindfront, punkduck, wolgade） | CC BY 4.0 / CC BY 3.0 / CC0 1.0 |
| [three.js](https://threejs.org/) r170 | MIT |

詳細（変更点・作者ごとの表記・ライセンス全文）は [`docs/licenses/README.md`](docs/licenses/README.md)。

## ローカルでの動かし方

ビルドは不要。リポジトリ直下で:

```sh
npx http-server docs -c-1 -p 8080
```

http://localhost:8080/ を開く（`-c-1` でキャッシュを無効にする）。

`docs/` のファイルを追加・変更したら、Service Worker のキャッシュ一覧とバージョンを更新してコミットする:

```sh
node tools/update-sw.mjs          # docs/sw.js を更新
node tools/update-sw.mjs --check  # 更新漏れの確認だけ
```

## ディレクトリ構成

```
docs/                 公開する静的ファイル（GitHub Pages は main ブランチの /docs を公開）
  index.html, style.css
  app.js              画面・3D表示・入力の保存
  body-model.js       体形データの読み込み、体形の合成、周囲長の計測と入力への合わせ込み
  attachments.js      体に追従する服
  sheet.js            下から引き出す入力シート
  pwa.js, sw.js, manifest.webmanifest   PWA（オフライン対応・更新の通知）
  data/               書き出した体形データ（形式は data/README.md）
    assets/           服のデータ（形式は assets/README.md）
  icons/              アプリアイコン
  licenses/           サードパーティのライセンス
  vendor/three/       three.js（同梱）
tools/
  export/             Anny などからデータを書き出す Python スクリプト
  icons/make_icons.py アイコンを作る
  update-sw.mjs       Service Worker のキャッシュ一覧を更新する
notes/                調査メモ
CLAUDE.md, ROADMAP.md 開発方針とタスク一覧
```

## 書き出しスクリプトの実行方法

`docs/data/` のデータは Python（PyTorch）で事前に書き出したもの。アプリの実行には不要で、データを作り直すときだけ使う。

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r tools/export/requirements.txt

# 体形データ（docs/data/anny-body.*, anny-shape-*.bin）
python tools/export/export_anny.py

# 肌の塗り分け用の領域（docs/data/skin-regions.*）
python tools/export/export_skin.py

# 服（docs/data/assets/）。入力は npm の makehuman-data
npm pack makehuman-data@0.0.2 && mkdir mh && tar xzf makehuman-data-0.0.2.tgz -C mh
python tools/export/export_assets.py --source mh/package/public/data/proxies

# アイコン（docs/icons/）
python tools/icons/make_icons.py
```

書き出したら `node tools/update-sw.mjs` を実行してからコミットする。
データの形式は [`docs/data/README.md`](docs/data/README.md) と [`docs/data/assets/README.md`](docs/data/assets/README.md) を参照。
