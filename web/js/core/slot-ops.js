/**
 * Remote Terminal — 창 슬롯의 조작 (WINDOW_SLOTS_SRS 묶음 S·I·N·U·D)
 *
 * 칸 더하기·빼기·포커스·배치·창 전환·회수·배선·손잡이. 상태·칸별 활성 탭·신원·영속은
 * `slots-controller.js` 에 있다. `SlotsController` 의 부품 `.ops` 다(REFACTOR3_FE_APPCTL_SRS 9h, 옛 `app-slots.js` 의 뒤쪽).
 */
class SlotOps extends Controller {
  // ── 더하기·빼기 (FR-WSL-52·53) ──

  // FR-WSL-52: 새 칸은 포커스 칸 **바로 뒤**에 서고 같은 창을 받으며, 곧바로
  // 포커스를 가져간다 — 방금 만든 칸에 다른 창을 여는 것이 기대되는 흐름이고
  // 그러면 사이드바 클릭 한 번으로 끝난다.
  slotAdd(){
    if(this.app.isMobile) return;                       // FR-WSL-62
    if(this.app.slot.slotCount()>=SLOT_MAX) return;          // FR-WSL-1
    if(!this.app._slots){
      const cur=this.app.ws.activeWindow||null;
      this.app._slots={windows:[cur,cur],sizes:[SLOT_SIZE_DEFAULT,SLOT_SIZE_DEFAULT],
        tabs:[{},{}],focused:1};
    }else{
      const at=this.app._slots.focused+1;
      this.app._slots.windows.splice(at,0,this.app._slots.windows[this.app._slots.focused]);
      this.app._slots.sizes.splice(at,0,SLOT_SIZE_DEFAULT);
      // FR-SVS-3: 새 칸은 포커스 칸과 같은 창을 받으므로 그 시선을 물려받는다.
      const src=this.app.slot._slotTabMap(this.app._slots.focused)||{};
      if(!Array.isArray(this.app._slots.tabs)) this.app._slots.tabs=this.app._slots.windows.map(()=>({}));
      this.app._slots.tabs.splice(at,0,Object.assign({},src));
      this.app._slots.focused=at;
    }
    this.app.slot._slotTabsSeed(this.app._slots.focused);
    this.app.slot._slotSyncSubs();
    this._slotSyncActive();
    this.app.slot._slotsPersist();
    this.app.render();
    this._slotClaimAll();
  }

  // FR-WSL-53: 포커스 칸이 사라지고 포커스는 그 자리의 이웃으로 간다. 칸이
  // 하나면 없앨 수 없다 — 그 상태가 단일 슬롯 모드다.
  slotRemove(){
    if(!this.app._slots) return;
    const n=this.app.slot.slotCount();
    if(n<=1) return;
    if(n===2){
      const ki=this.app._slots.focused===0?1:0;
      const keep=this.app._slots.windows[ki];
      // 단일 슬롯 모드에는 오버라이드가 없다 (FR-SVS-2). 남는 칸이 보던 탭이
      // 사라지지 않도록 그 시선을 워크스페이스에 내려 적고 맵을 버린다.
      const km=this.app._slots.tabs&&this.app._slots.tabs[ki];
      const kw=keep?this.app.ws.windows.find(x=>x.id===keep):null;
      if(km&&kw&&kw.layout){
        for(const pn of this.app.flattenPanes(kw.layout)){
          const tid=km[pn.id];
          if(tid&&(pn.tabs||[]).some(tab=>tab.id===tid)) pn.activeTab=tid;
        }
      }
      this.app._slots=null;
      this.app.slot._slotCloseAllSubs();
      this._slotReap();
      this.app.slot._slotsPersist();
      if(keep){
        this.app.layout.winState._activateWindow(keep);
      }
      this.app.render();
      if(this.app.ws.activeWindow) this.app.focus.owner._focusWindow(this.app.ws.activeWindow,0);
      return;
    }
    const at=this.app._slots.focused;
    this.app._slots.windows.splice(at,1);
    this.app._slots.sizes.splice(at,1);
    if(Array.isArray(this.app._slots.tabs)) this.app._slots.tabs.splice(at,1);
    if(this.app._slots.focused>=this.app._slots.windows.length) this.app._slots.focused=this.app._slots.windows.length-1;
    this.app.slot._slotSyncSubs();
    this._slotReap();
    this._slotSyncActive();
    this.app.slot._slotsPersist();
    this.app.render();
    this._slotClaimAll();
  }

