#!/usr/bin/env node
/**
 * 코드 주석이 가리키는 파일이 **있는가**, 줄 번호가 **파일 안인가** (PROD3 §4.3 · DOC-13·14).
 *
 * 파일을 나누고 옮기면 그 파일을 가리키던 주석이 남는다. 주석은 시험이 돌지 않으므로
 * 아무것도 알리지 않고, 읽는 사람은 없는 파일을 찾아 헤맨다. 3차 리팩토링이 `app-*.js`·
 * `panel-*.js` 를 컨트롤러로 나눈 뒤 이런 주석이 수십 곳 남았다.
 *
 * ## 무엇을 재는가
 *
 *   ① 주석 안의 파일 이름(`이름.js`·`.mjs`·`.ts`·`.go`·`.sh`·`.css`·`.html`)이 저장소에 있는가.
 *      이름은 **끝 이름(basename)** 으로 본다 — 주석은 경로를 줄여 적는 일이 많다.
 *   ② `이름.확장자:줄`(`:줄-줄`·`:줄~줄` 포함)의 줄이 그 파일의 줄 수를 넘지 않는가.
 *      같은 끝 이름이 여럿이면 가장 긴 파일과 견준다.
 *
 * ## 무엇을 세지 않는가
 *
 *   - ①만: 그 줄이나 바로 위 두 줄의 주석에 `옛`·`종전`·`당시`·`없어진`·`사라진`·`지운`·`이전`·`Go 기준선` 이 있는
 *     이름 — 지난 이름을 지난 이름이라고 밝힌 주석이다. `Go 기준선` 은 main 브랜치에 남은 Go 판의 파일을
 *     가리킨다 (GO_REMOVAL_SRS Q-GRM-9). 지금 이름을 함께 적는 것이 좋다
 *     (`옛 app-cmd.js, 지금 tool-cmd.js`). ②는 이때도 본다 — 지금 있는 파일의 줄을 적었다면 그 줄은 지금 있어야 한다.
 *   - 주석이 아닌 자리(문자열·시험 자료). `gone: [...]` 같은 표는 코드다.
 *   - 예시 이름 — 첫 점 앞이 두 글자 이하(`a/b.go`·`x.spec.ts`)이거나 `_`·숫자로 시작하는 이름(`_test.go`, URL 의 `%20c.go`).
 *   - 저장소 밖의 파일 — 아래 `OUTSIDE` 표. 이유를 함께 적는다.
 *   - 줄 번호가 파일 안이지만 **가리키는 내용이 달라진** 경우. 그것은 이 검사로 잴 수 없다 —
 *     줄 번호 대신 함수·규칙 이름으로 가리킨다.
 *
 * 사용: node scripts/check-code-refs.mjs
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { basename } from 'path';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`코드 주석의 파일 참조 검사

  web/js·e2e·scripts 의 주석에서 파일 이름과 \`파일:줄\` 을 찾아
  ① 그 이름의 파일이 저장소에 있는지 ② 줄이 파일 길이 안인지 본다.

  그 줄이나 바로 위 두 줄의 주석에 '옛'·'종전'·'당시'·'없어진'·'사라진'·'지운'·'이전'·'Go 기준선' 이 있으면 지난 이름으로 보고 건너뛴다.
  (지난 이름이어도 지금 있는 파일의 줄 번호가 파일 길이를 넘으면 잡는다.)
  걸리면: 지금 이름으로 고치거나('git log --follow'), 지난 이름임을 밝힌다.
  줄 번호는 함수·규칙 이름으로 바꾸는 것이 낫다.`);
  process.exit(0);
}

const SCAN_DIRS = ['web/js', 'e2e', 'scripts'];
const SCAN_EXT = /\.(js|mjs|ts|go|sh)$/;
const SKIP = /(^|\/)(vendor|node_modules)\//;
const HISTORIC = /옛|종전|당시|없어진|사라진|지운|이전|Go 기준선/;
/** 저장소 밖의 파일(끝 이름) → 이유. */
const OUTSIDE = new Map([
  ['nodejsWatcherLib.ts', 'VS Code 소스 — 감시기 설계의 출처'],
  ['watcher.ts', 'VS Code 소스 — 감시기 설계의 출처'],
  ['explorerService.ts', 'VS Code 소스 — 탐색기 동작의 출처'],
  ['textFileEditorModelManager.ts', 'VS Code 소스 — 편집기 모델 동작의 출처'],
  ['repository.ts', 'VS Code git 확장 소스 — 감시 동작의 출처'],
  ['graph.ts', '외부 그래프 구현 — 레인 배치의 출처'],
  ['lint.ts', 'CodeMirror lint 소스 — 미니맵 동작의 출처'],
  ['settings-schema.ts', 'oh-my-pi 소스 — 설정 스키마의 출처'],
  ['builtin-lifecycle.ts', 'oh-my-pi 소스 — 수명 주기의 출처'],
  ['install_omp.go', 'oh-my-pi 설치기 소스'],
  ['file_unix.go', 'Go 표준 라이브러리 소스'],
  ['npm-cli.js', 'npm 이 설치하는 파일'],
  ['cm.js', '빌드 산출물(scripts/build-codemirror.mjs) — 저장소에 싣지 않는다'],
  ['export_test.go', 'Go 관용 이름 — 특정 파일이 아니다'],
]);
/** 주석 안의 파일 참조. 앞 글자가 경로 문자면 더 긴 이름의 일부다. */
const REF = /(?<![\w.-])((?:[\w.-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:js|mjs|ts|go|sh|css|html))(?::(\d+)(?:\s*[-~]\s*(\d+))?)?(?![\w])/g;

const all = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
/** 끝 이름 → 그 이름을 가진 파일들의 최대 줄 수. */
const lines = new Map();
for (const f of all) {
  const b = basename(f);
  if (!/\.(js|mjs|ts|go|sh|css|html)$/.test(b)) continue;
  let n = 0;
  if (!SKIP.test(f)) {
    const src = readFileSync(f, 'utf8');
    n = src.split('\n').length - (src.endsWith('\n') ? 1 : 0);
  } else {
    n = Infinity;
  }
  lines.set(b, Math.max(lines.get(b) || 0, n));
}

/** 한 줄에서 주석 부분만 돌려준다. 문자열 안의 `//` 는 대충 피한다(URL `://`). */
function commentOf(line, ext) {
  const t = line.trimStart();
  if (ext === 'sh') {
    if (t.startsWith('#')) return t;
    const i = line.indexOf(' # ');
    return i >= 0 ? line.slice(i) : '';
  }
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return t;
  const m = line.match(/(^|[^:'"`\\])\/\/(?!\/)/);
  if (m) return line.slice(m.index + m[1].length);
  const b = line.indexOf('/*');
  return b >= 0 ? line.slice(b) : '';
}

const bad = [];
for (const f of all) {
  if (!SCAN_DIRS.some((d) => f.startsWith(d + '/')) || !SCAN_EXT.test(f) || SKIP.test(f)) continue;
  if (f === 'scripts/check-code-refs.mjs') continue;
  const ext = f.split('.').pop();
  const src = readFileSync(f, 'utf8').split('\n');
  src.forEach((line, i) => {
    const c = commentOf(line, ext);
    if (!c) return;
    const near = [c, commentOf(src[i - 1] || '', ext), commentOf(src[i - 2] || '', ext)].join(' ');
    const historic = HISTORIC.test(near);
    for (const m of c.matchAll(REF)) {
      const name = basename(m[1]);
      if (name.split('.')[0].length <= 2 || /^[_\d]/.test(name) || OUTSIDE.has(name)) continue;
      const have = lines.get(name);
      if (have === undefined) {
        if (!historic) bad.push(`${f}:${i + 1}  없는 파일 \`${m[1]}\``);
        continue;
      }
      const hi = Number(m[3] || m[2] || 0);
      if (hi && hi > have) bad.push(`${f}:${i + 1}  \`${m[0]}\` — ${name} 은 ${have}줄`);
    }
  });
}

if (bad.length) {
  console.log(`✗ 주석의 파일 참조 ${bad.length}곳이 없는 파일이나 파일 밖의 줄을 가리킵니다:`);
  for (const b of bad) console.log('  ' + b);
  console.log('  지금 이름으로 고치거나 지난 이름임을 밝히세요 (node scripts/check-code-refs.mjs --help).');
  process.exit(1);
}
console.log('code-refs ok — 주석의 파일 참조가 전부 저장소 안을 가리킵니다');
