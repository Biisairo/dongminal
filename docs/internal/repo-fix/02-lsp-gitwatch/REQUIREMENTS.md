# 요구조건: gitwatch·LSP 근본 수정 — IEEE 29148 (StRS)

> 문서 상태: 승인(사용자 인터뷰 2026-09-24) · 사전 공격 검증(`tmp/preattack-02-05.md`) 반영 — §3A · 입력 → sdd-tdd 워크플로우
> 우선순위: **§3A > §3 본문**. 본문 중 §3A 와 모순되던 문장(G-1.1·G-1.2·G-2.1·G-2.2·L-1·L-3.2·L-5)은 직접 정정했다.
> 근거: `tmp/REPO_AUDIT_2026-09-24.md`, `tmp/verify-backend.md`(판정·실측·N3/N5/N7/N9), `tmp/preattack-02-05.md` §0·§1.
> 선행: `docs/internal/repo-fix/01-git-backend` 완료. 이 문서가 쓰는 01 의 계약은 01 `REQUIREMENTS.md` 의 이름을 그대로 인용한다 — 오류 분류 `core.IsTerminal(err)`(01 §3A R-3.4), 세대 `Invalidate`(01 R-3.2·§3B-11), flight 자체 시한 30s·호출자 이탈 시 flight 유지(01 §3A R-3). 01 스펙(01-SPEC.md)의 이름이 이와 다르면 스펙 작성자는 플래그를 올리고 멈춘다.

## 1. 목적과 범위

사용자 진술: *"전부 수정. 구조적으로, 근본적으로 수정해서 정상동작하게 해야 한다."*

- 포함: `internal/webserver/hub/gitwatch.go`(+hub 관련), `internal/webserver/hub/commands.go`(구독 큐), `internal/webserver/httpapi/commands.go`(SSE 쓰기 루프), `internal/webserver/domain/lsp/**`, `internal/webserver/httpapi/handlers_lsp*.go`(+ LSP 실행 파일 경로 저장 종단), `internal/webserver/httpapi/handlers_files.go`(쓰기 성공 후 LSP 재동기화 알림 한 곳), `cmd/dongminal/main.go`(배선), LSP 설정 UI·요청(`web/js/core/app-lsp.js`, `web/js/core/app-settings.js` 의 설정 ▸ Code, `web/js/core/helpers.js` 의 `lspServerPaths` 제거), 편집기 문서 수명 훅(`web/js/core/app-editor-open.js` `edDocDrop`)에서 didClose 를 보내는 연결부의 최소 변경.
- 비포함: git 백엔드(01), 에디터 본체(03).

## 2. 근본 원인
1. **감시 제외가 오류 종류를 가리지 않음**: 일시적 오류(취소·시한·공유 flight 전파)와 결정적 오류(저장소 소실·비저장소)를 같게 취급.
2. **방송 기준선이 전달 성공과 무관하게 전진**: signature·mark 를 관측/전달 확인 전에 전진시킴.
3. **LSP 세션에 생존 판정·문서 수명이 없음**: 죽은 세션이 캐시에 남고, 열린 문서는 닫히지 않으며, 실패 기억은 전역이고 해제되지 않음. 설정 경로가 기동 경로에 배선되지 않음.
4. **이벤트 허브 하나를 모든 SSE 액션이 공유**: 큐 넘침·막힌 쓰기가 git·LSP·워크스페이스 이벤트를 함께 잃게 하고, LSP 진단은 잃으면 다시 받을 길이 없다.

## 3. 요구조건 (각 항목 이전/새 동작 기록, TDD)

