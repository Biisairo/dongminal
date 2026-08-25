/**
 * Dongminal — Changes 탭의 커밋 영역 (GIT_SRS §3A.2 / FR-GIT-74~85)
 *
 * 5단계가 세운 `.git-commit` 자리를 살린다. **파일 목록 스크롤과 독립된 고정
 * 영역**이라는 성질(FR-GIT-39)은 5단계의 flex 구조가 보장하므로 여기서는 그
 * 안쪽만 채운다.
 *
 * 폴링은 초당 한 번 `paint` 를 부른다. 그래서 **입력값을 paint 가 건드리지
 * 않는다** — 사용자가 타이핑하는 중에 값이 되돌아가면 안 된다. 값을 바꾸는 것은
 * 리포 전환·amend 토글·커밋 성공·undo 뿐이다.
 *
 * 옵션(sign-off / no-verify / commit all)은 기억하지 않는다 (FR-GIT-79) —
 * no-verify 가 기억되면 훅이 조용히 계속 꺼진다.
 */
class GitCommit {
  constructor(panel){
    this.panel=panel;
    this.app=panel.app;
    this._el=null;
    this._msg=null;
    this._repo=null;      // 화면에 채워 둔 리포. 바뀌면 전부 되돌린다
    this._pf=null;        // /api/git/preflight 의 응답 (template·gpgSign·warnings)
    this._pfRepo=null;
    this._st=null;        // 마지막 status. 비활성 사유 판정이 딛는다 (FR-GIT-84)
    this._amend=false;
    this._stash=null;     // amend 를 켤 때 보관한 draft (FR-GIT-78)
    this._opts={signoff:false,noVerify:false,all:false};
    this._menuOpen=false;
    this._blocks=null;    // 409 preflight_blocked 의 blocks (FR-GIT-88)
    this._err=null;
    this._busy=false;
    this._saveT=null;     // draft 디바운스
    this._undo=null;      // {repo,token,el,timer}
    this._tmplRepo=null;  // template 을 이미 채운 리포 (FR-GIT-76)
    this._h=undefined;    // 경계 드래그로 정한 높이 (기기별)
  }

  // 골격은 `.git-commit` 이 다시 만들어질 때마다 한 번 세운다. 리스너도 그때
  // 한 번만 붙는다 — paint 는 칠하기만 한다.
  mount(el){
    if(!el) return;
    this._el=el;
    el.innerHTML=
      '<div class="git-commit-main">'+
        '<textarea class="git-commit-msg"></textarea>'+
        '<div class="git-commit-side">'+
          '<label class="git-commit-amend"><input type="checkbox"><span></span></label>'+
          '<span class="git-commit-gpg"></span>'+
          '<div class="git-commit-go">'+
            '<button class="git-commit-btn"></button>'+
            '<button class="git-commit-more"></button>'+
            '<div class="git-commit-menu"></div>'+
          '</div>'+
        '</div>'+
      '</div>'+
      '<div class="git-commit-why"></div>'+
      '<div class="git-preflight"></div>'+
      '<div class="git-commit-resize"></div>';
    this._msg=el.querySelector('.git-commit-msg');
    this._msg.placeholder=GIT_COMMIT_PLACEHOLDER;
    el.querySelector('.git-commit-amend span').textContent=GIT_COMMIT_AMEND;
    el.querySelector('.git-commit-btn').textContent=GIT_COMMIT_BTN;
    el.querySelector('.git-commit-more').textContent=GIT_COMMIT_MORE;
    const menu=el.querySelector('.git-commit-menu');
    for(const o of GIT_COMMIT_OPTS){
      const lab=document.createElement('label');
      lab.className='git-commit-opt'; lab.dataset.opt=o.key;
      const i=document.createElement('input'); i.type='checkbox';
      const s=document.createElement('span'); s.textContent=o.label;
      i.addEventListener('change',()=>{this._opts[o.key]=i.checked;this._paint()});
      lab.appendChild(i); lab.appendChild(s); menu.appendChild(lab);
    }
    this._msg.addEventListener('input',()=>this._input());
    el.querySelector('.git-commit-amend input')
      .addEventListener('change',ev=>this._amendToggle(ev.target.checked));
    el.querySelector('.git-commit-btn').addEventListener('click',()=>this._commit());
    el.querySelector('.git-commit-more').addEventListener('click',()=>{
      this._menuOpen=!this._menuOpen; this._paint();
    });
    el.querySelector('.git-commit-resize').addEventListener('mousedown',ev=>this._drag(ev));
    // 골격이 새로 세워졌으므로 다음 paint 가 리포 상태를 다시 채워야 한다.
    this._repo=null;
  }

