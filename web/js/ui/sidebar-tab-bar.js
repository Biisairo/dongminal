/**
 * SidebarTabBar — 사이드바 상단 탭 줄 (REFACTOR3_FE_BASE_SRS FR-FEB-21 · GIT_SIDEBAR_TABS_SRS 묶음 T).
 *
 * 서술자는 `SB_TAB_DEFS`(sidebar-tabs.js)이고 고른 탭은 `app.sbTab` 이다 — e2e 와 렌더러가 그 이름을 읽는다(INV-F2).
 * 서술자의 훅은 `app` 을 인자로 받는다(`visible`·`badge`·`onEnter`·`onLeave`·`onActivate`).
 * `SidebarTabs`(sidebar-tabs.js)는 이 인스턴스에 맡기는 얇은 입구다.
 */
class SidebarTabBar extends TabBar {
  constructor(app){
    super({rootId:'sb-tabs',persistKey:SB_TAB_KEY});
    this.app=app;
  }

  /** FR-SBT-11: 탭이 보이게 할 패널 래퍼. 스크롤 자리는 그 안의 요소들에 적는다. */
  static panelOf(id){
    const d=SB_TAB_DEFS.find(x=>x.id===id);
    return d?document.getElementById(d.panelId):null;
  }

  defs(){ return SB_TAB_DEFS }
  isVisible(d){ return !d.visible||d.visible(this.app) }
  get current(){ return this.app.sbTab }
  set current(v){ this.app.sbTab=v }
  tabSel(id){ return '.sb-tab[data-panel="'+id+'"]' }
  scrollRoot(id){ return SidebarTabBar.panelOf(id) }
  /** ISSUE_TREE_CHAT_SRS FR-CAL-15: 서술자의 `attn(app)` 이 참이면 탭에 알람 표식(`attn`)을 세운다. */
  paintBadges(){
    super.paintBadges();
    for(const d of this.defs()){
      if(!d.attn) continue;
      const b=this.tabEl(d.id);
      if(b) b.classList.toggle('attn',!!d.attn(this.app));
    }
  }

  // FR-SBT-13: 0·null 이면 배지가 없다. UX_AUDIT_FIX_SRS FR-UXF-120 (D-41): 고른 탭에도 보인다 — 작업 패널과 같은 규칙이다.
  badgeFor(d){ return badgeOf(d.badge?d.badge(this.app):0) }

  paintPane(d,shown){
    const p=document.getElementById(d.panelId);
    if(p) p.hidden=!shown;
  }

  /**
   * SLOT_TITLE_BOUNDARY_SRS FR-STB-3: 창 타입의 **보이는 이름**. 라벨의 출처는 서술자 하나다 (D-5).
   * `visible` 을 거치지 않는다 — 라벨은 그 탭이 지금 보이는지와 무관하다.
   */
  labelForWindow(w){
    const a=this.app;
    // FR-RTU-1: Git 창과 Repo 창이 같은 탭에 속한다. 옛 Git 창은 마이그레이션 전까지 남는다(FR-RTU-70).
    const id=(a.git.isGitWin(w)||a.editor.isEditorWin(w))?REPO_TAB_ID:a.git.isChatWin(w)?CHAT_TAB_ID:'windows';
    const d=SB_TAB_DEFS.find(x=>x.id===id);
    return d?d.label:'';
  }

  buildTab(d){
    /**
     * UI_KIT_SRS FR-UIK-24: 탭을 만드는 자리는 하나다 (`UIKit.tab`). 기존 클래스(`sb-tab`·`sb-tab-icon`·`sb-tab-label`·
     * `sb-tab-badge`)는 **함께** 붙는다 — e2e 와 CSS 가 그 이름 위에 서 있다 (FR-UIK-10 / D-5).
     * SIDEBAR_COLLAPSE_SRS FR-SBC-13: 아이콘은 항상 DOM 에 있고 보임은 CSS 가 정한다. 서술자에 아이콘이 없으면 라벨의 첫 글자다.
     */
    const b=UIKit.tab({
      id:d.id,label:d.label,
      title:d.title,   // FR-TIP-1: 문자열은 탭 정의가 든다
      icon:d.icon,iconText:d.icon?null:(d.label||'?').charAt(0),
      // PANEL_TEMPLATE_SRS FR-PNT-6: 탭의 모양은 패널 템플릿(`ui-panel-tab`)이 정한다.
      cls:'sb-tab ui-panel-tab',iconCls:'sb-tab-icon',labelCls:'sb-tab-label',badgeCls:'sb-tab-badge',
    });
    // FR-SBC-17·18 (2026-09-06 개정): 레일에서의 클릭은 **전환만 한다** — 접어 둔 것은 접어 두려는 뜻이다.
    b.addEventListener('click',()=>this.select(d.id));
    return b;
  }

  /**
   * FR-SBT-22: 탭을 고르면 패널과 **콘텐츠 영역의 활성 창도 함께** 바뀐다. `silent` 는 역방향(창 → 탭, FR-SBT-14)의 것이다.
   * `sbBusy` 는 §3.9.2 의 재진입 가드다 — 탭 전환이 창을 바꾸고 그 창 변경이 다시 탭 동기화를 부르는 순환을 끊는다 (V-SBT-10).
   */
  select(id,opts){
    if(this.app.sbBusy) return false;
    return super.select(id,opts);
  }

  // FR-GOB-9: 패널이 화면에 온 사실은 `silent` 와 무관하다 — 창 쪽에서 따라온 전환도 "그 탭에 들어갔다" 이다.
  onLeave(prev){ if(prev&&prev.onLeave) prev.onLeave(this.app) }
  onEnter(next){ if(next.onEnter) next.onEnter(this.app) }

  onSelect(next,opts){
    if(opts&&opts.silent) return;
    if(!next.onActivate) return;
    const a=this.app;
    a.sbBusy=true;
    try{next.onActivate(a)}finally{a.sbBusy=false}
  }

  /**
   * FR-SBT-14: 창이 바뀌면 탭이 따라간다. 콘텐츠는 이미 그 창이므로 silent 다.
   * 일반 창 쪽은 **갈 창이 실제로 있을 때만** `repo` 탭에서 내려온다 — 없는데 내려보내면 FR-SBT-25 를 깬다 (V-SBT-25).
   */
  syncToWindow(){
    const a=this.app, w=a.tool.life.aw();
    // FR-EDT-8 + FR-RTU-1: Repo 창(과 남은 옛 Git 창)이 활성이면 탭도 `repo` 로 따라온다.
    if(a.git.isGitWin(w)||a.editor.isEditorWin(w)){this.select(REPO_TAB_ID,{silent:true});return}
    if(a.git.isChatWin(w)){this.select(CHAT_TAB_ID,{silent:true});return} // CHAT_WINDOW_SRS FR-CW-22
    if(a.sbTab===CHAT_TAB_ID){this.select('windows',{silent:true});return}
    if(a.sbTab===REPO_TAB_ID&&(a.editor.edWindows().length||a.git.gitWindow())) this.select('windows',{silent:true});
  }

  // UX_AUDIT_FIX_SRS FR-UXF-122 (D-41): 직행 키는 토글이다. 모바일(서랍)은 접기가 없어 고르기만 한다 (FR-SBC-20).
  //   이전: 토글이 아니어서 이미 그 탭이면 아무 일도 하지 않았다 (FR-SBT-27)
  canFold(){ return !this.app.isMobile }
  isFolded(){ return this.app.layout.tabOps.sidebarCollapsed() }
  setFolded(v){ this.app.layout.tabOps.setSidebarCollapsed(v) }
}
