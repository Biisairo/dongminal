import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BASE, TOOL, controllers, load } from './harness.mjs';

/**
 * PERF 3.4.12.4 (D-43, M3_BOOT_SCOPE §3 `search`): 터미널 찾기의 vendor addon-search 와 찾기 줄 본문은
 * `search` 묶음이다. 찾기 줄을 처음 열 때 싣고 살아 있는 터미널 모두에 붙인다. 그 뒤 새 터미널은 바로 붙인다.
 * `focusedTerminal` 은 상태 바·git·tool-life 가 부팅 때 부르므로 부팅 껍데기에 남는다.
 */

const WEB = join(import.meta.dirname, '..', '..');

function bundle(name) {
  const lines = readFileSync(join(WEB, 'bundles.txt'), 'utf8').split('\n');
  const out = [];
  let cur = null;
  for (const l of lines) {
    const m = l.match(/^\[(.+)\]$/);
    if (m) { cur = m[1]; continue }
    if (cur === name && l.trim() && !l.startsWith('#')) out.push(l.trim());
  }
  return out;
}

test('search 묶음은 vendor addon-search 와 찾기 줄 본문이고, 페이지와 부팅 묶음은 그것을 싣지 않는다', () => {
  assert.deepEqual(bundle('search'), ['vendor/addon-search.js', 'js/core/tool-search-bar.js']);
  assert.doesNotMatch(readFileSync(join(WEB, 'index.html'), 'utf8'), /vendor\/addon-search\.js/);
  assert.ok(!bundle('boot').includes('js/core/tool-search-bar.js'));
  assert.ok(bundle('boot').includes('js/core/tool-search.js'), '껍데기(focusedTerminal)는 부팅에 남는다');
});

function setup({ ready = false, fail = false } = {}) {
  const bar = { hidden: true };
  const el = (id) => (id === 'search-bar' ? bar : { focus() {}, value: '', textContent: '', hidden: true });
  const loads = [];
  const done = new Set(ready ? ['search'] : []);
  const Screens = {
    register() {},
    ready: (n) => done.has(n),
    load: (n) => {
      loads.push(n);
      if (fail) return Promise.reject(new Error('x'));
      done.add(n);
      return Promise.resolve();
    },
  };
  const ctx = load([...BASE, ...TOOL], {
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} }, Screens,
      document: { getElementById: el, documentElement: {} },
      SEARCH_NONE: 'none', SEARCH_BAD_REGEX: 'bad',
    },
  });
  // 묶음의 vendor 전역 — 실린 뒤에만 서 있는 것을 흉내 낸다.
  ctx.SearchAddon = { SearchAddon: function SearchAddon() { this.clearDecorations = () => {} } };
  const app = controllers(ctx, new ctx.App());
  const term = () => ({ loaded: [], loadAddon(a) { this.loaded.push(a) } });
  const t1 = { term: term(), el: { classList: { contains: () => false } } };
  const t2 = { term: term(), el: { classList: { contains: () => false } } };
  const idle = { el: { classList: { contains: () => false } } };   // 아직 xterm 이 서지 않은 칸
  app.tools = new Map([['a', t1], ['b', t2], ['c', idle]]);
  return { app, bar, loads, t1, t2, idle };
}

test('묶음이 실리기 전에 선 터미널에는 찾기 addon 을 붙이지 않는다', () => {
  const { app, t1, loads } = setup();
  app.tool.search.attachIfReady(t1);
  assert.equal(t1.search, undefined);
  assert.deepEqual(t1.term.loaded, []);
  assert.deepEqual(loads, []);
  app.tool.search.clearAllSearchDecorations();   // addon 이 없어도 던지지 않는다
  app.tool.search.researchIfOpen();
});

test('찾기 줄을 처음 열면 search 묶음을 한 번 싣고, 살아 있는 터미널 모두에 붙인 뒤 줄을 연다', async () => {
  const { app, bar, loads, t1, t2, idle } = setup();
  await app.tool.search.toggleSearch();
  assert.deepEqual(loads, ['search']);
  assert.equal(bar.hidden, false);
  for (const t of [t1, t2]) {
    assert.ok(t.search);
    assert.deepEqual(t.term.loaded, [t.search]);
  }
  assert.equal(idle.search, undefined, 'xterm 이 없는 칸은 자기 _loadAddons 가 붙인다');
});

test('실린 뒤 새 터미널은 바로 붙고, 이미 붙은 터미널에 두 번 붙이지 않는다', async () => {
  const { app, t1, loads } = setup({ ready: true });
  app.tool.search.attachIfReady(t1);
  assert.deepEqual(t1.term.loaded, [t1.search]);
  await app.tool.search.toggleSearch();
  assert.deepEqual(loads, []);
  assert.equal(t1.term.loaded.length, 1);
});

test('묶음을 싣지 못하면 줄을 열지 않고, 다음 열기가 다시 싣는다', async () => {
  const s = setup({ fail: true });
  await s.app.tool.search.toggleSearch();
  assert.equal(s.bar.hidden, true);
  assert.equal(s.t1.search, undefined);
  await s.app.tool.search.toggleSearch();
  assert.deepEqual(s.loads, ['search', 'search']);
});

test('term-pane 의 _loadAddons 는 SearchAddon 을 직접 만들지 않고 찾기 껍데기에 맡긴다', () => {
  const src = readFileSync(join(WEB, 'js/ui/term-pane.js'), 'utf8');
  assert.doesNotMatch(src, /SearchAddon/);
  assert.match(src, /attachIfReady\(this\)/);
});
