// Center "Compare" view: reference vs build/live, side-by-side / overlay / difference / swipe,
// metrics, hotspots and reference region mapping.
import { h, clear, toast, loadImage } from './ui.js';

export function initCompare(app) {
  const root = document.getElementById('view-compare');
  const leftSel = h('select', { title: 'Left image (A)' });
  const rightSel = h('select', { title: 'Right image (B)' });
  const modeSeg = h('div', { class: 'seg' });
  const opacity = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '0.5', title: 'Overlay opacity' });
  const zoomSel = h('select', { title: 'Zoom' }, h('option', { value: 'fit' }, 'Fit'), h('option', { value: '1' }, '100%'), h('option', { value: '2' }, '200%'), h('option', { value: '4' }, '400%'));
  const drawBtn = h('button', { class: 'icon toggle-btn', title: 'Draw a named region on the reference (A)' }, '▭ Region');
  const metricsBtn = h('button', { class: 'primary' }, 'Compute metrics');
  const stage = h('div', { class: 'cmp-stage' });
  const metrics = h('div', { class: 'cmp-metrics' }, h('div', { class: 'muted' }, 'Pick A and B, then "Compute metrics". Reference vs live/latest uses the deterministic agent preview.'));
  root.append(h('div', { class: 'cmp-toolbar' }, h('span', { class: 'muted' }, 'A'), leftSel, h('span', { class: 'muted' }, 'B'), rightSel, modeSeg, opacity, zoomSel, drawBtn, h('span', { class: 'grow' }), metricsBtn), stage, metrics);

  const modes = [['side', 'Side by side'], ['overlay', 'Overlay'], ['diff', 'Difference'], ['swipe', 'Swipe']];
  let mode = 'side';
  for (const [m, label] of modes) {
    modeSeg.appendChild(h('button', { class: m === mode ? 'active' : '', onclick: () => { mode = m; for (const b of modeSeg.children) b.classList.toggle('active', b.textContent === label); render(); } }, label));
  }

  let imgA = null;
  let imgB = null;
  let urlB = null;
  let swipe = 0.5;
  let drawing = false;
  let lastResult = null;
  let hoverSpot = null;

  function options() {
    const s = app.state || {};
    const refs = s.references?.items || [];
    const builds = (s.history || []).filter((b) => b.screenshot_url).slice(-40).reverse();
    const caps = (s.captures || []).filter((c) => c.kind !== 'build' && c.kind !== 'comparison').slice(0, 20);
    const prevA = leftSel.value;
    const prevB = rightSel.value;
    clear(leftSel);
    clear(rightSel);
    for (const r of refs) leftSel.appendChild(h('option', { value: `ref:${r.name}` }, `Reference: ${r.name}${r.name === s.references.active ? ' (active)' : ''}`));
    for (const b of builds) leftSel.appendChild(h('option', { value: `build:${b.id}` }, `Build #${b.id}${b.score != null ? ` (${b.score})` : ''}`));
    rightSel.appendChild(h('option', { value: 'live' }, 'Live preview (capture)'));
    for (const b of builds) rightSel.appendChild(h('option', { value: `build:${b.id}` }, `Build #${b.id}${b.score != null ? ` (${b.score})` : ''}`));
    for (const c of caps) rightSel.appendChild(h('option', { value: `cap:${c.capture_id}` }, `Capture ${c.capture_id} (${c.kind})`));
    if ([...leftSel.options].some((o) => o.value === prevA)) leftSel.value = prevA;
    else if (s.references?.active) leftSel.value = `ref:${s.references.active}`;
    if ([...rightSel.options].some((o) => o.value === prevB)) rightSel.value = prevB;
    else if (builds[0]) rightSel.value = `build:${builds[0].id}`;
  }

  async function urlFor(value) {
    const s = app.state;
    if (!value) return null;
    if (value.startsWith('ref:')) return s.references.items.find((r) => r.name === value.slice(4))?.url;
    if (value.startsWith('build:')) return `/studio-files/captures/build-${value.slice(6)}.png`;
    if (value.startsWith('cap:')) return `/studio-files/captures/${value.slice(4)}.png`;
    if (value === 'live') {
      const shot = await app.preview.rpc('capture', {});
      return `data:image/png;base64,${shot.png}`;
    }
    return null;
  }

  async function load() {
    try {
      const [a, b] = await Promise.all([urlFor(leftSel.value), urlFor(rightSel.value)]);
      urlB = b;
      imgA = a ? await loadImage(a) : null;
      imgB = b ? await loadImage(b) : null;
    } catch (e) {
      toast(e.message, 'err');
    }
    render();
  }

  function scaleFor(w, hgt, count = 1) {
    if (zoomSel.value !== 'fit') return Number(zoomSel.value);
    const r = stage.getBoundingClientRect();
    const availW = (r.width - 48 - (count - 1) * 16) / count;
    const availH = r.height - 60;
    return Math.max(0.05, Math.min(4, availW / w, availH / hgt));
  }

  function regionBoxes(container, natW, natH, dispW, dispH) {
    const s = app.state;
    const refName = leftSel.value.startsWith('ref:') ? leftSel.value.slice(4) : null;
    const ref = refName ? s.references.items.find((r) => r.name === refName) : null;
    if (!ref) return;
    for (const r of ref.regions || []) {
      container.appendChild(
        h(
          'div',
          { class: 'region-box', style: { left: `${(r.x / natW) * dispW}px`, top: `${(r.y / natH) * dispH}px`, width: `${(r.width / natW) * dispW}px`, height: `${(r.height / natH) * dispH}px` } },
          h('span', {}, `${r.name}${r.widget ? ` → ${r.widget}` : ''}`),
        ),
      );
    }
  }

  function hotspotBox(container, natW, natH, dispW, dispH) {
    if (!hoverSpot || !imgB) return;
    const sx = dispW / natW;
    const sy = dispH / natH;
    container.appendChild(h('div', { class: 'region-box', style: { left: `${hoverSpot.x * sx}px`, top: `${hoverSpot.y * sy}px`, width: `${hoverSpot.width * sx}px`, height: `${hoverSpot.height * sy}px`, borderColor: '#ff5c6c', background: '#ff5c6c22' } }));
  }

  function render() {
    clear(stage);
    if (!imgA && !imgB) {
      stage.appendChild(h('div', { class: 'empty-state' }, 'Load a reference image (Reference tab) and build the project to compare.'));
      return;
    }
    const bw = imgB ? imgB.naturalWidth : imgA.naturalWidth;
    const bh = imgB ? imgB.naturalHeight : imgA.naturalHeight;
    if (mode === 'side') {
      const count = imgA && imgB ? 2 : 1;
      const s = scaleFor(bw, bh, count);
      const row = h('div', { class: 'cmp-side' });
      if (imgA) {
        const dispW = Math.round(bw * s);
        const dispH = Math.round(bh * s);
        const wrap = h('div', { class: 'cmp-stack', style: { width: `${dispW}px`, height: `${dispH}px` } }, h('img', { class: 'cmp-img', src: imgA.src, style: { width: `${dispW}px`, height: `${dispH}px` }, draggable: 'false' }));
        regionBoxes(wrap, imgA.naturalWidth, imgA.naturalHeight, dispW, dispH);
        if (drawing) enableDraw(wrap, imgA.naturalWidth, imgA.naturalHeight, dispW, dispH);
        row.appendChild(h('figure', {}, h('figcaption', {}, `A · ${label(leftSel)} · ${imgA.naturalWidth}×${imgA.naturalHeight}`), wrap));
      }
      if (imgB) {
        const dispW = Math.round(bw * s);
        const dispH = Math.round(bh * s);
        const wrap = h('div', { class: 'cmp-stack', style: { width: `${dispW}px`, height: `${dispH}px` } }, h('img', { class: 'cmp-img', src: imgB.src, style: { width: `${dispW}px`, height: `${dispH}px` } }));
        hotspotBox(wrap, bw, bh, dispW, dispH);
        row.appendChild(h('figure', {}, h('figcaption', {}, `B · ${label(rightSel)} · ${bw}×${bh}`), wrap));
      }
      stage.appendChild(row);
      return;
    }
    if (!imgA || !imgB) {
      stage.appendChild(h('div', { class: 'empty-state' }, 'This mode needs both A and B.'));
      return;
    }
    const s = scaleFor(bw, bh);
    const W = Math.round(bw * s);
    const H = Math.round(bh * s);
    const wrap = h('div', { class: 'cmp-stack', style: { width: `${W}px`, height: `${H}px` } });
    if (mode === 'overlay') {
      wrap.append(h('img', { class: 'cmp-img', src: imgB.src, style: { width: `${W}px`, height: `${H}px` } }), h('img', { class: 'cmp-img top', src: imgA.src, style: { width: `${W}px`, height: `${H}px`, opacity: opacity.value } }));
    } else if (mode === 'diff') {
      const c = document.createElement('canvas');
      c.width = bw;
      c.height = bh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(imgA, 0, 0, bw, bh);
      const a = ctx.getImageData(0, 0, bw, bh);
      ctx.clearRect(0, 0, bw, bh);
      ctx.drawImage(imgB, 0, 0, bw, bh);
      const b = ctx.getImageData(0, 0, bw, bh);
      const out = ctx.createImageData(bw, bh);
      for (let i = 0; i < out.data.length; i += 4) {
        const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
        const base = (b.data[i] * 0.2126 + b.data[i + 1] * 0.7152 + b.data[i + 2] * 0.0722) * 0.3;
        const t = Math.min(1, d / 48);
        out.data[i] = base * (1 - t) + 255 * t;
        out.data[i + 1] = base * (1 - t) + 70 * t;
        out.data[i + 2] = base * (1 - t) + 90 * t;
        out.data[i + 3] = 255;
      }
      ctx.putImageData(out, 0, 0);
      c.className = 'cmp-img';
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
      wrap.appendChild(c);
    } else if (mode === 'swipe') {
      const topWrap = h('div', { class: 'top', style: { width: `${Math.round(W * swipe)}px`, height: `${H}px`, overflow: 'hidden' } }, h('img', { class: 'cmp-img', src: imgA.src, style: { width: `${W}px`, height: `${H}px`, maxWidth: 'none' } }));
      const handle = h('div', { class: 'swipe-handle', style: { left: `${Math.round(W * swipe)}px` } });
      wrap.append(h('img', { class: 'cmp-img', src: imgB.src, style: { width: `${W}px`, height: `${H}px` } }), topWrap, handle);
      wrap.addEventListener('mousemove', (e) => {
        if (!(e.buttons & 1)) return;
        const r = wrap.getBoundingClientRect();
        swipe = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        topWrap.style.width = `${Math.round(W * swipe)}px`;
        handle.style.left = `${Math.round(W * swipe)}px`;
      });
    }
    hotspotBox(wrap, bw, bh, W, H);
    stage.appendChild(h('figure', { style: { margin: 0 } }, h('figcaption', { class: 'muted small', style: { marginBottom: '4px' } }, `A (${label(leftSel)}) over B (${label(rightSel)})`), wrap));
  }

  function label(sel) {
    return sel.options[sel.selectedIndex]?.textContent || '';
  }

  function enableDraw(wrap, natW, natH, dispW, dispH) {
    wrap.classList.add('drawing');
    let start = null;
    let box = null;
    wrap.addEventListener('mousedown', (e) => {
      const r = wrap.getBoundingClientRect();
      start = [e.clientX - r.left, e.clientY - r.top];
      box = h('div', { class: 'region-box', style: { left: `${start[0]}px`, top: `${start[1]}px`, width: '0', height: '0' } });
      wrap.appendChild(box);
      e.preventDefault();
    });
    wrap.addEventListener('mousemove', (e) => {
      if (!start) return;
      const r = wrap.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      Object.assign(box.style, { left: `${Math.min(x, start[0])}px`, top: `${Math.min(y, start[1])}px`, width: `${Math.abs(x - start[0])}px`, height: `${Math.abs(y - start[1])}px` });
    });
    wrap.addEventListener('mouseup', async (e) => {
      if (!start) return;
      const r = wrap.getBoundingClientRect();
      const x0 = Math.min(start[0], e.clientX - r.left);
      const y0 = Math.min(start[1], e.clientY - r.top);
      const w = Math.abs(e.clientX - r.left - start[0]);
      const hh = Math.abs(e.clientY - r.top - start[1]);
      start = null;
      if (w < 4 || hh < 4) {
        box.remove();
        return;
      }
      const name = prompt('Region name (e.g. sidebar, header, toggle_row):');
      if (!name) {
        box.remove();
        return;
      }
      const widget = prompt('Linked widget / STUDIO_REGION id (optional):', '') || undefined;
      const rect = { name, x: Math.round((x0 / dispW) * natW), y: Math.round((y0 / dispH) * natH), width: Math.round((w / dispW) * natW), height: Math.round((hh / dispH) * natH), widget };
      try {
        await app.op('reference_set_regions', { reference: leftSel.value.slice(4), regions: [rect] });
        await app.refreshState();
        render();
        toast(`Region "${name}" saved`, 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  function renderMetrics(r, title) {
    clear(metrics);
    if (!r) return;
    const m = (v, k) => h('div', { class: 'metric' }, h('div', { class: 'mv' }, v), h('div', { class: 'mk' }, k));
    const pal = (list) => h('div', { class: 'swatches' }, ...(list || []).map((p) => h('div', { class: 'swatch', title: `${p.color} ${Math.round(p.share * 100)}%`, style: { background: p.color } })));
    metrics.append(
      h('div', { class: 'row' }, h('strong', {}, title), h('span', { class: 'grow' }), r.comparison_image ? h('a', { class: 'src', href: r.comparison_image, target: '_blank' }, 'composite image') : null),
      h(
        'div',
        { class: 'metric-grid' },
        m(r.similarity ?? '—', 'similarity / 100'),
        r.perceptual ? m(r.perceptual.ssim, 'SSIM') : null,
        r.pixel ? m(`${(r.pixel.mismatch_ratio * 100).toFixed(1)}%`, 'pixels differ') : null,
        r.edges ? m(r.edges.f1, 'edge alignment F1') : null,
        r.color ? m(r.color.mean_delta_e, 'mean colour ΔE') : null,
        r.layout ? m(`${r.layout.estimated_offset?.dx ?? r.layout.delta?.x ?? 0}, ${r.layout.estimated_offset?.dy ?? r.layout.delta?.y ?? 0}`, r.layout.delta ? 'region Δx, Δy' : 'est. offset dx, dy') : null,
      ),
      r.summary ? h('div', { class: 'small muted' }, ...r.summary.map((s) => h('div', {}, `• ${s}`))) : null,
      r.color ? h('div', { class: 'row small', style: { marginTop: '6px' } }, h('span', { class: 'muted' }, 'Palette A'), pal(r.color.reference_palette), h('span', { class: 'muted' }, 'B'), pal(r.color.current_palette)) : null,
      r.hotspots?.length
        ? h(
            'div',
            { style: { marginTop: '6px' } },
            h('div', { class: 'muted small' }, 'Hotspots (hover to locate on B):'),
            ...r.hotspots.map((s) =>
              h(
                'div',
                { class: 'hotspot', onmouseenter: () => { hoverSpot = s; render(); }, onmouseleave: () => { hoverSpot = null; render(); } },
                `(${s.x}, ${s.y}) ${s.width}×${s.height}  diff ${s.mean_diff}${s.widgets?.length ? `  → ${s.widgets.join(', ')}` : ''}`,
              ),
            ),
          )
        : null,
    );
  }

  metricsBtn.onclick = async () => {
    const a = leftSel.value;
    const b = rightSel.value;
    metricsBtn.disabled = true;
    try {
      let r;
      let title;
      if (a.startsWith('ref:') && (b === 'live' || b.startsWith('cap:') || b.startsWith('build:'))) {
        const args = { reference: a.slice(4) };
        if (b.startsWith('cap:')) args.capture_id = b.slice(4);
        if (b.startsWith('build:')) args.capture_id = `build-${b.slice(6)}`;
        r = await app.op('reference_compare', args);
        title = `Reference "${a.slice(4)}" vs ${b === 'live' ? 'agent preview (fresh capture)' : label(rightSel)}`;
        if (b === 'live' && r.current?.url) {
          imgB = await loadImage(r.current.url);
          render();
        }
      } else if (a.startsWith('build:') && b.startsWith('build:')) {
        r = await app.op('history_compare_builds', { a: Number(a.slice(6)), b: Number(b.slice(6)) });
        title = `Build #${a.slice(6)} vs #${b.slice(6)}`;
      } else {
        toast('Metrics need A = reference or build, and B = live/capture/build.');
        return;
      }
      lastResult = r;
      renderMetrics(r, title);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      metricsBtn.disabled = false;
    }
  };

  drawBtn.onclick = () => {
    if (!leftSel.value.startsWith('ref:')) {
      toast('Choose a reference as A to draw regions on it.');
      return;
    }
    drawing = !drawing;
    drawBtn.classList.toggle('on', drawing);
    if (drawing && mode !== 'side') {
      mode = 'side';
      for (const b of modeSeg.children) b.classList.toggle('active', b.textContent === 'Side by side');
    }
    render();
  };

  leftSel.onchange = load;
  rightSel.onchange = load;
  opacity.oninput = () => mode === 'overlay' && render();
  zoomSel.onchange = render;
  app.bus.on('layout', () => app.centerView === 'compare' && render());
  window.addEventListener('resize', () => app.centerView === 'compare' && render());
  app.bus.on('center-view', (v) => {
    if (v === 'compare') {
      options();
      load();
    }
  });
  app.bus.on('state', () => {
    if (app.centerView === 'compare') options();
  });

  app.compare = {
    async show({ a, b, result, title } = {}) {
      app.bus.emit('center-view', 'compare');
      options();
      if (a) leftSel.value = a;
      if (b) rightSel.value = b;
      await load();
      if (result) renderMetrics(result, title || 'Comparison');
    },
    get last() {
      return lastResult;
    },
    get urlB() {
      return urlB;
    },
  };
}
