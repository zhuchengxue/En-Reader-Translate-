/* 古腾堡书城：通过同源代理(/api/gutenberg)搜索与下载公版英文书，规避浏览器跨域限制。
 * 代理由 tools/serve.js(本地) 或 functions/api/gutenberg.js(生产 Cloudflare Pages) 提供。
 * 数据来自 Gutendex（Project Gutenberg 的开放目录 API）。 */
const Gutenberg = (() => {
  /* 仅允许这些受信任的公版书主机，避免代理被滥用来抓取任意外站 */
  const ALLOW = ['gutendex.com', 'www.gutenberg.org', 'gutenberg.org', 'aleph.pglaf.org', 'gutenberg.reader.bible'];

  function proxy(target) {
    return location.origin + '/api/gutenberg?url=' + encodeURIComponent(target);
  }
  function okHost(u) {
    try { return ALLOW.includes(new URL(u).hostname); } catch (e) { return false; }
  }

  /* 搜索：term 为空时按下载量返回热门公版书 */
  async function search(term, page) {
    page = page || 1;
    const q = (term && term.trim())
      ? '?search=' + encodeURIComponent(term.trim())
      : '?sort=download_count';
    const url = 'https://gutendex.com/books/' + q + '&page=' + page;
    const res = await fetch(proxy(url), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('搜索失败(' + res.status + ')');
    const data = await res.json();
    const results = (data.results || []).map(norm);
    return { results, next: !!data.next, count: data.count || 0 };
  }

  /* 把 Gutendex 原始条目规整成统一结构 */
  function norm(b) {
    const authors = (b.authors || []).map(a => fmtAuthor(a.name)).filter(Boolean);
    return {
      gid: b.id,
      title: Array.isArray(b.title) ? b.title.join(' / ') : (b.title || '未知书名'),
      authors,
      downloads: b.download_count || 0,
      cover: b.cover || (b.formats && b.formats['image/jpeg']) || '',
      formats: b.formats || {}
    };
  }

  /* “姓, 名” → “名 姓”，更顺眼 */
  function fmtAuthor(name) {
    if (!name) return '';
    const parts = String(name).split(',').map(s => s.trim());
    if (parts.length === 2) return parts[1] + ' ' + parts[0];
    return name;
  }

  /* 优先 EPUB，其次纯文本；读者只支持这两种格式 */
  function bestFormat(formats) {
    const order = ['application/epub+zip', 'text/plain; charset=utf-8', 'text/plain; charset=us-ascii', 'text/plain'];
    for (const k of order) {
      if (formats[k]) return { url: formats[k], ext: k.indexOf('epub') >= 0 ? 'epub' : 'txt' };
    }
    return null;
  }

  /* 经由同源代理下载文件字节（gutenberg.org 不发 CORS 头，浏览器直连会被拦） */
  async function download(url) {
    if (!okHost(url)) throw new Error('不支持的来源');
    const res = await fetch(proxy(url), { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error('下载失败(' + res.status + ')');
    return await res.arrayBuffer();
  }

  return { search, bestFormat, download, okHost };
})();
