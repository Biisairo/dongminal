/**
 * Dongminal — 파괴적 동작의 2단계 확인 (GIT_SRS §3A.3 / FR-GIT-90~97·174~178)
 *
 * 1단계는 **영향 범위**다 — 무엇이 몇 개 사라지는지 목록으로 보인다. 개수만
 * 보이면 사용자가 무엇을 잃는지 모른다 (FR-GIT-91).
 * 2단계는 recovery hint 를 보이고 받는 명시적 실행 확인이다 (FR-GIT-92).
 *
 * 이 클래스는 M5 묶음 P 의 공통 다이얼로그 규약이 흡수할 자리다. 그때 잃어서는
 * 안 되는 규약을 여기 적어 둔다 (GIT_M2_STEP9_CONTRACT §5):
 *
 * - 기본 선택지는 항상 안전한 쪽이다 (FR-GIT-97) — 초기 포커스는 `취소` 이고
 *   `Enter` 의 기본 동작도 취소다 (FR-GIT-176). 실행은 클릭 또는 탭 이동 후
 *   Space 로만 한다. `Esc` 는 취소다.
 * - 모바일에서는 실행 버튼을 목록과 **분리된 별도 행**에 두고 구분선·여백을
 *   준다. 목록은 max-height + overflow-y 로 버튼을 화면 밖으로 밀지 않는다
 *   (FR-GIT-94·177).
 * - 실행 중에는 두 버튼을 disable 하고 진행 표시를 보인다 (FR-GIT-174).
 * - 실패하면 사유와 stderr tail 을 보이고 복사 버튼을 준다 (FR-GIT-96·175).
 * - 다이얼로그가 열린 동안에도 폴링은 계속된다. 대상 상태가 바뀌면 1단계 목록
 *   위에 알리되 **실행을 막지 않고 다시 열게 강제하지도 않는다** (FR-GIT-178).
 *
 * **파괴적 동작 목록을 프론트에 복제하지 않는다** — `GET /api/git/policy` 를
 * 받아 캐시한다. 서버에 새 파괴적 동작이 생기면 클라이언트가 자동으로 그것을
 * 막는다 (FR-GIT-89).
 */
class GitConfirm {
  /**
   * open 은 확인을 띄우고 사용자가 끝까지 진행했을 때만 true 로 resolve 한다.
   *
   * run 을 주면 2단계 확인 뒤 그것을 실행하고 결과를 다이얼로그 안에서 보인다
   * (FR-GIT-174·175) — 실패 사유와 stderr tail 이 다이얼로그 밖으로 새면 복사
   * 버튼을 줄 자리가 없다. run 은 `{ok:true}` 또는
   * `{ok:false,reason,stderrTail}` 를 준다. run 이 없으면 확인만 하고 실행은
   * 호출자가 한다.
   */
  static async open({action,title,targets,hint,mobile,run}){
    // 파괴적 확인은 한 번에 하나다 — 겹치면 어느 대상의 확인인지 알 수 없다.
    if(GitConfirm._cur) return false;
    if(!await GitConfirm.destructive(action)){
      if(typeof run!=='function') return true;
      const res=await run();
      return !!(res&&res.ok);
    }
    const c=new GitConfirm({action,title,targets,hint,mobile,run});
    return c._show();
  }

  /**
   * destructive 는 서버의 파괴적 동작 목록으로 판정한다. 목록은 저장소마다
   * 다르지 않으므로 세션 동안 한 번만 받는다.
   *
   * 받지 못했으면 **파괴적으로 본다** — 목록을 모를 때 확인을 건너뛰면 방어가
   * 사라진다. 기본은 항상 안전한 쪽이다 (FR-GIT-97).
   */
  static async destructive(action){
    if(!GitConfirm._policy){
      if(!GitConfirm._policyP) GitConfirm._policyP=GitConfirm._fetchPolicy();
      GitConfirm._policy=await GitConfirm._policyP;
      GitConfirm._policyP=null;
    }
    return GitConfirm._policy?GitConfirm._policy.has(action):true;
  }

  static async _fetchPolicy(){
    let r,d;
    try{r=await fetch('/api/git/policy')}catch{return null}
    if(!r.ok) return null;
    try{d=await r.json()}catch{return null}
    return Array.isArray(d&&d.destructive)?new Set(d.destructive):null;
  }

