// ImGui Studio preview runtime.
//
// Hosts the compiled Dear ImGui application (WebAssembly + WebGL2) and exposes it
// to the Studio server (WebSocket RPC) and to the Studio UI (postMessage RPC).
//
// Two roles:
//   role=studio  realtime preview for humans (requestAnimationFrame, real input)
//   role=agent   deterministic preview for agents: time only advances when a
//                command steps it, with a fixed 1/60 s timestep.
//
// Every scripted interaction goes through the same C input functions the human
// preview uses, so what an agent sees is exactly what the native UI would do.

const params = new URLSearchParams(location.search);
const ROLE = params.get('role') === 'agent' ? 'agent' : 'studio';
const BUILD = params.get('build') || 'latest';
const EMBEDDED = window.parent !== window;
const DT = 1 / 60;

const canvas = document.getElementById('canvas');
const stage = document.getElementById('stage');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const refImg = document.getElementById('reference-overlay');
const guidesEl = document.getElementById('guides');

const state = {
  M: null,
  ready: false,
  crashed: null,
  config: null,
  buildId: null,
  viewport: { width: 1280, height: 800, scale: 1 },
  clear: [0.06, 0.06, 0.07, 1],
  paused: false,
  manualDepth: 0,
  lastTs: 0,
  time: 0,
  frames: 0,
  timeScale: 1,
  errors: [],
  errorCounts: new Map(),
  logs: [],
  zoom: 'fit',
  cssScale: 1,
  inspect: false,
  hoverWidget: null,
  selected: null,
  highlights: [],
  mouse: null,
  ws: null,
  cursor: -2,
  fpsFrames: 0,
  fpsT0: performance.now(),
  fps: 0,
};

// ---------------------------------------------------------------------------
// Messaging (server WebSocket + parent window)
// ---------------------------------------------------------------------------

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

function postParent(msg) {
  if (EMBEDDED) window.parent.postMessage({ source: 'imgui-studio-preview', ...msg }, '*');
}

function emitEvent(name, data) {
  send({ type: 'event', name, data });
  postParent({ type: 'event', name, data });
}

function reportError(kind, message, extra = {}) {
  const key = `${kind}:${message}`;
  const count = (state.errorCounts.get(key) || 0) + 1;
  state.errorCounts.set(key, count);
  if (count > 1) {
    const existing = state.errors.find((e) => e.key === key);
    if (existing) existing.count = count;
    return;
  }
  const err = { key, kind, message, ...extra, count, frame: state.frames, time: round(state.time, 4), build: state.buildId, at: new Date().toISOString() };
  state.errors.push(err);
  if (state.errors.length > 200) state.errors.shift();
  emitEvent('runtime_error', err);
}

