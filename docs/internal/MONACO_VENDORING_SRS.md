# SRS: Monaco 벤더링과 사전압축 정적 서빙 — IEEE 29148

> **문서 상태**: 승인·구현완료

- 근거 감사: `02-fe-arch.md` P1 "Monaco CDN"(`FE-6`) · `04-secops.md` §4.3(`B7`, CSP) ·
  `00-INDEX.md` §3 묶음 `B7`.
- 짝 문서: `REQUEST_GATE_SRS.md` §5 비목표 8 이 "CSP·보안 헤더·Monaco 벤더링 …
  구현은 M2 안에서 함께 한다" 로 이 문서를 예고했다. 이 문서가 그것이다.

---

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`web/js/ui/file-editor.js:5` 가 편집기를 런타임에 서드파티 CDN 에서 받는다.

```js
const MONACO_CDN = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.56.0/min/vs';
```

**SRI 가 없다.** 그 호스트가 주는 것이 무엇이든 사용자의 브라우저에서 실행되고, 그
브라우저에는 이 제품의 셸·파일 API·git 쓰기가 전부 열려 있다. 나머지 제3자 자산
아홉은 전부 저장소에 복사돼 `go:embed` 로 바이너리 안에 있는데
(`VENDOR_VERSIONS.md`), **편집기 하나만 예외**다.

결과가 둘이다.

| | 지금 |
|---|---|
| 공급망 | `cdn.jsdelivr.net` 이 곧 스크립트 공급망이다. 판을 고정하는 해시가 없다 |
| 폐쇄망 | 인터넷이 없으면 편집기·Diff 뷰·LSP 뷰가 **통째로 서지 않는다**. 오버레이 망 뒤에서만 쓰는 배치가 이 제품의 기본 사용 형태다(§0-1-1) |

그리고 그 하나 때문에 CSP 의 지시자 **넷**에 외부 호스트가 열려 있다
(`static.go:66-70`) — `script-src`·`style-src`·`font-src`·`connect-src`.

### 1.2 범위 (Scope)

**포함**

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **V** | `monaco-editor@0.56.0` 의 `min/vs` 를 `web/vendor/monaco/vs` 로 벤더링 | MEDIUM |
| **Z** | 정적 핸들러의 **사전압축 서빙** — 자산을 `.gz` 로 담고 그대로 흘린다 | MEDIUM |
| **C** | CSP 에서 외부 호스트 제거 · head 선주입 스크립트의 해시 허용 | MEDIUM |
| **G** | `check-vendor.sh` 가 디렉터리 자산을 다룰 수 있게 한다 | LOW |

**미포함** — §5.

### 1.3 정의 (Definitions)

| 용어 | 뜻 |
|---|---|
| **사전압축 자산** | 저장소에 `이름.gz` 로 들어 있고, 서버가 해제하지 않고 `Content-Encoding: gzip` 으로 그대로 내보내는 파일 |
| **논리 경로** | 브라우저가 요청하는 이름. `.gz` 가 붙지 않은 쪽 (`/vendor/monaco/vs/loader.js`) |
| **디렉터리 자산** | `web/vendor` 아래의 파일 하나가 아니라 트리 하나로 관리되는 제3자 자산 |

### 1.4 참조 (References)

- `VENDOR_VERSIONS.md` — 제3자 자산의 판 기록. §6 이 개정한다.
- `ASSET_VERSION_SINGLE_SOURCE_SRS` — `staticHandler` 가 `index.html` 의 판을
  치환하는 계약. 이 문서는 그 핸들러에 분기를 **더한다**.
- `REQUEST_GATE_SRS.md` §5 비목표 8 — 이 문서를 예고한 자리.

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 크기 — 실측

| | 값 |
|---|---|
| `min/vs` 파일 수 | 151 (`.js` 137 · `.d.ts` 13 · `.css` 1) |
| raw 합계 | **23.3 MB** |
| 파일마다 gzip 한 합계 | **5.4 MB** |
| 현재 바이너리 | 16 MB |

