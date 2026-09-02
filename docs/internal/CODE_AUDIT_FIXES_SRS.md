# SRS: 전수검사가 찾아낸 결함의 수정 — IEEE 29148

## 1. 개요

### 1.1 목적

코드 전수검사(`go vet`·`staticcheck`·`deadcode`·`go test -race`·핵심 경로 정독)가
찾아낸 결함을 고친다. 이 문서는 **찾은 것 전부**를 담되, 고치는 순서를 근거와 함께
정한다.

전수검사의 결론부터: 이 코드베이스는 견고하다. `go vet` 이 깨끗하고, TODO·FIXME 가
한 건도 없으며, git 인자 가드(`domain/git/core/guard.go`)는 허용목록·NUL·옵션
인젝션·Windows 경로 구분자까지 막는다. 셸을 경유하는 실행이 한 곳도 없고,
goroutine 18곳 전부에 종료 경로가 있다. 아래 결함은 그 위에서 발견한 것들이다.

### 1.2 이 결함들을 관통하는 하나의 사실

**이 저장소는 각 문제의 정답을 이미 알고 있다. 그 답이 한 자리에만 있을 뿐이다.**

| 문제 | 이미 있는 정답 | 그 답이 닿지 않은 곳 |
|---|---|---|
| 부분 쓰기가 살아 있는 파일이 되면 안 된다 | `domain/run/store.go:305` (temp+rename) | `workspace.json`·`tools.json`·`settings.json`·편집기 저장 |
| rename 은 Windows 에서 거부될 수 있다 | `shared/platform/paths.go:118` (`replaceFile`, 재시도 10회) | 위와 같음 |
| 저장은 한 줄로 세워야 순서가 보장된다 | `shared/workspace/manager.go:128` (`writer()` 단일 writer) | `toolhub.ToolManager.SaveAll` |
| 고루틴 종료는 `cancel()` 이 아니라 채널로 기다린다 | `diag_snapshot_test.go:115` (`TestDiagSnapshotLoopStopsWithContext`) | 바로 다음 함수인 `…WritesPeriodically` |

그래서 이 작업의 대부분은 **새 설계가 아니라 이미 있는 규약을 닿지 않은 자리에
적용하는 것**이다. `FG_RESTORE_RACE_SRS` 가 같은 성격의 작업이었다.

### 1.3 범위

순서는 사용자가 승인한 우선순위(1→2→3→4)를 따르고, 나머지를 뒤에 잇는다.

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **A** | `-race` 에서 실패하는 테스트를 고치고 CI 에 `-race` 를 켠다 | LOW |
| **B** | nil 역참조 패닉과 그것을 잡을 그물(recover) | LOW |
| **C** | 상태 파일·사용자 파일의 원자적 쓰기 | MEDIUM |
| **D** | `SaveAll` 직렬화 — 낡은 상태가 최신을 덮는 경쟁 | MEDIUM |
| **E** | 이름이 거짓말하는 필드, 아무것도 검증하지 않는 테스트, 죽은 코드 | LOW |
| **F** | 중복 헬퍼와 오탐 하나 | LOW |

### 1.4 비목표

- 인증 도입. `--expose` 에 인증이 없는 것은 README 에 경고된 **설계 결정**이며
  (README:81), 이 문서가 뒤집을 사안이 아니다.
- `/api/file/{read,write}` 의 경로 상한 도입. 저쪽이 절대경로를 그대로 받는 것은
  `handlers_fs.go:21` 이 근거를 적어 둔 의도적 대비다.
- 성능 최적화. 이 문서의 변경은 모두 정확성에 관한 것이다.
- staticcheck 의 SA4000 2건(`toolline_test.go:78`, `testpath_test.go:56`)을 억지로
  없애는 것. §5.5 를 볼 것.

---

## 2. 묶음 A — 검증이 검증하지 않는다

### 2.1 현상

`go test -race ./...` 가 실패한다. `-count=3` 에서 3회 모두.

```
--- FAIL: TestDiagSnapshotLoopWritesPeriodically (0.12s)
    testing.go:1617: race detected during execution of test
WARNING: DATA RACE ×3
```

### 2.2 근거

`internal/webserver/httpapi/diag_snapshot_test.go:133-145`

```go
go s.runDiagSnapshots(ctx, 10*time.Millisecond)
time.Sleep(120 * time.Millisecond)
cancel()
if n := strings.Count(buf.String(), "diag "); n < 2 {   // ← 고루틴이 아직 산다
```

