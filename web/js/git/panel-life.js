/**
 * GitPanel — 리포 전환과 패널의 수명 (SPLIT_REFACTOR_SRS 묶음 B).
 *
 * 활성 리포가 바뀌면 진행 중인 응답을 전부 버린다 — 세대 카운터(`_gen`)와
 * `token`/`isStale` 이 그 판정이다 (FR-GIT-16). 뷰 루트(`elFor`)는 칸마다 따로이며
 * (FR-SVS-42), 저장소가 사라졌을 때의 안내와 복구(`_enterMissing`·`_leaveMissing`,
 * FR-RMS-*)도 여기 산다.
 *
 * 이 파일이 대답하는 질문은 **"이 패널이 지금 무엇을 보고 있으며 그것이 유효한가"** 다.
 */
Object.assign(GitPanel.prototype, {
  setRepo(path){
    // FR-RTU-60: Repo 창의 패널은 저장소가 **고정**이다 (창의 루트가 그것이다) —
    // 갈아탈 대상이 없으므로 전환도 없다. 그 값은 `repo` getter 가 준다.
    if(this.root) return;
    const w=this.app._gitWindow(); if(!w) return;
    if(!w.git) w.git={repo:null};
    if(w.git.repo===path) return;
    w.git.repo=path;
    this._gen++;
    // 이전 리포의 목록이 새 리포의 헤더와 함께 보이는 순간이 있어서는 안 된다
    // (FR-GIT-16). 화면을 "불러오는 중" 으로 되돌린다.
    this._status=null; this._lastSig=null; this._lastViewFp=null; this._staleNote=false;
    // 소실과 실패 누적은 **리포에 붙은 것**이다 — 새 리포로 넘겨 오면 남의 사실이
    // 된다 (FR-RMS-6·22).
    this._missing=null; this._failStreak=0;
    // 관측을 버렸으므로 근거도 버린다 — 새 리포의 첫 관측은 무조건 그린다.
    this._obsSig=null;
    GitMenu.close();
    if(path) this._errMsg=null;
    // 진행 중인 요청의 소유권을 끊는다 — 그 응답은 가드에 걸려 버려지고, 새 리포는
    // 앞선 요청이 끝나기를 기다리지 않는다.
    this._seq++; this._busy=false; this._again=false; this._sigBusy=false;
    if(this._sigT){clearTimeout(this._sigT);this._sigT=null}
    // FR-SVS-34: 활성 리포는 창의 것이므로 **모든 칸이 같은 리포를 본다.** 그래서
    // 리포에 붙은 시선은 칸마다 되돌아간다 — 한 칸만 되돌리면 다른 칸이 이전
    // 리포의 선택·diff 를 새 리포의 헤더와 함께 보인다.
    for(const p of this.obs.panels) p._repoSwitchView(path);
    // 마지막 관측을 버렸으므로 chip 도 사라져야 한다 (FR-GIT-59).
    this.app._updateStatusBar();
    // 상단의 창 이름은 활성 리포에서 온다 — 같은 창에서 리포만 바뀌면 render 가
    // 돌지 않으므로(아래 주석의 조기 반환) 여기서 직접 고쳐 그린다.
    this.app.renderer._rTopbar();
    this._stop(); this._reschedule();
    // 활성 리포는 창에 붙어 영속한다 (FR-GIT-29). switchWindow 가 이미 활성인
    // 창에서는 조기 반환하므로 여기서 직접 저장한다 — 저장을 그쪽에 맡기면
    // "같은 창에서 리포만 바꾼" 경우가 새로고침에서 사라진다.
    this.app._save();
  },

  /**
   * 리포가 바뀔 때 **이 칸의** 시선을 되돌린다 (FR-SVS-34).
   *
   * `setRepo` 에서 뽑아낸 것이며 동작은 그대로다 — 달라진 것은 칸마다 한 번씩
   * 돈다는 것뿐이다. 이전 리포의 목록이 새 리포의 헤더와 함께 보이는 순간이
   * 어느 칸에도 있어서는 안 된다 (FR-GIT-16).
   */
  _repoSwitchView(path){
    this._shown.clear(); this.previewFile=null;
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
    // blame 은 파일에 붙은 것이다 — 새 리포로 넘겨 오면 다른 파일을 가리킨다.
    this._blameOn=false; this._blameKey=null; this._blameData=null; this._blameErr=null;
    for(const v of [this._diffView,this._previewView])
      if(v) v.clear(path?GIT_PREVIEW_HINT:GIT_NO_REPO_HINT);
    for(const v of GIT_VIEWS) if(this._els.has(v.key)) this._render(v.key);
  },

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
    // 아래의 탭별 재조회는 **`_render` 를 지난다** — 직접 `_renderHistory` 를 부르면
    // 소실 분기(FR-RMS-20)를 건너뛰어 소실 안내가 제 내용으로 덮인다.
    if(view==='history'){
      this._render(view);
      // 여기서는 루트가 아직 pane 본문에 붙기 전이라 목록의 높이가 0 이다 —
      // 붙은 뒤에 한 번 더 칠해야 스크롤 위치와 펼친 상세가 되돌아온다.
      requestAnimationFrame(()=>{if(!this._missing&&this._historyView) this._historyView.paint()});
    }
    // Branches·Stash 도 탭이 활성일 때 받는다 — 열지 않은 탭이 refs·stash 를 미리
    // 받아 둘 이유가 없다.
    // Worktrees 도 같다 — 열지 않은 탭이 목록을 미리 받아 둘 이유가 없다
    // (FR-STAT-17 과 같은 원칙).
    if(view==='branches'||view==='stash'||view==='console'||view==='worktrees')
      this._render(view);
    return el;
  },

  // Git 창이 사라졌을 때 루트를 area 로 되돌린다. 인스턴스는 살아 있다 —
  // 창은 다시 열릴 수 있다.
  /**
   * FR-SVS-46: 이 칸이 사라진다. `detach` 는 루트를 `#area` 로 되돌려 **다시
   * 열릴 수 있게** 두지만, 이쪽은 되돌아올 자리가 없으므로 DOM 까지 버린다.
   * Monaco 는 DOM 을 떼는 것으로 풀리지 않으므로 `_destroyViews` 를 지나야 한다
   * (FR-GIT-56).
   */
  destroy(){
    this.detach();
    for(const el of this._els.values()) if(el.parentNode) el.parentNode.removeChild(el);
    this._els.clear();
    this.obs.detach(this);
  },

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
  },

  // ── stale 가드 (FR-GIT-16) ──
  token(){return {gen:this._gen,repo:this.repo}},
  isStale(tok){return !tok||tok.gen!==this._gen||tok.repo!==this.repo},

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
    // FR-RMS-19·20: 소실은 탭을 가리지 않는다. **분기는 이 한 자리다** — 일곱
    // 자리에 두면 한 곳이 빠져도 조용히 지나간다.
    if(this._missing){this._renderMissing(el,view);return}
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
  },

  // ── 소실 (GIT_REPO_MISSING_SRS FR-RMS-6~11·19~21) ──

  /**
   * 소실 상태로 들어간다. **한 번만 한다** — 30초마다 오는 같은 사유에 매번
   * 골격을 부수면 사용자가 누르려던 버튼이 손 밑에서 교체된다 (FR-GIT-227 의 정신).
   *
   * 뷰의 해제는 `detach()` 와 같은 모양이다. Monaco 는 DOM 을 떼는 것으로 풀리지
   * 않으므로 `_destroyViews()` 를 지나야 하고(FR-GIT-56), 나머지 뷰도 자기 DOM 을
   * 놓아야 다시 붙일 때 두 벌이 되지 않는다.
   */
  _enterMissing(){
    if(this._missing===this.repo) return;
    this._missing=this.repo;
    // 사라진 폴더의 파일 목록을 남기지 않는다 (FR-RMS-6) — 남으면 정상으로 읽힌다.
    this._status=null; this._errMsg=null; this._staleNote=false; this._obsSig=null;
    GitMenu.close();
    // FR-SVS-33: 소실은 관측의 성질이다 — **모든 칸**이 동시에 소실로 간다.
    // 판정은 여기 한 번, 뷰 해제는 칸마다다.
    for(const p of this.obs.panels) p._enterMissingView();
  },

  // 소실이 부르는 뷰 해제. 칸마다 자기 뷰를 놓는다.
  _enterMissingView(){
    this._sel.clear(); this._anchor=null; this.previewFile=null;
    this._destroyViews();
    this._commit().unmount();
    this._history().unmount();
    this._branches().unmount();
    this._stash().unmount();
    this._console().unmount();
    this._worktrees().unmount();
    this._paintAllViews();
  },

  // 복구 (FR-RMS-11). 골격은 소실 안내가 차지했으므로 각 뷰가 다시 세운다 —
  // `_renderMissing` 이 `built` 를 비워 둔 것이 그 표식이다.
  _leaveMissing(){
    if(!this._missing) return;
    this._missing=null; this._obsSig=null;
    this.obs.paintAllViews();   // FR-SVS-33: 복구도 모든 칸에 온다
  },

  // FR-RMS-21: 대상은 **이미 만들어진 뷰 전부**다. 한 번도 열지 않은 탭은 보인 적이
  // 없으므로 낡을 수 없고, 열 때 새로 그린다 (`refresh()` 의 범위 규약과 같다).
  _paintAllViews(){
    for(const key of Array.from(this._els.keys())) this._render(key);
  },

  /**
   * FR-RMS-19: 소실을 보이는 한 벌. Changes 만 머리를 함께 세운다 — 어느 리포의
   * 이야기인지가 사라지면 사용자는 무엇이 없어졌는지 모른다.
   */
  _renderMissing(el,view){
    el.dataset.built=''; el.innerHTML='';
    if(view==='changes'){
      const head=document.createElement('div'); head.className='git-head';
      const name=document.createElement('span'); name.className='git-head-repo';
      const repo=this._missing||'';
      name.textContent=repo.split('/').filter(Boolean).pop()||repo;
      name.title=repo;
      head.appendChild(name);
      el.appendChild(head);
    }
    el.appendChild(this._missingBlock());
  },

  /**
   * FR-RMS-20: 안내를 만드는 **유일한 자리**. 문구·경로·사유·버튼이 탭마다 갈리면
   * 그것은 같은 사실이 아니게 된다.
   *
   * FR-RMS-12: 경로는 `textContent` 로만 넣는다 — 사용자의 폴더 이름이고, 마크업으로
   * 넣으면 파일 이름이 화면을 고칠 수 있다.
   */
  _missingBlock(){
    const repo=this._missing||'';
    const box=document.createElement('div'); box.className='git-missing';
    const add=(cls,text)=>{
      const d=document.createElement('div'); d.className=cls; d.textContent=text;
      box.appendChild(d); return d;
    };
    add('git-missing-title',GIT_ERR_REPO_MISSING);
    add('git-missing-path',repo);
    add('git-missing-reason',GIT_RMS_REASON_PREFIX+GIT_RMS_CODE);
    const acts=document.createElement('div'); acts.className='git-missing-acts';
    // FR-RMS-10: 핀되지 않은 리포에 핀 제거를 보이지 않는다 — 없는 핀을 지우는
    // 버튼은 거짓말이다.
    if(this._missingPinned()){
      const un=document.createElement('button');
      un.className='git-missing-unpin'; un.textContent=GIT_RMS_UNPIN;
      un.addEventListener('click',()=>this._missingUnpin());
      acts.appendChild(un);
    }
    const re=document.createElement('button');
    re.className='git-missing-recheck'; re.textContent=GIT_RMS_RECHECK;
    // FR-RMS-16·27: 사용자의 계기는 주기를 기다리지 않는다. 기존 새로고침을 지난다.
    re.addEventListener('click',()=>this.refresh());
    acts.appendChild(re);
    box.appendChild(acts);
    add('git-missing-auto',GIT_RMS_AUTO_NOTE);
    return box;
  },

  _missingPinned(){
    const pins=((this.app._gitRepos||{}).pinned)||[];
    return pins.some(p=>p&&p.path===this._missing);
  },

  /**
   * FR-RMS-9: 제거는 **기존 경로를 지난다** (`_gitUnpin`) — 새 경로를 만들면 핀의
   * 권위가 둘이 된다 (O1: 서버가 권위).
   *
   * 지운 뒤에는 활성 리포를 놓는다. 사라진 폴더의 핀까지 없앤 사용자에게 그 화면을
   * 계속 보일 이유가 없고, 돌아갈 곳은 "리포를 선택하세요" 다.
   */
  async _missingUnpin(){
    const path=this._missing; if(!path) return;
    if(await this.app._gitUnpin(path)) this.setRepo(null);
  },

  // ── Changes 탭 (FR-GIT-32~42) ──

});
