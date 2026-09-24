// Bottom panel: Problems (structured diagnostics), Build output (streamed), Runtime (errors/logs).
import { h, clear } from './ui.js';

export function initConsole(app) {
  const problems = document.getElementById('tab-problems');
  const output = document.getElementById('tab-output');
  const runtime = document.getElementById('tab-runtime');
  const probBadge = document.getElementById('problems-badge');
  const rtBadge = document.getElementById('runtime-badge');
  let current = 'problems';
  let rtCount = 0;

  function line(text) {
    const cls = /\berror\b|FAILED/i.test(text) ? 'err' : /\bwarning\b/i.test(text) ? 'warn' : /^compiled |^linked /.test(text) ? 'dim' : '';
    return h('div', { class: `log-line ${cls}` }, text);
  }

  function appendOutput(text) {
    const atBottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 20;
    for (const l of text.replace(/\n$/, '').split('\n')) output.appendChild(line(l));
    if (atBottom) output.scrollTop = output.scrollHeight;
  }

  function renderProblems(errors = [], warnings = []) {
    clear(problems);
    const all = [...errors.map((e) => ({ ...e, severity: 'error' })), ...warnings.map((w) => ({ ...w, severity: 'warning' }))];
    probBadge.hidden = !errors.length;
    probBadge.textContent = String(errors.length);
    if (!all.length) {
      problems.appendChild(h('div', { class: 'empty-state' }, 'No problems.'));
      return;
    }
    for (const d of all) {
      problems.appendChild(
        h(
          'div',
          { class: 'prob', onclick: () => d.file && !d.external && app.openFile(d.file, d.line, d.column) },
          h('span', { class: `sev ${d.severity}` }, d.severity === 'error' ? '✗' : '⚠'),
          h(
            'div',
            {},
            h('div', {}, d.message, d.flag ? h('span', { class: 'faint' }, ` [${d.flag}]`) : null),
            h('div', { class: 'loc' }, d.file ? `${d.file}${d.line ? `:${d.line}:${d.column}` : ''}` : d.linker ? 'linker' : ''),
            d.snippet ? h('pre', {}, d.snippet) : null,
            ...(d.notes || []).map((n) => h('div', { class: 'loc' }, typeof n === 'string' ? `note: ${n}` : `note: ${n.file}:${n.line}: ${n.message}`)),
          ),
        ),
      );
    }
  }

  function addRuntime(kind, e) {
    const text = kind === 'error' ? `[${e.role}] ${e.kind}: ${e.message}${e.file ? `  (${e.file}:${e.line})` : ''}${e.count > 1 ? `  ×${e.count}` : ''}` : `[${e.role}] ${e.text}`;
    const el = h('div', { class: `log-line ${kind === 'error' ? 'err' : e.level === 'warning' ? 'warn' : 'dim'}` }, `${new Date(e.at || Date.now()).toLocaleTimeString()}  ${text}`);
    runtime.appendChild(el);
    while (runtime.childNodes.length > 800) runtime.removeChild(runtime.firstChild);
    runtime.scrollTop = runtime.scrollHeight;
    if (kind === 'error') {
      rtCount++;
      if (current !== 'runtime') {
        rtBadge.hidden = false;
        rtBadge.textContent = String(rtCount);
      }
    }
  }

  app.bus.on('bottom-tab', (t) => {
    current = t;
    if (t === 'runtime') {
      rtBadge.hidden = true;
      rtCount = 0;
    }
  });
  document.getElementById('btn-clear-bottom').onclick = () => {
    if (current === 'output') clear(output);
    if (current === 'runtime') clear(runtime);
  };

  app.bus.on('server:build_started', (d) => {
    clear(output);
    appendOutput(`── Build #${d.id} (${d.source}) ──\n`);
  });
  app.bus.on('server:build_output', (d) => appendOutput(d.text));
  app.bus.on('server:build_finished', (b) => {
    appendOutput(b.success ? `✓ Build #${b.build_id} succeeded in ${b.duration_ms} ms${b.runtime?.errors?.length ? ` (${b.runtime.errors.length} runtime error(s))` : ''}\n` : `✗ Build #${b.build_id} failed (${b.errors.length} error(s))\n`);
    renderProblems(b.errors, (b.warnings || []).filter((w) => !w.external));
    if (!b.success) app.bus.emit('show-bottom', 'problems');
  });
  app.bus.on('server:runtime_error', (e) => addRuntime('error', e));
  app.bus.on('server:runtime_log', (e) => addRuntime('log', e));

  // Initial state
  const lb = app.state?.latest_build;
  if (lb && !lb.success) {
    app.op('build_errors', {}).then((r) => renderProblems(r.errors, r.warnings)).catch(() => renderProblems());
  } else renderProblems();
  if (lb) {
    fetch(`/api/build-log/${lb.id}`).then((r) => (r.ok ? r.text() : '')).then((t) => t && appendOutput(t)).catch(() => {});
  }
  for (const e of app.state?.runtime_errors || []) addRuntime('error', e);
}
