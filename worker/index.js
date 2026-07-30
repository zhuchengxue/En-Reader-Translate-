/* Cloudflare Worker: 翻译代理（免费兜底）
 * Google 免费 → Lingva
 */
export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Send POST {text, from, to}', { status: 405, headers: cors });
    }
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const text = (body.text || '').toString();
    const from = body.from || 'en';
    const to = body.to || 'zh-CN';
    if (!text) {
      return new Response(JSON.stringify({ translatedText: '' }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    /* ① Google 免费翻译 */
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + from + '&tl=' + to + '&dt=t&q=' + encodeURIComponent(text.slice(0, 1000));
    try {
      const r = await fetch(url, { headers: { 'User-Agent': ua } });
      if (r.ok) {
        const data = await r.json();
        const translated = (data[0] || []).map(seg => seg[0]).join('');
        if (translated) {
          return new Response(JSON.stringify({ translatedText: translated }), { headers: { ...cors, 'Content-Type': 'application/json' } });
        }
      }
    } catch (e) {}

    /* ② Lingva 兜底 */
    try {
      const lingva = 'https://lingva.ml/api/v1/' + from + '/' + to + '/' + encodeURIComponent(text.slice(0, 480));
      const lr = await fetch(lingva, { headers: { 'User-Agent': ua } });
      const ldata = await lr.json().catch(() => ({}));
      if (ldata.translation) {
        return new Response(JSON.stringify({ translatedText: ldata.translation }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }
    } catch (e) {}
    return new Response(JSON.stringify({ translatedText: '' }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};
