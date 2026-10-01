/**
 * 터미널의 터치 스크롤 (MOBILE_TUI_INPUT_SCROLL_SRS §3.2 · UX_BATCH11_SRS FR-MTS).
 * `term-input.js` 의 증강 분할이다 — 계약은 `TerminalTool` 한 클래스에 남고 주제만 이 파일로
 * 옮겼다 (FE_MODULE_BOUNDARY 규약).
 */

/**
 * FR-MTS-1: 모은 픽셀(`acc`+`px`)을 행 높이 `rh` 로 나눈 행 수 `n`(부호 있음)과 남는 픽셀 `rest`.
 * 행 높이를 모르면 내지 않고 쥐고 있는다.
 */
function termWheelSteps(acc,px,rh){
  const total=(acc||0)+(px||0);
  if(!(rh>0)) return {n:0,rest:total};
  const n=Math.trunc(total/rh);
  return {n,rest:total-n*rh};
}

/**
 * FR-MTS-5: 관성의 처음 속도(px/ms). `samples` 는 `{t, y}` 의 시간순 목록이고, 창 `win` 안의 첫·끝
 * 표본으로 잰다. 손가락이 위로 가면(y 가 줄면) 양수다 — 스크롤 delta 와 같은 부호. 표본이 둘 미만이거나
 * 마지막 표본이 `now` 보다 창 이상 오래됐으면(멈췄다 뗐으면) 0 이다.
 */
function termTouchVelocity(samples,now,win){
  if(!samples||samples.length<2) return 0;
  const last=samples[samples.length-1];
  if(now-last.t>=win) return 0;
  let first=null;
  for(const s of samples){ if(last.t-s.t<=win){ first=s; break } }
  if(!first||first===last||last.t<=first.t) return 0;
  return (first.y-last.y)/(last.t-first.t);
}