### G-1 gitwatch 감시 수명 (#20)
- G-1.1 감시 제외는 `core.IsTerminal(err)==true`(01 §3A R-3.4: `ErrNotRepo`·`ErrRepoMissing`·`ErrGitMissing`)일 때만 한다. 그 밖의 오류는 회차를 건너뛰고 기준선·holders(임대)를 유지하며, 연속 실패 카운터·백오프·로그를 둔다. 수치는 §3A-1.
- G-1.2 signature 가 바뀐 회차는 01 의 세대 `Invalidate` 를 거친 뒤 관측하고, `lastSig` 는 그 관측이 성공한 뒤에만 새 값으로 확정한다(둘 다 한다 — `Invalidate` 는 TTL 캐시·옛 flight 합류를, 늦은 확정은 실패 회차의 기준선 전진을 막는다. P2 4초 지연·N5). 회차 시한(20s)이 flight 시한(30s)보다 짧은 문제의 처리는 §3A-1.
- G-1.3 관측 실패 회차에서는 `lastSig`·`lastMark` 를 전진시키지 않는다.

### G-2 구독 큐 넘침 (#21)
- G-2.1 구독 큐가 가득 차면 이벤트를 조용히 버리지 않는다. 그 구독을 닫아 클라이언트가 재연결하고 재수집하게 한다. 재연결 시 재수집은 이미 있다(`web/js/core/state-registry.js:120-140` `git.observe` 의 `revalidateOn:['sse:open']`) — 새 코드 없이 테스트로 고정한다. 막힌 쓰기에서도 구독이 풀리도록 SSE 쓰기에 시한을 둔다(§3A-2).
- G-2.2 `lsp_diagnostics` 는 큐에 넣지 않고 구독별 "uri → 최신 진단" 슬롯에 덮어쓴다 — git 이벤트를 밀어내지 않고 넘침 판정 대상도 아니다. 재연결한 구독은 진단 스냅샷을 다시 받는다(§3A-2).

### L-1 설정 경로 배선 (#15 ✅, 사용자 결정: 서버 측 설정 + 편집 UI)
- L-1.1 LSP 실행 파일 경로(서술자 id → 절대경로 표)는 **서버가 보관**하고, 설정 ▸ Code 에서 편집한다. 모든 브라우저가 같은 값을 본다. 요청은 경로를 싣지 않는다(FR-LSP-4b 개정 — 스펙에 개정 기록). 상태 조회와 세션 기동은 서버가 보관한 같은 표로 해석한다.
- L-1.2 서버의 경로 표가 바뀌면 바뀐 서술자의 기존 세션(모든 루트)과 실패 기억을 무효화한다. 세션 키·실패 기억 키는 해석된 실행 파일 경로를 포함한다.
- L-1.3 브라우저 localStorage 의 `lspServerPaths` 읽기 경로는 제거한다. 이전/새 동작은 §3A-3.

### L-2 세션 생존·복구 (#16, N9)
- L-2.1 conn 이 죽으면(읽기 루프 종료) 세션을 캐시에서 제거하고 프로세스를 회수(`Wait`)한다 — 좀비 없음.
- L-2.2 다음 요청은 새 세션을 세운다(FR-LSP-20 "다음 요청이 다시 세운다"). 연속 크래시에는 백오프(§3A-4)를 둬 재시작 루프를 막는다.
- L-2.3 initialize 실패·시한 초과 세션은 캐시에 고착되지 않는다(백오프 뒤 재시도).
- L-2.4 `lastUse` 는 요청이 성공했을 때만 갱신한다(성공 정의 §3A-4).

### L-3 실패 기억 (#17, N7)
- L-3.1 실패 기억 키에 루트와 해석된 실행 파일 경로를 포함한다. 한 루트의 실패가 다른 루트를 막지 않는다.
- L-3.2 해석 결과(찾음 여부·exe 경로)가 기억과 달라지면 기억을 폐기한다. TTL 은 60s 다. 터미널에서 설치한 뒤 재시작 없이 60s 안에 동작해야 한다.

### L-4 JSON-RPC 정확성 (#18, P2)
- L-4.1 `method` 와 `id` 가 모두 있는 서버발 요청을 요청으로 분류하고 응답한다(알려진 메서드는 최소 응답, 그 밖은 MethodNotFound -32601 — 표는 §3A-5). 응답 매칭에 섞이지 않는다.
- L-4.2 호출자 ctx 가 취소되면 `$/cancelRequest {id}` 를 보낸다.
- L-4.3 문서 동기화(판 번호 증가 + didOpen/didChange/didClose 전송)를 세션별 임계구역으로 묶어 순서 역전이 없게 한다.