  // 리포가 없어 `.git-commit` 자체가 사라진 경우. 인스턴스는 살아 있다 — 리포는
  // 다시 선택될 수 있다.
  unmount(){
    this._el=null; this._msg=null; this._repo=null;
    this._undoHide();
  }

  paint(st){
    if(!this._el||!this._msg) return;
    this._st=st;
    const repo=this.panel.repo;
    if(repo!==this._repo) this._reset(repo);
    this._paint();
  }

  // ── 값과 draft (FR-GIT-75, O6) ──

  // draft 는 ws.git.drafts[<repo>] 다. **git 객체를 통째로 갈아치우지 않는다** —
  // git.pinned 는 서버가 권위로 쓰므로 그것을 지우면 핀이 사라진다 (O1).
  _drafts(){
    const ws=this.app.ws;
    if(!ws.git) ws.git={};
    if(!ws.git.drafts||typeof ws.git.drafts!=='object') ws.git.drafts={};
    return ws.git.drafts;
  }

  _draftGet(repo){
    const g=this.app.ws.git;
    const d=g&&g.drafts;
    return (d&&typeof d[repo]==='string')?d[repo]:'';
  }

  _draftSet(repo,v){
    if(!repo) return;
    const d=this._drafts();
    if(v) d[repo]=v; else delete d[repo];
    this.app._save();
  }

  _setValue(v){
    this._msg.value=v||'';
    this._grow();
  }

  _input(){
    this._grow();
    this._err=null;
    // 입력이 있으면 앞선 차단 표시는 낡은 것이다 — 다음 시도가 다시 채운다.
    this._blocks=null;
    const repo=this._repo,v=this._msg.value;
    if(this._saveT) clearTimeout(this._saveT);
    // 입력이 멈춘 뒤에 저장한다 — 키 하나마다 PUT 을 보내지 않는다.
    this._saveT=setTimeout(()=>{this._saveT=null;this._draftSet(repo,v)},GIT_COMMIT_DRAFT_DEBOUNCE_MS);
    this._paint();
  }

  _reset(repo){
    this._repo=repo;
    this._amend=false; this._stash=null;
    this._opts={signoff:false,noVerify:false,all:false};
    this._menuOpen=false; this._blocks=null; this._err=null; this._busy=false;
    if(this._saveT){clearTimeout(this._saveT);this._saveT=null}
    // 앞선 리포의 undo 진입점을 새 리포의 화면에 남기지 않는다.
    this._undoHide();
    this._pf=null; this._pfRepo=null;
    this._setValue(repo?this._draftGet(repo):'');
    if(repo) this._loadPreflight(repo);
  }

  // ── 높이 (FR-GIT-74) ──

  // 경계 드래그로 정한 높이는 기기별 취향이라 localStorage 에 남는다. 0 이면
  // 기본 줄 수를 쓴다.
  _height(){
    if(this._h===undefined){
      let v=null; try{v=localStorage.getItem(GIT_COMMIT_HEIGHT_KEY)}catch{}
      const n=parseInt(v,10);
      this._h=(Number.isFinite(n)&&n>0)?n:0;
    }
    return this._h;
  }

  // box-sizing 이 border-box 이므로 높이에 여백과 테두리가 포함된다.
  _rowsPx(n){
    const cs=getComputedStyle(this._msg);
    const lh=parseFloat(cs.lineHeight)||GIT_COMMIT_LINE_PX;
    const pad=(parseFloat(cs.paddingTop)||0)+(parseFloat(cs.paddingBottom)||0);
    return Math.round(n*lh+pad+this._borderPx());
  }

  _borderPx(){
    const cs=getComputedStyle(this._msg);
    if(cs.boxSizing!=='border-box') return 0;
    return (parseFloat(cs.borderTopWidth)||0)+(parseFloat(cs.borderBottomWidth)||0);
  }

