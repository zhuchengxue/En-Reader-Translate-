/* TXT 阅读器：CSS 多列分页，支持单/双页、章节检测 */
class TxtReader {
  constructor(container, buffer, opts) {
    this.container = container;
    this.buffer = buffer;
    this.fontSize = opts.fontSize || 18;
    this.pageMode = opts.pageMode || 'single';
    this.lineHeight = opts.lineHeight || 1.9;
    this.marginSize = opts.marginSize || 'medium';
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
    this._applyMargin();
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
    this.layout();
  }

  layout() {
    const W = this.viewport.clientWidth;
    const g = 56;
    const cw = this.pageMode === 'double' ? Math.floor((W - g) / 2) : W;
    this.content.style.columnWidth = cw + 'px';
    this.content.style.columnGap = g + 'px';
    this.content.style.fontSize = this.fontSize + 'px';
    this.content.style.lineHeight = this.lineHeight;
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

  /* ---------- 书内全文搜索 ---------- */
  /* 返回 [{snippet, label, target:{section,line,ch}}]，最多 200 条 */
  search(query) {
    const q = String(query || '').toLowerCase();
    const out = [];
    if (!q) return out;
    for (let si = 0; si < this.sections.length; si++) {
      const lines = this.sections[si];
      const label = (this.toc[si] && this.toc[si].label) || '';
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (!line) continue;
        const lower = line.toLowerCase();
        let idx = lower.indexOf(q);
        while (idx !== -1) {
          const s = Math.max(0, idx - 40);
          const e = Math.min(line.length, idx + q.length + 60);
          out.push({
            snippet: (s > 0 ? '…' : '') + line.slice(s, e).trim() + (e < line.length ? '…' : ''),
            label,
            target: { section: si, line: li, ch: idx }
          });
          if (out.length >= 200) return out;
          idx = lower.indexOf(q, idx + q.length);
        }
      }
    }
    return out;
  }

  /* 跳到匹配处：切章 → 定位段落与字符 → 算出所在列（页）→ 瞬时高亮 */
  showMatch(t, term) {
    if (!t || typeof t.section !== 'number') return;
    this.section = Math.min(t.section, this.sections.length - 1);
    this.page = 0;
    this.renderSection();
    const lines = this.sections[this.section];
    if (typeof t.line !== 'number' || t.line >= lines.length) return;
    /* renderSection 跳过空行且对行 trim；把原始行号映射为段落序号、原始 ch 映射为 trim 后偏移 */
    let pIdx = -1;
    for (let i = 0; i <= t.line; i++) if (lines[i].trim()) pIdx++;
    const p = this.content.children[pIdx];
    if (!p || !p.firstChild || p.firstChild.nodeType !== 3) return;
    const lead = lines[t.line].length - lines[t.line].trimStart().length;
    const node = p.firstChild;
    const start = Math.max(0, Math.min(t.ch - lead, node.nodeValue.length));
    const end = Math.min(node.nodeValue.length, start + (term ? term.length : 0));
    try {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, Math.max(start, end));
      /* 此刻 page=0、transform=0，rect.left 相对视口起点即为列内 x → 除以步长得页码 */
      const rect = range.getBoundingClientRect();
      const vp = this.viewport.getBoundingClientRect();
      this.page = Math.max(0, Math.min(this.pages - 1, Math.floor((rect.left - vp.left) / this.step)));
      this.update();
      Interaction.flashWord(range, document);
    } catch (e) { this.update(); }
  }

  _applyMargin() {
    const map = { small: '1440px', medium: '1080px', large: '760px' };
    this.viewport.style.maxWidth = map[this.marginSize] || map.medium;
  }

  setFontSize(px) { this.fontSize = px; this.layout(); }
  setLineHeight(v) { this.lineHeight = v; this.layout(); }
  setMargin(m) { this.marginSize = m; this._applyMargin(); this.layout(); }
  setPageMode(m) { this.pageMode = m; this.page = 0; this.layout(); }
  setTheme() { /* 由全局 CSS 变量控制，无需处理 */ }
  onResize() { this.layout(); }
  destroy() { this.container.innerHTML = ''; }
}
