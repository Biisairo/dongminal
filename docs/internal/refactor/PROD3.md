# 프로덕션 리팩토링 3차 — 조사 목록

> 2026-11-21 · `main` · 기준 커밋 `f433b371`
> 착수 문서: `docs/internal/REFACTOR_PROD3_HANDOFF.md`. 1차는 [`README.md`](README.md)(기준 `ba13ec92`), 2차는 [`PROD2.md`](PROD2.md)(기준 `fed7ef0e`)에 있다.
> 이 문서는 **조사 결과**다. 소스는 아직 한 줄도 고치지 않았다.

## 0. 범위와 방법

- **범위:** 프론트(`web/js`·`web/*.css`·`index.html`), 백(`internal/webserver/**`), 데몬·CLI(`internal/{daemon,shared,ctl,helper}`·`cmd`) 전부. 사용자가 정했다.
- **변화량:** `fed7ef0e..HEAD` 는 **357커밋**이다(`git log --oneline fed7ef0e..HEAD | wc -l`). `web`·`internal`·`cmd` 에서 1,003파일이 바뀌었고, +84,841줄, −14,471줄이다(`git diff --shortstat fed7ef0e..HEAD -- web internal cmd`).
- **방법:** 영역 여섯(FE core / FE 화면 / Go HTTP / Go 도메인 / 데몬·공유·CLI / 문서 대조)을 읽기 전용 조사로 나누어 보았다. 결함 후보 가운데 **확인** 열에 `✔메인` 이 붙은 것은 이 문서를 쓴 세션이 코드를 다시 읽어 확인한 것이다. `✔` 는 조사가 코드에서 확인한 것이고, `?` 는 추정이거나 재현하지 않은 것이다.
- **ID 앞머리:** `FC` FE core · `FU` FE 화면·CSS · `GH` Go HTTP · `GD` Go 도메인·hub · `DM` 데몬·공유·CLI · `DOC` 문서.
- **수의 출처:** 표의 개수는 대부분 grep 표본이다. 표본인 수에는 「표본」 이라고 적었다.

### 0.1. 인계서의 정정

| 인계서의 말 | 실제 |
|---|---|
| `fed7ef0e` 뒤 362커밋 | **357** (위 명령) |
| PROD2 #9·#10 은 "처리 방식 미정, 다시 묻는다" | **이미 처리됐다.** `SERVER_DRIVEN_ACTIONS_SRS`(승인·구현완료)가 서버 판정으로 옮겼다. `gitJobSlotsOf`·`GIT_JOB_COMMON_KEYS`·`GIT_JOB_INDEX_EXEMPT` 는 `web/js` 에 0곳이다(`menu.js:155` 의 「이전 동작」 주석만 남음). stash 판정은 Go `write.StashableCount` 하나이고, `check-server-driven.sh` 가 되살아남을 막는다. **다시 물을 것이 없다** |
| PROD2 §9 `_bgModalToggle` 주석이 `app-cmd.js` 를 가리킨다 | 이미 고쳐졌다(`4979072c`). 이름의 "Modal" 과 죽은 분기만 남았다(FC-16) |
| 1차 §7.3 D-STR-3 "dmctl 은 3계층, `serverconf` 가 `shared` 로 가야 한다" | 전제가 충족됐다. `serverconf` 는 `internal/shared/serverconf` 에 있고, `helper/runtimebin` 은 `shared/*`·`helper/toolline` 만 import 한다(DOC-20) |
| 1차 §7.3 빈 규칙 `.sc-list{}`·`.sb-settings{}` | 이미 없다. CSS 에 `{}` 가 0건이다 |

---

## 1. 결함 — 먼저 고칠 것

리팩토링보다 앞선다. 정확성·보안·계약 위반이다.

