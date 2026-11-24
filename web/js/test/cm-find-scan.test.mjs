import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { fakeClock, load, plain } from './harness.mjs';

/**
 * PERF_OPTIMIZATION_SRS FR-SPA-5 · OQ-2 (이슈 3.3) — 큰 문서의 찾기를 나눠 센다.
 *
 * `edFindScan` 은 문서를 줄 묶음으로 나눠 훑는다. 찾기 패널(`ED_FIND_MIXIN`)은 작은 문서는 바로 끝까지 세고,
 * 큰 문서는 보이는 구간을 먼저 칠한 뒤 입력이 멎으면(디바운스) 나머지를 시간 예산 안의 조각으로 센다.
 * 시간은 e2e(`editor-find-perf.spec.ts`)가 재고, 여기서는 조각의 크기와 순서를 결정적으로 잰다.
 */

const CM = await loadCM();
const WORD_SEP = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';
const doc = (s) => CM.Text.of(s.split('\n'));
const OFF = { case: false, regex: false, word: false };

const CHUNK = 10;
const SLICE_MS = 8;
const PERF_STEP_MS = 5;
const DEBOUNCE_MS = 100;
const MAX = 1000;
const BUSY = '…';
const NONE = '없음';

function loadFind() {
  const clock = fakeClock();
  let perf = 0;
  const ctx = load(['core/timer-hub.js', 'ui/cm-find.js', 'ui/file-editor-find.js'], {
    clock,
    globals: {
      CM,
      FileEditor: class {},
      performance: { now: () => (perf += PERF_STEP_MS) },
      ED_FIND_WORD_SEPARATORS: WORD_SEP,
      ED_FIND_MAX_HITS: MAX,
      ED_FIND_CHUNK_LINES: CHUNK,
      ED_FIND_SLICE_MS: SLICE_MS,
      ED_FIND_DEBOUNCE_MS: DEBOUNCE_MS,
      ED_FIND_BUSY: BUSY,
      ED_FIND_NONE: NONE,
      ED_FIND_BAD_RE: 'bad',
    },
    expose: ['edFindHits', 'edFindScan', 'ED_FIND_MIXIN'],
  });
  return { ctx, clock };
}

const { ctx } = loadFind();
const spans = (hs) => plain(hs).map((h) => [h.from, h.to]);
const full = (d, q, o = {}, max = MAX) => plain(ctx.edFindHits(d, q, { ...OFF, ...o }, max));

// ── 나눠 훑기 ───────────────────────────────────────────────────────────────

const BODY = Array.from({ length: 37 }, (_, i) =>
  `row ${i} Needle needle needleX (needle) k${i}=v${i} 가나 가나다`).join('\n');

const CASES = [
  ['리터럴 · 대소문자 무시', 'needle', {}],
  ['대소문자', 'Needle', { case: true }],
  ['단어 단위', 'needle', { word: true }],
  ['한글 단어 단위', '가나', { word: true }],
  ['정규식 · 캡처', '(k\\d+)=(v\\d+)', { regex: true }],
  ['정규식 · 줄 끝', '다$', { regex: true }],
];

for (const [name, q, o] of CASES) {
  test(`나눠 훑은 결과가 한 번에 센 결과와 같다 — ${name}`, () => {
    const d = doc(BODY);
    const want = full(d, q, o);
    assert.ok(want.length > 0, '이 질의는 일치가 있어야 시험이 무엇이든 잰다');
    for (const n of [1, 3, 7, 1000]) {
      const s = ctx.edFindScan(d, q, { ...OFF, ...o }, MAX);
      while (!s.done) s.step(n);
      assert.deepEqual(plain(s.hits), want, `묶음 ${n} 줄`);
    }
  });
}

test('step(n) 한 번은 줄을 n 개 넘게 훑지 않는다', () => {
  const d = doc(BODY);
  const s = ctx.edFindScan(d, 'needle', OFF, MAX);
  assert.equal(s.line, 1);
  s.step(10);
  assert.equal(s.line, 11);
  assert.equal(s.done, false);
  assert.deepEqual(spans(s.hits), spans(full(d, 'needle', {}).filter((h) => h.to <= d.line(10).to)));
  s.step(10); s.step(10);
  assert.equal(s.done, false);
  s.step(10);
  assert.equal(s.done, true);
});

