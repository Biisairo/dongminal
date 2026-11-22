# 인수인계 — WS-4 (패턴 카탈로그 + P2P 봉인 해제)

> 조정자 세션 종료 시점의 상태. 근거 SRS 는 `ORCHESTRATION_V2_SRS.md` §3.4(묶음 P).
> **커밋하지 않았다.** 모든 변경이 워킹 트리에 있다.

## 0. 한 줄 상태

묶음 P 는 **완료·승인**됐다. 남은 것은 **헤드리스 스킬 문안 반영 하나**이며, 그것을
막고 있던 CLI 4건은 **방금 해소됐다** — 다음 세션이 바로 이어받으면 된다 (§3).

---

## 1. 모델 문서 재작성 (`references/models_and_patterns.md`)

### 왜 다시 썼나

1차로 모델명만 최신화했으나(Opus 5 / Sonnet 5 / Haiku 4.5 / Fable 5), 사용자가 더
근본적인 문제를 지적했다 — **이 스킬은 claude 전용이 아닌데 모델 가이드만 claude 에
종속돼 있었다.** 구체 모델명을 표의 주역으로 두는 것 자체가 잘못이다. 낡을 뿐 아니라
`--agent codex` 인 팀에는 아예 적용되지 않는다.

### 바뀐 구조

| 절 | 내용 |
|---|---|
| **본체 — 급으로 고른다** | 상/중/경량 표. 각 급이 **어떤 자리에 왜** 가는지. 에이전트·세대 무관 |
| 모델을 지목하는 경로 | `dmctl run launch --model` 스니펫 + **ModelFlag 계약 표** |
| `--agent claude` 일 때의 값 | Claude 모델표를 **예시로 격하**. 급 열을 앞에 붙여 본체와 연결 |
| 에이전트가 늘어나면 | `agentadapter` 레지스트리가 진실 |

유지한 판단 기준(세대 무관): 비용·지연, 전원 같은 급도 정상, 팀장은 현재 모델 유지.

### codex 경고를 넣은 위치

**"모델을 지목하는 경로" 절, ModelFlag 표 바로 아래의 인용 블록**이다.

```
| `--agent` | 모델 플래그 | `--model` 을 주면 |
| claude | --model | 기동줄에 실린다 |
| codex  | 없음(확인되지 않았다) | 조용히 생략된다 |

> ⚠️ 모델 플래그가 없는 에이전트에서는 `--model` 이 조용히 생략된다. 오류가 나지
> 않는다 — 조정자는 모델을 지정했다고 믿는데 실제로는 그 에이전트의 기본 모델이
> 돈다. 급을 나눠 배분하는 설계가 그 멤버에서만 무효가 되므로, 모델 지정이 결과에
> 중요한 역할은 모델 플래그가 확인된 에이전트에 준다.
```

마지막 문장은 SRS·조정자 지시에 없던 것을 더한 것이다. **"조용히 무시된다" 만 적으면
조정자가 알고도 대응을 모른다** — 실제 대응은 "어느 멤버에 어떤 에이전트를 주는가"
이므로 거기까지 적었다.

### 근거 코드 (이 문서가 옮겨 적은 것)

| 위치 | 사실 |
|---|---|
| `agentadapter/adapter.go:169` | `if model != "" && a.ModelFlag != ""` — 이 게이트가 전부다 |
| `agentadapter/claude.go:13` | `ModelFlag: "--model"` |
| `agentadapter/codex.go:22` | `ModelFlag: ""` — 주석 *"미확인 — 지정되면 조용히 생략된다"* |
| `agentadapter/adapter.go:133` | `registry` = `claude`, `codex` 둘 |

**어댑터가 늘거나 codex 의 모델 플래그가 확인되면 이 문서의 표 두 개를 고쳐야 한다.**
문서에 "어긋나면 레지스트리가 맞고 이 문서가 틀린 것" 이라고 적어 두었다.

---