| ID | 종류 | 자리 | 현상 | 제안 | 규모 | 확인 |
|---|---|---|---|---|---|---|
| **FC-F1** | 보안(저장형 XSS) | `web/js/core/app-settings-theme.js` `_renderPreview` · 서버 `internal/shared/settingsschema/schema.go:199-202` | 저장된 `customTheme` 의 값(`u.sidebarBg`·`u.border`·터미널 팔레트)을 검증 없이 `innerHTML` 템플릿의 `style="…"` 에 넣는다. 서버는 `object` 인지만 본다. 따옴표가 든 값은 속성을 벗어나 마크업을 주입한다. 설정은 다른 기기로 방송된다 | 색은 `hexRgb` 를 통과한 것만 쓴다. 미리보기는 DOM API·`style.setProperty` 로 그린다. 서버도 `customTheme` 의 키별 값을 검증한다 | S~M | ✔메인 (공격 가능성은 설정 PUT 접근 제어에 달림 `?`) |
| **GD-F1** | 데이터 레이스 | `internal/webserver/domain/run/store_write.go:366` `ReapTargets` | Record 를 **얕게** 복사해 돌려준다. `Members`·`Worktree` 포인터가 저장소와 공유되고, 잠금 밖의 `reapRuns→cleanupWorktrees` 가 읽는 동안 `MarkWorktrees`·`mutateMember` 가 그 자리를 쓴다. 1차 H-1 의 `cloneRun` 처방이 이 경로에 닿지 않았다 | `cloneRun(r)` 로 복사한다. 이 경로를 치는 `-race` 시험을 더한다 | S | ✔메인 (재현은 안 함) |
| **GH-F4** | 레이스(덮어쓰기) | `internal/webserver/httpapi/handlers_files.go` `apiFileWrite` (스탬프 검사 :580 → 원자 쓰기) | 스탬프 검사와 쓰기 사이에 잠금이 없다(파일에 `Lock` 0건). 두 저장이 같은 스탬프를 보면 뒤의 쓰기가 앞을 덮는다. FR-EXC-5 가 막으려던 경우다 | 경로별 잠금으로 검사부터 쓰기까지 감싼다 | M | ✔메인 |
| **GH-F1** | 오류 계약 | `httpapi/handlers_toolio.go` `decodeJSONBody`·`writeToolIOError` (호출 49곳, 표본) · `handlers_lsp.go` | 1 MiB 를 넘는 본문이 `X-Error-Code: too_large` 로 나간다. 공개 계약(`features.md` 용량 표 「JSON 본문 → `body_too_large`」)과 다르다. 1차 H-4 가 `httperr` 쪽만 고친 재발이다 | 읽기 실패의 코드를 `bodyReadCode` 로 낸다. 시험을 더한다 | S | ✔메인 |
| **GH-F2** | 오류 계약 | `httpapi/handlers_fs.go` `fsDecode` · `gitapi/handlers_git_write.go` `gitDecodeBody` · `gitapi/handlers_git.go` `gitDecodeRawPath` | 같은 상한 초과에 fs 는 `400`+`bad_request`, git 은 `413`+`bad_request` 를 낸다. 계약은 `413`+`body_too_large` 다 | GH-F1 과 한 규칙으로 맞춘다 | S | ✔ |
| **GH-F3** | 정보 노출(경미) | toolio·fs·git 디코더, `apiFileWrite` | Go 오류 문구(`json: cannot unmarshal … httpapi.fsDeleteReq`)를 응답 본문에 싣는다. 내부 타입 이름이 드러난다 | 본문은 고정 문구로, 전문은 `dmlog` 로 보낸다 | S | ✔ |
| **GD-F2** | 블로킹·무한 증가 | `domain/telegram/bridge.go:122` `process` · `bridge_updates.go:15` · `bridge_events.go:103-131` | `b.mu` 를 쥔 채 HTTP 를 부른다(호출당 상한 15초). 그동안 업데이트 수신이 멈춘다. 알림 버튼 목록은 상한 없이 늘고, 걷을 때 버튼마다 HTTP 를 순차로 보낸다 | 전송은 잠금 밖에서 한다. 버튼 목록에 상한을 둔다 | M | ✔ (지연 실측 없음) |
| **GD-F3** | 중복 조회 | `domain/claudeacct/engine.go:271-289` `FetchNow` | 최소 간격 검사를 `e.busy` 잠금 **밖**에서 하고, 잠금을 얻은 뒤 다시 보지 않는다. 새로고침이 겹치면 두 번 조회한다 | 잠금을 얻은 뒤 다시 검사한다 | S | ✔ |
| **DM-F1** | 오류 삼킴 | `internal/helper/runtimebin/edit.go:44` | `dmctl edit` 이 응답 상태를 버려서 서버가 400/500 을 줘도 exit 0 이다 | `dmctlHTTPResult` 를 쓴다 | S | ✔메인 |
| **DM-F2** | 정화 누락 | `internal/daemon/chatsock/chatsock.go:539` `clean` | Cf(bidi 재정렬·zero-width)를 지우지 않는다. 같은 규칙의 다른 7벌은 지운다(DM-10). 결과는 이름·붙여넣기로 터미널에 찍힌다 | 공용 정화 함수로 바꾼다 | S | ✔메인 |
| FC-F2 | 표시 오류 | `core/app-layout.js:362`·`:386` · `core/app-chat-window.js:58-64` | 모바일 서랍을 닫는 두 경로가 상단바를 다시 그리지 않는다. ☰/✕ 아이콘이 낡을 수 있다 | FC-01 의 `closeDrawer()` 로 모은다 | S | ? (화면 확인 필요) |
| GH-F5 | 가용성 | `toolclient/client.go:622-672` `callWithin` | RPC 한 번이 5초를 넘으면 데몬 연결 전체를 끊고 다시 맞춘다. 느린 정상 호출이 연결을 흔들 수 있다 | 시한 초과는 그 호출만 실패시키고, 생존은 heartbeat 로 판정하도록 검토한다 | M | ? (빈도 미실측) |
| DM-F3 | 응답 해석 | `runtimebin/detach.go:157-175` | `Delivered` 가 없으면 0 으로 읽어 exit 1 이다. `dmctlDelivery` 는 "없으면 모른다" 로 읽는다. 규칙이 두 벌이다 | `dmctlDelivery` 로 통일한다 | S | ? |
| DM-F4 | 인코딩 | `runtimebin/dmctl_whoami.go:29` | `toolId` 를 이스케이프하지 않는다 | `url.QueryEscape` | S | ? (UUID 면 실해 없음) |
| DM-F5 | panic 가능 | `runtimebin/dmctl_account.go:217-223` | `--json` 에서 본문이 `null` 이면 nil map 에 대입한다 | 오류 검사 후 빈 객체로 시작한다 | S | ? |

---

## 2. 요청의 여덟 분류

### 2.1. 하드코딩 제거 (분류 1)

| ID | 자리 | 현상 | 제안 | 규모 |
|---|---|---|---|---|
| DM-12 | `internal/{daemon,shared,ctl,helper}`·`cmd` | `"/api/…"` 경로 리터럴 **89곳**(표본). 이름이 바뀌면 빌드가 아니라 실행 중 404 로 드러난다 | 경로 상수 한 벌 | M |
| DM-16 | `shared/humancmd/humancmd.go:27` | 도우미 소켓이 절대 경로로 고정이다. 다른 소켓은 home 에서 파생한다 | 플랫폼 transport 에서 얻는다 | S |
| GH-20 | `httpapi/handlers_fs_search.go:263` | rg JSON 줄 상한 `4<<20` 이 인라인이다 | 이름 있는 상수 | S |
| FU-19 | `ui/open-url.js:74` | `min(520px,90vw)` 를 JS 문자열에 박았다 | CSS 클래스로 | S |
| FU-9 | `web/style.css:875-876` | Activity 레일 숨김 목록이 한 선택자에 클래스 28개다. 새 클래스를 빠뜨리면 레일에 글자가 샌다. 그 가운데 죽은 선택자가 섞였다(DOC-15) | 죽은 것을 걷고, 숨김 대상에 표식을 달거나 게이트로 대조한다 | M |
| FC-12 | `core/app-settings-theme.js:206-267` | 테마 미리보기의 인라인 `style` 27줄(px·색) | `.pv-*` 클래스로. FC-F1 과 함께 | M |

### 2.2. 중복 로직 제거 (분류 2)

