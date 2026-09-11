# SRS: 브라우저의 API 호출을 한 자리로 — IEEE 29148

> **문서 상태**: 승인·구현완료

- 근거 감사: `02-fe-arch.md` P1 "fetch 관용구 중복" · `00-INDEX.md` §3 묶음 `B3`.
- 후속: M4(인증). **이 문서의 존재 이유가 그것이다** — 401 을 한 자리에서 다루려면
  호출이 한 자리를 지나야 한다.

---

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

브라우저가 서버를 부르는 자리가 **29파일 82곳**이고, 그 하나하나가 같은 네 줄을
다시 쓴다.

```js
try{const r=await fetch(`/api/tools/${toolId}/busy`);const d=await r.json();return d.busy}catch{return false}
```

같은 일을 하는 코드가 82벌이면 **규약이 82벌**이다. 실제로 갈려 있다.

| 갈린 것 | 실측 |
|---|---|
| 실패를 잡는 방법 | `try{}catch{}` · `if(!r.ok)` · 둘 다 · 둘 다 없음 |
| 본문을 읽는 방법 | `r.json()` · `r.text()` · 안 읽음 |
| 상태 변경의 `Content-Type` | 밝히는 곳과 **안 밝히는 곳**이 섞여 있었다 |
| 쿼리 조립 | `encodeURIComponent` 수동 · `URLSearchParams` · 문자열 접합 |

**세 번째 줄이 이 문서가 필요한 증거다.** M2 의 요청 게이트를 켜자 앱이 부팅되지
않았다 — 상태 변경 `fetch` 6곳이 `Content-Type` 을 밝히지 않고 있었고, 그중에
셸을 만드는 `POST /api/tools` 와 `DELETE /api/tools/{id}` 가 있었다. 같은 결함이
e2e 하네스에도 4곳 있었고, 그것이 **모든 테스트 앞에서 도는 정리 함수**여서 고아
도구가 쌓여 다른 스펙을 무너뜨렸다.

**한 자리를 지나면 그 부류가 사라진다.** 그리고 M4 가 401 을 다룰 자리도 하나가
된다 — 지금 상태로 인증을 붙이면 29파일을 고쳐야 하고, 그중 하나를 빠뜨리면
"로그인했는데 어떤 화면만 안 된다" 가 된다.

### 1.2 범위 (Scope)

**포함**

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **A** | `web/js/core/api.js` — 전송 한 겹 (`apiGet`·`apiSend`) | MEDIUM |
| **M** | 손수 `fetch` 를 전부 그 겹으로 옮긴다 — `core/`·`ui/`·`git/` | **HIGH** — 28파일 81곳 |
| **G** | `git/api.js` 가 **전송만** 위임한다. echo·stale 계약은 그대로 | MEDIUM |
| **W** | 그 상태를 지키는 게이트 (`scripts/check-fetch.sh`) | LOW |
| **T** | 단위 검사 (`node:test`) | LOW |

**미포함** — §5.

### 1.3 정의 (Definitions)

| 용어 | 뜻 |
|---|---|
| **전송 한 겹** | URL 조립·헤더·본문 읽기·실패 표현을 맡는 자리. **무엇을 부르는지는 모른다** |
| **응답 봉투** | 호출자가 받는 `{ok, status, data, text, headers}` |
| **방언** | 서버가 오류를 싣는 네 가지 본문 모양. `architecture.md:141-176` 의 공개 계약 |
| **주입 fetch** | 호출자가 건네는 `fetch` 구현. `TimerHub` 의 `ctx.fetch` 가 그것이다 |

### 1.4 참조 (References)

- `git/api.js` — `gitFetch`/`gitPost`. **이 문서가 따르는 원형**이며 §2.2 가 그 관계를 정한다.
- `REQUEST_GATE_SRS` FR-RQG-5 — 상태 변경은 본문이 없어도 JSON 을 밝힌다.
- `architecture.md:141-176` — 오류 본문 방언 4종이 공개 계약이라는 결정.
- `SCHEDULER_SRS` — `TimerHub` 의 `ctx.fetch`(잡 단위 시한). §2.3.

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 재고

