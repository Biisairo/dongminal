# SRS: 단일 출처를 세워 놓고 안 옮긴 자리를 닫는다 — IEEE 29148

> **문서 상태**: 초안

- 접수: 2026-09-21 (프로덕션 승격 감사 1단계 · `docs/internal/refactor/` 214건 중 **묶음 B5**)
- 선행: `SAFETY_CORRECTNESS_SRS`(B1) · `KIT_APPLICATION_SRS`(B2) · `KIT_COMPONENTS_SRS`(B3) · `WORDING_COLOR_SRS`(B4).
  B2·B3 이 **외형**을, B4 가 **말과 색**을 한 벌로 만들었다. 이 문서는 그 밑의 **구조**다.
- 근거: `refactor/README.md` §2 패턴 A · §5-5 · `refactor/AUDIT-go-infra.md` HIGH 1·2·3·4 ·
  `refactor/AUDIT-fe-ui.md` M-4·M-9 · `refactor/AUDIT-fe-core.md` M3·D2·D3
- 짝: `KIT_COMPONENTS_SRS` FR-CMP-63a(클립보드 헬퍼를 B5 로 넘긴 자리) ·
  `CONFIG_MANAGEMENT_SRS` FR-CFG-13(4계층) · `FE_MODULE_BOUNDARY_SRS` §7.1·N3·N4(모듈 크기) ·
  `EXPLORER_TRANSFER_IGNORE_SRS` FR-ETR-37~44(이미 선 3단 복사)

---

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

감사가 214건을 원인별로 묶었을 때 가장 많았던 모양은 **패턴 A — "단일 출처를 세우고
호출부 일부만 옮겼다"** 였다 (`refactor/README.md` §2). B1~B4 가 그 표의 여덟 행을
닫았고, **넷이 남았다.** 이 문서는 그 넷과, 같은 원인이 **파일 크기**로 드러난 자리를
다룬다.

| 결함 | 실측 (파싱으로 파생) | 사용자가 겪는 것 |
|---|---:|---|
| 같은 textarea 복사 수법의 사본 | **4벌** (헬퍼가 이미 선 채로) | 비보안 컨텍스트에서 **복사 버튼이 조용히 아무 일도 안 한다** |
| 서버를 겨누는 방법 | **5벌** · 4계층을 지키는 것 **3개** | `server.json` 에 포트를 적으면 `stop` 이 **엉뚱한 프로세스를 죽인다** |
| `net.JoinHostPort` 사용 | **0곳** | 문서가 지원한다고 적은 `DONGMINAL_HOST=::1` 로 **서버가 안 뜬다** |
| 기본 로그 경로의 답 | **3개** | `config show`·`doctor`·`--help` 가 **없는 파일**을 가리킨다 |
| `homeLayout()` 이 모르는 홈 항목 | **8개** | `backup` 이 사용자 worktree 를 빠뜨리고 `uninstall --purge` 가 `ext/` 수백 MB 를 남긴다 |
| 500줄 초과 파일 | **26** (기준선 22) · 최대 **1,586** (기준선 1,336) | — (개발자가 겪는 것) |
| 80줄 초과 함수 | **29** | — |

**첫 항목은 클립보드다** (§3.1). 가장 좁고, B3 이 `FR-CMP-63a` 로 명시해 넘긴
유일한 항목이며, 그것이 서야 빈 상태의 주동작이 가능해진다.

### 1.2 범위 (Scope)

| 묶음 | 내용 | 축 |
|---|---|---|
| **A** 클립보드 | 이미 선 3단 복사를 **터미널 밖으로 꺼내고** 사본 4벌을 그것으로 모은다 + 게이트 | JS·도구 |
| **B** 겨냥 | `ResolveTarget` 하나로 겨누는 명령 다섯을 모으고, 주소 조립을 `net.JoinHostPort` 로 세운다 + 게이트 | Go·도구 |
| **C** 홈 | `homeLayout()` 이 **홈의 전수 목록**이 되고, 기본 로그 경로의 답이 하나가 된다 + 게이트 | Go·도구 |
| **D** 모듈 크기 | 재지 않던 DoD 를 게이트로 세우고, `renderer.js` 의 함수·파일 경계를 가른다 | JS·문서·도구 |
| **V** 탐침 | 새 게이트 넷 전부에 대해 잡는 것과 **잡으면 안 되는 것**을 확인하고 지운다 | 도구 |

**미포함:** §6.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **패턴 A** | 단일 출처를 세운 뒤 호출부의 일부만 그리로 옮긴 상태 (`refactor/README.md` §2) |
| **겨누는 명령** | 도는 서버의 host·port 를 정해 두드리는 CLI 액션 (`health`·`window`·`stop`·`migrate`·`dmctl`) |
| **4계층** | 플래그 > 환경변수 > 파일(`server.json`) > 기본값 (`CONFIG_MANAGEMENT_SRS` FR-CFG-13) |
| **홈** | `$DONGMINAL_HOME` (기본 `~/.dongminal`). `cfg.DataDir` 이 같은 자리다 |
| **증강 분할** | 클래스 정의를 두고 `Object.assign(X.prototype, …)` 으로 멤버를 다른 파일에 두는 분할 (`FE_MODULE_BOUNDARY_SRS` 묶음 B·C) |
| **구간 이동** | 코드 줄을 한 글자도 바꾸지 않고 자리만 옮기는 편집 (`SPLIT_REFACTOR_SRS`) |

### 1.4 참조 (References)

