/* EPUB 阅读器：基于 epub.js，支持单/双页、主题注入、iframe 内单词交互 */
class EpubReader {
  constructor(container, buffer, opts) {
    this.container = container;
    this.buffer = buffer;
    this.fontSize = opts.fontSize || 18;
    this.pageMode = opts.pageMode || 'single';
    this.lineHeight = opts.lineHeight || 1.8;
    this.theme = opts.theme || 'light';
    this.pageAnim = opts.pageAnim || 'slide';
    this.handlers = opts.handlers || {};
    this.onProgress = null;
    this.currentCfi = null;
    this.currentTitle = '';
    this.locReady = false;
  }

  async init(saved) {
    this.holder = document.createElement('div');
    this.holder.className = 'epub-holder';
    this.container.appendChild(this.holder);

    this.book = ePub(this.buffer);
    await this.book.ready;
    try {
      const nav = await Promise.race([
        this.book.loaded.navigation,
        new Promise((_, rej) => setTimeout(() => rej(new Error('nav timeout')), 8000))
      ]);
      this.toc = this._flattenToc(nav.toc || []);
    } catch (e) {
      this.toc = [];
    }

    this._createRendition(saved && saved.cfi ? saved.cfi : undefined);

    /* 后台生成 locations 用于百分比进度 */
    this.book.locations.generate(1000).then(() => {
      this.locReady = true;
      this._emitProgress();
    }).catch(() => {});
  }

  _flattenToc(items, lv) {
    lv = lv || 1;
    let out = [];
    for (const it of items) {
      out.push({ label: it.label.trim(), target: it.href, lv });
      if (it.subitems && it.subitems.length && lv < 2) {
        out = out.concat(this._flattenToc(it.subitems, lv + 1));
      }
    }
    return out;
  }

  _themeStyles() {
    const themes = {
      light: { bg: '#ffffff', fg: '#1a1a1a' },
      sepia: { bg: '#f5f0e1', fg: '#5b4636' },
      dark:  { bg: '#1a1a1a', fg: '#c8c8c8' }
    };
    const t = themes[this.theme] || themes.light;
    return {
      body: {
        'background': t.bg + ' !important',
        'color': t.fg + ' !important',
        'font-family': 'Georgia, "Times New Roman", serif !important',
        'line-height': this.lineHeight + ' !important'
      },
      'p, div, span, li': { 'color': t.fg + ' !important' },
      'a': { 'color': '#3b82f6 !important' }
    };
  }

