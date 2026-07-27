/* TXT 阅读器：CSS 多列分页，支持单/双页、章节检测 */
class TxtReader {
  constructor(container, buffer, opts) {
    this.container = container;
    this.buffer = buffer;
    this.fontSize = opts.fontSize || 18;
    this.pageMode = opts.pageMode || 'single';
    this.section = 0;
    this.page = 0;
    this.onProgress = null;
    this.handlers = opts.handlers || {};
  }

  async init(saved) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer); }
    catch (e) { text = new TextDecoder('gbk').decode(this.buffer); }
    text = text.replace(/\r\n?/g, '\n');
    const lines = text.split('\n');

    /* 章节检测 */
    const chapRe = /^\s*(chapter\s+([0-9]+|[ivxlcdm]+)\b.*|part\s+([0-9]+|[ivxlcdm]+)\b.*|prologue\b.*|epilogue\b.*|第\s*[0-9一二三四五六七八九十百千]{1,9}\s*[章节卷回部].*)$/i;
    const marks = [];
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t && t.length < 80 && chapRe.test(t)) marks.push(i);
    });

    this.sections = [];
    this.toc = [];
    if (marks.length >= 3) {
      const pre = marks[0] > 0 ? lines.slice(0, marks[0]) : [];
      for (let k = 0; k < marks.length; k++) {
        const end = k + 1 < marks.length ? marks[k + 1] : lines.length;
        let sec = lines.slice(marks[k], end);
        if (k === 0 && pre.length) sec = pre.concat(sec); /* 标题并入第一章，避免首屏空荡 */
        this.toc.push({ label: lines[marks[k]].trim(), target: { section: this.sections.length } });
        this.sections.push(sec);
      }
    } else {
      let cur = [], size = 0;
      for (const l of lines) {
        cur.push(l);
        size += l.length;
        if (size > 22000) { this.sections.push(cur); cur = []; size = 0; }
      }
      if (cur.length) this.sections.push(cur);
      this.sections.forEach((_, i) => this.toc.push({ label: 'Part ' + (i + 1), target: { section: i } }));
    }
    if (!this.sections.length) this.sections = [['(空文件)']];

    /* DOM */
    this.viewport = document.createElement('div');
    this.viewport.className = 'txt-viewport';
    this.content = document.createElement('div');
    this.content.className = 'txt-content';
    this.viewport.appendChild(this.content);
    this.container.appendChild(this.viewport);

    if (saved && typeof saved.section === 'number') {
      this.section = Math.min(saved.section, this.sections.length - 1);
      this.page = saved.page || 0;
    }
    this.renderSection();
  }

  renderSection() {
    this.content.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const line of this.sections[this.section]) {
      const t = line.trim();
      if (!t) continue;
      const p = document.createElement('p');
      p.textContent = t;
      frag.appendChild(p);
    }
    this.content.appendChild(frag);
    Interaction.wrapWords(this.content);
    this.layout();
  }

  layout() {
    const W = this.viewport.clientWidth;
    const g = 56;
    const cw = this.pageMode === 'double' ? Math.floor((W - g) / 2) : W;
    this.content.style.columnWidth = cw + 'px';
    this.content.style.columnGap = g + 'px';
    this.content.style.fontSize = this.fontSize + 'px';
    this.content.style.width = W + 'px';
    this.step = W + g;
    /* 强制 reflow 后计算总页数 */
    void this.content.offsetHeight;
    this.pages = Math.max(1, Math.ceil(this.content.scrollWidth / this.step));
    if (this.page > this.pages - 1) this.page = this.pages - 1;
    this.update();
  }

  update() {
    this.content.style.transform = 'translateX(' + (-this.page * this.step) + 'px)';
    if (this.onProgress) {
      const pct = (this.section + (this.page + 1) / this.pages) / this.sections.length;
      this.onProgress({
        percent: Math.min(pct, 1),
        label: (this.section + 1) + '/' + this.sections.length + ' 章 · ' + (this.page + 1) + '/' + this.pages + ' 页',
        location: { section: this.section, page: this.page }
      });
    }
  }

  next() {
    if (this.page < this.pages - 1) { this.page++; this.update(); }
    else if (this.section < this.sections.length - 1) { this.section++; this.page = 0; this.renderSection(); }
  }

  prev() {
    if (this.page > 0) { this.page--; this.update(); }
    else if (this.section > 0) {
      this.section--;
      this.page = 0;
      this.renderSection();
      this.page = this.pages - 1;
      this.update();
    }
  }

  goTo(target) {
    if (target && typeof target.section === 'number') {
      this.section = target.section;
      this.page = 0;
      this.renderSection();
    }
  }

  getToc() { return this.toc; }

  setFontSize(px) { this.fontSize = px; this.layout(); }
  setPageMode(m) { this.pageMode = m; this.page = 0; this.layout(); }
  setTheme() { /* 由全局 CSS 变量控制，无需处理 */ }
  onResize() { this.layout(); }
  destroy() { this.container.innerHTML = ''; }
}
