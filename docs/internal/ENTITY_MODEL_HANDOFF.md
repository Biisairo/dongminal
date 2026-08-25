# 인계: 엔티티 모델 재정비 (P1~P8 완료)

P8 까지 완료. 요구 1·2 종결, 요구 3(오케스트레이션)만 후속 SRS 로 남았다.

## 1. 이 작업이 무엇인가

사용자 요구 3건에서 출발했다.

1. **구조·네이밍 재정비** — `session`/`pane`/`tab` 이 무엇을 지칭하는지 불명확
2. **백그라운드 동작** — tmux 처럼 탭을 닫아도 도구가 계속 돌게
3. **AI 오케스트레이션** — Orca ADE 수준으로 제대로

단일 진실 공급원은 **`docs/internal/ENTITY_MODEL_RESTRUCTURE_SRS.md`** (IEEE 29148, 370행).
요구 1·2 는 이 SRS 가 담당하고, 요구 3 은 후속 `RUN_ORCHESTRATION_SRS`(미작성)로 분리했다.

완료된 과거 SRS·RFC 는 `docs/internal/archive/` 로 옮겼다. **보관 문서는 당시 어휘와
당시 코드 위치를 그대로 담고 있으므로 갱신하지 않는다** — 지금의 사실은
`architecture.md` 와 코드가 답한다. 전체 색인은 `docs/internal/README.md` 에 있다.

## 2. 확정된 모델

```
공간 축:  Client ▶ Window ─ Pane ─ Tab ─ Tool
실행 축:  Run ─ Member ──1:1──▶ Tool        (직교. 접합 필드만 구현)
```

| 용어 | 뜻 | 구 용어 |
|------|----|---------|
| **Client** | 브라우저 창. 휘발성 뷰포트. Window 하나에 attach | (무명) |
| **Window** | Pane 들을 담는 작업공간. 서버 영속. tmux 의 session | `session` |
| **Pane** | Window 안에서 나뉜 공간. 탭 목록 보유 | `region` |
| **Tab** | 도구를 담는 공간 | `tab` |
| **Tool** | 탭에 탑재되는 실체 (`terminal`\|`editor`) | `pane`(PTY)/`paneId` |
| **Run** | 오케스트레이션 실행 인스턴스 | (없음) |

**핵심 결정과 근거**

- `session` 이라는 단어는 **폐기**했다. 업계에 두 관례(iTerm2 = 프로세스 부착 하나 / tmux = detach 가능한 작업공간)가 있어 한 단어가 두 층을 가리키는 것이 혼란의 원인이었다. 두 개념은 각각 `Tool` 과 `Window` 가 담는다.
- `Split` 은 **계층 레벨이 아니다** — Window 안의 Pane 배치를 표현하는 레이아웃 트리 내부 노드. 좌표계에 Split 성분이 없는 것과 일치한다.
- 좌표계는 `S{n}.P{n}.T{n}` → **`W{n}.P{n}.T{n}`**. 성분 3개 유지. `P` 의 의미(Split 트리 in-order 위치)는 원래부터 맞았고 어긋난 건 `S` 와 `paneId` 두 개였다.
- **Run 은 계층이 아니라 직교 축**이다. 최상위에 `Session` 을 추가하는 안(5계층)을 검토했으나, 공간 노드로는 "공간을 차지하지 않고 백그라운드로만 도는 팀"을 표현할 수 없고 실행 상태·토폴로지·보고를 담을 자리도 없어 폐기했다. Run 의 공간 투영은 선택적이다(`dedicated-window`|`background`|`inline`).
- **백그라운드는 도구 단위**다. Window 는 서버에 영속되고 아무 Client 가 보지 않아도 도구가 계속 돌아 tmux 의 detach 상태가 이미 기본값이므로 별도 동작이 없다(FR-BG-5). 도구만 탭 생명주기에 묶여 있어 떼어내기가 필요하다.
- 백그라운드 UX 는 **탭 닫기 기본 종료 + 명시적 `detach`**다. 닫을 때마다 묻지 않는다. 실행 중인 탭은 셸 프롬프트가 없어 `detach` 를 칠 수 없으므로, 이미 뜨는 busy 확인창에 버튼을 추가했다.
- 백그라운드 도구는 **데몬 재시작을 넘기지 않는다**(FR-BG-9). `LoadAll` 은 프로세스를 복원하는 게 아니라 같은 cwd 로 빈 셸을 만드는 것이므로 되살릴 의미가 없다. 이 규칙 하나가 고아 누적을 원리적으로 차단해 **TTL·개수 한도·회수 스케줄러가 전부 불필요**해졌다.