| ID | 자리 | 현상 | 제안 | 규모 |
|---|---|---|---|---|
| GH-2 | `httperr.go`·`handlers_toolio.go`·`handlers_whoami.go`·`handlers_runs.go`·`codefail.go`·`handlers_fs.go`·`handlers_files.go`·`gitapi/handlers_git.go`·`shared/edgenode`·`shared/edge` | 오류 응답 렌더러가 **11벌**이다. 각자 헤더를 세팅하고, 그것이 헤더 누락(GH-F1·F2)이 되풀이된 원인이다. `writeWhoAmIError` 는 `writeToolIOError` 와 바이트 단위로 같다(GH-1) | 방언을 인자로 받는 렌더러 하나. 방언별 바이트는 유지한다 | M |
| GH-3 | `httperr.go`·`codefail.go`·`handlers_toolio.go`·`handlers_fs.go`·`gitapi`×2·`handlers_lsp.go`·`edgenode` | 본문 디코더 래퍼 **8종**. 빈 본문 처리가 서로 다르다(`readJSONBody` 만 `{}` 로 바꿈) | `httpreq.DecodeJSON` 하나가 실패 종류를 돌려주고, 답은 방언이 한다 | M |
| GH-6 | `handlers_fs_search.go:429` `isBinary` ↔ `handlers_file_probe.go:62` | 이진 판정 두 벌. 편집기는 UTF-16 BOM 을 텍스트로, 검색은 이진으로 본다. 의도 기록이 없다 | 한 함수로. BOM 정책은 결정 필요(§6) | S |
| GH-7 | `gitapi/*.go` | `if s.Git == nil` 가드 16곳 | 라우트 등록 때 한 번 감싼다 | S |
| GH-8 | `apierr/codes_core.go:16`·`edgenode/node.go:56`·`edge/listener.go:143`·`edge/upgrade.go:99` | `"X-Error-Code"` 이름 4벌(하나는 리터럴) | shared 에 상수 하나 | S |
| GD-1·2 | `domain/worktree/remove.go:51-100`·`:127-159` | `Remove`·`RemoveListed` 전처리 중복, `worktree prune` 3번·`Stat` 2번 | 공통 전처리·`pruneAndCheckGone` | S |
| GD-3 | `worktree.go:235` ↔ `submodule.go:317` `runGit` | 1차 MED 쌍둥이가 그대로다 | core 에 한 벌 | S |
| GD-5 | `domain/wsentry/wsentry.go` | `homeFn` 기본값·`MkdirAll` 패턴 2~3곳 | 헬퍼 | S |
| DM-1 | `runtimebin` 9자리 | HTTP 응답 → 종료 코드 변환이 **9벌**(주석은 "세 자리" 라고 적음) | 상태→종료 코드 함수 하나에 종단별 거부 렌더러를 주입 | M |
| DM-2 | `dmctl_toolio.go:391`·`dmctl_run_http.go:70`·`dmctl_edge.go:344` | 거부 본문 렌더러 3벌. edge 용 `printRefusal` 을 account 가 빌려 쓴다 | 공통 파서 | S |
| DM-3 | `dmctl_listworkspace.go:38`·`:56`·`dmctl_rename_confirm.go:71` | `/api/state` 읽기 3벌, 실패 문구도 셋 | 읽기 함수 하나 | S |
| DM-4 | `dmctl_listworkspace.go:195-247` ↔ `shared/workspace/manager_parse.go:173` | 같은 순회·같은 JSON 모양 두 벌(주석은 의도라 적음) | 결정 필요(§6) | M |
| DM-5 | `runtimebin` 전반 | 인자 파싱 세 체계(`argSpec`·`parseSubArgs`·손 루프 10곳, 표본). 모르는 인자 문구도 셋 | `argSpec` 하나로 | M |
| **DM-7** | `shared/humancmd` ↔ `shared/chatwire` (`OpKill`·`OpKick`), `"hello"`·`"msg"` | IPC 상수가 여러 벌이다. 값이 어긋나면 `applyCmdLocked` 가 **조용히** 아무것도 하지 않는다 | 한 벌로, 어긋나면 실패하는 시험 | S |
| DM-6·8·9·10 | `edgenode`↔`edgemesh` `helloWait` · 형제 소켓 경로 3벌 · 이름 축약 4벌(지문 12·16자, 근거 없음) · Cf 정화 7벌 | 같은 규칙의 여러 벌 | shared 한 벌 | S |
| DM-17 | `shared/sandbox/runtime.go:119-181` | 같은 명령을 문자열·인자 배열로 두 번 적는다. OS 분기 3벌 | OS 표 하나에서 파생 | S |
| FC-01·02 | `core/app-mobile*.js`·`app-settings.js:437` | `_toggleDrawer(false); _rTopbar()` 쌍 5곳 복사. 서랍 상태가 필드·`body` 클래스·`#sidebar.open` 세 곳에서 따로 바뀐다 | `closeDrawer()`·`_setDrawer(open)` | S |
| FC-03 | `core/theme-vars.js:18-31` ↔ `core/contrast.js:55-60` | 색 거리 두 벌(제곱 RGB / redmean). `pickAccent2` 가 둘을 섞는다 | 한 메트릭. **알림색이 일부 테마에서 바뀌는 동작 변경**이다(§6) | M |
| FC-11 | `core/app-settings-claude.js:12-17` ↔ `claudeacct/autoswitch.go:73-78` | 자동 전환 범위가 JS·Go 두 벌, 대조 게이트 없음 | PROD2 §7a ② — 서버가 원천 | M |
| FC-13·14 | `#settings-btn` click 리스너 3개 · document Escape 처리기 4곳 | 실행 순서에 기댄다(주석으로만) | 열기 함수 하나 · `ui-kit` Escape 스택 | S~M |
| FU-1 | `app-activity.js:165` `actEl`·`app-chat.js:22` `chatEl`·`runs-panel.js:59·88` 외 7곳 | DOM 생성 헬퍼 10개. SVG 둘(`runSvg`·`meshSvg`)은 본문이 같다 | `core/helpers.js` 에 `domEl`·`svgEl` (계층 규칙상 ui-kit 이 아니라 core) | S |
| FU-18 | `style-runs.css:253` ↔ `style.css:2176` | `.bg-row` 두 파일 분산 | 한 파일로 | S |

