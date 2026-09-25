// Widget inspector: live list of Dear ImGui items in the visible preview, details, actions.
import { h, clear, toast, json } from './ui.js';

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
  let lastKey = '';
  let selected = null;
  let hoverId = null;
  let visible = true;

  app.bus.on('right-tab', (t) => {
    visible = t === 'inspector';
    if (visible) poll();
  });
  app.bus.on('widget-selected', (w) => select(w ? w.id : null));
  app.bus.on('inspect-hover', (w) => {
    hoverId = w ? w.id : null;
    markHover();
  });
  search.oninput = () => render(true);
  showHidden.onchange = () => poll(true);
  showAnon.onchange = () => poll(true);

  function select(id) {
    selected = id;
    app.preview.rpc('highlight', { ids: [], selected: id }).catch(() => {});
    render(true);
  }

  async function poll(force = false) {
    if (!visible || !app.preview?.ready) return;
    try {
      const r = await app.preview.rpc('widgets', { include_hidden: showHidden.checked, include_anonymous: showAnon.checked, include_windows: true, compact: false, limit: 3000 });
      const key = JSON.stringify(r.widgets);
      snapshot = r;
      if (force || key !== lastKey) {
        lastKey = key;
        render();
      }
    } catch {
      // preview reloading
    }
  }
  setInterval(poll, 400);
  app.bus.on('preview-ready', () => poll(true));

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

  function markHover() {
    for (const row of listEl.querySelectorAll('.insp-row')) row.style.outline = row.dataset.id === hoverId ? '1px solid var(--accent)' : '';
  }

  function render() {
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
      const root = w.window || '(no window)';
      if (!byWindow.has(root)) byWindow.set(root, []);
      byWindow.get(root).push(w);
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
              onmouseenter: () => app.preview.rpc('highlight', { ids: [w.id], selected }).catch(() => {}),
              onmouseleave: () => app.preview.rpc('highlight', { ids: [], selected }).catch(() => {}),
            },
            h('div', { class: 'wid', title: w.id }, w.id),
            h('div', { class: 'flags' }, h('span', { class: 'wtype' }, w.type), ...flags(w)),
          ),
        );
      }
    }
    if (!count) listEl.appendChild(h('div', { class: 'empty-state' }, q ? 'No widgets match.' : 'No widgets in the current frame.'));
    renderDetails();
    markHover();
  }

  function renderDetails() {
    clear(detailsEl);
    if (!selected || !snapshot) return;
    const w = snapshot.widgets.find((x) => x.id === selected);
    if (!w) {
      detailsEl.appendChild(h('div', { class: 'section muted' }, `${selected} is not in the current frame.`));
      return;
    }
    const b = w.bounds;
    const rows = [
      ['id', w.id],
      ['type', w.type],
      ['label', w.raw_label || w.label || '—'],
      ['window', w.window],
      ['bounds', `x ${b.x}  y ${b.y}  w ${b.width}  h ${b.height}`],
      w.visible_bounds ? ['visible', `x ${w.visible_bounds.x}  y ${w.visible_bounds.y}  w ${w.visible_bounds.width}  h ${w.visible_bounds.height}`] : null,
      ['imgui id', w.imgui_id],
      w.scope ? ['scope', w.scope] : null,
      w.value_type ? ['value type', `${w.value_type}${w.settable ? ' (settable)' : ''}`] : null,
    ].filter(Boolean);
    const state = w.state || {};
    const srcLinks = (w.source || []).map((s) => {
      const m = s.match(/^(.*):(\d+)$/);
      return m ? h('a', { class: 'src', onclick: () => app.openFile(m[1], Number(m[2])) }, s) : h('span', {}, s);
    });
    const act = (label, fn) => h('button', { onclick: async () => { try { await fn(); } catch (e) { toast(e.message, 'err'); } } }, label);
    detailsEl.appendChild(
      h(
        'div',
        { class: 'section' },
        h('h4', {}, 'Selected widget', h('button', { class: 'icon', title: 'Deselect', onclick: () => select(null) }, '✕')),
        h('div', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)]), h('div', { class: 'k' }, 'state'), h('div', { class: 'v' }, json(state)), srcLinks.length ? h('div', { class: 'k' }, 'source') : null, srcLinks.length ? h('div', { class: 'v' }, ...srcLinks.flatMap((l, i) => (i ? [h('br'), l] : [l]))) : null),
        h(
          'div',
          { class: 'row', style: { marginTop: '8px' } },
          act('Click', () => app.preview.rpc('click', { id: w.id, settle_ms: 0 })),
          act('Hover', () => app.preview.rpc('hover', { id: w.id, settle_ms: 0 })),
          act('Capture', async () => {
            const shot = await app.preview.rpc('capture', { id: w.id, padding: 8 });
            const rec = await app.op('capture_upload', { png: shot.png, label: w.id, meta: shot.meta, region: shot.region, kind: 'widget' });
            toast(h('span', {}, 'Captured ', h('a', { href: rec.url, target: '_blank' }, rec.capture_id)), 'ok');
          }),
          act('Copy id', () => navigator.clipboard.writeText(w.id)),
        ),
      ),
    );
  }

  render();
}
