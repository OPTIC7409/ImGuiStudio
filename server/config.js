// Configuration: studio paths, toolchain discovery and project settings (studio.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StudioError, readJsonSync } from './util.js';

export const STUDIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIME_DIR = path.join(STUDIO_ROOT, 'runtime');
export const BUILTIN_IMGUI_DIR = path.join(STUDIO_ROOT, 'third_party', 'imgui');
export const TEMPLATES_DIR = path.join(STUDIO_ROOT, 'templates');
export const WEB_DIR = path.join(STUDIO_ROOT, 'web');
export const GLOBAL_CACHE_DIR = process.env.IMGUI_STUDIO_CACHE || path.join(STUDIO_ROOT, '.cache');
export const DEFAULT_PORT = Number(process.env.IMGUI_STUDIO_PORT || 7420);

export const DEFAULT_PROJECT_CONFIG = {
  name: 'ImGui Project',
  // Source files compiled into the preview. Globs are relative to the project root.
  sources: ['**/*.cpp'],
  exclude: ['imgui/**', 'native/**', '**/*.native.cpp'],
  include_dirs: ['.', 'src', 'widgets', 'theme'],
  defines: [],
  cxx_std: 'c++17',
  cxx_flags: [],
  link_flags: [],
  optimize: '-O0',
  // "builtin" = Dear ImGui vendored with ImGui Studio; otherwise a project-relative directory.
  imgui: 'builtin',
  imconfig: null,
  // Directories mounted into the preview's virtual filesystem (read at runtime by your code).
  assets: ['assets'],
  viewport: { width: 1280, height: 800 },
  background: '#0e0f13',
};

export function loadProjectConfig(projectDir) {
  const file = path.join(projectDir, 'studio.json');
  if (!fs.existsSync(file)) {
    throw new StudioError('no_project', `No studio.json found in ${projectDir}. Create one with "imgui-studio new <dir>".`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new StudioError('bad_config', `studio.json is not valid JSON: ${e.message}`);
  }
  const cfg = { ...DEFAULT_PROJECT_CONFIG, ...raw };
  cfg.viewport = { ...DEFAULT_PROJECT_CONFIG.viewport, ...(raw.viewport || {}) };
  cfg.viewport.width = Math.max(64, Math.min(4096, Number(cfg.viewport.width) || 1280));
  cfg.viewport.height = Math.max(64, Math.min(4096, Number(cfg.viewport.height) || 800));
  for (const k of ['sources', 'exclude', 'include_dirs', 'defines', 'cxx_flags', 'link_flags', 'assets']) {
    if (!Array.isArray(cfg[k])) cfg[k] = cfg[k] ? [String(cfg[k])] : [];
  }
  return cfg;
}

export function imguiDirFor(projectDir, cfg) {
  if (!cfg.imgui || cfg.imgui === 'builtin') return BUILTIN_IMGUI_DIR;
  const dir = path.resolve(projectDir, cfg.imgui);
  if (!fs.existsSync(path.join(dir, 'imgui.h'))) {
    throw new StudioError('bad_config', `studio.json "imgui" points to ${cfg.imgui}, which has no imgui.h`);
  }
  return dir;
}

let toolchainCache = null;
const WIN = process.platform === 'win32';

// emcc / em++ are launchers for emcc.py / em++.py. The Studio runs the Python entry
// points directly (as the launchers do): on Windows the launchers are .bat files,
// which Node can only start through cmd.exe, with its quoting rules and 8 KB limit.
function findPython(emsdk, env) {
  if (env.EMSDK_PYTHON && fs.existsSync(env.EMSDK_PYTHON)) return env.EMSDK_PYTHON;
  const base = emsdk && path.join(emsdk, 'python');
  if (base && fs.existsSync(base)) {
    for (const v of fs.readdirSync(base).sort().reverse()) {
      const exe = path.join(base, v, WIN ? 'python.exe' : path.join('bin', 'python3'));
      if (fs.existsSync(exe)) return exe;
    }
  }
  return WIN ? 'python' : 'python3';
}

// [command, args] that runs an Emscripten tool ('emcc' or 'em++').
function toolCommand(emDir, python, tool, args) {
  const script = path.join(emDir, `${tool}.py`);
  if (fs.existsSync(script)) return [python, ['-E', script, ...args]];
  return [path.join(emDir, WIN ? `${tool}.bat` : tool), args];
}

// Locate Emscripten. Honours EMSDK / EMCC env vars, PATH, and common install locations.
export function findToolchain() {
  if (toolchainCache) return toolchainCache;
  const candidates = [];
  if (process.env.EMCC) candidates.push({ emcc: process.env.EMCC });
  const emsdkDirs = [process.env.EMSDK, path.join(os.homedir(), 'emsdk'), '/opt/emsdk', '/usr/local/emsdk', 'C:\\emsdk'].filter(Boolean);
  for (const dir of emsdkDirs) {
    candidates.push({ emcc: path.join(dir, 'upstream', 'emscripten', WIN ? 'emcc.bat' : 'emcc'), emsdk: dir });
  }
  try {
    const which = execFileSync(WIN ? 'where' : 'which', ['emcc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)[0]
      .trim();
    if (which) candidates.unshift({ emcc: which });
  } catch {
    // not on PATH
  }
  for (const c of candidates) {
    if (!c.emcc || !fs.existsSync(c.emcc)) continue;
    const emDir = path.dirname(c.emcc);
    const env = { ...process.env };
    delete env._PYTHON_SYSCONFIGDATA_NAME;
    const emsdk = c.emsdk || (path.basename(path.dirname(emDir)) === 'upstream' ? path.dirname(path.dirname(emDir)) : null);
    if (emsdk) {
      env.EMSDK = emsdk;
      const cfgFile = path.join(emsdk, '.emscripten');
      if (!env.EM_CONFIG && fs.existsSync(cfgFile)) env.EM_CONFIG = cfgFile;
      // emsdk-provided node/python on PATH, like emsdk_env does.
      const extra = [emDir];
      for (const sub of ['node', 'python']) {
        const base = path.join(emsdk, sub);
        if (!fs.existsSync(base)) continue;
        for (const v of fs.readdirSync(base)) {
          for (const bin of [path.join(base, v, 'bin'), path.join(base, v)]) {
            if (fs.existsSync(bin) && !extra.includes(bin)) extra.push(bin);
          }
        }
      }
      env.PATH = [...extra, env.PATH].join(path.delimiter);
    }
    const python = findPython(emsdk, env);
    const command = (tool, args) => toolCommand(emDir, python, tool, args);
    let version;
    try {
      const [cmd, args] = command('emcc', ['--version']);
      version = execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split(/\r?\n/)[0].trim();
    } catch {
      continue;
    }
    toolchainCache = { emcc: c.emcc, env, version, emsdk, python, command };
    return toolchainCache;
  }
  return null;
}

export function requireToolchain() {
  const tc = findToolchain();
  if (!tc) {
    throw new StudioError(
      'no_toolchain',
      'Emscripten (emcc) was not found. Install emsdk (https://emscripten.org/docs/getting_started/downloads.html) and either activate it, or set EMSDK=/path/to/emsdk.',
    );
  }
  return tc;
}

export function studioSettings(projectDir) {
  return readJsonSync(path.join(projectDir, '.studio', 'settings.json'), {});
}
