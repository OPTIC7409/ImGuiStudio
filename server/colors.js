// Colour literals in the project's C++ sources, for the Studio's Colors panel.
// Finds Hex(0xRRGGBB[, a]) style helpers, ImVec4(r, g, b, a), ImColor(...) and
// IM_COL32(r, g, b, a) with literal arguments, and rewrites them in place in their
// original notation. The sources stay the source of truth: an edit is a text edit.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StudioError, resolveInside, walkFiles } from './util.js';

const CODE_EXT = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i;
const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?[fF]?';
const PATTERNS = [
  { kind: 'hex', re: new RegExp(`\\b(\\w*(?:hex|Hex|HEX|rgb|Rgb|RGB)\\w*)\\(\\s*0[xX]([0-9a-fA-F]{6})\\s*(?:,\\s*(${NUM})\\s*)?\\)`, 'g') },
  { kind: 'vec4', re: new RegExp(`\\b(ImVec4)\\(\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\)`, 'g') },
  { kind: 'imcolor', re: new RegExp(`\\b(ImColor)\\(\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*(?:,\\s*(${NUM})\\s*)?\\)`, 'g') },
  { kind: 'col32', re: /\b(IM_COL32)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g },
];

// Comments and string literals blanked out (same length) so they never match.
function codeOnly(text) {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => m.replace(/[^\n]/g, ' '));
}

// ImColor(int, int, int[, int]) is 0-255; with any float argument it is 0-1.
const isIntColor = (m) => ![m[2], m[3], m[4], m[5] || ''].some((s) => /[.eEfF]/.test(s));
const num = (s) => parseFloat(String(s).replace(/[fF]$/, ''));
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const hex2 = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');

function parse(kind, m) {
  if (kind === 'hex') {
    const v = parseInt(m[2], 16);
    return { rgba: [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, m[3] != null ? num(m[3]) : 1] };
  }
  if (kind === 'col32') {
    const c = [m[2], m[3], m[4], m[5]].map(Number);
    if (c.some((x) => x > 255)) return null;
    return { rgba: c.map((x) => x / 255) };
  }
  const c = [m[2], m[3], m[4], m[5] ?? '1'].map(num);
  // ImColor takes 0-255 ints or 0-1 floats; ImVec4 must look like a colour.
  if (kind === 'imcolor' && isIntColor(m)) return c.every((x) => x >= 0 && x <= 255) ? { rgba: [c[0] / 255, c[1] / 255, c[2] / 255, m[5] != null ? c[3] / 255 : 1] } : null;
  return c.every((x) => x >= 0 && x <= 1) ? { rgba: c } : null;
}

// What the colour is called: `C.bg_root = Hex(..)` -> "C.bg_root", `c[ImGuiCol_Text] = ..` -> "ImGuiCol_Text",
// `SetAccent(Hex(..))` -> "SetAccent()", `{ "Ocean", Hex(..) }` -> "Ocean", `kSwatches[] = { .., Hex(..) }` -> "kSwatches[1]".
function arrayElement(code, start) {
  let depth = 0;
  let commas = 0;
  for (let i = start - 1; i >= Math.max(0, start - 2000); i--) {
    const ch = code[i];
    if (ch === ')' || ch === '}' || ch === ']') depth++;
    else if (ch === '(' || ch === '[') {
      if (depth-- === 0) return null;
    } else if (ch === '{') {
      if (depth-- > 0) continue;
      const m = /(\w+)\s*\[[^\]]*\]\s*=\s*$/.exec(code.slice(Math.max(0, i - 200), i));
      return m ? `${m[1]}[${commas}]` : null;
    } else if (ch === ',' && depth === 0) commas++;
    else if (ch === ';' && depth === 0) return null;
  }
  return null;
}

function nameFor(text, start, code) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const before = text.slice(lineStart, start);
  let m = /([A-Za-z_][\w.>\-]*(?:\[[^\]]*\])?)\s*=\s*$/.exec(before);
  if (m) {
    const idx = /\[\s*(ImGuiCol_\w+)\s*\]$/.exec(m[1]);
    return { name: idx ? idx[1] : m[1].replace(/->/g, '.'), named: true };
  }
  m = /"([^"\n]{1,40})"\s*,\s*$/.exec(before);
  if (m) return { name: m[1], named: true };
  const el = arrayElement(code, start);
  if (el) return { name: el, named: true };
  m = /(\w+)\s*\(\s*(?:[^()]*,\s*)?$/.exec(before);
  if (m && !/^(if|for|while|return|switch)$/.test(m[1])) return { name: `${m[1]}()`, named: /^Set[A-Z]/.test(m[1]) };
  return { name: null, named: false };
}

function fmtFloat(v, suffix) {
  const s = String(Math.round(clamp01(v) * 1000) / 1000);
  return `${/[.e]/.test(s) ? s : `${s}.0`}${suffix}`;
}

