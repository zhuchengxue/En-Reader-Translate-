/* 主控逻辑：书架 / 导入 / 阅读 / 生词本 / 设置 / 统计 */
(() => {
  const APP_VER = '2026-07-29.39'; // 前端版本号：诊断面板可见 + index.html 版本守卫比对
  window.APP_VER = APP_VER; // 暴露给 index.html 内联守卫脚本做版本一致性校验
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  /* 安全绑定：元素不存在时跳过并告警，绝不让一次 null.addEventListener
   * 炸掉 bindAll 里后续所有绑定（SW 缓存新旧文件混搭时的防御） */
  const on = (sel, ev, fn, opts) => {
    const el = $(sel);
    if (el) el.addEventListener(ev, fn, opts);
    else console.warn('[bind] 元素缺失，跳过绑定:', sel);
  };

  /* ---------- 朗读跟随文字：句子切片 + 高亮清理（三阅读器共用，挂到 window 供 reader 调用） ---------- */
  /* 把 root 内所有文本节点按英文句末标点切成句子 span（在指定 doc 中创建，兼容 iframe）。
   * 不依赖 lookbehind，旧版移动端浏览器也能跑。 */
  function buildSentenceSpans(root, doc) {
    const spans = [];
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const tns = [];
    while (walker.nextNode()) tns.push(walker.currentNode);
    for (const tn of tns) {
      const text = tn.nodeValue;
      const parts = text.split(/([^.!?]+[.!?]+["')\]]*)/g).map(s => s.trim()).filter(Boolean);
      const sentences = parts.length ? parts : [text.trim()];
      const parent = tn.parentNode;
      const frag = doc.createDocumentFragment();
      for (const s of sentences) {
        const span = doc.createElement('span');
        span.className = 'tts-sent';
        span.textContent = s + ' ';
        frag.appendChild(span);
        spans.push(span);
      }
      parent.replaceChild(frag, tn);
    }
    return spans;
  }
  /* 朗读前先清掉上一轮的句子 span，避免重复包裹导致嵌套 */
  function cleanupTtsSpans(root, doc) {
    if (!root) return;
    try {
      root.querySelectorAll('.tts-sent').forEach(sp => {
        const t = doc.createTextNode(sp.textContent);
        sp.parentNode.replaceChild(t, sp);
      });
    } catch (e) {}
  }
  window.buildSentenceSpans = buildSentenceSpans;
  window.cleanupTtsSpans = cleanupTtsSpans;

  /* 切换某段的高亮态（segment 携带 nodes 数组） */
  function ttsHl(seg, on) {
    if (!seg || !seg.nodes) return;
    for (const n of seg.nodes) { try { n.classList.toggle('tts-hl', on); } catch (e) {} }
  }

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

  /* 按需加载重型第三方库：epub.js / pdf.js 仅在打开对应格式时才下载，
   * 书架与 TXT 阅读完全不付这笔解析/内存开销，首屏更轻、更快。 */
  const _vendorPromises = {};
  function ensureVendor(type) {
    if (_vendorPromises[type]) return _vendorPromises[type];
    const files = type === 'epub'
      ? ['vendor/jszip.min.js', 'vendor/epub.min.js']
      : type === 'pdf'
        ? ['vendor/pdf.min.js']
        : [];
    _vendorPromises[type] = (async () => {
      for (const f of files) {
        if (document.querySelector('script[data-src="' + f + '"]')) continue;
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = f; s.dataset.src = f;
          s.onload = res;
          s.onerror = () => rej(new Error('加载失败: ' + f));
          document.head.appendChild(s);
        });
      }
    })();
    return _vendorPromises[type];
  }

  function switchView(v) {
    document.body.dataset.view = v;
    $('#view-shelf').classList.toggle('hidden', v !== 'shelf');
    $('#view-vocab').classList.toggle('hidden', v !== 'vocab');
    $('#view-store').classList.toggle('hidden', v !== 'store');
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
    /* 只在阅读视图拦截点击。此前缺这个开关：书架上点到「书名文字」会被取词逻辑
     * stopPropagation 吞掉，表现为“点书没反应”——正是间歇性打不开书的元凶之一。 */
    enabled: () => view() === 'reader',
    onWord(word, x, y, info) {
      if (view() !== 'reader') return;
      // 一次 flashWord 即可：传 'stay'，让 showDict 接管 span（持续高亮直到 hideDict）
      const flashSpan = Interaction.flashWord(info.range, info.doc, 'stay');
      const mode = settings.clickMode;
      if (mode === 'sound') {
        if (flashSpan) flashSpan.classList.add('w-sound-only');
        setTimeout(() => { try { if (flashSpan && flashSpan.parentNode) { while (flashSpan.firstChild) flashSpan.parentNode.insertBefore(flashSpan.firstChild, flashSpan); flashSpan.parentNode.removeChild(flashSpan); if (flashSpan.parentNode.normalize) flashSpan.parentNode.normalize(); } } catch (e) {} }, 650);
        TTS.speak(word); return;
      }
      showDict(word, x, y, info.range, info.doc, flashSpan);
      if (mode === 'both') TTS.speak(word);
    },
    onWordStart(word, x, y, info) {
      if (view() !== 'reader') return;
      // 单击单词瞬间立即关闭上一句句子弹层，避免 260ms 防抖期间译文仍显示
      if ($('#sent-popup').classList.contains('open')) {
        $('#sent-popup').classList.remove('open');
        lastSentPos = null;
        lastSentRect = null;
      }
    },
    onSentence(sent, word, info, sentRect) {
      if (view() !== 'reader') return;
      hideDict();
      showSentence(sent, word, info.x, info.y, sentRect);
    },
    onBlank(fx, target) {
      if (view() !== 'reader') return;
      if (target && target.closest && target.closest('.reader-top,.reader-bottom,.settings-panel,.toc-drawer,.bookmark-drawer,.dict-popup,.sent-popup,.mask,.toast,.loading')) return;
      if (closeAnyPopup()) return;
      if (!reader) return;
      if (fx < 0.3) reader.prev();
      else if (fx > 0.7) reader.next();
      else if (!document.body.classList.contains('fs-active')) toggleChrome();
    },
    onSwipe(dir) {
      if (view() !== 'reader' || !reader) return;
      if (dir === 'left') reader.next();
      else if (dir === 'right') reader.prev();
    }
  };

  function flash(info) {
    Interaction.flashWord(info && info.range, info && info.doc);
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
    if ($('#search-panel').classList.contains('open')) { closeSearch(); closed = true; }
    if ($('#toc-drawer').classList.contains('open')) { closeToc(); closed = true; }
    if ($('#bookmark-drawer').classList.contains('open')) { closeBookmarks(); closed = true; }
    if (closed) Interaction.clearSelection(); // 关闭弹层时清掉整句高亮
    return closed;
  }

  /* ---------- 词典卡片 ---------- */
  /* 把 span.w-seen / w-stay 还原成纯文本；批量清理 */
  function replaceSpanWithText(span) {
    if (!span || !span.parentNode) return;
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    if (parent.normalize) parent.normalize();
  }

  /* 在 doc 中找出所有匹配 word 的文本节点，包上 span.w-seen 高亮 */
  function highlightAllTextNodes(doc, word) {
    const spans = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const re = new RegExp('\\b' + escRe(word) + '\\b', 'gi');
    const targetNodes = [];
    let tn;
    while ((tn = walker.nextNode())) {
      const pn = tn.parentNode;
      if (!pn || pn.nodeName === 'SCRIPT' || pn.nodeName === 'STYLE') continue;
      let inMark = false, n = tn;
      while (n) {
        if (n.classList && (n.classList.contains('w-seen') || n.classList.contains('w-stay') || n.classList.contains('w-active'))) { inMark = true; break; }
        n = n.parentNode;
      }
      if (!inMark && re.test(tn.nodeValue)) { targetNodes.push(tn); re.lastIndex = 0; }
    }
    for (const node of targetNodes) {
      const text = node.nodeValue;
      const matcher = new RegExp('\\b' + escRe(word) + '\\b', 'gi');
      const positions = [];
      let m;
      while ((m = matcher.exec(text)) !== null) positions.push({ s: m.index, e: m.index + word.length });
      // 从后往前替换，避免偏移失效
      for (let i = positions.length - 1; i >= 0; i--) {
        const { s, e } = positions[i];
        const r = doc.createRange();
        r.setStart(node, s);
        r.setEnd(node, e);
        const span = doc.createElement('span');
        span.className = 'w-seen';
        try { r.surroundContents(span); spans.push(span); }
        catch (_) { /* 跨元素边界等，放弃该位置 */ }
      }
    }
    return spans;
  }
  /* 正则元字符转义 */
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  /* HTML 实体转义 */
  function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  async function showDict(word, x, y, range, doc, flashSpan) {
    const popup = $('#dict-popup');

    /* 清理上一次查词留下的高亮 */
    if (dictCurrent && dictCurrent.span) {
      try { replaceSpanWithText(dictCurrent.span); } catch (e) {}
    }
    $$('.w-seen').forEach(s => { try { replaceSpanWithText(s); } catch (e) {} });

    dictCurrent = { word, audio: '', zh: '', phonetic: '', en: '', meanings: [], doc };
    $('#dict-word').textContent = word;
    $('#dict-phonetic').textContent = '';
    $('#dict-body').innerHTML = '<div class="dict-loading">查询中…</div>';
    popup.classList.remove('hidden');
    lastDictPos = { x, y };
    placeNear(popup, x, y);   // 仅在显示的一刻定位一次，之后内容增量加载不再重排

    /* 复用 onWord 已创建的 flashSpan，加 w-stay 表示持续高亮。
       若 onWord 没传（如直接调用），则用 range 重新创建。 */
    let span = flashSpan;
    if (!span && range && doc) {
      span = Interaction.flashWord(range, doc, 'stay');
    }
    if (span) {
      try {
        span.classList.remove('w-sound-only');
        span.classList.add('w-stay');
        dictCurrent.span = span;
      } catch (e) {}
    }

    /* 查新词前清理旧的 .w-seen 高亮（确保每次只显示当前词的标黄） */
    $$('.w-seen').forEach(s => { try { replaceSpanWithText(s); } catch (e) {} });

    /* 增量渲染：翻译与词典释义并行获取，谁先回来先显示谁，互不阻塞 */
    const render = () => {
      if (!dictCurrent || dictCurrent.word !== word) return;
      const lang = settings.dictLang || 'both';
      let html = '';
      if (lang !== 'en' && dictCurrent.zh && dictCurrent.zh !== word) html += '<div class="dict-zh">' + esc(dictCurrent.zh) + '</div>';
      if (lang !== 'zh') for (const m of dictCurrent.meanings) {
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
    const w = popup.offsetWidth || (popup.classList.contains('dict-popup') ? 240 : 480);
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
    /* 移除被点击单词的 w-stay span（蓝色高亮） */
    if (dictCurrent && dictCurrent.span) {
      try { replaceSpanWithText(dictCurrent.span); } catch (e) {}
    }
    /* 保留 .w-seen 标黄（用户加入生词本或开了整本高亮时）—— 下次点新词时由 showDict 清理 */
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
        SyncService.schedulePush();
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
    const total = Stats.totalMinutes();
    let s = '今日阅读 ' + m + ' 分钟';
    if (streak > 1) s += ' · 连续 ' + streak + ' 天';
    if (total >= 60) s += ' · 累计 ' + (total >= 600 ? Math.round(total / 60) : (total / 60).toFixed(1)) + ' 小时';
    else if (total > m) s += ' · 累计 ' + total + ' 分钟';
    $('#stat-line').textContent = s;
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

  /* 把一本书的二进制（ArrayBuffer）解析元数据/封面并写入 IndexedDB。
   * importFiles（本地文件）与古腾堡下载都复用它，保证入库逻辑唯一。 */
  async function addBookFromBuffer(buf, opts) {
    const ext = opts.ext;
    /* 按需加载重型解析库（epub.js / pdf.js），取元数据与封面要用；命中缓存 Promise 不重复下载 */
    if (ext === 'epub' || ext === 'pdf') { try { await ensureVendor(ext); } catch (e) { console.error(e); } }
    const id = 'b' + Date.now() + Math.random().toString(36).slice(2, 7);
    let title = opts.titleHint || (opts.name ? opts.name.replace(/\.[^.]+$/, '') : '未命名');
    let author = opts.authorHint || '';
    let cover = opts.coverHint || null;
    if (ext === 'epub') {
      try {
        const bk = ePub(buf.slice(0));
        await withTimeout(bk.ready, 8000, 'epub-ready');
        try {
          const meta = await withTimeout(bk.loaded.metadata, 5000, 'epub-meta');
          if (meta.title) title = meta.title;
          author = meta.creator || author;
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
    await DB.put('books', { id, type: ext, title, author, cover, fileName: opts.name || title, addedAt: Date.now(), progress: 0, location: null, source: opts.source || 'import' });
    SyncService.schedulePush(); // 含书文件（base64 编码），自动同步到其他设备
    return id;
  }

  async function importFiles(files) {
    let ok = 0;
    for (const f of files) {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (!['epub', 'txt', 'pdf'].includes(ext)) { toast('不支持的格式：' + f.name); continue; }
      loading(true, '正在导入 ' + f.name);
      try {
        const buf = await f.arrayBuffer();
        await addBookFromBuffer(buf, { ext, name: f.name });
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

  /* ---------- 古腾堡书城 ---------- */
  let storePage = 1, storeTerm = '', storeHasMore = false, storeLoading = false;

  function openStore() {
    /* 书城本身是免费公版书来源，不拦；只有「打开书」才受试用/激活闸门限制 */
    switchView('store');
    $('#store-search').value = '';
    $('#store-results').innerHTML = '';
    $('#store-empty').classList.add('hidden');
    $('#store-status').classList.add('hidden');
    storePage = 1; storeTerm = ''; storeHasMore = false;
    loadStore(true);
  }
  function closeStore() { switchView('shelf'); renderShelf(); }

  let storeTimer = null;
  function onStoreInput() {
    clearTimeout(storeTimer);
    storeTimer = setTimeout(() => { storeTerm = $('#store-search').value; storePage = 1; loadStore(true); }, 450);
  }
  async function loadStore(reset) {
    if (storeLoading) return;
    storeLoading = true;
    $('#store-more').classList.add('hidden');
    if (reset) $('#store-results').innerHTML = '';
    const status = $('#store-status');
    status.textContent = '加载中…'; status.classList.remove('hidden');
    try {
      const { results, next } = await Gutenberg.search(storeTerm, storePage);
      const grid = $('#store-results');
      $('#store-empty').classList.toggle('hidden', !(reset && !results.length));
      for (const b of results) renderStoreCard(b, grid);
      storeHasMore = next;
      $('#store-more').classList.toggle('hidden', !next);
      if (results.length) status.classList.add('hidden');
    } catch (e) {
      status.textContent = (e && e.message ? e.message : '加载失败') + '（本地请运行 serve.js，或部署到 Cloudflare 后使用）';
    } finally {
      storeLoading = false;
    }
  }
  function renderStoreCard(b, grid) {
    const fmt = Gutenberg.bestFormat(b.formats);
    const card = document.createElement('div');
    card.className = 'store-card';
    const coverHtml = b.cover
      ? '<img src="' + b.cover + '" alt="" onerror="this.remove()">'
      : '<div class="cover-placeholder"><span class="cp-type">EBOOK</span><span class="cp-title">' + esc(b.title) + '</span></div>';
    const author = b.authors.join(', ');
    const dlLabel = fmt ? (fmt.ext === 'epub' ? '下载 EPUB' : '下载 TXT') : '无可用格式';
    card.innerHTML =
      '<div class="book-cover">' + coverHtml + '</div>' +
      '<div class="book-name">' + esc(b.title) + '</div>' +
      (author ? '<div class="book-author">' + esc(author) + '</div>' : '') +
      '<button class="store-dl" ' + (fmt ? '' : 'disabled') + '>' + dlLabel + '</button>';
    const btn = card.querySelector('.store-dl');
    if (fmt) {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true; btn.textContent = '下载中…';
        try {
          const buf = await Gutenberg.download(fmt.url);
          await addBookFromBuffer(buf, {
            ext: fmt.ext, name: b.title + '.' + fmt.ext,
            titleHint: b.title, authorHint: author, coverHint: b.cover, source: 'gutenberg'
          });
          btn.textContent = '✓ 已加入书架'; btn.classList.add('done');
          toast('已下载《' + b.title + '》到书架');
          renderShelf();
        } catch (e) {
          btn.disabled = false; btn.textContent = dlLabel;
          toast('下载失败：' + (e && e.message ? e.message : e));
        }
      });
    }
    grid.appendChild(card);
  }

  /* ---------- 书签（命名位置书签，按书聚合于 IndexedDB） ---------- */
  function openBookmarks() {
    closeSettings(); closeSearch(); closeToc();
    $('#bookmark-drawer').classList.add('open');
    $('#bookmark-mask').classList.remove('hidden');
    renderBookmarks();
    setTimeout(() => { const i = $('#bm-input'); if (i) i.focus(); }, 60);
  }
  function closeBookmarks() {
    $('#bookmark-drawer').classList.remove('open');
    $('#bookmark-mask').classList.add('hidden');
  }
  async function renderBookmarks() {
    const list = $('#bookmark-list');
    list.innerHTML = '';
    const bms = await DB.getBookmarks(currentBookId);
    if (!bms.length) {
      list.innerHTML = '<div class="bm-empty">还没有书签。<br>在下方输入名称（可留空），点「保存」即可收藏当前位置。</div>';
      return;
    }
    for (const bm of bms) {
      const item = document.createElement('div');
      item.className = 'bm-item';
      const title = (bm.title || '').trim();
      const text = (bm.text || '').trim();
      const name = (bm.name || '').trim();
      const label = (bm.label || '').trim();
      const snippet = text.length > 160 ? (text.slice(0, 160) + '…') : text;
      item.innerHTML =
        '<button class="bm-jump" title="跳转到该书签">' +
          (name ? '<span class="bm-name">' + esc(name) + '</span>' : '') +
          (title ? '<span class="bm-title">' + esc(title) + '</span>' : '') +
          (snippet ? '<span class="bm-text">' + esc(snippet) + '</span>' : '') +
          (label && !title ? '<span class="bm-label">' + esc(label) + '</span>' : '') +
        '</button>' +
        '<button class="bm-del" title="删除">✕</button>';
      item.querySelector('.bm-jump').addEventListener('click', () => jumpToBookmark(bm));
      item.querySelector('.bm-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        await DB.delBookmark(bm.id);
        renderBookmarks();
      });
      list.appendChild(item);
    }
  }
  async function addBookmark() {
    if (!reader || !reader.getLocation) return;
    const loc = reader.getLocation();
    if (reader instanceof EpubReader && !loc.cfi) { toast('位置尚未就绪，稍候再试'); return; }
    const input = $('#bm-input');
    let name = (input && input.value || '').trim();
    if (!name) name = '位置 · ' + (($('#page-label').textContent || '').trim() || '未命名');
    name = name.slice(0, 60);
    /* 书签保留「标题 + 文字」：标题=当前章节，文字=当前屏首段/本页（调用方 await，取不到也不阻断） */
    let title = '', text = '';
    try {
      if (reader.getBookmarkContext) {
        const ctx = await reader.getBookmarkContext();
        title = (ctx && ctx.title || '').trim();
        text = (ctx && ctx.text || '').trim();
      }
    } catch (e) {}
    const bm = {
      id: currentBookId + ':' + Date.now(),
      bookId: currentBookId,
      name,
      label: ($('#page-label').textContent || '').trim(),
      title,
      text,
      location: loc,
      addedAt: Date.now()
    };
    await DB.addBookmark(bm);
    if (input) input.value = '';
    toast('已添加书签');
    renderBookmarks();
  }
  function jumpToBookmark(bm) {
    if (reader && reader.goTo) { try { reader.goTo(bm.location); } catch (e) {} }
    closeBookmarks();
  }

  /* ---------- 朗读（直接驱动浏览器内置 speechSynthesis，免费无需 Key） ----------
   * 连续朗读：从【当前屏幕】开始，逐句高亮跟随文字，读完一屏自动翻页，到末页停止。
   * 三阅读器各提供 getPageSegments() 返回 [{text, nodes}]（nodes 为要高亮的 DOM 节点），
   * 切屏后自动重建，保证高亮永远落在可见文本上。 */
  const ttsCtl = {
    continuous: false,
    rate: 0.95,
    _segIdx: null,
    _pageSegs: [],
    _pageKey: '',
    _lastKey: '',
    _nomove: 0,
    _empty: 0,
    _moved: false,
    _relo: null,
    startContinuous() {
      if (!reader) return;
      if (this.continuous) { this.stop(); return; }
      this.continuous = true;
      this._segIdx = null; this._lastKey = ''; this._nomove = 0; this._empty = 0; this._moved = false;
      /* EPUB：监听 relocated，确认翻页真的生效，避免渲染慢导致误判「读完」 */
      if (reader instanceof EpubReader && reader.rendition) {
        this._relo = () => { this._moved = true; };
        try { reader.rendition.on('relocated', this._relo); } catch (e) {}
      }
      this._updateBtn();
      this._step();
    },
    stop() {
      this.continuous = false;
      if (this._pageSegs) for (const s of this._pageSegs) ttsHl(s, false);
      if (this._relo && reader && reader.rendition) {
        try { reader.rendition.off('relocated', this._relo); } catch (e) {}
        this._relo = null;
      }
      TTS.stop();
      if (reader && reader.clearTts) try { reader.clearTts(); } catch (e) {}
      this._segIdx = null; this._pageSegs = [];
      this._updateBtn();
    },
    async _step() {
      if (!this.continuous) return;
      if (this._segIdx == null) {
        /* 加载当前屏的句子片段 */
        try { this._pageSegs = reader.getPageSegments ? reader.getPageSegments() : []; } catch (e) { this._pageSegs = []; }
        this._segIdx = 0;
        try { this._pageKey = (reader.getPageText ? (await reader.getPageText()) : '') || ''; } catch (e) { this._pageKey = ''; }
        if (!this._pageSegs.length) { this._emptyFail(); return; }
        this._empty = 0;
      }
      if (this._segIdx >= this._pageSegs.length) {
        /* 当前屏读完：翻页或停止 */
        if (!this._canAdvance()) { this.stop(); toast('已读完'); return; }
        if (this._pageKey === this._lastKey) {
          if (reader instanceof EpubReader && !this._moved) {
            if (++this._nomove > 4) { this.stop(); toast('已读完'); return; }
            setTimeout(() => this._step(), 350); return;
          }
          this.stop(); toast('已读完'); return;
        }
        this._nomove = 0; this._lastKey = this._pageKey;
        this._advance();
        this._segIdx = null;
        setTimeout(() => this._step(), reader instanceof EpubReader ? 320 : 160);
        return;
      }
      const seg = this._pageSegs[this._segIdx];
      ttsHl(seg, true);
      TTS.speak(seg.text, this.rate, () => {
        if (!this.continuous) return;
        ttsHl(seg, false);
        this._segIdx++;
        this._step();
      });
    },
    _emptyFail() {
      this._empty++;
      if (this._empty > 4 || !this._canAdvance()) { this.stop(); if (this._empty > 4) toast('已读完'); return; }
      this._advance();
      this._segIdx = null;
      setTimeout(() => this._step(), reader instanceof EpubReader ? 320 : 140);
    },
    _canAdvance() {
      if (!reader) return false;
      if (reader instanceof PdfReader) return reader.page < reader.total;
      if (reader instanceof TxtReader) return reader.section < reader.sections.length - 1 || reader.page < reader.pages - 1;
      if (reader instanceof EpubReader) return true; // EPUB 总是可尝试翻页，到末页由 relocated 守卫判定
      return false;
    },
    _advance() {
      this._moved = false;
      if (reader) { try { reader.next(); } catch (e) {} }
    },
    _updateBtn() {
      const b = $('#btn-read');
      if (!b) return;
      if (this.continuous) { b.textContent = '停止'; b.classList.add('reading'); }
      else { b.textContent = '朗读'; b.classList.remove('reading'); }
    }
  };

  /* ---------- 打开 / 关闭图书 ---------- */
  async function openBook(id) {
    let book = null;
    try {
      /* 授权闸门：未激活且试用耗尽 -> 拦截打开并弹激活模态 */
      if (window.License && License.gateEnabled() && !(await License.isActivated())) {
        if (License.getTrialRemaining() <= 0) { openActivate(); return; }
        License.useTrial();
        updateTrialBanner();
      }
      ttsCtl.stop(); // 打开新书前停止上一本的朗读
      book = await DB.get('books', id);
      const file = await DB.get('files', id);
      if (!book || !file) {
        toast('《' + (book ? book.title : '该书') + '》的文件数据已被浏览器清理，请重新导入');
        return;
      }
      if (!file.data || !(file.data instanceof ArrayBuffer)) {
        toast('《' + book.title + '》文件数据格式异常，请删除后重新导入');
        return;
      }
      loading(true, '正在打开《' + book.title + '》');
      switchView('reader');
      document.body.classList.remove('chrome-hidden');
      $('#reader-book-title').textContent = book.title;
      currentBookId = id;
      currentBookTitle = book.title;
      settings = Settings.set({ lastBookId: id });

      const container = $('#reader-container');
      container.innerHTML = '';
      const opts = {
        fontSize: settings.fontSize, pageMode: settings.pageMode, theme: settings.theme,
        lineHeight: settings.lineHeight, marginSize: settings.marginSize, pageAnim: settings.pageAnim, handlers
      };
      const Cls = book.type === 'epub' ? EpubReader : book.type === 'pdf' ? PdfReader : TxtReader;

      /* EPUB/PDF 依赖重型解析库，必须加载成功才能继续；失败时抛出明确错误 */
      if (book.type === 'epub' || book.type === 'pdf') {
        await ensureVendor(book.type);
        if (book.type === 'epub' && typeof ePub === 'undefined') {
          throw new Error('epub.js 未加载成功，请检查网络 / 脚本是否被拦截');
        }
        if (book.type === 'pdf' && typeof pdfjsLib === 'undefined') {
          throw new Error('pdf.js 未加载成功，请检查网络 / 脚本是否被拦截');
        }
      }

      reader = new Cls(container, file.data, opts);
      reader.onProgress = (info) => {
        $('#page-label').textContent = info.label;
        $('#progress-fill').style.width = Math.round(info.percent * 1000) / 10 + '%';
        queueSave(info);
      };
      await reader.init(book.location);
      buildToc();
      updatePageModeBtn();
      Translator.warmup(settings.translateProxy); // 提前建链，缩短首次点击的翻译延迟
    } catch (e) {
      console.error('openBook error', e);
      const msg = e && e.message ? e.message : String(e);
      toast('图书解析失败：' + msg);
      // 解析失败时回到书架，避免用户卡在空白阅读器
      setTimeout(() => { try { closeBook(); } catch (_) {} }, 50);
    } finally {
      loading(false);
    }
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
      book.updatedAt = Date.now();
      await DB.put('books', book);
      SyncService.schedulePush();
    }, 800);
  }

  function closeBook() {
    if (reader) { try { reader.destroy(); } catch (e) {} }
    reader = null;
    currentBookId = null;
    ttsCtl.stop();
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

  /* ---------- 书内全文搜索 ---------- */
  let searchTimer = null;
  let searchSeq = 0;         // 请求序号：丢弃过期结果（快速连续输入时）
  let lastSearchQ = '';

  function openSearch() {
    closeSettings(); closeToc();
    $('#search-panel').classList.add('open');
    $('#search-mask').classList.remove('hidden');
    const inp = $('#search-input');
    inp.focus();
    inp.select();
  }

  function closeSearch() {
    $('#search-panel').classList.remove('open');
    $('#search-mask').classList.add('hidden');
  }

  async function runSearch(q) {
    const status = $('#search-status');
    const box = $('#search-results');
    q = q.trim();
    lastSearchQ = q;
    if (q.length < 2) {
      status.classList.toggle('hidden', !q);
      status.textContent = q ? '至少输入 2 个字符' : '';
      box.innerHTML = '';
      return;
    }
    if (!reader || !reader.search) { status.classList.remove('hidden'); status.textContent = '当前图书不支持搜索'; return; }
    const seq = ++searchSeq;
    status.classList.remove('hidden');
    status.textContent = '搜索中…';
    let results = [];
    try { results = await reader.search(q); } catch (e) { console.error('search error', e); }
    if (seq !== searchSeq || lastSearchQ !== q) return;   // 已有更新的搜索，丢弃本次
    status.textContent = results.length
      ? '共 ' + results.length + (results.length >= 200 ? '+' : '') + ' 处匹配'
      : '未找到 “' + q + '”';
    box.innerHTML = '';
    const frag = document.createDocumentFragment();
    const hlRe = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    for (const r of results) {
      const btn = document.createElement('button');
      btn.className = 'search-hit';
      btn.innerHTML =
        (r.label ? '<span class="hit-label">' + esc(r.label) + '</span>' : '') +
        esc(r.snippet).replace(hlRe, '<b>$1</b>');
      btn.addEventListener('click', () => {
        closeSearch();
        try { reader && reader.showMatch && reader.showMatch(r.target, q); } catch (e) {}
      });
      frag.appendChild(btn);
    }
    box.appendChild(frag);
  }

  function openToc() { $('#toc-drawer').classList.add('open'); $('#toc-mask').classList.remove('hidden'); }
  function closeToc() { $('#toc-drawer').classList.remove('open'); $('#toc-mask').classList.add('hidden'); }
  function openSettings() {
    /* 打开设置时关闭其他浮动弹层，避免层级叠加遮挡 */
    if (!$('#dict-popup').classList.contains('hidden')) hideDict();
    if ($('#sent-popup').classList.contains('open')) { $('#sent-popup').classList.remove('open'); lastSentPos = null; lastSentRect = null; Interaction.clearSelection(); }
    closeSearch();
    closeToc();
    $('#settings-panel').classList.add('open'); $('#settings-mask').classList.remove('hidden');
  }
  function closeSettings() { $('#settings-panel').classList.remove('open'); $('#settings-mask').classList.add('hidden'); }
  /* 书架顶「同步」按钮：直接控制内联同步面板的展开/收起 */
  function _toggleSyncPanel() {
    const panel = $('#shelf-sync-panel');
    const input = $('#shelf-sync-input');
    if (!panel) return;
    if (panel.classList.contains('hidden')) {
      SyncService.init();
      input.value = SyncService.getToken() || '';
      panel.classList.remove('hidden');
      setTimeout(() => input && input.focus(), 50);
    } else {
      panel.classList.add('hidden');
    }
  }
  async function _saveSyncToken() {
    const input = $('#shelf-sync-input');
    const val = (input && input.value || '').trim();
    if (!val) { toast('请输入同步口令'); return; }
    SyncService.setToken(val);
    toast('已保存');
    const n = await SyncService.syncOnce();
    if (n > 0) { renderShelf(); toast('同步完成，合并了 ' + n + ' 项'); }
    else toast('已是最新');
    $('#shelf-sync-panel').classList.add('hidden');
  }
  window._toggleSync = _toggleSyncPanel;
  window._saveSyncToken = _saveSyncToken;
  if (typeof window !== 'undefined') window.__highlightAllTextNodes = highlightAllTextNodes; // 测试用
  function closeProxyHelp() { $('#proxy-help-panel').classList.remove('open'); $('#proxy-help-mask').classList.add('hidden'); }

  /* ---------- 兑换码激活 / 试用限次 ---------- */
  function openActivate() {
    $('#activate-modal').classList.add('open');
    $('#activate-mask').classList.remove('hidden');
    const inp = $('#activate-input');
    inp.value = '';
    $('#activate-error').classList.add('hidden');
    setTimeout(() => inp.focus(), 50);
  }
  function closeActivate() {
    $('#activate-modal').classList.remove('open');
    $('#activate-mask').classList.add('hidden');
  }
  async function updateTrialBanner() {
    const banner = $('#trial-banner');
    if (!banner) return;
    const show = !!(window.License && License.gateEnabled() && !(await License.isActivated()));
    if (show) {
      const rem = License.getTrialRemaining();
      banner.textContent = '试用剩余 ' + rem + ' 次 · 输入兑换码解锁完整版';
      banner.classList.remove('hidden');
      document.body.classList.add('trial-on');
    } else {
      banner.classList.add('hidden');
      document.body.classList.remove('trial-on');
    }
  }
  async function submitActivate() {
    const inp = $('#activate-input');
    const err = $('#activate-error');
    const btn = $('#activate-submit');
    const code = (inp.value || '').trim();
    if (!code) { err.textContent = '请输入兑换码'; err.classList.remove('hidden'); return; }
    btn.disabled = true; btn.textContent = '激活中…'; err.classList.add('hidden');
    try {
      await License.activate(code);
      closeActivate();
      updateTrialBanner();
      updateActivateStatus();
      toast('激活成功，感谢支持！');
    } catch (e) {
      err.textContent = e.message || '激活失败'; err.classList.remove('hidden');
    } finally {
      btn.disabled = false; btn.textContent = '激活';
    }
  }
  async function updateActivateStatus() {
    const el = $('#activate-status');
    if (!el) return;
    if (window.License && await License.isActivated()) {
      el.textContent = '已激活 · 完整版'; el.className = 'set-hint set-ok';
    } else if (window.License && License.gateEnabled()) {
      el.textContent = '未激活 · 试用剩余 ' + License.getTrialRemaining() + ' 次'; el.className = 'set-hint';
    } else {
      el.textContent = ''; el.className = 'set-hint';
    }
  }
  async function initLicense() {
    if (!window.License || !License.gateEnabled()) return; // 测试环境不拦截
    if (await License.isActivated()) { updateTrialBanner(); return; }
    updateTrialBanner();
    if (License.getTrialRemaining() <= 0) openActivate();
  }

  /* ---------- 运行自检 / 诊断 ---------- */
  function closeDiag() { $('#diag-panel').classList.add('hidden'); $('#diag-mask').classList.add('hidden'); }

  /* 收集运行状态：书架/文件数据/解析库/SW/存储持久化，用于一键定位「打不开」类问题 */
  async function runDiag() {
    const body = $('#diag-body');
    body.textContent = '检测中…';
    $('#diag-panel').classList.remove('hidden');
    $('#diag-mask').classList.remove('hidden');
    const lines = [];
    const push = (k, v) => lines.push(k + '：' + v);
    push('前端版本', APP_VER + '（与我确认的最新版本不一致 = 浏览器在跑旧缓存，点下方「清除缓存并重启」）');
    try {
      const books = await DB.getAll('books').catch(() => []);
      const files = await DB.getAll('files').catch(() => []);
      const fileMap = new Map(files.map(f => [f.id, f]));
      push('书架书籍数', books.length);
      push('文件数据条数', files.length);
      let missing = 0;
      for (const b of books) {
        const f = fileMap.get(b.id);
        const has = !!(f && f.data);
        if (!has) missing++;
        let info = '【缺失】';
        if (has) {
          const t = Object.prototype.toString.call(f.data);
          const len = f.data.byteLength != null ? f.data.byteLength : (f.data.size != null ? f.data.size : 0);
          info = t + ' ' + (len / 1024).toFixed(1) + 'KB';
          if (t !== '[object ArrayBuffer]') info += ' ⚠类型异常(应为ArrayBuffer)';
        }
        lines.push('  [' + b.type + '] ' + b.title + ' → ' + info);
      }
      if (missing) {
        lines.push('');
        lines.push('⚠ ' + missing + ' 本书缺少文件数据（IndexedDB 被浏览器清理了）。');
        lines.push('  → 解决：点「导入图书」把这些书重新导入即可。');
      }
      push('epub.js 已加载', (typeof ePub !== 'undefined') ? '是' : '否（点 EPUB 时才加载）');
      push('pdf.js 已加载', (typeof pdfjsLib !== 'undefined') ? '是' : '否（点 PDF 时才加载）');
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
        push('ServiceWorker 数量', regs.length);
      } else push('ServiceWorker', '不支持');
      if (navigator.storage) {
        const persisted = await navigator.storage.persisted().catch(() => false);
        push('存储已持久化', persisted ? '是' : '否（磁盘紧张时浏览器可能清理数据）');
        if (navigator.storage.estimate) {
          const est = await navigator.storage.estimate().catch(() => null);
          if (est && est.quota) push('存储占用', (est.usage / 1048576).toFixed(1) + 'MB / 配额 ' + (est.quota / 1048576).toFixed(0) + 'MB');
        }
      }
      push('当前视图', view());
    } catch (e) {
      lines.push('诊断出错：' + (e && e.message ? e.message : e));
    }
    const text = lines.join('\n');
    body.textContent = text;
    console.log('[诊断]\n' + text);
  }

  /* 一键清除 ServiceWorker + 缓存并重启（应对旧缓存卡死） */
  async function fixAndRestart() {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) { await r.unregister(); }
      }
      if (window.caches) {
        const ks = await caches.keys();
        for (const k of ks) { await caches.delete(k); }
      }
      toast('已清除缓存，正在重启…');
      setTimeout(() => location.reload(true), 600);
    } catch (e) {
      toast('清除失败：' + (e && e.message ? e.message : e));
    }
  }

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
    $$('#dict-lang-seg button').forEach(b => b.classList.toggle('on', b.dataset.dl === (settings.dictLang || 'both')));
    $$('#persist-lookup-seg button').forEach(b => b.classList.toggle('on', (b.dataset.pl === '1') === !!settings.persistLookup));
    $$('#auto-resume-seg button').forEach(b => b.classList.toggle('on', (b.dataset.ar === '1') === !!settings.autoResumeBook));
  }

  function updateFontLabel() { $('#font-size-label').textContent = settings.fontSize; }

  function updateTypoSegs() {
    $$('#lh-seg button').forEach(b => b.classList.toggle('on', Number(b.dataset.lh) === Number(settings.lineHeight)));
    $$('#margin-seg button').forEach(b => b.classList.toggle('on', b.dataset.mg === settings.marginSize));
  }

  function updatePageModeBtn() {
    $('#btn-pagemode').textContent = settings.pageMode === 'single' ? '双页' : '单页';
  }

  function updatePageAnimSeg() {
    $$('#pageanim-seg button').forEach(b => b.classList.toggle('on', b.dataset.pa === settings.pageAnim));
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
  /* ---- 全屏阅读 ---- */
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement; }
  function toggleFullscreen() {
    const de = document.documentElement;
    if (!fsElement()) {
      const req = de.requestFullscreen || de.webkitRequestFullscreen;
      if (req) { try { req.call(de); } catch (e) {} }
    } else {
      const ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (ex) { try { ex.call(document); } catch (e) {} }
    }
  }
  function syncFsBtn() {
    const b = $('#btn-fs'); if (b) b.classList.toggle('is-fs', !!fsElement());
    const fs = !!fsElement();
    /* 全屏=沉浸式：默认隐藏顶/底栏，不呼出工具栏；Esc / 退出按钮退出全屏 */
    document.body.classList.toggle('fs-active', fs);
    document.body.classList.toggle('chrome-hidden', fs);
  }

  function bindAll() {
    /* 书架 */
    on('#btn-import', 'click', () => $('#file-input').click());
    /* 同步/设置按钮由内联 onclick 处理，不在此绑定 */
    on('#btn-diag', 'click', runDiag);
    on('#diag-close', 'click', closeDiag);
    on('#diag-mask', 'click', closeDiag);
    on('#diag-copy', 'click', () => {
      const txt = $('#diag-body').textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('已复制'), () => toast('复制失败'));
      else toast('当前环境不支持自动复制');
    });
    on('#diag-fixsw', 'click', fixAndRestart);
    on('#file-input', 'change', (e) => {
      importFiles(Array.from(e.target.files));
      e.target.value = '';
    });
    on('#btn-vocab', 'click', () => { switchView('vocab'); renderVocab(); });
    on('#btn-vocab-back', 'click', () => { switchView('shelf'); renderShelf(); });
    on('#btn-vocab-export', 'click', exportVocab);

    /* 古腾堡书城 */
    on('#btn-store', 'click', openStore);
    on('#btn-store-back', 'click', closeStore);
    on('#store-search', 'input', onStoreInput);
    on('#store-search', 'keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(storeTimer); storeTerm = e.target.value; storePage = 1; loadStore(true); }
      e.stopPropagation();
    });
    on('#store-search-btn', 'click', () => { storeTerm = $('#store-search').value; storePage = 1; loadStore(true); });
    on('#store-more', 'click', () => { if (storeHasMore && !storeLoading) { storePage++; loadStore(false); } });

    /* 兑换码激活 */
    on('#activate-submit', 'click', submitActivate);
    on('#activate-cancel', 'click', closeActivate);
    on('#activate-mask', 'click', closeActivate);
    on('#activate-input', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitActivate(); } });
    on('#btn-activate', 'click', openActivate);

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
    on('#btn-back', 'click', closeBook);
    on('#btn-prev', 'click', () => reader && reader.prev());
    on('#btn-next', 'click', () => reader && reader.next());
    on('#btn-toc', 'click', openToc);
    on('#btn-toc-close', 'click', closeToc);
    on('#toc-mask', 'click', closeToc);

    /* 书签 */
    on('#btn-bookmark', 'click', openBookmarks);
    on('#btn-bm-close', 'click', closeBookmarks);
    on('#bookmark-mask', 'click', closeBookmarks);
    on('#btn-bm-add', 'click', addBookmark);
    on('#bm-input', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBookmark(); } });

    /* 朗读：连续朗读（从当前屏幕开始，逐句跟随高亮） */
    on('#btn-read', 'click', () => { if (ttsCtl.continuous) ttsCtl.stop(); else ttsCtl.startContinuous(); });
    on('#btn-settings', 'click', () => {
      $('#settings-panel').classList.contains('open') ? closeSettings() : openSettings();
    });
    on('#settings-mask', 'click', closeSettings);
    on('#settings-close', 'click', closeSettings);
    on('#btn-pagemode', 'click', () => {
      const m = settings.pageMode === 'single' ? 'double' : 'single';
      settings = Settings.set({ pageMode: m });
      updatePageModeBtn();
      reader && reader.setPageMode && reader.setPageMode(m);
    });

    /* 查词高亮 / 启动行为 seg（设置面板） */
    $$('#persist-lookup-seg button').forEach(b => b.addEventListener('click', () => {
      settings = Settings.set({ persistLookup: b.dataset.pl === '1' });
      updateSegs();
      if (!settings.persistLookup) {
        $$('.w-seen').forEach(s => { try { replaceSpanWithText(s); } catch (e) {} });
      }
    }));
    $$('#auto-resume-seg button').forEach(b => b.addEventListener('click', () => {
      settings = Settings.set({ autoResumeBook: b.dataset.ar === '1' });
      updateSegs();
    }));

    /* 全屏：按钮 + 状态同步 + F 快捷键（阅读视图、非输入框）+ 退出浮钮 */
    on('#btn-fs', 'click', toggleFullscreen);
    on('#fs-exit-fab', 'click', toggleFullscreen);
    document.addEventListener('fullscreenchange', syncFsBtn);
    document.addEventListener('webkitfullscreenchange', syncFsBtn);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'f' && e.key !== 'F') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (view() === 'reader') { e.preventDefault(); toggleFullscreen(); }
    });

    /* 设置面板 */
    $$('.swatch').forEach(s => s.addEventListener('click', () => applyTheme(s.dataset.t)));
    on('#font-minus', 'click', () => {
      settings = Settings.set({ fontSize: Math.max(14, settings.fontSize - 2) });
      updateFontLabel();
      reader && reader.setFontSize && reader.setFontSize(settings.fontSize);
    });
    on('#font-plus', 'click', () => {
      settings = Settings.set({ fontSize: Math.min(26, settings.fontSize + 2) });
      updateFontLabel();
      reader && reader.setFontSize && reader.setFontSize(settings.fontSize);
    });
    $$('#click-mode-seg button').forEach(b => b.addEventListener('click', () => {
      settings = Settings.set({ clickMode: b.dataset.m });
      updateSegs();
    }));
    $$('#dict-lang-seg button').forEach(b => b.addEventListener('click', () => {
      settings = Settings.set({ dictLang: b.dataset.dl });
      updateSegs();
    }));
    $$('#lh-seg button').forEach(b => b.addEventListener('click', () => {
      settings = Settings.set({ lineHeight: Number(b.dataset.lh) });
      updateTypoSegs();
      reader && reader.setLineHeight && reader.setLineHeight(settings.lineHeight);
    }));
    $$('#margin-seg button').forEach(b => b.addEventListener('click', () => {
      settings = Settings.set({ marginSize: b.dataset.mg });
      updateTypoSegs();
      reader && reader.setMargin && reader.setMargin(settings.marginSize);
    }));
    $$('#pageanim-seg button').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.pa;
      settings = Settings.set({ pageAnim: a });
      $$('#pageanim-seg button').forEach(x => x.classList.toggle('on', x === b));
      reader && reader.setPageAnim && reader.setPageAnim(a);
    }));

    /* 书内搜索 */
    on('#btn-search', 'click', () => {
      $('#search-panel').classList.contains('open') ? closeSearch() : openSearch();
    });
    on('#btn-search-close', 'click', closeSearch);
    on('#search-mask', 'click', closeSearch);
    on('#search-input', 'input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(e.target.value), 350);
    });
    on('#search-input', 'keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(e.target.value); }
      if (e.key === 'Escape') closeSearch();
      e.stopPropagation(); // 不让阅读器快捷键（空格翻页等）截胡输入
    });
    const proxyInput = $('#proxy-input') || document.createElement('input'); // 缺失时用哑元素，保证 bindAll 不中断
    proxyInput.value = settings.translateProxy || '';
    if ($('#proxy-status')) $('#proxy-status').textContent = settings.translateProxy
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
    on('#proxy-test', 'click', async () => {
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
    on('#proxy-help', 'click', () => {
      const code = document.getElementById('worker-code');
      $('#ph-code').textContent = code ? code.textContent : '';
      $('#proxy-help-panel').classList.add('open');
      $('#proxy-help-mask').classList.remove('hidden');
    });
    on('#ph-close', 'click', closeProxyHelp);
    on('#proxy-help-mask', 'click', closeProxyHelp);
    on('#ph-copy', 'click', () => {
      const code = document.getElementById('worker-code');
      const txt = code ? code.textContent : '';
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('已复制 Worker 代码'), () => toast('复制失败，请手动选择'));
      else toast('当前环境不支持自动复制');
    });

    /* 书架同步面板（点开同步按钮展开） */
    on('#shelf-sync-save', 'click', _saveSyncToken);
    on('#shelf-sync-cancel', 'click', () => $('#shelf-sync-panel').classList.add('hidden'));
    on('#shelf-sync-input', 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); _saveSyncToken(); }
    });

    /* 词典卡片 */
    on('#dict-speak', 'click', () => {
      if (!dictCurrent) return;
      if (dictCurrent.audio) { new Audio(dictCurrent.audio).play().catch(() => TTS.speak(dictCurrent.word)); }
      else TTS.speak(dictCurrent.word);
    });
    on('#dict-add', 'click', async () => {
      if (!dictCurrent) return;
      const w = dictCurrent.word;
      const d = dictCurrent.doc;
      await DB.put('vocab', {
        word: w,
        phonetic: dictCurrent.phonetic || '',
        zh: dictCurrent.zh || '',
        en: dictCurrent.en || '',
        book: currentBookTitle,
        addedAt: Date.now()
      });
      updateVocabCount();
      hideDict();
      SyncService.schedulePush();
      /* 整本高亮开关 ON 时，加入生词本的同时标黄该词在全文中所有出现 */
      if (d && settings.persistLookup) {
        $$('.w-seen').forEach(s => { try { replaceSpanWithText(s); } catch (e) {} });
        const spans = highlightAllTextNodes(d, w);
        if (spans.length > 0) toast('已标黄 ' + spans.length + ' 处');
      }
    });

    /* 句子弹层 */
    on('#sent-speak', 'click', () => TTS.speak(currentSentence, 0.9));
    on('#sent-close', 'click', () => { $('#sent-popup').classList.remove('open'); lastSentPos = null; lastSentRect = null; Interaction.clearSelection(); });

    /* 键盘 */
    document.addEventListener('keydown', (e) => {
      if (view() !== 'reader') return;
      if (e.key === 'Escape') { closeAnyPopup(); ttsCtl.stop(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); return; }
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
    /* SW 更新器最先注册：即使下面任何一步因新旧文件混搭而报错，
     * 页面也能拿到新版 SW → 自动刷新自愈，不会永远停在坏状态 */
    registerSW();
    await DB.open();
    /* 请求持久化存储：防止浏览器在磁盘紧张时清理 IndexedDB 里的书籍文件数据（会导致点书打不开） */
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    settings = Settings.get();
    document.body.dataset.theme = settings.theme;
    /* 兑换码模块关闭时隐藏其全部 UI（入口/设置行/激活模态），便于调试与后续加功能 */
    if (!window.License || !License.enabled()) document.body.classList.add('no-license');
    try { bindAll(); } catch (e) { console.error('bindAll error', e); }
    try {
      updateSwatches();
      updateSegs();
      updateTypoSegs();
      updateFontLabel();
      updatePageModeBtn();
      updatePageAnimSeg();
      updateActivateStatus();
    } catch (e) { console.error('ui-init error', e); }
    /* 授权检查：未激活提示试用剩余；试用耗尽弹激活模态（仅真实浏览器，测试环境不拦） */
    try { await initLicense(); } catch (e) { console.error('license init error', e); }
    renderShelf();
    /* 跨设备同步：初始化 → 拉取合并 → 刷新书架（如有远端新书） */
    try {
      if (SyncService.init()) {
        const merged = await SyncService.syncOnce();
        if (merged > 0) {
          renderShelf();
          if (view() !== 'reader') renderVocab();
          toast('同步完成' + (merged ? '，合并了 ' + merged + ' 项' : ''));
        }
      }
    } catch (e) { console.error('sync init error', e); }
    /* 自动恢复上次打开的书（需设置中开启「自动打开上一次看的书」） */
    try {
      const lastId = settings.lastBookId;
      if (lastId && settings.autoResumeBook) {
        const b = await DB.get('books', lastId);
        if (b) openBook(lastId);
      }
    } catch (e) {}
    /* 阅读时长统计：阅读视图下每 10 秒累计一次 */
    setInterval(() => {
      if (view() === 'reader' && !document.hidden) Stats.addSeconds(10);
    }, 10000);
  }

  /* 注册 Service Worker：网络优先的同壳缓存，刷新秒开、离线可读（仅 http(s) 下生效）。
   * 关键：一旦部署了新版 SW，立即接管并让页面刷新一次，确保用户永远拿到最新代码，
   * 不会被旧缓存卡住（这是之前「改了代码却好像没生效 / 打不开书」的根因之一）。
   * 仅当页面【已被旧 SW 控制】时才刷新，首次访问（无旧 SW）不额外刷新，也不影响无头测试。 */
  function registerSW() {
    if (!('serviceWorker' in navigator) || location.protocol.indexOf('http') !== 0) return;
    /* 只负责注册。新 SW 在 sw.js 内 self.skipWaiting()+clients.claim() 会静默接管当前页面，
     * 配合 fetch 的「网络优先」策略，新版本的 HTML/JS/CSS 由 SW 直接回源返回，
     * 无需页面硬刷新即可生效 —— 避免「重新打开网址一直闪烁刷新」的不良体验。
     * （旧实现会在检测到新 SW 时 page.reload，每次发布后重开都会闪一下，已移除。） */
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', init);
})();