`go:embed` 는 압축하지 않고 `release.yml` 은 tar/zip 없이 raw 바이너리를 그대로
올린다(`gh release create "$VERSION" dist/*`). **그러므로 raw 로 담으면 사용자가
받는 파일이 16MB → 약 39MB 이고 5대상 합계가 +117MB 다.**

내역이 한쪽으로 쏠려 있다.

```
assets/ts.worker              6.7 MB  ┐ TypeScript 만 13.1 MB — 전체의 56%
language/typescript           6.4 MB  ┘
editor-*.js                   2.3 MB
nls/lang (UI 로케일 14개)      1.6 MB
toggleHighContrast            1.2 MB
css·html·json 의 worker+language  2.9 MB
나머지 (basic-languages 등)    ~2.8 MB
```

**`M2_PROGRESS.md` §4 의 "min/vs 약 5MB → 바이너리 21MB" 는 gzip 크기를 raw 로 잘못
적은 것이다.** §6 이 그 표를 개정한다.

### 2.2 트리 모양

디렉터리 11개, `vs` 아래 최대 깊이 3. `_`·`.` 으로 시작하는 이름이 **하나도 없다** —
`go:embed` 의 기본 제외 규칙에 걸리는 것이 없다는 뜻이고, `web/embed.go` 의
`vendor/*` 가 이 트리를 통째로 담는다.

### 2.3 로더는 고전 AMD 경로다

```js
require.config({ paths: { vs: MONACO_CDN } });          // file-editor.js:68
require(['vs/editor/editor.main'], …);                  // :69
script.src = MONACO_CDN + '/loader.js';                 // :75
```

`min/vs` 에 `loader.js` 와 `editor/editor.main.js` 가 있다. **상수 하나가 가리키는
곳을 바꾸는 것이 벤더링의 전부**이고, 나머지 파일은 로더가 그 아래에서 찾는다.

### 2.4 정적 핸들러에 이미 자리가 있다

`staticHandler`(`static.go:31-49`)가 `fs.FS` 를 직접 들고 ETag 를 손으로 붙인다
(embed 된 파일은 ModTime 이 zero 라 `Last-Modified` 가 없기 때문이다). `next` 로
`http.FileServer` 를 두고 필요할 때만 가로채는 구조가 이미 서 있다.

**`http.FileServer` 에 `.gz` 를 그대로 맡길 수는 없다** — 확장자를 보고
`application/gzip` 을 붙이고 `Content-Encoding` 을 붙이지 않는다. 브라우저는 그것을
스크립트로 실행하지 않는다.

### 2.5 CSP 의 네 지시자가 이 하나 때문에 열려 있다

```go
"script-src 'self' https://cdn.jsdelivr.net; " +        // static.go:66
"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
"font-src 'self' data: https://cdn.jsdelivr.net; " +
"connect-src 'self' ws: wss: https://cdn.jsdelivr.net; " +
```

`TestStatic_CSPExternalHostsAreKnown`(`static_test.go:106`)이 그 호스트 하나를 알고
있다. **벤더링이 끝나면 그 검사가 먼저 실패한다 — 그것이 이 줄을 지울 때가 됐다는
신호다.**

### 2.6 `check-vendor.sh` 는 flat 파일만 안다

```bash
for f in "$DIR"/*; do
  h="$(shasum -a 256 "$f" | cut -c1-16)"      # ← 디렉터리면 여기서 깨진다
```

디렉터리가 들어오면 게이트가 그 자리에서 실패한다.

### 2.7 제약 (Constraints)

- 새 런타임 의존을 넣지 않는다. 빌드에 번들러를 들이지 않는다.
- `staticHandler` 의 ETag·`index.html` 치환 계약을 바꾸지 않는다 — 분기를 더한다.
- 다른 벤더 자산 아홉의 관리 방식을 바꾸지 않는다. 이 문서는 monaco 만 다룬다.
- **기능을 깎지 않는다.** `nls` 제외·TypeScript 언어 서비스 제외 같은 트림은 크기를
  이유로 하지 않는다 — 압축이 그 거래를 불필요하게 만들었다 (§5 비목표 1).

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 V — 벤더링