### 2.3. 상수 분리 (분류 3)

| ID | 자리 | 현상 | 제안 | 규모 |
|---|---|---|---|---|
| GH-4·5·21 | 본문 상한 64 KiB 3벌·1 MiB 2벌 · NUL 검사 폭 `8000` 리터럴 3번 vs `binaryProbeLen` · fs 상한이 세 곳에 | 같은 값의 여러 이름 | 용도별 한 번, 한 표 | S |
| GH-19 | `toolclient/client.go:318` | 재접속 시작 백오프 `time.Second` 리터럴 | 이름 | S |
| GD-20 | `telegram/bridge.go:40·166`·`client.go:45`·`claudeacct/engine.go:637`·`dirlock.go:51` | 시간 값 다섯. `client.Timeout 70s` 는 `pollTimeout 50`(단위 없음)+20 인데 관계가 코드에 없다 | 이름, 파생 | S |
| DM-13·14·15 | 시간 상수 115줄/64파일(표본) · "떠 있나" 시한 6개(1·2·3·5초) · `humancmd.Info` 예산 두 벌 | 흩어진 예산 | 한 파일, 목적 두세 개로 | M |
| DM-11 | `dmenv` 머리말 vs `serverconf`·`updatecheck`·`ctl/cli/options.go`·`sandbox.go:279` | "이름은 여기 있다" 인데 밖에 넷, `sandbox` 는 문자열로 적는다 | `dmenv` 로 모은다 | S |
| FC-10 | `core/constants.js` 939줄 | 상수 파일에 함수 9개 | 쓰는 쪽으로 옮긴다 | M |
| FC-19·20·22 | `*1000` 환산·`after(50)` 류 · 타이밍 상수가 파일별 · 툴팁 리터럴 10곳(표본) | `constants*.js`·`TIP_*` 규약 밖 | 모은다 | S |
| FU-10 | `web/style*.css` | 간격 px 리터럴 **821건**(정규식 근사), 간격 토큰 0. `gap:6px` 68·`gap:8px` 63 | 간격 토큰 3~4단 → 치환 → 게이트 | L |

### 2.4. 쓸데없이 복잡한 로직 단순화 (분류 4)

| ID | 자리 | 현상 | 제안 | 규모 |
|---|---|---|---|---|
| GD-17 | `hub/gitwatch.go:706-787` `observe` | 잠금 3번, `need` 조건 4개, 전이가 함수 안에 묻혔다 | `need`·전이를 순수 함수로 떼고 시험 | M |
| GD-21 | `hub/gitwatch.go:354` `watchPhase` | 운영 호출 0(시험만) | 지운다 | S |
| FU-2~6 | `renderer-chrome.js:100` `_rWinTitle` · `history-load.js:201` `reloadRefs` · `panel-views.js:78` `_submodules` · `ui-kit.js:730` `menuOpen` · `cm-lsp.js:360` `unsubscribe` | 호출처 0 인 함수(뒤 둘은 `?`) | 확인 후 지운다 | S |
| FU-17 | `git/panel-changes.js:661-665` | 서브모듈 stage 금지를 화면만 판정한다(SERVER_DRIVEN 목록 밖의 C 부류) | 정책 결정 먼저(§6) | S |
| FC-15 | `core/app-agents.js:248-253` | `filter` 4번, `reconcileList` 3번 | 구역 표를 한 번 순회 | S |
| DM-24 | `ctl/cli/options.go:293-460` | `take`·`unknownFlag` 블록 6번 | 공통 적용기 | S |

### 2.5. 너무 큰 함수·클래스 분할 (분류 5)

| ID | 자리 | 크기 | 제안 | 규모 · 위험 |
|---|---|---|---|---|
| FC-04 | `core/app-settings.js` `initModal` | 135줄, 파일 500(게이트 경계) | `app-settings-modal.js` | M · L |
| FC-05 | `core/app-layout.js` | 975줄·메서드 44(저장소 최대), `delWindow` 108줄 | 창 / 탭 열기 / 탭 닫기 / 분할 / 사이드바 | M · M |
| FC-06·08 | `app-tool.js` `_pickSandbox` 155 · `app-statusbar.js` `updateStatusBar` 122 | 빌더 분리 | S · L |
| FC-07·09 | `app-ws-sync.js` `_applyRemoteWorkspace` 136 · `app.js` `save` 90·`_saveAdoptRemote` 88 | **먼저 순서·충돌을 시험으로 고정** | M · **H** |
| FU-12 | `git/remote.js` `GitRemote` | 약 680줄 클래스 | 실행·스트림 / 표시 | M · M |
| FU-13 | `ui/ui-kit.js` `UIKit` | 930줄 | modal·menu·drag·HUD 내부 모듈 | M · M |
| FU-14·15·16 | `lanes.js` `buildLaneGraph` ~180 · `panel-changes` `_buildChanges` 126·`_rowEl` 108 · `panel-poll` `_applyStatus` 120 · 100줄 안팎 6곳 | 분류(순수)와 그리기 | M · M |
| FU-11 | `web/style.css` 2,492줄 | CSS 는 크기 게이트가 없다(`check-file-size` 가 `web/js` 만) | 기준선 + 영역별 분할 | M · L |
| GH-13·14 | 80줄 넘는 함수 14개(표본; `apiRunSucceed` 131·`handleCommandSSE` 131·`handleCommandPost` 121·`apiGitStatus` 113) · `handlers_files.go` 749·`access.go` 744·`toolclient/client.go` 685 | 파싱·판정·렌더 / 주제별 파일 | M · M |
| GD-13~16·18 | `query/diff.go` 632 · `write/branch.go` 589 · `hub/gitwatch.go` 877 · `attn_tracker.go` 548 · `autoswitch.decide` 79줄 | 파일 분할(동작 불변) | M · M |
| DM-18 | `shared/platform/procinfo.go` 627 | 빌드 태그 없이 darwin·linux 가 한 파일 | 플랫폼별 파일 | M · L |
| DM-21·22·23 | `dmctl_account.go` 631 · `dmctl_listworkspace.go` 505 · `dmctl.go` 579(분기 셋 + 도움말 110줄) | 파일 분할, 명령 표 한 벌 | M · L |

