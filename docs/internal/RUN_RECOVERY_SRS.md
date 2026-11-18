# SRS: 데몬이 죽은 뒤 Run 복구 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 실제 운영에서의 확인(사용자 몫 — 셸 판정을 쓰려면 데몬 교체 `dongminal start` 가 한 번 필요하다, NFR-RRC-3). 묶음 F·A·J·E·W 와 문서는 마쳤다
> **입력**: 2026-11-18 사용자 요청("run 복구 명령을 만들자", "run 에도 수정할게 좀 있어")과 인터뷰. 결정은 §5 에 있다.

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

데몬(`dongminald`)이 실제로 죽었다가 다시 뜨면, 탭의 도구는 같은 uuid 의 빈 셸로 돌아온다. 그 셸에서 돌던 Run 의 조정자와 멤버 에이전트는 사라진다. 이 문서는 그 에이전트를 **기록된 세션 id 로 재개**하는 명령과 화면 버튼을 정한다.

함께 Run 화면의 결함 두 가지를 고친다. 조정자가 트리 Run 에서 보이지 않는 것과, 승계로 물러난 멤버가 목록에 `lost` 로 남는 것이다.

### 1.2 범위 (Scope)

| 묶음 | 이름 | 요구 |
|---|---|---|
| **묶음 A** | 재개 선언 (Adapter) — 에이전트별 재개 인자 | `FR-RRC-1..4` |
| **묶음 J** | 판정 (Judge) — 재개 대상 고르기, 세션 생존과 셸 점유 판정 | `FR-RRC-10..17` |
| **묶음 E** | 실행 (Execute) — API·`dmctl run recover`·조정자 에이전트 기록 | `FR-RRC-20..28` |
| **묶음 W** | 화면 (Web) — Run 단위 버튼, 노드별 버튼 | `FR-RRC-30..35` |
| **묶음 F** | 결함 수정 (Fix) — 조정자 표시, 승계 멤버 상태 | `FR-RRC-40..46` |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 말 | 뜻 |
|---|---|
| **복구** | 빈 셸이 된 도구에 에이전트 재개 명령줄을 넣고 실행하는 일 |
| **대상** | 복구할 수 있는 자리. Run 의 조정자 하나와 멤버 각각이다 |
| **재개줄** | 셸에 넣는 한 줄. 예: `claude --resume <id> --allowedTools 'Bash(dmctl:*)'` |
| **세션 등록부** | 실행 중인 에이전트가 남기는 `pid → 세션 id` 기록. claude 는 `<설정 폴더>/sessions/<pid>.json` 이다(§2.4) |
| **셸 판정** | 도구 셸을 보고 내는 값. `here`(세션이 이 셸의 자손으로 돈다)·`elsewhere`(세션이 다른 곳에서 돈다)·`busy`(세션은 꺼졌고 셸에 다른 자식이 있다)·`idle`(셸이 비었다)·`unknown`(읽지 못함) 다섯이다 |
| **끝난 멤버** | 저장 상태가 `done`·`failed`·`released`·`succeeded` 인 멤버 |

### 1.4 참조 (References)

- `DAEMON_SESSION_KEEP_SRS` — 교체 중 세션 유지. 이 문서는 그것이 맡지 못하는 경우(데몬이 실제로 죽음, Windows)를 맡는다(D-DSK-1)
- `AGENT_RECORD_DAEMON_SRS` FR-ARD-3·4 — Run 의 열림은 저장하지 않고 생존으로 계산한다
- `RUN_INACTIVE_NODE_SRS` FR-RIN-10·11·21 — 끝난·잃은 노드와 카드
- `ISSUE_TREE_OPS_SRS` FR-ITC-6·11 — 트리 Run 의 화면
- `ORCHESTRATION_V2_SRS` FR-CBG-9·10 — 승계, `succeeded` 상태
- `RUN_ORCHESTRATION_SRS` FR-ADP-1·3 — 에이전트 등록부, `MemberArgs`

## 2. 현재 상태 (조사로 확정한 사실, 2026-11-18)

### 2.1 데몬이 죽었다가 다시 뜨면

- 새 데몬은 `tools.json` 으로 탭의 도구를 같은 uuid 의 빈 셸로 만든다(`toolhub/persist.go` `LoadAll`). 셸의 작업 폴더는 마지막 저장 때의 실제 cwd 다. 에이전트가 돌던 셸이면 에이전트를 띄운 폴더다.
- 열린 Run 의 헤드리스 멤버 도구도 빈 셸로 돌아온다(`runfile.HeadlessToolIDs`).
- 빈 셸이 살아 있으므로 Run 의 `liveness` 는 `open` 이다(FR-ARD-4). 에이전트는 없는데 Run 은 열린 것으로 보인다.

### 2.2 재개 재료

| 자리 | 세션 id | 에이전트 id |
|---|---|---|
| 멤버 | `Member.ContextState.SessionID` (`runs.json` `sessionId`) | `Member.Agent` |
| 조정자 | `Record.Coordinator.SessionID` | **기록하지 않는다.** 맥락 관측(`ContextObservation.Agent`)으로 오지만 저장하지 않는다 |

