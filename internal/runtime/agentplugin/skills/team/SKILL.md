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

1. **항상 새 팀** — 기존 열린 CC 도구는 절대 팀원으로 재사용하지 않는다. 사용자 맥락 훼손 방지 + 팀원은 깨끗한 컨텍스트에서 지시받아야 작업이 명확하다.
2. **사용자 포커스 금지** — 모든 레이아웃 명령은 `--at <uuid>` + `--no-focus`. `dmctl focus` 는 **복원 목적 포함 어떤 경우에도 호출 금지**. 이유와 상세는 `references/layout.md`.
3. **Barrier 전 Kickoff 금지** — inline 프롬프트엔 첫 작업 지시를 **절대** 넣지 않는다. 전원 CC 준비 완료 확인 후 `dmctl msg` 로 Kickoff. 위반 시 데드락 실화 — `references/prompt.md`.
4. **식별자는 항상 UUID** — 팀원 식별·라우팅·정리 모든 단계에서 `dmctl who-am-i` / `dmctl list-workspace` 의 `uuid=<36자>` 필드를 사용한다. `W?.P?.T?` 라벨은 사람 가독성용 좌표일 뿐, 다른 창이 닫히면 reflow 되어 다른 탭을 가리키게 된다. 계층 팀·정리·해체 단계에서 라벨 보관 시 즉시 깨짐. **항상 uuid 로 보관·전달.**

---

## 도구 요약 (`dmctl`)

전부 `Bash` 로 호출하는 셸 명령이다. `dmctl` 은 dongminal 이 띄운 도구의 PATH 에 있다.

| 명령 | 용도 |
|------|------|
| `dmctl who-am-i` | 팀장 식별자 (`uuid=` `short=`) + `size=COLSxROWS` 획득 |
| `dmctl list-workspace [--json]` | 팀원 도구의 라벨·**uuid**·shellPid 식별 |
| `dmctl split-h [N] --at <uuid> -n` | 가로 분할 (좌↔우). N 지정 시 N 균등 분할 |
| `dmctl split-v [N] --at <uuid> -n` | 세로 분할 (상↕하). N 지정 시 N 균등 분할 |
| `dmctl close-tab --at <uuid>` | 탭 제거. 포커스 불변 |
| `dmctl rename-tab --at <uuid> <이름>` | 역할명 부여 |
| `dmctl send-input --at <uuid> --execute <텍스트>` | 새 도구의 쉘에 `claude` 명령 주입 |
| `dmctl msg --to <uuid> <메시지>` | 팀원과의 신뢰 채널 |
| `dmctl read-screen --at <uuid>` | Barrier 확인, 멈춘 CC 진단 |

세부는 `dmctl <명령> --help`.

**식별자 형식**: `--at` / `--to` 는 uuid·toolId·라벨 어느 형식이든 받지만, **이 스킬에서는 항상 uuid 사용**.

**`--from` 은 생략한다** — `dmctl msg` 는 `$DONGMINAL_TOOL_ID` 로 발신자를 자동 채운다. 팀장이 자기 uuid 를 `msg` 에 넘길 이유가 없다 (레이아웃 `--at` 에는 여전히 필요).

**긴 본문은 heredoc 으로 stdin 에 넘긴다.** 위치 인자로 넘기면 셸 인용 지옥에 빠진다:

```bash
dmctl msg --to "$MEMBER_UUID" - <<'MSG'
여러 줄
지시문
MSG
```

**병렬 실행은 `&` + `wait`** — 여러 팀원에게 동시에 보낼 때 한 `Bash` 호출 안에서 백그라운드로 돌린다 (아래 4단계).

---

## 워크플로우

### 1. 팀장 정보 + 레이아웃 계획

```bash
dmctl who-am-i
```

출력 라인의 `uuid=<36자>` 를 BOSS 로, `size=COLSxROWS` 를 레이아웃 입력으로 캡처한다. `label=<W?.P?.T?>` 는 사람이 보는 출력용. **이 단계 이후 모든 식별은 uuid 사용.**

레이아웃은 스크립트가 계산한다 (셀 비율 2.2 보정, 긴 축 판정, 직교 N 등분):

```bash
python scripts/plan_layout.py --cols <COLS> --rows <ROWS> --n <N> --boss <BOSS_UUID>
```

출력 JSON 의 `primary_split` / `orthogonal_split` 지시를 그대로 따른다. `location` 자리에 `BOSS_UUID` 를 넣는다.

### 2. 1차 분할

`plan` 의 `primary_split` 대로:

```bash
dmctl split-h --at "$BOSS_UUID" -n     # 또는 split-v
```

`dmctl` 은 생성 명령의 응답 JSON 을 그대로 출력하고, 거기에 **방금 생긴 SEED 의 uuid 가 들어 있다**:

```json
{"ok":true,"action":"splitH","delivered":1,"newTabs":[{"uuid":"<SEED_UUID>","toolId":"7"}],...}
```

`newTabs[0].uuid` 를 SEED 로 캡처한다. `list-workspace` 로 이전 목록과 비교할 필요가 없다. `timedOut: true` 면 브라우저 echo 가 늦은 것이므로 그때만 `dmctl list-workspace` 로 확인한다.

