/**
 * Dongminal — 설정 값의 길과 개별 설정의 **즉시 반영** (FE_MODULE_BOUNDARY_SRS FR-FMB-10).
 *
 * `SettingsApply` 는 `SettingsController` 의 부품이다(`settings.apply`, REFACTOR3_FE_APPCTL_SRS 9a). 표
 * `SETTINGS_ACCESS`(`settings-table.js`)를 도는 셋 — 저장(PUT) · 적용 · 복원 — 과, 설정 하나하나가 화면에 붙는
 * 자리(탭 제목 · 열린 편집기·터미널에 값 얹기 · 테마 고르기 · 키바 얹기), 그리고 옛 `agentsPollMs` 의 이사
 * (옛 `app-polling.js`)를 진다. 행의 배선은 설정 섹션이다(`settings-display.js` 등, REFACTOR3_FE_SETTINGS_SRS 8a).
 *
 * **모달과 갈린 이유**: 이 메서드들은 설정창이 없어도 돈다 (부팅이 부른다). 그래서 App 생성자가 컨트롤러를
 * 만든다. 부팅의 `_settingsApply`(`main.js`, `/api/settings` 응답 뒤)와 설정창 세우기(`initModal`, 워크스페이스를
 * 받은 뒤)는 어느 쪽이 먼저일지 정해져 있지 않다 — **순서와 무관하게 같은 결과**가 이 파일의 규약이다
 * (QUALITY_FIX_SRS FR-QFX-9·12): 적용은 값(상태)을 얹고, 설정창은 `_paintSettingControls` 한 자리에서만 칠한다
 * (선 섹션의 `paint()`). 아직 서지 않은 섹션은 `init` 에서 지금 상태로 칠한다. 적용 길은 섹션을 직접 부르지 않는다.
 * 표의 `get`·`set` 은 종전대로 App 을 `this` 로 받는다.
 *
 * 로드 순서 계약: `settings-table.js` 뒤, `settings-section.js` 앞.
 */
class SettingsApply extends Controller {
  // 설정 저장의 본체는 `settings-sync.js` 의 `SettingsSync` 다 (APP_STATE_EXTRACT_SRS FR-ASE-9).
  // 지연 생성은 `runsPanel` 과 같은 규약이다.
  _settingsSync(){
    if(!this._setSync) this._setSync=new SettingsSync(this.app);
    return this._setSync;
  }

  saveSettings(){ return this._settingsSync().saveSettings() }

  // SSE `settings_changed` (FEC-M3). 자기 `origin` 이면 서버 값이 곧 보낸 본문이다 (옛 서버는 origin 이 없다).
  _onSettingsChanged(args){
    if(!(args&&args.origin&&args.origin===this.app.clientId)) return this._settingsRestore();
  }

  _settingsBody(){
    const body={};
    for(const spec of SETTINGS_SCHEMA){
      const acc=SETTINGS_ACCESS[spec.key];
      // FR-CFG-6: 읽을 길이 없는 키는 빠진다 — UI 가 아직 없는 값을 표에 적어
      // 두는 길을 남긴다.
      if(!acc||!acc.get) continue;
      body[spec.key]=acc.get.call(this.app);
    }
    return body;
  }

  _settingsLocalPending(){ return this._settingsSync()._settingsLocalPending() }

