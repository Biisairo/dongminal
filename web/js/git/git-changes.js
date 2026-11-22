/**
 * GitChanges — Git 패널의 Changes 탭 부품: 골격 · 칠하기 · 머리 · 저장소 만들기 (FR-GIT-32~42 /
 * SPLIT_REFACTOR_SRS 묶음 B · REFACTOR3_FE_GITPANEL_SRS 7f). 보기 취향(`_fileView`)과 `git init` 의 진행·실패
 * (`_initBusy`·`_initErr`)를 소유한다.
 *
 * 골격을 한 번 세우고(`_buildChanges`) 이후에는 칠하기만 한다(`_paintChanges`) —
 * 폴링마다 DOM 을 다시 만들면 스크롤과 선택이 날아간다. 그룹·행은 `git-change-rows.js`,
 * 행을 **고르는** 일은 `git-selection.js`, 고른 것에 **하는** 일(스테이지·discard)은 `git-files.js` 다.
 *
 * 부르는 쪽은 `panel.changes._paint()` 처럼 이 부품을 부른다 — e2e·시험도 이 부품 인스턴스에서 그것을 덮는다.
 * `headHTML` 은 정적이다 — 머리 골격은 패널 인스턴스 없이도 필요하다(History 가 `GitChanges.headHTML` 을 부른다).
 */
/**
 * Changes 탭의 골격 (REFACTOR3_FE_REST3_SRS FR-FR3-18, FU-15). `head` 는 머리 골격(`GitPanel.headHTML()`), `boxes` 는
 * 잡 칸 박스(`GitJobs.boxesHTML()`)다. 안쪽은 부품들이 채우고 배선은 `_buildChanges` 가 한다.
 *
 * FR-GIT-39: .git-head·.git-commit 은 flex:0 0 auto 이고 목록 스크롤은 .git-files 안에서만 일어난다. 커밋 영역이
 * 목록과 함께 스크롤되면 요구사항 실패다 — 구조가 그것을 보장한다.
 */
function gitChangesHTML(head,boxes){
  return (
    // REPO_TAB_UNIFY_SRS FR-RTU-20 / D-RTU-4: **커밋 입력이 브랜치 줄보다
    // 위다.** 사용자 지시이며, 가장 자주 쓰는 입력이 목록의 스크롤에 밀리지
    // 않는 자리에 있어야 한다는 것이 근거다.
    //
    // 안쪽은 GitCommit 이 채운다 (FR-GIT-74~85). 자리와 고정 성질은 여기 있다.
    '<div class="git-commit"></div>'+
    head+
    // 잡 칸 둘의 화면 (FR-GIT-102·103·105·108, REPO_FIX 01 §6.4). 진행 중이
    // 아니면 접힌다. 골격은 GitJobs 가 한 벌을 칸마다 찍는다.
    '<div class="git-jobs">'+boxes+'</div>'+
    // FR-GIT-252: 진행 중 작업과 **나갈 길**. 상태만 보이고 출구가 없으면
    // 사용자는 GUI 안에 갇힌다.
    '<div class="git-op-bar">'+
      '<span class="git-op-kind"></span>'+
      '<span class="git-op-at"></span>'+
      '<span class="git-op-spacer"></span>'+
      '<button class="ui-btn ui-btn-lg git-op-act" data-act="'+GIT_OP_CONTINUE+'" hidden></button>'+
      '<button class="ui-btn ui-btn-lg git-op-act" data-act="'+GIT_OP_SKIP+'" hidden></button>'+
      '<button class="ui-btn ui-btn-lg ui-btn-danger git-op-act" data-act="'+GIT_OP_ABORT+'" hidden></button>'+
    '</div>'+
    // FR-GRF-11: 낡음 배너는 **여기 없다.** 뷰 공통으로 옮겼다
    // (`git-view-roots.js` `_paintStaleIn`) — 이 골격에만 있던 탓에 History·
    // Branches·Stash·Console 을 보는 동안에는 실패가 화면에 한 톨도 나타나지
    // 않았다 (`11 GP-4`). 자리는 같다: 머리 바로 아래.
    '<div class="ui-notice ui-notice-attn git-partial-note">'+
      '<div class="git-partial-msg"></div>'+
      '<ul class="git-partial-list ui-scroll-sm"></ul>'+
      '<button class="ui-btn ui-btn-lg git-lock-remove"></button>'+
      '<button class="ui-btn ui-btn-lg git-partial-close"></button>'+
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
      '<div class="git-files ui-scroll-sm">'+
      '</div>'+
    '</div>');
}

