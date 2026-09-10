# SRS: 요청 게이트 — 브라우저 매개 공격을 mux 바깥에서 닫는다 — IEEE 29148

- 문서 상태: **초안**. 로드맵 M2 (`docs/internal/production/MILESTONE_KICKOFF.md` §M2).
- 근거 감사: `04-secops.md` §1.2·§2(P0-1·P0-2)·§3(P1-2·P1-3·P1-7)·§4.1 · `01-go-arch.md` P0 ·
  `07-production-gap.md` §1 "도입 시 영향 범위".
- 개정 대상: `ACCESS_ALLOWLIST_SRS.md` §5 비목표 3(Host 헤더 검증) — §6 참조.

---

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

**"로컬 전용" 은 네트워크 경계일 뿐이고, 이 서버의 실제 공격면은 브라우저 동일 출처
정책의 틈이다.** 아래 두 경로는 기본 설정(`127.0.0.1:58146`)에서 성립한다.

| | 지금 |
|---|---|
| `ws://127.0.0.1:58146/ws` | `CheckOrigin` 이 **항상 true** (`toolhub/conn.go:37`). `tool` 을 생략하면 서버가 로그인 셸을 하나 만들고(`handlers_ws.go:81-92`), 이후 프레임이 그대로 PTY 에 쓰인다(`:243`) |
| `POST /api/tools/headless` | `Content-Type`·`Origin`·`Sec-Fetch-Site` 를 아무도 보지 않는다. JSON 한 줄이 곧 `sh -c <cmdline>` 이다 (`manager.go:416`) |

전제는 하나다 — **사용자가 dongminal 을 띄운 채 임의의 웹페이지를 연다.** 포트가
고정값이라 추측할 필요도 없다. 결과는 사용자 권한의 원격 코드 실행이고, ACL 은 이것을
막지 못한다: 출발지가 사용자 자신의 기기이기 때문이다.

`Content-Type: text/plain` 인 POST 는 브라우저가 "단순 요청" 으로 보내 프리플라이트가
없다. 서버는 Content-Type 을 보지 않고 본문을 JSON 으로 파싱한다. **응답을 못 읽어도
부작용은 이미 일어난다.**

**mux 바깥 한 겹에서 닫는다.** 핸들러마다 뿌리면 새 종단에서 빠진다 —
`ACCESS_ALLOWLIST_SRS` §2.1 이 같은 논리로 `accessGate` 를 그 자리에 세웠다.

### 1.2 범위 (Scope)

**포함**

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **G** | 요청 게이트: Origin · Host · Sec-Fetch-Site · Content-Type 판정 | **HIGH** |
| **W** | `/ws` 가 같은 판정 함수를 쓴다 (업그레이드 **이전**에) | **HIGH** |
| **J** | 공통 `readJSON` — 크기 상한과 Content-Type 을 한 자리에서 | MEDIUM |
| **T** | `http.Server` 타임아웃과 종료 경로 | LOW |
| **E** | 노출 모드 게이트 (`--expose` + ACL 꺼짐) · ACL fail-closed | MEDIUM |
| **A** | `authGate` **자리 예약** — 계약만 정하고 채우지 않는다 | LOW |

**미포함 (이 SRS 가 하지 않는 것)** — §5 에 근거와 함께.

### 1.3 정의 (Definitions)

| 용어 | 뜻 |
|---|---|
| **게이트** | mux 바깥에서 요청 하나를 통과·거절시키는 미들웨어 한 겹 |
| **브라우저 매개 요청** | 사용자의 브라우저가 다른 출처의 페이지 지시로 보낸 요청 |
| **비브라우저 클라이언트** | `dmctl`·`curl`·CI — `Origin` 을 싣지 않는다 |
| **상태 변경 메서드** | `POST`·`PUT`·`PATCH`·`DELETE` |
| **자기 주소 집합** | 이 서버가 도달 가능한 주소들. `accessStore.self` 가 이미 수집 중 |

### 1.4 참조 (References)

- `ACCESS_ALLOWLIST_SRS.md` — 같은 게이트 계층. 설계·비목표·`accessStore`.
- `docs/internal/architecture.md:141-176` — 오류 본문 방언 4종이 공개 계약이라는 결정.
- `docs/internal/production/13-tls-tailscale.md` §7 — 허용목록 판정 함수의 요구 10건.
- `CONNECTIVITY_RESILIENCE_SRS` — 미스 홀드·패닉 그물. 이 SRS 가 건드리지 않는다.

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 요청 헤더를 읽는 곳이 한 곳뿐이다

