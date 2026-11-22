/**
 * Remote Terminal — 패널 좌우 도킹 (PANEL_DOCK_SRS).
 *
 * 앱 패널(사이드바·Activity)과 Repo 사이드의 자리를 읽고, 바꾸고, 화면에 싣는다.
 * 계산은 `panel-dock.js` 의 순수 함수가 하고, 드래그 배선은 `input-binding.js` 가 한다.
 * `LayoutController` 의 부품 `.dock` 이다(REFACTOR3_FE_APPCTL_SRS 9i-2, 옛 `app-dock.js`). 화면에 실린 자리 `_dockShown` 은
 * 이 부품의 것이다(§2.2 SH-4).
 */
class LayoutDock extends Controller {
  /**
   * 노드를 옮기지 않고 flex `order` 로 놓는다 — 옮기면 스크롤·포커스·진행 중인
   * 드래그를 잃는다. 모바일 제외(FR-PDK-15)는 CSS 의 `body:not(.mobile)` 가 맡는다.
   */
  panelDock(){return dockNormalize(PrefStore.session.json(STORE_KEYS.panelDock,null))}

  /**
   * FR-PDK-36: 바뀐 것이 없으면 아무것도 하지 않는다. 비교 대상은 **화면에 실린 값**이다.
   *   이전: 저장소 값과 비교했다 — 다른 탭이 저장소를 먼저 바꾸면 이 탭에서 같은 배치로
   *         다시 바꿔도 화면에 실리지 않았다 (사용자 보고 2026-11-10)
   */
  setPanelDock(s){
    const n=dockNormalize(s);
    if(this._dockShown&&dockEqual(n,this._dockShown)) return;
    PrefStore.session.setJson(STORE_KEYS.panelDock,n);
    this.applyPanelDock();
    this._dockRefit();
    this.app.agentsRender();   // UX_BATCH13_SRS FR-ACB-5: 접기 아이콘이 자리를 따른다
  }

  // FR-PDK-14: 자리가 바뀌면 보이는 터미널의 폭이 바뀐다.
  _dockRefit(){
    for(const p of this.app.tools.values()) if(p.el.classList.contains('vis')) p.sizer.doFit();
  }

  applyPanelDock(){
    const s=this.app.panelDock(), o=dockOrders(s), de=document.documentElement, st=de.style;
    this._dockShown=s;
    st.setProperty('--dock-sb-ord',String(o.sidebar.panel));
    st.setProperty('--dock-sb-h-ord',String(o.sidebar.handle));
    st.setProperty('--dock-ag-ord',String(o.activity.panel));
    st.setProperty('--dock-ag-h-ord',String(o.activity.handle));
    de.dataset.sbSide=dockSideOf(s,'sidebar');
    de.dataset.agSide=dockSideOf(s,'activity');
    de.dataset.repoSide=this.app.repoSideDock();
    this.app.sbCollapsePaint();
  }

  /**
   * UX_AUDIT_FIX_SRS FR-UXF-30: 메인 패널 머리의 접기 단추 — 작업 패널의 `.ag-collapse` 와 같은 규칙이다(아이콘은
   * `agCollapseIcon`). 처음 필요할 때 끝 단추 자리(`#sb-acts`)에 세우고, 접힘·좌우가 바뀌면 칠한다. 모바일은 CSS 가 감춘다.
   */
  sbCollapsePaint(){
    const acts=document.getElementById('sb-acts');
    if(!acts) return;
    let b=acts.querySelector('.sb-collapse');
    if(!b){
      // 킷은 이름 없는 단추를 거절한다(던진다) — 부팅 경로이므로 처음부터 이름을 준다.
      // UX_AUDIT_FIX_SRS D-38: 작업 패널의 접기(`ag-collapse`)와 같은 크기다 — 다르면 레일 맨 위에서 두 레일의 탭 선이 어긋난다.
      // QUALITY_FIX_SRS FR-QFX-3: 둘 다 큰 단추(30px)다 — 사이드바 단추의 하한(GIT_UI_REVISION FR-GIT-226).
      //   이전: 표준(26px) — D-38 이 작은 쪽에 맞추며 하한을 깼다
      b=UIKit.button({icon:'chevron-left',title:TIP_PANEL_COLLAPSE,kind:'ghost',size:'lg',cls:'sb-collapse ui-panel-act-desktop',onClick:e=>{e.stopPropagation();this.app._toggleSidebar()}});
      acts.prepend(b);
    }
    const open=!this.app.sidebarCollapsed();
    const tip=open?TIP_PANEL_COLLAPSE:TIP_PANEL_EXPAND;
    b.title=tip; b.setAttribute('aria-label',tip);
    b.replaceChildren(UIKit.icon(agCollapseIcon(open,document.documentElement.dataset.sbSide||'left',false)));
  }

  repoSideDock(){return repoSideNormalize(PrefStore.session.get(STORE_KEYS.repoSideDock))}

  setRepoSideDock(v){
    const n=repoSideNormalize(v);
    if(n===document.documentElement.dataset.repoSide) return;   // FR-PDK-36 — 화면에 실린 값과 비교한다
    PrefStore.session.set(STORE_KEYS.repoSideDock,n);
    this.applyPanelDock();
    this._dockRefit();
  }

  /**
   * PANEL_LAYOUT_SRS FR-PLY-11: 지금 탭의 배치. 폭은 저장된 탭 값을 먼저, 없으면 화면에
   * 보이는 패널의 실제 폭을 쓴다. 둘 다 없으면(접혀 있고 바꾼 적 없음) 비율을 빼고 기본값이 된다.
   */
  _layoutState(){
    const px=(key,id,shown)=>{
      const v=parseInt(PrefStore.session.get(key),10);
      if(Number.isFinite(v)) return v;
      const el=document.getElementById(id);
      return el&&shown?el.getBoundingClientRect().width:NaN;
    };
    const open=this.app.agentsPanelOpen(), collapsed=this.app.sidebarCollapsed();
    return {
      dock:this.app.panelDock(), repoSide:this.app.repoSideDock(),
      sidebarPx:px(SIDEBAR_W_KEY,'sidebar',!collapsed), sidebarCollapsed:collapsed,
      repoSidePx:this.app.edSideWidth(),
      activityPx:px(STORE_KEYS.agentsWidth,'agents-panel',open), activityOpen:open,
    };
  }

  /** FR-PLY-12: 저장. 새 탭이 이 배치로 시작한다. */
  saveLayout(){
    return PrefStore.local.setJson(PLY_KEYS.saved,layoutCapture(this._layoutState(),window.innerWidth));
  }

  /** FR-PLY-12: 기본값으로. 저장 레이아웃만 지운다 — 지금 탭의 화면은 그대로다. */
  resetLayout(){
    return PrefStore.local.remove(PLY_KEYS.saved);
  }
}

// 바깥이 부르는 이름 — 부팅·설정·`ui/`(드래그 배선)·사이드바 접기(`layout-tab-ops.js`)·e2e·계약.
Controller.delegate(App,'layout.dock',['panelDock','setPanelDock','applyPanelDock','sbCollapsePaint','repoSideDock',
  'setRepoSideDock','saveLayout','resetLayout']);
