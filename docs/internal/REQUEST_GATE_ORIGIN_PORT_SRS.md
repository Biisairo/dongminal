# SRS: 요청 게이트 — `Origin` 의 포트까지 본다 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 전건 (FR-ROP-1~9) — 구현 세션에 인계됨. 조사와 결정은 `BROWSER_TAB_INVESTIGATION.md` §6.

| 항목 | 값 |
|---|---|
| 문서 | REQUEST_GATE_ORIGIN_PORT_SRS |
| 개정 대상 | `REQUEST_GATE_SRS` FR-RQG-3 · FR-RQG-7 · TC-RQG-30 |
| 후속 | `BROWSER_TAB_SRS` (0단계 — 이 문서가 닫혀야 브라우저 탭이 착수한다) |
| FR 접두 | FR-ROP |

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`requestGate` 의 `Origin` 판정은 **호스트만** 본다. 포트를 버리므로 **같은 기계의 다른
포트**에서 서빙되는 페이지가 이 서버의 출처로 인정된다. `/ws` 업그레이드는 `GET` 이라
Sec-Fetch-Site 판정(FR-RQG-4)도 받지 않는다. 그리고 `tool` 없이 붙은 `/ws` 는 로그인
셸을 하나 만든다(`handlers_ws.go:81-92`).

```
http://localhost:3000 의 페이지
  └─ new WebSocket('ws://localhost:58146/ws')     Origin: http://localhost:3000
       └─ normalizeHost → "localhost" → 허용       ← 포트가 버려진다
            └─ 101 → Create(로그인 셸) → 프레임이 PTY 로 간다
```

전제는 **이 기계에서 다른 포트로 서빙되는 페이지를 브라우저로 여는 것** 하나다.
오염된 npm 의존성을 가진 dev 서버, `python -m http.server` 로 연 HTML, Jupyter 가 모두
해당한다. `--expose` 에서는 이 기계 IP 의 어느 포트든 해당한다. 결과는 사용자 권한의
원격 코드 실행이며, `SECURITY.md` §1 이 `requestGate` 로 막는다고 약속한 공격
(*"다른 웹페이지가 여러분의 터미널에 명령을 보내는 것"*)이다.

**실측** (2026-09-26, 실행 중 서버, 존재하지 않는 tool id 로 핸드셰이크만):

```
Origin: http://localhost:3000   → 101
Origin: https://evil.example    → 403
```

후속 `BROWSER_TAB_SRS` 는 서버에서 도는 브라우저로 **dev 서버(`localhost:<포트>`)를 여는
것이 주 용도**다. 이 결함을 주 사용 경로 위에 올리므로 먼저 닫는다.

### 1.2 범위 (Scope)

**포함**

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **O** | `Origin` 이 있으면 그 **authority(호스트+포트)** 가 요청의 `Host` 와 같아야 한다 | **HIGH** (결함 수정) |
| **D** | 문서 — `SECURITY.md` §6 기록, `REQUEST_GATE_SRS` 개정 표시 | LOW |

**미포함** — §5.

### 1.3 정의 (Definitions)

| 용어 | 뜻 |
|---|---|
| **authority** | `(호스트, 포트 문자열)` 한 쌍. 호스트는 FR-RQG-7 의 정규화(소문자·대괄호 제거·후행 점 제거)를 지난 값, 포트는 **적힌 그대로의 문자열이며 없으면 빈 문자열** |
| **Origin authority** | `Origin` 헤더를 URL 로 파싱한 `u.Hostname()` 과 `u.Port()` |
| **Host authority** | `r.Host` 를 `net.SplitHostPort` 로 가른 값. 가르기 실패는 "포트 없음" (FR-RQG-7) |

### 1.4 참조 (References)

- `internal/webserver/httpapi/reqgate.go:59-83`(`normalizeHost`) · `:174-229`(`requestGate`)
- `internal/webserver/httpapi/handlers_ws.go:81-92` — `tool` 생략 시 셸 생성
- `internal/webserver/httpapi/reqgate_test.go` · `handlers_ws_test.go:532-556`
- `docs/internal/production/13-tls-tailscale.md` §3 — `tailscale serve` 는 `Host` 를 원본
  보존한다(`r.Out.Host = r.In.Host`)