test('상한은 묶음을 건너서도 지킨다', () => {
  const d = doc(Array.from({ length: 30 }, () => 'aaaa').join('\n'));
  const s = ctx.edFindScan(d, 'a', OFF, 25);
  while (!s.done) s.step(2);
  assert.equal(s.hits.length, 25);
  assert.equal(s.line <= 30, true, '상한에 닿으면 남은 줄을 훑지 않는다');
});

test('빈 질의는 처음부터 끝난 상태다', () => {
  const s = ctx.edFindScan(doc('abc'), '', OFF, MAX);
  assert.equal(s.done, true);
  assert.deepEqual(plain(s.hits), []);
});

test('여러 줄에 걸칠 수 있는 정규식은 한 번에 끝까지 훑는다 — 줄 경계에서 자르면 일치가 깨진다', () => {
  const d = doc('a\nb\na\nb');
  for (const q of ['a\\sb', 'a[^x]b', 'a\\nb']) {
    const s = ctx.edFindScan(d, q, { ...OFF, regex: true }, MAX);
    s.step(1);
    assert.equal(s.done, true, q);
    assert.deepEqual(spans(s.hits), [[0, 3], [4, 7]], q);
  }
});

test('edFindHits 는 범위를 받으면 그 안의 일치만 낸다', () => {
  const d = doc('ab\nab\nab');
  assert.deepEqual(spans(ctx.edFindHits(d, 'ab', OFF, MAX, 3, 5)), [[3, 5]]);
});

// ── 찾기 패널의 순서 ─────────────────────────────────────────────────────────

function fakePanel(query) {
  const cls = new Set(['vis']);
  const els = {
    '.fe-find-q': { value: query },
    '.fe-find-count': { textContent: '' },
    '.fe-find-r': { value: 'X' },
    '.fe-find-rep-one': { disabled: false },
    '.fe-find-rep-all': { disabled: false },
  };
  return {
    els,
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle() {} },
    querySelector: (s) => els[s] || null,
  };
}

// 엔진 대역 — 일치 계산은 진짜(`edFindScan`·`edFindHits`)이고, 화면에 닿는 것만 적어 둔다.
function setup(text, query, opts = {}) {
  const { ctx: c, clock } = loadFind();
  const state = { doc: doc(text) };
  const log = { paints: [], reveals: [], replaced: null, scans: 0 };
  const eng = {
    scan: (q, o) => { log.scans++; return c.edFindScan(state.doc, q, o, MAX) },
    visibleHits: (q, o) => c.edFindHits(state.doc, q, o, MAX, 0, state.doc.line(Math.min(3, state.doc.lines)).to),
    paint: (hits, cur) => log.paints.push({ n: hits.length, cur }),
    reveal: (h) => log.reveals.push([h.from, h.to]),
    replace: (edits) => { log.replaced = edits.length },
    focus() {},
  };
  const host = Object.create(c.ED_FIND_MIXIN);
  host._find = fakePanel(query);
  host._findOpts = { ...OFF, ...opts };
  host._findHits = [];
  host._findCur = 0;
  host._alive = true;
  host._findEngine = () => (host._alive ? eng : null);
  const count = () => host._find.els['.fe-find-count'].textContent;
  return { c, clock, state, log, host, count };
}

const BIG = Array.from({ length: 95 }, (_, i) => `line ${i} needle`).join('\n');

test('작은 문서(묶음 하나 이하)는 입력 즉시 끝까지 센다 — 종전 동작 그대로', () => {
  const { host, clock, count } = setup('needle\nneedle\nx needle', 'needle');
  host._findRun();
  assert.equal(count(), '1/3');
  assert.equal(host._findHits.length, 3);
  assert.equal(clock.pending(), 0);
});

test('큰 문서는 입력 직후 보이는 구간만 칠하고, 전체 계산은 입력이 멎을 때까지 미룬다', async () => {
  const { host, clock, log, count } = setup(BIG, 'needle');
  host._findRun();
  assert.equal(count(), BUSY);
  assert.deepEqual(log.paints.at(-1), { n: 3, cur: -1 }, '보이는 세 줄의 일치만, 현재 일치 없이');
  assert.equal(host._findHits.length, 0);
  await clock.advance(DEBOUNCE_MS - 1);
  assert.equal(count(), BUSY, '디바운스가 지나기 전에는 세지 않는다');
});

