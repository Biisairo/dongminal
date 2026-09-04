// 사이드바 상단 탭 — Windows / Git (GIT_SIDEBAR_TABS_SRS 묶음 T).
//
// 탭은 서술자의 배열로 정의된다 (FR-SBT-18/19). 배열 순서가 표시 순서이자 직행 키
// 번호이며, 새 탭을 더하는 비용은 서술자 1개다 (FR-SBT-21) — index.html·단축키 맵·
// 순회 디스패치를 다시 열지 않는다.
//
// 로드 순서 계약: helpers.js **뒤**(단축키 맵을 여기서 늘린다), renderer.js **앞**
// (렌더러가 활성 탭 상태를 읽는다).
//
// 서술자의 훅은 `app` 을 인자로 받는다. 배열이 **모듈 수준의 상수**여야 단축키
// 등록(아래)이 App 인스턴스보다 먼저 돌 수 있기 때문이다 — index.html 의 로드
// 순서상 이 파일은 app.js 보다 앞에 있다.

const SB_TAB_KEY='sidebarTab'; // FR-SBT-6: 보는 방식은 클라이언트의 것이다 (D-1)

/**
 * FR-SBT-19 의 서술자 계약.
 *
 *   id          안정 식별자. 영속(FR-SBT-6)·직행 키 라벨의 키
 *   label       탭 헤더에 보이는 이름
 *   panelId     이 탭이 보이게 할 패널 래퍼 id (§3.9.1)
 *   badge(app)  헤더 배지 값. 0·null 이면 표시하지 않는다 (FR-SBT-12/13)
 *   visible(app)탭 자체의 표시 여부 (FR-SBT-8)
 *   onActivate(app)     활성화 시의 콘텐츠 창 전환 (FR-SBT-22)
 *   onEnter(app)        탭이 보이게 된 직후. `silent` 여부와 **무관하게** 돈다
 *                       (FR-GOB-9) — 콘텐츠 전환이 아니라 "이제 이 패널이
 *                       화면에 있다" 는 사실에 딸린 일이 여기 온다
 *   cycle(app,dir)      순회 키가 이 탭에서 무엇을 순회하는지 (FR-SBT-31)
 *
 * 필드는 **창 목록이 실제로 하는 일**에서 뽑았다 — 쓰이지 않는 훅은 만들지 않는다.
 */
