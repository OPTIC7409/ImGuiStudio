// Colors panel backend: colour literals are found, named, and rewritten in their own notation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanProject, scanText, setColors } from '../server/colors.js';

const SRC = `#include "theme.h"
// Hex(0x123456) in a comment is ignored
void Init()
{
    C.bg_root = Hex(0x0C0D11);
    C.shadow  = Hex(0x000000, 0.6f);
    c[ImGuiCol_ChildBg] = ImVec4(0, 0, 0, 0);
    const ImVec4 kAccents[] = { Hex(0xF5A03A), Hex(0xF0605A) };
    dl->AddRect(a, b, IM_COL32(255, 128, 0, 255));
    SetAccent(Hex(0xf5a03a));
    ImVec4 rect = ImVec4(10, 20, 30, 40);
}
`;

describe('colors', () => {
  it('finds and names colour literals', () => {
    const list = scanText('theme.cpp', SRC);
    assert.deepEqual(
      list.map((c) => [c.name, c.hex, c.alpha]),
      [
        ['C.bg_root', '#0C0D11', 100],
        ['C.shadow', '#000000', 60],
        ['ImGuiCol_ChildBg', '#000000', 0],
        ['kAccents[0]', '#F5A03A', 100],
        ['kAccents[1]', '#F0605A', 100],
        ['AddRect()', '#FF8000', 100],
        ['SetAccent()', '#F5A03A', 100],
      ],
    );
  });

  it('rewrites literals in place, keeping their notation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgui-studio-colors-'));
    fs.writeFileSync(path.join(dir, 'theme.cpp'), SRC);
    const { colors, groups } = scanProject(dir);
    const orange = groups.find((g) => g.hex === '#F5A03A');
    assert.equal(orange.uses.length, 2);
    const byId = new Map(colors.map((c) => [c.id, c]));
    const edits = [...orange.uses, colors.find((c) => c.name === 'ImGuiCol_ChildBg').id, colors.find((c) => c.kind === 'col32').id].map((id) => ({ id, literal: byId.get(id).literal }));
    await setColors(dir, { edits, rgba: [0.2, 0.4, 1, 0.5] });
    const out = fs.readFileSync(path.join(dir, 'theme.cpp'), 'utf8');
    assert.match(out, /kAccents\[\] = \{ Hex\(0x3366FF, 0\.5f\), Hex\(0xF0605A\) \}/);
    assert.match(out, /SetAccent\(Hex\(0x3366ff, 0\.5f\)\)/);
    assert.match(out, /ImVec4\(0\.2f, 0\.4f, 1\.0f, 0\.5f\)/);
    assert.match(out, /IM_COL32\(51, 102, 255, 128\)/);
    assert.match(out, /ImVec4\(10, 20, 30, 40\)/);
    await assert.rejects(setColors(dir, { edits, rgba: [0, 0, 0, 1] }), /changed since/);
  });
});