### 2.6. 충분한 추상화 (분류 6)

| ID | 자리 | 현상 | 제안 | 규모 |
|---|---|---|---|---|
| GH-15 | `httpapi/server.go:82-228` `Server` | 필드 44개, 잠금 5개. `settingsMu` 하나가 access 와 sandbox 를 함께 잠근다 | 도메인별 하위 구조체와 각자의 잠금 | L · 위험 H |
| FU-8 | `style-panel.css`·`style.css` | 레일 상태 선택자 `:is(html.sb-collapsed body:not(.mobile) #sidebar, …)` 반복(style.css 14 · style-panel.css 6) | `data-rail` 속성 하나 | M |

### 2.7. 비슷한 로직을 하나의 클래스로 (분류 7)

| ID | 자리 | 현상 | 제안 | 규모 |
|---|---|---|---|---|
| **FU-20** | `web/js/ui/sidebar-tabs.js`(사이드바 탭 줄) ↔ `web/js/core/app-agents.js`(작업 패널 탭 줄) | **사용자 추가 요청(2026-11-21).** 두 패널 상단 탭의 동작이 아직 하나 다르다 — 글자(라벨) 표시 여부를 패널마다 따로 판정한다. 지금은 두 패널이 `UIKit.tabsFit`·`tabsFitWatch` 를 각자 부르고, 탭 정의·배지·스크롤 자리·직행 키도 각자 들고 있다(사이드바 `SB_TAB_DEFS`, 작업 패널 `_actTabsEl`·`_actTabsPaint`) | 패널 탭 줄을 **공통 패널 객체 하나**(탭 정의·라벨 판정·배지·스크롤 자리·직행 토글)로 만들고, 두 패널은 그것을 상속해 쓴다. 라벨 표시 규칙은 그 한 자리에서 정한다. **결정(2026-11-21): 글자 표시 규칙은 지금처럼 패널별**(자기 탭 줄에 라벨이 다 들어가면 보인다)이고, 그 판정·배선을 공통 패널 객체 한 자리로 옮긴다. 두 패널의 다른 동작은 그 한 자리를 지나며 사라져야 한다 — 구현 때 두 패널의 판정 시점(배지 변화·폭 변화·다시 그리기·모바일)을 나란히 대조해 실제 차이를 찾아 적는다 | M |
| GD-4 | `claudeacct/engine.go:609-650` ↔ `autoswitch.go:370-407` | 두 `Run` 의 wake 채널·ctx·타이머 루프가 같다 | 공용 루프에 `Tick` 주입 | M |
| GH-2·3 · DM-1·2 | (§2.2) | 오류 렌더러·디코더·종료 코드 변환 | 각각 한 타입으로 | M |

### 2.8. 사람의 가독성 (분류 8)

| ID | 자리 | 현상 |
|---|---|---|
| FC-16 · DOC-16 | `core/app-statusbar.js:258` `_bgModalToggle` | 모달 시절 이름. 인자를 넘기는 곳이 없어 `open===false` 분기가 죽었다 → `_bgPanelOpen` |
| FC-17 | `app-layout.js:2-5`·`app-git.js:2-5` | 머리 주석의 메서드 수가 낡았다(21→44, 23→48) |
| FC-18 | `app-settings.js:130` | 500줄 게이트를 맞추려고 짜낸 198자 한 줄 |
| GH-9 | `httpapi/httperr.go:69-79` | 주석의 코드 이름 `body_too_big` — 실제는 `body_too_large`(`SAFETY_CORRECTNESS_SRS:205-218` 도 같은 오기) |
| GH-23 | `toolclient/client.go` | 오류 문구의 옛 데몬 이름 `paned` |
| GD-19 | `hub/gitwatch.go:836` | 주석 "500ms 마다" — 실제 `GitWatchInterval` 1000ms |
| GD-22 | `hub/gitwatch.go:620` | `Watching()` 만 nil 가드가 없다 |
| DM-25·26 | `cmd/dongminal/app.go:51` 외 | `gitRoot context.Context` 라는 이름 · 주석이 다른 함수 위에 붙음 |
| DOC-13·14·17 | `apierr/inventory.go:97-104` · 코드 주석의 `파일:줄` 참조 | 없어진 함수 이름(`gitResetBlocked`), 파일 길이를 넘는 줄 참조 5개(35개 중), `app-agents.js:166` 의 낡은 주석 |

---

## 3. 성능 개선 후보 — 한 번에 처리할 목록

1차 §4 와 같은 방식이다. 지금 고치지 않고 모아 둔다. 묶음으로 처리할 때 측정 열의 방법으로 전후를 잰다. 전부 코드 읽기 추정이고 실측은 없다.

