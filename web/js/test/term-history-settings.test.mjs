import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * PERF D-25 (D-M2-11) — 기록 줄 수 설정 둘.
 *
 *   `termHistoryLines`  데몬 줄 저장소의 상한. 서버가 읽어 데몬에 보낸다(화면은 들고 저장만 한다)
 *   `termScrollback`    브라우저 xterm 의 스크롤백. 새로 만드는 터미널부터 쓴다
 *
 * 이전: 브라우저 스크롤백은 상수 `TERM_SCROLLBACK_LINES = 50000` 이었다.
 */
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const schema = () => load(['core/settings-schema.js'], { expose: ['SETTINGS_BY_KEY', 'settingValue'] });

test('D-25: 표가 두 키의 범위와 기본값을 갖는다', () => {
  const { SETTINGS_BY_KEY: by } = schema();
  const pick = (s) => ({ type: s.type, min: s.min, max: s.max, def: s.def });
  assert.deepEqual(pick(by.termHistoryLines), { type: 'int', min: 1000, max: 200000, def: 50000 });
  assert.deepEqual(pick(by.termScrollback), { type: 'int', min: 500, max: 50000, def: 5000 });
});

test('D-25: 범위 밖 값은 기본값으로 떨어진다', () => {
  const { SETTINGS_BY_KEY: by, settingValue } = schema();
  assert.equal(settingValue(999, by.termHistoryLines), 50000);
  assert.equal(settingValue(200001, by.termHistoryLines), 50000);
  assert.equal(settingValue(2000, by.termHistoryLines), 2000);
  assert.equal(settingValue(499, by.termScrollback), 5000);
  assert.equal(settingValue(800, by.termScrollback), 800);
});

test('D-25: 스크롤백은 설정에서 오고, 오기 전에는 표의 기본값이다', () => {
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/settings-schema.js', 'core/settings-state.js']);
  assert.equal(ctx.termScrollbackNow(), 5000);
});

test('D-25: 터미널은 만들 때 설정의 스크롤백을 쓰고, 상수는 남지 않는다', () => {
  assert.match(src('ui/term-pane.js'), /new Terminal\(Object\.assign\(\{\},TOPTS,\{[^}]*scrollback:termScrollbackNow\(\)/);
  assert.doesNotMatch(src('core/constants-term.js'), /TERM_SCROLLBACK_LINES|scrollback:/);
});