```
core/  51곳 / 15파일      ui/  17곳 / 7파일      git/  14곳 / 7파일
메서드:  GET 41 · POST 19 · PUT 5 · DELETE 2   (core+ui 기준 67, FormData 3 별도)
```

### 2.2 `git/` 에는 이미 한 겹이 있고 그것은 옳다

`gitFetch`/`gitPost` 가 **echo 검증**(늦게 온 남의 응답을 자기 것으로 읽지 않는
것, `FR-GIT-16`)과 **stale 판정**을 든다. 그 개념은 git 화면의 것이며 일반화할
대상이 아니다.

**그러나 그 아래의 전송은 같다.** 지금은 `gitFetch` 안에도 `fetch`·`r.json()`·
`try/catch` 가 한 벌 더 있다. 두 벌이면 M4 의 401 도 두 자리가 된다.

이 문서는 `git/api.js` 의 **계약을 바꾸지 않고** 전송만 아래로 내린다.

### 2.3 `TimerHub` 가 시한 있는 `fetch` 를 이미 준다

`_ctx()`(`timer-hub.js:177-183`)가 잡마다 `ctx.fetch` 를 만들고 `job.timeout` 을
`AbortSignal.timeout` 으로 붙인다. **지금 그것을 쓰는 호출자가 하나도 없다.**

경쟁하는 두 번째 시한 규약을 만들지 않는다 — `api.js` 는 `fetch` 구현을 **주입
받는다**. 폴링 잡은 `ctx.fetch` 를 건네고, 나머지는 전역 `fetch` 를 쓴다.

### 2.4 기본 시한을 둘 수 없다

`/api/status` 의 대기 종단은 최대 30분을 기다린다(`handlers_status.go:31`).
전역 기본 시한을 두면 그 종단이 조용히 끊긴다. **시한은 옵트인이다.**

### 2.5 본문을 두 가지로 읽는다

오류 문구를 `r.text()` 로 읽는 자리가 **12곳**이다 — 단문 `{error}` 방언이
`http.Error` 로 나가기 때문이다. 성공 본문은 `r.json()` 으로 읽는다.

`Response` 의 본문은 **한 번만** 읽을 수 있으므로 둘을 함께 얻으려면 한 번
읽고 나서 파싱해야 한다. 지금은 자리마다 하나만 골라 읽고, 그래서 실패
경로에서 사유를 버리는 자리가 있다.

### 2.6 제약 (Constraints)

- **오류 본문 방언 4종을 통일하지 않는다** (`architecture.md`). 이 겹은 방언을
  **읽지 않는다** — `data` 와 `text` 를 그대로 준다.
- 흐름 제어에 `try/catch` 를 쓰지 않는다 (CLAUDE.md). 이 겹은 **던지지 않는다**.
- 새 런타임 의존을 넣지 않는다. `web/js` 는 클래식 스크립트다 — `import` 가 없다.
- `EventSource`(SSE)는 이 문서의 대상이 아니다. `event-bus.js` 의 것이다.
- `git/api.js` 의 echo·stale 계약을 바꾸지 않는다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 전송 한 겹

**FR-CAPI-1 (자리)** `web/js/core/api.js` 하나다. `index.html` 에서
`helpers.js` **뒤**, 이 겹을 쓰는 어떤 파일보다 **앞**에 실린다.

**FR-CAPI-2 (봉투)** 모든 호출이 같은 모양을 돌려준다.

```js
{ ok: boolean, status: number, data: any|null, text: string, headers: Headers|null }
```

| 칸 | 뜻 |
|---|---|
| `ok` | HTTP 성공(`response.ok`). **본문 유무를 보지 않는다** — 204 를 내는 종단이 있다 |
| `status` | HTTP 상태. **망 실패는 0** 이다. 503 을 판정으로 굳히는 자리가 있어 실어 보낸다 |
| `data` | 본문을 JSON 으로 읽은 것. 아니면 `null` |
| `text` | 본문 원문. 오류 문구가 여기 있다 (§2.5) |
| `headers` | 응답 헤더. 망 실패면 `null` |

