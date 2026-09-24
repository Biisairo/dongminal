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
 * 실행 전에 보인다 (FR-GIT-167). 서버도 `nothing_to_stash` 로 막지만, 실행해 보고
 * 알려 주면 사용자는 왜 아무 일도 없었는지 모른다.
 */
class GitStashCreate {
  constructor(panel){
    this.panel=panel;
    this.repo=panel.repo;
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
      validate:v=>this._why(v),
      run:v=>this._run(v),
    });
  }

  // 이 옵션으로 담길 것이 있는지 (FR-GIT-167). 서버의 StashableCount 와 같은 규칙이다.
  _why(v){
    const s=this.panel.statusOf();
    if(!s) return GIT_LOADING_HINT;
    const n=(s.staged||[]).length+(s.changes||[]).length+(s.conflicts||[]).length+
      (v.includeUntracked?(s.untracked||[]).length:0);
    if(n) return '';
    return (s.untracked||[]).length?GIT_STASH_UNTRACKED_ONLY:GIT_STASH_NOTHING;
  }

  async _run(v){
    const res=await this.panel.post('/api/git/stash/push',{
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
    const res=await this.panel.post('/api/git/stash/branch',{
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
