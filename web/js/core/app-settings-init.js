/**
 * Dongminal — 개별 설정의 **초기화와 즉시 반영** (FE_MODULE_BOUNDARY_SRS FR-FMB-10).
 *
 * 설정 하나하나가 화면에 붙는 자리다 — 탭 제목 · 포커스/주의 가장자리 · 열린
 * 편집기·터미널에 값 얹기. 행의 배선은 설정 섹션으로 옮겼다(`settings-display.js`·
 * `settings-terminal.js`·`settings-code.js`, REFACTOR3_FE_SETTINGS_SRS 8a).
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

  _saveSettingsSoon(key){ return this._settingsSync()._saveSettingsSoon(key) },

  _saveSettingsNow(key){ return this._settingsSync()._saveSettingsNow(key) },

  /**
   * UX_REVISION_SRS FR-KEY-6 철회 (D-K2): **`_initBlockKeys` 가 사라졌다.**
   *
   *   이전 동작: Shortcuts 탭의 스위치로 브라우저 기본키 차단을 끌 수 있다
   *   새  동작: 스위치가 없다. 차단은 늘 돈다
   *   이유:     기본값이 이미 켬이라 **동작은 바뀌지 않는다.** 끄는 유일한
   *             실사용 근거가 *"입력란에서 편집 키가 막힌다"* 였고, 그것은
   *             설정이 아니라 면제표의 결함이었다 (FR-KEY-8)
   *
   * 서버 blob 에 남은 값은 `settingsschema.Validate` 가 unknown 으로 흘린다 —
   * 마이그레이션이 필요 없다.
   */

  /** 거울을 쓴다. 되읽어 같아야 참이다 — 사생활 모드에서는 거짓이다. */
  _localeMirror(v){
    return PrefStore.local.set(I18N_STORAGE_KEY,v)&&PrefStore.local.get(I18N_STORAGE_KEY)===v;
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
      this._saveSettingsSoon('ufe');
    });
    // 손을 떼는 순간이 값이 정해지는 순간이다 — 그때는 기다리지 않고 보낸다.
    // `tabWidthPx` 가 `blur` 에서 하는 것과 같은 자리다: 디바운스는 드래그 **중**의
    // PUT 폭주를 막으려는 것이지, 정해진 값을 늦추려는 것이 아니다.
    sl.addEventListener('change',()=>this._saveSettingsNow('ufe'));
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
      this._saveSettingsSoon('ae');
    });
    sl.addEventListener('change',()=>this._saveSettingsNow('ae'));
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
   * 열려 있는 편집기 전부에 지금 값을 얹는다.
   *
   * 살아 있는 인스턴스의 목록은 `app.fileEditors` 다 (`renderer.js:533` 이 만들고
   * `app-layout.js:428` 이 거둔다). diff 뷰 안의 편집기는
   * 여기 없다 — 그쪽은 `_diffApplyOptions` 가 맡는다.
   */
  _edApplyWordWrap(){
    if(!this.fileEditors) return;
    for(const ed of this.fileEditors.values()) if(ed&&ed.applyWordWrap) ed.applyWordWrap();
    // FR-UXB-40·41: diff 도 같은 설정을 딛는다 — 편집기만 따라가면 두 표면이
    // 서로 다른 글자로 선다.
    this._diffApplyOptions();
  },

  /** 열려 있는 편집기 전부에 지금 값을 얹는다 (`_edApplyWordWrap` 과 같은 근거). */
  _edApplyMinimap(){
    if(!this.fileEditors) return;
    for(const ed of this.fileEditors.values()) if(ed&&ed.applyMinimap) ed.applyMinimap();
  },

  /**
   * FR-UXB-40·41·42: **열려 있는 diff 전부**에 지금 값을 얹는다.
   *
   * 편집기 쪽이 셋(`_edApplyWordWrap`·`_edApplyMinimap`·`_edApplyFontSize`)인
   * 자리가 여기서 하나인 것은, diff 가 딛는 것이 `applyTextOptions` 하나이기 때문이다
   * (D-UXB-9).
   *
   * 살아 있는 diff 는 git 패널이 든다 — 패널마다 `_diffView` 가 하나다.
   */
  _diffApplyOptions(){
    if(!this.gitPanels) return;
    for(const p of this.gitPanels.values()){
      if(p&&p._diffView&&p._diffView.applyTextOptions) p._diffView.applyTextOptions();
    }
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
