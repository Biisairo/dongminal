import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, fakeClock, load, plain } from './harness.mjs';

/**
 * PERF 3.5.1 — 생명주기 기반 (D-36·D-37·D-38, M3_DESIGN §3.5, FR-SPA-3).
 *   계약 `mount`·`wake`·`sleep`·`unmount` · `Component.awake` · 도우미 `Awake` · 렌더러 전이 · 2초 지연 · 시험용 관측.
 */
function setup() {
  const clock = fakeClock();
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', 'core/event-bus.js',
    'core/channel.js', ...BASE, 'ui/screen-life.js', 'ui/renderer.js', 'ui/renderer-layout.js'], {
    clock,
    expose: ['TimerHub', 'EventBus', 'Channel', 'Component', 'View', 'Awake', 'ScreenLife', 'Renderer', 'SCREEN_SLEEP_MS'],
  });
  const timers = new ctx.TimerHub();
  const bus = new ctx.EventBus({}, timers);
  const channel = new ctx.Channel(bus, timers, { pingMs: () => 1000 });
  const app = { timers, bus, channel };
  // `Component` 의 깬 동안 도우미는 토픽 구독을 앱의 채널에서 찾는다.
  ctx.app = app;
  return { ctx, clock, timers, bus, channel, app };
}

/** 전이를 적는 계약 주인. 기반 클래스가 없다 (D-37). */
function logOwner(log, name = 'o') {
  return {
    mount: (host) => log.push(name + ':mount:' + (host && host.id)),
    wake: () => log.push(name + ':wake'),
    sleep: () => log.push(name + ':sleep'),
    unmount: () => log.push(name + ':unmount'),
  };
}

const ownedTimers = (timers, owner) => timers.pending().filter((r) => r.owner === owner).length;

test('SCREEN_SLEEP_MS 는 D-16 과 같은 2초다', () => {
  const { ctx } = setup();
  assert.equal(ctx.SCREEN_SLEEP_MS, 2000);
});

// ── Awake ────────────────────────────────────────────────────────────────

test('Awake: 깬 동안 건 타이머·구독·토픽이 sleep 뒤 0, wake 뒤 다시 1', () => {
  const { ctx, timers, bus, channel } = setup();
  const s = new ctx.Awake({ timers, bus, channel });
  let woke = 0;
  s.add((a) => {
    woke++;
    a.every(1000, () => {});
    a.on('topic', () => {});
    a.sub('git:/r', () => {});
  });
  assert.equal(woke, 0, '깨기 전에는 부르지 않는다');
  assert.equal(s.isAwake, false);

  s.wake();
  assert.equal(woke, 1);
  assert.equal(ownedTimers(timers, s), 1);
  assert.equal(bus.publish('topic'), 1);
  assert.equal(channel.countOwned((o) => o === s), 1);

  s.sleep();
  assert.equal(s.isAwake, false);
  assert.equal(ownedTimers(timers, s), 0);
  assert.equal(bus.publish('topic'), 0);
  assert.equal(channel.countOwned((o) => o === s), 0);

  s.wake();
  assert.equal(woke, 2);
  assert.equal(ownedTimers(timers, s), 1);
  assert.equal(bus.publish('topic'), 1);
  assert.equal(channel.countOwned((o) => o === s), 1);
});

test('Awake: sleep 을 두 번 불러도 한 번만 걷는다 · wake 를 두 번 불러도 한 번만 건다', () => {
  const { ctx, timers, bus, channel } = setup();
  const s = new ctx.Awake({ timers, bus, channel });
  let released = 0, woke = 0;
  s.add((a) => { woke++; a.own(() => { released++ }) });
  s.wake(); s.wake();
  assert.equal(woke, 1);
  s.sleep(); s.sleep();
  assert.equal(released, 1);
});

test('Awake: 깬 뒤에 더한 fn 은 곧바로 돈다', () => {
  const { ctx, timers, bus, channel } = setup();
  const s = new ctx.Awake({ timers, bus, channel });
  s.wake();
  let n = 0;
  s.add(() => { n++ });
  assert.equal(n, 1);
});

test('Awake: dispose 는 잠든 상태에서도 모두 놓고 다시 깨지 않는다', () => {
  const { ctx, timers, bus, channel } = setup();
  const s = new ctx.Awake({ timers, bus, channel });
  let woke = 0;
  s.add((a) => { woke++; a.every(1000, () => {}) });
  s.wake(); s.sleep();
  s.dispose();
  assert.equal(s.disposed, true);
  s.wake();
  assert.equal(woke, 1);
  assert.equal(ownedTimers(timers, s), 0);
});

// ── Component.awake · View 기본 구현 ─────────────────────────────────────

