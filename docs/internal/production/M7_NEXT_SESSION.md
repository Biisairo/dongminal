# M7 다음 세션 착수 프롬프트 — 접근성·디자인 시스템·UX 안전

아래 블록을 새 세션에 그대로 붙여넣으면 된다.

**M7 은 진행 중이다** (2026-09-13, 다섯 번째 세션 종료). 선행 SRS 2건이 서 있고
**①·②·③·④·`UX-16`** 이 닫혔다. `⑤` 과도기 클래스는 **표면 다섯 중 넷**이 닫혔다
(옛 클래스 서른이 선언 0). 남은 것은 **`⑤` 의 git 패널 본체**(아홉), **P2 열**
(UX 넷 + FUI 여섯), 그리고 **M7 종료 판정**(SRS §5.2 사람이 보는 것 1회)이다.

---

```
프로젝트: /Users/dykim/personal/dongminal

M7(접근성·디자인 시스템·UX 안전) 진행 중이다. 선행·①·②·③·④·UX-16 이 끝났고
`⑤`(과도기 클래스, UX-17 포함)는 상단바·설정 모달·편집기·확인창 표면이 끝났다.
남은 것은 `⑤` 의 git 패널 본체 · P2 열 · 종료 판정이다. **다음은 `⑤` git 패널
본체(§7.5 아홉)** 다 — 한 표면, 전량 1회. 그다음 P2, 마지막에 M7 종료 판정
(§5.2 사람이 보는 것 1회).

## 상태

  사용자 결정    로드맵의 미결정 0건. 기준은 **WCAG 2.1 AA 전면**
                 (xterm 캔버스·Monaco 위젯은 예외 등록부 E-1·E-2)
  선행 SRS 2건   ACCESSIBILITY_BASELINE_SRS · DESIGN_TOKENS_SRS (둘 다 `승인·구현중`)
  닫힌 것        UX-6 · UX-5 · FR-DRV-13d (첫 세션)
                 UX-13 · UX-7 · UX-12 · UX-10 (둘째 세션)
                 UX-18 · UX-16(z-index) · UX-14 · UX-15 · UX-3 · UX-8 (셋째 세션)
                 UX-4 · UX-2 · UX-25 · G7-1(axe) (넷째 세션)
                 **UX-16(모달 골격 7벌) · ⑤ 표면 넷(+UX-17)** (다섯째 세션 —
                 D-TOK-10·11 · FR-TOK-40~45 · TC-TOK-21·22)
  게이트         `make gates` 33개 (`check-*` 30 + gofmt·vet·build). 이 세션은
                 게이트를 더하지 않았다 — `scripts/count-css-class-decls.mjs` 는
                 **자**(TC-TOK-22)이지 게이트가 아니다
  단위 테스트    133
  e2e            1,626 항목 · 155 스펙 (`a11y-dialog` +TC-TOK-21)
  전량 e2e       다섯 회차 (M7_PROGRESS §4) — 내 회귀 0. unexpected 는 전부
                 V169(HEAD 에서도 죽는다) 또는 §5-5 군집
  결정 색인      439건 (D-TOK-10·11 이 이 세션의 둘)
  예외 등록부    접근성 4건 · 토큰 0건

## 먼저 읽을 것

- `docs/internal/production/M7_PROGRESS.md` — **여기부터.** §1 이 전체 상태,
  **§2j 가 다섯째 세션이 배운 것**, §4 가 전량 회차, §5-5 가 flaky 진단
- `docs/internal/DESIGN_TOKENS_SRS.md` **§3.9(모달 골격 사상표) · §7(잔여표 —
  7.1~7.4 끝났다, 7.5 git 이 다음, 7.6 탭은 범위 밖) · D-TOK-10·11**
- `docs/internal/UI_LAYOUT_DEFAULTS_SRS.md` §9 — **기준선 JSON 이 클래스 목록을
  키로 쓴다.** 병기로 키가 바뀌면 그 행이 조용히 대조에서 빠진다 (아래 배운 것 35)
- `docs/internal/production/PRODUCTION_ROADMAP.md` §M7 — 범위의 진실

## 남은 것 — 착수 순서

**1. `⑤` git 패널 본체 (M) — §7.5 의 표**

  `.git-remote-btn` 22 · `.git-commit-btn` 12 · `.git-files-mode` 19 · `.git-init-btn` 9 ·
  `.git-file-act` 24 · `.git-op-act` 17 · `.git-wt-act` 16 · `.git-sub-act` 18 ·
  `.git-hunk-act` 15. **병기가 하나도 없다** — `panel-changes.js`·`commit.js`·
  `worktrees.js`·`submodules.js`·`panel-diff.js` 가 이름만 붙인다. 상태 규칙이
  붙어 있다: `.git-files-mode.active` · `.git-op-act[data-act=abort]` 위험색 ·
  `.git-remote-btn`+`.git-remote-more` 의 **묶인 모서리** · `.git-file-act` 의
  hover 에만 드러남과 `--git-hit` 하한 (`style-git-views.css:734`). 방식은 이 세션과
  같다: `ui-btn`(+등급) 병기 → 옛 이름 규칙에서 외형을 지우고 상태·배치만 남기되
  **상태는 키트 등급 토글로**(`.gc-go` 의 `_paint` 처럼), 배치는 담는 쪽 선택자로
  (D-TOK-11). e2e 가 아홉 이름 전부를 짚으므로 이름은 남는다 (②). `.git-file-act`
  의 30px 하한은 `ui-btn-lg` 가 같은 값이다 (`.ed-side-act` 가 그렇게 갔다).
  끝나면 `style-kit.css` 머리말의 "남은 것" 을 줄이고 전량 1회.

**2. P2 열 (S/M)**

  `UX-19`(시스템 다크/라이트 추종) · `UX-22`(단축키 발견) · `UX-23`(드래그 어포던스,
  `cursor:grab` 0건) · `UX-24`(탭 줄 오버플로) · `UX-26`+`FUI-26`+`FUI-08·12·17`
  (컨텍스트 메뉴 하나로, `UIKit.roving` 이 키 계약) · `FUI-22`(알림 개별 해제) ·
  `FUI-25`(프리셋 삭제 확인·로드 실패 피드백) · `FUI-27`(모바일 Runs·Agents 진입).
  묶음: 메뉴 다섯 · CSS 둘(`UX-23`+`UX-24`) · `UX-19` · `UX-22` · 작은 셋.

**3. M7 종료 판정**

  로드맵 §M7 DoD 와 대조하고 SRS §5.2 의 **사람이 보는 것**(VoiceOver 순회 · 테마 넷
  눈 확인 · xterm screen-reader 모드)을 1회 하고 기록한다. 두 SRS 를 `승인·구현완료`
  로. **D-5 는 M7 DoD 가 아니다** — §7.5·7.6 이 남아 있어도 M7 은 닫힌다; 그 사실을
  적는다.

## 이 세션이 닫은 것 — 다음 세션이 알아 둘 것

**UX-16 모달 골격** (§3.9): 오버레이 여섯에 `ui-modal`, 상자 여섯에 `ui-modal-box`
병기, 옛 오버레이 규칙 삭제. `.ui-modal` 이 `backdrop-filter:blur(2px)` 를 얻었고
`.ui-modal-box` 는 `--bg`·8px 로 (사용자 결정, D-TOK-10). `#modal-overlay` 의
`display:none`/`.open` 만 상태로 남는다. **옛 다섯은 `UIKit.dialogOpen` 을 부르지
않는다** — 트랩·복귀가 없다 (FR-TOK-45 로 비목표에 뒀다, 아래 "열려 있는 것").

