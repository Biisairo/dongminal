# SRS: md 뷰어 도입 이후 회귀 수정 (IEEE 29148 준수)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
커밋 `1974efd` 이후 머지된 일련의 변경(`b4674d1 md viewer 추가`, `1aa0142 중복 탭 방지`, `83d4a5f focus bug fix`, `b54cef2 test`)으로 인해 발생한 탭/포커스 회귀를 식별하고, 최소 변경으로 정상 동작을 복원한다.

### 1.2 범위 (Scope)
- 프론트엔드(`web/app.js`)의 렌더링·포커스·탭 관리 경로
- 회귀 동작에 대한 e2e 테스트 추가
- 백엔드 API(`/api/md-file`)는 정상 동작 → 변경 없음

### 1.3 정의 (Definitions)
- **활성 세션(active session)**: `ws.activeSession` 가 가리키는 세션
- **포커스 영역(focused region)**: `app.focused` 가 가리키는 region id
- **`s.focusedRegion`**: 세션별로 마지막으로 포커스되었던 region id (세션 전환 후 복원에 사용)
- **MdViewer 캐시**: `app.mdViewers` Map. tab id → MdViewer 인스턴스

## 2. 회귀 식별 (Identified Regressions)

### REG-1: 비활성 세션의 MdViewer 인스턴스가 매 렌더마다 파기됨
- **위치**: `web/app.js` `App.render()` 의 정리 루프
- **현상**: `allTabIds` 가 활성 세션의 layout만 순회하여, 다른 세션의 markdown 탭 id 가 누락된다. `mdViewers` 전체를 순회하며 `allTabIds.has(tid)` 가 거짓이면 `destroy()` + 캐시 삭제 → 비활성 세션의 모든 md 뷰어가 사라진다.
- **영향**: 세션 전환마다 md 파일을 재요청, 스크롤 위치 손실, 짧은 빈화면 깜빡임.
- **이전 동작(1974efd 시점)**: MdViewer 자체가 없었음 → 회귀 없음. 새 기능 도입 시 발생한 결함.

### REG-2: `switchTab` 이 `s.focusedRegion` 을 동기화하지 않음
- **위치**: `web/app.js` `App.switchTab(rid, tid)`
- **현상**: `this.focused = rid` 만 갱신하고 `s.focusedRegion` 은 그대로 둔다. 이후 다른 세션으로 이동했다가 돌아오면 `s.focusedRegion` 의 옛 값으로 포커스가 복원된다.
- **트리거**: 다중 region 레이아웃에서 클릭으로 region 간 이동(탭 클릭 포함) → 세션 전환 → 복귀.
- **분류**: 포커스 영속성(focused-region persistence) 결함. `83d4a5f` 가 `paneUp/Down/Left/Right` 만 부분 수정한 동일 문제.

### REG-4: `split()` 이 `s.focusedRegion` 을 갱신하지 않음
- **위치**: `web/app.js` `App.split()`
- **현상**: `!keepFocus` 경로에서 `this.focused=lastR` 로 새 region 을 포커스하지만 `s.focusedRegion` 은 여전히 분할 전 `tgtRegionId` 를 가리킨다. `keepFocus=true` 경로도 동일하게 `s.focusedRegion` 미동기화. 결과적으로 세션 전환 후 복귀 시 포커스가 분할 이전 region 으로 돌아간다.
- **분류**: REG-2/3 와 같은 `focusedRegion` 동기화 누락 클래스.

### REG-3: `closeTab` 의 활성 세션 분기에서 `s.focusedRegion` 동기화 누락
- **위치**: `web/app.js` `App.closeTab(rid, tid, sid)` 의 `if(isActive)` 분기 (region 이 비어 제거되는 경로)
- **현상**: `this.focused` 는 새 fallback 으로 갱신되지만 `s.focusedRegion` 은 제거된 rid 를 그대로 참조. 세션 전환 후 복귀 시 fallback 으로 떨어진다.
- **분류**: REG-2 와 같은 클래스의 동기화 누락.

### REG-5: `delSession` 이 대상 세션의 `focusedRegion` 을 무조건 첫 region 으로 리셋
- **위치**: `web/app.js` `App.delSession(sid)`
- **현상**: 활성 세션 삭제 시 `this.focused = firstRg(a.layout)?.id` 로 강제 덮어쓰기. 다른 세션이 가지고 있던 `focusedRegion` 정보를 사용하지 않으며 `a.focusedRegion` 을 동기화하지도 않는다.
- **영향**: 활성 세션을 닫고 자동으로 옮겨간 세션의 마지막 포커스가 잊혀짐 → 분할 레이아웃에서 사용자 경험 저하.
- **분류**: REG-2 와 같은 동기화 누락 + 잘못된 폴백 선택.

### REG-8: `closeTab` 활성 탭 닫기 시 첫 탭으로 폴백
- **위치**: `web/app.js` `App.closeTab(rid, tid, sid)` 의 `else { if(rg.activeTab===tid) rg.activeTab=rg.tabs[0].id }` 경로
- **현상**: 활성 탭을 닫으면 `rg.tabs[0]` 즉 가장 앞 탭으로 이동. 사용자 직관(근접 탭)과 다름.
- **기대 동작**: 닫히는 탭의 원래 인덱스 기준 다음 탭(없으면 이전 탭)으로 이동.
- **참고**: 세션 삭제는 `Math.min(i, len-1)` 로 근접 세션 선택 ✓, region 제거는 `closestRg` 로 근접 region 선택 ✓ — 탭만 누락.

