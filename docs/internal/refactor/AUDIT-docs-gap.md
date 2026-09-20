# 감사: 문서 ↔ 구현 대조 (AUDIT-docs-gap)

> 읽기 전용 감사. 소스는 한 줄도 고치지 않았다. 생성 스크립트(`gen-errors`·`gen-decisions`)는
> 실행 후 diff 0 이었으므로 되돌릴 것이 없었다.
>
> - 일시: 2026-09-20 · 브랜치 `refactor` · HEAD `ba13ec92`
> - 방법: `make gates` 전량 실행(통과) · SRS 167건 상태 필드 추출 · FR 번호 집합
>   대조(문서 4,228 vs 코드 3,237) · 코드 증거 직접 확인

---

## 1. 요약

### 1.1 SRS 상태 분포 (`docs/internal/*_SRS.md`, 167건)

| 상태 | 건수 | 비고 |
|---|---:|---|
| `승인·구현완료` | 160 | |
| `승인·구현중` | 5 | **5건 전부 라벨이 틀렸다** (§3 H2·H3·M1·H1) |
| `폐기` | 1 | `DOCLANG_LSP_SRS` — `FR-M10-7` 이 근거를 남겼다. 정상 |
| `대체` | 1 | `AGENT_PROTOCOL_SURFACE_SRS`. 정상 |
| `초안` · `승인대기` | 0 | 방치된 초안 없음 |

`docs/internal/archive/` 40건은 상태 필드가 없다 — `check-srs-status.sh` 가
`docs/internal/*_SRS.md` 만 보므로 게이트 밖이며, `docs/internal/README.md` 가
"보관 문서는 갱신하지 않는다" 로 명시한 **의도된 범위**다. 결함 아님.

### 1.2 괴리 건수

| 분류 | 건수 | 등급 분포 |
|---|---:|---|
| 미구현 (완료 표기인데 코드 없음) | **0** | — |
| 구현 미흡 | 1 | MED 1 (§3 M5) |
| 잘못 구현 | 0 | — |
| 문서가 낡음 | 6 | HIGH 2 · MED 3 · LOW 1 |
| 상태 라벨 오류 | 5 | HIGH 3 · MED 1 (문서 4건, 색인 2건) |
| 고아 문서 | **0** | — |
| 생성물 비동기 | **0** | — |
| 대조 문서 비동기 | 1 | HIGH 1 (게이트 **밖** 표면) |
| TODO/FIXME/HACK | **0** | — |
| 추적성 (FR 번호) | 2 | MED 2 |

### 1.3 이미 잘 돌고 있는 것 (반증 목적으로 실측했다)

| 검사 | 결과 |
|---|---|
| `make gates` (게이트 33종) | **exit 0** — 전량 통과 |
| `go run ./scripts/gen-errors` | `docs/external/errors.md` diff **0줄** |
| `go run ./scripts/gen-decisions` | `docs/internal/decisions.md` diff **0줄** (589건) |
| `check-commands-docs.sh` | ok (32개) — `commands.md` ↔ `dmctl` 양방향 일치 |
| `check-api-docs.sh` | ok (155개) — `api.md` ↔ 라우트 표 |
| `check-shortcuts-docs.sh` | ok (34개) — `shortcuts.md` ↔ `helpers.js` |
| `check-env-docs.sh` | ok (18개) — `getting-started.md` 환경변수 표 ↔ `DONGMINAL_*` |
| TODO/FIXME/HACK/XXX | 1급 코드(`internal/` · `cmd/` · `web/js/` · `scripts/` · `e2e/`)에 **0건**. 히트는 `web/vendor/`(제3자) · `.golangci.yml` 주석 · `outbuf/stream_test.go:166` 의 `"XXXXX"` 픽스처 리터럴뿐 |
| 색인 누락 | `docs/internal/README.md` 가 SRS **167/167** 을 링크. archive 40건도 `./archive/*.md` 로 별도 표. 끊긴 링크 0 |

**그래서 이 감사가 찾은 것은 "게이트가 재지 않는 표면"에 몰려 있다.** 기계가 재는
자리는 전부 초록이고, 손으로 적는 자리(`features.md`·`architecture.md`·색인 설명문·
상태 라벨)만 낡았다. 이것이 이 보고서의 단일 결론이다.

---

## 2. 방법과 그 한계

### 2.1 쓴 것

1. `docs/internal/*_SRS.md` 167건의 제목·상태 한 줄을 스크립트로 추출 → `/tmp/srs.tsv`
2. 문서의 FR 번호 집합(4,228) − 코드·CI 의 FR 번호 집합(3,237) 차집합을 **문서별로** 계산
3. 차집합 상위 문서를 코드에서 직접 확인 (`grep` 텍스트 검색 · 파일 존재 · 심볼 정의)
4. `docs/internal/README.md` 색인의 "구현 완료/중" 표기 ↔ 각 문서의 상태 필드 교차 대조 (Python)
5. 생성 스크립트 실행 후 `git diff`, 그리고 `git status --short` 로 원상 확인

### 2.2 한계 — 이 수치를 믿지 말아야 하는 자리

**"FR 번호가 코드에 없다"는 미구현의 증거가 아니다.** 실측으로 확인했다:

- `SPLIT_REFACTOR_SRS` 는 선언 FR 17개 중 **17개 전부**가 코드에 인용돼 있지 않다.
  그러나 묶음 A~D 전부 구현돼 있다 — 코드는 `FR-MSP-*` 대신 **문서 이름**을 인용한다
  (`web/js/git/panel-changes.js:2`, `web/js/ui/file-tree-paint.js:2`, `web/style.css:6`
  등 13곳). 그 문서가 §1.4 에서 "`FR-SPL` 은 `PACKAGE_RESTRUCTURE_SRS` 소유" 라며
  접두어 충돌을 피한 것도 확인했다.
