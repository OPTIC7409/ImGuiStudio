// Unit tests for server-side building blocks (no toolchain or browser needed).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePathMapper, parseDiagnostics } from '../server/diagnostics.js';
import { parseDepfile } from '../server/builder.js';
import { unifiedDiff, diffStats } from '../server/textdiff.js';
import { compose, createImage, crop, decodeImage, encodePng, fillRect, scaleNearest } from '../server/images.js';
import { compareImages } from '../server/compare.js';
import { createZip } from '../server/zip.js';
import { globToRegExp, resolveInside, parseColor } from '../server/util.js';

const PROJECT = '/work/proj';
const STUDIO = '/opt/imgui-studio';
const mapPath = makePathMapper({ projectDir: PROJECT, studioRoot: STUDIO, objToSource: new Map([['/cache/abc.o', '/work/proj/src/menu.cpp']]) });

describe('diagnostics', () => {
  it('parses clang errors with snippets, notes and include stacks', () => {
    const out = [
      'In file included from /work/proj/src/menu.cpp:3:',
      '/work/proj/widgets/toggle.hpp:5:1: error: unknown type name \'foo\'',
      '    5 | foo bar;',
      '      | ^',
      '/work/proj/src/menu.cpp:42:17: error: use of undeclared identifier \'anim_progress\'',
      '   42 |     float t = anim_progress;',
      '      |               ^~~~~~~~~~~~~',
      '/work/proj/src/menu.cpp:10:8: note: did you mean \'anim_prog\'?',
      '/opt/imgui-studio/third_party/imgui/imgui.h:100:3: warning: something odd [-Wfoo]',
      '2 errors generated.',
    ].join('\n');
    const d = parseDiagnostics(out, mapPath);
    assert.equal(d.length, 3);
    assert.deepEqual([d[0].file, d[0].line, d[0].column], ['widgets/toggle.hpp', 5, 1]);
    assert.equal(d[0].included_from[0].file, 'src/menu.cpp');
    assert.equal(d[1].message, "use of undeclared identifier 'anim_progress'");
    assert.match(d[1].snippet, /anim_progress/);
    assert.equal(d[1].notes.length, 1);
    assert.equal(d[2].severity, 'warning');
    assert.equal(d[2].flag, '-Wfoo');
    assert.equal(d[2].external, true);
    assert.equal(d[2].file, '<studio>/third_party/imgui/imgui.h');
  });

  it('maps linker errors back to source files', () => {
    const d = parseDiagnostics('wasm-ld: error: /cache/abc.o: undefined symbol: ui::Toggle(char const*, bool*)', mapPath);
    assert.equal(d.length, 1);
    assert.equal(d[0].file, 'src/menu.cpp');
    assert.equal(d[0].linker, true);
    assert.match(d[0].message, /undefined symbol/);
  });

  it('treats symlink-resolved compiler paths as project files (macOS /var -> /private/var)', () => {
    // realpath: on macOS the temp dir itself is under the /var symlink.
    const real = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'imgui-studio-real-')));
    const link = `${real}-link`;
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    const map = makePathMapper({ projectDir: link, studioRoot: STUDIO });
    assert.deepEqual(map(path.join(real, 'src', 'main.cpp')), { file: 'src/main.cpp', external: false });
    assert.deepEqual(map(path.join(link, 'src', 'main.cpp')), { file: 'src/main.cpp', external: false });
    fs.rmSync(link);
    fs.rmSync(real, { recursive: true });
  });
});

describe('depfile', () => {
  it('handles continuations and escaped spaces', () => {
    const deps = parseDepfile('obj.o: /a/src/main.cpp \\\n  /a/include/my\\ header.h \\\n  /a/imgui.h\n');
    assert.deepEqual(deps, ['/a/src/main.cpp', '/a/include/my header.h', '/a/imgui.h']);
  });
});

