/**
 * Dongminal — **변경 감지 2계층**의 상수 (FE_MODULE_BOUNDARY_SRS FR-FMB-1).
 *
 * 무엇을 얼마나 자주 묻는가 (GIT_SRS §3.3 / FR-GIT-18~24). 주기 상수와 그것을
 * 담는 가변 전역이 여기 함께 산다 — `POLL_SETTINGS` 가 `get/set` 으로만 닿으므로
 * (`app-polling.js:30`) 선언이 어느 파일이든 호출부는 바뀌지 않는다 (FR-FMB-4).
 *
 * 절과 그 앵커: 변경 감지 2계층(GIT_SRS §3.3 / FR-GIT-18~24).
 */

// **셋이었다가 둘이 됐다** (POLL_INTERVAL_SETTINGS_SRS FR-PIS-1).
//
// 걷어낸 것은 브라우저의 signature 폴링(`GIT_SIGNATURE_POLL_MS`)이다. 서버가
// signature 를 감시해 바뀌었을 때만 `git_changed` 를 방송하면서(FR-GPO-1) 기본이
// 0(꺼짐)이 되었고, 그 뒤로 **한 번도 켜지지 않은 채** 감지 전부가 성립했다 —
// `git-push-observe` B-1~B-5 와 `git-polling` P1~P9 가 그 증거다. 남겨 두면 설정에
// 손잡이가 달리고, 켜지는 순간 그 SRS 가 없앤 60초당 120회 요청이 되살아난다.
//
// 서버 쪽 signature 는 그대로다 — `StartGitWatch` 와 `/api/git/signature` 종단은
// push 의 근거이며, status 응답이 실어 오는 `_lastSig` 도 남는다 (FR-PIS-3).
//
// FR-GPO-20: status 폴링은 **안전망**이다. 두 가지를 겸한다 —
// 푸시가 끊겼을 때의 회복(C-5)과 관심 표명의 갱신(FR-GPO-11 의 90초보다 세 배
// 잦다). 종전 1초는 푸시가 없을 때의 주기였다.
const GIT_STATUS_POLL_MS=30000;

// UX_BATCH9_SRS FR-GLR-2: 관측이 주기의 몇 배까지 낡으면 멈춘 것으로 보는가.
//
// 둘이면 한 회차를 통째로 걸러도 아직 정상이다 — 느린 응답이나 한 번의 실패로
// 워치독이 깨어나면 그것이 새로운 요청원이 된다 (R-B9-1).
const GIT_WATCHDOG_FACTOR=2;

// 워치독 검사 자체의 문턱. 렌더는 잦고 판정은 싸지만, 같은 프레임에 여러 번
// 그리는 경로가 있으므로 한 번으로 접는다.
//
// GIT_LIVE_TRIGGERS_SRS FR-GLW-4: 이 값은 **주기이기도 하다** — `_initGitSection`
// 의 `git.watchdog` job 이 같은 값으로 돈다. 문턱과 주기가 같은 값인 덕에 두 계기
// (렌더·주기)가 겹쳐도 검사는 이 간격당 한 번을 넘지 않는다.
const GIT_WATCHDOG_CHECK_MS=1000;
// status 요청 하나의 시한 (FR-RMS-29). 큰 저장소의 `git status` 가 몇 초일 수 있으니
// 넉넉하되, 백오프 상한(GIT_FAIL_BACKOFF_MAX_MS)보다는 짧다 — 시한이 그보다 길면
// 실패가 주기를 늘리기 전에 다음 회차들이 먼저 밀린다.
const GIT_STATUS_FETCH_TIMEOUT_MS=20000;
/**
 * 쓰기 한 번의 시한 (GIT_REFRESH_LIFECYCLE_SRS FR-GRF-6 · D-GRF-9).
 *
 * **읽기보다 길고, 서버의 상한보다도 길다.** 서버는 git 실행 하나에
 * `core.DefaultTimeout = 30s` 를 건다 — 클라이언트가 그보다 먼저 끊으면 **쓰기는
 * 실제로 일어나는데 화면은 실패로 읽는다.** 그것이 이 계층에서 가장 나쁜 결과다
 * (사용자가 같은 쓰기를 두 번 낸다).
 *
 * 그래서 서버가 먼저 포기하게 두고, 이 값은 **답이 아예 오지 않는 연결**만
 * 걷어내는 그물로 쓴다.
 */
