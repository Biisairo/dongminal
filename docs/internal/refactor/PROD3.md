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
| **FC-F1** | 보안(저장형 XSS) | `web/js/core/settings-theme.js` `_renderPreview` · 서버 `internal/shared/settingsschema/schema.go:199-202` | 저장된 `customTheme` 의 값(`u.sidebarBg`·`u.border`·터미널 팔레트)을 검증 없이 `innerHTML` 템플릿의 `style="…"` 에 넣는다. 서버는 `object` 인지만 본다. 따옴표가 든 값은 속성을 벗어나 마크업을 주입한다. 설정은 다른 기기로 방송된다 | 색은 `hexRgb` 를 통과한 것만 쓴다. 미리보기는 DOM API·`style.setProperty` 로 그린다. 서버도 `customTheme` 의 키별 값을 검증한다 — **처리함**: 화면은 P1 `08922b9b`(`REFACTOR3_DEFECTS_SRS` FR-RD3-1~4 `sanitizeCustomTheme`)와 R3b `26bafe55`(FC-12 미리보기), 서버는 `QUALITY_GO_SRS` QG-2 `63197fa7` — `PUT /api/settings` 가 색이 아닌 `customTheme` 값을 `400` · `bad_request` 로 거절하고, `dongminal config` 검증도 같은 규칙 | S~M | ✔메인 (공격 가능성은 설정 PUT 접근 제어에 달림 `?`) |
| **GD-F1** | 데이터 레이스 | `internal/webserver/domain/run/store_write.go:366` `ReapTargets` | Record 를 **얕게** 복사해 돌려준다. `Members`·`Worktree` 포인터가 저장소와 공유되고, 잠금 밖의 `reapRuns→cleanupWorktrees` 가 읽는 동안 `MarkWorktrees`·`mutateMember` 가 그 자리를 쓴다. 1차 H-1 의 `cloneRun` 처방이 이 경로에 닿지 않았다 | `cloneRun(r)` 로 복사한다. 이 경로를 치는 `-race` 시험을 더한다 — **처리함 (P1 `08922b9b`, `REFACTOR3_DEFECTS_SRS` FR-RD3-10)**: `cloneRun` 으로 복사 | S | ✔메인 (재현은 안 함) |
| **GH-F4** | 레이스(덮어쓰기) | `internal/webserver/httpapi/handlers_files.go` `apiFileWrite` (스탬프 검사 :580 → 원자 쓰기) | 스탬프 검사와 쓰기 사이에 잠금이 없다(파일에 `Lock` 0건). 두 저장이 같은 스탬프를 보면 뒤의 쓰기가 앞을 덮는다. FR-EXC-5 가 막으려던 경우다 | 경로별 잠금으로 검사부터 쓰기까지 감싼다 — **처리함 (P1 `08922b9b`, `REFACTOR3_DEFECTS_SRS` FR-RD3-20~22)**: 경로별 참조 계수 잠금 | M | ✔메인 |
| **GH-F1** | 오류 계약 | `httpapi/handlers_toolio.go` `decodeJSONBody`·`writeToolIOError` (호출 49곳, 표본) · `handlers_lsp.go` | 1 MiB 를 넘는 본문이 `X-Error-Code: too_large` 로 나간다. 공개 계약(`features.md` 용량 표 「JSON 본문 → `body_too_large`」)과 다르다. 1차 H-4 가 `httperr` 쪽만 고친 재발이다 | 읽기 실패의 코드를 `bodyReadCode` 로 낸다. 시험을 더한다 — **처리함 (P1 `08922b9b`, `REFACTOR3_DEFECTS_SRS` FR-RD3-30·31)**: `apierr.BodyReadCode` 한 자리 | S | ✔메인 |
| **GH-F2** | 오류 계약 | `httpapi/handlers_fs.go` `fsDecode` · `gitapi/handlers_git_write.go` `gitDecodeBody` · `gitapi/handlers_git.go` `gitDecodeRawPath` | 같은 상한 초과에 fs 는 `400`+`bad_request`, git 은 `413`+`bad_request` 를 낸다. 계약은 `413`+`body_too_large` 다 | GH-F1 과 한 규칙으로 맞춘다 — **처리함 (P1 `08922b9b`, `REFACTOR3_DEFECTS_SRS` FR-RD3-32·33)**: 모두 `413` · `body_too_large` | S | ✔ |
| **GH-F3** | 정보 노출(경미) | toolio·fs·git 디코더, `apiFileWrite` | Go 오류 문구(`json: cannot unmarshal … httpapi.fsDeleteReq`)를 응답 본문에 싣는다. 내부 타입 이름이 드러난다 | 본문은 고정 문구로, 전문은 `dmlog` 로 보낸다 — **처리함 (`QUALITY_GO_SRS` QG-1, `b7785b53`)**: 고정 문구에 요청 자리(`paths: number 값은 맞지 않다`)만 잇고 전문은 `dmlog`. git 핀 저장 실패도 고정 문구. git stderr 꼬리는 사용자가 읽을 이유라 그대로(D-QG-2) | S | ✔ |
| **GD-F2** | 블로킹·무한 증가 | `domain/telegram/bridge.go:122` `process` · `bridge_updates.go:15` · `bridge_events.go:103-131` | `b.mu` 를 쥔 채 HTTP 를 부른다(호출당 상한 15초). 그동안 업데이트 수신이 멈춘다. 알림 버튼 목록은 상한 없이 늘고, 걷을 때 버튼마다 HTTP 를 순차로 보낸다 | 전송은 잠금 밖에서 한다. 버튼 목록에 상한을 둔다 — **처리함**: 잠금 밖 전송·버튼 상한 32 는 P1 `08922b9b`(`REFACTOR3_DEFECTS_SRS` FR-RD3-40~42), 걷기를 상한 4 의 병렬로(버튼 32개, 요청당 100ms 에서 3.26s → 0.82s)는 `QUALITY_GO_SRS` QG-3 `5c48bccf` | M | ✔ (지연 실측 없음) |
| **GD-F3** | 중복 조회 | `domain/claudeacct/engine.go:271-289` `FetchNow` | 최소 간격 검사를 `e.busy` 잠금 **밖**에서 하고, 잠금을 얻은 뒤 다시 보지 않는다. 새로고침이 겹치면 두 번 조회한다 | 잠금을 얻은 뒤 다시 검사한다 — **처리함 (P1 `08922b9b`, `REFACTOR3_DEFECTS_SRS` FR-RD3-50·51)** | S | ✔ |
| **DM-F1** | 오류 삼킴 | `internal/helper/runtimebin/edit.go:44` | `dmctl edit` 이 응답 상태를 버려서 서버가 400/500 을 줘도 exit 0 이다 | `dmctlHTTPResult` 를 쓴다 — **처리함 (P1 `08922b9b`, `REFACTOR3_DEFECTS_SRS` FR-RD3-60)** | S | ✔메인 |
| **DM-F2** | 정화 누락 | `internal/daemon/chatsock/chatsock.go:539` `clean` | Cf(bidi 재정렬·zero-width)를 지우지 않는다. 같은 규칙의 다른 7벌은 지운다(DM-10). 결과는 이름·붙여넣기로 터미널에 찍힌다 | 공용 정화 함수로 바꾼다 — **처리함 (P1 `08922b9b`, `REFACTOR3_DEFECTS_SRS` FR-RD3-70)**. 공용 정화 한 벌은 P2 GC `994d9805` | S | ✔메인 |
| FC-F2 | 표시 오류 | `core/app-layout.js:362`·`:386` · `core/app-chat-window.js:58-64` | 모바일 서랍을 닫는 두 경로가 상단바를 다시 그리지 않는다. ☰/✕ 아이콘이 낡을 수 있다 | FC-01 의 `closeDrawer()` 로 모은다 — **처리함** (P1 FR-RD3-80 · P3a 2 `DrawerSheet`: 닫기 다섯 곳이 한 길로 상단바를 다시 그린다) | S | ? (화면 확인 필요) |
| GH-F5 | 가용성 | `toolclient/client.go:622-672` `callWithin` | RPC 한 번이 5초를 넘으면 데몬 연결 전체를 끊고 다시 맞춘다. 느린 정상 호출이 연결을 흔들 수 있다 | 시한 초과는 그 호출만 실패시키고, 생존은 heartbeat 로 판정하도록 검토한다 — **유지(결정, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-8 · SH `6cb999d1`)**: DAEMON_SPLIT_SRS FR-14 가 요구하고, `ping` 은 처리 중이면 건너뛰므로 무응답 데몬을 찾는 수단이 이 시한뿐이며, 옛 데몬은 요청을 읽기 루프에서 처리해 한 호출이 막히면 뒤 호출도 막힌다 | M | ? (빈도 미실측) |
| DM-F3 | 응답 해석 | `runtimebin/detach.go:157-175` | `Delivered` 가 없으면 0 으로 읽어 exit 1 이다. `dmctlDelivery` 는 "없으면 모른다" 로 읽는다. 규칙이 두 벌이다 | `dmctlDelivery` 로 통일한다 — **처리함 (P2 GB `a0372852`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-26)** | S | ? |
| DM-F4 | 인코딩 | `runtimebin/dmctl_whoami.go:29` | `toolId` 를 이스케이프하지 않는다 | `url.QueryEscape` — **처리함 (P2 GB `a0372852`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-26)** | S | ? (UUID 면 실해 없음) |
| DM-F5 | panic 가능 | `runtimebin/dmctl_account.go:217-223` | `--json` 에서 본문이 `null` 이면 nil map 에 대입한다 | 오류 검사 후 빈 객체로 시작한다 — **처리함 (P2 GB `a0372852`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-26)** | S | ? |

---

## 2. 요청의 여덟 분류

### 2.1. 하드코딩 제거 (분류 1)