**⑤ 표면 넷**: 상단바(`.tbtn`·`.mtbtn`) · 설정 모달(`.modal-close`·`.preset-*`·
`.ds-toggle`·`.sbx-del`·`.sc-rst`·`.drawer-close`) · 편집기(`.fe-find-*`·`.fe-offer-*`·
`.fe-dd-peek-*`·`.ed-side-act`·`.ed-head-btn`) · 확인창(`.confirm-*`·`.git-undo-btn`·
`.gc-*`·`.git-dialog-*`). 자는 `node scripts/count-css-class-decls.mjs <이름…>` —
0 이 아니면 종료코드 1.
  - **역할 색은 뜻이 고른다**: `.confirm-ok` 가 어디서나 붉던 것을 파괴적 닫기·
    삭제만 `danger`, 확인·실행·저장·백그라운드는 `primary` 로. `Toast` 의 action
    이 `ui-btn ui-btn-sm ui-btn-primary`. `.gc-go` 는 `_paint` 가 soft 면 `primary`
  - hover 에서만 붉어지는 삭제(`.runs-del`·`.bg-kill`·`.preset-del`)는 도메인 이름에
    남았다 — 키트 등급이 아니라 뜻이 다르다

## 이 세션이 비싸게 배운 것 (앞선 서른넷에 더해 셋)

