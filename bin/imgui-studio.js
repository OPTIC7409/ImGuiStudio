#!/usr/bin/env node
// ImGui Studio command line.
//
//   imgui-studio serve  [--project DIR] [--port N] [--no-headless]   Studio UI + API (+ headless agent preview)
//   imgui-studio mcp    [--project DIR] [--port N]                   MCP server on stdio (starts or reuses the Studio server)
//   imgui-studio new    <dir> [--template showcase|minimal] [--name NAME]
//   imgui-studio build  [--project DIR]                              one-shot build, prints the JSON result
//   imgui-studio export [--project DIR] [--dest DIR]
//   imgui-studio doctor                                              check toolchain and browser
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PORT, STUDIO_ROOT, TEMPLATES_DIR, findToolchain } from '../server/config.js';
import { Studio } from '../server/studio.js';
import { startHttpServer } from '../server/http.js';
import { localCaller, remoteCaller, runMcpServer } from '../server/mcp.js';
import { runOp } from '../server/ops.js';
import { log } from '../server/util.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

async function copyTemplate(template, dest, name) {
  const src = path.join(TEMPLATES_DIR, template);
  if (!fs.existsSync(src)) throw new Error(`Unknown template "${template}" (available: ${fs.readdirSync(TEMPLATES_DIR).join(', ')})`);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} already exists and is not empty`);
  await fsp.cp(src, dest, { recursive: true });
  if (name) {
    const f = path.join(dest, 'studio.json');
    const cfg = JSON.parse(await fsp.readFile(f, 'utf8'));
    cfg.name = name;
    await fsp.writeFile(f, `${JSON.stringify(cfg, null, 2)}\n`);
  }
}

async function resolveProject(args) {
  if (args.project) return path.resolve(String(args.project));
  if (process.env.IMGUI_STUDIO_PROJECT) return path.resolve(process.env.IMGUI_STUDIO_PROJECT);
  if (fs.existsSync(path.join(process.cwd(), 'studio.json'))) return process.cwd();
  const ws = path.join(STUDIO_ROOT, 'workspace');
  if (!fs.existsSync(path.join(ws, 'studio.json'))) {
    log(`creating default project in ${ws} from the "showcase" template`);
    await copyTemplate('showcase', ws, null);
  }
  return ws;
}

async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return body && body.app === 'imgui-studio' ? body : { foreign: true };
  } catch {
    return null;
  }
}

async function startStudio(projectDir, args) {
  let port = Number(args.port || DEFAULT_PORT);
  for (let attempt = 0; attempt < 20; attempt++, port++) {
    const existing = await probe(port);
    if (existing && !existing.foreign && path.resolve(existing.project) === projectDir) return { reuse: `http://127.0.0.1:${port}` };
    if (existing) continue;
    const studio = new Studio({ projectDir, port });
    await studio.init();
    if (args['no-headless']) studio.settings.headless = false;
    try {
      const srv = await startHttpServer(studio, { port, host: args.host || '127.0.0.1' });
      return { studio, srv, port };
    } catch (e) {
      if (e.code === 'EADDRINUSE') continue;
      throw e;
    }
  }
  throw new Error('No free port found');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'serve';

  if (cmd === 'new') {
    const dest = args._[1];
    if (!dest) throw new Error('usage: imgui-studio new <dir> [--template showcase|minimal] [--name NAME]');
    await copyTemplate(String(args.template || 'showcase'), path.resolve(dest), args.name ? String(args.name) : null);
    process.stderr.write(`Created ${path.resolve(dest)}\nNext: imgui-studio serve --project ${dest}\n`);
    return;
  }

  if (cmd === 'doctor') {
    const tc = findToolchain();
    const report = { node: process.version, emscripten: tc ? tc.version : 'NOT FOUND (install emsdk and activate it, or set EMSDK)', emcc: tc?.emcc };
    try {
      await import('playwright-core');
      report.playwright_core = 'installed';
    } catch {
      report.playwright_core = 'missing (npm install playwright-core) - headless agent preview disabled';
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const projectDir = await resolveProject(args);

  if (cmd === 'build' || cmd === 'export' || cmd === 'check') {
    const studio = new Studio({ projectDir, port: 0 });
    await studio.init();
    studio.settings.headless = false;
    studio.on('build_output', ({ text }) => process.stderr.write(text));
    const op = cmd === 'build' ? 'build_start' : cmd === 'export' ? 'export_source' : 'export_check';
    const opArgs = cmd === 'export' ? { dest: args.dest } : cmd === 'build' ? { capture: false } : {};
    try {
      const r = await runOp(studio, op, opArgs, { source: 'cli' });
      delete r.images;
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      process.exitCode = r.success === false || r.ok === false ? 1 : 0;
    } finally {
      await studio.shutdown();
    }
    return;
  }

  if (cmd === 'serve') {
    const r = await startStudio(projectDir, args);
    if (r.reuse) {
      process.stderr.write(`ImGui Studio is already running for this project: ${r.reuse}\n`);
      return;
    }
    const { studio, port } = r;
    process.stderr.write(`\n  ImGui Studio  ->  http://localhost:${port}\n  project: ${projectDir}\n\n`);
    if (studio.latestBuildId() == null || args.build) {
      studio.build({ source: 'startup', capture: true }).catch((e) => log('initial build failed:', e.message));
    } else if (studio.settings.headless !== false) {
      studio.loadAgentPreview().catch(() => {});
    }
    const stop = async () => {
      await studio.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  if (cmd === 'mcp') {
    const r = await startStudio(projectDir, args);
    let call;
    let studio = null;
    if (r.reuse) {
      log(`MCP: using running Studio at ${r.reuse}`);
      call = remoteCaller(r.reuse);
    } else {
      studio = r.studio;
      log(`MCP: Studio UI available at http://localhost:${r.port} (project ${projectDir})`);
      call = localCaller(studio);
    }
    await runMcpServer({ call });
    if (studio) await studio.shutdown();
    process.exit(0);
  }

  throw new Error(`Unknown command "${cmd}". Commands: serve, mcp, new, build, export, check, doctor`);
}

main().catch((e) => {
  process.stderr.write(`imgui-studio: ${e.message}\n`);
  process.exit(1);
});
