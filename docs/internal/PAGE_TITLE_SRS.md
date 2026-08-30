# SRS: 페이지 제목 설정 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 요구는 한 줄이다.

> **"세팅에서 페이지 title 바꿀 수 있는 기능으로 저장되어야해"**

지금 브라우저 탭에 뜨는 이름은 `Dongminal` 하나로 고정돼 있다. 한 사람이 여러
호스트(집·회사·서버)에 dongminal 을 띄우면 탭이 전부 같은 이름이라 **어느 탭이
어느 기계인지 탭 줄에서 구분되지 않는다.** 요구는 그 이름을 사용자가 정하고,
그 값이 다시 접속해도 남게 하는 것이다.

### 1.2 범위 (Scope)

**포함**

| 묶음 | 내용 |
|---|---|
| **A** 입력 | Settings ▸ Display 의 텍스트 입력 한 칸 |
| **B** 저장 | `/api/settings` 블롭의 `pageTitle` 키. 서버가 가지므로 브라우저를 가리지 않는다 |
| **C** 반영 | `document.title`. 주의 배지 `(n)` 와의 합성을 한 자리로 모은다 |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **페이지 제목** | `document.title` — 브라우저 탭·창 제목에 보이는 문자열 |
| **기본 이름** | `Dongminal`. 설정이 비었을 때 쓰는 값 |
| **주의 배지** | 주의 알림 개수를 제목 앞에 붙이는 `(n) ` 접두 (FR-PAN-13b) |
| **설정 블롭** | `/api/settings` 가 주고받는 JSON. 서버는 해석하지 않는다 |

### 1.4 참조 (References)

- [`./CONVENIENCE_SRS.md`](./CONVENIENCE_SRS.md) — FR-TAN-19. 브라우저별이 아니라
  **서버**에 사는 표시 설정의 선례
- [`./UX_REVISION_SRS.md`](./UX_REVISION_SRS.md) — FR-KEY-6. 같은 선례
- [`./ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS.md`](./ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS.md)
  — FR-PAN-13b (제목 배지). 이번 작업이 그 합성 지점을 건드린다

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 제목을 쓰는 자리는 둘이다

| 자리 | 값 |
|---|---|
| `web/index.html:9` `<title>` | 문서 최초 제목 `Dongminal` |
| `web/js/core/app-attn.js:179` `_attnRefresh` | `(n) ` + `'Dongminal'` 리터럴 |

두 번째가 제약이다. 주의 알림이 생기거나 사라질 때마다 **제목 전체가 다시 쓰이므로**,
설정값을 어딘가에서 `document.title` 에 넣기만 해서는 다음 `_attnRefresh` 에 지워진다.
합성 자리는 하나여야 한다.

### 2.2 설정 블롭은 서버가 해석하지 않는다

`internal/webserver/httpapi/handlers_settings.go` 는 받은 바이트를 그대로
`<dataDir>/settings.json` 에 쓰고 그대로 돌려준다. 키를 하나 늘리는 데 **서버 변경이
필요 없다.**

### 2.3 블롭은 PUT 이 전체를 갈아치운다

`_saveSettings`(`app-settings.js:11`)가 읽어 쓰는 값을 전부 실어 보낸다. 새 키를 이
목록에 넣지 않으면, 다른 설정을 건드리는 순간 조용히 사라진다.

### 2.4 자산을 고치면 `?v=` 를 올려야 한다

`web/version_test.go` 가 강제한다 — `web/js/**`·`style.css` 가 바뀌면
`index.html` 의 `?v=` 와 `web/assets.lock` 을 함께 올려야 테스트가 선다.

---

## 3. 기능 요구사항 (Functional Requirements)

### 3.1 묶음 A — 입력

- **FR-PGT-1** Settings ▸ Display 패널 첫 줄에 `페이지 제목` 텍스트 입력(`#ds-title`)이
  있다. 무엇을 위한 값인지 알리는 안내문(`.ds-hint`)이 뒤따른다.
- **FR-PGT-2** 입력은 60자를 넘겨 받지 않는다(`maxlength`). 탭 줄에서 잘려 보이는
  이름은 이 기능의 목적을 이루지 못한다.
