/**
 * Dongminal — 설정의 **단일 경로** (FE_MODULE_BOUNDARY_SRS FR-FMB-10).
 *
 * 설정 하나를 **읽고 얹는 방법**의 서술자 표와, 그 표를 도는 셋 — 저장(PUT) ·
 * 적용 · 복원. 설정창의 골격도 여기 있다.
 *
 * **패널은 갈라져 나갔다.** 고칠 자리를 파일 이름이 말한다:
 *
 *   app-settings-init.js      개별 설정의 즉시 반영 (설정창 없이도 돈다 — 테마 고르기·키바 얹기 포함)
 *   settings-controller.js    설정 탭들의 조정자 `SettingsController` (세우는 순서 · 열기·탭 훅)
 *   settings-section.js       설정 탭 하나 = `SettingsSection` 하위 하나 (`settings-display.js` 등)
 *   settings-row.js           단순한 행 `FormRow` (체크·숫자)
 *   settings-theme.js         테마 목록 · 미리보기 · 사용자 정의 편집 (`ThemeSection`)
 *   settings-shortcuts.js     단축키 목록 (`ShortcutsSection`, 녹화는 ui/input-binding.js)
 *   settings-presets.js       레이아웃 프리셋 목록 (`PresetsSection`) · settings-backup.js  백업 (`BackupSection`)
 *   settings-sandbox.js       샌드박스 패널 (`SandboxSection`)
 *   settings-access.js        접속 허용 목록(ACL) 패널 (`AccessSection`)
 *   settings-edges.js         간선(Edges) 패널 (`EdgesSection`)
 *   settings-profile.js       프로필(이름#번호) 패널 (`ProfileSection`)
 *   settings-telegram.js      Telegram 브리지 패널 · settings-server.js  Server(바인드) 패널
 *   settings-claude.js        Claude 계정 패널 (`ClaudeSection`, 순수 함수는 settings-claude-rows.js)
 */
/**
 * 설정 하나를 **읽고 얹는 방법** (CONFIG_MANAGEMENT_SRS FR-CFG-5).
 *
 * 키·타입·범위·기본값은 여기 없다 — `settings-schema.js` 의 `SETTINGS_SCHEMA` 가
 * 그 단일 원천이고 Go 도 같은 바이트를 읽는다 (FR-CFG-1·10). 이 표가 지는 것은
 * **전역 변수에 닿는 길과 얹은 뒤의 뒷일**뿐이다. JSON 에 담을 수 없어 갈라 둔
 * 것이며, 두 표의 키 집합이 같은지는 검사가 강제한다 (TC-CFG-1).
 *
 * 종전에는 이 목록이 **세 벌**이었다 — PUT 본문의 인라인 나열 · `_settingsApply`
 * 의 `if` 스무 갈래 · 이식 표. 아무 게이트도 없었고, 빠뜨린 실패는 다른 브라우저
 * 창을 열어 보기 전까지 아무도 모른다.
 *
 *   get()   블롭에 실을 값. 없으면 그 키는 PUT 본문에서 빠진다 (FR-CFG-6)
 *   set(v)  값을 얹고 화면까지 따라가게 한다. 설정창의 입력란은 칠하지 않는다 — 행(`FormRow`)이
 *           입력 중에도 이것을 부르므로, 여기서 칠하면 치는 글자가 튄다. 칠하는 것은
 *           `_paintSettingControls` 한 자리다 (FR-OPT-1-12 · REFACTOR3_FE_SETTINGS_SRS FR-FES-2)
 */
