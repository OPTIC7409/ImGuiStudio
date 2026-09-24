// Incremental Emscripten builder.
//
// - Dear ImGui + the Studio runtime are compiled once (-O2) into a content-addressed
//   global cache shared by every project.
// - Project translation units are cached per file using the compiler's depfile:
//   an object is reused when the source, every header it included, and the flags
//   are byte-identical to the last compile.
// - Only changed TUs recompile (in parallel); linking reuses the previous output
//   when no object changed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  BUILTIN_IMGUI_DIR,
  GLOBAL_CACHE_DIR,
  RUNTIME_DIR,
  STUDIO_ROOT,
  imguiDirFor,
  loadProjectConfig,
  requireToolchain,
} from './config.js';
import { makePathMapper, parseDiagnostics } from './diagnostics.js';
import { FileHashCache, ensureDir, globToRegExp, mapLimit, readJsonSync, sha1, toPosix, walkFiles } from './util.js';

const SOURCE_EXT = /\.(cpp|cc|cxx|c)$/i;
const BUILD_FORMAT = 3; // bump to invalidate caches when flags/layout change

export const LINK_FLAGS = [
  '-sMODULARIZE=1',
  '-sEXPORT_NAME=createStudioModule',
  '-sENVIRONMENT=web',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sSTACK_SIZE=1048576',
  '-sMAX_WEBGL_VERSION=2',
  '-sMIN_WEBGL_VERSION=2',
  '-sFORCE_FILESYSTEM=1',
  '-sEXPORTED_RUNTIME_METHODS=FS,UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8',
  '-sEXPORTED_FUNCTIONS=_main,_malloc,_free',
  '-sASSERTIONS=1',
  '--profiling-funcs',
];

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, output: `${out}\n${e.message}` }));
    child.on('close', (code) => resolve({ code, output: out }));
  });
}

// Parse a make-style depfile into absolute paths.
export function parseDepfile(text) {
  const joined = text.replace(/\\\r?\n/g, ' ');
  const colon = joined.indexOf(': ');
  const body = colon >= 0 ? joined.slice(colon + 2) : joined;
  const deps = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === ' ') {
      cur += ' ';
      i++;
    } else if (/\s/.test(c)) {
      if (cur) deps.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur) deps.push(cur);
  return deps;
}

export class Builder {
  constructor({ projectDir, onOutput }) {
    this.projectDir = projectDir;
    this.onOutput = onOutput || (() => {});
    this.hashes = new FileHashCache();
    this.lastLink = null; // { key, dir }
  }

  get studioDir() {
    return path.join(this.projectDir, '.studio');
  }

  collectSources(cfg) {
    const include = cfg.sources.map(globToRegExp);
    const exclude = cfg.exclude.map(globToRegExp);
    return walkFiles(this.projectDir)
      .filter((f) => SOURCE_EXT.test(f))
      .filter((f) => include.some((re) => re.test(f)))
      .filter((f) => !exclude.some((re) => re.test(f)));
  }

  flagsFor(cfg, imguiDir, { core }) {
    const flags = [`-std=${cfg.cxx_std}`, '-DIMGUI_STUDIO', '-DIMGUI_USER_CONFIG="imconfig_studio.h"'];
    if (cfg.imconfig) flags.push(`-DIMGUI_STUDIO_PROJECT_CONFIG="${path.resolve(this.projectDir, cfg.imconfig)}"`);
    for (const d of cfg.defines) flags.push(`-D${d}`);
    if (!core) {
      for (const inc of cfg.include_dirs) {
        const abs = path.resolve(this.projectDir, inc);
        if (fs.existsSync(abs)) flags.push(`-I${abs}`);
      }
    }
    flags.push(`-I${imguiDir}`, `-I${path.join(RUNTIME_DIR, 'include')}`, `-I${path.join(RUNTIME_DIR, 'src')}`);
    flags.push('-fno-color-diagnostics', '-fdiagnostics-absolute-paths', '-ferror-limit=40');
    if (core) {
      flags.push('-O2', '-w');
    } else {
      flags.push(cfg.optimize || '-O0', '-Wall', '-Wno-unused-function', '-Wno-unused-variable', '-Wno-unused-but-set-variable');
      flags.push(`-ffile-prefix-map=${this.projectDir}${path.sep}=`);
      flags.push(...cfg.cxx_flags);
    }
    return flags;
  }

