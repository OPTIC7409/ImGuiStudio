// The Studio core: one project, its builds, history, captures, references and the
// preview runtimes. HTTP, the Studio UI and the MCP adapter are thin layers on top.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Builder } from './builder.js';
import { findToolchain, imguiDirFor, loadProjectConfig } from './config.js';
import { History } from './history.js';
import { HeadlessRunner } from './headless.js';
import { RuntimeHub } from './runtime-hub.js';
import { decodeImage, encodePng, thumbnail } from './images.js';
import { compareImages } from './compare.js';
import { Emitter, StudioError, ensureDir, log, nowIso, parseColor, readJsonSync, toPosix, walkFiles, writeJsonAtomic } from './util.js';

const KEEP_BUILD_BINARIES = 12;

export class Studio extends Emitter {
  constructor({ projectDir, port }) {
    super();
    this.projectDir = path.resolve(projectDir);
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.studioDir = path.join(this.projectDir, '.studio');
    this.hub = new RuntimeHub();
    this.history = new History(this.projectDir);
    this.builder = new Builder({ projectDir: this.projectDir, onOutput: (text) => this.emit('build_output', { id: this.currentBuild, text }) });
    this.headless = new HeadlessRunner({ baseUrl: this.baseUrl, hub: this.hub });
    this.buildChain = Promise.resolve();
    this.currentBuild = null;
    this.captureCounter = 0;
    this.opLog = [];
    this.settings = readJsonSync(path.join(this.studioDir, 'settings.json'), { auto_build: false, agent_target: 'auto', headless: true });
    this.references = readJsonSync(path.join(this.studioDir, 'references.json'), { active: null, items: {} });
    for (const evt of ['runtime_status', 'runtime_error', 'runtime_log', 'runtime_ready']) this.hub.on(evt, (d) => this.emit(evt, d));
  }

  async init() {
    await ensureDir(this.studioDir);
    for (const d of ['builds', 'captures', 'thumbs', 'references', 'cache']) await ensureDir(path.join(this.studioDir, d));
    this.config = loadProjectConfig(this.projectDir);
    const existing = fs.readdirSync(path.join(this.studioDir, 'captures')).filter((f) => f.endsWith('.png'));
    this.captureCounter = existing.length;
    this.watch();
  }

  get name() {
    return this.config?.name || path.basename(this.projectDir);
  }

  reloadConfig() {
    this.config = loadProjectConfig(this.projectDir);
    return this.config;
  }

  async saveSettings(patch) {
    Object.assign(this.settings, patch);
    await writeJsonAtomic(path.join(this.studioDir, 'settings.json'), this.settings);
    this.emit('settings', this.settings);
    return this.settings;
  }

  // ---------------------------------------------------------------------------
  // File watching
  // ---------------------------------------------------------------------------

