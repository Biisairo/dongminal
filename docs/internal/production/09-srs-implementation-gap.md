# 09 — SRS 명세 대비 구현 대조

담당 축: `docs/internal/` 활성 SRS 의 요구사항이 실제 코드에 존재하는지 대조.
read-only. 파일 미수정.

기존 감사 173건과 겹치는 항목은 ID 로만 참조한다.
git 폴링·관측 영역(`DRIFT_RECLAIM_SRS`·`GIT_OBSERVE_REVIVE_SRS`·`GIT_LIVE_TRIGGERS_SRS`·
`GIT_PUSH_OBSERVE_SRS`·`GIT_VIEW_REFRESH_SRS`)은 전담 에이전트가 있어 제외했다.

---

## 0. 총평 — 먼저 밝힐 것

**이 저장소의 스펙-코드 정합성은 매우 높다.** 활성 SRS 113개가 선언한 FR ID
2,700여 개 중 **2,456개가 `internal/`·`web/`·`e2e/`·`cmd/`·`scripts/`·`.github/` 의
코드·주석·테스트에 실제로 인용돼 있다.** FR ID 를 코드 주석에 박아 두는 관행이
전 계층에 일관되게 적용돼 있어, 요구사항 하나하나를 코드에서 되짚을 수 있다.

그래서 이 축의 결론은 "미구현이 쏟아진다" 가 아니다. **진짜 격차는 소수이며,
대부분은 SRS 자신이 "다음 판" 으로 미뤄 두고 그 다음 판이 오지 않은 것**이다.

또 하나 확인된 사실: `docs/internal/README.md:5` 가 선언하듯 **`archive/` 는
"완료된 작업의 기록"** 이며, 실제로 archive SRS 의 FR 이 라이브 코드에 대량으로
인용된다(`USER_CHECKLIST_FIXES_SRS` 41개, `AGENT_ACTIVITY_PANEL_SRS` 22개 등).
**"archive 로 옮겨졌는데 코드에 잔재" 유형은 발견되지 않았다** — 그 관계는
설계된 것이지 결함이 아니다.

### 방법과 그 한계

세 갈래로 훑었다.

1. **FR ID 교차 대조** — 문서가 선언한 FR ID 를 코드 전역 corpus 와 비교.
   *이 신호는 노이즈가 크다.* 미참조 상위 SRS 를 직접 열어 보니
   `CROSS_PLATFORM_SRS`(16개 미참조)·`CI_E2E_MATRIX_SRS`(16개)·
   `ALERT_MOBILE_CONTEXT_SRS`(17개)·`SKILL_INJECTION_SRS`(13개)는 **전부 구현돼
   있었다.** 리팩터·삭제 요구사항(`FR-DHB-2`·`FR-RM-*`)은 성질상 코드가 인용할 수
   없고, 구현이 다른 SRS 의 FR 번호로 인용된 경우도 많다
   (`FR-DLS-11` → 코드는 `FR-EXT-1` 로 인용, `constants-editor.js:169`).
   **미참조를 미구현으로 단정하지 않았다** — 전부 코드에서 실물을 확인했다.
2. **유보 표현 추출** — `미구현`·`보류`·`다음 판`·`후속`·`남은 것`·`철회` 로
   grep 해 SRS 자신의 진술을 모은 뒤 코드로 검증. **여기서 실질 발견이 나왔다.**
3. **비목표 전수 수집** — 활성 SRS 94개의 `## 비목표` 절을 기계 추출해
   프로덕션 위험 항목을 선별.

---

## 1. 명세됐으나 미구현·부분구현 (결함)

### [P2] `DOCLANG_LSP_SRS.md` · FR-DLS-13 · FR-DLS-14 · FR-DLS-15 — 묶음 D 전량 미구현

**명세**
> **FR-DLS-13** **문서 심볼**(`textDocument/documentSymbol`) 을 받는다. Markdown 은
> 헤딩 트리, YAML·JSON 은 키 트리, CSS 는 선택자다.
> **FR-DLS-14** 그것을 보이는 자리는 **이미 있는 목록 껍데기**다 — 찾기 패널·참조
> 목록이 쓰는 그것. 새 사이드바를 만들지 않는다.
> **FR-DLS-15** **문서 링크**(`textDocument/documentLink`) …
> (`DOCLANG_LSP_SRS.md:186-197`)

문서 자신이 이 묶음의 무게를 못박는다 — *"문서 언어의 이득 절반이 여기 있다"*
(`DOCLANG_LSP_SRS.md:184`).

**실제 구현 상태**
`grep -rn 'textDocument/' internal web` 결과, LSP 세션이 말하는 메서드는 여섯뿐이다:

| 메서드 | 위치 |
|---|---|
| `textDocument/publishDiagnostics` | `internal/webserver/domain/lsp/session.go:160` |
| `textDocument/didOpen` | `session.go:255` |
| `textDocument/didChange` | `session.go:266` |
| `textDocument/definition` | `session.go:294` |
| `textDocument/references` | `session.go:299` |
| `textDocument/hover` | `session.go:316` |

`documentSymbol`·`documentLink` 는 **`internal/`·`web/`·`e2e/` 어디에도 0건**이다.
검증 항목 `V-DLS-7`(문서 심볼이 목록으로 뜨고 고르면 그 줄로 간다)에 대응하는
e2e 도 없다.

**격차**
같은 SRS 의 묶음 A(문서 언어 서버 조달)는 **끝났다** — `LSP_PLUGIN_SRS` 가 흡수해
`internal/webserver/domain/ext/builtin/` 에 `markdown`·`yaml`·`svg`·`html`·`css`·
`json` 서술자가 동봉돼 있다(`vscode-langservers.json`·`yaml.json`·`svg.json` 실측).
묶음 C(언어 목록 한 자리)도 끝났다(`constants-editor.js:169`, `LSP_HOVER_LANGS` 제거).
**묶음 D 만 통째로 남았다.**

