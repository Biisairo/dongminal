/**
 * Dongminal — Branches 의 **다이얼로그 셋** (FE_MODULE_BOUNDARY_SRS FR-FMB-30).
 *
 * 생성(FR-GIT-158·159) · 이름 변경 · 업스트림 설정. 셋 다 골격이 20단계의
 * `GitDialog` 이고(FR-GIT-171), 각자는 **자기 검사와 실행만** 안다.
 *
 * `GitBranches` 와 갈린 이유: 이 셋은 탭이 아니라 **한 번의 입력**이다. 탭이
 * 없어도 서고(History 의 refs 사이드바가 연다), 탭의 상태를 읽지 않는다.
 */
/**
 * 브랜치 생성 다이얼로그 (FR-GIT-158, 검증 V68).
 *
 * 골격은 20단계의 `GitDialog` 다 (FR-GIT-171) — 이름 / 시작점 / 생성 후 checkout
 * 3필드를 그것에 선언하고, 이 클래스는 이름 검사와 실행만 안다.
 *
 * 이름은 입력 중 `/api/git/branch/validate` 로 검사하고 **위반이면 실행을 막는다**
 * (FR-GIT-159) — 서버도 같은 것을 막지만, 실행해 보고 알려 주면 사용자는 왜
 * 막혔는지 모른다.
 *
 * `exists:true` 는 규칙 위반이 아니다 (계약 §1.2.1) — "다른 이름을 쓰세요" 를
 * 보이려면 그 구분이 필요하다.
 *
 * `track` 이 주어지면 원격 ref 를 다른 이름의 로컬로 가져오는 것이므로(FR-GIT-156)
 * 시작점과 checkout 여부는 뜻이 없다 — 그 두 필드를 만들지 않는다.
 */
class GitBranchCreate {
  constructor(panel,o){
    this.panel=panel;
    this.repo=panel.repo;
    this.track=o.track||'';
    this.name0=o.name||'';
    this.start0=o.startRef||'';
    this.why='';      // 사람이 읽는 사유
    this.whyKind='';  // '' | empty | pending | invalid | exists | fail
    this._seq=0;
  }

  _show(){
    return GitDialog.open({
      id:'git-br-create',ns:'gbc',action:'branch_create',
      title:GIT_BR_CREATE_TITLE,runLabel:GIT_BR_CREATE_RUN,focus:'name',
      fields:[
        {key:'name',type:GIT_DIALOG_TEXT,cls:'gbc-name',
         placeholder:GIT_BR_NAME_PLACEHOLDER,value:this.name0},
        {key:'startRef',type:GIT_DIALOG_TEXT,cls:'gbc-start',fieldCls:'gbc-startrow',
         placeholder:GIT_BR_START_PLACEHOLDER,value:this.start0,hidden:!!this.track},
        // 옵션의 기본값은 안전한 쪽이다 (FR-GIT-173) — 만든 뒤 옮겨 가지 않는다.
        {key:'checkout',type:GIT_DIALOG_CHECK,cls:'gbc-checkout',fieldCls:'gbc-checkoutrow',
         label:GIT_BR_CREATE_CHECKOUT,hidden:!!this.track},
      ],
      validate:(v,d,key)=>this._onName(v,d,key),
      run:v=>this._run(v),
    });
  }

  // 이름만 검사한다. 키 하나마다 보내지 않고 멈춘 뒤에 보낸다 — 이름은 짧지만
  // 검사는 git 실행이다.
  _onName(v,d,key){
    if(key&&key!=='name') return {kind:this.whyKind,why:this.why};
    // REPO_FIX 05 F-9.5: 입력마다 세대를 올린다 — 앞 이름의 검증 응답이 지금 입력의 실행
    // 버튼을 열지 않는다. 이전: 세대가 요청 때만 올라, 디바운스 사이의 입력에 앞 응답이 닿았다.
    this._seq++;
    TIMERS.cancel(this._t);
    const name=(v.name||'').trim();
    if(!name) return this._set('empty',GIT_BR_WHY_EMPTY);
    this._t=TIMERS.after(GIT_BR_VALIDATE_DEBOUNCE_MS,()=>{this._t=null;this._validate(name,d)},{owner:this,label:'branch-validate'});
    // 검사 중에는 실행을 막는다 — 판정을 모르는 동안 실행을 열어 두면 규칙 위반이
    // 그대로 지나간다 (FR-GIT-159).
    return this._set(GIT_DIALOG_WHY_PENDING,'');
  }

  async _validate(name,d){
    if(!d.alive()) return;
    const seq=++this._seq;
    // 뒤늦게 온 이전 이름의 판정을 지금 이름의 것으로 읽지 않는다 — 그 가드가
    // 이제 echo 로 선다.
    const res=await gitFetch(GIT_API.branchValidate,{repo:this.repo,name},
      {stale:()=>seq!==this._seq||!d.alive(),echo:{repo:this.repo,name}});
    if(res.stale) return;
    if(!res.ok){this._tell(d,'fail',GIT_BR_VALIDATE_FAIL); return}
    const dt=res.data;
    if(!dt.ok){this._tell(d,'invalid',dt.reason||GIT_BR_VALIDATE_FAIL);return}
    // 이미 있는 이름은 규칙 위반이 아니다 — 사유가 달라야 사용자가 무엇을 할지 안다.
    if(dt.exists){this._tell(d,'exists',GIT_BR_WHY_EXISTS);return}
    this._tell(d,'','');
  }

