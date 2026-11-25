/**
 * EventBus — 앱의 **모든 전파**가 지나는 한 지점 (EVENT_TIMER_HUB_SRS 묶음 B).
 *
 * 불변 조항의 나머지 절반이다 (SRS §1.2 INV-2). `TimerHub` 가 "언제" 를 갖고,
 * 여기가 "무엇이 누구에게" 를 갖는다.
 *
 * **이 파일이 생기기 전의 모양** (SRS §2.3·2.6·2.7):
 *
 *   · 같은 갱신 목록이 세 곳에 손으로 나열돼 있었다 — `onopen` 한 줄,
 *     `_softStep` 다섯 줄, `onmessage` 13분기. 새 상태를 더하면 셋을 다 고쳐야
 *     했고 하나를 빠뜨리면 조용히 안 갱신됐다.
 *   · 그 빠뜨림이 실제로 일어났다 — `w.editor.refresh()` 가 `typeof` 가드에
 *     삼켜져 탐색기만 낡은 채 남았다 (FR-WBR-95).
 *   · 한 action 에 구독자가 둘일 수 없었다. 두 곳이 알아야 하면 한쪽이 다른
 *     쪽을 직접 부르는 배선이 생겼다.
 *   · 같은 생명주기 신호를 네 곳이 각자 듣고 각자 해석했다. 순서 보장이 없어
 *     SSE 를 깨우기 전에 폴링이 먼저 돌면 그 회차는 죽은 채널을 딛었다.
 *
 * **`TimerHub` 를 참조하지 않는다** (SRS C-6 · D-2 · V-5). 침묵 감시는 타이머를
 * 쓰지만, 버스가 시간 계층을 붙들면 침묵 감시에서 순환이 생긴다 —
 * 버스 → 스케줄러 → (콜백) → 버스. 그래서 타이머를 **주입받는다**: 배선은
 * `main.js` 가 하고, 이 파일의 **코드**에 그 이름은 나오지 않는다.
 */
/**
 * 생명주기 토픽 (GIT_LIVE_TRIGGERS_SRS FR-GLW-8).
 *
 * **접두가 있어야 한다.** 이 버스의 토픽 이름공간과 서버 명령(채널 `cmd`)의 `action`
 * 이름공간은 같은 공간이고(`route` 가 `action` 을 그대로 토픽으로 쓴다),
 * 겹치는 이름을 구독하면 그 명령이 처리기에 닿지 못한다. `chan:open` 이 세워 둔
 * 규약을 그대로 따른다.
 *
 * 이 파일에 두는 이유는 **발행하는 쪽이 여기**이고, 계약 검사가 이 파일 하나만
 * 올려 놓고 돌기 때문이다.
 */
const LIFE_ONLINE='life:online';
const LIFE_FOCUS='life:focus';
const LIFE_HIDDEN='life:hidden';
const LIFE_VISIBLE='life:visible';

class EventBus {
  /**
   * @param {object} app  위임 껍데기가 남는 자리 (FR-HUB-7)
   * @param {{every:Function, after:Function}} timers  주입된 시간. TimerHub 의
   *        표면만 받는다 — 그것이 무엇인지는 알 필요가 없다.
   */
  constructor(app, timers){
    this.app=app;
    this._t=timers||{};
    this._subs=new Map();        // topic → Set<{fn, owner}>
    this._counts=new Map();      // topic → 발행 횟수 (FR-BUS-9)
    this._last=new Map();        // topic → 마지막 발행 시각
    this._flight={};             // 경쟁 해소 (FR-BUS-6)
    this._fallback=null;         // 구독자 없는 action 이 가는 곳
    this._wake=null;             // 깨어남에 부를 것 — 채널의 kick (CHANNEL_PROTOCOL C2a)
    this._lifecycleOn=false;
  }

  // ── 구독과 발행 (FR-BUS-3) ──────────────────────────────────────────────