**사용자 영향**
`.md`·`.yaml`·`.json` 을 열면 진단·호버·정의이동은 되지만 **아웃라인이 없다.**
긴 Markdown 문서에서 헤딩으로 점프하는 길이 없어 스크롤로만 다닌다. 이 SRS 가
접수한 요구("다양한 동작")의 절반이 미달이다.

**제안 조치**
`session.go` 에 `documentSymbol` 왕복을 더하고, FR-DLS-14 대로 기존 참조 목록
껍데기(`LSP_REFS_PLACEHOLDER` 계열)를 재사용한다. `documentLink` 는 FR-DLS-15 가
`DOC_RENDER_VIEW_SRS` FR-DRV-28 과의 중복을 경고하므로 **조율 후 판단**.

**규모** M (심볼) / S (링크 — 조율 결과에 따라 비목표화 가능)

---

### [P2] `GIT_ACTIONS_SRS.md` · FR-GIT-283 · FR-GIT-284 — 미구현, FR-GIT-285 절반

**명세**
`GIT_ACTIONS_SRS` 는 `GIT_SURFACE_MAP.md` 의 126항목을 전수 대조해 미구현 33항목을
FR-GIT-250~285 로 요구사항화했다(`:535`). 그중 셋을 2026-08-27 에 "다음 판" 으로
미뤘다(D9).

| # | 요구사항 | 상태표 |
|---|---|---|
| 283 | 3-way merge editor | `⬜ 다음 판 (D9)` (`:495`) |
| 284 | 인터랙티브 rebase | 〃 |
| 285 | clone / init | 〃, 단 `init` 절반은 섰다 (`:496`) |

**실제 구현 상태**

- **FR-GIT-285 `init`: 구현됨.** `internal/webserver/domain/git/core/write.go:41`
  의 `writeCommands` 에 `"init": true` 가 있고, 주석이 출처를 밝힌다 —
  *"REPO_TAB_UNIFY_SRS FR-RTU-29: 저장소가 아닌 자리를 저장소로 만든다"*
  (`write.go:35-41`). 인자 없는 모양으로 한정하는 `guardInitArgs` 까지 있다.
- **FR-GIT-285 `clone`: 미구현.** `writeCommands`(`write.go:24-42`) 전체를 읽었고
  `clone` 은 없다.
- **FR-GIT-283 / 284: 미구현.** merge editor 용 Monaco 모드도, `GIT_SEQUENCE_EDITOR`
  를 우리 실행 파일로 세우는 표면도 없다.

**격차**
FR-GIT-283·284 는 **각각 열린 결정이 하나씩 달려 있어 착수되지 못했다** —
283 은 "줄 단위 채택까지인가"(`:524`), 284 는 "todo 를 누가 쓰는가"(`:525`).
2026-08-27 이후 **2주간 어느 후속 SRS 도 이 셋을 받지 않았다**
(`grep 'FR-GIT-28[345]' docs/internal/*.md` → `GIT_ACTIONS_SRS` 외 0건).

**사용자 영향**
- 충돌 해결이 파일 단위 `ours`/`theirs` 채택뿐이다. 줄 단위로 섞어야 하는 충돌은
  터미널로 나가야 한다.
- rebase 는 `--continue`/`--abort` 만 되고 todo 편집(squash·reword·drop)이 안 된다.
- 저장소를 **새로 받아오는(clone)** 길이 UI 에 없다. `init` 은 되므로 "만들 수는
  있는데 받아올 수는 없다" 는 비대칭이 남는다.

**제안 조치**
셋 다 열린 결정이 선행한다. 우선순위는 `clone` → `284` → `283` 을 권한다 —
clone 은 결정이 가장 가볍고(경로를 서버가 정할지 사용자가 줄지), 표면도 이미 있는
`init` 버튼 옆이다. 283 은 새 Monaco 모드라 가장 무겁다.

**규모** clone S/M · 284 M · 283 L

---

### [P2] `GIT_CHANGES_CONTROLS_SRS.md` · FR-GCC-3 · FR-GCC-4 — 서버 도메인 계층에 죽은 코드가 남았다

**명세**
> **FR-GCC-3** 두 기능의 클라이언트 코드(`GitRemote.sync`·`preview`·`_addButtons`·
> 전용 상수)를 지운다 — **쓰이지 않는 코드를 남기지 않는다.**
> **FR-GCC-4** 서버의 `POST /api/git/sync` · `GET /api/git/sync` ·
> `GET /api/git/push/preview` 와 그 핸들러·라우트·Go 테스트를 지운다 (D-1).
> (`GIT_CHANGES_CONTROLS_SRS.md:65-66`)

**실제 구현 상태**
HTTP 표면과 클라이언트는 **깨끗이 지워졌다** — `internal/webserver/gitapi/routes.go`
전문에 `/api/git/sync`·`/api/git/push/preview` 0건(남은 `sync`·`preview` 매칭은
`submodules/sync`·`branch/merge-preview` 로 다른 기능이다).

그런데 **도메인 계층의 Sync 상태기계가 통째로 남아 있다**:

| 심볼 | 위치 | 프로덕션 호출처 |
|---|---|---|
| `StepOutcome` (struct) | `internal/webserver/domain/git/write/remote.go:264` | **없음** |
| `StepOutcome.OK()` | `remote.go:272` | **없음** |
| `SyncNext()` | `remote.go:278` | **없음** |
| `syncStopReason()` | `remote.go:294` | `SyncNext` 만 |

`grep -rn 'SyncNext' internal` → 정의 1 · 자기 테스트 2
(`write/remote_actions_test.go:185,203`) 뿐이고 **호출자가 하나도 없다.**
`SyncNext` 와 `StepOutcome` 은 **exported** 라 패키지 밖에서 쓰이는 것처럼 보인다.

