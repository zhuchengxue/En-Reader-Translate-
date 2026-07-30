const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve('F:/Workbuddy/英文网页阅读器');
const PORT = 8931;
const PROXY = 8932;
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.txt':'text/plain', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' };

/* 本地测试用的同步 KV（内存版），与生产 functions/api/sync.js 行为一致：
 * PUT 时合并保留已有 _file，防止元数据推送把文件覆盖掉。 */
const SYNC_KV = new Map();
function mergeSyncData(token, incoming) {
  const existing = SYNC_KV.get(token) || { books: [], vocab: [] };
  const fileMap = new Map();
  for (const b of existing.books || []) {
    if (b._file) fileMap.set(b.id, { _file: b._file, _fileSize: b._fileSize });
  }
  const mergedBooks = [];
  for (const b of incoming.books || []) {
    const kept = fileMap.get(b.id);
    if (kept && !b._file) mergedBooks.push({ ...b, _file: kept._file, _fileSize: kept._fileSize });
    else mergedBooks.push(b);
  }
  const merged = { books: mergedBooks, vocab: incoming.vocab || [] };
  SYNC_KV.set(token, merged);
  return merged;
}

function serve(root, port) {
  const rootNorm = path.resolve(root);
  return new Promise(res => {
    const srv = http.createServer((req, r) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/api/translate') {
        let b = '';
        req.on('data', c => b += c);
        req.on('end', () => {
          let text = '';
          try { text = (JSON.parse(b).text || '').toString(); } catch (e) {}
          r.writeHead(200, { 'Content-Type': 'application/json' });
          r.end(JSON.stringify({ translatedText: 'MOCK翻译:' + text }));
        });
        return;
      }
      if (p === '/api/sync') {
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
        if (req.method === 'OPTIONS') { r.writeHead(204, cors); r.end(); return; }
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'GET') {
          const token = (url.searchParams.get('token') || '').trim().slice(0, 64);
          if (!token) { r.writeHead(400, cors); r.end(JSON.stringify({ error: 'Missing token' })); return; }
          const data = SYNC_KV.get('sync:' + token) || { books: [], vocab: [] };
          r.writeHead(200, cors); r.end(JSON.stringify({ data, ts: Date.now() }));
          return;
        }
        if (req.method === 'PUT') {
          let b = '';
          req.on('data', c => b += c);
          req.on('end', () => {
            let body = {};
            try { body = JSON.parse(b); } catch (e) {}
            const token = (body.token || '').toString().trim().slice(0, 64);
            if (!token) { r.writeHead(400, cors); r.end(JSON.stringify({ error: 'Missing token' })); return; }
            if (!body.data || !body.data.books) { r.writeHead(400, cors); r.end(JSON.stringify({ error: 'Missing data' })); return; }
            mergeSyncData('sync:' + token, body.data);
            r.writeHead(200, cors); r.end(JSON.stringify({ ok: true, ts: Date.now() }));
          });
          return;
        }
        r.writeHead(405, cors); r.end('Method not allowed');
        return;
      }
      if (p === '/') p = '/index.html';
      const fp = path.normalize(path.join(rootNorm, p));
      if (!fp.startsWith(rootNorm) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { r.writeHead(404); r.end('nf'); return; }
      r.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(r);
    });
    srv.listen(port, '127.0.0.1', () => res(srv));
  });
}

/* 模拟用户的自建翻译代理（行为同 Cloudflare Worker：处理 CORS 预检 + POST {text} -> {translatedText}） */
function serveProxy(port) {
  return new Promise(res => {
    const srv = http.createServer((req, r) => {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
      if (req.method === 'OPTIONS') { r.writeHead(204, cors); r.end(); return; }
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let text = '';
        try { text = JSON.parse(body).text || ''; } catch (e) {}
        r.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        r.end(JSON.stringify({ translatedText: 'MOCK翻译:' + text }));
      });
    });
    srv.listen(port, '127.0.0.1', () => res(srv));
  });
}

