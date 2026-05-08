# SRS: 세션 전환 시 pane 스크롤 위치 보존 (IEEE 29148 준수)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
세션 전환 후 다시 돌아왔을 때 xterm 터미널 pane 의 스크롤백 viewport 위치가
최상단(가장 오래된 출력)으로 리셋되는 회귀를 식별하고 외과적으로 수정한다.
포커스 변경(같은 세션 내 region 이동) 동작은 영향 받지 않는다.

### 1.2 범위 (Scope)
- 프론트엔드(`web/app.js`)의 `Renderer._rLayout()` 와 `TermPane`(xterm) 경로.
- 신규 또는 변경되는 e2e 테스트.
- 비포함: 백엔드 변경, xterm 버퍼 스크롤백 길이/포맷 변경, 마크다운 뷰어
  로직(이미 `_scrollTop` 캡처/복원이 존재 — `MD_VIEWER_REGRESSION_FIX_SRS.md`
  REG-7 참조).

### 1.3 정의 (Definitions)
- **xterm viewport**: xterm.js 가 생성하는 `.xterm-viewport` 스크롤 컨테이너.
  실제 화면에 보이는 줄을 결정한다.
- **viewportY**: `term.buffer.active.viewportY`. 현재 viewport 의 최상단이
  버퍼의 몇 번째 라인인지를 가리키는 정수. xterm.js 의 내부 상태.
- **vis class**: `.tp.vis{display:block}` / `.md-viewer.vis{display:block}` 로
  활성/표시 여부를 토글하는 CSS 클래스.
- **세션 전환**: `App.switchSession()` → `App.render()` → `Renderer._rLayout()`
  를 통해 layout 트리 전체를 재구성하는 동작. 같은 세션 내 region focus 변경
  (`App.setFocus()`) 은 layout 을 재구성하지 않으며 본 SRS 의 회귀와 무관.

### 1.4 관련 문서
- `docs/internal/MD_VIEWER_REGRESSION_FIX_SRS.md` (REG-7: md viewer scrollTop 보존)
- `docs/internal/MD_SCROLL_SYNC_SRS.md` (md viewer 영속/동기화 정책)

## 2. 회귀 식별 (Identified Regression)

### REG-PSP-1: `_rLayout` 가 호출되는 모든 경로(세션 전환, 같은 region 내 탭 전환 등)에서 xterm 화면이 최상단으로 리셋
- **위치**: `web/app.js`
  - `Renderer._rLayout()` line 1064~1071 의 `for(const p of this.app.panes.values())` 루프
  - 동일 함수 line 1095~1138 의 `requestAnimationFrame` 콜백
- **현상**: 활성 터미널 pane 에서 스크롤백을 위로 올렸거나 단순히 최하단에서
  작업 중이라도, 세션 전환 또는 동일 region 안의 다른 탭으로 전환했다가
  돌아오면 xterm 화면 + 스크롤바가 모두 최상단(가장 오래된 출력)으로 튄다.