  subscribe(topic, fn, opts){
    opts=opts||{};
    let set=this._subs.get(topic);
    if(!set){ set=new Set(); this._subs.set(topic,set) }
    const rec={fn, owner:opts.owner||null};
    set.add(rec);
    return {topic, stop:()=>{ set.delete(rec); if(!set.size) this._subs.delete(topic) }};
  }

  // 한 topic 에 구독자가 여럿일 수 있다. 하나가 던져도 나머지는 받는다 —
  // 종전 if-체인은 한 분기의 예외가 그 뒤 전부를 삼켰다.
  publish(topic, args){
    this._counts.set(topic,(this._counts.get(topic)||0)+1);
    this._last.set(topic,Date.now());
    const set=this._subs.get(topic);
    if(!set) return 0;
    let n=0;
    for(const r of Array.from(set)){
      n++;
      try{ r.fn(args||{}, topic) }catch(e){ console.error('[bus]',topic,e) }
    }
    return n;
  }

  has(topic){ const s=this._subs.get(topic); return !!(s&&s.size) }

  disposeOwner(owner){
    if(owner==null) return 0;
    let n=0;
    for(const [topic,set] of Array.from(this._subs)){
      for(const r of Array.from(set)) if(r.owner===owner){ set.delete(r); n++ }
      if(!set.size) this._subs.delete(topic);
    }
    return n;
  }

  // 구독자가 없는 action 이 가는 곳. 서버가 지명한 실행자만 수행한다 (FR-SXE-3).
  setFallback(fn){ this._fallback=fn }

  setWake(fn){ this._wake=fn }

  // ── 경쟁 해소 (FR-BUS-6 · FR-RSF-3·5·7) ─────────────────────────────────

  /**
   * 스냅샷은 그 상태의 **전체 판**이고 증분은 **변화 한 조각**이다. 스냅샷이
   * 비행하는 동안 도착한 증분은 더 새로운데, 늦게 도착한 스냅샷이 그것을
   * 되돌린다. 비행을 **집합의 동일성**으로 식별해 그것을 막는다 — 추월당한
   * 비행은 그 자리에서 죽는다.
   *
   * 종전에는 이 방어가 `fg`·`attn`·`activity` **셋에만** 있었고
   * `background`·`focus` 는 같은 경쟁에 열려 있었다 (SRS §2.5). 버스가 소유하면
   * 다섯 전부가 같은 규약을 받는다.
   */
  beginSnapshot(key){ const flight=new Set(); this._flight[key]=flight; return flight }
  isLive(key,flight){ return this._flight[key]===flight }
  inFlight(key){ return !!this._flight[key] }
  noteTouched(key,id){ const flight=this._flight[key]; if(flight&&id) flight.add(id) }
  // 전체 초기화는 만진 id 로 표현되지 않는다. 그 비행은 통째로 버린다 (FR-RSF-5).
  voidSnapshot(key){ this._flight[key]=null }
  endSnapshot(key,flight){ if(this.isLive(key,flight)) this._flight[key]=null }

  // ── 생명주기 (FR-BUS-8) ─────────────────────────────────────────────────

