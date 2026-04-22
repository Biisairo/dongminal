# Architecture Deepening RFC — dongminal

> 목적: dongminal 코드베이스를 "얕은 모듈" 구조에서 "깊은 모듈(deep modules)" 구조로 전환해 테스트 가능성·AI 탐색 용이성·동시성 안전성을 높인다. (참고: John Ousterhout, *A Philosophy of Software Design*)
>
> 이 문서는 **단독 실행 가능한 작업 지시서**다. 작업자는 이 문서만 읽고도 각 단계를 순서대로 수행할 수 있어야 한다. 외부 컨텍스트(대화 이력 등)에 의존하지 않는다.
>
> 작업 대상 리포: `/Users/dykim/personal/dongminal`
> 언어/런타임: Go (single-module, `go.mod` 참조)
> 주요 파일: `main.go` (1370 lines), `mcp.go` (875 lines), `commands.go` (198 lines), `static/app.js`

---

## 0. 진행 원칙

1. **한 번에 하나의 Candidate만 머지한다.** 각 Candidate는 독립 PR 또는 커밋 시리즈로 처리한다.
2. **모든 Candidate 완료 후에도 기존 UX는 동일해야 한다.** 브라우저·MCP 툴 호출·code-server 동작은 외부에서 관찰했을 때 동일해야 한다.
3. **테스트를 같이 추가한다.** 각 Candidate는 최소 1개의 `*_test.go`를 동반한다. (현재 프로젝트는 테스트 0개)
4. **빌드 검증:** 매 단계 끝에 `go build ./...` 및 `go vet ./...` 통과 확인. 가능하면 `go test ./...` 통과.
5. **`./start.sh` 실행 금지.** 사용자가 명시적으로 금지했다. 빌드와 수동 스모크 테스트만 허용.
6. **`TODO.md` 업데이트:** 각 Candidate 완료 시 `TODO.md`에 결과 한 줄 기록.

---

## 1. 실행 순서 및 의존성

```
Candidate 1 (OutputBuffer)       ─┐
Candidate 2 (ProcessTracker)     ─┤  ← 1~4는 독립 가능하지만 2→3→5 의존
Candidate 3 (WorkspaceManager)   ─┤    (3은 2의 OnExit 훅을 소비)
Candidate 4 (ToolDispatcher)     ─┤    (4는 3의 resolver를 소비)
Candidate 5 (Server DI)          ─┘  ← 마지막 capstone. 1~4가 정리된 인터페이스 제공.
```

**권장 머지 순서:**
1. Candidate 1 (OutputBuffer) — 가장 국소적, 위험 최저, 워밍업.
2. Candidate 2 (ProcessTracker) — Pane → PaneManager 순환 의존 제거.
3. Candidate 3 (WorkspaceManager) — Candidate 2의 OnExit 콜백 소비.
4. Candidate 4 (ToolDispatcher) — Candidate 3의 resolver 인터페이스 소비.
5. Candidate 5 (Server DI) — 모든 모듈을 `Server` 구조체에 주입.

---

## 2. 아키텍처 현황 요약 (수정 전)

### 2.1 주요 모듈/개념

| 모듈 | 위치 | 역할 |
|---|---|---|
| Pane | main.go:128–330 | PTY 래퍼, 셸 spawn, output 버퍼링/브로드캐스트 |
| PaneManager | main.go:333–631 | 전역 pane 레지스트리 |
| CodeServerInst/Manager | main.go:347–556 | code-server 프로세스 라이프사이클 + reverse proxy |
| WebSocket 레이어 | main.go:59–97, 1051–1182 | 이진 메시지 I/O, safeConn, ping/pong |
| OutputBuffer | main.go:101–124 | 원형 버퍼(slice tail-drop) |
| HTTP API | main.go:842–1018 | pane CRUD, 파일 I/O, stats, code-server 제어 |
| MCP Protocol | mcp.go:24–227 | JSON-RPC 2.0, SSE 세션 다중화 |
| MCP Tools | mcp.go:370–876 | 8개 tool |
| Workspace Parser | mcp.go:437–525 | 레이아웃 트리 → pane 라벨(S.P.T) |
| Commands/CLI | commands.go:1–198 | SSE 브로드캐스터 |
| Persistence | main.go:635–726 | workspace.json / settings.json / panes.json |

### 2.2 식별된 마찰 지점

1. `OutputBuffer`: `bufMax=1<<20` 하드코딩, tail-drop 시 dropped 바이트 관측 불가. (main.go:50, 101–124, 216)
2. `Pane.readPTY()`가 전역 `pm.delete(p.ID)` 호출 — 상방 의존. (main.go:257)
3. Workspace는 브라우저 owner, 서버는 JSON blob만 저장. MCP tool이 호출 시마다 JSON 파싱 + 라벨 맵 재계산. dead pane 참조·동시 쓰기 방어 없음. (mcp.go:437–553, main.go:881–886)
4. MCP tool 8개가 `(map[string]interface{}, error)`를 반환하며 에러 컨벤션 3종이 혼재. 글로벌 `pm`, `csm` 직접 접근. (mcp.go:370–875)
5. 패키지 전역 `pm`, `csm`, `wsJSON`, `settingsJSON`, `mcpSessions` — 서버 2개 인스턴스화 불가, 테스트 불가. (main.go:339–340, mcp.go:56–59)
6. 테스트 0개. `pty.StartWithSize`, `exec.Cmd`, 파일 I/O 전부 하드 결합.

