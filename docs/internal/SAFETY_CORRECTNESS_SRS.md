# SRS: 조용히 틀리는 일곱 자리를 소리 나게 만든다 — IEEE 29148

> **문서 상태**: 승인·구현완료

- 접수: 2026-09-20 (프로덕션 승격 감사 1단계 · `docs/internal/refactor/` 214건 중 묶음 B1)
- 선행: `docs/internal/refactor/README.md` §3 "가장 먼저 고쳐야 할 열 가지"

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

전수 감사가 찾은 214건 중, **실패했는데 성공으로 보이는** 자리만 모았다.
일곱 자리는 성격이 하나다 — 잘못된 결과가 **그 순간에는 보이지 않는다**.

| 자리 | 지금 무엇이 보이나 | 실제로 무슨 일이 났나 |
|---|---|---|
| 접근 허용 목록 저장 | `200 OK` | 디스크에 안 적혔다. 다음 기동에 **열린 서버** |
| `run.Store` 조회 | 정상 응답 | 잠금 밖으로 내부 배열·포인터가 나갔다 (`-race` 대상) |
| 본문 상한 없는 종단 7개 | 정상 응답 | 요청자가 서버 힙 크기를 정한다 |
| 오류 응답 (fs 전체·gitapi 11곳) | 오류 본문 | `X-Error-Code` 가 없어 **"코드 없음"** 으로 읽힌다 |
| 본문 읽기 실패 6곳 | `body_too_large` | 연결이 끊긴 것이어도 "본문이 큽니다" 라고 답한다 |
| `TimerHub` 의 `after` 콜백 | 화면이 안 갱신됨 | **앱의 유일한 스케줄러가 멎었다** |
| 슬롯 2·3 의 도구 인스턴스 | 도구를 지웠다 | 인스턴스가 살아남아 죽은 PTY 로 **무한 재접속** |
| `git status` (대형 저장소) | 짧은 목록 또는 실패 | 출력이 1MiB 에서 **잘렸다** |

공통 처방도 하나다. **사실을 실어 보낸다** — 삼키지 않고, 감추지 않고,
추측하지 않는다.

### 1.2 범위 (Scope)

| 묶음 | 내용 | 축 |
|---|---|---|
| **A** 저장 실패 | `PUT /api/access` 가 쓰기 실패를 돌려준다 | 서버 |
| **B** 잠금 경계 | `run.Store` 의 반환값이 내부를 공유하지 않는다 | 서버 |
| **C** 본문 상한 | 종단 7개가 `httpreq` 를 지난다 | 서버 |
| **D** 오류 코드 | 모든 4xx/5xx 가 `X-Error-Code` 를 싣는다 · 읽기 실패가 제 코드를 낸다 | 서버 |
| **E** 스케줄러 | `TimerHub` 가 콜백 예외로 멎지 않는다 | 프론트 |
| **F** 슬롯 순회 | 손으로 적은 슬롯 목록을 `SLOT_MAX` 파생으로 바꾼다 | 프론트 |
| **G** 출력 잘림 | `StatusOf` 가 잘림을 사실로 싣는다 | 서버 |
| **V** 게이트 | 위 일곱이 **다시 새지 않도록** 검사를 세운다 | 도구 |

**미포함:** §6.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **방언** | 오류 응답의 본문 모양. 이 저장소에 넷이 있다 (`ERROR_CONTRACT_SRS`) |
| **잘림** | `core.DefaultMaxOutput`(1MiB)에 닿아 git 출력이 끊긴 것 (`core/exec.go:19`) |
| **슬롯** | 창 슬롯. `SLOT_MAX=4` (`app-slots.js:21`) |
| **손으로 적은 목록** | 상수에서 파생하지 않고 자리마다 나열한 목록 |

### 1.4 참조 (References)