- 세션 id 는 맥락 관측 훅(`POST /api/runs/context`)과 statusLine 보고가 채운다(`store_context.go` `applyContextObservation`).
- Run 밖의 에이전트 탭은 세션 id 를 저장하지 않는다(FR-AGR-9). 이 문서의 범위 밖이다(§6).

### 2.3 에이전트 등록부

- `agentadapter.Adapter` 에 `Launch`·`MemberArgs`·`LaunchLine` 은 있고 재개 인자는 없다.
- 확인한 재개 방법(2026-11-18, 각 CLI 의 `--help`):
  - claude: `claude --resume <session-id>`
  - omp: `omp --resume=<value>` (ID 앞부분·경로도 받는다)
  - codex: 이 기계에 설치되지 않아 확인하지 못했다.

### 2.4 에이전트가 도는지 아는 근거

- **전경 이름**(`toolhub/foreground.go`)은 셸 이름이어도, 읽지 못해도 빈 문자열이다. "셸이 비었다"와 "모른다"를 가를 수 없다. Windows 는 `ForegroundPGID` 가 늘 실패한다(`pty_windows.go:315`).
- **셸의 자식 유무**(`busy`·`busymany`, `Tool.IsBusy`)는 세 OS 모두 답한다(macOS `ps`, Linux `/proc`, Windows 프로세스 스냅샷). 그러나 프로세스 목록을 읽지 못해도 "자식 없음"으로 답한다. 또 자식이 무엇인지는 모른다.
- **claude 의 세션 등록부**: 실행 중인 claude 는 `<설정 폴더>/sessions/<pid>.json` 을 남긴다. 안에 `pid`·`sessionId`·`cwd`·`status` 가 있다. 2026-11-18 이 기계에서 9개 모두 살아 있는 `claude` 프로세스였고, 끝난 세션의 대화 기록(`projects/*/*.jsonl`, 772개)과 다르다. 파일 이름이 pid 이므로 pid 가 재사용되면 새 claude 가 그 파일을 덮어쓴다. 계정 기능(FR-CAC-87 `PinnedRunning`)이 이미 같은 파일을 "pid 가 살아 있으면 실행 중"으로 읽는다. 비공개 형식이다.
- 설정 폴더는 기본 `~/.claude` 와 계정 프로필 폴더(`claudeacct` `ProfileDir`, `CLAUDE_CONFIG_DIR`)들이다.
- omp 의 등록부는 확인하지 못했다.

### 2.5 셸에 글 넣기

서버는 `deliverToTool(toolID, text, submit)` 한 문으로 도구에 글을 넣는다(`handlers_toolio.go`). `POST /api/tools/input` 이 이미 이 문을 연다. 그래서 같은 API 를 부를 수 있는 쪽은 이미 셸에 무엇이든 넣을 수 있다.

### 2.6 결함 1 — 트리 Run 에서 조정자가 보이지 않는다

- 조정자를 그리는 곳은 평평한 관계 그래프(`run-dashboard.js` `_runPaintNodes`) 하나뿐이다.
- 트리 Run 은 그 그래프를 숨긴다(`style-runs.css:148` `.run-view.tree-run .run-graph-wrap{display:none}`).
- 대신 보이는 트리 다이어그램(`/api/runs/tree` 의 노드)과 카드 목록(`runCardsShown`)은 멤버만 그린다.

### 2.7 결함 2 — 승계로 물러난 멤버가 `lost` 로 남는다

- 2026-11-18 운영 기록(`ccr#32` 트리 Run): 저장 상태 `succeeded` 28개가 화면에 `lost` 로 나온다.
- 서버의 상태 계산(`handlers_runs.go` `deriveMemberState`·`memberStateFrom`)과 트리 노드의 끝남 판정(`handlers_runs_tree.go` `treeEnded`)이 `done`·`failed`·`released` 만 끝난 상태로 본다. `succeeded` 가 빠졌다.
- 그래서 도구가 닫힌 승계 멤버는 `lost` 가 되고, 잃은 멤버를 남기는 규칙(FR-RIN-11)에 따라 카드 목록에 남는다.
- 화면의 끝남 판정(`run-tree.js` `RUN_TREE_ENDED`)에도 `succeeded` 가 없다.

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 재개 선언

**FR-RRC-1** `agentadapter.Adapter` 에 재개 인자 선언을 더한다. 세션 id 를 받아 기동 커맨드 뒤에 붙일 인자를 낸다. 선언이 없는(`nil`) 에이전트는 "재개 방법 미확인"이다.

**FR-RRC-2** claude 는 `--resume <id>`(인자 둘), omp 는 `--resume=<id>`(인자 하나)로 선언한다. codex 는 선언하지 않는다(D-RRC-4).

