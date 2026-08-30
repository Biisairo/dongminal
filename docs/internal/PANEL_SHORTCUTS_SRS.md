# SRS: Background·Runs 진입점의 단축키 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 요구는 한 줄이다.

> **"bg, runs 버튼에 단축키 넣고"**

상단 툴바의 다섯 진입점 중 **`Agents` 만 단축키가 있다**(`Ctrl+Shift+A`).
`Split H`·`Split V` 는 분할 단축키로 같은 일을 할 수 있으므로 실질적으로 빠진
것은 **`Background` 와 `Runs`** 둘이다. 손을 마우스로 옮겨야만 닿는 자리가 남아 있다.

### 1.2 범위 (Scope)

`Background`(백그라운드 도구 모달)와 `Runs`(Run 오케스트레이션 모달)를 여는 동작을 앱의
단축키 체계에 편입한다. **미포함:** §5 비목표.

### 1.3 참조 (References)

- [`./SOFT_RELOAD_SRS.md`](./SOFT_RELOAD_SRS.md) — FR-SRL-9·D-6. 앱 단축키 체계에
  편입하는 방식과 **`R` 계열을 쓸 수 없는 이유**
- [`./STATUS_BAR_REFLOW_SRS.md`](./STATUS_BAR_REFLOW_SRS.md) — FR-SBR-8. `Background` 가
  상단 툴바에 선 근거
- [`./ORCHESTRATION_V2_SRS.md`](./ORCHESTRATION_V2_SRS.md) — FR-RVZ-1. `Runs` 진입점

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 체계는 이미 있고, 두 동작만 빠져 있다

단축키는 네 자리가 짝을 이룬다.

| 자리 | 하는 일 |
|---|---|
| `SHORTCUT_DEFAULTS`(`helpers.js:81`) | 동작 이름 → 기본 키 |
| `SHORTCUT_LABELS`(`helpers.js:92`) | 동작 이름 → 설정 화면의 이름 |
| `executeAction`(`app.js:225`) | 동작 이름 → 실제 함수 |
| 설정 ▸ Shortcuts | `_renderShortcutList`(`app-settings.js`)의 **하드코딩된 무리 배열**에서 그린다 |

`_bgModalToggle()` 과 `_runsModalToggle()` 은 이미 있다. **버튼만이 그것을 부르는
유일한 자리**다.

설정 목록은 자동이 아니다. 사이드바 탭 직행 키만 서술자 배열에서 파생하고
(FR-SBT-21·30), 나머지는 `_renderShortcutList` 안의 무리 배열이 이름을 나열한다 —
**동작을 더해도 그 배열에 넣지 않으면 설정 화면에 나타나지 않는다.**

### 2.2 쓸 수 있는 키가 정해져 있다

이미 쓰는 것: `Ctrl+Shift+` 의 `[`·`]`·`Tab`·방향키 넷·`H`·`V`·`N`·`T`·`W`·`D`·
`A`·`K`·`Digit1~9`, 그리고 `Ctrl+Tab`·`Ctrl+F`.

`R` 은 쓸 수 없다 — `SOFT_RELOAD_SRS` D-6 이 "브라우저가 가져가므로" 로 이미
배제했고, 그래서 내부 새로고침이 `K` 를 쓴다.

### 2.3 `dmctl` 은 이 둘을 부르지 않는다

`executeAction` 은 원격 명령(`app-cmd.js:454`)도 태우지만, 서버가 받는 액션
목록(`api.md`)에 두 모달은 없다. 이 스펙은 **브라우저 안의 단축키만** 다룬다.

---

## 3. 기능 요구사항 (Functional Requirements)

- **FR-PSC-1** `Background` 진입점을 여는 동작 `bgToggle` 이 단축키 체계에 선다. 기본은
  `Ctrl+Shift+B` 다 — `B`ackground 의 첫 글자이고 비어 있다.
- **FR-PSC-2** `Runs` 진입점을 여는 동작 `runsToggle` 이 선다. 기본은
  `Ctrl+Shift+O` 다 — 오케스트레이션의 `O` 이며, `R` 은 쓸 수 없다 (§2.2).
- **FR-PSC-3** 두 동작은 **버튼 클릭과 같은 함수**를 부른다. 여는 길이 둘로
  갈리면 한쪽만 고쳐진다.
- **FR-PSC-4** 토글이다 — 열려 있으면 닫는다. 버튼과 같은 처신이다.
- **FR-PSC-5** 설정 ▸ Shortcuts 목록에 이름과 함께 뜨고, 다른 항목처럼 바꾸고
  초기화할 수 있다. 그러려면 `_renderShortcutList` 의 무리 배열에도 넣어야 한다
  (§2.1) — 상단 툴바의 진입점 셋(`Runs`·`Background`·`Agents`)을 한 무리로 묶고, 차례를
  툴바와 맞춘다.
- **FR-PSC-6** 기본 키는 이미 쓰는 어떤 키와도 겹치지 않는다.

---

## 4. 검증 (Verification)

| ID | 검증 | 수단 |
|---|---|---|
| **V-PSC-1** | 기본 키가 기존 키와 겹치지 않는다 | e2e |
| **V-PSC-2** | `Ctrl+Shift+B` 로 백그라운드 모달이 열리고 다시 누르면 닫힌다 | e2e |
| **V-PSC-3** | `Ctrl+Shift+O` 로 Run 모달이 열리고 다시 누르면 닫힌다 | e2e |
| **V-PSC-4** | 설정 ▸ Shortcuts 에 두 항목이 이름과 함께 뜬다 | e2e |

---

## 5. 비목표 (Non-goals)

1. `Split H`·`Split V` 버튼의 단축키 — 분할 단축키가 이미 같은 일을 한다.
2. `dmctl` 에서 두 모달을 여는 원격 액션 (§2.3).
3. 모달 **안에서**의 키 조작(항목 이동·선택).
4. 기본 키의 OS 별 분기.