  // ── 포커스·배치 (FR-WSL-45·54·55) ──

  /**
   * FR-SVS-61: `deferRender` 면 **누른 그 한 번이 목적한 일을 한다.**
   *
   * mousedown 에서 곧바로 `render()` 를 돌면 `.slot`·`.pn`·`.ed-win` 이 지워지고
   * 다시 만들어진다. mousedown 을 받은 요소가 그때 문서에서 떨어지므로 브라우저는
   * click 을 발생시키지 않고, 다른 칸의 탭·탐색기 행을 누른 첫 클릭이 통째로
   * 사라졌다 (§2.11).
   *
   * 포커스 이동은 **구조를 바꾸지 않는다** — 바뀌는 것은 강조 클래스와 소유권
   * 흐림뿐이다. 그래서 강조만 즉시 칠하고 전체 그리기는 이 클릭이 끝난 뒤로
   * 미룬다. 미룬 것을 실제로 하는 자리는 `slotRenderFlush` 이고, 클릭이 자기
   * 일로 render 를 돌면 그것이 대신한다 (`App.render` 가 플래그를 지운다).
   */
  slotFocusTo(i,opts){
    if(!this.app._slots||i<0||i>=this.app.slot.slotCount()) return;
    if(this.app._slots.focused===i){this._slotSyncActive();return}
    this.app._slots.focused=i;
    this._slotSyncActive();
    this.app.slot._slotsPersist();
    if(opts&&opts.deferRender){
      this._slotPaintFocus();
      this.app._slotRenderPending=true;
      this._slotRenderArm();
    }else{
      this.app.render();
    }
    if(this.app.ws.activeWindow) this.app.focus.owner._focusWindow(this.app.ws.activeWindow,i);
  }

  /**
   * WINDOW_SLOTS_SRS FR-WSL-56 (2026-09-08 접수): 칸 사이를 **직접** 오간다.
   *
   *   이전 동작: 칸 이동에는 키가 없었다 — pane 이동이 창의 **끝에서** 넘어가는
   *              것이 유일한 길이었다 (FR-WSL-40, D-5)
   *   새  동작: 이전 칸·다음 칸에 각자 키가 있다. 끝에서는 반대편으로 감긴다
   *   이유:     끝으로 밀어야 넘어가는 이동은 칸 안의 분할이 깊을수록 멀다.
   *              가려는 자리가 정해져 있는데 그 앞을 다 지나야 했다 (사용자 지시)
   *
   * 칸이 하나면 아무 일도 하지 않는다 — 감아 봐야 제자리다. `slotFocusTo` 를
   * 지나므로 활성 창·활성 탭 동기화와 소유권 주장이 클릭과 **같은 길**이다.
   */
  slotNav(delta){
    const n=this.app.slot.slotCount(); if(n<=1) return;
    this.slotFocusTo((this.app.slot.slotFocused()+delta+n)%n);
  }

  /**
   * UX_BATCH14_SRS FR-SFX-1~4: 에이전트 카드에 올린 마우스 — 그 탭을 가진 칸만 또렷하고 나머지 칸은 흐리다.
   * 이 화면만의 일이다(D-UB14-4). null 이면 푼다. 칸 구성이 바뀌면 `slotHoverPaint` 가 다시 칠한다.
   */
  slotHoverTool(toolId){
    this._hoverTool=toolId||null;
    this.slotHoverPaint();
  }

  slotHoverPaint(){
    const n=this.app.slot.slotCount();
    const id=this._hoverTool;
    const loc=id&&!this.app.isMobile&&n>1?this.app.tool.life.findToolLocation(id):null;
    const wins=[];
    for(let k=0;k<n;k++){const w=this.app.slot.slotWindow(k);wins.push(w?w.id:null)}
    const blur=new Set(slotBlurTargets(wins,loc?loc.win.id:null));
    for(const el of document.querySelectorAll('#area .slot')) el.classList.toggle('slot-blurred',blur.has(Number(el.dataset.slot)));
  }