**FR-RRC-3** 재개줄은 다음 순서로 만든다. 인용은 `LaunchLine` 과 같이 `platform.ShellProvider` 가 한다.

1. `Launch`
2. 재개 인자
3. 대상이 멤버면 `MemberArgs`(자리 `{{dmHooks}}` 채우기 포함). 조정자면 넣지 않는다.

모델 인자와 프롬프트는 넣지 않는다. 재개한 세션이 이미 그것을 갖고 있다.

**FR-RRC-4** 세션 id 는 재개줄에 넣기 전에 형식을 검사한다. 허용은 `[A-Za-z0-9._-]`, 길이 1~128 이고, 첫 글자는 영문·숫자다 — `-` 로 시작하면 에이전트가 그 값을 옵션으로 읽는다. 어긋나면 그 대상을 `bad-session` 으로 건너뛴다. 세션 id 는 훅 보고에서 온 값이므로 명령줄에 그대로 믿고 넣지 않는다.

**FR-RRC-5** `agentadapter.Adapter` 에 세션 등록부 선언을 더한다. 세션 id 와 설정 폴더 목록을 받아, 그 세션을 기록한 pid 들을 낸다. 등록부를 읽지 못하면 "모름"을 낸다. 선언이 없는(`nil`) 에이전트는 등록부가 없다.

- claude: 각 설정 폴더의 `sessions/*.json` 을 읽어 `sessionId` 가 같은 파일의 `pid` 를 모은다. 폴더가 없으면 빈 목록이다(실행 중인 claude 가 없다). 폴더가 있는데 읽지 못하면 "모름"이다. 깨진 파일 하나는 건너뛴다.
- 설정 폴더 목록은 서버가 준다. 기본 `~/.claude` 와 계정 프로필 폴더 전부다.

### 3.2 묶음 J — 판정

**FR-RRC-10** 데몬은 셸 판정 요청(도구 id, 후보 pid 목록)에 답한다. 프로세스 목록(pid·부모 pid·이름)을 **한 번** 읽어 판정한다.

1. 목록을 읽지 못하면 `unknown` 이다. 도구가 없거나 셸 pid 를 모르면 `unknown` 이다. 목록에 셸 자신이 없어도 `unknown` 이다 — 목록이 비었거나 일부라서 그 목록으로는 아무것도 확인하지 못한다.
2. 후보 pid 가운데 목록에 있는 것을 "살아 있는 세션 pid"로 본다. 이름은 비교하지 않는다(D-RRC-11).
3. 살아 있는 세션 pid 가 셸 자신이거나 셸의 자손이면 `here` 다.
4. 살아 있는 세션 pid 가 있지만 셸의 자손이 아니면 `elsewhere` 다.
5. 셸에 자식이 있으면 `busy` 다.
6. 그 밖은 `idle` 이다.

프로세스 목록 읽기는 `internal/shared/platform` 안에 둔다(NFR-RRC-2). 판정은 그 목록 위의 순수 함수이며, 부모 고리가 있어도 끝나야 한다.

**FR-RRC-11** 대상마다 아래 순서로 판정하고, 처음 걸린 사유로 건너뛴다.

| 순서 | 조건 | 사유 |
|---|---|---|
| 1 | 멤버가 끝난 멤버다 | `ended` |
| 2 | 도구 id 가 없거나 도구가 확인된 죽음이다 | `no-tool` |
| 3 | 에이전트 id 가 없다(조정자의 옛 기록) | `no-agent` |
| 4 | 에이전트가 등록부에 없거나 재개 선언이 없다 | `no-resume` |
| 5 | 세션 id 가 없다 | `no-session` |
| 6 | 세션 id 형식이 어긋난다(FR-RRC-4) | `bad-session` |
| 7 | 이 도구에 재개줄을 넣은 지 15초가 지나지 않았다(FR-RRC-18) | `recovering` |
| 8 | 세션 등록부가 "모름"이거나 셸 판정이 `unknown` 이고, 강제가 아니다 | `unknown` |
| 9 | 셸 판정이 `here` 다 — 이 셸에서 이미 돈다 | `running-here` |
| 10 | 셸 판정이 `elsewhere` 다 — 다른 곳에서 돈다. 같은 세션을 둘 띄우지 않는다 | `running-elsewhere` |
| 11 | 셸 판정이 `busy` 다 | `busy` |

어디에도 걸리지 않으면 재개한다(`resumed`). 등록부가 없는 에이전트(omp)는 후보 pid 없이 판정하므로 9·10 이 나오지 않는다.

강제일 때 판정이 `unknown` 이면 9~11 을 볼 근거가 없으므로 재개한다.

**FR-RRC-12** Run 단위 복구는 조정자와 모든 멤버를 대상으로 삼는다. 조정자 도구가 없는 Run(`coordinatorToolId` 가 비었다)은 조정자를 대상에 넣지 않는다. `unknown` 은 건너뛴다(D-RRC-5). Run 단위 복구는 강제를 받지 않는다.

