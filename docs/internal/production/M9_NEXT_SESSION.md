# M9 — 착수 프롬프트 (P8 잔여: FR-M9-41 · 그 다음 P4)

P7 은 끝났고(`c873351`) **P8 은 넷 중 넷을 구현했으나 다섯째가 접수됐다.**
커밋: `5cd7414`(P8 본체) · `dc2d6cc`(활동 계기) · `60dba51`(버튼 모양).

**지금 할 일은 FR-M9-41 하나다** — 올린 세션의 기록을 띄우는 것. 사용자가 새
세션에서 하자고 지시했다 (2026-09-14).

> **P8 은 전량 e2e 를 아직 돌리지 못했다.** 한 회차가 결과 없이 죽었고
> (`[killed]`), 그 뒤 코드가 더 바뀌었다. FR-M9-41 을 끝낸 뒤 한 번에 돌린다.

---

```
프로젝트: /Users/dykim/personal/dongminal

FR-M9-41 (M9-B23) 을 한다. 스펙은 `docs/internal/M9_SRS.md` §3 의 그 조항이며
**설계와 실측이 거기 다 적혀 있다.** 끝나면 P4(FR-M9-15·17)로 간다 — 그것이 M9 의
마지막이다.

작업 트리는 깨끗하다 — `git status` 로 확인하라.

## 접수한 말과 이미 잰 것

사용자: *"세션 기록이 그대로 넘어가야하는데 아무것도 안보인다. 처음키는것과 같다.
기록을 그대로 띄어야한다."* 그리고 방향을 지적했다 — *"모든 에이전트가 이건 당연히
해줘야하는거 아닌가?"*

**그 지적의 두 갈래를 둘 다 실측했다.**

| 물음 | 답 |
|---|---|
| 에이전트가 resume 때 과거를 재생하는가 | **아니다.** 짧은 세션을 만들어 `--resume` 하니 새 턴의 **7줄**뿐이었다. 다만 세션은 제대로 이어진다 — *"암호가 뭐였지?"* 에 `ZEBRA-77` 로 답했다 |
| 그러면 누가 읽는가 | **어댑터다.** 기록의 자리와 형식은 에이전트마다 다르고, 그 지식을 아는 자리는 어댑터다. **계약은 이미 있다** — `ParseUsage(transcript)` 가 바로 그 함수이며 기록 파서는 그 옆에 같은 자격으로 선다 |

왜 비는가: 화면은 **우리 이벤트 로그**를 재생하는데(`apiAgentEvents` → `sess.Replay`)
올리기는 **새 `toolId`** 라 그 로그가 비어 있다. claude 세션은 이어졌지만 그릴 과거가
없다.

## 층 나누기 (스펙 FR-M9-41 의 요약 — 원문을 읽어라)

  SessionStart 훅 → `transcript_path` 도 보낸다 (지금은 `session_id` 만)
  서버           → 세션 신원과 함께 보관 (`AgentSessionInfo`)
  **어댑터**      → `ParseHistory(path, n)` — 자기 형식을 자기가 안다
  올리기         → 변환된 이벤트로 로그를 채운 뒤 도구를 연다
  화면           → **바꾸지 않는다.** 기존 재생 경로를 그대로 탄다

**부재가 뜻이다** (FR-APS-4): 기록을 읽지 못하는 어댑터에서는 빈 채로 열되 **그
사실을 문장으로 말한다.** 조용히 비면 사용자는 세션이 안 이어진 줄 안다.

**상한**: 트랜스크립트는 크다 (실측 4.1MB · 2191줄). 꼬리만 읽고 잘렸음을 표시한다 —
그 장치는 이미 있다 (`truncated`·`snapshot`, FR-ABG-21 · D-C-13).

**NFR-4 를 개정해야 한다.** `reportContext` 의 주석이 *"경로조차 보내지 않는다 —
서버는 그 파일을 열 이유가 없다"* 로 못박고 있고 이제 이유가 생겼다. **둘은 그대로
지킨다**: 훅은 내용을 실어 보내지 않는다 · `runs.json` 에 내용이 적히지 않는다
(V-CBG-11 카나리아 회귀를 반드시 확인하라).

## 실측한 트랜스크립트 형식 (다시 재지 마라)

`~/.claude/projects/<cwd-slug>/<session-id>.jsonl` — 줄마다 JSON 하나.

  user      키: message{role,content} · cwd · gitBranch · permissionMode · sessionId · timestamp
  assistant 키: message{content[],model,usage,stop_reason} · effort · requestId · sessionId
  content[] 의 type: `thinking` · `text` · `tool_use` · `tool_result`

stream-json 과 **형식이 겹친다** — `claudeDecode` 의 조각을 재사용할 수 있는지 먼저
보라. 다만 트랜스크립트는 래퍼가 다르다(최상위에 `type:"user"|"assistant"`).

## 그 다음: P4 (M9 의 마지막)

1. **FR-M9-15 — 500줄 초과 20 → 10 이하.** 분리는 **이동만**이다(D-A-10). 판정은 "같은
   테스트가 그대로 초록". **수치는 P1 실측이니 다시 재라** — P7·P8 이 `server.go`·
   `handlers_agent.go`·`claude_proto.go`·`proto.go`·`agent-pane.js` 를 키웠다
2. **FR-M9-17 — GO-44.** 선행이 GO-39 다. 범위는 **선행의 모양을 정하는 것**까지이고,
   서지 않으면 **왜 서지 않는지를 D-M9-… 로 적는다**

## 먼저 읽을 것

1. `docs/internal/M9_SRS.md` — §2.2 의 **M9-B19~23**(사용자 접수 원문) · §3 의
   **FR-M9-41** · P8 절(FR-M9-37~40) · §5 의 D-M9-20~23 · §7 비목표
2. `docs/internal/production/M9_PROGRESS.md` — §1-15·§1-16 · **§2 배운 것 스물다섯**
   (특히 **§2-22**(stash 는 커밋에서 조용히 빠진다) · **§2-23**(문서를 실측으로 읽었다) ·
   **§2-24**(없는 줄 알았던 것이 이미 있었다) · **§2-25**(홀로 싣는 검사)) · **§3 실측 방법 여섯**
3. `docs/internal/production/M9_P7_GUI_SURVEY.md` — §3.1 은 **두 번 틀렸다.** 그 경고를 읽어라

## P8 이 넘기는 것 (읽고 이어라)

- **전량 e2e 가 밀려 있다.** P8 의 코드로 한 번도 돌지 않았다
- **`V-M9-29` 는 M9-B2 의 결함을 재지 못한다** (§2-22). 수정이 통째로 없어도 초록이었고
  같은 자리를 세 번 밟았다. 재는 대상을 다시 정하는 일이 남아 있다
- **꼬리에서 이름 둘** (D-M9-11): `git-changes` V78(P7 ①②연속) · `git-worktrees` V169
- **`initialize` 응답은 우리가 아는 것보다 많이 싣는다** — `account`(구독 종류) ·
  `output_style` · `available_output_styles` · `fast_mode_state` · `session_state` ·
  `agents` · `commands`. 화면에 더할 것을 찾을 때 여기부터 보라
- **신원 갱신 계기는 둘이다**: 탭 이동(`moved`)과 **활동 신호**(`_noteLiftable`).
  하나만 두면 사용자가 겪은 그 결함이 돌아온다 — 셸에서 claude 를 띄우는 순간 그 탭은
  **이미 보이는 중**이라 이동이 없다
- **`SessionStart` 훅은 세션이 시작될 때만 난다.** 이미 도는 세션은 재시작 뒤에도
  신원이 바로 안 잡히고, 활동 훅이 채운다
- **어댑터가 `true` 를 돌려주는 자리는 "처리했다" 일 뿐이다** (§2-24 ①).
  `grep -n "return nil, true" internal/shared/agentadapter/`

## 사용자 결정·지시 (유효)

- 자격증명이 없으면 무모델까지만 실측 — 사용자에게 자격증명을 묻지 않는다
- 출력에 이모티콘을 쓰지 않는다
- (D-M9-6) 인계는 **문서 + 엔벨로프 두 벌**. 문서의 경로는 스킬이 정하지 않는다
- (M9-B6) `team` 스킬은 오케스트레이션 전용 — 인수인계는 `migration` (P3 에서 못박았다)
- (D-M9-11, 2026-09-14) **flaky 가 회차마다 달라지면 붙잡지 않는다.** 판정은 `unexpected 0`
- (D-M9-1) 노출 게이트는 없다. **인증은 M9 의 비목표다**

## 변하지 않는 규약

- **로컬 전량은 `make e2e`** (8샤드 병렬, ~5분). 판정 `unexpected 0`. 겹쳐 돌리지 마라
  (`pgrep -f e2e-shard-run.sh` 0 확인 뒤 `run_in_background` 하나). **주의**: `pgrep -fl
  e2e-shard-run` 은 자기 대기 루프의 명령줄도 잡는다 — 패턴을 `e2e-shard-run.sh` 로 좁혀라
- **전량이 도는 동안 제품 소스를 건드리지 마라 — Go 도 포함이다.** 샤드마다 시작할 때
  `go build` 를 하므로 그 순간 빌드가 깨져 있으면 그 샤드가 통째로 죽는다 (§2-9). 문서는 된다
- **`make e2e-rebalance` 는 전량 직후다.** 표적 실행이 `test-results/` 의 샤드별
  `report.json` 을 덮는다 (§2-10)
- **flaky 를 판정할 때는 `report.json` 을 먼저 읽어라** (§2-14 ②). 거기에 실패한 **줄 번호와
  실제 값**이 있고, 그것이 `--repeat-each` 재현보다 강한 증거다. 부하에서만 나는 실패는
  단독 반복으로 만들지 못한다
- **출력을 자르지 마라.** `LC_ALL=C grep -a` 로 읽어라
- 동작을 바꾸면 근거 문서를 같은 변경에서 고친다 (이전/새/이유)
- **RED 를 실제로 보아라** — `git stash push <바꾼 파일>` → 실행 → `stash pop`.
  P3 에서 이것이 세 번 값을 했다: TC-GOR-1 의 기전을 `p._wdTryAt = Date.now()` 로 **같은 줄·
  같은 값**으로 재현했고, `migration` 스킬을 치우자 계약 검사가 떨어졌으며, `client_test.go` 를
  stash 하자 내가 만든 회귀가 사라졌다
- **계약을 바꾸면 그 값을 `grep` 해라** — 파일이 아니라 **값**이다. 그리고 고칠 것은 검사만이
  아니다 — 그 검사가 딛는 **다른 SRS 의 조항**도 함께 개정한다
- **검사가 무엇을 *재는지*도 대상이다** (§2-12). 증상을 재는 검사는 그 증상을 없애는 **아무**
  경로에나 초록을 준다. 요구가 보장하려는 것을 직접 재라
- **요구의 낱말은 조건이다** (§2-13). "끊겼다 **다시** 붙으면" 의 "다시" 를 빠뜨린 한 줄이
  `session.spec.ts` 를 6/6 깨뜨렸다. 내 검사 넷은 전부 초록이었다 — 전량이 그것을 잡았다
- **상한 둘이 같은 크기면 안쪽이 바깥을 밀어낸다** (FR-CEM-21, P3). 테스트 하나의 상한(90초)은
  안쪽 대기의 상한(60초)보다 커야 한다 — 같으면 실패 메시지가 무엇을 기다렸는지 말하지 않는다
- 새 문구는 `t('ns.key')` — ko·en 둘 다 (`check-i18n.mjs`)
- 설정 키는 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` + `helpers.js` + `index.html` + ko·en
- 오류 코드는 `apierr/codes_core.go`·`codes_doc.go` → `go run ./scripts/gen-errors` · 프론트 문장은 `err.<code>`
- 스펙에 D-… 를 더하면 `go run ./scripts/gen-decisions` · dmctl 명령을 바꾸면 `commands.md`(check-commands-docs)
- e2e 의 고정 대기에는 **`TEST-16` 표식과 사유**가 필요하다 (`make gates` 가 잡는다).
  "일어나지 않음" 을 재는 관측 창만 예외다
