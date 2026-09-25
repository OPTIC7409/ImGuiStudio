// End-to-end: real Emscripten builds, the headless WebGL2 agent preview, scripted
// interaction, captures, comparison, history, export and the MCP adapter.
// Skipped automatically when emcc or a Chromium browser is not available.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { STUDIO_ROOT, findToolchain } from '../server/config.js';
import { Studio } from '../server/studio.js';
import { startHttpServer } from '../server/http.js';
import { runOp } from '../server/ops.js';
import { decodeImage } from '../server/images.js';

const toolchain = findToolchain();
let browserOk = true;
try {
  await import('playwright-core');
} catch {
  browserOk = false;
}
const SKIP = !toolchain ? 'emcc not found' : !browserOk ? 'playwright-core not installed' : false;

async function startStudio(template) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `imgui-studio-${template}-`));
  fs.cpSync(path.join(STUDIO_ROOT, 'templates', template), dir, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 7600 + Math.floor(Math.random() * 1000);
    const studio = new Studio({ projectDir: dir, port });
    await studio.init();
    try {
      const srv = await startHttpServer(studio, { port });
      return { studio, srv, dir, port, op: (name, args) => runOp(studio, name, args, { source: 'test' }) };
    } catch (e) {
      await studio.shutdown();
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error('no free port');
}

async function stopStudio(ctx) {
  if (!ctx) return;
  await ctx.studio.shutdown();
  await new Promise((r) => ctx.srv.server.close(r));
  for (const c of ctx.srv.wss.clients) c.terminate();
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

function pixels(capture) {
  return decodeImage(fs.readFileSync(capture.path));
}

describe('minimal project end-to-end', { skip: SKIP, timeout: 600000 }, () => {
  let ctx;
  before(async () => {
    ctx = await startStudio('minimal');
  });
  after(async () => stopStudio(ctx));

  it('builds to WebAssembly and returns a screenshot of the real render', async () => {
    const r = await ctx.op('build_start', { note: 'first' });
    assert.equal(r.success, true, JSON.stringify(r.errors));
    assert.equal(r.preview, 'loaded');
    assert.ok(r.images?.[0]?.data.length > 1000);
    const img = pixels(r.screenshot);
    assert.equal(img.width, 960);
    assert.equal(img.height, 600);
  });

  it('lists widgets with semantic ids, types, bounds and bound values', async () => {
    const r = await ctx.op('ui_list_widgets', {});
    const byId = Object.fromEntries(r.widgets.map((w) => [w.id, w]));
    assert.equal(byId['graphics.vsync'].type, 'checkbox');
    assert.equal(byId['graphics.vsync'].state.value, true);
    assert.equal(byId['graphics.fov'].state.value, 90);
    assert.equal(byId['graphics.quality'].type, 'combo');
    assert.equal(byId['graphics.apply'].type, 'button');
    assert.ok(byId['graphics.apply'].bounds.width > 20);
    assert.ok(r.windows.some((w) => w.name === 'Settings'));
  });

  it('clicks, sets values, drags and drives a combo', async () => {
    let r = await ctx.op('ui_click_widget', { id: 'graphics.vsync' });
    assert.equal(r.after.state.checked, false);
    r = await ctx.op('ui_set_value', { id: 'graphics.fov', value: 120 });
    assert.equal(r.after.state.value, 120);
    r = await ctx.op('ui_drag_widget', { id: 'graphics.fov', to: 0 });
    assert.equal(r.after.state.value, 30);
    await ctx.op('ui_click_widget', { id: 'Quality' });
    r = await ctx.op('ui_list_widgets', { query: 'high' });
    assert.equal(r.widgets.length, 1);
    await ctx.op('ui_click_widget', { id: r.widgets[0].id });
    r = await ctx.op('ui_inspect_widget', { id: 'graphics.quality' });
    assert.equal(r.widget.state.value, 2);
  });

  it('reports unknown widgets with candidates', async () => {
    await assert.rejects(ctx.op('ui_click_widget', { id: 'vsinc' }), (e) => e.code === 'widget_not_found');
  });

  it('produces deterministic captures', async () => {
    await ctx.op('preview_reload', {});
    const a = await ctx.op('capture_screen', {});
    await ctx.op('preview_reload', {});
    const b = await ctx.op('capture_screen', {});
    assert.deepEqual(Buffer.from(pixels(a).data), Buffer.from(pixels(b).data));
    const w = await ctx.op('capture_widget', { id: 'graphics.apply' });
    assert.ok(w.zoom > 1, 'small widgets are magnified');
  });

  it('returns structured compiler errors and can revert through history', async () => {
    const good = ctx.studio.history.latest({ successful: true }).id;
    await ctx.op('project_patch_file', { path: 'src/main.cpp', edits: [{ old_text: 'ImGui::Begin("Settings");', new_text: 'ImGui::Begin("Settings");\n    float t = anim_progress;' }] });
    const bad = await ctx.op('build_start', {});
    assert.equal(bad.success, false);
    assert.equal(bad.errors[0].file, 'src/main.cpp');
    assert.match(bad.errors[0].message, /anim_progress/);
    assert.ok(bad.errors[0].line > 0 && bad.errors[0].column > 0);
    const diff = await ctx.op('history_diff', { from: good, to: bad.build_id });
    assert.match(diff.files[0].diff, /\+\s+float t = anim_progress;/);
    const rev = await ctx.op('history_revert', { build_id: good });
    assert.equal(rev.build.success, true);
    assert.deepEqual(rev.written, ['src/main.cpp']);
  });

  it('compares against a reference image', async () => {
    const shot = ctx.studio.history.latest({ successful: true }).screenshot;
    await ctx.op('preview_reload', {});
    await ctx.op('reference_load', { path: path.join(ctx.studio.studioDir, shot), name: 'target' });
    const r = await ctx.op('reference_compare', {});
    assert.ok(r.similarity >= 99, `similarity ${r.similarity}`);
    await ctx.op('ui_click_widget', { id: 'graphics.vsync', move_away: true });
    const r2 = await ctx.op('reference_compare', {});
    assert.ok(r2.similarity < r.similarity);
    assert.ok(r2.hotspots.some((h) => h.widgets.includes('graphics.vsync')), JSON.stringify(r2.hotspots));
  });

  it('exports a native project whose sources compile without IMGUI_STUDIO', async () => {
    const exp = await ctx.op('export_source', {});
    assert.ok(fs.existsSync(path.join(exp.export_dir, 'CMakeLists.txt')));
    assert.ok(fs.existsSync(path.join(exp.export_dir, 'native', 'main.cpp')));
    assert.ok(fs.existsSync(path.join(exp.export_dir, 'studio', 'studio.h')));
    assert.ok(fs.existsSync(exp.zip));
    const check = await ctx.op('export_check', {});
    if (!check.skipped) assert.equal(check.ok, true, JSON.stringify(check.errors));
  });

  it('serves the MCP protocol over stdio (proxying to the running Studio)', async () => {
    const child = spawn(process.execPath, [path.join(STUDIO_ROOT, 'bin', 'imgui-studio.js'), 'mcp', '--project', ctx.dir, '--port', String(ctx.port)], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const waiters = new Map();
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        waiters.get(msg.id)?.(msg);
      }
    });
    let n = 0;
    const rpc = (method, params) =>
      new Promise((resolve) => {
        const id = ++n;
        waiters.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      assert.equal(init.result.serverInfo.name, 'imgui-studio');
      const tools = await rpc('tools/list', {});
      const names = tools.result.tools.map((t) => t.name);
      for (const t of ['build_start', 'ui_click_widget', 'capture_animation', 'reference_compare', 'export_source']) assert.ok(names.includes(t), t);
      const call = await rpc('tools/call', { name: 'capture_widget', arguments: { id: 'graphics.apply' } });
      assert.equal(call.result.content[0].type, 'text');
      assert.equal(call.result.content[1].type, 'image');
      const err = await rpc('tools/call', { name: 'ui_click_widget', arguments: { id: 'does.not.exist' } });
      assert.equal(err.result.isError, true);
    } finally {
      child.stdin.end();
      child.kill();
    }
  });
});

describe('showcase project end-to-end', { skip: SKIP, timeout: 600000 }, () => {
  let ctx;
  before(async () => {
    ctx = await startStudio('showcase');
  });
  after(async () => stopStudio(ctx));

  it('builds the custom widget showcase', async () => {
    const r = await ctx.op('build_start', {});
    assert.equal(r.success, true, JSON.stringify(r.errors));
    assert.equal(r.runtime_errors, undefined, JSON.stringify(r.runtime_errors));
  });

  it('exposes custom widgets through STUDIO_* annotations', async () => {
    const r = await ctx.op('ui_list_widgets', {});
    const byId = Object.fromEntries(r.widgets.map((w) => [w.id, w]));
    assert.equal(byId['graphics.vsync'].type, 'toggle');
    assert.equal(byId['graphics.display_mode'].type, 'segmented');
    assert.equal(byId['graphics.display_mode.fullscreen'].type, 'segment');
    assert.equal(byId['sidebar.graphics'].state.selected, true);
    assert.equal(byId['graphics.frame_rate_limit'].type, 'slider');
  });

  it('navigates, toggles and drags custom widgets', async () => {
    let r = await ctx.op('ui_click_widget', { id: 'graphics.display_mode.fullscreen' });
    r = await ctx.op('ui_inspect_widget', { id: 'graphics.display_mode' });
    assert.equal(r.widget.state.value, 2);
    r = await ctx.op('ui_drag_widget', { id: 'graphics.frame_rate_limit', to: 0.5 });
    assert.ok(Math.abs(r.after.state.value - 135) < 2, String(r.after.state.value));
    await ctx.op('ui_click_widget', { id: 'sidebar.audio' });
    r = await ctx.op('ui_list_widgets', { prefix: 'audio.' });
    assert.ok(r.widgets.some((w) => w.id === 'audio.master' && w.type === 'slider'));
  });

  it('captures a deterministic animation filmstrip with state', async () => {
    await ctx.op('preview_reload', {});
    const r = await ctx.op('capture_animation', { id: 'graphics.motion_blur', action: 'toggle', duration_ms: 240, frames: 5 });
    assert.equal(r.frame_count, 5);
    const anim = r.state_track.map((f) => f.anim);
    for (let i = 1; i < anim.length; i++) assert.ok(anim[i] >= anim[i - 1], `anim not monotonic: ${anim}`);
    assert.equal(anim[anim.length - 1], 1);
    assert.equal(r.state_track[0].value, true);
    await ctx.op('preview_reload', {});
    const again = await ctx.op('capture_animation', { id: 'graphics.motion_blur', action: 'toggle', duration_ms: 240, frames: 5 });
    assert.deepEqual(again.state_track.map((f) => f.anim), anim);
  });
});