const GIT_WRITE_FETCH_TIMEOUT_MS=35000;
// 즉시 신호는 몰아서 온다 — 셸 훅·에디터 저장·포커스 복귀가 겹친다. 하나로 합쳐
// status 를 연발하지 않게 한다 (FR-GIT-20).
const GIT_SIGNAL_DEBOUNCE_MS=150;
/**
 * 실패했을 때의 주기 (GIT_REPO_MISSING_SRS FR-RMS-13·23).
 *
 * 소실은 **확정된 사실**이므로 점증할 이유가 없다 — 곧바로 이 값으로 간다.
 * 그 밖의 실패는 일시적일 수 있으므로 기준 × 2ⁿ 으로 늘린다.
 *
 * **D-RMS-9(상한을 하나로 맞춘다)는 2026-09-12 에 철회됐다** — 상한과 기준 주기가
 * 같아지면서 백오프가 산술적으로 무효가 됐기 때문이다 (`GP-13`). 근거였던 "가장
 * 느릴 때가 화면마다 다르면 사용자가 두 가지 규칙을 배운다" 는, 백오프가 아예
 * 동작하지 않는 것과 견주면 작은 값이다. 자세한 것은 `GIT_FAIL_BACKOFF_MAX_MS`.
 */
const GIT_REPO_MISSING_POLL_MS=30000;
/**
 * GIT_REFRESH_LIFECYCLE_SRS FR-GRF-30 / D-GRF-6 (`GP-13`): 백오프 상한.
 *
 *   이전 동작: 30000 — 기준 주기와 **같았다.** `min(30000*2ⁿ, 30000)` 은 n 이
 *             무엇이든 30000 이므로 백오프가 기본 설정에서 **무효**였다
 *             (10초 설정에서만 1단계가 동작했다)
 *   새  동작: 300000 (5분). 30초 기준에서 30 → 60 → 120 → 240 → 300 초로 는다
 *   이유:     `GIT_PUSH_OBSERVE_SRS` FR-GPO-24 가 약속한 "실패가 이어지면
 *             뜸해진다" 는 여전히 옳다. 무효했던 것은 **상한값**이지 조항이
 *             아니다 — 기준 주기가 1초일 때 만들어진 상수 쌍이 30초로 올라가며
 *             뜻을 잃었다
 *
 * 소실(`GIT_REPO_MISSING_POLL_MS`)과 값이 갈린 것은 의도된 것이다. 소실은
 * **확정된 사실**이고 그 복구는 30초마다 물어야 알 수 있다 (FR-RMS-26). 그 밖의
 * 실패는 확정이 아니므로 점증한다.
 */
const GIT_FAIL_BACKOFF_MAX_MS=300000;
// 안내에 실을 재확인 주기 (초). 상수에서 파생한다 — 두 곳에 적으면 갈린다.
const GIT_RMS_AUTO_NOTE=(GIT_REPO_MISSING_POLL_MS/1000)+
  '초마다 다시 확인합니다 — 폴더가 돌아오면 자동으로 복구됩니다';
/**
 * 주기는 설정으로 덮을 수 있다 (FR-GIT-23) — statsInterval 과 같은 방식이다.
 *
 * POLL_INTERVAL_SETTINGS_SRS FR-PIS-6·11: **상수는 기본값으로 남고 변수가 설정을
 * 든다.** 아래 셋이 같은 모양이며, 값을 얹는 자리는 `_settingsApply` 하나다
 * (FR-PIS-7) — 여기서 다시 읽는 코드를 만들지 않는다.
 */
var gitStatusInterval=GIT_STATUS_POLL_MS;
var gitReposInterval=GIT_REPOS_POLL_MS;
// `gitConsoleInterval` 은 `constants-git-diff.js` 에 있다 — `GIT_CON_POLL_MS` 선언
// **뒤**여야 하고(`const` 의 TDZ), 그 상수가 Console 절의 것이기 때문이다.
