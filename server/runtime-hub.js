// Tracks connected preview runtimes (headless agent preview + visible Studio
// previews) and routes RPC calls to them over WebSocket.
import { Emitter, StudioError, log } from './util.js';

let nextRuntimeId = 1;
let nextCallId = 1;

export class RuntimeHub extends Emitter {
  constructor() {
    super();
    this.runtimes = new Map();
    this.errors = []; // recent runtime errors across runtimes
    this.logs = [];
  }

  attach(ws, { role, build }) {
    const rt = {
      id: nextRuntimeId++,
      ws,
      role: role === 'agent' ? 'agent' : 'studio',
      build: build && build !== 'latest' ? Number(build) : null,
      ready: false,
      crashed: false,
      info: null,
      pending: new Map(),
      connectedAt: Date.now(),
    };
    this.runtimes.set(rt.id, rt);
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.onMessage(rt, msg);
    });
    ws.on('close', () => {
      this.runtimes.delete(rt.id);
      for (const p of rt.pending.values()) p.reject(new StudioError('runtime_disconnected', 'The preview runtime disconnected (page reloaded or closed)'));
      rt.pending.clear();
      this.emit('runtime_status', this.status());
    });
    this.emit('runtime_status', this.status());
    return rt;
  }

  onMessage(rt, msg) {
    if (msg.type === 'hello') {
      rt.build = msg.build ?? rt.build;
      rt.ready = !!msg.ready;
      rt.crashed = !!msg.crashed;
      rt.embedded = !!msg.embedded;
      this.emit('runtime_status', this.status());
    } else if (msg.type === 'rpc_result') {
      const p = rt.pending.get(msg.id);
      if (!p) return;
      rt.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new StudioError(msg.error?.code || 'runtime_error', msg.error?.message || 'Runtime call failed', msg.error?.details));
    } else if (msg.type === 'event') {
      const data = msg.data || {};
      if (msg.name === 'ready') {
        rt.ready = true;
        rt.crashed = false;
        rt.info = data;
        rt.build = data.build_id ?? rt.build;
        this.emit('runtime_ready', { runtime: this.describe(rt), info: data });
        this.emit('runtime_status', this.status());
      } else if (msg.name === 'runtime_error') {
        const err = { ...data, role: rt.role, runtime: rt.id };
        if (data.kind === 'crash') {
          rt.crashed = true;
          rt.ready = false;
          this.emit('runtime_status', this.status());
        }
        this.errors.push(err);
        if (this.errors.length > 300) this.errors.shift();
        this.emit('runtime_error', err);
      } else if (msg.name === 'runtime_log') {
        const entry = { ...data, role: rt.role, runtime: rt.id };
        this.logs.push(entry);
        if (this.logs.length > 500) this.logs.shift();
        this.emit('runtime_log', entry);
      }
    }
  }

  describe(rt) {
    return { id: rt.id, role: rt.role, build: rt.build, ready: rt.ready, crashed: rt.crashed, embedded: !!rt.embedded };
  }

  status() {
    return [...this.runtimes.values()].map((rt) => this.describe(rt));
  }

  // Pick the runtime agent commands should go to.
  pick({ role = null, target = 'auto' } = {}) {
    const all = [...this.runtimes.values()].filter((r) => r.ws.readyState === 1 && !r.stale);
    const byRole = (r) => all.filter((x) => x.role === r).sort((a, b) => b.connectedAt - a.connectedAt);
    let order;
    if (role) order = byRole(role);
    else if (target === 'studio') order = [...byRole('studio'), ...byRole('agent')];
    else order = [...byRole('agent'), ...byRole('studio')];
    return order.find((r) => r.ready) || order[0] || null;
  }

  call(rt, method, params = {}, { timeout = 60000 } = {}) {
    if (!rt) throw new StudioError('no_runtime', 'No preview runtime is connected');
    const id = nextCallId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        rt.pending.delete(id);
        reject(new StudioError('runtime_timeout', `Runtime call "${method}" timed out after ${timeout} ms`));
      }, timeout);
      rt.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        rt.ws.send(JSON.stringify({ type: 'rpc', id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        rt.pending.delete(id);
        reject(new StudioError('runtime_disconnected', e.message));
      }
    });
  }

  // Mark every runtime of a role as stale (e.g. right before its page navigates away).
  invalidate(role) {
    for (const rt of this.runtimes.values()) {
      if (rt.role !== role) continue;
      rt.ready = false;
      rt.stale = true;
    }
  }

  // Resolve when a runtime with the given role reports ready for the given build (or crashes).
  waitForReady({ role, build, timeout = 30000 }) {
    const existing = [...this.runtimes.values()].find((r) => r.role === role && r.build === build && !r.stale && (r.ready || r.crashed));
    if (existing) return Promise.resolve({ runtime: existing, crashed: existing.crashed });
    return new Promise((resolve) => {
      const offReady = this.on('runtime_ready', ({ runtime }) => {
        if (runtime.role === role && runtime.build === build) done({ runtime: this.runtimes.get(runtime.id), crashed: false });
      });
      const offErr = this.on('runtime_error', (err) => {
        if (err.role === role && err.build === build && err.kind === 'crash') done({ runtime: this.runtimes.get(err.runtime), crashed: true });
      });
      const timer = setTimeout(() => done({ runtime: null, timeout: true }), timeout);
      function done(v) {
        clearTimeout(timer);
        offReady();
        offErr();
        resolve(v);
      }
    });
  }

  broadcast(msg, { role = null } = {}) {
    for (const rt of this.runtimes.values()) {
      if (role && rt.role !== role) continue;
      try {
        rt.ws.send(JSON.stringify(msg));
      } catch (e) {
        log('broadcast failed', e.message);
      }
    }
  }

  errorsForBuild(build) {
    return this.errors.filter((e) => e.build === build);
  }
}