function reportLog(level, text) {
  const entry = { level, text: String(text), frame: state.frames, at: new Date().toISOString() };
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  emitEvent('runtime_log', entry);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?kind=runtime&role=${ROLE}&build=${encodeURIComponent(state.buildId ?? BUILD)}`);
  state.ws = ws;
  ws.onopen = () => {
    send({ type: 'hello', role: ROLE, build: state.buildId, ready: state.ready, crashed: !!state.crashed, viewport: state.viewport, embedded: EMBEDDED });
  };
  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'rpc') {
      const reply = await handleRpc(msg.method, msg.params || {});
      send({ type: 'rpc_result', id: msg.id, ...reply });
    } else if (msg.type === 'reload') {
      reloadTo(msg.build);
    }
  };
  ws.onclose = () => {
    state.ws = null;
    setTimeout(connect, 1000);
  };
  ws.onerror = () => {};
}

window.addEventListener('message', async (ev) => {
  const msg = ev.data;
  if (!msg || msg.target !== 'imgui-studio-preview') return;
  if (msg.type === 'rpc') {
    const reply = await handleRpc(msg.method, msg.params || {});
    ev.source?.postMessage({ source: 'imgui-studio-preview', type: 'rpc_result', id: msg.id, ...reply }, '*');
  }
});

function reloadTo(build) {
  const p = new URLSearchParams(location.search);
  if (build != null) p.set('build', String(build));
  location.replace(`${location.pathname}?${p.toString()}`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function showStatus(text, kind = 'error') {
  statusEl.className = `visible ${kind}`;
  statusEl.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'box';
  box.textContent = text;
  statusEl.appendChild(box);
}

function hideStatus() {
  statusEl.className = '';
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function boot() {
  let cfg;
  try {
    const res = await fetch(`/api/preview-config?build=${encodeURIComponent(BUILD)}`);
    cfg = await res.json();
  } catch (e) {
    showStatus(`Cannot reach the ImGui Studio server: ${e.message}`);
    connect();
    return;
  }
  if (!cfg.ok) {
    showStatus(cfg.message || 'No successful build yet. Build the project to see the preview.', 'info');
    postParent({ type: 'event', name: 'no_build', data: cfg });
    connect();
    return;
  }
  state.config = cfg;
  state.buildId = cfg.build_id;
  state.clear = cfg.clear_color || state.clear;
  state.viewport = {
    width: Number(params.get('w')) || cfg.viewport.width,
    height: Number(params.get('h')) || cfg.viewport.height,
    scale: Number(params.get('scale')) || (ROLE === 'agent' ? 1 : Number(cfg.viewport.scale) || 1),
  };
  if (params.get('zoom')) state.zoom = params.get('zoom') === 'fit' ? 'fit' : Number(params.get('zoom')) || 1;
  applyCanvasSize();
  connect();

  let assets = [];
  try {
    assets = await Promise.all(
      (cfg.assets || []).map(async (a) => {
        const r = await fetch(a.url);
        if (!r.ok) throw new Error(`asset ${a.path}: HTTP ${r.status}`);
        return [a.path, new Uint8Array(await r.arrayBuffer())];
      }),
    );
  } catch (e) {
    reportError('asset', e.message);
  }

  try {
    await loadScript(cfg.js_url);
  } catch (e) {
    showStatus(e.message);
    reportError('load', e.message);
    return;
  }

  const readyPromise = new Promise((resolve) => (state._resolveReady = resolve));
  try {
    const M = await window.createStudioModule({
      canvas,
      studioConfig: { width: state.viewport.width, height: state.viewport.height, scale: state.viewport.scale },
      locateFile: (p) => cfg.base_url + p,
      preRun: [
        (Module) => {
          const FS = Module.FS;
          const mkdirp = (dir) => {
            let cur = '';
            for (const part of dir.split('/').filter(Boolean)) {
              cur += `/${part}`;
              try {
                FS.mkdir(cur);
              } catch {
                // exists
              }
            }
          };
          mkdirp('/project');
          for (const [p, bytes] of assets) {
            const full = `/project/${p}`;
            mkdirp(full.slice(0, full.lastIndexOf('/')));
            FS.writeFile(full, bytes);
          }
          FS.chdir('/project');
        },
      ],
      print: (t) => reportLog('stdout', t),
      printErr: (t) => {
        if (/^warning: /.test(t) || /Browser does not support|The WebGL context/.test(t)) return reportLog('stderr', t);
        reportLog('stderr', t);
      },
      studioOnReady: () => state._resolveReady(),
      studioOnLog: (level, text) => {
        const clean = String(text).replace(/^\[\d+\]\s*/, '').trim();
        if (/^\[imgui-error\] \(current settings:/.test(clean)) return;
        if (level >= 2) reportError('imgui', clean.replace(/^\[imgui-error\]\s*/, ''));
        else reportLog(level === 1 ? 'warning' : 'imgui', clean);
      },
      studioOnAssert: (expr, file, line) => reportError('assert', `Assertion failed: ${expr}`, { file, line }),
      studioOnFatal: (msg) => reportError('fatal', msg),
      onAbort: (what) => crash(new Error(`Aborted: ${what}`)),
    });
    state.M = M;
    await Promise.race([readyPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('AppInit() did not complete within 20s')), 20000))]);
  } catch (e) {
    crash(e);
    return;
  }

  state.M._studio_set_clear_color(...state.clear);
  state.ready = true;
  hideStatus();

  if (ROLE === 'agent') {
    const settle = Number(cfg.settle_ms ?? 500);
    step(Math.max(2, Math.round((settle / 1000) * 60)));
  } else {
    step(2);
    requestAnimationFrame(loop);
    installInput();
  }
  const info = await methods.info();
  emitEvent('ready', info);
}

function crash(e) {
  if (state.crashed) return;
  const message = e && e.message ? e.message : String(e);
  state.crashed = { message, stack: e && e.stack ? String(e.stack).split('\n').slice(0, 12).join('\n') : undefined };
  state.ready = false;
  const last = state.errors.filter((x) => x.kind === 'assert').slice(-1)[0];
  const detail = last ? `${last.message}\n  at ${last.file}:${last.line}\n\n` : '';
  reportError('crash', message, { stack: state.crashed.stack });
  showStatus(`The ImGui application crashed.\n\n${detail}${message}\n\n${state.crashed.stack || ''}`);
}

function applyCanvasSize() {
  const { width, height } = state.viewport;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  refImg.style.width = `${width}px`;
  refImg.style.height = `${height}px`;
  layoutStage();
}

function layoutStage() {
  const { width, height } = state.viewport;
  let z = state.zoom === 'fit' ? Math.min(1, (window.innerWidth - 16) / width, (window.innerHeight - 16) / height) : Number(state.zoom) || 1;
  if (!(z > 0)) z = 1;
  state.cssScale = z;
  const x = Math.max(0, Math.round((window.innerWidth - width * z) / 2));
  const y = Math.max(0, Math.round((window.innerHeight - height * z) / 2));
  stage.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  document.body.classList.toggle('pixelated', z > 1.01);
  renderHighlights();
}

window.addEventListener('resize', layoutStage);

// ---------------------------------------------------------------------------
// Frame stepping
// ---------------------------------------------------------------------------

function frame(dt, render) {
  if (!state.ready || state.crashed) return false;
  try {
    state.M._studio_frame(dt, render ? 1 : 0);
  } catch (e) {
    crash(e);
    return false;
  }
  state.frames++;
  state.time += dt;
  if (render && ROLE === 'studio') updateCursor();
  return true;
}

function step(n, dt = DT, renderLast = true) {
  for (let i = 0; i < n; i++) {
    if (!frame(dt, renderLast && i === n - 1)) return false;
  }
  return true;
}

function framesFor(ms) {
  return Math.max(1, Math.round((Math.max(0, ms) / 1000) * 60));
}

function settle(ms) {
  step(framesFor(ms));
}

function loop(ts) {
  requestAnimationFrame(loop);
  if (state.paused || state.manualDepth > 0 || !state.ready || state.crashed) {
    state.lastTs = ts;
    return;
  }
  const dt = state.lastTs ? Math.min(0.1, Math.max(0.0005, (ts - state.lastTs) / 1000)) : DT;
  state.lastTs = ts;
  frame(dt * state.timeScale, true);
  state.fpsFrames++;
  const now = performance.now();
  if (now - state.fpsT0 > 1000) {
    state.fps = Math.round((state.fpsFrames * 1000) / (now - state.fpsT0));
    state.fpsFrames = 0;
    state.fpsT0 = now;
    postParent({ type: 'event', name: 'stats', data: { fps: state.fps, frame: state.frames, time: round(state.time, 2), build: state.buildId, viewport: state.viewport } });
  }
  if (state.inspect && state.hoverPoint) updateInspectHover();
}

// Actions pause the realtime loop and advance time explicitly.
let rpcChain = Promise.resolve();
function exclusive(fn) {
  const run = rpcChain.then(async () => {
    state.manualDepth++;
    try {
      return await fn();
    } finally {
      state.manualDepth--;
      state.lastTs = 0;
    }
  });
  rpcChain = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Low-level input (shared by humans and agents)
// ---------------------------------------------------------------------------

function withString(str, fn) {
  const M = state.M;
  const len = M.lengthBytesUTF8(str) + 1;
  const ptr = M._malloc(len);
  M.stringToUTF8(str, ptr, len);
  try {
    return fn(ptr);
  } finally {
    M._free(ptr);
  }
}

const input = {
  move(x, y) {
    state.mouse = [x, y];
    state.M._studio_mouse_pos(x, y);
  },
  leave() {
    state.mouse = null;
    state.M._studio_mouse_leave();
  },
  button(b, down) {
    state.M._studio_mouse_button(b, down ? 1 : 0);
  },
  wheel(dx, dy) {
    state.M._studio_mouse_wheel(dx, dy);
  },
  mods(m) {
    state.M._studio_mods(m.ctrl ? 1 : 0, m.shift ? 1 : 0, m.alt ? 1 : 0, m.super ? 1 : 0);
  },
  key(code, down) {
    return withString(code, (p) => state.M._studio_key(p, down ? 1 : 0));
  },
  chars(text) {
    withString(text, (p) => state.M._studio_chars(p));
  },
};

const CURSORS = ['default', 'text', 'move', 'ns-resize', 'ew-resize', 'nesw-resize', 'nwse-resize', 'pointer', 'wait', 'progress', 'not-allowed'];
function updateCursor() {
  if (state.inspect) {
    canvas.style.cursor = 'crosshair';
    return;
  }
  const c = state.M._studio_get_cursor();
  if (c === state.cursor) return;
  state.cursor = c;
  canvas.style.cursor = c < 0 ? 'none' : CURSORS[c] || 'default';
}

function canvasPoint(ev) {
  const r = canvas.getBoundingClientRect();
  return [((ev.clientX - r.left) * state.viewport.width) / r.width, ((ev.clientY - r.top) * state.viewport.height) / r.height];
}

function installInput() {
  const mods = (e) => ({ ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, super: e.metaKey });
  canvas.addEventListener('mousemove', (e) => {
    const [x, y] = canvasPoint(e);
    if (state.inspect) {
      state.hoverPoint = [x, y];
      updateInspectHover();
      return;
    }
    if (state.ready) input.move(x, y);
  });
  canvas.addEventListener('mouseleave', () => {
    state.hoverPoint = null;
    if (state.inspect) {
      state.hoverWidget = null;
      renderHighlights();
      postParent({ type: 'event', name: 'inspect_hover', data: null });
    } else if (state.ready) input.leave();
  });
  canvas.addEventListener('mousedown', (e) => {
    canvas.focus();
    if (!state.ready) return;
    if (state.inspect) {
      const [x, y] = canvasPoint(e);
      const w = widgetAt(x, y);
      state.selected = w ? w.id : null;
      renderHighlights();
      postParent({ type: 'event', name: 'inspect_select', data: w });
      e.preventDefault();
      return;
    }
    input.mods(mods(e));
    input.button(e.button === 2 ? 1 : e.button === 1 ? 2 : 0, true);
    e.preventDefault();
  });
  window.addEventListener('mouseup', (e) => {
    if (!state.ready || state.inspect) return;
    input.button(e.button === 2 ? 1 : e.button === 1 ? 2 : 0, false);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!state.ready || state.inspect) return;
      const unit = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100;
      input.wheel(-e.deltaX / unit, -e.deltaY / unit);
      e.preventDefault();
    },
    { passive: false },
  );
  canvas.addEventListener('keydown', (e) => {
    if (!state.ready) return;
    input.mods(mods(e));
    input.key(e.code, true);
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) input.chars(e.key);
    if (!(e.metaKey && ['KeyR', 'KeyL'].includes(e.code))) e.preventDefault();
  });
  canvas.addEventListener('keyup', (e) => {
    if (!state.ready) return;
    input.mods(mods(e));
    input.key(e.code, false);
    e.preventDefault();
  });
  canvas.addEventListener('focus', () => state.ready && state.M._studio_focus(1));
  canvas.addEventListener('blur', () => state.ready && state.M._studio_focus(0));
}

// ---------------------------------------------------------------------------
// Widget queries
// ---------------------------------------------------------------------------

function snapshot() {
  if (!state.M || state.crashed) throw rpcError('runtime_unavailable', state.crashed ? `The application crashed: ${state.crashed.message}` : 'The runtime is not ready');
  return JSON.parse(state.M.UTF8ToString(state.M._studio_widgets_json()));
}

function frameInfo() {
  return JSON.parse(state.M.UTF8ToString(state.M._studio_frame_json()));
}

function rpcError(code, message, details) {
  const e = new Error(message);
  e.code = code;
  e.details = details;
  return e;
}

function round(v, d = 2) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function resolveWidget(id, snap = snapshot()) {
  if (id == null || id === '') throw rpcError('bad_request', 'A widget id is required');
  const q = String(id);
  const ws = snap.widgets;
  let hits = ws.filter((w) => w.id === q);
  if (hits.length === 1) return hits[0];
  if (/^0x[0-9a-f]+$/i.test(q)) {
    hits = ws.filter((w) => w.imgui_id.toLowerCase() === q.toLowerCase());
    if (hits.length) return hits[0];
  }
  const win = snap.windows.find((w) => w.id === q || w.name === q);
  if (win) return { ...win, type: 'window', label: win.name, state: { hovered: win.hovered, focused: win.focused }, visible: !win.hidden };
  const named = ws.filter((w) => !w.anonymous);
  hits = named.filter((w) => w.id.endsWith(`.${q}`));
  if (hits.length === 1) return hits[0];
  const lower = q.toLowerCase();
  const byLabel = named.filter((w) => w.label && w.label.toLowerCase() === lower);
  if (byLabel.length === 1) return byLabel[0];
  // Items whose widget does not report a label: match hash(label, ID-stack seed) == item ID.
  if (!hits.length && !byLabel.length && state.M) {
    const labels = [q, VISIBLE_LABEL(q)];
    for (const l of labels) {
      const ids = JSON.parse(state.M.UTF8ToString(withString(l, (p) => state.M._studio_find_by_label(p))));
      if (ids.length === 1) {
        const w = ws.find((x) => x.id === ids[0]);
        if (w) return { ...w, label: w.label || l, resolved_by: 'label_hash' };
      }
    }
  }
  const pool = hits.length > 1 ? hits : byLabel.length > 1 ? byLabel : named.filter((w) => w.id.includes(lower) || (w.label || '').toLowerCase().includes(lower));
  throw rpcError(
    hits.length > 1 || byLabel.length > 1 ? 'ambiguous_widget' : 'widget_not_found',
    hits.length > 1 || byLabel.length > 1 ? `"${q}" matches several widgets; use one of the full ids` : `No widget "${q}" in the current frame`,
    { candidates: pool.slice(0, 12).map((w) => ({ id: w.id, type: w.type, label: w.label, visible: w.visible })) },
  );
}

function VISIBLE_LABEL(s) {
  const i = s.indexOf('##');
  return i >= 0 ? s.slice(0, i) : s;
}

function boundsOf(w) {
  return w.visible_bounds || w.bounds;
}

function windowRank(snap, name) {
  const w = snap.windows.find((x) => x.name === name);
  if (!w) return 0;
  const kindBoost = { tooltip: 4000, modal: 3000, popup: 2000, menu: 2000 }[w.kind] || 0;
  return kindBoost + (w.focus_order >= 0 ? w.focus_order : 0) * 2 + w.begin_order / 10000;
}

function widgetAt(x, y, snap) {
  try {
    snap = snap || snapshot();
  } catch {
    return null;
  }
  const inside = (b) => x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
  let best = null;
  let bestKey = null;
  for (const w of snap.widgets) {
    if (!w.visible || w.type === 'window') continue;
    const b = boundsOf(w);
    if (!inside(b)) continue;
    const area = b.width * b.height;
    const root = w.window.split('/')[0];
    const key = [windowRank(snap, root), w.window.length, w.anonymous ? 0 : 1, -area];
    if (!bestKey || compareKeys(key, bestKey) > 0) {
      best = w;
      bestKey = key;
    }
  }
  return best;
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function filterWidgets(snap, p) {
  let ws = snap.widgets;
  if (!p.include_anonymous) ws = ws.filter((w) => !w.anonymous);
  if (!p.include_hidden) ws = ws.filter((w) => w.visible);
  if (!p.include_windows) ws = ws.filter((w) => w.type !== 'window');
  if (p.window) ws = ws.filter((w) => w.window === p.window || w.window.startsWith(`${p.window}/`));
  if (p.type) ws = ws.filter((w) => w.type === p.type);
  if (p.prefix) ws = ws.filter((w) => w.id.startsWith(p.prefix));
  if (p.query) {
    const q = String(p.query).toLowerCase();
    ws = ws.filter((w) => w.id.toLowerCase().includes(q) || (w.label || '').toLowerCase().includes(q));
  }
  if (p.explicit_only) ws = ws.filter((w) => w.explicit);
  return ws;
}

// ---------------------------------------------------------------------------
// Scripted interaction
// ---------------------------------------------------------------------------

function parseModifiers(list) {
  const m = { ctrl: false, shift: false, alt: false, super: false };
  for (const k of list || []) {
    const s = String(k).toLowerCase();
    if (s === 'ctrl' || s === 'control') m.ctrl = true;
    else if (s === 'shift') m.shift = true;
    else if (s === 'alt' || s === 'option') m.alt = true;
    else if (s === 'super' || s === 'cmd' || s === 'meta') m.super = true;
  }
  return m;
}

function ensureVisible(w) {
  if (w.visible || w.type === 'window' || !w.imgui_id) return w;
  if (state.M._studio_scroll_into_view(parseInt(w.imgui_id, 16) >>> 0)) {
    step(3, DT, false);
    try {
      return resolveWidget(w.id);
    } catch {
      return w;
    }
  }
  return w;
}

function pointFor(p, { allowEnsureVisible = true } = {}) {
  if (p.id != null && p.id !== '') {
    let w = resolveWidget(p.id);
    if (allowEnsureVisible && p.ensure_visible !== false) w = ensureVisible(w);
    if (!w.visible && w.type !== 'window') throw rpcError('widget_not_visible', `Widget "${w.id}" is not visible (clipped, scrolled out or its window is hidden)`, { widget: w });
    const b = boundsOf(w);
    const off = Array.isArray(p.offset) ? p.offset : [0.5, 0.5];
    return { x: b.x + b.width * off[0], y: b.y + b.height * off[1], widget: w };
  }
  if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y, widget: null };
  throw rpcError('bad_request', 'Provide a widget "id" or "x"/"y" coordinates');
}

function afterState(w) {
  if (!w) return null;
  try {
    const now = resolveWidget(w.id);
    return { id: now.id, type: now.type, bounds: now.bounds, visible: now.visible, state: now.state };
  } catch {
    return { id: w.id, gone: true };
  }
}

function summary(w) {
  if (!w) return null;
  return { id: w.id, type: w.type, label: w.label, bounds: w.bounds, state: w.state };
}

function pressKey(name, modifiers) {
  const code = keyCode(name);
  const m = parseModifiers(modifiers);
  input.mods(m);
  if (code && !input.key(code, true)) throw rpcError('bad_request', `Unknown key "${name}"`);
  step(1, DT, false);
  if (code) input.key(code, false);
  step(1, DT, false);
  input.mods({});
  step(1, DT, false);
}

const KEY_ALIASES = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace',
  delete: 'Delete', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert', ctrl: 'ControlLeft',
  shift: 'ShiftLeft', alt: 'AltLeft',
};

function keyCode(name) {
  if (!name) return null;
  const s = String(name);
  if (KEY_ALIASES[s.toLowerCase()]) return KEY_ALIASES[s.toLowerCase()];
  if (/^[a-z]$/i.test(s)) return `Key${s.toUpperCase()}`;
  if (/^[0-9]$/.test(s)) return `Digit${s}`;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(s)) return s.toUpperCase();
  return s;
}

function clickAt(x, y, button, modifiers, double) {
  const m = parseModifiers(modifiers);
  input.move(x, y);
  input.mods(m);
  step(1, DT, false);
  const clicks = double ? 2 : 1;
  for (let i = 0; i < clicks; i++) {
    input.button(button, true);
    step(1, DT, false);
    input.button(button, false);
    step(1, DT, false);
  }
  if (m.ctrl || m.shift || m.alt || m.super) {
    input.mods({});
    step(1, DT, false);
  }
}

function parseValue(v) {
  if (typeof v === 'boolean') return { nums: [v ? 1 : 0] };
  if (typeof v === 'number') return { nums: [v] };
  if (Array.isArray(v)) return { nums: v.slice(0, 4).map(Number) };
  if (typeof v === 'string') {
    const hex = v.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return { nums: [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, hex[2] ? parseInt(hex[2], 16) / 255 : 1], text: v };
    }
    return { text: v };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function encodePng(bytes, w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, w * h * 4), w, h), 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

function regionFor(p, snap) {
  const vw = state.viewport.width;
  const vh = state.viewport.height;
  let r = { x: 0, y: 0, width: vw, height: vh };
  let widget = null;
  if (p.region) {
    r = { x: Number(p.region.x) || 0, y: Number(p.region.y) || 0, width: Number(p.region.width) || vw, height: Number(p.region.height) || vh };
  } else if (p.id || p.widget || p.window) {
    widget = resolveWidget(p.id || p.widget || p.window, snap);
    r = { ...widget.bounds };
  }
  const pad = Number(p.padding) || 0;
  r = { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(vw, Math.ceil(r.x + r.width));
  const y1 = Math.min(vh, Math.ceil(r.y + r.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) throw rpcError('empty_region', 'The capture region is outside the viewport', { region: r });
  return { region: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, widget };
}

async function readRegion(region) {
  const s = state.viewport.scale;
  const fx = Math.round(region.x * s);
  const fy = Math.round(region.y * s);
  const fw = Math.max(1, Math.round(region.width * s));
  const fh = Math.max(1, Math.round(region.height * s));
  const M = state.M;
  M._studio_present();
  const ptr = M._studio_read_pixels(fx, fy, fw, fh);
  if (!ptr) throw rpcError('capture_failed', 'glReadPixels failed');
  const bytes = M.HEAPU8.slice(ptr, ptr + fw * fh * 4);
  M._studio_free(ptr);
  return { png: await encodePng(bytes, fw, fh), width: fw, height: fh };
}

function captureMeta(extra = {}) {
  return {
    build_id: state.buildId,
    role: ROLE,
    viewport: { ...state.viewport },
    frame: state.frames,
    time_s: round(state.time, 4),
    mouse: state.mouse ? state.mouse.map((v) => round(v, 1)) : null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// RPC methods
// ---------------------------------------------------------------------------

const methods = {
  async info() {
    return {
      role: ROLE,
      build_id: state.buildId,
      ready: state.ready,
      crashed: state.crashed,
      viewport: state.viewport,
      frame: state.frames,
      time_s: round(state.time, 4),
      paused: state.paused,
      errors: state.errors.slice(-20).map(({ key, ...e }) => e),
      project: state.config ? state.config.project : null,
    };
  },

  async errors({ clear = false } = {}) {
    const errors = state.errors.map(({ key, ...e }) => e);
    const logs = state.logs.slice(-100);
    if (clear) {
      state.errors = [];
      state.errorCounts.clear();
    }
    return { errors, logs, crashed: state.crashed };
  },

  async frame_info() {
    return frameInfo();
  },

  async widgets(p) {
    const snap = snapshot();
    const list = filterWidgets(snap, p);
    const limit = Number(p.limit) || 400;
    const compact = p.compact !== false;
    return {
      frame: snap.frame,
      time_s: round(snap.time, 4),
      viewport: state.viewport,
      count: list.length,
      truncated: list.length > limit,
      widgets: list.slice(0, limit).map((w) => (compact ? compactWidget(w) : w)),
      windows: snap.windows,
    };
  },

  async inspect({ id }) {
    const w = resolveWidget(id);
    return { widget: w, frame: frameInfo() };
  },

  async widget_at({ x, y }) {
    return { widget: widgetAt(Number(x), Number(y)) };
  },

  async click(p) {
    return exclusive(async () => {
      const t = pointFor(p);
      const before = summary(t.widget);
      clickAt(t.x, t.y, Number(p.button) || 0, p.modifiers, !!p.double);
      settle(p.settle_ms ?? 300);
      if (p.move_away) {
        input.leave();
        step(1);
      }
      return { clicked: { x: round(t.x, 1), y: round(t.y, 1) }, before, after: afterState(t.widget), errors: recentErrors() };
    });
  },

  async hover(p) {
    return exclusive(async () => {
      const t = pointFor(p);
      input.move(t.x, t.y);
      settle(p.settle_ms ?? 300);
      return { hovered: { x: round(t.x, 1), y: round(t.y, 1) }, after: afterState(t.widget), errors: recentErrors() };
    });
  },

  async mouse_leave(p) {
    return exclusive(async () => {
      input.leave();
      settle(p.settle_ms ?? 300);
      return { ok: true };
    });
  },

  async drag(p) {
    return exclusive(async () => {
      const from = p.from ? { x: p.from[0], y: p.from[1], widget: null } : pointFor({ ...p, offset: p.from_offset || p.offset });
      let to;
      const w = from.widget;
      if (typeof p.to === 'number' && w) {
        const b = boundsOf(w);
        to = { x: b.x + b.width * Math.max(0, Math.min(1, p.to)), y: from.y };
      } else if (Array.isArray(p.to)) {
        to = { x: Number(p.to[0]), y: Number(p.to[1]) };
      } else if (Array.isArray(p.by)) {
        to = { x: from.x + Number(p.by[0]), y: from.y + Number(p.by[1]) };
      } else {
        throw rpcError('bad_request', 'drag needs "to" (0..1 fraction across the widget, or [x,y]) or "by" ([dx,dy])');
      }
      const steps = Math.max(1, Math.min(120, Number(p.steps) || 10));
      input.move(from.x, from.y);
      step(1, DT, false);
      input.button(0, true);
      step(1, DT, false);
      for (let i = 1; i <= steps; i++) {
        input.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
        step(1, DT, false);
      }
      input.button(0, false);
      step(1, DT, false);
      settle(p.settle_ms ?? 300);
      return { from: [round(from.x, 1), round(from.y, 1)], to: [round(to.x, 1), round(to.y, 1)], before: summary(w), after: afterState(w), errors: recentErrors() };
    });
  },

  async scroll(p) {
    return exclusive(async () => {
      const t = pointFor({ ...p, ensure_visible: false });
      input.move(t.x, t.y);
      step(1, DT, false);
      const dy = p.dy != null ? Number(p.dy) : -1;
      const dx = Number(p.dx) || 0;
      const notches = Math.max(1, Math.min(50, Math.round(Math.abs(dy) || Math.abs(dx) || 1)));
      for (let i = 0; i < notches; i++) {
        input.wheel(dx / notches, dy / notches);
        step(1, DT, false);
      }
      settle(p.settle_ms ?? 300);
      const snap = snapshot();
      const winName = t.widget ? t.widget.window : null;
      const win = winName ? snap.windows.find((w) => w.name === winName) : null;
      return { at: [round(t.x, 1), round(t.y, 1)], window: win ? { name: win.name, scroll: win.scroll, scroll_max: win.scroll_max } : null };
    });
  },

  async set_value(p) {
    return exclusive(async () => {
      const w = resolveWidget(p.id);
      const v = parseValue(p.value);
      if (w.settable) {
        const idNum = parseInt(w.imgui_id, 16) >>> 0;
        if (w.value_type === 'text') {
          withString(String(v.text ?? p.value), (ptr) => state.M._studio_set_value_text(idNum, ptr));
        } else {
          const n = v.nums;
          if (!n || !n.length || n.some((x) => !Number.isFinite(x))) throw rpcError('bad_value', `Widget "${w.id}" expects a ${w.value_type} value`);
          state.M._studio_set_value_numbers(idNum, n.length, n[0] || 0, n[1] || 0, n[2] || 0, n[3] || 0);
        }
        step(2, DT, false);
        settle(p.settle_ms ?? 300);
        return { method: 'binding', before: summary(w), after: afterState(w), errors: recentErrors() };
      }
      if (w.text_input) {
        // Ctrl+Click turns sliders/drags into text input; InputText accepts it directly.
        const t = pointFor({ id: w.id });
        clickAt(t.x, t.y, 0, w.type === 'input' ? ['ctrl'] : [], false);
        step(2, DT, false);
        input.mods({ ctrl: true });
        input.key('KeyA', true);
        step(1, DT, false);
        input.key('KeyA', false);
        input.mods({});
        step(1, DT, false);
        input.chars(String(v.text ?? p.value));
        step(2, DT, false);
        pressKey('Enter');
        settle(p.settle_ms ?? 300);
        return { method: 'keyboard', before: summary(w), after: afterState(w), errors: recentErrors() };
      }
      throw rpcError('not_settable', `Widget "${w.id}" has no bound value. Add STUDIO_BIND(&value) after the widget, or use ui_click_widget / ui_drag_widget.`, { widget: summary(w) });
    });
  },

  async key(p) {
    return exclusive(async () => {
      pressKey(p.key, p.modifiers);
      settle(p.settle_ms ?? 150);
      return { ok: true, key: p.key, errors: recentErrors() };
    });
  },

  async type_text(p) {
    return exclusive(async () => {
      if (p.id) {
        const t = pointFor({ id: p.id });
        clickAt(t.x, t.y, 0, [], false);
        step(2, DT, false);
      }
      for (const ch of String(p.text || '')) {
        input.chars(ch);
        step(1, DT, false);
      }
      if (p.submit) pressKey('Enter');
      settle(p.settle_ms ?? 150);
      return { ok: true, typed: String(p.text || '').length, errors: recentErrors() };
    });
  },

  async wait(p) {
    return exclusive(async () => {
      settle(Number(p.ms) || 0);
      return { time_s: round(state.time, 4), frame: state.frames };
    });
  },

  async capture(p) {
    return exclusive(async () => {
      if (p.settle_ms) settle(p.settle_ms);
      const snap = snapshot();
      const { region, widget } = regionFor(p, snap);
      const img = await readRegion(region);
      const hovered = snap.widgets.find((w) => w.state && w.state.hovered);
      const active = snap.widgets.find((w) => w.state && w.state.active);
      return {
        ...img,
        region,
        widget: widget ? summary(widget) : null,
        meta: captureMeta({ hovered: hovered ? hovered.id : null, active: active ? active.id : null }),
      };
    });
  },

  // Deterministic animation capture: evaluate the UI at explicit times after an action.
  async capture_animation(p) {
    return exclusive(async () => {
      const frames = Math.max(2, Math.min(48, Number(p.frames) || 8));
      const duration = Math.max(1, Math.min(10000, Number(p.duration_ms ?? p.duration) || 300));
      const interval = duration / (frames - 1) / 1000;
      const sub = Math.max(1, Math.ceil(interval / DT - 1e-9));
      const dt = interval / sub;
      const action = String(p.action || (p.id ? 'click' : 'none')).toLowerCase();
      const target = p.id ? pointFor({ id: p.id, offset: p.offset }) : typeof p.x === 'number' ? { x: p.x, y: p.y, widget: null } : null;
      if (action !== 'none' && action !== 'set_value' && action !== 'key' && !target) throw rpcError('bad_request', `action "${action}" needs a widget id or x/y`);
      const pre = Number(p.pre_settle_ms ?? 400);

      // Prepare the starting state.
      if (action === 'hover') {
        input.leave();
        settle(pre);
      } else if (['click', 'toggle', 'unhover', 'press', 'release', 'double_click'].includes(action)) {
        input.move(target.x, target.y);
        settle(pre);
      } else if (pre > 0 && action !== 'none') {
        settle(pre);
      }
      if (action === 'release') {
        input.button(0, true);
        settle(pre);
      }

      // Trigger: the frame that processes the triggering input is t = 0.
      const trigger = () => {
        switch (action) {
          case 'click':
          case 'toggle':
            input.button(0, true);
            frame(dt, false);
            input.button(0, false);
            break;
          case 'double_click':
            input.button(0, true);
            frame(dt, false);
            input.button(0, false);
            frame(dt, false);
            input.button(0, true);
            frame(dt, false);
            input.button(0, false);
            break;
          case 'hover':
            input.move(target.x, target.y);
            break;
          case 'unhover':
            input.leave();
            break;
          case 'press':
            input.button(0, true);
            break;
          case 'release':
            input.button(0, false);
            break;
          case 'set_value': {
            const w = resolveWidget(p.id);
            const v = parseValue(p.value);
            const idNum = parseInt(w.imgui_id, 16) >>> 0;
            if (!w.settable) throw rpcError('not_settable', `Widget "${w.id}" has no bound value`);
            if (w.value_type === 'text') withString(String(v.text ?? p.value), (ptr) => state.M._studio_set_value_text(idNum, ptr));
            else state.M._studio_set_value_numbers(idNum, v.nums.length, v.nums[0] || 0, v.nums[1] || 0, v.nums[2] || 0, v.nums[3] || 0);
            break;
          }
          case 'key': {
            const code = keyCode(p.key);
            input.key(code, true);
            frame(dt, false);
            input.key(code, false);
            break;
          }
          default:
            break;
        }
      };
      trigger();
      frame(dt, true);

      const snap0 = snapshot();
      const regionParams = p.region ? { region: p.region, padding: p.padding } : p.capture_widget || p.id ? { id: p.capture_widget || p.id, padding: p.padding ?? 12 } : {};
      if (p.full_frame) delete regionParams.id;
      const { region } = regionFor(regionParams.id || regionParams.region ? regionParams : {}, snap0);
      const track = p.id ? p.id : null;
      const out = [];
      for (let i = 0; i < frames; i++) {
        if (i > 0) step(sub, dt, true);
        const img = await readRegion(region);
        let st = null;
        if (track) {
          try {
            const w = resolveWidget(track);
            st = { ...w.state, bounds: w.bounds };
          } catch {
            st = null;
          }
        }
        out.push({ t_ms: round((i * duration) / (frames - 1), 2), png: img.png, width: img.width, height: img.height, state: st });
      }
      if (action === 'press') {
        input.button(0, false);
        step(2);
      }
      return {
        action,
        widget: target && target.widget ? summary(target.widget) : null,
        duration_ms: duration,
        frames: out,
        region,
        timestep_ms: round(dt * 1000, 3),
        substeps_per_frame: sub,
        meta: captureMeta(),
        errors: recentErrors(),
      };
    });
  },

  async set_viewport(p) {
    return exclusive(async () => {
      state.viewport = {
        width: Math.max(64, Math.min(4096, Number(p.width) || state.viewport.width)),
        height: Math.max(64, Math.min(4096, Number(p.height) || state.viewport.height)),
        scale: Number(p.scale) || state.viewport.scale,
      };
      state.M._studio_set_viewport(state.viewport.width, state.viewport.height, state.viewport.scale);
      applyCanvasSize();
      step(3);
      return { viewport: state.viewport };
    });
  },

  // --- Studio UI helpers (visible preview only) ---
  async set_paused({ paused }) {
    state.paused = !!paused;
    return { paused: state.paused };
  },

  async step_frames({ frames = 1 }) {
    return exclusive(async () => {
      step(Math.max(1, Math.min(600, Number(frames) || 1)));
      return { frame: state.frames, time_s: round(state.time, 4) };
    });
  },

  async set_time_scale({ scale = 1 }) {
    state.timeScale = Math.max(0.05, Math.min(4, Number(scale) || 1));
    return { time_scale: state.timeScale };
  },

  async set_zoom({ zoom }) {
    state.zoom = zoom === 'fit' ? 'fit' : Number(zoom) || 1;
    layoutStage();
    return { zoom: state.zoom, css_scale: state.cssScale };
  },

  async set_inspect({ enabled }) {
    state.inspect = !!enabled;
    if (!state.inspect) {
      state.hoverWidget = null;
      renderHighlights();
    }
    canvas.style.cursor = state.inspect ? 'crosshair' : 'default';
    state.cursor = -2;
    return { inspect: state.inspect };
  },

  async highlight({ ids = [], selected = null }) {
    state.highlights = ids;
    if (selected !== undefined) state.selected = selected;
    renderHighlights();
    return { ok: true };
  },

  async set_overlay({ url = null, opacity = 0.5, blend = 'normal', visible = true }) {
    if (!url || !visible) {
      refImg.hidden = true;
      refImg.removeAttribute('src');
    } else {
      if (refImg.getAttribute('src') !== url) refImg.src = url;
      refImg.hidden = false;
      refImg.style.opacity = String(opacity);
      refImg.style.mixBlendMode = blend === 'difference' ? 'difference' : 'normal';
    }
    return { ok: true };
  },

  async set_guides({ grid = 0, color = 'rgba(77,163,255,0.18)' }) {
    const g = Number(grid) || 0;
    guidesEl.hidden = g <= 0;
    if (g > 0) {
      guidesEl.style.backgroundImage = `linear-gradient(to right, ${color} 1px, transparent 1px), linear-gradient(to bottom, ${color} 1px, transparent 1px)`;
      guidesEl.style.backgroundSize = `${g}px ${g}px`;
    }
    return { grid: g };
  },
};

function recentErrors() {
  return state.errors.slice(-5).map(({ key, ...e }) => e);
}

function compactWidget(w) {
  const out = { id: w.id, type: w.type, label: w.label, bounds: w.bounds, state: w.state };
  if (w.visible_bounds) out.visible_bounds = w.visible_bounds;
  if (!w.visible) out.visible = false;
  if (w.value_type) out.value_type = w.value_type;
  if (w.source) out.source = w.source;
  if (w.window) out.window = w.window;
  return out;
}

async function handleRpc(method, params) {
  const fn = methods[method];
  if (!fn) return { ok: false, error: { code: 'unknown_method', message: `Unknown runtime method: ${method}` } };
  if (!['info', 'errors', 'set_zoom', 'set_overlay', 'set_guides', 'set_inspect', 'highlight', 'set_paused', 'set_time_scale'].includes(method)) {
    if (!state.ready) {
      return {
        ok: false,
        error: {
          code: state.crashed ? 'runtime_crashed' : 'runtime_not_ready',
          message: state.crashed ? `The application crashed: ${state.crashed.message}` : 'The preview runtime is not ready yet',
          details: { errors: recentErrors() },
        },
      };
    }
  }
  try {
    const result = await fn(params);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: { code: e.code || 'runtime_error', message: e.message, details: e.details } };
  }
}

// ---------------------------------------------------------------------------
// Inspector overlay (visible preview)
// ---------------------------------------------------------------------------

function updateInspectHover() {
  if (!state.hoverPoint) return;
  const w = widgetAt(state.hoverPoint[0], state.hoverPoint[1]);
  const id = w ? w.id : null;
  if (id !== (state.hoverWidget && state.hoverWidget.id)) {
    state.hoverWidget = w;
    renderHighlights();
    postParent({ type: 'event', name: 'inspect_hover', data: w });
  }
}

function renderHighlights() {
  overlay.innerHTML = '';
  if (!state.ready) return;
  let snap;
  try {
    snap = snapshot();
  } catch {
    return;
  }
  const ids = new Set(state.highlights || []);
  if (state.hoverWidget) ids.add(state.hoverWidget.id);
  const inv = 1 / (state.cssScale || 1);
  for (const id of ids) {
    const w = snap.widgets.find((x) => x.id === id) || snap.windows.find((x) => x.id === id);
    if (!w) continue;
    addBox(w, id === state.selected, inv);
  }
  if (state.selected && !ids.has(state.selected)) {
    const w = snap.widgets.find((x) => x.id === state.selected);
    if (w) addBox(w, true, inv);
  }
}

function addBox(w, selected, inv) {
  const b = w.bounds;
  const box = document.createElement('div');
  box.className = `hl-box${selected ? ' selected' : ''}`;
  box.style.left = `${b.x}px`;
  box.style.top = `${b.y}px`;
  box.style.width = `${Math.max(1, b.width)}px`;
  box.style.height = `${Math.max(1, b.height)}px`;
  box.style.borderWidth = `${inv}px`;
  const label = document.createElement('div');
  label.className = `hl-label${b.y < 20 ? ' below' : ''}`;
  if (b.y < 20) label.style.top = `${b.height}px`;
  label.style.fontSize = `${11 * inv}px`;
  label.style.lineHeight = `${16 * inv}px`;
  label.textContent = `${w.id}  ${Math.round(b.width)}×${Math.round(b.height)}`;
  box.appendChild(label);
  overlay.appendChild(box);
}

window.__studio = { state, methods, handleRpc };

boot();
