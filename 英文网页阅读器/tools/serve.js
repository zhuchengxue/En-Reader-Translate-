const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 8899;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.txt':'text/plain; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.woff':'font/woff', '.woff2':'font/woff2' };

/* test-only mock of the built-in /api/translate Pages Function so regression can verify the same-origin path */
function handleApiTranslate(req, res) {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => {
    let text = '';
    try { text = (JSON.parse(b).text || '').toString(); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ translatedText: 'MOCK翻译:' + text }));
  });
  return true;
}

const srv = http.createServer((req, r) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/api/translate') return handleApiTranslate(req, r);
  let fp = path.normalize(path.join(ROOT, p === '/' ? '/index.html' : p));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { r.writeHead(404); r.end('nf'); return; }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(r);
});
srv.listen(PORT, '127.0.0.1', () => console.log('serving on http://127.0.0.1:' + PORT));
