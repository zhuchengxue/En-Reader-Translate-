/* 应用外壳缓存：网络优先（改动即时生效），失败回退缓存（离线可读）。仅缓存同源静态资源。
 * 版本号随每次重大改动递增，激活时清除旧版本缓存，避免浏览器一直用旧的破损 JS。 */
const CACHE = 'en-reader-v35';
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
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scopePath = new URL(self.registration.scope).pathname;
  const relativePath = url.pathname.startsWith(scopePath) ? url.pathname.slice(scopePath.length) : '';
  const isNavigation = req.mode === 'navigate';
  const isStatic = /^(?:index\.html|manifest\.json|sw\.js|css\/[^/]+\.css|js\/.+\.js|vendor\/.+\.js)$/.test(relativePath);
  // API 响应可能含同步密钥、书籍和生词；下载文件也由 IndexedDB 管理，绝不进入 Cache Storage。
  if (!isNavigation && !isStatic) return;
  e.respondWith((async () => {
    try {
      /* cache:'no-cache' 强制回源校验，绕过浏览器 HTTP 启发式缓存（Edge 曾借此喂旧 JS） */
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) {
        const copy = res.clone();
        await caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {           // 首屏离线兜底
        const f = await caches.match(new URL('index.html', self.registration.scope).href);
        if (f) return f;
      }
      return new Response('', { status: 504 });
    }
  })());
});
