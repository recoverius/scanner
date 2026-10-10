// IndexedDB persistence for documents and pages.
// Documents: { id, name, createdAt, updatedAt, pageIds: string[] }
// Pages:     { id, docId, original: Blob, width, height, corners, rotation, filter, adjust, thumb: Blob|null, createdAt }

const DB_NAME = 'scanner';
const DB_VERSION = 1;

let dbPromise = null;
let memory = null; // fallback when IndexedDB is unavailable (private mode, blocked storage)

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) {
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('docId', 'docId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  }).then((db) => {
    if (!db) memory = { docs: new Map(), pages: new Map() };
    return db;
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    Promise.resolve(fn(t.objectStore(store))).then((r) => { result = r; }, reject);
  });
}

export function isPersistent() {
  return open().then((db) => !!db);
}

export async function getAll(store) {
  const db = await open();
  if (!db) return [...memory[store].values()];
  return tx(store, 'readonly', (s) => promisify(s.getAll()));
}

export async function get(store, id) {
  const db = await open();
  if (!db) return memory[store].get(id) || null;
  return tx(store, 'readonly', (s) => promisify(s.get(id))).then((r) => r || null);
}

export async function put(store, value) {
  const db = await open();
  if (!db) { memory[store].set(value.id, value); return value; }
  await tx(store, 'readwrite', (s) => promisify(s.put(value)));
  return value;
}

export async function remove(store, id) {
  const db = await open();
  if (!db) { memory[store].delete(id); return; }
  await tx(store, 'readwrite', (s) => promisify(s.delete(id)));
}

export async function estimate() {
  try {
    if (navigator.storage?.estimate) return await navigator.storage.estimate();
  } catch { /* ignore */ }
  return null;
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}
