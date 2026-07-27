/* 主控逻辑：书架 / 导入 / 阅读 / 生词本 / 设置 / 统计 */
(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  let settings = null;
  let reader = null;
  let currentBookId = null;
  let currentBookTitle = '';
  let dictCurrent = null;
  let currentSentence = '';
  let saveTimer = null;
  let lastDictPos = null;   // 记录词典卡片的定位，缩放窗口时可稳定重排
  let lastSentPos = null;   // 记录句子弹层的定位（点击点）
  let lastSentRect = null;  // 记录选中整句的视口矩形，用于把弹层放到句子之外

  /* ---------- 工具 ---------- */
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const view = () => document.body.dataset.view;

  function switchView(v) {
    document.body.dataset.view = v;
    $('#view-shelf').classList.toggle('hidden', v !== 'shelf');
    $('#view-vocab').classList.toggle('hidden', v !== 'vocab');
    $('#view-reader').classList.toggle('hidden', v !== 'reader');
  }

  /* 超时包装：防止导入时某一步卡死 */
  function withTimeout(p, ms, label) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error((label || 'timeout') + ' timeout')), ms))
    ]);
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  function loading(on, text) {
    $('#loading').classList.toggle('hidden', !on);
    if (text) $('#loading-text').textContent = text;
  }

  /* ---------- 单词/句子交互处理 ---------- */
  const handlers = {
    onWord(word, x, y, span) {
      if (view() !== 'reader') return;
      flash(span);
      const mode = settings.clickMode;
      if (mode === 'sound') { TTS.speak(word); return; }
      showDict(word, x, y);
      if (mode === 'both') TTS.speak(word);
    },
    onWordStart(word, x, y, span) {
      if (view() !== 'reader') return;
      // 单击单词瞬间立即关闭上一句句子弹层，避免 260ms 防抖期间译文仍显示
      if ($('#sent-popup').classList.contains('open')) {
        $('#sent-popup').classList.remove('open');
        lastSentPos = null;
        lastSentRect = null;
      }
    },
    onSentence(sent, word, x, y, sentRect) {
      if (view() !== 'reader') return;
      hideDict();
      showSentence(sent, word, x, y, sentRect);
    },
    onBlank(fx, target) {
      if (view() !== 'reader') return;
      if (target && target.closest && target.closest('.reader-top,.reader-bottom,.settings-panel,.toc-drawer,.dict-popup,.sent-popup,.mask,.toast,.loading')) return;
      if (closeAnyPopup()) return;
      if (!reader) return;
      if (fx < 0.3) reader.prev();
      else if (fx > 0.7) reader.next();
      else toggleChrome();
    }
  };

  function flash(span) {
    if (!span) return;
    span.classList.add('w-active');
    setTimeout(() => span.classList.remove('w-active'), 700);
  }

  function toggleChrome() {
    document.body.classList.toggle('chrome-hidden');
    setTimeout(() => reader && reader.onResize && reader.onResize(), 300);
  }

  function closeAnyPopup() {
    let closed = false;
    if (!$('#dict-popup').classList.contains('hidden')) { hideDict(); closed = true; }
    if ($('#sent-popup').classList.contains('open')) { $('#sent-popup').classList.remove('open'); lastSentRect = null; closed = true; }
    if ($('#settings-panel').classList.contains('open')) { closeSettings(); closed = true; }
    if ($('#toc-drawer').classList.contains('open')) { closeToc(); closed = true; }
    if (closed) Interaction.clearSelection(); // 关闭弹层时清掉整句高亮
    return closed;
  }

  /* ---------- 词典卡片 ---------- */
  async function showDict(word, x, y) {
    const popup = $('#dict-popup');
    dictCurrent = { word, audio: '', zh: '', phonetic: '', en: '', meanings: [] };
    $('#dict-word').textContent = word;
    $('#dict-phonetic').textContent = '';
    $('#dict-body').innerHTML = '<div class="dict-loading">查询中…</div>';
    popup.classList.remove('hidden');
    lastDictPos = { x, y };
    placeNear(popup, x, y);   // 仅在显示的一刻定位一次，之后内容增量加载不再重排

    /* 增量渲染：翻译与词典释义并行获取，谁先回来先显示谁，互不阻塞 */
    const render = () => {
      if (!dictCurrent || dictCurrent.word !== word) return;
      let html = '';
      if (dictCurrent.zh && dictCurrent.zh !== word) html += '<div class="dict-zh">' + esc(dictCurrent.zh) + '</div>';
      for (const m of dictCurrent.meanings) {
        html += '<div class="dict-pos">[' + esc(m.pos) + ']</div><div class="dict-def">' + esc(m.def) + '</div>';
      }
      if (!html) html = '<div class="dict-loading">未找到释义</div>';
      $('#dict-body').innerHTML = html;
      $('#dict-phonetic').textContent = dictCurrent.phonetic || '';
      // 注意：此处不再调用 placeNear —— 高度变化已在定位时通过 max-height 封顶，避免卡片跳动
    };

    const proxy = settings.translateProxy;
    Translator.translate(word, proxy).then(zh => {
      if (dictCurrent && dictCurrent.word === word) { dictCurrent.zh = zh; render(); }
    }).catch(() => {});

    Dict.lookup(word).then(d => {
      if (dictCurrent && dictCurrent.word === word) {
        dictCurrent.audio = d.audio;
        dictCurrent.phonetic = d.phonetic;
        dictCurrent.en = (d.meanings[0] || {}).def || '';
        dictCurrent.meanings = d.meanings;
        render();
      }
    }).catch(() => {});
  }

  /* 将弹层锚定在点击点附近，且只定位一次：
   *  - 优先显示在单词「上方」（空间更大的一侧），并钉住底边，使卡片向上生长时底边不漂移；
   *  - 用 max-height 把卡片高度在定位时就封顶，后续增量内容只会在内部滚动，卡片不再跳动；
   *  - 因此 translate/词典释义先后到达都不会让窗口上跳下跳。 */
  function placeNear(popup, x, y) {
    const topThreshold = 56, bottomThreshold = 64;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = popup.offsetWidth || (popup.classList.contains('dict-popup') ? 320 : 480);
    const spaceAbove = y - topThreshold;
    const spaceBelow = vh - bottomThreshold - y;
    const placeAbove = spaceAbove >= spaceBelow;
    const avail = (placeAbove ? spaceAbove : spaceBelow) - 12;

    if (placeAbove) {
      // 钉住底边：卡片向上展开，底边始终贴近单词，位置稳定
      popup.style.top = 'auto';
      popup.style.bottom = (vh - (y - 12)) + 'px';
    } else {
      // 钉住顶边：卡片向下展开
      popup.style.bottom = 'auto';
      popup.style.top = (y + 24) + 'px';
    }

    // 高度封顶：卡片在定位瞬间即达到最大可能高度，内容增量加载也不会改变尺寸
    if (popup.classList.contains('dict-popup')) {
      const body = popup.querySelector('.dict-body');
      if (body) body.style.maxHeight = Math.max(60, avail - 100) + 'px';
    } else {
      popup.style.maxHeight = Math.max(80, avail) + 'px';
      popup.style.overflowY = 'auto';
    }

    // 水平：以点击点为中心，夹在视口内
    let left = Math.min(Math.max(8, x - w / 2), vw - w - 8);
    popup.style.left = left + 'px';
  }

  /* 句子弹层专用：把弹层放到【选中整句之外】，绝不遮挡高亮句子。
   * 依据整句矩形上方/下方的剩余空间选边，钉住靠近句子那条边缘，并把高度封顶。 */
  function placeNearSentence(popup, rect) {
    const topThreshold = 56, bottomThreshold = 64;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = popup.offsetWidth || 480;
    const spaceAbove = rect.top - topThreshold;
    const spaceBelow = vh - bottomThreshold - rect.bottom;
    const placeAbove = spaceAbove >= spaceBelow;
    const avail = (placeAbove ? spaceAbove : spaceBelow) - 12;

    if (placeAbove) {
      // 钉住底边：弹层整块位于句子上方，底边距句子 12px
      popup.style.top = 'auto';
      popup.style.bottom = (vh - (rect.top - 12)) + 'px';
    } else {
      // 钉住顶边：弹层整块位于句子下方，顶边距句子 12px
      popup.style.bottom = 'auto';
      popup.style.top = (rect.bottom + 12) + 'px';
    }

    // 高度封顶：不超过该侧的可用空间，既不遮挡句子，位置也恒定不跳动
    popup.style.maxHeight = Math.max(80, avail) + 'px';
    popup.style.overflowY = 'auto';

    // 水平以整句中心为基准，夹在视口内
    const cx = (rect.left + rect.right) / 2;
    let left = Math.min(Math.max(8, cx - w / 2), vw - w - 8);
    popup.style.left = left + 'px';
  }

  function hideDict() {
    $('#dict-popup').classList.add('hidden');
    dictCurrent = null;
    lastDictPos = null;
  }

  /* ---------- 句子翻译弹层（锚定在单词上方/下方） ---------- */
  async function showSentence(sent, word, x, y, sentRect) {
    currentSentence = sent;
    const popup = $('#sent-popup');
    $('#sent-zh').textContent = '翻译中…';
    popup.classList.add('open');
    lastSentPos = { x, y };
    lastSentRect = sentRect || null;
    /* 定位一次：优先把弹层放到整句高亮之外（不遮挡选中的句子）；无句矩形时退化为锚定点击点 */
    if (sentRect) placeNearSentence(popup, sentRect);
    else placeNear(popup, x, y);

    const proxy = settings.translateProxy;
    /* 并行翻译整句 + 单词本身 */
    const [zhSent, zhWord] = await Promise.all([
      Translator.translate(sent, proxy),
      word ? Translator.translate(word, proxy) : Promise.resolve('')
    ]);
    if (currentSentence !== sent) return;

    /* 只显示中文译文；双击词的中文释义在译文内【内联加粗】，不再单独提取成一行。
     * 取词的中文释义及其各义项（按 、,/，；; 切分）作为候选，在译文中逐个匹配，
     * 命中即加粗——可覆盖意译（句中用了同义表达时也能高亮）。 */
    let html = esc(zhSent);
    if (word && zhWord && zhWord !== word) {
      const cands = [...new Set([zhWord.trim(), ...zhWord.split(/[、,/，；;]/).map(s => s.trim()).filter(Boolean)])]
        .sort((a, b) => b.length - a.length);
      for (const c of cands) {
        if (c && zhSent.includes(c)) {
          html = esc(zhSent).split(esc(c)).join('<b class="kw">' + esc(c) + '</b>');
          break;
        }
      }
    }
    $('#sent-zh').innerHTML = html;
    // 翻译返回后不再重排，沿用初次定位，避免卡片跳动
  }

  /* ---------- 书架 ---------- */
  async function renderShelf() {
    const books = (await DB.getAll('books')).sort((a, b) => b.addedAt - a.addedAt);
    const grid = $('#shelf-grid');
    grid.innerHTML = '';
    $('#shelf-empty').classList.toggle('hidden', books.length > 0);
    for (const b of books) {
      const card = document.createElement('div');
      card.className = 'book-card';
      const coverHtml = b.cover
        ? '<img src="' + b.cover + '" alt="">'
        : '<div class="cover-placeholder"><span class="cp-type">' + b.type.toUpperCase() + '</span><span class="cp-title">' + esc(b.title) + '</span></div>';
      card.innerHTML =
        '<div class="book-cover">' + coverHtml + '</div>' +
        '<div class="book-name">' + esc(b.title) + '</div>' +
        '<div class="book-progress">' + (b.progress ? '已读 ' + Math.round(b.progress * 100) + '%' : '未开始') + '</div>' +
        '<button class="book-del" title="删除">✕</button>';
      card.addEventListener('click', () => openBook(b.id));
      card.querySelector('.book-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('删除《' + b.title + '》？')) return;
        await DB.del('books', b.id);
        await DB.del('files', b.id);
        renderShelf();
      });
      grid.appendChild(card);
    }
    updateStatLine();
    updateVocabCount();
  }

  function updateStatLine() {
    const m = Stats.todayMinutes();
    const streak = Stats.streakDays();
    $('#stat-line').textContent = '今日阅读 ' + m + ' 分钟' + (streak > 1 ? ' · 连续 ' + streak + ' 天' : '');
  }

  async function updateVocabCount() {
    const v = await DB.getAll('vocab');
    $('#vocab-count').textContent = v.length;
  }

  /* ---------- 导入 ---------- */
  function blobUrlToDataUrl(url) {
    return fetch(url).then(r => r.blob()).then(blob => new Promise(res => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(blob);
    }));
  }

  async function pdfCover(buf) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 300 / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const url = canvas.toDataURL('image/jpeg', 0.72);
    doc.destroy();
    return url;
  }

  async function importFiles(files) {
    let ok = 0;
    for (const f of files) {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (!['epub', 'txt', 'pdf'].includes(ext)) { toast('不支持的格式：' + f.name); continue; }
      loading(true, '正在导入 ' + f.name);
      try {
        const buf = await f.arrayBuffer();
        const id = 'b' + Date.now() + Math.random().toString(36).slice(2, 7);
        let title = f.name.replace(/\.[^.]+$/, ''), author = '', cover = null;
        if (ext === 'epub') {
          try {
            const bk = ePub(buf.slice(0));
            await withTimeout(bk.ready, 8000, 'epub-ready');
            try {
              const meta = await withTimeout(bk.loaded.metadata, 5000, 'epub-meta');
              if (meta.title) title = meta.title;
              author = meta.creator || '';
            } catch (e) {}
            try {
              const cu = await withTimeout(bk.coverUrl(), 5000, 'epub-cover');
              if (cu) cover = await blobUrlToDataUrl(cu);
            } catch (e) {}
            bk.destroy();
          } catch (e) {}
        }
        if (ext === 'pdf') {
          try { cover = await withTimeout(pdfCover(buf.slice(0)), 10000, 'pdf-cover'); } catch (e) {}
        }
        await DB.put('files', { id, data: buf });
        await DB.put('books', { id, type: ext, title, author, cover, fileName: f.name, addedAt: Date.now(), progress: 0, location: null });
        ok++;
      } catch (e) {
        console.error(e);
        toast('导入失败：' + f.name);
      }
      loading(false);
    }
    if (ok) toast('成功导入 ' + ok + ' 本书');
    renderShelf();
  }

  /* ---------- 打开 / 关闭图书 ---------- */
  async function openBook(id) {
    const book = await DB.get('books', id);
    const file = await DB.get('files', id);
    if (!book || !file) { toast('文件数据丢失'); return; }
    loading(true, '正在打开《' + book.title + '》');
    switchView('reader');
    document.body.classList.remove('chrome-hidden');
    $('#reader-book-title').textContent = book.title;
    currentBookId = id;
    currentBookTitle = book.title;
    settings = Settings.set({ lastBookId: id });

    const container = $('#reader-container');
    container.innerHTML = '';
    const opts = { fontSize: settings.fontSize, pageMode: settings.pageMode, theme: settings.theme, handlers };
    const Cls = book.type === 'epub' ? EpubReader : book.type === 'pdf' ? PdfReader : TxtReader;
    reader = new Cls(container, file.data, opts);
    reader.onProgress = (info) => {
      $('#page-label').textContent = info.label;
      $('#progress-fill').style.width = Math.round(info.percent * 1000) / 10 + '%';
      queueSave(info);
    };
    try {
      await reader.init(book.location);
      buildToc();
      updatePageModeBtn();
      Translator.warmup(settings.translateProxy); // 提前建链，缩短首次点击的翻译延迟
    } catch (e) {
      console.error(e);
      toast('图书解析失败');
    }
    loading(false);
  }

  function queueSave(info) {
    clearTimeout(saveTimer);
    const id = currentBookId;
    saveTimer = setTimeout(async () => {
      if (!id) return;
      const book = await DB.get('books', id);
      if (!book) return;
      book.progress = info.percent;
      book.location = info.location;
      await DB.put('books', book);
    }, 800);
  }

  function closeBook() {
    if (reader) { try { reader.destroy(); } catch (e) {} }
    reader = null;
    currentBookId = null;
    TTS.stop();
    closeAnyPopup();
    switchView('shelf');
    renderShelf();
  }

  /* ---------- 目录 ---------- */
  function buildToc() {
    const list = $('#toc-list');
    list.innerHTML = '';
    const toc = (reader && reader.getToc && reader.getToc()) || [];
    if (!toc.length) {
      list.innerHTML = '<div style="padding:16px;font-size:13px;color:var(--text2)">本书没有目录</div>';
      return;
    }
    for (const item of toc) {
      const btn = document.createElement('button');
      btn.className = 'toc-item' + (item.lv === 2 ? ' lv2' : '');
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        reader && reader.goTo(item.target);
        closeToc();
      });
      list.appendChild(btn);
    }
  }

  function openToc() { $('#toc-drawer').classList.add('open'); $('#toc-mask').classList.remove('hidden'); }
  function closeToc() { $('#toc-drawer').classList.remove('open'); $('#toc-mask').classList.add('hidden'); }
  function openSettings() { $('#settings-panel').classList.add('open'); $('#settings-mask').classList.remove('hidden'); }
  function closeSettings() { $('#settings-panel').classList.remove('open'); $('#settings-mask').classList.add('hidden'); }
  function closeProxyHelp() { $('#proxy-help-panel').classList.remove('open'); $('#proxy-help-mask').classList.add('hidden'); }

  /* ---------- 设置 ---------- */
  function applyTheme(t) {
    settings = Settings.set({ theme: t });
    document.body.dataset.theme = t;
    reader && reader.setTheme && reader.setTheme(t);
    updateSwatches();
  }

  function updateSwatches() {
    $$('.swatch').forEach(s => s.classList.toggle('on', s.dataset.t === settings.theme));
  }

  function updateSegs() {
    $$('#click-mode-seg button').forEach(b => b.classList.toggle('on', b.dataset.m === settings.clickMode));
  }

  function updateFontLabel() { $('#font-size-label').textContent = settings.fontSize; }

  function updatePageModeBtn() {
    $('#btn-pagemode').textContent = settings.pageMode === 'single' ? '双页' : '单页';
  }

  /* ---------- 生词本 ---------- */
  async function renderVocab() {
    const list = (await DB.getAll('vocab')).sort((a, b) => b.addedAt - a.addedAt);
    const wrap = $('#vocab-list');
    wrap.innerHTML = '';
    $('#vocab-empty').classList.toggle('hidden', list.length > 0);
    for (const v of list) {
      const item = document.createElement('div');
      item.className = 'vocab-item';
      item.innerHTML =
        '<div class="vocab-main">' +
        '<span class="vocab-word">' + esc(v.word) + '</span>' +
        (v.phonetic ? '<span class="vocab-phonetic">' + esc(v.phonetic) + '</span>' : '') +
        '<div class="vocab-def">' + esc(v.zh || '') + (v.en ? '<br><span style="color:var(--text2)">' + esc(v.en) + '</span>' : '') + '</div>' +
        '<div class="vocab-meta">' + esc(v.book || '') + ' · ' + new Date(v.addedAt).toLocaleDateString('zh-CN') + '</div>' +
        '</div>' +
        '<div class="vocab-ops"><button class="chip v-speak">🔊</button><button class="chip v-del">删除</button></div>';
      item.querySelector('.v-speak').addEventListener('click', () => TTS.speak(v.word));
      item.querySelector('.v-del').addEventListener('click', async () => {
        await DB.del('vocab', v.word);
        renderVocab();
        updateVocabCount();
      });
      wrap.appendChild(item);
    }
  }

  async function exportVocab() {
    const list = await DB.getAll('vocab');
    if (!list.length) { toast('生词本为空'); return; }
    let csv = '\uFEFF单词,音标,中文释义,英文释义,来源书籍,添加日期\n';
    for (const v of list) {
      const row = [v.word, v.phonetic || '', v.zh || '', v.en || '', v.book || '', new Date(v.addedAt).toLocaleDateString('zh-CN')]
        .map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',');
      csv += row + '\n';
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '生词本-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 ' + list.length + ' 个生词');
  }

  /* ---------- 事件绑定 ---------- */
  function bindAll() {
    /* 书架 */
    $('#btn-import').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', (e) => {
      importFiles(Array.from(e.target.files));
      e.target.value = '';
    });
    $('#btn-vocab').addEventListener('click', () => { switchView('vocab'); renderVocab(); });
    $('#btn-vocab-back').addEventListener('click', () => { switchView('shelf'); renderShelf(); });
    $('#btn-vocab-export').addEventListener('click', exportVocab);

    /* 拖拽导入 */
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (view() !== 'shelf') return;
      dragDepth++;
      $('#drop-overlay').classList.remove('hidden');
    });
    document.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('#drop-overlay').classList.add('hidden');
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      $('#drop-overlay').classList.add('hidden');
      if (view() === 'shelf' && e.dataTransfer.files.length) importFiles(Array.from(e.dataTransfer.files));
    });

    /* 阅读工具栏 */
    $('#btn-back').addEventListener('click', closeBook);
    $('#btn-prev').addEventListener('click', () => reader && reader.prev());
    $('#btn-next').addEventListener('click', () => reader && reader.next());
    $('#btn-toc').addEventListener('click', openToc);
    $('#btn-toc-close').addEventListener('click', closeToc);
    $('#toc-mask').addEventListener('click', closeToc);
    $('#btn-settings').addEventListener('click', () => {
      $('#settings-panel').classList.contains('open') ? closeSettings() : openSettings();
    });
    $('#settings-mask').addEventListener('click', closeSettings);
    $('#btn-pagemode').addEventListener('click', () => {
      const m = settings.pageMode === 'single' ? 'double' : 'single';
      settings = Settings.set({ pageMode: m });
      updatePageModeBtn();
      reader && reader.setPageMode && reader.setPageMode(m);
    });

    /* 设置面板 */
    $$('.swatch').forEach(s => s.addEventListener('click', () => applyTheme(s.dataset.t)));
    $('#font-minus').addEventListener('click', () => {
      settings = Settings.set({ fontSize: Math.max(14, settings.fontSize - 2) });
      updateFontLabel();
      reader && reader.setFontSize && reader.setFontSize(settings.fontSize);
    });
    $('#font-plus').addEventListener('click', () => {
      settings = Settings.set({ fontSize: Math.min(26, settings.fontSize + 2) });
      updateFontLabel();
      reader && reader.setFontSize && reader.setFontSize(settings.fontSize);
    });
    $$('#click-mode-seg button').forEach(b => b.addEventListener('click', () => {
      settings = Settings.set({ clickMode: b.dataset.m });
      updateSegs();
    }));
    const proxyInput = $('#proxy-input');
    proxyInput.value = settings.translateProxy || '';
    $('#proxy-status').textContent = settings.translateProxy
      ? '已设置（未测试，可点「测试」验证）'
      : '未设置（当前走公共翻译，偏慢且有每日限额）';
    proxyInput.addEventListener('change', () => {
      settings = Settings.set({ translateProxy: proxyInput.value.trim() });
      toast(settings.translateProxy ? '已设置翻译代理' : '已清除翻译代理');
    });
    proxyInput.addEventListener('input', () => {
      const v = proxyInput.value.trim();
      const st = $('#proxy-status');
      if (!v) st.textContent = '未设置（当前走公共翻译，偏慢且有每日限额）';
      else st.textContent = '未测试';
      st.className = 'set-hint';
    });

    /* 测试代理连通性 */
    $('#proxy-test').addEventListener('click', async () => {
      const url = proxyInput.value.trim();
      const st = $('#proxy-status');
      if (!url) { st.textContent = '请先粘贴代理地址'; st.className = 'set-hint'; return; }
      st.textContent = '测试中…'; st.className = 'set-hint';
      try {
        const res = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'book', from: 'en', to: 'zh-CN' }),
          signal: AbortSignal.timeout(8000)
        });
        const data = await res.json().catch(() => ({}));
        const out = data.translatedText || data.text || '';
        if (res.ok && out) {
          st.textContent = '✓ 连接正常（' + out + '）';
          st.className = 'set-hint ok';
          settings = Settings.set({ translateProxy: url });
        } else {
          st.textContent = '✗ 返回异常：' + (out || res.status);
          st.className = 'set-hint err';
        }
      } catch (e) {
        st.textContent = '✗ 连接失败：' + (e && e.message ? e.message : '网络/CORS 错误');
        st.className = 'set-hint err';
      }
    });

    /* 部署引导弹层 */
    $('#proxy-help').addEventListener('click', () => {
      const code = document.getElementById('worker-code');
      $('#ph-code').textContent = code ? code.textContent : '';
      $('#proxy-help-panel').classList.add('open');
      $('#proxy-help-mask').classList.remove('hidden');
    });
    $('#ph-close').addEventListener('click', closeProxyHelp);
    $('#proxy-help-mask').addEventListener('click', closeProxyHelp);
    $('#ph-copy').addEventListener('click', () => {
      const code = document.getElementById('worker-code');
      const txt = code ? code.textContent : '';
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('已复制 Worker 代码'), () => toast('复制失败，请手动选择'));
      else toast('当前环境不支持自动复制');
    });

    /* 词典卡片 */
    $('#dict-speak').addEventListener('click', () => {
      if (!dictCurrent) return;
      if (dictCurrent.audio) { new Audio(dictCurrent.audio).play().catch(() => TTS.speak(dictCurrent.word)); }
      else TTS.speak(dictCurrent.word);
    });
    $('#dict-add').addEventListener('click', async () => {
      if (!dictCurrent) return;
      await DB.put('vocab', {
        word: dictCurrent.word,
        phonetic: dictCurrent.phonetic || '',
        zh: dictCurrent.zh || '',
        en: dictCurrent.en || '',
        book: currentBookTitle,
        addedAt: Date.now()
      });
      updateVocabCount();
      toast('已加入生词本');
      hideDict();
    });

    /* 句子弹层 */
    $('#sent-speak').addEventListener('click', () => TTS.speak(currentSentence, 0.9));
    $('#sent-close').addEventListener('click', () => { $('#sent-popup').classList.remove('open'); lastSentPos = null; lastSentRect = null; Interaction.clearSelection(); });

    /* 键盘 */
    document.addEventListener('keydown', (e) => {
      if (view() !== 'reader') return;
      if (e.key === 'Escape') { closeAnyPopup(); return; }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); reader && reader.next(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); reader && reader.prev(); }
    });

    /* 窗口尺寸变化 */
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        reader && reader.onResize && reader.onResize();
        // 缩放后重新把已打开的弹层夹回视口内（沿用之前的锚点，不闪烁）
        if (lastDictPos && !$('#dict-popup').classList.contains('hidden')) placeNear($('#dict-popup'), lastDictPos.x, lastDictPos.y);
        if ($('#sent-popup').classList.contains('open')) {
          if (lastSentRect) placeNearSentence($('#sent-popup'), lastSentRect);
          else if (lastSentPos) placeNear($('#sent-popup'), lastSentPos.x, lastSentPos.y);
        }
      }, 250);
    });

    /* 主文档单词交互（TXT / PDF） */
    Interaction.attach(document, null, handlers);
  }

  /* ---------- 启动 ---------- */
  async function init() {
    await DB.open();
    settings = Settings.get();
    document.body.dataset.theme = settings.theme;
    bindAll();
    updateSwatches();
    updateSegs();
    updateFontLabel();
    updatePageModeBtn();
    renderShelf();
    /* 自动恢复上次打开的书（含阅读位置，已存于 books.location），刷新不再关闭 */
    try {
      const lastId = settings.lastBookId;
      if (lastId) {
        const b = await DB.get('books', lastId);
        if (b) openBook(lastId);
      }
    } catch (e) {}
    /* 阅读时长统计：阅读视图下每 10 秒累计一次 */
    setInterval(() => {
      if (view() === 'reader' && !document.hidden) Stats.addSeconds(10);
    }, 10000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
