// MCP (Model Context Protocol) adapter over stdio.
//
// Exposes every Studio operation as an MCP tool. If a Studio server for the same
// project is already running (e.g. `imgui-studio serve`), tool calls are proxied
// to it; otherwise the Studio server is started in-process so the user can open
// the UI and watch the agent work.
import readline from 'node:readline';
import { listOps, runOp } from './ops.js';
import { log } from './util.js';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'imgui-studio', version: '0.1.0' };

const INSTRUCTIONS = `ImGui Studio gives you a real visual feedback loop for Dear ImGui C++ UIs.
The C++ sources are the source of truth; the preview is the real compiled code (Emscripten -> WebAssembly -> WebGL2), never an imitation.

Loop: edit C++ (project_patch_file / project_write_file, or your own file tools) -> build_start (returns errors with file:line, or a screenshot) -> inspect (ui_list_widgets, capture_widget) -> interact (ui_click_widget, ui_hover_widget, ui_drag_widget, ui_set_value) -> compare (reference_compare, reference_compare_region) -> repeat. Finish with export_check and export_source.

- The agent preview is deterministic: time only advances when you act (settle_ms) or call ui_wait. The same build + same actions = identical pixels.
- Use capture_animation to judge motion (easing, overshoot, timing) from a filmstrip evaluated at exact timestamps.
- Widgets are addressable by semantic ids. Improve ids with STUDIO_SCOPE("section") / STUDIO_ID("x.y") and expose values with STUDIO_BIND(&v) (see studio.h); the macros compile away in native builds.
- Use ImGui::GetTime()/GetIO().DeltaTime for animation (not wall-clock time) so animation capture is deterministic.
- history_list / history_compare_builds / history_revert let you go back if an iteration made things worse.`;

function toolList() {
  return listOps()
    .filter((o) => o.mcp)
    .map((o) => ({
      name: o.name,
      title: o.title,
      description: o.description,
      inputSchema: o.input,
      annotations: { title: o.title, readOnlyHint: /^(project_info|project_list_files|project_read_file|project_search|build_status|build_errors|ui_list_widgets|ui_inspect_widget|ui_widget_at|captures_list|reference_list|history_list|history_diff|runtime_errors)$/.test(o.name) },
    }));
}

function toContent(result) {
  const images = (result && result.images) || [];
  const data = result && typeof result === 'object' ? { ...result } : { result };
  if (data.images) data.images = images.map((im) => ({ caption: im.caption }));
  const content = [{ type: 'text', text: JSON.stringify(data) }];
  for (const im of images) if (im.data) content.push({ type: 'image', data: im.data, mimeType: im.mime || 'image/png' });
  return content;
}

export async function runMcpServer({ call }) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

  async function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
          return isRequest && write({ jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return undefined;
        case 'ping':
          return isRequest && write({ jsonrpc: '2.0', id, result: {} });
        case 'tools/list':
          return isRequest && write({ jsonrpc: '2.0', id, result: { tools: toolList() } });
        case 'tools/call': {
          const name = params?.name;
          const args = params?.arguments || {};
          const tool = listOps().find((o) => o.name === name && o.mcp);
          if (!tool) return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
          try {
            const result = await call(name, args);
            return write({ jsonrpc: '2.0', id, result: { content: toContent(result) } });
          } catch (e) {
            const err = { error: { code: e.code || 'error', message: e.message, ...(e.details ? { details: e.details } : {}) } };
            return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(err) }], isError: true } });
          }
        }
        case 'resources/list':
          return isRequest && write({ jsonrpc: '2.0', id, result: { resources: [] } });
        case 'prompts/list':
          return isRequest && write({ jsonrpc: '2.0', id, result: { prompts: [] } });
        default:
          if (isRequest) write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (e) {
      log('mcp error', e.stack || e.message);
      if (isRequest) write({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
    return undefined;
  }

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
  });

  return new Promise((resolve) => rl.on('close', resolve));
}

// Call operations in-process.
export function localCaller(studio) {
  return (name, args) => runOp(studio, name, args, { source: 'mcp' });
}

// Call operations on an already running Studio server.
export function remoteCaller(baseUrl) {
  return async (name, args) => {
    const res = await fetch(`${baseUrl}/api/op/${name}?images=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-studio-client': 'mcp' },
      body: JSON.stringify(args || {}),
    });
    const body = await res.json();
    if (!body.ok) {
      const e = new Error(body.error?.message || 'Studio operation failed');
      e.code = body.error?.code;
      e.details = body.error?.details;
      throw e;
    }
    return body.result;
  };
}
