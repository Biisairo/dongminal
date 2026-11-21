/**
 * DisplaySection — Settings ▸ Display (REFACTOR3_FE_SETTINGS_SRS 8a).
 *
 * 종전에는 이 탭의 배선이 세 파일에 흩어져 있었다 — `initModal` 의 `_init*` 여럿, `initMobile`(표시 모드·경계 폭),
 * `_initSlots`(슬롯 방향). 탭 하나의 배선이 한 자리에 있어야 "이 탭에서 무엇이 도는가" 가 보인다(D-FES-5).
 * 슬롯 방향은 슬롯 주제의 일이라 그 함수(`_slotDirPaint`)를 부르기만 한다.
 *
 * 값이 서버에 있는 행(탭 폭·글자 크기·전경 이름·떠날 때 확인)은 다른 표시 설정과 같은 근거다 — 기기를 옮겨도
 * 따라와야 하고, 브라우저 탭별 저장으로는 그것이 서지 않는다(FR-TBW-8 · FR-TAN-18 · FR-LVC-1 D-2).
 * 포커스·주의 가장자리 두 행은 8b 에서 온다.
 */
class DisplaySection extends SettingsSection {
  constructor(app){ super(app,'display') }

  init(){
    applyTabWidth();
    this.bindRows([
      // TAB_WIDTH_SRS FR-TBW-1·2·10. 폭은 입력마다 얹되 저장은 미룬다 — 타이핑 한 글자마다 PUT 을 보내지 않는다.
      {key:'tabFixedWidth',id:'ds-tabfix',kind:'check'},
      {key:'tabWidthPx',id:'ds-tabw',kind:'number',guard:true},
      // FONT_SIZE_SETTING_SRS FR-FSS-1: 배율 하나가 CSS 토큰과 편집기 둘 다에 간다.
      {key:'uiFontSize',id:'ds-uifs',kind:'number'},
      // FR-TAN-19·20: 끄면 **즉시** 전 탭이 기본 이름으로 돌아간다 — 다시 칠하는 것은 set 이 한다.
      {key:'fgTabNames',id:'ds-fgnames',kind:'check'},
      // FR-LVC-1·10: 가드가 이 전역을 그때그때 읽으므로 리스너를 다시 걸 일이 없다.
      {key:'confirmLeave',id:'ds-confirmleave',kind:'check'},
    ]);
    this.paint();
    applyUiFontScale();
    this._initLocale();
    this._initPanelLayout();
    this._initDisplayMode();
    this._initSlotDir();
  }

  /** 열 때마다 현재 값을 다시 칠한다 — 표시 모드·경계 폭은 탭별 값, 슬롯 방향은 창의 값이라 행이 아니다. */
  onOpen(){
    const dsMode=document.getElementById('ds-mode');
    const dsBp=document.getElementById('ds-bp');
    if(dsMode) dsMode.value=this.app.displayMode;
    if(dsBp) dsBp.value=this.app.mobileBreakpoint;
    // FR-WSL-81: 슬롯 방향 세그먼트.
    this.app._slotDirPaint();
  }

  /**
   * M8_UNIFIED_SRS FR-B-4: `언어`. 저장이 끝난 뒤 페이지를 다시 연다 (D-B-1) — 저장 전에 열면 다음 부팅이
   * 옛 값을 읽는다.
   */
  _initLocale(){
    const sel=document.getElementById('ds-locale');
    if(!sel) return;
    sel.value=I18N.locale;
    this.listen(sel,'change',async()=>{
      uiLocale=I18N.resolve(sel.value);
      const ok=await this.app.saveSettings();
      if(ok&&uiLocale!==I18N.locale&&this.app._localeMirror(uiLocale)) location.reload();
    });
  }

  /** PANEL_LAYOUT_SRS FR-PLY-12·13: 「패널 레이아웃」 두 버튼. */
  _initPanelLayout(){
    const save=document.getElementById('ds-layout-save'), reset=document.getElementById('ds-layout-reset'),
      out=document.getElementById('ds-layout-status');
    if(!save||!reset||!out) return;
    const fail=t('settings.layout_failed');
    this.listen(save,'click',()=>{out.textContent=this.app.saveLayout()?t('settings.layout_saved'):fail});
    this.listen(reset,'click',()=>{out.textContent=this.app.resetLayout()?t('settings.layout_cleared'):fail});
  }

  /** 표시 모드와 모바일 경계 폭. 탭별(sessionStorage) 값이다 — 서버 블롭에 싣지 않는다. */
  _initDisplayMode(){
    const app=this.app;
    const dsMode=document.getElementById('ds-mode');
    const dsBp=document.getElementById('ds-bp');
    if(dsMode){
      dsMode.value=app.displayMode;
      this.listen(dsMode,'change',()=>{
        app.displayMode=dsMode.value;
        app.render();
      });
    }
    if(dsBp){
      dsBp.value=app.mobileBreakpoint;
      this.listen(dsBp,'change',()=>{
        let v=parseInt(dsBp.value,10);
        if(!(v>=320&&v<=2000)){v=768;dsBp.value=v}
        app.mobileBreakpoint=v;
        app.render();
      });
    }
  }

  // FR-WSL-81 / SETTINGS_CONTROLS_SRS FR-SCT-5: 값이 둘뿐이라 누를 때마다 뒤집는다.
  _initSlotDir(){
    const el=document.getElementById('ds-slotdir');
    if(!el) return;
    const app=this.app;
    const sw=el.querySelector('button');
    if(sw) this.listen(sw,'click',()=>{
      app.slotDir=app.slotDir==='vertical'?'horizontal':'vertical';
      app._slotDirPaint();
    });
    app._slotDirPaint();
  }
}
