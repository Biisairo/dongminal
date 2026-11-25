import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, PANELS, load, plain } from './harness.mjs';

/**
 * PERF 3.4.12.8 (perf/M3_BOOT_SCOPE.md §3 `mobile`): 모바일 본체는 [mobile] 묶음이다. 부팅 쪽 껍데기 `MobileShell` 은
 * 렌더러·상태 바·main 이 부르는 이름에 데스크톱의 답을 내고, 모바일이어야 할 때(`app.wantsMobile`) 묶음을 실어
 * `app.mobile` 을 본체 `MobileController` 로 바꾼다. 본체가 서기 전에는 `app.isMobile` 이 거짓이다.
 */
const tick = () => new Promise((r) => setImmediate(r));

function setup({ fail = 0 } = {}) {
  const calls = { load: [], resize: [], errors: [] };
  let left = fail;
  const Screens = {
    register() {},
    ready: () => false,
    load: (name) => {
      calls.load.push(name);
      if (left > 0) { left--; return Promise.reject(new Error('net')) }
      return Promise.resolve();
    },
  };
  const ctx = load([...BASE, ...PANELS, 'core/mobile-shell.js', 'ui/drawer-sheet.js', 'core/mobile-controller.js',
    'core/mobile-sheets.js', 'core/mobile-nav.js'], {
    globals: {
      Screens, TIMERS: { disposeOwner() {}, frame() {} },
      document: { getElementById: () => null, querySelector: () => null, body: { classList: { contains: () => false } } },
      ErrorLog: { push: (k, m) => calls.errors.push([k, String(m)]), quiet: (_k, f) => f() },
      addEventListener: (t, fn) => { if (t === 'resize') calls.resize.push(fn) },
    },
    expose: ['MobileShell', 'MobileController'],
  });
  const log = [];
  const app = {
    wantsMobile: false,
    tools: new Map(),
    layout: { tabOps: { sbPanel: () => ({ railSync: () => log.push('sbRail') }) } },
    agents: { list: { actPanel: () => ({ railSync: () => log.push('actRail') }) } },
    tool: { life: { aw: () => ({ layout: { type: 'split' } }) } },
    flattenPanes: () => [{ id: 'a' }, { id: 'b' }],
    render: () => log.push('render'),
  };
  app.mobile = new ctx.MobileShell(app);
  return { ctx, app, log, calls };
}

test('껍데기는 데스크톱의 답을 낸다', () => {
  const { app, log } = setup();
  const m = app.mobile;
  assert.equal(m.loaded, false);
  assert.equal(m.mobileSideSlots(), 0);
  assert.equal(m.mobileOnSide(), false);
  assert.equal(m.mobileShowPane('a', { render: true }), false);
  assert.equal(m.mobilePaneCount(), 2, '칸 수는 모드와 무관하다');
  m.mTopPaint(); m._mkbRender(); m.mkbRefresh(); m._kbSuppressAll(); m._mobileVvApply(); m._toggleDrawer(false);
  m.nav.actSheetLeave(); m.nav.mobileActSync(); m.nav.mobileRepoSegSync(); m.sheets.mobileChromeSync();
  m.applyMobileMode();
  assert.deepEqual(log, ['sbRail', 'actRail'], '렌더는 레일만 맞춘다');
  const modal = { dataset: {} };
  m.sheets._settingsMobileOnOpen(modal);
  assert.equal(modal.dataset.mview, 'list');
});

test('모바일이 아니면 묶음을 싣지 않는다', async () => {
  const { app, calls } = setup();
  app.mobile.applyMobileMode();
  await app.mobile.loadIfWanted();
  calls.resize.forEach((fn) => fn());
  await tick();
  assert.deepEqual(calls.load, []);
  assert.equal(app.mobile.loaded, false);
});

test('부팅 때 모바일이면 실은 뒤 본체로 바꾸고, 첫 렌더는 부팅이 한다', async () => {
  const { ctx, app, log, calls } = setup();
  app.wantsMobile = true;
  const shell = app.mobile;
  await shell.loadIfWanted();
  assert.deepEqual(calls.load, ['mobile']);
  assert.ok(app.mobile instanceof ctx.MobileController);
  assert.ok(app.mobile instanceof ctx.MobileShell, '본체는 껍데기를 잇는다');
  assert.equal(app.mobile.loaded, true);
  assert.deepEqual(log, [], '부팅 전에는 다시 그리지 않는다');
});

test('부팅 뒤 resize 로 모바일이 되면 본체의 init 을 돌리고 다시 그린다', async () => {
  const { ctx, app, log, calls } = setup();
  const shell = app.mobile;
  shell.initMobile(); shell.initMobileKeybar();
  assert.deepEqual(plain(app.modKbd), { ctrl: false, alt: false });
  const seen = [];
  ctx.MobileController.prototype._mobileBind = function () { seen.push('mobileBind') };
  ctx.MobileController.prototype.initMobileKeybar = function () { seen.push('initMobileKeybar') };
  ctx.MobileController.prototype._kbSuppressAll = function () { seen.push('kbSuppressAll') };
  app.wantsMobile = true;
  calls.resize.forEach((fn) => fn());
  calls.resize.forEach((fn) => fn());
  await tick();
  assert.deepEqual(calls.load, ['mobile', 'mobile'], '등록부가 같은 Promise 를 나눈다');
  assert.ok(app.mobile instanceof ctx.MobileController);
  assert.deepEqual(seen, ['mobileBind', 'initMobileKeybar', 'kbSuppressAll'], '본체는 한 번만 선다');
  assert.deepEqual(log, ['render']);
});

test('설정 창이 이미 섰으면 본체가 모바일 설정 화면을 배선한다', async () => {
  const { ctx, app } = setup();
  app.mobile.sheets._initSettingsMobile();
  let wired = 0;
  const proto = Object.getPrototypeOf(new ctx.MobileController(app).sheets);
  proto._initSettingsMobile = () => { wired++ };
  app.wantsMobile = true;
  await app.mobile.loadIfWanted();
  assert.equal(wired, 1);
});

test('렌더(표시 모드 바꿈)도 계기다', async () => {
  const { ctx, app, calls } = setup();
  app.wantsMobile = true;
  app.mobile.applyMobileMode();
  await tick();
  assert.deepEqual(calls.load, ['mobile']);
  assert.ok(app.mobile instanceof ctx.MobileController);
});

test('싣기에 실패하면 데스크톱에 남고 기록하며, 다음 계기가 다시 시도한다', async () => {
  const { ctx, app, calls } = setup({ fail: 1 });
  app.wantsMobile = true;
  await app.mobile.loadIfWanted();
  assert.equal(app.mobile.loaded, false);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0][0], 'mobile');
  await app.mobile.loadIfWanted();
  assert.ok(app.mobile instanceof ctx.MobileController);
});

test('본체가 서기 전에는 app.isMobile 이 거짓이다', () => {
  const ctx = load(['core/app.js'], { expose: ['App'], globals: { MOBILE_LANDSCAPE_MAX_H: 0 } });
  const get = Object.getOwnPropertyDescriptor(ctx.App.prototype, 'isMobile').get;
  assert.equal(get.call({ wantsMobile: true, mobile: { loaded: false } }), false);
  assert.equal(get.call({ wantsMobile: true, mobile: undefined }), false);
  assert.equal(get.call({ wantsMobile: true, mobile: { loaded: true } }), true);
  assert.equal(get.call({ wantsMobile: false, mobile: { loaded: true } }), false);
});
