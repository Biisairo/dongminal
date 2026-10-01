<!-- 이 파일은 전체가 새 세션의 첫 메시지다. 열어서 전체 선택 → 붙여넣기. -->

dongminal 저장소에서 **Claude Code 를 띄웠을 때의 주의 알람 오류**를 조사하고 고친다. 브랜치는 `main` 이다.

## 0. 가장 먼저

```bash
git branch --show-current      # main
git status --short             # 비어 있어야 한다
git log -1 --format='%h %s'    # 5d9c6ae7 이후여야 한다
```

`CLAUDE.md`(사용자 전역 규약)를 따른다 — 중·대 규모는 **인터뷰 → 스펙(IEEE 29148) → 테스트 → 구현**,
커밋은 **사용자 확인 후에만**, 커밋 메시지에 AI 서명(`Co-Authored-By` 등) 금지.

## 1. 이번 세션의 일

사용자 접수(2026-10-01):

1. **Claude Code 가 대기 중(입력 대기·유휴)인데 알람이 울린다.**
2. **알람이 연달아 여러 번 울린다.**

재현 조건은 아직 사용자에게 받지 않았다 — 어떤 상황(작업 끝·권한 요청·그냥 유휴), 어떤
알람(탭·창 깜빡임 · 🔔 배지 · OS 알림 · 알림음), "연달아" 가 몇 번·몇 초 간격인지. **코드로 답할 수
있는 것은 먼저 조사하고, 그래도 갈리는 것만 하나씩 묻는다.**

## 2. 먼저 읽을 것 (순서대로)

1. `docs/internal/ATTENTION_FIRING_SRS.md` 전부 — 특히 **§1.7 "AS-2 는 반증되었다"**, **§1.8 "대기 중에도
   알람이 선다 (2026-09-06 재접수)"**, §1.9 인터뷰 결정. 같은 계열의 증상이 한 번 접수·수정됐다 —
   이번 것이 재발인지 다른 경로인지부터 가른다
2. `docs/internal/ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS.md` — 알람의 생애(켜짐·걷힘)
3. `docs/internal/AGENT_ADAPTER_COMPLETION_SRS.md` · `AGENT_EVENT_ABSTRACTION_SRS.md` — claude 훅이 무엇을
   언제 보고하는가(`SessionStart` 가 기동 직후 `idle` 을 보고한다는 실측이 있다 — `dmctl wait --for ready`
   가 `waitedMs=0` 으로 돌아오는 이유)
4. 코드: `web/js/core/app-attn.js`(판정·발화·`attnUserIsWatching`), `web/js/core/app-attn-center.js`(배지·팝오버),
   `internal/shared/agentadapter/claude*.go`(훅 해석), `internal/helper/runtimebin/dmctl_activity.go`(활동 보고)
5. 실기기 진단: `?diag=1` 오버레이(`web/js/ui/diag.js`)가 이벤트 순서를 기록하고 [전송]으로 올린다 —
   에뮬레이션으로 재현되지 않으면 이것으로 사용자에게 로그를 받는다

## 3. 어디까지 왔나 (직전 세션, 전부 `main` 에 푸시됨)

| 커밋 | 내용 |
|---|---|
| `f644468e` | UX_BATCH11 — 터미널 복사·붙여넣기 키, 파일 경로 링크, 끊긴 동안의 입력 보류, 주의 맥박 opacity 합성(`--z-under` 층 신설), 모바일 터치 스크롤(행 단위 wheel · 1:1 · 관성 재측정), 모바일 터미널 위 OS 기본 선택 — `docs/internal/UX_BATCH11_SRS.md` |
| `4ad7c161` | 전체 검색이 실린 선택으로 곧바로 검색 — `EDITOR_REPLACE_AND_SEED_SRS` FR-ERS-25 |
| `5d9c6ae7` | 목록에서 빠진 루트의 Editor 창을 병합이 되살리지 않음 — `OPTIMISTIC_LAYOUT_SRS` FR-OPL-14 (CI `editor-link` L2 의 진짜 원인) |

