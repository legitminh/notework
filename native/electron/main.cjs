// Electron shell for the Notework web build (macOS, Windows, Linux).
//
// The window loads the same static build the PWA ships, served from a private
// `notework://app/` origin. That origin is standard and secure, so OPFS,
// IndexedDB, the File System Access API and the service worker behave as they
// do in Chrome. The protocol serves only files inside the bundled web build:
// there is no IPC, preload or Node access, and nothing exposes the host
// filesystem. Machine folders still go through the browser folder picker.
const { app, BrowserWindow, Menu, net, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'notework';
const ORIGIN = `${SCHEME}://app`;

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: true, corsEnabled: true, stream: true, codeCache: true }
}]);

/** The static SvelteKit build: bundled in the app, or `../build` while developing. */
const webRoot = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '..', '..', 'build');

const types = { '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.mjs': 'text/javascript' };

function resolveFile(pathname) {
  let relative;
  try { relative = decodeURIComponent(pathname); } catch { return null; }
  const file = path.resolve(webRoot, `.${relative}`);
  if (file !== webRoot && !file.startsWith(webRoot + path.sep)) return null;
  for (const candidate of [file, path.join(file, 'index.html'), `${file}.html`]) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try the next form */ }
  }
  return null;
}

async function serve(request) {
  const url = new URL(request.url);
  if (url.host !== 'app') return new Response('not found', { status: 404 });
  // Unknown paths fall back to the app shell, like the service worker does for navigations.
  const file = resolveFile(url.pathname) ?? (request.headers.get('accept')?.includes('text/html') ? path.join(webRoot, 'index.html') : null);
  if (!file) return new Response('not found', { status: 404 });
  const response = await net.fetch(pathToFileURL(file).toString());
  const type = types[path.extname(file)];
  if (!type) return response;
  const headers = new Headers(response.headers);
  headers.set('content-type', type);
  return new Response(response.body, { status: response.status, headers });
}

function isExternal(target) {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(target).protocol); } catch { return false; }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 360,
    title: 'Notework',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
  });
  window.once('ready-to-show', () => window.show());
  // Links such as GitHub token pages open in the system browser, never inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${ORIGIN}/`)) return;
    event.preventDefault();
    if (isExternal(url)) void shell.openExternal(url);
  });
  void window.loadURL(`${ORIGIN}/`);
  return window;
}

/**
 * macOS needs an Edit menu for Cmd+C/V/X/A. Undo and redo are left to the editor so
 * its own history handles them. Windows and Linux get no menu, so Ctrl shortcuts
 * (Vim's Ctrl+R, Ctrl+W, and Notework's own) reach the page untouched.
 */
function installMenu() {
  if (process.platform !== 'darwin') return Menu.setApplicationMenu(null);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { label: 'Developer Tools', click: (_, window) => window?.webContents.toggleDevTools() }] },
    { role: 'windowMenu' }
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(() => {
    protocol.handle(SCHEME, serve);
    installMenu();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
