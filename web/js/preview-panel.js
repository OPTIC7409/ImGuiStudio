// The visible live preview (an iframe running the same preview runtime as the agent,
// in realtime mode) and its toolbar.
import { h, toast } from './ui.js';

export function initPreview(app) {
  const frame = document.getElementById('preview-frame');
  const stats = document.getElementById('preview-stats');
  const pending = new Map();
  let nextId = 1;
  let ready = false;
  const settings = { zoom: 'fit', dpr: 1, paused: false, timeScale: 1, inspect: false, grid: false, overlay: false, opacity: 0.5, blend: 'normal', viewport: null };

  function rpc(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!frame.contentWindow) return reject(new Error('preview not loaded'));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`preview ${method} timed out`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      frame.contentWindow.postMessage({ target: 'imgui-studio-preview', type: 'rpc', id, method, params }, '*');
    });
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || msg.source !== 'imgui-studio-preview' || ev.source !== frame.contentWindow) return;
    if (msg.type === 'rpc_result') {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error?.message || 'preview error'), { code: msg.error?.code, details: msg.error?.details }));
    } else if (msg.type === 'event') {
      if (msg.name === 'ready') {
        ready = true;
        applySettings();
        app.bus.emit('preview-ready', msg.data);
      } else if (msg.name === 'stats') {
        stats.textContent = `build #${msg.data.build ?? '?'} · ${msg.data.viewport ? `${msg.data.viewport.width}×${msg.data.viewport.height} · ` : ''}${msg.data.fps} fps · t=${msg.data.time}s`;
      } else if (msg.name === 'inspect_hover') {
        app.bus.emit('inspect-hover', msg.data);
      } else if (msg.name === 'inspect_select') {
        app.bus.emit('widget-selected', msg.data);
        if (msg.data) app.bus.emit('show-right', 'inspector');
      } else if (msg.name === 'no_build') {
        stats.textContent = 'no build yet';
      }
    }
  });

  function src() {
    return `/preview.html?role=studio&zoom=${settings.zoom}&scale=${settings.dpr}`;
  }

  function reload() {
    ready = false;
    frame.src = src();
  }

  async function applySettings() {
    try {
      if (settings.viewport) await rpc('set_viewport', settings.viewport);
      await rpc('set_zoom', { zoom: settings.zoom });
      await rpc('set_paused', { paused: settings.paused });
      await rpc('set_time_scale', { scale: settings.timeScale });
      await rpc('set_inspect', { enabled: settings.inspect });
      await rpc('set_guides', { grid: settings.grid ? 8 : 0 });
      await applyOverlay();
    } catch (e) {
      console.warn(e);
    }
  }

  async function applyOverlay() {
    const ref = app.state?.references?.items?.find((r) => r.name === app.state.references.active);
    await rpc('set_overlay', { url: settings.overlay && ref ? ref.url : null, opacity: settings.opacity, blend: settings.blend, visible: settings.overlay });
  }

  // Toolbar
  const vpSelect = document.getElementById('vp-select');
  function fillViewports() {
    const cfg = app.state?.config?.viewport || { width: 1280, height: 800 };
    const presets = [[cfg.width, cfg.height, 'project'], [1920, 1080], [1600, 900], [1280, 800], [1280, 720], [1024, 768], [800, 600], [640, 480]];
    vpSelect.innerHTML = '';
    const seen = new Set();
    for (const [w, hh, tag] of presets) {
      const key = `${w}x${hh}`;
      if (seen.has(key)) continue;
      seen.add(key);
      vpSelect.appendChild(h('option', { value: tag ? 'project' : key }, `${w}×${hh}${tag ? ' (project)' : ''}`));
    }
  }
  fillViewports();
  app.bus.on('state', fillViewports);
  vpSelect.onchange = async () => {
    const v = vpSelect.value;
    if (v === 'project') {
      settings.viewport = null;
      reload();
      return;
    }
    const [w, hh] = v.split('x').map(Number);
    settings.viewport = { width: w, height: hh };
    try {
      await rpc('set_viewport', settings.viewport);
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  const zoomSel = document.getElementById('zoom-select');
  zoomSel.onchange = () => {
    settings.zoom = zoomSel.value;
    rpc('set_zoom', { zoom: settings.zoom }).catch(() => {});
  };
  const dprSel = document.getElementById('dpr-select');
  dprSel.onchange = () => {
    settings.dpr = Number(dprSel.value);
    reload();
  };

  const pauseBtn = document.getElementById('btn-pause');
  pauseBtn.onclick = async () => {
    settings.paused = !settings.paused;
    pauseBtn.textContent = settings.paused ? '▶' : '❚❚';
    pauseBtn.classList.toggle('on', settings.paused);
    await rpc('set_paused', { paused: settings.paused }).catch(() => {});
  };
  document.getElementById('btn-step').onclick = () => rpc('step_frames', { frames: 1 }).catch((e) => toast(e.message, 'err'));
  const ts = document.getElementById('timescale');
  ts.onchange = () => {
    settings.timeScale = Number(ts.value);
    rpc('set_time_scale', { scale: settings.timeScale }).catch(() => {});
  };

  const toggle = (id, key, fn) => {
    const b = document.getElementById(id);
    b.onclick = async () => {
      settings[key] = !settings[key];
      b.classList.toggle('on', settings[key]);
      await fn().catch(() => {});
    };
    return b;
  };
  toggle('btn-inspect', 'inspect', () => rpc('set_inspect', { enabled: settings.inspect }));
  toggle('btn-grid', 'grid', () => rpc('set_guides', { grid: settings.grid ? 8 : 0 }));
  const overlayBtn = toggle('btn-overlay', 'overlay', async () => {
    if (settings.overlay && !app.state?.references?.active) {
      toast('Load a reference image first (Reference tab).');
      settings.overlay = false;
      overlayBtn.classList.remove('on');
    }
    return applyOverlay();
  });
  const op = document.getElementById('overlay-opacity');
  op.oninput = () => {
    settings.opacity = Number(op.value);
    if (settings.overlay) applyOverlay().catch(() => {});
  };
  const blend = document.getElementById('overlay-blend');
  blend.onchange = () => {
    settings.blend = blend.value;
    if (settings.overlay) applyOverlay().catch(() => {});
  };

  document.getElementById('btn-reload').onclick = reload;
  document.getElementById('btn-capture').onclick = async () => {
    try {
      const shot = await rpc('capture', {});
      const rec = await app.op('capture_upload', { png: shot.png, label: 'Visible preview', meta: shot.meta, region: shot.region });
      toast(h('span', {}, 'Captured ', h('a', { href: rec.url, target: '_blank' }, rec.capture_id)), 'ok');
    } catch (e) {
      toast(`Capture failed: ${e.message}`, 'err');
    }
  };

  app.bus.on('server:reference_updated', async () => {
    await app.refreshState();
    if (settings.overlay) applyOverlay().catch(() => {});
  });

  // The preview page reloads itself on new builds (server push); nothing to do here
  // except tracking the build for display.
  app.bus.on('server:preview_reload', (d) => (app.previewBuild = d.build));

  reload();
  return {
    rpc,
    reload,
    get ready() {
      return ready;
    },
    settings,
  };
}
