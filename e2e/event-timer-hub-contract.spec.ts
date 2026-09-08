import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled } from './fixtures';

// 최상위 `class` 선언은 **전역 객체의 프로퍼티가 아니다** (`const`·`let` 과 같은
// 규칙). `window.TimerHub` 로는 잡히지 않으므로 이름으로 직접 조회한다 —
// `page.evaluate` 의 본문은 브라우저의 전역 스코프에서 실행되므로 그것이 닿는다.
declare const TimerHub: any;
declare const EventBus: any;


// EVENT_TIMER_HUB_SRS §4.1 — 계약 고정 (T-1·2·5·6·7·10·11·12).
//
// 이 스펙은 **아직 존재하지 않는 구조를 위한 것이 아니다.** 지금 코드가 이미
// 지키고 있는 계약을 못박아, `TimerHub`·`EventBus` 이관이 그것을 흘리는 순간
// 실패하게 만든다. 그래서 이관 **전에** 통과해야 하고, 이관 후에도 같은 것이
// 통과해야 한다 (SRS 단계 0).
//
// T-3·T-4 는 `version-autoreload.spec.ts` (TC-RLC-25·27), T-8·T-9 는
// `slot-view-state.spec.ts` (TC-SVS-22·53) 가 이미 재고 있다 — 다시 쓰지 않는다.
//
// 재는 방식은 `sse-resilience.spec.ts` 의 관용구를 따른다: 빈 페이지에 대상
// 파일만 얹고 계약만 시험한다. 앱을 통째로 띄우면 무엇이 계약이고 무엇이 우연인지
// 구분되지 않는다.

const WEB = join(process.cwd(), 'web', 'js');
const APP_CMD_JS = join(WEB, 'core', 'app-cmd.js');
const HELPERS_JS = join(WEB, 'core', 'helpers.js');
const TIMER_HUB_JS = join(WEB, 'core', 'timer-hub.js');
const CONST_GIT_JS = join(WEB, 'core', 'constants-git.js');
const EVENT_BUS_JS = join(WEB, 'core', 'event-bus.js');
const PANEL_POLL_JS = join(WEB, 'git', 'panel-poll.js');

// ─────────────────────────────────────────────────────────────────────────────
// T-1·T-2 — 푸시와 스냅샷의 경쟁 (REMOTE_STATE_SNAPSHOT_SRS FR-RSF-3·5·7)
//
// 스냅샷은 그 상태의 **전체 판**이고 SSE 증분은 **변화 한 조각**이다. 스냅샷이
// 비행하는 동안 도착한 증분은 더 새로운데, 늦게 도착한 스냅샷이 그것을 되돌린다.
// `_restore*` 가 그 경쟁을 막는 장치이며, 이관 후에는 EventBus 의 `merge:'touched'`
// 가 같은 일을 해야 한다 (SRS FR-BUS-6).
// ─────────────────────────────────────────────────────────────────────────────

async function loadRestoreProtocol(page: Page) {
  await page.setContent('<!doctype html><title>restore-protocol</title>');
  await page.addScriptTag({ path: EVENT_BUS_JS });
  await page.evaluate(() => {
    // app-cmd.js 는 App.prototype 에 메서드를 얹는다. 껍데기만 세운다 —
    // `_fgApply` 가 만지는 것은 `_fgMap()` 이 돌려주는 Map 하나뿐이다.
    (window as any).App = class {
      clientId = 'test-client';
      _fg = new Map();
      // `_fgApply` 는 이름이 바뀐 도구의 탭을 다시 그린다 — 그 경로가 딛는
      // 최소한만 세운다. 빈 워크스페이스면 그릴 탭이 없어 무해하게 지난다.
      ws = { windows: [] as any[] };
      _fgMap() {
        return this._fg;
      }
      _flattenPanes() {
        return [];
      }
      _fgPaint() {}
      _repaintTabs() {}
      // 경쟁 해소는 이제 버스가 소유한다 (FR-BUS-6). `_restore*` 는 위임
      // 껍데기이므로, 그것을 재려면 버스가 서 있어야 한다. 침묵 감시를 쓰지
      // 않으므로 타이머는 주입하지 않는다.
      bus = new EventBus({ clientId: 'test-client' }, {});
    };
  });
  await page.addScriptTag({ path: APP_CMD_JS });
  await page.evaluate(() => {
    (window as any).__app = new (window as any).App();
  });
}

