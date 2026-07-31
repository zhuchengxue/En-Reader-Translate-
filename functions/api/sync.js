/* Cloudflare Pages Function: 跨设备同步端点
 * GET  /api/sync  + Authorization: Bearer <token> → { data, ts }
 * PUT  /api/sync  + Authorization: Bearer <token> + body: { data } → { ok, ts }
 *
 * 书文件已编码在 data.books[]._file 中（base64），不依赖 R2。
 * 服务端会合并文件：若本次上传不含某书的 _file，但 KV 里已有，则保留旧文件，
 * 避免客户端用「已上传过」标记跳过文件体后，把 KV 里的文件也覆盖掉。
 * KV 绑定名称: SYNC_KV
 */

const cors = {
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function getToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = (match ? match[1] : '').trim().slice(0, 64);
  return token.length >= 16 ? token : '';
}

async function tokenKey(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return 'sync:v2:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }
  if (!env.SYNC_KV) {
    return Response.json({ error: '服务端未配置同步存储' }, { status: 503, headers: cors });
  }

  if (request.method === 'GET') {
    const token = getToken(request);
    if (!token) return new Response('Missing or weak token', { status: 401, headers: cors });
    const key = await tokenKey(token);
    let data = { books: [], vocab: [] };
    try {
      const raw = await env.SYNC_KV.get(key, 'json');
      if (raw && raw.books) data = raw;
      // 一次性兼容旧存储键；读取后迁移到不暴露原始口令的哈希键。
      if (!raw) {
        const legacy = await env.SYNC_KV.get('sync:' + token, 'json');
        if (legacy && legacy.books) {
          data = legacy;
          await env.SYNC_KV.put(key, JSON.stringify(legacy));
          await env.SYNC_KV.delete('sync:' + token);
        }
      }
    } catch (e) {
      return Response.json({ error: '同步存储读取失败' }, { status: 503, headers: cors });
    }
    return Response.json({ data, ts: Date.now() }, { headers: cors });
  }

  if (request.method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const token = getToken(request);
    if (!token) return new Response('Missing or weak token', { status: 401, headers: cors });
    if (!body.data || !body.data.books) return new Response('Missing data', { status: 400, headers: cors });
    const key = await tokenKey(token);

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
      return Response.json({ ok: false, error: 'Payload too large (>20MB). Consider removing some books.', ts: Date.now() }, { status: 413, headers: cors });
    }
    try {
      await env.SYNC_KV.put(key, payload);
    } catch (e) {
      return Response.json({ ok: false, error: '同步存储写入失败', ts: Date.now() }, { status: 503, headers: cors });
    }
    return Response.json({ ok: true, ts: Date.now(), keptFiles: existingFileMap.size }, { headers: cors });
  }

  return new Response('Method not allowed', { status: 405, headers: cors });
}
