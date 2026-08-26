/**
 * Dongminal — Git 다이얼로그 공통 골격 (GIT_SRS §3D.3 / FR-GIT-171~178)
 *
 * M1~M5 를 지나며 다이얼로그가 여럿 생겼다. **이 파일은 새 다이얼로그를 만드는
 * 것이 아니라 이미 만든 것들의 골격을 한 자리에 모은 것이다** — 제목·본문·옵션·
 * 실행/취소·진행 표시·결과 표시가 여기 한 번만 있다 (FR-GIT-171).
 *
 * 흡수한 것: 원격 `▾` 옵션(FR-GIT-109·110), 브랜치 생성(FR-GIT-158),
 * stash 생성(FR-GIT-166), 셋 이상의 선택(FR-GIT-156·157).
 *
 * **파괴적 확인은 여기서 다시 구현하지 않는다** (FR-GIT-172). 9단계 `GitConfirm`
 * 이 그것의 전문가이고 — 영향 범위 목록, recovery hint, 2단계, 서버의 파괴적 동작
 * 목록 판정 — `destructive:true` 는 그것에 **위임**한다. 확인 로직이 두 벌이면
 * 한쪽이 조용히 뒤처진다.
 *
 * 규약 (검증 V59):
 *
 * - 옵션의 기본값은 항상 안전한 쪽이다 (FR-GIT-173): 체크박스는 꺼짐, 라디오는
 *   첫 선택지, 자격증명을 받는 필드 종류는 아예 없다 (FR-GIT-104).
 * - 실행 중에는 중복 실행을 막고 진행을 보인다 (FR-GIT-174).
 * - 실패하면 사유와 stderr tail 을 보이고 복사 버튼을 준다 (FR-GIT-175) —
 *   다이얼로그를 닫지 않는다. 닫으면 복사할 자리가 사라진다.
 * - `Esc` 는 취소이고 `Enter` 는 기본 동작이다 (FR-GIT-176). **파괴적
 *   다이얼로그에서 기본 동작은 취소**이며 그 규약은 `GitConfirm` 이 지킨다.
 * - 모바일 폭에서는 옵션이 스크롤로 접히고 실행 버튼이 분리된 별도 행이 된다
 *   (FR-GIT-94·177).
 * - 열린 동안에도 폴링은 계속된다. 대상 상태 지문이 바뀌면 상단에 알리되
 *   **실행을 막지 않는다** (FR-GIT-178).
 */
class GitDialog {
  /**
   * 확인만 하는 다이얼로그는 `GitConfirm` 그 자체다 (FR-GIT-172) — 골격을 다시
   * 세울 것이 없으므로 그대로 넘긴다.
   */
  static confirm(o){return GitConfirm.open(o||{})}

  /**
   * open 은 골격을 세우고 사용자의 결정을 resolve 한다.
   *
   * `choices` 를 주면 고른 항목의 id 를, 그 밖에는 실행까지 끝났는지를 boolean
   * 으로 준다. `run` 은 `{ok:true}` 또는 `{ok:false,reason,stderrTail}` 를 준다.
   */
  static open(o){
    const d=o||{};
    // 파괴적 확인은 전문가에게 넘긴다 — 옵션 폼을 얹은 파괴적 동작은 아직 없다.
    if(d.destructive) return GitDialog.confirm(d);
    // 한 번에 하나다 — 겹치면 어느 대상의 다이얼로그인지 알 수 없다.
    if(GitDialog._cur) return Promise.resolve(GitDialog._safe(d));
    return new GitDialog(d)._show();
  }

  // 열지 못했을 때의 값은 안전한 쪽이다 (FR-GIT-97).
  static _safe(o){return (o.choices&&o.choices.length)?(o.def||''):false}

  /**
   * FR-GIT-178 의 상태 지문.
   *
   * 저장소 signature(index·HEAD·ref 의 mtime)와 **대상 파일들의 `xy` 조합**을
   * 함께 잡는다. 둘 중 하나만으로는 놓치는 것이 있다: signature 만 보면 분류가
   * 바뀐 것을 늦게 알고, `xy` 만 보면 이미 수정된 파일을 다시 고친 것을 못 본다.
   */
  static fingerprint(){
    const p=(window.app&&app.gitPanel)||null;
    if(!p) return '';
    const out=[p._lastSig||''];
    const s=(p.statusOf&&p.statusOf())||null;
    if(s){
      out.push(s.oid||'',s.branch||'');
      for(const g of GIT_DIALOG_FP_GROUPS)
        for(const e of (s[g]||[])) out.push(g+' '+(e.xy||'')+' '+e.path);
    }
    return out.join('\n');
  }

