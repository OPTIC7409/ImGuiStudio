// Headless Chromium that hosts the deterministic agent preview.
//
// Agents need to see and drive the UI even when no human has the Studio open,
// so the server keeps one headless page (role=agent) loaded with the latest
// build. WebGL2 is rendered with SwiftShader so captures are identical on any
// machine, independent of the GPU.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './util.js';

function findBrowser() {
  const env = process.env.IMGUI_STUDIO_BROWSER;
  if (env && fs.existsSync(env)) return env;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'), path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')].filter(Boolean);
  const rel = [
    ['chrome-linux64', 'chrome'],
    ['chrome-linux', 'chrome'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-win', 'chrome.exe'],
    ['chrome-win64', 'chrome.exe'],
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const r of rel) {
        const p = path.join(root, d, ...r);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  const system = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return system.find((p) => fs.existsSync(p)) || null;
}

export class HeadlessRunner {
  constructor({ baseUrl, hub }) {
    this.baseUrl = baseUrl;
    this.hub = hub;
    this.browser = null;
    this.page = null;
    this.available = null;
    this.reason = null;
    this.build = null;
    this.viewport = null;
    this.starting = null;
  }

  async ensure() {
    if (this.page && !this.page.isClosed()) return true;
    if (this.available === false) return false;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      let pw;
      try {
        pw = await import('playwright-core');
      } catch {
        this.available = false;
        this.reason = 'playwright-core is not installed (npm install playwright-core)';
        log(`headless preview disabled: ${this.reason}`);
        return false;
      }
      const executablePath = findBrowser();
      const opts = {
        headless: true,
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
      };
      if (executablePath) opts.executablePath = executablePath;
      try {
        this.browser = await pw.chromium.launch(opts);
      } catch (e) {
        this.available = false;
        this.reason = `could not launch Chromium (${e.message.split('\n')[0]}). Set IMGUI_STUDIO_BROWSER to a Chrome/Chromium executable.`;
        log(`headless preview disabled: ${this.reason}`);
        return false;
      }
      this.browser.on('disconnected', () => {
        this.browser = null;
        this.page = null;
      });
      const context = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
      this.page = await context.newPage();
      this.page.on('pageerror', (e) => log('agent preview page error:', e.message));
      this.page.on('console', (m) => {
        if (m.type() === 'error' && !/favicon/.test(m.text())) log('agent preview console:', m.text());
      });
      this.available = true;
      log(`headless agent preview ready (${executablePath || 'playwright default chromium'})`);
      return true;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  // Load a build in the agent preview and wait until AppInit() finished and the first frames ran.
  async load(build, viewport, { timeout = 30000 } = {}) {
    if (!(await this.ensure())) return { ok: false, reason: this.reason };
    const vp = viewport || { width: 1280, height: 800 };
    if (!this.viewport || this.viewport.width !== vp.width || this.viewport.height !== vp.height) {
      await this.page.setViewportSize({ width: vp.width, height: vp.height });
      this.viewport = vp;
    }
    this.hub.invalidate('agent');
    const wait = this.hub.waitForReady({ role: 'agent', build, timeout });
    this.build = build;
    const url = `${this.baseUrl}/preview.html?role=agent&build=${build}&zoom=1`;
    try {
      await this.page.goto(url, { waitUntil: 'load', timeout });
    } catch (e) {
      return { ok: false, reason: `navigation failed: ${e.message}` };
    }
    const r = await wait;
    if (r.timeout) return { ok: false, reason: 'the agent preview did not become ready in time' };
    return { ok: !r.crashed, crashed: !!r.crashed };
  }

  async close() {
    try {
      await this.browser?.close();
    } catch {
      // ignore
    }
    this.browser = null;
    this.page = null;
  }
}
