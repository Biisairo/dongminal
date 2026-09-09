# 문서 정합성 · 저장소 위생 · 프로젝트 메타데이터 감사

담당 축: docs/internal, docs/external, README, 저장소 위생, 메타데이터, go.mod/package.json, CHANGELOG.
read-only 조사. 파일 미수정.

---

## 1. docs/internal 인벤토리

```
$ ls docs/internal/*.md | wc -l          → 137
$ ls docs/internal/*.md | grep -c _SRS.md → 113   (활성 SRS)
$ ls docs/internal/archive/*.md | wc -l  → 48
$ ls docs/internal/archive/*.md | grep -c _SRS.md → 40  (보관 SRS)
```

- 활성 137개 중 SRS 113개, 비-SRS 24개 (architecture.md, building.md, README.md,
  test-checklist.md, *_HANDOFF.md 8종, *_PLAN.md/RESEARCH_NOTES 등).
- `docs/internal/design/` 는 13개 GIT_M*_CONTRACT.md + README.md — SRS/archive 집계에서 별도.
- archive 48개 중 SRS 40, 비-SRS 8 (TODO.md, *_RFC.md 3종, DESIGN_REVIEW_FOLLOWUP.md,
  MULTI_TAB_TYPE_SPEC.md, NEXT_SESSION_PROMPTS.md, USER_CHECKLIST_FIXES_PLAN.md).

### 상태 표기 체계 — 없음

`grep -rE "^#+ *(Status|상태)"` 로 헤더/필드 형태의 상태 표기를 찾았으나 0건.
인라인 자유 텍스트로 "상태:"를 쓰는 문서는 활성 113개 SRS 중 **7개뿐**:

| 파일 | 표기 |
|---|---|
| `ALERT_MOBILE_CONTEXT_SRS.md` | `문서 상태: 승인 · **구현 중** (§7 참조)` |
| `EVENT_TIMER_HUB_SRS.md` | `상태: **초안**. 착수 전 검토 대상.` |
| `GIT_PUSH_OBSERVE_SRS.md` | `상태: **초안**.` |
| `ICON_ASSETS_SRS.md` | `문서 상태: 승인 대기` |
| `POLL_INTERVAL_SETTINGS_SRS.md` | `문서 상태: 승인 · **구현 완료** (2026-09-08)` |
| `PANEL_SURFACE_SRS.md` | `문서 상태: 승인 · **① ④ ⑦ ⑨ 구현 완료** (2026-09-08)` |
| `UI_KIT_SRS.md` | `문서 상태: 승인 · **구현 중** (§7 이전 순서 참조)` |

**[P2] SRS 113개 중 106개(약 94%)는 구현 완료 여부를 판별할 표준 필드가 전혀 없다**
근거: 위 grep 결과, 인라인 텍스트도 값의 형식이 문서마다 다름(`승인 · 구현 완료` /
`초안` / `승인 대기` — enum 아님, 자유 텍스트).
현상: 어떤 SRS가 살아있는 설계 문서이고 어떤 것이 이미 구현되어 참고용으로만
남았는지 문서 집합 자체로는 판별 불가 — 코드를 직접 대조해야 한다.
제안 조치: 최소한 파일 상단에 `상태: 초안|구현중|구현완료|폐기` 같은 통일된
필드를 강제(린트 스크립트 또는 템플릿)하거나, `archive/`처럼 완료본을 별도
디렉터리로 옮기는 관행을 전체 SRS로 확장.
규모: M

archive 이동 자체는 일관되게 이뤄지고 있음(구현 완료된 것으로 보이는 40개 SRS가
이동됨) — 이동 판단 기준(commit message/PR)까지는 확인하지 않음(미확인).

---

## 2. docs/external vs 코드 — 표본 검증

### 2-1. `commands.md` vs 실제 CLI 서브커맨드

**중요 정정**: 사용자 요청은 `internal/ctl/cli/`를 대조 대상으로 지정했으나, 그
디렉터리는 `dongminal start/stop/doctor/verify` 등 **서버 관리용 CLI**이고,
`commands.md`가 문서화하는 `dmctl`/`edit`/`detach`/`download`의 실제 구현은
`internal/helper/runtimebin/dmctl.go`(멀티콜 서브커맨드 디스패치)에 있다.
근거: `internal/helper/runtimebin/dmctl.go:13-153`.

