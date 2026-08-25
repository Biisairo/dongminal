/**
 * Dongminal — Git 창의 표면 (GIT_SRS §3.4)
 *
 * Git 창은 워크스페이스에 하나이므로(FR-GIT-26) 이 객체도 앱에 하나다. 고정 탭
 * 6개는 각자 루트 DOM 을 갖고, 활성 탭의 루트만 pane 본문에 붙는다.
 *
 * 활성 리포가 바뀌면 진행 중인 응답은 전부 버린다 (FR-GIT-16). 세대 카운터
 * 하나로 판정한다 — 나중에 비동기 경로를 하나씩 훑어 가드를 덧붙이는 상황을
 * 만들지 않으려고 처음부터 둔다.
 */
class GitPanel {
  constructor(app){
    this.app=app;
    this._els=new Map(); // view key → 루트 DOM
    this._gen=0;
    this._status=null;   // /api/git/status 의 마지막 유효 응답
    this._lastSig=null;  // FR-GIT-19 의 비교 대상
    this._errMsg=null;
    this._staleNote=false;
    this._gitMissing=false;
    this._collapsed=new Set();    // 접힌 그룹. 뷰의 성질이라 리포 전환에도 남는다
    this._dirCollapsed=new Set(); // 접힌 트리 디렉터리 (group:path)
    this._shown=new Map();        // 그룹별로 그린 행 수 (FR-GIT-42)
    this._fileView=null;          // 'flat' | 'tree'
    this._seq=0;                  // status 요청 일련번호 (single-flight 소유권)
    this.previewFile=null;        // {repo,group,axis,path,origPath} — 7단계가 읽는다
  }

  // 활성 리포. Git 창의 win.git.repo 가 진실이고 이것은 그 읽기다 (FR-GIT-29).
  get repo(){
    const w=this.app._gitWindow();
    return (w&&w.git&&w.git.repo)||null;
  }

  setRepo(path){
    const w=this.app._gitWindow(); if(!w) return;
    if(!w.git) w.git={repo:null};
    if(w.git.repo===path) return;
    w.git.repo=path;
    this._gen++;
    // 이전 리포의 목록이 새 리포의 헤더와 함께 보이는 순간이 있어서는 안 된다
    // (FR-GIT-16). 화면을 "불러오는 중" 으로 되돌린다.
    this._status=null; this._lastSig=null; this._staleNote=false;
    this._shown.clear(); this.previewFile=null; this._closeCtx();
    if(path) this._errMsg=null;
    // 진행 중인 요청의 소유권을 끊는다 — 그 응답은 가드에 걸려 버려지고, 새 리포는
    // 앞선 요청이 끝나기를 기다리지 않는다.
    this._seq++; this._busy=false; this._again=false; this._sigBusy=false;
    if(this._sigT){clearTimeout(this._sigT);this._sigT=null}
    for(const v of GIT_VIEWS) if(this._els.has(v.key)) this._render(v.key);
    this._stop(); this._reschedule();
    // 활성 리포는 창에 붙어 영속한다 (FR-GIT-29). switchWindow 가 이미 활성인
    // 창에서는 조기 반환하므로 여기서 직접 저장한다 — 저장을 그쪽에 맡기면
    // "같은 창에서 리포만 바꾼" 경우가 새로고침에서 사라진다.
    this.app._save();
  }

  elFor(view){
    let el=this._els.get(view);
    if(!el){
      el=document.createElement('div');
      el.className='git-view git-'+view;
      this._els.set(view,el);
      this._render(view);
    }
    return el;
  }

  // Git 창이 사라졌을 때 루트를 area 로 되돌린다. 인스턴스는 살아 있다 —
  // 창은 다시 열릴 수 있다.
  detach(){
    this._stop(); this._closeCtx();
    const area=document.getElementById('area');
    for(const el of this._els.values()){
      el.classList.remove('vis');
      if(area) area.appendChild(el);
    }
  }