const SB_TAB_DEFS=[
  {
    id:'windows',label:'Windows',panelId:'sb-panel-windows',
    // FR-SBT-13: 알람이 있는 창 수. `.si.attn` 이 목록 안에서만 알리던 것을 탭까지 끌어올린다.
    badge:app=>app._plainWindows().filter(s=>app._windowHasAttn(s)).length,
    // FR-SBT-22·23: 마지막으로 활성이었던 일반 창. 대상 계산은 `_gitBackTarget`
    // 한 자리다 (FR-SBT-36).
    onActivate:app=>{const w=app._gitBackTarget();if(w)app.switchWindow(w.id)},
    // UX_REVISION_SRS FR-BLP-1~3: 목록의 서술자. 그리는 일도 순회도 SidebarList 가
    // 한다 — 이 탭이 주는 것은 **타깃뿐**이다.
    list:{
      containerId:'windows',
      // FR-BLP-6: 기존 클래스는 보존한다 — e2e 와 CSS 가 그 위에 서 있다.
      itemClass:'si',dotClass:'si-dot',nameClass:'si-name',xClass:'si-x',
      actions:['add-window','add-preset'],
      // FR-GIT-182: Git 창은 이 목록에 없다 — 진입점은 GIT 탭의 리포 항목뿐이다.
      items:app=>app._plainWindows(),
      key:s=>s.id,
      // FR-BLP-15~18: 순회. 규약은 블루프린트가 갖고, 여기는 타깃만 준다.
      cycle:{
        currentKey:app=>app.ws.activeWindow,
        open:(app,s)=>app.switchWindow(s.id),
      },
      // FR-MOV-1: 창 항목은 탭을 받는다. 지금 보고 있는 창은 받을 이유가 없다 —
      // 같은 창 안의 이동은 분할 칸의 탭 바가 이미 한다.
      tabDrop:{
        accepts:(app,r)=>r.key!==app.ws.activeWindow,
        drop:(app,r,dr)=>app._moveTabToWindow(dr.srcPaneId,dr.tabId,r.key),
      },
      row:(app,s)=>({
        name:s.name,
        active:s.id===app.ws.activeWindow,
        // FR-PAN-16: 알람이 있는 창을 사이드바에서 구분 표시.
        attn:app._windowHasAttn(s),
        // SANDBOX_WINDOW_SRS: 격리된 창임을 목록에서 구분한다. 어느 창이
        // 샌드박스인지 알 수 없으면 사용자가 격리를 신뢰할 근거가 없다.
        // SANDBOX_PICK_COPY_SRS FR-SPK-21·22: 작업 폴더가 복사본인 창은 그
        // 사실을 함께 적는다 — 컨테이너 안의 변경이 호스트로 돌아오지 않는다는
        // 것은 창을 여는 순간에만 말하고 끝낼 성질이 아니다. 폴더를 실제로 받은
        // 창에만 붙는다 (복사한 것이 없으면 뜻이 없다).
        badge:s.sandbox?{text:'▣ '+s.sandbox+(s.sandboxCopy?' · '+SANDBOX_COPY_BADGE:''),
          cls:'si-sbx',
          title:'샌드박스 창 — 이 창의 도구는 컨테이너 안에서 돕니다'
            +(s.sandboxCopy?String.fromCharCode(10)+SANDBOX_COPY_BADGE_TITLE:'')}:null,
        removable:true,
        dataset:{sid:s.id,windowType:s.type||WINDOW_TYPE_TERMINAL},
        onOpen:app=>app.switchWindow(s.id),
        onRemove:app=>app.delWindow(s.id),
        onRename:(app,el)=>app._rename(s,el),
      }),
      reorder:{
        type:'window',
        apply:(app,dr)=>{
          const arr=app.ws.windows;
          const si=arr.findIndex(x=>x.id===dr.src); if(si<0) return false;
          const[moved]=arr.splice(si,1);
          let ti=arr.findIndex(x=>x.id===dr.target);
          if(ti<0) arr.push(moved); else { if(!dr.before) ti++; arr.splice(ti,0,moved) }
          return true;
        },
        // 창 순서는 클라이언트가 workspace.json 에 쓴다 — 서버 확정이 없다.
        commit:app=>app._save(),
      },
    },
  },
  {
    /**
     * REPO_TAB_UNIFY_SRS FR-RTU-1: **`Git` 과 `Editor` 를 대신하는 하나의 탭.**
     *
     * 둘을 합치는 근거는 목록이 이미 같은 집합이라는 것이다 (§2.1) — `git.pinned`
     * 와 `editors.list` 는 서버 연동이 한 번의 저장 안에서 함께 바꾼다. 화면만
     * 둘로 그리고 있었고, 그래서 `+ Add` 한 번이 두 목록에 나타나는 것을 사용자가
     * 두 가지 일로 읽었다.
     *
     * 배열 순서가 곧 직행 키 번호이므로 이 탭은 `Ctrl+Shift+Digit2` 다.
     * `sidebarTab3` 은 파생이 사라지면서 함께 사라진다 (FR-RTU-7).
     */
    id:REPO_TAB_ID,label:REPO_TAB_LABEL,panelId:REPO_PANEL_ID,
    // FR-EDT-120: 목록의 원천은 `/api/editors` 다 — 그것이 없으면 행을 만들 수
    // 없다. **git 이 없는 것은 사유가 되지 않는다** (FR-RTU-9 / D-RTU-12):
    // 탐색기와 편집기는 git 없이 성립하고, 그때 Changes 사이드가 사유를 보인다.
    visible:app=>app._edOn(),
    // FR-RTU-6: 헤더 배지는 두지 않는다 — 근거 없는 숫자를 남기지 않는다는
    // FR-GOB-13 의 판단이 그대로다. 개수는 행마다 붙는다.
    // FR-EDT-7: 탭을 고르면 콘텐츠 창까지 바뀐다.
    onActivate:app=>{const w=app._edActivateTarget();if(w)app.switchWindow(w.id)},
    // FR-GOB-9: 들어간 순간 등록된 리포 전부를 관측한다. 다음 폴링(3초)을
    // 기다리면 사용자는 낡은 배지를 먼저 본다.
    onEnter:app=>{if(app._gitReposRefresh)app._gitReposRefresh()},
    list:{
      containerId:REPO_LIST_ID,
      // FR-EDT-14 / FR-NOT-10: 고정 항목(root·메모장)의 자리는 **패널 최하단**이다.
      fixedContainerId:REPO_ROOT_ID,
      itemClass:'ed-entry',dotClass:'ed-entry-dot',
      nameClass:'ed-entry-name',xClass:'ed-entry-x',badgeClass:'git-badge',
      actions:[REPO_ADD_ID],
      // 첫 응답 전에는 "없다" 를 말하지 않는다.
      ready:app=>!!app._editors,
      emptyText:REPO_ENTRIES_NONE,emptyClass:'ed-entries-none',
      items:app=>app._edEntries(),
      key:e=>'ed:'+e.path,
      fixed:app=>app._edFixed(),
      // FR-RTU-8: 순회 대상은 `items` 뒤에 `fixed` 를 이어 붙인 순서다 — 고정 행이
      // 마지막 자리로 **포함된다.** 제외하면 키만으로는 거기 갈 수 없다.
      cycle:{
        currentKey:app=>{
          const w=app._aw();
          return app._isEditorWin(w)?('ed:'+app._edRootOf(w)):null;
        },
        open:(app,e)=>app._edOpenWindow(e.path),
      },
      row:(app,e)=>{
        const w=app._edWindowFor(e.path);
        // FR-NOT-10: 고정 행 둘(`~`·메모장)은 지울 수 없고 재배치의 출발점도
        // 대상도 아니다. 가르는 것은 클래스뿐이며 CSS 가 그것을 딛는다.
        const pinned=!!e.root||!!e.notes;
        // FR-RTU-6: 변경 개수는 **git 쪽 관측**에서 온다. 두 목록이 같은 집합이므로
        // 경로로 짝지으면 되고, 저장소가 아닌 행에는 배지가 없다.
        const b=app._gitBadgeFor(e.path);
        const stale=!!b&&gitBadgeStale(b);
        return {
          // FR-EDT-10 / FR-NOT-9: 표시 이름은 경로의 마지막 조각, 툴팁은 절대경로.
          name:app._edName(e.path),
          title:e.path,
          active:!!w&&w.id===app.ws.activeWindow,
          cls:e.root?'ed-root':(e.notes?'ed-notes':''),
          // 배지는 서버의 마지막 관측값이다. 0 을 보일 이유는 없다 (FR-GIT-14).
          badge:(b&&b.total>0)?{
            text:String(b.total),
            cls:stale?'stale':'',
            title:stale?'최신 아님 (마지막 관측: '+new Date(b.observedAtUnixMs).toLocaleTimeString()+')':'',
          }:null,
          fixed:pinned,
          removable:!pinned,
          dataset:{edRoot:e.path,gitRepo:e.path},
          onOpen:app=>app._edOpenWindow(e.path),
          // FR-RTU-5 의 대칭: 제거도 하나다 — `/api/editors/remove` 가 연동으로
          // 핀까지 함께 지운다 (FR-EDT-34).
          onRemove:pinned?null:(app=>app._edRemove(e.path)),
        };
      },
      // FR-EDT-12·27: 순서는 서버가 권위다 — (src,target,before) 델타다.
      reorder:{
        type:'editor',
        apply:(app,dr)=>{
          const arr=(app._editors||{}).list;
          if(!Array.isArray(arr)) return false;
          const key=p=>'ed:'+p;
          const si=arr.findIndex(x=>key(x)===dr.src); if(si<0) return false;
          const[moved]=arr.splice(si,1);
          let ti=arr.findIndex(x=>key(x)===dr.target);
          if(ti<0) arr.push(moved); else { if(!dr.before) ti++; arr.splice(ti,0,moved) }
          app._edMirror();
          return true;
        },
        commit:(app,dr)=>app._edReorder(dr),
      },
    },
  },
];