| ID | 자리 | 현상 | 제안 | 규모 |
|---|---|---|---|---|
| DM-12 | `internal/{daemon,shared,ctl,helper}`·`cmd` | `"/api/…"` 경로 리터럴 **89곳**(표본). 이름이 바뀌면 빌드가 아니라 실행 중 404 로 드러난다 | 경로 상수 한 벌 — **처리함 (SC `d60365c6`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-40)**: `shared/apipath`(상수 61, 리터럴 92곳), 서버 라우트와의 대조 시험 | M |
| DM-16 | `shared/humancmd/humancmd.go:27` | 도우미 소켓이 절대 경로로 고정이다. 다른 소켓은 home 에서 파생한다 | 플랫폼 transport 에서 얻는다 — **처리함 (유지 결정, SC `f0849a42`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-42)**: darwin 전용 특권 도우미라 고정 경로가 맞다는 이유를 주석에 적었다 | S |
| GH-20 | `httpapi/handlers_fs_search.go:263` | rg JSON 줄 상한 `4<<20` 이 인라인이다 | 이름 있는 상수 — **처리함 (SH `b429a39a`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-5)** | S |
| FU-19 | `ui/open-url.js:74` | `min(520px,90vw)` 를 JS 문자열에 박았다 | CSS 클래스로 — **처리함 (R2, `324d7922`)**: 같은 꼴 9줄을 `ui-modal-sm·md·lg` 로, `KitModal` 의 `width` 삭제 | S |
| FU-9 | `web/style.css:875-876` | Activity 레일 숨김 목록이 한 선택자에 클래스 28개다. 새 클래스를 빠뜨리면 레일에 글자가 샌다. 그 가운데 죽은 선택자가 섞였다(DOC-15) | 죽은 것을 걷고, 숨김 대상에 표식을 달거나 게이트로 대조한다 — **처리함 (R4a, `3f3df12a`)**: `.ag-title`·`.ag-refresh` 를 걷고, 레일 숨김 목록(`[data-rail]` 의 `display:none`)의 클래스 25개를 JS·HTML 과 대조하는 시험 TC-FR4-5(`REFACTOR3_FE_REST4_SRS` D-FR4-9·10) | M |
| FC-12 | `core/settings-theme.js`(옛 `app-settings-theme.js`) `_renderPreview` | 테마 미리보기의 인라인 `style` 27줄(px·색) | `.pv-*` 클래스로. FC-F1 과 함께 — **처리함 (R3b, `26bafe55`)**. 인라인 `style` 45곳 → 0. 골격은 팔레트 값이 섞이지 않는 고정 문자열(`THEME_PREVIEW_HTML`), 색은 `themePreviewVars` 의 `--pv-*` 변수. 계산된 스타일 그대로 | M |

### 2.2. 중복 로직 제거 (분류 2)

| ID | 자리 | 현상 | 제안 | 규모 |
|---|---|---|---|---|
| GH-2 | `httperr.go`·`handlers_toolio.go`·`handlers_whoami.go`·`handlers_runs.go`·`codefail.go`·`handlers_fs.go`·`handlers_files.go`·`gitapi/handlers_git.go`·`shared/edgenode`·`shared/edge` | 오류 응답 렌더러가 **11벌**이다. 각자 헤더를 세팅하고, 그것이 헤더 누락(GH-F1·F2)이 되풀이된 원인이다. `writeWhoAmIError` 는 `writeToolIOError` 와 바이트 단위로 같다(GH-1) | 방언을 인자로 받는 렌더러 하나. 방언별 바이트는 유지한다 — **처리함 (P2 GA `d94b16bd`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-2·3·4)**: `httpresp.Fail`·`FailCode` 한 렌더러, 방언 바이트는 골든으로 그대로 | M |
| GH-3 | `httperr.go`·`codefail.go`·`handlers_toolio.go`·`handlers_fs.go`·`gitapi`×2·`handlers_lsp.go`·`edgenode` | 본문 디코더 래퍼 **8종**. 빈 본문 처리가 서로 다르다(`readJSONBody` 만 `{}` 로 바꿈) | `httpreq.DecodeJSON` 하나가 실패 종류를 돌려주고, 답은 방언이 한다 — **처리함 (P2 GA `d94b16bd`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-5)**: `httpreq.DecodeJSON`. `lspReadBody` 는 상한 상수만 공유(그 SRS §6) | M |
| GH-6 | `handlers_fs_search.go:429` `isBinary` ↔ `handlers_file_probe.go:62` | 이진 판정 두 벌. 편집기는 UTF-16 BOM 을 텍스트로, 검색은 이진으로 본다. 의도 기록이 없다 | 한 함수로. BOM 정책은 결정 필요(§6) — **처리함 (P2 GA `d94b16bd`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-9)**: 한 함수, 검색도 UTF-16 BOM 을 텍스트로(Q2) | S |
| GH-7 | `gitapi/*.go` | `if s.Git == nil` 가드 16곳 | 라우트 등록 때 한 번 감싼다 — **처리함 (P2 GA `d94b16bd`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-8)**: 라우트 `needGit` 으로 10곳. 본문 검증이 가드보다 먼저인 처리기는 400 이 503 이 되므로 감싸지 않음(그 SRS §6) | S |
| GH-8 | `apierr/codes_core.go:16`·`edgenode/node.go:56`·`edge/listener.go:143`·`edge/upgrade.go:99` | `"X-Error-Code"` 이름 4벌(하나는 리터럴) | shared 에 상수 하나 — **처리함 (P2 GA `d94b16bd`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-1)**: `httpresp.CodeHeader` 하나, 리터럴 검사 시험 | S |
| GD-1·2 | `domain/worktree/remove.go:51-100`·`:127-159` | `Remove`·`RemoveListed` 전처리 중복, `worktree prune` 3번·`Stat` 2번 | 공통 전처리·`pruneAndCheckGone` — **처리함 (P2 GD `56dffed0`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-60)**: `prepareRemove`·`pruneAndCheckGone` | S |
| GD-3 | `worktree.go:235` ↔ `submodule.go:317` `runGit` | 1차 MED 쌍둥이가 그대로다 | core 에 한 벌 — **처리함**: 실행·결합은 P2 GD `56dffed0`(`REFACTOR3_DEDUP_GO_SRS` FR-RDG-61, `core.ExecUnguardedText`), 남은 감싸개 두 벌은 `QUALITY_GO_SRS` FR-QG-50 `036e184a`(`core.UnguardedTextRunner` 하나, 호출처 게이트가 새 진입점도 본다) | S |
| GD-5 | `domain/wsentry/wsentry.go` | `homeFn` 기본값·`MkdirAll` 패턴 2~3곳 | 헬퍼 — **처리함 (P2 GD `56dffed0`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-63)**: `wsentry.home`·`ensureRoot` | S |
| DM-1 | `runtimebin` 9자리 | HTTP 응답 → 종료 코드 변환이 **9벌**(주석은 "세 자리" 라고 적음) | 상태→종료 코드 함수 하나에 종단별 거부 렌더러를 주입 — **처리함 (P2 GB `a0372852`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-20)**: `httpExit`+`exitRule`, 골든 `httpexit.golden` | M |
| DM-2 | `dmctl_toolio.go:391`·`dmctl_run_http.go:70`·`dmctl_edge.go:344` | 거부 본문 렌더러 3벌. edge 용 `printRefusal` 을 account 가 빌려 쓴다 | 공통 파서 — **처리함 (P2 GB `a0372852`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-21)**: `parseRefusal` | S |
| DM-3 | `dmctl_listworkspace.go:38`·`:56`·`dmctl_rename_confirm.go:71` | `/api/state` 읽기 3벌, 실패 문구도 셋 | 읽기 함수 하나 — **처리함 (P2 GB `a0372852`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-22)**: `fetchState` | S |
| DM-4 | `dmctl_listworkspace.go:195-247` ↔ `shared/workspace/manager_parse.go:173` | 같은 순회·같은 JSON 모양 두 벌(주석은 의도라 적음) | 결정 필요(§6) — **처리함 (P2 GB `a0372852`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-23, Q4)**: `shared/workspace` 한 벌, 골든 `listworkspace.golden` | M |
| DM-5 | `runtimebin` 전반 | 인자 파싱 세 체계(`argSpec`·`parseSubArgs`·손 루프 10곳, 표본). 모르는 인자 문구도 셋 | `argSpec` 하나로 — **처리함**: 모르는 인자 문구 하나는 P2 GB `a0372852`(`REFACTOR3_DEDUP_GO_SRS` FR-RDG-24), `send-input`·`msg`·`detach` 의 손 루프는 `QUALITY_GO_SRS` FR-QG-53 `cdd38aa9`(골든 전후 — detach 의 `=` 형·빈 `--at` 만 바뀜). 남김: `parseSubArgs`(edge·account) — 플래그 표·한 줄표 위치 인자(`-5`)·값 빠짐 문구가 다른 체계라 옮기면 출력이 바뀐다 | M |
| **DM-7** | `shared/humancmd` ↔ `shared/chatwire` (`OpKill`·`OpKick`), `"hello"`·`"msg"` | IPC 상수가 여러 벌이다. 값이 어긋나면 `applyCmdLocked` 가 **조용히** 아무것도 하지 않는다 | 한 벌로, 어긋나면 실패하는 시험 — **처리함 (P2 GC `994d9805`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-41)**: kill·kick 원천은 `humancmd`, 대조 시험 | S |
| DM-6·8·9·10 | `edgenode`↔`edgemesh` `helloWait` · 형제 소켓 경로 3벌 · 이름 축약 4벌(지문 12·16자, 근거 없음) · Cf 정화 7벌 | 같은 규칙의 여러 벌 | shared 한 벌 — **처리함 (P2 GC `994d9805`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-40·42·43·44)**: `edgemesh.HelloWait` · `platform.SiblingSocket` · `shared/termtext` | S |
| DM-17 | `shared/sandbox/runtime.go:119-181` | 같은 명령을 문자열·인자 배열로 두 번 적는다. OS 분기 3벌 | OS 표 하나에서 파생 — **처리함 (P2 GC `994d9805`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-46)**: OS 표 하나 | S |
| FC-01·02 | `core/app-mobile*.js`·`app-settings.js:437` | `_toggleDrawer(false); _rTopbar()` 쌍 5곳 복사. 서랍 상태가 필드·`body` 클래스·`#sidebar.open` 세 곳에서 따로 바뀐다 | `closeDrawer()`·`_setDrawer(open)` — **처리함** (§7.1 P3a 2: 서랍 상태는 `DrawerSheet` 한 자리, 닫기 경로는 모두 `_toggleDrawer(false)` → `DrawerSheet.setOpen`) | S |
| FC-03 | `core/theme-vars.js:18-31` ↔ `core/contrast.js:55-60` | 색 거리 두 벌(제곱 RGB / redmean). `pickAccent2` 가 둘을 섞는다 | 한 메트릭. **알림색이 일부 테마에서 바뀌는 동작 변경**이다(§6) — **처리함 (R1, `8ab87528`)**: redmean 하나, Ayu Mirage 알림색·실행 중 색이 바뀐다 | M |
| FC-11 | `core/app-settings-claude.js:12-17` ↔ `claudeacct/autoswitch.go:73-78` | 자동 전환 범위가 JS·Go 두 벌, 대조 게이트 없음 | PROD2 §7a ② — 서버가 원천 — **처리함 (R1, `a51da4bb`)**: autoswitch 응답의 `ranges`. 계정 행 칸은 남음 | M |
| FC-13·14 | `#settings-btn` click 리스너 3개 · document Escape 처리기 4곳 | 실행 순서에 기댄다(주석으로만) | 열기 함수 하나 · `ui-kit` Escape 스택 — **처리함** (§7.1 P3a 6, `REFACTOR3_FE_ESC_SRS`) | S~M |
| FU-1 | `app-activity.js:165` `actEl`·`app-chat.js:22` `chatEl`·`runs-panel.js:59·88` 외 7곳 | DOM 생성 헬퍼 10개. SVG 둘(`runSvg`·`meshSvg`)은 본문이 같다 | `core/helpers.js` 에 `domEl`·`svgEl` (계층 규칙상 ui-kit 이 아니라 core) — **처리함** (§7.1 P3a 0~2) | S |
| FU-18 | `style-runs.css:253` ↔ `style.css:2176` | `.bg-row` 두 파일 분산 | 한 파일로 — **처리함 (R4a, `fb874af4`)**: 바탕 규칙을 `style-runs.css` 의 bg-kill 절 앞으로. 계산된 스타일 그대로 | S |