`dmctl.go`의 `dmctlHelp` 상수와 `runDmctlSpecial`/`runDmctlWithFlags`/
`dmctlSimpleActions`에 등록된 전체 서브커맨드와 `commands.md`를 대조:

| 서브커맨드 | 코드에 존재 | commands.md 문서화 |
|---|---|---|
| new-window, new-tab, split-h/v, focus, close-tab/window, window-next/prev, tab-next/prev, tool-up/down/left/right, rename-tab, rename-window, list-workspace, who-am-i, send | ✅ | ✅ |
| **open-editor** | ✅ (`dmctl.go:32,142`) | ❌ 없음 (`edit` 헬퍼가 내부적으로 이 액션을 브로드캐스트한다는 서술만 있음) |
| **open-url** | ✅ (`dmctl.go:33,144`) | ❌ 없음 |
| **notify** | ✅ (`dmctl.go:36,130`) | ❌ 없음 |
| **activity** | ✅ (`dmctl.go:37,132`) | ❌ 없음 |
| **agent-context** | ✅ (`dmctl.go:38,134`) | ❌ 없음 |
| **read-screen / read-output** | ✅ (`dmctl.go:42-43,136`) | ❌ 없음 |
| **send-input** | ✅ (`dmctl.go:44,138`) | ❌ 없음 |
| **msg** | ✅ (`dmctl.go:45,140`) | ❌ 없음 |
| **status / wait** | ✅ (`dmctl.go:46-47,146,148`) | ❌ 없음 |
| **run start/member/launch/report/status/list/close** | ✅ (`dmctl.go:49-54,150`) | ❌ 없음 |
| `rename-tab --auto` | ✅ (`dmctl.go:30,232-248`) | ❌ 없음 (`--auto` 플래그 미언급) |
| `new-window --cwd` | ✅ (`dmctl.go:81`) | ❌ 없음 (`--name`/`-n`/`--sandbox`/`--workdir`만 문서화) |

역방향(문서에만 있고 코드에 없는 것)은 0건 — commands.md에 적힌 것은 전부 코드에
실재한다.

**[P1] `commands.md`가 `dmctl` 서브커맨드의 절반 가까이를 문서화하지 않는다**
근거: `internal/helper/runtimebin/dmctl.go:36-57` (에이전트 접합면·오케스트레이션
실행 기록 섹션 전체) vs `docs/external/commands.md:17-97`.
현상: 에이전트 간 화면 읽기/입력 주입(`read-screen`, `send-input`, `msg`),
상태 대기(`status`, `wait`), Run 오케스트레이션 기록(`run *`), `notify`/`activity`/
`agent-context`, `open-editor`, `open-url` — 총 13개 이상의 서브커맨드가
`commands.md`에 전무하다. `agent-orchestration.md`에서 이를 다루는지 확인했으나
그 문서는 `api.md`의 `/api/tools/output`·`input`·`message` 3개만 링크할 뿐
(`docs/external/agent-orchestration.md:124`), `dmctl` CLI 서브커맨드 목록 자체를
다루지 않는다. 사용자가 외부 문서만으로는 이 CLI 표면의 존재 자체를 알 수 없다.
제안 조치: `commands.md`에 "에이전트 접합면"·"오케스트레이션 실행 기록" 절 추가,
또는 `agent-orchestration.md`가 이 서브커맨드들의 사용법을 대신 다루도록 상호
링크를 명시.
규모: M

### 2-2. `api.md` vs 실제 HTTP 핸들러 등록부

라우트 진실 공급원 확인: `internal/webserver/httpapi/handlers_api.go:69-201`
(`apiRoutes` 테이블, `httproute.Get/Post/Put/Delete/Any/When`), 서버 최상위
등록은 `internal/webserver/httpapi/server.go:203-209`, git 전용 라우트는
`internal/webserver/gitapi/routes.go:16-88`(`s.git.Handle` 폴백,
`handlers_api.go:207`).

api.md에 적힌 엔드포인트는 전부 코드에 실재함(역방향 불일치 0건, 위 라우트
테이블과 1:1 대조 완료). 문제는 **코드에는 있으나 api.md에 없는** 대규모 표면:

| 분류 | 코드 종단 수(대표) | api.md 언급 |
|---|---|---|
| **`/api/git/*` 전체** | 60개 이상 (`gitapi/routes.go:16-88`: repos/status/stage/commit/branch/stash/tag/remote/fetch/pull/push/log/blame/diff 등) | **0건** |
| **`/api/runs/*` 전체** | 13개 (`handlers_api.go:91-116`: 시작/멤버/보고/종료/graph/attach/detach/succeed/handoff/context/peers/preamble/delete) | **0건** |
| `/api/tools/activity/get`, `/api/tools/activity/wait` | 2개 (`handlers_api.go:88-89`, `dmctl status`/`wait` 백엔드) | 0건 |
| `/api/tools/kill` | 1개 (`handlers_api.go:112`) | 0건 |
| `/api/sandbox/*` | 5개 (`handlers_api.go:121-126`) | 0건 |
| `/api/access` (GET/PUT) | 2개 (`handlers_api.go:134-135`) | 0건 |
| `/api/file/probe`, `/api/file/raw` | 2개 (`handlers_api.go:142-143`) | 0건 |
| `/api/fs/find`, `/api/fs/grep`, `/api/fs/copy` | 3개 (`handlers_api.go:153-162`) | 0건 |
| `/api/lsp/*` (status/install/definition/references/hover) | 5개 (`handlers_api.go:173-178`) | 0건 |
| `/api/open-url/where` | 1개 (`server.go:209`) | 0건 |

**[P1] `api.md`가 실제 HTTP 표면의 절반 이상을 누락한다 — Git API(60+ 종단)와
Run 오케스트레이션 API(13종단)는 문서에 전무하다**
근거: `internal/webserver/gitapi/routes.go:16-88` 및
`internal/webserver/httpapi/handlers_api.go:91-178` 전체 vs `docs/external/api.md`
전문(grep `"/api/git/"` 0건, `"/api/runs"` 0건, `"/api/sandbox"` 0건, `"/api/lsp"`
0건, `"/api/access"` 0건).
현상: api.md는 스스로 "외부 통합용 공개 엔드포인트 정리"(`api.md:1`)라 밝히는데,
실제로 외부 통합 대상이 될 만한 표면(Git 조작 전체, 멀티에이전트 Run 기록,
LSP 조회, 접속 허용목록 관리)이 통째로 빠져 있다. `agent-orchestration.md`도
Run API를 다루지 않는다(2-1 확인).
제안 조치: 최소한 각 그룹의 존재와 대표 종단 하나씩이라도 표로 추가하고
"자세한 스키마는 `gitapi/routes.go`·`handlers_api.go` 참고" 식으로 소스를
가리키게 하거나, 내부 문서(`architecture.md`)로 명시적으로 위임.
규모: L

### 2-3. `shortcuts.md` vs `web/js` 키 바인딩

진실 공급원: `web/js/core/helpers.js:237-282` (`SHORTCUT_DEFAULTS`,
`SHORTCUT_LABELS`).

표본 10개(및 확인 가능한 전체) 대조 — **전부 일치**:

| 동작 | 문서 | 코드(`SHORTCUT_DEFAULTS`) |
|---|---|---|
| 다음 항목 | `Ctrl+Shift+]` | `windowNext:'Ctrl+Shift+BracketRight'` |
| 이전 항목 | `Ctrl+Shift+[` | `windowPrev:'Ctrl+Shift+BracketLeft'` |
| 다음 탭 | `Ctrl+Tab` | `tabNext:'Ctrl+Tab'` |
| Pane ↑ | `Ctrl+Shift+↑` | `paneUp:'Ctrl+Shift+ArrowUp'` |
| 가로 분할 | `Ctrl+Shift+H` | `splitH:'Ctrl+Shift+KeyH'` |
| Run 오케스트레이션 | `Ctrl+Shift+O` | `runsToggle:'Ctrl+Shift+KeyO'` |
| 이전 슬롯 | `Ctrl+Alt+[` | `slotPrev:'Ctrl+Alt+BracketLeft'` |
| 정의로 이동 | `F12` | `edGotoDef:'F12'` |
| 이동 뒤로 | `Ctrl+Alt+-` | `edNavBack:'Mod+Alt+Minus'` |
| 파일 전체 검색 | `Ctrl+Shift+F` | `edGrep:'Mod+Shift+KeyF'` |