// The literal rewritten to rgba, in the notation (and float suffix) it was written in.
function format(c, rgba) {
  const [r, g, b, a] = rgba.map(clamp01);
  const f = /[fF]$/.test(c.args.find((x) => /[.eE]/.test(x)) || 'f') ? 'f' : '';
  if (c.kind === 'hex') {
    const digits = `${hex2(r)}${hex2(g)}${hex2(b)}`;
    const hx = /[A-F]/.test(c.args[0]) || !/[a-f]/.test(c.args[0]) ? digits.toUpperCase() : digits;
    const alpha = c.args[1] != null || a < 0.9995 ? `, ${fmtFloat(a, /[fF]$/.test(c.args[1] || 'f') ? 'f' : '')}` : '';
    return `${c.fn}(0x${hx}${alpha})`;
  }
  if (c.kind === 'col32') return `IM_COL32(${[r, g, b, a].map((x) => Math.round(x * 255)).join(', ')})`;
  if (c.kind === 'imcolor' && c.ints) {
    const parts = [r, g, b].map((x) => Math.round(x * 255));
    if (c.args.length > 3 || a < 0.9995) parts.push(Math.round(a * 255));
    return `ImColor(${parts.join(', ')})`;
  }
  const parts = [r, g, b].map((x) => fmtFloat(x, f));
  if (c.kind === 'vec4' || c.args.length > 3 || a < 0.9995) parts.push(fmtFloat(a, f));
  return `${c.fn}(${parts.join(', ')})`;
}

export function hexOf(rgba) {
  return `#${rgba.slice(0, 3).map(hex2).join('').toUpperCase()}`;
}

export function scanText(file, text) {
  const code = codeOnly(text);
  const out = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(code)); ) {
      const p = parse(kind, m);
      if (!p) continue;
      const start = m.index;
      const literal = text.slice(start, start + m[0].length);
      const line = text.slice(0, start).split('\n').length;
      const { name, named } = nameFor(text, start, code);
      out.push({
        id: `${file}:${start}`,
        file,
        start,
        line,
        column: start - text.lastIndexOf('\n', start - 1),
        kind,
        fn: m[1],
        args: m.slice(2).filter((x) => x != null),
        ints: kind === 'imcolor' && isIntColor(m),
        literal,
        rgba: p.rgba.map((x) => Math.round(x * 10000) / 10000),
        hex: hexOf(p.rgba),
        alpha: Math.round(p.rgba[3] * 100),
        name,
        named,
        context: text.slice(text.lastIndexOf('\n', start - 1) + 1, text.indexOf('\n', start) === -1 ? undefined : text.indexOf('\n', start)).trim().slice(0, 160),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function scanProject(projectDir) {
  const files = walkFiles(projectDir).filter((f) => CODE_EXT.test(f) && !f.startsWith('imgui/') && !f.startsWith('third_party/'));
  const colors = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(projectDir, f), 'utf8');
    if (text.length < 2 * 1024 * 1024) colors.push(...scanText(f, text));
  }
  // Unique colours (Figma's "selection colors"): same RGBA -> one swatch, many uses.
  const groups = new Map();
  for (const c of colors) {
    const key = `${c.hex}/${c.alpha}`;
    if (!groups.has(key)) groups.set(key, { key, hex: c.hex, alpha: c.alpha, rgba: c.rgba, uses: [] });
    groups.get(key).uses.push(c.id);
  }
  return {
    colors: colors.map(({ args, fn, ints, ...c }) => c),
    groups: [...groups.values()].sort((a, b) => b.uses.length - a.uses.length),
  };
}

// edits: [{ id: "file:offset", literal: <text the client saw> }]; rgba: [r, g, b, a] in 0..1.
export async function setColors(projectDir, { edits, rgba }) {
  if (!Array.isArray(rgba) || rgba.length !== 4 || rgba.some((x) => typeof x !== 'number' || Number.isNaN(x))) {
    throw new StudioError('bad_args', 'rgba must be [r, g, b, a] numbers in 0..1');
  }
  const byFile = new Map();
  for (const e of edits) {
    const i = e.id.lastIndexOf(':');
    const file = e.id.slice(0, i);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ start: Number(e.id.slice(i + 1)), literal: e.literal });
  }
  const changed = [];
  const writes = [];
  for (const [file, list] of byFile) {
    const abs = resolveInside(projectDir, file);
    const text = await fsp.readFile(abs, 'utf8');
    const found = new Map(scanText(file, text).map((c) => [c.start, c]));
    let out = text;
    for (const e of list.sort((a, b) => b.start - a.start)) {
      const c = found.get(e.start);
      if (!c || c.literal !== e.literal) {
        throw new StudioError('stale', `${file} changed since the colours were listed (no ${e.literal} at offset ${e.start}). Refresh and try again.`);
      }
      out = out.slice(0, c.start) + format(c, rgba) + out.slice(c.start + c.literal.length);
    }
    if (out !== text) writes.push([abs, out, file]);
  }
  for (const [abs, out, file] of writes) {
    await fsp.writeFile(abs, out);
    changed.push(file);
  }
  return { changed, ...scanProject(projectDir) };
}