  // ── stale 가드 (FR-GIT-16) ──
  token(){return {gen:this._gen,repo:this.repo}}
  isStale(tok){return !tok||tok.gen!==this._gen||tok.repo!==this.repo}

  // 5단계는 changes 를 채운다. diff 는 7단계가 채운다.
  _render(view){
    const el=this._els.get(view); if(!el) return;
    const def=GIT_VIEWS.find(v=>v.key===view);
    if(def&&def.pending){
      el.innerHTML='';
      const d=document.createElement('div'); d.className='git-pending';
      d.innerHTML='<div class="git-pending-name"></div><div class="git-pending-hint"></div>';
      d.querySelector('.git-pending-name').textContent=def.name;
      d.querySelector('.git-pending-hint').textContent=GIT_PENDING_HINT;
      el.appendChild(d);
      return;
    }
    if(view==='changes'){this._renderChanges(el);return}
    el.innerHTML='';
    if(!this.repo){
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=GIT_NO_REPO_HINT;
      el.appendChild(d);
    }
  }

  // ── Changes 탭 (FR-GIT-32~42) ──

  // 골격은 한 번만 세우고 이후에는 칠하기만 한다 — 폴링마다 DOM 을 다시 만들면
  // 스크롤 위치와 선택이 날아간다.
  _renderChanges(el){
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1') this._buildChanges(el);
    this._paintChanges(el);
  }

  _paint(){
    const el=this._els.get('changes'); if(!el) return;
    this._renderChanges(el);
  }

  // FR-GIT-39: .git-head·.git-commit 은 flex:0 0 auto 이고 목록 스크롤은
  // .git-files 안에서만 일어난다. 커밋 영역이 목록과 함께 스크롤되면 요구사항
  // 실패다 — 구조가 그것을 보장한다.
  _buildChanges(el){
    el.innerHTML=
      '<div class="git-head">'+
        '<span class="git-head-repo"></span><span class="git-head-branch"></span>'+
        '<span class="git-head-badges"></span><span class="git-head-ab"></span>'+
        '<span class="git-head-spacer"></span>'+
        '<span class="git-head-remote">'+
          '<button class="git-remote-btn" data-remote="fetch" disabled>Fetch</button>'+
          '<button class="git-remote-btn" data-remote="pull" disabled>Pull</button>'+
          '<button class="git-remote-btn" data-remote="push" disabled>Push</button>'+
        '</span>'+
      '</div>'+
      '<div class="git-commit">'+
        '<textarea class="git-commit-msg" disabled></textarea>'+
        '<div class="git-commit-side">'+
          '<label class="git-commit-amend"><input type="checkbox" disabled>amend</label>'+
          '<button class="git-commit-btn" disabled>Commit ▾</button>'+
        '</div>'+
      '</div>'+
      '<div class="git-stale-note"></div>'+
      '<div class="git-changes-body">'+
        '<div class="git-files">'+
          '<div class="git-files-bar">'+
            '<button class="git-files-mode" data-mode="tree">트리</button>'+
            '<button class="git-files-mode" data-mode="flat">플랫</button>'+
          '</div>'+
        '</div>'+
        '<div class="git-preview"></div>'+
      '</div>';
    for(const b of el.querySelectorAll('.git-remote-btn')) b.title=GIT_REMOTE_HINT;
    const msg=el.querySelector('.git-commit-msg');
    msg.placeholder=GIT_COMMIT_HINT; msg.title=GIT_COMMIT_HINT;
    el.querySelector('.git-commit-btn').title=GIT_COMMIT_HINT;
    const files=el.querySelector('.git-files');
    for(const g of GIT_GROUPS){
      const d=document.createElement('div'); d.className='git-group'; d.dataset.group=g.key;
      d.innerHTML='<div class="git-group-head"><span class="git-group-caret"></span>'+
        '<span class="git-group-name"></span><span class="git-group-count"></span></div>'+
        '<div class="git-group-rows"></div>';
      d.querySelector('.git-group-name').textContent=g.name;
      d.querySelector('.git-group-head').addEventListener('click',()=>this._toggleGroup(g.key));
      files.appendChild(d);
    }
    for(const b of el.querySelectorAll('.git-files-mode'))
      b.addEventListener('click',()=>this._setFileView(b.dataset.mode));
    // FR-GIT-42: 목록 끝이 보일 때마다 다음 덩어리를 이어 그린다.
    if(this._io) this._io.disconnect();
    if(typeof IntersectionObserver!=='undefined'){
      this._io=new IntersectionObserver(es=>{
        for(const e of es) if(e.isIntersecting) this._growGroup(e.target.dataset.group);
      },{root:files});
    }
    el.dataset.built='1';
  }