**FR-RRC-13** 대상 하나 복구(노드별)는 강제를 받는다. 강제면 순서 8 만 건너뛴다. 나머지는 강제여도 그대로 적용한다. 그래서 세션이 돈다고 확인되거나(`running-here`·`running-elsewhere`) 셸이 점유됐다고 확인된(`busy`) 경우에는 어떤 경우에도 넣지 않는다.

**FR-RRC-14** 열리지 않은 Run(`closed`·`aborted`)은 복구하지 않는다. 오류로 답한다.

**FR-RRC-15** 같은 대상을 다시 복구해도 안전해야 한다. 재개한 셸은 에이전트가 자식으로 돌므로 다음 판정이 `running-here`(등록부가 있을 때) 또는 `busy` 로 건너뛴다.

**FR-RRC-16** 대상들은 하나씩 차례로 처리한다. 한 대상의 실패는 다음 대상을 막지 않는다. 설정 폴더 목록(FR-RRC-5)은 요청마다 한 번 만든다.

**FR-RRC-18** 서버는 재개줄을 넣은 도구를 15초 동안 다시 넣지 않는다(순서 7). 자리는 판정 **전에** 잡고, 넣지 않았으면(건너뜀·실패) 푼다. 에이전트가 떠서 셸의 자식과 세션 등록부에 보이기 전에는 겹친 두 번째 요청도 셸을 비었다고 보기 때문이다. 자리는 서버 메모리에만 둔다.

**FR-RRC-17** 판정 결과는 대상마다 `{target, memberId?, toolId, agent, outcome, reason?}` 로 낸다. `target` 은 `coordinator` 또는 `member` 다. `outcome` 은 `resumed`·`skipped`·`failed`(넣기 실패) 셋이다.

### 3.3 묶음 E — 실행

**FR-RRC-20** `POST /api/runs/recover` 를 더한다. 본문은 `{runId, memberId?, coordinator?, force?}` 다.

- `memberId`·`coordinator` 둘 다 없으면 Run 단위 복구다(FR-RRC-12). 이때 `force` 를 주면 400 이다.
- `memberId` 를 주면 그 멤버 하나, `coordinator: true` 면 조정자 하나다. 둘을 함께 주면 400 이다.
- 응답은 `{runId, results: [...]}` 다(FR-RRC-17).

**FR-RRC-21** 재개줄은 `deliverToTool(toolID, line, true)` 로 넣는다. 다른 입력 경로를 새로 만들지 않는다.

**FR-RRC-22** 대상 하나 복구에서 결과가 `unknown` 이면 응답의 그 결과에 `needsForce: true` 를 싣는다. Run 단위 복구에는 싣지 않는다 — 강제를 받지 않기 때문이다. 호출자는 사람에게 확인을 받고 `force` 로 다시 부른다.

**FR-RRC-23** 복구가 끝나면 `run_changed` 를 방송한다(`broadcastRunChanged`). 재개한 대상이 하나도 없으면 방송하지 않는다.

**FR-RRC-24** `dmctl run recover --run <uuid> [--member <uuid> | --coordinator] [--force] [--json]` 을 더한다.

- 대상마다 한 줄을 낸다. 예: `member 01a1c99e  resumed` / `coordinator  skipped  busy`
- `--force` 는 `--member`·`--coordinator` 와 함께일 때만 받는다. 아니면 종료 코드 2 다.
- 결과에 `needsForce` 가 있으면 `--force` 로 다시 부르라고 stderr 에 안내한다.
- 재개한 대상이 하나 이상이면 종료 코드 0, 없으면 1 이다. 요청 오류(잘못된 인자, 서버의 거절, 서버에 닿지 못함)는 2 다.

**FR-RRC-25** 조정자의 에이전트 id 를 Run 기록에 저장한다. 맥락 관측이 조정자에게 앉을 때(`observeCoordinator`) 관측의 `Agent` 가 비어 있지 않으면 `Record.CoordinatorAgent`(`coordinatorAgent`, `omitempty`)에 적는다. 값이 바뀌면 저장한다.

**FR-RRC-26** 응답의 Run 보기(`/api/runs`·`/api/runs/{id}`)와 대시보드 응답(`/api/runs/{id}/graph`)에 화면이 버튼을 그릴 근거를 싣는다. Run 화면은 대시보드 응답으로 그리므로, 그 응답에 빠지면 버튼이 보이지 않는다. 멤버마다 `recoverable`(불리언)이다. 조정자는 Run 에 `coordinatorRecoverable` 로 싣는다. 판정은 FR-RRC-11 의 1~6 이다. 7~11 은 싣지 않는다 — 목록을 그릴 때마다 프로세스 목록을 읽지 않기 위해서다.

**FR-RRC-27** 이 API 는 다른 Run API 와 같은 인증을 따른다. 새 권한을 만들지 않는다(§2.5). 서버 로그에는 대상·결과·사유만 남기고 재개줄 본문은 남기지 않는다.

