# SRS: 리팩토링 3차 Go P4·P5·P6 — 상수, 큰 파일·함수, 성능 — IEEE 29148

> **문서 상태**: 승인·구현완료

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `docs/internal/refactor/PROD3.md` §2.1·§2.3·§2.4·§2.5·§2.6·§2.8·§3 의 Go 항목)
- 사용자 결정(2026-11-21): 목록 전부를 진행한다. 묶음마다 커밋한다. 전체 시험은 마지막에 한 번.

## 1. 개요

### 1.1 목적

P2 가 Go 의 같은 규칙 여러 벌을 한 벌로 모았다. 이 문서는 그 뒤에 남은 Go 항목 — 이름 없는 상수, 너무 큰 파일·함수·구조체, 성능 후보 — 를 처리한다.

### 1.2 범위

| 묶음 | 패키지 | PROD3 ID |
|---|---|---|
| **SH** HTTP 계층 | `webserver/{httpapi,gitapi,toolclient,httproute,sse}` | GH-13·14·15·16·17·18·19·20·21·23 · GH-11·12(문서 D 중 코드 쪽) · GH-F5(설계 검토) |
| **SD** 도메인·hub | `webserver/{domain,hub}` | GD-6~23 |
| **SC** 데몬·공유·CLI | `daemon/**` · `shared/**` · `ctl/**` · `helper/**` · `cmd/**` | DM-12·13·14·15·16·18·19·20·21·22·23·25·26·27·28 · P2 GC 가 남긴 `DONGMINAL_*` 문자열 셋 |

### 1.3 불변 조건

| ID | 조건 |
|---|---|
| INV-S1 | 와이어(HTTP 상태·헤더·본문, IPC 프레임, `dmctl` 출력·종료 코드)는 바뀌지 않는다. 예외는 §4 다 |
| INV-S2 | 파일·함수 분할은 **동작 불변**이다. 옮기기만 하고, 옮긴 것은 기존 시험이 지킨다 |
| INV-S3 | 분할 결과 파일은 한 주제다. 파일 이름이 그 주제를 말한다. 같은 패키지 안에서만 나눈다(공개 API 를 바꾸지 않는다) |
| INV-S4 | 성능 항목은 **전후를 잰다.** 잴 수 있는 모양(호출 수·fork 수·할당·바이트·대기 시간)으로 시험이나 벤치마크를 둔다. 재지 못한 것은 "재지 않음" 으로 적는다 |

## 2. 요구사항

### 2.1 SH — HTTP 계층

| ID | 요구 | 근거 |
|---|---|---|
| FR-RGS-1 | 80줄을 넘는 처리기(`apiRunSucceed`·`handleCommandSSE`·`handleCommandPost`·`apiGitStatus`·`server.New`·`apiFileWrite` 외 표본 14)는 파싱·판정·렌더로 나눈다. 판정 함수는 순수하게 두고 단위 시험을 붙인다. **결과**: 다시 잰 HTTP 계층 14개를 모두 80줄 아래로 나눴다(D-RGS-3~5, §6). 판정·렌더 순수 함수에 표 주도 시험 30개(httpapi 23 · gitapi 7) | GH-13 |
| FR-RGS-2 | `handlers_files.go`(749)·`access.go`(744)·`toolclient/client.go`(685)는 주제별 파일로 나눈다(예: 읽기·쓰기 / 업로드 / 표식 · 저장소 / 정규화·매처 / HTTP · 연결 감시 / RPC / 재동기) | GH-14 |
| FR-RGS-3 | `httpapi.Server` 의 필드(44개)·잠금(5개)을 도메인별 하위 구조체(fs·access·sandbox·runs 등)와 각자의 잠금으로 묶는다. `settingsMu` 하나가 access 와 sandbox 를 함께 잠그던 것을 가른다 | GH-15 |
| FR-RGS-4 | 성능: 검색 워크가 파일마다 64 KiB `bufio` 를 새로 만들지 않는다(GH-16). 서버 전역 `fsOps` 가 세기(최대 1만 항목) 구간을 잡지 않는다 — 세기는 잠금 밖에서, 쓰기 직전에 다시 확인한다(GH-17). 접근 목록 저장의 DNS 조회는 잠금 밖에서 하고 시한을 둔다(GH-18) | GH-16·17·18 |
| FR-RGS-5 | 상수: 재접속 시작 백오프(`time.Second`)·rg JSON 줄 상한(`4<<20`)에 이름을 준다. fs 상한(`zipMaxEntries`·`zipMaxBytes`·`fsList/Delete/Copy` 10000·`uploadMaxBytes`)은 한 표(파일 하나)에 모은다 | GH-19·20·21 |
| FR-RGS-6 | 오류 문구의 옛 데몬 이름 `paned` 를 지금 이름으로 바꾼다(와이어에 나가는 문구면 바꾸지 않고 이유를 적는다) | GH-23 |
| FR-RGS-7 | runs 의 미분류 실패가 `action.Answer.Why`·오류 이름으로 `err.Error()` 자유 문구를 싣던 것을 고정 코드(`run_failed` 등 기존 카탈로그에 있으면 그것)로 바꾸고 전문은 로그로 보낸다. `action.EntityName` 은 생산자를 잇거나 카탈로그에서 뺀다. 와이어가 바뀌면 §4 에 적는다 | GH-11·12 |
| FR-RGS-8 | `toolclient.callWithin` 의 시한 초과가 연결 전체를 끊는 설계(GH-F5)는 **검토만** 한다: 왜 그렇게 했는지(주석·SRS)를 찾고, 바꿀 근거가 있으면 바꾸고 시험을 둔다. 근거가 없으면 이유를 적고 두며 보고한다 | GH-F5 |