### L-5 문서 수명 (#19, 사용자 결정: L-5.1 ①, L-5.2 ①)
- L-5.1 한 브라우저에서 그 문서의 **마지막 뷰가 떠날 때**(`edDocDrop` 에서 문서의 `views` 가 0 이 된 순간 — 03 E-9.1 과 같은 훅) didClose 를 보낸다. 서버의 open 맵에서도 제거한다. 다른 브라우저가 같은 문서를 보고 있어도 보낸다(동작 기록 §3A-6).
- L-5.2 디스크 변경(파일 저장, gitwatch 가 알린 저장소 변화 — 브랜치 전환 포함)이 생기면 **세션에 열려 있는 문서만** 디스크 판으로 재동기화한다. 열지 않은 파일의 변경 통보(`workspace/didChangeWatchedFiles`)는 보내지 않는다(비목표). 규칙은 §3A-6.

## 3A. 확정 사항 (사전 공격 검증 `tmp/preattack-02-05.md` 반영, 2026-09-24)

아래는 §3 의 모호점을 확정한다. **충돌 시 이 절이 본문보다 우선한다.** 근거 file:line 은 2026-09-24 작업 트리(`ed2e4e39`) 기준이다.

### §3A-0 문서 간 계약
| # | 계약 | 짝 문서 |
|---|------|---------|
| X4 | "문서의 마지막 뷰가 떠날 때" = `edDocDrop`(`app-editor-open.js:98-108`)에서 `d.views.size` 가 0 이 된 순간. 02 는 이 자리에서 `POST /api/lsp/close` 를 부르고, 03 은 같은 자리에서 LSP 진단 표시를 지운다(03 E-9.1). 뷰 단위 `destroy()`(`file-editor.js:1145`)에서는 둘 다 하지 않는다 | 03 E-9.1 |
| X7 | 결정적 오류 판정 = `core.IsTerminal(err)`(01 §3A R-3.4). 02 는 오류 종류를 자체 분류하지 않는다 | 01 R-3.4 |
| — | 03 이 이름변경(`edDocMove`, 03 §3A-5)에서 옛 경로 문서를 닫을 때도 같은 `POST /api/lsp/close` 를 쓴다 | 03 E-5.1 |

### §3A-1 gitwatch 감시 수명 (G-1)
사실: 오류 종류 불문 `delete(w.watch, repo)`(`hub/gitwatch.go:523-529`), `lastSig` 는 Status 전에 전진(`:497-502`), 회차 시한 `GitWatchRoundTimeout`=20s(`:63`) < 01 flight 시한 30s(01 §3A R-3), `Store.Observed`(`store/store.go:180-188`)는 TTL 과 무관하게 마지막 유효 관측을 준다, `ObservedAtUnixMs` 는 관측 완료 시각(`store.go:286`).