| 문서 | 이 SRS 와의 관계 |
|---|---|
| `ERROR_CONTRACT_SRS` FR-ERR-7 | 묶음 D 가 못 지킨 요구 |
| `REQUEST_GATE_SRS` FR-RQG-14 | 묶음 C 가 못 지킨 요구 |
| `GIT_DOMAIN_TRUNCATION_SRS` FR-GDT-22·23 | 묶음 G 의 규약 |
| `WINDOW_SLOTS_SRS` FR-WSL-22 | 묶음 F 가 못 지킨 요구 |
| `docs/internal/refactor/AUDIT-go-http.md` H-1~H-4 | 묶음 A·C·D 의 근거 |
| `docs/internal/refactor/AUDIT-go-domain.md` | 묶음 B·G 의 근거 |
| `docs/internal/refactor/AUDIT-fe-core.md` H1·H5 | 묶음 E·F 의 근거 |

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 요구는 이미 적혀 있고, 코드가 그것을 안 지킨다

일곱 중 넷은 **새 요구가 아니다.** 문서가 이미 못박았고 구현이 일부만 닿았다.

| 요구 | 문서의 말 | 실제 |
|---|---|---|
| FR-ERR-7 | *"기존 방언 넷의 렌더러도 `X-Error-Code` 를 싣는다"* | `gitFail`·`jsonFail` 둘만. fs 표면 **전체**와 gitapi **11곳**이 빠졌다 |
| FR-RQG-14 | *"`io.ReadAll` 10곳과 `decodeJSONBody`·`fsDecode` 가 **전부** 경유한다"* | `json.NewDecoder(r.Body).Decode` **7곳**이 무제한으로 남았다 |
| FR-WSL-22 | *"도구를 지우는 경로는 **모든 슬롯의 인스턴스**를 파괴한다"* | 주석 바로 아래 코드가 슬롯 0·1 만 돈다 |
| FR-GDT-22 | 대형 저장소의 잘림을 겨냥 | 조회 9개 중 `StatusOf` **하나만** 잘림을 안 본다 |

`httpreq/body.go` 머리말은 그 작업이 끝난 것처럼 **과거형**으로 적혀 있다
(*"`json.NewDecoder(r.Body).Decode` 가 둘이었다"*). 실제로는 일곱이 남았다.

### 2.2 올바른 형태가 이미 저장소 안에 있다

일곱 전부 **같은 저장소 안에 정답이 있다.** 새로 설계할 것이 없다.

| 묶음 | 올바른 대조군 | 어긋난 쪽 |
|---|---|---|
| A | `settingsStore.Save()` — *"**실패를 돌려준다** (M3 DoD)"* (`handlers_settings.go:55`) | `access.go:175` 은 로그만 찍고 `return nil` |
| B | `store_messages.go:61` — `Messages` 를 새 배열로 옮기며 *"읽는 쪽이 잠금 밖이라 데이터 레이스다"* 라고 적는다 | 같은 처방이 `Members`·`Worktree` 에 없다 |
| C | `decodeJSONBody` (`handlers_toolio.go:204`) | 7곳이 `json.NewDecoder` 직행 |
| D | `gitFail` (`handlers_git.go:49`) · `failRead` | `gitJSON`/`fsJSON` 직행 11곳 · `failRead` 를 안 쓰는 6곳 |
| E | `EventBus.publish` — *"하나가 던져도 나머지는 받는다"* (`event-bus.js:95`) | `TimerHub._tick` 의 `after` 만 구멍 |
| F | `_slotReap` — `for(let i=1;i<SLOT_MAX;i++)` (`app-slots.js:549`) | `_killToolInstances`·`toolAny` 가 손으로 적은 목록 |
| G | `log.go:120`·`refs.go:77`·`diff.go:160` 외 8개 조회 | `status.go:306` 만 안 본다 |

**결론: 이 묶음은 설계가 아니라 적용이다.** 판단이 필요한 자리는 A(되돌림
여부)와 G(실패로 끝낼 수 없는 표면) 둘뿐이고, 둘 다 §4 에서 정한다.

### 2.3 왜 게이트가 못 잡았나