  _paintChanges(el){
    const s=this._status&&this._status.status;
    this._paintHead(el,s);
    const note=el.querySelector('.git-stale-note');
    const loading=!s&&!this._errMsg&&!this._staleNote;
    note.textContent=this._errMsg||(this._staleNote?GIT_STALE_NOTE:(loading?GIT_LOADING_HINT:''));
    note.classList.toggle('vis',!!note.textContent);
    // 아직 불러오는 중인 것은 오류가 아니다 — 같은 자리에 다른 색으로 알린다.
    note.classList.toggle('loading',loading);
    for(const g of GIT_GROUPS) this._paintGroup(el,g,(s&&s[g.key])||[]);
    this._paintMode(el);
    this._paintPreview(el);
  }

  // 헤더 (FR-GIT-32·33·40)
  _paintHead(el,s){
    const repo=this.repo||'';
    const r=el.querySelector('.git-head-repo');
    r.textContent=repo.split('/').filter(Boolean).pop()||repo;
    r.title=repo;
    // detached 면 브랜치 자리에 해시 앞 7자가 온다.
    el.querySelector('.git-head-branch').textContent=
      !s?'':(s.detached?(s.oid||'').slice(0,7):(s.branch||''));
    const badges=el.querySelector('.git-head-badges'); badges.innerHTML='';
    const add=(cls,text)=>{
      const b=document.createElement('span'); b.className='git-head-badge '+cls;
      b.textContent=text; badges.appendChild(b);
    };
    if(s){
      if(s.detached) add('git-badge-detached','detached HEAD');
      else if(!s.hasUpstream) add('git-badge-noupstream','upstream 없음');
      const n=(s.conflicts||[]).length;
      if(n) add('git-badge-conflict','충돌 '+n);
    }
    // ahead/behind 는 0 이면 그리지 않는다.
    const ab=[];
    if(s&&s.ahead>0) ab.push('↑'+s.ahead);
    if(s&&s.behind>0) ab.push('↓'+s.behind);
    el.querySelector('.git-head-ab').textContent=ab.join(' ');
  }

  // 그룹 (FR-GIT-34·42). 빈 그룹도 개수를 보인다 — 숨기면 "없다"와 "모른다"가
  // 같아진다.
  _paintGroup(el,g,entries){
    const box=el.querySelector('.git-group[data-group="'+g.key+'"]'); if(!box) return;
    box.querySelector('.git-group-count').textContent='('+entries.length+')';
    const collapsed=this._collapsed.has(g.key)||!entries.length;
    box.classList.toggle('collapsed',collapsed);
    box.querySelector('.git-group-caret').textContent=collapsed?'▸':'▾';
    const rows=box.querySelector('.git-group-rows');
    rows.innerHTML='';
    if(collapsed) return;
    const limit=this._shown.get(g.key)||GIT_FILE_ROW_CHUNK;
    // 행은 DocumentFragment 로 한 번에 붙인다 — 수천 행을 innerHTML 로 만들지 않는다.
    const frag=document.createDocumentFragment();
    const drawn=this._treeMode()
      ?this._emitTree(frag,g.key,entries,limit)
      :this._emitFlat(frag,g.key,entries,limit);
    rows.appendChild(frag);
    if(drawn<entries.length){
      const more=document.createElement('div');
      more.className='git-file-more'; more.dataset.group=g.key;
      more.textContent='… '+(entries.length-drawn)+' 개 더';
      rows.appendChild(more);
      if(this._io) this._io.observe(more);
    }
  }

