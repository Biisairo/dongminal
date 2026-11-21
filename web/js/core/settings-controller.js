/**
 * SettingsController — 설정 탭들의 조정자 (REFACTOR3_FE_SETTINGS_SRS FR-FES-6·7, 8e).
 *
 * 탭 하나는 `SettingsSection` 하위 하나다. 이 컨트롤러가 섹션을 들고(`section(tab)`·`all()`), 부팅 때 세우고,
 * 설정을 열 때·탭을 고를 때 섹션의 `onOpen`·`onTab` 을 부른다. App 은 이것 하나를 `settings` 로 든다(FR-FES-7).
 *
 * 무엇을 어떤 순서로 세우는지는 표 `SETTINGS_INIT` 하나다. 열 때의 순서는 `onOpen` 의 본문이 말한다(INV-S3).
 * 모바일 두 화면과 검색은 섹션이 모른다 — 이 컨트롤러가 App 의 것을 부른다(§1.3).
 */

/** `SETTINGS_INIT` 의 표지 — 설정 모달을 만들고 검색을 배선한다. */
const SETTINGS_INIT_MODAL='@modal';

/**
 * 부팅 배선의 순서 (TC-FES-4). 섹션은 클래스, 문자열은 그 사이에 도는 App 의 init 이다.
 *
 * 옛 순서(df15f347)는 `initModal` 의 나열 다음에 `ui/input-binding.js` 의 init 여덟이었다. 섹션 셋은 다른 init
 * 안이나 뒤에서 섰다 — statusbar 는 `initStatusBar` 끝, notify 는 `initAttn` 안, polling 은 `initPollingSettings`.
 * 다른 주제의 init 과의 상대 순서를 그대로 둔다: `initSaveButtons` 는 패널들이 선 뒤여야 하고(FR-UXF-72),
 * `initMobile` 이 거는 모바일 설정의 탭 리스너는 `SettingsModal` 의 것보다 뒤여야 한다(FR-MUX-20).
 */
const SETTINGS_INIT=[
  ThemeSection, SETTINGS_INIT_MODAL, ShortcutsSection, DisplaySection, TerminalSection, CodeSection,
  '_paintSettingControls', BackupSection, SandboxSection, AccessSection, EdgesSection, ProfileSection,
  TelegramSection, ServerSection, ClaudeSection,
  'initSaveButtons', 'initStatusBar', StatusbarSection, PresetsSection, 'initMobile', 'initMobileKeybar',
  'initAttn', NotifySection, PollingSection,
];

class SettingsController extends Controller {
  constructor(app){
    super(app);
    this._sections=new Map();
    this.modal=null;
  }

  /** 표의 순서대로 세운다. 한 번만 부른다. */
  init(){
    for(const step of SETTINGS_INIT){
      if(typeof step==='function') this.start(new step(this.app));
      else if(step===SETTINGS_INIT_MODAL) this._initModal();
      else this.app[step]();
    }
    return this;
  }

  /** 섹션을 들고 `init()` 을 부른다. */
  start(section){
    this._sections.set(section.tab,section);
    section.init();
    return section;
  }

  section(tab){ return this._sections.get(tab)||null }

  /** 세운 순서다. */
  all(){ return [...this._sections.values()] }

  /** 칠하기 한 자리 — 섹션마다 `paint()`. */
  paint(){
    for(const s of this._sections.values()) s.paint();
  }

  /**
   * REFACTOR3_FE_DIALOG_SRS FR-FED-10: 열기·닫기·탭 고르기는 `SettingsModal` 이 진다. 여기서 만들어야
   * `_initSettingsMobile` 의 탭 리스너가 그 뒤에 붙어 뒤에 돈다.
   */
  _initModal(){
    const modal=document.getElementById('modal');
    this.modal=new SettingsModal({onOpen:()=>this.onOpen(modal),onTab:n=>this.onTab(n)}).init();
    this.app._bindSettingsSearch(modal);
  }

  /**
   * 설정창을 열 때 (`SettingsModal` 의 `onOpen`). 열 때마다 현재 값을 다시 칠한다 — FR-LVC-3 · FR-WBR-10 ·
   * FR-MMT-6 · FR-UXB-43 · FR-FSS-21: 다른 화면에서 바뀐 값이 이 모달에 옛 상태로 남아 있으면 사용자가 그것을
   * 켜진 줄로 읽는다. 숫자 입력란도 확정하지 않은 글자(`999` 를 치고 `Esc`)를 여기서 맞춘다. 포커스는 다음
   * 프레임에 오므로 여기서는 전부 칠해진다.
   *
   * 순서가 계약이다(INV-S3) — 모든 섹션을 돌지 않는다. profile 은 검색 비우기 뒤다(REFACTOR3_FE_ESC_SRS FR-FEE-9:
   * 종전 `#settings-btn` 클릭 리스너 셋의 실행 순서 — 검색 비우기 → 프로필 읽기 → 모바일 머리와 목록 화면).
   * 목록 화면은 열기·패널 칠하기 뒤여야 한다.
   */
  onOpen(modal){
    const app=this.app;
    this._hook('theme','onOpen');
    this._hook('shortcuts','onOpen');
    this._hook('presets','onOpen');
    this._hook('display','onOpen');
    app._paintSettingControls();
    app._labelSettingsRows();
    this._hook('claude','onOpen');
    if(app.isMobile&&app.drawerOpen) app._toggleDrawer(false);
    if(app._settingsSearchReset) app._settingsSearchReset();
    this._hook('profile','onOpen');
    app._settingsMobileOnOpen(modal);
  }

  /**
   * 탭을 골랐을 때 (`SettingsModal` 의 `onTab`). 고른 탭의 DOM 은 이미 바뀌었다. 탭별 재조회(sandbox·access·
   * profile·edges·telegram·server·claude)·code 탭의 관측·프리셋 목록은 그 섹션의 `onTab` 이다.
   */
  onTab(tab){ this._hook(tab,'onTab') }

  _hook(tab,name){
    const s=this.section(tab);
    if(s) s[name]();
  }
}
