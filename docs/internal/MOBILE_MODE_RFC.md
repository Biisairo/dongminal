# Mobile Mode RFC — dongminal Web UI

> 데스크톱 전용으로 설계된 dongminal 웹 UI(`web/index.html`, `web/app.js`, `web/style.css`)에 모바일 모드를 추가한다. 본 문서는 `grill-me` 인터뷰를 통해 도출된 모든 설계 결정을 한 곳에 모아 구현자가 독립 실행 가능하도록 작성되었다.
>
> 작업 대상 리포: `/Users/dykim/personal/dongminal`
> 작성일: 2026-04-27
> 작성 도구: grill-me 인터뷰 결과 정리

---

## 0. 진행 원칙

- 데스크톱 코드 경로는 **무손상**. 모바일 분기는 명시적인 분기점에서만 발생한다.
- 단일 코드베이스, 단일 진입점(`/`). 별도 `/m` 또는 `mobile.html` 만들지 않는다.
- 상태 모델(`session → split tree → region(=pane) → tab`)은 **유지**. 모바일은 같은 모델을 다른 표현 레이어로 렌더한다.
- 용어: 코드 내 기존 명칭 그대로 — `pane`(탭 묶음 단위), `tab`(개별 터미널). 별도 명칭(`region`) 도입하지 않는다.
- 분할 관련 UI는 모바일에서 **완전 제거**. 새 분할 생성, 리사이즈, 분할 단축키 모두 비활성. 데스크톱에서 만들어진 분할은 **순회만** 가능.
- `go build ./... && go vet ./... && go test ./...` 통과 필수. (서버 측 변경은 최소; 주로 `web/`만 손댐)

---

## 1. 사용 시나리오 (Scope)

### 1.1 채택: 보조 컨트롤러 (Light Control)

모바일 사용자는 다음을 수행한다:

- 데스크톱에서 돌고 있는 에이전트/빌드/세션을 **모니터링**
- 현재 보고 있는 pane에 **새 탭 생성**
- 사이드바 드로어를 통해 **새 세션 생성**
- 모든 열린 pane들을 **순회하며 사용**
- 가상 키보드 + 보조 키바로 **터미널 입력**

### 1.2 비채택

- (A) 모니터링 전용 (read-mostly): 입력이 1급이 아니면 도구가 답답해짐 → 거부
- (C) 풀 모바일 IDE (full parity): 작은 화면에서 split UI는 본질적으로 어색, ROI 음수 → 거부

### 1.3 명시적 비지원 기능

| 기능 | 모바일에서 |
|---|---|
| 새 분할(split) 생성 | ✕ 차단 |
| 분할 리사이즈 | ✕ 핸들 자체 숨김 |
| 분할 단축키 (Ctrl+Shift+H/V) | ✕ 비활성 |
| 탭을 region drop-zone에 끌어 분할 | ✕ 드롭존 미렌더 |
| 사이드바 드래그 리사이즈 | ✕ (드로어 폭 고정) |

---

## 2. 모드 결정 로직

### 2.1 설정 항목 (Settings에 추가)

| 키 | 타입 | 기본값 | 저장 위치 | 설명 |
|---|---|---|---|---|
| `displayMode` | `'auto' \| 'mobile' \| 'desktop'` | `'auto'` | **sessionStorage (탭별)** | 모드 강제. `'auto'`면 뷰포트 너비로 자동 판정 |
| `mobileBreakpoint` | `number` (px) | `768` | **sessionStorage (탭별)** | `'auto'` 모드에서 모바일 판정 기준 너비 |

두 값 모두 기존 ⚙ Settings 모달에 항목 추가하여 노출. **워크스페이스 동기화 대상 아님** + **탭/창 단위 격리**. 같은 브라우저의 다른 탭에서도 별도 설정 가능. 탭 닫으면 휘발 — 새 탭은 항상 `'auto'` / `768`로 시작. `'auto'`는 viewport 너비 기반이라 빈 상태에서도 자연 동작.

