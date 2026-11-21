import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { AGENTS, BASE, TOOL, controllers, load } from './harness.mjs';

/**
 * UX_AUDIT_FIX_SRS TC-UXF-62 의 unit 부분 (FR-UXF-60·63) — 작업 중 판정과 에이전트 탭 배지.
 */
const ACTIVITY_STATE = { WORKING: 'working', WAITING: 'waiting', DONE: 'done', IDLE: 'idle', ENDED: 'ended' };

function setup(acts, { located = () => true, attn = new Set() } = {}) {
  const ctx = load([...BASE, ...AGENTS, ...TOOL], {
    expose: ['ACTIVITY_SECTIONS'],
    globals: { App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, ACTIVITY_STATE },
  });
  const app = controllers(ctx, new ctx.App());
  app._activity = new Map(Object.entries(acts).map(([id, state]) => [id, { state }]));
  app.findToolLocation = located;
  app.attnHas = (id) => attn.has(id);
  const agents = ctx.ACTIVITY_SECTIONS.find((s) => s.key === 'agents');
  return { app, badge: (its) => JSON.parse(JSON.stringify(agents.badge(app, its))) };
}

test('TC-UXF-62: 배지는 자리가 있는 작업 중 에이전트의 수다', () => {
  const { badge } = setup({ a: 'working', b: 'working', c: 'done' });
  assert.deepEqual(badge([]), { n: 2, dot: false });
});

test('TC-UXF-62: 자리가 없는 도구는 세지 않는다', () => {
  const { badge } = setup({ a: 'working', b: 'working' }, { located: (id) => id === 'a' });
  assert.deepEqual(badge([]), { n: 1, dot: false });
});

test('TC-UXF-62: 주의가 있는 그룹이 있으면 수 대신 점이다', () => {
  const { badge } = setup({ a: 'working' });
  assert.deepEqual(badge([{ t: 'group', attn: 1 }]), { n: 0, dot: true });
});

test('FR-UXF-61: 주의가 있는 탭에는 작업 중 점을 두지 않는다', () => {
  const { app } = setup({ a: 'working', b: 'working', c: 'waiting' }, { attn: new Set(['b']) });
  assert.equal(app.tabWorkDot('a'), true);
  assert.equal(app.tabWorkDot('b'), false);
  assert.equal(app.tabWorkDot('c'), false);
  assert.equal(app.tabWorkDot(undefined), false);
});

/**
 * REFACTOR3_FE_FIX_SRS TC-FFX-1 (FR-FFX-1~3): 작업 중이면 툴팁 첫 줄 끝과 접근 이름이 `working` 을 말한다.
 */
function fakeEl(title, kids) {
  const attrs = {};
  return {
    title,
    children: kids.map(([text, hidden]) => ({ textContent: text, getAttribute: (k) => (k === 'aria-hidden' && hidden ? 'true' : null) })),
    attrs,
    setAttribute(k, v) { attrs[k] = String(v) },
    removeAttribute(k) { delete attrs[k] },
    getAttribute(k) { return k in attrs ? attrs[k] : null },
  };
}

// FR-FFX-5: 문구는 상수다 — `constants.js` 의 값을 그대로 쓴다.
const WORKING_SUFFIX = readFileSync(new URL('../core/constants.js', import.meta.url), 'utf8')
  .match(/^const TIP_WORKING_SUFFIX='([^']*)';$/m)?.[1];

function labelCtx() {
  return load([...BASE, ...AGENTS, ...TOOL], {
    expose: ['workLabelSync'],
    globals: { App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, ACTIVITY_STATE, TIP_WORKING_SUFFIX: WORKING_SUFFIX },
  });
}

test('TC-FFX-1: 접미사 상수는 ` — working` 이다', () => {
  assert.equal(WORKING_SUFFIX, ' — working');
});

test('TC-FFX-1: 켜면 첫 줄 끝에 붙고 접근 이름은 보이는 글자 + 접미사, 둘째 줄은 그대로다', () => {
  const ctx = labelCtx();
  const el = fakeEl('claude\nwork@x', [['', true], ['claude', false], ['', true]]);
  ctx.workLabelSync(el, true);
  assert.equal(el.title, 'claude — working\nwork@x');
  assert.equal(el.getAttribute('aria-label'), 'claude — working');
});

test('TC-FFX-1: 두 번 불러도 한 번이고, 끄면 원래 툴팁으로 돌아가며 aria-label 이 없다', () => {
  const ctx = labelCtx();
  const el = fakeEl('mywin', [['', true], ['mywin', false], [' dev', false]]);
  ctx.workLabelSync(el, true);
  ctx.workLabelSync(el, true);
  assert.equal(el.title, 'mywin — working');
  assert.equal(el.getAttribute('aria-label'), 'mywin dev — working');
  ctx.workLabelSync(el, false);
  assert.equal(el.title, 'mywin');
  assert.equal(el.getAttribute('aria-label'), null);
});

test('TC-FFX-1: 작업 중이 아니면 툴팁도 접근 이름도 건드리지 않는다', () => {
  const ctx = labelCtx();
  const el = fakeEl('plain', [['plain', false]]);
  ctx.workLabelSync(el, false);
  assert.equal(el.title, 'plain');
  assert.equal(el.getAttribute('aria-label'), null);
});
