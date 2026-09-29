#!/usr/bin/env node
// ImGui Studio command line.
//
//   imgui-studio serve  [--project DIR] [--port N] [--no-headless] [--open]  Studio UI + API (+ headless agent preview)
//   imgui-studio mcp    [--project DIR] [--port N]                   MCP server on stdio (starts or reuses the Studio server)
//   imgui-studio agent  "<brief>" [--project DIR | --new DIR] [--reference IMG] [--model ID] [--effort LEVEL]
//                       [--budget USD] [--max-turns N] [--dry-run]    run the ImGui Menu Designer (Claude Code, headless);
//                       [--no-open] [--exit]                          opens the Studio and keeps it running afterwards
//   imgui-studio agent-kit [--project DIR]                           install the Claude Code kit (skill, subagent, .mcp.json)
//   imgui-studio new    <dir> [--template showcase|minimal] [--name NAME] [--no-agent-kit]
//   imgui-studio build  [--project DIR]                              one-shot build, prints the JSON result
//   imgui-studio export [--project DIR] [--dest DIR]
//   imgui-studio doctor                                              check toolchain, browser and Claude Code
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { STUDIO_ROOT, findToolchain, lastToolchainProblem } from '../server/config.js';
import { Studio } from '../server/studio.js';
import { startStudio } from '../server/launch.js';
import { localCaller, remoteCaller, runMcpServer } from '../server/mcp.js';
import { runOp } from '../server/ops.js';
import { createProject, installAgentKit, listTemplates, subagentDefinition, AGENT_NAME } from '../server/scaffold.js';
import { findClaude, runDesignAgent } from '../server/agent.js';
import { findBrowser } from '../server/headless.js';
import { log } from '../server/util.js';

const BOOLEAN_FLAGS = new Set(['dry-run', 'no-headless', 'no-agent-kit', 'build', 'repo', 'check', 'open', 'no-open', 'keep', 'exit']);

