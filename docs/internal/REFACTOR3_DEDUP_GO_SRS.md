# SRS: 리팩토링 3차 P2 — Go 의 같은 규칙 여러 벌을 한 벌로 — IEEE 29148

> **문서 상태**: 승인·구현완료

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `docs/internal/refactor/PROD3.md` §2.2·§2.7 · 묶음 P2)
- 선행: `REFACTOR3_DEFECTS_SRS`(P1). 사용자 결정(2026-11-21): 목록 전부를 진행한다 · GH-6 은 검색도 UTF-16(BOM)을 텍스트로 본다(Q2) · DM-4 는 `shared/workspace` 로 합친다(Q4).

## 1. 개요

### 1.1 목적

같은 규칙이 Go 코드 여러 자리에 따로 적혀 있다. 한쪽만 고치면 다른 쪽이 조용히 어긋난다. 1차·P1 의 결함 가운데 여럿(오류 헤더 누락, 상한 초과 코드)이 이 모양에서 나왔다. 이 묶음은 그 규칙을 한 자리로 모은다.

### 1.2 범위

| 묶음 | PROD3 ID | 패키지 |
|---|---|---|
| **GA** 오류 응답·본문 읽기 | GH-1·2·3·4·6·7·8 · GH-F3(문구 규칙만 정리) | `shared/httpresp` · `shared/httpreq` · `webserver/apierr` · `webserver/httpapi` · `webserver/gitapi` · `shared/edgenode`·`shared/edge` 의 오류 렌더 자리 |
| **GB** `otterctl` | DM-1·2·3·4·5·24 · DM-F3·F4·F5 | `helper/runtimebin` · `shared/workspace` · `ctl/cli/options.go` |
| **GC** 공유·데몬 | DM-6·7·8·9·10·11·17 | `shared/{edgenode,edgemesh,humancmd,chatwire,toolipc,agentrec,edgerelay,platform,otterenv,sandbox,…}` · `daemon/{chat,chatsock}` |
| **GD** 도메인 | GD-1·2·3·4·5 | `webserver/domain/{worktree,submodule,git/core,claudeacct,wsentry}` |

### 1.3 범위 밖

- 시간·크기 상수의 이름 붙이기(PROD3 §2.3) — P4.
- 큰 파일·함수 분할 — P5. 이 묶음은 **옮기거나 합치기만** 하고, 합친 결과가 큰 파일을 만들면 P5 에서 나눈다.
- 프론트의 두 벌(FC-11 자동 전환 범위) — P3.

### 1.4 불변 조건 (모든 묶음)

| ID | 조건 |
|---|---|
| INV-1 | 오류 본문은 **공개 계약**이다(`architecture.md` 방언 표). 이 묶음이 고치는 모든 응답은 상태·헤더·본문 바이트가 종전과 같다. 아래 §5 에 적은 동작 변경만 예외다 |
| INV-2 | `otterctl` 의 표준 출력과 종료 코드는 종전과 같다. 예외는 §5 다 |
| INV-3 | 기존 시험은 모양을 바꾸지 않고 통과한다. 바꿔야 하면 그 시험에 이전/새/이유를 적는다 |
| INV-4 | 새 공개 API·새 와이어 이름을 만들지 않는다 |

## 2. 요구사항

### 2.1 GA — 오류 응답·본문 읽기

