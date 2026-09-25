// Operation registry: every capability of the Studio is an operation with a JSON
// schema and a handler. The MCP adapter exposes them as tools, the HTTP API as
// POST /api/op/<name>, and the Studio UI calls the same endpoints.
//
// Handlers return plain JSON data. Images are returned in an `images` array
// ({ data: base64 PNG, caption }) and are always also saved to disk.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StudioError, ensureDir, resolveInside, toPosix, walkFiles } from './util.js';
import { compose, crop, decodeImage, downscale, encodePng, scaleNearest } from './images.js';
import { compareImages, describeComparison } from './compare.js';
import { exportProject, nativeCheck } from './exporter.js';
import { unifiedDiff } from './textdiff.js';

const MAX_READ = 2 * 1024 * 1024;

const OPS = new Map();

function op(name, def) {
  OPS.set(name, { name, mcp: true, ...def });
}

export function listOps() {
  return [...OPS.values()];
}

export function getOp(name) {
  return OPS.get(name);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const S = {
  str: (description, extra = {}) => ({ type: 'string', description, ...extra }),
  num: (description, extra = {}) => ({ type: 'number', description, ...extra }),
  int: (description, extra = {}) => ({ type: 'integer', description, ...extra }),
  bool: (description, extra = {}) => ({ type: 'boolean', description, ...extra }),
  obj: (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false }),
  rect: (description) => ({
    type: 'object',
    description,
    properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
    required: ['x', 'y', 'width', 'height'],
  }),
};

const WIDGET_TARGET = {
  id: S.str('Semantic widget id from ui_list_widgets (e.g. "graphics.vsync"). A unique label or id suffix also works.'),
  x: S.num('Fallback: x coordinate in viewport pixels (use with y instead of id)'),
  y: S.num('Fallback: y coordinate in viewport pixels'),
};

const CAPTURE_AFTER = S.bool('Return a screenshot of the whole viewport after the action (default false)');
const SETTLE = S.int('Simulated milliseconds to advance after the action so transitions finish (default 300)', { minimum: 0, maximum: 10000 });

function trimDiag(d) {
  const out = { file: d.file, line: d.line, column: d.column, message: d.message };
  if (d.severity !== 'error') out.severity = d.severity;
  if (d.flag) out.flag = d.flag;
  if (d.snippet) out.snippet = d.snippet;
  if (d.external) out.external = true;
  if (d.included_from) out.included_from = d.included_from.map((i) => `${i.file}:${i.line}`);
  if (d.notes) out.notes = d.notes.slice(0, 3).map((n) => `${n.file}:${n.line}: ${n.message}`);
  if (d.linker) out.linker = true;
  if (d.defined_in) out.defined_in = d.defined_in;
  return out;
}

function autoZoom(w, h, zoom) {
  if (zoom != null) return Math.max(1, Math.min(8, Math.round(Number(zoom) || 1)));
  const long = Math.max(w, h);
  if (long >= 320) return 1;
  return Math.max(1, Math.min(6, Math.floor(480 / Math.max(1, long))));
}

async function saveAndReturnCapture(studio, shot, { kind, label, zoom, extra = {} }) {
  const png = Buffer.from(shot.png, 'base64');
  const rec = await studio.saveCapture(png, {
    kind,
    label,
    width: shot.width,
    height: shot.height,
    region: shot.region,
    widget: shot.widget ? shot.widget.id : null,
    build_id: shot.meta?.build_id,
    meta: shot.meta,
    ...extra,
  });
  const z = autoZoom(shot.width, shot.height, zoom);
  let outPng = shot.png;
  if (z > 1) outPng = encodePng(scaleNearest(decodeImage(png), z)).toString('base64');
  return {
    data: {
      capture_id: rec.capture_id,
      path: rec.path,
      url: rec.url,
      width: shot.width,
      height: shot.height,
      region: shot.region,
      zoom: z,
      widget: shot.widget || undefined,
      meta: shot.meta,
    },
    image: { data: outPng, caption: `${label || kind} (${shot.width}x${shot.height}${z > 1 ? `, shown at ${z}x` : ''})` },
  };
}

async function screenshotAfter(studio, args, result, label) {
  if (!args.capture) return result;
  const shot = await studio.rpc('capture', {});
  const c = await saveAndReturnCapture(studio, shot, { kind: 'screen', label, zoom: 1 });
  return { ...result, screenshot: c.data, images: [c.image] };
}

function intersect(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
}

function widgetsForRect(widgets, rect, max = 4) {
  return widgets
    .filter((w) => w.visible !== false && w.type !== 'window' && !w.anonymous)
    .map((w) => {
      const b = w.visible_bounds || w.bounds;
      const inter = intersect(b, rect);
      const area = Math.max(1, b.width * b.height);
      return { w, score: inter / Math.min(area, Math.max(1, rect.width * rect.height)) };
    })
    .filter((x) => x.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.w.id);
}

function fitWidth(img, maxW) {
  if (img.width <= maxW) return img;
  return downscale(img, maxW, Math.round((img.height * maxW) / img.width));
}

function comparisonComposite(ref, cur, heat, { labels = ['REFERENCE', 'CURRENT', 'DIFF'], maxTile = 800, zoomSmall = true } = {}) {
  let z = 1;
  if (zoomSmall) z = autoZoom(cur.width, cur.height);
  const prep = (img) => fitWidth(z > 1 ? scaleNearest(img, z) : img, maxTile);
  return compose(
    [
      { image: prep(ref), label: labels[0] },
      { image: prep(cur), label: labels[1] },
      { image: prep(heat), label: labels[2] },
    ],
    { labelScale: 2 },
  );
}

async function freshCapture(studio, params = {}) {
  const shot = await studio.rpc('capture', params);
  return { shot, img: decodeImage(Buffer.from(shot.png, 'base64')) };
}

function buildSummaryForAgent(r) {
  const out = {
    build_id: r.build_id,
    success: r.success,
    duration_ms: r.duration_ms,
    compiled: r.compiled,
    changed_files: r.changed_files,
  };
  if (!r.success) {
    out.failed_in = r.phase;
    out.errors = r.errors.slice(0, 25).map(trimDiag);
    if (r.errors.length > 25) out.more_errors = r.errors.length - 25;
  }
  const warnings = (r.warnings || []).filter((w) => !w.external);
  if (warnings.length) out.warnings = warnings.slice(0, 10).map(trimDiag);
  if (r.runtime) {
    out.preview = r.runtime.crashed ? 'crashed' : r.runtime.loaded ? 'loaded' : `not loaded: ${r.runtime.reason || 'unknown'}`;
    if (r.runtime.crashed) out.next = 'The build compiled but the app crashed while starting. Read runtime_errors (assertion file:line, stack), fix it and rebuild.';
    if (r.runtime.errors && r.runtime.errors.length) out.runtime_errors = r.runtime.errors.slice(0, 10);
  }
  if (r.screenshot) {
    out.screenshot = { capture_id: r.screenshot.capture_id, path: r.screenshot.path, url: r.screenshot.url };
    if (r.screenshot.similarity != null) out.reference_similarity = { reference: r.screenshot.reference, similarity: r.screenshot.similarity };
  }
  if (r.screenshot_error) out.screenshot_error = r.screenshot_error;
  return out;
}