| 문서 | 관계 |
|---|---|
| `KIT_COMPONENTS_SRS` FR-CMP-63a | *"공용 클립보드 헬퍼가 없다 … 그 추출은 B5 다"* — **그 전제가 틀렸다** (§2.2) |
| `EXPLORER_TRANSFER_IGNORE_SRS` FR-ETR-37~44 · D-12·D-13 | 3단 복사는 **이미 서 있다.** 이 묶음은 그것을 옮길 뿐 설계하지 않는다 |
| `CONFIG_MANAGEMENT_SRS` FR-CFG-13 | 4계층이 계약이다. 묶음 B 는 그 계약을 **지키지 않는 다섯**을 고친다 |
| `CLI_CONSOLIDATION_SRS` FR-CLI-9 | `Common.ResolvePort` 의 3계층. 묶음 B 가 그 위에 파일 계층을 얹는다 |
| `FE_MODULE_BOUNDARY_SRS` §4.3·§7.1·N3 | 수치 DoD 와 그것을 **재지 않는** 상태. 묶음 D 가 게이트를 세우고 N3 을 개정한다 |
| `SPLIT_REFACTOR_SRS` · `FR-FMB-33` | 구간 이동의 규약 — 선행 주석은 다음 멤버의 것이다 |
| `KIT_COMPONENTS_SRS` D-CMP-5 | 게이트를 한 검사에 몰지 않는다. 이 묶음의 새 게이트 넷은 **각자 하나의 물음**을 갖는다 |
| `DAEMON_STALENESS_SRS` FR-DFP-4 | `paned.build` — 홈 항목이면서 표 밖인 자리 |
| `WINDOWS_TOOL_CWD_SRS` FR-WIN-2 | *"대상 주소를 `start` 와 같은 규칙으로 정한다"* — **주석이 말하는 불변식을 코드가 안 지킨다** |

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.0 세는 방법을 먼저 적는다 — 손으로 센 수는 이 저장소에서 **일곱 번** 표본이었다

`HANDOFF.md` §3-1 이 그 일곱을 표로 적는다. 직전 세션은 자기 SRS §2.3 에서
*"같은 그릇에 `t()` 가 섞인 자리"* 라는 **자기가 고른 규칙**으로 13을 셌고 실측은
79였다. 교훈은 *"감사를 믿지 마라"* 가 아니라 **"세는 규칙이 곧 수다"** 이다.

그래서 이 문서의 수는 전부 파싱으로 파생했고, 각 절이 **세는 방법을 적는다**
(FR-STR-2). 규칙을 적어 두면 다음 사람이 그 규칙의 사각지대를 볼 수 있다.

### 2.1 패턴 A 의 표에서 남은 것은 **넷**이다

세는 방법: `refactor/README.md` §2 의 표에서 B1~B4 의 SRS 가 FR 로 가져가지 않은 행.

| 세운 것 | 안 닿은 곳 | 누가 | 이 묶음 |
|---|---|---|---|
| ~~`apierr.CodeHeader`·`failRead`~~ | | B1 | — |
| ~~`.ui-scroll`·`UIKit.button()`·`.ui-btn`·`UIKit.dialogOpen`~~ | | B2 | — |
| ~~`t()`~~ | | B4 | — |
| `timer-hub` | 직접 `setTimeout` 하는 자리 | — | **아니다** (§6-4) |
| `dmenv.DialHost` | `dmctl`·`health`·`doctor`·`window`·`stop`·`migrate` 가 각자 | — | **묶음 B** |
| `reconcileList` | `innerHTML=''` 전량 재생성 | — | **아니다** (D-STR-6) |
| `homeLayout()` | `git-worktrees/`·`ext/`·`worktrees/` 누락 | — | **묶음 C** |

표에 없는 **다섯 번째**가 있다 — §2.2 의 클립보드다. 감사는 그것을 패턴 A 로
분류하지 않았다. `TermClipboard` 라는 이름이 "터미널 전용" 으로 읽혔기 때문이다.

### 2.2 클립보드 헬퍼는 **없는 것이 아니라 이름이 터미널을 말하고 있었다**

> **FR-CMP-63a 의 전제 정정.** B3 은 *"공용 클립보드 헬퍼가 없다;
> `git/confirm.js`·`git/dialog.js` 가 각자 textarea 수법을 갖고 있어 여기 넣으면
> **같은 수법의 세 번째 복사본**이 된다"* 로 적었다. 실측은 다르다 — 헬퍼는
> **2026-09-15 에 이미 섰고**(`EXPLORER_TRANSFER_IGNORE_SRS` 묶음 F,
> `web/js/ui/term-clipboard.js`), 사본은 둘이 아니라 **넷**이다.
>
> 그 파일의 `_execCopy` 주석이 스스로 적는다: *"Git 패널의 `_copyFallback` 과 같은
> 수법이며 …, 여기서는 성공 여부를 **돌려준다**"*. **알면서 다섯 번째를 만들었다.**
> 이것이 이 저장소에서 손으로 센 수가 표본이었던 **여덟 번째**다.

세는 방법: `web/js` 에서 ① `execCommand('copy')` ② `navigator.clipboard.writeText`
를 부르는 자리를 전부 찾고, 각각이 **몇 단까지 내려가는지** 읽는다.

| # | 자리 | 1단 `navigator.clipboard` | 2단 `execCommand` | 3단 복사창 | 성공 여부를 돌려주는가 |
|---|---|:---:|:---:|:---:|:---:|
| 0 | `ui/term-clipboard.js:74` `write` | ✅ | ✅ | ✅ | ✅ |
| 1 | `git/panel-poll.js:79` `copyText` | ✅ | ✅ | ❌ | ❌ |
| 2 | `git/dialog.js:394` `_copy` | ❌ | ✅ | ❌ | ❌ |
| 3 | `git/confirm.js:346` `_copy` | ❌ | ✅ | ❌ | ❌ |
| 4 | `core/app-tool.js:116` (샌드박스 런타임 명령) | ✅ | ❌ | ❌ | ❌ |

**4번이 결함이다.** `navigator.clipboard` 는 secure context 밖에서 **아예 없으므로**
`await navigator.clipboard.writeText(cmd)` 가 `TypeError` 로 던지고, 그것을 빈
`catch{}` 가 삼킨다 — 사용자에게는 **버튼을 눌러도 아무 일이 안 일어나는 것**으로
보인다. 그 자리의 주석은 *"복사가 막힌 환경에서도 명령은 화면에 남아 있다 — 실패를
알릴 뿐 흐름을 막지 않는다"* 라 적었는데, **알리지 않는다.**

2·3번은 secure context 에서도 1단을 건너뛰고 2단으로 간다. 제스처 안에서 도는
경로라 대개 통하지만, `execCommand` 는 **폐기된 API** 이고 그것이 이 저장소가
3단을 만든 이유다 (D-12).

