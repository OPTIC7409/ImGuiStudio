// Small DOM helpers shared by the Studio UI modules.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function toast(message, kind = 'info', ms = 4000) {
  const el = h('div', { class: `toast ${kind}` });
  if (message instanceof Node) el.appendChild(message);
  else el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

export function modal({ title, body, footer = [], width = null, onClose = null }) {
  const root = document.getElementById('modal-root');
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const box = h(
    'div',
    { class: 'modal', style: width ? { width } : null },
    h('header', {}, h('span', {}, title), h('button', { class: 'icon', onclick: () => close(), title: 'Close' }, '✕')),
    h('div', { class: 'body' }, body),
    footer.length ? h('footer', {}, footer) : null,
  );
  const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => e.target === backdrop && close() }, box);
  root.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  return { close, box };
}

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function fmtMs(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function json(v) {
  return JSON.stringify(v, null, 2);
}

export function fileIcon(path) {
  if (/\.(cpp|cc|cxx|c)$/i.test(path)) return ['cpp', 'C'];
  if (/\.(h|hpp|hh|hxx|inl)$/i.test(path)) return ['h', 'H'];
  if (/\.json$/i.test(path)) return ['json', '{}'];
  if (/\.(png|jpe?g|svg|gif)$/i.test(path)) return ['img', '▣'];
  if (/\.(ttf|otf)$/i.test(path)) return ['', 'F'];
  return ['', '·'];
}

export function languageFor(path) {
  if (/\.(cpp|cc|cxx|c|h|hpp|hh|hxx|inl)$/i.test(path)) return 'cpp';
  if (/\.json$/i.test(path)) return 'json';
  if (/\.md$/i.test(path)) return 'markdown';
  if (/\.(js|mjs)$/i.test(path)) return 'javascript';
  if (/\.(glsl|frag|vert)$/i.test(path)) return 'cpp';
  return 'plaintext';
}

export function isTextFile(path) {
  return /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl|json|md|txt|glsl|frag|vert|cmake|ini|toml|ya?ml|svg|js)$/i.test(path) || !/\.[a-z0-9]+$/i.test(path);
}

export function drag(handle, { onMove, onEnd, cursor }) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    document.body.style.cursor = cursor || getComputedStyle(handle).cursor;
    const shield = h('div', { style: { position: 'fixed', inset: '0', zIndex: 999, cursor: document.body.style.cursor } });
    document.body.appendChild(shield);
    const move = (ev) => onMove(ev.clientX - start.x, ev.clientY - start.y, ev);
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      shield.remove();
      document.body.style.cursor = '';
      if (onEnd) onEnd();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^;]+;base64,/, ''));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}
