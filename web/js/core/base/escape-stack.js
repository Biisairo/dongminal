/**
 * EscapeStack — Esc 로 닫히는 것의 등록부 (REFACTOR3_FE_BASE_SRS FR-FEB-13 · FE_OBJECT_MODEL 계열 11).
 *
 * Esc 하나에 맨 위 항목 하나의 `close()` 만 부른다. 항목은 `{close()}` 모양이고 나중에 넣은 것이 위다.
 * 같은 항목을 다시 넣으면 맨 위로 올라간다. 문서 리스너는 처음 넣을 때 한 번 건다 — 넣은 것이 없으면
 * 아무 일도 하지 않는다. 기존 Esc 처리기는 아직 여기를 지나지 않는다(FC-14 는 단계 6).
 */
class EscapeStack {
  static _items=[];
  static _wired=false;

  static push(entry){
    EscapeStack.remove(entry);
    EscapeStack._items.push(entry);
    if(EscapeStack._wired) return;
    EscapeStack._wired=true;
    document.addEventListener('keydown',e=>EscapeStack.handle(e));
  }

  static remove(entry){
    const i=EscapeStack._items.indexOf(entry);
    if(i>=0) EscapeStack._items.splice(i,1);
  }

  /** Esc 이고 항목이 있으면 맨 위 것을 빼고 닫는다. 처리했으면 참이다. */
  static handle(e){
    if(e.key!=='Escape') return false;
    const top=EscapeStack._items.pop();
    if(!top) return false;
    e.preventDefault();
    top.close();
    return true;
  }
}