## 2. 파일명 개명 — **하지 않았다**

`models.md` 가 맞는 이름이다(패턴 절이 빠져 모델 가이드만 남았으므로). 그럼에도 두지
않은 이유는 **SRS 가 이 파일명을 못 박고 있어서**다.

| 고쳐야 할 자리 | 내용 |
|---|---|
| `skills/team/SKILL.md:328` | "더 깊이 읽을 때" 목록의 참조 |
| `ORCHESTRATION_V2_SRS.md` FR-PAT-10 | 본문이 파일명을 지목 |
| `ORCHESTRATION_V2_SRS.md` **V-PAT-2** | 검증 항목이 파일명을 지목 — **이미 서명된 검증 ID** |

V-PAT-2 는 조정자가 통과 서명한 항목이라, 개명하면 그 항목이 문언 그대로는 돌지
않는다. **SRS 두 줄은 WS-4 소유가 아니다.** 개명하려면 SRS 개정과 같은 커밋이어야
한다. `docs/internal/archive/` 의 옛 SRS 두 건은 역사 기록이므로 건드리지 않는다.

**권고**: 헤드리스 문안 반영과 함께 한 번에 처리. 그때 SRS 두 줄은 조정자가 고친다.

---

## 3. 헤드리스 스킬 문안 — **반영 대기, 지금 바로 가능**

### 상태: 막힌 것이 없다

WS-2 가 넘긴 FR-HLM-10/11/12 문안은 CLI 4건에 의존했고 **넷 다 해소됐다.**
판정 스크립트를 아래에 옮겨 둔다 (scratchpad 는 세션과 함께 사라진다).

```bash
#!/bin/bash
# WS-2 의 CLI 4건이 열렸는지 판정한다. 스킬 문안이 없는 명령을 가리키지 않게
# 하는 것이 목적이므로, 서버가 아니라 **CLI 표면**만 본다.
cd /Users/dykim/personal/dongminal || exit 1
rc=0
chk() { if eval "$2"; then echo "ok    $1"; else echo "BLOCK $1"; rc=1; fi; }

chk "run member --headless 배선" \
    "sed -n '/func runSubMember/,/^}/p' internal/helper/runtimebin/dmctl_run.go | grep -q 'f\.headless'"
chk "wait --member" \
    "grep -q '\-\-member' internal/helper/runtimebin/dmctl_status.go"
chk "run close --keep-tools 파싱" \
    "grep -q 'keep-tools' internal/helper/runtimebin/dmctl_run.go"
chk "run status 고아 목록 렌더" \
    "grep -qi 'orphan\|고아' internal/helper/runtimebin/dmctl_run.go"

# FR-HLM-3: SaveAll 이 **소유자 있는** 백그라운드 도구에 예외를 내는가.
# `IsBackground` 유무로 보면 안 된다 — FR-BG-9 스킵은 그대로 남아 있어야 옳고,
# 판정 대상은 그 안의 예외다.
chk "FR-HLM-3 (SaveAll 의 소유 도구 예외)" \
    "sed -n '/func.*SaveAll/,/^}/p' internal/shared/toolhub/tool.go | grep -q 'owned\['"

[ $rc -eq 0 ] && echo "=> 반영 가능" || echo "=> 반영 보류"
exit $rc
```

**세션 종료 시점 실행 결과: 5건 전부 `ok`, `=> 반영 가능`.**

> **판정식을 한 번 고쳤다.** 처음에는 `SaveAll` 안에 `IsBackground` 가 있으면
> "미구현" 으로 봤는데, WS-2 가 그 스킵을 **지우지 않고 예외를 낸** 것이 옳은 구현이라
> 그대로면 영원히 오탐이다. 지금은 예외(`owned[...]`)의 존재를 본다.