class GitChanges extends GitPart {
  constructor(panel){
    super(panel);
    this._fileView=null;          // 'flat' | 'tree'
  }

  // 골격은 한 번만 세우고 이후에는 칠하기만 한다 — 폴링마다 DOM 을 다시 만들면
  // 스크롤 위치와 선택이 날아간다.
  _renderChanges(el){
    if(!this.p.repo){
      el.dataset.built=''; el.innerHTML='';
      // 골격을 버렸으므로 커밋 영역도 자기 DOM 을 놓아야 한다.
      this.p.views._commit().unmount();
      const d=document.createElement('div'); d.className='ui-empty ui-empty-center git-empty';
      d.textContent=this.p._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    // FR-RTU-25: 저장소가 아닌 자리다. **그 사실만 말하고 끝내지 않는다** —
    // 여기서 만들 수 있으므로 그 길을 함께 둔다. Repo 창에서만 그린다: 옛
    // 표면에는 "어느 폴더를 저장소로 만드는가" 라는 대상이 없다.
    if(this.p.root&&this.p._notRepo){ this._renderInit(el); return }
    if(el.dataset.built!=='1') this._buildChanges(el);
    this._paintChanges(el);
  }

  /**
   * FR-RTU-25·26: `git init` 의 자리.
   *
   * 확인을 거치는 이유는 홈처럼 넓은 경로에서 되돌리기가 사용자의 몫이 되기
   * 때문이다 (D-RTU-13). 확인창은 **대상 절대경로를 밝힌다** — 어느 폴더인지
   * 모른 채 누르는 일이 없어야 한다.
   */
  _renderInit(el){
    el.dataset.built='';
    this.p.views._commit().unmount();
    el.innerHTML='';
    const box=document.createElement('div'); box.className='git-init';
    const msg=document.createElement('div'); msg.className='git-init-msg';
    msg.textContent=GIT_INIT_NOT_REPO;
    const path=document.createElement('div'); path.className='git-init-path';
    path.textContent=this.p.root; path.title=this.p.root;
    const btn=UIKit.button({label:GIT_INIT_RUN,kind:'primary',size:'lg',cls:'git-init-btn',onClick:()=>this.runInit()});
    box.appendChild(msg); box.appendChild(path); box.appendChild(btn);
    // 실패는 그 자리에 남는다 — 알림창은 닫는 순간 사유가 사라진다.
    if(this._initErr){
      const e=document.createElement('div'); e.className='git-init-err';
      e.textContent=this._initErr;
      box.appendChild(e);
    }
    el.appendChild(box);
  }

  async runInit(){
    if(this._initBusy||!this.p.root) return;
    // 확인은 **GitConfirm 한 자리**를 지난다 (CONFIRM_ONE_STAGE_SRS FR-COS-1) —
    // git 을 바꾸는 조작의 확인이 두 벌이 되면 한쪽만 정책을 따른다.
    // `stages:1` 은 "파괴적은 아니지만 뜻을 먼저 알려야 한다" 이며, 여기서는
    // **어느 폴더인지**가 그 뜻이다 (FR-RTU-26).
    this._initBusy=true; this._initErr=null; this.p.obs.paintAll();
    const res=await GitConfirm.open({
      action:GIT_INIT_ACTION,title:GIT_INIT_CONFIRM,targets:[this.p.root],
      hint:GIT_INIT_HINT,stages:1,
      // F-6.3: 실패는 서버 사유로 말한다 — 확인창 안에서, 그리고 닫은 뒤 그 자리에.
      // 이전: 응답 모양을 그대로 돌려 사유가 비어 "동작이 실패했습니다" 만 보였다.
      run:async()=>{
        const r=await this.p.write.post(GIT_API.init,{path:this.p.root});
        if(r.ok) return {ok:true};
        const why=(r.data&&r.data.message)||'';
        this._initErr=why||GIT_INIT_FAIL;
        return {ok:false,reason:GIT_INIT_FAIL,stderrTail:why};
      },
    });
    this._initBusy=false;
    if(res===true||(res&&res.ok)){
      // FR-RTU-28: 서버가 캐시를 이미 지웠다 — 곧바로 다시 물으면 참이 온다.
      this.p._notRepo=false; this.p._errMsg=null; this.p._failStreak=0;
      this.p.poll._applyCadence();
      this.p.poll.signal('init');
      // 목록·핀이 함께 바뀌었다 (FR-RTU-27). 사이드바가 그것을 따라오게 한다.
      if(this.app.edRefresh) this.app.edRefresh();
      if(this.app.gitReposRefresh) this.app.gitReposRefresh();
    }
    // 취소(`false`)는 실패가 아니다 — 사유는 실패한 실행이 남긴 것만 선다.
    this.p.obs.paintAll();
  }

  _paint(){
    // 소실은 status 가 없는 상태다 — 아래의 칠하기는 전부 그것을 딛는다 (FR-RMS-19).
    if(this.p._missing){this.p.viewRoots._paintAllViews();return}
    const c=this.p._els.get('changes'); if(c) this._renderChanges(c);
    const d=this.p._els.get('diff'); if(d) this.p.diffPane._renderDiff(d);
    // History 는 status 에서 미커밋 변경 행만 딛는다 (FR-GIT-127) — 목록 전체를
    // 폴링마다 다시 그리면 스크롤이 매초 흔들린다.
    if(this.p._historyView) this.p._historyView.paintStatus();
    // FR-GHM-5: History 의 머리는 그 걸러내기에 업힐 수 없다 — `paintStatus` 는
    // 미커밋 개수와 HEAD 만 근거로 삼으므로 브랜치가 그대로인 채 ahead 만 바뀌면
    // 되돌아가고, 그러면 머리의 ↑↓ 가 Changes 와 어긋난다.
    const h=this.p._els.get('history'); if(h) this._paintHeadIn(h);
    // Branches 는 현재 브랜치만, Stash 는 "담을 것이 있는지" 만 딛는다
    // (FR-GIT-152·167).
    if(this.p._branchesView) this.p._branchesView.paintStatus();
    if(this.p._stashView) this.p._stashView.paintStatus();
    // 1층 답을 그리는 머리 (SERVER_DRIVEN_ACTIONS_SRS GR-1d).
    if(this.p._worktreesView) this.p._worktreesView._paintHead();
    if(this.p._submodulesView) this.p._submodulesView._paintHead();
    // FR-GRF-9: 낡음은 **모든 뷰**의 사실이다 — 위의 뷰별 칠하기와 달리
    // 무엇을 보고 있든 같은 것을 말한다.
    this.p.viewRoots.paintStale();
  }

  /**
   * 머리 하나에 라벨과 동작을 붙인다 (FR-GHM-3·4). 골격이 세워질 때마다 한 번이며,
   * 뷰가 무엇이든 같은 것을 붙인다 — 머리가 같으면 동작도 같아야 한다.
   */
  _wireHead(el){
    const head=el&&el.querySelector('.git-head'); if(!head) return;
    // 요구 ③: 아이콘이 버튼을 꽉 채운다 — 크기는 `.ui-icon` 이 버튼 높이에서
    // 파생시킨다 (FR-GLY-5). 글자 화살표는 폰트 크기를 따라 작게 남아 있었다.
    for(const b of head.querySelectorAll('.git-remote-btn')){
      b.appendChild(UIKit.icon(GIT_REMOTE_ICON[b.dataset.remote]));
      // UX_AUDIT_FIX_SRS FR-UXF-77 (D-27): 머리가 넓으면 아이콘 뒤에 라벨이 선다 — 작업 줄의 이름과 같은 말이다.
      //   이전 동작: 아이콘만 (FR-GCC-5) — ⤓(fetch)와 ↓(pull)가 구별되지 않았다 (진단 D12·X5)
      //   새  동작: 넓으면 라벨, 좁으면 아이콘만 — 폭은 style-git.css 의 컨테이너 쿼리가 가른다
      const l=document.createElement('span');
      l.className='git-remote-label'; l.textContent=gitJobKindLabel(b.dataset.remote);
      b.appendChild(l);
    }
    for(const b of head.querySelectorAll('.git-remote-more'))
      b.appendChild(UIKit.icon(GIT_REMOTE_MORE,{size:'sm'}));
    // FR-GIT-282: 리포명 자체가 전환 자리다 — 헤더에 새 버튼을 더하지 않는다.
    head.querySelector('.git-head-repo').addEventListener('click',ev=>this._openRepoPicker(ev));
    this.p.views._remote().bindHead(head);
  }

  // 머리 하나를 칠한다 (FR-GHM-5·6). 머리가 없는 뷰에서는 아무것도 하지 않는다 —
  // 부르는 쪽이 뷰마다 판별하면 뷰가 늘 때 한 곳이 빠진다.
  _paintHeadIn(el){
    const head=el&&el.querySelector('.git-head'); if(!head) return;
    this._paintHead(el,this.p._status&&this.p._status.status);
    this.p.views._remote().paintHead(head);
  }

  // 머리를 실은 뷰 전부. 목록을 따로 적지 않는다 — 머리가 있는 뷰가 곧 대상이다.
  paintHeads(){
    for(const el of this.p._els.values())
      if(el.dataset.built==='1') this._paintHeadIn(el);
  }

  // 골격을 세우고 배선한다 (FR-FR3-18). 순서: 골격 → 보기 전환 → 머리 → 잡 글자 → 노트·진행 중 작업 → 그룹 → 커밋 → 원격.
  _buildChanges(el){
    el.innerHTML=gitChangesHTML(GitChanges.headHTML(),this.p.views._remote().boxesHTML());
    /**
     * UX_AUDIT_FIX_SRS FR-UXF-23: 보기 전환(폴더/목록)은 브랜치 줄의 끝에 선다. 원격 단추와는 세로 선으로 가른다.
     *   이전: 목록 위에 보기 전환만의 줄(`.git-files-bar`)이 따로 섰다
     *   이유: 목록 첫 줄 위의 줄이 너무 많았다 (진단 D9·M5)
     * FR-CMP-40: 배타 선택지 둘이므로 세그먼트다 — 붙어 한 덩이로 보이고 고른 쪽이 채워진다.
     */
    el.querySelector('.git-head').insertAdjacentHTML('beforeend',
      '<span class="git-head-sep" aria-hidden="true"></span>'+
      '<span class="ui-segment">'+
        '<button class="ui-btn ui-btn-icon ui-btn-lg git-files-mode" data-mode="tree"></button>'+
        '<button class="ui-btn ui-btn-icon ui-btn-lg git-files-mode" data-mode="flat"></button>'+
      '</span>');
    this._wireHead(el);
    GitJobs.label(el);
    this._wireChangesBar(el);
    const files=el.querySelector('.git-files');
    for(const g of GIT_GROUPS) files.appendChild(this._groupEl(g));
    for(const b of el.querySelectorAll('.git-files-mode')){
      // FR-GCC-8 / NFR-3: 아이콘만 남으므로 툴팁이 유일한 설명이다.
      b.appendChild(UIKit.icon(GIT_FILES_MODE_ICON[b.dataset.mode]));
      b.title=GIT_FILE_VIEW_TITLE[b.dataset.mode]||'';
      b.addEventListener('click',()=>this._setFileView(b.dataset.mode));
    }
    this.p.views._commit().mount(el.querySelector('.git-commit'));
    // 원격 버튼과 작업 영역의 동작 (FR-GIT-98~112). 골격은 여기 있고 상태는
    // GitRemote 가 들고 있다 — 골격을 다시 세워도 진행 중 작업이 사라지지 않는다.
    this.p.views._remote().bind(el);
    // FR-GIT-42: 목록 끝이 보일 때마다 다음 덩어리를 이어 그린다 — 관측기는 행 부품이 든다.
    this.p.changeRows._watchMore(files);
    el.dataset.built='1';
  }

  // 부분 노트의 닫기·lock 지우기·진행 중 작업의 단추 (FR-GIT-252).
  _wireChangesBar(el){
    const partClose=el.querySelector('.git-partial-close');
    partClose.textContent=GIT_NOTE_CLOSE; partClose.title=GIT_TIP_NOTE_CLOSE;
    el.querySelector('.git-partial-close')
      .addEventListener('click',()=>{this.p._note=null;this._paint()});
    const lockBtn=el.querySelector('.git-lock-remove');
    lockBtn.textContent=GIT_LOCK_REMOVE;
    lockBtn.addEventListener('click',()=>this.p.write.removeIndexLock());
    for(const b of el.querySelectorAll('.git-op-act')){
      b.textContent=GIT_OP_ACT_LABEL[b.dataset.act]||'';
      b.title=GIT_OP_ACT_TITLE[b.dataset.act]||'';
      b.addEventListener('click',()=>this.p.write.runOperation(b.dataset.act));
    }
  }

  // 그룹 하나 — 머리(접기·이름·수·일괄 단추)와 행 자리.
  _groupEl(g){
    const d=document.createElement('div'); d.className='git-group'; d.dataset.group=g.key;
    d.innerHTML='<div class="git-group-head"><span class="git-group-caret"></span>'+
      '<span class="git-group-name"></span><span class="git-group-count ui-count"></span>'+
      '<span class="git-group-spacer"></span></div>'+
      '<div class="git-group-rows"></div>';
    d.querySelector('.git-group-name').textContent=g.name;
    d.querySelector('.git-group-head').addEventListener('click',()=>this.p.changeRows._toggleGroup(g.key));
    // 그룹별 일괄 (FR-GIT-66·67·68 / FR-WBR-50·51·52). 그룹이 이미 tracked /
    // untracked 를 가르므로 그룹별 일괄이 곧 그 구분이다. 그리는 순서가 곧
    // 손에서의 거리이므로 `GIT_GROUP_BULK` 의 배열 순서를 그대로 따른다 —
    // 여기서 정렬하면 순서의 뜻이 두 자리에 살게 된다.
    // 일괄도 행과 **같은 열**에 선다 (GIT_ACT_COLS) — 자리지킴이 없는 열을
    // 메운다. 머리와 행의 오른쪽 끝이 어긋나면 같은 뜻의 아이콘이 다른 자리에
    // 서고, 그것이 접수한 말의 "정렬이 안되었다" 다.
    const acts=document.createElement('span');
    acts.className='git-act-cols git-group-acts';
    for(const c of this.p.changeRows._actCols(GIT_GROUP_BULK[g.key]||[],GIT_BULK_COLS)){
      if(!c.act){acts.appendChild(this.p.changeRows._actGap());continue}
      // FR-WBR-52: 행 동작과 **같은 어휘**의 아이콘이다. FR-WBR-52a: 뜻이
      // 갈리는 자리는 툴팁이다 — 워킹 그룹의 폐기는 삭제를 포함한다.
      // 헤더 클릭은 접기다 — 일괄 버튼이 그것을 함께 일으키지 않는다.
      acts.appendChild(UIKit.button({icon:GIT_ACT_ICON[c.act],
        title:(GIT_BULK_TITLE_GROUP[g.key]||{})[c.act]||GIT_BULK_TITLE[c.act],
        kind:'ghost',size:'lg',cls:'git-group-bulk',dataset:{act:c.act},
        onClick:ev=>{ev.stopPropagation();this.p.files._bulk(g.key,c.act)}}));
    }
    d.querySelector('.git-group-head').appendChild(acts);
    return d;
  }

  _paintChanges(el){
    const s=this.p._status&&this.p._status.status;
    this._paintHeadIn(el);
    // FR-GRF-9: 낡음 배너는 뷰 공통이다 — 여기서는 이 뷰의 것만 칠한다.
    this.p.viewRoots._paintStaleIn(el);
    this.p.write._paintOp(el,s);
    // FR-CMG-2: 워킹 그룹은 서버의 두 배열을 합친 것이다 — 판정은 한 자리다.
    for(const g of GIT_GROUPS) this.p.changeRows._paintGroup(el,g,gitGroupEntries(s,g.key));
    this._paintMode(el);
    this.p.write._paintNote(el);
    this.p.views._commit().paint(s||null);
    this.p.views._remote().paint(el);
  }

  // 헤더 (FR-GIT-32·33·40)
  _paintHead(el,s){
    // F-3.3 (FR-RTU-24): 창 루트가 하위 폴더여도 이름은 그 저장소의 것이다.
    const repo=this.p.poll.repoTop();
    const r=el.querySelector('.git-head-repo');
    r.textContent=pathBase(repo)||repo;
    r.title=repo;
    // detached 면 브랜치 자리에 해시 앞 7자가 온다.
    el.querySelector('.git-head-branch').textContent=
      !s?'':(s.detached?(s.oid||'').slice(0,7):(s.branch||''));
    const badges=el.querySelector('.git-head-badges');
    // FR-PRF-10 — 이전: 관측 회차마다 배지 줄을 비우고 다시 만들었다.
    // 새: 배지가 그대로면 그리지 않는다.
    // 이유: `_paintHead` 는 status 폴링이 부르고, 배지는 detached·upstream·충돌
    //       셋으로만 정해져 **거의 언제나 그대로다.** 이 자리는 감사가 든 여섯에
    //       없었고 **등록부를 채우는 과정에서 나왔다** (SRS §2.2 · D-PRF-2).
    const sig=!s?'':[s.detached?1:0,s.hasUpstream?1:0,(s.conflicts||[]).length].join(RPT_SEP);
    paintIfChanged(badges,sig,()=>{
      badges.innerHTML='';
      const add=(cls,text)=>{
        const b=document.createElement('span'); b.className='git-head-badge '+cls;
        b.textContent=text; badges.appendChild(b);
      };
      if(s){
        if(s.detached) add('git-badge-detached','detached HEAD');
        else if(!s.hasUpstream) add('git-badge-noupstream',t('git.badge_no_upstream'));
        const n=(s.conflicts||[]).length;
        if(n) add('git-badge-conflict',t('git.badge_conflicts',{n}));
      }
    });
    // ahead/behind 는 0 이면 그리지 않는다.
    // UX_AUDIT_FIX_SRS FR-UXF-78 (D-27): 원격 단추가 있는 머리에서는 수가 단추 **안**이다 — 같은 수를 두 곳에 두지 않는다.
    //   이전 동작: 수는 늘 브랜치 옆 `.git-head-ab` 였다 / 이유: 진단 D12 — 무엇을 밀고 당길지가 단추에서 보인다
    const remote=el.querySelector('.git-head-remote');
    if(remote){
      for(const [kind,key] of Object.entries(GIT_REMOTE_COUNT)){
        const b=remote.querySelector('.git-remote-btn[data-remote="'+kind+'"]');
        if(b) this._paintRemoteCount(b,s&&s[key]>0?String(s[key]):'');
      }
      el.querySelector('.git-head-ab').textContent='';
      return;
    }
    const ab=[];
    if(s&&s.ahead>0) ab.push('↑'+s.ahead);
    if(s&&s.behind>0) ab.push('↓'+s.behind);
    el.querySelector('.git-head-ab').textContent=ab.join(' ');
  }

  /** FR-UXF-78: 단추 안의 수. 빈 값이면 원소를 거둔다. */
  _paintRemoteCount(b,text){
    let n=b.querySelector('.git-remote-n');
    if(!text){ if(n) n.remove(); return }
    if(!n){ n=document.createElement('span'); n.className='git-remote-n'; b.appendChild(n) }
    n.textContent=text;
  }

  // 그룹 (FR-GIT-34·42). 빈 그룹도 개수를 보인다 — 숨기면 "없다"와 "모른다"가
  // 같아진다.
  /**
   * FR-GIT-282: 지금 열 수 있는 리포를 그 자리에서 고른다.
   *
   * 목록은 좌측 GIT 섹션과 **같은 정보원**(`app.gitRepos`)이다 — 두 벌로 두면
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
      cur:c.path===this.p.repo,
      // 고른 뒤 그 창의 사이드도 Changes 로 돌린다 — 사용자가 누른 자리가
      // Changes 이므로 "같은 자리의 다른 저장소" 로 가는 것이 이 손짓의 뜻이다.
      // 그러지 않으면 새 창의 기본 사이드(Explorer)가 떠서 누른 목록이 사라진다.
      run:()=>{
        GitMenu.close();
        this.app.openGitWindow(c.path).then(id=>{
          if(!id) return;
          const w=this.app.ws.windows.find(s=>s&&s.id===id);
          if(w) this.app.edSetSide(w,REPO_SIDE_CHANGES);
        });
      },
    }));
    if(!items.length) return;
    GitMenu.openList(items,'repo',null,ev);
  }

  _repoChoices(){
    const d=this.app.gitRepos||{};
    const out=[],seen=new Set();
    const name=p=>pathBase(p)||p;
    const add=e=>{
      if(!e||!e.path||!e.isRepo||seen.has(e.path)) return;
      seen.add(e.path);
      out.push({path:e.path,name:e.name||name(e.path)});
    };
    add(d.follow);
    for(const p of d.pinned||[]) add(p);
    // 지금 보고 있는 리포가 목록에 없으면 앞에 세운다 — 없으면 사용자는 자기가
    // 어디에 서 있는지 목록에서 찾지 못한다.
    if(this.p.repo&&!seen.has(this.p.repo)) out.unshift({path:this.p.repo,name:name(this.p.repo)});
    return out;
  }

  // 보기 선택은 localStorage 에 남긴다 (기기별 취향이다). 기본은 플랫이다.
  _treeMode(){
    if(this._fileView==null){
      this._fileView=PrefStore.local.get(GIT_FILE_VIEW_KEY)==='tree'?'tree':'flat';
    }
    return this._fileView==='tree';
  }

  _setFileView(mode){
    this._fileView=mode==='tree'?'tree':'flat';
    PrefStore.local.set(GIT_FILE_VIEW_KEY,this._fileView);
    this._paint();
  }

  _paintMode(el){
    const tree=this._treeMode();
    for(const b of el.querySelectorAll('.git-files-mode')){
      const on=(b.dataset.mode==='tree')===tree;
      // FR-CMP-41: **선택은 등급이 아니라 상태다.** 종전에는 켜진 쪽에
      // `ui-btn-primary` 를 붙였는데, 등급은 "이 버튼이 무슨 무게인가" 이고
      // 선택은 "지금 어느 쪽인가" 다 — 섞으면 비활성 세그먼트를 표현할 수 없다.
      // 외형은 `.ui-segment>.ui-btn.active` 가 준다.
      b.classList.toggle('active',on);
    }
    el.querySelector('.git-files').classList.toggle('tree',tree);
  }

  // ── 머리 (FR-GHM-1~8) ──

  /**
   * 머리 한 벌의 마크업. **만드는 자리는 여기 하나다** (FR-GHM-4) — 두 벌로 두면
   * 한쪽에만 버튼이 늘어나고, 그 어긋남은 탭을 바꿔야 보인다.
   *
   * FR-GHM-1: 여백은 **동작부 뒤**다. 앞에 두면 버튼이 오른쪽 끝으로 밀린다.
   *
   * `opts.remote===false` 면 원격 동작부를 뺀다 (FR-GHM-3a / U-6). 마크업을 두
   * 벌로 만들지 않고 **한 자리에서 가른다** — 그것이 FR-GHM-4 의 뜻이다.
   */
  static headHTML(opts){
    const remote=!opts||opts.remote!==false;
    return '<div class="git-head">'+
      '<span class="git-head-repo"></span><span class="git-head-branch"></span>'+
      '<span class="git-head-badges"></span><span class="git-head-ab"></span>'+
      // 원격 버튼은 기본 동작만 하고 변형은 `▾` 다이얼로그에서 온다
      // (FR-GIT-98·99). 동작은 GitRemote 가 붙인다.
      (remote?'<span class="git-head-remote">'+GIT_REMOTE_KINDS.map(k=>
        // FR-CMP-70: 주동작과 더보기가 한 테두리를 나눈다. 종전에는 부모의
        // `gap:4px` 이 **쌍 안에도** 틈을 줘서 모서리만 붙은 척했다.
        '<span class="ui-split">'+
          '<button class="ui-btn ui-btn-icon ui-btn-lg git-remote-btn" data-remote="'+k+'" disabled></button>'+
          '<button class="ui-btn ui-btn-lg git-remote-more" data-remote="'+k+'" disabled></button>'+
        '</span>'
      ).join('')+'</span>':'')+
      '<span class="git-head-spacer"></span>'+
    '</div>';
  }
}
