// Small UI toolkit: toasts, bottom sheets, confirm/prompt dialogs, busy overlay, helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Today, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function defaultDocName(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `Scan ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

export function safeFileName(name) {
  return (name || 'scan').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'scan';
}

export function vibrate(ms = 15) {
  try { navigator.vibrate?.(ms); } catch { /* ignore */ }
}

/* ---------- toasts ---------- */
export function toast(message, { action, onAction, error = false, duration = 3200 } = {}) {
  const host = $('#toast-host');
  const node = el('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, el('span', { text: message }));
  let timer;
  const close = () => {
    clearTimeout(timer);
    node.remove();
  };
  if (action) {
    node.append(el('button', { text: action, onclick: () => { close(); onAction?.(); } }));
  }
  host.append(node);
  while (host.children.length > 3) host.firstChild.remove();
  timer = setTimeout(close, action ? Math.max(duration, 5000) : duration);
  return close;
}

/* ---------- sheets ---------- */
let sheetStack = [];

export function openSheet(build, { onClose } = {}) {
  const scrim = $('#scrim');
  const host = $('#sheet-host');
  const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, el('div', { class: 'sheet-grip' }));
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    sheet.remove();
    sheetStack = sheetStack.filter((s) => s !== entry);
    if (!sheetStack.length) scrim.hidden = true;
    document.removeEventListener('keydown', onKey);
    onClose?.(result);
  };
  const onKey = (e) => { if (e.key === 'Escape' && sheetStack.at(-1) === entry) close(); };
  const entry = { close };
  build(sheet, close);
  host.append(sheet);
  scrim.hidden = false;
  scrim.onclick = () => sheetStack.at(-1)?.close();
  sheetStack.push(entry);
  document.addEventListener('keydown', onKey);
  // Swipe down on the grip area to dismiss.
  let startY = null;
  sheet.addEventListener('touchstart', (e) => { if (sheet.scrollTop <= 0) startY = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (startY == null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    if (dy > 90) close(); else sheet.style.transform = '';
  });
  requestAnimationFrame(() => sheet.querySelector('[autofocus]')?.focus());
  return close;
}

export function closeAllSheets() {
  [...sheetStack].reverse().forEach((s) => s.close());
}

export function hasOpenSheet() {
  return sheetStack.length > 0;
}

export function menu(title, items) {
  return new Promise((resolve) => {
    openSheet((sheet, close) => {
      if (title) sheet.append(el('h3', { text: title, style: 'margin-bottom:8px' }));
      const list = el('div', { class: 'menu' });
      for (const item of items) {
        if (!item) continue;
        list.append(el('button', {
          class: item.danger ? 'danger' : '',
          onclick: () => close(item.value),
        }, item.icon ? icon(item.icon) : null, el('span', { text: item.label }), item.hint ? el('small', { text: item.hint }) : null));
      }
      sheet.append(list);
    }, { onClose: (v) => resolve(v ?? null) });
  });
}

export function confirmDialog({ title, message, confirm = 'OK', danger = false }) {
  return new Promise((resolve) => {
    openSheet((sheet, close) => {
      sheet.append(
        el('h3', { text: title }),
        message ? el('p', { class: 'sub', text: message }) : null,
        el('div', { class: 'sheet-actions' },
          el('button', { class: 'btn', text: 'Cancel', onclick: () => close(false) }),
          el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, text: confirm, autofocus: true, onclick: () => close(true) }),
        ),
      );
    }, { onClose: (v) => resolve(!!v) });
  });
}

export function promptDialog({ title, value = '', placeholder = '', confirm = 'Save' }) {
  return new Promise((resolve) => {
    openSheet((sheet, close) => {
      const input = el('input', { class: 'text-input', type: 'text', value, placeholder, id: 'prompt-input', autocomplete: 'off', enterkeyhint: 'done' });
      const form = el('form', {
        onsubmit: (e) => { e.preventDefault(); close(input.value.trim()); },
      },
      el('h3', { text: title, style: 'margin-bottom:12px' }),
      el('label', { class: 'field' }, input),
      el('div', { class: 'sheet-actions' },
        el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => close(null) }),
        el('button', { class: 'btn primary', type: 'submit', text: confirm }),
      ));
      sheet.append(form);
      setTimeout(() => { input.focus(); input.select(); }, 60);
    }, { onClose: (v) => resolve(typeof v === 'string' && v ? v : null) });
  });
}

/* ---------- busy overlay ---------- */
let busyNode = null;
let busyCount = 0;
export function busy(message = 'Working…') {
  busyCount++;
  if (!busyNode) {
    busyNode = el('div', { class: 'busy-overlay' }, el('div', { class: 'busy-box' }, el('div', { class: 'spinner' }), el('span', { class: 'busy-text' })));
    document.body.append(busyNode);
  }
  busyNode.querySelector('.busy-text').textContent = message;
  let done = false;
  return {
    update(msg) { if (busyNode) busyNode.querySelector('.busy-text').textContent = msg; },
    done() {
      if (done) return;
      done = true;
      busyCount--;
      if (busyCount <= 0 && busyNode) { busyNode.remove(); busyNode = null; busyCount = 0; }
    },
  };
}

/* ---------- files ---------- */
// When the app runs inside a Claude artifact, files go through the host's save prompt.
let downloadsCap = null;
function hostDownloads() {
  if (!window.claude?.use) return Promise.resolve(null);
  downloadsCap ??= window.claude.use('downloads').catch(() => null);
  return downloadsCap;
}

// Resolves true when the file was handed to the browser, false when the viewer declined.
export async function downloadBlob(blob, filename) {
  const host = await hostDownloads();
  if (host) {
    try {
      await host.save({ filename, data: blob });
      return true;
    } catch (e) {
      if (e?.code === 'declined') return false;
      throw new Error(e?.message || 'The file could not be saved.');
    }
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

export async function shareFiles(files, title) {
  if (!navigator.canShare || !navigator.canShare({ files })) return false;
  try {
    await navigator.share({ files, title });
    return true;
  } catch (e) {
    if (e?.name === 'AbortError') return true;
    return false;
  }
}

export function canShareFiles(type = 'application/pdf') {
  try {
    const f = new File([new Uint8Array(1)], 'x', { type });
    return !!navigator.canShare?.({ files: [f] });
  } catch {
    return false;
  }
}