**`headers` 를 싣는 이유는 `ETag` 다.** 워크스페이스 저장이 낙관적 잠금을 쓰고
(`WORKSPACE_SAVE_CONFLICT_SRS`), 그 판정이 `ETag`/`If-Match` 위에 선다 — 세 자리가
이 값을 읽는다. 그것을 못 주면 그 세 자리가 이 겹을 지나지 못하고, 지나지 못하는
자리가 하나라도 있으면 M4 의 401 이 다시 흩어진다.

**FR-CAPI-3 (던지지 않는다)** 망 실패·중단·파싱 실패가 전부 봉투로 돌아온다.
호출부에 `try/catch` 가 생기지 않는 것이 이 겹의 값이다.

**FR-CAPI-4 (본문을 한 번 읽는다)** 본문을 텍스트로 한 번 읽고 그것을 파싱해
`data` 를 만든다. 그래야 `data` 와 `text` 가 **함께** 선다 (§2.5).

**FR-CAPI-5 (상태 변경은 JSON 을 밝힌다)** `POST`·`PUT`·`PATCH`·`DELETE` 는
**본문이 없어도** `Content-Type: application/json` 을 싣는다
(`REQUEST_GATE_SRS` FR-RQG-5). 호출자가 빠뜨릴 자리가 없어진다.

**예외는 `FormData` 하나다** — 그때는 `Content-Type` 을 **세우지 않는다**.
브라우저가 경계(boundary)를 붙여야 하고, 게이트도 `multipart/form-data` 를
받는다.

**FR-CAPI-6 (쿼리)** `opts.query` 는 객체이고 `URLSearchParams` 로 조립한다.
`encodeURIComponent` 를 손으로 부르는 자리가 없어진다.

**FR-CAPI-7 (시한)** `opts.timeout` 이 있으면 `AbortSignal.timeout` 을 건다.
**기본값은 없다** (§2.4). `opts.signal` 은 그대로 지나간다. 둘 다 있으면
`opts.signal` 이 이긴다 — 호출자가 명시한 쪽이다.

**FR-CAPI-8 (주입 fetch)** `opts.fetch` 가 있으면 그것을 쓴다. 없으면 전역
`fetch`. `TimerHub` 의 `ctx.fetch` 가 이 자리로 들어온다 (§2.3).

**구현을 주입받으므로 그 입력에 대해 전부여야 한다.** 던지는 것뿐 아니라 **응답
없이 resolve 하는 것**도 전송 실패로 읽는다. 진짜 `fetch` 는 그러지 않지만 잡의
`ctx.fetch` 와 검사 스텁이 이 자리로 들어오고, 종전 호출부의 `if(r)` 관용구가
바로 그 경우를 다루고 있었다.

**FR-CAPI-9 (표면)**

```js
apiGet(path, opts)                 // GET
apiSend(method, path, body, opts)  // 상태 변경
apiPost(path, body, opts)          // apiSend('POST', …)
apiPut(path, body, opts)           // apiSend('PUT', …)
apiDel(path, opts)                 // apiSend('DELETE', null, …)
```

`body` 가 `FormData` 면 그대로 보낸다. `null`·`undefined` 면 본문이 없다.
그 밖은 `JSON.stringify`.

**~~FR-CAPI-10 (M4 자리)~~** — ⊘ **철회 (2026-09-11, 로드맵 결정 9)**.
인증을 도입하지 않으므로 401 을 낳을 표면이 없다. `api.js` 의 예약 주석은
**제거했다** — 채울 것이 없는 자리를 남기면 그것이 "예정" 으로 읽힌다.
**`apiSend` 가 모든 응답이 지나는 한 지점이라는 사실은 그대로이며**, 필요가
생기면 그때 그 자리에서 하면 된다(이 SRS 의 실질 가치는 그 통합이다).
아래는 철회된 원문이다. ~~응답을 봉투로 만들기 **전에** 한 지점을 지난다.~~
M4 가 401 을 여기서 다룬다. **M2 에서는 아무것도 하지 않는다** — 자리와 계약만
적는다 (`REQUEST_GATE_SRS` FR-RQG-22 와 같은 규약).

### 3.2 묶음 M — 옮기기

