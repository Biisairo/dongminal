import assert from 'node:assert/strict';
import test from 'node:test';

import { load } from './harness.mjs';

/**
 * `git/input-answer.js` (SERVER_DRIVEN_ACTIONS_SRS GV-d · TC-SDA-2).
 *
 * 대화상자는 입력의 옳고 그름을 스스로 정하지 않는다 — 서버에 묻고 그 답을 그린다.
 * 이 장치가 아는 것은 답·묻는 중·요청 실패 셋뿐이다.
 */
function setup() {
  const timers = [];
  const calls = [];
  const ctx = load(['core/i18n.js', 'core/action-answer.js', 'git/input-answer.js'], {
    expose: ['I18N', 'GitInputAnswer'],
    globals: {
      localStorage: { getItem: () => 'ko', setItem() {} },
      document: { documentElement: { setAttribute() {} }, querySelectorAll: () => [] },
      GIT_API: { actions: '/api/git/actions' },
      GIT_BR_VALIDATE_DEBOUNCE_MS: 200,
      GIT_DIALOG_WHY: 'why',
      GIT_DIALOG_WHY_PENDING: 'pending',
      TIMERS: {
        after(_ms, fn) { timers.push(fn); return timers.length },
        cancel(id) { if (id) timers[id - 1] = null },
      },
      // 실제 gitFetch 처럼 응답 때 stale 가드를 묻는다.
      gitFetch(url, q, o) {
        return new Promise(res => calls.push({ url, q, o, res: v => res(o.stale() ? { stale: true } : v) }));
      },
    },
  });
  ctx.I18N.register('ko', {
    'why.loading': '확인하는 중',
    'why.empty_name': '이름을 적으세요',
    'why.branch_exists': '{branch} 가 이미 있습니다',
  });
  ctx.I18N.register('en', {});
  const dialog = { alive: () => true, painted: [], setWhy(kind, why) { this.painted.push({ kind, why }) } };
  const ans = new ctx.GitInputAnswer({
    repo: '/r', id: 'git.stash.branch',
    params: v => ({ name: (v.name || '').trim() }),
    fail: () => '실패',
  });
  const flush = () => { const fns = timers.splice(0); for (const f of fns) if (f) f() };
  const reply = (i, data, ok = true) => calls[i].res(ok ? { ok: true, data } : { ok: false, code: 500, data: {} });
  const answer = (a) => ({ actions: { 'git.stash.branch': a } });
  return { ans, dialog, calls, flush, reply, answer };
}

const tick = () => new Promise(r => setImmediate(r));

test('첫 답 전에는 loading 사유로 실행을 막는다 (FR-SDA-6)', () => {
  const { ans, dialog } = setup();
  const s = ans.why({ name: 'x' }, dialog);
  assert.equal(s.kind, 'why');
  assert.equal(s.why, '확인하는 중');
});

test('입력은 멈춘 뒤 묻고, 묻는 값은 params 가 정한다', () => {
  const { ans, dialog, calls, flush } = setup();
  ans.why({ name: ' x ' }, dialog);
  assert.equal(calls.length, 0, '멈추기 전에 묻지 않는다');
  flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/git/actions');
  assert.equal(calls[0].q.action, 'git.stash.branch');
  assert.equal(calls[0].q.repo, '/r');
  assert.equal(calls[0].q.name, 'x');
});

test('거짓 답은 사유 코드의 문구로, 참 답은 열림으로 그린다', async () => {
  const { ans, dialog, flush, reply, answer } = setup();
  ans.why({ name: 'main' }, dialog);
  flush();
  reply(0, answer({ ok: false, why: 'branch_exists', args: { branch: 'main' } }));
  await tick();
  assert.deepEqual(dialog.painted.at(-1), { kind: 'why', why: 'main 가 이미 있습니다' });
  assert.deepEqual({ ...ans.why({ name: 'main' }, dialog) }, { kind: 'why', why: 'main 가 이미 있습니다' });

  ans.why({ name: 'new' }, dialog);
  flush();
  reply(1, answer({ ok: true }));
  await tick();
  assert.deepEqual(dialog.painted.at(-1), { kind: '', why: '' });
});

test('판정에 쓰이는 입력이 같으면 다시 묻지 않는다', () => {
  const { ans, dialog, calls, flush } = setup();
  ans.why({ name: 'x', other: 1 }, dialog);
  flush();
  ans.why({ name: 'x ', other: 2 }, dialog);
  flush();
  assert.equal(calls.length, 1);
});

test('다시 묻는 동안 실행만 막고 앞선 사유는 그대로 둔다 (GR-3d)', async () => {
  const { ans, dialog, flush, reply, answer } = setup();
  ans.why({ name: '' }, dialog);
  flush();
  reply(0, answer({ ok: false, why: 'empty_name' }));
  await tick();
  const s = ans.why({ name: 'a' }, dialog);
  assert.equal(s.kind, 'pending');
  assert.equal(s.why, '이름을 적으세요');
});

test('늦게 온 앞선 답은 버린다 — 지금 입력의 답만 그린다', async () => {
  const { ans, dialog, flush, reply, answer } = setup();
  ans.why({ name: 'main' }, dialog);
  flush();
  ans.why({ name: 'new' }, dialog);
  flush();
  reply(1, answer({ ok: true }));
  reply(0, answer({ ok: false, why: 'branch_exists', args: { branch: 'main' } }));
  await tick();
  assert.deepEqual(dialog.painted, [{ kind: '', why: '' }]);
});

test('stale 가드: 앞선 세대의 요청은 stale 로 읽힌다', () => {
  const { ans, dialog, calls, flush } = setup();
  ans.why({ name: 'a' }, dialog);
  flush();
  ans.why({ name: 'b' }, dialog);
  flush();
  assert.equal(calls[0].o.stale(), true);
  assert.equal(calls[1].o.stale(), false);
});

test('묻지 못했으면 fail 의 사유로 실행을 막는다', async () => {
  const { ans, dialog, flush, reply } = setup();
  ans.why({ name: 'x' }, dialog);
  flush();
  reply(0, null, false);
  await tick();
  assert.deepEqual(dialog.painted.at(-1), { kind: 'why', why: '실패' });
});

test('onChange 를 주면 setWhy 대신 그것을 부른다 — 다른 사유와 합치는 대화상자', async () => {
  const seen = [];
  const { dialog, calls, reply, answer } = setup();
  const ctx = load(['core/i18n.js', 'core/action-answer.js', 'git/input-answer.js'], {
    expose: ['GitInputAnswer'],
    globals: {
      localStorage: { getItem: () => 'ko', setItem() {} },
      document: { documentElement: { setAttribute() {} }, querySelectorAll: () => [] },
      GIT_API: { actions: '/api/git/actions' }, GIT_BR_VALIDATE_DEBOUNCE_MS: 0,
      GIT_DIALOG_WHY: 'why', GIT_DIALOG_WHY_PENDING: 'pending',
      TIMERS: { after(_ms, fn) { fn(); return 1 }, cancel() {} },
      gitFetch: (url, q, o) => new Promise(res => calls.push({ url, q, o, res })),
    },
  });
  const ans = new ctx.GitInputAnswer({
    repo: '/r', id: 'git.stash.branch', params: v => ({ name: v.name }), fail: () => '',
    onChange: s => seen.push(s),
  });
  ans.why({ name: 'x' }, dialog);
  reply(0, answer({ ok: true }));
  await tick();
  assert.equal(seen.length, 1);
  assert.deepEqual({ ...seen[0] }, { kind: '', why: '' });
  assert.equal(dialog.painted.length, 0);
});
