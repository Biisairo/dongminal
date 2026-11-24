import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * `web/js/git/git-poll.js` 의 실효 주기(`_cadence`)와 토픽 구독 (PERF_OPTIMIZATION_SRS M1 C4).
 *
 * e2e 에서 옮겨 왔다 (E2E_PRUNE_REPORT §8.3):
 *   - `git-repo-missing` B3 (V-RMS-18·26 · V-GRF-13) — 브라우저를 띄워 `_cadence` 값만 읽었다
 */

const MISSING_MS = 30000;
const BACKOFF_MAX_MS = 300000;

function poll() {
  const armed = [];
  // 상수는 실제 파일에서 싣는다 — 기대값(30000·300000)은 종전 e2e 가 단정하던 값이다.
  const ctx = load(['core/constants-git-detect.js', ...BASE, 'git/git-part.js', 'git/git-poll.js'], {
    expose: ['GitPoll'],
    globals: {
      t: () => '',
      MS_PER_SEC: 1000,
      TIMERS: { every: (o) => { armed.push(o); return { stop() {} } } },
    },
  });
  // 패널 대역 — 관측 상태는 패널의 공용 필드다.
  const watched = [];
  const p = {
    app: { git: { topics: { watch: (root) => { const w = { root, stopped: false }; watched.push(w); return { stop() { w.stopped = true } } } } } },
    repo: '/r', root: '', _missing: null, _failStreak: 0, _notRepo: false,
    _lastObsAt: 0, _pollOn: false, _pollSt: null, _stPoll: null, _status: null,
    _obsSig: null, _lastViewFp: null,
    obs: { pollOkAny: () => true },
  };
  p.poll = new ctx.GitPoll(p);
  p.poll._pollOk = () => true;
  return { ctx, p, armed, watched };
}

test('B3 (V-RMS-18·26): 백오프는 기준 × 2ⁿ 이고 상한을 넘지 않는다', () => {
  const { p } = poll();
  p._failStreak = 0;
  assert.equal(p.poll._cadence(1000), 1000);
  p._failStreak = 2;
  assert.equal(p.poll._cadence(1000), 4000);
  p._failStreak = 20;
  assert.equal(p.poll._cadence(1000), BACKOFF_MAX_MS);
});

test('B3 (V-GRF-13): 기본 주기(30초)에서도 백오프가 실제로 는다', () => {
  const { p } = poll();
  p._failStreak = 1;
  assert.equal(p.poll._cadence(30000), 60000, '기본 주기에서 백오프 1단계가 늘지 않았다');
  p._failStreak = 2;
  assert.equal(p.poll._cadence(30000), 120000, '기본 주기에서 백오프 2단계가 늘지 않았다');
});

test('B3 (V-RMS-26): 소실은 고정 주기다 — 점증하지 않는다', () => {
  const { p } = poll();
  p._missing = '/gone';
  p._failStreak = 20;
  assert.equal(p.poll._cadence(1000), MISSING_MS, '소실인데 고정 주기가 아니다');
});

test('TC-CH4-16: 평상시에는 git:<root> 토픽을 구독하고 주기 타이머를 걸지 않는다', () => {
  const { p, armed, watched } = poll();
  p._status = { repo: '/private/r' };
  assert.equal(p.poll._applyCadence(), true);
  assert.equal(armed.length, 0, '평상시에 status 주기가 걸렸다');
  assert.deepEqual(watched.map((w) => w.root), ['/private/r'], '서버가 푼 루트를 구독해야 한다');
  assert.equal(p.poll._applyCadence(), false, '같은 조건에서 다시 걸었다');
  p.obs.pollOkAny = () => false;
  p.poll._applyCadence();
  assert.equal(watched[0].stopped, true, '보는 표면이 없는데 구독이 남았다');
});

test('TC-CH4-17: 실패·소실 동안에만 회복용 주기를 건다', () => {
  const { p, armed, watched } = poll();
  p._failStreak = 1;
  p.poll._applyCadence();
  assert.equal(armed.length, 1);
  assert.equal(armed[0].every(), 60000, '회복 주기는 백오프다');
  assert.equal(watched.length, 1, '실패 중에도 토픽은 구독한다');
  p._failStreak = 0;
  p.poll._applyCadence();
  assert.equal(armed.length, 1, '회복한 뒤에도 주기가 다시 걸렸다');
});