**FR-MVN-1** `monaco-editor@0.56.0` 의 `min/vs` 트리를 `web/vendor/monaco/vs` 아래에
둔다. 디렉터리 구조를 그대로 보존한다 — AMD 로더가 상대 경로로 찾는다.

**FR-MVN-2** `.d.ts` 13개는 담지 않는다. TypeScript 선언 파일이며 런타임에 요청되지
않는다. **이것은 기능 트림이 아니다** — 실행되는 코드는 하나도 빠지지 않는다.

**FR-MVN-3** `MONACO_CDN` 상수가 사라지고 그 자리를 자기 경로가 대신한다
(`/vendor/monaco/vs`). 전수 grep 으로 `jsdelivr` 가 저장소에서 0건이 된다.

**FR-MVN-4** monaco 의 `LICENSE`(MIT)를 함께 담고 `VENDOR_VERSIONS.md` 에 적는다.

### 3.2 묶음 Z — 사전압축 서빙

**FR-MVN-5** 담기는 파일의 이름은 `<논리 경로>.gz` 이고 내용은 gzip 스트림이다.
저장소에 raw 사본을 함께 두지 않는다 — 두 벌이면 한쪽만 고쳐진다.

**FR-MVN-6** `staticHandler` 는 요청 경로 `P` 에 대해 `P` 가 없고 `P.gz` 가 있으면
그것으로 답한다. 이 판정은 **모든 정적 자산에 적용된다** — monaco 전용 분기를 만들지
않는다. 지금 `.gz` 를 갖는 것이 monaco 뿐인 것과, 규칙이 monaco 만 아는 것은 다르다.

**FR-MVN-7 (Content-Type)** `Content-Type` 은 **`.gz` 를 뗀 이름**으로 정한다.
`.js` → `text/javascript`, `.css` → `text/css`. `application/gzip` 을 내보내면
브라우저가 스크립트로 실행하지 않는다.

**FR-MVN-8 (협상)** 클라이언트가 `Accept-Encoding` 에 `gzip` 을 실으면
`Content-Encoding: gzip` 과 함께 **그대로** 내보낸다. 싣지 않으면 서버가 풀어서
평문으로 내보낸다. **후자를 생략하지 않는다** — 브라우저 아닌 클라이언트가 깨진
바이트를 받고 그 사실을 모르는 것이 이 종단에서 가장 나쁜 실패다.

**FR-MVN-9 (Vary)** 압축 여부가 갈리는 응답에 `Vary: Accept-Encoding` 을 붙인다.
중간 캐시가 한쪽 답을 다른 쪽에 주지 않게 한다.

**FR-MVN-10 (ETag)** ETag 는 종전대로 **담긴 바이트**(즉 `.gz` 의 내용)에서 만든다.
압축 여부와 무관하게 같은 값이며, `Vary` 가 그 둘을 가른다.

**FR-MVN-11** `.gz` 가 없는 자산의 경로는 **바뀌지 않는다** — 종전 그대로
`http.FileServer` 로 간다.

### 3.3 묶음 C — CSP

**FR-MVN-12** `script-src`·`style-src`·`font-src`·`connect-src` 에서
`https://cdn.jsdelivr.net` 을 뺀다. `script-src` 가 `'self'` 하나가 된다.

**FR-MVN-13** `TestStatic_CSPExternalHostsAreKnown` 이 아는 목록을 **빈 것**으로
바꾼다. 외부 호스트가 다시 들어오면 그 검사가 실패한다.

**FR-MVN-13a (head 선주입 스크립트)** `index.html` 의 head 인라인 스크립트 둘은
`script-src` 의 **`'sha256-…'` 해시**로 허용한다. 해시는 기동 시 **서빙되는
바이트에서 직접 계산**한다.

근거가 셋이다.

1. **지금 그 둘이 막혀 있다.** `script-src 'self'` 에는 인라인이 포함되지 않는다.
   `SEC-11`(2026-09-10 1차 세션)이 CSP 를 세우면서 첫 페인트의 선주입이 조용히
   죽었다 — 테마와 사이드바 너비가 첫 페인트에 반영되지 않는다.
   `boot-screen.spec.ts` 의 V-1·V-3 이 그것을 잡는다.