---

## 3. 공통 준비 (모든 Candidate 시작 전)

### 3.1 내부 패키지 디렉터리 생성

```bash
mkdir -p /Users/dykim/personal/dongminal/internal/outbuf
mkdir -p /Users/dykim/personal/dongminal/internal/pane
mkdir -p /Users/dykim/personal/dongminal/internal/workspace
mkdir -p /Users/dykim/personal/dongminal/internal/mcptool
mkdir -p /Users/dykim/personal/dongminal/internal/server
```

`go.mod`의 모듈 경로를 확인하고(`head -1 go.mod` → `module <path>`), 이후 import 경로를 `<module>/internal/<sub>` 형태로 사용한다.

### 3.2 첫 테스트 파일 준비

프로젝트에 `*_test.go`가 없다. 각 Candidate PR은 최소 1개의 테스트를 동반해야 한다. 테스트 파일은 해당 내부 패키지 안에 둔다 (예: `internal/outbuf/stream_test.go`).

### 3.3 브랜치 전략

Candidate 별 브랜치: `refactor/c1-outbuf`, `refactor/c2-proctracker`, `refactor/c3-workspace`, `refactor/c4-mcp-dispatch`, `refactor/c5-server-di`. 각 브랜치는 `main`(또는 기본 브랜치)에서 분기, 머지 후 다음 브랜치 분기.

---

## 4. Candidate 1 — OutputBuffer 심화

### 4.1 Problem Frame

현재 모든 Pane은 동일한 1MB tail-drop 버퍼를 공유한다. `readPTY`는 `bch` 채널 + `drainBuf` 고루틴 + `buf.Write` 조합으로 버퍼링하며, MCP `toolReadPaneOutput`/`toolReadScreen`은 스냅샷의 tail만 받기 때문에 앞쪽이 얼마나 잘렸는지 알 수 없다. 매 스냅샷마다 `make+copy`가 발생하고, 폴링 툴이 많으면 측정 가능한 낭비다.

### 4.2 채택 설계 — "Design C + Stats(from B)"

`internal/outbuf/stream.go`:

```go
package outbuf

import (
    "context"
    "sync"
    "sync/atomic"
)

// Stream은 readPTY 라이터와 MCP/WS 리더를 통합한 바운디드 버퍼다.
// bch/drainBuf 패턴을 대체한다.
type Stream struct {
    ctx       context.Context
    cancel    context.CancelFunc
    mu        sync.Mutex
    buf       []byte  // 최대 2*max까지 성장, 주기적으로 max로 compaction
    max       int
    totalIn   atomic.Int64
    totalDrop atomic.Int64
}

type Stats struct {
    TotalBytesIn   int64
    TotalBytesDrop int64
    Retained       int
}

// NewStream은 최대 유지 바이트 max로 Stream을 생성한다.
// parent가 Done되면 내부 리소스를 정리한다.
func NewStream(parent context.Context, max int) *Stream {
    ctx, cancel := context.WithCancel(parent)
    return &Stream{ctx: ctx, cancel: cancel, max: max, buf: make([]byte, 0, max)}
}

// Feed는 readPTY에서 호출된다. 절대 블로킹하지 않으며,
// 드롭된 바이트 수를 반환한다(없으면 0).
func (s *Stream) Feed(p []byte) (dropped int) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.totalIn.Add(int64(len(p)))
    s.buf = append(s.buf, p...)
    if over := len(s.buf) - s.max; over > 0 && len(s.buf) > 2*s.max {
        s.buf = append(s.buf[:0], s.buf[over:]...)
        dropped = over
        s.totalDrop.Add(int64(over))
    } else if len(s.buf) > s.max {
        dropped = len(s.buf) - s.max
        s.totalDrop.Add(int64(dropped))
        // 물리적 compaction은 2*max 초과 시에만. 빠른 경로는 논리적 truncation만 기록.
        // 실제 바이트 제거는 Snapshot 시점에 지연 처리됨.
    }
    return
}

// Snapshot은 현재 유지된 tail을 복사해 반환한다. Stats도 함께 반환.
func (s *Stream) Snapshot() ([]byte, Stats) {
    s.mu.Lock()
    defer s.mu.Unlock()
    start := 0
    if len(s.buf) > s.max {
        start = len(s.buf) - s.max
    }
    out := make([]byte, len(s.buf)-start)
    copy(out, s.buf[start:])
    return out, Stats{
        TotalBytesIn:   s.totalIn.Load(),
        TotalBytesDrop: s.totalDrop.Load(),
        Retained:       len(out),
    }
}

// Len은 현재 유지된 바이트 수를 반환한다.
func (s *Stream) Len() int {
    s.mu.Lock()
    defer s.mu.Unlock()
    if len(s.buf) > s.max {
        return s.max
    }
    return len(s.buf)
}

// Close는 리소스를 정리한다. 이후 호출은 no-op.
func (s *Stream) Close() {
    s.cancel()
    s.mu.Lock()
    s.buf = nil
    s.mu.Unlock()
}
```

> **설계 단순화 결정:** 원설계의 zero-copy refcount 방식은 오용 위험이 커 포기. `Snapshot`은 현재처럼 복사본을 반환한다. 대신 `Stats`를 통해 drop 관측을 제공한다.

### 4.3 이관 작업

