# AUDIT — Go HTTP/API 계층 (httpapi · gitapi · httproute · httpreq · apierr · seam · toolclient)

- 대상 브랜치: `refactor`
- 감사 범위: `internal/webserver/{httpapi,httproute,httpreq,gitapi,apierr,seam,toolclient}` 의 비테스트 Go 파일
- 성격: **읽기 전용 전수 감사.** 소스는 한 줄도 수정하지 않았다.
- 검증 보조: `go vet` (대상 7개 패키지 전부 clean), 도구 기반 심볼 추적 + 전수 읽기

---

## 0. 요약

### 우선순위별 건수

| 우선순위 | 건수 |
|---|---|
| HIGH | 6 |
| MED | 9 |
| LOW | 8 |
| 성능 개선 기회 | 6 |
| 문서-구현 괴리 | 4 |
| **합계** | **33** |

### 가장 중요한 5건

| # | 제목 | 왜 가장 중요한가 |
|---|---|---|
| H-1 | `X-Error-Code` 가 fs 표면 전체와 gitapi 11곳에서 빠진다 (FR-ERR-7 위반) | 방금 도입한 오류 계약이 **가장 자주 실패하는 경로**(모든 git 쓰기 실패, 모든 탐색기 오류)에서 서지 않는다. 클라이언트는 그 코드가 있다고 믿고 분기한다 |
| H-2 | 본문 상한 없는 종단 7개가 남아 있다 (FR-RQG-14 위반) | `httpreq` 패키지의 존재 이유가 "요청이 서버 메모리를 정하지 않게 한다" 인데, 인증이 없는 이 제품에서 7개 종단이 그 상태 그대로다 |
| H-3 | `PUT /api/access` 가 디스크 쓰기 실패를 삼키고 200 을 답한다 | 접근 제어 목록이다. 사용자는 목록을 켰다고 믿고, 다음 기동에서 열린 서버를 만난다 |
| H-4 | 본문 읽기 실패 6곳이 언제나 `body_too_large` 코드를 낸다 | 연결이 끊긴 400 이 "본문이 너무 큽니다" 로 나간다. `failRead` 가 이미 올바르게 존재하는데 6곳이 쓰지 않는다 |
| H-5 | 문서 주석 10개가 **다른 심볼에 붙어 있다** (godoc 오염, 2곳은 EOF 에 매달림) | 이 저장소의 주석은 설계 결정의 단일 기록이다. 그 기록이 엉뚱한 함수를 설명하면 다음 사람이 잘못된 계약을 믿고 고친다 |

**전반 평가.** 이 계층은 이미 여러 차례의 SRS 주도 리팩터를 거쳤고, `httproute`·`httpreq`·`apierr`·`gitwrite.gitWrite` 는 모범적이다. 아래 항목 대부분은 **새로 만든 규약이 기존 호출처 전부에 닿지 않은 자리**(H-1·H-2·H-4)와 **파일 분할·심볼 삽입 과정에서 어긋난 주석**(H-5)이다. 설계 결함이 아니라 마감 결손이 지배적이다.

---

## 1. HIGH

### [HIGH] H-1 — `X-Error-Code` 가 fs 표면 전체와 gitapi 11곳에서 빠진다

- 위치:
  - `internal/webserver/httpapi/handlers_fs.go:70` (`fsFail`) — `/api/fs/*` · `/api/editors/*` 오류 **전부**
  - `internal/webserver/gitapi/gitwrite.go:135`(`rejectBody`, 본문 키는 `:140`)
  - `internal/webserver/gitapi/handlers_git_write.go:158`(preflight 409) · `:266`(`gitApply` — **모든 git 쓰기 실패**)
  - `internal/webserver/gitapi/handlers_git_branch.go:158` · `:299` · `:323`
  - `internal/webserver/gitapi/handlers_git_commit_ops.go:258`
  - `internal/webserver/gitapi/handlers_git_ignore.go:135`
  - `internal/webserver/gitapi/handlers_git_operation.go:60`
  - `internal/webserver/gitapi/handlers_git_remote.go:197` (`gitPushError`)
  - `internal/webserver/gitapi/handlers_git_stash.go:281`
  - `internal/webserver/gitapi/handlers_git_tag.go:222`
  - 올바른 대조군: `gitapi/handlers_git.go:49` (`gitFail` — 헤더를 세운다), `httpapi/handlers_files.go:97` (`jsonFail` — 세운다)
- 현상: 이 자리들은 `gitFail`/`jsonFail` 을 우회해 `gitJSON`/`fsJSON` 으로 본문을 직접 쓰므로 `apierr.CodeHeader` 가 응답에 실리지 않는다.
- 비용: `ERROR_CONTRACT_SRS` **FR-ERR-7** 은 *"기존 방언 넷의 렌더러도 `X-Error-Code` 를 싣는다"* 를 요구한다. 빠진 자리가 하필 **가장 자주 실패하는 경로**다 — `gitApply` 는 stage·unstage·discard·resolve·commit·undo 의 모든 실패를 지나고, `fsFail` 은 탐색기 오류 전부를 지난다. `httperr.go:23-27` 이 적어 둔 대로 *"빈 헤더는 '코드가 없다' 가 아니라 '옮기다 잊었다' 로 읽힌다"* — 지금이 정확히 그 상태이며, 헤더만 보고 분기하는 클라이언트는 이 응답들을 코드 없는 것으로 읽는다.
- 제안:
  - `gitapi/handlers_git.go` 에 `gitErrJSON(w http.ResponseWriter, status int, code string, body map[string]any)` 를 추가한다 — `w.Header().Set(apierr.CodeHeader, code)` 뒤 `gitJSON`. 위 11곳을 이 함수로 바꾼다. `gitFail` 도 이 함수로 재구현하면 헤더를 세우는 자리가 **하나**가 된다.
  - `fsFail` 은 `handlers_files.go:97 jsonFail` 과 본문 모양이 **바이트 단위로 같다**. `fsFail` 안에 `w.Header().Set(apierr.CodeHeader, code)` 한 줄을 넣고, `jsonFail` 을 `func jsonFail(w http.ResponseWriter) failFn { return func(status int, code, msg string) { fsFail(w, code, msg) } }` 로 줄인다 (→ D-5 와 함께 해소).
  - 회귀 방지: `gitapi`·`httpapi` 의 모든 4xx/5xx 응답에 `X-Error-Code` 가 있는지 보는 테이블 테스트 하나.
- 위험도: LOW (헤더 추가는 본문 계약을 건드리지 않는다 — D-ERR-2 가 지키려는 것이 본문이다)
- 공수: M

---

### [HIGH] H-2 — 본문 상한 없는 종단 7개 (FR-RQG-14 위반)

- 위치:
  - `internal/webserver/httpapi/handlers_tools_kill.go:31` — `POST /api/tools/kill`
  - `internal/webserver/httpapi/commands.go:265` — `POST /api/command-result`
  - `internal/webserver/httpapi/focus.go:45` — `POST /api/focus/claim`
  - `internal/webserver/httpapi/handlers_attention.go:42` · `:77` · `:170` · `:268` — attention/activity/background 넷
  - 규약: `internal/webserver/httpreq/body.go:10-16`, `docs/internal/REQUEST_GATE_SRS.md:209` (FR-RQG-14)
