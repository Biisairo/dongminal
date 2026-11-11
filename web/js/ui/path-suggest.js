/**
 * UI_POLISH_SRS FR-UIP-21: 경로 입력의 후보 목록.
 *
 * 후보를 **어디서 얻는가**는 부르는 쪽이 정한다(`source`) — 이 모듈은 목록을 보이고
 * 키를 받는 일만 한다. 서버의 파일 접근 경계는 `source` 가 지킨다.
 *
 *   ↑ ↓   후보를 옮긴다
 *   Tab   고른 후보(없으면 첫 후보)를 입력에 채운다
 *   Esc   목록만 닫는다 — 다이얼로그는 그대로다
 *   Enter 손대지 않는다 — 다이얼로그의 실행이다
 */
class PathSuggest{
  constructor(input,source){
    this.input=input; this.source=source;
    this.items=[]; this.sel=-1; this._gen=0;
    const el=this.el=document.createElement('div');
    el.className='path-suggest ui-scroll-sm'; el.setAttribute('role','listbox'); el.hidden=true;
    input.setAttribute('autocomplete','off');
    input.insertAdjacentElement('afterend',el);
    input.addEventListener('input',()=>this.refresh());
    input.addEventListener('focus',()=>this.refresh());
    input.addEventListener('blur',()=>{this.el.hidden=true});
    input.addEventListener('keydown',ev=>this._key(ev));
    // 누르는 동안 입력이 포커스를 잃으면 blur 가 목록을 먼저 닫는다.
    el.addEventListener('mousedown',ev=>ev.preventDefault());
  }

  async refresh(){
    const gen=++this._gen;
    const list=await this.source(this.input.value);
    if(gen!==this._gen) return;
    const v=this.input.value;
    this.items=list.filter(p=>p&&p!==v);
    this.sel=-1;
    this._paint();
  }

  _paint(){
    const el=this.el;
    el.textContent='';
    this.items.forEach((p,i)=>{
      const it=document.createElement('div');
      it.className='path-suggest-item'+(i===this.sel?' active':'');
      it.setAttribute('role','option'); it.setAttribute('aria-selected',String(i===this.sel));
      it.textContent=p;
      it.addEventListener('click',()=>this._fill(p));
      el.appendChild(it);
    });
    el.hidden=!this.items.length||document.activeElement!==this.input;
  }

  _fill(p){
    this.input.value=p;
    this.input.dispatchEvent(new Event('input',{bubbles:true}));
    this.input.focus();
  }

  _key(ev){
    if(this.el.hidden||!this.items.length) return;
    const n=this.items.length;
    if(ev.key==='ArrowDown'||ev.key==='ArrowUp'){
      ev.preventDefault();
      this.sel=ev.key==='ArrowDown'?(this.sel+1)%n:(this.sel<=0?n-1:this.sel-1);
      this._paint();
    }else if(ev.key==='Tab'&&!ev.shiftKey){
      ev.preventDefault();
      this._fill(this.items[Math.max(0,this.sel)]);
    }else if(ev.key==='Escape'){
      ev.preventDefault(); ev.stopPropagation();
      this.el.hidden=true;
    }
  }
}