const SETTINGS_ACCESS={
  // 테마는 두 키가 한 쌍이라 얹는 자리가 `_settingsApply` 에 따로 있다 —
  // 사용자 정의가 있으면 그것이 이름을 이긴다. 여기서는 싣기만 한다.
  themeName:{get:()=>customTheme?null:currentThemeName},
  customTheme:{get:()=>customTheme},
  shortcuts:{get:()=>shortcuts,set:v=>{Object.assign(shortcuts,v)}},
  statusBar:{get:()=>statusBar,set:v=>{Object.assign(statusBar,v)}},
  // 주기 다섯은 `POLL_SETTINGS` 가 이미 쥔 길을 그대로 쓴다 (FR-PIS-7).
  agentsPollInterval:{get:()=>agentsPollInterval,set:v=>POLL_BY_KEY.agentsPollInterval.set(v)},
  statsInterval:{get:()=>statsInterval,set:v=>POLL_BY_KEY.statsInterval.set(v)},
  gitStatusInterval:{get:()=>gitStatusInterval,set:v=>POLL_BY_KEY.gitStatusInterval.set(v)},
  gitReposInterval:{get:()=>gitReposInterval,set:v=>POLL_BY_KEY.gitReposInterval.set(v)},
  gitWorktreeInterval:{get:()=>gitWorktreeInterval,set:v=>POLL_BY_KEY.gitWorktreeInterval.set(v)},
  gitConsoleInterval:{get:()=>gitConsoleInterval,set:v=>POLL_BY_KEY.gitConsoleInterval.set(v)},
  layoutPresets:{get:()=>layoutPresets,set(v){layoutPresets=v;this._presetButtonPaint()}},
  defaultPreset:{get:()=>defaultPreset,set(v){defaultPreset=v;this._presetButtonPaint()}},
  // FR-TAN-19
  fgTabNames:{get:()=>fgTabNames,set(v){
    fgTabNames=v;
    if(this._fgRepaint) this._fgRepaint();
  }},
  // FR-ARE-3: 저장된 적 없으면 기본값(켬). 서버도 같은 기본값을 쓴다
  // (`agentRenderEnv`) — 두 자리가 어긋나면 화면과 실제가 갈린다.
  claudeFullscreen:{get:()=>claudeFullscreen,set(v){claudeFullscreen=v}},
  confirmLeave:{get:()=>confirmLeave,set(v){confirmLeave=v}},   // FR-LVC-6: 저장된 적 없으면 기본값(끔).
  // FR-WBR-10·11: 값만 바꾸면 사용자는 설정이 듣지 않는 것으로 읽는다 —
  // 이미 열려 있는 편집기에도 얹는다.
  editorWordWrap:{get:()=>editorWordWrap,set(v){
    editorWordWrap=v;
    if(this._edApplyWordWrap) this._edApplyWordWrap();
  }},
  // FR-MMT-4: 줄바꿈과 같은 근거로 열려 있는 편집기에도 얹는다.
  editorMinimap:{get:()=>editorMinimap,set(v){
    editorMinimap=v;
    if(this._edApplyMinimap) this._edApplyMinimap();
  }},
  // FR-TBW-8: 같은 근거로 곧바로 얹는다. 클래스와 변수 하나뿐이라 다시 그리지 않는다.
  tabFixedWidth:{get:()=>tabFixedWidth,set(v){
    tabFixedWidth=v;
    applyTabWidth();
  }},
  tabWidthPx:{get:()=>tabWidthPx,set(v){
    tabWidthPx=clampSetting('tabWidthPx',v);
    applyTabWidth();
  }},
  // FONT_SIZE_SETTING_SRS FR-FSS-3·9: 배율 하나가 CSS 토큰과 편집기 둘 다에 간다.
  // 터미널은 여기 없다 — 그것이 이 스펙의 요점이다 (FR-FSS-17).
  uiFontSize:{get:()=>uiFontSize,set(v){
    uiFontSize=clampSetting('uiFontSize',v);
    applyUiFontScale();
    if(this._edApplyFontSize) this._edApplyFontSize();
  }},
  // FR-FSS-12·15: 터미널만 움직인다.
  termFontSize:{get:()=>termFontSize,set(v){
    termFontSize=clampSetting('termFontSize',v);
    if(this._termApplyFontSize) this._termApplyFontSize();
  }},
  // AGENT_RENDER_ENV_SRS FR-ARE-8: 얹을 화면이 없다 — 값은 서버가 쓴다.
  // ISSUE_TREE_OPS_SRS FR-ITM-1·2: 두 쌍은 서로 영향을 주지 않는다. 얹을 화면이 없다.
  migrationHook:{get:()=>migrationHook??SETTINGS_BY_KEY.migrationHook.def,set(v){migrationHook=v}},
  migrationHookCtxPct:{get:()=>migrationHookCtxPct,set(v){
    migrationHookCtxPct=clampSetting('migrationHookCtxPct',v);
  }},
  issueTreeMigration:{get:()=>issueTreeMigration??SETTINGS_BY_KEY.issueTreeMigration.def,set(v){issueTreeMigration=v}},
  issueTreeCtxPct:{get:()=>issueTreeCtxPct,set(v){
    issueTreeCtxPct=clampSetting('issueTreeCtxPct',v);
  }},
  keybar:{get:()=>keybarCfg,set(v){keybarCfg=v;this._keybarApply()}},   // UX_AUDIT_FIX_SRS FR-UXF-93·95: 키바·설정 구역을 곧바로 다시 그린다
  claudeScrollSpeed:{get:()=>claudeScrollSpeed,set(v){
    claudeScrollSpeed=clampSetting('claudeScrollSpeed',v);
  }},
  // FR-UFE-12·13 / FR-AED-9: 범위 판정은 표가 한다 (`settingValue`) — 종전에는
  // 같은 모양의 `if` 가 두 줄 걸러 두 번 적혀 있었다.
  // 레인지 행을 칠하는 것은 `_paintSettingControls` 다 (`DisplaySection.paint`).
  focusEdgeLevel:{get:()=>focusEdgeLevel,set(v){
    focusEdgeLevel=v;
    this._paintFocusEdge();
  }},
  attnEdgeLevel:{get:()=>attnEdgeLevel,set(v){
    attnEdgeLevel=v;
    this._paintAttnEdge();
    this._attnRefresh();
  }},
  // SYSTEM_THEME_FOLLOW_SRS FR-STF-1·THEME_SEED_COLOR_SRS FR-SEED-1: 얹는 것은 값뿐이다 — 어느 테마를 어떻게 적용할지는 `_settingsApply` 가 정한다 (`_applyThemeChoice`).
  themeFollowSystem:{get:()=>themeFollowSystem,set(v){themeFollowSystem=!!v}},
  themeNameDark:{get:()=>themeNameDark,set(v){if(THEMES[v]) themeNameDark=v}},
  themeNameLight:{get:()=>themeNameLight,set(v){if(THEMES[v]) themeNameLight=v}},
  seedColor:{get:()=>seedColor,set(v){seedColor=SEED_HEX_RE.test(v)?v.toLowerCase():''}},
  // FR-B-4 / D-B-1: 서버의 값이 활성 로케일과 다르면 거울(`localStorage`)을 고치고
  // 페이지를 다시 연다 — 상수 1,100여 개가 로드 시점에 읽었으므로 살아 있는
  // 재렌더는 없다. 거울을 쓰지 못하는 브라우저에서는 다시 열지 않는다(무한 재로드).
  locale:{get:()=>uiLocale,set(v){
    uiLocale=I18N.resolve(v);
    const sel=document.getElementById('ds-locale');
    if(sel) sel.value=uiLocale;
    if(uiLocale!==I18N.locale&&this._localeMirror(uiLocale)) location.reload();
  }},
};


