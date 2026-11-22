import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load } from './harness.mjs';

/**
 * UX_BATCH13_SRS — Activity 접기 단추 방향(FR-ACB) · 편집기 줄 이동(FR-EGL).
 */

const dock = load(['core/panel-dock.js'], { expose: ['agCollapseIcon'] });

test('TC-ACB-1: 접기 아이콘은 위치와 모바일 여부를 따른다', () => {
  const f = dock.agCollapseIcon;
  assert.equal(f(true, 'right', false), 'chevron-right');
  assert.equal(f(false, 'right', false), 'chevron-left');
  assert.equal(f(true, 'left', false), 'chevron-left');
  assert.equal(f(false, 'left', false), 'chevron-right');
  // MOBILE_UX_OVERHAUL_SRS FR-MUX-17: 모바일 Activity 는 전체 화면 시트다 — 접는 것이 아니라 닫는다.
  assert.equal(f(true, 'right', true), 'x');
  assert.equal(f(true, 'left', true), 'x');
});

const CM = await loadCM();
const cm = load(['core/path.js', 'ui/cm-setup.js'], { globals: { CM }, expose: ['edVscodeKeymap'] });
const find = load(['ui/cm-find.js'], { globals: { CM, ED_FIND_WORD_SEPARATORS: '' }, expose: ['edGotoParse'] });
const sc = load(['core/i18n.js', 'i18n/ko.js', 'core/shortcuts.js'], { expose: ['SHORTCUT_DEFAULTS', 'SHORTCUT_LABELS', 'ED_SEARCH_ACTIONS'] });

test('TC-EGL-1: 내장 gotoLine 묶음이 없다', () => {
  const km = cm.edVscodeKeymap();
  assert.equal(km.find((b) => b.key === 'Ctrl-g'), undefined);
  assert.equal(km.find((b) => b.run === CM.gotoLine), undefined);
});

test('TC-EGL-2: edGotoLine 은 Ctrl+KeyG 이고 라벨이 있다', () => {
  assert.equal(sc.SHORTCUT_DEFAULTS.edGotoLine, 'Ctrl+KeyG');
  assert.ok(sc.SHORTCUT_LABELS.edGotoLine);
  assert.equal(sc.ED_SEARCH_ACTIONS.edGotoLine, 'editor.search._edGotoLine');
});

test('TC-EGL-3: 줄 · 줄:열 을 해석한다', () => {
  const p = (s, n = 100) => {
    const r = find.edGotoParse(s, n);
    return r && { line: r.line, col: r.col };
  };
  assert.deepEqual(p('12'), { line: 12, col: null });
  assert.deepEqual(p('  7 '), { line: 7, col: null });
  assert.deepEqual(p('3:5'), { line: 3, col: 5 });
});

test('TC-EGL-3: 범위 밖은 접는다', () => {
  const p = (s, n = 100) => {
    const r = find.edGotoParse(s, n);
    return r && { line: r.line, col: r.col };
  };
  assert.deepEqual(p('0'), { line: 1, col: null });
  assert.deepEqual(p('999'), { line: 100, col: null });
  assert.deepEqual(p('5:0'), { line: 5, col: 1 });
});

test('TC-EGL-3: 해석할 수 없으면 null', () => {
  for (const s of ['', '  ', 'abc', '-3', '1.5', '3:', ':4', '1:2:3', '12a']) {
    assert.equal(find.edGotoParse(s, 100), null, JSON.stringify(s));
  }
});