### 2.2 결정식

```js
get isMobile() {
  if (this.displayMode === 'mobile') return true;
  if (this.displayMode === 'desktop') return false;
  return window.innerWidth < this.mobileBreakpoint; // 'auto'
}
```

### 2.3 동적 전환

- `window.addEventListener('resize', ...)` 에서 `isMobile` 변화 감지 → `render()` 재호출.
- 새로고침 불필요. xterm 인스턴스는 재사용(detach/re-append), WebSocket 끊지 않음.
- 모드 전환 시 포커스/스크롤 위치는 xterm 기본 동작에 맡김.

---

## 3. 레이아웃 (모바일)

### 3.1 화면 구조

```
┌─────────────────────────────────────────┐
│ session-A   ‹ 2/3 ›       🔍  +  ☰      │  ← Topbar (32px)
├─────────────────────────────────────────┤
│ [build] [server] [logs]                 │  ← Tab bar (28px)
├─────────────────────────────────────────┤
│                                         │
│         xterm terminal                  │  ← 풀 fill
│         (현재 pane의 활성 탭)             │
│                                         │
├─────────────────────────────────────────┤
│ [Esc][Tab][Ctrl][Alt][↑][↓][←][→][|]... │  ← 보조 키바 (키보드 위 sticky, 키보드 시에만)
├─────────────────────────────────────────┤
│        Virtual Keyboard                 │
└─────────────────────────────────────────┘
```

### 3.2 Topbar (32px) 상세

좌→우 배치:

1. **세션명** (현재 활성 session). 탭하면 드로어 열림(보조 발견성).
2. **Pane 인디케이터** `‹` `N/M` `›` — 단일 pane(`1/1`)이어도 **항상 표시** (사용자에게 현재 위치 명시).
3. **🔍 검색** — 누르면 기존 검색 바 슬라이드 다운(데스크톱과 동일 컴포넌트 재사용).
4. **+ 새 탭** — 현재 보고 있는 pane에 새 탭 추가. "어디에 만들지" 묻지 않음.
5. **☰ 햄버거** (우상단) — 드로어 토글. 드로어 열려있으면 **✕** 로 변경.

세션 추가는 topbar에 두지 않음 — **드로어 안 `+ New session` 버튼만**.

### 3.3 Pane 순회

- 순서: split 트리 **in-order 순회** 결과(좌→우, 위→아래). 결정론적이라 데스크톱에서 레이아웃 변경 시에도 일관됨.
- pane 번호는 코드의 기존 pane 인덱스를 그대로 사용.
- `‹` / `›` 버튼이 유일한 전환 수단. **스와이프 미사용** (TUI 앱의 마우스 모드와 충돌 회피).
- 휘발성 상태 `App._mPaneIdx`로 현재 pane 추적. 디바이스별 (localStorage 저장 안 함).
- **Focus 동기화**: 모바일 ‹ ›로 pane 이동 시 `s.focusedRegion`을 갱신하고 `_save()` 호출. 즉 데스크톱 `setFocus`와 동일 정책 — 다중 브라우저(예: 데스크톱 + 모바일 동시 사용) 시 모바일에서 만지는 pane이 데스크톱 화면의 focused border에도 반영됨.

### 3.4 사이드바 → 우측 슬라이드 드로어

| 항목 | 값 |
|---|---|
| 폭 | `min(80vw, 320px)` |
| 슬라이드 방향 | 우측 → 좌측 (`transform: translateX(100%)` ↔ `0`) |
| 애니메이션 | 200ms ease |
| 백드롭 | 반투명 검은 오버레이, opacity 페이드 |
| 트리거 | 우상단 ☰ 탭 |
| 닫기 | (a) ✕ 탭, (b) 백드롭 탭, (c) 세션 항목 선택 시 자동 |

