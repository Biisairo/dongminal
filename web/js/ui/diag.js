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
      '<button class="dg-b" data-a="send">전송</button>'+
      '<button class="dg-b" data-a="clear">지우기</button>'+
      '<button class="dg-b" data-a="pause">멈춤</button>'+
      '<button class="dg-b" data-a="env">환경</button>'+
      '<button class="dg-b" data-a="min">─</button>'+
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
      setTimeout(()=>put(s+' dp='+e.defaultPrevented),0);
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

  el.querySelector('.dg-bar').addEventListener('click',(e)=>{
    const a=e.target&&e.target.dataset&&e.target.dataset.a;
    if(!a) return;
    e.preventDefault();e.stopPropagation();
    if(a==='clear'){lines.length=0;logEl.textContent='';return}
    if(a==='min'){el.classList.toggle('min');return}
    if(a==='env'){env();return}
    if(a==='pause'){paused=!paused;e.target.textContent=paused?'재개':'멈춤';return}
    if(a==='send'){
      const body=lines.join('\n')+'\n';
      const name='dongminal-diag-'+Date.now()+'.txt';
      const fd=new FormData();
      fd.append('file',new Blob([body],{type:'text/plain'}),name);
      e.target.textContent='...';
      fetch('/api/upload?dir='+encodeURIComponent('/tmp'),{method:'POST',body:fd})
        .then(r=>r.json()).then(d=>{e.target.textContent='보냄';put('UPLOADED '+(d&&d.name))})
        .catch(err=>{e.target.textContent='실패';put('UPLOAD FAIL '+err)});
    }
  });
  // 오버레이 자체의 터치가 터미널 핸들러로 새지 않게 한다.
  el.addEventListener('touchstart',e=>e.stopPropagation(),true);
  el.addEventListener('touchmove',e=>e.stopPropagation(),true);

  setTimeout(env,800);
})();