- **e2e 는 `app.testing.<이름>` 만 쓴다** (`check-e2e-internals`). **주석도 걸린다** — P3 가
  `app._gitWdAt` 을 주석에 적었다가 게이트에 잡혔다
- SRS 머리의 문서 상태는 **enum 안**이어야 한다 (`초안`·`승인대기`·`승인·구현중`·`승인·구현완료`·`폐기`·`대체`)
- z-index 는 층 토큰에서 온다 — 숫자 리터럴 금지 (`check-z-index.mjs`)
- 하네스를 복사하지 마라 · 에이전트 이름을 등록부 밖에 적지 마라(`check-agent-names`)
- 커밋 메시지에 AI 서명 금지
- dmctl 주의: `new-tab`/`close-tab` 은 `--help` 를 받지 않는다. `close-tab` 에는 `--force` 가 있다
- **격리 인스턴스를 멈출 때 `--port` 와 `--home` 을 함께 줘라.** 한쪽만 주면 나머지는
  환경변수가 채우고 이 워크스페이스의 환경은 언제나 **운영**을 가리킨다 (§2-11)
- **운영 인스턴스는 사용자가 `start --foreground` 로 띄운다.** 재시작이 필요하면 직접
  죽이지 말고 사용자에게 요청하라 — 그 창이 어디인지는 사용자만 안다

