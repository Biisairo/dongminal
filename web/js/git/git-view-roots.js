/**
 * GitViewRoots — Git 패널의 뷰 루트 부품: 칸마다의 루트 DOM · 그리기 분기 · 낡음 배너 · 저장소 소실의 안내와
 * 복구 (FR-SVS-42 · GIT_REFRESH_LIFECYCLE_SRS FR-GRF-9~12 · GIT_REPO_MISSING_SRS FR-RMS-6~21 ·
 * REFACTOR3_FE_GITPANEL_SRS 7g FR-FEP-7). 소유 필드는 없다 — 루트 맵(`_els`)·소실(`_missing`)·뷰 필드는 패널의 것이다.
 * 리포 전환·파괴는 패널 본문(`panel.js`)에 있다.
 *
 * `_paint` 는 패널 위임자를 지난다 — e2e·시험이 패널 인스턴스에서 그것을 덮는다.
 */
class GitViewRoots extends GitPart {

  elFor(view){
    // FR-OPT-4-9: 아래 `_render` 가 리포를 새로 채택하는지 가르는 값이다 (`_staleTake`).
    const vf=GIT_VIEW_FIELD_BY_KEY[view];
    const before=vf&&this.p[vf]?this.p[vf]._repo:undefined;
    let el=this.p._els.get(view);
    if(!el){
      el=document.createElement('div');
      el.className='git-view git-'+view;
      this.p._els.set(view,el);
      this._render(view);
    }
    // 탭 전환마다 루트가 DOM 에서 떼였다 붙는다 — 편집기는 그 사이 크기를 0 으로
    // 보므로 다시 붙은 뒤 한 번 재배치한다.
    if(view==='diff'&&this.p._diffView) TIMERS.frame(()=>this.p._diffView.layout(),{owner:this.p,label:'diff-layout'});
    // History 는 탭이 활성일 때만 목록을 받는다 — 열지 않은 탭이 10,000 커밋을
    // 미리 받아 둘 이유가 없다.
    // 아래의 탭별 재조회는 **`_render` 를 지난다** — 직접 `_renderView` 를 부르면
    // 소실 분기(FR-RMS-20)를 건너뛰어 소실 안내가 제 내용으로 덮인다.
    if(view==='history'){
      this._render(view);
      // 여기서는 루트가 아직 pane 본문에 붙기 전이라 목록의 높이가 0 이다 —
      // 붙은 뒤에 한 번 더 칠해야 스크롤 위치와 펼친 상세가 되돌아온다.
      TIMERS.frame(()=>{if(!this.p._missing&&this.p._historyView) this.p._historyView.paint()},{owner:this.p,label:'history-paint'});
    }
    // Branches·Stash 도 탭이 활성일 때 받는다 — 열지 않은 탭이 refs·stash 를 미리
    // 받아 둘 이유가 없다.
    // Worktrees 도 같다 — 열지 않은 탭이 목록을 미리 받아 둘 이유가 없다
    // (FR-STAT-17 과 같은 원칙).
    if(view==='branches'||view==='stash'||view==='console'||view==='worktrees'||view==='submodules')
      this._render(view);
    // FR-OPT-4-9 (FR-GVR-4 개정): 보이지 않는 동안 지나간 변화를 지금 받는다.
    this.p._staleTake(view,before);
    return el;
  }

  /**
   * 이 뷰가 저장하지 않은 편집을 들고 있는가 (FR-RTU-103).
   *
   * Diff 만 편집을 든다 — `GitDiffView` 가 unstaged·conflict 축에서 열린다.
   * 다른 뷰는 읽기이므로 언제나 false 다.
   *
   * REPO_FIX 05 §3A-3: 편집은 공유 문서의 것이다. 라벨(●)은 문서 dirty 이고,
   * `closing`(닫기 확인)은 이 뷰가 그 문서의 **마지막 뷰**일 때만 참이다 — 다른
   * 뷰가 들고 있으면 닫아도 편집은 문서에 남는다.
   */
  viewDirty(view,closing){
    const v=view==='diff'?this.p._diffView:null;
    if(!v) return false;
    return closing?v.dirtyLast:v.dirty;
  }

