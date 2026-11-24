// 스냅숏을 xterm.js 에 넣어 확인한다(이슈 2.4, A-2). cargo 시험은 에뮬레이터끼리 견주고, 이 스크립트는
// 같은 일을 앱의 xterm.js(@xterm/headless 5.5.0 + unicode11)로 한다.
//   OTTER_SNAP_OUT=<dir> cargo test -p otter-shared-termstate --lib export_snapshots -- --ignored
//   node check-snap.mjs <node_modules 경로> <dir>
// 분할점 k 마다 두 가지를 본다(j = k - back): xterm(바이트[..j]) = xterm(스냅숏),
// xterm(바이트 전체) = xterm(스냅숏 + 바이트[j..]).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HIST = 1000;
const [modulesDir, snapDir] = process.argv.slice(2);
if (!modulesDir || !snapDir) {
  process.stderr.write('사용: node check-snap.mjs <node_modules 경로> <스냅숏 폴더>\n');
  process.exit(2);
}
const req = createRequire(join(modulesDir, 'noop.js'));
const { Terminal } = req('@xterm/headless');
const { Unicode11Addon } = req('@xterm/addon-unicode11');

const write = (t, data) => new Promise((r) => t.write(data, r));

function cellKey(c) {
  const fm = c.isFgDefault() ? 'd' : c.isFgRGB() ? 'r' + c.getFgColor() : 'p' + c.getFgColor();
  const bm = c.isBgDefault() ? 'd' : c.isBgRGB() ? 'r' + c.getBgColor() : 'p' + c.getBgColor();
  const f = [c.isBold(), c.isItalic(), c.isUnderline(), c.isInverse(), c.isDim(), c.isStrikethrough(), c.isInvisible()]
    .map(Number)
    .join('');
  return `${c.getChars() || ' '}|${c.getWidth()}|${fm}|${bm}|${f}`;
}

function bufferDump(buf, cols, from, to) {
  const out = [];
  for (let y = from; y < to; y++) {
    const l = buf.getLine(y);
    if (!l) continue;
    const cells = [];
    for (let x = 0; x < cols; x++) cells.push(cellKey(l.getCell(x)));
    out.push(`${l.isWrapped ? 'w' : '-'}${cells.join(',')}`);
  }
  return out;
}

function dump(t, cols, rows) {
  const n = t.buffer.normal;
  const a = t.buffer.alternate;
  const active = t.buffer.active;
  return {
    type: active.type,
    cursor: [active.cursorX, active.cursorY],
    hidden: t._core.coreService.isCursorHidden,
    modes: JSON.stringify(t.modes),
    normal: bufferDump(n, cols, Math.max(0, n.baseY - HIST), n.baseY + rows),
    alt: active.type === 'alternate' ? bufferDump(a, cols, 0, rows) : [],
  };
}

async function term(cols, rows, ...parts) {
  const t = new Terminal({ cols, rows, scrollback: 50000, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  for (const p of parts) await write(t, p);
  return dump(t, cols, rows);
}

function firstDiff(a, b) {
  for (const k of ['type', 'cursor', 'hidden', 'modes']) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return `${k}: ${JSON.stringify(a[k])} != ${JSON.stringify(b[k])}`;
  }
  for (const k of ['normal', 'alt']) {
    if (a[k].length !== b[k].length) return `${k} 줄 수 ${a[k].length} != ${b[k].length}`;
    for (let i = 0; i < a[k].length; i++) {
      if (a[k][i] !== b[k][i]) {
        const x = a[k][i].split(','), y = b[k][i].split(',');
        const j = x.findIndex((v, n) => v !== y[n]);
        return `${k} 줄 ${i} 칸 ${j}: ${x[j]} != ${y[j]}`;
      }
    }
  }
  return '';
}

const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
const tally = {};
for (const m of manifest) {
  const data = readFileSync(join(HERE, 'corpus', m.input));
  const snap = readFileSync(join(snapDir, m.snap));
  const t = (tally[m.input] ??= { points: 0, at: 0, rest: 0, first: '' });
  t.points++;
  const j = m.k - m.back;
  const atK = firstDiff(await term(m.cols, m.rows, data.subarray(0, j)), await term(m.cols, m.rows, snap));
  const rest = firstDiff(await term(m.cols, m.rows, data), await term(m.cols, m.rows, snap, data.subarray(j)));
  if (atK) t.at++;
  if (rest) t.rest++;
  if ((atK || rest) && !t.first) t.first = `k=${m.k} ${atK ? '직후 ' + atK : '나머지 뒤 ' + rest}`;
}
let bad = 0;
for (const [name, t] of Object.entries(tally)) {
  bad += t.at + t.rest;
  process.stdout.write(`${name}: 분할점 ${t.points}, 직후 다름 ${t.at}, 나머지 뒤 다름 ${t.rest}${t.first ? ' — ' + t.first : ''}\n`);
}
process.exit(bad ? 1 : 0);
