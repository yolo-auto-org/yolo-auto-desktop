#!/usr/bin/env node
/* Real Electron fixture: the browser-tool guard is installed only on one isolated BrowserWindow session. */

const http = require('node:http');
const { app, BrowserWindow, session } = require('electron');
const { __testing } = require('../src/main/pi-sdk-session-manager');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();

  const server = http.createServer((req, res) => {
    if (req.url === '/track') {
      server.hits += 1;
      res.writeHead(200, { 'content-type': 'image/gif' });
      res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>ok</title>');
  });
  server.hits = 0;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = server.address().port;
  const pageUrl = 'data:text/html;charset=utf-8,<!doctype html><title>guard fixture</title>';
  const requestPrivateUrl = async (win) => {
    await win.webContents.executeJavaScript(`fetch(${JSON.stringify(`http://127.0.0.1:${port}/track?${Date.now()}`)}, { mode: 'no-cors' }).catch(() => {})`, true);
  };
  const logs = [];
  let unguarded;
  let guarded;

  try {
    // Control: an unrelated BrowserWindow/session is not guarded globally.
    unguarded = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `yolo-auto-unguarded-control-${Date.now()}`
      }
    });
    await unguarded.loadURL(pageUrl);
    await requestPrivateUrl(unguarded);
    await wait(750);
    const unguardedHits = server.hits;

    server.hits = 0;
    guarded = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `yolo-auto-browser-guarded-${Date.now()}`
      }
    });
    __testing.hardenBrowserToolWindow(guarded, (level, message, meta = {}) => logs.push({ level, message, meta }));
    await guarded.loadURL(pageUrl);
    await requestPrivateUrl(guarded);
    await wait(1250);

    const result = {
      defaultSessionGuarded: !!session.defaultSession.__yoloAutoWebGuardInstalled,
      unguardedHits,
      guardedHits: server.hits,
      guardedSessionGuarded: !!guarded.webContents.session.__yoloAutoWebGuardInstalled,
      blockedLogCount: logs.filter((entry) => entry.message === 'web-guard:browser-blocked').length
    };

    process.stdout.write(`YOLO_ELECTRON_BROWSER_GUARD_RESULT ${JSON.stringify(result)}\n`);
  } finally {
    try { if (unguarded && !unguarded.isDestroyed()) unguarded.destroy(); } catch {}
    try { if (guarded && !guarded.isDestroyed()) guarded.destroy(); } catch {}
    await new Promise((resolve) => server.close(resolve));
    app.quit();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  app.quit();
  process.exit(1);
});
