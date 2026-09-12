/**
 * Dongminal — Git Branches 탭 (GIT_SRS §3D.1 / FR-GIT-147~160)
 *
 * 목록은 **14단계의 `/api/git/refs` 를 그대로 쓴다** (FR-GIT-147) — 이름·대상·
 * upstream·ahead/behind 를 이미 주므로 새 조회를 만들지 않는다.
 *
 * 트리는 즐겨찾기 / 로컬 / 원격 / 태그 4그룹이고, 이름에 `/` 가 있으면 첫 조각으로
 * 다시 묶는다 (FR-GIT-148·149·150). 검색 중에는 접힘을 무시한다 — 일치하는 이름이
 * 접힌 그룹 안에 숨어 있으면 사용자는 없다고 읽는다 (FR-GIT-151).
 *
 * 쓰기 경로는 **static** 이다. 우클릭 메뉴는 History 탭의 refs 사이드바에서도
 * 열리므로 checkout 이 이 탭의 인스턴스에 묶여 있으면 그쪽에서 쓸 수 없다.
 *
 * 기본은 항상 안전한 쪽이다 (FR-GIT-97, O14): dirty checkout 의 기본은 취소이고,
 * 강제는 `GitConfirm` 의 파괴적 확인을 거친다.
 *
 * **이 파일은 목록의 수명이다** (FE_MODULE_BOUNDARY_SRS FR-FMB-30) — 마운트 ·
 * 적재 · 선택 · 칠하기의 진입. 나머지는 갈라져 나갔다:
 *
 *   branches-tree.js      트리를 그린다 — 그룹 · 접두어 · 행 · 즐겨찾기 · 접힘
 *   branches-ops.js       쓰기 동작 27 (전부 static — 위 문단이 그 이유다)
 *   branches-dialogs.js   생성 · 이름 변경 · 업스트림 다이얼로그
 */
class GitBranches {
  constructor(panel){
    this.panel=panel;
    this.app=panel.app;
    this._el=null;
    this._repo=undefined; // 화면에 채워 둔 리포. 바뀌면 전부 되돌린다 (FR-GIT-16)
    this.reset();
  }

  // 리포에 붙은 것은 전부 여기서 지운다. 검색어도 함께 되돌린다 — 이전 리포의
  // 필터가 새 리포의 목록을 조용히 걸러내면 사용자는 브랜치가 없다고 읽는다.
  reset(){
    this._refs=[];
    this._err=null;
    this._loading=false;
    // GIT_REFRESH_LIFECYCLE_SRS FR-GRF-22: **이 리포의 목록을 받아 본 적이 있는가.**
    // 값은 받기를 끝낸 리포 경로다 (성공·실패 모두). `null` 은 아직 없다는 뜻이다.
    this._loadedFor=null;
    this._q='';
    this._head=null;   // 현재 브랜치. 바뀌면 목록의 ✓ 가 따라야 한다
    this._barRepo=null;
    // FR-GIT-254: 일괄 삭제의 대상. **로컬 브랜치만** 담는다 — 원격 ref 와 태그는
    // 이 동작의 대상이 아니다. 리포가 바뀌면 함께 비워진다 (FR-GIT-16).
    this._sel=new Set();
  }

  // ── 다중 선택 (FR-GIT-254) ──

  // 목록에 남아 있는 로컬 브랜치만 뜻이 있다 — 사라진 이름의 선택은 저절로 잊힌다
  // (Changes 탭의 선택과 같은 규약).
  selection(){
    const live=new Set(this._refs.filter(r=>r.kind===GIT_REF_KIND_LOCAL).map(r=>r.short));
    return [...this._sel].filter(s=>live.has(s));
  }

  clearSelection(){
    if(!this._sel.size) return;
    this._sel.clear();
    this._paintTree();
  }

  _toggleSel(short){
    if(this._sel.has(short)) this._sel.delete(short); else this._sel.add(short);
    this._paintTree();
  }

  // ── 골격 ──

  // 골격은 루트가 다시 만들어질 때 한 번 세운다. 리스너도 그때 한 번만 붙는다 —
  // paint 는 칠하기만 한다.
  mount(el){
    if(!el) return;
    this._el=el;
    el.innerHTML=
      '<div class="git-br-bar">'+
        '<input class="git-br-search" type="text">'+
        '<span class="git-br-spacer"></span>'+
        '<button class="git-br-new"></button>'+
      '</div>'+
      '<div class="git-br-note">'+
        '<span class="git-br-note-msg"></span>'+
        '<button class="git-br-retry"></button>'+
      '</div>'+
      '<div class="git-br-tree"></div>'+
      // FR-GIT-269: 원격 목록. 트리 **아래**에 둔다 — 브랜치가 이 탭의 본체이고
      // 원격 설정은 그것을 보조한다. 채우는 것은 GitRemoteList 다 (remote.js).
      '<div class="git-br-remotes"></div>';
    el.querySelector('.git-br-search').placeholder=GIT_BR_SEARCH_PLACEHOLDER;
    const brNew=el.querySelector('.git-br-new');
    brNew.textContent=GIT_BR_NEW; brNew.title=GIT_BR_NEW_TITLE;
    const brRetry=el.querySelector('.git-br-retry');
    brRetry.textContent=GIT_BR_RETRY; brRetry.title=GIT_TIP_RETRY;
    el.querySelector('.git-br-search').addEventListener('input',ev=>{
      this._q=ev.target.value; this._paintTree();
    });
    el.querySelector('.git-br-new').addEventListener('click',()=>
      GitBranches.create(this.panel,{}));
    el.querySelector('.git-br-retry').addEventListener('click',()=>{
      this._err=null; this._load();
    });
    this._el.dataset.repo='';
    // FR-GIT-269: 원격 목록은 자기 상태를 스스로 든다 — 골격 자리만 내준다.
    this._remotes().mount(el.querySelector('.git-br-remotes'));
    // 골격이 새로 세워졌으므로 다음 paint 가 리포 상태를 다시 채운다.
    this._repo=undefined;
  }