// ---------------------------------------------------------------------------
// Project files
// ---------------------------------------------------------------------------

op('project_info', {
  title: 'Project info',
  description:
    'Overview of the ImGui Studio project: name, directory, studio.json settings (viewport, sources), toolchain, latest build, connected preview runtimes and the active reference image. Call this first.',
  input: S.obj({}),
  async handler(_a, { studio }) {
    return studio.info();
  },
});

op('project_list_files', {
  title: 'List project files',
  description: 'List files in the project (Studio state, exports and build outputs are excluded).',
  input: S.obj({ path: S.str('Optional sub-directory to list'), pattern: S.str('Optional substring or extension filter, e.g. ".cpp"') }),
  async handler({ path: sub, pattern }, { studio }) {
    const root = sub ? resolveInside(studio.projectDir, sub) : studio.projectDir;
    let files = walkFiles(root).map((f) => (sub ? `${toPosix(sub).replace(/\/$/, '')}/${f}` : f));
    if (pattern) files = files.filter((f) => f.includes(pattern));
    return {
      files: files.map((f) => {
        const st = fs.statSync(path.join(studio.projectDir, f));
        return { path: f, size: st.size };
      }),
    };
  },
});

op('project_read_file', {
  title: 'Read file',
  description: 'Read a project file. Use start_line/end_line for large files; numbered=true prefixes line numbers (matching compiler diagnostics).',
  input: S.obj({ path: S.str('Project-relative path'), start_line: S.int('First line (1-based)'), end_line: S.int('Last line (inclusive)'), numbered: S.bool('Prefix each line with its number') }, ['path']),
  async handler({ path: rel, start_line, end_line, numbered }, { studio }) {
    const abs = resolveInside(studio.projectDir, rel);
    if (!fs.existsSync(abs)) throw new StudioError('file_not_found', `File not found: ${rel}`);
    const st = fs.statSync(abs);
    if (st.size > MAX_READ) throw new StudioError('file_too_large', `${rel} is ${st.size} bytes; read it with start_line/end_line`);
    const text = await fsp.readFile(abs, 'utf8');
    let lines = text.split('\n');
    const total = lines.length;
    const s = Math.max(1, start_line || 1);
    const e = Math.min(total, end_line || total);
    lines = lines.slice(s - 1, e);
    const content = numbered ? lines.map((l, i) => `${String(s + i).padStart(5)}  ${l}`).join('\n') : lines.join('\n');
    return { path: toPosix(rel), content, start_line: s, end_line: e, total_lines: total };
  },
});

op('project_write_file', {
  title: 'Write file',
  description: 'Create or overwrite a project file with the given content (directories are created).',
  input: S.obj({ path: S.str('Project-relative path'), content: S.str('Full file content') }, ['path', 'content']),
  async handler({ path: rel, content }, { studio }) {
    const abs = resolveInside(studio.projectDir, rel);
    const existed = fs.existsSync(abs);
    const before = existed ? await fsp.readFile(abs, 'utf8') : '';
    await ensureDir(path.dirname(abs));
    await fsp.writeFile(abs, content);
    const diff = unifiedDiff(before, content, { fromFile: `a/${rel}`, toFile: `b/${rel}` });
    return { path: toPosix(rel), bytes: Buffer.byteLength(content), created: !existed, diff: diff.length > 4000 ? `${diff.slice(0, 4000)}\n... (diff truncated)` : diff };
  },
});

op('project_patch_file', {
  title: 'Patch file',
  description:
    'Apply exact text replacements to a file. Each edit replaces old_text (which must match exactly, including whitespace, and be unique unless replace_all) with new_text. Edits apply in order. Returns a unified diff.',
  input: S.obj(
    {
      path: S.str('Project-relative path'),
      edits: {
        type: 'array',
        minItems: 1,
        items: S.obj({ old_text: S.str('Exact text to find'), new_text: S.str('Replacement text'), replace_all: S.bool('Replace every occurrence') }, ['old_text', 'new_text']),
      },
    },
    ['path', 'edits'],
  ),
  async handler({ path: rel, edits }, { studio }) {
    const abs = resolveInside(studio.projectDir, rel);
    if (!fs.existsSync(abs)) throw new StudioError('file_not_found', `File not found: ${rel}`);
    const before = await fsp.readFile(abs, 'utf8');
    let text = before;
    edits.forEach((e, i) => {
      if (!e.old_text) throw new StudioError('bad_edit', `Edit #${i + 1}: old_text is empty`);
      const count = text.split(e.old_text).length - 1;
      if (count === 0) {
        const first = e.old_text.split('\n').find((l) => l.trim()) || e.old_text;
        const lines = text.split('\n');
        const near = lines.map((l, n) => ({ l, n })).filter(({ l }) => l.trim() && (l.includes(first.trim().slice(0, 24)) || first.includes(l.trim())));
        throw new StudioError('edit_not_found', `Edit #${i + 1}: old_text not found in ${rel}`, {
          hint: near.length ? `Similar line(s): ${near.slice(0, 3).map(({ l, n }) => `${n + 1}: ${l.trim()}`).join(' | ')}` : 'Read the file again; it may have changed.',
        });
      }
      if (count > 1 && !e.replace_all) throw new StudioError('edit_ambiguous', `Edit #${i + 1}: old_text occurs ${count} times in ${rel}; add surrounding context or set replace_all`);
      text = e.replace_all ? text.split(e.old_text).join(e.new_text) : text.replace(e.old_text, () => e.new_text);
    });
    await fsp.writeFile(abs, text);
    return { path: toPosix(rel), applied: edits.length, diff: unifiedDiff(before, text, { fromFile: `a/${rel}`, toFile: `b/${rel}` }) };
  },
});

op('project_delete_file', {
  title: 'Delete file',
  description: 'Delete a project file.',
  input: S.obj({ path: S.str('Project-relative path') }, ['path']),
  async handler({ path: rel }, { studio }) {
    const abs = resolveInside(studio.projectDir, rel);
    if (!fs.existsSync(abs)) throw new StudioError('file_not_found', `File not found: ${rel}`);
    await fsp.rm(abs);
    return { deleted: toPosix(rel) };
  },
});

