// Build history: every build records a content-addressed snapshot of the project
// sources, the build result, a screenshot, comparison scores and notes, so any
// iteration can be inspected, diffed and restored.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StudioError, ensureDir, readJsonSync, sha1, walkFiles, writeJsonAtomic } from './util.js';
import { diffStats, unifiedDiff } from './textdiff.js';

const MAX_SNAPSHOT_FILE = 8 * 1024 * 1024;
const TEXT_EXT = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl|ipp|json|md|txt|glsl|hlsl|frag|vert|cmake|ini|toml|ya?ml|svg)$/i;

export class History {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.dir = path.join(projectDir, '.studio');
    this.file = path.join(this.dir, 'history.json');
    this.objects = path.join(this.dir, 'objects');
    this.data = readJsonSync(this.file, { next_id: 1, builds: [] });
    if (!Array.isArray(this.data.builds)) this.data.builds = [];
    this.saving = Promise.resolve();
  }

  nextId() {
    const id = this.data.next_id || 1;
    this.data.next_id = id + 1;
    return id;
  }

  list() {
    return this.data.builds;
  }

  get(id) {
    const b = this.data.builds.find((x) => x.id === Number(id));
    if (!b) throw new StudioError('build_not_found', `Build #${id} not found in history`);
    return b;
  }

  latest({ successful = false } = {}) {
    for (let i = this.data.builds.length - 1; i >= 0; i--) {
      const b = this.data.builds[i];
      if (!successful || b.success) return b;
    }
    return null;
  }

  async save() {
    this.saving = this.saving.then(async () => {
      await ensureDir(this.dir);
      await writeJsonAtomic(this.file, this.data);
    });
    return this.saving;
  }

  objectPath(hash) {
    return path.join(this.objects, hash.slice(0, 2), hash.slice(2));
  }

  // Store every project file (content-addressed; unchanged files cost nothing).
  async snapshot() {
    const files = {};
    for (const rel of walkFiles(this.projectDir)) {
      const abs = path.join(this.projectDir, rel);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size > MAX_SNAPSHOT_FILE) continue;
      const buf = fs.readFileSync(abs);
      const hash = sha1(buf);
      const obj = this.objectPath(hash);
      if (!fs.existsSync(obj)) {
        await ensureDir(path.dirname(obj));
        await fsp.writeFile(obj, buf);
      }
      files[rel] = hash;
    }
    return files;
  }

  readObject(hash) {
    return fs.readFileSync(this.objectPath(hash));
  }

  changedFiles(prevFiles, files) {
    const changed = [];
    for (const [p, h] of Object.entries(files)) {
      if (!prevFiles || !(p in prevFiles)) changed.push({ path: p, change: 'added' });
      else if (prevFiles[p] !== h) changed.push({ path: p, change: 'modified' });
    }
    for (const p of Object.keys(prevFiles || {})) if (!(p in files)) changed.push({ path: p, change: 'deleted' });
    return changed;
  }

  async record(entry) {
    const prev = this.latest();
    const files = entry.files;
    const changed = this.changedFiles(prev ? prev.files : null, files);
    for (const c of changed) {
      if (c.change !== 'modified' || !TEXT_EXT.test(c.path)) continue;
      try {
        const s = diffStats(this.readObject(prev.files[c.path]).toString('utf8'), this.readObject(files[c.path]).toString('utf8'));
        c.added = s.added;
        c.removed = s.removed;
      } catch {
        // ignore
      }
    }
    const record = { ...entry, changed, parent: prev ? prev.id : null };
    this.data.builds.push(record);
    await this.save();
    return record;
  }

  async update(id, patch) {
    const b = this.get(id);
    Object.assign(b, patch);
    await this.save();
    return b;
  }

  fileAt(id, rel) {
    const b = this.get(id);
    const h = b.files[rel];
    if (!h) return null;
    return this.readObject(h);
  }

  diff(fromId, toId, onlyPath) {
    const a = this.get(fromId);
    const b = toId === 'working' ? { id: 'working', files: null } : this.get(toId);
    const bFiles = b.files || this.workingHashes();
    const paths = new Set([...Object.keys(a.files), ...Object.keys(bFiles)]);
    const out = [];
    for (const p of [...paths].sort()) {
      if (onlyPath && p !== onlyPath) continue;
      const ha = a.files[p];
      const hb = bFiles[p];
      if (ha === hb) continue;
      if (!TEXT_EXT.test(p)) {
        out.push({ path: p, change: !ha ? 'added' : !hb ? 'deleted' : 'modified', binary: true });
        continue;
      }
      const ta = ha ? this.readObject(ha).toString('utf8') : '';
      const tb = hb ? (b.files ? this.readObject(hb).toString('utf8') : fs.readFileSync(path.join(this.projectDir, p), 'utf8')) : '';
      out.push({
        path: p,
        change: !ha ? 'added' : !hb ? 'deleted' : 'modified',
        diff: unifiedDiff(ta, tb, { fromFile: `a/${p} (#${a.id})`, toFile: `b/${p} (${b.id === 'working' ? 'working tree' : `#${b.id}`})` }),
      });
    }
    return out;
  }

  workingHashes() {
    const files = {};
    for (const rel of walkFiles(this.projectDir)) {
      try {
        files[rel] = sha1(fs.readFileSync(path.join(this.projectDir, rel)));
      } catch {
        // skip
      }
    }
    return files;
  }

  // Restore the project files to the state captured by a build.
  async restore(id) {
    const b = this.get(id);
    const current = this.workingHashes();
    const written = [];
    const deleted = [];
    for (const [rel, hash] of Object.entries(b.files)) {
      if (current[rel] === hash) continue;
      const abs = path.join(this.projectDir, rel);
      await ensureDir(path.dirname(abs));
      await fsp.writeFile(abs, this.readObject(hash));
      written.push(rel);
    }
    for (const rel of Object.keys(current)) {
      if (rel in b.files) continue;
      await fsp.rm(path.join(this.projectDir, rel), { force: true });
      deleted.push(rel);
    }
    return { written, deleted };
  }

  summary(b) {
    if (!b) return null;
    return {
      id: b.id,
      time: b.time,
      success: b.success,
      duration_ms: b.duration_ms,
      errors: b.error_count,
      warnings: b.warning_count,
      note: b.note || null,
      notes: b.notes || [],
      changed: (b.changed || []).map((c) => (c.added != null ? `${c.path} (+${c.added} -${c.removed})` : `${c.path} (${c.change})`)),
      screenshot_url: b.screenshot ? `/studio-files/${b.screenshot}` : null,
      thumbnail_url: b.thumbnail ? `/studio-files/${b.thumbnail}` : null,
      score: b.score ?? null,
      reference: b.reference || null,
      restored_from: b.restored_from || null,
    };
  }
}