| # | ID | 자리 | 현상 | 측정 | 규모 |
|---|---|---|---|---|---|
| 1 | GH-17 | `httpapi` `fsOps` 전역 뮤텍스 | 세기(최대 1만 항목)와 복사·삭제 전 구간을 잡아, 다른 루트의 mkdir·이름 바꾸기가 모두 기다린다 | 큰 폴더 복사 중 mkdir 응답 시간 | M |
| 2 | GH-18 | `access.go` `apiAccessPut` → `refresh` | `settingsMu` 를 쥔 채 DNS 조회. 샌드박스 설정 PUT 이 그동안 기다린다 | 해석 지연 주입 후 sandbox PUT 지연 | S |
| 3 | GD-11 | `run.Store.save` | 변경마다 전체 Run 을 `json.Marshal`(1차 P3 의 남은 절반) | 저장 1회 바이트·alloc, Run 수별 | L |
| 4 | GD-7 | `query/diff.go` `diffBlobSide` | 블롭 한쪽마다 git 2회(`cat-file -s`+`show`), diff 한 번에 fork 4회 | diff 1회의 자식 프로세스 수 | M |
| 5 | GH-16 | `handlers_fs_search.go:348` | 파일마다 64 KiB `bufio` 를 새로 만들고 8000바이트만 본다 | 검색 1회의 alloc | S |
| 6 | GD-8 | `claudeacct/autoswitch.go` `Tick` | 회차마다 `ps -axo args=` fork | Tick 당 fork 수 | S |
| 7 | GD-9·23 | `claudeacct/engine.go` `setRow`·`Tick` | 행마다 전 행 `MarshalIndent`+fsync(잠금 안). 한 회차에 `accounts.json` 을 2~3번 다시 읽는다 | 회차당 쓰기·읽기 횟수 | S |
| 8 | GD-10 | `engine.go:213` | 계정 사이 250ms 를 `busy` 를 쥐고 `time.Sleep`, ctx 를 안 본다 — 종료가 N×250ms 늦는다 | 종료 신호 → Run 복귀 시간 | S |
| 9 | GD-6 | `wsentry.Roots` | 호출마다 `MkdirAll` 2번(1차 LOW 잔존) | 응답 경로의 시스템콜 수 | S |
| 10 | GD-12 | `telegram` `b.tabs` | 넣기만 하고 지우지 않는다 | 도구 N개 생성·종료 뒤 맵 크기 | S |
| 11 | DM-19 | `ctl/cli/proc.go` 정지 대기 | 정지 한 번에 `lsof` 최대 약 20회(darwin) | `stop` 1회의 자식 프로세스 수 | S |
| 12 | DM-20 | `dmctl rename-tab` 확인 | `/api/state` 를 최대 약 15회 GET, 매번 전체 디코딩 | 1회의 요청 수 | S |
| 13 | FC-21 | `app-statusbar.js` `_pollStats` | ping → stats 직렬 2왕복 | 회차당 왕복 | S |
| 14 | DM-27·28 | `daemon/ipc/paned.go:203` `MethodTerminate` · `chatsock.Serve` | `goSlow` 상한 우회로 고루틴이 요청 수만큼 · hello 전 연결은 `Close` 에서 안 닫힘(5초 상한) | 동시 terminate N건의 고루틴 수 | S |

---

## 4. 문서·기록에는 있으나 미구현·미흡·잘못 구현

**코드는 그대로 두고 문서를 고칠 것이 대부분이다.** 사내 규약대로 문서와 코드가 충돌하면 코드를 우선하고, 문서를 고칠지는 사용자가 고른다.

### 4.1. 미구현·미흡·잘못 구현 (코드 쪽)

| ID | 자리 | 내용 |
|---|---|---|
| DOC-6 | `UX_AUDIT_FIX_SRS` FR-UXF-85 | "사이드바 창 행 메뉴" 에 키캡을 단다고 적었지만 그 메뉴가 **없다**(`sidebar-list.js`·`sidebar-tabs.js` 에 `contextmenu` 0곳). 만들지, 범위 밖으로 둘지 결정 필요 |
| GH-11 | `httpapi/handlers_runs_actions.go` `runErrAnswer` · `handlers_runs.go:174` | `action.Answer.Why` 는 사유 **코드**인데 미분류 실패는 `err.Error()` 자유 문구가 들어간다 |
| GH-12 | `action/action.go:118` `EntityName` | 카탈로그 42개 ID 가운데 이것만 생산자가 없다 |
| GH-24 | `httpapi/access_denied.go:53` | 403 HTML 화면에 `X-Error-Code` 가 없다. FR-ERR-7 이 HTML 을 빼는지 확인 못 함 `?` |
| — | `git-ui-metrics.spec.ts` V80 | 사이드바 접기 단추 26px 가 하한 미달. HEAD 에서도 실패(인계서 확인) |
| — | `npm run -s unit` | 열 번에 두 번꼴로 1건 실패, 어느 시험인지 모름(인계서) |
| — | `settings.spec.ts` | "규칙에 맞지 않는 이름은 거절" 이 전량 실행에서만 실패, 원인 미조사 |
| — | V-LAY-1 | `linux`·`win32` 기준선은 사용자가 `layout-baseline` 워크플로를 돌려야 한다 |
| — | PROD2 #8 · TC-SLP-6 | Windows statusLine 미실측(그대로) |

### 4.2. 문서가 낡았거나 틀림 (문서 쪽)

| ID | 자리 | 내용 |
|---|---|---|
| DOC-1 | `UIUX_OVERHAUL_SRS:852·867` FR-SEM-1 | "working = `--term-green`" — D-43 으로 `--accent2` |
| DOC-2 | `scripts/check-i18n-html.mjs:16-19` | "설정 탭 열둘과 모달 제목은 `lang="en"`" — 실제 5곳 |
| DOC-3 | `docs/external/shortcuts.md:6` | "저장소·Editor 행" — Editor 탭은 합쳐졌다. 채팅 탭에서 순회 키가 아무 일도 안 한다는 말이 없다 |
| DOC-4 | `DESIGN_TOKENS_SRS:430` `--z-sticky` 표 · `style-git.css:391-395` | 없어진 `.git-files-bar` 를 센다. **죽은 CSS 규칙 둘**(`.git-files-bar`·`.git-files-spacer`)이 남았다 |
| DOC-5 | `architecture.md:329·483-494` · `sidebar-tabs.js:1` | 탭 이름 `Windows·Git·Editor` — 실제 `windows·repo·chat`. `_rLists` 자리는 `renderer-chrome.js` |
| DOC-7 | `UX_AUDIT_FIX_SRS:4·546·568·607` | 「남은 것」 이 이미 끝난 7묶음을 적고, §3.12~3.14 상태가 "스펙" 인데 구현됐다 |
| DOC-8 | `UIUX_OVERHAUL_SRS:4` | 「남은 것: M6(FR-CHR)」 — 다음 날 커밋으로 처리된 것으로 보인다. FR 단위 대조 필요 `?` |
| DOC-9 | `CHAT_WINDOW_SRS` FR-CW-24·TC-CW-11 | "180px 미만이면 아이콘만" — FR-UXF-98(D-35)로 대체됐다는 표시가 없다 |
| DOC-10·11 | `docs/external/features.md:295` vs `:337`, `:340` vs `:338` | 같은 문서 안에서 서로 뒤집는다(라벨 폭 규칙, 카드 순서 — 철회된 FR-UXF-12 를 그대로 적음) |
| DOC-12 | `CHANGELOG.md [Unreleased]` | 서로 뒤집는 항목 4쌍(실행 중 색, 카드 자리, 모바일 상태바, Activity 새로고침 단추). 릴리스 전에 최종 동작 기준으로 합쳐야 한다 |
| DOC-18 | `SERVER_DRIVEN_ACTIONS_SRS` FR-SDA-70~73 | 동작 이름이 실제 ID(`sandbox.runtime.start`·`term.upload`·`file.convert_utf8`)와 다르다 |
| DOC-19 | `refactor/SERVER_DRIVEN_INVENTORY.md` F-A3·F-A6·F-B2 | 이미 처리된 항목을 미처리로 적는다(GH-10 · FU-7) |
| DOC-20 | `STRUCTURE_CLEANUP_SRS` D-STR-3 · `refactor/README.md:295` · `refactor/HANDOFF.md:343` | "dmctl 3계층" — 전제 충족(§0.1) |
| GH-9 | `SAFETY_CORRECTNESS_SRS:205-218` | `body_too_big` 오기 |

