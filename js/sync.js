/* 跨设备同步：书架元数据 + 生词本 (KV) + 书文件 (R2)
 * 依赖 Cloudflare Pages Function: /api/sync
 * 本地开发（无此端点）��静默跳过，不影响本地使用。
 */

const SyncService = (() => {
  let syncToken = null;
  let lastSyncTs = 0;
  let pushTimer = null;
  const PUSH_DELAY = 2000;

  /* 初始化 */
  function init() {
    syncToken = (Settings.get().syncToken || '').trim();
    lastSyncTs = Settings.get()._syncTs || 0;
    return !!syncToken;
  }

  function setToken(t) {
    syncToken = (t || '').trim().slice(0, 64);
    Settings.set({ syncToken });
    lastSyncTs = 0;
    Settings.set({ _syncTs: 0 });
    return !!syncToken;
  }

  function getToken() { return syncToken; }
  function available() { return !!(syncToken && navigator.onLine !== false); }

  /* ───── 元数据导出/导入 ───── */

  async function exportData() {
    const books = await DB.getAll('books');
    const vocab = await DB.getAll('vocab');
    return {
      books: books.map(b => ({
        id: b.id, title: b.title, author: b.author || '', type: b.type,
        addedAt: b.addedAt || 0, updatedAt: b.updatedAt || b.addedAt || 0,
        progress: b.progress || 0, location: b.location || null,
        coverColor: b.coverColor || '', coverText: b.coverText || ''
      })),
      vocab: vocab.map(v => ({
        word: v.word, phonetic: v.phonetic || '', zh: v.zh || '',
        en: v.en || '', book: v.book || '', addedAt: v.addedAt || 0,
        updatedAt: v.updatedAt || v.addedAt || 0
      }))
    };
  }

  async function importData(remote) {
    if (!remote || !remote.books || !remote.vocab) return 0;
    const localBooks = await DB.getAll('books');
    const localVocab = await DB.getAll('vocab');

    const bookMap = {}; for (const b of localBooks) bookMap[b.id] = b;
    const vocabMap = {}; for (const v of localVocab) vocabMap[v.word] = v;

    let merged = 0;
    for (const rb of remote.books) {
      const lb = bookMap[rb.id];
      if (lb) {
        if (rb.updatedAt > (lb.updatedAt || lb.addedAt || 0)) {
          lb.progress = rb.progress; lb.location = rb.location;
          lb.updatedAt = rb.updatedAt;
          await DB.put('books', lb); merged++;
        }
      } else {
        await DB.put('books', {
          id: rb.id, title: rb.title, author: rb.author, type: rb.type,
          addedAt: rb.addedAt, updatedAt: rb.updatedAt,
          progress: rb.progress, location: rb.location,
          coverColor: rb.coverColor || '', coverText: rb.coverText || '',
          _remoteOnly: true
        });
        merged++;
      }
    }

    for (const rv of remote.vocab) {
      const lv = vocabMap[rv.word];
      if (lv) {
        if (rv.updatedAt > (lv.updatedAt || lv.addedAt || 0)) {
          await DB.put('vocab', Object.assign({}, lv, {
            phonetic: rv.phonetic, zh: rv.zh, en: rv.en,
            book: rv.book, updatedAt: rv.updatedAt, addedAt: rv.addedAt
          })); merged++;
        }
      } else {
        await DB.put('vocab', {
          word: rv.word, phonetic: rv.phonetic, zh: rv.zh, en: rv.en,
          book: rv.book, addedAt: rv.addedAt, updatedAt: rv.updatedAt
        });
        merged++;
      }
    }
    return merged;
  }

  /* ───── 网络请求 ───── */

  async function pull() {
    if (!available()) return null;
    try {
      const resp = await fetch('/api/sync?token=' + encodeURIComponent(syncToken));
      if (!resp.ok) return null;
      const json = await resp.json();
      lastSyncTs = json.ts || Date.now();
      Settings.set({ _syncTs: lastSyncTs });
      return json.data;
    } catch (e) { return null; }
  }

  async function push() {
    if (!available()) return;
    try {
      const data = await exportData();
      const resp = await fetch('/api/sync', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: syncToken, data })
      });
      if (resp.ok) { lastSyncTs = Date.now(); Settings.set({ _syncTs: lastSyncTs }); }
    } catch (e) {}
  }

  function schedulePush() {
    if (!available()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, PUSH_DELAY);
  }

  /* ───── 书文件同步 (R2) ───── */

  /* 上传一本书到云端 */
  async function uploadBook(bookId) {
    if (!available()) return false;
    try {
      const file = await DB.get('files', bookId);
      if (!file || !file.data) return false;
      const bytes = file.data instanceof ArrayBuffer ? new Uint8Array(file.data) : file.data;
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const resp = await fetch('/api/sync/book/' + encodeURIComponent(bookId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: syncToken, data: btoa(binary) })
      });
      return resp.ok;
    } catch (e) { return false; }
  }

  /* 从云端下载一本书 */
  async function downloadBook(bookId) {
    if (!available()) return null;
    try {
      const resp = await fetch('/api/sync/book/' + encodeURIComponent(bookId) + '?token=' + encodeURIComponent(syncToken));
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      return buf;
    } catch (e) { return null; }
  }

  /* 从云端删除一本书 */
  async function deleteBookFile(bookId) {
    if (!available()) return false;
    try {
      const resp = await fetch('/api/sync/book/' + encodeURIComponent(bookId) + '?token=' + encodeURIComponent(syncToken), { method: 'DELETE' });
      return resp.ok;
    } catch (e) { return false; }
  }

  /* 下载所有远端仅有元数据的书（书架同步后自动调用） */
  async function downloadMissingBooks(onProgress) {
    if (!available()) return 0;
    const books = (await DB.getAll('books')).filter(b => b._remoteOnly);
    if (!books.length) return 0;
    let count = 0;
    for (const b of books) {
      try {
        const buf = await downloadBook(b.id);
        if (!buf) continue;
        await DB.put('files', { id: b.id, data: buf });
        b._remoteOnly = false;
        b.addedAt = b.addedAt || Date.now();
        await DB.put('books', b);
        count++;
        if (onProgress) onProgress(count, books.length);
      } catch (e) {}
    }
    return count;
  }

  /* 初始化同步：拉取元数据 → 合并 → 下载缺失的书 → 推送 */
  async function syncOnce() {
    if (!available()) return 0;
    try {
      const remote = await pull();
      if (!remote) return 0;
      const merged = await importData(remote);
      await push();
      // 自动下载远端只有元数据的书
      const downloaded = await downloadMissingBooks();
      return merged + downloaded;
    } catch (e) { return 0; }
  }

  return {
    init, setToken, getToken, available, syncOnce, schedulePush,
    uploadBook, downloadBook, deleteBookFile, downloadMissingBooks,
    exportData, pull, push
  };
})();