### 2.2 SD — 도메인·hub

| ID | 요구 | 근거 |
|---|---|---|
| FR-RGS-20 | 성능: `wsentry.Roots` 가 호출마다 `MkdirAll` 하지 않는다(GD-6). diff 블롭 한쪽에 git 을 두 번(`cat-file -s`+`show`) 부르지 않는다(GD-7). 자동 전환 Tick 마다 `ps` 를 fork 하지 않도록 짧게 캐시한다(GD-8). `claudeacct` 는 행마다 전 행 직렬화+fsync 하지 않고 회차 끝에 한 번 쓴다(GD-9). 회차 안의 `time.Sleep(stagger)` 는 ctx 를 본다(GD-10). `run.Store.save` 의 전량 직렬화를 줄인다 — 위험이 크면 측정만 하고 근거와 함께 남긴다(GD-11). 텔레그램 `b.tabs` 는 탭이 사라지면 지운다(GD-12). 한 회차에 `accounts.json` 을 여러 번 읽지 않는다(GD-23) | GD-6~12·23 |
| FR-RGS-21 | 분할: `query/diff.go`(헝크 파싱 → `diff_hunks.go`) · `write/branch.go`(인자 빌더 → `branch_args.go`, 힌트 → `branch_hints.go`) · `hub/gitwatch.go`(임차·축출 / 계기 / 회차 / 시동) · `hub/attn_tracker.go`(유휴 스위퍼 → `attn_idle.go`) | GD-13~16 |
| FR-RGS-22 | 함수: `gitwatch.observe`(81줄)의 `need` 판정·`pending` 전이를 순수 함수로 떼고 시험한다. `autoswitch.decide`(79줄)의 트리거 결정(순수)과 전환 실행을 나눈다 | GD-17·18 |
| FR-RGS-23 | 정리: `gitwatch.watchPhase`(운영 호출 0)를 지우고 시험은 `phaseHash` 로 옮긴다. `Watching()` 에 `Leases()` 와 같은 nil 가드. `gitwatch.go` 주석 "500ms 마다" 를 실제 주기(`GitWatchInterval`)로. 텔레그램·claudeacct 의 인라인 시간 값 다섯에 이름(클라이언트 시한은 `pollTimeout` 에서 파생) | GD-19~22 |

### 2.3 SC — 데몬·공유·CLI