| 항목 | 확정 |
|------|------|
| 제외 조건 | Status·Signature 어느 쪽 오류든 `core.IsTerminal(err)==true` 일 때만 감시에서 뺀다 |
| 제외 시 알림 | 결정적 오류로 뺄 때 그 저장소에 `git_changed`(`mark:""`)를 1회 방송한다 — 브라우저가 status 를 다시 물어 `GIT_REPO_MISSING` 화면으로 간다 |
| 일시적 오류 | 그 저장소의 회차를 건너뛴다. `lastSig`·`lastMark`·holders·임대 만료 시각을 바꾸지 않는다 |
| 백오프 | 연속 실패 n(≥1)회째 뒤 다음 관측을 `min(2^(n-1), 30)` 초 뒤로 미룬다(그 사이 회차는 그 저장소를 건너뜀). 관측 성공 시 n=0 |
| 로그 | n=1 과 n 이 10 의 배수일 때만 1줄(저장소·n·오류) |
| sig 변화 회차 | ① 저장소에 "관측 대기(pending)"가 없으면 `Store.Invalidate(repo)`(01 R-3.2) → pending={sig, t=지금} → Status. ② pending 이 있으면 `Invalidate` 하지 않고 Status 만 부른다(같은 세대 flight 합류 또는 fresh 캐시) |
| 관측 성립 | 회차 안의 Status 성공, 또는 `Store.Observed(repo)` 가 유효하고 `ObservedAtUnixMs ≥ pending.t`. 성립하면 `lastSig=pending.sig`, pending 해제, mark 비교·방송. 이후 회차에서 현재 sig ≠ `lastSig` 면 다시 ①. 01 이 옛 세대 결과를 fresh 로 저장하지 않으므로(01 R-3.2) 이 조건을 만족하는 관측은 변화 이후 관측이다 |
| 회차 시한 | `GitWatchRoundTimeout` 20s 는 유지한다(D-GDT-7). 회차가 시한으로 Status 를 놓쳐도 flight 는 01 규약상 30s 까지 계속 돌고(호출자 이탈 시 취소 안 함), 다음 회차가 위 "관측 성립" 으로 그 결과를 받는다. pending 이 있는 동안 추가 `Invalidate` 가 없으므로 status 가 20~30s 걸리는 저장소도 관측이 성립한다 |
| 시한 초과 분류 | 회차 시한으로 Status 를 놓친 것은 일시적 오류로 세되 백오프 대상에서 뺀다(pending 유지 중에는 연속 실패 n 을 올리지 않는다) — flight 가 도는 중이기 때문이다 |
| 인터페이스 | 감시자가 쓰는 git 인터페이스에 01 의 `Invalidate`·`Observed` 를 더한다(새 판정 함수는 만들지 않는다) |

인수: ① 일시적 오류 3회 후 성공 시 holders 유지·방송 발생 ② `ErrRepoMissing` 시 제외 + `mark:""` 방송 1회 ③ 가짜 Status 가 25s 걸리는 저장소(시한은 테스트에서 축소)에서 sig 변화 후 방송이 발생 ④ TTL 캐시·옛 flight 에서 변화 전 관측을 받는 N5 재현이 방송을 낸다.

### §3A-2 이벤트 허브·SSE (G-2)
사실: 허브 하나(`hub/commands.go`)를 모든 SSE 액션이 공유 — 워크스페이스 명령·`window_focus`·`settings_changed`(`handlers_settings.go:122-124`)·`git_changed`·`lsp_diagnostics`(`cmd/dongminal/main.go:375-387`). 구독 큐 16칸(`hub/commands.go:188`), 가득 차면 버림(`:233-245`). SSE 쓰기 루프(`httpapi/commands.go:130-143`)에 쓰기 시한이 없고 전역 `WriteTimeout` 도 없다(`httpapi/server.go:346`). 따라서 쓰기가 막히면 `sub.Close()` 뒤에도 핸들러가 `Fprintf` 안에서 빠져나오지 못한다. `lsp_diagnostics` 는 푸시 전용이라 재수신 경로가 없다.

