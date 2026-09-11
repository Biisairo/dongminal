# SRS: 설정 관리 — 서술자 단일 원천 · `server.json` · 환경변수 — IEEE 29148

> **문서 상태**: 승인·구현완료

| | |
|---|---|
| 근거 | `PRODUCTION_ROADMAP` §M5 — `G5-1`(설정 스키마 단일 원천 + `config validate`) · `G5-2`(환경변수 미문서) · `G5-3`(서버 설정 파일, M4 이월) |
| 위치 | M5 **내부 순서 ②**. `TLS-2`(①) 다음이고 관측성·오류 규약보다 앞이다 |
| 성격 | 신규 파일 하나(`server.json`) + 기존 키 나열의 파생 전환 + CLI 서브커맨드 |

---

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

설정에 **원천이 없다.** 같은 키 목록이 세 곳에 손으로 적혀 있고, 서버가 자기
기동값을 어디서 받는지의 규칙이 코드에만 있으며, 환경변수 넷은 문서 어디에도 없다.

셋을 한 번에 다룬다. **나누면 서술자 표를 세 번 고친다.**

### 1.2 범위 (Scope)

**포함**

| 묶음 | 내용 |
|---|---|
| **S** 서술자 | 브라우저 설정 키의 **단일 원천** — 키·타입·범위·기본값 |
| **D** 파생 | `_saveSettings` 의 키 나열과 `BACKUP_KEYS` 가 그 표에서 파생된다 |
| **C** CLI | `dongminal config show` · `dongminal config validate` |
| **F** 파일 | `server.json` — 서버 기동값의 파일 계층 |
| **P** 우선순위 | **플래그 > 환경변수 > 파일 > 기본값** |
| **E** 환경변수 | 14개 전수 문서화 + `PORT` 비숫자 거부 |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **설정 블롭** | `/api/settings` 가 주고받는 JSON. `<home>/settings.json` 에 그대로 쓰인다 |
| **서술자 표** | `web/js/core/settings-schema.js` 의 `SETTINGS_SCHEMA`. 블롭 키의 단일 진실 |
| **서버 설정** | 서버가 **뜨기 위해** 읽는 값(host·port·로그). 블롭과 다른 파일에 산다 |
| **해석하지 않는다** | 서버가 **런타임 동작을 그 값으로 가르지 않는다**는 뜻이다. 요청으로 불린 진단이 그것을 읽는 것은 해석이 아니다 (§2.4 판정) |

### 1.4 참조 (References)

- [`./SETTINGS_PORTABILITY_SRS.md`](./SETTINGS_PORTABILITY_SRS.md) — §3.1 이식 표, D-1
  (서버는 블롭을 해석하지 않으므로 종단을 새로 파지 않는다)
- [`./POLL_INTERVAL_SETTINGS_SRS.md`](./POLL_INTERVAL_SETTINGS_SRS.md) — `POLL_SETTINGS`.
  **이 저장소에 이미 있는 서술자 표의 선례**이고 이 문서는 그것을 넓힌다
- [`./REQUEST_GATE_SRS.md`](./REQUEST_GATE_SRS.md) — `FR-RQG-24`. 호스트 판정의 단일 원천
- [`./CLI_CONSOLIDATION_SRS.md`](./CLI_CONSOLIDATION_SRS.md) — 액션 디스패치와 옵션 해석

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 같은 키 목록이 세 곳에 있다

| 자리 | 무엇 |
|---|---|
| `app-settings.js:18` | `_saveSettings` 의 PUT 본문 — **키 20개를 인라인으로 나열** |
| `app-settings.js:326` | `_settingsApply` — 같은 키를 **받는 쪽**에서 다시 나열 |
| `SETTINGS_PORTABILITY_SRS §3.1` | 이식 표 — 문서에만 있다 |

> **로드맵의 "24키" 는 낡은 값이다.** 실측은 **20** 이다(`themeName` `customTheme`
> `shortcuts` `statusBar` `agentsPollInterval` `statsInterval` `gitStatusInterval`
> `gitReposInterval` `gitConsoleInterval` `layoutPresets` `defaultPreset`
> `fgTabNames` `blockBrowserKeys` `pageTitle` `confirmLeave` `editorWordWrap`
> `tabFixedWidth` `tabWidthPx` `focusEdgeLevel` `attnEdgeLevel`). **문서를 근거로
> 코드를 단정하지 않는다** — 이 마일스톤이 반복해 만나는 자리다.

