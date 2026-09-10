import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock } from './harness.mjs';

/**
 * `web/js/core/timer-hub.js` — 앱의 모든 주기가 지나는 단일 스케줄러.
 *
 * **우선순위 2** 다 (`05-test.md §3.4`). `scripts/check-timers.sh` 가 앱의 모든
 * 타이머를 이 한 클래스로 강제하므로, 여기의 규약이 깨지면 앱 전체의 갱신이
 * 함께 깨진다. 지금 그것을 재는 것은 브라우저를 띄우는 e2e 두 파일(1,136줄)이고
 * 그 대부분이 순수 로직이다.
 *
 * **가짜 시계로 잰다.** 실시간을 기다리면 검사가 느리고 흔들린다 — 여기서
 * 재려는 것은 "언제 깨어나는가" 이지 브라우저의 최소 지연이 아니다.
 */
function hub() {
  const clock = fakeClock();
  const ctx = load(['core/timer-hub.js'], { clock, expose: ['TimerHub', 'TIMERS'] });
  return { clock, ctx, TIMERS: ctx.TIMERS, doc: ctx.document };
}

test('every: 주기마다 한 번 돈다', async () => {
  const { clock, TIMERS } = hub();
  let n = 0;
  TIMERS.every({ id: 'a', every: () => 100, run: () => { n++ } });
  await clock.advance(350);
  assert.equal(n, 3, '350ms 에 100ms 주기가 3회여야 한다');
});

test('every: 주기 0 은 그 계층을 아예 걸지 않는다 (FR-GIT-23)', async () => {
  const { clock, TIMERS } = hub();
  let n = 0;
  TIMERS.every({ id: 'a', every: () => 0, run: () => { n++ } });
  await clock.advance(10_000);
  assert.equal(n, 0, '주기 0 인데 돌았다');
});

test('every: 주기는 값이 아니라 함수다 — 중간에 바뀌면 따라간다 (FR-SCH-4)', async () => {
  const { clock, TIMERS } = hub();
  let ms = 100, n = 0;
  TIMERS.every({ id: 'a', every: () => ms, run: () => { n++ } });
  await clock.advance(250);
  const first = n;
  ms = 1000;
  await clock.advance(2500);
  assert.ok(n > first, '주기를 늘렸더니 아예 멈췄다');
  assert.ok(n - first <= 3, '주기를 늘렸는데 옛 주기로 계속 돈다: ' + (n - first));
});

test('immediate: 걸자마자 한 번 돈다', async () => {
  const { TIMERS } = hub();
  let n = 0;
  TIMERS.every({ id: 'a', every: () => 1000, run: () => { n++ }, immediate: true });
  assert.equal(n, 1);
});

test('when 이 거짓이면 콜백이 돌지 않는다', async () => {
  const { clock, TIMERS } = hub();
  let n = 0, on = false;
  TIMERS.every({ id: 'a', every: () => 100, when: () => on, run: () => { n++ } });
  await clock.advance(500);
  assert.equal(n, 0);
  on = true;
  await clock.advance(500);
  assert.ok(n > 0, '조건이 참이 됐는데도 돌지 않는다 — 조건은 주기마다 다시 물어야 한다');
});

/**
 * SCHEDULER_REARM_SRS FR-SRA-1·2 의 회귀 검사.
 *
 * 돌지 않고 나가는 갈래가 마감을 **과거에 남긴 채** 물러나면, 과거의 마감이
 * 언제나 "가장 이른 마감" 이므로 스케줄러가 최소 지연마다 되풀이해 깨어난다.
 * 실측에서 주기 50ms 짜리가 조건 거짓인 400ms 동안 85회 깨어났다.
 */
test('조건이 거짓인 동안 스케줄러가 폭주하지 않는다 (FR-SRA-1)', async () => {
  const { clock, TIMERS } = hub();
  // `when` 이 불린 횟수가 곧 스케줄러가 깨어난 횟수다 — `_fire` 가 `_alive` 를
  // 지나며 매번 묻는다. 마감을 과거에 남기면 이 수가 폭발한다.
  let asked = 0;
  TIMERS.every({ id: 'a', every: () => 50, when: () => { asked++; return false }, run: () => {} });
  await clock.advance(400);
  // 400ms / 50ms = 8 회가 제자리다. 실측된 결함은 85회였다.
  assert.ok(asked <= 12, '조건이 거짓인 동안 스케줄러가 ' + asked + '회 깨어났다 (제자리 8회)');
  assert.ok(asked >= 6, '아예 깨어나지 않는다 — 조건이 참으로 바뀌어도 돌지 않는다: ' + asked);
  assert.equal(TIMERS.pending().length, 1, '조건이 거짓이라고 job 이 사라졌다 — 멈추는 것과 없어지는 것은 다르다');
});

