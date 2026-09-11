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

  /**
   * REPO_TAB_UNIFY_SRS FR-RTU-83 (2026-09-08 접수): **연 것은 보여야 한다.**
   *
   *   이전 동작: 사이드를 떠나는 판정이 `_setFocus` 의 `moved`(포커스 pane 이
   *              실제로 **바뀌었는가**)에만 있었다. 본문에 pane 이 이미 있고
   *              그것이 이미 포커스면 옮겨 갈 것이 없으므로 사이드에 남았다 —
   *              탭은 생기는데 화면은 그대로였다
   *   새  동작: 여는 부름이 **자기가 연 칸을 가리킨다.** 포커스가 움직였는지와
   *              무관하다
   *   이유:     실측(Pixel 7): pane 이 없던 첫 파일만 열리고, 그 뒤의 파일·
   *              diff·이미지·미리보기는 전부 먹통이었다. 넷이 이 한 자리였다
   *
   * 데스크톱에서는 곧바로 물러선다 — 모바일 순회에만 있는 자리다.
   * 바뀐 것이 있을 때만 `true` 이고, `opts.render` 면 그때만 다시 그린다.
   */
  _mobileShowPane(rid,opts){
    if(!rid||!this.isMobile) return false;
    const s=this._aw(); if(!s||!s.layout) return false;
    const i=this._flattenPanes(s.layout).findIndex(p=>p&&p.id===rid);
    if(i<0) return false;
    const idx=i+this._mobileSideSlots();
    if(this._mPaneIdx===idx) return false;
    this._mPaneIdx=idx;
    if(opts&&opts.render) this.render();
    return true;
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
    if(drwr) drwr.addEventListener('click',()=>{this._toggleDrawer();this.renderer._rTopbar()});
    if(bd) bd.addEventListener('click',()=>{this._toggleDrawer(false);this.renderer._rTopbar()});
    // Drawer close button injected into sidebar (visible only on mobile)
    const sb=document.getElementById('sidebar');
    if(sb && !sb.querySelector('.drawer-close')){
      const xb=document.createElement('button');
      xb.className='ui-btn ui-btn-icon ui-btn-ghost drawer-close';
      xb.appendChild(UIKit.icon('x'));
      xb.title='Close the sidebar';xb.setAttribute('aria-label','Close the sidebar');
      xb.addEventListener('click',()=>{this._toggleDrawer(false);this.renderer._rTopbar()});
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
      // FR-MKB-8: `⌨` 는 **맨 왼쪽**이다. 종전에는 열일곱 개 중 열일곱 번째였고,
      // 키보드를 내리려면 키바를 끝까지 가로로 밀어야 했다. 이제 이 버튼은
      // 키보드를 **올리는** 유일한 길이기도 하므로(FR-MKB-4) 손이 먼저 닿는
      // 자리에 있어야 한다.
      {label:'⌨',act:'kb'},
      {label:'Esc',send:''},
      {label:'Tab',send:'\t'},
      // FR-MKB-15: 소프트 키보드를 내려 둔 채 쓰는 길이 `⌨` 로 생겼으므로
      // (FR-MKB-4), 그 상태에서 줄을 넘길 자리가 있어야 한다. `Tab` 옆인 것은
      // 둘 다 **입력을 확정하는 키**이기 때문이고, `Ctrl`–`^C` 쌍(D-4)은
      // 건드리지 않는다.
      {label:'⏎',send:'\r'},
      {label:'Ctrl',mod:'ctrl'},
      // FR-MKB-9·10 / D-4·D-12: `Ctrl` 바로 옆이다. 소프트 키보드를 올리지
      // 않기로 하면(③) `Ctrl` 을 켠 뒤 `c` 를 칠 자리가 사라지므로, 접수한 말이
      // 그 둘을 한 문장에 담고 있었다. **모디파이어를 거치지 않고** 곧바로
      // `0x03` 을 보낸다 — 중단은 급할 때 누르는 것이고, 두 번 눌러야 하는
      // 중단은 중단이 아니다. `Ctrl` 의 sticky 를 읽지도 바꾸지도 않는다.
      {label:'^C',raw:''},
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
    ];
    const FULL_NAMES={
      'Esc':'Escape','Tab':'Tab','⏎':'Enter','Ctrl':'Control (modifier)','Alt':'Alt (modifier)',
      '↑':'Arrow Up','↓':'Arrow Down','←':'Arrow Left','→':'Arrow Right',
      '|':'Pipe','~':'Tilde','/':'Slash','-':'Hyphen',
      'Home':'Home','End':'End','PgUp':'Page Up','PgDn':'Page Down',
      // UX_BATCH5_SRS FR-TIP-2: 이 표는 전부 영어다 — long-press 툴팁도 같은
      // 값을 쓰므로 접수한 말("영어로 무슨 버튼인지")이 그대로 성립한다.
      // FR-MKB-5: 버튼 하나가 두 방향을 가지므로 이름도 방향을 말하지 않는다.
      '⌨':'Toggle keyboard',
      // FR-MKB-11: 무엇을 보내는지 이름이 말한다.
      '^C':'Interrupt (Ctrl+C)',
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
        if(pressTimer){TIMERS.cancel(pressTimer);pressTimer=null}
      };
      const activate=()=>{
        /**
         * FR-MKB-4·5·6: **버튼 하나가 두 방향을 갖는다.**
         *
         *   막혀 있으면 푼다 → 소프트 키보드가 올라온다
         *   그렇지 않으면 막고 내린다
         *
         * 판정도 조작도 `TerminalTool` 이 갖는다 (D-10) — 여기서 속성을 직접
         * 쓰면 두 곳이 `inputmode` 의 진실을 다툰다.
         */
        if(k.act==='kb'){
          const p=this._focusedTerminal();
          // 터미널이 아닌 것(편집기·git 입력)에 포커스가 있을 수 있다. 그쪽은
          // 이 규칙의 대상이 아니므로(FR-MKB-14) 종전대로 내리기만 한다.
          if(!p||!p._kbSuppressed){
            const ae=document.activeElement;if(ae&&ae.blur)try{ae.blur()}catch{}
            this._mkbRefresh();
            return;
          }
          if(p._kbSuppressed()) p._kbAllow(); else p._kbSuppress();
          this._mkbRefresh();
          return;
        }
        // FR-MKB-10 / D-12: sticky 를 거치지 않는 날것의 바이트.
        if(k.raw!==undefined){
          const p=this._focusedTerminal();
          if(!p) return;
          if(p.term){try{p.term.focus()}catch{}}
          p._sendText(k.raw);
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
        pressTimer=TIMERS.after(MKB_LONG_PRESS_MS,()=>{longPressFired=true;showTip(full,b)},{owner:'mkb',label:'long-press'});
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
    TIMERS.frame(()=>{
      for(const p of this.tools.values()){if(p.el.classList.contains('vis'))p.doFit()}
    },{owner:'app', coalesce:'fit'});
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
    /**
     * FR-MKB-7 / D-11: **키보드가 내려가면 `inputmode` 를 되돌린다.**
     *
     * `⌨` 로 한 번 풀면 그 뒤로는 터치마다 키보드가 올라오는데, 그것이 정확히
     * ③ 이 없애려던 동작이다. 되돌리는 계기를 따로 만들지 않고 이미 오르내림을
     * 아는 이 자리에서 한다.
     *
     * **전이에서만 한다** (`true → false`). 매번 하면 `⌨` 로 방금 푼 것을 —
     * 키보드가 아직 올라오는 중이라 `isUp` 이 거짓인 그 순간에 — 다시 잠근다.
     * 위 게이트를 지난 시점의 `keyboard-up` 이 전이 전 값이다.
     */
    const wasUp=document.body.classList.contains('keyboard-up');
    document.body.classList.toggle('keyboard-up', isUp);
    if(wasUp&&!isUp) this._kbSuppressAll();
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

  /**
   * FR-MKB-7: 열려 있는 터미널 전부의 `inputmode` 를 되돌린다.
   *
   * 포커스된 하나만 되돌리면 다른 칸의 터미널이 풀린 채 남고, 그 칸을 터치하는
   * 순간 키보드가 올라온다 — 속성은 요소마다이므로 대상도 요소 전부다.
   */
  _kbSuppressAll(){
    for(const p of this.tools.values()) if(p._kbApply) p._kbApply();
    this._mkbRefresh();
  },

  _mkbRefresh(){
    document.querySelectorAll('#mobile-keybar .mkb-btn[data-mod]').forEach(b=>{
      const m=b.dataset.mod, st=this._modKbd&&this._modKbd[m];
      b.classList.toggle('sticky', st===true);
      b.classList.toggle('locked', st==='lock');
    });
    /**
     * FR-MKB-6: `⌨` 의 현재 방향을 모디파이어와 **같은 방식**으로 보인다.
     *
     * 켜짐 = 소프트 키보드가 올라올 수 있다(= 막혀 있지 않다). 두 방향을 가진
     * 버튼은 지금 어느 쪽인지 보이지 않으면 누를 때마다 도박이 된다.
     */
    const kb=document.querySelector('#mobile-keybar .mkb-btn[data-act="kb"]');
    if(kb){
      const p=this._focusedTerminal&&this._focusedTerminal();
      kb.classList.toggle('sticky', !!(p&&p._kbSuppressed&&!p._kbSuppressed()));
    }
  },
});
