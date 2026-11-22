# SRS: 리팩토링 3차 Go 남은 항목 — 오류 문구, 테마 값, 병렬 걷기, 잠금 범위, 한 벌 — IEEE 29148

> **문서 상태**: 승인·구현중

> **남은 것**: 이슈 여섯을 차례로 구현한다(§6 구현 기록).

- 접수: 2026-11-22 (프로덕션 리팩토링 3차 · `docs/internal/refactor/PROD3.md` 에서 남은 Go 항목)
- 사용자 지시(2026-11-22): 하나씩 끝나면 커밋한다. 끝까지 진행한다.
- 실측 기준: HEAD `ab4a91f2`.
- 규약: `REFACTOR_PROD3_HANDOFF_2.md` §7 — SRS → 시험(RED) → 구현. 동작이 바뀌면 이전/새/이유를 적는다.

## 1. 개요

### 1.1 목적

리팩토링 3차의 Go 쪽에서 아직 남은 결함 둘(GH-F3 · FC-F1 서버 쪽), 성능 둘(GD-F2 남은 것 · GH-17 남은 것), 계약 하나(GH-24), 구조 정리 다섯(GD-3 · DM-18 · GH-4·5·21 · DM-5)을 처리한다.

### 1.2 범위

| 이슈 | PROD3 ID | 자리 | 지금 |
|---|---|---|---|
| QG-1 | GH-F3 | `httpapi/handlers_fs.go` `fsDecode` · `handlers_toolio.go` `decodeJSONBody` · `handlers_files_stamp.go` · `handlers_files_rw.go` · `commands.go` · `gitapi/handlers_git_write.go` `gitDecodeBody` · `gitapi/handlers_git.go` 핀 추가·빼기 | 디코드 오류의 Go 문구(`json: cannot unmarshal number into Go struct field fsDeleteReq.paths of type []string`)를 응답 본문에 싣는다. 내부 타입 이름이 드러난다. 핀 저장 실패도 내부 오류 문구(작업 공간 파일의 경로·JSON 해석 오류)를 싣는다 |
| QG-2 | FC-F1 서버 쪽 | `shared/settingsschema/schema.go` `check` · `httpapi/handlers_settings.go` `apiSettingsPut` | `customTheme` 이 객체인지만 본다. 서버의 `PUT /api/settings` 는 JSON 인지만 본다 |
| QG-3 | GD-F2 남은 것 | `domain/telegram/bridge_events.go` `clearButtons` | `[읽음]` 버튼(탭마다 최대 32개)을 하나씩 순서대로 HTTP 로 걷는다 |
| QG-4 | GH-24 | `httpapi/access_denied.go` `writeDeniedPage` | 403 HTML 화면에 `X-Error-Code` 가 없다 |
| QG-5 | GH-17 남은 것 | `httpapi/handlers_fs_copy.go` `apiFSCopy` | 복사 전 구간(이름 잡기부터 트리 채우기까지)을 `s.fs.ops` 잠금 안에서 한다 |
| QG-6 | GD-3 · DM-18 · GH-4·5·21 · DM-5 | `domain/worktree`·`domain/submodule` `runGit` · `shared/platform/procinfo_{lsof,procfs}.go` · `binaryProbeLen`·`BinarySniffBytes` · `runtimebin` 손 루프 셋 | 같은 일이 두 벌, 빌드 제약 없는 OS 어댑터, 같은 값의 두 이름, 인자 파싱의 손 루프 |

### 1.3 범위 밖

- `web/`·`e2e/` — 다른 작업이 고친다. 클라이언트의 `sanitizeCustomTheme` 규칙은 **읽기만** 한다.
- 오류 코드. QG-1 은 본문 문구만 바꾸고 상태와 코드는 그대로 둔다.
- `gitError` 의 git stderr 꼬리(`gitapi/handlers_git.go` `gitError`) — §3 D-QG-2.

### 1.4 용어

| 용어 | 뜻 |
|---|---|
| 방언 | 오류 본문의 모양. 공개 계약이다(`architecture.md`). 이 문서는 방언을 바꾸지 않는다 |
| 고정 문구 | 서버 코드에 적힌 문장. 원인 오류의 문자열을 그대로 잇지 않는다 |
| 요청 자리 | 클라이언트가 보낸 JSON 의 어디가 틀렸는지: 필드 경로(JSON 키 이름)와 받은 값의 JSON 종류, 또는 문법 오류의 위치 |

## 2. 요구사항

### 2.1 QG-1 — 디코드 오류 문구 (GH-F3)