1. `internal/outbuf/stream.go` 작성 (위 코드).
2. `internal/outbuf/stream_test.go` 작성:
   - `TestFeedBelowMax`: max=100, 50바이트 Feed → dropped=0, Len=50.
   - `TestFeedAboveMax`: max=100, 250바이트 Feed → Snapshot 길이 100, Stats.TotalBytesDrop=150.
   - `TestMultipleFeeds`: 여러 번 Feed 누적, tail만 유지됨 검증.
   - `TestSnapshotIsolation`: Snapshot 반환 후 추가 Feed가 반환 바이트를 오염시키지 않음.
3. `main.go:101-124`의 기존 `OutputBuffer` 타입을 **제거하지 말고 유지** (다른 곳에서 쓰이면 호환성 위해). 신규 Pane 필드만 교체:
   - `main.go:128-145` Pane 구조체: `buf *outputBuffer` → `stream *outbuf.Stream`
   - `main.go:213-220` `startPane`: `buf: newOutputBuffer(bufMax)` → `stream: outbuf.NewStream(context.Background(), bufMax)`
4. `main.go:238-270` `readPTY`에서 `p.buf.Write(msg[1:])` 호출 지점을 `p.stream.Feed(raw[:n])`로 교체.
   - **주의:** 기존 코드는 `bch` 채널 + `drainBuf` 고루틴을 사용한다. 이 단계에서는 `drainBuf`를 **제거하지 않는다.** `bch` 는 WebSocket fan-out 용도만 유지하고, 버퍼 저장은 `Stream.Feed`로 직접 간다.
5. `mcp.go`의 `toolReadPaneOutput`, `toolReadScreen` 호출부에서 `p.buf.Snapshot()` → `data, stats := p.stream.Snapshot()`. 응답 텍스트 헤더에 `dropped_bytes: N` 표기 추가.
6. `Pane.kill()` (main.go:315-329)에 `p.stream.Close()` 추가.
7. `OutputBuffer` 참조가 0이면 `main.go:101-124` 삭제 (`grep -n outputBuffer main.go` 확인 후).

### 4.4 수용 기준

- [ ] `go build ./...` 통과
- [ ] `go test ./internal/outbuf/...` 통과
- [ ] 브라우저에서 pane 2개 생성 후 긴 출력(`seq 1 100000`) 발생 → UI에 tail 정상 표시
- [ ] MCP `read_pane_output` 호출 결과에 `dropped_bytes` 필드 표기 확인
- [ ] `TODO.md`에 "Candidate 1 완료" 기록

---

## 5. Candidate 2 — ProcessTracker / Pane→PM 순환 제거

### 5.1 Problem Frame

`Pane.readPTY` (main.go:238-270)가 종료 시 전역 `pm.delete(p.ID)`를 호출한다. Pane이 자신의 레지스트리를 알고 있어, 하위 모듈이 상위 모듈을 참조하는 순환 의존 구조다. 이로 인해 (a) Pane을 별도 패키지로 분리 불가, (b) `pm`을 교체하거나 fake로 만들 수 없음, (c) readPTY의 cleanup 로직을 단위 테스트할 수 없음.

### 5.2 채택 설계 — "Design C (ExitReporter 콜백) + Design A의 Wait()"

`Pane` 생성 시 `ExitReporter func(paneID string)` 콜백을 주입한다. `readPTY`는 이 콜백만 호출하고 `pm`을 모른다. `PaneManager`는 생성 시 `Create`에서 콜백을 바인드한다. 보너스로 `Pane.Wait() <-chan struct{}`를 공개 (free, 이미 `done` 채널 존재).

### 5.3 이관 작업

1. `main.go:128-145` Pane 구조체에 필드 추가:
   ```go
   onExit func(id string) // nil-safe
   ```
2. `main.go:176-225` `startPane` 시그니처 변경:
   ```go
   func startPane(id, name, cwd string, cols, rows uint16, onExit func(string)) (*Pane, error)
   ```
   호출자(`PaneManager.create`)에서 콜백을 전달.
3. `main.go:238-270` `readPTY`의 exit 경로:
   ```go
   // 변경 전:
   pm.delete(p.ID)
   // 변경 후:
   if p.onExit != nil {
       go p.onExit(p.ID) // 데드락 방지를 위해 비동기
   }
   ```
4. `main.go:333-631` `PaneManager.create`에서 콜백 바인드:
   ```go
   func (m *PaneManager) create(cwd string, cols, rows uint16) (*Pane, error) {
       id := m.nextID()
       p, err := startPane(id, "", cwd, cols, rows, func(paneID string) {
           m.delete(paneID)
       })
       if err != nil { return nil, err }
       m.mu.Lock(); m.panes[id] = p; m.mu.Unlock()
       return p, nil
   }
   ```
5. 공개 `Wait` 메서드 추가:
   ```go
   func (p *Pane) Wait() <-chan struct{} { return p.done }
   ```
6. `grep -n "pm\\.delete" main.go mcp.go` 실행. `readPTY` 내부의 호출이 완전히 제거되었는지 확인. 다른 위치(예: `PaneManager.delete`의 자기 호출)는 유지.
7. 테스트 `main_pane_exit_test.go` 또는 `internal/pane/pane_test.go`:
   - fake `onExit` 콜백을 주입하고, `echo hi; exit` 셸로 Pane 생성 후 콜백이 호출되는지 확인.
   - `Wait()` 채널이 프로세스 종료 시 닫히는지 확인.