> **이 스크립트를 왜 만들었나.** WS-2 는 막힌 것을 2개로 셌지만 실제로는 4개였다.
> `--keep-tools` 와 고아 목록은 **서버 구현·테스트가 전부 통과하는데 CLI 렌더가 없어
> 사용자는 쓸 수 없는 상태**였다. 서버 테스트로는 안 잡히는 자리다. 문서를 검증하다
> 발견했고, 다시 놓치지 않으려고 자동화했다.

### 3.1 왜 아직 반영하지 않았나

조정자가 세션을 좁히며 "다음 세션에 넘긴다" 고 명시했다. 그 시점의 이유(WS-2 미완)는
그 뒤 해소됐지만, **세션 범위를 정하는 것은 조정자의 판단**이라 지시를 넘기지 않았다.
문안·검증은 전부 끝나 있으므로 **다음 사람은 붙여넣고 검증만 돌리면 된다.**

### 3.2 반영할 문안 (검증 완료 초안)

WS-2 원문에서 **세 가지를 바꾼** 최종본이다. 셸 블록 3개는 이미 `bash -n` 통과,
좌표 라벨 0건, 재시작 생존 문장 0건을 확인했다.

바꾼 것:
1. 능력 동등성 표에 **멤버→멤버 행 추가** (원문은 조정자→멤버만 다뤘다). WS-2 동의함
2. §3.3 에 **`run peers` 의 `state` 불변** 한 줄 추가. WS-2 가 store·HTTP 두 계층에서
   구조체 전체 비교로 고정해 뒀다 — `Attach`/`Detach` 는 `TabID`·`Headless` 외에는
   멤버 레코드를 건드리지 않는다
3. `wait` 행에 **`--at` 과 배타(rc=2)** 명시 — WS-2 정정
4. attach/detach 의 **브라우저 요구를 비대칭으로 명시** — WS-2 정정. 헤드리스는 화면
   없이 도는데 부착만 화면을 요구한다
5. FR-HLM-3 은 (G) 로 분리 (§3.3) — 세션 후반에 구현됐고, 문장을 정확히 써야 한다

#### (A) `SKILL.md` §3 "Run 열고 멤버 등록" **바로 뒤**에 삽입

