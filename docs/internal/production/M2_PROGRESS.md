# M2 진행 상황 — 브라우저 매개 공격 봉합 + 서버 하드닝

- 문서 상태: **진행 중** (2026-09-10 세션 중단 시점).
- 상위 문서: [`MILESTONE_KICKOFF.md`](./MILESTONE_KICKOFF.md) §M2
- 스펙: [`REQUEST_GATE_SRS.md`](../REQUEST_GATE_SRS.md) ·
  [`FILE_API_BOUNDARY_SRS.md`](../FILE_API_BOUNDARY_SRS.md)
- 다음 세션 착수 프롬프트: §5

---

## 1. 한 줄 요약

**P0 5건을 전부 닫았고 P1 8건을 끝냈다.** 남은 것은 P1 4건과 P2 18건이며, 그중
**Monaco 벤더링은 사용자 결정을 기다린다**(§4).

---

## 2. 완료 — 무엇이 어떻게 닫혔는가

### 2.1 P0 (5/5)

| 발견 | 무엇이었나 | 어떻게 닫았나 |
|---|---|---|
| `SEC-1` `GO-1` | `/ws` 의 `CheckOrigin` 이 **항상 true** — 임의 웹페이지가 셸을 얻었다 (CSWSH → RCE) | `requestGate` 가 mux **바깥**에서 판정하므로 업그레이드 전에 403. `CheckOrigin` 은 그 사실을 신뢰하는 자리로 남고 주석이 그 계약을 적는다 |
| `SEC-2` | 상태 변경 API 전체가 CSRF 무방비. `Content-Type: text/plain` 이면 프리플라이트가 없고, 응답을 못 읽어도 부작용은 일어난다 | `requestGate` 의 Content-Type·Sec-Fetch-Site·Origin 판정. **본문 없는 요청에도 JSON 을 요구한다** — `POST /api/tools?cwd=…` 처럼 쿼리만으로 셸을 만드는 종단이 있다 |
| `SEC-9` | Host 미검증 → DNS 리바인딩으로 위 방어를 우회 | Host 를 **GET 에서도** 대조, 불일치 421. 허용 집합은 `accessStore.self` 를 읽어 자동 유도 — 새 수집 코드 없음 |
| `TEST-1` | `/api/file/write` 단위 테스트 0 · 경로 경계 없음 (`~/.ssh/authorized_keys` 를 요청 하나로 덮을 수 있었다) | `fileGuard` 가 허용 루트와 대조. `/api/fs/*` 의 `fsResolveExisting`/`fsResolveTarget` 을 **재사용**한다. 검사 10건 |
| `FE-1` | 터미널 출력이 상태바 `innerHTML` 로 들어가 스크립트가 됐다 | 싱크에서 전량 이스케이프 + `scripts/check-html.sh` 게이트 + e2e 회귀 2건 |

**게이트 체인이 이렇게 됐다** (`server.go:Handler()`):

```
logging → accessGate(어느 기기) → requestGate(어느 출처) → authGate(누구 — M4) → recover → mux
```

`authGate` 는 **자리만 잡았다** — 지금은 통과시키고, 계약은 `REQUEST_GATE_SRS` §3.6 에 있다.

### 2.2 P1 (8건)

| 발견 | 조치 |
|---|---|
| `GO-2` `SEC-4` | `ReadHeaderTimeout: 10s` · `IdleTimeout: 120s`. **`ReadTimeout`·`WriteTimeout` 은 두지 않는다** — SSE·WS·30분 대기 종단이 있다. 종료는 `Shutdown(2s)` → `Close()` |
| `GO-3` `SEC-5` | `internal/webserver/httpreq` 신설. `io.ReadAll(r.Body)` **10곳 → 0곳**, 스트림 디코더 2개도 경유. 기본 1MiB·워크스페이스 8MiB. 업로드 512MiB·LSP·WS 의 기존 상한은 **우회하지 않는다** |
| `SEC-21` | `PUT /api/settings` 가 `json.Valid` 를 통과해야 쓴다 — 종전에는 받은 바이트를 그대로 파일에 썼다 |
| `SEC-6` | `ToolCap = 256`(429) · `SubCap = 64`. 도구 상한은 **잠금 안에서·기동 전에** 센다 |
| `SEC-8` | 홈 0700 · 소켓 0600(`Chmod`) · 소켓 디렉터리 0700 · pid 0600 · 로그 0600. 기본 로그가 `/tmp/dongminal.log` → `$DONGMINAL_HOME/server.log` |
| `SEC-3` 완화 | `--expose` + ACL 꺼짐이면 **기동 거부**. 되돌리는 길은 `--insecure-no-acl` 하나. 사유가 셋으로 갈린다(없다/꺼졌다/항목이 없다) |
| `UX-1` | `_confirmClose` 를 `GitConfirm` 규약으로 수렴 — 초기 포커스 취소 · `Enter`≠실행 · `textContent`. DOM 조립으로 재작성 |
| `SEC-11` 일부 | 정적 응답에 CSP · `X-Frame-Options` · `X-Content-Type-Options` · `Referrer-Policy` |