검증 상태(`5d9c6ae7`): CI `verify`·`e2e` 성공 · 로컬 `make e2e` 8샤드 `e2e ok`(1,940 통과, flaky 2 —
`git-branch-actions` BR8, `window-slots` TC-WSL-2, 둘 다 격리 판정 "부하") · `make gates` 통과 · 단위 546 통과.

**주의 맥박과 이번 일의 경계**: UX_BATCH11 은 알람의 **모습**(깜빡임을 opacity 겹으로)만 바꿨다 — 알람이
**언제 켜지는가**는 건드리지 않았다. 다만 표식 CSS 가 바뀌었으므로(`.pn-tab.attn::before` 등, `UX_BATCH11_SRS`
§3.4) 화면 증상을 볼 때 그 구조를 안다.

## 4. 직전 세션이 값을 치르고 배운 것

1. **e2e 전량(`make e2e`)이 도는 동안 다른 e2e 를 같은 기계에서 돌리지 마라.** 포트·CPU 가 겹쳐 샤드 7·8 의
   동기화 계열 25건이 가짜로 졌다. 단독 재실행에서 68건 전부 통과했다
2. **격리 3회 "부하" 판정이 결함을 놓칠 수 있다.** `editor-link:58` L2 는 두 번 "부하" 로 판정됐지만 실제로는
   병합이 Editor 창을 되살리는 경합이었다(`E2E_FLAKY_ISOLATION_SRS` §8.3h). 같은 자리에서 **재시도까지** 지면
   부하가 아니라 상태를 의심하라 — 실패 지점의 값(무엇이 남았나)이 원인을 가리킨다
3. **실측 전에 결론 내지 마라.** 모바일 스크롤은 "배율이 낮아서" 가 아니라 "xterm 이 wheel 하나당 마우스 리포트를
   하나만 보내는데 우리가 프레임당 wheel 하나로 합쳤다" 였다 — 옛 방식을 임시로 되살려 수치(300 px → 리포트 3)로
   확인했다. 알람도 "어느 이벤트가 몇 번 오는가" 를 세어서 가른다
4. **CSS 리터럴 게이트**: `font-size`·`z-index` 는 토큰만(`var(--fs-*)`·`var(--z-*)`), 구르는 표면에는 킷 스크롤바
   클래스(`.ui-scroll*`). 모듈 500줄 기준을 넘으면 **가른다**(기준선을 옮기지 않는다). SRS 상태 필드는 enum 이고
   `승인·구현중` 이면 `> **남은 것**:` 줄이 필요하다. SRS 를 고치면 `go run ./scripts/gen-decisions`
5. CI 재실행(`gh run rerun`)은 이 계정에 저장소 관리자 권한이 없어 안 된다 — 고쳐서 다시 푸시하는 수밖에 없다

## 5. 변하지 않는 규약

- 커밋 전: `make gates` · `npm run unit` · `npm run lint` · `npm run typecheck`
- 동작 변경은 **이전 / 새 / 이유** 를 SRS 에 남긴다
- e2e 는 `app._x` 를 직접 만지지 않는다(`app.testing.x`, 게이트 `check-e2e-private`). 고정 대기는 `TEST-16` 표식과 사유가 있어야 한다
- 사용자가 커밋·푸시를 말하면 CI(`gh run list`)와 로컬 `make e2e` 를 **동시에** 돌리고 둘의 결과를 함께 보고한다

## 6. 아직 유효한 사용자 결정

- 인증은 지원하지 않는다(확정된 경계 — README "노출해서 쓸 때")
- 에이전트별 GUI(채팅 뷰·승인 카드)는 만들지 않는다
- HTTPS 를 쓰지 않으므로 Web Push·Wake Lock 은 범위 밖이다 — OS 알림은 탭이 열려 있을 때의 `Notification` 뿐
- 터미널 출력 흐름 제어(ACK)는 측정부터 하는 별도 과제, 전역 명령 팔레트는 차후 과제로 분리돼 있다