### 2.3. 상수 분리 (분류 3)

| ID | 자리 | 현상 | 제안 | 규모 |
|---|---|---|---|---|
| GH-4·5·21 | 본문 상한 64 KiB 3벌·1 MiB 2벌 · NUL 검사 폭 `8000` 리터럴 3번 vs `binaryProbeLen` · fs 상한이 세 곳에 | 같은 값의 여러 이름 | 용도별 한 번, 한 표 — **처리함**: 64 KiB·1 MiB 는 P2 GA `d94b16bd`(`REFACTOR3_DEDUP_GO_SRS` FR-RDG-6 `httpreq.SmallLimit`·`DefaultLimit`), fs 상한 표는 SH `b429a39a`(`fs_limits.go`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-5), NUL 검사 폭 8000 은 `QUALITY_GO_SRS` FR-QG-52 `0296bf2d`(`editorlimit.BinarySniffBytes` 하나 — 편집기·검색·diff) | S |
| GH-19 | `toolclient/client.go:318` | 재접속 시작 백오프 `time.Second` 리터럴 | 이름 — **처리함 (SH `b429a39a`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-5)** | S |
| GD-20 | `telegram/bridge.go:40·166`·`client.go:45`·`claudeacct/engine.go:637`·`dirlock.go:51` | 시간 값 다섯. `client.Timeout 70s` 는 `pollTimeout 50`(단위 없음)+20 인데 관계가 코드에 없다 | 이름, 파생 — **처리함 (SD `7d7891f8`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-23)**: 클라이언트 시한은 `pollTimeout` 에서 파생 | S |
| DM-13·14·15 | 시간 상수 115줄/64파일(표본) · "떠 있나" 시한 6개(1·2·3·5초) · `humancmd.Info` 예산 두 벌 | 흩어진 예산 | 한 파일, 목적 두세 개로 — **처리함 (SC `f0849a42`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-41)**: `runtimebin/budgets.go`, "떠 있나" 시한은 목적 둘, `humancmd.DefaultTimeout` 하나 | M |
| DM-11 | `dmenv` 머리말 vs `serverconf`·`updatecheck`·`ctl/cli/options.go`·`sandbox.go:279` | "이름은 여기 있다" 인데 밖에 넷, `sandbox` 는 문자열로 적는다 | `dmenv` 로 모은다 — **처리함 (P2 GC `994d9805`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-45)**. 남았던 문자열 셋은 SC `44ba911f` | S |
| FC-10 | `core/constants.js` 939줄 | 상수 파일에 함수 9개 | 쓰는 쪽으로 옮긴다 — **처리함 (R2, `49136bd7`)**: 서버 상한은 새 `core/server-meta.js`, 사이드바 폭은 `input-binding.js`, 샌드박스 문구는 `tool-controller.js`, `agentsWidthOk` 은 호출 0 이라 삭제 | M |
| FC-19·20·22 | `*1000` 환산·`after(50)` 류 · 타이밍 상수가 파일별 · 툴팁 리터럴 10곳(표본) | `constants*.js`·`TIP_*` 규약 밖 | 모은다 — **처리함 (R2, `b3fe9935`)**: 전수는 `REFACTOR3_FE_REST2_SRS` §2.6. `MS_PER_SEC`, 주기 상수 넷 → `constants.js`, 지연 이름 다섯, `TIP_*` 열일곱. 남김: `CLAUDE_ACCT_POLL_MS`(등록부만 싣는 페이지) · 서술자 표·`diag.js` 의 툴팁 | S |
| FU-10 | `web/style*.css` | 간격 px 리터럴 **821건**(정규식 근사), 간격 토큰 0. `gap:6px` 68·`gap:8px` 63 | 간격 토큰 3~4단 → 치환 → 게이트 — **처리함 (R4b, `92c59b26`·`6d46d4e1`·`d05e001a`·`0efcb302`)**: 토큰 여덟 단, 치환 822 · 붙이기 105 · 예외 20, 게이트 `check-spacing.mjs` (`REFACTOR3_FE_REST4_SRS` §2.5) | L |

### 2.4. 쓸데없이 복잡한 로직 단순화 (분류 4)

| ID | 자리 | 현상 | 제안 | 규모 |
|---|---|---|---|---|
| GD-17 | `hub/gitwatch.go:706-787` `observe` | 잠금 3번, `need` 조건 4개, 전이가 함수 안에 묻혔다 | `need`·전이를 순수 함수로 떼고 시험 — **처리함 (SD `7d7891f8`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-22)**: 판정 순수 함수 셋 | M |
| GD-21 | `hub/gitwatch.go:354` `watchPhase` | 운영 호출 0(시험만) | 지운다 — **처리함 (SD `7d7891f8`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-23)**: 지우고 시험은 `phaseHash` 로 | S |
| FU-2~6 | `renderer-chrome.js:100` `_rWinTitle` · `history-load.js:201` `reloadRefs` · `panel-views.js:78` `_submodules` · `ui-kit.js:730` `menuOpen` · `cm-lsp.js:360` `unsubscribe` | 호출처 0 인 함수(뒤 둘은 `?`) | 확인 후 지운다 — **넷 처리함** (§7.1 P3a 0~2. `_rWinTitle` 은 `_rWinTitleParts` 로 살아 있어 죽은 것이 아니었다). `cm-lsp.js` `unsubscribe` 는 **남김 (R2)** — 호출처 0 이 아니다. 번들 `cm.js` 의 `LSPClient.connect`·`disconnect` 가 부른다(`REFACTOR3_FE_REST2_SRS` D-FR2-9). 같은 R2 에서 앱 호출 0 인 `UIKit.tabsFitWatch` 를 지웠다(`854590b2`) | S |
| FU-17 | `git/panel-changes.js:661-665` | 서브모듈 stage 금지를 화면만 판정한다(SERVER_DRIVEN 목록 밖의 C 부류) | 정책 결정 먼저(§6) — **처리함 (R1, `19f60b6a`)**: 서버 판정·409 `submodule_inner_only`·행 답 `rowActions` | S |
| FC-15 | `core/app-agents.js:248-253` | `filter` 4번, `reconcileList` 3번 | 구역 표를 한 번 순회 — **처리함 (R2, `854590b2`)**: 한 번 훑어 구역 넷으로. `reconcileList` 는 받는 곳이 셋이라 세 번 그대로 | S |
| DM-24 | `ctl/cli/options.go:293-460` | `take`·`unknownFlag` 블록 6번 | 공통 적용기 — **처리함 (P2 GB `a0372852`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-25)** | S |

### 2.5. 너무 큰 함수·클래스 분할 (분류 5)