  /**
   * FR-GIT-178: 폴링이 새 관측을 얻을 때마다 불린다. 저장소 signature 가
   * 열었을 때와 달라지면 1단계 목록 위에 알린다 — 대상 하나하나를 다시 재는
   * 것이 아니라 저장소가 움직였다는 사실만 전한다. 실행은 막지 않는다.
   */
  static notify(sig){
    const c=GitConfirm._cur;
    if(!c||c.changed||!c._sig0||!sig||sig===c._sig0) return;
    c.changed=true; c._paint();
  }

  static _sig(){
    const g=window.app&&app.gitPanel;
    return (g&&g._lastSig)||'';
  }

  constructor(o){
    this.action=o.action||'';
    this.title=o.title||GIT_CONFIRM_TITLE;
    this.targets=Array.isArray(o.targets)?o.targets:[];
    this.hint=o.hint||null;
    this.run=typeof o.run==='function'?o.run:null;
    // 모바일 판정은 호출자가 덮을 수 있다. 기본은 app.isMobile (FR-GIT-94).
    this.mobile=o.mobile===undefined?!!(window.app&&app.isMobile):!!o.mobile;
    this.stage=1;
    this.busy=false;
    this.changed=false;
    this.err=null;   // {reason,tail}
    this._sig0=GitConfirm._sig();
  }

  _show(){
    this._build();
    GitConfirm._cur=this;
    this._paint();
    this._focus();
    return new Promise(res=>{this._resolve=res});
  }

  _build(){
    const ov=document.createElement('div'); ov.id='git-confirm'; ov.className='gc-modal';
    ov.innerHTML=
      '<div class="gc-box" role="dialog" aria-modal="true">'+
        '<div class="gc-head"></div>'+
        // FR-GIT-178: 목록 **위**에 알린다.
        '<div class="gc-changed"></div>'+
        '<div class="gc-count"></div>'+
        '<ul class="gc-targets"></ul>'+
        '<div class="gc-hint">'+
          '<div class="gc-hint-label"></div>'+
          '<div class="gc-hint-note"></div>'+
          '<code class="gc-hint-cmd"></code>'+
          '<button type="button" class="gc-copy gc-copy-hint"></button>'+
        '</div>'+
        '<div class="gc-err">'+
          '<div class="gc-err-reason"></div>'+
          '<pre class="gc-err-tail"></pre>'+
          '<button type="button" class="gc-copy gc-copy-err"></button>'+
        '</div>'+
        // 실행 버튼이 목록과 분리된 별도 행이다 (FR-GIT-94·177).
        '<div class="gc-actions">'+
          '<span class="gc-progress"></span>'+
          '<button type="button" class="gc-cancel"></button>'+
          '<button type="button" class="gc-go"></button>'+
        '</div>'+
      '</div>';
    document.body.appendChild(ov);
    this.ov=ov; this.box=ov.querySelector('.gc-box');
    this.box.querySelector('.gc-cancel').addEventListener('click',()=>this._cancel());
    this.box.querySelector('.gc-go').addEventListener('click',()=>this._advance());
    this.box.querySelector('.gc-copy-hint').addEventListener('click',()=>
      this._copy((this.hint&&this.hint.command)||''));
    this.box.querySelector('.gc-copy-err').addEventListener('click',()=>
      this._copy((this.err&&this.err.tail)||''));
    // Enter 는 실행이 아니다 (FR-GIT-176). capture 로 잡아 기본 동작(포커스된
    // 버튼의 click 합성)까지 막는다 — 실행은 클릭 또는 Space 로만 한다.
    this._key=e=>{
      if(e.key!=='Enter'&&e.key!=='Escape') return;
      e.preventDefault(); e.stopPropagation();
      // 실행 중에는 두 버튼이 disable 이다 — 키도 같이 막는다 (FR-GIT-174).
      if(!this.busy) this._cancel();
    };
    document.addEventListener('keydown',this._key,true);
  }

