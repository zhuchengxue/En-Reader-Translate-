/* 模拟 Edge「增强安全模式(严格)」= 禁用 JIT(--jitless)，验证应用是否仍能初始化/打开书 */
const { chromium } = require("playwright");
const fs = require("fs");
const base = "http://127.0.0.1:9000/index.html";
const UD = "C:/Users/zhuch/.workbuddy/tmp/pw-edge-jitless";
fs.rmSync(UD, { recursive: true, force: true });

(async () => {
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(UD, {
      headless: true,
      channel: "msedge",
      args: ["--js-flags=--jitless"] // 模拟 Edge 严格增强安全模式禁用 JIT
    });
  } catch (e) { console.log("EDGE LAUNCH FAIL:", e.message); process.exit(0); }
  const p = await ctx.newPage();
  const errs = [];
  p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  p.on("pageerror", e => errs.push("PAGEERR: " + e.message));
  p.on("requestfailed", r => errs.push("REQFAIL: " + r.url()));
  try { await p.goto(base, { waitUntil: "load", timeout: 20000 }); }
  catch (e) { errs.push("GOTO: " + e.message); }
  await p.waitForTimeout(2500);
  // 导入 TXT + EPUB 并尝试打开（最依赖 JIT 的是 pdf/jszip）
  for (const f of ["samples/The-Great-Gatsby-Sample.txt", "samples/test.epub"]) {
    const input = await p.$("#file-input");
    if (input) { await input.setInputFiles(f); await p.waitForTimeout(1800); }
  }
  const cards = await p.evaluate(() => document.querySelectorAll(".book-card").length);
  // 打开 EPUB
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
  console.log("JITLESS cards:", cards, "openEPUB:", JSON.stringify(rEpub));
  console.log("JITLESS ERRORS:", errs.length);
  errs.slice(0, 15).forEach(e => console.log("  " + e));
  await ctx.close();
  fs.rmSync(UD, { recursive: true, force: true });
})().catch(e => { console.error("SCRIPT ERR", e); process.exit(1); });