`cancel()` 은 종료를 **요청**할 뿐 그것을 **기다리지 않는다**. 스냅샷 고루틴은
`log.Printf` 로 `buf` 에 쓰는 중일 수 있고, `bytes.Buffer` 에는 잠금이 없다.

이 규약은 **바로 위 함수가 이미 지키고 있다**:

```go
// TestDiagSnapshotLoopStopsWithContext (:115)
done := make(chan struct{})
go func() { s.runDiagSnapshots(ctx, 10*time.Millisecond); close(done) }()
cancel()
select {
case <-done:            // ← 종료를 기다린다
```

`captureLog` (:26) 가 주는 것이 잠금 없는 `*bytes.Buffer` 라는 것이 두 번째
사실이다. 테스트가 고루틴 종료를 기다리더라도, 로그를 쓰는 주체가 여럿인 다른
테스트에서 같은 함정이 되풀이된다.

### 2.3 이것이 지금까지 드러나지 않은 이유

`.github/workflows/verify.yml:51` 은 `go test ./internal/... ./cmd/...` 로 돈다 —
`-race` 가 없다. CI 는 이 실패를 볼 수 없다.

**전체 패키지를 `-race` 로 돌린 결과 실패는 이 하나뿐이다.** 즉 `-race` 를 켜는
비용은 이 테스트 하나를 고치는 것으로 끝난다.

### 2.4 요구사항

- **FR-CAF-1** `TestDiagSnapshotLoopWritesPeriodically` 는 스냅샷 고루틴의 종료를
  기다린 뒤에 버퍼를 읽는다. 기다리는 방법은 `…StopsWithContext` 와 같은 채널이다.
- **FR-CAF-2** `captureLog` 가 돌려주는 버퍼는 동시 쓰기에 안전하다. 테스트가
  버퍼를 읽는 모든 자리가 잠금 아래에 있다.
- **FR-CAF-3** CI 의 단위 테스트가 `-race` 로 돈다.

### 2.5 검증

- **V-CAF-1** `go test -race -count=3 ./internal/webserver/httpapi/` 가 통과한다.
- **V-CAF-2** `go test -race -count=1 ./...` 전량이 통과한다.

---

## 3. 묶음 B — nil 역참조와 그물

### 3.1 현상

`internal/webserver/httpapi/handlers_files.go:339`

```go
f, err := os.Open(fp)
if err != nil { … }
defer f.Close()
stat, _ := f.Stat()
if stat.IsDir() {        // ← Stat 이 실패하면 stat 은 nil 이다
```

`Open` 이 성공해도 `Stat` 은 실패할 수 있다 — 네트워크 파일시스템, 경합으로 지워진
파일, EIO. 그때 이 줄은 nil 포인터 역참조로 패닉한다.

### 3.2 그물이 없다

`net/http` 는 핸들러의 패닉을 잡아 그 연결만 끊는다. 서버는 죽지 않지만 **사용자는
아무 응답도 받지 못하고, 로그에는 스택만 남는다.**

이 저장소는 그물을 칠 줄 안다 — `handlers_ws.go:229`·`:299` 가 recover 를 쓴다.
그런데 HTTP 경로에는 그것이 없다. `Handler()` (`server.go:147`) 가 씌우는 것은
로깅 하나뿐이다.

### 3.3 요구사항

- **FR-CAF-4** `apiFileRead` 는 `Stat` 실패를 오류 응답으로 답한다. nil 을
  역참조하지 않는다.
- **FR-CAF-5** HTTP 핸들러의 패닉은 500 으로 답하고 스택과 함께 기록된다.
- **FR-CAF-6** 그물은 **이미 시작된 응답을 훼손하지 않는다.** SSE·WebSocket 은
  헤더를 이미 보냈으므로, 그 뒤의 패닉에 `WriteHeader` 를 부르면 안 된다.
- **FR-CAF-7** `http.ErrAbortHandler` 는 삼키지 않고 다시 패닉시킨다 — 그것은
  `net/http` 가 "조용히 끊어라" 를 뜻하는 약속된 값이다.

### 3.4 검증

- **V-CAF-3** `Stat` 이 실패하도록 만든 조건에서 `apiFileRead` 가 패닉 없이 오류
  코드를 낸다.
- **V-CAF-4** 패닉하는 핸들러가 500 을 낸다.
- **V-CAF-5** 응답을 이미 시작한 뒤 패닉한 핸들러는 상태 코드를 덮어쓰지 않는다.
- **V-CAF-6** `http.ErrAbortHandler` 를 던진 핸들러는 그물에 걸리지 않는다.

