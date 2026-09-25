# ImGui Studio - contributor notes

Node (ESM, no build step) server + C++ runtime compiled with Emscripten + plain-JS web UI.

## Commands
- `npm install && npm run setup` - installs Emscripten / a Chromium when missing, builds both examples
- `npm test` - unit, agent-wiring and end-to-end tests (e2e needs emcc + Chromium; skips otherwise)
- `node bin/imgui-studio.js serve --project <dir>` - run the Studio against a project
- `node bin/imgui-studio.js build --project <dir>` - one-shot build, JSON result
- `node bin/imgui-studio.js agent-kit --repo` - regenerate `.claude/agents/imgui-menu-designer.md` after editing `agent/designer.md` (a test fails if they drift)

## Where things live
- Capabilities are operations in `server/ops.js`; MCP tools and `POST /api/op/<name>` both come from there.
- The preview driver (input, deterministic stepping, captures) is `web/js/runtime/preview.js`; it talks to the C exports in `runtime/src/studio_host_web.cpp`.
- Widget registry: `runtime/src/studio_runtime.cpp` (Dear ImGui test-engine hooks). Public macros: `runtime/include/studio.h` - they must stay no-ops without `IMGUI_STUDIO`.
- Vendored Dear ImGui has a two-line patch documented in `third_party/imgui/STUDIO_PATCHES.md`.
- stdout is reserved for MCP JSON-RPC in `mcp` mode: log with `log()` from `server/util.js` (stderr).

## Design agent
- `server/agent.js` runs Claude Code headless; `server/scaffold.js` writes the per-project kit.
- The design skill (`.claude/skills/imgui-premium-menu-design/SKILL.md`) is the user's; keep it verbatim.
- Cursor gets the same setup from `.cursor/mcp.json` and the always-applied `.cursor/rules/imgui-menu-designer.mdc`
  (it `@`-references `agent/designer.md` and the skill; a test checks the references exist).

## Platforms
- Emscripten is run through its Python entry points (`emcc.py` / `em++.py`, see `toolCommand` in `server/config.js`),
  never the `.bat` launchers, so Windows needs no shell. CI (`.github/workflows/ci.yml`) runs setup, tests and a native
  CMake build of the exported Resonance example on Linux, macOS and Windows.