```markdown
### 3.2 화면에 붙일까, 헤드리스로 둘까

**기본은 탭 부착이다.** 사람이 팀 활동을 지켜보는 것이 이 제품의 이점이므로, 전용 창 + 분할 + 탭이 기본 배치다. 헤드리스는 그 이점을 포기하는 선택이며, 포기할 이유가 있을 때만 쓴다.

| 이렇게 생겼으면 | 배치 |
|---|---|
| 멤버 4명 이하, 진행을 보고 싶다 | **탭 부착** (기본) — `--at "$T1"` |
| 멤버가 4명을 넘어 분할이 읽을 수 없다 | 헤드리스 — `--headless` |
| 팬아웃 멤버처럼 개별 화면을 볼 이유가 없다 | 헤드리스 |
| 승계로 잠깐 살아있는 인수인계 전용 멤버 | 헤드리스 |

​```bash
dmctl run member --run "$RUN" --role "수집-3" --agent claude --headless --brief - <<'B'
<혼자 시작할 수 있는 일>
B
​```

`--at` 과 `--headless` 는 **배타이며 정확히 하나**여야 한다. 둘 다 주거나 둘 다 빼면 오류다.

헤드리스 멤버는 탭을 점유하지 않는다. 대신:

- **cwd 는 서버가 정한다** — 격리 Run 이면 그 멤버의 worktree, 아니면 조정자의 cwd 다. 헤드리스 멤버에게는 `cd` 를 대신 쳐 줄 사람이 없으므로, 탭 부착 멤버와 달리 기동 전에 작업 디렉터리로 보내는 절차가 **없다** (3.5 의 `send-input ... cd` 는 헤드리스에 필요 없다)
- 상단바 `⏻` 배지·모달에 **함께 보인다**. 그 행에 Run·역할이 붙어 있어 사용자가 "떼어 둔 내 도구" 와 구분할 수 있다
- 워크스페이스 탭 수는 변하지 않는다 — 사용자의 화면을 침범하지 않는다

**능력은 탭 부착 멤버와 동등하다.** 관측·제어·협업 어느 쪽에도 차이를 만들지 않는다:

| 하고 싶은 것 | 헤드리스 멤버에게도 |
|---|---|
| 준비완료 대기 | `dmctl wait --member "$M" --for ready` (`--at` 과 배타 — 둘 다 주면 rc=2) |
| 지시 보내기 | `dmctl msg --to "$TOOL" -` |
| 상태 보기 | `dmctl status --at "$TOOL"` |
| 막혔을 때 진단 | `dmctl read-screen --at "$TOOL"` |
| **동료가 직접 말 걸기** | `dmctl run peers` 에 `headless=true` 로 나오고, 그 `to=` 로 그대로 도달한다 |

`$TOOL` 은 `run member` 출력의 `toolId=` 이며 `run peers` 의 `to=` 와 같은 값이다. 출력 버퍼는 화면 부착 여부와 무관하므로 `read-screen` 이 그대로 동작한다 — **헤드리스 멤버가 막혔을 때 진단할 유일한 길이므로 막지 않는다.**

마지막 행이 뜻하는 것: **헤드리스는 P2P 를 막지 않는다.** 카탈로그의 6개 P2P 패턴 어디서든 멤버를 헤드리스로 둘 수 있다.

### 3.3 잠깐 들여다보기 — attach / detach

헤드리스 멤버를 지금 눈으로 봐야 하면 탭에 붙였다가 되돌린다.

​```bash
dmctl run attach --member "$M"              # 현재 포커스 분할 칸에 새 탭
dmctl run attach --member "$M" --at "$TAB"  # 그 탭이 속한 분할 칸에
dmctl run detach --member "$M"              # 탭을 닫고 백그라운드로
​```

**부착·분리는 멤버의 상태를 바꾸지 않는다.** `state`·`outcome`·컨텍스트 관측·보고 계약 전부 그대로다 — 화면 결속은 관찰 수단일 뿐이고, 관찰 행위가 관찰 대상을 바꾸지 않는다. `detach` 로 에이전트 프로세스가 죽지도 않는다.

동료가 보는 값도 그대로다 — `dmctl run peers` 의 `state` 는 도구 생존과 활동에서 파생하므로 부착 여부와 무관하다. 조정자가 들여다보는 동안 동료의 판단이 흔들리지 않는다.

**attach·detach 는 구독 중인 브라우저가 있어야 한다. 창이 없으면 거부된다(rc≠0).** 헤드리스는 화면 없이 도는 것이 요점인데 **부착만은 화면을 요구한다** — 이 비대칭을 모르면 창 없는 상황에서 attach 를 걸고 막힌다.
```

#### (B) "도구 요약" 표에 3행 (기존 `dmctl wait` 행 뒤)

```markdown
| `dmctl run attach --member <uuid> [--at <uuid>]` | 헤드리스 멤버를 탭에 붙여 들여다본다 |
| `dmctl run detach --member <uuid>` | 탭을 닫고 도구는 살려 둔다 |
| `dmctl wait --member <uuid> --for ready\|done` | 헤드리스 멤버의 상태 대기 (`--at` 의 짝) |
```

#### (C) "패턴 선택" 표 아래 한 줄

```markdown
> **헤드리스는 패턴이 아니라 배치다.** 어느 패턴이든 멤버를 화면에 붙일지 말지는 따로 정한다 (§3.2).
```

#### (D) §5 Barrier — 기존 `for` 루프 아래

```markdown
헤드리스 멤버는 탭 uuid 가 없으므로 `--member` 로 부른다. 판정 근거는 같다(훅 상태) — 화면 스크래핑에 의존하지 않으므로 헤드리스에서도 그대로 성립한다.

​```bash
for m in "$M1" "$M2"; do dmctl wait --member "$m" --for ready --timeout-ms 180000; done
​```
```