- **FR-PGT-3** 모달을 열 때 입력값은 현재 설정값으로 채워진다. 설정된 적 없으면 빈 칸이며,
  빈 칸이 곧 "기본 이름을 쓴다"는 뜻이다(FR-PGT-6).

### 3.2 묶음 B — 저장

- **FR-PGT-4** 값은 설정 블롭의 `pageTitle` 키로 서버에 저장된다. 브라우저·기기를
  가리지 않고 같은 서버에 붙은 모든 화면이 같은 제목을 쓴다.
- **FR-PGT-5** 저장은 입력이 멎은 뒤 500ms 에 한 번 나간다. 글자마다 PUT 을 보내지 않는다.
- **FR-PGT-6** `_saveSettings` 가 싣는 키 목록에 `pageTitle` 이 들어간다 (§2.3).

### 3.3 묶음 C — 반영

- **FR-PGT-7** 실효 제목은 한 함수(`effectiveTitle()`)가 정한다: 설정값의 앞뒤 공백을
  덜어 낸 것이 비어 있지 않으면 그것, 비어 있으면 기본 이름 `Dongminal`.
- **FR-PGT-8** `document.title` 을 쓰는 자리는 하나(`_applyPageTitle()`)로 모은다.
  주의 배지 합성(`(n) ` 접두)은 그 안에서 일어나고, `_attnRefresh` 는 그것을 부른다.
- **FR-PGT-9** 입력 중에는 저장을 기다리지 않고 제목이 즉시 바뀐다 — 지금 고치는 값이
  탭에서 어떻게 보이는지가 곧바로 보여야 한다.
- **FR-PGT-10** 페이지를 열 때 저장된 값을 읽어 제목에 적용한다. 저장값이 없으면
  `<title>` 이 가진 기본 이름 그대로다.
- **FR-PGT-11** 자산이 바뀌므로 `index.html` 의 `?v=` 와 `web/assets.lock` 을 올린다 (§2.4).

---

## 4. 검증 (Verification)

| ID | 검증 | 수단 |
|---|---|---|
| **V-PGT-1** | Display 패널에 제목 입력이 있고, 입력하면 `document.title` 이 즉시 그 값이 된다 | e2e |
| **V-PGT-2** | 새로고침 뒤에도 그 제목이 유지된다 | e2e |
| **V-PGT-3** | 값을 비우면 제목이 `Dongminal` 로 돌아가고, 새로고침 뒤에도 그렇다 | e2e |
| **V-PGT-4** | 다른 설정(테마)을 바꿔도 제목 설정이 살아남는다 (§2.3) | e2e |
| **V-PGT-5** | `?v=`·`assets.lock` 계약 | `go test ./web` |

---

## 5. 확정 결정 (Decisions)

- **D-1 서버 저장이다 (브라우저별 아님).** 선례가 둘 있다(FR-TAN-19·FR-KEY-6). 제목은
  "이 서버가 무엇인가"를 말하는 값이지 이 브라우저의 취향이 아니다. 기기를 옮겨도
  같은 이름이 서야 한다.
- **D-2 기본값은 빈 문자열이다.** `'Dongminal'` 을 초기값으로 넣으면 사용자가 지웠을 때와
  설정한 적 없을 때가 구별되지 않는다. 비어 있음이 기본을 뜻한다(FR-PGT-7).
- **D-3 검증(길이 외)은 하지 않는다.** 제목은 텍스트 노드가 아니라 `document.title` 로
  들어가므로 마크업으로 해석되지 않는다. 이스케이프할 것이 없다.
- **D-4 서버는 건드리지 않는다.** 블롭은 불투명하다(§2.2).

---

## 6. 비목표 (Non-goals)

1. 브라우저 탭마다 다른 제목 — 값은 서버의 것이다(D-1).
2. 창·도구·현재 탭 이름을 제목에 넣는 동적 서식(`{window}` 같은 치환).
3. PWA manifest 의 앱 이름·favicon 변경.
4. 사이드바 로고·모달 머리글 등 화면 안의 이름 — `document.title` 만 다룬다.
