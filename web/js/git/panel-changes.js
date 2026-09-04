/**
 * GitPanel — Changes 탭 (FR-GIT-32~42 / SPLIT_REFACTOR_SRS 묶음 B).
 *
 * 골격을 한 번 세우고(`_buildChanges`) 이후에는 칠하기만 한다(`_paintChanges`) —
 * 폴링마다 DOM 을 다시 만들면 스크롤과 선택이 날아간다. 그룹·플랫/트리 보기·
 * 행 렌더·머리(HEAD)가 여기 산다.
 *
 * 행을 **고르는** 일(선택·범위·diff 열기)은 panel-diff.js 이고, 고른 것에 **하는**
 * 일(스테이지·discard)은 panel-files.js 다.
 *
 * `headHTML` 은 prototype 이 아니라 클래스 자체에 붙는다 — 머리 골격은 패널
 * 인스턴스 없이도 필요하다.
 */
Object.assign(GitPanel.prototype, {
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
    // FR-RTU-25: 저장소가 아닌 자리다. **그 사실만 말하고 끝내지 않는다** —
    // 여기서 만들 수 있으므로 그 길을 함께 둔다. Repo 창에서만 그린다: 옛
    // 표면에는 "어느 폴더를 저장소로 만드는가" 라는 대상이 없다.
    if(this.root&&this._notRepo){ this._renderInit(el); return }
    if(el.dataset.built!=='1') this._buildChanges(el);
    this._paintChanges(el);
  },

  /**
   * FR-RTU-25·26: `git init` 의 자리.
   *
   * 확인을 거치는 이유는 홈처럼 넓은 경로에서 되돌리기가 사용자의 몫이 되기
   * 때문이다 (D-RTU-13). 확인창은 **대상 절대경로를 밝힌다** — 어느 폴더인지
   * 모른 채 누르는 일이 없어야 한다.
   */
  _renderInit(el){
    el.dataset.built='';
    this._commit().unmount();
    el.innerHTML='';
    const box=document.createElement('div'); box.className='git-init';
    const msg=document.createElement('div'); msg.className='git-init-msg';
    msg.textContent=GIT_INIT_NOT_REPO;
    const path=document.createElement('div'); path.className='git-init-path';
    path.textContent=this.root; path.title=this.root;
    const btn=document.createElement('button');
    btn.className='git-init-btn'; btn.textContent=GIT_INIT_RUN;
    btn.addEventListener('click',()=>this.runInit());
    box.appendChild(msg); box.appendChild(path); box.appendChild(btn);
    // 실패는 그 자리에 남는다 — 알림창은 닫는 순간 사유가 사라진다.
    if(this._initErr){
      const e=document.createElement('div'); e.className='git-init-err';
      e.textContent=this._initErr;
      box.appendChild(e);
    }
    el.appendChild(box);
  },

  async runInit(){
    if(this._initBusy||!this.root) return;
    // 확인은 **GitConfirm 한 자리**를 지난다 (CONFIRM_ONE_STAGE_SRS FR-COS-1) —
    // git 을 바꾸는 조작의 확인이 두 벌이 되면 한쪽만 정책을 따른다.
    // `stages:1` 은 "파괴적은 아니지만 뜻을 먼저 알려야 한다" 이며, 여기서는
    // **어느 폴더인지**가 그 뜻이다 (FR-RTU-26).
    this._initBusy=true; this._initErr=null; this.obs.paintAll();
    const res=await GitConfirm.open({
      action:GIT_INIT_ACTION,title:GIT_INIT_CONFIRM,targets:[this.root],
      hint:GIT_INIT_HINT,stages:1,
      run:()=>this.post('/api/git/init',{path:this.root}),
    });
    this._initBusy=false;
    if(res===true||(res&&res.ok)){
      // FR-RTU-28: 서버가 캐시를 이미 지웠다 — 곧바로 다시 물으면 참이 온다.
      this._notRepo=false; this._errMsg=null; this._failStreak=0;
      this._applyCadence();
      this.signal('init');
      // 목록·핀이 함께 바뀌었다 (FR-RTU-27). 사이드바가 그것을 따라오게 한다.
      if(this.app._edRefresh) this.app._edRefresh();
      if(this.app._gitReposRefresh) this.app._gitReposRefresh();
    }else if(res!==false){
      // `false` 는 사용자가 취소한 것이다 — 실패가 아니므로 사유를 남기지 않는다.
      this._initErr=(res&&res.message)||GIT_INIT_FAIL;
    }
    this.obs.paintAll();
  },

  _paint(){
    // 소실은 status 가 없는 상태다 — 아래의 칠하기는 전부 그것을 딛는다 (FR-RMS-19).
    if(this._missing){this._paintAllViews();return}
    const c=this._els.get('changes'); if(c) this._renderChanges(c);
    const d=this._els.get('diff'); if(d) this._renderDiff(d);
    // History 는 status 에서 미커밋 변경 행만 딛는다 (FR-GIT-127) — 목록 전체를
    // 폴링마다 다시 그리면 스크롤이 매초 흔들린다.
    if(this._historyView) this._historyView.paintStatus();
    // FR-GHM-5: History 의 머리는 그 걸러내기에 업힐 수 없다 — `paintStatus` 는
    // 미커밋 개수와 HEAD 만 근거로 삼으므로 브랜치가 그대로인 채 ahead 만 바뀌면
    // 되돌아가고, 그러면 머리의 ↑↓ 가 Changes 와 어긋난다.
    const h=this._els.get('history'); if(h) this._paintHeadIn(h);
    // Branches 는 현재 브랜치만, Stash 는 "담을 것이 있는지" 만 딛는다
    // (FR-GIT-152·167).
    if(this._branchesView) this._branchesView.paintStatus();
    if(this._stashView) this._stashView.paintStatus();
  },

  /**
   * 머리 하나에 라벨과 동작을 붙인다 (FR-GHM-3·4). 골격이 세워질 때마다 한 번이며,
   * 뷰가 무엇이든 같은 것을 붙인다 — 머리가 같으면 동작도 같아야 한다.
   */
  _wireHead(el){
    const head=el&&el.querySelector('.git-head'); if(!head) return;
    for(const b of head.querySelectorAll('.git-remote-btn'))
      b.textContent=GIT_REMOTE_LABEL[b.dataset.remote]||'';
    for(const b of head.querySelectorAll('.git-remote-more')) b.textContent=GIT_REMOTE_MORE;
    const rf=head.querySelector('.git-head-refresh');
    rf.textContent=GIT_REFRESH_LABEL; rf.title=GIT_REFRESH_TITLE;
    rf.addEventListener('click',()=>this.refresh());
    // FR-GIT-282: 리포명 자체가 전환 자리다. 헤더에 새 버튼을 더하면 원격 버튼을
    // 세는 기존 단정이 흔들린다 (.git-head-refresh 가 밖에 선 것과 같은 이유).
    head.querySelector('.git-head-repo').addEventListener('click',ev=>this._openRepoPicker(ev));
    this._remote().bindHead(head);
  },

  // 머리 하나를 칠한다 (FR-GHM-5·6). 머리가 없는 뷰에서는 아무것도 하지 않는다 —
  // 부르는 쪽이 뷰마다 판별하면 뷰가 늘 때 한 곳이 빠진다.
  _paintHeadIn(el){
    const head=el&&el.querySelector('.git-head'); if(!head) return;
    this._paintHead(el,this._status&&this._status.status);
    this._remote().paintHead(head);
  },

  // 머리를 실은 뷰 전부. 목록을 따로 적지 않는다 — 머리가 있는 뷰가 곧 대상이다.
  paintHeads(){
    for(const el of this._els.values())
      if(el.dataset.built==='1') this._paintHeadIn(el);
  },

  // FR-GIT-39: .git-head·.git-commit 은 flex:0 0 auto 이고 목록 스크롤은
  // .git-files 안에서만 일어난다. 커밋 영역이 목록과 함께 스크롤되면 요구사항
  // 실패다 — 구조가 그것을 보장한다.
  _buildChanges(el){
    el.innerHTML=
      // REPO_TAB_UNIFY_SRS FR-RTU-20 / D-RTU-4: **커밋 입력이 브랜치 줄보다
      // 위다.** 사용자 지시이며, 가장 자주 쓰는 입력이 목록의 스크롤에 밀리지
      // 않는 자리에 있어야 한다는 것이 근거다.
      //
      // 안쪽은 GitCommit 이 채운다 (FR-GIT-74~85). 자리와 고정 성질은 여기 있다.
      '<div class="git-commit"></div>'+
      GitPanel.headHTML()+
      // 원격 작업 하나의 화면 (FR-GIT-102·103·105·108). 진행 중이 아니면 접힌다.
      '<div class="git-job">'+
        '<div class="git-job-bar">'+
          // REPO_TAB_UNIFY_SRS FR-RTU-100: 접기·펴기는 **전용 토글**이 갖는다.
          // 바의 나머지를 누르는 계기도 남지만, 폭이 줄면 그 자리가 버튼이 되므로
          // 폭과 무관한 자리가 하나 있어야 한다 (D-RTU-33).
          '<button class="git-job-fold"></button>'+
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
      /**
       * REPO_TAB_UNIFY_SRS FR-RTU-20: **목록 하나다.**
       *
       *   이전 동작: `목록 | 손잡이 | 인라인 diff 미리보기` 가로 두 칸
       *   새  동작: 목록만. diff 는 본문의 탭이다 (FR-RTU-30)
       *   이유:     사이드는 260px 이고 그 안을 둘로 나누면 목록이 ~90px 이 된다 —
       *             실측에서 행 이름이 0 으로 눌려 사라지고 호버 동작 버튼이 행
       *             가운데를 덮어, 선택하려는 클릭이 stage 를 실행했다 (C4b).
       *             그리고 diff 를 본문 탭으로 옮긴 것이 이번 통합의 요구 ②다 —
       *             같은 것을 두 자리에 두면 어느 쪽이 진짜인지 말할 수 없다
       *
       * 이 삭제로 EDITOR_GIT_UX_SRS 묶음 D(FR-CSZ-1~8, 두 칸 손잡이)는 폐기된다.
       * 나눌 칸이 없으면 그 사이의 손잡이도 없다 (§7 D-RTU-22).
       */
      '<div class="git-changes-body">'+
        '<div class="git-files">'+
          '<div class="git-files-bar">'+
            '<button class="git-files-mode" data-mode="tree">Tree</button>'+
            '<button class="git-files-mode" data-mode="flat">Flat</button>'+
            '<span class="git-files-spacer"></span>'+
          '</div>'+
        '</div>'+
      '</div>';
    this._wireHead(el);
    for(const b of el.querySelectorAll('.git-job-cancel')) b.textContent=GIT_JOB_CANCEL;
    el.querySelector('.git-job-copy').textContent=GIT_JOB_COPY;
    el.querySelector('.git-job-close').textContent=GIT_JOB_CLOSE;
    el.querySelector('.git-job-fold').title=GIT_JOB_FOLD_TITLE;
    el.querySelector('.git-job-auth-copy').textContent=GIT_JOB_AUTH_COPY;
    el.querySelector('.git-partial-close').textContent=GIT_NOTE_CLOSE;
    el.querySelector('.git-partial-close')
      .addEventListener('click',()=>{this._note=null;this._paint()});
    for(const b of el.querySelectorAll('.git-op-act')){
      b.textContent=GIT_OP_ACT_LABEL[b.dataset.act]||'';
      b.title=GIT_OP_ACT_TITLE[b.dataset.act]||'';
      b.addEventListener('click',()=>this.runOperation(b.dataset.act));
    }
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
  },

  _paintChanges(el){
    const s=this._status&&this._status.status;
    this._paintHeadIn(el);
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
  },

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
  },

  // 그룹 (FR-GIT-34·42). 빈 그룹도 개수를 보인다 — 숨기면 "없다"와 "모른다"가
  // 같아진다.
  /**
   * FR-GIT-282: 지금 열 수 있는 리포를 그 자리에서 고른다.
   *
   * 목록은 좌측 GIT 섹션과 **같은 정보원**(`app._gitRepos`)이다 — 두 벌로 두면
   * 사이드바에는 있는 리포가 여기에는 없는 상태가 생긴다.
   */
  /**
   * REPO_TAB_UNIFY_SRS FR-RTU-72: **리포 전환은 이제 창 전환이다.**
   *
   * 종전에는 `setRepo` 가 그 창의 활성 리포를 갈아 끼웠다 — Git 창이 워크스페이스에
   * 하나여서 리포가 창의 속성이었기 때문이다. 저장소마다 창이 서는 지금 패널의
   * 리포는 **창의 루트**이고 갈아 끼울 대상이 없다 (`setRepo` 는 `this.root` 가
   * 있으면 조기 반환한다). 그래서 드롭다운이 아무 일도 하지 않았다 — 실측한
   * 결함이다 (V207).
   *
   * `openGitWindow` 는 목록에 없는 경로도 먼저 더한 뒤 그 창으로 옮긴다.
   */
  _openRepoPicker(ev){
    const items=this._repoChoices().map(c=>({
      id:c.path, label:c.name, tip:c.path,
      cur:c.path===this.repo,
      // 고른 뒤 그 창의 사이드도 Changes 로 돌린다 — 사용자가 누른 자리가
      // Changes 이므로 "같은 자리의 다른 저장소" 로 가는 것이 이 손짓의 뜻이다.
      // 그러지 않으면 새 창의 기본 사이드(Explorer)가 떠서 누른 목록이 사라진다.
      run:()=>{
        GitMenu.close();
        this.app.openGitWindow(c.path).then(id=>{
          if(!id) return;
          const w=this.app.ws.windows.find(s=>s&&s.id===id);
          if(w) this.app._edSetSide(w,REPO_SIDE_CHANGES);
        });
      },
    }));
    if(!items.length) return;
    GitMenu.openList(items,'repo',null,ev);
  },

  _repoChoices(){
    const d=this.app._gitRepos||{};
    const out=[],seen=new Set();
    const name=p=>p.split('/').filter(Boolean).pop()||p;
    const add=e=>{
      if(!e||!e.path||!e.isRepo||seen.has(e.path)) return;
      seen.add(e.path);
      out.push({path:e.path,name:e.name||name(e.path)});
    };
    add(d.follow);
    for(const p of d.pinned||[]) add(p);
    // 지금 보고 있는 리포가 목록에 없으면 앞에 세운다 — 없으면 사용자는 자기가
    // 어디에 서 있는지 목록에서 찾지 못한다.
    if(this.repo&&!seen.has(this.repo)) out.unshift({path:this.repo,name:name(this.repo)});
    return out;
  },

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
  },

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
  },

  _itemEl(it){
    if(it.t==='dir') return this._dirEl(it);
    if(it.t==='file') return this._rowEl(it.group,it.e,it.depth);
    const more=document.createElement('div');
    more.className='git-file-more'; more.dataset.group=it.group;
    more.textContent='… '+it.n+' 개 더';
    if(this._io) this._io.observe(more);
    return more;
  },

  _emitFlat(items,group,entries,limit){
    const n=Math.min(limit,entries.length);
    for(let i=0;i<n;i++) items.push({t:'file',group,e:entries[i],depth:0});
    return n;
  },

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
  },

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
  },

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
  },

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
  },

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
    // FR-STC-1·2: 그 위에 상태별 색이 얹힌다. 문자를 클래스로도 실어 CSS 가
    // 색을 정한다 — 색표를 스타일 한 곳에 두기 위해서다 (FR-STC-3).
    const ch=this._stateChar(group,e);
    const st=document.createElement('span');
    st.className='git-file-st st-'+(GIT_ST_CLASS[ch]||'other');
    st.textContent=ch;
    const p=document.createElement('span'); p.className='git-file-path';
    this._fillPath(p,e);
    // FR-DIR-20: 디렉터리 항목은 종류까지 밝힌다 — 서브모듈과 중첩 저장소는
    // 사용자가 할 수 있는 일이 다르다.
    if(e.dir) d.classList.add('dir-entry');
    d.title=(e.origPath?e.origPath+' → '+e.path:e.path)+(e.score?' ('+e.score+'%)':'')+
      (partial?' — '+GIT_PARTIAL_TITLE:'')+
      (e.dir?' — '+(e.sub?GIT_DIR_ENTRY_TITLE_SUB:GIT_DIR_ENTRY_TITLE_NESTED):'');
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
    /**
     * REPO_TAB_UNIFY_SRS FR-RTU-40 (사용자 지시 2026-09-04): **한 번 클릭이 연다.**
     *
     *   이전 동작: 한 번 클릭은 고르기만, 더블클릭이 본문을 열었다
     *   새  동작: 한 번 클릭이 고르고 **곧바로 본문에 diff 를 연다.**
     *             더블클릭 계기는 없다
     *   이유:     VSCode 와 동치다 (사용자 지시). 사이드의 인라인 미리보기를
     *             걷었으므로(FR-RTU-20) 클릭의 결과를 보일 자리가 본문뿐이고,
     *             더블클릭을 남기면 "한 번 눌렀는데 아무 일도 없다" 가 된다
     *
     * FR-RTU-51: 새 파일은 diff 가 아니라 편집기로 연다 — 비교할 왼쪽이 없다.
     *
     * **보조키 클릭은 열지 않는다.** Cmd·Shift 는 여러 개를 고르는 손짓이고
     * (FR-GIT-69), 고를 때마다 본문이 갈리면 무엇을 고르는 중인지 알 수 없다.
     */
    d.addEventListener('click',ev=>{
      this._select(group,e,ev);
      if(ev&&(ev.metaKey||ev.ctrlKey||ev.shiftKey)) return;
      if(group==='untracked'&&this._openUntracked(e)) return;
      this.openView('diff');
    });
    d.addEventListener('contextmenu',ev=>{
      ev.preventDefault();
      GitMenu.open('file',{group,path:e.path,origPath:e.origPath||''},ev);
    });
    return d;
  },

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
    // GIT_DIR_ENTRY_SRS FR-DIR-20: 디렉터리 항목임을 접미 `/` 로 보인다.
    // **판정은 서버의 `dir` 에서 온다** (D-DIR-1) — 경로 문자열로 판정하면
    // 판정 자리가 둘이 된다. 그래서 서버는 경로에서 슬래시를 벗겨 보내고
    // (FR-DIR-2), 표시가 필요한 여기서만 다시 붙인다.
    if(e.dir){
      const s=document.createElement('span');
      s.className='git-file-path-dirmark'; s.textContent=GIT_DIR_ENTRY_SUFFIX;
      p.appendChild(s);
    }
  },

  // 상태문자는 xy 에서 뽑는다 — 그룹이 어느 축을 보는지가 곧 X/Y 선택이다.
  _stateChar(group,e){
    if(group==='untracked') return '?';
    if(group==='conflicts') return 'U';
    const xy=e.xy||'..';
    return group==='staged'?xy[0]:xy[1];
  },

  _toggleGroup(key){
    if(this._collapsed.has(key)) this._collapsed.delete(key); else this._collapsed.add(key);
    this._paint();
  },

  _growGroup(key){
    if(!key) return;
    this._shown.set(key,(this._shown.get(key)||GIT_FILE_ROW_CHUNK)+GIT_FILE_ROW_CHUNK);
    this._paint();
  },

  // 보기 선택은 localStorage 에 남긴다 (기기별 취향이다). 기본은 플랫이다.
  _treeMode(){
    if(this._fileView==null){
      let v=null; try{v=localStorage.getItem(GIT_FILE_VIEW_KEY)}catch{}
      this._fileView=v==='tree'?'tree':'flat';
    }
    return this._fileView==='tree';
  },

  _setFileView(mode){
    this._fileView=mode==='tree'?'tree':'flat';
    try{localStorage.setItem(GIT_FILE_VIEW_KEY,this._fileView)}catch{}
    this._paint();
  },

  _paintMode(el){
    const tree=this._treeMode();
    for(const b of el.querySelectorAll('.git-files-mode'))
      b.classList.toggle('active',(b.dataset.mode==='tree')===tree);
    el.querySelector('.git-files').classList.toggle('tree',tree);
  },

  // ── 스테이징 (FR-GIT-64~73) ──

});