| ID | 요구 | 우선 |
|---|---|---|
| FR-QG-1 | 본문 디코드 실패의 응답 문구는 고정 문구에 **요청 자리**만 덧붙인다. 요청 자리는 `httpreq.Reason` 한 함수가 만든다: 문법 오류(`*json.SyntaxError`)는 그 문구, 형 오류(`*json.UnmarshalTypeError`)는 `<필드 경로>: <JSON 값 종류>` 꼴이다. Go 의 타입·구조체 이름(`fsDeleteReq`·`[]string`)은 싣지 않는다. 그 밖의 오류는 요청 자리가 없다 | 필수 |
| FR-QG-2 | 본문 읽기 실패의 문구는 상한 초과면 `httpreq.ErrTooLarge` 의 문구, 그 밖은 고정 문구뿐이다 | 필수 |
| FR-QG-3 | 디코드·읽기 실패의 원인 오류 전문은 `dmlog` 로 남긴다(경로와 함께) | 필수 |
| FR-QG-4 | 적용 자리: `fsDecode` · `decodeJSONBody` · `gitDecodeBody` · `apiFileStamps` · `parseFileWrite` · `parseCommandPost`. 상태와 `X-Error-Code` 는 바뀌지 않는다 | 필수 |
| FR-QG-5 | git 핀 추가·빼기(`apiGitPin`·`apiGitUnpin`)의 저장 실패는 고정 문구로 답하고 원인은 `dmlog` 로 보낸다. 상태(500)와 코드(`git_failed`)는 바뀌지 않는다 | 필수 |

### 2.2 QG-2 — 테마 값 서버 검증 (FC-F1)

| ID | 요구 | 우선 |
|---|---|---|
| FR-QG-10 | `settingsschema` 는 `customTheme` 값을 키별로 본다. `null` 은 통과한다. 객체가 아니면 문제다. `ui`·`terminal` 은 있으면 객체이고, 그 값은 모두 `#rrggbb` 또는 `#rrggbbaa`(16진수, 대소문자 무관)인 문자열이다. `mode` 는 있으면 `"dark"`·`"light"` 다. 그 밖의 위쪽 키는 보지 않는다. 색 규칙은 클라이언트 `THEME_COLOR_RE`(`web/js/core/theme-vars.js`)와 같다 | 필수 |
| FR-QG-11 | `PUT /api/settings` 는 블롭의 `customTheme` 이 FR-QG-10 을 어기면 `400` + `X-Error-Code: bad_request` 로 거절하고 저장하지 않는다. 본문 문구는 어긴 자리(키 경로)를 말한다 | 필수 |
| FR-QG-12 | 서버는 기동 때 이미 저장된 블롭을 검증하지 않는다. `GET /api/settings` 는 저장된 바이트 그대로다 | 필수 |
| FR-QG-13 | 내장 테마 54종의 값은 모두 FR-QG-10 을 통과한다 | 필수 |

### 2.3 QG-3 — 버튼 걷기 병렬 (GD-F2)

| ID | 요구 | 우선 |
|---|---|---|
| FR-QG-20 | `clearButtons` 는 버튼 걷기 HTTP 를 동시에 최대 `clearButtonsParallel` 개 보낸다. 모두 끝난 뒤 돌아온다 | 필수 |
| FR-QG-21 | 걷기의 실패는 지금처럼 버린다. 잠금(`b.mu`) 밖에서 부른다(FR-RD3-40) | 필수 |

### 2.4 QG-4 — 403 화면의 코드 (GH-24)

| ID | 요구 | 우선 |
|---|---|---|
| FR-QG-30 | 막힌 출발지에게 보내는 403 HTML 화면은 `X-Error-Code: forbidden` 을 싣는다. 본문·다른 헤더는 바뀌지 않는다 | 필수 |

### 2.5 QG-5 — 복사 잠금 범위 (GH-17)

| ID | 요구 | 우선 |
|---|---|---|
| FR-QG-40 | 큰 트리 복사 중 다른 루트의 `mkdir` 응답 시간을 잰다(전). 잠금이 지키는 불변식을 코드로 확인한다 | 필수 |
| FR-QG-41 | 불변식을 지키며 범위를 줄일 수 있으면 줄이고 다시 잰다(후). 줄일 수 없으면 근거를 적고 둔다 | 필수 |

### 2.6 QG-6 — 구조