| ID | 자리 | 크기 | 제안 | 규모 · 위험 |
|---|---|---|---|---|
| FC-04 | `core/app-settings.js` `initModal` | 135줄, 파일 500(게이트 경계) | `app-settings-modal.js` — **처리함** (§7.1 P3a 3·8: 열기·닫기·탭은 `SettingsModal`, `_init*` 나열은 `SettingsController` 의 표 하나. `initModal` 은 한 줄, `app-settings.js` 386줄) | M · L |
| FC-05 | `core/app-layout.js` | 975줄·메서드 44(저장소 최대), `delWindow` 108줄 | 창 / 탭 열기 / 탭 닫기 / 분할 / 사이드바 — **파일은 처리함** (P3a 9: `layout-*.js` 아홉). `delWindow` 108줄은 **처리함 (R3b, `61f2e97b` 시험 고정 · `4a418d40`)** — 단계 메서드 넷, 코드 56 → 13 | M · M |
| FC-06·08 | `app-tool.js` `_pickSandbox` 155 · `app-statusbar.js` `updateStatusBar` 122 | 빌더 분리 — **처리함 (R2, `7cfe190b`)**: 41줄·22줄, 순수 판정 셋은 단위 시험 | S · L |
| FC-07·09 | `ws-sync-controller.js`(옛 `app-ws-sync.js`) `_applyRemoteWorkspace` 136 · `app.js` `save` 90·`_saveAdoptRemote` 88 | **먼저 순서·충돌을 시험으로 고정** — **처리함 (R3a, `0d4af0dc` 시험 고정 · `94d73ccd` FC-07 · `18aa0a35` FC-09)**. 시험 `ws-apply-save.test.mjs` 가 호출 순서·충돌 갈래 26가지를 나누기 전 동작으로 고정했다. 적용기는 순수 판정 넷(`layout-tree.js`)과 단계 메서드 다섯으로 136 → 40줄, 저장은 순수 판정 넷과 `_savePut`·`_adoptRemote`·`_saveBackoff` 로 `save` 90 → 34줄·`_saveAdoptRemote` 88 → 14줄 | M · **H** |
| FU-12 | `git/remote.js` `GitRemote` | 약 680줄 클래스 | 실행·스트림 / 표시 — **파일 분할은 처리함** (P3a 5: `remote-list`·`remote-add`·`remote-opts`). `GitRemote` 안 나누기는 **처리함 (R3b, `ccb4da87`)** — 칠하기는 `GitRemoteView`(`remote-view.js`), `remote.js` 704 → 482줄 | M · M |
| FU-13 | `ui/ui-kit.js` `UIKit` | 930줄 | modal·menu·drag·HUD 내부 모듈 — **modal·menu 처리함** (P3a 3·6, 930 → 695줄). drag·HUD 도 **처리함 (R3b, `ed802920`)** — `SizeDrag`(`size-drag.js`)·`SizeHud`(`size-hud.js`), `ui-kit.js` 685 → 582줄 | M · M |
| FU-14·15·16 | `lanes.js` `buildLaneGraph` ~180 · `git-changes.js`(옛 `panel-changes`) `_buildChanges` 126 · `git-change-rows.js` `_rowEl` 108 · `git-poll.js`(옛 `panel-poll`) `_applyStatus` 120 · 100줄 안팎 6곳 | 분류(순수)와 그리기 — **처리함 (R3b, `b40a3086` FU-14 · `47a00334` FU-15·16)**. 넷 다 순수 판정과 단계로(코드 121 → 5 · 73 → 22 · 60 → 28 · 32 → 9). 100줄 안팎 나머지 넷(`version-watch` 익명 · `_makeTab` · `file-tree` constructor · `_renderThemePanel`)은 **남김** — 고정 시험부터 세워야 한다(`REFACTOR3_FE_REST3_SRS` D-FR3-14) | M · M |
| FU-11 | `web/style.css` 2,492줄 | CSS 는 크기 게이트가 없다(`check-file-size` 가 `web/js` 만) | 기준선 + 영역별 분할 — **처리함 (R4a, `8e87010d`)**: `check-file-size.mjs` 가 `web/*.css` 도 잰다(`CSS 500줄초과=4 · 최대=824`). `style.css` 2,539줄을 원래 순서의 연속 구간 여덟(268~385줄)으로, `<link>` 순서가 캐스케이드를 지킨다. 계산된 스타일 그대로 | M · L |
| GH-13·14 | 80줄 넘는 함수 14개(표본; `apiRunSucceed` 131·`handleCommandSSE` 131·`handleCommandPost` 121·`apiGitStatus` 113) · `handlers_files.go` 749·`access.go` 744·`toolclient/client.go` 685 | 파싱·판정·렌더 / 주제별 파일 — **GH-13 처리함 (`37e36bcd` · `6cc3e9cd` · `66a37fda`)**: 다시 잰 HTTP 처리기 14개를 모두 80줄 아래로, 판정 순수 함수에 표 주도 시험 30개, httpapi PASS 이름 빠짐 0(`REFACTOR3_GO_STRUCT_SRS` FR-RGS-1 · `deniedPageHTML` 과 domain 셋은 남김 D-RGS-3). **GH-14 처리함** (SH 묶음 FR-RGS-2: 파일 셋 분할) | M · M |
| GD-13~16·18 | `query/diff.go` 632 · `write/branch.go` 589 · `hub/gitwatch.go` 877 · `attn_tracker.go` 548 · `autoswitch.decide` 79줄 | 파일 분할(동작 불변) — **처리함**: 파일 넷은 SD `8c2cc91d`(`REFACTOR3_GO_STRUCT_SRS` FR-RGS-21), `decide` 는 SD `7d7891f8`(FR-RGS-22, `autoTrigger`·`inCooldown`·`switchFirst`) | M · M |
| DM-18 | `shared/platform/procinfo.go` 627 | 빌드 태그 없이 darwin·linux 가 한 파일 | 플랫폼별 파일 — **처리함 (SC `c2389f95`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-43)**: 플랫폼 어댑터 파일로. OS 빌드 제약은 **달지 않음**(결정, `QUALITY_GO_SRS` D-QG-8 `35786196`) — 가짜 실행기 시험이 다른 OS 에서 도는 것이 설계이고, `go tool nm` 으로 다른 OS 어댑터가 바이너리에 없음을 확인 | M · L |
| DM-21·22·23 | `dmctl_account.go` 631 · `dmctl_listworkspace.go` 505 · `dmctl.go` 579(분기 셋 + 도움말 110줄) | 파일 분할, 명령 표 한 벌 — **처리함 (SC `c2389f95`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-43)** | M · L |

### 2.6. 충분한 추상화 (분류 6)

| ID | 자리 | 현상 | 제안 | 규모 |
|---|---|---|---|---|
| GH-15 | `httpapi/server.go:82-228` `Server` | 필드 44개, 잠금 5개. `settingsMu` 하나가 access 와 sandbox 를 함께 잠근다 | 도메인별 하위 구조체와 각자의 잠금 — **처리함 (SH `acb5cae9`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-3)**: 하위 구조체, `settingsMu` → access·sandbox 각자의 `putMu` | L · 위험 H |
| FU-8 | `style-panel.css`·`style.css` | 레일 상태 선택자 `:is(html.sb-collapsed body:not(.mobile) #sidebar, …)` 반복(style.css 14 · style-panel.css 6) | `data-rail` 속성 하나 — **처리함 (R4a, `abb8a5df`)**: 패널 루트의 `data-rail`, `Panel.railSync` 한 자리가 세운다(열림·`body.mobile`·부팅 복원). 첫 프레임은 `index.html`. 선택자 22곳(style-panel.css 는 실제 8). 계산된 스타일 그대로 | M |

### 2.7. 비슷한 로직을 하나의 클래스로 (분류 7)

| ID | 자리 | 현상 | 제안 | 규모 |
|---|---|---|---|---|
| **FU-20** | `web/js/ui/sidebar-tabs.js`(사이드바 탭 줄) ↔ `web/js/core/app-agents.js`(작업 패널 탭 줄) | **사용자 추가 요청(2026-11-21).** 두 패널 상단 탭의 동작이 아직 하나 다르다 — 글자(라벨) 표시 여부를 패널마다 따로 판정한다. 지금은 두 패널이 `UIKit.tabsFit`·`tabsFitWatch` 를 각자 부르고, 탭 정의·배지·스크롤 자리·직행 키도 각자 들고 있다(사이드바 `SB_TAB_DEFS`, 작업 패널 `_actTabsEl`·`_actTabsPaint`) | 패널 탭 줄을 **공통 패널 객체 하나**(탭 정의·라벨 판정·배지·스크롤 자리·직행 토글)로 만들고, 두 패널은 그것을 상속해 쓴다. 라벨 표시 규칙은 그 한 자리에서 정한다. **결정(2026-11-21): 글자 표시 규칙은 지금처럼 패널별**(자기 탭 줄에 라벨이 다 들어가면 보인다)이고, 그 판정·배선을 공통 패널 객체 한 자리로 옮긴다. 두 패널의 다른 동작은 그 한 자리를 지나며 사라져야 한다 — 구현 때 두 패널의 판정 시점(배지 변화·폭 변화·다시 그리기·모바일)을 나란히 대조해 실제 차이를 찾아 적는다 — **처리함 (구조)** (§7.1 P3a 2: 판정은 `TabBar.fit` 한 자리. 사용자 보고 차이는 재현하지 못해 화면·조작을 묻는다) | M |
| GD-4 | `claudeacct/engine.go:609-650` ↔ `autoswitch.go:370-407` | 두 `Run` 의 wake 채널·ctx·타이머 루프가 같다 | 공용 루프에 `Tick` 주입 — **처리함 (P2 GD `56dffed0`, `REFACTOR3_DEDUP_GO_SRS` FR-RDG-62)**: `claudeacct.waker` | M |
| GH-2·3 · DM-1·2 | (§2.2) | 오류 렌더러·디코더·종료 코드 변환 | 각각 한 타입으로 — **처리함** (§2.2 의 각 행) | M |

### 2.8. 사람의 가독성 (분류 8)