**FR-CAPI-11** 손수 `fetch` 가 전부 이 겹을 지난다 — `core/`·`ui/` 뿐 아니라
`git/` 의 **`gitFetch` 를 지나지 않던 10곳**도 포함이다. 그것을 남기면 401 을 다룰
자리가 다시 흩어지고, 이 문서의 존재 이유가 반만 달성된다.

남는 것은 아래 둘뿐이며 목록은 이 문서가 진실이다.

| 남는 것 | 왜 |
|---|---|
| `EventSource` (`event-bus.js`) | `fetch` 가 아니다 |
| `TimerHub._ctx` 의 `ctx.fetch` (`timer-hub.js`) | **그것이 주입 fetch 자체다** (FR-CAPI-8). 잡의 시한을 붙여 `opts.fetch` 로 건네지는 값이며, 이 겹의 위가 아니라 아래다 |

큰 원문을 그대로 받는 자리(`/api/file/read`·판 감시)는 예외가 아니다 —
`opts.parse:false` 로 표시하고 `text` 로 받는다. 업로드(`FormData`)도 예외가
아니다 — FR-CAPI-5 로 이 겹을 지난다.

**FR-CAPI-12 (동작을 바꾸지 않는다)** 옮기는 것은 관용구이지 행동이 아니다.
같은 요청이 나가고 같은 화면이 나온다. **화면 문구를 이 작업에서 바꾸지 않는다.**

**FR-CAPI-12a (합성 페이지 검사)** `page.addScriptTag` 로 스크립트 몇 개만 싣는
e2e 스펙은 `index.html` 의 로드 순서를 물려받지 않는다. 이 겹을 쓰는 스크립트를
싣는 스펙은 **`core/api.js` 를 그보다 앞에** 실어야 한다 — 빠뜨리면
`apiGet is not defined` 로 그 자리에서 터진다.

닿는 스펙 셋: `event-timer-hub-contract` · `sse-resilience` · `reconnect-storm`.

**FR-CAPI-13 (게이트)** 그 상태를 `scripts/check-fetch.sh` 가 지킨다. 허용 목록에
이름을 더하는 것은 **결정**이며 이 문서를 함께 고쳐야 한다. 기록만 두면 반드시
어긋난다 — `check-vendor.sh` 가 같은 이유로 있다.

### 3.3 묶음 G — `git/api.js`

**FR-CAPI-14** `gitFetch`/`gitPost` 의 **시그니처와 반환 모양을 바꾸지 않는다.**
`{ok, data, stale, status}` 그대로다. 안쪽의 `fetch`·`r.json()`·`try/catch` 만
`apiGet`/`apiPost` 로 내린다.

**FR-CAPI-15** git 의 `ok` 는 종전대로 `r.ok && data!==null && echo` 다. 코어의
`ok`(HTTP만)와 다르며, **그 차이가 의도된 것임을 주석이 적는다** — git 종단은
언제나 JSON 을 내고, 코어에는 204 를 내는 종단이 있다.

### 3.4 비기능 요구 (NFR)

**NFR-CAPI-1** 이 겹은 **상태를 갖지 않는다.** 전역 하나·함수 몇 개다.

**NFR-CAPI-2** `node:test` 에서 `fetch` 를 갈아 끼워 검사할 수 있다 —
`opts.fetch` 가 그 자리다 (FR-CAPI-8).

**NFR-CAPI-3** 옮기기가 끝난 뒤 전체 e2e 가 종전대로 통과한다. 이 작업의
성공 판정은 **아무것도 달라지지 않는 것**이다.

---

## 4. 검증 (Verification)

### 4.1 겹 (`node:test`, `web/js/test/api.test.mjs`)