  _createRendition(cfi) {
    if (this.rendition) { try { this.rendition.destroy(); } catch (e) {} }
    this.holder.innerHTML = '';
    this.rendition = this.book.renderTo(this.holder, {
      width: '100%',
      height: '100%',
      flow: 'paginated',
      spread: this.pageMode === 'double' ? 'always' : 'none'
    });

    this.rendition.themes.register('reader', this._themeStyles());
    this.rendition.themes.select('reader');
    this.rendition.themes.fontSize(this.fontSize + 'px');

    this.rendition.hooks.content.register((contents) => {
      const doc = contents.document;
      /* 注入瞬时高亮样式（点击单词的 .w-active 由 Interaction.flashWord 临时创建，无需常驻 span） */
      const st = doc.createElement('style');
      st.textContent = '.w-active{background:rgba(59,130,246,.22);border-radius:2px}.tts-hl{background:rgba(59,130,246,.24);border-radius:2px}body{padding-left:16px!important;padding-right:16px!important}';
      doc.head.appendChild(st);
      const offsetFn = () => {
        try {
          const f = contents.window.frameElement;
          const r = f.getBoundingClientRect();
          return { x: r.left, y: r.top };
        } catch (e) { return { x: 0, y: 0 }; }
      };
      Interaction.attach(doc, offsetFn, this.handlers);
      /* iframe 内键盘翻页 */
      doc.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === ' ') this.next();
        if (e.key === 'ArrowLeft') this.prev();
      });
    });

    this.rendition.on('relocated', (loc) => {
      this.currentCfi = loc.start.cfi;
      const dt = loc.start && loc.start.displayed && loc.start.displayed.title;
      if (dt) this.currentTitle = dt; // 记录当前章节标题，供书签保留「标题」
      this._loc = loc;
      this._emitProgress();
      /* 翻页动画（滑动 / 淡入淡出），none 时不加 */
      if (this.pageAnim && this.pageAnim !== 'none' && this.holder) {
        const h = this.holder;
        h.classList.remove('ep-anim-slide', 'ep-anim-fade');
        void h.offsetWidth;
        h.classList.add(this.pageAnim === 'fade' ? 'ep-anim-fade' : 'ep-anim-slide');
      }
    });

    this.rendition.display(cfi);
  }

  _emitProgress() {
    if (!this.onProgress || !this._loc) return;
    let pct = 0;
    if (this.locReady) {
      try { pct = this.book.locations.percentageFromCfi(this.currentCfi) || 0; } catch (e) {}
    }
    this.onProgress({
      percent: pct,
      label: this.locReady ? Math.round(pct * 100) + '%' : '…',
      location: { cfi: this.currentCfi }
    });
  }

  next() { this.rendition && this.rendition.next(); }
  prev() { this.rendition && this.rendition.prev(); }
  goTo(href) { this.rendition && this.rendition.display(href); }
  getToc() { return this.toc; }

  /* ---------- 书签 / 朗读 ---------- */
  getLocation() { return { cfi: this.currentCfi }; }

  /* 书签要保留「标题 + 文字」：标题取当前章节名（relocated 时记录），文字取当前屏首块 */
  getBookmarkContext() {
    const title = this.currentTitle || '';
    const text = (this.getCurrentText && this.getCurrentText()) || '';
    return { title, text: text.slice(0, 500) };
  }

  /* 当前可见页的文本（分页模式下，仅取落在 iframe 视口内的元素）。
   * 避免把整章文本一次性读出导致连续朗读无法翻页：逐页读、逐页翻。 */
  _visibleText(onlyFirst) {
    try {
      const contents = this.rendition.getContents();
      if (!contents || !contents.length) return '';
      const doc = contents[0].document;
      const win = contents[0].window;
      const els = doc.body.querySelectorAll('p, li, h1, h2, h3, h4, blockquote, div');
      const out = [];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!(r.width && r.bottom > 0 && r.top < win.innerHeight)) continue;
        /* 跳过含块级子元素的容器节点（其子孙会单独处理），避免整章文本重复计入 */
        if (el.children.length && el.querySelector('p, li')) continue;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) { out.push(t); if (onlyFirst) break; }
      }
      return out.join(' ');
    } catch (e) { return ''; }
  }

  getPageText() { return this._visibleText(false); }
  getCurrentText() { return this._visibleText(true); }

  /* 朗读跟随文字：把当前可见块切成句子片段，返回 [{text, nodes}]（在 iframe 文档内创建 span） */
  getPageSegments() {
    const segs = [];
    try {
      const contents = this.rendition.getContents();
      if (!contents || !contents.length) return segs;
      const doc = contents[0].document;
      const win = contents[0].window;
      if (window.cleanupTtsSpans) cleanupTtsSpans(doc.body, doc);
      const blocks = doc.body.querySelectorAll('p, li, h1, h2, h3, h4, blockquote, div');
      for (const el of blocks) {
        const r = el.getBoundingClientRect();
        if (!(r.width && r.bottom > 0 && r.top < win.innerHeight)) continue;
        if (el.children.length && el.querySelector('p, li')) continue; // 跳过含块级子元素的容器
        const spans = window.buildSentenceSpans ? buildSentenceSpans(el, doc) : [];
        for (const s of spans) segs.push({ text: (s.textContent || '').trim(), nodes: [s] });
      }
    } catch (e) {}
    return segs;
  }

  clearTts() {
    try {
      const contents = this.rendition.getContents();
      if (contents && contents.length) {
        contents[0].document.querySelectorAll('.tts-hl').forEach(n => { try { n.classList.remove('tts-hl'); } catch (e) {} });
      }
    } catch (e) {}
  }

  setPageAnim(a) { this.pageAnim = a; }

  /* ---------- 书内全文搜索 ----------
   * 逐章加载 spine → section.find（epub.js 内部已做小写匹配）→ 卸载释放内存。
   * 返回 [{snippet, label, target: cfi}]，最多 200 条。 */
  async search(query) {
    const q = String(query || '').trim();
    const out = [];
    if (!q || !this.book) return out;
    const items = this.book.spine && this.book.spine.spineItems || [];
    for (const item of items) {
      try {
        await item.load(this.book.load.bind(this.book));
        const found = item.find(q) || [];
        for (const f of found) {
          out.push({ snippet: f.excerpt || q, label: '', target: f.cfi });
          if (out.length >= 200) break;
        }
      } catch (e) {}
      try { item.unload(); } catch (e) {}
      if (out.length >= 200) break;
    }
    return out;
  }

  /* 跳到匹配 CFI 并短暂高亮 */
  async showMatch(cfi) {
    if (!this.rendition || !cfi) return;
    try {
      await this.rendition.display(cfi);
      this.rendition.annotations.highlight(cfi, {}, null, 'search-hl',
        { fill: 'rgba(59,130,246,.35)', 'fill-opacity': '1' });
      setTimeout(() => { try { this.rendition.annotations.remove(cfi, 'highlight'); } catch (e) {} }, 1800);
    } catch (e) {}
  }

  setFontSize(px) {
    this.fontSize = px;
    this.rendition.themes.fontSize(px + 'px');
  }

  setLineHeight(v) {
    this.lineHeight = v;
    try { this.rendition.themes.override('line-height', String(v), true); } catch (e) {}
  }

  setMargin() { /* EPUB 版心由 epub.js 控制，暂不支持 */ }

  setPageMode(m) {
    this.pageMode = m;
    this._createRendition(this.currentCfi);
  }

  setTheme(t) {
    this.theme = t;
    /* 重新注册主题并强制刷新 */
    this.rendition.themes.register('reader-' + t, this._themeStyles());
    this.rendition.themes.select('reader-' + t);
  }

  onResize() { /* epub.js 自适应 */ }

  destroy() {
    try { this.rendition && this.rendition.destroy(); } catch (e) {}
    try { this.book && this.book.destroy(); } catch (e) {}
    this.container.innerHTML = '';
  }
}
