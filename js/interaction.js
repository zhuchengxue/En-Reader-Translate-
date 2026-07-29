/* 单词交互：基于坐标的命中测试（caretRangeFromPoint），不再把整本书的每个单词都包成 <span>。
 * 这是流畅度的核心优化——去掉成千上万个常驻 DOM 节点后，重排/内存/重渲染卡顿从根本上消失。
 * 仅 PDF 文本层保留按词包裹（规模仅限可见页，可控），因为它被拆成了非整词片段。 */
const Interaction = (() => {
  const WORD_CH = /[A-Za-z'’\-]/;
  // 与 WORD_CH 同字符集，用于 PDF 文本层按词包裹（wrapWords）与句子回落取词（sentenceOf）。
  // 原先此处遗漏定义，导致 wrapWords 抛 ReferenceError（被 pdf.js 的 try/catch 吞掉），PDF 的 .w 整词路径失效。
  const WORD_RE = /[A-Za-z'’\-]+/g;

  /* 把容器内所有英文单词包裹为 <span class="w">（仅 PDF 文本层使用） */
  function wrapWords(root) {
    if (!root) return;
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('script,style,noscript')) return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('w')) return NodeFilter.FILTER_REJECT;
        return /[A-Za-z]/.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) {
      const txt = node.nodeValue;
      const frag = doc.createDocumentFragment();
      let last = 0, m;
      WORD_RE.lastIndex = 0;
      while ((m = WORD_RE.exec(txt))) {
        if (m.index > last) frag.appendChild(doc.createTextNode(txt.slice(last, m.index)));
        const s = doc.createElement('span');
        s.className = 'w';
        s.textContent = m[0];
        frag.appendChild(s);
        last = m.index + m[0].length;
      }
      if (last < txt.length) frag.appendChild(doc.createTextNode(txt.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  /* 判断视口坐标 (x,y) 是否落在 range 的实际包围盒内（容差 tol 像素）。
   * 这是「点哪都翻译」的根因修复：caretRangeFromPoint 会把点击吸附到最近单词，
   * 即使你点在一行末尾的空白 / 词间空格 / 页边距附近。只有真正落在单词盒子里的点击
   * 才算取词，其余一律当作空白（翻页 / 关弹层）。 */
  function pointInRange(x, y, range, tol) {
    let rects = range.getClientRects();
    if (!rects.length) {
      const r = range.getBoundingClientRect();
      if (r && (r.width || r.height)) rects = [r];
    }
    for (const r of rects) {
      if (x >= r.left - tol && x <= r.right + tol && y >= r.top - tol && y <= r.bottom + tol) return true;
    }
    return false;
  }

  /* 命中测试：在文档(doc)的视口坐标(x,y)处取出单词，返回 {word, node, offset, range, doc}
   * offset 为单词在 node 文本中的起始位置，供句子计算使用。
   * precise=true 时要求点击点必须落在单词包围盒内（单击取词用，避免误触）；
   * precise=false 时宽松（双击整句翻译用，确保点击略偏也能命中）。 */
  function wordAtPoint(doc, x, y, precise, tol) {
    let node = null, offset = 0;
    try {
      /* caretRangeFromPoint 为主力；iOS Safari 上可能因合成层/transform 返回 null，
       * 此时回退到 carePositionFromPoint（旧版 WebKit API，行为有时不同） */
      if (doc.caretRangeFromPoint) {
        const r = doc.caretRangeFromPoint(x, y);
        if (r) { node = r.startContainer; offset = r.startOffset; }
      }
      if ((!node || node.nodeType !== 3) && doc.caretPositionFromPoint) {
        const p = doc.caretPositionFromPoint(x, y);
        if (p) { node = p.offsetNode; offset = p.offset; }
      }
      if (!node || node.nodeType !== 3) return null;
    } catch (e) { return null; }
    const text = node.nodeValue;
    // 点落在词边界或标点处也能归到相邻单词
    if (!WORD_CH.test(text[offset] || '') && !WORD_CH.test(text[offset - 1] || '')) return null;
    let s = offset;
    while (s > 0 && WORD_CH.test(text[s - 1])) s--;
    let e = offset;
    while (e < text.length && WORD_CH.test(text[e])) e++;
    if (s === e) return null;
    const word = text.slice(s, e);
    const range = doc.createRange();
    range.setStart(node, s);
    range.setEnd(node, e);
    // 精确模式：点击点必须落在单词的实际包围盒内，否则视为空白
    if (precise && !pointInRange(x, y, range, tol || 3)) return null;
    return { word, node, offset: s, range, doc };
  }

  /* 兼容 PDF 文本层：优先用已包裹的整词（.w）；否则坐标命中（自然段落/整词）。
   * PDF 文本被拆成非整词片段，必须由 .w 提供完整单词，故 .w 优先。
   * precise=true 时要求点击落在单词盒子内，否则当作空白。 */
  function resolveHit(doc, x, y, target, precise, tol) {
    const span = target && target.closest ? target.closest('.w') : null;
    const t = tol || 3;
    if (span && span.firstChild && span.firstChild.nodeType === 3) {
      const sr = span.getBoundingClientRect();
      if (!precise || (x >= sr.left - t && x <= sr.right + t && y >= sr.top - t && y <= sr.bottom + t)) {
        const range = doc.createRange();
        range.selectNodeContents(span);
        return { word: span.textContent, node: span.firstChild, offset: 0, range, doc };
      }
      return null; // 命中 .w 区域外：不算取词
    }
    const hit = wordAtPoint(doc, x, y, precise, tol);
    if (hit && hit.word) return hit;
    return null;
  }

  function blockOf(node) {
    const el = node.parentElement;
    if (!el) return null;
    return el.closest('p,li,blockquote,h1,h2,h3,h4,h5,h6,td,dd,figcaption,div,section,article') || el;
  }

  /* 计算句子边界：给定整块文本与单词起始下标，返回 [句首, 句尾] 索引（忽略 F. / J. 等单字母缩写） */
  function sentenceBounds(text, start) {
    const re = /[.!?\u2026]["'\u201d\u2019)\]]*/g;
    const ends = [];
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 2), m.index);
      if (/[A-Z]\.$/.test(before)) continue; // 单字母缩写（F. J.），不当作句末
      ends.push(m.index + m[0].length);
    }
    let s = 0, e = text.length;
    for (const it of ends) {
      if (it <= start) s = it; else { e = it; break; }
    }
    return { s, e };
  }

  /* 计算单词所在整句，返回 {sentence, range}（range 覆盖整句，可直接用于选中高亮） */
  function computeSentence(node, wordOffset) {
    const doc = node.ownerDocument || document;
    const block = blockOf(node);
    if (!block) return null;
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    const nodes = []; let text = '', wordPos = -1, n;
    while ((n = walker.nextNode())) {
      nodes.push(n);
      if (n === node) wordPos = text.length + wordOffset;
      text += n.nodeValue;
    }
    if (wordPos < 0) return null;
    const b = sentenceBounds(text, wordPos);
    let acc = 0, sNode = null, sOff = 0, eNode = null, eOff = 0;
    for (const nn of nodes) {
      const L = nn.nodeValue.length;
      if (sNode === null && b.s <= acc + L) { sNode = nn; sOff = b.s - acc; }
      if (b.e <= acc + L) { eNode = nn; eOff = b.e - acc; break; }
      acc += L;
    }
    if (!sNode || !eNode) return null;
    const range = doc.createRange();
    range.setStart(sNode, Math.max(0, sOff));
    range.setEnd(eNode, Math.min(eNode.nodeValue.length, eOff));
    const sentence = text.slice(b.s, b.e).replace(/\s+/g, ' ').trim();
    return { sentence, range };
  }

  function sentenceOf(node, offset) {
    const c = computeSentence(node, offset);
    return c ? c.sentence : (node.nodeValue || '').slice(offset).match(WORD_RE)?.[0] || '';
  }

  function selectSentence(node, offset) {
    const c = computeSentence(node, offset);
    if (!c || !c.range) return;
    try {
      const sel = (c.range.startContainer.ownerDocument.defaultView || window).getSelection();
      sel.removeAllRanges();
      sel.addRange(c.range);
    } catch (e) {}
  }

  function clearSel(d) {
    try { const s = (d.defaultView || window).getSelection(); if (s) s.removeAllRanges(); } catch (e) {}
  }

  function getSentenceRect(doc) {
    try {
      const sel = (doc.defaultView || window).getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r && (r.width || r.height)) return r;
      }
    } catch (e) {}
    try { return null; } catch (e) { return null; }
  }

  /* 点击单词的瞬时高亮：只临时包住这【一个】词，650ms 后还原。
   * 取代原先给每个词都加常驻 span 的方案——常驻节点才是卡顿根源。 */
  function flashWord(range, doc) {
    if (!range || !range.startContainer || range.startContainer.nodeType !== 3) return;
    const span = doc.createElement('span');
    span.className = 'w-active';
    try {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
      setTimeout(() => {
        try {
          const parent = span.parentNode;
          if (parent) {
            parent.replaceChild(doc.createTextNode(span.textContent), span);
            if (parent.normalize) parent.normalize();
          }
        } catch (e) {}
      }, 650);
    } catch (e) {}
  }

  /*
   * 绑定交互事件（支持主文档和 EPUB iframe 文档）
   * offsetFn: 返回该文档相对主视口的偏移 {x, y}
   * handlers: { onWord(word, x, y, info), onWordStart(word, x, y, info), onSentence(sentence, word, info, sentRect), onBlank(fx, target) }
   *   info = { word, node, offset, range, doc, x, y }  —— x,y 为相对主视口的全局坐标（用于弹层定位）
   */
  /* UI 元素（按钮/输入框/弹层/工具栏）内的点击不做取词，交还给控件自身的监听器。
   * 否则搜索结果、书名等含英文的控件会被 capture 阶段的 stopPropagation 吞掉点击。 */
  const CHROME_SEL = 'button,input,textarea,select,a,label,.reader-top,.reader-bottom,.settings-panel,.search-panel,.dict-popup,.sent-popup,.toc-drawer,.diag-panel,.proxy-help-panel,.shelf-header,.sub-header,.book-card,.vocab-item';
  function inChrome(target) {
    return !!(target && target.closest && target.closest(CHROME_SEL));
  }

  /* 空白区域判定：点击段落间隙、页边距、列间等容器本身时，caretRangeFromPoint
   * 常会落到相邻文本节点造成误翻译。若 target 是阅读容器（div/section/body/html），
   * 直接视为空白，走 onBlank（翻页/呼出工具栏）。 */
  const BLANK_HOSTS = '.reader-container,.txt-viewport,.txt-content,.epub-holder,.pdf-stage';
  const BLANK_TAGS = new Set(['div', 'section', 'article', 'aside', 'main', 'body', 'html']);
  function isBlankArea(target) {
    if (!target || !target.closest) return false;
    const tag = (target.tagName || '').toLowerCase();
    if (!BLANK_TAGS.has(tag)) return false;
    return !!target.closest(BLANK_HOSTS);
  }

  function attach(doc, offsetFn, handlers) {
    const off0 = () => offsetFn ? offsetFn() : { x: 0, y: 0 };
    let clickTimer = null;
    let lastTap = null;          // 移动端双击检测：上一次 tap 的视口坐标与时间
    let touchStart = null;       // 移动端 touchstart 记录
    let touchSuppressUntil = 0;  // 触摸处理后抑制合成的 click，避免重复触发

    /* 从一次命中得到句子信息（文本 + 选中范围 + 弹层避让矩形） */
    function sentenceHit(hit, off) {
      const c = computeSentence(hit.node, hit.offset);
      const sent = c ? c.sentence : hit.word;
      selectSentence(hit.node, hit.offset);
      const sRect = getSentenceRect(doc);
      const sentRect = sRect
        ? { top: sRect.top + off.y, bottom: sRect.bottom + off.y, left: sRect.left + off.x, right: sRect.right + off.x }
        : null;
      return { sent, sentRect };
    }

    doc.addEventListener('click', (e) => {
      if (handlers.enabled && !handlers.enabled()) return; // 非阅读视图不拦截（否则书架点书名会被吞掉）
      if (inChrome(e.target)) return;               // UI 控件内不取词
      if (Date.now() < touchSuppressUntil) return; // 触摸已处理，跳过合成的 click
      const off = off0();
      const vx = e.clientX + off.x;
      const vy = e.clientY + off.y;
      /* 先尝试取词（caretRangeFromPoint），再判断是否空白。iOS Safari 上
       * elementFromPoint 可能返回容器而非段落，导致 isBlankArea 假阳性。 */
      const hit = resolveHit(doc, e.clientX, e.clientY, e.target, true);

      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        clearSel(doc); // 单击单词时清掉上一次的整句高亮
        handlers.onWordStart && handlers.onWordStart(hit.word, vx, vy, hit); // 立即关闭上一句句子弹层等
        /* 取消上一次未触发的单击，避免误触 */
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        clickTimer = setTimeout(() => {
          clickTimer = null;
          handlers.onWord && handlers.onWord(hit.word, vx, vy, hit);
        }, 260);
        return;
      }

      /* 无单词命中 → 空白区域（翻页/呼出工具栏）。
       * 不判断 isBlankArea：iOS 上 caretRangeFromPoint 不可靠，命中失败便作空白处理，
       * 避免 tap 被静默丢弃。 */
      clearSel(doc);
      const fx = vx / window.innerWidth;
      handlers.onBlank && handlers.onBlank(fx, e.target);
    }, true);

    /* 双击单词：自动选中包含该词的整句并翻译（用原生 dblclick，稳定可靠） */
    doc.addEventListener('dblclick', (e) => {
      if (handlers.enabled && !handlers.enabled()) return;
      if (inChrome(e.target)) return;
      const off = off0();
      const vx = e.clientX + off.x;
      const vy = e.clientY + off.y;
      const hit = resolveHit(doc, e.clientX, e.clientY, e.target, false);
      if (!hit) return;
      e.preventDefault();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      const { sent, sentRect } = sentenceHit(hit, off);
      handlers.onSentence && handlers.onSentence(sent, hit.word, hit, sentRect);
    }, true);

    /* ===== 触摸支持：移动端单击单词翻译、双击整句翻译 ===== */
    doc.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length !== 1) { touchStart = null; return; }
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY, t: Date.now() };
    }, { passive: true });

    doc.addEventListener('touchend', (e) => {
      if (handlers.enabled && !handlers.enabled()) return;
      if (!touchStart) return;
      const ct = e.changedTouches && e.changedTouches[0];
      if (!ct) { touchStart = null; return; }
      const sx = touchStart.x, sy = touchStart.y, st = touchStart.t;
      const dx = Math.abs(ct.clientX - sx);
      const dy = Math.abs(ct.clientY - sy);
      const dt = Date.now() - st;
      touchStart = null;
      /* 横向滑动翻页：移动端主翻页手势（左滑=下一页，右滑=上一页）。
         必须早于「滚动/点击」判定，否则滑动被当成滚动而翻不了页。 */
      if (dx > 40 && dx > dy * 1.4 && dt < 800) {
        const el0 = doc.elementFromPoint(ct.clientX, ct.clientY);
        if (el0 && !inChrome(el0)) {
          e.preventDefault();           // 阻止原生选区与合成的 click
          touchSuppressUntil = Date.now() + 1200;
          clearSel(doc);
          handlers.onSwipe && handlers.onSwipe(ct.clientX - sx < 0 ? 'left' : 'right');
          return;
        }
      }
      if (dx > 10 || dy > 10 || dt > 600) return; // 移动过大视为滚动，不处理

      const off = off0();
      const vx = ct.clientX + off.x;
      const vy = ct.clientY + off.y;
      const el = doc.elementFromPoint(ct.clientX, ct.clientY);
      if (inChrome(el)) return; // UI 控件内不取词，交还控件自身

      /* 先尝试取词（caretRangeFromPoint），再判断是否空白。
       * iOS Safari 上 elementFromPoint 可能返回容器而非段落，导致 isBlankArea 假阳性。 */
      const hit = resolveHit(doc, ct.clientX, ct.clientY, el, true, 10);

      if (hit) {
        e.preventDefault();           // 阻止原生选区与合成的 click
        touchSuppressUntil = Date.now() + 1200;
        clearSel(doc);
        handlers.onWordStart && handlers.onWordStart(hit.word, vx, vy, hit);
        // 双击检测：与上一次 tap 间隔 < 320ms 且位置接近 → 翻译整句
        if (lastTap && (Date.now() - lastTap.t) < 320 &&
            Math.abs(vx - lastTap.x) < 30 && Math.abs(vy - lastTap.y) < 30) {
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
          lastTap = null;
          // 双击：宽松取词，确保第二次点略偏也能命中整句
          const dblHit = resolveHit(doc, ct.clientX, ct.clientY, el, false) || hit;
          const { sent, sentRect } = sentenceHit(dblHit, off);
          handlers.onSentence && handlers.onSentence(sent, dblHit.word, dblHit, sentRect);
        } else {
          lastTap = { x: vx, y: vy, t: Date.now() };
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
          clickTimer = setTimeout(() => {
            clickTimer = null;
            handlers.onWord && handlers.onWord(hit.word, vx, vy, hit);
          }, 260);
        }
        return;
      }

      /* 无单词命中 → 空白区域（翻页/呼出工具栏）。
       * 不判断 isBlankArea：iOS 上 caretRangeFromPoint 不可靠，命中失败便作空白处理。 */
      e.preventDefault();
      touchSuppressUntil = Date.now() + 1200;
      clearSel(doc);
      const fx = vx / window.innerWidth;
      handlers.onBlank && handlers.onBlank(fx, el);
    }, { passive: false });
  }

  /* 清除主文档与 EPUB iframe 中的文本选择（弹层关闭时调用） */
  function clearSelection() {
    try { window.getSelection && window.getSelection().removeAllRanges(); } catch (e) {}
    try {
      const f = document.querySelector('.epub-holder iframe');
      if (f && f.contentDocument) f.contentDocument.defaultView.getSelection().removeAllRanges();
    } catch (e) {}
  }

  return { wrapWords, wordAtPoint, resolveHit, sentenceOf, selectSentence, flashWord, clearSelection, attach };
})();
