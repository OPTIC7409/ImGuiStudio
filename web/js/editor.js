// Source editor (Monaco) with tabs, save, external-change reload and build error markers.
import { h, clear, toast, languageFor, isTextFile, modal } from './ui.js';

function loadMonaco() {
  return new Promise((resolve, reject) => {
    if (!window.require) return reject(new Error('Monaco loader unavailable'));
    window.MonacoEnvironment = {
      getWorkerUrl() {
        const base = `${location.origin}/vendor/monaco/`;
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(`self.MonacoEnvironment={baseUrl:'${base}'};importScripts('${base}vs/base/worker/workerMain.js');`)}`;
      },
    };
    window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
    window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
  });
}

export async function initEditor(app) {
  const container = document.getElementById('editor');
  const tabsEl = document.getElementById('editor-tabs');
  const banner = document.getElementById('editor-banner');
  let monaco = null;
  let editor = null;
  const docs = new Map(); // path -> { model, savedVersion, diskContent, viewState, stale }
  let active = null;
  let lastDiagnostics = [];

  try {
    monaco = await loadMonaco();
    monaco.editor.defineTheme('studio-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6b7385', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'c792ea' },
        { token: 'number', foreground: 'f5b83d' },
        { token: 'string', foreground: '9ece6a' },
      ],
      colors: {
        'editor.background': '#13161c',
        'editor.lineHighlightBackground': '#1a1e27',
        'editorLineNumber.foreground': '#454d5d',
        'editorGutter.background': '#13161c',
        'editor.selectionBackground': '#2b4170',
        'editorWidget.background': '#181c24',
      },
    });
    editor = monaco.editor.create(container, {
      theme: 'studio-dark',
      automaticLayout: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
      minimap: { enabled: true, scale: 1, renderCharacters: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      glyphMargin: true,
      tabSize: 4,
      insertSpaces: true,
      model: null,
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save(active));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => app.build());
    editor.onDidChangeModelContent(() => {
      renderTabs();
      scheduleLinks(400);
    });
  } catch (e) {
    console.error(e);
    toast('Monaco editor failed to load; using a plain text editor.', 'err');
  }

  let fallback = null;
  if (!editor) {
    fallback = h('textarea', { class: 'mono', style: { width: '100%', height: '100%', resize: 'none', background: '#13161c', border: '0', padding: '10px' }, spellcheck: 'false' });
    container.appendChild(fallback);
    fallback.addEventListener('input', () => {
      const d = docs.get(active);
      if (d) d.fallbackText = fallback.value;
      renderTabs();
    });
    fallback.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save(active);
      }
    });
  }

  const textOf = (d) => (d.model ? d.model.getValue() : d.fallbackText ?? d.diskContent);
  const isDirty = (d) => (d.model ? d.model.getAlternativeVersionId() !== d.savedVersion : (d.fallbackText ?? d.diskContent) !== d.diskContent);

  function showEmpty() {
    if (editor) editor.setModel(null);
    if (!docs.size) {
      if (!container.querySelector('.empty')) container.appendChild(h('div', { class: 'empty', style: { position: 'absolute', inset: '0', pointerEvents: 'none' } }, 'Open a file from the tree. Ctrl+S saves, Ctrl+B builds.'));
    }
  }

  function renderTabs() {
    clear(tabsEl);
    for (const [p, d] of docs) {
      const name = p.split('/').pop();
      tabsEl.appendChild(
        h(
          'button',
          { class: p === active ? 'active' : '', title: p, onclick: () => show(p), onauxclick: (e) => e.button === 1 && close(p) },
          isDirty(d) ? h('span', { class: 'dirty' }, '●') : null,
          name,
          h('span', { class: 'close', onclick: (e) => { e.stopPropagation(); close(p); } }, '✕'),
        ),
      );
    }
    container.style.position = 'relative';
    const empty = container.querySelector('.empty');
    if (docs.size && empty) empty.remove();
  }

  function updateBanner() {
    const d = docs.get(active);
    if (!d || !d.stale) {
      banner.hidden = true;
      return;
    }
    clear(banner);
    banner.hidden = false;
    banner.append(
      h('span', {}, `${active} changed on disk (probably by the agent) while you have unsaved edits.`),
      h('button', { onclick: () => reloadFromDisk(active, true) }, 'Load disk version'),
      h('button', { onclick: () => { d.stale = false; updateBanner(); } }, 'Keep mine'),
    );
  }

  async function open(path, line = null, column = null) {
    if (!isTextFile(path)) {
      if (/\.(png|jpe?g|gif|svg)$/i.test(path)) {
        modal({ title: path, body: h('img', { src: `/project-files/${path}` }) });
      } else toast(`${path} is not a text file`);
      return;
    }
    if (!docs.has(path)) {
      let content;
      try {
        content = (await app.op('project_read_file', { path })).content;
      } catch (e) {
        toast(e.message, 'err');
        return;
      }
      const d = { diskContent: content, stale: false };
      if (monaco) {
        const uri = monaco.Uri.parse(`file:///${path}`);
        d.model = monaco.editor.getModel(uri) || monaco.editor.createModel(content, languageFor(path), uri);
        d.model.setValue(content);
        d.savedVersion = d.model.getAlternativeVersionId();
      }
      docs.set(path, d);
    }
    show(path);
    if (line && editor) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: column || 1 });
      editor.focus();
    }
    applyMarkers();
  }

  function show(path) {
    const prev = docs.get(active);
    if (prev && editor) prev.viewState = editor.saveViewState();
    active = path;
    const d = docs.get(path);
    if (editor) {
      editor.setModel(d.model);
      if (d.viewState) editor.restoreViewState(d.viewState);
    } else if (fallback) {
      fallback.value = textOf(d);
    }
    renderTabs();
    updateBanner();
    scheduleLinks(0);
    app.bus.emit('active-file', path);
  }

  function close(path) {
    const d = docs.get(path);
    if (!d) return;
    if (isDirty(d) && !confirm(`${path} has unsaved changes. Close anyway?`)) return;
    d.model?.dispose();
    docs.delete(path);
    if (active === path) {
      const next = [...docs.keys()].pop();
      active = null;
      if (next) show(next);
      else {
        showEmpty();
        app.bus.emit('active-file', null);
      }
    }
    renderTabs();
  }

  async function save(path) {
    const d = docs.get(path);
    if (!d || !isDirty(d)) return;
    const content = textOf(d);
    try {
      await app.op('project_write_file', { path, content });
      d.diskContent = content;
      if (d.model) d.savedVersion = d.model.getAlternativeVersionId();
      d.stale = false;
      renderTabs();
      updateBanner();
    } catch (e) {
      toast(`Save failed: ${e.message}`, 'err');
    }
  }

  async function saveAll() {
    for (const p of docs.keys()) await save(p);
  }

  async function reloadFromDisk(path, force = false) {
    const d = docs.get(path);
    if (!d) return;
    let content;
    try {
      content = (await app.op('project_read_file', { path })).content;
    } catch {
      return; // deleted
    }
    if (content === d.diskContent && !force) return;
    if (isDirty(d) && !force) {
      d.stale = true;
      updateBanner();
      return;
    }
    d.diskContent = content;
    d.stale = false;
    if (d.model) {
      const vs = active === path && editor ? editor.saveViewState() : null;
      d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text: content }], () => null);
      d.savedVersion = d.model.getAlternativeVersionId();
      if (vs) editor.restoreViewState(vs);
    } else if (active === path && fallback) {
      d.fallbackText = content;
      fallback.value = content;
    }
    renderTabs();
    updateBanner();
    applyMarkers();
  }

  function applyMarkers() {
    if (!monaco) return;
    for (const [p, d] of docs) {
      const markers = lastDiagnostics
        .filter((x) => x.file === p && x.line > 0)
        .map((x) => ({
          severity: x.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          message: x.message + (x.notes?.length ? `\n${x.notes.map((n) => (typeof n === 'string' ? n : `${n.file}:${n.line}: ${n.message}`)).join('\n')}` : ''),
          startLineNumber: x.line,
          startColumn: Math.max(1, x.column || 1),
          endLineNumber: x.line,
          endColumn: Math.max(1, x.column || 1) + 1,
          source: x.flag || 'clang',
        }));
      monaco.editor.setModelMarkers(d.model, 'build', markers);
    }
  }

  app.bus.on('server:files_changed', ({ paths }) => {
    for (const p of paths) if (docs.has(p)) reloadFromDisk(p);
  });
  app.bus.on('server:build_finished', (b) => {
    lastDiagnostics = [...(b.errors || []), ...(b.warnings || [])];
    applyMarkers();
  });

  app.openFile = open;

  // Code <-> preview. Lines that create a widget visible in the preview get a gutter
  // marker (a string literal matching the widget's label or id, or the line of its
  // STUDIO_ macro). The widgets on the cursor's line are highlighted in the preview,
  // and clicking a marker selects its widget.
  let lineWidgets = new Map(); // line -> [widget]
  let glyphIds = [];
  let linkTimer = 0;
  function scheduleLinks(ms = 250) {
    clearTimeout(linkTimer);
    linkTimer = setTimeout(refreshWidgetLinks, ms);
  }
  function literals(text) {
    const out = [];
    const re = /"((?:[^"\\\n]|\\.)*)"/g;
    let m;
    while ((m = re.exec(text))) out.push(m[1]);
    return out;
  }
  function refreshWidgetLinks() {
    if (!editor || !active) return;
    const d = docs.get(active);
    if (!d?.model || editor.getModel() !== d.model) return;
    const byLabel = new Map();
    const bySource = new Map();
    const add = (map, key, w) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(w);
    };
    for (const w of app.widgets?.widgets || []) {
      if (!w.visible) continue;
      for (const key of new Set([w.raw_label, w.label, w.anonymous ? null : w.id])) if (key && key.length > 1) add(byLabel, key, w);
      for (const src of w.source || []) add(bySource, src, w);
    }
    lineWidgets = new Map();
    const n = d.model.getLineCount();
    for (let i = 1; i <= Math.min(n, 20000); i++) {
      const text = d.model.getLineContent(i);
      const found = new Set(bySource.get(`${active}:${i}`) || []);
      if (text.includes('"')) for (const lit of literals(text)) for (const w of byLabel.get(lit) || []) found.add(w);
      if (found.size) lineWidgets.set(i, [...found]);
    }
    const sel = app.selectedWidget;
    glyphIds = editor.deltaDecorations(
      glyphIds,
      [...lineWidgets].map(([line, ws]) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: `widget-glyph${ws.some((w) => w.id === sel) ? ' sel' : ''}`,
          glyphMarginHoverMessage: {
            value: `${ws
              .slice(0, 6)
              .map((w) => `\`${w.type}\` ${w.id}`)
              .join('  \n')}${ws.length > 6 ? `  \n+${ws.length - 6} more` : ''}  \n_Click to select in the preview_`,
          },
        },
      })),
    );
  }
  if (editor) {
    let cursorTimer = 0;
    let linked = '';
    editor.onDidChangeCursorPosition((e) => {
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => {
        const ids = (lineWidgets.get(e.position.lineNumber) || []).slice(0, 40).map((w) => w.id);
        if (ids.join(',') === linked) return;
        linked = ids.join(',');
        app.preview?.rpc('highlight', { ids }).catch(() => {});
      }, 120);
    });
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const ws = lineWidgets.get(e.target.position.lineNumber);
      if (!ws?.length) return;
      // Clicking again cycles through the widgets on that line.
      const next = ws[(ws.findIndex((w) => w.id === app.selectedWidget) + 1) % ws.length];
      app.bus.emit('select-widget', next.id);
      app.bus.emit('show-right', 'inspector');
    });
    app.bus.on('widgets', () => scheduleLinks(250));
    app.bus.on('selection', () => scheduleLinks(0));
  }
  showEmpty();
  const api = {
    open,
    save,
    saveAll,
    get activePath() {
      return active;
    },
    monaco,
  };

  // Open the main source file initially.
  const initial = ['src/menu.cpp', 'src/main.cpp'];
  const openInitial = (files) => {
    const first = initial.find((p) => files.some((f) => f.path === p)) || files.find((f) => /\.cpp$/.test(f.path))?.path;
    if (first && !docs.size) open(first);
  };
  const known = app.files?.list() || [];
  if (known.length) openInitial(known);
  else {
    const off = app.bus.on('files', (files) => {
      off();
      openInitial(files);
    });
  }
  return api;
}