### 3. 직교 축 N 등분 (N≥2 일 때만)

```bash
dmctl split-v "$N" --at "$SEED_UUID" -n     # 또는 split-h
```

단일 호출로 정확히 N 균등 분할. 응답의 `newTabs` 배열이 **팀원 uuid 전부**다. SEED 자신도 팀원 한 명이므로, 팀원 목록은 `SEED_UUID` + `newTabs[*].uuid` 다.

> 팁: `dmctl list-workspace` 의 각 행에는 `uuid=<full>  short=<8자>` 가 붙는다. short 는 로그 가독성용 별칭. 라우팅·인자 전달에는 항상 full uuid 사용.

### 4. 팀원 CC 병렬 부팅 (대기 프롬프트)

각 팀원 프롬프트는 빌더로 생성:

```bash
python scripts/build_prompt.py \
  --model <opus|sonnet|haiku> --my-label <팀원UUID> --boss <BOSS_UUID> \
  --role "<한 줄 역할>" \
  --teammate <UUID>:<역할> [--teammate ...] \
  [--process "<통신 흐름>"] [--reply-to <허브UUID>]
```

스크립트 인자명은 역사적으로 `--my-label`/`--boss`/`--teammate <id>:<role>` 이지만 식별자 형식을 검사하지 않으므로 uuid 값 그대로 통과한다. 빌더는 `[대기]` 지시를 자동 포함한다. 직접 쓰지 말 것.

**하나의 `Bash` 호출에서 병렬로** 전원 기동:

```bash
for i in 1 2 3; do
  eval "uuid=\$MEMBER_$i"; eval "prompt=\$PROMPT_$i"
  printf '%s' "$prompt" | dmctl send-input --at "$uuid" --execute - &
done
wait
```

병렬이 중요한 이유: 순차 기동 시 먼저 뜬 팀원이 아직 존재하지 않는 동료 uuid 에 송신 시도 → unknown uuid.

### 5. Barrier — 전원 CC 준비 완료 확인

> ⚠️ **턴 종료 금지** — 4단계(병렬 부팅) 부터 6단계(Kickoff) 까지는 **반드시 하나의 어시스턴트 턴 안에서 연속 실행**한다. "90초 후 kickoff" 같은 예고만 남기고 턴을 끝내면 영원히 재진입되지 않아 팀이 정지한다. `ScheduleWakeup` / 사용자 응답 대기로 빠지지 말 것. 대기는 오직 아래 도구 호출로 표현한다.
>
> **`Thinking...` 차단 정책** — Barrier 단계는 본질적으로 **모델이 출력 없이 도구 호출만 반복하는 구간**이다. "잠시 기다리겠습니다" 같은 텍스트도 출력하지 말 것 — 텍스트가 들어가는 순간 모델이 "응답 끝"으로 인식해 턴 종료 위험이 커진다. Barrier 통과 후 Kickoff 직전까지 무발화 도구 체인 유지.

**대기 표현 — 반드시 도구 호출로**:

1. 4단계 병렬 부팅 직후, **첫 확인 전 최소 8초 대기를 명시 도구 호출로** 삽입:
   - `Bash(command="sleep 8", description="CC 부팅 대기")` — 가장 단순
   - 또는 다른 유의미한 동시 작업이 있으면 그걸로 8초+ 채워도 됨
2. 대기 후 전원 확인. 한 `Bash` 호출로 묶는다:
   ```bash
   for u in "$M1" "$M2" "$M3"; do echo "=== $u ==="; dmctl read-screen --at "$u" --bytes 4000; done
   ```
   준비 완료 조건 (모두 충족):
   - `╭─` / `>` 프롬프트 박스 노출
   - 화면에 `Thinking...` 부재
   - **초기 프롬프트의 `[대기]` 텍스트가 화면에 보임** (CC가 초기 프롬프트를 실제 처리했다는 fingerprint — 단순 부팅과 구분)
3. 미준비 팀원이 있으면 `sleep 3` → 미준비 팀원만 재확인. **최대 10회 (≈30초) 자동 재시도**. 한두 번 미준비로 절대 종료/보고 후 종료 하지 말 것.
4. 30초 누적 미준비면 실패 판정 — 해당 도구의 화면을 진단 (`claude: command not found`, 쿼터 초과, 쉘 파싱 에러 등).

### 6. Kickoff — 첫 작업 지시

작업 개시자(들)에게 첫 지시 전송:

```bash
dmctl msg --to "$STARTER_UUID" - <<'MSG'
[TEAM-KICKOFF task-id=<id>]
status: START
<짧은 태스크>
[/TEAM-KICKOFF]
MSG
```

엔벨로프 헤더의 `from=...` `to=...` 는 서버가 사람 가독성용 라벨로 정규화해 표시한다. 신뢰 라우팅 키는 내부적으로 uuid 기준.