`make gates` 33종 전량 통과 상태에서 이 일곱이 살아 있다. 검사가 **세는 방법**
때문이다.

| 검사 | 세는 것 | 못 세는 것 |
|---|---|---|
| (없음) | — | 4xx/5xx 응답의 `X-Error-Code` 유무 |
| (없음) | — | 요청 본문을 읽는 자리가 `httpreq` 를 지나는가 |
| `check-*` 계열 | 선언·이름의 일치 | **손으로 적은 목록**이 상수를 따라갔는가 |

묶음 V 가 이 셋을 세운다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 저장 실패

- **FR-SAF-1** `saveAccess` 는 `platform.WriteStateFile` 실패 시
  `errAccessSaveFailed` 를 돌려준다. 호출처(`apiAccessPut`)는 이미
  `errors.Is` 로 500 을 내므로 고치지 않는다.
- **FR-SAF-2** 저장에 실패하면 **메모리도 되돌린다.** 저장 전 값을 붙들었다가
  복원하고 `s.refresh()` 를 부르지 않는다. 근거는 D-SAF-1.
- **FR-SAF-3** 이것은 **동작 변경**이다. 이전 동작 / 새 동작 / 이유를 변경
  기록과 커밋에 적는다.

### 3.2 묶음 B — 잠금 경계

- **FR-SAF-4** `cloneRun(Record) Record` 와 `cloneMember(Member) Member` 를
  세운다. 잠금 밖으로 나가는 **참조 필드 다섯 전부**를 덮는다.

  | 타입 | 필드 | 종류 | 지금 상태 |
  |---|---|---|---|
  | `Record` | `Members []Member` | 슬라이스 | 감사가 지목 |
  | `Record` | `Worktree *Worktree` | 포인터 (per-run 공유 트리) | **감사가 놓침** |
  | `Record` | `Coordinator *ContextState` | 포인터 | **감사가 놓침** |
  | `Record` | `Messages []MsgEvent` | 슬라이스 | `store_messages.go` 가 이미 지킨다 |
  | `Member` | `Worktree *Worktree` | 포인터 | 감사가 지목 |
  | `Member` | `FilesModified []string` | 슬라이스 | **감사가 놓침** |

  `Member` 의 임베드 `ContextState` 와 `Worktree` 의 본문은 **전부 스칼라**이므로
  포인터 대상은 값 복제 한 번으로 끝난다.
