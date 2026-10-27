// MCP proxy: forwards stdio JSON-RPC to a Computer Use server and drives the
// top-of-screen pill from tools/call traffic. Must never write to stdout.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// stdout is the JSON-RPC channel: every diagnostic line must go to stderr.
const log = (...parts) => process.stderr.write(`[cua-pill] ${parts.join(' ')}\n`);

// The Computer Use server binary is NOT bundled with this package. Supply your
// own copy via CUA_SERVER, or drop it at bin/<CUA_SERVER_NAME>.
const SERVER_NAME = process.env.CUA_SERVER_NAME || 'cua-server.exe';
const SERVER_CANDIDATES = [
  process.env.CUA_SERVER,
  join(HERE, 'bin', SERVER_NAME),
  // Interoperability fallback: some IDEs ship their own Computer Use backend
  // inside their install tree. We only *detect* an already-installed copy on
  // the user's machine — nothing is bundled, mirrored, or redistributed here.
  join(homedir(), '.qoder', 'bin', 'qoder-computer-use', 'QoderComputerUse.exe'),
].filter(Boolean);

// An explicitly configured backend must exist. Silently falling back to a
// different binary would run something the user never asked for.
if (process.env.CUA_SERVER && !existsSync(process.env.CUA_SERVER)) {
  log(`CUA_SERVER does not exist: ${process.env.CUA_SERVER}`);
  process.exit(1);
}

const SERVER_EXE = SERVER_CANDIDATES.find(candidate => existsSync(candidate)) ?? SERVER_CANDIDATES[0];

const LABEL = process.env.CUA_LABEL || 'AI 正在操控电脑';
// `|| 6000` would swallow a legitimate 0 (hide immediately) and a typo would
// become NaN — setTimeout(NaN) fires at once. Treat blank / non-numeric as unset.
const num = (value, fallback) => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const GRACE_MS = num(process.env.CUA_GRACE_MS, 6000);
const WATCHDOG_MS = num(process.env.CUA_WATCHDOG_MS, 180000);
const PILL_DISABLED = process.env.CUA_PILL === '0';

// The plugin runs from the package store, while the pnpm-linked profile copy
// ships without an electron dependency of its own. Resolve the runtime from the
// first candidate that exists so a pill started from either copy still finds it.
const ELECTRON_CANDIDATES = [
  join(HERE, 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(homedir(), '.dsh', 'plugin-packages', 'dsh-cua-pill', 'node_modules', 'electron', 'dist', 'electron.exe'),
];
const ELECTRON_EXE = ELECTRON_CANDIDATES.find(candidate => existsSync(candidate)) ?? ELECTRON_CANDIDATES[0];

const TOOL_TEXT = {
  list_apps: '正在扫描应用',
  list_windows: '正在扫描窗口',
  get_window: '正在读取窗口',
  launch_app: '正在启动应用',
  activate_window: '正在切换窗口',
  get_window_state: '正在读取屏幕',
  click: '正在点击',
  drag: '正在拖拽',
  scroll: '正在滚动',
  press_key: '正在按键',
  type_text: '正在输入',
  set_value: '正在填值',
  perform_secondary_action: '正在操作控件',
  run_steps: '正在执行操作序列',
};

// ── pill ──────────────────────────────────────────────────────────────────
// The window talks back over loopback: Electron's stdin is already closed by
// the time the GUI process starts on Windows.
class Pill {
  constructor() {
    this.server = null;
    this.socket = null;
    this.child = null;
    this.starting = false;
    this.visible = false;
    this.hideTimer = null;
    this.queued = [];
    this.token = randomBytes(16).toString('hex');
  }

  async start() {
    if (PILL_DISABLED || this.starting || this.child) return;
    if (!existsSync(ELECTRON_EXE)) {
      log(`pill runtime missing: ${ELECTRON_EXE} — run "npm install" first`);
      return;
    }
    this.starting = true;

    this.server = net.createServer(socket => this.attach(socket));
    this.server.on('error', error => log(`pill channel error: ${error.message}`));
    // Without a reject path a failed listen() would leave `starting` stuck at
    // true forever, so the pill could never be retried for the rest of the run.
    try {
      await new Promise((resolve, reject) => {
        const onListenError = error => {
          this.server?.off('error', onListenError);
          reject(error);
        };
        this.server.once('error', onListenError);
        this.server.listen(0, '127.0.0.1', () => {
          this.server?.off('error', onListenError);
          resolve();
        });
      });
    } catch (error) {
      log(`pill channel bind failed: ${error.message}`);
      this.server?.close();
      this.server = null;
      this.starting = false;
      return;
    }
    const { port } = this.server.address();

    const env = {
      ...process.env,
      CUA_LABEL: LABEL,
      CUA_PILL_PORT: String(port),
      CUA_PILL_TOKEN: this.token,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    };
    // Inherited node-mode flag would turn the pill into a headless node script.
    delete env.ELECTRON_RUN_AS_NODE;

    // Electron must boot the pill entry script. Passing HERE made Electron read
    // HERE/package.json (main: proxy.mjs), so it restarted the proxy with ignored
    // stdin and exited at once — the pill window never appeared.
    const pillApp = join(HERE, 'pill', 'main.mjs');
    if (!existsSync(pillApp)) {
      log(`pill entry missing: ${pillApp}`);
      this.starting = false;
      this.server?.close();
      this.server = null;
      return;
    }
    // A piped stderr is drained here instead of inherited: the pill may outlive
    // this proxy, and an inherited or ignored handle is what produced the
    // "EPIPE: broken pipe" crash dialog inside Electron.
    let child;
    try {
      child = spawn(ELECTRON_EXE, [pillApp], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env,
      });
    } catch (error) {
      log(`pill spawn failed: ${error.message}`);
      this.starting = false;
      this.server?.close();
      this.server = null;
      return;
    }
    this.child = child;
    this.starting = false;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('error', () => {});
    child.stderr?.on('data', chunk => {
      if (process.env.CUA_PILL_DEBUG !== '1') return;
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) log(`pill: ${line}`);
    });
    child.on('error', error => log(`pill spawn failed: ${error.message}`));
    child.on('exit', code => {
      log(`pill exited (${code})`);
      if (this.child !== child) return;
      // A crashed pill must not silence later tool calls: allow a fresh start.
      this.child = null;
      this.socket = null;
      this.visible = false;
      this.server?.close();
      this.server = null;
    });
  }

  attach(socket) {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.once('data', chunk => {
      if (chunk.trim() !== this.token) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
      });
      for (const message of this.queued.splice(0)) this.write(message);
    });
  }

  write(message) {
    this.socket?.write(`${JSON.stringify(message)}\n`);
  }

  send(message) {
    if (this.socket) {
      this.write(message);
    } else if (this.queued.length < 32) {
      this.queued.push(message);
    }
  }

  show(detail) {
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
    // Lazy start keeps a hidden Electron off the session until control is used.
    if (!this.child) this.start();
    this.send({ type: 'show', label: LABEL, detail });
    this.visible = true;
  }

  update(detail) {
    if (!this.visible) return this.show(detail);
    this.send({ type: 'update', detail });
  }

  hide() {
    if (!this.visible || this.hideTimer) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.visible = false;
      this.send({ type: 'hide' });
    }, GRACE_MS);
  }

  quit() {
    this.send({ type: 'quit' });
    this.socket?.end();
    this.server?.close();
    const child = this.child;
    this.child = null;
    if (!child) return;
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 900).unref();
  }
}

