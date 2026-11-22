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
 * App 은 이것을 `slot` 으로 든다(REFACTOR3_FE_APPCTL_SRS 9h, 옛 `app-slots.js` 의 앞쪽 — `slots` 는 접근자 이름이라
 * 쓸 수 없다). 여기는 상태·칸별 활성 탭·신원·영속이고, 조작은 부품 `SlotOps`(`slot-ops.js`) `.ops` 다.
 * 슬롯 상태 `_slots`·`_slotRenderPending` 은 App 에 남고 쓰기는 이 묶음만 한다(§2.2 A/9h).
 *
 * app.js 이후에 로드된다.
 */
const SLOT_KEY='slots';                  // FR-WSL-72
const SLOT_MAX=4;                        // FR-WSL-1, D-9
const SLOT_SIZE_DEFAULT=1;
const SLOT_MIN_PX=80;                    // 손잡이가 칸을 이보다 좁히지 않는다
const SLOT_DIR_KEY='slotDir';            // FR-WSL-82 (창별 — FR-UXB-1)
const SLOT_DIR_DEFAULT='horizontal';     // FR-WSL-80
// FR-SCT-4 / D-4a: 두 값의 이름(`Horizontal`·`Vertical`)은 **마크업**에 산다 —
// 바뀌지 않는 이름이고 화면의 자리도 고정이라 코드가 들고 있을 이유가 없다.
// FR-TIP-2: 툴팁은 지금 값이 무엇을 뜻하는지와, 누르면 무엇이 되는지를 함께 말한다.
const SLOT_DIR_TITLE={horizontal:'Split side by side — click to split top and bottom',
  vertical:'Split top and bottom — click to split side by side'};

class SlotsController extends Controller {
  constructor(app){
    super(app);
    this._slotIds=[];          // 칸별 clientId. [0] 은 app.clientId 를 쓴다 (FR-WSL-10)
    this._slotSse=[];          // 칸 1.. 의 소유권을 살려 두는 구독들 (FR-WSL-11)
    this.ops=new SlotOps(app);
  }

  // ── 상태 (FR-WSL-73) ──

  slotCount(){ return this.app._slots?this.app._slots.windows.length:1 }
  slotFocused(){ return this.app._slots?this.app._slots.focused:0 }

  // FR-WSL-75: 칸 0 의 키는 `toolId` **그대로**다. 단일 슬롯 모드의 Map 이 지금과
  // 한 글자도 다르지 않아야 D-4 가 Map 층에서도 성립한다.
  slotKey(id,slot){ return slot?`${id}@${slot}`:id }

  /**
   * 한 id 의 **모든 슬롯 키**를 칸 0 부터 차례로 준다
   * (SAFETY_CORRECTNESS_SRS FR-SAF-17).
   *
   * 손으로 적지 않는다. `SLOT_MAX` 가 2 에서 4 로 자랐을 때 상수를 도는 자리
   * (`_slotReap`·`_gitPanelReap`·`_slotSyncSubs`·`_slotCloseAllSubs`)는 따라왔고
   * 손으로 적은 자리 둘은 따라오지 못했다 — 그것이 이 함수가 생긴 이유다.
   */
  slotKeysOf(id){
    const out=[];
    for(let i=0;i<SLOT_MAX;i++) out.push(this.slotKey(id,i));
    return out;
  }

  /**
   * REPO_FIX 03 §3A-6: 탭 id 로 편집기를 찾는 **유일한 두 길**.
   *
   * 편집기 Map 의 키는 `slotKey(id,slot)` 인데 조회가 `tab.id` 로 하면 칸 0 만
   * 잡힌다 — 칸 1 이상에만 있는 편집기의 닫기 확인·이름변경 추적·줄 이동이 조용히
   * 빠졌다 (#5, N6). `fileEditors.get(` 을 이 둘 밖에서 쓰지 않는다
   * (scripts/check-editor-lookup.sh).
   *
   *   editorsOf  그 탭의 모든 칸 인스턴스 (경로 갱신·파괴)
   *   editorAny  포커스 칸 → 칸 0 → 나머지 순의 첫 인스턴스 (dirty·reveal·refresh — 문서 단위)
   */
  editorsOf(tabId){
    const out=[];
    if(!tabId) return out;
    for(const k of this.slotKeysOf(tabId)){
      const v=this.app.fileEditors.get(k);
      if(v) out.push(v);
    }
    return out;
  }

  editorAny(tabId){
    if(!tabId) return null;
    return this.app.fileEditors.get(this.slotKey(tabId,this.app.slotFocused()))||this.editorsOf(tabId)[0]||null;
  }

