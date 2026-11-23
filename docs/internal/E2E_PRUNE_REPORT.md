# e2e 가치 낮은 시험 정리 — 12.0 분석 보고서

- 이슈: `rust-port/issues/12-e2e-가치-낮은-시험-정리.md` (12.0 분석)
- 기준 트리: `rp/12` (e2e spec 251개)
- 작성일: 2026-11-24
- 범위: 분석만 한다. 코드와 시험은 고치지 않는다. 삭제는 조정자가 사용자 확인을 받은 뒤 별도 작업에서 한다.

## 1. 결론

1. 지울 후보는 **85개**다. 범주별로 A 3 · B 0 · C 79 · D 3 · E 0 이다. 보류는 **8개**다.
2. 후보를 모두 지워도 줄어드는 시간은 **직렬 약 1.0분**(워커 2개 기준 벽시계 약 0.5분)뿐이다. 전량 실행은 직렬 약 57분(워커 2개 약 30분)이다.
3. 시간이 적게 주는 이유는 이렇다. e2e 의 비용 대부분은 실제 흐름을 검증하는 시험의 준비 비용(서버·git 저장소·편집기 기동)에서 나온다. 그런 시험은 대부분 다른 시험이나 단위 시험이 덮지 않는 사용자 흐름을 지킨다. 그래서 지울 수 없다.
4. 후보의 대부분(64개)은 **합성 페이지 시험**이다. 이 시험은 서버를 띄우지 않고 `page.setContent` 로 JS 모듈만 올려 순수 함수를 검사한다. Rust 포팅의 동등성 검증(V-RSP-3)에는 쓸모가 없다. 다만 이 시험만이 그 요구를 지킨다. 그래서 **단위 시험(`web/js/test`)으로 옮긴 뒤에 지워야 한다.**
5. 시간을 줄이려면 삭제보다 **고정 대기 단축**이 효과가 크다. 고정 대기(`waitForTimeout`)는 모두 합쳐 직렬 약 6.2분이다(§6).

## 2. 방법

### 2.1 정적 분석

`playwright --list` 는 쓰지 않았다. 이 worktree 에 `node_modules` 가 없기 때문이다. 그 대신 spec 원문을 스크립트로 읽어 시험마다 다음을 셌다.

| 항목 | 세는 방법 |
|---|---|
| 시험 선언 | `test(`·`test.skip(` 등. 정적 선언 2,284개를 찾았다. 반복문으로 만드는 시험까지 더한 실행 항목은 2,317개다(이슈 8.1 실측). |
| 단정 | `expect(`·`expect.poll`·`toPass` |
| 고정 대기 | `waitForTimeout(n)`. 파일 상수(`POLL_WAIT`·`WINDOW_MS` 등)는 값으로 바꿔 셌다. |
| 시험 상한 | `test.setTimeout(n)` |
| 화면 조작 | `click`·`press`·`fill`·`keyboard`·`mouse`·`tap` 등 |
| 합성 페이지 | `page.setContent` + `addScriptTag` |
| 소스 읽기 | `readFileSync` 로 `web/` 를 읽는 자리 |
| CSS 값 | `getComputedStyle`·`toHaveCSS` |
| 연결 요구 | 제목·본문의 `V-*`·`FR-*`·`TC-*` ID |

### 2.2 비용

- 파일별 실측 시간은 `e2e/shard-timings.json` 을 썼다(전량 실행의 산출물, 2026-11-03 생성, 163개 파일). 그 뒤에 더해지거나 바뀐 파일 90개는 시간이 없다. 이 파일들은 시험당 평균 1.49초로 추정했다.
- 시험 하나의 비용은 `파일 시간 ÷ 시험 수` 로 추정했다. 고정 대기가 큰 시험은 대기 시간에 준비 비용(약 1.5초)을 더했다.
- e2e 는 실행하지 않았다(AGENT_RULES 2-4). 그래서 시간은 모두 추정이다.

### 2.3 판정

1. 정적 분석에서 신호가 있는 시험을 골랐다. 신호는 단정 0, 합성 페이지, 소스 읽기, CSS 값 위주, 제목의 "옛·남아 있지 않다", 같은 ID·제목의 반복, 큰 고정 대기다.
2. 고른 시험은 본문을 읽고, 같은 요구를 덮는 다른 수단이 있는지 찾았다. 다른 수단은 다른 e2e, `web/js/test/*.test.mjs` 단위 시험, `Makefile gates` 의 정적 검사다.
3. 신호가 없는 시험은 파일 단위로 §5 의 기준에 따라 남김으로 판정했다. 파일별 판정은 부록 A 에 있다.
4. 흔들림 정보는 이슈 8.1·10.7·10.7b 의 전량 실행 기록을 썼다.

### 2.4 한계

- 신호가 없는 시험 사이의 **의미상 중복**은 전부 대조하지 못했다. 예를 들어 git 계열 40여 개 파일 안에서 같은 흐름을 다른 말로 검사하는 경우다. 이 보고서의 D 후보는 확인한 것만 적었다.
- 시간표가 3주 전 것이라 최근 파일의 비용은 실제와 다를 수 있다.

## 3. 요약 표

| 범주 | 뜻 | 개수 | 절약(직렬, 초) |
|---|---|---:|---:|
| A | 쓸데없음: 아무것도 단정하지 않음, 항상 통과, 죽은 기능 | 3 | 4.8 |
| B | 비용 대비 가치 낮음: 오래 걸리는데 다른 시험이 같은 흐름을 덮음 | 0 | 0 |
| C | e2e 의 뜻이 아님: 순수 함수·문구·CSS 값·구현 세부만 봄 | 79 | 33.6 |
| C-1 | 이미 단위·정적 게이트가 덮음. 지우기만 하면 됨 | 11 | 5.4 |
| C-2 | 값 고정만 봄. 지우면 그 값의 고정을 잃음 | 4 | 6.0 |
| C-3 | 이 시험만 그 요구를 지킴. **단위로 옮긴 뒤** 지움 | 64 | 22.2 |
| D | 중복 | 3 | 20.9 |
| E | 흔들림이 잦은데 지키는 것이 약함 | 0 | 0 |
| **합계** | | **85** | **약 59초 (≈1.0분)** |
| 보류 | 확신이 낮음. 사용자가 정한다 | 8 | 최대 약 18초 |

