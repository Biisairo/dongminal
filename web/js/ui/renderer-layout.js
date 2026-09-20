/**
 * Dongminal — 렌더러의 칸과 창 (`Renderer.prototype` 증강)
 *
 * `renderer.js` 에서 **구간 이동**했다 (STRUCTURE_CLEANUP_SRS FR-STR-44).
 *
 * `_rLayout` 이 진행 순서이고 나머지가 그 단계다 — 칸 골격(WINDOW_SLOTS_SRS
 * FR-WSL-4·60) · 위젯 회수(FR-PDR-9) · 프레임 뒤처리(FR-PDR-10) · 포커스
 * 재지정(FR-EXR-58·59) · 창과 편집기 창.
 *
 * 로드 순서: `renderer.js` **뒤**.
 */

Object.assign(Renderer.prototype, {

  /**
   * 한 화면을 세우는 **진행 순서**다 (`AUDIT-fe-ui.md` M-4 · FR-STR-43).
   *
   * 종전에는 이 함수가 168줄이었고 여섯을 했다 — 스크롤 갈무리 · 칸 골격 ·
   * 위젯 회수 · 패널 detach · `_domGC` · 프레임 뒤처리. 그중 프레임 하나가
   * 77줄이고 그 안에 근거 주석이 40줄이라, *"이 프레임이 무엇을 하는가"* 를
   * 한눈에 읽을 수 없었다.
   *
   * **구간 이동만 했다** — 아래 넷의 본문은 한 줄도 바뀌지 않았고 들여쓰기만
   * 한 칸 줄었다 (`SPLIT_REFACTOR_SRS` 의 규약).
   */
  _rLayout(){
    const area=document.getElementById('area');
    // FR-SCR-1: **무엇보다 먼저** 잰다 — git 뷰의 스크롤이다. 터미널은 이제
    // 움직이지 않으므로 여기 없다 (PANE_DOM_RECONCILE_SRS FR-PDR-20).
    this._keepScrollAll();
    // FR-PDR-1·9: 이번 그리기의 장부를 연다. `_moved` 는 여기서 비우지 않는다 —
    // 프레임이 오기 전에 다시 그려지면 그 이동이 장부에서 사라진다.
    this._domUsed=new Set();
    this._mounted=new Set();
    this._rSlots(area);
    this._gcWidgets();
    this._afterLayout();
  },

  /**
   * 칸의 골격을 세우고 본문을 채운다 (FR-WSL-4·60).
   *
   * `_rSlot` 은 여기서 정해져 `_rWindowInto` 아래로 흐른다 — 그 상태가 이
   * 구간에 갇혀 있다는 것이 경계를 여기 그은 이유다.
   */
  _rSlots(area){
    const app=this.app;
    // WINDOW_SLOTS_SRS FR-WSL-4·60: 단일 슬롯 모드와 모바일에서는 슬롯 컨테이너를
    // 만들지 않는다. `.sp`·`.pn` 의 `inset:0` 이 딛는 조상이 바뀌면 기존 e2e 가
    // 전부 그 위에 서 있으므로(D-4), 슬롯이 1개일 때의 DOM 은 지금과 같아야 한다.
    const slots=(!app.isMobile&&app.slots)?app.slots:null;
    if(!slots){
      area.removeAttribute('data-slotdir');
      this._rSlot=0;
      this._rWindowInto(app.aw(),area);
    }else{
      area.dataset.slotdir=app.slotDir;
      const n=app.slotCount();
      // 골격을 먼저 세워 자리에 놓고, 본문은 그다음에 채운다 — 붙기 전에 채우면
      // 첫 그리기에서 문서 밖의 요소를 재는 코드가 생긴다.
      const kids=[],bodies=[];
      for(let i=0;i<n;i++){
        const el=this._keep('slot:'+i,()=>this._makeSlot(i));
        const win=app.slotWindow(i);
        el.classList.toggle('slot-focused',i===slots.focused);
        el.classList.toggle('slot-empty',!win);   // FR-WSL-6
        el.dataset.slot=String(i);
        // FR-WSL-35 / D-10: 칸이 둘을 넘으면 위치만으로는 어느 칸이 무슨 창인지
        // 읽히지 않는다. 이름을 적는다.
        const head=this._keep('slot:'+i+'/head',()=>{
          const h=document.createElement('div'); h.className='slot-head'; return h;
        });
        head.textContent=win?this._rWinTitle(win):t('core.no_window');
        // 분할 트리는 `inset:0` 으로 조상을 채우므로 머리글과 겹치지 않게 자기
        // 몫의 상자를 준다.
        const body=this._keep('slot:'+i+'/body',()=>{
          const b=document.createElement('div'); b.className='slot-body';
          // FR-B-6 (UX-11): 빈 칸의 안내는 CSS `content` 가 아니라 DOM 텍스트다 —
          // 접근성 트리에 잡히고 카탈로그를 지난다. 창이 있으면 CSS 가 숨긴다.
          const hint=document.createElement('div'); hint.className='ui-empty ui-empty-center slot-empty-hint'; hint.textContent=SLOT_EMPTY_HINT;
          b.appendChild(hint); return b;
        });
        this._place(el,[head,body]);
        kids.push(el);
        bodies.push([i,win,body]);
        if(i<n-1){
          kids.push(this._keep('slot:'+i+'/handle',()=>{
            const h=document.createElement('div');
            h.className='slot-handle';
            h.dataset.slotHandle=String(i);
            app.slotHandleBind(h,i);            // FR-WSL-32 — 배선은 만들 때 한 번
            return h;
          }));
        }
      }
      this._placeLayout(area,kids);
      for(const [i,win,body] of bodies){ this._rSlot=i; this._rWindowInto(win,body) }
      app.slotApplySizes();
      this._rSlot=0;
    }
  },

  /**
   * 이번 그리기에 어디에도 붙지 못한 것을 거둔다 (FR-PDR-9 · FR-SVS-42).
   *
   * **떼지 않는다** — 자리를 지키고 있어야 다시 보일 때 옮기지 않는다.
   */
  _gcWidgets(){
    const app=this.app;
    const allTabIds=new Set();
    const walk=n=>{if(!n)return;if(n.type==='pane'&&n.tabs)n.tabs.forEach(t=>allTabIds.add(t.id));if(n.type==='split'&&n.children)n.children.forEach(walk)};
    for(const sess of app.ws.windows){if(sess&&sess.layout)walk(sess.layout)}
    // 편집기 Map 의 키는 복합키다 (FR-WSL-75) — 회수는 탭 id 로 판정한다.
    // FR-SVS-60: 파싱은 `slotBase` 한 자리다. 여기서 `@1` 만 잘라 내던 동안
    // 칸 2·3 의 편집기는 살아 있는 탭인데도 매 render 마다 파괴됐다.
    for(const[k,v] of app.fileEditors){
      const tid=app.slotBase(k);
      if(!allTabIds.has(tid)){v.destroy();app.fileEditors.delete(k)}
    }
    // 옛 Git 창이 사라졌으면 그 창의 패널만 루트를 area 로 되돌린다. 인스턴스는
    // 유지 — 다시 열릴 수 있다. FR-SVS-42: 패널은 칸마다 있으므로 그 자리의
    // 것을 **전부** 되돌린다.
    //
    // **Repo 창의 패널(`root` 가 있는 것)은 건드리지 않는다** (FR-RTU-60).
    // 그쪽의 Changes 는 창의 사이드에 붙어 있고, 여기서 함께 떼면 방금 그린
    // 사이드가 비어 버린다 — 실측으로 확인한 결함이다.
    if(!app.gitWindow()&&app.gitPanels)
      for(const p of app.gitPanels.values()) if(!p.root) p.detach();
    // FR-PDR-9: 이번에 어디에도 붙지 못한 위젯만 물러난다. **떼지 않는다** —
    // 자리를 지키고 있어야 다시 보일 때 옮기지 않는다.
    for(const p of app.tools.values()) if(!this._mounted.has(p.el)) p.el.classList.remove('vis');
    for(const v of app.fileEditors.values()) if(!this._mounted.has(v.el)) v.el.classList.remove('vis');
    this._domGC();
  },

  /**
   * 프레임 뒤처리 — fit · 스크롤 복원 · 포커스 재지정 (FR-PDR-10).
   *
   * 붙은 **뒤**라야 잴 수 있는 것들이다. 순서가 계약이므로 한 자리에 모아 둔다.
   */
  _afterLayout(){
    const app=this.app;
    TIMERS.frame(()=>{
      for(const p of app.tools.values()){
        if(p.el.classList.contains('vis')){
          if(!p._opened)p.open();
          p.doFit();
        }
      }
      // FR-PDR-10: **옮겨진 것만** 되돌린다. 재사용된 pane 은 이 목록에 없고,
      // 그래서 어떤 스크롤 API 도 닿지 않는다 — 그것이 이 작업의 요점이다.
      const moved=this._moved; this._moved=[];
      for(const rec of moved) this._restoreScrollOf(rec);
      this._refocus();
      // After fit, panes have correct dimensions. Re-send sizes for the
      // active window if this window owns it and has OS focus.
      if(app.windowFocused){
        app.resendWindowSizes(app.ws.activeWindow);
      }
    },{owner:this,label:'render-frame'});
  },

  /**
   * 포커스 재지정. 본문은 옮기기 전과 같다 — 근거 주석이 로직보다 길지만
   * 그것이 이 자리의 값이다 (`FR-FMB-33`: 선행 주석은 다음 멤버의 것이다).
   */
  _refocus(){
    const app=this.app;
    // FR-MTI-25: 모바일에서는 render 가 터미널에 focus 하지 않는다. focus 된
    // 입력 요소가 있으면 Android Chrome 이 탭마다 키보드를 재표시하므로, 첫
    // 로드와 모든 재렌더가 키보드를 불러들이게 된다. 모바일에서 키보드를
    // 올리는 길은 사용자가 터미널을 탭하는 것 하나뿐이다 (_buildPane 의
    // mousedown). 편집기는 그 대상이 아니다 — 자기 UI 를 가진다.
    // `s?.layout` 을 여기서도 본다 — pane 이 없는 Editor 창(FR-EDT-55)이
    // 활성일 때 이 블록에 도달하기 때문이다.
    /**
     * FR-EXR-58: **탐색기가 쥔 포커스는 빼앗지 않는다.**
     *
     *   이전 동작: 매 렌더가 활성 탭으로 포커스를 되돌렸다 — 행을 한 번
     *             클릭하면 미리보기가 열리고 그 렌더가 편집기로 가져갔다
     *   새  동작: 탐색기 안에 포커스가 있으면 그대로 둔다
     *   이유:     그것이 `U-14`("탐색기가 편집기로부터 키보드 주도권을
     *             가져온다")의 본체다. `tabindex` 만으로는 한 프레임도
     *             유지되지 않는다. `FR-EFP-5` 가 이미 "포커스를 편집기로
     *             되돌리는 **모든 자리**" 를 가리키며 여기가 그 하나다
     *
     * FR-EXR-59: 명시적으로 여는 손짓(더블클릭·`Enter`·생성 직후)은 예외다 —
     * `focusHandoff` 가 그 한 번을 표명한다. 판정을 이 자리 하나에 두는
     * 이유는 여는 자리마다 `focus()` 를 부르면 그 자리가 여러 벌이 되기
     * 때문이다 (FR-EFP-5 가 겪은 형태).
     *
     * ACCESSIBILITY_BASELINE_SRS D-A11Y-12: 목록·탭 줄(`.kb-nav`)도 같은
     * 함정이다 — 화살표로 훑는 동안 SSE 한 번이 포커스를 터미널로 끌고 간다.
     * 다만 **키보드로 들어온 포커스**(`:focus-visible`)만 지킨다: 탭에
     * `tabindex` 가 생기면 클릭도 탭에 포커스를 두는데, 그것까지 지키면
     * 탭을 누른 뒤 터미널에 글자를 칠 수 없다. Enter 로 연 것은 `focusHandoff`
     * 가 넘긴다 (`UIKit.roving` 의 activate).
     */
    const ae=document.activeElement;
    const held=!app.focusHandoff&&ae&&ae.closest&&(ae.closest('.ed-explorer')
      ||(ae.closest('.kb-nav')&&ae.matches(':focus-visible')));
    const s=app.aw();
    if(app.focused && !app.isMobile && s?.layout && !held){
      const pn=findPane(s.layout,app.focused);
      if(pn){const tab=pn.tabs.find(t=>t.id===app.paneTab(pn));if(tab){
        // 포커스 슬롯의 인스턴스를 focus 한다 (FR-WSL-20).
        const key=app.slotKey(tab.id,app.slotFocused());
        if(tab.type==='editor'){const v=app.fileEditors.get(key)||app.fileEditors.get(tab.id);if(v)v.el.focus()}
        else{
          /**
           * M11_SRS FR-M11-47 (M11-B48): **에이전트 탭도 여기서 포커스를 받는다.**
           *
           *   이전 동작: `toolAny` 는 `app.tools`(터미널)만 본다 — 에이전트 탭에서는
           *              `p` 가 `null` 이라 **아무도 포커스를 받지 않았고**, 탭을 연
           *              뒤 한 번 더 눌러야 칠 수 있었다
           *   새  동작: 에이전트 패널도 같은 자리에서 찾아 `focus()` 한다
           *   이유:     터미널은 이미 그렇다. 같은 화면의 두 도구가 다른 손을 쓰면
           *             그 자체가 결함이다 (FR-M11-22 가 좌우 키에 세운 근거)
           *
           * **모바일 제외는 이 블록의 조건이 이미 지킨다** (`!app.isMobile`,
           * FR-MTI-25) — 판정을 새로 만들지 않는다.
           */
          const p=app.toolAny(tab.toolId);
          if(p&&p.focus)p.focus();
        }
        // 표명은 **실제로 넘긴 때**만 지운다 — 여는 한 손짓이 render 를 여러 번
        // 부르므로(addTab·switchWindow·mobileShowPane), 읽을 때 지우면 탭이
        // 아직 활성이 아닌 첫 렌더가 그것을 먹는다.
        app.focusHandoff=false;
      }}
    }
  },

  /**
   * FR-WSL-55 / FR-SVS-61 (FR-PDR-7): 칸 하나의 껍데기. **배선은 여기 한 번뿐이다** —
   * 칸의 자리(인덱스)가 곧 키이므로 `i` 는 이 요소에 대해 변하지 않는다.
   *
   * 포커스는 mousedown 에 옮기고 **그리기는 클릭이 끝난 뒤**로 미룬다. 여기서
   * 곧바로 그리면 이 클릭이 어떤 핸들러에도 닿지 못한다 (§2.11).
   */
  _makeSlot(i){
    const app=this.app;
    const el=document.createElement('div');
    el.className='slot';
    el.addEventListener('mousedown',()=>{if(app.slotFocused()!==i)app.slotFocusTo(i,{deferRender:true})});
    // 클릭이 자기 일로 render 를 돌면 `App.render` 가 플래그를 지우므로 이 자리는
    // 아무 일도 하지 않는다. 빈 자리를 눌렀을 때를 위한 자리다.
    el.addEventListener('click',()=>app.slotRenderFlush());
    return el;
  },

  /**
   * 슬롯 하나(또는 단일 슬롯 모드의 `#area`)에 창 하나를 그린다.
   *
   * `_rLayout` 에서 뽑아낸 것이며 동작은 그대로다 — 달라진 것은 **붙일 자리를
   * 인자로 받는다**는 것뿐이다 (FR-WSL-31). 그리는 동안 `this._rSlot` 이 지금
   * 어느 슬롯인지 말해 준다; 도구·편집기 인스턴스 조회가 그것을 딛는다.
   */
  _rWindowInto(s,host){
    const app=this.app;
    // FR-RTU-60: 지금 그리는 창. 탭 본문을 붙이는 자리(`_mountTabBody`)가 **그 탭이
    // 어느 창의 것인지** 알아야 패널을 고를 수 있다.
    this._rWin=s;
    // FR-EDT-46: Editor 창은 좌우 둘로 나뉜다 — 좌측 탐색기는 분할 트리 **밖**의
    // 고정 영역이므로 트리가 붙을 자리를 우측으로 바꾼다. 골격은 재사용한다.
    const ed=app.isEditorWin(s)?this._rEditorWin(s):null;
    if(ed) this._placeLayout(host,[ed.root]);
    const h=ed?ed.main:host;
    // FR-EDT-55: pane 이 하나도 없는 창이 있다. 그리기를 건너뛴다 — 죽은 편집기
    // 회수는 호출자(_rLayout)가 슬롯 바깥에서 한다.
    if(!s||!s.layout){
      // 옛 트리가 남아 있으면 거둔다. Editor 창은 `_rEditorWin` 이 안내문을 놓았다.
      if(!ed) this._placeLayout(host,[]);
      return;
    }
    // 포커스 보정은 **포커스 슬롯에서만** 한다. 비포커스 슬롯의 창을 그린다고
    // 해서 `app.focused`(포커스 슬롯의 pane)를 옮기면 안 된다.
    const isFocusedSlot=this._rSlot===app.slotFocused();
    if(isFocusedSlot&&!findPane(s.layout,app.focused)){
      app.setFocusState(firstPane(s.layout)?.id||null,s);
    }
    let dom;
    if(app.isMobile){
      const regs=app.flattenPanes(s.layout);
      /**
       * FR-RTU-80·82: 순회의 첫 자리가 **사이드**다 (Repo 창일 때).
       *
       * 포커스 동기화는 그 자리를 건너뛴다 — 사이드는 분할 트리 밖이라 포커스된
       * pane 이 될 수 없고, 무조건 포커스를 따라가면 사이드에 설 수 없다.
       */
      const off=app.mobileSideSlots();
      const n=regs.length+off;
      if(app.mPaneIdx>=n) app.mPaneIdx=n-1;
      if(app.mPaneIdx<0) app.mPaneIdx=0;
      if(regs.length&&!(off&&app.mPaneIdx===0)){
        const fIdx=regs.findIndex(r=>r.id===app.focused);
        if(fIdx>=0) app.mPaneIdx=fIdx+off;
        const target=regs[app.mPaneIdx-off];
        if(target){app.setFocusState(target.id,s);dom=this._buildPane(target,'m')}
      }
    }else{
      dom=this._buildNode(s.layout,'0');
    }
    if(h) this._placeLayout(h,dom?[dom]:[]);
  },

  /**
   * EDITOR_TAB_SRS FR-EDT-46·47·55: Editor 창의 골격.
   *
   * 좌측은 탐색기, 우측은 편집기 영역이다. 탐색기는 분할 트리 **밖**이므로
   * 어떤 드롭으로도 쪼개지지 않는다 — 트리는 우측(`.ed-area`) 안에만 산다.
   *
   * 탐색기의 내용은 M3 의 것이다. 여기서는 자리와 폭만 잡는다.
   * 분할 트리가 붙을 요소를 돌려준다.
   */
  _rEditorWin(s){
    const app=this.app, slot=this._rSlot||0;
    // FR-PDR-1: 골격은 창(과 칸)마다 하나다. 이것이 남아 있어야 `.ed-area` 안의
    // 분할 트리도, 그 안의 터미널도 제자리를 지킨다.
    const key='edwin:'+slot+':'+((s&&s.id)||'');
    const el=this._keep(key,()=>{
      const e=document.createElement('div'); e.className='ed-win'; return e;
    });
    /**
     * FR-RTU-80: **모바일은 사이드와 본문을 나란히 두지 않는다.**
     *
     * 폭이 없다 — 대신 순회의 자리 하나로 만들어 **한 번에 하나**를 전체 폭으로
     * 보인다 (D-RTU-11).
     */
    const mob=app.isMobile;
    const onSide=mob&&app.mobileOnSide();
    const kids=[];
    if(!mob||onSide){
      // REPO_TAB_UNIFY_SRS FR-RTU-12: 사이드는 `Explorer` 와 `Changes` 를 탭으로
      // 갈아 끼운다. 사이드 안쪽은 이 SRS 의 범위 밖이므로 종전대로 매번 세운다 —
      // 그 안의 스크롤은 `_keepScrollAll` 이 이미 지킨다 (FR-SCR-1).
      const side=this._rSide(s);
      // REPO_SIDE_WIDTH_SRS FR-RSW-2: 폭은 창의 것이 아니라 워크스페이스 하나다.
      if(!mob) side.style.width=app.edSideWidth()+'px';
      kids.push(side);
      if(!mob){
        const h=this._keep(key+'/exh',()=>{
          const x=document.createElement('div'); x.className='ed-ex-handle';
          this._rEdHandle(x);                    // FR-PDR-7: 배선은 한 번
          return x;
        });
        kids.push(h);
      }
    }
    if(onSide){
      // 본문은 그리지 않는다 — `_rWindowInto` 가 붙일 자리가 없다.
      this._place(el,kids);
      return {root:el,main:null};
    }
    const main=this._keep(key+'/main',()=>{
      const m=document.createElement('div'); m.className='ed-area'; return m;
    });
    kids.push(main);
    this._place(el,kids);
    // FR-EDT-55: pane 이 없는 것이지 빈 pane 이 있는 것이 아니다 — 안내문을 둔다.
    if(!s||!s.layout){
      const hint=this._keep(key+'/hint',()=>{
        const x=document.createElement('div'); x.className='ui-empty ui-empty-center ed-empty';
        x.textContent=EDITOR_EMPTY_HINT; return x;
      });
      this._place(main,[hint]);
    }
    return {root:el,main};
  },
});
