/**
 * Dongminal — Git Submodules 탭 (UX_BATCH5_SRS 묶음 D / FR-SUB-1~11)
 *
 * 목록의 진실은 `git submodule status` 다 (FR-SUB-2) — 상태 문자를 우리가 다시
 * 계산하지 않는다. 그래서 등록되었으나 초기화되지 않은 것(`-`)도, 다른 커밋에 가
 * 있는 것(`+`)도 함께 보인다: 목록이 git 과 다르면 사용자가 "왜 안 되지" 를
 * 헛갈린다.
 *
 * **골격은 `GitListTab` 이 소유한다** (FR-SUB-7, FR-DRC-7). 머리에 일괄, 그 아래
 * 안내 줄, 그 아래 `reconcileList` 로 그리는 목록 — 같은 모양의 목록이 둘이면
 * 규칙도 하나여야 한다. 여기 남는 것은 서브모듈 고유의 **내용**뿐이다.
 *
 * 보이는 것과 할 수 있는 것은 다르다 (FR-SUB-8): 초기화되지 않은 서브모듈에는
 * 여는 길도 터미널도 붙지 않는다 — 열 저장소가 아직 없기 때문이며, 눌리지만
 * 아무 일도 하지 않는 버튼은 고장으로 읽힌다 (FR-GIT-180).
 */
class GitSubmodules extends GitListTab {
  constructor(panel){
    super(panel,'git-sub');
  }

  // ── 골격이 채워 달라는 자리 ──

  _headHTML(){
    return '<button class="git-sub-bulk" data-act="update"></button>'+
           '<button class="git-sub-bulk" data-act="sync"></button>';
  }

  _mountHead(el){
    for(const b of el.querySelectorAll('.git-sub-bulk')){
      b.textContent=GIT_SUB_BULK_LABEL[b.dataset.act]||'';
      b.title=GIT_SUB_BULK_TITLE[b.dataset.act]||'';
      // FR-SUB-9: 대상이 **전부**다 — 경로를 비워 보내는 것이 그 뜻이다.
      b.addEventListener('click',()=>this._act(b.dataset.act,null));
    }
  }

  // FR-SUB-9: 서브모듈이 없으면 일괄에 뜻이 없다 (FR-WBR-53 과 같은 근거).
  _paintHead(){
    for(const b of this._el.querySelectorAll('.git-sub-bulk'))
      b.disabled=!this._list.length||this._busy;
  }

  _emptyText(){return GIT_SUB_EMPTY}

  _sigParts(e){
    return [e.path,e.oid||'',e.state||'',e.describe||'',this._busy?1:0];
  }

  _rowEl(e){
    const d=document.createElement('div');
    d.className='git-sub-row';
    d.dataset.path=e.path; d.dataset.state=e.state||'';

    const p=document.createElement('span'); p.className='git-sub-path';
    p.textContent=e.path; p.title=e.absPath||e.path;

    const st=document.createElement('span');
    st.className='git-sub-state'; st.dataset.state=e.state||'';
    st.textContent=GIT_SUB_STATE_LABEL[e.state]||e.state||'';
    if(GIT_SUB_STATE_TITLE[e.state]) st.title=GIT_SUB_STATE_TITLE[e.state];

    // 등록된 커밋. 앞 7자인 것은 머리·History 와 같은 규약이다.
    const oid=document.createElement('code'); oid.className='git-sub-oid';
    oid.textContent=(e.oid||'').slice(0,7); oid.title=e.oid||'';

    d.appendChild(p); d.appendChild(st); d.appendChild(oid);
    if(e.describe){
      const ds=document.createElement('span'); ds.className='git-sub-desc';
      ds.textContent=e.describe;
      d.appendChild(ds);
    }
    const sp=document.createElement('span'); sp.className='git-sub-rowspacer';
    d.appendChild(sp);

    const acts=document.createElement('span'); acts.className='git-sub-acts';
    for(const a of this._actsOf(e)){
      const btn=document.createElement('button');
      btn.className='git-sub-act'; btn.dataset.act=a;
      btn.textContent=GIT_SUB_ACT_LABEL[a]; btn.title=GIT_SUB_ACT_TITLE[a];
      btn.disabled=!!this._busy;
      btn.addEventListener('click',ev=>{ev.stopPropagation();this._act(a,e)});
      acts.appendChild(btn);
    }
    d.appendChild(acts);
    return d;
  }

  /**
   * 행이 가질 수 있는 동작 (FR-SUB-8).
   *
   * 초기화되지 않은 것에는 **`init` 이 서고 `open`·`update`·`term` 이 서지 않는다** —
   * 열 저장소가 아직 없다. `init` 은 `update --init` 이므로 명령이 하나 더 생기는
   * 것이 아니라 같은 명령의 다른 이름이다: 사용자가 보는 말만 그 상태에 맞춘다.
   */
  _actsOf(e){
    if(e.state===GIT_SUB_STATE_UNINIT) return ['init','sync'];
    return ['open','update','sync','term'];
  }