- B 와 E 는 확정 후보가 없다. 해당하는 것은 모두 보류(§4.6)로 옮겼다. 오래 걸리는 시험은 다른 수단이 같은 요구를 덮지 않았다. 흔들린 시험은 시험의 상태 격리나 입력을 고칠 대상이지, 지킬 가치가 약한 시험이 아니었다.
- 단정이 없어 보인 12개(정적 계수 0)는 모두 단정이 있었다. 여러 줄로 나뉜 `expect\n.poll(` 이나, 도우미 함수(`assertAll`·`matchesBaseline`·`expectToolCwd`) 안의 단정이었다. 그래서 A 에서 뺐다.

## 4. 후보 목록

열 설명: **지키던 것**은 연결 ID 와 흐름이다. **다른 곳에서 덮는가**는 같은 요구를 지키는 다른 수단이다. **잃는 것**은 지웠을 때 사라지는 검증이다. **절약**은 직렬 기준 추정이다.

### 4.1 A — 쓸데없음 (3)

| # | 위치 | 지키던 것 | 다른 곳에서 덮는가 | 잃는 것 | 절약 |
|---|---|---|---|---|---:|
| A1 | `e2e/poll-interval.spec.ts:65` PIS1 | V-1. 지운 signature 폴링의 전역 이름(`GIT_SIGNATURE_POLL_MS`·`gitSignatureInterval`)이 `undefined` 인가 | 필요 없음. 지운 이름이 되살아나는지만 본다. 사용자에게 보이는 결과(요청 0건)는 A2 와 `editor-traffic.spec.ts:61` 이 본다 | 죽은 이름의 부활 감지 | 1.1 |
| A2 | `e2e/poll-interval.spec.ts:81` PIS2 | V-1. 옛 설정 키를 넣어도 `/api/git/signature` 요청이 0건 (고정 대기 1.5초) | `editor-traffic.spec.ts:61` 이 저장소 창에서 30초 동안의 `/api/git/status` 요청 수를 잰다. signature 종단을 세는 시험은 이것뿐이므로, 지우면 옛 키로 지운 계층이 되살아나는 경우를 놓친다 | 옛 설정 키로 지운 계층이 되살아나는 경우의 감지 | 2.6 |
| A3 | `e2e/poll-interval.spec.ts:345` PIS16 | V-10. 옛 두 자리(`#agents-poll`·`.sbs-select`)에 주기 컨트롤이 없다 | PIS15(`:332`)가 새 자리의 컨트롤 다섯을 확인한다. `check-settings-docs.sh` 가 설정 화면과 문서의 일치를 본다 | 지운 컨트롤의 부활 감지 | 1.1 |

### 4.2 C-1 — 이미 단위·정적 게이트가 덮음 (11)

| # | 위치 | 지키던 것 | 덮는 수단 | 잃는 것 | 절약 |
|---|---|---|---|---|---:|
| C1 | `e2e/git-history.spec.ts:184` H4b | V47. `history.js`·`lanes.js`·`menu.js` 에 색 리터럴이 없다(소스를 grep 한다. 페이지를 쓰지 않는다) | `scripts/check-hardcoded-color.mjs` ③ 이 `web/js/**` 전체의 색 리터럴을 0 으로 묶는다 | 없음 | 0.2 |
| C2 | `e2e/poll-interval.spec.ts:228` PIS9 | V-7. `visiblePoll` 이 값과 함수를 둘 다 받는다 | `web/js/test/timer-hub.test.mjs` "every: 주기는 값이 아니라 함수다 (FR-SCH-4)" | `visiblePoll` 감싸개 자체의 인자 전달 | 1.1 |
| C3 | `e2e/poll-interval.spec.ts:247` PIS10 | V-8a. `refreshChanged` 는 바뀐 job 만 다시 건다 | `timer-hub.test.mjs` "refreshChanged: 주기가 바뀐 job 만 다시 건다" | 없음 | 1.1 |
| C4 | `e2e/git-live-triggers.spec.ts:125` TC-GLW-5 | `git.watchdog` job 의 내부 필드(`whenHidden='pause'`, 주기 1000) | 관측 동작은 같은 파일의 TC-GLW-3(`:90`, 숨김 신호가 폴링을 걷는다)이 본다 | 내부 등록값 고정 | 2.3 |
| C5 | `e2e/timer-hub-bus.spec.ts:57` FR-SCH-4·5 | 주기는 함수이고, 다시 거는 것은 발화가 아니다 | `timer-hub.test.mjs` "주기는 값이 아니라 함수다 (FR-SCH-4)"·"refreshChanged: 발화하지 않는다 (FR-SCH-5)" | 없음 | 0.1 |
| C6 | `e2e/timer-hub-bus.spec.ts:76` FR-SCH-6 | 숨으면 멈추고, 돌아오면 즉시 한 번 | `timer-hub.test.mjs` "숨으면 멈추고, 돌아오면 즉시 한 번 갚는다 (FR-RST-23)" | 없음 | 0.1 |
| C7 | `e2e/timer-hub-bus.spec.ts:299` FR-SCH-11 | `pending` 이 대기 중인 일을 답한다 | `timer-hub.test.mjs` "pending: 무엇이 언제 도는지 답한다 (FR-SCH-11)" | 없음 | 0.1 |
| C8 | `e2e/git-lanes.spec.ts:111` L1 | V117. 선형 히스토리는 전부 0열이고 통과선이 없다 | `web/js/test/lanes.test.mjs:41`·`:47` | 없음 | 0.1 |
| C9 | `e2e/git-lanes.spec.ts:136` L3 | V117. 머지는 부모 수만큼 선을 갖는다 | `lanes.test.mjs:58` | 없음 | 0.1 |
| C10 | `e2e/git-lanes.spec.ts:301` L10 | V120. `clampLanes` 는 원본을 고치지 않고, 두 번 접어도 같다 | `lanes.test.mjs:118`·`:125` | 없음 | 0.1 |
| C11 | `e2e/git-lanes.spec.ts:404` L12 | V117·FR-GIT-121. 브랜치 머리만 위쪽 진입선이 없다 | `lanes.test.mjs:52` | 없음 | 0.1 |

### 4.3 C-2 — 값 고정만 봄 (4)

