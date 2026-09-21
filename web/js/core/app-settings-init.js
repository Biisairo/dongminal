/**
 * Dongminal — 개별 설정의 **초기화와 즉시 반영** (FE_MODULE_BOUNDARY_SRS FR-FMB-10).
 *
 * 설정 하나하나가 화면에 붙는 자리다 — 탭 제목 · 탭 폭 · 전경 탭 이름 · 브라우저
 * 키 · 이탈 확인 · 포커스/주의 가장자리 · 줄바꿈. 저마다 `_init*` 하나로 리스너를
 * 걸고, 값이 바뀌면 그 자리에서 화면까지 따라간다.
 *
 * **모달과 갈린 이유**: 이 메서드들은 설정창이 없어도 돈다 (부팅이 부른다).
 * 모달은 그것들을 **보여주는** 표면일 뿐이다.
 */
Object.assign(App.prototype, {
  /**
   * PAGE_TITLE_SRS FR-PGT-8: `document.title` 을 쓰는 유일한 자리.
   *
   * 주의 배지(FR-PAN-13b)가 제목 전체를 다시 쓰므로, 설정값을 다른 곳에서
   * 넣으면 다음 `_attnRefresh` 에 지워진다. 합성은 여기 하나뿐이어야 한다.
   */
  _applyPageTitle(){
    const n=this._attn?this._attn.size:0;
    document.title=(n?'('+n+') ':'')+effectiveTitle();
  },

  // FR-PGT-1: Settings ▸ Display 의 `페이지 제목`.
  _initPageTitle(){
    const el=document.getElementById('ds-title');
    if(!el) return;
    el.value=pageTitle;
    el.addEventListener('input',()=>{
      pageTitle=el.value;
      // FR-PGT-9: 저장을 기다리지 않고 지금 값이 탭에서 어떻게 보이는지 보인다.
      this._applyPageTitle();
      // FR-PGT-5: 글자마다 PUT 을 보내지 않는다.
      TIMERS.cancel(this._titleSaveTimer);
      this._titleSaveTimer=this.timers.after(500,()=>this.saveSettings(),{owner:'app',label:'save-title'});
    });
  },

  /**
   * TAB_WIDTH_SRS FR-TBW-1·2·10: Settings ▸ Display 의 `탭 너비 고정`과 그 폭.
   *
   * 값이 서버에 있는 이유는 다른 표시 설정과 같다 (FR-TBW-8) — 기기를 옮겨도
   * 따라와야 하고, 브라우저 탭별 저장으로는 그것이 서지 않는다.
   *
   * 폭 입력은 `input` 마다 적용하되 저장은 미룬다 — 타이핑 한 글자마다 PUT 을
   * 보내면 요청이 글자 수만큼 난다 (`ds-title` 과 같은 규약).
   */
  _initTabWidth(){
    const cb=document.getElementById('ds-tabfix');
    const num=document.getElementById('ds-tabw');
    if(!cb||!num) return;
    cb.checked=tabFixedWidth;
    num.value=String(tabWidthPx);
    applyTabWidth();
    cb.addEventListener('change',()=>{
      tabFixedWidth=cb.checked;
      applyTabWidth();
      this.saveSettings();
    });
    num.addEventListener('input',()=>{
      // FR-TBW-4: 자르는 것은 적용하는 값뿐이다 — 입력란의 글자를 그때그때
      // 고쳐 쓰면 타이핑이 튄다 (`160` 을 지우고 `9` 를 치는 순간 `40` 이 된다).
      tabWidthPx=clampTabWidth(num.value);
      applyTabWidth();
      TIMERS.cancel(this._tabwSaveTimer);
      this._tabwSaveTimer=this.timers.after(500,()=>this.saveSettings(),{owner:'app',label:'save-tabw'});
    });
    /**
     * 포커스를 놓을 때 두 가지를 한다.
     *
     * ① 입력란을 실제로 쓰이는 값과 맞춘다 — 잘린 사실이 보여야 사용자가 왜 그
     *    폭인지 안다 (FR-TBW-4).
     * ② **곧바로 저장한다.** 디바운스는 타이핑 중 요청이 글자 수만큼 나는 것을
     *    막는 장치이지 확정을 미루는 장치가 아니다 — 값을 바꾸고 바로 새로고침하면
     *    500ms 가 지나지 않아 **입력이 통째로 날아갔다** (실측, W7). 포커스를
     *    놓는 순간이 곧 확정이므로 그때 미룰 이유가 없다.
     */
    num.addEventListener('blur',()=>{
      num.value=String(tabWidthPx);
      TIMERS.cancel(this._tabwSaveTimer);
      this.saveSettings();
    });
  },

  // FR-TAN-19: Settings ▸ Display 의 `프로세스 이름을 탭 이름으로`. 기본은 켬.
  //
  // 값이 서버에 있는 이유는 FR-TAN-18 이다 — `dmctl list-workspace` 가 화면과
  // 같은 이름을 내려면 표시 규칙에 진실이 하나여야 하고, 브라우저 탭별 저장
  // (displayMode 가 쓰는 sessionStorage)으로는 그것이 서지 않는다.
  _initFgNames(){
    const cb=document.getElementById('ds-fgnames');
    if(!cb) return;
    cb.checked=fgTabNames;
    cb.addEventListener('change',()=>{
      fgTabNames=cb.checked;
      // FR-TAN-20: 끄면 **즉시** 전 탭이 기본 이름(또는 수동 이름)으로 돌아간다.
      // 켜면 이미 들고 있는 파생 이름이 그대로 다시 보인다 — 다음 조회를
      // 기다릴 필요가 없다.
      this._fgRepaint();
      this.saveSettings();
    });
  },

  /**
   * AGENT_RENDER_ENV_SRS FR-ARE-3: Settings ▸ Terminal 의 `Claude Code 를
   * fullscreen 으로 띄우기`.
   *
   * 값이 서버에 사는 이유는 `blockBrowserKeys` 와 같다 — **쓰는 주체가 서버**이고
   * (도구를 띄울 때 환경에 넣는다) 정하는 자리만 화면이다.
   */
  _initClaudeFullscreen(){
    const cb=document.getElementById('ds-claudefs');
    if(!cb) return;
    cb.checked=claudeFullscreen;
    cb.addEventListener('change',()=>{
      claudeFullscreen=cb.checked;
      this.saveSettings();
    });
  },

  /**
   * FR-KEY-6: Settings ▸ Shortcuts 의 `브라우저 기본 단축키 차단`.
   *
   * 값이 서버에 있는 이유는 `fgTabNames` 와 같다 — 단축키 자체가 서버 설정이고,
   * 그 단축키가 실제로 먹히는지를 정하는 스위치가 다른 곳에 살면 두 값이
   * 브라우저마다 어긋난다.
   */
  _initBlockKeys(){
    const cb=document.getElementById('sc-blockbrowser');
    if(!cb) return;
    cb.checked=blockBrowserKeys;
    cb.addEventListener('change',()=>{
      blockBrowserKeys=cb.checked;
      this.saveSettings();
    });
  },

  /**
   * FR-LVC-1·10: Settings ▸ Display 의 `떠날 때 확인`.
   *
   * 값이 서버에 있는 이유는 `blockBrowserKeys` 와 같다 (D-2). 자리가 Display 인
   * 이유는 D-3 이다 — 저쪽은 **키**를 다루고 이쪽은 떠남의 동작이다.
   *
   * 가드가 이 전역을 그때그때 읽으므로 리스너를 다시 걸 일이 없다 (FR-LVC-10).
   */
  /**
   * M8_UNIFIED_SRS FR-B-4: Settings ▸ Display 의 `언어`. 저장이 끝난 뒤 페이지를
   * 다시 연다 (D-B-1) — 저장 전에 열면 다음 부팅이 옛 값을 읽는다.
   */
  _initLocale(){
    const sel=document.getElementById('ds-locale');
    if(!sel) return;
    sel.value=I18N.locale;
    sel.addEventListener('change',async()=>{
      uiLocale=I18N.resolve(sel.value);
      const ok=await this.saveSettings();
      if(ok&&uiLocale!==I18N.locale&&this._localeMirror(uiLocale)) location.reload();
    });
  },

  /** 거울을 쓴다. 되읽어 같아야 참이다 — 사생활 모드에서는 거짓이다. */
  _localeMirror(v){
    try{localStorage.setItem(I18N_STORAGE_KEY,v);return localStorage.getItem(I18N_STORAGE_KEY)===v}catch{return false}
  },

  _initConfirmLeave(){
    const cb=document.getElementById('ds-confirmleave');
    if(!cb) return;
    cb.checked=confirmLeave;
    cb.addEventListener('change',()=>{
      confirmLeave=cb.checked;
      this.saveSettings();
    });
  },

  /**
   * UNFOCUSED_EDGE_SRS FR-UFE-10·11: Settings ▸ Display 의 `포커스 잃은 창 표시`.
   *
   * 바꾼 값은 **그 자리에서** 화면에 닿는다 (`_paintFocusEdge`). 저장만 하고
   * 다음 로드로 미루면 사용자는 스위치가 듣지 않는 것으로 읽는다 —
   * `fgTabNames` 가 `_fgRepaint` 를 부르는 것과 같은 이유다.
   */
  /**
   * UNFOCUSED_EDGE_SRS FR-UFE-10·11·16: Settings ▸ Display 의 `포커스 잃은 창 표시`.
   *
   * 손잡이가 하나다 (D-4a): 0 이 곧 끔이므로 스위치를 따로 두지 않는다.
   * 바꾼 값은 **그 자리에서** 화면에 닿는다 — 저장만 하고 다음 로드로 미루면
   * 사용자는 손잡이가 듣지 않는 것으로 읽는다 (`fgTabNames` 와 같은 이유).
   */
  _initFocusEdge(){
    const sl=document.getElementById('ds-focusedge');
    if(!sl) return;
    sl.max=UFE_LEVEL_MAX;
    this._focusEdgePaintRow();
    // FR-UFE-16: 움직이는 대로 화면이 따라야 고른 것을 볼 수 있다. 저장은 멎은
    // 뒤 한 번이다 — `tabWidthPx` 와 같은 근거(한 번의 드래그가 수십 번의 PUT).
    sl.addEventListener('input',()=>{
      focusEdgeLevel=Number(sl.value);
      this._focusEdgePaintRow();
      this._attnEdgePaintRow();
      this._paintFocusEdge();
      this._focusEdgePreview();
      TIMERS.cancel(this._ufeSaveTimer);
      this._ufeSaveTimer=this.timers.after(500,()=>this.saveSettings(),{owner:'app',label:'save-ufe'});
    });
    // 손을 떼는 순간이 값이 정해지는 순간이다 — 그때는 기다리지 않고 보낸다.
    // `tabWidthPx` 가 `blur` 에서 하는 것과 같은 자리다: 디바운스는 드래그 **중**의
    // PUT 폭주를 막으려는 것이지, 정해진 값을 늦추려는 것이 아니다.
    sl.addEventListener('change',()=>{
      TIMERS.cancel(this._ufeSaveTimer);
      this.saveSettings();
    });
  },

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
    sl.max=ATTN_EDGE_LEVEL_MAX;
    this._attnEdgePaintRow();
    sl.addEventListener('input',()=>{
      attnEdgeLevel=Number(sl.value);
      this._attnEdgePaintRow();
      this._paintAttnEdge();
      this._attnEdgePreview();
      // 세기를 0 으로 내리면 지금 켜져 있던 띠도 그 자리에서 꺼져야 한다.
      this._attnRefresh();
      TIMERS.cancel(this._aeSaveTimer);
      this._aeSaveTimer=this.timers.after(500,()=>this.saveSettings(),{owner:'app',label:'save-ae'});
    });
    sl.addEventListener('change',()=>{
      TIMERS.cancel(this._aeSaveTimer);
      this.saveSettings();
    });
  },

  // FR-AED-11: 0 은 숫자가 아니라 상태다 — `끔` 이라 적는다.
  _attnEdgePaintRow(){
    const sl=document.getElementById('ds-attnedge');
    const out=document.getElementById('ds-attnedge-val');
    if(!sl) return;
    sl.value=attnEdgeLevel;
    sl.style.setProperty('--fill',(attnEdgeLevel/ATTN_EDGE_LEVEL_MAX*100)+'%');
    if(out) out.textContent=attnEdgeLevel?String(attnEdgeLevel):UFE_LEVEL_OFF_LABEL;
  },

  // FR-AED-12: 고르는 동안 보인다. 알림이 없어도 — 없을 때가 대부분이다.
  _attnEdgePreview(){
    const ds=document.documentElement;
    TIMERS.cancel(this._aePreviewTimer);
    if(!attnEdgeLevel){ds.classList.remove(ATTN_EDGE_PREVIEW_CLASS);return}
    ds.classList.add(ATTN_EDGE_PREVIEW_CLASS);
    this._aePreviewTimer=this.timers.after(ATTN_EDGE_PREVIEW_MS,
      ()=>ds.classList.remove(ATTN_EDGE_PREVIEW_CLASS),{owner:'app',label:'ae-preview'});
  },

  // FR-UFE-14·15 / FR-SCT-8: 레인지와 그 값 표시, 채움 비율을 함께 되돌린다.
  // 0 은 숫자가 아니라 상태이므로 `끔` 이라 적는다 (SETTINGS_CONTROLS_SRS D-7).
  _focusEdgePaintRow(){
    const sl=document.getElementById('ds-focusedge');
    const out=document.getElementById('ds-focusedge-val');
    if(!sl) return;
    sl.value=focusEdgeLevel;
    sl.style.setProperty('--fill',(focusEdgeLevel/UFE_LEVEL_MAX*100)+'%');
    if(out) out.textContent=focusEdgeLevel?String(focusEdgeLevel):UFE_LEVEL_OFF_LABEL;
  },

  /**
   * FR-UFE-18 / D-8d: 고르는 동안 보인다.
   *
   * 이 표시는 포커스를 잃었을 때만 뜨는데, 레인지를 만지는 동안 창은 **반드시**
   * 포커스를 가지고 있다. 미리보기가 없으면 사용자는 눈을 감고 값을 고른다.
   * 0 에서는 보여 줄 것이 없으므로 켜지 않는다.
   */
  _focusEdgePreview(){
    const ds=document.documentElement;
    TIMERS.cancel(this._ufePreviewTimer);
    if(!focusEdgeLevel){ds.classList.remove(UFE_PREVIEW_CLASS);return}
    ds.classList.add(UFE_PREVIEW_CLASS);
    this._ufePreviewTimer=this.timers.after(UFE_PREVIEW_MS,()=>ds.classList.remove(UFE_PREVIEW_CLASS),{owner:'app',label:'ufe-preview'});
  },

  /**
   * WORKBENCH_REVIEW_SRS FR-WBR-10·11: Settings ▸ Code 의 `줄 바꿈`.
   *
   * **이미 열려 있는 편집기에도 곧바로 반영한다** — 새로 여는 탭부터 듣게 하면
   * 사용자는 설정이 고장난 것으로 읽는다. 옵션 갱신이지 편집기 재생성이 아니므로
   * 편집 중인 내용과 커서를 잃지 않는다 (NFR-WBR-1).
   */
  _initWordWrap(){
    const cb=document.getElementById('ds-wordwrap');
    if(!cb) return;
    cb.checked=editorWordWrap;
    cb.addEventListener('change',()=>{
      editorWordWrap=cb.checked;
      this._edApplyWordWrap();
      this.saveSettings();
    });
  },

  /**
   * 열려 있는 편집기 전부에 지금 값을 얹는다.
   *
   * 살아 있는 인스턴스의 목록은 `app.fileEditors` 다 (`renderer.js:533` 이 만들고
   * `app-layout.js:428` 이 거둔다). `monaco.editor.getEditors()` 를 쓰지 않는
   * 이유는 그것이 **diff 뷰 안의 편집기까지** 주기 때문이다 — 그쪽은 비목표다.
   */
  _edApplyWordWrap(){
    if(!this.fileEditors) return;
    for(const ed of this.fileEditors.values()) if(ed&&ed.applyWordWrap) ed.applyWordWrap();
    // FR-UXB-40·41: diff 도 같은 설정을 딛는다 — 편집기만 따라가면 두 표면이
    // 서로 다른 글자로 선다.
    this._diffApplyOptions();
  },

  /**
   * EDITOR_MINIMAP_TOGGLE_SRS FR-MMT-1·4: 미니맵 스위치. 줄바꿈과 **같은 모양**
   * 이며, 그 사실이 이 함수가 짧은 이유다 — 새 규약을 만들지 않는다.
   */
  _initMinimap(){
    const cb=document.getElementById('ds-minimap');
    if(!cb) return;
    cb.checked=editorMinimap;
    cb.addEventListener('change',()=>{
      editorMinimap=cb.checked;
      this._edApplyMinimap();
      this.saveSettings();
    });
  },

  /** 열려 있는 편집기 전부에 지금 값을 얹는다 (`_edApplyWordWrap` 과 같은 근거). */
  _edApplyMinimap(){
    if(!this.fileEditors) return;
    for(const ed of this.fileEditors.values()) if(ed&&ed.applyMinimap) ed.applyMinimap();
  },

  /**
   * UX_BATCH10_SRS FR-UXB-42·43: diff 미니맵 스위치. 편집기 미니맵과 **같은
   * 모양**이다 (FR-MMT-1·4).
   */
  _initDiffMinimap(){
    const cb=document.getElementById('ds-diffminimap');
    if(!cb) return;
    cb.checked=diffMinimap;
    cb.addEventListener('change',()=>{
      diffMinimap=cb.checked;
      this._diffApplyOptions();
      this.saveSettings();
    });
  },

  /**
   * FR-UXB-40·41·42: **열려 있는 diff 전부**에 지금 값을 얹는다.
   *
   * 편집기 쪽이 셋(`_edApplyWordWrap`·`_edApplyMinimap`·`_edApplyFontSize`)인
   * 자리가 여기서 하나인 것은, diff 가 딛는 것이 덩이 하나이기 때문이다
   * (`edTextOptions`, D-UXB-9).
   *
   * 살아 있는 diff 는 git 패널이 든다 — 패널마다 `_diffView` 가 하나다.
   */
  _diffApplyOptions(){
    if(!this.gitPanels) return;
    for(const p of this.gitPanels.values()){
      if(p&&p._diffView&&p._diffView.applyTextOptions) p._diffView.applyTextOptions();
    }
  },

  /**
   * 설정 숫자 입력란 하나 (FONT_SIZE_SETTING_SRS FR-FSS-1·11·19·20·21 ·
   * AGENT_RENDER_ENV_SRS FR-ARE-10).
   *
   * 셋(UI 배율 · 터미널 글자 px · Claude 스크롤 속도)이 **같은 모양**이라 한
   * 자리에 둔다. 다른 것은 키와 얹는 손뿐이고, 그 둘을 인자로 받는다 — 같은
   * 40줄을 세 벌 적으면 한쪽만 고쳐지는 날이 온다.
   *
   * 규약은 `_initTabWidth` 에서 그대로 온다: 입력마다 얹되 저장은 미루고
   * (타이핑 한 글자마다 PUT 을 보내지 않는다), **포커스를 놓을 때 곧바로
   * 저장한다** — 디바운스는 요청 수를 줄이는 장치이지 확정을 미루는 장치가
   * 아니다 (실측 W7: 값을 바꾸고 바로 새로고침하면 입력이 통째로 날아갔다).
   */
  _initNumSetting(id,key,apply){
    const num=document.getElementById(id);
    if(!num) return;
    const timer='_fontSaveTimer_'+key;
    const read=()=>clampSetting(key,num.value);
    const paint=()=>{num.value=String(SETTINGS_ACCESS[key].get()??SETTINGS_BY_KEY[key].def)};
    paint();
    // FR-FSS-21: 여는 자리가 목록을 들고 있으면 키를 두 벌 적게 된다 — 세운
    // 쪽이 자기 칠하는 손을 맡긴다.
    (this._numSettingPaints||(this._numSettingPaints=[])).push(paint);
    num.addEventListener('input',()=>{
      // FR-FSS-19: 자르는 것은 **적용하는 값뿐**이다 — 입력란의 글자를 그때그때
      // 고쳐 쓰면 타이핑이 튄다 (`150` 을 지우고 `9` 를 치는 순간 80 이 된다).
      apply.call(this,read());
      TIMERS.cancel(this[timer]);
      this[timer]=this.timers.after(500,()=>this.saveSettings(),{owner:'app',label:'save-'+id});
    });
    num.addEventListener('blur',()=>{
      // 잘린 사실이 **보여야** 사용자가 왜 그 크기인지 안다 (FR-TBW-4 와 같은 근거).
      num.value=String(read());
      TIMERS.cancel(this[timer]);
      this.saveSettings();
    });
  },

  /**
   * FR-FSS-21: 설정 창을 **열 때마다** 숫자 입력들이 현재 값으로 다시 칠해진다
   * (FR-LVC-3 과 같은 근거).
   *
   * 방송이 올 때마다 `SETTINGS_ACCESS` 가 이미 칠하지만, 그 사이에 **확정하지
   * 않은 글자**가 입력란에 남을 수 있다 — `999` 를 치고 `Esc` 로 닫은 경우가
   * 그렇다. 적용된 값은 200 이고 입력란만 999 다. 여는 순간이 그것을 맞출 자리다.
   */
  _paintNumSettings(){
    for(const paint of this._numSettingPaints||[]) paint();
  },

  /** FR-FSS-1: Settings ▸ Display 의 `UI 글자 크기`. */
  _initUiFontScale(){
    this._initNumSetting('ds-uifs','uiFontSize',function(v){
      uiFontSize=v;
      applyUiFontScale();
      this._edApplyFontSize();
    });
    applyUiFontScale();
  },

  /** FR-FSS-11: Settings ▸ Terminal 의 `터미널 글자 크기`. */
  _initTermFontSize(){
    this._initNumSetting('ds-termfs','termFontSize',function(v){
      termFontSize=v;
      this._termApplyFontSize();
    });
  },

  /**
   * AGENT_RENDER_ENV_SRS FR-ARE-10·11: Settings ▸ Terminal 의 `스크롤 속도`.
   *
   * **얹을 화면이 없다.** 이 값은 도구를 띄울 때 서버가 환경변수로 넣는 것이라
   * (FR-ARE-8), 브라우저가 할 일은 값을 들고 저장하는 것뿐이다 — 이미 떠 있는
   * 터미널은 바뀌지 않는다 (FR-ARE-11, 환경은 프로세스 시작 시점의 것이다).
   */
  _initClaudeScrollSpeed(){
    this._initNumSetting('ds-scrollspeed','claudeScrollSpeed',function(v){
      claudeScrollSpeed=v;
    });
  },

  /** FR-FSS-9: 열려 있는 편집기 전부 (`_edApplyMinimap` 과 같은 근거). */
  _edApplyFontSize(){
    if(!this.fileEditors) return;
    for(const ed of this.fileEditors.values()) if(ed&&ed.applyFontSize) ed.applyFontSize();
    // FR-UXB-40·41: diff 도 같은 설정을 딛는다 — 편집기만 따라가면 두 표면이
    // 서로 다른 글자로 선다.
    this._diffApplyOptions();
  },

  /**
   * FR-FSS-15·16: 열려 있는 터미널 전부. **보이는 것만이 아니다** — 숨은 pane 도
   * 되돌아올 때 옛 크기로 서면 안 된다. `applyFontSize` 가 값이 같으면 아무 일도
   * 하지 않으므로 헛된 `fit` 이 나지 않는다.
   */
  _termApplyFontSize(){
    if(!this.tools) return;
    for(const p of this.tools.values()) if(p&&p.applyFontSize) p.applyFontSize();
  },

  // ── Modal & Theme ──
});
