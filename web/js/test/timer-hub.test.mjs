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

/**
 * UX_BATCH10_SRS FR-UXB-27·28 — **포커스 복귀에도 되살린다.**
 *
 * 창 둘을 오갈 때 `document.hidden` 은 양쪽 다 거짓이므로 `visibilitychange`
 * 가 오지 않는다. 그동안 돌아온 창은 다음 주기까지 옛 값을 보여 줬다 — 접수된
 * "포커스가 돌아왔을 때 화면 갱신이 늦다" 의 절반이 이것이다.
 */
test('revalidate: 가시성 변화 없이도 되살린다 (FR-UXB-27)', async () => {
  const { TIMERS } = hub();
  let n = 0;
  TIMERS.every({ id: 'a', every: () => 100000, whenHidden: 'pause', run: () => { n++ } });
  TIMERS.revalidate();
  assert.equal(n, 1, '되살림이 job 을 깨우지 않았다');
});

test('revalidate: 숨어 있으면 되살리지 않는다 (FR-UXB-27)', async () => {
  const { TIMERS, doc } = hub();
  let n = 0;
  TIMERS.every({ id: 'a', every: () => 100000, whenHidden: 'pause', run: () => { n++ } });
  doc.hidden = true;
  TIMERS.revalidate();
  assert.equal(n, 0, '아무도 보지 않는 화면을 위해 요청이 나갔다');
});

test('revalidate: 비행 중인 job 에 겹쳐 쏘지 않는다 (FR-UXB-28)', async () => {
  const { TIMERS } = hub();
  let n = 0;
  let release;
  const gate = new Promise((r) => { release = r });
  TIMERS.every({ id: 'a', every: () => 100000, whenHidden: 'pause', run: async () => { n++; await gate } });
  TIMERS.revalidate();
  assert.equal(n, 1);
  TIMERS.revalidate();
  TIMERS.revalidate();
  assert.equal(n, 1, '답을 기다리는 job 에 요청이 겹쳐 나갔다');
  release();
});

