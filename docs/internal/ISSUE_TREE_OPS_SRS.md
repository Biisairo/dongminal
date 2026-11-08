# SRS: issue-tree 운영 — 배정·승계·트리 구조·맥락 migration·표시줄 탭 이름·편집기 단축키 — IEEE 29148

> **문서 상태**: 승인·구현완료
> **확인**: 사용자가 설치를 갱신하고 진행 중이던 트리를 재가동해 확인했다(2026-11-07). 맥락 훅의 additionalContext 전달과 `dmctl status` 의 사용량 줄은 실측했다.
> **남은 것(막지 않음)**: 맥락 훅의 지연 측정(NFR-ITO-1) · mac 의 편집기 키 실측(e2e 브라우저는 Win32 였다) · git diff 보기의 키 차단(§3.6a 범위 밖) · 긴 brief 에서 트리 프리앰블 길이(R-1)
> **입력**: `docs/internal/ISSUE_TREE_OPS_FINDINGS.md`(요구 입력 1~14번, 사용자 결정 넷). 이 SRS 가 그 문서를 대신한다.
> **개정 대상**: `ISSUE_AGENT_TREE_SRS.md` 의 FR-IAT-50~54·60~64·73, FR-ITD-2·6, D-IAT-19 (§8 변경 기록)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`/dongminal:issue-tree` 를 실제 트리(`hancomins/common-chart-renderer-ts#32`)에 돌려 보니 운영 문제가 여럿 드러났다(입력 1~8번). 사용자는 그 뒤 요구 여섯을 더했다(9~14번). 별건으로 맥락 기준 migration 의 설정과 훅, 표시줄의 탭 이름도 요청했다. 이 SRS 는 이 요구들을 묶음으로 나누어 정한다.

### 1.2 범위 (Scope)

| 묶음 | 이름 | 접두어 | 입력 | 산출물 |
|---|---|---|---|---|
| **A** | 배정과 트리 프리앰블 | `FR-ITA-` | 3·4·6·12·13·14 | `run member` 의 배정 필드 · 트리 멤버 프리앰블 · `issue-tree.md` 개정 |
| **B** | 노드 승계 | `FR-ITB-` | 1·7·13 | 자기 승계(`run succeed --self`) · 부모·자식 알림 · `migration.md` 의 Run 멤버 갈래 |
| **C** | 트리 구조와 상태 | `FR-ITC-` | 2·5·8 | 멤버의 부모 데이터 · `waiting-children` 상태 · 끝난 노드의 흔적 · 트리 모양 대시보드 |
| **M** | 맥락 기준 migration | `FR-ITM-` | 별건 요구 1~5 | 설정 넷 · 맥락 훅 · 잎 노드의 안전 지점 |
| **W** | 표시줄 탭 이름 | `FR-ITW-` | 별건 요구 | `_rWinTitle` 에 포커스 탭 이름 |
| **E** | 편집기 단축키 | `FR-ITE-` | 10 | VS Code 기본 단축키와 같은 편집 키 |
| **S** | 에이전트 정보 조회 | `FR-ITS-` | 11 | `dmctl status` 글자 출력의 사용량 줄 |
| — | GitHub 이슈 트리 그래프 | — | 9 | 조사 결과만 (§2.9). 구현하지 않는다 (D-ITO-9) |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

`ISSUE_AGENT_TREE_SRS` §1.3 의 용어(노드·잎·중간 노드·사슬 이름·안전 지점·발사대)를 따른다. 이 SRS 고유 용어만 적는다.

| 용어 | 정의 |
|---|---|
| **배정** | 노드 하나가 일하는 데 필요한 값의 묶음. 이슈 · 제목 · 사슬 이름 · 목표 경로 · 부모 멤버 · 그룹 · 병렬 가지 여부 · 맥락 기준 · 커밋 허용 (FR-ITA-1) |
| **트리 멤버** | 배정을 가진 Run 멤버. 트리 표지가 있는 Run 의 멤버이고 이슈를 가진다 |
| **부모 멤버** | 트리 멤버의 배정에 적힌 부모 노드의 member id. 루트 노드는 부모 멤버가 없다 |
| **자기 승계** | 승계당하는 멤버의 세션이 스스로 부르는 승계. 인수인계 요약을 직접 싣고 기다리지 않는다 (FR-ITB-1) |
| **맥락 훅** | 일반 세션의 맥락 사용률을 보고 migration 을 제안하는 에이전트 훅 (FR-ITM-10) |
| **결정 코멘트** | 노드가 사용자에게 받은 결정을 GitHub 이슈에 남긴 코멘트 (FR-ITA-31) |

### 1.4 참고 (References)

- `ISSUE_TREE_OPS_FINDINGS.md` — 요구 입력과 사용자 결정 원문
- `ISSUE_AGENT_TREE_SRS.md` — 이슈 트리 명령 · statusLine 프록시(FR-SLP-*) · 트리 대시보드(FR-ITD-*) · 중복 방지(FR-ITU-*)
- `RUN_ORCHESTRATION_SRS.md` · `ORCHESTRATION_V2_SRS.md` — Run · 멤버 · 프리앰블(FR-PRE-*) · 승계(FR-CBG-9~12)
- `CONFIG_MANAGEMENT_SRS.md` FR-CFG-2 — `SETTINGS_SCHEMA` 가 설정의 원본
- `SLOT_MARKER_SRS.md` · FR-STB-11·12 — 칸이 여럿일 때의 표시줄
- `EDITOR_GIT_UX_SRS.md` FR-EKB-* · `CODEMIRROR_MIGRATION_SRS.md` — 편집기 키
- 외부: GitHub sub-issues REST(`/issues/{n}/sub_issues`·`/parent`), GraphQL `reprioritizeSubIssue`, Projects hierarchy view(2026-03 GA)

### 1.5 개요 (Overview)

§2 는 지금의 사실, §3 은 요구, §4 는 결정, §5 는 검증, §6 은 비목표, §7 은 위험, §8 은 변경 기록이다.

## 2. 현황 (Identified Issue)

### 2.1 배정이 brief 뒤에 따로 온다 (입력 3·7)

- `run launch` 의 기동줄은 프리앰블을 싣는다. 프리앰블은 멤버의 `brief` 를 `[작업]` 으로 넣는다(`internal/webserver/domain/run/preamble.go:42-46`). 배정(그룹·Run·맥락 기준·부모·커밋 허용)은 기동 **뒤에** 엔벨로프로 따로 온다(`issue-tree.md` 「배정」).
- 그래서 에이전트는 brief 만 보고 일을 시작한다. 루트 노드는 배정 전에 하위를 띄워 `맥락 기준: 없음` 을 아래로 넘겼다.
- 배정은 Run 기록에 없다. migration 이 배정을 새 세션에 넘기려면 세션의 기억에 기대야 한다.

### 2.2 프리앰블이 issue-tree 절차와 부딪친다 (입력 4)

`preamble.go` 의 규약과 `issue-tree.md` 가 다르게 지시한다.

| 프리앰블 | issue-tree |
|---|---|
| 질문은 조정자(`rec.CoordinatorToolID` = 발사대)에게 (`:69-74`) | 질문은 부모에게. 발사대는 트리를 세운 뒤 빠진다 |
| AskUserQuestion 을 열지 마라 (`:69-70`) | 내 탭에서 사용자에게 묻는다 |
| 탭을 스스로 닫지 마라 (`:85-86`) | 잎은 완료 뒤 자기 탭을 닫는다 · migration 은 자기 탭을 닫는다 |
| `run report` 를 정확히 한 번 | migration 뒤 report 의 주인을 말하지 않는다 |

### 2.3 승계 장치는 있으나 쓰이지 않는다 (입력 1)