- **원인 (정정 — 2차 패치 후 재진단, xterm v5 소스 직접 확인)**:
  1. `_rLayout` 은 `vis` 를 제거하고 모든 pane 을 `area.appendChild(p.el)` 로
     재부착한다 → 짧은 순간 `display:none` + DOM 부모 변경이 동시에 발생.
  2. 브라우저는 detach·display:none 시 `.xterm-viewport.scrollTop` 를 0 으로
     리셋한다. xterm v5 `Viewport._handleScroll` 은 `!_viewportElement.offsetParent`
     이면 early return 하지만, 그 직전 `_lastScrollTop = scrollTop` 은 항상
     실행된다. 또한 scroll 이벤트가 element 가 다시 visible 된 후 fire 되는
     경우(브라우저별 비결정적) 에는 early return 이 우회되어 `ydisp` 까지
     0 으로 동기화된다.
  3. xterm v5 `Viewport._innerRefresh()` 끝부분은 `vp.scrollTop = ydisp * rowHeight`
     를 강제 세팅한다(권위 있는 sync). 그러나 이는 `syncScrollArea` 가 호출될
     때만 트리거되고, `syncScrollArea` 자동 트리거 조건(차원 변경, scrollback
     option 변경, `_onScroll` 발화 등)이 모두 충족되지 않으면 호출되지 않는다.
  4. xterm v5 `Terminal.resize(cols, rows)` 는 `cols/rows` 변화가 없으면
     `super.resize` 를 건너뛰고 `_afterResize` 도 발생하지 않는다. 따라서
     세션/탭 전환처럼 영역 크기가 동일한 상황에서 `doFit()` 호출은 no-op 이
     되어 `syncScrollArea` 가 트리거되지 않는다.
  5. xterm v5 `Terminal.scrollLines(0)`(또는 `scrollToLine(target)` 시 `target==ydisp`)
     도 early return 이라 `_onScroll` 을 발화시키지 않는다. 1차/2차 패치의
     `scrollLines(target - viewportY)` 는 `target == viewportY` 인 빈번한
     케이스에서 무력화되며 DOM scrollTop 도 보강이 필요한 상황이 남는다.
  6. 동일 클래스 결함이 같은 region 의 탭 전환(`switchTab` → `render` →
     `_rLayout`)에서도 발생한다. 탭 전환은 `setFocus` 와 달리 layout 을
     완전히 재구성하기 때문이다.
- **트리거**: `App.switchSession()`, `App.switchTab()`, `App.split()`,
  `App.closeTab()`, `App.delSession()`, 드래그 앤 드롭 — 즉 `App.render()`
  를 부르는 모든 경로.
- **이전 패치 이력**:
  - 1차(`viewportY` 캡처 + `scrollLines(delta)` 복원): 원인 #5 로 무력화.
  - 2차(`_scrollTop` + `_viewportY` 동시 캡처/복원): 원인 #3, #5 로 ydisp 가
    target 과 동일한 흔한 케이스에서 `_innerRefresh` 가 트리거되지 않아
    DOM 만 보강되고 화면 콘텐츠 일부 케이스에서 여전히 잘못 렌더링.

### REG-PSP-2 (관찰): 같은 클래스 결함이 md viewer 에도 잠재
- 현재 `_buildRg` 의 md 뷰어 부착 경로(line 1145~1149)는 `viewer._scrollTop`
  이 truthy 일 때만 복원한다. `0` 또는 `undefined` 는 무시되어 `_tryRestore()`
  로 떨어지며 영속 엔트리가 있으면 복원되고 없으면 0 으로 시작한다. 본 SRS
  에서는 정상 경로이므로 추가 조치 없음.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-1 | `_rLayout` 은 detach 직전(즉 `vis` 제거 직전) `vis` 인 모든 `TermPane` 에 대해 두 값을 캡처해야 한다. (a) `.xterm-viewport.scrollTop` 픽셀(`p._scrollTop`), (b) `term.buffer.active.viewportY` 라인(`p._viewportY`). 두 값은 detach 후 어느 쪽이 0 으로 끌려가는지 브라우저별로 비결정적이라 둘 다 필요하다. | 필수 |