- `SECURITY.md` §1 · §2-④ · §4-4 · §6

---

## 2. 현재 상태 (Identified Issue)

### 2.1 판정 코드

```go
if o := r.Header.Get("Origin"); o != "" && !allow.ok(normalizeHost(o)) {   // reqgate.go:200
```

`normalizeHost` 는 `url.Parse` 뒤 `net.SplitHostPort` 로 **포트를 버린다**(`:79-81`).
FR-RQG-7 의 문장 *"포트 유무가 판정을 바꾸면 안 된다"* 는 **`Host` 를 허용 집합과 대조할 때**
옳다 — `localhost` 와 `localhost:58146` 은 같은 이 기계다. 그것이 `Origin` 에도 같이
적용되면서 **"이 서버의 출처인가" 가 "이 기계의 어떤 출처인가" 로 넓어졌다.**

### 2.2 왜 다른 판정이 막지 못하는가

| 판정 | 이 공격에서 |
|---|---|
| ① Host | `localhost:58146` — 정상 |
| ② Origin | 호스트 `localhost` — 허용 (**결함**) |
| ③ Sec-Fetch-Site | `/ws` 는 `GET` → 판정 대상 아님. `POST` 라도 `localhost:3000`→`:58146` 은 `same-site`(site 는 포트를 보지 않는다)라 통과 |
| ④ Content-Type | `POST` 는 JSON 이면 프리플라이트가 걸려 막힌다. `multipart/form-data` 는 단순 요청이다. WS 는 해당 없음 |
| gorilla `CheckOrigin` | 항상 `true` — 판정을 게이트에 맡긴다(FR-RQG-11). 설계대로다 |

### 2.3 정상 브라우저 요청의 모양

dongminal 화면이 부르는 요청은 전부 **자기 출처**다. 브라우저는 그때 `Origin` 을 요청
URL 의 출처로, `Host` 를 같은 URL 의 authority 로 싣는다. 기본 포트는 둘 다 생략한다.
그러므로 정상 경로에서 **Origin authority 와 Host authority 는 언제나 같다.** 배치별 확인:

| 배치 | 브라우저 주소 | `Host` | `Origin` |
|---|---|---|---|
| 로컬 | `http://localhost:58146` | `localhost:58146` | `http://localhost:58146` |
| `--expose` LAN | `http://192.168.1.5:58146` | `192.168.1.5:58146` | `http://192.168.1.5:58146` |
| 별명 (FR-ACL-31) | `http://macmini-office:58146` | `macmini-office:58146` | `http://macmini-office:58146` |
| `ssh -L 8080:127.0.0.1:58146` | `http://localhost:8080` | `localhost:8080` | `http://localhost:8080` |
| `tailscale serve` | `https://x.tail.ts.net` | `x.tail.ts.net` (원본 보존) | `https://x.tail.ts.net` |

`Origin` 이 없는 요청(`dmctl` 17곳·`curl`·CI)은 이 판정과 무관하다 (FR-RQG-3).

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 O — authority 일치

**FR-ROP-1** `Origin` 헤더가 있는 요청은 FR-RQG-3 의 호스트 판정에 **더해**, Origin authority
가 Host authority 와 **같아야** 한다. 다르면 **403**. 메서드와 경로를 가리지 않는다 —
게이트 예외 경로(FR-RQG-8)만 제외다.

**FR-ROP-2 (비교 규칙)** 두 authority 는 호스트와 포트가 **둘 다** 같을 때 같다.

- 호스트: FR-RQG-7 과 같은 정규화 뒤 문자열 비교
- 포트: **문자열 비교.** 없음(`""`)은 없음과만 같다. 기본 포트를 추론하지 않는다
- **스킴은 비교하지 않는다** — `tailscale serve` 에서 `Origin` 은 `https` 이고 서버는 평문을
  받는다. 서버가 브라우저의 스킴을 알 길은 `X-Forwarded-Proto` 뿐인데 그것은 읽지 않는다
  (FR-RQG-10)

