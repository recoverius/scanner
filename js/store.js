// In-memory model of documents and pages, persisted to IndexedDB.
import * as db from './db.js';
import { uid, defaultDocName } from './ui.js';
import { makeThumb, forget } from './render.js';

export const docs = new Map();
export const pages = new Map();
const listeners = new Set();

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) { for (const fn of listeners) fn(what); }

/* ---------- settings ---------- */
const SETTINGS_KEY = 'paperwise.settings';
export const settings = {
  defaultFilter: 'auto',
  autoCapture: true,
  reviewCrop: true,
  pageSize: 'a4',
  quality: 'balanced',
  ...(() => {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
  })(),
};
export function saveSettings(patch) {
  Object.assign(settings, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

/* ---------- loading ---------- */
export async function load() {
  const [d, p] = await Promise.all([db.getAll('docs'), db.getAll('pages')]);
  for (const doc of d) docs.set(doc.id, doc);
  for (const page of p) pages.set(page.id, page);
  // Repair: drop page ids that no longer exist; adopt orphan pages.
  for (const doc of docs.values()) {
    const before = doc.pageIds.length;
    doc.pageIds = doc.pageIds.filter((id) => pages.has(id));
    if (doc.pageIds.length !== before) db.put('docs', doc);
  }
  for (const page of pages.values()) {
    const doc = docs.get(page.docId);
    if (!doc) { pages.delete(page.id); db.remove('pages', page.id); continue; }
    if (!doc.pageIds.includes(page.id)) { doc.pageIds.push(page.id); db.put('docs', doc); }
  }
  emit('load');
}

export function docPages(docId) {
  const doc = docs.get(docId);
  return doc ? doc.pageIds.map((id) => pages.get(id)).filter(Boolean) : [];
}

export function sortedDocs(sort = 'updated', query = '') {
  const q = query.trim().toLowerCase();
  const list = [...docs.values()].filter((d) => !q || d.name.toLowerCase().includes(q));
  if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  else if (sort === 'created') list.sort((a, b) => b.createdAt - a.createdAt);
  else list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}

/* ---------- documents ---------- */
export async function createDoc(name) {
  const now = Date.now();
  const doc = { id: uid(), name: name || defaultDocName(now), createdAt: now, updatedAt: now, pageIds: [] };
  docs.set(doc.id, doc);
  await db.put('docs', doc);
  emit('docs');
  return doc;
}

async function touch(doc) {
  doc.updatedAt = Date.now();
  await db.put('docs', doc);
}

export async function renameDoc(docId, name) {
  const doc = docs.get(docId);
  if (!doc) return;
  doc.name = name;
  await touch(doc);
  emit('docs');
}

export async function deleteDocs(docIds) {
  const removed = [];
  for (const id of docIds) {
    const doc = docs.get(id);
    if (!doc) continue;
    const ps = docPages(id);
    removed.push({ doc: { ...doc, pageIds: [...doc.pageIds] }, pages: ps });
    for (const p of ps) { pages.delete(p.id); forget(p.id); await db.remove('pages', p.id); }
    docs.delete(id);
    await db.remove('docs', id);
  }
  emit('docs');
  return async function undo() {
    for (const r of removed) {
      docs.set(r.doc.id, r.doc);
      await db.put('docs', r.doc);
      for (const p of r.pages) { pages.set(p.id, p); await db.put('pages', p); }
    }
    emit('docs');
  };
}

export async function duplicateDoc(docId) {
  const src = docs.get(docId);
  const copy = await createDoc(`${src.name} copy`);
  for (const p of docPages(docId)) {
    const np = { ...p, id: uid(), docId: copy.id, createdAt: Date.now(), corners: p.corners && p.corners.map((c) => ({ ...c })), adjust: { ...p.adjust } };
    pages.set(np.id, np);
    copy.pageIds.push(np.id);
    await db.put('pages', np);
  }
  await touch(copy);
  emit('docs');
  return copy;
}

export async function mergeDocs(docIds, name) {
  const [first, ...rest] = docIds.map((id) => docs.get(id)).filter(Boolean);
  if (!first) return null;
  for (const d of rest) {
    for (const pid of d.pageIds) {
      const p = pages.get(pid);
      if (!p) continue;
      p.docId = first.id;
      first.pageIds.push(pid);
      await db.put('pages', p);
    }
    docs.delete(d.id);
    await db.remove('docs', d.id);
  }
  if (name) first.name = name;
  await touch(first);
  emit('docs');
  return first;
}

/* ---------- pages ---------- */
export async function addPage(docId, { blob, width, height, corners = null, filter, rotation = 0 }) {
  const doc = docs.get(docId);
  const page = {
    id: uid(),
    docId,
    original: blob,
    width,
    height,
    corners,
    rotation,
    filter: filter || settings.defaultFilter,
    adjust: {},
    thumb: null,
    createdAt: Date.now(),
  };
  pages.set(page.id, page);
  doc.pageIds.push(page.id);
  await db.put('pages', page);
  await touch(doc);
  emit('pages');
  refreshThumb(page.id);
  return page;
}

const thumbQueue = new Map();
export function refreshThumb(pageId) {
  if (thumbQueue.has(pageId)) { thumbQueue.get(pageId).again = true; return thumbQueue.get(pageId).promise; }
  const entry = { again: false };
  entry.promise = (async () => {
    do {
      entry.again = false;
      const page = pages.get(pageId);
      if (!page) break;
      try {
        page.thumb = await makeThumb(page);
        if (!pages.has(pageId)) break;
        await db.put('pages', page);
        emit({ thumb: pageId });
      } catch (e) {
        console.warn('Thumbnail failed', e);
      }
    } while (entry.again);
    thumbQueue.delete(pageId);
  })();
  thumbQueue.set(pageId, entry);
  return entry.promise;
}

export async function updatePage(pageId, patch, { thumb = true } = {}) {
  const page = pages.get(pageId);
  if (!page) return;
  Object.assign(page, patch);
  await db.put('pages', page);
  const doc = docs.get(page.docId);
  if (doc) await touch(doc);
  emit({ page: pageId });
  if (thumb) refreshThumb(pageId);
}

export async function reorderPages(docId, pageIds) {
  const doc = docs.get(docId);
  doc.pageIds = pageIds;
  await touch(doc);
  emit('pages');
}

export async function deletePages(pageIds) {
  const removed = [];
  for (const id of pageIds) {
    const p = pages.get(id);
    if (!p) continue;
    const doc = docs.get(p.docId);
    const index = doc ? doc.pageIds.indexOf(id) : -1;
    removed.push({ page: p, index });
    if (doc) { doc.pageIds = doc.pageIds.filter((x) => x !== id); await touch(doc); }
    pages.delete(id);
    forget(id);
    await db.remove('pages', id);
  }
  emit('pages');
  return async function undo() {
    // Each index was taken after the earlier removals, so restore in reverse order.
    for (const r of [...removed].reverse()) {
      let doc = docs.get(r.page.docId);
      if (!doc) {
        doc = { id: r.page.docId, name: defaultDocName(), createdAt: Date.now(), updatedAt: Date.now(), pageIds: [] };
        docs.set(doc.id, doc);
      }
      pages.set(r.page.id, r.page);
      await db.put('pages', r.page);
      doc.pageIds.splice(r.index < 0 ? doc.pageIds.length : r.index, 0, r.page.id);
      await touch(doc);
    }
    emit('pages');
  };
}

export async function movePages(pageIds, targetDocId) {
  const target = docs.get(targetDocId);
  for (const id of pageIds) {
    const p = pages.get(id);
    if (!p || p.docId === targetDocId) continue;
    const src = docs.get(p.docId);
    if (src) { src.pageIds = src.pageIds.filter((x) => x !== id); await touch(src); }
    p.docId = targetDocId;
    target.pageIds.push(id);
    await db.put('pages', p);
  }
  await touch(target);
  emit('pages');
}

export function docSize(docId) {
  return docPages(docId).reduce((n, p) => n + (p.original?.size || 0), 0);
}