| FR-2 | 후속 rAF 콜백은 다시 `vis` 가 부여된 `TermPane` 에 대해 `p.doFit()` 직후 xterm 의 `_onScroll` 이 **반드시** 발화되도록 ydisp 를 토글한다. 구체적으로 `target>0` 이면 `term.scrollToTop()` → `term.scrollToLine(target)` 시퀀스, `target==0` 이면서 buffer 가 충분히 길면 `scrollToBottom()` → `scrollToTop()` 시퀀스로 강제 발화. 이는 `_onScroll` → `syncScrollArea` → `_innerRefresh` 가 가동되어 xterm 이 권위 있게 `vp.scrollTop = ydisp * rowHeight` 를 세팅하도록 만든다. | 필수 |
| FR-3 | FR-2 와 동시에 안전망으로 `vp.scrollTop = p._scrollTop` 을 직접 세팅한다(가드 없이 무조건). xterm 의 `_innerRefresh` 가 어떤 이유로든 늦거나 누락되어도 스크롤바 위치는 보존된다. | 필수 |
| FR-4 | 복원은 `_viewportY` 가 현재 buffer 의 유효 범위(`0 <= y <= buffer.length - rows`) 를 벗어날 경우 가까운 값으로 클램프해야 한다. DOM scrollTop 은 브라우저가 `scrollHeight - clientHeight` 로 자동 클램프하므로 별도 수식 불필요. | 필수 |
| FR-5 | 같은 세션 내 region focus 이동(`App.setFocus`)은 layout 을 재구성하지 않으므로 본 변경의 영향 범위 밖이다. 동작이 그대로 유지되어야 한다(부수 효과 없음). | 필수 |
| FR-6 | 첫 페이지 로드 / pane `open()` 직후의 기본 동작인 `scrollToBottom()` 은 변경 없이 유지된다. 재연결(`_reconnecting`) 경로의 `scrollToBottom()` 도 그대로 유지한다. | 필수 |
| FR-7 | 마크다운 뷰어의 기존 `_scrollTop` 캡처/복원 로직(`MD_VIEWER_REGRESSION_FIX_SRS.md` REG-7)은 손대지 않는다. | 필수 |
| FR-8 | xterm 이 아직 `open()` 되지 않은 pane(`p._opened==false` 또는 `.xterm-viewport` 부재)은 캡처/복원을 모두 건너뛴다. 첫 표시는 기본 `scrollToBottom()` 동작에 맡긴다. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)
- NFR-1: 변경은 외과적이어야 하며 비-xterm 경로(md viewer, 사이드바, 모바일
  drawer 등)의 동작을 바꾸지 않는다.
- NFR-2: 추가 코드는 `xterm.js` 공식 API(`term.buffer.active.viewportY`,
  `term.scrollLines`) 만 사용한다. DOM `scrollTop` 직접 조작 금지.
- NFR-3: `go test ./...` 통과(백엔드 변경 없음 — 회귀 없음 확인).
- NFR-4: 추가되는 Playwright e2e 는 회귀 재발 시 실패해야 한다.
- NFR-5: 캡처/복원으로 인한 추가 비용은 세션 전환당 O(visible panes) 이며
  실수치는 ~수 µs 수준이어야 한다(필드 대입 + 함수 1회).

### 3.3 제약 (Constraints)
- 데이터 모델/`workspace.json` 스키마 변경 금지.
- 새 의존성 추가 금지.
- xterm.js 버전 업그레이드 금지.
- `_viewportY` 는 휘발성(인메모리)이며 영속화하지 않는다(스크롤백은 본래
  세션 메모리이므로 새로고침 시 재현되지 않아도 무방).

## 4. 설계 개요 (Design)

### 4.1 자료 구조
- `TermPane._viewportY?: number` — detach 직전 xterm 내부 viewport 라인.
- `TermPane._scrollTop?: number` — detach 직전 `.xterm-viewport.scrollTop` 픽셀.
  둘 다 휘발성. 값 없음 = 미캡처(첫 렌더 등).

### 4.2 변경 지점
1. `Renderer._rLayout()` 캡처 루프
   ```js
   for(const p of this.app.panes.values()){
     if(p.el.classList.contains('vis')){
       const vp = p.el.querySelector('.xterm-viewport');
       if(vp) p._scrollTop = vp.scrollTop;
       if(p.term){ try{ p._viewportY = p.term.buffer.active.viewportY }catch{} }
     }
     p.el.classList.remove('vis');
     area.appendChild(p.el);
   }
   ```
