# SRS: 스킴 없는 도메인 링크 — `naver.com` 도 누르면 열린다 (IEEE 29148 준수)

> **문서 상태**: 승인·구현완료

| 항목 | 값 |
|---|---|
| 문서 | BARE_DOMAIN_LINK_SRS |
| 관련 | `BROWSER_TAB_SRS` FR-BRT-68(링크 클릭의 한 길 `app.openLink`) · `DOC_RENDER_VIEW_SRS` FR-DRV-28(문서 링크) |
| FR 접두 | FR-BDL |

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수(2026-09-27):

> `https://naver.com` 이 아니라 `naver.com` 도 링크로 연결되게 하고 싶은데

터미널 출력과 문서 렌더에서 스킴 없이 적힌 도메인(`naver.com`·`www.x.com`·`naver.com/path`)을 링크로
잡는다. 누르면 스킴이 붙은 링크와 **같은 길**(`app.openLink`)로 열린다.

### 1.2 범위 (Scope)

- 포함: 터미널(xterm)의 링크 감지, 문서 렌더(markdown)의 linkify.
- 비포함: 편집기(Monaco)의 링크, 브라우저 탭 주소창, 이메일 주소, IP 주소, `localhost:<포트>`,
  파일 경로를 파일 링크로 여는 것.

### 1.3 정의 (Definitions)

- **맨 도메인**: 스킴(`http://` 등) 없이 적힌 `<이름>.<TLD>[/경로]`. 판정은 linkify-it 의 fuzzy link 다.
- **linkify-it**: `web/vendor/markdown-it.js`(15.0.1)에 들어 있는 링크 감지기. `markdownit().linkify` 로 꺼낸다.
- **기준 폴더**: 터미널은 그 도구의 cwd(`Cwd` OSC 로 받은 `_cwd`), 문서는 그 문서 파일의 폴더.

## 2. 현재 상태와 검증된 사실

1. 터미널은 `WebLinksAddon` 이 `https?://` 로 시작하는 것만 잡는다 (`web/js/ui/term-pane.js` `_loadAddons`).
2. 문서 렌더는 `markdownit({linkify: true})` 이지만 markdown-it 15 의 기본이 `fuzzyLink: false` 라
   스킴 있는 것만 잡는다(실측).
3. linkify-it 의 fuzzy 판정(실측, 번들 판):

| 입력 | 잡힘 | url |
|---|---|---|
| `naver.com` · `a.co.kr` · `www.x.com` · `github.com/a/b` | 예 | `http://…` |
| `README.md` · `app.py` | **예** — `md`·`py` 가 국가 TLD 다 | `http://README.md` |
| `main.go` · `v1.2.3` · `foo.bar` · `1.2.3.4` · `localhost:3000` | 아니오 | — |
| `docs/README.md` · `./a.md` · `/abs/b.md` · `src/x.rs` | 아니오 — 앞이 `/` 다 | — |

   그러므로 오탐은 **맨 이름으로 적힌 파일**뿐이다.
4. `/api/file/stamps` 는 절대 경로 목록을 받아 **있는 파일만** 답한다(없음·디렉터리·읽을 수 없음은 빠진다).
   경로 경계가 없다(`/api/file/read` 와 같다).

### 2.1 사용자 결정 (2026-09-27)

- **D-BDL-1** 터미널과 문서 렌더 둘 다에 적용한다.
- **D-BDL-2** 파일 이름 오탐은 **기준 폴더에 그 이름의 파일이 실제로 있는지**로 가른다(안 A). 확장자형 TLD 를
  규칙으로 빼는 안(B)은 기각 — 실제 도메인(`x.md`)까지 막는다.

### 2.2 설계 결정

- **D-BDL-3** 감지기는 번들된 linkify-it 을 쓴다 — 새 vendor 파일이 없다. TLD 목록은 linkify-it 기본이다
  (일반 TLD 몇 + 두 글자 국가 TLD 전부). `dev`·`app` 같은 새 gTLD 는 잡히지 않는다 — 스킴을 붙이면 된다.
- **D-BDL-4** 존재 확인은 **파일만** 본다(`/api/file/stamps`). `github.com` 이라는 **폴더**가 있어도 링크가 된다
  — 새 종단을 만들지 않는 쪽이 더 단순하고, 그 이름을 누르면 그 사이트가 열리는 것이 틀린 답도 아니다.
- **D-BDL-5** 확인할 수 없으면(기준 폴더를 모름·요청 실패) 링크로 둔다. 링크를 놓치는 것보다 파일 이름 하나가
  링크가 되는 쪽이 덜 해롭고, 누르면 그 결과가 보인다.
- **D-BDL-6** 터미널은 줄 단위로 판정한다. 줄바꿈으로 갈린 맨 도메인은 잡지 않는다.

