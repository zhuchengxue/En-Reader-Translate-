/* 应用外壳缓存：网络优先（改动即时生效），失败回退缓存（离线可读）。仅缓存同源静态资源。
 * 版本号随每次重大改动递增，激活时清除旧版本缓存，避免浏览器一直用旧的破损 JS。 */
const CACHE = 'en-reader-v23';
self.addEventListener('install', (e) => {
  // 立即激活新 SW，配合 clients.claim 让新版本尽快接管
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', (e) => {
  // 来自页面的「跳过等待」指令：新 SW 立即接管，触发 controllerchange → 页面刷新
  if (e.data === 'skip-waiting') self.skipWaiting();
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;            // POST（如 /api/translate）不走缓存
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 仅同源
  e.respondWith((async () => {
    try {
      /* cache:'no-cache' 强制回源校验，绕过浏览器 HTTP 启发式缓存（Edge 曾借此喂旧 JS） */
      const res = await fetch(req, { cache: 'no-cache' });
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {           // 首屏离线兜底
        const f = await caches.match('/index.html');
        if (f) return f;
      }
      return new Response('', { status: 504 });
    }
  })());
});