/* 坐标命中测试：在容器内找一个真实单词的视口中心坐标（验证新的 caretRangeFromPoint 取词，
 * 不再依赖 .w span）。isIframe=true 时从 EPUB iframe 取词并叠加 iframe 偏移。
 * 两遍扫描：第一遍只接受落在可见区内的单词（EPUB 分页会把相邻页藏到屏外，rect 有宽度但落在可见区外）；
 * 找不到再退化为任意有宽度的单词，避免 epub.js 渲染时序抖动导致的偶发 null。 */
async function findWordPoint(page, sel, isIframe) {
  return await page.evaluate(({ sel, isIframe }) => {
    let rootDoc = document, base = { x: 0, y: 0 }, frameEl = null;
    if (isIframe) {
      const f = document.querySelector(sel);
      if (!f || !f.contentDocument) return null;
      rootDoc = f.contentDocument;
      frameEl = f;
      const fr = f.getBoundingClientRect();
      base = { x: fr.x, y: fr.y };
    } else {
      if (!document.querySelector(sel)) return null;
    }
    const root = isIframe ? rootDoc.body : document.querySelector(sel);
    const inRect = (r) => r && r.width > 0 && r.height >= 0;
    const inView = (r) => isIframe
      ? (r.left >= 0 && r.top >= 0 && r.right <= (frameEl ? frameEl.clientWidth : 1e9) && r.bottom <= (frameEl ? frameEl.clientHeight : 1e9))
      : (r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight);
    const walker = rootDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.parentElement) return NodeFilter.FILTER_REJECT;
        if (n.parentElement.closest('.dict-popup,.sent-popup,.settings-panel,.toc-drawer,.mask,.tool-btn,.swatch')) return NodeFilter.FILTER_REJECT;
        return /[A-Za-z]{3,}/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let n, candidates = [];
    while ((n = walker.nextNode())) {
      const m = n.nodeValue.match(/[A-Za-z]{3,}/);
      if (!m) continue;
      const idx = m.index;
      const range = rootDoc.createRange();
      range.setStart(n, idx); range.setEnd(n, idx + m[0].length);
      const r = range.getBoundingClientRect();
      if (!inRect(r)) continue;
      candidates.push({ r, pt: { x: Math.round(base.x + r.x + r.width / 2), y: Math.round(base.y + r.y + r.height / 2), word: m[0] } });
    }
    if (!candidates.length) return null;
    const inside = candidates.filter(c => inView(c.r));
    const best = inside.length ? inside[0] : candidates[0];
    return best.pt;
  }, { sel, isIframe });
}

/* 带重试的取词：等待阅读器懒加载 / 分页渲染完成，最多重试若干次。 */
async function findWordPointRetry(page, sel, isIframe, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const p = await findWordPoint(page, sel, isIframe);
    if (p) return p;
    await page.waitForTimeout(400);
  }
  return null;
}

/* 点击前清空词典卡片，避免上一轮残留内容造成「可翻译」误判（假阳性） */
async function clearDictPopup(page) {
  await page.evaluate(() => {
    const p = document.querySelector('#dict-popup');
    if (p) p.classList.add('hidden');
    const b = document.querySelector('#dict-body');
    if (b) b.textContent = '查询中…';
  });
}
async function clearSentPopup(page) {
  await page.evaluate(() => {
    const p = document.querySelector('#sent-popup');
    if (p) { p.classList.remove('open'); const z = document.querySelector('#sent-zh'); if (z) z.textContent = '翻译中…'; }
  });
}

