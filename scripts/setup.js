#!/usr/bin/env node
// One-command setup after `npm install`: makes sure Emscripten and a Chromium-based
// browser are available (installing them if not), reports Claude Code, then builds
// the showcase and the Resonance example once so the first `npm start` is instant.
//
//   npm run setup [-- --emsdk-version 6.0.10] [-- --skip-build] [-- --bundled-python]
//   (--bundled-python: install emsdk with its own standalone Python even if one is on PATH)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STUDIO_ROOT, findToolchain, lastToolchainProblem } from '../server/config.js';
import { findBrowser } from '../server/headless.js';
import { findClaude } from '../server/agent.js';

const WIN = process.platform === 'win32';
// The Emscripten release ImGui Studio is tested with (CI builds and tests with it on
// Linux, macOS and Windows). An emsdk you already have is used as is.
const EMSDK_VERSION = argValue('--emsdk-version') || '6.0.10';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : null;
}

function step(title) {
  process.stdout.write(`\n== ${title}\n`);
}

function run(cmd, args, opts = {}) {
  process.stdout.write(`$ ${[cmd, ...args].join(' ')}\n`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

// emsdk and Emscripten need Python 3.10+. macOS's /usr/bin/python3 is 3.9 and Windows
// may have no Python, so fall back to the standalone Python that emsdk itself ships
// (the same archive `emsdk install` downloads) when none is found.
const EMSDK_DEPS_URL = 'https://storage.googleapis.com/webassembly/emscripten-releases-builds/deps/';
const BUNDLED_PYTHON = '3.13.3';

function pythonOk(exe) {
  if (path.isAbsolute(exe) && !fs.existsSync(exe)) return false;
  const r = spawnSync(exe, ['-c', 'import sys; print(sys.version_info >= (3, 10))'], { encoding: 'utf8' });
  return !r.error && r.status === 0 && r.stdout.trim() === 'True';
}

// Kept outside emsdk/python/: emsdk installs its own copy there, and on Windows it cannot
// overwrite the files of the Python that is running it.
function bootstrapPythonDir(dir) {
  return path.join(dir, 'bootstrap-python');
}

function bootstrapPython(dir) {
  return path.join(bootstrapPythonDir(dir), WIN ? 'python.exe' : path.join('bin', 'python3'));
}

function findBootstrapPython(dir) {
  if (process.argv.includes('--bundled-python')) return pythonOk(bootstrapPython(dir)) ? bootstrapPython(dir) : null;
  const candidates = [process.env.EMSDK_PYTHON, bootstrapPython(dir), 'python3.13', 'python3.12', 'python3.11', 'python3.10', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3', 'python'];
  return candidates.filter(Boolean).find(pythonOk) || null;
}

async function downloadBundledPython(dir) {
  const arm = process.arch === 'arm64';
  const file =
    process.platform === 'darwin' ? `python-${BUNDLED_PYTHON}-0-macos-${arm ? 'arm64' : 'x86_64'}.tar.gz` : WIN ? `python-${BUNDLED_PYTHON}-0-win-${arm ? 'arm64' : 'amd64'}.zip` : null;
  if (!file) return null; // Linux: emsdk has no Python build; use the distribution's
  const archive = path.join(dir, 'downloads', file);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  process.stdout.write(`downloading ${EMSDK_DEPS_URL}${file}\n`);
  const res = await fetch(EMSDK_DEPS_URL + file);
  if (!res.ok) throw new Error(`downloading ${file} failed: HTTP ${res.status}`);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  const tmp = fs.mkdtempSync(path.join(dir, 'python-extract-'));
  // Windows' own tar (bsdtar) reads zip files; Git's GNU tar, often earlier on PATH, does not.
  const tar = WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  run(tar, ['-xf', archive, '-C', tmp]);
  // The macOS archive has one top-level folder; the Windows one does not.
  const entries = fs.readdirSync(tmp);
  const root = entries.length === 1 && fs.statSync(path.join(tmp, entries[0])).isDirectory() ? path.join(tmp, entries[0]) : tmp;
  fs.rmSync(bootstrapPythonDir(dir), { recursive: true, force: true });
  fs.renameSync(root, bootstrapPythonDir(dir));
  fs.rmSync(tmp, { recursive: true, force: true });
  return bootstrapPython(dir);
}

async function installEmscripten() {
  const dir = process.env.EMSDK || path.join(os.homedir(), 'emsdk');
  if (!fs.existsSync(path.join(dir, 'emsdk.py'))) {
    run('git', ['clone', '--depth', '1', 'https://github.com/emscripten-core/emsdk.git', dir]);
  }
  let python = findBootstrapPython(dir);
  if (!python) {
    process.stdout.write('no Python 3.10 or newer found (emsdk needs it): fetching the standalone Python emsdk uses\n');
    python = await downloadBundledPython(dir);
    if (!python || !pythonOk(python)) {
      throw new Error('emsdk needs Python 3.10 or newer. Install it (e.g. `sudo apt install python3`, or from https://www.python.org/downloads/) and run setup again.');
    }
  }
  process.stdout.write(`using ${python}\n`);
  // Run emsdk.py directly (what the emsdk / emsdk.bat launchers do) with the Python found above.
  const env = { ...process.env, EMSDK_PYTHON: python };
  if (python === bootstrapPython(dir)) {
    delete env.PYTHONHOME;
    delete env.PYTHONPATH;
  }
  for (const action of ['install', 'activate']) run(python, [path.join(dir, 'emsdk.py'), action, EMSDK_VERSION], { cwd: dir, env });
}

const problems = [];

step('Node');
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) problems.push(`Node ${process.version} is too old: install Node 22 or newer (https://nodejs.org)`);
process.stdout.write(`node ${process.version}\n`);
if (!fs.existsSync(path.join(STUDIO_ROOT, 'node_modules', 'ws'))) problems.push('dependencies are missing: run `npm install` first');

step('Emscripten');
let tc = findToolchain();
if (!tc) {
  process.stdout.write(`not found: installing emsdk ${EMSDK_VERSION} into ${process.env.EMSDK || path.join(os.homedir(), 'emsdk')} (a few minutes, ~1 GB)\n`);
  try {
    await installEmscripten();
  } catch (e) {
    process.stdout.write(`${e.message}\n`);
  }
  tc = findToolchain();
}
if (tc) process.stdout.write(`${tc.version}\n  ${tc.emcc}\n`);
else {
  process.stdout.write(`${lastToolchainProblem()}\n`);
  problems.push(
    'Emscripten could not be installed (the reason is printed under "== Emscripten" above). Fix that and run `npm run setup` again,' +
      ' or install emsdk by hand (https://emscripten.org/docs/getting_started/downloads.html) and set EMSDK to its folder.',
  );
}

step('Browser for the headless agent preview');
let browser = findBrowser();
if (!browser) {
  process.stdout.write('no Chrome, Chromium or Edge found: downloading Chromium for Playwright\n');
  try {
    run(process.execPath, [path.join(STUDIO_ROOT, 'node_modules', 'playwright-core', 'cli.js'), 'install', 'chromium']);
  } catch (e) {
    process.stdout.write(`${e.message}\n`);
  }
  browser = findBrowser();
}
if (browser) process.stdout.write(`${browser}\n`);
else problems.push('No Chromium-based browser: install Google Chrome, or run `npx playwright-core install chromium`, or set IMGUI_STUDIO_BROWSER.');

step('Claude Code (for the design agent; optional)');
const claude = findClaude();
process.stdout.write(
  claude
    ? `${claude}\n`
    : `not found. To run the menu designer agent, install it:\n  ${WIN ? 'irm https://claude.ai/install.ps1 | iex   (PowerShell)' : 'curl -fsSL https://claude.ai/install.sh | bash'}\nthen run \`claude\` once to sign in.\n`,
);

if (tc && !process.argv.includes('--skip-build')) {
  step('First builds (compiles Dear ImGui once into the shared cache)');
  // No --project: the CLI creates workspace/ from the showcase template on first use.
  for (const [project, extra] of [['workspace', []], ['examples/resonance', ['--project', path.join(STUDIO_ROOT, 'examples', 'resonance')]]]) {
    const r = spawnSync(process.execPath, [path.join(STUDIO_ROOT, 'bin', 'imgui-studio.js'), 'build', ...extra], {
      cwd: STUDIO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let result = null;
    try {
      result = JSON.parse(r.stdout);
    } catch {
      // reported below
    }
    if (result?.success) process.stdout.write(`${project}: build #${result.build_id} ok (${result.duration_ms} ms)\n`);
    else problems.push(`${project} failed to build:\n${r.stdout}`);
  }
}

step('Result');
if (problems.length) {
  process.stdout.write(`${problems.map((p) => `- ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(
  'Ready.\n' +
    '  npm start              Studio with the showcase project   -> http://localhost:7420\n' +
    '  npm run resonance      Studio with the agent-built menu   -> http://localhost:7421\n' +
    '  npm test               unit + end-to-end tests\n' +
    '  node bin/imgui-studio.js agent "<brief>" --new my-menu --budget 5\n',
);