test('글자를 잇달아 치면 마지막 질의만 끝까지 센다', async () => {
  const { host, clock, log, count } = setup(BIG, 'n');
  host._findRun();
  await clock.advance(50);
  host._find.els['.fe-find-q'].value = 'ne';
  host._findRun();
  await clock.advance(50);
  host._find.els['.fe-find-q'].value = 'needle';
  host._findRun();
  await clock.advance(DEBOUNCE_MS);
  assert.equal(count(), '1/95');
  const steps = log.paints.filter((p) => p.cur !== -1);
  assert.equal(steps.length, 1, '끝까지 센 칠하기는 한 번이다');
});

test('조각 하나는 시간 예산 안에서 멈추고 나머지는 다음 작업으로 넘긴다', async () => {
  const { host, clock } = setup(BIG, 'needle');
  host._findRun();
  host._findSlice();
  // 첫 묶음은 입력 때 센다. 조각은 예산 8 ms, 시계는 부를 때마다 5 ms — 묶음 둘을 더 훑고 멈춘다.
  assert.equal(host._findScan.line, 3 * CHUNK + 1);
  assert.equal(host._findScan.done, false);
  assert.ok(clock.pending() > 0, '다음 조각이 걸려 있다');
});

test('끝까지 센 결과는 한 번에 센 것과 같다', async () => {
  const { host, clock, state, count } = setup(BIG, 'needle');
  host._findRun();
  await clock.advance(DEBOUNCE_MS);
  assert.equal(count(), '1/95');
  assert.deepEqual(spans(host._findHits), spans(full(state.doc, 'needle')));
});

test('세는 동안 누른 다음/이전은 다 센 뒤에 그만큼 옮긴다', async () => {
  const { host, clock, log, count } = setup(BIG, 'needle');
  host._findRun();
  host._findMove(1);
  host._findMove(1);
  assert.equal(count(), BUSY);
  await clock.advance(DEBOUNCE_MS);
  assert.equal(count(), '3/95');
  assert.equal(log.reveals.length, 1);
});

test('세는 동안 모두 바꾸기를 누르면 마저 센 뒤 전부 바꾼다', () => {
  const { host, log } = setup(BIG, 'needle');
  host._findRun();
  host._findReplaceAll();
  assert.equal(log.replaced, 95);
});

test('세는 동안 하나 바꾸기를 누르면 마저 센 뒤 현재 일치를 바꾼다', () => {
  const { host, log } = setup(BIG, 'needle');
  host._findRun();
  host._findReplaceOne();
  assert.equal(log.replaced, 1);
});

test('세는 동안 닫으면 남은 계산이 걷히고 다시 칠하지 않는다', async () => {
  const { host, clock, log } = setup(BIG, 'needle');
  host._findRun();
  host.findClose();
  const n = log.paints.length;
  await clock.advance(DEBOUNCE_MS * 2);
  assert.equal(log.paints.length, n);
  assert.equal(clock.pending(), 0);
});

test('세는 동안 문서가 바뀌면 이전 계산을 버리고 새 문서로 센다 · 현재 자리를 지킨다', async () => {
  const { host, clock, state, count } = setup(BIG, 'needle');
  host._findRun();
  await clock.advance(DEBOUNCE_MS);
  host._findMove(1);
  host._findMove(1);
  assert.equal(count(), '3/95');
  state.doc = doc(BIG + '\nneedle');
  host._findRun(true);
  await clock.advance(DEBOUNCE_MS);
  assert.equal(count(), '3/96');
});

test('질의를 비우면 걸린 계산이 걷힌다', async () => {
  const { host, clock, count } = setup(BIG, 'needle');
  host._findRun();
  host._find.els['.fe-find-q'].value = '';
  host._findRun();
  await clock.advance(DEBOUNCE_MS * 2);
  assert.equal(count(), '');
  assert.equal(clock.pending(), 0);
});

test('편집기가 사라지면 남은 조각은 멈춘다', async () => {
  const { host, clock, log } = setup(BIG, 'needle');
  host._findRun();
  const n = log.paints.length;
  host._alive = false;
  await clock.advance(DEBOUNCE_MS * 2);
  assert.equal(log.paints.length, n);
  assert.equal(clock.pending(), 0);
});
