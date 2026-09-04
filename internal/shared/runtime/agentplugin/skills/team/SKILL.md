---
name: team
description: dongminal 워크스페이스에서 여러 Claude Code 인스턴스를 팀으로 묶어 협업시키는 범용 오케스트레이션 스킬. tmux 기반 team agents 대체. "팀 에이전트", "멀티 에이전트", "agent team", "서브 에이전트 여러 개", "병렬로 CC 돌려서", "역할 분담", "다른 pane 에 CC 띄워서", "GAN 식으로 두 CC", "리서치 fan-out", "여러 Claude 협업" 류의 의도면 반드시 이 스킬을 써라. 구성 방식이 아직 정해지지 않아도 트리거한다.
---

# team

dongminal 의 창/분할 칸/탭/도구 + 신뢰 채널 (`dmctl msg`) 로 **여러 Claude Code 인스턴스를 같은 워크스페이스에서 팀으로 협업**시키는 스킬. 팀은 항상 이 스킬이 **새로** 만들고, 끝나면 정리한다.

## 언제 쓰나

- "팀 만들어서", "여러 CC 돌려서", "A는 X, B는 Y", "역할 분담", "fan-out", "GAN 스타일"
- 한 CC 가 혼자 하기엔 맥락이 너무 크거나, 서로 다른 관점(생성 vs 비판, 리서치 병렬) 이 필요할 때
- 길고 독립적인 서브태스크 3개 이상

**안 쓰는 경우**: 단일 CC 로 충분, 단순 질의응답, 단일 파일 수정.

---

## 절대 원칙 (4가지)

1. **항상 새 팀, 전용 창에서** — 기존 열린 CC 도구를 팀원으로 재사용하지 않는다. 팀은 자기 창(`dmctl new-window -n`)에서 산다. 사용자 창을 쪼개지 않으므로 사용자 작업 공간을 침범할 일 자체가 없다.
2. **Kickoff 는 `dmctl wait --for ready` 뒤에만** — 첫 작업 지시를 기동 프롬프트에 넣지 않는다. 준비완료는 **화면 모양이 아니라 훅 상태**로 판정한다. 위반 시 데드락 실화.
3. **매핑표는 기록에 있다** — 팀원 uuid 를 대화 기록에 보관하지 않는다. `dmctl run status --run <uuid>` 가 진실이다. 컨텍스트가 압축돼도 팀을 정리할 수 있다.
4. **1멤버 1역할 1관심사** — 아래 참조.

> `dmctl focus` 는 호출하지 않는다. 전용 창이 기본이라 포커스를 되돌릴 일이 없고, 사용자가 그 사이 다른 곳으로 옮겼을 수 있어 "원위치 복원" 이 오히려 엉뚱한 곳으로 보낸다.

### 1멤버 1역할 1관심사

한 멤버의 `--brief` 는 **한 종류의 일**만 담는다. "구현하고 테스트도 짜고 문서도 써라" 는 **셋으로 쪼갠다.**

- 서로 다른 관심사를 한 멤버에 몰면 그 멤버의 컨텍스트가 셋 몫으로 차고, 산출물의 품질은 **셋 다** 떨어진다
- **멤버는 재사용하지 않는다.** 일이 끝난 멤버에게 다음 일을 주지 말고, 새 멤버를 만든다. 보고를 마친 멤버는 그 일에 대해 끝난 것이고, 두 번째 보고는 서버가 거부한다
- 위반은 `dmctl run status` 의 컨텍스트 등급으로 **관측된다** — 규칙과 계측이 짝이다

멤버를 늘리는 것이 아까워 보일 때가 이 규칙이 필요한 순간이다.

---

## 패턴 선택

작업의 성격에서 패턴으로 바로 간다. 여기서 한 번에 고르고, 세부는 `references/patterns.md` 에서 읽는다.

| 작업이 이렇게 생겼으면 | 패턴 |
|---|---|
| 같은 종류의 일이 N개, 서로 안 봐도 된다 | supervisor-worker (헤드리스) |
| 순서가 있다. B는 A의 결과가 있어야 시작한다 | pipeline |
| 정답이 없고 **더 나은 것**을 찾는다 | debate |
| 혼자 만들 수 있지만 스스로 검토가 필요하다 | reflection |
| 넓게 찾아서 하나로 모은다 | map-reduce fan-out |
| 공유 문서 하나를 여럿이 쌓는다 | blackboard |
| 만든 것의 결함을 찾아야 한다 | red-team |
| 서브태스크 하나가 혼자 팀만큼 크다 | hierarchical |

