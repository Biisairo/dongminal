/**
 * Dongminal — Git 창의 표면 (GIT_SRS §3.4)
 *
 * Git 창은 워크스페이스에 하나이므로(FR-GIT-26) 이 객체도 앱에 하나다. GIT_VIEWS 의
 * 고정 탭은 각자 루트 DOM 을 갖고, 활성 탭의 루트만 pane 본문에 붙는다 — 숫자를 여기
 * 적지 않는다 (FR-GIT-28 이 개정될 때 이 주석이 낡는다).
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
    this._refreshing=false;       // FR-GIT-238 의 새로고침이 도는 중 (겹쳐 부르지 않는다)
    this._gitMissing=false;
    this._collapsed=new Set();    // 접힌 그룹. 뷰의 성질이라 리포 전환에도 남는다
    this._dirCollapsed=new Set(); // 접힌 트리 디렉터리 (group:path)
    this._shown=new Map();        // 그룹별로 그린 행 수 (FR-GIT-42)
    this._fileView=null;          // 'flat' | 'tree'
    this._seq=0;                  // status 요청 일련번호 (single-flight 소유권)
    this.previewFile=null;        // {repo,group,axis,path,origPath}. 미리보기와 Diff 탭이 같이 쓴다
    this._diffView=null;          // Diff 탭의 GitDiffView
    this._previewView=null;       // Changes 탭 미리보기의 GitDiffView
    this._diffKey=null;           // 두 뷰에 이미 보인 대상 (재요청 방지)
    this._prevKey=null;
    // 부분 스테이징 (FR-GIT-278·279). 조각은 서버가 만든 diff 에서 온다 — 여기서
    // 만들지 않는다. _hunkKey 는 이미 받아 둔 대상, _hunks 는 그 관측이다.
    this._hunkKey=null;
    this._hunks=null;             // {diffId,list,note} 또는 {err}
    this._hunkSel=null;           // {hunk,from,to,anchor} — 한 덩어리 안의 줄 범위
    this._diffPos=0;              // 목록에서 사라진 대상을 클램프할 기준 (FR-GIT-53)
    this._sideBy=null;            // FR-GIT-51 의 보기 모드
    this._ignWs=null;             // FR-GIT-50 의 공백무시 토글
    this._sel=new Set();          // 다중 선택 (FR-GIT-69). group\0path
    this._anchor=null;            // Shift 범위 선택의 기준 행
    this._note=null;              // 쓰기 실패·부분 적용 안내 (FR-GIT-73)
    this._commitView=null;        // 커밋 영역 (FR-GIT-74~85)
    this._historyView=null;       // History 탭 (FR-GIT-113~139)
    this._branchesView=null;      // Branches 탭 (FR-GIT-147~160)
    this._stashView=null;         // Stash 탭 (FR-GIT-161~170)
    this._consoleView=null;       // Console 탭 (FR-GIT-218)
    this._worktreesView=null;     // Worktrees 탭 (FR-GIT-240~244)
    this._remoteView=null;        // 원격 작업 (FR-GIT-98~112)
    // 커밋 축의 diff 대상 (FR-GIT-138). previewFile 과 자리를 나눈다 — 같은 자리에
    // 두면 Changes 탭의 미리보기가 커밋의 diff 를 보이면서 목록에는 아무 행도
    // 선택되지 않는다.
    this.commitFile=null;
    this._writing=false;          // 쓰기 한 번은 한 번이다 — 겹쳐 보내지 않는다
    // FR-GIT-227: 마지막으로 그린 관측. null 이면 다음 관측은 무조건 그린다.
    this._obsSig=null;
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
    // 관측을 버렸으므로 근거도 버린다 — 새 리포의 첫 관측은 무조건 그린다.
    this._obsSig=null;
    this._shown.clear(); this.previewFile=null; GitMenu.close();
    // 선택과 쓰기 안내는 리포에 붙은 것이다 — 새 리포로 넘겨 오면 다른 파일을
    // 가리킨다.
    this._sel.clear(); this._anchor=null; this._note=null;
    // 원격 작업은 리포에 붙은 것이다 — 이전 리포의 출력이 새 리포의 헤더와 함께
    // 보이는 순간이 있어서는 안 된다. 작업 자체는 서버에서 계속 돈다.
    if(this._remoteView) this._remoteView.detachRepo();
    // 앞 리포의 실행 기록이 새 리포의 이력에 섞이면 이력이 아니라 잡음이다
    // (FR-GIT-218).
    if(this._consoleView) this._consoleView.reset();
    // 이전 리포의 diff 가 새 리포의 헤더와 함께 보이는 순간이 있어서는 안 된다.
    this._diffKey=null; this._prevKey=null; this._diffPos=0; this.commitFile=null;
    this._hunkKey=null; this._hunks=null; this._hunkSel=null;
    for(const v of [this._diffView,this._previewView])
      if(v) v.clear(path?GIT_PREVIEW_HINT:GIT_NO_REPO_HINT);
    if(path) this._errMsg=null;
    // 진행 중인 요청의 소유권을 끊는다 — 그 응답은 가드에 걸려 버려지고, 새 리포는
    // 앞선 요청이 끝나기를 기다리지 않는다.
    this._seq++; this._busy=false; this._again=false; this._sigBusy=false;
    if(this._sigT){clearTimeout(this._sigT);this._sigT=null}
    for(const v of GIT_VIEWS) if(this._els.has(v.key)) this._render(v.key);
    // 마지막 관측을 버렸으므로 chip 도 사라져야 한다 (FR-GIT-59).
    this.app._updateStatusBar();
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
    // 탭 전환마다 루트가 DOM 에서 떼였다 붙는다 — Monaco 는 그 사이 크기를 0 으로
    // 보므로 다시 붙은 뒤 한 번 재배치한다.
    const v=view==='diff'?this._diffView:(view==='changes'?this._previewView:null);
    if(v) requestAnimationFrame(()=>v.layout());
    // History 는 탭이 활성일 때만 목록을 받는다 — 열지 않은 탭이 10,000 커밋을
    // 미리 받아 둘 이유가 없다.
    if(view==='history'){
      this._renderHistory(el);
      // 여기서는 루트가 아직 pane 본문에 붙기 전이라 목록의 높이가 0 이다 —
      // 붙은 뒤에 한 번 더 칠해야 스크롤 위치와 펼친 상세가 되돌아온다.
      requestAnimationFrame(()=>{if(this._historyView) this._historyView.paint()});
    }
    // Branches·Stash 도 탭이 활성일 때 받는다 — 열지 않은 탭이 refs·stash 를 미리
    // 받아 둘 이유가 없다.
    if(view==='branches') this._renderBranches(el);
    if(view==='stash') this._renderStash(el);
    if(view==='console') this._renderConsole(el);
    // Worktrees 도 탭이 활성일 때 받는다 — 열지 않은 탭이 목록을 미리 받아 둘
    // 이유가 없다 (FR-STAT-17 과 같은 원칙).
    if(view==='worktrees') this._renderWorktrees(el);
    return el;
  }

  // Git 창이 사라졌을 때 루트를 area 로 되돌린다. 인스턴스는 살아 있다 —
  // 창은 다시 열릴 수 있다.
  detach(){
    this._stop(); GitMenu.close(); this._destroyViews();
    // 창이 사라지면 커밋 영역의 토스트도 함께 사라진다 — 진입점이 화면 없이
    // 남아 있어서는 안 된다 (FR-GIT-83).
    this._commit().unmount();
    this._history().unmount();
    this._branches().unmount();
    this._stash().unmount();
    this._console().unmount();
    this._worktrees().unmount();
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
    if(view==='diff'){this._renderDiff(el);return}
    if(view==='history'){this._renderHistory(el);return}
    if(view==='branches'){this._renderBranches(el);return}
    if(view==='stash'){this._renderStash(el);return}
    if(view==='console'){this._renderConsole(el);return}
    if(view==='worktrees'){this._renderWorktrees(el);return}
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
      // 골격을 버렸으므로 커밋 영역도 자기 DOM 을 놓아야 한다.
      this._commit().unmount();
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1') this._buildChanges(el);
    this._paintChanges(el);
  }

  _paint(){
    const c=this._els.get('changes'); if(c) this._renderChanges(c);
    const d=this._els.get('diff'); if(d) this._renderDiff(d);
    // History 는 status 에서 미커밋 변경 행만 딛는다 (FR-GIT-127) — 목록 전체를
    // 폴링마다 다시 그리면 스크롤이 매초 흔들린다.
    if(this._historyView) this._historyView.paintStatus();
    // Branches 는 현재 브랜치만, Stash 는 "담을 것이 있는지" 만 딛는다
    // (FR-GIT-152·167).
    if(this._branchesView) this._branchesView.paintStatus();
    if(this._stashView) this._stashView.paintStatus();
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
        // FR-GIT-238: 새로고침. **`.git-head-remote` 밖**에 둔다 — 안에 넣으면 원격
        // 버튼을 세는 기존 단정이 깨진다.
        '<button class="git-head-refresh"></button>'+
        // 원격 버튼은 기본 동작만 하고 변형은 `▾` 다이얼로그에서 온다
        // (FR-GIT-98·99). 동작은 GitRemote 가 붙인다.
        '<span class="git-head-remote">'+GIT_REMOTE_KINDS.map(k=>
          '<button class="git-remote-btn" data-remote="'+k+'" disabled></button>'+
          '<button class="git-remote-more" data-remote="'+k+'" disabled></button>'
        ).join('')+'</span>'+
      '</div>'+
      // 안쪽은 GitCommit 이 채운다 (FR-GIT-74~85). 자리와 고정 성질은 여기 있다.
      '<div class="git-commit"></div>'+
      // 원격 작업 하나의 화면 (FR-GIT-102·103·105·108). 진행 중이 아니면 접힌다.
      '<div class="git-job">'+
        '<div class="git-job-bar">'+
          '<span class="git-job-kind"></span>'+
          '<code class="git-job-argv"></code>'+
          '<span class="git-job-state"></span>'+
          '<span class="git-job-spacer"></span>'+
          '<button class="git-job-cancel"></button>'+
          '<button class="git-job-copy"></button>'+
          '<button class="git-job-close"></button>'+
        '</div>'+
        '<div class="git-job-note"></div>'+
        '<div class="git-job-fail">'+
          '<div class="git-job-reason"></div>'+
          '<pre class="git-job-tail"></pre>'+
          // 자격증명을 받는 자리가 아니다 — 안내와 복사 가능한 명령뿐이다
          // (FR-GIT-104).
          '<div class="git-job-auth">'+
            '<div class="git-job-auth-note"></div>'+
            '<code class="git-job-auth-cmd"></code>'+
            '<button class="git-job-auth-copy"></button>'+
          '</div>'+
          '<div class="git-job-opts"></div>'+
        '</div>'+
        '<pre class="git-job-log"></pre>'+
      '</div>'+
      // FR-GIT-252: 진행 중 작업과 **나갈 길**. 상태만 보이고 출구가 없으면
      // 사용자는 GUI 안에 갇힌다.
      '<div class="git-op-bar">'+
        '<span class="git-op-kind"></span>'+
        '<span class="git-op-at"></span>'+
        '<span class="git-op-spacer"></span>'+
        '<button class="git-op-act" data-act="'+GIT_OP_CONTINUE+'"></button>'+
        '<button class="git-op-act" data-act="'+GIT_OP_SKIP+'"></button>'+
        '<button class="git-op-act" data-act="'+GIT_OP_ABORT+'"></button>'+
      '</div>'+
      '<div class="git-stale-note"></div>'+
      '<div class="git-partial-note">'+
        '<div class="git-partial-msg"></div>'+
        '<ul class="git-partial-list"></ul>'+
        '<button class="git-partial-close"></button>'+
      '</div>'+
      '<div class="git-changes-body">'+
        '<div class="git-files">'+
          '<div class="git-files-bar">'+
            '<button class="git-files-mode" data-mode="tree">Tree</button>'+
            '<button class="git-files-mode" data-mode="flat">Flat</button>'+
            '<span class="git-files-spacer"></span>'+
          '</div>'+
        '</div>'+
        '<div class="git-preview"></div>'+
      '</div>';
    for(const b of el.querySelectorAll('.git-remote-btn'))
      b.textContent=GIT_REMOTE_LABEL[b.dataset.remote]||'';
    for(const b of el.querySelectorAll('.git-remote-more')) b.textContent=GIT_REMOTE_MORE;
    for(const b of el.querySelectorAll('.git-job-cancel')) b.textContent=GIT_JOB_CANCEL;
    el.querySelector('.git-job-copy').textContent=GIT_JOB_COPY;
    el.querySelector('.git-job-close').textContent=GIT_JOB_CLOSE;
    el.querySelector('.git-job-auth-copy').textContent=GIT_JOB_AUTH_COPY;
    el.querySelector('.git-partial-close').textContent=GIT_NOTE_CLOSE;
    el.querySelector('.git-partial-close')
      .addEventListener('click',()=>{this._note=null;this._paint()});
    for(const b of el.querySelectorAll('.git-op-act')){
      b.textContent=GIT_OP_ACT_LABEL[b.dataset.act]||'';
      b.title=GIT_OP_ACT_TITLE[b.dataset.act]||'';
      b.addEventListener('click',()=>this.runOperation(b.dataset.act));
    }
    const rf=el.querySelector('.git-head-refresh');
    rf.textContent=GIT_REFRESH_LABEL; rf.title=GIT_REFRESH_TITLE;
    rf.addEventListener('click',()=>this.refresh());
    const files=el.querySelector('.git-files');
    for(const g of GIT_GROUPS){
      const d=document.createElement('div'); d.className='git-group'; d.dataset.group=g.key;
      d.innerHTML='<div class="git-group-head"><span class="git-group-caret"></span>'+
        '<span class="git-group-name"></span><span class="git-group-count"></span>'+
        '<span class="git-group-spacer"></span></div>'+
        '<div class="git-group-rows"></div>';
      d.querySelector('.git-group-name').textContent=g.name;
      d.querySelector('.git-group-head').addEventListener('click',()=>this._toggleGroup(g.key));
      // 그룹별 일괄 (FR-GIT-66·67·68). 그룹이 이미 tracked / untracked 를
      // 가르므로 그룹별 일괄이 곧 그 구분이다.
      const act=GIT_GROUP_BULK[g.key];
      if(act){
        const b=document.createElement('button');
        b.className='git-group-bulk'; b.dataset.act=act;
        b.textContent=GIT_BULK_LABEL[act];
        // 헤더 클릭은 접기다 — 일괄 버튼이 그것을 함께 일으키지 않는다.
        b.addEventListener('click',ev=>{ev.stopPropagation();this._bulk(g.key,act)});
        d.querySelector('.git-group-head').appendChild(b);
      }
      files.appendChild(d);
    }
    for(const b of el.querySelectorAll('.git-files-mode'))
      b.addEventListener('click',()=>this._setFileView(b.dataset.mode));
    this._commit().mount(el.querySelector('.git-commit'));
    // 원격 버튼과 작업 영역의 동작 (FR-GIT-98~112). 골격은 여기 있고 상태는
    // GitRemote 가 들고 있다 — 골격을 다시 세워도 진행 중 작업이 사라지지 않는다.
    this._remote().bind(el);
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
    this._paintOp(el,s);
    for(const g of GIT_GROUPS) this._paintGroup(el,g,(s&&s[g.key])||[]);
    this._paintMode(el);
    this._paintNote(el);
    this._commit().paint(s||null);
    this._remote().paint(el);
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
    // 빈 그룹에 일괄 동작은 뜻이 없다.
    const bulk=box.querySelector('.git-group-bulk');
    if(bulk) bulk.disabled=!entries.length;
    const collapsed=this._collapsed.has(g.key)||!entries.length;
    box.classList.toggle('collapsed',collapsed);
    box.querySelector('.git-group-caret').textContent=collapsed?'▸':'▾';
    const rows=box.querySelector('.git-group-rows');
    if(collapsed){rows.innerHTML=''; return}
    const limit=this._shown.get(g.key)||GIT_FILE_ROW_CHUNK;
    // 그릴 행을 먼저 **기술**하고, 요소는 reconcileList 가 필요한 것만 만든다
    // (FR-GIT-227 / FR-RPT-3) — 목록을 비우고 다시 만들면 hover·더블클릭·우클릭이
    // 매 회차 끊긴다. 평평한 보기와 트리 보기가 같은 기술을 낸다.
    const items=[];
    const drawn=this._treeMode()
      ?this._emitTree(items,g.key,entries,limit)
      :this._emitFlat(items,g.key,entries,limit);
    if(drawn<entries.length) items.push({t:'more',group:g.key,n:entries.length-drawn});
    reconcileList(rows,items,{
      key:it=>it.t+':'+(it.t==='file'?it.e.path:it.t==='dir'?it.path:''),
      sig:it=>this._itemSig(it),
      build:it=>this._itemEl(it),
    });
  }

  // 행의 **보이는 값 전부**다 (FR-RPT-2). 하나라도 빠지면 그 값의 변화가 화면에
  // 닿지 않는다 — 좁히지 않는다.
  _itemSig(it){
    if(it.t==='dir') return [it.depth,it.label,it.collapsed?1:0].join('\u0001');
    if(it.t==='more') return String(it.n);
    const e=it.e,group=it.group;
    return [
      it.depth,e.path,e.origPath||'',e.staged||'',e.unstaged||'',
      e.conflict?1:0,e.score||'',this._stateChar(group,e),
      this._sel.has(this._selKey(group,e.path))?1:0,
      (this.previewFile&&this.previewFile.group===group&&this.previewFile.path===e.path)?1:0,
      this._treeMode()?1:0,
      // ours·theirs 의 title 이 진행 중인 조작에 따라 뒤집힌다 (FR-GIT-224).
      this._op()||'',
    ].join('\u0001');
  }

  _itemEl(it){
    if(it.t==='dir') return this._dirEl(it);
    if(it.t==='file') return this._rowEl(it.group,it.e,it.depth);
    const more=document.createElement('div');
    more.className='git-file-more'; more.dataset.group=it.group;
    more.textContent='… '+it.n+' 개 더';
    if(this._io) this._io.observe(more);
    return more;
  }

  _emitFlat(items,group,entries,limit){
    const n=Math.min(limit,entries.length);
    for(let i=0;i<n;i++) items.push({t:'file',group,e:entries[i],depth:0});
    return n;
  }

  // 트리 보기 (FR-GIT-38). 자식이 하나뿐인 중간 디렉터리는 합쳐 보인다 —
  // 깊은 트리에서 줄 수를 줄인다.
  _emitTree(items,group,entries,limit){
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
    this._emitDir(items,group,root,'',0,st);
    return st.drawn;
  }

  _emitDir(items,group,node,prefix,depth,st){
    if(st.drawn>=st.limit) return;
    for(const [name,child] of node.dirs){
      let label=name,cur=child,path=prefix+name;
      while(cur.dirs.size===1&&!cur.files.length){
        const [n2,c2]=cur.dirs.entries().next().value;
        label+='/'+n2; path+='/'+n2; cur=c2;
      }
      const collapsed=this._dirCollapsed.has(group+':'+path);
      items.push({t:'dir',group,path,label,depth,collapsed});
      if(!collapsed) this._emitDir(items,group,cur,path+'/',depth+1,st);
      if(st.drawn>=st.limit) return;
    }
    for(const e of node.files){
      if(st.drawn>=st.limit) return;
      st.drawn++;
      items.push({t:'file',group,e,depth});
    }
  }

  _dirEl(it){
    const key=it.group+':'+it.path;
    const d=document.createElement('div');
    d.className='git-dir'+(it.collapsed?' collapsed':'');
    d.dataset.dir=it.path;
    this._indent(d,it.depth);
    d.innerHTML='<span class="git-dir-caret"></span><span class="git-dir-name"></span>';
    d.querySelector('.git-dir-caret').textContent=it.collapsed?'▸':'▾';
    d.querySelector('.git-dir-name').textContent=it.label;
    d.addEventListener('click',()=>{
      if(this._dirCollapsed.has(key)) this._dirCollapsed.delete(key);
      else this._dirCollapsed.add(key);
      this._paint();
    });
    return d;
  }

  /**
   * FR-GIT-211: 트리의 들여쓰기와 **깊이 세로선**.
   *
   * 트리 행은 중첩 DOM 이 아니라 패딩으로 들여쓴 평평한 목록이다 — 조상 요소가
   * 없으니 선을 걸 자리도 없다. 그래서 깊이를 행에 실어 CSS 가 배경으로 그 수만큼
   * 반복해 그린다. 패딩과 선이 같은 상수를 딛는다.
   */
  _indent(el,depth){
    const d=depth||0;
    el.style.setProperty('--git-depth',d);
    if(d) el.style.paddingLeft=(GIT_TREE_PAD0+d*GIT_TREE_INDENT)+'px';
  }

  _rowEl(group,e,depth){
    const d=document.createElement('div');
    // 충돌 행은 따로 구분한다 (FR-GIT-37). M1 은 표시만 한다.
    d.className='git-file'+(e.conflict?' conflict':'');
    // FR-GIT-70: staged 와 unstaged 를 동시에 가진 파일은 일부만 스테이지된 것이다.
    const partial=!!(e.staged&&e.unstaged);
    if(partial) d.classList.add('partial');
    d.dataset.path=e.path; d.dataset.group=group;
    if(e.origPath) d.dataset.origPath=e.origPath;
    this._indent(d,depth);
    // FR-GIT-187·189: 선택은 행 자체다 (체크박스 없음). 선택(`sel`)과 포커스
    // (`cur`, 미리보기 대상)를 나눈다 — 같게 그리면 미리보기가 어느 행을 보이는지
    // 알 수 없다.
    if(this._sel.has(this._selKey(group,e.path))) d.classList.add('sel');
    const cur=this.previewFile;
    if(cur&&cur.group===group&&cur.path===e.path) d.classList.add('cur');
    // FR-GIT-190: 일부만 스테이지된 상태는 상태 문자 색으로 알린다.
    const st=document.createElement('span'); st.className='git-file-st';
    st.textContent=this._stateChar(group,e);
    const p=document.createElement('span'); p.className='git-file-path';
    this._fillPath(p,e);
    d.title=(e.origPath?e.origPath+' → '+e.path:e.path)+(e.score?' ('+e.score+'%)':'')+
      (partial?' — '+GIT_PARTIAL_TITLE:'');
    d.appendChild(st); d.appendChild(p);
    // 행 인라인 동작 (FR-GIT-64·65·89). 그룹이 할 수 있는 것만 붙인다.
    const acts=document.createElement('span'); acts.className='git-file-acts';
    for(const a of (GIT_ROW_ACTS[group]||[])){
      const b=document.createElement('button');
      b.className='git-file-act'; b.dataset.act=a;
      b.textContent=GIT_ACT_LABEL[a];
      // ours·theirs 는 진행 중인 조작에 따라 뜻이 뒤집힌다 (FR-GIT-224).
      b.title=(a==='ours'||a==='theirs')
        ? (GIT_SIDE_TITLE[this._op()]||GIT_SIDE_TITLE[''])[a]
        : GIT_ACT_TITLE[a];
      b.addEventListener('click',ev=>{
        ev.stopPropagation();
        // FR-GIT-236: Open File 은 선택을 끌어오지 않는다 — `_rowTargets` 는 쓰기
        // 동작의 규약이고, 그것을 그대로 쓰면 고른 수만큼 편집기 탭이 열린다.
        this._run(a, a==='openFile'
          ? [{group,path:e.path,origPath:e.origPath||''}]
          : this._rowTargets(a,group,e.path,e.origPath));
      });
      acts.appendChild(b);
    }
    d.appendChild(acts);
    d.addEventListener('click',ev=>this._select(group,e,ev));
    d.addEventListener('dblclick',()=>this._openDiff(group,e));
    d.addEventListener('contextmenu',ev=>{
      ev.preventDefault();
      GitMenu.open('file',{group,path:e.path,origPath:e.origPath||''},ev);
    });
    return d;
  }

  /**
   * FR-GIT-237: 경로 표시를 디렉터리와 파일명으로 가른다.
   *
   * **합쳐진 글자는 바뀌지 않는다** — 요소를 나누는 것이지 글자를 바꾸는 것이
   * 아니다. 대비는 색과 굵기로 내고 색은 테마 변수에서 파생한다 (`style.css`).
   */
  _fillPath(p,e){
    const seg=full=>{
      const i=full.lastIndexOf('/');
      // 디렉터리가 없는 경로는 그 요소를 **만들지 않는다** — 빈 요소가 자리를
      // 먹으면 안 된다.
      if(i>=0){
        const d=document.createElement('span');
        d.className='git-file-path-dir'; d.textContent=full.slice(0,i+1);
        p.appendChild(d);
      }
      const n=document.createElement('span');
      n.className='git-file-path-name'; n.textContent=full.slice(i+1);
      p.appendChild(n);
    };
    // rename/copy 는 원본과 대상을 둘 다 보인다 (FR-GIT-36) — 같은 규칙을 두 번
    // 적용하고 화살표만 가장 약하게 둔다. 예외를 만들지 않는다.
    if(e.origPath){
      seg(e.origPath);
      const a=document.createElement('span');
      a.className='git-file-path-arrow'; a.textContent=' → ';
      p.appendChild(a);
      seg(e.path);
      return;
    }
    // 트리 보기는 디렉터리가 이미 행으로 갈려 있어 파일명만 남는다.
    seg(this._treeMode()?e.path.split('/').pop():e.path);
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

  // ── 스테이징 (FR-GIT-64~73) ──

  // 커밋 영역은 지연 생성한다 — Git 창을 열지 않은 브라우저 창은 만들지 않는다.
  _commit(){
    if(!this._commitView) this._commitView=new GitCommit(this);
    return this._commitView;
  }

  // ── 원격 작업 (FR-GIT-98~112) ──

  // 원격 조각도 지연 생성한다. 진행 중 작업의 상태를 들고 있으므로 Changes 탭의
  // 골격보다 오래 산다.
  _remote(){
    if(!this._remoteView) this._remoteView=new GitRemote(this);
    return this._remoteView;
  }

  // 상태바 폴링이 받은 진행 중 작업 목록 (FR-GIT-101·112). 같은 리포의 작업이면
  // 원격 버튼이 막히고 출력이 이어진다.
  adoptJobs(jobs){
    if(!this._remoteView&&!(jobs||[]).length) return;
    this._remote().adoptJobs(jobs);
  }

  // 그룹 하나를 펼친다. pull 이 충돌로 끝나면 충돌 그룹이 접혀 있어서는 안 된다
  // (FR-GIT-111).
  expandGroup(key){
    if(!this._collapsed.has(key)) return;
    this._collapsed.delete(key);
    this._paint();
  }

  // ── History 탭 (FR-GIT-113~139) ──

  _history(){
    if(!this._historyView) this._historyView=new GitHistory(this);
    return this._historyView;
  }

  _renderHistory(el){
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      // 골격을 버렸으므로 History 도 자기 DOM 을 놓아야 한다.
      this._history().unmount();
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1'){this._history().mount(el);el.dataset.built='1'}
    this._history().paint();
  }

  // ── Branches 탭 (FR-GIT-147~160) ──

  _branches(){
    if(!this._branchesView) this._branchesView=new GitBranches(this);
    return this._branchesView;
  }

  _renderBranches(el){
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      this._branches().unmount();
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1'){this._branches().mount(el);el.dataset.built='1'}
    this._branches().paint();
  }

  // ── Console 탭 (FR-GIT-218) ──

  _console(){
    if(!this._consoleView) this._consoleView=new GitConsole(this);
    return this._consoleView;
  }

  _renderConsole(el){
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      this._console().unmount();
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1'){this._console().mount(el);el.dataset.built='1'}
    this._console().paint();
  }

  // ── Worktrees 탭 (GIT_REVIEW4_SRS §3.6.5 / FR-GIT-240~244) ──

  _worktrees(){
    if(!this._worktreesView) this._worktreesView=new GitWorktrees(this);
    return this._worktreesView;
  }

  _renderWorktrees(el){
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      this._worktrees().unmount();
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1'){this._worktrees().mount(el);el.dataset.built='1'}
    this._worktrees().paint();
  }

  // ── Stash 탭 (FR-GIT-161~170) ──

  _stash(){
    if(!this._stashView) this._stashView=new GitStash(this);
    return this._stashView;
  }

  _renderStash(el){
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      this._stash().unmount();
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1'){this._stash().mount(el);el.dataset.built='1'}
    this._stash().paint();
  }

  // 마지막 유효 status. Branches 의 현재 브랜치와 Stash 의 "담을 것이 있는지" 가
  // 같은 값을 딛는다 (FR-GIT-152·167).
  statusOf(){return (this._status&&this._status.status)||null}

  // 지금 HEAD 가 가리키는 이름. detached 면 커밋 해시다 — 둘을 같게 보면 detached
  // 로 옮겨 간 것을 목록이 알아채지 못한다.
  headName(){
    const s=this.statusOf(); if(!s) return null;
    return s.detached?('#'+(s.oid||'')):(s.branch||'');
  }

  // ── 브랜치·태그 쓰기 (GIT_MENUS branch·tag 가 부른다) ──
  // 실행은 git-branches.js 에 있다 — 메뉴는 History 의 refs 사이드바에서도 열리므로
  // Branches 탭 인스턴스에 묶여 있으면 그쪽에서 쓸 수 없다.

  checkoutRef(ref,o){return GitBranches.checkout(this,ref,o||{})}
  checkoutRemote(short){return GitBranches.checkoutRemote(this,short)}

  // FR-GIT-249: 핀 목록이 바뀌었을 수 있다. 그것을 읽는 목록에만 넘긴다 — 판정을
  // 다시 그리기에 업지 않기 위한 통지 경로다 (FR-RPT-8, GitDialog.notify 와 같은 규약).
  notifyPins(){
    if(this._worktreesView) this._worktreesView.notifyPins();
  }

  // FR-GIT-141: 커밋 우클릭의 "여기서 브랜치 생성". 18단계의 생성 다이얼로그에
  // 시작점만 고정해 넘긴다 — 이름 검증도 그것이 이미 안다 (FR-GIT-158·159).
  createBranchFrom(oid){return GitBranches.create(this,{startRef:oid||''})}

  // ── 태그 쓰기 (GIT_MENUS tag·commit 이 부른다, FR-GIT-260~262) ──
  // 실행은 git/tag.js 에 있다 — 브랜치와 같은 이유로 static 이다: 태그 메뉴는
  // History 의 커밋 배지에서도 열린다.
  //
  // 삭제가 둘인 것은 로컬과 원격이 **다른 항목**이기 때문이다 (FR-GIT-261).

  createTag(oid){return GitTag.create(this,{ref:oid||''})}
  tagDelete(name){return GitTag.deleteLocal(this,name)}
  tagDeleteRemote(name){return GitTag.deleteRemote(this,name)}
  tagPush(name){return GitTag.push(this,name,false)}
  tagPushAll(){return GitTag.push(this,'',true)}

  /**
   * ref 를 바꾼 쓰기 하나의 뒷정리 (FR-GIT-160·170).
   *
   * 응답에 실린 실행 후 status 로 화면을 갱신하고 **refs 를 다시 받는다** — status
   * 만으로는 새 브랜치가 생겼는지, 어느 것이 사라졌는지 알 수 없다.
   */
  afterRefWrite(d){
    this.adopt(d);
    if(this._branchesView) this._branchesView.reload();
    if(this._historyView) this._historyView.reloadRefs();
  }

  // ── stash 쓰기 (GIT_MENUS stash 가 부른다) ──

  async stashApply(index,withIndex){
    const res=await this.post('/api/git/stash/apply',
      {repo:this.repo,index,withIndex:!!withIndex});
    this.afterStashWrite(res);
  }

  async stashPop(index){
    const res=await this.post('/api/git/stash/pop',{repo:this.repo,index});
    this.afterStashWrite(res);
  }

  // drop 은 파괴적이다 (FR-GIT-89·168). 2단계 확인과 recovery hint 는 GitMenu 가
  // 이미 거쳤으므로 여기서는 `confirm` 을 실어 보낸다 — 서버도 그것을 요구한다.
  async stashDrop(index){
    const res=await this.post('/api/git/stash/drop',
      {repo:this.repo,index,confirm:true});
    this.afterStashWrite(res);
  }

  /**
   * stash 쓰기 하나의 뒷정리 (FR-GIT-165·170).
   *
   * **실패 응답도 status 와 목록을 싣고 온다** — pop 이 충돌로 끝나면 stash 가
   * 남으므로 그 사실을 Stash 탭이 그 자리에서 알려야 한다.
   */
  afterStashWrite(res){
    const d=(res&&res.data)||{};
    if(d.status) this.adopt(d);
    // 실패 사유는 Stash 탭이 보인다 — Changes 탭의 안내로 보내면 사용자가 조작한
    // 자리에서 결과를 읽을 수 없다.
    this._stash().adoptWrite(res);
  }

  // ── 묶음 F — stash·파일·미커밋 행 (FR-GIT-272~275·277) ──
  // 실행은 도메인별 클래스에 있다 — 여기 있는 것은 메뉴가 부르는 한 줄뿐이다.

  // FR-GIT-272: Branch from stash. 다이얼로그는 git-stash.js 가 안다.
  stashBranch(s){return new GitStashBranch(this,s)._show()}

  // FR-GIT-277: 미커밋 행의 Stash. 생성 다이얼로그를 그대로 다시 쓴다.
  stashCreate(){return new GitStashCreate(this)._show()}

  /**
   * stash 쓰기이면서 **ref 도 바꾸는** 것의 뒷정리 (FR-GIT-160·170).
   *
   * Branch from stash 하나가 그것이다 — stash 목록과 refs 가 함께 바뀌므로 둘 다
   * 다시 받는다. status 만으로는 새 브랜치가 생겼는지 알 수 없다.
   */
  afterStashRefWrite(res){
    this.afterStashWrite(res);
    if(!res||!res.ok) return;
    if(this._branchesView) this._branchesView.reload();
    if(this._historyView) this._historyView.reloadRefs();
  }

  // FR-GIT-277: untracked 경로들. Clean 의 대상 목록과 비활성 판정이 같은 값을
  // 딛는다 — 두 벌로 두면 한쪽만 고쳐진다.
  untrackedPaths(){
    const s=this.statusOf();
    return ((s&&s.untracked)||[]).map(e=>e.path);
  }

  // mixed 다 — index 만 HEAD 로 되돌리고 워킹 트리는 그대로 둔다.
  async uncommittedReset(){
    if(this._writing) return;
    const res=await this.post('/api/git/uncommitted/reset',{repo:this.repo});
    this._after(res,[]);
  }

  // **파괴적이다** (FR-GIT-277). 2단계 확인과 recovery hint 는 GitMenu 가 이미
  // 거쳤으므로 여기서는 `confirm` 을 실어 보낸다 — 서버도 그것을 요구한다.
  async uncommittedClean(){
    if(this._writing) return;
    const res=await this.post('/api/git/uncommitted/clean',
      {repo:this.repo,confirm:true});
    this._after(res,[]);
  }

  /**
   * FR-GIT-273: 경로를 `.gitignore` 에 덧붙인다. **git 실행이 아니라 파일 쓰기다.**
   *
   * 이미 있던 줄은 서버가 `skipped` 로 답한다 — "추가했습니다" 로 뭉개면 사용자는
   * 아무 일도 아니었던 것을 성공으로 읽는다 (V200).
   */
  async ignorePath(t){
    if(!t||!t.path||this._writing) return;
    const res=await this.post('/api/git/ignore',{repo:this.repo,paths:[t.path]});
    if(!res.ok){
      this._note={msg:GIT_IGNORE_FAIL+': '+this.writeError(res)};
      this._paint();
      return;
    }
    const d=res.data||{};
    this._after(res,[]);
    // 이미 있던 줄은 `skipped` 로 온다 — 그 사실을 보이지 않으면 사용자는 아무 일도
    // 아니었던 것을 성공으로 읽는다 (V200).
    if(!(d.added||[]).length){this._note={msg:GIT_IGNORE_DUP+': '+t.path};this._paint()}
  }

  // FR-GIT-275: path 필터를 채워 History 탭을 연다. **새 조회를 만들지 않는다** —
  // 필터는 FR-GIT-129 로 이미 있다.
  openFileHistory(t){
    if(!t||!t.path) return;
    // **탭을 먼저 연다.** 아직 마운트되지 않은 History 는 mount 가 `_repo` 를 비우고,
    // 그 뒤 첫 paint 의 `_adopt` → `reset` 이 방금 채운 필터를 지운다. 열어 둔 뒤에
    // 채우면 두 경우 모두 성립한다 — 이미 받아들였으면 그대로, 아니면 filterPath 가
    // 스스로 받아들인다.
    this.openView('history');
    this._history().filterPath(t.path);
  }

  /**
   * FR-GIT-274: 워킹 트리가 아니라 `HEAD:<path>` 의 내용을 연다.
   *
   * 여는 자리는 Open File 과 같은 규약이다 — Git 창이 아닌 창이다
   * (FR-GIT-179·185). 조회는 서버가 diff 의 `cat-file` 경로를 그대로 쓴다.
   */
  async openFileAtHead(t){
    if(!t||!t.path||!this.repo) return;
    const q=new URLSearchParams({repo:this.repo,path:t.path});
    let r=null,d=null;
    try{r=await fetch('/api/git/file-head?'+q.toString())}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    if(!r||!r.ok||!d||!d.openPath){
      // 사유를 그 자리에 보인다 — 빈 편집기를 열면 사용자는 파일이 비었다고 읽는다.
      this._note={msg:GIT_HEAD_OPEN_FAIL+((d&&d.message)?': '+d.message:'')};
      this._paint();
      return;
    }
    this._note=null;
    this.app._gitOpenFileHead(d.openPath,t.path);
  }

  // 워킹 트리에 남은 변경의 개수. History 의 미커밋 변경 행(FR-GIT-127)과
  // checkout 의 dirty 판정(FR-GIT-157)이 같은 값을 딛는다.
  dirtyCount(){
    const s=this._status&&this._status.status; if(!s) return 0;
    let n=0;
    for(const g of GIT_GROUPS) n+=(s[g.key]||[]).length;
    return n;
  }

  isDirty(){return this.dirtyCount()>0}

  /**
   * FR-GIT-138: 커밋 상세의 파일을 Diff 탭에 `commit-parent` 축으로 보인다.
   *
   * f 는 {repo,axis,path,origPath,oid,parentOid} 다 — 그대로 질의 인자가 된다.
   * `parentOid` 가 비면 루트 커밋이고 original 쪽이 absent 로 온다 (오류가 아니다).
   * 머지 커밋에서는 고른 부모의 oid 가 들어온다 (FR-GIT-139).
   */
  showCommitDiff(f){
    if(!f||!f.oid) return;
    this.commitFile=f;
    this.openView('diff');
    this._paint();
  }

  // Diff 탭이 보일 대상. 커밋 축이 있으면 그것이 먼저다 — Changes 탭의 미리보기는
  // previewFile 만 본다 (§3.2).
  _diffTarget(){return this.commitFile||this.previewFile}

  _selKey(group,path){return group+'\x00'+path}

  _group(key){
    const s=this._status&&this._status.status;
    return (s&&s[key])||[];
  }

  // 선택은 status 에 남아 있는 것만 뜻한다 — 사라진 경로의 선택은 저절로 잊힌다.
  _selected(){
    const out=[];
    for(const g of GIT_GROUPS)
      for(const e of this._group(g.key))
        if(this._sel.has(this._selKey(g.key,e.path)))
          out.push({group:g.key,path:e.path,origPath:e.origPath||''});
    return out;
  }

  // rename 은 index 에서 (원본 삭제 + 대상 추가) 두 경로다 (FR-GIT-36). 대상만
  // 되돌리면 원본의 삭제가 index 에 남아 **반쪽만 언스테이지된다** — 짝을 함께
  // 보낸다. stage 는 원본이 워킹 트리에 없으므로 대상만 보낸다.
  _paths(act,items){
    const out=[];
    for(const i of items){
      out.push(i.path);
      if(act==='unstage'&&i.origPath) out.push(i.origPath);
    }
    return out;
  }

  // 동작이 뜻을 갖는 대상만 남긴다 — staged 행을 stage 하거나 untracked 행을
  // unstage 하는 것은 아무 일도 하지 않는다.
  _fit(act,items){
    if(act==='unstage') return items.filter(i=>i.group!=='untracked');
    return items.filter(i=>i.group!=='staged');
  }

  /**
   * FR-GIT-208: 행 인라인 버튼의 대상.
   *
   * 누른 행이 **선택 안에 있으면 선택 전체**가, 밖이면 그 행 하나가 대상이다 —
   * 여러 개를 골라 두고 그 중 아무 행에서나 누르면 골라 둔 것에 걸린다.
   * 선택 밖의 행을 누르는 것은 "이 행만" 이라는 뜻이므로 선택을 끌어오지 않는다.
   */
  _rowTargets(act,group,path,origPath){
    const one=[{group,path,origPath:origPath||''}];
    if(!this._sel.has(this._selKey(group,path))) return this._fit(act,one);
    const all=this._fit(act,this._selected());
    return all.length?all:this._fit(act,one);
  }

  // Shift 는 화면에 보이는 순서대로 범위를 고른다 (FR-GIT-69) — 그룹 경계를
  // 넘어도 목록의 순서가 그대로 기준이다.
  _range(group,path){
    const el=this._els.get('changes'); if(!el) return;
    const rows=Array.from(el.querySelectorAll('.git-file'));
    const at=r=>rows.findIndex(x=>x.dataset.group===r.group&&x.dataset.path===r.path);
    const a=at(this._anchor),b=at({group,path});
    if(a<0||b<0){this._sel.add(this._selKey(group,path));return}
    const lo=Math.min(a,b),hi=Math.max(a,b);
    for(let i=lo;i<=hi;i++)
      this._sel.add(this._selKey(rows[i].dataset.group,rows[i].dataset.path));
  }

  // 그룹 일괄은 그려진 행이 아니라 그룹 **전체**다 (FR-GIT-66·67) — 목록이
  // 잘려 보이는 것과 대상 범위는 별개다.
  _bulk(group,act){
    this._run(act,this._group(group).map(e=>({group,path:e.path,origPath:e.origPath||''})));
  }

  // 쓰기 한 번의 단일 경로다. 충돌 stage 의 뜻 알림과 discard 의 2단계 확인이
  // 여기서 갈린다.
  async _run(act,items){
    if(!items.length||!this.repo) return;
    // FR-GIT-236: Open File 은 쓰기가 아니므로 진행 중인 쓰기에 막히지 않는다.
    // 우클릭 메뉴도 이 자리를 지난다 — 두 벌로 두면 한쪽만 고쳐진다.
    if(act==='openFile'){
      for(const i of items) this.app._gitOpenFile(this.absPath(i));
      return;
    }
    if(this._writing) return;
    if(act==='discard'){this._discard(items);return}
    if(act==='ours'||act==='theirs'){this._resolveSide(act,items);return}
    // FR-GIT-72: 충돌 파일의 stage 는 "해결됨 표시" 다. 실행 **전에** 그 뜻을
    // 알린다. 파괴적이 아니므로 1단계 확인이다.
    const conflicts=items.filter(i=>i.group==='conflicts').map(i=>i.path);
    if(act==='stage'&&conflicts.length){
      const ok=await GitDialog.confirm({
        action:GIT_ACT_RESOLVE,title:GIT_RESOLVE_TITLE,targets:conflicts,
        hint:{note:GIT_RESOLVE_NOTE,command:'git reset -q HEAD -- '+conflicts.map(gitShQuote).join(' ')},
        stages:1,
      });
      if(!ok) return;
    }
    const url=act==='stage'?'/api/git/stage':'/api/git/unstage';
    const res=await this.post(url,{repo:this.repo,paths:this._paths(act,items)});
    this._after(res,items);
  }

  /**
   * 진행 중인 조작. preflight 가 이미 안다 — 두 번 묻지 않는다.
   * 모르면 빈 문자열이고, 그때 툴팁은 양쪽을 다 밝힌다 (FR-GIT-224).
   */
  _op(){
    const pf=this._commit()._pf;
    for(const b of (pf&&pf.blocks)||[]){
      const op=GIT_OP_BY_BLOCK[b.code];
      if(op) return op;
    }
    return '';
  }

  /**
   * 충돌 파일을 한쪽으로 받아 해결한다 (FR-GIT-224).
   *
   * **파괴적이다** — 워킹 트리의 충돌 표식과 손대던 내용이 사라지고 git 에 저장된
   * 적이 없어 되살릴 값이 없다. discard 와 같은 규약을 지난다: 판정은 서버의
   * 목록이 하고(GitConfirm), 확인은 2단계이며, 요청에 confirm 을 함께 보낸다.
   */
  async _resolveSide(side,items){
    const paths=items.filter(i=>i.group==='conflicts').map(i=>i.path);
    if(!paths.length) return;
    const repo=this.repo;
    const label=(GIT_SIDE_TITLE[this._op()]||GIT_SIDE_TITLE[''])[side];
    await GitDialog.confirm({
      action:GIT_ACT_RESOLVE_SIDE,
      title:GIT_RESOLVE_SIDE_TITLE,
      targets:paths,
      hint:{note:label+'. '+GIT_RESOLVE_SIDE_NOTE,
        command:'git checkout -m -- '+paths.map(gitShQuote).join(' ')},
      run:async()=>{
        const res=await this.post('/api/git/resolve',{repo,side,paths,confirm:true});
        this._after(res,items);
        if(res.ok) return {ok:true};
        return {ok:false,reason:this.writeReason(res),stderrTail:(res.data&&res.data.message)||''};
      },
    });
  }

  // discard 는 파괴적이다 (FR-GIT-89). 판정은 서버의 목록이 하고(GitConfirm),
  // 확인은 2단계이며, 실행 요청에는 confirm 을 함께 보낸다 — 서버도 그것을
  // 요구한다.
  async _discard(items){
    const tracked=items.filter(i=>i.group!=='untracked').map(i=>i.path);
    const untracked=items.filter(i=>i.group==='untracked').map(i=>i.path);
    const targets=tracked.concat(untracked);
    if(!targets.length) return;
    const repo=this.repo;
    await GitDialog.confirm({
      action:GIT_ACT_DISCARD,title:GIT_DISCARD_TITLE,targets,
      // O8: stash 를 자동 생성하지 않는다 — 실행할 명령을 보여 준다.
      hint:{note:GIT_DISCARD_NOTE,command:'git stash push -- '+targets.map(gitShQuote).join(' ')},
      run:async()=>{
        const res=await this.post('/api/git/discard',{repo,tracked,untracked,confirm:true});
        this._after(res,items);
        if(res.ok) return {ok:true};
        // 사유와 stderr tail 은 다이얼로그 안에서 보인다 (FR-GIT-96·175).
        return {ok:false,reason:this.writeReason(res),stderrTail:(res.data&&res.data.message)||''};
      },
    });
  }

  // 쓰기 응답 하나의 처리. 성공이면 안내를 지우고 처리한 대상을 선택에서 뺀다.
  _after(res,items){
    if(res.ok){
      this._note=null;
      for(const i of items) this._sel.delete(this._selKey(i.group,i.path));
      this.adopt(res.data);
      return;
    }
    this.applyWriteFail(res);
  }

  // FR-GIT-73 · §7.1 I2: 실패를 조용히 넘기지 않는다. 부분 적용이면 무엇이
  // 바뀌었는지까지 보인다 — git 이 주지 않는 원자성을 흉내 내지 않는다.
  applyWriteFail(res){
    const d=res.data||{};
    this._note={msg:this.writeError(res),partial:!!d.partial,changed:d.changed||[]};
    if(d.status) this.adopt(d); else this._paint();
  }

  // POST 한 번. ok 는 **서버가 ok:true 를 준 것**이다 — 200 이지만 본문이 없는
  // 응답을 성공으로 읽지 않는다.
  async post(url,body){
    this._writing=true;
    let r=null,d=null;
    try{
      r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body)});
    }catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    this._writing=false;
    // 모든 쓰기가 이 한 곳을 지난다 — 방금 실행한 명령이 Console 의 맨 위에
    // 있어야 한다 (FR-GIT-218).
    if(this._consoleView) this._consoleView.reload();
    return {ok:!!(r&&r.ok&&d&&d.ok),code:r?r.status:0,data:d};
  }

  writeReason(res){
    const d=res.data||{};
    return GIT_WRITE_ERR[d.error]||GIT_WRITE_FAIL;
  }

  writeError(res){
    const m=(res.data&&res.data.message)||'';
    return this.writeReason(res)+(m?': '+m:'');
  }

  // 응답에 실린 **실행 후** status 로 화면을 즉시 갱신한다 (FR-GIT-71) — 폴링
  // 주기를 기다리지 않는다.
  //
  // signature 는 쓰기 응답에 없으므로 _lastSig 를 그대로 둔다. 다음 signature
  // 폴링이 차이를 보고 한 번 더 재조회하는 것은 해롭지 않다.
  adopt(d){
    if(!d||!d.status||d.requested!==this.repo) return;
    this._status=Object.assign({},this._status||{},
      {requested:d.requested,repo:d.repo,status:d.status});
    this._errMsg=null; this._staleNote=false;
    // 사용자가 부른 쓰기의 응답이다 — 화면은 반드시 바뀐다 (FR-RPT-5). 다만 근거는
    // 갱신해 둔다: 곧 오는 폴링이 같은 관측으로 한 번 더 그리지 않게 한다.
    this._obsSig=JSON.stringify(d.status||null);
    this._paint();
    this.app._gitReposRefresh();
    this.app._updateStatusBar();
  }

  /**
   * 진행 중 작업 줄 (FR-GIT-252).
   *
   * **출구 목록은 서버가 준다** (`/api/git/policy` 의 operations) — 여기서 복제하면
   * merge 에 없는 Skip 이 생기고, 눌리면 exit 128 로만 실패한다. 아직 못 받았으면
   * 버튼을 그리지 않는다: 없는 버튼을 그리는 것보다 안 그리는 쪽이 안전하다.
   */
  _paintOp(el,s){
    const box=el.querySelector('.git-op-bar'); if(!box) return;
    const op=(s&&s.operation)||null;
    const kind=(op&&op.kind)||'';
    box.classList.toggle('vis',!!kind);
    box.dataset.kind=kind;
    if(!kind) return;
    box.querySelector('.git-op-kind').textContent=GIT_OP_LABEL[kind]||kind;
    // 리베이스의 "몇 번째 중". 알 수 없으면 비운다 — 반쪽짜리 진행 표시는 없는
    // 것보다 나쁘다.
    box.querySelector('.git-op-at').textContent=(op.total>0)
      ? GIT_OP_AT.replace('%n',String(op.at||0)).replace('%t',String(op.total)) : '';
    const acts=this._opActions(kind);
    for(const b of box.querySelectorAll('.git-op-act'))
      b.classList.toggle('vis',acts.indexOf(b.dataset.act)>=0);
  }

  // 정책은 한 번만 받아 들고 있는다. 받으면 그때 다시 그린다 — 판정을 그리기에
  // 업지 않는다 (FR-RPT-8).
  _opActions(kind){
    if(this._opActs) return this._opActs[kind]||[];
    if(!this._opActsP){
      this._opActsP=GitConfirm.policy().then(p=>{
        this._opActs=(p&&p.operations)||{};
        this._opActsP=null;
        this._paint();
      });
    }
    return [];
  }

  /**
   * 출구 하나를 실행한다 (FR-GIT-252).
   *
   * **중단만 2단계 확인이다** — 그 작업 중 해결한 내용이 사라지고 되살릴 값이 없다.
   * 계속·건너뛰기는 되돌릴 것이 없다. 서버도 같은 것을 요구한다(confirm) —
   * 클라이언트만 막으면 API 직접 호출이 우회한다.
   */
  runOperation(action){
    const op=(this.statusOf()||{}).operation||{};
    const kind=op.kind||''; if(!kind) return;
    if(action!==GIT_OP_ABORT) return this._runOp(kind,action,false);
    return GitDialog.confirm({
      action:GIT_ACT_OP_ABORT,title:GIT_OP_ABORT_TITLE,
      targets:[GIT_OP_LABEL[kind]||kind],
      hint:{note:GIT_OP_ABORT_NOTE,command:'git '+kind+' --abort'},
      stages:2,
      run:async()=>{
        const res=await this._runOp(kind,action,true);
        if(res.ok) return {ok:true};
        return {ok:false,reason:this.writeReason(res),
          stderrTail:(res.data&&res.data.message)||''};
      },
    });
  }

  async _runOp(kind,action,confirm){
    const res=await this.post('/api/git/operation',
      {repo:this.repo,kind,action,confirm:!!confirm});
    if(res.ok){this._note=null; this.adopt(res.data)}
    else this.applyWriteFail(res);
    return res;
  }

  _paintNote(el){
    const box=el.querySelector('.git-partial-note'); if(!box) return;
    const n=this._note;
    box.classList.toggle('vis',!!n);
    box.querySelector('.git-partial-msg').textContent=
      n?(n.partial?n.msg+' — '+GIT_PARTIAL_NOTE:n.msg):'';
    const ul=box.querySelector('.git-partial-list'); ul.innerHTML='';
    for(const p of (n&&n.changed)||[]){
      const li=document.createElement('li'); li.className='git-partial-path';
      li.textContent=p; ul.appendChild(li);
    }
  }

  // ── 선택과 이동 (FR-GIT-52) ──

  /**
   * FR-GIT-52·188: 행 클릭 하나가 **선택과 미리보기를 함께** 정한다.
   *
   * - 클릭: 선택을 그 행 하나로 바꾼다. 앵커도 그 행이다.
   * - `Cmd`/`Ctrl` + 클릭: 그 행을 토글한다.
   * - `Shift` + 클릭: 앵커부터 그 행까지 범위로 **바꾼다** (더하지 않는다) —
   *   더하면 앵커를 옮길 때마다 선택이 눈덩이처럼 불어난다.
   *
   * 어느 경우든 미리보기는 방금 누른 행이다. 그것이 포커스 행이다.
   */
  _select(group,e,ev){
    const key=this._selKey(group,e.path);
    const multi=!!(ev&&(ev.metaKey||ev.ctrlKey));
    const range=!!(ev&&ev.shiftKey&&this._anchor);
    if(range){
      this._sel.clear();
      this._range(group,e.path);
    }else if(multi){
      if(this._sel.has(key)) this._sel.delete(key); else this._sel.add(key);
      this._anchor={group,path:e.path};
    }else{
      this._sel.clear(); this._sel.add(key);
      this._anchor={group,path:e.path};
    }
    // 워킹 트리 파일을 골랐다 — 커밋 축의 대상은 놓는다.
    this.commitFile=null;
    this.previewFile={
      repo:this.repo,group,axis:GIT_GROUP_AXIS[group],
      path:e.path,origPath:e.origPath||'',
    };
    const i=this._diffIndex(this._fileList());
    if(i>=0) this._diffPos=i;
    this._paint();
  }

  _openDiff(group,e){
    this._select(group,e);
    this.openView('diff');
  }

  // 고정 탭 하나를 활성화한다 (FR-GIT-28). History 의 미커밋 변경 행이 Changes 를
  // 여는 것과 파일 클릭이 Diff 를 여는 것이 같은 경로다.
  openView(view){
    const w=this.app._gitWindow(); if(!w||!w.layout) return;
    for(const pn of this.app._flattenPanes(w.layout)){
      const t=(pn.tabs||[]).find(x=>x.type===TAB_TYPE_GIT&&x.gitView===view);
      if(t){this.app.switchTab(pn.id,t.id);return}
    }
  }

  // 미리보기는 Diff 탭과 같은 뷰를 좁은 자리에 둔 것이다 (§3.2·§3.4). 골격은 한 번만
  // 세운다 — 폴링마다 다시 만들면 Monaco 인스턴스가 매초 버려진다.
  _paintPreview(el){
    const p=el.querySelector('.git-preview'); if(!p) return;
    if(p.dataset.built!=='1'){
      p.innerHTML='<div class="git-preview-target">'+
        '<div class="git-preview-path"></div><div class="git-preview-axis"></div></div>'+
        '<div class="git-preview-body"></div>';
      p.querySelector('.git-preview-body').appendChild(this._preview().el);
      p.dataset.built='1';
    }
    const f=this.previewFile;
    const t=p.querySelector('.git-preview-target');
    t.classList.toggle('vis',!!f);
    t.querySelector('.git-preview-path').textContent=
      f?(f.origPath?f.origPath+' → '+f.path:f.path):'';
    t.querySelector('.git-preview-axis').textContent=f?(GIT_AXIS_LABEL[f.axis]||f.axis):'';
    this._showTarget(this._preview(),f,'_prevKey');
  }

  // ── Diff 탭 (FR-GIT-49~56) ──

  _renderDiff(el){
    if(el.dataset.built!=='1') this._buildDiff(el);
    this._paintDiff(el);
  }

  _buildDiff(el){
    el.innerHTML=
      '<div class="git-diff-bar">'+
        '<button class="git-diff-nav" data-nav="prev">\u2039</button>'+
        '<button class="git-diff-nav" data-nav="next">\u203a</button>'+
        '<span class="git-diff-path"></span>'+
        '<span class="git-diff-pos"></span>'+
        '<span class="git-diff-gone"></span>'+
        '<span class="git-diff-rev"></span>'+
        '<span class="git-diff-spacer"></span>'+
        '<button class="git-diff-mode"></button>'+
        '<label class="git-diff-ws"><input type="checkbox"></label>'+
      '</div>'+
      '<div class="git-diff-body"></div>'+
      // 부분 스테이징의 자리다 (FR-GIT-278). Monaco 는 두 모델을 그릴 뿐이고
      // hunk 의 경계를 모른다 — 조각과 그 동작은 서버가 준 경계 위에 선다.
      '<div class="git-hunks"></div>';
    el.querySelector('.git-diff-ws').appendChild(document.createTextNode(GIT_DIFF_WS_LABEL));
    el.querySelector('.git-diff-body').appendChild(this._diff().el);
    el.querySelector('.git-hunks').addEventListener('click',ev=>this._hunkClick(ev));
    for(const b of el.querySelectorAll('.git-diff-nav'))
      b.addEventListener('click',()=>this._diffMove(b.dataset.nav==='next'?1:-1));
    el.querySelector('.git-diff-mode').addEventListener('click',()=>this._toggleSideBySide());
    el.querySelector('.git-diff-ws input')
      .addEventListener('change',ev=>this._setIgnoreWs(ev.target.checked));
    el.dataset.built='1';
  }

  _paintDiff(el){
    const list=this._fileList();
    // 커밋 축의 대상은 워킹 트리 목록에 없다 — ‹ › 와 n/m 과 "사라졌습니다" 는
    // 그 목록의 것이므로 커밋 축에서는 뜻이 없다 (FR-GIT-53).
    const cf=this.commitFile;
    const f=this._diffTarget();
    const i=cf?-1:this._diffIndex(list);
    if(i>=0) this._diffPos=i;
    // 목록이 비면 0/0 이고 ‹ › 는 disabled 다.
    for(const b of el.querySelectorAll('.git-diff-nav')) b.disabled=!list.length||!!cf;
    el.querySelector('.git-diff-path').textContent=
      f?(f.origPath&&f.origPath!==f.path?f.origPath+' \u2192 '+f.path:f.path):'';
    el.querySelector('.git-diff-pos').textContent=
      cf?'':(list.length?(i>=0?(i+1)+'/'+list.length:'\u2013/'+list.length):'0/0');
    // 대상이 목록에서 사라졌으면(커밋·discard) 그 사실만 알린다 — 아무 파일이나
    // 임의로 보이지 않는다 (§3.3).
    const gone=el.querySelector('.git-diff-gone');
    const lost=!cf&&!!(f&&i<0&&list.length);
    gone.textContent=lost?GIT_DIFF_GONE_NOTE:'';
    gone.classList.toggle('vis',lost);
    // 커밋 축은 어느 두 리비전을 비교하는지 함께 보인다 (FR-GIT-139).
    const rev=el.querySelector('.git-diff-rev');
    rev.textContent=cf?this._revLabel(cf):'';
    rev.classList.toggle('vis',!!cf);
    el.querySelector('.git-diff-mode').textContent=
      this._sideBySidePref()?GIT_DIFF_MODE_LABEL.side:GIT_DIFF_MODE_LABEL.inline;
    el.querySelector('.git-diff-ws input').checked=this._ignoreWsPref();
    this._showTarget(this._diff(),f,'_diffKey');
    this._paintHunks(el,cf?null:f);
  }

  // ── 부분 스테이징 (FR-GIT-278·279) ──
  //
  // 패치는 **서버가 만든다** (D6). 여기서 만드는 것은 좌표뿐이다 —
  // (경로, 축, hunk 번호, 줄 범위, 관측 식별자). 패치 문자열을 조립하는 코드가
  // 이 파일에 없어야 하고, 있으면 그것이 임의 쓰기 표면이 된다.

  _paintHunks(el,f){
    const box=el.querySelector('.git-hunks'); if(!box) return;
    const on=!!(f&&f.repo&&GIT_HUNK_AXES.has(f.axis));
    box.classList.toggle('vis',on);
    if(!on){
      this._hunkKey=null; this._hunks=null; this._hunkSel=null;
      box.dataset.sig=''; box.innerHTML=''; return;
    }
    // 대상이 그대로면 다시 부르지 않는다 — 폴링마다 재요청하면 스크롤과 줄 선택이
    // 매초 초기화된다 (_showTarget 과 같은 규약).
    const key=[f.repo,f.axis,f.path].join('\u0000');
    if(this._hunkKey!==key){
      this._hunkKey=key; this._hunks=null; this._hunkSel=null;
      // 다른 대상으로 옮겨 갔을 때만 사유를 지운다 — 같은 대상을 다시 받는 것은
      // 방금 그 거부가 일으킨 일이다.
      if(this._hunkErrKey!==key){this._hunkErr=null; this._hunkErrKey=null}
      this._loadHunks(f,key);
    }
    this._drawHunks(box,f);
  }

  async _loadHunks(f,key){
    const tok=this.token();
    const u='/api/git/hunks?repo='+encodeURIComponent(f.repo)+
      '&axis='+encodeURIComponent(f.axis)+'&path='+encodeURIComponent(f.path);
    let r=null,d=null;
    try{r=await fetch(u)}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    if(this.isStale(tok)||this._hunkKey!==key) return;
    // 서버가 되돌려준 요청값도 확인한다 — 같은 세대 안에서도 응답 순서가 뒤바뀔 수
    // 있다 (FR-GIT-54). 짝이 맞지 않는 응답이 화면에 닿아서는 안 된다.
    const q=(d&&d.requested)||{};
    if(!r||!r.ok||!d||q.repo!==f.repo||q.axis!==f.axis||q.path!==f.path){
      this._hunks={err:GIT_HUNK_LOAD_FAIL}; this._paint(); return;
    }
    this._hunks={diffId:d.diffId||'',list:d.hunks||[],note:d.note||''};
    this._paint();
  }

  _drawHunks(box,f){
    const h=this._hunks,sel=this._hunkSel;
    // 같은 관측·같은 선택이면 다시 그리지 않는다 — 폴링마다 다시 그리면 스크롤이
    // 매초 맨 위로 돌아간다.
    const sig=[this._hunkKey,h?(h.err||h.diffId||'-'):'',
      sel?[sel.hunk,sel.from,sel.to].join(','):'',this._hunkErr||'',
      // 쓰기 중에는 버튼이 비활성이다 — 그 상태도 그림의 일부이므로 식별자에 든다.
      this._writing?'w':''].join('\u0000');
    if(box.dataset.sig===sig) return;
    box.dataset.sig=sig;
    box.innerHTML='';
    const note=document.createElement('div');
    note.className='git-hunk-note';
    if(!h){note.textContent=GIT_HUNK_LOADING;box.appendChild(note);return}
    if(h.err){note.textContent=h.err;box.appendChild(note);return}
    if(!h.list.length){note.textContent=h.note||GIT_HUNK_NONE;box.appendChild(note);return}
    note.textContent=this._hunkErr||GIT_HUNK_HINT;
    note.classList.toggle('fail',!!this._hunkErr);
    box.appendChild(note);
    for(const hunk of h.list) box.appendChild(this._hunkEl(hunk,f,sel));
  }

  _hunkEl(hunk,f,sel){
    const has=!!(sel&&sel.hunk===hunk.index);
    const el=document.createElement('div');
    el.className='git-hunk'+(has?' sel':'');
    el.dataset.hunk=String(hunk.index);
    const head=document.createElement('div');
    head.className='git-hunk-head';
    head.appendChild(gitHunkSpan('git-hunk-header',hunk.header||''));
    if(has){
      head.appendChild(gitHunkSpan('git-hunk-range',
        GIT_HUNK_SEL_LABEL+sel.from+GIT_HUNK_SEL_SEP+sel.to));
      const c=document.createElement('button');
      c.className='git-hunk-clear'; c.textContent=GIT_HUNK_CLEAR; c.title=GIT_HUNK_CLEAR_TITLE;
      head.appendChild(c);
    }
    head.appendChild(gitHunkSpan('git-hunk-spacer',''));
    // 붙는 동작은 축이 정한다 — 방향이 축에서 갈린다 (FR-GIT-278).
    for(const act of (GIT_HUNK_ACTS[f.axis]||[])){
      const b=document.createElement('button');
      b.className='git-hunk-act'; b.dataset.act=act;
      b.textContent=has?GIT_HUNK_LINE_LABEL[act]:GIT_HUNK_LABEL[act];
      b.title=GIT_HUNK_TITLE[act];
      b.disabled=this._writing;
      head.appendChild(b);
    }
    el.appendChild(head);
    const body=document.createElement('div');
    body.className='git-hunk-body';
    const lines=hunk.lines||[];
    for(let i=0;i<lines.length;i++){
      const n=i+1,l=lines[i];
      const row=document.createElement('div');
      row.className='git-hunk-line'+(GIT_HUNK_LINE_CLASS[l[0]]||'')+
        ((has&&n>=sel.from&&n<=sel.to)?' sel':'');
      row.dataset.i=String(n);
      row.textContent=l;
      body.appendChild(row);
    }
    el.appendChild(body);
    return el;
  }

  _hunkClick(ev){
    const btn=ev.target.closest('.git-hunk-act');
    if(btn){
      const h=btn.closest('.git-hunk');
      if(h) this._hunkAct(btn.dataset.act,Number(h.dataset.hunk));
      return;
    }
    if(ev.target.closest('.git-hunk-clear')){this._hunkSel=null;this._paint();return}
    const line=ev.target.closest('.git-hunk-line');
    if(!line) return;
    const h=line.closest('.git-hunk'); if(!h) return;
    this._hunkPick(Number(h.dataset.hunk),Number(line.dataset.i),!!ev.shiftKey);
  }

  /**
   * 줄 선택은 **한 덩어리 안에서만** 잡힌다 — 덩어리를 넘는 범위는 패치가 되지
   * 않는다. 다른 덩어리를 누르면 선택이 그쪽으로 옮겨간다.
   *
   * 같은 한 줄을 다시 누르면 놓는다 — 선택을 지울 길이 Clear 뿐이면 한 줄을 잘못
   * 고른 사용자가 갇힌다.
   */
  _hunkPick(hunk,i,extend){
    const s=this._hunkSel;
    if(extend&&s&&s.hunk===hunk){
      this._hunkSel={hunk,from:Math.min(s.anchor,i),to:Math.max(s.anchor,i),anchor:s.anchor};
    }else if(s&&s.hunk===hunk&&s.from===i&&s.to===i){
      this._hunkSel=null;
    }else{
      this._hunkSel={hunk,from:i,to:i,anchor:i};
    }
    this._paint();
  }

  /**
   * 조각 하나의 동작. 보내는 것은 좌표뿐이다 — 패치는 서버가 자기가 만든 diff 에서
   * 잘라 짓는다 (D6).
   *
   * `diffId` 는 화면이 본 관측의 식별자다. 서버가 다시 만든 diff 와 다르면 409 로
   * 거부되고, 그때 화면은 조각을 다시 받는다 — 낡은 번호로 다른 곳을 고치지 않는다.
   */
  async _hunkAct(op,idx){
    const f=this.commitFile?null:this._diffTarget();
    const h=this._hunks;
    if(!f||!h||!h.list||!h.list[idx]||this._writing) return;
    const sel=(this._hunkSel&&this._hunkSel.hunk===idx)?this._hunkSel:null;
    const body={repo:f.repo,axis:f.axis,path:f.path,op,hunk:idx,
      from:sel?sel.from:0,to:sel?sel.to:0,diffId:h.diffId};
    if(op===GIT_PATCH_REVERT){this._hunkRevert(body,f,h.list[idx],sel);return}
    this._afterHunk(await this.post('/api/git/patch',body));
  }

  /**
   * revert 는 **파괴적이다** (FR-GIT-279) — 워킹 트리의 그 줄을 버린다. discard 와
   * 같은 규약을 지난다: 판정은 서버의 목록이 하고(GitConfirm), 확인은 2단계이며,
   * 실행 요청에 confirm 을 함께 보낸다 — 서버도 그것을 요구한다.
   */
  async _hunkRevert(body,f,hunk,sel){
    const label=sel?(GIT_HUNK_SEL_LABEL+sel.from+GIT_HUNK_SEL_SEP+sel.to):(hunk.header||'');
    await GitDialog.confirm({
      action:GIT_ACT_DISCARD,
      title:GIT_HUNK_REVERT_TITLE,
      targets:[f.path+GIT_HUNK_TARGET_SEP+label],
      // O8 의 선례: stash 를 자동 생성하지 않는다 — 실행할 명령을 보여 준다.
      hint:{note:GIT_HUNK_REVERT_NOTE,command:'git stash push -- '+gitShQuote(f.path)},
      run:async()=>{
        const res=await this.post('/api/git/patch',Object.assign({confirm:true},body));
        this._afterHunk(res);
        if(res.ok) return {ok:true};
        return {ok:false,reason:this.writeReason(res),stderrTail:(res.data&&res.data.message)||''};
      },
    });
  }

  /**
   * 조각 쓰기 한 번의 처리.
   *
   * 성공이든 실패든 **관측을 놓는다** — 조각을 적용하면 남은 덩어리의 번호가 밀리고,
   * 실패가 stale 이었다면 화면이 보던 것이 이미 낡은 것이다. 어느 쪽이든 다음
   * 그리기에서 다시 받는다.
   */
  _afterHunk(res){
    // **거부 사유는 누른 자리에 보인다.** `applyWriteFail` 의 안내 줄은 Changes 탭
    // 골격에만 있어(`.git-partial-note`) Diff 탭에서 낸 실패는 화면에 자국을 남기지
    // 않는다 — 조각을 누른 사람은 Diff 탭에 있다 (FR-GIT-278 의 stale 거부가 이
    // 자리를 실제로 필요로 한다).
    this._hunkErr=res.ok?null:this.writeError(res);
    // 사유는 **그 대상의 것**이다. 아래에서 목록을 다시 받으려고 키를 비우므로,
    // 어느 대상의 사유인지 따로 들고 있어야 다시 받는 그 회차에 지워지지 않는다.
    this._hunkErrKey=res.ok?null:this._hunkKey;
    this._hunkKey=null; this._hunks=null; this._hunkSel=null;
    // Monaco 의 두 모델도 낡았다 — 같은 대상이라도 내용이 바뀌었다 (FR-GIT-71).
    this._diffKey=null; this._prevKey=null;
    if(res.ok){this._note=null; this.adopt(res.data); return}
    this.applyWriteFail(res);
  }

  // FR-GIT-138·139: `<parent>..<commit>` 를 짧은 해시로 보인다. 루트 커밋은 부모가
  // 없으므로 그 사실을 적는다 — 빈 자리로 두면 해시를 못 읽은 것과 구분되지 않는다.
  _revLabel(f){
    // 40자 이상의 16진 문자열만 줄인다 — `stash@{0}` 같은 ref 를 자르면 무엇과
    // 비교하는지 읽을 수 없다 (FR-GIT-169).
    const short=o=>{
      const v=o||'';
      return /^[0-9a-f]{40,}$/.test(v)?v.slice(0,GIT_DIFF_REV_ABBREV):v;
    };
    return (GIT_AXIS_LABEL[f.axis]||f.axis)+' \u00b7 '+
      (f.parentOid?short(f.parentOid):GIT_DETAIL_ROOT)+GIT_DIFF_REV_RANGE+short(f.oid);
  }

  // FR-GIT-53: ‹ › 가 도는 순서는 Changes 탭의 목록과 같다 — 그룹 순서를 이어
  // 평탄화한 것이다.
  _fileList(){
    const s=this._status&&this._status.status;
    if(!s||!this.repo) return [];
    const out=[];
    for(const g of GIT_GROUPS)
      for(const e of (s[g.key]||[]))
        out.push({repo:this.repo,group:g.key,axis:GIT_GROUP_AXIS[g.key],
          path:e.path,origPath:e.origPath||''});
    return out;
  }

  _diffIndex(list){
    const f=this.previewFile; if(!f) return -1;
    return list.findIndex(x=>x.group===f.group&&x.path===f.path);
  }

  // 대상이 목록에서 사라졌으면 마지막 위치를 경계로 클램프한다 (§3.3).
  _diffMove(delta){
    const list=this._fileList(); if(!list.length) return;
    const cur=this._diffIndex(list);
    let i=cur<0?this._diffPos:cur+delta;
    i=Math.max(0,Math.min(list.length-1,i));
    this._diffPos=i;
    const t=list[i];
    this._select(t.group,{path:t.path,origPath:t.origPath});
  }

  // 대상이 그대로면 다시 부르지 않는다 — status 폴링마다 diff 를 재요청하면
  // 스크롤과 접힘이 매초 초기화된다.
  _showTarget(view,f,slot){
    // 식별자는 (리포, 축, 경로, 리비전) 이다 (FR-GIT-54·145) — 리비전이 빠지면
    // 머지 커밋에서 부모를 바꿔도 같은 대상으로 보여 다시 받지 않는다.
    const key=f?[f.repo,f.axis,f.path,f.origPath,f.oid||'',f.parentOid||''].join('\u0000'):'';
    if(this[slot]===key) return;
    this[slot]=key;
    if(!f){view.clear(this.repo?GIT_PREVIEW_HINT:GIT_NO_REPO_HINT);return}
    view.show(f,this.token());
  }

  // 두 인스턴스는 같은 클래스다 (§3.2). 미리보기는 좁은 자리이므로 inline 을
  // 기본으로 둔다 (§3.4).
  _diff(){
    if(!this._diffView) this._diffView=new GitDiffView({
      inlineBreakpoint:GIT_DIFF_OPTIONS.renderSideBySideInlineBreakpoint,
      sideBySide:this._sideBySidePref(),
      ignoreWhitespace:this._ignoreWsPref(),
      isStale:tok=>this.isStale(tok),
    });
    return this._diffView;
  }

  _preview(){
    if(!this._previewView) this._previewView=new GitDiffView({
      inlineBreakpoint:GIT_PREVIEW_INLINE_BREAKPOINT,
      sideBySide:false,
      ignoreWhitespace:this._ignoreWsPref(),
      isStale:tok=>this.isStale(tok),
    });
    return this._previewView;
  }

  _destroyViews(){
    if(!this._diffView&&!this._previewView) return;
    if(this._diffView){this._diffView.destroy();this._diffView=null}
    if(this._previewView){this._previewView.destroy();this._previewView=null}
    this._diffKey=null; this._prevKey=null;
    this._hunkKey=null; this._hunks=null; this._hunkSel=null;
    // 골격이 버린 뷰의 DOM 을 들고 있다 — 다시 열릴 때 새 뷰로 세운다.
    for(const [k,el] of this._els) if(k==='changes'||k==='diff') el.dataset.built='';
  }

  // 보기 모드와 공백무시는 기기별 취향이라 localStorage 에 남는다 (§3.3).
  _sideBySidePref(){
    if(this._sideBy==null){
      let v=null; try{v=localStorage.getItem(GIT_DIFF_SIDE_KEY)}catch{}
      this._sideBy=v!=='0';
    }
    return this._sideBy;
  }

  _ignoreWsPref(){
    if(this._ignWs==null){
      let v=null; try{v=localStorage.getItem(GIT_DIFF_WS_KEY)}catch{}
      // 기본은 공백을 무시하지 않는다 — git 과 같은 판정이다 (FR-GIT-50).
      this._ignWs=v==='1';
    }
    return this._ignWs;
  }

  _toggleSideBySide(){
    this._sideBy=!this._sideBySidePref();
    try{localStorage.setItem(GIT_DIFF_SIDE_KEY,this._sideBy?'1':'0')}catch{}
    this._diff().setSideBySide(this._sideBy);
    this._paint();
  }

  _setIgnoreWs(on){
    this._ignWs=!!on;
    try{localStorage.setItem(GIT_DIFF_WS_KEY,this._ignWs?'1':'0')}catch{}
    // 미리보기와 Diff 탭은 같은 상태다.
    for(const v of [this._diffView,this._previewView]) if(v) v.setIgnoreWhitespace(this._ignWs);
    this._paint();
  }

  // ── 우클릭 (FR-GIT-41·146) ──
  // 메뉴는 GitMenu 프레임워크가 그린다 — 5단계의 자체 메뉴를 그것이 흡수했다.
  // 여기 남는 것은 항목이 부르는 동작뿐이다.

  absPath(t){return (this.repo||'')+'/'+t.path}

  openFileDiff(t){this._openDiff(t.group,{path:t.path,origPath:t.origPath||''})}

  // 복사 유틸이 기존에 없다. clipboard 가 막힌 환경(비보안 컨텍스트)에서는
  // 임시 textarea 로 떨어진다.
  copyText(text){
    if(!text) return;
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).catch(()=>this._copyFallback(text));
      return;
    }
    this._copyFallback(text);
  }

  _copyFallback(text){
    const ta=document.createElement('textarea');
    ta.value=text; ta.style.cssText='position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    try{document.execCommand('copy')}catch{}
    ta.remove();
  }

  /**
   * FR-GIT-238: 새로고침. **전부 다시 받는다** — status · History · Branches ·
   * Console · Worktrees 다. 어느 탭을 보고 있는지에 따라 달라지지 않는다: 같은
   * 버튼이 늘 같은 일을 한다. `collect()` 하나로는 끝나지 않는다 — 그것은 status
   * 만 받고 Console 을 건드리지 않는다.
   *
   * 범위는 **이미 만들어진 뷰 전부**다. 탭의 뷰는 처음 열 때 지연 생성되므로 한 번도
   * 열지 않은 탭은 대상이 아니다 — 보인 적이 없는 것은 낡을 수 없고, 열 때 새로
   * 받는다.
   *
   * **자기 계기다** (FR-RPT-5). 관측 동일성 가드의 대상이 아니므로 값이 같아도 다시
   * 받는다.
   *
   * 실패는 각 경로가 이미 자기 자리에 알린다 — 새 표현을 만들지 않는다. status 의
   * 실패는 `.git-stale-note` 로 드러난다.
   */
  async refresh(){
    if(this._refreshing||!this.repo) return;
    this._refreshing=true; this._paintRefresh();
    const jobs=[this.collect()];
    if(this._historyView) jobs.push(this._historyView.reload());
    if(this._branchesView) jobs.push(this._branchesView.reload());
    if(this._consoleView) jobs.push(this._consoleView.reload());
    if(this._worktreesView) jobs.push(this._worktreesView.reload());
    // 하나가 실패해도 나머지를 기다린다 — 넷은 서로의 성공에 걸려 있지 않다.
    await Promise.allSettled(jobs);
    this._refreshing=false; this._paintRefresh();
  }

  // 받는 동안 진입점은 다시 눌리지 않는다 (FR-GIT-238). `_refreshing` 이 실제
  // 방어이고 `disabled` 는 그것을 화면에 보이는 것이다.
  _paintRefresh(){
    const el=this._els.get('changes'); if(!el) return;
    const b=el.querySelector('.git-head-refresh');
    if(b) b.disabled=this._refreshing;
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
      // 사유가 붙은 화면은 관측으로 그린 화면이 아니다 — 근거를 버려 회복하는
      // 관측이 값이 같아도 다시 그리게 한다 (FR-GIT-227).
      this._obsSig=null;
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
    /**
     * FR-GIT-227 (FR-RPT-1·2): 관측이 지난 회차와 같으면 다시 그리지 않는다.
     *
     * 폴링이 1초마다 도는데 그때마다 목록을 새로 만들면 화면은 그대로인 채 요소만
     * 버려진다 — hover 로만 보이는 행 버튼이 매초 깜빡이고, 더블클릭의 두 번째
     * 클릭이 새 요소에 떨어져 `dblclick` 이 만들어지지 않는다 (FR-GIT-52).
     *
     * 근거는 **화면이 읽는 값 전부**다. 그리는 쪽이 보는 것은 `_status.status`
     * 하나이고(`statusOf`), `observedAtUnixMs`·`cached` 는 회차마다 달라지지만
     * 화면에 닿지 않는다 — 그것까지 넣으면 근거가 늘 달라 가드가 죽는다.
     */
    const obs=JSON.stringify(d.status||null);
    if(obs!==this._obsSig){this._obsSig=obs; this._paint()}
    // 활성 리포의 배지가 따라 갱신된다. 다른 리포는 서버의 마지막 관측값이다.
    this.app._gitReposRefresh();
    // 상태바 chip 은 Git 창 밖에서도 보이므로 관측마다 갱신한다 (FR-GIT-57).
    this.app._updateStatusBar();
    // FR-GIT-111 (FR-RPT-8): 충돌 판정은 관측마다 돈다 — 다시 그리기에 업히면
    // 관측이 같은 회차에 판정이 멈춘다.
    if(this._remoteView) this._remoteView.notifyStatus();
    // FR-GIT-178: 다이얼로그가 열려 있으면 대상 변경을 알린다. 실행은 막지 않는다.
    if(typeof GitConfirm!=='undefined') GitConfirm.notify(this._lastSig);
    if(typeof GitDialog!=='undefined') GitDialog.notify();
  }

  _applyError(code){
    // 사유가 붙은 화면은 관측으로 그린 화면이 아니다 (FR-GIT-227).
    this._obsSig=null;
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

/**
 * recovery hint 의 명령에 넣을 경로를 감싼다 (FR-GIT-92). 저장소에는 공백·따옴표·
 * 한글이 든 경로가 있고, 사용자가 그 명령을 **붙여 그대로 실행**하므로 셸이 읽는
 * 형태여야 한다.
 */
/**
 * 조각 머리의 텍스트 한 조각 (FR-GIT-278). 값은 **textContent 로만** 넣는다 —
 * hunk 의 본문은 사용자의 파일 내용이고, 그것을 마크업으로 넣으면 파일이 화면을
 * 고칠 수 있다.
 */
function gitHunkSpan(cls,text){
  const el=document.createElement('span');
  el.className=cls;
  el.textContent=text;
  return el;
}

function gitShQuote(p){
  const s=String(p==null?'':p);
  if(/^[A-Za-z0-9._\/@=+:,-]+$/.test(s)) return s;
  return "'"+s.replace(/'/g,"'\\''")+"'";
}

/**
 * 바이트 수를 사람이 읽는 한 조각으로 만든다. 나누는 단위는 상태바·전송량 표시와
 * 같은 1024 계열이다 — 같은 화면 안에서 두 계산법이 섞이면 값이 어긋나 보인다.
 */
function gitFmtBytes(n){
  const b=Number(n)||0;
  if(b<1024) return b+' B';
  if(b<1048576) return (b/1024).toFixed(1)+' KB';
  if(b<1073741824) return (b/1048576).toFixed(1)+' MB';
  return (b/1073741824).toFixed(1)+' GB';
}

/**
 * 본문을 그리지 못하는 쪽의 메타 한 줄 (FR-GIT-46·47·48).
 *
 * LFS 포인터는 **가리키는 객체**의 oid·크기다 — 포인터 파일 자신의 134 B 는
 * 사용자가 묻는 것이 아니다. 서버가 싣지 않은 값은 만들지 않는다.
 */
function gitBlobMeta(side){
  const s=side||{};
  if(s.kind===GIT_LFS_KIND){
    const oid=s.lfsOid?GIT_LFS_OID_PREFIX+s.lfsOid.slice(0,GIT_LFS_OID_ABBREV)+'…':'';
    const size=s.lfsSize?gitFmtBytes(s.lfsSize):'';
    return [oid,size].filter(Boolean).join(GIT_META_SEP);
  }
  if(GIT_META_SIZED.has(s.kind)) return s.size?gitFmtBytes(s.size):'';
  return '';
}

/**
 * 양쪽 메타를 안내 아래 줄들로 만든다. 같으면 한 줄이다 — 같은 값을 두 번 보이면
 * 사용자는 두 쪽이 다르다고 읽는다.
 */
function gitBlobMetaLines(orig,mod){
  const a=gitBlobMeta(orig),b=gitBlobMeta(mod);
  if(a&&b&&a!==b){
    return [GIT_META_SIDE.orig+GIT_META_LABEL_SEP+a,GIT_META_SIDE.mod+GIT_META_LABEL_SEP+b];
  }
  return [a||b].filter(Boolean);
}

/**
 * Monaco DiffEditor 한 개를 감싼다 (FR-GIT-43) — diff 하이라이트를 자체
 * 구현하지 않는다.
 *
 * Changes 탭의 미리보기와 Diff 탭은 같은 것을 다른 크기로 보이는 것이므로 이
 * 클래스를 두 번 인스턴스화한다 (§3.2).
 *
 * 인스턴스는 탭·리포 전환에서 반드시 정리된다 (FR-GIT-56) — Monaco 에디터는
 * DOM 을 떼는 것으로 해제되지 않고, 남으면 모델과 리스너가 누적된다.
 */
class GitDiffView {
  constructor(opts){
    const o=opts||{};
    this._breakpoint=o.inlineBreakpoint||GIT_DIFF_OPTIONS.renderSideBySideInlineBreakpoint;
    this._sideBySide=o.sideBySide!==false;
    this._ignoreWs=!!o.ignoreWhitespace;
    // stale 판정의 절반은 바깥(세대·리포)이 안다. 나머지 절반은 자기 일련번호다
    // (FR-GIT-54).
    this._isStale=o.isStale||(()=>false);
    this._seq=0; this._dead=false;
    this._editor=null; this._orig=null; this._mod=null;
    this._el=document.createElement('div');
    this._el.className='git-diff-view';
    this._el.innerHTML='<div class="git-diff-note"></div><div class="git-diff-host"></div>';
    this._note=this._el.querySelector('.git-diff-note');
    this._host=this._el.querySelector('.git-diff-host');
  }

  get el(){return this._el}

  // (리포, 축, 경로, 리비전) 을 받아 내용을 불러 그린다. stale 가드를 자기가 건다.
  // 리비전(oid·parentOid)은 커밋 축만 쓴다 (FR-GIT-138).
  async show(target,token){
    const seq=++this._seq;
    if(!target||!target.repo||!target.path){this.clear(GIT_PREVIEW_HINT);return}
    this._setNote(GIT_LOADING_HINT);
    // Monaco 로드 실패는 밖으로 던지지 않는다 — Git 창의 나머지가 계속 동작해야
    // 한다 (FR-GIT-55).
    const loaded=await loadMonaco().then(()=>true,e=>{
      console.error('[GitDiffView] monaco load failed:',e); return false;
    });
    if(this._stale(seq,token)) return;
    if(!loaded){this.clear(GIT_DIFF_MONACO_FAIL);return}
    const d=await this._fetch(target);
    if(this._stale(seq,token)) return;
    if(!d.ok){this.clear(d.msg);return}
    // 서버가 되돌려준 요청값도 확인한다 — 같은 세대 안에서도 응답 순서가 뒤바뀔
    // 수 있다 (FR-GIT-54).
    const q=d.body.requested||{};
    if(q.repo!==target.repo||q.axis!==target.axis||q.path!==target.path) return;
    // 리비전까지 본다 — 머지 커밋에서 비교 부모를 바꿨을 때 이전 응답이 화면에
    // 닿아서는 안 된다 (FR-GIT-54·145).
    if((q.oid||'')!==(target.oid||'')||(q.parentOid||'')!==(target.parentOid||'')) return;
    const a=d.body.original||{},b=d.body.modified||{};
    // 한쪽이라도 본문이 없으면 에디터를 만들지 않고 서버가 준 사유를 보인다
    // (FR-GIT-46·47·48).
    if(!GIT_DIFF_DRAWABLE.has(a.kind)||!GIT_DIFF_DRAWABLE.has(b.kind)){
      this.clear(d.body.note||GIT_DIFF_LOAD_FAIL,gitBlobMetaLines(a,b)); return;
    }
    this._draw(target.path,a.content||'',b.content||'',d.body.note||'');
  }

  // 본문 대신 안내를 보인다. 에디터와 모델은 함께 버린다 (FR-GIT-56).
  clear(message,meta){
    this._seq++;
    this._setNote(message||'',meta);
    if(this._editor){this._editor.dispose();this._editor=null}
    this._dropModels(this._orig,this._mod);
    this._orig=null; this._mod=null;
    this._host.innerHTML='';
  }

  setSideBySide(on){ // FR-GIT-51
    this._sideBySide=!!on;
    if(this._editor) this._editor.updateOptions({renderSideBySide:this._sideBySide});
  }

  setIgnoreWhitespace(on){ // FR-GIT-50 의 사용자 토글
    this._ignoreWs=!!on;
    if(this._editor) this._editor.updateOptions({ignoreTrimWhitespace:this._ignoreWs});
  }

  layout(){ if(this._editor) this._editor.layout() }

  destroy(){ this._dead=true; this.clear('') }

  _stale(seq,token){return this._dead||seq!==this._seq||this._isStale(token)}

  async _fetch(target){
    let u='/api/git/diff-content?repo='+encodeURIComponent(target.repo)+
      '&axis='+encodeURIComponent(target.axis)+'&path='+encodeURIComponent(target.path);
    if(target.origPath) u+='&origPath='+encodeURIComponent(target.origPath);
    // 커밋 축만 리비전을 싣는다 (FR-GIT-138). oid 는 필수이고, parentOid 가 비면
    // 루트 커밋이다 — 서버가 그것을 absent 로 답한다.
    if(target.oid) u+='&oid='+encodeURIComponent(target.oid);
    if(target.parentOid) u+='&parentOid='+encodeURIComponent(target.parentOid);
    let r=null,d=null;
    try{r=await fetch(u)}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    if(!r||!d) return {ok:false,msg:GIT_DIFF_LOAD_FAIL};
    if(!r.ok) return {ok:false,msg:GIT_DIFF_ERR[d.error]||GIT_DIFF_LOAD_FAIL};
    return {ok:true,body:d};
  }

  _draw(path,orig,mod,note){
    this._setNote(note);
    const lang=monacoLang(path);
    if(!this._editor){
      this._editor=monaco.editor.createDiffEditor(this._host,Object.assign({},GIT_DIFF_OPTIONS,{
        renderSideBySide:this._sideBySide,
        renderSideBySideInlineBreakpoint:this._breakpoint,
        ignoreTrimWhitespace:this._ignoreWs,
        theme:monacoTheme(),
      }));
    }
    const prevO=this._orig,prevM=this._mod;
    this._orig=monaco.editor.createModel(orig,lang);
    this._mod=monaco.editor.createModel(mod,lang);
    this._editor.setModel({original:this._orig,modified:this._mod});
    // 이전 모델은 새 모델을 붙인 뒤에 버린다 — 먼저 버리면 에디터가 사라진 모델을
    // 읽는다 (FR-GIT-56).
    this._dropModels(prevO,prevM);
    requestAnimationFrame(()=>this.layout());
  }

  _dropModels(){
    for(const m of arguments) if(m) m.dispose();
  }

  // 안내 한 줄과 그 아래 메타 줄들 (FR-GIT-46·47·48). 메타는 별도 요소여야
  // 사유와 값이 한 줄로 뭉치지 않는다.
  _setNote(text,meta){
    this._note.textContent=text||'';
    const lines=meta||[];
    for(const line of lines){
      const el=document.createElement('span');
      el.className='git-diff-meta';
      el.textContent=line;
      this._note.appendChild(el);
    }
    this._note.classList.toggle('vis',!!(text||lines.length));
  }
}
