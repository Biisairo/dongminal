// `shortcuts.md` ↔ `helpers.js` 대조의 본체 (M5 `DOC-3`).
//
// node 로 쓴 이유는 대상이 JS 객체 리터럴이기 때문이다 — 중첩된 따옴표와
// 주석을 bash 로 읽으면 그 파서가 곧 두 번째 결함이 된다.
import { readFileSync } from 'node:fs';

const H = readFileSync('web/js/core/helpers.js', 'utf8');
// 단축키 패널은 `app-settings.js` 에서 갈라져 나왔다 (FE_MODULE_BOUNDARY_SRS
// FR-FMB-10) — `_renderShortcutList` 가 사는 자리가 곧 이 파일이다.
const A = readFileSync('web/js/core/app-settings-keys.js', 'utf8');
const DOC_PATH = 'docs/external/shortcuts.md';
const DOC = readFileSync(DOC_PATH, 'utf8');

// `const NAME={ … \n};` 블록을 잘라낸다. 이 저장소의 표는 전부 이 모양이다.
function block(src, name) {
  const i = src.indexOf(`const ${name}={`);
  if (i < 0) throw new Error(`${name} 을 찾지 못했습니다`);
  const j = src.indexOf('\n};', i);
  return src.slice(i, j + 3);
}

// 최상위 키 이름. 주석 줄은 `:` 앞에 이름이 오지 않으므로 자연히 빠진다.
function keysOf(b) {
  return [...b.matchAll(/(?:^|[,{\n]\s*)([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]);
}

// 라벨 값(한국어 문구)까지 읽는다 — 문서의 첫 칸이 그것이다.
function labelsOf(b) {
  const out = {};
  for (const m of b.matchAll(/(?:^|[,{\n]\s*)([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'/g)) out[m[1]] = m[2];
  return out;
}

const defaults = keysOf(block(H, 'SHORTCUT_DEFAULTS')).filter((k) => !k.startsWith('sbTab'));
const labels = labelsOf(block(H, 'SHORTCUT_LABELS'));

// 설정 화면의 그룹. 서술자에서 파생하는 사이드바 탭 키는 리터럴이 아니라 빠진다.
const gi = A.indexOf('const groups=[');
const gj = A.indexOf('\n    ];', gi);
if (gi < 0 || gj < 0) throw new Error('_renderShortcutList 의 groups 를 찾지 못했습니다');
const grouped = new Set([...A.slice(gi, gj).matchAll(/'([A-Za-z_$][\w$]*)'/g)].map((m) => m[1]));

// 문서 표의 첫 칸.
const docRows = new Set(
  [...DOC.matchAll(/^\|\s*([^|]+?)\s*\|/gm)].map((m) => m[1].trim()),
);

const problems = [];
for (const k of defaults) {
  const label = labels[k];
  if (!label) {
    problems.push(`${k}: SHORTCUT_LABELS 에 라벨이 없습니다 — 설정 화면에 이름이 뜨지 않습니다`);
    continue;
  }
  if (!grouped.has(k)) {
    problems.push(`${k}: _renderShortcutList 의 어느 그룹에도 없습니다 — 화면에 뜨지 않아 바꿀 수 없습니다`);
  }
  if (!docRows.has(label)) {
    problems.push(`${k}: ${DOC_PATH} 의 표에 "${label}" 행이 없습니다`);
  }
}

// 역방향 — 문서에만 있는 동작. 없는 단축키를 안내하면 사용자가 그것을 찾는다.
const knownLabels = new Set(defaults.map((k) => labels[k]).filter(Boolean));
// **`## 기본값` 절의 첫 표만** 본다.
//
// 같은 절 안에 두 번째 표가 있다 — 찾기 줄의 조작(`Enter`·`Escape`…)이며, 그것은
// 앱 단축키가 아니라 그 패널 안의 키다. 코드 목록에 견주면 거짓 경보만 낸다.
const docStart = DOC.indexOf('## 기본값');
const afterHead = docStart < 0 ? '' : DOC.slice(docStart);
const rows = [];
let inTable = false;
for (const line of afterHead.split('\n')) {
  if (line.startsWith('|')) {
    inTable = true;
    rows.push(line);
    continue;
  }
  if (inTable) break; // 표가 끝났다 — 첫 표가 전부다
}
for (const line of rows) {
  const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/);
  if (!m) continue;
  const [, label, value] = m;
  if (label === '동작' || label.startsWith('---')) continue;
  // 사이드바 탭 직행 키는 서술자에서 파생하므로 코드에 리터럴이 없다.
  if (label.startsWith('사이드바 탭:')) continue;
  // **고정 키는 바꿀 수 없고, 그래서 `SHORTCUT_DEFAULTS` 에 없다.** 문서가
  // `(고정)` 이라 적는 것이 그 표시이며, 그 표시가 이 검사의 면제 사유다.
  if (value.includes('(고정)')) continue;
  if (!knownLabels.has(label)) {
    problems.push(`${DOC_PATH}: "${label}" 이 코드의 단축키 목록에 없습니다 — 지워진 동작인가요?`);
  }
}

if (problems.length) {
  console.error('단축키 문서·화면 대조 실패:');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`shortcuts-docs ok (${defaults.length} 개)`);
