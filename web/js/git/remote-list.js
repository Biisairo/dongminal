/**
 * Dongminal — Branches 탭 아래의 원격 목록 (FR-GIT-269).
 *
 * 채우는 자리(`.git-br-remotes`)는 `GitBranches` 가 골격과 함께 내준다. 목록은 자기 상태를 스스로
 * 든다 — 적재는 `gitLoadList` 규약을 지나고, 쓰기(add·remove)의 응답이 실은 목록을 그대로 쓴다.
 */
class GitRemoteList extends GitView {
  constructor(panel){
    super(panel);
    this.reset();
    this._loading=false;
  }

  // 저장소가 바뀌면 목록과 사유를 비운다. 받는 중 표시는 적재가 놓는다 (FR-GRF-24).
  reset(){
    this._list=[]; this._err=null;
  }

  _build(el){
    el.innerHTML=
      '<div class="git-rm-head">'+
        '<span class="git-rm-title"></span>'+
        '<span class="git-rm-count"></span>'+
        '<span class="git-rm-spacer"></span>'+
        '<button class="ui-btn ui-btn-sm git-rm-add" type="button"></button>'+
      '</div>'+
      '<div class="git-rm-note"></div>'+
      '<div class="git-rm-rows ui-scroll-sm"></div>';
    el.querySelector('.git-rm-title').textContent=GIT_RM_TITLE;
    const add=el.querySelector('.git-rm-add');
    add.textContent=GIT_RM_ADD; add.title=GIT_RM_ADD_TITLE;
    add.addEventListener('click',()=>this.add());
  }

  paint(){
    if(!this.el) return;
    if(!this._syncRepo()) return;
    const note=this.el.querySelector('.git-rm-note');
    note.textContent=this._err||'';
    note.classList.toggle('vis',!!this._err);
    this.el.querySelector('.git-rm-count').textContent='('+this._list.length+')';
    this.el.querySelector('.git-rm-add').disabled=!this._repo;
    this._paintRows();
  }

  /**
   * FR-PRF-10: 행을 `reconcileList` 로 맞춘다.
   *
   *   이전 동작: `box.innerHTML=''` 후 전량 재생성. `GitBranches.paint()` 가 관측
   *             회차마다 부르므로, 원격이 하나도 바뀌지 않은 회차에도 행이 전부
   *             사라졌다 다시 났다 — hover 와 글자 선택이 매 회차 끊긴다
   *   새  동작: 값이 그대로면 요소를 그대로 둔다 (변이 0)
   *   이유:     `refactor/README.md` §4.1 항목 6 · `repaint.js` FR-RPT-3
   *
   * 빈 목록의 안내 줄도 같은 규약을 지난다 — 항목 하나짜리 목록으로 둔다.
   */
  _paintRows(){
    const box=this.el.querySelector('.git-rm-rows');
    if(!this._list.length){
      // 빈 목록은 사실을 알린다 — 빈 화면은 실패와 구분되지 않는다.
      const text=(this._loading&&this._repo)?GIT_HIST_LOADING:GIT_RM_EMPTY;
      reconcileList(box,[text],{
        key:()=>'empty',
        sig:s=>s,
        build:s=>{
          const d=document.createElement('div');
          d.className='ui-empty git-rm-empty'; d.textContent=s; return d;
        },
      });
      return;
    }
    // 보이는 값 전부다 (FR-RPT-2) — 이름·URL·push URL 이 행이 그리는 전부이고,
    // 지우기 버튼의 글자는 상수다.
    reconcileList(box,this._list,{
      key:r=>r.name||'',
      sig:r=>[r.name||'',r.url||'',r.pushUrl||''].join(RPT_SEP),
      build:r=>this._rowEl(r),
    });
  }

  _rowEl(r){
    const d=document.createElement('div');
    d.className='git-rm-row'; d.dataset.remote=r.name||'';
    const nm=document.createElement('span');
    nm.className='git-rm-name'; nm.textContent=r.name||'';
    d.appendChild(nm);
    const url=document.createElement('span');
    url.className='git-rm-url';
    url.textContent=(r.url||'')+(r.pushUrl?(' '+GIT_RM_PUSH_PREFIX+r.pushUrl):'');
    // 가려진 자리가 있으면 그 사실을 말한다 — 없으면 URL 이 그렇게 저장돼
    // 있다고 읽힌다.
    url.title=url.textContent.includes(GIT_RM_MASK)?GIT_RM_MASK_TITLE:url.textContent;
    d.appendChild(url);
    d.appendChild(UIKit.button({label:GIT_RM_REMOVE,title:GIT_TIP_RM_REMOVE,size:'sm',cls:'git-rm-del',
      onClick:()=>this.remove(r)}));
    return d;
  }

  add(){
    if(!this.panel.repo) return;
    return new GitRemoteAdd(this)._show();
  }

  async remove(r){
    const repo=this.panel.repo;
    if(!repo||!r||!r.name) return;
    const ok=await GitDialog.confirm({
      action:GIT_ACT_REMOTE_REMOVE,title:GIT_RM_REMOVE_CONFIRM_TITLE,
      targets:[r.name],stages:1,
      hint:{note:GIT_RM_REMOVE_NOTE,
        command:'git -C '+gitShQuote(repo)+' remote add '+r.name+' '+(r.url||'')},
    });
    if(!ok) return;
    const res=await this.panel.write.post(GIT_API.remoteRemove,{repo,name:r.name});
    if(!this.adoptWrite(res)) this._fail(GIT_RM_REMOVE_FAIL,res);
  }

  /**
   * 쓰기 하나의 뒷정리. **응답이 실은 목록을 그대로 쓴다** — 폴링 주기를 기다리면
   * 화면이 그만큼 거짓말을 한다 (FR-GIT-71).
   */
  adoptWrite(res){
    const d=(res&&res.data)||{};
    if(!res||!res.ok) return false;
    if(d.status) this.panel.write.adopt(d);
    if(Array.isArray(d.remotes)) this._list=d.remotes;
    this._err=null;
    this.paint();
    return true;
  }

  // 사유를 보이고 **이미 받은 목록을 지우지 않는다** (FR-GIT-132 과 같은 규약).
  _fail(base,res){
    this._err=base+': '+this.panel.write.writeReason(res);
    this.paint();
  }

  // FR-OPT-1-5: 목록 뷰들과 같은 적재 규약을 지난다 — 낡은 응답에서 잠금을 푸는
  // 순서(FR-GRF-24)와 앞선 조회를 끊는 신호(FR-GRF-31)가 거기 있다.
  _load(){
    return gitLoadList(this,{url:GIT_API.remotes,key:'remotes',failMsg:GIT_RM_LOAD_FAIL});
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitRemoteList=GitRemoteList;