2. `Renderer._rLayout()` rAF 콜백 복원 단계 (3차)
   ```js
   requestAnimationFrame(()=>{
     for(const p of this.app.panes.values()){
       if(p.el.classList.contains('vis')){
         if(!p._opened) p.open();
         p.doFit();
         // (a) ydisp 토글로 xterm 의 _onScroll 을 강제 발화시켜
         //     syncScrollArea → _innerRefresh 를 트리거. _innerRefresh 가
         //     scrollTop = ydisp * rowHeight 을 권위 있게 sync.
         if(p.term && typeof p._viewportY === 'number'){
           try{
             const buf = p.term.buffer.active;
             const max = Math.max(0, buf.length - p.term.rows);
             const target = Math.min(Math.max(0, p._viewportY), max);
             if(target > 0){
               p.term.scrollToTop();        // ydisp -> 0 (force fire)
               p.term.scrollToLine(target); // ydisp -> target (force fire)
             }else if(max > 0){
               p.term.scrollToBottom();
               p.term.scrollToTop();
             }else{
               p.term.scrollToTop();
             }
           }catch{}
         }
         // (b) 안전망: DOM scrollTop 직접 세팅(가드 없음).
         if(typeof p._scrollTop === 'number'){
           const vp = p.el.querySelector('.xterm-viewport');
           if(vp){ try{ vp.scrollTop = p._scrollTop }catch{} }
         }
       }
     }
     // ... 기존 focus 복원 로직 ...
   });
   ```

### 4.3 동작 시나리오
- A 에서 작업 중(viewportY=250, scrollTop≈3750px) → B 로 전환 →
  A 의 pane 은 `vis` 제거 직전 두 값 모두 캡처. → A 복귀 → rAF 에서
  `vis` 재부여 + `doFit` 후 (a) 내부 viewport 복원, (b) DOM scrollTop 보강.
  결과: 화면 + 스크롤바가 캡처 시점과 동일.
- 같은 region 의 다른 탭으로 전환 후 복귀 → 동일 시퀀스가 적용된다(둘 다
  `_rLayout` 경유). 1차 패치에서 빠졌던 케이스가 본 패치로 커버된다.
- A 의 pane 이 한 번도 열린 적 없는 경우(`p._opened==false`,
  `.xterm-viewport` 부재) → 캡처/복원 모두 스킵. `open()` + 첫
  `scrollToBottom()` 정상 흐름 유지.

### 4.4 장애/엣지 케이스
- buffer 가 줄어들어 `_viewportY` 가 `max` 초과 → 클램프(FR-3).
- 사용자 doFit 으로 cols 변경 → reflow 가 발생할 수 있으나 `viewportY` 는
  라인 단위라 근사적으로 동일 위치로 복원. 정확 픽셀 복원은 비목표.
- xterm 미연결(`_opened=false`) pane → 캡처/복원 모두 스킵.

## 5. 검증 계획 (Validation)

### 5.1 단위/통합 (Go)
- 본 변경은 프론트엔드 한정 → `go test ./...` 로 회귀 없음만 확인.

### 5.2 e2e (Playwright)
- `e2e/regression-pane-scroll.spec.ts` 신규:
  1. 세션 1개 추가하여 총 2개 세션 보유.
  2. 첫 세션 터미널에 충분한 출력 생성 후(`for i in $(seq 1 200); do echo $i; done`)
     `term.scrollLines(-100)` 로 위로 100 라인 스크롤.
  3. `term.buffer.active.viewportY` 캡처(=before).
  4. 두 번째 세션으로 전환 → 다시 첫 세션으로 전환.
  5. 첫 세션 터미널의 `viewportY` 가 `before` 와 동일함을 단언
     (오차 허용 ±2 라인 — doFit reflow 보정).

### 5.3 수동 체크리스트
- [ ] 단일 세션, 동일 region 내 탭 전환 시 스크롤 보존(기존 동작 유지).
- [ ] split layout 에서 region focus 이동 시 스크롤 변동 없음.
- [ ] 세션 전환 후 viewportY 동일.
- [ ] 모바일 모드에서 mPaneIdx 변경 시 동일하게 동작.

## 6. 완료 조건 (Definition of Done)
- [ ] 본 SRS 문서 commit.
- [ ] `web/app.js` 외과적 패치 적용(FR-1 ~ FR-3).
- [ ] e2e 회귀 스펙 추가, 패치 전 실패·패치 후 통과(작성됨; 실행은 사용자).
- [ ] `go test ./...` 통과.
- [ ] 사용자 confirm 후 commit.