Object.assign(App.prototype, {
  // 설정 저장의 본체는 `settings-sync.js` 의 `SettingsSync` 다 (APP_STATE_EXTRACT_SRS FR-ASE-9).
  // 지연 생성은 `_runsPanel` 과 같은 규약이다.
  _settingsSync(){
    if(!this._setSync) this._setSync=new SettingsSync(this);
    return this._setSync;
  },
  saveSettings(){ return this._settingsSync().saveSettings() },

  // SSE `settings_changed` (FEC-M3). 자기 `origin` 이면 서버 값이 곧 보낸 본문이다 (옛 서버는 origin 이 없다).
  _onSettingsChanged(args){
    if(!(args&&args.origin&&args.origin===this.clientId)) return this._settingsRestore();
  },

  _settingsBody(){
    const body={};
    for(const spec of SETTINGS_SCHEMA){
      const acc=SETTINGS_ACCESS[spec.key];
      // FR-CFG-6: 읽을 길이 없는 키는 빠진다 — UI 가 아직 없는 값을 표에 적어
      // 두는 길을 남긴다.
      if(!acc||!acc.get) continue;
      body[spec.key]=acc.get.call(this);
    }
    return body;
  },

  _settingsLocalPending(){ return this._settingsSync()._settingsLocalPending() },

  /**
   * SANDBOX_PICK_COPY_SRS FR-SPK-7: 설정 화면을 특정 탭으로 연다.
   *
   * 여는 절차는 `SettingsModal.open()` 한 자리다(REFACTOR3_FE_ESC_SRS FR-FEE-9). 탭은 탭 요소를 **실제로
   * 누른다** — 탭별 재조회와 모바일 상세 화면이 그 리스너 안에 있다.
   */
  _openSettings(tab){
    if(this.settings&&this.settings.modal) this.settings.modal.open();
    if(!tab) return;
    const tabEl=document.querySelector('#modal .mtab[data-tab="'+tab+'"]');
    if(tabEl) tabEl.click();
  },

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
      acc.set.call(this,v);
    }
    this._paintSettingControls();
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
    if(this.gitPanel&&this.gitPanel._reschedule) this.gitPanel._reschedule();
    /**
     * FR-PIS-14 / D-8a: 나머지 주기는 **도는 타이머에 닿아야** 한다.
     *
     * 진입점이 하나인 이유는 핸들에 닿는 길이 저마다 다르기 때문이다 — git
     * 콘솔의 타이머는 `observer → panels → panel._consoleView` 세 단 아래에 있고,
     * 그 길을 설정이 알아야 할 이유가 없다. 바뀐 job 만 다시 걸리고, **발화하지
     * 않는다**: 주기를 바꾼 것은 수집의 계기가 아니다.
     */
    TIMERS.refreshChanged();
    // 화면의 드롭다운도 같은 값을 보여야 한다 — 다른 창에서 바뀐 값이 SSE 로
    // 왔을 때 열려 있는 설정창이 옛 값을 든 채 남지 않는다 (FR-SYN). 위의
    // `_paintSettingControls` 가 `PollingSection.paint` 로 칠한다.
    /**
     * FR-PIS-17 / D-9: `agentsPollMs` 의 이사는 **부팅에서만** 한다.
     *
     * `boot` 가 가르는 자리가 바로 이런 것이라고 위 주석이 적어 두었다 — SSE
     * 방송마다 로컬을 다시 보면, 그 사이 다른 창에서 바꾼 값을 옛 로컬 값이
     * 덮는다. 이사는 한 번이고 조용하다.
     */
    if(opts&&opts.boot) this._pollMigrateAgents(saved);
  },

  /**
   * OPTIMIZE_REFACTOR_SRS FR-OPT-1-12 (FEC-26): 설정창의 행을 **지금 값으로** 칠한다.
   * 계기는 셋이다 — 부팅(`SettingsController.init`) · 값을 얹은 뒤(`_settingsApply`) · 설정창을 열 때
   * (FR-LVC-3). 행은 섹션이 `FormRow` 로 선언한다(REFACTOR3_FE_SETTINGS_SRS FR-FES-2) —
   * 포커스를 쥔 입력란을 건너뛰는지도 행마다 정해져 있다(`guard`).
   */
  _paintSettingControls(){
    if(this.settings) this.settings.paint();
  },

  /**
   * 서버의 설정을 다시 받아 얹는다. `STATE_REGISTRY` 의 `settings` 가 부른다 —
   * 계기는 셋이다: SSE `settings_changed` · 구독이 열린 순간 · 소프트 리로드.
   *
   * `merge:'latest'` 인 이유는 이 상태에 **증분이 없기** 때문이다 (FR-HUB 의
   * `background` 와 같은 근거) — 방송은 "다시 받으라" 는 신호이고, 막아야 하는
   * 것은 스냅샷끼리의 추월뿐이다.
   */
  _settingsRestore(src){
    const flight=this._restoreBegin('settings');
    return stateFetch(src,'/api/settings').then(r=>{
      if(!this._restoreLive('settings',flight)) return;
      // D-OPT-7: 자기 에코는 얹지 않는다 — 판정은 `SettingsSync._settingsAcceptRemote`.
      this._settingsSync()._settingsAcceptRemote(r);
      this._restoreEnd('settings',flight);
    });
  },

  /**
   * ACCESSIBILITY_BASELINE_SRS FR-A11Y-13 (`G7-1` 첫 판): 설정 컨트롤의 **이름을
   * 구조에서 파생**한다.
   *
   * 첫 판이 올린 것: `<input>` 18개 중 17개·`<select>` 6개에 이름이 없고
   * `label[for]` 는 0개였다 — 이름이 없는 게 아니라 **연결 기제가 없었다.** 관용구는
   * 한결같다: `.ds-row`/`.sbs-row` 의 첫 자식 `<span>` 이 이름이고 그 뒤에 컨트롤
   * 하나가 선다. 그러므로 손으로 스물셋을 적지 않고 그 구조에서 `aria-labelledby`
   * 를 세운다 — 행을 더하는 사람이 아무것도 기억하지 않아도 된다 (`.mtab` 의
   * tablist 와 같은 규약). 컨트롤이 둘 이상인 행은 건드리지 않는다 — 어느 것의
   * 이름인지 구조가 말하지 않는다.
   *
   * 열 때마다 돈다 — 상태바·주기 행은 다시 그려질 수 있다. 멱등이다.
   */
  _labelSettingsRows(){
    const modal=document.getElementById('modal'); if(!modal) return;
    let n=0;
    for(const row of modal.querySelectorAll('.ds-row,.sbs-row')){
      const lab=row.firstElementChild;
      if(!lab||lab.tagName!=='SPAN'||lab.className||!(lab.textContent||'').trim()) continue;
      const ctls=row.querySelectorAll('input:not([type=hidden]),select,textarea,[role=switch]');
      if(ctls.length!==1) continue;
      const c=ctls[0];
      if(c.hasAttribute('aria-label')||c.hasAttribute('aria-labelledby')) continue;
      if(!lab.id) lab.id='ds-lbl-'+(c.id||String(++n));
      c.setAttribute('aria-labelledby',lab.id);
    }
  },

  /**
   * UI_POLISH_SRS FR-UIP-23: 설정 검색. 탭 이름(영어 툴팁도, FR-UXF-40)이나 그 탭 안의 글(항목 라벨·설명)에
   * 입력이 들어 있는 탭만 목록에 남긴다. 선택지(`<option>`)의 글은 보지 않는다 —
   * 언어·테마 이름 같은 값이 거의 모든 낱말에 걸린다.
   * 고른 탭이 걸러지면 남은 첫 탭으로 옮긴다. 모달을 열 때마다 비운다.
   */
  _bindSettingsSearch(modal){
    const input=document.getElementById('modal-search'); if(!input) return;
    const textOf=root=>{
      const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:n=>
        n.parentElement&&n.parentElement.closest('option,select,script,style')
          ?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
      let out='';
      for(let n=w.nextNode();n;n=w.nextNode()) out+=' '+n.nodeValue;
      return out.toLowerCase();
    };
    const apply=()=>{
      const q=input.value.trim().toLowerCase();
      const tabs=[...modal.querySelectorAll('.mtab')];
      for(const tab of tabs){
        const pn=document.getElementById('panel-'+tab.dataset.tab);
        tab.hidden=!!q&&!((tab.textContent+' '+tab.title).toLowerCase().includes(q)||(pn&&textOf(pn).includes(q)));
      }
      for(const g of modal.querySelectorAll('.mtab-grp')) g.hidden=!!q; // FR-STO-4: 거른 목록에 묶음 이름은 없다
      const cur=modal.querySelector('.mtab.active');
      if(cur&&cur.hidden&&!(this.isMobile&&modal.dataset.mview==='list')){   // MOBILE_UX_OVERHAUL_SRS FR-MUX-21: 모바일 목록에서는 상세로 넘기지 않는다
        const first=tabs.find(x=>!x.hidden);
        if(first) first.click();
      }
    };
    input.addEventListener('input',apply);
    this._settingsSearchReset=()=>{input.value='';apply()};   // 열 때 비운다(`SettingsController.onOpen`)
  },

  /**
   * 설정 탭들을 세운다 — `SettingsController` 하나가 든다(REFACTOR3_FE_SETTINGS_SRS FR-FES-6·7). 세우는 순서와
   * 그 사이에 도는 다른 init(`initSaveButtons`·`initStatusBar`·`initMobile`·`initMobileKeybar`·`initAttn`)은
   * 컨트롤러의 표 `SETTINGS_INIT` 이 말한다.
   */
  initModal(){
    this.settings=new SettingsController(this).init();
  },

  // ── 설정 섹션 위임자 (REFACTOR3_FE_SETTINGS_SRS FR-FES-9) ──
  // 설정 밖(`app-edges.js`·`state-registry.js`·`app-claude-accounts.js`·`main.js`)·저장 단추 판정(`settings-save-state.js`)·
  // 단위 시험이 App 에서 부르는 이름이다. 섹션이 아직 없으면(`initModal` 전) 아무것도 하지 않는다.
  _onAccessChanged(...a){ return this._sectionCall('access','_onAccessChanged',a) },
  _onSandboxChanged(...a){ return this._sectionCall('sandbox','_onSandboxChanged',a) },
  _onServerMoving(...a){ return this._sectionCall('server','_onServerMoving',a) },
  _edgesPaint(...a){ return this._sectionCall('edges','_edgesPaint',a) },
  _egNodePaint(...a){ return this._sectionCall('edges','_egNodePaint',a) },
  _egNodeCollect(...a){ return this._sectionCall('edges','_egNodeCollect',a) },
  _cacctPanelShown(...a){ return this._sectionCall('claude','_cacctPanelShown',a) },
  _cacctRefreshSoft(...a){ return this._sectionCall('claude','_cacctRefreshSoft',a) },
  _loadTelegramPanel(...a){ return this._sectionCall('telegram','_loadTelegramPanel',a) },
  _tgRead(...a){ return this._sectionCall('telegram','_tgRead',a) },
  _pfCollect(...a){ return this._sectionCall('profile','_pfCollect',a) },
  _pfFollow(...a){ return this._sectionCall('profile','_pfFollow',a) },
  _sbxCollect(...a){ return this._sectionCall('sandbox','_sbxCollect',a) },
  _aclCollect(...a){ return this._sectionCall('access','_aclCollect',a) },
  // 8d — `main.js`(사용자 정의 편집기 단추)·e2e 계약(`app-testing.js`)
  themeSlots(...a){ return this._sectionCall('theme','themeSlots',a) },
  setThemeSlots(...a){ return this._sectionCall('theme','setThemeSlots',a) },
  _showCustomEditor(...a){ return this._sectionCall('theme','_showCustomEditor',a) },
  _hideCustomEditor(...a){ return this._sectionCall('theme','_hideCustomEditor',a) },
  _renderPresets(...a){ return this._sectionCall('presets','_renderPresets',a) },
  _savePreset(...a){ return this._sectionCall('presets','_savePreset',a) },

  _sectionCall(tab,name,args){
    const s=this.settings?this.settings.section(tab):null;
    return s?s[name](...args):undefined;
  },
});
