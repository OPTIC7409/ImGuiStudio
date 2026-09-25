// Agent tab: live log of every tool/operation call (MCP, UI, CLI).
import { h, clear, fmtMs, modal } from './ui.js';

export function initActivity(app) {
  const root = document.getElementById('tab-activity');
  const badge = document.getElementById('activity-badge');
  const onlyAgent = h('input', { type: 'checkbox', checked: true });
  const list = h('div');
  root.append(h('div', { class: 'insp-search' }, h('label', { class: 'toggle' }, onlyAgent, 'agent activity only'), h('span', { class: 'grow' })), list);
  let entries = (app.state?.activity || []).slice();
  let visible = false;
  let unseen = 0;

  function item(e) {
    const args = Object.keys(e.args || {}).length ? JSON.stringify(e.args) : '';
    return h(
      'div',
      { class: 'act' },
      h('div', { class: 'act-head' }, h('span', { class: `src ${e.source}` }, e.source), h('span', { class: 'op' }, e.op), h('span', { class: 'dur' }, `${fmtMs(e.duration_ms)} · ${new Date(e.time).toLocaleTimeString()}`)),
      args ? h('div', { class: 'args' }, args.length > 300 ? `${args.slice(0, 300)}…` : args) : null,
      e.ok === false ? h('div', { class: 'res err' }, `${e.error?.code}: ${e.error?.message}`) : e.summary ? h('div', { class: e.source === 'agent' ? 'say' : 'res' }, e.source === 'agent' ? e.summary : `→ ${e.summary}`) : null,
      ...(e.image_urls || []).slice(0, 1).map((u) => h('img', { src: u, loading: 'lazy', onclick: () => modal({ title: e.op, body: h('img', { src: u }) }) })),
    );
  }

  function render() {
    clear(list);
    const isAgent = (e) => e.source === 'mcp' || e.source === 'agent';
    const shown = entries.filter((e) => !onlyAgent.checked || isAgent(e)).slice(-150).reverse();
    if (!shown.length) {
      list.appendChild(h('div', { class: 'empty-state' }, onlyAgent.checked ? 'No agent activity yet. Connect an MCP client (see README) and its tool calls appear here live.' : 'No activity yet.'));
      return;
    }
    for (const e of shown) list.appendChild(item(e));
  }

  onlyAgent.onchange = render;
  app.bus.on('right-tab', (t) => {
    visible = t === 'activity';
    if (visible) {
      unseen = 0;
      badge.hidden = true;
    }
  });
  app.bus.on('server:op_log', (e) => {
    entries.push(e);
    if (entries.length > 500) entries.shift();
    if ((e.source === 'mcp' || e.source === 'agent') && !visible) {
      unseen++;
      badge.textContent = String(unseen);
      badge.className = 'badge info';
      badge.hidden = false;
    }
    if (visible || !onlyAgent.checked || e.source === 'mcp' || e.source === 'agent') render();
  });
  render();
}