### 5.4 수용 기준

- [ ] `grep -n "pm\." main.go` 결과 중 `readPTY` 함수 본문에서 `pm.` 호출 없음
- [ ] `go build ./... && go vet ./...` 통과
- [ ] 브라우저에서 pane 생성 → 터미널에서 `exit` → UI에서 pane이 자동 제거됨
- [ ] 종료 콜백 테스트 통과
- [ ] `TODO.md` 갱신

---

## 6. Candidate 3 — WorkspaceManager

### 6.1 Problem Frame

워크스페이스 트리(sessions → regions → tabs)의 authoritative owner는 브라우저 `static/app.js`다. 서버는 `wsJSON` raw 바이트만 저장하고, MCP tool이 호출될 때마다 `parseWorkspace` → `buildLabelMap` (mcp.go:437–553)을 돌려 pane 라벨(S.P.T)을 재계산한다. 문제:
- dead pane 참조 방어 없음 — `buildLabelMap`이 silently skip (mcp.go:~546)
- 동시 PUT 레이스 — last-write-wins, 두 MCP client가 레이아웃을 편집하면 한쪽이 소리 없이 덮어씀
- MCP tool당 JSON 파싱 1회 — 핫패스 비효율
- 버전/타임스탬프 없음 → stale 감지 불가

### 6.2 채택 설계 — "Design C (Hot-path Resolver + ETag)"

`internal/workspace/manager.go`:

```go
package workspace

import (
    "encoding/json"
    "errors"
    "sync"
    "sync/atomic"
)

var ErrStale = errors.New("workspace: stale revision")

type Liveness interface {
    IsLive(paneID string) bool
}

type Persister interface {
    Read() ([]byte, error)
    Write([]byte) error
}

type index struct {
    labels    map[string]string // paneID → "S1.P2.T1"
    labelToID map[string]string // "S1.P2.T1" → paneID
}

type Manager struct {
    live    Liveness
    store   Persister
    mu      sync.Mutex
    rev     atomic.Uint64
    raw     atomic.Pointer[[]byte]  // 현재 blob
    idx     atomic.Pointer[index]   // lock-free read
}

func New(live Liveness, store Persister) (*Manager, error) {
    m := &Manager{live: live, store: store}
    raw, err := store.Read()
    if err == nil && raw != nil {
        m.raw.Store(&raw)
        m.rebuildIndex(raw)
    } else {
        empty := []byte("null")
        m.raw.Store(&empty)
        m.idx.Store(&index{labels: map[string]string{}, labelToID: map[string]string{}})
    }
    return m, nil
}

// Save는 새 blob을 저장한다. ifMatch=0이면 force, 아니면 rev 불일치 시 ErrStale.
func (m *Manager) Save(blob []byte, ifMatch uint64) (rev uint64, err error) {
    m.mu.Lock()
    defer m.mu.Unlock()
    cur := m.rev.Load()
    if ifMatch != 0 && ifMatch != cur {
        return cur, ErrStale
    }
    // 기본 검증: 유효 JSON
    var probe any
    if err := json.Unmarshal(blob, &probe); err != nil {
        return cur, err
    }
    if err := m.store.Write(blob); err != nil {
        return cur, err
    }
    m.raw.Store(&blob)
    m.rebuildIndex(blob)
    return m.rev.Add(1), nil
}

func (m *Manager) CurrentRev() uint64 { return m.rev.Load() }

func (m *Manager) Raw() []byte {
    p := m.raw.Load()
    if p == nil { return nil }
    return *p
}

// Resolve는 "S1.P2.T1" 라벨 또는 raw paneID를 live paneID로 매핑한다.
// 죽은 pane은 ok=false.
func (m *Manager) Resolve(labelOrID string) (paneID string, ok bool) {
    idx := m.idx.Load()
    if idx == nil { return "", false }
    if id, found := idx.labelToID[labelOrID]; found {
        if m.live.IsLive(id) { return id, true }
        return "", false
    }
    // raw ID일 수 있음
    if _, found := idx.labels[labelOrID]; found {
        if m.live.IsLive(labelOrID) { return labelOrID, true }
    } else if m.live.IsLive(labelOrID) {
        // workspace엔 없지만 살아있는 orphan pane
        return labelOrID, true
    }
    return "", false
}

// Labels는 현재 라벨 스냅샷 (paneID → label)을 반환한다.
func (m *Manager) Labels() map[string]string {
    idx := m.idx.Load()
    if idx == nil { return nil }
    out := make(map[string]string, len(idx.labels))
    for k, v := range idx.labels {
        if m.live.IsLive(k) { out[k] = v }
    }
    return out
}

// InvalidatePane은 Pane이 종료됐을 때 PaneManager가 호출.
// 현재 구현은 no-op + 다음 Resolve에서 Liveness로 필터. 필요 시 index 재빌드.
func (m *Manager) InvalidatePane(paneID string) {
    // atomic.Pointer 기반 읽기 경로가 Liveness로 필터하므로 즉시 반영된다.
    // 필요하면 여기서 강제 rebuild.
}

// rebuildIndex는 mu를 보유한 상태에서만 호출.
func (m *Manager) rebuildIndex(blob []byte) {
    idx := parseWorkspaceBlob(blob) // 기존 mcp.go의 parseWorkspace + buildLabelMap 포팅
    m.idx.Store(idx)
}
```