**FR-RRC-28** 오류 코드는 기존 Run 오류(`writeRunError`)를 쓴다. 새 코드가 필요하면 `go run ./scripts/gen-errors` 로 표를 다시 만든다.

### 3.4 묶음 W — 화면

**FR-RRC-30** Run 보기의 요약 줄에 "복구" 버튼을 둔다. 조정자 또는 멤버 중 하나라도 `recoverable` 이면 보인다. 누르면 Run 단위 복구(FR-RRC-12)를 부르고 결과를 토스트로 알린다(재개 n · 건너뜀 m).

**FR-RRC-31** 노드별 "복구" 버튼을 둔다. `recoverable` 인 대상의 다음 자리에 보인다.

- 카드 목록의 카드(조정자 카드 포함, FR-RRC-41)
- 트리 다이어그램의 노드(조정자 노드 포함, FR-RRC-40). 헤드리스 멤버 노드도 같다.

**FR-RRC-32** 노드별 버튼은 대상 하나 복구를 부른다. 결과가 `needsForce` 면 확인을 받는다. 확인은 「계속」 버튼이 달린 토스트다(`Toast.show` 의 `actions`). 문구는 "이 셸에 에이전트가 없는지 확인할 수 없습니다. 화면을 확인했으면 계속하세요." 이다. 「계속」을 누르면 `force` 로 다시 부른다.

**FR-RRC-33** 결과를 토스트로 알린다 — 재개·건너뜀·실패 수와 사유. 넣기 실패(`failed`)는 건너뜀과 따로 세고 사유 `failed` 로 보인다. 사유 문구는 i18n 키로 둔다(키는 리터럴로 쓴다).

**FR-RRC-34** 같은 대상의 복구는 응답이 오기 전까지 한 번만 나간다. 버튼·트리 단추·「계속」 모두 같다. 응답이 오면 풀린다.

**FR-RRC-35** 버튼은 기존 버튼 키트를 쓴다(`check-button-kit` 게이트).

### 3.5 묶음 F — 결함 수정

**FR-RRC-40** 트리 Run 의 트리 다이어그램은 맨 위에 조정자 노드를 둔다. 이 Run 의 최상위 노드들은 조정자 노드의 자식으로 이어 그린다. 트리는 같은 트리의 여러 Run(가지 Run)에 걸치므로, 다른 Run 의 최상위 노드는 루트로 둔다. 조정자 노드는 그 Run 의 조정자 관측(`coordinator`)을 멤버 노드와 같은 규칙으로 그린다(FR-RCX-8).

**FR-RRC-46** 대시보드 응답(`/api/runs/{id}/graph`)은 조정자 노드를 그릴 값을 싣는다.

- `coordinatorAgent`: 조정자의 에이전트 id 다(FR-RRC-25).
- `coordinator`: 조정자 관측 가운데 멤버 노드와 같은 다섯 값만 싣는다. `contextRatio`·`contextLevel`·`compactCount`·`contextTokens`·`contextLimit` 이다. `sessionId`·`contextBytes`·`contextAt`·`windowOfficial` 은 싣지 않는다(NFR-RVZ-3). 관측이 없으면 `coordinator` 를 싣지 않는다.
- Run id 는 `runId` 에 실린다. 화면은 이 응답의 Run id 를 `runId` 로 읽는다.

**FR-RRC-41** 카드 목록은 맨 앞에 조정자 카드를 둔다. 조정자 도구가 없는 Run(`coordinatorToolId` 가 비었다)은 조정자 노드와 카드를 그리지 않는다.

**FR-RRC-42** 서버의 멤버 상태 계산은 `succeeded` 를 끝난 상태로 본다. 저장 상태가 `succeeded` 면 생존·훅과 무관하게 `succeeded` 를 낸다.

**FR-RRC-43** 트리 노드의 끝남 판정(`treeEnded`)도 `succeeded` 를 끝난 상태로 본다.

**FR-RRC-44** 화면의 끝남 판정(`RUN_TREE_ENDED`)에 `succeeded` 를 더한다. 그래서 승계 멤버는 카드 목록에서 빠지고(FR-RIN-10), 트리에서는 끝난 노드 모양으로 남는다.

**FR-RRC-45** Run 의 미보고 수·생존(`liveness`) 계산은 바꾸지 않는다. 이미 `settled()` 가 `succeeded` 를 보고한 것으로 친다.

## 4. 비기능 요구와 시험

### 4.1 비기능

- **NFR-RRC-1** 시험은 임시 홈(`os.MkdirTemp`)과 빈 포트에서만 돈다. 시험 시작 때 그 홈이 `~/.dongminal` 아래가 아닌지 확인한다. 사용 중인 서버·데몬을 재시작·종료하지 않는다.
- **NFR-RRC-2** 이음매 게이트를 지킨다. 프로세스 목록 읽기와 부모 거슬러 오르기의 OS 차이는 `internal/shared/platform` 뒤에 둔다.
- **NFR-RRC-3** FR-RRC-10 은 데몬 코드를 바꾼다. 적용하려면 데몬 교체(`dongminal start`, 세션 유지)가 한 번 필요하다. 옛 데몬은 셸 판정 요청을 모르므로, 서버는 그때 판정을 `unknown` 으로 본다.
- **NFR-RRC-4** 새 API 경로는 `docs/external/api.md` 에, 새 dmctl 명령은 사용법(`dmctl run --help`)과 사용자 문서에 적는다.