  _emitFlat(frag,group,entries,limit){
    const n=Math.min(limit,entries.length);
    for(let i=0;i<n;i++) frag.appendChild(this._rowEl(group,entries[i],0));
    return n;
  }

  // 트리 보기 (FR-GIT-38). 자식이 하나뿐인 중간 디렉터리는 합쳐 보인다 —
  // 깊은 트리에서 줄 수를 줄인다.
  _emitTree(frag,group,entries,limit){
    const root={dirs:new Map(),files:[]};
    for(const e of entries){
      const parts=e.path.split('/');
      let n=root;
      for(let i=0;i<parts.length-1;i++){
        let x=n.dirs.get(parts[i]);
        if(!x){x={dirs:new Map(),files:[]};n.dirs.set(parts[i],x)}
        n=x;
      }
      n.files.push(e);
    }
    const st={drawn:0,limit};
    this._emitDir(frag,group,root,'',0,st);
    return st.drawn;
  }

  _emitDir(frag,group,node,prefix,depth,st){
    if(st.drawn>=st.limit) return;
    for(const [name,child] of node.dirs){
      let label=name,cur=child,path=prefix+name;
      while(cur.dirs.size===1&&!cur.files.length){
        const [n2,c2]=cur.dirs.entries().next().value;
        label+='/'+n2; path+='/'+n2; cur=c2;
      }
      const key=group+':'+path;
      const collapsed=this._dirCollapsed.has(key);
      const d=document.createElement('div');
      d.className='git-dir'+(collapsed?' collapsed':'');
      d.dataset.dir=path;
      d.style.paddingLeft=(6+depth*12)+'px';
      d.innerHTML='<span class="git-dir-caret"></span><span class="git-dir-name"></span>';
      d.querySelector('.git-dir-caret').textContent=collapsed?'▸':'▾';
      d.querySelector('.git-dir-name').textContent=label;
      d.addEventListener('click',()=>{
        if(this._dirCollapsed.has(key)) this._dirCollapsed.delete(key);
        else this._dirCollapsed.add(key);
        this._paint();
      });
      frag.appendChild(d);
      if(!collapsed) this._emitDir(frag,group,cur,path+'/',depth+1,st);
      if(st.drawn>=st.limit) return;
    }
    for(const e of node.files){
      if(st.drawn>=st.limit) return;
      st.drawn++;
      frag.appendChild(this._rowEl(group,e,depth));
    }
  }

  _rowEl(group,e,depth){
    const d=document.createElement('div');
    // 충돌 행은 따로 구분한다 (FR-GIT-37). M1 은 표시만 한다.
    d.className='git-file'+(e.conflict?' conflict':'');
    d.dataset.path=e.path; d.dataset.group=group;
    if(e.origPath) d.dataset.origPath=e.origPath;
    if(depth) d.style.paddingLeft=(6+depth*12)+'px';
    const sel=this.previewFile;
    if(sel&&sel.group===group&&sel.path===e.path) d.classList.add('sel');
    const st=document.createElement('span'); st.className='git-file-st';
    st.textContent=this._stateChar(group,e);
    const p=document.createElement('span'); p.className='git-file-path';
    // rename/copy 는 원본과 대상을 둘 다 보인다 (FR-GIT-36).
    p.textContent=e.origPath?e.origPath+' → '+e.path
      :(this._treeMode()?e.path.split('/').pop():e.path);
    d.title=(e.origPath?e.origPath+' → '+e.path:e.path)+(e.score?' ('+e.score+'%)':'');
    d.appendChild(st); d.appendChild(p);
    d.addEventListener('click',()=>this._select(group,e));
    d.addEventListener('dblclick',()=>this._openDiff(group,e));
    d.addEventListener('contextmenu',ev=>{ev.preventDefault();this._ctxMenu(ev,group,e)});
    return d;
  }