| 항목 | 확정 |
|------|------|
| 넘침 | 큐(16칸, 값 유지)가 가득 차면 그 구독을 닫는다(Close + 로그 1줄). 조용한 드롭은 없다 |
| 쓰기 시한 | SSE 핸들러는 인사·메시지·keepalive 의 **매 쓰기 전에** `http.ResponseController.SetWriteDeadline(now+10s)` 를 건다. 쓰기·Flush 오류면 핸들러가 반환하고, 반환 경로의 구독 제거·`gitWatch.Detach` 가 돈다 |
| 진단 합치기 | `lsp_diagnostics` 는 큐가 아니라 구독별 슬롯(uri → 최신 진단)에 덮어쓴다. SSE 루프는 큐와 슬롯을 함께 비운다. 같은 uri 는 최신만 전달된다. 넘침 판정은 큐에만 적용된다 |
| 진단 스냅샷 | LSP 서비스는 "uri → 최신 진단" 표를 유지한다. 빈 배열이 publish 되면 그 uri 를 지운다. 세션이 끝나면(정지·크래시·무효화) 그 세션이 publish 한 uri 들에 빈 진단을 방송하고 표에서 지운다 |
| 재연결 | 새 구독이 열리면 인사 직후 스냅샷 전부를 그 구독 슬롯에 넣는다. 새 HTTP 종단은 없다 |
| 그 밖 재수집 | 워크스페이스·설정·git 은 기존 `revalidateOn:['sse:open']`(`state-registry.js:44-149`)로 재수집한다 — 새 코드 없음, 테스트로 고정 |
| 명령 손실 | 닫힌 구독 큐에 남은 워크스페이스 명령은 재전송하지 않는다(이전 동작: 넘친 명령 드롭 — 같음). `BroadcastAndAwait` 의 전달 수 규약은 바꾸지 않는다 |

구현 중 정정 (G-2): 진단 스냅샷 표("uri → 최신 진단")는 LSP 서비스가 아니라 **허브**(`CommandHub.diagLatest`)가 든다 — 모든 진단이 `BroadcastDiagnostics(uri, payload, clear)` 로 허브를 지나므로 새 구독(`Add`)이 곧바로 스냅샷을 받고, httpapi 에 새 배선이 없다. "빈 진단이면 지운다" 는 `clear` 인자다. 세션 종료 시 빈 진단 방송은 LSP 쪽(L-2)이 그대로 진다. 또 쓰기 시한이 미들웨어의 `responseWriter` 를 지나도록 `Unwrap()` 을 더했다(없으면 `SetWriteDeadline` 이 ErrNotSupported).

인수: ① 큐를 채우면 구독이 닫히고 클라이언트 재연결 뒤 `git.observe` 재수집이 일어남(e2e 또는 단위) ② 읽지 않는 클라이언트에서 10s(테스트 축소) 뒤 핸들러 반환·Detach 호출 ③ 진단 1000건 방송 중에도 `git_changed` 가 전달됨 ④ 재연결 구독이 스냅샷을 받음.

### §3A-3 LSP 실행 파일 경로 — 서버 측 설정 (L-1, 사용자 결정)
사실: `lsp.Service.Overrides` 는 전역 필드 하나이고 설정처가 없다(`domain/lsp/service.go:25-27`). 화면의 `lspServerPaths` 는 localStorage 에서 읽기만 하고(`web/js/core/helpers.js:648-667`), 쓰는 UI 가 없다(`setItem('lspServerPaths'` 0건). 상태 조회만 `overrides` 를 싣고(`app-lsp.js:33,42,520` → `handlers_lsp.go:40-42,63`), ask 요청은 싣지 않는다. 캐시 히트 경로는 `Resolve` 를 건너뛴다(`manager.go:106-109`, FR-PRF-70). 설정 blob(`settings.json`)은 서버가 해석하지 않는다(`handlers_settings.go:16-17,87-90`, FR-LSP-4b 의 근거).

