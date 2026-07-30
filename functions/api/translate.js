/* Cloudflare Pages Function: 翻译代理。
 * 优先 Workers AI（启用后），失败兜底 Google → Lingva。
 * 路由：POST /api/translate  ->  { translatedText }
 *
 * 启用 AI：Cloudflare Dashboard → 你的 Pages 项目 → Settings → Functions →
 *   AI bindings → 添加绑定，名称填 AI → 保存。绑定存在时自动生效，否则走 Google。
 */
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function aiTranslate(context, text, from, to) {
  const ai = context && context.env && context.env.AI;
  if (!ai) return null;
  const langNames = { 'zh-CN': 'Chinese', 'zh': 'Chinese', 'en': 'English', 'ja': 'Japanese', 'ko': 'Korean', 'fr': 'French', 'de': 'German', 'es': 'Spanish' };
  const src = langNames[from] || from;
  const tgt = langNames[to] || to;
  try {
    const resp = await ai.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [
        { role: 'system', content: 'You are a professional translator. Translate the user text from ' + src + ' to ' + tgt + '. Only output the translation, no explanations, no quotes, no prefixes.' },
        { role: 'user', content: text }
      ],
      max_tokens: Math.min(1024, text.length * 3 + 100)
    });
    const result = (resp && resp.response) ? String(resp.response).trim() : '';
    if (result && result.length > 1) return result;
  } catch (e) { console.warn('[translate-ai]', e.message || e); }
  return null;
}

export async function onRequest(context) {
  const request = context.request;
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

  /* ① Workers AI（绑定 AI 后自动启用） */
  const aiResult = await aiTranslate(context, text, from, to);
  if (aiResult) {
    return new Response(JSON.stringify({ translatedText: aiResult }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  /* ② Google 免费翻译，并发 429 / 空返回时兜底 */
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

  /* ③ Lingva 兜底 */
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