| ID | 요구 | 우선 |
|---|---|---|
| FR-QG-50 | (GD-3) `worktree.runGit`·`submodule.runGit` 두 벌을 `core` 의 실행기 생성 함수 하나로 바꾼다. 패키지마다 다른 것(git 부재 sentinel 로 바꾸는 함수, 다듬기, 사유)은 인자다. 호출처 게이트(FR-GXU-12)는 새 진입점도 덮는다 | 필수 |
| FR-QG-51 | (DM-18) `procinfo_lsof.go`·`procinfo_procfs.go` 에 OS 빌드 제약을 다는 방법을 찾는다. 가짜 실행기 시험이 다른 OS 에서 깨지면 달지 않고 이유를 적는다. `GOOS=linux`·`windows`·`darwin` 의 `go vet ./...` 이 통과한다 | 필수 |
| FR-QG-52 | (GH-4·5·21) 편집기 판정의 NUL 검사 폭(`binaryProbeLen`)과 diff 의 이진 판정 폭(`BinarySniffBytes`)은 같은 목적(git 의 휴리스틱)이므로 `editorlimit.BinarySniffBytes` 한 이름을 쓴다 | 필수 |
| FR-QG-53 | (DM-5) `send-input`·`msg`·`detach` 의 손 루프를 `argSpec` 으로 옮긴다. 출력이 바뀌면 `argparse.golden` 에 전후가 남고 §5 에 적는다 | 필수 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-QG-1 | QG-1 은 고정 문구에 **요청 자리**를 덧붙인다. 문구를 통째로 고정하지 않는다. 같은 규칙을 모든 방언(toolio·fs·git·평문)에 쓴다 | P2 가 git 쪽 문구를 남긴 이유(`REFACTOR3_DEDUP_GO_SRS` FR-RDG-7: *"클라이언트가 자기 요청의 어디가 틀렸는지 알아야 한다"*)는 요청 자리만으로 채워진다. 드러나던 것은 Go 타입 이름(`*json.UnmarshalTypeError` 의 `Struct`·`Type`)뿐이다. 문법 오류 문구는 클라이언트가 보낸 바이트만 말한다. 그래서 git 의 기존 골든(`unexpected end of JSON input`)은 그대로다. 클라이언트(`web/js`·`runtimebin`)는 이 문구를 읽지 않는다(문자열 검색 0곳). 화면은 코드로 문구를 고른다(`err.invalid_json` 등) |
| D-QG-2 | `gitError` 의 git stderr 꼬리는 그대로 둔다. 핀 추가·빼기의 저장 실패만 고정 문구로 바꾼다 | git stderr 는 사용자가 읽을 실패 이유다(FR-GIT-96 · 화면이 그대로 보인다). 핀 저장 실패의 원인은 작업 공간 파일의 JSON 해석 오류(Go 타입 이름)·저장 경로라 내부 사정이다 |
| D-QG-3 | QG-2 는 PUT 을 **거절**한다. 그 키만 버리지 않는다 | 서버는 설정 블롭을 해석하지 않고 그대로 저장한다(`handlers_settings.go` 규약). 키를 버리면 서버가 블롭을 고쳐 쓰게 된다. 이미 저장된 나쁜 값의 호환: 서버는 기동 때 검증하지 않고(FR-QG-12), 화면은 읽을 때 `sanitizeCustomTheme` 으로 거른 값을 메모리에 들고 저장할 때 그 값을 보낸다(`settings-table.js` 의 `customTheme` 접근자). 그래서 나쁜 값이 저장된 서버도 다음 저장부터 통과한다. 거절이 닿는 것은 손으로 만든 요청과 나쁜 값이 든 백업 파일 복원뿐이고, 복원은 실패를 화면에 알린다(`backup.write_fail`) |
| D-QG-4 | QG-2 의 오류 코드는 새로 만들지 않고 `bad_request` 를 쓴다 | 새 코드는 화면의 i18n 문구가 필요하다(`web/` 는 이 작업의 범위 밖). 화면이 이 거절을 만날 길이 백업 복원뿐이고, 그 길은 상태 숫자로 알린다 |
| D-QG-5 | QG-2 의 키 이름 규칙은 클라이언트와 같이 **열어 둔다**(키 목록을 대조하지 않는다) | 클라이언트 `sanitizeCustomTheme` 은 키 이름을 묻지 않고 값만 본다. 서버가 키 목록을 따로 들면 두 벌이 된다 |
| D-QG-6 | QG-3 의 동시 상한은 4 다 | 탭 하나의 버튼은 최대 32개(D-RD3-4)다. Telegram 은 한 대화에 짧은 시간 많은 요청을 보내면 429 로 늦춘다. 4 는 걷기 시간을 약 1/4 로 줄이면서 한 대화에 한꺼번에 보내는 요청을 작게 둔다. 걷지 못한 버튼은 눌러도 답이 같다(FR-TGB-58a) |
| D-QG-7 | QG-5 의 잠금 범위는 **줄이지 않는다**(측정 뒤 유지) | 잠금이 지키는 불변식이 둘이다(코드 확인). ① 채우다 실패하면 `os.RemoveAll(target)` 으로 거둔다(FR-WBR-67). 그 삭제가 사용자의 것을 잃지 않는다는 전제는 "`target` 안에는 이 복사가 만든 것만 있다" 이다. 채우는 동안 잠금을 풀면, 탐색기에 이미 보이는 새 폴더 안으로 우리의 다른 조작(만들기·이름 바꾸기·복사)이 넣은 것이 실패 정리에 함께 지워진다. ② 이름 바꾸기 폴백의 "`Lstat` 검사 → `os.Rename`" 창(EDITOR_TAB_SRS D-26)은 이 잠금이 우리끼리의 경합에서 닫는다. 채우는 동안 풀면 복사가 만드는 이름과 그 창이 겹칠 수 있다. 범위를 줄이는 다른 길(보이지 않는 임시 이름에 채운 뒤 잠금 안에서 덮어쓰지 않는 이름 바꾸기로 놓기)은 복사 중 임시 항목이 탐색기에 보이고 비정상 종료 때 그것이 남는 **새 동작**이라 사용자 결정이 필요하다 — 이 문서는 바꾸지 않는다. 측정은 §6 |
| D-QG-8 | DM-18 의 두 파일(`procinfo_lsof.go`·`procinfo_procfs.go`)에는 OS 빌드 제약을 **달지 않는다** | ① 제약을 달면 그 어댑터의 가짜 실행기·가짜 `/proc` 시험도 같은 OS 에서만 돈다. 이 시험이 다른 OS 에서 도는 것이 설계다(CROSS_PLATFORM_SRS §4.2) — Windows 에서 `filepath.Join` 이 `\proc\…` 를 만들던 결함(FR-WTP-40)을 그렇게 찾았다. 시험만 남기려고 사용자 태그(`-tags`)를 두면 `go test ./...` 가 그 시험을 건너뛴다. ② 제약이 막으려는 해(다른 OS 의 코드가 바이너리에 섞임)가 없다 — 실측(`go tool nm`, amd64): linux 바이너리에 `darwinProcInfo` 0 · `parseLsof*` 0, windows 바이너리에 두 어댑터 모두 0, darwin 바이너리에 `linuxProcInfo` 0. 연결은 이미 `platform_{darwin,linux}.go` 가 OS 별로 한다. `GOOS=linux`·`windows`·`darwin` 의 `go vet ./...` 은 바꾸기 전에도 통과한다 |

