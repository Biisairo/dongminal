/**
 * Dongminal — Git Stash 다이얼로그 (FR-GIT-166·272)
 *
 * stash 생성과 Branch from stash. `stash.js`(목록·미리보기)에서 떼어 냈다 — 모듈
 * 크기 기준선(FR-STR-40)을 지키기 위한 이동이며 동작은 같다.
 */
/**
 * stash 생성 다이얼로그 (FR-GIT-166, 검증 V58).
 *
 * 골격은 20단계의 `GitDialog` 다 (FR-GIT-171) — 메시지 / `--include-untracked` /
 * `--keep-index` 3필드를 그것에 선언하고, 이 클래스는 담길 것이 있는지의 판정과
 * 실행만 안다. 옵션의 기본값은 안전한 쪽이므로 둘 다 꺼져 있다 (FR-GIT-173).
 *
 * untracked 뿐인 저장소에서는 `--include-untracked` 없이 담길 것이 없다 — 그것을
 * 실행 전에 보인다 (FR-GIT-167). 담길 것이 있는지는 **서버가 답한다**
 * (SERVER_DRIVEN_ACTIONS_SRS M-9) — 이 클래스는 묻고 그 답을 그린다. 실행 요청도
 * 서버가 같은 판정으로 거절한다.
 */
class GitStashCreate {
  constructor(panel){
    this.panel=panel;
    this.repo=panel.repo;
    this._seq=0;
    this._state=null;
  }

  _show(){
    return GitDialog.open({
      id:'git-stash-create',ns:'gsc',action:'stash_push',
      title:GIT_STASH_CREATE_TITLE,runLabel:GIT_STASH_CREATE_RUN,focus:'message',
      fields:[
        {key:'message',type:GIT_DIALOG_TEXT,cls:'gsc-msg',
         placeholder:GIT_STASH_MSG_PLACEHOLDER},
        {key:'includeUntracked',type:GIT_DIALOG_CHECK,cls:'gsc-untracked',
         fieldCls:'gsc-optrow',label:GIT_STASH_OPT_UNTRACKED},
        {key:'keepIndex',type:GIT_DIALOG_CHECK,cls:'gsc-keepindex',
         fieldCls:'gsc-optrow',label:GIT_STASH_OPT_KEEPINDEX},
      ],
      validate:(v,d,key)=>this._why(v,d,key),
      run:v=>this._run(v),
    });
  }

  // 판정을 바꾸는 입력은 untracked 포함 하나다 — 열 때와 그것을 바꿀 때만 묻는다.
  // 메시지를 치는 동안에는 마지막 답을 그대로 둔다.
  _why(v,d,key){
    if(key===''||key==='includeUntracked'){
      const seq=++this._seq;
      this._state=this._whyOf(actionState(null,false));
      this._ask(!!v.includeUntracked,d,seq);
    }
    return this._state;
  }

  async _ask(includeUntracked,d,seq){
    const id=GIT_ACTION.stashCreate;
    // 늦게 온 앞선 답은 버린다 — 옵션을 바꾼 뒤의 답만 지금 입력의 것이다.
    const res=await gitFetch(GIT_API.actions,{repo:this.repo,action:id,includeUntracked:includeUntracked?'1':'0'},
      {stale:()=>seq!==this._seq||!d.alive(),echo:{repo:this.repo,action:id}});
    if(res.stale) return;
    const s=res.ok?actionState(res.data.actions[id],false):{enabled:false,why:this.panel.writeReason(res)};
    this._state=this._whyOf(s);
    d.setWhy(this._state.kind,this._state.why);
  }

  _whyOf(s){return s.enabled?{kind:'',why:''}:{kind:GIT_DIALOG_WHY,why:s.why}}

  async _run(v){
    const res=await this.panel.post(GIT_API.stashPush,{
      repo:this.repo,
      message:(v.message||'').trim(),
      includeUntracked:!!v.includeUntracked,
      keepIndex:!!v.keepIndex,
    });
    // 조작 응답은 실행 후 목록과 status 를 함께 싣고 온다 (FR-GIT-170) — 실패
    // 응답도 그렇다.
    this.panel.afterStashWrite(res);
    if(res.ok) return {ok:true};
    // 실패 사유는 다이얼로그 안에 남는다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175).
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(res.data&&res.data.message)||''};
  }
}

/**
 * Branch from stash 다이얼로그 (FR-GIT-272, 검증 V199).
 *
 * 골격은 20단계의 `GitDialog` 다 (FR-GIT-171) — 이름 한 필드를 선언하고, 이 클래스는
 * 실행만 안다. **파괴적이 아니다**: git 은 적용이 끝난 뒤에만 그 stash 를 지우므로
 * 실패하면 stash 가 그대로 남는다.
 *
 * 이름 규칙 전체를 여기서 판정하지 않는다 — 그것은 서버가 git 에 묻는다
 * (FR-GIT-159). 여기서 막는 것은 비어 있는 이름뿐이다.
 */
class GitStashBranch {
  constructor(panel,stash){
    this.panel=panel;
    this.repo=panel.repo;
    this.stash=stash;
  }

  _show(){
    return GitDialog.open({
      id:'git-stash-branch',ns:'gsb',action:'stash_branch',
      title:GIT_STASH_BRANCH_TITLE,runLabel:GIT_STASH_BRANCH_RUN,focus:'name',
      // 무엇에서 만드는지 보이지 않으면 사용자는 어느 stash 인지 알 수 없다
      // (FR-GIT-91 의 정신).
      body:GitStash.label(this.stash),
      fields:[
        {key:'name',type:GIT_DIALOG_TEXT,cls:'gsb-name',
         placeholder:GIT_STASH_BRANCH_NAME_PH},
      ],
      validate:v=>(v.name||'').trim()?'':GIT_STASH_BRANCH_NEED_NAME,
      run:v=>this._run(v),
    });
  }

  async _run(v){
    const res=await this.panel.post(GIT_API.stashBranch,{
      repo:this.repo,oid:this.stash.oid,name:(v.name||'').trim(),
    });
    // 조작 응답은 실행 후 목록과 status 를 함께 싣고 온다 (FR-GIT-170) — 실패
    // 응답도 그렇다. **ref 가 바뀌므로 refs 도 다시 받는다** (FR-GIT-160):
    // status 만으로는 새 브랜치가 생겼는지 알 수 없다.
    this.panel.afterStashRefWrite(res);
    if(res.ok) return {ok:true};
    // 실패 사유는 다이얼로그 안에 남는다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175).
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(res.data&&res.data.message)||''};
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitStashCreate=GitStashCreate;
window.GitStashBranch=GitStashBranch;