전수 grep 결과 `handlers_api.go:327` 의 `If-Match` 하나다. `Origin`·`Host`·
`Sec-Fetch-*`·`Content-Type` 을 읽는 코드가 **없다.** `Access-Control-*` 를 쓰는
곳도 없다 — CORS 로 응답을 *읽는* 것은 막히지만 *쓰기 부작용*은 막히지 않는다.

### 2.2 체인은 이미 옳은 모양이다

```go
loggingMiddlewareFor(s, accessGate(s.Access, recoverMiddleware(mux)))   // server.go:216
```

게이트가 로깅 **안쪽**(거절이 접근 로그에 남는다), recover **바깥쪽**(mux 바깥이라야
정적 자산·`/api/*`·`/ws` 가 한 겹에 덮인다). 이 SRS 는 그 자리에 한 겹을 **더한다.**

### 2.3 자기 주소는 이미 수집돼 있다

`accessStore.self`(`access.go:73`)가 `localInterfaceAddrs()` 로 인터페이스 주소를 들고,
`refresh()` 가 호스트명 해석까지 캐시한다. **새 수집 코드가 필요 없다** — 허용 판정이
이 값을 읽으면 `--expose 0.0.0.0` 에서 어느 로컬 IP 로 접속하든 자동으로 통과한다.

### 2.4 `io.ReadAll(r.Body)` 가 10곳이고 상한이 없다

`handlers_fs.go:93` · `handlers_files.go:363` · `handlers_settings.go:91` ·
`commands.go:116` · `gitapi/handlers_git.go:247,353` · `gitapi/handlers_git_write.go:339` ·
`access.go:424` · `handlers_api.go:326,452`. `decodeJSONBody`(`handlers_toolio.go:176`)도
무제한 스트림 디코드다.

상한이 **있는** 곳: 업로드 512MiB `MaxBytesReader`(`handlers_files.go:100,111`) ·
LSP(`handlers_lsp.go:57,82,121`) · WS 프레임 1MiB(`handlers_ws.go:25`).
**이 셋은 실제 사고에서 배운 방어다 — 공통 디코더가 우회하지 않는다.**

`apiSettingsPut`(`handlers_settings.go:90-102`)은 받은 바이트를 **JSON 인지도 보지 않고**
`settings.json` 에 쓴다.

### 2.5 `http.Server` 에 타임아웃이 하나도 없다

`server.go:220` — `&http.Server{Addr: addr, Handler: s.Handler()}`.
전수 grep 으로 `ReadTimeout`/`WriteTimeout`/`IdleTimeout`/`ReadHeaderTimeout` 이 저장소
어디에도 없다.

**전역 `WriteTimeout`·`ReadTimeout` 을 둘 수 없다.** SSE(`commands.go`)·WebSocket·
대기 종단(`handlers_status.go:31` 최대 30분)이 살아 있어야 한다.

### 2.6 `Origin` 부재를 거부하면 안 된다

`dmctl` 은 `helper/runtimebin` 의 HTTP 클라이언트를 지나고 호출부가 17곳/9파일이다.
전부 `Origin` 을 싣지 않는다. 거부하면 에이전트 오케스트레이션이 통째로 멎는다.

### 2.7 제약 (Constraints)

- 새 런타임 의존을 넣지 않는다.
- **오류 본문 방언 4종을 통일하지 않는다** — `architecture.md:141-176` 이 공개 계약으로
  문서화하고 "통일하지 않는다(파괴적 변경)" 를 결정으로 적었다.
- `accessGate` 의 설계를 바꾸지 않는다 — `RemoteAddr` 만 신뢰하고 프록시 헤더를 무시하며
  403 본문에 목록을 싣지 않는 것은 양호 판정이다. 이 게이트는 **직렬 추가**다.
- 기본값(바인드 `127.0.0.1`)을 바꾸지 않는다. 노출 게이트는 노출 시 조건만 더한다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 G — 요청 게이트

**FR-RQG-1** 체인은 `logging → accessGate(기기) → requestGate(출처) → authGate(빈 자리)
→ recover → mux` 가 된다. `requestGate` 는 mux 바깥의 한 겹이며 판정 함수는 **한 곳**에
산다 (`httpapi/reqgate.go`).

