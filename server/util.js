// Shared helpers: hashing, filesystem walking, logging, small async utilities.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const IGNORED_DIRS = new Set(['.studio', '.git', 'node_modules', 'export', 'build', '.cache', '.vscode', '.idea']);

export function log(...args) {
  // stdout is reserved for the MCP protocol when running as an MCP server.
  process.stderr.write(`[studio] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}

export function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

// Resolve a project-relative path and refuse anything escaping the project root.
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new StudioError('invalid_path', 'A relative file path is required');
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(root, cleaned);
  const relBack = path.relative(root, abs);
  if (relBack.startsWith('..') || path.isAbsolute(relBack)) {
    throw new StudioError('invalid_path', `Path escapes the project root: ${rel}`);
  }
  return abs;
}

export class StudioError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Recursively list files under root (posix relative paths), skipping ignored directories.
export function walkFiles(root, { ignore = IGNORED_DIRS, maxFiles = 20000 } = {}) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.clang-format') {
        if (e.isDirectory()) continue;
      }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (ignore.has(e.name)) continue;
        stack.push(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
        if (out.length >= maxFiles) return out.sort();
      }
    }
  }
  return out.sort();
}

// Minimal glob matcher supporting **, *, ? and {a,b}.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += `(?:${glob.slice(i + 1, end).split(',').map(escapeRe).join('|')})`;
        i = end;
      } else {
        re += '\\{';
      }
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

// Cache of file content hashes keyed by (mtime, size) to avoid re-reading unchanged files.
export class FileHashCache {
  constructor() {
    this.map = new Map();
  }

  hash(absPath) {
    let st;
    try {
      st = fs.statSync(absPath);
    } catch {
      return null;
    }
    const prev = this.map.get(absPath);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev.hash;
    const hash = sha1(fs.readFileSync(absPath));
    this.map.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, hash });
    return hash;
  }
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Run async tasks with bounded concurrency.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function parseColor(input, fallback = [0.06, 0.06, 0.07, 1]) {
  if (Array.isArray(input) && input.length >= 3) {
    const v = input.map(Number);
    const scale = v.some((x) => x > 1) ? 1 / 255 : 1;
    return [v[0] * scale, v[1] * scale, v[2] * scale, v.length > 3 ? v[3] * scale : 1];
  }
  if (typeof input === 'string') {
    const m = input.trim().match(/^#?([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (m) {
      const n = parseInt(m[1], 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
    }
  }
  return fallback;
}

export function nowIso() {
  return new Date().toISOString();
}

export class Emitter {
  constructor() {
    this.handlers = new Map();
  }
  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, new Set());
    this.handlers.get(evt).add(fn);
    return () => this.handlers.get(evt)?.delete(fn);
  }
  emit(evt, data) {
    for (const fn of this.handlers.get(evt) || []) {
      try {
        fn(data);
      } catch (e) {
        log('event handler error', evt, e.stack || String(e));
      }
    }
    for (const fn of this.handlers.get('*') || []) {
      try {
        fn(evt, data);
      } catch (e) {
        log('event handler error', evt, e.stack || String(e));
      }
    }
  }
}
