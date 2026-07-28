/* 本地开发/日常使用服务器（双栈 IPv4+IPv6，默认端口 9000）。
 * 关键：所有响应带 Cache-Control: no-cache —— 强制浏览器每次向服务器校验，
 * 杜绝 Edge 的「启发式 HTTP 缓存」拿旧 JS 不放（Chrome 正常 / Edge 坏 的根因）。
 * python -m http.server 不发缓存头，已弃用，请用本文件或 start-server.bat。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 9000;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.txt':'text/plain; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.woff':'font/woff', '.woff2':'font/woff2' };

/* 注意：本服务器只处理静态文件，不提供 /api/translate。
 * 本地开发时翻译服务自然回退到 Lingva / MyMemory 真实链路；
 * 部署到 Cloudflare Pages 后 Pages Functions 才提供 /api/translate。
 * 测试脚本（tools/regression.js）自带 mock server，不要在这里加 mock。 */

const srv = http.createServer((req, r) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  let fp = path.normalize(path.join(ROOT, p === '/' ? '/index.html' : p));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { r.writeHead(404); r.end('nf'); return; }
  const st = fs.statSync(fp);
  r.writeHead(200, {
    'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Last-Modified': st.mtime.toUTCString(),
    /* no-cache = 可以缓存但每次必须回源校验；杜绝启发式缓存吃旧文件 */
    'Cache-Control': 'no-cache, must-revalidate',
  });
  fs.createReadStream(fp).pipe(r);
});
/* 监听 '::' 在 Windows 上为双栈：Edge 把 localhost 解析成 ::1 也能连上 */
srv.listen(PORT, '::', () => console.log('serving (dual-stack, no-cache) on http://localhost:' + PORT));