**격차**
FR-GCC-3 이 세운 원칙("쓰이지 않는 코드를 남기지 않는다")이 클라이언트에만
적용되고 서버 도메인 계층에는 적용되지 않았다. FR-GCC-4 가 지우라고 한 목록이
`핸들러·라우트·Go 테스트` 로 한정돼 있어 도메인 함수가 그물을 빠져나갔다.

**사용자 영향**
사용자에게는 없다. **유지보수 영향**: exported 죽은 코드가 자기 테스트로 초록을
유지하므로 커버리지·정적 분석 어느 쪽도 이것을 잡지 못한다. `write` 패키지를
읽는 다음 사람은 Sync 기능이 아직 있는 줄로 읽는다.

**제안 조치**
`remote.go:261-300` 구간과 `remote_actions_test.go` 의 `TestSyncNext_*` 를 함께
제거. FR-GIT-270 이 GIT_ACTIONS_SRS 에 ✅ 로 남아 있어(§2-C 참조) 문서 정정이 동반돼야 한다.

**규모** S

---

### [P2] `WORKBENCH_REVIEW_SRS.md` · D-WBR-8 — "다음 판에서 지운다" 한 죽은 분기가 그대로다

**명세**
> **D-WBR-8** `_paneNewToolRef` 의 editor 분기는 남겨 둔다 — **지금은 닿는 길이 없다**.
> … **지우지 않은 이유는 확신이 아니라 추적의 한계다** … **다음 판에서 확인하고 지운다**
> (`WORKBENCH_REVIEW_SRS.md:767`)

**실제 구현 상태**
분기가 그대로 있다 — `web/js/core/app-layout.js:732-736`:

```js
if(tab.type==='editor' && typeof tab.filePath==='string' && isAbsPath(tab.filePath)){
```

호출자는 둘(`app-layout.js:496`·`:676`)이고, SRS 가 밝힌 대로 Editor 창에서는
`addTab`·split 두 진입점이 FR-EDT-54·50·51 로 이미 막혀 있다.

**격차**
문서 작성일(2026-09-05) 이후 나흘이 지났고, 이 결정을 받은 후속 SRS 가 없다.
`WORKBENCH_REVIEW_HANDOFF.md` 에도 이 항목의 승계 기록이 없다.

**사용자 영향**
없다(닿지 않는 코드). 유지보수 부채이며, SRS 가 스스로 "확인하고 지운다" 고
약속한 것이 미이행 상태다.

**제안 조치**
`tab.type==='editor'` 분기의 도달 가능성을 e2e 로 한 번 확정한 뒤 제거하거나,
도달 가능하다면 D-WBR-8 을 철회하고 요구사항으로 승격.

**규모** S

---

### [P3] `ICON_ASSETS_SRS.md` · FR-ICON-4 — 자산은 있으나 아무도 참조하지 않는다

**명세**
> **FR-ICON-4** `web/assets/icon-192.png`, `icon-512.png` 를 제공한다. 둥근 타일,
> 투명 배경. | **필수** | (`ICON_ASSETS_SRS.md:112`)

같은 문서의 비목표 1 은 *"PWA 매니페스트(`manifest.webmanifest`)·서비스워커 —
설치형 앱 동작을 유발하므로 별도 결정 사항"* 이다(`:29`).

**실제 구현 상태**
- 자산 존재: `web/assets/icon-192.png`(9,987 B) · `icon-512.png`(40,199 B).
- `go:embed` 대상: `web/embed.go:10` 의 `assets/*` 가 둘을 바이너리에 넣는다.
- **참조: 0건.** `grep -rn 'icon-192\|icon-512\|manifest' web/index.html web/js`
  → 무출력. `web/index.html:11-14` 는 `favicon.svg`·`favicon-16/32.png`·
  `apple-touch-icon.png` 넷만 선언한다.

**격차**
FR-ICON-4 가 요구한 두 자산은 **오직 PWA 매니페스트만이 쓰는 규격**인데, 그
매니페스트는 같은 문서의 비목표다. 요구사항 자체가 자기 비목표와 어긋나 있고,
결과적으로 50KB 가 매 배포 바이너리에 실린 채 아무 데도 쓰이지 않는다.

**사용자 영향**
없다. 배포물 크기 +50KB.

**제안 조치**
둘 중 하나 — (a) FR-ICON-4 를 철회하고 자산 제거, (b) 비목표 1 을 철회하고
`manifest.webmanifest` 를 더해 자산을 살린다. 판단은 PWA 설치를 원하는지에 달렸다.

**규모** S

**함께 발견**: 이 문서의 `문서 상태: 승인 대기`(`:3`)는 **사실과 다르다.**
FR-ICON-1·2·3·5·6 은 전부 구현돼 있다(자산 파일 6개 · `index.html:11-14` ·
`embed.go:10`, 자산 mtime 2026-09-08). 06-docs-hygiene 의 DOC 항목(SRS 94% 에
상태 필드 없음)과 별개로, **상태 필드가 있는 7개 중 하나가 틀린 값**이라는 점이
추가된다 — 필드를 도입하는 것만으로는 부족하고 갱신 규약이 함께 필요하다.

---

### [P3] `DOCLANG_LSP_SRS.md` · FR-DLS-6~10 — 사용자 서술자 표: 파일 경로만 있고 UI 가 없다

**명세**
> **FR-DLS-6** 사용자는 설정에서 **서술자를 더할 수 있다**: 확장자들 · Monaco 언어
> id 들 · 실행 파일 · 인자.
> **FR-DLS-10** 표가 잘못 적혀 있으면(없는 실행 파일 등) **그 사실이 보인다.**
> 조용히 세션이 서지 않으면 사용자는 우리 버그로 읽는다 (D-9). (`:170-180`)

이 묶음은 `EDITOR_LSP_SRS` **FR-LSP-3 의 미구현분**으로 명시돼 있다(`:54`, `:91`).