**8패턴 중 6개는 팀원끼리 직접 주고받는 것이 본체다.** 그것은 이미 되는 일이고 금지가 아니다 — 다만 **Barrier 뒤에** 열린다 (아래 §3·§6). 멤버는 `dmctl run peers` 로 동료를 찾는다.

> **헤드리스는 패턴이 아니라 배치다.** 어느 패턴이든 멤버를 화면에 붙일지 말지는 따로 정한다 (§3.2).

---

## 도구 요약 (`dmctl`)

전부 `Bash` 로 호출하는 셸 명령이다. `dmctl` 은 dongminal 이 띄운 도구의 PATH 에 있다.

| 명령 | 용도 |
|------|------|
| `dmctl who-am-i` | 조정자(나) 식별자 |
| `dmctl new-window --name <이름> -n --cwd "$PWD"` | Run 전용 창. 응답의 `newWindows[0]`·`newTabs[0]` 를 쓴다. **`--cwd` 없이 부르면 홈에서 뜬다** (FR-WBR-22) |
| `dmctl split-h [N] --at <uuid> -n` | 전용 창 안에서 분할. 응답 `newTabs` 가 팀원 탭들 |
| `dmctl rename-tab --at <uuid> <이름>` | 역할명 부여 (사이드바 관전성) |
| `dmctl run start\|member\|launch\|status\|close` | 실행 기록. 아래 워크플로우가 전부다 |
| `dmctl run peers` | **팀원이** 부르는 명령. 자기를 뺀 동료의 역할·uuid·상태를 낸다 |
| `dmctl wait --at <uuid> --for ready\|done` | 상태 대기 (서버 long-poll). 폴링 루프 금지 |
| `dmctl wait --member <uuid> --for ready\|done` | 헤드리스 멤버의 상태 대기 (`--at` 의 짝) |
| `dmctl run attach --member <uuid> [--at <uuid>]` | 헤드리스 멤버를 탭에 붙여 들여다본다 |
| `dmctl run detach --member <uuid>` | 탭을 닫고 도구는 살려 둔다 |
| `dmctl status --at <uuid>` | 그 도구의 에이전트 상태 (막힌 팀원 진단) |
| `dmctl send-input --at <uuid> --execute -` | 도구의 **셸**에 명령 주입 |
| `dmctl msg --to <uuid> -` | 팀원과의 신뢰 채널 (에이전트 대상) |
| `dmctl close-tab --at <uuid>` | 탭 제거. 포커스 불변 |

세부는 `dmctl <명령> --help`.

**식별자는 항상 uuid.**

- 접합면 명령(`read-screen`/`read-output`/`send-input`/`msg`/`status`/`wait`/`run member`)의 `--at`/`--to`/`--from` 은 **uuid 만** 받는다. `W1.P1.T1` 같은 좌표 라벨은 **400** 이다
- 라벨은 `list-workspace` 의 `label=` 컬럼에만 있는 **표시 전용** 값이다. 명령에 넣을 값은 `uuid=` 컬럼에서 가져온다
- 이유: 라벨은 창·분할 칸이 닫히면 다시 계산돼 다른 탭을 가리킨다
- **답장할 때는 엔벨로프 헤더의 `from=<라벨> (<uuid>)` 에서 괄호 안 uuid 를 `--to` 에 쓴다.** 헤더에 uuid 가 함께 실리므로 보낸 사람을 되짚어 찾을 일이 없다

생성 명령의 응답도 uuid 를 직접 주므로 `list-workspace` 로 되찾을 일이 없다.

**`--from` 은 넘기지 않는다** — `dmctl msg` 가 `$DONGMINAL_TOOL_ID` 로 발신자를 자동으로 채운다.

**긴 본문은 heredoc 으로 stdin 에.** 위치 인자로 넘기면 셸 인용 지옥에 빠진다. 종료자는 **반드시 열 0**:

```bash
dmctl msg --to "$MEMBER_TAB" - <<'MSG'
여러 줄
지시문
MSG
```

---

## 워크플로우

### 1. Run 전용 창 만들기

```bash
dmctl new-window --name "team-<목적>" -n --cwd "$PWD"
```

응답에서 두 값을 캡처한다 — `newWindows[0]` = **창 uuid**, `newTabs[0].uuid` = **첫 팀원 탭**.

> **`--cwd` 를 반드시 붙인다** (WORKBENCH_REVIEW_SRS FR-WBR-22·23). 새 창은 이제
> **홈**에서 뜬다 — 붙이지 않으면 팀 전원이 프로젝트 밖에서 기동해 에이전트 정의를
> 찾지 못한다. 분할로 태어나는 나머지 팀원 탭은 그 창의 cwd 를 물려받으므로
> (FR-WBR-21) 첫 창에만 주면 된다.
>
>   이전 동작: `dmctl` 이 호출자 도구를 자동으로 실어 이 셸의 cwd 에서 열렸다
>             (UX_REVISION_SRS FR-CWD-4)
>   새  동작: 자동 승계가 없다. `--cwd "$PWD"` 로 **명시**한다
>   이유:     사용자 지시 — "새로 뜨는 창은 누가 열었든 홈" 이 규칙이 되었다

```json
{"ok":true,"newWindows":["<WIN>"],"newTabs":[{"uuid":"<T1>","toolId":"..."}],"timedOut":false}
```

`delivered=0` 이면 브라우저가 SSE 를 구독하지 않은 것이다 — 사용자에게 새로고침을 요청한다. `timedOut: true` 면 브라우저 echo 가 늦은 것이므로 그때만 `dmctl list-workspace` 로 확인한다.

### 2. 팀원 수만큼 분할

N 명이면 첫 탭을 포함해 N 개가 필요하므로 `N` 을 그대로 넘긴다:

```bash
dmctl split-h "$N" --at "$T1" -n      # 또는 split-v
```

응답 `newTabs` 가 나머지 팀원 탭이다. 팀원 탭 목록 = `T1` + `newTabs[*].uuid`.

**전용 창이라 사용자 화면 비율과 무관하다** — 단순 균등 분할로 충분하고 레이아웃 계산이 필요 없다. (사용자 창을 쪼개는 `inline` 모드를 굳이 쓸 때만 `scripts/plan_layout.py` 가 필요하다. `references/layout.md` 참조.)

역할명을 붙인다:

```bash
dmctl rename-tab --at "$T1" "작가"
```

### 3. Run 열고 멤버 등록

```bash
RUN=$(dmctl run start --objective "<한 줄 목적>" --window "$WIN" | sed -n 's/^run=\([^ ]*\).*/\1/p')
```

격리가 필요하면 여기서 `--isolation` 을 준다 (아래 3.5). **기본은 격리 없음**이다.

팀원마다 등록한다. `--brief` 가 그 팀원이 할 일이며, **여러 줄이면 `-` 로 stdin** 에 넘긴다:

```bash
dmctl run member --run "$RUN" --role "작가" --agent claude --at "$T1" --brief - <<'B'
'아침' 을 주제로 짧은 시를 쓴다. 다 쓰면 비평가에게 넘기지 말고 곧바로 보고한다.
B
```

출력의 `member=<uuid>` 를 캡처한다. 서버가 이 시점에 **프리앰블을 조립**한다 — 역할·목적·Run/Member uuid·보고 규약이 들어간 평문이며, 조정자가 uuid 를 옮겨 적을 일이 없다.

> **brief 는 기동 프롬프트에 실린다** — 멤버는 뜨자마자 그 일을 시작한다. 그러니 brief 에는 **혼자 시작할 수 있는 일**만 적는다. 동료에게 말을 거는 것은 금지가 아니라 **순서의 문제**다: 기동 시점에는 동료가 아직 없으므로 그때 보낸 메시지는 사라진다. **Barrier(전원 ready) 이후에는 자유롭게 주고받는다** — 그것이 pipeline·debate·red-team 이 작동하는 방식이다. 조정자는 Kickoff 메시지에 "이제 동료가 전원 준비됐다. `dmctl run peers` 로 확인하고 <역할>에게 <무엇>을 보내라" 를 넣어 P2P 를 **연다**.

