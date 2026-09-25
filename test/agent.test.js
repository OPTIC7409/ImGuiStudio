// The ImGui Menu Designer agent: the design skill must always be in context, and
// Claude Code must only get the ImGui Studio tools plus project-scoped file tools.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STUDIO_ROOT } from '../server/config.js';
import { buildClaudeArgs, buildSystemPrompt, buildTask, claudeCommand, createRenderer, MCP_ALLOW } from '../server/agent.js';
import { AGENT_NAME, SKILL_FILE, SKILL_IMPORT, SKILL_NAME, createProject, installAgentKit, subagentDefinition } from '../server/scaffold.js';
import { exportProject } from '../server/exporter.js';

const SKILL = fs.readFileSync(SKILL_FILE, 'utf8');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `imgui-studio-${name}-`));

describe('design agent', () => {
  it('appends the full skill to the system prompt for projects without the kit', () => {
    const dir = tmp('plain');
    fs.cpSync(path.join(STUDIO_ROOT, 'templates', 'minimal'), dir, { recursive: true });
    const { text, skillSource } = buildSystemPrompt(dir);
    assert.equal(skillSource, 'appended system prompt');
    assert.ok(text.includes(SKILL), 'skill text must be included verbatim');
    assert.match(text, /# ImGui Menu Designer/);
    assert.match(text, /headless/);
  });

  it('relies on the CLAUDE.md import (no duplicate) for projects with the kit', async () => {
    const dir = tmp('kit');
    fs.rmSync(dir, { recursive: true });
    await createProject(dir, { template: 'minimal' });
    const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.includes(SKILL_IMPORT));
    assert.equal(fs.readFileSync(path.join(dir, '.claude', 'skills', SKILL_NAME, 'SKILL.md'), 'utf8'), SKILL);
    const { text, skillSource } = buildSystemPrompt(dir);
    assert.equal(skillSource, 'CLAUDE.md import');
    assert.ok(!text.includes('## 29. Before considering a menu finished'));
    assert.ok(fs.existsSync(path.join(dir, 'assets', 'fonts', 'Inter-Medium.ttf')), 'projects get Inter fonts');
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers['imgui-studio'].args.slice(-3), ['mcp', '--project', dir]);
  });

  it('keeps an existing CLAUDE.md and installs the kit idempotently', async () => {
    const dir = tmp('existing');
    fs.cpSync(path.join(STUDIO_ROOT, 'templates', 'minimal'), dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# My notes\n');
    await installAgentKit(dir);
    await installAgentKit(dir);
    const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(md.startsWith('# My notes'));
    assert.equal(md.split(SKILL_IMPORT).length - 1, 1);
  });

  it('runs Claude Code headless with only Studio + file tools', () => {
    const args = buildClaudeArgs({ systemPromptFile: '/p/sys.md', mcpConfigFile: '/p/mcp.json', budgetUsd: 3 });
    const flag = (f) => args[args.indexOf(f) + 1];
    assert.equal(args[0], '-p');
    assert.equal(flag('--append-system-prompt-file'), '/p/sys.md');
    assert.equal(flag('--mcp-config'), '/p/mcp.json');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(flag('--tools'), 'Read,Edit,Write,Glob,Grep');
    assert.ok(!flag('--tools').includes('Bash'));
    assert.ok(flag('--allowedTools').split(',').includes(MCP_ALLOW));
    assert.equal(flag('--permission-mode'), 'acceptEdits');
    assert.equal(flag('--permission-prompts'), 'none');
    assert.equal(flag('--output-format'), 'stream-json');
    assert.equal(flag('--model'), 'claude-opus-5-5');
    assert.equal(flag('--max-budget-usd'), '3');
  });

  it("starts npm's Windows .cmd shim through its JavaScript entry point", () => {
    const dir = tmp('npm-prefix');
    const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { claude: 'cli.js' } }));
    fs.writeFileSync(path.join(pkg, 'cli.js'), '');
    assert.deepEqual(claudeCommand(path.join(dir, 'claude.cmd')), [process.execPath, [path.join(pkg, 'cli.js')]]);
    assert.deepEqual(claudeCommand('/usr/local/bin/claude'), ['/usr/local/bin/claude', []]);
  });

  it('adds reference instructions to the task', () => {
    const t = buildTask({ brief: 'Recreate this menu', reference: '/abs/ref.png', studioUrl: 'http://localhost:7420' });
    assert.match(t, /Reference design: \/abs\/ref\.png/);
    assert.match(t, /reference_load/);
  });

  it('defines a subagent that preloads the skill, and the repo copy is in sync', () => {
    const def = subagentDefinition();
    assert.match(def, /^---\nname: imgui-menu-designer\n/);
    assert.match(def, /\nskills:\n {2}- imgui-premium-menu-design\n/);
    assert.match(def, /tools: .*mcp__imgui-studio__\*/);
    const repoCopy = fs.readFileSync(path.join(STUDIO_ROOT, '.claude', 'agents', `${AGENT_NAME}.md`), 'utf8');
    assert.equal(repoCopy, def, 'run `node bin/imgui-studio.js agent-kit --repo` after editing agent/designer.md');
  });

  it('wires Cursor: the Studio MCP server, an always-applied rule with the skill, run tasks', () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(STUDIO_ROOT, '.cursor', 'mcp.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers['imgui-studio'].args, ['${workspaceFolder}/bin/imgui-studio.js', 'mcp']);
    const rule = fs.readFileSync(path.join(STUDIO_ROOT, '.cursor', 'rules', 'imgui-menu-designer.mdc'), 'utf8');
    assert.match(rule, /^---\n(?:.*\n)*?alwaysApply: true\n(?:.*\n)*?---\n/);
    const refs = [...rule.matchAll(/@([\w./-]+\.md)\b/g)].map((m) => m[1]);
    assert.ok(refs.includes('.claude/skills/imgui-premium-menu-design/SKILL.md'), 'the rule must pull in the full skill');
    assert.ok(refs.includes('agent/designer.md'));
    for (const r of refs) assert.ok(fs.existsSync(path.join(STUDIO_ROOT, r)), `${r} referenced by the Cursor rule`);
    const jsonc = (f) => JSON.parse(fs.readFileSync(path.join(STUDIO_ROOT, '.vscode', f), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    const tasks = jsonc('tasks.json').tasks;
    const all = tasks.find((t) => t.runOptions?.runOn === 'folderOpen');
    for (const dep of all.dependsOn) assert.ok(tasks.some((t) => t.label === dep), dep);
    assert.equal(jsonc('launch.json').configurations.length, 2);
  });

  it('renders stream-json progress', () => {
    let out = '';
    const r = createRenderer({ write: (s) => (out += s) });
    r.handle({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5', mcp_servers: [{ name: 'imgui-studio', status: 'connected' }], tools: ['mcp__imgui-studio__build_start'] });
    r.handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__imgui-studio__build_start', input: { note: 'first' } }] } });
    r.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"build_id":3,"success":true,"duration_ms":812}' }, { type: 'image', data: 'x' }] }] } });
    r.handle({ type: 'result', subtype: 'success', num_turns: 4, duration_ms: 61000, total_cost_usd: 1.234 });
    assert.match(out, /build_start/);
    assert.match(out, /build #3 ok \(812 ms\) \[1 image\]/);
    assert.match(out, /done/);
    assert.equal(r.result.num_turns, 4);
  });

  it('never exports the Claude Code kit files', async () => {
    const dir = tmp('export');
    fs.rmSync(dir, { recursive: true });
    await createProject(dir, { template: 'minimal' });
    const exp = await exportProject({ projectDir: dir, latestBuildId: () => null }, { zip: false });
    assert.ok(!fs.existsSync(path.join(exp.export_dir, 'CLAUDE.md')));
    assert.ok(!fs.existsSync(path.join(exp.export_dir, '.mcp.json')));
    assert.ok(!fs.existsSync(path.join(exp.export_dir, '.claude')));
    assert.ok(fs.existsSync(path.join(exp.export_dir, 'src', 'main.cpp')));
  });
});
