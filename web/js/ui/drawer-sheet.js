/**
 * DrawerSheet — 모바일 서랍 (REFACTOR3_FE_BASE_SRS FR-FEB-25 · FC-02 · PANEL_TEMPLATE_SRS FR-PNT-11).
 *
 * 서랍은 모바일의 `#sidebar` 시트다. 열림의 기준은 `#sidebar.open` 이고, 종전에 따로 바뀌던 두 자리
 * — App 의 필드 `drawerOpen`(e2e·다른 파일이 읽는다, INV-F2)과 `body.drawer-open`(CSS 의 배경막) — 를 `mark` 한 자리에서 함께 바꾼다.
 *   이전: `_toggleDrawer`·`applyMobileMode`·`_drawerSheetSync` 가 세 자리를 각자 바꿨다
 *
 * 바뀐 뒤에는 하단 크롬(`mobileChromeSync`, MOBILE_UX_OVERHAUL_SRS FR-MUX-13)과 상단바(REFACTOR3_DEFECTS_SRS FR-RD3-80)를
 * 다시 그린다. 상단바는 렌더러의 것이라 생성자가 `opts.onChange` 로 받는다. `opts.tabs` 는 사이드바의 탭 줄이다.
 * Esc 로 닫힌다 — EscapeStack 버블 층이고 모바일에서만 살아 있다(REFACTOR3_FE_ESC_SRS FR-FEE-5).
 */
class DrawerSheet extends Panel {
  constructor(app,opts){
    super({rootId:'sidebar',escapable:true,phase:'bubble'});
    this.app=app;
    const o=opts||{};
    this._onChange=o.onChange||null;
    this.tabs=o.tabs||null;   // 서랍은 사이드바다 — 열면 그 탭 줄을 같은 길로 다시 잰다 (FR-FEB-26)
  }

  mark(e,v){
    super.mark(e,v);
    document.body.classList.toggle('drawer-open',v);
    this.app.drawerOpen=v;
  }

  active(){ return !!this.app.isMobile }

  onOpen(){ this.changed() }
  onClose(){ this.changed() }

  changed(){
    if(this.app.mobileChromeSync) this.app.mobileChromeSync();
    if(this._onChange) this._onChange();
  }
}
