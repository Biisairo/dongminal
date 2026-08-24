# MDScroll Leak Fix SRS

> IEEE 29148 형식. mdscroll.json 에 닫힌 markdown 탭의 스크롤 엔트리가
> 영구 누적되는 문제를 정정한다.

## 1. Problem
`mdscroll.Manager` 는 `Reconcile`/`Delete` 메서드를 노출하지만 어디서도
호출되지 않는다. 결과적으로:
- 사용자가 markdown viewer 탭을 닫아도 해당 `tabId` 의 entry 가 남는다.
- mdscroll.json 파일 크기 단조 증가.
- 죽은 tab id 가 다시 (확률적으로) 발급될 경우 잘못된 스크롤 위치 복원.

## 2. Cause
- `internal/workspace/manager.go` 의 `Save` 가 인덱스를 갱신할 때 satellite
  store(mdscroll) 에 알릴 hook 이 없음.
- 부팅 시에도 동기화가 일어나지 않음.

## 3. Solution
### 3.1 workspace.Manager
- `index` 에 `tabIDs map[string]struct{}` 추가, `buildIndex` 가 모든 탭의 id
  를 채움.
- `TabIDs() map[string]struct{}` 공개 메서드 추가 (복사본 반환).
- `OnIndexUpdate func()` 콜백 필드 추가. `Save` 가 `idx.Store` 직후 동기 호출.

### 3.2 main.go wiring
- `mdscroll.Manager` 생성 직후
  ```go
  wsMgr.OnIndexUpdate = func() { msMgr.Reconcile(wsMgr.TabIDs()) }
  msMgr.Reconcile(wsMgr.TabIDs())   // initial load 후 1회
  ```
- 부팅 시 prune 갯수가 0보다 크면 로그.

## 4. Non-Goals
- 탭 close 시 즉시 fine-grained delete: workspace 변경은 latest-wins 로 통째
  Save 되므로 인덱스 갱신마다 reconcile 만으로 충분 (set diff = O(N tabs)).
- workspace 와 mdscroll 의 트랜잭셔널 일관성 보장: 두 파일은 별개 도메인이며
  reconcile 은 "최종적으로 수렴" 정책을 따른다.

## 5. Verification
- `internal/workspace/manager_tabids_test.go`
  - `TestTabIDsAfterSave`: Save 이후 TabIDs 가 모든 tab.id 포함.
  - `TestOnIndexUpdateFiresOnSave`: hook 정확히 1회 호출.
- `internal/mdscroll/manager_test.go::TestReconcile` (기존) — 로직 자체.
- 수동 검증: 탭 추가 후 PUT /api/md-scroll → 탭 삭제 후 부팅 →
  mdscroll.json 에 해당 tabId 사라짐 + 로그 `pruned N stale tab(s) at startup`.

## 6. Backward Compatibility
- 외부 API 무변화. 기존 mdscroll.json 의 stale entry 는 다음 워크스페이스
  Save 또는 다음 부팅 시 자동 정리.