  _paint(){
    const b=this.box; if(!b) return;
    b.classList.toggle('mobile',this.mobile);
    b.dataset.action=this.action;
    b.dataset.stage=String(this.stage);
    b.querySelector('.gc-head').textContent=this.title;
    const ch=b.querySelector('.gc-changed');
    ch.textContent=this.changed?GIT_CONFIRM_CHANGED:'';
    ch.classList.toggle('vis',this.changed);
    // 개수는 목록과 **함께** 보인다 (FR-GIT-91).
    b.querySelector('.gc-count').textContent=
      GIT_CONFIRM_COUNT_LABEL+' '+this.targets.length+'개';
    const ul=b.querySelector('.gc-targets'); ul.innerHTML='';
    for(const t of this.targets){
      const li=document.createElement('li'); li.className='gc-target'; li.textContent=t;
      ul.appendChild(li);
    }
    // 2단계에서만 recovery hint 를 보인다. 목록은 두 단계 모두 남는다 — 무엇을
    // 잃는지가 실행 직전에도 보여야 한다.
    const hint=b.querySelector('.gc-hint');
    hint.classList.toggle('vis',this.stage===2);
    hint.querySelector('.gc-hint-label').textContent=GIT_CONFIRM_HINT_LABEL;
    hint.querySelector('.gc-hint-note').textContent=
      (this.hint&&this.hint.note)||(this.hint?'':GIT_CONFIRM_NO_HINT);
    hint.querySelector('.gc-hint-cmd').textContent=(this.hint&&this.hint.command)||'';
    hint.querySelector('.gc-copy-hint').textContent=GIT_CONFIRM_COPY;
    const err=b.querySelector('.gc-err');
    err.classList.toggle('vis',!!this.err);
    err.querySelector('.gc-err-reason').textContent=(this.err&&this.err.reason)||'';
    err.querySelector('.gc-err-tail').textContent=(this.err&&this.err.tail)||'';
    err.querySelector('.gc-copy-err').textContent=GIT_CONFIRM_COPY;
    b.querySelector('.gc-progress').textContent=this.busy?GIT_CONFIRM_RUNNING:'';
    const cancel=b.querySelector('.gc-cancel'),go=b.querySelector('.gc-go');
    cancel.textContent=GIT_CONFIRM_CANCEL;
    go.textContent=this.stage===1?GIT_CONFIRM_CONTINUE:GIT_CONFIRM_RUN;
    cancel.disabled=this.busy; go.disabled=this.busy;
  }

  // 기본 선택지는 취소다 (FR-GIT-97) — 단계가 넘어가도 포커스는 취소로 돌아온다.
  _focus(){
    const c=this.box&&this.box.querySelector('.gc-cancel');
    if(c) c.focus();
  }

  async _advance(){
    if(this.busy) return;
    if(this.stage===1){
      this.stage=2; this.err=null; this._paint(); this._focus();
      return;
    }
    if(!this.run){this._close(true);return}
    this.busy=true; this.err=null; this._paint();
    let res=null;
    try{res=await this.run()}catch(e){res={ok:false,reason:String(e)}}
    this.busy=false;
    if(res&&res.ok){this._close(true);return}
    // FR-GIT-96·175: 사유와 stderr tail 을 남기고 다이얼로그를 닫지 않는다 —
    // 닫아 버리면 복사할 자리가 사라진다.
    this.err={reason:(res&&res.reason)||GIT_CONFIRM_FAIL,tail:(res&&res.stderrTail)||''};
    this._paint(); this._focus();
  }

  _cancel(){ this._close(false) }

  _close(v){
    document.removeEventListener('keydown',this._key,true);
    if(this.ov) this.ov.remove();
    this.ov=null; this.box=null;
    if(GitConfirm._cur===this) GitConfirm._cur=null;
    const r=this._resolve; this._resolve=null;
    if(r) r(!!v);
  }

  // 클립보드 접근이 막힌 환경에서도 동작해야 한다 — GitPanel 의 경로 복사와 같은
  // 방식이다.
  _copy(text){
    if(!text) return;
    const ta=document.createElement('textarea');
    ta.value=text; ta.style.cssText='position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    try{document.execCommand('copy')}catch{}
    ta.remove();
  }
}

GitConfirm._cur=null;
GitConfirm._policy=null;
GitConfirm._policyP=null;

// e2e 와 10·11단계 클라이언트가 창 밖에서 부르는 진입점이다. 고전 스크립트의
// class 선언은 window 의 속성이 되지 않으므로 여기서 명시적으로 붙인다
// (main.js 의 window.app 과 같은 규약).
window.GitConfirm=GitConfirm;
