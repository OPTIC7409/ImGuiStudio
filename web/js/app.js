// ImGui Studio UI entry point: shared app context, server events, top bar.
import { connectEvents, getState, op } from './api.js';
import { h, clear, toast, modal, fmtMs } from './ui.js';
import { initLayout } from './layout.js';
import { initFiles } from './files.js';
import { initEditor } from './editor.js';
import { initPreview } from './preview-panel.js';
import { initInspector } from './inspector.js';
import { initReference } from './reference.js';
import { initHistory } from './history.js';
import { initCaptures } from './captures.js';
import { initActivity } from './activity.js';
import { initConsole } from './console.js';
import { initCompare } from './compare-view.js';

class Bus {
  constructor() {
    this.map = new Map();
  }
  on(evt, fn) {
    if (!this.map.has(evt)) this.map.set(evt, new Set());
    this.map.get(evt).add(fn);
    return () => this.map.get(evt).delete(fn);
  }
  emit(evt, data) {
    for (const fn of this.map.get(evt) || []) {
      try {
        fn(data);
      } catch (e) {
        console.error(evt, e);
      }
    }
  }
}

const app = {
  bus: new Bus(),
  op,
  state: null,
  building: false,
  lastBuild: null,
  async refreshState() {
    app.state = await getState();
    app.bus.emit('state', app.state);
    return app.state;
  },
};
window.studioApp = app;

function buildPill() {
  const pill = document.getElementById('build-pill');
  pill.onclick = null;
  if (app.building) {
    pill.className = 'pill busy';
    pill.textContent = `Building #${app.building}…`;
    return;
  }
  const b = app.lastBuild;
  if (!b) {
    pill.className = 'pill idle';
    pill.textContent = 'No builds yet';
    return;
  }
  if (b.success) {
    pill.className = 'pill ok';
    pill.textContent = `✓ Build #${b.id ?? b.build_id} · ${fmtMs(b.duration_ms)}${b.score != null ? ` · ${b.score}` : ''}`;
  } else {
    const n = b.errors?.length ?? b.errors ?? 0;
    pill.className = 'pill err';
    pill.textContent = `✗ Build #${b.id ?? b.build_id} · ${n} error${n === 1 ? '' : 's'}`;
    pill.onclick = () => app.bus.emit('show-bottom', 'problems');
  }
}

async function build() {
  await app.editor?.saveAll();
  try {
    await op('build_start', { capture: true });
  } catch (e) {
    toast(`Build failed to start: ${e.message}`, 'err');
  }
}

function renderRuntimes(list) {
  const el = document.getElementById('runtime-status');
  clear(el);
  const roles = { agent: 'Agent preview', studio: 'Visible preview' };
  for (const role of ['agent', 'studio']) {
    const rts = list.filter((r) => r.role === role);
    if (!rts.length) continue;
    const rt = rts[rts.length - 1];
    el.appendChild(h('span', { class: `rt-dot ${rt.crashed ? 'crashed' : rt.ready ? 'ready' : ''}`, title: `${roles[role]}: build #${rt.build ?? '?'} ${rt.crashed ? '(crashed)' : rt.ready ? '(ready)' : '(loading)'}` }, role === 'agent' ? 'agent' : 'visible'));
  }
}

async function exportProject() {
  const body = h('div', {}, h('div', { class: 'muted' }, 'Exporting and checking native compilation…'));
  const m = modal({ title: 'Export native C++ project', body, width: '720px' });
  try {
    const [exp, check] = await Promise.all([op('export_source', {}), op('export_check', {}).catch((e) => ({ ok: false, error: e.message }))]);
    clear(body);
    body.appendChild(
      h(
        'div',
        {},
        h('p', {}, 'The exported project is plain C++ Dear ImGui: your sources, ', h('code', {}, 'studio/studio.h'), ' (macros compile away), Dear ImGui, a GLFW + OpenGL3 host and a CMakeLists.txt.'),
        h('div', { class: 'kv' }, h('div', { class: 'k' }, 'Directory'), h('div', { class: 'v' }, exp.export_dir), h('div', { class: 'k' }, 'Zip'), h('div', { class: 'v' }, exp.zip_url ? h('a', { class: 'src', href: exp.zip_url, download: '' }, exp.zip) : '—'), h('div', { class: 'k' }, 'Sources'), h('div', { class: 'v' }, exp.sources.join(', ')), h('div', { class: 'k' }, 'Build'), h('div', { class: 'v' }, exp.build_instructions)),
        h('h4', { style: { margin: '14px 0 6px' } }, 'Native compile check (without IMGUI_STUDIO)'),
        check.skipped
          ? h('div', { class: 'muted' }, check.reason)
          : check.ok
            ? h('div', { style: { color: 'var(--ok)' } }, `✓ ${check.checked?.length ?? 0} source file(s) compile natively with ${check.compiler}`)
            : h('div', {}, h('div', { style: { color: 'var(--err)' } }, `✗ ${check.error || `${check.failed?.length} file(s) failed`}`), ...(check.errors || []).map((d) => h('div', { class: 'mono small' }, `${d.file}:${d.line}:${d.column}: ${d.message}`))),
      ),
    );
  } catch (e) {
    clear(body);
    body.appendChild(h('div', { style: { color: 'var(--err)' } }, e.message));
  }
  return m;
}

async function main() {
  initLayout(app);
  await app.refreshState();
  const s = app.state;
  document.getElementById('project-name').textContent = s.name;
  document.getElementById('project-name').title = s.project_dir;
  document.title = `${s.name} — ImGui Studio`;
  app.lastBuild = s.latest_build;
  buildPill();
  renderRuntimes(s.runtimes || []);

  const auto = document.getElementById('auto-build');
  auto.checked = !!s.settings.auto_build;
  auto.onchange = () => op('studio_settings', { auto_build: auto.checked });
  const agentVisible = document.getElementById('agent-visible');
  agentVisible.checked = s.settings.agent_target === 'studio';
  agentVisible.onchange = () => op('studio_settings', { agent_target: agentVisible.checked ? 'studio' : 'auto' });
  document.getElementById('btn-build').onclick = build;
  document.getElementById('btn-export').onclick = exportProject;
  app.build = build;

  initConsole(app);
  initFiles(app);
  app.editor = await initEditor(app);
  app.preview = initPreview(app);
  initInspector(app);
  initCompare(app);
  initReference(app);
  initHistory(app);
  initCaptures(app);
  initActivity(app);

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      build();
    }
  });

  connectEvents(
    (type, data) => {
      if (type === 'build_started') {
        app.building = data.id;
        buildPill();
      } else if (type === 'build_finished') {
        app.building = false;
        app.lastBuild = { ...data.history, id: data.build_id, success: data.success, duration_ms: data.duration_ms, errors: data.errors };
        buildPill();
        if (!data.success && data.errors?.length) toast(`Build #${data.build_id} failed: ${data.errors[0].file ? `${data.errors[0].file}:${data.errors[0].line}: ` : ''}${data.errors[0].message}`, 'err', 6000);
      } else if (type === 'runtime_status') {
        renderRuntimes(data);
      } else if (type === 'settings') {
        auto.checked = !!data.auto_build;
        agentVisible.checked = data.agent_target === 'studio';
      }
      app.bus.emit(`server:${type}`, data);
    },
    (connected) => {
      document.getElementById('topbar').style.boxShadow = connected ? '' : 'inset 0 -2px 0 var(--err)';
      if (connected) app.refreshState().catch(() => {});
    },
  );
}

main().catch((e) => {
  console.error(e);
  toast(`Studio failed to start: ${e.message}`, 'err', 20000);
});
