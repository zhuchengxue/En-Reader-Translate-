/* PDF 阅读器：基于 pdf.js，Canvas + 文本层，支持单/双页 */
class PdfReader {
  constructor(container, buffer, opts) {
    this.container = container;
    this.buffer = buffer;
    this.pageMode = opts.pageMode || 'single';
    this.pageAnim = opts.pageAnim || 'slide';
    this.handlers = opts.handlers || {};
    this.onProgress = null;
    this.page = 1;
    this.rendering = false;
    this._dirty = false;
    this._key = null;
    this._rz = null;
    this._cache = new Map();       // 已渲染页位图（ImageBitmap），key=页码:DPR:scale
    this._cacheOrder = [];         // LRU 顺序
    this._tlCache = new Map();     // 已渲染文本层 DOM（含 .w 整词包裹），key 同上
    this._tlOrder = [];            // 文本层 LRU 顺序（独立容量，避免与位图争用）
    this._pageTexts = null;        // 全书页文本缓存（首次搜索时构建，之后秒搜）
  }

  async init(saved) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    this.doc = await pdfjsLib.getDocument({ data: new Uint8Array(this.buffer) }).promise;
    this.total = this.doc.numPages;
    if (saved && saved.page) this.page = Math.min(saved.page, this.total);

    this.stage = document.createElement('div');
    this.stage.className = 'pdf-stage';
    this.container.appendChild(this.stage);

