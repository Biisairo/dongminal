/**
 * Otterminal — 설정의 **단일 경로** (FE_MODULE_BOUNDARY_SRS FR-FMB-10).
 *
 * 설정 하나를 **읽고 얹는 방법**의 서술자 표다. 그 표를 도는 셋 — 저장(PUT) · 적용 · 복원 — 은
 * `settings-apply.js` 의 `SettingsApply` 가 진다(REFACTOR3_FE_APPCTL_SRS 9a).
 *
 * **패널은 갈라져 나갔다.** 고칠 자리를 파일 이름이 말한다:
 *
 *   settings-apply.js         저장 · 적용 · 복원과 개별 설정의 즉시 반영 (`SettingsApply`, 설정창 없이도 돈다)
 *   settings-controller.js    설정의 조정자 `SettingsController` (세우는 순서 · 열기·탭 훅 · 검색 · 부품)
 *   settings-live.js          패널의 실시간 갱신 (`SettingsLive`) · settings-save-state.js  저장 단추 (`SettingsSaveState`)
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
  // PERF M1 C3: 주기가 토픽 이름(`stats:<ms>`)이라 바뀌면 상태바가 토픽을 갈아탄다.
  statsInterval:{get:()=>statsInterval,set(v){POLL_BY_KEY.statsInterval.set(v);if(this.statusbar)this.statusbar._statsRearm()}},
  gitWorktreeInterval:{get:()=>gitWorktreeInterval,set:v=>POLL_BY_KEY.gitWorktreeInterval.set(v)},
  layoutPresets:{get:()=>layoutPresets,set(v){layoutPresets=v;this.layout.winState._presetButtonPaint()}},
  defaultPreset:{get:()=>defaultPreset,set(v){defaultPreset=v;this.layout.winState._presetButtonPaint()}},
  // FR-TAN-19
  fgTabNames:{get:()=>fgTabNames,set(v){
    fgTabNames=v;
    if(this.wsSync?._fgRepaint) this.wsSync._fgRepaint();
  }},
  // FR-ARE-3: 저장된 적 없으면 기본값(켬). 서버도 같은 기본값을 쓴다
  // (`agentRenderEnv`) — 두 자리가 어긋나면 화면과 실제가 갈린다.
  claudeFullscreen:{get:()=>claudeFullscreen,set(v){claudeFullscreen=v}},
  confirmLeave:{get:()=>confirmLeave,set(v){confirmLeave=v}},   // FR-LVC-6: 저장된 적 없으면 기본값(끔).
  // FR-WBR-10·11: 값만 바꾸면 사용자는 설정이 듣지 않는 것으로 읽는다 —
  // 이미 열려 있는 편집기에도 얹는다.
  editorWordWrap:{get:()=>editorWordWrap,set(v){
    editorWordWrap=v;
    if(this.settings.apply._edApplyWordWrap) this.settings.apply._edApplyWordWrap();
  }},
  // FR-MMT-4: 줄바꿈과 같은 근거로 열려 있는 편집기에도 얹는다.
  editorMinimap:{get:()=>editorMinimap,set(v){
    editorMinimap=v;
    if(this.settings.apply._edApplyMinimap) this.settings.apply._edApplyMinimap();
  }},
  // FR-TBW-8: 같은 근거로 곧바로 얹는다. 클래스와 변수 하나뿐이라 다시 그리지 않는다.
  // OTTERMINAL_RENAME_SRS FR-FAV-3: 바꾸면 곧바로 아이콘을 다시 고른다.
  attnFavicon:{get:()=>attnFavicon,set(v){
    attnFavicon=v;
    this.settings.apply._applyPageTitle();
  }},
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
    if(this.settings.apply._edApplyFontSize) this.settings.apply._edApplyFontSize();
  }},
  // FR-FSS-12·15: 터미널만 움직인다.
  termFontSize:{get:()=>termFontSize,set(v){
    termFontSize=clampSetting('termFontSize',v);
    if(this.settings.apply._termApplyFontSize) this.settings.apply._termApplyFontSize();
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
  keybar:{get:()=>keybarCfg,set(v){keybarCfg=v;this.settings.apply._keybarApply()}},   // UX_AUDIT_FIX_SRS FR-UXF-93·95: 키바를 곧바로 다시 그린다. 설정 구역은 칠하기(`TerminalSection.paint`)가 맡는다
  claudeScrollSpeed:{get:()=>claudeScrollSpeed,set(v){
    claudeScrollSpeed=clampSetting('claudeScrollSpeed',v);
  }},
  // FR-UFE-12·13 / FR-AED-9: 범위 판정은 표가 한다 (`settingValue`) — 종전에는
  // 같은 모양의 `if` 가 두 줄 걸러 두 번 적혀 있었다.
  // 레인지 행을 칠하는 것은 `_paintSettingControls` 다 (`DisplaySection.paint`).
  focusEdgeLevel:{get:()=>focusEdgeLevel,set(v){
    focusEdgeLevel=v;
    this.focus._paintFocusEdge();
  }},
  attnEdgeLevel:{get:()=>attnEdgeLevel,set(v){
    attnEdgeLevel=v;
    this.focus._paintAttnEdge();
    this.attn._attnRefresh();
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
    if(uiLocale!==I18N.locale&&this.settings.apply._localeMirror(uiLocale)) location.reload();
  }},
};
