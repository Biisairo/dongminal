/**
 * Remote Terminal — 패널 좌우 도킹 (PANEL_DOCK_SRS).
 *
 * 앱 패널(사이드바·Activity)과 Repo 사이드의 자리를 읽고, 바꾸고, 화면에 싣는다.
 * 계산은 `panel-dock.js` 의 순수 함수가 하고, 드래그 배선은 `input-binding.js` 가 한다.
 */
Object.assign(App.prototype, {
  /**
   * 노드를 옮기지 않고 flex `order` 로 놓는다 — 옮기면 스크롤·포커스·진행 중인
   * 드래그를 잃는다. 모바일 제외(FR-PDK-15)는 CSS 의 `body:not(.mobile)` 가 맡는다.
   */
  panelDock(){return dockNormalize(PrefStore.session.json(STORE_KEYS.panelDock,null))},

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
  },

  // FR-PDK-14: 자리가 바뀌면 보이는 터미널의 폭이 바뀐다.
  _dockRefit(){
    for(const p of this.tools.values()) if(p.el.classList.contains('vis')) p.doFit();
  },

  applyPanelDock(){
    const s=this.panelDock(), o=dockOrders(s), de=document.documentElement, st=de.style;
    this._dockShown=s;
    st.setProperty('--dock-sb-ord',String(o.sidebar.panel));
    st.setProperty('--dock-sb-h-ord',String(o.sidebar.handle));
    st.setProperty('--dock-ag-ord',String(o.activity.panel));
    st.setProperty('--dock-ag-h-ord',String(o.activity.handle));
    de.dataset.sbSide=dockSideOf(s,'sidebar');
    de.dataset.agSide=dockSideOf(s,'activity');
    de.dataset.repoSide=this.repoSideDock();
  },

  repoSideDock(){return repoSideNormalize(PrefStore.session.get(STORE_KEYS.repoSideDock))},

  setRepoSideDock(v){
    const n=repoSideNormalize(v);
    if(n===document.documentElement.dataset.repoSide) return;   // FR-PDK-36 — 화면에 실린 값과 비교한다
    PrefStore.session.set(STORE_KEYS.repoSideDock,n);
    this.applyPanelDock();
    this._dockRefit();
  },

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
    const open=this.agentsPanelOpen(), collapsed=this.sidebarCollapsed();
    return {
      dock:this.panelDock(), repoSide:this.repoSideDock(),
      sidebarPx:px(SIDEBAR_W_KEY,'sidebar',!collapsed), sidebarCollapsed:collapsed,
      repoSidePx:this.edSideWidth(),
      activityPx:px(STORE_KEYS.agentsWidth,'agents-panel',open), activityOpen:open,
    };
  },

  /** FR-PLY-12: 저장. 새 탭이 이 배치로 시작한다. */
  saveLayout(){
    return PrefStore.local.setJson(PLY_KEYS.saved,layoutCapture(this._layoutState(),window.innerWidth));
  },

  /** FR-PLY-12: 기본값으로. 저장 레이아웃만 지운다 — 지금 탭의 화면은 그대로다. */
  resetLayout(){
    return PrefStore.local.remove(PLY_KEYS.saved);
  },

  /** FR-PLY-12·13: Settings ▸ Display 의 「패널 레이아웃」 두 버튼. */
  _initPanelLayout(){
    const save=document.getElementById('ds-layout-save'), reset=document.getElementById('ds-layout-reset'),
      out=document.getElementById('ds-layout-status');
    if(!save||!reset||!out) return;
    const fail=t('settings.layout_failed');
    save.addEventListener('click',()=>{out.textContent=this.saveLayout()?t('settings.layout_saved'):fail});
    reset.addEventListener('click',()=>{out.textContent=this.resetLayout()?t('settings.layout_cleared'):fail});
  },
});
