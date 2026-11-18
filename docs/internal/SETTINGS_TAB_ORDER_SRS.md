# SRS: 설정 탭의 순서와 묶음 — IEEE 29148

> **문서 상태**: 승인·구현완료

## 1. 개요

### 1.1 목적

사용자 요구 (2026-11-18):

> *"지금 setting 의 탭들 순서 좀 정돈할 필요가 있겠어."*

설정 창의 탭 17개는 더해진 순서대로 놓여 있어 성격이 섞여 있다. 비슷한 탭을 묶고, 데스크톱 세로
목록에서 묶음 이름을 보인다. 사용자는 "성격별 묶음 + 구분선" 안을 골랐다.

### 1.2 범위

- `web/index.html` — 탭 순서, 묶음 이름 요소, 처음 열리는 탭.
- `web/style.css` — 묶음 이름의 표시.
- `web/js/core/app-settings.js` — 검색 중 묶음 이름 숨김, 처음 열 때 Profile 읽기.
- `web/js/i18n/{ko,en}.js` — 묶음 이름.

비포함: 탭 이름, 패널 내용, 모바일의 가로 탭 줄 배치.

## 2. 요구사항

- **FR-STO-1** 탭 순서와 묶음은 다음과 같다.

  | 묶음 | 탭 |
  |---|---|
  | (없음) | Profile |
  | 보기 / View | Display · Theme · Status Bar · Presets |
  | 작업 / Work | Terminal · Code · Shortcuts |
  | 알림·갱신 / Alerts & refresh | Notifications · Telegram · Polling |
  | 연결·보안 / Connection & security | Server · Access · Edges |
  | 에이전트 / Agents | Claude · Sandbox |
  | 관리 / Manage | Backup |

- **FR-STO-2** 설정 창을 처음 열면 Profile 탭이 선택돼 있고, 그 값을 서버에서 읽어 그린다. 다시 열 때는
  지금처럼 마지막에 본 탭이 남는다. Profile 이 선택된 채로 열면 다시 읽는다.
- **FR-STO-3** 묶음 이름은 데스크톱 세로 목록에서만 보인다. 모바일·좁은 창의 가로 줄에서는 보이지 않는다.
- **FR-STO-4** 검색창에 낱말이 있으면 묶음 이름을 숨긴다. 비우면 다시 보인다.
- **FR-STO-5** 묶음 이름은 접근성 트리에 들어가지 않는다(`aria-hidden`). tablist 의 자식은 tab 뿐이어야 한다.
  키보드 이동은 탭만 지난다.

## 3. 동작 변경

| 항목 | 이전 | 이후 | 이유 |
|---|---|---|---|
| 처음 열리는 탭 | Theme | Profile | 맨 위 탭이 처음 보이는 규약을 유지한다 |
| 탭 순서 | 더해진 순서 | FR-STO-1 | 성격별로 찾는다 |

## 4. 검증

- e2e: 처음 열면 Profile 이 선택되고 이름 칸이 채워진다. 묶음 이름 6개가 보이고, 검색하면 숨는다. 탭 순서가
  FR-STO-1 과 같다. 기존 접근성 검사(axe·tablist·키보드)가 통과한다.
- 설정을 열고 곧바로 Theme 를 쓰던 e2e 는 Theme 탭을 먼저 고른다.