35. **기준선 JSON 은 클래스 목록을 키로 쓰고, 키가 바뀐 행은 조용히 빠진다.**
    `ui-layout-defaults` 는 "양쪽에 있는 키만 대조한다" — 병기로 키가 바뀌면
    빨개지지 않고 그 행이 대조에서 사라진다. FR-TOK-37("판정은 검사다") 이 이
    부류를 못 본다. 키를 손으로 옮겨 적었고(마흔 행, `UI_LAYOUT_DEFAULTS_SRS` §9),
    값은 `LAYOUT_BASELINE=write` 로 **임시 파일**에 떠서 그 행만 가져왔다 — 기준선
    자체를 다시 뜨면 168행의 남의 드리프트가 함께 들어온다 (FR-LAY-51)

36. **이름을 키로 쓰는 배치 규칙이 "선언 0" 을 막는다 — 옮겨라, 예외로 두지 마라.**
    `.tbtn` 18선언 중 넷은 외형이 아니라 `.slot-ctl .tbtn{min-width}` 같은 배치였다.
    ③(근거 주석으로 남긴다)로 가고 싶어지지만 그러면 이름이 영원히 남는다. 키트
    선택자(`ui-btn-sm`)나 담는 쪽(`.fe-dd-peek-bar>.ui-btn-icon`)·id(`#drawer-close`)
    로 옮기면 문자 그대로 0 이다 (D-TOK-11). 이 세션에서 ③ 은 `#modal-overlay` 의
    켜고 끄기 하나뿐이다

37. **키트를 붙이면 요소 선택자 규칙이 키트를 덮는다.** `.fe-offer button{…}`·
    `.confirm-btns button{…}` 은 (0,1,1) 이라 `.ui-btn`(0,1,0) 보다 세다 — 병기만
    하면 키트는 아무것도 그리지 않는다. 그 규칙을 지우면 **같은 선택자 아래의
    다른 버튼**(`.fe-offer-go`·`.fe-offer-set`)도 맨몸이 되므로 함께 키트에 올려야
    한다. 한 표면의 "옛 클래스 목록" 은 이름이 아니라 **캐스케이드가 닿는 범위**다

## e2e — 무엇을 신호로 쓰나

(넷째 세션의 규약 그대로 — 아래 "변하지 않는 규약". 이 세션의 다섯 회차는 전부
unexpected ≤ 1 이었고 그 하나는 V169 또는 §5-5 군집이다. **V169 는 HEAD 에서도
단독 2/2 로 죽는다** — 그 검사 자신의 문제이고, 다음 세션이 §5-5 를 손대면 거기서
시작하면 된다.)

    벽시계 ~4.4분 · 항목 1,626 · 스펙 155 · 불균형 1.00배

