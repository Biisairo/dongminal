// xterm.js 기준 화면을 만든다(이슈 2.2). cargo 시험은 node 없이 이 결과(ref/*.json)와 견준다.
//
// 앱과 같은 판(@xterm/headless 5.5.0 + @xterm/addon-unicode11 0.8.0, 활성 11)을 쓴다.
//   npm i --prefix <dir> @xterm/headless@5.5.0 @xterm/addon-unicode11@0.8.0
//   node gen-ref.mjs <dir>/node_modules
//
// 셀 하나 = [글자, 폭, 전경, 배경, 속성]. 색은 d(기본)·p<번호>·#rrggbb, 속성은 b i u r d s h.
// 줄 하나는 { t: 글자 목록, s: [[개수, 폭, 전경, 배경, 속성], ...] } 로 줄여 적는다.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HIST = 40;
const modulesDir = process.argv[2];
if (!modulesDir) {
  process.stderr.write('사용: node gen-ref.mjs <node_modules 경로>\n');
  process.exit(2);
}
const req = createRequire(join(modulesDir, 'noop.js'));
const { Terminal } = req('@xterm/headless');
const { Unicode11Addon } = req('@xterm/addon-unicode11');

const color = (mode, v) => (mode === 'd' ? 'd' : mode === 'rgb' ? '#' + v.toString(16).padStart(6, '0') : 'p' + v);

function cellOf(c) {
  const fm = c.isFgDefault() ? 'd' : c.isFgRGB() ? 'rgb' : 'p';
  const bm = c.isBgDefault() ? 'd' : c.isBgRGB() ? 'rgb' : 'p';
  const f =
    (c.isBold() ? 'b' : '') +
    (c.isItalic() ? 'i' : '') +
    (c.isUnderline() ? 'u' : '') +
    (c.isInverse() ? 'r' : '') +
    (c.isDim() ? 'd' : '') +
    (c.isStrikethrough() ? 's' : '') +
    (c.isInvisible() ? 'h' : '');
  return [c.getChars() || ' ', c.getWidth(), color(fm, c.getFgColor()), color(bm, c.getBgColor()), f];
}

function packRow(cells) {
  const t = cells.map((c) => c[0]);
  const s = [];
  for (const c of cells) {
    const last = s[s.length - 1];
    if (last && last[1] === c[1] && last[2] === c[2] && last[3] === c[3] && last[4] === c[4]) last[0]++;
    else s.push([1, c[1], c[2], c[3], c[4]]);
  }
  return { t, s };
}

const write = (t, data) => new Promise((r) => t.write(data, r));

async function run(cs) {
  const t = new Terminal({ cols: cs.cols, rows: cs.rows, scrollback: 50000, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  await write(t, readFileSync(join(HERE, 'corpus', cs.input)));
  const [cols, rows] = cs.resize ?? [cs.cols, cs.rows];
  if (cs.resize) t.resize(cols, rows);
  if (cs.after) await write(t, readFileSync(join(HERE, 'corpus', cs.after)));
  const b = t.buffer.active;
  const rowsOut = [];
  const wrapped = [];
  for (let y = 0; y < rows; y++) {
    const l = b.getLine(b.viewportY + y);
    const cells = [];
    for (let x = 0; x < cols; x++) cells.push(cellOf(l.getCell(x)));
    rowsOut.push(packRow(cells));
    wrapped.push(Boolean(b.getLine(b.viewportY + y + 1)?.isWrapped));
  }
  const nb = t.buffer.normal;
  const hist = [];
  for (let y = Math.max(0, nb.baseY - HIST); y < nb.baseY; y++) hist.push(nb.getLine(y).translateToString(true));
  const m = t.modes;
  return {
    cols,
    rows,
    alt: b.type === 'alternate',
    cursor: [b.cursorX, b.cursorY],
    cursorVisible: !t._core.coreService.isCursorHidden,
    modes: {
      appCursor: m.applicationCursorKeysMode,
      appKeypad: m.applicationKeypadMode,
      bracketedPaste: m.bracketedPasteMode,
      insert: m.insertMode,
      mouse: m.mouseTrackingMode,
      origin: m.originMode,
      focus: m.sendFocusMode,
      autowrap: m.wraparoundMode,
    },
    rowsData: rowsOut,
    wrapped,
    hist,
  };
}

const cases = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));
for (const cs of cases) {
  const out = await run(cs);
  writeFileSync(join(HERE, 'ref', `${cs.name}.json`), JSON.stringify(out) + '\n');
}