### 2.3 서버를 겨누는 방법이 **다섯 벌**이고, 계약을 지키는 것은 **셋**이다

세는 방법: `serverconf.Resolve(` 와 `ResolvePort()` 의 호출부를 전부 찾고,
각 CLI 액션이 host·port 를 어디서 얻는지 읽는다.

| 명령 | host | port | 파일 계층(`server.json`) |
|---|---|---|:---:|
| `start` | `serverconf.Resolve` → `DialHost` | `serverconf.Resolve` | ✅ |
| `config show` | `serverconf.Resolve` | `serverconf.Resolve` | ✅ |
| `service install` | `serverconf.Resolve` | `serverconf.Resolve` | ✅ |
| `window` | `DefaultHost` + `os.Getenv(EnvHost)` (`window.go:26`) | `o.ResolvePort()` | ❌ |
| `health` | **`dmenv.DefaultHost` 고정** (`health.go:37`) | `o.ResolvePort()` | ❌ |
| `stop` | — | `o.ResolvePort()` (`stop.go:15`) | ❌ |
| `migrate` | — | `o.ResolvePort()` (`migrate.go:39`) | ❌ |
| `dmctl`(헬퍼) | `envOr(EnvHost, DefaultHost)` | 동 | ❌ |

`server.json` 에 `{"port":"9000"}` 한 줄을 적는 순간 갈라진다. **`stop` 이 가장 나쁘다** —
`killPort` 는 대상을 가리지 않으므로 58146 을 쓰는 **남의 프로세스에 TERM→KILL 을 보낸다.**
`migrate` 는 포트 점유 검사가 안전장치인데 엉뚱한 포트를 봐서 **무력화된다.**

`window.go:25-27` 의 주석이 직접 이렇게 적는다:

> FR-WIN-2: 대상 주소를 `start` 와 같은 규칙으로 정한다. 두 곳이 다르면
> 띄운 자리와 여는 자리가 어긋난다.

**주석이 말하는 불변식을 코드가 지키지 않는다.**

### 2.4 `net.JoinHostPort` 사용이 **0곳**이다

세는 방법: `grep -rn 'net\.JoinHostPort' --include='*.go'` → 0. 반대로
`host+":"+port` 꼴과 `fmt.Sprintf("http://%s:%s"` 꼴을 센다 → 4자리
(`cmd/dongminal/app.go:229` · `cli/start.go:359` · `helper/runtimebin/http.go:24` ·
`cli/health.go:37`).

`DONGMINAL_HOST=::1` 은 **문서가 명시적으로 지원한다고 적은 값**이다
(`docs/external/getting-started.md` — loopback 셋). 그 값으로 띄우면
`serverconf.Resolve` 를 통과하고, 자식이 `net.Listen("tcp","::1:9911")` 에서
*too many colons in address* 로 죽고, 부모는 5초 폴링 뒤 **"기동 실패" 만** 낸다.

`dmenv.normalizeHost` 가 `[::1]` 의 대괄호를 **뗀다** — 판정에는 그것이 맞고
조립에는 붙이는 것이 맞는데, **둘이 한 함수의 출력을 공유한다.**

### 2.5 `homeLayout()` 이 모르는 홈 항목이 **8개**다

세는 방법: `filepath.Join(<home|cfg.DataDir 류>, "…")` 의 **첫 조각**을 파싱으로
모으고 `homeLayout()` 의 `Name` 집합과 뺀다. 상수로 적힌 이름
(`toolipc.DaemonBuildFile`)은 정의를 따라간다.

| 항목 | 만드는 자리 | 성격 | 지금의 결과 |
|---|---|---|---|
| `worktrees/` | `cmd/dongminal/main.go:342` | Run 격리 worktree | `uninstall --purge` 가 남긴다 |
| `git-worktrees/` | `main.go:348` | **사용자 콘텐츠** (FR-WKT-13) | **`backup` 이 담지 않는다** |
| `ext/` | `main.go:365` | LSP 플러그인·언어 서버 | `--purge` 가 "전부 지웠습니다" 하고 수백 MB 를 남긴다 |
| `paned.build` | `daemon/boot/boot.go:103` | 데몬 코드 지문 (FR-DFP-4) | 남는다 |
| `doctor/` | `cli/doctor.go:288` | 진단 IPC 자리 | 남는다 |
| `doctor-tools/` | `cli/doctor.go:392` | 진단 데이터 | 남는다 |
| `doctor-probe.txt` | `cli/doctor_probe.go:204` | 진단 탐침 출력 | 남는다 |
| `verify-too-large.bin` | `cli/verify_boundary.go:53` | 413 확인용 sparse 파일 | `defer os.Remove` 가 지운다 — **`verify` 가 죽으면 남는다** |

마지막 줄은 **감사가 적지 않은 것**이다 (`AUDIT-go-infra.md` 항목 4 는 일곱을 적었다).
파싱이 여덟 번째를 찾았다 — §2.0 이 요구한 것이 이것이다.

**검사가 왜 못 잡았나.** `homelayout_test.go:32-40` 은 `rollbackTargets` 와 `homeLogs`
가 **표에 포함되는지만** 본다. 둘 다 이미 표에 있는 것들이다. **표 밖에서 홈에 쓰는
코드가 있는지**는 아무도 묻지 않는다.

### 2.6 기본 로그 경로에 답이 **셋**이다

세는 방법: `defaultLogFile()` 과 `DefaultLogFile()` 의 호출부를 전부 읽고,
각각이 어떤 값을 내는지 따라간다.

| 답 | 자리 | 누가 읽는가 |
|---|---|---|
| `<home>/server.log` | `cli/start.go:316` — **실제로 쓰이는 값** | 배경 모드 기동 |
| `/tmp/dongminal.log` | `platform/paths.go:65` → `cli/options.go:50` | `config show`·`doctor`·`start --help`·`service install` |
| `%LOCALAPPDATA%\…` | 같은 자리의 Windows 분기 | 동 |

