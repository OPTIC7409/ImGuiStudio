#!/usr/bin/env node
// One-command setup after `npm install`: makes sure Emscripten and a Chromium-based
// browser are available (installing them if not), reports Claude Code, then builds
// the showcase and the Resonance example once so the first `npm start` is instant.
//
//   npm run setup [-- --emsdk-version 6.0.10] [-- --skip-build]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STUDIO_ROOT, findToolchain } from '../server/config.js';
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

function installEmscripten() {
  const dir = process.env.EMSDK || path.join(os.homedir(), 'emsdk');
  if (!fs.existsSync(path.join(dir, WIN ? 'emsdk.bat' : 'emsdk'))) {
    run('git', ['clone', '--depth', '1', 'https://github.com/emscripten-core/emsdk.git', dir]);
  }
  // emsdk.bat is a batch file: it has to go through cmd.exe (plain arguments only).
  const emsdk = WIN ? ['emsdk.bat', { shell: true }] : ['./emsdk', {}];
  run(emsdk[0], ['install', EMSDK_VERSION], { cwd: dir, ...emsdk[1] });
  run(emsdk[0], ['activate', EMSDK_VERSION], { cwd: dir, ...emsdk[1] });
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
    installEmscripten();
  } catch (e) {
    process.stdout.write(`${e.message}\n`);
  }
  tc = findToolchain();
}
if (tc) process.stdout.write(`${tc.version}\n  ${tc.emcc}\n`);
else {
  problems.push(
    'Emscripten could not be installed automatically. Install emsdk by hand (https://emscripten.org/docs/getting_started/downloads.html)' +
      `${WIN ? '; on Windows emsdk needs Python 3 and Git on PATH' : ''}, then set EMSDK to its folder.`,
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