## 4. 검증

| ID | 시험 | 이슈 |
|---|---|---|
| TC-QG-1 | fs·toolio·git·평문 종단에 형이 틀린 JSON 을 보내면 본문에 Go 타입 이름(`Req`·`[]string`·`Go struct`)이 없고 필드 경로는 있다. 상태·코드는 종전과 같다 | QG-1 |
| TC-QG-2 | `httpreq.Reason` — 문법 오류 · 형 오류 · 상한 초과 · 그 밖 | QG-1 |
| TC-QG-3 | 핀 저장이 실패하면 본문이 고정 문구다 | QG-1 |
| TC-QG-10 | `settingsschema` — 정상 · null · 색 아닌 값 · 따옴표 · `ui` 가 문자열 · `mode` 가 이상함 · 내장 테마 54종 | QG-2 |
| TC-QG-11 | `PUT /api/settings` 가 나쁜 `customTheme` 을 400 `bad_request` 로 거절하고 저장하지 않는다. 정상 블롭은 200 | QG-2 |
| TC-QG-20 | 가짜 HTTP 서버(요청마다 100ms)로 버튼 32개를 걷는 벽시계 시간. 전후를 §6 에 적는다. 동시 요청 수의 최댓값이 상한을 넘지 않는다 | QG-3 |
| TC-QG-30 | 403 HTML 화면에 `X-Error-Code: forbidden` | QG-4 |
| TC-QG-40 | 측정 시험(임시 폴더, 끝나면 지움): 수천 파일 트리 복사 중 다른 루트 `mkdir` 의 응답 시간 | QG-5 |
| TC-QG-50 | 기존 `worktree`·`submodule`·`core` 시험(호출처 게이트 포함)이 통과한다 | QG-6 |
| TC-QG-53 | `argparse.golden` 에 `send-input`·`msg`·`detach` 줄을 옛 코드로 먼저 만든다. 옮긴 뒤 다른 줄은 §5 의 동작 변경뿐이다 | QG-6 |