### 4.2 시험

| 번호 | 대상 | 방법 | 기대 |
|---|---|---|---|
| TC-RRC-1 | FR-RRC-1·2·3 | 유닛(agentadapter) — 재개줄: claude 멤버·claude 조정자·omp 멤버(`{{dmHooks}}` 채움)·codex | 인자 순서와 인용이 맞다. codex 는 미확인 오류다. 조정자 줄에 `MemberArgs` 가 없다 |
| TC-RRC-2 | FR-RRC-4 | 유닛 — 세션 id: 정상·빈 값·`;`·`$( )`·공백·129자·`-` 로 시작 | 정상만 통과한다 |
| TC-RRC-3 | FR-RRC-10 | 유닛(platform·toolhub) — 프로세스 목록 읽기(OS 별 파싱)와 셸 판정: 목록 읽기 실패 / 세션 pid 가 손자 / 세션 pid 가 셸 자신 / 세션 pid 가 다른 가지 / 후보 pid 가 목록에 없음 + 셸 자식 있음 / 자식 없음 / 부모 고리 | `unknown`·`here`·`here`·`elsewhere`·`busy`·`idle`·끝남 |
| TC-RRC-15 | FR-RRC-5 | 유닛(agentadapter) — claude 등록부: 폴더 둘에서 같은 세션 pid 모으기, 폴더 없음, 깨진 파일, 읽기 실패 | pid 목록·빈 목록·건너뜀·모름 |
| TC-RRC-4 | FR-RRC-11·12·18 | 유닛(httpapi) — Run 단위 판정표: 사유 11가지를 하나씩 만든 대상 + 재개할 대상, 연달은 두 요청, 조정자 도구 없는 Run | 사유가 표 순서대로 나오고, 재개 대상에만 `deliverToTool` 이 한 번 불린다 |
| TC-RRC-5 | FR-RRC-13·22 | 유닛(httpapi) — 대상 하나: `unknown` 은 `needsForce`, `force` 면 재개, `busy`·`running-here`·`running-elsewhere` 는 `force` 여도 건너뜀 | 그렇다 |
| TC-RRC-6 | FR-RRC-14·20 | 유닛(httpapi) — 닫힌 Run, `memberId`+`coordinator`, Run 단위+`force` | 오류·400·400 |
| TC-RRC-7 | FR-RRC-23 | 유닛(httpapi) — 재개 하나 이상이면 `run_changed` 한 번, 없으면 0 번 | 그렇다 |
| TC-RRC-8 | FR-RRC-24 | 유닛(runtimebin) — 출력 줄·종료 코드 0/1/2·`--force` 단독 거절·`needsForce` 안내 | 그렇다 |
| TC-RRC-9 | FR-RRC-25 | 유닛(domain/run) — 조정자 관측의 `Agent` 가 `coordinatorAgent` 로 저장되고 다시 읽힌다. 빈 값은 덮지 않는다 | 그렇다 |
| TC-RRC-10 | FR-RRC-26 | 유닛(httpapi) — `recoverable`·`coordinatorRecoverable` 계산. Run 보기와 대시보드 응답 둘 다 | 판정 1~6 과 같다 |
| TC-RRC-11 | FR-RRC-30~34 | 단위(JS, run-dashboard) — 버튼 보이기 조건, 누름 중 막기, `needsForce` 확인 뒤 `force` 재호출 | 그렇다 |
| TC-RRC-12 | FR-RRC-40·41 | 단위(JS) — 트리 Run 의 다이어그램 맨 위와 카드 맨 앞에 조정자. 조정자 도구가 없으면 없다 | 그렇다 |
| TC-RRC-13 | FR-RRC-42·43 | 유닛(httpapi) — 저장 `succeeded` + 도구 죽음 → `succeeded`. 트리 노드 끝남 | 그렇다 (`lost` 가 아니다) |
| TC-RRC-14 | FR-RRC-44 | 단위(JS) — `succeeded` 카드가 목록에 없다 | 그렇다 |
| TC-RRC-16 | FR-RRC-46 | 유닛(httpapi) — 대시보드 응답의 조정자 관측: 다섯 값을 싣고 `sessionId`·`contextBytes` 는 싣지 않는다. 관측이 없으면 `coordinator` 가 없다 | 그렇다 |
| TC-RRC-17 | FR-RRC-30·46 | 단위(JS) — 대시보드 응답 모양(`runId`)으로 Run 단위 버튼을 그리고, 누르면 그 Run 으로 복구를 부른다 | 그렇다 |

## 5. 설계 결정 (Design Decisions)

