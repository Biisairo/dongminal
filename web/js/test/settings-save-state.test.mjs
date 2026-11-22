import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * UX_AUDIT_FIX_SRS FR-UXF-70~72 (TC-UXF-70) — 설정 행 저장 단추는 저장할 변경이 있을 때만 활성이다.
 */
function btn() {
  const cls = new Set();
  return {
    disabled: false,
    classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c) }, contains: (c) => cls.has(c) },
  };
}

function setup() {
  const ids = ['pf-save', 'acl-save', 'eg-save', 'sbx-save', 'tg-token-save', 'tg-silence-save', 'tg-token', 'tg-silence'];
  const dom = Object.fromEntries(ids.map((id) => [id, { ...btn(), value: '' }]));
  const ctx = load([...BASE, 'core/settings-live.js', 'core/settings-save-state.js'], {
    expose: ['SettingsLive', 'SettingsSaveState'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} },
      document: { getElementById: (id) => dom[id] || null, querySelector: () => null },
    },
  });
  const app = new ctx.App();
  // REFACTOR3_FE_APPCTL_SRS 9a: 기준과 단추는 `SettingsController` 의 부품이다.
  // 폼 값은 그 탭의 섹션이 모은다 — 판정은 `_sectionCall(탭, 이름)` 으로 묻는다 (REFACTOR3_FE_DELEG_SRS D-DLG-4).
  app._pfForm = { name: 'a' };
  const sections = {
    profile: { _pfCollect: () => app._pfForm }, access: { _aclCollect: () => ({}) },
    edges: { _egNodeCollect: () => ({}) }, sandbox: { _sbxCollect: () => ({}) },
  };
  app.settings = {
    live: new ctx.SettingsLive(app), saveState: new ctx.SettingsSaveState(app),
    section: (tab) => sections[tab],
    _sectionCall: (tab, name, args) => sections[tab][name](...args),
  };
  return { app, dom, ctx };
}

test('Telegram 토큰은 공백을 뺀 값이 있으면 변경이다', () => {
  const { ctx } = setup();
  assert.equal(ctx.tgTokenDirty('   '), false);
  assert.equal(ctx.tgTokenDirty(''), false);
  assert.equal(ctx.tgTokenDirty(' 1:a '), true);
});

test('Telegram 조용한 시간은 서버 값과 다를 때만 변경이다', () => {
  const { ctx } = setup();
  assert.equal(ctx.tgSilenceDirty(null, '7'), false, '서버 값을 모르면 변경이 없다');
  assert.equal(ctx.tgSilenceDirty({ silenceMin: 5 }, '5'), false);
  assert.equal(ctx.tgSilenceDirty({ silenceMin: 5 }, '7'), true);
  assert.equal(ctx.tgSilenceDirty({ silenceMin: 5 }, ''), true, '빈 값은 0 이다');
  assert.equal(ctx.tgSilenceDirty({ silenceMin: 0 }, 'x'), false);
});

test('기준을 읽기 전에는 비활성, 읽은 값과 같으면 비활성, 다르면 활성이고 주동작 모양이다', () => {
  const { app, dom } = setup();
  app.settings.saveState._saveBtnsPaint();
  assert.equal(dom['pf-save'].disabled, true);
  assert.equal(dom['pf-save'].classList.contains('ui-btn-primary'), false);

  app.settings.live._liveMark('profile', null, app.settings.section('profile')?._pfCollect());
  assert.equal(dom['pf-save'].disabled, true, '_liveMark 가 다시 판정한다');

  app._pfForm = { name: 'b' };
  app.settings.saveState._saveBtnsPaint();
  assert.equal(dom['pf-save'].disabled, false);
  assert.equal(dom['pf-save'].classList.contains('ui-btn-primary'), true);

  app.settings.live._liveMark('profile', null, app.settings.section('profile')?._pfCollect());
  assert.equal(dom['pf-save'].disabled, true, '저장하면 기준이 새 값이다');
});

test('Telegram 단추는 입력과 서버 값으로 판정한다', () => {
  const { app, dom } = setup();
  app._tg = { silenceMin: 5 };
  dom['tg-silence'].value = '5';
  dom['tg-token'].value = '';
  app.settings.saveState._saveBtnsPaint();
  assert.equal(dom['tg-token-save'].disabled, true);
  assert.equal(dom['tg-silence-save'].disabled, true);
  dom['tg-token'].value = '1:a';
  dom['tg-silence'].value = '9';
  app.settings.saveState._saveBtnsPaint();
  assert.equal(dom['tg-token-save'].disabled, false);
  assert.equal(dom['tg-silence-save'].disabled, false);
});