op('project_search', {
  title: 'Search files',
  description: 'Search project source files for a string or regular expression. Returns file:line matches.',
  input: S.obj({ pattern: S.str('Text or regex'), regex: S.bool('Treat pattern as a regular expression'), max_results: S.int('Default 100') }, ['pattern']),
  async handler({ pattern, regex, max_results = 100 }, { studio }) {
    const re = regex ? new RegExp(pattern) : null;
    const results = [];
    for (const f of walkFiles(studio.projectDir)) {
      if (!/\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl|json|md|txt)$/i.test(f)) continue;
      const lines = fs.readFileSync(path.join(studio.projectDir, f), 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (results.length >= max_results) return;
        if (re ? re.test(l) : l.includes(pattern)) results.push({ file: f, line: i + 1, text: l.trim().slice(0, 200) });
      });
      if (results.length >= max_results) break;
    }
    return { matches: results, truncated: results.length >= max_results };
  },
});

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

op('build_start', {
  title: 'Build + preview',
  description:
    'Compile the project to WebAssembly (incremental: only changed files recompile), load it in the headless preview and return structured errors or a screenshot. This is the core loop: edit C++ -> build_start -> look at the screenshot -> edit again. If an active reference is set, the result includes a similarity score.',
  input: S.obj({ note: S.str('Optional note stored with this build in the history (what you changed / why)'), capture: S.bool('Return a screenshot after a successful build (default true)') }),
  async handler({ note = null, capture = true }, { studio, source }) {
    const r = await studio.build({ note, capture: true, source });
    const out = buildSummaryForAgent(r);
    if (r.success && capture && r.screenshot) {
      const png = await fsp.readFile(r.screenshot.path);
      out.images = [{ data: png.toString('base64'), caption: `Build #${r.build_id} (${r.screenshot.width}x${r.screenshot.height})` }];
    }
    if (!r.success) out.next = 'Fix the errors (file:line:column) and call build_start again.';
    return out;
  },
});

op('build_status', {
  title: 'Build status',
  description: 'Latest build result, preview runtime state and recent runtime errors.',
  input: S.obj({}),
  async handler(_a, { studio }) {
    const latest = studio.history.latest();
    const ok = studio.latestBuildId();
    return {
      latest: studio.history.summary(latest),
      latest_successful_build: ok,
      building: studio.currentBuild,
      runtimes: studio.hub.status(),
      runtime_errors: ok != null ? studio.hub.errorsForBuild(ok).slice(-10).map(({ runtime, key, ...e }) => e) : [],
    };
  },
});