- `dmctl run succeed --member <uuid> --at <탭>` 이 있다(FR-CBG-9, `store_context.go:369`). 새 멤버가 역할·brief·worktree 를 물려받고, 옛 멤버는 `succeeded` 가 된다. `succeeded` 는 `settled` 라서 `node_taken` 판정(`store_write.go:166-175`)에서 빠진다.
- `migration.md` 와 `issue-tree.md` 는 이 명령을 부르지 않는다. 그래서 옛 멤버가 `lost` 로 남고, 새 세션의 `run member` 는 `node_taken` 으로 거절된다.
- `run succeed` 는 옛 멤버의 도구에 인수인계를 청하고 요약이 올 때까지 기다린다(`handlers_runs_context.go:396-436`). 옛 세션이 스스로 부르면, 청하는 메시지가 Bash 를 실행 중인 자기에게 간다. 그래서 시한까지 기다리게 된다.

### 2.4 트리 구조가 문자열에만 있다 (입력 8)

- 부모·자식 관계는 역할 이름(사슬 이름)을 잘라서 얻는다(`handlers_runs_tree.go:50-59` `treeParent`). Run 기록에는 부모가 없다(D-IAT-19).
- 트리 응답은 끝난 멤버(`done`·`failed`·`released`·`succeeded`)를 뺀다(`:88-92`). 그래서 진행 순서가 보이지 않는다.
- Run 화면의 중심(그래프 SVG · 카드 · 타임라인, `runs-panel.js:351-369`)은 멤버를 평평하게 그린다. 깊이는 위쪽의 「이슈 트리」 영역(`run-tree.js`, 41줄)에서만 보인다.

### 2.5 상태가 경로마다 다르다 (입력 5)

- `dmctl status` 의 `state` 는 훅 상태를 그대로 낸다(`handlers_status.go:92-107`). 값은 working·waiting·done·idle 이다. `done` 은 Stop 훅, 곧 **한 턴의 끝**이다.
- `run status`·`run tree` 의 멤버 상태는 `deriveMemberState`(`handlers_runs.go:61-78`)가 만든다. 이 함수는 훅의 idle 과 done 을 모두 `ready` 로 바꾼다. 기록의 `done` 은 `run report` 다.
- 그래서 하위를 띄우고 쉬는 중간 노드가 `done`(status) · `ready`(run tree) · 다음 턴의 `working` 으로 갈린다. "하위를 기다린다" 는 상태는 어디에도 없다.

### 2.6 맥락 기준 migration (별건 요구)

- 맥락 기준은 `issue-tree.md` 의 `--ctx`(기본 60)뿐이다. 설정에 자리가 없다. 중간 노드의 안전 지점만 이 값을 본다.
- claude 훅은 9개 이벤트에 걸려 있고 모두 `dmctl activity claude` 를 부른다(`agentadapter/claude_install.go:27-37`). 이 명령은 stdout 에 아무것도 내지 않는다. additionalContext 를 내는 훅은 SessionStart 의 `dmctl agent-context` 하나다.
- 맥락 사용률은 statusLine 프록시가 서버 메모리에 올린다(`handlers_usage.go:95-163`). 훅은 `DONGMINAL_TOOL_ID` 로 자기 도구를 지목할 수 있다.
- `SETTINGS_SCHEMA`(`web/js/core/settings-schema.js`)에는 `orchestration.*` 항목이 없다. 키는 평평한 camelCase 다. 서버의 `orchestration.contextWarnRatio` 는 스키마 밖의 중첩 값이다. 브라우저는 스키마 키만 저장하므로, 손으로 넣은 중첩 값은 설정을 한 번 저장하면 사라진다.

### 2.7 표시줄에 탭 이름이 없다 (별건 요구)

- `_rWinTitle(w)`(`renderer-chrome.js:88-95`)는 `<창 종류> · <window 이름>` 을 만든다. 최상단 표시줄(`_rTopbar`, `:112-118`)과 칸 머리글(`renderer-layout.js:70-73`)이 이 함수를 같이 쓴다.
- 다시 칠하는 경로는 `render()` 하나다. 탭 전환과 이름 바꾸기는 `render()` 를 부른다. pane 포커스 이동(`setFocus`, `app-focus.js:154-172`)과 전경 프로세스 이름 갱신(`_fgRepaint`, `app-ws-sync.js:258-267`)은 부르지 않는다.
- 머리글과 `#window-name` 에는 `title` 이 없다. 탭에는 늘 붙는다(FR-TBW-6).

### 2.8 편집기 단축키 (입력 10)

- 사용자 보고: "기존 모나코 단축키들중 안먹히는게 많다."
- CodeMirror 키맵은 closeBrackets·default·history·fold·completion·indentWithTab 이다(`cm-setup.js:132-135`). `@codemirror/search` 키맵은 넣지 않았다(`constants-editor.js:81`). 그래서 `Mod-d`(다음 같은 단어 선택)·`Mod-Shift-l`·줄 이동(go to line) 같은 키가 없다.
- 앱 단축키가 capture 단계에서 먼저 잡는 키는 편집기에 닿지 않는다(`input-binding.js:165·226`). 예: Win/Linux 의 `Ctrl+Shift+←/→`.

### 2.9 GitHub 이슈 트리 그래프 (입력 9 · 조사 결과)

| 경로 | 자격 증명 | 결과 |
|---|---|---|
| GitHub 웹의 이슈 화면 | 공개 저장소는 비로그인 | 한 단계씩만 보인다. 그래프 없음 |
| Projects hierarchy view | 프로젝트 권한 | 표 안에서 8단계까지 들여 쓴 트리다(2026-03-19 GA). 그래프는 아니다 |
| 비인증 REST `/issues/{n}/sub_issues`·`/parent` | 없음 | 공개 저장소만 된다(2026-11-07 실측 200). IP 당 60회/시. `ETag` 조건부 요청의 304 는 한도에서 빠진다 |
| GraphQL `subIssues`·`parent` | 필요 | 비인증은 403 |
| 사용자의 `gh` | 사용자 인증 | 5000회/시. 한두 번의 질의로 트리 전체를 읽는다 |

**결론:** 비공개 저장소는 자격 증명 없이 읽을 수 없다. 사용자는 조사로 끝내기로 했다(D-ITO-9).

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 배정과 트리 프리앰블 (FR-ITA-\*)

#### 3.1.1 배정은 기록이다

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITA-1 | `dmctl run member` 는 트리 Run 의 멤버에게 배정을 받는다: `--issue <owner/repo#N>`(필수) · `--title <제목>` · `--parent <부모 member uuid>` · `--goal <번호 목록>` · `--parallel` · `--ctx <퍼센트>` · `--no-commit`. 사슬 이름은 지금처럼 `--role` 이다. 그룹은 Run 의 window 에서 얻으므로 받지 않는다 | 필수 |
| FR-ITA-2 | 서버는 배정을 멤버 기록의 `assign` 객체에 저장한다. 트리 표지가 없는 Run 의 멤버에 배정을 주면 `invalid_argument` 로 거절한다. 트리 Run 의 멤버에 `--issue` 가 없으면 거절한다 | 필수 |
| FR-ITA-3 | `--parent` 는 같은 트리의 열린 Run 에 있는 멤버여야 한다. 없으면 `invalid_argument` 다. 루트 노드는 `--parent` 를 주지 않는다 | 필수 |
| FR-ITA-4 | 배정은 승계로 그대로 물려받는다(FR-CBG-9 의 역할·brief 와 같다). 맥락 기준 정정처럼 배정이 바뀌면 `dmctl run assign --member <uuid> [필드…]` 로 고친다. 고칠 수 있는 것은 그 멤버의 세션 자신 또는 부모 멤버의 세션이다 | 필수 |