**드로어 내용** (현재 사이드바 DOM 그대로 이식):

```
┌──────────────────────────────┐
│                          ✕   │
│ Sessions                     │
│ ● session-A                  │
│ ○ session-B                  │
│ ○ session-C                  │
│                              │
│ [+ New session]              │
│ [★ Preset]                   │
│                              │
│ ──────────────────────────   │
│ ⚙ Settings                   │
└──────────────────────────────┘
```

기존 사이드바 컨테이너 DOM을 재활용하고, CSS만 다르게 적용(`position: fixed; transform`). 드래그 리사이즈 핸들은 모바일에서 숨김.

---

## 4. 키보드 / 입력 UX

### 4.1 보조 키바

**위치**: 가상 키보드 **바로 위**에 sticky. 가상 키보드가 등장(visualViewport 변화)할 때만 표시, 사라지면 함께 사라짐.

**키 구성** (한 줄, 가로 스크롤):

```
[Esc] [Tab] [Ctrl] [Alt] [↑] [↓] [←] [→] [|] [~] [/] [-] [Home] [End] [PgUp] [PgDn]
```

**Modifier 동작 (Ctrl, Alt)**:

- 단일 탭: sticky 1회 — 다음 일반 키 입력 시 결합 후 자동 해제.
- 더블 탭: lock — 명시적으로 다시 누를 때까지 유지.
- 시각적 하이라이트(눌림 / lock 상태 색 구분).

**클립보드**: 별도 버튼 없음. 모바일 브라우저 기본 동작(길게 누르기 → 선택/복사/붙여넣기 메뉴) + xterm selection 지원에 위임.

### 4.2 가상 키보드 대응 (visualViewport API)

```js
window.visualViewport.addEventListener('resize', () => {
  const kbHeight = window.innerHeight - window.visualViewport.height;
  const keyBarHeight = mobileKeyBar.offsetHeight;
  termContainer.style.bottom = (kbHeight + keyBarHeight) + 'px';
  mobileKeyBar.style.bottom = kbHeight + 'px';
  fitAddon.fit(); // xterm 재계산 → cols/rows 서버에 OP.RESIZE
});
```

- 키보드 등장으로 줄어든 visible viewport에 맞춰 xterm 컨테이너를 축소.
- 키바는 `kbHeight` 위치에 sticky → 키보드 바로 위.
- 키바 사라질 때(`kbHeight === 0`) 키바 컴포넌트도 hide.

### 4.3 포커스 보존

xterm은 자체 hidden textarea로 입력 받음. 보조 키바 버튼 탭이 textarea 포커스를 빼앗으면 키보드가 사라짐 → 키바도 사라짐. 막아야 함.

```js
keyBarButton.addEventListener('mousedown', e => e.preventDefault());
keyBarButton.addEventListener('touchstart', e => e.preventDefault());
keyBarButton.addEventListener('click', () => {
  // xterm textarea로 키 이벤트 dispatch
});
```

---

## 5. 코드 분기 전략

### 5.1 3-tier 분기

| Layer | 도구 | 다루는 것 |
|---|---|---|
| 1. CSS | `@media` 쿼리 | 시각/레이아웃 (드로어 transform, 핸들 숨김, 폰트, 터치 타겟 크기) |
| 2. JS 플래그 | `App.isMobile` getter | 단일 진실 원천. 리사이즈에서 갱신. |
| 3. JS 분기 | `render()` 안의 if | `_buildNode(layout)` (데스크톱 split 트리) vs `_buildMobileShell(layout)` (단일 pane 렌더) |

### 5.2 신규 / 변경 항목

**신규 함수 / 모듈**