**실제 구현 상태 — 부분 구현**
`LSP_PLUGIN_SRS` 가 흡수한 형태로 **길은 났다**: `internal/webserver/domain/ext/load.go:19`
의 `Load(root)` 가 격리 칸의 디렉터리를 훑어 사용자가 직접 놓은 `plugin.json` 을
읽는다. 오류를 모아서 내는 규약도 있다(`load.go:18` 주석, FR-EXT-8).

그러나 FR-DLS-6 이 요구한 **"설정에서"** 는 아니다 — 사용자가 파일시스템의 특정
경로에 JSON 을 손으로 놓아야 한다. FR-DLS-10 의 "그 사실이 보인다" 는
`Load` 가 모은 `[]error` 가 화면까지 전달되는지 이 축에서 **확인하지 못했다(미확인)**.

**사용자 영향**
목록에 없는 언어(예: Rust `rust-analyzer`, Java `jdtls`)를 쓰려면 문서화되지 않은
경로에 매니페스트를 직접 작성해야 한다. 발견 가능성이 사실상 0 이다.

**제안 조치**
FR-DLS-6~10 을 `LSP_PLUGIN_SRS` 의 "사용자 매니페스트" 로 정식 흡수하고
(DOCLANG_LSP 자신이 그 가능성을 예고한다 — `:16`), 흡수했으면 DOCLANG_LSP §3.2 를
철회 표기. 흡수하지 않을 거면 설정 UI 가 필요하다.

**규모** S(문서 정리) / M(설정 UI 까지)

---

## 2. 상호 모순되는 SRS — 나중 문서가 앞 문서를 뒤집었으나 앞 문서가 그대로다

세 건 모두 **코드는 나중 문서를 따른다.** 결함은 코드가 아니라 문서 집합에 있다 —
앞 문서만 읽은 사람이 사실과 반대되는 결론을 얻는다.

### [P2] A. 파일 검색(Ctrl+P) — `EDITOR_TAB_SRS` 비목표 ↔ `EDITOR_GIT_UX_SRS` 구현

| | 내용 |
|---|---|
| **앞** | `EDITOR_TAB_SRS.md` §6 비목표 3: *"**파일 검색 (Ctrl+P 류).** 탐색기는 트리이지 검색기가 아니다."* |
| **뒤** | `EDITOR_GIT_UX_SRS.md` FR-EQO-1~8 · V-EQO-6: *"`cmd+p` → 고르기 → 탭이 열린다"*(`:370`) |
| **코드** | `web/js/core/helpers.js:268` `edQuickOpen:'Mod+KeyP'` · `:305` `'파일 검색 (Editor)'` · `:314` `'_edQuickOpen'`. 서버는 `/api/fs/find`(`handlers_api.go:153`), 구현 `handlers_fs_search.go` |

**핵심**: `EDITOR_TAB_SRS` 는 `EDITOR_GIT_UX_SRS`(2026-09-04)보다 **나중에
수정됐는데도**(2026-09-08) 비목표가 그대로다. `EDITOR_GIT_UX_SRS` 는
`EDITOR_TAB_SRS` 를 **한 번도 언급하지 않는다**(`grep 'EDITOR_TAB' EDITOR_GIT_UX_SRS.md`
→ 0건). 두 문서 어느 쪽도 상대를 모른다.

**제안 조치** `EDITOR_TAB_SRS` §6-3 을 `~~취소선~~ + **(철회, EDITOR_GIT_UX_SRS FR-EQO-*)**`
로 표기 — 같은 저장소가 이미 쓰는 관행이다(`GIT_SIDEBAR_TABS_SRS.md:309` 참조). **규모 S**

---

### [P2] B. 폴더 zip 다운로드 — `FILE_TRANSFER_SRS` 비목표 ↔ `EXPLORER_TRANSFER_IGNORE_SRS` 구현

| | 내용 |
|---|---|
| **앞(구현)** | `EXPLORER_TRANSFER_IGNORE_SRS.md`(2026-09-05) D-4 묶음 B — 폴더 다운로드는 zip |
| **뒤(비목표)** | `FILE_TRANSFER_SRS.md`(2026-09-06) §6: *"**폴더 다운로드(zip).** 서버 표면과 항목 수·크기 상한을 새로 정해야 한다."* |
| **코드** | `internal/webserver/httpapi/handlers_fs_zip.go` — `GET /api/fs/download-dir`(`:15`), 라우트 `handlers_api.go:166`, 상한 `zipMaxEntries=50000`(`:31`) · `zipMaxBytes=2GB`(`:33`) |