op('build_errors', {
  title: 'Build errors',
  description: 'Full structured compiler/linker diagnostics for a build (default: latest), optionally with the raw log tail.',
  input: S.obj({ build_id: S.int('Build number (default latest)'), include_log: S.bool('Include the last 80 lines of the raw build log'), include_warnings: S.bool('Include warnings (default true)') }),
  async handler({ build_id, include_log = false, include_warnings = true }, { studio }) {
    const b = build_id ? studio.history.get(build_id) : studio.history.latest();
    if (!b) return { message: 'No builds yet' };
    const out = { build_id: b.id, success: b.success, failed_in: b.success ? undefined : b.phase, errors: (b.errors || []).map(trimDiag) };
    if (include_warnings) out.warnings = (b.warnings || []).map(trimDiag);
    if (include_log) {
      try {
        const log = await fsp.readFile(path.join(studio.studioDir, 'builds', `${b.id}.log`), 'utf8');
        out.log_tail = log.split('\n').slice(-80).join('\n');
      } catch {
        out.log_tail = null;
      }
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Preview / runtime
// ---------------------------------------------------------------------------

op('preview_reload', {
  title: 'Reset preview',
  description: 'Reload the latest build in the agent preview, resetting all UI state (fresh AppInit, time = 0, no hover).',
  input: S.obj({ capture: S.bool('Return a screenshot after reloading') }),
  async handler(args, { studio }) {
    const r = await studio.resetAgentPreview();
    return screenshotAfter(studio, args, { reloaded: r.loaded, crashed: r.crashed || false, errors: r.errors, reason: r.reason }, 'After reload');
  },
});

op('preview_set_viewport', {
  title: 'Set viewport',
  description: 'Resize the preview viewport (logical pixels). persist=true also saves it to studio.json and reloads.',
  input: S.obj({ width: S.int('Width in pixels'), height: S.int('Height in pixels'), persist: S.bool('Save to studio.json'), capture: CAPTURE_AFTER }, ['width', 'height']),
  async handler(args, { studio }) {
    if (args.persist) {
      const file = path.join(studio.projectDir, 'studio.json');
      const cfg = JSON.parse(await fsp.readFile(file, 'utf8'));
      cfg.viewport = { ...(cfg.viewport || {}), width: args.width, height: args.height };
      await fsp.writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`);
      studio.reloadConfig();
      await studio.resetAgentPreview();
      return screenshotAfter(studio, args, { viewport: studio.config.viewport, persisted: true }, 'Viewport');
    }
    const r = await studio.rpc('set_viewport', { width: args.width, height: args.height });
    return screenshotAfter(studio, args, r, 'Viewport');
  },
});

op('runtime_errors', {
  title: 'Runtime errors',
  description: 'Runtime errors and logs from the running preview: assertion failures (with file:line), crashes, Dear ImGui error-recovery messages (e.g. missing End()), and printf output.',
  input: S.obj({ clear: S.bool('Clear the error list after reading') }),
  async handler({ clear = false }, { studio }) {
    try {
      return await studio.rpc('errors', { clear });
    } catch (e) {
      const id = studio.latestBuildId();
      return { errors: id != null ? studio.hub.errorsForBuild(id).map(({ runtime, key, ...x }) => x) : [], note: e.message };
    }
  },
});

// ---------------------------------------------------------------------------
// UI inspection & interaction
// ---------------------------------------------------------------------------

op('ui_list_widgets', {
  title: 'List widgets',
  description:
    'List the Dear ImGui widgets on screen in the current frame: semantic id, type, label, bounds (x,y,width,height in viewport pixels), state (hovered/active/focused/checked/value/custom STUDIO_STATE) and windows. Ids come from STUDIO_SCOPE/STUDIO_ID annotations or are derived from window + label.',
  input: S.obj({
    query: S.str('Filter by substring of id or label'),
    type: S.str('Filter by type (button, checkbox, input, toggle, window, ...)'),
    window: S.str('Only widgets in this window (name)'),
    prefix: S.str('Only ids starting with this prefix, e.g. "graphics."'),
    include_hidden: S.bool('Include clipped/invisible widgets'),
    include_anonymous: S.bool('Include unlabeled items (scrollbars, title bars, ...)'),
    limit: S.int('Max widgets (default 400)'),
  }),
  async handler(args, { studio }) {
    return studio.rpc('widgets', args);
  },
});

op('ui_inspect_widget', {
  title: 'Inspect widget',
  description: 'Full details for one widget: bounds, visible bounds, state, value, source location of its STUDIO_* annotations, window, plus current frame info (mouse, hovered/active ids).',
  input: S.obj({ id: WIDGET_TARGET.id }, ['id']),
  async handler(args, { studio }) {
    return studio.rpc('inspect', args);
  },
});

op('ui_widget_at', {
  title: 'Widget at point',
  description: 'Find the top-most widget at a viewport coordinate.',
  input: S.obj({ x: S.num('x'), y: S.num('y') }, ['x', 'y']),
  async handler(args, { studio }) {
    return studio.rpc('widget_at', args);
  },
});

op('ui_click_widget', {
  title: 'Click widget',
  description: 'Click a widget (by semantic id) or a coordinate. Scrolls it into view if needed. Returns the widget state before/after (e.g. checked/value) and any runtime errors.',
  input: S.obj({
    ...WIDGET_TARGET,
    button: S.int('0 = left (default), 1 = right, 2 = middle'),
    double: S.bool('Double click'),
    modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'super'] } },
    offset: { type: 'array', items: { type: 'number' }, description: '[fx, fy] point inside the widget as fractions (default [0.5, 0.5])' },
    settle_ms: SETTLE,
    move_away: S.bool('Move the mouse off the UI after clicking (removes hover state from screenshots)'),
    capture: CAPTURE_AFTER,
  }),
  async handler(args, { studio }) {
    const { capture, ...p } = args;
    const r = await studio.rpc('click', p);
    return screenshotAfter(studio, args, r, `After click ${args.id || `${args.x},${args.y}`}`);
  },
});

op('ui_hover_widget', {
  title: 'Hover widget',
  description: 'Move the mouse over a widget (or coordinate) and keep it there, to inspect hover states / tooltips.',
  input: S.obj({ ...WIDGET_TARGET, offset: { type: 'array', items: { type: 'number' } }, settle_ms: SETTLE, capture: CAPTURE_AFTER }),
  async handler(args, { studio }) {
    const { capture, ...p } = args;
    const r = await studio.rpc('hover', p);
    return screenshotAfter(studio, args, r, `Hover ${args.id || `${args.x},${args.y}`}`);
  },
});

op('ui_mouse_leave', {
  title: 'Mouse leave',
  description: 'Move the mouse out of the viewport (clears hover states).',
  input: S.obj({ settle_ms: SETTLE, capture: CAPTURE_AFTER }),
  async handler(args, { studio }) {
    const r = await studio.rpc('mouse_leave', { settle_ms: args.settle_ms });
    return screenshotAfter(studio, args, r, 'Mouse left');
  },
});

op('ui_drag_widget', {
  title: 'Drag widget',
  description:
    'Press on a widget and drag. "to" as a number 0..1 drags horizontally to that fraction of the widget width (sliders); "to" as [x,y] drags to a point; "by" as [dx,dy] drags relative. Returns before/after state.',
  input: S.obj({
    ...WIDGET_TARGET,
    to: { description: 'Number 0..1 (fraction across the widget) or [x, y]', anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }] },
    by: { type: 'array', items: { type: 'number' }, description: '[dx, dy] relative drag' },
    from: { type: 'array', items: { type: 'number' }, description: 'Optional absolute [x, y] start point' },
    steps: S.int('Intermediate mouse moves (default 10)'),
    settle_ms: SETTLE,
    capture: CAPTURE_AFTER,
  }),
  async handler(args, { studio }) {
    const { capture, ...p } = args;
    const r = await studio.rpc('drag', p);
    return screenshotAfter(studio, args, r, `After drag ${args.id || ''}`);
  },
});

op('ui_scroll', {
  title: 'Scroll',
  description: 'Mouse-wheel scroll over a widget/window or coordinate. dy < 0 scrolls down (content moves up), in wheel notches.',
  input: S.obj({ ...WIDGET_TARGET, dy: S.num('Vertical wheel notches (default -1 = down)'), dx: S.num('Horizontal wheel notches'), settle_ms: SETTLE, capture: CAPTURE_AFTER }),
  async handler(args, { studio }) {
    const { capture, ...p } = args;
    const r = await studio.rpc('scroll', p);
    return screenshotAfter(studio, args, r, 'After scroll');
  },
});

op('ui_set_value', {
  title: 'Set widget value',
  description:
    'Set the value of a widget. Works directly for widgets bound with STUDIO_BIND (bool/int/float/double/color/text/vector), and via Ctrl+Click text entry for standard ImGui sliders/drags/inputs. Colors accept [r,g,b,a] (0..1) or "#RRGGBB".',
  input: S.obj(
    {
      id: WIDGET_TARGET.id,
      value: { description: 'New value: boolean, number, array of numbers, or string', anyOf: [{ type: 'boolean' }, { type: 'number' }, { type: 'string' }, { type: 'array', items: { type: 'number' } }] },
      settle_ms: SETTLE,
      capture: CAPTURE_AFTER,
    },
    ['id', 'value'],
  ),
  async handler(args, { studio }) {
    const { capture, ...p } = args;
    const r = await studio.rpc('set_value', p);
    return screenshotAfter(studio, args, r, `After set ${args.id}`);
  },
});

op('ui_key', {
  title: 'Press key',
  description: 'Press and release a key, optionally with modifiers. Names: Enter, Escape, Tab, Space, Backspace, Delete, Up/Down/Left/Right, Home, End, PageUp, PageDown, F1-F24, a-z, 0-9, or DOM codes like "KeyA".',
  input: S.obj({ key: S.str('Key name'), modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'super'] } }, capture: CAPTURE_AFTER }, ['key']),
  async handler(args, { studio }) {
    const { capture, ...p } = args;
    const r = await studio.rpc('key', p);
    return screenshotAfter(studio, args, r, `After key ${args.key}`);
  },
});

op('ui_type_text', {
  title: 'Type text',
  description: 'Type text into the focused text field (or click the widget "id" first). submit=true presses Enter afterwards.',
  input: S.obj({ text: S.str('Text to type'), id: S.str('Optional widget to click first'), submit: S.bool('Press Enter afterwards'), capture: CAPTURE_AFTER }, ['text']),
  async handler(args, { studio }) {
    const { capture, ...p } = args;
    const r = await studio.rpc('type_text', p);
    return screenshotAfter(studio, args, r, 'After typing');
  },
});

op('ui_wait', {
  title: 'Advance time',
  description: 'Advance simulated time (the agent preview is deterministic: time only moves when you act or wait).',
  input: S.obj({ ms: S.int('Milliseconds of simulated time'), capture: CAPTURE_AFTER }, ['ms']),
  async handler(args, { studio }) {
    const r = await studio.rpc('wait', { ms: args.ms });
    return screenshotAfter(studio, args, r, `After ${args.ms} ms`);
  },
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

op('capture_screen', {
  title: 'Screenshot',
  description: 'Screenshot the whole viewport of the real Dear ImGui render (pixels read back from WebGL2). Deterministic for a given build + interaction sequence.',
  input: S.obj({ settle_ms: S.int('Advance simulated time before capturing'), label: S.str('Label stored with the capture') }),
  async handler(args, { studio }) {
    const shot = await studio.rpc('capture', { settle_ms: args.settle_ms });
    const c = await saveAndReturnCapture(studio, shot, { kind: 'screen', label: args.label || 'Screen', zoom: 1 });
    return { ...c.data, images: [c.image] };
  },
});

op('capture_region', {
  title: 'Capture region',
  description: 'Capture a rectangle of the viewport. Small regions are shown magnified (nearest-neighbour) so details like 1px borders and anti-aliasing are visible.',
  input: S.obj({ x: S.num('x'), y: S.num('y'), width: S.num('width'), height: S.num('height'), zoom: S.int('Magnification 1-8 (default: automatic for small regions)'), label: S.str('Label') }, ['x', 'y', 'width', 'height']),
  async handler(args, { studio }) {
    const shot = await studio.rpc('capture', { region: { x: args.x, y: args.y, width: args.width, height: args.height } });
    const c = await saveAndReturnCapture(studio, shot, { kind: 'region', label: args.label || 'Region', zoom: args.zoom });
    return { ...c.data, images: [c.image] };
  },
});

op('capture_widget', {
  title: 'Capture widget',
  description: 'Capture one widget (plus padding), magnified automatically when small.',
  input: S.obj({ id: WIDGET_TARGET.id, padding: S.int('Pixels around the widget (default 8)'), zoom: S.int('Magnification 1-8'), label: S.str('Label') }, ['id']),
  async handler(args, { studio }) {
    const shot = await studio.rpc('capture', { id: args.id, padding: args.padding ?? 8 });
    const c = await saveAndReturnCapture(studio, shot, { kind: 'widget', label: args.label || args.id, zoom: args.zoom });
    return { ...c.data, images: [c.image] };
  },
});

op('capture_window', {
  title: 'Capture window',
  description: 'Capture a Dear ImGui window by name or window id (e.g. "window.settings").',
  input: S.obj({ id: S.str('Window name or id'), padding: S.int('Pixels around the window (default 0)'), zoom: S.int('Magnification'), label: S.str('Label') }, ['id']),
  async handler(args, { studio }) {
    const shot = await studio.rpc('capture', { window: args.id, padding: args.padding ?? 0 });
    const c = await saveAndReturnCapture(studio, shot, { kind: 'window', label: args.label || args.id, zoom: args.zoom });
    return { ...c.data, images: [c.image] };
  },
});

op('capture_animation', {
  title: 'Capture animation',
  description:
    'Deterministic animation filmstrip. Performs an action at t=0 and renders the UI at evenly spaced explicit times (fixed timestep, independent of real frame rate), returning one labelled filmstrip image plus per-frame widget state (e.g. STUDIO_STATE values) so easing, overshoot and timing can be judged. Actions: click/toggle, hover, unhover, press, release, double_click, set_value, key, none.',
  input: S.obj({
    id: S.str('Widget to act on (and to track/capture)'),
    action: S.str('click | toggle | hover | unhover | press | release | double_click | set_value | key | none (default click when id given)'),
    duration_ms: S.int('Total time span captured (default 300)'),
    frames: S.int('Number of frames, 2-48 (default 8)'),
    value: { description: 'Value for action=set_value' },
    key: S.str('Key for action=key'),
    x: S.num('Coordinate target instead of id'),
    y: S.num('Coordinate target instead of id'),
    region: S.rect('Capture this rectangle instead of the widget'),
    capture_widget: S.str('Capture a different widget than the one acted on (e.g. a panel that animates)'),
    full_frame: S.bool('Capture the whole viewport'),
    padding: S.int('Padding around the captured widget (default 12)'),
    pre_settle_ms: S.int('Simulated time to settle the starting state before t=0 (default 400)'),
    zoom: S.int('Magnification of each frame'),
  }),
  async handler(args, { studio }) {
    const r = await studio.rpc('capture_animation', args, { timeout: 120000 });
    const frames = r.frames.map((f) => ({ ...f, img: decodeImage(Buffer.from(f.png, 'base64')) }));
    const w = frames[0].img.width;
    const h = frames[0].img.height;
    const z = autoZoom(w, h, args.zoom);
    const maxTile = 640;
    const tiles = frames.map((f) => {
      let im = z > 1 ? scaleNearest(f.img, z) : f.img;
      im = fitWidth(im, maxTile);
      return { image: im, label: `T=${Math.round(f.t_ms)}MS` };
    });
    const tileW = tiles[0].image.width;
    const maxCols = Math.max(1, Math.min(frames.length, Math.floor(2600 / (tileW + 8))));
    const columns = Math.ceil(frames.length / Math.ceil(frames.length / maxCols));
    const strip = compose(tiles, { columns, labelScale: 2 });
    const stripPng = encodePng(strip);
    const rec = await studio.saveCapture(stripPng, {
      kind: 'animation',
      label: `${r.action} ${args.id || ''} ${r.duration_ms}ms x${frames.length}`.trim(),
      width: strip.width,
      height: strip.height,
      region: r.region,
      widget: r.widget ? r.widget.id : null,
      build_id: r.meta?.build_id,
      frames: frames.map((f) => ({ t_ms: f.t_ms, state: f.state })),
      meta: r.meta,
    });
    const framesDir = path.join(studio.studioDir, 'captures', rec.capture_id);
    await ensureDir(framesDir);
    const frameFiles = [];
    for (let i = 0; i < frames.length; i++) {
      const file = path.join(framesDir, `frame-${String(i).padStart(2, '0')}.png`);
      await fsp.writeFile(file, Buffer.from(frames[i].png, 'base64'));
      frameFiles.push(file);
    }
    const track = frames.map((f) => {
      const s = f.state || {};
      const { bounds, hovered, active, focused, ...rest } = s;
      return { t_ms: f.t_ms, ...rest, hovered, active, bounds: bounds ? [bounds.x, bounds.y, bounds.width, bounds.height] : undefined };
    });
    return {
      capture_id: rec.capture_id,
      url: rec.url,
      path: rec.path,
      action: r.action,
      widget: r.widget,
      duration_ms: r.duration_ms,
      frame_count: frames.length,
      timestep_ms: r.timestep_ms,
      region: r.region,
      state_track: track,
      frame_files: frameFiles,
      errors: r.errors,
      images: [{ data: stripPng.toString('base64'), caption: `Filmstrip: ${r.action} ${args.id || ''}, ${frames.length} frames over ${r.duration_ms} ms (left to right, top to bottom)` }],
    };
  },
});

op('captures_list', {
  title: 'List captures',
  description: 'Recent captures (screenshots, widget captures, filmstrips) with ids and file paths.',
  input: S.obj({ limit: S.int('Default 30') }),
  async handler({ limit = 30 }, { studio }) {
    return { captures: studio.listCaptures(limit) };
  },
});

// ---------------------------------------------------------------------------
// Reference images & comparison
// ---------------------------------------------------------------------------

op('reference_load', {
  title: 'Load reference',
  description: 'Load a reference/target design image (PNG or JPEG) from a file path (absolute or project-relative) or base64 data, and make it the active reference for comparisons and build scores.',
  input: S.obj({ path: S.str('Image file path'), data_base64: S.str('Image data (base64)'), name: S.str('Reference name (default: file name)'), activate: S.bool('Make active (default true)') }),
  async handler({ path: p, data_base64, name, activate = true }, { studio }) {
    let buf;
    let sourceName = name;
    if (p) {
      const abs = path.isAbsolute(p) ? p : path.resolve(studio.projectDir, p);
      if (!fs.existsSync(abs)) throw new StudioError('file_not_found', `Reference image not found: ${p}`);
      buf = await fsp.readFile(abs);
      sourceName = sourceName || path.basename(abs);
    } else if (data_base64) {
      buf = Buffer.from(data_base64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    } else {
      throw new StudioError('bad_request', 'Provide "path" or "data_base64"');
    }
    const ref = await studio.addReference(buf, { name: sourceName, activate, source: p || 'upload' });
    const vp = studio.config.viewport;
    const img = decodeImage(buf);
    const note = img.width !== vp.width || img.height !== vp.height ? `Reference is ${img.width}x${img.height} but the viewport is ${vp.width}x${vp.height}; comparisons will ${Math.abs(img.width / img.height - vp.width / vp.height) < 0.03 * (vp.width / vp.height) ? 'scale the reference' : 'crop to the overlap'}. Consider preview_set_viewport to match.` : null;
    const shown = fitWidth(img, 1280);
    return { reference: ref, note, images: [{ data: encodePng(shown).toString('base64'), caption: `Reference "${ref.name}" (${img.width}x${img.height})` }] };
  },
});

op('reference_list', {
  title: 'List references',
  description: 'Loaded reference images, the active one, and their named regions.',
  input: S.obj({}),
  async handler(_a, { studio }) {
    return studio.referenceList();
  },
});

op('reference_set_active', {
  title: 'Activate reference',
  description: 'Choose which loaded reference is active.',
  input: S.obj({ name: S.str('Reference name') }, ['name']),
  async handler({ name }, { studio }) {
    studio.getReference(name);
    studio.references.active = name;
    await studio.saveReferences();
    return studio.referenceList();
  },
});

op('reference_set_regions', {
  title: 'Map reference regions',
  description:
    'Name rectangles of the reference image (in reference pixels) and optionally link each to a widget/region id, e.g. {name:"sidebar", x:0,y:0,width:220,height:800, widget:"sidebar.main"}. Enables reference_compare_region for targeted comparisons.',
  input: S.obj(
    {
      reference: S.str('Reference name (default active)'),
      regions: {
        type: 'array',
        items: S.obj({ name: S.str('Region name'), x: S.num('x'), y: S.num('y'), width: S.num('width'), height: S.num('height'), widget: S.str('Linked widget / STUDIO_REGION id') }, ['name', 'x', 'y', 'width', 'height']),
      },
      replace: S.bool('Replace all regions instead of merging by name'),
    },
    ['regions'],
  ),
  async handler({ reference, regions, replace = false }, { studio }) {
    const ref = studio.getReference(reference);
    const item = studio.references.items[ref.name];
    const map = new Map(replace ? [] : (item.regions || []).map((r) => [r.name, r]));
    for (const r of regions) map.set(r.name, r);
    item.regions = [...map.values()];
    await studio.saveReferences();
    return { reference: ref.name, regions: item.regions };
  },
});

op('reference_compare', {
  title: 'Compare with reference',
  description:
    'Capture the current preview and compare it with the reference. Returns a REFERENCE | CURRENT | DIFF image plus metrics: similarity (0-100), SSIM, pixel mismatch, colour (mean dE, palettes), edge alignment, estimated global layout offset, and hotspots (regions that differ most, with the widgets they overlap). Metrics guide attention; always look at the images too.',
  input: S.obj({
    reference: S.str('Reference name (default active)'),
    capture_id: S.str('Compare an existing capture instead of taking a new screenshot'),
    fit: S.str('auto | stretch | crop (how to handle different sizes; default auto)'),
  }),
  async handler({ reference, capture_id, fit = 'auto' }, { studio }) {
    const ref = studio.getReference(reference);
    const refImg = decodeImage(await fsp.readFile(ref.path));
    let curImg;
    let captureInfo;
    let widgets = [];
    if (capture_id) {
      const file = path.join(studio.studioDir, 'captures', `${capture_id}.png`);
      if (!fs.existsSync(file)) throw new StudioError('capture_not_found', `Capture ${capture_id} not found`);
      curImg = decodeImage(await fsp.readFile(file));
      captureInfo = { capture_id };
    } else {
      const { shot, img } = await freshCapture(studio);
      curImg = img;
      const rec = await studio.saveCapture(Buffer.from(shot.png, 'base64'), { kind: 'compare', label: `Compare vs ${ref.name}`, width: shot.width, height: shot.height, build_id: shot.meta?.build_id, meta: shot.meta });
      captureInfo = { capture_id: rec.capture_id, url: rec.url };
      try {
        widgets = (await studio.rpc('widgets', { limit: 2000 })).widgets;
      } catch {
        widgets = [];
      }
    }
    const { result, ref: refA, cur: curA, heat } = compareImages(refImg, curImg, { fit });
    if (result.hotspots) for (const h of result.hotspots) h.widgets = widgetsForRect(widgets, h);
    const composite = comparisonComposite(refA, curA, heat, { maxTile: 900 });
    const png = encodePng(composite);
    const rec = await studio.saveCapture(png, { kind: 'comparison', label: `Reference ${ref.name} vs current`, width: composite.width, height: composite.height, similarity: result.similarity });
    return {
      reference: ref.name,
      current: captureInfo,
      comparison_image: rec.url,
      summary: describeComparison(result),
      ...result,
      images: [{ data: png.toString('base64'), caption: `REFERENCE | CURRENT | DIFF (similarity ${result.similarity})` }],
    };
  },
});

op('reference_compare_region', {
  title: 'Compare region',
  description:
    'Compare one part of the design: a named reference region (see reference_set_regions), or a widget/STUDIO_REGION id whose bounds are compared with the same area of the reference. Reports pixel metrics plus the layout delta (position/size difference) between the reference region and the widget.',
  input: S.obj({
    region: S.str('Named reference region'),
    widget: S.str('Widget or STUDIO_REGION id to compare (overrides the region link)'),
    rect: S.rect('Explicit rectangle in reference pixels'),
    reference: S.str('Reference name (default active)'),
  }),
  async handler({ region, widget, rect, reference }, { studio }) {
    const ref = studio.getReference(reference);
    const refImg = decodeImage(await fsp.readFile(ref.path));
    const { shot, img: curImg } = await freshCapture(studio);
    const sx = curImg.width / refImg.width;
    const sy = curImg.height / refImg.height;
    let refRect = rect || null;
    let widgetId = widget || null;
    let regionName = null;
    if (region) {
      const r = (studio.references.items[ref.name].regions || []).find((x) => x.name === region);
      if (!r) throw new StudioError('region_not_found', `Region "${region}" is not defined on reference "${ref.name}"`, { regions: (studio.references.items[ref.name].regions || []).map((x) => x.name) });
      refRect = refRect || { x: r.x, y: r.y, width: r.width, height: r.height };
      widgetId = widgetId || r.widget || null;
      regionName = r.name;
    }
    let curRect;
    let widgetInfo = null;
    if (widgetId) {
      const insp = await studio.rpc('inspect', { id: widgetId });
      widgetInfo = insp.widget;
      curRect = { ...widgetInfo.bounds };
      if (!refRect) refRect = { x: curRect.x / sx, y: curRect.y / sy, width: curRect.width / sx, height: curRect.height / sy };
    } else if (refRect) {
      curRect = { x: refRect.x * sx, y: refRect.y * sy, width: refRect.width * sx, height: refRect.height * sy };
    } else {
      throw new StudioError('bad_request', 'Provide region, widget or rect');
    }
    const refCrop = crop(refImg, refRect);
    const curCrop = crop(curImg, curRect);
    const { result, ref: refA, cur: curA, heat } = compareImages(refCrop, curCrop, { fit: 'stretch', maxShift: 16 });
    const layout = {
      reference_rect: roundRect(refRect),
      current_rect: roundRect(curRect),
      delta: {
        x: Math.round(curRect.x - refRect.x * sx),
        y: Math.round(curRect.y - refRect.y * sy),
        width: Math.round(curRect.width - refRect.width * sx),
        height: Math.round(curRect.height - refRect.height * sy),
      },
      note: 'delta = current - reference (in current viewport pixels); e.g. delta.width = 12 means the widget is 12px wider than the design',
    };
    const composite = comparisonComposite(refA, curA, heat, { maxTile: 700 });
    const png = encodePng(composite);
    const rec = await studio.saveCapture(png, { kind: 'comparison', label: `Region ${regionName || widgetId || 'rect'} vs ${ref.name}`, width: composite.width, height: composite.height, similarity: result.similarity, build_id: shot.meta?.build_id });
    return {
      reference: ref.name,
      region: regionName,
      widget: widgetInfo ? { id: widgetInfo.id, bounds: widgetInfo.bounds } : null,
      layout,
      comparison_image: rec.url,
      summary: describeComparison(result),
      ...result,
      images: [{ data: png.toString('base64'), caption: `Region ${regionName || widgetId || ''}: REFERENCE | CURRENT | DIFF (similarity ${result.similarity})` }],
    };
  },
});

function roundRect(r) {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

op('history_list', {
  title: 'Build history',
  description: 'Recent builds (newest first) with success, changed files, notes, screenshot paths and reference similarity scores, to track whether iterations improve.',
  input: S.obj({ limit: S.int('Default 20') }),
  async handler({ limit = 20 }, { studio }) {
    const builds = studio.history.list().slice(-limit).reverse();
    return { builds: builds.map((b) => ({ ...studio.history.summary(b), screenshot_path: b.screenshot ? path.join(studio.studioDir, b.screenshot) : null })) };
  },
});

op('history_diff', {
  title: 'Diff builds',
  description: 'Unified source diff between two builds (or a build and the working tree with to="working").',
  input: S.obj({ from: S.int('Older build id'), to: { description: 'Newer build id or "working" (default: latest build)', anyOf: [{ type: 'integer' }, { type: 'string' }] }, path: S.str('Only this file') }, ['from']),
  async handler({ from, to, path: only }, { studio }) {
    const latest = studio.history.latest();
    const target = to ?? (latest ? latest.id : 'working');
    const files = studio.history.diff(from, target === 'working' ? 'working' : Number(target), only);
    return { from, to: target, files };
  },
});

op('history_revert', {
  title: 'Revert to build',
  description: 'Restore all project files to their state at a given build (the current state stays recoverable from history), then rebuild by default.',
  input: S.obj({ build_id: S.int('Build to restore'), rebuild: S.bool('Build after restoring (default true)') }, ['build_id']),
  async handler({ build_id, rebuild = true }, { studio, source }) {
    await studio.history.snapshot();
    const r = await studio.history.restore(build_id);
    const out = { restored_from: build_id, written: r.written, deleted: r.deleted };
    if (rebuild) {
      const b = await studio.build({ note: `Reverted to build #${build_id}`, source, capture: true });
      await studio.history.update(b.build_id, { restored_from: build_id });
      Object.assign(out, { build: buildSummaryForAgent(b) });
      if (b.screenshot) out.images = [{ data: (await fsp.readFile(b.screenshot.path)).toString('base64'), caption: `Build #${b.build_id} (reverted to #${build_id})` }];
    }
    return out;
  },
});

op('history_note', {
  title: 'Annotate build',
  description: 'Attach a note to a build (default latest), e.g. what looked wrong or what you intend to try next.',
  input: S.obj({ build_id: S.int('Build id (default latest)'), note: S.str('Note text') }, ['note']),
  async handler({ build_id, note }, { studio }) {
    const b = build_id ? studio.history.get(build_id) : studio.history.latest();
    if (!b) throw new StudioError('no_build', 'No builds yet');
    const notes = [...(b.notes || []), { time: new Date().toISOString(), text: note }];
    await studio.history.update(b.id, { notes, note: b.note || note });
    studio.emit('history_updated', {});
    return { build_id: b.id, notes };
  },
});

op('history_compare_builds', {
  title: 'Compare builds',
  description: 'Compare the screenshots of two builds side by side with a diff (e.g. to check whether a change made the design worse).',
  input: S.obj({ a: S.int('First (older) build'), b: S.int('Second build (default latest)') }, ['a']),
  async handler({ a, b }, { studio }) {
    const A = studio.history.get(a);
    const B = b ? studio.history.get(b) : studio.history.latest({ successful: true });
    if (!A.screenshot || !B.screenshot) throw new StudioError('no_screenshot', 'Both builds need a screenshot (successful builds with capture)');
    const ia = decodeImage(await fsp.readFile(path.join(studio.studioDir, A.screenshot)));
    const ib = decodeImage(await fsp.readFile(path.join(studio.studioDir, B.screenshot)));
    const { result, ref, cur, heat } = compareImages(ia, ib, { fit: 'auto' });
    const composite = comparisonComposite(ref, cur, heat, { labels: [`BUILD ${A.id}`, `BUILD ${B.id}`, 'DIFF'], maxTile: 800 });
    const png = encodePng(composite);
    return {
      a: studio.history.summary(A),
      b: studio.history.summary(B),
      similarity: result.similarity,
      pixel: result.pixel,
      hotspots: result.hotspots,
      images: [{ data: png.toString('base64'), caption: `Build #${A.id} | Build #${B.id} | diff` }],
    };
  },
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

op('export_source', {
  title: 'Export native project',
  description:
    'Export the project as a standalone native C++ Dear ImGui project: your sources and assets, studio/studio.h (macros compile away without IMGUI_STUDIO), Dear ImGui, a GLFW + OpenGL3 host (native/main.cpp) and CMakeLists.txt; also zipped.',
  input: S.obj({ dest: S.str('Output directory (default export/<name>-build<N>)'), zip: S.bool('Also create a .zip (default true)') }),
  async handler({ dest, zip = true }, { studio }) {
    return exportProject(studio, { dest, zip });
  },
});

op('export_check', {
  title: 'Check native compile',
  description: 'Compile all project sources with the host C++ compiler without IMGUI_STUDIO (syntax-only) to verify the code has no Studio dependency and will build natively.',
  input: S.obj({}),
  async handler(_a, { studio }) {
    return nativeCheck(studio);
  },
});

// ---------------------------------------------------------------------------
// Studio UI-only operations (not exposed as MCP tools)
// ---------------------------------------------------------------------------

op('studio_settings', {
  mcp: false,
  title: 'Settings',
  description: 'Get or update Studio settings (auto_build, agent_target, headless).',
  input: S.obj({ auto_build: S.bool(''), agent_target: S.str(''), headless: S.bool('') }),
  async handler(args, { studio }) {
    const patch = {};
    for (const k of ['auto_build', 'agent_target', 'headless']) if (args[k] !== undefined) patch[k] = args[k];
    if (Object.keys(patch).length) await studio.saveSettings(patch);
    return studio.settings;
  },
});

op('capture_upload', {
  mcp: false,
  title: 'Save capture',
  description: 'Save a PNG captured by the visible Studio preview.',
  input: S.obj({ png: S.str('base64 PNG'), label: S.str(''), meta: { type: 'object' }, region: { type: 'object' }, kind: S.str('') }, ['png']),
  async handler({ png, label = 'Studio preview', meta = {}, region = null, kind = 'screen' }, { studio }) {
    const buf = Buffer.from(png, 'base64');
    const img = decodeImage(buf);
    return studio.saveCapture(buf, { kind, label, width: img.width, height: img.height, region, build_id: meta.build_id, meta, source: 'studio' });
  },
});

op('agent_say', {
  mcp: false,
  title: 'Agent narration',
  description: 'Record a message from the design agent in the activity log.',
  input: S.obj({ text: S.str('Message') }, ['text']),
  async handler({ text }) {
    return { text: String(text) };
  },
});

op('activity_log', {
  mcp: false,
  title: 'Activity log',
  description: 'Recent tool/operation calls.',
  input: S.obj({ limit: S.int('') }),
  async handler({ limit = 200 }, { studio }) {
    return { entries: studio.opLog.slice(-limit) };
  },
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string' && v.length > 160) out[k] = `${v.slice(0, 160)}... (${v.length} chars)`;
    else if (Array.isArray(v) && JSON.stringify(v).length > 400) out[k] = `[${v.length} items]`;
    else out[k] = v;
  }
  return out;
}

function summarizeResult(name, r) {
  if (!r || typeof r !== 'object') return null;
  if (name === 'agent_say') return String(r.text || '').slice(0, 600);
  if (name === 'build_start') return r.success ? `build #${r.build_id} ok (${r.duration_ms} ms)` : `build #${r.build_id} failed: ${r.errors?.length || 0} error(s)`;
  if (r.similarity != null) return `similarity ${r.similarity}`;
  if (r.capture_id) return `capture ${r.capture_id}`;
  if (r.after && r.after.state) return `after: ${JSON.stringify(r.after.state).slice(0, 160)}`;
  if (Array.isArray(r.widgets)) return `${r.widgets.length} widgets`;
  if (r.diff !== undefined) return `${r.path}`;
  return null;
}

export async function runOp(studio, name, args = {}, { source = 'api' } = {}) {
  const def = OPS.get(name);
  if (!def) throw new StudioError('unknown_op', `Unknown operation: ${name}`);
  const started = Date.now();
  const entry = { id: `${started}-${Math.random().toString(36).slice(2, 7)}`, time: new Date(started).toISOString(), source, op: name, args: name === 'agent_say' ? {} : summarizeArgs(args) };
  try {
    const result = await def.handler(args || {}, { studio, source });
    entry.ok = true;
    entry.duration_ms = Date.now() - started;
    entry.summary = summarizeResult(name, result);
    if (result && result.images) {
      entry.image_urls = [result.url, result.comparison_image, result.screenshot?.url].filter(Boolean).slice(0, 2);
      if (!entry.image_urls.length && name === 'build_start' && result.screenshot) entry.image_urls = [result.screenshot.url];
    }
    if (name !== 'activity_log' && name !== 'studio_settings') studio.logOp(entry);
    return result;
  } catch (e) {
    entry.ok = false;
    entry.duration_ms = Date.now() - started;
    entry.error = { code: e.code || 'error', message: e.message };
    studio.logOp(entry);
    throw e;
  }
}