test('Component.awake: 깬 동안의 것은 주인 자신의 것과 갈린다', () => {
  const { ctx, timers, bus } = setup();
  const c = new ctx.Component({ timers, bus });
  c.every(5000, () => {});                         // 수명 내내 사는 것
  const scope = c.awake((a) => { a.every(1000, () => {}) });
  assert.equal(scope.parent, c);
  scope.wake();
  assert.equal(ownedTimers(timers, c), 1);
  assert.equal(ownedTimers(timers, scope), 1);
  scope.sleep();
  assert.equal(ownedTimers(timers, c), 1, 'sleep 은 깬 동안의 것만 걷는다');
  assert.equal(ownedTimers(timers, scope), 0);
  c.dispose();
  assert.equal(timers.pending().length, 0);
  assert.equal(scope.disposed, true);
});

test('Component.awake: 두 번 불러도 도우미는 하나다', () => {
  const { ctx, timers, bus } = setup();
  const c = new ctx.Component({ timers, bus });
  assert.equal(c.awake(() => {}), c.awake(() => {}));
});

test('View 기본 구현: mount→wake→sleep→wake→unmount, 잠들었다 깨면 한 번 그린다', () => {
  const { ctx, timers, bus } = setup();
  let renders = 0;
  class V extends ctx.View { render() { renders++ } }
  const v = new V({ timers, bus });
  const scope = v.awake((a) => { a.every(1000, () => {}); a.on('t', () => {}) });
  const host = ctx.document.createElement('div');
  v.mount(host);
  assert.equal(renders, 1);
  v.wake();
  assert.equal(renders, 1, '첫 wake 는 mount 가 그린 것을 다시 그리지 않는다');
  assert.equal(ownedTimers(timers, scope), 1);
  v.sleep(); v.sleep();
  assert.equal(ownedTimers(timers, scope), 0);
  assert.equal(bus.publish('t'), 0);
  v.wake();
  assert.equal(renders, 2, '잠든 동안 놓친 것을 깰 때 한 번 그린다');
  assert.equal(ownedTimers(timers, scope), 1);
  v.sleep();
  v.unmount();
  assert.equal(v.disposed, true, '잠든 상태의 unmount 도 모두 놓는다');
  assert.equal(timers.pending().length, 0);
  v.wake();
  assert.equal(ownedTimers(timers, scope), 0);
});

// ── ScreenLife — 전이와 2초 지연 ─────────────────────────────────────────

test('ScreenLife: 전이 mount→wake→sleep→wake→unmount, sleep 은 2초 뒤다', async () => {
  const { ctx, clock, app } = setup();
  const life = new ctx.ScreenLife(app);
  const log = [];
  const o = logOwner(log);
  const host = { id: 'h1' };
  life.commit(new Map([[o, host]]));
  assert.deepEqual(plain(log), ['o:mount:h1', 'o:wake']);
  life.commit(new Map());
  await clock.advance(1999);
  assert.deepEqual(plain(log), ['o:mount:h1', 'o:wake'], '2초가 차기 전에는 잠들지 않는다');
  await clock.advance(1);
  assert.deepEqual(plain(log), ['o:mount:h1', 'o:wake', 'o:sleep']);
  life.commit(new Map([[o, host]]));
  life.unmount(o);
  assert.deepEqual(plain(log), ['o:mount:h1', 'o:wake', 'o:sleep', 'o:wake', 'o:unmount']);
});

test('ScreenLife: 2초 안에 다시 보이면 sleep 이 불리지 않는다', async () => {
  const { ctx, clock, app } = setup();
  const life = new ctx.ScreenLife(app);
  const log = [];
  const o = logOwner(log);
  life.commit(new Map([[o, {}]]));
  life.commit(new Map());
  await clock.advance(1500);
  life.commit(new Map([[o, {}]]));
  await clock.advance(10000);
  assert.deepEqual(plain(log), ['o:mount:undefined', 'o:wake']);
  assert.equal(life.pending(), 0);
});

test('ScreenLife: 계속 안 보여도 sleep 은 한 번이다 · 다시 그려도 지연이 늘지 않는다', async () => {
  const { ctx, clock, app } = setup();
  const life = new ctx.ScreenLife(app);
  const log = [];
  const o = logOwner(log);
  life.commit(new Map([[o, {}]]));
  life.commit(new Map());
  await clock.advance(1000);
  life.commit(new Map());                          // 잠들기 전의 다시 그리기
  await clock.advance(1000);
  assert.deepEqual(plain(log).slice(2), ['o:sleep'], '처음 빠진 때부터 2초다');
  life.commit(new Map());
  await clock.advance(5000);
  assert.deepEqual(plain(log).slice(2), ['o:sleep']);
});

