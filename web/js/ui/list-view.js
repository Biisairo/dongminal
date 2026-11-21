/**
 * ListView — 목록의 기반 (REFACTOR3_FE_LIST_SRS FR-FEL-1·2). 사이드바 목록(`SidebarList`)과 Git 목록 탭(`GitListTab`)이
 * 이것의 하위다.
 *
 * `reconcileList` 위의 일을 한 벌로 둔다 — 행의 정체(`key`)·서명(`sig`)·만들기(`buildRow`)와 키보드 배선. 서명은 행이
 * 읽는 값 전부여야 하고(FR-RPT-2), 필드 사이에는 값에 나타나지 않는 구분자(`RPT_SEP`)를 둔다 — 그냥 이어 붙이면
 * 서로 다른 행이 같은 서명을 내고, 그 행은 바뀌어도 다시 그려지지 않는다.
 *
 * 행 만들기는 `build()`(View 의 루트 만들기)와 이름이 다르다(D-FEL-2).
 */
class ListView extends View {
  key(item){ return item.key }

  sigParts(item){ return [this.key(item)] }

  sig(item){ return this.sigParts(item).join(RPT_SEP) }

  buildRow(_item){ return document.createElement('div') }

  /** 바뀌지 않은 행은 그대로 두고 그린다(FR-RPT-1·3). 그린 행 수를 돌려준다. */
  reconcile(box,items){
    return reconcileList(box,items,{
      key:i=>this.key(i),
      sig:i=>this.sig(i),
      build:i=>this.buildRow(i),
    });
  }

  /** 키보드 계약(`UIKit.roving`)을 상자마다 한 번 건다 — 행에 걸면 다시 만들 때 함께 사라진다. */
  bindKeys(box,spec){
    if(box._kbNav) return;
    box._kbNav=true;
    this.own(UIKit.roving(box,spec));
  }
}