  /**
   * 이 뷰의 편집을 저장한다. 들고 있지 않으면 할 일이 없으므로 true 다 —
   * "저장할 것이 없었다" 와 "저장했다" 는 호출자에게 같은 답이어야 한다.
   */
  async viewSave(view){
    if(!this.viewDirty(view,true)) return true;
    return await this.p._diffView.save();
  }

  /**
   * REPO_TAB_UNIFY_SRS FR-RTU-34 + NFR-RTU-3: 뷰 **하나**의 DOM 을 놓는다.
   *
   * 탭이 닫히는 자리가 부른다. `destroy` 와 다른 것은 범위다 — 패널은 살아 있고
   * 스크롤·선택·diff 대상 같은 **상태는 필드에 남는다.** 다시 열면 `elFor` 가
   * 골격을 새로 세우고 그 상태로 칠한다.
   *
   * 편집기는 DOM 을 떼는 것으로 풀리지 않으므로 diff 뷰는 명시적으로 버린다
   * (FR-GIT-56) — 그러지 않으면 탭을 닫아도 인스턴스가 남아 NFR-RTU-3 이 깨진다.
   *
   * **저장하지 않은 편집의 확인은 이 함수 앞에서 끝나 있어야 한다** (FR-RTU-103).
   * 여기까지 오면 `destroy()` 가 편집을 버리므로 되돌릴 수 없다 — 호출자
   * (`closeTab`)가 그 순서를 진다.
   */
  dropView(view){
    const el=this.p._els.get(view); if(!el) return;
    if(view==='diff'&&this.p._diffView){
      this.p._diffView.destroy(); this.p._diffView=null;
      this.p._hunkBarDispose();
      this.p._diffKey=null; this.p._hunkKey=null; this.p._hunks=null;
    }
    // FR-RST-20·21: 맵을 손으로 적지 않는다 — 종전 맵에 Submodules 가 빠져 탭을
    // 닫아도 언마운트되지 않았다. 출처는 `GIT_VIEWS` 하나다.
    const v=GIT_VIEW_FIELD_BY_KEY[view];
    if(v&&this.p[v]&&this.p[v].unmount) this.p[v].unmount();
    if(el.parentNode) el.parentNode.removeChild(el);
    this.p._els.delete(view);
    if(this.p._staleViews) this.p._staleViews.delete(view);
  }

  // 5단계는 changes 를 채운다. diff 는 7단계가 채운다.
  _render(view){
    const el=this.p._els.get(view); if(!el) return;
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
    if(this.p._missing){this._renderMissing(el,view);return}
    this._renderBody(view,el);
    // FR-GRF-9: 골격이 방금 섰어도 낡음은 보여야 한다. 관측이 다음 회차에
    // 칠해 주기를 기다리면, 실패한 상태에서 탭을 여는 동안 화면이 조용하다.
    this._paintStaleIn(el);
  }

  _renderBody(view,el){
    if(view==='changes') return this.p._renderChanges(el);
    if(view==='diff') return this.p._renderDiff(el);
    if(GIT_VIEW_KINDS[view]) return this.p._renderView(view,el);
    el.innerHTML='';
    if(!this.p.repo) this.p._emptyHint(el,GIT_NO_REPO_HINT);
  }

  /**
   * GIT_REFRESH_LIFECYCLE_SRS FR-GRF-9~12 (`GP-4`): **낡음 배너는 모든 git 뷰에
   * 걸린다.**
   *
   *   이전 동작: `.git-stale-note` 가 Changes 골격 안에만 있었다. History·
   *             Branches·Stash·Console·Worktrees·Submodules·Diff 를 보는 동안
   *             망 실패·서버 재시작·권한 상실이 나면 화면은 **아무 표시 없이**
   *             마지막으로 성공한 목록을 계속 보였다
   *   새  동작: 소실 안내와 같은 자리(이 파일)에서 뷰 공통으로 그린다
   *   이유:     `_staleNote`·`_errMsg` 는 **관측기의 값**이라 이미 모든 패널이
   *             공유한다. 그리는 요소만 한 뷰에 갇혀 있었다 (`11 GP-4`)
   *
   * 골격에 자리를 미리 파지 않고 **필요할 때 끼운다** — 뷰가 여덟이고 각자
   * 자기 마크업을 갖는데, 여덟 곳에 같은 한 줄을 두면 다음 뷰가 늘 때 한 곳이
   * 빠진다. 그것이 이 결함이 생긴 방식이다.
   */
  _staleInfo(){
    // FR-GRF-12: 소실은 확정된 사실이고 낡음은 그 상위 집합이다 — 겹쳐 보이지 않는다.
    if(this.p._missing) return null;
    if(this.p._errMsg) return {text:this.p._errMsg,loading:false};
    if(this.p._staleNote) return {text:GIT_STALE_NOTE,loading:false};
    // 아직 불러오는 중인 것은 오류가 아니다 — 같은 자리에 다른 색으로 알린다.
    if(!(this.p._status&&this.p._status.status)) return {text:GIT_LOADING_HINT,loading:true};
    return null;
  }