  // 입력마다 내용 높이로 맞추고 상한을 넘으면 내부 스크롤로 넘긴다 (FR-GIT-74).
  // 드래그로 정한 높이는 하한이 된다 — 사용자가 정한 크기가 입력 때문에 줄지 않는다.
  _grow(){
    const ta=this._msg; if(!ta) return;
    const base=this._height()||this._rowsPx(GIT_COMMIT_ROWS);
    const max=Math.max(base,this._rowsPx(GIT_COMMIT_MAX_ROWS));
    ta.style.height='0px';
    const need=ta.scrollHeight+this._borderPx();
    ta.style.height=Math.max(base,Math.min(need,max))+'px';
  }

  _drag(ev){
    ev.preventDefault();
    const ta=this._msg;
    const y0=ev.clientY,h0=ta.getBoundingClientRect().height;
    const min=this._rowsPx(1);
    const move=e=>{
      this._h=Math.round(Math.max(min,h0+(e.clientY-y0)));
      ta.style.height=this._h+'px';
    };
    const up=()=>{
      document.removeEventListener('mousemove',move,true);
      document.removeEventListener('mouseup',up,true);
      try{localStorage.setItem(GIT_COMMIT_HEIGHT_KEY,String(this._height()))}catch{}
      this._grow();
    };
    document.addEventListener('mousemove',move,true);
    document.addEventListener('mouseup',up,true);
  }

  // ── preflight (FR-GIT-76·85·87) ──

  // 커밋 차단은 서버가 커밋 시점에 다시 판정한다 (FR-GIT-86). 이 조회는 화면에
  // 필요한 것 — template·서명 표시·detached 경고 — 을 얻기 위한 것이다.
  async _loadPreflight(repo){
    let r=null,d=null;
    try{r=await fetch('/api/git/preflight?repo='+encodeURIComponent(repo))}catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    if(!d||!d.preflight||d.requested!==repo||this.panel.repo!==repo) return;
    this._pf=d.preflight; this._pfRepo=repo;
    this._applyTemplate(repo);
    this._paint();
  }

  // draft 가 있으면 덮지 않는다 (FR-GIT-76). 한 리포에 한 번만 채운다 — 지운
  // 템플릿이 다음 폴링에 되살아나면 지울 수 없다.
  _applyTemplate(repo){
    if(this._tmplRepo===repo) return;
    const t=(this._pf&&this._pf.template)||'';
    if(!t||this._msg.value||this._draftGet(repo)) return;
    this._tmplRepo=repo;
    this._setValue(t);
  }

  _warning(code){
    const ws=(this._pfRepo===this._repo&&this._pf&&this._pf.warnings)||[];
    return ws.find(w=>w&&w.code===code)||null;
  }

  // ── 칠하기 ──

  _paint(){
    const el=this._el; if(!el) return;
    const pf=this._pfRepo===this._repo?this._pf:null;
    this._msg.disabled=!this._repo;
    const gpg=el.querySelector('.git-commit-gpg');
    const sign=!!(pf&&pf.gpgSign);
    gpg.textContent=sign?GIT_COMMIT_GPG:'';
    gpg.classList.toggle('vis',sign);
    el.querySelector('.git-commit-amend input').checked=this._amend;
    for(const o of GIT_COMMIT_OPTS){
      const i=el.querySelector('.git-commit-opt[data-opt="'+o.key+'"] input');
      if(i) i.checked=!!this._opts[o.key];
    }
    el.querySelector('.git-commit-menu').classList.toggle('vis',this._menuOpen);
    el.querySelector('.git-commit-more').classList.toggle('active',this._menuOpen);
    // 왜 못 누르는지 보인다 (FR-GIT-84). 버튼 옆 한 줄과 title 둘로 알린다.
    const why=this._why();
    const btn=el.querySelector('.git-commit-btn');
    btn.disabled=!!why||this._busy;
    btn.title=why||'';
    const w=el.querySelector('.git-commit-why');
    w.textContent=this._busy?GIT_COMMIT_RUNNING:(this._err||why||'');
    w.classList.toggle('vis',!!w.textContent);
    w.classList.toggle('err',!this._busy&&!!this._err);
    this._paintBlocks();
  }

