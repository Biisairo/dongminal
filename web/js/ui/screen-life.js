/**
 * ScreenLife — 탭 본문 주인의 생명주기 전이 (PERF M3 §3.5, FR-SPA-3, D-36·D-37·D-38).
 *
 * 계약은 메서드 넷이다: `mount(host)`·`wake()`·`sleep()`·`unmount()`. 기반 클래스를 강제하지 않는다(D-37).
 * **`wake` 와 `sleep` 을 둘 다 가진 주인만** 이 전이를 탄다 — 갖지 않은 주인은 손대지 않는다. `mount`·`unmount` 는
 * 있으면 부른다.
 *
 * 무엇이 보이는지는 렌더러 한 자리가 정한다(`Renderer._lifeCommit`). 그릴 때마다 이번에 보인 주인 집합을
 * `commit` 으로 받아 지난 집합과 견준다:
 *
 *   처음 보임        mount(host) → wake()
 *   빠짐             `SCREEN_SLEEP_MS` 뒤 sleep() 을 예약한다. 이미 예약됐으면 늘리지 않는다
 *   예약 중 다시 보임  예약을 걷는다. 아무것도 부르지 않는다
 *   잠든 뒤 다시 보임  wake()
 *
 * 주인이 사라질 때는 걷는 자리가 `unmount(owner)` 를 부른다 — 예약을 걷고 잊는다. 잠든 상태여도 같다.
 *
 * 브라우저 탭 숨김은 `TimerHub` 의 하나뿐인 `visibilitychange` 에서 받아 `pageHidden` 에 둔다(FR-BUS-8).
 * 그 신호로 잠드는 규칙은 3.5.4 가 정한다(D-M3-8).
 */
class ScreenLife extends Component {
  constructor(app){
    super();
    this.app=app;
    this._owners=new Map();   // owner → {state:'awake'|'pending'|'asleep', timer}
    this.pageHidden=false;
    this.own(this._hub().onVisibility(hidden=>{ this.pageHidden=hidden }).stop);
  }

  /** @param {Map<object, Element>} shown 이번 그리기에 보인 주인 → 그 본문이 붙은 자리 */
  commit(shown){
    for(const [o,host] of shown){
      if(typeof o.wake!=='function'||typeof o.sleep!=='function') continue;
      const e=this._owners.get(o);
      if(!e){
        this._owners.set(o,{state:'awake',timer:null});
        if(typeof o.mount==='function') o.mount(host);
        o.wake();
      }else if(e.state==='pending'){
        e.timer.stop(); e.timer=null; e.state='awake';
      }else if(e.state==='asleep'){
        e.state='awake';
        o.wake();
      }
    }
    for(const [o,e] of this._owners){
      if(e.state!=='awake'||shown.has(o)) continue;
      e.state='pending';
      e.timer=this.after(SCREEN_SLEEP_MS,()=>this._sleep(o));
    }
  }

  unmount(o){
    const e=this._owners.get(o);
    if(!e) return;
    if(e.timer) e.timer.stop();
    this._owners.delete(o);
    if(typeof o.unmount==='function') o.unmount();
  }

  /** 잠들기를 기다리는 주인 수. */
  pending(){
    let n=0;
    for(const e of this._owners.values()) if(e.state==='pending') n++;
    return n;
  }

  /** `app.testing.sleepers()` — 잠든 주인과 그 주인(또는 깬 동안 도우미)에게 남은 타이머·토픽 구독 수. */
  sleepers(){
    const out=[];
    const pend=this._hub().pending();
    const ch=this.app&&this.app.channel;
    for(const [o,e] of this._owners){
      if(e.state!=='asleep') continue;
      const mine=w=>w===o||(w!=null&&w.parent===o);
      out.push({
        kind:o.constructor&&o.constructor.name,
        timers:pend.filter(r=>mine(r.owner)).length,
        subs:ch?ch.countOwned(mine):0,
      });
    }
    return out;
  }

  _sleep(o){
    const e=this._owners.get(o);
    if(!e||e.state!=='pending') return;
    e.state='asleep'; e.timer=null;
    o.sleep();
  }
}