(async () => {
  const srv = await serve(ROOT, PORT);
  const proxy = await serveProxy(PROXY);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (/Failed to load resource|status of 4|status of 5/i.test(t)) return; logs.push(t); } });
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
  /* 书签命名用 window.prompt，自动接受（移动端 mpage 不注册，不影响） */
  page.on('dialog', d => { try { d.accept('测试书签'); } catch (e) {} });

  const results = [];
  const check = (name, cond, extra) => { results.push({ name, pass: !!cond, extra: extra || '' }); };
  const BASE = `http://127.0.0.1:${PORT}/index.html`;

  await page.goto(BASE);
  await page.waitForTimeout(500);

  // 导入三种格式
  const samples = ['samples/The-Great-Gatsby-Sample.txt', 'samples/test.epub', 'samples/test.pdf'];
  const fi = await page.waitForSelector('#file-input', { state: 'attached' });
  await fi.setInputFiles(samples.map(s => path.join(ROOT, s)));
  await page.waitForTimeout(3000);
  const shelf = await page.evaluate(() => document.querySelectorAll('#shelf-grid .book-card').length);
  check('导入三种格式', shelf === 3, 'shelf=' + shelf);

  const openByTitle = async (sub) => {
    await page.evaluate((t) => {
      const cards = [...document.querySelectorAll('#shelf-grid .book-card')];
      const c = cards.find(x => x.querySelector('.book-name').textContent.toLowerCase().includes(t.toLowerCase()));
      c && c.click();
    }, sub);
  };
  const waitLoading = async () => page.waitForFunction(() => document.querySelector('#loading').classList.contains('hidden'), { timeout: 15000 }).catch(() => {});

  // 配置自建代理
  await openByTitle('Gatsby'); await waitLoading();
  await page.waitForSelector('#reader-container .txt-content', { timeout: 10000 }).catch(() => {});
  const txtPt = await findWordPoint(page, '#reader-container', false);
  check('TXT 找到可点单词', !!txtPt, JSON.stringify(txtPt));
  await page.evaluate((url) => {
    const i = document.querySelector('#proxy-input');
    i.value = url;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, `http://127.0.0.1:${PROXY}/translate`);
  const proxyStatus = await page.evaluate(() => document.querySelector('#proxy-status').textContent);
  check('代理 UI 状态更新', /未测试|已设置/.test(proxyStatus), proxyStatus);

  // 单击单词：翻译 + 发音（坐标点击，验证 caret 命中取词）
  await clearDictPopup(page);
  await page.evaluate(() => { window.__speak = 0; const o = window.speechSynthesis.speak.bind(window.speechSynthesis); window.speechSynthesis.speak = (u) => { window.__speak++; return o(u); }; });
  await page.mouse.click(txtPt.x, txtPt.y);
  await page.waitForFunction(() => !document.querySelector('#dict-popup').classList.contains('hidden'), { timeout: 5000 }).catch(() => {});
  let t0 = Date.now();
  let txtDict = '查询中…';
  while (Date.now() - t0 < 12000) { txtDict = await page.evaluate(() => document.querySelector('#dict-body').innerText); if (txtDict !== '查询中…') break; await page.waitForTimeout(120); }
  const txtTTS = await page.evaluate(() => window.__speak);
  const txtPopupOpen = await page.evaluate(() => !document.querySelector('#dict-popup').classList.contains('hidden'));
  check('TXT 单击可翻译(代理快)', txtPopupOpen && /MOCK翻译/.test(txtDict), 'ms=' + (Date.now() - t0) + ' open=' + txtPopupOpen + ' body=' + txtDict.slice(0, 30));
  check('TXT 单击可发音', txtTTS > 0, 'TTS=' + txtTTS);

  // 词典卡片位置稳定（不跳动）
  const pos1 = await page.evaluate(() => { const r = document.querySelector('#dict-popup').getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; });
  await page.waitForTimeout(1600);
  const pos2 = await page.evaluate(() => { const r = document.querySelector('#dict-popup').getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; });
  check('词典卡片不跳动(位置稳定)', pos1.top === pos2.top && pos1.left === pos2.left, JSON.stringify({ pos1, pos2 }));

  // 负向回归：点击左侧页边距空白处【不得】触发翻译（揪出「点哪都翻译」回潮）
  const blankPt = await page.evaluate(() => {
    const r = document.querySelector('#reader-container').getBoundingClientRect();
    return { x: Math.round(r.left) + 6, y: Math.round(r.top) + Math.round(r.height / 2) };
  });
  await page.mouse.click(blankPt.x, blankPt.y);
  await page.waitForTimeout(300);
  const blankDictHidden = await page.evaluate(() => document.querySelector('#dict-popup').classList.contains('hidden'));
  check('TXT 点空白不翻译(页边距)', blankDictHidden, 'hidden=' + blankDictHidden);

  // 双击单词：现在只选中整句，不再弹出整句翻译
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await clearSentPopup(page);
  const cw = await findWordPoint(page, '#reader-container', false);
  await page.mouse.dblclick(cw.x, cw.y);
  await page.waitForTimeout(300);
  const selInfo = await page.evaluate(() => ({ text: window.getSelection().toString() }));
  check('双击自动选中整句(高亮)', !!cw.word && selInfo.text.toLowerCase().includes(cw.word.toLowerCase()) && selInfo.text.length > cw.word.length, 'selLen=' + selInfo.text.length + ' word=' + cw.word);
  const sentClosed = await page.evaluate(() => !document.querySelector('#sent-popup').classList.contains('open'));
  check('双击不再翻译整句(弹层关闭)', sentClosed);

  // 设置「单击单词 → 翻译句子」后，单击单词应弹出整句翻译
  await page.evaluate(() => { document.querySelector('#btn-settings').click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#click-mode-seg button')].find(x => x.dataset.m === 'sentence');
    if (b) b.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const b = document.querySelector('#settings-close'); if (b) b.click(); });
  await page.waitForTimeout(300);
  const modeCheck = await page.evaluate(() => (JSON.parse(localStorage.getItem('en-reader-settings') || '{}')).clickMode);
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await clearSentPopup(page);
  const sw = await findWordPoint(page, '#reader-container', false);
  const t1 = Date.now();
  if (sw) await page.mouse.click(sw.x, sw.y);
  let sentOk = false, inlineBold = false, boldTxt = '';
  while (Date.now() - t1 < 12000) {
    const r = await page.evaluate(() => {
      const p = document.querySelector('#sent-popup');
      const zh = document.querySelector('#sent-zh').textContent;
      const b = document.querySelector('#sent-zh b.kw');
      return { open: p.classList.contains('open'), zh, boldText: b ? b.textContent : '' };
    });
    if (r.open && /MOCK翻译/.test(r.zh)) { sentOk = true; inlineBold = !!r.boldText; boldTxt = r.boldText; break; }
    await page.waitForTimeout(120);
  }
  check('单击单词(翻译句子模式)可翻译整句[' + modeCheck + ']', sentOk);
  check('句中词在译文内联加粗', inlineBold, 'bold=' + boldTxt);
  // 恢复默认模式，避免影响后续测试
  await page.evaluate(() => { document.querySelector('#btn-settings').click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#click-mode-seg button')].find(x => x.dataset.m === 'both');
    if (b) b.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const b = document.querySelector('#settings-close'); if (b) b.click(); });
  await page.waitForTimeout(300);

  // 书签：添加 / 列表 / 跳转
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector('#btn-bookmark').click());
  await page.waitForTimeout(300);
  const bmOpen = await page.evaluate(() => document.querySelector('#bookmark-drawer').classList.contains('open'));
  check('书签抽屉可打开', bmOpen);
  const bmBefore = await page.evaluate(() => document.querySelectorAll('#bookmark-list .bm-item').length);
  await page.evaluate(() => document.querySelector('#btn-bm-add').click());
  await page.waitForTimeout(400);
  const bmAfter = await page.evaluate(() => document.querySelectorAll('#bookmark-list .bm-item').length);
  check('书签添加成功', bmAfter === bmBefore + 1, 'before=' + bmBefore + ' after=' + bmAfter);
  const bmCtx = await page.evaluate(() => {
    const item = document.querySelector('#bookmark-list .bm-item');
    const t = item && item.querySelector('.bm-title');
    const x = item && item.querySelector('.bm-text');
    return { hasTitle: !!(t && t.textContent.trim()), hasText: !!(x && x.textContent.trim()) };
  });
  check('书签保留标题', bmCtx.hasTitle, JSON.stringify(bmCtx));
  check('书签保留文字', bmCtx.hasText, JSON.stringify(bmCtx));
  await page.evaluate(() => { const j = document.querySelector('#bookmark-list .bm-jump'); j && j.click(); });
  await page.waitForTimeout(300);
  const bmClosed = await page.evaluate(() => !document.querySelector('#bookmark-drawer').classList.contains('open'));
  check('书签跳转后关闭抽屉', bmClosed);

  // 朗读：连续朗读（会话内静默 TTS，仅验证触发 / 按钮态 / 跟随高亮）
  await page.evaluate(() => {
    window.__speak = 0;
    window.speechSynthesis.speak = () => { window.__speak++; };
    const g = window.speechSynthesis.getVoices.bind(window.speechSynthesis);
    window.speechSynthesis.getVoices = () => { const v = g(); return (v && v.length) ? v : [{ name: 'Google US English', lang: 'en-US' }]; };
  });
  await page.evaluate(() => document.querySelector('#btn-read').click());
  await page.waitForTimeout(400);
  const reading = await page.evaluate(() => ({ txt: document.querySelector('#btn-read').textContent, speak: window.__speak }));
  check('连续朗读开始(按钮变停止+TTS)', /停止/.test(reading.txt) && reading.speak > 0, JSON.stringify(reading));
  const hlCount = await page.evaluate(() => document.querySelectorAll('#reader-container .tts-hl, #reader-container .tts-sent').length);
  check('朗读跟随文字(高亮节点)', hlCount > 0, 'hl=' + hlCount);
  await page.evaluate(() => document.querySelector('#btn-read').click());
  await page.waitForTimeout(200);
  const stopped = await page.evaluate(() => document.querySelector('#btn-read').textContent);
  check('连续朗读可停止', /朗读/.test(stopped), 'txt=' + stopped);

  // 翻页效果设置 + 全屏退出浮钮 + 设置关闭按钮
  const paSeg = await page.evaluate(() => !!document.querySelector('#pageanim-seg'));
  check('翻页效果设置存在', paSeg);
  const fsFab = await page.evaluate(() => !!document.querySelector('#fs-exit-fab'));
  check('全屏退出浮钮存在', fsFab);
  // 验证设置面板关闭 X 存在且可点击关闭
  const settingsClose = await page.evaluate(() => !!document.querySelector('#settings-close'));
  check('设置面板关闭X存在', settingsClose);
  await page.evaluate(() => { document.querySelector('#btn-settings').click(); });
  await page.waitForTimeout(400);
  await page.evaluate(() => { const b = document.querySelector('#settings-close'); if (b) b.click(); });
  await page.waitForTimeout(400);
  const settingsClosedAfterX = await page.evaluate(() => !document.querySelector('#settings-panel').classList.contains('open'));
  check('设置面板X可关闭', settingsClosedAfterX);
  await page.evaluate(() => { const b = [...document.querySelectorAll('#pageanim-seg button')].find(x => x.dataset.pa === 'fade'); b && b.click(); });
  const paStored = await page.evaluate(() => (JSON.parse(localStorage.getItem('en-reader-settings') || '{}')).pageAnim);
  check('翻页效果可切换(fade)', paStored === 'fade', 'stored=' + paStored);

  // EPUB 单击（iframe 坐标命中）
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await openByTitle('Test English'); await page.waitForTimeout(2000); await waitLoading();
  await page.waitForSelector('.epub-holder iframe', { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => {
    const f = document.querySelector('.epub-holder iframe');
    return f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerText.trim().length > 3;
  }, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__speak = 0; const o = window.speechSynthesis.speak.bind(window.speechSynthesis); window.speechSynthesis.speak = (u) => { window.__speak++; return o(u); }; });
  const epubPt = await findWordPointRetry(page, '.epub-holder iframe', true);
  check('EPUB 找到可点单词', !!epubPt, JSON.stringify(epubPt));
  await clearDictPopup(page);
  if (epubPt) await page.mouse.click(epubPt.x, epubPt.y);
  await page.waitForFunction(() => !document.querySelector('#dict-popup').classList.contains('hidden'), { timeout: 5000 }).catch(() => {});
  t0 = Date.now(); let epubDict = '查询中…';
  while (Date.now() - t0 < 12000) { epubDict = await page.evaluate(() => document.querySelector('#dict-body').innerText); if (epubDict !== '查询中…') break; await page.waitForTimeout(120); }
  const epubPopupOpen = await page.evaluate(() => !document.querySelector('#dict-popup').classList.contains('hidden'));
  check('EPUB 单击可翻译', epubPopupOpen && /MOCK翻译/.test(epubDict), 'open=' + epubPopupOpen + ' body=' + epubDict.slice(0, 24));

  // PDF 单击（文本层坐标命中 + .w 回退）
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await openByTitle('test'); await page.waitForTimeout(2500); await waitLoading();
  await page.waitForSelector('.textLayer span', { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => { window.__speak = 0; const o = window.speechSynthesis.speak.bind(window.speechSynthesis); window.speechSynthesis.speak = (u) => { window.__speak++; return o(u); }; });
  const pdfPt = await findWordPointRetry(page, '.textLayer', false);
  check('PDF 找到可点单词', !!pdfPt, JSON.stringify(pdfPt));
  await clearDictPopup(page);
  if (pdfPt) await page.mouse.click(pdfPt.x, pdfPt.y);
  await page.waitForFunction(() => !document.querySelector('#dict-popup').classList.contains('hidden'), { timeout: 5000 }).catch(() => {});
  t0 = Date.now(); let pdfDict = '查询中…';
  while (Date.now() - t0 < 12000) { pdfDict = await page.evaluate(() => document.querySelector('#dict-body').innerText); if (pdfDict !== '查询中…') break; await page.waitForTimeout(120); }
  const pdfPopupOpen = await page.evaluate(() => !document.querySelector('#dict-popup').classList.contains('hidden'));
  check('PDF 单击可翻译', pdfPopupOpen && /MOCK翻译/.test(pdfDict), 'open=' + pdfPopupOpen + ' body=' + pdfDict.slice(0, 24));

  // 持久化：刷新后仍在书中（不关闭）
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('en-reader-settings')||'{}'); s.autoResumeBook = true; localStorage.setItem('en-reader-settings', JSON.stringify(s)); });
  await page.reload(); await page.waitForTimeout(2500); await waitLoading();
  const persisted = await page.evaluate(() => ({ view: document.body.dataset.view, hasReader: !!document.querySelector('#reader-container .txt-viewport, #reader-container .epub-holder, #reader-container .pdf-stage'), last: (JSON.parse(localStorage.getItem('en-reader-settings')||'{}')).lastBookId }));
  check('刷新后仍在书中', persisted.view === 'reader' && persisted.hasReader, JSON.stringify(persisted));

  // 书签持久化：重新打开 TXT，书签仍在；并测试删除
  await openByTitle('Gatsby'); await page.waitForTimeout(2500); await waitLoading();
  await page.waitForSelector('#reader-container .txt-content', { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => document.querySelector('#btn-bookmark').click());
  await page.waitForTimeout(300);
  const bmPersist = await page.evaluate(() => document.querySelectorAll('#bookmark-list .bm-item').length);
  check('书签刷新后持久化', bmPersist >= 1, 'count=' + bmPersist);
  const bmDelBefore = bmPersist;
  await page.evaluate(() => { const d = document.querySelector('#bookmark-list .bm-del'); d && d.click(); });
  await page.waitForTimeout(300);
  const bmDelAfter = await page.evaluate(() => document.querySelectorAll('#bookmark-list .bm-item').length);
  check('书签可删除', bmDelAfter === bmDelBefore - 1, 'before=' + bmDelBefore + ' after=' + bmDelAfter);
  await page.evaluate(() => document.querySelector('#btn-bm-close').click());

  // 响应式：窄窗口无横向溢出
  await page.setViewportSize({ width: 820, height: 600 }); await page.waitForTimeout(400);
  const narrow = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth <= window.innerWidth + 1, view: document.body.dataset.view }));
  check('窄窗口无横向溢出', narrow.overflow, JSON.stringify(narrow));
  await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(300);

  // 内置同源翻译（部署态默认、无自建代理时走 /api/translate）
  const soOk = await page.evaluate(async () => {
    try {
      const s = JSON.parse(localStorage.getItem('en-reader-settings') || '{}');
      s.translateProxy = '';
      localStorage.setItem('en-reader-settings', JSON.stringify(s));
      return await Translator.translate('builtinEndpointTestWord', '');
    } catch (e) { return 'ERR:' + e.message; }
  });
  check('内置同源翻译可用(/api/translate)', /MOCK翻译/.test(soOk), soOk.slice(0, 40));

  check('无控制台错误', logs.length === 0, logs.join(' | ').slice(0, 200));

  // ===== 移动端触摸：单击单词翻译、双击只选中句子 =====
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mpage = await mctx.newPage();
  mpage.on('pageerror', e => logs.push('MOBILE PAGEERROR: ' + e.message));
  await mpage.goto(BASE);
  await mpage.waitForTimeout(400);
  const mfi = await mpage.waitForSelector('#file-input', { state: 'attached' });
  await mfi.setInputFiles([path.join(ROOT, 'samples/The-Great-Gatsby-Sample.txt')]);
  await mpage.waitForTimeout(3000);
  await mpage.evaluate(() => { const c = [...document.querySelectorAll('#shelf-grid .book-card')][0]; c && c.click(); });
  await mpage.waitForSelector('#reader-container .txt-content', { timeout: 10000 }).catch(() => {});
  await mpage.waitForTimeout(800);
  const mcenter = await findWordPoint(mpage, '#reader-container', false);
  check('移动端找到可点单词', !!mcenter, JSON.stringify(mcenter));
  if (mcenter) {
    await clearDictPopup(mpage);
    await clearSentPopup(mpage);
    await mpage.touchscreen.tap(mcenter.x, mcenter.y);
    await mpage.waitForFunction(() => !document.querySelector('#dict-popup').classList.contains('hidden'), { timeout: 5000 }).catch(() => {});
    let t0 = Date.now(); let mDict = '查询中…';
    while (Date.now() - t0 < 12000) { mDict = await mpage.evaluate(() => document.querySelector('#dict-body').innerText); if (mDict !== '查询中…') break; await mpage.waitForTimeout(120); }
    const mPopupOpen = await mpage.evaluate(() => !document.querySelector('#dict-popup').classList.contains('hidden'));
    check('移动端单击单词可翻译', mPopupOpen && /MOCK翻译/.test(mDict), 'open=' + mPopupOpen + ' body=' + mDict.slice(0, 24));

    await mpage.keyboard.press('Escape');
    await mpage.waitForTimeout(400);

    // 双击：合成 Touch 事件，精确控制 150ms 间隔；现在只选中句子，不翻译
    await clearSentPopup(mpage);
    await mpage.evaluate(({ x, y }) => new Promise(res => {
      const doc = document;
      const fire = (type) => {
        const t = new Touch({ identifier: 1, target: doc.elementFromPoint(x, y), clientX: x, clientY: y, pageX: x, pageY: y });
        const ev = new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t] });
        doc.dispatchEvent(ev);
      };
      fire('touchstart'); fire('touchend');
      setTimeout(() => { fire('touchstart'); fire('touchend'); res(); }, 150);
    }), { x: mcenter.x, y: mcenter.y });
    await mpage.waitForTimeout(1500);
    const mSel = await mpage.evaluate(() => ({ text: window.getSelection().toString(), sentOpen: document.querySelector('#sent-popup').classList.contains('open') }));
    check('移动端双击只选中句子(不翻译)', !!mcenter.word && mSel.text.toLowerCase().includes(mcenter.word.toLowerCase()) && mSel.text.length > mcenter.word.length && !mSel.sentOpen, JSON.stringify(mSel));
  }
  await mctx.close();

  // ===== 跨设备同步：A 导入并同步后，B 拉取应能打开同一本书 =====
  const SYNC_TOKEN = 'regression-sync-token';
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('en-reader-settings') || '{}'); s.autoResumeBook = false; localStorage.setItem('en-reader-settings', JSON.stringify(s)); });
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await page.goto(BASE); await page.waitForTimeout(800); // 回到书架
  // 设备 A：直接调用 SyncService 设置口令并推送
  const aSync = await page.evaluate(async (token) => {
    if (!window.SyncService) return { noService: true };
    SyncService.setToken(token);
    const merged = await SyncService.syncOnce();
    return { merged, tokenSet: SyncService.getToken(), online: navigator.onLine };
  }, SYNC_TOKEN);
  check('设备 A 同步推送成功', aSync.tokenSet === SYNC_TOKEN && aSync.merged >= 0, JSON.stringify(aSync));

  // 模拟 A 后续只改进度（元数据推送），不应把 KV 里的文件覆盖掉
  await page.evaluate(() => { const c = [...document.querySelectorAll('#shelf-grid .book-card')].find(x => x.querySelector('.book-name') && /Gatsby/i.test(x.querySelector('.book-name').textContent)); c && c.click(); });
  await page.waitForSelector('#reader-container .txt-content', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(() => { if (typeof reader !== 'undefined' && reader.next) reader.next(); });
  await page.waitForTimeout(1500);
  // 触发一次进度同步（元数据推送）
  const aMetaPush = await page.evaluate(async () => { if (!window.SyncService) return -1; await SyncService.syncOnce(); return 0; });
  await page.waitForTimeout(1500);

  // 设备 B：全新浏览器上下文，只同步不导入
  const bctx = await browser.newContext();
  const bpage = await bctx.newPage();
  bpage.on('pageerror', e => logs.push('SYNC-B PAGEERROR: ' + e.message));
  await bpage.goto(BASE);
  await bpage.waitForTimeout(800);
  await bpage.evaluate((token) => { if (window.SyncService) SyncService.setToken(token); }, SYNC_TOKEN);
  await bpage.goto(BASE); // 用 init 自动同步 + 渲染书架
  await bpage.waitForTimeout(2500);
  const bShelf = await bpage.evaluate(() => ({ count: document.querySelectorAll('#shelf-grid .book-card').length, names: [...document.querySelectorAll('#shelf-grid .book-name')].map(x => x.textContent).slice(0, 5), cloudCount: document.querySelectorAll('#shelf-grid .book-cloud').length }));
  check('设备 B 同步后能看到 A 的图书', bShelf.count >= 1, JSON.stringify(bShelf));
  check('设备 B 自动同步后图书已下载(无云朵标)', bShelf.cloudCount === 0, 'cloudCount=' + bShelf.cloudCount);
  // B 打开同步下来的书，不应提示“文件缺失”
  const bOpenOk = await bpage.evaluate(async () => {
    const c = [...document.querySelectorAll('#shelf-grid .book-card')].find(x => x.querySelector('.book-name') && /Gatsby/i.test(x.querySelector('.book-name').textContent));
    if (!c) return { found: false };
    c.click();
    await new Promise(r => setTimeout(r, 2500));
    return { found: true, view: document.body.dataset.view, hasReader: !!document.querySelector('#reader-container .txt-viewport, #reader-container .txt-content'), toast: document.querySelector('.toast') ? document.querySelector('.toast').textContent : '' };
  });
  check('设备 B 能打开同步下来的书', bOpenOk.found && bOpenOk.view === 'reader' && bOpenOk.hasReader && !/文件数据|文件尚未同步|重新导入/.test(bOpenOk.toast), JSON.stringify(bOpenOk));
  await bctx.close();

  await browser.close();
  srv.close(); proxy.close();

  const allPass = results.every(r => r.pass);
  for (const r of results) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
  console.log('=== 总判定:', allPass ? 'ALL PASS ✅' : 'HAS FAIL ❌', '===');
  process.exit(allPass ? 0 : 1);
})();