- `POPUP_DEFAULT_ACTION_SRS` 의 `FR-PDA-20~26` 은 **다른 SRS 를 개정하라**는 요구다.
  코드에 있을 수 없다. 전부 이행됐음을 대상 문서에서 확인했다
  (`GIT_SRS.md:437-439`·`627-631`·`428-432`, `CONFIRM_ONE_STAGE_SRS.md:116`·`147`·`173-174`,
  `production/M2_PROGRESS.md:80`).
- `ACCESSIBILITY_BASELINE_SRS` 의 미인용 15건은 대부분 정책 선언
  (`FR-A11Y-1` = "README 에 WCAG 2.1 AA 선언" → `README.md:227` 에 있다).

따라서 본문의 판정은 **전부 개별 확인을 거친 것만** 적었다. 차집합은 우선순위 결정에만 썼다.

---

## 3. 항목 (우선순위 순)

### [HIGH] H1 — M11_SRS · M12_SRS: 대상이 제거된 문서가 `승인·구현중` 으로 살아 있다

- **문서**: `docs/internal/M11_SRS.md` (상태: 승인·구현중) · `docs/internal/M12_SRS.md` (상태: 승인·구현중)
- **요구**: 두 문서의 본체는 **에이전트 GUI** 다. `M11_SRS` 는 머리글에서 "B10·B11·B15·B22·B23·
  B26·B27·B28·B29·B35·B36 — 명세는 이미 있다, 남은 것은 옮기는 일" 이라며 **미완 11건을 명시**하고,
  `M12_SRS` 의 `FR-M12-1~8`·`13~23` 은 전부 GUI 대화 뷰의 동작이다.
- **실제**: `AGENT_GUI_REMOVAL_SRS` 가 그 GUI 를 **코드에서 걷어 냈다**. 실측:
  - `web/js/ui/agent-pane.js` — 없음
  - `web/js/core/app-agent-tool.js` — 없음
  - `internal/webserver/domain/agentsess/` — 없음
  - `toolhub.KindAgent` — 없음 (남은 `MsgKindAgent` 는 `domain/run` 의 메시지 종류로 무관)
  - `/api/agent/*` — 없음. `internal/shared/runtime/skills_contract_test.go:310` 이
    `--agent`·`/api/agent/` 의 **부재를 가드 테스트로 봉인**하고 있다
- **차이**: 문서 낡음 + 상태 라벨 오류. `AGENT_GUI_REMOVAL_SRS` §2.3 비목표가
  *"기존 SRS 문서(M8~M12)의 수정. 그것은 **기록**이며 이 문서가 그 위에 선다"* 로 **의도적으로**
  두 문서를 건드리지 않기로 했다. 그 판단 자체는 타당하다 — 그러나 **상태 필드는 기록이 아니라
  현재 상태를 말하는 enum** 이고, `승인·구현중` 은 "지금 누군가 만들고 있다" 를 뜻한다.
  `check-srs-status.sh` 는 enum 안에 있는지만 보므로 이 모순을 잡지 못한다.
