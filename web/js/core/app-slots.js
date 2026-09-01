/**
 * Remote Terminal — 창 슬롯 (WINDOW_SLOTS_SRS 묶음 S·I·N·U·D)
 *
 * 콘텐츠 영역을 여러 칸으로 나눠 창을 하나씩 담는다. 창 하나만 그리던 `_rLayout`
 * 이 칸마다 도는 것이 전부이고, **창 타입의 불변식은 건드리지 않는다** — 슬롯은
 * 창을 담는 그릇이다 (§1.2).
 *
 * 슬롯은 클라이언트의 것이다 (FR-WSL-2, D-2). `workspace.json` 에 새지 않으므로
 * 데스크톱의 배치가 모바일 접속에 강제되지 않는다.
 *
 * 소유권의 열쇠는 **칸마다 다른 clientId** 다 (FR-WSL-10, D-3). 서버의 `owners`
 * 맵은 여전히 `windowId → clientId` 이고 여전히 한 클라이언트가 창 하나를
 * 소유한다 — 칸 여럿은 서버 눈에 정확히 브라우저 창 여럿이다.
 *
 * 칸의 크기는 **flex 배분값**이다 (D-8). 2칸 시절의 `ratio`(경계 위치) 로는 셋을
 * 넘길 수 없고, 창 안 분할이 이미 같은 표현을 쓴다 (`split.sizes`).
 *
 * app.js 이후에 로드된다.
 */
const SLOT_KEY='slots';                  // FR-WSL-72
const SLOT_MAX=4;                        // FR-WSL-1, D-9
const SLOT_SIZE_DEFAULT=1;
const SLOT_MIN_PX=80;                    // 손잡이가 칸을 이보다 좁히지 않는다
const SLOT_DIR_KEY='slotDir';            // FR-WSL-82
const SLOT_DIR_DEFAULT='horizontal';     // FR-WSL-80
// FR-WSL-81: 토글에 적히는 **지금 값**이다. 고를 목록이 아니라 현재 상태이므로
// 그림과 말이 함께 있어야 한다 — 그림만으로는 어느 쪽이 켜진 것인지 모른다.
const SLOT_DIR_LABEL={horizontal:'▐▌ 가로',vertical:'▀▄ 세로'};
const SLOT_DIR_TITLE={horizontal:'좌우로 나눔 — 누르면 위아래로',vertical:'위아래로 나눔 — 누르면 좌우로'};

