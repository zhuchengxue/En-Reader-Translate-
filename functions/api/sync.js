/* Cloudflare Pages Function: 跨设备同步端点
 * GET  /api/sync?token=xxx  →  { data, ts }
 * PUT  /api/sync            →  body: { token, data }  →  { ok, ts }
 *
 * KV 绑定名称: SYNC_KV（需在 Cloudflare Dashboard → Workers & Pages → KV 创建并绑定）
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

  // GET: 从 URL 参数取 token → 返回服务器端存储的数据
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

  // PUT: 从 body 取 token 和 data → 存储
  if (request.method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const token = (body.token || '').toString().trim().slice(0, 64);
    if (!token) return new Response('Missing token', { status: 400, headers: cors });
    if (!body.data || !body.data.books) {
      return new Response('Missing data', { status: 400, headers: cors });
    }
    const key = 'sync:' + token;
    const payload = JSON.stringify(body.data);
    if (payload.length > 500000) {
      return new Response('Payload too large', { status: 413, headers: cors });
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
