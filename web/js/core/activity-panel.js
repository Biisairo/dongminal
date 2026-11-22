/**
 * ActivityPanel — 오른쪽 작업 패널 (REFACTOR3_FE_BASE_SRS FR-FEB-24 · UX_BATCH12_SRS FR-ACF-1·8).
 *
 * 열림은 `#agents-panel.open` 이고 뜻은 **펼침**이다. 데스크톱에서 닫힘은 레일이고(CSS 가 폭을 덮는다), 모바일에서는 숨는다.
 * 저장 값(`STORE_KEYS.agentsPanelOpen`)의 뜻도 같다. 손잡이(`#agents-handle`)는 표식을 따라간다.
 * 모바일 시트로는 Esc 로 닫힌다 — EscapeStack 버블 층이고 모바일에서만 살아 있다. 데스크톱에서는 닫히지 않는다(REFACTOR3_FE_ESC_SRS FR-FEE-5).
 * `AgentsController` 의 `setAgentsPanelOpen`·`agentsPanelOpen`·`agentsToggle` 과 `ActivityList.actPanelOpen` 이 이 인스턴스에 맡긴다 (INV-F2).
 */
class ActivityPanel extends Panel {
  constructor(app){
    super({rootId:'agents-panel',persistKey:STORE_KEYS.agentsPanelOpen,escapable:true,phase:'bubble',rail:true});
    this.app=app;
    this.tabs=new ActivityTabBar(app);
  }

  active(){ return !!this.app.isMobile }

  onOpen(){ this.changed(true) }
  onClose(){ this.changed(false) }

  changed(open){
    const a=this.app, h=document.getElementById('agents-handle');
    if(h) h.classList.toggle('open',open);
    if(a.mobile.sheets.mobileChromeSync) a.mobile.sheets.mobileChromeSync();   // MOBILE_UX_OVERHAUL_SRS FR-MUX-13
    for(const p of a.tools.values()) if(p.el.classList.contains('vis')) p.sizer.doFit();
    // ACTIVITY_RUNS_REFRESH_SRS FR-ARR-4: 핸들로 열어도 단축키로 열 때처럼 구역 목록을 다시 받는다.
    if(open) a.agents.list._actRefresh();
    a.agents.agentsRender();
  }

  /**
   * UIUX_OVERHAUL_SRS FR-ACT-3·4: 패널을 열고 그 구역으로 간다. 구역 없이 부르면 열고 닫는다.
   * UX_AUDIT_FIX_SRS FR-UXF-122 (D-41): 구역을 주면 직행 키의 토글이다 — 기준은 **지금 보고 있는 탭**이다.
   */
  show(key){
    if(!this.root()) return;
    if(!key){ this.toggle(); return }
    this.tabs.jump(this.tabs.defs().findIndex(d=>d.id===key)+1);
  }
}