| ID | 요구 | 근거 |
|---|---|---|
| FR-RDG-1 | 응답 헤더 이름 `X-Error-Code` 는 `shared/httpresp.CodeHeader` 하나로 선언한다. `apierr.CodeHeader` 는 그 값을 가리킨다. 시험이 아닌 코드에 `"X-Error-Code"` 문자열 리터럴이 그 한 자리 밖에 없다 | GH-8 |
| FR-RDG-2 | 오류 응답은 `shared/httpresp` 의 렌더 함수 하나를 지난다. 그 함수가 코드 헤더를 세우고 상태와 본문을 쓴다. 방언(평문 · `{error}` · `{code,message}` · `{error,message}` · runs 의 `{error,detail,…}`)은 그 함수를 부르는 얇은 함수로 남는다 | GH-2 |
| FR-RDG-3 | `writeWhoAmIError` 를 없애고 `writeToolIOError` 를 쓴다 | GH-1 |
| FR-RDG-4 | `codeFail`·`jsonFail`·`fsFailBody`·`edgenode.writeFail` 처럼 같은 방언(`{code,message}`)의 렌더러는 FR-RDG-2 의 같은 방언 함수 하나를 쓴다. `handlers_files.go` 의 422 `encoding_unmappable` 직접 인코드도 그 길을 지난다 | GH-2 · GH-22 |
| FR-RDG-5 | JSON 본문 읽기는 `httpreq.DecodeJSON(w, r, v, limit)` 하나가 한다. 돌려주는 값은 실패 종류(없음 · 읽기 실패(+원인 오류) · JSON 아님)다. 답은 방언이 쓴다. 빈 본문을 `{}` 로 읽는 종단(`readJSONBody`)은 그 선택을 인자로 준다. 디코더 래퍼 여덟(`readBodyHTTP`·`readJSONBody`·`decodeJSONBody`·`fsDecode`·`gitDecodeBody`·`gitDecodeRawPath`·`lspReadBody`·`edgenode.readBody`)은 이것을 부르는 얇은 함수가 되거나 없어진다 | GH-3 |
| FR-RDG-6 | 본문 상한 64 KiB 는 `httpreq` 의 이름 하나(`httpreq.SmallLimit`)다. `codefail.jsonBodyLimit`·`lspMaxBody`·`edgenode.bodyLimit` 는 그것을 쓴다. 1 MiB 는 `httpreq.DefaultLimit` 하나다(`carryBodyLimit` 포함) | GH-4 |
| FR-RDG-7 | 디코드 실패 문구 규칙을 한 줄로 정한다: 읽기 실패·JSON 아님의 본문 문구는 지금처럼 원인 오류의 문구를 싣는다(git 디코더의 기존 설계 — 클라이언트가 요청의 어디가 틀렸는지 알아야 한다). 이 규칙을 `httpreq.DecodeJSON` 의 문서 주석에 적는다. 문구는 바뀌지 않는다 | GH-F3 |
| FR-RDG-8 | gitapi 처리기 첫 줄의 `if s.Git == nil { gitUnavailable(w); return }` 가드는 라우트 등록에서 한 번 감싸는 것으로 바꾼다. 503 응답은 종전과 같다 | GH-7 |
| FR-RDG-9 | 이진 판정은 한 함수다(`handlers_file_probe.go` 쪽 규칙). NUL 검사 폭은 상수 하나(`binaryProbeLen`)다. **검색도 UTF-16 BOM 이 있는 파일을 텍스트로 본다**(Q2) | GH-5·6 |

### 2.2 GB — `otterctl`