| 항목 | 확정 |
|------|------|
| 저장 위치 | 전용 파일 `<dataDir>/lsp-paths.json`, 모양 `{"paths":{"<팩id>/<서버id>":"<절대경로>"}}`. 설정 blob 에 넣지 않는다(blob 비해석 규약 유지). 쓰기는 `platform.WriteStateFile(path, data, 0644)`(`handlers_settings.go:64` 와 같은 원자적 쓰기) |
| 조회 종단 | `GET /api/lsp/paths` → 200 `{paths}`(없으면 빈 객체) |
| 저장 종단 | `PUT /api/lsp/paths` 본문 `{paths}` — 표 전체 교체. 키가 현재 서술자 id 가 아니면 400 `bad_request`. 값이 빈 문자열이면 그 키 삭제. 값이 절대경로가 아니면 400 `path_must_be_absolute`(`apierr.CodeAbsPathNeeded`, `file_boundary.go:63-64` 와 같은 코드). 파일 존재는 검사하지 않는다(상태 조회가 "없음" 을 보인다). 저장 실패 500 `save_failed`. 성공 200 `{paths}` |
| 무효화 | 저장 성공 직후, 값이 바뀐(추가·변경·삭제) 서술자마다 그 서술자의 세션을 모든 루트에서 정지하고 실패 기억을 지운다. 바뀌지 않은 서술자의 세션은 유지한다 |
| 해석 | `Status` 와 세션 기동이 같은 서버 표로 `Ext.Resolve` 한다(FR-LSP-4 ① 순위 유지). `Service.Overrides` 전역 필드와 `lspStatusReq.overrides`(`handlers_lsp.go:40-42`)는 제거한다. ask 요청(`lspAskReq`)에는 경로 필드를 더하지 않는다 |
| 세션 키 | (루트, 서술자 id, exe키). exe키 = 서버 표에 그 서술자 경로가 있으면 그 절대경로, 없으면 `default`. 캐시 히트 경로는 `extDesc` → 서술자 id → 서버 표 맵 조회 1회로 키를 만든다(`Resolve` 는 여전히 건너뜀, FR-PRF-70 유지) |
| 편집 UI | 설정 ▸ Code 의 언어 서버 목록(`app-settings.js:426-433`, `app-lsp.js:520`)의 서버 행마다 경로 입력 1칸과 저장·지우기 버튼. 저장 성공 뒤 상태를 다시 조회해 "어디서 찾았는지"(FR-LSP-5)를 갱신한다. 실패 시 서버 사유 문구를 그 행에 표시한다. Code 패널은 열릴 때마다 `GET /api/lsp/paths` 로 읽는다(방송 없음 — 기존 "상태는 관측" 규약 FR-LSP-47) |
| localStorage | `lspServerPaths` 읽기(`helpers.js:648-667`)와 `_lspOverrides`(`app-lsp.js:33`)를 제거하고, 페이지 로드 시 그 키를 `removeItem` 한다. 값을 서버로 이관하지 않는다 — 쓰는 UI 가 없어 값이 들어 있는 경우는 개발자 도구로 직접 넣은 경우뿐이다 |

구현 중 정정 (L-1): 플러그인 계층 `ext.Locator` 의 override 표는 **서버 id** 로 키잉한다(`locate.go` `Overrides[s.ID]`). 서버 표(`팩/서버`)는 서비스가 서버 id 표로 옮겨 넘긴다 — 다른 팩에 같은 서버 id 가 있으면 둘이 같은 경로를 받는다(현재 선언에는 없다). 새 파일은 `homeLayout()`·getting-started 표·api.md 에 등록했다(게이트 FR-STR-30·FR-DSY-50). 편집 UI 는 `web/js/core/app-lsp-paths.js`.

동작 기록(스펙에 싣는다) — 이전: 경로는 기기별 localStorage 에서 읽혔고 상태 조회에만 실렸으며 세션 기동은 무시했다 / 새: 서버 한 벌, 설정 ▸ Code 에서 편집, 상태·기동이 같은 값을 쓴다, 기존 localStorage 값은 버려진다 / 이유: 실행 파일은 서버 기계의 사실이고, 세션은 브라우저가 아니라 서버에서 (루트, 서술자)로 공유된다.

### §3A-4 세션 생존·실패 기억 (L-2, L-3)
사실: 실패 기억 키는 서술자 id 만(`manager.go:133-137,191-198`), `Shutdown` 이 지우지 않음(`:272-284`), 핸드셰이크 실패는 기억되지 않고 세션이 맵에 남아 `initErr` 를 되풀이(`session.go:232`, `manager.go:155` 는 Start 실패만 처리).