04-secops P1-6 이 기본 로그를 옮겼는데 **그 이동이 `prepareServerCmd` 안에만 있다.**
`config show` 의 존재 이유는 FR-CFG-7 *"값이 아니라 **출처**를 말한다"* 인데,
출처는 맞고 **값이 틀렸다** — 안 듣는 설정을 쫓는 사람이 정확히 그 화면에서
없는 파일로 간다.

### 2.7 모듈 크기 DoD 가 **재고 있지 않다**

세는 방법: `web/js/**/*.js`(`vendor` 제외)의 줄 수.

| 지표 | §2.1 기준선 (2026-09-12) | §7.1 달성 기록 | **지금 실측 (2026-09-21)** |
|---|---:|---:|---:|
| `web/js` 합계 | 38,586 | — | **44,978** (+16.6%) |
| 500줄 초과 파일 | 27 | **22** | **26** |
| 최대 파일 | `ui/renderer.js` 1,336 | 1,336 | `ui/renderer.js` **1,586** (+18.7%) |

`FE_MODULE_BOUNDARY_SRS` §4.3 이 이 수치를 DoD 로 올렸는데 **그 DoD 에는 게이트가
없다.** 이 저장소의 다른 41종 게이트가 전부 "두 곳이 같은가" 를 재는데, 유일하게
수치 DoD 만 문서에 적히고 집행되지 않아 9일 만에 되돌아왔다. §4.3 이 수치를 요구한
이유(`FR-FMB-43`: *"값을 옮기는 것보다 다시 흩어지지 않게 하는 것이 본체다"*)가
**자기 자신에게 적용되지 않았다.**

80줄 초과 함수는 brace 매칭으로 **29개**다 (감사 `AUDIT-fe-core.md` M3 은 14 — `core/` 만 셌다).

| 줄 | 자리 | 줄 | 자리 |
|---:|---|---:|---|
| 228 | `ui/input-binding.js:9 bind` | 154 | `ui/renderer.js:1358 _makePane` |
| 203 | `core/app-mobile.js:163 initMobileKeybar` | 153 | `core/app.js:138 init` |
| 184 | `core/app-cmd.js:476 _execRemote` | 147 | `core/app-cmd.js:317 _applyRemoteWorkspace` |
| 184 | `core/app.js:464 save` | 145 | `core/app-layout.js:623 closeTab` |
| **168** | **`ui/renderer.js:542 _rLayout`** | 139 | `core/app-settings.js:314 initModal` |
| 161 | `ui/file-editor.js:409 _createEditor` | … | (나머지 17개) |
| 160 | `core/app-layout.js:462 addTab` | | |
| 157 | `git/panel-changes.js:147 _buildChanges` | | |
| 154 | `core/app-tool.js:223 _pickSandbox` | | |

**29 를 전부 가르지 않는다** (§6-3). 묶음 D 가 여는 것은 `renderer.js` 하나이고,
근거는 그 파일이 **최대 파일이면서 §7.1 이 수치를 명시적으로 닫은 자리**라는 것이다.

---

## 3. 요구사항 (Requirements)

### 3.0 이 묶음 전체에 걸리는 것

| ID | 요구 | 등급 |
|---|---|---|
| FR-STR-1 | **계약을 바꾸지 않는다.** 묶음 A·D 는 자리를 옮긴다. 묶음 B·C 는 **틀린 값을 고치는 것**이며 그것은 동작 변경이므로 FR-STR-5 가 적용된다 | 필수 |
| FR-STR-2 | **대상 목록을 손으로 적지 않는다.** 각 묶음의 대상은 파싱으로 **파생**하고, 파생 결과가 §2 와 어긋나면 §2 를 먼저 고친다. 이 저장소가 같은 함정에 **여덟 번** 빠졌다 (§2.0·§2.2) | 필수 |
| FR-STR-3 | **게이트를 같은 커밋에 세운다** (D-SAF-4 · 사용자 결정 2026-09-20). 고친 뒤에 세우면 고치는 동안 다시 샌다 | 필수 |
| FR-STR-4 | **게이트는 각자 하나의 물음을 갖는다** (D-CMP-5). 넷을 한 검사에 몰면 실패 메시지가 *"어딘가 구조가 틀렸다"* 가 되어 고칠 자리를 말하지 못한다 | 필수 |
| FR-STR-5 | 동작이 바뀌면 **이전 / 새 / 이유** 셋을 같은 변경에 적는다 (규약 4) | 필수 |
| FR-STR-6 | **값·이름을 바꾸기 전에 그것을 못박은 요구를 grep 으로 찾는다** (규약 8 · D-CMP-6 의 교훈) | 필수 |

### 3.1 묶음 A — 클립보드 (**첫 항목**)