`_saveSettings` 의 주석이 그 위험을 이미 적고 있다 — *"블롭 전체를 갈아치우므로
읽어 쓰는 값은 전부 실어야 한다 — 여기서 빠지면 다른 설정을 건드릴 때 조용히
사라진다."* **그 계약의 집행자가 사람의 눈**이라는 것이 결함이다.

### 2.2 범위 검사는 키마다 흩어져 있다

`POLL_SETTINGS` 는 주기 다섯을 표로 묶었다(`FR-PIS-7`). 나머지는 각자다 —
`focusEdgeLevel` 은 `0..UFE_LEVEL_MAX` 를 `_settingsApply` 안에서 직접 보고,
`attnEdgeLevel` 은 같은 모양을 한 줄 아래에서 다시 적는다. **표가 이미 하나
있는데 그 표가 다섯 개만 덮고 있다.**

### 2.3 서버 기동값에 파일 계층이 없다

지금 서버 기동값의 출처는 **둘**이다 — 플래그와 환경변수. 기계마다 다른
기동값(포트·바인드 주소·로그 자리)을 고정하려면 셸 프로필이나 래퍼 스크립트가
필요하고, 그것은 dongminal 이 관리하지 않는 자리다.

### 2.4 `settings.json` 을 서버가 해석하게 할 것인가 — **판정: 뒤집지 않는다**

`SEC-27` 잔여가 열어 둔 물음이고 로드맵이 *"`G5-1` 이 정확히 그 결정을 건드린다"*
고 적었다. **판정: 런타임 해석은 도입하지 않는다.**

근거 셋이다.

1. **해석은 소비자가 있을 때만 뜻이 있다.** 서버에는 이 값을 읽을 이유가 지금도
   앞으로도 없다 — 테마·단축키·상태바는 브라우저의 것이다. 판만 붙이고 아무도
   읽지 않으면 그 판은 **다음 사람에게 "서버가 본다" 는 거짓 신호**가 된다.
2. **거절의 대가가 비대칭이다.** 서버가 해석하면 스키마 밖의 키를 거절해야 하고,
   그러면 **판이 앞선 브라우저가 뒤진 서버에 설정을 저장하지 못한다.** 지금은
   `FR-SFD-15` 가 워크스페이스에만 그 엄격함을 걸고 있으며 그것으로 충분하다 —
   워크스페이스는 서버가 실제로 해석한다.
3. **요구된 것은 검증이지 해석이 아니다.** `G5-1` 의 DoD 는 `config validate` 다.
   그것은 **사람이 부를 때만 도는 진단**이고, 요청 경로에 없다.

그러므로 `SEC-27` 잔여의 `settings.json` 쪽은 **닫힌다** — 조치는 "판을 붙인다"
가 아니라 **"검증할 수단을 준다"** 이며 그것이 묶음 C 다. `access.json` 쪽은
서버가 실제로 해석하므로 사정이 다르나, 그 파일은 이미 `accessStore` 가 모르는
키를 무시하고 깨지면 fail-closed 한다(`FR-RQG-21`) — **남은 위험이 없어 이번에
함께 닫는다.**

### 2.5 환경변수 14개 중 문서에 없는 것이 5개다

| 변수 | 자리 | 문서 |
|---|---|---|
| `PORT` | `options.go:26` | ✅ |
| `DONGMINAL_HOME` | `dmenv.go` | ✅ |
| `DONGMINAL_HOST` | `dmenv.go` | ✅ |
| `DONGMINAL_PORT` | `dmenv.go` | ✅ |
| `DONGMINAL_LOG` | `options.go:29` | ✅ |
| `DONGMINAL_RESTART_RUNNER` | `options.go:33` | ❌ |
| `DONGMINAL_TOOL_ID` | `dmenv.go` | ✅ |
| `DONGMINAL_TOOL_HOME` | `dmenv.go` | ✅ |
| `DONGMINAL_HISTFILE` | `dmenv.go` | ✅ |
| `DONGMINAL_ATTENTION_IDLE_MS` | `attention.go:57` | ❌ |
| `DONGMINAL_ATTENTION_BELL` | `attention.go:72` | ❌ |
| `DONGMINAL_CMD_RESULT_TIMEOUT_MS` | `commands.go:97` | ❌ |
| `DONGMINAL_URL_OPEN` | `openurl.go:29` | ❌ |
| `DONGMINAL_SHELL` | `shell.go:237` | ❌ |
| `DONGMINAL_LOG_LEVEL` | (이 문서가 신설) | ❌ |

