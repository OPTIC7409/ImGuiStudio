// Widget inspector: live list of the Dear ImGui items in the visible preview, and the
// selected widget's geometry, spacing, value (editable when bound), code and actions.
import { h, clear, toast, json } from './ui.js';

const SOURCE_FILE = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i;

export function initInspector(app) {
  const root = document.getElementById('tab-inspector');
  const search = h('input', { type: 'text', placeholder: 'Filter widgets (id, label, type)…' });
  const showHidden = h('input', { type: 'checkbox' });
  const showAnon = h('input', { type: 'checkbox' });
  const listEl = h('div', { class: 'insp-list' });
  const detailsEl = h('div', { class: 'insp-details' });
  root.append(
    h('div', { class: 'insp-search' }, search),
    h('div', { class: 'row small muted', style: { padding: '4px 10px', borderBottom: '1px solid var(--border)' } }, h('label', { class: 'toggle' }, showHidden, 'hidden'), h('label', { class: 'toggle' }, showAnon, 'anonymous'), h('span', { class: 'grow' }), h('span', { class: 'faint', id: 'insp-count' })),
    detailsEl,
    listEl,
  );

  let snapshot = null;
  let selected = null;
  let hoverId = null;
  let visible = true;
  let detailsKey = '';
  const usages = new Map(); // widget id -> Promise<[{file, line, text}]>

  app.bus.on('right-tab', (t) => {
    visible = t === 'inspector';
    if (visible) render();
  });
  app.bus.on('widgets', (r) => {
    snapshot = r;
    if (visible) render();
  });
  app.bus.on('widget-selected', (w) => select(w ? w.id : null, { fromPreview: true }));
  app.bus.on('select-widget', (id) => select(id));
  app.bus.on('widget-open', (w) => openCode(w));
  app.bus.on('inspect-hover', (w) => {
    hoverId = w ? w.id : null;
    markHover(true);
  });
  // A new build reloads the preview: keep the selection.
  app.bus.on('preview-ready', () => {
    if (selected) app.preview.rpc('highlight', { selected }).catch(() => {});
  });
  app.bus.on('server:files_changed', () => usages.clear());
  search.oninput = () => render();
  showHidden.onchange = () => render();
  showAnon.onchange = () => render();

  function widget(id) {
    return id && snapshot ? snapshot.widgets.find((w) => w.id === id) || null : null;
  }

  function select(id, { fromPreview = false } = {}) {
    if (id === selected && fromPreview) return;
    selected = id;
    app.selectedWidget = id;
    if (!fromPreview) app.preview?.rpc('highlight', { selected: id }).catch(() => {});
    app.bus.emit('selection', id);
    detailsKey = '';
    render();
    listEl.querySelector('.insp-row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  // Where the widget is created: string literals matching its label or id, in source files.
  function findUsages(w) {
    if (usages.has(w.id)) return usages.get(w.id);
    const terms = [...new Set([w.raw_label, w.label, w.anonymous ? null : w.id].filter((t) => t && t.length > 1).map((t) => `"${t}"`))];
    const p = (async () => {
      const out = [];
      const seen = new Set();
      for (const pattern of terms) {
        const r = await app.op('project_search', { pattern, max_results: 20 }).catch(() => ({ matches: [] }));
        for (const m of r.matches) {
          const key = `${m.file}:${m.line}`;
          if (!SOURCE_FILE.test(m.file) || seen.has(key)) continue;
          seen.add(key);
          out.push(m);
        }
        if (out.length >= 8) break;
      }
      return out.slice(0, 8);
    })();
    usages.set(w.id, p);
    return p;
  }

  function parseSource(s) {
    const m = String(s).match(/^(.*):(\d+)$/);
    return m ? { file: m[1], line: Number(m[2]) } : null;
  }

  async function openCode(w) {
    if (!w) return;
    const used = await findUsages(w);
    const target = used[0] || (w.source || []).map(parseSource).find(Boolean);
    if (target) app.openFile(target.file, target.line);
    else toast(`No source location found for ${w.id}`);
  }

  // Smallest region or child window that contains the widget.
  function containerOf(w) {
    const b = w.visible_bounds || w.bounds;
    let best = null;
    for (const c of snapshot.widgets) {
      if (c.id === w.id || !c.visible || (c.type !== 'region' && c.type !== 'window')) continue;
      const cb = c.visible_bounds || c.bounds;
      const inside = cb.x <= b.x && cb.y <= b.y && cb.x + cb.width >= b.x + b.width && cb.y + cb.height >= b.y + b.height;
      if (!inside || cb.width * cb.height <= b.width * b.height) continue;
      if (!best || cb.width * cb.height < best.b.width * best.b.height) best = { w: c, b: cb };
    }
    return best;
  }

  // "Nova/##page_398DAF6D/##card_516A7F4E" -> "Nova › page › card"
  function prettyWindow(name) {
    return name
      .split('/')
      .map((seg) => seg.replace(/^#+/, '').replace(/_[0-9A-F]{8}$/, '') || '·')
      .join(' › ');
  }

  function matches(w, q) {
    if (!q) return true;
    return w.id.toLowerCase().includes(q) || (w.label || '').toLowerCase().includes(q) || (w.type || '').toLowerCase().includes(q);
  }

  function flags(w) {
    const s = w.state || {};
    const out = [];
    if (s.hovered) out.push(h('span', { class: 'flag h' }, 'hover'));
    if (s.active) out.push(h('span', { class: 'flag a' }, 'active'));
    if (s.focused) out.push(h('span', { class: 'flag h' }, 'focus'));
    if (s.checked === true) out.push(h('span', { class: 'flag v' }, 'on'));
    if (s.open === true) out.push(h('span', { class: 'flag v' }, 'open'));
    if (s.value !== undefined && typeof s.value !== 'boolean') out.push(h('span', { class: 'flag' }, fmtValue(s.value)));
    if (!w.visible) out.push(h('span', { class: 'flag x' }, 'hidden'));
    return out;
  }

  function fmtValue(v) {
    if (Array.isArray(v)) return `[${v.map((x) => (typeof x === 'number' ? +x.toFixed(2) : x)).join(', ')}]`;
    if (typeof v === 'number') return String(+v.toFixed(3));
    return String(v).slice(0, 24);
  }

  const fmtPx = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));

  function markHover(fromPreview = false) {
    for (const row of listEl.querySelectorAll('.insp-row')) {
      const on = row.dataset.id === hoverId;
      row.style.outline = on ? '1px solid var(--accent)' : '';
      if (on && fromPreview && !listEl.matches(':hover')) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function render() {
    renderList();
    renderDetails();
  }

  function renderList() {
    clear(listEl);
    if (!snapshot) {
      listEl.appendChild(h('div', { class: 'empty-state' }, 'Waiting for the preview…'));
      return;
    }
    const q = search.value.trim().toLowerCase();
    const byWindow = new Map();
    let count = 0;
    for (const w of snapshot.widgets) {
      if (w.type === 'window' || !matches(w, q)) continue;
      if (!showHidden.checked && !w.visible) continue;
      if (!showAnon.checked && w.anonymous) continue;
      const win = w.window || '(no window)';
      if (!byWindow.has(win)) byWindow.set(win, []);
      byWindow.get(win).push(w);
      count++;
    }
    document.getElementById('insp-count').textContent = `${count} widgets · frame ${snapshot.frame}`;
    for (const [win, ws] of byWindow) {
      const winInfo = snapshot.windows.find((x) => x.name === win);
      listEl.appendChild(h('div', { class: 'insp-window', title: win }, h('span', { class: 'wname' }, prettyWindow(win)), h('span', { class: 'faint' }, winInfo ? `${winInfo.kind} ${Math.round(winInfo.bounds.width)}×${Math.round(winInfo.bounds.height)}` : '')));
      for (const w of ws) {
        listEl.appendChild(
          h(
            'div',
            {
              class: `insp-row${w.id === selected ? ' selected' : ''}`,
              dataset: { id: w.id },
              onclick: () => select(w.id),
              ondblclick: () => openCode(w),
              onmouseenter: () => app.preview.rpc('highlight', { ids: [w.id] }).catch(() => {}),
              onmouseleave: () => app.preview.rpc('highlight', { ids: [] }).catch(() => {}),
            },
            h('div', { class: 'wid', title: w.id }, w.id),
            h('div', { class: 'flags' }, h('span', { class: 'wtype' }, w.type), ...flags(w)),
          ),
        );
      }
    }
    if (!count) listEl.appendChild(h('div', { class: 'empty-state' }, q ? 'No widgets match.' : 'No widgets in the current frame.'));
    markHover();
  }

  function renderDetails() {
    const w = widget(selected);
    const key = selected ? JSON.stringify(w) : '';
    if (key === detailsKey) return;
    // Do not rebuild under the user's cursor while they edit a value.
    if (detailsEl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && detailsKey && w) return;
    detailsKey = key;
    clear(detailsEl);
    if (!selected) return;
    if (!w) {
      detailsEl.appendChild(h('div', { class: 'section muted' }, `${selected} is not in the current frame.`, ' ', h('a', { class: 'src', onclick: () => select(null) }, 'Clear')));
      return;
    }
    const b = w.bounds;
    const section = h('div', { class: 'section' });
    section.append(
      h(
        'div',
        { class: 'wd-head' },
        h('span', { class: 'wd-type' }, w.type),
        h('span', { class: 'wd-id', title: w.id }, w.id),
        h('button', { class: 'icon', title: 'Copy id', onclick: () => navigator.clipboard.writeText(w.id).then(() => toast('Copied', 'ok')) }, '⧉'),
        h('button', { class: 'icon', title: 'Deselect (Esc)', onclick: () => select(null) }, '✕'),
      ),
    );
    if (w.label && w.label !== w.id) section.append(h('div', { class: 'small muted', style: { margin: '-4px 0 8px' } }, `“${w.label}”`, w.raw_label ? h('span', { class: 'faint' }, `  ${w.raw_label}`) : null));
    section.append(h('div', { class: 'wd-grid' }, ...[['X', b.x], ['Y', b.y], ['W', b.width], ['H', b.height]].map(([k, v]) => h('div', { class: 'wd-cell' }, h('b', {}, k), fmtPx(v)))));

    const c = containerOf(w);
    if (c) {
      const vb = w.visible_bounds || w.bounds;
      const gaps = [
        ['←', vb.x - c.b.x],
        ['→', c.b.x + c.b.width - (vb.x + vb.width)],
        ['↑', vb.y - c.b.y],
        ['↓', c.b.y + c.b.height - (vb.y + vb.height)],
      ];
      section.append(
        h('div', { class: 'wd-sub' }, 'Spacing in ', h('a', { class: 'src', title: 'Select the container', onclick: () => select(c.w.id) }, c.w.type === 'window' ? prettyWindow(c.w.label || c.w.id) : c.w.id)),
        h('div', { class: 'wd-spacing' }, ...gaps.map(([k, v]) => h('span', {}, `${k} `, h('b', {}, fmtPx(v))))),
      );
    }

    const editor = valueEditor(w);
    if (editor) section.append(h('div', { class: 'wd-sub' }, 'Value', h('span', { class: 'grow' }), h('span', { class: 'faint' }, w.value_type)), editor);

    const st = flags(w);
    if (st.length) section.append(h('div', { class: 'wd-sub' }, 'State'), h('div', { class: 'flags', style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } }, ...st));

    const code = h('div', { class: 'wd-code' }, h('span', { class: 'faint small' }, 'Searching…'));
    section.append(h('div', { class: 'wd-sub' }, 'Code', h('span', { class: 'grow' }), h('span', { class: 'faint' }, 'double-click in the preview to open')), code);
    const impl = (w.source || []).map(parseSource).filter(Boolean);
    findUsages(w).then((used) => {
      if (selected !== w.id) return;
      clear(code);
      const link = (m, ctx) => h('div', {}, h('a', { class: 'src', onclick: () => app.openFile(m.file, m.line) }, `${m.file}:${m.line}`), ctx ? h('div', { class: 'ctx', title: ctx }, ctx) : null);
      if (used.length) code.append(h('div', { class: 'faint small' }, 'Created at'), ...used.map((m) => link(m, m.text)));
      if (impl.length) code.append(h('div', { class: 'faint small', style: { marginTop: used.length ? '4px' : 0 } }, 'Widget code (STUDIO_ macros)'), ...impl.map((m) => link(m)));
      if (!used.length && !impl.length) code.append(h('span', { class: 'faint small' }, 'Not found: the label is built at runtime. Add STUDIO_ID("…") to name it.'));
    });

    const act = (label, title, fn) =>
      h(
        'button',
        {
          title,
          onclick: async () => {
            try {
              await fn();
            } catch (e) {
              toast(e.message, 'err');
            }
          },
        },
        label,
      );
    section.append(
      h(
        'div',
        { class: 'wd-actions' },
        act('Open code', 'Open where this widget is created (Enter in the preview)', () => openCode(w)),
        c ? act('↑ Container', 'Select the enclosing region or window', () => select(c.w.id)) : null,
        act('Click', 'Click it in the preview', () => app.preview.rpc('click', { id: w.id, settle_ms: 0 })),
        act('Hover', 'Hover it in the preview', () => app.preview.rpc('hover', { id: w.id, settle_ms: 0 })),
        act('Capture', 'Save a capture of this widget', async () => {
          const shot = await app.preview.rpc('capture', { id: w.id, padding: 8 });
          const rec = await app.op('capture_upload', { png: shot.png, label: w.id, meta: shot.meta, region: shot.region, kind: 'widget' });
          toast(h('span', {}, 'Captured ', h('a', { href: rec.url, target: '_blank' }, rec.capture_id)), 'ok');
        }),
      ),
    );
    section.append(h('details', { style: { marginTop: '8px' } }, h('summary', { class: 'faint small', style: { cursor: 'pointer' } }, 'Raw'), h('div', { class: 'kv', style: { marginTop: '6px' } }, ...[['imgui id', w.imgui_id], ['window', w.window], w.scope ? ['scope', w.scope] : null, ['state', json(w.state || {})]].filter(Boolean).flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)]))));
    detailsEl.appendChild(section);
  }

  // Live editor for values bound with STUDIO_BIND / _N / _COLOR / _TEXT.
  function valueEditor(w) {
    if (!w.settable || !w.value_type) return null;
    const v = w.state?.value;
    const set = (value) => app.preview.rpc('set_value', { id: w.id, value, settle_ms: 0 }).catch((e) => toast(e.message, 'err'));
    const box = h('div', { class: 'wd-value' });
    if (w.value_type === 'bool') {
      const cb = h('input', { type: 'checkbox', checked: v === true || w.state?.checked === true, onchange: () => set(cb.checked) });
      box.append(h('label', { class: 'toggle' }, cb, cb.checked ? 'on' : 'off'));
    } else if (w.value_type === 'int' || w.value_type === 'float') {
      const n = h('input', { type: 'number', step: w.value_type === 'int' ? '1' : 'any', value: typeof v === 'number' ? +v.toFixed(4) : '' });
      n.onchange = () => n.value !== '' && set(Number(n.value));
      n.onkeydown = (e) => e.key === 'Enter' && n.blur();
      box.append(n);
    } else if (w.value_type === 'color' && Array.isArray(v)) {
      const hex = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
      const alpha = v.length > 3 ? v[3] : 1;
      const picker = h('input', { type: 'color', value: `#${hex(v[0])}${hex(v[1])}${hex(v[2])}` });
      let t = 0;
      picker.oninput = () => {
        clearTimeout(t);
        t = setTimeout(() => set(`${picker.value}${hex(alpha)}`), 40);
      };
      box.append(picker, h('span', { class: 'mono small' }, `${picker.value.toUpperCase()}${alpha < 1 ? ` · α ${alpha.toFixed(2)}` : ''}`));
    } else if (w.value_type === 'float_array' && Array.isArray(v)) {
      const inputs = v.map((x) => h('input', { type: 'number', step: 'any', value: +Number(x).toFixed(4), style: { width: '64px' } }));
      for (const i of inputs) i.onchange = () => set(inputs.map((x) => Number(x.value)));
      box.append(...inputs);
    } else if (w.value_type === 'text') {
      const t = h('input', { type: 'text', value: typeof v === 'string' ? v : '' });
      t.onchange = () => set(t.value);
      t.onkeydown = (e) => e.key === 'Enter' && t.blur();
      box.append(t);
    } else return null;
    return box;
  }

  render();
}