불일치는 "역방향" — 코드에 있으나 문서 표에 없는 것 2건:

**[P2] `shortcuts.md` 기본값 표에 `sidebarToggle`·`edSave` 누락**
근거: `web/js/core/helpers.js:262` (`sidebarToggle:'Ctrl+Shift+KeyE'`,
라벨 "사이드바 접기/펼치기", `helpers.js:298`), `helpers.js:281`
(`edSave:'Mod+KeyS'`) vs `docs/external/shortcuts.md:18-53` 표 전체 grep — 두 동작
모두 없음. (참고: README.md도 자주 쓰는 단축키 표에 이 둘을 넣지 않음 —
README는 요약 표라 누락이 덜 치명적이나 shortcuts.md는 "기본값" 전체 목록을
표방한다.)
현상: 사이드바 접기/펼치기 키와 편집기 저장 키가 사용자 문서 어디에도 없다.
`edSave`는 관용적 단축키(Cmd/Ctrl+S)라 발견하기 쉽지만, `sidebarToggle`은
비관용적 배정(`E`)이라 문서 없이는 존재를 알기 어렵다.
제안 조치: 두 항목을 `shortcuts.md` 표에 추가.
규모: S

---

## 3. 루트 README.md — 프로덕션 문서 점검

| 항목 | 상태 | 근거 |
|---|---|---|
| 설치 방법 | ✅ 있음 | README.md:14-52 (macOS/Linux/Windows curl 커맨드) |
| 지원 플랫폼 | ✅ 있음 | README.md:18-49 (darwin-arm64/amd64, linux-amd64/arm64, windows-amd64, "Windows 10 1809+") |
| 요구 버전 | 🟡 부분적 | Windows 최소 버전만 명시. 브라우저 최소 버전, 최소 화면 크기 등은 없음(단일 바이너리라 Go/Node 버전 요구는 해당 없음 — 정당) |
| 보안 주의사항 | 🟡 부분적 | README.md:81-87 "인증이 없으므로 신뢰하는 망에서만" 경고는 있으나, 취약점 신고 경로(SECURITY.md)·HTTPS/TLS 미지원 여부·access allowlist의 스푸핑 가능성 등은 없음 |
| **라이선스** | **❌ 없음** | README.md 전체에 라이선스 절 없음. LICENSE 파일도 저장소에 없음(§5 확인) |
| 기여 가이드 | 🟡 부분적 | README.md:248-255 "고치려는 분께" — `docs/internal/building.md`/`architecture.md` 링크만. PR 규칙·코드 스타일·리뷰 절차는 없음(CONTRIBUTING.md 부재, §5) |
| 문제 해결 | ✅ 있음 | README.md:207-232 (`doctor`/`health` 커맨드, 알려진 문제 절) |

**[P1] LICENSE 파일과 README 라이선스 절이 모두 없다**
근거: `LICENSE`/`LICENSE.md`/`LICENSE.txt` 파일 부재(§5), README.md 전문 검색
결과 "license"/"라이선스" 0건, `.github/`에도 라이선스 관련 파일 없음.
현상: GitHub 공개 저장소(`github.com/Biisairo/dongminal`)로 배포되는데
재사용·재배포·특허 조건이 명시되지 않았다. GitHub 기본 정책상 라이선스가
없으면 "All rights reserved"로 간주되어 포크·기여·재배포가 법적으로
불명확해진다.
제안 조치: 라이선스 선택 후 `LICENSE` 파일 추가 + README에 배지/절 추가.
규모: S

---

## 4. 저장소 위생

### git 크기

```
$ git count-objects -vH
count: 4773
size: 26.39 MiB
in-pack: 11258
packs: 31
size-pack: 79.67 MiB
prune-packable: 0
garbage: 0
```
총 git 데이터 ≈ 106 MiB (loose 26.39 + pack 79.67).

### 대용량 산출물 추적 여부 — **정정: 요청에서 가정한 문제는 재현되지 않음**