## 3. 요구사항 (Requirements)

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-BDL-1 | `bareLinks(text)` 는 `text` 의 맨 도메인들을 `{index, lastIndex, text, url}` 로 돌려준다. 스킴이 있는 링크·이메일은 돌려주지 않는다 — 스킴 있는 것은 기존 경로(`WebLinksAddon`·markdown-it)가 잡는다. `url` 은 linkify-it 의 정규화(`http://` 를 붙인다)다. | 필수 |
| FR-BDL-2 | `bareLinkFiles(names, dir)` 는 `dir` 기준으로 `names` 중 **있는 파일**의 이름 집합을 돌려준다. 한 번의 `/api/file/stamps` 로 묻는다. `dir` 이 비었거나 요청이 실패하면 빈 집합이다 (D-BDL-5). | 필수 |
| FR-BDL-3 | 같은 `(dir, name)` 의 답은 짧게(5초) 기억한다 — 마우스가 한 줄 위를 움직일 때마다 묻지 않는다. | 필수 |
| FR-BDL-4 | 터미널: 줄에 맨 도메인이 있고 그것이 기준 폴더의 파일이 아니면 링크다. 누르면 `app.openLink(url, event)` 로 간다 (FR-BRT-68 과 같은 길). | 필수 |
| FR-BDL-5 | 문서 렌더: 맨 도메인이 링크가 된다(`fuzzyLink: true`; 이메일 판정은 종전 그대로). 그리고 나서 그 문서 폴더에 같은 이름의 파일이 있으면 그 링크는 **글자로 되돌린다.** 스킴 있는 링크·markdown 링크 문법(`[a](b)`)은 건드리지 않는다. | 필수 |
| FR-BDL-6 | 문서 렌더의 맨 도메인 링크는 누르면 `app.openLink` 로 간다 (FR-DRV-28 의 외부 링크와 같다). | 필수 |

### 3.1 이전 동작 / 새 동작 / 이유

| 자리 | 이전 | 새 | 이유 |
|---|---|---|---|
| 터미널 | `naver.com` 은 글자 | 링크 | 접수 |
| 문서 렌더 | `naver.com` 은 글자 | 링크 (그 폴더의 파일 이름이면 글자) | D-BDL-1 |

## 4. 검증 (Verification)

| ID | 확인 |
|---|---|
| TC-BDL-1 | JS 단위: `bareLinks` 가 §2 표의 "예" 를 잡고 "아니오" 는 잡지 않는다. `https://a.com`·`me@x.com` 은 돌려주지 않는다 (FR-BDL-1) |
| TC-BDL-2 | JS 단위: `bareLinkFiles` 가 `dir` + 이름을 한 요청으로 묻고, 답에 있는 이름만 돌려준다. `dir` 이 비면 묻지 않고 빈 집합, 요청 실패면 빈 집합 (FR-BDL-2) |
| TC-BDL-3 | JS 단위: 5초 안의 같은 질문은 다시 묻지 않고, 지나면 다시 묻는다 (FR-BDL-3) |
| TC-BDL-4 | e2e: 터미널에 `echo naver.com README.md` — 그 cwd 에 `README.md` 파일이 있을 때 `naver.com` 위는 링크(밑줄)이고 누르면 `app.openLink` 가 `http://naver.com` 으로 불린다. `README.md` 위는 링크가 아니다 (FR-BDL-4) |
| TC-BDL-5 | e2e: 문서 렌더 — `naver.com` 은 `a[href="http://naver.com"]`, 같은 폴더에 있는 `notes.md` 는 링크가 아니다. `https://a.com` 과 `[t](https://b.com)` 는 그대로 링크다 (FR-BDL-5·6) |

## 5. 비목표 (Non-goals)

1. 파일 이름을 파일 링크(편집기로 열기)로 만드는 것.
2. 새 gTLD 전체 목록(IANA) — D-BDL-3.
3. 편집기(Monaco)·브라우저 탭 주소창.

## 6. 리스크

- LOW: 링크 감지와 표시만 바뀐다. 여는 길은 기존 `app.openLink` 다.
- 잔여: 기준 폴더를 모르는 터미널(셸이 `Cwd` 를 알리지 않는다)에서는 맨 파일 이름이 링크가 된다 (D-BDL-5).

## 7. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-27 | 초안 · 사용자 결정 D-BDL-1·2 반영 |
| 2026-09-27 | 구현 — `web/js/ui/bare-link.js`(감지·파일 확인·xterm 공급자), `term-pane.js` `_loadAddons`, `doc-render.js`(`fuzzyLink` + `data-bare` 표 + 그린 뒤 되돌리기). TC-BDL-1~5 통과. 구현 중 결정: 문서 렌더의 이메일 판정(`fuzzyEmail`)은 종전 그대로 둔다 — 이 문서의 범위가 아니다 |