| ID | 자리 | 현상 |
|---|---|---|
| FC-16 · DOC-16 | `core/app-statusbar.js:258` `_bgModalToggle` | 모달 시절 이름. 인자를 넘기는 곳이 없어 `open===false` 분기가 죽었다 → `_bgPanelOpen` — **처리함 (R2, `854590b2`)**: 단축키가 컨트롤러를 직접 부른다, 위임자 없음 |
| FC-17 | `app-layout.js:2-5`·`app-git.js:2-5` | 머리 주석의 메서드 수가 낡았다(21→44, 23→48) — **대상 소멸** (P3a 9 에서 두 파일이 컨트롤러로 나뉘었다) |
| FC-18 | `app-settings.js:130` | 500줄 게이트를 맞추려고 짜낸 198자 한 줄 — **원 자리 소멸** (P3a 8). 같은 종류(150자 넘는 줄)는 남았다 — **처리함 (R2, `7cd0bb29`)**: 198자 넘는 17줄을 나누고 단위 시험이 고정한다. 150~198자 58줄은 남김 |
| GH-9 | `httpapi/httperr.go:69-79` | 주석의 코드 이름 `body_too_big` — 실제는 `body_too_large`(`SAFETY_CORRECTNESS_SRS:205-218` 도 같은 오기) — **처리함**: 주석은 P1 `08922b9b`, SRS 는 P7 `0b8ad169` |
| GH-23 | `toolclient/client.go` | 오류 문구의 옛 데몬 이름 `paned` — **처리함 (유지 결정, SH `b429a39a`)**: 와이어에 나가는 문구라 두고 이유를 `toolclient/client_rpc.go` 주석에 적었다(`REFACTOR3_GO_STRUCT_SRS` FR-RGS-6) |
| GD-19 | `hub/gitwatch.go:836` | 주석 "500ms 마다" — 실제 `GitWatchInterval` 1000ms — **처리함 (SD `7d7891f8`)**: 주석이 `GitWatchInterval` 을 이름으로 가리킨다 |
| GD-22 | `hub/gitwatch.go:620` | `Watching()` 만 nil 가드가 없다 — **처리함 (SD `7d7891f8`)**: `gitwatch_lease.go` `Watching()` 이 nil 수신자에서 0 을 돌려준다 |
| DM-25·26 | `cmd/dongminal/app.go:51` 외 | `gitRoot context.Context` 라는 이름 · 주석이 다른 함수 위에 붙음 — **처리함 (SC `44ba911f`)**: `gitCtx` 로, 엇붙은 주석 넷(`copyExecutable`·`unpackAgentPlugin`·`contextCell`·`pidsOnPort`)을 제자리로 |
| DOC-13·14·17 | `apierr/inventory.go:97-104` · 코드 주석의 `파일:줄` 참조 | 없어진 함수 이름(`gitResetBlocked`), 파일 길이를 넘는 줄 참조 5개(35개 중), `app-agents.js:166` 의 낡은 주석 — **처리함 (P7 `0b8ad169` · `7362d88a` · `000e3f85`, 게이트 `289a4d41`)**: `inventory.go` 는 `resetAnswer`·`cleanAnswer` 로, 주석의 옛 파일 이름·낡은 줄 번호는 지금 이름과 함수·규칙 이름으로, 엇붙은 주석은 `agents-controller.js` 에서 고쳤다. `WORKSPACE_IDENTITY`·`PERFORMANCE_HARDENING` 의 표와 감사 기록은 시점 기록이라 고치지 않음(사용자 결정 Q6 의 범위: 살아 있는 문서·주석만) |

---

## 3. 성능 개선 후보 — 한 번에 처리할 목록

1차 §4 와 같은 방식이다. 지금 고치지 않고 모아 둔다. 묶음으로 처리할 때 측정 열의 방법으로 전후를 잰다. 전부 코드 읽기 추정이고 실측은 없다.

| # | ID | 자리 | 현상 | 측정 | 규모 |
|---|---|---|---|---|---|
| 1 | GH-17 | `httpapi` `fsOps` 전역 뮤텍스 | 세기(최대 1만 항목)와 복사·삭제 전 구간을 잡아, 다른 루트의 mkdir·이름 바꾸기가 모두 기다린다 — **처리함·유지**: 세기는 잠금 밖(SH `b429a39a`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-4). 복사 전 구간의 잠금은 측정 뒤 **유지**(결정, `QUALITY_GO_SRS` D-QG-7 `6c4b7551`) — 파일 3,000개 복사 중 다른 루트 mkdir 318~748 ms(복사가 끝날 때까지). 실패 정리(FR-WBR-67)와 이름 바꾸기 폴백의 창(D-26)이 그 잠금에 기댄다 | 큰 폴더 복사 중 mkdir 응답 시간 | M |
| 2 | GH-18 | `access.go` `apiAccessPut` → `refresh` | `settingsMu` 를 쥔 채 DNS 조회. 샌드박스 설정 PUT 이 그동안 기다린다 — **처리함 (SH `b429a39a`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-4)**: DNS 는 잠금 밖, 시한 3초 | 해석 지연 주입 후 sandbox PUT 지연 | S |
| 3 | GD-11 | `run.Store.save` | 변경마다 전체 Run 을 `json.Marshal`(1차 P3 의 남은 절반) — **유지(결정, `REFACTOR3_GO_STRUCT_SRS` §6 SD)**: 직렬화 몫은 Run 10/50/200 에서 2%/9%/36%(저장 1회 42.6/64.2/88.0 ms). 나머지는 세대 회전·쓰기라 증분 직렬화로 줄지 않고, 무효화 누락은 데이터 손실이다 | 저장 1회 바이트·alloc, Run 수별 | L |
| 4 | GD-7 | `query/diff.go` `diffBlobSide` | 블롭 한쪽마다 git 2회(`cat-file -s`+`show`), diff 한 번에 fork 4회 — **유지(결정, `REFACTOR3_GO_STRUCT_SRS` §6 SD)**: 한 번으로 줄이면 상한 넘는 블롭을 끝까지 받아 FR-GIT-48 을 어긴다 | diff 1회의 자식 프로세스 수 | M |
| 5 | GH-16 | `handlers_fs_search.go:348` | 파일마다 64 KiB `bufio` 를 새로 만들고 8000바이트만 본다 — **처리함 (SH `b429a39a`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-4)**: 버퍼 되쓰기, 2.66 MB → 0.11 MB/op | 검색 1회의 alloc | S |
| 6 | GD-8 | `claudeacct/autoswitch.go` `Tick` | 회차마다 `ps -axo args=` fork — **처리함 (SD `cd12d4cb`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-20)**: 1분 기억, fork 6 → 2 | Tick 당 fork 수 | S |
| 7 | GD-9·23 | `claudeacct/engine.go` `setRow`·`Tick` | 행마다 전 행 `MarshalIndent`+fsync(잠금 안). 한 회차에 `accounts.json` 을 2~3번 다시 읽는다 — **처리함 (SD `cd12d4cb`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-20)**: 쓰기 3 → 1, 읽기 2 → 1 | 회차당 쓰기·읽기 횟수 | S |
| 8 | GD-10 | `engine.go:213` | 계정 사이 250ms 를 `busy` 를 쥐고 `time.Sleep`, ctx 를 안 본다 — 종료가 N×250ms 늦는다 — **처리함 (SD `cd12d4cb`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-20)**: stagger 가 ctx 를 본다 | 종료 신호 → Run 복귀 시간 | S |
| 9 | GD-6 | `wsentry.Roots` | 호출마다 `MkdirAll` 2번(1차 LOW 잔존) — **유지(결정, `REFACTOR3_GO_STRUCT_SRS` §6 SD)**: `MkdirAll` 은 `Roots` 42 µs 의 6.6% 이고, 빼면 FR-NOT-1·2 가 깨진다 | 응답 경로의 시스템콜 수 | S |
| 10 | GD-12 | `telegram` `b.tabs` | 넣기만 하고 지우지 않는다 — **처리함 (SD `cd12d4cb`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-20)**: `SetToolGoneObserver` 로 수거 | 도구 N개 생성·종료 뒤 맵 크기 | S |
| 11 | DM-19 | `ctl/cli/proc.go` 정지 대기 | 정지 한 번에 `lsof` 최대 약 20회(darwin) — **처리함 (SC `fdf4bdba`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-44)**: pid 생존만 보고 끝에 포트를 한 번, `lsof` 25 → 3 | `stop` 1회의 자식 프로세스 수 | S |
| 12 | DM-20 | `dmctl rename-tab` 확인 | `/api/state` 를 최대 약 15회 GET, 매번 전체 디코딩 — **처리함 (SC `fdf4bdba`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-44)**: 간격을 두 배씩, 요청 42 → 15 | 1회의 요청 수 | S |
| 13 | FC-21 | `app-statusbar.js` `_pollStats` | ping → stats 직렬 2왕복 — **처리함 (R1, `85668248`)**: 함께 보낸다, 회차당 1왕복 | 회차당 왕복 | S |
| 14 | DM-27·28 | `daemon/ipc/paned.go:203` `MethodTerminate` · `chatsock.Serve` | `goSlow` 상한 우회로 고루틴이 요청 수만큼 · hello 전 연결은 `Close` 에서 안 닫힘(5초 상한) — DM-28 **처리함 (SC `fdf4bdba`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-44)**: hello 전 연결도 `Close` 에서 닫는다. DM-27 **유지(결정, 같은 SRS §6 SC)**: 상한 뒤에 줄 세우면 클라이언트 시한(5+3초)을 넘어 연결이 끊긴다(GH-F5 와 엮임) | 동시 terminate N건의 고루틴 수 | S |

---

## 4. 문서·기록에는 있으나 미구현·미흡·잘못 구현

**코드는 그대로 두고 문서를 고칠 것이 대부분이다.** 사내 규약대로 문서와 코드가 충돌하면 코드를 우선하고, 문서를 고칠지는 사용자가 고른다.

### 4.1. 미구현·미흡·잘못 구현 (코드 쪽)

