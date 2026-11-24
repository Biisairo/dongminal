import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

/**
 * REFACTOR3_FE_REST5_SRS TC-FR5-10: 새 판 자동 새로고침(`ui/version-watch.js`)의 지금 동작을 고정한다.
 * 나누기 전 코드에서 GREEN 이다 — 즉시 실행 함수를 클래스로 바꾼 뒤에도 같은 답을 내야 한다.
 *
 * 바깥 표면: `window.__dmAssetVersion(next, live)` · 세션 키 `verReloadTried` · `#ver-held` 배너 ·
 * `window.__dmReloading` · `BootScreen.show(BOOT_STEP_VERSION)` · `location.reload()` · 탭 복귀의 `apiGet('/')`.
 */
const SELF = 'aaa111';

function setup({ self = SELF, tried = null, dirty = false, page = null } = {}) {
  const log = [];
  const session = new Map();
  if (tried) session.set('verReloadTried', tried);
  const byId = new Map();
  let vis = null;
  const mk = (tag) => {
    const el = { tag, id: '', className: '', textContent: '', children: [],
      appendChild(c) { el.children.push(c); if (c.id) byId.set(c.id, c); return c } };
    return el;
  };
  const document = {
    hidden: false,
    querySelector: (sel) => (sel === 'script[src*="core/main.js"]' && self !== undefined
      ? { getAttribute: () => (self ? 'js/core/main.js?v=' + self : 'js/core/main.js') } : null),
    getElementById: (id) => byId.get(id) || null,
    createElement: mk,
    addEventListener: (t, fn) => { if (t === 'visibilitychange') vis = fn },
    body: { appendChild(c) { log.push('banner'); if (c.id) byId.set(c.id, c); return c } },
  };
  const ctx = load(['ui/version-watch.js'], {
    globals: {
      document,
      location: { reload: () => log.push('reload') },
      PrefStore: { session: {
        json: (k, d) => (session.has(k) ? session.get(k) : d),
        setJson: (k, v) => { log.push('set:' + JSON.stringify(v)); session.set(k, v) },
      } },
      BootScreen: { show: (s) => log.push('boot:' + s) },
      BOOT_STEP_VERSION: 'step-version',
      setInterval: () => { log.push('setInterval') },
      VER_HELD_MSG: 'held', VER_HELD_GO: 'go',
      UIKit: { button: (o) => ({ id: '', label: o.label, cls: o.cls, click: o.onClick }) },
      app: { editor: { sync: { edAnyDirty: () => dirty } }, },
      apiGet: async (path, o) => {
        log.push('get:' + path + ':' + o.cache + ':' + o.parse + ':' + (o.query && typeof o.query._v));
        return page || { ok: false };
      },
    },
  });
  return { ctx, log, session, byId, document, fireVisible: () => vis && vis() };
}

test('TC-FR5-10: 같은 판이면 아무것도 하지 않는다', () => {
  const s = setup();
  s.ctx.__dmAssetVersion(SELF);
  s.ctx.__dmAssetVersion('');
  s.ctx.__dmAssetVersion(null);
  assert.deepEqual(s.log, []);
  assert.equal(s.ctx.__dmReloading, undefined);
});

test('TC-FR5-10: 다른 판이면 세션 키를 적은 뒤 부팅 화면을 세우고 다시 연다 — 한 번만', () => {
  const s = setup();
  s.ctx.__dmAssetVersion('bbb222');
  assert.deepEqual(s.log, ['set:{"from":"aaa111","to":"bbb222"}', 'boot:step-version', 'reload']);
  assert.equal(s.ctx.__dmReloading, true);
  s.ctx.__dmAssetVersion('ccc333');
  assert.equal(s.log.length, 3, '다시 열기는 한 번뿐이다');
});

test('TC-FR5-10: 같은 쌍으로 이미 시도했으면 열지 않는다 — 다른 목표면 연다', () => {
  const s = setup({ tried: { from: SELF, to: 'bbb222' } });
  s.ctx.__dmAssetVersion('bbb222');
  assert.deepEqual(s.log, []);
  s.ctx.__dmAssetVersion('ccc333');
  assert.deepEqual(s.log, ['set:{"from":"aaa111","to":"ccc333"}', 'boot:step-version', 'reload']);
});

