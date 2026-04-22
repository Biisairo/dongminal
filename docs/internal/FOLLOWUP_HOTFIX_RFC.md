# Follow-up & Hotfix RFC — dongminal

> `ARCHITECTURE_DEEPENING_RFC.md` (Candidate 1~5) 후속 작업을 단일 문서로 정리한다. 이 문서 역시 **작업자 독립 실행 가능**을 목표로 작성되었으며, dongminal-team 스킬로 각 항목을 하나씩 순차 구현·검증한다.
>
> 작업 대상 리포: `/Users/dykim/personal/dongminal`
> 이전 RFC: `/Users/dykim/personal/dongminal/docs/ARCHITECTURE_DEEPENING_RFC.md`
> 작성일: 2026-04-21

---

## 0. 진행 원칙

- 이전 RFC와 동일: `./start.sh` 실행 금지. git commit/push/add 사용자 영역. gh 이슈 생성 금지. 서버 실행·브라우저 스모크도 사용자 영역(단 이번에는 사용자가 서버 재기동 후 라이브 MCP 검증까지 확인함).
- **dongminal-team 스킬로 항목당 1개 팀(Implementer+Reviewer, 모두 Opus)** 구성. 완료 후 `/exit` + `closeTab` 으로 해체하고 다음 항목으로 넘어간다.
- 모든 항목은 `go build ./... && go vet ./... && go test ./...` 통과 필수.
- `TODO.md` 에 각 항목 완료 1줄 기록.
- 한 항목 PR 단위로 커밋하며, 사용자가 직접 커밋.

---

## 1. 실행 순서 및 의존성

```
H1 (dropped_bytes 과산정 핫픽스)           ← 국소, 독립
H2 (list_panes 좀비 엔트리 정리)           ← 국소, 독립
H3 (File drop 업로드 후 프롬프트 미표시)   ← 프런트, 독립
F1 (프런트 If-Match 연동)                  ← 프런트, 독립
F2 (ToolDispatcher Stage 2)                ← 서버 내부, 독립
F3 (Server DI Stage 5b: handler 메서드 전환) ← F4에 선행
F4 (Server DI Stage 5c: full interface-ization) ← F3 뒤
```

**권장 머지 순서:** H1 → H2 → H3 → F1 → F2 → F3 → F4

---

## 2. Item H1 — `dropped_bytes` 과산정 수정

### 2.1 Problem Frame

실환경 테스트에서 50000줄(~4MB) 출력 후 `read_pane_output` 응답이 `dropped_bytes: 10757557239` (≈10.7GB) 으로 실제의 ~2500배 과산정. Candidate 1의 Reviewer가 승인 시점에 이미 "max~2*max 구간 중첩 Feed 시 totalDrop 과산정" 을 "설계 의도 내, 비차단" 으로 판단했으나, 실환경에서 수치가 의미를 잃을 만큼 벌어져 사용자 오해를 유발함.

### 2.2 Root Cause

`/Users/dykim/personal/dongminal/internal/outbuf/stream.go:36-52` `Feed` 함수:

```go
} else if len(s.buf) > s.max {
    dropped = len(s.buf) - s.max
    s.totalDrop.Add(int64(dropped))     // ← 버그
    // 물리적 compaction은 2*max 초과 시에만. 빠른 경로는 논리적 truncation만 기록.
}
```

- 이 분기는 **실제 drop 없이** totalDrop 카운터만 누적
- 다음 Feed에서 `len(s.buf)` 가 여전히 over-max이면 같은 영역의 over 바이트가 **또** 카운트됨
- Snapshot은 tail만 복사해 돌려주므로 "논리적 drop"은 실제로는 drop이 아님 — 사용자에게 보이는 tail은 손실 없음

### 2.3 채택 설계

`else if` 분기 삭제. `totalDrop` 은 오직 실제 물리 compaction(2×max 초과) 시점에서만 증가. 이 경우 사용자가 보는 tail은 snapshot 복사본이고, drop 카운트는 **정말로 소실된 바이트 수**를 반영.

부수 효과: dropped_bytes가 `>0` 이 될 조건이 더 드물어짐. 실제 사용자가 관찰하는 drop은 "수 MB 입력 → compaction 1~2회" 단위로 누적되며 수치가 현실적으로 됨.

### 2.4 이관 작업

1. `internal/outbuf/stream.go:45-50` 의 `else if` 분기 삭제. `dropped` 반환값은 compaction이 있을 때만 `>0`.
2. 주석 정리: "논리적 truncation" 표현 제거. `totalDrop` 은 "실제 compaction 으로 소실된 누적 바이트".
3. `Feed` 함수 설명 주석 업데이트.
4. `stream_test.go`:
   - `TestFeedAboveMax`: 250 바이트 × max 100, Feed 1회 → compaction 즉시? 실제로는 250 > 2×100 이므로 compaction 발생. dropped=150, Stats.TotalBytesDrop=150.
   - 추가 테스트 `TestNoPhantomDrops`: max=100, Feed 50바이트 × 5회 = 250바이트. 최종 Stats.TotalBytesDrop 은 250-100=150 정확히. (기존엔 120+130 식으로 중복 누적되었음)
