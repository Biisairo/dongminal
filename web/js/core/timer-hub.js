/**
 * TimerHub — 앱의 **모든 시간**이 지나는 한 지점 (EVENT_TIMER_HUB_SRS 묶음 S).
 *
 * 불변 조항은 하나다 (SRS §1.2) — *모든 시간과 모든 전파는 한 군데에서 관리할
 * 수 있어야 한다.* 여기가 그 절반이고, 나머지 절반은 `EventBus` 다.
 *
 * **이 파일이 생기기 전의 모양**: 타이머 66개가 33개 파일에 흩어져 있었고, 같은
 * 규약이 서로를 모른 채 최대 네 벌 재구현돼 있었다 (SRS §2.1·2.2) — 낡은 응답
 * 폐기 4벌, single-flight 3벌, visibility 2벌, 백오프 2벌, 그리고 fetch 시한은
 * `/api/git/status` 한 곳에만 있었다. `visiblePoll` 이 그 통합의 1차 시도였고
 * 다섯 축 중 visibility 하나만 흡수하고 멈췄다.
 *
 * **표면은 다섯이지만 주체는 하나다** (INV-1). 다섯이 필요한 이유는 재는 것이
 * 서로 다르기 때문이다:
 *
 *   every  주기        마감 힙을 지난다
 *   after  1회 지연     마감 힙을 지난다
 *   defer  매크로태스크 경계   힙 우회 — 순서가 계약이다 (FR-SCH-13)
 *   sleep  호출자의 흐름       힙 우회 — await 로 쓴다 (FR-SCH-14)
 *   frame  렌더 파이프라인 위치  힙 우회 — rAF 를 그대로 통과 (FR-SCH-15)
 *
 * 우회한다고 관리 밖은 아니다. 소유자 등록·`disposeOwner`·`pending()` 은 다섯이
 * 모두 같다 — INV-1 이 요구하는 것은 한 지점을 지나는 것이지 한 큐에 들어가는
 * 것이 아니다 (FR-SCH-3a).
 */
class TimerHub {
  constructor(){
    this._jobs=new Map();     // id → job (every)
    this._ones=new Map();     // handle id → {kind, native, owner, at, label}
    this._seq=0;
    this._nextT=null;         // 마감 힙을 대신하는 단일 타이머 (FR-SCH-3)
    this._nextAt=0;
    this._hidden=()=>document.hidden;
    // FR-BUS-8: 생명주기 신호를 듣는 자리는 앱 전체에 하나다. 종전에는 네 곳이
    // 각자 `visibilitychange` 를 듣고 각자 해석했고, 그래서 순서 보장이 없었다
    // (SRS §2.7). 여기서 한 번 듣고 전부에 같은 규약으로 준다.
    this._onVis=()=>this._visibility();
    document.addEventListener('visibilitychange',this._onVis);
  }

  // ── 주기 (FR-SCH-2·4·5·6) ───────────────────────────────────────────────

  /**
   * `every` 는 **값이 아니라 함수**를 받는다 (FR-SCH-4).
   *
   * `_cadence` 의 특수 규칙 — 실패 누적 시 2ⁿ 백오프(FR-RMS-22), 저장소 소실 시
   * 고정 주기(FR-RMS-6), 기준 0 은 0 으로 남음(FR-GIT-23) — 이 스케줄러를 한
   * 줄도 건드리지 않고 살아남는다. 주기를 아는 것은 job 이지 스케줄러가 아니다.
   */
  every(spec){
    const id=spec.id||('job#'+(++this._seq));
    this._stopJob(id);
    const job={
      id, owner:spec.owner||null,
      every:typeof spec.every==='function'?spec.every:()=>spec.every,
      run:spec.run,
      when:spec.when||(()=>true),
      whenHidden:spec.whenHidden||'pause',
      revalidateOnShow:spec.revalidateOnShow!==false,
      overlap:spec.overlap||'drop',
      backoff:spec.backoff||null,
      timeout:spec.timeout||0,
      gen:0, inflight:false, again:false, failStreak:0, lastRun:0, runs:0,
      nextAt:0,
      // POLL_INTERVAL_SETTINGS_SRS D-8a: 마지막으로 **건** 주기. `refreshChanged`
      // 가 "바뀐 것만" 을 가리는 근거이며, `every()` 를 매번 견줄 대상이다.
      armedMs:null,
    };
    this._jobs.set(id,job);
    this._arm(job);
    if(spec.immediate) this._fire(job);
    return {
      id,
      stop:()=>this._stopJob(id),
      poke:()=>{const j=this._jobs.get(id); if(j) this._fire(j)},
      // 주기가 바뀌었음을 알린다. **발화하지 않는다** (FR-SCH-5·FR-RMS-28) —
      // 관측 결과로 주기를 바꾸는 자리에서 수집이 시작되면 관측이 관측을
      // 부른다 (D-RMS-10).
      refresh:()=>{const j=this._jobs.get(id); if(j) this._arm(j)},
    };
  }