  coreSources(imguiDir) {
    const list = ['imgui.cpp', 'imgui_draw.cpp', 'imgui_widgets.cpp', 'imgui_tables.cpp', 'imgui_demo.cpp'].map((f) => path.join(imguiDir, f));
    const backend = fs.existsSync(path.join(imguiDir, 'backends', 'imgui_impl_opengl3.cpp'))
      ? path.join(imguiDir, 'backends', 'imgui_impl_opengl3.cpp')
      : path.join(BUILTIN_IMGUI_DIR, 'backends', 'imgui_impl_opengl3.cpp');
    list.push(backend);
    list.push(path.join(RUNTIME_DIR, 'src', 'studio_runtime.cpp'));
    list.push(path.join(RUNTIME_DIR, 'src', 'studio_host_web.cpp'));
    const stdlib = path.join(imguiDir, 'misc', 'cpp', 'imgui_stdlib.cpp');
    if (fs.existsSync(stdlib)) list.push(stdlib);
    return list;
  }

  // Compile one TU unless a cached object with identical inputs exists.
  async compileUnit(tc, unit) {
    const { src, flags, cacheDir } = unit;
    const key = sha1(JSON.stringify([BUILD_FORMAT, tc.version, src, flags]));
    const obj = path.join(cacheDir, `${key}.o`);
    const metaFile = path.join(cacheDir, `${key}.json`);
    const meta = readJsonSync(metaFile, null);
    if (meta && fs.existsSync(obj)) {
      let valid = true;
      for (const [dep, h] of Object.entries(meta.deps)) {
        if (this.hashes.hash(dep) !== h) {
          valid = false;
          break;
        }
      }
      if (valid) return { src, obj, cached: true, output: '', ok: true, objHash: meta.objHash };
    }
    const depFile = path.join(cacheDir, `${key}.d`);
    const tmpObj = `${obj}.${process.pid}.tmp`;
    const args = [...flags, '-c', src, '-o', tmpObj, '-MMD', '-MF', depFile];
    const started = Date.now();
    const res = await run(tc.emxx, args, { env: tc.env, cwd: this.projectDir });
    const ms = Date.now() - started;
    if (res.code !== 0) {
      await fsp.rm(tmpObj, { force: true });
      return { src, obj: null, cached: false, output: res.output, ok: false, ms };
    }
    await fsp.rename(tmpObj, obj);
    const deps = {};
    let depList = [src];
    try {
      depList = parseDepfile(await fsp.readFile(depFile, 'utf8'));
    } catch {
      // fall back to the source only
    }
    for (const d of depList) {
      const abs = path.resolve(this.projectDir, d);
      deps[abs] = this.hashes.hash(abs);
    }
    deps[src] = this.hashes.hash(src);
    const objHash = sha1(await fsp.readFile(obj));
    await fsp.writeFile(metaFile, JSON.stringify({ src, deps, objHash, ms }));
    return { src, obj, cached: false, output: res.output, ok: true, ms, objHash };
  }