test('ScreenLife: 잠들기를 기다리는 중의 unmount 는 sleep 을 부르지 않는다', async () => {
  const { ctx, clock, app } = setup();
  const life = new ctx.ScreenLife(app);
  const log = [];
  const o = logOwner(log);
  life.commit(new Map([[o, {}]]));
  life.commit(new Map());
  life.unmount(o);
  await clock.advance(5000);
  assert.deepEqual(plain(log).slice(2), ['o:unmount']);
  life.unmount(o);
  assert.deepEqual(plain(log).slice(2), ['o:unmount'], '두 번째 unmount 는 아무것도 하지 않는다');
});

test('ScreenLife: 잠든 View 의 unmount 도 모두 놓는다', async () => {
  const { ctx, clock, timers, bus, app } = setup();
  const life = new ctx.ScreenLife(app);
  const v = new ctx.View({ timers, bus });
  const scope = v.awake((a) => { a.every(1000, () => {}) });
  life.commit(new Map([[v, ctx.document.createElement('div')]]));
  assert.equal(ownedTimers(timers, scope), 1);
  life.commit(new Map());
  await clock.advance(2000);
  assert.equal(ownedTimers(timers, scope), 0);
  life.unmount(v);
  assert.equal(v.disposed, true);
  assert.equal(timers.pending().length, 0);
});

test('ScreenLife: 계약(wake·sleep)이 없는 주인은 건드리지 않는다', async () => {
  const { ctx, clock, app } = setup();
  const life = new ctx.ScreenLife(app);
  let touched = 0;
  const plainOwner = { mount: () => { touched++ }, unmount: () => { touched++ } };
  life.commit(new Map([[plainOwner, {}]]));
  life.commit(new Map());
  await clock.advance(5000);
  life.unmount(plainOwner);
  assert.equal(touched, 0);
  assert.deepEqual(plain(life.sleepers()), []);
});

test('ScreenLife.sleepers: 잠든 주인과 남은 타이머·토픽 구독 수', async () => {
  const { ctx, clock, timers, bus, channel, app } = setup();
  const life = new ctx.ScreenLife(app);
  class Panel extends ctx.Component {
    wake() { this._awake.wake() }
    sleep() { this._awake.sleep() }
  }
  const p = new Panel({ timers, bus });
  p.awake((a) => { a.every(1000, () => {}); a.sub('git:/r', () => {}) });
  p.every(9000, () => {});                         // 잠들어도 남는 것 — 관측이 보여야 한다
  channel.sub('git.jobs', () => {}, { owner: p });
  life.commit(new Map([[p, {}]]));
  assert.deepEqual(plain(life.sleepers()), []);
  life.commit(new Map());
  await clock.advance(2000);
  assert.deepEqual(plain(life.sleepers()), [{ kind: 'Panel', timers: 1, subs: 1 }]);
});

test('ScreenLife: 브라우저 탭 숨김은 TimerHub 의 visibilitychange 에서 받는다', () => {
  const { ctx, app } = setup();
  const life = new ctx.ScreenLife(app);
  assert.equal(life.pageHidden, false);
  ctx.document.hidden = true;
  ctx.document._fire('visibilitychange');
  assert.equal(life.pageHidden, true);
  ctx.document.hidden = false;
  ctx.document._fire('visibilitychange');
  assert.equal(life.pageHidden, false);
});

// ── 렌더러 ───────────────────────────────────────────────────────────────

test('렌더러: 본문이 빠지면 sleep 을 예약하고, 다시 붙으면 취소한다', async () => {
  const { ctx, clock, app } = setup();
  const r = new ctx.Renderer(app);
  const log = [];
  const o = logOwner(log);
  const body = { id: 'body' };
  const el = { parentNode: body };
  const placeholder = { parentNode: body };
  r._mounted = new Map([[el, o], [placeholder, null]]);
  r._lifeCommit();
  assert.deepEqual(plain(log), ['o:mount:body', 'o:wake']);

  r._mounted = new Map();
  r._lifeCommit();
  assert.equal(r.life.pending(), 1, 'sleep 이 예약됐다');
  await clock.advance(1000);
  r._mounted = new Map([[el, o]]);
  r._lifeCommit();
  assert.equal(r.life.pending(), 0, '다시 붙어 취소됐다');
  await clock.advance(5000);
  assert.deepEqual(plain(log), ['o:mount:body', 'o:wake']);

  r._mounted = new Map();
  r._lifeCommit();
  await clock.advance(ctx.SCREEN_SLEEP_MS);
  assert.deepEqual(plain(log), ['o:mount:body', 'o:wake', 'o:sleep']);
});