초기 프롬프트에 이미 역할·프로토콜이 있으므로 kickoff 메시지는 짧아도 된다. 송신 후 `sleep 2` → `dmctl read-screen --at "$STARTER_UUID"` 으로 수신측이 처리 시작(`Thinking...`)했는지 확인. `Thinking...` 미관측 시 `dmctl send-input --at "$STARTER_UUID" --execute ""` 로 엔터 보강 후 재확인 (TUI reconciliation 지연 대비, troubleshooting 참고). 이 확인까지가 같은 턴에서 끝나야 한다 — 그 다음에야 7단계(턴 종료) 로 진행.

### 7. 팀장 턴 종료 → 답장 대기

팀장 CC 는 팀원을 실시간 감시하지 않는다. 팀원 답장은 엔벨로프 `[DONGMINAL-AGENT-MSG from=... to=...]...[/DONGMINAL-AGENT-MSG]` 로 다음 사용자 턴처럼 자동 도착. 엔벨로프 내부 `[TEAM-REPLY task-id=...]` 파싱해 결과 활용. 폴링 불필요.

여러 명의 답장이 순차 도착하면 부분 처리하거나 "현재 M/N 완료" 로 보고하고 다음 턴에서 마저 받는다. 비정상 지연은 `dmctl read-screen --at <팀원_UUID>` 로 해당 도구 진단.

### 8. 팀 해체 (사용자 확인 후)

1. **CC 종료 (포커스 안전, CC 종료만)**:
```bash
for u in "$M1" "$M2" "$M3"; do dmctl send-input --at "$u" --execute "/exit"; done
```
탭은 쉘 상태로 남는다 (사용자가 중간 로그를 볼 수 있음).

2. **탭까지 제거**: `/exit` 먼저 → 쉘 복귀 확인 → 보관해둔 팀원 uuid 들에 대해
```bash
for u in "$M1" "$M2" "$M3"; do dmctl close-tab --at "$u"; done
```
- **uuid 기반이라 라벨 reflow 영향 없음**: 한 탭을 닫으면 다른 팀원의 라벨은 옮겨질 수 있지만 uuid 는 그대로. `list-workspace` 재확인이 더는 필수가 아니다.
- `--at` 지정 `close-tab` 은 서버가 포커스를 움직이지 않는다. `dmctl focus` 는 **호출 금지**.

`/exit` 를 먼저 하는 이유: 실행 중 CC 를 바로 닫으면 "프로세스 종료?" 다이얼로그가 뜨기 때문.

---

## 체크리스트

1. [ ] `dmctl who-am-i` → BOSS **uuid** + size (라벨은 보조 표시용)
2. [ ] `scripts/plan_layout.py` 로 분할 계획 (`--boss <BOSS_UUID>`)
3. [ ] 1차 분할 `dmctl split-* --at "$BOSS_UUID" -n` → 응답 `newTabs[0].uuid` = SEED
4. [ ] (N≥2) 직교 축 `dmctl split-* "$N" --at "$SEED_UUID" -n` → 응답 `newTabs` = 팀원 **uuid** 들
5. [ ] 팀원별 `scripts/build_prompt.py` 로 대기 프롬프트 생성 (`--my-label <팀원_UUID>` `--boss <BOSS_UUID>` `--teammate <UUID>:<role>`)
6. [ ] **한 `Bash` 호출에서 `&` + `wait`** 로 `dmctl send-input --at <팀원_UUID> --execute -` 전원 기동
7. [ ] **같은 턴 안에서** `sleep 8` → Barrier `dmctl read-screen --at <팀원_UUID>` (준비 fingerprint: `╭─` + `Thinking...` 부재 + `[대기]` 텍스트). 미준비면 `sleep 3` → 재확인 최대 10회
8. [ ] **같은 턴 안에서** `dmctl msg --to <UUID>` Kickoff → `sleep 2` → `dmctl read-screen --at <UUID>` 으로 `Thinking...` 확인
9. [ ] 위 7~8 까지 끝낸 **다음에야** 팀장 턴 종료 — 답장 대기
10. [ ] 답장 파싱 → 결과 종합 → 사용자에 보고
11. [ ] 정리 여부 확인. 기본 `dmctl send-input --at <UUID> --execute "/exit"`. 요청 시 `dmctl close-tab --at <UUID>`. `dmctl focus` 금지.

---

## 더 깊이 읽을 때

- `references/layout.md` — 셀 비율 2.2, 긴 축/직교 축 휴리스틱, 포커스 안전 설계
- `references/prompt.md` — 초기 프롬프트 구조, 데드락 원인, 이스케이프
- `references/troubleshooting.md` — 실패 모드 진단 표 + 로그 위치
- `references/models_and_patterns.md` — 모델 선택 가이드 + 팀 패턴 카탈로그
- `evals/test-scenarios.md` — 검증 시나리오 (4인 팀 비평 파이프라인 등)

재사용할 팀 구성은 정의서로 저장한다 — `/dongminal:workflow`.

## tmux team agents 대비 장점

브라우저에서 팀 활동 실시간 관찰, 신뢰 채널 명시, 레이아웃이 터미널 비율에 맞춰 자동 조정, **식별자가 uuid 라 창 닫힘에 따른 라벨 reflow 무관**. 접합면이 셸 명령이라 Claude Code 외 에이전트도 같은 방식으로 참여할 수 있다.