  // 상태문자는 xy 에서 뽑는다 — 그룹이 어느 축을 보는지가 곧 X/Y 선택이다.
  _stateChar(group,e){
    if(group==='untracked') return '?';
    if(group==='conflicts') return 'U';
    const xy=e.xy||'..';
    return group==='staged'?xy[0]:xy[1];
  }

  _toggleGroup(key){
    if(this._collapsed.has(key)) this._collapsed.delete(key); else this._collapsed.add(key);
    this._paint();
  }

  _growGroup(key){
    if(!key) return;
    this._shown.set(key,(this._shown.get(key)||GIT_FILE_ROW_CHUNK)+GIT_FILE_ROW_CHUNK);
    this._paint();
  }

  // 보기 선택은 localStorage 에 남긴다 (기기별 취향이다). 기본은 플랫이다.
  _treeMode(){
    if(this._fileView==null){
      let v=null; try{v=localStorage.getItem(GIT_FILE_VIEW_KEY)}catch{}
      this._fileView=v==='tree'?'tree':'flat';
    }
    return this._fileView==='tree';
  }

  _setFileView(mode){
    this._fileView=mode==='tree'?'tree':'flat';
    try{localStorage.setItem(GIT_FILE_VIEW_KEY,this._fileView)}catch{}
    this._paint();
  }

  _paintMode(el){
    const tree=this._treeMode();
    for(const b of el.querySelectorAll('.git-files-mode'))
      b.classList.toggle('active',(b.dataset.mode==='tree')===tree);
    el.querySelector('.git-files').classList.toggle('tree',tree);
  }

  // ── 선택과 이동 (FR-GIT-52) ──

  _select(group,e){
    this.previewFile={
      repo:this.repo,group,axis:GIT_GROUP_AXIS[group],
      path:e.path,origPath:e.origPath||'',
    };
    this._paint();
  }

  _openDiff(group,e){
    this._select(group,e);
    const w=this.app._gitWindow(); if(!w||!w.layout) return;
    for(const pn of this.app._flattenPanes(w.layout)){
      const t=(pn.tabs||[]).find(x=>x.type===TAB_TYPE_GIT&&x.gitView==='diff');
      if(t){this.app.switchTab(pn.id,t.id);return}
    }
  }

  // 미리보기는 5단계에서 대상과 축을 보이는 자리다. 실제 diff 는 7단계가 채운다.
  _paintPreview(el){
    const p=el.querySelector('.git-preview'); if(!p) return;
    const f=this.previewFile;
    p.innerHTML='';
    const d=document.createElement('div');
    if(!f){
      d.className='git-preview-empty'; d.textContent=GIT_PREVIEW_HINT;
    }else{
      d.className='git-preview-target';
      d.innerHTML='<div class="git-preview-path"></div><div class="git-preview-axis"></div>';
      d.querySelector('.git-preview-path').textContent=
        f.origPath?f.origPath+' → '+f.path:f.path;
      d.querySelector('.git-preview-axis').textContent=GIT_AXIS_LABEL[f.axis]||f.axis;
    }
    p.appendChild(d);
  }

  // ── 우클릭 (FR-GIT-41) ──
  // M1 전용 최소 구현이다. 공통 프레임워크는 M4 다 (FR-GIT-146).