  // 다음 마감을 계산해 건다. 주기 0 은 그 계층을 걸지 않는다 (FR-GIT-23).
  _arm(job){
    const ms=+job.every()||0;
    job.armedMs=ms;
    job.nextAt=ms>0?Date.now()+ms:0;
    this._reschedule();
  }

  /**
   * POLL_INTERVAL_SETTINGS_SRS FR-PIS-14·14a / D-8a — **주기가 바뀐 job 만 다시 건다.**
   *
   * 설정에서 주기를 바꾸는 자리(`_settingsApply`)가 부르는 유일한 진입점이다.
   * 핸들마다 `refresh()` 를 부르는 길은 **핸들에 닿을 수 있는 것에만** 통한다 —
   * git 콘솔의 타이머는 `observer → panels → panel._consoleView` 세 단 아래에
   * 있고, 그 길을 설정이 알아야 할 이유가 없다.
   *
   * **전부 다시 걸지 않는다.** `_arm` 은 마감을 `now+ms` 로 다시 계산하므로,
   * 안 바뀐 job 까지 걸면 설정을 한 번 만질 때마다 모든 폴링의 다음 회차가
   * 뒤로 밀린다.
   *
   * **발화하지 않는다** (FR-SCH-5 · FR-RMS-28): 주기를 바꾼 것은 수집의 계기가
   * 아니다. 다른 브라우저 창에서 바뀐 값이 SSE 로 올 때 열려 있는 창 전부가
   * 즉시 요청을 내면 그것이 곧 폭주다.
   */
  refreshChanged(){
    let n=0;
    for(const job of this._jobs.values()){
      if((+job.every()||0)===job.armedMs) continue;
      this._arm(job); n++;
    }
    return n;
  }

  _alive(job){
    if(job.whenHidden==='pause'&&this._hidden()) return false;
    return !!job.when();
  }

  async _fire(job){
    if(!this._alive(job)) return;
    if(job.inflight){
      // 겹침 정책은 job 이 고른다 (FR-SCH-7). `queue` 는 "쓰기 직후의 상태를
      // 반드시 한 번 더 본다"(FR-GIT-21), `drop` 은 "최신 스냅샷만 있으면
      // 된다". 하나로 통일하면 둘 중 하나가 깨진다.
      if(job.overlap==='queue') job.again=true;
      return;
    }
    job.inflight=true;
    const gen=++job.gen;
    job.lastRun=Date.now(); job.runs++;
    let failed=false;
    const ctx=this._ctx(job,gen);
    // 흐름 제어에 try/catch 를 쓰지 않는다. 여기서 잡는 것은 흐름이 아니라
    // **잠금**이다 — 답이 오지 않는 요청 하나가 single-flight 를 영구히 붙들면
    // 그 뒤의 모든 수집이 조용히 되돌아간다 (FR-RMS-29 · TC-SVS-64).
    try{ await job.run(ctx) }catch{ failed=true }
    job.inflight=false;
    if(failed) job.failStreak++; else job.failStreak=0;
    if(job.again){ job.again=false; this._fire(job); return }
    this._arm(job);
  }

  /**
   * 실행 맥락. 네 벌로 흩어져 있던 규약이 여기 한 벌로 선다 (SRS §2.2).
   *
   *   stale()  낡은 응답 폐기 — 종전 4벌 (seq · gen+seq · token · 집합 동일성)
   *   fetch()  시한 — 종전 1벌 (`/api/git/status` 만)
   */
  _ctx(job,gen){
    const stale=()=>job.gen!==gen;
    return {
      stale, signal:null,
      fetch:(url,opts)=>{
        const o=Object.assign({},opts||{});
        if(job.timeout&&!o.signal) o.signal=AbortSignal.timeout(job.timeout);
        return fetch(url,o);
      },
    };
  }

  _stopJob(id){
    const j=this._jobs.get(id);
    if(!j) return;
    j.gen++;            // 비행 중인 응답의 소유권을 끊는다
    this._jobs.delete(id);
    this._reschedule();
  }

  // ── 1회 지연 (FR-SCH-2) ─────────────────────────────────────────────────

  after(ms,fn,opts){
    opts=opts||{};
    const id='after#'+(++this._seq);
    this._ones.set(id,{kind:'after',owner:opts.owner||null,at:Date.now()+(+ms||0),fn,label:opts.label||''});
    this._reschedule();
    return {id, stop:()=>this._cancelOne(id)};
  }

