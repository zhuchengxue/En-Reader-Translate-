/* 激活流程真实浏览器测试：关闭 navigator.webdriver 让授权闸门生效，
 * 验证「试用限次 → 耗尽弹激活 → 输码解锁 → 刷新保持」。
 * 依赖本地 tools/serve.js（端口 9000，提供 /api/redeem 本地签名）。
 * 运行：先启动 serve.js，再 node tools/activate-test.js
 */
const { chromium } = require('playwright');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:9000/index.html';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled']
  });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('   [console.error]', m.text()); });
  await page.goto(BASE);
  await page.waitForSelector('#file-input', { state: 'attached' });
  await page.waitForFunction(() => window.License && document.querySelector('#trial-banner'));
  await page.waitForTimeout(400);

  const webdriver = await page.evaluate(() => navigator.webdriver);
  check('闸门生效(navigator.webdriver=false)', webdriver === false, { webdriver });

  // 导入一本 TXT
  await page.setInputFiles('#file-input', [path.join(ROOT, 'samples/The-Great-Gatsby-Sample.txt')]);
  await page.waitForSelector('#shelf-grid .book-card');
  await page.waitForTimeout(300);

  const bannerText = () => page.$eval('#trial-banner', el => el.classList.contains('hidden') ? '' : el.textContent).catch(() => '');
  check('试用条可见(剩余3次)', (await bannerText()).includes('试用剩余 3 次'), { txt: await bannerText() });

  async function openOnce() {
    await page.evaluate(() => { const c = document.querySelector('#shelf-grid .book-card'); c && c.click(); });
    await page.waitForFunction(() => document.body.dataset.view === 'reader');
    await page.waitForTimeout(200);
    await page.click('#btn-back');
    await page.waitForFunction(() => document.body.dataset.view === 'shelf');
    await page.waitForTimeout(150);
  }

  // 打开 3 次（试用 3→2→1→0）
  await openOnce();
  check('开1次后剩余2', (await bannerText()).includes('试用剩余 2 次'), { txt: await bannerText() });
  await openOnce();
  await openOnce();
  check('开3次后剩余0', (await bannerText()).includes('试用剩余 0 次'), { txt: await bannerText() });

  // 第4次点击应弹激活模态且不打开书
  await page.evaluate(() => { const c = document.querySelector('#shelf-grid .book-card'); c && c.click(); });
  await page.waitForTimeout(400);
  const modalOpen = await page.$eval('#activate-modal', el => el.classList.contains('open'));
  const stillShelf = await page.evaluate(() => document.body.dataset.view === 'shelf');
  check('试用耗尽弹激活模态', modalOpen, { modalOpen });
  check('耗尽后不打开书(仍在书架)', stillShelf, { stillShelf });

  // 无效码应报错（用原生 DOM 触发，绕过 Playwright 可见性判断）
  await page.$eval('#activate-input', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, 'BADCODE');
  await page.$eval('#activate-submit', el => el.click());
  await page.waitForTimeout(500);
  const errShown = await page.$eval('#activate-error', el => !el.classList.contains('hidden') && el.textContent);
  check('无效码报错', !!errShown, { err: errShown });

  // 有效码解锁
  await page.$eval('#activate-input', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, 'ENRD-ABCD-1234');
  await page.$eval('#activate-submit', el => el.click());
  await page.waitForFunction(() => !document.querySelector('#activate-modal').classList.contains('open'), { timeout: 5000 });
  await page.waitForTimeout(300);
  const bannerHidden = await page.$eval('#trial-banner', el => el.classList.contains('hidden'));
  check('激活后试用条隐藏', bannerHidden, { bannerHidden });
  const activated = await page.evaluate(() => window.License && License.isActivated());
  check('License.isActivated()=true', activated === true, { activated });

  // 刷新后保持激活
  await page.reload();
  await page.waitForSelector('#file-input', { state: 'attached' });
  await page.waitForTimeout(500);
  const bannerHidden2 = await page.$eval('#trial-banner', el => el.classList.contains('hidden'));
  const activated2 = await page.evaluate(() => window.License && License.isActivated());
  check('刷新后仍激活', activated2 === true && bannerHidden2, { activated2, bannerHidden2 });

  await browser.close();
  console.log('\n激活测试: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
