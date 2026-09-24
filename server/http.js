// HTTP + WebSocket server: serves the Studio UI, preview runtime, build outputs
// and the operation API. Binds to localhost only (local-first).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { STUDIO_ROOT, WEB_DIR } from './config.js';
import { getOp, listOps, runOp } from './ops.js';
import { StudioError, log } from './util.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
};

const MONACO_DIR = path.join(STUDIO_ROOT, 'node_modules', 'monaco-editor', 'min');

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendFile(res, root, rel, { cache = false } = {}) {
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    res.writeHead(400);
    return res.end('bad path');
  }
  const abs = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': cache ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(abs).pipe(res);
  });
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new StudioError('too_large', 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sameOrigin(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') && Number(u.port || 80) === Number(port);
  } catch {
    return false;
  }
}

export function publicOpList() {
  return listOps().map((o) => ({ name: o.name, title: o.title, description: o.description, input: o.input, mcp: o.mcp }));
}

export function stripImages(result, inline) {
  if (!result || !result.images) return result;
  const images = result.images.map((im) => (inline ? im : { caption: im.caption }));
  return { ...result, images };
}

export function startHttpServer(studio, { port, host = '127.0.0.1' }) {
  const uiClients = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    try {
      if (req.method === 'GET') {
        if (p === '/' || p === '/index.html') return sendFile(res, WEB_DIR, 'index.html');
        if (p === '/preview.html') return sendFile(res, WEB_DIR, 'preview.html');
        if (p.startsWith('/css/') || p.startsWith('/js/') || p.startsWith('/img/')) return sendFile(res, WEB_DIR, p.slice(1));
        if (p.startsWith('/vendor/monaco/')) return sendFile(res, MONACO_DIR, p.slice('/vendor/monaco/'.length), { cache: true });
        if (p.startsWith('/builds/')) return sendFile(res, path.join(studio.studioDir, 'builds'), p.slice('/builds/'.length), { cache: true });
        if (p.startsWith('/studio-files/')) return sendFile(res, studio.studioDir, p.slice('/studio-files/'.length));
        if (p.startsWith('/project-files/')) return sendFile(res, studio.projectDir, p.slice('/project-files/'.length));
        if (p === '/api/health') return sendJson(res, 200, { ok: true, app: 'imgui-studio', project: studio.projectDir, name: studio.name, pid: process.pid });
        if (p === '/api/preview-config') return sendJson(res, 200, studio.previewConfig(url.searchParams.get('build')));
        if (p === '/api/ops') return sendJson(res, 200, { ops: publicOpList() });
        if (p === '/api/state') {
          return sendJson(res, 200, {
            ...studio.info(),
            history: studio.history.list().slice(-200).map((b) => studio.history.summary(b)),
            captures: studio.listCaptures(200),
            references: studio.referenceList(),
            activity: studio.opLog.slice(-200),
            runtime_errors: studio.hub.errors.slice(-100),
          });
        }
        if (p === '/api/history-file') {
          let buf = null;
          try {
            buf = studio.history.fileAt(Number(url.searchParams.get('build')), String(url.searchParams.get('path') || ''));
          } catch {
            buf = null;
          }
          if (!buf) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            return res.end('');
          }
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(buf);
        }
        if (p.startsWith('/api/build-log/')) {
          const id = Number(p.split('/').pop());
          return sendFile(res, path.join(studio.studioDir, 'builds'), `${id}.log`);
        }
        if (p === '/favicon.ico') {
          res.writeHead(204);
          return res.end();
        }
      }
      if (req.method === 'POST' && p.startsWith('/api/op/')) {
        if (!sameOrigin(req, port) || !req.headers['x-studio-client']) {
          return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'Cross-origin or unauthenticated request rejected' } });
        }
        const name = p.slice('/api/op/'.length);
        if (!getOp(name)) return sendJson(res, 404, { ok: false, error: { code: 'unknown_op', message: `Unknown operation ${name}` } });
        const body = await readBody(req);
        let args = {};
        if (body.length) {
          try {
            args = JSON.parse(body.toString('utf8'));
          } catch {
            return sendJson(res, 400, { ok: false, error: { code: 'bad_json', message: 'Body must be JSON' } });
          }
        }
        const source = String(req.headers['x-studio-client']).slice(0, 32);
        try {
          const result = await runOp(studio, name, args, { source });
          return sendJson(res, 200, { ok: true, result: stripImages(result, url.searchParams.get('images') === '1') });
        } catch (e) {
          if (!(e instanceof StudioError) && !e.code) log(`op ${name} failed:`, e.stack || e.message);
          return sendJson(res, 200, { ok: false, error: { code: e.code || 'error', message: e.message, details: e.details } });
        }
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      log('http error', e.stack || e.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: e.message } });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws' || !sameOrigin(req, port)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const kind = url.searchParams.get('kind');
      if (kind === 'runtime') {
        studio.hub.attach(ws, { role: url.searchParams.get('role'), build: url.searchParams.get('build') });
      } else {
        uiClients.add(ws);
        ws.on('close', () => uiClients.delete(ws));
        ws.on('error', () => {});
        ws.send(JSON.stringify({ type: 'hello', data: { name: studio.name, settings: studio.settings } }));
      }
    });
  });

  const forward = [
    'build_started', 'build_output', 'build_finished', 'history_updated', 'files_changed', 'runtime_status', 'runtime_error',
    'runtime_log', 'op_log', 'capture_added', 'reference_updated', 'preview_reload', 'settings',
  ];
  for (const evt of forward) {
    studio.on(evt, (data) => {
      const msg = JSON.stringify({ type: evt, data });
      for (const ws of uiClients) {
        if (ws.readyState === 1) ws.send(msg);
      }
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ server, wss, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}` });
    });
  });
}