> P2P 를 쓰는 패턴의 brief 에는 세 가지를 **반드시** 적는다 — **누가 먼저 말하는가 · 왕복 상한 · 상대가 응답하지 않을 때 누구에게 보고하는가.** 서버는 패턴을 모르므로 이 셋은 brief 로만 성립하고, 빠지면 무한 왕복이나 상호 대기로 끝난다. 패턴별 문구는 `references/patterns.md` 의 "4. 토폴로지" 에 있다.

### 3.2 화면에 붙일까, 헤드리스로 둘까

**기본은 탭 부착이다.** 사람이 팀 활동을 지켜보는 것이 이 제품의 이점이므로, 전용 창 + 분할 + 탭이 기본 배치다. 헤드리스는 그 이점을 포기하는 선택이며, 포기할 이유가 있을 때만 쓴다.

| 이렇게 생겼으면 | 배치 |
|---|---|
| 멤버 4명 이하, 진행을 보고 싶다 | **탭 부착** (기본) — `--at "$T1"` |
| 멤버가 4명을 넘어 분할이 읽을 수 없다 | 헤드리스 — `--headless` |
| 팬아웃 멤버처럼 개별 화면을 볼 이유가 없다 | 헤드리스 |
| 승계로 잠깐 살아있는 인수인계 전용 멤버 | 헤드리스 |

```bash
dmctl run member --run "$RUN" --role "수집-3" --agent claude --headless --brief - <<'B'
<혼자 시작할 수 있는 일>
B
```

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

데몬을 재시작하면 헤드리스 멤버의 도구는 되살아나지만 **그 안의 에이전트는 돌아오지 않는다.** Run 도 재시작으로 aborted 가 된다. 되살리는 이유는 작업을 잇기 위해서가 아니라 **거둘 수 있게 하기 위해서**다 — `dmctl run status` 의 고아 목록에 나타나고 `dmctl run close --run "$RUN" --force` 로 정리한다.

### 3.3 잠깐 들여다보기 — attach / detach

헤드리스 멤버를 지금 눈으로 봐야 하면 탭에 붙였다가 되돌린다.

```bash
dmctl run attach --member "$M"              # 현재 포커스 분할 칸에 새 탭
dmctl run attach --member "$M" --at "$TAB"  # 그 탭이 속한 분할 칸에
dmctl run detach --member "$M"              # 탭을 닫고 백그라운드로
```

**부착·분리는 멤버의 상태를 바꾸지 않는다.** `state`·`outcome`·컨텍스트 관측·보고 계약 전부 그대로다 — 화면 결속은 관찰 수단일 뿐이고, 관찰 행위가 관찰 대상을 바꾸지 않는다. `detach` 로 에이전트 프로세스가 죽지도 않는다.

동료가 보는 값도 그대로다 — `dmctl run peers` 의 `state` 는 도구 생존과 활동에서 파생하므로 부착 여부와 무관하다. 조정자가 들여다보는 동안 동료의 판단이 흔들리지 않는다.

**attach·detach 는 구독 중인 브라우저가 있어야 한다. 창이 없으면 거부된다(rc≠0).** 헤드리스는 화면 없이 도는 것이 요점인데 **부착만은 화면을 요구한다** — 이 비대칭을 모르면 창 없는 상황에서 attach 를 걸고 막힌다.

### 3.5 격리 — 쓸 때만 (기본: 안 쓴다)

격리는 팀원마다 **별도 git worktree** 에서 일하게 하는 선택이다. 기본값은 `none`
이고, 그대로 두는 것이 정상이다.

| 값 | 뜻 |
|----|-----|
| `none` (기본) | 전원이 조정자의 작업 트리를 공유한다 |
| `per-run` | 팀 전체가 worktree 하나를 공유한다. 사용자 트리와는 분리 |
| `per-member` | 팀원마다 worktree 하나. 같은 파일을 동시에 고치는 팬아웃용 |

**"독립 태스크·병렬 실행·편의" 는 격리 사유가 아니다.** 신뢰 채널로 서로의 산출물을
읽는 협업 토폴로지는 **파일 공유를 전제**하므로, 격리하면 오히려 깨진다. 같은 파일을
동시에 고칠 것이 확실할 때만 쓴다.