  _why(){
    if(!this._repo) return GIT_NO_REPO_HINT;
    if(!this._msg.value.trim()) return GIT_COMMIT_WHY_EMPTY;
    // 서버와 같은 판정이다 — `-a` 는 tracked 변경을 스스로 담으므로 staged 가
    // 없어도 커밋할 것이 있다 (FR-GIT-84).
    const staged=(this._st&&this._st.staged&&this._st.staged.length)||0;
    if(!staged&&!this._opts.all) return GIT_COMMIT_WHY_NOTHING;
    return '';
  }

  // 차단 사유는 **무엇이 왜 막혔고 어떻게 푸는지**를 함께 보인다 (FR-GIT-88).
  // Fix 는 복사할 수 있다 — 옮겨 적게 하지 않는다.
  _paintBlocks(){
    const box=this._el.querySelector('.git-preflight');
    const blocks=this._blocks||[];
    box.classList.toggle('vis',!!blocks.length);
    const sig=blocks.map(b=>b&&b.code).join(',');
    if(box.dataset.sig===sig) return;
    box.dataset.sig=sig;
    box.innerHTML='';
    if(!blocks.length) return;
    const h=document.createElement('div');
    h.className='git-preflight-head'; h.textContent=GIT_PREFLIGHT_TITLE;
    box.appendChild(h);
    for(const b of blocks){
      const d=document.createElement('div');
      d.className='git-preflight-block'; d.dataset.code=(b&&b.code)||'';
      const r=document.createElement('div');
      r.className='git-preflight-reason'; r.textContent=(b&&b.reason)||'';
      const f=document.createElement('div'); f.className='git-preflight-fix';
      const lab=document.createElement('span');
      lab.className='git-preflight-fix-label'; lab.textContent=GIT_PREFLIGHT_FIX;
      const code=document.createElement('code');
      code.className='git-preflight-cmd'; code.textContent=(b&&b.fix)||'';
      const cp=document.createElement('button');
      cp.className='git-preflight-copy'; cp.textContent=GIT_PREFLIGHT_COPY;
      cp.addEventListener('click',()=>this.panel.copyText((b&&b.fix)||''));
      f.appendChild(lab); f.appendChild(code); f.appendChild(cp);
      d.appendChild(r); d.appendChild(f);
      box.appendChild(d);
    }
  }

  // ── amend (FR-GIT-78) ──

  async _amendToggle(on){
    const repo=this._repo;
    this._amend=!!on;
    this._err=null;
    if(!repo){this._paint();return}
    if(this._amend){
      this._stash=this._msg.value;
      const msg=await this._lastMessage(repo);
      // 왕복 중에 리포가 바뀌거나 토글이 꺼졌으면 그 결과는 버린다.
      if(this._repo!==repo||!this._amend) return;
      this._setValue(msg===null?this._stash:msg);
    }else{
      // 켤 때 보관한 것을 그대로 되돌린다. 왕복이 손실 없어야 한다 (검증 V33).
      this._setValue(this._stash||'');
      this._stash=null;
    }
    this._paint();
  }

  // 직전 커밋 메시지. 전용 진입점이 없으므로 커밋 상세의 body 를 쓴다
  // (FR-GIT-136). 커밋이 없는 저장소에서는 null 이다 — amend 할 것이 없다.
  async _lastMessage(repo){
    let r=null,d=null;
    try{r=await fetch('/api/git/commit?repo='+encodeURIComponent(repo)+'&oid=HEAD')}catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    if(!d||typeof d.body!=='string') return null;
    if(d.requested&&d.requested.repo!==repo) return null;
    return d.body.replace(/\n+$/,'');
  }

  // ── 커밋 (FR-GIT-77·79·80·87·88) ──

