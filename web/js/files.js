// Project file tree.
import { h, clear, debounce, fileIcon, toast } from './ui.js';

const EXPANDED_KEY = 'imgui-studio.expanded';

export function initFiles(app) {
  const el = document.getElementById('file-tree');
  let files = [];
  let errorFiles = new Set();
  let expanded;
  try {
    expanded = new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY)) || ['src', 'widgets', 'theme']);
  } catch {
    expanded = new Set(['src', 'widgets', 'theme']);
  }

  function saveExpanded() {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
    } catch {
      // ignore
    }
  }

  function tree() {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
        node = node.dirs.get(parts[i]);
      }
      node.files.push(f.path);
    }
    return root;
  }

  function render() {
    clear(el);
    const active = app.editor?.activePath;
    const walk = (node, prefix, depth) => {
      const dirs = [...node.dirs.keys()].sort();
      for (const d of dirs) {
        const p = prefix ? `${prefix}/${d}` : d;
        const open = expanded.has(p);
        const hasErr = [...errorFiles].some((f) => f.startsWith(`${p}/`));
        el.appendChild(
          h(
            'div',
            {
              class: 'tree-row',
              style: { paddingLeft: `${10 + depth * 12}px` },
              onclick: () => {
                if (open) expanded.delete(p);
                else expanded.add(p);
                saveExpanded();
                render();
              },
            },
            h('span', { class: 'tw' }, open ? '▾' : '▸'),
            h('span', {}, d),
            hasErr && !open ? h('span', { class: 'err-dot' }, '●') : null,
          ),
        );
        if (open) walk(node.dirs.get(d), p, depth + 1);
      }
      for (const f of node.files.sort()) {
        const name = f.split('/').pop();
        const [cls, ico] = fileIcon(f);
        el.appendChild(
          h(
            'div',
            { class: `tree-row${f === active ? ' active' : ''}`, style: { paddingLeft: `${10 + depth * 12}px` }, onclick: () => app.openFile(f), title: f },
            h('span', { class: 'tw' }),
            h('span', { class: `fi ${cls}` }, ico),
            h('span', {}, name),
            errorFiles.has(f) ? h('span', { class: 'err-dot' }, '●') : null,
          ),
        );
      }
    };
    walk(tree(), '', 0);
  }

  async function refresh() {
    try {
      files = (await app.op('project_list_files', {})).files;
      render();
      app.bus.emit('files', files);
    } catch (e) {
      toast(`Could not list files: ${e.message}`, 'err');
    }
  }

  app.files = { refresh, list: () => files };
  document.getElementById('btn-refresh-files').onclick = refresh;
  document.getElementById('btn-new-file').onclick = async () => {
    const p = prompt('New file path (relative to the project), e.g. widgets/knob.cpp');
    if (!p) return;
    try {
      await app.op('project_write_file', { path: p, content: '' });
      await refresh();
      app.openFile(p);
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  const debounced = debounce(refresh, 300);
  app.bus.on('server:files_changed', debounced);
  app.bus.on('active-file', render);
  app.bus.on('server:build_finished', (b) => {
    errorFiles = new Set((b.errors || []).map((e) => e.file).filter(Boolean));
    render();
  });
  const lb = app.state?.latest_build;
  if (lb && !lb.success) app.op('build_errors', {}).then((r) => {
    errorFiles = new Set((r.errors || []).map((e) => e.file).filter(Boolean));
    render();
  }).catch(() => {});
  refresh();
}
