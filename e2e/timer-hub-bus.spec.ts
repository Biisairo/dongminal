import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// 최상위 `class` 선언은 **전역 객체의 프로퍼티가 아니다** (`const`·`let` 과 같은
// 규칙). `window.TimerHub` 로는 잡히지 않으므로 이름으로 직접 조회한다 —
// `page.evaluate` 의 본문은 브라우저의 전역 스코프에서 실행되므로 그것이 닿는다.
declare const TimerHub: any;
declare const EventBus: any;


// EVENT_TIMER_HUB_SRS 묶음 S·B — `TimerHub` 와 `EventBus` 자체의 계약.
//
// `event-timer-hub-contract.spec.ts` 가 **이관 전후로 변하지 않아야 할 것**을
// 재는 데 비해, 이 스펙은 **새 두 클래스가 그 계약을 실제로 줄 수 있는가**를
// 잰다. 둘 다 통과해야 이관이 안전하다.
//
// 같은 관용구를 쓴다 — 빈 페이지에 대상 파일만 얹고 계약만 시험한다.

const WEB = join(process.cwd(), 'web', 'js');
const TIMER_HUB_JS = join(WEB, 'core', 'timer-hub.js');
const EVENT_BUS_JS = join(WEB, 'core', 'event-bus.js');

async function loadTimerHub(page: Page) {
  await page.setContent('<!doctype html><title>scheduler</title>');
  await page.addScriptTag({ path: TIMER_HUB_JS });
  await page.evaluate(() => {
    (window as any).__s = new TimerHub();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 묶음 S — TimerHub
// ─────────────────────────────────────────────────────────────────────────────

test.describe('TimerHub — 마감과 규약 (FR-SCH-3~9)', () => {
  test('FR-SCH-3 단일 타이머로 서로 다른 주기를 각자 마감에 맞춘다', async ({ page }) => {
    await loadTimerHub(page);

    const r = await page.evaluate(async () => {
      const s = (window as any).__s;
      let fast = 0, slow = 0;
      s.every({ id: 'fast', every: () => 20, run: () => { fast++ } });
      s.every({ id: 'slow', every: () => 200, run: () => { slow++ } });
      await new Promise((r) => setTimeout(r, 230));
      return { fast, slow };
    });

    // 고정 tick 이라면 느린 쪽이 빠른 쪽 주기로 깨어나 헛돈다.
    expect(r.fast, '빠른 주기가 자기 마감을 못 지켰다').toBeGreaterThan(5);
    expect(r.slow, '느린 주기가 돌지 않았다').toBeGreaterThanOrEqual(1);
    expect(r.slow, '느린 주기가 빠른 주기를 따라 돌았다 — 고정 tick 이다').toBeLessThan(4);
  });

  test('FR-SCH-4·5 주기는 함수이고, 다시 거는 것이 발화는 아니다', async ({ page }) => {
    await loadTimerHub(page);

    const r = await page.evaluate(async () => {
      const s = (window as any).__s;
      let ms = 1000, runs = 0;
      const h = s.every({ id: 'j', every: () => ms, run: () => { runs++ } });
      // 관측 결과로 주기가 바뀐 장면. 여기서 발화하면 관측이 관측을 부른다.
      ms = 20;
      h.refresh();
      const rightAfter = runs;
      await new Promise((r) => setTimeout(r, 80));
      return { rightAfter, later: runs };
    });

    expect(r.rightAfter, '주기 변경이 즉시 발화를 불렀다 (FR-RMS-28 · D-RMS-10)').toBe(0);
    expect(r.later, '새 주기가 적용되지 않았다').toBeGreaterThan(0);
  });

  test('FR-SCH-6 숨은 화면에서 멈추고 복귀하면 즉시 한 번 (FR-RST-23)', async ({ page }) => {
    await loadTimerHub(page);

    const r = await page.evaluate(async () => {
      const s = (window as any).__s;
      let hidden = false;
      s._hidden = () => hidden;
      let n = 0;
      s.every({ id: 'v', every: () => 20, run: () => { n++ } });
      await new Promise((r) => setTimeout(r, 70));
      const visible = n;

      hidden = true;
      s._visibility();
      const atHide = n;
      await new Promise((r) => setTimeout(r, 70));
      const whileHidden = n;

      hidden = false;
      s._visibility();
      return { visible, atHide, whileHidden, atShow: n };
    });

    expect(r.visible, '보이는 동안 돌지 않았다').toBeGreaterThan(0);
    expect(r.whileHidden, '숨은 화면에서 계속 돌았다 (FR-STAT-17)').toBe(r.atHide);
    expect(r.atShow, '복귀했는데 즉시 갱신하지 않았다 (FR-RST-23)').toBe(r.whileHidden + 1);
  });

  test('FR-SCH-7 overlap 은 job 이 고른다 — queue 와 drop 둘 다 산다', async ({ page }) => {
    await loadTimerHub(page);

    const r = await page.evaluate(async () => {
      const s = (window as any).__s;
      const mk = (mode: string) => {
        let starts = 0;
        let release: any = null;
        const h = s.every({
          id: 'ov-' + mode, every: () => 100000, overlap: mode,
          run: () => new Promise((res) => { starts++; release = res }),
        });
        return { h, get starts() { return starts }, rel: () => release && release() };
      };

      const q = mk('queue');
      const d = mk('drop');
      q.h.poke(); d.h.poke();                 // 첫 비행 시작
      await new Promise((r) => setTimeout(r, 0));
      q.h.poke(); d.h.poke();                 // 비행 중 재요청
      await new Promise((r) => setTimeout(r, 0));
      const during = { q: q.starts, d: d.starts };
      q.rel(); d.rel();                       // 첫 비행 종료
      await new Promise((r) => setTimeout(r, 10));
      return { during, after: { q: q.starts, d: d.starts } };
    });

    expect(r.during.q, '비행 중 재요청이 곧바로 겹쳐 나갔다').toBe(1);
    expect(r.after.q, 'queue 인데 대기하던 한 번이 나가지 않았다 (FR-GIT-21)').toBe(2);
    expect(r.after.d, 'drop 인데 겹친 요청이 살아남았다').toBe(1);
  });

  // 소유권이 끊긴 뒤 도착한 응답은 화면을 건드리지 않는다. `panel-poll` 의
  // `_seq!==seq` 경로가 손으로 하던 판정이 여기로 온다 (SRS §2.2 — 종전 4벌).
  //
  // `overlap:'queue'` 에서 비행 중의 재요청은 **새 회차를 만들지 않는다**
  // (`again` 만 세운다). 그러므로 그 상황의 첫 회차는 여전히 최신이며, stale 이
  // 참이 되는 것은 소유권 자체가 끊길 때다 — 리포가 바뀌거나 job 이 멈출 때.
  test('FR-SCH-9 소유권이 끊기면 뒤늦은 응답이 stale 로 답한다', async ({ page }) => {
    await loadTimerHub(page);

    const r = await page.evaluate(async () => {
      const s = (window as any).__s;
      const seen: boolean[] = [];
      let release: any = null;
      const h = s.every({
        id: 'st', every: () => 100000,
        run: (ctx: any) => new Promise<void>((res) => {
          release = () => { seen.push(ctx.stale()); res() };
        }),
      });
      h.poke();
      await new Promise((r) => setTimeout(r, 0));
      const inflight = release;
      h.stop();                       // 화면이 사라졌다 — 소유권을 끊는다
      await new Promise((r) => setTimeout(r, 0));
      inflight();                     // 뒤늦게 도착한 응답
      await new Promise((r) => setTimeout(r, 10));

      // 겹침 중에는 최신이 유지된다 — 그것이 queue 의 계약이다.
      const seen2: boolean[] = [];
      let rel2: any = null;
      const h2 = s.every({
        id: 'st2', every: () => 100000, overlap: 'queue',
        run: (ctx: any) => new Promise<void>((res) => { rel2 = () => { seen2.push(ctx.stale()); res() } }),
      });
      h2.poke();
      await new Promise((r) => setTimeout(r, 0));
      const first2 = rel2;
      h2.poke();
      await new Promise((r) => setTimeout(r, 0));
      first2();
      await new Promise((r) => setTimeout(r, 10));
      return { afterStop: seen, whileQueued: seen2 };
    });

    expect(r.afterStop[0], '소유권이 끊겼는데 자기를 최신이라고 답했다').toBe(true);
    expect(r.whileQueued[0], 'queue 중의 첫 회차를 낡았다고 답했다').toBe(false);
  });

  test('FR-SCH-8 timeout 이 걸린 job 은 시한 뒤 잠금을 놓는다 (FR-RMS-29)', async ({ page }) => {
    await loadTimerHub(page);

    const r = await page.evaluate(async () => {
      const s = (window as any).__s;
      (window as any).fetch = (_u: string, o: any) =>
        new Promise((_res, rej) => {
          o.signal.addEventListener('abort', () => rej(new Error('aborted')));
        });
      let fails = 0;
      const h = s.every({
        id: 'to', every: () => 100000, timeout: 30,
        run: async (ctx: any) => { await ctx.fetch('/x', {}) },
      });
      h.poke();
      await new Promise((r) => setTimeout(r, 120));
      const job = s._jobs.get('to');
      fails = job.failStreak;
      return { busy: job.inflight, fails };
    });

    expect(r.busy, '답이 오지 않는 요청이 잠금을 영구히 붙들었다 (FR-RMS-29)').toBe(false);
    expect(r.fails, '시한 초과가 실패로 세어지지 않았다').toBe(1);
  });
});

test.describe('TimerHub — 다섯 API 와 소유권 (FR-SCH-10·13·14·15)', () => {
  // V-7: 이것이 INV-1 의 실질이다. API 가 다섯이어도 관리는 한 지점이다.
  test('V-7 disposeOwner 가 다섯 API 전부를 걷는다', async ({ page }) => {
    await loadTimerHub(page);

    const r = await page.evaluate(async () => {
      const s = (window as any).__s;
      const fired: string[] = [];
      s.every({ id: 'e', owner: 'win1', every: () => 20, run: () => { fired.push('every') } });
      s.after(20, () => fired.push('after'), { owner: 'win1' });
      s.defer(() => fired.push('defer'), { owner: 'win1' });
      s.frame(() => fired.push('frame'), { owner: 'win1' });
      s.sleep(20, { owner: 'win1' }).then(() => fired.push('sleep'));
      // 남의 것은 걷히면 안 된다.
      s.after(20, () => fired.push('other'), { owner: 'win2' });

      const before = s.pending().filter((p: any) => p.owner === 'win1').length;
      const n = s.disposeOwner('win1');
      await new Promise((r) => setTimeout(r, 80));
      return { before, n, fired, left: s.pending().filter((p: any) => p.owner === 'win1').length };
    });

    expect(r.before, '다섯 API 가 모두 pending 에 잡히지 않는다').toBe(5);
    expect(r.n, 'disposeOwner 가 다섯을 걷지 않았다').toBe(5);
    expect(r.left, '걷은 뒤에도 대기 항목이 남았다').toBe(0);
    expect(r.fired, '파괴된 소유자의 일이 실행됐다').toEqual(['other']);
  });

  // FR-SCH-14: 파괴된 화면의 뒤 작업이 이어지지 않는 것이 옳은 동작이다.
  test('FR-SCH-14 sleep 은 소유자 파괴 뒤 resolve 하지 않는다', async ({ page }) => {
    await loadTimerHub(page);

    const woke = await page.evaluate(async () => {
      const s = (window as any).__s;
      let after = false;
      (async () => { await s.sleep(20, { owner: 'gone' }); after = true })();
      s.disposeOwner('gone');
      await new Promise((r) => setTimeout(r, 80));
      return after;
    });

    expect(woke, 'reject 도 resolve 도 하지 않아야 한다 — 그 자리에서 멈춘다').toBe(false);
  });

  // FR-SCH-13: 기다리는 것이 아니라 순서를 미루는 것이다. 큐를 거치면 깨진다.
  test('FR-SCH-13 defer 는 등록 순서대로, 마감 힙을 거치지 않고 실행된다', async ({ page }) => {
    await loadTimerHub(page);

    const order = await page.evaluate(async () => {
      const s = (window as any).__s;
      const out: string[] = [];
      // 중첩 defer 는 남의 setTimeout(0) 뒤에 서려는 계약이다 (term-pane IME).
      s.defer(() => { out.push('a'); s.defer(() => out.push('a2')) });
      s.defer(() => out.push('b'));
      setTimeout(() => out.push('native'), 0);
      await new Promise((r) => setTimeout(r, 40));
      return out;
    });

    expect(order.slice(0, 3), 'defer 가 등록 순서를 잃었다').toEqual(['a', 'b', 'native']);
    expect(order[3], '중첩 defer 가 한 바퀴 뒤에 서지 않았다').toBe('a2');
  });

  // **먼저 잡힌 예약이 이긴다.** 나중이 이기면 연속 입력(터치 스크롤·리사이즈)에서
  // 재예약이 프레임보다 잦을 때 영영 실행되지 않는다 — `_wheelRaf`·`_mFitRaf`·
  // `_docRenderRaf` 가 `if(this._xRaf) return` 으로 그것을 막고 있었다.
  test('FR-SCH-15 coalesce 는 접되 굶기지 않는다 — 먼저 잡힌 예약이 이긴다', async ({ page }) => {
    await loadTimerHub(page);

    const r = await page.evaluate(async () => {
      const s = (window as any).__s;
      const order: string[] = [];
      for (const tag of ['first', 'second', 'third']) {
        s.frame(() => order.push(tag), { owner: 'w', coalesce: 'fit' });
      }
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));

      // 계속 재예약해도 굶지 않는다 — 매 프레임 한 번은 반드시 돈다.
      let starved = 0;
      const pump = () => { s.frame(() => { starved++ }, { owner: 'w', coalesce: 'pump' }) };
      for (let i = 0; i < 40; i++) pump();
      await new Promise((r) => setTimeout(r, 60));
      return { order, starved };
    });

    expect(r.order, '같은 키의 프레임이 접히지 않았거나 나중 것이 이겼다').toEqual(['first']);
    expect(r.starved, '재예약이 잦으면 영영 실행되지 않는다 — 기아다').toBeGreaterThan(0);
  });

  test('FR-SCH-11 pending 이 대기 중인 일을 전부 답한다', async ({ page }) => {
    await loadTimerHub(page);

    const p = await page.evaluate(() => {
      const s = (window as any).__s;
      s.every({ id: 'poll', owner: 'a', every: () => 5000, run: () => {} });
      s.after(5000, () => {}, { owner: 'a', label: 'debounce' });
      return s.pending().map((x: any) => ({ kind: x.kind, id: x.id, owner: x.owner }));
    });

    expect(p.length, 'pending 이 등록된 일을 놓쳤다').toBe(2);
    expect(p.find((x: any) => x.kind === 'every')?.id).toBe('poll');
    expect(p.find((x: any) => x.kind === 'after')?.owner).toBe('a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 묶음 B — EventBus
// ─────────────────────────────────────────────────────────────────────────────

async function loadBus(page: Page) {
  await page.setContent('<!doctype html><title>event-bus</title>');
  await page.evaluate(() => {
    (window as any).SSE_RETRY_MIN_MS = 5;
    (window as any).SSE_RETRY_MAX_MS = 10;
    (window as any).SSE_SILENCE_MS = 50;
    (window as any).SSE_SILENCE_CHECK_MS = 10;
    const made: any[] = [];
    (window as any).__made = made;
    class FakeES {
      static CLOSED = 2;
      url: string; readyState = 0;
      onopen: any = null; onerror: any = null; onmessage: any = null;
      constructor(url: string) { this.url = url; made.push(this) }
      close() { this.readyState = 2 }
    }
    (window as any).EventSource = FakeES;
  });
  await page.addScriptTag({ path: TIMER_HUB_JS });
  await page.addScriptTag({ path: EVENT_BUS_JS });
  await page.evaluate(() => {
    const s = new TimerHub();
    // 타이머는 **주입**된다. 버스는 시간 계층을 모른다 (D-2 · V-5).
    const bus = new EventBus(
      { clientId: 'me' },
      { every: (spec: any) => s.every(spec), after: (ms: number, fn: any, o: any) => s.after(ms, fn, o) },
    );
    (window as any).__s = s;
    (window as any).__bus = bus;
  });
}

const send = (page: Page, msg: any) =>
  page.evaluate((m) => {
    const es = (window as any).__made.at(-1);
    es.onmessage({ data: JSON.stringify(m) });
  }, msg);

test.describe('EventBus — 전파 (FR-BUS-3~9)', () => {
  test('FR-BUS-3 한 topic 에 구독자가 여럿일 수 있다', async ({ page }) => {
    await loadBus(page);

    const r = await page.evaluate(() => {
      const bus = (window as any).__bus;
      const got: string[] = [];
      bus.subscribe('t', () => got.push('one'), { owner: 'a' });
      bus.subscribe('t', () => got.push('two'), { owner: 'b' });
      const n = bus.publish('t', {});
      bus.disposeOwner('a');
      bus.publish('t', {});
      return { n, got };
    });

    expect(r.n, '한 topic 의 구독자가 하나로 제한됐다').toBe(2);
    expect(r.got, 'disposeOwner 가 그 소유자만 떼지 못했다').toEqual(['one', 'two', 'two']);
  });

  test('FR-BUS-3 한 구독자가 던져도 나머지는 받는다', async ({ page }) => {
    await loadBus(page);

    const got = await page.evaluate(() => {
      const bus = (window as any).__bus;
      const out: string[] = [];
      bus.subscribe('t', () => { throw new Error('boom') });
      bus.subscribe('t', () => out.push('survived'));
      bus.publish('t', {});
      return out;
    });

    expect(got, '한 분기의 예외가 그 뒤 전부를 삼켰다').toEqual(['survived']);
  });

  test('FR-BUS-4·5 구독자가 있으면 지명 검사를 지나지 않는다', async ({ page }) => {
    await loadBus(page);
    await page.evaluate(() => {
      const bus = (window as any).__bus;
      (window as any).__got = [] as string[];
      (window as any).__fell = [] as string[];
      bus.subscribe('workspace_changed', () => (window as any).__got.push('ws'));
      bus.setFallback((a: string) => (window as any).__fell.push(a));
      bus.connect('/sse');
    });

    // 남이 지명받은 메시지라도, 구독자가 있는 action 은 도달해야 한다 —
    // 종전 if-체인에서 그 아홉이 execClientId 검사 **앞**에 있었다.
    await send(page, { action: 'workspace_changed', execClientId: 'someone-else', args: {} });
    // 구독자가 없는 action 은 지명을 따른다 (FR-SXE-3).
    await send(page, { action: 'open_tool', execClientId: 'someone-else', args: {} });
    await send(page, { action: 'open_tool', execClientId: 'me', args: {} });

    const r = await page.evaluate(() => ({ got: (window as any).__got, fell: (window as any).__fell }));
    expect(r.got, '구독자가 있는 action 이 지명 때문에 막혔다 (FR-BUS-5)').toEqual(['ws']);
    expect(r.fell, '지명받지 않은 명령을 수행했다 (FR-SXE-3)').toEqual(['open_tool']);
  });

  test('FR-BUS-6 스냅샷 비행 중 만진 id 는 스냅샷이 덮지 않는다 (FR-RSF-3·5)', async ({ page }) => {
    await loadBus(page);

    const r = await page.evaluate(() => {
      const bus = (window as any).__bus;
      const t = bus.beginSnapshot('focus');   // 종전에 방어가 없던 상태다
      bus.noteTouched('focus', 'X');
      const live = bus.isLive('focus', t);
      const touched = t.has('X');
      bus.voidSnapshot('focus');
      const afterVoid = bus.isLive('focus', t);

      const a = bus.beginSnapshot('bg');
      const b = bus.beginSnapshot('bg');
      return { live, touched, afterVoid, first: bus.isLive('bg', a), second: bus.isLive('bg', b) };
    });

    expect(r.live).toBe(true);
    expect(r.touched, '비행 중 만진 id 가 기록되지 않았다').toBe(true);
    expect(r.afterVoid, '초기화 뒤에도 비행이 살아 있다 (FR-RSF-5)').toBe(false);
    expect(r.first, '추월당한 비행이 여전히 살아 있다').toBe(false);
    expect(r.second).toBe(true);
  });

  test('FR-BUS-7 침묵이 상한을 넘으면 스스로 다시 연다 (FR-RLC-25)', async ({ page }) => {
    await loadBus(page);
    await page.evaluate(() => {
      const bus = (window as any).__bus;
      (window as any).__silent = 0;
      bus.subscribe('sse:silent', () => (window as any).__silent++);
      bus.connect('/sse');
      const es = (window as any).__made.at(-1);
      es.readyState = 1;
      es.onopen();
      bus._seen = Date.now() - 100000;   // 침묵을 흉내낸다
    });

    await expect
      .poll(() => page.evaluate(() => (window as any).__made.length), { timeout: 3000 })
      .toBeGreaterThan(1);
    const silent = await page.evaluate(() => (window as any).__silent);
    expect(silent, '침묵을 알리지 않고 조용히 다시 열었다').toBeGreaterThan(0);
  });

  test('FR-RLC-28 모든 수신이 생존의 증거다', async ({ page }) => {
    await loadBus(page);
    await page.evaluate(() => {
      const bus = (window as any).__bus;
      bus.connect('/sse');
      const es = (window as any).__made.at(-1);
      es.readyState = 1; es.onopen();
      bus._seen = Date.now() - 100000;
    });
    // 인사가 아닌 아무 메시지 하나가 도착하면 그것으로 살아 있는 것이다.
    await send(page, { action: 'anything', args: {} });
    const alive = await page.evaluate(() => Date.now() - (window as any).__bus.lastSeen() < 1000);
    expect(alive, '인사가 아닌 수신을 생존의 증거로 세지 않았다').toBe(true);
  });

  test('FR-BUS-9 stats 가 topic 별 발행과 구독자를 답한다', async ({ page }) => {
    await loadBus(page);

    const st = await page.evaluate(() => {
      const bus = (window as any).__bus;
      bus.subscribe('tool_activity', () => {});
      bus.publish('tool_activity', {});
      bus.publish('tool_activity', {});
      const s = bus.stats();
      return s.topics.find((t: any) => t.topic === 'tool_activity');
    });

    expect(st.count, '발행 횟수를 세지 않았다').toBe(2);
    expect(st.subs, '구독자 수를 답하지 않았다').toBe(1);
    expect(st.agoMs, '마지막 발행 시각을 모른다').not.toBeNull();
  });

  // V-5: 순환 의존이 없다. 이 검사는 파일 자체를 읽는다.
  test('V-5 event-bus.js 의 코드가 TimerHub 를 참조하지 않는다', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(EVENT_BUS_JS, 'utf8');
    // 주석은 계약을 설명한다 — 위반이 아니다. 코드 줄만 본다.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code, '버스가 시간 계층을 붙들면 침묵 감시에서 순환이 생긴다 (D-2)').not.toMatch(
      /\bTimerHub\b/,
    );
  });
});
