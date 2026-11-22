# SRS: 아이콘 세트 재정비 — 한 뜻 한 아이콘, 선 한 벌의 톤 (IEEE 29148 준수)

> **문서 상태**: 승인·구현완료
>
> 개정 2026-11-22: D-ICN-25 — 선 굵기 2.25 → 2 (사용자 피드백)
>
> 근거: `web/index.html` `#ui-sprite`(심볼 70개)·`web/style-kit.css` `.ui-icon`·`#ui-sprite .t`·`web/js/test/icon-set.test.mjs`(TC-ICN-1~7)·관련 e2e 28 spec 통과. 옅은 면이 `<use>` 복제본에 먹는 것(A-1)은 Chromium 화면으로 확인했다

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
UI 아이콘 스프라이트(`web/index.html` `#ui-sprite`)를 다시 짠다. 목표는 셋이다.
1. 아이콘 하나는 뜻 하나만 나른다. 뜻 하나는 아이콘 하나로만 그린다.
2. 처음 보는 사람이 한눈에 뜻을 안다.
3. 모든 아이콘이 같은 톤(선 굵기·끝 모양·옅은 면 규칙)을 갖는다.

### 1.2 범위 (Scope)
- 포함: 스프라이트 심볼 교체·추가·삭제, 아이콘 이름을 적은 모든 자리(상수·`UIKit.icon`·`UIKit.iconHTML`·`UIKit.button({icon})`·`index.html` 의 `#i-*`), `.ui-icon` 선 굵기, 옅은 면 스타일, CSS 마스크 꺾쇠(`--ui-chev-right`)의 선 굵기, 시험
- 비포함: 아이콘 크기 토큰(`--ui-icon-*`)·버튼 치수, 아이콘 색(위험색 등 기존 규칙 그대로), 툴팁·`aria-label` 문구, 아이콘이 아닌 글자(git 상태 문자·lane 그래프 — `UI_KIT_SRS` FR-GLY-8), 회전 애니메이션

### 1.3 정의 (Definitions)
- **뜻**: 아이콘이 화면에서 사용자에게 전하는 의미 하나. 상태가 둘 이상인 뜻(펼침/접힘, 이전/다음)은 심볼을 둘 이상 갖는다
- **물체 모양**: 실제 물건이나 화면 속 물건을 그린 아이콘. 폴더·상자·책·창·말풍선·종·톱니·키보드·구름·로봇·팔레트·휴지통·종이·모래시계 등
- **기호 모양**: 물건이 아닌 표지. 화살표·꺾쇠·더하기·빼기·체크·x·점·동그라미 상태·그래프(브랜치·흐름도·트리)·목록 줄
- **옅은 면**: 물체 모양의 몸통에 까는 반투명 채움. 심볼 안에서 `class="t"` 를 단 요소다
- **쓰는 자리**: 아이콘 이름을 적은 코드 위치

### 1.4 관계 (References)
- `UI_KIT_SRS.md` §3.3 FR-GLY-1~9 를 **개정한다.** FR-GLY-2 의 `stroke-width:2` 는 FR-ICN-2 가 이어받는다(한때 2.25 였다가 D-ICN-25 로 2 에 돌아왔다). FR-GLY-2 의 「채움 없음」 은 FR-ICN-3 의 옅은 면만 예외로 둔다. FR-GLY-3 의 「Lucide(MIT)」 는 FR-ICN-11 로 바로잡는다(실제 라이선스는 ISC). FR-GLY-4 의 초기 사상표는 역사 기록으로 남고, 현재 사상은 이 문서 §3.2 다
- `UX_AUDIT_FIX_SRS.md` FR-UXF-100~102(D-36) — 문자 아이콘 금지는 그대로 유효하다
- `UX_AUDIT_FIX_SRS.md` FR-UXF-10 을 **개정한다**(D-ICN-23)
- 시안 자료: `docs/internal/design/icons-2026-11-22/`(`proposal.html` 시안 비교, `meanings.mjs` 뜻 63개 표, `gen.mjs` 직접 그린 시범 C 의 경로)

### 1.5 사용자 결정 (2026-11-22)