  unmount(){
    if(this._remotesView) this._remotesView.unmount();
    this._el=null;
    this._repo=undefined;
  }

  // FR-GIT-269: 원격 목록 (remote.js 가 소유한다). 지연 생성이며, 목록을 다시
  // 받아야 하는 쪽(원격 add/remove 를 밖에서 한 경우)이 reloadRemotes 를 부른다.
  _remotes(){
    if(!this._remotesView) this._remotesView=new GitRemoteList(this.panel);
    return this._remotesView;
  }

  reloadRemotes(){return this._remotes().reload()}

  // FR-GVR-4: **열지 않은 뷰에는 요청이 가지 않는다.** 위 `reloadRemotes` 는
  // 없으면 만들므로 폴링 경로가 쓸 수 없다 — 관측마다 `git config --list` 가
  // 한 번씩 늘어난다.
  reloadRemotesIfOpen(){return this._remotesView?this._remotesView.reload():undefined}

  // ── 칠하기 ──

  paint(){
    if(!this._el) return;
    if(this.panel.repo!==this._repo) this._adopt();
    /**
     * FR-GRF-23 (flaky `git-branches` B6): **빈 목록이 굳지 않는다.**
     *
     *   이전 동작: 목록을 다시 받는 계기는 리포 교체와 ref 쓰기뿐이었다
     *   새  동작: 리포가 있는데 아직 받은 적이 없고 받는 중도 아니면 여기서 받는다
     *   이유:     `_adopt()` 가 리포 없이 도는 회차(`if(!this._repo) return`)와
     *             낡은 응답으로 빠져나간 `_load()` 가 `_refs=[]` 를 남긴다. 그
     *             뒤 관측 signature 가 같으면 `_obsSig` 가드가 `paintAll` 까지
     *             막아 빈 목록이 영구히 굳었다 (`11 §5` 8번)
     *
     * 실패도 "받은 적 있음" 이므로 실패가 되풀이되지 않는다.
     */
    else if(this._repo&&!this._loading&&this._loadedFor!==this._repo) this._load();
    if(!this._el) return;
    this._paintBar();
    this._paintTree();
    this._remotes().paint();
  }

  /**
   * 폴링이 새 status 를 얻을 때마다 불린다. 목록에 영향을 주는 것은 현재 브랜치
   * 하나뿐이다 — 그 밖의 것으로 refs 를 다시 받으면 매초 git 을 실행한다.
   *
   * 창 밖에서(터미널의 `git checkout`) 옮겨 간 것도 이 경로로 들어온다.
   */
  paintStatus(){
    if(!this._el||this.panel.repo!==this._repo) return;
    const h=this.panel.headName();
    if(h===this._head) return;
    this._head=h;
    this._load();
  }

  // ref 를 바꾼 쓰기 뒤에 `GitPanel.afterRefWrite` 가 부른다 (FR-GIT-160). status
  // 하나로는 어느 브랜치가 생겼는지 사라졌는지 알 수 없으므로 목록을 다시 받는다.
  reload(){return this._load()}

  _adopt(){
    this._repo=this.panel.repo;
    this.reset();
    if(!this._el) return;
    this._el.dataset.repo=this._repo||'';
    if(!this._repo) return;
    this._head=this.panel.headName();
    this._load();
  }

  _paintBar(){
    const el=this._el;
    // 입력값은 사용자가 치는 중일 수 있다 — 리포가 바뀔 때만 되돌린다.
    if(this._barRepo!==this._repo){
      this._barRepo=this._repo;
      el.querySelector('.git-br-search').value=this._q;
    }
    // FR-GIT-132 과 같은 규약: 사유를 보이고 목록은 지우지 않는다.
    const note=el.querySelector('.git-br-note');
    note.classList.toggle('vis',!!this._err);
    note.querySelector('.git-br-note-msg').textContent=this._err||'';
  }

  // ── 질의 ──

  async _load(){
    const repo=this._repo; if(!repo) return;
    const tok=this.panel.token();
    // FR-GRF-31: 앞선 조회를 끊는다. 표는 잠금의 임자도 가른다.
    const t=gitLoadTicket(this);
    this._loading=true;
    const res=await gitFetch('/api/git/refs',{repo},
      {stale:()=>this.panel.isStale(tok),echo:{repo},signal:t.signal});
    if(gitLoadTaken(this,t)) return;
    // FR-GRF-24: 낡은 응답은 **그 값을 쓰지 않는 것**이지 잠금을 영원히 쥐는
    // 것이 아니다. 종전에는 여기서 `_loading=true` 인 채로 빠져나갔고, 그러면
    // 위 `paint()` 의 재조회도 함께 막혔다.
    this._loading=false;
    if(res.stale) return;
    this._loadedFor=repo;
    if(!res.ok){
      // 사유를 보이고 **이미 받은 목록을 지우지 않는다.**
      this._err=GIT_BR_LOAD_FAIL;
      if(this._el) this.paint();
      return;
    }
    const d=res.data;
    this._err=null;
    this._refs=Array.isArray(d.refs)?d.refs:[];
    if(this._el) this.paint();
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitBranches=GitBranches;
