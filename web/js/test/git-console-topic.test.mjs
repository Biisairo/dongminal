import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, GITVIEW, load } from './harness.mjs';

/**
 * PERF_OPTIMIZATION_SRS M1 C6 (`perf/CHANNEL_PROTOCOL.md` §10.7 TC-CH6-7) — Console 탭은 주기로 묻지 않는다.
 * 보이는 동안 `gitconsole:<root>` 를 구독하고, 그 저장소에 새 기록이 있을 때만 `after` 로 그 뒤를 받는다.
 */
function setup() {
  const sent = [];
  const subs = [];
  const answers = [];
  const ctx = load([...BASE, 'core/constants-api.js', 'git/api.js', ...GITVIEW, 'git/console.js'], {
    expose: ['GitConsole'],
    globals: {
      GIT_CON_LIMIT: 500,
      GIT_CON_FAIL: 'fail',
      GIT_STATUS_FETCH_TIMEOUT_MS: 20000,
      visiblePoll: () => { throw new Error('Console 이 주기 재조회를 걸었다') },
      apiGet: async (_p, o) => { sent.push(o && o.query ? o.query : {}); return answers.shift() },
    },
  });
  const channel = {
    sub(topic, fn) {
      const s = { topic, fn, live: true, stop() { s.live = false } };
      subs.push(s);
      return s;
    },
  };
  const panel = { repo: '/r', token: () => ({}), isStale: () => false, app: { channel } };
  const con = new ctx.GitConsole(panel);
  const cls = new Set(['vis']);
  con.el = { isConnected: true, classList: { contains: (c) => cls.has(c) }, querySelector: () => null };
  con._paintList = () => {};
  return { con, sent, subs, answers, cls };
}

const resp = (d) => ({ ok: true, status: 200, data: { requested: { repo: '/r' }, repo: '/root', records: [], firstSeq: 1, gap: false, epoch: 'E', ...d } });
const flush = () => new Promise((r) => setTimeout(r, 0));

test('TC-CH6-7: 보이는 Console 은 받은 루트의 gitconsole 토픽을 하나 구독한다', async () => {
  const { con, subs, answers } = setup();
  answers.push(resp({ lastSeq: 5 }));
  await con.reload();
  con.paint();
  con.paint();
  assert.deepEqual(subs.filter((s) => s.live).map((s) => s.topic), ['gitconsole:/root']);
});

test('TC-CH6-7: 새 기록이 있을 때만 다시 받고, 받은 뒤 것만 묻는다', async () => {
  const { con, subs, sent, answers } = setup();
  answers.push(resp({ lastSeq: 5 }));
  await con.reload();
  con.paint();
  const s = subs.at(-1);
  s.fn({ kind: 'full', data: { seq: 5, epoch: 'E' } });
  await flush();
  assert.equal(sent.length, 1, '새 기록이 없는데 다시 물었다');
  answers.push(resp({ lastSeq: 7 }));
  s.fn({ kind: 'full', data: { seq: 7, epoch: 'E' } });
  await flush();
  assert.equal(sent.length, 2);
  assert.equal(String(sent[1].after), '5');
});

test('TC-CH6-7: 세대가 바뀌면 다시 받는다', async () => {
  const { con, subs, sent, answers } = setup();
  answers.push(resp({ lastSeq: 5 }));
  await con.reload();
  con.paint();
  answers.push(resp({ lastSeq: 1, gap: true, epoch: 'F' }));
  subs.at(-1).fn({ kind: 'full', data: { seq: 1, epoch: 'F' } });
  await flush();
  assert.equal(sent.length, 2);
});

test('TC-CH6-7: 보이지 않으면 구독을 놓고, 저장소가 바뀌거나 내려가면 놓는다', async () => {
  const { con, subs, sent, answers, cls } = setup();
  answers.push(resp({ lastSeq: 5 }));
  await con.reload();
  con.paint();
  cls.delete('vis');
  subs.at(-1).fn({ kind: 'full', data: { seq: 9, epoch: 'E' } });
  await flush();
  assert.equal(subs.at(-1).live, false, '숨은 Console 이 구독을 쥐었다');
  assert.equal(sent.length, 1, '숨은 Console 이 다시 물었다');
  cls.add('vis');
  con.paint();
  assert.equal(subs.at(-1).live, true);
  con.reset();
  assert.equal(subs.at(-1).live, false, '저장소가 바뀌었는데 옛 토픽을 쥐었다');
  answers.push(resp({ lastSeq: 5 }));
  await con.reload();
  con.paint();
  con.unmount();
  assert.equal(subs.filter((s) => s.live).length, 0);
});