#### (E) §8 팀 해체 — `/exit` → `close-tab` 문단 뒤

```markdown
헤드리스 멤버의 도구는 **`dmctl run close` 가 닫는다.** 닫을 탭이 없으므로 Run 이 소유권을 갖기 때문이다 — 탭 부착 멤버처럼 `/exit` → `close-tab` 을 칠 필요가 없다. 화면에 붙어 있는 도구는 close 가 건드리지 않는다.

남기려면 `--keep-tools`. 남긴 것은 이후 `dmctl run status` 의 **고아 목록**에 계속 나온다 — 조용히 남는 자원이 없어야 하기 때문이고, worktree 잔여물과 같은 규약이다.
```

#### (F) 체크리스트 5번 교체

```markdown
5. [ ] 팀원마다 `dmctl run member ... --at <탭> | --headless` → member uuid. **brief 하나에 관심사 하나**, `--at`/`--headless` 는 정확히 하나
```

### 3.3 FR-HLM-3 (재시작 생존) — **구현됐다. 다만 문장을 정확히 써라**

세션 후반에 WS-2 가 구현했고 코드로 확인했다. **초안 §3.2 에는 이 절이 없으므로
(G) 로 더해야 한다** — 넣을지는 반영하는 사람의 판단이다. 안 넣어도 문안은 성립한다.

**참인 것과 거짓인 것이 갈린다.** "재시작을 넘겨 멤버가 계속 일한다" 는 **거짓**이다.

- 헤드리스 도구는 `tools.json` 에 기록되고 재시작 후 되살아난다
- 되살아난 것은 **빈 셸**이다. 그 안에서 돌던 에이전트는 돌아오지 않는다
- Run 은 재시작으로 `aborted` 가 된다 (FR-RUN-5, 묶음 H 와 무관한 기존 규칙)
- 그래서 그 도구는 `run status` 의 고아 목록에 나타나고 `run close --force` 로 거둬진다

즉 **FR-HLM-3 이 사는 것은 작업의 연속성이 아니라 정리 가능성**이다. 기록하지 않으면
재시작 후 도구가 사라져 거둘 대상조차 없어진다.

#### (G) §3.2 끝에 더할 문단 (선택)

```markdown
데몬을 재시작하면 헤드리스 멤버의 도구는 되살아나지만 **그 안의 에이전트는 돌아오지 않는다.** Run 도 재시작으로 aborted 가 된다. 되살리는 이유는 작업을 잇기 위해서가 아니라 **거둘 수 있게 하기 위해서**다 — `dmctl run status` 의 고아 목록에 나타나고 `dmctl run close --run <uuid> --force` 로 정리한다.
```

#### 구현 형태 — 되돌리지 마라

FR-BG-9 와 정면으로 부딪히는 자리였고, WS-2 는 **스킵을 지우지 않고 예외를 냈다.**
`SaveAll` 의 현재 주석이 그 논리다:

> FR-HLM-3 이 그 규칙에 **예외 하나**를 낸다. 규칙이 사라지는 것이 아니다 — 위 근거의
> 핵심은 그 도구에 **소유자가 없다**는 것이고, 그래서 되살아나도 아무도 거둘 수 없다.
> 헤드리스 멤버의 도구는 Run 이 소유하며, 소유자가 있으면 되살아난 뒤에도 고아 목록과
> `run close` 가 그것을 거둘 수 있다.

증거는 테스트 **세 개가 함께 통과**하는 것이다 (`httpapi/background_test.go`):

| 테스트 | 지키는 것 |
|---|---|
| `TestSaveAll_ExcludesBackgroundTools` | FR-BG-9 원 규칙 (**고치지 않았다**) |
| `TestSaveAll_KeepsOwnedBackgroundTools` | FR-HLM-3 예외 |
| `TestSaveAll_NoOwnerProbeKeepsLegacyBehavior` | 소유 조회가 없을 때 기존 동작 |

