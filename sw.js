/* 画面そのものを端末に置く。曲の実体は app.js が別の入れ物（tracks-v1）に持つ。 */
const SHELL = 'shell-v33';
const FILES = ['./', './index.html', './app.js?v=32', './manifest.webmanifest', './icon-192.png', './icon-180.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== 'tracks-v1').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;              // pCloud も iTunes も素通し
  /* 音と一覧は横取りしない。音は部分取得（206）で来るので控えに入らず、
     横取りすると再生そのものが壊れる（入口に移って初めて表に出た）。 */
  if (u.pathname.startsWith('/api/')) return;
  if (e.request.headers.has('range')) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    /* 素の fetch はブラウザの控えを掴むことがある。必ず問い合わせ直す。 */
    fetch(e.request, { cache: 'no-cache' }).then(r => {
      const copy = r.clone();
      caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {});
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