**FR-RQG-2 (Host)** `Host` 헤더가 있으면 **항상** 허용 목록과 대조한다. 메서드와 무관하다 —
DNS 리바인딩 방어의 본체이며, 그 공격은 `GET` 으로 응답을 읽는 것이 목적이다.
불일치는 **421 Misdirected Request**.

**FR-RQG-3 (Origin)** `Origin` 이 있으면 그 호스트를 같은 목록과 대조한다. 불일치는 403.
**`Origin` 부재는 거부가 아니다** (§2.6).

**FR-RQG-4 (Sec-Fetch-Site)** 상태 변경 메서드에서 `Sec-Fetch-Site` 가 있고 그 값이
`same-origin`·`same-site`·`none` 중 하나가 아니면 403. 헤더가 없으면 판정하지 않는다
(비브라우저 클라이언트와 구형 브라우저).

**FR-RQG-5 (Content-Type)** 상태 변경 메서드는 `application/json` 또는
`multipart/form-data`(업로드)를 요구한다. 그 밖은 **415 Unsupported Media Type**.
이것이 프리플라이트를 강제해 §1.1 의 "단순 요청" 우회를 닫는다.

**FR-RQG-6 (허용 목록의 구성)** 판정 대상 호스트 집합은 다음의 합집합이다.
새 수집 코드를 만들지 않는다 (§2.3).

1. `localhost` · `127.0.0.1` · `::1`
2. 실제 바인드 주소
3. `accessStore.self` — 이 기계의 인터페이스 주소
4. ACL 의 호스트명 항목
5. `--allowed-host` 로 명시 추가한 것 (와일드카드 접미사 `*.ts.net` 문법 지원)

**FR-RQG-7 (정규화)** 판정은 **스킴을 하드코딩하지 않는다** — 평문과 TLS 둘 다 유효한
배치가 있다. 포트 유무를 정규화한다: `net.SplitHostPort` 실패는 "포트 없음" 으로 읽는다.

**FR-RQG-8 (예외 경로)** 다음은 게이트를 지나지 않는다. 목록은 이 문서가 진실이다.

| 경로 | 왜 |
|---|---|
| `/` 와 정적 자산 | 브라우저가 페이지를 받아야 나머지가 시작된다. 부작용이 없다 |
| `GET /api/ping` | 기동 대기(`waitReady`)·헬스체크가 쓴다. 부작용이 없다 |

**`/api/ping` 은 `GET` 만 예외다.** 경로로만 예외를 두면 새 메서드가 붙을 때 구멍이 된다.

**FR-RQG-9 (거절의 모양)** 거절은 로그에 남고(출발지·메서드·경로·사유), 본문에 허용
목록을 싣지 않는다 (`FR-ACL-8` 승계). 상태 코드는 사유를 가른다 — Host 421 · Origin/
Sec-Fetch 403 · Content-Type 415.

**FR-RQG-10 (`X-Forwarded-*` 를 읽지 않는다)** `FR-ACL-6` 승계. 리버스 프록시 미지원이
확정 결정이므로 신뢰 옵트인 설계 자체가 범위 밖이다.

### 3.2 묶음 W — WebSocket

**FR-RQG-11** `toolhub.Upgrader.CheckOrigin` 이 항상 true 를 돌려주는 것을 없앤다.
**판정은 업그레이드 이전에 미들웨어에서 끝나 있다** — `/ws` 는 `requestGate` 를 이미
지나므로(mux 바깥), `CheckOrigin` 은 그 사실을 신뢰하는 자리다.

두 곳에서 판정하지 않는다. 두 벌이면 한쪽만 고쳐진다.

**FR-RQG-12** `/ws` 에 `Origin: https://evil.example` 로 오면 업그레이드 **전에** 403 이다.
`Origin` 없는 업그레이드(`dmctl`)는 통과한다.

**FR-RQG-13** WebSocket 업그레이드는 `GET` 이므로 FR-RQG-5(Content-Type)의 대상이 아니다.
막는 것은 FR-RQG-2·3 이다.

### 3.3 묶음 J — 본문 디코더

**FR-RQG-14** 공통 `readJSON(w, r, limit, into) error` 하나를 만들고
`io.ReadAll(r.Body)` 10곳과 `decodeJSONBody`·`fsDecode` 가 전부 경유한다.
그 안에서 `http.MaxBytesReader` 와 크기 초과 판정(413)을 함께 한다.