  /**
   * 폴링이 새 관측을 얻을 때마다 `GitPanel` 이 부른다. 열었을 때의 지문과
   * 달라졌으면 상단에 알린다 — **실행은 막지 않고 다시 열게 강제하지도 않는다.**
   */
  static notify(){
    const d=GitDialog._cur;
    if(!d||d.changed||!d._fp0) return;
    const fp=d._fingerprint();
    if(!fp||fp===d._fp0) return;
    d.changed=true; d._paint();
  }

  constructor(o){
    // id·클래스 접두는 흡수한 다이얼로그가 자기 것을 유지한다 — 공유하는 것은
    // 골격이고 이름은 각자의 것이다.
    this.id=o.id||GIT_DIALOG_ID;
    this.ns=o.ns||GIT_DIALOG_NS;
    this.action=o.action||'';
    this.title=o.title||'';
    this.body=o.body||'';
    // hidden 필드는 뜻이 없는 것이다 — 꺼진 채로 보이면 사용자가 켤 수 있다고 읽는다.
    this.fields=(Array.isArray(o.fields)?o.fields:[]).filter(f=>f&&!f.hidden);
    this.choices=Array.isArray(o.choices)?o.choices:[];
    this.def=o.def||((this.choices[0]||{}).id)||'';
    this.runLabel=o.runLabel||GIT_CONFIRM_RUN;
    this.focusKey=o.focus||'';
    // 모바일 판정은 호출자가 덮을 수 있다. 기본은 app.isMobile (FR-GIT-94).
    this.mobile=o.mobile===undefined?!!(window.app&&app.isMobile):!!o.mobile;
    this._check=typeof o.validate==='function'?o.validate:null;
    this._fpFn=typeof o.fingerprint==='function'?o.fingerprint:GitDialog.fingerprint;
    this.run=typeof o.run==='function'?o.run:null;
    this.why=''; this.whyKind='';
    this.busy=false; this.changed=false;
    this.err=null;   // {reason,tail}
    this._fp0=this._fingerprint();
  }

  _fingerprint(){return String(this._fpFn()||'')}

  // 왕복 중에 다이얼로그가 닫혔는지 — 뒤늦게 온 판정을 죽은 DOM 에 칠하지 않는다.
  alive(){return !!this.box}

  // 지금 옵션 값. 이름은 호출자가 정한 key 그대로다.
  values(){
    const v={};
    if(!this.box) return v;
    for(const i of this.box.querySelectorAll('.git-dialog-fields input')){
      const k=i.dataset.key;
      if(i.type==='checkbox') v[k]=i.checked;
      else if(i.type==='radio'){if(i.checked) v[k]=i.value}
      else v[k]=i.value;
    }
    return v;
  }

  /**
   * 실행을 막는 사유를 밖에서 세운다 (FR-GIT-159·167). 왕복이 필요한 검사가
   * 뒤늦게 판정을 물고 오는 경로다.
   */
  setWhy(kind,why){
    if(!this.box) return;
    this.whyKind=kind||''; this.why=why||'';
    this._paint();
  }

  _show(){
    this._build();
    GitDialog._cur=this;
    this._revalidate('');
    this._paint();
    this._focus();
    return new Promise(res=>{this._resolve=res});
  }

