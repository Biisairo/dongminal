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

## 절대 원칙 (3가지)

1. **항상 새 팀, 전용 창에서** — 기존 열린 CC 도구를 팀원으로 재사용하지 않는다. 팀은 자기 창(`dmctl new-window -n`)에서 산다. 사용자 창을 쪼개지 않으므로 사용자 작업 공간을 침범할 일 자체가 없다.
2. **Kickoff 는 `dmctl wait --for ready` 뒤에만** — 첫 작업 지시를 기동 프롬프트에 넣지 않는다. 준비완료는 **화면 모양이 아니라 훅 상태**로 판정한다. 위반 시 데드락 실화.
3. **매핑표는 기록에 있다** — 팀원 uuid 를 대화 기록에 보관하지 않는다. `dmctl run status --run <uuid>` 가 진실이다. 컨텍스트가 압축돼도 팀을 정리할 수 있다.

> `dmctl focus` 는 호출하지 않는다. 전용 창이 기본이라 포커스를 되돌릴 일이 없고, 사용자가 그 사이 다른 곳으로 옮겼을 수 있어 "원위치 복원" 이 오히려 엉뚱한 곳으로 보낸다.

---

## 도구 요약 (`dmctl`)

전부 `Bash` 로 호출하는 셸 명령이다. `dmctl` 은 dongminal 이 띄운 도구의 PATH 에 있다.

| 명령 | 용도 |
|------|------|
| `dmctl who-am-i` | 조정자(나) 식별자 |
| `dmctl new-window --name <이름> -n` | Run 전용 창. 응답의 `newWindows[0]`·`newTabs[0]` 를 쓴다 |
| `dmctl split-h [N] --at <uuid> -n` | 전용 창 안에서 분할. 응답 `newTabs` 가 팀원 탭들 |
| `dmctl rename-tab --at <uuid> <이름>` | 역할명 부여 (사이드바 관전성) |
| `dmctl run start\|member\|launch\|status\|close` | 실행 기록. 아래 워크플로우가 전부다 |
| `dmctl wait --at <uuid> --for ready\|done` | 상태 대기 (서버 long-poll). 폴링 루프 금지 |
| `dmctl status --at <uuid>` | 그 도구의 에이전트 상태 (막힌 팀원 진단) |
| `dmctl send-input --at <uuid> --execute -` | 도구의 **셸**에 명령 주입 |
| `dmctl msg --to <uuid> -` | 팀원과의 신뢰 채널 (에이전트 대상) |
| `dmctl close-tab --at <uuid>` | 탭 제거. 포커스 불변 |

세부는 `dmctl <명령> --help`.

**식별자는 항상 uuid.** `--at`/`--to` 는 라벨도 받지만 `W?.P?.T?` 는 다른 창이 닫히면 reflow 되어 다른 탭을 가리킨다. 생성 명령의 응답이 uuid 를 직접 주므로 `list-workspace` 로 되찾을 일이 없다.

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
dmctl new-window --name "team-<목적>" -n
```

응답에서 두 값을 캡처한다 — `newWindows[0]` = **창 uuid**, `newTabs[0].uuid` = **첫 팀원 탭**.

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

> **brief 는 기동 프롬프트에 실린다.** 멤버는 뜨자마자 그 일을 시작한다. 그러니 brief 에는 **혼자 끝낼 수 있는 일**만 적고, 다른 팀원에게 말을 거는 지시(리뷰 넘기기·순서 협의)는 넣지 마라 — 상대가 아직 없을 때 송신해 데드락이 된다. 팀원 간 협업은 Barrier 뒤 Kickoff 로 연다.

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

격리 Run 에서 탭을 남겨 둘 거면 `/exit` 뒤에 `dmctl send-input --at "$t" --execute "cd ~"` 를 보낸다. 그러지 않으면 셸의 cwd 가 방금 지워진 worktree 라 이후 명령이 전부 실패한다.

격리 Run 이면 `close` 가 작업 트리도 정리한다. **clean 한 트리만 지운다** — 고친
파일이 남아 있으면 지우지 않고 **잔여물로 보고**하며, 그 목록은 이후의
`dmctl run status --run "$RUN"` 에도 남는다. 사용자에게 그대로 전달하라. 전부
남기려면 `dmctl run close --run "$RUN" --keep-worktrees`.

`/exit` 를 먼저 하는 이유: 실행 중인 CC 의 탭을 바로 닫으면 브라우저가 "프로세스 종료?" 확인창을 띄워 무인 정리가 그 자리에서 막힌다. 마지막 탭이 닫히면 **전용 창은 스스로 사라진다** — `close-window` 를 쓰지 않는다.

---

## 체크리스트

1. [ ] `dmctl new-window --name <이름> -n` → `newWindows[0]`=WIN, `newTabs[0].uuid`=T1
2. [ ] `dmctl split-h "$N" --at "$T1" -n` → `newTabs` = 나머지 팀원 탭
3. [ ] `dmctl rename-tab --at <탭> <역할명>` 팀원마다
4. [ ] `dmctl run start --objective <목적> --window "$WIN"` → RUN (격리가 필요할 때만 `--isolation`)
5. [ ] 팀원마다 `dmctl run member --run "$RUN" --role <역할> --agent claude --at <탭> --brief -` → member uuid
6. [ ] 격리 Run 이면 팀원마다 `dmctl send-input --at <탭> --execute "cd '<worktree>'"` 를 먼저 보낸다
7. [ ] **한 `Bash` 호출에서 `&` + `wait`** 로 `dmctl run launch --member <m> | dmctl send-input --at <탭> --execute -`
8. [ ] **같은 턴 안에서** 팀원마다 `dmctl wait --at <탭> --for ready` (rc=5 면 진단, rc=4 는 체크포인트)
9. [ ] **같은 턴 안에서** `dmctl msg --to <시작 팀원>` Kickoff → `dmctl status` 로 `working` 확인
10. [ ] 위 7~9 를 끝낸 **다음에야** 턴 종료 — 보고 대기
11. [ ] `dmctl run status --run "$RUN"` 로 결과 종합 → 사용자에 보고
12. [ ] 정리 확인 → `dmctl run close --run "$RUN"` (잔여물이 나오면 사용자에게 전달) → `/exit` → `dmctl close-tab`

---

## 더 깊이 읽을 때

- `references/troubleshooting.md` — 실패 모드 진단 표 + 로그 위치
- `references/layout.md` — 전용 창이 기본인 이유, `inline` 을 쓸 때의 레이아웃 계산
- `references/models_and_patterns.md` — 모델 선택 가이드 + 팀 패턴 카탈로그
- `evals/test-scenarios.md` — 검증 시나리오

재사용할 팀 구성은 정의서로 저장한다 — `/dongminal:workflow`.

## tmux team agents 대비 장점

브라우저에서 팀 활동 실시간 관찰, 신뢰 채널 명시, **팀이 전용 창에 살아 사용자 작업 공간과 겹치지 않음**, 식별자가 uuid 라 창 닫힘에 따른 reflow 무관, **실행 기록이 파일에 남아 컨텍스트 압축을 넘어감**. 접합면이 셸 명령이라 Claude Code 외 에이전트도 같은 방식으로 참여할 수 있다.