  /**
   * `defer` 는 기다리는 것이 아니라 **순서를 미루는 것**이다 (FR-SCH-13).
   *
   * `term-pane.js` 의 IME 처리는 xterm 이 자기 `compositionend` 안에서 부르는
   * `setTimeout(0)` **뒤에 서려는 계약**이다. 큐잉하거나 병합하면 순서가 바뀌고
   * 조합 입력이 깨진다 — 그래서 마감 힙을 지나지 않고 원시 호출을 그대로 쓴다.
   */
  defer(fn,opts){
    opts=opts||{};
    const id='defer#'+(++this._seq);
    const rec={kind:'defer',owner:opts.owner||null,at:Date.now(),label:opts.label||''};
    rec.native=setTimeout(()=>{ this._ones.delete(id); fn() },0);
    this._ones.set(id,rec);
    return {id, stop:()=>this._cancelOne(id)};
  }

  /**
   * `sleep` 은 소유자가 파괴되면 **resolve 하지 않는다** (FR-SCH-14).
   *
   * 그 자리에서 async 함수가 멈추고 GC 된다. reject 하지 않는 이유는 호출부마다
   * `try/catch` 가 생기기 때문이다 — 이 저장소는 흐름 제어에 그것을 쓰지 않는다.
   * 파괴된 화면의 뒤 작업이 이어지지 않는 것이 옳은 동작이다.
   */
  sleep(ms,opts){
    opts=opts||{};
    const id='sleep#'+(++this._seq);
    return new Promise(res=>{
      const rec={kind:'sleep',owner:opts.owner||null,at:Date.now()+(+ms||0),label:opts.label||''};
      rec.native=setTimeout(()=>{ this._ones.delete(id); res() },+ms||0);
      this._ones.set(id,rec);
    });
  }

  /**
   * `frame` 은 rAF 를 그대로 통과시킨다 (FR-SCH-15). 지연을 넣지 않는다 —
   * 재는 것이 시간이 아니라 **브라우저가 레이아웃을 확정한 직후**라는 렌더
   * 파이프라인 위치이기 때문이다.
   *
   * 값어치는 지연이 아니라 소유권에 있다. 15개 중 11개가 id 를 붙들지 않는
   * fire-and-forget 이었고, 화면이 파괴된 뒤 죽은 DOM 을 만졌다.
   *
   * `coalesce` 는 같은 키의 프레임을 하나로 접는다 — `_wheelRaf`·`_mFitRaf`·
   * `_docRenderRaf` 가 손으로 하던 일이다.
   *
   * **먼저 잡힌 예약이 이긴다.** 세 곳 모두 `if(this._xRaf) return` 으로 그렇게
   * 하고 있었고, 그것이 옳다 — 나중이 이기면 연속 입력(터치 스크롤·리사이즈)에서
   * 재예약이 프레임보다 잦을 때 **영영 실행되지 않는다**. 접힌 동안의 변화는
   * 누적 상태(`_wheelPend` 같은)가 들고 있다가 한 번에 반영된다.
   */
  frame(fn,opts){
    opts=opts||{};
    const key=opts.coalesce?('frame:'+(opts.owner||'')+':'+opts.coalesce):null;
    // 이미 잡혀 있으면 그것을 돌려준다. 새 콜백은 버린다 — 누적 상태를 읽는
    // 콜백이므로 어느 쪽이 실행돼도 최신을 본다.
    if(key&&this._ones.has(key)) return {id:key, stop:()=>this._cancelOne(key)};
    const id=key||('frame#'+(++this._seq));
    const rec={kind:'frame',owner:opts.owner||null,at:Date.now(),label:opts.label||''};
    rec.native=requestAnimationFrame(()=>{ this._ones.delete(id); fn() });
    this._ones.set(id,rec);
    return {id, stop:()=>this._cancelOne(id)};
  }

  /**
   * 손잡이를 걷는다. **없어도 조용히 지난다** — `clearTimeout(undefined)` 이
   * 무해했던 것과 같다. 종전 코드 39곳이 그 관용구에 기대고 있었으므로
   * (`clearTimeout(this._timer)` 를 초기화 여부와 무관하게 부른다) 같은
   * 관용구를 준다. 여기서 까다롭게 굴면 39곳에 가드가 생긴다.
   */
  cancel(h){ if(h&&typeof h.stop==='function') h.stop() }

  _cancelOne(id){
    const r=this._ones.get(id);
    if(!r) return;
    if(r.kind==='frame') cancelAnimationFrame(r.native);
    else if(r.native!=null) clearTimeout(r.native);
    this._ones.delete(id);
    if(r.kind==='after') this._reschedule();
  }

  // ── 소유권 (FR-SCH-10) ──────────────────────────────────────────────────

