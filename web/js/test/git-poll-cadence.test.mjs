import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * `web/js/git/git-poll.js` 의 실효 주기(`_cadence`)와 `git-watchdog.js` 의 주기 0 규약.
 *
 * e2e 에서 옮겨 왔다 (E2E_PRUNE_REPORT §8.3):
 *   - `git-repo-missing` B3 (V-RMS-18·26 · V-GRF-13) — 브라우저를 띄워 `_cadence` 값만 읽었다
 *   - `git-refresh-lifecycle` V-GRF-2 (FR-GRF-2) — 워치독(1초 상수)의 되풀이 여부를 3초 창으로 쟀다
 */

const MISSING_MS = 30000;
const BACKOFF_MAX_MS = 300000;

function poll(interval) {
  const armed = [];
  // 상수는 실제 파일에서 싣는다 — 기대값(30000·300000)은 종전 e2e 가 단정하던 값이다.
  const ctx = load(['core/constants-git-detect.js', ...BASE, 'git/git-part.js', 'git/git-poll.js', 'git/git-watchdog.js'], {
    expose: ['GitPoll', 'GitWatchdog'],
    globals: {
      t: () => '',
      gitStatusInterval: interval,
      GIT_STATUS_POLL_MS: 30000,
      MS_PER_SEC: 1000,
      TIMERS: { every: (o) => { armed.push(o); return { stop() {} } } },
    },
  });
  // 패널 대역 — 관측 상태는 패널의 공용 필드다.
  const p = {
    app: {}, repo: '/r', root: '', _missing: null, _failStreak: 0, _notRepo: false,
    _lastObsAt: 0, _wdTryAt: 0, _pollOn: false, _pollSt: null, _stPoll: null,
    _obsSig: null, _lastViewFp: null,
    obs: { pollOkAny: () => true },
  };
  p.poll = new ctx.GitPoll(p);
  p.watchdog = new ctx.GitWatchdog(p);
  p.poll._pollOk = () => true;
  return { ctx, p, armed };
}

test('B3 (V-RMS-18·26): 백오프는 기준 × 2ⁿ 이고 상한을 넘지 않는다', () => {
  const { p } = poll(1000);
  p._failStreak = 0;
  assert.equal(p.poll._cadence(1000), 1000);
  p._failStreak = 2;
  assert.equal(p.poll._cadence(1000), 4000);
  p._failStreak = 20;
  assert.equal(p.poll._cadence(1000), BACKOFF_MAX_MS);
});

test('B3 (V-GRF-13): 기본 주기(30초)에서도 백오프가 실제로 는다', () => {
  const { p } = poll(30000);
  p._failStreak = 1;
  assert.equal(p.poll._cadence(30000), 60000, '기본 주기에서 백오프 1단계가 늘지 않았다');
  p._failStreak = 2;
  assert.equal(p.poll._cadence(30000), 120000, '기본 주기에서 백오프 2단계가 늘지 않았다');
});

test('B3 (V-RMS-18): 기준 0 은 백오프에도 0 이다', () => {
  const { p } = poll(0);
  p._failStreak = 5;
  assert.equal(p.poll._cadence(0), 0, '꺼 둔 계층이 백오프로 되살아났다');
});

test('B3 (V-RMS-26): 소실은 고정 주기다 — 점증하지 않고 0 을 되살리지 않는다', () => {
  const { p } = poll(1000);
  p._missing = '/gone';
  p._failStreak = 20;
  assert.equal(p.poll._cadence(1000), MISSING_MS, '소실인데 고정 주기가 아니다');
  assert.equal(p.poll._cadence(0), 0, '소실이 꺼 둔 계층을 되살렸다');
});

test('V-GRF-2 (FR-GRF-2): 주기 0 에서 워치독은 1회만 수집하고 타이머를 걸지 않는다', async () => {
  const { ctx, p, armed } = poll(0);
  let collects = 0;
  // 성공한 관측 대역 — `_adoptObs` 가 하는 일 중 이 규약에 닿는 둘(관측 시각·주기 재평가)이다.
  p.poll.collect = function () {
    collects++;
    p._lastObsAt = ctx._clock.now();
    this._applyCadence();
  };
  // V-GRF-1 의 상태: 한 번도 관측이 없고 폴링은 주기 0 으로 서 있다 (`11 GP-2`).
  Object.assign(p, { _lastObsAt: 0, _wdTryAt: 0, _pollOn: true, _pollSt: 0 });

  // 워치독은 `GIT_WATCHDOG_CHECK_MS`(1초)마다 돈다. 종전 e2e 의 3초 창보다 길게, 묻기 문턱
  // (`GIT_STATUS_POLL_MS` 30초)을 넘기는 40회를 돌린다.
  for (let i = 0; i < 40; i++) {
    p.watchdog.run();
    await ctx._clock.advance(1000);
  }
  assert.equal(collects, 1, `주기 0 인데 요청이 되풀이된다 (${collects}회)`);
  assert.equal(armed.length, 0, '주기 0 인데 타이머가 걸렸다');
  assert.equal(p._stPoll, null);
});
