# M9 P3 — 착수 프롬프트 (migration 스킬 · 고정 대기 · flaky 군집)

P2 는 끝났다 — 커밋 `2d10e86`. **P3 는 착수 전**이다. 아래 블록이 착수 세션의 지시 전부다.

---

```
프로젝트: /Users/dykim/personal/dongminal

M9 P3 을 한다 — 스펙 `docs/internal/M9_SRS.md` §4 의 P3: FR-M9-6(`migration` 스킬) ·
FR-M9-13·14(고정 대기) · FR-M9-16(§5-5 flaky 군집, 전량 3회 연속 0).
작업 트리는 깨끗하다 — `git status` 로 확인하라.

## 먼저 읽을 것 (순서대로)

1. `docs/internal/M9_SRS.md` — §3.1 의 FR-M9-6 · §3.2 의 FR-M9-13·14·16 · §5 의 D-M9-6 ·
   §7 비목표 · §2.1 의 M9-A2(군집의 이름 다섯)
2. `docs/internal/production/M9_PROGRESS.md` — §1 단계표·판정표 · **§2 배운 것 열셋**
   (특히 §2-12: 검사가 **증상**을 재면 부수 경로가 대신 답한다 — P2 가 값을 치른 자리) ·
   **§3 실측 방법 넷**. §3 은 그대로 다시 쓴다
3. `docs/internal/production/M8_NEXT_SESSION.md` — M8 종료 기록. 규약과 단계 종료 절차의 원본
4. FR-M9-6 을 할 때: `internal/shared/runtime/agentplugin/skills/{team,workflow}/SKILL.md` 와
   **이 파일의 단계 종료 절차 3·4**(그것이 스킬이 자동화할 본이다)

## 남은 일 (순서)

1. **FR-M9-16 을 먼저 띄운다** — 전량 3회 연속 flaky 0 이 판정이므로 시간이 가장 오래
   걸린다. `git-*` 관측 주기 대기 다섯(`git-observe-revive`·`git-worktrees`·`git-history`·
   `git-live-triggers`·`git-sidebar`)과 `slot-view-state` 가 대상이다. 판정할 것은 두
   헬퍼가 **"요청이 왔는가"** 를 기다리는지 **"화면이 반영했는가"** 를 기다리는지다
2. **FR-M9-6 — `migration` 스킬**. 하는 일은 하나다: 지금 pane 에 새 탭을 열고 에이전트를
   띄운 뒤 이번 세션의 일을 잇게 한다. 인계는 **두 벌**이다(D-M9-6) — 문서 한 장 + `dmctl msg`
   엔벨로프로 "그 문서를 읽고 진행하라". 절차의 본은 아래 단계 종료 절차 3·4 다.
   함께: `team/SKILL.md` 머리에 "이 스킬은 오케스트레이션 전용 — 인수인계는 `migration`" 을 못박는다
3. **`bg-kill-touch` TC-BGK-12t — FR-M9-11 의 후속** (P2 전량이 새로 보였다). P1 은
   `bg-kill.spec.ts:284` 의 불투명도 단정을 `expect.poll` 로 고쳤는데 **`bg-kill-touch.spec.ts:74`
   에 옛 형태가 그대로 남아 있다** (`expect(await btn.evaluate(…opacity)).toBe('1')`).
   고치는 법은 이미 있다 — P1 이 검증한 그 형태를 그대로 쓰고 `--repeat-each=16` 으로 확인하라
4. **FR-M9-13·14 — 고정 대기**. `sandboxplace/e2e_test.go` 의 700·700·900·900ms 넷과
   `time.Sleep` 98 의 분류(① 조건 대기 ② 폴링 간격 ③ 부정 단정의 관측 창). **①만 옮긴다**
5. **M9-B2 (이월)** — 아래 "B2 의 지금 상태" 절을 보라. 사용자 로그가 오면 그것이 판정한다
6. **V 전량** (단계 끝): `go test -race -shuffle=on -count=1 ./...` · `make gates` · `make unit` ·
   `make e2e` → `unexpected 0` → `make e2e-rebalance`
7. **문서** — `M9_PROGRESS.md`(§1 단계표·판정표·전량 · §2 배운 것) · `M9_SRS` §10 ·
   `PRODUCTION_ROADMAP.md` 의 M9 절 단계표 · 이 파일을 P4 착수 프롬프트로
8. **커밋** — 단계 종료 커밋 하나 (`feat(m9): P3 — …`)
9. **인수인계** — 아래 절차. M9 가 끝나면 사용자에게 종료를 보고하고 다음 지시를 기다린다

## B2 의 지금 상태 (P2 가 남긴 것 — 읽고 이어라)

**재현하지 못했지만 기전은 확정됐다.** 사용자가 `?diag=1` 로그를 보냈고 그것이 재현을
대신했다 (`M9_PROGRESS` §1-4, 근거 `/tmp/m9-b2/b2-evidence.txt` — 휘발성이니 필요하면
저장소로 옮겨라).

확정된 것:
- `_restoreScrollOf` 는 **돌고 있다.** P1 의 가설 ③(안 돈다)은 틀렸다 — 흔들기 두 줄이
  로그에 그대로 찍혔다
- 복원이 **틀린 자리로 정확히 복원한다.** 사용자가 둔 자리는 `vY=174`, 복원은 `96`
- 한 번 `ydisp!==ybase` 가 되면 xterm 이 새 출력을 따라가지 않아 **영영 안 내려간다** —
  이것이 접수한 증상이다
- 구조적 결함: `_grabScroll` 이 **요소가 떨어진 뒤** 읽는다 (`grab … conn=false vis=false`
  를 실측으로 찍었다). 편집기는 `FR-VSR-2` 로 "떼기 전 갈무리" 로 이미 고쳤고 **터미널만
  그 규약 밖**이다
- 두 기기가 아니다 (사용자 확인) — 한 브라우저, 사이드바로 창 둘, **문제는 49줄 창**

모르는 것: `174 → 96` 을 만든 것. 그 구간은 요소가 문서 밖이라 `term.onScroll` 이 나지
않아 로그가 비어 있다. 재현 시도 넷이 전부 `vY` 를 보존했다(창 왕복 두 가지 · `rows`
왕복 · TUI 재그리기).

**그래서 `diag.js` 에 계측 셋을 심었다** — `ydisp` 200ms 폴링(`conn`·`vis` 와 함께) ·
`grab` · `restore`. 사용자가 운영 인스턴스를 새 바이너리로 재시작하고 `?diag=1` 로 쓰다가
현상이 나면 보내기를 누른다. **그 로그의 `ydisp … conn=false vis=false` 한 줄이 범인을
지목한다.** 로그가 오기 전에는 고치지 마라 — 재현 없이 고치면 검사가 결함 위에서 초록이
된다 (§2-4, 그리고 P2 가 §2-12 에서 다시 겪었다).

## 사용자 결정·지시 (유효)

- 자격증명이 없으면 무모델까지만 실측 — 사용자에게 자격증명을 묻지 않는다
- 출력에 이모티콘을 쓰지 않는다
- (D-M9-6) 인계는 **문서 + 엔벨로프 두 벌**. 문서의 경로는 스킬이 정하지 않는다 —
  진행 중인 작업에 규약이 있으면 그것을 쓴다
- (M9-B6) `team` 스킬은 오케스트레이션 전용으로 못박는다
- (FR-M9-10, 2026-09-14) 구현을 유지하고 **보장으로** 검증한다 — 증상은 부수 경로가
  가리고 있었다 (§2-12)
- (D-M9-1) 노출 게이트는 없다. **인증은 M9 의 비목표다**

## 변하지 않는 규약

- **로컬 전량은 `make e2e`** (8샤드 병렬, ~7분). 판정 `unexpected 0`. 겹쳐 돌리지 마라
  (`pgrep -fl e2e-shard-run` 0 확인 뒤 `run_in_background` 하나)
- **전량이 도는 동안 제품 소스를 건드리지 마라 — Go 도 포함이다.** 샤드마다 시작할 때
  `go build` 를 하므로 그 순간 빌드가 깨져 있으면 그 샤드가 통째로 죽는다 (§2-9). 문서는 된다
- **`make e2e-rebalance` 는 전량 직후다.** 표적 실행이 `test-results/` 의 샤드별
  `report.json` 을 덮는다 (§2-10)
- **출력을 자르지 마라.** `LC_ALL=C grep -a` 로 읽어라
- 동작을 바꾸면 근거 문서를 같은 변경에서 고친다 (이전/새/이유)
- **RED 를 실제로 보아라** — `git stash push <바꾼 파일>` → 실행 → `stash pop`.
  P2 에서 이것이 두 번 값을 했다: JS 단위 셋과 e2e 둘이 실제로 떨어지는 것을 확인했고,
  FR-M9-10 의 첫 검사가 **구현 없이 초록**임을 잡아 검사를 다시 쓰게 했다 (§2-12)
- **계약을 바꾸면 그 값을 `grep` 해라** — 파일이 아니라 **값**이다. P2 는 `OpSize` 를
  프레임 순서에 끼워 넣고 그 순서를 못박던 검사 하나를 그렇게 찾았다. 그리고 고칠 것은
  검사만이 아니다 — 그 검사가 딛는 **다른 SRS 의 조항**도 함께 개정한다 (P2 는
  `TERMINAL_RESUME_SRS` FR-TRS-8·10 을 고쳤다)
- **검사가 무엇을 *재는지*도 대상이다** (§2-12). 증상을 재는 검사는 그 증상을 없애는
  **아무** 경로에나 초록을 준다. 요구가 보장하려는 것을 직접 재라
- **요구의 낱말은 조건이다** (§2-13). P2 는 "끊겼다 **다시** 붙으면" 에서 "다시" 를 빠뜨려
  최초 연결까지 걸었고, 그 한 줄이 `session.spec.ts` 의 이름 바꾸기를 6/6 깨뜨렸다.
  **내 검사 넷은 전부 초록이었다** — 그것들은 요구가 *말하는* 경로만 보았고 요구가
  *건드리는* 경로는 보지 않았다. 전량이 있는 이유가 그것이다
- 새 문구는 `t('ns.key')` — ko·en 둘 다 (`check-i18n.mjs`)
- 설정 키는 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` + `helpers.js` + `index.html` + ko·en
- 오류 코드는 `apierr/codes_core.go`·`codes_doc.go` → `go run ./scripts/gen-errors` · 프론트 문장은 `err.<code>`
- 스펙에 D-… 를 더하면 `go run ./scripts/gen-decisions` · dmctl 명령을 바꾸면 `commands.md`(check-commands-docs)
- e2e 의 고정 대기에는 **`TEST-16` 표식과 사유**가 필요하다 (`make gates` 가 잡는다).
  "일어나지 않음" 을 재는 관측 창만 예외다
