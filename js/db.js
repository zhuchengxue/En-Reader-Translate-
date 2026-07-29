/* IndexedDB 封装：books(元数据) / files(文件二进制) / vocab(生词) */
const DB = (() => {
  let db = null;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('en-reader', 2);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('books')) {
          const s = d.createObjectStore('books', { keyPath: 'id' });
          s.createIndex('addedAt', 'addedAt');
        }
        if (!d.objectStoreNames.contains('files')) {
          d.createObjectStore('files', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('vocab')) {
          const s = d.createObjectStore('vocab', { keyPath: 'word' });
          s.createIndex('addedAt', 'addedAt');
        }
        if (!d.objectStoreNames.contains('bookmarks')) {
          d.createObjectStore('bookmarks', { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      t.oncomplete = () => resolve(r && r.result !== undefined ? r.result : undefined);
      t.onerror = (e) => reject(e.target.error);
    });
  }

  return {
    open,
    put: (store, val) => tx(store, 'readwrite', s => s.put(val)),
    del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
    get: (store, key) => new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = (e) => reject(e.target.error);
    }),
    getAll: (store) => new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = (e) => reject(e.target.error);
    }),
    /* 书签：按书聚合（store 仅 bookmarks，按 bookId 在 JS 端过滤并排序） */
    addBookmark: (bm) => tx('bookmarks', 'readwrite', s => s.put(bm)),
    delBookmark: (id) => tx('bookmarks', 'readwrite', s => s.delete(id)),
    getBookmarks: (bookId) => new Promise((resolve, reject) => {
      const r = db.transaction('bookmarks').objectStore('bookmarks').getAll();
      r.onsuccess = () => {
        const list = (r.result || []).filter(b => b.bookId === bookId).sort((a, b) => a.addedAt - b.addedAt);
        resolve(list);
      };
      r.onerror = (e) => reject(e.target.error);
    })
  };
})();

/* localStorage 设置 */
const Settings = (() => {
  const KEY = 'en-reader-settings';
  const defaults = { theme: 'light', fontSize: 18, lineHeight: 1.9, marginSize: 'medium', clickMode: 'both', pageMode: 'single', pageAnim: 'slide', translateProxy: '', lastBookId: '', syncToken: '', dictLang: 'both', persistLookup: false, autoResumeBook: false };
  let cache = null;
  return {
    get() {
      if (!cache) {
        try { cache = Object.assign({}, defaults, JSON.parse(localStorage.getItem(KEY) || '{}')); }
        catch (e) { cache = Object.assign({}, defaults); }
      }
      return cache;
    },
    set(patch) {
      cache = Object.assign(this.get(), patch);
      localStorage.setItem(KEY, JSON.stringify(cache));
      return cache;
    }
  };
})();

/* 阅读统计（按天累计秒数） */
const Stats = (() => {
  const KEY = 'en-reader-stats';
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  return {
    addSeconds(sec) {
      const s = load(); const t = today();
      s[t] = (s[t] || 0) + sec;
      localStorage.setItem(KEY, JSON.stringify(s));
    },
    todayMinutes() { return Math.floor((load()[today()] || 0) / 60); },
    totalMinutes() {
      const s = load();
      let sec = 0;
      for (const k in s) sec += s[k] || 0;
      return Math.floor(sec / 60);
    },
    activeDays() { const s = load(); let n = 0; for (const k in s) if (s[k] > 0) n++; return n; },
    streakDays() {
      const s = load(); let n = 0; const d = new Date();
      for (;;) {
        const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        if (s[k] > 0) { n++; d.setDate(d.getDate() - 1); } else break;
      }
      return n;
    }
  };
})();