test('stop: 멈춘 job 은 더 돌지 않는다', async () => {
  const { clock, TIMERS } = hub();
  let n = 0;
  const h = TIMERS.every({ id: 'a', every: () => 100, run: () => { n++ } });
  await clock.advance(150);
  h.stop();
  const at = n;
  await clock.advance(1000);
  assert.equal(n, at, '멈춘 job 이 계속 돈다');
});

test('poke: 주기를 기다리지 않고 즉시 한 번 돈다', async () => {
  const { TIMERS } = hub();
  let n = 0;
  const h = TIMERS.every({ id: 'a', every: () => 100_000, run: () => { n++ } });
  h.poke();
  assert.equal(n, 1);
});

test('같은 id 로 다시 걸면 앞의 것을 대체한다 — 두 벌이 되지 않는다', async () => {
  const { clock, TIMERS } = hub();
  let n = 0;
  TIMERS.every({ id: 'a', every: () => 100, run: () => { n++ } });
  TIMERS.every({ id: 'a', every: () => 100, run: () => { n++ } });
  await clock.advance(150);
  assert.equal(n, 1, '같은 id 가 두 벌로 돈다');
  assert.equal(TIMERS.pending().length, 1);
});

/**
 * POLL_INTERVAL_SETTINGS_SRS FR-PIS-14 / D-8a.
 *
 * 전부 다시 걸면 설정을 한 번 만질 때마다 모든 폴링의 다음 회차가 뒤로 밀린다.
 * 그리고 **발화하지 않는다** — 주기를 바꾼 것은 수집의 계기가 아니다. 다른
 * 창에서 바뀐 값이 SSE 로 올 때 열린 창 전부가 요청을 내면 그것이 폭주다.
 */
test('refreshChanged: 주기가 바뀐 job 만 다시 건다', async () => {
  const { TIMERS } = hub();
  let msA = 100;
  TIMERS.every({ id: 'a', every: () => msA, run: () => {} });
  TIMERS.every({ id: 'b', every: () => 200, run: () => {} });
  assert.equal(TIMERS.refreshChanged(), 0, '바뀐 것이 없는데 다시 걸었다');
  msA = 500;
  assert.equal(TIMERS.refreshChanged(), 1, '바뀐 하나만 다시 걸어야 한다');
});

test('refreshChanged: 발화하지 않는다 (FR-SCH-5)', async () => {
  const { TIMERS } = hub();
  let ms = 100, n = 0;
  TIMERS.every({ id: 'a', every: () => ms, run: () => { n++ } });
  ms = 500;
  TIMERS.refreshChanged();
  assert.equal(n, 0, '주기를 바꿨다고 수집이 시작됐다');
});

test('숨으면 멈추고, 돌아오면 즉시 한 번 갚는다 (FR-RST-23)', async () => {
  const { clock, TIMERS, doc } = hub();
  let n = 0;
  TIMERS.every({ id: 'a', every: () => 100, whenHidden: 'pause', run: () => { n++ } });
  doc.hidden = true;
  doc._fire('visibilitychange');
  await clock.advance(1000);
  assert.equal(n, 0, '숨은 화면을 위해 요청이 돌았다');
  doc.hidden = false;
  doc._fire('visibilitychange');
  assert.equal(n, 1, '돌아왔는데 한 주기를 더 기다린다 — 화면이 낡은 채다');
});

test("whenHidden:'run' 인 job 은 숨어도 돈다", async () => {
  const { clock, TIMERS, doc } = hub();
  let n = 0;
  TIMERS.every({ id: 'a', every: () => 100, whenHidden: 'run', run: () => { n++ } });
  doc.hidden = true;
  doc._fire('visibilitychange');
  await clock.advance(350);
  assert.ok(n >= 3, "whenHidden:'run' 인데 숨었다고 멈췄다");
});

test('after: 한 번만 돈다', async () => {
  const { clock, TIMERS } = hub();
  let n = 0;
  TIMERS.after(100, () => { n++ });
  await clock.advance(1000);
  assert.equal(n, 1);
});

test('pending: 무엇이 언제 도는지 답한다 (FR-SCH-11)', async () => {
  const { TIMERS } = hub();
  TIMERS.every({ id: 'a', owner: 'panel-1', every: () => 100, run: () => {} });
  const p = TIMERS.pending();
  assert.equal(p.length, 1);
  assert.equal(p[0].id, 'a');
  assert.equal(p[0].owner, 'panel-1');
  assert.equal(p[0].every, 100);
});