- SRS 머리의 문서 상태는 **enum 안**이어야 한다 (`초안`·`승인대기`·`승인·구현중`·`승인·구현완료`·`폐기`·`대체`)
- z-index 는 층 토큰에서 온다 — 숫자 리터럴 금지 (`check-z-index.mjs`)
- 하네스를 복사하지 마라 · 에이전트 이름을 등록부 밖에 적지 마라(`check-agent-names`)
- 커밋 메시지에 AI 서명 금지
- dmctl 주의: `new-tab`/`close-tab` 은 `--help` 를 받지 않는다. `close-tab` 에는 `--force` 가 있다
- **격리 인스턴스를 멈출 때 `--port` 와 `--home` 을 함께 줘라.** 한쪽만 주면 나머지는
  환경변수가 채우고 이 워크스페이스의 환경은 언제나 **운영**을 가리킨다 (§2-11).
  기동 출력이 찍어 주는 `정지: …` 줄을 그대로 쓰는 것이 가장 안전하다
- **운영 인스턴스는 사용자가 `start --foreground` 로 띄운다.** 재시작이 필요하면 직접
  죽이지 말고 사용자에게 요청하라 — 그 창이 어디인지는 사용자만 안다

## 단계 종료 절차 (사용자 지시 2026-09-13 — 모든 단계에 같다)