  /**
   * 서버 설정 blob 하나를 **화면에 얹는다** (SETTINGS_LIVE: 2026-09-08 접수).
   *
   * 종전에는 이 일이 두 곳에 흩어져 있었다 — `main.js` 의 부팅 로더(테마·단축키·
   * 상태바·주기·프리셋·제목)와 이 파일 끝의 IIFE(브라우저 키·떠날 때 확인·
   * 가장자리·줄바꿈·탭 너비·프로세스 이름). 둘 다 키를 손으로 나열했고, 그래서
   * **다른 창에서 바뀐 값을 받아 얹을 자리가 아예 없었다**: 접수한 말이
   * "설정값이 바뀌었을 때 다른 브라우저창은 바로 갱신이 안된다" 다.
   *
   * 얹는 규약을 한 함수로 내리면 세 계기가 같은 길을 지난다 — 부팅 · SSE 방송 ·
   * 소프트 리로드. 새 설정을 더할 때 고칠 자리도 하나다.
   *
   * `boot` 는 **부팅에서만 해야 하는 일**을 가른다. 지금은 그런 것이 없지만,
   * 값을 지우는 쪽(예: `saved.x===undefined` 일 때 기본으로 되돌리기)은 부팅과
   * 갱신에서 뜻이 다를 수 있어 자리를 비워 둔다.
   */
  _settingsApply(saved,opts){
    if(!saved||typeof saved!=='object') return;
    // FR-FSS-2c: 옛 `uiFontScale`(%) 을 `uiFontSize`(px) 로 옮긴다. 세 계기가
    // 모두 이 함수를 지나므로 자리가 여기 하나다.
    migrateUiFontScale(saved);
    /**
     * **서술자 표 하나를 돈다** (CONFIG_MANAGEMENT_SRS FR-CFG-3·5).
     *
     * 종전에는 키마다 `if` 가 하나씩 있었고 범위 검사가 같은 모양으로 두 번 세
     * 번 적혀 있었다 (`focusEdgeLevel`·`attnEdgeLevel`·주기 다섯). 값 판정은
     * 이제 `settingValue` 한 자리이고, 이 표가 지는 것은 얹은 뒤의 뒷일뿐이다.
     *
     * `!==undefined` 가드는 **그대로다** (FR-PIS-8): 서버가 말하지 않은 키에
     * 대해 화면이 판단하지 않는다. 부팅에서는 변수가 이미 기본값이라 결과가
     * 같고, 갱신에서는 이것이 유일하게 안전한 답이다 — 되돌려 버리면 이 자리에
     * 값을 직접 넣어 둔 쪽(검사·진단)의 값을 방송 하나가 지운다.
     */
    for(const spec of SETTINGS_SCHEMA){
      if(saved[spec.key]===undefined) continue;
      const acc=SETTINGS_ACCESS[spec.key];
      if(!acc||!acc.set) continue;
      const v=settingValue(saved[spec.key],spec);
      if(v===undefined) continue;
      acc.set.call(this.app,v);
    }
    // 테마는 두 키가 한 쌍이라 표 밖에 남는다 — **사용자 정의가 이름을 이긴다.**
    // 표를 돌며 각자 얹으면 순서에 따라 답이 갈린다.
    if(saved.customTheme){customTheme=sanitizeCustomTheme(saved.customTheme)}
    else if(saved.themeName&&THEMES[saved.themeName]){customTheme=null;currentThemeName=saved.themeName}
    // FR-STF-2·7: 추종이 켜져 있으면 슬롯이 이기고, 사용자 정의는 남되 적용되지 않는다.
    this._applyThemeChoice();
    // FR-B-7: 단축키를 품은 툴팁은 설정이 선 뒤에 채운다 — 기본값이어도 한 번은 채워야 한다.
    I18N.applyShortcuts(document);
    // 설정 변경은 감지 계층의 재평가 시점이다 (FR-GIT-23). 이 계층만 따로인
    // 이유는 백오프·소실 판정·활성 저장소 판정을 함께 쥐고 있어 주기만 떼어 올
    // 수 없기 때문이다 (FR-PIS-15).
    if(this.app.gitPanel&&this.app.gitPanel._reschedule) this.app.gitPanel._reschedule();
    /**
     * FR-PIS-14 / D-8a: 나머지 주기는 **도는 타이머에 닿아야** 한다.
     *
     * 진입점이 하나인 이유는 핸들에 닿는 길이 저마다 다르기 때문이다 — git
     * 콘솔의 타이머는 `observer → panels → panel._consoleView` 세 단 아래에 있고,
     * 그 길을 설정이 알아야 할 이유가 없다. 바뀐 job 만 다시 걸리고, **발화하지
     * 않는다**: 주기를 바꾼 것은 수집의 계기가 아니다.
     */
    TIMERS.refreshChanged();
    /**
     * FR-PIS-17 / D-9: `agentsPollMs` 의 이사는 **부팅에서만** 한다.
     *
     * `boot` 가 가르는 자리가 바로 이런 것이라고 위 주석이 적어 두었다 — SSE
     * 방송마다 로컬을 다시 보면, 그 사이 다른 창에서 바꾼 값을 옛 로컬 값이
     * 덮는다. 이사는 한 번이고 조용하다.
     */
    if(opts&&opts.boot) this._pollMigrateAgents(saved);
    /**
     * 설정창을 칠하는 자리는 여기 하나다 (QUALITY_FIX_SRS FR-QFX-9·11) — 선 섹션마다 `paint()`. 다른 창에서 바뀐
     * 값이 SSE 로 왔을 때 열려 있는 설정창이 옛 값을 든 채 남지 않는다 (FR-SYN). 맨 끝인 것은 이사가 바꾼 값까지
     * 싣기 위해서다. 칠하기는 값만 읽으므로 테마·주기를 얹은 뒤여도 결과가 같다.
     *   이전: 표를 돈 직후에 칠했고, 이사(`_pollMigrateAgents`)와 키바 얹기(`_keybarApply`)가 섹션을 따로 칠했다
     *         — 섹션이 아직 없으면(부팅 적용이 `initModal` 보다 먼저) 아무것도 하지 않는 `_sectionCall` 로 버텼다
     */
    this.app.settings.paint();
  }

