/* 本地开发/日常使用服务器（双栈 IPv4+IPv6，默认端口 9000）。
 * 关键：所有响应带 Cache-Control: no-cache —— 强制浏览器每次向服务器校验，
 * 杜绝 Edge 的「启发式 HTTP 缓存」拿旧 JS 不放（Chrome 正常 / Edge 坏 的根因）。
 * python -m http.server 不发缓存头，已弃用，请用本文件或 start-server.bat。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { webcrypto, createHash } = require('crypto');
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

/* 古腾堡代理：浏览器直连 gutenberg.org 会被 CORS 拦截，故经同源代理取搜索结果与文件字节。
 * 仅放行受信任的公版书主机，防代理被滥用于抓取任意外站。 */
const GUTEN_ALLOW = ['gutendex.com', 'www.gutenberg.org', 'gutenberg.org', 'aleph.pglaf.org', 'gutenberg.reader.bible'];
async function handleGutenberg(req, res) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const target = new URL(req.url, 'http://localhost').searchParams.get('url');
  if (!target) { res.writeHead(400, cors); res.end('missing url'); return; }
  let host;
  try { host = new URL(target).hostname; } catch (e) { res.writeHead(400, cors); res.end('bad url'); return; }
  if (!GUTEN_ALLOW.includes(host)) { res.writeHead(403, cors); res.end('host not allowed'); return; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let r = null, lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        r = await fetch(target, {
          redirect: 'follow',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EnReader/1.0)' },
          signal: ctrl.signal
        });
        if (r.ok) break;
        lastErr = new Error('upstream ' + r.status);
      } catch (e) { lastErr = e; }
    }
    clearTimeout(timer);
    if (!r || !r.ok) { res.writeHead((r && r.status) || 502, cors); res.end('upstream error: ' + (lastErr && lastErr.message)); return; }
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const len = r.headers.get('content-length');
    const headers = { ...cors, 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' };
    if (len) {
      if (Number(len) > 60 * 1024 * 1024) { res.writeHead(413, cors); res.end('too large'); return; }
      headers['Content-Length'] = len;
    }
    res.writeHead(200, headers);
    /* 流式透传响应体：直接管道上游字节，避免大文件在内存里缓冲 */
    const nodeStream = Readable.fromWeb(r.body);
    nodeStream.on('error', () => { try { res.destroy(); } catch (e) {} });
    nodeStream.pipe(res);
  } catch (e) {
    res.writeHead(502, cors); res.end('fetch failed');
  }
}

/* 本地同步 mock：存 .workbuddy/sync-dev.json（仅开发用，不进入 git）
 * 书文件通过 _file base64 嵌入 books 数组，无需独立 R2。
 * 与生产 functions/api/sync.js 保持一致：PUT 时合并保留 KV 中已有的 _file。 */
const SYNC_FILE = path.join(ROOT, '.workbuddy', 'sync-dev.json');
async function handleSync(req, res) {
  const cors = { 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const token = (match ? match[1] : '').trim().slice(0, 64);
  if (token.length < 16) { res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Missing or weak token' })); return; }
  const key = 'sync:v2:' + createHash('sha256').update(token).digest('hex');
  let store = {};
  try { store = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')); } catch (e) {}
  if (req.method === 'GET') {
    res.writeHead(200, cors);
    res.end(JSON.stringify({ data: store[key] || { books: [], vocab: [] }, ts: Date.now() }));
    return;
  }
  if (req.method === 'PUT') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (e) {}
    if (!body || !body.data) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Missing data' })); return; }
    if (JSON.stringify(body.data).length > 20971520) { res.writeHead(413, cors); res.end(JSON.stringify({ error: 'Too large (>20MB)' })); return; }
    const existing = store[key] || { books: [], vocab: [] };
    const fileMap = new Map();
    for (const b of existing.books || []) {
      if (b._file) fileMap.set(b.id, { _file: b._file, _fileSize: b._fileSize });
    }
    const incoming = body.data;
    const mergedBooks = [];
    for (const b of incoming.books || []) {
      const kept = fileMap.get(b.id);
      if (kept && !b._file) {
        mergedBooks.push({ ...b, _file: kept._file, _fileSize: kept._fileSize });
      } else {
        mergedBooks.push(b);
      }
    }
    store[key] = { books: mergedBooks, vocab: incoming.vocab || [] };
    fs.mkdirSync(path.dirname(SYNC_FILE), { recursive: true });
    fs.writeFileSync(SYNC_FILE, JSON.stringify(store, null, 2), 'utf8');
    res.writeHead(200, cors); res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }
  res.writeHead(405, cors); res.end('Method not allowed');
}

const srv = http.createServer(async (req, r) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/api/redeem') return handleRedeem(req, r);
  if (p === '/api/gutenberg') return handleGutenberg(req, r);
  if (p === '/api/sync') return handleSync(req, r);
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