## 단계 종료 절차 (사용자 지시 2026-09-13 — 모든 단계에 같다)

단계의 DoD 가 서고 전량 e2e 가 `unexpected 0` 이면, 같은 세션 안에서 순서대로:

  1. 문서 갱신 — `M9_PROGRESS.md` · 스펙 §10 · 로드맵 M9 절 · **이 파일을 다음 단계의 착수
     프롬프트로 다시 쓴다** (이 절을 그대로 옮긴다)
  2. `make gates` 초록 확인 뒤 **커밋** (단계 종료 커밋 하나 — 이 지시가 그 확인이다)
  3. 인수인계 — **`/dongminal:migration` 스킬을 쓴다** (P3 에서 만들었다). 스킬이 담고 있는
     절차가 이것이다:
       `dmctl new-tab -n` (`--at` 없이) → `newTabs[0]` 의 uuid·toolId
       `dmctl rename-tab --at <탭> "M9-P<n+1>"`
       `dmctl send-input --at <탭> --execute "cd '$PWD' && <이 세션을 띄운 에이전트 명령>"`
       `dmctl wait --at <탭> --for ready --timeout-ms 180000`
       (rc=5 면 `dmctl read-screen --at <탭>` 으로 무엇을 묻는지 보고 처리)
       `dmctl msg --to <toolId> -` 로 `[HANDOFF M9 P<n> → P<n+1>]` 엔벨로프 — 이 파일을 읽고
       진행하라는 한 문단 + 커밋 해시
       `dmctl status --at <탭>` 로 `working` 확인 (idle 이면 `send-input --execute ""`)
  4. **자기 탭을 닫는다** — `dmctl close-tab --at <자기 탭 uuid> --force` (`dmctl who-am-i` 의
     `uuid=`). 세션의 마지막 명령이다
```
