import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, TOOL, controllers, load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-7 (FEC-33): 검색은 키 입력마다 계산 스타일을 읽지 않는다 —
 * 장식은 테마를 적용할 때 한 번 계산된다(`searchDecor`).
 */
test('doSearch 세 번에 getComputedStyle 0회 — 테마가 계산해 둔 장식을 쓴다', () => {
  let reads = 0;
  const input = { value: 'foo' }, count = { textContent: '' };
  const seen = [];
  const ctx = load([...BASE, ...TOOL], {
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} },
      document: { getElementById: (id) => (id === 'search-input' ? input : count), documentElement: {} },
      getComputedStyle: () => { reads++; return { getPropertyValue: () => '#000000' } },
      hexToRgba: (h, a) => h + '/' + a,
      searchDecor: { matchBackground: 'mb', matchBorder: 'b', activeMatchBackground: 'amb', activeMatchBorder: 'ab' },
      SEARCH_NONE: 'none', SEARCH_BAD_REGEX: 'bad',
    },
  });
  const a = controllers(ctx, new ctx.App());
  const term = { search: { findNext: (q, o) => { seen.push(o.decorations); return true } }, _searchSub: null };
  a.tool.search.focusedTerminal = () => term;
  a.tool.search._searchOpt = () => false;          // REFACTOR3_FE_APPCTL_SRS 9j: 부품 `ToolSearch` 의 것이다
  a.tool.search._searchBindResults = () => {};
  for (let i = 0; i < 3; i++) a.tool.search.doSearch('next');
  assert.equal(reads, 0);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].matchBackground, 'mb');
});

test('searchDecorOf 는 테마 변수에서 종전과 같은 장식을 만든다', () => {
  const ctx = load(['core/theme-vars.js'], { globals: { hexRgb: () => [0, 0, 0], mixHex: () => '#000000', t: (k) => k } });
  const d = ctx.searchDecorOf({ '--accent': '#102030', '--accent-border': '#aabbcc', '--danger': '#ff0000' });
  assert.equal(d.matchBackground, 'rgba(16,32,48,0.4)');
  assert.equal(d.matchBorder, '#aabbcc');
  assert.equal(d.activeMatchBackground, 'rgba(255,0,0,0.5)');
  assert.equal(d.activeMatchBorder, '#ff0000');
});
