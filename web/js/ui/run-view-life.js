/**
 * Otterminal — Run 뷰의 생명주기 (`RunsPanel.prototype` 증강, PERF M3 §3.5 · FR-SPA-3)
 *
 * 뷰(`runViewEl` 이 탭·칸마다 세우는 것)가 탭 본문의 주인이다. 렌더러가 `runViewOwner` 로 그것을 받아
 * `wake`·`sleep` 을 부른다.
 *
 * 로드 순서: `runs-panel.js` **뒤**.
 */

Object.assign(RunsPanel.prototype, {

  /** 새 뷰에 생명주기 계약을 단다. */
  _runLifeArm(v) {
    v.lifeKind = 'RunView';
    v.wake = () => this._runWake(v);
    v.sleep = () => this._runSleep(v);
  },

  /** 렌더러가 생명주기에 넘길 그 탭·칸의 뷰 (`runViewEl` 뒤에 부른다). */
  runViewOwner(tab, slot) {
    return this._runViewMap().get(this.app.slot.slotKey(tab.id, slot || 0)) || null;
  },

  /**
   * PERF M3 §3.5 (FR-SPA-3): 잠든 뷰는 `run:<id>` 를 놓고 다시 받지 않는다. 다시 보이면 `runViewEl` 이 다시 구독하고
   * (서버가 최신 그래프를 민다, FR-CON-4), 잠든 동안 건너뛴 다시 받기가 있었으면 깰 때 한 번 받는다.
   *   이전: 가려진 Run 탭도 구독을 쥐고, 바뀔 때마다 /graph 를 다시 받아 그렸다
   *   새:   가려지고 2초 뒤 잠들면 구독·다시 받기·그리기가 0 이다
   *   이유: 잠든 화면은 구독·그리기를 하지 않는다
   */
  _runSleep(v) {
    v.asleep = true;
    if (v.sub) { v.sub.stop(); v.sub = null }
    v.subRun = null;
    // 강조가 꺼질 때의 다시 그리기 예약 — 깨면 `runViewEl` 의 그리기가 다시 건다.
    if (v.decay) { TIMERS.cancel(v.decay); v.decay = null }
  },

  _runWake(v) {
    v.asleep = false;
    if (!v.stale) return;
    v.stale = false; v.err = null;
    this._runFetch(v);
  }
});
