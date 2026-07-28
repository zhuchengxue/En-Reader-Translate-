/* 古腾堡书城 E2E：书城加载 -> 搜索 -> 下载入库 -> 出现在书架。
 * 前置：tools/serve.js 已在 9000 运行（含 /api/gutenberg 代理）。
 * 用法：node tools/store-test.js
 */
const { chromium } = require('playwright');

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  const log = (...a) => console.log('[store-test]', ...a);
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; log('PASS', name); } else { fail++; log('FAIL', name); } };

  try {
    await page.goto('http://localhost:9000/', { waitUntil: 'networkidle' });
    await page.waitForSelector('#btn-store', { timeout: 15000 });
    check('书架入口加载', true);

    // 打开书城
    await page.click('#btn-store');
    await page.waitForSelector('#store-results .store-card', { timeout: 30000 });
    const popCount = await page.$$eval('#store-results .store-card', els => els.length);
    check('书城默认加载热门公版书', popCount > 0);

    // 搜索 alice
    await page.fill('#store-search', 'alice');
    await page.click('#store-search-btn');
    await page.waitForFunction(() => {
      const s = document.querySelector('#store-status');
      return s && s.classList.contains('hidden');
    }, { timeout: 30000 });
    const firstTitle = await page.$eval('#store-results .store-card .book-name', el => el.textContent.trim());
    check('搜索返回结果', !!firstTitle);
    log('搜索首条:', firstTitle);

    // 找到第一个可下载的卡片并点击下载
    const dlBtn = await page.waitForSelector('#store-results .store-card .store-dl:not([disabled])', { timeout: 30000 });
    const bookTitle = await dlBtn.evaluate(b => b.closest('.store-card').querySelector('.book-name').textContent.trim());
    log('准备下载:', bookTitle);
    await dlBtn.click();

    // 等待下载完成 -> 按钮变为“已加入书架”
    await page.waitForFunction(() => {
      const btns = [...document.querySelectorAll('#store-results .store-dl')];
      return btns.some(b => b.textContent.includes('已加入书架'));
    }, { timeout: 90000 });
    check('下载并入库成功', true);

    // 返回书架，确认该书已出现
    await page.click('#btn-store-back');
    await page.waitForSelector('#shelf-grid .book-card', { timeout: 15000 });
    const found = await page.$$eval('#shelf-grid .book-card', (els, title) =>
      els.some(e => e.textContent.includes(title)), bookTitle);
    check('下载的书出现在书架', found);
    log('书架命中:', bookTitle);
  } catch (e) {
    fail++;
    log('EXCEPTION', e.message);
  } finally {
    await browser.close();
  }

  // 过滤掉无影响的噪声（SW / 翻译代理等）
  const realErrors = errors.filter(e =>
    !/serviceWorker|registerSW|skip-waiting|Version guard|activation|__EXPECT_VER|translate|lingva|mymemory/i.test(e));
  console.log('\n=== 结果 ===');
  console.log('PASS:', pass, 'FAIL:', fail);
  if (realErrors.length) { console.log('控制台错误:'); realErrors.forEach(e => console.log('  -', e)); }
  else console.log('无实质性控制台错误');
  process.exit(fail ? 1 : 0);
})();
