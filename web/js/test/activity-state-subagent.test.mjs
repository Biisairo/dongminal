import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * ACTIVITY_STATE_SUBAGENT_SRS 묶음 V — 서브에이전트 두 보기·사용량 줄 배치·Usage 구역.
 *
 *   TC-ASV-11  사용량 줄의 배치, 서브에이전트 값, 목록형 줄 (FR-ASV-30·31·34·35)
 *   TC-ASV-12  보기 전환과 폴더형 접기 (FR-ASV-32·33)
 *   TC-ASV-13  SSE 갱신과 재조정 근거 (FR-ASV-36·37)
 *   TC-ASV-14  Usage 구역의 값 (FR-ASV-41·42·43)
 */
function memStore() {
  const m = new Map();
  return {
    m,
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)); return true },
    json: (k, d) => (m.has(k) ? JSON.parse(m.get(k)) : d),
    setJson: (k, v) => { m.set(k, JSON.stringify(v)); return true },
  };
}

function loadActivity(globals = {}) {
  const local = memStore();
  const ctx = load(['core/app-agents.js', 'core/app-agents-sub.js', 'core/app-activity.js'], {
    expose: ['ACTIVITY_SECTIONS'],
    globals: {
      App: class {},
      ACTIVITY_STATE: { ENDED: 'ended', WORKING: 'working', DONE: 'done', WAITING: 'waiting', IDLE: 'idle' },
      AGENT_STATE_ICON: { working: '●', done: '✓', waiting: '…', idle: '○' },
      PrefStore: { local },
      STORE_KEYS: { agentsGroupFold: 'agentsGroupFold', agentsSubView: 'agentsSubView' },
      UIKit: { iconHTML: (n) => '<i:' + n + '>' },
      t: (k) => k,
      ...globals,
    },
  });
  ctx._local = local;
  return ctx;
}

const SUB = {
  id: 'a1', agentType: 'Explore', status: 'running', state: 'working', tool: 'Grep', detail: 'parse',
  description: 'Find parseClaudeHook', model: 'claude-haiku-5-5', effort: 'low',
  tokens: 19250, windowTokens: 1000000, ctxPct: 1.925, ctxLevel: 'ok', startTime: 1000,
};
const kinds = (row) => row.children.map((c) => c.className.split(' ')[0]);

// ── TC-ASV-11 ──

test('FR-ASV-30: 사용량 줄은 모델·effort 가 왼쪽, 막대와 백분율이 오른쪽이다', () => {
  const ctx = loadActivity();
  const app = new ctx.App();
  const row = app._agUsageEl(ctx.agentUsageView({ ctxPct: 55.4, ctxLevel: 'ok', model: 'Opus 5.5', effort: 'high' }));
  assert.deepEqual(plain(kinds(row)), ['ag-usage-model', 'ag-usage-bar', 'ag-usage-pct']);
  assert.equal(row.children[0].textContent, 'Opus 5.5·high');
  assert.equal(row.children[2].textContent, '55%');
});

test('FR-ASV-31: 서브에이전트 값 — 상태·도구·내용(detail 우선)·툴팁에 description', () => {
  const { agentSubagentView } = loadActivity();
  const v = agentSubagentView(SUB);
  assert.equal(v.state, 'working');
  assert.equal(v.tool, 'Grep');
  assert.equal(v.text, 'parse');
  assert.equal(v.done, false);
  assert.equal(v.title, 'Explore · claude-haiku-5-5 · effort low · 19,250 / 1,000,000 tokens · running · Find parseClaudeHook');
  assert.equal(agentSubagentView({ ...SUB, detail: '' }).text, 'Find parseClaudeHook');
  // state 가 없으면 status 로 정한다 (서버가 늘 싣지만 옛 응답을 견딘다).
  assert.equal(agentSubagentView({ id: 'x', status: 'running' }).state, 'working');
  assert.equal(agentSubagentView({ id: 'x', status: 'completed' }).state, 'done');
});

test('FR-ASV-35: 상태가 done 이면 흐리다 — 훅 상태가 statusLine 의 running 보다 앞선다', () => {
  const { agentSubagentView } = loadActivity();
  assert.equal(agentSubagentView({ ...SUB, state: 'done' }).done, true);
  assert.equal(agentSubagentView({ ...SUB, state: 'waiting' }).done, false);
});

