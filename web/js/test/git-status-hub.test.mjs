import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeClock, load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-4-1 · FR-OPT-4-7 — GitStatusHub.
 *
 * 같은 root 의 `/api/git/status` 를 탐색기·dirty-diff 가 한 벌로 나눠 쓴다. 세는 것은
 * 요청 수다 (FR-OPT-0-4).
 */
function setup(answer) {
  const clock = fakeClock();
  const sent = [];
  const waits = [];
  const ctx = load(['git/status-hub.js'], {
    clock,
    expose: ['GitStatusHub', 'gitStatusMerge'],
    globals: {
      GIT_STATUS_API: '/api/git/status',
      GIT_STATUS_FETCH_TIMEOUT_MS: 20000,
      GIT_STATUS_HUB_TTL_MS: 500,
      apiGet: (path, opts) => {
        sent.push({ path, query: { ...opts.query }, timeout: opts.timeout });
        return new Promise((resolve) => waits.push(() => resolve(answer(opts.query, sent.length))));
      },
    },
  });
  let cid = 'c-1';
  const hub = new ctx.GitStatusHub({ clientId: () => cid });
  const flush = async () => { while (waits.length) waits.shift()(); await clock.advance(0) };
  return { hub, sent, flush, clock, merge: ctx.gitStatusMerge, setCid: (v) => { cid = v } };
}

const full = (mark, extra = {}) => ({
  ok: true, status: 200,
  data: { repo: '/r', requested: '/r', isRepo: true, rootMatch: true, mark, status: { untracked: [] }, ...extra },
});

test('같은 root 의 동시 물음은 한 요청을 나눠 쓴다 (single-flight)', async () => {
  const { hub, sent, flush } = setup(() => full('m1'));
  const a = hub.ask('/r'), b = hub.ask('/r'), c = hub.ask('/r');
  await flush();
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.equal(sent.length, 1);
  assert.equal(ra.data.mark, 'm1');
  assert.equal(rb, ra);
  assert.equal(rc, ra);
});

test('TTL 안의 다음 물음은 요청하지 않고, 지나면 다시 묻는다', async () => {
  const { hub, sent, flush, clock } = setup(() => full('m1'));
  const p = hub.ask('/r'); await flush(); await p;
  await hub.ask('/r');
  assert.equal(sent.length, 1, 'TTL 안');
  await clock.advance(500);
  const q = hub.ask('/r'); await flush(); await q;
  assert.equal(sent.length, 2, 'TTL 뒤');
});

test('요청은 clientId 를 싣는다 — 탐색기도 서버 감시의 임대를 쥔다 (IPC-8)', async () => {
  const { hub, sent, flush, setCid } = setup(() => full('m1'));
  const p = hub.ask('/r'); await flush(); await p;
  assert.equal(sent[0].query.clientId, 'c-1');
  assert.equal(sent[0].timeout, 20000);
  setCid('');
  hub.invalidate();
  const q = hub.ask('/r'); await flush(); await q;
  assert.equal('clientId' in sent[1].query, false, '신원이 없으면 싣지 않는다');
});

test('invalidate 뒤에는 캐시도, 그 전에 떠난 요청도 나눠 쓰지 않는다', async () => {
  const { hub, sent, flush } = setup(() => full('m1'));
  const before = hub.ask('/r');
  hub.invalidate();
  const after = hub.ask('/r');
  const again = hub.ask('/r');
  assert.equal(sent.length, 2, '무효화 뒤의 첫 물음은 새 요청이다');
  await flush();
  await Promise.all([before, after, again]);
  assert.equal(await again, await after, '무효화 뒤의 물음끼리는 나눠 쓴다');
});