| # | 결정 |
|---|---|
| D-ICN-1 | 사용자 문제 제기: Repo·History 아이콘이 어울리지 않고, Submodule·Worktree 는 한 번 더 생각해야 이해된다. 짝을 다시 맞추고 이쁘고 귀엽게 해도 좋다 |
| D-ICN-2 | 시안 세 벌(A Lucide 선 / B Phosphor Duotone / C 직접 그린 시범)을 본 뒤의 지시: 뜻마다 **최선의 모양, 한 번에 이해되는 모양**을 고르되, 세 시안을 오가며 고르면 톤이 달라지므로 **두께·느낌 등 톤을 맞춘다**. 모양 선택은 위임받았다 |
| D-ICN-3 | 톤 규칙 ①: **선 기반 한 벌.** FR-GLY-2(stroke·currentColor) 규약을 지킨다. B(채움 기반)에서 고른 뜻은 선으로 다시 그려 같은 톤에 맞춘다 |
| D-ICN-4 | 톤 규칙 ②: **stroke-width 2.25, 둥근 끝(round cap)·둥근 이음(round join)** 으로 통일한다(이전 2) |
| D-ICN-25 | (2026-11-22, 사용자 피드백) D-ICN-4 의 선 굵기를 **2.25 → 2** 로 되돌린다. 둥근 끝·둥근 이음은 그대로다 | 사용자: 「아이콘 선 두께 좀만 얇게. 조금만 복잡한 아이콘은 선이 뭉개진다」. 1배 화면 실측(16px) — 2.25 에서 톱니·팔레트·키보드·겹친 층의 선 사이가 붙었고, 2 에서 벌어졌다. 1.75 는 `+`·`−`·화살표가 옅어져 「조금」 보다 많이 바뀐다 |
| D-ICN-5 | 톤 규칙 ③: **옅은 면(opacity .18)은 물체 모양에만** 일관되게 깐다. 화살표·꺾쇠·점 같은 기호 모양에는 깔지 않는다 |
| D-ICN-6 | 톤 규칙 ④: **한 뜻 = 한 아이콘, 한 아이콘 = 한 뜻.** 남는 겹침 하나(`chevron-right` 의 접힘 / 다음)는 방향 꺾쇠 관례라 둔다 |
| D-ICN-7 | 쓰는 곳 없는 `file`·`panel-left` 는 스프라이트에서 뺀다 |

### 1.6 설계 결정 (위임받아 정한 것)