**핵심**: `FILE_TRANSFER_SRS` 가 비목표 사유로 든 바로 그것("항목 수·크기 상한을
새로 정해야 한다")이 **이미 코드에 상수로 정해져 있다.** 날짜상 나중 문서가
앞 문서의 성과를 모른 채 비목표로 적었다.

**제안 조치** `FILE_TRANSFER_SRS` §6 첫 줄 철회 표기 + `handlers_fs_zip.go` 로 링크. **규모 S**

---

### [P2] C. Sync · Push preview — `GIT_ACTIONS_SRS` ✅ ↔ `GIT_CHANGES_CONTROLS_SRS` 삭제

| | 내용 |
|---|---|
| **앞** | `GIT_ACTIONS_SRS.md:308` FR-GIT-270 **Sync** · `:310` FR-GIT-271 **Push preview**. 상태표 `:490` `\| E 원격 \| 269~271 \| ✅ \|` |
| **뒤** | `GIT_CHANGES_CONTROLS_SRS.md:64-66` FR-GCC-2(버튼·다이얼로그 삭제) · FR-GCC-3(클라이언트 코드 삭제) · FR-GCC-4(서버 종단·핸들러·라우트·테스트 삭제) |
| **코드** | 나중 문서를 따랐다 — `gitapi/routes.go` 에 `/api/git/sync`·`/api/git/push/preview` 0건. **단 도메인 잔재 있음(§1 참조)** |

**핵심**: `GIT_ACTIONS_SRS` 는 269~271 을 **✅ 완료로 표시한 채** 그대로다.
`grep 'GIT_CHANGES_CONTROLS\|GCC' GIT_ACTIONS_SRS.md` → **0건**. Git 표면의 진실
공급원을 자처하는 문서(`GIT_SURFACE_MAP` 126항목 전수 대조본)가 **이미 삭제된
기능 둘을 제공된다고 말한다.**

이 셋 중 사용자 영향이 가장 큰 모순이다 — `GIT_ACTIONS_SRS` 는 "무엇이 되는가" 의
색인으로 쓰이는 문서이기 때문이다.

**제안 조치** `:490` 을 `269 ✅ / 270·271 ⊘ 삭제 (GIT_CHANGES_CONTROLS_SRS FR-GCC-2·4)`
로 정정하고, `:308`·`:310` 에 철회 표기. **규모 S**

---

### [P3] D. `EDITOR_TAB_SRS` 의 "cross-platform 보류 방침" — 존재하지 않는 조항을 두 번 인용

`EDITOR_TAB_SRS.md:845` 와 `:1098`(D-7)이 근거로 드는 **"cross-platform 보류 방침
(§6 비목표)"** 이 §6 에 없다. §6 비목표 10개를 전수 확인했고(1 Monaco · 2 Git 창 ·
3 파일 검색 · 4 파일 감시 · 5 중첩 저장소 색 · 6 휴지통 · 7 잘라내기 · 8 모바일 ·
9 편집기 탭 백그라운드화 · 10 dmctl 서브커맨드) cross-platform 항목은 없다.

게다가 그 "방침" 자체가 `CROSS_PLATFORM_SRS.md` 로 뒤집혔다 — Windows·Linux 는
이제 1급 대상이다(`scripts/build.sh:20` `TARGETS=(darwin/arm64 darwin/amd64
linux/amd64 linux/arm64 windows/amd64)`, `.github/workflows/verify.yml` 이
`windows-latest`·`ubuntu-latest` 에서 실기 검증).

**영향**: D-7("삭제는 영구 삭제, 휴지통은 플랫폼 의존이라 …")의 근거가 무효다.
결정 자체는 유지할 수 있으나 **근거를 다시 세워야 한다.** **규모 S**

---

### [P3] E. `diag_snapshot_test.go` 데이터 경쟁 — 두 SRS 가 미결로 남겼으나 이미 닫혔다

- `DEEPENING_REFACTOR_SRS.md` §7.5: *"이 리팩터와 **무관한 기존 결함**이다 …
  `git archive HEAD` 로 뜬 기준선에서도 같은 실패가 재현된다"*
- `SPLIT_REFACTOR_SRS.md` §7.5: *"비목표 N5. 무관한 기존 결함이며 `-race` 없이는 통과한다."*

**실측**: `go test -race -count=3 -run TestDiagSnapshot ./internal/webserver/httpapi/`
→ `ok dongminal/internal/webserver/httpapi 2.265s`. 재현되지 않는다.
`diag_snapshot_test.go:168-170` 에 `<-done` 과 함께 사유가 적혀 있다 —
*"**끝난 것을 확인한 뒤에 읽는다** … 그 규약이 여기에만 빠져 있었다 (FR-CAF-1)"*.
`CODE_AUDIT_FIXES_SRS` FR-CAF-1 이 닫았다.

**영향**: 두 활성 SRS 가 **이미 해결된 결함을 미결로 광고한다.** 다음 사람이
같은 조사를 반복한다. **규모 S**(두 §7.5 에 해소 표기)

---

## 3. 의도적 비목표 — 프로덕션 관점 재검토 필요

**아래는 결함이 아니다.** SRS 가 근거를 밝히고 범위 밖으로 선언한 것들이며,
전부 코드에서 부재를 확인했다. 프로덕션 판단이 필요한 것만 모았다.