| ID | 자리 | 내용 |
|---|---|---|
| DOC-6 | `UX_AUDIT_FIX_SRS` FR-UXF-85 | "사이드바 창 행 메뉴" 에 키캡을 단다고 적었지만 그 메뉴가 **없다**(`sidebar-list.js`·`sidebar-tabs.js` 에 `contextmenu` 0곳). 만들지, 범위 밖으로 둘지 결정 필요 — **처리함 (P7 `0b8ad169`)**: Q5 결정대로 FR 에서 「사이드바 창 행 메뉴」 를 지웠다 |
| GH-11 | `httpapi/handlers_runs_actions.go` `runErrAnswer` · `handlers_runs.go:174` | `action.Answer.Why` 는 사유 **코드**인데 미분류 실패는 `err.Error()` 자유 문구가 들어간다 — **처리함 (SH `8ae39a5e`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-7)**: 미분류 실패는 `internal_error`, 전문은 로그 |
| GH-12 | `action/action.go:118` `EntityName` | 카탈로그 42개 ID 가운데 이것만 생산자가 없다 — **처리함 (SH `8ae39a5e`, `REFACTOR3_GO_STRUCT_SRS` FR-RGS-7)**: 생산자 `entityNameAnswer` 를 주석으로 이음 |
| GH-24 | `httpapi/access_denied.go:53` | 403 HTML 화면에 `X-Error-Code` 가 없다. FR-ERR-7 이 HTML 을 빼는지 확인 못 함 `?` — **처리함 (`QUALITY_GO_SRS` QG-4, `527aa03c`)**: 화면에 `X-Error-Code: forbidden`(평문 403 과 같음), 본문 그대로 |
| — | `git-ui-metrics.spec.ts` V80 | 사이드바 접기 단추 26px 가 하한 미달. HEAD 에서도 실패(인계서 확인) |
| — | `npm run -s unit` | 열 번에 두 번꼴로 1건 실패, 어느 시험인지 모름(인계서) |
| — | `settings.spec.ts` | "규칙에 맞지 않는 이름은 거절" 이 전량 실행에서만 실패, 원인 미조사 |
| — | V-LAY-1 | `linux`·`win32` 기준선은 사용자가 `layout-baseline` 워크플로를 돌려야 한다 |
| — | PROD2 #8 · TC-SLP-6 | Windows statusLine 미실측(그대로) |

### 4.2. 문서가 낡았거나 틀림 (문서 쪽)

| ID | 자리 | 내용 |
|---|---|---|
| DOC-1 | `UIUX_OVERHAUL_SRS:852·867` FR-SEM-1 | "working = `--term-green`" — D-43 으로 `--accent2` — **처리함 (P7 `0b8ad169`)** |
| DOC-2 | `scripts/check-i18n-html.mjs:16-19` | "설정 탭 열둘과 모달 제목은 `lang="en"`" — 실제 5곳 — **처리함 (P7 `000e3f85`)** |
| DOC-3 | `docs/external/shortcuts.md:6` | "저장소·Editor 행" — Editor 탭은 합쳐졌다. 채팅 탭에서 순회 키가 아무 일도 안 한다는 말이 없다 — **처리함 (P7 `000e3f85`)** |
| DOC-4 | `DESIGN_TOKENS_SRS:430` `--z-sticky` 표 · `style-git.css:391-395` | 없어진 `.git-files-bar` 를 센다. **죽은 CSS 규칙 둘**(`.git-files-bar`·`.git-files-spacer`)이 남았다 — **처리함 (`c9ea6550`)**: 두 규칙을 지우고(쓰는 요소 0, 화면 불변) 표에서 뺐다(`--z-sticky` 4 → 3, 계 43 → 42) |
| DOC-5 | `architecture.md:329·483-494` · `sidebar-tabs.js:1` | 탭 이름 `Windows·Git·Editor` — 실제 `windows·repo·chat`. `_rLists` 자리는 `renderer-chrome.js` — **처리함 (P7 `000e3f85`)** |
| DOC-7 | `UX_AUDIT_FIX_SRS:4·546·568·607` | 「남은 것」 이 이미 끝난 7묶음을 적고, §3.12~3.14 상태가 "스펙" 인데 구현됐다 — **처리함 (P7 `0b8ad169`, 게이트 `4910afc9`)** |
| DOC-8 | `UIUX_OVERHAUL_SRS:4` | 「남은 것: M6(FR-CHR)」 — 다음 날 커밋으로 처리된 것으로 보인다. FR 단위 대조 필요 `?` — **처리함 (P7 `0b8ad169`)**: M6 구현 커밋을 머리에 적고 구현완료로 |
| DOC-9 | `CHAT_WINDOW_SRS` FR-CW-24·TC-CW-11 | "180px 미만이면 아이콘만" — FR-UXF-98(D-35)로 대체됐다는 표시가 없다 — **처리함 (P7 `0b8ad169`)** |
| DOC-10·11 | `docs/external/features.md:295` vs `:337`, `:340` vs `:338` | 같은 문서 안에서 서로 뒤집는다(라벨 폭 규칙, 카드 순서 — 철회된 FR-UXF-12 를 그대로 적음) — **처리함 (P7 `000e3f85`)** |
| DOC-12 | `CHANGELOG.md [Unreleased]` | 서로 뒤집는 항목 4쌍(실행 중 색, 카드 자리, 모바일 상태바, Activity 새로고침 단추). 릴리스 전에 최종 동작 기준으로 합쳐야 한다 — **처리함 (`d6a6bee6`)**: 뒤집힌 앞 항목을 지우거나 최종 문장 하나로 합쳤다 |
| DOC-18 | `SERVER_DRIVEN_ACTIONS_SRS` FR-SDA-70~73 | 동작 이름이 실제 ID(`sandbox.runtime.start`·`term.upload`·`file.convert_utf8`)와 다르다 — **처리함 (P7 `0b8ad169`)** |
| DOC-19 | `refactor/SERVER_DRIVEN_INVENTORY.md` F-A3·F-A6·F-B2 | 이미 처리된 항목을 미처리로 적는다(GH-10 · FU-7) — **처리함 (P7 `0b8ad169`)** |
| DOC-20 | `STRUCTURE_CLEANUP_SRS` D-STR-3 · `refactor/README.md:295` · `refactor/HANDOFF.md:343` | "dmctl 3계층" — 전제 충족(§0.1) — **처리함 (P7 `0b8ad169`)**: `STRUCTURE_CLEANUP_SRS` 에 전제 충족을 적었다. `refactor/README.md`·`HANDOFF.md` 는 지난 인계 기록이라 고치지 않음 |
| GH-9 | `SAFETY_CORRECTNESS_SRS:205-218` | `body_too_big` 오기 — **처리함 (P7 `0b8ad169`)** |

### 4.3. 게이트의 사각지대 (문서 쪽 어긋남이 새는 길)