**D-RRC-1 Run 복구만 한다. Run 밖 에이전트 탭의 상태 복원은 뒤에 한다.** Run 쪽 재개 재료(세션 id)는 이미 `runs.json` 에 있다. 재개줄 만들기(묶음 A)는 나중에 상태 복원이 그대로 쓴다. (사용자 결정, 2026-11-18)

**D-RRC-2 dmctl 명령과 웹 버튼 둘 다 둔다. 자동 복구는 하지 않는다.** 데몬 기동 때 자동으로 띄우면 사용자가 모르는 사이에 에이전트가 여럿 뜨고, 일부러 끝낸 경우와 가를 수 없다. (사용자 결정)

**D-RRC-3 Run 단위 복구는 필요한 것만 재개한다.** 조정자와 끝나지 않은 멤버 가운데 셸이 비고 세션 id 가 있는 것만 재개하고, 나머지는 사유와 함께 건너뛴다. 다시 불러도 안전하다. (사용자 결정)

**D-RRC-4 재개 선언은 확인한 claude·omp 만 둔다.** codex 는 이 기계에서 확인하지 못했다. `ExitCommand` 의 "미확인" 관례와 같다. (사용자 결정)

**D-RRC-5 판정 불가(`unknown`)는 Run 단위 복구에서 건너뛴다. 노드별 버튼과 `--member`·`--coordinator` 로 하나씩 복구하게 하고, 판정 불가면 확인을 받고 진행한다.** Windows 에서도 하나씩은 복구할 수 있다. (사용자 결정)

**D-RRC-6 트리 Run 의 조정자는 트리 맨 위 루트와 카드 목록 맨 앞에 둔다.** 평평한 그래프가 조정자를 맨 위에 두는 것과 같은 배치다. (사용자 결정)

**D-RRC-7 결함 두 가지는 이 문서에 함께 넣는다.** (사용자 결정)

**D-RRC-8 판정은 세션 생존과 셸 점유를 함께 본다.** 세션 등록부의 pid 가 이 셸의 자손인지로 "이 셸에서 이미 돈다"를, 다른 곳에 살아 있는지로 "같은 세션을 둘 띄우려 한다"를 가린다. 세션이 꺼져 있어도 셸에 다른 자식(vim 등)이 있으면 재개줄이 그 프로그램에 들어가므로 건너뛴다. 셸 자식 판정은 세 OS 모두 되므로 Windows 도 Run 단위 복구를 받는다. 전경 프로세스 판정은 쓰지 않는다 — Windows 에서 늘 실패하고 "비었다"와 "모른다"를 가르지 못한다(§2.4). (사용자 결정, 2026-11-18. 처음 SRS 의 전경 판정 안을 바꿨다)

**D-RRC-11 claude 의 세션 등록부(`sessions/<pid>.json`)를 쓴다.** 비공개 형식이지만 계정 기능이 이미 같은 파일을 읽는다(FR-CAC-87). 읽지 못하면 `unknown` 으로 두어 사람의 확인을 받는다. pid 가 살아 있으면 그 세션이 돈다고 본다. 시작 시각과 실행 파일 이름은 비교하지 않는다. npm 으로 설치한 claude 는 프로세스 이름이 `node` 라서 이름을 맞추면 살아 있는 세션을 꺼졌다고 오판하고, 같은 세션을 둘 띄우게 된다. 이름을 보지 않을 때의 오판은 강제 종료로 남은 파일의 pid 가 재사용된 경우뿐이고, 그때는 `running-elsewhere` 로 건너뛰는 안전한 쪽이다. (사용자 결정, 2026-11-18. 이름 비교는 구현 중 조정)

**D-RRC-9 조정자의 에이전트 id 는 새 필드로 둔다.** `ContextState` 에 넣으면 멤버에 임베드되어 `Member.Agent` 와 JSON 이름(`agent`)이 겹친다. 그래서 `Record.CoordinatorAgent` 로 둔다. 옛 기록은 값이 없으므로 다음 관측이 채울 때까지 조정자는 `no-agent` 로 건너뛴다.

**D-RRC-10 재개줄은 셸의 지금 작업 폴더에서 실행한다.** 되살아난 셸은 마지막 저장 때의 cwd 에서 시작하고, 그것은 에이전트를 띄운 폴더다(§2.1). `cd` 를 덧붙이지 않는다.

## 6. 비목표 (Non-goals)

- **상태 복원.** Run 밖 에이전트 탭의 재개. 도구마다 `{agent, sessionId}` 를 저장하는 일이 먼저다(D-RRC-1).
- **자동 복구.** 데몬·서버 기동 때 알아서 재개하지 않는다(D-RRC-2).
- **codex 재개.** 재개 방법을 확인한 뒤 선언만 더하면 된다(D-RRC-4).
- **사라진 도구 되살리기.** 도구 자체가 없으면(`no-tool`) 새 도구를 만들지 않는다. 헤드리스 멤버 도구는 데몬 기동이 이미 되살린다(§2.1).
- **화면 내용 복원.** 데몬이 죽으면 스크롤백은 사라진다. 재개한 에이전트가 자기 화면을 다시 그린다.

