// ImGui Menu Designer: runs Claude Code headless against an ImGui Studio project.
//
// The design skill is guaranteed to be in context for the whole run: it is
// appended to Claude Code's system prompt (--append-system-prompt-file), or,
// for projects with the agent kit installed, imported in full by CLAUDE.md.
// Claude only gets the ImGui Studio MCP tools plus file tools scoped to the
// project, so every build, screenshot and interaction goes through the Studio.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { STUDIO_ROOT } from './config.js';
import { DESIGNER_FILE, SKILL_FILE, SKILL_NAME, projectImportsSkill } from './scaffold.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const FILE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
export const MCP_ALLOW = 'mcp__imgui-studio__*';

export function findClaude() {
  const explicit = process.env.IMGUI_STUDIO_CLAUDE;
  if (explicit) return explicit;
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (process.platform !== 'win32') return found[0] || null;
    // `where` also lists npm's extensionless shell shim, which Windows cannot run.
    return found.find((f) => /\.exe$/i.test(f)) || found.find((f) => /\.cmd$/i.test(f)) || null;
  } catch {
    return null;
  }
}

// [command, leading args] to start Claude Code. Node cannot spawn npm's .cmd shim on
// Windows without a shell, so run the package's JavaScript entry point directly.
export function claudeCommand(claude) {
  if (!/\.cmd$/i.test(claude)) return [claude, []];
  const pkgDir = path.join(path.dirname(claude), 'node_modules', '@anthropic-ai', 'claude-code');
  try {
    const bin = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).bin;
    const entry = path.join(pkgDir, typeof bin === 'string' ? bin : bin.claude);
    if (/\.[cm]?js$/.test(entry) && fs.existsSync(entry)) return [process.execPath, [entry]];
    if (fs.existsSync(entry)) return [entry, []];
  } catch {
    // fall through
  }
  throw new Error(`Cannot start ${claude} without a shell. Install the native Claude Code build (https://code.claude.com) or set IMGUI_STUDIO_CLAUDE to claude.exe.`);
}

export function buildSystemPrompt(projectDir) {
  const viaClaudeMd = projectImportsSkill(projectDir);
  const parts = [];
  if (!viaClaudeMd) {
    parts.push(fs.readFileSync(DESIGNER_FILE, 'utf8'));
    parts.push(`\n\n# Design skill: ${SKILL_NAME} (always loaded)\n\n${fs.readFileSync(SKILL_FILE, 'utf8')}`);
  }
  parts.push(
    '\n\n# This run\n\nYou are running unattended (headless). Nobody will answer questions: make reasonable design decisions yourself, state them in your final message, and keep going until the finish criteria are met.',
  );
  return { text: parts.join(''), skillSource: viaClaudeMd ? 'CLAUDE.md import' : 'appended system prompt' };
}

export function buildTask({ brief, reference, studioUrl }) {
  const lines = [brief.trim()];
  if (reference) {
    lines.push('', `Reference design: ${reference}`, 'Load it with reference_load, study it (skill section 27), then match its design system. Track progress with reference_compare.');
  }
  if (studioUrl) lines.push('', `(The user can watch your builds live in ImGui Studio at ${studioUrl}.)`);
  return lines.join('\n');
}

export function buildClaudeArgs({ systemPromptFile, mcpConfigFile, model = DEFAULT_MODEL, effort = 'high', maxTurns = null, budgetUsd = null }) {
  const args = [
    '-p',
    '--append-system-prompt-file', systemPromptFile,
    '--mcp-config', mcpConfigFile,
    '--strict-mcp-config',
    '--tools', FILE_TOOLS.join(','),
    '--allowedTools', [MCP_ALLOW, ...FILE_TOOLS].join(','),
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
  ];
  if (effort) args.push('--effort', effort);
  if (maxTurns) args.push('--max-turns', String(maxTurns));
  if (budgetUsd) args.push('--max-budget-usd', String(budgetUsd));
  return args;
}