test('가진 관측의 mark 를 ifMark 로 싣고, unchanged 답은 가진 본문으로 채운다 (FR-OPT-4-7)', async () => {
  const { hub, sent, flush } = setup((q, n) => (n === 1 ? full('m1', { observedAtUnixMs: 1 })
    : { ok: true, status: 200, data: { repo: '/r', requested: '/r', isRepo: true, rootMatch: true, mark: q.ifMark, unchanged: true } }));
  const p = hub.ask('/r'); await flush(); await p;
  assert.equal('ifMark' in sent[0].query, false, '처음에는 가진 것이 없다');
  hub.invalidate();
  const q = hub.ask('/r'); await flush();
  const r = await q;
  assert.equal(sent[1].query.ifMark, 'm1');
  assert.equal(r.ok, true);
  assert.equal(r.data.mark, 'm1');
  assert.deepEqual(r.data.status, { untracked: [] }, '목록은 가진 본문의 것이다');
  assert.equal('unchanged' in r.data, false, '소비자는 생략을 몰라도 된다');
});

test('옛 서버는 ifMark 를 모르고 전량으로 답한다 — 그대로 쓴다', async () => {
  const { hub, flush } = setup((q, n) => full(n === 1 ? 'm1' : 'm2'));
  let p = hub.ask('/r'); await flush(); await p;
  hub.invalidate();
  p = hub.ask('/r'); await flush();
  assert.equal((await p).data.mark, 'm2');
});

test('비저장소 답 뒤에는 ifMark 를 싣지 않는다', async () => {
  const { hub, sent, flush } = setup((q, n) => (n === 2
    ? { ok: true, status: 200, data: { isRepo: false, requested: '/r', mark: '' } } : full('m1')));
  for (let k = 0; k < 3; k++) { hub.invalidate(); const p = hub.ask('/r'); await flush(); await p }
  assert.equal(sent[1].query.ifMark, 'm1');
  assert.equal('ifMark' in sent[2].query, false);
});

test('feed 로 받은 패널의 관측을 peek 가 준다 — 탐색기가 요청 없이 칠한다 (FEU-M1)', async () => {
  const { hub, sent, clock } = setup(() => full('x'));
  assert.equal(hub.peek('/r'), null);
  hub.feed('/r', full('m7'));
  const got = hub.peek('/r');
  assert.equal(got.data.mark, 'm7');
  assert.equal(got.at, clock.now());
  assert.equal((await hub.ask('/r')).data.mark, 'm7', 'TTL 안에서는 feed 도 캐시다');
  assert.equal(sent.length, 0);
  hub.feed('/r', { ok: false, status: 0, data: null });
  assert.equal(hub.peek('/r').data.mark, 'm7', '실패는 가진 관측을 지우지 않는다');
});

test('짝이 맞지 않는 생략은 전송 실패와 같은 길로 간다 — 이전 화면을 지킨다', () => {
  const { merge } = setup(() => full('x'));
  const un = { ok: true, status: 200, data: { mark: 'm2', unchanged: true } };
  const r = merge(un, full('m1').data);
  assert.deepEqual({ ok: r.ok, status: r.status, data: r.data }, { ok: false, status: 0, data: null });
  assert.equal(merge(un, null).status, 0, '가진 본문이 없는데 생략됐다');
  const plainR = full('m3');
  assert.equal(merge(plainR, full('m1').data), plainR, '전량 답은 그대로다');
});

// Ofix2: feed 도 seq/done 순서에 선다. 패널은 떠날 때 번호를 받고(`depart`) 그 번호로
// feed 한다 — 먼저 떠난 요청의 늦은 답이 나중에 떠난 관측을 덮지 않는다.
test('먼저 떠난 ask 의 늦은 답이 나중에 떠난 패널 관측(feed)을 덮지 않는다', async () => {
  const { hub, flush } = setup(() => full('m1'));
  const p = hub.ask('/r');
  const t = hub.depart('/r');
  hub.feed('/r', full('m2'), t);
  await flush(); await p;
  assert.equal(hub.peek('/r').data.mark, 'm2', '옛 flight 가 feed 된 새 본문을 덮었다');
});

test('먼저 떠난 패널 관측의 늦은 feed 는 나중에 떠난 ask 의 답을 덮지 않는다', async () => {
  const { hub, flush } = setup(() => full('m2'));
  const t = hub.depart('/r');
  const p = hub.ask('/r');
  await flush(); await p;
  hub.feed('/r', full('m1'), t);
  assert.equal(hub.peek('/r').data.mark, 'm2', '늦은 feed 가 새 답을 덮었다');
});
