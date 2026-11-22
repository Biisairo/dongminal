import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, SETTINGS, load, plain } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-1-12 (FEC-26) — 설정 컨트롤을 칠하는 자리가 **하나**다.
 *
 * 종전에는 같은 `getElementById → checked/value = 전역` 이 세 곳(setter · 설정창
 * 열기 · `_init*`)에 있었다. 이제 행은 설정 섹션이 `FormRow` 로 선언하고
 * (REFACTOR3_FE_SETTINGS_SRS FR-FES-2) `_paintSettingControls` 가 섹션을 돌며 칠한다.
 */
const CTLS = {
  'ds-tabfix': 'check', 'ds-tabw': 'number', 'ds-uifs': 'number', 'ds-fgnames': 'check', 'ds-confirmleave': 'check',
  'ds-claudefs': 'check', 'ds-termfs': 'number', 'ds-scrollspeed': 'number',
  // ISSUE_TREE_OPS_SRS FR-ITM-1
  'ds-mighook': 'check', 'ds-mighookpct': 'number', 'ds-treemig': 'check', 'ds-treemigpct': 'number',
  'ds-wordwrap': 'check', 'ds-minimap': 'check',
};

function setup() {
  const els = {};
  for (const id of Object.keys(CTLS)) els[id] = { checked: false, value: '', addEventListener() {}, removeEventListener() {} };
  const ctx = load(['core/settings-schema.js', ...BASE, ...SETTINGS, 'core/settings-table.js'], {
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} },
      TermGpu: { enabled: () => false, setEnabled() {} }, I18N: { locale: 'ko', resolve: (v) => v },
      applyTabWidth() {}, applyUiFontScale() {},
      // 설정 전역 — 부팅 전의 값이다(`settings-state.js`). 숫자 넷은 블롭이 오기 전까지 비어 있다.
      fgTabNames: true, claudeFullscreen: true, confirmLeave: false, editorWordWrap: false, editorMinimap: true,
      tabFixedWidth: false, tabWidthPx: 160, uiFontSize: undefined, termFontSize: undefined,
      claudeScrollSpeed: undefined, migrationHook: undefined, migrationHookCtxPct: undefined,
      issueTreeMigration: undefined, issueTreeCtxPct: undefined, focusEdgeLevel: 0, attnEdgeLevel: 5,
      UFE_LEVEL_MAX: 10, ATTN_EDGE_LEVEL_MAX: 10,
    },
    expose: ['SettingsController', 'DisplaySection', 'TerminalSection', 'CodeSection'],
  });
  ctx.document.getElementById = (id) => els[id] || null;
  // QUALITY_FIX_SRS FR-QFX-10: terminal 의 칠하기가 키바 구성 목록(`#ds-keybar .kbc-list`)도 찾는다 — 여기는 없다.
  ctx.document.querySelector = () => null;
  ctx.document.activeElement = null;
  const app = new ctx.App();
  app.slot = { ops: { _slotDirPaint: () => {} } };
  app.settings = new ctx.SettingsController(app);
  for (const C of ['DisplaySection', 'TerminalSection', 'CodeSection']) app.settings.start(new ctx[C](app));
  return { ctx, els, app };
}

test('FEC-26: 컨트롤이 섹션의 행 선언에 한 번씩 있고, 포커스 가드는 숫자 행 모두다', () => {
  const { app } = setup();
  const got = {}, guarded = [];
  for (const s of app.settings.all()) {
    for (const r of s.rows) {
      assert.equal(got[r.decl.id], undefined, '두 번 선언됐다: ' + r.decl.id);
      got[r.decl.id] = r.decl.kind;
      if (r.decl.guard) guarded.push(r.decl.id);
    }
  }
  assert.deepEqual(plain(got), CTLS);
  // REFACTOR3_FE_FIX_SRS FR-FFX-7 개정 — 이전: 탭 폭 하나(`ds-tabw`) / 새: 숫자 행 여섯 / 이유: 다섯이 입력 중 방송에 덮였다(실측)
  assert.deepEqual(plain(guarded.sort()), ['ds-mighookpct', 'ds-scrollspeed', 'ds-tabw', 'ds-termfs', 'ds-treemigpct', 'ds-uifs']);
});

test('FEC-26: _paintSettingControls 가 전역 값으로 칠하고, 치는 중인 탭 폭은 덮지 않는다', () => {
  const { ctx, els, app } = setup();
  Object.assign(ctx, {
    fgTabNames: true, claudeFullscreen: true, confirmLeave: false, editorWordWrap: true,
    editorMinimap: false, tabFixedWidth: true, tabWidthPx: 180,
    migrationHook: false, issueTreeMigration: true, uiFontSize: 18,
  });
  ctx.document.activeElement = els['ds-tabw'];
  els['ds-tabw'].value = '99';
  app.settings.paint();
  assert.equal(els['ds-fgnames'].checked, true);
  assert.equal(els['ds-claudefs'].checked, true);
  assert.equal(els['ds-confirmleave'].checked, false);
  assert.equal(els['ds-wordwrap'].checked, true);
  assert.equal(els['ds-minimap'].checked, false);
  assert.equal(els['ds-tabfix'].checked, true);
  assert.equal(els['ds-uifs'].value, '18');
  assert.equal(els['ds-termfs'].value, '14', '한 번도 실리지 않은 키는 표의 기본값');
  assert.equal(els['ds-tabw'].value, '99', '치는 중인 글자를 덮었다');
  ctx.document.activeElement = null;
  app.settings.paint();
  assert.equal(els['ds-tabw'].value, '180');
});
