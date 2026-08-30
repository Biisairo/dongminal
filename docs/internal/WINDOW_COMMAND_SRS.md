# SRS: `dongminal window` — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 요구는 두 줄이다.

> **"`--open` 명령어를 지우고, 서버를 열지 않고 단순 창만 여는 명령어를
> `dongminal window` 로 만들어줘."**

지금 창을 여는 수단은 `start --open` 하나뿐이고, 그것은 **서버를 띄우는 명령의
꼬리표**다. 이미 돌고 있는 서버에 창만 하나 더 붙이고 싶을 때 쓸 것이 없다 —
`--isolated` 없이 `start` 를 다시 부르면 **돌던 서버를 죽이고 새로 띄운다**
(`killPort`, `start.go:59`). 창을 여는 일과 서버를 띄우는 일이 한 명령에 묶여
있는 것이 문제다.

### 1.2 범위 (Scope)

| 묶음 | 내용 |
|---|---|
| **W** 새 명령 | `dongminal window` — 돌고 있는 서버에 frameless window 를 연다. 서버를 띄우지 않는다 |
| **R** 제거 | `start --open` 을 없앤다. 대체 별칭도 남기지 않는다 |
| **D** 문서 | README · getting-started · 릴리스 노트 본문의 안내를 두 명령으로 고친다 |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **frameless window** | 주소창 없는 앱 창. 조립은 `platform.Browser` 가 한다 (FR-XBR-1) |
| **준비** | `/api/ping` 이 2xx/3xx 를 주는 상태 |

### 1.4 참조 (References)

- [`./CLI_CONSOLIDATION_SRS.md`](./CLI_CONSOLIDATION_SRS.md) — FR-OPN-1~3. 이 스펙이
  그 셋을 **폐기하고** 같은 일을 독립 명령으로 옮긴다
- [`./CROSS_PLATFORM_SRS.md`](./CROSS_PLATFORM_SRS.md) — FR-XBR-1~3 (`Browser` 어댑터).
  창을 여는 수단 자체는 바뀌지 않는다

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 `--open` 은 `start` 의 마지막 한 걸음이다

`RunStart` → `startDetached` 의 순서는 이렇다 (`start.go`).

1. 홈·포트 결정, `--isolated` 가 아니면 **그 포트의 기존 서버를 죽인다**
2. 자기 자신을 `start --foreground` 로 재실행해 떼어 낸다
3. `waitReady` 로 준비를 확인한다 (0.5초 × 10회)
4. `✅ dongminal running on ...`
5. `if o.Open { openFrameless(url) }` — **여기가 전부다** (`start.go:142`)

그래서 준비 확인이 실패하면 3에서 `return 1` 이라 창은 열리지 않고(FR-OPN-1),
창 열기 실패는 경고일 뿐 종료 코드를 바꾸지 않는다(FR-OPN-3).

### 2.2 창을 여는 일 자체는 이미 독립적이다

`openFrameless(url)`(`open.go`)는 URL 하나만 받는다. 명령 조립은
`platform.Current().Browser` 가 하고, 실행은 `exec.Command(...).Start()` 다.
**옮길 것은 이 함수를 부르는 자리뿐이다.**

### 2.3 `--open` 은 문서의 첫 줄에 있다

README 의 빠른 시작과 `docs/external/getting-started.md`, 그리고 릴리스 노트
본문(`.github/workflows/release.yml` 안의 마크다운)이 `./dongminal start --open`
을 **설치 직후의 첫 명령**으로 안내한다. 지우면 그 안내가 두 명령이 된다.

### 2.4 액션 추가에는 자리가 넷이다

`Dispatch` 의 `switch`(`dispatch.go:19`) · `ParseX`(`options.go`) ·
`Usage(action)`(`help.go`) · `Help()` 의 액션 목록. 넷이 짝이 맞아야 한다.

---

## 3. 기능 요구사항 (Functional Requirements)

### 3.1 묶음 W — `dongminal window`

- **FR-WIN-1** `dongminal window` 는 돌고 있는 서버를 향해 frameless window 를
  연다. **서버를 띄우지 않고, 죽이지 않으며, 어떤 프로세스도 새로 만들지 않는다**
  (창을 여는 프로세스 외에는).
- **FR-WIN-2** 대상 주소는 `start` 와 같은 규칙으로 정한다 — `--port`(없으면
  `$PORT`, 없으면 기본 포트)와 호스트 환경변수. `0.0.0.0`·`::` 로 바인드된
  경우에도 두드리는 주소는 `localhost` 다 (`pingHost`).
