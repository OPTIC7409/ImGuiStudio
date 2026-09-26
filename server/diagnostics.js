// Parse clang / wasm-ld / emcc output into structured, agent-friendly diagnostics.
import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from './util.js';

const DIAG_RE = /^(.*?):(\d+):(\d+): (fatal error|error|warning|note|remark): (.*?)(?: \[([^\]]+)\])?$/;
const DIAG_NOCOL_RE = /^(.*?):(\d+): (fatal error|error|warning|note): (.*)$/;
const INCLUDED_RE = /^In file included from (.*?):(\d+):$/;
const INCLUDED_MORE_RE = /^\s+from (.*?):(\d+):$/;
const LD_UNDEF_RE = /^wasm-ld: error: (.*?): undefined symbol: (.*)$/;
const LD_DUP_RE = /^wasm-ld: error: duplicate symbol: (.*)$/;
const LD_DEFINED_RE = /^>>> defined in (.*)$/;
const LD_GENERIC_RE = /^wasm-ld: (error|warning): (.*)$/;
const EMCC_RE = /^(?:em\+\+|emcc)(?:\.py)?: (error|warning): (.*)$/;

// The compiler may report symlink-resolved paths (macOS: /var -> /private/var), so a
// root matches both as given and as its real path.
function withRealPath(dir) {
  try {
    const real = fs.realpathSync.native(dir);
    return real === dir ? [dir] : [dir, real];
  } catch {
    return [dir];
  }
}

function relativeInside(roots, abs) {
  for (const root of roots) {
    const rel = path.relative(root, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
  }
  return null;
}

export function makePathMapper({ projectDir, studioRoot, objToSource = new Map() }) {
  const projectRoots = withRealPath(projectDir);
  const studioRoots = withRealPath(studioRoot);
  return function mapPath(p) {
    if (!p) return { file: null, external: true };
    const src = objToSource.get(p) || objToSource.get(path.resolve(p));
    if (src) p = src;
    const abs = path.isAbsolute(p) ? p : path.resolve(projectDir, p);
    const inProject = relativeInside(projectRoots, abs);
    if (inProject !== null) return { file: inProject, external: false };
    const inStudio = relativeInside(studioRoots, abs);
    if (inStudio !== null) return { file: `<studio>/${inStudio}`, external: true };
    return { file: toPosix(abs), external: true };
  };
}

export function parseDiagnostics(text, mapPath) {
  const lines = String(text || '').split(/\r?\n/);
  const diags = [];
  let includeStack = [];
  let current = null; // last primary (non-note) diagnostic
  let target = null; // diagnostic receiving snippet lines
  let lastLd = null;

  for (const line of lines) {
    let m;
    if ((m = line.match(INCLUDED_RE))) {
      includeStack = [{ ...mapPath(m[1]), line: Number(m[2]) }];
      continue;
    }
    if ((m = line.match(INCLUDED_MORE_RE))) {
      includeStack.push({ ...mapPath(m[1]), line: Number(m[2]) });
      continue;
    }
    if ((m = line.match(DIAG_RE)) || (m = line.match(DIAG_NOCOL_RE))) {
      const hasCol = m.length >= 6 && /^\d+$/.test(m[3]);
      const [file, lineNo, col, sev, msg, flag] = hasCol ? [m[1], m[2], m[3], m[4], m[5], m[6]] : [m[1], m[2], '0', m[3], m[4], undefined];
      const loc = mapPath(file);
      const d = {
        severity: sev === 'fatal error' ? 'error' : sev,
        file: loc.file,
        line: Number(lineNo),
        column: Number(col),
        message: msg,
      };
      if (flag) d.flag = flag;
      if (loc.external) d.external = true;
      if (includeStack.length) d.included_from = includeStack;
      includeStack = [];
      if (d.severity === 'note' && current) {
        (current.notes ||= []).push(d);
        target = d;
      } else {
        diags.push(d);
        current = d;
        target = d;
      }
      continue;
    }
    if ((m = line.match(LD_UNDEF_RE))) {
      const loc = mapPath(m[1]);
      const d = { severity: 'error', file: loc.file, line: 0, column: 0, message: `undefined symbol: ${m[2]}`, linker: true };
      if (loc.external) d.external = true;
      diags.push(d);
      current = lastLd = d;
      target = null;
      continue;
    }
    if ((m = line.match(LD_DUP_RE))) {
      const d = { severity: 'error', file: null, line: 0, column: 0, message: `duplicate symbol: ${m[1]}`, linker: true, defined_in: [] };
      diags.push(d);
      current = lastLd = d;
      target = null;
      continue;
    }
    if ((m = line.match(LD_DEFINED_RE)) && lastLd && lastLd.defined_in) {
      const loc = mapPath(m[1]);
      lastLd.defined_in.push(loc.file);
      if (!lastLd.file) lastLd.file = loc.file;
      continue;
    }
    if ((m = line.match(LD_GENERIC_RE))) {
      const d = { severity: m[1], file: null, line: 0, column: 0, message: m[2], linker: true };
      diags.push(d);
      current = lastLd = d;
      target = null;
      continue;
    }
    if ((m = line.match(EMCC_RE))) {
      diags.push({ severity: m[1], file: null, line: 0, column: 0, message: m[2], tool: 'emcc' });
      target = null;
      continue;
    }
    // Source snippet ("   42 |   code" / "      |   ^~~~")
    if (target && /^\s*\d*\s*\|/.test(line)) {
      target.snippet = target.snippet ? `${target.snippet}\n${line}` : line;
      continue;
    }
    if (/^\d+ (errors?|warnings?)( and \d+ (errors?|warnings?))? generated\.$/.test(line)) {
      target = null;
    }
  }
  return diags;
}

export function summarizeDiagnostics(diags, limit = 30) {
  return diags.slice(0, limit).map((d) => {
    const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}${d.column ? `:${d.column}` : ''}` : '<link>';
    return `${where}: ${d.severity}: ${d.message}`;
  });
}
