/**
 * Component — 프론트 부품 계층의 뿌리 (REFACTOR3_FE_BASE_SRS FR-FEB-10 · `FE_OBJECT_MODEL.md` §3).
 *
 * 수명을 한 자리에 묶는다. 리스너·관측·타이머·구독을 걸 때 해제를 함께 쌓아 두고 `dispose()` 한 번으로
 * 전부 놓는다. 종전에는 해제 규약이 셋(주인 id · 해제 함수 · 없음)으로 갈려 있었다.
 *
 * 타이머와 구독은 이 인스턴스를 주인(owner)으로 넘긴다. `TimerHub`·`EventBus` 의 `disposeOwner` 는 주인을
 * `===` 로 견주므로 객체가 주인이 될 수 있다.
 *
 * opts.timers · opts.bus: 시간과 전파. 주지 않으면 `this.app` 의 것, 그다음 전역(`TIMERS` · `window.app.bus`)이다.
 * 부를 때 찾는다 — 하위(`Controller`)는 `super()` 뒤에 `app` 을 둔다.
 */
class Component {
  constructor(opts){
    const o=opts||{};
    this._timers=o.timers||null;
    this._bus=o.bus||null;
    this._disposers=[];
    this.disposed=false;
  }

  /** 해제 함수를 쌓는다. 받은 함수를 그대로 돌려준다. */
  own(disposer){
    this._disposers.push(disposer);
    return disposer;
  }

  /** 리스너를 달고 떼는 일을 쌓는다. 떼는 함수를 돌려준다. */
  listen(target,type,fn,opts){
    target.addEventListener(type,fn,opts);
    return this.own(()=>target.removeEventListener(type,fn,opts));
  }

  /** Resize·MutationObserver 를 걸고 끊는 일을 쌓는다. 관측자를 돌려준다. */
  observe(observer,target,opts){
    observer.observe(target,opts);
    this.own(()=>observer.disconnect());
    return observer;
  }

  /** `TimerHub.after` — 손잡이 `{id, stop}` 을 돌려준다. */
  after(ms,fn){ return this._hub().after(ms,fn,{owner:this}) }

  /** `TimerHub.every` — `ms` 는 값이나 함수다(FR-SCH-4). */
  every(ms,fn){ return this._hub().every({owner:this,every:ms,run:fn}) }

  /** `EventBus.subscribe` — 손잡이 `{topic, stop}` 을 돌려준다. */
  on(topic,fn){ return this._channel().subscribe(topic,fn,{owner:this}) }

  /**
   * 깬 동안만 사는 것을 건다 (PERF M3 D-37, FR-SPA-3). `fn(a)` 는 깰 때마다 불리고, 그 안에서 `a` 로 건 구독·타이머·관측은
   * 잠들 때 모두 걷힌다. 도우미 `Awake` 를 돌려준다 — 주인의 `wake`·`sleep` 이 그것의 `wake`·`sleep` 을 부른다.
   */
  awake(fn){
    if(!this._awake){
      this._awake=new Awake({parent:this});
      this.own(()=>this._awake.dispose());
    }
    return this._awake.add(fn);
  }

  /** 쌓인 해제를 거꾸로 부르고 주인으로 건 타이머·구독을 걷는다. 두 번째부터는 아무것도 하지 않는다. */
  dispose(){
    if(this.disposed) return;
    this.disposed=true;
    this._release();
  }

  _release(){
    const ds=this._disposers;
    this._disposers=[];
    for(let i=ds.length-1;i>=0;i--) ds[i]();
    this._hub().disposeOwner(this);
    const bus=this._channel();
    if(bus) bus.disposeOwner(this);
  }

  _hub(){ return this._timers||(this.app&&this.app.timers)||TIMERS }

  _channel(){
    return this._bus||(this.app&&this.app.bus)||(typeof window!=='undefined'&&window.app&&window.app.bus)||null;
  }
}

/**
 * Awake — 깬 동안만 사는 것의 주인 (PERF M3 D-37, FR-SPA-3).
 *
 * `add(fn)` 으로 받은 것을 `wake()` 때마다 부르고, 그 안에서 이 인스턴스로 건 리스너·관측·타이머·구독·토픽(`sub`)을
 * `sleep()` 때 모두 걷는다. 두 번 불러도 한 번만 건다·걷는다. `dispose()` 뒤에는 다시 깨지 않는다.
 * `Component` 는 `awake(fn)` 으로 이것을 하나 든다. `Component` 가 아닌 주인(`TerminalTool` 등)은 직접 만든다.
 *
 * opts.parent: 시간·전파를 찾을 주인. opts.channel: 토픽 채널 — 없으면 `parent.app`, 그다음 `window.app` 의 것이다.
 */
class Awake extends Component {
  constructor(opts){
    super(opts);
    const o=opts||{};
    this.parent=o.parent||null;
    this._chan=o.channel||null;
    this._fns=[];
    this.isAwake=false;
  }

  /** 깰 때 부를 것을 더한다. 이미 깨 있으면 곧바로 부른다. */
  add(fn){
    this._fns.push(fn);
    if(this.isAwake) fn(this);
    return this;
  }

  wake(){
    if(this.isAwake||this.disposed) return;
    this.isAwake=true;
    for(const fn of this._fns) fn(this);
  }

  sleep(){
    if(!this.isAwake) return;
    this.isAwake=false;
    this._release();
  }

  /** 채널 토픽 구독(`Channel.sub`). 잠들 때 놓이고, 마지막 구독자가 빠지면 서버에 `unsub` 이 간다. */
  sub(topic,fn){ return this._topics().sub(topic,fn,{owner:this}) }

  dispose(){
    this.sleep();
    this._fns=[];
    this.disposed=true;
  }

  _release(){
    super._release();
    const ch=this._topics();
    if(ch) ch.disposeOwner(this);
  }

  _hub(){ const p=this.parent; return this._timers||(p&&p._hub?p._hub():null)||super._hub() }

  _channel(){ const p=this.parent; return this._bus||(p&&p._channel?p._channel():null)||super._channel() }

  _topics(){
    const p=this.parent;
    return this._chan||(p&&p.app&&p.app.channel)||(typeof window!=='undefined'&&window.app&&window.app.channel)||null;
  }
}
