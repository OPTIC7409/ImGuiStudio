// The drop-in embed/ export: flat sources with local includes, assets compiled in,
// and sources that compile with nothing but Dear ImGui on the include path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BUILTIN_IMGUI_DIR, STUDIO_ROOT } from '../server/config.js';
import { rewriteAssetAccess } from '../server/embed.js';
import { exportProject } from '../server/exporter.js';

function hostCompiler() {
  for (const c of [process.env.CXX, 'clang++', 'g++', 'c++'].filter(Boolean)) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

describe('embed export', () => {
  it('routes font and file loads through StudioAssets', () => {
    const src = [
      '#include "theme.h"',
      '#include <cstdio>',
      'ImFont* A(const char* p) { if (FILE* f = std::fopen(p, "rb")) fclose(f); return ImGui::GetIO().Fonts->AddFontFromFileTTF(p, 13.0f); }',
      'ImFont* B(ImFontAtlas& atlas) { return atlas.AddFontFromFileTTF("assets/x.ttf", 12.0f, nullptr); }',
      'void* C(size_t* n) { return ImFileLoadToMemory("assets/a.bin", "rb", n); }',
      'int my_fopen(int); int D() { return my_fopen(1); }',
    ].join('\n');
    const out = rewriteAssetAccess(src);
    assert.match(out, /^#include "theme.h"\n#include "studio_assets.h"\n/);
    assert.match(out, /if \(FILE\* f = StudioAssets::Open\(p, "rb"\)\)/);
    assert.match(out, /return StudioAssets::AddFontFromFileTTF\(ImGui::GetIO\(\)\.Fonts, p, 13\.0f\)/);
    assert.match(out, /return StudioAssets::AddFontFromFileTTF\(&\(atlas\), "assets\/x\.ttf", 12\.0f, nullptr\)/);
    assert.match(out, /return StudioAssets::LoadToMemory\("assets\/a\.bin"/);
    assert.match(out, /my_fopen\(1\)/);
    assert.equal(rewriteAssetAccess('int x = 1;\n'), null);
  });

  it('exports flat, self-contained sources that compile against plain Dear ImGui', async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'imgui-studio-embed-'));
    const exp = await exportProject({ projectDir: path.join(STUDIO_ROOT, 'examples', 'resonance'), latestBuildId: () => null }, { dest, zip: false });
    const embed = path.join(exp.export_dir, 'embed');
    assert.deepEqual(exp.embed.assets_embedded.filter((a) => a.endsWith('.ttf')).length, 3);
    for (const f of ['CMakeLists.txt', 'README.md', 'studio.h', 'studio_app.h', 'studio_assets.h', 'studio_assets.cpp', 'src_main.cpp', 'ui.h', 'theme.cpp']) {
      assert.ok(fs.existsSync(path.join(embed, f)), f);
    }
    assert.ok(!fs.existsSync(path.join(embed, 'main.cpp')));
    assert.match(fs.readFileSync(path.join(embed, 'theme.cpp'), 'utf8'), /StudioAssets::AddFontFromFileTTF/);
    assert.match(fs.readFileSync(path.join(exp.export_dir, 'CMakeLists.txt'), 'utf8'), /add_subdirectory\(embed\)/);

    const cxx = hostCompiler();
    if (!cxx) return;
    for (const f of fs.readdirSync(embed).filter((n) => n.endsWith('.cpp') && n !== 'studio_assets.cpp')) {
      execFileSync(cxx, ['-std=c++17', '-fsyntax-only', `-I${BUILTIN_IMGUI_DIR}`, path.join(embed, f)], { stdio: 'pipe' });
    }
  });
});