- 현상: 전부 `json.NewDecoder(r.Body).Decode(&body)` 로 **무제한** 스트림 디코드를 한다.
- 비용: FR-RQG-14 는 *"`io.ReadAll(r.Body)` 10곳과 `decodeJSONBody`·`fsDecode` 가 **전부** 경유한다"* 고 못박았고, `httpreq/body.go` 머리말은 그 작업이 끝난 것처럼 적혀 있다 (*"`json.NewDecoder(r.Body).Decode` 가 둘이었다"* — 과거형). 실제로는 일곱이 남았다. 이 제품은 인증이 없고(`reqgate.go:14-23`) 게이트가 막는 것은 *출처*이지 *크기*가 아니므로, 허용된 기기 하나가 `POST /api/focus/claim` 에 수 GB 를 흘리면 그대로 힙에 올라간다. `handlers_attention.go` 의 넷은 **에이전트 훅이 고빈도로 때리는 경로**라 더 나쁘다.
- 제안: 일곱 자리를 전부 `decodeJSONBody(w, r, &body)` (이미 `handlers_toolio.go:204` 에 있고 `httpreq` 를 지난다) 로 바꾼다. `handlers_attention.go` 는 `writeToolIOError` 방언이 아니라 `httpErr` 방언을 쓰므로, 그 넷에는 `decodeJSONBodyHTTP(w, r, &body, code string) bool` 을 하나 더 두거나 — 더 단순하게 — `httpreq.Read` + `json.Unmarshal` 두 줄을 직접 쓴다.
- 위험도: LOW (본문이 1MiB 를 넘는 정상 호출자가 이 넷에는 없다 — 전부 `{toolId, state, tool, detail}` 수준이다)
- 공수: S

---

### [HIGH] H-3 — `PUT /api/access` 가 저장 실패를 삼키고 200 을 답한다

- 위치: `internal/webserver/httpapi/access.go:175-181` (`setConfig` 끝), 호출처 `access.go:572-588` (`apiAccessPut`)
- 현상:
  ```go
  if err := platform.WriteStateFile(s.path, data, 0o644); err != nil {
      dmlog.Infof(nil, "saveAccess: %v", err)   // ← 로그만. return 이 없다
  }
  s.refresh()
  return nil                                    // ← 언제나 성공
  ```
  같은 함수의 **marshal** 실패(`:167-172`)는 `errAccessSaveFailed` 를 돌려주는데, 실무에서 실제로 실패하는 **디스크 쓰기**는 돌려주지 않는다.
- 비용: 이것은 접근 허용 목록이다. 디스크가 가득 찼거나 홈 권한이 막혔을 때 사용자는 200 을 받고 "목록을 켰다" 고 믿는다. 메모리에는 반영되므로 그 세션에서는 동작하고, **다음 기동에서 조용히 열린 서버**가 된다. `errAccessSaveFailed` 의 주석(`:132-135`)이 *"저장 자체가 실패했다는 뜻"* 이라고 적어 둔 갈래가 정작 그 실패를 잡지 못한다. 같은 저장소의 `settingsStore.Save()`(`handlers_settings.go:55-69`)는 *"**실패를 돌려준다** (M3 DoD)"* 라고 적고 실제로 돌려주므로, 두 설정 저장소가 반대 동작을 한다.
- 제안: `access.go:175` 를 `if err := platform.WriteStateFile(...); err != nil { dmlog.Infof(...); return errAccessSaveFailed }` 로 바꾼다. `apiAccessPut` 은 이미 `errors.Is(err, errAccessSaveFailed)` 로 500 을 내므로 호출처는 손대지 않아도 된다. 다만 이때 메모리(`s.cfg`)는 이미 갱신된 상태이므로 — 저장 전에 옛 값을 붙들었다가 실패 시 되돌리거나, 최소한 응답 문구에 "적용은 됐으나 저장하지 못했습니다" 를 담아야 한다. **권장은 되돌림**이다: 디스크와 메모리가 갈리면 다음 기동의 동작을 아무도 예측할 수 없다.
- 위험도: MED (지금까지 200 이던 실패 경로가 500 이 된다 — 그것이 옳지만 동작 변경이다)
- 공수: S

---

### [HIGH] H-4 — 본문 읽기 실패 6곳이 언제나 `body_too_large` 를 낸다

- 위치 (동일 패턴 6곳):
  - `internal/webserver/httpapi/handlers_api.go:369`
  - `internal/webserver/httpapi/access.go:564`
  - `internal/webserver/httpapi/handlers_settings.go:102`
  - `internal/webserver/httpapi/handlers_workspace_revert.go:76`
  - `internal/webserver/httpapi/handlers_files.go:401` · `:495`
  - 올바른 대조군: `internal/webserver/httpapi/fail.go:45-51` (`failRead`), 이미 쓰는 곳 `handlers_api.go:520` · `handlers_update.go:37` · `commands.go:154`
- 현상: `httpErr(w, "read body", httpreq.Status(err), apierr.CodeBodyTooBig)` — 상태는 `httpreq.Status(err)` 로 갈라 놓고(413 또는 400), **코드는 무조건 `body_too_large`** 다. 연결이 끊긴 읽기 실패가 `400 body_too_large` 로 나간다.
- 비용: 클라이언트가 코드로 분기하는 것이 이 계약의 전부인데(`codes_core.go:1-13`), 같은 코드가 두 가지 서로 다른 일을 가리킨다. 사용자에게는 "나눠 보내세요" 라는 복구 안내(`codes_doc.go:36`)가 전달되지만 실제 원인은 연결이라 나눠 보내도 같은 결과가 온다. `fail.go:41-51` 이 바로 이 구분을 하려고 존재하는데 여섯 자리가 쓰지 않는다.
- 제안: 여섯 자리를 `failRead(w, err)` 로 교체한다. `handlers_files.go` 두 곳은 덤으로 `err.Error()` 누설(→ M-6)도 함께 없어진다. `failRead` 의 본문 문구가 한국어("본문을 읽지 못했습니다")이므로 영문 문구를 기대하는 e2e 가 있다면 그쪽을 함께 본다.
- 위험도: LOW
- 공수: S

---

### [HIGH] H-5 — 문서 주석 10개가 다른 심볼에 붙어 있다 (godoc 오염)

- 위치 (주석이 설명하는 심볼 → 주석이 실제로 붙은 심볼):
  | 파일:줄 | 주석이 설명하는 것 | 주석이 붙은 것 |
  |---|---|---|
  | `httpapi/handlers_fs_search.go:106-120` | `findFiles` | `fsWalkFiles` (`:121`) |
  | `httpapi/handlers_ws.go:105-120` | `handleWSDirect` | `sendModeRestore` (`:121`) |
  | `httpapi/handlers_fs.go:168-180` | `fsUnderRoot` | `fsResolveErr` (`:175`) |
  | `httpapi/handlers_fs.go:307-315` | `apiFSCreate` (`POST /api/fs/create`) | `fsRootTarget` (`:316`) |
  | `httpapi/access.go:333-339` | `allowed` | `isSelf` (`:340`) |
  | `httpapi/handlers_toolio.go:185-203` | `resolveSender` | `decodeJSONBody` (`:204`) |
  | `httpapi/handlers_runs.go:125-131` | `apiRunsGet` | `runMember` (`:132`) |
  | `gitapi/handlers_git_history.go:192-197` | `gitCountParam` | `gitBoolParam` (`:198`) |
  | `toolclient/client.go:336-339` | `handlePush` | `call` (`:340`) |
  | `toolclient/client_push.go:178-179` | `call` | **아무것도** — 파일 끝에 매달린 미완성 문장 |
  | `httpapi/server_middleware.go:148-157` | `assetVersion` (실체는 `server.go:390`) | **아무것도** — 파일 끝에 매달림 |
- 현상: 새 헬퍼를 기존 함수 **바로 위**에 삽입하면서 원 주석이 새 함수에 붙었다. `client_push.go:178` ↔ `client.go:339` 는 M9 파일 분할(FR-M9-15)이 문장 하나를 두 파일로 **반 토막** 낸 자리다: 앞은 `client_push.go` 끝에, 뒤(`"// is lost, the call times out (FR-14), or the client closes."`)는 `client.go` 의 `call` 위에 남았다.
- 비용: 이 저장소에서 주석은 장식이 아니라 **설계 결정의 단일 기록**이다 (파일마다 SRS·FR 번호가 붙어 있다). `handlers_fs.go:307` 의 주석은 `fsRootTarget` 의 godoc 으로 *"POST /api/fs/create (FR-EDT-109·115) … **Stat 후 생성하지 않는다.** 검사와 생성 사이의 경합은 os.Mkdir 와"* 라는 **중간에서 잘린 문장**을 보여 준다. `go doc`·IDE hover·LLM 코드 읽기가 전부 이 잘못된 짝을 본다. `handlers_toolio.go:185-203` 은 세 함수의 주석이 한 덩어리로 뭉쳐 `decodeJSONBody` 위에 얹혀 있어, `resolveSender` 의 FR-IDU-9 계약이 godoc 에서 사라졌다.
- 제안: 11개 블록을 원래 심볼 위로 되돌린다. `client_push.go:178-179` 의 반 토막은 `client.go:339` 의 나머지와 합쳐 `call` 위에 온전한 문장으로 두고, `client.go:336-338` 의 `handlePush` 설명은 `client_push.go:17` 로 옮긴다. `server_middleware.go:148-157` 의 `assetVersion` 블록은 `server.go:389` 로 옮긴다(그 자리에 있는 한 줄 주석과 합친다).
  회귀 방지: CI 에 간단한 스크립트 하나면 충분하다 — 함수 선언 바로 위 주석 블록의 첫 식별자가 함수 이름과 다르면 실패. (감사에 쓴 스크립트가 11개 중 9개를 정확히 잡았다.)