  _paintStaleIn(el){
    if(!el) return;
    const info=this._staleInfo();
    let note=null;
    for(const c of el.children) if(c.classList&&c.classList.contains('git-stale-note')){note=c;break}
    if(!info){ if(note) note.classList.remove('vis'); return }
    if(!note){
      note=document.createElement('div');
      note.className='ui-notice ui-notice-attn git-stale-note';
      // 자리는 머리 바로 아래다 — Changes 에서 그랬던 그 자리이며, 머리가 없는
      // 뷰에서는 맨 위다.
      let head=null;
      for(const c of el.children) if(c.classList&&c.classList.contains('git-head')){head=c;break}
      el.insertBefore(note,head?head.nextSibling:el.firstChild);
      // UX_AUDIT_FIX_SRS FR-UXF-29: 수동 git 새로고침이 없으므로(FR-UXF-27) 복구 길은 앱 새로고침이다.
      note.append(document.createElement('span'),
        UIKit.button({label:t('core.reload_app'),kind:'ghost',size:'sm',cls:'git-stale-reload',onClick:()=>this.app.wsSync.reload.softReload()}));
    }
    note.firstChild.textContent=info.text;
    note.classList.add('vis');
    note.classList.toggle('loading',info.loading);
  }

  // 골격이 선 뷰 전부. 목록을 따로 적지 않는다 (`paintHeads` 와 같은 규약).
  paintStale(){
    for(const el of this.p._els.values())
      if(el.dataset.built==='1') this._paintStaleIn(el);
  }

  // ── 소실 (GIT_REPO_MISSING_SRS FR-RMS-6~11·19~21) ──

  /**
   * 소실 상태로 들어간다. **한 번만 한다** — 30초마다 오는 같은 사유에 매번
   * 골격을 부수면 사용자가 누르려던 버튼이 손 밑에서 교체된다 (FR-GIT-227 의 정신).
   *
   * 뷰의 해제는 `detach()` 와 같은 모양이다. 편집기는 DOM 을 떼는 것으로 풀리지
   * 않으므로 `_destroyViews()` 를 지나야 하고(FR-GIT-56), 나머지 뷰도 자기 DOM 을
   * 놓아야 다시 붙일 때 두 벌이 되지 않는다.
   */
  _enterMissing(){
    if(this.p._missing===this.p.repo) return;
    this.p._missing=this.p.repo;
    // 사라진 폴더의 파일 목록을 남기지 않는다 (FR-RMS-6) — 남으면 정상으로 읽힌다.
    this.p._status=null; this.p._errMsg=null; this.p._staleNote=false; this.p._obsSig=null;
    GitMenu.close();
    // FR-SVS-33: 소실은 관측의 성질이다 — **모든 칸**이 동시에 소실로 간다.
    // 판정은 여기 한 번, 뷰 해제는 칸마다다.
    for(const p of this.p.obs.panels) p._enterMissingView();
  }

  // 소실이 부르는 뷰 해제. 칸마다 자기 뷰를 놓는다.
  _enterMissingView(){
    this.p._sel.clear(); this.p._anchor=null; this.p.previewFile=null;
    this.p._destroyViews();
    this.p._commit().unmount();
    this.p._history().unmount();
    this.p._branches().unmount();
    this.p._stash().unmount();
    this.p._console().unmount();
    this.p._worktrees().unmount();
    this._paintAllViews();
  }