test("revalidate: revalidateOnShow:false 인 job 은 그대로 잔다", async () => {
  const { TIMERS } = hub();
  let n = 0;
  TIMERS.every({ id: 'a', every: () => 100000, whenHidden: 'pause', revalidateOnShow: false, run: () => { n++ } });
  TIMERS.revalidate();
  assert.equal(n, 0, '되살리지 말라고 한 job 을 되살렸다');
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

/**
 * SAFETY_CORRECTNESS_SRS 묶음 E (TC-SAF-8·9).
 *
 * 이 저장소에서 시간은 하나다 (INV-1). 스케줄러가 멎으면 상태바·git 폴링·SSE
 * 침묵 감시·워크스페이스 저장 홀드가 **전부** 함께 멎고, 증상은 "화면이 갱신되지
 * 않는다" 로만 보인다 — 원인 함수와 증상이 완전히 분리된다.
 *
 * `EventBus.publish` 가 같은 위험을 이미 막고 그 주석이 *"하나가 던져도 나머지는
 * 받는다"* 라고 적는다. 버스는 막았고 허브는 막지 않았다.
 */
function hubWithLog() {
  const clock = fakeClock();
  // error-log.js 는 로드되는 순간 window 훅을 건다 (조건 없이 — 그것이 그
  // 파일의 요구다). 브라우저 스텁에는 그 자리가 없으므로 받아만 둔다.
  const ctx = load(['core/error-log.js', 'core/timer-hub.js'], {
    clock,
    globals: { addEventListener() {} },
    expose: ['TimerHub', 'TIMERS', 'ErrorLog'],
  });
  return { clock, ctx, TIMERS: ctx.TIMERS, ErrorLog: ctx.ErrorLog };
}

test('after: 하나가 던져도 같은 tick 의 나머지가 돈다 (TC-SAF-8)', async () => {
  const { clock, TIMERS } = hubWithLog();
  let ran = 0;
  TIMERS.after(100, () => { throw new Error('일부러 던진다') });
  TIMERS.after(100, () => { ran++ });
  await clock.advance(200);
  assert.equal(ran, 1, '앞의 after 가 던져서 뒤의 after 가 죽었다');
});

test('after: 던진 뒤에도 다음 예약이 선다 (TC-SAF-9)', async () => {
  const { clock, TIMERS } = hubWithLog();
  let n = 0;
  TIMERS.every({ id: 'a', every: () => 100, run: () => { n++ } });
  TIMERS.after(100, () => { throw new Error('일부러 던진다') });
  await clock.advance(500);
  assert.ok(n >= 3, `after 가 던진 뒤 스케줄러가 멎었다 — every 가 ${n}회만 돌았다`);
});

test('after: 던진 예외가 흔적을 남긴다 (FR-SAF-16)', async () => {
  const { clock, TIMERS, ErrorLog } = hubWithLog();
  TIMERS.after(100, () => { throw new Error('흔적 검사') });
  await clock.advance(200);
  const hit = ErrorLog.items().some(i => i.kind === 'timer' && /흔적 검사/.test(i.message));
  assert.ok(hit, `삼킨 예외가 ErrorLog 에 없다: ${JSON.stringify(ErrorLog.items())}`);
});

test('every: run 이 던져도 스케줄러가 멎지 않는다 (TC-SAF-9b)', async () => {
  const { clock, TIMERS } = hubWithLog();
  let other = 0;
  TIMERS.every({ id: 'bad', every: () => 100, run: () => { throw new Error('던진다') } });
  TIMERS.every({ id: 'good', every: () => 100, run: () => { other++ } });
  await clock.advance(500);
  assert.ok(other >= 3, `던지는 job 옆에서 멀쩡한 job 이 ${other}회만 돌았다`);
});

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-8-6 (IPC-31) — 한 회차에 마감이 N 개 몰려도 다음 마감
 * 계산(전체 훑기)은 회차 끝의 한 번이다. 종전에는 `_fire → _arm → _reschedule` 이
 * job 마다 훑어 회차 하나가 O(n²) 이었다.
 */
test('한 회차의 재예약은 전체 훑기 한 번이다 (IPC-31)', async () => {
  const { clock, TIMERS } = hub();
  for (let i = 0; i < 50; i++) TIMERS.every({ id: 'j' + i, every: () => 100, run: () => {} });
  let scans = 0;
  const values = TIMERS._jobs.values.bind(TIMERS._jobs);
  TIMERS._jobs.values = () => { scans++; return values(); };
  await clock.advance(100);
  // _tick 이 마감 지난 job 을 고르는 한 번 + 회차 끝 재예약 한 번 + `await` 뒤
  // 재무장들을 모은 재예약 한 번. 종전에는 54 번이었다.
  assert.ok(scans <= 3, '한 회차에 전체를 ' + scans + ' 번 훑었다 (job 50)');
});

/**
 * PERF_OPTIMIZATION_SRS FR-SPA-4 · D-39 — `frame` 의 합치기 키·우선순위·예산 (이슈 3.6.1).
 *
 * 하네스의 rAF 는 16 ms 뒤의 가짜 타이머다. 예산은 `performance.now()` 로 재므로 그 값을
 * 시험이 쥔다 — 콜백 안에서 `t.ms += …` 로 "오래 걸린 일" 을 흉내 낸다.
 */
function frameHub({ inputPending } = {}) {
  const clock = fakeClock();
  const t = { ms: 0, input: false };
  const globals = { performance: { now: () => t.ms } };
  if (inputPending) globals.navigator = { scheduling: { isInputPending: () => t.input } };
  const ctx = load(['core/error-log.js', 'core/timer-hub.js'], {
    clock,
    globals: { addEventListener() {}, ...globals },
    expose: ['TimerHub', 'TIMERS', 'ErrorLog'],
  });
  return { clock, t, TIMERS: ctx.TIMERS, ErrorLog: ctx.ErrorLog };
}

test('frame: 옵션 없는 호출은 부른 순서대로 한 프레임에 돈다', async () => {
  const { clock, TIMERS } = frameHub();
  const log = [];
  for (const k of ['a', 'b', 'c']) TIMERS.frame(() => log.push(k));
  await clock.advance(16);
  assert.deepEqual(log, ['a', 'b', 'c']);
});

test('frame: 한 프레임에 rAF 는 하나다', async () => {
  const { clock, TIMERS } = frameHub();
  for (let i = 0; i < 5; i++) TIMERS.frame(() => {});
  assert.equal(clock.pending(), 1, '호출마다 rAF 를 걸었다');
});

test('frame: 프레임 안에서 건 frame 은 다음 프레임에 돈다', async () => {
  const { clock, TIMERS } = frameHub();
  const log = [];
  TIMERS.frame(() => { log.push('a'); TIMERS.frame(() => log.push('b')) });
  await clock.advance(16);
  assert.deepEqual(log, ['a']);
  await clock.advance(16);
  assert.deepEqual(log, ['a', 'b']);
});

test('frame key: 같은 프레임의 같은 키는 마지막 것만 한 번 돈다', async () => {
  const { clock, TIMERS } = frameHub();
  const log = [];
  TIMERS.frame(() => log.push(1), { key: 'k' });
  TIMERS.frame(() => log.push('other'), { key: 'j' });
  TIMERS.frame(() => log.push(2), { key: 'k' });
  await clock.advance(16);
  assert.deepEqual(log, ['other', 2], '앞의 것을 버리고 마지막 것이 부른 순서의 끝에 선다');
});

test('frame key: 돈 뒤의 같은 키는 새로 잡힌다', async () => {
  const { clock, TIMERS } = frameHub();
  let n = 0;
  TIMERS.frame(() => n++, { key: 'k' });
  await clock.advance(16);
  TIMERS.frame(() => n++, { key: 'k' });
  await clock.advance(16);
  assert.equal(n, 2);
});

test('frame coalesce: 종전대로 먼저 잡힌 예약이 이긴다 (FR-SCH-15)', async () => {
  const { clock, TIMERS } = frameHub();
  const log = [];
  const h1 = TIMERS.frame(() => log.push(1), { owner: 'o', coalesce: 'c' });
  const h2 = TIMERS.frame(() => log.push(2), { owner: 'o', coalesce: 'c' });
  assert.equal(h1.id, h2.id);
  await clock.advance(16);
  assert.deepEqual(log, [1]);
});

test('frame prio: input > term > normal > idle 순서로 돈다', async () => {
  const { clock, TIMERS } = frameHub();
  const log = [];
  TIMERS.frame(() => log.push('idle'), { prio: 'idle' });
  TIMERS.frame(() => log.push('normal'));
  TIMERS.frame(() => log.push('term'), { prio: 'term' });
  TIMERS.frame(() => log.push('input'), { prio: 'input' });
  TIMERS.frame(() => log.push('normal2'), { prio: 'normal' });
  await clock.advance(16);
  assert.deepEqual(log, ['input', 'term', 'normal', 'normal2', 'idle']);
});

test('frame 예산: 8 ms 를 넘으면 남은 idle 은 다음 프레임으로 간다', async () => {
  const { clock, t, TIMERS } = frameHub();
  const log = [];
  TIMERS.frame(() => { log.push('n'); t.ms += 9 });
  TIMERS.frame(() => log.push('i1'), { prio: 'idle' });
  TIMERS.frame(() => log.push('i2'), { prio: 'idle' });
  await clock.advance(16);
  assert.deepEqual(log, ['n']);
  assert.equal(TIMERS.pending().filter((p) => p.kind === 'frame').length, 2, '미룬 idle 이 대기 목록에서 사라졌다');
  await clock.advance(16);
  assert.deepEqual(log, ['n', 'i1', 'i2']);
});

test('frame 예산: idle 이 예산을 넘기면 그 뒤의 idle 만 미룬다', async () => {
  const { clock, t, TIMERS } = frameHub();
  const log = [];
  TIMERS.frame(() => { log.push('i1'); t.ms += 8 }, { prio: 'idle' });
  TIMERS.frame(() => log.push('i2'), { prio: 'idle' });
  await clock.advance(16);
  assert.deepEqual(log, ['i1']);
  await clock.advance(16);
  assert.deepEqual(log, ['i1', 'i2']);
});

test('frame 예산: input·term·normal 은 예산을 넘어도 미루지 않는다', async () => {
  const { clock, t, TIMERS } = frameHub();
  const log = [];
  TIMERS.frame(() => { log.push('input'); t.ms += 20 }, { prio: 'input' });
  TIMERS.frame(() => log.push('term'), { prio: 'term' });
  TIMERS.frame(() => log.push('normal'));
  await clock.advance(16);
  assert.deepEqual(log, ['input', 'term', 'normal']);
});

test('frame isInputPending: 참이면 idle 을 돌리지 않고, 거짓이 되면 돈다', async () => {
  const { clock, t, TIMERS } = frameHub({ inputPending: true });
  const log = [];
  t.input = true;
  TIMERS.frame(() => log.push('n'));
  TIMERS.frame(() => log.push('i'), { prio: 'idle' });
  await clock.advance(16);
  assert.deepEqual(log, ['n']);
  t.input = false;
  await clock.advance(16);
  assert.deepEqual(log, ['n', 'i']);
});

test('frame isInputPending: 없는 환경은 예산만 본다', async () => {
  const { clock, TIMERS } = frameHub();
  const log = [];
  TIMERS.frame(() => log.push('i'), { prio: 'idle' });
  await clock.advance(16);
  assert.deepEqual(log, ['i']);
});

test('frame: 주인을 정리하면 대기 작업이 사라지고 rAF 도 걷힌다', async () => {
  const { clock, t, TIMERS } = frameHub();
  const log = [];
  TIMERS.frame(() => log.push('a'), { owner: 'o' });
  TIMERS.frame(() => log.push('k'), { owner: 'o', key: 'k', prio: 'idle' });
  assert.equal(TIMERS.disposeOwner('o'), 2);
  assert.equal(TIMERS.pending().length, 0);
  assert.equal(clock.pending(), 0, '할 일이 없는데 rAF 가 남았다');
  TIMERS.frame(() => { t.ms += 9 });
  TIMERS.frame(() => log.push('late'), { owner: 'p', prio: 'idle' });
  await clock.advance(16);
  assert.equal(TIMERS.disposeOwner('p'), 1, '미룬 idle 이 주인 정리에 잡히지 않았다');
  await clock.advance(32);
  assert.deepEqual(log, []);
});

test('frame: stop 은 그 작업만 걷는다', async () => {
  const { clock, TIMERS } = frameHub();
  const log = [];
  const h = TIMERS.frame(() => log.push('a'));
  TIMERS.frame(() => log.push('b'));
  TIMERS.cancel(h);
  await clock.advance(16);
  assert.deepEqual(log, ['b']);
});

test('frame: 하나가 던져도 같은 프레임의 나머지가 돈다', async () => {
  const { clock, TIMERS, ErrorLog } = frameHub();
  const log = [];
  TIMERS.frame(() => { throw new Error('프레임 던짐') });
  TIMERS.frame(() => log.push('b'));
  await clock.advance(16);
  assert.deepEqual(log, ['b']);
  assert.ok(ErrorLog.items().some((i) => i.kind === 'timer' && /프레임 던짐/.test(i.message)));
});