  async build({ buildId, outDir }) {
    const started = Date.now();
    const cfg = loadProjectConfig(this.projectDir);
    const tc = requireToolchain();
    const imguiDir = imguiDirFor(this.projectDir, cfg);
    const coreCache = await ensureDir(path.join(GLOBAL_CACHE_DIR, 'obj'));
    const projCache = await ensureDir(path.join(this.studioDir, 'cache', 'obj'));

    const sources = this.collectSources(cfg);
    const coreFlags = this.flagsFor(cfg, imguiDir, { core: true });
    const projFlags = this.flagsFor(cfg, imguiDir, { core: false });
    const units = [
      ...this.coreSources(imguiDir).map((src) => ({ src, flags: coreFlags, cacheDir: coreCache, core: true })),
      ...sources.map((rel) => ({ src: path.join(this.projectDir, rel), rel, flags: projFlags, cacheDir: projCache, core: false })),
    ];

    const objToSource = new Map();
    const mapPath = makePathMapper({ projectDir: this.projectDir, studioRoot: STUDIO_ROOT, objToSource });
    let log = '';
    const emit = (text) => {
      log += text;
      this.onOutput(text);
    };
    emit(`Build #${buildId}: ${sources.length} project source file(s), ${tc.version}\n`);
    if (sources.length === 0) {
      emit('error: no source files found (check "sources" in studio.json)\n');
      return this.result({ buildId, started, success: false, log, errors: [{ severity: 'error', file: 'studio.json', line: 0, column: 0, message: 'No source files matched "sources" in studio.json' }] });
    }

    const jobs = Math.max(1, os.cpus().length);
    const results = await mapLimit(units, jobs, async (u) => {
      const r = await this.compileUnit(tc, u);
      const name = u.core ? path.relative(STUDIO_ROOT, u.src) : u.rel;
      if (!r.cached) emit(`${r.ok ? 'compiled' : 'FAILED  '} ${toPosix(name)}${r.ms ? ` (${r.ms} ms)` : ''}\n`);
      if (r.output.trim()) emit(r.output.endsWith('\n') ? r.output : `${r.output}\n`);
      if (r.obj) objToSource.set(r.obj, u.src);
      return { ...r, unit: u };
    });

    const diagnostics = parseDiagnostics(results.map((r) => r.output).join('\n'), mapPath);
    const compiled = results.filter((r) => !r.cached && !r.unit.core).map((r) => r.unit.rel);
    const coreCompiled = results.filter((r) => !r.cached && r.unit.core).length;
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      return this.result({ buildId, started, success: false, log, diagnostics, compiled, coreCompiled, cached: results.filter((r) => r.cached).length, phase: 'compile' });
    }

    // Link (or reuse the previous link output when no object changed).
    const objs = results.map((r) => r.obj);
    const linkFlags = [...LINK_FLAGS, ...cfg.link_flags];
    const linkKey = sha1(JSON.stringify([BUILD_FORMAT, tc.version, linkFlags, results.map((r) => r.objHash)]));
    await ensureDir(outDir);
    let linkMs = 0;
    let linkReused = false;
    if (this.lastLink && this.lastLink.key === linkKey && fs.existsSync(path.join(this.lastLink.dir, 'app.wasm'))) {
      for (const f of ['app.js', 'app.wasm']) await fsp.copyFile(path.join(this.lastLink.dir, f), path.join(outDir, f));
      linkReused = true;
      emit('link: no object changed, reusing previous output\n');
    } else {
      const t0 = Date.now();
      const res = await run(tc.emxx, [...objs, '-o', path.join(outDir, 'app.js'), ...linkFlags], { env: tc.env, cwd: this.projectDir });
      linkMs = Date.now() - t0;
      if (res.output.trim()) emit(res.output.endsWith('\n') ? res.output : `${res.output}\n`);
      const linkDiags = parseDiagnostics(res.output, mapPath);
      diagnostics.push(...linkDiags);
      if (res.code !== 0) {
        if (!linkDiags.some((d) => d.severity === 'error')) {
          diagnostics.push({ severity: 'error', file: null, line: 0, column: 0, message: `link failed (exit ${res.code})`, linker: true });
        }
        return this.result({ buildId, started, success: false, log, diagnostics, compiled, coreCompiled, cached: results.filter((r) => r.cached).length, phase: 'link' });
      }
      emit(`linked in ${linkMs} ms\n`);
    }
    this.lastLink = { key: linkKey, dir: outDir };
    return this.result({
      buildId,
      started,
      success: true,
      log,
      diagnostics,
      compiled,
      coreCompiled,
      cached: results.filter((r) => r.cached).length,
      phase: 'done',
      linkMs,
      linkReused,
      sources,
    });
  }

  result({ buildId, started, success, log, diagnostics = [], errors = [], compiled = [], coreCompiled = 0, cached = 0, phase = 'compile', linkMs = 0, linkReused = false, sources = [] }) {
    const all = [...errors, ...diagnostics];
    return {
      build_id: buildId,
      success,
      phase,
      duration_ms: Date.now() - started,
      link_ms: linkMs,
      link_reused: linkReused,
      compiled,
      core_compiled: coreCompiled,
      cached,
      sources,
      errors: all.filter((d) => d.severity === 'error'),
      warnings: all.filter((d) => d.severity === 'warning'),
      log,
    };
  }
}
