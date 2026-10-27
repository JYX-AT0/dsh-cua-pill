import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM resolves the bare specifier to the npm package; only require() reaches
// Electron's built-in module.
const { app, BrowserWindow, ipcMain, screen } = createRequire(import.meta.url)('electron');

const HERE = dirname(fileURLToPath(import.meta.url));
const LABEL = process.env.CUA_LABEL || 'AI 正在操控电脑';
const PORT = Number(process.env.CUA_PILL_PORT || 0);
const TOKEN = process.env.CUA_PILL_TOKEN || '';

// Electron outlives the proxy that spawned it, so a closed stderr pipe must never
// surface as an uncaught EPIPE crash dialog on the user's desktop.
const log = (...parts) => {
  try {
    process.stderr.write(`[pill ${new Date().toISOString().slice(11, 23)}] ${parts.join(' ')}\n`);
  } catch {
    // logging is best-effort; the pill keeps working with no stderr reader
  }
};

process.stderr.on('error', () => {});
process.stdout.on('error', () => {});
process.on('uncaughtException', error => {
  const code = error?.code;
  if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') return;
  log('uncaught', error?.stack || String(error));
});

let win = null;
let ready = false;
let lastCommand = 'hide';
let socket = null;
const queued = [];

function bounds() {
  // Full work area: the capsule is centered by CSS, so the pill stays put no
  // matter how Electron maps window bounds onto a scaled display.
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x, y: area.y, width: area.width, height: area.height };
}

function deliver(message) {
  if (!ready) {
    queued.push(message);
    return;
  }
  try {
    win?.webContents.send('pill', message);
  } catch (error) {
    log('send failed', error?.message || String(error));
  }
}

function createWindow() {
  win = new BrowserWindow({
    ...bounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: join(HERE, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setMenu(null);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(join(HERE, 'index.html'));

  win.webContents.on('did-finish-load', () => {
    ready = true;
    deliver({ type: 'label', label: LABEL });
    for (const message of queued.splice(0)) deliver(message);
    log('loaded');
  });

  win.webContents.on('preload-error', (_event, path, error) => log('preload-error', path, error.message));
  win.webContents.on('console-message', (_event, ...args) => {
    log('console', args.map(value => (typeof value === 'object' ? JSON.stringify(value) : value)).join(' '));
  });

  win.on('show', () => log('show', JSON.stringify(win.getBounds())));
  win.on('hide', () => log('hide'));
  win.on('closed', () => {
    win = null;
    ready = false;
    log('closed');
  });
}

function showWindow() {
  if (!win) createWindow();
  win.setBounds(bounds());
  win.setAlwaysOnTop(true, 'screen-saver');
  win.showInactive();
}

function reposition() {
  if (!win || !win.isVisible()) return;
  win.setBounds(bounds());
}

ipcMain.on('pill-hidden', () => {
  if (lastCommand === 'hide') win?.hide();
});

const commands = {
  show(message) {
    lastCommand = 'show';
    showWindow();
    deliver({ type: 'show', label: message.label || LABEL, detail: message.detail || '' });
  },
  update(message) {
    deliver({ type: 'update', detail: message.detail || '' });
  },
  hide() {
    lastCommand = 'hide';
    deliver({ type: 'hide' });
  },
  quit() {
    log('quit command');
    app.quit();
  },
};

function dispatch(line) {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  commands[message?.type]?.(message);
}

function connect() {
  if (!PORT) {
    log('no port configured');
    app.quit();
    return;
  }
  socket = net.connect({ port: PORT, host: '127.0.0.1' }, () => {
    log('channel open');
    socket.write(`${TOKEN}\n`);
  });
  socket.setEncoding('utf8');
  socket.on('error', error => log('channel error', error.message));
  socket.on('close', () => {
    log('channel closed');
    app.quit();
  });

  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      dispatch(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
}

app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea;
  log(`display workArea=${area.x},${area.y} ${area.width}x${area.height} scale=${screen.getPrimaryDisplay().scaleFactor}`);
  createWindow();
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
  connect();
});

app.on('window-all-closed', () => app.quit());