### REG-7: `render()` 가 MdViewer 의 `scrollTop` 을 매번 리셋
- **위치**: `web/app.js` `App._rLayout()` 의 `this.mdViewers` 순회와 `_buildRg` 의 viewer 부착 경로
- **현상**: `_rLayout` 이 모든 mdViewer 에서 `.vis` 클래스를 제거하여 `display:none` 으로 전환한다. CSS `.md-viewer{overflow-y:auto;display:none}` + `.md-viewer.vis{display:block}` 조합 때문에 `display:none` 이 되는 순간 브라우저가 스크롤 위치를 잃는다. 이후 `.vis` 가 다시 부여되어도 `scrollTop=0` 으로 복귀.
- **트리거**: `switchTab`, `split`, `closeTab`, `addTab`, 세션 전환, 드래그 앤 드롭 등 `render()` 를 유발하는 모든 동작.
- **영향**: 마크다운 탭에서 스크롤 후 다른 동작을 하고 돌아오면 맨 위로 튐.

### REG-6: `render()` 의 stale focused 보정/모바일 분기에서 `s.focusedRegion` 미동기화
- **위치**: `web/app.js` `App.render()` 의 `if(!findRg(...)) this.focused=firstRg(...)` 와 모바일 `target` 보정 경로
- **현상**: `this.focused` 가 layout 에 없을 때 fallback 으로 재설정하면서 `s.focusedRegion` 은 갱신하지 않음. 모바일 분기에서 `_mPaneIdx` 기반으로 focused 를 재선택할 때도 동일.
- **영향**: 세션 전환 후 복귀 시 stale 한 `s.focusedRegion` 이 다시 적용되어 포커스가 튐.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-1 | `App.render()` 의 MdViewer GC 는 모든 세션의 layout 에 존재하는 tab id 를 보존해야 한다. | 필수 |
| FR-2 | `App.switchTab(rid, tid)` 는 `this.focused` 와 함께 `s.focusedRegion` 을 `rid` 로 갱신해야 한다. | 필수 |
| FR-3 | `App.closeTab` 가 활성 세션의 region 을 제거할 때, 갱신되는 `this.focused` 와 동일한 값으로 `s.focusedRegion` 을 갱신해야 한다. | 필수 |
| FR-4 | `App.split()` 완료 후 `this.focused` 와 `s.focusedRegion` 이 반드시 동일한 값을 가져야 한다 (`!keepFocus` → 새 region, `keepFocus` → 원래 region). | 필수 |
| FR-7 | `App.delSession()` 이 활성 세션을 삭제할 때, 새 활성 세션의 저장된 `focusedRegion` 이 layout 에 존재하면 그것을 사용하고, 없으면 첫 region 으로 폴백하며 `a.focusedRegion` 도 함께 갱신해야 한다. | 필수 |
| FR-8 | `App.render()` 가 stale `this.focused` 를 보정하거나 모바일 분기에서 `target` 을 선택할 때, `s.focusedRegion` 도 동일하게 갱신해야 한다. | 필수 |
| FR-9 | `App.render()` 가 마크다운 뷰어의 `scrollTop` 을 보존해야 한다. 활성 상태로 다시 부착될 때 직전 스크롤 위치를 복원해야 한다. | 필수 |
| FR-10 | `App.closeTab()` 이 활성 탭을 닫을 때, 닫힌 탭의 원래 인덱스를 기준으로 다음 탭(없으면 이전 탭)을 활성화해야 한다. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)
- NFR-1: 변경은 외과적(surgical)이어야 하며, md 미사용 경로의 동작을 바꾸지 않는다.
- NFR-2: 기존 Go 단위 테스트 전부 통과(`go test ./...`).
- NFR-3: 추가되는 Playwright e2e 테스트는 회귀 재발 시 실패한다.

### 3.3 제약 (Constraints)
- 데이터 모델(`tab.type`, `tab.filePath`)은 변경하지 않는다.
- `MULTI_TAB_TYPE_SPEC.md` 의 동작 계약을 깨뜨리지 않는다.

## 4. 검증 계획 (Validation)

### 4.1 단위/통합 테스트
- `e2e/regression-md.spec.ts`:
  1. 두 세션에 각각 md 탭을 열고, 세션을 전환했다가 돌아왔을 때 동일 MdViewer 인스턴스가 유지되는지 확인 (FR-1).
  2. 세션 내 두 region 중 두 번째 region 클릭 → 세션 전환 → 복귀 시 두 번째 region 이 포커스되어야 함 (FR-2).
  3. 두 region 중 활성 region 의 마지막 탭을 닫음 → 세션 전환 → 복귀 시 stale region 이 아닌 fallback region 이 포커스되어야 함 (FR-3).

### 4.2 수동 확인 (Test Checklist)
- 터미널 탭 추가/포커스/단축키 입력이 1974efd 동작과 동일한지 회귀 체크리스트(`docs/test-checklist.md`)로 확인.

## 5. 완료 조건 (Definition of Done)
- [ ] 위 4건의 코드 수정 적용 (REG-1~4)
- [ ] e2e 회귀 스펙 추가 — 수정 전 실패, 수정 후 통과(작성됨; 사용자가 실행)
- [ ] `go test ./...` 통과
- [ ] 본 SRS 문서 commit