| 항목 | 확정 |
|------|------|
| 회수 | conn 의 읽기 루프가 끝나면 관리자는 그 세션을 맵에서 빼고 정지(stdin 닫기 → Kill → `Wait`)한다. 맵의 값이 그 세션일 때만 뺀다(재기동된 새 세션을 지우지 않는다). 진단 스냅샷 정리는 §3A-2 |
| 실패 기억 통합 | 기동 실패·핸드셰이크(initialize) 실패·시한 초과·크래시를 하나의 실패 기억에 둔다 |
| 기억 키 | (루트, 서술자 id, 해석된 exe 경로 — 못 찾았으면 빈 문자열) |
| 기억 값 | {사유, 시각, 연속 횟수 n} |
| 재시도 시각 | 시각 + `min(2^(n-1) × 1s, 60s)`. 그 전 요청은 기억된 사유로 즉시 실패 |
| 크래시 계수 | 기동 후 60s 안에 죽은 경우만 n 을 올린다. 60s 이후의 크래시는 기억 없이 다음 요청이 즉시 재기동 |
| 폐기 | TTL 60s 경과, 또는 `Resolve` 결과의 찾음 여부·exe 가 기억과 다름, 또는 `Install`·`Shutdown`·경로 표 변경(§3A-3) |
| 핸드셰이크 실패 | 그 세션을 맵에 넣지 않고(이미 넣었으면 뺀다) 정지한다 |
| `lastUse` | LSP 응답을 받은 요청(JSON-RPC error 응답 포함)에서만 갱신한다. 전송 실패·ctx 취소·conn 사망은 갱신하지 않는다. `sync()` 안의 갱신은 제거한다 |
| 비목표 | 언어 서버가 띄운 자식 프로세스 그룹 kill(01 R-1 헬퍼 재사용은 후속 과제) |

### §3A-5 JSON-RPC (L-4)
사실: 서버발 요청 처리는 `conn.go:106-121`. id 타입이 `*int64` 라 문자열 id 요청은 Unmarshal 단계에서 버려진다(`conn.go:99-103`). 판 번호 증가(잠금 안)와 전송(잠금 밖)이 분리(`session.go:245-270`). 클라이언트 capability 에 dynamicRegistration 을 선언하지 않는다(`session.go:218-229`).

| 항목 | 확정 |
|------|------|
| id 보존 | 수신 id 는 원문 JSON(숫자·문자열 모두)으로 보존하고 응답에 그대로 되싣는다 |
| 분류 | `method` 와 `id` 가 함께 있으면 서버발 요청, `id` 만 있으면 응답, `method` 만 있으면 알림 |
| 응답 위치 | 서버발 요청의 응답은 읽기 루프 밖(별도 고루틴)에서 쓴다 — 서버가 stdin 을 읽지 않아도 읽기 루프가 막히지 않는다 |
| 최소 응답 | `workspace/configuration` → `params.items` 길이만큼 `null` 배열 · `client/registerCapability`·`client/unregisterCapability`·`window/workDoneProgress/create` → `null` · `workspace/workspaceFolders` → 세션 루트 1개 · 그 밖 → error −32601 |
| 취소 | `Call` 이 응답 수신 전에 ctx 로 빠질 때만 `$/cancelRequest {id}` 를 알림으로 보낸다. `initialize` 에도 적용 |
| 동기화 임계구역 | 세션에 문서 동기화 뮤텍스를 두고 "판 번호 증가 + didOpen/didChange/didClose 전송" 을 한 임계구역에서 한다(`conn.wmu` 와 별개). 요청 본문(`Call`)은 임계구역 밖 |

### §3A-6 문서 수명 (L-5, 사용자 결정 L-5.1 ①·L-5.2 ①)
사실: didClose·didChangeWatchedFiles 0건, didClose 를 보낼 HTTP 종단 없음(`handlers_lsp.go` 는 status/install/definition/references/hover). 요청마다 전체 텍스트가 온다(D-3) — 일찍 닫아도 다음 요청이 didOpen 으로 다시 연다. gitwatch 는 바뀐 파일 목록을 모른다.