| # | 결정 | 이유 |
|---|---|---|
| D-ICN-8 | 모양은 Lucide 1.77.0 의 경로를 먼저 쓰고, 맞는 그림이 없는 뜻 넷(저장소·창 그룹·기록·Fetch)만 직접 그린다(시안 C 의 경로) | Lucide 경로는 24 격자에 맞춰 손질되어 16px 에서 또렷하다. 직접 그린 것을 늘리면 유지 비용이 늘고(시안 C 의 단점) 톤이 흔들린다 |
| D-ICN-9 | 저장소(Repo) = 책갈피 꽂힌 책(`git-repo`, 시안 C) | GitHub 가 저장소를 책으로 그려 개발자에게 익숙하다. `folder-git-2` 는 폴더라 작업 트리(폴더 두 겹)·폴더 표시와 모양이 가깝다 |
| D-ICN-10 | 기록(History) = 커밋 점 셋 + 메시지 줄(`git-history`, 시안 C). 점에는 옅은 면을 깔지 않는다 | `git log` 화면 그대로라 한눈에 읽힌다. `git-commit-vertical` 은 커밋 하나라 「기록」 보다 「커밋」 으로 읽힌다. 점은 기호라 D-ICN-5 를 따른다 |
| D-ICN-11 | 하위 모듈(Submodules) = `blocks`(떨어진 블록 하나를 옅은 면으로) | 시안의 `package`(상자)는 샌드박스의 `container`(상자)와 같은 육각 실루엣이라 16px 에서 갈리지 않는다. 「큰 덩어리에 끼운 작은 모듈」 이 하위 모듈을 바로 말한다 |
| D-ICN-12 | 작업 트리(Worktrees) = `folders`(앞 폴더에 옅은 면) | 「같은 저장소를 여러 폴더에 펼친 것」. 시안 A·B·C 가 모두 같은 뜻이었다 |
| D-ICN-13 | 임시 보관(Stash) = `archive`(몸통에 옅은 면) | 「상자에 넣어 둔다」. 시안 C 의 상자와 같은 그림이고 Lucide 경로가 더 고르다 |
| D-ICN-14 | 콘솔(Console) = `square-terminal`(창 틀에 옅은 면) | 시안 C 의 「창 틀 + 프롬프트」 와 같은 그림이다. 프롬프트만 있는 `terminal` 은 옅은 면을 깔 몸통이 없어 물체 톤과 어긋난다 |
| D-ICN-15 | Fetch = 닫힌 구름 + 안쪽 아래 화살표(`git-fetch`, 시안 C, 구름에 옅은 면). Pull·Push = `arrow-down-to-line`·`arrow-up-from-line`(면 없음) | 구름이 「원격」 을 말한다. Lucide `cloud-download` 는 구름 선이 열려 있어 면을 깔 수 없다. Pull·Push 는 화살표라 기호다 — 시안 C 의 바닥 막대 면은 D-ICN-5 와 맞지 않는다 |
| D-ICN-16 | 에이전트 상태 넷 = 작업 중 `loader-circle` · 끝남 `circle-check` · 기다림 `hourglass`(아래 모래에 옅은 면) · 쉼 `circle-dashed` | 넷 모두 동그라미 크기 안에 든다. 모래시계만 물체라 면을 깐다. 시안 C 의 달(쉼)은 「다크 모드」 로 먼저 읽힌다 |
| D-ICN-17 | 패널 접기·펴기 = `panel-{left,right}-{close,open}` 넷(패널 띠에 옅은 면). 사이드바와 Activity 패널이 같이 쓴다 | 시안의 뜻 표는 사이드바 접기(`panel-left-close`) 하나만 적었으나, 실제 코드(`agCollapseIcon`)는 패널 쪽(좌/우)과 상태(펼침/접힘)에 따라 `chevron-left`·`chevron-right` 를 고른다. 같은 뜻의 상태 넷이므로 같은 그림 계열로 넓힌다. 꺾쇠는 「이전/다음」 에만 남는다 |
| D-ICN-18 | 샌드박스 = `container`(바깥 윤곽에 옅은 면) | 시안 A 그대로다. 「격리된 컨테이너」 이고 이 앱의 샌드박스는 창마다 컨테이너다(`architecture.md` `sandbox/`). D-ICN-11 로 상자 모양 겹침이 풀렸다 |
| D-ICN-19 | 옅은 면은 심볼의 `class="t"` 요소에 CSS 한 규칙으로 준다. 심볼은 채움·투명도 속성을 스스로 갖지 않는다 | 투명도 값 하나를 한 자리에 둔다(상수 하드코딩 금지). 심볼은 모양만 갖는다는 FR-GLY-2 의 원칙을 지킨다 |
| D-ICN-20 | 이름은 Lucide 에서 가져온 것은 Lucide 이름 그대로, 직접 그린 것은 뜻 이름(`git-repo`·`git-history`·`git-fetch`·`window-group`)을 쓴다. 이전 자작 `git-stash`·`git-worktree`·`git-submodule`·`terminal-bg` 는 지운다 | 이름만 보고 출처를 안다. 이전 이름에 새 모양을 담으면 옛 문서·주석과 어긋난다 |
| D-ICN-21 | 기본 프리셋 = `bookmark`, 즐겨찾기 = `star`. 둘 다 켜짐 상태는 지금처럼 꽉 채운다(`ui-icon-fill`) | 별은 브랜치 즐겨찾기에만 남긴다(시안 표). 채움으로 켜짐을 보이는 기존 동작을 바꾸지 않는다 |
| D-ICN-22 | Discard 의 위험색은 이미 CSS(`style-git-commit.css` `[data-act="discard"]`)가 칠한다. 색 규칙은 바꾸지 않는다 | 시안의 「이쪽만 위험색」 은 이미 지금 동작이다 |
| D-ICN-23 | 앱 다시 읽기(`#soft-reload-btn`)와 목록 다시 읽기는 같은 `refresh-cw` 다. `UX_AUDIT_FIX_SRS` FR-UXF-10(둘을 가른다)을 개정한다 | 시안 표의 결정이다(「같은 다시 읽기에 두 그림」). 두 단추는 놓인 자리(사이드바 아래 / 파일 트리 머리)가 달라 같은 그림이어도 헷갈리지 않고, `rotate-ccw` 는 「되돌리기」 로 읽힌다 |
| D-ICN-24 | 스프라이트의 선은 `<line>` 대신 `<path>` 로 적는다(Lucide 의 `hash`·`user-minus` 를 옮겨 적었다) | 레이아웃 기준선 e2e(V-LAY-1)가 문서의 모든 요소를 태그로 세어, 새 태그가 「재지 않는 자리」 9개로 잡혔다(2026-11-22 전량 e2e). 모양은 같다 |

