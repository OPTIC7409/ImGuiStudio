// Splitters and tab switching.
import { drag } from './ui.js';

const KEY = 'imgui-studio.layout';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function save(v) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // storage unavailable
  }
}

export function initLayout(app) {
  const root = document.documentElement;
  const saved = load();
  for (const [k, v] of Object.entries(saved)) root.style.setProperty(k, v);
  const px = (name) => parseFloat(getComputedStyle(root).getPropertyValue(name));

  for (const s of document.querySelectorAll('.vsplit')) {
    const side = s.dataset.side;
    let start;
    s.addEventListener('mousedown', () => {
      start = side === 'left' ? document.getElementById('left').getBoundingClientRect().width : document.getElementById('right').getBoundingClientRect().width;
    });
    drag(s, {
      cursor: 'col-resize',
      onMove: (dx) => {
        const w = Math.max(200, Math.min(window.innerWidth * 0.7, side === 'left' ? start + dx : start - dx));
        root.style.setProperty(side === 'left' ? '--left-w' : '--right-w', `${w}px`);
        app.bus.emit('layout');
      },
      onEnd: () => persist(),
    });
  }

  const treeSplit = document.querySelector('.hsplit[data-target="file-tree"]');
  let treeStart;
  treeSplit.addEventListener('mousedown', () => (treeStart = px('--tree-h')));
  drag(treeSplit, {
    cursor: 'row-resize',
    onMove: (_dx, dy) => {
      root.style.setProperty('--tree-h', `${Math.max(40, Math.min(window.innerHeight * 0.6, treeStart + dy))}px`);
      app.bus.emit('layout');
    },
    onEnd: () => persist(),
  });

  const bottomSplit = document.querySelector('.bottom-split');
  let bottomStart;
  bottomSplit.addEventListener('mousedown', () => (bottomStart = px('--bottom-h')));
  drag(bottomSplit, {
    cursor: 'row-resize',
    onMove: (_dx, dy) => {
      root.style.setProperty('--bottom-h', `${Math.max(60, Math.min(window.innerHeight * 0.7, bottomStart - dy))}px`);
      app.bus.emit('layout');
    },
    onEnd: () => persist(),
  });

  function persist() {
    const v = {};
    for (const k of ['--left-w', '--right-w', '--bottom-h', '--tree-h']) {
      const val = root.style.getPropertyValue(k);
      if (val) v[k] = val;
    }
    save(v);
  }

  // Tab groups
  setupTabs(app, 'right-tabs', 'tab', (name) => app.bus.emit('right-tab', name));
  setupTabs(app, 'bottom-tabs', 'tab', (name) => app.bus.emit('bottom-tab', name));
  const center = document.getElementById('center-tabs');
  center.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) app.bus.emit('center-view', b.dataset.view);
  });
  app.bus.on('center-view', (view) => {
    for (const b of center.querySelectorAll('button')) b.classList.toggle('active', b.dataset.view === view);
    for (const v of document.querySelectorAll('#center .view')) v.classList.toggle('active', v.id === `view-${view}`);
    document.getElementById('preview-tools').style.display = view === 'preview' ? '' : 'none';
    app.centerView = view;
  });
  app.centerView = 'preview';
  app.bus.on('show-right', (name) => document.querySelector(`#right-tabs button[data-tab="${name}"]`)?.click());
  app.bus.on('show-bottom', (name) => document.querySelector(`#bottom-tabs button[data-tab="${name}"]`)?.click());
}

function setupTabs(app, id, prefix, onChange) {
  const bar = document.getElementById(id);
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    for (const x of bar.querySelectorAll('button[data-tab]')) x.classList.toggle('active', x === b);
    const panel = bar.parentElement;
    for (const body of panel.querySelectorAll(':scope > .tab-body')) body.hidden = body.id !== `${prefix}-${b.dataset.tab}`;
    onChange(b.dataset.tab);
  });
}
