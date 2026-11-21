/**
 * EscapeStack — Esc 로 닫히는 것의 등록부 (REFACTOR3_FE_BASE_SRS FR-FEB-13 · REFACTOR3_FE_ESC_SRS FR-FEE-1·2).
 *
 * 항목은 `{close(), phase?, active?(), propagate?}` 모양이고 나중에 넣은 것이 위다. 같은 항목을 다시 넣으면
 * 맨 위로 올라간다. 순서는 **연 순서**다 — 리스너를 붙인 순서에 기대지 않는다(D-FEE-2).
 *
 * 층이 둘이다(D-FEE-1). 처음 넣을 때 문서에 캡처·버블 리스너를 하나씩 걸고, 각 층은 살아 있는 맨 위 항목이
 * **자기 층일 때만** 처리한다. 캡처 층(`'capture'`, 기본)은 포커스 요소보다 먼저 받는다 — 터미널이 전파를
 * 끊어도 닫힌다. 버블 층은 포커스 요소가 Esc 를 먼저 쓰게 두고, 이미 쓴(`defaultPrevented`) Esc 는 다시
 * 쓰지 않는다(D-FEE-5).
 *
 *   active()   거짓이면 없는 것으로 보고 건너뛴다(D-FEE-3). 걷어 내지는 않는다 — 데스크톱에서 건너뛴 작업 패널이
 *              모바일 폭이 되면 다시 Esc 로 닫혀야 한다. 빼는 것은 항목의 주인이다. 없으면 살아 있다
 *   propagate  참이면 닫고도 전파를 끊지 않는다
 */
class EscapeStack {
  static _items=[];
  static _wired=false;

  static push(entry){
    EscapeStack.remove(entry);
    EscapeStack._items.push(entry);
    if(EscapeStack._wired) return;
    EscapeStack._wired=true;
    document.addEventListener('keydown',e=>EscapeStack.handle(e,'capture'),true);
    document.addEventListener('keydown',e=>EscapeStack.handle(e,'bubble'));
  }

  static remove(entry){
    const i=EscapeStack._items.indexOf(entry);
    if(i>=0) EscapeStack._items.splice(i,1);
  }

  /** 살아 있는 맨 위 항목. 죽은 것은 건너뛴다. */
  static top(){
    const it=EscapeStack._items;
    for(let i=it.length-1;i>=0;i--) if(!it[i].active||it[i].active()) return it[i];
    return null;
  }

  /** `phase` 층의 Esc 다. 맨 위가 이 층이면 빼고 닫는다. 처리했으면 참이다. */
  static handle(e,phase){
    if(e.key!=='Escape') return false;
    const ph=phase||'capture';
    if(ph==='bubble'&&e.defaultPrevented) return false;
    const top=EscapeStack.top();
    if(!top||(top.phase||'capture')!==ph) return false;
    EscapeStack.remove(top);
    e.preventDefault();
    if(!top.propagate) e.stopPropagation();
    top.close();
    return true;
  }
}