5. `go test ./internal/outbuf/...` 통과.
6. `TODO.md` 에 "H1 dropped_bytes 핫픽스 완료" 기록.

### 2.5 수용 기준

- [ ] `else if len(s.buf) > s.max` 분기 삭제 확인
- [ ] `TestNoPhantomDrops` 추가 및 통과
- [ ] 기존 4개 테스트 재통과
- [ ] `go build/vet/test` 통과
- [ ] TODO.md 갱신

---

## 3. Item H2 — `list_panes` 좀비 엔트리 정리

### 3.1 Problem Frame

shell에서 `exit` 명령으로 PTY 프로세스가 종료되면:
- `Pane.readPTY` 가 EOF 수신 → `p.onExit(id)` → `pm.delete(id)` + `wsMgr.InvalidatePane(id)`
- `pm` 에서는 제거되지만, **`workspace.json` 의 브라우저-소유 레이아웃 트리에는 해당 paneId 를 참조하는 탭이 남음**
- `InvalidatePane` 은 no-op (Candidate 3 Reviewer 승인 시점 설계 결정)
- `toolListPanes` 는 `wsMgr.Entries()` 를 iterate 하므로 죽은 paneId 도 노출. `pm.Get(id)` 실패 시 `shellPid=0, size=?` 좀비로 표시됨

실제 UX에서 혼란을 유발 (AI agent가 dead pane에 send_input 시도 등).

### 3.2 채택 설계

**"toolListPanes 가 반환 전 dead pane 엔트리를 필터링"** — 최소 침습, 단일 소스 원칙(브라우저가 workspace owner) 유지.

대안(기각):
- B: `InvalidatePane` 이 workspace.json을 직접 수정 → 브라우저 모르게 서버가 workspace state 변경 → 동기 갈등 위험
- C: 프런트가 `opExit` 수신 시 tab 자동 닫기 → 프런트 범위 확대, 사용자가 의도적으로 dead tab 보존하고 싶은 경우와 충돌

### 3.3 이관 작업

1. `internal/mcptool/tools/listpanes.go` (또는 해당 tool struct 파일):
   - `Entries()` 로 얻은 엔트리 중 `PaneReader.Get(id)` 가 not-found 인 것은 응답에서 제외
   - 응답 텍스트에 "live panes only" 또는 "(dead entries filtered)" 같은 설명은 추가하지 않음 (기존 포맷 유지)
2. `toolReadPaneOutput`, `toolReadPaneScreen`, `toolSendInput`, `toolSendAgentMessage` 에서도 이미 `wsMgr.Resolve` 가 `IsLive` 를 거치므로 dead pane은 error 반환 — 추가 수정 불필요 (확인만).
3. `internal/mcptool/tools/listpanes_test.go` 또는 기존 테스트 확장:
   - fake WorkspaceReader 가 3개 엔트리 반환, fake PaneReader 는 그 중 2개만 live → 응답에 2개만 포함
4. `go test ./internal/mcptool/...` 통과.
5. `TODO.md` 에 "H2 list_panes 좀비 필터 완료" 기록.

### 3.4 수용 기준

- [ ] 새 파일 `_test.go` 에서 dead 필터 테스트 통과
- [ ] 라이브 스모크(사용자 영역): 새 탭 생성 → shell `exit` → MCP `list_panes` 호출 시 해당 탭 미표시
- [ ] `go build/vet/test` 통과
- [ ] TODO.md 갱신

---

## 4. Item H3 — File drop 업로드 후 프롬프트 미표시 수정

### 4.1 Problem Frame

사용자 재현:
```
dykim@DongyoonKimui-Macmini Downloads % ↑ Uploading: test.tt  ✓ test (1).tt (0B) dykim@DongyoonKimui-Macmini Downloads %
```
파일 드롭 업로드가 완료돼도 쉘 프롬프트가 **자동으로 새 줄에 재렌더되지 않음**. 커서는 빈 줄에 있고, 입력은 가능하지만 프롬프트가 보이지 않아 사용자가 혼란. 엔터 1회 입력 시 정상 프롬프트 표시.

### 4.2 Root Cause

`/Users/dykim/personal/dongminal/static/app.js:475-495` `_uploadFiles`:

```js
this.term.write('\x1b[2m↑ Uploading: '+f.name+'\x1b[0m\r\n');
// ... upload ...
this.term.write('\x1b[2m  ✓ '+d.name+' ('+this._fmtSize(d.size)+')\x1b[0m\r\n');
```