| ID | 요구 | 등급 |
|---|---|---|
| FR-STR-10 | 3단 복사가 **`web/js/ui/clipboard.js` 의 `ClipboardWriter`** 로 선다. 몸통은 `term-clipboard.js` 의 `write`·`_execCopy`·`prompt`·`close`·`_watchedHere` 를 **구간 이동**한 것이고 한 줄도 바뀌지 않는다 | 필수 |
| FR-STR-11 | `TermClipboard` 는 **OSC 52 어댑터로 남는다** — `attach`·`_onOsc`·`_decode` 와 상한. 쓰기는 `ClipboardWriter.write` 에 위임한다. 이름이 그 파일이 하는 일을 말하게 된다 | 필수 |
| FR-STR-12 | **CSS 클래스(`.tc-copy*`)·카탈로그 키(`TERM_COPY_*`)·`TERM_COPY_ID` 는 그대로 둔다.** 외형도 낱말도 이 묶음의 대상이 아니고, e2e 가 그 이름을 단정한다 (FR-STR-6) | 필수 |
| FR-STR-13 | `window.TermClipboard` 는 **남는다.** e2e 와 `term-pane.js` 가 창 밖에서 부른다. `window.ClipboardWriter` 가 함께 선다 — 전역 이름이 `Clipboard` 가 **아닌 이유**는 그것이 브라우저의 인터페이스 이름이기 때문이다 (`navigator.clipboard instanceof Clipboard`) | 필수 |
| FR-STR-14 | 사본 넷이 `ClipboardWriter.write` 를 지난다 — `git/panel-poll.js`(`copyText`·`_copyFallback`) · `git/dialog.js`(`_copy`) · `git/confirm.js`(`_copy`) · `core/app-tool.js:116` | 필수 |
| FR-STR-15 | **이것은 동작 변경이다.** 이전: 1·2단이 실패하면 아무 일도 일어나지 않는다. 새: 3단 복사창이 선다. 이유: `EXPLORER_TRANSFER_IGNORE_SRS` D-12 가 *"1·2 가 실패하는 것은 환경이 정하는 것이므로 3 이 없으면 이 기능은 될 때도 있고 안 될 때도 있는 것이 된다"* 로 이미 판정했다. FR-STR-5 대로 기록한다 | 필수 |
| FR-STR-16 | `app-tool.js:116` 의 빈 `catch{}` 가 사라진다 — `ClipboardWriter.write` 는 **던지지 않고 성공 여부를 돌려준다.** 실패하면 버튼 글자가 `SBX_RT_COPIED` 로 바뀌지 않는다 (지금은 성공·실패가 구분되지 않는다) | 필수 |
| FR-STR-17 | **게이트 1**: `scripts/check-clipboard.mjs` — `web/js` 에서 `execCommand('copy')` 또는 `navigator.clipboard.writeText` 를 부르는 자리가 **헬퍼 밖에 없다.** 물음은 하나다: *"복사가 한 자리를 지나는가"* | 필수 |
| FR-STR-18 | 게이트는 **읽기(`readText`)를 잡지 않는다.** `term-pane.js:61` 의 붙여넣기는 다른 물음이고 3단 폴백이 성립하지 않는다 (브라우저가 주지 않는 것을 우회할 수 없다) | 필수 |

### 3.2 묶음 B — 겨냥

| ID | 요구 | 등급 |
|---|---|---|
| FR-STR-20 | `dmenv` 에 **조립 전용** 함수 둘이 선다. 판정용(`DialHost`·`IsExposedHost`)과 갈라 둔다 — 판정은 대괄호를 떼야 하고 조립은 붙여야 한다 (§2.4)<br>`ListenAddr(host,port)` = `net.JoinHostPort(host,port)`<br>`BaseURL(host,port)` = `"http://" + net.JoinHostPort(DialHost(host),port)` | 필수 |
| FR-STR-21 | 문자열 접합 4자리가 그것을 지난다 — `cmd/dongminal/app.go:229` · `cli.ServerURL` · `helper/runtimebin` 의 base URL · `cli/health.go` | 필수 |
| FR-STR-22 | `Common.ResolveTarget()` 이 선다. 계층은 `start` 와 같다 (FR-CFG-13 의 4계층). 돌려주는 것은 `Home`·`Host`(`DialHost` 를 지난 값)·`Port`·`URL` 과 **경고 목록**이다 — `serverconf.Resolve` 가 이미 내는 경고를 버리지 않는다 | 필수 |
| FR-STR-23 | 겨누는 명령 넷이 그것을 지난다 — `health.go` · `window.go` · `stop.go` · `migrate.go`. `RunStart` 은 이미 같은 일을 하므로 **몸통을 옮기고** `--host` 플래그만 덧댄다 | 필수 |
| FR-STR-24 | `health` 의 host 고정이 사라진다. `health.go:33-36` 의 주석이 적은 근거(*"`localhost` 가 `::1` 로 먼저 풀려 실패했다"*)는 **과교정**이며, `DialHost` 가 그 문제를 이미 푼다. 그 주석을 이전/새/이유로 고친다 | 필수 |
| FR-STR-25 | **이것은 동작 변경이다.** `server.json` 에 포트를 적어 둔 사용자에게 `stop` 의 대상이 바뀐다 — **그것이 옳다.** 지금은 남의 프로세스를 죽인다 (§2.3) | 필수 |
| FR-STR-26 | `dmctl`(`helper/runtimebin`)은 **`cli` 를 import 할 수 없다** (축 경계 — `check-pkg-axis.sh`). 그쪽은 `dmenv.BaseURL` 까지만 지나고 파일 계층은 **범위 밖**이다. 그 사실을 `runtimebin` 머리말에 사유로 적는다 (D-STR-3) | 필수 |
| FR-STR-27 | **게이트 2**: `scripts/check-server-target.sh` — ① `internal/**`·`cmd/**` 에 host+":"+port 꼴 접합이 없다 ② 겨누는 명령의 파일이 `ResolveTarget` 을 지난다. 물음은 하나다: *"겨누는 자리가 한 규칙을 지나는가"* | 필수 |

### 3.3 묶음 C — 홈

| ID | 요구 | 등급 |
|---|---|---|
| FR-STR-30 | `homeLayout()` 이 §2.5 의 여덟을 담는다. `What` 은 비울 수 없다 (`uninstall --dry-run` 의 목록이 곧 안내다) | 필수 |
| FR-STR-31 | `git-worktrees/` 는 **`Backup: false`** 다 (D-STR-4). 목록에는 **있어야** `uninstall` 이 그것을 지운다고 말할 수 있다 | 필수 |
| FR-STR-32 | **이것은 동작 변경이다.** `uninstall --purge` 가 더 많이 지운다 (`ext/`·`worktrees/`·`doctor-*`). 이전/새/이유를 적고 `--dry-run` 목록이 그것을 먼저 보여준다 | 필수 |
| FR-STR-33 | 기본 로그 경로가 **한 함수**가 된다 — `defaultLogFile(home)`. 홈이 있으면 `<home>/server.log` 이고, 없을 때만 `platform` 의 자리로 물러선다. `prepareServerCmd` 도 그것을 쓴다 | 필수 |
| FR-STR-34 | `usageStart()` 는 홈을 모르므로 문구를 **`$DONGMINAL_HOME/server.log`** 로 적는다 — 그 편이 실제로도 정확하다 | 필수 |
| FR-STR-35 | `platform.Paths.DefaultLogFile()` 머리말의 *"종전 `cli.DefaultLog` 와 같은 값이다"* 를 고친다 — **그 문장이 지금 거짓이다** | 필수 |
| FR-STR-36 | **게이트 3**: `scripts/check-home-layout.sh` — 코드가 홈 아래에 쓰는 **첫 조각**이 전부 `homeLayout()` 의 `Name` 에 있다. 물음은 하나다: *"홈의 목록이 전수인가"* | 필수 |
| FR-STR-37 | 게이트는 **예외를 사유와 함께** 든다 (§6-예외표). 등록 대상: 홈이 아닌 경로에 쓰는 자리 · 테스트 픽스처 | 필수 |