## 3. 단계별 진행 상황

| 단계 | 내용 | 커밋 | 상태 |
|------|------|------|------|
| P1 | 스펙 + v2 마이그레이션 도구 (`dongminal migrate`) | `0d45514` | 완료 |
| P2 | v2 스키마 전환(원자적) — 스키마·Go 파서·브라우저·좌표계 | `039c234` | 완료 |
| P3 | 공간 계층 심볼·UI 문자열 개명 | `fa420a8` | 완료 |
| — | e2e 인프라 수리 (데몬·PTY 누수, 자기 홈 삭제) | `7fdca80` | 완료 |
| P4 | 외부 계약 — MCP·dmctl·HTTP·SSE·단축키 + settings 마이그레이션 | `200382f` | 완료 |
| P5 | 도구 1급화 + 참조 무결성 + PTY 계층 `Tool` 개명 | `8730ed5` | 완료 |
| P6+P7 | 백그라운드 + Run 접합 필드 (+ P5 회귀 수정) | `6572b9c` | 완료 |
| P8 | 문서·스킬 어휘 스윕 + 잔여 심볼 개명 + 죽은 코드 제거 + e2e 정상화 | — | 완료 |

## 4. 완료 내역과 다음 세션이 할 일

### 4.1 P8 에서 실제로 한 일 (완료)

문서·스킬 어휘 스윕에서 출발했지만, 스윕 중 **기능이 죽어 있던 결함 3건**과
**제거된 서브시스템의 문서·코드 잔재**가 드러나 함께 처리했다.

**기능 결함**

| 결함 | 증상 | 성격 |
|------|------|------|
| `detachTab`·`restoreTool` 이 `allowedCmdActions` 에 없음 | `detach` CLI 전체가 400 으로 무동작 | P6 회귀 |
| `renameWindow` 가 화이트리스트에 없음 | `dmctl rename-window` 무동작 | `renameSession` 시절부터의 기존 결함 |
| `closeTab` 이 창 소멸 경로에서 백그라운드 등록을 건너뜀 | 마지막 탭을 `detach` 하면 도구가 종료되지도, 목록에 오르지도 않아 **어디서도 닿을 수 없게 됨** (FR-BG-6f 위반) | P6 결함 |

세 결함 모두 회귀 테스트를 먼저 RED 로 고정한 뒤 고쳤다.

**제거된 서브시스템 정리**

`code-server` 통합과 `markdown` 뷰어는 `8dc0a3f`("feat: editor 임베드")에서
내장 Monaco 편집기로 대체되며 사라졌으나 잔재가 광범위했다.

- 문서: README·`api.md`·`features.md`·`commands.md`·`architecture.md`·`test-checklist.md` 가 없는 기능을 설명 중이었다. 편집기 기술로 대체하고 README TODO 의 "code-server 재검토" 도 제거했다.
- 브라우저 코드: `term-pane.js` 가 **정의되지 않은** `codeServerPending`/`codeServerWatchers`/`codeServerTrack` 을 참조했다. 그중 한 곳은 터미널 링크 클릭 핸들러(살아있는 경로)였다. 삭제했다.
- `web/js/helpers.js` 의 `markdown` 도구 타입 항목, 미사용 함수 `closestRg`·`_focusedTab`·`_paneActiveToolId` 도 제거했다.

**심볼 개명 (P3·P5 미완 잔재)**

`gopls` 를 PATH 에 연결해 LSP 로 참조 집합을 확인한 뒤 그 집합에만 편집했다.
`Serena` 는 MCP 프로세스가 심볼릭 링크 생성 전에 기동돼 PATH 가 낡아 쓸 수 없었다.

| 개명 | 비고 |
|------|------|
| `PaneHooks`→`ToolHooks`, `paneRelay`→`toolRelay`, `pane*AttentionPayload`→`tool*` | `internal/server` |
| `PaneInfo`→`ToolInfo`, `ClientPaneResolver`→`ClientToolResolver` | `internal/mcptool` |
| `ListPanes*`→`ListWorkspace*`, `ReadPane{Screen,Output}*`→`Read{Screen,Output}*`, `readPaneArgs`→`readToolArgs`, `ReadPaneDeps`→`ReadToolDeps` | 툴명과 일치시킴 |
| `dmctlListPanes*`→`dmctlListWorkspace*`, `listPanesRow`→`listWorkspaceRow`, `paneEntry`→`toolEntry` | `internal/runtimebin` |
| `internal/paneline` → **`internal/toolline`** | 패키지·파일 이동 |
| `Deps.Panes`/`Server.Panes` → `.Tools`, 기존 `.Tools`(MCP 레지스트리) → `.MCPTools` | 이름 충돌 해소 |
| `OpSID` → `OpToolID` (Go·JS 양쪽) | 죽은 코드가 아니다 — 매 WS 연결마다 도구 id 를 보낸다 |
| DOM 클래스 `.rt`/`.rt-add`/`.rt-label` → `.pn-tab`/`.pn-tab-add`/`.pn-tab-label` | `rt` = "region tab" 의 잔재 |
| 테스트 함수 103개의 `Pane`→`Tool` 등 | `Paned`(데몬 계약)는 보존 |
| 죽은 코드 `Server.PersistSettings` 제거 | `a7bb512` 이후 호출자 없음. 설정은 PUT 시점에 저장돼 손실 없음 |