#### 3.1.2 트리 멤버의 프리앰블

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITA-10 | 트리 멤버의 프리앰블은 일반 프리앰블 대신 **트리 프리앰블**이다. 일반 Run 멤버의 프리앰블은 바꾸지 않는다 | 필수 |
| FR-ITA-11 | 트리 프리앰블은 배정 전체를 `[ISSUE-TREE 배정]` 블록으로 싣는다: 노드(이슈·제목) · 사슬 이름 · 목표 경로 · 부모(toolId) · 그룹 uuid · Run · member · 병렬 가지 · 맥락 기준(실효값, FR-ITM-3) · 커밋. 기동줄에 배정이 들어가므로 따로 보내는 배정 엔벨로프는 없다 | 필수 |
| FR-ITA-12 | 부모 toolId 는 **프리앰블을 만드는 순간** 부모 멤버의 지금 도구다. 부모가 승계됐으면 승계자의 도구다. 루트 노드는 `부모: 없음 — 사용자에게 직접 말한다` 다 | 필수 |
| FR-ITA-13 | 트리 프리앰블은 절차 문서의 **절대 경로**를 싣는다. 경로는 설치된 플러그인의 `commands/issue-tree.md` 다(`$DONGMINAL_HOME/bin/agent-plugin/commands/issue-tree.md`) | 필수 |
| FR-ITA-14 | 트리 프리앰블은 「조정자」 라는 말을 쓰지 않는다. 보고·완료·실패는 부모에게, 루트는 자기 탭의 사용자에게 한다 | 필수 |
| FR-ITA-15 | 트리 프리앰블은 사용자에게 묻는 것을 막지 않는다. 판단이 필요한 질문은 자기 탭에서 사용자에게 묻는다(AskUserQuestion 을 써도 된다, FR-ITA-30) | 필수 |
| FR-ITA-16 | 트리 프리앰블은 「자기 탭을 닫지 마라. 탭은 부모가 닫는다」 를 적는다. 예외는 자기 승계를 마친 뒤의 옛 세션이다(FR-ITB-5) | 필수 |
| FR-ITA-17 | 트리 프리앰블은 report 의 주인을 적는다: 「지금 이 member 가 보고한다. 승계로 들어왔으면 이 member id 로 보고한다」 | 필수 |
| FR-ITA-18 | 트리 프리앰블은 이슈 운영 동작을 모두 적는다: ① 착수할 때 이슈를 프로젝트 보드의 진행 중으로 옮긴다 ② 필요할 때 이슈에 코멘트를 남긴다(진행 메모·결정, FR-ITA-31) ③ 하위 이슈가 필요하면 만든다 ④ 끝나면 이슈를 닫고 보드의 완료로 옮긴다. 규약(보드·필드·이름)은 프로젝트 지시 문서를 따르고, 규약이 없으면 GitHub 기본 동작만 한다(FR-IAT-55) | 필수 |
| FR-ITA-19 | 트리 프리앰블의 `[작업]` 에는 brief 가 그대로 들어간다. 배정 블록이 brief 보다 **앞에** 온다 | 필수 |

#### 3.1.3 질문과 결정 (입력 12)

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITA-30 | 판단이 필요한 질문이 생기면 노드는 먼저 기존 결정을 찾는다: 프로젝트 문서 · 자기 이슈와 부모 이슈의 코멘트. 답이 있으면 그것을 따른다. 없으면 부모를 거치지 않고 **자기 탭에서** 사용자에게 묻는다 | 필수 |
| FR-ITA-31 | 받은 결정은 GitHub 이슈 코멘트로 남긴다(결정 코멘트). 결정이 자기 이슈에만 걸리면 자기 이슈에, 형제 이슈에도 걸리면 부모 이슈에 남긴다. 첫 줄은 `결정:` 이다. dongminal 은 결정을 저장하지 않는다 | 필수 |
| FR-ITA-32 | 사실 질문(코드·문서로 답이 나오는 것)은 노드가 스스로 찾는다. 부모에게 `질문` 을 보내는 것은 부모 범위의 사실(형제 이슈의 상태·결과 등)이 필요할 때뿐이다 | 필수 |
| FR-ITA-33 | 부모는 하위 하나가 끝나면(안전 지점) 그 하위 이슈의 결정 코멘트를 읽는다. 자기 범위의 다른 이슈·앞선 결정과 충돌하면 사용자에게 묻는다. 공유 문서로 옮길지는 프로젝트 규약을 따르고, 규약이 없으면 옮기지 않는다 | 필수 |
| FR-ITA-34 | 이슈 본문과 하위 이슈 목록·순서는 그 이슈를 맡은 노드만 고친다. 하위 노드는 부모 이슈에 코멘트만 남긴다 — 병렬 형제가 같은 본문을 동시에 고치지 않게 한다 | 필수 |

#### 3.1.4 형제 이동과 끼어든 이슈 (입력 2·13)

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITA-40 | 잎 노드는 다른 이슈로 스스로 옮겨 가지 않는다. 자기 이슈를 끝내면 부모에게 `완료` 를 보내고 멈춘다. 다음 형제의 노드는 부모가 연다 | 필수 |
| FR-ITA-41 | 부모는 `완료` 를 받으면 그 하위의 탭을 닫는다(`close-tab --force`). 병렬 가지의 마지막 노드이면 window 를 닫는다. 그 뒤 다음 하위를 연다 | 필수 |
| FR-ITA-42 | 잎이 먼저 해야 할 이슈를 찾으면: ① 그 이슈를 부모의 하위로 만들고 자기 이슈보다 **앞** 순서에 놓는다(`reprioritizeSubIssue`) ② 하던 변경을 WIP 커밋으로 남긴다(`wip(#<자기 번호>): <한 줄>`, `--no-commit` 이면 `git stash push -m "issue-tree #<번호>"`) ③ 자기 이슈에 진행 메모를 코멘트로 남긴다 ④ 부모에게 `보고: 선행 #<번호>` 를 보내고 멈춘다 | 필수 |
| FR-ITA-43 | 부모는 `보고: 선행` 을 받으면 그 잎의 탭을 닫고 선행 이슈의 노드를 연다. 선행 이슈가 닫히면 원래 이슈의 노드를 다시 연다. 다시 열린 노드는 WIP 커밋과 진행 메모에서 이어 간다 | 필수 |
| FR-ITA-44 | 노드가 맡은 이슈를 바꾸는 명령은 두지 않는다. 한 노드는 한 이슈다 | 필수 |
| FR-ITA-45 | 부모는 하위 이슈를 더하거나 순서를 바꾸면 서브이슈 순서를 진행 순서에 맞게 다시 놓는다(`reprioritizeSubIssue`). 이미 닫힌 하위는 닫힌 순서대로 앞에 둔다 | 필수 |

#### 3.1.5 발사대

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITA-50 | 발사대는 루트 노드를 `run member --issue … --goal …` 로 등록하고 `run launch` 로 띄운다. 배정 엔벨로프를 보내지 않는다. 띄운 뒤 `state=working` 을 확인하고 빠진다 | 필수 |
| FR-ITA-51 | `issue-tree.md` 의 「스펙」 줄은 dongminal 저장소의 SRS 를 대상 저장소에서 읽으라고 하지 않는다. 노드가 따를 것은 이 문서뿐이라고 적는다 | 필수 |

