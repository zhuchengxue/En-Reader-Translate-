/* PDF 阅读器：基于 pdf.js，Canvas + 文本层，支持单/双页 */
class PdfReader {
  constructor(container, buffer, opts) {
    this.container = container;
    this.buffer = buffer;
    this.pageMode = opts.pageMode || 'single';
    this.handlers = opts.handlers || {};
    this.onProgress = null;
    this.page = 1;
    this.rendering = false;
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
    if (this.rendering) return;
    this.rendering = true;
    try {
      this.stage.innerHTML = '';
      const nums = [this.page];
      if (this.pageMode === 'double' && this.page + 1 <= this.total) nums.push(this.page + 1);

      const boxW = this.stage.clientWidth - 24;
      const boxH = this.stage.clientHeight - 24;
      const slotW = this.pageMode === 'double' ? (boxW - 16) / 2 : boxW;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      for (const num of nums) {
        const page = await this.doc.getPage(num);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(slotW / base.width, boxH / base.height);
        const vp = page.getViewport({ scale });

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

        const tl = document.createElement('div');
        tl.className = 'textLayer';
        tl.style.setProperty('--scale-factor', String(scale));
        wrap.appendChild(tl);
        this.stage.appendChild(wrap);

        await page.render({
          canvasContext: canvas.getContext('2d'),
          viewport: page.getViewport({ scale: scale * dpr })
        }).promise;

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
        } catch (e) { /* 扫描版 PDF 无文本层 */ }
      }
      this._emitProgress();
    } finally {
      this.rendering = false;
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
  setFontSize() { /* PDF 版式固定 */ }
  setPageMode(m) { this.pageMode = m; if (this.pageMode === 'double' && this.page % 2 === 0 && this.page > 1) this.page -= 1; this.render(); }
  setTheme() { /* 通过 CSS filter 处理 */ }
  onResize() { this.render(); }
  destroy() {
    try { this.doc && this.doc.destroy(); } catch (e) {}
    this.container.innerHTML = '';
  }
}