test('TC-FR5-10: 다른 출발 판의 기록은 막지 않는다', () => {
  const s = setup({ tried: { from: 'zzz', to: 'bbb222' } });
  s.ctx.__dmAssetVersion('bbb222');
  assert.equal(s.log.at(-1), 'reload');
});

test('TC-FR5-10: dirty 편집이 있으면 배너만 한 번 세우고, 배너의 단추가 다시 연다', () => {
  const s = setup({ dirty: true });
  s.ctx.__dmAssetVersion('bbb222');
  s.ctx.__dmAssetVersion('bbb222');
  assert.deepEqual(s.log, ['banner']);
  const banner = s.byId.get('ver-held');
  assert.ok(banner, '#ver-held 가 선다');
  assert.equal(banner.className, 'ver-held');
  assert.equal(banner.children[0].textContent, 'held');
  assert.equal(banner.children[1].label, 'go');
  assert.equal(banner.children[1].cls, 'ver-held-go');
  banner.children[1].click();
  assert.deepEqual(s.log, ['banner', 'set:{"from":"aaa111","to":"bbb222"}', 'boot:step-version', 'reload']);
});

test('TC-FR5-10: 앱의 dirty 판정이 던지면 dirty 가 아니다', () => {
  const s = setup();
  s.ctx.app.editor.sync.edAnyDirty = () => { throw new Error('x') };
  s.ctx.__dmAssetVersion('bbb222');
  assert.equal(s.log.at(-1), 'reload');
});

test('TC-FR5-10: 살아 있는 인사가 있으면 탭 복귀에 묻지 않고 그 판으로 판정한다', async () => {
  const s = setup();
  let alive = true;
  s.ctx.__dmAssetVersion(SELF, () => alive);
  s.fireVisible();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.log, []);
  alive = false;
  s.fireVisible();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.log, ['get:/:no-store:false:number']);
});

test('TC-FR5-10: 인사가 없으면 탭 복귀에 / 를 받아 판을 읽는다', async () => {
  const s = setup({ page: { ok: true, text: '<script src="js/core/main.js?v=ddd444"></script>' } });
  s.fireVisible();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.log, ['get:/:no-store:false:number', 'set:{"from":"aaa111","to":"ddd444"}', 'boot:step-version', 'reload']);
});

test('TC-FR5-10: 함수가 아닌 live 는 인사로 치지 않는다 · 응답이 실패면 아무것도 하지 않는다', async () => {
  const s = setup();
  s.ctx.__dmAssetVersion(SELF, true);
  s.fireVisible();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.log, ['get:/:no-store:false:number']);
});

test('TC-FR5-10: 문서에 판이 없으면 아무것도 걸지 않는다', () => {
  const s = setup({ self: '' });
  assert.equal(s.ctx.__dmAssetVersion, undefined);
  s.fireVisible();
  assert.deepEqual(s.log, []);
});

// RELOAD_CONTINUITY_SRS TC-RLC-3c (FR-RLC-2a): 판 확인에는 주기가 없다. 종전 e2e 는 8초 동안 확인
// 요청이 0 인지 봤는데, 그 창은 무엇이 주기를 걸든 재지 못했다 (E2E_PRUNE_REPORT §8.6). 여기서는
// 적재가 타이머를 하나도 걸지 않고, 시계를 한참 흘려도 묻지 않음을 직접 본다.
test('TC-RLC-3c: 적재와 인사가 타이머를 걸지 않고, 가만히 두면 판을 묻지 않는다', async () => {
  const s = setup();
  assert.equal(s.ctx._clock.pending(), 0, '적재가 타이머를 걸었다');
  s.ctx.__dmAssetVersion(SELF, () => true);
  assert.equal(s.ctx._clock.pending(), 0, '인사가 타이머를 걸었다');
  await s.ctx._clock.advance(10 * 60 * 1000);
  assert.deepEqual(s.log, [], '가만히 두었는데 판을 물었다');
});
