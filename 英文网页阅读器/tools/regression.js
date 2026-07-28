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
      /* 模拟部署态内置端点 /api/translate（Cloudflare Pages Function），用于验证同源默认翻译路径 */
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

  // 全新 context 已自带干净的 IndexedDB / localStorage
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

  // 配置自建代理（模拟用户部署了 Worker 并填入）
  await openByTitle('Gatsby'); await waitLoading();
  await page.waitForSelector('#reader-container .w', { timeout: 10000 }).catch(() => {});
  await page.evaluate((url) => {
    const i = document.querySelector('#proxy-input');
    i.value = url;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, `http://127.0.0.1:${PROXY}/translate`);
  const proxyStatus = await page.evaluate(() => document.querySelector('#proxy-status').textContent);
  check('代理 UI 状态更新', /未测试|已设置/.test(proxyStatus), proxyStatus);

  // 单击单词：翻译 + 发音（代理应很快）。用 dispatch 触发，与 EPUB/PDF 一致，排除真实鼠标坐标漂移
  await page.evaluate(() => { window.__speak = 0; const o = window.speechSynthesis.speak.bind(window.speechSynthesis); window.speechSynthesis.speak = (u) => { window.__speak++; return o(u); }; });
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('#reader-container .w')].find(x => {
      const r = x.getBoundingClientRect(); return r.top > 60 && r.bottom < window.innerHeight - 60 && r.left > 4 && r.right < window.innerWidth - 4;
    });
    if (s) { const r = s.getBoundingClientRect(); s.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + 3, clientY: r.y + 3 })); }
  });
  // 等待弹层出现（单击有 260ms 防抖），再轮询译文
  await page.waitForFunction(() => !document.querySelector('#dict-popup').classList.contains('hidden'), { timeout: 5000 }).catch(() => {});
  let t0 = Date.now();
  let txtDict = '查询中…';
  while (Date.now() - t0 < 12000) { txtDict = await page.evaluate(() => document.querySelector('#dict-body').innerText); if (txtDict !== '查询中…') break; await page.waitForTimeout(120); }
  const txtTTS = await page.evaluate(() => window.__speak);
  check('TXT 单击可翻译(代理快)', /MOCK翻译/.test(txtDict), 'ms=' + (Date.now() - t0) + ' body=' + txtDict.slice(0, 30));
  check('TXT 单击可发音', txtTTS > 0, 'TTS=' + txtTTS);

  // 稳定性：词典卡片显示后位置应保持不变（修复「点击单词卡片上跳下跳」）
  const pos1 = await page.evaluate(() => { const r = document.querySelector('#dict-popup').getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; });
  await page.waitForTimeout(1600); // 等翻译 / 词典释义陆续到达
  const pos2 = await page.evaluate(() => { const r = document.querySelector('#dict-popup').getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; });
  check('词典卡片不跳动(位置稳定)', pos1.top === pos2.top && pos1.left === pos2.left, JSON.stringify({ pos1, pos2 }));

  // 双击单词：自动选中整句 + 句子翻译 + 词在译文内联加粗
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  const firstWord = async () => page.evaluate(() => {
    const s = [...document.querySelectorAll('#reader-container .w')].find(x => {
      const r = x.getBoundingClientRect(); return r.top > 60 && r.bottom < window.innerHeight - 60 && r.left > 4 && r.right < window.innerWidth - 4;
    });
    if (!s) return null; const r = s.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, word: s.textContent };
  });
  cw = await firstWord();
  t0 = Date.now();
  await page.mouse.dblclick(cw.x, cw.y);
  // 双击应视觉选中包含该词的整句（高亮）
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
  // 句子锚定在单词附近（非底部固定）
  const anchor = await page.evaluate(() => { const p = document.querySelector('#sent-popup').getBoundingClientRect(); return { top: Math.round(p.top), bottom: Math.round(p.bottom), vh: window.innerHeight }; });
  check('句子弹层锚定单词附近(非底部)', anchor.top > 0 && anchor.bottom < anchor.vh - 5, JSON.stringify(anchor));
  // 弹层不得遮挡已选中的整句：与高亮句子的矩形在垂直方向应无重叠（容差 2px）
  const ov = await page.evaluate(() => {
    const p = document.querySelector('#sent-popup').getBoundingClientRect();
    const sel = window.getSelection();
    const r = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    if (!r) return { ok: true, reason: 'no-sel' };
    const overlapY = Math.min(p.bottom, r.bottom) - Math.max(p.top, r.top);
    return { ok: overlapY <= 2, overlapY: Math.round(overlapY) };
  });
  check('句子弹层不遮挡选中句', ov.ok, JSON.stringify(ov));

  // EPUB 单击
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await openByTitle('Test English'); await page.waitForTimeout(2000); await waitLoading();
  await page.evaluate(() => { window.__speak = 0; const o = window.speechSynthesis.speak.bind(window.speechSynthesis); window.speechSynthesis.speak = (u) => { window.__speak++; return o(u); }; });
  await page.evaluate(() => {
    try {
      const d = document.querySelector('.epub-holder iframe').contentDocument;
      const s = d.querySelector('.w'); s && s.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 120, clientY: 120 }));
    } catch (e) {}
  });
  await page.waitForFunction(() => !document.querySelector('#dict-popup').classList.contains('hidden'), { timeout: 5000 }).catch(() => {});
  t0 = Date.now(); let epubDict = '查询中…';
  while (Date.now() - t0 < 12000) { epubDict = await page.evaluate(() => document.querySelector('#dict-body').innerText); if (epubDict !== '查询中…') break; await page.waitForTimeout(120); }
  check('EPUB 单击可翻译', /MOCK翻译/.test(epubDict), epubDict.slice(0, 24));

  // PDF 单击
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await openByTitle('test'); await page.waitForTimeout(2500); await waitLoading();
  await page.evaluate(() => { window.__speak = 0; const o = window.speechSynthesis.speak.bind(window.speechSynthesis); window.speechSynthesis.speak = (u) => { window.__speak++; return o(u); }; });
  await page.evaluate(() => { const s = document.querySelector('.textLayer .w'); s && s.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 200 })); });
  await page.waitForFunction(() => !document.querySelector('#dict-popup').classList.contains('hidden'), { timeout: 5000 }).catch(() => {});
  t0 = Date.now(); let pdfDict = '查询中…';
  while (Date.now() - t0 < 12000) { pdfDict = await page.evaluate(() => document.querySelector('#dict-body').innerText); if (pdfDict !== '查询中…') break; await page.waitForTimeout(120); }
  check('PDF 单击可翻译', /MOCK翻译/.test(pdfDict), pdfDict.slice(0, 24));

  // 持久化：刷新后仍在书中（不关闭）
  await page.reload(); await page.waitForTimeout(2500); await waitLoading();
  const persisted = await page.evaluate(() => ({ view: document.body.dataset.view, hasReader: !!document.querySelector('#reader-container .txt-viewport, #reader-container .epub-holder, #reader-container .pdf-stage'), last: (JSON.parse(localStorage.getItem('en-reader-settings')||'{}')).lastBookId }));
  check('刷新后仍在书中', persisted.view === 'reader' && persisted.hasReader, JSON.stringify(persisted));

  // 响应式：窄窗口无横向溢出
  await page.setViewportSize({ width: 820, height: 600 }); await page.waitForTimeout(400);
  const narrow = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth <= window.innerWidth + 1, view: document.body.dataset.view }));
  check('窄窗口无横向溢出', narrow.overflow, JSON.stringify(narrow));
  await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(300);

  // 内置同源翻译（部署态默认、无自建代理时走 /api/translate）：必须可用，否则公开部署后别人无法翻译
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

  await browser.close();
  srv.close(); proxy.close();

  const allPass = results.every(r => r.pass);
  for (const r of results) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
  console.log('=== 总判定:', allPass ? 'ALL PASS ✅' : 'HAS FAIL ❌', '===');
  process.exit(allPass ? 0 : 1);
})();