### 3.2 묶음 B — 노드 승계 (FR-ITB-\*)

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITB-1 | `dmctl run succeed --self --at <새 탭 uuid> --summary <본문>\|-` 는 **자기 승계**다. 발신 도구가 그 멤버여야 한다. 서버는 인수인계를 청하지 않고 기다리지도 않는다. 받은 요약을 옛 멤버의 `handoffSummary` 로 적고 승계한다 | 필수 |
| FR-ITB-2 | 자기 승계도 기존 승계와 같은 결과를 낸다: 새 멤버가 역할·brief·worktree·배정을 물려받고, 옛 멤버는 `succeeded` 가 된다. 새 멤버의 프리앰블에 인수인계 절이 붙는다(FR-CBG-9) | 필수 |
| FR-ITB-3 | 트리 멤버가 승계되면(자기 승계든 아니든) 서버가 부모 멤버의 도구와 **자식 멤버들**(배정의 부모가 옛 멤버인 열린 멤버)의 도구에 알린다. 알림은 서버 발신 엔벨로프이고 본문은 `[ISSUE-TREE 승계] <사슬 이름> 새 toolId=<…> member=<…>` 다. 자식의 배정 부모는 새 멤버로 바꾼다 | 필수 |
| FR-ITB-4 | `node_taken` 은 지금처럼 `lost` 멤버도 맡은 것으로 본다. 거절 응답에 그 멤버의 id 와 상태를 싣고, 상태가 `lost` 면 `dmctl run succeed --member <id> --at <탭>` 으로 이어받으라는 안내를 싣는다 | 필수 |
| FR-ITB-5 | `migration.md` 는 넘기는 세션이 Run 멤버인지 먼저 본다(`dmctl who-am-i --json` 의 `member`). 멤버이면 일반 절차 대신 **멤버 갈래**를 따른다: 새 탭 → `run succeed --self`(요약에 인계 문서 경로를 적는다 — 프리앰블의 인수인계 절로 간다) → `run launch --member <새 member>` 로 기동 → 준비 확인 → `working` 확인 → 자기 탭 닫기. 「문서를 읽어라」 엔벨로프는 보내지 않는다. 새 탭의 이름은 넘기는 탭과 같다 | 필수 |
| FR-ITB-6 | `dmctl who-am-i --json` 은 그 도구가 열린 Run 의 멤버이면 `member: {id, runId, role, tree?}` 를 싣는다. 글자 출력에는 `member=<id>` 를 더한다 | 필수 |
| FR-ITB-7 | migration 은 **같은 이슈**를 이어 갈 때만 쓴다. `migration.md` 와 `issue-tree.md` 에 「다른 이슈로 넘어가는 수단이 아니다」 를 적는다(입력 13) | 필수 |

### 3.3 묶음 C — 트리 구조와 상태 (FR-ITC-\*)

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITC-1 | 트리의 부모·자식은 배정의 부모 멤버(FR-ITA-1)에서 얻는다. 배정 부모가 없는 노드(루트·옛 기록)는 지금처럼 사슬 이름에서 얻는다(FR-ITD-2) | 필수 |
| FR-ITC-2 | 승계 사슬은 한 노드다. 트리 응답은 승계 사슬의 **마지막** 멤버를 그 노드로 낸다. 부모가 승계됐으면 자식은 승계자 아래에 선다 | 필수 |
| FR-ITC-3 | `GET /api/runs/tree` 는 끝난 노드(`done`·`failed`·`released`)도 낸다. 노드마다 `issue` · `title` · `state` · `context` · `endedAt`(보고 시각) 을 싣는다. 노드는 깊이 우선으로 내고, 같은 부모의 자식은 노드가 선 순서(승계 사슬 첫 멤버의 등록 시각)로 낸다. `leaf` 는 열린 자식이 없는 열린 노드다 | 필수 |
| FR-ITC-4 | 트리 멤버의 상태에 `waiting-children` 을 더한다. 훅 상태가 working·waiting 이 아니고, 열린 자식 멤버(끝나지 않은 배정 자식)가 하나 이상이면 `waiting-children` 이다. `run status` · `run peers` · `run graph` · `run tree` 가 같은 함수로 낸다 | 필수 |
| FR-ITC-5 | `dmctl status` 의 대상이 Run 멤버이면 응답에 `member: {id, state}` 를 더한다. `state` 는 FR-ITC-4 와 같은 값이다. 글자 출력에는 `run_state=<값>` 을 더한다. 기존 `state`(훅 상태)는 바꾸지 않는다 | 필수 |
| FR-ITC-6 | 트리 표지가 있는 Run 의 대시보드는 **이슈 트리를 중심**에 그린다. 평평한 멤버 그래프(SVG) 자리에 트리를 둔다. 루트 → 중간 → 잎의 깊이를 위에서 아래로 내려가는 도형 다이어그램(노드 상자 + 연결선, SVG)으로 보이고, 병렬 가지(다른 Run)도 같은 트리 안에 보인다. 배치 규칙은 FR-ITC-10 이다 | 필수 |
| FR-ITC-7 | 트리 노드마다 이슈 번호 · 제목 · 상태(`waiting-children` 포함) · 맥락 사용률을 보인다. 끝난 노드는 흐리게 남긴다. 노드를 누르면 그 탭으로 간다(FR-ITD-4) | 필수 |
| FR-ITC-8 | 트리 Run 의 카드와 타임라인은 지금처럼 남긴다. 카드 순서는 트리 순서(깊이 우선)다 | 필수 |
| FR-ITC-9 | 트리 아닌 Run 의 대시보드는 바꾸지 않는다 | 필수 |
| FR-ITC-10 | 트리 다이어그램의 배치는 노드 목록(깊이 우선 순서)만으로 정한다. 깊이가 세로 줄이다. 잎(자식이 없는 노드)은 깊이 우선 순서대로 가로 칸을 하나씩 받고, 부모는 첫 자식과 끝 자식의 가운데에 선다. 부모가 목록에 없는 노드는 루트로 세운다. 연결선은 부모 상자 아래에서 자식 상자 위로 꺾여 내려간다. 상자 안에 제목이 넘치면 줄여 쓰고 전체는 툴팁에 싣는다. 표시 크기는 멤버 그래프와 같은 폭 맞춤(FR-FIT-1~4)을 따른다 | 필수 |

### 3.4 묶음 M — 맥락 기준 migration (FR-ITM-\*)

#### 3.4.1 설정

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITM-1 | `SETTINGS_SCHEMA` 에 넷을 더한다. 일반 훅: `migrationHook`(bool, 기본 거짓) · `migrationHookCtxPct`(int, 기본 50, 1~100). issue-tree: `issueTreeMigration`(bool, 기본 참) · `issueTreeCtxPct`(int, 기본 50, 1~100). 설정창에 보인다 | 필수 |
| FR-ITM-2 | 두 쌍은 서로 영향을 주지 않는다. 한쪽 값을 바꿔도 다른 쪽은 그대로다 | 필수 |
| FR-ITM-3 | issue-tree 노드의 맥락 기준 **실효값**은 배정의 `--ctx` > `issueTreeCtxPct` > 50 이다. `issueTreeMigration` 이 거짓이면 실효값은 「끔」 이다. 서버가 프리앰블을 만들 때 이 값을 정해 싣는다 | 필수 |
| FR-ITM-4 | 값이 비었거나 범위 밖이면 기본값으로 돌아간다(`ContextPolicy.withDefaults` 와 같은 규칙) | 필수 |
| FR-ITM-5 | `issue-tree.md` 의 `--ctx` 기본값 표기를 「설정 `issueTreeCtxPct`(기본 50)」 로 바꾼다. `--ctx` 를 주지 않으면 배정에 싣지 않는다 | 필수 |