### 3.4 묶음 D — 모듈 크기

| ID | 요구 | 등급 |
|---|---|---|
| FR-STR-40 | **게이트 4**: `scripts/check-file-size.mjs` — `web/js`(vendor·`test/` 제외)의 ① 500줄 초과 파일 수 ② 최대 줄 수를 세어 `FE_MODULE_BOUNDARY_SRS §7.1` 의 표와 대조하고 **악화하면 실패**한다. 개선은 통과시키되 표를 갱신하라고 안내한다 (`check-error-docs.sh` 와 같은 꼴) | 필수 |
| FR-STR-41 | **i18n 카탈로그(`web/js/i18n/*.js`)는 대상 밖이다.** 데이터이고 키가 늘면 줄이 는다 — 분할의 대상이 아니다. §6-예외표에 사유와 함께 든다 | 필수 |
| FR-STR-42 | **기준선은 지금 값으로 다시 잡는다** (D-STR-5). 감사 D2 가 권한 순서 그대로다: *"게이트를 먼저 세우고 기준선을 정한다"* | 필수 |
| FR-STR-43 | `renderer.js:542 _rLayout`(168줄)이 넷으로 갈린다 — `_rSlots`·`_gcWidgets`·`_afterLayout`·`_refocus`. **전부 구간 이동**이고 `_rLayout` 에 남는 것은 진행 순서다 | 필수 |
| FR-STR-44 | `renderer.js`(1,586)가 **증강 분할**된다 — `renderer.js` · `renderer-scroll.js` · `renderer-chrome.js` · `renderer-layout.js` · `renderer-pane.js`. `Renderer.prototype` 에 `Object.assign` 하므로 계약은 한 글자도 바뀌지 않는다 | 필수 |
| FR-STR-45 | `index.html` 의 로드 순서가 **클래스 정의 뒤**에 증강 파일을 둔다. `check-load-order.mjs` 가 그것을 강제한다 (C-2) | 필수 |
| FR-STR-46 | **무동작변경의 증명**은 전수성으로 한다 (`FE_MODULE_BOUNDARY_SRS` §7.2 의 규약): 분할 전후로 `Renderer.prototype` 멤버 수가 같고, 멤버 본문의 **비공백 행이 다중집합으로 동일**하다 | 필수 |
| FR-STR-47 | `FE_MODULE_BOUNDARY_SRS` **N3 과 §7.1 을 같은 변경에서 개정한다** (규약 4). N3 의 근거는 *"응집도가 있다"* 였고, 그것은 줄이 늘어도 자동으로 재검토되지 않았다 — 실측으로 이 파일은 지금 **넷을 한다** (§2.7 · `AUDIT-fe-ui.md` M-9) | 필수 |
| FR-STR-48 | 나머지 28개 과대 함수와 다른 파일의 분할은 **이 묶음이 아니다** (§6-3). 게이트가 섰으므로 악화는 막힌다 | 필수 |

### 3.5 묶음 V — 탐침

| ID | 요구 | 등급 |
|---|---|---|
| FR-STR-50 | 새 게이트 넷 각각에 대해 **잡아야 하는 것**을 일부러 만들어 빨개지는 것을 보고 지운다 (규약 3-3) | 필수 |
| FR-STR-51 | **잡으면 안 되는 것**도 확인한다 — §5 의 TC 표가 자리를 적는다 | 필수 |
| FR-STR-52 | 게이트는 **아무것도 재지 않는 상태**를 스스로 거부한다 (M6 §4-A-1). 자리 수가 바닥 아래면 실패한다 | 필수 |

---

## 4. 결정 (Decisions)

