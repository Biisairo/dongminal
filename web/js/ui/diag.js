/**
 * Remote Terminal — 실기기 진단 오버레이
 *
 * `?diag=1` 로 접속할 때만 동작한다. 그 밖에는 아무 것도 하지 않는다.
 *
 * 존재 이유: 모바일의 터치·소프트 키보드·IME 결함은 Chromium 에뮬레이션에서
 * 재현되지 않는다(합성 마우스 이벤트와 실제 키보드가 없다). 그래서 추측으로
 * 두 차례 잘못된 곳을 고쳤다. 실기기에서 이벤트 순서와 상태를 직접 받는 것이
 * 유일하게 신뢰할 수 있는 경로다.
 *
 * 로그는 [전송] 으로 기존 /api/upload 에 파일로 올린다 — 서버 표면을 늘리지
 * 않는다. LAN(http) 접속에서는 clipboard API 가 막혀 복사가 불가능하다.
 */
(function(){
  if(!/[?&]diag=1(&|$)/.test(location.search)) return;

  const MAX=600;
  const lines=[];
  let paused=false;

  const el=document.createElement('div');
  el.id='diag-ov';
  el.innerHTML=
    '<div class="dg-bar">'+
      '<span class="dg-t">DIAG</span>'+
      '<button class="dg-b" data-a="send" title="Upload this log to the server as a file">전송</button>'+
      '<button class="dg-b" data-a="clear" title="Clear the collected log lines">지우기</button>'+
      '<button class="dg-b" data-a="pause" title="Pause and resume log collection">멈춤</button>'+
      '<button class="dg-b" data-a="env" title="Log the current environment (viewport, user agent, feature flags)">환경</button>'+
      '<button class="dg-b" data-a="hub" title="Dump pending timers and event topics (TimerHub / EventBus)">허브</button>'+
      '<button class="dg-b" data-a="err" title="Dump uncaught errors and unhandled promise rejections">오류</button>'+
      '<button class="dg-b" data-a="min" title="Minimize this overlay">─</button>'+
    '</div>'+
    '<div class="dg-log"></div>';
  const style=document.createElement('style');
  style.textContent=
    '#diag-ov{position:fixed;left:0;right:0;top:0;z-index:9999;background:rgba(0,0,0,.88);'+
      'color:#0f0;font:10px/1.35 ui-monospace,monospace;max-height:45vh;display:flex;flex-direction:column;'+
      'border-bottom:1px solid #0a0}'+
    '#diag-ov.min .dg-log{display:none}'+
    '#diag-ov .dg-bar{display:flex;gap:4px;align-items:center;padding:3px 4px;flex:0 0 auto;'+
      'background:#020;border-bottom:1px solid #060}'+
    '#diag-ov .dg-t{color:#0f0;font-weight:700;margin-right:auto}'+
    '#diag-ov .dg-b{background:#030;border:1px solid #0a0;color:#0f0;font:10px ui-monospace,monospace;'+
      'padding:3px 6px;border-radius:3px}'+
    '#diag-ov .dg-log{overflow-y:auto;padding:3px 4px;white-space:pre-wrap;word-break:break-all;'+
      '-webkit-user-select:text;user-select:text}';
  document.head.appendChild(style);
  document.body.appendChild(el);
  const logEl=el.querySelector('.dg-log');

  const t0=Date.now();
  function put(s){
    if(paused) return;
    lines.push(((Date.now()-t0)/1000).toFixed(2)+' '+s);
    if(lines.length>MAX) lines.splice(0,lines.length-MAX);
    logEl.textContent=lines.slice(-60).join('\n');
    logEl.scrollTop=logEl.scrollHeight;
  }

  const cn=(n)=>{
    if(!n) return 'null';
    if(n===document.body) return 'body';
    const c=(n.className&&typeof n.className==='string')?('.'+n.className.trim().split(/\s+/).join('.')):'';
    return (n.tagName||'?').toLowerCase()+c;
  };

  function pane(){
    const a=window.app;
    if(!a||!a._focusedTerminal) return null;
    try{return a._focusedTerminal()}catch{return null}
  }
  function scrollState(){
    const p=pane(); if(!p||!p.term) return 'no-pane';
    const b=p.term.buffer.active;
    const vp=p.el.querySelector('.xterm-viewport');
    return 'vY='+b.viewportY+' baseY='+b.baseY+' len='+b.length+' rows='+p.term.rows+
      ' sTop='+(vp?Math.round(vp.scrollTop):-1)+' sH='+(vp?vp.scrollHeight:-1)+' cH='+(vp?vp.clientHeight:-1);
  }

  /**
   * UX_BATCH9_SRS FR-GLR-5: **지금 이 git 화면이 언제의 것인가.**
   *
   * 자동 갱신이 멎어도 화면에는 낡은 목록이 정상처럼 그려져 있다 (SRS §2.4).
   * 그 침묵을 깨는 값이 관측의 나이이며, 워치독이 판정에 쓰는 것과 같은 값이다.
   */
  function gitObsState(){
    const a=window.app;
    if(!a||!a._gitPanels||!a._gitPanels.size) return 'git: 패널 없음';
    const out=[];
    for(const p of a._gitPanels.values()){
      const age=p._lastObsAt?Math.round((Date.now()-p._lastObsAt)/1000)+'s':'never';
      out.push((p.repo||'-')+' obs='+age+' poll='+(p._pollOn?p._pollSt:'off'));
    }
    return 'git: '+out.join(' | ');
  }

  function env(){
    const a=window.app;
    const p=pane();
    const tp=p?p.el:null;
    const vv=window.visualViewport;
    put('--- ENV ---');
    put('ua='+navigator.userAgent);
    put('ver='+(document.querySelector('script[src*="term-pane.js"]')||{}).getAttribute?.('src'));
    put('isMobile='+(a?a.isMobile:'?')+' displayMode='+(a?a.displayMode:'?')+' bp='+(a?a.mobileBreakpoint:'?'));
    put('body.mobile='+document.body.classList.contains('mobile')+' kbUp='+document.body.classList.contains('keyboard-up'));
    put('innerW/H='+window.innerWidth+'/'+window.innerHeight+' dpr='+window.devicePixelRatio);
    put('vv='+(vv?(Math.round(vv.width)+'/'+Math.round(vv.height)+' offTop='+Math.round(vv.offsetTop)+' scale='+vv.scale.toFixed(2)):'none'));
    put('tp.touchAction='+(tp?getComputedStyle(tp).touchAction:'?'));
    put('vp.overflowY='+(p?getComputedStyle(p.el.querySelector('.xterm-viewport')||document.body).overflowY:'?'));
    put('hasTouchScrollHook='+!!(p&&p._tsStart)+' hasBeforeInput='+!!(p&&p._onBeforeInput));
    put('mouseEventsActive='+(p&&p.term&&p.term._core&&p.term._core.coreMouseService?p.term._core.coreMouseService.areMouseEventsActive:'?'));
    put('active='+cn(document.activeElement));
    put(scrollState());
    put(gitObsState());
    put('--- /ENV ---');
  }

  // ── 터치 ──
  // capture 로 발생을 기록하고, setTimeout 으로 처리 완료 후의 defaultPrevented 를 읽는다.
  // 이 방식은 중간에서 stopPropagation 되어도 관측이 끊기지 않는다.
  for(const type of ['touchstart','touchmove','touchend','touchcancel']){
    window.addEventListener(type,(e)=>{
      const p=pane();
      const t=e.touches&&e.touches[0];
      const info=type+' n='+(e.touches?e.touches.length:0)+
        (t?(' y='+Math.round(t.clientY)):'')+
        ' cancelable='+e.cancelable+' tgt='+cn(e.target)+
        ' tsActive='+(p?!!p._tsActive:'?');
      setTimeout(()=>put(info+' dp='+e.defaultPrevented+' | '+scrollState()),0);
    },{capture:true,passive:true});
  }

  // ── 키·입력 ──
  for(const type of ['keydown','keypress','beforeinput','input','compositionstart','compositionupdate','compositionend']){
    window.addEventListener(type,(e)=>{
      let s=type;
      if(e instanceof KeyboardEvent) s+=' key='+JSON.stringify(e.key)+' code='+e.keyCode;
      if(typeof e.data!=='undefined') s+=' data='+JSON.stringify(e.data);
      if(e.inputType) s+=' it='+e.inputType;
      if(typeof e.isComposing!=='undefined') s+=' comp='+e.isComposing;
      s+=' tgt='+cn(e.target);
      // UX_BATCH9_SRS FR-IMK-4: 조합 게이트가 이 키를 어떻게 다뤘는가.
      //
      // 게이트의 판정은 내부 상태라 이벤트만 보아서는 읽히지 않는다. 보류 큐의
      // 길이와 정리 창의 상태를 이벤트 **직후**에 함께 찍으면 그 순서가 드러난다 —
      // Enter 와 모바일 되풀이(SRS §2.8)를 실측으로 특정하기 위한 자리다.
      const ip=pane();
      const imeInfo=ip?(' ime='+(ip._imeOpen?'open':(ip._imeSettling?'settling':'-'))
        +' q='+((ip._imeQ||[]).length)):'';
      setTimeout(()=>put(s+' dp='+e.defaultPrevented+imeInfo),0);
    },{capture:true,passive:true});
  }

  // ── 포커스 ──
  for(const type of ['focusin','focusout']){
    window.addEventListener(type,(e)=>put(type+' tgt='+cn(e.target)),{capture:true,passive:true});
  }

  // ── 뷰포트 ──
  window.addEventListener('resize',()=>put('window.resize innerH='+window.innerHeight+' | '+scrollState()));
  if(window.visualViewport){
    const vv=window.visualViewport;
    vv.addEventListener('resize',()=>put('vv.resize h='+Math.round(vv.height)+' offTop='+Math.round(vv.offsetTop)+
      ' kbH='+Math.round(Math.max(0,window.innerHeight-vv.height-vv.offsetTop))));
    vv.addEventListener('scroll',()=>put('vv.scroll offTop='+Math.round(vv.offsetTop)));
  }

  // ── 전송 바이트 ──
  const hookSend=()=>{
    const p=pane();
    if(!p||p.__diagSpied) return;
    const orig=p._send.bind(p);
    p._send=(m)=>{
      try{
        if(m[0]===0) put('SEND '+JSON.stringify(new TextDecoder().decode(m.subarray(1))));
        else if(m[0]===1) put('RESIZE '+((m[1]<<8)|m[2])+'x'+((m[3]<<8)|m[4]));
      }catch{}
      return orig(m);
    };
    p.__diagSpied=true;
  };
  setInterval(hookSend,1000);

  // ── 스크롤 결과 ──
  const watchScroll=()=>{
    const p=pane();
    if(!p||!p.term||p.__diagScroll) return;
    try{p.term.onScroll(()=>put('term.onScroll '+scrollState()))}catch{}
    p.__diagScroll=true;
  };
  setInterval(watchScroll,1000);

  /**
   * OBSERVABILITY_SRS FR-OBS-18: 잡히지 않은 오류를 여기서 본다.
   *
   * 기록은 `error-log.js` 가 **언제나** 쥐고 있다 — 진단을 켜야만 걸리는 훅은
   * 재현되는 문제만 잡기 때문이다. 이 버튼은 그 쥔 것을 화면으로 옮길 뿐이다.
   */
  function errs(){
    const L=window.__dongminalErrors;
    if(!L){put('ERR (기록 계층 없음)');return}
    const items=L.items();
    put('ERR total='+L.total()+' kept='+items.length);
    if(!items.length){put('ERR (없음)');return}
    for(const it of items){
      put('ERR '+it.t+' '+it.kind+' '+it.message
        +(it.src?(' @'+it.src+':'+it.line+':'+it.col):''));
      if(it.stack) for(const ln of it.stack.split('\n').slice(0,4)) put('ERR   '+ln.trim());
    }
  }

  el.querySelector('.dg-bar').addEventListener('click',(e)=>{
    const a=e.target&&e.target.dataset&&e.target.dataset.a;
    if(!a) return;
    e.preventDefault();e.stopPropagation();
    if(a==='clear'){lines.length=0;logEl.textContent='';return}
    if(a==='min'){el.classList.toggle('min');return}
    if(a==='env'){env();return}
    if(a==='hub'){hub();return}
    if(a==='err'){errs();return}
    if(a==='pause'){paused=!paused;e.target.textContent=paused?'재개':'멈춤';return}
    if(a==='send'){
      const body=lines.join('\n')+'\n';
      const name='dongminal-diag-'+Date.now()+'.txt';
      const fd=new FormData();
      fd.append('file',new Blob([body],{type:'text/plain'}),name);
      e.target.textContent='...';
      apiPost('/api/upload',fd,{query:{dir:'/tmp'}})
        .then(r=>{
          if(!r.ok){e.target.textContent='실패';put('UPLOAD FAIL '+r.status);return}
          e.target.textContent='보냄';put('UPLOADED '+(r.data&&r.data.name));
        });
    }
  });
  // 오버레이 자체의 터치가 터미널 핸들러로 새지 않게 한다.
  el.addEventListener('touchstart',e=>e.stopPropagation(),true);
  el.addEventListener('touchmove',e=>e.stopPropagation(),true);

  /**
   * 시간과 전파의 지금 상태 (EVENT_TIMER_HUB_SRS FR-SCH-11 · FR-BUS-9).
   *
   * **"이벤트가 안 온다" 를 재현 대신 스냅샷으로 푼다.** 종전 진단은
   * `console.error('[cmd] parse')` 한 줄이 전부였고, 무엇이 언제 왔는지 볼
   * 자리가 없었다.
   *
   * 이 파일은 두 클래스 위에 서지 않는다 (D-3) — 그러나 들여다볼 수는 있어야
   * 한다. 없으면 조용히 지난다: 앱이 서기 전이나 부서진 뒤에도 진단은 살아야
   * 한다는 것이 이 계층의 규칙이다.
   */
  const hub=()=>{
    const app=window.app;
    if(!app){put('HUB app 이 아직 없다');return}
    if(app.timers){
      const ps=app.timers.pending();
      put('HUB timers pending='+ps.length);
      // 주기적인 것부터 — 마감이 가까운 순으로 본다.
      ps.slice().sort((a,b)=>(a.inMs==null?1e15:a.inMs)-(b.inMs==null?1e15:b.inMs))
        .slice(0,24)
        .forEach(x=>put('  ['+x.kind+'] '+(x.id||x.label||'?')
          +' owner='+(typeof x.owner==='string'?x.owner:(x.owner?'obj':'-'))
          +(x.inMs!=null?' in='+x.inMs+'ms':'')
          +(x.every?' every='+x.every:'')
          +(x.runs!=null?' runs='+x.runs:'')
          +(x.fails?' fails='+x.fails:'')
          +(x.inflight?' INFLIGHT':'')));
      if(ps.length>24) put('  … +'+(ps.length-24));
    }else put('HUB timers 없음');
    if(app.bus){
      const s=app.bus.stats();
      put('HUB channels '+JSON.stringify(s.channel)+' extra='+((s.channels||[]).length-1));
      for(const c of (s.channels||[])) put('  ch '+c.id+' alive='+c.alive);
      // 온 적 없는 topic 이 곧 "안 오는 이벤트" 다 — 그것부터 보이게 둔다.
      s.topics.slice().sort((a,b)=>a.count-b.count).forEach(x=>
        put('  · '+x.topic+' subs='+x.subs+' n='+x.count
          +(x.agoMs!=null?' ago='+x.agoMs+'ms':' (온 적 없음)')));
    }else put('HUB bus 없음');
  };

  setTimeout(env,800);
})();