#### 3.4.2 일반 훅

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITM-10 | claude 의 `PostToolUse`·`UserPromptSubmit` 에 맥락 훅 `dmctl ctx-hook claude` 를 더한다. 훅은 서버에 자기 도구(`DONGMINAL_TOOL_ID`)의 판정을 묻는다: `GET /api/tools/migration-advice?id=<toolId>` | 필수 |
| FR-ITM-11 | 서버 판정: ① 도구가 트리 멤버이면 `skip` ② `migrationHook` 이 거짓이면 `skip` ③ 맥락 사용률을 모르면 `unknown` ④ 사용률 ≥ `migrationHookCtxPct` 이면 `advise` ⑤ 아니면 `ok`. 응답은 `{verdict, usedPct?, ctxPct}` 다 | 필수 |
| FR-ITM-12 | `advise` 이면 훅은 additionalContext 로 알린다. 매 훅마다 알린다. 본문은 지금 사용률과 기준(「지금 맥락 57% · 기준 50%」), `/dongminal:migration` 을 하라는 강한 제안, 넘기지 않아도 되는 경우(여러 파일에 걸친 수정을 반쯤 했거나, 디버깅 단서를 들고 있을 때)다 | 필수 |
| FR-ITM-13 | `unknown` 은 그 도구에서 **한 번만** 알린다(「맥락 사용률을 읽을 수 없어 migration 기준을 적용하지 못한다」). 몇 번째인지는 서버가 도구마다 기억한다 | 필수 |
| FR-ITM-14 | 훅은 `Stop` 을 막지 않는다. 훅의 실패·시간 초과는 에이전트를 막지 않고 조용히 끝난다(시한은 `hookBudget`) | 필수 |
| FR-ITM-15 | 트리 멤버인지는 서버가 Run 기록으로 판정한다(D-ITO-5). 자기 승계로 선 새 세션도 트리 멤버이므로 따로 표시하지 않아도 된다 | 필수 |

#### 3.4.3 issue-tree 노드의 안전 지점

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITM-20 | 중간 노드의 안전 지점은 지금과 같다: 하위 하나의 `완료` 를 처리한 뒤, 다음 하위를 열기 전 | 필수 |
| FR-ITM-21 | 잎 노드의 안전 지점: 일의 한 단계(시험이 통과하는 단위)를 커밋한 뒤. 잎은 이 자리에서 `dmctl status --json` 의 `context.usedPct` 를 배정의 맥락 기준과 견주고, 이상이면 `/dongminal:migration` 의 멤버 갈래(FR-ITB-5)로 넘긴다 | 필수 |
| FR-ITM-22 | 맥락 기준이 「끔」 이면 노드는 맥락 때문에 넘기지 않는다. 사용률을 읽지 못하면 넘기지 않고, 그 사실을 보고에 적는다(FR-IAT-64) | 필수 |

### 3.5 묶음 W — 표시줄 탭 이름 (FR-ITW-\*)

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITW-1 | `_rWinTitle(w)` 는 `<창 종류> · <window 이름> · <포커스 탭 이름>` 을 만든다. 포커스 탭은 그 window 의 포커스 pane 의 활성 탭이다. 탭이 없으면 지금 꼴이다 | 필수 |
| FR-ITW-2 | 탭 이름은 탭 바와 같은 `tabName` 규칙이다(사용자 이름 · 전경 프로세스 이름 포함). 탭 바의 변경 표시(●)는 싣지 않는다. 탭 이름이 창 이름이나 종류 라벨과 같으면 겹쳐 적지 않는다(FR-STB-1 과 같은 규칙) | 필수 |
| FR-ITW-3 | 최상단 표시줄과 칸 머리글이 모두 FR-ITW-1 의 함수 하나로 칠한다. 칸이 여럿이면 각 머리글이 자기 window 의 포커스 탭을 보인다 | 필수 |
| FR-ITW-4 | pane 포커스가 바뀌거나, 탭이 바뀌거나, 탭 이름(전경 프로세스 이름 포함)이 바뀌면 바로 다시 칠한다 | 필수 |
| FR-ITW-5 | 길면 CSS 말줄임으로 줄이고, 전체 문자열을 `title` 에 싣는다. 모바일도 같은 함수와 같은 규칙이다 | 필수 |

### 3.6 묶음 E — 편집기 단축키 (FR-ITE-\*)

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITE-1 | 편집기는 VS Code 기본 편집 단축키를 받는다. 대상 표는 묶음 착수 때 VS Code 기본 키맵과 지금 동작을 키 하나씩 견주어 이 절에 덧붙인다(§3.6a). 그 표가 이 묶음의 시험 목록이다 | 필수 |
| FR-ITE-2 | 키는 CodeMirror 의 기존 명령(`@codemirror/commands`·`@codemirror/search`)으로 묶는다. 같은 동작을 새로 짜지 않는다 | 필수 |
| FR-ITE-3 | 편집 키와 앱 단축키가 겹치면, 포커스가 편집기 본문에 있을 때는 **편집 키가 이긴다.** 겹치는 키는 §3.6a 표에 적는다 | 필수 |
| FR-ITE-4 | 사용자가 Settings ▸ Shortcuts 에서 바꾼 앱 단축키는 그 키가 편집 키와 겹쳐도 앱 단축키로 동작한다(사용자가 고른 키다) | 필수 |
| FR-ITE-5 | 편집기 고유 키(검색·코드 탐색·저장, FR-EKB-*)는 바꾸지 않는다 | 필수 |

#### 3.6a 대조표 (묶음 E 착수 때 조사, 2026-11-07)

**근본 원인.** 편집기 본문에 포커스가 있어도 앱의 capture 단계 keydown 처리기(`input-binding.js`)가 끝에서 `Cmd`/`Ctrl` 조합의 브라우저 기본 동작을 막았다(`_blockBrowserDefault`). 막힌 이벤트는 CodeMirror 키맵이 처리하지 않는다. 그래서 키맵에 있는 `Mod-/`(주석) · `Mod-]`·`Mod-[`(들여쓰기) · `Shift-Mod-k`(줄 지우기) · `Mod-Enter` · `Mod-Alt-↑/↓`(커서 더하기) · `Mod-u` 등이 모두 동작하지 않았다. 수식키 없는 `Alt-↑/↓`(줄 옮기기)만 살아 있었다.

**고침.** 파일 편집기 본문에서는 capture 단계에서 막지 않는다. CodeMirror 가 판정한 뒤 편집기의 bubble 처리기가, CodeMirror 가 쓰지 않은 조합만 막는다(`InputBinding.blockBrowserDefault`). git diff 보기의 동작은 바꾸지 않는다.