### 1.7 가정 (Assumptions)
- A-1: 문서 CSS 규칙은 `<use>` 가 복제한 심볼 내용에도 적용된다(SVG 2 — 복제본은 원본 요소에 맞는 규칙을 받는다). 구현 때 화면으로 확인한다
- A-2: 아이콘 크기는 13~20px 이다. 2 선은 16px 에서 1.33px 이다(D-ICN-25 전의 2.25 는 1.5px)

## 2. 현황 (Current State)
- 스프라이트는 심볼 54개, 쓰는 곳 없는 것 2개(`file`·`panel-left`)
- 한 아이콘이 여러 뜻에 쓰인다: `x`(닫기·지우기·나가기·알림 확인), `plus`(새로 만들기·Stage), `minus`(칸 빼기·Unstage·내보내기), `folder`(창 그룹·트리 보기·폴더), `git-branch`(Repo 탭·Branches 탭), `check`(현재·끝남), `more-horizontal`(메뉴·기다림), `star`(프리셋·즐겨찾기), `undo`(Discard·기본값), `list`(목록 보기·그룹 방), `message-square`(Chat 탭·1:1), `chevron-left`(이전·뒤로·접기), `arrow-up/down`(찾기·Push·Pull)
- 한 뜻을 여러 아이콘이 그린다: 메뉴 열기(`more-horizontal`·`chevron-down`), 다시 읽기(`rotate-ccw`·`refresh-cw`), 지우기(`x`·`trash`), 펼침(`chevron-up`·`chevron-down`)
- 선 굵기 2, 면 없음. 작업 중 점만 채워 그린다(`dot` + `ui-icon-fill`)

## 3. 요구사항 (Specific Requirements)

### 3.1 톤

**FR-ICN-1** — 모든 심볼은 `viewBox="0 0 24 24"` 이고 `stroke`·`stroke-width`·`stroke-linecap`·`stroke-linejoin`·`fill`·`opacity` 속성을 스스로 갖지 않는다(D-ICN-19).

**FR-ICN-2** — `.ui-icon` 은 `stroke-width:2`·`stroke-linecap:round`·`stroke-linejoin:round`·`fill:none`·`stroke:currentColor` 다. CSS 마스크 꺾쇠 `--ui-chev-right` 도 2·둥근 끝이다(D-ICN-4, D-ICN-25).
  - **개정 (2026-11-22, D-ICN-25)** — 이전: 2.25 / 새: 2 / 이유: 복잡한 아이콘의 선이 1배 화면에서 뭉개졌다(사용자 피드백).

**FR-ICN-3** — 옅은 면은 `#ui-sprite .t{fill:currentColor;stroke:none;opacity:.18}` 한 규칙이 준다(D-ICN-5·19).

**FR-ICN-4** — 물체 모양 심볼은 `.t` 요소를 하나 이상 갖고, 기호 모양 심볼은 갖지 않는다. 어느 심볼이 물체인지는 §3.2 표의 「면」 열이 정한다.

### 3.2 뜻과 심볼

**FR-ICN-5** — 스프라이트의 심볼은 아래 표의 심볼과 정확히 같다(더 있거나 빠진 것이 없다).

**FR-ICN-6** — 심볼 하나는 뜻 하나에만 속한다. 예외는 `chevron-right`(접힘 / 다음 항목) 하나다(D-ICN-6).

**FR-ICN-7** — 각 뜻의 쓰는 자리는 표의 심볼 이름을 쓴다.