  // 강조만 칠한다. render 를 대신하는 것이 아니라 그 **앞자리**를 메운다 —
  // 사용자가 누른 칸이 즉시 켜져 보여야 하기 때문이다.
  _slotPaintFocus(){
    const n=this.app.slot.slotCount();
    const f=this.app.slot.slotFocused();
    for(let k=0;k<n;k++){
      const el=document.querySelector(`#area .slot[data-slot="${k}"]`);
      if(el) el.classList.toggle('slot-focused',k===f);
      // SLOT_MARKER_SRS FR-SMK-9: 마커도 **같은 판정**을 딛는다. 이 경로는
      // `render()` 를 미루므로(`deferRender`), 여기서 칠하지 않으면 마커만 옛
      // 칸을 가리킨 채 남는다 — 포커스를 말하는 자리 둘이 서로 다른 말을 한다.
      const m=document.querySelector(`#slot-marker .slot-marker-cell[data-slot="${k}"]`);
      if(m){
        if(k===f) m.setAttribute('aria-current','true');
        else m.removeAttribute('aria-current');
      }
    }
  }

  // 미뤄 둔 그리기를 지금 한다. 클릭이 **끝난 뒤** 부르는 자리다.
  slotRenderFlush(){
    if(!this.app._slotRenderPending) return;
    this.app.render();
  }

  /**
   * FR-SVS-62 (§2.11.1): **click 은 오지 않을 수 있는 신호다.**
   *
   *   이전 동작: 미룬 그리기를 하는 자리는 칸 el 의 click 하나였다
   *   새  동작: click 이 오지 않아도 그 누름이 끝나면 미룬 그리기가 돈다
   *   이유:     xterm 은 출력을 갱신할 때 문자 span 을 교체한다. mousedown 을
   *             받은 그 span 이 사라지면 브라우저는 click 을 발생시키지 않고,
   *             미룬 `render()` 가 영영 유실된다 — 칸 포커스 이동에 딸린 활성
   *             탭·창 이름·사이드바 탭·소유권 흐림이 함께 멎었고, 무관한 git
   *             폴링이 사이드바 탭만 우연히 정정하고 있었다 (실측)
   *
   * 예약이 **mouseup 뒤**여야 하는 이유는 그 사이에 click 이 서기 때문이다.
   * 누르고 있는 동안 그리면 FR-SVS-61 이 막은 결함이 되살아난다. click 이 오면
   * 그것이 먼저 그리고 `_slotRenderPending` 이 내려가므로 이 예약은 아무 일도
   * 하지 않는다 — **먼저 온 신호 하나만** 그린다.
   *
   * 듣는 자리가 칸 el 이 아니라 window 인 것은 칸 안에서 눌러 밖에서 놓는
   * 누름도 끝난 누름이기 때문이다.
   */
  _slotRenderArm(){
    if(this._slotRenderArmed) return;
    this._slotRenderArmed=true;
    window.addEventListener('mouseup',()=>{
      this._slotRenderArmed=false;
      // FR-SCH-13: `defer` 는 기다리는 것이 아니라 **순서를 미루는 것**이다 —
      // 이 자리가 원하는 것이 정확히 그것이다. click 은 mouseup 의 **뒤에**
      // 서므로, 마감을 가진 지연이 아니라 다음 태스크여야 한다.
      this.app.timers.defer(()=>this.slotRenderFlush(),{owner:'slots',label:'render-flush'});
    },{once:true});
  }

  // 포커스 칸의 창을 `ws.activeWindow` 로 옮긴다 (FR-WSL-3). `focused`(pane) 도 그
  // 창이 기억하는 자리로 맞춘다 — 창을 오갈 때 `switchWindow` 가 하는 일과 같다
  // (FR-WSL-43).
  _slotSyncActive(){
    const s=this.app.slot.slotWindow(this.app.slot.slotFocused());
    if(!s) return;
    this.app.layout.winState._activateWindow(s.id);
    // FR-SVS-14: 워크스페이스의 활성 탭은 **포커스 칸이 보는 것**이다. 포커스가
    // 칸을 옮기면 그것도 따라온다.
    if(this.app.slot._slotTabsToWs()) this.app.wsSave.save();
    if(s.layout){
      const saved=s.focusedPane;
      const pn=(saved&&findPane(s.layout,saved))?{id:saved}:firstPane(s.layout);
      if(pn) this.app.focus.setFocusState(pn.id,s);
    }
  }