  _act(act,e){
    // e 가 없으면 머리의 일괄이다 — 대상은 저장소의 서브모듈 전부다 (FR-SUB-9).
    const path=e?e.path:'';
    if(act==='open'){this.app.openGitWindow(e.absPath||'');return}
    // FR-GIT-244 와 같은 경로다 — 터미널은 Git 창이 아닌 창에 연다.
    if(act==='term'){this.app.gitOpenTerminal(e.absPath||'');return}
    if(act==='sync'){this._sync(path);return}
    /**
     * `init` 과 `update` 는 같은 명령이고 `--init` 만 다르다.
     *
     * **일괄은 언제나 `--init` 이다** (FR-SUB-9 는 "update --init 전부" 를
     * 요구한다). 대상이 전부라면 그 안에 초기화되지 않은 것이 섞여 있을 수 있고,
     * `--init` 없이는 그것들만 조용히 건너뛴다 — 사용자는 "전부" 를 눌렀는데
     * 일부가 그대로인 것을 고장으로 읽는다.
     */
    if(act==='init'||act==='update'){this._update(path,act==='init'||!e);return}
  }

  // ── 질의 ──

  async _load(){
    await gitLoadList(this,{url:'/api/git/submodules',key:'submodules',failMsg:GIT_SUB_LOAD_FAIL});
  }


  // ── 쓰기 ──

  /**
   * FR-SUB-5: `update` 는 **파괴적이다** — 서브모듈 안의 체크아웃이 옮겨지며,
   * 커밋되지 않은 변경이 있으면 git 이 거부하거나 덮는다. 그래서 2단계 확인을
   * 거치고, 확인창은 실행될 명령을 밝힌다 (discard 와 같은 규약).
   */
  _update(path,init){
    const repo=this.panel.repo;
    const target=path||GIT_SUB_ALL;
    const argv=['git','submodule','update'];
    if(init) argv.push('--init');
    if(path) argv.push('--',gitShQuote(path));
    return GitDialog.confirm({
      action:GIT_SUB_UPDATE_ACTION,title:GIT_SUB_UPDATE_TITLE,targets:[target],
      hint:{note:GIT_SUB_UPDATE_NOTE,command:argv.join(' ')},
      stages:2,
      run:()=>this._run('/api/git/submodules/update',
        {repo,path,init,recursive:false,confirm:true},GIT_SUB_UPDATED+target,GIT_SUB_UPDATE_FAIL),
    });
  }

  /**
   * `sync` 는 `.gitmodules` 의 URL 을 설정으로 옮길 뿐 체크아웃을 건드리지 않는다 —
   * 파괴적이 아니므로 1단계다 (FR-SUB-5). 그래도 확인을 거치는 이유는 저장소를
   * 바꾸는 조작의 확인이 한 자리를 지나야 하기 때문이다 (FR-COS-1).
   */
  _sync(path){
    const repo=this.panel.repo;
    const target=path||GIT_SUB_ALL;
    const argv=['git','submodule','sync'];
    if(path) argv.push('--',gitShQuote(path));
    return GitDialog.confirm({
      action:GIT_SUB_SYNC_ACTION,title:GIT_SUB_SYNC_TITLE,targets:[target],
      hint:{note:GIT_SUB_SYNC_NOTE,command:argv.join(' ')},
      stages:1,
      run:()=>this._run('/api/git/submodules/sync',
        {repo,path,confirm:true},GIT_SUB_SYNCED+target,GIT_SUB_SYNC_FAIL),
    });
  }

  /**
   * 쓰기 한 번의 단일 통로. 진행 중에는 버튼을 잠근다 — `submodule update` 는
   * 원격에서 받아올 수 있어 초 단위로 걸리고, 그동안 같은 버튼이 다시 눌리면
   * 두 번째 git 이 첫 번째의 index.lock 에 걸려 실패한다.
   */
  async _run(url,body,okMsg,failMsg){
    this._busy=true;
    if(this._el) this._paintList();
    const res=await this.panel.post(url,body);
    this._busy=false;
    if(res.ok){
      this._note={kind:'done',msg:okMsg};
      // 상태가 바뀌었다 — 목록과 Changes 를 함께 새로 받는다. 서브모듈이 옮겨지면
      // 부모의 gitlink 도 달라지므로 둘이 같은 회차에 갱신돼야 한다.
      this._load();
      this.panel.signal('submodule');
      return {ok:true};
    }
    const d=(res&&res.data)||{};
    this._note={kind:'fail',msg:failMsg};
    if(this._el){this._paintNote();this._paintList()}
    // 사유와 stderr tail 은 다이얼로그 안에서 보인다 (FR-GIT-96·175).
    return {ok:false,reason:this.panel.writeReason(res),stderrTail:d.message||''};
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (worktrees.js 와 같은 규약).
window.GitSubmodules=GitSubmodules;
