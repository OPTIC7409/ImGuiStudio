// Start (or find) the Studio server for a project. Shared by the CLI, the MCP
// adapter and the design agent runner.
import path from 'node:path';
import { DEFAULT_PORT } from './config.js';
import { Studio } from './studio.js';
import { startHttpServer } from './http.js';

export async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return body && body.app === 'imgui-studio' ? body : { foreign: true };
  } catch {
    return null;
  }
}

// Returns { reuse: url, port } when a Studio for the same project is already
// running, otherwise { studio, srv, port } for a freshly started one.
export async function startStudio(projectDir, { port = DEFAULT_PORT, host = '127.0.0.1', headless = true } = {}) {
  let p = Number(port);
  for (let attempt = 0; attempt < 20; attempt++, p++) {
    const existing = await probe(p);
    if (existing && !existing.foreign && path.resolve(existing.project) === path.resolve(projectDir)) return { reuse: `http://127.0.0.1:${p}`, port: p };
    if (existing) continue;
    const studio = new Studio({ projectDir, port: p });
    await studio.init();
    if (!headless) studio.settings.headless = false;
    try {
      const srv = await startHttpServer(studio, { port: p, host });
      return { studio, srv, port: p };
    } catch (e) {
      await studio.shutdown();
      if (e.code === 'EADDRINUSE') continue;
      throw e;
    }
  }
  throw new Error('No free port found');
}