- 위험도: LOW (주석만 움직인다)
- 공수: S

---

### [HIGH] H-6 — `waitInFlight`·`waitMaxConcurrent` 가 패키지 전역이다

- 위치: `internal/webserver/httpapi/handlers_status.go:49-52`, 사용처 `:218-224`
  - 대조군: `internal/webserver/httpapi/server.go:159-181` (`serverLimits` / `defaultLimits`)
- 현상:
  ```go
  var (
      waitMaxConcurrent int64 = 32
      waitInFlight      atomic.Int64
  )
  ```
  프로세스 전역이다.
- 비용: `server.go:130-134` 가 이 문제를 **이미 진단하고 고친 기록**을 남겨 두었다 — *"종전에는 패키지 전역이라 '두 서버가 한 프로세스에 공존한다' 는 이 파일 머리말의 계약을 깼고, 테스트가 전역을 낮추면 같은 프로세스의 다른 서버까지 낮아졌다"* (M8 `GO-9`). 그 수선이 `serverLimits` 에만 적용되고 이 계수기에는 닿지 않았다. 결과: ① 한 프로세스의 두 `Server` 가 32개 슬롯을 나눠 쓴다 — `server.go:1-4` 의 공존 계약 위반 ② 테스트가 실제로 이것을 밟고 있다 (`handlers_status_concurrency_test.go:17-18` 이 전역을 `Store`/복구한다 — 병렬 테스트에서 다른 테스트의 `/api/tools/activity/wait` 가 429 를 받는다).
- 제안: `Server.limits` 에 `waitMaxConcurrent int64` 를 더하고(`defaultLimits()` 에서 32), 계수기는 `Server` 필드 `waitInFlight atomic.Int64` 로 옮긴다. `serverLimits` 가 이미 있으므로 새 구조를 만들 필요가 없다. 테스트는 `srv.limits.waitMaxConcurrent = 1` 로 낮춘다.
- 위험도: LOW
- 공수: S

---

## 2. MED

### [MED] M-1 — `exit` push 의 stderr 꼬리를 파싱해 놓고 버린다

- 위치:
  - `internal/webserver/toolclient/client_push.go:145-176` — `Stderr []string` 을 선언하고(`:149`) 한 번도 읽지 않는다
  - `internal/webserver/toolclient/client.go:106-112` — `SetOnExit` 주석이 *"info 는 데몬이 `exit` push 에 실은 종료 코드와 **stderr 꼬리**다 (M8_UNIFIED_SRS D-C-15)"* 라고 단언한다
  - `internal/shared/toolhub/tool_exitinfo.go:8-10` — `ExitInfo` 에는 `Code int` 뿐이다
- 현상: 데몬이 `{code, stderr[]}` 를 보내고 클라이언트가 그것을 구조체에 파싱한 뒤, `toolhub.ExitInfo{Code: ev.Code}` 로 코드만 옮긴다. 담을 필드 자체가 없다.
- 비용: 죽은 필드 하나가 아니라 **없어진 기능**이다. `docs/internal/production/M8_PROGRESS.md:164` 가 D-C-15 를 *"해소"* 로 기록하면서 *"stderr 꼬리(8줄·2 KiB)는 `toolhub.Tool.stderrTail` → `ExitInfo`"* 라고 적었는데, 지금 `ExitInfo` 에 그 자리가 없고 direct 모드(`toolhub/tool.go:178`)도 코드만 넣는다. 결과적으로 "도구가 왜 죽었는가" 의 사유가 두 모드 모두에서 사라졌고, 남은 것은 그것이 있다고 말하는 주석뿐이다.
- 제안: 둘 중 하나를 고른다.
  - ① 되살린다 — `ExitInfo` 에 `Reason string` 을 더하고 `ExitInfo.String()` 이 `"exit N: <reason>"` 을 내게 한다. `client_push.go` 는 `strings.Join(ev.Stderr, "\n")` 을, `toolhub/tool.go:178` 은 자기 `stderrTail` 을 채운다.
  - ② 폐기를 명시한다 — `client_push.go:149` 의 `Stderr` 필드를 지우고, `client.go:110-111` 의 주석과 `M8_PROGRESS.md:164` 에 "D-C-15 의 stderr 절은 폐기됨(일자·근거)" 을 적는다.
  **권장은 ①**이다. 이 기능이 붙었던 근거(`FR-ABG-20` — "프로세스가 죽으면 `Dormant=error`, 사유 줄 + 재개 버튼")가 여전히 유효하고, 데몬은 이미 값을 보내고 있어 남은 일이 수신 쪽 한 필드뿐이다.
- 위험도: LOW
- 공수: S(②) / M(①)

### [MED] M-2 — 에이전트 엔벨로프가 세 곳에서 따로 조립되고, `to=` 의 뜻이 한 곳만 다르다

- 위치:
  - `internal/webserver/httpapi/handlers_toolio.go:155-158` — `to=<toolID>`, 본문에 `quoteEnvelope` 적용
  - `internal/webserver/httpapi/handlers_runs_context.go:230-232` — `to=<rec.CoordinatorToolID>` (tool id), 인용 없음
  - `internal/webserver/httpapi/handlers_runs_context.go:400-402` — **`to=<prev.ID>` (member id)**, 인용 없음. 실제 배달은 `deliverToTool(prev.ToolID, …)` 로 **다른 식별자**에 간다
  - 계약: `docs/external/agent-orchestration.md:62` (`to=<수신 도구 uuid>`), `docs/external/api.md:42` (*"봉투 헤더와 응답의 `from`/`to` 는 **uuid** 뿐"*)
- 현상: 같은 포맷 문자열이 세 벌이고, 그중 하나가 다른 종류의 식별자를 싣는다.
- 비용: `handlers_toolio.go:189-192` 가 적은 계약이 *"헤더의 `from=` 값이 곧 답장의 `--to` 다"* 이다. 대칭으로 `to=` 도 도구 식별자여야 하는데, 승계 요청(`requestHandoff`)의 엔벨로프만 멤버 id 를 싣는다. 이 메시지를 받은 에이전트가 헤더의 `to=` 를 자기 신원으로 읽거나 그것으로 회신 대상을 고르면 존재하지 않는 도구를 가리킨다. 포맷이 세 벌인 한, 인용 정책(`quoteEnvelope`)이나 시각 형식을 바꿀 때 한 곳만 바뀐다.
- 제안: `handlers_toolio.go` 에 한 자리를 둔다.
  ```go
  const envelopeServerSender = "dongminal-server"
  // agentEnvelope 는 신뢰 봉투 한 벌이다. 본문 인용은 여기서 한다 — 호출자가
  // "서버가 쓴 글이라 안전하다" 고 판단할 자리를 남기지 않는다.
  func agentEnvelope(from, toToolID, body string) string
  ```
  세 호출처를 이것으로 바꾸고, `handlers_runs_context.go:401` 은 `prev.ToolID` 를 넘긴다 (멤버 id 는 본문의 `[HANDOFF-REQUEST … member=%s]` 에 이미 있다).
- 위험도: MED (`to=` 값이 바뀐다. 이 값을 읽는 에이전트 프롬프트·스킬이 있으면 함께 본다)
- 공수: S