describe('textdiff', () => {
  it('produces unified hunks and stats', () => {
    const a = 'one\ntwo\nthree\nfour\n';
    const b = 'one\n2\nthree\nfour\nfive\n';
    const d = unifiedDiff(a, b, { fromFile: 'a', toFile: 'b' });
    assert.match(d, /^--- a\n\+\+\+ b\n@@/);
    assert.match(d, /-two\n\+2/);
    assert.match(d, /\+five/);
    assert.deepEqual(diffStats(a, b), { added: 2, removed: 1 });
    assert.equal(unifiedDiff(a, a), '');
  });
});

describe('images', () => {
  it('round-trips PNG and crops/scales', () => {
    const img = createImage(20, 10, [10, 20, 30, 255]);
    fillRect(img, 5, 2, 4, 4, [255, 0, 0, 255]);
    const back = decodeImage(encodePng(img));
    assert.equal(back.width, 20);
    assert.deepEqual([...back.data.slice(0, 4)], [10, 20, 30, 255]);
    const c = crop(back, { x: 5, y: 2, width: 4, height: 4 });
    assert.deepEqual([...c.data.slice(0, 4)], [255, 0, 0, 255]);
    const z = scaleNearest(c, 3);
    assert.equal(z.width, 12);
    const comp = compose([{ image: img, label: 'A' }, { image: img, label: 'B' }]);
    assert.ok(comp.width > 40 && comp.height > 10);
  });
});

describe('compare', () => {
  function scene(offsetX = 0) {
    const img = createImage(200, 120, [15, 17, 22, 255]);
    fillRect(img, 20 + offsetX, 20, 80, 30, [109, 93, 252, 255]);
    fillRect(img, 20 + offsetX, 70, 140, 8, [230, 230, 240, 255]);
    return img;
  }

  it('scores identical images as identical', () => {
    const { result } = compareImages(scene(), scene());
    assert.equal(result.similarity, 100);
    assert.equal(result.pixel.mismatch_ratio, 0);
    assert.equal(result.hotspots.length, 0);
  });

  it('detects a horizontal layout offset and reports hotspots', () => {
    const { result } = compareImages(scene(0), scene(6));
    assert.ok(result.similarity < 100);
    assert.equal(result.layout.estimated_offset.dx, -6);
    assert.ok(result.hotspots.length > 0);
  });

  it('resizes references with the same aspect ratio', () => {
    const big = createImage(400, 240, [15, 17, 22, 255]);
    const { result } = compareImages(big, scene());
    assert.equal(result.size.fit, 'stretch');
  });
});

describe('zip', () => {
  it('writes a valid archive structure', () => {
    const zip = createZip([{ name: 'a/b.txt', data: Buffer.from('hello hello hello hello') }, { name: 'c.bin', data: Buffer.from([1, 2, 3]) }]);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    const end = zip.length - 22;
    assert.equal(zip.readUInt32LE(end), 0x06054b50);
    assert.equal(zip.readUInt16LE(end + 10), 2);
  });
});

describe('util', () => {
  it('matches globs', () => {
    assert.ok(globToRegExp('**/*.cpp').test('src/menu.cpp'));
    assert.ok(globToRegExp('**/*.cpp').test('main.cpp'));
    assert.ok(globToRegExp('src/**/*.cpp').test('src/a/b.cpp'));
    assert.ok(!globToRegExp('imgui/**').test('src/imgui.cpp'));
    assert.ok(globToRegExp('*.{h,hpp}').test('x.hpp'));
  });

  it('refuses paths that escape the project', () => {
    assert.throws(() => resolveInside('/work/proj', '../etc/passwd'), /escapes/);
    assert.equal(resolveInside('/work/proj', 'src/a.cpp'), path.resolve('/work/proj/src/a.cpp'));
  });

  it('parses colours', () => {
    assert.deepEqual(parseColor('#ff0000').map((v) => Math.round(v * 255)), [255, 0, 0, 255]);
    assert.deepEqual(parseColor([255, 128, 0]).map((v) => Math.round(v * 255)), [255, 128, 0, 255]);
  });
});
