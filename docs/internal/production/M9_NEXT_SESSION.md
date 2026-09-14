# M9 P4 — 착수 프롬프트 (마지막 단계)

P7 이 끝났다 — 커밋 `7d064ee`(스펙) · `e4f2d04`(FR-M9-31) · `d52dcd6`·`26c8c05`
(FR-M9-34) · `b290246`(FR-M9-32) · `0f0c23a`·`7868d25`(FR-M9-33·36) ·
`96c0540`(FR-M9-35). **남은 것은 P4 하나이고 그것으로 M9 가 끝난다.**

> **P6b 의 수정이 stash 에 갇혀 있었다** (사용자 접수 — *"여전히 똑같이 한 페이지
> 위에서 고정되는 문제야"*, 원인 지목도 사용자 — *"지금 스태시된 거 아니야?"*).
> 커밋 `70c1eea` 에 `renderer.js` 가 없었다. 복원은 `91f9d9d` 이고 사용자가 실물에서
> 확인했다. **함께 드러난 것**: 복원 전에 `V-M9-29` 를 돌렸더니 6/6 초록이었다 —
> 그 검사는 지켜야 할 코드가 통째로 없어도 통과한다 (`M9_PROGRESS` §2-22).
> **재는 대상을 다시 정하는 것은 아직 안 했다.**

---

```
프로젝트: /Users/dykim/personal/dongminal

M9 **P4** 를 한다. 이것이 M9 의 마지막 단계다.
스펙은 `docs/internal/M9_SRS.md` §3 — FR-M9-15 · FR-M9-17.
작업 트리는 깨끗하다 — `git status` 로 확인하라.

## 먼저 읽을 것 (순서대로)

1. `docs/internal/M9_SRS.md` — §3 의 **FR-M9-15**(500줄 초과 20 → 10) ·
   **FR-M9-17**(GO-44 `Git *store.Store` 좁히기) · §5 의 **D-A-10**(이동만) · §7 비목표
2. `docs/internal/production/M9_PROGRESS.md` — §1 단계표·판정표 · **§2 배운 것 스물넷**
   (특히 **§2-8**(계약을 바꾸면 그 값을 grep) · **§2-12**(검사가 무엇을 재는가) ·
   **§2-22**(stash 는 커밋에서 조용히 빠진다) · **§2-24**(없는 줄 알았던 것이 이미 있었다)) ·
   **§3 실측 방법 여섯**. §3 은 그대로 다시 쓴다
3. `docs/internal/production/M8_NEXT_SESSION.md` — M8 종료 기록. 규약과 단계 종료 절차의 원본
4. FR-M9-17 을 할 때: `01-go-arch.md` P2 "인터페이스 설계" · `M8_PROGRESS` §1-1 의 GO-44·GO-39

## 남은 일 (순서)

1. **FR-M9-15 — 500줄 초과 20 → 10 이하.** 분리는 **이동만**이다(D-A-10). 판정은 "같은 테스트가
   그대로 초록" 이고 새 테스트는 쓰지 않는다. 큰 것부터: `toolclient/client.go` 893 ·
   `dmctl_run.go` 794 · `workspace/manager.go` 742 · `toolhub/manager.go` 711 · `run/store.go` 705
   (**수치는 P1 실측이다 — 다시 재라.** P7 이 `server.go`·`handlers_agent.go`·`claude_proto.go`·
   `proto.go`·`agent-pane.js` 를 키웠다)
2. **FR-M9-17 — GO-44.** 선행이 GO-39(git 실행기 통합)다. 이 단계의 범위는 **선행의 모양을
   정하는 것**까지이고, 서지 않으면 **왜 서지 않는지를 D-M9-… 로 적는다**. DoD 가 그렇게 적혀 있다
3. **V 전량** (단계 끝): `go test -race -shuffle=on -count=1 ./...` · `make gates` · `make unit` ·
   `make e2e` → `unexpected 0` → `make e2e-rebalance`
4. **문서** — `M9_PROGRESS.md`(§1 단계표·판정표·전량 · §2 배운 것) · `M9_SRS` §10 ·
   `PRODUCTION_ROADMAP.md` 의 M9 절 단계표
5. **커밋** — 단계 종료 커밋 하나 (`feat(m9): P4 — …`. **M9 가 이 단계로 끝난다**)
6. **종료 보고** — M9 가 끝나면 사용자에게 보고하고 다음 지시를 기다린다

## P7 이 넘기는 것 (읽고 이어라)

- **`V-M9-29` 는 결함을 재지 못한다** (§2-22). `renderer.js` 의 수정이 통째로 없어도 초록이었고,
  그 검사는 같은 자리를 **세 번** 밟았다(주석이 스스로 적고 있다). 재는 대상을 다시 정하는 일이
  남아 있다 — 헤드리스에서 `.xterm-scroll-area` 가 낡는 조건과 실물의 조건이 같다는 보장이 없다
- **어댑터가 `true` 를 돌려주는 자리는 "처리했다" 일 뿐이다** (§2-24 ①). `return nil, true` 는
  어떤 검사에도 걸리지 않는다 — 플랜 사용량이 거기서 여덟 달 버려졌다. 비슷한 자리를 찾으려면
  `grep -n "return nil, true" internal/shared/agentadapter/`
- **`ProtoUsage` 가 넓어졌다** (FR-M9-34). `Limits []ProtoLimit`·`ContextRatio`·`CacheRead/Write`.
  **비율의 단위는 0.0~1.0 한 벌**이고 맞추는 일은 어댑터가 한다(omp 의 `percent` 는 0~100 이라
  나눈다). 새 어댑터를 붙이면 그 규약을 먼저 본다
- **주기 이름은 카탈로그 밖 문자열이 화면에 서는 유일한 자리다** (D-M9-23). `check-i18n` 의
  예외이며 사유가 코드와 스펙 양쪽에 적혀 있다 — 지우지 마라
- **세션 신원은 `Server.agentSessions` 에 산다** (FR-M9-32). `AttnTracker` 가 아닌 이유는 그것이
  daemon 모드 전용이어서다. 서버 수명이고 훅이 다시 채운다
- **터미널 도구는 전역 `app` 을 쓴다** — 생성자가 `(id, name)` 이다. `this.app` 은 없다(§3-6)
- **비활성 탭의 DOM 은 떼어진다**(`_hideOthers`). "탭이 남았는가" 를 요소의 존재로 재면 틀린다 —
  돌아가서 본다
- **터미널 스크롤 복원은 네 자리가 한 벌이다** (FR-M9-28·29, 복원됨): `_keepTermScroll`(떼기 전
  갈무리) · `_termScrollOf` · `_restoreScrollOf`(**바닥 갈래도 흔든다**) · `_nudgeScrollArea` ·
  `_syncAfterRestore`(크기가 생긴 자리에서 흔들고 맞춘다)

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