### 2.3 새로 선 게이트

| 게이트 | 무엇을 막나 |
|---|---|
| `scripts/check-html.sh` | HTML 템플릿의 `${…}` 가 `escHtml(`/`e(` 로 시작하지 않으면 실패. **예외 없음** — 마크업을 넣어야 하는 자리는 DOM 으로 세운다 |

`make gates` 와 `verify.yml` 의 `gates` 잡에 함께 걸렸다.

### 2.4 부수적으로 드러난 것

- **프론트의 상태 변경 `fetch` 6곳이 Content-Type 을 안 밝히고 있었다.** 게이트를 켜자
  앱이 부팅되지 않아서 드러났다. 그중 `POST /api/tools?cols=…`(셸 생성)·
  `DELETE /api/tools/{id}` 가 있었다 — 정확히 게이트가 막아야 할 모양이다.
- `internal/webserver/httpapi` 의 테스트 105건이 `httptest.NewRequest` 의 기본 Host
  (`example.com`)로 요청을 만들고 있었다. `apiTestRequest` 헬퍼로 일괄 정리했다.

---

## 3. 남은 것

### 3.1 P1 (4건)

| 발견 | 내용 | 규모 |
|---|---|---|
| `FE-6` + `B7` | **Monaco 벤더링** — §4 의 결정을 받은 뒤 | M |
| `GO-11` `SEC-17` | 오류 분류·문구 노출. `http.Error(w, err.Error(), …)` 8곳, `strings.Contains(err.Error(), …)` 3곳 (§3.3) | S |
| `SEC-7` 잔여 | `/api/upload`·`/api/download` 의 경계 — `FILE_API_BOUNDARY_SRS` §5 비목표 2 가 M8 로 넘겼다. **그때까지 게이트가 호출을 덮는다** | — |
| `FE-8` | `web/js/core/api.js` 통합 (`fetch` 51곳). M4 인증의 선행 권장 | M |

### 3.2 P2·기능축 (미착수)

`SEC-10`·`SEC-12`~`SEC-16`·`SEC-18`~`SEC-20` · `GO-23`·`GO-38`·`GO-39`(B5) ·
`FE-15`~`FE-17` · `FBE-08`(submodule `core.Env()`+`ctx`) · `FUI-06`(편집기 크기 상한) ·
`09` 비목표 3(샌드박스 cpu·memory·pids 상한).

### 3.3 오류 분류 — 조사해 둔 것

착수하면 바로 쓸 수 있게 실측해 두었다.

```
http.Error(w, err.Error(), …)   8곳
  access.go:478 · handlers_api.go:283,347,448,466,470 · commands.go:138,171

strings.Contains(err.Error(), …)  분류에 쓰는 3곳
  toolhub/tool.go:352          "input/output error"  → errors.Is(err, syscall.EIO)
  handlers_ws.go:234           "use of closed …"     → errors.Is(err, net.ErrClosed)
  handlers_files.go:117        "request body too large" → 이미 errors.As 가 있고 폴백만 남았다

  query/blame.go:82 은 **git 의 stderr 문자열**을 본다 — Go 오류 분류가 아니므로
  이 항목이 아니다. 건드리지 마라.
```

### 3.4 DoD 중 아직 못 채운 항목

- CSP `script-src` 에 외부 호스트가 **하나 남아 있다** (`https://cdn.jsdelivr.net`).
  `TestStatic_CSPExternalHostsAreKnown` 이 그 하나를 알고 있고, 벤더링이 끝나면
  그 검사가 먼저 실패한다 — 그것이 이 줄을 지울 때가 됐다는 신호다.
- `wait` 동시 수 상한 · diag 스냅샷의 임계 경고.
- 헤드리스 명령 로그를 전문 대신 길이·해시로.
- `worktree.execGit`·`submodule` 실행기의 `core.Env()` 공유 (B5).
- `dongminal verify` 에 게이트 항목 추가.
- **전체 e2e 미검증** — §6.

