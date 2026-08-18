/* Thin promise wrapper over IndexedDB. No dependency, no schema migrations
 * beyond a version bump, because everything here is derived data we can
 * rebuild from the original file we keep in `files`. */

const NAME = 'mobile-reader';
const VERSION = 1;

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Library rows. Small — safe to read all of them to render the list.
      if (!db.objectStoreNames.contains('docs')) {
        const s = db.createObjectStore('docs', { keyPath: 'id' });
        s.createIndex('addedAt', 'addedAt');
      }
      // Extracted block arrays, one row per document. Can be large.
      if (!db.objectStoreNames.contains('content')) {
        db.createObjectStore('content', { keyPath: 'id' });
      }
      // Original bytes, so OCR re-extraction never needs the file again.
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'id' });
      }
      // Playback position.
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'id' });
      }
      // Rendered neural-TTS audio, keyed docId:sentenceHash:voice.
      if (!db.objectStoreNames.contains('audio')) {
        const s = db.createObjectStore('audio', { keyPath: 'key' });
        s.createIndex('docId', 'docId');
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onversionchange = () => { _db.close(); _db = null; };
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s, t); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const asPromise = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

/* ────────────────────────────────────────────────────────── documents ── */

export const docs = {
  async all() {
    const rows = await tx('docs', 'readonly', s => asPromise(s.getAll()));
    return (await rows).sort((a, b) => b.addedAt - a.addedAt);
  },
  async get(id) { return tx('docs', 'readonly', s => asPromise(s.get(id))); },
  async put(doc) { await tx('docs', 'readwrite', s => s.put(doc)); return doc; },
  async remove(id) {
    await tx('docs', 'readwrite', s => s.delete(id));
    await tx('content', 'readwrite', s => s.delete(id));
    await tx('files', 'readwrite', s => s.delete(id));
    await tx('progress', 'readwrite', s => s.delete(id));
    await audio.clearDoc(id);
  },
  async count() { return tx('docs', 'readonly', s => asPromise(s.count())); },
};

/* ─────────────────────────────────────────────────────────── content ─── */

export const content = {
  async get(id) {
    const row = await tx('content', 'readonly', s => asPromise(s.get(id)));
    return row ? row.blocks : null;
  },
  async put(id, blocks) { await tx('content', 'readwrite', s => s.put({ id, blocks })); },
};

/* ───────────────────────────────────────────────────────────── files ─── */

export const files = {
  async get(id) {
    const row = await tx('files', 'readonly', s => asPromise(s.get(id)));
    return row ? row.blob : null;
  },
  async put(id, blob, name, mime) {
    await tx('files', 'readwrite', s => s.put({ id, blob, name, mime }));
  },
};

/* ──────────────────────────────────────────────────────────── progress ─ */

export const progress = {
  async get(id) { return tx('progress', 'readonly', s => asPromise(s.get(id))); },
  async put(id, index, total) {
    await tx('progress', 'readwrite', s => s.put({ id, index, total, at: Date.now() }));
  },
};

/* ─────────────────────────────────────────────────────────────── audio ─ */

export const audio = {
  async get(key) {
    const row = await tx('audio', 'readonly', s => asPromise(s.get(key)));
    return row ? row.blob : null;
  },
  async put(key, docId, blob) {
    await tx('audio', 'readwrite', s => s.put({ key, docId, blob, at: Date.now() }));
  },
  async has(key) {
    const row = await tx('audio', 'readonly', s => asPromise(s.getKey(key)));
    return row !== undefined;
  },
  async countDoc(docId) {
    return tx('audio', 'readonly', s =>
      asPromise(s.index('docId').count(IDBKeyRange.only(docId))));
  },
  async clearDoc(docId) {
    return tx('audio', 'readwrite', s => new Promise((res, rej) => {
      const req = s.index('docId').openKeyCursor(IDBKeyRange.only(docId));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return res();
        s.delete(c.primaryKey);
        c.continue();
      };
      req.onerror = () => rej(req.error);
    }));
  },
  async clearAll() { await tx('audio', 'readwrite', s => s.clear()); },
  async count() { return tx('audio', 'readonly', s => asPromise(s.count())); },
};

export async function wipe() {
  for (const s of ['docs', 'content', 'files', 'progress', 'audio']) {
    await tx(s, 'readwrite', st => st.clear());
  }
}

export async function usage() {
  if (!navigator.storage?.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}

/** Ask the browser not to evict our data under storage pressure. Safari only
 *  grants this once the app has been added to the home screen. */
export async function persist() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}