---

## 4. 묶음 C — 부분 쓰기가 살아 있는 파일이 된다

### 4.1 현상

같은 저장소 안에서 상태 파일을 쓰는 방식이 갈린다.

| 파일 | 쓰는 자리 | 방식 |
|---|---|---|
| `runs.json` | `domain/run/store.go:316` | temp + rename ✅ |
| `workspace.json` | `shared/workspace/fs.go:11` | `os.WriteFile` ❌ |
| `tools.json` | `shared/toolhub/persist.go:60` | `os.WriteFile` ❌ |
| `settings.json` | `httpapi/handlers_settings.go:52` | `os.WriteFile` ❌ |
| 사용자 파일(편집기 저장) | `httpapi/handlers_files.go:372` | `os.WriteFile` ❌ |

`os.WriteFile` 은 `O_TRUNC` 로 연 뒤 쓴다. 그 사이에 프로세스가 죽거나 디스크가
차면 **잘린 파일이 살아 있는 파일이 된다.**

### 4.2 왜 이것이 중요한가

`workspace.json` 은 창·분할 칸·탭 배치 전체다. 이 저장소는 그 파일의 무게를 안다 —
`workspace/manager.go:24` 는 스키마가 낮으면 **기동을 거부**한다:

> 구 스키마를 빈 workspace 와 구별할 수 없으므로 조용히 넘기지 않고 명시적으로
> 실패한다 — 방치하면 브라우저가 빈 상태를 저장해 덮어쓴다.

파싱할 수 없는 파일을 그토록 경계하면서, **파싱할 수 없는 파일을 만들 수 있는
쓰기 방식**을 쓰고 있다.

편집기 저장(`handlers_files.go:372`)은 성격이 다르다. 여기서 잘리는 것은 우리 상태
파일이 아니라 **사용자가 쓰던 원본**이다.

### 4.3 정답은 이미 두 자리에 있다

`domain/run/store.go:305` 가 무엇을 해야 하는지 적어 두었다:

> save writes runs.json atomically (FR-RUN-4): a temp file in the same
> directory, then rename. **A partial write must never become the live file.**

`shared/platform/paths.go:118` 은 그것이 Windows 에서 왜 단순하지 않은지까지 적어
두었다:

> Windows 는 갓 쓴 파일을 바이러스 검사·인덱서가 잠깐 열어 두는 일이 흔하고,
> 그동안 MoveFileEx 가 거부된다. … 실측으로 Windows CI 에서 120회 중 4회 dst 가
> 비었다.

그래서 `replaceFile` 은 10회까지 물러섰다 다시 건다. 이 지식은 지금 **실행 파일
설치 경로에만** 쓰인다.

### 4.4 설계 결정

**D-CAF-1: 공용 함수를 `shared/platform` 에 둔다. 새 패키지를 만들지 않는다.**

`tempSibling`·`replaceFile` 이 이미 그 패키지에 있고, 원자적 교체가 어려운 이유가
전부 OS 차이다 — `platform` 의 존재 이유가 정확히 그것이다. 새 패키지를 만들면
저 두 함수를 export 하거나 복제해야 한다.

**D-CAF-2: `fsync` 를 한다.**

rename 만으로는 "잘린 파일" 은 막아도 "빈 파일" 은 막지 못한다 — 임시 파일의 내용이
디스크에 닿기 전에 rename 만 먼저 반영되는 순서가 가능하다. 비용은 상태 파일 한 번
저장에 수 ms 이고, 이 파일들은 초당 여러 번 쓰이지 않는다.

**D-CAF-3: `run/store.go` 도 이 함수로 옮긴다.**

옳게 하고 있는 자리를 그대로 두면 구현이 둘이 된다. 한쪽만 고쳐지는 날이 온다 —
이 저장소가 `errUnresolvedID` 를 한 자리에 모은 것과 같은 이유다
(`workspace/manager.go:281`).

### 4.5 요구사항

- **FR-CAF-8** `platform.WriteFileAtomic(path, data, perm)` 은 같은 디렉터리의
  임시 파일에 쓰고, `fsync` 한 뒤, `replaceFile` 로 목적 이름에 건다.
- **FR-CAF-9** 실패하면 임시 파일을 남기지 않는다.
- **FR-CAF-10** 실패해도 **목적 파일의 기존 내용은 그대로다.** 이것이 계약의 핵심
  이다 — 새 내용을 못 쓰는 것보다 옛 내용을 잃는 것이 나쁘다.