  _set(kind,why){this.whyKind=kind;this.why=why;return {kind,why}}

  _tell(d,kind,why){
    this._set(kind,why);
    d.setWhy(kind,why);
  }

  async _run(v){
    const name=(v.name||'').trim();
    // REPO_FIX 01 §5.2: 만들며 옮겨 가는 것은 checkout 잡이다 — 시작되면 닫는다.
    const settle=r=>{
      if(r.ok) this.panel.afterRefWrite(r.data); else this.panel.applyWriteFail(r);
    };
    const res=this.track
      ? await this.panel.postJob(GIT_API.checkout,
          {repo:this.repo,ref:'',create:name,track:this.track},settle)
      : await this.panel.postJob(GIT_API.branch,{
          repo:this.repo,name,
          startRef:(v.startRef||'').trim(),
          checkout:!!v.checkout,
        },settle);
    if(res.started) return {ok:true};
    if(res.ok){
      // 조작 후 목록·상태를 갱신한다 (FR-GIT-160).
      this.panel.afterRefWrite(res.data);
      return {ok:true};
    }
    // 실패 사유는 다이얼로그 안에 남는다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175).
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(res.data&&res.data.message)||''};
  }
}

/**
 * 이름 변경 다이얼로그 (FR-GIT-253).
 *
 * 이름 검사는 생성 다이얼로그의 것을 **그대로 물려받는다** — 규칙 검사·중복 확인이
 * 두 벌이면 한쪽만 고쳐진다 (FR-GIT-159). 처음 값이 현재 이름이므로 그대로 두면
 * `exists` 로 실행이 막힌다: 바꾸지 않은 이름으로의 변경은 변경이 아니다.
 */
class GitBranchRename extends GitBranchCreate {
  constructor(panel,from){
    super(panel,{name:from});
    this.from=from;
  }

  _show(){
    return GitDialog.open({
      id:'git-br-rename',ns:'gbr',action:'branch_rename',
      title:GIT_BR_RENAME_TITLE,runLabel:GIT_BR_RENAME_RUN,focus:'name',
      fields:[
        {key:'name',type:GIT_DIALOG_TEXT,cls:'gbr-name',
         placeholder:GIT_BR_RENAME_PLACEHOLDER,value:this.from},
      ],
      validate:(v,d,key)=>this._onName(v,d,key),
      run:v=>this._run(v),
    });
  }

  async _run(v){
    const res=await this.panel.post(GIT_API.branchRename,
      {repo:this.repo,from:this.from,to:(v.name||'').trim()});
    if(res.ok){
      // 조작 후 목록·상태를 갱신한다 (FR-GIT-160) — 상태바의 브랜치 이름도 따라간다.
      this.panel.afterRefWrite(res.data);
      return {ok:true};
    }
    // 실패 사유는 다이얼로그 안에 남는다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175).
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(res.data&&res.data.message)||''};
  }
}

/**
 * upstream 설정 다이얼로그 (FR-GIT-257).
 *
 * upstream 이 알려진 원격 ref 인지는 **서버가 판정한다** (SERVER_DRIVEN_ACTIONS_SRS GV-f ·
 * FR-SDA-41). 입력 중에 묻고(`git.branch.upstream_set`), 실행도 같은 판정으로 거절된다.
 *
 *   이전 동작: Branches 탭이 들고 있는 원격 ref 로 화면이 검사했고, 목록이 없는 자리
 *             (History 의 refs 사이드바)에서는 검사를 건너뛰었다. 서버는 막지 않았다
 *   새  동작: 어느 자리에서 열어도 서버가 판정하고 거절한다
 *   이유:     D-SDA-3 — 화면을 거치지 않은 요청도 같은 판정을 받는다
 */
class GitBranchUpstream {
  constructor(panel,target){
    this.panel=panel;
    this.repo=panel.repo;
    this.branch=target.short||'';
    this.value=target.upstream||'';
    this._answer=new GitInputAnswer({repo:this.repo,id:GIT_ACTION.branchUpstreamSet,
      params:v=>({branch:this.branch,upstream:(v.upstream||'').trim()}),
      fail:res=>panel.writeReason(res)});
  }

  _show(){
    return GitDialog.open({
      id:'git-br-upstream',ns:'gbu',action:'branch_upstream',
      title:GIT_BR_UPSTREAM_TITLE,runLabel:GIT_BR_UPSTREAM_RUN,focus:'upstream',
      fields:[
        {key:'upstream',type:GIT_DIALOG_TEXT,cls:'gbu-up',
         placeholder:GIT_BR_UPSTREAM_PLACEHOLDER,value:this.value},
      ],
      validate:(v,d)=>this._answer.why(v,d),
      run:v=>this._run(v),
    });
  }

  async _run(v){
    const res=await this.panel.post(GIT_API.branchUpstream,
      {repo:this.repo,branch:this.branch,upstream:(v.upstream||'').trim()});
    if(res.ok){
      this.panel.afterRefWrite(res.data);
      return {ok:true};
    }
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(res.data&&res.data.message)||''};
  }
}

window.GitBranchCreate=GitBranchCreate;
window.GitBranchRename=GitBranchRename;
window.GitBranchUpstream=GitBranchUpstream;