  /**
   * 서버의 설정을 다시 받아 얹는다. `STATE_REGISTRY` 의 `settings` 가 부른다 —
   * 계기는 셋이다: SSE `settings_changed` · 구독이 열린 순간 · 소프트 리로드.
   *
   * `merge:'latest'` 인 이유는 이 상태에 **증분이 없기** 때문이다 (FR-HUB 의
   * `background` 와 같은 근거) — 방송은 "다시 받으라" 는 신호이고, 막아야 하는
   * 것은 스냅샷끼리의 추월뿐이다.
   */
  _settingsRestore(src){
    const flight=this.app._restoreBegin('settings');
    return stateFetch(src,'/api/settings').then(r=>{
      if(!this.app._restoreLive('settings',flight)) return;
      // D-OPT-7: 자기 에코는 얹지 않는다 — 판정은 `SettingsSync._settingsAcceptRemote`.
      this._settingsSync()._settingsAcceptRemote(r);
      this.app._restoreEnd('settings',flight);
    });
  }

  /**
   * PAGE_TITLE_SRS FR-PGT-8: `document.title` 을 쓰는 유일한 자리.
   *
   * 주의 배지(FR-PAN-13b)가 제목 전체를 다시 쓰므로, 설정값을 다른 곳에서
   * 넣으면 다음 `_attnRefresh` 에 지워진다. 합성은 여기 하나뿐이어야 한다.
   */
  _applyPageTitle(){
    const n=this.app._attn?this.app._attn.size:0;
    document.title=(n?'('+n+') ':'')+effectiveTitle();
  }

  _saveSettingsSoon(key){ return this._settingsSync()._saveSettingsSoon(key) }

