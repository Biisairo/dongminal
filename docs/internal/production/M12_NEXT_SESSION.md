# M12 이어서 — 착수 프롬프트 (백그라운드·서브에이전트·todo·플러그인)

**FR-M12-1~15 가 구현·검증되어 커밋됐다.** 그 뒤 사용자가 **일곱을 더 접수**했고
**전부 재어 원인을 확정했다** — 남은 일은 옮기는 것이다.

---

```
프로젝트: /Users/dykim/personal/dongminal

## 0. 먼저 읽을 것

`docs/internal/M12_SRS.md` — 이번 단계의 스펙.
  §2.1  누수 목록 열둘 (FR-M12-1~12 로 닫혔다)
  §2.3b **§2.3 의 결론을 뒤집은 절** — 실측의 표본이 현상을 담는지 묻는 법
  §3    FR-M12-16~22 가 **이번에 할 일**이다. 전부 실측 근거가 본문에 있다
  §7    갭

`docs/internal/production/M12_PROGRESS.md` §3 — 재는 손 (claude 두 턴 · omp 프레임 모양).

## 1. 할 일 — 일곱, 전부 원인이 확정돼 있다

  FR-M12-13  모르는 프레임 여섯을 어댑터가 해석한다
  FR-M12-16  **서브에이전트 카드에 도구가 한 줄도 안 선다**
  FR-M12-17  `Agent` 의 detail 이 JSON 원문이다 — `description` 이어야 한다
  FR-M12-18  **Ctrl+B** — 도는 작업을 백그라운드로
  FR-M12-19  **bg·서브에이전트를 모아 보인다** (원본처럼)
  FR-M12-20  **todo 목록을 보인다**
  FR-M12-21  **GUI 에이전트가 플러그인을 못 든다** — `/dongminal:*` 이 안 보인다
  FR-M12-22  `Cmd/Alt+Shift+좌우` 로 **고르기**
  FR-M12-23  **멈춘 것을 오류로 적는다** — 턴 12개 중 7개가 거짓 오류였다

**순서 제안**: 23 → 21 → 13 → 19 → 18 → 16 → 17 → 20 → 22.
23 이 맨 앞인 이유는 **가장 자주 보이는 거짓**이고 고침이 작기 때문이다.
21 이 먼저인 이유는 그것이 **이 세션 자신의 손**을 되찾아 주기 때문이다 (아래 §4).

### 재어 둔 것 — 다시 재지 마라

**Ctrl+B 와 작업 목록의 프로토콜** (CLI 2.1.273 바이너리의 SDK 클라이언트):

    async stopTask(e){ await this.request({subtype:"stop_task", task_id:e}) }
    async backgroundTasks(e){ return (await this.request({
        subtype:"background_tasks", tool_use_id:e })).response.backgrounded ?? true }

**bg 와 서브에이전트는 한 개념이다** — `task_type` 이 `local_bash` · `local_agent` 다.
원본이 모아 적는 함수도 그대로 있다:

    local_bash          → "1 shell" / "N shells"   (kind==="monitor" 이면 "N monitors")
    local_agent         → "1 local agent" / "N local agents"
    in_process_teammate → "N teams"

살아 있는 목록은 `system:background_tasks_changed{tasks:[…]}` 가 **매번 통째로** 준다.

**모르는 프레임 여섯** (사용자 로그 4096 중 raw 124 + 서브에이전트 캡처에서 하나 더):

    system:task_started · system:task_updated · system:task_notification
    system:background_tasks_changed · system:task_progress · tool_progress

`task_notification` 에 **`status`·`output_file`·`summary`** 가 있다 — 백그라운드의
*결과*가 거기 있다.

**덤으로 찾은 것**: `control_request{subtype:"get_context_usage", detail:"summary"|"full"}`
— 컨텍스트를 에이전트가 직접 말해 주는 제어다. 지금 방식(`iterations[-1]`)도 맞으므로
**이번엔 두었다** (§7 의 갭).

**재는 손**: CLI 바이너리에서 문자열을 뽑아 본다.

    strings ~/.local/share/claude/versions/<판> > /tmp/cli.strings
    grep -oE 'subtype:"[a-z_]+"' /tmp/cli.strings | sort -u

## 2. 값을 치르고 배운 것 (반복하지 마라)

- **실측의 표본이 현상을 담는지 물어라.** *"두 턴을 쟀다"* 를 근거로 들었는데 재야
  했던 것은 턴의 수가 아니라 **턴 안의 요청 수**였다 — 도구를 안 쓰는 턴은 합과
  순간이 같은 수다 (§2.3b)
- **한 수치가 둘 이상의 결함을 가질 수 있다.** 첫 고침 뒤 증상이 남으면 *"안
  고쳐졌다"* 가 아니라 **"둘이었다"** 를 먼저 의심한다 — 라이브 상태를 읽고서야 갈렸다
- **`FR-CBG-5`("모른다 ≠ 0")를 인용한 주석일수록 그 '모른다' 가 실측인지 다시 봐라.**
  이번 단계에서 **두 번** 틀렸다 — omp 의 명령 설명(L8)과 백그라운드 진행(`M11_SRS`
  §7). 둘 다 *"프로토콜이 주지 않는다"* 로 적혀 있었고 둘 다 주고 있었다
- **누수는 틀린 답보다 *우연히 맞은 답*으로 더 오래 산다** — 프로브를 세 판 모두에
  돌려야 갈린다 (omp 가 `command` 키로 우연히 맞고 있었다)
- **흉내가 원본보다 빠르거나 적으면 검사가 헛돈다.** 이번에 셋을 고쳤다 — fake 에
  `config` 를 더하고, 끊김의 `result` 를 늦추고, 명령 **수**를 박은 단언을 지웠다
- **e2e 를 겹쳐 돌리지 마라.** 배경 전량 중에 앞단에서 또 돌리면 실패가 부하로
  번진다 — 한 번에 22건이 그렇게 났고 둘만 진짜였다
- **`git checkout <파일>` 로 프로브를 되돌리지 마라** — `cp` 백업으로

## 3. 변하지 않는 규약

- **로컬 전량은 8샤드.** `run_in_background` 는 세션 경계에서 죽는다 — `nohup` 으로:

      nohup env PW_WORKERS=1 sh -c 'seq 1 8 | xargs -P 4 -I{} scripts/e2e-shard-run.sh {} 8' \
        > /tmp/dm-e2e.log 2>&1 &

- **판정은 `unexpected 0`.** flaky 는 **같은 샤드를 혼자** 돌려 통과하면 부하다
- **RED 를 실제로 보아라.** 화면으로 가를 수 없으면 **나가는 요청**을 재라
- **동작을 바꾸면 기존 검사가 떨어진다 — 같은 변경에서 고쳐라**
- 색·글꼴·z-index 는 **토큰에서** · 새 문구는 `t('ns.key')` ko·en 둘 다
- 스펙에 `D-…` 를 더하면 `go run ./scripts/gen-decisions`
- 새 API 라우트를 더하면 `docs/external/api.md` 에도 (`make gates` 가 잡는다)
- 커밋 메시지에 AI 서명 금지 · 커밋은 **사용자 확인 후에만**
- **운영 인스턴스는 사용자가 `start --foreground` 로 띄운다** — 직접 죽이지 말고 요청하라
- `dmctl` 은 `DONGMINAL_PORT` 를 본다 (`PORT` 가 아니다)

## 4. 이 세션이 GUI 라면 — 주의

**FR-M12-21 이 고쳐지기 전에는 `/dongminal:migration` 을 쓸 수 없다.** GUI 에이전트는
`--plugin-dir` 없이 뜨므로 그 명령이 목록에 없다. 다음 인계가 필요하면:

  1. FR-M12-21 을 먼저 고치고 **서버를 다시 띄워 달라고 사용자에게 요청**하거나
  2. 터미널 탭에서 도는 claude 로 인계하거나
  3. 인계 문서를 갱신하고 사용자에게 말한다

## 5. 이 저장소가 세운 규약

- **D-M11-3**: 진실은 실제 에이전트의 동작이다
- **D-M11-4**: **주지 않는 값은 옮기지 않는다** — 다만 **주는 값은 버리지 않는다**
- **D-M11-7**: 쓰면서 나온 접수는 앞선 결정을 이긴다 — 뒤집었다고 적고 검사를 고친다
- **D-M12-1**: 어댑터가 **옮기는 것은 값**, **선언하는 것은 능력**
- **D-M12-2**: 값이 있는데 안 읽는 것과 값이 없는 것은 다르다
- **D-M12-3**: 못 고른 것은 비우고, **비운 것은 화면까지 간다**
- **사용자 지시 (반복)**: *"agent 별로 다른 동작은 전부 adaptor 에서 끝나야 한다.
  밖에서는 무조건 agent adaptor 를 통해 동작한다"*

## 6. 단계 종료 절차

  1. 문서 갱신 — 진행 문서 · 스펙 §8 · **이 파일을 다음 착수 프롬프트로 다시 쓴다**
  2. `make gates` 초록 · 전량 e2e `unexpected 0` 뒤 **커밋** (사용자 확인 후)
  3. 인수인계 — `/dongminal:migration` (§4 의 주의를 먼저 읽어라)
```