xterm.js 의 `this.term.write(...)` 는 **터미널 로컬 렌더링만** — PTY 쉘에는 어떤 입력도 가지 않음. 결과:
- 프런트가 진행 상황 텍스트를 xterm에 그림
- 쉘은 원래 프롬프트를 이미 그려놓은 상태
- 업로드 완료 후 프런트는 `\r\n` 두 줄 추가로 커서만 이동, 쉘은 **자신이 프롬프트를 다시 그려야 한다는 것을 모름**
- 사용자가 Enter 입력 → `\r` 이 PTY로 가서 빈 명령 실행 → 쉘이 새 프롬프트 출력

### 4.3 채택 설계

**모든 파일 업로드 완료 시점에 PTY로 `\r` (빈 엔터) 1회 전송.** 쉘이 이를 빈 명령으로 처리하고 새 프롬프트를 자동 출력. 사용자의 수동 Enter와 동일한 효과.

대안(기각):
- `\x0c` (Ctrl+L / clear): 스크롤백 클리어 부작용
- `term.refresh(0, term.rows-1)`: xterm 내부 리드로만 — 쉘은 여전히 침묵
- PROMPT_COMMAND 기반 트릭: 쉘 설정 의존성 발생

### 4.4 이관 작업

1. `static/app.js:475-495` `_uploadFiles` 수정:
   - `uploadNext` 가 모든 파일을 처리하고 `i >= files.length` 가 되는 순간(업로드 종료 시점)에 `OP.INPUT + \r` 을 WebSocket으로 전송:
     ```js
     const uploadNext=()=>{
       if(i>=files.length){
         // 프롬프트 재렌더: 빈 엔터 전송
         const m=new Uint8Array(2); m[0]=OP.INPUT; m[1]=0x0d;
         this._send(m);
         return;
       }
       // ... existing logic ...
     };
     ```
   - 실패 경로에서도 동일하게 최종 호출에서 프롬프트 복구되도록 uploadNext 흐름 유지.
2. 단건·다건 모두 케이스 검증 (사용자 재현 예는 3개 연속 드롭).
3. 프런트만 수정이므로 `go test` 영향 없음. 기존 빌드 통과 확인.
4. `TODO.md` 에 "H3 file drop 프롬프트 복구 완료" 기록.

### 4.5 수용 기준

- [ ] `_uploadFiles` 최종 completion 경로에서 `OP.INPUT + \r` 전송 확인
- [ ] 브라우저 라이브 테스트 (사용자 영역):
  - [ ] 파일 1개 드롭 → 업로드 완료 직후 새 프롬프트 자동 표시
  - [ ] 파일 3개 이상 연속 드롭 → 마지막 완료 직후 프롬프트 1회만 재표시
  - [ ] 업로드 실패 시에도 프롬프트 복구
- [ ] TODO.md 갱신

---

## 4-bis. Item H4 — pane 제거 시 포커스가 항상 P1로 이동하는 버그

### 4b.1 Problem Frame

어떤 pane(탭)을 닫으면 포커스가 인접 pane이 아닌 **첫 pane(P1)** 으로 점프. UX 측면에서 사용자가 직전에 보던 위치의 이웃으로 이동해야 자연스러움.

### 4b.2 Root Cause

`/Users/dykim/personal/dongminal/static/app.js:866-893` `closeTab` 메서드:

```js
rg.tabs=rg.tabs.filter(t=>t.id!==tid);
const isActive = s.id === this.ws.activeSession;
if(!rg.tabs.length){
  s.layout=doRemove(s.layout,rid);          // ← rid가 트리에서 이미 제거됨
  if(!s.layout){await this.delSession(s.id);return}
  if(isActive){
    const fallback=this.focused===rid?closestRg(s.layout,rid)?.id:this.focused;  // ← findPath가 null 반환
    this.focused=fallback&&findRg(s.layout,fallback)?fallback:firstRg(s.layout)?.id||null;  // ← firstRg로 폴백
  } else if(s.focusedRegion===rid){
    s.focusedRegion=firstRg(s.layout)?.id||null;  // ← 동일 문제(inactive session)
  }
}
```

`closestRg(n, rid)` 는 `findPath(n, rid)` 로 대상 region의 부모 체인을 찾은 뒤 인접 형제를 선택하는 함수 (`app.js:556-566`). 그러나 이 시점엔 rid가 이미 트리에서 제거됐으므로 path가 null → `firstRg` 로 폴백 → 항상 최초 region.

### 4b.3 채택 설계

**`doRemove` 이전에 closest region을 계산**해 둔다. 제거 후에는 해당 id로 `findRg` 체크만 수행하여 유효성 확인.

### 4b.4 이관 작업

1. `static/app.js:880-888` 수정:
   ```js
   if(!rg.tabs.length){
     // doRemove 전에 closest 계산 (rid가 트리에 있을 때)
     const prevClosestId =
       (isActive && this.focused===rid) || (!isActive && s.focusedRegion===rid)
         ? closestRg(s.layout, rid)?.id
         : null;
     s.layout = doRemove(s.layout, rid);
     if(!s.layout){await this.delSession(s.id);return}
     if(isActive){
       const fallback = this.focused===rid
         ? (prevClosestId && findRg(s.layout, prevClosestId) ? prevClosestId : null)
         : this.focused;
       this.focused = fallback && findRg(s.layout, fallback)
         ? fallback
         : firstRg(s.layout)?.id || null;
     } else if(s.focusedRegion===rid){
       s.focusedRegion = (prevClosestId && findRg(s.layout, prevClosestId))
         ? prevClosestId
         : firstRg(s.layout)?.id || null;
     }
   }
   ```