test('FR-ASV-34: 목록형 줄은 머리(↳·종류·상태) 한 줄과 사용량 줄이다', () => {
  const ctx = loadActivity();
  const app = new ctx.App();
  const row = app._agSubagentEl(ctx.agentSubagentView(SUB));
  assert.equal(row.className, 'ag-sub');
  assert.deepEqual(plain(kinds(row)), ['ag-sub-head', 'ag-usage']);
  assert.deepEqual(plain(kinds(row.children[0])), ['ag-sub-arrow', 'ag-sub-type', 'ag-sub-state']);
  assert.equal(row.children[0].children[2].textContent, '● working · Grep');
  assert.equal(row.children[0].children[2].className, 'ag-sub-state working');
  assert.deepEqual(plain(kinds(row.children[1])), ['ag-usage-model', 'ag-usage-bar', 'ag-usage-pct']);
  assert.match(row.title, /Find parseClaudeHook/);

  const bare = app._agSubagentEl(ctx.agentSubagentView({ id: 'x', status: 'completed' }));
  assert.equal(bare.className, 'ag-sub done');
  assert.deepEqual(plain(kinds(bare)), ['ag-sub-head']);
});

// ── TC-ASV-12 ──

function stubPanelApp(ctx, subagents) {
  const app = new ctx.App();
  app._activity = new Map([['t1', { state: 'working', subagents }]]);
  app.ws = { windows: [{ id: 'w1', name: 'W' }] };
  app._agentOrderSync = () => ['t1'];
  app.findToolLocation = () => ({ win: { id: 'w1' }, tab: { name: 'tab' } });
  app.attnHas = () => false;
  app.agentsRender = () => {};
  return app;
}

test('FR-ASV-32: 기본 보기는 폴더형이고, 전환은 브라우저 저장소에 남는다', () => {
  const ctx = loadActivity();
  const app = stubPanelApp(ctx, [SUB]);
  assert.equal(app._agSubView(), 'tree');
  app._agSubViewToggle();
  assert.equal(app._agSubView(), 'list');
  assert.equal(ctx._local.get('agentsSubView'), 'list');
  app._agSubViewToggle();
  assert.equal(app._agSubView(), 'tree');
});

test('FR-ASV-33: 폴더형은 카드 뒤에 하위 카드 항목이 서고, 접으면 없다', () => {
  const ctx = loadActivity();
  const app = stubPanelApp(ctx, [SUB, { ...SUB, id: 'a2' }]);
  const ts = () => plain(app._agWindowItems().map((i) => i.t));
  assert.deepEqual(ts(), ['group', 'card', 'sub', 'sub']);
  const sub = app._agWindowItems()[2];
  assert.equal(sub.toolId, 't1');
  assert.equal(sub.s.id, 'a1');

  app._agSubFoldToggle('t1');
  assert.deepEqual(ts(), ['group', 'card']);
  assert.deepEqual(plain(JSON.parse(ctx._local.get('agentsGroupFold'))), ['sub:t1']);
  app._agSubFoldToggle('t1');
  assert.deepEqual(ts(), ['group', 'card', 'sub', 'sub']);
});

test('FR-ASV-33·34: 목록형에서는 하위 카드 항목이 없다', () => {
  const ctx = loadActivity();
  const app = stubPanelApp(ctx, [SUB]);
  app._agSubViewToggle();
  assert.deepEqual(plain(app._agWindowItems().map((i) => i.t)), ['group', 'card']);
});

test('FR-ASV-33: 하위 카드는 머리·내용·사용량 줄이고 누르면 그 도구로 간다', () => {
  const ctx = loadActivity();
  const app = stubPanelApp(ctx, [SUB]);
  let jumped = null;
  app.jumpToTool = (id) => { jumped = id };
  let onClick = null;
  const card = app._agSubCardEl('t1', ctx.agentSubagentView(SUB));
  assert.equal(card.className, 'ag-subcard');
  assert.equal(card.dataset.toolid, 't1');
  assert.deepEqual(plain(kinds(card)), ['ag-sub-head', 'ag-detail', 'ag-usage']);
  assert.deepEqual(plain(kinds(card.children[0])), ['ag-sub-type', 'ag-sub-state']);
  assert.equal(card.children[1].textContent, 'parse');

  // 클릭 배선은 대역에서 직접 꺼내 부른다.
  const ctx2 = loadActivity({
    document: {
      createElement: () => {
        const el = { className: '', dataset: {}, style: {}, children: [], title: '', textContent: '',
          appendChild(c) { el.children.push(c); return c },
          addEventListener(type, fn) { if (type === 'click') onClick = fn } };
        return el;
      },
    },
  });
  const app2 = stubPanelApp(ctx2, [SUB]);
  app2.jumpToTool = (id) => { jumped = id };
  app2._agSubCardEl('t1', ctx2.agentSubagentView({ id: 'x', status: 'completed' }));
  onClick({ stopPropagation() {} });
  assert.equal(jumped, 't1');
});

// ── TC-ASV-13 ──

