/**
 * ScrollMemo — 키별 스크롤 자리 (REFACTOR3_FE_BASE_SRS FR-FEB-14 · FE_OBJECT_MODEL 계열 10).
 *
 * `rootOf(key)` 가 그 키의 루트 요소를 준다. 값은 요소에 적는 기존 규약(`UIKit.scrollSave/Restore`,
 * FR-SBT-11)을 그대로 쓴다 — 루트 안에 스크롤 컨테이너가 몇 개인지 부르는 쪽이 알 필요가 없다.
 */
class ScrollMemo {
  constructor(rootOf){ this._rootOf=rootOf }

  save(key){ UIKit.scrollSave(this._rootOf(key)) }

  restore(key){ UIKit.scrollRestore(this._rootOf(key)) }
}
