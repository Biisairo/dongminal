import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import globals from 'globals';

/**
 * ESLint 최소 설정 (CI_GATES_SRS B3 · 02-fe-arch 의 P1 "린트·타입 안전망 전무").
 *
 * **규칙이 셋뿐인 것은 의도다.** 스타일 규칙을 켜면 35,120 LOC 가 한꺼번에
 * 빨개지고, 그러면 아무도 보지 않는 게이트가 된다. 셋은 전부 결함 탐지이지
 * 취향이 아니다 — 없는 이름, 죽은 변수, 빈 블록.
 *
 * ── 전역 목록을 손으로 적지 않는 이유 ──
 *
 * `web/index.html` 이 클래식 `<script>` 85개를 순서대로 싣고, 모듈은 전역
 * `class`/`function`/`const` 로 서로를 본다 (`type="module"` 0). ESLint 는 파일
 * 단위로 스코프를 보므로 그 상호 참조가 전부 `no-undef` 가 된다.
 *
 * 목록이 1,254개다. 손으로 적으면 그 목록이 곧 두 번째 진실이 되고, 새 상수를
 * 더할 때마다 두 곳을 고쳐야 하며, 한쪽만 고쳐지면 게이트가 조용히 거짓말을 한다.
 * **그래서 소스에서 뽑는다** — 이 파일이 `web/js` 를 훑어 최상위 선언을 모은다.
 *
 * 정규식이 파서보다 성긴 것은 사실이고, 그 성김이 어느 쪽으로 틀리는지가 중요하다:
 * 놓친 선언은 **거짓 양성**(있는 이름을 없다고 한다)이 되어 눈에 띄고 고쳐진다.
 * 반대 방향(없는 이름을 있다고 하는 것)은 최상위 선언이 아닌 것을 선언으로 잘못
 * 읽을 때뿐인데, 앵커가 줄 첫 칸이라 그런 자리가 거의 없다.
 */
function appGlobals(dir) {
  const out = {};
  const fn = /^(?:class|function|async function)\s+([A-Za-z_$][\w$]*)/gm;
  // `const enc=new TextEncoder(), dec=new TextDecoder();` — 한 줄에 여럿이다.
  // 첫 이름만 잡으면 나머지가 `no-undef` 로 나온다 (실제로 `dec` 가 그랬다).
  const vars = /^(?:const|let|var)\s+([^;\n]*)/gm;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(fn)) out[m[1]] = 'writable';
        for (const m of src.matchAll(vars)) for (const n of declaredNames(m[1])) out[n] = 'writable';
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * 선언부 한 줄에서 이름들을 뽑는다. 초기화식 안의 쉼표(함수 인자·배열·객체)를
 * 세지 않기 위해 괄호 깊이를 따라간다 — 깊이 0 의 쉼표만 선언 구분자다.
 */
function declaredNames(head) {
  const names = [];
  let depth = 0, start = 0;
  const parts = [];
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push(head.slice(start, i)); start = i + 1 }
  }
  parts.push(head.slice(start));
  for (const part of parts) {
    const m = /^\s*([A-Za-z_$][\w$]*)/.exec(part);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * `web/vendor` 와 CDN 이 세우는 전역. 이쪽은 손으로 적는다 — 최소화된 번들에서
 * 선언을 뽑을 수 없고, 수가 적어 두 번째 진실이 될 만큼 자라지 않는다.
 */
const VENDOR_GLOBALS = {
  Terminal: 'readonly',          // web/vendor/xterm.js
  FitAddon: 'readonly',          // web/vendor/addon-fit.js
  SearchAddon: 'readonly',       // web/vendor/addon-search.js
  WebLinksAddon: 'readonly',     // web/vendor/addon-web-links.js
  Unicode11Addon: 'readonly',    // web/vendor/addon-unicode11.js
  hljs: 'readonly',              // web/vendor/highlight.js
  markdownit: 'readonly',        // web/vendor/markdown-it.js
  DOMPurify: 'readonly',         // web/vendor/purify.js
  monaco: 'readonly',            // CDN (02-fe-arch 의 P1 — 벤더링 대상)
  require: 'readonly',           // monaco 의 AMD 로더 (`file-editor.js:64-81`)
};

export default [
  {
    // vendor 는 남의 코드이고 최소화돼 있다. 검사할 것도 고칠 것도 없다.
    ignores: ['web/vendor/**', 'node_modules/**', 'dist/**', 'playwright-report/**', 'test-results/**'],
  },
  {
    // 앱 본체 — 클래식 스크립트. 모듈이 아니다.
    files: ['web/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...VENDOR_GLOBALS, ...appGlobals('web/js') },
    },
    rules: {
      'no-undef': 'error',
      // `vars: 'local'` 이 핵심이다. 최상위 `class`/`const` 는 이 구조에서 **다른
      // 파일이 쓰는 전역**이므로, 파일 안에서 안 쓰인다고 죽은 코드가 아니다.
      // 그것까지 세면 1,000건이 넘는 거짓 양성이 나와 게이트가 잡음이 된다.
      // 함수 안의 죽은 변수는 그대로 잡힌다 — 그쪽이 재려던 것이다.
      'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // 단위 테스트 하네스 — 이쪽은 진짜 Node ESM 이다.
    files: ['web/js/test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