| # | 출처 | 선언 내용 | 코드 확인 | 재검토 사유 |
|---|---|---|---|---|
| 1 | `FILE_TRANSFER_SRS` §6 | *"`/api/upload`·`/api/download` 의 **인증**. 이 종단들은 인증 없이 임의 경로를 읽고 쓴다. `--expose` 로 0.0.0.0 에 띄우면 LAN 의 누구나 닿는다 … §7 에 위험으로 기록한다"* | 게이트는 `accessGate`(`server.go:216`) 하나이고 **기본 비활성** (`access.go:285` `if !s.cfg.Enabled` → 전부 통과) | 기존 **SEC-1·SEC-2·GO-1·TEST-1** 과 같은 뿌리. SRS 가 **스스로 위험으로 기록해 두었다**는 점이 새 정보 — 팀이 이미 인지한 사안이다 |
| 2 | `ACCESS_ALLOWLIST_SRS` §6 | 1 인증 · 2 TLS(*"평문 HTTP 그대로다. 같은 네트워크에서 트래픽은 읽힌다"*) · 5 속도 제한·차단 이력·잠금 | `access.go` 전문 확인 — 출발지 IP 판정만 | allowlist 는 **기밀성·무결성을 주지 않는다.** README:81-87 의 "신뢰하는 망에서만" 경고와 함께 읽어야 한다 |
| 3 | `SANDBOX_WINDOW_SRS` §6 | *"**컨테이너 자원 제한**(cpu·memory·pids). 후속 과제"*(`:545`) · *"**HTTP API 인증·권한 스코프.** `dev` 를 격리 경계로 만들려면 필요하지만 … 이 SRS 는 그 부재를 §3.3 으로 명시할 뿐 해결하지 않는다"* | `internal/shared/sandbox/` 전 파일에 `cpu`·`memory`·`pids` 0건 | 샌드박스 창의 도구가 **호스트 자원을 무제한 쓴다.** AI 에이전트가 도는 컨테이너라 폭주 시나리오가 가설이 아니다 |
| 4 | `EXPLORER_TRANSFER_IGNORE_SRS` D-4 | *"HTTPS 도입은 사용자가 보류했다"* → File System Access API 불가 → 폴더 다운로드가 zip 으로 우회 | `handlers_fs_zip.go` | HTTPS 보류가 UX 를 이미 한 번 굴절시켰다. 2번과 같은 결정에 걸려 있다 |
| 5 | `E2E_UNIFICATION_SRS` §6-4 | *"**git 쓰기 계열 검사**(`fetch`·`pull`·`push`) — 네트워크와 자격증명이 필요하다. 별도 트랙"* | `.github/workflows/e2e.yml` 확인 | git 쓰기 경로가 **CI 에서 한 번도 돌지 않는다.** 05-Test 축과 겹칠 수 있음 |
| 6 | `RUN_ORCHESTRATION_SRS` FR-STA-4 2단계 | *"스펙에 남기고 **구현만 보류**했다(사용자 확정) — 화면 패턴은 스테이터스라인 하나로 깨지며 … codex 패턴을 실측할 수 없어 추측을 코드에 넣지 않았다"*(`:757`) | 미구현 확인. **다만 `agentadapter/adapter_test.go:72` 에 가드 테스트가 있다** — 소비자 없는 화면 패턴을 선언하면 실패시킨다 | **재검토 불필요 — 모범 사례로 기록한다.** 의도적 미구현을 테스트로 봉인한 유일한 사례이며, 다른 보류 항목(§1 의 D-WBR-8 등)이 본받을 형태다 |
| 7 | `EDITOR_TAB_SRS` §6-4 | *"**파일 감시(watch).** 갱신 계기는 FR-EDT-67 의 셋뿐이다"* | `POLL_INTERVAL_SETTINGS_SRS:41` 이 *"열려 있는 편집기 탭의 내용을 디스크에서 다시 읽는 경로 — 지금 없고, 별건이다"* 로 재확인 | 에이전트가 파일을 고치는 것이 이 앱의 전제인데, **열린 편집기 탭은 그것을 모른다.** 오케스트레이션 제품에서 이 비목표는 재검토 값이 있다 |
| 8 | `EDITOR_TAB_SRS` §6-6 / D-7 | *"**휴지통.** 삭제는 영구 삭제다"* | `FS_DELETE_MAX` 상한만 있고 되돌림 없음(`handlers_fs.go:41`) | 근거가 §2-D 로 무효화됐다. 결정 유지 여부와 무관하게 **근거 재작성 필요** |
| 9 | `EXPLORER_TRANSFER_IGNORE_SRS` §6 / `FILE_TRANSFER_SRS` §6 | *"전송 진행률·취소 UI"* 없음 | — | 2GB zip·10,000 항목 업로드에 취소 수단이 없다. 상한이 커서 체감이 크다 |

---

## 4. 미확인 (추측하지 않은 것)

- **FR-DLS-10** — `ext.Load` 가 모은 `[]error` 가 실제로 화면까지 도달하는지
  UI 경로를 끝까지 따라가지 못했다.
- **`EDITOR_DIRTY_DIFF_SRS`(21/58 미참조) · `SLOT_TITLE_BOUNDARY_SRS`(9/29) ·
  `GIT_REPO_MISSING_SRS`(9/42)** — 표본(FR-EDD-6·13)은 구현돼 있었으나 전수
  대조는 하지 않았다. 미참조가 곧 미구현이 아님은 §0 에서 확인했다.
- **`SPLIT_REFACTOR_SRS`(17/18) · `PACKAGE_RESTRUCTURE_SRS`(27/48) ·
  `DEEPENING_REFACTOR_SRS`(25/39) · `CLI_CONSOLIDATION_SRS`(26/52) ·
  `README_REWRITE_SRS`(14/17)** — 전부 **구조 리팩터·문서 재작성 SRS** 로,
  FR 이 코드에 인용될 성질이 아니다. 실제 분할 여부는 확인하지 않았다.
- **e2e 실행 결과** — Playwright 를 돌리지 않았다. `V-DLS-*` 등 검증 항목의
  존재 여부만 grep 으로 봤다.

---

## 5. 커버리지 — 정직한 집계

### 5.1 실제로 열어 코드와 대조한 SRS — **31개 / 활성 113개 (27%)**

