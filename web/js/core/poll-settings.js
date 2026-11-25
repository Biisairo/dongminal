/**
 * 폴링 주기 설정 — **주기가 한 화면에 나란히 선다** (POLL_INTERVAL_SETTINGS_SRS).
 *
 * 접수한 말은 "polling 이 한쪽에 모여있잖아? setting 에서 이 값을 조절할 수
 * 있도록" 이다. 앞부분은 이미 참이었다 — 주기의 진실은 `STATE_REGISTRY` 의 선언과
 * `constants-git.js` 의 상수 몇으로 모여 있었다. 참이 아니던 것은 뒷부분이다:
 * 다섯 중 둘만 화면에서 바꿀 수 있었고, 그 둘조차 서로 다른 탭에 있었다.
 * (PERF M1 뒤로 남은 주기는 둘 — `statsInterval`·`gitWorktreeInterval` 이다. 나머지는 채널 토픽이 대신한다.)
 *
 * **표 하나가 전부를 진다** (FR-PIS-6·7·10). 값을 읽는 자리·쓰는 자리·선택지·
 * 설명이 한 행에 있으므로, 주기를 더할 때 고치는 곳이 이 배열 하나다. 흩어 두면
 * `saveSettings` 의 키 목록과 `_settingsApply` 와 화면이 세 벌이 되고, 그중
 * 하나를 빠뜨린 실패는 다른 브라우저 창을 열어 보기 전까지 아무도 모른다.
 *
 * 키·범위·기본값은 여기 없다 — `SETTINGS_SCHEMA` 가 갖는다 (FR-CFG-1 · FR-OPT-11-4).
 * 선택지의 최소·최대가 표의 min·max 와 같은지는 `settings-source.test.mjs` 가 본다.
 *
 * 로드 순서 계약: settings-schema.js **뒤**, settings-table.js **앞**(`_settingsApply`
 * 가 이 표를 지난다).
 */

/**
 * 주기 하나의 서술자.
 *
 *   key       서버 설정의 키이자 `saveSettings` 가 싣는 이름
 *   id        `Polling` 탭에 서는 `<select>` 의 id
 *   label     사용자가 보는 이름
 *   hint      **무엇을 얼마나 자주 묻는지** (FR-PIS-21). 값 이름이 아니라 화면의 말이다
 *   get/set   전역 변수의 읽기·쓰기. 변수가 전역이라 표에서 이름만으로는 닿지 않는다
 *   opts      선택지 [ms, 라벨]. 주기마다 다르다 (D-6)
 */
const POLL_SETTINGS=[
  {
    key:'statsInterval', id:'pi-stats', label:t('poll.stats.label'),
    hint:t('poll.stats.hint'),
    get:()=>statsInterval, set:v=>{statsInterval=v},
    opts:[[1000,tn('core.dur_sec',1)],[2000,tn('core.dur_sec',2)],[3000,tn('core.dur_sec',3)],[5000,tn('core.dur_sec',5)],[10000,tn('core.dur_sec',10)],[30000,tn('core.dur_sec',30)]],
  },
  {
    // EDITOR_LIVE_RELOAD_SRS FR-ELR-76: 서버의 워크트리 회차 간격. 저장하면 서버가 다음 회차부터 쓴다.
    key:'gitWorktreeInterval', id:'pi-gitworktree', label:t('poll.git_worktree.label'),
    hint:t('poll.git_worktree.hint'),
    get:()=>gitWorktreeInterval, set:v=>{gitWorktreeInterval=v},
    opts:[[1000,tn('core.dur_sec',1)],[2000,tn('core.dur_sec',2)],[4000,tn('core.dur_sec',4)],[10000,tn('core.dur_sec',10)],[30000,tn('core.dur_sec',30)]],
  },
];

const POLL_BY_KEY=Object.fromEntries(POLL_SETTINGS.map(s=>[s.key,s]));
