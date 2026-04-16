const OP_INPUT  = 0x00;
const OP_RESIZE = 0x01;
const OP_OUTPUT = 0x00;
const OP_EXIT   = 0x02;

const term = new Terminal({
  scrollback: 50000,
  cursorBlink: true,
  cursorStyle: 'block',
  fontSize: 14,
  lineHeight: 1.2,
  fontFamily: "'Menlo','Monaco','Consolas','Liberation Mono','Courier New',monospace",
  allowProposedApi: true,
  theme: {
    background: '#1a1b26', foreground: '#a9b1d6',
    cursor: '#c0caf5', cursorAccent: '#1a1b26',
    selectionBackground: '#33467c', selectionForeground: '#c0caf5',
    black: '#15161e', red: '#f7768e', green: '#9ece6a',
    yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7',
    cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a',
    brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  },
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
term.loadAddon(new Unicode11Addon.Unicode11Addon());
term.unicode.activeVersion = '11';
term.open(document.getElementById('terminal'));
fitAddon.fit();

// Connect WebSocket
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${proto}//${location.host}/ws?cols=${term.cols}&rows=${term.rows}`);
ws.binaryType = 'arraybuffer';

const encoder = new TextEncoder();

ws.onopen = () => {
  log('connected');
};

ws.onmessage = (e) => {
  const data = new Uint8Array(e.data);
  if (data.length < 1) return;
  switch (data[0]) {
    case OP_OUTPUT: term.write(data.subarray(1)); break;
    case OP_EXIT:   term.write('\r\n\x1b[90m--- process exited ---\x1b[0m\r\n'); break;
  }
};

ws.onclose = () => {
  log('disconnected');
  term.write('\r\n\x1b[90m--- disconnected ---\x1b[0m\r\n');
};

// Input → Server
term.onData((data) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const encoded = encoder.encode(data);
  const msg = new Uint8Array(1 + encoded.length);
  msg[0] = OP_INPUT;
  msg.set(encoded, 1);
  ws.send(msg);
});

// Resize → Server
term.onResize(({ cols, rows }) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const msg = new Uint8Array(5);
  msg[0] = OP_RESIZE;
  new DataView(msg.buffer).setUint16(1, cols, false);
  new DataView(msg.buffer).setUint16(3, rows, false);
  ws.send(msg);
});

// Window resize → fit terminal
window.addEventListener('resize', () => fitAddon.fit());

function log(...args) {
  console.log('%c[terminal]', 'color: #7aa2f7', ...args);
}