Object.assign(App.prototype, {
  // ── 상태 (FR-WSL-73) ──

  slotCount(){ return this._slots?this._slots.windows.length:1 },
  _slotFocused(){ return this._slots?this._slots.focused:0 },

  // FR-WSL-75: 칸 0 의 키는 `toolId` **그대로**다. 단일 슬롯 모드의 Map 이 지금과
  // 한 글자도 다르지 않아야 D-4 가 Map 층에서도 성립한다.
  _slotKey(id,slot){ return slot?`${id}@${slot}`:id },

  // 복합키에서 슬롯 번호와 원래 id 를 되돌린다. `_slotKey` 의 역이며 **자리는
  // 여기 하나다** — 렌더러의 편집기 회수가 자기 손으로 `@1` 만 잘라 내다가 칸
  // 2·3 의 편집기를 매 render 마다 파괴했다 (FR-SVS-60).
  _slotOf(k){
    const at=k.lastIndexOf('@');
    if(at<0) return 0;
    const i=parseInt(k.slice(at+1),10);
    return Number.isInteger(i)?i:0;
  },
  _slotBase(k){
    const at=k.lastIndexOf('@');
    if(at<0) return k;
    return Number.isInteger(parseInt(k.slice(at+1),10))?k.slice(0,at):k;
  },

  // ── 칸별 활성 탭 (SLOT_VIEW_STATE_SRS FR-SVS-1~14) ──

  // 오버라이드 맵을 확보한다. 단일 슬롯 모드에서는 만들지 않는다 (FR-SVS-2) —
  // 그 상태에 맵이 있으면 `pn.activeTab` 이 진실이라는 규약이 흐려진다.
  _slotTabMap(i){
    if(!this._slots) return null;
    if(!Array.isArray(this._slots.tabs)) this._slots.tabs=this._slots.windows.map(()=>({}));
    while(this._slots.tabs.length<this._slots.windows.length) this._slots.tabs.push({});
    if(!this._slots.tabs[i]) this._slots.tabs[i]={};
    return this._slots.tabs[i];
  },

  /**
   * FR-SVS-1·2·5: 칸 `slot` 에서 pane `pn` 이 보이는 탭 id.
   *
   * **활성 탭을 읽는 자리는 이 함수 하나다.** 읽는 자리가 둘이면 한쪽이 칸을
   * 모르는 채로 남고, 그 어긋남은 두 칸이 같은 창을 볼 때만 드러난다.
   *
   * `slot` 을 생략하면 포커스 칸이다 — 창 하나를 상대하는 대부분의 호출자가
   * 뜻하는 것이 그것이다.
   */
  paneTab(pn,slot){
    if(!pn) return null;
    const tabs=pn.tabs||[];
    const i=(slot==null)?this._slotFocused():slot;
    const m=this._slots&&Array.isArray(this._slots.tabs)?this._slots.tabs[i]:null;
    const tid=m&&m[pn.id];
    if(tid&&tabs.some(t=>t.id===tid)) return tid;
    if(pn.activeTab&&tabs.some(t=>t.id===pn.activeTab)) return pn.activeTab;
    return (tabs[0]&&tabs[0].id)||null;
  },

  /**
   * FR-SVS-4·14: 칸 `slot` 이 pane `pn` 에서 보는 탭을 정한다.
   *
   * 그 칸의 오버라이드만 바꾼다 — 다른 칸은 움직이지 않는다. 다만 **포커스
   * 칸**이면 워크스페이스의 `pn.activeTab` 에도 쓴다. `dmctl` 의 활성 판정이
   * 그것을 딛기 때문이며 (SRS §2.4), `focusedPane` 이 로컬이면서 워크스페이스에도
   * 쓰이는 것과 같은 취급이다.
   */
  paneTabSet(pn,tid,slot){
    if(!pn||!tid) return;
    const i=(slot==null)?this._slotFocused():slot;
    const m=this._slotTabMap(i);
    if(m){ m[pn.id]=tid; this._slotsPersist() }
    if(!this._slots||i===this._slotFocused()) pn.activeTab=tid;
  },

  // FR-SVS-3: 칸이 창을 받으면 그 창의 pane 마다 **그 순간의 활성 탭**으로
  // 오버라이드를 채운다. 채우지 않으면 다른 칸이 탭을 바꿀 때 이 칸이 따라
  // 움직인다 — 오버라이드가 없는 pane 은 `pn.activeTab` 을 따르기 때문이다.
  _slotTabsSeed(i){
    if(!this._slots) return;
    const s=this._slotWindow(i);
    if(!s||!s.layout) return;
    const m=this._slotTabMap(i);
    for(const pn of this._flattenPanes(s.layout)){
      if(!m[pn.id]&&pn.activeTab) m[pn.id]=pn.activeTab;
    }
  },

  // FR-SVS-14 의 반대 방향: 포커스 칸이 바뀌면 그 칸의 시선이 워크스페이스의
  // 활성 탭이 된다. 포커스 이동만으로 탭이 바뀌는 것이 아니라, **워크스페이스가
  // 포커스 칸을 따라오는** 것이다.
  _slotTabsToWs(){
    if(!this._slots) return false;
    const s=this._slotWindow(this._slotFocused());
    if(!s||!s.layout) return false;
    const m=this._slots.tabs&&this._slots.tabs[this._slotFocused()];
    if(!m) return false;
    let changed=false;
    for(const pn of this._flattenPanes(s.layout)){
      const tid=m[pn.id];
      if(tid&&pn.activeTab!==tid&&(pn.tabs||[]).some(t=>t.id===tid)){pn.activeTab=tid;changed=true}
    }
    return changed;
  },

  // 칸 idx 에 있는 창. 단일 슬롯 모드면 활성 창이다.
  _slotWindow(i){
    if(!this._slots) return i?null:this._aw();
    const id=this._slots.windows[i];
    return id?(this.ws.windows.find(s=>s.id===id)||null):null;
  },

  /**
   * SLOT_VIEW_STATE_SRS FR-SVS-36·37·38: 이 창이 **지금 화면에 있는가.**
   *
   * 활성 창인가와 다르다. 칸이 여럿이면 여러 창이 동시에 보이며(FR-WSL-1), 그중
   * 포커스는 하나뿐이다. "보인다" 를 "활성이다" 로 물으면 눈앞의 Git·Editor 가
   * 멎은 채로 남는다 — 접수한 증상이 그것이다.
   *
   * 판정이 여기 있는 이유는 슬롯의 안을 아는 것이 App 이기 때문이다 (FR-SVS-37).
   * 패널이 `_slots` 를 직접 들여다보면 그 표현이 바뀔 때마다 따라 고쳐야 한다.
   *
   * 단일 슬롯 모드의 답은 종전과 한 글자도 다르지 않다 (FR-SVS-38).
   */
  _windowVisible(id){
    if(!id) return false;
    if(!this._slots) return this.ws.activeWindow===id;
    return this._slots.windows.includes(id);
  },

  // ── 신원 (FR-WSL-10·11) ──

  // 칸 0 은 App.clientId 를 그대로 쓴다 — 단일 슬롯 모드에서 서버가 보는 신원이
  // 지금과 같아야 하기 때문이다. 신원은 **인덱스에 매인다**: 칸이 줄면 초과
  // 인덱스의 구독만 닫히고, 남은 칸들은 0..n-1 의 신원을 그대로 쓴다.
  _slotIdentity(i){
    if(!i) return this.clientId;
    if(!this._slotIds[i]) this._slotIds[i]=newUUID();
    return this._slotIds[i];
  },

  // 이 브라우저 창이 쓰는 신원 전부. `_resizeCheck`·`_applyFocusOverlay` 가
  // "내 것인가" 를 판정할 때 딛는다 (FR-WSL-13).
  _slotIdentities(){
    const n=this.slotCount();
    const out=[];
    for(let i=0;i<n;i++) out.push(this._slotIdentity(i));
    return out;
  },

  // FR-WSL-11: 칸 i(>0) 의 소유권은 그 신원의 SSE 구독이 살아 있는 동안만
  // 유지된다 (FR-XDF-9). 구독 없는 신원은 소유를 영원히 붙든다.
  //
  // 이 구독들은 메시지를 처리하지 않는다 — 워크스페이스 변경·알람·명령은 칸 0 의
  // 구독이 이미 받고 있고, 같은 브라우저 안에서 두 번 처리하면 그것이 결함이다.
  _slotSyncSubs(){
    const n=this.slotCount();
    for(let i=1;i<SLOT_MAX;i++){
      const want=i<n;
      if(want&&!this._slotSse[i]){
        try{
          this._slotSse[i]=new EventSource(
            '/api/commands/sse?clientId='+encodeURIComponent(this._slotIdentity(i)));
        }catch{ this._slotSse[i]=null }
      }else if(!want&&this._slotSse[i]){
        try{this._slotSse[i].close()}catch{}
        this._slotSse[i]=null;
      }
    }
  },
  _slotCloseAllSubs(){
    for(let i=1;i<SLOT_MAX;i++){
      if(!this._slotSse[i]) continue;
      try{this._slotSse[i].close()}catch{}
      this._slotSse[i]=null;
    }
  },

  // ── 영속 (FR-WSL-2·72) ──

  _slotsPersist(){
    try{
      if(!this._slots){sessionStorage.removeItem(SLOT_KEY);return}
      sessionStorage.setItem(SLOT_KEY,JSON.stringify(this._slots));
    }catch{}
  },

  // 형식이 어긋나면 키를 지우고 단일 슬롯 모드로 떨어진다 (FR-WSL-72). 창 id 가
  // 워크스페이스에 없으면 그 칸만 비운다 (FR-WSL-7).
  _slotsRestore(){
    let raw=null;
    try{raw=sessionStorage.getItem(SLOT_KEY)}catch{}
    if(!raw) return;
    let v=null;
    try{v=JSON.parse(raw)}catch{}
    const n=v&&Array.isArray(v.windows)?v.windows.length:0;
    const ok=n>=2&&n<=SLOT_MAX&&Array.isArray(v.sizes)&&v.sizes.length===n
      &&Number.isInteger(v.focused)&&v.focused>=0&&v.focused<n;
    if(!ok){try{sessionStorage.removeItem(SLOT_KEY)}catch{};return}
    const has=id=>!!id&&this.ws.windows.some(s=>s.id===id);
    const windows=v.windows.map(id=>has(id)?id:null);
    const sizes=v.sizes.map(x=>(typeof x==='number'&&x>0)?x:SLOT_SIZE_DEFAULT);
    // FR-SVS-6·71: 오버라이드는 칸 배치와 같은 키에 산다. 형식이 어긋난 항목만
    // 빈 맵으로 떨어뜨린다 — 배치 전체를 버릴 이유는 아니다 (본 SRS 이전에 적힌
    // 키에는 `tabs` 가 없다).
    const tabs=windows.map((_,i)=>{
      const m=Array.isArray(v.tabs)?v.tabs[i]:null;
      return (m&&typeof m==='object'&&!Array.isArray(m))?Object.assign({},m):{};
    });
    this._slots={windows,sizes,tabs,focused:v.focused};
    this._slotFocusFallback();
    // FR-SVS-3: 복원된 맵에 없는 pane 은 지금의 활성 탭으로 채운다 — 본 SRS
    // 이전에 적힌 키에는 `tabs` 가 아예 없다.
    for(let i=0;i<this._slots.windows.length;i++) this._slotTabsSeed(i);
    const cur=this._slots.windows[this._slots.focused];
    if(cur) this.ws.activeWindow=cur;
    this._slotSyncSubs();
  },

  // 포커스 칸이 비었으면 창이 있는 **가장 가까운** 칸으로 옮긴다 (FR-WSL-6).
  _slotFocusFallback(){
    if(!this._slots) return;
    const {windows}=this._slots;
    if(windows[this._slots.focused]) return;
    const f=this._slots.focused;
    for(let d=1;d<windows.length;d++){
      if(windows[f+d]){this._slots.focused=f+d;return}
      if(windows[f-d]){this._slots.focused=f-d;return}
    }
  },

  // ── 더하기·빼기 (FR-WSL-52·53) ──

  // FR-WSL-52: 새 칸은 포커스 칸 **바로 뒤**에 서고 같은 창을 받으며, 곧바로
  // 포커스를 가져간다 — 방금 만든 칸에 다른 창을 여는 것이 기대되는 흐름이고
  // 그러면 사이드바 클릭 한 번으로 끝난다.
  slotAdd(){
    if(this.isMobile) return;                       // FR-WSL-62
    if(this.slotCount()>=SLOT_MAX) return;          // FR-WSL-1
    if(!this._slots){
      const cur=this.ws.activeWindow||null;
      this._slots={windows:[cur,cur],sizes:[SLOT_SIZE_DEFAULT,SLOT_SIZE_DEFAULT],
        tabs:[{},{}],focused:1};
    }else{
      const at=this._slots.focused+1;
      this._slots.windows.splice(at,0,this._slots.windows[this._slots.focused]);
      this._slots.sizes.splice(at,0,SLOT_SIZE_DEFAULT);
      // FR-SVS-3: 새 칸은 포커스 칸과 같은 창을 받으므로 그 시선을 물려받는다.
      const src=this._slotTabMap(this._slots.focused)||{};
      if(!Array.isArray(this._slots.tabs)) this._slots.tabs=this._slots.windows.map(()=>({}));
      this._slots.tabs.splice(at,0,Object.assign({},src));
      this._slots.focused=at;
    }
    this._slotTabsSeed(this._slots.focused);
    this._slotSyncSubs();
    this._slotSyncActive();
    this._slotsPersist();
    this.render();
    this._slotClaimAll();
  },

  // FR-WSL-53: 포커스 칸이 사라지고 포커스는 그 자리의 이웃으로 간다. 칸이
  // 하나면 없앨 수 없다 — 그 상태가 단일 슬롯 모드다.
  slotRemove(){
    if(!this._slots) return;
    const n=this.slotCount();
    if(n<=1) return;
    if(n===2){
      const ki=this._slots.focused===0?1:0;
      const keep=this._slots.windows[ki];
      // 단일 슬롯 모드에는 오버라이드가 없다 (FR-SVS-2). 남는 칸이 보던 탭이
      // 사라지지 않도록 그 시선을 워크스페이스에 내려 적고 맵을 버린다.
      const km=this._slots.tabs&&this._slots.tabs[ki];
      const kw=keep?this.ws.windows.find(x=>x.id===keep):null;
      if(km&&kw&&kw.layout){
        for(const pn of this._flattenPanes(kw.layout)){
          const tid=km[pn.id];
          if(tid&&(pn.tabs||[]).some(t=>t.id===tid)) pn.activeTab=tid;
        }
      }
      this._slots=null;
      this._slotCloseAllSubs();
      this._slotReap();
      this._slotsPersist();
      if(keep){
        this.ws.activeWindow=keep;
        try{sessionStorage.setItem('activeWindow',keep)}catch{}
      }
      this.render();
      if(this.ws.activeWindow) this._focusWindow(this.ws.activeWindow,0);
      return;
    }
    const at=this._slots.focused;
    this._slots.windows.splice(at,1);
    this._slots.sizes.splice(at,1);
    if(Array.isArray(this._slots.tabs)) this._slots.tabs.splice(at,1);
    if(this._slots.focused>=this._slots.windows.length) this._slots.focused=this._slots.windows.length-1;
    this._slotSyncSubs();
    this._slotReap();
    this._slotSyncActive();
    this._slotsPersist();
    this.render();
    this._slotClaimAll();
  },

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
   * 미룬다. 미룬 것을 실제로 하는 자리는 `_slotRenderFlush` 이고, 클릭이 자기
   * 일로 render 를 돌면 그것이 대신한다 (`App.render` 가 플래그를 지운다).
   */
  slotFocusTo(i,opts){
    if(!this._slots||i<0||i>=this.slotCount()) return;
    if(this._slots.focused===i){this._slotSyncActive();return}
    this._slots.focused=i;
    this._slotSyncActive();
    this._slotsPersist();
    if(opts&&opts.deferRender){
      this._slotPaintFocus();
      this._slotRenderPending=true;
    }else{
      this.render();
    }
    if(this.ws.activeWindow) this._focusWindow(this.ws.activeWindow,i);
  },

  // 강조만 칠한다. render 를 대신하는 것이 아니라 그 **앞자리**를 메운다 —
  // 사용자가 누른 칸이 즉시 켜져 보여야 하기 때문이다.
  _slotPaintFocus(){
    const n=this.slotCount();
    const f=this._slotFocused();
    for(let k=0;k<n;k++){
      const el=document.querySelector(`#area .slot[data-slot="${k}"]`);
      if(el) el.classList.toggle('slot-focused',k===f);
    }
  },

  // 미뤄 둔 그리기를 지금 한다. 클릭이 **끝난 뒤** 부르는 자리다.
  _slotRenderFlush(){
    if(!this._slotRenderPending) return;
    this.render();
  },

  // 포커스 칸의 창을 `ws.activeWindow` 로 옮긴다 (FR-WSL-3). `focused`(pane) 도 그
  // 창이 기억하는 자리로 맞춘다 — 창을 오갈 때 `switchWindow` 가 하는 일과 같다
  // (FR-WSL-43).
  _slotSyncActive(){
    const s=this._slotWindow(this._slotFocused());
    if(!s) return;
    this.ws.activeWindow=s.id;
    try{sessionStorage.setItem('activeWindow',s.id)}catch{}
    // FR-SVS-14: 워크스페이스의 활성 탭은 **포커스 칸이 보는 것**이다. 포커스가
    // 칸을 옮기면 그것도 따라온다.
    if(this._slotTabsToWs()) this._save();
    if(s.layout){
      const saved=s.focusedPane;
      const pn=(saved&&findPane(s.layout,saved))?{id:saved}:firstPane(s.layout);
      if(pn) this._setFocus(pn.id,s);
    }
  },

  slotOpen(i,winId){
    if(!this._slots||i<0||i>=this.slotCount()) return;
    this._slots.windows[i]=winId||null;
    // FR-SVS-3: 창이 바뀐 칸의 시선은 그 창의 현재 활성 탭에서 시작한다. 이전
    // 창의 pane id 가 남아 있어도 해가 없다 — `paneTab` 이 없는 탭을 폴백한다.
    this._slotTabsSeed(i);
    if(i===this._slots.focused) this._slotSyncActive();
    this._slotReap();          // FR-WSL-21: 밀려난 창의 인스턴스를 회수한다
    this._slotsPersist();
    this.render();
    this._slotClaimAll();
  },

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
    if(!this._slots) return;
    const {windows,focused}=this._slots;
    const claimed=new Set();
    // 포커스 칸이 먼저다 — 같은 창을 든 다른 칸은 주장하지 않는다.
    const order=[focused];
    for(let i=0;i<windows.length;i++) if(i!==focused) order.push(i);
    for(const i of order){
      const id=windows[i];
      if(!id||claimed.has(id)) continue;
      claimed.add(id);
      this._focusWindow(id,i);
    }
  },

  // ── 창 전환·삭제의 반영 ──

  // FR-WSL-54: 창을 여는 **모든** 길이 포커스 칸에 연다. `switchWindow` 가
  // 사이드바 클릭·순회 키·`_focusLocation` 이 모두 지나는 단일 통로이므로 여기
  // 한 자리에 건다 — 경로마다 걸면 한 곳이 빠진다.
  _slotOnSwitch(sid){
    if(!this._slots||!sid) return;
    if(this._slots.windows[this._slots.focused]===sid) return;
    this._slots.windows[this._slots.focused]=sid;
    this._slotTabsSeed(this._slots.focused);   // FR-SVS-3
    this._slotReap();
    this._slotsPersist();
  },

  // FR-WSL-6: 칸이 가리키던 창이 사라지면 그 칸은 빈다. **칸 자체는 남는다** —
  // 사용자가 만든 칸을 앱이 임의로 없애지 않는다.
  _slotOnWindowGone(sid){
    if(!this._slots||!sid) return;
    let hit=false;
    for(let i=0;i<this._slots.windows.length;i++){
      if(this._slots.windows[i]===sid){this._slots.windows[i]=null;hit=true}
    }
    if(!hit) return;
    this._slotFocusFallback();
    this._slotReap();
    this._slotsPersist();
  },

  // ── 경계 넘침 (FR-WSL-40~46) ──

  // `paneNavigate` 가 창 안에서 갈 pane 을 찾지 못했을 때 부른다. 넘어갈 곳이
  // 없으면 무동작이다 — 그것이 지금까지의 동작이고, 칸이 없을 때도 같다.
  // 순환하지 않는다: 마지막 칸에서 더 가도 첫 칸으로 돌아오지 않는다.
  slotNavigate(dir){
    if(!this._slots||this.isMobile) return false;          // FR-WSL-44·60
    // FR-WSL-42: 넘는 축은 칸이 놓인 방향을 따른다. 좌우로 놓인 칸을 위아래 키가
    // 넘으면 "칸으로 간다" 는 키의 뜻이 깨진다.
    const axis=this.slotDir==='vertical'?['up','down']:['left','right'];
    if(!axis.includes(dir)) return false;
    const from=this._slots.focused;
    const to=dir===axis[1]?from+1:from-1;
    if(to<0||to>=this.slotCount()) return false;           // FR-WSL-44
    if(!this._slots.windows[to]) return false;             // FR-WSL-46
    this.slotFocusTo(to);
    return true;
  },

  // ── 인스턴스 회수 (FR-WSL-21·24) ──

  // 어느 칸에서도 더 이상 보이지 않게 된 도구·편집기 인스턴스를 파괴한다. 같은
  // 창을 여러 칸에 두면 WebSocket 이 그만큼 늘어나므로, 이 회수가 새면 연결이
  // 누적된다 (§7 R-1).
  _slotReap(){
    // FR-SVS-46: Git 패널도 칸의 것이다 — 사라진 칸의 것을 함께 거둔다.
    this._gitPanelReap();
    // 칸 i(>0) 마다 그 칸이 지금 보여주는 toolId·tabId 집합.
    const keepTools=new Map(), keepTabs=new Map();
    const n=this.slotCount();
    for(let i=1;i<SLOT_MAX;i++){
      const tools=new Set(), tabs=new Set();
      const s=(i<n)?this._slotWindow(i):null;
      if(s&&s.layout){
        for(const pn of this._flattenPanes(s.layout)){
          for(const t of (pn.tabs||[])){
            if(t.toolId) tools.add(t.toolId);
            tabs.add(t.id);
          }
        }
      }
      keepTools.set(i,tools); keepTabs.set(i,tabs);
    }
    for(const [k,p] of [...this.tools]){
      const i=this._slotOf(k); if(!i) continue;
      if(keepTools.get(i)?.has(this._slotBase(k))) continue;
      try{p.destroy()}catch{}
      this.tools.delete(k);
    }
    for(const [k,v] of [...this.fileEditors]){
      const i=this._slotOf(k); if(!i) continue;
      if(keepTabs.get(i)?.has(this._slotBase(k))) continue;
      try{v.destroy()}catch{}
      this.fileEditors.delete(k);
    }
    // SLOT_RUN_VIEW_SRS FR-SRV-4.2: Run 뷰도 칸의 것이다 — 편집기와 같은 판정을
    // 같은 자리에서 한다. 여기서 빠지면 사라진 칸의 뷰가 관측자를 들고 남는다.
    // 레지스트리는 RunsPanel 이 든다 (APP_STATE_EXTRACT_SRS 묶음 A). `_runsPanel()`
    // 로 지연 생성하지 않는다 — Run 을 연 적이 없으면 거둘 것도 없다.
    const rp=this._runs;
    if(rp&&rp._runViews) for(const [k,v] of [...rp._runViews]){
      const i=this._slotOf(k); if(!i) continue;
      if(keepTabs.get(i)?.has(this._slotBase(k))) continue;
      rp._runDisposeView(v);
      rp._runViews.delete(k);
    }
  },

  // ── 진입점 배선 (FR-WSL-50·51·81) ──

  // 버튼과 단축키가 **같은 함수**를 부른다 — 여는 길이 둘로 갈리면 한쪽만
  // 고쳐진다 (FR-PSC-3 이 이미 세운 규약).
  _initSlots(){
    const add=document.getElementById('slot-add');
    if(add) add.addEventListener('click',()=>this.slotAdd());
    const rm=document.getElementById('slot-remove');
    if(rm) rm.addEventListener('click',()=>this.slotRemove());
    // FR-WSL-81: 값이 둘뿐이라 누를 때마다 뒤집는다. 고를 목록을 펼치는 것보다
    // 한 번 누르는 편이 짧다.
    const t=document.getElementById('ds-slotdir');
    if(t){
      t.addEventListener('click',()=>{
        this.slotDir=this.slotDir==='vertical'?'horizontal':'vertical';
        this._slotDirPaint();
      });
      this._slotDirPaint();
    }
  },

  // 버튼에 적힌 것은 **지금 값**이지 다음 값이 아니다. 눌러서 바뀌는 방향은
  // title 이 말한다 — 둘을 뒤집어 적으면 켜진 것이 무엇인지 읽을 수 없다.
  _slotDirPaint(){
    const t=document.getElementById('ds-slotdir');
    if(!t) return;
    const cur=this.slotDir==='vertical'?'vertical':'horizontal';
    t.textContent=SLOT_DIR_LABEL[cur];
    t.title=SLOT_DIR_TITLE[cur];
    t.dataset.v=cur;
  },

  // ── 손잡이 (FR-WSL-32) ──

  // 손잡이는 **이웃한 두 칸의 배분**만 바꾼다 — 나머지 칸은 그대로다. 창 안
  // 분할의 손잡이(`_handle`)와 같은 규약이다.
  _slotHandleBind(h,i){
    if(!h) return;
    h.addEventListener('mousedown',e=>{
      e.preventDefault();
      const vert=this.slotDir==='vertical';
      const a=document.querySelector(`#area .slot[data-slot="${i}"]`);
      const b=document.querySelector(`#area .slot[data-slot="${i+1}"]`);
      if(!a||!b) return;
      const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
      const aPx0=vert?ra.height:ra.width;
      const total=aPx0+(vert?rb.height:rb.width);
      const sum=this._slots.sizes[i]+this._slots.sizes[i+1];
      const start=vert?e.clientY:e.clientX;
      const move=ev=>{
        const delta=(vert?ev.clientY:ev.clientX)-start;
        const aPx=Math.min(total-SLOT_MIN_PX,Math.max(SLOT_MIN_PX,aPx0+delta));
        this._slots.sizes[i]=sum*(aPx/total);
        this._slots.sizes[i+1]=sum-this._slots.sizes[i];
        this._slotApplySizes();
      };
      const up=()=>{
        document.removeEventListener('mousemove',move);
        document.removeEventListener('mouseup',up);
        this._slotsPersist();
        // 배분이 바뀌면 PTY 크기도 바뀐다 — 놓는 순간 한 번만 맞춘다.
        for(const p of this.tools.values()){ if(p.el.classList.contains('vis')) p.doFit() }
      };
      document.addEventListener('mousemove',move);
      document.addEventListener('mouseup',up);
    });
  },

  // 칸은 flex 아이템이다 (D-8) — 배분값만 준다. 방향은 `#area[data-slotdir]` 의
  // `flex-direction` 이 정하므로 여기서 축을 따질 일이 없다.
  _slotApplySizes(){
    if(!this._slots) return;
    for(let i=0;i<this._slots.windows.length;i++){
      const el=document.querySelector(`#area .slot[data-slot="${i}"]`);
      if(el) el.style.flex=`${this._slots.sizes[i]} 1 0`;
    }
  },
});

