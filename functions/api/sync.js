/* Cloudflare Pages Function: 跨设备同步端点
 * GET  /api/sync?token=xxx  →  { data, ts }
 * PUT  /api/sync            →  body: { token, data }  →  { ok, ts }
 *
 * 书文件已编码在 data.books[]._file 中（base64），不依赖 R2。
 * 服务端会合并文件：若本次上传不含某书的 _file，但 KV 里已有，则保留旧文件，
 * 避免客户端用「已上传过」标记跳过文件体后，把 KV 里的文件也覆盖掉。
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

    /* 合并策略：incoming 是客户端当前完整书架/生词本。
     * 1. 若 incoming 某书带了 _file，用新的（重新导入、重新上传）。
     * 2. 若 incoming 某书没 _file，但 KV 里同 id 有 _file，保留 KV 里的文件。
     * 3. KV 里有但 incoming 没有的书，视为已删除，直接丢弃。
     * 4. 生词本直接以 incoming 为准（数据量小，全量替换即可）。 */
    let incoming = body.data;
    let existing = { books: [], vocab: [] };
    try {
      const raw = await env.SYNC_KV.get(key, 'json');
      if (raw && raw.books) existing = raw;
    } catch (e) {}

    const existingFileMap = new Map();
    for (const b of existing.books || []) {
      if (b._file) {
        existingFileMap.set(b.id, { _file: b._file, _fileSize: b._fileSize });
      }
    }

    const mergedBooks = [];
    for (const b of incoming.books || []) {
      const kept = existingFileMap.get(b.id);
      if (kept && !b._file) {
        mergedBooks.push({ ...b, _file: kept._file, _fileSize: kept._fileSize });
      } else {
        mergedBooks.push(b);
      }
    }

    const merged = { books: mergedBooks, vocab: incoming.vocab || [] };
    const payload = JSON.stringify(merged);
    if (payload.length > 20971520) { // 20MB 上限，留 5MB 余量给 KV 25MB hard limit
      return Response.json({ ok: false, error: 'Payload too large (>20MB). Consider removing some books.', ts: Date.now() }, { headers: cors });
    }
    try {
      await env.SYNC_KV.put(key, payload);
    } catch (e) {
      return Response.json({ ok: false, error: String(e), ts: Date.now() }, { headers: cors });
    }
    return Response.json({ ok: true, ts: Date.now(), keptFiles: existingFileMap.size }, { headers: cors });
  }

  return new Response('Method not allowed', { status: 405, headers: cors });
}