이 시험들은 CSS 계산값 하나가 정해진 값인지만 본다. 사용자 흐름이 없다. 정적 게이트(`check-spacing`·`check-radius` 등)는 값이 토큰에서 오는지는 보지만, 그 토큰이 무엇인지는 고정하지 않는다. 그래서 지우면 **그 값의 고정**을 잃는다. 가치를 판단하기 쉬운 것만 넣었다. CSS 값을 보더라도 테마 전환·캐스케이드·겹침처럼 렌더링 결과를 봐야 하는 시험은 남겼다(§5).

| # | 위치 | 지키던 것 | 잃는 것 | 절약 |
|---|---|---|---|---:|
| C12 | `e2e/ui-polish.spec.ts:21` TC-UIP-1 | 터미널 본문의 안쪽 여백이 4px·8px | 여백 값 고정 | 1.5 |
| C13 | `e2e/ui-polish.spec.ts:30` TC-UIP-2 | 저장된 폭이 없으면 사이드바가 200px | 기본 폭 값 고정 | 1.5 |
| C14 | `e2e/ui-polish.spec.ts:64` TC-UIP-4 | 사이드바 하단 버튼에 테두리가 없다 | 테두리 없음 고정 | 1.5 |
| C15 | `e2e/settings-legibility.spec.ts:29` V-SIL-1 | 설정 항목 행에 아래 테두리가 없다 | 테두리 없음 고정 | 1.5 |

### 4.4 C-3 — 단위로 옮긴 뒤 지움 (64)

여섯 파일 모두 서버 없이 `page.setContent` 로 빈 문서를 만들고, `web/js` 의 모듈을 `addScriptTag` 로 올려 함수를 직접 부른다. 사용자 흐름도 서버도 없다. 그래서 **Rust 바이너리의 동등성 검증에는 아무 신호도 주지 않는다.** 하지만 지키는 요구를 다른 수단이 덮지 않는다(`FR-SCH-7~9·13~15`, `FR-BUS-3~9`, `FR-RPT-1~3`, `V-RCS-*`, `FR-GIT-228~235` 를 `web/js/test`·`scripts/check-*` 에서 찾지 못했다). 그러므로 **`node --test` 단위 시험(`web/js/test/harness.mjs` 가 있다)으로 같은 입력·기대값을 옮긴 뒤에** 지운다. 옮기지 않고 지우면 이 요구를 지키는 수단이 사라진다.

| # | 파일 | 시험 | 지키던 것 | 절약 |
|---|---|---:|---|---:|
| C16 | `e2e/git-lanes.spec.ts` (C8~C11 제외) | 11 | V115~V131, FR-GIT-228~235. 레인 그래프(갈래 당김, 경계, 색 키, 접기, 통과선 방향) | 0.9 |
| C17 | `e2e/repaint.spec.ts` (전부) | 13 | FR-RPT-1~3. `paintIfChanged`·`reconcileList` 의 다시 그리기 판정과 DOM 보존 | 1.1 |
| C18 | `e2e/timer-hub-bus.spec.ts` (C5~C7 제외) | 16 | FR-SCH-3·7~9·13~15, FR-BUS-3~9, FR-RLC-28, V-7. 그리고 `:491` V-5(`event-bus.js` 가 `TimerHub` 를 참조하지 않는다)는 소스 grep 이므로 정적 게이트(`check-timers.sh` 등)로 옮긴다 | 2.1 |
| C19 | `e2e/event-timer-hub-contract.spec.ts` (전부) | 15 | 합성 페이지에서 api·tool-cmd·ws-sync·soft-reload 모듈 사이의 계약 | 3.7 |
| C20 | `e2e/reconnect-storm.spec.ts` (전부) | 5 | V-RCS-1~4 등. 터미널 칸 재연결 백오프(OP.EXIT 뒤 재연결 금지, 백오프 리셋) | 9.0 |
| C21 | `e2e/sse-resilience.spec.ts` (전부) | 3 | V-RCS-7 등. SSE 연속 실패 뒤에도 재시도 | 4.3 |
| C22 | `e2e/poll-interval.spec.ts:321` PIS14 | 1 | FR-PIS-18. `BACKUP_KEYS` 에 `agentsPollMs` 가 없다(상수 검사) | 1.1 |

- 합성 페이지 여섯 파일의 실측 합계는 21.8초다. 그중 C5~C11(약 0.6초)은 §4.2 에 따로 셌다.
- `event-timer-hub-contract` 는 여러 모듈을 한 문서에 함께 올린 통합 검사다. 단위로 옮길 때 브라우저 API(EventSource·visibilitychange)를 흉내 내야 한다. 옮기기가 어려우면 이 파일만 남겨도 된다.

### 4.5 D — 중복 (3)

| # | 위치 | 지키던 것 | 덮는 시험 | 잃는 것 | 절약 |
|---|---|---|---|---|---:|
| D1 | `e2e/workspace-resync.spec.ts:122` TC-M9-10b | D-M9-8. 재연결이 없으면 rev 없는 재수신(`_onWorkspaceChanged()` → `GET /api/state`)이 없다. 6초 고정 대기, 새 브라우저 컨텍스트 | `e2e/steady-traffic.spec.ts:58` 이 터미널 창의 30초 동안 `/api/state` 를 0건으로, 그 밖의 `/api/*` 도 목록 밖은 0건으로 단정한다. 더 길고 더 엄격하다 | 없음(steady-traffic 을 남기는 조건) | 7.5 |
| D2 | `e2e/git-push-observe.spec.ts:138` B-5 | NFR-1. 변화가 없는 저장소 창에서 10초 동안 git status·signature 요청이 10건 미만. 10초 고정 대기 | `e2e/editor-traffic.spec.ts:61` 이 같은 종류의 창(`.ed-win`)에서 30초 동안 `/api/git/status` 를 1건 이하로 단정한다. signature 는 A2 가 본다(A2 를 지우면 signature 를 세는 시험이 없어진다. 그 종단은 폴링 계층과 함께 지워졌다) | Changes 뷰를 연 상태의 요청 수. editor-traffic 은 탐색기를 연 상태다. **확신 중간** | 12.0 |
| D3 | `e2e/repo-tab.spec.ts:388` X3 | V-RTU-31·FR-RTU-17. git 뷰 탭은 창 밖으로 나가지 않는다 | `e2e/git-window.spec.ts:267` V71 이 같은 요구(창 밖 이동 불가)를 보고, 창 안 분할 허용까지 본다 | 없음 | 1.4 |

### 4.6 보류 (8)