| VS Code 키 (mac / Win·Linux) | 동작 | 지금 | 조치 |
|---|---|---|---|
| ⌘/ · Ctrl+/ | 줄 주석 | 키맵에 있음 · 막혀 있었다 | 막기 시점 이동 |
| ⇧⌥A · Shift+Alt+A | 블록 주석 | 키맵에 있음 · 막혀 있었다(Win) | 막기 시점 이동 |
| ⌘] ⌘[ · Ctrl+] Ctrl+[ | 들여쓰기 · 내어쓰기 | 키맵에 있음 · 막혀 있었다 | 막기 시점 이동 |
| ⇧⌘K · Ctrl+Shift+K | 줄 지우기 | 키맵에 있음 · 막혀 있었다. Win 은 앱 `softReload` 와 겹친다 | 막기 시점 이동 · 겹침은 편집 키가 이긴다(FR-ITE-3) |
| ⌥↑↓ · Alt+↑↓ | 줄 옮기기 | 동작 | — |
| ⇧⌥↑↓ · Shift+Alt+↑↓ | 줄 복사 | 동작 | — |
| ⌘⌥↑↓ · Ctrl+Alt+↑↓ | 커서 더하기 | 키맵에 있음 · 막혀 있었다 | 막기 시점 이동 |
| ⌘↩ · Ctrl+Enter | 아래에 줄 넣기 | 키맵에 있음 · 막혀 있었다 | 막기 시점 이동 |
| ⇧⌘\\ · Ctrl+Shift+\\ | 짝 괄호로 | 키맵에 있음 · 막혀 있었다 | 막기 시점 이동 |
| ⌘U · Ctrl+U | 커서 되돌리기 | 키맵에 있음 · 막혀 있었다 | 막기 시점 이동 |
| ⌥⌘[ ⌥⌘] · Ctrl+Shift+[ ] | 접기 · 펴기 | 키맵에 있음 · 막혀 있었다. Win 은 앱 window 이동과 겹친다 | 막기 시점 이동 · 겹침은 편집 키가 이긴다 |
| ⌥←→ · Ctrl+←→ (+Shift) | 낱말 단위 이동·선택 | 키맵에 있음. Win 의 Ctrl+Shift+←→ 는 앱 칸 이동과 겹친다 | 겹침은 편집 키가 이긴다 |
| ⌘D · Ctrl+D | 다음 같은 낱말 선택 | 없음(`@codemirror/search` 키맵을 넣지 않았다) | `Mod-d` → `selectNextOccurrence` |
| ⇧⌘L · Ctrl+Shift+L | 같은 낱말 모두 선택 | 없음 | `Mod-Shift-l` → `selectSelectionMatches` |
| ⌃G · Ctrl+G | 줄로 이동 | 없음 | `Ctrl-g` → `gotoLine` |
| ⌘L · Ctrl+L | 줄 선택 | CodeMirror 는 `Alt-l`(mac `Ctrl-l`) | `Mod-l` → `selectLine` |
| ⌃⇧⌘→ · Shift+Alt+→ | 선택 넓히기 | CodeMirror 는 `Mod-i` | `Shift-Alt-ArrowRight`(mac `Ctrl-Shift-Cmd-ArrowRight`) → `selectParentSyntax` |
| ⌥클릭 · Alt+클릭 | 커서 더하기 | CodeMirror 는 Mod+클릭 | `clickAddsSelectionRange` 를 Alt 로. Mod+클릭은 정의로 가기(FR-ELS-*)가 쓴다 |
| ⌘F · ⌘P · ⇧⌘F · F12 · ⌘S | 찾기 · 빠른 열기 · 전체 찾기 · 정의 · 저장 | 앱의 편집기 키(FR-EKB-*) | 바꾸지 않는다(FR-ITE-5) |
| ⇧⌘↩ · 축소 선택 · ⇧⌥F(서식) · F2(이름 바꾸기) | — | CodeMirror 에 명령이 없거나 LSP 기능이다 | 비목표(§6) |

### 3.7 묶음 S — 에이전트 정보 조회 (FR-ITS-\*)

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITS-1 | `dmctl status --at <탭 uuid\|toolId>`(또는 `--member`)의 **글자 출력**에 statusLine 관측이 있으면 한 줄을 더한다: `model=<표시 이름> effort=<값> cost=$<총 비용> rate=<창 이름>:<사용률>%…`. `--json` 은 이미 `usage` 전부를 싣는다(FR-SLP-20) | 필수 |
| FR-ITS-2 | `dmctl status` 도움말에 「다른 에이전트는 `--at <toolId>` 로 지목한다」 와 `usage` 필드 설명을 적는다 | 필수 |

### 3.8 비기능 요구사항 (Non-functional)

| ID | 요구 |
|---|---|
| NFR-ITO-1 | 맥락 훅(FR-ITM-10)이 도구 호출 하나에 더하는 시간은 서버 응답 포함 50ms 이하(로컬)다. 서버가 응답하지 않으면 `hookBudget` 안에 끝난다 |
| NFR-ITO-2 | 배정 필드는 모두 omitempty 다. 배정 없는 옛 `runs.json` 은 그대로 읽힌다(마이그레이션 없음) |
| NFR-ITO-3 | 트리 프리앰블과 일반 프리앰블은 같은 패키지의 함수 둘이다. 서버가 강제하는 계약(보고 1회·outcome 필수)은 두 함수가 같은 명령 줄(`dmctl run report --run --member --outcome`)로 적는다. 문장이 같은 규칙은 같은 상수를 쓴다. 일반 프리앰블은 바이트로 바뀌지 않는다 |
| NFR-ITO-4 | 바뀐 명령 문서(`issue-tree.md`·`migration.md`)는 스킬 계약 시험(`skills_contract_test.go`)을 통과한다 |

## 4. 결정 (Decisions)

| ID | 결정 | 근거 |
|---|---|---|
| D-ITO-1 | 배정을 Run 기록의 데이터로 두고 프리앰블에 싣는다. 배정 엔벨로프를 없앤다 | 입력 3의 두 안 중 「배정 전체를 brief 에 담는다」 를 고른다. 기록에 있으면 기동줄·승계·migration 이 같은 값을 쓴다(입력 7이 함께 풀린다). 「배정 전에 시작하지 마라」 는 기다림 하나를 더할 뿐, 배정이 빠지는 경로를 막지 못한다 |
| D-ITO-2 | 트리 멤버에게는 트리 전용 프리앰블을 준다. 조정자 = 부모 멤버의 지금 도구 | 입력 4의 두 안 중 전용 프리앰블. 일반 Run(트리 아님)의 규약은 그대로 맞다. 부모를 toolId 가 아닌 member 로 기록해 승계에도 맞는 주소를 낸다 |
| D-ITO-3 | 질문은 노드가 자기 탭에서 바로 묻고, 결정은 GitHub 이슈 코멘트로 남긴다. 부모는 안전 지점에서 결정 코멘트로 충돌을 본다 | 사용자 결정(2026-11-07). 부모 왕복은 부모 맥락만 늘렸다. 새 장부·새 문서는 결정의 자리를 하나 더 만들고, 이번 Run 밖의 결정을 담지 못한다. 이슈 코멘트는 이미 있는 자리이고 입력 14의 「메모」 와 같은 자리다 |
| D-ITO-4 | 끼어든 이슈는 (가) 새 노드로 연다. 하던 일은 WIP 커밋과 이슈 메모로 남긴다 | 입력 13 원문("다음 형제 이슈로 이동할 때 leaf 가 직접 하는게 아닌 무조건 부모에 의해")이 (나) 같은 세션 유지를 막는다. WIP 커밋은 사용자 결정(2026-11-07) — 같은 worktree 를 쓰는 다음 노드의 커밋에 섞이지 않는다. 트리 브랜치는 사용자 브랜치가 아니다 |
| D-ITO-5 | issue-tree 표시는 서버 판정((다))이다. 맥락 훅은 서버에 묻고, 서버가 트리 멤버면 `skip` 을 낸다 | 훅은 사용률을 읽으려면 어차피 서버를 부른다. 같은 호출이 표시를 판정하므로 비용이 없다. 자기 승계로 선 새 세션은 멤버이므로 저절로 같은 표시를 가진다. (가) 환경 변수는 migration 이 새 세션에 다시 붙여야 하고, (나) `--settings` 는 claude 래퍼의 설정과 겹친다 |
| D-ITO-6 | 맥락 훅은 `PostToolUse`·`UserPromptSubmit` 에 건다. 켬이 기본이다 | 「기준을 넘긴 바로 그 훅부터 매 훅」(사용자 결정)은 도구 호출마다 불리는 `PostToolUse` 가 지킨다. `UserPromptSubmit` 은 도구를 부르지 않는 턴을 덮는다. `Stop` 은 막는 데 쓰지 않는다(사용자 결정). 켬이 기본인 것은 「모든 에이전트에 적용」 이 요구이기 때문이다 |
| D-ITO-7 | 표시 기준(warn 70%)과 migration 기준(50%)의 차이는 그대로 둔다. 따로 표시하지 않는다 | 두 값은 뜻이 다르다(맥락 위험 등급 vs 넘길 시점). migration 제안은 훅이 에이전트에게 직접 하므로 화면 표시가 없어도 동작한다. 필요해지면 그때 더한다 |
| D-ITO-8 | 트리 Run 의 대시보드를 트리 중심으로 바꾼다. 새 Run 종류를 만들지 않는다 | 사용자 지시("issue-tree 전용 Run", "Run 을 issue-tree 에 특화해도 된다")의 목표는 깊이가 보이는 것이다. 트리 표지(FR-ITU-1)가 이미 issue-tree Run 을 가른다. 종류를 새로 두면 격리·정리·보고 경로가 갈라진다 |
| D-ITO-9 | GitHub 이슈 트리 그래프는 만들지 않는다(D-IAT-18 유지) | 사용자 결정(2026-11-07). 자격 증명 없이 읽을 수 있는 것은 공개 저장소뿐이다(§2.9). 진행한 경로와 끝난 노드는 묶음 C 의 대시보드에 보인다 |
| D-ITO-10 | D-IAT-19(부모 필드를 두지 않는다)를 뒤집는다 | 입력 8 의 사용자 지시("부모·자식 관계를 Run 이 데이터로 가진다"). 사슬 이름은 끼어든 이슈·승계를 표현하지 못한다 |
| D-ITO-11 | 맥락 설정은 평평한 키 넷이다(`migrationHook`·`migrationHookCtxPct`·`issueTreeMigration`·`issueTreeCtxPct`) | 사용자 결정은 「설정창이 저장하는 같은 파일, 이름은 기존 규약」 이다. 스키마의 규약은 평평한 camelCase 다. 중첩 `orchestration.*` 은 스키마 밖이라 브라우저 저장에서 사라진다(§2.6) |
| D-ITO-12 | 편집기 단축키의 기준은 VS Code 기본 키맵이다 | 사용자 보고("기존 모나코 단축키들중 안먹히는게 많아"). 편집기 엔진을 CodeMirror 로 바꾸면서 사라진 키(이전 엔진은 VS Code 와 같은 키를 썼다)를 되돌리는 일이다 |
| D-ITO-13 | 에이전트 정보 조회는 새 명령을 만들지 않고 `dmctl status` 를 쓴다 | `status --at <toolId> --json` 이 이미 statusLine 값 전부를 낸다(FR-SLP-20). 빠진 것은 글자 출력의 한 줄과 안내뿐이다 |

## 5. 검증 (Verification)

| TC | 대상 | 방법 |
|---|---|---|
| TC-ITA-1 | FR-ITA-1~4 | Go: 배정 저장 · 트리 아닌 Run 거절 · `--issue` 없음 거절 · 없는 부모 거절 · 승계가 배정을 물려받음 · `run assign` 권한(자기·부모만) |
| TC-ITA-2 | FR-ITA-10~19 | Go: 트리 프리앰블에 배정 블록·절대 경로·부모 toolId(승계 뒤 승계자)·루트의 「부모 없음」·이슈 운영 넷·report 주인이 있고 「조정자」·「AskUserQuestion 류의 … 열지 마라」 가 없다. 일반 멤버의 프리앰블은 변경 전과 바이트로 같다 |
| TC-ITA-3 | FR-ITA-30~51 · FR-ITB-5·7 · FR-ITM-21 | Go(문서 대조): `issue-tree.md`·`migration.md` 에 각 절차 문장이 있다. 계약 시험 통과(NFR-ITO-4) |
| TC-ITB-1 | FR-ITB-1·2 | Go: 자기 승계가 청하지 않고 곧바로 승계한다(시한을 기다리지 않음). 남의 멤버를 `--self` 로 승계하면 거절 |
| TC-ITB-2 | FR-ITB-3 | Go: 트리 멤버 승계 뒤 부모·자식 도구에 알림이 가고 자식의 배정 부모가 바뀐다. 트리 아닌 멤버는 알리지 않는다 |
| TC-ITB-3 | FR-ITB-4 | Go: `node_taken` 응답에 멤버 id·상태, `lost` 면 안내 |
| TC-ITB-4 | FR-ITB-6 | Go: `who-am-i` 응답의 `member` |
| TC-ITC-1 | FR-ITC-1~3 | Go: 배정 부모로 트리를 만든다 · 옛 기록은 사슬 이름 · 승계 사슬은 마지막 멤버 · 끝난 노드 포함 · 자식 순서 |
| TC-ITC-2 | FR-ITC-4·5 | Go: `waiting-children` 판정(훅 idle/done + 열린 자식) · 모든 Run 응답과 `dmctl status` 의 `member.state` 가 같다 |
| TC-ITC-3 | FR-ITC-6~10 | e2e: 트리 Run 대시보드의 중심에 트리 다이어그램 · 깊이 · 연결선 · 병렬 가지 · 끝난 노드 흐림 · 누르면 탭 이동. 트리 아닌 Run 은 그래프 그대로 |
| TC-ITC-4 | FR-ITC-10 | 단위(JS): 배치 함수 — 루트 하나 · 사슬 · 부모가 자식 가운데 · 형제 칸이 겹치지 않음 · 부모가 없는 노드는 루트 · 같은 입력은 같은 배치 · 빈 목록 · 제목 줄임 |
| TC-ITM-1 | FR-ITM-1~5 | 단위(JS)·Go: 스키마 넷 · 범위 밖은 기본값 · `--ctx` > 설정 > 50 · 끔 |
| TC-ITM-2 | FR-ITM-10~15 | Go: 판정 다섯 갈래 · `unknown` 한 번 · 트리 멤버 `skip`. 단위: `ctx-hook` 의 출력 모양(additionalContext), 서버 무응답 시 빈 출력·종료 0. 훅 설치 파일에 두 이벤트 |
| TC-ITW-1 | FR-ITW-1~5 | e2e: 표시줄·칸 머리글에 포커스 탭 이름 · pane 포커스 이동·탭 이름 변경을 따라감 · `title` · 모바일 |
| TC-ITE-1 | FR-ITE-1~5 | e2e: §3.6a 표의 키마다 편집기에서 동작 · 겹치는 키는 편집 키가 이김 · 사용자가 바꾼 앱 키는 앱 키 |
| TC-ITS-1 | FR-ITS-1·2 | Go: 글자 출력의 사용량 줄(관측 있음·없음) |

## 6. 비목표 (Non-goals)

- GitHub 이슈 데이터를 dongminal 이 읽거나 저장하는 것(D-ITO-9)
- 결정의 저장소·장부(D-ITO-3)
- claude 가 아닌 에이전트(codex·omp)의 맥락 훅. additionalContext 를 받는 훅이 확인된 에이전트만 대상이다
- 노드가 맡은 이슈를 바꾸는 명령(FR-ITA-44)
- 맥락 훅이 migration 을 강제하는 것(`Stop` 막기)
- 저장소별 맥락 설정 덮어쓰기
- 편집기 단축키 중 VS Code 기본 키맵에 없는 키, CodeMirror 에 명령이 없는 VS Code 키(⇧⌘↩ 위에 줄 넣기 · 선택 줄이기), 서식·이름 바꾸기처럼 LSP 기능에 기대는 키

## 7. 위험 (Risks)

| ID | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | 트리 프리앰블이 길어져 기동줄 길이 한도에 걸린다 | MEDIUM | 배정은 짧은 값이다. 절차 본문은 싣지 않고 문서의 절대 경로만 싣는다(FR-ITA-13). 시험에서 길이 상한을 잰다 |
| R-2 | 서버 발신 승계 알림(FR-ITB-3)이 일하던 자식의 입력에 끼어든다 | LOW | 신뢰 엔벨로프는 이미 일하는 에이전트에게 가는 경로다(협업 요청). 본문은 한 줄이다 |
| R-3 | 맥락 훅이 매 도구 호출마다 서버를 부른다 | MEDIUM | NFR-ITO-1. 판정은 메모리 값만 본다. 서버가 없으면 시한 안에 조용히 끝난다 |
| R-4 | WIP 커밋이 트리 브랜치에 남아 병합 때 보인다 | LOW | 루트 노드의 끝(FR-IAT-71)에서 사용자에게 병합 방식(스쿼시 포함)을 묻는다 |
| R-5 | 부모가 결정 코멘트를 읽지 않으면 충돌을 놓친다 | MEDIUM | 안전 지점의 절차 걸음으로 적는다(FR-ITA-33). 트리 프리앰블에도 적는다 |
| R-6 | VS Code 키와 앱 단축키·브라우저 키가 겹친다(`Mod-d`·`Mod-l` 등) | MEDIUM | FR-ITE-3·4. 브라우저가 가로채는 키는 §3.6a 표에 「불가」 로 적는다 |

## 8. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-11-09 | FR-ITC-6 개정, FR-ITC-10·TC-ITC-4 추가. 이전 동작: 트리 Run 의 이슈 트리는 깊이만큼 들여쓴 목록이었고 노드를 잇는 선이 없었다. 새 동작: 위에서 아래로 내려가는 도형 다이어그램(SVG 노드 상자 + 꺾인 연결선)으로 그린다. 노드 내용·흐림·누르면 탭 이동은 그대로다. 이유: 사용자 요청(「실제 트리 모양으로」, 도형 다이어그램 선택) |
| 2026-11-09 | FR-ITM-1 의 `migrationHook` 기본값을 참에서 거짓으로 바꿨다. 이전 동작: 일반 세션은 맥락 사용률이 50% 이상이면 기본으로 migration 제안을 받았다. 새 동작: 기본은 끔이다. 맥락 사용률은 그대로 모으고, 설정에서 켜야 제안한다. 표를 읽지 못할 때의 폴백도 일반 훅은 끔이다. `issueTreeMigration` 은 기본 켬 그대로다. 이유: 자동 제안이 사용자의 하네스나 설정을 깰 수 있다(사용자 결정) |
| 2026-11-07 | 구현완료. 사용자 시범으로 확인 |
| 2026-11-07 | 묶음 E 구현(§3.6a). 이전 동작: 편집기 본문의 수식키 조합은 capture 단계에서 브라우저 기본이 막혀 CodeMirror 키맵에 닿지 않았다. `Mod-d`·`Mod-Shift-l`·`Ctrl-g`·`Mod-l` 등 VS Code 키가 없었다. 새 동작: CodeMirror 가 먼저 판정하고 쓰지 않은 조합만 막는다. VS Code 키 다섯과 Alt+클릭 커서를 더했다. Win/Linux 에서 겹치는 기본 앱 키 다섯은 편집기 본문에서 편집 키가 이긴다(사용자가 녹음한 키는 앱 키). 이유: 입력 10 의 사용자 보고 |
| 2026-11-07 | 묶음 W 구현. 이전 동작: 표시줄과 칸 머리글은 `<창 종류> · <창 이름>` 이었고, pane 포커스 이동과 전경 이름 갱신에는 다시 칠하지 않았다. 새 동작: 끝에 그 창의 포커스 탭 이름이 붙고(겹치면 생략), 포커스 이동·전경 이름 갱신에도 제목만 다시 칠하며(`_rPaintTitles`), 전체 문자열을 `title` 에 싣는다. 기존 e2e(`slot-title-boundary`·`git-window-name`)의 기댓값을 새 형식으로 고쳤다. 이유: 별건 요구(표시줄 탭 이름)와 사용자 결정(모든 자리에 붙인다) |
| 2026-11-07 | 묶음 M 구현. 이전 동작: 맥락 기준은 `issue-tree.md` 의 `--ctx`(기본 60)뿐이었고 중간 노드만 봤다. 일반 세션에는 migration 제안이 없었다. 새 동작: 설정 넷(`migrationHook`·`migrationHookCtxPct`·`issueTreeMigration`·`issueTreeCtxPct`, 기본 켬·50). claude 의 PostToolUse·UserPromptSubmit 에 `dmctl ctx-hook` 이 서서 서버 판정(`GET /api/tools/migration-advice`)을 additionalContext 로 옮긴다. 트리 프리앰블의 맥락 기준은 `--ctx` > 설정 > 50, 설정이 끔이면 「끔」. 잎 노드도 단계를 커밋한 뒤 맥락을 본다. 이유: 별건 요구 1~5 와 사용자 결정 넷 |
| 2026-11-07 | 묶음 C·S 구현. 이전 동작: 트리 응답은 열린 노드만, 부모는 사슬 이름에서 냈다. 하위를 기다리는 노드는 `ready`(Run)·`done`(훅)으로 갈렸다. 트리 Run 대시보드의 중심은 평평한 그래프였다. `dmctl status` 글자 출력에 모델·비용·한도가 없었다. 새 동작: 부모는 배정에서 얻고 승계 사슬은 마지막 멤버 하나다. 끝난 노드도 흔적으로 내고 깊이 우선으로 늘어놓는다. 열린 자식이 있는 쉬는 트리 노드는 `waiting-children` 이다. `GET /api/tools/activity/get` 은 Run 멤버이면 `member{id,state}` 를 싣는다. 트리 Run 대시보드는 그래프를 감추고 트리를 중심에 둔다(이슈 번호·제목, 끝난 노드는 흐림). 카드는 트리 순서다. `dmctl status` 는 `run_state=` 와 사용량 줄을 낸다. 이유: 입력 5·8·11 |
| 2026-11-07 | 묶음 B 구현. 이전 동작: `run succeed` 는 언제나 옛 멤버에게 인수인계를 청하고 기다렸다. `node_taken` 은 코드만 냈다. migration 은 Run 멤버도 일반 절차로 넘겨 옛 멤버가 `lost` 로 남았다. 새 동작: `run succeed --self` 는 청하지 않고 요약을 싣는다. 트리 멤버의 승계는 부모·자식에게 알리고 자식의 배정 부모를 옮긴다. `node_taken` 은 쥔 멤버·상태와 lost 일 때 이어받기 안내를 싣는다. `who-am-i` 는 `member` 를 싣고, migration 은 멤버이면 자기 승계로 넘긴다. 이유: 입력 1·7 |
| 2026-11-07 | 묶음 A 구현. 이전 동작: 트리 Run 의 멤버는 역할 이름만으로 등록됐고, 배정은 기동 뒤 엔벨로프로 따로 왔다. 새 동작: 트리 멤버는 `--issue` 배정이 있어야 등록되고(없으면 `invalid_argument`), 배정은 기록에 남아 트리 프리앰블에 실린다. 이유: 배정 전에 일을 시작하고 migration 이 배정을 빠뜨렸다(입력 3·7). 권한 거절은 새 코드를 만들지 않고 `sender_not_member` 를 쓴다 |
| 2026-11-07 | 초안. 요구 입력 `ISSUE_TREE_OPS_FINDINGS.md` 1~14번과 별건 요구(맥락 migration·표시줄)를 묶음 A·B·C·M·W·E·S 로 옮겼다. 사용자 결정: 질문·결정 경로(D-ITO-3), 끼어든 이슈의 하던 일(D-ITO-4), 이슈 트리 그래프는 조사로 끝냄(D-ITO-9), 편집기 키의 기준(D-ITO-12). `ISSUE_AGENT_TREE_SRS` 개정: FR-IAT-51~54(질문 경로) → FR-ITA-30~34, FR-IAT-60(`--ctx` 기본 60) → FR-ITM-3·5(설정 기본 50), FR-IAT-63(migration) → FR-ITB-5, FR-IAT-73(잎이 자기 탭을 닫는다) → FR-ITA-41(부모가 닫는다), FR-ITD-2(사슬 이름) → FR-ITC-1, FR-ITD-6(열린 노드만) → FR-ITC-3, D-IAT-19 → D-ITO-10 |