첫 번째를 **고쳐야만 통과하는 구조가 나오면 예외가 아니라 정책 교체라는 신호다.**
그때는 멈추고 재판정을 받아라 (조정자 지시).

---

## 4. 검증 결과 (세션 종료 시점)

### Go

```
go build ./...   통과
go vet ./...     통과
go test ./...    25개 패키지 전량 통과 · 실패 0
```

**내 범위 밖 실패 없음.** 세션 중반에 `TestPanedServerListenAccept`(daemon/ipc),
`TestApiToolKill_SigtermThenKillAfterGrace`, `TestSaveAll_ExcludesBackgroundTools`,
`TestToolClientForegroundNameOverIPC` 가 실패했으나 전부 CNV 묶음 N·X 의 진행 중
변경이었고 해당 워크스트림이 해결했다.

### 묶음 P 검증표

| ID | 결과 |
|---|---|
| V-PAT-1 | `patterns.md` 9/9 + `models_and_patterns.md` 1/1 `bash -n` 통과 |
| V-PAT-1 (확장) | 스킬 전체 좌표 라벨 **0건** (남은 2건은 "쓰지 마라" 금지문 자체) |
| V-PAT-2 | 패턴 카탈로그 잔재 **0건** |
| V-PAT-3 | 결정표 8패턴이 카탈로그에 **8/8** |
| V-PAT-5 | 세 항목을 전부 가진 P2P 패턴 **6종** (요구 5) |
| V-PAT-7 / V-PAT-8 | 자동 테스트로 고정 (`handlers_runs_peers_test.go`) |
| V-CBG-7 | 자동 테스트로 고정 (`preamble_test.go`) |
| **V-PAT-4 / V-PAT-6** | **미실행** — 실제 Run 이 필요하고 e2e 가 금지 범위였다 |

**재실행 방법** (V-PAT-1):

```bash
# ```bash 블록을 뽑아 bash -n 을 건다
awk '/^```bash$/{n++; f="/tmp/snip-"n".sh"; b=1; next} /^```$/{b=0} b{print > f}' \
    internal/shared/runtime/agentplugin/skills/team/references/patterns.md