`git ls-files` 결과, 다음은 **현재 전혀 추적되지 않는다**(모두 0건):

```
git ls-files | grep -E "^dongminal$"        → 0건
git ls-files | grep -E "^dist/"             → 0건
git ls-files | grep -E "^playwright-report/" → 0건
git ls-files | grep -E "^test-results/"     → 0건
git ls-files | grep -E "^\.playwright-mcp/"  → 0건
git ls-files | grep -E "^node_modules/"     → 0건
```

`.gitignore`(전체 47줄)에 이미 `/dongminal`, `/dist/`, `node_modules/`,
`playwright-report/`, `test-results/`, `.playwright-mcp/` 전부 등재되어 있고
(`.gitignore:2,47,29-31,37`), 작업 디렉터리의 16MB `dongminal` 바이너리·
`.playwright-mcp/`(143항목)·`dist/`·`node_modules/` 등은 git 추적 상태가 아닌
untracked 파일임을 확인했다. **요청에서 전제한 "루트 바이너리·산출물이 git에
추적된다"는 가정은 사실이 아니다** — 현재 워킹트리 위생은 양호하다.

### 실제 위생 문제 — **git 히스토리에 과거 바이너리가 반복 커밋되어 팩 크기를 부풀림 (재검증 완료)**

audit-secops 축이 "`dongminal`(루트)·`dist/`·`playwright-report/`·`test-results/`·
`.playwright-mcp/`는 git 미추적이며 과거 커밋 이력도 없다"고 보고해 본 항목과의
정합성을 team-lead 요청으로 재검증했다. 결론: **충돌 아님 — 서로 다른 경로를
가리킨다.** secops가 확인한 5개 경로는 실측으로도 전부 이력 0건임을 재확인했고
(`git log --all --oneline -- dongminal / dist/ / playwright-report/ /
test-results/ / .playwright-mcp/` → 전부 `0`), 본 항목이 지적하는 것은 **그와
다른 두 경로**(`remote-terminal`, `bin/dongminal`)다.

**1MB 초과 blob 실측** (`git rev-list --objects --all | git cat-file
--batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' | awk
'$1=="blob" && $3>1000000'`):

```
28개 blob, 경로는 2종뿐:
  remote-terminal   27개  (최대 9,105,986 bytes)
  bin/dongminal      1개  (9,086,770 bytes)
합계: 249,218,200 bytes (≈ 237.7 MiB, blob 원본 크기 합 — pack 압축 전)
```

경로별 커밋 수 (`git log --all --oneline -- <경로>`):
- `remote-terminal` → **29 커밋** (`91e74b8 remove binary` 포함 — 이후 제거됐으나
  히스토리에는 영구 보존)
- `bin/dongminal` → **2 커밋** (`28a3026 이름 변경` 포함 — 개명 과정에서 생성)

`git count-objects -vH` 재실행 결과(직전 보고와 사실상 동일, 오차는 감사
진행 중 커밋 1건 반영):
```
count: 4775
size: 26.40 MiB
in-pack: 11258
packs: 31
size-pack: 79.67 MiB
```

`.gitignore` 대조(`git check-ignore -v`):
- `bin/dongminal` → `.gitignore:5:/bin` 규칙에 걸림 (현재는 막힘)
- `remote-terminal`(루트, `bin/` 아님) → **매칭 규칙 없음** — 현재 `.gitignore`는
  `/dongminal`만 알고, 개명 전 이름 `remote-terminal`은 애초에 언급이 없다
  (이미 히스토리에만 남고 워킹트리엔 없는 파일이라 실질적 재발 위험은 낮음)
- 둘 다 `git ls-files`엔 없음(현재 추적 안 됨) — secops 보고와 일치