| # | 위치 | 범주 후보 | 보류 사유 | 절약 |
|---|---|---|---|---:|
| H1 | `e2e/ui-layout-defaults.spec.ts:197` V-LAY-1, `:207` V-LAY-1b | C(스냅샷)·E | 모든 화면의 계산값을 OS별 기준선(`e2e/baseline/ui-layout.*.json`)과 대조한다. 상한 180초. 8.1 에서 Go·Rust 둘 다 실패했고, 원인은 시험 상태 누수였다(10.7 에서 고침). 기준선 유지 비용이 크다. 하지만 레이아웃 변화를 넓게 잡는 유일한 장치다. 지울지는 사용자가 정한다 | 약 3 |
| H2 | `e2e/status-bar-reflow.spec.ts:56` | E | 10.7 전량 회차에서 두 번 흔들렸다. 원인은 호스트 가동 시간 글자(`13d 17`)의 길이다. 모바일 상태바의 실제 배치를 지키므로, 지우기보다 입력을 고정하는 편이 맞다 | 1 |
| H3 | `e2e/editor-ops.spec.ts:349` O7 | E | 500ms 고정 대기 뒤 다시 읽기 수를 정확히 센다(10.7b 관측 B). 지키는 것은 중복 다시 읽기 방지다. 대기를 조건으로 바꾸는 편이 맞다 | 1 |
| H4 | `e2e/update-notice.spec.ts:130` | B·D | `/api/update` 를 주기로 묻지 않는다(8초 대기). steady-traffic 이 목록 밖 `/api/*` 를 0건으로 보지만, 그 시험에서는 업데이트 배지가 꺼져 있어 같은 조건이 아니다 | 9 |
| H5 | `e2e/sidebar-tabs.spec.ts:61` T1 | D | `git-sidebar.spec.ts:58` S1 이 첫 접속 상태(Windows 활성, 저장소 패널 숨김)를 함께 본다. T1 에만 있는 것은 ⚙ 버튼이 두 탭 모두에서 보인다는 단정이다 | 1 |
| H6 | `e2e/kit-components.spec.ts:77` TC-CMP-7 | C·D | `scripts/check-uppercase.mjs` 가 CSS 의 대문자 변형을 0 으로 묶는다. 시험 주석은 JS 인라인이나 캐스케이드로 다시 걸리는 경우를 잡으려고 따로 둔다고 밝힌다 | 1.5 |
| H7 | `e2e/kit-button.spec.ts:88` TC-KIT-6a | C·E | 10.7 최종 2회차에서 흔들렸다. 버튼 높이가 세 눈금으로 모이는지(CSS 계산값)를 본다. `check-button-kit.mjs` 는 정적 소스만 보므로 실행 중 만든 버튼은 이 시험만 본다 | 1.5 |

보류의 시험 수는 V-LAY-1·1b 를 둘로 세어 8개다.

## 5. 남길 것의 기준

다음 중 하나라도 해당하면 남긴다. 부록 A 의 "남김" 은 이 기준을 따른 것이다.

1. **실제 사용자 흐름**: 브라우저 조작(클릭·키·터치·드래그)이 서버를 거쳐 화면·디스크·PTY 결과로 이어지는 것을 본다.
2. **서버 관측 표면**: HTTP·SSE·WS 응답, 요청 수·종단, 파일 내용, PTY 출력처럼 Rust 포팅의 동등성(V-RSP-3)에 직접 쓰이는 것을 본다. `skill-contract.spec.ts` 처럼 브라우저 없이 API·CLI 계약만 보는 시험도 여기에 들어간다.
3. **렌더링 결과**: 테마 전환, 캐스케이드, 겹침, 모바일 폭처럼 정적 검사가 볼 수 없는 계산 결과를 본다.
4. **부재의 계약**: "요청이 나가지 않는다", "편집본을 덮지 않는다" 처럼 일어나지 않음을 보는 시험이다. 고정 대기가 길어도, 같은 부재를 더 넓게 보는 시험이 없으면 남긴다.
5. **다중 클라이언트·재연결·재기동**: 두 브라우저, 연결 끊김, 서버·데몬 재기동처럼 단위 시험으로 만들 수 없는 조건을 쓴다.

다음에 해당하면 후보로 본다.

1. 서버도 사용자 흐름도 없이 순수 함수·내부 필드·소스 문자열만 본다(C).
2. 같은 요구를 다른 e2e·단위·게이트가 같거나 더 넓게 본다(D, C-1).
3. 지운 기능의 이름·자리가 없다는 것만 본다(A).

## 6. 삭제 밖의 권고 — 고정 대기 단축

후보를 모두 지워도 1분 남짓만 준다. 시간을 줄이려면 아래 고정 대기를 줄이는 편이 효과가 크다. 이 시험들은 지키는 요구를 다른 수단이 덮지 않으므로 **지우지 않고** 대기만 줄인다. 대기를 주기 설정값(시험에서 주기를 줄이기)이나 관측 사건으로 바꾸면 된다. 이 일은 이슈 12 의 범위 밖이다. 조정자가 필요하다고 보면 하위 이슈로 연다.

| 위치 | 고정 대기 |
|---|---:|
| `e2e/steady-traffic.spec.ts:58` (D1 을 덮는 시험) | 30초 |
| `e2e/editor-traffic.spec.ts:61` (D2 를 덮는 시험) | 30초 |
| `e2e/editor-live-reload.spec.ts:121`·`:135`·`:145`·`:167` | 12초 × 4 |
| `e2e/notes-live-explorer.spec.ts:350`·`:412`·`:432` | 9초 × 3 |
| `e2e/git-repo-missing.spec.ts:263`·`:319`·`:338` | 5·7·9초 |
| `e2e/git-view-refresh.spec.ts:666` V-GLV-3 | 8초 |
| `e2e/version-autoreload.spec.ts:126` TC-RLC-3c | 8초 |
| `e2e/git-not-repo.spec.ts:31` F-6.2 | 7초 |
| `e2e/git-repos-push.spec.ts:51` | 7초 |

- 전체 고정 대기는 정적 계수로 약 374초(직렬 약 6.2분)다.
- 두 30초 시험(steady-traffic·editor-traffic)은 D1·D2 를 덮는 상위 시험이다. 이 둘을 줄이거나 지우려면 D1·D2 를 먼저 다시 판단해야 한다.

## 7. 다음 단계 (이슈 12 절차 2·3)

