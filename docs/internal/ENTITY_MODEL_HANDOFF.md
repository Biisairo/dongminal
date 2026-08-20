# 인계: 엔티티 모델 재정비 (P1~P7 완료, P8 잔여)

작성 시점 커밋: `6572b9c`. 작업트리 청결.

## 1. 이 작업이 무엇인가

사용자 요구 3건에서 출발했다.

1. **구조·네이밍 재정비** — `session`/`pane`/`tab` 이 무엇을 지칭하는지 불명확
2. **백그라운드 동작** — tmux 처럼 탭을 닫아도 도구가 계속 돌게
3. **AI 오케스트레이션** — Orca ADE 수준으로 제대로

단일 진실 공급원은 **`docs/internal/ENTITY_MODEL_RESTRUCTURE_SRS.md`** (IEEE 29148, 370행).
요구 1·2 는 이 SRS 가 담당하고, 요구 3 은 후속 `RUN_ORCHESTRATION_SRS`(미작성)로 분리했다.

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
| **Tool** | 탭에 탑재되는 실체 (`terminal`\|`editor`\|`markdown`) | `pane`(PTY)/`paneId` |
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
| **P8** | **문서·스킬 어휘 최종 스윕** | — | **잔여** |

## 4. 다음 세션이 할 일

### 4.1 P8 — 문서·스킬 어휘 최종 스윕 (유일한 잔여 단계)

기계적 치환과 한국어 산문은 이미 했다. **남은 것은 P5·P6 에서 새로 생긴 심볼·계약의 반영**이다.

확인 명령:

```bash
grep -rn 'PaneManager\|PaneHub\|PaneClient\|paneId\|list_panes\|new-session\|/api/panes\|DONGMINAL_PANE_ID' \
  docs/external/ docs/internal/architecture.md README.md skills/
```

반영해야 할 것:

- `PaneManager` → `ToolManager` 등 P5 의 새 심볼 (`docs/internal/architecture.md`, `README.md` 의 패키지 구조·핫패스 설명)
- P6 신규 표면: `detach` CLI, `GET/POST /api/tools/background*`, 상태바 배지, `DONGMINAL_TOOL_ID`
- 파일명 변경: `internal/server/tool.go`·`tool_client.go`, `internal/adapters/tool.go`, `internal/mcptool/tools/{listworkspace,readtool}.go`, `internal/runtimebin/dmctl_listworkspace.go`
- 신규 패키지: `internal/migrate`, `internal/run`
- `skills/dongminal-team`·`dongminal-workflow` — MCP 툴명·dmctl·좌표계가 전부 바뀌었으므로 **실행 불가 상태일 가능성이 높다**. 스킬 재작성은 요구 3(후속 SRS)과 겹치므로, P8 에서는 어휘만 맞추고 토폴로지 재설계는 후속으로 남기는 것을 권장한다.

**손대지 말 것**: `docs/internal/*_SRS.md` 의 과거 스펙들(`PANE_ATTENTION_NOTIFY_SRS` 등)은 완료된 작업의 기록이다. 당시 어휘를 그대로 둔다.

### 4.2 사용자 인스턴스 업그레이드 (사용자가 "모든 작업 완료 후" 하기로 함)

현재 `~/.dongminal` 은 **v1 그대로**이고 구 바이너리가 돌고 있어 정상이다. 순서를 반드시 지켜야 한다.

```bash
./scripts/stop.sh --all          # 데몬까지 완전 정지 (필수)
dongminal migrate --dry-run      # 변환 내용 확인
dongminal migrate                # 실행 (*.v1.bak 백업 자동)
./scripts/start.sh
```

- 정지하지 않으면 `ErrDaemonRunning` 으로 거부된다 — 살아있는 데몬이 `SaveAll` 로 `tools.json` 을 되살려 산출물을 덮어쓰기 때문이다.
- 마이그레이션 없이 새 바이너리를 띄우면 `schemaVersion` 게이트가 안내를 출력하고 종료한다.
- 마이그레이션은 `workspace.json`(v2 스키마) + `panes.json`→`tools.json`(고아 폐기) + `settings.json`(단축키 id·레이아웃 프리셋)을 한 번에 처리하며 멱등하다.

### 4.3 요구 3 — 오케스트레이션 (후속 SRS 신규 작성)

`RUN_ORCHESTRATION_SRS` 를 새로 써야 한다. 조사 결론은 SRS §7 에 있다.

**사용자 결정**: "Orca 의 장점을 최대한 모방. 동작뿐 아니라 **실제 구현(MIT 공개 소스)도 참고**."

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
| e2e 실패 17개 | **기존 실패** (HEAD 기준선과 동일 집합) | 원인 미조사. `layout.spec.ts` 388/410/432 는 런마다 통과/실패가 오간다 |
| `paned` 어휘 | 의도적 유지 | 데몬 프로세스·`paned.sock`·`paned.pid` 는 `scripts/*.sh` 와 실행 중 인스턴스의 계약. SRS 개명 목록에 없다 |
| `delSession` 의 editor 미저장 확인 부재 | 기존 결함 | SRS 비목표에 명시 |
| 원격 `closeWindow` 무인 백그라운드 인자 | 미도입 | Run 이 Window 를 정리하는 시나리오는 후속 SRS |
| 도구를 다른 탭·Pane·Window 로 이동 | 미도입 | 1급화가 가능하게 만들었지만 기능은 추가하지 않았다 (SRS 비목표) |
| gofmt 미준수 2개 (`handlers_ws.go`, `paned.go`) | 기존 상태 | HEAD 에서 9개였고 만진 파일만 정리해 2개로 줄었다 |

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
go build ./... && go test ./... -count=1     # 전체 통과해야 한다
npx playwright test --reporter=list          # 17 실패 / 94 통과 (기준선과 동일 집합)
gofmt -l internal/ cmd/                      # handlers_ws.go, paned.go 2개만 (기존)
```

실 데이터 마이그레이션 검증(사용자 홈을 건드리지 않는다):

```bash
SB=$(mktemp -d) && cp ~/.dongminal/workspace.json ~/.dongminal/panes.json "$SB"/
go build -o "$SB/dongminal" ./cmd/dongminal
DONGMINAL_HOME="$SB" "$SB/dongminal" migrate --dry-run
```