for s in /tmp/snip-*.sh; do bash -n "$s" || echo "FAIL $s"; done
```

---

## 5. 남은 것 · 다음 사람이 알아야 할 것

### 5.1 즉시 가능

1. **헤드리스 문안 반영** (§3). 막힌 것 없음. 붙여넣고 V-PAT-1 + 좌표 라벨 + `go test`
2. **`models.md` 개명** (§2). SRS 두 줄을 함께 고쳐야 하므로 조정자 참여 필요

### 5.2 다른 워크스트림에 걸린 것

- **V-PAT-6 은 묶음 V(WS-5) 이후에야 기계 검증된다.** FR-PAT-9 가 "P2P 를 안전하게 열
  수 있는 근거" 로 드는 메시지 로그가 **자리는 있으나 아직 비어 있다** —
  `run.Record.Messages []MsgEvent` 는 존재하지만 채우는 주체(WS-5)가 아직이다.
  `evals/test-scenarios.md` 시나리오 4·5·6 의 "메시지 기록에 멤버→멤버 간선" 체크가
  전부 여기에 걸린다
- **`Member.MsgSent`/`MsgRecv` 는 없다.** SRS 에 없어 의도적으로 뺐고, 건수는
  `Record.Messages` 집계로 낸다

### 5.3 검증되지 않은 채 남은 것

**"실제 에이전트가 그렇게 행동하는가."** 프리앰블에 `dmctl run peers` 가 있다는 것과
멤버가 그것을 부른다는 것은 다른 문제다. `PARALLEL_DELIVERY_PLAN` §7.3 의 수동 실사
**M-6**(debate Run 에서 멤버끼리 직접 대화가 실제로 일어나는지)이 그 자리다.

### 5.4 SRS 결함 3건 — 전부 조정자가 정정 완료

기록으로 남긴다. 셋 다 §3.4.1(P2P)에서 나왔다.

| # | 내용 | 처리 |
|---|---|---|
| 1 | **FR-PAT-6 의 `dmctl msg --to <member uuid>` 는 해석되지 않는다.** `msg` 는 `workspace.ResolveStrict` 를 지나고 그것이 받는 것은 살아있는 toolId 와 공간 엔티티 uuid 뿐이다. member uuid 는 Run 도메인 id 라 둘 다 아니다 — **그대로 구현했으면 P2P 가 안 열렸다** | `run peers` 가 `to=<toolId>` 를 병기하는 것으로 해소. SRS 개정됨. 정석(`msg` 가 member uuid 해석)을 안 택한 이유는 **`workspace` 가 Run 도메인을 알면 의존 방향이 뒤집히기 때문** |
| 2 | FR-PAT-2 본문 "5개" vs 표 "6개" | 본문을 6으로 정정. 카탈로그는 6개 전부에 세 항목을 넣어 어느 해석이든 통과 |
| 3 | FR-PAT-9 의 관측이 비어 있음 | FR-PAT-9 에 그 구간과 검증 방법을 명문화. WS-5 최우선 |

---

## 6. 이 워크스트림이 건드린 파일 전부

**커밋하지 않았다.**

### Go

| 파일 | 내용 |
|---|---|
| `internal/webserver/httpapi/handlers_runs_peers.go` | `GET /api/runs/peers` 구현 (FR-PAT-5) |
| `internal/webserver/httpapi/handlers_runs_peers_test.go` | 신규 · 5개 테스트 (V-PAT-7/8 포함) |
| `internal/helper/runtimebin/dmctl_run_peers.go` | `dmctl run peers` 구현 |
| `internal/helper/runtimebin/dmctl_run_peers_test.go` | 신규 · 3개 테스트 |
| `internal/webserver/domain/run/preamble.go` | 통신 규약 절 (FR-PAT-6) |
| `internal/webserver/domain/run/preamble_test.go` | 5개 테스트 추가 + 길이 상한 테스트 개편 |

### 스킬 문서

| 파일 | 내용 |
|---|---|
| `skills/team/references/patterns.md` | **신규** · 8패턴 × 6절 (FR-PAT-1/2/8) |
| `skills/team/references/models_and_patterns.md` | 모델 가이드 재작성 (FR-PAT-10 + 에이전트 무관화) |
| `skills/team/SKILL.md` | 결정표 · 1멤버 1역할 · brief 순서 규칙 · FR-IDU-8/9 |
| `skills/team/evals/test-scenarios.md` | 시나리오 4·5·6 추가 (FR-PAT-11) |
| `skills/team/scripts/plan_layout.py` | "toolId·라벨도 호환" 제거 (FR-IDU-8) |

### 설계 메모 — 다음 사람이 되돌리기 쉬운 자리

**`preamble.go` 의 길이 상한 테스트를 총량에서 절별로 바꿨다.**
조건부 절(작업 트리 FR-PRE-4, 인수인계 FR-CBG-9)이 둘 생기면서 총량 상한이 잘못된
척도가 됐다 — 붙지 않는 멤버는 그 절의 비용을 한 줄도 물지 않는다. 지금은
**기본 ≤42 / 작업 트리 절 ≤6 / 인수인계 뼈대 ≤6** 이며, 요약 본문은 `brief` 와 같은
이유로 상한 밖이다. **총량 하나로 되돌리지 마라** — 어느 절이 불어났는지 못 잡는다.

**`HandoffClause` 는 `store_context.go`(WS-3 소유)에 있고 호출만 `preamble.go` 에
있다.** 조정자가 현행 유지로 판정했다. 같은 패키지라 동작에 문제없다.