### [MED] M-3 — `apiGitBranchValidate` 와 `apiGitTagValidate` 가 32줄 그대로 같다

- 위치: `internal/webserver/gitapi/handlers_git_branch.go:103-134` · `internal/webserver/gitapi/handlers_git_tag.go:148-180`
- 현상: 주석까지 거의 같다(*"이름의 문제가 아니라 저장소·git 의 문제다. 판정으로 뭉개면 사용자는 이름을 고치며 헤맨다"* 가 두 파일에 각각 있다). 다른 것은 세 가지뿐이다 — 본문의 `kinds` 키(tag 만), 검증 함수(`query.ValidBranchName` / `query.ValidTagName`), 존재 확인(`query.LocalBranchExists` / `query.TagExists`).
- 비용: 이 종단의 계약(*"위반을 요청 실패로 답하지 않는다 — 200 의 본문에 담는다"*)은 미묘하고, 두 벌이면 한쪽만 규칙이 바뀐다. 실제로 지금도 `core.ErrRefName` 판정 분기가 두 벌로 유지되고 있다 — `apierr` 가 `FR-DPN-10` 에서 없앤 바로 그 복제 형태다.
- 제안:
  ```go
  // gitNameValidateRoute 는 ref 이름 검사 종단의 공통 절차다 (FR-GIT-159·260).
  func (s *GitServer) gitNameValidateRoute(
      w http.ResponseWriter, r *http.Request,
      extra map[string]any,
      valid func(*core.Service, context.Context, string, string) error,
      exists func(*core.Service, context.Context, string, string) (bool, error),
  )
  ```
  두 핸들러는 각각 한 줄이 된다 (`tag` 쪽만 `extra: map[string]any{"kinds": write.TagKinds}`).
- 위험도: LOW (응답 본문이 바이트 단위로 같게 유지된다)
- 공수: S

### [MED] M-4 — `gitStartJob` / `gitStartUnguardedJob` 의 오류 처리가 두 벌

- 위치: `internal/webserver/gitapi/handlers_git_remote.go:161-177` · `:181-193`
- 현상: 8줄(`ErrJobBusy` → 409, 그 밖 → `gitErrorCode`)이 그대로 두 번 적혀 있다. 다른 것은 `Start` vs `StartUnguarded` 와 `extra` 유무뿐이다.
- 비용: `job_busy` 가 두 자리에 있으므로 한쪽의 상태 코드나 문구만 바뀔 수 있다 — `DRIFT_RECLAIM_SRS FR-DRC-5` 가 기록한 *"같은 '확인이 없다'가 한쪽은 `bad_request`, 다른 쪽은 `confirmation_required`"* 와 같은 부류다.
- 제안: 실행을 인자로 받고 응답을 한 자리로 모은다.
  ```go
  // gitJobStarted 는 작업 시작의 성공·실패를 한 규약으로 답한다 (FR-GIT-102).
  func (s *GitServer) gitJobStarted(w http.ResponseWriter, requested, root string,
      jb jobs.Job, err error, extra map[string]any)
  ```
  두 함수는 `Start`/`StartUnguarded` 를 부른 뒤 이것을 부르는 두 줄이 된다.
- 위험도: LOW
- 공수: S

### [MED] M-5 — 같은 오류 방언에 렌더러가 둘이고 동작이 다르다

- 위치: `internal/webserver/httpapi/handlers_fs.go:70-72` (`fsFail`) · `internal/webserver/httpapi/handlers_files.go:97-103` (`jsonFail`)
- 현상: 둘 다 `{"code":…, "message":…}` 를 내고 상태를 `apierr.FSStatus` 로 정한다. 그런데 `jsonFail` 만 `X-Error-Code` 를 세운다 (→ H-1). `jsonFail` 은 상태를 인자로 받고 `fsFail` 은 코드에서 끌어낸다.
- 비용: `handlers_files.go:95-96` 의 주석이 *"탐색기 표면의 형식이다 — /api/fs/* 의 코드 규약을 그대로 쓴다"* 라고 적었지만 **그대로 쓰지 않고 다시 구현했다.** 두 렌더러가 갈린 결과가 정확히 H-1 이다.
- 제안: `jsonFail` 을 `fsFail` 위에 얹는다 (H-1 참조). 상태를 인자로 받는 갈래가 필요하면 `fsFailAt(w, status, code, msg)` 를 `fsFail` 옆에 두고 `fsFail` 이 그것을 부른다.
- 위험도: LOW
- 공수: S

### [MED] M-6 — 오류 전문이 응답 본문으로 나간다 (fail.go 의 SEC-17 판정과 반대)

- 위치:
  - `internal/webserver/httpapi/handlers_files.go:454` (`"stat failed: "+err.Error()`) · `:526` (`"write failed: "+err.Error()`)
  - `internal/webserver/httpapi/handlers_fs.go:80`(`fsFailErr` 폴백) · `:125`(`s.Entries.Roots()` 실패) · `:177` · `:179`(`fsResolveErr` — `EvalSymlinks` 오류 전문)
  - 규약: `internal/webserver/httpapi/fail.go:11-25`
- 현상: `os.Stat`·`os.OpenFile`·`filepath.EvalSymlinks`·`platform.WriteFileAtomic` 의 오류를 그대로 본문에 싣는다. 이 오류들은 정의상 **절대경로를 포함한다** (`*PathError`).
- 비용: `fail.go:11-25` 가 이 판정을 명문화해 두었다 — *"아래 계층이 자기 사정으로 만든 말… 절대경로·명령줄·git 인자·내부 상태가 들어 있고, 그것이 응답 본문으로 나가면 곧 정찰 정보다. 종전에는 아홉 자리가 오류의 전문을 그 구분 없이 응답 본문에 그대로 실었다."* 아홉 중 여섯이 남았다. `fsResolveErr` 는 특히 나쁘다 — 존재하지 않는 경로를 넣어 가며 서버 파일시스템을 조사할 수 있다.
- 제안:
  - `handlers_files.go:454`·`:526` → `fail(w, http.StatusInternalServerError, "파일을 읽지 못했습니다"/"저장하지 못했습니다", err)` (전문은 로그로).
  - `handlers_fs.go` 의 넷 → `fsError{code, msg}` 의 `msg` 를 우리가 쓴 문구로 채우고 원본은 `dmlog` 로 보낸다. `fsError` 에 `cause error` 필드를 더해 `fsFailErr` 가 그것을 로그하게 하면 판정과 기록이 한 자리에 남는다.
  - **gitapi 쪽은 그대로 둔다.** `codes_doc.go:76` 이 *"본문의 message 에 git 의 마지막 출력이 있습니다"* 를 공개 계약으로 적었고 `gitTail` 이 상한을 건다 — 의도된 설계다.
- 위험도: MED (본문 문구가 바뀐다. 이 문구를 단정하는 e2e 가 있으면 함께 본다)
- 공수: M

### [MED] M-7 — attention 종단 넷이 해석 실패와 인자 누락을 한 코드로 뭉갠다

- 위치: `internal/webserver/httpapi/handlers_attention.go:42` · `:77` · `:170` · `:268`, `focus.go:45`, `handlers_tools_kill.go:31`
- 현상: `if err := …Decode(&req); err != nil || req.ToolID == "" { httpErr(w, "bad request", 400, apierr.CodeBadRequest) }`. `:268` 은 같은 두 갈래를 `apierr.CodeMissingArg` 로 낸다 — **깨진 JSON 이 `missing_argument` 로 나간다.** `:170` 은 세 갈래(JSON 오류 · toolId 누락 · 잘못된 state)를 하나로 뭉친다.
- 비용: `apierr.CodeInvalidJSON`·`CodeMissingArg`·`CodeBadRequest` 가 존재하는 이유가 이 구분이다 (`codes_doc.go:34-35` 가 각각에 다른 복구 안내를 붙여 놓았다: *"직렬화를 확인하세요"* vs *"본문의 문구가 빠진 항목의 이름을 말합니다"*). 지금은 어느 안내도 맞지 않는다. 훅에서 도는 종단이라 사람이 실시간으로 보지 못하고, 코드가 유일한 단서다.
- 제안: H-2 의 `decodeJSONBody` 전환과 함께 처리한다 — 해석 실패는 `CodeInvalidJSON`, 필수 인자 누락은 `CodeMissingArg`(문구에 빠진 항목 이름), 잘못된 state 는 `CodeBadRequest`(허용값 나열)로 가른다.
- 위험도: LOW
- 공수: S

