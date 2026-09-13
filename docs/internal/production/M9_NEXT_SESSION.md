# M9 — 착수 프롬프트 (M8 유산 + 사용자 이슈 9건)

M8 은 끝났다(`fc6db80`, 종료 기록 `M8_NEXT_SESSION.md`). **M9 는 착수 전**이다. 아래 블록이 착수 세션의 지시 전부다.

---

```
프로젝트: /Users/dykim/personal/dongminal

M9 를 한다 — 스펙 초안 `docs/internal/M9_SRS.md` §2 의 16항목: M9-A1~A7(M8 이 사유와 함께 남긴 것) +
M9-B1~B9(사용자 이슈). 작업 트리는 깨끗하다 — `git status` 로 확인하라.

## 먼저 읽을 것 (순서대로)

1. `docs/internal/M9_SRS.md` 전체 — §2.1·§2.2 표가 범위다. §3~§5 는 비어 있고 네가 채운다
2. `docs/internal/production/M8_NEXT_SESSION.md`(M8 종료 기록) — 규약·단계 종료 절차
3. `docs/internal/M8_UNIFIED_SRS.md` §5 의 D-A-10~27 · `docs/internal/production/M8_PROGRESS.md` §2-35~2-39
   (P7 이 배운 것 — 특히 §2-39: "flaky" 는 먼저 `--repeat-each` 로 재현한다)
4. 항목마다 §2.2 표의 "착수 시 볼 자리" — 추정이다. 사실은 코드에서 잰다

## 남은 일 (순서)

1. **재감사** — 16항목 각각을 지금 코드·실제 화면에서 재현/측정한다. 사용자 이슈(B)는 **재현부터**:
   dongminal 격리 인스턴스(`dongminal start --isolated`)와 Playwright(모바일 폭 포함)로. 재현되지 않으면
   조건을 좁혀 적고, 끝내 안 되면 "재현 실패 — 조건" 으로 스펙에 남긴다. B3(렌더)는 여러 방향 —
   리사이즈 소유·재생 스냅샷·기기 간 cols/rows 차이·xterm 리플로우를 각각 가설로 세워 반증한다
2. **스펙 확정** — M9_SRS §3 요구(FR-M9-n·DoD) · §4 단계 · §5 결정(D-M9-n) · §7 비목표. 유효한 구현이
   복수이거나 동작 변경 위험이 있는 결정(예: B4 옵션 이름·기본값, B5 미니맵 끄기 vs 폭 보정, B6 스킬의
   인계 형식, B7 모바일 버튼 배치)은 **AskUserQuestion 으로 하나씩, 권장안과 함께** 묻고 해소한다.
   코드를 보면 답이 나오는 것은 묻지 않는다
3. **구현** — 단계마다 Spec → Test → Code. 분리는 이동만(D-A-10). 동작 변경은 이전/새/이유를 근거 문서에
4. **V 전량** (단계 끝마다): `go test -race -shuffle=on -count=1 ./...` · `make gates` · `make unit` ·
   `make e2e` → `unexpected 0` → `make e2e-rebalance`. M9-A2 의 판정은 전량 3회 연속 flaky 0
5. **문서** — `docs/internal/production/M9_PROGRESS.md`(M8_PROGRESS 형식: §1 단계표·판정표·전량, §2 배운 것) ·
   M9_SRS §10 · 로드맵 `PRODUCTION_ROADMAP.md` 에 M9 절 · 이 파일을 다음 단계 착수 프롬프트로
6. **커밋** — 단계 종료 커밋 하나 (`feat(m9): P<n> — …`)
7. **인수인계** — 아래 절차. M9 가 끝나면 사용자에게 종료를 보고하고 다음 지시를 기다린다

## 사용자 결정·지시 (M8 에서 이어진 것)

- 자격증명이 없으면 무모델까지만 실측 — 사용자에게 자격증명을 묻지 않는다
- 출력에 이모티콘을 쓰지 않는다
- (M9-B6) 현재 `team` 스킬은 오케스트레이션 전용으로 못박는다 — 인수인계는 새 `migration` 스킬의 것

## 변하지 않는 규약

- **로컬 전량은 `make e2e`** (8샤드 병렬, ~7분). 판정 `unexpected 0`. 겹쳐 돌리지 마라(`pgrep -fl e2e-shard-run`
  0 확인 뒤 `run_in_background` 하나) · 전량 중 `web/js`·CSS·`scripts/`·`e2e/` 를 고치지 마라 · 직후 `make e2e-rebalance`
- **출력을 자르지 마라.** `LC_ALL=C grep -a` 로 읽어라
- 동작을 바꾸면 근거 문서를 같은 변경에서 고친다 (이전/새/이유)
- 새 문구는 `t('ns.key')` — ko·en 둘 다 (`check-i18n.mjs`)
- 설정 키는 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` + `helpers.js` + `index.html` + ko·en — TC-CFG-4 개수(지금 25)를 올려라
- 오류 코드는 `apierr/codes_core.go`·`codes_doc.go` → `go run ./scripts/gen-errors` · 프론트 문장은 `err.<code>`
- 스펙에 D-… 를 더하면 `go run ./scripts/gen-decisions` · dmctl 명령을 바꾸면 `commands.md`(check-commands-docs)
- 하네스를 복사하지 마라 · 에이전트 이름을 등록부 밖에 적지 마라(`check-agent-names`)
- 커밋 메시지에 AI 서명 금지

## 단계 종료 절차 (사용자 지시 2026-09-13 — 모든 단계에 같다)

단계의 DoD 가 서고 전량 e2e 가 `unexpected 0` 이면, 같은 세션 안에서 순서대로:

  1. 문서 갱신 — `M9_PROGRESS.md` · 스펙 §10 · **이 파일을 다음 단계의 착수 프롬프트로 다시 쓴다** (이 절을 그대로 옮긴다)
  2. `make gates` 초록 확인 뒤 **커밋** (단계 종료 커밋 하나 — 이 지시가 그 확인이다)
  3. 인수인계 — dongminal 접합면으로 **현재 위치에 새 탭**을 열고 claude 를 띄운다:
       `dmctl new-tab -n` (`--at` 없이. `new-tab`/`close-tab` 은 `--help` 를 받지 않는다) → `newTabs[0]` 의 uuid·toolId
       `dmctl rename-tab --at <탭> "M9-P<n+1>"`
       `dmctl send-input --at <탭> --execute "cd '$PWD' && claude"` → `dmctl wait --at <탭> --for ready --timeout-ms 180000`
       (rc=5 면 `dmctl read-screen --at <탭>` 으로 무엇을 묻는지 보고 처리)
       `dmctl msg --to <toolId> -` 로 `[HANDOFF M9 P<n> → P<n+1>]` 엔벨로프 — 이 파일을 읽고 진행하라는 한 문단 + 커밋 해시
       `dmctl status --at <탭>` 로 `working` 확인 (idle 이면 `send-input --execute ""`)
  4. **자기 탭을 닫는다** — `dmctl close-tab --at <자기 탭 uuid>` (`dmctl who-am-i` 의 `uuid=`). 세션의 마지막 명령이다
```