  watch() {
    let pending = new Set();
    let timer = null;
    try {
      this.watcher = fs.watch(this.projectDir, { recursive: true }, (_evt, file) => {
        if (!file) return;
        const rel = toPosix(String(file));
        if (/^(\.studio|export|node_modules|\.git|build)(\/|$)/.test(rel)) return;
        pending.add(rel);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const paths = [...pending];
          pending = new Set();
          if (paths.includes('studio.json')) {
            try {
              this.reloadConfig();
            } catch (e) {
              log('studio.json reload failed:', e.message);
            }
          }
          this.emit('files_changed', { paths });
          if (this.settings.auto_build && paths.some((p) => /\.(c|cc|cpp|cxx|h|hpp|hh|inl)$|studio\.json$/.test(p))) {
            this.build({ source: 'auto', capture: true }).catch((e) => log('auto build failed:', e.message));
          }
        }, 200);
      });
    } catch (e) {
      log('file watching unavailable:', e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Builds
  // ---------------------------------------------------------------------------

  build(opts = {}) {
    const run = this.buildChain.then(() => this.runBuild(opts));
    this.buildChain = run.catch(() => {});
    return run;
  }

  async runBuild({ note = null, capture = true, source = 'api' } = {}) {
    this.reloadConfig();
    const id = this.history.nextId();
    this.currentBuild = id;
    const outDir = path.join(this.studioDir, 'builds', String(id));
    this.emit('build_started', { id, source, time: nowIso() });
    let result;
    try {
      result = await this.builder.build({ buildId: id, outDir });
    } catch (e) {
      result = {
        build_id: id,
        success: false,
        phase: 'setup',
        duration_ms: 0,
        errors: [{ severity: 'error', file: null, line: 0, column: 0, message: e.message, code: e.code }],
        warnings: [],
        compiled: [],
        log: `${e.message}\n`,
      };
      this.emit('build_output', { id, text: `error: ${e.message}\n` });
    }
    const files = await this.history.snapshot();
    await fsp.writeFile(path.join(this.studioDir, 'builds', `${id}.log`), result.log || '').catch(() => {});
    const entry = await this.history.record({
      id,
      time: nowIso(),
      source,
      success: result.success,
      phase: result.phase,
      duration_ms: result.duration_ms,
      compiled: result.compiled,
      error_count: result.errors.length,
      warning_count: result.warnings.length,
      errors: result.errors.slice(0, 50),
      warnings: result.warnings.slice(0, 50),
      note,
      notes: note ? [{ time: nowIso(), text: note }] : [],
      files,
    });
    const summary = {
      build_id: id,
      success: result.success,
      phase: result.phase,
      duration_ms: result.duration_ms,
      compiled: result.compiled,
      cached_units: result.cached,
      link_ms: result.link_ms,
      errors: result.errors,
      warnings: result.warnings,
      changed_files: entry.changed.map((c) => c.path),
    };

    if (result.success) {
      this.pruneBuilds().catch(() => {});
      this.emit('preview_reload', { build: id });
      this.hub.broadcast({ type: 'reload', build: id }, { role: 'studio' });
      const load = await this.loadAgentPreview(id);
      summary.runtime = load;
      if (load.loaded && capture) {
        try {
          const shot = await this.captureBuildScreenshot(id);
          summary.screenshot = shot;
        } catch (e) {
          summary.screenshot_error = e.message;
        }
      }
    }
    this.currentBuild = null;
    this.emit('build_finished', { ...summary, history: this.history.summary(this.history.get(id)) });
    this.emit('history_updated', {});
    return summary;
  }

  async pruneBuilds() {
    const dir = path.join(this.studioDir, 'builds');
    const ids = fs
      .readdirSync(dir)
      .filter((d) => /^\d+$/.test(d))
      .map(Number)
      .sort((a, b) => b - a);
    for (const id of ids.slice(KEEP_BUILD_BINARIES)) await fsp.rm(path.join(dir, String(id)), { recursive: true, force: true });
  }

  latestBuildId() {
    const b = this.history.latest({ successful: true });
    if (!b) return null;
    if (!fs.existsSync(path.join(this.studioDir, 'builds', String(b.id), 'app.wasm'))) return null;
    return b.id;
  }

  // Load (or reload) a build into the headless agent preview.
  async loadAgentPreview(buildId = this.latestBuildId()) {
    if (buildId == null) return { loaded: false, reason: 'no successful build yet' };
    if (this.settings.headless === false) return { loaded: false, reason: 'headless preview disabled in settings' };
    const cfg = this.config;
    const res = await this.headless.load(buildId, cfg.viewport);
    const errors = this.hub.errorsForBuild(buildId).filter((e) => e.role === 'agent').map(({ runtime, role, key, ...e }) => e);
    if (!res.ok && res.reason) {
      return { loaded: false, reason: res.reason, errors };
    }
    return { loaded: res.ok, crashed: !!res.crashed, errors };
  }

  // Runtime that agent commands target.
  async agentRuntime() {
    const latest = this.latestBuildId();
    if (latest == null) throw new StudioError('no_build', 'There is no successful build yet. Run build_start first.');
    const target = this.settings.agent_target || 'auto';
    if (target !== 'studio' && this.settings.headless !== false) {
      if (this.headless.build !== latest || !this.hub.pick({ role: 'agent' })) {
        await this.loadAgentPreview(latest);
      }
      const rt = this.hub.pick({ role: 'agent' });
      if (rt) {
        if (rt.crashed) throw new StudioError('runtime_crashed', 'The preview crashed. See runtime errors (runtime_errors) and fix the code, then rebuild.', { errors: this.hub.errorsForBuild(rt.build).slice(-10) });
        return rt;
      }
    }
    const rt = this.hub.pick({ target: 'studio' });
    if (!rt) {
      throw new StudioError(
        'no_runtime',
        `No preview runtime available${this.headless.reason ? ` (${this.headless.reason})` : ''}. Open ${this.baseUrl} in a browser to host the preview.`,
      );
    }
    return rt;
  }

  async rpc(method, params = {}, opts = {}) {
    const rt = await this.agentRuntime();
    return this.hub.call(rt, method, params, opts);
  }

  async resetAgentPreview() {
    const id = this.latestBuildId();
    if (id == null) throw new StudioError('no_build', 'There is no successful build yet');
    this.headless.build = null;
    return this.loadAgentPreview(id);
  }

  // ---------------------------------------------------------------------------
  // Captures
  // ---------------------------------------------------------------------------

  async saveCapture(png, meta, { name = null } = {}) {
    const id = name || `cap-${String(++this.captureCounter).padStart(5, '0')}`;
    const file = path.join(this.studioDir, 'captures', `${id}.png`);
    await fsp.writeFile(file, png);
    const record = { capture_id: id, path: file, url: `/studio-files/captures/${id}.png`, time: nowIso(), ...meta };
    await fsp.writeFile(path.join(this.studioDir, 'captures', `${id}.json`), JSON.stringify(record, null, 2));
    this.emit('capture_added', record);
    return record;
  }

  listCaptures(limit = 100) {
    const dir = path.join(this.studioDir, 'captures');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJsonSync(path.join(dir, f), null))
      .filter(Boolean)
      .sort((a, b) => (a.time < b.time ? 1 : -1))
      .slice(0, limit);
  }

  async captureBuildScreenshot(buildId) {
    const rt = this.hub.pick({ role: 'agent' }) || this.hub.pick({ target: 'studio' });
    if (!rt) throw new StudioError('no_runtime', 'No preview runtime to capture from');
    const shot = await this.hub.call(rt, 'capture', {});
    const png = Buffer.from(shot.png, 'base64');
    const rec = await this.saveCapture(png, { kind: 'build', build_id: buildId, width: shot.width, height: shot.height, meta: shot.meta, label: `Build #${buildId}` }, { name: `build-${buildId}` });
    const img = decodeImage(png);
    const thumbFile = path.join(this.studioDir, 'thumbs', `build-${buildId}.png`);
    await fsp.writeFile(thumbFile, encodePng(thumbnail(img, 320, 200)));
    const patch = { screenshot: `captures/build-${buildId}.png`, thumbnail: `thumbs/build-${buildId}.png` };
    const ref = this.activeReference();
    if (ref) {
      try {
        const refImg = decodeImage(fs.readFileSync(ref.path));
        const { result } = compareImages(refImg, img, { withHotspots: false });
        patch.score = result.similarity;
        patch.reference = ref.name;
        rec.similarity = result.similarity;
      } catch (e) {
        log('build comparison failed:', e.message);
      }
    }
    await this.history.update(buildId, patch);
    return { ...rec, similarity: patch.score ?? null, reference: patch.reference ?? null };
  }

  // ---------------------------------------------------------------------------
  // References
  // ---------------------------------------------------------------------------

  async saveReferences() {
    await writeJsonAtomic(path.join(this.studioDir, 'references.json'), this.references);
    this.emit('reference_updated', this.referenceList());
  }

  referenceList() {
    return {
      active: this.references.active,
      items: Object.values(this.references.items).map((r) => ({ ...r, url: `/studio-files/references/${r.file}` })),
    };
  }

  activeReference() {
    const name = this.references.active;
    if (!name || !this.references.items[name]) return null;
    const r = this.references.items[name];
    return { ...r, path: path.join(this.studioDir, 'references', r.file), url: `/studio-files/references/${r.file}` };
  }

  getReference(name) {
    const key = name || this.references.active;
    const r = key ? this.references.items[key] : null;
    if (!r) throw new StudioError('no_reference', name ? `Reference "${name}" not found` : 'No active reference. Load one with reference_load.');
    return { ...r, path: path.join(this.studioDir, 'references', r.file), url: `/studio-files/references/${r.file}` };
  }

  async addReference(buf, { name, activate = true, source = null }) {
    const img = decodeImage(buf);
    const clean = String(name || `reference-${Object.keys(this.references.items).length + 1}`)
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .toLowerCase();
    const file = `${clean}.png`;
    await fsp.writeFile(path.join(this.studioDir, 'references', file), encodePng(img));
    const prev = this.references.items[clean];
    this.references.items[clean] = { name: clean, file, width: img.width, height: img.height, source, added: nowIso(), regions: prev ? prev.regions : [] };
    if (activate || !this.references.active) this.references.active = clean;
    await this.saveReferences();
    return { ...this.references.items[clean], active: this.references.active === clean, url: `/studio-files/references/${file}` };
  }

  // ---------------------------------------------------------------------------
  // Preview configuration for runtime pages
  // ---------------------------------------------------------------------------

  previewConfig(buildParam) {
    const id = buildParam && buildParam !== 'latest' ? Number(buildParam) : this.latestBuildId();
    if (id == null) return { ok: false, message: 'No successful build yet. Build the project to see the preview.' };
    const dir = path.join(this.studioDir, 'builds', String(id));
    if (!fs.existsSync(path.join(dir, 'app.js'))) return { ok: false, message: `Build #${id} has no binaries (failed or pruned).` };
    const cfg = this.config;
    const assets = [];
    for (const a of cfg.assets) {
      const abs = path.resolve(this.projectDir, a);
      if (!fs.existsSync(abs)) continue;
      const rel = toPosix(path.relative(this.projectDir, abs));
      for (const f of walkFiles(abs)) {
        const p = rel ? `${rel}/${f}` : f;
        assets.push({ path: p, url: `/project-files/${p.split('/').map(encodeURIComponent).join('/')}` });
      }
    }
    return {
      ok: true,
      build_id: id,
      project: this.name,
      js_url: `/builds/${id}/app.js`,
      base_url: `/builds/${id}/`,
      viewport: cfg.viewport,
      clear_color: parseColor(cfg.background),
      settle_ms: cfg.settle_ms ?? 500,
      assets,
    };
  }

  // ---------------------------------------------------------------------------
  // Agent/tool activity log
  // ---------------------------------------------------------------------------

  logOp(entry) {
    this.opLog.push(entry);
    if (this.opLog.length > 500) this.opLog.shift();
    fsp.appendFile(path.join(this.studioDir, 'activity.jsonl'), `${JSON.stringify(entry)}\n`).catch(() => {});
    this.emit('op_log', entry);
  }

  info() {
    const tc = findToolchain();
    const latest = this.history.latest();
    let imguiDir = null;
    try {
      imguiDir = imguiDirFor(this.projectDir, this.config);
    } catch {
      // reported by builds
    }
    return {
      name: this.name,
      project_dir: this.projectDir,
      studio_url: this.baseUrl,
      config: this.config,
      imgui_dir: imguiDir,
      toolchain: tc ? { emcc: tc.emcc, version: tc.version } : null,
      latest_build: this.history.summary(latest),
      latest_successful_build: this.latestBuildId(),
      runtimes: this.hub.status(),
      headless: { available: this.headless.available, reason: this.headless.reason, build: this.headless.build },
      reference: this.activeReference() ? { name: this.references.active, url: this.activeReference().url } : null,
      settings: this.settings,
    };
  }

  async shutdown() {
    try {
      this.watcher?.close();
    } catch {
      // ignore
    }
    await this.headless.close();
  }
}