- `App._buildMobileShell(sessionLayout)` — split 트리를 in-order로 평탄화하여 `panes[]` 배열을 만들고, `currentMobilePaneIdx`에 해당하는 pane 하나만 DOM에 부착.
- `App._mountMobileTopbar()` — 세션명 / 화살표 / 인디케이터 / 🔍 / + / ☰ 렌더 및 핸들러.
- `App._mountDrawer()` — 기존 사이드바 DOM을 드로어 컨테이너에 마운트, 백드롭 / ✕ 핸들러.
- `MobileKeyBar` — visualViewport 추적, sticky modifier 상태, xterm dispatch.

**신규 상태**

- 휘발성: `App.currentMobilePaneIdx` (number, 기본 0)
- 휘발성: `App.drawerOpen` (boolean, 기본 false)
- 탭별 (sessionStorage): `App.displayMode`, `App.mobileBreakpoint` (워크스페이스 동기화 대상 아님, 탭 닫으면 휘발)

**변경**

- `App.render()` — `isMobile` 분기 추가
- `App` getter/setter로 `displayMode`/`mobileBreakpoint` sessionStorage 노출 (워크스페이스에는 저장 안 함)
- ⚙ Settings 모달 — 두 항목 폼 추가
- `style.css` — `@media (max-width: ...)` 블록 추가 (브레이크포인트는 CSS 변수 `--mobile-bp` 통해 JS와 동기화 필요)

> **CSS 변수 동기화 주의**: `mobileBreakpoint`가 사용자 설정이므로 CSS `@media` 정적 값과 일치시키기 어려움. 해결책: CSS는 기본 768px로 고정 작성하되 **시각적 분기는 `body.mobile` 클래스로** 통제. JS `isMobile` 변화 시 `document.body.classList.toggle('mobile', isMobile)`. CSS는 `body.mobile .sidebar { transform: ... }` 식으로 클래스 기반 셀렉터 사용. → CSS `@media`는 보조용(터치 디바이스 폰트 크기 등)으로만 쓰고, 핵심 분기는 클래스 기반.

### 5.3 데스크톱 무손상 보장

- 모바일 함수들은 모두 신규 함수 (`_buildMobileShell` 등). 기존 `_buildNode` / `_buildRg` / `_buildSp`는 그대로 두고 분기점에서만 호출 갈림.
- 기존 키보드 단축키, 드래그 리사이즈, 분할 핸들러는 손대지 않음. `body.mobile`이 아닐 때 그대로 동작.
- 영속화 스키마 변경: 두 키 추가만, 기존 키 변경 / 삭제 없음.

---

## 6. 구현 순서

```
M1. App.isMobile + Settings 두 항목 + body.mobile 토글
M2. _buildMobileShell + topbar + pane 순회 (분할 무시 단일 pane 렌더)
M3. 사이드바 → 드로어 변환 (CSS + 토글 핸들러)
M4. 보조 키바 (visualViewport, sticky modifier)
M5. 검색 / 새 탭 / 새 세션 모바일 동선 정리
M6. 모바일 실기기 + Chrome DevTools 모바일 에뮬레이션 검증
```

각 단계 완료 시 `go build ./... && go vet ./... && go test ./...` + 데스크톱 회귀 확인 (브레이크포인트 위로 창 키우면 기존 동작 그대로).

---

## 7. 검증 체크리스트

### 7.1 데스크톱 회귀

- [ ] 사이드바 드래그 리사이즈 동작
- [ ] 분할 생성 / 리사이즈 동작
- [ ] 모든 단축키 동작
- [ ] 탭 드래그 분할 드롭존 동작
- [ ] 워크스페이스 영속화 (기존 세션 / 분할 보존)

### 7.2 모바일 신규