// Open a URL in the default browser (serve --open). On Windows the empty argument is
// start's window title (Node passes it as ""), so the URL is not taken as the title.
function openInBrowser(url) {
  const [cmd, argv] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const child = spawn(cmd, argv, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => log(`could not open a browser; visit ${url}`));
  child.unref();
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (!BOOLEAN_FLAGS.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

async function resolveProject(args) {
  if (args.project) return path.resolve(String(args.project));
  if (process.env.IMGUI_STUDIO_PROJECT) return path.resolve(process.env.IMGUI_STUDIO_PROJECT);
  if (fs.existsSync(path.join(process.cwd(), 'studio.json'))) return process.cwd();
  const ws = path.join(STUDIO_ROOT, 'workspace');
  if (!fs.existsSync(path.join(ws, 'studio.json'))) {
    log(`creating default project in ${ws} from the "showcase" template`);
    await createProject(ws, { template: 'showcase' });
  }
  return ws;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'serve';

  if (cmd === 'new') {
    const dest = args._[1];
    if (!dest) throw new Error(`usage: imgui-studio new <dir> [--template ${listTemplates().join('|')}] [--name NAME] [--no-agent-kit]`);
    await createProject(path.resolve(dest), { template: String(args.template || 'showcase'), name: args.name ? String(args.name) : null, agentKit: !args['no-agent-kit'] });
    process.stderr.write(`Created ${path.resolve(dest)}\nNext: imgui-studio serve --project ${dest}\n   or: imgui-studio agent "Design a settings menu for ..." --project ${dest}\n`);
    return;
  }

  if (cmd === 'agent-kit') {
    if (args.repo) {
      // Regenerate the repository's own subagent definition from agent/designer.md.
      const file = path.join(STUDIO_ROOT, '.claude', 'agents', `${AGENT_NAME}.md`);
      const want = subagentDefinition();
      if (args.check) {
        const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (have !== want) throw new Error(`${file} is out of date; run: imgui-studio agent-kit --repo`);
        process.stderr.write('agent kit is up to date\n');
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, want);
      process.stderr.write(`wrote ${file}\n`);
      return;
    }
    const projectDir = await resolveProject(args);
    const r = await installAgentKit(projectDir);
    process.stderr.write(`Installed the Claude Code kit in ${r.project}:\n${r.written.map((w) => `  ${w}`).join('\n')}\n` + 'Run `claude` there: CLAUDE.md imports the design skill in full, and the imgui-studio MCP server is configured.\n');
    return;
  }

  if (cmd === 'doctor') {
    const tc = findToolchain();
    const report = { node: process.version, emscripten: tc ? tc.version : `NOT FOUND: ${lastToolchainProblem()} - run npm run setup, or set EMSDK`, emcc: tc?.emcc };
    try {
      await import('playwright-core');
      report.playwright_core = 'installed';
    } catch {
      report.playwright_core = 'missing (npm install playwright-core) - headless agent preview disabled';
    }
    report.browser = findBrowser() || 'no Chrome/Chromium/Edge found - run `npx playwright-core install chromium` or set IMGUI_STUDIO_BROWSER';
    report.claude_code = findClaude() || 'not found (needed for `imgui-studio agent`)';
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  if (cmd === 'agent') {
    const brief = args._.slice(1).join(' ').trim() || (args.brief ? String(args.brief) : '');
    if (!brief) throw new Error('usage: imgui-studio agent "<what to design>" [--project DIR | --new DIR] [--reference image.png] [--dry-run]');
    let projectDir;
    if (args.new) {
      projectDir = path.resolve(String(args.new));
      await createProject(projectDir, { template: String(args.template || 'minimal'), name: args.name ? String(args.name) : null });
      log(`created ${projectDir} from the "${args.template || 'minimal'}" template`);
    } else {
      projectDir = await resolveProject(args);
    }
    const r = await startStudio(projectDir, { port: args.port, headless: !args['no-headless'] });
    const studioUrl = r.reuse || `http://localhost:${r.port}`;
    // In a terminal, show the Studio while the agent works and keep it up afterwards,
    // so the result can be inspected; scripts and CI get a plain run-and-exit.
    const interactive = !!process.stdout.isTTY && !process.env.CI;
    if (interactive && !args['dry-run'] && !args['no-open']) openInBrowser(studioUrl);
    let outcome;
    try {
      outcome = await runDesignAgent({
        projectDir,
        brief,
        reference: args.reference ? String(args.reference) : null,
        port: r.port,
        studioUrl,
        model: args.model ? String(args.model) : undefined,
        effort: args.effort ? String(args.effort) : 'high',
        maxTurns: args['max-turns'] ? Number(args['max-turns']) : null,
        budgetUsd: args.budget ? Number(args.budget) : null,
        dryRun: !!args['dry-run'],
        studio: r.studio || null,
      });
    } catch (e) {
      if (r.studio) await r.studio.shutdown();
      throw e;
    }
    if (outcome.dryRun) {
      process.stdout.write(`${JSON.stringify({ ...outcome, command: `${outcome.claude} ${outcome.args.map((a) => (/[\s*]/.test(a) ? JSON.stringify(a) : a)).join(' ')} < task` }, null, 2)}\n`);
    } else {
      process.stderr.write(`\ntranscript: ${outcome.transcript}\n`);
      process.exitCode = outcome.success ? 0 : 1;
    }
    if (r.studio && !outcome.dryRun && (args.keep || (interactive && !args.exit))) {
      process.stderr.write(`\nImGui Studio is still running with the result: ${studioUrl}  (Ctrl+C to stop)\n`);
      const stop = async () => {
        await r.studio.shutdown();
        process.exit(process.exitCode || 0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    if (r.studio) {
      await r.studio.shutdown();
      r.srv.server.close();
    }
    if (r.reuse && !outcome.dryRun) process.stderr.write(`\nSee the result in the Studio: ${studioUrl}\n`);
    process.exit(process.exitCode || 0);
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
    const r = await startStudio(projectDir, { port: args.port, host: args.host || '127.0.0.1', headless: !args['no-headless'] });
    if (r.reuse) {
      process.stderr.write(`ImGui Studio is already running for this project: ${r.reuse}\n`);
      if (args.open) openInBrowser(r.reuse);
      return;
    }
    const { studio, port } = r;
    process.stderr.write(`\n  ImGui Studio  ->  http://localhost:${port}\n  project: ${projectDir}\n\n`);
    if (args.open) openInBrowser(`http://localhost:${port}`);
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
    const r = await startStudio(projectDir, { port: args.port, headless: !args['no-headless'] });
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

  throw new Error(`Unknown command "${cmd}". Commands: serve, mcp, agent, agent-kit, new, build, export, check, doctor`);
}

main().catch((e) => {
  process.stderr.write(`imgui-studio: ${e.message}\n`);
  process.exit(1);
});