| ID | 요구 | 근거 |
|---|---|---|
| FR-RDG-20 | HTTP 응답 → 종료 코드 변환은 함수 하나다. 종단별로 다른 것(거절 본문을 어떻게 찍는가)은 인자로 준다. 지금 따로 적힌 아홉 자리(`otterctl.go` `otterctlHTTPResult`·`detach.go`·`edit.go`·`openurl.go`·`otterctl_toolio.go`·`otterctl_run_http.go`·`otterctl_order.go`·`otterctl_status.go`·`otterctl_account.go`)가 그것을 쓴다 | DM-1 |
| FR-RDG-21 | 거절 본문 렌더러는 공통 파서 하나다. `{error}` · `{error,detail,…}` · `{code,message}` 셋을 읽는다. `printRefusal`(edge 이름)을 account 가 빌려 쓰는 일이 없다 | DM-2 |
| FR-RDG-22 | `/api/state` 읽기는 함수 하나다(`fetchWorkspaceTree`·`fetchListWorkspaceRows`·`renameApplied`) | DM-3 |
| FR-RDG-23 | `list-workspace` 의 워크스페이스 순회와 JSON 모양(`wsTree`·`wsLayout`·`wsTab`·`collectPanes`·`shortCode`)은 `shared/workspace` 의 것을 쓴다(Q4). 출력은 종전과 같다(골든) | DM-4 · R9 의 `shortCode` |
| FR-RDG-24 | 손으로 인자를 도는 하위 명령은 `argSpec` 으로 옮긴다. 모르는 인자의 문구는 하나다 | DM-5 |
| FR-RDG-25 | `ctl/cli/options.go` 의 `take`·`unknownFlag` 반복은 공통 적용기 하나다 | DM-24 |
| FR-RDG-26 | `detachPost` 는 `otterctlDelivery` 로 배달을 판정한다(본문 디코드 실패를 버리지 않는다). `whoami` 의 `toolId` 는 `url.QueryEscape` 한다. `account list --json` 은 본문이 객체가 아니면 빈 객체에서 시작한다 | DM-F3·F4·F5 |

### 2.3 GC — 공유·데몬

| ID | 요구 | 근거 |
|---|---|---|
| FR-RDG-40 | hello 대기 시간은 `edgemesh` 의 내보낸 이름 하나를 `edgenode` 가 쓴다 | DM-6 |
| FR-RDG-41 | 채팅 IPC 의 연산 이름(`kill`·`kick`)과 프레임 종류(`hello`·`msg`)는 한 벌로 선언하고 나머지 자리는 그것을 가리킨다. 두 이름이 어긋나면 실패하는 시험을 둔다 | DM-7 |
| FR-RDG-42 | IPC 소켓과 같은 폴더의 형제 소켓 경로는 `platform` 의 함수 하나가 만든다(`agentrec`·`edgerelay`·`chatwire`) | DM-8 |
| FR-RDG-43 | 이름·지문 줄이기는 함수 하나와 길이 이름 둘(지문 표시 길이, 짧은 코드 길이)이다. `edgemesh.short` ↔ `daemon/chat.short` 를 합친다. 지문 표시 길이가 12·16 둘인 이유를 이름과 주석으로 적는다(같으면 하나로) | DM-9 |
| FR-RDG-44 | 표시용 정화의 공통 핵심(제어 문자 · Cf 를 지움)은 `shared/termtext` 의 함수 하나다. 지금의 여덟 자리(P1 에서 맞춘 `chatsock.clean` 포함)가 그것을 쓴다. U+FFFD 는 지금처럼 `chatsock` 만 지운다 — 다른 자리까지 넓히면 `otterctl` 출력과 `edge` 오류 문구가 바뀐다(INV-1·2). *2026-11-21 정정: 처음 문구는 공용 함수가 U+FFFD 도 지운다고 적었다* | DM-10 |
| FR-RDG-45 | `OTTERMINAL_*` 환경 변수 이름은 `otterenv` 에 모은다(`serverconf`·`updatecheck`·`ctl/cli/options.go` 의 것). `sandbox` 는 문자열 대신 `otterenv` 상수를 쓴다 | DM-11 |
| FR-RDG-46 | `sandbox` 의 런타임 시작·설치 명령은 OS 표 하나에서 문자열과 인자 배열을 함께 만든다 | DM-17 |

### 2.4 GD — 도메인

