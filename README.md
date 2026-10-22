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

- **基本**: 性別・身長・体重をスライダー、数値入力、−／＋ボタンで入力すると体形が変わる（年齢は30歳、筋肉量は平均として計算する）。名前（任意）も付けられる
- **入力のシート**: ふだんは隠れていて、画面下の「入力」で出し、右上の × で閉じる
- **数値の非表示**: シートを出しても、身長・体重・BMI は「•••」で隠れている。シート右上の「数値を表示」で表示し、シートを閉じる・たたむ、またはアプリを切り替えるとまた隠れる
- **見た目**: 肌の色、髪形（ショート・短髪・アフロ・ポニーテール・ボブ2種・内巻きボブ・なし）、髪の色（黒・こげ茶・茶・金）
- **服装**: 常にタンクトップとショートジーンズを着ている。服は体形に合わせて変形する
- **2人表示**: シート上部の「＋ 2人目を追加」で別の人を横に並べられる。タブで入力する人を切り替え、名前は頭の上に表示される
- **3D操作**: 1本指で回転、ピンチで指の間に向かって拡大・縮小、2本指ドラッグで平行移動。ダブルタップした部位に寄り、もう一度ダブルタップで全身に戻る。右上のボタンで正面・横・後ろ・全身に切り替え
- 入力のシートは、たたむ・半分・全体の3段階
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
| MakeHuman / MPFB2 のアセット（Anny が利用する形状） | CC0 1.0 |
| 服（MakeHuman のアセット。作者: Mindfront, punkduck） | CC BY 4.0 / CC BY 3.0 |
| 髪（MakeHuman の公式アセットパック。作者: MakeHuman チーム, MargaretToigo） | CC0 1.0 |
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
  body-model.js       体形データの読み込み、体形の合成、身長・体重への合わせ込み
  attachments.js      体に追従する服・髪
  sheet.js            下から引き出す入力シート
  pwa.js, sw.js, manifest.webmanifest   PWA（オフライン対応・更新の通知）
  data/               書き出した体形データ（形式は data/README.md）
    assets/           服・髪のデータ（形式は assets/README.md）
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

# 体形データ（docs/data/anny-body.*, anny-shape-standard.bin）
python tools/export/export_anny.py

# 服・髪（docs/data/assets/）。服は npm の makehuman-data、髪は MakeHuman の公式アセットパックから
npm pack makehuman-data@0.0.2 && mkdir mh && tar xzf makehuman-data-0.0.2.tgz -C mh
curl -LO https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip
curl -LO https://files.makehumancommunity.org/asset_packs/hair01/hair01_cc0.zip
unzip makehuman_system_assets_cc0.zip -d packs/makehuman_system_assets && unzip hair01_cc0.zip -d packs/hair01
python tools/export/export_assets.py --source mh/package/public/data/proxies --packs packs

# アイコン（docs/icons/）
python tools/icons/make_icons.py
```

書き出したら `node tools/update-sw.mjs` を実行してからコミットする。
データの形式は [`docs/data/README.md`](docs/data/README.md) と [`docs/data/assets/README.md`](docs/data/assets/README.md) を参照。
