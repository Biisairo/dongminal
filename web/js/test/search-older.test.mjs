import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, TOOL, controllers, load } from './harness.mjs';

/**
 * PERF 2.8.2 (D-21): "이전 기록에서 찾기" — 브라우저 버퍼 위(스냅숏의 첫 기록 줄 앞)를 데몬 저장소에서 찾는다.
 * 찾기 줄의 선택지를 그대로 싣고, 일치를 새 줄부터 목록으로 보인다. 고르면 터미널의 기록 보기(2.7)에 줄 번호를 넘긴다.
 */
function setup({ first = 42, reply = { ok: true, status: 200, data: { hits: [{ line: 7, col: 2, text: 'a needle' }] } }, opts = [] } = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, value: '', textContent: '', hidden: true, children: [], replaceChildren(...c) { this.children = c } });
    return els.get(id);
  };
  el('search-input').value = 'needle';
  const calls = [];
  const ctx = load([...BASE, ...TOOL], {
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} },
      document: {
        getElementById: el,
        createElement: () => ({ dataset: {}, textContent: '', addEventListener(t, fn) { this.click = fn } }),
        documentElement: {},
      },
      apiGet: async (path) => { calls.push(path); return reply },
      apiErrText: (r) => 'err ' + r.status,
      SEARCH_NONE: 'none', SEARCH_BAD_REGEX: 'bad',
    },
  });
  const a = controllers(ctx, new ctx.App());
  const opened = [];
  const term = { id: 't1', _firstLine: first, openHistoryAt: (n) => opened.push(n) };
  a.tool.search.focusedTerminal = () => term;
  a.tool.search._searchOpt = (id) => opts.includes(id);
  return { a, el, calls, opened };
}

test('브라우저 버퍼의 첫 기록 줄 앞을 찾기 줄의 선택지로 묻고, 일치를 목록으로 보인다', async () => {
  const { a, el, calls, opened } = setup({ opts: ['search-case', 'search-regex'] });
  await a.tool.search.searchOlder();
  assert.equal(calls.length, 1);
  const u = new URL(calls[0], 'http://h');
  assert.equal(u.pathname, '/api/tools/search');
  assert.deepEqual(Object.fromEntries(u.searchParams), { id: 't1', q: 'needle', before: '42', case: '1', regex: '1' });
  const list = el('search-older-list');
  assert.equal(list.hidden, false);
  assert.equal(list.children.length, 1);
  assert.match(list.children[0].textContent, /a needle/);
  list.children[0].click();
  assert.deepEqual(opened, [7]);
});

test('버퍼 위에 기록이 없거나(첫 줄 0) 검색어가 없으면 묻지 않는다', async () => {
  const s = setup({ first: 0 });
  await s.a.tool.search.searchOlder();
  assert.equal(s.calls.length, 0);
  assert.equal(s.el('search-count').textContent, 'none');
  const t = setup();
  t.el('search-input').value = '';
  await t.a.tool.search.searchOlder();
  assert.equal(t.calls.length, 0);
});

test('일치가 없으면 없음, 데몬이 찾지 못하면 그 사유를 적는다', async () => {
  const s = setup({ reply: { ok: true, status: 200, data: { hits: [] } } });
  await s.a.tool.search.searchOlder();
  assert.equal(s.el('search-count').textContent, 'none');
  assert.equal(s.el('search-older-list').hidden, true);
  const f = setup({ reply: { ok: false, status: 422, data: null, text: 'regex parse error' } });
  await f.a.tool.search.searchOlder();
  assert.equal(f.el('search-count').textContent, 'err 422');
});
