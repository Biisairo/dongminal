/**
 * RemoteTerminal — WebSocket + xterm.js bridge
 *
 * Protocol (binary WebSocket):
 *   Client → Server:
 *     [0x00] + data                → terminal input (UTF-8)
 *     [0x01] + cols(u16) + rows(u16) → resize
 *
 *   Server → Client:
 *     [0x00] + data                → terminal output (raw)
 *     [0x01] + message             → error (UTF-8)
 *     [0x02]                       → process exited
 */

const OP_INPUT  = 0x00;
const OP_RESIZE = 0x01;
const OP_OUTPUT = 0x00;
const OP_ERROR  = 0x01;
const OP_EXIT   = 0x02;

class RemoteTerminal {
  constructor() {
    this.container = document.getElementById('terminal-container');
    this.overlay   = document.getElementById('overlay');
    this.overlayMsg = document.getElementById('overlay-message');
    this.reconnectBtn = document.getElementById('reconnect-btn');

    this.ws = null;
    this.term = null;
    this.fitAddon = null;
    this.reconnectDelay = 1000;
    this.disposed = false;
  }

  // ── Lifecycle ─────────────────────────────────────

  start() {
    this.initTerminal();
    this.fit();
    this.connect();
    this.bindGlobalEvents();
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('resize', this._resizeHandler);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.term) {
      this.term.dispose();
      this.term = null;
    }
  }

  // ── Terminal Init ─────────────────────────────────

  initTerminal() {
    this.term = new Terminal({
      scrollback: 50000,
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      lineHeight: 1.2,
      fontFamily: "'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', monospace",
      allowProposedApi: true,
      allowTransparency: false,
      fastScrollModifier: 'alt',
      fastScrollSensitivity: 5,
      // Tokyo Night theme
      theme: {
        background:           '#1a1b26',
        foreground:           '#a9b1d6',
        cursor:               '#c0caf5',
        cursorAccent:         '#1a1b26',
        selectionBackground:  '#33467c',
        selectionForeground:  '#c0caf5',
        black:                '#15161e',
        red:                  '#f7768e',
        green:                '#9ece6a',
        yellow:               '#e0af68',
        blue:                 '#7aa2f7',
        magenta:              '#bb9af7',
        cyan:                 '#7dcfff',
        white:                '#a9b1d6',
        brightBlack:          '#414868',
        brightRed:            '#f7768e',
        brightGreen:          '#9ece6a',
        brightYellow:         '#e0af68',
        brightBlue:           '#7aa2f7',
        brightMagenta:        '#bb9af7',
        brightCyan:           '#7dcfff',
        brightWhite:          '#c0caf5',
      },
    });

    // Addons
    this.fitAddon = new FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);

    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    this.term.loadAddon(webLinksAddon);

    const unicode11Addon = new Unicode11Addon.Unicode11Addon();
    this.term.loadAddon(unicode11Addon);
    this.term.unicode.activeVersion = '11';

    this.term.open(this.container);

    // Input → WebSocket
    this.term.onData((data) => {
      this.sendInput(data);
    });

    // Resize → Server
    this.term.onResize(({ cols, rows }) => {
      this.sendResize(cols, rows);
    });
  }

  // ── WebSocket ─────────────────────────────────────

  connect() {
    this.showOverlay('Connecting...');

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const cols = this.term ? this.term.cols : 120;
    const rows = this.term ? this.term.rows : 40;
    const url = `${proto}//${location.host}/ws?cols=${cols}&rows=${rows}`;

    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      log('connected');
      this.hideOverlay();
      this.reconnectDelay = 1000;
      // Sync size after connect (in case of reconnection with different viewport)
      this.fit();
    };

    this.ws.onmessage = (event) => {
      const data = new Uint8Array(event.data);
      if (data.length === 0) return;

      const op = data[0];
      const payload = data.slice(1);

      switch (op) {
        case OP_OUTPUT:
          this.term.write(payload);
          break;
        case OP_ERROR:
          const msg = new TextDecoder().decode(payload);
          log('server error: ' + msg);
          break;
        case OP_EXIT:
          this.handleExit();
          break;
      }
    };

    this.ws.onclose = (event) => {
      log('disconnected: code=' + event.code);
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event) => {
      log('ws error');
    };
  }

  // ── Send Helpers ──────────────────────────────────

  sendInput(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const encoded = new TextEncoder().encode(data);
    const msg = new Uint8Array(1 + encoded.length);
    msg[0] = OP_INPUT;
    msg.set(encoded, 1);
    this.ws.send(msg);
  }

  sendResize(cols, rows) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = new Uint8Array(5);
    msg[0] = OP_RESIZE;
    const dv = new DataView(msg.buffer);
    dv.setUint16(1, cols, false);  // big-endian
    dv.setUint16(3, rows, false);
    this.ws.send(msg);
  }

  // ── Fit & Resize ──────────────────────────────────

  fit() {
    if (!this.fitAddon) return;
    try {
      this.fitAddon.fit();
    } catch (e) {
      // ignore fit errors during init
    }
  }

  bindGlobalEvents() {
    this._resizeHandler = () => {
      this.fit();
    };
    window.addEventListener('resize', this._resizeHandler);

    // Prevent accidental page leave
    window.addEventListener('beforeunload', (e) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // ── Exit & Reconnect ──────────────────────────────

  handleExit() {
    log('process exited');
    this.ws.close();
    this.showOverlay('Process exited.');
    this.reconnectBtn.classList.remove('hidden');
  }

  scheduleReconnect() {
    this.showOverlay(`Disconnected. Reconnecting in ${Math.round(this.reconnectDelay / 1000)}s...`);
    this.reconnectBtn.classList.remove('hidden');

    setTimeout(() => {
      if (!this.disposed) {
        this.reconnectBtn.classList.add('hidden');
        this.connect();
      }
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  // ── Overlay UI ────────────────────────────────────

  showOverlay(message) {
    this.overlayMsg.textContent = message;
    this.overlay.classList.remove('hidden');
  }

  hideOverlay() {
    this.overlay.classList.add('hidden');
    this.reconnectBtn.classList.add('hidden');
  }

  // ── Reconnect Button ──────────────────────────────

  setupReconnectButton() {
    this.reconnectBtn.addEventListener('click', () => {
      this.reconnectDelay = 1000;
      this.reconnectBtn.classList.add('hidden');
      this.connect();
    });
  }
}

// ── Logger ──────────────────────────────────────────
function log(...args) {
  console.log('%c[remote-terminal]', 'color: #7aa2f7', ...args);
}

// ── Boot ────────────────────────────────────────────
const app = new RemoteTerminal();
app.setupReconnectButton();
app.start();
