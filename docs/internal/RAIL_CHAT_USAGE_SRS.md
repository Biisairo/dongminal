# SRS: 레일의 채팅 목록과 Claude 사용량 (IEEE 29148 준수)

> **문서 상태**: 승인·구현완료
>
> 근거: `e2e/rail-chat-usage.spec.ts` TC-RCU-1·2 와 `ui-layout-defaults`·`claude-accounts`·`chat-window`·`activity-rail`·`sidebar-tabs`·`ux-batch13`·`panel-dock` e2e 통과, `npm run unit`(`css-structure`·`activity-tabs`)·`make gates` 통과. 규칙은 `web/style-main-panel.css`(`#sidebar[data-rail] .chat-*`)와 `web/style-activity.css`(`#agents-panel[data-rail] .act-usage-*`)다

## 1. 개요

### 1.1 목적
1. (수정) 메인 패널(사이드바)을 레일로 접고 `채팅` 탭을 고르면 목록이 제대로 보이지 않는다 — 구역 제목·빈 안내가 한 글자씩 세로로 꺾이고 온라인 이름이 잘린다(2026-11-22 화면 확인).
2. (추가) Activity 패널을 레일로 접어도 Claude 사용량이 작게 보인다. 지금은 레일이 사용량 바닥을 통째로 감춘다.

### 1.2 범위
- 포함: `#sidebar[data-rail]` 의 채팅 목록 규칙, `#agents-panel[data-rail]` 의 사용량 바닥 규칙, 죽은 레일 규칙 정리, 시험
- 비포함: 펼친 패널의 모양, 채팅·사용량의 데이터·동작, 모바일(레일이 없다)

### 1.3 현황 (조사)
- 채팅은 `CHAT_WINDOW_SRS`(D-7)로 Activity 에서 메인 패널로 옮겨졌다. 그런데 레일 규칙은 `#agents-panel[data-rail]` 에만 남았다(`style-activity.css` 의 `.chat-row`·`.chat-row-name`·`.chat-row-sub`·`.chat-act`·`.chat-sub-h`·`.chat-none`·`.chat-node`·`.chat-person`·`.chat-down`) — 그 자리에는 채팅이 없어 죽은 규칙이다. `#sidebar[data-rail]` 에는 채팅 규칙이 하나도 없다
- 창·저장소 목록의 레일 규칙은 `style-main-panel.css` 의 `#sidebar[data-rail] .sbl-*` 다(FR-RAL-2: 이름 두 줄 줄임, 빈 안내 감춤)
- 사용량 바닥은 `#agents-panel[data-rail]` 숨김 목록의 `.act-usage-foot` 로 감춰진다. 바닥의 첫 줄은 요약 줄 `.act-usage-sum`(색 점·이름·세션/주간 칸 `.cacct-cell` — `title` 에 자세한 값)이다(FR-UXF-73)

### 1.4 설계 결정 (위임받아 정한 것)

| # | 결정 | 이유 |
|---|---|---|
| D-RCU-1 | 채팅 레일은 창 목록 레일과 같은 말씨다: 방 행은 아이콘 + 두 줄 줄인 이름(FR-RAL-2 와 같은 글자 크기 `--sb-rail-fs`), 구역 제목·빈 안내·부가 줄·행 동작 단추는 감춘다. 온라인 사람도 두 줄 줄인 이름이고, 노드 머리와 「닿지 않음」 표시는 감춘다 | 한 레일 안에서 두 말씨를 쓰지 않는다. 전체 이름은 `title` 이 말한다 |
| D-RCU-2 | 사용량 레일은 **요약 줄만** 세로로 작게: 색 점 · 세션 % · 주간 % 와 얇은 막대. 이름·칸 이름·남은 시간·요약 꺾쇠는 감춘다. 펼쳐 둔 상태여도 레일에서는 요약만 보인다. 자세한 값은 칸의 `title` 이 말한다 | 40px 폭에 들어가는 최소 정보 — 「지금 얼마나 썼나」 |
| D-RCU-3 | `#agents-panel[data-rail]` 의 죽은 채팅 규칙은 지운다 | 그 자리에 채팅이 없다 |

## 2. 요구사항

- **FR-RCU-1** — `#sidebar[data-rail]` 에서 채팅 탭의 보이는 글자 요소는 레일 폭을 넘지 않고, 한 글자씩 세로로 꺾이는 요소가 없다: 구역 제목(`.chat-sub-h`)·빈 안내(`.chat-none`)·부가 줄(`.chat-row-sub`)·행 동작(`.chat-act`)·노드 머리(`.chat-node`)·`.chat-down` 은 감춘다.
- **FR-RCU-2** — 레일의 방 행(`.chat-row`)과 사람 행(`.chat-person`)은 이름을 두 줄까지 보이고 넘치면 `…` 다(FR-RAL-2 와 같은 규칙). 행 아이콘은 가운데 선다.
- **FR-RCU-3** — `#agents-panel[data-rail]` 에서 사용량 바닥이 보인다. 보이는 것은 요약 줄 하나이고, 세션·주간 칸의 % 와 막대가 세로로 쌓인다. 레일 폭을 넘지 않는다. 계정 머리·계정 줄·statusLine 줄은 레일에서 감춘다.
- **FR-RCU-4** — 펼친 패널의 채팅·사용량 모양은 바뀌지 않는다(레이아웃 기준선 V-LAY-1 유지).
- **FR-RCU-5** — `#agents-panel[data-rail]` 의 채팅 규칙을 지운다.

## 3. 검증

| TC | 대상 | 방법 |
|---|---|---|
| TC-RCU-1 | FR-RCU-1·2 | e2e: 사이드바를 레일로 접고 채팅 탭 — 보이는 채팅 요소의 폭 ≤ 레일 폭, 감춘 요소가 보이지 않음, 방·사람 이름 높이가 두 줄 이하 |
| TC-RCU-2 | FR-RCU-3 | e2e: 계정 사용량을 모의(`claude-accounts.spec` 의 방식)로 채우고 Activity 를 레일로 — `.act-usage-sum` 이 보이고 % 글자가 있으며 폭 ≤ 레일 폭, 계정 줄은 보이지 않음 |
| TC-RCU-3 | FR-RCU-4·5 | `ui-layout-defaults`·`claude-accounts`·`chat-window`·`activity-rail`·`css-structure` 시험 통과 |
