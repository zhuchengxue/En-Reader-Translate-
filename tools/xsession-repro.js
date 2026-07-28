/* 跨浏览器会话复现用户真实路径，并抓取挂起的网络请求。
 * 会话1（昨天）：导入 + 打开 EPUB；会话2（今天）：同 userDataDir 回来 → 检查真实渲染、报错、挂起请求。 */
const { chromium } = require("playwright");
const fs = require("fs");
const UD = "C:/Users/zhuch/.workbuddy/tmp/pw-xsession";
fs.rmSync(UD, { recursive: true, force: true });
const base = "http://127.0.0.1:9000/index.html";

(async () => {
  // ===== 会话1（昨天）：导入 + 打开 EPUB =====
  let ctx = await chromium.launchPersistentContext(UD, { headless: true });
  let p = await ctx.newPage();
  await p.goto(base, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2000);
  for (const f of ["samples/test.epub", "samples/The-Great-Gatsby-Sample.txt"]) {
    const input = await p.$("#file-input");
    await input.setInputFiles(f);
    await p.waitForTimeout(1500);
  }
  await p.evaluate(() => {
    const cards = [...document.querySelectorAll(".book-card")];
    const c = cards.find(x => x.textContent.includes("Test English Book")) || cards[0];
    c.click();
  });
  await p.waitForTimeout(4000);
  const epubTxt1 = await p.evaluate(() => {
    const f = document.querySelector(".epub-holder iframe");
    return (f && f.contentDocument && f.contentDocument.body) ? f.contentDocument.body.innerText.trim().length : -1;
  });
  console.log("SESSION1 epub iframe textLen:", epubTxt1);
  await ctx.close();

  // ===== 会话2（今天）：同 userDataDir，抓挂起请求 =====
  ctx = await chromium.launchPersistentContext(UD, { headless: true });
  p = await ctx.newPage();
  const errs = [];
  const pending = new Set();
  p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  p.on("pageerror", e => errs.push("PAGEERR: " + e.message));
  p.on("request", r => pending.add(r.url()));
  p.on("requestfinished", r => pending.delete(r.url()));
  p.on("requestfailed", r => { pending.delete(r.url()); });
  try { await p.goto(base, { waitUntil: "load", timeout: 15000 }); }
  catch (e) { console.log("GOTO catch:", e.message); }
  await p.waitForTimeout(5000);
  const ready = await p.evaluate(() => document.readyState);
  const toast = await p.evaluate(() => { const t = document.querySelector("#toast"); return t.classList.contains("hidden") ? "" : t.textContent; });
  const auto = await p.evaluate(() => ({
    view: document.body.dataset.view,
    readerVisible: !document.querySelector("#view-reader").classList.contains("hidden"),
    epubIframe: (() => { const f = document.querySelector(".epub-holder iframe"); return (f && f.contentDocument && f.contentDocument.body) ? f.contentDocument.body.innerText.trim().length : -1; })(),
    title: document.querySelector("#reader-book-title").textContent
  }));
  console.log("SESSION2 readyState:", ready, "auto-open:", JSON.stringify(auto), "toast:", toast);
  console.log("SESSION2 PENDING REQUESTS:", JSON.stringify([...pending].slice(0, 20)));

  // 手动点 EPUB
  await p.evaluate(() => { const b = document.querySelector("#btn-back"); if (b) b.click(); });
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const cards = [...document.querySelectorAll(".book-card")];
    const c = cards.find(x => x.textContent.includes("Test English Book")) || cards[0];
    if (c) c.click();
  });
  await p.waitForTimeout(4000);
  const rEpub = await p.evaluate(() => {
    const f = document.querySelector(".epub-holder iframe");
    const t = document.querySelector("#toast");
    return { view: document.body.dataset.view, iframeTextLen: (f && f.contentDocument && f.contentDocument.body) ? f.contentDocument.body.innerText.trim().length : -1, toast: t.classList.contains("hidden") ? "" : t.textContent };
  });
  console.log("SESSION2 manual EPUB:", JSON.stringify(rEpub));

  // 手动点 TXT
  await p.evaluate(() => { const b = document.querySelector("#btn-back"); if (b) b.click(); });
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const cards = [...document.querySelectorAll(".book-card")];
    const c = cards.find(x => x.textContent.includes("Gatsby")) || cards[0];
    if (c) c.click();
  });
  await p.waitForTimeout(3000);
  const rTxt = await p.evaluate(() => {
    const t = document.querySelector("#toast");
    const tc = document.querySelector(".txt-content");
    return { view: document.body.dataset.view, txtTextLen: tc ? tc.innerText.trim().length : -1, kids: document.querySelector("#reader-container").children.length, toast: t.classList.contains("hidden") ? "" : t.textContent };
  });
  console.log("SESSION2 manual TXT:", JSON.stringify(rTxt));
  console.log("ERRORS:", errs.length, JSON.stringify(errs.slice(0, 10)));
  await ctx.close();
  fs.rmSync(UD, { recursive: true, force: true });
})().catch(e => { console.error("SCRIPT ERR", e); process.exit(1); });