- `check-srs-progress.sh` 는 「남은 것」 줄이 **있는지만** 본다. `승인·구현완료` 는 아무것도 확인하지 않는다(DOC-7·8). — **처리함 (P7 `4910afc9`)**: 머리가 `승인·구현완료` 인데 절 상태 줄이 `스펙` 이면 실패한다.
- 절 안의 `> 상태: 스펙` 을 보는 검사가 없다(DOC-7). — **처리함 (P7 `4910afc9`)**: 위와 같은 검사.
- 뒤 SRS·결정이 앞 FR 을 뒤집어도 앞 문서에 표시가 남지 않는다(DOC-1·9).
- `features.md` 본문과 `CHANGELOG` 의 자기 모순을 보는 검사가 없다(DOC-10~12).
- 코드 주석의 `파일:줄`·함수 이름 참조를 보는 검사가 없다(DOC-13·14). — **처리함 (P7 `289a4d41`)**: `check-code-refs.mjs` 가 주석의 파일 이름과 줄 번호를 잰다. 함수 이름 참조와 줄이 가리키는 내용은 재지 않는다.
- CSS 파일 크기 기준선이 없다(FU-11). — **처리함 (R4a, `8e87010d`)**: `check-file-size.mjs` 가 CSS 도 기준선(`FE_MODULE_BOUNDARY_SRS` §7.1a)과 견준다.

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
| Q7 | `UX_REMAINING` §7 받아들인 한계 다섯 | **결정(2026-11-21): 다시 본다.** P7 뒤에 하나씩 바꿀지 묻는다. **결과(2026-11-22)**: 둘째(작업 중 점의 접근 이름)만 고친다 — 처리함(`REFACTOR3_FE_FIX_SRS` FX-1). 나머지 넷(상단바 표식·같은 이름·fish 훅·행 문법 둘)은 그대로 둔다 |
| Q8 | FU-10 간격 토큰의 단 수와 값 변화 | **결정(2026-11-22): 이번에 끝까지 한다.** 값마다 상수를 만들지 않고 어느 정도 공통화해 묶으며, 그 과정의 결과값 변화(골든 변경)는 어느 정도 인정한다. 적용: 여덟 단 · 허용 폭 ±2px · 넘는 값은 예외 표(`REFACTOR3_FE_REST4_SRS` D-FR4-15~18) |

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
| P3a 3 | (이 커밋) | `REFACTOR3_FE_DIALOG_SRS` — `Dialog` 아래 `KitModal`(`UIKit.modal` 본체)·`GitModalBase`→`GitConfirm`·`GitDialog`·`SettingsModal`. FC-04 의 열기·닫기·탭 고르기 부분(`initModal` 135 → 8줄(단계 8 에서 한 줄), 나머지 `_init*` 나열은 단계 8), FU-13 의 모달 부분(`ui-kit.js` 934 → 817). git 모달 키는 맨 위일 때만 |
| P3a 4 | (이 커밋) | `REFACTOR3_FE_LIST_SRS` — `ListView` 아래 `SidebarList`(객체 → 서술자별 인스턴스)·`GitListTab`(`git-list-tab.js`). 나머지 `reconcileList` 호출 약 20곳은 각 부품의 단계(5·7·9)에서 |
| P3a 5 | `d60b5e44` | `REFACTOR3_FE_GITVIEW_SRS` — `GitView`(`git/git-view.js`) 아래 Stash·Branches·History·Console·Commit·RemoteList·GitListTab. 세대 가드 세 종류를 `ticket`/`superseded`/`stale` 한 벌로, 루트는 모두 `el`(`gitViewMounted` 삭제), `GitListTab` 은 `ListView` 를 부품(`rows`)으로. `remote.js` 를 클래스마다 넷으로(FU-12 의 파일 분할, `GitRemote` 안 나누기는 단계 7) |
| P3a 6 | (이 커밋) | `REFACTOR3_FE_ESC_SRS` — FC-13·14. `EscapeStack` 두 층(캡처·버블, 연 순서, 맨 위 하나, 죽은 항목은 건너뜀), `Menu`(`ui/menu.js`, `ui-kit.js` 817 → 696), 대화상자·모바일 시트·설정 상세·계정 팝오버·파일 트리 끌기의 Esc 를 항목으로, `#settings-btn` 리스너 넷 → `SettingsModal.open()` 하나 |
| P3a 7 | `2f29a3a8`…(이 커밋) | `REFACTOR3_FE_GITPANEL_SRS` — `GitPanel` 의 mixin 열하나(`Object.assign(GitPanel.prototype, …)` 12) → `GitPart` 아래 부품 열하나(`GitBlame`·`GitHunks`·`GitDiffPane`·`GitPoll`·`GitWrite`·`GitChanges`·`GitChangeRows`·`GitFiles`·`GitSelection`·`GitViews`·`GitViewRoots`), 혼자 쓰는 필드는 부품이 갖고 공용 필드·관측 접근자·리포 전환·수명은 패널 본문(`panel.js` 435줄). 바깥·다른 부품이 부르는 이름은 패널의 한 줄 위임자로 남긴다(단계 9 에서 부르는 쪽과 함께 걷는다). 500줄 초과 17 → 16 |
| P3a 8 | `9afbb9fe`…(이 커밋) | `REFACTOR3_FE_SETTINGS_SRS` — FC-04. 설정 탭 열일곱을 `SettingsSection`(View) 하위 하나씩으로, 체크·숫자 14행을 `FormRow` 선언으로(8a), 폴링·statusbar·notify·레인지(8b), 서버 자원 패널 일곱(패널 상태를 섹션 필드로, claude 는 순수 함수 파일로 먼저 나눔, 8c), theme·shortcuts·키바(terminal)·presets·backup(8d). `initModal` 의 `_init*` 나열과 `input-binding.js` 의 설정 init 은 `SettingsController`(`Controller`)의 표 `SETTINGS_INIT` 하나로, 열기·탭 훅은 그 `onOpen`·`onTab` 으로 모았다(8e). App 은 `settings` 하나를 들고, 설정 밖·e2e·단위 시험이 부르는 이름은 한 줄 위임자로 남긴다(단계 9 에서 부르는 쪽과 함께 걷는다). 동작 변경 없음 |
| P3a 9 | `b0e3b411`…(이 커밋) | `REFACTOR3_FE_APPCTL_SRS` — App mixin(`Object.assign(App.prototype, …)` 57파일·메서드 835)을 하위 이슈 열하나(9a~9k)로 주제별 `Controller` 와 그 부품(클래스 하나 = 파일 하나)으로 옮겼다 — 간선·업데이트·설정 · 알림·Claude 계정·상태바 · 채팅·활동·모바일 · git · 상태 동기화 · 포커스 · 슬롯 · 레이아웃 · 도구 · 편집기 · Repo 창. 공유 상태의 주인과 쓰기 입구는 9e 가 정했다(App 이 공용 상태의 주인, 쓰기 모음 `focused`·`focusHandoff`·`_edGitHeld`). 바깥·e2e·계약이 부르는 이름은 컨트롤러 파일 끝의 위임자 표(`Controller.delegate`)로 남는다. `Object.assign(App.prototype` 57 → 0, 500줄 초과 16 → 12. 동작 변경 없음 |
| P3 FE 나머지 — 정리 | (이 커밋) | P3a 가 흡수한 ID 에 「처리함」 표시(실측 HEAD `c96988c7`): FC-F2·01·02·04·13·14 · FU-1·20 · FU-2~6 넷 · FC-05·FU-12·13 일부 · FC-17·18 대상 소멸. 남은 것을 하위 묶음 넷으로 나눈다 — **R1 동작 변경·서버 원천**(FC-03 redmean · FU-17 서브모듈 stage 서버 거부 · FC-11 자동 전환 범위 서버 원천 · FC-21 ping·stats) · **R2 JS 작은 정리**(FC-06·08·10·15·16·18·19·20·22 · FU-19 · `cm-lsp` `unsubscribe` · `UIKit.tabsFitWatch`) · **R3 큰 함수·클래스**(FC-05 `delWindow` · FC-07·09 시험 고정 먼저 · FC-12 · FU-12 `GitRemote` · FU-13 drag·HUD · FU-14·15·16) · **R4 CSS**(FU-8·9·18 · FU-11 CSS 크기 게이트 · FU-10 간격 토큰) |
| R1 | `32b9e597`·`8ab87528`·`19f60b6a`·`a51da4bb`·`85668248`…(이 커밋) | `REFACTOR3_FE_REST1_SRS` — FC-03 알림색 거리 redmean(Ayu Mirage 알림색 `#dfbfff`→`#95e6cb`, 실행 중 색 `#6dcbfa`→`#dfbfff`, 메인색 조합 432개 중 알림색 31·실행 중 색 29 바뀜) · FU-17 서브모듈 안쪽만 바뀐 경로만 담는 stage 를 서버가 409 `submodule_inner_only` 로 거절, 화면은 status 의 `rowActions` 로 끈다 · FC-11 자동 전환 칸 범위를 `autoswitch` 응답의 `ranges` 로 · FC-21 ping·stats 를 함께. 남은 것: 계정 행 칸의 범위 두 벌 — **처리함 (FIX FX-7)** |
| R2 | `903526b9`·`7cfe190b`·`49136bd7`·`854590b2`·`7cd0bb29`·`b3fe9935`·`324d7922`…(이 커밋) | `REFACTOR3_FE_REST2_SRS` — 동작 불변. FC-06·08 빌더 분리 · FC-10 상수 파일의 함수 9개(새 `core/server-meta.js`) · FC-15 한 번 훑기 · FC-16 `_bgPanelOpen` · `UIKit.tabsFitWatch` 삭제 · FC-18 198자 넘는 줄 17 · FC-19·20·22 `MS_PER_SEC`·주기 상수·`TIP_*` 열일곱 · FU-19 모달 폭 클래스. 남긴 것: `cm-lsp` `unsubscribe`(라이브러리가 부른다) · `CLAUDE_ACCT_POLL_MS` · 서술자 표·`diag.js` 툴팁 · 150~198자 줄 |
| R3a | `af16d851`·`0d4af0dc`·`94d73ccd`·`18aa0a35`…(이 커밋) | `REFACTOR3_FE_REST3_SRS` — 동작 불변. FC-07·09: 나누기 전에 적용기·저장의 순서·충돌 26가지를 단위 시험으로 고정(처음부터 GREEN)한 뒤, 적용기 `_applyRemoteWorkspace` 를 순수 판정 넷(`wsLiveTools`·`wsPinsKey`·`wsViewOf`·`wsViewRestore`, 크기 게이트 때문에 `layout-tree.js`)과 단계 메서드 다섯으로, `save`·`_saveAdoptRemote` 를 순수 판정 넷(`wsSaveBody`·`wsSaveSame`·`wsGitAdopt`·`wsSaveHoldMs`)과 `_savePut`·`_adoptRemote`·`_saveBackoff` 로 나눴다. 위임자는 더하지 않았다. 남은 것: R3b(FC-05 `delWindow` · FC-12 · FU-12 `GitRemote` · FU-13 drag·HUD · FU-14·15·16) — 같은 SRS 에 이어 쓴다 |
| R3b | `7a0390a1`·`61f2e97b`·`4a418d40`·`26bafe55`·`ccb4da87`·`ed802920`·`b40a3086`·`47a00334`…(이 커밋) | `REFACTOR3_FE_REST3_SRS` — 동작 불변. FC-05 `delWindow` 를 고정 시험 뒤 단계 넷으로 · FC-12 테마 미리보기 인라인 `style` 45곳 → `.pv-*` 규칙과 `--pv-*` 변수(계산된 스타일 비교로 확인) · FU-12 `GitRemote` 에서 칠하기를 `GitRemoteView` 로(500줄 초과 12 → 11) · FU-13 킷의 끌기·HUD 를 `SizeDrag`·`SizeHud` 로 · FU-14·15·16 `buildLaneGraph`·`_buildChanges`·`_rowEl`·`_applyStatus` 를 순수 판정과 단계로. 남긴 것: 100줄 안팎 함수 넷 |
| R4a | `0cd6527c`·`fb874af4`·`abb8a5df`·`3f3df12a`·`8e87010d`…(이 커밋) | `REFACTOR3_FE_REST4_SRS` — 화면 불변. FU-18 `.bg-row` 바탕 규칙을 `style-runs.css` 로 · FU-8 레일 상태를 패널 루트의 `data-rail` 표식 하나로(`Panel.railSync`, 첫 프레임은 `index.html`, 특이도 대조로 루트 둘·탭 배지 하나를 맞춤) · FU-9 죽은 클래스 둘을 걷고 숨김 목록 대조 시험 · FU-11 CSS 크기 게이트와 `style.css` 를 연속 구간 여덟으로. 화면 34개의 계산된 스타일 해시를 HEAD 와 견주어 차이 0(글자 폭 흔들림 2요소 제외). 남은 것: R4b FU-10 간격 토큰 |
| R4b | `8f809850`·`92c59b26`·`6d46d4e1`·`d05e001a`·`0efcb302`…(이 커밋) | `REFACTOR3_FE_REST4_SRS` — FU-10 간격 토큰. `--sp-1`~`--sp-8`(2·4·6·8·10·12·16·24px), 간격 리터럴 870개 가운데 822개를 토큰으로(그중 105개는 ±2px 안의 단으로 붙여 값이 바뀜 — 사용자 결정 Q8), 예외 20(레일·근거 주석·±2px 밖·함수 안). 게이트 `check-spacing.mjs`. 41화면 계산된 스타일 비교에서 차이는 사상표의 쌍과 그 기하 귀결뿐. 전량 e2e 실패 2는 원래 실패 |
| 전체 시험 (마무리) | `fa990d74` 기준 | `make gates` · `npm run -s unit`(1478) · `typecheck` · `go test -race -shuffle=on ./...` 통과. `make lint` 는 원래 eslint 2건(`theme-vars.js` `t` 가림 · `claude-accounts-foot.test.mjs` 미사용 `b`)만, golangci-lint 0. e2e 전량 8샤드: 통과 2294 · 실패 6 · 흔들림 5. 실패는 원래 실패 다섯(`sidebar-actions` TC-SBA-1 · `version-autoreload` TC-RLC-25 · `git-ui-metrics` V80 · `ui-kit-icons` V-GAP-1 · 환경 `skill-contract.spec.ts:451`)과 `settings.spec.ts:256` 「고치던 이름은 덮지 않고…」 — 이것은 단독 3/3·파일 19/19·같은 샤드 목록 단독 285/285 통과라 8샤드 동시 부하의 흔들림으로 본다. 흔들림: `slot-view-state` 넷 · `ux-audit-fix` 2묶음 |
| P4·P5·P6 (Go) | 합침 `b13406a3`·`9ab7c188`·`1af24478` | `REFACTOR3_GO_STRUCT_SRS` — SH·SD·SC. 남은 것: FR-RGS-1 |
| P7 | `ead3f7be`·`7362d88a`·`289a4d41`·`0b8ad169`·`000e3f85`·`4910afc9` (합침 `9171f2b7`) · `c9ea6550`·`d6a6bee6`…(이 커밋) | 문서 동기화와 게이트 — 문서는 코드 기준(Q6). 설정 대조 시험이 옮긴 파일을 읽는다 · 주석의 옛 파일 이름·낡은 줄 번호(DOC-13·14·17) · 게이트 `check-code-refs.mjs` · 낡은 SRS 본문(DOC-1·6·7·8·9·13·18·19·20 · GH-9) · 살아 있는 문서(DOC-2·3·5·10·11·17) · 게이트 `check-srs-progress.sh` 의 절 상태 검사(DOC-7) · 죽은 CSS 규칙 둘과 디자인 토큰 표(DOC-4) · CHANGELOG 의 뒤집는 네 쌍(DOC-12) · 색인(`docs/internal/README.md`) 상태 · 이 문서의 처리함 표시. DOC-15·16 은 R4a·R2, GD-19·22 는 SD, GH-23 은 SH(유지), DM-25·26 은 SC 가 이미 처리했다. 지난 인계서·감사·SRS 구현 기록과 `WORKSPACE_IDENTITY`·`PERFORMANCE_HARDENING` 의 표는 시점 기록이라 고치지 않음(사용자 결정 Q6 의 범위: 살아 있는 문서·주석만). 동작 변경 없음 |
| FIX | `777e8629`·`e683f684`·`8a4fbc93`·`e60c4880`·`6a92e943`·`fa990d74` · FX-6·7 `4a370b32`·`4e7e4c21`·`ca4645ab`…(이 커밋) | `REFACTOR3_FE_FIX_SRS` — 사용자 결정(2026-11-22)으로 고친 다섯, 모두 동작 변경. FX-1 P8-2: 작업 중인 탭·창 행·Agents 탭의 툴팁과 `aria-label` 이 `working` 을 말한다(§6 Q7 의 나머지 넷은 그대로) · FX-2 설정 statusbar 스위치를 열 때·방송 뒤에 다시 칠하고, 숫자 행 다섯에 포커스 가드(실측으로 다섯 모두 덮임을 확인) · FX-3 설정을 열 때 고른 서버 패널(access·sandbox·edges·telegram·server)을 다시 읽는다 — 수정이 있으면 두고 읽기는 섹션마다 하나 · FX-4 죽은 `_gitAddRepo`·`_gitReorder` 와 도우미·문구 · FX-5 e2e 게이트가 `<별칭>.app._x` 를 잡고(7곳을 계약으로), 계약의 없는 이름 `_gitJobChip`·`_focusCh` 를 걷었다 · FX-6 부르는 곳 없는 서버 종단 `GET /api/git/repo-at`·`POST /api/git/repos/reorder` 와 그것만 쓰던 함수·경로·시험·문서를 지웠다(둘 다 404, dmctl·다른 Go 코드는 부르지 않았다) · FX-7 계정 행 칸(별칭 24자·한도 50~100·우선순위 0~1000)의 범위를 Go 표 `AccountRanges` 하나로, `GET /api/claude-accounts` 의 `ranges` 로 싣고 화면이 그것을 쓴다(R1 의 남은 것, 값 같음) |
| QUALITY | `2f141812`·`abbf050f`·`e7d0ccc6`·`8f524ff6`·`b34f65f5`·`0d861c59`·`43cd0c79`·`eb6487c6`…(이 커밋) | `QUALITY_FIX_SRS` — 「원래 실패」 e2e 다섯과 eslint 2건, 부팅 설정 적용 순서. 낡은 시험 넷을 뒤의 요구에 맞췄다: TC-SBA-1·V-GAP-1(FR-UXF-96 한 줄 배치, `Box` 라벨 감춤) · TC-RLC-25(침묵 흉내가 FR-UXF-65 의 전경 이름 알림에 덮였다 — 수신 처리기를 뗀다) · skill-contract:451(「환경」 이 아니라 「전」 사진이 전경 이름 자리잡기 전에 찍히는 경합). 결함 하나: V80 — 두 패널의 접기 단추 26 → 30px(FR-GIT-226, D-38 은 두 단추를 같게 해 지킨다). eslint 0(`.claude/**` 제외 포함). QF-7: 적용은 값, 칠하기는 맨 끝 한 자리 — 적용 길의 `_sectionCall`·`modKbd` 가드를 걷고 두 순서의 결과가 같음을 단위로 잰다 |
| QUALITY_GO | `060f7358` · `b7785b53` · `63197fa7` · `5c48bccf` · `527aa03c` · `6c4b7551` · `036e184a` · `35786196` · `0296bf2d` · `0674988f` · `cdd38aa9`…(이 커밋) | `QUALITY_GO_SRS` — Go 의 남은 항목. GH-F3 디코드 오류 문구는 고정 문구에 요청 자리만(Go 타입 이름 없음, 전문은 `dmlog`, 핀 저장 실패도 고정) · FC-F1 서버 쪽: `PUT /api/settings` 가 색이 아닌 `customTheme` 값을 `400` · `bad_request` 로 거절(이미 저장된 값은 화면이 걸러 다음 저장부터 통과) · GD-F2 버튼 걷기 상한 4 병렬(3.26s → 0.82s) · GH-24 403 화면에 `X-Error-Code: forbidden` · GH-17 복사 잠금은 측정 뒤 유지(불변식 둘) · GD-3 `core.UnguardedTextRunner` · DM-18 빌드 제약은 달지 않음(근거) · GH-4·5·21 `editorlimit.BinarySniffBytes` · DM-5 손 루프 셋을 `argSpec` 으로(골든 전후, detach 셋만 바뀜). 동작 변경은 그 SRS §5. 이 문서의 이미 처리된 행 표시(§1·§2·§3·§4.1)도 이 커밋. 남김: `parseSubArgs`(edge·account) |
| FLAKY | `2553c6b1`·`5c3a078d`·`14e238e6`·`f542b2ed`·`f8e8fc70`·`bd588f63`·`18b75f11`…(이 커밋) | `QUALITY_FLAKY_SRS` — 「흔들림」 목록의 원인. 앱 결함 둘: FL-3 구독이 열리면 서버가 도구마다 `tool_foreground` 를 싣는다(부팅 조회와 구독 사이에 바뀐 이름이 사라져 새 셸 탭이 `Shell` 에 머물렀다) · FL-4 프로필 패널 읽기를 하나로 묶고 읽는 사이에 고친 이름을 덮지 않는다. 시험 경합: FL-1 전경이 빈 셸의 `working`(TC-ACF-1) · FL-2·6 이름이 `~` 인 탭의 가운데 클릭이 닫기 단추(`selectTab`, slot-view-state·tab·a11y-keyboard) · FL-3 진짜 전경 알림이 흉내를 덮음(tab-names) · FL-5 `waitForInit` 이 첫 구독의 재검증을 기다린다 · TC-UXF-1·16 의 시점 · FL-7 cm-sticky·`TestWorktreeCreateInputAnswer`. 재현 못 함: TC-UXF-94 · O7 · 간선 주소·망 그림 · TC-CAC-27 · TC-CMP-19. 전량 e2e: 통과 2303 · 실패 1(V-LAY-1 — QF-3 뒤 기준선 미갱신, 결정적) · 흔들림 1(TC-UXF-1 — `goto` 의 `ERR_INVALID_HTTP_RESPONSE`, 다른 원인) |

