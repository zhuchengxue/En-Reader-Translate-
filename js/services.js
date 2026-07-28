/* 核心服务：TTS 朗读 / 词典查询 / 翻译
 * 设计原则：全部走免费、无需 Key 的接口；翻译多链路兜底，优先选用国内可达的服务。
 */

/* ---------- 跨会话缓存：翻译/词典结果持久化到 localStorage，重复查词即时返回，刷新后依然快 ---------- */
function hydrateCache(key) {
  try {
    const a = JSON.parse(localStorage.getItem(key) || '[]');
    const m = new Map();
    if (Array.isArray(a)) for (const kv of a) m.set(kv[0], kv[1]);
    return m;
  } catch (e) { return new Map(); }
}
const _persistTimers = {};
function persistCache(key, map, cap) {
  clearTimeout(_persistTimers[key]);
  _persistTimers[key] = setTimeout(() => {
    try { localStorage.setItem(key, JSON.stringify([...map.entries()].slice(-cap))); } catch (e) {}
  }, 400);
}

/* ---------- TTS（Web Speech API，浏览器内置，免费） ---------- */
const TTS = (() => {
  let voices = [];
  let warmed = false;
  let pending = null;

  function loadVoices() {
    try { voices = window.speechSynthesis ? (speechSynthesis.getVoices() || []) : []; }
    catch (e) { voices = []; }
    if (voices.length) warmed = true;
  }

  function pickVoice() {
    if (!voices.length) return null;
    return voices.find(v => /natural|online|neural/i.test(v.name) && /en(-US)?$/i.test(v.lang))
      || voices.find(v => /^en(-US)?$/i.test(v.lang))
      || voices.find(v => v.lang && v.lang.toLowerCase().startsWith('en'))
      || null;
  }

  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.onvoiceschanged = () => {
      loadVoices();
      if (pending) { const p = pending; pending = null; speak(p.text, p.rate, { onEnd: p.onEnd, retry: true }); }
    };
  }

  /* opts: 支持三种形式（向后兼容旧调用）
   *  - 函数 onEnd：朗读结束（或出错）回调，连续朗读靠它自动翻页
   *  - 布尔 isRetry：仅用于预热重试（不再预热时二次预热）
   *  - 对象 { onEnd, retry } */
  function speak(text, rate, opts) {
    if (!('speechSynthesis' in window) || !text) return;
    let onEnd = null, isRetry = false;
    if (typeof opts === 'function') onEnd = opts;
    else if (typeof opts === 'boolean') isRetry = opts;
    else if (opts && typeof opts === 'object') { onEnd = opts.onEnd || null; isRetry = !!opts.retry; }
    /* 冷启动时浏览器会吞掉首次合成：先预热嗓音，就绪后再播 */
    if (!warmed && !isRetry) {
      loadVoices();
      if (!voices.length) { pending = { text, rate, onEnd }; return; }
    }
    try { speechSynthesis.cancel(); } catch (e) {}
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = 'en-US';
    u.rate = rate || 0.95;
    if (onEnd) {
      /* onerror（如嗓音缺失）也触发 onEnd，避免连续朗读卡在等待中 */
      u.onend = () => { try { onEnd(); } catch (e) {} };
      u.onerror = () => { try { onEnd(); } catch (e) {} };
    }
    speechSynthesis.speak(u);
  }

  return {
    speak,
    stop() { if ('speechSynthesis' in window) try { speechSynthesis.cancel(); } catch (e) {} },
    hasVoice() { return !!pickVoice(); }
  };
})();

/* ---------- 词典（dictionaryapi.dev，免费无 Key） ---------- */
const Dict = (() => {
  const cache = hydrateCache('en-reader-dict');
  async function lookup(word) {
    const w = (word || '').toLowerCase();
    if (cache.has(w)) return cache.get(w);
    const result = { word: w, phonetic: '', audio: '', meanings: [] };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w), { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const entry = Array.isArray(data) ? data[0] : null;
        if (entry) {
          result.phonetic = entry.phonetic || (entry.phonetics.find(p => p.text) || {}).text || '';
          result.audio = (entry.phonetics.find(p => p.audio) || {}).audio || '';
          for (const m of (entry.meanings || []).slice(0, 3)) {
            result.meanings.push({
              pos: m.partOfSpeech,
              def: (m.definitions[0] || {}).definition || '',
              example: (m.definitions[0] || {}).example || ''
            });
          }
        }
      }
    } catch (e) { /* 网络失败时静默，仍返回骨架 */ }
    cache.set(w, result);
    if (result.phonetic || result.meanings.length) persistCache('en-reader-dict', cache, 1500);
    return result;
  }
  return { lookup };
})();