- [ ] 뷰포트 < 768px에서 자동으로 모바일 모드 진입
- [ ] Settings에서 `displayMode = 'mobile'/'desktop'` 강제 동작
- [ ] Settings에서 `mobileBreakpoint` 변경 시 즉시 반영
- [ ] 창 리사이즈로 모드 자동 전환 시 xterm 출력 / 입력 끊김 없음
- [ ] 분할 2개 이상인 세션을 모바일에서 ‹ › 로 순회
- [ ] 새 탭 + 누르면 현재 pane에만 추가
- [ ] 드로어 열기 / 닫기 (✕, 백드롭, 항목 선택)
- [ ] 새 세션 드로어 안에서 생성
- [ ] 가상 키보드 등장 시 보조 키바가 키보드 바로 위
- [ ] 가상 키보드 사라질 때 키바도 사라짐
- [ ] Ctrl + C, Ctrl + D 등 sticky modifier 조합 동작
- [ ] 보조 키바 버튼 누를 때 키보드 사라지지 않음 (focus 보존)
- [ ] 모바일에서 분할 핸들 / 분할 단축키 모두 비노출 / 비동작
- [ ] 단일 pane 세션에서도 `1/1` 인디케이터 표시
- [ ] 길게 누르기로 텍스트 선택 / 붙여넣기 동작 (브라우저 기본)

### 7.3 안전성

- [ ] visualViewport 미지원 브라우저 (구형 Android WebView)에서 fallback (보조 키바 미표시 / 단순 fixed 위치)
- [ ] sessionStorage 빈 상태에서 기본값(`auto` / `768`) 적용 (새 탭 / 시크릿 창)
- [ ] 다중 브라우저 동기화: A 브라우저에서 모바일 ‹ ›로 pane 이동 → B 브라우저(데스크톱)의 focused border가 따라감
- [ ] 탭별 격리: 같은 브라우저의 탭 1에서 displayMode='mobile' 강제해도 탭 2는 영향 없음
- [ ] 탭 닫고 새로 열면 `'auto'`로 리셋

---

## 8. 미확정 / 후속 항목 (Out of Scope)

본 RFC는 **합의된 결정만** 포함한다. 다음은 1차 구현 이후 사용자 피드백 받아 결정:

- 보조 키바에 `Ctrl+C`, `Ctrl+D`, `Ctrl+Z` 단발 단축 버튼 추가 여부
- 보조 키바 키 구성 사용자 커스터마이즈
- 모바일 전용 제스처 (예: 두 손가락 스와이프로 pane 전환)
- 모바일에서 분할 단축키를 새 탭 단축키로 매핑할지
- iPad 등 큰 터치 디바이스에서 데스크톱 모드 + 터치 핸들 두께 확장

---

## 9. 결정 이력 (grill-me 인터뷰 요약)

| Q | 채택 | 비채택 |
|---|---|---|
| 사용 시나리오 | B (보조 컨트롤러) | A (모니터링 전용), C (풀 IDE) |
| Pane 표현 | (a) 보존 — 별도 공간으로 순회 | (b) flatten 단일 탭바, (c) 사이드바 트리 |
| 명칭 | 기존 `pane` 명칭 유지 | `region` 신규 도입 |
| Pane 전환 | 화살표 버튼만 | 스와이프 (TUI 마우스 모드 충돌) |
| 인디케이터 | topbar 통합 `‹ N/M ›`, 항상 표시 | 하단 닷, 탭바 통합, 단일 pane 시 숨김 |
| 햄버거 위치 | 우상단 | 좌상단 |
| 드로어 방향 | 우 → 좌 슬라이드 | 좌 → 우 |
| 진입점 | 단일 (`/`) | 별도 (`/m`) |
| 분기 기준 | 뷰포트 너비 | User-Agent |
| 모드 강제 | Settings로 사용자 override 가능 | auto only |
| 모드 전환 | 동적 (resize 시 즉시) | 새로고침 강제 |
| 보조 키바 | (c) 특수키 한 줄 + sticky modifier | (b) modifier만, (d) 외부 키보드 가정 |
| 키바 위치 | 키보드 바로 위 sticky (visualViewport) | 화면 최하단 고정 |
| 클립보드 | 브라우저 기본 동작 위임 | 키바에 별도 버튼 |