### [MED] M-8 — `clipLine` 이 UTF-8 을 바이트 중간에서 자른다

- 위치: `internal/webserver/httpapi/handlers_fs_search.go:352-358`, 호출처 `:297` · `:331`
- 현상: `return s[:fsGrepMaxLine]` — 400번째 바이트가 멀티바이트 룬 중간이면 깨진 바이트열이 남는다.
- 비용: `json.Marshal` 이 유효하지 않은 UTF-8 을 U+FFFD 로 바꾸므로 오류는 나지 않고 **마지막 글자만 조용히 깨진다.** 한글·CJK 소스에서 `/api/fs/grep` 결과의 긴 줄마다 일어난다. 같은 저장소의 `asciiFallbackName`(`handlers_files.go:236-238`)이 *"바꾸는 단위는 **rune** 이다 — 바이트로 세면 한글 한 글자가 밑줄 셋이 된다"* 라고 같은 함정을 명시적으로 피해 놓았으므로, 이 자리는 그 판정이 닿지 않은 곳이다.
- 제안:
  ```go
  func clipLine(s string) string {
      if len(s) <= fsGrepMaxLine {
          return s
      }
      cut := fsGrepMaxLine
      for cut > 0 && !utf8.RuneStart(s[cut]) {
          cut--
      }
      return s[:cut]
  }
  ```
  (상한은 바이트 그대로 둔다 — 그 값의 목적이 응답 크기다.)
- 위험도: LOW
- 공수: S

### [MED] M-9 — `apiStateGet` 이 `json.Unmarshal` 오류를 이름 없이 버린다

- 위치: `internal/webserver/httpapi/handlers_api.go:249`
- 현상: `json.Unmarshal(rawWS, &ws)` — 반환값을 `_ =` 로도 받지 않는다.
- 비용: 같은 파일 `:333-336` 이 이 저장소의 규약을 적어 두었다 — *"`GO-8`: 오류를 **명시로** 무시한다. … 버리는 것과 판단한 것은 다르므로 그 사실을 여기 적어 둔다."* 여기는 판단이 적혀 있지 않다. 그리고 실제로 판단이 필요한 자리다: `workspace.json` 이 깨져 있으면 `ws` 가 nil 이 되어 `/api/state` 가 `"workspace": null` 을 조용히 답하고, 브라우저는 그것을 "창이 없다" 로 읽는다 — `reapSandboxes`(`:429-433`)가 *"Windows() 의 nil 은 '창이 없다' 가 아니라 '판단 근거가 없다'"* 라며 방어하는 바로 그 상황이다.
- 제안: 최소한 `if err := json.Unmarshal(rawWS, &ws); err != nil { dmlog.Errorf(nil, "state: workspace 해석 실패: %v", err) }`. 더 나은 쪽은 `apiWorkspaceGet`(`:346-359`)처럼 **원본 바이트를 그대로 싣는 것**이다 — 서버가 해석하지 않는 blob 을 왕복 해석할 이유가 없다 (→ P-6 참조).
- 위험도: LOW
- 공수: S

---

## 3. LOW

### [LOW] L-1 — `itoaGrep` — 테스트만 쓰는 프로덕션 함수
- 위치: `internal/webserver/httpapi/handlers_fs_search.go:360-361`, 유일 호출처 `handlers_fs_search_test.go:263`
- 현상: `strconv.Itoa` 의 별칭이며 주석이 *"테스트가 결과를 키로 묶을 때 쓴다"* 라고 밝힌다.
- 비용: 프로덕션 바이너리에 테스트 전용 심볼이 남는다. 이름도 하는 일을 말하지 않는다.
- 제안: 삭제하고 테스트가 `strconv.Itoa` 를 직접 쓴다.
- 위험도: LOW / 공수: S

### [LOW] L-2 — `loggingMiddleware` — 호출처 없음
- 위치: `internal/webserver/httpapi/server_middleware.go:59-61`
- 현상: `loggingMiddlewareFor(nil, next)` 로 위임만 한다. 비테스트 호출처가 0이다.
- 제안: 삭제한다. 테스트가 쓴다면 테스트 쪽에서 `loggingMiddlewareFor(nil, …)` 를 직접 부른다.
- 위험도: LOW / 공수: S

### [LOW] L-3 — `readWSDirect` — 한 줄짜리 무의미한 별칭
- 위치: `internal/webserver/httpapi/handlers_ws.go:308-309`, 유일 호출처 `:172`
- 현상: `func readWSDirect(conn, tool) { readWS(conn, tool) }`. 주석이 *"original WS read loop kept for direct mode"* 라고 적었지만 `readWS` 도 direct 전용이다.
- 제안: `handlers_ws.go:172` 를 `readWS(conn, tool)` 로 바꾸고 삭제한다.
- 위험도: LOW / 공수: S

### [LOW] L-4 — `adapters.Client` → `Tool` 구조체 변환과 도달 불가 분기
- 위치: `internal/webserver/seam/adapters/client.go:29` (`Tool(r).List()`), `internal/webserver/seam/adapters/tool.go:21-33` (`listPanes`)
- 현상: ① `Client` 를 `Tool` 로 **타입 변환**해 메서드를 빌려 쓴다 — 두 구조체의 필드가 우연히 같기 때문이며, 어디에도 그 의존이 적혀 있지 않다. ② `listPanes` 의 Hub 분기(`:25-31`)는 도달할 수 없다 — 유일 호출처인 `List()`(`:56`)가 `PM == nil && Hub != nil` 인 경우를 `:39-51` 에서 이미 반환한다.
- 비용: ①은 `Client` 에 필드를 하나 더하는 순간 컴파일이 깨지고(안전하긴 하다) 왜 깨졌는지가 보이지 않는다. ②는 읽는 사람이 두 갈래를 다 따라가게 만든다.
- 제안: ① `Client` 에 `func (r Client) tools() Tool { return Tool{PM: r.PM, Hub: r.Hub} }` 를 두고 그것을 부른다 — 의존이 한 줄로 보인다. ② `listPanes` 에서 Hub 분기를 지우고 `PM.Snapshot()` 만 남긴다(이름도 `pmSnapshot` 이 정직하다).
- 위험도: LOW / 공수: S

### [LOW] L-5 — `fileAllow` 의 무시되는 매개변수와 `fileDenial.log` 죽은 필드
- 위치: `internal/webserver/httpapi/file_boundary.go:36-46` (`log`), `:59` (`fileAllow(p string, _ bool)`), `:71-81` (`fileGuard` 의 `r` 는 죽은 `den.log` 분기에서만 쓰인다)
- 현상: 경계 폐기(2026-09-20) 뒤 남은 껍데기다. 파일 자신이 *"지금 이것을 채우는 자리는 없다"* 라고 밝힌다.
- 비용: `fileAllow(p, true)` 와 `fileAllow(p, false)` 가 **같은 답을 낸다.** 호출처 넷(`handlers_files.go:421`·`:439`·`:507`, `handlers_file_probe.go`)이 의미 없는 불값을 전달하며, 읽는 사람은 읽기/쓰기 판정이 살아 있다고 믿는다.
- 제안: 통로를 남기는 판단 자체는 타당하다. 다만 **말과 코드를 맞춘다** — `fileAllow(p string) (string, *fileDenial)` 로 매개변수를 없애고, `fileGuard` 의 `forWrite`·`r` 도 지운다. 판정이 다시 필요해지면 그때 인자를 더한다(그편이 "어디가 검사받는가" 를 그 커밋에서 한눈에 보이게 한다).
- 위험도: LOW / 공수: S