  slotOpen(i,winId){
    if(!this.app._slots||i<0||i>=this.app.slot.slotCount()) return;
    this.app._slots.windows[i]=winId||null;
    // FR-SVS-3: 창이 바뀐 칸의 시선은 그 창의 현재 활성 탭에서 시작한다. 이전
    // 창의 pane id 가 남아 있어도 해가 없다 — `paneTab` 이 없는 탭을 폴백한다.
    this.app.slot._slotTabsSeed(i);
    if(i===this.app._slots.focused) this._slotSyncActive();
    this._slotReap();          // FR-WSL-21: 밀려난 창의 인스턴스를 회수한다
    this.app.slot._slotsPersist();
    this.app.render();
    this._slotClaimAll();
  }

  // 칸의 창을 각자의 신원으로 클레임한다.
  //
  // FR-WSL-14: 같은 창이 여러 칸에 있으면 **포커스 칸만** 주장한다. 둘 이상이
  // 주장하면 `_focusClaim` 이 fire-and-forget POST 를 여럿 내보내고, 어느 쪽이
  // 이길지는 네트워크 도착 순서에 달린다 — 로컬에서는 나중에 부른 쪽이 이기지만
  // 서버 브로드캐스트가 그것을 뒤집는다. 실측으로 드러난 경합이다.
  //
  // 주장하지 않은 칸은 소유자가 아니게 되어 흐려진다 — 그것이 이 요구가 원하는
  // 결과 그대로다.
  _slotClaimAll(){
    if(!this.app._slots) return;
    const {windows,focused}=this.app._slots;
    const claimed=new Set();
    // 포커스 칸이 먼저다 — 같은 창을 든 다른 칸은 주장하지 않는다.
    const order=[focused];
    for(let i=0;i<windows.length;i++) if(i!==focused) order.push(i);
    for(const i of order){
      const id=windows[i];
      if(!id||claimed.has(id)) continue;
      claimed.add(id);
      this.app.focus.owner._focusWindow(id,i);
    }
  }

  // ── 창 전환·삭제의 반영 ──

  // FR-WSL-54: 창을 여는 **모든** 길이 포커스 칸에 연다. `switchWindow` 가
  // 사이드바 클릭·순회 키·`_focusLocation` 이 모두 지나는 단일 통로이므로 여기
  // 한 자리에 건다 — 경로마다 걸면 한 곳이 빠진다.
  _slotOnSwitch(sid){
    if(!this.app._slots||!sid) return;
    if(this.app._slots.windows[this.app._slots.focused]===sid) return;
    this.app._slots.windows[this.app._slots.focused]=sid;
    this.app.slot._slotTabsSeed(this.app._slots.focused);   // FR-SVS-3
    this._slotReap();
    this.app.slot._slotsPersist();
  }

  // FR-WSL-6: 칸이 가리키던 창이 사라지면 그 칸은 빈다. **칸 자체는 남는다** —
  // 사용자가 만든 칸을 앱이 임의로 없애지 않는다.
  _slotOnWindowGone(sid){
    if(!this.app._slots||!sid) return;
    let hit=false;
    for(let i=0;i<this.app._slots.windows.length;i++){
      if(this.app._slots.windows[i]===sid){this.app._slots.windows[i]=null;hit=true}
    }
    if(!hit) return;
    this.app.slot._slotFocusFallback();
    this._slotReap();
    this.app.slot._slotsPersist();
  }

  // ── 경계 넘침 (FR-WSL-40~46) ──

  // `paneNavigate` 가 창 안에서 갈 pane 을 찾지 못했을 때 부른다. 넘어갈 곳이
  // 없으면 무동작이다 — 그것이 지금까지의 동작이고, 칸이 없을 때도 같다.
  // 순환하지 않는다: 마지막 칸에서 더 가도 첫 칸으로 돌아오지 않는다.
  slotNavigate(dir){
    if(!this.app._slots||this.app.isMobile) return false;          // FR-WSL-44·60
    // FR-WSL-42: 넘는 축은 칸이 놓인 방향을 따른다. 좌우로 놓인 칸을 위아래 키가
    // 넘으면 "칸으로 간다" 는 키의 뜻이 깨진다.
    const axis=this.app.slotDir==='vertical'?['up','down']:['left','right'];
    if(!axis.includes(dir)) return false;
    const from=this.app._slots.focused;
    const to=dir===axis[1]?from+1:from-1;
    if(to<0||to>=this.app.slot.slotCount()) return false;           // FR-WSL-44
    if(!this.app._slots.windows[to]) return false;             // FR-WSL-46
    this.slotFocusTo(to);
    return true;
  }