| ID | 요구 | 근거 |
|---|---|---|
| FR-RGS-40 | `"/api/…"` 경로 리터럴(표본 89)을 경로 상수 한 벌(`shared` 의 패키지 하나)로 바꾼다. 서버 라우트 등록도 그 상수를 쓸 수 있으면 쓴다(한쪽 이름을 바꾸면 빌드가 실패해야 한다) | DM-12 |
| FR-RGS-41 | 시간 예산(표본 115줄/64파일) 가운데 `helper/runtimebin` 의 예산을 한 파일에 근거 주석과 함께 모은다. "떠 있나" 를 묻는 시한 여섯(1·2·3·5초)은 목적 두셋으로 줄인다. `humancmd.Info` 를 두 예산으로 부르던 것은 클라이언트 기본값 하나로 | DM-13·14·15 |
| FR-RGS-42 | 도우미 소켓 절대 경로(`humancmd.SocketPath`)가 플랫폼 transport 에서 나오게 할 수 있으면 그렇게 하고, darwin 전용 특권 도우미라 고정이 맞으면 이유를 주석에 적는다 | DM-16 |
| FR-RGS-43 | 분할: `platform/procinfo.go`(627, 빌드 태그 없이 darwin·linux)를 플랫폼 파일로 · `dmctl_account.go`(631) · `dmctl_listworkspace.go`(505) · `dmctl.go`(579 — 명령 표 한 벌 + 도움말 파일) | DM-18·21·22·23 |
| FR-RGS-44 | 성능: `stop` 의 정지 대기가 `lsof` 를 반복 fork 하지 않는다(대상 pid 생존만 보고 끝에 포트를 한 번)(DM-19). `rename-tab` 확인이 `/api/state` 를 최대 15번 받지 않는다(DM-20). `paned` `MethodTerminate` 가 `goSlow` 상한을 탄다(DM-27). `chatsock` 의 hello 전 연결도 `Close` 에서 닫는다(DM-28) | DM-19·20·27·28 |
| FR-RGS-45 | 가독성: `gitRoot context.Context` 이름(DM-25), 주석 위치(DM-26). P2 GC 가 남긴 `DONGMINAL_*` 문자열(`httpapi/openurl.go` 는 SH 영역이니 제외, `runtimebin/dmctl_statusline.go`·`ctl/cli/doctor_probe.go`)은 `dmenv` 상수로 | DM-25·26 · P2 잔여 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-RGS-1 | 묶음 셋은 서로 다른 작업 트리에서 구현해 합친다 | 패키지가 겹치지 않는다. FR-RGS-40 의 서버 라우트 상수 사용은 SC 가 상수 패키지만 세우고, `httpapi` 쪽 적용은 SH 와 겹치므로 **합친 뒤 메인이 한다** |
| D-RGS-2 | 위험이 큰 항목(GH-15 Server 구조체, GD-11 run.Store 저장)은 먼저 측정·설계를 적고, 동작 불변을 시험으로 지킬 수 있을 때만 바꾼다 | 1차 감사 §7.3 의 교훈 — 근거 없이 바꾸면 회귀를 굳힌다 |
| D-RGS-3 | FR-RGS-1 의 대상은 `internal/webserver` 에서 다시 잰 HTTP 계층(`httpapi`·`gitapi`)의 80줄 넘는 함수 14개다(`go/ast` 로 선언 줄부터 닫는 줄까지). `deniedPageHTML`(96줄)은 나누지 않는다. `domain` 의 셋(`claudeacct.Service.Switch` 106·`run.TreePreamble` 101·`run.Store.Succeed` 86)은 범위 밖이다 | `deniedPageHTML` 은 판정이 없는 HTML 문자열 하나다. `domain` 셋은 처리기가 아니고 SD 묶음의 패키지다(FR-RGS-21·22 범위 밖) |
| D-RGS-4 | 잠금과 `defer` 는 처리기 본문에 남기고, 뗀 함수는 그 안에서 부른다 — `apiFileWrite` 의 경로 잠금, `apiServerBind` 의 `busy`, `apiGitWorktreeRemove` 의 `LockTop`. SSE 구독 해제는 건 역순으로 푸는 함수 하나로 모은다 | 잠금 범위와 해제 순서가 그대로여야 동작 불변이다(FR-RD3-20 · FR-XDF-9) |
| D-RGS-5 | 익명 본문 구조체는 같은 필드·태그의 이름 있는 타입으로 옮긴다(`commandPostReq`·`succeedReq`·`contextReq`·`runCloseReq`·`memberAddReq`·`bindReq`). 응답 `map` 은 렌더 함수로 옮긴다 | 디코드 결과와 `json.Marshal` 바이트가 같다. `encoding/json` 은 `map` 키를 정렬하므로 만드는 자리가 바뀌어도 응답 바이트가 같다 |