단계의 DoD 가 서고 전량 e2e 가 `unexpected 0` 이면, 같은 세션 안에서 순서대로:

  1. 문서 갱신 — `M9_PROGRESS.md` · 스펙 §10 · 로드맵 M9 절 · **이 파일을 다음 단계의 착수
     프롬프트로 다시 쓴다** (이 절을 그대로 옮긴다)
  2. `make gates` 초록 확인 뒤 **커밋** (단계 종료 커밋 하나 — 이 지시가 그 확인이다)
  3. 인수인계 — dongminal 접합면으로 **현재 위치에 새 탭**을 열고 claude 를 띄운다:
       `dmctl new-tab -n` (`--at` 없이) → `newTabs[0]` 의 uuid·toolId
       `dmctl rename-tab --at <탭> "M9-P<n+1>"`
       `dmctl send-input --at <탭> --execute "cd '$PWD' && claude"` → `dmctl wait --at <탭> --for ready --timeout-ms 180000`
       (rc=5 면 `dmctl read-screen --at <탭>` 으로 무엇을 묻는지 보고 처리)
       `dmctl msg --to <toolId> -` 로 `[HANDOFF M9 P<n> → P<n+1>]` 엔벨로프 — 이 파일을 읽고
       진행하라는 한 문단 + 커밋 해시
       `dmctl status --at <탭>` 로 `working` 확인 (idle 이면 `send-input --execute ""`)
  4. **자기 탭을 닫는다** — `dmctl close-tab --at <자기 탭 uuid>` (`dmctl who-am-i` 의 `uuid=`).
     세션의 마지막 명령이다. `--force` 를 쓰면 확인창 없이 닫힌다
```