### [LOW] L-6 — `toolclient` 의 이름이 `paned`/`Pane` 과 `Tool` 로 갈려 있다
- 위치: `internal/webserver/toolclient/client.go:21-34` (`panedCallTimeout`·`panedDialTimeout`·`panedMaxBackoff`·`panedRespawnEvery`), `:141` (`DialPaneClientWithReconnect`), 오류 문구 `:150`(`"dial paned"`) · `:381`·`:402`(`"paned connection lost"`) · `:408`(`"paned call %q timed out"`)
- 현상: 타입은 `ToolClient`, 생성자 하나는 `DialToolClient`, 다른 하나는 `DialPaneClientWithReconnect`. 상수와 오류 문구는 전부 옛 `pane` 어휘다. `toolipc.PanedRequest` 도 같은 계열이다.
- 비용: `pane → tool` 개명이 절반만 끝났다. **오류 문구가 사용자·로그에 노출된다** — 제품 어디에도 "paned" 라는 말이 없는데 로그에는 나온다. 새 코드가 어느 어휘를 따를지 판단할 근거가 없다.
- 제안: 패키지 내부 이름은 `toolCallTimeout`·`toolDialTimeout`… 으로, `DialPaneClientWithReconnect` → `DialToolClientWithReconnect` 로 개명한다(구 이름은 필요하면 deprecated 별칭으로). 오류 문구는 `"도구 데몬 연결이 끊겼다"` 류로 통일한다. **와이어 타입(`toolipc.PanedRequest`)은 건드리지 않는다** — 그것은 옛 데몬과의 호환 표면이다.
- 위험도: LOW / 공수: M

### [LOW] L-7 — 상태 코드 리터럴과 `http.Status*` 가 섞여 있다
- 위치 (예): `handlers_api.go:234`(`404`) · `:239`·`:266`·`:363`(`500`) · `:343`·`:410`(`200`) · `:497`·`:515`(`503`) · `:533`(`204`), `handlers_settings.go:125`(`200`), `access.go:588`(`200`)
- 현상: 같은 파일 안에서 `http.StatusBadRequest` 와 `400` 이 함께 쓰인다.
- 비용: `grep -n "StatusServiceUnavailable"` 로 503 을 내는 자리를 세면 답이 틀린다. 오류 계약을 감사할 때마다 두 가지로 찾아야 한다.
- 제안: `http.Status*` 로 통일한다. 기계적 치환이며 `go vet` 로 검증된다.
- 위험도: LOW / 공수: S

### [LOW] L-8 — `apiToolsCreate` 가 `cwd` 질의를 두 번 파싱한다
- 위치: `internal/webserver/httpapi/handlers_api.go:270` 과 `:288`
- 현상: `r.URL.Query().Get("cwd")` 를 두 번 부른다 (`r.URL.Query()` 는 호출마다 질의문자열을 **다시 파싱하고 map 을 새로 만든다**). 같은 핸들러가 `r.URL.Query()` 를 총 7회 부른다(`:270`·`:272`·`:287`·`:288`·`:296`·`:299`·`:302` 부근).
- 비용: 성능은 무시할 만하다. 진짜 비용은 **읽기 어려움**이다 — `:270` 의 `cwd`(cwdTool 폴백 포함)와 `:288` 의 `explicit`(폴백 없는 원값)가 다른 것임을 두 번 파싱한다는 사실에서 유추해야 한다.
- 제안: 함수 머리에서 `q := r.URL.Query()` 를 한 번 잡고, 두 값에 `cwd` / `explicitCwd` 라는 별개 이름을 준다.
- 위험도: LOW / 공수: S

---

## 4. 성능 개선 기회

### [HIGH] P-1 — 사전압축 자산을 요청마다 통째로 읽고(필요하면 통째로 푼다)
- 위치: `internal/webserver/httpapi/static.go:191-227` (`servePrecompressed`), 특히 `:196` (`fs.ReadFile`) 과 `:214-225` (gzip 해제)
- 현상: `.gz` 자산 요청마다 ① `fs.ReadFile` 로 전체를 힙에 복사하고 ② `Accept-Encoding` 에 gzip 이 없으면 추가로 전체를 해제해 두 번째 버퍼를 만든다. 캐시가 없다.
- 비용: 이 파일의 주석(`:185-187`)이 규모를 적어 두었다 — *"Monaco 의 `min/vs` 는 raw 23.3MB·gzip 5.4MB"*. 콜드 페이지 로드는 수십 개의 Monaco 청크를 받으므로, 매 요청이 자기 크기만큼 힙을 잡았다 버린다. 자산은 `go:embed` 라 **프로세스 수명 동안 절대 바뀌지 않는다** — 같은 파일의 `etags` 맵(`:53-54`)이 이미 그 근거로 캐시를 두고 있는데 바이트는 캐시하지 않는다. 비gzip 클라이언트(`dmctl`·curl·일부 프록시)는 매 요청 전체 해제를 유발한다.
- 제안: `staticHandler` 에 `sync.Map`(또는 `mu` 아래 map) 기반 `blobs map[string][]byte` 를 두고 `.gz` 원본과 해제본을 **처음 한 번만** 담는다. 전체 자산이 5.4MB + 자주 쓰이는 해제본이므로 상주 메모리 증가는 예측 가능하다. 더 보수적으로 가려면 해제본만 캐시하고 압축본은 `fs.Open` 으로 스트리밍한다(`http.ServeContent` 의 Range 지원을 유지하려면 `io.ReadSeeker` 가 필요하므로 `embed.FS` 파일은 그대로 쓸 수 있다).
- 예상 효과: 콜드 로드 시 힙 할당 수십 MB → 0 (캐시 워밍 후). 비gzip 클라이언트의 요청당 CPU(5.4MB gunzip ≈ 20–40ms) → 0.
- 측정 방법: `go test -bench BenchmarkStaticMonaco -benchmem ./internal/webserver/httpapi/` 로 `allocs/op`·`B/op` 를 전후 비교. 실제 로드는 서버에 `net/http/pprof` 를 붙이고 페이지 새로고침 중 `go tool pprof -alloc_space` 를 뜬다.
- 위험도: LOW / 공수: M

### [MED] P-2 — `etags` 가 요청자가 정하는 키로 무한히 자라는 음수 캐시
- 위치: `internal/webserver/httpapi/static.go:303-334` (`etagFor`), 특히 `:327-332`
- 현상: 존재하지 않는 경로도 `tag == ""` 인 채로 `h.etags[name] = tag` 에 들어간다. 키는 요청 URL 에서 온다.
- 비용: `GET /a1`, `/a2`, … 를 반복하면 맵이 요청 수만큼 자란다. `fs.ValidPath` 가 형식만 거르므로 유효한 상대경로 문자열은 전부 키가 된다. 허용된 기기만 닿는 표면이지만(ACL), **정적 자산은 `gateExempt`(`reqgate.go:149-158`)로 출처 게이트를 비켜 간다** — 즉 게이트 한 겹만 지나면 닿는다. 상한도 만료도 없다.
- 제안: 빈 태그는 캐시하지 않는다 (`if tag != "" { … }`). 그러면 없는 파일은 매번 두 번의 `fs.Stat` 을 하지만 그것은 `embed.FS` 의 맵 조회라 싸다. 더 엄격히 가려면 `etags` 를 부팅 시 `fs.WalkDir` 로 **미리 채우고 쓰기를 닫는다** — 자산은 불변이므로 지연 계산이 벌어 주는 것이 없고, 맵이 닫히면 잠금도 필요 없어진다(`mu` 제거).
- 예상 효과: 무한 증가 경로 제거. 사전 채움을 택하면 `h.mu` 잠금이 요청 경로에서 사라진다.
- 측정 방법: 무작위 404 경로 10만 건을 보낸 뒤 `runtime.ReadMemStats` 의 `HeapInuse` 비교, 또는 `pprof -inuse_space` 에서 `etagFor` 프레임 확인.
- 위험도: LOW / 공수: S