  _build(){
    const ns=this.ns;
    const ov=document.createElement('div');
    ov.id=this.id; ov.className='git-dialog '+ns+'-modal';
    ov.innerHTML=
      '<div class="git-dialog-box '+ns+'-box" role="dialog" aria-modal="true">'+
        '<div class="git-dialog-head '+ns+'-head"></div>'+
        // FR-GIT-178: 상단에 알린다.
        '<div class="git-dialog-changed"></div>'+
        '<div class="git-dialog-body '+ns+'-note"></div>'+
        '<div class="git-dialog-fields '+ns+'-fields"></div>'+
        '<div class="git-dialog-why '+ns+'-why"></div>'+
        '<div class="git-dialog-err '+ns+'-err">'+
          '<div class="git-dialog-err-reason"></div>'+
          '<pre class="git-dialog-err-tail"></pre>'+
          '<button type="button" class="git-dialog-copy"></button>'+
        '</div>'+
        '<div class="git-dialog-opts '+ns+'-opts"></div>'+
        // 실행 버튼은 옵션과 분리된 별도 행이다 (FR-GIT-94·177).
        '<div class="git-dialog-actions '+ns+'-actions">'+
          '<span class="git-dialog-progress '+ns+'-progress"></span>'+
          '<button type="button" class="git-dialog-cancel '+ns+'-cancel"></button>'+
          '<button type="button" class="git-dialog-go '+ns+'-go"></button>'+
        '</div>'+
      '</div>';
    document.body.appendChild(ov);
    this.ov=ov; this.box=ov.querySelector('.git-dialog-box');
    this.box.dataset.action=this.action;
    this._fieldsEl(this.box.querySelector('.git-dialog-fields'));
    this.box.querySelector('.git-dialog-copy').addEventListener('click',()=>
      this._copy((this.err&&this.err.tail)||''));
    // 선택지와 실행/취소는 배타다 — 쓰지 않는 행은 자리도 남기지 않는다.
    if(this.choices.length){
      this.box.querySelector('.git-dialog-actions').remove();
      this._optsEl(this.box.querySelector('.git-dialog-opts'));
    }else{
      this.box.querySelector('.git-dialog-opts').remove();
      this.box.querySelector('.git-dialog-cancel').addEventListener('click',()=>this._cancel());
      this.box.querySelector('.git-dialog-go').addEventListener('click',()=>this._run());
    }
    this._key=e=>{
      if(e.key!=='Enter'&&e.key!=='Escape') return;
      e.preventDefault(); e.stopPropagation();
      // 실행 중에는 버튼이 disable 이다 — 키도 같이 막는다 (FR-GIT-174).
      if(this.busy) return;
      if(e.key==='Escape'){this._cancel();return}
      // Enter 는 기본 동작이다 (FR-GIT-176). 선택 다이얼로그의 기본 동작은 기본
      // 선택이고 그것은 안전한 쪽이다 (O14).
      if(this.choices.length){this._pick(this.def);return}
      this._run();
    };
    document.addEventListener('keydown',this._key,true);
  }

  _fieldsEl(host){
    for(const f of this.fields) host.appendChild(this._fieldEl(f));
  }

  /**
   * 필드 하나. 종류는 텍스트·체크박스·라디오 셋뿐이고 **자격증명을 받는 종류는
   * 없다** (FR-GIT-104) — 만들지 않는 것이 유일한 보장이다.
   */
  _fieldEl(f){
    const d=document.createElement('div');
    d.className='git-dialog-field '+this.ns+'-field'+(f.fieldCls?' '+f.fieldCls:'');
    d.dataset.key=f.key;
    if(f.type===GIT_DIALOG_CHECK){
      // 기본은 꺼짐이다 (FR-GIT-173).
      d.appendChild(this._rowEl(f,'checkbox','',f.label,false));
      return d;
    }
    if(f.type===GIT_DIALOG_RADIO){
      if(f.label) d.appendChild(this._labelEl(f.label));
      const opts=Array.isArray(f.opts)?f.opts:[];
      // 첫 선택지가 기본이고 그것이 안전한 쪽이다 (FR-GIT-173).
      for(let i=0;i<opts.length;i++)
        d.appendChild(this._rowEl(f,'radio',opts[i].v,opts[i].label,i===0));
      return d;
    }
    if(f.label) d.appendChild(this._labelEl(f.label));
    const i=document.createElement('input');
    i.type='text';
    i.className='git-dialog-input'+(f.cls?' '+f.cls:'');
    i.dataset.key=f.key;
    i.value=f.value||''; i.placeholder=f.placeholder||'';
    i.addEventListener('input',()=>this._changed(f.key));
    d.appendChild(i);
    return d;
  }

  _labelEl(text){
    const l=document.createElement('div');
    l.className='git-dialog-label '+this.ns+'-label';
    l.textContent=text;
    return l;
  }

  _rowEl(f,type,value,label,on){
    const l=document.createElement('label');
    l.className='git-dialog-row '+this.ns+'-row';
    const i=document.createElement('input');
    i.type=type; i.dataset.key=f.key; i.value=value; i.checked=!!on;
    if(f.cls) i.className=f.cls;
    if(type==='radio') i.name=this.ns+'-'+f.key;
    i.addEventListener('change',()=>this._changed(f.key));
    const s=document.createElement('span');
    s.textContent=label||'';
    l.appendChild(i); l.appendChild(s);
    return l;
  }

  // 기본 선택은 제시 순서와 별개다 — 포커스가 그것을 가리킨다 (O14).
  _optsEl(host){
    for(const o of this.choices){
      const b=document.createElement('button');
      b.type='button';
      b.className='git-dialog-opt '+this.ns+'-opt'+(o.danger?' danger':'');
      b.dataset.opt=o.id;
      b.textContent=o.label||o.id;
      b.addEventListener('click',()=>this._pick(o.id));
      host.appendChild(b);
      if(o.id===this.def) this._defBtn=b;
    }
  }

  _changed(key){
    this._revalidate(key);
    this._paint();
  }