// ---------------------------------------------------------------------------
// Progress rendering for Claude Code's stream-json output
// ---------------------------------------------------------------------------

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

function shortArgs(name, input = {}) {
  if (input.path) return input.path;
  if (input.file_path) return path.basename(input.file_path);
  if (input.id) return input.id;
  if (input.note) return `"${input.note}"`;
  if (input.pattern) return input.pattern;
  const s = JSON.stringify(input);
  return s === '{}' ? '' : s.slice(0, 80);
}

function summarizeToolResult(block) {
  const texts = (Array.isArray(block.content) ? block.content : [{ type: 'text', text: String(block.content ?? '') }]).filter((c) => c.type === 'text').map((c) => c.text);
  const images = Array.isArray(block.content) ? block.content.filter((c) => c.type === 'image').length : 0;
  let summary = texts.join(' ').replace(/\s+/g, ' ').slice(0, 140);
  try {
    const j = JSON.parse(texts[0]);
    if (j.error) summary = `${j.error.code}: ${j.error.message}`;
    else if (j.build_id != null) summary = j.success ? `build #${j.build_id} ok (${j.duration_ms} ms)${j.preview && j.preview !== 'loaded' ? `, preview ${j.preview}` : ''}` : `build #${j.build_id} failed: ${j.errors?.[0]?.file}:${j.errors?.[0]?.line} ${j.errors?.[0]?.message ?? ''}`;
    else if (j.similarity != null) summary = `similarity ${j.similarity}`;
    else if (j.capture_id) summary = `capture ${j.capture_id}`;
    else if (Array.isArray(j.widgets)) summary = `${j.widgets.length} widgets`;
    else if (j.after?.state) summary = `after: ${JSON.stringify(j.after.state).slice(0, 110)}`;
    else if (j.diff !== undefined && j.path) summary = `${j.path} updated`;
  } catch {
    // plain text result
  }
  return `${summary}${images ? ` [${images} image${images > 1 ? 's' : ''}]` : ''}`;
}