test('FR-ASV-36: SSE 는 같은 id 의 원소를 바꾸고, 없으면 끝에 더하고, main 이 없으면 버린다', () => {
  const ctx = loadActivity();
  const app = stubPanelApp(ctx, [{ ...SUB }]);
  app._onToolSubagentActivity({ toolId: 't1', agentId: 'a1', agentType: 'Explore', state: 'waiting', tool: 'Bash', detail: 'rm' });
  const s = app._activity.get('t1').subagents;
  assert.equal(s.length, 1);
  assert.equal(s[0].state, 'waiting');
  assert.equal(s[0].tool, 'Bash');
  assert.equal(s[0].detail, 'rm');
  assert.equal(s[0].model, 'claude-haiku-5-5');

  app._onToolSubagentActivity({ toolId: 't1', agentId: 'n1', agentType: 'Plan', state: 'working', tool: '', detail: '' });
  assert.deepEqual(plain(app._activity.get('t1').subagents.map((x) => x.id)), ['a1', 'n1']);
  assert.equal(app._activity.get('t1').subagents[1].agentType, 'Plan');

  app._onToolSubagentActivity({ toolId: 'nope', agentId: 'a1', state: 'working' });
  assert.equal(app._activity.has('nope'), false);
});

test('FR-ASV-37: 근거는 state·tool·내용으로도 바뀐다', () => {
  const { agentSubagentsSig } = loadActivity();
  const sig = (s) => agentSubagentsSig([s]);
  assert.notEqual(sig(SUB), sig({ ...SUB, state: 'waiting' }));
  assert.notEqual(sig(SUB), sig({ ...SUB, tool: 'Read' }));
  assert.notEqual(sig(SUB), sig({ ...SUB, detail: 'other' }));
  assert.notEqual(sig({ ...SUB, detail: '' }), sig({ ...SUB, detail: '', description: 'x' }));
  assert.equal(sig(SUB), sig({ ...SUB, tokens: 20000 }));
});

// ── TC-ASV-14 ──

test('FR-ASV-41: 남은 시간은 큰 단위 둘이고 0 이면 soon 이다', () => {
  const { limitResetText } = loadActivity();
  assert.equal(limitResetText(368000), '4d 6h');
  assert.equal(limitResetText(7800), '2h 10m');
  assert.equal(limitResetText(2100), '35m');
  assert.equal(limitResetText(0), 'soon');
});

test('FR-ASV-41·42: 줄 값 — 에이전트 줄과 창 줄, 이름·남은 시간·등급·as of', () => {
  const { limitRowsView } = loadActivity();
  const observedAt = Date.UTC(2026, 10, 10, 5, 0);
  const limits = [{ agent: 'claude', observedAt, windows: [
    { name: 'five_hour', usedPct: 34.4, resetsAt: 1794298291, resetsInSec: 7200, level: '' },
    { name: 'seven_day', usedPct: 91, resetsAt: 1794659091, resetsInSec: 368000, level: 'critical' },
    { name: 'opus_week', usedPct: 5, level: '' },
  ] }];
  const fresh = plain(limitRowsView(limits, observedAt + 60_000));
  assert.equal(fresh.length, 4);
  assert.deepEqual(fresh[0], { kind: 'agent', id: 'claude', name: 'Claude', asOf: '' });
  const d = new Date(1794298291 * 1000);
  const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  assert.deepEqual(fresh[1], { kind: 'win', id: 'claude:five_hour', label: '5h', pct: 34, fill: 34.4, level: '',
    reset: 'resets 2h 0m', title: '5-hour limit · 34% used · resets at ' + hhmm });
  assert.equal(fresh[2].label, '7d');
  assert.equal(fresh[2].reset, 'resets 4d 6h');
  assert.equal(fresh[2].level, 'critical');
  assert.equal(fresh[3].label, 'opus_week');
  assert.equal(fresh[3].reset, '');
  assert.equal(fresh[3].title, 'opus_week · 5% used');

  const o = new Date(observedAt);
  const stale = plain(limitRowsView(limits, observedAt + 11 * 60_000));
  assert.equal(stale[0].asOf, 'as of ' + String(o.getHours()).padStart(2, '0') + ':' + String(o.getMinutes()).padStart(2, '0'));
});

test('FR-ASV-40·43: Usage 구역은 맨 끝이고, 한도가 없으면 항목이 없다(빈 문구)', () => {
  const ctx = loadActivity();
  const keys = ctx.ACTIVITY_SECTIONS.map((s) => s.key);
  assert.equal(keys[keys.length - 1], 'usage');
  const app = new ctx.App();
  app._limits = [];
  assert.equal(app._actUsageRows().length, 0);
  assert.equal(ctx.ACTIVITY_SECTIONS.at(-1).empty(), 'usage.empty');
});

test('FR-ASV-21·44: 복원이 limits 를 담는다', async () => {
  const limits = [{ agent: 'claude', observedAt: 1, windows: [] }];
  const ctx = loadActivity({ stateFetch: () => Promise.resolve({ ok: true, data: { activities: [], limits } }) });
  const app = new ctx.App();
  app._activity = new Map();
  app._restoreBegin = () => new Set();
  app._restoreLive = () => true;
  app._restoreEnd = () => {};
  app.agentsRender = () => {};
  await app._activityRestore();
  assert.deepEqual(plain(app._limits), limits);
});