const pill = new Pill();

// ── server ────────────────────────────────────────────────────────────────
if (!existsSync(SERVER_EXE)) {
  log('Computer Use server not found.');
  log('Set CUA_SERVER to the absolute path of the server executable,');
  log(`or place it at ${join(HERE, 'bin', SERVER_NAME)}`);
  log('See README.md → "Backend" for details.');
  process.exit(1);
}

const server = spawn(SERVER_EXE, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  // Read by the backend itself to suppress its own overlay — we draw ours.
  // Kept verbatim: it is an interface contract, not a branding choice.
  env: { ...process.env, QODER_CUA_OPERATION_OVERLAY: '0' },
});

server.stderr.on('data', chunk => process.stderr.write(chunk));
server.on('error', error => {
  log(`server spawn failed: ${error.message}`);
  shutdown(1);
});
server.on('exit', code => {
  log(`server exited (${code})`);
  pill.quit();
  process.exit(code ?? 0);
});

// ── traffic ───────────────────────────────────────────────────────────────
const inFlight = new Map();
const buffers = { client: '', server: '' };

function eachMessage(side, chunk, onMessage) {
  buffers[side] += chunk.toString('utf8');
  if (buffers[side].length > 8 * 1024 * 1024) buffers[side] = '';
  let index;
  while ((index = buffers[side].indexOf('\n')) !== -1) {
    const line = buffers[side].slice(0, index).trim();
    buffers[side] = buffers[side].slice(index + 1);
    if (!line) continue;
    try {
      onMessage(JSON.parse(line));
    } catch {
      // Not a JSON-RPC line; the raw bytes were already forwarded.
    }
  }
}

function describe(params) {
  const name = params?.name ?? '';
  const args = params?.arguments ?? {};
  const action = TOOL_TEXT[name] ?? `正在调用 ${name}`;
  const title = args.window?.title ?? args.target?.window_title_filter ?? args.target?.app_filter;
  return title ? `${action} · ${title}` : action;
}

function onClientMessage(message) {
  if (message.method !== 'tools/call' || message.id === undefined) return;
  const id = String(message.id);
  inFlight.set(id, setTimeout(() => inFlight.delete(id), WATCHDOG_MS).unref());
  const detail = describe(message.params);
  pill.visible && inFlight.size > 1 ? pill.update(detail) : pill.show(detail);
}

function onServerMessage(message) {
  if (message.id === undefined) return;
  const id = String(message.id);
  const timer = inFlight.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  inFlight.delete(id);
  if (inFlight.size === 0) pill.hide();
}

process.stdin.on('data', chunk => {
  try {
    server.stdin.write(chunk);
  } catch {
    // Backend died mid-write; its exit handler takes over from here.
    return shutdown(0);
  }
  eachMessage('client', chunk, onClientMessage);
});
process.stdin.on('end', () => shutdown(0));
process.stdin.on('error', () => shutdown(0));
// A closed stdout means the client is gone; nothing left to serve.
process.stdout.on('error', () => shutdown(0));

server.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  eachMessage('server', chunk, onServerMessage);
});

function shutdown(code) {
  pill.quit();
  try {
    server.stdin.end();
  } catch {}
  setTimeout(() => {
    server.kill();
    process.exit(code);
  }, 300).unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown(0));
}