// 접근자는 `Object.assign` 으로 옮길 수 없다 — 그것은 getter 를 **평가해서 값으로**
// 복사하므로, 프로토타입에 상수가 박히고 인스턴스 상태를 영영 보지 못한다.
Object.defineProperties(App.prototype,{
  // FR-WSL-73: 슬롯 상태. 단일 슬롯 모드면 null 이다.
  slots:{
    get(){ return this._slots||null },
    configurable:true,
  },
  // FR-WSL-80~84: 칸이 놓이는 방향. 칸 배치(sessionStorage)와 달리 **기기별
  // 설정**이므로 localStorage 다 — 탭을 새로 열 때마다 기본값으로 돌아가면
  // 설정으로서 배신이다.
  slotDir:{
    get(){
      try{
        const v=localStorage.getItem(SLOT_DIR_KEY);
        if(v==='vertical'||v==='horizontal') return v;
      }catch{}
      return SLOT_DIR_DEFAULT;
    },
    set(v){
      const d=v==='vertical'?'vertical':'horizontal';
      try{localStorage.setItem(SLOT_DIR_KEY,d)}catch{}
      // FR-WSL-83: 열려 있는 칸은 즉시 재배치된다. 배분값은 방향과 무관하므로
      // 그대로 둔다. PTY 크기 맞추기는 render 의 rAF 가 doFit 으로 한다.
      this.render();
    },
    configurable:true,
  },
});