**MCP 툴 설명문 (에이전트 노출 계약)**

`list_workspace` 설명이 컬럼을 `session/tab/session_uuid/region_uuid` 로 광고했으나
실제 출력은 `window/tab/window_uuid/pane_uuid` 였다. 존재하지 않는 `dmctl list-tools`
를 6곳에서 참조했고, `workspace_command` 의 용어 블록은 일괄 개명 사고로
"분할 칸(Tool)" 이라 적혀 있었다(→ `Pane`). 모두 고쳤다.

**`workspace_command` 의 action 집합 분리**

화이트리스트를 넓힌 결과 MCP 가 `toolId` 없이 `detachTab` 을 보낼 수 있게 됐다.
스펙 enum 을 `workspaceCmdActions` 로 승격해 핸들러가 그것으로 검증한다 —
HTTP 20개, MCP 18개. `workspacecmd_gate_test.go` 가 둘의 동기화를 고정한다.

**e2e 17개 실패 전면 해소 (17 → 0)**

인계 시점의 "기존 실패 17개, 원인 미조사" 를 전수 진단했다. 제품 결함은 1건
(위의 `closeTab`)이고 나머지는 테스트 쪽 문제였다.

| 원인 | 건수 | 처리 |
|------|------|------|
| 워크스페이스 상태 누적 (순서 의존) | 11 | `e2e/fixtures.ts` 가 매 테스트 전 워크스페이스를 비우도록 변경 |
| 제거된 markdown 뷰어를 검사 | 5 | `md-scroll-sync.spec.ts` 삭제, `regression-md.spec.ts` → `regression-focus.spec.ts`(MdViewer 의존 2개만 제거, 포커스 불변식 7개 보존), `md-cwd-inherit.spec.ts` → `editor-cwd-inherit.spec.ts`(살아있는 editor 계약으로 이관) |
| 주의 알림 상태 누수 | 1 | 픽스처가 `clear-all` 호출 |
| 포커스 경합에 의존한 단정 | 1 | `mobile-keybar` TC-D2 를 요구 그대로(`mousedown` 의 `defaultPrevented`) 관측하도록 재작성 |
| 잘못된 기대값 | 1 | `sync.spec.ts` — `3abb475` 가 `waitForTimeout` 을 단정으로 바꿀 때 기대값을 0 으로 잘못 넣었다(창 2개 중 1개를 지웠으니 0 이 될 수 없다). 추가로 B 가 동기화되기 전에 개수를 읽는 경쟁 조건도 고쳤다 |

**신규 회귀 테스트**

- `internal/server/commands_browser_test.go` — `web/js/app.js` 의 `_execRemote` 본문을 파싱해 화이트리스트와 대조한다. `detach_test.go` 가 `httptest` 스텁에 POST 해서 결함을 못 본 구조를 막는다.
- `internal/mcptool/tools/workspacecmd_gate_test.go` — 스펙 enum ↔ 핸들러 게이트 동기화.
- `internal/server/httptest_helpers_test.go` — `mustGet`/`mustPost`/`mustDo`. `resp, _ := http.Get(...)` + `defer resp.Body.Close()` 패턴 44곳을 교체해 `go vet` 경고 32건을 없앴다.
- `e2e/skill-contract.spec.ts` — 스킬의 MCP 시퀀스와 `detach` 왕복을 라이브 서버에서 검증 (8개).

**스킬**

MCP 툴명·좌표계·`toolId` 는 이미 맞았고, 틀린 것은 `pane` 이 **도구/탭**을 뜻하는
자리였다(새 모델에서 Pane = 분할 칸). 42곳을 정정했다. 검증은 두 층 —
정적으로 스킬이 부르는 툴·action·dmctl 명령을 코드 계약과 대조(불일치 0),
라이브로 `e2e/skill-contract.spec.ts`. 토폴로지 재설계는 요구 3으로 남겼다.

