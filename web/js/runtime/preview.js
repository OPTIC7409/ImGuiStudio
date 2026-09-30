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
const layer = document.getElementById('inspect-layer');
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
  inspect: false, // inspect mode: the mouse picks widgets instead of driving the UI
  peek: false, // Alt held in interact mode: inspect temporarily
  outlines: false, // draw every widget's bounds
  hoverPoint: null,
  hoverWidget: null,
  selected: null,
  highlights: [], // "linked" widgets: hovered in the inspector list or under the editor cursor
  pick: null, // { x, y, stack, index } for click-again-to-select-the-container
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
  requestOverlay();
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
  if ((state.inspect || state.peek) && state.hoverPoint) updateInspectHover();
  if (overlayWanted()) requestOverlay();
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
  if (state.inspect || state.peek) {
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
  const picking = (e) => state.inspect || e.altKey;
  let downForwarded = false;
  canvas.addEventListener('mousemove', (e) => {
    const [x, y] = canvasPoint(e);
    const wasPeek = state.peek;
    state.peek = !state.inspect && e.altKey;
    if (picking(e)) {
      state.hoverPoint = [x, y];
      updateInspectHover();
      return;
    }
    if (wasPeek) clearHover();
    if (state.ready) input.move(x, y);
  });
  canvas.addEventListener('mouseleave', () => {
    state.hoverPoint = null;
    state.peek = false;
    clearHover();
    if (!state.inspect && state.ready) input.leave();
  });
  canvas.addEventListener('mousedown', (e) => {
    canvas.focus();
    if (!state.ready) return;
    if (picking(e)) {
      // The second press of a double-click belongs to the dblclick (open code).
      if (e.detail < 2) pickAt(...canvasPoint(e), e.shiftKey);
      e.preventDefault();
      return;
    }
    input.mods(mods(e));
    input.button(e.button === 2 ? 1 : e.button === 1 ? 2 : 0, true);
    downForwarded = true;
    e.preventDefault();
  });
  window.addEventListener('mouseup', (e) => {
    if (!state.ready || !downForwarded) return;
    downForwarded = false;
    input.button(e.button === 2 ? 1 : e.button === 1 ? 2 : 0, false);
  });
  canvas.addEventListener('dblclick', (e) => {
    if (!state.ready || !picking(e) || !state.selected) return;
    openSelected();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!state.ready) return;
      const unit = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100;
      // Scrolling works while inspecting: the UI needs the mouse position to know what to scroll.
      if (picking(e)) input.move(...canvasPoint(e));
      input.wheel(-e.deltaX / unit, -e.deltaY / unit);
      e.preventDefault();
    },
    { passive: false },
  );
  canvas.addEventListener('keydown', (e) => {
    if (!state.ready) return;
    // Ctrl/Cmd+Shift+C toggles inspect mode (as in browser dev tools).
    if (e.code === 'KeyC' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
      setInspect(!state.inspect);
      postParent({ type: 'event', name: 'inspect_mode', data: { enabled: state.inspect } });
      e.preventDefault();
      return;
    }
    if (state.inspect) {
      if (e.key === 'Escape') selectWidget(null);
      else if (e.key === 'Enter') openSelected();
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') stepSelection(e.key === 'ArrowUp' ? 1 : -1);
      e.preventDefault();
      return;
    }
    if (e.key === 'Alt') return;
    input.mods(mods(e));
    input.key(e.code, true);
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) input.chars(e.key);
    if (!(e.metaKey && ['KeyR', 'KeyL'].includes(e.code))) e.preventDefault();
  });
  canvas.addEventListener('keyup', (e) => {
    if (!state.ready) return;
    if (e.key === 'Alt' && state.peek) {
      state.peek = false;
      clearHover();
    }
    if (state.inspect) return;
    input.mods(mods(e));
    input.key(e.code, false);
    e.preventDefault();
  });
  window.addEventListener('blur', () => {
    if (state.peek) {
      state.peek = false;
      clearHover();
    }
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
    setInspect(enabled);
    return { inspect: state.inspect };
  },

  async set_outlines({ enabled }) {
    state.outlines = !!enabled;
    requestOverlay();
    return { outlines: state.outlines };
  },

  // ids: widgets to show as linked (inspector list hover, editor cursor); selected: the selection.
  async highlight({ ids, selected }) {
    if (ids !== undefined) state.highlights = ids || [];
    if (selected !== undefined) {
      if (selected !== state.selected) state.pick = null;
      state.selected = selected;
    }
    requestOverlay();
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
  if (!['info', 'errors', 'set_zoom', 'set_overlay', 'set_guides', 'set_inspect', 'set_outlines', 'highlight', 'set_paused', 'set_time_scale'].includes(method)) {
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
//
// Drawn on a screen-space canvas above the stage, so lines and labels stay crisp at
// any zoom. Hover (inspect mode, or Alt held in interact mode) shows the widget under
// the mouse and its container; the selection persists while interacting; hovering
// another widget while one is selected measures the distance between them.
// ---------------------------------------------------------------------------

const OVERLAY = {
  hover: '#4da3ff',
  hoverFill: 'rgba(77,163,255,0.12)',
  hoverChip: '#1e6fd9',
  select: '#ffb547',
  selectFill: 'rgba(255,181,71,0.10)',
  selectChip: '#c7831b',
  linkedFill: 'rgba(77,163,255,0.07)',
  container: 'rgba(176,186,206,0.8)',
  measure: '#ff4d6d',
  outline: 'rgba(120,200,255,0.32)',
  outlineRegion: 'rgba(255,190,110,0.5)',
  outlineWindow: 'rgba(190,150,255,0.45)',
  font: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

let snapCache = { key: null, snap: null };
function overlaySnapshot() {
  if (!state.ready || state.crashed || !state.M) return null;
  const key = `${state.buildId}:${state.frames}`;
  if (snapCache.key === key && snapCache.snap) return snapCache.snap;
  try {
    snapCache = { key, snap: snapshot() };
  } catch {
    return null;
  }
  return snapCache.snap;
}

function findWidget(snap, id) {
  return id ? snap.widgets.find((w) => w.id === id) || null : null;
}

function setInspect(enabled) {
  state.inspect = !!enabled;
  if (!state.inspect) clearHover();
  state.cursor = -2;
  canvas.style.cursor = state.inspect ? 'crosshair' : 'default';
  requestOverlay();
}

function clearHover(notify = true) {
  const had = !!state.hoverWidget;
  state.hoverWidget = null;
  requestOverlay();
  if (had && notify) postParent({ type: 'event', name: 'inspect_hover', data: null });
}

function updateInspectHover() {
  if (!state.hoverPoint) return;
  const w = widgetAt(state.hoverPoint[0], state.hoverPoint[1], overlaySnapshot() || undefined);
  const changed = (w && w.id) !== (state.hoverWidget && state.hoverWidget.id);
  state.hoverWidget = w;
  if (changed) postParent({ type: 'event', name: 'inspect_hover', data: w });
  requestOverlay();
}

const areaOf = (w) => boundsOf(w).width * boundsOf(w).height;
const contains = (o, i) => o.x <= i.x && o.y <= i.y && o.x + o.width >= i.x + i.width && o.y + o.height >= i.y + i.height;

// Everything under a point, innermost first: the widget, then its regions and child windows.
function stackAt(x, y, snap) {
  const top = widgetAt(x, y, snap);
  const root = top ? top.window.split('/')[0] : null;
  const inside = (b) => x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
  const list = snap.widgets
    .filter((w) => w.visible && inside(boundsOf(w)) && (!root || (w.window || '').split('/')[0] === root || w.id === root))
    .sort((a, b) => areaOf(a) - areaOf(b) || (a.anonymous ? 1 : 0) - (b.anonymous ? 1 : 0));
  const seen = new Set();
  const out = [];
  for (const w of list) {
    const b = boundsOf(w);
    const k = `${b.x},${b.y},${b.width},${b.height}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  if (top) {
    const i = out.findIndex((w) => w.id === top.id);
    if (i !== 0) {
      if (i > 0) out.splice(i, 1);
      out.unshift(top);
    }
  }
  return out;
}

// Click selects the innermost widget under the mouse. Shift+click selects its
// container, and each further Shift+click at that spot walks one level further out.
function pickAt(x, y, outward = false) {
  const snap = overlaySnapshot();
  if (!snap) return;
  const p = state.pick;
  if (outward && p && Math.abs(p.x - x) < 4 && Math.abs(p.y - y) < 4 && p.stack.length > 1 && state.selected === p.stack[p.index].id) {
    p.index = Math.min(p.stack.length - 1, p.index + 1);
    selectWidget(p.stack[p.index]);
    return;
  }
  const stack = stackAt(x, y, snap);
  const index = outward && stack.length > 1 ? 1 : 0;
  state.pick = { x, y, stack, index };
  selectWidget(stack[index] || null);
}

function selectWidget(w) {
  state.selected = w ? w.id : null;
  if (!w) state.pick = null;
  requestOverlay();
  postParent({ type: 'event', name: 'inspect_select', data: w });
}

// ArrowUp: select the container; ArrowDown: back towards the innermost widget.
function stepSelection(dir) {
  const snap = overlaySnapshot();
  const sel = snap && findWidget(snap, state.selected);
  if (!sel) return;
  let p = state.pick;
  if (!p || p.stack[p.index]?.id !== sel.id) {
    const b = boundsOf(sel);
    const stack = stackAt(b.x + b.width / 2, b.y + b.height / 2, snap);
    const i = stack.findIndex((w) => w.id === sel.id);
    p = state.pick = { x: -1, y: -1, stack: i >= 0 ? stack : [sel, ...stack], index: Math.max(0, i) };
  }
  p.index = Math.max(0, Math.min(p.stack.length - 1, p.index + dir));
  selectWidget(p.stack[p.index]);
}

function openSelected() {
  const snap = overlaySnapshot();
  const w = snap && findWidget(snap, state.selected);
  if (w) postParent({ type: 'event', name: 'inspect_open', data: w });
}

// Smallest region or child window that contains the widget.
function containerOf(snap, w) {
  const b = boundsOf(w);
  let best = null;
  for (const c of snap.widgets) {
    if (c.id === w.id || !c.visible || (c.type !== 'region' && c.type !== 'window')) continue;
    const cb = boundsOf(c);
    if (!contains(cb, b) || areaOf(c) <= b.width * b.height) continue;
    if (!best || areaOf(c) < areaOf(best)) best = c;
  }
  return best;
}

function overlayWanted() {
  return state.outlines || !!state.selected || !!state.hoverWidget || state.highlights.length > 0;
}

let overlayQueued = false;
function requestOverlay() {
  if (overlayQueued || ROLE !== 'studio') return;
  overlayQueued = true;
  requestAnimationFrame(() => {
    overlayQueued = false;
    drawOverlay();
  });
}

function drawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (layer.width !== Math.round(vw * dpr) || layer.height !== Math.round(vh * dpr)) {
    layer.width = Math.round(vw * dpr);
    layer.height = Math.round(vh * dpr);
  }
  const ctx = layer.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);
  if (!overlayWanted()) return;
  const snap = overlaySnapshot();
  if (!snap) return;
  const r = canvas.getBoundingClientRect();
  const s = r.width / state.viewport.width;
  const g = {
    ctx,
    dpr,
    vw,
    vh,
    scr: (b) => ({ x: r.left + b.x * s, y: r.top + b.y * s, w: b.width * s, h: b.height * s }),
    pt: (x, y) => [r.left + x * s, r.top + y * s],
  };
  if (state.outlines) drawOutlines(g, snap);
  const sel = findWidget(snap, state.selected);
  const hov = state.hoverWidget ? findWidget(snap, state.hoverWidget.id) || state.hoverWidget : null;
  for (const id of state.highlights) {
    const w = findWidget(snap, id);
    if (w && w.visible && id !== state.selected && (!hov || id !== hov.id)) drawBox(g, w, 'linked');
  }
  if (hov) {
    const c = containerOf(snap, hov);
    if (c && (!sel || c.id !== sel.id)) drawContainer(g, c);
  }
  if (sel && sel.visible) drawBox(g, sel, 'selected');
  if (hov && (!sel || hov.id !== sel.id)) drawBox(g, hov, 'hover');
  if (sel && sel.visible && hov && sel.id !== hov.id) drawMeasure(g, boundsOf(sel), boundsOf(hov));
}

const fmtPx = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
const snapPx = (g, v) => Math.round(v * g.dpr) / g.dpr;

// Stroke inside the rectangle, aligned to device pixels.
function strokeBox(g, q, lw) {
  const x = snapPx(g, q.x);
  const y = snapPx(g, q.y);
  const w = snapPx(g, q.x + q.w) - x;
  const h = snapPx(g, q.y + q.h) - y;
  g.ctx.lineWidth = lw;
  g.ctx.strokeRect(x + lw / 2, y + lw / 2, Math.max(0, w - lw), Math.max(0, h - lw));
}

function prettyName(w) {
  if (w.type !== 'window') return w.id;
  const last = String(w.label || w.id).split('/').pop();
  return last.replace(/^#+/, '').replace(/_[0-9A-F]{8}$/, '') || w.id;
}

// A label chip: [type] id  W×H, above the box (below when there is no room).
function chip(g, q, parts, bg, below = false) {
  const { ctx } = g;
  ctx.font = `600 11px ${OVERLAY.font}`;
  const pad = 5;
  const widths = parts.map((p) => {
    ctx.font = `${p.bold ? 600 : 400} 11px ${OVERLAY.font}`;
    return ctx.measureText(p.text).width;
  });
  const gap = 6;
  const w = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1) + pad * 2;
  const h = 17;
  const x = Math.min(Math.max(2, q.x), g.vw - w - 2);
  const above = q.y - h - 2;
  const under = q.y + q.h + 2;
  let y = below ? (under + h <= g.vh - 2 ? under : above) : above >= 2 ? above : under;
  if (y < 2 || y + h > g.vh - 2) y = Math.max(2, Math.min(g.vh - h - 2, q.y + 2));
  ctx.fillStyle = bg;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 3);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  let cx = x + pad;
  parts.forEach((p, i) => {
    ctx.font = `${p.bold ? 600 : 400} 11px ${OVERLAY.font}`;
    ctx.fillStyle = p.color || '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.text, cx, y + h / 2 + 0.5);
    cx += widths[i] + gap;
  });
}

function drawBox(g, w, kind) {
  const { ctx } = g;
  const b = boundsOf(w);
  const q = g.scr(b);
  ctx.save();
  // Tint small boxes only: a tinted window or panel would hide the colours being judged.
  if (q.w * q.h < 0.15 * g.vw * g.vh) {
    ctx.fillStyle = kind === 'selected' ? OVERLAY.selectFill : kind === 'hover' ? OVERLAY.hoverFill : OVERLAY.linkedFill;
    ctx.fillRect(q.x, q.y, q.w, q.h);
  }
  ctx.strokeStyle = kind === 'selected' ? OVERLAY.select : OVERLAY.hover;
  if (kind === 'linked') ctx.setLineDash([4, 3]);
  strokeBox(g, q, kind === 'selected' ? 2 : 1);
  ctx.setLineDash([]);
  if (kind === 'selected') {
    ctx.fillStyle = OVERLAY.select;
    ctx.strokeStyle = '#0b0c10';
    ctx.lineWidth = 1;
    for (const [hx, hy] of [[q.x, q.y], [q.x + q.w, q.y], [q.x, q.y + q.h], [q.x + q.w, q.y + q.h]]) {
      ctx.fillRect(snapPx(g, hx) - 3, snapPx(g, hy) - 3, 6, 6);
      ctx.strokeRect(snapPx(g, hx) - 3.5, snapPx(g, hy) - 3.5, 7, 7);
    }
  }
  if (kind !== 'linked' || q.w > 40) {
    const light = kind === 'selected' ? '#2a1c05' : '#dbe9ff';
    chip(
      g,
      q,
      [
        { text: w.type || 'item', bold: true, color: kind === 'selected' ? '#1b1203' : '#fff' },
        { text: prettyName(w), color: kind === 'selected' ? '#1b1203' : '#fff' },
        { text: `${fmtPx(b.width)}×${fmtPx(b.height)}`, color: light },
      ],
      kind === 'selected' ? OVERLAY.select : OVERLAY.hoverChip,
      kind === 'selected',
    );
  }
  ctx.restore();
}

function drawContainer(g, c) {
  const { ctx } = g;
  const q = g.scr(boundsOf(c));
  ctx.save();
  ctx.strokeStyle = OVERLAY.container;
  ctx.setLineDash([3, 3]);
  strokeBox(g, q, 1);
  ctx.setLineDash([]);
  ctx.font = `10px ${OVERLAY.font}`;
  const text = `${c.type === 'window' ? 'window' : c.type} ${prettyName(c)}`;
  const tw = ctx.measureText(text).width + 8;
  // A tab above the container's top-left corner (inside it when there is no room).
  const ty = q.y - 15 >= 2 ? q.y - 15 : q.y + 1;
  ctx.fillStyle = 'rgba(11,12,16,0.88)';
  ctx.fillRect(q.x, ty, tw, 14);
  ctx.fillStyle = OVERLAY.container;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, q.x + 4, ty + 7.5);
  ctx.restore();
}

function drawOutlines(g, snap) {
  const { ctx } = g;
  ctx.save();
  for (const w of snap.widgets) {
    if (!w.visible) continue;
    const q = g.scr(boundsOf(w));
    if (w.type === 'region') {
      ctx.strokeStyle = OVERLAY.outlineRegion;
      ctx.setLineDash([3, 3]);
    } else if (w.type === 'window') {
      ctx.strokeStyle = OVERLAY.outlineWindow;
      ctx.setLineDash([6, 3]);
    } else {
      ctx.strokeStyle = OVERLAY.outline;
      ctx.setLineDash([]);
    }
    strokeBox(g, q, 1);
  }
  ctx.restore();
}

// Distances between the selection (a) and the hovered widget (b), in design pixels:
// gaps when they are apart, insets when one contains the other.
function drawMeasure(g, a, b) {
  const segs = [];
  const guides = [];
  const aR = a.x + a.width;
  const aB = a.y + a.height;
  const bR = b.x + b.width;
  const bB = b.y + b.height;
  if (contains(b, a) || contains(a, b)) {
    const [o, i] = contains(b, a) ? [b, a] : [a, b];
    const cy = i.y + i.height / 2;
    const cx = i.x + i.width / 2;
    segs.push([o.x, cy, i.x, cy], [i.x + i.width, cy, o.x + o.width, cy], [cx, o.y, cx, i.y], [cx, i.y + i.height, cx, o.y + o.height]);
  } else {
    const oy1 = Math.max(a.y, b.y);
    const oy2 = Math.min(aB, bB);
    const yMid = oy2 > oy1 ? (oy1 + oy2) / 2 : a.y + a.height / 2;
    const ox1 = Math.max(a.x, b.x);
    const ox2 = Math.min(aR, bR);
    const xMid = ox2 > ox1 ? (ox1 + ox2) / 2 : a.x + a.width / 2;
    const toB = (x, y, vertical) => {
      // Dashed guide from the end of a measurement to b when they do not overlap on that axis.
      if (vertical && (y < b.y || y > bB)) guides.push([x, y, x, y < b.y ? b.y : bB]);
      if (!vertical && (x < b.x || x > bR)) guides.push([x, y, x < b.x ? b.x : bR, y]);
    };
    if (b.x >= aR) {
      segs.push([aR, yMid, b.x, yMid]);
      toB(b.x, yMid, true);
    } else if (a.x >= bR) {
      segs.push([bR, yMid, a.x, yMid]);
      toB(bR, yMid, true);
    }
    if (b.y >= aB) {
      segs.push([xMid, aB, xMid, b.y]);
      toB(xMid, b.y, false);
    } else if (a.y >= bB) {
      segs.push([xMid, bB, xMid, a.y]);
      toB(xMid, bB, false);
    }
  }
  const { ctx } = g;
  ctx.save();
  ctx.strokeStyle = OVERLAY.measure;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  for (const [x1, y1, x2, y2] of guides) {
    const [p1x, p1y] = g.pt(x1, y1);
    const [p2x, p2y] = g.pt(x2, y2);
    ctx.beginPath();
    ctx.moveTo(snapPx(g, p1x) + 0.5 / g.dpr, snapPx(g, p1y) + 0.5 / g.dpr);
    ctx.lineTo(snapPx(g, p2x) + 0.5 / g.dpr, snapPx(g, p2y) + 0.5 / g.dpr);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const [x1, y1, x2, y2] of segs) {
    const len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
    if (len < 0.5) continue;
    const [p1x, p1y] = g.pt(x1, y1);
    const [p2x, p2y] = g.pt(x2, y2);
    const horizontal = y1 === y2;
    const o = 0.5 / g.dpr;
    ctx.beginPath();
    ctx.moveTo(snapPx(g, p1x) + o, snapPx(g, p1y) + o);
    ctx.lineTo(snapPx(g, p2x) + o, snapPx(g, p2y) + o);
    // End ticks
    for (const [px, py] of [[p1x, p1y], [p2x, p2y]]) {
      if (horizontal) {
        ctx.moveTo(snapPx(g, px) + o, py - 4);
        ctx.lineTo(snapPx(g, px) + o, py + 4);
      } else {
        ctx.moveTo(px - 4, snapPx(g, py) + o);
        ctx.lineTo(px + 4, snapPx(g, py) + o);
      }
    }
    ctx.stroke();
    const text = fmtPx(len);
    ctx.font = `600 10px ${OVERLAY.font}`;
    const tw = ctx.measureText(text).width + 8;
    const mx = (p1x + p2x) / 2;
    const my = (p1y + p2y) / 2;
    const lx = horizontal ? mx - tw / 2 : mx + 5;
    const ly = horizontal ? my + 5 : my - 7;
    ctx.fillStyle = OVERLAY.measure;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(lx, ly, tw, 14, 3);
    else ctx.rect(lx, ly, tw, 14);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx + 4, ly + 7.5);
  }
  ctx.restore();
}

window.__studio = { state, methods, handleRpc };

boot();