- **FR-SAF-4a** `cloneRuns`(`store.go:77`)를 **재사용하지 않는다.** 그것은
  되돌리기용이고 `Members` 만 덮는다 — 머리말이 적은 목적("되돌릴 수 있는
  깊이까지")이 다르다. `cloneRun` 을 세운 뒤 `cloneRuns` 가 그것을 돌게 하여
  깊이를 **한 자리**로 모은다.
- **FR-SAF-5** 잠금 밖으로 `Record`/`Member` 를 내보내는 **모든** 경로가 그것을
  지난다: `Get`·`List`·`MemberByTool`·`FindMember`·`Close`·`Sweep`·`Delete`·
  `Report`·`Succeed`·`ObserveContext`·`mutateMember`.
- **FR-SAF-6** 착수 전에 **반환된 포인터로 저장소를 고치는 호출처가 있는지**
  확인한다. 있으면 그 호출처를 저장소 메서드로 옮긴 뒤 FR-SAF-5 를 적용한다 —
  순서를 바꾸면 그 호출처가 조용히 무력화된다.

  > **확인 완료 (2026-09-20).** `LSP findReferences` 로 `Get` 44곳 · `List` 17곳을
  > 전수 확인했다. 프로덕션 호출처 **11곳**(`handlers_runs.go` 4 ·
  > `handlers_runs_close.go` · `handlers_runs_context.go` 2 ·
  > `handlers_runs_delete.go` 2 · `handlers_runs_graph.go` ·
  > `handlers_runs_peers.go`)은 **전부 읽기 전용**이다. 반환값의 참조 필드에
  > 대입하는 자리는 0곳이며, `provisionMember`(`handlers_runs_worktree.go:103`)는
  > 이미 `wt := *rec.Worktree` 로 값 복제를 한다 — 올바른 형태가 이미 있다.
  > **그러므로 FR-SAF-5 를 곧바로 적용해도 무력화되는 호출처가 없다.**

### 3.3 묶음 C — 본문 상한

- **FR-SAF-7** 아래 일곱이 `httpreq` 를 지난다.

  | 종단 | 위치 |
  |---|---|
  | `POST /api/tools/kill` | `handlers_tools_kill.go:31` |
  | `POST /api/command-result` | `commands.go:265` |
  | `POST /api/focus/claim` | `focus.go:45` |
  | attention·activity·background 넷 | `handlers_attention.go:42·77·170·268` |

- **FR-SAF-8** 방언이 갈리는 자리는 방언에 맞는 헬퍼를 쓴다 —
  `handlers_attention.go` 넷은 `httpErr` 방언이므로 `decodeJSONBody`(toolio
  방언)를 그대로 쓰지 않는다.
- **FR-SAF-9** `httpreq/body.go` 머리말의 **과거형 서술을 고친다.** 끝나지 않은
  일을 끝난 것처럼 적은 문장이 이 결손을 7개월 가렸다.

### 3.4 묶음 D — 오류 코드

- **FR-SAF-10** `gitErrJSON(w, status, code, body)` 를 `handlers_git.go` 에
  세운다. `gitFail` 도 그것으로 재구현해 **헤더를 세우는 자리가 하나**가 되게
  한다.
- **FR-SAF-11** gitapi 11곳이 `gitErrJSON` 을 지난다 (`rejectBody` ·
  preflight 409 · `gitApply` · branch 3 · commit_ops · ignore · operation ·
  `gitPushError` · stash · tag).
- **FR-SAF-12** `fsFail` 이 `apierr.CodeHeader` 를 세운다. 한 줄이 `/api/fs/*` ·
  `/api/editors/*` 의 오류 **전부**를 세운다.

  > **뒷부분은 기각한다 (2026-09-20).** 착수 시 요구는 *"`jsonFail` 은 본문이
  > 바이트 단위로 같으므로 `fsFail` 을 감싸는 형태로 줄인다"* 였다. 코드를 읽고
  > **틀렸음을 확인했다.**
  >
  > 같은 것은 **본문뿐**이다. `jsonFail` 은 상태를 **호출자가 정하고**
  > (`fail(http.StatusConflict, …)`), `fsFail` 은 `fsStatus(code)` 로 파생한다.
  > 더 중요하게 `jsonFail` 은 `failFn` 타입의 구현 둘 중 하나이고 나머지 하나가
  > 터미널 표면의 `textFail` 이다 (`handlers_files.go:84`) — `uploadInto` ·
  > `serveDownload` 가 그 타입으로 두 표면을 공유한다. `fsFail` 로 줄이면 그
  > 공유 추상이 깨지고 호출자가 고른 상태가 사라진다.
  >
  > `jsonFail` 은 **이미 헤더를 세우고 있다**(`handlers_files.go:100`). 고칠
  > 것이 없었다.
- **FR-SAF-13** 본문 읽기 실패 6곳이 **사유에 맞는 코드**를 낸다 — 연결 절단을
  `body_too_big` 으로 답하지 않는다.

  > **`failRead` 로 옮기지 않는다 (2026-09-20).** 착수 시 요구는 *"여섯 자리를
  > `failRead(w, err)` 로 교체한다"* 였다. 코드를 읽고 **더 나쁜 결과**임을
  > 확인했다.
  >
  > `failRead` 는 `fail` → `httpErr(…, "")` 를 지나며 코드를 **상태에서**
  > 파생한다 (`CodeForStatus(413)` = `too_large`). 지금 이 여섯 자리는 413 에
  > **`body_too_big`** 을 내고 있고 그쪽이 더 좁다 — `codes_doc.go` 가 두 코드에
  > 서로 다른 복구 안내를 달아 두었기 때문이다. 옮기면 상한 초과의 안내가 덜
  > 구체적인 쪽으로 **물러선다**.
  >
  > 그래서 고친 것은 **코드 선택**뿐이다. `bodyReadCode(err)` 가 상한 초과만
  > `body_too_big` 으로, 나머지를 `bad_request` 로 가른다. 413 의 계약은 그대로다.
  > `handlers_files.go` 두 곳의 `err.Error()` 누설도 함께 걷었다.

### 3.5 묶음 E — 스케줄러

- **FR-SAF-14** `TimerHub._tick` 은 **어떤 경우에도** `_reschedule()` 에
  도달한다 (`try{…}finally{}`).
- **FR-SAF-15** `after` 콜백과 `_fire` 호출을 개별로 감싼다 — 하나가 던져도
  같은 tick 의 나머지가 돈다. `EventBus.publish` 와 같은 형태다.
- **FR-SAF-16** 삼킨 예외는 **흔적을 남긴다.** `after` 실패는 콘솔 +
  `ErrorLog`, 주기 job 실패는 콘솔만 (폴링 실패는 흔하고 50칸 버퍼를 덮는다).

### 3.6 묶음 F — 슬롯 순회

- **FR-SAF-17** `App.prototype.slotKeysOf(id)` 를 세운다 — `SLOT_MAX` 에서
  파생하며 손으로 적지 않는다.
- **FR-SAF-18** `_killToolInstances` 와 `toolAny` 가 그것을 돈다. `toolAny` 는
  **포커스 칸 → 슬롯 0 → 나머지 오름차순** 순서를 유지한다 (지금의 의도다).

### 3.7 묶음 G — 출력 잘림

- **FR-SAF-19** `StatusOf` 는 `out.StdoutTruncated` 를 본다.
- **FR-SAF-20** status 는 **실패로 끝낼 수 없는 표면**이다 (배지·관측이 여기
  딛는다). 그러므로 오류로 끝내지 않고 `Status.Truncated` 에 사실을 실어
  FR-GDT-23 의 규약을 출력 상한까지 넓힌다.
- **FR-SAF-21** 잘렸을 때 `Total` 이 **틀린 수를 확정적으로 말하지 않는다** —
  "최소 N개" 임이 드러나야 한다.

  > **부분 완료 (2026-09-20).** 서버는 끝났다 — `Status.OutputTruncated` 가
  > 사실을 싣고, `Total` 이 하한임을 그 필드의 주석이 못박는다. **화면은
  > 남았다**: git 배지는 여전히 `Total` 을 정확한 수처럼 그린다.
  >
  > 남긴 이유는 자리가 다르기 때문이다. 프론트의 `gitGroupTruncated` 는
  > `truncated` 맵을 **키별로 합산**하므로 `OutputTruncated` 는 그 경로에 들지
  > 않고, 새 표시는 `.ui-badge`·빈 상태 어휘와 함께 정해야 한다
  > (`AUDIT-uiux.md` §1.4 — 지금 개수 표기가 네 가지다). **묶음 B4 에서
  > 처리한다.** 그때까지 화면은 잘림을 말하지 않는다 — 이 문장이 그 빚의 기록이다.

### 3.8 묶음 V — 게이트

- **FR-SAF-22** `scripts/check-error-header.sh` — `gitapi`·`httpapi` 의 모든
  4xx/5xx 응답 경로가 `apierr.CodeHeader` 를 세우는지 본다.
- **FR-SAF-23** `scripts/check-body-limit.sh` — 요청 본문을 읽는 자리
  (`r.Body` 를 지나는 모든 호출)가 `httpreq` 를 경유하는지 본다.
  예외는 등록부에 **사유와 함께** 적는다.
- **FR-SAF-24** `web/js/test/` 에 "손으로 적은 슬롯 목록이 없다" 검사 —
  `slotKey(` 를 리터럴 첨자와 함께 부르는 자리를 센다.
- **FR-SAF-25** 셋 다 **탐침으로 검출을 확인하고 지운다** (규약 3-3). 잡지
  못하는 게이트는 없는 것보다 나쁘다.

---

## 4. 결정 (Decisions)

- **D-SAF-1 저장 실패 시 메모리를 되돌린다.** 대안은 "적용은 하되 저장 실패를
  알린다" 였다. 채택하지 않은 이유: 디스크와 메모리가 갈리면 **다음 기동의
  동작을 아무도 예측할 수 없다.** 접근 목록은 그 불확실성을 감당할 수 있는
  대상이 아니다.
- **D-SAF-2 묶음 G 는 오류가 아니라 사실을 싣는다.** `StatusOf` 를 다른 조회와
  똑같이 오류로 끝내면 대형 저장소에서 배지·관측·stash·clean·rebase·push 가
  **함께** 막힌다. 잘림은 실패가 아니라 상태이므로 `Truncated` 가 맞는 그릇이다.
- **D-SAF-3 묶음 B 는 확인이 먼저다.** 반환 포인터로 저장소를 고치는 호출처가
  있으면 복사를 넣는 순간 그 호출처가 **조용히** 무력화된다. FR-SAF-6 이
  순서를 고정한다.
- **D-SAF-4 게이트를 각 묶음과 함께 세운다.** 사용자 지시 (2026-09-20).
  묶음을 고치는 커밋에 그 묶음의 검사가 함께 들어간다 — 고친 뒤에 세우면
  고치는 동안 다시 새는 것을 못 막는다.
- **D-SAF-5 `httpreq` 머리말의 과거형을 고치는 것을 요구로 올린다**
  (FR-SAF-9). 주석 한 줄이지만, 끝나지 않은 일을 끝난 것으로 적은 문장이
  일곱 자리를 가린 **직접 원인**이다. 규약 3-2 의 취지다.

---

## 5. 검증 (Verification)

| TC | 묶음 | 내용 |
|---|---|---|
| TC-SAF-1 | A | 쓰기 불가 경로에서 `PUT /api/access` → **500** 이고, 응답 뒤 메모리 값이 **옛 값**이다 |
| TC-SAF-2 | A | 정상 경로는 그대로 200 이고 디스크에 적힌다 (회귀) |
| TC-SAF-3 | B | `go test -race` — `List()` 순회 중 다른 고루틴이 `Report` 로 제자리 수정. 지금은 실패하고 고친 뒤 통과 |
| TC-SAF-4 | B | 반환된 `Record.Members` 를 호출자가 고쳐도 저장소가 안 바뀐다 |
| TC-SAF-5 | C | 일곱 종단 각각에 상한 초과 본문 → `body_too_large`, 힙이 늘지 않는다 |
| TC-SAF-6 | D | `gitapi`·`httpapi` 의 **모든** 4xx/5xx 에 `X-Error-Code` 가 있다 (표 검사) |
| TC-SAF-7 | D | 연결 절단 시 `body_too_large` 가 **아닌** 코드가 나온다 |
| TC-SAF-8 | E | 던지는 `after` 뒤에도 같은 tick 의 다른 `after` 가 돈다 |
| TC-SAF-9 | E | 던진 뒤 `_reschedule` 이 섰다 — 다음 tick 이 온다 |
| TC-SAF-10 | F | 슬롯 3 에만 있는 도구를 지우면 그 인스턴스가 파괴된다 |
| TC-SAF-11 | F | 슬롯 2 에만 있는 도구를 `toolAny` 가 찾는다 |
| TC-SAF-12 | G | 잘린 status 출력 → 파싱이 죽지 않고 `Truncated` 가 선다 |
| TC-SAF-13 | V | 게이트 셋에 탐침을 심어 **검출을 확인하고 지운다** |

**순서 (규약 3-1).** 전부 RED 를 먼저 본다. TC-SAF-3 은 `-race` 로, TC-SAF-1·
TC-SAF-8·TC-SAF-10 은 지금 코드에서 실제로 실패하는 것을 확인한 뒤 고친다.

---

## 6. 비목표 (Non-goals)

1. **성능.** `docs/internal/refactor/README.md` §4 의 15건은 묶음 B6 이다.
2. **UI·디자인.** 묶음 B2~B4.
3. **구조 정리·함수 분할.** 묶음 B5.
4. **영문 리터럴 113개·색 위반 25건.** 묶음 B4.
5. **`stop --all` 의 "정지 실패" 오보.** 재현되지 않았다
   (`AUDIT-go-infra.md` 부록). 확인 전에는 고치지 않는다.
6. **오류 방언 넷을 하나로 합치는 것.** 이 묶음은 넷을 **그대로 두고** 헤더만
   세운다. 방언 수렴은 본문 계약을 바꾸므로 별개 SRS 다.
7. **`--untracked-files=all` 을 되돌리는 것.** FR-GIT-215 의 결정이며 묶음 G 는
   그 결정 위에서 잘림만 다룬다.

---

## 7. 리스크 (Risks)

| 리스크 | 등급 | 완화 |
|---|---|---|
| **A 가 동작을 바꾼다** — 지금까지 200 이던 실패가 500 이 된다 | MED | 그것이 옳다. FR-SAF-3 이 이전/새/이유를 기록으로 남기고, TC-SAF-2 가 정상 경로의 회귀를 막는다 |
| ~~**B 의 복사가 호출처를 무력화한다**~~ | ~~HIGH~~ → **해소** | **확인 완료 2026-09-20** (FR-SAF-6 의 주석). 프로덕션 호출처 11곳 전부 읽기 전용이고 반환값의 참조 필드에 대입하는 자리는 0곳이다. 이 리스크는 더 이상 열려 있지 않다 |
| **참조 필드를 빠뜨린다** — 감사는 둘만 지목했으나 실제로는 다섯이다 | MED | FR-SAF-4 의 표가 다섯을 명시하고, FR-SAF-4a 가 깊이를 `cloneRun` **한 자리**로 모은다. 타입에 참조 필드가 늘면 그 한 자리만 고치면 된다 |
| **B 의 복사가 뜨거운 경로에 들어간다** — `List()` 가 자주 불린다 | MED | `handlers_runs_peers.go` 가 이미 전량을 순회한다. 복사 비용을 §4(B6)의 성능 목록에 올려 두고, 이 묶음에서는 **정확성을 먼저** 택한다 |
| **G 가 `Total` 계약을 바꾼다** — 프론트가 그 수를 믿고 있다 | MED | FR-SAF-21. 소비자를 먼저 찾고, 배지가 "최소 N" 을 표현할 수 있는지 확인한 뒤 정한다 |
| **게이트 셋이 기존 코드에서 빨개진다** | LOW | 그것이 목적이다. 게이트와 수정이 같은 커밋에 든다 (D-SAF-4) |
| **e2e 가 영향받는다** — 오류 응답·슬롯 순회를 짚는 스펙 | MED | 묶음 경계에서 e2e 전량 1회 (사용자 지시). grep 이 아니라 검사로 판정 |

---

## 8. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-20 | 초안. 감사 1단계(214건) 중 "실패가 성공으로 보이는" 일곱 자리를 묶음 B1 로 분리 |
| 2026-09-20 | 구현 완료. 일곱 묶음 전부 RED→GREEN. 검증: `go test -race -shuffle=on ./...` 45패키지 · `npm run unit` 248건 · `make gates` 33종 · `npm run typecheck` · **e2e 전량 1,725건 통과(실패 0 · flaky 0)**. 감사 제안 둘(`jsonFail` 축소 · `failRead` 이동)은 코드 확인 후 기각하고 근거를 FR-SAF-12·13 에 남겼다 |