  /**
   * 생명주기 신호를 듣는 자리는 앱 전체에 **하나**다.
   *
   * 순서가 여기서 결정된다 — `chan:open` 이 먼저 서고 그 다음에 상태들이 자기
   * 스냅샷을 받는다. 종전에는 네 리스너가 각자 깨어나 순서가 없었다.
   *
   * **토픽에 `life:` 를 붙인다** (GIT_LIVE_TRIGGERS_SRS FR-GLW-8).
   *
   *   이전 동작: `online`·`focus`·`hidden`·`visible` 을 그 이름 그대로 발행했다
   *   새  동작: `life:` 접두를 붙인다 — `chan:open` 과 같은 규약이다
   *   이유:     `route` 는 **구독자가 있는 action 을 지명 검사 앞에서
   *             가로챈다** (FR-BUS-5). 그러므로 토픽 이름이 서버 `action` 과
   *             겹치면 그 토픽을 구독하는 순간 같은 이름의 **명령이 죽는다** —
   *             `_fallback` 에 닿지 않는다. 서버는 `{"action":"focus"}` 를
   *             보내고 그것이 pane 포커스를 옮긴다 (`tool-cmd.js` `_execRemote`).
   *             구독자가 하나도 없던 동안에는 드러나지 않던 지뢰이며, 첫 구독이
   *             그것을 밟았다 (TC-SXE-7 실패)
   */
  startLifecycle(){
    if(this._lifecycleOn) return;
    this._lifecycleOn=true;
    // FR-RLC-26: 살아 있으면 침묵부터 보고, 끊겼으면 백오프를 기다리지 않는다 — 판정은 채널이 한다.
    const wake=()=>{ if(this._wake) this._wake() };
    window.addEventListener('online',()=>{ this.publish(LIFE_ONLINE,{}); wake() });
    window.addEventListener('focus',()=>{ this.publish(LIFE_FOCUS,{}); wake() });
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden){ this.publish(LIFE_HIDDEN,{}); return }
      this.publish(LIFE_VISIBLE,{});
      wake();
    });
  }

  /**
   * 13분기 if-체인이 **라우팅 테이블**이 된다 (FR-BUS-4).
   *
   * 게이팅 순서를 보존한다 (FR-BUS-5). 구독자가 있는 action 은 지명 검사를
   * 지나지 않는다 — 종전 코드에서 그 아홉이 `execClientId` 검사 **앞**에 있었기
   * 때문이다. 순서를 바꾸면 워크스페이스 변경이 지명받지 못한 클라이언트에
   * 도달하지 않는다.
   */
  route(m){
    if(!m||!m.action) return;
    if(this.has(m.action)){ this.publish(m.action, m.args||{}); return }
    // 서버가 실행자를 지명한 명령은 그 클라이언트만 수행한다 (FR-SXE-3).
    // 어떤 action 을 게이팅할지는 서버만 정하므로 여기서 종류를 보지 않는다.
    if(m.execClientId&&!this._isMine(m.execClientId)) return;
    const args=m.args||{};
    if(m.reqId) args.reqId=m.reqId;   // echo correlation
    if(this._fallback) this._fallback(m.action, args);
  }

  /**
   * PERF 4.3: 이 브라우저 창의 **모든 칸 신원**이 내 것이다 (FR-WSL-10·13).
   *
   *   이전 동작: `app.clientId`(칸 [0]) 하나와만 비교했다
   *   새  동작: 지금 열린 칸들의 신원 집합과 비교한다. 실행은 이 창이 한 번 하고,
   *             문맥은 지명된 칸이 아니라 지금의 포커스 칸이다 (FR-WSL-54)
   *   이유:     칸 [1] 이상이 포커스를 주장하면 서버는 그 칸 신원을 실행자로 지명한다
   *             (FR-SXE-4). 채널은 창 하나에 하나라 아무도 자기 것으로 알아보지 못해
   *             생성·닫기 명령이 버려졌다 (`timedOut`)
   */
  _isMine(id){
    if(id===this.app.clientId) return true;
    const s=this.app.slot;
    return !!s&&s._slotIdentities().includes(id);
  }

  // ── 진단 (FR-BUS-9) ─────────────────────────────────────────────────────

  /**
   * topic 별 발행 횟수·마지막 시각·구독자 수. `?diag=1` 오버레이에 얹으면
   * "이벤트가 안 온다" 가 재현 대신 스냅샷으로 해결된다 — 종전 진단은
   * `console.error('[cmd] parse')` 한 줄이 전부였다.
   */
  stats(){
    const now=Date.now(), out=[];
    const topics=new Set([...this._subs.keys(), ...this._counts.keys()]);
    for(const topic of topics){
      const set=this._subs.get(topic);
      out.push({
        topic:topic, subs:set?set.size:0,
        count:this._counts.get(topic)||0,
        agoMs:this._last.has(topic)?now-this._last.get(topic):null,
      });
    }
    out.sort((a,b)=>a.topic<b.topic?-1:1);
    return {topics:out};
  }
}