2. 변경 LOC 약 ±10. `closestRg` 구현 자체는 유지 (형제 인접 영역 선택 로직은 유효).
3. 프런트 전용 — `go build/vet/test` 영향 없음.
4. TODO.md 에 "H4 pane 제거 시 포커스 이동 버그 수정 완료 (2026-04-21)" 기록.

### 4b.5 수용 기준

- [ ] `doRemove` 호출 전에 closest region id 계산
- [ ] 활성 세션 / 비활성 세션 모두 closest fallback 적용
- [ ] closest region이 트리에서 실제 존재하지 않는 에지 케이스(예: 마지막 영역 제거)에서 `firstRg` 폴백 유지
- [ ] 기존 `closeTab(location=...)` 원격 호출 경로도 동일하게 정상 동작
- [ ] 브라우저 라이브 테스트(사용자 영역): 여러 pane 분할 상태에서 중간 pane 닫으면 좌/우 인접 pane으로 포커스 이동
- [ ] TODO.md 갱신

---

## 4-ter. Item H5 — 창 분할/삭제 지연 (성능 회귀)

### 4c.1 Problem Frame

후속 작업(Candidate 1~5 + H1~H4 + F1~F4) 머지 후 **창 분할·pane 삭제 시 키보드 입력 후 지연이 발생**한 뒤 동작이 진행됨. 리팩터링 전 대비 명확하게 느려짐. 기능은 정상.

### 4c.2 가설 — Suspected Causes

사용자 관찰 상 체감 지연은 수백 ms 규모. 아래 후보들을 우선순위로 조사·대응:

1. **`workspace.Manager.Save` 의 동기 디스크 쓰기** — HTTP PUT `/api/workspace` 의 response 가 `os.WriteFile` 완료를 기다림. macOS 에서 sync 포함 single-digit~수십 ms. 분할/삭제마다 PUT 발생.
2. **workspace.Manager 의 JSON 파싱 + 인덱스 재빌드** — `buildIndex` 가 `json.Unmarshal` + tree traversal. 기존엔 MCP tool 호출 시점에만 lazy 파싱, 이제 매 PUT 에서 eager.
3. **`loggingMiddleware` 의 `log.Printf`** — `/api/ping`·`/api/stats` 외 모든 요청을 stdout 으로 로깅. 핫 엔드포인트 제외 필요.
4. **(기존 요인, 참고)** `_isPaneBusy` → `/api/pane/:id/busy` → `pgrep` shell out. 이건 리팩터링 이전부터 존재했으므로 회귀 원인 아님.

### 4c.3 채택 설계

**투-트랙 접근**:

**Track A (확실한 개선, 저위험):** 로깅 미들웨어의 핫 엔드포인트 제외 목록 확장 — `/api/workspace`(PUT), `/api/panes`, `/api/pane/`·`/api/panes/` 프리픽스 등 분할/삭제 관련 엔드포인트를 로그 스킵 목록에 추가. stdout flush/버퍼 대기 제거.

**Track B (핵심 개선):** `workspace.Manager.Save` 의 디스크 쓰기를 **백그라운드 goroutine**으로 이관.
- Save 는 raw/idx/rev 를 atomic 교체 후 즉시 리턴
- 별도 writer goroutine 이 채널로 받은 최신 blob 을 파일에 쓴다. 중간 쓰기는 drop (coalescing) — 최신본만 유지
- writer goroutine 종료는 `Close()` 메서드에서 graceful flush
- `Server.Shutdown` 경로에서 `wsMgr.Close()` 호출해 디스크 일관성 확보

**Track C (측정):** Implementer 가 먼저 간단 타이밍 로그를 `workspace.Save` 핫 경로(buildIndex, store.Write 각각)에 임시 추가해 실측. 결과에 따라 B 의 범위를 조정(파싱도 async 로 뺄지 여부). 최종 커밋 시 타이밍 로그는 제거.

### 4c.4 이관 작업

1. **측정 단계 (임시 계측)**:
   - `internal/workspace/manager.go` 의 `Save` 에 `t0 := time.Now()` 로그 3개 구간(buildIndex / store.Write / atomic swap+rev) 추가
   - 로컬에서 재기동 후 UI 에서 분할·삭제 10회 반복, 로그의 평균/최대 확인
   - 결과를 TEAM-REPLY 비고에 기록