| ID | 결정 | 근거 |
|---|---|---|
| **D-STR-1** | 클립보드 헬퍼를 **새로 만들지 않고 `term-clipboard.js` 에서 꺼낸다** | 그 파일의 3단은 `EXPLORER_TRANSFER_IGNORE_SRS` 묶음 F 가 설계하고 D-12·D-13 이 근거를 적은 것이다. 새로 만들면 **여섯 번째 사본**이 되고, 이 문서가 고치려는 바로 그 모양이다 (D-CMP-4 와 같은 규약) |
| **D-STR-2** | `TermClipboard` 라는 **이름을 남긴다** — OSC 52 어댑터로 | `window.TermClipboard` 를 e2e 와 `term-pane.js` 가 부른다. 이름을 지우면 계약이 바뀌고, 이 묶음은 **자리만 옮긴다** (FR-STR-1). 이름이 터미널을 말하는 것이 옳아진다 — 그 파일에 남는 것이 실제로 터미널의 일(OSC 52)이기 때문이다 |
| **D-STR-3** | `dmctl` 의 **파일 계층은 범위 밖**이다 | `helper/runtimebin` 은 `ctl/cli` 를 import 할 수 없다 (프로세스 축 경계, `check-pkg-axis.sh`). 계층을 주려면 `serverconf` 를 `shared` 로 옮겨야 하고 그것은 패키지 구조 변경이다 — 이 묶음의 범위를 넘는다. **`dmenv.BaseURL` 까지는 지나게** 해서 주소 조립만이라도 한 벌로 만들고, 남은 결손을 머리말에 사유로 적는다 |
| **D-STR-4** | `git-worktrees/` 는 `Backup: false` | worktree 의 실체는 **git 저장소 밖**이고 `.git` 파일이 절대 경로를 가리킨다. zip 에 담아 다른 기계에서 풀면 **깨진 worktree** 가 복원된다 — 담지 않는 것이 담고 거짓말하는 것보다 낫다. 감사는 이것을 *"사용자 결정 대상"* 으로 남겼는데, 담았을 때 실제로 무엇이 복원되는지를 읽으면 답이 하나다. 사용자에게 물을 자리는 **목록에 넣을지**가 아니라 **worktree 백업 기능을 만들지**이며 그것은 이 묶음이 아니다 |
| **D-STR-5** | 모듈 크기 기준선을 **지금 값(26 / 1,586)으로 다시 잡고**, 같은 변경에서 최대 파일만 내린다 | 22 / 1,336 으로 되돌리려면 네 파일을 추가로 500 아래로 갈라야 하고 그것은 L 공수다. 감사 D2 가 권한 순서가 *"게이트를 먼저 세우고 기준선을 정하는 순서"* 이며, **재는 것이 없는 상태가 수치보다 나쁘다** — 9일 만에 되돌아온 것이 그 증거다. 게이트가 서면 다음 되돌림은 커밋에서 막힌다 |
| **D-STR-6** | `reconcileList` 이주는 **B6 이다** | `refactor/README.md` §4.1 항목 6 이 그 이주를 **성능 항목으로 등록하고 측정 방법까지 못박았다**(`MutationObserver` 로 60초간 변이 수). 이주 없이는 측정할 수 없고 측정 없이 이주하면 §4 의 *"각 항목의 전후를 그 표의 측정 열로 잰다"* 가 깨진다 — **같은 변경이어야 한다.** 더구나 `innerHTML=''` 54자리 중 폴링 경로인 것을 가르는 일은 자리마다 판단이 필요해 파싱으로 파생되지 않는다 (FR-STR-2 를 만족하지 못한다). B5 는 이 행을 **열지 않는다** |
| **D-STR-7** | 빈 상태의 **주동작은 넣지 않는다** | FR-CMP-62 가 버튼을 **선택**으로 두었으므로 미달이 아니다. 헬퍼가 섰으니 Runs 의 "팀 명령 복사" 는 이제 **가능해졌고**, 그것을 만드는 것은 컴포넌트 작업이 아니라 기능 작업이다 (D-CMP-3 과 같은 경계) |
| **D-STR-8** | 게이트 넷을 **각자 세운다** | D-CMP-5. 물음이 넷이다 — 복사가 한 자리를 지나는가 · 겨누는 자리가 한 규칙을 지나는가 · 홈의 목록이 전수인가 · 모듈 크기가 기준선보다 나빠졌는가. 한 검사에 몰면 실패 메시지가 고칠 자리를 말하지 못한다 |

---

## 5. 검증 (Verification)

| TC | 묶음 | 내용 | 수단 |
|---|---|---|---|
| TC-STR-1 | A | `ClipboardWriter.write` 가 1단 성공·1단 실패→2단 성공·둘 다 실패→3단 창을 각각 낸다 | 단위 |
| TC-STR-2 | A | git 패널 경로 복사 · 확인창의 명령 복사 · 샌드박스 명령 복사가 **실제 화면에서** 통한다 | e2e |
| TC-STR-3 | A | `execCommand('copy')`·`navigator.clipboard.writeText` 를 부르는 자리가 헬퍼 밖에 **0** | 단위 (게이트 1) |
| TC-STR-4 | A | 게이트 1 이 `navigator.clipboard.readText`(붙여넣기)를 **잡지 않는다** | 탐침 |
| TC-STR-5 | B | `dmenv.ListenAddr("::1","9911")` = `[::1]:9911` · `BaseURL("0.0.0.0","9911")` = `http://127.0.0.1:9911` | 단위 (Go) |
| TC-STR-6 | B | `server.json` 에 포트를 적으면 `health`·`window`·`stop`·`migrate` 가 **같은 포트**를 본다 | 단위 (Go, 한 표) |
| TC-STR-7 | B | `--port` 플래그가 `server.json` 을 이긴다 (4계층 순서 회귀) | 단위 (Go) |
| TC-STR-8 | B | host:port 문자열 접합이 `internal/**`·`cmd/**` 에 **0** | 게이트 2 |
| TC-STR-9 | B | 게이트 2 가 로그 문구·테스트의 주소 리터럴을 **잡지 않는다** | 탐침 |
| TC-STR-10 | C | `homeLayout()` 의 이름 집합이 코드가 홈에 쓰는 첫 조각 집합을 **덮는다** | 게이트 3 |
| TC-STR-11 | C | 게이트 3 이 홈 밖 경로(`os.TempDir()`·저장소 경로)를 **잡지 않는다** | 탐침 |
| TC-STR-12 | C | `backup` 이 담는 이름에 `git-worktrees` 가 **없고**, `uninstall --dry-run` 목록에는 **있다** | 단위 (Go) |
| TC-STR-13 | C | `config show` 의 `logFile` 이 `<home>/server.log` 다 | 단위 (Go) |
| TC-STR-14 | D | `web/js` 의 500줄 초과 수·최대 줄이 §7.1 표보다 **나빠지면 빨갛다** | 탐침 (게이트 4) |
| TC-STR-15 | D | 게이트 4 가 `i18n/*.js`·`vendor/`·`test/` 를 **세지 않는다** | 탐침 |
| TC-STR-16 | D | 분할 전후로 `Renderer.prototype` 멤버 수가 같고 멤버 본문의 비공백 행이 **다중집합으로 동일** | 수동 + 기록 |
| TC-STR-17 | D | 창 열기·분할·탭 전환·pane 이동·스크롤 복원·포커스 재지정이 **그대로다** | e2e (기존 `window-slots`·`view-scroll-restore`·`focus-*`) |
| TC-STR-18 | V | 게이트 넷 각각이 변경 전에 빨갛다 | 수동 + 기록 |
| TC-STR-19 | 전체 | `go test -race -shuffle=on ./...` · `npm run unit` · `make gates` · `npm run typecheck` · `make lint` | 명령 |

**순서 (규약 3-1).** 전부 RED 를 먼저 본다. 초록인 검사와 **재고 있는** 검사는 다르다.

**e2e 전량.** 묶음 A(복사 경로)와 묶음 D(렌더러)는 화면의 뼈대를 건드리므로 **각자 전량 1회**,
묶음 B·C 는 Go 이므로 `go test` 로 닫고 B5 가 끝난 뒤 전량 1회. 결과는 **샤드별로 직접 센다**
(`HANDOFF.md` §3-8 — `; echo` 가 종료 코드를 가린다).