  _ctxMenu(ev,group,e){
    this._closeCtx();
    const m=document.createElement('div'); m.className='git-ctxmenu';
    for(const it of GIT_CTX_ITEMS){
      const b=document.createElement('div'); b.className='git-ctx-item'; b.dataset.act=it.key;
      b.textContent=it.label;
      b.addEventListener('click',()=>{this._closeCtx();this._ctxRun(it.key,group,e)});
      m.appendChild(b);
    }
    document.body.appendChild(m);
    m.style.left=Math.max(0,Math.min(ev.clientX,window.innerWidth-m.offsetWidth-4))+'px';
    m.style.top=Math.max(0,Math.min(ev.clientY,window.innerHeight-m.offsetHeight-4))+'px';
    this._ctx=m;
    this._ctxOff=ev2=>{if(!m.contains(ev2.target))this._closeCtx()};
    this._ctxKey=ev2=>{if(ev2.key==='Escape')this._closeCtx()};
    this._ctxScroll=()=>this._closeCtx();
    // 이 메뉴를 띄운 contextmenu 는 이미 지나갔으므로 지금 붙여도 자기 이벤트로
    // 닫히지 않는다. Esc·바깥 클릭·스크롤로 닫힌다.
    document.addEventListener('mousedown',this._ctxOff,true);
    document.addEventListener('keydown',this._ctxKey,true);
    window.addEventListener('scroll',this._ctxScroll,true);
  }

  _closeCtx(){
    if(!this._ctx) return;
    this._ctx.remove(); this._ctx=null;
    document.removeEventListener('mousedown',this._ctxOff,true);
    document.removeEventListener('keydown',this._ctxKey,true);
    window.removeEventListener('scroll',this._ctxScroll,true);
  }

  _ctxRun(act,group,e){
    if(act==='openChanges'){this._openDiff(group,e);return}
    const abs=(this.repo||'')+'/'+e.path;
    if(act==='openFile'){this.app._gitOpenFile(abs);return}
    if(act==='copyPath') this._copyPath(abs);
  }

