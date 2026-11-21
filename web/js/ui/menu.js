/**
 * Menu — 드롭다운·컨텍스트 메뉴 (UI_KIT_SRS FR-UIK-26 · CONTEXT_MENU_UNIFY_SRS · REFACTOR3_FE_ESC_SRS FR-FEE-3).
 * `UIKit.menu`·`UIKit.closeMenu` 가 이것에 맡긴다 — 두 이름과 `UIKit._menu` 는 기존 호출처를 위한 입구로 남는다.
 *
 * `GitMenu` 가 갖던 것이 여기로 왔다 (FR-CMU-1~4): ↑↓ 이동(비활성 건너뜀, 끝에서 감김) · Enter 실행 · Home/End ·
 * 비활성의 **사유가 `title`** · `cur` · `role=menu`/`menuitem`. 닫힘은 `Esc`·바깥 `mousedown`·스크롤·리사이즈.
 * 한 번에 하나만 열린다(`Menu._cur`). 활성 항목이 포커스를 갖고(D-CMU-2) 닫으면 연 자리로 돌아간다.
 *
 * Esc 는 `EscapeStack` 캡처 층 항목이다 — 항목은 메뉴 자신이다. 화살표·Enter·바깥 누름·스크롤·크기 바꾸기는
 * 메뉴 자신의 리스너가 한다(D-FEE-4).
 *
 * items: {id, label, icon, key, onClick, disabled:boolean|string, danger, cur, title}
 *        — `key` 는 단축키 동작 이름이다. 바인딩이 있으면 끝에 키캡이 선다 (UX_AUDIT_FIX_SRS FR-UXF-84)
 *        | {sep:true} | {el:<HTMLElement>} | {label, static:true}
 * opts:  {at, align, cls, itemCls, sepCls, flipGap} — `itemCls`·`sepCls` 는 옛
 *        이름을 함께 붙이는 자리다 (D-5, `GitMenu` 의 `.git-menu-item`).
 */
// OPTIMIZE_REFACTOR_SRS FR-OPT-12-6 (FEU-19): 메뉴는 창 안쪽 4px 에 머문다.
const UIK_MENU_EDGE_PX = 4;

class Menu extends View {
  static _cur=null;

  static open(items,opts){
    Menu.close();
    const m=new Menu(items,opts);
    Menu._cur=m;
    m.mount(document.body);
    m._wire();
    return m;
  }

  static close(){
    const m=Menu._cur;
    if(!m) return;
    Menu._cur=null;
    EscapeStack.remove(m);
    const hadFocus=m.el.contains(document.activeElement);
    m.dispose();
    // D-CMU-2: 키로 옮겨 온 포커스는 연 자리로 돌려준다.
    const r=m.returnTo;
    if(hadFocus&&r&&r.isConnected&&typeof r.focus==='function') r.focus();
  }

  constructor(items,opts){
    super();
    this.items=items||[];
    this.opts=opts||{};
    this.returnTo=document.activeElement;
  }

  /** EscapeStack 항목의 닫기. 이미 다른 메뉴가 떴으면 아무것도 하지 않는다. */
  close(){ if(Menu._cur===this) Menu.close() }

  build(){
    const o=this.opts;
    const m=document.createElement('div');
    // MOBILE_UX_OVERHAUL_SRS FR-MUX-53: 모바일 메뉴는 화면을 넘으면 스스로 구른다 — 그 표면의 스크롤바는 킷의 것이다.
    m.className='ui-menu ui-scroll-sm'+(o.cls?' '+o.cls:'');
    m.setAttribute('role','menu');
    for(const it of this.items){
      if(!it) continue;
      if(it.sep){
        const d=document.createElement('div');
        d.className=['ui-menu-sep',o.sepCls||''].filter(Boolean).join(' ');
        d.setAttribute('role','separator');
        m.appendChild(d); continue;
      }
      if(it.el){ m.appendChild(it.el); continue }
      if(it.label!=null&&it.static){
        const d=document.createElement('div'); d.className='ui-menu-label'; d.textContent=it.label; m.appendChild(d); continue;
      }
      m.appendChild(this._item(it));
    }
    return m;
  }

