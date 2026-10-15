// Service Worker の登録と更新の案内。
// 新しい版は待機状態でインストールされるので、ユーザーが「更新」を押したら切り替えて再読み込みする。

const banner = document.getElementById('update-banner');
const button = document.getElementById('update-button');

function offerUpdate(worker) {
  banner.hidden = false;
  button.onclick = () => {
    button.disabled = true;
    worker.postMessage('SKIP_WAITING');
  };
}

async function register() {
  const reg = await navigator.serviceWorker.register('sw.js');

  // 既に待機中の版がある（前回の起動中にインストールされた）
  if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);

  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => {
      // 初回インストール（controller がない）は案内しない
      if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
    });
  });

  // 新しい版に切り替わったら、その版のファイルで読み直す。
  // 初回インストール時の clients.claim() でも controllerchange が来るので、そのときは読み直さない
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  // ホーム画面から開いたままのことが多いので、前面に戻ったときにも更新を確認する
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reg.update().catch(() => {});
  });
}

if ('serviceWorker' in navigator) {
  register().catch((err) => console.error('Service Worker の登録に失敗しました', err));
}
