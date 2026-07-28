/* 真实 Edge 验证：①正常加载 = 版本一致、设置面板可开 ②强制喂旧版 app.js = 版本守卫自愈。
 * 场景②做法：page.route 拦截 app.js 请求返回假旧版（APP_VER=2026-07-20.0），
 * 页面 load 后版本守卫应发现不符 → 清 SW/缓存 → 重载；重载前解除拦截 → 拿到真新版。 */
const { chromium } = require('playwright');
const os = require('os');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:9000/index.html';
const EXPECT = '2026-07-28.2';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '  [' + extra + ']' : ''));
  cond ? pass++ : fail++;
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-verify-'));
  /* serviceWorkers:'block'：SW 会绕过 page.route 拦截，屏蔽后才能确定性喂旧版 app.js。
   * 版本守卫是页面级逻辑，与旧文件来自 SW 缓存还是 HTTP 缓存无关，此测试依然有效。 */
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'msedge', headless: true, serviceWorkers: 'block' });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  const consoleWarns = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'warning') consoleWarns.push(m.text()); });

  /* ---- 场景① 正常加载 + 设置按钮 ---- */
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const ver1 = await page.evaluate(() => window.APP_VER);
  ok('Edge 加载版本一致', ver1 === EXPECT, 'APP_VER=' + ver1);

  const tmpTxt = path.join(os.tmpdir(), 'edge-verify-book.txt');
  fs.writeFileSync(tmpTxt, 'Chapter 1\n\n' + 'The quick brown fox jumps over the lazy dog. '.repeat(120));
  await page.setInputFiles('#file-input', tmpTxt);
  await page.waitForSelector('.book-card', { timeout: 10000 });
  await page.click('.book-card');
  await page.waitForSelector('.txt-content p', { timeout: 10000 });
  await page.click('#btn-settings');
  const setOpen = await page.evaluate(() => document.querySelector('#settings-panel').classList.contains('open'));
  ok('Edge 设置面板可打开', setOpen);
  await page.keyboard.press('Escape');
  await page.click('#btn-back'); // 回书架，避免下轮直接进阅读器

  /* ---- 场景② 强制喂旧版 app.js（确定性复现用户症状）---- */
  let fedOld = false;
  await page.route('**/js/app.js*', async (route) => {
    if (fedOld) return route.continue();     // 只喂一次旧版，守卫重载后放行真文件
    fedOld = true;
    await route.fulfill({
      contentType: 'text/javascript',
      body: "window.APP_VER='2026-07-20.0'; console.log('FAKE OLD APP.JS RUNNING');",
    });
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  // 此刻页面应在跑假旧版（守卫即将触发重载）；用 fedOld 确认拦截确实生效
  ok('已确定性喂入旧版 app.js', fedOld);
  await page.waitForTimeout(3500); // 守卫：清 SW + 缓存 + location.replace
  const ver2 = await page.evaluate(() => window.APP_VER).catch(() => 'N/A');
  ok('版本守卫自愈成功（自动回到新版）', ver2 === EXPECT, 'APP_VER=' + ver2);
  const guardFired = consoleWarns.some(w => w.indexOf('版本守卫') >= 0);
  ok('守卫日志确认触发过自愈', guardFired);

  // 自愈后功能完好：进书 → 点 Aa
  await page.unroute('**/js/app.js*');
  const inReader = await page.evaluate(() => document.body.dataset.view === 'reader');
  if (!inReader) {
    await page.waitForSelector('.book-card', { timeout: 10000 });
    await page.click('.book-card');
  }
  await page.waitForSelector('.txt-content p', { timeout: 10000 });
  await page.click('#btn-settings');
  const setOpen2 = await page.evaluate(() => document.querySelector('#settings-panel').classList.contains('open'));
  ok('自愈后设置面板可打开', setOpen2);

  const realErrors = errors.filter(e => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|ERR_FAILED/i.test(e));
  ok('无页面报错', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

  await ctx.close();
  try { fs.unlinkSync(tmpTxt); } catch (e) {}
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