## 7. 위험 (Risks)

| 번호 | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | 에이전트가 도는 셸에 재개줄이 들어가 프롬프트로 전달된다 | MEDIUM | `running-here`·`busy` 는 강제여도 넣지 않는다. `unknown` 은 사람의 확인을 받는다(FR-RRC-13·32) |
| R-1a | `exec claude` 처럼 셸이 에이전트로 바뀐 경우, 셸 자식이 없고 세션 pid 가 셸 자신이다 | LOW | 세션 pid 가 셸 pid 와 같으면 `here` 로 본다(자손에 자기 자신을 포함한다) |
| R-1b | claude 가 등록부 형식을 바꾼다 | LOW | 읽지 못하면 `unknown` 이다. 셸 자식 판정은 그대로 남는다 |
| R-2 | 세션 id 를 통한 명령 주입 | MEDIUM | 형식 검사(FR-RRC-4)와 셸 인용(FR-RRC-3) 두 겹 |
| R-3 | 셸 cwd 가 에이전트를 띄운 폴더와 달라 재개가 "세션 없음"으로 실패한다 | LOW | 에이전트가 오류를 화면에 낸다. 사용자는 셸에서 직접 고칠 수 있다. 복구는 재개줄을 넣는 데까지 책임진다 |
| R-4 | 옛 데몬이 셸 판정 요청을 모른다 | LOW | `unknown` 으로 본다(NFR-RRC-3). 노드별 버튼으로는 복구할 수 있다 |
| R-5 | 조정자의 옛 기록에 에이전트 id 가 없다 | LOW | 다음 맥락 관측이 채운다(D-RRC-9) |

## 8. 변경 기록

- 2026-11-19 결함 수정. 이전 동작 → 새 동작(이유):
  - Run 단위 「빈 셸 복구」 버튼이 보이지 않았다 → 보인다. Run 화면은 `/graph` 응답으로 그리는데, 그 응답에 `recoverable`·`coordinatorRecoverable` 이 없었다(FR-RRC-26).
  - 화면이 Run id 를 `id` 로 읽어 `/graph` 응답에서 비었다. Run 단위 복구 요청에 Run id 가 없고, 조정자 노드가 자기 Run 의 최상위 노드와 이어지지 않았다 → `runId` 로 읽는다(FR-RRC-46).
  - 조정자 노드에 에이전트 id 와 컨텍스트 표기가 없었다 → `/graph` 가 `coordinatorAgent`·`coordinator`(다섯 값)를 싣는다(FR-RRC-46).
  - JS 시험이 실제 응답과 다른 모양(`id`)을 넣어 이 결함을 놓쳤다 → 실제 모양으로 고쳤다(TC-RRC-17).

- 2026-11-18 독립 리뷰 반영. 이전 동작 → 새 동작(이유):
  - 겹친 두 복구 요청이 같은 셸에 재개줄을 두 번 넣을 수 있었다 → 넣은 도구는 15초 동안 `recovering` 으로 건너뛴다(FR-RRC-18).
  - 프로세스 목록에 셸 자신이 없어도 `idle` 이었다 → `unknown` 이다(FR-RRC-10).
  - Run 단위 복구도 `needsForce` 를 실어 받지 않는 `--force` 를 안내했다 → 대상 하나에만 싣는다(FR-RRC-22).
  - 조정자 도구가 없는 Run 도 조정자를 `no-tool` 로 건너뛰었다 → 대상에 넣지 않는다(FR-RRC-12).
  - 서버가 거절해도 dmctl 이 1 로 끝났다 → 2 다(FR-RRC-24).
  - 트리 단추와 「계속」 은 응답 전에 다시 누를 수 있었다 → 대상마다 한 번만 나간다(FR-RRC-34).
  - 넣기 실패가 사유 없이 건너뜀으로 셌다 → 실패로 따로 센다(FR-RRC-33).
  - 가지 Run 화면에서 다른 Run 의 루트까지 조정자 밑에 붙었다 → 이 Run 의 루트만 붙인다(FR-RRC-40).
  - 설정 폴더 목록을 대상마다 만들었다 → 요청마다 한 번이다(FR-RRC-16). 목록은 `claudeacct.Service.ConfigDirs` 가 낸다.
  - 남긴 것: 셸 판정 IPC 는 대상마다 한 번이다. 판정 1~6 을 통과한 대상만 묻으므로 끝난 멤버가 많아도 늘지 않는다.
- 2026-11-18 구현 중 조정: 전경 판정 대신 세션 생존 + 셸 자식(D-RRC-8), 이름 비교 없음(D-RRC-11), 세션 id 첫 글자 영문·숫자(FR-RRC-4, 보안 검토), 확인은 토스트의 「계속」(FR-RRC-32).
- 2026-11-18 초안·승인.