| 뜻 | 쓰는 자리 | 심볼 | 면 | 이전 |
|---|---|---|---|---|
| 창 탭(Windows) | 사이드바 탭 줄 | `app-window` | ○ | 같음 |
| 저장소 탭(Repo) | 사이드바 탭 줄 | `git-repo` | ○ | `git-branch` |
| 창 그룹 | 사이드바 「Group」 단추 | `window-group` | ○ | `folder` |
| 더하기·새로 만들기 | 새 창·저장소 추가·칸 더하기·새 탭·새 그룹 채팅 | `plus` | | 같음 |
| 칸 하나 빼기 | 상단 칸 수 빼기 | `minus` | | 같음 |
| 샌드박스 | 샌드박스 창 만들기·창 이름표 배지 | `container` | ○ | `box` |
| 기본 프리셋 | 「Preset」 단추·설정의 기본 프리셋 표시 | `bookmark` | ○ | `star` |
| 프리셋 불러오기 | 설정 프리셋 행 | `play` | | 같음 |
| 닫기 | 모달·설정·찾기 줄·탭·미리보기·트리 오류 줄·모바일 서랍·모바일 Activity 시트 | `x` | | 같음 |
| 서랍 메뉴 열기 | 모바일 서랍 | `menu` | | 같음 |
| 추가 동작 메뉴 | 채팅방 동작·diff 더 보기·커밋 더 보기·원격 더 보기·계정 Smart 메뉴 | `ellipsis` | | `more-horizontal`·`chevron-down` |
| 펼침 / 접힘 | 트리·그룹·찾기 바꾸기 줄·에이전트 접기·사용량 요약 | `chevron-down` / `chevron-right` | | `chevron-up` 포함 |
| 이전 / 다음 항목 | 모바일 칸 포커스·diff 파일 이동 | `chevron-left` / `chevron-right` | | 같음 |
| 뒤로 / 앞으로 | 포커스 기록·모바일 시트 뒤로·문서 보기 원문으로 | `arrow-left` / `arrow-right` | | 시트·문서는 `chevron-left` |
| 패널 접기 / 펴기 | 사이드바·Activity 패널의 접기 단추(좌·우) | `panel-left-close` / `panel-left-open` / `panel-right-close` / `panel-right-open` | ○ | `chevron-left`·`chevron-right` |
| 칸 나누기(좌우 / 위아래) | 칸의 나누기 방향 단추 | `columns-2` / `rows-2` | ○ | `columns`·`rows` |
| 키보드 줄 열기 | 모바일 키 줄 | `keyboard` | ○ | 같음 |
| 찾기 | 칸 찾기 단추·찾기 칸 머리 | `search` | ○ | 같음 |
| 이전 / 다음 찾기 결과 | 찾기 줄·편집기 찾기 | `arrow-up` / `arrow-down` | | 같음 |
| 알림 | 상단 주의 배지 | `bell` | ○ | 같음 |
| 알림 확인 | 알림 목록 한 건 지우기 | `check-check` | | `x` |
| 설정 | 사이드바 아래 설정 단추 | `settings` | ○ | 같음 |
| 다시 읽기 | 앱 다시 읽기·파일 트리 다시 읽기 | `refresh-cw` | | 앱은 `rotate-ccw` |
| 브랜치(Branches) | Git 패널 탭 | `git-branch` | | 같음 |
| 기록(History) | Git 패널 탭 | `git-history` | | `clock` |
| 임시 보관(Stash) | Git 패널 탭 | `archive` | ○ | `git-stash` |
| 콘솔(Console) | Git 패널 탭 | `square-terminal` | ○ | `terminal` |
| 작업 트리(Worktrees) | Git 패널 탭 | `folders` | ○ | `git-worktree` |
| 하위 모듈(Submodules) | Git 패널 탭 | `blocks` | ○ | `git-submodule` |
| Fetch | 원격 단추 | `git-fetch` | ○ | `download` |
| Pull | 원격 단추 | `arrow-down-to-line` | | `arrow-down` |
| Push | 원격 단추 | `arrow-up-from-line` | | `arrow-up` |
| 파일 열기 | 변경 행 | `square-arrow-out-up-right` | | `external-link` |
| Stage | 변경 행 | `square-plus` | | `plus` |
| Unstage | 변경 행 | `square-minus` | | `minus` |
| 변경 버리기(Discard) | 변경 행 | `undo-2` | | `undo` |
| 트리로 보기 | 변경 목록 보기 방식 | `folder-tree` | | `folder` |
| 목록으로 보기 | 변경 목록 보기 방식 | `list` | | 같음 |
| 기록 보기 옵션 | History 옵션 줄 | `sliders-horizontal` | | `sliders` |
| 즐겨찾기 | 브랜치 즐겨찾기 표시·토글·그룹 머리 | `star` | | 같음 |
| 현재 · 선택됨 | 현재 브랜치·메뉴의 고른 항목 | `check` | | 같음 |
| 에이전트(Agents) | Activity 구역 머리·모바일 아래 탭 | `bot` | ○ | 같음 |
| 백그라운드(Background) | Activity 구역 머리 | `layers` | ○ | `terminal-bg` |
| 실행(Runs) | Activity 구역 머리 | `workflow` | | 같음 |
| 하위 에이전트 | 하위 줄의 꺾인 화살표 | `corner-down-right` | | 같음 |
| 작업 중 | 에이전트 상태 | `loader-circle` | | `dot`(채움) |
| 끝남 | 에이전트 상태 | `circle-check` | | `check` |
| 기다림 | 에이전트 상태 | `hourglass` | ○ | `more-horizontal` |
| 쉼 | 에이전트 상태 | `circle-dashed` | | `circle` |
| 경고 | 트리 낡음·실행 맥락 경고 | `triangle-alert` | | 같음 |
| 새 파일 | 파일 트리 머리 | `file-plus` | ○ | 같음 |
| 새 폴더 | 파일 트리 머리 | `folder-plus` | ○ | 같음 |
| 폴더(경로 표시) | 설정 Claude 계정의 폴더 이름 앞 | `folder` | ○ | 같음 |
| 링크 표시 | 파일 트리 심볼릭 링크 | `link` | | 같음 |
| 복사 | 설정 프로필 지문 복사 | `copy` | ○ | 같음 |
| 테마 꾸미기 | 설정 「Customize Current Theme」 | `palette` | ○ | `pencil` |
| 기본값으로 되돌리기 | 설정 단축키 기본값 | `list-restart` | | `undo` |
| 삭제 | 프리셋·접근 허용·샌드박스 마운트 한 줄 지우기·채팅방 강제 삭제 | `trash-2` | ○ | `x`·`trash` |
| 채팅 탭(Chat) | 사이드바 탭 줄 | `messages-square` | ○ | `message-square` |
| 그룹 채팅방 | 채팅 목록 그룹 방 | `hash` | | `list` |
| 1:1 대화 | 채팅 목록 1:1 방·「1:1 대화 열기」 | `message-square` | ○ | 같음 |
| 채팅방 나가기 | 채팅방 메뉴 「나가기」 | `log-out` | | `x` |
| 참가자 내보내기 | 이름 우클릭 「내보내기」 | `user-minus` | | `minus` |