---

## 8. 한계 — 보지 못한 것

- **실행하지 않았다.** 빌드·`make gates`·e2e 를 돌리지 않았다(`go vet` 과 `go test -race ./internal/webserver/domain/run/...` 만 돌렸고, 둘 다 통과했다). 결함의 재현은 하나도 하지 않았다.
- **심볼 도구를 쓰지 못했다.** Serena 는 프로젝트가 활성화되지 않아 실패했고, 조사는 grep·정독으로 참조를 셌다. 호출 수·죽은 코드 판정은 표본이다.
- **정독하지 않은 곳:** Go 도메인 `ext`·`lsp`·`sysstat`·`git/store`·`git/jobs`·`telegram` 렌더 · `gitapi` 의 branch·write 핸들러 본문 · `edgemesh/mesh.go`·`daemon/chat/service.go`·`edge/config.go`·`runtime/install.go` · FE `app-git.js`·`app-slots.js`·`app-ws-sync.js` 본문.
- **문서 대조는 표본이다.** 바뀐 SRS 73개를 FR 단위로 모두 대조하지 않았다. `M8_UNIFIED`·`WORDING_COLOR`·`RELEASE`·`ISSUE_AGENT_TREE`·`CLAUDE_ACCOUNTS`·`PEER_CHAT` 의 미참조 FR 은 개별로 보지 않았다.
- **XSS 는 표본이다**(템플릿 13곳 + 테마 미리보기). 전수 감사가 아니다.
- **Windows·linux 쪽 동작은 이 기계에서 확인할 수 없다.**