/* ---------- 翻译（多链路竞速，优先快且稳的路径） ---------- */
const Translator = (() => {
  const cache = hydrateCache('en-reader-trans');
  /* 启动时清理历史误缓存的 mock 翻译（tools/serve.js 旧版污染过 /api/translate） */
  for (const [k, v] of cache) {
    if (typeof v === 'string' && /^MOCK翻译/.test(v)) cache.delete(k);
  }
  persistCache('en-reader-trans', cache, 1500);
  const enc = encodeURIComponent;

  /* 用户自建代理（settings.translateProxy）。POST {text,from,to} -> {translatedText}。
     推荐：Cloudflare Worker 代理 Google 翻译（见 worker/ 目录）。中国网络可达、免费、快、稳定。
     注意：浏览器里直接请求 translate.googleapis.com 会被 CORS 拦截，故只能通过“自建代理”间接使用。 */
  async function viaProxy(text, proxyUrl) {
    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from: 'en', to: 'zh-CN' }),
      signal: AbortSignal.timeout(7000)
    });
    if (!res.ok) throw new Error('proxy ' + res.status);
    const data = await res.json().catch(() => ({}));
    const out = data.translatedText || data.text || '';
    if (!out) throw new Error('proxy empty');
    return out;
  }

  /* 同源内置翻译（仅部署到 Cloudflare Pages 时存在 /api/translate）。
     本地开发无此端点 -> fetch 快速失败，自然回退到 Lingva/MyMemory。
     部署后所有访客默认可用，无需各自搭建代理，且同源无 CORS 问题。 */
  async function viaSameOrigin(text) {
    const res = await fetch(location.origin + '/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from: 'en', to: 'zh-CN' }),
      signal: AbortSignal.timeout(7000)
    });
    if (!res.ok) throw new Error('sameorigin ' + res.status);
    const data = await res.json().catch(() => ({}));
    const out = data.translatedText || '';
    if (!out) throw new Error('sameorigin empty');
    return out;
  }

  /* MyMemory：免费无 Key、CORS 可用（匿名 5000 词/日）。慢但稳，作兜底。 */
  async function viaMyMemory(text) {
    const url = 'https://api.mymemory.translated.net/get?q=' + enc(text.slice(0, 480)) + '&langpair=en|zh-CN';
    const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!res.ok) throw new Error('mymemory ' + res.status);
    const data = await res.json();
    if (data.responseStatus !== 200 && data.responseStatus !== '200') throw new Error('mymemory ' + data.responseStatus);
    const out = (data.responseData && data.responseData.translatedText) || '';
    if (!out || /MYMEMORY WARNING/i.test(out)) throw new Error('mymemory quota');
    return out;
  }

  /* Lingva：代理 Google 翻译，免费、CORS 可用；部分网络偶尔不通，作并行备选提速。 */
  async function viaLingva(text) {
    const url = 'https://lingva.ml/api/v1/en/zh-CN/' + enc(text.slice(0, 480));
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error('lingva ' + res.status);
    const data = await res.json().catch(() => ({}));
    const out = data.translation || '';
    if (!out) throw new Error('lingva empty');
    return out;
  }

  async function translate(text, proxyUrl) {
    const key = (text || '').trim();
    if (!key) return '';
    if (cache.has(key)) {
      const cached = cache.get(key);
      /* 旧版 serve.js 曾误带 mock /api/translate，浏览器可能缓存了“MOCK翻译:原文”。
       * 检测到 mock 残留时丢弃，重新走真实翻译链路。 */
      if (typeof cached === 'string' && !/^MOCK翻译/.test(cached)) return cached;
      cache.delete(key);
    }
    const tasks = [];
    /* 优先级：用户自建代理（最快最稳） > 同源内置 /api/translate（部署态默认可用）
       > Lingva（Google 代理，常更快） > MyMemory（兜底）。
       本地无 /api/translate 时该任务快速失败，自动回退。 */
    if (proxyUrl) tasks.push(() => viaProxy(text, proxyUrl));
    tasks.push(() => viaSameOrigin(text));
    tasks.push(() => viaLingva(text));
    tasks.push(() => viaMyMemory(text));
    /* 并行竞速：哪个翻译服务先返回有效结果就用哪个 */
    let out = '';
    try {
      out = await Promise.any(tasks.map(t => t().then(r => {
        const s = String(r || '').trim();
        if (!s) throw new Error('empty');
        /* 部分服务（如 MyMemory）查不到时直接把原文当译文返回 —— 视为无效，继续竞速 */
        if (s.toLowerCase() === key.toLowerCase()) throw new Error('echo');
        return s;
      })));
    } catch (e) { out = ''; }
    if (!out) out = '（翻译服务暂不可用或已达每日限额。可在「设置 → 翻译代理」填入自建代理获得稳定快速的翻译）';
    if (cache.size < 2000) cache.set(key, out);
    if (out && !out.startsWith('（翻译服务')) persistCache('en-reader-trans', cache, 1500);
    return out;
  }

  /* 提前建链：缩短首次点击的翻译延迟。若已配置代理则预热代理连接 + CORS 预检缓存。 */
  function warmup(proxyUrl) {
    const fire = (url, opts) => { try { fetch(url, opts).catch(() => {}); } catch (e) {} };
    if (proxyUrl) {
      fire(proxyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi', from: 'en', to: 'zh-CN' }) });
    } else {
      fire(location.origin + '/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi', from: 'en', to: 'zh-CN' }) });
      fire('https://api.mymemory.translated.net/get?q=hi&langpair=en|zh-CN');
      fire('https://lingva.ml/api/v1/en/zh-CN/hi');
    }
  }

  return { translate, warmup };
})();
