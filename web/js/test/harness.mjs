import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * 클래식 `<script>` 를 Node 에서 불러오는 30줄 하네스
 * (CI_GATES_SRS B4 · `05-test.md §3.4`).
 *
 * `web/js` 는 모듈이 아니다 — `web/index.html` 이 `<script>` 85개를 순서대로
 * 싣고 그 안의 `class`/`function`/`const` 가 전역으로 서로를 본다
 * (`type="module"` 0개). 그래서 `import` 로는 꺼낼 수 없다.
 *
 * ESM 으로 옮기는 것이 정공법이지만 그것은 85개의 로드 순서와 `__ASSETV__`
 * 캐시 버스팅에 얽힌 별도 결정이다. **그때까지 순수 로직을 검사 못 할 이유는
 * 없다** — `vm.createContext` 에 같은 순서로 넣으면 브라우저가 하는 일과 같다.
 *
 * 지금 이 자리가 없어서 생긴 것: `git-hunk.spec.ts:407-448` 의 "묶음 S — 좌표
 * 사상 (단위)" 5건이 **브라우저를 띄워 순수 함수를 검사한다.** 단위 테스트를
 * e2e 로 돌리고 있었다는 뜻이다.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const JS_ROOT = join(HERE, '..');

/**
 * 최소 브라우저 대역. **필요한 것만 둔다** — 넓은 대역은 검사 대상이 실제로
 * 무엇에 기대는지를 감춘다.
 */
function browserStub(clock) {
  const listeners = new Map();
  return {
    document: {
      hidden: false,
      addEventListener: (t, fn) => { listeners.set(t, fn) },
      removeEventListener: (t) => { listeners.delete(t) },
      /** 검사가 가시성 변화를 흉내내는 자리. */
      _fire: (t) => { const fn = listeners.get(t); if (fn) fn() },
    },
    requestAnimationFrame: (fn) => clock.setTimeout(fn, 16),
    cancelAnimationFrame: (h) => clock.clearTimeout(h),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: clock.Date,
    console,
  };
}

/**
 * 가짜 시계. `TimerHub` 는 `Date.now()` 와 `setTimeout` 위에 서 있으므로, 그 둘을
 * 쥐면 주기 동작을 **실시간을 기다리지 않고** 결정적으로 잴 수 있다.
 *
 * 실시간 대기로 재면 그 검사는 느리고 흔들린다 — e2e 의 `waitForTimeout` 224회가
 * 그렇게 생겼다 (`05-test.md §3.2`).
 */
/** 대기 중인 마이크로태스크를 전부 비운다. */
const drain = () => new Promise((r) => setImmediate(r));

export function fakeClock(start = 1_700_000_000_000) {
  let now = start, seq = 0;
  const timers = new Map();
  const clock = {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (+ms || 0), fn }); return id },
    clearTimeout: (id) => { timers.delete(id) },
    Date: class extends Date {
      static now() { return now }
    },
    now: () => now,
    /**
     * ms 만큼 흘린다. 그 사이에 걸린 타이머를 시각 순서대로 돌린다.
     *
     * **비동기다.** `TimerHub._fire` 는 `await job.run(ctx)` 를 지나므로 다음
     * 마감을 거는 `_arm` 이 마이크로태스크로 밀린다. 동기 루프로 흘리면 그
     * 재무장이 아직 일어나지 않은 상태에서 다음 타이머를 찾게 되어, 주기 job 이
     * 한 번만 돌고 멈춘 것처럼 보인다.
     */
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await drain();
      }
      now = until;
      await drain();
    },
    pending: () => timers.size,
  };
  return clock;
}

/**
 * `web/js` 아래의 스크립트들을 **하나의 스크립트로 이어** 싣는다.
 *
 * 이어 붙이는 것이 핵심이다. 브라우저의 클래식 `<script>` 들은 **하나의 전역
 * 렉시컬 환경**을 공유하므로, A 파일의 `const X` 를 B 파일이 그대로 본다.
 * `vm.Script` 를 파일마다 따로 돌리면 그 공유가 사라져 `X is not defined` 가
 * 난다 — 브라우저에서 나지 않는 오류를 검사가 만들어 내는 셈이다.
 *
 * 같은 이유로 최상위 `const`·`let`·`class` 는 `globalThis` 의 속성이 **아니다**
 * (그것은 `var` 와 함수 선언만 그렇다). 그래서 꺼내 볼 이름을 `expose` 로 받아
 * 같은 스크립트 끝에서 전역에 얹는다.
 *
 * @param {string[]} files `web/js` 기준 상대 경로. **index.html 과 같은 순서로 준다.**
 * @param {object} [opts]
 * @param {string[]} [opts.expose] 꺼내 볼 최상위 `const`/`class` 이름들.
 * @param {ReturnType<typeof fakeClock>} [opts.clock]
 * @returns 컨텍스트. 함수 선언과 `expose` 한 이름이 속성으로 보인다.
 */
export function load(files, opts = {}) {
  const clock = opts.clock || fakeClock();
  const ctx = vm.createContext({ ...browserStub(clock), _clock: clock });
  ctx.globalThis = ctx;
  ctx.window = ctx;

  const parts = [];
  for (const rel of files) {
    // 실패한 줄을 찾을 수 있게 경계를 남긴다. 이어 붙이므로 스택의 줄 번호는
    // 합친 소스의 것이다.
    parts.push('/* ==== web/js/' + rel + ' ==== */');
    parts.push(readFileSync(join(JS_ROOT, rel), 'utf8'));
  }
  const expose = opts.expose || [];
  if (expose.length) {
    parts.push(';Object.assign(globalThis, { ' + expose.join(', ') + ' });');
  }
  new vm.Script(parts.join('\n'), { filename: 'web/js/<' + files.join('+') + '>' }).runInContext(ctx);
  return ctx;
}

/**
 * vm 컨텍스트의 값을 **호스트 실인(realm)의 값**으로 옮긴다.
 *
 * `vm.createContext` 는 새 실인을 만들므로 그 안의 배열·객체는 호스트의
 * `Array.prototype` 을 갖지 않는다. `assert.deepStrictEqual` 은 프로토타입까지
 * 보므로, 내용이 같아도 실패한다 — 출력에 `actual [1,1]` 과 `expected [1,1]` 이
 * 나란히 찍히는 그 모양이다.
 *
 * 느슨한 `deepEqual` 로 내리면 그 문제는 사라지지만 `'1'` 과 `1` 을 같다고 하므로
 * 검사가 약해진다. 옮기고 나서 엄격하게 보는 쪽이 옳다.
 */
export function plain(v) {
  return structuredClone(v);
}
