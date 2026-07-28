/* Cloudflare Pages Function: 古腾堡（Project Gutenberg）代理。
 * 路由：GET /api/gutenberg?url=<encoded>  ->  透传目标（搜索 JSON 或 EPUB/TXT 字节）
 * 用途：浏览器直连 gutenberg.org 会被 CORS 拦截，故经同源代理取搜索结果与文件字节。
 * 部署：本 Function 随项目一起推到 Cloudflare Pages 即生效；本地开发由 tools/serve.js 提供同路由。
 * 安全：仅放行受信任的公版书主机，防止代理被滥用于抓取任意外站。
 */
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const ALLOW = ['gutendex.com', 'www.gutenberg.org', 'gutenberg.org', 'aleph.pglaf.org', 'gutenberg.reader.bible'];

export async function onRequest(context) {
  const request = context.request;
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const target = new URL(request.url).searchParams.get('url');
  if (!target) return new Response('missing url', { status: 400, headers: cors });

  let host;
  try { host = new URL(target).hostname; } catch (e) { return new Response('bad url', { status: 400, headers: cors }); }
  if (!ALLOW.includes(host)) return new Response('host not allowed', { status: 403, headers: cors });

  try {
    const r = await fetch(target, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EnReader/1.0)' },
    });
    if (!r.ok) return new Response('upstream ' + r.status, { status: r.status, headers: cors });
    /* 透传响应体，Cloudflare 会流式返回（EPUB 通常几 MB，远低于限制） */
    const headers = {
      ...cors,
      'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
    };
    return new Response(r.body, { status: 200, headers });
  } catch (e) {
    return new Response('fetch failed', { status: 502, headers: cors });
  }
}