    this.toc = await this._buildToc();
    await this.render();
  }

  async _buildToc() {
    const out = [];
    try {
      const outline = await this.doc.getOutline();
      if (outline) {
        for (const it of outline.slice(0, 120)) {
          out.push({ label: it.title, target: { dest: it.dest } });
          if (it.items) {
            for (const sub of it.items.slice(0, 30)) {
              out.push({ label: sub.title, target: { dest: sub.dest }, lv: 2 });
            }
          }
        }
      }
    } catch (e) {}
    if (!out.length) {
      const step = Math.max(1, Math.floor(this.total / 20));
      for (let p = 1; p <= this.total; p += step) {
        out.push({ label: '第 ' + p + ' 页', target: { page: p } });
      }
    }
    return out;
  }

  async render() {
    if (this.rendering) { this._dirty = true; return; }
    this.rendering = true;
    try {
      const boxW = this.stage.clientWidth - 24;
      const boxH = this.stage.clientHeight - 24;
      const slotW = this.pageMode === 'double' ? (boxW - 16) / 2 : boxW;
      /* 渲染密钥：页码+版式+尺寸。未变化则跳过整页重绘（避免 resize 抖动/重复渲染） */
      const key = this.pageMode + ':' + this.page + ':' + Math.round(boxW) + 'x' + Math.round(boxH);
      if (key === this._key) return;
      this._key = key;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      this.stage.innerHTML = '';
      const nums = [this.page];
      if (this.pageMode === 'double' && this.page + 1 <= this.total) nums.push(this.page + 1);

      for (const num of nums) {
        const page = await this.doc.getPage(num);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(slotW / base.width, boxH / base.height);
        const vp = page.getViewport({ scale });
        const bkey = this._bitmapKey(num, scale, dpr);

        const wrap = document.createElement('div');
        wrap.className = 'pdf-page';
        wrap.style.width = vp.width + 'px';
        wrap.style.height = vp.height + 'px';

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = vp.width + 'px';
        canvas.style.height = vp.height + 'px';
        wrap.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        const bmp = this._cache.get(bkey);
        if (bmp) {
          /* 命中缓存：直接贴图，跳过 pdf.js 光栅化（最耗时的步骤），翻页近乎瞬时 */
          ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        } else {
          await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: scale * dpr }) }).promise;
          this._storeBitmap(bkey, canvas);
        }

        /* 文本层：优先复用已渲染 DOM（含 .w 整词包裹），跳过 renderTextLayer 这一最耗
         * DOM 构建的步骤——翻回上一页时文本层零重建，取词依旧精准。缓存存克隆体，避免
         * 后续 flashWord 的实时改动污染模板。 */
        let tl = this._tlCache.get(bkey);
        if (tl) {
          tl = tl.cloneNode(true);
        } else {
          tl = document.createElement('div');
          tl.className = 'textLayer';
          tl.style.setProperty('--scale-factor', String(scale));
          try {
            const textContent = await page.getTextContent();
            await pdfjsLib.renderTextLayer({
              textContentSource: textContent,
              textContent: textContent,
              container: tl,
              viewport: vp,
              textDivs: []
            }).promise;
            Interaction.wrapWords(tl);
            this._storeTl(bkey, tl);
          } catch (e) { /* 扫描版 PDF 无文本层 */ }
        }
        wrap.appendChild(tl);
        this.stage.appendChild(wrap);
      }
      /* 翻页动画（滑动 / 淡入淡出），none 时不加 */
      const a = this.pageAnim || 'slide';
      this.stage.classList.remove('pf-anim-slide', 'pf-anim-fade');
      if (a !== 'none') { void this.stage.offsetWidth; this.stage.classList.add(a === 'fade' ? 'pf-anim-fade' : 'pf-anim-slide'); }
      this._emitProgress();
      this._prefetch(boxW, boxH, slotW, dpr);
    } finally {
      this.rendering = false;
      if (this._dirty) { this._dirty = false; this.render(); }
    }
  }

  _bitmapKey(num, scale, dpr) { return num + ':' + dpr + ':' + Math.round(scale * 1000); }

  /* 文本层 LRU：容量独立于位图（DOM 更重），淘汰时仅丢弃引用，由 GC 回收 */
  _storeTl(bkey, tl) {
    this._tlCache.set(bkey, tl.cloneNode(true));
    this._tlOrder.push(bkey);
    while (this._tlOrder.length > 6) {
      const k = this._tlOrder.shift();
      this._tlCache.delete(k);
    }
  }

  _storeBitmap(key, canvas) {
    if (typeof createImageBitmap !== 'function') return;
    createImageBitmap(canvas).then(b => {
      this._cache.set(key, b);
      this._cacheOrder.push(key);
      while (this._cacheOrder.length > 16) {       // 限制内存：淘汰最旧的位图
        const k = this._cacheOrder.shift();
        const old = this._cache.get(k);
        if (old && old.close) { try { old.close(); } catch (e) {} }
        this._cache.delete(k);
      }
    }).catch(() => {});
  }

  /* 空闲时预渲染相邻页位图：翻页时大概率已缓存，零等待 */
  _prefetch(boxW, boxH, slotW, dpr) {
    const nums = [];
    if (this.page + 1 <= this.total) nums.push(this.page + 1);
    if (this.pageMode === 'double' && this.page + 2 <= this.total) nums.push(this.page + 2);
    if (this.page - 1 >= 1) nums.push(this.page - 1);
    if (!nums.length) return;
    const run = () => this._warmBitmaps(nums, boxW, boxH, slotW, dpr);
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 600);
  }

  async _warmBitmaps(nums, boxW, boxH, slotW, dpr) {
    for (const num of nums) {
      try {
        const page = await this.doc.getPage(num);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(slotW / base.width, boxH / base.height);
        const bkey = this._bitmapKey(num, scale, dpr);
        if (this._cache.has(bkey)) continue;
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(base.width * scale * dpr);
        canvas.height = Math.floor(base.height * scale * dpr);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale: scale * dpr }) }).promise;
        this._storeBitmap(bkey, canvas);
      } catch (e) {}
    }
  }


  _emitProgress() {
    if (!this.onProgress) return;
    this.onProgress({
      percent: this.page / this.total,
      label: this.page + ' / ' + this.total + ' 页',
      location: { page: this.page }
    });
  }

  next() {
    const step = this.pageMode === 'double' ? 2 : 1;
    if (this.page + step <= this.total) { this.page += step; this.render(); }
    else if (this.page < this.total) { this.page = this.total; this.render(); }
  }

  prev() {
    const step = this.pageMode === 'double' ? 2 : 1;
    this.page = Math.max(1, this.page - step);
    this.render();
  }

  async goTo(target) {
    if (!target) return;
    if (target.page) { this.page = Math.min(Math.max(1, target.page), this.total); this.render(); return; }
    if (target.dest) {
      try {
        let dest = target.dest;
        if (typeof dest === 'string') dest = await this.doc.getDestination(dest);
        const idx = await this.doc.getPageIndex(dest[0]);
        this.page = idx + 1;
        this.render();
      } catch (e) {}
    }
  }

  getToc() { return this.toc; }

  /* ---------- 书签 / 朗读 ---------- */
  getLocation() { return { page: this.page }; }

  /* 书签要保留「标题 + 文字」：标题取页码，文字取本页文本（异步提取，调用方 await） */
  async getBookmarkContext() {
    const title = '第 ' + this.page + ' 页';
    let text = '';
    try { text = (this.getCurrentText && await this.getCurrentText()) || ''; } catch (e) {}
    return { title, text: (text || '').slice(0, 500) };
  }

  /* 懒提取单页文本（不依赖文本层 DOM 是否渲染，连续朗读也能用） */
  async _pageText(page) {
    if (this._pageTexts && this._pageTexts[page - 1] != null) return this._pageTexts[page - 1];
    try {
      const p = await this.doc.getPage(page);
      const tc = await p.getTextContent();
      const t = tc.items.map(i => i.str).join(' ').replace(/\s+/g, ' ');
      if (!this._pageTexts) this._pageTexts = new Array(this.total);
      this._pageTexts[page - 1] = t;
      return t;
    } catch (e) { return ''; }
  }

  async getPageText() { return await this._pageText(this.page); }
  async getCurrentText() { return await this._pageText(this.page); }

  /* 朗读跟随文字：把当前屏文本层的整词（.w）按句末标点分组，返回 [{text, nodes}]。
   * 双页模式下遍历全部可见文本层（左页→右页，DOM 顺序），保证朗读顺序与视觉一致。 */
  getPageSegments() {
    const segs = [];
    const tls = this.stage.querySelectorAll('.textLayer');
    if (!tls.length) return segs;
    let cur = [];
    const flush = () => {
      if (cur.length) {
        const text = cur.map(w => (w.textContent || '').trim()).join(' ').replace(/\s+/g, ' ').trim();
        if (text) segs.push({ text, nodes: cur.slice() });
        cur = [];
      }
    };
    for (const tl of tls) {
      const words = Array.from(tl.querySelectorAll('.w'));
      for (const w of words) {
        cur.push(w);
        const t = (w.textContent || '').trim();
        if (/[.!?]["')\]]?$/.test(t)) flush();
      }
    }
    flush();
    return segs;
  }

  clearTts() {
    this.stage.querySelectorAll('.w.tts-hl, .w.tts-cur').forEach(n => { try { n.classList.remove('tts-hl', 'tts-cur'); } catch (e) {} });
  }

  setPageAnim(a) { this.pageAnim = a; }

  /* ---------- 书内全文搜索 ----------
   * 首次搜索时逐页提取文本并缓存（仅字符串，内存可控），之后的搜索直接命中缓存。
   * 返回 [{snippet, label, target:{page}}]，最多 200 条。 */
  async search(query) {
    const q = String(query || '').toLowerCase();
    const out = [];
    if (!q || !this.doc) return out;
    if (!this._pageTexts) {
      const texts = new Array(this.total);
      for (let p = 1; p <= this.total; p++) {
        try {
          const page = await this.doc.getPage(p);
          const tc = await page.getTextContent();
          texts[p - 1] = tc.items.map(i => i.str).join(' ').replace(/\s+/g, ' ');
        } catch (e) { texts[p - 1] = ''; }
      }
      this._pageTexts = texts;
    }
    for (let p = 1; p <= this.total; p++) {
      const text = this._pageTexts[p - 1];
      const lower = text.toLowerCase();
      let idx = lower.indexOf(q);
      while (idx !== -1) {
        const s = Math.max(0, idx - 40);
        const e = Math.min(text.length, idx + q.length + 60);
        out.push({
          snippet: (s > 0 ? '…' : '') + text.slice(s, e).trim() + (e < text.length ? '…' : ''),
          label: '第 ' + p + ' 页',
          target: { page: p }
        });
        if (out.length >= 200) return out;
        idx = lower.indexOf(q, idx + q.length);
      }
    }
    return out;
  }

  /* 跳到匹配页，并在文本层中瞬时高亮命中的首个单词 */
  async showMatch(t, term) {
    if (!t || !t.page) return;
    this.page = Math.min(Math.max(1, t.page), this.total);
    this._key = null;           // 强制重绘（render 有同键跳过逻辑）
    await this.render();
    if (!term) return;
    const first = String(term).toLowerCase().match(/[a-z'’\-]+/);
    if (!first) return;
    try {
      /* 文本层单词已被 wrapWords 包成 .w，找到第一个匹配的整词闪一下 */
      const spans = this.stage.querySelectorAll('.textLayer .w');
      for (const sp of spans) {
        if (sp.textContent.toLowerCase() === first[0] && sp.firstChild && sp.firstChild.nodeType === 3) {
          const range = document.createRange();
          range.selectNodeContents(sp);
          Interaction.flashWord(range, document);
          break;
        }
      }
    } catch (e) {}
  }

  setFontSize() { /* PDF 版式固定 */ }
  setLineHeight() { /* PDF 版式固定 */ }
  setMargin() { /* PDF 版式固定 */ }
  setPageMode(m) { this.pageMode = m; if (this.pageMode === 'double' && this.page % 2 === 0 && this.page > 1) this.page -= 1; this.render(); }
  setTheme() { /* 通过 CSS filter 处理 */ }
  onResize() { clearTimeout(this._rz); this._rz = setTimeout(() => this.render(), 200); }
  destroy() {
    try { this.doc && this.doc.destroy(); } catch (e) {}
    this._cache.clear(); this._cacheOrder.length = 0;
    this._tlCache.clear(); this._tlOrder.length = 0;
    this.container.innerHTML = '';
  }
}
