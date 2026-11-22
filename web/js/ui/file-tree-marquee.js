/**
 * FileTree — 빈 여백의 사각형 선택 (UX_BATCH12 FR-EXM-1·2).
 *
 * 행에서 시작한 끌기는 파일 옮기기다(FR-EXM-2) — 여기서는 행이 아닌 자리만 받는다.
 * 상자는 `this.el` 에 붙인다. 목록(`this.list`)의 자식은 `reconcileList` 가 다룬다.
 * 좌표는 **목록 내용 좌표**(스크롤 포함)로 들어, 자동 스크롤 중에도 시작점이 내용에 붙어 있다.
 *
 * 부품 `FileTreeMarquee`(탐색기의 `marquee`) 이다 (REFACTOR3_FE_REST5_SRS FR-FR5-31 — 옛 `Object.assign(FileTree.prototype, …)`). 상태는 종전대로
 * 탐색기 인스턴스에 있고 이 부품은 그것을 `this.tree` 로 읽고 쓴다. 탐색기의 이름은 전부 `this.tree.X` 로 부른다 — 시험·e2e 가
 * 인스턴스에 갈아 끼운 것을 부품도 본다. 파일 끝의 위임자 표가 이 부품의 이름을 `FileTree` 원형에 둔다.
 */
class FileTreeMarquee {
  constructor(tree){
    this.tree=tree;
  }

  _initMarquee(){
    this.tree.list.addEventListener('mousedown',e=>this.tree._mqDown(e));
  }

  _mqDown(e){
    if(e.button!==0||e.target.closest('.ed-row,button,input')) return;
    // 글자 선택이 시작되지 않게 막는다. 막으면 포커스도 오지 않으므로 직접 준다 (FR-EXR-50).
    e.preventDefault();
    this.tree.list.focus({preventScroll:true});
    const add=e.metaKey||e.ctrlKey||e.shiftKey;
    const m={x0:e.clientX,y0:e.clientY,from:this.tree._mqY(e.clientY),x:e.clientX,y:e.clientY,on:false,
      base:add?[...this.tree._selSet]:[],anchor:add?this.tree._sel:'',box:null,tick:null};
    const move=ev=>{m.x=ev.clientX;m.y=ev.clientY;this.tree._mqMove(m)};
    const up=()=>{
      document.removeEventListener('mousemove',move);
      document.removeEventListener('mouseup',up);
      TIMERS.cancel(m.tick);
      if(!m.on) return;
      m.on=false;
      m.box.remove();
      // 놓은 자리의 클릭이 빈 여백 클릭(루트 선택)으로 읽히지 않게 한 번 삼킨다.
      // 클릭이 오지 않는 경우(목록 밖에서 놓음)를 위해 다음 차례에 거둔다.
      this.tree._mqEat=true;
      TIMERS.defer(()=>{this.tree._mqEat=false},{label:'ed-marquee-eat'});
    };
    document.addEventListener('mousemove',move);
    document.addEventListener('mouseup',up);
  }

  _mqY(clientY){ return clientY-this.tree.list.getBoundingClientRect().top+this.tree.list.scrollTop }

  _mqMove(m){
    if(!m.on){
      if(Math.hypot(m.x-m.x0,m.y-m.y0)<EDITOR_MARQUEE_MIN_PX) return;
      m.on=true;
      if(this.tree._edit) this.tree.cancelEdit();
      this.tree._clearErr();
      m.box=document.createElement('div');
      m.box.className='ed-marquee';
      this.tree.el.appendChild(m.box);
    }
    this.tree._mqPaint(m);
    this.tree._mqScroll(m);
  }

  // 상자를 그리고 세로로 겹친 행을 고른다. 앵커는 포인터 쪽 끝의 행이다.
  _mqPaint(m){
    const lr=this.tree.list.getBoundingClientRect(),er=this.tree.el.getBoundingClientRect();
    const to=this.tree._mqY(m.y),lo=Math.min(m.from,to),hi=Math.max(m.from,to);
    const off=lr.top-er.top-this.tree.list.scrollTop;
    const top=Math.max(lo+off,lr.top-er.top),bot=Math.min(hi+off,lr.bottom-er.top);
    const xl=Math.min(m.x0,m.x)-er.left,xr=Math.max(m.x0,m.x)-er.left;
    Object.assign(m.box.style,{left:xl+'px',top:top+'px',width:(xr-xl)+'px',height:Math.max(0,bot-top)+'px'});
    const hits=[];
    for(const r of this.tree.list.querySelectorAll('.ed-row[data-path]:not(.ed-edit)')){
      const b=r.getBoundingClientRect(),y=b.top-lr.top+this.tree.list.scrollTop;
      if(y<hi&&y+b.height>lo&&r.dataset.path!==this.tree.root) hits.push(r.dataset.path);
    }
    if(to<m.from) hits.reverse();
    this.tree._selMarquee(m.base,hits,m.anchor);
    this.tree._paintAll();
  }

  // 포인터가 위·아래 끝에 있으면 프레임마다 스크롤한다. 더 갈 수 없으면 멈추고,
  // 다음 움직임이 다시 건다.
  _mqScroll(m){
    if(m.tick) return;
    const lr=this.tree.list.getBoundingClientRect();
    const d=m.y<lr.top+EDITOR_MARQUEE_EDGE_PX?-EDITOR_MARQUEE_SCROLL_PX
      :m.y>lr.bottom-EDITOR_MARQUEE_EDGE_PX?EDITOR_MARQUEE_SCROLL_PX:0;
    if(!d) return;
    m.tick=TIMERS.frame(()=>{
      m.tick=null;
      if(!m.on) return;
      const before=this.tree.list.scrollTop;
      this.tree.list.scrollTop+=d;
      if(this.tree.list.scrollTop===before) return;
      this.tree._mqPaint(m);
      this.tree._mqScroll(m);
    },{label:'ed-marquee-scroll'});
  }
}

// 탐색기 원형의 이름 — 앱·렌더러·e2e·시험과 다른 부품이 `FileTree` 에서 부른다 (REFACTOR3_FE_REST5_SRS FR-FR5-32).
Controller.delegate(FileTree,'marquee',['_initMarquee','_mqDown','_mqY','_mqMove','_mqPaint','_mqScroll']);