**새 스펙을 더하면** `make e2e-rebalance` — 직전 전량의 JSON 리포트를 읽으므로
**전량 뒤·표적 전**에 돌린다.

## 변하지 않는 규약

- **로컬 전량은 `make e2e`** (8샤드 병렬, ~4.5분). 판정은 `unexpected 0`
- **출력을 자르지 마라.** `LC_ALL=C grep -a` 로 읽어라. 합성 명령의 종료코드는
  로그 파일의 `종료코드` 줄을 읽어라
- **전량이 도는 동안 `web/js`·CSS·`scripts/`·`e2e/` 를 고치지 마라** (문서는 된다)
- **전량을 겹쳐 돌리지 마라** · **재시동은 하지 않는다** · `--isolated`
- 중·대 규모는 **스펙 → 테스트(RED) → 구현(GREEN)**
- **동작을 바꾸면 그 근거 문서를 같은 변경에서 고쳐라** (이전/새/이유)
- 게이트를 세우면 **탐침으로 검출을 확인하고 지운다** · Makefile 과 `verify.yml`
  둘 다
- **하네스를 복사하지 마라** — 새 단정은 그 설정이 이미 있는 자리에
- `decisions.md` 는 생성물이다. `D-*` 를 더하면 `go run ./scripts/gen-decisions`
- **기준선 JSON 의 키가 바뀌는 변경은 그 행을 손으로 옮긴다** (배운 것 35)
- 커밋 메시지에 AI 서명 금지. 커밋은 사용자 확인 후에만
```

---

## 이 세션이 남긴 수치 (2026-09-13, 다섯 번째)

| 항목 | 착수 시 | 지금 |
|---|---|---|
| 모달 오버레이 골격 | 7벌 (같은 8선언 ×6) | **1벌** (`.ui-modal`) + 상태 2선언 |
| `.ui-modal-box` | `--sidebar-bg`·6px (소수) | `--bg`·8px (다수값, D-TOK-10) |
| §7 잔여표 | 비어 있음 | 채움 — 옛 클래스 서른 → **0** · 남은 것 git 아홉 + 탭 넷 |
| `.tbtn` 키트 없는 자리 | 9 | 0 |
| e2e | 1,625 · 155 | **1,626 · 155** (TC-TOK-21) |
| 기준선 JSON | — | 키 마흔 옮김, `display` 서른 정정 (§9) |
| 결정 색인 | 437 | **439** (D-TOK-10·11) |
| 게이트 · 단위 | 30 · 133 | 30 · 133 |

## 이 세션의 커밋

```
(커밋 전 — 사용자 확인 대기)
```

---

## 이 세션이 남긴 수치 (2026-09-13, 네 번째)

| 항목 | 착수 시 | 지금 |
|---|---|---|
| 우리 코드의 `role=`/`setAttribute('role'` | 12 | 목록 `listbox/option` · 탭 `tablist/tab` · 트리 `tree/treeitem` 이 팩토리에서 파생 |
| `Tab` 으로 닿는 창 항목·분할 칸 탭·탐색기 행 | 0 · 0 · 컨테이너만 | 셋 다 (TC-A11Y-6a·b·c) |
| 단축키 없는 파일 열기 | 불가 | `Tab`·화살표·`Enter` 만으로 (TC-A11Y-7) |
| `touch-targets` 의 손 목록 | `ROLELESS` 6 | `POINTER_ONLY` 2 (`×` 둘, D-A11Y-10) |
| 창 닫기 | 한가한 창 즉시 kill | **5초 Undo**, 유예 중 백그라운드 (`UX-2`) |
| 파일 삭제 | 확인창만 | 추적 파일이면 복구 힌트 `Toast` (`UX-25`) |
| axe 스모크 | 없음 | 표면 셋 · 위반 0 · 첫 판 42 → 0, 예외 불변 (`G7-1`) |
| 이름 없는 `<input>`/`<select>` | 17 + 6 | **0** (구조에서 파생) |
| e2e | 1,606 항목 · 152 스펙 | **1,625 · 155** (`a11y-keyboard` 9 · `window-close-undo` 6 · O11 · `a11y-axe` 3) |
| 결정 색인 | 431건 | **437건** (D-A11Y-10·11·12 · D-WCU-1·2·3) |
| 게이트 · 단위 | 30 · 133 | 30 · 133 |

## 이 세션의 커밋

```
8cb145e  feat(a11y): 목록·탭·트리에 역할과 키 이동을 준다 (UX-4)
cd90223  test(e2e): 새 스펙을 시간표에 넣는다 (a11y-keyboard)
67793ec  docs(m7): 네 번째 세션의 근거를 맺고 다음 인계를 세운다
1d96dfb  docs(m7): 인계서에 커밋 해시를 적는다
e299e58  docs(m7): 인계서에 로드맵의 FUI 여섯을 되살린다
9e2ce7f  feat(ux): 창 닫기를 5초 안에 되돌린다 (UX-2)
8f24b7b  feat(explorer): 지운 파일의 복구 길을 알린다 (UX-25)
ebe7f5f  test(e2e): 시간표를 다시 맞춘다 (window-close-undo)
554c7db  docs(m7): ③ 을 맺고 ④ 로 인계한다
e52b878  feat(a11y): axe 스모크가 서고 첫 판의 마흔둘을 닫는다 (G7-1)
f6068c1  test(e2e): 시간표를 다시 맞춘다 (a11y-axe)
a91f714  docs(m7): 네 번째 세션을 맺고 다섯 번째로 인계한다
```

---

## 세 번째 세션이 남긴 수치 (2026-09-13)

| 항목 | 착수 시 | 지금 |
|---|---|---|
| `font-size` px 리터럴 | 378곳 · 12종 | **0** (선언 385개 전부 토큰) |
| z-index 선언 | 44 · 28값 · 1~9999 | **43 · 여섯 층** (100~600) |
| `:root` 밖 색 리터럴 | 116 (그중 52는 마스크 알파) | **0** |
| `aria-live` 리전 | **0** | 2 (`#toast-host` · `.tp-overlay`) |
| 알림 채널 | 4 | **2** |
| `role="dialog"` | 2 (labelledby·트랩 없음) | 설정 모달·`UIKit.modal` 이 계약을 갖는다 |
| 게이트 (`check-*`) | 27 (CI 26) | **30** (CI 30) · **일치** |
| 단위 테스트 | 133 | 133 |
| e2e | 1,600 항목 · 150 스펙 | **1,606 · 152** |
| 토큰 예외 등록부 | 0건 | **0건** (지역 토큰으로 풀었다) |
| 결정 색인 | 428건 | **431건** (D-A11Y-7·8·9) |

## 세 번째 세션의 커밋 셋

```
507458f  feat(tokens): 글자 크기를 다섯 눈금으로 모은다 (UX-18)
9957d92  docs(tokens): z-index 를 여섯 층으로 정하고 44선언 전수를 사상한다 (UX-16 스펙)
ffa1d02  feat(tokens): z-index 를 여섯 층으로 모은다 (UX-16 절반)
1e69954  feat(tokens): 색을 :root 하나로 모은다 (UX-14 · UX-15)
f50af56  docs(m7): ② 의 근거와 flaky 진단의 정정을 적는다
e65c9fb  feat(a11y): 모달에 dialog 시맨틱과 포커스 관리를 준다 (UX-3)
464b219  docs(m7): UX-3 의 근거를 적는다 (§2d)
7534fa3  feat(a11y): 알림이 읽힌다 — 라이브 리전과 채널 통합 (UX-8)
dce48a9  test(e2e): 새 스펙 둘을 시간표에 넣는다 (a11y-dialog · a11y-live)
(이 커밋) docs(m7): 세 번째 세션의 근거를 맺고 다음 인계를 세운다
```

## 열려 있는 것

**전량 3회 연속 flaky 0** (로드맵 §M6 DoD). **한 회차를 처음으로 달성했다**
(`UX-3` 뒤, 1,607항목). 그러나 같은 코드에서 다음 세 회차가 8 → 3 → 4 로 흔들렸다 —
**전량을 반복해 0 을 쫓는 것으로는 수렴하지 않는다.**

§5-5 가 대상을 좁혔다: 19건 중 16건이 **두 부류**이고 둘 다 주기적으로 도는 것을
기다린다 — 칸별 상태(`slot-view-state`·`slot-live-refresh`)와 git 관측 주기
(`git-worktrees`·`git-history`·`git-refresh-lifecycle`·`git-observe-revive`·
`git-head-mobile`). 스무 개의 검사가 아니라 **두 헬퍼**를 보는 일일 가능성이
높다 (예: `expect.poll` 의 대상이 "요청이 왔는가" 인지 "화면이 그것을 반영했는가"
인지 — M6 `TEST-16` 의 판정이 여기 다시 걸린다). 그 자체로 하나의 작업이다.

**옛 모달 다섯에 접근성 계약이 없다.** `.confirm-overlay`·`.bg-modal`·`.runs-modal`·
`.gc-modal`·`.git-dialog` 는 `UIKit.dialogOpen` 을 부르지 않는다 — `Tab` 이 밖으로
나가고 닫아도 연 컨트롤로 돌아가지 않는다. `UX-3` 의 DoD 범위는 설정 모달·
`UIKit.modal` 이었고 골격 수렴은 CSS·DOM 만 접었다 (FR-TOK-45). 골격이 한 벌이
됐으니 다섯에 `dialogOpen(box)` 한 줄씩 넣는 것은 이제 S 다 — 접근성 SRS 의
변경으로 다뤄라 (FR-A11Y-18 의 범위를 넓히고 `a11y-dialog` 에 단정을 더한다).

**`⑤` 의 git 패널 본체와 탭 넷** — §7.5·7.6. D-5 는 그때까지 열려 있다.

**`Tab` 이 벤더 표면에 갇힌다.** xterm 과 Monaco 는 `Tab` 을 먹는다 — 키보드
사용자가 터미널에 들어가면 **나올 길이 없다** (`a11y-keyboard` 의 `tabTo` 가 그
자리에서 멎는 것으로 실측). E-1·E-2 의 범위 안이지만 "벤더의 접근성 모드를 따른다"
가 탈출 키까지 주지는 않는다. 사용자 결정이 필요한 자리다 — 예: `Ctrl+M`(Monaco 의
관용) 류의 탈출 키를 둘 것인가.

**`.git-repo-xslot`** — CSS `style-git-views.css:396·398` 에 남아 있으나 JS 어디서도
만들지 않는 죽은 선택자다 (같은 파일 `:760` 의 주석이 이미 "사라졌다" 고 적는다).
`⑤` 와 함께 지우면 된다.

**`.ver-held`(버전 보류 배너)** — 알림을 셋 모았으나 이것은 범위 밖으로 뒀다.
FR-A11Y-19 가 요구하는 셋(업로드·재연결·Undo)에 없고 다른 의미다. 모으면 로드맵의
"알림 채널 4종 분산" 이 완전히 닫힌다.

**`style-docrender.css` 의 `var(--term-*, …)` 폴백 여섯** — 여섯 이름이 모두
`:root` 와 `applyThemeObj` 에 있으므로 그 폴백은 죽은 안전망이다. FR-TOK-5 의
규약("토큰이 정의되면 폴백은 거짓 안전망이다")이 가리키는 자리지만 FR-TOK-29 는
색 **리터럴**을 재므로 게이트가 잡지 않는다. 지우는 것이 옳다.