### 4.3. 게이트의 사각지대 (문서 쪽 어긋남이 새는 길)

- `check-srs-progress.sh` 는 「남은 것」 줄이 **있는지만** 본다. `승인·구현완료` 는 아무것도 확인하지 않는다(DOC-7·8).
- 절 안의 `> 상태: 스펙` 을 보는 검사가 없다(DOC-7).
- 뒤 SRS·결정이 앞 FR 을 뒤집어도 앞 문서에 표시가 남지 않는다(DOC-1·9).
- `features.md` 본문과 `CHANGELOG` 의 자기 모순을 보는 검사가 없다(DOC-10~12).
- 코드 주석의 `파일:줄`·함수 이름 참조를 보는 검사가 없다(DOC-13·14).
- CSS 파일 크기 기준선이 없다(FU-11).

---

## 5. 이미 처리됐음을 확인한 것 (다시 하지 않는다)

- 1차 H-1 `run.Store` 조회의 잠금 밖 노출 — `Get`·`List`·`MemberByTool`·`FindMember` 는 `cloneRun` 으로 복사한다. **`ReapTargets` 만 빠졌다**(GD-F1).
- 1차 H5 `TimerHub._tick` 콜백 예외 — `_safe`·`try/finally`.
- 1차 H1 슬롯 0·1 만 보는 정리 — `slotKeysOf` 가 `SLOT_MAX` 전체를 돈다.
- 상한 없는 본문 읽기 — 비테스트 코드에 `io.ReadAll(r.Body)`·`json.NewDecoder(r.Body)` 0건.
- SSE 작성기는 `sse.Start` 하나로 통일됐다.
- `innerHTML` 템플릿 13곳(표본)은 값을 `textContent`·`escHtml` 로 넣는다. 마크다운은 DOMPurify 를 거친다. **FC-F1 의 테마 미리보기가 예외다.**
- `innerHTML=''` 전량 재생성은 `PERFORMANCE_BUDGET.md` §2-5-1 등록부와 `check-repaint` 가 지킨다.

---

## 6. 사용자가 정해야 하는 것

목록에서 이 항목들은 **결정 전에 고치지 않는다.**

| # | 항목 | 갈림길 |
|---|---|---|
| Q1 | FC-03 색 거리 통일 | **결정(2026-11-21): redmean 하나로 통일한다.** 바뀌는 테마와 이전/새 색을 SRS 에 적는다 |
| Q2 | GH-6 UTF-16 BOM | **결정(2026-11-21): 둘 다 텍스트로 본다.** 검색도 BOM 이 있는 UTF-16 을 건너뛰지 않는다(동작 변경 — 기록) |
| Q3 | FU-17 서브모듈 stage 금지 | **결정(2026-11-21): 서버도 막고 server-driven 으로 옮긴다** |
| Q4 | DM-4 workspace 순회 두 벌 | **결정(2026-11-21): `shared/workspace` 로 합친다** |
| Q5 | DOC-6 FR-UXF-85 창 행 메뉴 | **결정(2026-11-21): FR 에서 「사이드바 창 행 메뉴」 를 지운다.** 메뉴는 만들지 않는다 |
| Q6 | §4.2 문서 수정 | **결정(2026-11-21): 전부 코드 기준으로 고친다**(P7) |
| Q7 | `UX_REMAINING` §7 받아들인 한계 다섯 | **결정(2026-11-21): 다시 본다.** P7 뒤에 하나씩 바꿀지 묻는다 |

---

## 7. 진행 순서

**결정(사용자, 2026-11-21):** 아래 묶음을 **전부** 진행한다. 묶음 사이에는 간단한 시험(관련 단위·`make gates` 등)만 돌리고, 전체 시험(e2e 전량 포함)은 모든 묶음이 끝난 뒤 한 번 돌린다. 묶음마다 커밋하고 푸시는 하지 않는다.

1차의 묶음 방식을 따른다. 묶음마다 SRS(중·대) → RED → 구현 → `make gates`·`npm run -s unit`·`typecheck`·`go test ./...` → 관련 e2e. 묶음 경계에서 사용자 확인 뒤 커밋한다.