  /**
   * 소유자가 사라지면 그에 걸린 일을 **전부** 걷는다. 다섯 API 가 모두 같다.
   *
   * 종전에는 `setTimeout` 45 대 `clearTimeout` 39 였고, 어느 것이 취소되는지
   * 알려면 파일 33개를 열어야 했다 (SRS §2.1). 화면 하나가 파괴될 때 그에 걸린
   * 타이머가 전부 걷혔는지 확인할 방법이 없었다.
   */
  disposeOwner(owner){
    if(owner==null) return 0;
    let n=0;
    for(const [id,j] of Array.from(this._jobs)) if(j.owner===owner){ this._stopJob(id); n++ }
    for(const [id,r] of Array.from(this._ones)) if(r.owner===owner){ this._cancelOne(id); n++ }
    return n;
  }

  // ── 마감 힙 (FR-SCH-3) ──────────────────────────────────────────────────

  /**
   * 등록된 일 중 **가장 이른 마감 하나만** 예약한다.
   *
   * 고정 tick 브로드캐스트가 아니다 — 주기가 500ms 부터 5000ms 까지 섞여 있고
   * 백오프로 2ⁿ 배까지 변하므로, 공통 tick 은 최소 주기로 깨어나 나머지를 헛돈다.
   */
  _reschedule(){
    let at=0;
    for(const j of this._jobs.values()) if(j.nextAt>0&&(!at||j.nextAt<at)) at=j.nextAt;
    for(const r of this._ones.values()) if(r.kind==='after'&&(!at||r.at<at)) at=r.at;
    if(!at){ this._clearNext(); return }
    if(this._nextT&&this._nextAt<=at) return;   // 이미 더 이른 것이 걸려 있다
    this._clearNext();
    this._nextAt=at;
    this._nextT=setTimeout(()=>{ this._nextT=null; this._tick() },Math.max(0,at-Date.now()));
  }

  _clearNext(){ if(this._nextT){ clearTimeout(this._nextT); this._nextT=null } this._nextAt=0 }

  _tick(){
    const now=Date.now();
    for(const [id,r] of Array.from(this._ones)){
      if(r.kind!=='after'||r.at>now) continue;
      this._ones.delete(id);
      r.fn();
    }
    for(const j of Array.from(this._jobs.values())){
      if(j.nextAt>0&&j.nextAt<=now) this._fire(j);
    }
    this._reschedule();
  }

  /**
   * 숨은 화면에서는 멈추고, 복귀하면 즉시 한 번 돈다
   * (FR-RST-23 · FR-STAT-17).
   *
   * 보이지 않는 화면을 위해 요청을 살릴 이유가 없다. 복귀하면 멈춰 있던 동안의
   * 낡음을 그 자리에서 갚는다 — 한 주기를 더 기다리면 돌아온 화면이 낡은 채다.
   */
  _visibility(){
    if(this._hidden()){ this._reschedule(); return }
    for(const j of this._jobs.values()){
      if(j.whenHidden==='pause'&&j.revalidateOnShow&&this._alive(j)) this._fire(j);
    }
    this._reschedule();
  }

  // ── 진단 (FR-SCH-11) ────────────────────────────────────────────────────

  /**
   * 대기 중인 일 전부. e2e 정지 판정(E2E_QUIESCENCE_SRS)이 추정에서 사실이 되고,
   * `?diag=1` 오버레이가 "무엇이 언제 돌았나" 를 한 곳에서 답한다.
   */
  pending(){
    const now=Date.now(), out=[];
    for(const j of this._jobs.values()) out.push({
      kind:'every', id:j.id, owner:j.owner, inMs:j.nextAt?j.nextAt-now:null,
      every:+j.every()||0, runs:j.runs, fails:j.failStreak, inflight:j.inflight,
    });
    for(const [id,r] of this._ones) out.push({
      kind:r.kind, id, owner:r.owner, inMs:r.kind==='after'?r.at-now:0, label:r.label,
    });
    return out;
  }

  dispose(){
    document.removeEventListener('visibilitychange',this._onVis);
    for(const id of Array.from(this._jobs.keys())) this._stopJob(id);
    for(const id of Array.from(this._ones.keys())) this._cancelOne(id);
    this._clearNext();
  }
}

/**
 * 앱의 유일한 시간 (INV-1).
 *
 * **모듈 로드 시점에 선다.** `BootScreen` 은 `App` 이 생기기 전에 화면을 덮고
 * 스스로 시한을 걸며(`BOOT_MAX_MS`), `TermPane`·`Toast`·`GitPanel` 은 `app` 을
 * 거치지 않고 자기 타이머를 건다. 전역 하나가 없으면 그 파일들이 각자 인스턴스를
 * 만들게 되고, 그 순간 "한 군데" 가 깨진다.
 *
 * `App` 은 이것을 `this.timers` 로 들고, 검사는 `new TimerHub()` 로 격리한
 * 인스턴스를 쓴다.
 */
const TIMERS=new TimerHub();
