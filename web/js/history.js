// History tab: visual timeline of builds, details, diffs, notes, revert.
import { h, clear, toast, modal, timeAgo, fmtMs } from './ui.js';

export function initHistory(app) {
  const root = document.getElementById('tab-history');
  let selected = null;

  function builds() {
    return (app.state?.history || []).slice().reverse();
  }

  function render() {
    clear(root);
    const list = builds();
    if (!list.length) {
      root.appendChild(h('div', { class: 'empty-state' }, 'No builds yet. Press Build (Ctrl+B).'));
      return;
    }
    // Visual timeline (oldest -> newest)
    const tl = h('div', { class: 'timeline' });
    const chron = list.slice(0, 30).reverse();
    chron.forEach((b, i) => {
      if (i) tl.appendChild(h('span', { class: 'arrow' }, '→'));
      tl.appendChild(
        h(
          'div',
          { class: `tl${b.id === selected ? ' sel' : ''}`, title: `Build #${b.id}${b.note ? ` — ${b.note}` : ''}`, onclick: () => select(b.id) },
          b.thumbnail_url ? h('img', { src: b.thumbnail_url, loading: 'lazy' }) : h('div', { class: 'noimg', style: { width: '64px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: b.success ? 'var(--text-faint)' : 'var(--err)', border: '1px dashed var(--border-2)', borderRadius: '3px' } }, b.success ? '·' : '✗'),
          h('div', {}, `v${b.id}${b.score != null ? ` · ${Math.round(b.score)}` : ''}`),
        ),
      );
    });
    root.appendChild(tl);
    requestAnimationFrame(() => (tl.scrollLeft = tl.scrollWidth));

    if (selected != null) {
      const b = list.find((x) => x.id === selected);
      if (b) root.appendChild(details(b, list));
    }
    let prevScore = null;
    const scores = new Map();
    for (const b of chron) {
      if (b.score != null) {
        scores.set(b.id, prevScore != null && b.score < prevScore - 0.5 ? 'down' : '');
        prevScore = b.score;
      }
    }
    for (const b of list) {
      root.appendChild(
        h(
          'div',
          { class: `hist-item${b.id === selected ? ' selected' : ''}`, onclick: () => select(b.id) },
          b.thumbnail_url ? h('img', { src: b.thumbnail_url, loading: 'lazy' }) : h('div', { class: 'noimg' }, b.success ? '·' : '✗'),
          h(
            'div',
            {},
            h('div', { class: 'hist-title' }, h('span', { class: b.success ? 'ok' : 'bad' }, b.success ? '✓' : '✗'), `Build #${b.id}`, b.score != null ? h('span', { class: `score ${scores.get(b.id) || ''}` }, String(b.score)) : null, b.restored_from ? h('span', { class: 'flag' }, `revert → #${b.restored_from}`) : null),
            h('div', { class: 'hist-meta' }, `${timeAgo(b.time)} · ${fmtMs(b.duration_ms)}${b.errors ? ` · ${b.errors} error(s)` : ''}`),
            b.changed?.length ? h('div', { class: 'hist-meta mono small', title: b.changed.join('\n') }, b.changed.slice(0, 3).join(', ') + (b.changed.length > 3 ? ` +${b.changed.length - 3}` : '')) : null,
            b.note ? h('div', { class: 'hist-note' }, `“${b.note}”`) : null,
          ),
        ),
      );
    }
  }

  function details(b, list) {
    const idx = list.findIndex((x) => x.id === b.id);
    const prev = list.slice(idx + 1).find((x) => x.screenshot_url);
    const prevAny = list[idx + 1];
    const act = (label, fn, cls = '') => h('button', { class: cls, onclick: async () => { try { await fn(); } catch (e) { toast(e.message, 'err'); } } }, label);
    return h(
      'div',
      { class: 'section', style: { background: 'var(--panel-2)' } },
      h('h4', {}, `Build #${b.id}`, h('button', { class: 'icon', onclick: () => select(null) }, '✕')),
      b.screenshot_url ? h('img', { class: 'thumb', src: b.screenshot_url, style: { cursor: 'zoom-in' }, onclick: () => modal({ title: `Build #${b.id}`, body: h('img', { src: b.screenshot_url }) }) }) : null,
      (b.notes || []).length ? h('div', { style: { marginTop: '6px' } }, ...b.notes.map((n) => h('div', { class: 'hist-note' }, `${n.text}`))) : null,
      h(
        'div',
        { class: 'row', style: { marginTop: '8px' } },
        prevAny ? act('Diff vs previous', () => showDiff(prevAny.id, b.id)) : null,
        prev && b.screenshot_url ? act(`Compare with #${prev.id}`, () => app.compare.show({ a: `build:${prev.id}`, b: `build:${b.id}` })) : null,
        b.screenshot_url && app.state.references?.active ? act('vs reference', () => app.compare.show({ a: `ref:${app.state.references.active}`, b: `build:${b.id}` })) : null,
        act('Note…', async () => {
          const note = prompt(`Note for build #${b.id}:`);
          if (note) {
            await app.op('history_note', { build_id: b.id, note });
            await app.refreshState();
          }
        }),
        act(
          'Revert to this',
          async () => {
            if (!confirm(`Restore all project files to build #${b.id} and rebuild? (The current state stays in history.)`)) return;
            await app.op('history_revert', { build_id: b.id, rebuild: true });
            toast(`Reverted to build #${b.id}`, 'ok');
          },
          'danger',
        ),
      ),
    );
  }

  async function showDiff(from, to) {
    const r = await app.op('history_diff', { from, to });
    if (!r.files.length) {
      toast('No source differences.');
      return;
    }
    const monaco = app.editor?.monaco;
    const sel = h('select', {}, ...r.files.map((f, i) => h('option', { value: String(i) }, `${f.path} (${f.change})`)));
    const holder = h('div', { style: { height: '65vh', border: '1px solid var(--border)' } });
    const body = h('div', {}, h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'muted' }, `Build #${from} → #${to}`), sel), holder);
    let diffEditor = null;
    modal({ title: 'Source diff', body, onClose: () => diffEditor?.dispose() });
    const showFile = async (i) => {
      const f = r.files[i];
      if (monaco && !f.binary) {
        const [a, bText] = await Promise.all([fileAt(from, f.path), fileAt(to, f.path)]);
        if (!diffEditor) diffEditor = monaco.editor.createDiffEditor(holder, { theme: 'studio-dark', readOnly: true, automaticLayout: true, renderSideBySide: true, minimap: { enabled: false } });
        diffEditor.setModel({ original: monaco.editor.createModel(a, 'cpp'), modified: monaco.editor.createModel(bText, 'cpp') });
      } else {
        clear(holder);
        holder.appendChild(h('pre', { class: 'mono small', style: { padding: '8px', margin: 0, overflow: 'auto', height: '100%' } }, f.diff || '(binary file)'));
      }
    };
    sel.onchange = () => showFile(Number(sel.value));
    showFile(0);
  }

  async function fileAt(buildId, path) {
    const res = await fetch(`/api/history-file?build=${buildId}&path=${encodeURIComponent(path)}`);
    return res.ok ? res.text() : '';
  }

  function select(id) {
    selected = id;
    render();
  }

  app.bus.on('state', render);
  app.bus.on('server:history_updated', () => app.refreshState());
  app.bus.on('server:build_finished', () => app.refreshState());
  render();
}