2. **외부 파일로 뺄 수 없다.** `BOOT_SCREEN_SRS` NFR-1 이 "선주입 스크립트는 동기
   인라인 1줄이며 **네트워크에 닿지 않는다**" 를 요구한다. `<script src>` 로 옮기면
   첫 페인트 앞에 왕복이 하나 생기고, 그것이 이 화면이 존재하는 이유를 깎는다.
3. **`'unsafe-inline'` 은 안 된다.** 그것을 켜면 `FE-1`(상태바 XSS)의 2차 방어가
   통째로 사라진다. 해시는 **그 두 스크립트만** 허용한다.

**FR-MVN-13b** 해시는 `src` 속성이 **없는** `<script>` 블록에서만 만든다. 속성이
붙은 인라인 스크립트는 해시 대상이 아니며 따라서 막힌다 — 조용히 허용되는 것보다
막혀서 보이는 편이 낫다.

**FR-MVN-13c** 해시 계산이 어긋나면 첫 페인트만 종전 동작(기본 테마)으로 떨어진다.
`BOOT_SCREEN_SRS` 의 실패 경로가 이미 그렇게 설계돼 있다 — 앱은 선다.

### 3.4 묶음 G — 판 기록 게이트

**FR-MVN-14** `check-vendor.sh` 가 `web/vendor` 아래의 **디렉터리**를 자산 하나로
다룬다. 판정은 둘이다: 파일 수와, 트리 전체의 **집계 해시**.

집계 해시는 결정적이어야 한다 — 파일마다 `sha256  상대경로` 줄을 만들고, 그 목록을
경로로 정렬한 뒤 다시 `sha256` 한다. 그래야 파일 하나가 바뀌어도, 사라져도, 이름이
바뀌어도 값이 달라진다.

**FR-MVN-15** `VENDOR_VERSIONS.md` 에 디렉터리 자산의 줄을 더하고, "벤더링되지
**않은** 것" 절에서 monaco 를 뺀다.

### 3.5 비기능 요구 (NFR)

**NFR-MVN-1** 사전압축 판정은 요청당 맵 조회 한 번이다. 압축 해제는 `gzip` 을
싣지 않은 클라이언트에서만 일어난다.

**NFR-MVN-2** 바이너리 증가는 **5.4MB 이내**다 (16MB → 약 21.4MB). 이 값이 이 설계를
고른 이유이므로 수치로 검증한다.

**NFR-MVN-3** 인터넷이 없는 상태에서 편집기·Diff 뷰가 선다.

---

## 4. 검증 (Verification)

### 4.1 서빙 (Go, `static_test.go`)

| ID | 확인 |
|---|---|
| TC-MVN-1 | `Accept-Encoding: gzip` 으로 `/vendor/monaco/vs/loader.js` → 200 · `Content-Encoding: gzip` · `Content-Type: text/javascript` |
| TC-MVN-2 | `Accept-Encoding` 없이 같은 요청 → 200 · `Content-Encoding` 없음 · 본문이 **평문 JS** |
| TC-MVN-3 | 두 응답의 해제된 바이트가 같다 |
| TC-MVN-4 | 응답에 `Vary: Accept-Encoding` 이 있다 |
| TC-MVN-5 | ETag 가 두 경우에 같다 |
| TC-MVN-6 | `/vendor/monaco/vs/loader.js.gz` 를 **직접** 요청해도 종전 규칙대로 답한다 (숨기지 않는다 — 숨기면 규칙이 둘이 된다) |
| TC-MVN-7 | `.gz` 가 없는 자산(`/vendor/xterm.js`)의 응답이 바뀌지 않았다 (회귀) |
| TC-MVN-8 | `/vendor/monaco/vs/editor/editor.main.css` → `Content-Type: text/css` |

### 4.2 CSP