**parseWorkspaceBlob**은 `mcp.go:437-525`의 `parseWorkspace` + `buildLabelMap` 로직을 그대로 옮긴 것. JSON 스키마는 변경하지 않는다.

### 6.3 이관 작업

1. `internal/workspace/manager.go` 작성 + `parseWorkspaceBlob` 포팅.
2. `internal/workspace/manager_test.go`:
   - fake `Liveness` (map 기반), fake `Persister` (bytes.Buffer).
   - `TestResolveByLabel`: 3-pane 워크스페이스 JSON 투입, "S1.P2"가 pane2 ID로 resolve됨.
   - `TestResolveDeadPane`: pane2를 dead로 마킹 → "S1.P2" resolve 실패.
   - `TestSaveStale`: ifMatch=0 성공, ifMatch=잘못된값 → ErrStale.
   - `TestSaveRevIncrement`: 연속 Save 시 rev 증가.
3. `main.go`에 `Liveness` 어댑터 구현:
   ```go
   type pmLiveness struct{ pm *PaneManager }
   func (a pmLiveness) IsLive(id string) bool { _, ok := a.pm.get(id); return ok }
   ```
4. `main.go`에 `Persister` 어댑터:
   ```go
   type fsPersister struct{ path string }
   func (p fsPersister) Read() ([]byte, error) { return os.ReadFile(p.path) }
   func (p fsPersister) Write(b []byte) error  { return os.WriteFile(p.path, b, 0644) }
   ```
5. 전역 `wsJSON`·`wsMu` 제거. 대신:
   ```go
   var wsMgr *workspace.Manager
   ```
   `main()` 초기화에서 `wsMgr, _ = workspace.New(pmLiveness{pm}, fsPersister{path: workspaceJSONPath})`.
6. `main.go:881-886` PUT `/api/workspace` 핸들러 수정:
   ```go
   ifMatch, _ := strconv.ParseUint(r.Header.Get("If-Match"), 10, 64)
   body, _ := io.ReadAll(r.Body)
   rev, err := wsMgr.Save(body, ifMatch)
   if errors.Is(err, workspace.ErrStale) {
       w.Header().Set("ETag", fmt.Sprint(wsMgr.CurrentRev()))
       http.Error(w, "stale", 409)
       return
   }
   if err != nil { http.Error(w, err.Error(), 400); return }
   w.Header().Set("ETag", fmt.Sprint(rev))
   ```
   GET 핸들러도 `ETag` 응답 헤더 추가.
7. `mcp.go:437-553`의 `parseWorkspace`, `buildLabelMap`, `resolveID` 제거 후 `wsMgr.Resolve`, `wsMgr.Labels` 호출로 교체.
   - 각 MCP tool (`toolSendInput`, `toolSendAgentMessage`, `toolReadPaneOutput`, `toolReadScreen`, `toolListPanes`)이 `resolveID`를 사용했다면 `wsMgr.Resolve`로 대체.
8. Candidate 2에서 추가한 `PaneManager`의 `onExit` 콜백 안에서 `wsMgr.InvalidatePane(id)` 호출 추가.
9. 프런트(`static/app.js`)는 이 단계에서는 손대지 않는다. ETag/If-Match는 서버 쪽만 준비하고, 프런트가 활용하지 않으면 409는 발생하지 않음(If-Match 미전송=force). 후속 작업으로 프런트에 ETag 연동 추가 가능 — `TODO.md`에 기록.

### 6.4 수용 기준

- [ ] `go build ./... && go test ./internal/workspace/...` 통과
- [ ] 브라우저에서 pane 생성·이동·삭제 동작 정상, workspace.json 갱신됨
- [ ] MCP `list_panes` 결과에 라벨(S1.P1 등) 정상 표기
- [ ] MCP `send_agent_message` 대상 지정이 라벨과 raw ID 모두 동작
- [ ] pane 종료 후 `send_agent_message`로 해당 pane 지정 시 명확한 오류
- [ ] `TODO.md` 갱신 (프런트 ETag 연동 TODO 추가)

---

## 7. Candidate 4 — ToolDispatcher

### 7.1 Problem Frame

MCP 8 tool (`mcp.go:592-875`)이 각각 `(map[string]interface{}, error)`를 반환하며 에러 컨벤션이 3종 혼재: (a) result에 "오류: ..." 텍스트 삽입, (b) 실제 error 반환, (c) panic. `callTool` (mcp.go:370-433)은 대형 switch. 전역 `pm`, `csm`에 직접 의존. tool 추가 시 switch 항목·tool 함수·`tools/list` 스키마 3곳을 동기 수정해야 함.

### 7.2 채택 설계 — "Stage 1: Registry (Design A) → Stage 2: Ergonomics (Design C)"

두 단계로 나눈다. Stage 1만으로도 switch 제거 + 글로벌 의존 제거 효과. Stage 2는 tool 작성 편의성(Register[A], Env, Textf).

#### Stage 1 — Registry

`internal/mcptool/registry.go`:

