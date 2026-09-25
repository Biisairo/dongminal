import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-1-12 (FEC-26) — 설정 컨트롤을 칠하는 자리가 **하나**다.
 *
 * 종전에는 같은 `getElementById → checked/value = 전역` 이 세 곳(setter · 설정창
 * 열기 · `_init*`)에 있었다. 이제 컨트롤은 `SETTINGS_ACCESS` 항목의 `ctl` 로
 * 선언되고 `_paintSettingControls` 한 함수가 칠한다.
 */
const ctx = load(['core/app-settings.js'], {
  globals: { App: function App() {} },
  expose: ['SETTINGS_ACCESS'],
});

const CTLS = {
  'ds-fgnames': 'check', 'ds-claudefs': 'check', 'ds-confirmleave': 'check',
  'ds-wordwrap': 'check', 'ds-minimap': 'check', 'ds-diffminimap': 'check',
  'ds-tabfix': 'check', 'ds-tabw': 'value', 'ds-title': 'value',
};

test('FEC-26: 컨트롤이 서술자 표에 한 번씩 선언된다', () => {
  const got = {};
  for (const acc of Object.values(ctx.SETTINGS_ACCESS)) {
    if (!acc.ctl) continue;
    assert.equal(got[acc.ctl.id], undefined, '두 번 선언됐다: ' + acc.ctl.id);
    got[acc.ctl.id] = acc.ctl.kind;
  }
  assert.deepEqual(plain(got), CTLS);
});

test('FEC-26: _paintSettingControls 가 전역 값으로 칠하고, 치는 중인 입력란은 덮지 않는다', () => {
  const els = {};
  for (const id of Object.keys(CTLS)) els[id] = { checked: false, value: '' };
  ctx.document.getElementById = (id) => els[id] || null;
  Object.assign(ctx, {
    fgTabNames: true, claudeFullscreen: true, confirmLeave: false, editorWordWrap: true,
    editorMinimap: false, diffMinimap: true, tabFixedWidth: true, tabWidthPx: 180, pageTitle: 'T',
  });
  ctx.document.activeElement = els['ds-title'];
  els['ds-title'].value = 'typing';
  const app = new ctx.App();
  app._paintSettingControls();
  assert.equal(els['ds-fgnames'].checked, true);
  assert.equal(els['ds-claudefs'].checked, true);
  assert.equal(els['ds-confirmleave'].checked, false);
  assert.equal(els['ds-wordwrap'].checked, true);
  assert.equal(els['ds-minimap'].checked, false);
  assert.equal(els['ds-diffminimap'].checked, true);
  assert.equal(els['ds-tabfix'].checked, true);
  assert.equal(els['ds-tabw'].value, '180');
  assert.equal(els['ds-title'].value, 'typing', '치는 중인 글자를 덮었다');
  ctx.document.activeElement = null;
  app._paintSettingControls();
  assert.equal(els['ds-title'].value, 'T');
});