Object.assign(TerminalTool.prototype, {
  // FR-MTI-8: capture 단계에서 가로채 xterm 의 1:1 터치 경로와 선택 경로에
  // 도달하지 않게 한다. xterm 쪽은 관성이 없다.
  _initTouchScroll(){
    const opt={capture:true,passive:false};
    this.el.addEventListener('touchstart',e=>this._tsStart(e),opt);
    this.el.addEventListener('touchmove',e=>this._tsMove(e),opt);
    this.el.addEventListener('touchend',e=>this._tsEnd(e),opt);
    this.el.addEventListener('touchcancel',e=>this._tsEnd(e),opt);
    // FR-MTI-29: Chrome 은 제스처가 끝난 뒤 합성 마우스 이벤트를 낸다. 마우스
    // 리포팅이 켜진 TUI 에는 그것이 클릭으로 전달된다 — 실기기 로그에서 스크롤
    // 제스처가 ESC[<0;32;22M/m 을 보내고 있었다. 스크롤한 것을 클릭으로 받으면
    // TUI 가 엉뚱하게 반응한다. 스크롤로 판정된 제스처의 합성분만 막는다.
    for(const type of ['mousedown','mouseup','click']){
      this.el.addEventListener(type,e=>{
        if(!this._tsSuppressUntil||Date.now()>this._tsSuppressUntil) return;
        e.preventDefault();e.stopPropagation();
      },true);
    }
    // UX_BATCH11_SRS FR-TCP-7·8: 길게 누르기는 OS 의 선택이다 — 그 배선은 `term-clip.js` 에 있다.
    this._wireNativeSelect();
  },

  /** FR-MTS-6: 모바일 레이아웃이거나 주 포인터가 coarse(터치 기기)면 터치 스크롤이 선다. */
  _tsTouch(){
    if(window.app&&window.app.isMobile) return true;
    return !!(window.matchMedia&&window.matchMedia('(pointer: coarse)').matches);
  },

  _tsStart(e){
    this._flingStop();
    this._tsY0=null;
    if(!this._tsTouch()) return;
    if(!e.touches || e.touches.length!==1) return;
    const p=e.touches[0];
    this._tsY0=this._tsY=p.clientY;
    this._tsX0=this._tsX=p.clientX;
    this._tsActive=false;
    // 앞 손짓의 한 행 미만 나머지는 이 손짓에 넘기지 않는다.
    this._wheelRest=0;
    this._tsSamples=[{t:e.timeStamp,y:p.clientY}];
  },

  _tsMove(e){
    if(this._tsY0===null||this._tsY0===undefined) return;
    if(!e.touches || e.touches.length!==1) return;
    const p=e.touches[0];
    const x=p.clientX, y=p.clientY;
    this._tsX=x;
    if(!this._tsActive){
      // FR-MTI-9: slop 이내는 탭이다 — 그대로 통과시켜 포커스를 남긴다.
      // 여기서 preventDefault 하면 Chrome 이 이 제스처의 합성 마우스 이벤트를
      // 억제해 탭 → 포커스 경로까지 죽는다 (FR-MTI-24 철회 근거).
      if(Math.abs(y-this._tsY0)<MTI_TOUCH_SLOP_PX) return;
      this._tsActive=true;
      // UX_BATCH11_SRS FR-MTS-4: slop 을 지난 거리도 넣는다 — 버리면 출발이 한 박자 늦다.
      this._tsY=this._tsY0;
      // FR-MTI-22: Android Chrome 은 focus 된 입력 요소가 있는 동안 페이지를
      // 탭하면 키보드를 재표시한다. 스크롤하려고 만졌을 뿐인데 키보드가 올라오고,
      // 그것이 window resize → fit → 재렌더로 이어진다. 제스처가 스크롤로
      // 확정된 순간 포커스를 놓는다. 제스처가 끝나도 되돌리지 않는다 —
      // 되돌리면 키보드가 다시 올라온다.
      this._blurInput();
    }
    const dy=this._tsY-y;
    this._tsY=y;
    const ss=this._tsSamples;
    ss.push({t:e.timeStamp,y});
    // 창보다 오래된 것은 쓰이지 않는다 — 긴 끌기에서 목록이 자라지 않게 한다.
    while(ss.length>2&&ss[ss.length-1].t-ss[1].t>MTI_VELOCITY_WINDOW_MS) ss.shift();
    e.preventDefault();e.stopPropagation();
    this._touchScrollBy(dy*MTI_TOUCH_GAIN);
  },

  _tsEnd(e){
    const wasActive=this._tsActive;
    this._tsY0=null;this._tsActive=false;
    if(!wasActive) return;
    e.preventDefault();e.stopPropagation();
    this._tsSuppressUntil=Date.now()+MTI_SYNTH_MOUSE_MS;   // FR-MTI-29
    // UX_BATCH11_SRS FR-MTS-5: 최근 창의 속도(px/ms)에서 시작해, 프레임 사이의 실제 시간만큼
    // 가고 그 시간만큼 감쇠한다. 멈췄다 뗐으면 속도가 0 이다.
    let v=termTouchVelocity(this._tsSamples,e.timeStamp,MTI_VELOCITY_WINDOW_MS)*MTI_TOUCH_GAIN;
    if(Math.abs(v)>MTI_FLING_MAX_V) v=v<0?-MTI_FLING_MAX_V:MTI_FLING_MAX_V;
    if(Math.abs(v)<MTI_FLING_MIN_V) return;
    let last=performance.now();
    const step=()=>{
      this._flingId=null;
      const now=performance.now(), dt=now-last;
      last=now;
      this._touchScrollBy(v*dt);
      v*=Math.pow(MTI_FLING_DECAY,dt/MTI_FRAME_MS);
      if(Math.abs(v)<MTI_FLING_MIN_V) return;
      this._flingId=TIMERS.frame(step,{owner:this,label:'fling'});
    };
    this._flingId=TIMERS.frame(step,{owner:this,label:'fling'});
  },

  _flingStop(){
    if(this._flingId){TIMERS.cancel(this._flingId);this._flingId=null}
    if(this._wheelRaf){TIMERS.cancel(this._wheelRaf);this._wheelRaf=null;this._wheelPend=0}
  },

  // FR-MTI-28: 스크롤을 직접 처리하지 않고 xterm 의 wheel 경로로 넘긴다.
  //
  // scrollLines 로 직접 움직이던 이전 구현은 스크롤백이 있을 때만 동작했다.
  // 실기기 로그에서 이 TUI 는 마우스 리포팅을 켜고 있었고(SGR 리포트가 실제로
  // 전송됐다), 그런 TUI 는 스크롤을 스크롤백이 아니라 자기가 처리한다 — 화면을
  // 재렌더하므로 스크롤백은 rows 만큼밖에 없다(실측 len==rows, 제스처 내내 vY=0).
  //
  // 합성 wheel 을 넘기면 xterm 이 상태에 맞게 갈라준다:
  //   · 마우스 리포팅 ON  → 프로토콜(SGR/일반)에 맞는 휠 리포트 전송 → TUI 가 스크롤
  //   · OFF, 스크롤백 있음 → viewport 스크롤
  //   · OFF, alt screen    → 위/아래 방향키로 변환
  // FR-MTI-32: 터치는 한 프레임에 여러 번 발화한다 — 내는 것은 프레임당 한 번이다.
  // UX_BATCH11_SRS FR-MTS-1: 그 한 번에 **한 행마다 wheel 하나**를 낸다. xterm 은 마우스 리포팅
  // TUI 에 wheel 하나당 리포트를 하나만 보내므로, 한 wheel 로 합치면 나머지 행이 버려졌다.
  _touchScrollBy(px){
    if(!px) return;
    this._wheelPend=(this._wheelPend||0)+px;
    this._wheelRaf=TIMERS.frame(()=>{
      this._wheelRaf=null;
      const d=this._wheelPend; this._wheelPend=0;
      const rh=this._rowHeight();
      const {n,rest}=termWheelSteps(this._wheelRest,d,rh);
      this._wheelRest=rest;
      for(let i=0;i<Math.abs(n);i++) this._dispatchWheel(n<0?-rh:rh);
    },{owner:this,coalesce:'wheel'});
  },

  /** 한 행의 CSS 높이. xterm 이 wheel 을 행으로 바꿀 때 쓰는 값과 같아야 한 wheel 이 정확히 한 행이다. */
  _rowHeight(){
    const core=this.term&&this.term._core;
    const dims=core&&core._renderService&&core._renderService.dimensions;
    const h=dims&&dims.css&&dims.css.cell&&dims.css.cell.height;
    if(h>0) return h;
    const scr=this.term&&this.term.element&&this.term.element.querySelector('.xterm-screen');
    return scr&&this.term.rows?scr.getBoundingClientRect().height/this.term.rows:0;
  },

  // FR-MTS-3: 좌표는 마지막 손가락 자리다 — 마우스 리포트는 그 칸을 싣는다.
  // 손가락이 없으면(손짓 밖에서 불렸으면) 터미널 가운데다.
  _dispatchWheel(px){
    const el=this.term&&this.term.element;
    if(!el) return;
    const r=el.getBoundingClientRect();
    const touching=this._tsX!==undefined&&this._tsY!==undefined;
    try{
      el.dispatchEvent(new WheelEvent('wheel',{
        deltaY:px, deltaX:0, deltaMode:0,
        clientX:touching?this._tsX:r.left+r.width/2, clientY:touching?this._tsY:r.top+r.height/2,
        bubbles:true, cancelable:true,
      }));
    }catch{}
  },
});
