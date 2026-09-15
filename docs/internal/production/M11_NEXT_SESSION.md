# M11 이후 — 착수 프롬프트 (다음 단계: 어댑터 강화와 컨텍스트 사용량)

**M11 의 접수 쉰둘이 전부 닫혔다.** 열려 있는 것은 `M11-B1` 본체 하나뿐이고, 사용자가
**다음 단계의 과제 넷**을 지정했다. 전량 e2e 는 `unexpected 0` 이다.

---

```
프로젝트: /Users/dykim/personal/dongminal

## 0. 이번 단계가 할 일 — 사용자가 지정한 넷

**1. `/dongminal:migration` — 인수인계가 확인되면 탭을 묻지 않고 닫는다**

지금은 마지막에 사용자에게 확인을 구한다. 새 세션이 `working` 임을 **이미 확인한
경우**에는 그 물음이 군더더기다 — 확인의 근거가 화면이 아니라 **훅 상태**(`dmctl wait
--for ready` · `dmctl status`)이므로, 그 판정이 섰으면 닫아도 된다.
스킬은 `~/.dongminal/bin/agent-plugin/skills/migration` 에 있다.

**2. 에이전트 어댑터 강화 — 모든 에이전트가 GUI 에서 같게 동작한다**

> 사용자 지시 (반복해 온 것이다): *"agent 별로 다른 동작은 전부 adaptor 에서 끝나야
> 한다. 밖에서는 무조건 agent adaptor 를 통해 동작한다."*

**이것이 이번 단계의 본체다.** M11 이 claude 를 기준으로 GUI 를 세웠고, 그러는 동안
**어댑터 밖에 claude 의 사정이 새어 나간 자리**가 생겼다. 먼저 **그 자리를 세는 것**이
첫 일이다 — 고치기 전에 목록을 만들어라. 아는 것만 적어 둔다:

  - `agent-pane.js` 의 `agentDetail()` — `command`·`file_path` 는 **claude 의 입력 이름**이다
  - `_mkDiff()` 가 `Edit`·`Write` 와 `old_string`/`new_string` 을 안다 (FR-M11-37)
  - `_isBackground()` 가 `run_in_background` 를 안다 (FR-M11-50)
  - `AGENT_PICK_CMD_RE` 가 `/model`·`/config` 를 안다 (FR-M11-14)
  - `_openConfigPick()` 이 `key=a|b|c` 라는 **claude 의 응답 형식**을 파싱한다
  - 서브에이전트 묶기는 `parentToolUseId` 로 **공통**이다 (이쪽은 이미 어댑터를 지난다)

**codex·omp 에서 무엇이 다른지는 재야 한다** — 어느 것이 그 어댑터에 없는 개념인지,
있는데 이름만 다른지가 설계를 가른다. `fakeagent` 가 세 판을 말하므로 e2e 로 셋을
함께 재는 길이 이미 있다 (`TC-AGT-10/codex`·`/omp` 가 그 모양이다).

**3. 컨텍스트 사용량을 제대로 구한다**

> 사용자 지시: *"지금 300% 넘게 쓰고있으니까 말이야."*

**증상이 그것이다 — 우리가 그리는 비율이 100 을 크게 넘는다.** 지금 화면은
`usage.tokens / usage.contextWindow` 로 그린다 (`_setUsage`). 그 둘의 출처를 다시 재라:

  - `Tokens` 는 `claudeUsage.context()` 가 **input + cache_creation + cache_read** 를
    합친 값이다 (`claude_decode.go`)
  - `ContextWindow` 는 `result` 프레임의 `modelUsage[<model>].contextWindow` 에서 온다
  - **누적과 순간이 섞였는지**를 먼저 의심하라 — 300% 는 *한 턴의 합*을 *창*으로 나눈
    모양이 아니라 **여러 턴이 더해진** 모양이다

`/context` 명령이 실제로 무엇을 돌려주는지도 재 볼 것 (§3 의 프로토콜 실측 손).

**4. 글 쓰던 중간의 `/` 도 명령을 찾아 넣는다**

지금은 **입력 전체가 `/` 로 시작할 때만** 목록이 선다 (`_suggest` 의 `v.startsWith('/')`).
문장을 쓰다가 중간에 `/` 를 쳐도 찾아야 한다 — `FR-M11-48` 이 연 드롭다운을 **캐럿
앞의 토큰**을 보도록 넓히는 일이다. 넣을 때도 그 토큰만 갈아 끼운다(문장을 날리지 않는다).

## 1. 지금 서 있는 자리

  마지막 전량: 8샤드 `unexpected 0` · expected 1758~1761 · skipped 3
  flaky·부하성 실패는 **사유로 갈랐다** — 같은 샤드를 혼자 돌리면 231/231 통과한다

**M11 의 접수 쉰둘이 닫혔다.** 남은 하나는 `M11-B1` 본체(터미널 잔재)이며 여섯 배치를
재현하지 못했다 (`M11_SRS` §2.4~2.4d).

## 2. 이 저장소가 세운 규약 — 다음 단계도 이것을 딛는다

- **D-M11-3**: 진실은 실제 에이전트의 동작이다. 원본은 `M11_SRS` **§2.10**(화면)·
  **§2.11**(프로토콜)·**§2.13**(서브에이전트·백그라운드)에 재어 두었다
- **D-M11-4**: **주지 않는 값은 옮기지 않는다.** 원본이 보이는 것을 프로토콜이 주지
  않으면 모양만 옮기고 수는 지어내지 않는다 (`FR-CBG-5` 가 `D-M11-3` 을 이긴다)
- **D-M11-7**: **쓰면서 나온 접수는 앞선 결정을 이긴다.** 다만 뒤집을 때는 뒤집었다고
  적고, 그 계약을 재던 검사를 **같은 변경에서** 고친다
- **사용자 결정**: *"모양을 또같이 할 필요는 없다"* — 옮기는 것은 **무엇을 보여야
  하는가**이지 화면의 청사진이 아니다

## 3. 값을 치르고 배운 것 (반복하지 마라)

- **"구현 끝" 은 판단이다.** 끝났다고 보고한 뒤 감사에서 결함 다섯이 더 나왔고, 전부
  **두 기능이 만나는 자리**였다 (`M11_PROGRESS` §2-16·2-22)
- **접수의 말을 가설로 굳히지 마라.** *"특정 동작 중에 안 된다"* 의 원인은 동작이
  아니라 **포커스**였다 (§2-20)
- **고르게 한 뒤에도 재라.** 사용자가 고른 것이 실제로 그 일을 하는지는 다른 물음이다 —
  `interrupt` 만으로는 무한 대기가 남았다 (§2-21)
- **RED 를 실제로 보아라 — 검사가 틀린 것을 두 번 잡았다.** 화면으로 가를 수 없는 것은
  **나가는 요청**을 재라 (§2-17)
- **`git checkout <파일>` 로 되돌리지 마라.** 프로브는 `cp` 백업으로 되돌린다 — 그
  파일에는 거의 언제나 다른 변경이 함께 있다 (§2-23)
- **한 손이 두 접수의 뿌리일 수 있다** (§2-11) · **"에이전트가 안 해 준다" 는 재기
  전에는 가설이다** (§2-12) · **상한은 전제와 함께 읽는다** (§2-18)

## 4. 손

**원본 TUI 를 재려면:**

    dmctl new-tab -n --name "probe"        # -n 이 포커스를 뺏지 않는다
    dmctl send-input --at <uuid> --execute "cd <폴더> && claude"
    dmctl read-screen --at <uuid> --bytes 30000

`dmctl send-input` 은 **제어키를 보내지 못한다**(bracketed paste). 화살표가 필요한
실측은 사용자에게 눌러 달라고 하라. 신뢰 대화상자는 `~/.claude.json` 의
`projects.<경로>.hasTrustDialogAccepted` 를 미리 `true` 로 두면 건너뛴다 — **쓰고 나면
그 항목을 지워라** (사용자의 파일이다).

**프로토콜을 재려면** 어댑터가 쓰는 기동줄 그대로 돌린다:

    claude -p --output-format stream-json --input-format stream-json \
           --include-partial-messages --verbose --permission-mode bypassPermissions

한 줄짜리 `{"type":"user","message":{...}}` 를 stdin 으로 넣고 stdout 을 `jq` 로 센다.
승인 경로가 필요하면 `--permission-prompt-tool stdio` 를 붙이고 `control_request` 에
답하는 스크립트를 쓴다 (이 세션이 그렇게 서브에이전트를 쟀다).

**모르는 프레임을 세려면** 같은 패키지의 임시 테스트로 `ad.Proto.Decode` 를 돌린다 —
`NewProtoState()` 와 `Handshake` 를 **먼저** 거쳐야 한다(대기표·`Open` 맵이 거기서 선다).

## 5. 변하지 않는 규약

- **로컬 전량은 8샤드.** `run_in_background` 는 세션 경계에서 죽는다 — `nohup` 으로:

      nohup env PW_WORKERS=1 sh -c 'seq 1 8 | xargs -P 4 -I{} scripts/e2e-shard-run.sh {} 8' \
        > /tmp/dm-e2e.log 2>&1 &

- **판정은 `unexpected 0`.** flaky·부하성은 **사유로** 가른다 — **같은 샤드를 혼자**
  돌려 통과하면 부하다 (`PW_WORKERS=1 scripts/e2e-shard-run.sh <N> 8`)
- **RED 를 실제로 보아라.** `if(1||…) // TEMP-PROBE` 로 무력화한 뒤 되돌리고
  `grep -c TEMP-PROBE` = 0 을 확인한다