- **FR-CAF-11** `workspace.json`·`tools.json`·`settings.json`·편집기 저장·
  `runs.json` 이 모두 이 함수를 쓴다.

### 4.6 검증

- **V-CAF-7** 쓰기 도중 실패하면 목적 파일이 이전 내용을 유지한다.
- **V-CAF-8** 실패 후 디렉터리에 임시 파일이 남지 않는다.
- **V-CAF-9** 성공 시 내용과 권한이 요청대로다.
- **V-CAF-10** 위 다섯 자리가 비원자적 쓰기를 더 이상 부르지 않는다(코드 검사).

---

## 5. 묶음 D~F

### 5.1 D — `SaveAll` 이 낡은 상태로 최신을 덮을 수 있다

`toolhub/manager.go:379` 의 `saveAsync` 는 호출마다 고루틴을 띄운다:

```go
go func() { defer m.saves.Done(); m.SaveAll() }()
```

그런데 `SaveAll` (`persist.go:27`) 에는 직렬화가 없다. 도구를 빠르게 여닫으면
스냅샷 시각이 A→B 인 두 저장이 디스크에는 B→A 순으로 도착할 수 있고, 그러면 **낡은
`tools.json` 이 최종본이 된다.**

이 저장소는 이 문제도 이미 풀었다 — `workspace/manager.go:128` 의 `writer()` 가
단일 writer 로 순서를 보장한다. `toolhub` 에는 그것이 없다.

**설계 결정 D-CAF-4: 단일 writer 고루틴이 아니라 뮤텍스로 직렬화한다.**

`workspace` 처럼 채널+coalescing 을 도입하면 `StopSaving` 의 계약
(`manager.go:389` 이 근거를 길게 적어 둔 "문을 닫고 기다린다")을 다시 설계해야
한다. 뮤텍스는 그 계약을 건드리지 않고 순서만 세운다. 스냅샷을 잠금 **안에서**
떠야 순서가 성립한다는 것이 요점이다.

- **FR-CAF-12** `SaveAll` 은 동시에 하나만 돈다. 상태 스냅샷과 디스크 쓰기가 같은
  임계 구역 안에 있다.
- **V-CAF-11** 서로 다른 상태로 `SaveAll` 을 동시에 여러 번 불러도, 마지막에 디스크에
  남는 것이 가장 나중에 스냅샷된 상태다.

### 5.2 E — 이름이 거짓말한다

`dirty` (`toolhub/manager.go:34`) 는 `SaveAll` 이후에도 내려가지 않는다. 실제 뜻은
"미저장 변경이 있다" 가 아니라 **"기동 후 한 번이라도 변경됐다"** 다.