| ID | 요구 | 근거 |
|---|---|---|
| FR-RDG-60 | `worktree.Remove`·`RemoveListed` 의 같은 전처리는 함수 하나다. `worktree prune` 뒤 "사라졌나" 판정은 헬퍼 하나다 | GD-1·2 |
| FR-RDG-61 | `worktree.runGit`·`submodule.runGit` 는 `git/core` 의 함수 하나다. 다른 것(오류 매핑)은 인자다 | GD-3 |
| FR-RDG-62 | `claudeacct` 의 `Engine.Run`·`Auto.Run` 의 깨우기·ctx·타이머 루프는 공용 함수 하나에 `Tick` 을 주입한다. 최소 1초 하한 같은 차이는 인자다 | GD-4 |
| FR-RDG-63 | `wsentry` 의 홈 기본값·폴더 만들기 반복은 헬퍼 둘이다 | GD-5 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-RDG-1 | 공통 렌더·디코드는 `shared/httpresp`·`shared/httpreq` 에 둔다. `apierr` 에 두지 않는다 | `shared/edge`·`edgenode` 는 `webserver` 를 가져올 수 없다(의존 방향). 그래서 지금 헤더 이름이 네 벌이다 |
| D-RDG-2 | 방언은 합치지 않는다 | 공개 계약이고, 통일은 `G6-4` 로 기각됐다 |
| D-RDG-3 | 묶음 넷은 서로 다른 작업 트리에서 구현해 합친다 | 패키지가 겹치지 않는다. 겹치는 자리(`shared/edgenode`)는 GA 가 렌더 자리만, GC 가 대기 시간·정화만 고친다 |

## 4. 검증

| ID | 시험 | 묶음 |
|---|---|---|
| TC-RDG-1 | 방언마다 골든: 같은 실패가 바꾸기 전과 같은 상태·헤더·본문 바이트를 낸다(평문·toolio·`{code,message}`·git·runs) | GA |
| TC-RDG-2 | `"X-Error-Code"` 리터럴이 `shared/httpresp` 밖의 비시험 코드에 없다(소스 검사 시험) | GA |
| TC-RDG-3 | `httpreq.DecodeJSON` — 정상 · 빈 본문(두 선택) · 상한 초과 · 깨진 JSON | GA |
| TC-RDG-4 | 검색이 UTF-16 BOM 파일을 건너뛰지 않는다(이전: 건너뛰었다) | GA |
| TC-RDG-20 | 종료 코드 함수 — 2xx·4xx·5xx·연결 실패 × 거절 본문 셋 | GB |
| TC-RDG-21 | `list-workspace` 골든 — 출력이 종전과 같다(표본 워크스페이스 JSON 하나 이상) | GB |
| TC-RDG-22 | 모르는 인자 문구가 모든 하위 명령에서 같다 | GB |
| TC-RDG-40 | IPC 이름 대조 시험(어긋나면 실패) | GC |
| TC-RDG-41 | 정화 함수 — 제어·Cf 를 지우고 나머지는 그대로(U+FFFD 는 `chatsock/clean_test.go` 가 본다) | GC |
| TC-RDG-60 | 기존 `worktree`·`submodule`·`claudeacct`·`wsentry` 시험이 그대로 통과한다 | GD |

새 시험은 새 함수가 없는 옛 코드에서 실패한다(컴파일 실패 포함). 묶음마다 `go vet ./...` · `go test ./...`(바뀐 패키지는 `-race`) · `make gates` 를 돌린다.

## 5. 동작 변경 기록