  // 복사 유틸이 기존에 없다. clipboard 가 막힌 환경(비보안 컨텍스트)에서는
  // 임시 textarea 로 떨어진다.
  _copyPath(abs){
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(abs).catch(()=>this._copyFallback(abs));
      return;
    }
    this._copyFallback(abs);
  }

  _copyFallback(abs){
    const ta=document.createElement('textarea');
    ta.value=abs; ta.style.cssText='position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    try{document.execCommand('copy')}catch{}
    ta.remove();
  }

  // ── 변경 감지 3계층 (FR-GIT-18~24) ──

  // init 은 재평가 계기를 붙인다. 폴링과 즉시 신호는 게이팅이 다르므로 같은
  // 리스너에서 둘을 각각 부른다.
  init(){
    document.addEventListener('visibilitychange',()=>{
      this._reschedule();
      if(!document.hidden) this.signal('visible');
    });
    window.addEventListener('focus',()=>{this._reschedule();this.signal('focus')});
    this._reschedule();
  }

  // signal 은 즉시 신호의 유일한 처리점이다 (FR-GIT-18·20). Git 창이 활성이 아니어도
  // 한 번은 수집한다 — 사용자 행동과 1:1 이라 폴링이 아니고, 상태바 chip 과 GIT
  // 섹션 배지가 창을 보지 않을 때도 딛는 값이다 (SRS §7.1 I1).
  signal(kind){
    if(document.hidden) return;
    if(!this.repo||this._gitMissing) return;
    if(this._sigT) clearTimeout(this._sigT);
    // 연속 신호가 status 를 연발하지 않게 하나로 합친다.
    this._sigT=setTimeout(()=>{this._sigT=null;this.collect()},GIT_SIGNAL_DEBOUNCE_MS);
  }

  // 폴링 두 계층은 세 조건이 전부 참일 때만 돈다 (FR-GIT-22).
  _pollOk(){
    if(document.hidden) return false;
    if(this._gitMissing) return false;
    const w=this.app._gitWindow();
    if(!w||this.app.ws.activeWindow!==w.id) return false;
    return !!this.repo;
  }

  // 조건이 거짓이면 clearInterval 로 완전히 멈춘다 — 콜백에서 return 으로 넘기지
  // 않는다. 참이 되면 즉시 1회 수집하고 주기를 건다 (FR-STAT-17 과 같은 규약).
  _reschedule(){
    if(!this._pollOk()){this._stop();return}
    const sig=gitSignatureInterval,st=gitStatusInterval;
    if(this._pollOn&&this._pollSig===sig&&this._pollSt===st) return;
    this._stop();
    this._pollOn=true; this._pollSig=sig; this._pollSt=st;
    // 주기 0 은 그 계층을 걸지 않는다 (FR-GIT-23). 상수는 여기서 한 번만 읽는다.
    if(sig>0) this._sigPoll=setInterval(()=>this._pollSignature(),sig);
    if(st>0) this._stPoll=setInterval(()=>this.collect(),st);
    this.collect();
  }

  _stop(){
    if(this._sigPoll){clearInterval(this._sigPoll);this._sigPoll=null}
    if(this._stPoll){clearInterval(this._stPoll);this._stPoll=null}
    this._pollOn=false;
  }

  // collect 는 status 1회다. single-flight — 진행 중이면 "끝나면 한 번 더" 플래그만
  // 세운다 (FR-GIT-21). 요청은 활성 리포에만 간다 (FR-GIT-24).
  async collect(){
    const repo=this.repo; if(!repo) return;
    if(this._busy){this._again=true;return}
    this._busy=true;
    const seq=++this._seq;
    const tok=this.token();
    let r=null,d=null;
    try{r=await fetch('/api/git/status?repo='+encodeURIComponent(repo))}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    // 리포가 바뀌면 setRepo 가 소유권을 끊는다 — 그 뒤 도착한 응답은 플래그를
    // 건드리지 않는다.
    if(this._seq!==seq){this._applyStatus(tok,r,d);return}
    this._busy=false;
    const again=this._again; this._again=false;
    this._applyStatus(tok,r,d);
    if(again) this.collect();
  }

  _applyStatus(tok,r,d){
    // ① 세대·리포 확인 (FR-GIT-16)
    if(this.isStale(tok)) return;
    if(!r){
      // 네트워크 오류 — 이전 화면을 유지한다. **목록을 지우지 않는다.**
      this._staleNote=true; this._paint(); return;
    }
    if(!r.ok){this._applyError(d&&d.error);return}
    // ② 서버가 되돌려준 요청값 확인. 같은 세대 안에서도 응답 순서가 뒤바뀔 수 있다.
    if(!d||d.requested!==tok.repo) return;
    this._status=d;
    // 응답에 signature 가 함께 오므로 그 값으로 갱신한다 — 직후 signature 폴링이
    // 헛되이 변화를 보고하지 않게 한다.
    this._lastSig=(d.signature&&d.signature.value)||'';
    this._errMsg=null; this._staleNote=false;
    this._paint();
    // 활성 리포의 배지가 따라 갱신된다. 다른 리포는 서버의 마지막 관측값이다.
    this.app._gitReposRefresh();
  }

  _applyError(code){
    if(code==='not_a_git_repo'){
      this._errMsg=GIT_ERR_NOT_REPO; this._status=null;
      this.setRepo(null);
      return;
    }
    if(code==='git_missing'){
      this._errMsg=GIT_ERR_GIT_MISSING; this._gitMissing=true;
      this._stop(); this._paint();
      return;
    }
    this._staleNote=true; this._paint();
  }

  // signature 는 git 을 실행하지 않는 감지 경로다. 값이 그대로면 아무것도 하지
  // 않는다 (FR-GIT-19).
  async _pollSignature(){
    const repo=this.repo; if(!repo) return;
    if(this._sigBusy) return;
    this._sigBusy=true;
    const seq=this._seq;
    const tok=this.token();
    let r=null,d=null;
    try{r=await fetch('/api/git/signature?repo='+encodeURIComponent(repo))}catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    if(this._seq===seq) this._sigBusy=false;
    if(!d||this.isStale(tok)||d.requested!==tok.repo) return;
    const v=(d.signature&&d.signature.value)||'';
    if(v===this._lastSig) return;
    this._lastSig=v;
    this.collect();
  }
}