test.describe('T-1·T-2 — 스냅샷과 증분의 경쟁 (FR-RSF-3·5·7)', () => {
  // T-1: 비행 중 증분이 만진 id 는 뒤늦게 도착한 스냅샷이 덮지 않는다.
  //
  // `_fgApply(tools, touched)` 가 그 계약의 자리다 — `touched` 에 든 id 는
  // 스냅샷보다 새로우므로 **추가도 삭제도 하지 않는다**.
  test('T-1 비행 중 증분이 만진 id 를 스냅샷이 덮지 않는다', async ({ page }) => {
    await loadRestoreProtocol(page);

    const r = await page.evaluate(() => {
      const app = (window as any).__app;
      // ① 증분이 먼저 도착해 X 의 전경 이름을 세웠다.
      app._fgMap().set('X', 'from-sse');

      // ② 스냅샷 비행이 시작되고, 그 사이 증분이 X 를 만졌다고 기록한다.
      const t = app._restoreBegin('fg');
      app._restoreNote('fg', 'X');

      // ③ X 를 **모르는** 스냅샷이 뒤늦게 도착한다. 보호가 없으면 X 가 지워진다.
      app._fgApply([{ id: 'Y', fgName: 'from-snapshot' }], t);

      return { x: app._fgMap().get('X') || null, y: app._fgMap().get('Y') || null };
    });

    expect(r.x, '증분이 만진 id 를 스냅샷이 지웠다 (FR-RSF-3)').toBe('from-sse');
    expect(r.y, '스냅샷이 나른 id 가 반영되지 않았다').toBe('from-snapshot');
  });

  // T-1b: touched 를 주지 않으면 스냅샷이 전부를 정한다 (FR-RSF-7).
  // 비행이 아닌 동기 경로(`_applyRemoteWorkspace`)가 그렇게 부른다.
  test('T-1b touched 없는 호출에서는 스냅샷이 전부를 정한다', async ({ page }) => {
    await loadRestoreProtocol(page);

    const left = await page.evaluate(() => {
      const app = (window as any).__app;
      app._fgMap().set('X', 'stale');
      app._fgApply([{ id: 'Y', fgName: 'fresh' }]);
      return { x: app._fgMap().get('X') || null, y: app._fgMap().get('Y') || null };
    });

    expect(left.x, 'touched 가 없는데도 낡은 id 가 살아남았다 (FR-RSF-7)').toBeNull();
    expect(left.y).toBe('fresh');
  });

  // T-2: 전체 초기화는 만진 id 로 표현되지 않는다 — 그 비행은 통째로 버린다.
  test('T-2 전체 초기화는 비행을 통째로 버린다 (FR-RSF-5)', async ({ page }) => {
    await loadRestoreProtocol(page);

    const r = await page.evaluate(() => {
      const app = (window as any).__app;
      const t = app._restoreBegin('attn');
      const before = app._restoreLive('attn', t);
      app._restoreVoid('attn'); // 전체 초기화가 일어났다
      return { before, after: app._restoreLive('attn', t) };
    });

    expect(r.before, '갓 시작한 비행이 살아 있지 않다').toBe(true);
    expect(r.after, '초기화 뒤에도 비행이 살아 응답을 반영한다 (FR-RSF-5)').toBe(false);
  });

  // T-2b: 뒤에 시작한 비행이 앞의 비행을 무효로 만든다 (추월).
  test('T-2b 나중 비행이 앞선 비행을 무효로 만든다 (FR-RSF-3)', async ({ page }) => {
    await loadRestoreProtocol(page);

    const r = await page.evaluate(() => {
      const app = (window as any).__app;
      const first = app._restoreBegin('activity');
      const second = app._restoreBegin('activity');
      return {
        first: app._restoreLive('activity', first),
        second: app._restoreLive('activity', second),
      };
    });

    expect(r.first, '추월당한 비행이 여전히 응답을 반영한다').toBe(false);
    expect(r.second, '최신 비행이 살아 있지 않다').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T-5·T-6·T-7·T-11 — 주기·백오프·잠금 (GIT_REPO_MISSING_SRS FR-RMS-22·28·29,
// FR-GIT-23)
//
// `GitObserver`(= panel-poll 의 폴링 계층)는 다섯 축을 전부 자체 구현해 둔
// 유일한 자리다. SRS 단계 6 이 이것을 흡수하며, 그때 아래 넷이 한 줄도 흔들리면
// 안 된다.
// ─────────────────────────────────────────────────────────────────────────────

async function loadPanelPoll(page: Page) {
  await page.setContent('<!doctype html><title>panel-poll</title>');
  await page.addScriptTag({ path: TIMER_HUB_JS });
  await page.addScriptTag({ path: CONST_GIT_JS });
  await page.evaluate(() => {
    // panel-poll.js 는 GitPanel.prototype 에 얹는다. 폴링 계층이 딛는 것만 세운다.
    // `_applyStatus` 는 **덮지 않는다** — 실패가 `_fail()` 을 지나 `_failStreak`
    // 를 올리고 백오프를 다시 거는 그 경로가 곧 T-5·T-7 의 실질이기 때문이다.
    // 대신 그것이 부르는 관측자(`obs`)와 이웃 파일의 메서드만 세운다.
    (window as any).GitPanel = class {
      repo = '/tmp/repo';
      root = '';
      obs = {
        ticks: [] as string[],
        paints: 0,
        tick(k: string) { this.ticks.push(k) },
        paintAll() { this.paints++ },
        paintAllViews() {},
        notifyStatusAll() {},
        reloadDiffAll() {},
        reloadViewsAll() {},
        reloadStaleViewsAll() {},
      };
      _busy = false;
      _again = false;
      _seq = 0;
      _failStreak = 0;
      _missing = null as string | null;
      _gitMissing = false;
      _staleNote = false;
      _obsSig = null as any;
      _pollOn = false;
      // POLL_INTERVAL_SETTINGS_SRS FR-PIS-1: signature 폴링 계층이 사라졌다 —
      // `_sigPoll` 도 함께 걷는다.
      _stPoll = null as any;
      app = {
        _gitWindow: () => ({ id: 'w1' }),
        _edWindowFor: () => ({ id: 'w1' }),
        _windowVisible: () => true,
        _gitSurfaceOn: () => true,
      };
      token() { return 'tok' }
      isStale() { return false }
      // 이웃 파일(panel-life·panel-views)의 것. 폴링 계층은 부르기만 한다.
      _leaveMissing() {}
      _viewFp() { return '' }
      _paint() {}
    };
    // 주기는 설정으로 덮을 수 있다 (FR-GIT-23) — 전역이 그 자리다.
    (window as any).gitStatusInterval = 1000;
    (window as any).pathJoin = (a: string, b: string) => a + '/' + b;
  });
  await page.addScriptTag({ path: PANEL_POLL_JS });
  await page.evaluate(() => {
    (window as any).__p = new (window as any).GitPanel();
  });
}

test.describe('T-5·6·7·11 — 주기와 잠금 (FR-RMS-22·28·29 · FR-GIT-23)', () => {
  // T-5: 실패가 쌓이면 주기가 2ⁿ 로 늘고 상한에서 멈춘다.
  test('T-5 실패 누적이 주기를 2ⁿ 로 늘리고 상한에서 멈춘다 (FR-RMS-22)', async ({ page }) => {
    await loadPanelPoll(page);

    // 상한**값**을 재지 않는다. 계약은 "상한이 있다" 이지 "30000 이다" 가 아니며,
    // 상수를 조정할 때 검사가 깨지면 그 검사는 계약을 지키는 것이 아니다.
    const seen = await page.evaluate(() => {
      const p = (window as any).__p;
      const out: any[] = [];
      for (const n of [0, 1, 2, 3, 20, 40]) {
        p._failStreak = n;
        out.push(p._cadence(1000, 500));
      }
      return out;
    });

    expect(seen[0], '실패가 없는데 주기가 늘었다').toEqual({ st: 1000, sig: 500 });
    expect(seen[1], '1회 실패에 2배가 아니다').toEqual({ st: 2000, sig: 1000 });
    expect(seen[2], '2회 실패에 4배가 아니다').toEqual({ st: 4000, sig: 2000 });
    expect(seen[3], '3회 실패에 8배가 아니다').toEqual({ st: 8000, sig: 4000 });
    // 20회와 40회가 같다는 것이 곧 상한의 존재다 — 없다면 2²⁰ 배가 더 벌어진다.
    expect(seen[5], '백오프에 상한이 없다 — 주기가 무한히 늘어난다').toEqual(seen[4]);
    expect(seen[4].st, '상한이 기준 주기보다 작다').toBeGreaterThan(1000);
  });

  // T-11: 기준 0 은 0 으로 남는다. 실패가 그것을 되살리면 사용자가 끈 것이
  // 저절로 켜진다 (FR-GIT-23).
  /**
   * POLL_INTERVAL_SETTINGS_SRS FR-PIS-4: `_cadence` 의 인자가 둘에서 하나가 됐다.
   *
   * 종전에는 켜 둔 계층이 백오프를 받는지도 함께 쟀는데, 그 "켜 둔 계층" 이
   * signature 였다. 백오프 규약 자체는 status 로 그대로 잰다 — 재던 것은 계층의
   * 개수가 아니라 **0 이 백오프를 이긴다**는 것이었다.
   */
  test('T-11 주기 0 은 실패가 쌓여도 0 이고, 그 계층을 걸지 않는다 (FR-GIT-23)', async ({ page }) => {
    await loadPanelPoll(page);

    const r = await page.evaluate(() => {
      const p = (window as any).__p;
      p._failStreak = 5;
      const off = p._cadence(0);
      const on = p._cadence(500);

      // 실제로 타이머가 걸리는지도 본다 — status 주기가 0 이면 그 계층은 없다.
      (window as any).gitStatusInterval = 0;
      p._failStreak = 0;
      p._applyCadence();
      return { off, on, st: p._stPoll };
    });

    expect(r.off, '꺼 둔 계층을 백오프가 되살렸다 (FR-GIT-23)').toBe(0);
    expect(r.on, '켜 둔 계층이 백오프를 받지 않았다').toBeGreaterThan(500);
    expect(r.st, '주기 0 인데 status 타이머가 걸렸다').toBeNull();
  });

  // T-6: 주기를 다시 거는 것과 수집하는 것은 다른 일이다.
  //
  // 관측 결과로 주기를 바꾸는 자리에서 수집이 시작되면 관측이 관측을 부른다 —
  // 실패·성공이 번갈아 오는 동안 요청이 배로 늘어난다 (D-RMS-10).
  test('T-6 주기 재계산은 수집을 부르지 않는다 (FR-RMS-28)', async ({ page }) => {
    await loadPanelPoll(page);

    const r = await page.evaluate(() => {
      const p = (window as any).__p;
      let collects = 0;
      p.collect = () => { collects++ };

      p._failStreak = 0;
      p._applyCadence();               // 최초 등록
      const afterFirst = collects;

      p._failStreak = 3;               // 관측 결과로 주기가 바뀌었다
      const changed = p._applyCadence();
      const afterCadence = collects;

      p._failStreak = 0;
      p._reschedule();                 // 조건이 참이 됐다 → 여기서만 수집한다
      return { afterFirst, changed, afterCadence, afterReschedule: collects };
    });

    expect(r.afterFirst, '주기 등록이 수집을 불렀다 (FR-RMS-28)').toBe(0);
    expect(r.changed, '주기가 바뀌었는데 다시 걸지 않았다').toBe(true);
    expect(r.afterCadence, '주기 변경이 수집을 불렀다 — 관측이 관측을 부른다 (D-RMS-10)').toBe(0);
    expect(r.afterReschedule, '_reschedule 이 즉시 1회 수집하지 않았다 (FR-GIT-22)').toBe(1);
  });

  // T-7: 답이 오지 않는 요청 하나가 single-flight 잠금을 영구히 붙들면 안 된다.
  //
  // Windows 러너 실측: 46초 동안 signature 요청만 돌고 status 는 한 건도 없었다
  // (TC-SVS-64). 타이머는 살아 있는데 status 만 멎는 모양이다.
  test('T-7 응답이 오지 않아도 single-flight 잠금이 풀린다 (FR-RMS-29)', async ({ page }) => {
    await loadPanelPoll(page);

    const r = await page.evaluate(async () => {
      const p = (window as any).__p;
      // 시한을 넘긴 요청은 망 실패와 같은 길을 간다 — 그것을 흉내낸다.
      (window as any).fetch = () => Promise.reject(new DOMException('timeout', 'TimeoutError'));

      let calls = 0;
      const base = (window as any).fetch;
      (window as any).fetch = () => {
        calls++;
        return base();
      };

      await p.collect();
      const afterFail = { busy: p._busy, streak: p._failStreak, calls };

      // 잠금이 풀렸으므로 다음 수집이 실제로 나가야 한다.
      await p.collect();
      return { afterFail, calls, streak: p._failStreak };
    });

    expect(r.afterFail.busy, '시한을 넘긴 요청이 잠금을 영구히 붙들었다 (FR-RMS-29)').toBe(false);
    expect(r.afterFail.streak, '실패가 백오프 경로를 지나지 않았다 (FR-RMS-22)').toBe(1);
    expect(r.calls, '잠금이 풀렸는데도 다음 수집이 조용히 되돌아갔다').toBe(2);
    expect(r.streak, '두 번째 실패가 누적되지 않았다').toBe(2);
  });

  // T-7b: 수집 중에 들어온 요청은 버려지지 않고 "끝나면 한 번 더" 로 남는다.
  // 이관 후에는 `overlap:'queue'` 가 같은 일을 해야 한다 (SRS FR-SCH-7).
  test('T-7b 수집 중의 요청은 끝난 뒤 한 번 더로 남는다 (FR-GIT-21)', async ({ page }) => {
    await loadPanelPoll(page);

    const n = await page.evaluate(async () => {
      const p = (window as any).__p;
      let calls = 0;
      let release: any = null;
      (window as any).fetch = () => {
        calls++;
        return new Promise((res) => { release = () => res(null) });
      };

      const first = p.collect();
      await new Promise((r) => setTimeout(r, 0));
      p.collect();                       // 비행 중 — 버려지지 않아야 한다
      const again = p._again;
      // 첫 요청을 실패로 끝낸다. 그러면 대기하던 한 번이 나간다.
      (window as any).fetch = () => Promise.reject(new Error('down'));
      release();
      await first;
      await new Promise((r) => setTimeout(r, 0));
      return { again, calls };
    });

    expect(n.again, '비행 중 요청이 흔적 없이 버려졌다 (FR-GIT-21)').toBe(true);
    expect(n.calls, '대기하던 수집이 끝난 뒤에 나가지 않았다').toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T-10 — 숨은 화면에서는 멈추고, 복귀하면 즉시 한 번 (FR-RST-23 · FR-STAT-17)
//
// `visiblePoll` 이 이 통합의 1차 시도이고, 다섯 축 중 이 하나만 흡수했다.
// `TimerHub` 는 이 계약을 `whenHidden`·`revalidateOnShow` 로 이어받는다.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('T-10 — 숨김 정지와 복귀 갱신 (FR-RST-23 · FR-STAT-17)', () => {
  test('T-10 숨은 동안 멈추고 복귀하면 즉시 한 번 돈다', async ({ page }) => {
    await page.setContent('<!doctype html><title>visible-poll</title>');
    await page.addScriptTag({ path: TIMER_HUB_JS });
    await page.addScriptTag({ path: HELPERS_JS });

    const r = await page.evaluate(async () => {
      let hidden = false;
      Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
      const fire = () => document.dispatchEvent(new Event('visibilitychange'));

      // FR-HUB-6: `visiblePoll` 은 스케줄러 위의 래퍼가 됐다. 앱 없이 재므로
      // 주입한다 — **재는 것은 바뀌지 않는다**.
      const sched = new TimerHub();
      let n = 0;
      const h = (window as any).visiblePoll(20, () => { n++ }, { sched });

      await new Promise((r) => setTimeout(r, 70));
      const whileVisible = n;

      // 숨긴다 — 보이지 않는 화면을 위해 요청을 살릴 이유가 없다 (FR-STAT-17).
      hidden = true;
      fire();
      const atHide = n;
      await new Promise((r) => setTimeout(r, 70));
      const whileHidden = n;

      // 복귀하면 멈춰 있던 동안의 낡음을 그 자리에서 갚는다 (FR-RST-23).
      hidden = false;
      fire();
      const atShow = n;

      h.stop();
      const atStop = n;
      await new Promise((r) => setTimeout(r, 70));
      return { whileVisible, atHide, whileHidden, atShow, atStop, afterStop: n };
    });

    expect(r.whileVisible, '보이는 동안 주기가 돌지 않았다').toBeGreaterThan(0);
    expect(r.whileHidden, '숨은 화면에서 폴링이 계속됐다 (FR-STAT-17)').toBe(r.atHide);
    expect(r.atShow, '복귀했는데 즉시 갱신하지 않았다 (FR-RST-23)').toBe(r.whileHidden + 1);
    expect(r.afterStop, 'stop 뒤에도 타이머가 살아 있다').toBe(r.atStop);
  });

  test('T-10b when 이 거짓이면 보여도 돌지 않는다 (FR-RST-23)', async ({ page }) => {
    await page.setContent('<!doctype html><title>visible-poll-when</title>');
    await page.addScriptTag({ path: TIMER_HUB_JS });
    await page.addScriptTag({ path: HELPERS_JS });

    const r = await page.evaluate(async () => {
      const sched = new TimerHub();
      let on = false;
      let n = 0;
      const h = (window as any).visiblePoll(20, () => { n++ }, { when: () => on, sched });
      await new Promise((r) => setTimeout(r, 70));
      const off = n;
      on = true;
      await new Promise((r) => setTimeout(r, 70));
      h.stop();
      return { off, onCount: n };
    });

    expect(r.off, 'when 이 거짓인데 돌았다').toBe(0);
    expect(r.onCount, 'when 이 참이 됐는데 돌지 않았다').toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T-12 — 소프트리로드가 다섯 상태를 전부 재검증한다 (SRS §2.4)
//
// **지금 코드에 없는 검사다.** `app-reload.js` 는 다섯 상태를 손으로 나열하고
// 각 줄에 `&&` 가드를 달고 있어, 이름이 하나 바뀌면 그 상태만 조용히 빠진다 —
// `w.editor.refresh()` 가 정확히 그렇게 삼켜졌다 (FR-WBR-95).
//
// 이관 뒤에는 이 목록이 `state-registry` 에서 파생되므로 빠뜨림이 구조적으로
// 불가능해진다. 그때까지 이 검사가 그 자리를 지킨다.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('T-12 — 소프트리로드의 재검증 목록 (SRS §2.4)', () => {
  test('T-12 소프트리로드가 다섯 상태를 전부 재검증한다', async ({ page }) => {
    await waitForInit(page);
    await waitSettled(page);

    const seen = await page.evaluate(async () => {
      const app = (window as any).app;
      const keys = ['_attnRestore', '_activityRestore', '_bgRefresh', '_focusRestore', '_fgRestore'];

      // 존재 자체가 계약이다 — `&&` 가드는 없는 이름을 조용히 삼킨다.
      const missing = keys.filter((k) => typeof app[k] !== 'function');

      const called: string[] = [];
      const orig: any = {};
      for (const k of keys) {
        orig[k] = app[k].bind(app);
        app[k] = (...a: any[]) => { called.push(k); return orig[k](...a) };
      }
      await app.softReload();
      for (const k of keys) app[k] = orig[k];

      return { missing, called };
    });

    expect(seen.missing, '재검증 대상 이름이 사라졌다 — 가드가 조용히 삼킨다 (FR-WBR-95)').toEqual([]);
    for (const k of ['_attnRestore', '_activityRestore', '_bgRefresh', '_focusRestore', '_fgRestore']) {
      expect(seen.called, `소프트리로드가 ${k} 를 재검증하지 않았다 (SRS §2.4)`).toContain(k);
    }
  });
});