### 4.2 사용자 인스턴스 업그레이드 (사용자가 "모든 작업 완료 후" 하기로 함)

현재 `~/.dongminal` 은 **v1 그대로**이고 구 바이너리가 돌고 있어 정상이다. 순서를 반드시 지켜야 한다.

```bash
./scripts/stop.sh --all          # 데몬까지 완전 정지 (필수)
./scripts/migrate.sh --dry-run   # 변환 내용 확인
./scripts/migrate.sh             # 실행 (*.v1.bak 백업 자동)
./scripts/start.sh
```

- `dongminal` 은 PATH 에 설치되지 않으므로(설치되는 helper 는 dmctl/edit/download/detach 뿐) `./scripts/migrate.sh` 가 진입점이다. 스크립트는 매번 재빌드하고, 서버가 포트에서 응답하면 변환을 거부한다 (`USER_CHECKLIST_FIXES_SRS` FR-MIG-3/6).
- 정지하지 않으면 `ErrDaemonRunning` 으로 거부된다 — 살아있는 데몬이 `SaveAll` 로 `tools.json` 을 되살려 산출물을 덮어쓰기 때문이다.
- 마이그레이션 없이 새 바이너리를 띄우면 `schemaVersion` 게이트가 안내를 출력하고 종료한다.
- 마이그레이션은 `workspace.json`(v2 스키마) + `panes.json`→`tools.json`(고아 폐기) + `settings.json`(단축키 id·레이아웃 프리셋)을 한 번에 처리하며 멱등하다.

### 4.3 요구 3 — 오케스트레이션 (후속 SRS 신규 작성)

`RUN_ORCHESTRATION_SRS` 를 새로 써야 한다. 조사 결론은 SRS §7 에 있다.

**사용자 결정**: "Orca 의 장점을 최대한 모방. 동작뿐 아니라 **실제 구현(MIT 공개 소스)도 참고**."

> **정정 (2026-08-25).** 아래 대비표 두 곳이 실측과 어긋난다 — orca 에 **fan-out 결과의
> 자동 비교·병합은 없고**(`merge_ready` 는 무동작 알림 타입이며 병합 판단은 사람이 한다),
> **paseo 는 AGPL-3.0-or-later** 라 코드를 차용할 수 없다. 근거는
> [ORCHESTRATOR_RESEARCH_NOTES.md](./ORCHESTRATOR_RESEARCH_NOTES.md) §2·§9, 정리된 결론은
> [RUN_ORCHESTRATION_SRS.md](./RUN_ORCHESTRATION_SRS.md) §2.5 다.

| 축 | Orca | dongminal 현재 |
|----|------|----------------|
| 격리 | agent 당 git worktree — 파일시스템 수준 | Pane 분할 — UI 수준만. **같은 워킹트리 공유** (repo 에 worktree 개념 0건) |
| 에이전트 간 통신 | 없음. fan-out → 비교 → 병합 | `send_agent_message` 신뢰 채널 + 토폴로지 협업 (**Orca 에 없는 차별점, 유지**) |
| 리뷰 | diff 인라인 주석 → 에이전트로 되돌림 | 없음 |
| 착수 | GitHub/Linear 태스크에서 worktree 개설 | 없음 |
| 실행 상태 | worktree 가 실체 | **없음** — `workflows/*.md` 정의서만 있고 런타임 부재 |

가장 큰 결손은 **격리**다. 현재 `skills/dongminal-team` 은 팀을 별도 공간에 만들지 않고 팀장의 Pane 을 쪼개므로 사용자 작업 공간을 침범하고, 그 방어 규칙이 스킬 문서의 절반을 차지한다.

**해소해야 할 결정**: worktree 격리는 팀원 간 파일 공유를 차단한다. 격리 여부를 **Run 단위로 선택**할지(두 실행 모드 유지) **항상 격리하고 통신 채널만으로 협업**할지(기존 토폴로지 일부 성립 불가).

## 5. 알려진 미해결 항목