```bash
RUN=$(dmctl run start --objective "<목적>" --window "$WIN" --isolation per-member \
      | sed -n 's/^run=\([^ ]*\).*/\1/p')
```

- **조정자의 셸 cwd 가 그 저장소여야 한다.** git 저장소가 아니면 Run 시작이 **실패**
  한다 — 조용히 비격리로 낮추지 않는다. 필요하면 `cd` 를 먼저 하고 시작하라
- 갈라져 나올 지점은 기본이 **현재 HEAD** 다. 바꾸려면 `--base <ref>`
- 멤버 등록 출력에 `worktree=<경로>` 가 함께 나온다. 경로·브랜치는 uuid 에서
  파생되며 **재사용되지 않는다**

**격리 Run 에서는 기동 전에 반드시 그 경로로 보낸다** — 도구의 셸은 `~` 에서 시작하고,
`cd` 없이 띄우면 팀원이 조정자의 트리를 고친다:

```bash
LINE=$(dmctl run member --run "$RUN" --role "작가" --agent claude --at "$T1" --brief - <<'B'
<할 일>
B
)
WT=$(printf '%s' "$LINE" | sed -n 's/.*worktree=\([^ ]*\).*/\1/p')

dmctl send-input --at "$T1" --execute "cd '$WT'"
```

새 worktree 경로는 정의상 **신뢰 목록에 없다.** 기동 직후 폴더 신뢰 확인 모달이 뜰 수
있고, 그 상태에서는 훅이 아무것도 보고하지 않아 `dmctl wait` 가 rc=4(타임아웃)로
돌아온다. **실패가 아니라 체크포인트다** — `dmctl read-screen --at <탭>` 으로 무엇을
묻는지 보고 응답한 뒤 다시 기다린다.

### 4. 팀원 병렬 기동

`dmctl run launch` 가 **셸에 그대로 넣을 기동줄**을 만든다 (프리앰블 포함, 권한 사전 허용 포함, 인용 처리 완료). 파이프만 하면 된다:

```bash
for pair in "$M1:$T1" "$M2:$T2"; do
  m=${pair%%:*}; t=${pair##*:}
  dmctl run launch --member "$m" --model sonnet | dmctl send-input --at "$t" --execute - &
done
wait
```

**하나의 `Bash` 호출에서 `&` + `wait`** 로 병렬 기동한다. 순차 기동하면 먼저 뜬 팀원이 아직 없는 동료에게 송신을 시도한다.

> **도구의 셸은 `~` 에서 시작한다.** 특정 디렉터리에서 일해야 하면 기동 전에 `dmctl send-input --at "$t" --execute 'cd <절대경로>'` 를 먼저 보낸다. 신뢰하지 않는 디렉터리에서 claude 를 띄우면 **폴더 신뢰 확인 모달**이 떠서 기동이 멈춘다. 격리 Run 이면 그 절대 경로가 곧 멤버의 worktree 다 (3.5).

### 5. Barrier — 준비완료 확인

> ⚠️ **턴 종료 금지** — 4단계(기동)부터 6단계(Kickoff)까지는 **하나의 어시스턴트 턴 안에서 연속 실행**한다. "잠시 후 kickoff" 같은 예고만 남기고 턴을 끝내면 재진입되지 않아 팀이 정지한다. 대기는 오직 아래 도구 호출로 표현한다.

```bash
for t in "$T1" "$T2"; do dmctl wait --at "$t" --for ready --timeout-ms 180000; done
```

헤드리스 멤버는 탭 uuid 가 없으므로 `--member` 로 부른다. 판정 근거는 같다(훅 상태) — 화면 스크래핑에 의존하지 않으므로 헤드리스에서도 그대로 성립한다.

```bash
for m in "$M1" "$M2"; do dmctl wait --member "$m" --for ready --timeout-ms 180000; done
```

서버가 붙잡아 준다. `sleep` 루프를 돌리지 않는다. 종료 코드가 결과다:

| rc | 뜻 | 대응 |
|----|-----|------|
| 0 | 준비완료 | 다음 팀원, 전원 끝나면 Kickoff |
| 5 | **blocked** — 팀원이 권한 확인 등을 기다린다 | `dmctl read-screen --at <uuid>` 로 무엇을 묻는지 보고 처리. 시간이 지난다고 풀리지 않는다 |
| 4 | 타임아웃 — **실패가 아니라 체크포인트** | 마지막 관측 상태를 보고 계속 기다릴지 진단할지 정한다. 이것만으로 팀원을 죽이거나 재기동하지 않는다 |

**화면 모양으로 준비완료를 판정하지 않는다.** 프롬프트 박스 유무·스피너 부재 같은 fingerprint 는 에이전트 버전이나 사용자의 스테이터스라인 하나로 깨지고, 무엇보다 **권한 대기와 준비완료를 구분하지 못한다.**

### 6. Kickoff — 첫 작업 지시

```bash
dmctl msg --to "$STARTER_TAB" - <<'MSG'
[TEAM-KICKOFF task-id=<id>]
status: START
<짧은 태스크>
[/TEAM-KICKOFF]
MSG
```

**P2P 를 여는 자리가 여기다.** 팀원끼리 주고받아야 하는 패턴이면 Kickoff 에 그 한 줄을 넣는다 — 이 시점에는 전원이 등록돼 있으므로 명부가 완전하다:

```bash
dmctl msg --to "$STARTER_TAB" - <<'MSG'
[TEAM-KICKOFF task-id=<id>]
status: START
동료가 전원 준비됐다. `dmctl run peers` 로 확인하고, 초안이 서면 "비평가" 에게 보내라.
왕복은 최대 3회. 상대가 10분 안에 답하지 않으면 나에게 보고하라.
<짧은 태스크>
[/TEAM-KICKOFF]
MSG
```

Kickoff 는 **첫 발신자에게만** 보낸다. 나머지는 동료의 메시지로 깨어난다 — 전원에게 START 를 보내면 대기해야 할 멤버가 먼저 움직여 순서가 무너진다.

프리앰블에 이미 역할·목적·보고 규약이 있으므로 kickoff 는 짧아도 된다. 송신 후 `dmctl status --at "$STARTER_TAB"` 로 `working` 으로 넘어갔는지 확인한다. `idle` 그대로면 `dmctl send-input --at "$STARTER_TAB" --execute ""` 로 엔터를 보강하고 재확인한다. 이 확인까지가 같은 턴에서 끝나야 한다.

### 7. 턴 종료 → 보고 대기

조정자는 팀원을 실시간 감시하지 않는다. 팀원의 질문·중간 공유는 엔벨로프로 다음 사용자 턴처럼 자동 도착한다. 폴링 불필요.

**최종 결과는 기록에서 읽는다:**

```bash
dmctl run status --run "$RUN"
```

멤버별 `state` 와 보고된 `outcome`·요약이 나온다. `state` 는 조회 시점에 파생된다 — 도구가 죽었으면 `lost`, 훅이 말한 대로 `working`/`waiting`, 보고를 마쳤으면 `done`/`failed`. **보고는 기록이 관측을 이긴다.**

특정 팀원의 완료만 기다리려면 `dmctl wait --at <uuid> --for done`.

### 8. 팀 해체 (사용자 확인 후)

```bash
dmctl run close --run "$RUN"
```

미보고 멤버가 있으면 **거부하고 목록을 낸다** — 보고하지 않은 팀원은 완료의 증거가 아니다. 정말 접으려면 `--force`.

`close` 는 도구를 닫지 않는다. 정리 대상(`role`/`toolId`/`tabId`)을 돌려주므로 조정자가 순서대로 마무리한다:

```bash
dmctl send-input --at "$t" --execute "/exit"    # 팀원마다. 대화를 저장하고 정상 종료
# 쉘 복귀 확인 후
dmctl close-tab --at "$t"
```

헤드리스 멤버의 도구는 **`dmctl run close` 가 닫는다.** 닫을 탭이 없으므로 Run 이 소유권을 갖기 때문이다 — 탭 부착 멤버처럼 `/exit` → `close-tab` 을 칠 필요가 없다. 화면에 붙어 있는 도구는 close 가 건드리지 않는다.

남기려면 `--keep-tools`. 남긴 것은 이후 `dmctl run status` 의 **고아 목록**에 계속 나온다 — 조용히 남는 자원이 없어야 하기 때문이고, worktree 잔여물과 같은 규약이다.

