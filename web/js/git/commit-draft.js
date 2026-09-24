/**
 * GitCommit — 입력칸의 두 슬롯: draft 와 amend 메시지 (FR-GIT-75·78, O6 · REPO_FIX 05 F-7.2·7.3·7.5).
 *
 * draft 는 워크스페이스(서버 동기)에 저장되는 사용자의 글이고, amend 메시지는 직전 커밋의
 * 메시지를 고치는 **일시적인** 글이다 — 메모리에만 두고 저장하지 않는다(사용자 결정).
 * 새로고침하면 amend 가 풀리고 draft 가 보인다.
 *
 *   이전 동작: 한 슬롯에 두 의미 — amend 중 친 글자가 디바운스로 draft 에 저장돼 원 draft 를
 *             덮었고, 새로고침하면 amend 글이 draft 로 남았다(#34)
 *   새  동작: 슬롯을 나눈다. 입력칸은 그때의 슬롯을 보인다
 */
Object.assign(GitCommit.prototype, {
  // draft 는 ws.git.drafts[<repo>] 다. **git 객체를 통째로 갈아치우지 않는다** —
  // git.pinned 는 서버가 권위로 쓰므로 그것을 지우면 핀이 사라진다 (O1).
  _drafts(){
    const ws=this.app.ws;
    if(!ws.git) ws.git={};
    if(!ws.git.drafts||typeof ws.git.drafts!=='object') ws.git.drafts={};
    return ws.git.drafts;
  },

  _draftGet(repo){
    const g=this.app.ws.git;
    const d=g&&g.drafts;
    return (d&&typeof d[repo]==='string')?d[repo]:'';
  },

  _draftSet(repo,v){
    if(!repo) return;
    const d=this._drafts();
    if(v) d[repo]=v; else delete d[repo];
    this.app.save();
  },

  _setValue(v){
    this._msg.value=v||'';
    this._grow();
  },

  _input(){
    this._grow();
    this._err=null;
    // 입력이 있으면 앞선 차단 표시는 낡은 것이다 — 다음 시도가 다시 채운다.
    this._blocks=null;
    const v=this._msg.value;
    // F-7.2: amend 중의 입력은 amend 슬롯이다 — draft 를 덮지 않고 저장하지 않는다.
    if(this._amend){this._amendText=v; this._paint(); return}
    TIMERS.cancel(this._saveT);
    this._saveRepo=this._repo; this._saveV=v;
    // 입력이 멈춘 뒤에 저장한다 — 키 하나마다 PUT 을 보내지 않는다.
    this._saveT=TIMERS.after(GIT_COMMIT_DRAFT_DEBOUNCE_MS,()=>this._draftFlush(),{owner:this,label:'commit-draft'});
    this._paint();
  },

  // F-7.5: 대기 중인 draft 저장을 곧바로 반영한다. 저장소 전환·amend 켜기가 부른다 —
  // 취소하면 방금 친 글이 사라진다(이전 동작).
  _draftFlush(){
    if(this._saveT){TIMERS.cancel(this._saveT);this._saveT=null}
    const repo=this._saveRepo; this._saveRepo=null;
    if(repo) this._draftSet(repo,this._saveV);
  },

  _reset(repo){
    this._draftFlush();
    this._repo=repo;
    this._amend=false; this._amendText='';
    this._opts={signoff:false,noVerify:false,all:false};
    this._menuOpen=false; this._blocks=null; this._err=null; this._busy=false;
    this._headKey=null;
    // 앞선 리포의 undo 진입점을 새 리포의 화면에 남기지 않는다.
    this._undoHide();
    this._pf=null; this._pfRepo=null;
    this._setValue(repo?this._draftGet(repo):'');
    if(repo) this._loadPreflight(repo);
  },

  // ── amend (FR-GIT-78) ──

  /**
   * 켜면 직전 커밋 메시지를 amend 슬롯에 채운다. F-7.3: 조회는 (저장소, 요청 시 입력 값)
   * 토큰을 잡고, 도착했을 때 그 사이 입력이 바뀌었으면 넣지 않는다 — 친 글자를 덮지 않는다.
   * 끄면 draft 슬롯을 보인다.
   */
  async _amendToggle(on){
    const repo=this._repo;
    this._err=null;
    if(!repo){this._amend=!!on;this._paint();return}
    if(!on){
      this._amend=false; this._amendText='';
      this._setValue(this._draftGet(repo));
      this._paint();
      return;
    }
    this._draftFlush();
    this._amend=true;
    const tok=this._msg.value;
    this._amendText=tok;
    this._paint();
    const msg=await this._lastMessage(repo);
    if(this._repo!==repo||!this._amend||this._msg.value!==tok||msg===null){this._paint();return}
    this._amendText=msg;
    this._setValue(msg);
    this._paint();
  },

  // 직전 커밋 메시지. 전용 진입점이 없으므로 커밋 상세의 body 를 쓴다
  // (FR-GIT-136). 커밋이 없는 저장소에서는 null 이다 — amend 할 것이 없다.
  async _lastMessage(repo){
    const res=await gitFetch('/api/git/commit',{repo,oid:'HEAD'},{echo:{repo}});
    if(!res.ok||typeof res.data.body!=='string') return null;
    return res.data.body.replace(/\n+$/,'');
  },
});