export function createRenderer({ write = (s) => process.stdout.write(s), onAssistantText = null } = {}) {
  const pendingTools = new Map();
  let result = null;
  return {
    handle(msg) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        const mcp = (msg.mcp_servers || []).map((s) => `${s.name}:${s.status}`).join(', ');
        const tools = (msg.tools || []).filter((t) => t.startsWith('mcp__imgui-studio__')).length;
        write(dim(`  session ${msg.session_id} · model ${msg.model} · mcp ${mcp || 'none'} · ${tools} studio tools\n`));
      } else if (msg.type === 'assistant') {
        for (const block of msg.message?.content || []) {
          if (block.type === 'text' && block.text.trim()) {
            write(`\n${block.text.trim()}\n`);
            onAssistantText?.(block.text.trim());
          } else if (block.type === 'tool_use') {
            const name = String(block.name).replace(/^mcp__imgui-studio__/, '');
            pendingTools.set(block.id, name);
            write(cyan(`▸ ${name}`) + dim(` ${shortArgs(name, block.input)}\n`));
          }
        }
      } else if (msg.type === 'user') {
        for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
          if (block.type !== 'tool_result') continue;
          const name = pendingTools.get(block.tool_use_id) || 'tool';
          const line = `  ${block.is_error ? red('✗') : green('✓')} ${dim(`${name}: ${summarizeToolResult(block)}`)}\n`;
          write(line);
        }
      } else if (msg.type === 'result') {
        result = msg;
        const secs = Math.round((msg.duration_ms || 0) / 1000);
        const cost = msg.total_cost_usd != null ? ` · $${Number(msg.total_cost_usd).toFixed(2)}` : '';
        const status = msg.subtype === 'success' && !msg.is_error ? green('✓ done') : red(`✗ ${msg.subtype}`);
        write(`\n${status} ${dim(`${msg.num_turns ?? '?'} turns · ${Math.floor(secs / 60)}m${secs % 60}s${cost}`)}\n`);
      }
    },
    get result() {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// Show the designer's narration in the Studio's Agent tab.
function narrate(studio, studioUrl, text) {
  if (studio) {
    studio.logOp({ id: `${Date.now()}-agent`, time: new Date().toISOString(), source: 'agent', op: 'agent_say', args: {}, ok: true, duration_ms: 0, summary: text.slice(0, 600) });
    return;
  }
  if (!studioUrl) return;
  const base = studioUrl.replace('localhost', '127.0.0.1');
  fetch(`${base}/api/op/agent_say`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-client': 'agent' }, body: JSON.stringify({ text }) }).catch(() => {});
}

export async function runDesignAgent({ projectDir, brief, reference = null, port, studioUrl, model, effort, maxTurns, budgetUsd, dryRun = false, studio = null, log = (s) => process.stderr.write(s) }) {
  const runDir = path.join(projectDir, '.studio', 'agent');
  await fsp.mkdir(runDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const { text: systemPrompt, skillSource } = buildSystemPrompt(projectDir);
  const systemPromptFile = path.join(runDir, 'system-prompt.md');
  await fsp.writeFile(systemPromptFile, systemPrompt);

  // The MCP server proxies to the Studio this process started (or found), so
  // the Studio UI shows the agent's builds and tool calls live.
  const mcpConfigFile = path.join(runDir, 'mcp.json');
  const mcpConfig = { mcpServers: { 'imgui-studio': { type: 'stdio', command: process.execPath, args: [path.join(STUDIO_ROOT, 'bin', 'imgui-studio.js'), 'mcp', '--project', projectDir, '--port', String(port)] } } };
  await fsp.writeFile(mcpConfigFile, `${JSON.stringify(mcpConfig, null, 2)}\n`);

  const refAbs = reference ? path.resolve(reference) : null;
  if (refAbs && !fs.existsSync(refAbs)) throw new Error(`Reference image not found: ${reference}`);
  const task = buildTask({ brief, reference: refAbs, studioUrl });
  const args = buildClaudeArgs({ systemPromptFile, mcpConfigFile, model: model || DEFAULT_MODEL, effort, maxTurns, budgetUsd });
  const claude = findClaude();

  log(`${bold('◆ ImGui Menu Designer')} ${dim(`(Claude Code, ${model || DEFAULT_MODEL}${effort ? `, effort ${effort}` : ''})`)}\n`);
  log(dim(`  project  ${projectDir}\n  studio   ${studioUrl}\n  skill    ${SKILL_NAME} via ${skillSource} (${Math.round(fs.statSync(SKILL_FILE).size / 1024)} KB)\n`));

  const plan = { claude: claude || 'claude (not found on PATH)', args, cwd: projectDir, task, systemPromptFile, mcpConfigFile, skillSource };
  if (dryRun) return { dryRun: true, ...plan };
  if (!claude) throw new Error('Claude Code CLI ("claude") was not found on PATH. Install it (https://code.claude.com) or set IMGUI_STUDIO_CLAUDE.');

  const transcript = fs.createWriteStream(path.join(runDir, `run-${stamp}.jsonl`));
  const renderer = createRenderer({
    write: (s) => process.stdout.write(s),
    onAssistantText: (t) => narrate(studio, studioUrl, t),
  });

  const [cmd, lead] = claudeCommand(claude);
  const child = spawn(cmd, [...lead, ...args], { cwd: projectDir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(task);
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      transcript.write(`${line}\n`);
      try {
        renderer.handle(JSON.parse(line));
      } catch {
        process.stdout.write(`${line}\n`);
      }
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
    process.stderr.write(dim(String(d)));
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  transcript.end();
  const result = renderer.result;
  return {
    ...plan,
    exitCode: code,
    success: code === 0 && result?.subtype === 'success' && !result?.is_error,
    result: result?.result ?? null,
    costUsd: result?.total_cost_usd ?? null,
    turns: result?.num_turns ?? null,
    transcript: path.join(runDir, `run-${stamp}.jsonl`),
    stderr: code === 0 ? undefined : stderr.slice(-2000),
  };
}
