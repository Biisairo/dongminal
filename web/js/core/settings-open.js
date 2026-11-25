/**
 * 설정 창을 처음 열 때의 세우기 (PERF D-41, 3.4.9.2). `settings` 화면 묶음의 끝이다.
 *
 * `SettingsController.ready` 가 묶음을 실은 뒤 `settingsBuild` 를 한 번 부른다. 부팅 몫(`SETTINGS_BOOT`)은 부팅 때 이미 돌았다.
 */

/** `SETTINGS_INIT` 의 표지 — 설정 모달을 만들고 검색을 배선한다. */
const SETTINGS_INIT_MODAL='@modal';

/**
 * 열기 몫의 순서 (TC-FES-4). 섹션은 클래스, 문자열은 그 사이에 도는 init 의 앱에서 주인까지의 점 경로다
 * (REFACTOR3_FE_DELEG_SRS FR-DLG-3).
 *
 * 옛 표(부팅 때 한 번)에서 설정 창과 무관한 init 넷(`SETTINGS_BOOT`)을 뺀 나머지이고, 상대 순서는 그대로다:
 * `initSaveButtons` 는 패널들이 선 뒤여야 하고(FR-UXF-72), 모바일 설정의 탭 리스너(`_initSettingsMobile`, 옛 `initMobile`
 * 안)는 `SettingsModal` 의 것보다 뒤여야 한다(FR-MUX-20).
 */
const SETTINGS_INIT=[
  ThemeSection, SETTINGS_INIT_MODAL, ShortcutsSection, DisplaySection, TerminalSection, CodeSection,
  'settings.paint', BackupSection, SandboxSection, AccessSection, EdgesSection, ProfileSection,
  TelegramSection, ServerSection, ClaudeSection,
  'settings.saveState.initSaveButtons', StatusbarSection, PresetsSection, 'mobile.sheets._initSettingsMobile',
  NotifySection, PollingSection,
];

/** 표의 순서대로 세운다. `ctl.modal` 이 서면 끝난 것이다 — 한 번만 부른다. */
function settingsBuild(ctl){
  for(const step of SETTINGS_INIT){
    if(typeof step==='function') ctl.start(new step(ctl.app));
    else if(step===SETTINGS_INIT_MODAL){
      // REFACTOR3_FE_DIALOG_SRS FR-FED-10: 열기·닫기·탭 고르기는 `SettingsModal` 이 진다. 여기서 만들어야
      // `_initSettingsMobile` 의 탭 리스너가 그 뒤에 붙어 뒤에 돈다.
      const modal=document.getElementById('modal');
      ctl.modal=new SettingsModal({onOpen:()=>ctl.onOpen(modal),onTab:n=>ctl.onTab(n)}).init();
      ctl._bindSettingsSearch(modal);
    }
    else ctl._step(step);
  }
  return ctl;
}