| 묶음 | 이전 | 새 | 이유 |
|---|---|---|---|
| GA | 파일 검색이 UTF-16(BOM) 파일을 이진으로 보고 건너뛰었다 | 텍스트로 보고 찾는다(바이트 비교) | Q2 — 편집기와 같은 규칙 |
| GB | 모르는 인자 문구가 넷(`모르는 인자 %q` · `unknown argument: %s` · `모르는 플래그 %s` · `unknown flag: %s`) | 하나(`unknown argument: X`). `argparse.golden` 은 그 줄만 바뀌었다 | DM-5 · TC-RDG-22. *처음 표는 셋으로 적었다 — `unknown flag:` 는 구현 중에 찾았다* |
| GB | `list-workspace` 가 pane·split 이 아닌 레이아웃 노드의 자식도 돌았다 | 서버(`shared/workspace.CollectPanes`)와 같이 돌지 않는다 | Q4 로 한 벌이 되었다. 브라우저는 pane·split 만 만들므로(`layout-tree.js`) 실제로 나타나지 않는다 |
| GB | `rename-tab` 확인이 `/api/state` 200 만 성공으로 봤다 | 2xx | `/api/state` 읽기가 한 벌이 되었다. 서버는 늘 200 이라 실제로 나타나지 않는다 |
| GB | `detach` 가 응답 본문을 해석하지 못해도 "브라우저 없음" 으로 1 | 해석하지 못하면 `otterctlDelivery` 규칙("모른다" → 0) | DM-F3 — 규칙 두 벌을 하나로 |

## 6. 구현 기록 (2026-11-21)

| 묶음 | 커밋 | 요점 |
|---|---|---|
| GA | `d94b16bd` | `httpresp.Fail`·`FailCode`·`CodeHeader`, `httpreq.DecodeJSON`·`SmallLimit`, git 가드 10곳을 라우트 `needGit` 으로, 이진 판정 하나(검색도 UTF-16 BOM 을 텍스트로). 방언 골든 httpapi 15갈래·git 5갈래. **남긴 것:** `lspReadBody` 는 상한 상수만 공유한다(`DecodeJSON` 의 `MaxBytesReader` 가 실제 서버에서 `Connection: close` 를 붙여 INV-1 을 어긴다). 본문 검증을 git 가드보다 먼저 하는 처리기(`gitResolveRepoSoft` 류)는 감싸지 않았다(감싸면 400 이 503 이 된다). ripgrep 경로의 UTF-16 처리는 확인하지 않았다 |
| GB | `a0372852` | `httpExit`+`exitRule` 이 응답→종료 코드 아홉 자리를, `parseRefusal` 이 거절 방언 셋을, `fetchState` 가 `/api/state` 읽기 셋을 맡는다. `list-workspace` 는 `shared/workspace` 타입을 쓴다(`WsState`·`WsWindow`·`ShortCode` 로 이름을 내보냄). 골든 `httpexit.golden`(17 종단 × 19 본문)·`listworkspace.golden` 은 옛 코드로 만들었다. **남긴 것:** `send-input`·`msg`·`detach`·`parseSubArgs` 는 `argSpec` 으로 옮기면 출력이 바뀌어 문구만 맞췄다. Claude 가 부르는 명령(activity·notify·ctxhook·agentcontext·chatmcp)은 외부 계약이라 손대지 않았다 |
| GC | `994d9805` | `edgemesh.HelloWait`, kill·kick 원천은 `humancmd`(hello·msg 는 층이 달라 합치지 않음), `platform.SiblingSocket`, 새 패키지 `shared/termtext`(`Cut`·`Hidden`·`Strip`·`Line`, `FPShown=16`·`FPShort=12`), `otterenv` 에 env 이름 넷, `sandbox` OS 표 하나. **남긴 것:** `OTTERMINAL_*` 문자열 셋(`httpapi/openurl.go`·`runtimebin/otterctl_statusline.go`·`ctl/cli/doctor_probe.go`)은 FR 범위 밖이라 P4 로 |
| GD | `56dffed0` | `worktree.prepareRemove`·`pruneAndCheckGone`, `core.ExecUnguardedText`(게이트 정규식을 넓힘), `claudeacct.waker`, `wsentry.home`·`ensureRoot` |

묶음 넷을 `main` 에 합친 뒤(`cef773f3`): `gofmt` 0 · `go vet ./...` · `go test ./...` · `make gates` · `npm run -s unit`(1157) 통과. 문서의 옛 이름(`ensureDir`·`shortCodeOf`·`printRefusal`·`isBinary` 의 자리)은 `PROD3.md` P7 로 넘겼다.