  /**
   * 사유는 호출자가 판정한다. 문자열이면 그대로 사유이고, `{kind,why}` 면 kind 가
   * `data-why` 로 남는다 — 규칙 위반과 "이미 있음" 은 사용자가 할 일이 다르므로
   * 구분되어야 한다 (계약 §1.2.1).
   */
  _revalidate(key){
    if(!this._check) return;
    const r=this._check(this.values(),this,key||'');
    if(typeof r==='string'){
      this.whyKind=r?GIT_DIALOG_WHY:''; this.why=r;
      return;
    }
    this.whyKind=(r&&r.kind)||''; this.why=(r&&r.why)||'';
  }

  _paint(){
    const b=this.box; if(!b) return;
    b.classList.toggle('mobile',this.mobile);
    b.querySelector('.git-dialog-head').textContent=this.title;
    const ch=b.querySelector('.git-dialog-changed');
    ch.textContent=this.changed?GIT_CONFIRM_CHANGED:'';
    ch.classList.toggle('vis',this.changed);
    const bd=b.querySelector('.git-dialog-body');
    bd.textContent=this.body;
    bd.classList.toggle('vis',!!this.body);
    // pending 은 사유가 없다 — 검사 중임을 문구로 떠들지 않고 실행만 막는다.
    const w=b.querySelector('.git-dialog-why');
    w.textContent=this.why;
    w.dataset.why=this.whyKind===GIT_DIALOG_WHY_PENDING?'':this.whyKind;
    w.classList.toggle('vis',!!this.why);
    // FR-GIT-175: 사유와 stderr tail 을 남기고 닫지 않는다.
    const err=b.querySelector('.git-dialog-err');
    err.classList.toggle('vis',!!this.err);
    err.querySelector('.git-dialog-err-reason').textContent=(this.err&&this.err.reason)||'';
    const tail=err.querySelector('.git-dialog-err-tail');
    tail.textContent=(this.err&&this.err.tail)||'';
    tail.classList.toggle('vis',!!tail.textContent);
    err.querySelector('.git-dialog-copy').textContent=GIT_CONFIRM_COPY;
    // FR-GIT-174: 실행 중에는 진행을 보이고 옵션·버튼을 전부 막는다.
    for(const i of b.querySelectorAll('.git-dialog-fields input')) i.disabled=this.busy;
    const go=b.querySelector('.git-dialog-go');
    if(!go) return;
    b.querySelector('.git-dialog-progress').textContent=this.busy?GIT_CONFIRM_RUNNING:'';
    const cancel=b.querySelector('.git-dialog-cancel');
    cancel.textContent=GIT_CONFIRM_CANCEL;
    go.textContent=this.runLabel;
    cancel.disabled=this.busy;
    go.disabled=this.busy||!!this.whyKind;
  }

  // 텍스트 필드가 있으면 그것이 첫 입력 자리다. 그 밖에는 취소에 둔다 (FR-GIT-173).
  _focus(){
    if(this._defBtn){this._defBtn.focus();return}
    const b=this.box;
    const f=this.focusKey&&
      b.querySelector('.git-dialog-fields input[data-key="'+this.focusKey+'"]');
    if(f){f.focus();return}
    const c=b.querySelector('.git-dialog-cancel');
    if(c) c.focus();
  }

  async _run(){
    // 중복 실행 차단 (FR-GIT-174). 사유가 있으면 실행 자체가 열려 있지 않다.
    if(this.busy||this.whyKind||!this.run) return;
    const v=this.values();
    this.busy=true; this.err=null; this._paint();
    let res=null;
    try{res=await this.run(v,this)}catch(e){res={ok:false,reason:String(e)}}
    this.busy=false;
    if(res&&res.ok){this._close(true);return}
    this.err={reason:(res&&res.reason)||GIT_CONFIRM_FAIL,tail:(res&&res.stderrTail)||''};
    this._paint();
    this._focus();
  }

  _pick(id){this._close(id||'')}

  _cancel(){this._close(this.choices.length?this.def:false)}

  _close(v){
    document.removeEventListener('keydown',this._key,true);
    if(this.ov) this.ov.remove();
    this.ov=null; this.box=null; this._defBtn=null;
    if(GitDialog._cur===this) GitDialog._cur=null;
    const r=this._resolve; this._resolve=null;
    if(r) r(this.choices.length?String(v||''):!!v);
  }

  // 클립보드 접근이 막힌 환경에서도 동작해야 한다 — GitConfirm 과 같은 방식이다.
  _copy(text){
    if(!text) return;
    const ta=document.createElement('textarea');
    ta.value=text; ta.style.cssText='position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    try{document.execCommand('copy')}catch{}
    ta.remove();
  }
}

GitDialog._cur=null;

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — 다른 파일과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitDialog=GitDialog;