2. **Track A — 로깅 스킵**:
   - `internal/server/server.go:211` 의 스킵 조건 확장:
     ```go
     if !isHotPath(r.URL.Path) {
         log.Printf(...)
     }
     ```
   - `isHotPath` 는 `/api/ping`, `/api/stats`, `/api/workspace`, `/api/panes`, `/api/pane/`, `/api/panes/` prefix 를 체크
   - 에러 상태(status>=400)는 로깅 유지
3. **Track B — 비동기 디스크 쓰기**:
   - `workspace.Manager` 에 필드 추가:
     ```go
     writeCh chan []byte
     done    chan struct{}
     ```
   - `New` 에서 buffered channel(크기 1 또는 2) + writer goroutine 시작. goroutine 은 latest-wins 패턴: 채널에서 받을 때 drain 후 최신 blob 만 store.Write
   - `Save` 는 store.Write 호출 대신 `select{ case m.writeCh <- buf: default: /* drop older pending */ }` 로 교체
   - `Close()` 추가 — channel close + goroutine 조인
   - `Server.Shutdown` 또는 main 의 graceful shutdown 경로에서 `wsMgr.Close()` 호출 (`deps.Work` 가 `Close() error` 를 만족하도록 인터페이스 확장 검토. YAGNI 관점에서 구체 타입 접근이 더 간단하면 그걸로)
4. **테스트**:
   - `workspace/manager_test.go` 에 `TestSaveIsNonBlocking` 추가 — slow Persister(write에 100ms sleep) 로도 Save 가 sub-ms 리턴
   - `TestSaveCoalescing` — 빠른 연속 Save 10회 시 실제 disk write 는 1~2회만 발생 (mock 카운터)
   - `TestCloseFlushesPending` — Close() 호출 시 pending 최신본이 디스크에 반영
5. **계측 로그 제거** — 측정 결과 Track B 로 해결됐는지 확인 후 임시 로그 삭제.
6. `go build/vet/test ./...` 통과.
7. TODO.md 에 'H5 창 분할/삭제 지연 수정 완료 (2026-04-21). 측정값 before=A ms / after=B ms' 기록.

### 4c.5 수용 기준

- [ ] 측정 단계에서 지연 원인 수치로 확인 (비고에 기재)
- [ ] Track A: `/api/workspace`, `/api/panes` 계열 로그 스킵 적용
- [ ] Track B: Save 가 sub-ms 리턴 (TestSaveIsNonBlocking PASS)
- [ ] Coalescing 동작 (TestSaveCoalescing PASS)
- [ ] Close/shutdown 에서 pending flush (TestCloseFlushesPending PASS)
- [ ] 기존 테스트 회귀 0
- [ ] 라이브 테스트(사용자 영역): 분할·삭제 체감 지연 사라짐
- [ ] 임시 계측 로그 제거됨
- [ ] TODO.md 갱신

---

## 5. Item F1 — 프런트 `If-Match` 연동

### 5.1 Problem Frame

Candidate 3에서 서버 측 `PUT /api/workspace` 가 `If-Match` 헤더를 파싱하고 `ErrStale` → 409 응답을 반환하도록 구현됐지만, 프런트가 `If-Match` 를 보내지 않아 사실상 force save 경로로만 동작. 두 Claude Code 인스턴스가 동시에 workspace 편집 시 여전히 last-write-wins.

### 5.2 채택 설계

- GET `/api/workspace` 응답의 `ETag` 헤더를 클라이언트에서 저장 (`this.wsETag`)
- PUT 시 `If-Match: <wsETag>` 헤더 전송
- 409 응답 수신 시: 1) 사용자에게 경고 표시, 2) GET 재호출로 최신 워크스페이스 리로드, 3) 로컬 변경 덮어쓰고 재시도는 하지 **않음** (사용자 데이터 유실 방지). 간단한 toast/console.warn 수준으로 시작.

### 5.3 이관 작업

1. `static/app.js` 에서 workspace GET 경로 찾기 (`fetch('/api/workspace')` 등). 응답 헤더 `ETag` 값을 `this.wsETag` 에 저장.
2. workspace PUT 경로:
   - 요청 헤더에 `If-Match: <this.wsETag>` 추가
   - 성공 응답(200)의 `ETag` 로 `this.wsETag` 갱신
   - 409 응답: `console.warn('[workspace] stale; reloading')` + GET 으로 리로드 + 현재 편집 중인 state 는 보존하지만 적용 스킵
3. 로컬에서 저장되지 않은 변경이 있는 상태에서 409 발생 시 사용자에게 알림 (toast UI 있으면 사용, 없으면 console 로그만).
4. GET `/api/state` 경로가 별도로 workspace를 포함해 리턴하는 엔드포인트라면 해당 경로에서도 ETag 처리.
5. 실제 동작 확인(사용자 영역): 2개 브라우저 탭에서 동시에 workspace 편집 시 두 번째 PUT이 409로 차단됨.
6. `TODO.md` 에 "F1 프런트 If-Match 연동 완료" 기록.

### 5.4 수용 기준

