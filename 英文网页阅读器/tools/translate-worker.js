/**
 * 翻译代理 · Cloudflare Worker
 * ---------------------------------------------------------------
 * 用途：纯前端阅读器在中国网络下无法直连 Google 翻译（CORS 拦截），
 *       本 Worker 在服务端代理 Google 翻译并补上 CORS 头，浏览器即可调用。
 * 免费额度：Cloudflare Workers 免费版 10 万次/天，个人阅读完全够用。
 *
 * 部署步骤：
 *   1. 打开 https://workers.cloudflare.com  （用 Cloudflare 账号，免费注册）
 *   2. 创建 Worker → 把本文件内容粘进编辑器 → Deploy
 *   3. 你会得到一个地址，类似：
 *        https://translate-proxy.<你的子域>.workers.dev
 *   4. 在阅读器里：设置 → 翻译代理 → 粘贴上面的地址 → 保存
 *   5. 之后单词/句子翻译即走该代理，稳定且不限 MyMemory 的每日配额。
 *
 * 接口约定（与阅读器 js/services.js 的 viaProxy 对应）：
 *   POST  { "text": "待译文本", "from": "en", "to": "zh-CN" }
 *   返回  { "translatedText": "译文" }
 *   需正确处理 OPTIONS 预检（跨域 POST + JSON 会触发）。
 */
export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // 1) 处理 CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors });
    }

    // 2) 解析请求
    let body;
    try { body = await request.json(); } catch (e) {
      return new Response('Bad Request', { status: 400, headers: cors });
    }
    const text = (body.text || '').toString();
    const from = body.from || 'en';
    const to = body.to || 'zh-CN';
    if (!text) {
      return new Response(JSON.stringify({ translatedText: '' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // 3) 代理 Google 翻译（服务端调用，无 CORS 限制）
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
      encodeURIComponent(from) + '&tl=' + encodeURIComponent(to) +
      '&dt=t&q=' + encodeURIComponent(text);
    try {
      const r = await fetch(url);
      const data = await r.json();
      const translated = (data[0] || []).map(seg => seg[0]).join('');
      return new Response(JSON.stringify({ translatedText: translated }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ translatedText: '' }), {
        status: 502,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  },
};