> **로드맵은 "상수 9 + 흩어진 4 = 13" 이라 적었다.** 실측은 다르다.
> `DONGMINAL_SHELL` 이 집계에서 통째로 빠져 있었고, `DONGMINAL_RESTART_RUNNER` 는
> "상수 9" 에 들어 문서화된 것으로 셌으나 **`getting-started.md` 의 표에 없었다**
> — 상수로 선언된 것과 문서에 실린 것은 다른 물음이다.
>
> 문서에 없던 것은 **여섯**이고, 이 문서가 `DONGMINAL_LOG_LEVEL` 을 신설하므로
> 표는 **15개**(+`PORT`·`BINARY`)가 된다. 다시 세지 않아도 되도록
> **`scripts/check-env-docs.sh` 가 양방향으로 센다** (FR-CFG-18).

### 2.6 `PORT` 비숫자 값이 `net.Listen` 까지 간다

`PORT=abc` 로 띄우면 해석 단계가 통과하고 `net.Listen("tcp", "127.0.0.1:abc")`
가 실패한다. 사용자가 보는 것은 주소 해석 오류이며 **어느 변수가 잘못됐는지가
없다.**

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 S — 서술자 표

**FR-CFG-1** 블롭 키의 단일 원천은 `web/js/core/settings-schema.js` 의
`SETTINGS_SCHEMA` 다. 각 서술자는 다음을 갖는다.

| 필드 | 뜻 |
|---|---|
| `key` | 블롭의 키 |
| `type` | `string`·`bool`·`int`·`object`·`array`·`any` |
| `def` | 기본값. 저장된 적 없을 때의 값 |
| `min`·`max` | `int` 의 범위 (선택) |
| `off` | `0` 이 "그 계층을 걸지 않는다" 를 뜻하는가 (주기 전용, `FR-PIS-9`) |
| `where` | Settings 창의 자리. 문서와 `config show` 가 함께 쓴다 |

**FR-CFG-2** 이 파일은 **`const SETTINGS_SCHEMA = <JSON 배열>;` 한 줄 형태**를
지킨다. JS 표현식을 쓰지 않는다 — Go 가 같은 바이트를 JSON 으로 읽기 때문이다
(`FR-CFG-10`). 형태가 깨지면 검사가 잡는다(`TC-CFG-3`).

> **왜 생성기가 아니라 형태 제약인가.** 생성기를 두면 원천이 Go 로 가고 JS 는
> 산출물이 된다 — 그러면 `make gates` 밖에서 JS 를 고친 사람이 조용히 되돌려진다.
> 형태 제약은 **두 언어가 같은 바이트를 읽게** 하며 중간 산출물을 만들지 않는다.

**FR-CFG-3** 범위 밖·타입 밖의 값은 **기본값으로 떨어진다.** 손으로 고친
`settings.json` 하나가 화면을 통째로 반전시키지 않는다 (`FR-UFE-12`·`FR-AED-9`
가 이미 개별로 적은 규약을 표로 올린다).

### 3.2 묶음 D — 파생

**FR-CFG-4** `_saveSettings` 의 PUT 본문은 `SETTINGS_SCHEMA` 를 돌며 만들어진다.
키를 인라인으로 나열하지 않는다.

**FR-CFG-5** 값을 읽고 얹는 방법은 `app-settings.js` 의 `SETTINGS_ACCESS` 가
갖는다 — 전역 변수를 직접 만지므로 JSON 에 담을 수 없다(`FR-CFG-2`). **두 표의 키
집합이 같아야 하고 그것을 검사가 강제한다**(`TC-CFG-1`).

> 표가 둘인 것은 타협이 아니라 경계다. **데이터는 두 언어가 읽고 접근자는 한
> 언어만 실행한다.** 접근자를 JSON 에 넣으려면 문자열로 담아 `eval` 해야 하고,
> 그러면 표가 코드가 되어 Go 쪽이 읽을 수 없다. 빠뜨림은 게이트가 막는다 —
> 종전에는 **세 벌이 아무 게이트 없이** 흩어져 있었다.