---

## 4. 사용자 결정 대기 — Monaco 벤더링

`web/js/ui/file-editor.js:5` 가 편집기를 런타임에 `cdn.jsdelivr.net` 에서 받는다.
나머지 자산은 전부 `go:embed` 로 바이너리 안에 있고 **편집기만 인터넷이 필요하다.**

| | 벤더링한다 | 지금대로 둔다 |
|---|---|---|
| CSP | `script-src 'self'` — 외부 호스트 0 | `cdn.jsdelivr.net` 을 영구 개방 |
| 폐쇄망·Tailscale 전용 | 편집기·Diff·LSP 뷰가 선다 | 통째로 서지 않는다 |
| 공급망 | 없음 | 서드파티 CDN 이 곧 스크립트 공급망 |
| 바이너리 | **16MB → 약 21MB** (min/vs 약 5MB) | 그대로 |
| 배포 | 5대상 합계가 약 25MB 늘어난다 | 그대로 |

`README` 의 첫 문장이 "의존이 없는 단일 파일" 이므로 크기는 제품의 성격에 닿는다.
**그래서 임의로 정하지 않았다.**

---

## 5. 다음 세션 착수 프롬프트

§6 에 그대로 붙여넣을 수 있는 형태로 있다.

---

## 6. 이 세션이 남긴 미검증 — e2e

### 6.1 통과한 것

Go 전량(`-race`) · `make gates`(이음매·타이머·git쓰기·크로스·vendor·**html**) ·
`golangci-lint` 0건 · `tsc`(e2e + `@ts-check` 6파일) · `eslint` 0건 ·
`node:test` 46건 · `statusbar-xss.spec.ts` 4건.

### 6.2 전체 e2e 는 **끝까지 보지 못했다**

세션을 접을 때 실행 중이었고 중단했다. 그 시점까지 **실패로 기록된 스펙이 20개**다.
아래는 그 목록이고, **다음 세션의 첫 일이 이것의 분류**다.

**확정 — 게이트 때문이고 이미 고쳤다 (워킹트리에 있다)**

```
focus-invariant  "API method routing (S3)" 넷
  POST /api/state → 404 를 기대했는데 415
  DELETE /api/workspace → 같음
  GET /api/ping returns ok regardless of method → POST/PUT/DELETE 가 415
```

게이트가 라우팅 **앞**에 서므로 Content-Type 이 없으면 404 에 닿기 전에 415 다.
검사에 헤더를 달았다. **게이트가 옳다** — 본문 없는 상태 변경에도 JSON 을 요구하는
것이 `POST /api/tools?cwd=…` 를 막는 방법이다.

**미분류 — 다음 세션이 판정할 것 (16)**

```
bg-kill            마지막 도구 종료      "Expected: 1, Received: 6"  ← 도구 수
reconnect-storm    4건 (OP-EXIT·백오프·종료 오버레이)
git-history        2건 (DOM 행 수·필터)
mobile-kb-gate · mobile-keybar · repo-tab      3건
editor-lsp-nav · editor-ops · git-window       3건
layout · settings · sidebar-collapse           3건
focus-invariant    "Pane size MaxTerminalDim falls back"
```

**이 목록을 그대로 믿지 마라.** 두 가지 오염이 있다.

1. **자원 경합.** 같은 기계에서 Go 테스트와 e2e 를 겹쳐 돌렸고, PTY 가 218개까지
   올라갔다(macOS `kern.tty.ptmx_max` 기본 511). 그 상태에서 daemon 통합 테스트가
   **HEAD 에서도** 실패했다 — 즉 이 목록에는 내 변경과 무관한 실패가 섞여 있다.
   `bg-kill` 의 "도구가 1개여야 하는데 6개" 가 그 냄새다.
2. **중단.** 끝까지 돌지 않았으므로 이 20개가 전부가 아니다.

**분류 방법**: 깨끗한 기계에서 `npx playwright test` 를 **단독으로** 한 번 돌린다.
남는 실패만 진짜다. 그중 415·403 이 보이면 게이트/경계가 맞는지 스펙으로 먼저
판정하고, 맞으면 **호출부를 고친다** — 게이트를 느슨하게 만들지 않는다.

---

## 7. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-10 | 초안. P0 5건·P1 8건 완료 시점에서 세션 중단. |
