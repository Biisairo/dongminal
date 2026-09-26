import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-4-8 후속 — Console 증분 커서의 세대.
 *
 * 서버가 다시 뜨면 Seq 가 처음부터다. 새 Seq 가 옛 커서를 넘어서면 `after` 만으로는
 * 이을 수 없음을 서버가 모른다 — 받은 세대(`epoch`)를 되돌려 주어 서버가 gap 을 판정한다.
 */
function setup(answers) {
  const sent = [];
  const ctx = load(['git/console.js'], {
    expose: ['GitConsole'],
    globals: {
      GIT_CON_LIMIT: 500,
      GIT_CON_FAIL: 'fail',
      GIT_STATUS_FETCH_TIMEOUT_MS: 20000,
      visiblePoll: () => ({ stop() {} }),
      apiGet: async (u) => { sent.push(u); return answers.shift() },
    },
  });
  const panel = { repo: '/r', token: () => ({}), isStale: () => false };
  return { con: new ctx.GitConsole(panel), sent };
}

const rec = (seq) => ({ seq, argv: ['status'], exitCode: 0 });
const resp = (d) => ({ ok: true, status: 200, data: { requested: { repo: '/r' }, repo: '/r', ...d } });

test('받은 세대를 다음 물음에 싣고, 세대가 바뀐 gap 응답은 목록을 갈아 끼운다', async () => {
  const { con, sent } = setup([
    resp({ records: [rec(5), rec(4)], lastSeq: 5, firstSeq: 1, gap: false, epoch: 'A' }),
    resp({ records: [rec(7), rec(6)], lastSeq: 7, firstSeq: 1, gap: true, epoch: 'B' }),
    resp({ records: [], lastSeq: 7, firstSeq: 1, gap: false, epoch: 'B' }),
  ]);
  await con.reload();
  assert.equal(new URL(sent[0], 'http://x').searchParams.get('epoch'), null, '첫 물음은 세대를 모른다');
  await con.reload();
  const q1 = new URL(sent[1], 'http://x').searchParams;
  assert.equal(q1.get('after'), '5');
  assert.equal(q1.get('epoch'), 'A', '받은 세대를 되돌려 주지 않았다');
  assert.deepEqual(con._recs.map((r) => r.seq), [7, 6], '옛 세대의 기록이 남았다');
  await con.reload();
  assert.equal(new URL(sent[2], 'http://x').searchParams.get('epoch'), 'B');
});

test('리포가 바뀌면 세대도 버린다', async () => {
  const { con, sent } = setup([
    resp({ records: [rec(5)], lastSeq: 5, firstSeq: 1, gap: false, epoch: 'A' }),
    resp({ records: [], lastSeq: 5, firstSeq: 1, gap: false, epoch: 'A' }),
  ]);
  await con.reload();
  con.reset();
  await con.reload();
  const q = new URL(sent[1], 'http://x').searchParams;
  assert.equal(q.get('after'), '0');
  assert.equal(q.get('epoch'), null);
});