/**
 * FR-SBT-26·28·30: 직행 키를 서술자 배열의 인덱스에서 파생시킨다.
 *
 * 니모닉 키(`G`=Git)라면 탭이 늘 때마다 키를 발명하고 충돌을 검사해야 한다. 번호는
 * 자동으로 나오므로 새 탭을 더할 때 단축키를 고민하지 않는다 (D-9·D-10).
 *
 * **네 자리를 함께 채운다** — 기본값 맵·라벨 맵·현재 바인딩·영속. 하나만 고치면
 * 설정 화면에서 사라진다. `shortcuts` 까지 여기서 채우는 이유는 helpers.js 가
 * 이 파일보다 먼저 로드되어 `{...SHORTCUT_DEFAULTS}` 를 이미 떠 갔기 때문이다.
 */
function sbTabAction(i){return 'sidebarTab'+(i+1)}
for(let i=0;i<SB_TAB_DEFS.length&&i<9;i++){
  const k=sbTabAction(i);
  SHORTCUT_DEFAULTS[k]='Ctrl+Shift+Digit'+(i+1);
  SHORTCUT_LABELS[k]='사이드바 탭: '+SB_TAB_DEFS[i].label;
  shortcuts[k]=SHORTCUT_DEFAULTS[k];
}
/**
 * REPO_TAB_UNIFY_SRS FR-RTU-7: **탭이 줄면 파생도 줄어야 한다.**
 *
 * 탭 셋이 둘이 되면서 `sidebarTab3` 이 갈 곳을 잃었다. 그런데 그 값은 사용자의
 * 설정 파일에 이미 저장돼 있을 수 있고(`settings.json` 의 `shortcuts`), 그대로
 * 두면 설정 화면에 **아무 데도 가지 않는 단축키**가 남는다 — 눌러도 아무 일이
 * 없는 항목은 고장으로 읽힌다.
 */