### [MED] P-3 — `gitPinnedEntries` 가 핀마다 `RepoRoot` 를 순차로 부른다
- 위치: `internal/webserver/gitapi/handlers_git.go:210-228` (`:218` 의 루프 안 `s.Git.RepoRoot`), 대조군 `:122-149` (`gitObservePins` — `gitObserveMax=4` 로 병렬)
- 현상: `GET /api/git/repos` 의 기본 경로(`observe` 없음)가 핀 N개에 대해 `RepoRoot` 를 순차 호출한다. `store.Store` 의 TTL 이 2초(`store.go:19 DefaultRepoRootTTL`)이므로 그보다 느린 폴링에서는 매번 N번의 `git rev-parse` 프로세스가 **직렬로** 뜬다.
- 비용: 핀 10개 × `rev-parse` 10–30ms ≈ 100–300ms 의 응답 지연. Git 탭이 열려 있는 동안 반복된다. 같은 파일이 바로 위에서 이 문제를 이미 풀어 놓았다(`gitObservePins`) — 그 수단이 형제 함수에 닿지 않았다.
- 제안: `gitObservePins` 의 세마포어 패턴(`sem := make(chan struct{}, gitObserveMax)`)을 `gitPinnedEntries` 에 그대로 적용한다. 결과 슬라이스는 **인덱스로 쓴다** — 핀 순서가 사용자가 정한 순서이고 그것이 계약이다(`:208-209`).
- 예상 효과: 벽시계 지연이 N배 → ⌈N/4⌉배. 핀 10개 기준 ~250ms → ~75ms.
- 측정 방법: `curl -w '%{time_total}' /api/git/repos` 를 핀 1·5·10개에서 전후 비교. 또는 `apiGitRepos` 에 벤치마크를 붙이고 `rev-parse` 호출 수를 fake `Service` 로 센다.
- 위험도: LOW (순서만 보존하면 응답이 동일하다)
- 공수: S

### [MED] P-4 — `grepWithGo` 가 파일마다 전체를 두 번 복사한다
- 위치: `internal/webserver/httpapi/handlers_fs_search.go:309-335`, 특히 `:314` (`os.ReadFile`) 과 `:318` (`strings.Split(string(blob), "\n")`)
- 현상: 파일당 ① `ReadFile` 로 최대 2MiB(`fsGrepMaxBytes`) ② `string(blob)` 로 같은 크기 한 번 더 ③ `strings.Split` 으로 줄 개수만큼의 string 헤더 슬라이스. 전부 매 파일마다, 매 요청마다.
- 비용: ripgrep 이 없는 환경의 기본 경로다(Windows·최소 컨테이너). 파일 5000개 트리를 훑으면 GB 단위의 할당이 GC 를 때린다. `isBinary`(`:344-350`)가 앞 8000바이트만 보므로 이진 파일도 일단 전량 읽은 뒤 버린다.
- 제안: `os.Open` + `bufio.Scanner` 로 바꾼다. 앞 8000바이트를 먼저 읽어 `isBinary` 판정 후 되감기(`f.Seek(0,0)`)하면 이진 파일의 전량 읽기가 사라진다. `Scanner.Buffer` 상한은 `fsGrepMaxLine` 이 아니라 현실적인 최대 줄 길이(예: 1MiB)로 두고, 초과 줄은 건너뛴다.
  ```go
  // grepFile 은 파일 하나를 줄 단위로 훑는다 — 전량을 메모리에 올리지 않는다.
  func grepFile(path, needle string, limit int, add func(line int, col int, text string) bool) error
  ```
- 예상 효과: 파일당 상주 메모리 O(파일크기) → O(줄길이). 5000파일 트리에서 할당 총량 수 GB → 수 MB.
- 측정 방법: 큰 트리(예: 이 저장소 자체)에 대해 `go test -bench BenchmarkGrepWithGo -benchmem`. `B/op` 와 `allocs/op` 가 지표다.
- 위험도: MED (줄 분할 경계가 바뀐다 — 지금은 `\n` 만 자르고 마지막 줄에 종결자가 없어도 포함된다. `bufio.Scanner` 의 기본 `ScanLines` 는 `\r\n` 도 처리하므로 `Col` 값이 CRLF 파일에서 달라질 수 있다. 테스트로 고정할 것)
- 공수: M

### [LOW] P-5 — `lookRipgrep` 이 요청마다 PATH 를 훑는다
- 위치: `internal/webserver/httpapi/handlers_fs_search.go:219-225`, 호출처 `:200`
- 현상: `GET /api/fs/grep` 마다 `exec.LookPath("rg")` — PATH 의 모든 디렉터리에 대한 `stat` 이다.
- 비용: PATH 항목이 20개면 요청당 최대 20번의 syscall. 편집기의 찾기 패널은 타이핑 중에도 부르므로 빈도가 높다. `rg` 의 존재 여부는 프로세스 수명 동안 사실상 바뀌지 않는다.
- 제안: `var lookRipgrep = sync.OnceValue(func() string { p, err := exec.LookPath("rg"); if err != nil { return "" }; return p })`. 테스트가 결과를 바꿔야 하면 `var ripgrepPath = sync.OnceValue(...)` + 테스트용 주입 변수로 둔다.
- 예상 효과: 요청당 syscall 수십 개 제거. 절대값은 작지만 공수도 작다.
- 측정 방법: `strace`/`dtruss` 로 `/api/fs/grep` 한 건의 `stat` 호출 수를 전후 비교.
- 위험도: LOW / 공수: S

### [LOW] P-6 — `/api/state` 가 workspace blob 을 왕복 해석한다
- 위치: `internal/webserver/httpapi/handlers_api.go:242-261` (`:249` 의 `json.Unmarshal`, `:254` 의 `Encode`)
- 현상: 저장된 workspace 바이트를 `interface{}` 로 해석했다가 응답 JSON 안에 다시 인코딩한다. `apiWorkspaceGet`(`:346-359`)은 같은 바이트를 **그대로** 쓴다.
- 비용: 워크스페이스는 창·탭·핀이 쌓이면 커지도록 설계돼 있고(`httpreq.WorkspaceLimit = 8MiB`), `/api/state` 는 부팅·재연결마다 불린다. `map[string]interface{}` 트리로의 해석은 JSON 파싱 중 가장 비싼 형태다 — 키마다 맵 할당, 숫자마다 `float64` 박싱. 그러고는 곧바로 다시 직렬화한다. 게다가 M-9 의 오류 삼킴이 여기 있다.
- 제안: `ws` 를 `json.RawMessage` 로 받는다. `map[string]interface{}` 대신 명시 구조체 + `Workspace json.RawMessage` 를 쓰면 해석·재직렬화가 사라지고 M-9 도 함께 없어진다 (빈 값일 때 `json.RawMessage("null")` 을 넣는다).
- 예상 효과: 워크스페이스 크기에 비례하던 CPU·할당 제거. 1MB blob 기준 파싱+재직렬화 ≈ 10–20ms → ~0.
- 측정 방법: 큰 `workspace.json` 픽스처로 `BenchmarkAPIState -benchmem`.
- 위험도: LOW (응답 바이트는 키 순서를 빼면 동일. 클라이언트가 키 순서에 의존하지 않음은 JSON 계약상 보장된다)
- 공수: S

### [LOW] P-7 — `callWithin` 이 소켓 쓰기 동안 넓은 뮤텍스를 쥔다
- 위치: `internal/webserver/toolclient/client.go:364-366`
- 현상: `pc.mu.Lock(); err := enc.Encode(req); pc.mu.Unlock()` — `pc.mu` 는 `conn`·`pending`·`onOutput`/`onExit`/`onForeground`·`daemonInfo` 를 모두 지키는 잠금이다.
- 비용: 쓰기 직렬화 자체는 필요하다(JSON 스트림이므로). 문제는 **같은 잠금**이라는 것이다 — 소켓이 느려지면 그 동안 `handleResponse`(`:326-330`)·`pushOutput`(`:93-95`)·`Connected()` 가 전부 막힌다. `pushOutput` 이 막히면 `readLoop` 가 서고, 그 루프는 **모든 도구의** push 를 나른다. `client_push.go:99-110` 이 정확히 이 위험("느린 브라우저 하나가 나머지 전부를 멎게 하는 자리를 만들지 않는다")을 피하려고 구독 전송을 non-blocking 으로 만들어 놓았는데, 쓰기 잠금이 같은 경로를 뒤에서 되살린다.
- 제안: 쓰기 전용 뮤텍스 `writeMu sync.Mutex` 를 분리한다. 로컬 유닉스 소켓이라 실제로 막히는 일은 드물지만, 분리 비용이 필드 하나다.
- 예상 효과: 병리적 상황에서의 head-of-line 제거. 정상 상황의 처리량 변화는 미미하다.
- 측정 방법: 도구 8개에 동시 출력을 흘리면서 `go test -race -bench BenchmarkToolClientConcurrentCalls` 로 p99 지연 비교. 또는 `runtime/trace` 로 `mu` 대기 시간 확인.
- 위험도: LOW / 공수: S