**FR-RQG-15** 기본 상한은 **1MiB** 이고 종단별로 올릴 수 있다(`workspace` 는 더 크다).
**업로드·LSP·WS 의 기존 상한을 우회하지 않는다** (§2.4) — 그 경로는 `readJSON` 을
쓰지 않는다.

**FR-RQG-16** `settings.json` 은 저장 전에 `json.Valid` 를 통과해야 한다. 실패는 400.

**FR-RQG-17** 크기 초과는 `*http.MaxBytesError` 를 `errors.Is`/`errors.As` 로 가른다.
`strings.Contains(err.Error(), …)` 를 쓰지 않는다.

### 3.4 묶음 T — 서버 수명

**FR-RQG-18** `http.Server` 에 `ReadHeaderTimeout: 10s` · `IdleTimeout: 120s`.
**`ReadTimeout`·`WriteTimeout` 은 두지 않는다** (§2.5) — 필요하면 핸들러가
`http.ResponseController` 로 자기 마감을 세운다.

**FR-RQG-19** 종료는 `Shutdown(ctx)` 뒤 마감이 지나면 `Close()`.

### 3.5 묶음 E — 노출 모드

**FR-RQG-20** `--expose`/`DONGMINAL_HOST` 로 노출하면서 ACL 이 꺼져 있으면 **기동을
거부한다.** 되돌리는 길은 명시 플래그 하나(`--insecure-no-acl`)이며 그 이름이 곧 경고다.

근거: §0-1-1 — 원격 접속이 이 제품의 기본 사용 형태다. "기본이 안전하니 노출 경로의
결함은 낮은 등급" 이라는 추론을 하지 않는다.

**FR-RQG-21** 노출 모드에서 `access.json` 이 깨지면 **fail-closed**(loopback 만)다.
로컬 모드에서는 종전대로 fail-open 이다(`FR-ACL-2` 의 의도를 로컬에 한정한다).

### 3.6 묶음 A — `authGate` 자리 예약

**FR-RQG-22** 체인에 `authGate` 자리를 만든다. **M2 에서는 통과만 시킨다.**
계약을 여기 적어 M4 가 그것을 채운다:

| 항목 | 계약 |
|---|---|
| 자리 | `requestGate` **안쪽**, `recover` **바깥쪽** |
| 예외 경로 | `/` · 정적 자산 · `/login` · `GET /api/ping` |
| loopback 예외 | **없다.** `FR-ACL-5`(loopback 무조건 통과)를 인증에 적용하지 않는다 — 브라우저 매개 공격이 정확히 loopback 출발지다 |
| 판정 함수 위치 | `httpapi/auth.go` — `accessStore` 와 같은 모양(파일 로드·원자 저장·검증·`view()`) |
| 실패 응답 | 401. 본문에 사유를 싣지 않는다 |

**FR-RQG-23** 자리만 예약하고 **판정을 넣지 않는다.** 빈 게이트가 체인에 있는 것이
M4 가 미들웨어 자리를 다시 여는 것보다 싸다.

### 3.7 비기능 요구 (NFR)

**NFR-RQG-1** 게이트 판정은 할당 없이 헤더 몇 개를 읽는 일이다. 요청당 DNS 조회를 하지
않는다 — 해석은 `accessStore.refresh()` 가 요청 경로 밖에서 한다(`FR-ACL` 승계).

**NFR-RQG-2** `-race` 에서 통과한다. 허용 목록은 `accessStore.mu` 아래에서만 읽는다.

**NFR-RQG-3** 게이트가 nil 인 구성(시험·부분 배선)에서도 서버가 선다.

---

## 4. 검증 (Verification)

### 4.1 게이트 (Go, `httpapi/reqgate_test.go`)

| ID | 확인 |
|---|---|
| TC-RQG-1 | `Origin: https://evil.example` 로 `POST /api/tools/headless` → 403 |
| TC-RQG-2 | `Origin` 없는 같은 요청 → 통과 (비브라우저) |
| TC-RQG-3 | `Content-Type: text/plain` → 415 |
| TC-RQG-4 | `Content-Type: application/json` + same-origin → 통과 |
| TC-RQG-5 | `Sec-Fetch-Site: cross-site` → 403 |
| TC-RQG-6 | `Host: evil.example` → 421 (**GET 에서도**) |
| TC-RQG-7 | `Host: 127.0.0.1:58146` · `localhost` · 바인드 IP → 통과 |
| TC-RQG-8 | 포트 유무가 판정을 바꾸지 않는다 |
| TC-RQG-9 | `X-Forwarded-Host: ok.example` 는 판정을 바꾸지 않는다 |
| TC-RQG-10 | `GET /api/ping`·`/`·정적 자산은 게이트를 지나지 않는다 |
| TC-RQG-11 | `POST /api/ping` 은 **지난다** (메서드까지 본다) |
| TC-RQG-12 | 거절이 로그에 남고 본문에 목록이 없다 |
| TC-RQG-13 | `--allowed-host '*.ts.net'` 이 접미사로 통과시킨다 |

