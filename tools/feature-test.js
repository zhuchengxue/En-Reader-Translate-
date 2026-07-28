/* 新功能验证：书内搜索 / 行距与版心设置 / 统计行
 * 用法：NODE_PATH=... node tools/feature-test.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://127.0.0.1:9000/index.html';
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  /* 只统计脚本错误；翻译接口的网络失败（501/429 等资源错误）有多路兜底，不算页面错误 */
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text());
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  /* 造一本 TXT 测试书（多章、含目标词） */
  const lines = [];
  for (let c = 1; c <= 5; c++) {
    lines.push('Chapter ' + c + ' The Journey Part ' + c);
    for (let i = 0; i < 60; i++) {
      lines.push('This is paragraph ' + i + ' of chapter ' + c + '. The quick brown fox jumps over the lazy dog. ' +
        (c === 4 && i === 30 ? 'Here lies the UNIQUEWORD treasure sentence for searching. ' : '') +
        'Reading English books every day improves vocabulary steadily.');
      lines.push('');
    }
  }
  const tmp = path.join(__dirname, '_ft.txt');
  fs.writeFileSync(tmp, lines.join('\n'), 'utf8');

  await page.setInputFiles('#file-input', tmp);
  await page.waitForSelector('.book-card', { timeout: 10000 });
  check('导入 TXT 成功', true);

  await page.click('.book-card');
  await page.waitForSelector('.txt-content p', { timeout: 10000 });
  check('打开图书', true);

  /* ---- 搜索按钮 & 面板 ---- */
  await page.click('#btn-search');
  await page.waitForTimeout(300);
  check('搜索面板打开', await page.$eval('#search-panel', el => el.classList.contains('open')));

  await page.fill('#search-input', 'UNIQUEWORD');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.search-hit', { timeout: 8000 });
  const hits = await page.$$eval('.search-hit', els => els.length);
  check('搜索到唯一词（1 处）', hits === 1, '实际 ' + hits);
  const status = await page.$eval('#search-status', el => el.textContent);
  check('状态行显示匹配数', /1/.test(status), status);
  const hitHtml = await page.$eval('.search-hit', el => el.innerHTML);
  check('结果含高亮 <b>', /<b>/i.test(hitHtml));

  /* 点击结果 → 跳转并落到第 4 章 */
  await page.click('.search-hit');
  await page.waitForTimeout(600);
  const label = await page.$eval('#page-label', el => el.textContent);
  check('跳转到第 4 章', /^4\//.test(label), label);
  check('搜索面板已关闭', await page.$eval('#search-panel', el => !el.classList.contains('open')));
  /* 命中词应在当前可视列内（rect 在视口内） */
  const visible = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector('.txt-content'), NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const i = n.nodeValue.indexOf('UNIQUEWORD');
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + 10);
        const rect = r.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth && rect.width > 0;
      }
    }
    /* flashWord 可能仍包着 span */
    const sp = document.querySelector('.txt-content .w-active');
    if (sp) { const rect = sp.getBoundingClientRect(); return rect.left >= 0 && rect.right <= window.innerWidth; }
    return false;
  });
  check('命中词在可视页内', visible);

  /* ---- Ctrl+F 快捷键 ---- */
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(250);
  check('Ctrl+F 打开搜索', await page.$eval('#search-panel', el => el.classList.contains('open')));
  await page.fill('#search-input', 'quick brown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.search-hit', { timeout: 8000 });
  const hits2 = await page.$$eval('.search-hit', els => els.length);
  check('多结果搜索（200 上限）', hits2 > 100 && hits2 <= 200, '实际 ' + hits2);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape 关闭搜索', await page.$eval('#search-panel', el => !el.classList.contains('open')));

  /* ---- 行距 / 版心设置 ---- */
  await page.click('#btn-settings');
  await page.waitForTimeout(250);
  await page.click('#lh-seg button[data-lh="2.3"]');
  await page.waitForTimeout(300);
  const lh = await page.$eval('.txt-content', el => el.style.lineHeight);
  check('行距切换为 2.3', lh === '2.3', lh);
  await page.click('#margin-seg button[data-mg="large"]');
  await page.waitForTimeout(300);
  const mw = await page.$eval('.txt-viewport', el => el.style.maxWidth);
  check('版心切窄（760px）', mw === '760px', mw);
  /* 持久化 */
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('en-reader-settings')));
  check('排版设置已持久化', saved.lineHeight === 2.3 && saved.marginSize === 'large');

  /* 关闭设置面板（遮罩会挡住返回按钮） */
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /* ---- 统计行 ---- */
  await page.evaluate(() => {
    localStorage.setItem('en-reader-stats', JSON.stringify({ '2026-07-20': 4000, '2026-07-27': 300 }));
  });
  await page.click('#btn-back');
  await page.waitForTimeout(400);
  const stat = await page.$eval('#stat-line', el => el.textContent);
  check('统计行含累计时长', /累计/.test(stat), stat);

  check('无页面报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  try { fs.unlinkSync(tmp); } catch (e) {}
  await browser.close();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
