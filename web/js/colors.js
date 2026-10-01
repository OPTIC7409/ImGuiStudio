// Colors tab: every colour literal in the project, Figma-style. "Theme" lists the named
// ones (C.bg_root, ImGuiCol_Text, kAccents[2] ...); "All colors" groups identical colours
// so one edit recolours every use. Edits rewrite the C++ literals in place and rebuild.
import { h, clear, toast } from './ui.js';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const hex2 = (v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0');
const toHex = (rgb) => rgb.slice(0, 3).map(hex2).join('').toUpperCase();
const css = (rgba) => `rgba(${rgba.slice(0, 3).map((x) => Math.round(x * 255)).join(',')},${rgba[3]})`;

function parseHex(s) {
  let t = String(s).trim().replace(/^#|^0x/i, '');
  if (/^[0-9a-f]{3}$/i.test(t)) t = t.replace(/./g, '$&$&');
  if (!/^[0-9a-f]{6}$/i.test(t)) return null;
  const v = parseInt(t, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function rgbToHsv([r, g, b]) {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let hue = 0;
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return [hue, max ? d / max : 0, max];
}

function hsvToRgb([hue, s, v]) {
  const f = (n) => {
    const k = (n + hue / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

function swatch(rgba, extra = {}) {
  return h('span', { class: 'swatch', ...extra }, h('span', { style: { background: css(rgba) } }));
}

// Pointer drag inside an element, reporting 0..1 coordinates.
function draggable(el, onMove, onEnd) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = el.getBoundingClientRect();
      onMove(clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height));
    };
    move(e);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onEnd();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

// Figma-like picker: saturation/value field, hue and alpha strips, hex + opacity inputs,
// project swatches. onInput fires while dragging, onCommit when a change is settled.
function openPicker({ anchor, title, rgba, palette, onInput, onCommit }) {
  document.querySelector('.color-picker')?.dispatchEvent(new Event('close'));
  const original = rgba.slice();
  let hsv = rgbToHsv(rgba);
  let alpha = rgba[3];

  const svKnob = h('span', { class: 'cp-knob' });
  const sv = h('div', { class: 'cp-sv' }, h('div', { class: 'cp-sv-white' }), h('div', { class: 'cp-sv-black' }), svKnob);
  const hueKnob = h('span', { class: 'cp-knob' });
  const hue = h('div', { class: 'cp-strip cp-hue' }, hueKnob);
  const alphaFill = h('div', { class: 'cp-alpha-fill' });
  const alphaKnob = h('span', { class: 'cp-knob' });
  const alphaStrip = h('div', { class: 'cp-strip cp-alpha' }, alphaFill, alphaKnob);
  const hexIn = h('input', { type: 'text', class: 'cp-hex', spellcheck: 'false', maxlength: 7 });
  const alphaIn = h('input', { type: 'text', class: 'cp-pct', maxlength: 4 });
  const preview = swatch(rgba);

  const current = () => [...hsvToRgb(hsv), alpha];
  function paint(fromInputs = false) {
    const rgb = hsvToRgb(hsv);
    sv.style.background = `hsl(${hsv[0]}, 100%, 50%)`;
    svKnob.style.left = `${hsv[1] * 100}%`;
    svKnob.style.top = `${(1 - hsv[2]) * 100}%`;
    svKnob.style.background = css([...rgb, 1]);
    hueKnob.style.left = `${(hsv[0] / 360) * 100}%`;
    hueKnob.style.background = `hsl(${hsv[0]}, 100%, 50%)`;
    alphaFill.style.background = `linear-gradient(to right, ${css([...rgb, 0])}, ${css([...rgb, 1])})`;
    alphaKnob.style.left = `${alpha * 100}%`;
    preview.firstChild.style.background = css(current());
    if (!fromInputs) {
      hexIn.value = toHex(rgb);
      alphaIn.value = `${Math.round(alpha * 100)}%`;
    }
  }

  let timer = 0;
  const input = () => onInput(current());
  const commit = (delay = 0) => {
    clearTimeout(timer);
    timer = setTimeout(() => onCommit(current()), delay);
  };
  draggable(sv, (x, y) => { hsv = [hsv[0], x, 1 - y]; paint(); input(); }, () => commit());
  draggable(hue, (x) => { hsv = [x * 360 >= 360 ? 359.9 : x * 360, hsv[1], hsv[2]]; paint(); input(); }, () => commit());
  draggable(alphaStrip, (x) => { alpha = Math.round(x * 100) / 100; paint(); input(); }, () => commit());
  const applyHex = () => {
    const rgb = parseHex(hexIn.value);
    if (!rgb) return paint();
    hsv = rgbToHsv(rgb);
    paint();
    input();
    commit();
  };
  const applyAlpha = () => {
    const v = parseFloat(alphaIn.value);
    if (Number.isNaN(v)) return paint();
    alpha = clamp(v / 100);
    paint();
    input();
    commit();
  };
  hexIn.addEventListener('change', applyHex);
  alphaIn.addEventListener('change', applyAlpha);
  for (const el of [hexIn, alphaIn]) el.addEventListener('keydown', (e) => e.key === 'Enter' && el.blur());

  const set = (c) => {
    hsv = rgbToHsv(c);
    alpha = c[3];
    paint();
    input();
    commit();
  };
  const chips = palette.length
    ? h('div', { class: 'cp-palette' }, h('div', { class: 'cp-label' }, 'In this project'), h('div', { class: 'cp-chips' }, palette.map((c) => swatch(c, { title: `#${toHex(c)}${c[3] < 1 ? ` · ${Math.round(c[3] * 100)}%` : ''}`, onclick: () => set(c) }))))
    : null;

  const box = h(
    'div',
    { class: 'color-picker', role: 'dialog' },
    h('header', {}, h('span', { class: 'cp-title', title }, title), h('button', { class: 'icon', title: 'Reset to the colour it had when opened', onclick: () => set(original) }, '↺'), h('button', { class: 'icon', title: 'Close', onclick: () => close() }, '✕')),
    sv,
    h('div', { class: 'cp-strips' }, h('div', { class: 'cp-strip-col' }, hue, alphaStrip), preview),
    h('div', { class: 'cp-fields' }, h('span', { class: 'cp-label' }, 'Hex'), h('span', { class: 'cp-hash' }, '#'), hexIn, alphaIn),
    chips,
  );
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  const bw = box.offsetWidth;
  const bh = box.offsetHeight;
  box.style.left = `${clamp(r.left - bw - 8, 8, window.innerWidth - bw - 8)}px`;
  box.style.top = `${clamp(r.top - 40, 8, window.innerHeight - bh - 8)}px`;
  paint();

  const onDoc = (e) => {
    if (!box.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  function close() {
    clearTimeout(timer);
    box.remove();
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey);
  }
  box.addEventListener('close', close);
  setTimeout(() => document.addEventListener('pointerdown', onDoc, true));
  document.addEventListener('keydown', onKey);
  return { close };
}

export function initColors(app) {
  const root = document.getElementById('tab-colors');
  let data = { colors: [], groups: [] };
  let filter = '';
  let loaded = false;
  const expanded = new Set();

  // One write at a time; while one is in flight only the latest colour is kept.
  let busy = false;
  let pending = null;
  async function apply(target, rgba) {
    pending = { target, rgba };
    if (busy) return;
    busy = true;
    try {
      while (pending) {
        const { target: t, rgba: c } = pending;
        pending = null;
        const edits = t.edits();
        if (!edits.length) break;
        await app.editor?.saveAll();
        data = await app.op('colors_set', { edits, rgba: c });
        t.committed(c);
        render();
        if (!document.getElementById('auto-build')?.checked) app.build();
      }
    } catch (e) {
      toast(e.message, 'err');
      await refresh();
    } finally {
      busy = false;
    }
  }

  const byId = () => new Map(data.colors.map((c) => [c.id, c]));
  const palette = () => data.groups.slice(0, 24).map((g) => g.rgba);

  // Edit one literal; its id (file:offset) survives its own rewrite.
  function editOne(c, anchor, rowSwatch) {
    const id = c.id;
    openPicker({
      anchor,
      title: `${c.name || c.literal} · ${c.file}:${c.line}`,
      rgba: c.rgba,
      palette: palette(),
      onInput: (rgba) => (rowSwatch.firstChild.style.background = css(rgba)),
      onCommit: (rgba) =>
        apply({ edits: () => [byId().get(id)].filter(Boolean).map((x) => ({ id: x.id, literal: x.literal })), committed: () => {} }, rgba),
    });
  }

  // Edit every use of a colour; afterwards the group is found again by its new value.
  function editGroup(g, anchor, rowSwatch) {
    let key = g.key;
    openPicker({
      anchor,
      title: `${g.uses.length} use${g.uses.length === 1 ? '' : 's'} of #${g.hex.slice(1)}`,
      rgba: g.rgba,
      palette: palette(),
      onInput: (rgba) => (rowSwatch.firstChild.style.background = css(rgba)),
      onCommit: (rgba) =>
        apply(
          {
            edits: () => {
              const grp = data.groups.find((x) => x.key === key);
              const m = byId();
              return grp ? grp.uses.map((id) => m.get(id)).filter(Boolean).map((x) => ({ id: x.id, literal: x.literal })) : [];
            },
            committed: (c) => (key = `#${toHex(c)}/${Math.round(c[3] * 100)}`),
          },
          rgba,
        ),
    });
  }

  const matches = (c) => !filter || `${c.name || ''} ${c.hex} ${c.file} ${c.literal}`.toLowerCase().includes(filter);
  const alphaLabel = (a) => (a < 100 ? h('span', { class: 'clr-alpha' }, `${a}%`) : null);

  function row(c) {
    const sw = swatch(c.rgba);
    const el = h(
      'div',
      { class: 'clr-row', title: `${c.context}\n${c.file}:${c.line}` },
      sw,
      h('span', { class: 'clr-name' }, c.name || c.literal),
      h('span', { class: 'clr-hex' }, c.hex.slice(1)),
      alphaLabel(c.alpha),
      h('button', { class: 'icon clr-go', title: `Open ${c.file}:${c.line}`, onclick: (e) => { e.stopPropagation(); app.openFile?.(c.file, c.line, c.column); } }, '↗'),
    );
    el.addEventListener('click', () => editOne(c, el, sw));
    return el;
  }

  function render() {
    const scrollTop = root.scrollTop;
    clear(root);
    const search = h('input', { type: 'text', placeholder: 'Filter colours (name, hex, file)…', value: filter });
    search.addEventListener('input', () => {
      filter = search.value.trim().toLowerCase();
      render();
      const s = root.querySelector('.insp-search input');
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    });
    root.append(h('div', { class: 'insp-search' }, search, h('button', { class: 'icon', title: 'Rescan sources', onclick: () => refresh() }, '⟳')));

    if (!loaded) return root.append(h('div', { class: 'empty-state' }, 'Scanning sources…'));
    if (!data.colors.length) {
      return root.append(h('div', { class: 'empty-state' }, 'No colour literals found. Colours written as Hex(0xRRGGBB), ImVec4(r, g, b, a), ImColor(...) or IM_COL32(...) show up here.'));
    }

    const named = data.colors.filter((c) => c.named && matches(c));
    if (named.length) {
      const byFile = new Map();
      for (const c of named) {
        if (!byFile.has(c.file)) byFile.set(c.file, []);
        byFile.get(c.file).push(c);
      }
      root.append(
        h('div', { class: 'section clr-section' }, h('h4', {}, 'Theme colors', h('span', { class: 'faint' }, String(named.length))), [...byFile].sort(([a], [b]) => /theme|style|color|palette/i.test(b) - /theme|style|color|palette/i.test(a)).map(([file, list]) => [h('div', { class: 'clr-file' }, file), list.map(row)])),
      );
    }

    const m = byId();
    const groups = data.groups.filter((g) => g.uses.some((id) => matches(m.get(id))));
    root.append(
      h(
        'div',
        { class: 'section clr-section' },
        h('h4', {}, 'All colors', h('span', { class: 'faint' }, `${groups.length} unique`)),
        groups.map((g) => {
          const sw = swatch(g.rgba);
          const open = expanded.has(g.key);
          const head = h(
            'div',
            { class: 'clr-row', title: 'Edit every use of this colour' },
            sw,
            h('span', { class: 'clr-name mono' }, g.hex.slice(1)),
            alphaLabel(g.alpha),
            h('span', { class: 'clr-uses' }, `${g.uses.length} use${g.uses.length === 1 ? '' : 's'}`),
            h('button', { class: `icon clr-caret${open ? ' open' : ''}`, title: open ? 'Hide uses' : 'Show uses', onclick: (e) => { e.stopPropagation(); open ? expanded.delete(g.key) : expanded.add(g.key); render(); } }, '›'),
          );
          head.addEventListener('click', () => editGroup(g, head, sw));
          return [head, open ? h('div', { class: 'clr-uses-list' }, g.uses.map((id) => m.get(id)).filter(Boolean).map(row)) : null];
        }),
      ),
    );
    root.scrollTop = scrollTop;
  }

  async function refresh() {
    try {
      data = await app.op('colors_list', {});
      loaded = true;
      render();
    } catch (e) {
      clear(root).append(h('div', { class: 'empty-state' }, `Could not scan colours: ${e.message}`));
    }
  }

  let visible = false;
  let stale = true;
  let timer = 0;
  app.bus.on('right-tab', (name) => {
    visible = name === 'colors';
    if (visible && stale) {
      stale = false;
      refresh();
    }
  });
  app.bus.on('server:files_changed', () => {
    if (busy) return;
    if (!visible) return void (stale = true);
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  });
  render();
}