| 묶음 | 내용 | 근거 | 위험 |
|---|---|---|---|
| **P1 결함** | §1 의 `✔` 결함 열: FC-F1 · GD-F1 · GH-F4 · GH-F1·F2·F3 · GD-F2·F3 · DM-F1·F2. `?` 결함(FC-F2·GH-F5·DM-F3~F5)은 재현부터 | 정확성·보안 | M |
| **P2 중복·추상화(Go)** | GH-2·3(오류 렌더러·디코더 한 벌) · DM-1·2·3·5 · DM-7 IPC 상수 · DM-6·8·9·10 · GD-1~5 · GH-7·8 | 패턴 A 의 재발 원인 | M |
| **P3a 프론트 객체 모델** | **사용자 강조(2026-11-21): 프론트의 객체화·공통화가 가장 중요하다.** 프레임워크 없이 파일마다 따로 구현한 화면 부품을 계열별로 모아 공통 기반 클래스(부품 계층)를 세운다. **방향 결정(사용자, 2026-11-21): 단순히 파일을 나누는 것이 아니라, 다른 프레임워크처럼 각 구조를 클래스로 만들고 상속받아 나눠 쓰고 다시 쓰는 구조를 만든다. 파일도 클래스 단위로(클래스 하나 = 파일 하나) 정리한다.** 계열 조사와 클래스 계층 설계안을 먼저 내고 확인받은 뒤 P3 를 그 설계로 진행한다. FU-20 이 첫 적용 사례다 | 사용자 요청 | M~H |
| **P3 중복·추상화(FE)** | **FU-20 패널 공통 객체(사용자 요청)** · FC-01·02 · FU-1 · FC-13·14·15 · FU-8·9 · FU-2~6 죽은 코드 | | M |
| **P4 상수·하드코딩** | §2.1·§2.3 (FU-10 간격 토큰은 크기가 커서 따로) | | L |
| **P5 큰 파일·함수 분할** | §2.5 · GH-15. 위험 H 인 FC-07·09 는 시험 고정을 먼저 | 동작 불변 | M |
| **P6 성능 한 묶음** | §3 의 14건, 전후 측정과 함께 | 요청 | M |
| **P7 문서 동기화 + 게이트** | §4.2 전부 · §4.3 게이트 · 가독성 §2.8 | 요청 | L |
| 별도 | FU-10 간격 토큰(821건) · §6 결정 항목 | | — |
| P8 | `UX_REMAINING` §7 받아들인 한계 다섯을 하나씩 다시 본다(Q7) | 사용자 결정 | — |

### 7.1. 진행 기록

| 묶음 | 커밋 | 내용 |
|---|---|---|
| P1 | `08922b9b` | `REFACTOR3_DEFECTS_SRS` — §1 의 ✔ 결함 아홉. GH-F3 은 git 디코더의 의도된 설계라 P2 로, GH-F5 는 설계 검토라 P5 로, DM-F3~F5 는 실제로 일어나지 않아 P2(DM-1)로 넘겼다 |
| P2 | `56dffed0` · `d94b16bd` · `a0372852` · `994d9805` (합침 `cef773f3`) | `REFACTOR3_DEDUP_GO_SRS` — GA 오류 응답·디코더 · GB `dmctl` · GC 공유·데몬 · GD 도메인. 남긴 것과 이유는 그 SRS §6 |
| P3a 0~2 | `6a30fc80` · `d8b92b63` | `REFACTOR3_FE_BASE_SRS` — `core/base/`(Component·View·Controller 외), Panel·TabBar 계층과 두 패널·서랍·탭 줄. FU-20 의 사용자 보고 차이는 실측으로 재현하지 못했다(판정 결과 차이 0, 경로·시점만 달라 `TabBar.fit` 으로 모음) — 사용자에게 화면·조작을 묻는다 |
| P3a 3 | (이 커밋) | `REFACTOR3_FE_DIALOG_SRS` — `Dialog` 아래 `KitModal`(`UIKit.modal` 본체)·`GitModalBase`→`GitConfirm`·`GitDialog`·`SettingsModal`. FC-04 의 열기·닫기·탭 고르기 부분(`initModal` 135 → 8줄, 나머지 `_init*` 나열은 단계 8), FU-13 의 모달 부분(`ui-kit.js` 934 → 817). git 모달 키는 맨 위일 때만 |
| P3a 4 | (이 커밋) | `REFACTOR3_FE_LIST_SRS` — `ListView` 아래 `SidebarList`(객체 → 서술자별 인스턴스)·`GitListTab`(`git-list-tab.js`). 나머지 `reconcileList` 호출 약 20곳은 각 부품의 단계(5·7·9)에서 |
| P3a 5 | (이 커밋) | `REFACTOR3_FE_GITVIEW_SRS` — `GitView`(`git/git-view.js`) 아래 Stash·Branches·History·Console·Commit·RemoteList·GitListTab. 세대 가드 세 종류를 `ticket`/`superseded`/`stale` 한 벌로, 루트는 모두 `el`(`gitViewMounted` 삭제), `GitListTab` 은 `ListView` 를 부품(`rows`)으로. `remote.js` 를 클래스마다 넷으로(FU-12 의 파일 분할, `GitRemote` 안 나누기는 단계 7) |
| P4·P5·P6 (Go) | 합침 `b13406a3`·`9ab7c188`·`1af24478` | `REFACTOR3_GO_STRUCT_SRS` — SH·SD·SC. 남은 것: FR-RGS-1 |

---

## 8. 한계 — 보지 못한 것

- **실행하지 않았다.** 빌드·`make gates`·e2e 를 돌리지 않았다(`go vet` 과 `go test -race ./internal/webserver/domain/run/...` 만 돌렸고, 둘 다 통과했다). 결함의 재현은 하나도 하지 않았다.
- **심볼 도구를 쓰지 못했다.** Serena 는 프로젝트가 활성화되지 않아 실패했고, 조사는 grep·정독으로 참조를 셌다. 호출 수·죽은 코드 판정은 표본이다.
- **정독하지 않은 곳:** Go 도메인 `ext`·`lsp`·`sysstat`·`git/store`·`git/jobs`·`telegram` 렌더 · `gitapi` 의 branch·write 핸들러 본문 · `edgemesh/mesh.go`·`daemon/chat/service.go`·`edge/config.go`·`runtime/install.go` · FE `app-git.js`·`app-slots.js`·`app-ws-sync.js` 본문.
- **문서 대조는 표본이다.** 바뀐 SRS 73개를 FR 단위로 모두 대조하지 않았다. `M8_UNIFIED`·`WORDING_COLOR`·`RELEASE`·`ISSUE_AGENT_TREE`·`CLAUDE_ACCOUNTS`·`PEER_CHAT` 의 미참조 FR 은 개별로 보지 않았다.
- **XSS 는 표본이다**(템플릿 13곳 + 테마 미리보기). 전수 감사가 아니다.
- **Windows·linux 쪽 동작은 이 기계에서 확인할 수 없다.**