| # | SRS | 대조한 것 | 결과 |
|---|---|---|---|
| 1 | `DOCLANG_LSP_SRS` | FR-DLS-1~16 전수 | **묶음 D 미구현** · 묶음 B 부분 |
| 2 | `GIT_ACTIONS_SRS` | FR-GIT-250~285 (36개) | **283·284 미구현 · 285 절반** |
| 3 | `GIT_CHANGES_CONTROLS_SRS` | FR-GCC-1~13 전수 | **FR-GCC-3·4 불완전(죽은 코드)** |
| 4 | `WORKBENCH_REVIEW_SRS` | D-WBR-8 | **미이행** |
| 5 | `ICON_ASSETS_SRS` | FR-ICON-1~7 전수 | **FR-ICON-4 사표** · 상태 필드 오류 |
| 6 | `EDITOR_TAB_SRS` | §6 비목표 10개 · FR-EDT-115/116 · D-7 | **모순 A·D** |
| 7 | `EDITOR_GIT_UX_SRS` | FR-EQO-4/5 · FR-EGS-5/6 | 구현 (`handlers_fs_search.go`) |
| 8 | `FILE_TRANSFER_SRS` | §6 비목표 5개 | **모순 B** · 비목표 1 |
| 9 | `EXPLORER_TRANSFER_IGNORE_SRS` | FR-ETR-21~24 · D-4 · §6 | 구현 (`EDITOR_UPLOAD_MAX_ENTRIES`) |
| 10 | `CROSS_PLATFORM_SRS` | §2.2 표 16이음매 · FR-XSY/XBD | 전부 구현 |
| 11 | `ACCESS_ALLOWLIST_SRS` | FR-ACL 미참조 7개 · §6 | 구현 · 비목표 2 |
| 12 | `ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS` | FR-ATL-1~11 · FR-ATJ-1~3 | 전부 구현 (`main.go:472-489`) |
| 13 | `SKILL_INJECTION_SRS` | FR-RM-1~6 · FR-SK-1~5 | MCP 삭제 완료 |
| 14 | `ALERT_MOBILE_CONTEXT_SRS` | FR-SYN-1~7 | 구현 (문서 §7 이 명시) |
| 15 | `RUN_ORCHESTRATION_SRS` | FR-STA-4 사다리 · 묶음 A/W/K | **2단계 의도적 보류(가드 있음)** |
| 16 | `ORCHESTRATION_V2_SRS` | FR-PAT-1~11 · D-3 | 문서 산출물로 구현(`references/patterns.md`) |
| 17 | `WORKSPACE_IDENTITY_SRS` | FR-UNI-2/14/15 | 구현 (`run/store.go:24`) · 표기 stale |
| 18 | `LSP_PLUGIN_SRS` | FR-EXT-1~41 표본 | 구현 (`domain/ext/`) |
| 19 | `EDITOR_LSP_SRS` | FR-LSP-3/19/52/53 | 19·52·53 구현 · 3 은 DOCLANG 으로 이관 |
| 20 | `SANDBOX_WINDOW_SRS` | §6 자원 제한 · 인증 | **비목표 3** |
| 21 | `RECONNECT_STORM_SRS` | §6 비목표 · FR-LOG-1~4 | 철회분 전부 구현 (`ctl/cli/logcap.go`) |
| 22 | `DIFF_HUNK_BAR_SRS` | FR-DHB-2 폐기 목록 전수 | 폐기 완료 |
| 23 | `EDITOR_DIRTY_DIFF_SRS` | FR-EDD-6/13 | 구현 (`file-editor-diff.js:73`) |
| 24 | `APP_STATE_EXTRACT_SRS` | §7.5 · §8 | 보류분 §8 에서 종결 |
| 25 | `DEEPENING_REFACTOR_SRS` | §7.5 | **모순 E** |
| 26 | `SPLIT_REFACTOR_SRS` | §7.5 | **모순 E** |
| 27 | `FG_RESTORE_RACE_SRS` | §7.4 · §8 | 미조사분 §8 에서 종결 |
| 28 | `CI_E2E_MATRIX_SRS` | FR-CEM-1~30 | 구현 (`.github/workflows/e2e.yml`) |
| 29 | `E2E_PARALLEL_SRS` | FR-EPL-1~11 | 구현 (`playwright.config.ts`) |
| 30 | `E2E_UNIFICATION_SRS` | §6 비목표 | **비목표 5** |
| 31 | `CODE_AUDIT_FIXES_SRS` | FR-CAF-1 | 구현 (경쟁 해소 실측) |

### 5.2 기계 대조만 한 SRS — **26개** (FR 접두별 코드 참조율 산출, 개별 검증 없음)

`SETTINGS_PORTABILITY`(14/16) · `LEAVE_CONFIRM_TOGGLE`(9/11) · `BOOT_SCREEN`(13/16) ·
`BOOT_SCREEN_REUSE`(8/12) · `HELPER_INSTALL`(9/11) · `PANEL_SHORTCUTS`(4/6) ·
`SETTINGS_CONTROLS`(7/9) · `ASSET_VERSION_SINGLE_SOURCE`(10/15) · `SLOT_RUN_VIEW`(4/7) ·
`HISTORY_BRANCH_BUTTON`(4/7) · `SLOT_VIEW_STATE`(45/50) · `TOOL_HISTORY_ISOLATION` ·
`SCHEDULER_REARM` · `HOST_PARITY` · `VIEWER_URL_OPEN` · `SUBMODULE_DIRTY_NOTICE` ·
`TERM_XFER_NOTICE` · `UNFOCUSED_EDGE` · `TAB_WIDTH` · `SIDEBAR_COLLAPSE` ·
`PANE_DOM_RECONCILE` · `WORKSPACE_SAVE_CONFLICT` · `TOOL_LIST_UNKNOWN` ·
`REPO_SIDE_WIDTH` · `STATUS_BAR_REFLOW` · `CONFIRM_ONE_STAGE`
— 전부 코드 참조율 60% 이상이며 명백한 공백 없음. **개별 FR 검증은 하지 않았다.**

### 5.3 대조하지 않은 SRS — **56개**

