/* 本地开发/日常使用服务器（双栈 IPv4+IPv6，默认端口 9000）。
 * 关键：所有响应带 Cache-Control: no-cache —— 强制浏览器每次向服务器校验，
 * 杜绝 Edge 的「启发式 HTTP 缓存」拿旧 JS 不放（Chrome 正常 / Edge 坏 的根因）。
 * python -m http.server 不发缓存头，已弃用，请用本文件或 start-server.bat。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 9000;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.txt':'text/plain; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.woff':'font/woff', '.woff2':'font/woff2' };

/* 本地开发用的 /api/redeem：用真实私钥给任意合法格式兑换码签名，方便浏览器端实测激活流程。
 * ⚠️ 仅供本地开发/测试，绝不随 Cloudflare Pages 部署（生产由 functions/api/redeem.js 走 KV 校验）。 */
async function handleRedeem(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return; }
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch (e) {}
  const code = (body.code || '').toString().trim().toUpperCase().replace(/\s+/g, '');
  const dev = (body.dev || '').toString().slice(0, 64);
  const cors = { 'Access-Control-Allow-Origin':'*', 'Content-Type':'application/json' };
  if (!/^ENRD-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) || !dev) {
    res.writeHead(400, cors); res.end(JSON.stringify({ error: '兑换码格式不正确' })); return;
  }
  let privJwk;
  try { privJwk = JSON.parse(fs.readFileSync(path.join(ROOT, 'worker', 'keys.private.txt'), 'utf8')); }
  catch (e) { res.writeHead(500, cors); res.end(JSON.stringify({ error: '本地未找到私钥 worker/keys.private.txt' })); return; }
  const priv = await webcrypto.subtle.importKey('jwk', privJwk, { name: 'Ed25519' }, false, ['sign']);
  const payload = { code, dev, iat: Date.now(), exp: Date.now() + 600 * 30 * 864e5 };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'Ed25519' }, priv, Buffer.from(data, 'utf8'))).toString('base64url');
  res.writeHead(200, cors); res.end(JSON.stringify({ token: data + '.' + sig }));
}
function readBody(req) {
  return new Promise((res, rej) => { let b = ''; req.on('data', c => b += c); req.on('end', () => res(b)); req.on('error', rej); });
}

const srv = http.createServer(async (req, r) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/api/redeem') return handleRedeem(req, r);
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