  // ── 인스턴스 회수 (FR-WSL-21·24) ──

  // 어느 칸에서도 더 이상 보이지 않게 된 도구·편집기 인스턴스를 파괴한다. 같은
  // 창을 여러 칸에 두면 WebSocket 이 그만큼 늘어나므로, 이 회수가 새면 연결이
  // 누적된다 (§7 R-1).
  _slotReap(){
    // FR-SVS-46: Git 패널도 칸의 것이다 — 사라진 칸의 것을 함께 거둔다.
    this.app.git.surfaces._gitPanelReap();
    // 칸 i(>0) 마다 그 칸이 지금 보여주는 toolId·tabId 집합.
    const keepTools=new Map(), keepTabs=new Map();
    const n=this.app.slot.slotCount();
    for(let i=1;i<SLOT_MAX;i++){
      const tools=new Set(), tabs=new Set();
      const s=(i<n)?this.app.slot.slotWindow(i):null;
      if(s&&s.layout){
        for(const pn of this.app.flattenPanes(s.layout)){
          for(const tab of (pn.tabs||[])){
            if(tab.toolId) tools.add(tab.toolId);
            tabs.add(tab.id);
          }
        }
      }
      keepTools.set(i,tools); keepTabs.set(i,tabs);
    }
    for(const [k,p] of [...this.app.tools]){
      const i=this.app.slot._slotOf(k); if(!i) continue;
      if(keepTools.get(i)?.has(this.app.slot.slotBase(k))) continue;
      ErrorLog.quiet('destroy',()=>p.destroy());
      this.app.tools.delete(k);
    }
    for(const [k,v] of [...this.app.fileEditors]){
      const i=this.app.slot._slotOf(k); if(!i) continue;
      if(keepTabs.get(i)?.has(this.app.slot.slotBase(k))) continue;
      ErrorLog.quiet('destroy',()=>v.destroy());
      this.app.fileEditors.delete(k);
    }
    // SLOT_RUN_VIEW_SRS FR-SRV-4.2: Run 뷰도 칸의 것이다 — 편집기와 같은 판정을
    // 같은 자리에서 한다. 여기서 빠지면 사라진 칸의 뷰가 관측자를 들고 남는다.
    // 레지스트리는 RunsPanel 이 든다 (APP_STATE_EXTRACT_SRS 묶음 A). `runsPanel()`
    // 로 지연 생성하지 않는다 — Run 을 연 적이 없으면 거둘 것도 없다.
    const rp=this.app._runs;
    if(rp&&rp._runViews) for(const [k,v] of [...rp._runViews]){
      const i=this.app.slot._slotOf(k); if(!i) continue;
      if(keepTabs.get(i)?.has(this.app.slot.slotBase(k))) continue;
      rp._runDisposeView(v);
      rp._runViews.delete(k);
    }
  }

  // ── 진입점 배선 (FR-WSL-50·51·81) ──

  // 버튼과 단축키가 **같은 함수**를 부른다 — 여는 길이 둘로 갈리면 한쪽만
  // 고쳐진다 (FR-PSC-3 이 이미 세운 규약).
  _initSlots(){
    // FR-UXB-4: 방향이 창의 것이 되면서 기기의 키는 읽는 자리를 잃었다. 남겨
    // 두면 다음 사람이 그것을 진실로 읽는다 — 부팅에서 한 번 지운다.
    PrefStore.local.remove(SLOT_DIR_KEY);
    const add=document.getElementById('slot-add');
    if(add) add.addEventListener('click',()=>this.slotAdd());
    const rm=document.getElementById('slot-remove');
    if(rm) rm.addEventListener('click',()=>this.slotRemove());
    // UX_BATCH12_SRS FR-RTR-13a: 뒤로·앞으로 버튼은 단축키와 같은 액션이다. 같은 상단바 줄이라 여기서 붙인다.
    for(const [id,action] of [['nav-back','focusBack'],['nav-forward','focusForward']]){
      const b=document.getElementById(id);
      if(b) b.addEventListener('click',()=>this.app.executeAction(action));
    }
    // FR-WSL-81: 방향 설정의 배선은 `DisplaySection` 이 한다 (REFACTOR3_FE_SETTINGS_SRS D-FES-5).
  }