| ID | 확인 |
|---|---|
| TC-CAPI-1 | 200 + JSON → `{ok:true, status:200, data:{…}, text:'…'}` |
| TC-CAPI-2 | 204(본문 없음) → `ok:true` · `data:null` · `text:''` |
| TC-CAPI-3 | 400 + 단문 본문 → `ok:false` · `text` 에 사유 · `data:null` |
| TC-CAPI-4 | 400 + JSON 본문 → `ok:false` · `data` 가 있다 (실패해도 본문을 읽는다) |
| TC-CAPI-5 | 망 실패(`fetch` 가 던진다) → `{ok:false, status:0, data:null, text:''}`, **던지지 않는다** |
| TC-CAPI-6 | 깨진 JSON → `data:null` · `text` 는 원문 |
| TC-CAPI-7 | `POST` 에 본문이 없어도 `Content-Type: application/json` 이 실린다 |
| TC-CAPI-8 | `DELETE`·`PUT`·`PATCH` 도 같다 |
| TC-CAPI-9 | `GET` 에는 `Content-Type` 을 싣지 않는다 |
| TC-CAPI-10 | `FormData` 본문이면 `Content-Type` 을 **세우지 않는다** |
| TC-CAPI-11 | `opts.query` 가 `URLSearchParams` 로 조립되고 특수문자가 인코딩된다 |
| TC-CAPI-12 | `opts.timeout` 이 `signal` 을 만든다. 없으면 `signal` 이 없다 |
| TC-CAPI-13 | `opts.signal` 이 `opts.timeout` 을 이긴다 |
| TC-CAPI-14 | `opts.fetch` 가 전역 `fetch` 대신 불린다 |
| TC-CAPI-15 | `opts.parse:false` 면 `data` 를 만들지 않는다 |
| TC-CAPI-16 | 응답 헤더를 `headers` 로 읽을 수 있다 (`ETag`) |
| TC-CAPI-17 | 망 실패면 `headers` 가 `null` 이다 |
| TC-CAPI-18 | 응답 없이 resolve 하는 `fetch` 도 전송 실패로 읽는다 |

### 4.2 옮기기

| ID | 확인 |
|---|---|
| TC-CAPI-19 | `scripts/check-fetch.sh` 가 통과한다 — `web/js` 전체에서 손수 `fetch` 가 허용 목록 둘뿐이다 |
| TC-CAPI-20 | 그 게이트가 `make gates` 와 `verify.yml` 에 걸려 있다 |
| TC-CAPI-21 | (e2e) 전량 통과 — 이 작업의 성공은 **아무것도 달라지지 않는 것**이다 |

### 4.3 보존 확인 (회귀)

`eslint` 0건 · `tsc` 통과 · `check-html.sh` 통과 · git 화면의 echo·stale
e2e 통과 · 업로드·SSE 관련 e2e 통과.

---

## 5. 비목표 (Non-goals)

1. **오류 본문 방언 통일.** `architecture.md:141-176` 의 공개 계약이다. 이 겹은
   방언을 **읽지 않는다** — `data` 와 `text` 를 그대로 준다.
2. **인증.** ~~자리(FR-CAPI-10)만 만든다. 401 처리는 M4 다.~~
   > **개정 (2026-09-11, 로드맵 결정 9)**: **인증을 도입하지 않는다.** 401 을 낳을
   > 표면이 없으므로 FR-CAPI-10 은 철회됐고 `api.js` 의 예약 주석도 제거했다.
   > 이 SRS 가 남긴 실질 가치는 인증과 무관하다 — **fetch 관용구가 한 자리를 지난다**
   > 는 것이고, 그것은 그대로 유효하다.
3. **재시도·백오프.** 재연결 폭주 대책은 `RECONNECT_STORM_SRS` 의 것이고 그것은
   소켓의 일이다. 요청 하나에 자동 재시도를 넣으면 쓰기가 두 번 일어난다.
4. **캐시·중복 제거.** 겹치는 요청을 접는 것은 `TimerHub` 의 single-flight 가
   이미 하는 일이다 (`FR-SCH-7`).
5. **`EventSource`(SSE) 통합.** `event-bus.js` 의 것이며 `fetch` 가 아니다.
6. **`git/api.js` 의 echo·stale 계약 변경.** 양호 판정이며 전송만 내린다.
7. **ESM 전환.** `web/js` 85개 스크립트의 로드 순서와 `__ASSETV__` 캐시 버스팅에
   얽힌 별도 결정이다 (`web/js/test/harness.mjs` 가 같은 이유를 적었다).
8. **화면 문구 변경.** 옮기는 것은 관용구이지 행동이 아니다 (FR-CAPI-12).

---

## 6. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-10 | 초안. M2 `FE-8`. |
