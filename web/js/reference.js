// Reference tab: load/select reference designs, regions, quick comparison.
import { h, clear, toast, readFileAsBase64 } from './ui.js';

export function initReference(app) {
  const root = document.getElementById('tab-reference');

  async function upload(file) {
    try {
      const data = await readFileAsBase64(file);
      await app.op('reference_load', { data_base64: data, name: file.name });
      await app.refreshState();
      toast(`Reference "${file.name}" loaded`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function render() {
    clear(root);
    const refs = app.state?.references || { items: [], active: null };
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true, onchange: () => input.files[0] && upload(input.files[0]) });
    const drop = h('div', { class: 'dropzone', onclick: () => input.click() }, 'Drop a PNG/JPEG design here, or click to choose');
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (f) upload(f);
    });
    root.appendChild(h('div', { class: 'section' }, h('h4', {}, 'Reference designs'), input, drop, refs.items.length ? h('div', { class: 'ref-list', style: { marginTop: '10px' } }, ...refs.items.map((r) => h('div', { class: `ref-card${r.name === refs.active ? ' active' : ''}`, title: `${r.width}×${r.height}`, onclick: async () => { await app.op('reference_set_active', { name: r.name }); await app.refreshState(); } }, h('img', { src: r.url }), h('div', {}, `${r.name} · ${r.width}×${r.height}`)))) : null));

    const active = refs.items.find((r) => r.name === refs.active);
    if (!active) {
      root.appendChild(h('div', { class: 'empty-state' }, 'No active reference. Agents can also load one with the reference_load tool.'));
      return;
    }
    const vp = app.state.config.viewport;
    const sizeNote = active.width !== vp.width || active.height !== vp.height ? h('div', { class: 'small', style: { color: 'var(--warn)', marginTop: '6px' } }, `Reference is ${active.width}×${active.height}, viewport is ${vp.width}×${vp.height}. Comparisons will scale or crop.`) : null;
    root.appendChild(
      h(
        'div',
        { class: 'section' },
        h('h4', {}, `Active: ${active.name}`),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'primary', onclick: () => app.compare.show({ a: `ref:${active.name}`, b: 'live' }) }, 'Open compare view'),
          h('button', { onclick: async () => { try { const r = await app.op('reference_compare', {}); app.compare.show({ a: `ref:${active.name}`, b: r.current?.capture_id ? `cap:${r.current.capture_id}` : 'live', result: r, title: `Reference "${active.name}" vs agent preview` }); } catch (e) { toast(e.message, 'err'); } } }, 'Compare now'),
        ),
        h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Tip: the ◐ button in the preview toolbar overlays this reference on the live preview (blend or difference).'),
        sizeNote,
      ),
    );
    const regions = active.regions || [];
    root.appendChild(
      h(
        'div',
        { class: 'section' },
        h('h4', {}, 'Regions', h('span', { class: 'faint small' }, 'draw them in the compare view')),
        regions.length
          ? h(
              'div',
              {},
              ...regions.map((r) =>
                h(
                  'div',
                  { class: 'region-row' },
                  h('div', {}, h('div', { class: 'mono' }, r.name), h('div', { class: 'faint small' }, `${r.x},${r.y} ${r.width}×${r.height}${r.widget ? ` → ${r.widget}` : ''}`)),
                  h(
                    'div',
                    { class: 'row' },
                    h('button', { onclick: async () => { try { const res = await app.op('reference_compare_region', { region: r.name }); app.compare.show({ a: `ref:${active.name}`, b: 'live', result: res, title: `Region "${r.name}"` }); } catch (e) { toast(e.message, 'err'); } } }, 'Compare'),
                    h('button', { class: 'icon', title: 'Delete region', onclick: async () => { await app.op('reference_set_regions', { reference: active.name, regions: regions.filter((x) => x.name !== r.name), replace: true }); await app.refreshState(); } }, '✕'),
                  ),
                ),
              ),
            )
          : h('div', { class: 'faint small' }, 'No regions yet. In the compare view, press "▭ Region" and drag on the reference to map parts of the design to widgets.'),
      ),
    );
  }

  app.bus.on('state', render);
  app.bus.on('server:reference_updated', () => app.refreshState());
  render();
}