```go
package mcptool

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
)

var ErrUnknownTool = errors.New("mcptool: unknown tool")

type Result = map[string]any

type Tool interface {
    Name() string
    Call(ctx context.Context, args json.RawMessage) (Result, error)
}

type Registry struct{ tools map[string]Tool }

func NewRegistry() *Registry { return &Registry{tools: map[string]Tool{}} }

func (r *Registry) Register(t Tool) { r.tools[t.Name()] = t }

func (r *Registry) Names() []string {
    out := make([]string, 0, len(r.tools))
    for n := range r.tools { out = append(out, n) }
    return out
}

func (r *Registry) Dispatch(ctx context.Context, name string, args json.RawMessage) (Result, error) {
    t, ok := r.tools[name]
    if !ok { return nil, fmt.Errorf("%w: %s", ErrUnknownTool, name) }
    return t.Call(ctx, args)
}

// TextResult는 표준 text 응답을 만든다.
func TextResult(s string) Result {
    return Result{"content": []any{map[string]any{"type": "text", "text": s}}}
}

// ErrorResult는 isError:true 응답을 만든다.
func ErrorResult(format string, a ...any) Result {
    return Result{
        "isError": true,
        "content": []any{map[string]any{"type": "text", "text": fmt.Sprintf(format, a...)}},
    }
}
```

각 tool을 Struct로 포팅:

```go
// internal/mcptool/tools/listpanes.go
type ListPanes struct {
    PM        PaneReader    // interface: List() / Get(id)
    Workspace WorkspaceReader // interface: Labels() map[string]string
}
func (ListPanes) Name() string { return "list_panes" }
func (t ListPanes) Call(ctx context.Context, _ json.RawMessage) (mcptool.Result, error) {
    // 기존 toolListPanes 본문 포팅. PM과 Workspace로만 접근.
}
```

`PaneReader`, `WorkspaceReader` 인터페이스는 `internal/mcptool/deps.go`에 정의:

```go
type PaneReader interface {
    List() []PaneSummary
    Get(id string) (Pane, bool)
    WriteInput(id string, data []byte) error
    Snapshot(id string) (bytes []byte, dropped int64, err error)
    // ... 필요한 만큼
}

type WorkspaceReader interface {
    Resolve(labelOrID string) (string, bool)
    Labels() map[string]string
}
```

`main.go`/Pane 쪽에서 이 인터페이스를 만족하도록 얇은 어댑터를 추가.

#### Stage 2 — Ergonomics

제네릭 `Register[A]` 헬퍼 추가:

```go
func Register[A any](r *Registry, name string, fn func(ctx context.Context, a A) (Result, error)) {
    r.Register(genericTool[A]{name: name, fn: fn})
}
type genericTool[A any] struct {
    name string
    fn   func(ctx context.Context, a A) (Result, error)
}
func (g genericTool[A]) Name() string { return g.name }
func (g genericTool[A]) Call(ctx context.Context, raw json.RawMessage) (Result, error) {
    var a A
    if len(raw) > 0 {
        if err := json.Unmarshal(raw, &a); err != nil {
            return ErrorResult("잘못된 인자: %v", err), nil
        }
    }
    return g.fn(ctx, a)
}
```

### 7.3 이관 작업

1. `internal/mcptool/registry.go` 작성.
2. `internal/mcptool/deps.go`에 `PaneReader`, `WorkspaceReader`, `CodeServerHost` 인터페이스 정의.
3. `internal/mcptool/tools/` 아래 8개 tool을 구조체로 포팅. 기존 `toolXxx` 함수 본문을 `Call` 메서드로 이동. `pm.get(...)` → `t.PM.Get(...)`, `resolveID(...)` → `t.Workspace.Resolve(...)`, `buildLabelMap(...)` → `t.Workspace.Labels()`.
4. `mcp.go`의 `handleMCPRequest` 수정:
   ```go
   // 기존: switch p.Name { case "list_panes": ... }
   // 변경:
   result, err := toolRegistry.Dispatch(ctx, p.Name, p.Arguments)
   if errors.Is(err, mcptool.ErrUnknownTool) { /* -32601 */ }
   if err != nil { /* -32603 internal */ }
   ```
5. `main.go` 초기화에서 tool 등록:
   ```go
   toolRegistry = mcptool.NewRegistry()
   toolRegistry.Register(tools.ListPanes{PM: pmAdapter{pm}, Workspace: wsMgr})
   toolRegistry.Register(tools.SendInput{PM: pmAdapter{pm}, Workspace: wsMgr})
   // ... 8개
   ```
6. `tools/list` 응답도 레지스트리 기반으로 생성(정적 스키마 테이블이 있다면 각 tool struct에 `Schema() json.RawMessage` 추가하거나, tool별 파일에 옆자리로 저장).
7. `mcp.go:370-433`의 `callTool` switch + tool 함수들 삭제.
8. 테스트 `internal/mcptool/registry_test.go`:
   - `TestUnknownTool`: 등록 안 된 이름 → `ErrUnknownTool`.
   - `TestDispatchText`: fake tool이 정상 Result 반환.
   - `TestInvalidArgs`: 잘못된 JSON → `isError:true`.
   - tool 개별 단위 테스트 1-2개 (fake PaneReader, fake WorkspaceReader로).

### 7.4 수용 기준

- [ ] `go build ./... && go test ./internal/mcptool/...` 통과
- [ ] 기존 MCP tool 8개 전부 MCP 클라이언트(Claude Code 등)에서 정상 호출됨
- [ ] `tools/list` 응답에 8개 tool 이름·스키마 표기
- [ ] `mcp.go`에서 `pm.`, `csm.` 직접 참조가 MCP protocol 레이어(SSE 핸들러)에만 남아있고 tool 본문엔 없음
- [ ] 새 9번째 tool 추가 예시 PR 초안이 10~15 LOC 내외로 작성 가능
- [ ] `TODO.md` 갱신