  // FR-SCT-1·3: 지금 값은 컨테이너의 `data-v` 하나가 말한다 — 손잡이의 자리도,
  // 켜진 이름도 CSS 가 그것에서 그린다. 값을 밖에서 읽는 자리를 하나로 남긴다.
  _slotDirPaint(){
    const el=document.getElementById('ds-slotdir');
    if(!el) return;
    const cur=this.app.slotDir==='vertical'?'vertical':'horizontal';
    el.dataset.v=cur;
    const sw=el.querySelector('button');
    if(!sw) return;
    sw.setAttribute('aria-checked',cur==='vertical'?'true':'false');
    sw.title=SLOT_DIR_TITLE[cur];
  }

  // ── 손잡이 (FR-WSL-32) ──

  // 손잡이는 **이웃한 두 칸의 배분**만 바꾼다 — 나머지 칸은 그대로다. 창 안
  // 분할의 손잡이(`_handle`)와 같은 규약이다.
  slotHandleBind(h,i){
    if(!h) return;
    /**
     * UI_KIT_SRS FR-HSZ-1·10: 여섯 핸들이 `UIKit.drag` 한 골격을 쓴다.
     *
     * FR-HSZ-6: 여기서 `%` 는 **곧 저장되는 값**이다 (`_slots.sizes`) — 화면이
     * 보이는 수치와 워크스페이스에 남는 수치가 같다.
     */
    const vertOf=()=>this.app.slotDir==='vertical';
    UIKit.drag(h,{
      axis:vertOf()?'y':'x',
      start:()=>{
        const vert=vertOf();
        const a=document.querySelector(`#area .slot[data-slot="${i}"]`);
        const b=document.querySelector(`#area .slot[data-slot="${i+1}"]`);
        if(!a||!b) return false;
        const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
        const aPx0=vert?ra.height:ra.width;
        return {
          a,b,vert,aPx0,
          total:aPx0+(vert?rb.height:rb.width),
          sum:this.app._slots.sizes[i]+this.app._slots.sizes[i+1],
        };
      },
      move:(ctx,ev)=>{
        const delta=(ctx.vert?ev.clientY-ctx.sy0:ev.clientX-ctx.sx0);
        const aPx=Math.min(ctx.total-SLOT_MIN_PX,Math.max(SLOT_MIN_PX,ctx.aPx0+delta));
        this.app._slots.sizes[i]=ctx.sum*(aPx/ctx.total);
        this.app._slots.sizes[i+1]=ctx.sum-this.app._slots.sizes[i];
        this.slotApplySizes();
      },
      sides:(ctx)=>{
        const {a,b,vert,aPx0,total}=ctx;
        const ap=vert?a.getBoundingClientRect().height:a.getBoundingClientRect().width;
        const bp=Math.max(0,total-ap), d=ap-aPx0;
        const cell=(el,delta)=>UIKit.grid(this.app.layout.tabOps.termIn(el),vert?'y':'x',vert?0:delta,vert?delta:0);
        return [
          {px:ap,cell:cell(a,d),pct:total?ap/total*100:null},
          {px:bp,cell:cell(b,-d),pct:total?bp/total*100:null},
        ];
      },
      end:()=>{
        this.app.slot._slotsPersist();
        // 배분이 바뀌면 PTY 크기도 바뀐다 — 놓는 순간 한 번만 맞춘다.
        for(const p of this.app.tools.values()){ if(p.el.classList.contains('vis')) p.sizer.doFit() }
      },
    });
  }

  // 칸은 flex 아이템이다 (D-8) — 배분값만 준다. 방향은 `#area[data-slotdir]` 의
  // `flex-direction` 이 정하므로 여기서 축을 따질 일이 없다.
  slotApplySizes(){
    if(!this.app._slots) return;
    for(let i=0;i<this.app._slots.windows.length;i++){
      const el=document.querySelector(`#area .slot[data-slot="${i}"]`);
      if(el) el.style.flex=`${this.app._slots.sizes[i]} 1 0`;
    }
  }
}