새 시험은 고치기 전 코드에서 실패하는 것을 먼저 본다(측정 시험은 옛 수치를 기록한다). 커밋마다 `gofmt -l` · `go vet ./...` · 관련 패키지 `go test`. httpapi 는 `go test -v` 의 PASS 이름이 시작 시점(1321)에서 빠지지 않는지 대조한다. 마지막에 `go test -race ./...` · `make gates`.

## 5. 동작 변경 기록

| 이슈 | 이전 | 새 | 이유 |
|---|---|---|---|
| QG-1 | 디코드 실패 문구에 원인 오류 그대로(`… json: cannot unmarshal number into Go struct field fsDeleteReq.path of type string`). 읽기 실패도 원인 그대로 | 고정 문구 + 요청 자리(`본문이 JSON 이 아니다: path: number 값은 맞지 않다`). 문법 오류·상한 초과는 종전 문구 그대로(골든 불변). 그 밖의 읽기 실패는 고정 문구뿐. 전문은 `dmlog` | 내부 타입 이름 노출(GH-F3). D-QG-1 |
| QG-1 | 핀 추가·빼기의 저장 실패 문구가 원인 오류(작업 공간 파일 해석 오류·경로) | `핀 목록을 저장하지 못했다`. 원인은 `dmlog` | D-QG-2 |
| QG-2 | `PUT /api/settings` 가 JSON 이면 무엇이든 저장했다 | `customTheme` 의 색·`mode` 가 규칙을 어기면 `400` · `bad_request`(문구 `customTheme.ui.bg: #rrggbb 또는 #rrggbbaa 색이어야 합니다`), 저장하지 않는다 | FC-F1 서버 쪽 — 나쁜 값이 다른 기기로 방송되지 않게. D-QG-3 |
| QG-2 | `dongminal config` 검증이 `customTheme` 을 object 인지만 봤다 | 키별 값 검증(문제의 키가 `customTheme.ui.bg` 꼴) | 같은 규칙 한 벌(FR-QG-10) |
| QG-4 | 403 차단 화면(HTML)에 `X-Error-Code` 가 없었다 | `X-Error-Code: forbidden`(평문 403 과 같음). 본문·다른 헤더 그대로 | 모든 오류 응답이 코드를 싣는다는 규약(FR-ERR-4, `docs/external/errors.md` 머리) |
| QG-6 (DM-5) | `detach --restore=ID`·`detach -r=ID` 는 모르는 인자(도움말과 종료 2). `detach --at ""` 는 통과(복귀 대상 없음과 같음) | 앞의 둘은 `--restore ID` 와 같다. `--at ""` 는 `--at=` 처럼 `--at 은 탭 uuid 가 필요합니다` 로 거절(2). `send-input`·`msg` 의 출력은 그대로(골든 불변) | `argSpec` 이 값 플래그의 `=` 형을 한 규칙으로 받고, 빈 탭 uuid 를 한 자리에서 거절한다. 골든 `argparse.golden` 의 바뀐 줄은 이 셋뿐이다 |

## 6. 구현 기록

| 이슈 | 커밋 | 요점 |
|---|---|---|
| QG-5 | `6c4b7551` | **측정 뒤 유지**(D-QG-7). 측정 `TestMeasureFSCopyBlocksOtherRootMkdir`(`DM_MEASURE_FS_COPY=1` 일 때만 돈다, 임시 폴더): 파일 3,000개(4 KiB)·폴더 30개 트리 복사 중 다른 루트의 `mkdir` 응답 — 3회 397 · 748 · 318 ms, 복사 시간 398 · 748 · 319 ms. 즉 다른 루트의 `mkdir` 은 복사가 끝날 때까지 기다린다(상한 1만 항목이면 약 1~2.5초, 큰 파일이면 더 길다). 잠금 자리에 불변식 두 개를 주석으로 적었다 |
| QG-6 DM-18 | (이 커밋) | **달지 않음**(D-QG-8). 세 OS `go vet ./...` 통과, `go tool nm` 으로 다른 OS 어댑터가 바이너리에 없음을 확인 |