---

## 8. Candidate 5 — Server DI Capstone

### 8.1 Problem Frame

패키지 전역 `pm`, `csm`, `wsJSON`, `settingsJSON`, `mcpSessions`, 그리고 `commands.go`의 broadcaster 전역. 서버를 2개 인스턴스화 불가, 테스트를 위해 별도 임시 디렉터리 기반으로 구동 불가, init 순서가 암묵적. Candidate 1~4 완료 시점에는 `outbuf.Stream`, `PaneManager`(with callback), `workspace.Manager`, `mcptool.Registry`가 이미 독립적으로 존재. 남은 작업은 "배선".

### 8.2 채택 설계 — "Design C (Server + shim 전역) → 점진 Design B"

한 PR에 담는 최소 diff 버전:
- `Server` 구조체 도입, `NewServer(cfg Config) (*Server, error)` / `Run(ctx)` / `Handler() http.Handler` / `MCP() http.Handler` 제공.
- 기존 핸들러 본문은 최대한 유지, 전역 `pm`, `csm`, `wsMgr`, `toolRegistry`는 **shim**으로 남겨 `main()`에서 `defaultServer.Panes` 등으로 바인드. 컴파일 호환성 유지.
- MCP SSE 세션 레지스트리(`mcpSessions`)는 `Server.MCPSessions *MCPSessionRegistry` 필드로 이동.
- 후속 PR에서 파일 단위로 핸들러를 메서드로 전환하고 shim 변수 제거.

### 8.3 이관 작업

1. `internal/server/server.go` 작성:
   ```go
   package server

   type Config struct {
       Port     string
       DataDir  string
       StaticFS fs.FS
   }

   type Server struct {
       cfg      Config
       Panes    *PaneManager         // 기존 main.go의 타입 임포트
       CS       *CodeServerManager
       Work     *workspace.Manager
       Tools    *mcptool.Registry
       Commands *CommandBroker
       MCP      *MCPSessionRegistry
       Settings *SettingsStore
       started  time.Time
       httpSrv  *http.Server
   }

   func NewServer(cfg Config) (*Server, error) { /* load settings/workspace/panes, wire managers */ }
   func (s *Server) Handler() http.Handler { /* ServeMux with /api, /ws, /cs, /mcp, static */ }
   func (s *Server) MCPHandler() http.Handler { /* mcp SSE + message */ }
   func (s *Server) Run(ctx context.Context, addr string) error { /* httpSrv.ListenAndServe + graceful shutdown */ }
   func (s *Server) Shutdown(ctx context.Context) error
   ```
   참고: `PaneManager`·`CodeServerManager` 등이 현재 `package main`에 있으면 Candidate 5 에서 `internal/pane`, `internal/codeserver` 패키지로 옮긴다. 순환 import 주의.
2. `main.go`의 `main()` 교체:
   ```go
   func main() {
       cfg := server.Config{Port: envOr("PORT", "7531"), DataDir: defaultDataDir(), StaticFS: staticFS}
       srv, err := server.NewServer(cfg)
       if err != nil { log.Fatal(err) }
       // shim: 기존 전역이 참조하던 포인터를 Server 필드로 바인드
       pm = srv.Panes
       csm = srv.CS
       wsMgr = srv.Work
       toolRegistry = srv.Tools
       ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
       defer stop()
       if err := srv.Run(ctx, ":"+cfg.Port); err != nil { log.Fatal(err) }
   }
   ```
3. 기존 HTTP 핸들러(main.go:842-1018), MCP 핸들러(mcp.go:24-227), commands 브로드캐스터(commands.go)를 `Server` 메서드로 점진 전환:
   - **Stage 5a (같은 PR)**: 컴파일 통과만 목표. 핸들러 본문은 전역 변수 참조 그대로 유지.
   - **Stage 5b (후속 PR)**: 파일 단위로 `func handleXxx(...)` → `func (s *Server) handleXxx(...)` 전환. 해당 파일의 shim 전역 제거.
4. `internal/server/server_test.go`:
   - `TestNewServerInTempDir`: `t.TempDir()`로 `DataDir` 지정, `NewServer` 성공.
   - `TestHandlerBasics`: `httptest.NewServer(srv.Handler())`로 `/api/panes` GET → 빈 배열 응답.
   - `TestTwoServersInSameProcess`: 두 서버 동시에 띄우기 가능 확인.
5. 린트 가드: `go vet` 또는 추가 스크립트로 새 코드가 `package main`의 `pm`/`csm` 전역을 참조하지 않도록 주의. `grep -rn "\bpm\." internal/` 결과는 0이어야 함.
6. 후속 정리(Optional, 별도 PR):
   - Stage 5b: 핸들러 메서드 전환 + shim 전역 제거
   - Stage 5c: `PaneManager` → `PaneStore` 인터페이스로 추상화 (Design B 수렴)

### 8.4 수용 기준

- [ ] `go build ./... && go test ./internal/server/...` 통과
- [ ] `TestTwoServersInSameProcess` 통과
- [ ] 실제 실행 시(사용자가 수동으로) 브라우저 UI, MCP 툴, code-server 전부 정상
- [ ] `var pm`, `var csm` 등 전역 선언은 shim으로만 존재, 실제 소유권은 `Server` 필드
- [ ] `mcpSessions` 전역 제거
- [ ] `TODO.md`에 Stage 5b/5c follow-up 기록