  // 그 탭의 모든 칸 편집기를 파괴하고 Map 에서 뺀다.
  editorsDrop(tabId){
    for(const k of this.slotKeysOf(tabId)){
      const v=this.app.fileEditors.get(k);
      if(v){v.destroy();this.app.fileEditors.delete(k)}
    }
  }

  // 복합키에서 슬롯 번호와 원래 id 를 되돌린다. `slotKey` 의 역이며 **자리는
  // 여기 하나다** — 렌더러의 편집기 회수가 자기 손으로 `@1` 만 잘라 내다가 칸
  // 2·3 의 편집기를 매 render 마다 파괴했다 (FR-SVS-60).
  _slotOf(k){
    const at=k.lastIndexOf('@');
    if(at<0) return 0;
    const i=parseInt(k.slice(at+1),10);
    return Number.isInteger(i)?i:0;
  }
  slotBase(k){
    const at=k.lastIndexOf('@');
    if(at<0) return k;
    return Number.isInteger(parseInt(k.slice(at+1),10))?k.slice(0,at):k;
  }

  // ── 칸별 활성 탭 (SLOT_VIEW_STATE_SRS FR-SVS-1~14) ──

  // 오버라이드 맵을 확보한다. 단일 슬롯 모드에서는 만들지 않는다 (FR-SVS-2) —
  // 그 상태에 맵이 있으면 `pn.activeTab` 이 진실이라는 규약이 흐려진다.
  _slotTabMap(i){
    if(!this.app._slots) return null;
    if(!Array.isArray(this.app._slots.tabs)) this.app._slots.tabs=this.app._slots.windows.map(()=>({}));
    while(this.app._slots.tabs.length<this.app._slots.windows.length) this.app._slots.tabs.push({});
    if(!this.app._slots.tabs[i]) this.app._slots.tabs[i]={};
    return this.app._slots.tabs[i];
  }

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
    const i=(slot==null)?this.app.slotFocused():slot;
    const m=this.app._slots&&Array.isArray(this.app._slots.tabs)?this.app._slots.tabs[i]:null;
    const tid=m&&m[pn.id];
    if(tid&&tabs.some(tab=>tab.id===tid)) return tid;
    if(pn.activeTab&&tabs.some(tab=>tab.id===pn.activeTab)) return pn.activeTab;
    return (tabs[0]&&tabs[0].id)||null;
  }

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
    const i=(slot==null)?this.app.slotFocused():slot;
    const m=this._slotTabMap(i);
    if(m){ m[pn.id]=tid; this._slotsPersist() }
    if(!this.app._slots||i===this.app.slotFocused()) pn.activeTab=tid;
    /**
     * M9_SRS FR-M9-24: **탭이 바뀐 사실은 여기서만 온전하다.**
     *
     * `setFocusState` 하나로 충분할 줄 알았으나 아니었다 — 탭을 **새로 만드는**
     * 길은 이미 포커스인 칸에 탭을 얹으므로 그 함수를 지나지 않는다 (실측:
     * `+` 로 탭을 둘 만들어도 기록이 0 이었다). 창·칸의 변화는 저쪽이, 탭의
     * 변화는 이쪽이 말한다. 둘 다 같은 `_navNote` 를 부르므로 판정은 한 벌이다.
     */
    this.app._navNote();
  }

  // FR-SVS-3: 칸이 창을 받으면 그 창의 pane 마다 **그 순간의 활성 탭**으로
  // 오버라이드를 채운다. 채우지 않으면 다른 칸이 탭을 바꿀 때 이 칸이 따라
  // 움직인다 — 오버라이드가 없는 pane 은 `pn.activeTab` 을 따르기 때문이다.
  _slotTabsSeed(i){
    if(!this.app._slots) return;
    const s=this.app.slotWindow(i);
    if(!s||!s.layout) return;
    const m=this._slotTabMap(i);
    for(const pn of this.app.flattenPanes(s.layout)){
      if(!m[pn.id]&&pn.activeTab) m[pn.id]=pn.activeTab;
    }
  }

  // FR-SVS-14 의 반대 방향: 포커스 칸이 바뀌면 그 칸의 시선이 워크스페이스의
  // 활성 탭이 된다. 포커스 이동만으로 탭이 바뀌는 것이 아니라, **워크스페이스가
  // 포커스 칸을 따라오는** 것이다.
  _slotTabsToWs(){
    if(!this.app._slots) return false;
    const s=this.app.slotWindow(this.app.slotFocused());
    if(!s||!s.layout) return false;
    const m=this.app._slots.tabs&&this.app._slots.tabs[this.app.slotFocused()];
    if(!m) return false;
    let changed=false;
    for(const pn of this.app.flattenPanes(s.layout)){
      const tid=m[pn.id];
      if(tid&&pn.activeTab!==tid&&(pn.tabs||[]).some(tab=>tab.id===tid)){pn.activeTab=tid;changed=true}
    }
    return changed;
  }

  // 칸 idx 에 있는 창. 단일 슬롯 모드면 활성 창이다.
  slotWindow(i){
    if(!this.app._slots) return i?null:this.app.tool.life.aw();
    const id=this.app._slots.windows[i];
    return id?(this.app.ws.windows.find(s=>s.id===id)||null):null;
  }

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
  windowVisible(id){
    if(!id) return false;
    if(!this.app._slots) return this.app.ws.activeWindow===id;
    return this.app._slots.windows.includes(id);
  }


  // ── 신원 (FR-WSL-10·11) ──

  // 칸 0 은 App.clientId 를 그대로 쓴다 — 단일 슬롯 모드에서 서버가 보는 신원이
  // 지금과 같아야 하기 때문이다. 신원은 **인덱스에 매인다**: 칸이 줄면 초과
  // 인덱스의 구독만 닫히고, 남은 칸들은 0..n-1 의 신원을 그대로 쓴다.
  _slotIdentity(i){
    if(!i) return this.app.clientId;
    if(!this._slotIds[i]) this._slotIds[i]=newUUID();
    return this._slotIds[i];
  }

  // 이 브라우저 창이 쓰는 신원 전부. `resizeCheck`·`applyFocusOverlay` 가
  // "내 것인가" 를 판정할 때 딛는다 (FR-WSL-13).
  _slotIdentities(){
    const n=this.slotCount();
    const out=[];
    for(let i=0;i<n;i++) out.push(this.app._slotIdentity(i));
    return out;
  }

  // FR-WSL-11: 칸 i(>0) 의 소유권은 그 신원의 SSE 구독이 살아 있는 동안만
  // 유지된다 (FR-XDF-9). 구독 없는 신원은 소유를 영원히 붙든다.
  //
  // 이 구독들은 메시지를 처리하지 않는다 — 워크스페이스 변경·알람·명령은 칸 0 의
  // 구독이 이미 받고 있고, 같은 브라우저 안에서 두 번 처리하면 그것이 결함이다.
  _slotSyncSubs(){
    const n=this.slotCount();
    for(let i=1;i<SLOT_MAX;i++){
      const want=i<n;
      // 채널은 버스가 연다 (INV-2). 메시지를 처리하지 않으므로 topic 도 없다 —
      // 여기서 여는 것 자체가 목적이다.
      // OPTIMIZE_REFACTOR_SRS FR-OPT-4-12: `presence=1` 이면 서버가 방송을 싣지 않는다.
      // 옛 서버는 파라미터를 모르고 전부 보내지만 이 채널은 처리하지 않는다.
      if(want&&!this._slotSse[i]){
        this._slotSse[i]=this.app.bus.openChannel('slot:'+i,
          '/api/commands/sse?presence=1&clientId='+encodeURIComponent(this.app._slotIdentity(i)),
          {owner:'slots'});
      }else if(!want&&this._slotSse[i]){
        this.app.bus.closeChannel('slot:'+i);
        this._slotSse[i]=null;
      }
    }
  }
  _slotCloseAllSubs(){
    for(let i=1;i<SLOT_MAX;i++){
      if(!this._slotSse[i]) continue;
      this.app.bus.closeChannel('slot:'+i);
      this._slotSse[i]=null;
    }
  }

  // ── 영속 (FR-WSL-2·72) ──

  _slotsPersist(){
    if(!this.app._slots){PrefStore.session.remove(SLOT_KEY);return}
    PrefStore.session.setJson(SLOT_KEY,this.app._slots);
  }

  // 형식이 어긋나면 키를 지우고 단일 슬롯 모드로 떨어진다 (FR-WSL-72). 창 id 가
  // 워크스페이스에 없으면 그 칸만 비운다 (FR-WSL-7).
  _slotsRestore(){
    if(!PrefStore.session.get(SLOT_KEY)) return;
    const v=PrefStore.session.json(SLOT_KEY,null);
    const n=v&&Array.isArray(v.windows)?v.windows.length:0;
    const ok=n>=2&&n<=SLOT_MAX&&Array.isArray(v.sizes)&&v.sizes.length===n
      &&Number.isInteger(v.focused)&&v.focused>=0&&v.focused<n;
    if(!ok){PrefStore.session.remove(SLOT_KEY);return}
    const has=id=>!!id&&this.app.ws.windows.some(s=>s.id===id);
    const windows=v.windows.map(id=>has(id)?id:null);
    const sizes=v.sizes.map(x=>(typeof x==='number'&&x>0)?x:SLOT_SIZE_DEFAULT);
    // FR-SVS-6·71: 오버라이드는 칸 배치와 같은 키에 산다. 형식이 어긋난 항목만
    // 빈 맵으로 떨어뜨린다 — 배치 전체를 버릴 이유는 아니다 (본 SRS 이전에 적힌
    // 키에는 `tabs` 가 없다).
    const tabs=windows.map((_,i)=>{
      const m=Array.isArray(v.tabs)?v.tabs[i]:null;
      return (m&&typeof m==='object'&&!Array.isArray(m))?Object.assign({},m):{};
    });
    this.app._slots={windows,sizes,tabs,focused:v.focused};
    this._slotFocusFallback();
    // FR-SVS-3: 복원된 맵에 없는 pane 은 지금의 활성 탭으로 채운다 — 본 SRS
    // 이전에 적힌 키에는 `tabs` 가 아예 없다.
    for(let i=0;i<this.app._slots.windows.length;i++) this._slotTabsSeed(i);
    const cur=this.app._slots.windows[this.app._slots.focused];
    if(cur) this.app._activateWindow(cur);
    this._slotSyncSubs();
  }

  // 포커스 칸이 비었으면 창이 있는 **가장 가까운** 칸으로 옮긴다 (FR-WSL-6).
  _slotFocusFallback(){
    if(!this.app._slots) return;
    const {windows}=this.app._slots;
    if(windows[this.app._slots.focused]) return;
    const f=this.app._slots.focused;
    for(let d=1;d<windows.length;d++){
      if(windows[f+d]){this.app._slots.focused=f+d;return}
      if(windows[f-d]){this.app._slots.focused=f-d;return}
    }
  }
}

