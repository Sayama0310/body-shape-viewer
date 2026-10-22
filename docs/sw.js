// Service Worker: docs/ の全ファイルを1つのキャッシュに入れ、オフラインで動かす。
//
// - キャッシュ名にバージョンを入れ、新しい版をインストールし終えたら古いキャッシュを消す
// - ページは常に1つのキャッシュ（＝1つの版）からだけ読むので、新旧ファイルは混ざらない
// - 新しい版は待機状態で止め、ページからの指示（SKIP_WAITING）で切り替えてから再読み込みする
// - 標準以外の体格の傾向の形状データは最初はキャッシュせず、選ばれて取得したときにキャッシュに入れる
//
// VERSION と FILES は `node tools/update-sw.mjs` で更新する（手で書き換えない）。

// <precache>
const VERSION = '48bfb26938';
const FILES = [
  './',
  'app.js',
  'attachments.js',
  'body-model.js',
  'data/README.md',
  'data/anny-body.bin',
  'data/anny-body.json',
  'data/anny-shape-standard.bin',
  'data/assets/README.md',
  'data/assets/hair_blunt_bob.bin',
  'data/assets/hair_blunt_bob.png',
  'data/assets/hair_short02.bin',
  'data/assets/hair_short02.png',
  'data/assets/index.json',
  'data/assets/short_jeans.bin',
  'data/assets/short_jeans.png',
  'data/assets/tank_top.bin',
  'data/assets/tank_top.png',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'index.html',
  'licenses/README.md',
  'licenses/anny-LICENSE.txt',
  'licenses/makehuman-mpfb2-CC0.md',
  'manifest.webmanifest',
  'pwa.js',
  'sheet.js',
  'style.css',
  'vendor/three/LICENSE',
  'vendor/three/README.md',
  'vendor/three/addons/controls/OrbitControls.js',
  'vendor/three/three.module.min.js',
];
// </precache>

const CACHE = `body-shape-viewer-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // HTTP キャッシュを通さずに取り直す（古いファイルが混ざらないように）
      cache.addAll(FILES.map((path) => new Request(path, { cache: 'reload' }))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('body-shape-viewer-') && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // ページの表示は index.html（./ や ?source=pwa などでも同じものを返す）
      const key = request.mode === 'navigate' ? new URL('./', self.registration.scope).href : request;
      const cached = await cache.match(key, { ignoreSearch: request.mode === 'navigate' });
      if (cached) return cached;
      const response = await fetch(request);
      // 必要になったときに読むデータ（標準以外の体格の傾向など）は、取得したら同じ版のキャッシュに入れる
      if (response.ok && new URL(request.url).pathname.includes('/data/')) cache.put(request, response.clone());
      return response;
    })(),
  );
});