**FR-ICN-8** — 에이전트 상태 아이콘은 채움 없이 그린다(`ui-icon-fill` 을 붙이지 않는다). 상태 색은 지금 규칙(`.ag-state.<state>`)을 그대로 쓴다.

**FR-ICN-9** — 사용량 요약 줄의 펼침 아이콘은 닫힘 `chevron-right`, 열림 `chevron-down` 이다(펼침 / 접힘 뜻).

**FR-ICN-10** — 패널 접기 단추는 패널 쪽과 상태로 심볼을 고른다: 펼친 왼쪽 패널 `panel-left-close`, 접힌 왼쪽 레일 `panel-left-open`, 펼친 오른쪽 패널 `panel-right-close`, 접힌 오른쪽 레일 `panel-right-open`. 모바일 시트는 `x` 다(지금과 같다).

### 3.3 출처·고지

**FR-ICN-11** — 스프라이트 머리 주석이 출처를 적는다: Lucide(ISC, Copyright Lucide Icons and Contributors; 일부는 Feather MIT)와 직접 그린 넷(`git-repo`·`git-history`·`git-fetch`·`window-group`).

**FR-ICN-12** — Phosphor 의 경로는 쓰지 않는다. 시안 B 에서 고른 뜻은 Lucide 또는 직접 그린 선으로 그린다(고지 대상이 아니다).

### 3.4 시험

**FR-ICN-13** — 단위 시험 `web/js/test/icon-set.test.mjs` 가 FR-ICN-1~7 을 정적으로 확인한다: 심볼 속성, CSS 값, 뜻 표 ↔ 스프라이트(같은 집합·겹침 예외 하나·면 규칙), 쓰는 자리마다 표의 이름이 있는지, 코드의 아이콘 이름이 모두 스프라이트에 있는지.