for(let i=SB_TAB_DEFS.length;i<9;i++){
  const k=sbTabAction(i);
  delete SHORTCUT_DEFAULTS[k];
  delete SHORTCUT_LABELS[k];
  delete shortcuts[k];
}

const SidebarTabs={
  // 등록된 서술자 중 지금 보이는 것들 (FR-SBT-19 `visible`).
  visible(app){return SB_TAB_DEFS.filter(d=>!d.visible||d.visible(app))},

  def(app,id){return this.visible(app).find(d=>d.id===id)||null},

  /**
   * SLOT_TITLE_BOUNDARY_SRS FR-STB-3: 창 타입의 **보이는 이름**.
   *
   * 제목이 부르는 이름과 사이드바 탭이 부르는 이름이 갈라지면 둘을 잇는 일이
   * 사용자 몫이 된다 (D-5). 그래서 라벨의 출처는 서술자 하나다.
   *
   * `visible` 을 거치지 않는다 — 라벨은 그 탭이 지금 보이는지와 무관하다.
   */
  labelForWindow(app,w){
    // FR-RTU-1: Git 창과 Repo 창이 같은 탭에 속한다. 옛 Git 창은 마이그레이션
    // 전까지 남으므로(FR-RTU-70) 그 라벨도 여기서 나온다.
    const id=(app._isGitWin(w)||app._isEditorWin(w))?REPO_TAB_ID:'windows';
    const d=SB_TAB_DEFS.find(x=>x.id===id);
    return d?d.label:'';
  },

  // FR-SBT-7: 보관된 값이 없거나 알 수 없는 값이면 첫 탭이다.
  restore(){
    let v=null;
    try{v=localStorage.getItem(SB_TAB_KEY)}catch{}
    return SB_TAB_DEFS.some(d=>d.id===v)?v:SB_TAB_DEFS[0].id;
  },

  /**
   * FR-SBT-22: 탭을 활성화하면 패널이 바뀌고 **콘텐츠 영역의 활성 창도 함께
   * 바뀐다.** 탭과 활성 창은 한 상태의 두 표현이다 (FR-SBT-15 개정, D-7).
   *
   * `silent` 는 역방향(창 → 탭, FR-SBT-14)의 것이다 — 콘텐츠가 이미 그 창이므로
   * 다시 옮길 이유가 없다. `_sbBusy` 는 §3.9.2 가 요구하는 **재진입 가드**다:
   * 탭 전환이 창을 바꾸고 그 창 변경이 다시 탭 동기화를 부르는 순환을 한 번에
   * 끊는다 (V-SBT-10).
   */
  setTab(app,id,opts){
    if(app._sbBusy) return;
    const d=this.def(app,id); if(!d||app._sbTab===id) return;
    this.saveScroll(app._sbTab);
    app._sbTab=id;
    try{localStorage.setItem(SB_TAB_KEY,id)}catch{}
    this.paint(app);
    this.restoreScroll(id);
    // FR-GOB-9: 패널이 화면에 온 사실은 `silent` 와 무관하다 — 창 쪽에서 따라온
    // 전환(FR-SBT-14)도 사용자에게는 똑같이 "그 탭에 들어갔다" 이다.
    if(d.onEnter) d.onEnter(app);
    if(opts&&opts.silent) return;
    if(!d.onActivate) return;
    app._sbBusy=true;
    try{d.onActivate(app)}finally{app._sbBusy=false}
  },

  /**
   * FR-SBT-14: 창이 바뀌면 탭이 따라간다. 콘텐츠는 이미 그 창이므로 silent 다.
   *
   * 일반 창 쪽에는 조건이 하나 붙는다 — **Git 창이 실제로 있을 때만** `Git` 탭에서
   * 내려온다. Git 창이 없는데 보관된 탭이 `git` 인 경우는 FR-SBT-25 가 허용한 상태이며
   * (탭만 전환, 콘텐츠 불변), 여기서 내려보내면 V-SBT-25 를 깬다.
   */
  syncToWindow(app){
    // FR-EDT-8 + FR-RTU-1: Repo 창(과 아직 남아 있는 옛 Git 창)이 활성이면 탭도
    // `repo` 로 따라온다. 재진입은 기존 `_sbBusy` 가드가 그대로 끊는다.
    const w=app._aw();
    if(app._isGitWin(w)||app._isEditorWin(w)){this.setTab(app,REPO_TAB_ID,{silent:true});return}
    // 그 반대는 **갈 창이 실제로 있을 때만** 한다 — 없는데 내려보내면 탭만
    // 전환된 상태(FR-SBT-25)를 깬다.
    if(app._sbTab===REPO_TAB_ID&&(app._edWindows().length||app._gitWindow()))
      this.setTab(app,'windows',{silent:true});
  },

  // FR-SBT-26·27·29: n 은 1-based 이며 **서술자 배열의 인덱스**다 — 숨은 탭이 있어도
  // 번호가 밀리지 않는다. 토글이 아니므로 이미 그 탭이면 아무 일도 하지 않는다.
  jumpTo(app,n){
    const d=SB_TAB_DEFS[n-1];
    if(!d||!this.def(app,d.id)||app._sbTab===d.id) return;
    this.setTab(app,d.id);
  },

  /**
   * 탭 바를 그린다. **버튼을 다시 만들지 않는다** (C-3) — 서술자마다 한 번 만들고
   * 이후로는 글자·클래스·배지만 고친다. 배열 전체로 한 번에 만들므로 나중에
   * 보이게 된 탭이 순서를 잃지 않는다.
   */
  paint(app){
    const bar=document.getElementById('sb-tabs'); if(!bar) return;
    if(!bar.childElementCount) for(const d of SB_TAB_DEFS) bar.appendChild(this.build(app,d));
    // 보관된 탭이 지금 보이지 않으면 첫 탭으로 떨어진다 (FR-SBT-8).
    const vis=this.visible(app);
    if(!vis.some(d=>d.id===app._sbTab)) app._sbTab=vis.length?vis[0].id:null;
    for(const d of SB_TAB_DEFS){
      const b=bar.querySelector('.sb-tab[data-panel="'+d.id+'"]');
      const on=vis.includes(d);
      if(b){
        b.hidden=!on;
        b.classList.toggle('active',on&&app._sbTab===d.id);
        b.setAttribute('aria-selected',on&&app._sbTab===d.id?'true':'false');
      }
      const p=document.getElementById(d.panelId);
      if(p) p.hidden=!(on&&app._sbTab===d.id);
    }
    this.updateBadges(app);
  },

  build(app,d){
    const b=document.createElement('button');
    b.className='sb-tab';b.dataset.panel=d.id;b.type='button';b.setAttribute('role','tab');
    const l=document.createElement('span');l.className='sb-tab-label';l.textContent=d.label;
    const g=document.createElement('span');g.className='sb-tab-badge';g.hidden=true;
    b.appendChild(l);b.appendChild(g);
    b.addEventListener('click',()=>this.setTab(app,d.id));
    return b;
  },

  // FR-SBT-12·13: 배지는 **비활성 탭에서만** 보인다. 0·null 이면 배지가 없다.
  updateBadges(app){
    const bar=document.getElementById('sb-tabs'); if(!bar) return;
    for(const d of SB_TAB_DEFS){
      const g=bar.querySelector('.sb-tab[data-panel="'+d.id+'"] .sb-tab-badge');
      if(!g) continue;
      const n=(d.badge&&app._sbTab!==d.id)?d.badge(app):0;
      g.hidden=!(n>0);
      if(n>0) g.textContent=String(n);
    }
  },

  /**
   * FR-SBT-11: 숨김이 display:none 이면 스크롤이 0 으로 돌아간다. 전환 전
   * scrollTop 을 요소에 적어 두고 다시 보일 때 복원한다 — 값을 요소에 두는 이유는
   * 패널마다 스크롤 컨테이너가 몇 개인지 서술자가 알 필요가 없기 때문이다.
   */
  panelOf(id){
    const d=SB_TAB_DEFS.find(x=>x.id===id);
    return d?document.getElementById(d.panelId):null;
  },
  saveScroll(id){
    const p=this.panelOf(id); if(!p) return;
    for(const el of p.querySelectorAll('*')) if(el.scrollTop) el.__sbTop=el.scrollTop;
  },
  restoreScroll(id){
    const p=this.panelOf(id); if(!p) return;
    for(const el of p.querySelectorAll('*')) if(el.__sbTop) el.scrollTop=el.__sbTop;
  },
};
