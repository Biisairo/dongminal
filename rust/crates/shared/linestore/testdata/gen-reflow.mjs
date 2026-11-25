// xterm.js 재흐름 기준 자료를 만든다: 논리 줄을 폭 `from` 에서 쓰고 `to` 로 바꾼 뒤 행을 떠낸다.
// node gen-reflow.mjs > reflow.json
// @xterm/headless 5.5.0 + @xterm/addon-unicode11 이 든 node_modules 를 XTERM_NODE_MODULES 로 준다.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const base = process.env.XTERM_NODE_MODULES || '/private/tmp/otter-emu-spike/node/node_modules';
const require = createRequire(join(base, 'noop.js'));
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

const ROWS = 30;
const cases = [
  { name: 'ascii-shrink', from: 20, to: 7, lines: [[{ t: 'hello world this is long' }], [{ t: 'short' }], []] },
  { name: 'styles-shrink', from: 40, to: 8, lines: [[
    { t: 'red ', fg: 1 }, { t: 'bold', f: 'b' }, { t: ' rgb-bg text here', bg: '#102030' },
    { t: ' idx', fg: 200, bg: 9 }, { t: ' end', f: 'iurds' },
  ]] },
  { name: 'wide-boundary', from: 20, to: 5, lines: [[{ t: 'ab한글漢字cd' }], [{ t: 'a한b' }], [{ t: 'abcd한' }]] },
  { name: 'grow', from: 6, to: 25, lines: [[{ t: 'abcdefghijklmnopqrstu' }], [{ t: 'xy' }]] },
  { name: 'wide-grow', from: 5, to: 9, lines: [[{ t: 'a한글漢字b' }]] },
  { name: 'combining', from: 10, to: 4, lines: [[{ t: 'café au lait' }]] },
  { name: 'exact-fit', from: 10, to: 5, lines: [[{ t: 'abcde' }], [{ t: 'abcdefghij' }]] },
  { name: 'styled-gap', from: 12, to: 4, lines: [[{ t: 'x' }, { t: '   ', bg: 2 }, { t: 'y' }, { t: 'z', f: 'h' }]] },
  { name: 'wide-styled', from: 12, to: 3, lines: [[{ t: 'a' }, { t: '한글', fg: '#ff8800', f: 'b' }, { t: 'b' }]] },
  { name: 'linked', from: 16, to: 6, lines: [[{ t: 'see ' }, { t: 'example.com/x', link: 'https://example.com/x' }, { t: ' ok' }]] },
];

function sgr(seg) {
  const p = ['0'];
  for (const [k, c] of [['b', '1'], ['d', '2'], ['i', '3'], ['u', '4'], ['r', '7'], ['h', '8'], ['s', '9']]) {
    if ((seg.f || '').includes(k)) p.push(c);
  }
  const color = (v, lo, hi, ext) => {
    if (v === undefined) return;
    if (typeof v === 'string') {
      const n = parseInt(v.slice(1), 16);
      p.push(`${ext};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`);
    } else if (v < 8) p.push(String(lo + v));
    else if (v < 16) p.push(String(hi + v - 8));
    else p.push(`${ext};5;${v}`);
  };
  color(seg.fg, 30, 90, 38);
  color(seg.bg, 40, 100, 48);
  return `\x1b[${p.join(';')}m`;
}

function ansi(line) {
  let s = '';
  for (const seg of line) {
    s += sgr(seg);
    s += seg.link ? `\x1b]8;;${seg.link}\x1b\\${seg.t}\x1b]8;;\x1b\\` : seg.t;
  }
  return s + '\x1b[0m\r\n';
}

const col = (mode, v) => (mode === 0 ? 'd' : mode === 0x3000000 ? '#' + v.toString(16).padStart(6, '0') : 'p' + v);
function cellOf(c) {
  const fm = c.isFgDefault() ? 0 : c.isFgRGB() ? 0x3000000 : 1;
  const bm = c.isBgDefault() ? 0 : c.isBgRGB() ? 0x3000000 : 1;
  const f = (c.isBold() ? 'b' : '') + (c.isItalic() ? 'i' : '') + (c.isUnderline() ? 'u' : '') + (c.isInverse() ? 'r' : '')
    + (c.isDim() ? 'd' : '') + (c.isStrikethrough() ? 's' : '') + (c.isInvisible() ? 'h' : '');
  return [c.getChars() || ' ', c.getWidth(), col(fm, c.getFgColor()), col(bm, c.getBgColor()), f];
}

async function run(cs) {
  const t = new Terminal({ cols: cs.from, rows: ROWS, scrollback: 1000, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  await new Promise((r) => t.write(cs.lines.map(ansi).join(''), r));
  t.resize(cs.to, ROWS);
  const b = t.buffer.normal;
  const logical = [];
  for (let y = 0; y < b.length && logical.length <= cs.lines.length; y++) {
    const l = b.getLine(y);
    const row = [];
    for (let x = 0; x < cs.to; x++) row.push(cellOf(l.getCell(x)));
    if (l.isWrapped && logical.length) logical[logical.length - 1].push(row);
    else logical.push([row]);
  }
  return { ...cs, rows: logical.slice(0, cs.lines.length) };
}

const out = [];
for (const cs of cases) out.push(await run(cs));
process.stdout.write(JSON.stringify({ xterm: '5.5.0+unicode11', cases: out }, null, 1) + '\n');
