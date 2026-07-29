/* 跨设备同步：读取/更新云端的书架元数据 + 生词本
 * 依赖 Cloudflare Pages Function: /api/sync
 * 本地开发（无此端点）时静默跳过，不影响本地使用。
 */

const SyncService = (() => {
  let syncToken = null;
  let lastSyncTs = 0;
  let pushTimer = null;
  const PUSH_DELAY = 2000; // 改动后延迟 2 秒推送（去抖）

  /* 初始化：从 settings 读取 token，返回是否已配置同步 */
  function init() {
    syncToken = (Settings.get().syncToken || '').trim();
    lastSyncTs = Settings.get()._syncTs || 0;
    return !!syncToken;
  }

  function setToken(t) {
    syncToken = (t || '').trim().slice(0, 64);
    Settings.set({ syncToken });
    lastSyncTs = 0; // 更换 token 后下次拉取全量
    Settings.set({ _syncTs: 0 });
    return !!syncToken;
  }

  function getToken() { return syncToken; }

  /* 判断是否支持同步（网络 + token 都存在） */
  function available() {
    return !!(syncToken && navigator.onLine !== false);
  }

  /* 从 IndexedDB 导出可同步的数据（不含文件二进制） */
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

  /* 把同步数据写入 IndexedDB（合并：按 id/word 保留 updatedAt 较新的） */
  async function importData(remote) {
    if (!remote || !remote.books || !remote.vocab) return;
    const localBooks = await DB.getAll('books');
    const localVocab = await DB.getAll('vocab');

    const bookMap = {};
    for (const b of localBooks) bookMap[b.id] = b;
    const vocabMap = {};
    for (const v of localVocab) vocabMap[v.word] = v;

    let merged = 0;

    // 合并书架：本地已有 → 仅更新 progress/location（保留本地文件）；本地没有 → 仅记元数据
    for (const rb of remote.books) {
      const lb = bookMap[rb.id];
      if (lb) {
        // 两边都有：保留 updatedAt 更新的 progress/location
        if (rb.updatedAt > (lb.updatedAt || lb.addedAt || 0)) {
          lb.progress = rb.progress;
          lb.location = rb.location;
          lb.updatedAt = rb.updatedAt;
          await DB.put('books', lb);
          merged++;
        }
      } else {
        // 本地没有：仅存元数据（文件需用户手动导入）
        await DB.put('books', {
          id: rb.id, title: rb.title, author: rb.author, type: rb.type,
          addedAt: rb.addedAt, updatedAt: rb.updatedAt,
          progress: rb.progress, location: rb.location,
          coverColor: rb.coverColor || '', coverText: rb.coverText || '',
          _remoteOnly: true // 标记为「仅有元数据，无文件」，UI 显示「下载」
        });
        merged++;
      }
    }

    // 合并生词本
    for (const rv of remote.vocab) {
      const lv = vocabMap[rv.word];
      if (lv) {
        if (rv.updatedAt > (lv.updatedAt || lv.addedAt || 0)) {
          await DB.put('vocab', Object.assign({}, lv, {
            phonetic: rv.phonetic, zh: rv.zh, en: rv.en,
            book: rv.book, updatedAt: rv.updatedAt, addedAt: rv.addedAt
          }));
          merged++;
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

  /* 全量拉取：GET /api/sync?token=xxx */
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

  /* 全量推送：PUT /api/sync */
  async function push() {
    if (!available()) return;
    try {
      const data = await exportData();
      const resp = await fetch('/api/sync', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: syncToken, data })
      });
      if (resp.ok) {
        lastSyncTs = Date.now();
        Settings.set({ _syncTs: lastSyncTs });
      }
    } catch (e) { /* 推送失败静默，下次自动重试 */ }
  }

  /* 去抖推送：书架/进度/生词变动后调用 */
  function schedulePush() {
    if (!available()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, PUSH_DELAY);
  }

  /* 初始化同步：拉取 → 合并 → 推送（合并后的全量写回云） */
  async function syncOnce() {
    if (!available()) return 0;
    try {
      const remote = await pull();
      if (!remote) return 0;
      const merged = await importData(remote);
      await push(); // 把合并后的本地数据推上去
      return merged;
    } catch (e) { return 0; }
  }

  return { init, setToken, getToken, available, syncOnce, schedulePush, exportData, pull, push };
})();