- [ ] GET 응답에서 ETag 저장
- [ ] PUT 요청에 If-Match 헤더 포함
- [ ] 409 응답 시 워크스페이스 리로드 경로 동작 확인
- [ ] 정상 저장 경로는 회귀 없음 (기존 UX 유지)
- [ ] TODO.md 갱신

---

## 6. Item F2 — ToolDispatcher Stage 2

### 6.1 Problem Frame

RFC §7에서 Stage 1(Registry + Tool interface + 7개 tool struct)은 완료. Stage 2(제네릭 `Register[A]` + `Textf` 헬퍼)는 tool 작성 boilerplate 감소를 위한 ergonomics 개선.

### 6.2 채택 설계

`internal/mcptool/registry.go` 에:
```go
func Register[A any](r *Registry, name string, fn func(ctx context.Context, a A) (Result, error))

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

추가 헬퍼:
```go
func Textf(format string, a ...any) Result   // TextResult(fmt.Sprintf(...)) shortcut
```

기존 7개 tool 마이그레이션은 **선택적**. 적어도 1개 tool은 Register[A] 경로로 재작성해 예시 제공.

### 6.3 이관 작업

1. `internal/mcptool/registry.go` 에 `Register[A]`, `genericTool[A]`, `Textf` 추가.
2. `internal/mcptool/registry_test.go`:
   - `TestRegisterGeneric`: struct args 타입으로 Register, Dispatch 시 자동 unmarshal 검증
   - `TestGenericInvalidJSON`: JSON invalid → ErrorResult 반환 (error는 nil)
   - `TestTextf`: 형식 문자열 치환 검증
3. 기존 tool 중 비교적 단순한 1개(예: `who_am_i` 또는 `workspace_command`) 를 Register[A] 경로로 재작성. 인자 struct는 tools 패키지에 정의.
4. main.go 의 Registry 등록 지점은 기존 `reg.Register(tools.Xxx{...})` 와 신규 `mcptool.Register(reg, "name", fn)` 이 **공존 가능**하도록 확인.
5. `tools/list` 응답의 스키마는 재작성된 tool도 기존과 동일해야 함 (Schema 메서드 없으면 별도 스키마 테이블 유지 가능). 스키마 동일성 수동 확인.
6. `go build/vet/test` 통과.
7. `TODO.md` 에 "F2 ToolDispatcher Stage 2 완료" 기록.

### 6.4 수용 기준

- [ ] Register[A]·Textf·genericTool[A] 구현
- [ ] 3개 신규 테스트 PASS
- [ ] 1개 tool 재작성 샘플 + LOC 감소 확인 (대략 5~10 LOC 절감)
- [ ] tools/list 스키마 동일성
- [ ] TODO.md 갱신

---

## 7. Item F3 — Server DI Stage 5b (handler 메서드 전환)

### 7.1 Problem Frame

Candidate 5 Stage 5a 완료 시점에 `Server` 구조체와 `NewServer/Run/Handler/MCPHandler/Shutdown` 이 `internal/server` 에 존재하지만, 기존 HTTP·MCP 핸들러 본문은 여전히 **package main 의 shim 전역**(`pm`, `csm`, `wsMgr`, `toolRegistry`, `mcpReg`) 을 직접 참조. 2개 서버 동시 기동은 테스트에서만 가능하고, 프로덕션에서는 shim 때문에 실질적으로 1 서버 전제.

### 7.2 채택 설계

**handler 본문을 Server 메서드로 전환하고 shim 전역을 제거.** 점진적 전환(파일 단위) 권장.

구체:
- `main.go` 의 `http.HandleFunc("/api/panes", handlePanesGet)` 같은 등록 → `server.go` 의 `Server.Handler()` 내에서 `mux.HandleFunc("/api/panes", s.handlePanesGet)` 로 이동
- 핸들러 함수 시그니처 변경: `func handleX(w, r)` → `func (s *Server) handleX(w, r)` (또는 closure로 Server 주입)
- 본문의 `pm.foo()` → `s.Panes.foo()`, `wsMgr.Save(...)` → `s.Work.Save(...)`
- MCP 핸들러(SSE + message) 도 동일 패턴
- shim 전역 선언부 전부 삭제 (`var pm *PaneManager`, `var csm *CodeServerManager`, `var wsMgr *workspace.Manager`, `var toolRegistry *mcptool.Registry`, `var mcpReg *server.MCPSessionRegistry`)
- `main.go::main()` 은 srv = server.New(...); srv.Run(ctx, addr) 만 남음

### 7.3 이관 작업

1. 현재 `package main` 에 있는 HTTP 핸들러 함수 목록 grep으로 수집:
   ```bash
   grep -n "^func handle\|http.HandleFunc" /Users/dykim/personal/dongminal/main.go
   grep -n "^func.*http.ResponseWriter" /Users/dykim/personal/dongminal/main.go
   ```
2. 파일 단위 또는 기능 단위로 1개씩 `internal/server/server.go` (또는 `internal/server/handlers.go` 같은 새 파일) 로 옮김:
   - 시그니처 `func (s *Server) handleXxx(w, r)` 로
   - 본문 `pm.` → `s.Panes.`, `csm.` → `s.CS.`, `wsMgr.` → `s.Work.`, `toolRegistry.` → `s.Tools.`, `mcpReg.` → `s.MCP.`
   - 필요한 새 메서드가 `Server.Handler()` 의 mux 등록에 포함되도록 반영
3. MCP SSE/message 핸들러 동일 처리. 기존 mcpSessions 접근부는 `s.MCP` 로.
4. 전부 전환된 시점에 `var pm`, `var csm`, `var wsMgr`, `var toolRegistry`, `var mcpReg` 선언 완전 제거. main() 은 단순화:
   ```go
   func main() {
       cfg := server.Config{Port: envOr("PORT","7531"), DataDir: defaultDataDir(), StaticFS: staticFS}
       srv, err := server.New(cfg, buildDeps(cfg))
       if err != nil { log.Fatal(err) }
       ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
       defer stop()
       if err := srv.Run(ctx, ":"+cfg.Port); err != nil { log.Fatal(err) }
   }
   ```
5. `buildDeps` (또는 동급 helper) 가 PaneManager/CodeServerManager/workspace.Manager/mcptool.Registry 구체 타입을 구성해 `server.Deps` 에 담아 전달.
6. `grep -rn "\\bpm\\." main.go` 결과 0 확인. 유사하게 csm/wsMgr/toolRegistry/mcpReg 도 0.
7. `internal/server/server_test.go` 확장:
   - TestHandlerBasics 같은 기존 테스트는 shim 없이 단독 기동 경로로 실행됨 — 이미 통과했던 테스트가 깨지지 않는지 확인
   - 새 테스트 `TestCreatePaneViaServer`: `POST /api/panes` 로 실제 생성되는지 fake deps 로 검증
8. `go build/vet/test` 통과. 특히 `TestTwoServersInSameProcess` 는 여전히 green.
9. `TODO.md` 에 "F3 Server DI Stage 5b 완료" 기록.

### 7.4 수용 기준

- [ ] 모든 HTTP/MCP 핸들러가 `Server` 메서드로 이동
- [ ] shim 전역 선언 0 (grep 확인)
- [ ] 기존 테스트 + 신규 테스트 모두 PASS
- [ ] 라이브 스모크(사용자 영역): 브라우저 UI/MCP tool/code-server 모두 회귀 없음
- [ ] TODO.md 갱신

---

## 8. Item F4 — Server DI Stage 5c (full interface-ization)

### 8.1 Problem Frame

F3 완료 시점에 `Server.Panes`, `Server.CS`, `Server.Work`, `Server.Tools` 는 Stage 5a/b 과정에서 이미 **인터페이스**로 선언됐을 가능성이 높음 (Candidate 5 option b의 결과). 그러나 프로덕션에서는 여전히 구체 타입(`*PaneManager` 등) 하나만 주입됨. Stage 5c 는 다음 두 가지 가치를 제공:

1. fake 구현으로 단위 테스트 커버리지 확대 (PTY 의존 없이 HTTP/MCP 레이어 테스트)
2. 향후 다른 백엔드(예: 원격 pane 프록시, 메모리 전용 테스트용) 도입 가능성

### 8.2 채택 설계

F3 완료 시점의 Server 인터페이스들을 정식 문서화:
- `internal/server/deps.go` (또는 server.go 내부) 에 인터페이스 정의 consolidate
- 각 인터페이스에 필요한 메서드만 최소로 유지. 현재 사용처만 반영
- 테스트용 fake 구현을 `internal/server/fakes/` (또는 `_test.go` 내부) 에 작성
- `*PaneManager` (package main) 가 `server.PaneHub` 인터페이스를 만족함을 어댑터/메서드 추가로 명시적으로 보장

### 8.3 이관 작업

1. F3 완료 후 현재 Server 가 보유한 인터페이스 시그니처 정리:
   - PaneHub / CodeServerHost / WorkspaceStore / ToolDispatcher / CommandBroker / SettingsStore
2. 각 인터페이스에 대응하는 fake:
   - `fakePaneHub` (map 기반 in-memory)
   - `fakeCodeServerHost` (no-op 또는 간단 상태 머신)
   - `fakeWorkspaceStore` (in-memory, 버전 카운터 포함)
   - `fakeToolDispatcher` (등록된 이름 반환, 지정 응답)
   - `fakeCommandBroker` (publish 기록 보관)
   - `fakeSettingsStore` (map[string]any)
3. 신규 테스트 2~3개 추가:
   - `TestHandlerPanesGetUsesFake`: fake Panes 주입 → GET /api/panes 응답에 fake 데이터 반영
   - `TestHandlerWorkspacePutIfMatch`: fake Work로 ErrStale 시뮬레이션 → 409 응답 + ETag 헤더
   - `TestMCPDispatchUsesFakeTools`: fake ToolDispatcher 주입 → JSON-RPC 응답 검증
4. 인터페이스 메서드 이름은 기존 구체 타입의 PascalCase 메서드를 따르거나 어댑터로 매핑.
5. `go build/vet/test` 통과.
6. `TODO.md` 에 "F4 Server DI Stage 5c 완료" 기록.

### 8.4 수용 기준

- [ ] 인터페이스 정의 consolidate (`internal/server/deps.go` 또는 server.go)
- [ ] 6개 fake 구현
- [ ] 3개 신규 테스트 PASS
- [ ] 기존 테스트 회귀 0
- [ ] TODO.md 갱신

---

## 9. 통합 수용 기준

- [ ] H1~H3, F1~F4 전부 개별 수용 기준 통과
- [ ] `go build ./... && go vet ./... && go test ./...` 통과
- [ ] 라이브 스모크(사용자 영역):
  - [ ] 긴 출력 (`yes | head -200000`) 이후 `read_pane_output` 의 `dropped_bytes` 가 현실적인 수치 (원본 사이즈의 10배 미만)
  - [ ] pane `exit` 후 `list_panes` 에 좀비 엔트리 없음
  - [ ] 파일 다건 드롭 후 프롬프트 자동 재표시
  - [ ] 두 브라우저 탭 동시 워크스페이스 편집 시 409 conflict 경로 확인
  - [ ] MCP tool 전수 정상 응답
- [ ] `TODO.md` 최종 정리 (미완 follow-up 없음)

---

## 10. 리스크 및 롤백

| 항목 | 리스크 | 완화 |
|---|---|---|
| H1 | TotalBytesDrop=0 상태가 오래 지속되어 사용자가 "drop 안 일어남" 으로 오해 | Retained+TotalBytesIn 동시 제공, 문서에서 "drop은 compaction 시점에만 증가" 명시 |
| H2 | 필터 조건이 실제 live pane까지 걸러내는 경우 (race) | `pm.Get` lookup을 response 직전에만 실행, 필터링 전후 동일 snapshot에서 판단 |
| H3 | 쉘이 Python REPL 등 non-standard 상태일 때 `\r` 이 의도치 않은 엔터로 해석 | 현 디자인은 엄격히 "업로드 완료 직후 1회" 에만 전송, 기존과 수동 Enter 결과 동일하므로 회귀 최소 |
| F1 | 409 루프 (브라우저가 자동 재시도 후 또 충돌) | 자동 재시도 금지, 사용자에게 경고만 |
| F2 | 제네릭+반사 기반 unmarshal의 런타임 에러가 스택에서 헷갈림 | 기본 에러 메시지에 tool name 포함, 기존 tool은 그대로 두고 점진 마이그레이션 |
| F3 | 핸들러 전환 과정 중 일시적 컴파일 깨짐 | 파일 단위로 PR, 각 PR이 독립적으로 green 보장 |
| F4 | fake 구현이 실제 동작과 괴리 → 테스트가 거짓 OK | fake 도입 시 "실 구현 대응표" 테스트 1개로 대응 확인 |

각 항목은 독립 브랜치로 관리해 문제 시 revert.

---

## 11. 작업자 체크리스트 (요약)

```
[ ] H1 — dropped_bytes 과산정 수정
    [ ] stream.go else-if 분기 삭제, 주석 정리
    [ ] TestNoPhantomDrops 추가
    [ ] 기존 테스트 재통과, go build/vet/test
    [ ] TODO.md 갱신