1. 조정자가 §3·§4 를 사용자에게 요약해 확인을 받는다. 범주별로 승인받는 것을 권한다(A, C-1, C-2, C-3, D, 보류 항목별).
2. 승인된 것만 지운다. C-3 은 단위 시험을 먼저 옮기고, 옮긴 시험이 통과한 뒤에 지운다.
3. 지운 뒤 확인할 것:
   - `tsc --noEmit -p e2e` 통과(지운 시험만 쓰던 도우미가 남지 않았는지)
   - `npm run unit` 통과(C-3 이관분)
   - `scripts/check-e2e-waits.mjs` 의 예외 목록에서 지운 시험의 줄 참조 정리
   - `e2e/shard-timings.json` 은 다음 전량 실행(11.10) 뒤 다시 만든다

## 부록 A. 파일별 판정 (251개)

열: 시험 수(정적 선언) · 실측(초, `shard-timings.json`, `-` 는 기록 없음) · 고정 대기 합(초) · 판정.

| spec | 시험 | 실측 | 고정 대기 | 판정 |
|---|---:|---:|---:|---|
| `a11y-axe.spec.ts` | 3 | 9.6 | 0.0 | 남김 |
| `a11y-dialog.spec.ts` | 9 | 7.8 | 0.0 | 남김 |
| `a11y-keyboard.spec.ts` | 9 | 12.8 | 0.0 | 남김 |
| `a11y-live.spec.ts` | 1 | 0.8 | 0.0 | 남김 |
| `access-allowlist.spec.ts` | 9 | 8.4 | 0.0 | 남김 |
| `activity-rail.spec.ts` | 3 | - | 0.0 | 남김 |
| `activity-runs-refresh.spec.ts` | 1 | - | 0.0 | 남김 |
| `activity.spec.ts` | 15 | 11.7 | 0.0 | 남김 |
| `agent-card-focus.spec.ts` | 2 | - | 0.0 | 남김 |
| `agent-render-env.spec.ts` | 2 | - | 0.0 | 남김 |
| `attention-dedupe.spec.ts` | 1 | - | 0.0 | 남김 |
| `attention-focus-clear.spec.ts` | 1 | - | 0.0 | 남김 |
| `attention-insecure.spec.ts` | 5 | 4.5 | 0.0 | 남김 |
| `attention-pulse.spec.ts` | 8 | 5.4 | 0.0 | 남김 |
| `attention.spec.ts` | 9 | 26.0 | 0.8 | 남김 |
| `background-restore-at.spec.ts` | 8 | 15.0 | 1.0 | 남김 |
| `background-ui.spec.ts` | 8 | 15.8 | 0.0 | 남김 |
| `bare-link.spec.ts` | 1 | - | 0.0 | 남김 |
| `basic.spec.ts` | 4 | 5.9 | 0.0 | 남김 |
| `bg-kill-touch.spec.ts` | 1 | 2.1 | 0.0 | 남김 |
| `bg-kill.spec.ts` | 12 | 29.8 | 0.0 | 남김 |
| `boot-reuse.spec.ts` | 5 | 14.9 | 0.4 | 남김 |
| `boot-screen.spec.ts` | 5 | 17.0 | 0.0 | 남김 |
| `branch-menu-unify.spec.ts` | 16 | 15.4 | 0.0 | 남김 |
| `chat-window.spec.ts` | 4 | - | 0.0 | 남김 |
| `claude-accounts.spec.ts` | 1 | - | 0.6 | 남김 |
| `cmd-single-executor.spec.ts` | 3 | - | 0.0 | 남김 |
| `codemirror-load.spec.ts` | 4 | - | 0.0 | 남김 |
| `diag-overlay-touch.spec.ts` | 4 | 5.1 | 0.5 | 남김 |
| `diff-no-change.spec.ts` | 3 | - | 0.0 | 남김 |
| `doc-render.spec.ts` | 26 | 32.0 | 0.0 | 남김 |
| `edges-settings.spec.ts` | 5 | - | 0.0 | 남김 |
| `editor-cwd-inherit.spec.ts` | 7 | 10.0 | 0.0 | 남김 |
| `editor-dirty-derived.spec.ts` | 1 | - | 0.0 | 남김 |
| `editor-dirty-diff.spec.ts` | 18 | 34.1 | 0.0 | 남김 |
| `editor-doc-registry.spec.ts` | 7 | - | 0.0 | 남김 |
| `editor-encoding.spec.ts` | 7 | - | 0.0 | 남김 |
| `editor-explorer.spec.ts` | 19 | 43.6 | 1.5 | 남김 |
| `editor-external-change.spec.ts` | 7 | 14.2 | 2.6 | 남김 |
| `editor-find-panel.spec.ts` | 19 | 31.5 | 1.1 | 남김 |
| `editor-fs-watch.spec.ts` | 8 | - | 0.0 | 남김 |
| `editor-git-ux.spec.ts` | 24 | 22.6 | 0.2 | 남김 |
| `editor-link-marks.spec.ts` | 7 | - | 0.0 | 남김 |
| `editor-link.spec.ts` | 6 | 6.3 | 0.0 | 남김 |
| `editor-live-reload.spec.ts` | 8 | - | 50.0 | 남김 (고정 대기 단축 검토) |
| `editor-lsp-nav.spec.ts` | 27 | 34.6 | 5.8 | 남김 |
| `editor-lsp.spec.ts` | 4 | 3.7 | 0.0 | 남김 |
| `editor-minimap.spec.ts` | 15 | 5.5 | 0.0 | 남김 |
| `editor-multi-slot.spec.ts` | 3 | - | 0.0 | 남김 |
| `editor-nested-root.spec.ts` | 4 | 3.9 | 0.0 | 남김 |
| `editor-offline.spec.ts` | 2 | 4.8 | 0.0 | 남김 |
| `editor-ops.spec.ts` | 45 | 39.4 | 1.0 | 남김 + 보류 1 (O7 흔들림) |
| `editor-replace-seed.spec.ts` | 11 | - | 0.0 | 남김 |
| `editor-save.spec.ts` | 4 | 5.1 | 0.5 | 남김 |
| `editor-scrollbar.spec.ts` | 2 | - | 0.0 | 남김 |
| `editor-search-keys.spec.ts` | 5 | 5.7 | 0.0 | 남김 |
| `editor-sticky.spec.ts` | 3 | - | 0.0 | 남김 |
| `editor-tab.spec.ts` | 26 | 22.8 | 0.6 | 남김 |
| `editor-traffic.spec.ts` | 3 | - | 30.0 | 남김 (D 후보 B-5 를 덮는 상위 시험) |
| `event-timer-hub-contract.spec.ts` | 15 | 3.7 | 0.0 | 후보 C (전부: 합성 페이지, 이관 뒤 삭제) |
| `explorer-copy.spec.ts` | 11 | 14.5 | 0.0 | 남김 |
| `explorer-download-drag.spec.ts` | 5 | - | 0.0 | 남김 |
| `explorer-keys-multi.spec.ts` | 9 | - | 0.0 | 남김 |
| `explorer-root-keys.spec.ts` | 31 | 36.5 | 0.0 | 남김 |
| `explorer-transfer-ignore.spec.ts` | 19 | 22.1 | 2.8 | 남김 |
| `fe-fix.spec.ts` | 5 | - | 0.0 | 남김 |
| `file-path-link.spec.ts` | 3 | - | 0.0 | 남김 |
| `file-size-gate.spec.ts` | 1 | 1.6 | 0.0 | 남김 |
| `file-transfer.spec.ts` | 15 | 27.6 | 0.6 | 남김 |
| `focus-highlight-reveal.spec.ts` | 4 | - | 0.0 | 남김 |
| `focus-highlight.spec.ts` | 5 | - | 0.0 | 남김 |
| `focus-invariant.spec.ts` | 15 | 6.7 | 0.0 | 남김 |
| `focus-nav.spec.ts` | 5 | 7.6 | 0.0 | 남김 |
| `focus-owner.spec.ts` | 12 | 15.7 | 1.5 | 남김 |
| `focus.spec.ts` | 7 | 7.6 | 0.0 | 남김 |
| `font-size.spec.ts` | 10 | - | 0.0 | 남김 |
| `git-blame-fresh.spec.ts` | 2 | - | 0.0 | 남김 |
| `git-branch-actions.spec.ts` | 15 | 42.7 | 0.0 | 남김 |
| `git-branches.spec.ts` | 15 | 33.6 | 1.4 | 남김 |
| `git-changes.spec.ts` | 22 | 37.7 | 1.2 | 남김 |
| `git-commit-actions.spec.ts` | 10 | 28.7 | 1.0 | 남김 |
| `git-commit-slots.spec.ts` | 8 | - | 1.6 | 남김 |
| `git-commit.spec.ts` | 13 | 33.6 | 0.0 | 남김 |
| `git-confirm.spec.ts` | 17 | 15.9 | 0.0 | 남김 |
| `git-console.spec.ts` | 8 | 13.7 | 0.0 | 남김 |
| `git-detect-tier.spec.ts` | 8 | 23.6 | 0.0 | 남김 |
| `git-dialog.spec.ts` | 10 | 12.7 | 0.0 | 남김 |
| `git-diff-doc.spec.ts` | 9 | - | 0.0 | 남김 |
| `git-diff.spec.ts` | 21 | 41.6 | 0.0 | 남김 |
| `git-dir-entry.spec.ts` | 15 | 16.2 | 0.0 | 남김 |
| `git-discard-all.spec.ts` | 8 | 11.3 | 0.0 | 남김 |
| `git-feedback.spec.ts` | 3 | - | 0.0 | 남김 |
| `git-file-actions.spec.ts` | 15 | 21.0 | 0.0 | 남김 |
| `git-folder-stage.spec.ts` | 9 | 23.3 | 0.0 | 남김 |
| `git-head-mobile.spec.ts` | 5 | 7.7 | 1.6 | 남김 |
| `git-history-fresh.spec.ts` | 5 | - | 0.0 | 남김 |
| `git-history.spec.ts` | 35 | 61.3 | 2.7 | 일부 후보 (C 1: H4b). 나머지는 남김 |
| `git-hunk.spec.ts` | 22 | 41.1 | 0.0 | 남김 |
| `git-improve.spec.ts` | 11 | 19.6 | 4.8 | 남김 |
| `git-index-lock.spec.ts` | 2 | - | 0.0 | 남김 |
| `git-job-indicator.spec.ts` | 5 | - | 0.0 | 남김 |
| `git-lanes.spec.ts` | 15 | 1.2 | 0.0 | 후보 C (전부: 합성 페이지, 순수 함수. 4개는 단위가 이미 덮음, 11개는 이관 뒤 삭제) |
| `git-live-triggers.spec.ts` | 6 | 13.5 | 4.0 | 일부 후보 (C 1: TC-GLW-5). 나머지는 남김 |
| `git-menu.spec.ts` | 13 | 21.2 | 0.0 | 남김 |
| `git-not-repo.spec.ts` | 2 | - | 7.0 | 남김 |
| `git-observe-revive.spec.ts` | 11 | 21.9 | 2.8 | 남김 |
| `git-operation.spec.ts` | 3 | 9.5 | 1.0 | 남김 |
| `git-polling.spec.ts` | 10 | 62.2 | 12.8 | 남김 |
| `git-push-observe.spec.ts` | 5 | 20.4 | 11.3 | 일부 후보 (D 1: B-5). 나머지는 남김 |
| `git-refresh-lifecycle.spec.ts` | 10 | 37.6 | 4.0 | 남김 |
| `git-remote-actions.spec.ts` | 5 | 7.8 | 0.0 | 남김 |
| `git-remote.spec.ts` | 12 | 30.1 | 0.0 | 남김 |
| `git-repaint.spec.ts` | 16 | 49.9 | 19.7 | 남김 |
| `git-repo-missing.spec.ts` | 11 | 45.7 | 22.2 | 남김 (고정 대기 단축 검토) |
| `git-repos-push.spec.ts` | 3 | - | 7.0 | 남김 |
| `git-sidebar.spec.ts` | 22 | 26.8 | 0.0 | 남김 |
| `git-staging.spec.ts` | 8 | 17.9 | 0.0 | 남김 |
| `git-stash.spec.ts` | 11 | 17.0 | 0.0 | 남김 |
| `git-statusbar.spec.ts` | 3 | 2.7 | 0.0 | 남김 |
| `git-submodule-notice.spec.ts` | 10 | 10.0 | 0.0 | 남김 |
| `git-submodules.spec.ts` | 11 | 43.4 | 0.0 | 남김 |
| `git-subroot.spec.ts` | 4 | - | 0.0 | 남김 |
| `git-tag.spec.ts` | 7 | 16.6 | 0.0 | 남김 |
| `git-ui-metrics.spec.ts` | 6 | 7.8 | 0.0 | 남김 |
| `git-view-refresh.spec.ts` | 19 | 84.8 | 20.2 | 남김 |
| `git-window-name.spec.ts` | 2 | 2.2 | 0.0 | 남김 |
| `git-window.spec.ts` | 12 | 15.4 | 2.7 | 남김 |
| `git-worktree-repo.spec.ts` | 7 | 8.7 | 0.0 | 남김 |
| `git-worktrees.spec.ts` | 12 | 18.7 | 0.0 | 남김 |
| `git-write-order.spec.ts` | 4 | - | 0.0 | 남김 |
| `handle-size-hud.spec.ts` | 3 | 10.6 | 0.3 | 남김 |
| `history-branch-button.spec.ts` | 4 | 4.4 | 0.0 | 남김 |
| `i18n.spec.ts` | 6 | 7.2 | 0.0 | 남김 |
| `ime-order.spec.ts` | 7 | 7.9 | 0.0 | 남김 |
| `kit-button.spec.ts` | 4 | - | 0.0 | 남김 + 보류 1 (TC-KIT-6a) |
| `kit-components.spec.ts` | 12 | - | 0.0 | 남김 + 보류 1 (TC-CMP-7) |
| `kit-dialog.spec.ts` | 2 | - | 0.0 | 남김 |
| `kit-scroll.spec.ts` | 3 | - | 0.0 | 남김 |
| `layout.spec.ts` | 22 | 19.1 | 0.0 | 남김 |
| `leave-confirm.spec.ts` | 9 | 9.8 | 0.0 | 남김 |
| `m9-p1-ui.spec.ts` | 4 | 5.8 | 0.0 | 남김 |
| `migration-settings.spec.ts` | 1 | - | 0.0 | 남김 |
| `mobile-android-touch.spec.ts` | 8 | 7.8 | 0.5 | 남김 |
| `mobile-ime-order-touch.spec.ts` | 5 | 3.1 | 0.0 | 남김 |
| `mobile-kb-gate.spec.ts` | 9 | 7.0 | 0.0 | 남김 |
| `mobile-keybar-touch.spec.ts` | 11 | 12.7 | 1.3 | 남김 |
| `mobile-keybar.spec.ts` | 27 | 20.8 | 0.0 | 남김 |
| `mobile-tui-input-touch.spec.ts` | 12 | 11.6 | 0.6 | 남김 |
| `mobile-tui-input.spec.ts` | 3 | 2.6 | 0.0 | 남김 |
| `mobile-ux-overhaul.spec.ts` | 25 | - | 0.4 | 남김 |
| `mobile-wheel-touch.spec.ts` | 4 | 4.0 | 0.3 | 남김 |
| `notes-live-explorer.spec.ts` | 18 | 54.0 | 27.0 | 남김 (고정 대기 단축 검토) |
| `optimistic-layout.spec.ts` | 3 | 4.4 | 0.0 | 남김 |
| `pane-dom-reconcile.spec.ts` | 10 | 9.3 | 0.0 | 남김 |
| `panel-dock.spec.ts` | 12 | - | 0.3 | 남김 |
| `panel-layout.spec.ts` | 3 | - | 0.0 | 남김 |
| `panel-shortcuts.spec.ts` | 10 | 5.4 | 0.0 | 남김 |
| `panel-tabs-unify.spec.ts` | 6 | - | 0.0 | 남김 |
| `panel-template.spec.ts` | 11 | - | 0.0 | 남김 |
| `perf-render.spec.ts` | 3 | - | 5.0 | 남김 |
| `perf-repaint.spec.ts` | 5 | - | 0.0 | 남김 |
| `perf-statusbar.spec.ts` | 1 | - | 0.0 | 남김 |
| `poll-interval.spec.ts` | 21 | 22.7 | 2.1 | 일부 후보 (A 3: PIS1·2·16 / C 3: PIS9·10·14). 나머지는 남김 |
| `popup-default-action.spec.ts` | 18 | 15.1 | 0.0 | 남김 |
| `rail-chat-usage.spec.ts` | 3 | - | 0.0 | 남김 |
| `reconnect-storm.spec.ts` | 5 | 9.0 | 1.3 | 후보 C (전부: 합성 페이지, 이관 뒤 삭제) |
| `reduced-motion.spec.ts` | 3 | 2.3 | 0.0 | 남김 |
| `regression-focus.spec.ts` | 7 | 6.8 | 0.0 | 남김 |
| `regression-pane-scroll.spec.ts` | 6 | 6.9 | 0.0 | 남김 |
| `reload-continuity.spec.ts` | 5 | 5.7 | 0.0 | 남김 |
| `remote-close-focus.spec.ts` | 4 | - | 0.0 | 남김 |
| `remote-view-tab.spec.ts` | 2 | - | 0.0 | 남김 |
| `repaint.spec.ts` | 13 | 1.1 | 0.0 | 후보 C (전부: 합성 페이지, 이관 뒤 삭제) |
| `repo-diff-edit.spec.ts` | 8 | 13.6 | 3.0 | 남김 |
| `repo-tab-diff-preview.spec.ts` | 12 | - | 0.0 | 남김 |
| `repo-tab-pane-preview.spec.ts` | 6 | - | 0.0 | 남김 |
| `repo-tab.spec.ts` | 31 | 42.4 | 4.8 | 일부 후보 (D 1: X3). 나머지는 남김 |
| `restore-flight.spec.ts` | 6 | 5.4 | 0.0 | 남김 |
| `run-tree.spec.ts` | 3 | - | 0.0 | 남김 |
| `run-view-live.spec.ts` | 1 | - | 0.0 | 남김 |
| `runs.spec.ts` | 24 | 23.7 | 0.5 | 남김 |
| `sandbox-pick.spec.ts` | 13 | 9.3 | 0.5 | 남김 |
| `sandbox-runtime.spec.ts` | 9 | 10.0 | 0.0 | 남김 |
| `sandbox-window.spec.ts` | 3 | 0.0 | 0.0 | 남김 |
| `save-pipeline.spec.ts` | 6 | - | 1.5 | 남김 |
| `session.spec.ts` | 5 | 5.1 | 0.0 | 남김 |
| `settings-backup.spec.ts` | 9 | 8.4 | 0.0 | 남김 |
| `settings-legibility.spec.ts` | 5 | - | 0.0 | 일부 후보 (C 1: V-SIL-1). 나머지는 남김 |
| `settings-reset-revert.spec.ts` | 4 | 3.7 | 0.0 | 남김 |
| `settings.spec.ts` | 19 | 18.1 | 0.0 | 남김 |
| `sidebar-actions.spec.ts` | 1 | - | 0.0 | 남김 |
| `sidebar-collapse.spec.ts` | 24 | 20.5 | 0.0 | 남김 |
| `sidebar-tabs.spec.ts` | 21 | 26.2 | 0.6 | 남김 + 보류 1 (T1) |
| `skill-contract.spec.ts` | 23 | 25.4 | 0.0 | 남김 (HTTP·CLI 계약. 포팅 동등성에 직접 쓰인다) |
| `slot-live-refresh.spec.ts` | 7 | 13.9 | 0.6 | 남김 |
| `slot-marker.spec.ts` | 16 | - | 0.0 | 남김 |
| `slot-run-view.spec.ts` | 6 | 7.2 | 0.0 | 남김 |
| `slot-title-boundary.spec.ts` | 10 | 9.7 | 0.0 | 남김 |
| `slot-view-state.spec.ts` | 35 | 69.7 | 0.0 | 남김 |
| `small-traffic.spec.ts` | 4 | - | 2.4 | 남김 |
| `soft-reload.spec.ts` | 9 | 9.8 | 3.0 | 남김 |
| `sse-resilience.spec.ts` | 3 | 4.3 | 0.2 | 후보 C (전부: 합성 페이지, 이관 뒤 삭제) |
| `status-bar-reflow.spec.ts` | 3 | 3.0 | 0.0 | 남김 + 보류 1 (흔들림) |
| `statusbar-xss.spec.ts` | 4 | 3.3 | 0.0 | 남김 |
| `steady-traffic.spec.ts` | 2 | - | 30.0 | 남김 (D 후보 2개를 덮는 상위 시험) |
| `sync.spec.ts` | 4 | 8.3 | 1.0 | 남김 |
| `tab-names.spec.ts` | 15 | 15.2 | 3.0 | 남김 |
| `tab-reopen.spec.ts` | 11 | - | 1.1 | 남김 |
| `tab-width.spec.ts` | 11 | 16.7 | 0.0 | 남김 |
| `tab.spec.ts` | 5 | 5.5 | 0.0 | 남김 |
| `telegram-settings.spec.ts` | 2 | - | 0.0 | 남김 |
| `term-copy-paste.spec.ts` | 5 | - | 0.9 | 남김 |
| `term-gpu.spec.ts` | 4 | - | 0.0 | 남김 |
| `term-held-input.spec.ts` | 2 | - | 0.8 | 남김 |
| `term-hidden-reclaim.spec.ts` | 1 | - | 1.5 | 남김 |
| `term-lazy-connect.spec.ts` | 5 | - | 0.8 | 남김 |
| `term-mode-restore.spec.ts` | 3 | - | 1.5 | 남김 |
| `term-nudge-altscreen.spec.ts` | 3 | - | 1.0 | 남김 |
| `term-reclaim.spec.ts` | 2 | 3.7 | 0.0 | 남김 |
| `term-resume.spec.ts` | 2 | 6.2 | 1.3 | 남김 |
| `term-scroll-touch.spec.ts` | 8 | - | 2.1 | 남김 |
| `term-select-touch.spec.ts` | 5 | - | 0.9 | 남김 |
| `term-size.spec.ts` | 2 | 2.9 | 0.0 | 남김 |
| `terminal.spec.ts` | 10 | 14.4 | 0.0 | 남김 |
| `theme-seed.spec.ts` | 4 | - | 0.0 | 남김 |
| `theme.spec.ts` | 7 | 9.0 | 0.0 | 남김 |
| `timer-hub-bus.spec.ts` | 19 | 2.5 | 0.0 | 후보 C (전부: 합성 페이지. 3개는 단위가 이미 덮음, 16개는 이관 뒤 삭제) |
| `tool-list-unknown.spec.ts` | 5 | 4.7 | 0.0 | 남김 |
| `tooltips.spec.ts` | 15 | 11.5 | 0.0 | 남김 |
| `topbar-tab-name.spec.ts` | 2 | - | 0.0 | 남김 |
| `touch-targets.spec.ts` | 2 | 2.1 | 0.0 | 남김 |
| `ui-kit-icons.spec.ts` | 6 | 5.4 | 0.0 | 남김 |
| `ui-layout-defaults.spec.ts` | 8 | 9.1 | 0.6 | 남김 + 보류 1 (V-LAY-1·1b) |
| `ui-polish.spec.ts` | 13 | - | 0.0 | 일부 후보 (C 3: TC-UIP-1·2·4). 나머지는 남김 |
| `unfocused-edge.spec.ts` | 4 | 6.6 | 0.0 | 남김 |
| `update-notice.spec.ts` | 7 | - | 8.0 | 남김 + 보류 1 (폴링 없음 8초) |
| `ux-audit-fix-5.spec.ts` | 8 | - | 0.0 | 남김 |
| `ux-audit-fix-6.spec.ts` | 6 | - | 0.0 | 남김 |
| `ux-audit-fix-7.spec.ts` | 9 | - | 0.0 | 남김 |
| `ux-audit-fix.spec.ts` | 39 | - | 0.0 | 남김 |
| `ux-batch10.spec.ts` | 13 | - | 0.3 | 남김 |
| `ux-batch13.spec.ts` | 4 | - | 0.0 | 남김 |
| `version-autoreload.spec.ts` | 17 | 40.7 | 16.5 | 남김 |
| `view-scroll-restore.spec.ts` | 10 | 19.6 | 3.0 | 남김 |
| `viewer-url-open.spec.ts` | 6 | 5.1 | 0.0 | 남김 |
| `window-close-undo.spec.ts` | 6 | 19.1 | 0.0 | 남김 |
| `window-groups.spec.ts` | 21 | - | 0.0 | 남김 |
| `window-slots.spec.ts` | 45 | 46.8 | 0.0 | 남김 |
| `workspace-identity.spec.ts` | 10 | 8.5 | 1.0 | 남김 |
| `workspace-resync.spec.ts` | 4 | 11.7 | 8.0 | 일부 후보 (D 1: TC-M9-10b). 나머지는 남김 |
| `workspace-save-conflict.spec.ts` | 7 | 13.1 | 3.6 | 남김 |