---

## 9. 통합 수용 기준 (전체 완료 기준)

- [ ] Candidate 1~5 모두 수용 기준 통과
- [ ] `go build ./... && go vet ./... && go test ./...` 전부 통과
- [ ] 수동 스모크:
  - [ ] 브라우저 접속 → pane 3개 생성 → 긴 출력 → exit → UI 반영
  - [ ] MCP 클라이언트에서 `list_panes`, `send_agent_message`, `send_input`, `read_pane_output`, `workspace_command` 호출 성공
  - [ ] code-server 기능(`/cs/...` 엔드포인트) 정상
- [ ] `TODO.md`에 각 Candidate 완료 기록 + 미완 follow-up 항목 정리

---

## 10. 리스크 및 롤백

| Candidate | 리스크 | 완화 |
|---|---|---|
| 1 | Snapshot 성능 회귀 | 벤치 추가 (`Snapshot`/`Feed` 100K 루프), 필요 시 내부 compaction 시점 튜닝 |
| 2 | onExit 콜백 데드락 | 콜백 호출을 별도 고루틴으로 (`go p.onExit(...)`) |
| 3 | ETag 미지원 프런트가 409를 받음 | ifMatch=0이면 force save (기본 동작 유지). 프런트는 후속 작업 |
| 4 | tool 스키마 불일치 | `tools/list` 응답을 레지스트리에서만 생성해 단일 소스 유지 |
| 5 | shim 전역이 영구 잔존 | `TODO.md`에 명시적으로 Stage 5b 기록, 린트 가드 추가 |

각 Candidate 브랜치는 독립적이므로 문제가 생기면 해당 브랜치를 revert하고 다음으로 진행한다.

---

## 11. 설계 비교 기록 (미래 참고)

각 Candidate는 3개 설계(A: 최소, B: 최대 유연성, C: 공통 호출자 최적화)를 병렬로 검토한 결과물이다.

| Candidate | A | B | C | 채택 |
|---|---|---|---|---|
| 1 OutputBuffer | 최소 `Write/Snapshot` | Policy/Sink/Observer 풀 | `Stream.Feed/Snapshot/Stats` | **C+B(Stats만)** |
| 2 ProcessTracker | `Wait/Kill` 3메서드 | Launcher/Introspector/EventBus | `ExitReporter` 콜백 | **C+A(Wait)** |
| 3 WorkspaceManager | 3메서드 opaque | Store/Validator/Subscriber/CAS | 원자 인덱스 + ETag | **C** |
| 4 ToolDispatcher | Registry+Tool 인터페이스 | Schema/Middleware/Outcome | Env+Register[A]+Textf | **A→C 단계적** |
| 5 Server DI | Monolithic Server | 포트&어댑터 전면 | shim 전역 + `Server` 메서드 | **C → (향후) B** |

기준: 개인 프로젝트, 테스트 0개 기점, 실제 마찰 중심 해결, 과설계 회피(YAGNI).

---

## 12. 작업자 체크리스트 (요약)

```
[ ] 3.1 내부 패키지 디렉터리 생성
[ ] Candidate 1 — OutputBuffer
    [ ] internal/outbuf/stream.go + _test.go
    [ ] Pane 구조체 필드 교체, readPTY.Feed, Snapshot 사이트 교체
    [ ] 수용 기준 4.4 전부
[ ] Candidate 2 — ProcessTracker
    [ ] Pane.onExit 필드 + startPane 시그니처
    [ ] readPTY의 pm.delete 제거
    [ ] PaneManager.create에서 콜백 바인드
    [ ] Pane.Wait() 공개
    [ ] 수용 기준 5.4 전부
[ ] Candidate 3 — WorkspaceManager
    [ ] internal/workspace/manager.go + _test.go
    [ ] Liveness/Persister 어댑터
    [ ] mcp.go의 parseWorkspace/buildLabelMap/resolveID 제거
    [ ] PUT /api/workspace ETag 응답
    [ ] Candidate 2의 onExit에서 InvalidatePane 호출
    [ ] 수용 기준 6.4 전부
[ ] Candidate 4 — ToolDispatcher (Stage 1)
    [ ] internal/mcptool/registry.go + deps.go
    [ ] 8개 tool 구조체 포팅
    [ ] handleMCPRequest에서 Registry.Dispatch 사용
    [ ] callTool switch 제거
    [ ] 수용 기준 7.4 전부
[ ] Candidate 4 — Stage 2 (옵션)
    [ ] Register[A] 제네릭 헬퍼
    [ ] tool 본문 Textf 등으로 리팩터
[ ] Candidate 5 — Server DI
    [ ] internal/server/server.go + _test.go
    [ ] main() NewServer 사용
    [ ] shim 전역 바인드
    [ ] MCPSessionRegistry 필드화, mcpSessions 전역 제거
    [ ] 수용 기준 8.4 전부
[ ] 통합 수용 기준 9 전부
[ ] TODO.md 갱신, 후속 follow-up 기록
```

---

*문서 버전: 2026-04-21 (초판)*
*저자: dykim@hancomins.com (via Claude Code improve-codebase-architecture skill)*
