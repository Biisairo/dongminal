/**
 * 설정의 기본값·범위 상수와 **그 기본값으로 시작하는 설정 전역**
 * (OPTIMIZE_REFACTOR_SRS FR-OPT-11-4 · FEC-25).
 *
 * 종전에는 같은 값이 `SETTINGS_SCHEMA` 와 상수(`constants.js`·`helpers.js`·
 * `constants-git*.js`)에 두 벌로 있었고, 두 벌이 같은지 보는 것이 없었다. 이제
 * 상수는 표에서 **파생한다** — 값을 고치는 자리는 표 한 줄이다 (FR-CFG-1).
 * 이름은 남는다: 기본값 상수로 부르는 자리(FR-PIS-11)와 e2e 가 그 이름을 본다.
 *
 * 설정 전역도 여기서 선다. 초기값이 곧 이 상수라 선언이 이 파일 **뒤**에만 설 수
 * 있고, 흩어 두면 그 파일이 표보다 먼저 실리는 날 로드가 죽는다.
 * `scripts/check-load-order.mjs` 가 그 순서를 지킨다.
 *
 * `web/js/test/settings-source.test.mjs`(TC-CFG-2x)가 파생과 선언 자리를 지킨다.
 *
 * 로드 순서: settings-schema.js 바로 뒤, constants.js 앞.
 */
const AGENTS_POLL_DEFAULT=SETTINGS_BY_KEY.agentsPollInterval.def;
const STATS_INTERVAL_DEFAULT=SETTINGS_BY_KEY.statsInterval.def;
const GIT_STATUS_POLL_MS=SETTINGS_BY_KEY.gitStatusInterval.def;
const GIT_REPOS_POLL_MS=SETTINGS_BY_KEY.gitReposInterval.def;
const GIT_CON_POLL_MS=SETTINGS_BY_KEY.gitConsoleInterval.def;
const TAB_WIDTH_DEFAULT=SETTINGS_BY_KEY.tabWidthPx.def;
const TAB_WIDTH_MIN=SETTINGS_BY_KEY.tabWidthPx.min;
const TAB_WIDTH_MAX=SETTINGS_BY_KEY.tabWidthPx.max;
const UFE_LEVEL_DEFAULT=SETTINGS_BY_KEY.focusEdgeLevel.def;
const UFE_LEVEL_MAX=SETTINGS_BY_KEY.focusEdgeLevel.max;
const ATTN_EDGE_LEVEL_DEFAULT=SETTINGS_BY_KEY.attnEdgeLevel.def;
const ATTN_EDGE_LEVEL_MAX=SETTINGS_BY_KEY.attnEdgeLevel.max;

/**
 * POLL_INTERVAL_SETTINGS_SRS FR-PIS-6·11: **상수는 기본값으로 남고 변수가 설정을
 * 든다.** 값을 얹는 자리는 `_settingsApply` 하나다 (FR-PIS-7).
 *
 * `agentsPollInterval` 의 저장 자리는 서버 설정이다 (FR-PIS-16 / D-3) — 종전의
 * `localStorage` 는 다른 브라우저 창에 전파되지 않았다.
 */
var agentsPollInterval=AGENTS_POLL_DEFAULT;
var statsInterval=STATS_INTERVAL_DEFAULT;
var gitStatusInterval=GIT_STATUS_POLL_MS;
var gitReposInterval=GIT_REPOS_POLL_MS;
var gitConsoleInterval=GIT_CON_POLL_MS;
/**
 * UNFOCUSED_EDGE_SRS FR-UFE-10·12·13 / ALERT_MOBILE_CONTEXT_SRS FR-AED-8·9: 가장자리
 * 표시 둘의 세기(0~10). `/api/settings` blob 에 실린다 — 취향 스위치가 기기마다
 * 어긋나면 같은 사람이 기기를 옮길 때마다 다시 끈다 (D-7).
 *
 * 기본이 0 이 아닌 것은 이 기능이 **모르는 사이 잘못 친 키**를 줄이기 위한 것이기
 * 때문이다 — 켜야만 보이는 안전장치는 그것이 필요한 사람에게 닿지 않는다.
 */
var focusEdgeLevel=UFE_LEVEL_DEFAULT;
var attnEdgeLevel=ATTN_EDGE_LEVEL_DEFAULT;
// TAB_WIDTH_SRS FR-TBW-2: 고정 폭. 켜고 끄는 `tabFixedWidth` 는 helpers.js 에 있다.
var tabWidthPx=TAB_WIDTH_DEFAULT;