## 4. 이전 동작 / 새 동작 / 이유

| 자리 | 이전 | 새 | 이유 |
|---|---|---|---|
| 모든 아이콘 | 선 2, 면 없음 | 선 2(D-ICN-25 로 2.25 에서 되돌림), 물체에 옅은 면 | D-ICN-3~5·25 |
| 위 표의 「이전」 열이 다른 자리 | 표의 이전 심볼 | 표의 새 심볼 | 겹침 해소·한눈에 이해(D-ICN-1·6, 이유는 `meanings.mjs` 의 `why`) |
| 작업 중 상태 | 채운 점 | 도는 고리 그림(움직이지 않는다) | 알림 점과 갈린다 |
| 사용량 요약 펼침 | 닫힘 `chevron-up` | 닫힘 `chevron-right` | 펼침 / 접힘 한 짝(FR-ICN-9) |
| 패널 접기 | 꺾쇠 | 패널 그림 | 꺾쇠는 「이전/다음」 으로 읽힌다(D-ICN-17) |
| 스프라이트에서 빠지는 심볼 | `clock`·`download`·`rotate-ccw`·`pencil`·`more-horizontal`·`chevron-up`·`box`·`git-stash`·`git-worktree`·`git-submodule`·`external-link`·`undo`·`circle`·`dot`·`columns`·`rows`·`trash`·`sliders`·`file`·`panel-left`·`terminal`·`terminal-bg` | — | 새 심볼로 옮겼거나 쓰는 곳이 없다 |

## 5. 검증 (Verification)

| TC | 대상 | 방법 |
|---|---|---|
| TC-ICN-1 | FR-ICN-1 | 단위: 스프라이트의 심볼마다 viewBox 24 이고 금지 속성이 없다 |
| TC-ICN-2 | FR-ICN-2·3 | 단위: `style-kit.css` 의 `.ui-icon`·`#ui-sprite .t`·`--ui-chev-right` 값 |
| TC-ICN-3 | FR-ICN-4 | 단위: 면 ○ 심볼은 `.t` 가 있고, 나머지는 없다 |
| TC-ICN-4 | FR-ICN-5·6 | 단위: 뜻 표의 심볼 집합 = 스프라이트 심볼 집합, 두 뜻에 속한 심볼은 `chevron-right` 뿐 |
| TC-ICN-5 | FR-ICN-7 | 단위: 쓰는 자리 파일마다 표의 심볼 이름이 있다 |
| TC-ICN-6 | FR-ICN-5 | 단위: 코드(`web/js` 시험 제외·`index.html`)의 아이콘 이름 자리(`icon:'…'`·`UIKit.icon('…'`·`iconHTML('…'`·`#i-…`·아이콘 상수)가 모두 스프라이트에 있다 |
| TC-ICN-7 | FR-ICN-8·9·10 | 단위: `agentStateIcon` 이 채움을 붙이지 않는다, `agCollapseIcon` 의 네 경우, 사용량 요약 아이콘 이름 |
| TC-ICN-8 | 화면 | 전후 스크린샷 비교(사이드바·Git 패널·Activity·설정·모바일)를 로컬 html 로 만들어 사용자에게 준다 |
| TC-ICN-9 | 회귀 | 아이콘을 단정하는 e2e(`ui-kit-icons`·`ui-polish`·`ux-batch13`·`ux-audit-fix`·`git-*` 등)를 묶음 끝에 한 번 |

## 6. 리스크

- MEDIUM — 동적으로 고르는 아이콘 이름(삼항·상수)을 놓치면 빈 아이콘이 된다. 완화: TC-ICN-6 의 패턴 스캔 + `UIKit.icon` 의 개발 경고 + e2e 전량
- LOW — 옅은 면이 일부 브라우저에서 `<use>` 복제본에 안 먹으면 면이 사라질 뿐 모양은 남는다(A-1). 구현 때 화면으로 확인한다
- LOW — 2.25 선이 13px 아이콘에서 조금 두꺼워 보일 수 있다. 화면 비교로 확인한다 → 실제로 복잡한 아이콘이 1배 화면에서 뭉개져 2 로 되돌렸다(D-ICN-25)

## 7. 비목표
- 아이콘 크기·버튼 치수·색 규칙 변경
- 회전·깜빡임 같은 움직임
- Phosphor 도입
