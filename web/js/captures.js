// Captures tab: screenshots, widget captures, animation filmstrips, comparisons.
import { h, clear, modal, timeAgo, json } from './ui.js';

export function initCaptures(app) {
  const root = document.getElementById('tab-captures');
  const kindSel = h('select', {}, ...['all', 'screen', 'widget', 'region', 'window', 'animation', 'comparison', 'build'].map((k) => h('option', { value: k }, k)));
  const grid = h('div', { class: 'cap-grid' });
  root.append(h('div', { class: 'insp-search' }, h('span', { class: 'muted' }, 'Kind'), kindSel), grid);

  function render() {
    clear(grid);
    let caps = app.state?.captures || [];
    if (kindSel.value !== 'all') caps = caps.filter((c) => c.kind === kindSel.value);
    if (!caps.length) {
      grid.appendChild(h('div', { class: 'empty-state', style: { gridColumn: '1 / -1' } }, 'No captures yet. Agents create them with capture_* tools; you can use ⎙ in the preview toolbar.'));
      return;
    }
    for (const c of caps) {
      grid.appendChild(
        h(
          'div',
          { class: 'cap', title: c.label || c.capture_id, onclick: () => open(c) },
          h('img', { src: c.url, loading: 'lazy' }),
          h('div', { class: 'cap-meta' }, h('span', { class: 'kind' }, c.kind), c.label || c.capture_id),
          h('div', { class: 'cap-meta faint' }, `${timeAgo(c.time)}${c.build_id ? ` · #${c.build_id}` : ''}${c.similarity != null ? ` · ${c.similarity}` : ''}`),
        ),
      );
    }
  }

  function open(c) {
    const meta = { ...c };
    delete meta.url;
    const body = h(
      'div',
      {},
      h('img', { src: c.url, style: { display: 'block', margin: '0 auto 10px', maxWidth: '100%', background: '#0b0c10' } }),
      c.frames ? h('div', { class: 'small muted', style: { marginBottom: '8px' } }, 'Per-frame state: ', h('pre', { class: 'mono small' }, c.frames.map((f) => `t=${f.t_ms}ms  ${JSON.stringify(f.state || {})}`).join('\n'))) : null,
      h('details', {}, h('summary', { class: 'muted' }, 'Metadata'), h('pre', { class: 'mono small' }, json(meta))),
    );
    const footer = [h('a', { href: c.url, target: '_blank' }, h('button', {}, 'Open image'))];
    if (app.state.references?.active && ['screen', 'build'].includes(c.kind)) {
      footer.unshift(h('button', { onclick: () => { m.close(); app.compare.show({ a: `ref:${app.state.references.active}`, b: c.kind === 'build' ? `build:${c.build_id}` : `cap:${c.capture_id}` }); } }, 'Compare with reference'));
    }
    const m = modal({ title: `${c.kind}: ${c.label || c.capture_id}`, body, footer });
  }

  kindSel.onchange = render;
  app.bus.on('state', render);
  app.bus.on('server:capture_added', (c) => {
    if (!app.state) return;
    app.state.captures = [c, ...(app.state.captures || []).filter((x) => x.capture_id !== c.capture_id)].slice(0, 300);
    render();
  });
  render();
}