> 기본 포트를 추론하지 않는 이유: 브라우저는 두 헤더 모두에서 기본 포트를 생략하므로
> 추론할 입력이 정상 경로에 없다. 추론하려면 스킴이 필요한데(`80` 인가 `443` 인가), 그
> 스킴이 위 이유로 믿을 수 없는 값이다. 추론은 잔여 위험(§3.4)을 넓히기만 한다.

**FR-ROP-3 (해석할 수 없는 Origin)** 다음 `Origin` 은 **403** 이다.

- `null` — 샌드박스 iframe(`doc-render.js` 의 HTML 미리보기)·`file://` 페이지·일부 리다이렉트
- URL 로 파싱되지 않는 값
- 스킴이 `http`·`https` 가 아닌 값 (`chrome-extension://…`, `file://…` 등)

현행도 `null` 은 호스트 `"null"` 로 읽혀 거절된다. **그 결과를 우연에서 규칙으로 옮긴다.**
후속 `BROWSER_TAB_SRS` 가 `file://` 페이지를 여는데, 그 페이지가 이 서버의 API 에 닿지
못한다는 것을 이 FR 이 보증한다.

**FR-ROP-4 (Host 없는 Origin)** `r.Host` 가 비어 있는데 `Origin` 이 있으면 **403**. 브라우저는
언제나 `Host` 를 싣는다 — 둘 중 하나만 있는 요청은 정상 경로에 없다.

**FR-ROP-5 (Origin 부재)** `Origin` 이 없는 요청은 지금처럼 통과한다 (FR-RQG-3·§2.6 승계).

**FR-ROP-6 (판정의 자리)** 판정은 `reqgate.go` 한 곳에 산다. `/ws` 는 이미 `requestGate` 를
지나므로 **따로 판정하지 않는다** (FR-RQG-11 승계). `toolhub.Upgrader.CheckOrigin` 을
바꾸지 않는다.

**FR-ROP-7 (거절의 모양)** 거절 로그의 사유는 기존 호스트 불일치(`origin`)와 **구별되는 값**
(`origin-authority`)이다 — 운영자가 "허용 목록에 없는 이름" 과 "같은 기계의 다른 포트" 를
로그에서 가를 수 있어야 한다. 응답 본문은 기존과 같은 `forbidden` 이며 허용 목록을 싣지
않는다 (FR-RQG-9 승계).

### 3.2 묶음 D — 문서

**FR-ROP-8** `SECURITY.md` §6 에 이 결함을 기존 항목과 같은 형식(무엇이었나 · 무엇이
가능했나 · 해당 조건 · 영향 판 · 고친 판 · 지금 할 일 · 어떻게 고쳤나 · 어떻게
드러났나)으로 적는다. §1 표의 `requestGate` 설명에 "포트까지" 를 더한다. `CHANGELOG.md`
의 다음 판 항목에 보안 수정으로 적는다.

**FR-ROP-9** `REQUEST_GATE_SRS` 의 FR-RQG-3·FR-RQG-7·TC-RQG-30 에 개정 표시를 달고 이
문서를 가리킨다. 변경 기록에 한 줄을 더한다. (이 문서 작성과 함께 반영한다.)

### 3.3 동작 변경 기록

| | |
|---|---|
| 이전 동작 | `Origin` 의 **호스트**가 허용 집합에 있으면 통과. 포트는 무시 |
| 새 동작 | 호스트 판정에 더해 `Origin` 의 authority(호스트+포트)가 `Host` 와 같아야 통과. `null`·비 http(s) Origin 은 거절 |
| 이유 | 같은 기계의 다른 포트에서 서빙되는 페이지가 `/ws` 로 셸을 얻었다 (§1.1 실측) |
| 영향받는 정상 경로 | 없음 (§2.3 표 전부 통과). 영향받는 것은 **실제 브라우저가 만들지 않는 헤더 조합**을 쓰던 시험뿐이다 — TC-RQG-30 |

### 3.4 잔여 위험 (이 문서가 닫지 않는 것)

