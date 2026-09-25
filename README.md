# ImGui Studio

**A visual feedback loop for AI agents building real Dear ImGui interfaces in C++.**

Agents are good at writing Dear ImGui code but blind to what it looks like, so
they settle for "default ImGui with new colours". ImGui Studio compiles the
actual C++ to WebAssembly, renders it through WebGL2, and gives the agent eyes
and hands: screenshots, widget inspection, scripted interaction, deterministic
animation filmstrips, reference-image comparison, build history, and export
back to a native project.

![Studio UI](docs/images/studio-ui.png)

```
edit C++  ->  build_start (incremental, ~0.5-1 s)  ->  real Dear ImGui render (WASM + WebGL2)
   ^                                                            |
   |          inspect widgets / click / drag / hover / filmstrip / compare to reference
   +--------------------------------------------------------------+
                                  ...  ->  export_source  ->  native C++ (CMake + GLFW)
```

There is no HTML mock-up anywhere: every pixel comes from compiled Dear ImGui
code. The exported native build renders the same pixels as the preview
(SSIM 1.000, PSNR 56.8 dB between the WebGL2 preview and a GLFW + Mesa build of
the showcase project).

| Studio preview (WASM + WebGL2) | Exported native app (GLFW + OpenGL 3) |
|---|---|
| ![preview](docs/images/showcase.png) | ![native](docs/images/native-glfw.png) |

## Quick start

