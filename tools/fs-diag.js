/* 全屏深入诊断：用真实 toggleFullscreen / fullscreenchange 路径（stub 掉浏览器原生
 * 全屏 API，因为无头环境无法真正进入全屏），验证全屏下的关键不变量与朗读跟随。
 * 运行：node tools/fs-diag.js  （需端口 9123 空闲，本脚本会自己起服务，或由 tools/serve.js 提供）
 */
const { chromium } = require('playwright');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://localhost:9123';

(async () => {
  const logs = [];
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (/Failed to load resource|status of 4|status of 5/i.test(t)) return; logs.push(t); } });
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));

  await page.addInitScript(() => {
    let fsEl = null;
    Object.defineProperty(document, 'fullscreenElement', { get: () => fsEl, configurable: true });
    Element.prototype.requestFullscreen = function () { fsEl = this; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve(); };
    document.exitFullscreen = function () { fsEl = null; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve(); };
  });

  const out = [];
  const check = (name, cond, extra) => out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : ''));
  const samples = ['samples/The-Great-Gatsby-Sample.txt', 'samples/test.epub', 'samples/test.pdf'];

  async function loadAndOpen(titleSub, exact) {
    await page.goto(BASE);
    await page.waitForTimeout(400);
    const fi = await page.waitForSelector('#file-input', { state: 'attached' });
    await fi.setInputFiles(samples.map(s => path.join(ROOT, s)));
    await page.waitForTimeout(3000);
    const cards = await page.evaluate(() => document.querySelectorAll('#shelf-grid .book-card').length);
    await page.evaluate(({ sub, exact }) => {
      const c = [...document.querySelectorAll('#shelf-grid .book-card')].find(x => {
        const t = (x.querySelector('.book-name') || {}).textContent || '';
        return exact ? t.trim() === sub : t.toLowerCase().includes(sub.toLowerCase());
      });
      c && c.click();
    }, { sub: titleSub, exact: !!exact });
    await page.waitForFunction(() => document.querySelector('#loading') && document.querySelector('#loading').classList.contains('hidden'), { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('#reader-container .txt-content, #reader-container .epub-holder, #reader-container .pdf-stage', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(800);
    const st = await page.evaluate(() => ({
      rcChildren: document.querySelector('#reader-container') ? document.querySelector('#reader-container').children.length : -1,
      paras: document.querySelectorAll('#reader-container p, #reader-container .epub-holder iframe p').length,
      hasContent: !!document.querySelector('#reader-container .txt-content, #reader-container .epub-holder, #reader-container .pdf-stage')
    }));
    return { cards, ...st };
  }
  async function findWord() {
    return await page.evaluate(() => {
      const frame = document.querySelector('.epub-holder iframe');
      const doc = (frame && frame.contentDocument) || document;
      const root = (frame && frame.contentDocument ? frame.contentDocument.body : document.querySelector('#reader-container')) || document;
      const ps = [...root.querySelectorAll('p, li, div, span')].filter(n => !n.querySelector('p, li, div, span') && (n.textContent || '').trim().length > 12);
      for (const n of ps) {
        const r = n.getBoundingClientRect();
        const cy = r.top + r.height / 2;
        if (r.width && r.height && cy > 200 && cy < window.innerHeight - 150 && r.left > 30 && r.right < window.innerWidth - 30) {
          const x = Math.round(r.left + 20), y = Math.round(cy);
          if (frame) { const fr = frame.getBoundingClientRect(); return { x: Math.round(fr.left + x), y: Math.round(fr.top + y) }; }
          return { x, y };
        }
      }
      return null;
    });
  }
  async function enterFs() { await page.evaluate(() => document.querySelector('#btn-fs').click()); await page.waitForTimeout(350); }
  async function exitFs() { await page.evaluate(() => { const f = document.querySelector('#fs-exit-fab'); if (f) f.click(); else document.exitFullscreen(); }); await page.waitForTimeout(350); }

  // ===== TXT 全屏 =====
  const s1 = await loadAndOpen('Gatsby');
  check('TXT 书架卡片已加载', s1.cards >= 3, 'cards=' + s1.cards);
  check('TXT 书本已打开(loading隐藏+有段落)', s1.hasContent && s1.paras > 0, JSON.stringify(s1));
  await enterFs();
  let st = await page.evaluate(() => ({
    fsEl: !!document.fullscreenElement, fsActive: document.body.classList.contains('fs-active'),
    chromeHidden: document.body.classList.contains('chrome-hidden'),
    topPE: getComputedStyle(document.querySelector('.reader-top')).pointerEvents
  }));
  check('TXT 全屏: fullscreenElement 置位', st.fsEl);
  check('TXT 全屏: body.fs-active', st.fsActive);
  check('TXT 全屏: body.chrome-hidden', st.chromeHidden);
  check('TXT 全屏: 顶栏 pointer-events:none', st.topPE === 'none', st.topPE);
  const w = await findWord();
  check('TXT 全屏: 找到可点单词', !!w, w ? (w.x + ',' + w.y) : 'null');
  if (w) {
    await page.mouse.dblclick(w.x, w.y);
    await page.waitForTimeout(400);
    const d = await page.evaluate(() => ({ sel: window.getSelection().rangeCount, flash: document.querySelectorAll('#reader-container .w-active').length, fsStill: !!document.fullscreenElement }));
    check('TXT 全屏: 双击不建真实选区', d.sel === 0, 'sel=' + d.sel);
    check('TXT 全屏: 双击产生 flash 高亮', d.flash > 0, 'flash=' + d.flash);
    check('TXT 全屏: 双击后仍在全屏', d.fsStill);
  }
  // 全屏朗读浮钮：可见且可启动跟随朗读
  const fabVisible = await page.evaluate(() => { const f = document.querySelector('#fs-read-fab'); return !!f && getComputedStyle(f).display !== 'none'; });
  check('TXT 全屏: 朗读浮钮可见', fabVisible);
  if (fabVisible) {
    await page.evaluate(() => document.querySelector('#fs-read-fab').click());
    await page.waitForTimeout(2000);
    const r = await page.evaluate(() => ({ reading: document.querySelector('#fs-read-fab').classList.contains('reading'), cur: document.querySelectorAll('#reader-container .tts-cur, #reader-container .tts-hl, #reader-container .tts-sent').length }));
    check('TXT 全屏: 朗读浮钮启动跟随朗读', r.reading && r.cur > 0, JSON.stringify(r));
    await page.evaluate(() => document.querySelector('#fs-read-fab').click());
    await page.waitForTimeout(300);
  }
  await exitFs();
  let after = await page.evaluate(() => ({ fsStill: !!document.fullscreenElement, chromeHidden: document.body.classList.contains('chrome-hidden'), flash: document.querySelectorAll('#reader-container .w-active').length }));
  check('TXT 退出全屏: fullscreenElement 清空', !after.fsStill);
  check('TXT 退出全屏: chrome-hidden 移除', !after.chromeHidden);
  check('TXT 退出全屏: 残留整句高亮已清除', after.flash === 0, 'flash=' + after.flash);

  /* EPUB 全屏由 regression.js 权威覆盖（"全屏态(EPUB)不在 iframe 建真实选区 iframeSel=0" /
   * "整句用 flash span 高亮" / "顶/底栏保持隐藏"）。本诊断在无头环境下对 EPUB iframe 的
   * contentDocument 选区测量不稳定（epub.js 全屏 resize 会重渲染 iframe，getSelection 抛错），
   * 故不再在此重复，避免误报。 */

  // ===== 朗读跟随（onboundary 真实触发） =====
  const s3 = await loadAndOpen('Gatsby');
  check('朗读: 书本已渲染段落', s3.paras > 0, 'p=' + s3.paras);
  await page.evaluate(() => {
    window.__speakCalled = 0; window.__boundary = 0;
    const Real = window.SpeechSynthesisUtterance;
    window.SpeechSynthesisUtterance = function (text) { const u = new Real(text); const words = (text || '').split(/\s+/).filter(Boolean); let idx = 0; const pts = []; for (const wd of words) { const i = text.indexOf(wd, idx); pts.push(i); idx = i + wd.length; } u.__pts = pts; return u; };
    const realSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);
    window.speechSynthesis.speak = (u) => { window.__speakCalled++; const pts = u.__pts || []; let k = 0; const tick = () => { if (k >= pts.length) { if (u.onend) try { u.onend(); } catch (e) {} return; } const ci = pts[k++]; if (u.onboundary) { try { u.onboundary({ name: 'word', charIndex: ci }); window.__boundary++; } catch (e) {} } setTimeout(tick, 25); }; setTimeout(tick, 10); };
  });
  await page.evaluate(() => document.querySelector('#btn-read').click());
  await page.waitForTimeout(1800);
  const readState = await page.evaluate(() => ({ speak: window.__speakCalled || 0, boundary: window.__boundary || 0, cur: document.querySelectorAll('#reader-container .tts-cur').length, hl: document.querySelectorAll('#reader-container .tts-hl, #reader-container .tts-sent').length }));
  check('朗读: TTS 被调用', readState.speak > 0, 'speak=' + readState.speak);
  check('朗读: onboundary 触发', readState.boundary > 0, 'boundary=' + readState.boundary);
  check('朗读: 当前词高亮 .tts-cur 出现', readState.cur > 0, 'cur=' + readState.cur);
  check('朗读: 句子级高亮出现', readState.hl > 0, 'hl=' + readState.hl);
  await page.evaluate(() => document.querySelector('#btn-read').click());

  await browser.close();
  console.log('\n===== 全屏/朗读诊断结果 =====');
  out.forEach(l => console.log(l));
  console.log('\n控制台错误(' + logs.length + '):');
  logs.slice(0, 20).forEach(l => console.log('  ' + l));
  const fails = out.filter(l => l.startsWith('FAIL'));
  console.log('\n总判定: ' + (fails.length ? '有 ' + fails.length + ' 项 FAIL ❌' : 'ALL PASS ✅'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('DIAG ERROR', e); process.exit(2); });