- **FR-WIN-3** 서버가 준비되어 있지 않으면 **창을 열지 않고** 실패한다(rc=1).
  무엇이 없는지와 `dongminal start` 를 안내한다.
- **FR-WIN-4** 창 열기에 실패하면 이 명령은 실패다(rc=1). `start --open` 의
  FR-OPN-3(경고만)과 반대이며, 그 이유는 §5 D-3 이다.
- **FR-WIN-5** 성공하면 어떤 주소로 열었는지 한 줄로 알린다.
- **FR-WIN-6** 준비 확인은 **한 번**만 한다. 기다리지 않는다 — 이 명령은 기동을
  기다리는 명령이 아니다.
- **FR-WIN-7** `dongminal window --help` 가 사용법을 낸다. `Help()` 의 액션
  목록에도 선다 (§2.4).

### 3.2 묶음 R — `--open` 제거

- **FR-WIN-8** `start --open` 을 제거한다. `StartOpts.Open` 과 그 분기도 함께
  없앤다.
- **FR-WIN-9** `--open` 은 이제 **알 수 없는 옵션**이다 — 조용히 무시하지 않고
  기존 규약대로 사용법과 함께 거절한다(`unknownFlag`).
- **FR-WIN-10** 별칭·경고성 잔류를 두지 않는다 (D-4).

### 3.3 묶음 D — 문서

- **FR-WIN-11** README · `docs/external/getting-started.md` · 릴리스 노트 본문의
  `start --open` 을 `start` + `window` 두 줄로 고친다 (§2.3).
- **FR-WIN-12** `CLI_CONSOLIDATION_SRS` 의 FR-OPN-1~3 에 폐기 표시를 남기고 이
  문서를 가리킨다.

---

## 4. 검증 (Verification)

| ID | 검증 | 수단 |
|---|---|---|
| **V-WIN-1** | `ParseWindow` 가 `--port`·`--home`·`--help` 를 받고 모르는 옵션을 거절한다 | 단위 |
| **V-WIN-2** | 서버가 없으면 창을 열지 않고 rc=1 | 단위 (opener 주입) |
| **V-WIN-3** | 서버가 있으면 opener 가 **정확히 그 주소로** 한 번 불린다 | 단위 |
| **V-WIN-4** | opener 가 실패하면 rc=1 | 단위 |
| **V-WIN-5** | `start --open` 이 거절된다 | 단위 |
| **V-WIN-6** | `Dispatch("window")` 가 이 명령으로 간다 | 단위 |
| **V-WIN-7** | `Help()` 와 `Usage("window")` 에 항목이 있다 | 단위 |

---

## 5. 확정 결정 (Decisions)

- **D-1 창을 여는 수단은 바꾸지 않는다.** `platform.Browser` 체인 그대로다. 이
  작업은 **부르는 자리를 옮기는 것**이지 여는 방법을 바꾸는 것이 아니다.
- **D-2 서버가 죽어 있으면 열지 않는다.** 빈 화면을 띄우고 사용자가 원인을 찾게
  하는 것보다, 무엇이 없는지 말하는 편이 낫다. 이 명령은 서버를 띄우지 않기로
  했으므로(FR-WIN-1) 대신 안내한다.
- **D-3 창 열기 실패는 실패다.** `start --open` 에서 경고였던 이유는 **서버가
  본체**였기 때문이다(FR-OPN-3). 여기서는 창이 본체이므로 같은 사건이 실패가 된다.
- **D-4 `--open` 을 남기지 않는다.** 별칭으로 남기면 "서버를 띄우면서 여는 길"이
  계속 존재해 이 작업이 분리한 것이 다시 붙는다. 같은 판(1.0.2)의 CHANGELOG 와
  README 가 이전 방법을 안내한다.
- **D-5 기다리지 않는다.** `start` 는 자기가 띄운 서버를 기다릴 이유가 있지만
  (`waitReady` 10회), `window` 가 기다리는 것은 남이 띄울 때까지 기다리는 것이다.
  한 번 묻고 답한다.

---

## 6. 비목표 (Non-goals)

1. 창 여는 수단의 변경(네이티브 셸·Electron 등) — 별건이다.
2. 여러 창 관리·창 목록·닫기.
3. 원격 호스트의 서버를 겨누는 창 (`--host`).
4. `stop` 이 창을 닫는 것.