Object.assign(GitPanel, {
  // ── 머리 (FR-GHM-1~8) ──

  /**
   * 머리 한 벌의 마크업. **만드는 자리는 여기 하나다** (FR-GHM-4) — 두 벌로 두면
   * 한쪽에만 버튼이 늘어나고, 그 어긋남은 탭을 바꿔야 보인다.
   *
   * FR-GHM-1: 여백은 **동작부 뒤**다. 앞에 두면 버튼이 오른쪽 끝으로 밀린다.
   */
  headHTML(){
    return '<div class="git-head">'+
      '<span class="git-head-repo"></span><span class="git-head-branch"></span>'+
      '<span class="git-head-badges"></span><span class="git-head-ab"></span>'+
      // FR-GIT-238: 새로고침. **`.git-head-remote` 밖**에 둔다 — 안에 넣으면 원격
      // 버튼을 세는 기존 단정이 깨진다.
      '<button class="git-head-refresh"></button>'+
      // 원격 버튼은 기본 동작만 하고 변형은 `▾` 다이얼로그에서 온다
      // (FR-GIT-98·99). 동작은 GitRemote 가 붙인다.
      '<span class="git-head-remote">'+GIT_REMOTE_KINDS.map(k=>
        '<button class="git-remote-btn" data-remote="'+k+'" disabled></button>'+
        '<button class="git-remote-more" data-remote="'+k+'" disabled></button>'
      ).join('')+'</span>'+
      '<span class="git-head-spacer"></span>'+
    '</div>';
  },
});
