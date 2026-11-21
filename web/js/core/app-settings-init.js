/**
 * Dongminal — 개별 설정의 **초기화와 즉시 반영** (FE_MODULE_BOUNDARY_SRS FR-FMB-10).
 *
 * 설정 하나하나가 화면에 붙는 자리다 — 탭 제목 · 열린
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