  async _commit(){
    if(this._busy) return;
    const repo=this._repo; if(!repo) return;
    const msg=this._msg.value;
    if(this._why()) return;
    // 경고 판정은 preflight 에 의존한다. **아직 오지 않았으면 기다린다** —
    // 창을 열고 바로 커밋하면 preflight 가 도착하기 전이라 detached 경고 없이
    // 커밋된다 (FR-GIT-87). 서버는 detached 를 막지 않으므로(그것이 옳다) 이
    // 경고를 보장하는 것은 여기뿐이다.
    if(this._pfRepo!==repo){
      await this._loadPreflight(repo);
      if(this._repo!==repo||this._busy) return;
    }
    // detached 는 막지 않되 결과를 명시적으로 경고한다 (FR-GIT-87). 파괴적이
    // 아니므로 1단계 확인이다.
    const det=this._warning(GIT_WARN_DETACHED);
    if(det){
      const ok=await GitConfirm.open({
        action:GIT_ACT_DETACHED,title:GIT_DETACHED_TITLE,targets:[det.reason||''],
        hint:{note:GIT_DETACHED_NOTE,command:'git switch -c <새 브랜치>'},
        stages:1,
      });
      if(!ok||this._repo!==repo) return;
    }
    this._busy=true; this._blocks=null; this._err=null; this._paint();
    const res=await this.panel.post('/api/git/commit',{
      repo,message:msg,amend:this._amend,
      signoff:this._opts.signoff,noVerify:this._opts.noVerify,all:this._opts.all,
    });
    this._busy=false;
    if(this._repo!==repo){this._paint();return}
    const d=res.data||{};
    if(d.error===GIT_ERR_PREFLIGHT){
      this._blocks=(d.preflight&&d.preflight.blocks)||[];
      this._paint(); return;
    }
    if(!res.ok){
      this._err=this.panel.writeError(res);
      this.panel.applyWriteFail(res);
      this._paint(); return;
    }
    // FR-GIT-80: 상태를 갱신하고 입력을 비운다. draft 도 함께 지운다.
    this.panel.adopt(d);
    if(this._saveT){clearTimeout(this._saveT);this._saveT=null}
    this._setValue('');
    this._draftSet(repo,'');
    this._amend=false; this._stash=null; this._tmplRepo=repo;
    // 옵션을 기억하지 않는다 (FR-GIT-79) — 다음 커밋이 조용히 훅을 끄지 않는다.
    this._opts={signoff:false,noVerify:false,all:false};
    this._menuOpen=false;
    this._undoShow(repo,d.undoToken);
    this._paint();
  }

  // ── undo 토스트 (FR-GIT-81·82·83, O7) ──

  // 5초 뒤 진입점이 DOM 에서 사라진다. 서버 토큰도 같은 순간 만료되므로 두 겹으로
  // 막힌다 — 탭을 멈춰 두어도 만료된 undo 는 실행되지 않는다.
  _undoShow(repo,token){
    this._undoHide();
    if(!token) return;
    const t=document.createElement('div');
    t.className='git-undo-toast'; t.id='git-undo';
    const s=document.createElement('span');
    s.className='git-undo-text'; s.textContent=GIT_UNDO_TEXT;
    const b=document.createElement('button');
    b.className='git-undo-btn'; b.textContent=GIT_UNDO_LABEL;
    b.addEventListener('click',()=>this._undoRun());
    t.appendChild(s); t.appendChild(b);
    document.body.appendChild(t);
    this._undo={repo,token,el:t,timer:setTimeout(()=>this._undoHide(),GIT_UNDO_MS)};
  }

  _undoHide(){
    const u=this._undo; if(!u) return;
    this._undo=null;
    clearTimeout(u.timer);
    if(u.el) u.el.remove();
  }

  async _undoRun(){
    const u=this._undo; if(!u) return;
    // 진입점을 먼저 없앤다 — 한 번의 커밋에 한 번의 undo 다.
    this._undoHide();
    const res=await this.panel.post('/api/git/undo-last',{repo:u.repo,undoToken:u.token});
    const d=res.data||{};
    if(!res.ok){
      this._err=d.error===GIT_ERR_UNDO_EXPIRED?GIT_UNDO_FAIL:this.panel.writeError(res);
      this._paint(); return;
    }
    this.panel.adopt(d);
    // 메시지를 커밋 직전으로 되돌린다 (FR-GIT-82).
    if(u.repo===this._repo){
      this._setValue(d.message||'');
      this._draftSet(u.repo,this._msg.value);
    }
    this._paint();
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitCommit=GitCommit;
