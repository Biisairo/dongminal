/**
 * Remote Terminal — App 모바일 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 7개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  _applyMobileMode(){
    const mob=this.isMobile;
    document.body.classList.toggle('mobile', mob);
    if(!mob && this._drawerOpen){this._drawerOpen=false;document.body.classList.remove('drawer-open')}
    if(!mob){document.body.classList.remove('keyboard-up')}
  },
  _toggleDrawer(open){
    if(!this.isMobile){this._drawerOpen=false;document.body.classList.remove('drawer-open');return}
    this._drawerOpen = (open===undefined) ? !this._drawerOpen : !!open;
    document.body.classList.toggle('drawer-open', this._drawerOpen);
  },
  /**
   * REPO_TAB_UNIFY_SRS FR-RTU-80: **모바일 순회의 첫 자리는 사이드다.**
   *
   * Repo 창은 사이드와 본문으로 나뉘는데(FR-RTU-11) 모바일에는 둘을 나란히 둘
   * 폭이 없다. 그래서 기존 pane 순회(`‹ 1/3 ›`)에 자리 하나를 더한다 — 사용자가
   * 새 조작을 배우지 않는다 (D-RTU-11).
   *
   * 사이드 자리를 갖는 조건은 **모바일 + Repo 창**이다. 일반 창에는 사이드가
   * 없으므로 종전과 한 글자도 다르지 않다.
   */
  _mobileSideSlots(){
    return (this.isMobile&&this._isEditorWin(this._aw()))?1:0;
  },

  // 지금 사이드 자리에 서 있는가. 그 자리에서는 본문의 pane 을 그리지 않는다.
  _mobileOnSide(){
    return this._mobileSideSlots()>0&&this._mPaneIdx===0;
  },

  _mobileCurrentPane(){
    const s=this._aw(); if(!s||!s.layout) return null;
    const regs=this._flattenPanes(s.layout);
    if(!regs.length) return null;
    const off=this._mobileSideSlots();
    const n=regs.length+off;
    if(this._mPaneIdx>=n) this._mPaneIdx=n-1;
    if(this._mPaneIdx<0) this._mPaneIdx=0;
    // 사이드 자리에는 pane 이 없다 — 부르는 쪽이 그 없음을 견딘다 (`_initMobile`
    // 의 `+` 버튼이 그렇다).
    const i=this._mPaneIdx-off;
    return i>=0?regs[i]:null;
  },

  // FR-RTU-82: 계수는 **사이드를 포함한다** — pane 이 둘이면 `1/3` 이다.
  _mobilePaneCount(){
    const s=this._aw(); if(!s) return 0;
    const off=this._mobileSideSlots();
    if(!s.layout) return off;
    return this._flattenPanes(s.layout).length+off;
  },
  navMobilePane(delta){
    const n=this._mobilePaneCount(); if(n<=1) return;
    this._mPaneIdx = (this._mPaneIdx + delta + n) % n;
    const pn=this._mobileCurrentPane();
    // 사이드 자리에서는 포커스를 옮기지 않는다 — 사이드는 분할 트리 밖이라
    // 포커스의 대상이 아니고(FR-RTU-11), 옮기면 렌더의 포커스 동기화가 곧바로
    // 본문 자리로 되돌린다.
    if(pn){
      this._setFocus(pn.id);
      this._save();
    }
    this.render();
  },

  // ── Mobile bindings ──

  _initMobile(){
    // Topbar mobile buttons
    const prev=document.getElementById('m-pane-prev');
    const next=document.getElementById('m-pane-next');
    const addT=document.getElementById('m-add-tab');
    const srch=document.getElementById('m-search-btn');
    const drwr=document.getElementById('m-drawer-toggle');
    const bd=document.getElementById('drawer-backdrop');
    if(prev) prev.addEventListener('click',()=>this.navMobilePane(-1));
    if(next) next.addEventListener('click',()=>this.navMobilePane(1));
    if(addT) addT.addEventListener('click',()=>{
      const pn=this._mobileCurrentPane(); if(pn) this.addTab(pn.id);
    });
    if(srch) srch.addEventListener('click',()=>this.toggleSearch&&this.toggleSearch());
    if(drwr) drwr.addEventListener('click',()=>{this._toggleDrawer();this._rTopbar()});
    if(bd) bd.addEventListener('click',()=>{this._toggleDrawer(false);this._rTopbar()});
    // Drawer close button injected into sidebar (visible only on mobile)
    const sb=document.getElementById('sidebar');
    if(sb && !sb.querySelector('.drawer-close')){
      const xb=document.createElement('button');
      xb.className='drawer-close';xb.textContent='✕';xb.title='닫기';
      xb.addEventListener('click',()=>{this._toggleDrawer(false);this._rTopbar()});
      sb.insertBefore(xb, sb.firstChild);
    }
    // Auto-close drawer on window switch (mobile)
    // (handled in switchWindow via _drawerOpen check)

    // Display Settings panel sync
    const dsMode=document.getElementById('ds-mode');
    const dsBp=document.getElementById('ds-bp');
    if(dsMode){
      dsMode.value=this.displayMode;
      dsMode.addEventListener('change',()=>{
        this.displayMode=dsMode.value;
        this.render();
      });
    }
    if(dsBp){
      dsBp.value=this.mobileBreakpoint;
      dsBp.addEventListener('change',()=>{
        let v=parseInt(dsBp.value,10);
        if(!(v>=320&&v<=2000)){v=768;dsBp.value=v}
        this.mobileBreakpoint=v;
        this.render();
      });
    }
  },

  _initMobileKeybar(){
    const bar=document.getElementById('mobile-keybar');
    if(!bar) return;
    bar.innerHTML='';
    const keys=[
      {label:'Esc',send:''},
      {label:'Tab',send:'\t'},
      {label:'Ctrl',mod:'ctrl'},
      {label:'Alt',mod:'alt'},
      {label:'↑',send:'[A'},
      {label:'↓',send:'[B'},
      {label:'←',send:'[D'},
      {label:'→',send:'[C'},
      {label:'|',send:'|'},
      {label:'~',send:'~'},
      {label:'/',send:'/'},
      {label:'-',send:'-'},
      {label:'Home',send:'[H'},
      {label:'End',send:'[F'},
      {label:'PgUp',send:'[5~'},
      {label:'PgDn',send:'[6~'},
      // FR-MTI-26: 키보드를 내리는 명시적 탈출구. Android Chrome 은 focus 된
      // 입력 요소가 있으면 탭마다 키보드를 재표시하므로, 포커스를 놓는 길이
      // 사용자에게 있어야 한다. 키를 보내지 않으므로 send 도 mod 도 없다.
      {label:'⌨',act:'hidekb'},
    ];
    const FULL_NAMES={
      'Esc':'Escape','Tab':'Tab','Ctrl':'Control (modifier)','Alt':'Alt (modifier)',
      '↑':'Arrow Up','↓':'Arrow Down','←':'Arrow Left','→':'Arrow Right',
      '|':'Pipe','~':'Tilde','/':'Slash','-':'Hyphen',
      'Home':'Home','End':'End','PgUp':'Page Up','PgDn':'Page Down',
      '⌨':'키보드 내리기',
    };
    this._modKbd={ctrl:false,alt:false};
    const refresh=()=>this._mkbRefresh();
    // FR-MTI-15~17: sticky 규칙은 TerminalTool 한 곳에만 둔다 — 키바 경로와
    // 키보드 경로가 서로 다른 규칙을 쓰면 어느 쪽도 신뢰할 수 없다.
    const sendToFocused=(s)=>{
      const p=this._focusedTerminal();
      if(!p) return;
      if(p.term){try{p.term.focus()}catch{}}
      p._sendText(p._applyStickyMods(s));
    };
    const showTip=(text, btn)=>{
      let tip=document.getElementById('mkb-tip');
      if(!tip){tip=document.createElement('div');tip.id='mkb-tip';document.body.appendChild(tip)}
      tip.textContent=text;
      const r=btn.getBoundingClientRect();
      tip.style.left=(r.left+r.width/2)+'px';
      tip.style.top=(r.top-8)+'px';
    };
    const hideTip=()=>{const t=document.getElementById('mkb-tip');if(t)t.remove()};
    for(const k of keys){
      const b=document.createElement('button');
      b.className='mkb-btn';b.textContent=k.label;b.type='button';
      // FR-MTI-14: 버튼이 포커스를 가져가면 소프트 키보드가 내려가고, 이어지는
      // term.focus() 가 다시 올려 visualViewport 이벤트가 폭주한다. 스와이프로
      // 판정된 터치(preventDefault 를 하지 않는 경로)에서도 그 일이 없어야 한다.
      b.tabIndex=-1;
      const full=FULL_NAMES[k.label]||k.label;
      b.title=full;b.setAttribute('aria-label',full);
      if(k.mod){b.dataset.mod=k.mod}
      if(k.act){b.dataset.act=k.act}
      // 마우스 경로에서만 포커스 탈취를 막는다. touchstart 에서 preventDefault
      // 하면 브라우저가 합성 click 과 스크롤을 함께 취소해, 실기기에서 버튼이
      // 아무 반응도 하지 않고 키바 슬라이드도 막힌다 (FR-MTB-1/3).
      b.addEventListener('mousedown',e=>e.preventDefault());

      let lastTap=0;          // 모디파이어 더블탭(lock) 판정
      let pressTimer=null;
      let longPressFired=false;
      let startPt=null;       // 터치 시작 좌표 — 이동 거리 판정의 기준
      let moved=false;        // TAP_SLOP 초과 = 스크롤 제스처
      let lastTouchEndAt=0;   // 합성 click(ghost click) 억제용

      const cancelPress=()=>{
        if(pressTimer){clearTimeout(pressTimer);pressTimer=null}
      };
      const activate=()=>{
        if(k.act==='hidekb'){
          const p=this._focusedTerminal();
          if(p&&p._blurInput) p._blurInput();
          else{const ae=document.activeElement;if(ae&&ae.blur)try{ae.blur()}catch{}}
          return;
        }
        if(k.mod){
          const now=Date.now();
          const dbl=(now-lastTap)<MKB_DOUBLE_TAP_MS;
          lastTap=now;
          const cur=this._modKbd[k.mod];
          if(dbl){this._modKbd[k.mod]=(cur==='lock')?false:'lock'}
          else{this._modKbd[k.mod]=cur?false:true}
          refresh();
        }else{
          sendToFocused(k.send);
        }
      };

      b.addEventListener('touchstart',e=>{
        const t=e.touches[0];
        startPt=t?{x:t.clientX,y:t.clientY}:null;
        moved=false;longPressFired=false;
        cancelPress();
        pressTimer=setTimeout(()=>{longPressFired=true;showTip(full,b)},MKB_LONG_PRESS_MS);
      },{passive:true});

      // FR-MTB-5: 이동 거리 임계값으로 판정한다. touchmove 발생만으로 취소하면
      // 손떨림에도 롱프레스가 죽고, 스크롤과 공존할 수 없다.
      b.addEventListener('touchmove',e=>{
        if(!startPt||moved) return;
        const t=e.touches[0];
        if(!t) return;
        if(Math.abs(t.clientX-startPt.x)>MKB_TAP_SLOP_PX||Math.abs(t.clientY-startPt.y)>MKB_TAP_SLOP_PX){
          moved=true;cancelPress();hideTip();longPressFired=false;
        }
      },{passive:true});

      b.addEventListener('touchcancel',()=>{
        cancelPress();hideTip();
        startPt=null;moved=false;longPressFired=false;
        lastTouchEndAt=Date.now();
      });

      b.addEventListener('touchend',e=>{
        cancelPress();
        const wasLong=longPressFired, wasMoved=moved;
        startPt=null;moved=false;longPressFired=false;
        lastTouchEndAt=Date.now();
        if(wasLong){hideTip();e.preventDefault();return}
        if(wasMoved) return;              // 스크롤 제스처 — 키를 보내지 않는다
        e.preventDefault();               // 합성 click 억제. 여기서 직접 처리한다
        activate();
      });

      b.addEventListener('click',e=>{
        e.preventDefault();
        // FR-MTB-2: 터치 제스처가 합성한 click 은 무시한다 — touchend 가 이미
        // 처리했다. 시간 기준을 쓰는 이유는, 플래그를 쓰면 preventDefault 로
        // click 이 오지 않은 경우 플래그가 남아 다음 마우스 클릭을 먹는다.
        if(Date.now()-lastTouchEndAt<MKB_GHOST_CLICK_MS) return;
        activate();
      });
      bar.appendChild(b);
    }
    // visualViewport tracking — keyboard up/down detection
    if(window.visualViewport){
      const vv=window.visualViewport;
      const apply=()=>this._mobileVvApply();
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      apply();
    }
  },

  // FR-MTI-12/20: 뷰포트 변화마다 fit 하면 PTY SIGWINCH 가 이벤트 수만큼 나가고
  // TUI 는 매번 프레임 전체를 다시 그린다 — 입력이 씹히는 원인이다. 프레임당
  // 1회로 묶는다.
  //
  // 두 계기가 이 함수를 공유한다. WebKit 은 키보드를 visualViewport 로만 알리고
  // (FR-MKV-3), Android Chrome 은 interactive-widget=resizes-content 를 지원해
  // layout viewport 가 함께 줄어 window resize 로 알린다. 후자에서는 kbH 가 0 에
  // 수렴해 vv 경로가 스스로 비활성되므로, window resize 쪽도 반드시 묶여야 한다.
  _scheduleFit(){
    if(this._mFitRaf) return;
    this._mFitRaf=requestAnimationFrame(()=>{
      this._mFitRaf=null;
      for(const p of this.tools.values()){if(p.el.classList.contains('vis'))p.doFit()}
    });
  },

  // 이전 이름. 모바일 전용이 아니게 되었으므로 _scheduleFit 을 쓴다.
  _scheduleMobileFit(){ this._scheduleFit() },

  _mobileVvApply(){
    const vv=window.visualViewport;
    if(!vv) return;
    const bar=document.getElementById('mobile-keybar');
    const kbH_PX=()=>{
      const v=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--m-kb-h'));
      return isFinite(v)?v:38;
    };
    if(!this.isMobile){
      document.body.classList.remove('keyboard-up');
      document.body.style.paddingTop='';
      document.body.style.paddingBottom='';
      if(bar) bar.style.bottom='';
      this._mKbH=null;this._mKbOff=null;
      this._scheduleFit();
      return;
    }
    // FR-MKV-3: layout viewport 가 키보드만큼 함께 줄어드는 환경
    // (interactive-widget=resizes-content 를 지원하는 Chromium·Firefox)에서는
    // innerHeight 도 줄어 kbH 가 0 에 수렴하므로 이 보정이 스스로 비활성된다.
    // 엔진 판별을 하지 않는 이유다. WebKit 은 그 키를 무시하므로 여기가 유일한 수단이다.
    const kbH=Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    const off=vv.offsetTop;
    const isUp=kbH > MOBILE_KB_UP_PX;
    // FR-MTI-13: 잡음 수준의 변화로는 레이아웃도 fit 도 건드리지 않는다.
    if(document.body.classList.contains('keyboard-up')===isUp
       && typeof this._mKbH==='number' && Math.abs(kbH-this._mKbH)<MTI_KB_EPS_PX
       && typeof this._mKbOff==='number' && Math.abs(off-this._mKbOff)<MTI_KB_EPS_PX) return;
    this._mKbH=kbH;this._mKbOff=off;
    document.body.classList.toggle('keyboard-up', isUp);
    if(isUp){
      if(bar) bar.style.bottom = kbH + 'px';
      // FR-MKV-4: WebKit 은 포커스된 요소를 드러내려 visual viewport 를 위로
      // 스크롤한다. 그 스크롤은 overflow:hidden 으로 막을 수 없고 레이아웃은
      // layout viewport 좌표계에 그대로 남으므로, 상쇄하지 않으면 화면 상단
      // (topbar)이 가시 영역 밖으로 밀린다.
      //
      // padding-top 으로 상쇄하면 body 의 content box 가
      // [offsetTop, innerHeight-kbH-키바높이] 로 내려앉아 가시 영역 안에 정확히
      // 들어간다. kbH 는 이미 offsetTop 을 뺀 값이므로 padding-bottom 계산은
      // 바뀌지 않고, 키바(position:fixed, bottom:kbH)와도 틈 없이 맞물린다.
      //
      // transform 이 아니라 padding 인 이유: transform 은 fixed 자손의 컨테이닝
      // 블록을 만들어 키바의 bottom 기준을 layout viewport 에서 #app 으로 바꾼다.
      document.body.style.paddingTop = off + 'px';
      document.body.style.paddingBottom = (kbH + kbH_PX()) + 'px';
    }else{
      if(bar) bar.style.bottom = '';
      document.body.style.paddingTop = '';
      document.body.style.paddingBottom = '';
    }
    this._scheduleFit();
  },

  _mkbRefresh(){
    document.querySelectorAll('#mobile-keybar .mkb-btn[data-mod]').forEach(b=>{
      const m=b.dataset.mod, st=this._modKbd&&this._modKbd[m];
      b.classList.toggle('sticky', st===true);
      b.classList.toggle('locked', st==='lock');
    });
  },
});
