import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load } from './harness.mjs';

/**
 * ISSUE_TREE_OPS_SRS 묶음 E — VS Code 기본 편집 키 (TC-ITE-1).
 * 키 묶음은 CodeMirror 의 기존 명령을 그대로 가리키는가(FR-ITE-2), 겹치는 키는 누가 이기는가(FR-ITE-3·4).
 */

const CM = await loadCM();
const cm = load(['core/path.js', 'ui/cm-setup.js'], { globals: { CM }, expose: ['edVscodeKeymap'] });
const sc = load(['core/i18n.js', 'i18n/ko.js', 'core/shortcuts.js'], { expose: ['edEditKeyWins', 'SHORTCUT_DEFAULTS'] });

test('FR-ITE-1·2: VS Code 키가 CodeMirror 명령에 묶인다', () => {
  const km = cm.edVscodeKeymap();
  const by = (key) => km.find((b) => b.key === key);
  const want = {
    'Mod-d': CM.selectNextOccurrence,
    'Mod-Shift-l': CM.selectSelectionMatches,
    'Ctrl-g': CM.gotoLine,
    'Mod-l': CM.selectLine,
    'Shift-Alt-ArrowRight': CM.selectParentSyntax,
  };
  for (const [key, run] of Object.entries(want)) {
    assert.ok(by(key), key + ' 가 묶이지 않았다');
    assert.equal(by(key).run, run, key + ' 가 다른 명령에 묶였다');
    assert.equal(by(key).preventDefault, true, key + ' 의 브라우저 기본 동작을 막지 않는다');
  }
  assert.equal(by('Shift-Alt-ArrowRight').mac, 'Ctrl-Shift-Cmd-ArrowRight');
});

const ev = (code, mods = {}) => ({ code, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift });

test('FR-ITE-3: Win/Linux 에서 겹치는 기본 앱 키는 편집 키가 이긴다', () => {
  const d = sc.SHORTCUT_DEFAULTS;
  for (const [code, action] of [['KeyK', 'softReload'], ['BracketLeft', 'windowPrev'], ['BracketRight', 'windowNext'], ['ArrowLeft', 'paneLeft'], ['ArrowRight', 'paneRight']]) {
    assert.equal(sc.edEditKeyWins(ev(code, { ctrl: true, shift: true }), action, d[action], false), true, action);
  }
});

test('FR-ITE-3·4: mac · 사용자가 바꾼 키 · 겹치지 않는 키는 앱 키다', () => {
  const d = sc.SHORTCUT_DEFAULTS;
  const k = ev('KeyK', { ctrl: true, shift: true });
  assert.equal(sc.edEditKeyWins(k, 'softReload', d.softReload, true), false, 'mac 은 겹치지 않는다');
  assert.equal(sc.edEditKeyWins(k, 'closeTab', 'Ctrl+Shift+KeyK', false), false, '사용자가 이 키를 앱 동작에 녹음했다');
  assert.equal(sc.edEditKeyWins(ev('KeyW', { ctrl: true, shift: true }), 'closeWindow', d.closeWindow, false), false, '창 닫기');
});