// 렌더러·레이아웃·편집기·도구·포커스·동기화와 계약·시험이 App 에서 부르는 이름 (FR-FEA-4).
Controller.delegate(App,'slot',['slotCount','slotFocused','slotKey','slotKeysOf','editorsOf','editorAny','editorsDrop','_slotOf',
  'slotBase','paneTab','paneTabSet','_slotTabsToWs','slotWindow','windowVisible','_slotIdentity','_slotsRestore']);

// 접근자는 `Object.assign` 으로 옮길 수 없다 — 그것은 getter 를 **평가해서 값으로**
// 복사하므로, 프로토타입에 상수가 박히고 인스턴스 상태를 영영 보지 못한다.
Object.defineProperties(App.prototype,{
  // FR-WSL-73: 슬롯 상태. 단일 슬롯 모드면 null 이다.
  slots:{
    get(){ const app=this; return app._slots||null },
    configurable:true,
  },
  /**
   * FR-WSL-80~84 / UX_BATCH10_SRS FR-UXB-1~3: 칸이 놓이는 방향.
   *
   *   이전 동작: `localStorage` — "기기별 설정" 이라 그것이 맞다고 보았다
   *   새  동작: `sessionStorage` — 칸 배치(`_slots`)와 같은 칸이다
   *   이유:     같은 브라우저의 탭·PWA 창이 localStorage 를 공유하고, 이
   *             getter 는 **매 render 마다 다시 읽는다** (`renderer-layout.js`
   *             의 `data-slotdir`). 그래서 한 창에서 바꾼 방향이 다른 창의 다음
   *             렌더에 실렸다 — 사용자가 만지지도 않은 창의 배치가 돌아간다
   *
   * 새 창이 기본값으로 서는 것은 이 규약의 대가가 아니라 **뜻**이다 (D-UXB-1):
   * 창의 배치는 그 창에서 정한다.
   */
  slotDir:{
    get(){
      const v=PrefStore.session.get(SLOT_DIR_KEY);
      return (v==='vertical'||v==='horizontal')?v:SLOT_DIR_DEFAULT;
    },
    set(v){
      const app=this;
      const d=v==='vertical'?'vertical':'horizontal';
      PrefStore.session.set(SLOT_DIR_KEY,d);
      // FR-WSL-83: 열려 있는 칸은 즉시 재배치된다. 배분값은 방향과 무관하므로
      // 그대로 둔다. PTY 크기 맞추기는 render 의 rAF 가 doFit 으로 한다.
      app.render();
    },
    configurable:true,
  },
});