- **제안**: **문서를 고친다.** 두 문서의 상태를 `대체` 로 내리고, 상태 줄 바로 아래에
  `AGENT_GUI_REMOVAL_SRS` 를 가리키는 한 줄(`GIT_SRS.md` 머리의 "후속 문서가 이 SRS 의 일부를
  개정했다" 표와 같은 형식)을 둔다. 본문은 비목표대로 그대로 둔다 — 기록이므로.
  근거: `AGENT_PROTOCOL_SURFACE_SRS` 가 이미 같은 사유로 `대체` 를 쓰고 있어 선례가 있다.
  코드를 고치는 선택지는 없다 — 사용자 결정으로 제거한 것을 되살릴 이유가 없다.
- **공수**: S (두 문서에 각 2줄)

---

### [HIGH] H2 — AGENT_GUI_REMOVAL_SRS: 구현이 끝났는데 `승인·구현중`

- **문서**: `docs/internal/AGENT_GUI_REMOVAL_SRS.md` (상태: **승인·구현중**)
- **요구**: `FR-AGR-1`~`16` — 프론트 뷰·탭 종류·올리기 경로·승인 정책·문구·스타일·HTTP 표면·
  해석층·세션 신원 저장소·`KindAgent`·오류 코드·`dmctl new-tab --agent`·인계 `gui` 갈래·
  e2e 가짜 배선·테스트를 **전부 제거**한다. `FR-AGR-12`(어댑터는 남는다)만 존치 요구.
- **실제**: 전부 이행됐고, **제거의 영속성을 가드 테스트가 지키고 있다**.
  - `internal/shared/runtime/skills_contract_test.go:310` — `--agent`·`/api/agent/` 부재 검사
  - `internal/shared/settingsschema/schema_test.go:22` — `agentApprovalMode` 가 빠진 사실을
    서술자 개수 계약(29개)의 주석으로 못박음 (`FR-AGR-4` 인용)
  - `internal/webserver/httpapi/handlers_attention.go:166` ·
    `handlers_runs_context.go:150` — `FR-AGR-9`(세션 신원 저장소 없음)를 "필드를 남기되 쓰지
    않는다" 로 인용
  - `internal/shared/agentadapter/` — 존재. `FR-AGR-12` 충족
  - 커밋 `dff008ff refactor: 에이전트 GUI 를 걷고 어댑터만 남긴다 (AGENT_GUI_REMOVAL_SRS)` 가
    `docs/external/commands.md` 까지 함께 고쳤다
- **차이**: 상태 라벨 오류. `CONTRIBUTING` 3-1 ②("구현을 끝낸 커밋이 그 SRS 의 상태를 함께 고친다")
  가 지켜지지 않았다.
- **제안**: **문서를 고친다** — `승인·구현완료`. 코드 쪽에 할 일 없음.
- **공수**: S

---

### [HIGH] H3 — EDITOR_MINIMAP_TOGGLE_SRS: 구현이 끝났는데 `승인·구현중`

- **문서**: `docs/internal/EDITOR_MINIMAP_TOGGLE_SRS.md` (상태: **승인·구현중**)
- **요구 / 실제** (FR 8개 전건 확인):

| FR | 요구 | 실제 |
|---|---|---|
| FR-MMT-1 | `Settings ▸ Display` 에 `#ds-minimap` 체크박스 | `web/js/core/app-settings-init.js:324` |
| FR-MMT-2 | 블롭 키 `editorMinimap`(bool, 기본 `true`) | `web/js/core/settings-schema.js:46` — `{"key":"editorMinimap","type":"bool","def":true,"where":"Display ▸ 편집기 미니맵"}` |
| FR-MMT-3 | 새 편집기에 `minimap.enabled` 로 간다 | `web/js/ui/file-editor.js:435` — `minimap: edMinimapOpts(editorMinimap)` |
| FR-MMT-4 | 열린 편집기도 `updateOptions` 로 즉시 | `web/js/ui/file-editor.js:602-604` `applyMinimap()` · `app-settings-init.js:335-337` `_edApplyMinimap()` |
| FR-MMT-5 | 옵션 덩이는 한 자리 | `web/js/core/constants-editor.js:140` `edMinimapOpts()` — 생성·갱신이 같은 함수를 지난다 |
| FR-MMT-6 | 설정 창을 열 때마다 다시 칠한다 | `web/js/core/app-settings.js:390-391` |
| FR-MMT-7 | 카탈로그 키 `html.minimap`·`html.minimap_hint` | `check-i18n` 게이트 통과(한글 리터럴 0 · ko·en 958키 한 벌) |
| FR-MMT-8 | diff 화면은 따르지 않는다 | `web/js/core/constants-git-diff.js:42` — `minimap:{enabled:false}` 고정 |

- **차이**: 상태 라벨 오류. H2 와 같은 사유.
- **제안**: **문서를 고친다** — `승인·구현완료`.
- **공수**: S

---

### [HIGH] H4 — 사용자 설정 6종이 외부 문서 어디에도 없다 (대조 게이트 부재)

- **문서**: `docs/external/features.md` §표시 설정 (Display) (267~296행) · `README.md` · `getting-started.md`
- **요구**: `CONTRIBUTING` 3-2 — "동작을 바꾸면 그 근거 문서를 같은 변경에서 고친다".
  사용자에게 보이는 설정이 늘면 사용자 문서가 그것을 말해야 한다.
- **실제**: `web/js/core/settings-schema.js` 의 서술자 29개 중 `where` 가 `Display ▸ …` 인
  항목과 `features.md` 표를 대조한 결과, **여섯이 문서 어디에도 없다.**

| 스키마 키 | `where` | `features.md` | `getting-started.md` | `README.md` |
|---|---|---|---|---|
| `editorWordWrap` | Display ▸ 편집기 줄바꿈 | 없음 | 없음 | 없음 |
| `editorMinimap` | Display ▸ 편집기 미니맵 | 없음 | 없음 | 없음 |
| `tabFixedWidth` | Display ▸ 탭 너비 고정 | 없음 | 없음 | 없음 |
| `tabWidthPx` | Display ▸ 탭 너비 | 없음 | 없음 | 없음 |
| `focusEdgeLevel` | Display ▸ 비활성 창 가장자리 | 없음 | 없음 | 없음 |
| `attnEdgeLevel` | Display ▸ 알림 가장자리 | 없음 | 없음 | 없음 |

  검색어 `가장자리`·`탭 너비`·`줄바꿈`·`미니맵` 으로 `docs/external/` 과 `README.md` 전량을
  훑어 0건을 확인했다(`features.md:110` 의 "가장자리" 는 편집기 분할 드롭존으로 무관).
  각 설정의 근거 SRS 는 존재한다 — `WORKBENCH_REVIEW_SRS`(FR-WBR-10·11) ·
  `EDITOR_MINIMAP_TOGGLE_SRS` · `TAB_WIDTH_SRS` · `UNFOCUSED_EDGE_SRS` ·
  `ALERT_MOBILE_CONTEXT_SRS`(FR-AED-8).
- **차이**: 문서 낡음. **근본 원인은 게이트의 구멍이다.** `CONTRIBUTING` 3-4 의 대조 표에는
  `commands.md`·`api.md`·`shortcuts.md`·`getting-started.md` 환경변수 넷만 있고 **설정 표면이
  없다**. 그런데 설정은 `settings-schema.js` 가 기계가 읽는 JSON(`CheckShape()` 가 형태를
  계약으로 강제)이라 **넷 중 어느 것보다도 대조하기 쉽다**.
- **제안**: **둘 다 고친다.**
  1. (문서) `features.md` §Display 표에 여섯 줄을 더한다. `editorMinimap` 은 특히
     `EDITOR_MINIMAP_TOGGLE_SRS` §2.2 의 "이전 동작/새 동작" 을 그대로 옮기면 된다.
  2. (게이트) `scripts/check-settings-docs.sh` 를 세운다 — `settings-schema.js` 의
     `where` 가 `Display ▸ X`·`Terminal ▸ X` 인 키마다 `features.md` 의 해당 절에 `**X**` 행이
     있는지 양방향 검사. `check-env-docs.sh` 가 같은 모양의 선례다.
     `CONTRIBUTING` 3-3 대로 **탐침으로 검출을 확인하고 지운다**.
- **공수**: 문서 S · 게이트 M

---

### [HIGH] H5 — architecture.md 의 `allowedCmdActions` 가 코드보다 하나 적고 이름도 틀렸다

- **문서**: `docs/internal/architecture.md` §커맨드 브로드캐스트 (881행~)
- **요구(문서가 말하는 것)**:
  > `allowedCmdActions` 는 20개를 허용한다: `newWindow`/`newTab`/`splitH`/`splitV`/`focus`/
  > `closeTab`/`closeWindow`/`windowNext`/`windowPrev`/`tabNext`/`tabPrev`/`paneUp`/`paneDown`/
  > `paneLeft`/`paneRight`/`openEditorTab`/`renameTab`/`renameWindow`/`detachTab`/`restoreTool`
- **실제**: `internal/webserver/hub/commands.go:248-270` — **`AllowedCmdActions`**(대문자로
  시작하는 **내보낸** 심볼)이고 항목은 **21개**다. 문서에 없는 것은 `openUrl`(269행).
  검증은 `internal/webserver/httpapi/commands.go:170` 에서 일어난다.
- **차이**: 문서 낡음. 원인을 커밋으로 확정했다 —
  `a06ad769 feat(url): 터미널이 여는 링크가 보고 있는 기기에서 열린다` 가
  `internal/webserver/hub/commands.go` 에 `openUrl` 을 더하면서 **30개 파일을 고쳤지만
  `docs/internal/architecture.md` 는 건드리지 않았다**(`git show --stat` 로 확인).
  `CONTRIBUTING` 3-2 직접 위반이다. 심볼 이름의 대소문자(`allowedCmdActions` vs
  `AllowedCmdActions`)도 처음부터 틀려 있어 문서에서 심볼을 찾으면 0건이 나온다.
- **제안**: **문서를 고친다** — 코드가 맞다. `openUrl` 을 목록에 더하고 "21개", 심볼 이름을
  `AllowedCmdActions` 로 바로잡는다. `VIEWER_URL_OPEN_SRS` 가 근거 문서이므로 그쪽에서
  architecture.md 로 가는 링크를 하나 두면 다음에 같은 누락이 덜 생긴다.
- **공수**: S

---

### [MED] M1 — M10_SRS: 남은 셋까지 닫혔는데 `승인·구현중`

- **문서**: `docs/internal/M10_SRS.md` (상태: **승인·구현중**, 머리글 "§3.2(M9 가 넘긴 둘)는 P2 로 미룬다")
- **요구 / 실제** (FR 10건):

| FR | 요구 | 실제 |
|---|---|---|
| FR-M10-1 | 소유권을 되찾은 창은 자기 폭으로 되잰다 | `web/js/ui/term-pane.js:30`(`_ownCols`) · `863` · `885`(`ptySize`) · `web/js/core/app-focus.js:414` |
| FR-M10-2 | 폭이 바뀌면 전량 재생 | `term-pane.js:832` · `893` · `908`(`_refreshForWidth`) · `e2e/osenv.ts:148` |
| FR-M10-3 | 복원의 흔들기는 관측 가능 | `web/js/ui/renderer.js:252`·`269`(`_nudgeScrollArea`) · `e2e/regression-pane-scroll.spec.ts:306` |
| FR-M10-5 | 동시 워커 수는 한 자리·상한 안 | `playwright.config.ts:126`(`workerCount()`) · `e2e/fixtures.ts:864` 가 `FR-M10-5` 를 인용 |
| FR-M10-6 | `migration` 은 skill 이 아니라 command | `internal/shared/runtime/agentplugin/commands/migration.md` 존재 · `skills_contract_test.go:22`·`183`·`224` 가 `commands/` 트리를 검사 |
| FR-M10-7 | `DOCLANG_LSP` 폐기 | `DOCLANG_LSP_SRS.md` 상태 = `폐기`. 일치 |
| FR-M10-10 | `V-GDT-5`·`V-GDT-6` 검사를 세운다 | `internal/webserver/hub/gitwatch_test.go:40`·`762`·`804` |
| FR-M10-4 · 8 · 9 | 문서 감사 · `openGit` 진단 · 논리 경합 | 문서 §개정 이력(492행)이 "P6 — 남은 셋" 으로 닫았다고 적는다 |
| e2e | `TC-M10-1`·`TC-M10-2` | `e2e/term-reclaim.spec.ts:78`·`112` |

- **차이**: 상태 라벨 오류. 머리글이 "§3.2 는 P2 로 미룬다" 로 남아 있으나 같은 문서의
  개정 이력 492행이 그 셋을 닫았다고 적는다 — **문서 안에서 머리글과 이력이 모순**이다.
- **제안**: **문서를 고친다** — `승인·구현완료` 로 올리고 머리글의 "P2 로 미룬다" 를 이력과
  맞춘다. 판단 근거: M10 은 `M11_SRS` 머리글이 "선행: M10 완료(`b54fb15`)" 라고 이미 적고 있다.
- **공수**: S

---

### [MED] M2 — 색인의 ALERT_MOBILE_CONTEXT 항목이 "③⑩ 미착수" 로 낡았다

- **문서**: `docs/internal/README.md` (색인 행) — *"**구현 중** — ②와 설정 전파(FR-SYN, 추가 접수)
  완료, ③⑩ 미착수"*
  / 대상 문서 `ALERT_MOBILE_CONTEXT_SRS.md` (상태: **승인·구현완료**)
- **요구**: ③ = 모바일 소프트 키보드(`FR-MKB-1~15`) · ⑩ = Run 컨텍스트 표기(`FR-RCX-1~10`)
- **실제**: **둘 다 구현돼 있다.**
  - ③ — `web/js/ui/term-pane.js:197`(FR-MKB-1) · `493`(FR-MKB-2·3, `inputmode` 소유) ·
    `507`(FR-MKB-13) · `521`(FR-MKB-4) · `532`(FR-MKB-5) ·
    `web/js/core/app-mobile.js:168`(FR-MKB-8 맨 왼쪽) · `181`(FR-MKB-9·10 `^C`) ·
    `web/js/core/main.js:115`(FR-MKB-13)
  - ⑩ — `web/js/ui/runs-panel.js:657`·`707`·`720`·`759`·`765`(FR-RCX-9·4·1·2) ·
    `internal/webserver/httpapi/handlers_runs_context.go:174`·`180`(FR-RCX-10·6·7) ·
    `internal/webserver/domain/run/store_context.go:164`·`176`·`191`(FR-RCX-6·8)
- **차이**: 문서 낡음. **상태 필드가 맞고 색인 설명문이 틀렸다.**
- **제안**: **색인을 고친다** — 해당 행 꼬리를 `**구현 완료**` 로. 코드·SRS 본문은 손대지 않는다.
- **공수**: S

---

### [MED] M3 — 색인의 UI_KIT 항목이 "넷 완료" 로 낡았다 (§7 표는 열 전부 완료)

- **문서**: `docs/internal/README.md` (색인 행) — *"**구현 중** — 키트·상단바·사이드바 탭·설정
  모달까지 **넷 완료**(§7 표), git 아이콘 상수의 소비 지점은 §7.1 에 조사돼 있다"*
  / 대상 문서 `UI_KIT_SRS.md` (상태: **승인·구현완료**)
- **요구**: `FR-UIK-30` — "이전이 끝난 표면의 목록을 이 문서 §7 에 적는다"
- **실제**: `UI_KIT_SRS.md` §7 (369행~)의 이전 순서 표 **10행 전부가 `완료`** 다
  (8번 "모바일 키바" 만 근거를 적고 `이전하지 않는다`). 색인이 말하는 "넷" 은 표의 1~4 행에서
  멈춘 시점의 기록이다.
- **차이**: 문서 낡음. 상태 필드가 맞고 색인 설명문이 틀렸다.
- **제안**: **색인을 고친다** — `**구현 완료**` 로. 단 §7.1 의 잔여 하나(M5)는 그대로 남으므로
  그 사실을 한 구로 덧붙이는 편이 낫다.
- **공수**: S

---

### [MED] M4 — docs/external/agent-orchestration.md 가 2026-09-06 에 멈춰 있다

- **문서**: `docs/external/agent-orchestration.md` (최종 변경 `ef02d01b`, **2026-09-06**)
- **요구(문서가 말하는 것)** / **실제(코드)**:

| 문서가 적은 것 | 실제 | 차이 |
|---|---|---|
| §주입 방식 전개도: `agent-plugin/` 아래 `.claude-plugin/plugin.json`·`skills/team, skills/workflow`·`hooks/hooks.json` | 임베드 트리에 **`commands/migration.md`** 가 더 있다 (`internal/shared/runtime/agentplugin/commands/migration.md`) — `install.go:35` 의 `//go:embed all:agentplugin` 이 통째로 담고 `unpackAgentPlugin` 이 그대로 전개한다 | `commands/` **누락** |
| §스킬 표: `team`·`workflow` 둘 | 세션에는 `/dongminal:migration` 도 선다. `M10_SRS` `FR-M10-6` 이 "명령이지 스킬이 아니다" 로 자리를 갈랐고 `skills_contract_test.go:224` 가 `commands/` 에 명령만 있는지 검사한다 | `/dongminal:migration` **누락** |
| §dmctl 명령 표 8행 | `docs/external/commands.md:69-75` 에 **`dmctl run` 계열 7개**(`start`·`member`·`launch`·`report`·`status`/`list`/`close`·`delete`·`graph`)가 있다. `RUN_ORCHESTRATION_SRS`·`ORCHESTRATION_V2_SRS` 가 근거 | 오케스트레이션 문서인데 **Run 오케스트레이션이 전무** |

  전개도의 `hooks/hooks.json` 은 **맞다** — 임베드가 아니라 `install.go:283`·`334`
  (`generatedPluginPaths`)가 설치 시 생성하는 것임을 확인했다. 그 줄은 고치지 않는다.
- **차이**: 문서 낡음.
- **제안**: **문서를 고친다** — 코드가 맞다. ① 전개도에 `commands/migration.md` 한 줄,
  ② 스킬 표 아래에 "명령" 한 줄(`/dongminal:migration`)과 `FR-M10-6` 의 구분 근거,
  ③ `dmctl run` 계열은 `commands.md` 를 가리키는 한 행으로 충분하다(전량 복제하면 또 낡는다).
  `commands.md` 는 게이트가 지키므로 **그쪽을 진실로 삼고 이쪽은 링크**하는 것이 이 저장소의
  3-4 규약과 맞는다.
- **공수**: S

---

### [MED] M5 — FR-GLY-4 미흡: `★` 가 아직 문자다 (그리고 이를 재는 게이트가 없다)

- **문서**: `docs/internal/UI_KIT_SRS.md` (상태: 승인·구현완료)
  - `FR-GLY-4`(227행) — *"§2.6 의 문자 아이콘을 **전부** 교체한다 … `★`→`star` …"*
  - §7.1(398행~) — 여섯 상수의 소비 지점을 **줄 번호까지 조사해 표로** 남겼다
    (`GIT_BR_FAV_MARK` → `branches.js:278`)
- **요구**: 여섯 상수 전부를 아이콘 이름으로 바꾸고 소비 지점에서 `UIKit.icon()` 을 붙인다.
- **실제**: **여섯 중 넷은 끝났고 `★` 는 남았다.**

| 상수 | 현재 값 | 소비 |
|---|---|---|
| `GIT_REFRESH_LABEL` | `'refresh-cw'` ✅ | `renderer.js:919` `UIKit.icon(...)` |
| `GIT_FILES_MODE_ICON` | `{tree:'folder',flat:'list'}` ✅ | `panel-changes.js:283` `UIKit.icon(...)` |
| `GIT_REMOTE_ICON` | `{fetch:'download',pull:'arrow-down',push:'arrow-up'}` ✅ | `panel-changes.js:122` `UIKit.icon(...)` |
| `GIT_ACT_LABEL` | `{ours:'Ours',theirs:'Theirs'}` ✅ | 나머지는 아이콘으로 이전됨 (`constants-git-changes.js:176` 주석이 경위를 적는다) |
| **`GIT_BR_FAV_MARK`** | **`'★'`** ❌ | `web/js/git/branches-tree.js:184` — `f.textContent=GIT_BR_FAV_MARK` |
| `GIT_BR_CURRENT_MARK` | `'✓'` | `branches-tree.js:195`. **`FR-GLY-8` 예외에 해당**(상태를 나르는 문자) — 결함 아님 |

  `★` 를 붙이는 `<span class="git-br-fav">` 는 `click` 리스너와 `title` 을 가진 **조작 요소**다
  (`branches-tree.js:186-187`). 즉 `FR-GLY-8`("상태·의미를 나르는 문자") 예외가 아니라
  `FR-GLY-4` 가 명시적으로 `star` 로 사상한 **아이콘 버튼**이다.
- **차이**: 구현 미흡 (1건). 더 중요한 것은 **이것을 잡을 게이트가 없다**는 사실이다 —
  `UI_KIT_SRS` §5 가 완화책으로 "문자 인벤토리 스크립트" 를 적었으나 `scripts/` 에 없다
  (`check-hardcoded-color`·`check-font-size`·`check-z-index` 같은 형제 게이트는 다 있다).
- **제안**: **코드를 고친다.** `GIT_BR_FAV_MARK='star'` + `branches-tree.js:184` 를
  `f.appendChild(UIKit.icon(GIT_BR_FAV_MARK))` 로. `.git-br-fav.on` 의 CSS 가 색을
  `textContent` 전제로 잡고 있으면 함께 본다. 덧붙여 `scripts/check-glyph.mjs` 를 세워
  `FR-GLY-4` 사상표의 문자가 `web/js/**` 의 `textContent`/`innerHTML` 우변에 오면 잡게 한다
  (`ours`/`theirs`·키바 열셋·`×`(곱셈기호, `doc-render.js:467`·`file-editor.js:345`)·
  `EDITOR_TREE_LINK`(아래)는 근거와 함께 예외 등록).
- **공수**: 코드 S · 게이트 M

---

### [MED] M6 — CHANGELOG 에 FR·SRS 추적이 0건이다

- **문서**: `CHANGELOG.md` (118KB)
- **요구**: `CONTRIBUTING` §2 — *"이 저장소는 요구를 SRS 에 적고 번호로 가리킨다. 그 번호가
  커밋에 있으면 '왜 이 줄이 있는가' 에 답할 수 있다."*
- **실제**: `grep -c 'FR-' CHANGELOG.md` → **0**. `_SRS` 패턴은 **전체에서 1건**.
  즉 릴리스 노트에서 SRS 로 거슬러 올라갈 길이 사실상 없다. (릴리스 노트는 이 절을
  그대로 가져간다 — `CONTRIBUTING` §6-1.)
- **차이**: 규약이 커밋만 요구하고 CHANGELOG 를 말하지 않으므로 **엄밀한 위반은 아니다.**
  그러나 "고아 SRS 를 찾으라" 는 이 감사의 과제가 성립하지 않은 이유가 이것이다 —
  CHANGELOG 를 추적 근거로 쓸 수 없어 167건 중 165건이 "CHANGELOG 에 없음" 으로 나왔다.
- **제안**: **문서 규약을 고친다** — 둘 중 하나를 택한다.
  (a) CHANGELOG 항목 꼬리에 근거 SRS 이름을 괄호로 단다. 커밋 제목이 이미 그 형식이므로
      (`feat(editor): … (EDITOR_REPLACE_AND_SEED_SRS)`) 전사 비용이 낮다.
  (b) 추적은 커밋으로 충분하다고 판단하고 `CONTRIBUTING` 에 그 사실을 명시한다 —
      "CHANGELOG 는 사용자 언어로만 적는다".
  **권장은 (a)** 다. 근거: `docs/internal/README.md` 색인이 이미 문서→요약 방향을 담당하므로,
  반대 방향(판→문서)이 비어 있는 것이 지금의 비대칭이고 이 감사가 거기서 막혔다.
- **공수**: (a) M · (b) S

---

### [MED] M7 — 커밋 60건 중 20건이 FR·SRS 를 어디에도 달지 않았다

- **문서**: `CONTRIBUTING.md` §2 커밋 메시지 — *"**FR 번호를 답니다.**"*
- **실제**: 최근 60커밋을 제목+본문으로 재어 **20건(33%)** 이 `FR-*` 도 `*_SRS` 도 없다.
  제목만 보면 48건(80%)이 없다. 대부분 `docs(changelog)`·`fix(e2e)`·`test(*)` 라 정상 참작
  여지가 있으나, **동작을 바꾼 것들이 섞여 있다**:
  - `95bbdd08 fix(toolhub): 등록보다 먼저 끝나는 프로세스가 죽은 도구를 남긴다`
  - `9bedf7ff test(toolhub): 오인 여부를 직접 잰다 — SetBackground 는 두 사유로 거절한다`
  - `877f861c fix(e2e): 진단 덤프는 스냅샷이다 — 기다리지 말고 다시 찍는다`
- **차이**: 규약 준수 누락. H5 의 `a06ad769` 처럼 **근거 문서 갱신 누락과 같은 뿌리**다 —
  FR 을 달지 않은 변경은 어느 문서를 함께 고쳐야 하는지도 판정되지 않는다.
- **제안**: **게이트를 세운다.** `.githooks/` 가 이미 있으므로 `commit-msg` 훅에서
  `type` 이 `feat`·`fix`·`refactor` 인 커밋에만 `FR-[A-Z]+-[0-9]` 또는 `_SRS` 를 요구한다
  (`docs`·`test`·`chore`·`ci` 는 면제). `CONTRIBUTING` §2 에 그 면제 목록을 명시한다 —
  지금은 규약이 전건을 요구하는데 실무가 33% 를 비우고 있어, 규약과 실무 중 하나가 거짓이다.
- **공수**: M

---

### [LOW] L1 — EDITOR_MINIMAP_TOGGLE V-MMT-1 의 절대 수치가 낡았다

- **문서**: `docs/internal/EDITOR_MINIMAP_TOGGLE_SRS.md` §4 검증 —
  *"V-MMT-1 | Go 단위 | 서술자 표가 `editorMinimap` 을 포함해 **25개**다"*
- **실제**: `internal/shared/settingsschema/schema_test.go:23` — `if len(specs) != 29`.
  `web/js/core/settings-schema.js` 의 `"key"` 도 29개. 그 사이에 `claudeFullscreen` ·
  `uiFontSize` · `termFontSize` · `claudeScrollSpeed` 넷이 더 들어왔고(테스트 주석이 출처를
  전부 적는다) `agentApprovalMode` 하나가 빠졌다.
- **차이**: 문서 낡음. 코드가 맞다.
- **제안**: **문서를 고친다.** 다만 고치는 방식이 중요하다 — 숫자를 25→29 로 바꾸면 다음
  설정이 늘 때 또 낡는다. `"서술자 표가 editorMinimap 을 포함한다 (개수 계약은
  schema_test.go 가 갖는다)"` 처럼 **개수의 소유자를 한 곳으로 옮기는** 편이 낫다.
  같은 형태의 위험이 `FR-SYN-6`(L2)·`architecture.md`(H5)에도 있으므로 규약으로 다루는 편이
  효율적이다: **SRS 의 검증 표에 절대 수치를 쓰지 않는다.**
- **공수**: S

---

### [LOW] L2 — FR-SYN-6 의 설정 키 열거가 낡았다

- **문서**: `docs/internal/ALERT_MOBILE_CONTEXT_SRS.md:238` `FR-SYN-6` —
  *"얹는 대상은 지금 `saveSettings` 가 보내는 키 전부다 — 테마·단축키·상태바·주기·프리셋·
  기본 프리셋·제목·브라우저 키 차단·떠날 때 확인·줄바꿈·탭 너비·프로세스 이름·가장자리 세기.
  **새 설정이 늘면 이 함수 한 곳만 고친다.**"*
- **실제**: 그 뒤로 `editorMinimap`·`uiFontSize`·`termFontSize`·`claudeFullscreen`·
  `claudeScrollSpeed`·`locale`·`themeFollowSystem`·`themeNameDark`·`themeNameLight` 가 늘었다.
  전파 자체는 정상이다 — `_settingsApply` 한 자리를 지나며(`app-settings.js:256`,
  `constants.js:134`, `e2e/poll-interval.spec.ts:134` 가 `FR-SYN` 을 인용) 요구의 **본체는
  충족**된다.
- **차이**: 문서 낡음 (열거가 예시로 읽히므로 영향 작음).
- **제안**: **문서를 고친다** — 열거를 지우고 *"`saveSettings` 가 보내는 키 전부"* 만 남긴다.
  요구가 이미 "한 곳만 고친다" 라고 말하고 있으므로 열거는 그 요구와 모순이다.
- **공수**: S

---

### [LOW] L3 — `EDITOR_TREE_LINK='↗'` 가 문자로 남아 있다 (판정이 갈린다)

- **문서**: `UI_KIT_SRS.md` `FR-GLY-4`(`↗`→`external-link`) vs `FR-GLY-8`(상태를 나르는
  문자는 그대로)
- **실제**: `web/js/core/constants-editor.js:355` — `const EDITOR_TREE_LINK='↗'`.
  주석이 `FR-EDT-60` 을 인용하며 *"표시가 그 사실과 대상 종류를 알린다"* 라고 적는다 —
  심볼릭 링크임을 나타내는 **상태 표식**이다.
- **차이**: `FR-GLY-8` 의 예외로 볼 여지가 크다. 다만 `FR-GLY-8` 의 예시 목록
  (git 상태 문자 · lane 그래프 · diff `+`/`-` · 키바 문자 키)에 **이것이 없어** 판정이 문서로
  결정되지 않는다.
- **제안**: **문서를 고친다** — `FR-GLY-8` 의 예시에 "편집기 트리의 링크 표식" 을 더해
  판정을 못박는다. M5 의 게이트를 세울 때 예외 등록부가 필요하므로 그때 함께 처리한다.
- **공수**: S

---

### [LOW] L4 — 상태 enum 이 "일부 폐기" 를 표현하지 못한다

- **문서**: `docs/internal/FILE_API_BOUNDARY_SRS.md` (상태: `승인·구현완료`)
- **실제**: 같은 문서 머리에 *"⚠ 경계 조항은 **폐기됐다**(2026-09-20, 사용자 결정) —
  묶음 B·W·G·O 는 더 이상 효력이 없다. 살아 있는 조항은 §3.3 묶음 S(크기 상한)뿐"* 이 있다.
  즉 요구 17개 중 넷 묶음이 죽고 하나가 산다. 상태는 `승인·구현완료` 다.
- **차이**: 라벨 자체는 틀리지 않았다(살아 있는 조항은 구현돼 있다). 머리의 경고 블록이
  `check-srs-status.sh` 보다 훨씬 많은 것을 말하고 있고, 그 블록이 **폐기가 빠뜨린 자리까지
  자백한다**(`dongminal verify` 의 경계 검사가 커밋 `b38bda77` 로 걷혔다) — 문서 품질은 높다.
- **제안**: **지금은 고치지 않는다.** enum 에 값을 늘리면(`부분폐기` 등) `check-srs-status.sh`
  와 모든 문서가 따라 움직여야 하고, 얻는 것이 경고 블록 하나보다 크지 않다.
  다만 `M11`/`M12`(H1)를 `대체` 로 내릴 때 **같은 판단 기준**을 `CONTRIBUTING` 3-1 에 한 줄로
  적어 두면 다음 사람이 되묻지 않는다: *"문서의 본체가 죽으면 `대체`·`폐기`, 일부가 죽으면
  상태는 그대로 두고 머리에 개정 블록을 둔다."*
- **공수**: S

---

## 4. 찾지 못한 것 (반증)

| 과제 | 결과 | 근거 |
|---|---|---|
| **미구현** — `승인·구현완료` 인데 코드 없음 | **0건** | 차집합 상위 24개 문서를 개별 확인. `SPLIT_REFACTOR`(17/17 미인용)·`README_REWRITE`(14/16)·`PACKAGE_RESTRUCTURE`(27/47)·`APP_STATE_EXTRACT`(5/6)·`ATTN_UTIL_RELOCATE`(6/8)·`FG_RESTORE_RACE`(4/5)·`ICON_ASSETS`(5/7)·`WINDOW_COMMAND`(7/12)·`POPUP_DEFAULT_ACTION`(7/16)·`ACCESSIBILITY_BASELINE`(15/29) 전부 **구현 확인**. §2.2 참조 |
| **잘못 구현** | **0건** | 확인한 범위에서 코드 동작이 FR 과 어긋난 자리 없음 |
| **고아 문서** | **0건** | 색인 167/167. `DOCLANG_LSP_SRS`(폐기)는 `M10_SRS` `FR-M10-7`·`D-M10-9` 가 폐기 근거와 경위를 남김 — 규약대로 "상태로 말한" 것 |
| **초안 방치** | **0건** | `초안`·`승인대기` 상태 0건 |
| **생성물 비동기** | **0건** | `gen-errors`·`gen-decisions` 재생성 후 diff 0줄 |
| **대조 문서 비동기** | **0건** (게이트 넷 범위 내) | `commands.md` 32 · `api.md` 155 · `shortcuts.md` 34 · 환경변수 18 전부 ok. 단 **게이트 밖**에 H4·M4 가 있다 |
| **TODO/FIXME/HACK** | **0건** | 1급 코드 전량. 방치된 빚의 마커가 없다 |

### 저장소 청결

감사 시작·종료 시점 모두 `git status --short` 에 소스 변경 0건.
(감사 중 관측된 미추적 파일 `audit-0*.png` 6개는 **같은 세션의 다른 에이전트**가 남긴
스크린샷이며 이 감사의 산출물이 아니다. 건드리지 않았다.)

---

## 5. 권고 — 세 줄

1. **상태 라벨 5건을 고친다** (H1·H2·H3·M1, 전부 공수 S). `승인·구현중` 5건이 전부 오답이므로
   지금 이 필드는 신호가 아니라 잡음이다.
2. **게이트가 없는 두 표면을 게이트 안으로 들인다** — 설정 표면(H4)과 문자 아이콘(M5).
   이 저장소의 실측된 사실은 명확하다: **기계가 재는 문서는 하나도 낡지 않았고, 손으로 적는
   문서만 낡았다.**
3. **추적의 반대 방향을 잇는다** (M6·M7). 문서→코드는 FR 3,237개로 촘촘한데 판→문서가 비어 있고,
   그 비대칭이 H5 같은 누락을 조용하게 만든다.