**R-ROP-1** `Host` 에 포트가 없는 배치(`tailscale serve`)에서, **같은 이름의 기본 포트**에서
서빙되는 다른 페이지는 구별되지 않는다. 예: dongminal 이 `https://x.ts.net`(serve)이고 같은
기계가 `http://x.ts.net`(80)에서 다른 페이지를 낼 때, 두 요청 모두 포트가 없다. 막으려면
브라우저의 스킴을 알아야 하고 그 값은 `X-Forwarded-Proto` 뿐이다(FR-RQG-10 이 읽지 않는다).
`SECURITY.md` §4 에 한 줄로 적는다.

---

## 4. 검증 (Verification)

### 4.1 게이트 (Go, `httpapi/reqgate_test.go`)

| ID | 확인 |
|---|---|
| TC-ROP-1 | `Host: localhost:58146` · `Origin: http://localhost:3000` 의 `POST /api/tools/headless` → 403 |
| TC-ROP-2 | 위 조합의 `/ws` 업그레이드 → 403, **업그레이드가 일어나지 않고 도구가 생기지 않는다** (§1.1 재현) |
| TC-ROP-3 | §2.3 표의 다섯 배치(`Host`·`Origin` 쌍)가 전부 통과 — `tailscale serve` 행은 `--allowed-host '*.ts.net'` 구성 |
| TC-ROP-4 | `Host: localhost:58146` · `Origin: http://127.0.0.1:58146` → 403 (호스트 불일치) |
| TC-ROP-5 | `Origin: null` · `Origin: file://` · `Origin: chrome-extension://abc` · 파싱 불가 값 → 403 |
| TC-ROP-6 | `Host` 없음 + `Origin` 있음 → 403 |
| TC-ROP-7 | 대소문자·후행 점·IPv6 대괄호가 결과를 바꾸지 않는다 (`Host: [::1]:58146` · `Origin: http://[::1]:58146` → 통과) |
| TC-ROP-8 | `Host: localhost:58146` · `Origin: http://localhost` → 403 (기본 포트를 추론하지 않는다, FR-ROP-2) |
| TC-ROP-9 | 거절 로그의 사유가 `origin-authority` 이고 본문에 목록이 없다 |
| TC-RQG-30 (개정) | `Host`·`Origin` 이 **둘 다** `macmini-office:58146` → 통과. `Origin` 만 그 이름이고 `Host` 가 다른 주소면 → 403 |

### 4.2 회귀

| ID | 확인 |
|---|---|
| TC-ROP-10 | TC-RQG-1~36 중 TC-RQG-30 외 전부가 그대로 통과 — 특히 TC-RQG-2·15(Origin 부재 통과), TC-RQG-16(자기 출처 WS 101) |
| TC-ROP-11 | e2e 전체(TC-RQG-26) — 게이트가 자기 화면을 막지 않는다 |
| TC-ROP-12 | 수동 재현: §1.1 의 `curl` 핸드셰이크가 `Origin: http://localhost:3000` 에서 **403** |

### 4.3 문서

`scripts/check-srs-status.sh` · `scripts/check-srs-progress.sh` · `scripts/check-decisions.sh`
통과. `SECURITY.md` §6 항목 존재.

---

## 5. 비목표 (Non-goals)

1. **Sec-Fetch-Site 조이기.** `same-site` 를 빼는 것은 FR-ROP-1 뒤에는 추가 효과가 없다 —
   상태 변경 메서드에서 브라우저는 교차 출처 요청에 늘 `Origin` 을 싣는다.
2. **`Origin` 없는 교차 출처 GET** (`<img>`·`<script src>`·링크 이동). 응답을 읽지 못하고,
   부작용 있는 `GET` 종단은 이 문서의 범위가 아니다.
3. **`X-Forwarded-*` 읽기** — FR-RQG-10 승계. R-ROP-1 은 그 대가로 남긴다.
4. **인증·TLS** — `REQUEST_GATE_SRS` §5 의 영구 비목표 승계.

---

## 6. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-27 | 초안. `BROWSER_TAB_INVESTIGATION` §6 에서 발견·실측. 사용자 지시로 브라우저 탭의 0단계로 선행 |