- **동작을 바꾸면 기존 검사가 떨어진다 — 같은 변경에서 고쳐라.** 이 물결에서만 여덟 번
- 색·글꼴·z-index 는 **토큰에서** · 새 문구는 `t('ns.key')` ko·en 둘 다
- 스펙에 `D-…` 를 더하면 `go run ./scripts/gen-decisions`
- 커밋 메시지에 AI 서명 금지 · 커밋은 **사용자 확인 후에만**
- **운영 인스턴스는 사용자가 `start --foreground` 로 띄운다** — 직접 죽이지 말고 요청하라
- `dmctl` 은 `DONGMINAL_PORT` 를 본다 (`PORT` 가 아니다)

## 6. 열려 있는 것

| 항목 | 상태 |
|---|---|
| **M11-B1 본체** | 접수한 화면을 **재현하지 못했다**. 닫은 것은 홀 하나(FR-M11-1)다 (§2.4~2.4d) |
| **갭 여덟** | `M11_SRS` §7 — 스킬 본문·diff 줄번호·`/config` 현재값·큐의 수명·큐 합치기의 표식 겹침·`replace_all`·**백그라운드의 내용**·(그 밖) |
| FR-STA-4 사다리 2단계 · M4 인증 계열 | 종전대로 의도적 보류·회피 |

## 7. 단계 종료 절차

DoD 가 서고 전량 e2e 가 `unexpected 0` 이면, 같은 세션 안에서 순서대로:

  1. 문서 갱신 — 진행 문서 · 스펙 §8 · **이 파일을 다음 단계의 착수 프롬프트로 다시 쓴다**
  2. `make gates` 초록 확인 뒤 **커밋** (사용자 확인 후)
  3. 인수인계 — **`/dongminal:migration`**
  4. **자기 탭을 닫는다** — 단, 새 세션이 `working` 임을 확인한 뒤에만
     (위 §0 의 1 번이 이 절차 자체를 고치는 일이다)
```