  _item(it){
    const o=this.opts;
    // FR-CMU-1: 문자열 disabled 는 사유다 — 색만으로는 사용자가 고장으로 읽는다.
    const why=typeof it.disabled==='string'?it.disabled:'';
    const off=!!it.disabled;
    const d=document.createElement('div');
    d.className=['ui-menu-item',o.itemCls||'',off?'disabled':'',it.danger?'danger':'',it.cur?'cur':''].filter(Boolean).join(' ');
    d.setAttribute('role','menuitem');
    d.tabIndex=-1;
    if(it.id!=null) d.dataset.id=it.id;
    if(it.icon) d.appendChild(UIKit.icon(it.icon,{size:'sm'}));
    const l=document.createElement('span');
    l.textContent=it.label||'';
    d.appendChild(l);
    const combo=it.key&&typeof shortcuts==='object'?shortcuts[it.key]:'';
    if(combo){
      const k=document.createElement('span');
      k.className='ui-menu-key';
      k.textContent=displayKey(combo);
      d.appendChild(k);
    }
    if(why) d.title=why; else if(it.title) d.title=it.title;
    if(off) d.setAttribute('aria-disabled','true');
    if(!off&&it.onClick) d.addEventListener('click',()=>{ Menu.close(); it.onClick() });
    return d;
  }

  /** 자리는 붙인 뒤에 잡는다 — 크기를 알아야 화면 밖으로 나가지 않게 밀 수 있다. */
  render(){
    const o=this.opts, m=this.el;
    const at=o.at||{x:0,y:0};
    const r=m.getBoundingClientRect();
    let x=at.x, y=at.y;
    if(o.align==='right') x=at.x-r.width;
    const edge=UIK_MENU_EDGE_PX;
    if(x+r.width>innerWidth-edge) x=innerWidth-r.width-edge;
    if(y+r.height>innerHeight-edge) y=Math.max(edge,at.y-r.height-(o.flipGap||0));
    m.style.left=Math.max(edge,x)+'px';
    m.style.top=Math.max(edge,y)+'px';
  }

  _wire(){
    const m=this.el;
    /**
     * FR-CMU-2: 키 이동. 활성 가능한 항목만 돌고, 처음에는 아무것도 활성이
     * 아니다 — 첫 ↓ 가 첫 항목이다 (`GitMenu` N2 의 계약 그대로).
     */
    const live=()=>[...m.querySelectorAll('.ui-menu-item:not(.disabled)')];
    const mark=el=>{
      for(const x of m.querySelectorAll('.ui-menu-item')) x.classList.toggle('active',x===el);
      if(el) el.focus();
    };
    const off=e=>{
      if(e.type==='mousedown'){ if(!m.contains(e.target)) Menu.close(); return }
      if(e.type!=='keydown'){ Menu.close(); return }
      const list=live(); if(!list.length) return;
      const cur=list.indexOf(m.querySelector('.ui-menu-item.active'));
      if(e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='Home'||e.key==='End'){
        e.preventDefault(); e.stopPropagation();
        const next=e.key==='Home'?0:e.key==='End'?list.length-1
          :e.key==='ArrowDown'?(cur+1)%list.length:(cur<=0?list.length-1:cur-1);
        mark(list[next]); return;
      }
      if(e.key==='Enter'||e.key===' '){
        const el=list[cur]; if(!el) return;
        e.preventDefault(); e.stopPropagation();
        el.click();
      }
    };
    this.listen(window,'scroll',off,true);   // FR-CMU-3
    this.listen(window,'resize',off,true);
    this.listen(document,'keydown',off,true);
    /**
     * `Esc` 는 **즉시** 넣고(FR-FEE-3), 바깥 `mousedown` 만 다음 태스크로 미룬다.
     *
     * 미루는 이유는 하나뿐이다 — 이 메뉴를 연 그 클릭의 `mousedown` 이 아직
     * 전파 중이면 메뉴가 뜨자마자 자기 자신을 닫는다. 그 사유는 키에는 없다:
     * `Esc` 로 메뉴를 여는 길이 없으므로 방금의 키가 이 메뉴를 닫을 수 없다.
     *
     * 둘을 함께 미뤘더니 **메뉴가 뜬 뒤 한 태스크 동안 `Esc` 가 죽어 있었다.**
     * 그 사이의 `Esc` 는 아무 일도 하지 않고, 한 번 놓친 키는 다시 오지 않으므로
     * 메뉴가 열린 채로 남는다 — e2e 가 그 창을 실제로 맞았고(H14 · F9), 빠르게
     * 누르는 사용자도 같은 창을 맞는다.
     */
    EscapeStack.push(this);
    this._hub().defer(()=>{ this.listen(document,'mousedown',off,true) },{owner:this,label:'ui-menu-open'});
  }
}