동작은 옳다. `SaveAll` 의 가드가 노리는 것("아무 일도 없던 실행이 기존 사용자
파일을 빈 상태로 덮지 않는다", `persist.go:21`)은 달성된다. 문제는 이름이다.

- **FR-CAF-13** 필드 이름이 그 뜻을 말한다. 동작은 바뀌지 않는다.

### 5.3 E — 아무것도 검증하지 않는 테스트

`toolhub/tool_test.go:88-102`

```go
if !pm.dirty.Load() { t.Log("dirty was reset — bug fixed") }
else                { t.Log("BUG: dirty remains true after SaveAll (documented)") }
```

두 갈래 다 `t.Log` 다. **`TestToolManager_DirtyAndSaveAll` 은 어느 쪽이든 항상
초록이다.** 버그를 기록하려 한 의도는 읽히지만, 지금은 커버리지에 잡히면서 아무것도
지키지 않는다.

- **FR-CAF-14** 이 테스트는 §5.2 로 확정된 동작을 단언한다.

### 5.4 E — 죽은 코드

`hub.AttnTracker.Stop` (`attn_tracker.go:144`) 은 프로덕션에서 호출되지 않는다
(`deadcode` 확인). 스위퍼는 `stopCh` 로만 멈춘다. 딸린 `ticker` 필드는 고루틴
안에서만 쓰여 구조체 필드일 이유가 없고, 잠금 없이 접근된다. `Stop` 을 두 번 부르면
`close` 가 패닉한다.

- **FR-CAF-15** 쓰이지 않는 종료 경로와 필드를 지운다. 남기는 쪽을 택한다면 이중
  호출에 안전해야 한다.

### 5.5 E — staticcheck 나머지

- `ST1005` (`workspace/manager.go:21`): 오류 문자열이 마침표로 끝난다. 다만 이
  메시지는 **진단의 마지막 줄로 사람에게 보이도록 쓰인 문장**이다(주석이 그렇게
  말한다). 규칙보다 의도가 앞서므로 `//lint:ignore` 로 의도를 명시한다.
- `SA4000` 2건: `l.Render() != l.Render()` 는 결정성 검사다. Go 는 이 두 호출을
  접지 않으므로 **검사는 의도대로 동작한다.** 값을 변수로 받아 비교하면 경고가
  사라지고 뜻은 그대로다.

- **FR-CAF-16** `staticcheck ./...` 가 경고 없이 끝난다(플랫폼별 미도달 코드 제외).

### 5.6 F — 중복과 오탐

- **FR-CAF-17** HTML 이스케이프 헬퍼가 하나다. 지금은 `ui/file-editor.js:481`
  (`_esc`) 와 `core/app-edsearch.js:176` (`esc`) 두 벌이며, **이미 조용히 갈라져
  있다** — 앞은 홑따옴표를 막고 뒤는 막지 않는다. 이스케이프가 갈라지는 것은 그
  자체로 결함이다: 어느 자리가 무엇을 막는지 말할 수 없게 된다.

> **FR-CAF-18 철회.** 초안은 `guard.go:34` 의 `-o` 접두어 검사가 `-out.txt` 같은
> 정상 파일 이름을 거부하는 오탐이라고 적었다. **틀렸다.** git 자신이 그 문자열을
> 옵션으로 읽는다 (git 2.51 실측: `git log --oneline -out.txt` →
> `fatal: unrecognized argument: -out.txt`). 파일 이름으로 해석되지 않으므로
> 접두어 검사는 정확하며, 고칠 것이 없다. 지금 형태가 옳다.

> 테스트 헬퍼 중복(`gitRun` 3벌, `itoa` 3벌)은 **고치지 않는다.** 패키지가 서로
> 다르고, 테스트 헬퍼를 공유 패키지로 끌어올리면 테스트가 서로 결합된다. 지금의
> 복제가 더 싸다.

---

## 6. 검증 계획

| 단계 | 명령 | 통과 기준 |
|---|---|---|
| 빌드 | `go build ./...` + `GOOS=windows`·`GOOS=linux` | 3면 모두 성공 |
| 정적 | `go vet ./...` / `staticcheck ./...` | 경고 없음 |
| 단위 | `go test -race -count=1 ./...` | 전량 통과 |
| 죽은 코드 | `deadcode ./...` | §5.4 항목이 사라짐 |

각 묶음은 **테스트를 먼저 쓰고**(실패를 확인한 뒤) 구현한다. 묶음 C 는 실패 주입이
필요하므로 쓰기 함수를 주입 가능하게 두는 대신, 임시 파일 생성이 실패하는 조건
(읽기 전용 디렉터리)으로 검증한다.

## 7. 변경되는 동작

| 자리 | 이전 | 이후 | 이유 |
|---|---|---|---|
| 상태 파일 쓰기 | 부분 쓰기가 살아 있는 파일이 됨 | 실패 시 이전 내용 유지 | FR-CAF-10 |
| `SaveAll` 동시 호출 | 도착 순서가 뒤집힐 수 있음 | 스냅샷 순서대로 | FR-CAF-12 |
| HTTP 핸들러 패닉 | 응답 없이 연결 끊김 | 500 + 스택 기록 | FR-CAF-5 |
| `apiFileRead` 의 `Stat` 실패 | 패닉 | 오류 응답 | FR-CAF-4 |
| `app-edsearch` 의 이스케이프 | 홑따옴표를 넘김 | 홑따옴표도 막음 | FR-CAF-17 |

그 밖의 동작은 바뀌지 않는다.

## 8. 수행 결과

| 검증 | 결과 |
|---|---|
| `go build` (darwin·windows·linux) | 3면 성공 |
| `go vet ./...` | 경고 없음 |
| `staticcheck ./...` | SA4000·ST1005 해소. 남은 U1000 5건은 `platform_windows.go`· `platform_linux.go` 가 쓰는 코드로, darwin 에서 돌린 검사기에만 미도달로 보인다 (§1.4 비목표) |
| `go test -race ./internal/... ./cmd/...` | 28개 패키지 전량 통과, DATA RACE 0 |
| `deadcode ./...` | `AttnTracker.Stop` 이 목록에서 사라짐 (FR-CAF-15) |
| e2e (editor-search-keys·editor-ops·editor-tab) | 48건 통과 — FR-CAF-17 이 실제 앱에서 검증됨 |