| 항목 | 확정 |
|------|------|
| close 종단 | `POST /api/lsp/close {root, path}`. path 가 절대경로가 아니면 400. 세션이 없거나 문서가 열려 있지 않으면 200 no-op. 열려 있으면 didClose 전송 + open 맵·마지막 전송 해시에서 제거 |
| 호출 자리 | `edDocDrop` 에서 문서 뷰가 0 이 되는 순간(§3A-0 X4). 브라우저 단위 |
| 다른 브라우저 | 서버 관례상 닫힌 문서에 빈 진단이 publish 되어 같은 파일을 연 다른 브라우저의 밑줄도 사라진다. 그 브라우저의 다음 LSP 요청(호버·정의·참조)이 didOpen 으로 복구한다. 이를 허용한다(동작 기록) |
| 재동기화 계기 | ① gitwatch 가 저장소 R 에 `git_changed` 를 방송할 때(제외 알림 포함) — R 아래 경로의 열린 문서 전부 ② `/api/file/write` 성공 — 그 경로가 열린 세션의 그 문서 |
| 재동기화 동작 | 문서마다 디스크를 읽는다. 없음·읽기 실패·`fileReadMaxBytes`(10MiB) 초과·유효하지 않은 UTF-8 이면 didClose. 그 밖에는 내용의 SHA-256 을 세션이 기억한 "마지막 전송 텍스트" 해시와 비교해 같으면 아무것도 하지 않고, 다르면 didChange(전체 텍스트 = 디스크 판, 판 번호 +1)를 §3A-5 임계구역에서 보낸다 |
| 비목표 | 열지 않은 파일의 변경 통보(`workspace/didChangeWatchedFiles` — 클라이언트 등록 영역이며 dynamicRegistration 미선언), HEAD 변경 시 세션 재시작, 변경 파일 계산 |
| 배선 | gitwatch → LSP 알림은 `cmd/dongminal/main.go` 에서 `OnDiagnostics`(:375-387)와 같은 방식으로 잇는다(도메인 계층은 서로를 모른다) |

동작 기록 — 이전: 한 번 연 문서는 세션이 끝날 때까지 열린 채 남아 디스크가 바뀌어도(브랜치 전환 포함) 서버가 옛 판으로 답했다 / 새: 마지막 뷰가 닫히면 닫고, 디스크가 바뀌면 열린 문서를 디스크 판으로 맞춘다 / 이유: #19 "한 번 호버한 파일이 영구 오버레이로 남는다".

### §3A-7 추적·인수 보강
- 스펙 산출물로 "감사 # ↔ 요구 ID ↔ 테스트 ID" 표를 싣는다(X8).
- §5 의 "크래시 복구" 테스트는 V-LSP-10(`docs/internal/EDITOR_LSP_SRS.md:501`)을 확장한다: 가짜 LSP 서버를 죽인 뒤 ① 세션이 맵에서 빠지고 프로세스가 `Wait` 로 회수됨 ② 다음 요청이 새 세션을 세움 ③ 기동 후 60s 안 연속 크래시에서 재시도 간격이 1s·2s·4s 로 늘어남(시계 주입).

## 4. 제약
- 새 외부 의존성 금지. `make gates lint typecheck unit test` 통과, `e2e/editor-lsp*.spec.ts`·`e2e/git-live-triggers.spec.ts`·`e2e/git-observe-revive.spec.ts` 등 관련 e2e 회귀 없음.
- 커밋 메시지·문서에 AI 서명 금지.

## 5. 인수 기준
- G-*, L-* 각각에 대해 실패하던 테스트가 구현 후 통과(결정적 — 가짜 LSP 서버·가짜 git 서비스·주입 시계 사용).
- 크래시 복구(§3A-7), 서버 경로 표 기동·변경 시 무효화(§3A-3), 서버발 요청 처리(§3A-5 표 전 행), 큐 넘침·쓰기 시한·진단 스냅샷(§3A-2), 회차 시한 < flight 시한 관측 성립(§3A-1 인수 ③) 테스트가 새로 존재한다.
