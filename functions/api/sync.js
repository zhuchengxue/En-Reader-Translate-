/* Cloudflare Pages Function: 跨设备同步端点
 * GET  /api/sync?token=xxx  →  { data, ts }
 * PUT  /api/sync            →  body: { token, data }  →  { ok, ts }
 *
 * 书文件已编码在 data.books[]._file 中（base64），不依赖 R2。
 * KV 绑定名称: SYNC_KV
 */

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }

  if (request.method === 'GET') {
    const token = (url.searchParams.get('token') || '').trim().slice(0, 64);
    if (!token) return new Response('Missing token', { status: 400, headers: cors });
    const key = 'sync:' + token;
    let data = { books: [], vocab: [] };
    try {
      const raw = await env.SYNC_KV.get(key, 'json');
      if (raw && raw.books) data = raw;
    } catch (e) {}
    return Response.json({ data, ts: Date.now() }, { headers: cors });
  }

  if (request.method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const token = (body.token || '').toString().trim().slice(0, 64);
    if (!token) return new Response('Missing token', { status: 400, headers: cors });
    if (!body.data || !body.data.books) return new Response('Missing data', { status: 400, headers: cors });
    const key = 'sync:' + token;
    const payload = JSON.stringify(body.data);
    if (payload.length > 20971520) { // 20MB 上限，留 5MB 余量给 KV 25MB hard limit
      return Response.json({ ok: false, error: 'Payload too large (>20MB). Consider removing some books.', ts: Date.now() }, { headers: cors });
    }
    try {
      await env.SYNC_KV.put(key, payload);
    } catch (e) {
      return Response.json({ ok: false, error: String(e), ts: Date.now() }, { headers: cors });
    }
    return Response.json({ ok: true, ts: Date.now() }, { headers: cors });
  }

  return new Response('Method not allowed', { status: 405, headers: cors });
}