| ID | 확인 |
|---|---|
| TC-MVN-9 | CSP 의 어느 지시자에도 `//` 로 시작하는 외부 출처가 없다 |
| TC-MVN-10 | `script-src` 에 `'unsafe-inline'` 이 **없다** |
| TC-MVN-10a | `script-src` 의 `'sha256-…'` 개수가 `index.html` 의 인라인 `<script>` 개수와 **같다** |
| TC-MVN-10b | 인라인 스크립트 하나를 바꾸면 그 해시도 바뀐다 |
| TC-MVN-10c | (e2e) 첫 페인트에 저장된 테마 색이 적용된다 — `boot-screen` V-1·V-3 |

### 4.3 게이트

| ID | 확인 |
|---|---|
| TC-MVN-11 | `grep -rn 'jsdelivr' web/ internal/` 이 0건 |
| TC-MVN-12 | `scripts/check-vendor.sh` 가 통과한다 |
| TC-MVN-13 | monaco 파일 하나를 바꾸면 `check-vendor.sh` 가 실패한다 |
| TC-MVN-14 | 바이너리 크기가 21.4MB 이하다 (NFR-MVN-2) |

### 4.4 브라우저 (e2e)

| ID | 확인 |
|---|---|
| TC-MVN-15 | **외부 요청을 전부 끊은 채** 파일을 열면 편집기가 뜨고 내용이 보인다 |
| TC-MVN-16 | 같은 조건에서 Diff 뷰가 뜬다 |
| TC-MVN-17 | 페이지가 `cdn.jsdelivr.net` 으로 요청을 **하나도** 보내지 않는다 |

### 4.5 보존 확인 (회귀)

편집기 저장·찾기·LSP 이동 e2e 통과 · `index.html` 판 치환 통과 ·
정적 자산 ETag/304 통과.

---

## 5. 비목표 (Non-goals)

1. **기능 트림.** `nls/lang`(1.6MB)·TypeScript 언어 서비스(13.1MB)를 크기를 이유로
   빼지 않는다. 사전압축이 크기 문제를 없앴으므로 그 거래를 할 이유가 사라졌다.
   빼면 "무엇이든 열린다" 는 성격과 JS/TS 의 내장 IntelliSense 를 내주게 된다.
2. **커스텀 번들.** esbuild/webpack 으로 필요한 모듈만 재는 길은 더 작아지지만
   빌드에 번들 단계를 만든다. `min/vs` 를 그대로 담는 것이 제약(§2.7)에 맞다.
3. **다른 벤더 자산의 사전압축.** 아홉 개 합계가 600KB 미만이라 얻는 것이 없다.
   규칙(FR-MVN-6)은 전역이므로 나중에 필요하면 파일만 바꾸면 된다.
4. **Brotli.** gzip 이 모든 대상 브라우저에 있고, 추가 이득이 빌드·검증의 두 벌을
   만들 만큼 크지 않다.
5. **monaco 판 올리기.** 0.56.0 을 그대로 담는다. 판 갱신은 별도 변경이다.
6. **`web/vendor` 밖의 자산 서빙 규칙.** `index.html`·`js/**` 는 그대로다.

---

## 6. 기존 문서 개정

**`VENDOR_VERSIONS.md`** — "벤더링되지 **않은** 것" 절이 monaco 를 지목하며 "이
마일스톤의 범위가 아니다" 로 끝난다. 그 절을 지우고 표에 디렉터리 자산 줄을 더한다.
갱신 절차도 디렉터리를 다루도록 고친다.

**`M2_PROGRESS.md` §4`** — "min/vs 약 5MB → 바이너리 약 21MB" 는 gzip 크기를 raw 로
잘못 적은 것이다(§2.1). 실측값과 이 문서의 결정으로 대체한다.

**`static.go:56-60` 의 주석** — "`script-src` 에 외부 호스트가 하나 남아 있다 … 별도
결정" 이 더는 사실이 아니다. 그 결정이 이 문서다.

---

## 7. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-10 | 초안. 사용자 결정(사전압축 벤더링) 뒤 작성. |
| 2026-09-10 | 구현·검증 완료. 바이너리 15.64MB → 21.15MB. `FR-MVN-13a`(CSP 해시)는 구현 중 드러난 첫 페인트 회귀를 닫으려고 더해졌다. |