| 사유 | 문서 |
|---|---|
| **타 에이전트 전담** (5) | `DRIFT_RECLAIM` · `GIT_OBSERVE_REVIVE` · `GIT_LIVE_TRIGGERS` · `GIT_PUSH_OBSERVE` · `GIT_VIEW_REFRESH` |
| **대형 Git SRS — 예산 초과** (7) | `GIT_SRS`(175 FR) · `GIT_REVIEW4`(45) · `GIT_UI_REVISION`(55) · `GIT_SIDEBAR_TABS`(40) · `GIT_DIR_ENTRY`(29) · `GIT_REPO_MISSING`(42) · `GIT_FOLLOW_REMOVAL`(27). `GIT_ACTIONS_SRS` 를 **Git 표면 전수 대조본**으로 삼아 그 하나만 깊이 팠다 |
| **대형 UX 배치 — 예산 초과** (8) | `UX_REVISION`(124 FR) · `UX_BATCH5`(63) · `UX_BATCH6`(66) · `UX_BATCH8` · `UX_BATCH9` · `CONVENIENCE`(44) · `WORKBENCH_REVIEW`(D-WBR-8 만 봄) · `REPO_TAB_UNIFY`(77) |
| **구조 리팩터 — FR 인용 불가라 방법이 없음** (5) | `PACKAGE_RESTRUCTURE` · `ENTITY_MODEL_RESTRUCTURE` · `REFACTOR_STABILIZATION` · `ATTN_UTIL_RELOCATE` · `E2E_HELPER_RECLAIM` |
| **문서·릴리스 산출물** (3) | `README_REWRITE` · `RELEASE` · `LEFTOVERS` |
| **나머지** (28) | `EVENT_TIMER_HUB`(76 FR) · `WINDOW_SLOTS`(54) · `PANEL_SURFACE`(63) · `UI_KIT`(52) · `ATTENTION_FIRING`(51) · `DOC_RENDER_VIEW`(46) · `MOBILE_TUI_INPUT_SCROLL`(40) · `SANDBOX_PICK_COPY` · `EDITOR_FIND_PANEL` · `NOTES_LIVE_EXPLORER` · `POLL_INTERVAL_SETTINGS` · `RELOAD_CONTINUITY` · `WINDOWS_TEST_PARITY` · `LSP_WINDOWS_PORTABILITY` · `WINDOWS_TOOL_CWD` · `CONNECTIVITY_RESILIENCE` · `SOFT_RELOAD` · `BRACKETED_PASTE` · `BRANCH_MENU_UNIFY` · `BRIGHT_DARK_THEMES` · `PAGE_TITLE` · `SYSTEM_STATS` · `WINDOW_COMMAND` · `RESTORE_FLIGHT` · `SLOT_TITLE_BOUNDARY` · `TOOL_LIST_UNKNOWN` · `E2E_QUIESCENCE` · `ATTENTION_PULSE` — **시간 배분 문제이며 위험 신호가 있어서가 아니다.** 이 중 유보 표현이 잡힌 것은 없다 |

**커버리지 요약**: 깊이 대조 31개(27%) · 기계 대조 26개(23%) · 미대조 56개(50%).
유보 표현(`미구현`·`보류`·`다음 판`·`남은 것`·`철회`) grep 은 **활성 SRS 전량에
돌렸으므로**, "SRS 가 스스로 밝힌 미완성" 유형은 사실상 전수 조사됐다.
놓쳤을 가능성이 큰 것은 **SRS 가 완료라고 믿지만 실제로는 반쪽인 것**이며,
그것은 5.3 의 28개에 숨어 있을 수 있다.

---

## 6. 발견 요약

### 미구현·부분구현 (6건)

| 심각도 | SRS · FR | 격차 | 규모 |
|---|---|---|---|
| P2 | `DOCLANG_LSP` · FR-DLS-13·14·15 | 문서 심볼·문서 링크 전무 (묶음 D 통째) | M |
| P2 | `GIT_ACTIONS` · FR-GIT-283·284 | 3-way merge editor · 인터랙티브 rebase 미구현 | L / M |
| P2 | `GIT_ACTIONS` · FR-GIT-285 | `init` 만 섰고 `clone` 없음 | S/M |
| P2 | `GIT_CHANGES_CONTROLS` · FR-GCC-3·4 | `write.SyncNext`·`StepOutcome` 죽은 코드 잔존 | S |
| P2 | `WORKBENCH_REVIEW` · D-WBR-8 | "다음 판에 지운다" 한 죽은 분기 잔존 | S |
| P3 | `ICON_ASSETS` · FR-ICON-4 | `icon-192/512` 참조 0건 (자기 비목표와 충돌) | S |
| P3 | `DOCLANG_LSP` · FR-DLS-6~10 | 사용자 서술자에 UI 없음, 파일 경로만 | S / M |

### 상호 모순 SRS (5건)

| 심각도 | 앞 문서 | 뒤 문서 | 코드가 따르는 쪽 |
|---|---|---|---|
| P2 | `EDITOR_TAB` §6-3 (Ctrl+P 비목표) | `EDITOR_GIT_UX` FR-EQO-* | **뒤** |
| P2 | `EXPLORER_TRANSFER_IGNORE` D-4 (zip 구현) | `FILE_TRANSFER` §6 (zip 비목표) | **앞** — 뒤 문서가 stale |
| P2 | `GIT_ACTIONS` :490 (269~271 ✅) | `GIT_CHANGES_CONTROLS` FR-GCC-2·4 (삭제) | **뒤** |
| P3 | `EDITOR_TAB` :845·:1098 ("§6 cross-platform 보류") | §6 에 그런 조항 없음 + `CROSS_PLATFORM_SRS` 가 방침 반전 | — (dangling) |
| P3 | `DEEPENING_REFACTOR`·`SPLIT_REFACTOR` §7.5 (경쟁 미결) | `CODE_AUDIT_FIXES` FR-CAF-1 | **뒤** — 앞 둘이 stale |

### 의도적 비목표 중 프로덕션 재검토 대상 (5건)

1. `/api/upload`·`/api/download` 무인증 — `FILE_TRANSFER` §6 (SEC-1·2·GO-1 과 동근)
2. 인증·TLS·속도제한 전무, allowlist 기본 OFF — `ACCESS_ALLOWLIST` §6
3. 샌드박스 컨테이너 자원 제한(cpu·mem·pids) 없음 — `SANDBOX_WINDOW` §6
4. 열린 편집기 탭의 파일 감시 없음 — `EDITOR_TAB` §6-4 (에이전트가 파일을 고치는 제품)
5. git 쓰기 계열(fetch·pull·push) CI 미검증 — `E2E_UNIFICATION` §6-4

### 모범 사례로 기록할 것 (1건)

`RUN_ORCHESTRATION` FR-STA-4 2단계 — 의도적 미구현을 **가드 테스트로 봉인**했다
(`internal/shared/agentadapter/adapter_test.go:66-72`: 소비자 없는 화면 패턴을
선언하면 실패). 다른 보류 항목(D-WBR-8 등)이 본받을 형태다.
