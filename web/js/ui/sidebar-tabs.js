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
 *   cycle(app,dir)      순회 키가 이 탭에서 무엇을 순회하는지 (FR-SBT-31)
 *
 * 필드는 **창 목록이 실제로 하는 일**에서 뽑았다 — 쓰이지 않는 훅은 만들지 않는다.
 */
const SB_TAB_DEFS=[
  {
    id:'windows',label:'Windows',panelId:'sb-panel-windows',
    // FR-SBT-13: 알람이 있는 창 수. `.si.attn` 이 목록 안에서만 알리던 것을 탭까지 끌어올린다.
    badge:app=>app._plainWindows().filter(s=>app._windowHasAttn(s)).length,
    // FR-SBT-22·23: 마지막으로 활성이었던 일반 창. 대상 계산은 `_gitBackTarget` 한
    // 자리다 — `_gitCloseWindow` 와 같은 것이므로 두 벌로 만들지 않는다 (FR-SBT-36).
    onActivate:app=>{const w=app._gitBackTarget();if(w)app.switchWindow(w.id)},
    cycle:(app,dir)=>app._cycleWindow(dir),
  },
  {
    id:'git',label:'Git',panelId:'sb-panel-git',
    // FR-SBT-8: git 이 없는 환경이면 탭 자체가 없다.
    visible:app=>!app._gitOff,
    // FR-SBT-12 (D-12): 변경사항이 있는 핀 리포의 **개수**다 (변경 파일 총합이 아니다).
    badge:app=>((app._gitRepos||{}).pinned||[]).filter(e=>e&&e.badge&&e.badge.total>0).length,
    // FR-SBT-25: Git 창이 없으면 만들지 않는다 — 창은 여전히 리포를 골라야 생긴다.
    onActivate:app=>{const w=app._gitWindow();if(w)app.switchWindow(w.id)},
    cycle:(app,dir)=>app._gitCycleRepo(dir),
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

const SidebarTabs={
  // 등록된 서술자 중 지금 보이는 것들 (FR-SBT-19 `visible`).
  visible(app){return SB_TAB_DEFS.filter(d=>!d.visible||d.visible(app))},

  def(app,id){return this.visible(app).find(d=>d.id===id)||null},

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
    if(app._isGitWin(app._aw())){this.setTab(app,'git',{silent:true});return}
    if(app._sbTab==='git'&&app._gitWindow()) this.setTab(app,'windows',{silent:true});
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