**[P2] git 히스토리에 프로젝트 개명 전 바이너리(`remote-terminal` 27개·
`bin/dongminal` 1개, 합계 28개 blob·249,218,200 bytes)가 반복 커밋되어 팩(.git)
크기를 79.67 MiB까지 불렸다 — secops가 확인한 5개 경로(`dongminal`/`dist/`/
`playwright-report/`/`test-results/`/`.playwright-mcp/`)와는 무관한, 별도의
두 경로에서 발견됨**
근거: 위 실측 명령 출력 전체.
현상: 워킹트리·현재 `.gitignore` 상태는 깨끗하나(secops 보고대로), 과거
9MB급 바이너리 blob 28개가 히스토리에 영구 보존되어 clone 크기·pack 크기를
필요 이상으로 키운다.
제안 조치: 히스토리 재작성이 허용된다면(강제 push·팀 통보 필요) `git filter-repo`
로 `remote-terminal`·`bin/dongminal` 경로를 히스토리에서 제거. 부담이 크면
현행 유지도 선택지 — 다만 `git count-objects` 수치가 계속 늘어나는지는 주기적
관찰 권장.
규모: M (재작성 시 팀 전체 재-clone 필요 — 판단은 팀 몫)

---

## 5. 프로젝트 메타데이터 — 누락 목록

| 파일 | 상태 |
|---|---|
| LICENSE / LICENSE.md / LICENSE.txt | ❌ 없음 |
| CONTRIBUTING.md | ❌ 없음 |
| SECURITY.md | ❌ 없음 |
| CODE_OF_CONDUCT.md | ❌ 없음 |
| `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md` | ❌ 없음 (`.github/`엔 `workflows/`만 존재: release.yml, verify.yml, e2e.yml) |
| `.editorconfig` | ❌ 없음 |
| golangci-lint 설정(`.golangci.yml`/`.yaml`) | ❌ 없음 |
| eslint 설정 | ❌ 없음 |
| prettier 설정 | ❌ 없음 |

**[P2] 린터 설정(golangci-lint/eslint/prettier) 부재 — 코드 스타일이 CI로 강제되지 않음**
근거: 위 표. `.github/workflows/verify.yml` 자체 내용은 미확인(이 축의 조사
범위 밖 — CI 파이프라인 상세는 별도 축 소관으로 보임).
현상: Go/JS 스타일 가이드가 관습으로만 존재하고 도구로 강제되지 않는다.
제안 조치: 팀 결정 필요 — 최소 `.editorconfig`는 즉시 추가 가능(S).
규모: S(`.editorconfig`) / M(린터 도입 전체)

**[P3] 이슈/PR 템플릿 부재**
근거: `.github/` 하위 `workflows/`만 존재.
현상: 공개 저장소인데 기여자가 이슈/PR을 표준 양식 없이 자유 서술로 남긴다.
제안 조치: 필요성은 팀 판단 — 외부 기여를 받을 계획이 있는지에 달림.
규모: S

---

## 6. go.mod / package.json

**go.mod**
```
module dongminal
go 1.24.0

require (
	github.com/creack/pty v1.1.24
	github.com/gorilla/websocket v1.5.3
)
require golang.org/x/sys v0.36.0
```
Go 1.24.0, 의존성 3개(직접 2 + 간접 1) — 매우 가벼움. 특이사항 없음.

**package.json** (`dongminal-e2e`, private)
```json
devDependencies: { "@playwright/test": "^1.59.0" }
scripts: e2e / e2e:ui / e2e:report
```
프론트엔드는 vanilla JS로 `package.json`에 런타임 의존성이 전혀 없다
(`web/vendor/`에 xterm.js·highlight.js·markdown-it.js를 직접 vendoring —
`du` 결과 확인, §2-3 인접 조사에서 발견). Playwright만 devDependency로 존재.
빌드 도구 체인(webpack/vite 등) 없음 — 정적 파일 서빙 구조로 추정(미확인, 이
축의 조사 범위 밖).

---

## 7. CHANGELOG.md

87KB, 13개 버전 헤더 + `[Unreleased]`. `# 변경 이력` 직후 명시적으로
"형식은 Keep a Changelog를 따르고, 판 번호는 유의적 버전을 따른다"고 선언
(`CHANGELOG.md:1-4`).

버전-태그 대응 확인:

```
CHANGELOG 헤더        git 태그(생성일)
[1.0.12] 2026-09-08 ↔ v1.0.12 2026-09-08  ✅
[1.0.11] 2026-09-06 ↔ v1.0.11 2026-09-06  ✅
[1.0.10] 2026-09-06 ↔ v1.0.10 2026-09-06  ✅
[1.0.9]  2026-09-05 ↔ v1.0.9  2026-09-05  ✅
[1.0.8]  2026-09-02 ↔ v1.0.8  2026-09-02  ✅
[1.0.7]  2026-09-01 ↔ v1.0.7  2026-09-01  ✅
[1.0.6]  2026-09-01 ↔ v1.0.6  2026-09-01  ✅
[1.0.5]  2026-09-01 ↔ v1.0.5  2026-09-01  ✅
[1.0.4]  2026-08-31 ↔ v1.0.4  2026-08-31  ✅
[1.0.3]  2026-08-31 ↔ v1.0.3  2026-08-31  ✅
[1.0.2]  2026-08-30 ↔ v1.0.2  2026-08-30  ✅
[1.0.1]  2026-08-30 ↔ v1.0.1  2026-08-30  ✅
[1.0.0]  2026-08-30 ↔ v1.0.0  2026-08-30  ✅
                     v1       2026-08-21  (CHANGELOG 에 대응 항목 없음)
```

13개 버전 헤더 전부 날짜까지 정확히 태그와 일치 — **형식·버전 대응 모두 양호**.
유일한 예외는 `v1` 태그(2026-08-21, CHANGELOG 시작보다 이전 시점의 초기 태그로
추정) — SemVer 형식이 아니고 CHANGELOG에 대응 항목도 없다.

**[P3] `v1` 태그가 SemVer 형식이 아니고 CHANGELOG에 대응 항목이 없다**
근거: `git for-each-ref` 출력, `CHANGELOG.md` 최초 버전 헤더가 `[1.0.0]`부터
시작(`CHANGELOG.md:1100`대 이전에 더 이른 헤더 없음).
현상: `v1`은 CHANGELOG 도입 이전의 초기 태그로 보이며 실무 영향은 낮음.
제안 조치: 조치 불필요 — 기록용으로만 남겨도 무방. 원한다면 태그 설명에 각주.
규모: S

각 버전 섹션의 하위 구조(`### 수정`/`### 추가` 등 카테고리 사용) 표본 확인
결과 일관되게 사용됨(`CHANGELOG.md:8` `### 수정` 등) — Keep a Changelog의
Added/Changed/Fixed/Removed 카테고리를 한국어로 일관 적용.

---

## 발견 요약 (중요도 순)

1. **[P1]** `api.md`가 `/api/git/*`(60+ 종단)·`/api/runs/*`(13종단) 등 HTTP 표면
   절반 이상을 누락 — §2-2, 규모 L
2. **[P1]** LICENSE 파일·README 라이선스 절 전무 — §3, 규모 S
3. **[P1]** `commands.md`가 `dmctl` 에이전트 접합면·Run 오케스트레이션
   서브커맨드 13개 이상 누락 — §2-1, 규모 M
4. **[P2]** SRS 113개 중 106개(94%)에 구현 상태 판별 필드 없음 — §1, 규모 M
5. **[P2]** git 히스토리에 옛 9MB 바이너리 반복 커밋으로 팩 79.67MiB 팽창
   (현재 워킹트리는 깨끗함 — 요청의 "대용량 파일 추적" 가정은 사실 아님) — §4, 규모 M
6. **[P2]** `shortcuts.md`에 `sidebarToggle`·`edSave` 키 누락 — §2-3, 규모 S
7. **[P2]** 린터 설정(golangci-lint/eslint/prettier)·`.editorconfig` 부재 — §5, 규모 S/M
8. **[P3]** 이슈/PR 템플릿 부재 — §5, 규모 S
9. **[P3]** `v1` 태그가 SemVer 미준수·CHANGELOG 미대응 (실무 영향 낮음) — §7, 규모 S

## 미확인 항목
- `.github/workflows/verify.yml` 등 CI 파이프라인이 린트/포맷을 어떻게든 강제하고
  있는지는 이 축의 범위 밖이라 확인하지 않음.
- archive 이동 판단 기준(리뷰 프로세스 존재 여부)은 git log/PR 이력을 보지 않아 미확인.
- `web/vendor/` vendoring 방식과 `package.json`에 빌드 도구가 없는 이유(정적 서빙
  구조 추정)는 프론트엔드 아키텍처 축 소관으로 보여 깊이 파지 않음.