**FR-CFG-6** 표에 있으나 `SETTINGS_ACCESS` 에 `get` 이 없는 키는 **PUT 본문에서
빠진다.** 아직 UI 가 없는 값을 표에 적어 두는 길을 남긴다 (`FR-SPT-2` 의 "값이
설정인 것과 화면에 칸이 있는 것은 다르다" 를 잇는다).

### 3.3 묶음 C — `dongminal config`

**FR-CFG-7** `dongminal config show` 는 **실효값과 그 출처**를 낸다.
출처는 `flag`·`env`·`file`·`default` 중 하나이며 **어디서 왔는지가 값보다 중요하다**
— 안 듣는 설정을 쫓을 때 사람이 묻는 것이 그것이다.

**FR-CFG-8** `dongminal config validate` 는 `<home>/server.json` 과
`<home>/settings.json` 을 서술자에 대조해 **불일치를 전부** 낸다. 첫 오류에서
멈추지 않는다 — 고치고 다시 돌리는 왕복을 키 수만큼 시키지 않는다.

**FR-CFG-9** `validate` 는 불일치가 있으면 **exit 1** 이다. 알 수 없는 키는
**경고이지 실패가 아니다** — 판이 앞선 브라우저가 쓴 키가 여기서 빨갛게 뜨면
사용자는 멀쩡한 설정을 지운다 (§2.4 근거 2).

**FR-CFG-10** Go 쪽은 embed 된 `settings-schema.js` 를 읽어 같은 표를 얻는다.
표를 Go 에 다시 적지 않는다.

**FR-CFG-11** `config` 는 `--json` 을 받는다. 사람이 읽는 표가 기본이다.

### 3.4 묶음 F·P — `server.json` 과 우선순위

**FR-CFG-12** `<home>/server.json` 이 서버 기동값의 **파일 계층**이다. 키는 넷이다.

| 키 | 타입 | 기본 | 대응 플래그 / 환경변수 |
|---|---|---|---|
| `host` | string | `127.0.0.1` | `--expose` / `DONGMINAL_HOST` |
| `port` | string | `58146` | `--port` / `PORT`·`DONGMINAL_PORT` |
| `logLevel` | string | `info` | — / `DONGMINAL_LOG_LEVEL` |
| `logFile` | string | OS 기본 | — / `DONGMINAL_LOG` |

**FR-CFG-13** 우선순위는 **플래그 > 환경변수 > 파일 > 기본값**이다. 빈 문자열은
"정하지 않음" 이며 다음 계층으로 넘어간다.

**FR-CFG-14** `server.json` 이 없으면 **조용히 넘어간다.** 없는 것이 정상이다.

**FR-CFG-15** `server.json` 이 깨졌으면 **기동을 막지 않고 경고한 뒤 다음 계층으로
간다.** 설정 파일 하나가 서버를 못 뜨게 만들면 고칠 화면에 닿을 수 없다.

> **`access.json` 과 다른 이유**: 그쪽은 **경계**라 읽지 못하면 fail-closed 가
> 답이다(`FR-RQG-21`). 이쪽은 **편의**라 fail-open 이 답이다. 둘을 같은 규칙으로
> 묶으면 한쪽이 반드시 틀린다.

**FR-CFG-16** `server.json` 도 `platform.WriteStateFile` 의 자리를 쓴다 — 세대·원자성이
다른 상태 파일과 같다.

### 3.5 묶음 E — 환경변수

**FR-CFG-17** 환경변수 **14개 전부**가 `docs/external/getting-started.md` 의 표에
있다. 이름·뜻·기본값·범위.

**FR-CFG-18** 문서 표와 코드의 실제 이름이 어긋나면 **CI 가 잡는다**
(`scripts/check-env-docs.sh`). 문서는 조용히 낡으므로 사람의 눈을 집행자로 두지
않는다.

**FR-CFG-19** `PORT`·`DONGMINAL_PORT` 의 비숫자 값은 **`net.Listen` 전에**
거부된다. 오류 문구에 **어느 변수의 어떤 값인지**가 실린다.

---

## 4. 검증 (Verification)

### 4.1 서술자 (unit, JS)

| ID | 확인 |
|---|---|
| TC-CFG-1 | `SETTINGS_SCHEMA`·`SETTINGS_ACCESS`·`_saveSettings` PUT 본문의 키 집합이 **셋 다 같다** |
| TC-CFG-2 | 범위 밖 `focusEdgeLevel`·`attnEdgeLevel`·주기가 기본값으로 떨어진다 |
| TC-CFG-3 | `settings-schema.js` 가 `const SETTINGS_SCHEMA = <JSON>;` 형태다 (`FR-CFG-2`) |

### 4.2 Go 서술자 읽기

| ID | 확인 |
|---|---|
| TC-CFG-4 | Go 가 embed 된 표를 읽어 20개 서술자를 얻는다 |
| TC-CFG-5 | 표의 키가 `SETTINGS_PORTABILITY_SRS §3.1` 의 서버 계층과 모순되지 않는다 |

### 4.3 우선순위 (unit, Go)

| ID | 확인 |
|---|---|
| TC-CFG-6 | 플래그·환경변수·파일·기본값이 **넷 다 있을 때** 플래그가 이긴다 |
| TC-CFG-7 | 플래그만 빼면 환경변수, 둘 다 빼면 파일, 셋 다 빼면 기본값 |
| TC-CFG-8 | 빈 문자열은 "정하지 않음" 이다 — 다음 계층으로 간다 |
| TC-CFG-9 | `server.json` 없음 → 조용히 통과 |
| TC-CFG-10 | `server.json` 깨짐 → 경고 + 다음 계층. **기동을 막지 않는다** |

### 4.4 CLI

| ID | 확인 |
|---|---|
| TC-CFG-11 | `config show` 가 값과 **출처**를 함께 낸다 |
| TC-CFG-12 | `config validate` 가 범위 밖 값을 잡고 exit 1 |
| TC-CFG-13 | 알 수 없는 키는 **경고이며 exit 0** (`FR-CFG-9`) |
| TC-CFG-14 | `config validate` 가 **첫 오류에서 멈추지 않는다** — 셋을 넣으면 셋 다 나온다 |
| TC-CFG-15 | `--json` 이 기계가 읽는 형태를 낸다 |

### 4.5 환경변수

| ID | 확인 |
|---|---|
| TC-CFG-16 | `PORT=abc` → `net.Listen` 전에 거부, 문구에 변수명과 값 |
| TC-CFG-17 | `scripts/check-env-docs.sh` 가 코드의 이름 14개와 문서 표를 양방향 대조 |
| TC-CFG-18 | 탐침 — 코드에 새 변수를 넣으면 위 검사가 **실패한다** |

---

## 5. 결정 (Decisions)

| ID | 결정 | 근거 |
|---|---|---|
| **D-CFG-1** | 서버는 `settings.json` 을 **런타임에 해석하지 않는다** | §2.4. 소비자 없는 판은 거짓 신호이고, 거절은 판이 앞선 브라우저를 잠근다 |
| **D-CFG-2** | 서술자 표는 **JS 파일에 살고 Go 가 읽는다** | 생성기를 두면 원천이 Go 로 가고 JS 가 산출물이 된다 — 게이트 밖에서 고친 사람이 조용히 되돌려진다 |
| **D-CFG-3** | `server.json` 은 깨져도 **기동을 막지 않는다** | 설정 파일 하나가 서버를 못 뜨게 하면 고칠 화면에 닿을 수 없다. `access.json`(경계)과 규칙이 다른 이유다 |
| **D-CFG-4** | 알 수 없는 키는 경고이지 실패가 아니다 | 판이 앞선 브라우저가 쓴 키가 빨갛게 뜨면 사용자가 멀쩡한 설정을 지운다 |
| **D-CFG-5** | `server.json` 은 **기동값만** 담는다 | 브라우저 블롭을 여기로 옮기면 D-CFG-1 을 뒷문으로 뒤집는 셈이 된다 |

---

## 6. 비목표 (Non-goals)

1. **블롭의 런타임 해석·거절.** D-CFG-1.
2. **설정 마이그레이션 엔진.** `internal/ctl/migrate` 가 이미 있고 이 문서의 일이 아니다.
3. **`server.json` 을 UI 에서 편집하는 것.** 기동값은 기동 전에 정해진다.
4. **환경변수의 재정의(rename)·폐기.** 이름은 계약이다. 문서화만 한다.
5. **TLS·인증 관련 키.** 영구 제외다 (로드맵 결정 9).

---

## 7. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-12 | 신규. M5 `G5-1`·`G5-2`·`G5-3`. `SEC-27` 잔여의 `settings.json`·`access.json` 쪽을 §2.4 로 **판정하고 닫는다**. 로드맵의 낡은 수치 둘을 정정 — 블롭 키 **24→20**, 환경변수 **13→14**(`DONGMINAL_SHELL` 누락) |