격리 Run 에서 탭을 남겨 둘 거면 `/exit` 뒤에 `dmctl send-input --at "$t" --execute "cd ~"` 를 보낸다. 그러지 않으면 셸의 cwd 가 방금 지워진 worktree 라 이후 명령이 전부 실패한다.

격리 Run 이면 `close` 가 작업 트리도 정리한다. **clean 한 트리만 지운다** — 고친
파일이 남아 있으면 지우지 않고 **잔여물로 보고**하며, 그 목록은 이후의
`dmctl run status --run "$RUN"` 에도 남는다. 사용자에게 그대로 전달하라. 전부
남기려면 `dmctl run close --run "$RUN" --keep-worktrees`.

`/exit` 를 먼저 하는 이유: 실행 중인 CC 의 탭을 바로 닫으면 브라우저가 "프로세스 종료?" 확인창을 띄워 무인 정리가 그 자리에서 막힌다. 마지막 탭이 닫히면 **전용 창은 스스로 사라진다** — `close-window` 를 쓰지 않는다.

---

## 체크리스트

0. [ ] 선택 결정표에서 **패턴을 고른다.** P2P 패턴이면 첫 발신자·왕복 상한·탈출로를 먼저 정한다
1. [ ] `dmctl new-window --name <이름> -n --cwd "$PWD"` → `newWindows[0]`=WIN, `newTabs[0].uuid`=T1
2. [ ] `dmctl split-h "$N" --at "$T1" -n` → `newTabs` = 나머지 팀원 탭
3. [ ] `dmctl rename-tab --at <탭> <역할명>` 팀원마다
4. [ ] `dmctl run start --objective <목적> --window "$WIN"` → RUN (격리가 필요할 때만 `--isolation`)
5. [ ] 팀원마다 `dmctl run member ... --at <탭> | --headless` → member uuid. **brief 하나에 관심사 하나**, `--at`/`--headless` 는 정확히 하나 (§3.2)
6. [ ] 격리 Run 이면 팀원마다 `dmctl send-input --at <탭> --execute "cd '<worktree>'"` 를 먼저 보낸다
7. [ ] **한 `Bash` 호출에서 `&` + `wait`** 로 `dmctl run launch --member <m> | dmctl send-input --at <탭> --execute -`
8. [ ] **같은 턴 안에서** 팀원마다 `dmctl wait --at <탭> --for ready` (rc=5 면 진단, rc=4 는 체크포인트)
9. [ ] **같은 턴 안에서** `dmctl msg --to <시작 팀원>` Kickoff (P2P 패턴이면 첫 발신자에게만, 왕복 상한·탈출로를 함께) → `dmctl status` 로 `working` 확인
10. [ ] 위 7~9 를 끝낸 **다음에야** 턴 종료 — 보고 대기
11. [ ] `dmctl run status --run "$RUN"` 로 결과 종합 → 사용자에 보고
12. [ ] 정리 확인 → `dmctl run close --run "$RUN"` (잔여물이 나오면 사용자에게 전달) → `/exit` → `dmctl close-tab`

---

## 더 깊이 읽을 때

- `references/troubleshooting.md` — 실패 모드 진단 표 + 로그 위치
- `references/layout.md` — 전용 창이 기본인 이유, `inline` 을 쓸 때의 레이아웃 계산
- `references/patterns.md` — 팀 패턴 8종. 토폴로지·종료 조건·그대로 실행 가능한 dmctl 시퀀스
- `references/models.md` — 역할별 모델 선택 가이드
- `evals/test-scenarios.md` — 검증 시나리오

재사용할 팀 구성은 정의서로 저장한다 — `/dongminal:workflow`.

## tmux team agents 대비 장점

브라우저에서 팀 활동 실시간 관찰, 신뢰 채널 명시, **팀이 전용 창에 살아 사용자 작업 공간과 겹치지 않음**, 식별자가 uuid 라 창 닫힘에 따른 reflow 무관, **실행 기록이 파일에 남아 컨텍스트 압축을 넘어감**. 접합면이 셸 명령이라 Claude Code 외 에이전트도 같은 방식으로 참여할 수 있다.
