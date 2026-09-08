/**
 * Dongminal — Git 목록 탭의 공통 골격 (DRIFT_RECLAIM_SRS FR-DRC-7)
 *
 * Worktrees 와 Submodules 는 같은 모양이다: 머리에 동작, 그 아래 안내 줄, 그 아래
 * `reconcileList` 로 그리는 목록, 비었을 때의 한 줄. `submodules.js` 의 머리
 * 주석이 그것을 이미 적어 두었다 —
 *
 *   **골격은 Worktrees 탭과 같다** (FR-SUB-7). ... 같은 모양의 목록이 둘이면
 *   규칙도 하나여야 한다.
 *
 * 규칙이 하나여야 한다고 적고 **두 벌로 구현했다.** 복제는 표기부터 갈라져 있었다:
 * 같은 U+0001 구분자를 `worktrees.js` 는 `'\u0001'` 로, `submodules.js` 는 소스에
 * 날것의 제어문자로 적었다 — 동작은 같지만 뒤엣것은 화면에서 빈 문자열로 보여
 * 읽는 사람이 "구분자가 없다" 로 읽는다. 규칙이 한 곳에 있으면 그 표기도 하나다.
 *
 * 여기 남는 것은 **모양**이고, 하위가 채우는 것은 **내용**이다:
 *
 *   _headHTML()   머리에 들어갈 마크업 (spacer 는 골격이 붙인다)
 *   _mountHead()  머리의 배선. mount 당 한 번
 *   _paintHead()  머리의 상태 반영 (비활성 등). paint 마다
 *   _emptyText()  목록이 비었을 때의 한 줄
 *   _key(e)·_sig(e)·_rowEl(e)   행의 정체·서명·마크업
 *   _load()       목록 질의
 *
 * `prefix` 는 CSS 클래스의 접두사다 (`git-wt` · `git-sub`). 마크업과 스타일이
 * 그것 하나로 이어진다 — 골격이 클래스 이름을 만들므로 `-head`·`-note`·`-list`·
 * `-empty` 의 규칙이 탭마다 갈릴 수 없다.
 */
class GitListTab {
  constructor(panel, prefix){
    this.panel=panel;
    this.app=panel.app;
    this.prefix=prefix;
    this._el=null;
    this._repo=undefined;
    this.reset();
  }

  reset(){
    this._list=[];
    this._err=null;
    this._loading=false;
    this._note=null;   // {kind,msg}
  }

  // ── 골격 ──

  mount(el){
    if(!el) return;
    this._el=el;
    const p=this.prefix;
    el.innerHTML=
      '<div class="'+p+'-head">'+this._headHTML()+
        '<span class="'+p+'-spacer"></span>'+
      '</div>'+
      '<div class="'+p+'-note">'+
        '<span class="'+p+'-note-msg"></span>'+
        '<button class="'+p+'-note-close"></button>'+
      '</div>'+
      '<div class="'+p+'-list"></div>'+
      '<div class="'+p+'-empty"></div>';
    const close=el.querySelector('.'+p+'-note-close');
    close.textContent=GIT_NOTE_CLOSE; close.title=GIT_TIP_NOTE_CLOSE;
    close.addEventListener('click',()=>{this._note=null; this._paintNote()});
    this._mountHead(el);
    this._repo=undefined;
  }

  unmount(){
    this._el=null;
    this._repo=undefined;
  }

  // ── 칠하기 ──

  paint(){
    if(!this._el) return;
    if(this.panel.repo!==this._repo) this._adopt();
    if(!this._el) return;
    this._paintNote();
    this._paintList();
  }

  // FR-GIT-238: 새로고침이 부르는 공개 진입점. 목록만 다시 받는다.
  reload(){
    if(!this._el||this.panel.repo!==this._repo) return;
    return this._load();
  }

  _adopt(){
    this._repo=this.panel.repo;
    this.reset();
    if(!this._repo) return;
    this._load();
  }

  _paintNote(){
    gitPaintNote(this._el,this.prefix,this._note);
  }

  /**
   * FR-RPT-1·3: 바깥 계기로 다시 그려도 바뀌지 않은 행은 그대로 둔다. 목록마다
   * 손으로 막으면 다음 목록에서 또 빠진다 (FR-RPT-6). 판정 근거는 **행이 읽는 값
   * 전부**다 (FR-RPT-2).
   */
  _paintList(){
    const p=this.prefix;
    const box=this._el.querySelector('.'+p+'-list');
    const empty=this._el.querySelector('.'+p+'-empty');
    const msg=this._err||(this._list.length?'':(this._loading?GIT_LOADING_HINT:this._emptyText()));
    empty.textContent=msg;
    empty.classList.toggle('vis',!!msg);
    this._paintHead();
    reconcileList(box,this._err?[]:this._list,{
      key:e=>this._key(e),
      sig:e=>this._sig(e),
      build:e=>this._rowEl(e),
    });
  }

  /**
   * 행의 서명. **구분자를 반드시 지난다** — 필드를 그냥 이어 붙이면 경계가 없어
   * 서로 다른 행이 같은 서명을 낼 수 있고, 그 행은 바뀌어도 다시 그려지지 않는다.
   * 하위는 `_sigParts` 만 정하고 이 규칙은 건드리지 않는다. 값에 나타나지 않는
   * 제어문자를 쓰는 이유이며, 소스에는 이스케이프로 적는다 (보이지 않는 바이트를
   * 소스에 두면 diff 와 검색이 그것을 놓친다).
   */
  _sig(e){
    return this._sigParts(e).join('\u0001');
  }

  // ── 하위가 채우는 자리 ──

  _headHTML(){return ''}
  _mountHead(_el){}
  _paintHead(){}
  _emptyText(){return ''}
  _key(e){return e.path}
  _sigParts(e){return [e.path]}
  _rowEl(_e){return document.createElement('div')}
  _load(){}
}
