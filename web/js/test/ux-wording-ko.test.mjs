import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { CONSTANTS, HELPERS, load } from './harness.mjs';

/**
 * UX_AUDIT_FIX_SRS TC-UXF-40 (FR-UXF-42) · TC-UXF-42 의 unit 부분 (FR-UXF-43).
 *
 * ko 카탈로그에서 값이 라틴 문자로만 된 키를 모아, 값의 낱말이 모두 §3.5.1 의 허용
 * 목록 안인지 본다. 숫자·기호·자리표시자(`{n}`)는 낱말이 아니다.
 * 툴팁·`aria-label` 키는 영어가 요구라 대상이 아니다 (FR-TIP-2).
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** §3.5.1 의 낱말. 대소문자는 가리지 않는다. */
const ALLOW = new Set([
  // 제품·서비스·모델
  'claude', 'git', 'telegram', 'opus', 'sonnet', 'statusline', 'cpu', 'server.json',
  // git 명령·옵션·용어 (D-11)
  'commit', 'fetch', 'pull', 'push', 'merge', 'rebase', 'stash', 'pop', 'drop', 'cherry-pick', 'revert',
  'reset', 'clean', 'checkout', 'blame', 'diff', 'head', 'detached', 'main', 'amend', 'signoff',
  'no-verify', 'a', 'reflog', 'date', 'author-date', 'topo', 'ours', 'theirs', 'continue', 'skip',
  'abort', 'stage', 'unstage', 'hunk', 'lines', 'init', 'update', 'sync', 'am', 'bisect', 'cwd',
  // 표에 없던 것: git reset 의 `--mixed` 와 이 제품의 CLI 이름
  'mixed', 'otterctl',
  // 실행 단위 (D-12)
  'run',
  // 키 이름·기호
  'esc', 'tab', 'ctrl', 'alt', 'home', 'end', 'pgup', 'pgdn', 'c', 'aa', 'ab',
  // ANSI 색 이름
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brblk', 'brred', 'brgrn', 'brylw', 'brblu', 'brmag', 'brcyn', 'brwht',
  // 저장 데이터 기본값
  'shell', 'window', 'chat',
]);

/** 툴팁·`aria-label` 로만 쓰이는 키 — 이름이 `_title` 로 끝나지 않는 것. */
const TIP_KEYS = new Set(['html.btn_split_h', 'html.btn_split_v']);
const isTipKey = (k) => /_title$/.test(k) || TIP_KEYS.has(k);
/** §3.5.1 의 키 단위 예외 — 낱말로 풀면 `{n}d` 같은 남은 시간까지 통과한다. 레일 사용량 창 이름 `5h`·`7d` (RAIL_CHAT_USAGE_SRS D-RCU-2 개정).
 *  UX_BATCH14_SRS FR-UHD-3·4 (D-UB14-3): 칸 라벨과 막대 제목도 창 이름 `5h`·`7d` 다. */
const LATIN_KEYS = new Set(['usage.rail.five_hour', 'usage.rail.seven_day', 'usage.sl.five_hour', 'usage.sl.seven_day',
  'usage.win.five_hour', 'usage.win.seven_day', 'usage.win.seven_day_opus', 'usage.win.seven_day_sonnet']);

const HANGUL = /[가-힣ㄱ-ㆎ]/;
const WORD = /[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*/g;

function catalog(locale) {
  let cat = null;
  const ctx = { I18N: { register(_l, o) { cat = o } } };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(HERE, '..', 'i18n', locale + '.js'), 'utf8'), ctx);
  return cat;
}

/** 값에서 허용 목록 밖의 낱말. 한글이 있는 값은 대상이 아니다. */
function strayWords(v) {
  if (HANGUL.test(v)) return [];
  return (v.replace(/\{\w+\}/g, '').match(WORD) || []).filter((w) => !ALLOW.has(w.toLowerCase()));
}

test('TC-UXF-40: ko 카탈로그의 라틴 문자 전용 값은 §3.5.1 허용 목록 안이다', () => {
  const bad = Object.entries(catalog('ko'))
    .filter(([k]) => !isTipKey(k) && !LATIN_KEYS.has(k))
    .map(([k, v]) => [k, v, strayWords(v)])
    .filter(([, , w]) => w.length)
    .map(([k, v, w]) => `${k} = ${JSON.stringify(v)} (${w.join(', ')})`);
  assert.deepEqual(bad, []);
});

test('TC-UXF-40 (판정): 허용 낱말·자리표시자·기호만이면 통과하고 하나라도 밖이면 걸린다', () => {
  assert.deepEqual(strayWords('{what} ({status})'), []);
  assert.deepEqual(strayWords('Reset (mixed)'), []);
  assert.deepEqual(strayWords('Cherry-pick'), []);
  assert.deepEqual(strayWords('server.json'), []);
  assert.deepEqual(strayWords('Ctrl+Tab · ^C'), []);
  assert.deepEqual(strayWords('여기서 브랜치 만들기…'), []);
  assert.deepEqual(strayWords('Rename…'), ['Rename']);
  assert.deepEqual(strayWords('{n}d'), ['d']);
});

test('TC-UXF-42 (unit): agentsToggle 단축키 이름은 작업 패널을 말한다', () => {
  const ctx = load(['core/i18n.js', 'i18n/ko.js', ...CONSTANTS, ...HELPERS], { expose: ['SHORTCUT_LABELS'] });
  assert.match(ctx.SHORTCUT_LABELS.agentsToggle, /작업/);
  assert.match(catalog('en')['shortcut.agents_toggle'], /Work/);
});