Requirements: Node 20+, [Emscripten](https://emscripten.org/docs/getting_started/downloads.html)
(emsdk; found via `EMSDK`, `PATH`, `~/emsdk` or `/opt/emsdk`), and a Chromium for the
headless agent preview (Playwright's Chromium or system Chrome; override with
`IMGUI_STUDIO_BROWSER`). `imgui-studio doctor` checks all three.

```sh
npm install
npm start                                   # Studio UI on http://localhost:7420 (creates ./workspace from the showcase)
node bin/imgui-studio.js new my-menu        # new project from a template (showcase | minimal)
node bin/imgui-studio.js serve --project my-menu
```

The first build compiles Dear ImGui once (~5 s) into a shared cache; after that
only changed files recompile. An edit to one file typically goes from save to a
reloaded preview and screenshot in 0.5-1 s.

## The ImGui Menu Designer agent

`imgui-studio agent` runs **Claude Code** headless as a menu designer, with the
[`imgui-premium-menu-design`](.claude/skills/imgui-premium-menu-design/SKILL.md)
skill **always loaded** and ImGui Studio as its only way to build and look:

```sh
node bin/imgui-studio.js agent "Design the settings window for an audio app: sidebar nav, \
  a preset selector, audio/MIDI/appearance pages" --new resonance --budget 5

node bin/imgui-studio.js agent "Recreate this menu" --project my-menu --reference target.png
```

How the skill stays in context for every run (never left to on-demand skill matching):

| Where the agent runs | How the skill is loaded |
|---|---|
| `imgui-studio agent` (headless) | Designer instructions + the full skill are passed with `--append-system-prompt-file`; for projects that already import it via CLAUDE.md, the import is used instead so it is never duplicated |
| `claude` inside a project created by `imgui-studio new` (or after `imgui-studio agent-kit`) | The project's `CLAUDE.md` `@imports` the designer instructions and the full skill at session start; `.mcp.json` configures the `imgui-studio` server |
| `claude --agent imgui-menu-designer` in this repo, or delegating to that subagent | [`.claude/agents/imgui-menu-designer.md`](.claude/agents/imgui-menu-designer.md) preloads the skill through its `skills:` frontmatter |

The headless run uses `--strict-mcp-config` (only the Studio's MCP server),
`--tools Read,Edit,Write,Glob,Grep` (no shell: every build goes through
`build_start`), `--permission-mode acceptEdits`, and streams its progress; the
designer's narration also appears live in the Studio's **Agent** tab. Options:
`--model` (default `claude-opus-5-5`), `--effort` (default `high`), `--budget USD`,
`--max-turns N`, `--dry-run` (print the exact Claude Code command and files).
Transcripts are saved to `<project>/.studio/agent/run-*.jsonl`.

The designer's operating instructions live in [`agent/designer.md`](agent/designer.md):
the working loop (build, judge screenshots against the skill using measured
bounds, exercise every control, filmstrip animations, compare to references),
the finish criteria (the skill's section 29 checklist with capture evidence,
clean runtime errors, `export_check`, `export_source`), and boundaries. After
editing it, run `node bin/imgui-studio.js agent-kit --repo` to regenerate the subagent.

## Using the Studio from any MCP client

`imgui-studio mcp` is an MCP stdio server; it starts the Studio for the project
(or proxies to one already running), so you can watch the agent in the UI.

```sh
claude mcp add imgui-studio -- node /path/to/ImGuiStudio/bin/imgui-studio.js mcp --project /path/to/my-menu
```

This repository's [`.mcp.json`](.mcp.json) does the same for the default `workspace/` project.

### Tools

| Area | Tools |
|---|---|
| Project | `project_info`, `project_list_files`, `project_read_file`, `project_write_file`, `project_patch_file`, `project_delete_file`, `project_search` |
| Build | `build_start` (returns structured errors, or a screenshot + reference score), `build_status`, `build_errors`, `runtime_errors`, `preview_reload`, `preview_set_viewport` |
| Inspect & interact | `ui_list_widgets`, `ui_inspect_widget`, `ui_widget_at`, `ui_click_widget`, `ui_hover_widget`, `ui_mouse_leave`, `ui_drag_widget`, `ui_scroll`, `ui_set_value`, `ui_key`, `ui_type_text`, `ui_wait` |
| Capture | `capture_screen`, `capture_region`, `capture_widget`, `capture_window`, `capture_animation`, `captures_list` |
| Reference | `reference_load`, `reference_list`, `reference_set_active`, `reference_set_regions`, `reference_compare`, `reference_compare_region` |
| History | `history_list`, `history_diff`, `history_revert`, `history_note`, `history_compare_builds` |
| Export | `export_source`, `export_check` |

Interaction tools accept a semantic widget id (`graphics.vsync`), a unique label,
or `x`/`y` coordinates, and return the widget's state before and after. Pass
`capture: true` to get a screenshot back in the same call.

## Writing a project

A project is ordinary Dear ImGui C++ plus a `studio.json`:

```
my-menu/
  studio.json          # name, sources, include_dirs, viewport, background
  src/main.cpp         # AppInit() / AppFrame()
  src/menu.cpp         # composition
  widgets/*.cpp        # your ui:: control layer
  theme/*.cpp          # tokens, fonts, style
  assets/fonts/        # mounted into the preview; loaded with relative paths
```

The only contract is [`studio_app.h`](runtime/include/studio_app.h): `AppInit()` once
after the context and renderer exist, `AppFrame()` every frame between
`NewFrame()` and `Render()`. The same two calls drive the WebAssembly preview
and the exported native host, and they are all you need to embed the UI in an
existing application.

### Instrumentation (`studio.h`)

The Studio sees every Dear ImGui item automatically through Dear ImGui's
test-engine hooks (bounds, labels, hover/active, checked/open). The macros in
[`studio.h`](runtime/include/studio.h) add meaning and compile to nothing without
`IMGUI_STUDIO`, so instrumented code builds unchanged in native apps:

```cpp
bool ui::Toggle(const char* label, bool* v)
{
    ImGui::InvisibleButton(label, size);
    STUDIO_WIDGET("toggle");        // type for inspection
    STUDIO_BIND(v);                 // readable + settable with ui_set_value
    // ... animate with ImGui::GetIO().DeltaTime, draw with ImDrawList ...
    STUDIO_STATE("anim", t);        // shows up per frame in capture_animation
}

STUDIO_SCOPE("graphics");           // ids below become graphics.<label>
ui::Toggle("VSync", &s.vsync);      // -> "graphics.vsync"
```

Also: `STUDIO_ID("x.y")` (explicit id), `STUDIO_LABEL(label)` (for widgets built on
`ItemAdd`), `STUDIO_BIND_N / _COLOR / _TEXT`, and `STUDIO_REGION("sidebar", min, max)`
for panels that are not items.

### Determinism

The agent preview runs in a headless Chromium with SwiftShader WebGL2 and a
fixed 1/60 s timestep: time only advances when a command acts or waits, so the
same build and the same actions produce identical pixels on any machine. Drive
animations from `ImGui::GetIO().DeltaTime` / `ImGui::GetTime()`.

`capture_animation` performs an action at t = 0 and renders frames at exact
timestamps (sub-stepping at <= 1/60 s so exponential smoothing behaves as it
would live), returning a labelled filmstrip plus the widget's state per frame:

![filmstrip](docs/images/filmstrip-toggle.png)

### Comparing with a reference

`reference_compare` returns a REFERENCE | CURRENT | DIFF composite and metrics:
similarity score, SSIM, pixel mismatch, colour (mean dE, matched palettes), edge
alignment, an estimated global layout offset, and hotspots annotated with the
widgets they overlap. `reference_compare_region` compares one mapped region (or
a widget's bounds) and reports its position/size delta. The Studio's Compare
view offers side-by-side, overlay, difference and swipe modes, region drawing,
and the live preview can overlay the reference directly.

![compare](docs/images/studio-compare.png)

## Studio UI

- **Left**: file tree and Monaco editor (Ctrl+S save, Ctrl+B build, error markers).
- **Centre**: the live preview (the same WASM build, realtime), with viewport presets,
  zoom, HiDPI, pause/step/slow-motion, inspect mode, 8 px grid, reference overlay;
  and the Compare view.
- **Right**: widget inspector (live list, details, source links, actions), references
  and regions, visual build history (timeline, notes, diffs, compare, revert),
  captures, and the Agent activity log.
- **Bottom**: problems (structured diagnostics), streamed build output, runtime
  errors and logs (assertions with file:line, Dear ImGui error recovery messages).
- "Agent drives preview" routes agent commands to your visible preview instead of
  the headless one, so you can watch every click.

## Export

`export_source` writes `export/<name>-build<N>/` (and a zip): your sources and
assets, `studio/studio.h`, Dear ImGui, `native/main.cpp` (GLFW + OpenGL 3 host)
and a `CMakeLists.txt` (uses system GLFW, or fetches it). `export_check`
compiles every source with the host compiler without `IMGUI_STUDIO` to prove
there is no Studio dependency.

```sh
cd export/my-menu-build12 && cmake -S . -B build && cmake --build build
```

## Architecture

```
bin/imgui-studio.js      CLI: serve, mcp, agent, agent-kit, new, build, export, check, doctor
server/
  builder.js             incremental Emscripten builds (content-addressed object cache, depfiles, parallel)
  diagnostics.js         clang / wasm-ld output -> structured errors
  studio.js              project state: builds, history, captures, references, preview runtimes
  ops.js                 every capability as an operation (JSON schema + handler)
  mcp.js / http.js       MCP stdio adapter / HTTP + WebSocket API (localhost only)
  headless.js            headless Chromium hosting the deterministic agent preview
  runtime-hub.js         RPC to preview runtimes over WebSocket
  compare.js images.js   metrics, compositing, PNG/JPEG
  history.js textdiff.js snapshots, diff, revert
  exporter.js zip.js     native export + check
  agent.js scaffold.js   Claude Code design agent, project templates + agent kit
runtime/
  include/studio.h       instrumentation macros (no-ops natively)
  src/studio_runtime.cpp widget registry on Dear ImGui's test-engine hooks
  src/studio_host_web.cpp WebGL2 host: frame stepping, input injection, pixel readback
  native/main.cpp        exported GLFW + OpenGL 3 host
web/                     Studio UI and the preview runtime page
agent/designer.md        the designer agent's instructions
.claude/                 the design skill and the designer subagent
templates/               showcase ("Nova" custom settings UI) and minimal projects
third_party/imgui/       Dear ImGui v1.92.9b (see STUDIO_PATCHES.md)
```

## Tests

```sh
npm test    # unit + agent wiring + end-to-end (real Emscripten builds in headless Chromium)
```

End-to-end tests skip automatically when emcc or Chromium is unavailable.

## Licences

MIT for ImGui Studio. Dear ImGui is MIT (third_party/imgui/LICENSE.txt). The Inter
font bundled with the templates is under the SIL Open Font License
(templates/showcase/assets/fonts/Inter-LICENSE.txt).