  // 복구 (FR-RMS-11). 골격은 소실 안내가 차지했으므로 각 뷰가 다시 세운다 —
  // `_renderMissing` 이 `built` 를 비워 둔 것이 그 표식이다.
  _leaveMissing(){
    if(!this.p._missing) return;
    this.p._missing=null; this.p._obsSig=null;
    this.p.obs.paintAllViews();   // FR-SVS-33: 복구도 모든 칸에 온다
  }

  // FR-RMS-21: 대상은 **이미 만들어진 뷰 전부**다. 한 번도 열지 않은 탭은 보인 적이
  // 없으므로 낡을 수 없고, 열 때 새로 그린다 (`refresh()` 의 범위 규약과 같다).
  _paintAllViews(){
    for(const key of Array.from(this.p._els.keys())) this._render(key);
  }

  /**
   * FR-RMS-19: 소실을 보이는 한 벌. Changes 만 머리를 함께 세운다 — 어느 리포의
   * 이야기인지가 사라지면 사용자는 무엇이 없어졌는지 모른다.
   */
  _renderMissing(el,view){
    el.dataset.built=''; el.innerHTML='';
    if(view==='changes'){
      const head=document.createElement('div'); head.className='git-head';
      const name=document.createElement('span'); name.className='git-head-repo';
      const repo=this.p._missing||'';
      name.textContent=pathBase(repo)||repo;
      name.title=repo;
      head.appendChild(name);
      el.appendChild(head);
    }
    el.appendChild(this._missingBlock());
  }

  /**
   * FR-RMS-20: 안내를 만드는 **유일한 자리**. 문구·경로·사유·버튼이 탭마다 갈리면
   * 그것은 같은 사실이 아니게 된다.
   *
   * FR-RMS-12: 경로는 `textContent` 로만 넣는다 — 사용자의 폴더 이름이고, 마크업으로
   * 넣으면 파일 이름이 화면을 고칠 수 있다.
   */
  _missingBlock(){
    const repo=this.p._missing||'';
    const box=document.createElement('div'); box.className='git-missing';
    box.appendChild(domEl('div','git-missing-title',GIT_ERR_REPO_MISSING));
    box.appendChild(domEl('div','git-missing-path',repo));
    box.appendChild(domEl('div','git-missing-reason',GIT_RMS_REASON_PREFIX+GIT_RMS_CODE));
    const acts=document.createElement('div'); acts.className='git-missing-acts';
    // FR-RMS-10: 핀되지 않은 리포에 핀 제거를 보이지 않는다 — 없는 핀을 지우는
    // 버튼은 거짓말이다.
    if(this._missingPinned()){
      acts.appendChild(UIKit.button({label:GIT_RMS_UNPIN,title:GIT_TIP_MISSING_UNPIN,size:'sm',
        cls:'git-missing-unpin',onClick:()=>this._missingUnpin()}));
    }
    // FR-RMS-16·27: 사용자의 계기는 주기를 기다리지 않는다. 기존 새로고침을 지난다.
    acts.appendChild(UIKit.button({label:GIT_RMS_RECHECK,title:GIT_TIP_MISSING_RECHECK,size:'sm',
      cls:'git-missing-recheck',onClick:()=>this.p.refresh()}));
    box.appendChild(acts);
    box.appendChild(domEl('div','git-missing-auto',GIT_RMS_AUTO_NOTE));
    return box;
  }

  _missingPinned(){
    const pins=((this.app.gitRepos||{}).pinned)||[];
    return pins.some(p=>p&&p.path===this.p._missing);
  }

  /**
   * FR-RMS-9: 제거는 **기존 경로를 지난다** (`gitUnpin`) — 새 경로를 만들면 핀의
   * 권위가 둘이 된다 (O1: 서버가 권위).
   *
   * 지운 뒤에는 활성 리포를 놓는다. 사라진 폴더의 핀까지 없앤 사용자에게 그 화면을
   * 계속 보일 이유가 없고, 돌아갈 곳은 "리포를 선택하세요" 다.
   */
  async _missingUnpin(){
    const path=this.p._missing; if(!path) return;
    if(await this.app.git.sync.gitUnpin(path)) this.p.setRepo(null);
  }
}