---

## 5. 문서-구현 괴리

### [HIGH] D-1 — FR-RQG-14: "전부 경유한다" 가 7곳에서 거짓
- 근거 문서: `docs/internal/REQUEST_GATE_SRS.md:209-211` — *"공통 `readJSON(w, r, limit, into) error` 하나를 만들고 `io.ReadAll(r.Body)` 10곳과 `decodeJSONBody`·`fsDecode` 가 **전부** 경유한다. 그 안에서 `http.MaxBytesReader` 와 크기 초과 판정(413)을 함께 한다."*
- 구현: `handlers_tools_kill.go:31` · `commands.go:265` · `focus.go:45` · `handlers_attention.go:42`·`:77`·`:170`·`:268` — 무제한 `json.NewDecoder(r.Body)`
- 분류: **구현 미흡** (부분 적용)
- 부수 피해: `internal/webserver/httpreq/body.go:10-16` 의 패키지 머리말이 과거형으로 *"`json.NewDecoder(r.Body).Decode` 가 둘이었다"* 라고 적어, **문서가 코드보다 낙관적**이다. 이 패키지를 읽는 사람은 상한이 전면 적용된 줄 안다.
- 조치: H-2. 함께 `body.go` 의 머리말도 현재 상태에 맞춘다.

### [HIGH] D-2 — FR-ERR-7: 헤더가 방언 넷 중 둘에서 빠진다
- 근거 문서: `docs/internal/ERROR_CONTRACT_SRS.md:108-109` — *"기존 방언 넷의 렌더러도 `X-Error-Code` 를 싣는다. 본문의 코드와 같은 값이다 — 두 자리가 갈리면 헤더 쪽이 거짓말이 된다."*
- 구현: `{code,message}` 방언의 주 렌더러(`httpapi/handlers_fs.go:70 fsFail`)와 `{error,message}` 방언의 직접 조립 11곳이 헤더를 세우지 않는다 (전체 목록은 H-1).
- 분류: **구현 미흡**
- 조치: H-1.

### [MED] D-3 — D-C-15 (FR-ABG-20): exit 의 stderr 사유가 사라졌다
- 근거 문서: `docs/internal/production/M8_PROGRESS.md:164` — *"**해소 (둘 다)** … stderr 꼬리(8줄·2 KiB)는 `toolhub.Tool.stderrTail` → `ExitInfo` — 직접 모드 `ExitObserver(id, info)`, 데몬 `exit` push `{code, stderr[]}`(종전 `code:0` 고정을 실제 값으로). 뷰: `data-state=error` + 사유 줄 + 재개 버튼"*
- 구현: `internal/shared/toolhub/tool_exitinfo.go:8-10` 의 `ExitInfo` 에는 `Code int` 뿐이다. `toolclient/client_push.go:149` 가 `Stderr []string` 을 파싱하고 `:170`·`:174` 에서 버린다. `toolhub/tool.go:178` 도 코드만 넣는다.
- 분류: **잘못 구현** — 문서가 해소로 기록한 기능이 지금 코드에 없고, `toolclient/client.go:110-111` 의 주석이 그 없어진 계약을 여전히 단언한다.
- 조치: M-1.

### [MED] D-4 — 엔벨로프 `to=` 가 한 자리에서 멤버 id 를 싣는다
- 근거 문서: `docs/external/agent-orchestration.md:62` (`[DONGMINAL-AGENT-MSG from=<발신 도구 uuid> to=<수신 도구 uuid> ts=…]`), `docs/external/api.md:42` (*"봉투 헤더와 응답의 `from`/`to` 는 **uuid** 뿐"*), `docs/internal/ORCHESTRATION_V2_SRS.md:439` (`to=<조정자 uuid>`)
- 구현: `internal/webserver/httpapi/handlers_runs_context.go:401` 이 `prev.ID`(run 멤버 id)를 `to=` 에 넣는다. 배달은 `deliverToTool(prev.ToolID, …)`(`:403`)로 **다른 식별자**에 간다. 같은 파일 `:231` 과 `handlers_toolio.go:156` 은 도구 id 를 넣는다.
- 분류: **잘못 구현** (한 자리)
- 조치: M-2.

---

## 6. 흠잡지 않은 것 (참고)

아래는 검토했고 **손댈 이유가 없다**고 판단한 것들이다. 다음 감사가 같은 자리를 다시 파지 않도록 남긴다.

- `internal/webserver/httproute/httproute.go` — 두 라우팅 표의 통합이 깔끔하고, `Under`/`UnderWith` 의 명명 근거가 주석에 있다. 무키 리터럴 제거 이유(`go vet composites`)도 명시적이다.
- `internal/webserver/apierr/*` — `Table`/`Inventory`/`Unmapped` 의 삼분할이 "빠뜨림"과 "확인함"을 구조적으로 가른다. 표면별 테이블이 둘인 이유도 반례와 함께 적혀 있다.
- `internal/webserver/gitapi/gitwrite.go` — sticky-error 파이프라인. 순서 불변식을 주석이 아니라 타입에 둔 것이 정확하다.
- `internal/webserver/httpapi/reqgate.go` — 게이트 네 단계의 순서와 각 단계의 우회 시나리오가 전부 근거와 함께 적혀 있다. `matchHostPattern` 의 `*.` 접미사 규칙도 정확하다.
- `internal/webserver/httpapi/server_middleware.go` 의 `responseWriter` — `wrote` 플래그와 `Hijack`/`Flush` 위임이 SSE·WS 를 정확히 다룬다.
- `internal/webserver/httpapi/handlers_files.go` 의 `attachmentDisposition`/`rfc5987Escape`/`asciiFallbackName` — RFC 6266·5987 처리가 정확하고 rune 단위 판정 근거가 적혀 있다.
- `internal/webserver/httpapi/static.go` 의 `acceptsGzip`/`qZero` — `gzip;q=0` 을 토큰으로 가르는 판정이 옳다.
- `internal/webserver/toolclient/client_toolhub.go` 의 `ListOK` 세대 기반 캐시 무효화 — 경합 시나리오가 실측 근거와 함께 문서화돼 있다.

---

## 7. 권장 착수 순서

1. **H-5** (주석 위치 복원) — 다른 모든 작업의 전제다. 잘못된 계약을 읽으며 고치면 안 된다. 위험 0, 반나절.
2. **H-1 + M-5** (X-Error-Code 일원화) — 렌더러를 한 자리로 모으면서 헤더 구멍을 함께 닫는다.
3. **H-2 + M-7** (본문 상한 + 오류 코드 구분) — 같은 일곱 자리를 한 번에 지난다.
4. **H-4** (`failRead` 전환) · **H-3** (access 저장 실패) · **H-6** (wait 전역) — 각각 독립이고 전부 S.
5. **P-1 + P-2** (정적 자산) — 사용자 체감이 가장 큰 성능 항목이며 `etags` 사전 채움으로 둘을 한 번에 푼다.
6. 나머지 MED/LOW 는 인접 파일을 건드릴 때 함께.

**D-1·D-2·D-3·D-4 는 각각 대응 코드 수정과 **같은 커밋**에서 문서를 고친다.** 특히 `httpreq/body.go` 머리말과 `toolclient/client.go:110-111` 은 코드보다 낙관적인 상태이므로, 코드를 고치지 않기로 결정한 항목이 있다면 문서 쪽을 먼저 현실에 맞춰야 한다.