## 4. 동작 변경 기록

| FR | 이전 | 새 | 이유 |
|---|---|---|---|
| FR-RGS-7 | `/api/runs/*` 미분류 실패의 `X-Error-Code`·`error`·`detail`·`Answer.Why` 가 오류 문자열 그대로 | 모두 `internal_error`, 전문은 로그로만 | 아래 계층 문구에 경로·내부 상태가 들어 있다. 자유 문구는 헤더 값으로도 안전하지 않다. **와이어 변경** |
| FR-RGS-4 (GH-18) | 접근 목록 PUT 응답의 ETag 를 잠금 안에서 계산 | 잠금 밖에서 계산(그 사이 다른 PUT 이 끼면 그 뒤 값의 태그) | DNS 조회를 잠금 밖으로. 태그는 여전히 지금 설정의 올바른 값 |
| FR-RGS-41 | `dongminal health` HTTP 확인·config bind ping 시한 3초, `otp status` 도우미 시한 2초 | 2초 · 3초 | "떠 있나" 시한을 목적 둘로, 도우미는 `humancmd.DefaultTimeout` 하나로 |
| FR-RGS-44 (DM-20) | `rename-tab` 확인 100ms 간격 | 100ms 에서 두 배씩, 마지막은 창 끝 | `/api/state` 요청 42 → 15 이하. 늦게 선 반영을 알아차리는 시점이 창 끝(1.5초)까지 늦어질 수 있다 |
| FR-RGS-20 (GD-8) | 자동 전환이 켜진 회차마다 `ps` | 1분 동안 직전 결과 | fork 6 → 2. 켜진 동안 새로 띄운 cswap 을 늦으면 1분 뒤에 안다 |
| FR-RGS-20 (GD-9) | 행마다 `usage.json` 쓰기 | 회차 끝에 한 번 | 쓰기 3 → 1. 회차 도중 프로세스가 죽으면 그 회차 갱신을 잃고 다음 회차가 다시 조회한다 |
| FR-RGS-20 (GD-23) | 전환 직후 다시 읽기 실패와 무관하게 `pruneNotified` | 실패하면 그 회차의 알림 판정을 건너뜀 | 읽기 2 → 1. 방금 쓴 파일이라 실제로는 거의 없다 |

## 5. 검증

묶음마다 `gofmt -l` 0 · `go vet ./...` · 바뀐 패키지 `go test -race` · `go test ./...` · `make gates`. 성능 항목은 INV-S4 의 측정을 시험·벤치마크로 남긴다. 새 시험은 고치기 전 코드에서 실패한다(측정 시험은 옛 수치를 기록으로 남긴다).

## 6. 구현 기록 (2026-11-21)

