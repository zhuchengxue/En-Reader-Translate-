const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve('F:/Workbuddy/英文网页阅读器');
const PORT = 8931;
const PROXY = 8932;
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.txt':'text/plain', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' };

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

  // 双击单词：自动选中整句 + 句子翻译 + 词在译文内联加粗
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await clearSentPopup(page);
  const cw = await findWordPoint(page, '#reader-container', false);
  t0 = Date.now();
  await page.mouse.dblclick(cw.x, cw.y);
  const selInfo = await page.evaluate(() => ({ text: window.getSelection().toString() }));
  check('双击自动选中整句(高亮)', !!cw.word && selInfo.text.toLowerCase().includes(cw.word.toLowerCase()) && selInfo.text.length > cw.word.length, 'selLen=' + selInfo.text.length + ' word=' + cw.word);
  const sentPos1 = await page.evaluate(() => { const r = document.querySelector('#sent-popup').getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; });
  let sentOk = false, inlineBold = false, boldTxt = '';
  while (Date.now() - t0 < 12000) {
    const r = await page.evaluate(() => {
      const p = document.querySelector('#sent-popup');
      const zh = document.querySelector('#sent-zh').textContent;
      const b = document.querySelector('#sent-zh b.kw');
      return { open: p.classList.contains('open'), zh, boldText: b ? b.textContent : '' };
    });
    if (r.open && /MOCK翻译/.test(r.zh)) { sentOk = true; inlineBold = !!r.boldText; boldTxt = r.boldText; break; }
    await page.waitForTimeout(120);
  }
  const sentPos2 = await page.evaluate(() => { const r = document.querySelector('#sent-popup').getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; });
  check('双击翻译整句', sentOk);
  check('双击词在译文中内联加粗(不再单独提取)', inlineBold, 'bold=' + boldTxt);
  check('句子弹层不跳动(位置稳定)', sentPos1.top === sentPos2.top && sentPos1.left === sentPos2.left, JSON.stringify({ sentPos1, sentPos2 }));
  const anchor = await page.evaluate(() => { const p = document.querySelector('#sent-popup').getBoundingClientRect(); return { top: Math.round(p.top), bottom: Math.round(p.bottom), vh: window.innerHeight }; });
  check('句子弹层锚定单词附近(非底部)', anchor.top > 0 && anchor.bottom < anchor.vh - 5, JSON.stringify(anchor));
  const ov = await page.evaluate(() => {
    const p = document.querySelector('#sent-popup').getBoundingClientRect();
    const sel = window.getSelection();
    const r = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    if (!r) return { ok: true, reason: 'no-sel' };
    const overlapY = Math.min(p.bottom, r.bottom) - Math.max(p.top, r.top);
    return { ok: overlapY <= 2, overlapY: Math.round(overlapY) };
  });
  check('句子弹层不遮挡选中句', ov.ok, JSON.stringify(ov));

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
  await page.reload(); await page.waitForTimeout(2500); await waitLoading();
  const persisted = await page.evaluate(() => ({ view: document.body.dataset.view, hasReader: !!document.querySelector('#reader-container .txt-viewport, #reader-container .epub-holder, #reader-container .pdf-stage'), last: (JSON.parse(localStorage.getItem('en-reader-settings')||'{}')).lastBookId }));
  check('刷新后仍在书中', persisted.view === 'reader' && persisted.hasReader, JSON.stringify(persisted));

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

  // ===== 移动端触摸：单击单词翻译、双击整句翻译 =====
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

    // 双击整句：合成 Touch 事件，精确控制 150ms 间隔
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
    const mSent = await mpage.evaluate(() => {
      const p = document.querySelector('#sent-popup');
      return { open: p.classList.contains('open'), zh: document.querySelector('#sent-zh').innerText, bold: !!document.querySelector('#sent-zh b.kw') };
    });
    check('移动端双击整句可翻译', mSent.open && /MOCK翻译/.test(mSent.zh), JSON.stringify(mSent));
  }
  await mctx.close();

  await browser.close();
  srv.close(); proxy.close();

  const allPass = results.every(r => r.pass);
  for (const r of results) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
  console.log('=== 总判定:', allPass ? 'ALL PASS ✅' : 'HAS FAIL ❌', '===');
  process.exit(allPass ? 0 : 1);
})();