[ ] H2 — list_panes 좀비 필터
    [ ] tools/listpanes.go 필터 로직
    [ ] 단위 테스트
    [ ] TODO.md 갱신
[ ] H3 — file drop 프롬프트 복구
    [ ] _uploadFiles 최종 경로에서 OP.INPUT+\r 전송
    [ ] 사용자 라이브 테스트
    [ ] TODO.md 갱신
[ ] F1 — 프런트 If-Match 연동
    [ ] GET ETag 저장
    [ ] PUT If-Match 헤더
    [ ] 409 리로드 경로
    [ ] TODO.md 갱신
[ ] F2 — ToolDispatcher Stage 2
    [ ] Register[A], genericTool[A], Textf
    [ ] 3개 테스트
    [ ] 1개 tool 재작성 샘플
    [ ] TODO.md 갱신
[ ] F3 — Server DI Stage 5b
    [ ] 모든 HTTP/MCP 핸들러 → Server 메서드
    [ ] shim 전역 삭제
    [ ] 기존+신규 테스트
    [ ] TODO.md 갱신
[ ] F4 — Server DI Stage 5c
    [ ] 인터페이스 정의 consolidate
    [ ] fake 6종
    [ ] 신규 테스트 3개
    [ ] TODO.md 갱신
[ ] 통합 수용 기준 9 전부
```

---

*문서 버전: 2026-04-21 (초판)*
*저자: dykim@hancomins.com (via Claude Code improve-codebase-architecture skill)*