| 묶음 | 커밋 | 요점 |
|---|---|---|
| SH | `b429a39a` · `8ae39a5e` · `ec9c31a3` · `acb5cae9` · `6cb999d1` | 검색 버퍼 되쓰기(2.66 MB → 0.11 MB/op), 세기·DNS 를 잠금 밖으로(DNS 시한 3초), fs 상한 표 `fs_limits.go`, 옛 이름 `paned` 은 와이어 문구라 두고 이유를 적음, runs 미분류 → `internal_error`, `EntityName` 은 생산자(`entityNameAnswer`)를 주석으로 이음, 파일 셋 분할, `Server` 필드 44개를 하위 구조체로(`settingsMu` → access·sandbox 각자의 `putMu`, PASS 1049 이름 목록 diff 0). **FR-RGS-8 결론: 바꾸지 않는다** — DAEMON_SPLIT_SRS FR-14 가 요구하고, `ping` 은 처리 중이면 건너뛰어 무응답 데몬을 찾는 수단이 이 시한뿐이며, 옛 데몬은 요청을 읽기 루프에서 처리해 한 호출이 막히면 뒤 호출도 막힌다(`callWithin` 주석). **FR-RGS-1 은 남음** |
| SD | `8c2cc91d` · `7d7891f8` · `cd12d4cb` | 큰 파일 넷 분할, `observe` 판정 순수 함수 셋, `decide` 를 `autoTrigger`·`inCooldown`·`switchFirst` 로, `watchPhase` 삭제, 시간 값 이름(클라이언트 시한은 `pollTimeout` 에서 파생), 회차 성능(§4 표), 텔레그램 `b.tabs` 수거(`SetToolGoneObserver`). **SRS 와 다르게 한 것:** GD-6·7·11 은 측정 뒤 바꾸지 않았다 — GD-11 `run.Store.save` 직렬화 몫은 Run 10/50/200 에서 2%/9%/36%(저장 1회 42.6/64.2/88.0 ms), 나머지는 세대 회전·쓰기라 증분 직렬화로 줄지 않고 무효화 누락은 데이터 손실이다(Run 200 이 실제로 쌓이는 환경이면 다시 본다). GD-6 MkdirAll 은 `Roots` 42 µs 의 6.6% 이고 빼면 FR-NOT-1·2 가 깨진다. GD-7 을 한 번으로 줄이면 상한 넘는 블롭을 끝까지 받아 FR-GIT-48 을 어긴다 |
| SC | `d60365c6` · `f0849a42` · `fdf4bdba` · `44ba911f` · `c2389f95` | `shared/apipath`(상수 61, 리터럴 92곳, 서버 라우트 대조 시험), 시간 예산 `budgets.go`, 도우미 소켓 고정 경로 이유, 정지 대기 `lsof` 25 → 3, `rename-tab` 42 → 15, chatsock hello 전 연결 정리, 파일 분할(procinfo 는 `_darwin` 접미사를 쓰지 않음 — 가짜 실행기 시험을 위해), `check-commands-docs.sh` 가 명령 표 `dmctlCommands` 를 읽게 고침. **DM-27 은 바꾸지 않음** — 상한 뒤 줄 세우면 클라이언트 시한(5+3초)을 넘어 연결이 끊긴다(GH-F5 와 엮임) |
| SH FR-RGS-1 (2026-11-22) | `37e36bcd` · `6cc3e9cd` · `66a37fda` | 처리기 14개를 파싱·판정·렌더로 나눴다(전 → 후 줄 수): `apiRunSucceed` 132 → 51 · `handleCommandSSE` 132 → 54 · `handleCommandPost` 122 → 53 · `apiGitStatus` 117 → 46 · `New` 107 → 60 · `apiFileWrite` 96 → 13 · `relayOutput` 92 → 64 · `apiGitLog` 89 → 65 · `apiRunsTree` 88 → 26 · `apiGitWorktreeRemove` 88 → 74 · `apiRunClose` 85 → 57 · `apiRunMemberAdd` 84 → 56 · `apiRunContext` 83 → 40 · `apiServerBind` 81 → 41. 새로 만든 함수도 모두 80줄 아래다. 판정 순수 함수의 예는 `sseSubPlanFor`·`commandLocField`·`stampConflict`·`bindTarget`·`succeedArgsError`·`linkTree`·`keepRunRecord`·`gitStatusUnchanged`·`gitLogStopWithSkip`·`listedWorktreeBranch`·`relayJoinable` 이다. 시험 파일은 여섯이다(`httpapi/*_verdict_test.go` 다섯 · `gitapi/split_verdict_test.go`). httpapi PASS 이름 대조: 기준선 1049 → 1072, **빠진 이름 0**(더해진 23은 새 시험). 남긴 것은 D-RGS-3 에 적었다 |

합친 뒤(`1af24478`): `gofmt` 0 · `go vet` · `go test ./...` · `make gates` · `npm run -s unit`(1190) 통과. `gitapi` `TestWorktreeCreateInputAnswer` 가 한 번 임시 폴더 정리(`directory not empty`)에서 졌고 단독 3회는 통과했다 — 흔들리는 시험으로 기록한다.