### 4.2 WebSocket (`handlers_ws_test.go`)

| ID | 확인 |
|---|---|
| TC-RQG-14 | `Origin: https://evil.example` 로 `/ws` → 403, **업그레이드가 일어나지 않는다** |
| TC-RQG-15 | `Origin` 없는 업그레이드 → 101 |
| TC-RQG-16 | `Origin` 이 자기 주소면 → 101 |

### 4.3 디코더·수명

| ID | 확인 |
|---|---|
| TC-RQG-17 | `grep -rn 'io.ReadAll(r.Body)' internal/` 이 0건 |
| TC-RQG-18 | 1MiB 초과 본문 → 413 |
| TC-RQG-19 | 깨진 JSON 을 `PUT /api/settings` → 400, 파일이 바뀌지 않는다 |
| TC-RQG-20 | 업로드 512MiB 상한이 그대로다 (회귀) |
| TC-RQG-21 | `http.Server` 에 `ReadHeaderTimeout`·`IdleTimeout` 이 있다 |

### 4.4 노출 모드

| ID | 확인 |
|---|---|
| TC-RQG-22 | `--expose` + ACL 꺼짐 → 기동 거부, 사유가 출력에 있다 |
| TC-RQG-23 | `--expose --insecure-no-acl` → 기동, 경고 출력 |
| TC-RQG-24 | 노출 모드에서 `access.json` 손상 → loopback 만 통과 |
| TC-RQG-25 | 로컬 모드에서 손상 → 종전대로 fail-open |

### 4.5 브라우저 (e2e)

| ID | 확인 |
|---|---|
| TC-RQG-26 | 정상 사용 경로가 전부 그대로 돈다 — 게이트가 자기 화면을 막지 않는다 |

### 4.6 보존 확인 (회귀)

`go vet ./...` 무경고 · `scripts/check-gitwrite.sh` 통과 · 업로드/SSE/WS 패닉 그물 테스트
통과 · `dmctl` 경로 17곳이 그대로 동작.

---

## 5. 비목표 (Non-goals)

1. **인증.** 이 SRS 는 `authGate` 의 **자리와 계약**만 정한다. 세션·토큰·로그인 화면은
   M4 다. **그러므로 `SEC-3`(무인증 LAN 노출)은 이 마일스톤 뒤에도 열려 있다** — 운영
   안내를 문서에 임시로 둔다(FR-RQG-20 이 그 절반을 강제한다).
2. **TLS.** 확정 결정 8(축소안)에 따라 M4 에서 `--tls-cert/--tls-key` 두 플래그만.
3. **오류 본문 방언 통일.** `architecture.md:141-176` 이 공개 계약으로 못박았다.
4. **`accessGate` 재설계.** 양호 판정이며 직렬로 남는다.
5. **`/api/fs/*` 경로 가드 변경.** 양호 판정이다. 파일 경계는 별도 SRS
   (`FILE_API_BOUNDARY_SRS`)가 `/api/file/*` 에만 적용한다.
6. **리버스 프록시 지원.** 확정 결정 8 이 미지원을 선언했다.
7. **속도 제한·차단 이력.** `FR-ACL` 의 비목표 5 를 그대로 승계한다.
8. **CSP·보안 헤더·Monaco 벤더링.** 같은 마일스톤이지만 정적 응답의 일이고, 이 문서는
   요청 게이트의 일이다. 구현은 M2 안에서 함께 한다.

---

## 6. 기존 문서 개정

**`ACCESS_ALLOWLIST_SRS.md` §5 비목표 3** — "Host 헤더 검증. …DNS rebinding 방어가
필요해지면 별도 SRS 로 다룬다." 이 SRS 가 그 별도 SRS 다. 해당 항목에 개정 표시를 단다.

비목표 1(인증)·2(TLS)는 **그대로 남는다** — M4 가 개정한다.

---

## 7. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-10 | 초안. M2 착수. |