  _saveSettingsNow(key){ return this._settingsSync()._saveSettingsNow(key) }

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
  }

  /**
   * 열려 있는 편집기 전부에 지금 값을 얹는다.
   *
   * 살아 있는 인스턴스의 목록은 `app.fileEditors` 다 (`renderer-pane.js` 가 만들고
   * 탭이 사라지면 `renderer-layout.js`·`slot-ops.js` 등이 거둔다). diff 뷰 안의 편집기는
   * 여기 없다 — 그쪽은 `_diffApplyOptions` 가 맡는다.
   */
  _edApplyWordWrap(){
    if(!this.app.fileEditors) return;
    for(const ed of this.app.fileEditors.values()) if(ed&&ed.applyWordWrap) ed.applyWordWrap();
    // FR-UXB-40·41: diff 도 같은 설정을 딛는다 — 편집기만 따라가면 두 표면이
    // 서로 다른 글자로 선다.
    this._diffApplyOptions();
  }

  /** 열려 있는 편집기 전부에 지금 값을 얹는다 (`_edApplyWordWrap` 과 같은 근거). */
  _edApplyMinimap(){
    if(!this.app.fileEditors) return;
    for(const ed of this.app.fileEditors.values()) if(ed&&ed.applyMinimap) ed.applyMinimap();
  }

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
    if(!this.app.gitPanels) return;
    for(const p of this.app.gitPanels.values()){
      if(p&&p._diffView&&p._diffView.applyTextOptions) p._diffView.applyTextOptions();
    }
  }

  /** FR-FSS-9: 열려 있는 편집기 전부 (`_edApplyMinimap` 과 같은 근거). */
  _edApplyFontSize(){
    if(!this.app.fileEditors) return;
    for(const ed of this.app.fileEditors.values()) if(ed&&ed.applyFontSize) ed.applyFontSize();
    // FR-UXB-40·41: diff 도 같은 설정을 딛는다 — 편집기만 따라가면 두 표면이
    // 서로 다른 글자로 선다.
    this._diffApplyOptions();
  }

  /**
   * FR-FSS-15·16: 열려 있는 터미널 전부. **보이는 것만이 아니다** — 숨은 pane 도
   * 되돌아올 때 옛 크기로 서면 안 된다. `applyFontSize` 가 값이 같으면 아무 일도
   * 하지 않으므로 헛된 `fit` 이 나지 않는다.
   */
  _termApplyFontSize(){
    if(!this.app.tools) return;
    for(const p of this.app.tools.values()) if(p&&p.sizer.applyFontSize) p.sizer.applyFontSize();
  }

  /**
   * SYSTEM_THEME_FOLLOW_SRS FR-STF-2·4·7: 세 이름 중 **무엇을 적용할지** 정하는
   * 자리 하나. 추종이 켜져 있으면 시스템 모드의 슬롯, 아니면 사용자 정의 →
   * `currentThemeName` 순이다 (기존 규약: 사용자 정의가 이름을 이긴다).
   * 테마 패널(`ThemeSection`)도 이것을 부른다.
   */
  _applyThemeChoice(){
    if(themeFollowSystem){
      const name=systemColorMode()==='dark'?themeNameDark:themeNameLight;
      const theme=THEMES[name]; if(theme){currentThemeName=name;applyThemeObj(theme);return}
    }
    applyThemeObj(customTheme||THEMES[currentThemeName]);
  }

  /**
   * UX_AUDIT_FIX_SRS FR-UXF-93·95: 키바 구성을 모바일 키바에 얹는다. 그리기는 상태(`keybarCfg`·`modKbd`)만 읽으므로
   * 키바가 서기 전(`initMobileKeybar` 앞, 부팅 적용)에 불러도 같은 키바가 된다 — 서면서 다시 그린다.
   * 설정 구역(Terminal ▸ 모바일 키바)의 목록은 `TerminalSection.paint` 가 칠한다 (QUALITY_FIX_SRS FR-QFX-10).
   *   이전: `modKbd` 가 있을 때만 그렸고, 설정 구역은 섹션이 있으면 여기서 칠했다(`_sectionCall`)
   */
  _keybarApply(){
    this.app.mobile._mkbRender();
    this.app.mobile.mkbRefresh();
  }

  // FR-PIS-20: `Polling` 탭의 행은 `PollingSection` 이 표에서 만든다 (REFACTOR3_FE_SETTINGS_SRS 8b·8e).

  /**
   * FR-PIS-17 / D-9: `agentsPollMs` 의 이사. **한 번이고 조용하다.**
   *
   * 서버에 값이 있으면 서버가 이긴다 — 여러 기기가 각자 옛 값을 들고 있을 때
   * 마지막에 뜬 기기가 남의 설정을 덮으면 안 된다. 어느 쪽이든 로컬의 옛 값은
   * 지운다: 남겨 두면 다음 부팅이 같은 판단을 다시 하고, 그 사이에 서버 값이
   * 바뀌었다면 그때는 덮는다.
   */
  _pollMigrateAgents(saved){
    const old=PrefStore.local.get(STORE_KEYS.legacyAgentsPollMs);
    if(old===null) return;
    PrefStore.local.remove(STORE_KEYS.legacyAgentsPollMs);
    if(saved&&saved.agentsPollInterval!==undefined) return;
    const v=settingValue(parseInt(old,10),SETTINGS_BY_KEY.agentsPollInterval);
    if(v===agentsPollInterval) return;
    agentsPollInterval=v;
    TIMERS.refreshChanged();
    this.saveSettings();
  }
}
