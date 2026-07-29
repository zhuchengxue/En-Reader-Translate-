/* Cloudflare Pages Function: 跨设备同步端点
 *
 * 元数据同步 (KV):
 *   GET  /api/sync?token=xxx       →  { data, ts }
 *   PUT  /api/sync                 →  body: { token, data }  →  { ok, ts }
 *
 * 书文件同步 (R2):
 *   GET    /api/sync/book/:id?token=xxx  →  下载该书文件字节
 *   PUT    /api/sync/book/:id            →  body: { token, data: "<base64>" }
 *   DELETE /api/sync/book/:id?token=xxx  →  删除
 *
 * 绑定:
 *   KV: SYNC_KV   R2: SYNC_R2（bucket 名称）
 */

const cors = (method) => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': method || 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

function error(text, status) {
  return new Response(text, { status, headers: cors() });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: cors() });
  }

  // ─── 书文件: GET /api/sync/book/:id?token=xxx ───
  if (request.method === 'GET' && parts[2] === 'book' && parts[3]) {
    const token = (url.searchParams.get('token') || '').trim().slice(0, 64);
    if (!token) return error('Missing token', 400);
    const key = `sync:${token}:books:${parts[3]}`;
    try {
      const obj = await env.SYNC_R2.get(key);
      if (!obj) return error('Not found', 404);
      const headers = new Headers(cors('GET'));
      obj.writeHttpMetadata(headers);
      headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
      headers.set('Cache-Control', 'public, max-age=86400');
      return new Response(obj.body, { headers });
    } catch (e) {
      return error('R2 error: ' + String(e), 502);
    }
  }

  // ─── 书文件: PUT /api/sync/book/:id  body: { token, data } ───
  if (request.method === 'PUT' && parts[2] === 'book' && parts[3]) {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const token = (body.token || '').toString().trim().slice(0, 64);
    if (!token) return error('Missing token', 400);
    if (!body.data) return error('Missing data', 400);
    const key = `sync:${token}:books:${parts[3]}`;
    try {
      // body.data 是 base64 编码的文件内容
      const binary = Uint8Array.from(atob(body.data), c => c.charCodeAt(0));
      await env.SYNC_R2.put(key, binary, {
        httpMetadata: { contentType: body.type || 'application/octet-stream' }
      });
      return Response.json({ ok: true }, { headers: cors('PUT') });
    } catch (e) {
      return error('R2 error: ' + String(e), 502);
    }
  }

  // ─── 书文件: DELETE /api/sync/book/:id?token=xxx ───
  if (request.method === 'DELETE' && parts[2] === 'book' && parts[3]) {
    const token = (url.searchParams.get('token') || '').trim().slice(0, 64);
    if (!token) return error('Missing token', 400);
    const key = `sync:${token}:books:${parts[3]}`;
    try {
      await env.SYNC_R2.delete(key);
      return Response.json({ ok: true }, { headers: cors('DELETE') });
    } catch (e) {
      return error('R2 error: ' + String(e), 502);
    }
  }

  // ─── 元数据: GET /api/sync?token=xxx ───
  if (request.method === 'GET') {
    const token = (url.searchParams.get('token') || '').trim().slice(0, 64);
    if (!token) return error('Missing token', 400);
    const key = 'sync:' + token;
    let data = { books: [], vocab: [] };
    try {
      const raw = await env.SYNC_KV.get(key, 'json');
      if (raw && raw.books) data = raw;
    } catch (e) {}
    return Response.json({ data, ts: Date.now() }, { headers: cors('GET') });
  }

  // ─── 元数据: PUT /api/sync  body: { token, data } ───
  if (request.method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const token = (body.token || '').toString().trim().slice(0, 64);
    if (!token) return error('Missing token', 400);
    if (!body.data || !body.data.books) return error('Missing data', 400);
    const key = 'sync:' + token;
    const payload = JSON.stringify(body.data);
    if (payload.length > 500000) return error('Payload too large', 413);
    try {
      await env.SYNC_KV.put(key, payload);
    } catch (e) {
      return Response.json({ ok: false, error: String(e), ts: Date.now() }, { headers: cors('PUT') });
    }
    return Response.json({ ok: true, ts: Date.now() }, { headers: cors('PUT') });
  }

  return error('Method not allowed', 405);
}