| 항목 | 성격 | 비고 |
|------|------|------|
| ~~e2e 실패 17개~~ | **해소** | P8 에서 전수 진단. 115개 전원 통과, 2회 연속 재현 |
| `paned` 어휘 | 의도적 유지 | 데몬 프로세스·`paned.sock`·`paned.pid` 는 `scripts/*.sh` 와 실행 중 인스턴스의 계약. SRS 개명 목록에 없다 |
| `pane`/`paneId`/`pane_uuid`/`newPanes`/`type:"pane"` | **정당** | Pane = 분할 칸. 공간 계층의 실체이므로 개명 대상이 아니다 |
| `internal/migrate` 의 `panes.json`·`region`·`paneId` | **정당** | 구 어휘가 입력이다 (함정 2) |
| `delSession` 의 editor 미저장 확인 부재 | 기존 결함 | SRS 비목표에 명시 |
| 원격 `closeWindow` 무인 백그라운드 인자 | 미도입 | Run 이 Window 를 정리하는 시나리오는 후속 SRS |
| 도구를 다른 탭·Pane·Window 로 이동 | 미도입 | 1급화가 가능하게 만들었지만 기능은 추가하지 않았다 (SRS 비목표) |
| ~~gofmt 미준수 2개~~ | **해소** | `gofmt -l internal/ cmd/` 0건, `go vet ./...` 무경고 |

## 6. 이 작업에서 배운 함정 (반복 금지)

1. **일괄 정규식 치환이 스키마 값·와이어 키를 침범한다.** P5 에서 `\bpane\b`→`tool` 이 `n.Type == "pane"` 까지 바꿨고, 테스트 픽스처도 같이 바뀌어 **자기 정합적으로 틀린 계약**이 되어 Go 테스트가 통과했다. 브라우저는 `"pane"` 을 쓰므로 실제 데이터에서 라벨·uuid 해석이 전부 깨진 상태였다. → 값 자체를 고정하는 테스트를 넣었다(`TestLayoutTypeConstant_MatchesBrowser`). 같은 원인으로 `/ws?pane=`·`/api/cwd?pane=` 도 어긋났다.
2. **마이그레이션 코드는 구 어휘가 입력이다.** 일괄 치환이 `shortcutRenames` 맵의 구 키를 신 키로 덮어 매핑을 무력화한 일이 두 번 있었다. `internal/migrate` 는 치환 대상에서 제외한다.
3. **TypeScript 타입 주석이 매칭된다.** `\bpaneId:` 가 `paneId: string` 을 잡아 시그니처만 바뀌고 본문이 남았다.
4. **개명 후 소비처 전수 확인이 필수다.** `_findToolLocation` 의 반환 키를 바꾸면서 소비처 3곳을 놓쳐 TypeError 가 될 상태였다. `grep -v` 필터가 같은 줄의 실제 누락을 가린 것이 원인이었다.
5. **e2e 결과는 기준선과 대조해야 의미가 있다.** HEAD 에서 이미 17개가 실패한다. 절대 숫자로 판단하면 회귀를 놓치거나 없는 회귀를 만든다.
6. **e2e 를 반복 실행하면 PTY 가 고갈된다.** 수리 전에는 실행마다 데몬 1개 + 셸 ~73개가 누수되어 7회쯤에 `kern.tty.ptmx_max`(511)를 소진하고 `device not configured` 로 대부분의 테스트가 무너졌다(실측 80 실패/31 통과, 23분). `7fdca80` 에서 고쳤지만, 사용자의 실제 dongminal 세션(셸 20개)과 겹치면 여전히 여유가 크지 않다. 이상 결과가 나오면 먼저 `ps -eo tty | awk '$1 ~ /^ttys/' | sort -u | wc -l` 로 확인할 것.
7. **`e2e/fixtures.ts`** 가 매 테스트 전 미참조 도구를 회수한다. 이걸 제거하면 6번과 무관하게 도구 누적으로 무너진다.

## 7. 검증 방법

```bash
go build ./... && go test ./... -count=1     # 전체 통과
go vet ./...                                 # 무경고
gofmt -l internal/ cmd/                      # 0건
npx playwright test --reporter=list          # 115 통과 / 0 실패
```

e2e 가 이상하면(대량 실패·런타임 급증) 코드를 의심하기 전에 PTY 를 확인한다:

```bash
ps -eo tty | awk '$1 ~ /^ttys/' | sort -u | wc -l   # 상한 511
```

심볼 작업에는 `gopls` 가 필요하다. 이미 `~/go/bin/gopls` 에 있으나 PATH 에
없으면 LSP·Serena 가 못 쓴다 — `ln -sf ~/go/bin/gopls ~/.local/bin/gopls`.
Serena 는 MCP 프로세스 기동 시점의 PATH 를 쓰므로, 링크를 새로 걸었다면
세션을 다시 시작해야 인식한다.

실 데이터 마이그레이션 검증(사용자 홈을 건드리지 않는다):

```bash
SB=$(mktemp -d) && cp ~/.dongminal/workspace.json ~/.dongminal/panes.json "$SB"/
go build -o "$SB/dongminal" ./cmd/dongminal
DONGMINAL_HOME="$SB" "$SB/dongminal" migrate --dry-run
```
