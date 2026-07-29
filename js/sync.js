/* 跨设备同步：书架元数据 + 书文件 + 生词本（全部存 KV，不依赖 R2/付费）
 * 单 key 上限 25MB，足够存数十本普通 EPUB。
 * 依赖 Cloudflare Pages Function: /api/sync
 */

const SyncService = (() => {
  let syncToken = null;
  let lastSyncTs = 0;
  let pushTimer = null;
  const PUSH_DELAY = 2000;
  const MAX_PAYLOAD = 20 * 1024 * 1024; // 20MB 安全上限

  function init() {
    syncToken = (Settings.get().syncToken || '').trim();
    lastSyncTs = Settings.get()._syncTs || 0;
    return !!syncToken;
  }

  function setToken(t) {
    syncToken = (t || '').trim().slice(0, 64);
    Settings.set({ syncToken, _syncTs: 0 });
    lastSyncTs = 0;
    return !!syncToken;
  }

  function getToken() { return syncToken; }
  function available() { return !!(syncToken && navigator.onLine !== false); }

  /* ───── 元数据 + 书文件导出 ───── */

  function toBase64(buf) {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function fromBase64(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function exportData() {
    const books = await DB.getAll('books');
    const vocab = await DB.getAll('vocab');
    const result = {
      books: [],
      vocab: vocab.map(v => ({
        word: v.word, phonetic: v.phonetic || '', zh: v.zh || '',
        en: v.en || '', book: v.book || '', addedAt: v.addedAt || 0,
        updatedAt: v.updatedAt || v.addedAt || 0
      }))
    };

    for (const b of books) {
      const meta = {
        id: b.id, title: b.title, author: b.author || '', type: b.type,
        addedAt: b.addedAt || 0, updatedAt: b.updatedAt || b.addedAt || 0,
        progress: b.progress || 0, location: b.location || null,
        coverColor: b.coverColor || '', coverText: b.coverText || ''
      };

      // 只对有本地文件的书记入文件数据
      if (!b._remoteOnly) {
        try {
          const file = await DB.get('files', b.id);
          if (file && file.data) {
            meta._file = toBase64(file.data);
            meta._fileSize = file.data instanceof ArrayBuffer ? file.data.byteLength : file.data.length;
          }
        } catch (e) {}
      }

      result.books.push(meta);
    }

    return result;
  }

  /* ───── 数据导入 ───── */

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
        // 本地已有：只更新进度和位置
        if (rb.updatedAt > (lb.updatedAt || lb.addedAt || 0)) {
          lb.progress = rb.progress; lb.location = rb.location;
          lb.updatedAt = rb.updatedAt;
          await DB.put('books', lb); merged++;
        }
        // 如果本地缺文件但远端有，补下载
        if (lb._remoteOnly && rb._file) {
          await DB.put('files', { id: rb.id, data: fromBase64(rb._file) });
          lb._remoteOnly = false;
          await DB.put('books', lb); merged++;
        }
      } else {
        // 本地没有：存元数据，如果有文件体一并存入
        const entry = {
          id: rb.id, title: rb.title, author: rb.author, type: rb.type,
          addedAt: rb.addedAt, updatedAt: rb.updatedAt,
          progress: rb.progress, location: rb.location,
          coverColor: rb.coverColor || '', coverText: rb.coverText || '',
          _remoteOnly: !rb._file
        };
        await DB.put('books', entry);
        if (rb._file) {
          await DB.put('files', { id: rb.id, data: fromBase64(rb._file) });
        }
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
      const payload = JSON.stringify({ token: syncToken, data });
      if (payload.length > MAX_PAYLOAD) {
        console.warn('[sync] 数据量 ' + (payload.length / 1048576).toFixed(1) + 'MB 超限，跳过推送');
        return;
      }
      const resp = await fetch('/api/sync', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (resp.ok) { lastSyncTs = Date.now(); Settings.set({ _syncTs: lastSyncTs }); }
    } catch (e) {}
  }

  function schedulePush() {
    if (!available()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, PUSH_DELAY);
  }

  /* ───── 初始化同步 ───── */

  async function syncOnce() {
    if (!available()) return 0;
    try {
      const remote = await pull();
      if (!remote) return 0;
      const merged = await importData(remote);
      await push();
      return merged;
    } catch (e) { return 0; }
  }

  return { init, setToken, getToken, available, syncOnce, schedulePush, exportData, pull, push };
})();
