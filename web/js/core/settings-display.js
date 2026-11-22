/**
 * DisplaySection — Settings ▸ Display (REFACTOR3_FE_SETTINGS_SRS 8a).
 *
 * 종전에는 이 탭의 배선이 세 파일에 흩어져 있었다 — `initModal` 의 `_init*` 여럿, `initMobile`(표시 모드·경계 폭),
 * `_initSlots`(슬롯 방향). 탭 하나의 배선이 한 자리에 있어야 "이 탭에서 무엇이 도는가" 가 보인다(D-FES-5).
 * 슬롯 방향은 슬롯 주제의 일이라 그 함수(`_slotDirPaint`)를 부르기만 한다.
 *
 * 값이 서버에 있는 행(탭 폭·글자 크기·전경 이름·떠날 때 확인)은 다른 표시 설정과 같은 근거다 — 기기를 옮겨도
 * 따라와야 하고, 브라우저 탭별 저장으로는 그것이 서지 않는다(FR-TBW-8 · FR-TAN-18 · FR-LVC-1 D-2).
 * 포커스·주의 가장자리 두 레인지 행(8b)은 미리보기·서로 칠하기가 얽혀 `FormRow` 로 맞추지 않고 섹션 메서드다(FR-FES-4).
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
      // REFACTOR3_FE_FIX_SRS FR-FFX-7: 탭 폭 행과 같은 포커스 가드.
      {key:'uiFontSize',id:'ds-uifs',kind:'number',guard:true},
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
    this._initFocusEdge();
    this._initAttnEdge();
  }

  /**
   * 행과 레인지 둘. FR-UFE-14: 레인지도 열 때마다 다시 칠한다 — 값 표시와 채움 비율이 함께 움직이므로 한 자리가
   * 셋을 맡는다. `_settingsApply` 뒤에도 여기서 칠한다(종전에는 set 이 칠했다).
   */
  paint(){
    super.paint();
    this._paintFocusEdgeRow();
    this._paintAttnEdgeRow();
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
      const ok=await this.app.settings.apply.saveSettings();
      if(ok&&uiLocale!==I18N.locale&&this.app.settings.apply._localeMirror(uiLocale)) location.reload();
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

  /**
   * UNFOCUSED_EDGE_SRS FR-UFE-10·11·16: `포커스 잃은 창 표시`.
   *
   * 손잡이가 하나다 (D-4a): 0 이 곧 끔이므로 스위치를 따로 두지 않는다.
   * 바꾼 값은 **그 자리에서** 화면에 닿는다 — 저장만 하고 다음 로드로 미루면
   * 사용자는 손잡이가 듣지 않는 것으로 읽는다 (`fgTabNames` 와 같은 이유).
   */
  _initFocusEdge(){
    const sl=document.getElementById('ds-focusedge');
    if(!sl) return;
    const app=this.app;
    sl.max=UFE_LEVEL_MAX;
    this._paintFocusEdgeRow();
    // FR-UFE-16: 움직이는 대로 화면이 따라야 고른 것을 볼 수 있다. 저장은 멎은
    // 뒤 한 번이다 — `tabWidthPx` 와 같은 근거(한 번의 드래그가 수십 번의 PUT).
    this.listen(sl,'input',()=>{
      focusEdgeLevel=Number(sl.value);
      this._paintFocusEdgeRow();
      this._paintAttnEdgeRow();
      app._paintFocusEdge();
      this._focusEdgePreview();
      app.settings.apply._saveSettingsSoon('ufe');
    });
    // 손을 떼는 순간이 값이 정해지는 순간이다 — 그때는 기다리지 않고 보낸다.
    // `tabWidthPx` 가 `blur` 에서 하는 것과 같은 자리다: 디바운스는 드래그 **중**의
    // PUT 폭주를 막으려는 것이지, 정해진 값을 늦추려는 것이 아니다.
    this.listen(sl,'change',()=>app.settings.apply._saveSettingsNow('ufe'));
  }

  /**
   * ALERT_MOBILE_CONTEXT_SRS FR-AED-8·10·12: 알림 가장자리의 세기.
   *
   * 손잡이도 규약도 포커스 표시와 같다 (FR-UFE-16 의 근거 그대로: 움직이는 대로
   * 화면이 따라야 고른 것을 볼 수 있고, 저장은 멎은 뒤 한 번이다). 다른 것은
   * **미리보기의 이유**다 — 저쪽은 창이 포커스를 가진 동안 보이지 않아서이고,
   * 이쪽은 알림이 없는 동안 보이지 않아서다.
   */
  _initAttnEdge(){
    const sl=document.getElementById('ds-attnedge');
    if(!sl) return;
    const app=this.app;
    sl.max=ATTN_EDGE_LEVEL_MAX;
    this._paintAttnEdgeRow();
    this.listen(sl,'input',()=>{
      attnEdgeLevel=Number(sl.value);
      this._paintAttnEdgeRow();
      app._paintAttnEdge();
      this._attnEdgePreview();
      // 세기를 0 으로 내리면 지금 켜져 있던 띠도 그 자리에서 꺼져야 한다.
      app.attn._attnRefresh();
      app.settings.apply._saveSettingsSoon('ae');
    });
    this.listen(sl,'change',()=>app.settings.apply._saveSettingsNow('ae'));
  }

  _paintFocusEdgeRow(){ this._paintRange('ds-focusedge',focusEdgeLevel,UFE_LEVEL_MAX) }

  _paintAttnEdgeRow(){ this._paintRange('ds-attnedge',attnEdgeLevel,ATTN_EDGE_LEVEL_MAX) }

  // FR-UFE-14·15 / FR-SCT-8 · FR-AED-11: 레인지와 그 값 표시, 채움 비율을 함께 되돌린다.
  // 0 은 숫자가 아니라 상태이므로 `끔` 이라 적는다 (SETTINGS_CONTROLS_SRS D-7).
  _paintRange(id,level,max){
    const sl=document.getElementById(id);
    const out=document.getElementById(id+'-val');
    if(!sl) return;
    sl.value=level;
    sl.style.setProperty('--fill',(level/max*100)+'%');
    if(out) out.textContent=level?String(level):UFE_LEVEL_OFF_LABEL;
  }

  /**
   * FR-UFE-18 / D-8d: 고르는 동안 보인다.
   *
   * 이 표시는 포커스를 잃었을 때만 뜨는데, 레인지를 만지는 동안 창은 **반드시**
   * 포커스를 가지고 있다. 미리보기가 없으면 사용자는 눈을 감고 값을 고른다.
   * 0 에서는 보여 줄 것이 없으므로 켜지 않는다. 타이머의 주인은 이 섹션이다.
   */
  _focusEdgePreview(){
    this._ufePreview=this._preview(this._ufePreview,focusEdgeLevel,UFE_PREVIEW_CLASS,UFE_PREVIEW_MS);
  }

  // FR-AED-12: 고르는 동안 보인다. 알림이 없어도 — 없을 때가 대부분이다.
  _attnEdgePreview(){
    this._aePreview=this._preview(this._aePreview,attnEdgeLevel,ATTN_EDGE_PREVIEW_CLASS,ATTN_EDGE_PREVIEW_MS);
  }

  /** 미리보기 클래스를 켜고 `ms` 뒤에 끈다. 앞의 타이머는 거둔다. 새 손잡이(없으면 null)를 돌려준다. */
  _preview(prev,level,cls,ms){
    const ds=document.documentElement;
    if(prev) prev.stop();
    if(!level){ds.classList.remove(cls);return null}
    ds.classList.add(cls);
    return this.after(ms,()=>ds.classList.remove(cls));
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
