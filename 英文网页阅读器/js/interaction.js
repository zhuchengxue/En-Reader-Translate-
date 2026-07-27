/* 单词交互：包裹单词 span、单击/双击区分、句子边界检测 */
const Interaction = (() => {
  const WORD_RE = /[A-Za-z]+(?:['\u2019-][A-Za-z]+)*/g;

  /* 将容器内所有英文单词包裹为 <span class="w"> */
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

  function blockOf(span) {
    return span.closest('p,li,blockquote,h1,h2,h3,h4,h5,h6,td,dd,figcaption,div,section,article') || span.parentElement;
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

  /* 提取单词所在的完整句子文本 */
  function sentenceOf(span) {
    const doc = span.ownerDocument;
    const block = blockOf(span);
    if (!block) return span.textContent;
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    let text = '', start = -1, node;
    while ((node = walker.nextNode())) {
      if (start < 0 && node.parentElement === span) start = text.length;
      text += node.nodeValue;
    }
    if (start < 0) return span.textContent;
    const b = sentenceBounds(text, start);
    return text.slice(b.s, b.e).replace(/\s+/g, ' ').trim();
  }

  /* 视觉选中包含该词的整句：双击时高亮，便于确认翻译的是哪一句 */
  function selectSentence(span) {
    try {
      const doc = span.ownerDocument;
      const block = blockOf(span);
      if (!block) return;
      const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
      const nodes = []; let node, text = '', start = -1;
      while ((node = walker.nextNode())) {
        nodes.push(node);
        if (start < 0 && node.parentElement === span) start = text.length;
        text += node.nodeValue;
      }
      if (start < 0) return;
      const b = sentenceBounds(text, start);
      let acc = 0, sNode = null, sOff = 0, eNode = null, eOff = 0;
      for (const n of nodes) {
        const L = n.nodeValue.length;
        if (sNode === null && b.s <= acc + L) { sNode = n; sOff = b.s - acc; }
        if (b.e <= acc + L) { eNode = n; eOff = b.e - acc; break; }
        acc += L;
      }
      if (!sNode || !eNode) return;
      const range = doc.createRange();
      range.setStart(sNode, Math.max(0, sOff));
      range.setEnd(eNode, Math.min(eNode.nodeValue.length, eOff));
      const sel = (doc.defaultView || window).getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }

  function clearSel(d) {
    try { const s = (d.defaultView || window).getSelection(); if (s) s.removeAllRanges(); } catch (e) {}
  }

  /* 取当前已选中整句的视口矩形（用于把翻译弹层放到句子之外，不遮挡高亮） */
  function getSentenceRect(span) {
    try {
      const doc = span.ownerDocument;
      const sel = (doc.defaultView || window).getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r && (r.width || r.height)) return r;
      }
    } catch (e) {}
    try { return span.getBoundingClientRect(); } catch (e) { return null; }
  }

  /*
   * 绑定交互事件（支持主文档和 EPUB iframe 文档）
   * offsetFn: 返回该文档相对主视口的偏移 {x, y}
   * handlers: { onWord(word, x, y, span), onWordStart(word, x, y, span), onSentence(sentence, x, y, sentRect), onBlank(fx) }
   */
  function attach(doc, offsetFn, handlers) {
    let clickTimer = null;

    doc.addEventListener('click', (e) => {
      const off = offsetFn ? offsetFn() : { x: 0, y: 0 };
      const vx = e.clientX + off.x;
      const vy = e.clientY + off.y;
      const span = e.target && e.target.closest ? e.target.closest('.w') : null;

      if (span) {
        e.preventDefault();
        e.stopPropagation();
        clearSel(doc); // 单击单词时清掉上一次的整句高亮
        handlers.onWordStart && handlers.onWordStart(span.textContent, vx, vy, span); // 立即关闭上一句句子弹层等
        /* 取消上一次未触发的单击，避免误触 */
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        clickTimer = setTimeout(() => {
          clickTimer = null;
          handlers.onWord && handlers.onWord(span.textContent, vx, vy, span);
        }, 260);
        return;
      }

      /* 空白区域：按横向位置分区（翻页/呼出工具栏） */
      clearSel(doc);
      const fx = vx / window.innerWidth;
      handlers.onBlank && handlers.onBlank(fx, e.target);
    }, true);

    /* 双击单词：自动选中包含该词的整句并翻译（用原生 dblclick，稳定可靠） */
    doc.addEventListener('dblclick', (e) => {
      const off = offsetFn ? offsetFn() : { x: 0, y: 0 };
      const vx = e.clientX + off.x;
      const vy = e.clientY + off.y;
      const span = e.target && e.target.closest ? e.target.closest('.w') : null;
      if (!span) return;
      e.preventDefault();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      const sent = sentenceOf(span);
      const word = span.textContent;
      selectSentence(span); // 视觉高亮整句，确认翻译对象
      const sRect = getSentenceRect(span);
      const sentRect = sRect
        ? { top: sRect.top + off.y, bottom: sRect.bottom + off.y, left: sRect.left + off.x, right: sRect.right + off.x }
        : null;
      handlers.onSentence && handlers.onSentence(sent, word, vx, vy, sentRect);
    }, true);
  }

  /* 清除主文档与 EPUB iframe 中的文本选择（弹层关闭时调用） */
  function clearSelection() {
    try { window.getSelection && window.getSelection().removeAllRanges(); } catch (e) {}
    try {
      const f = document.querySelector('.epub-holder iframe');
      if (f && f.contentDocument) f.contentDocument.defaultView.getSelection().removeAllRanges();
    } catch (e) {}
  }

  return { wrapWords, sentenceOf, selectSentence, clearSelection, attach };
})();