---

## 6. 비목표 (Non-goals)

1. **빈 상태의 주동작** (D-STR-7). 헬퍼가 섰으므로 가능해졌으나 기능 작업이다.
2. **`reconcileList` 이주** (D-STR-6) — B6. 측정과 같은 변경이어야 한다.
3. **28개 과대 함수와 `renderer.js` 밖의 파일 분할** (FR-STR-48). 게이트가 섰으므로
   악화는 막힌다. 여는 근거가 생길 때 연다 — `FR-FMB-3` 이 `constants-git.js` 를 열 때
   쓴 절차 그대로다.
4. **`timer-hub` 의 잔여** (패턴 A 표의 한 행). `check-timers.sh` 가 **이미 그것을 재고
   있다** — 게이트가 있는 자리는 패턴 A 가 아니다 (게이트가 예외를 들고 있다면 그것은
   B7 의 등록부 문제다).
5. **`internal/shared` 응집도** (`refactor/README.md` §6 의 B5 행이 언급). `AUDIT-go-infra.md`
   MED 6·10(홈 하위 경로 조립 · `envOr` 두 벌)이 그 몸통인데, MED 6 은 묶음 C 의 게이트가
   **대상을 드러내는 것**까지만 하고 이동은 하지 않는다. 패키지 이동은 `PACKAGE_RESTRUCTURE_SRS`
   의 축이고 그 문서를 여는 일이다.
6. **`lspServerPaths` 편집 UI** (`AUDIT-fe-core.md` D1/U1). 구조가 아니라 **없는 기능**이다.
7. **성능** — B6. **문서 동기화·상태 라벨·결정 색인의 B2·B3·B4 누락** — B7.
8. **키보드 도달** — B2-K, 사용자가 직접 (D-KIT-8).
9. **간격·`--mono`·`line-height` 토큰화** (`AUDIT-design.md` §5·§6). 색도 구조도 아니다 — B7.

### 6-예외표

| # | 대상 | 이유 | 언제 없어지나 |
|---|---|---|---|
| S-1 | `ui/clipboard.js` 자신 | 복사를 **정의하는 쪽**이다 | 없어지지 않는다 |
| S-2 | `ui/term-pane.js:61` `navigator.clipboard.readText` | **읽기**다. 브라우저가 주지 않는 것에는 폴백이 없다 (FR-STR-18) | 읽기에 다른 통로가 생기면 |
| S-3 | `web/js/i18n/*.js` (모듈 크기) | **데이터**다. 키가 늘면 줄이 늘고 분할이 뜻을 갖지 않는다 | 카탈로그가 JSON 으로 나가면 |
| S-4 | `web/vendor/**` · `web/js/test/**` (모듈 크기) | 우리 코드가 아니거나 검사 코드다 | — |
| S-5 | `helper/runtimebin` 의 파일 계층 결손 | **축 경계**가 `ctl/cli` import 를 막는다 (D-STR-3) | `serverconf` 가 `shared` 로 가면 |
| S-6 | `cli/verify_boundary.go:53` `verify-too-large.bin` | `defer os.Remove` 가 지운다. 표에는 `Ephemeral` 로 **든다** — 죽으면 남기 때문이다 | 검사가 임시 디렉터리를 쓰게 되면 |
| S-7 | 테스트 픽스처의 홈 경로 (`*_test.go`) | 검사가 만드는 가짜 홈이다 | — |
| (구현 중 추가) | | | |

---

## 7. 리스크

| 리스크 | 등급 | 완화 |
|---|---|---|
| **`renderer.js` 분할이 로드 순서·전역 해석을 깬다** | **HIGH** | `FE_MODULE_BOUNDARY_SRS` §7.3-⑤ 가 이미 이 실패를 겪었다 — 격리 하네스가 분할에 **결정적으로** 죽었고 전량에서만 드러났다. FR-STR-45(`check-load-order.mjs`) + TC-STR-16(전수성) + 묶음 D 뒤 **전량 1회** |
| **`stop` 의 대상이 바뀐다** | **HIGH** | 의도된 변경이다 (FR-STR-25). 지금은 **남의 프로세스를 죽인다.** TC-STR-6 이 다섯 명령의 일치를 한 표로 잠그고 FR-STR-5 가 이전/새/이유를 남긴다 |
| **`uninstall --purge` 가 더 많이 지운다** | MED | FR-STR-32. `--dry-run` 목록이 먼저 보여주고, `git-worktrees` 는 **사용자 콘텐츠이므로 `Backup: false` 라도 목록에 있어야** 사용자가 그 사실을 본다 (D-STR-4) |
| **3단 복사창이 e2e 에서 예기치 않게 뜬다** | MED | 1단은 secure context(localhost)에서 선다. 뜬다면 그것은 **실제 결함의 노출**이다 — 묶음 A 뒤 전량 1회로 확인한다 |
| **게이트 2 가 로그 문구의 주소를 오탐한다** | MED | TC-STR-9. 판정을 **변수 접합**으로 좁힌다 — 리터럴만인 문자열은 주소가 아니라 문구다 |
| **`ResolveTarget` 이 `start` 의 경고 출력을 바꾼다** | MED | FR-STR-22 가 경고 목록을 **버리지 않는다**. `start_test.go` 가 그 출력을 이미 단정한다 |
| ~~공용 헬퍼를 새로 설계해야 한다~~ | ~~MED~~ → **해소** | **확인 완료 2026-09-21** (§2.2). 3단 복사는 이미 서 있고 근거 문서도 있다. 이 묶음은 **자리만 옮긴다** |

---

## 8. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-21 | 초안. B4 인계서 §0 의 셋 중 **`reconcileList` 를 B6 으로 넘겼고**(D-STR-6) 대신 감사가 패턴 A 로 분류하지 않은 자리 셋(주소 조립 · 기본 로그 경로 · 클립보드의 실제 사본 수)을 파싱으로 찾아 넣었다. FR-CMP-63a 의 전제가 틀렸다는 것이 이 문서의 뿌리다 (§2.2) |
