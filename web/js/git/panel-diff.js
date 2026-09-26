/**
 * GitPanel — 고른 것을 보여 주는 일 (SPLIT_REFACTOR_SRS 묶음 B).
 *
 * 행 선택에서 diff 로 가는 길(`_select`·`_openDiff`·`_showTarget`)과 Diff 탭·Changes
 * 미리보기의 두 `GitDiffView` 가 여기 산다. blame 은 `panel-blame.js`, 부분 스테이징
 * (`_paintHunks`·`_hunkBar*`·`_hunkAct`, FR-GIT-278·279)은 `panel-hunks.js`, 디렉터리 항목의 사유·진입점
 * (`_dirEntryNote`·`_dirEntryActs`)은 `panel-dir-entry.js` 다 (FR-OPT-12-4).
 *
 * 조각은 서버가 만든 diff 에서 온다 — 이 파일이 만들지 않는다. **화면에 그리지도
 * 않는다** (DIFF_HUNK_BAR_SRS): diff 를 그리는 것은 Monaco 하나이고, 여기가 얹는
 * 것은 그 위에 hover 로 뜨는 동작 툴바뿐이다.
 */
Object.assign(GitPanel.prototype, {
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
  /**
   * FR-RTU-51 / D-RTU-8 (개정 — 사용자 지시 2026-09-08: "vsc 의 패턴을 똑같이"):
   * **비교의 왼쪽이 아예 없는 행만 편집기로 연다.**
   *
   *   이전 규칙: `untracked` 인가 — 그룹의 성질로 갈랐다
   *   새   규칙: 그 행의 **축에서 왼쪽이 실재하는가** — 항목의 상태로 가른다
   *   이유:     같은 파일이 상태에 따라 두 그림을 갖는다. 새 파일을 스테이지한 뒤
   *             고치면 `Changes` 행의 축(index↔worktree)에는 양쪽이 다 있으므로
   *             diff 가 뜻을 갖고, 다시 스테이지하거나 되돌리면 한쪽이 사라져
   *             편집기가 맞다. VS Code 가 그렇게 가른다
   *
   * 왼쪽이 없는 자리는 둘뿐이다:
   *   - 워킹 그룹의 새 파일 (`untracked`) — index 에 그 경로가 없다
   *   - staged 그룹의 추가 (`A`) — HEAD 에 그 경로가 없다
   *
   * 삭제는 여기 오지 않는다 — 없는 것은 **오른쪽**이고, 사라진 내용을 보여 주는
   * 것이 그 행의 뜻이다.
   */
  _noBaseline(group,e){
    if(!e) return false;
    if(e.untracked) return true;
    return group==='staged'&&(e.xy||'').charAt(0)===GIT_ST_ADDED;
  },

  /**
   * 그 행을 편집기로 연다. 디렉터리 항목(중첩 저장소·서브모듈)은 열 파일이 없어
   * 여기 오지 않는다 — 그쪽은 사유와 진입점을 보인다 (GIT_DIR_ENTRY_SRS FR-DIR-21).
   */
  _openInEditor(e){
    if(!this.repo||!e||!e.path||e.dir) return false;
    const abs=this.absPath(e);
    // 한 번 클릭이므로 미리보기다 (FR-RTU-40) — 목록을 훑어도 탭이 쌓이지 않는다.
    this.app.edOpenFile(abs,{preview:true});
    return true;
  },

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
      // GIT_DIR_ENTRY_SRS FR-DIR-21: 이 대상이 디렉터리인가, 그리고 어느
      // 종류인가. diff 를 부르는 대신 사유를 보이는 판단이 이 둘에 걸린다.
      dir:!!e.dir,sub:e.sub||'',
      // FR-CMG-3: 출신은 그룹이 아니라 항목이 안다 — 워킹 그룹에는 둘이 함께 있다.
      untracked:!!e.untracked,
    };
    const i=this._diffIndex(this._fileList());
    if(i>=0) this._diffPos=i;
    this._paint();
  },

  _openDiff(group,e){
    this._select(group,e);
    this.openView('diff');
  },

  /**
   * 뷰 하나를 화면에 올린다. History 의 미커밋 변경 행이 Changes 를 여는 것과
   * 파일 클릭이 Diff 를 여는 것이 같은 경로다.
   *
   * **표면이 둘이다** (REPO_TAB_UNIFY_SRS FR-RTU-73).
   *
   *   Repo 창(`this.root` 있음)  본문에 그 뷰의 탭을 연다. 없으면 만든다
   *   옛 Git 창(`root` 없음)     고정 탭 7개 중 하나를 활성화한다 (FR-GIT-28)
   *
   * Changes 는 Repo 창에서 **사이드에만** 있으므로(FR-RTU-32) 탭으로 열지 않고
   * 사이드를 그쪽으로 돌린다 — 그러지 않으면 "Changes 를 열었는데 아무 일도
   * 없다" 가 된다.
   */
  openView(view){
    const app=this.app;
    if(this.root){
      const w=app.edWindowFor(this.root); if(!w) return;
      if(view===REPO_SIDE_CHANGES){ app.edSetSide(w,REPO_SIDE_CHANGES); return }
      const rid=app.edEnsurePane(w); if(!rid) return;
      app.addTab(rid,TAB_TYPE_GIT,{gitView:view,windowId:w.id});
      // FR-RTU-83: 모바일은 사이드(Changes)에 서서 이 부름을 낸다. 본문의 칸을
      // 가리키지 않으면 diff 탭은 생기고 화면은 Changes 그대로다.
      app.mobileShowPane(rid,{render:true});
      return;
    }
    const w=app.gitWindow(); if(!w||!w.layout) return;
    for(const pn of app.flattenPanes(w.layout)){
      const t=(pn.tabs||[]).find(x=>x.type===TAB_TYPE_GIT&&x.gitView===view);
      if(t){app.switchTab(pn.id,t.id);return}
    }
  },

  /**
   * **인라인 미리보기는 폐기됐다** (REPO_TAB_UNIFY_SRS FR-RTU-20, 사용자 지시).
   *
   * `_paintPreview`·`_preview()`·`_previewView` 가 여기 있었다. Changes 사이드
   * 안의 좁은 diff 칸이었고, diff 가 본문의 탭이 된 지금(FR-RTU-30) 같은 것을
   * 두 자리에 두는 일이었다. 그 자리를 지우면서 EDITOR_GIT_UX_SRS 묶음 D
   * (두 칸 손잡이, FR-CSZ-1~8)도 함께 폐기됐다 — §7 D-RTU-22.
   */

  // ── Diff 탭 (FR-GIT-49~56) ──

  _renderDiff(el){
    if(el.dataset.built!=='1') this._buildDiff(el);
    this._paintDiff(el);
  },

  _buildDiff(el){
    el.innerHTML=
      '<div class="git-diff-bar">'+
        '<button class="ui-btn ui-btn-sm git-diff-nav" data-nav="prev">\u2039</button>'+
        '<button class="ui-btn ui-btn-sm git-diff-nav" data-nav="next">\u203a</button>'+
        '<span class="git-diff-path"></span>'+
        // REPO_TAB_UNIFY_SRS FR-RTU-20: 축 라벨은 걷어낸 인라인 미리보기가 들고
        // 있었다 (`worktree ↔ index`). 어느 두 쪽을 비교하는지는 diff 를 읽는
        // 근거의 절반이므로 자리를 옮겨 남긴다.
        '<span class="git-diff-axis"></span>'+
        '<span class="git-diff-pos"></span>'+
        '<span class="git-diff-gone"></span>'+
        '<span class="git-diff-rev"></span>'+
        // DIFF_HUNK_BAR_SRS FR-DHB-4·5: 조각 관측의 상태가 서는 한 줄이다 —
        // 받는 중·못 받음·나눌 조각 없음·거부 사유. 하단 패널이 그것을 들고
        // 있었고, 그 패널이 세로 공간의 42% 를 먹었다 (I-3).
        '<span class="git-diff-hunk-note"></span>'+
        '<span class="git-diff-spacer"></span>'+
        '<button class="ui-btn ui-btn-sm git-diff-blame"></button>'+
        '<button class="ui-btn ui-btn-sm git-diff-mode"></button>'+
        '<label class="git-diff-ws"><input type="checkbox"></label>'+
        // FR-DOR-3: 접기 토글. 공백무시와 같은 규약·같은 자리다 — 둘 다
        // "무엇을 보여 줄 것인가"를 정하는 기기별 취향이다.
        '<label class="git-diff-fold"><input type="checkbox"></label>'+
      '</div>'+
      // FR-GIT-276: blame 은 Diff 탭의 **모드**다 (D8). 두 본문이 함께 보이면
      // 사용자는 무엇을 보고 있는지 모른다 — 켜진 쪽만 보인다.
      '<div class="git-blame">'+
        '<div class="ui-notice git-blame-note"></div>'+
        '<div class="git-blame-rows ui-scroll-sm"></div>'+
      '</div>'+
      '<div class="git-diff-body"></div>';
    el.querySelector('.git-diff-ws').appendChild(document.createTextNode(GIT_DIFF_WS_LABEL));
    el.querySelector('.git-diff-fold').appendChild(document.createTextNode(GIT_DIFF_FOLD_LABEL));
    el.querySelector('.git-diff-body').appendChild(this._diff().el);
    for(const b of el.querySelectorAll('.git-diff-nav')){
      b.title=GIT_DIFF_NAV_TITLE[b.dataset.nav]||'';
      b.addEventListener('click',()=>this._diffMove(b.dataset.nav==='next'?1:-1));
    }
    const bl=el.querySelector('.git-diff-blame');
    bl.textContent=GIT_BLAME_TOGGLE; bl.title=GIT_BLAME_TOGGLE_TITLE;
    bl.addEventListener('click',()=>{this._blameOn=!this._blameOn; this._paint()});
    const dm=el.querySelector('.git-diff-mode');
    dm.title=GIT_DIFF_MODE_TITLE;
    dm.addEventListener('click',()=>this._toggleSideBySide());
    el.querySelector('.git-diff-ws input')
      .addEventListener('change',ev=>this._setIgnoreWs(ev.target.checked));
    el.querySelector('.git-diff-fold input')
      .addEventListener('change',ev=>this._setFold(ev.target.checked));
    el.dataset.built='1';
  },

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
    el.querySelector('.git-diff-axis').textContent=
      f?(GIT_AXIS_LABEL[f.axis]||f.axis||''):'';
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
    el.querySelector('.git-diff-fold input').checked=this._foldPref();
    el.querySelector('.git-diff-blame').classList.toggle('on',!!this._blameOn);
    // UX_BATCH6_SRS FR-GLV-1: 관측이 나른 재적재는 **같은 대상을 다시 받는
    // 것**이므로 키 비교를 지나야 한다. 플래그를 여기서 소비하는 이유는 한 번의
    // 계기가 한 번만 받아야 하기 때문이다 — 남겨 두면 이후 모든 회차가 다시 받는다.
    const force=!!this._diffStale; this._diffStale=false;
    this._showTarget(this._diff(),f,'_diffKey',force);
    // blame 모드에서는 hunk 조각이 뜻을 잃는다 — 부분 스테이징의 대상은 diff 다.
    // **force 를 넘기지 않는다** — 조각이 낡는 계기는 본문이 바뀐 것이고, 그것은
    // `onChanged` 가 `_hunkKey` 를 지워 알린다 (FR-GLV-1).
    this._paintHunks(el,(cf||this._blameOn)?null:f);
    this._paintBlame(el);
  },

  // 쓰기 뒤 Diff 를 다시 받게 한다 — 조각 관측과 본문 둘 다 낡았다. hunk 쓰기와 파일
  // 단위 쓰기(F-4.3)가 이 한 함수를 쓴다.
  _diffInvalidate(){
    this._hunkKey=null; this._hunks=null;
    // FR-DHB-44: 사라진 조각 위에 툴바가 남지 않는다 — 다시 hover 로만 뜬다.
    this._hunkBarHide();
    // Monaco 의 두 모델도 낡았다 — 같은 대상이라도 내용이 바뀌었다 (FR-GIT-71).
    this._diffKey=null;
  },

  // FR-GIT-138·139: `<parent>..<commit>` 를 짧은 해시로 보인다. 루트 커밋은 부모가
  // 없으므로 그 사실을 적는다 — 빈 자리로 두면 해시를 못 읽은 것과 구분되지 않는다.
  _revLabel(f){
    // 40자 이상의 16진 문자열만 줄인다 — `stash@{0}` 같은 ref 를 자르면 무엇과
    // 비교하는지 읽을 수 없다 (FR-GIT-169).
    const short=o=>{
      const v=o||'';
      const m=/^([0-9a-f]{40,})(\^?)$/.exec(v);
      return m?m[1].slice(0,GIT_DIFF_REV_ABBREV)+m[2]:v;
    };
    // REPO_FIX 01 §5.3: stash 는 oid 로 열되 사람이 읽는 이름(`stash@{n}`)을
    // 따로 싣는다 — 식별은 oid, 표시는 이름이다.
    if(f.revLabel) return (GIT_AXIS_LABEL[f.axis]||f.axis)+' \u00b7 '+f.revLabel;
    return (GIT_AXIS_LABEL[f.axis]||f.axis)+' \u00b7 '+
      (f.parentOid?short(f.parentOid):GIT_DETAIL_ROOT)+GIT_DIFF_REV_RANGE+short(f.oid);
  },

  // FR-GIT-53: ‹ › 가 도는 순서는 Changes 탭의 목록과 같다 — 그룹 순서를 이어
  // 평탄화한 것이다.
  _fileList(){
    const s=this._status&&this._status.status;
    if(!s||!this.repo) return [];
    const out=[];
    for(const g of GIT_GROUPS)
      for(const e of gitGroupEntries(s,g.key))
        out.push({repo:this.repo,group:g.key,axis:GIT_GROUP_AXIS[g.key],
          path:e.path,origPath:e.origPath||'',untracked:!!e.untracked});
    return out;
  },

  _diffIndex(list){
    const f=this.previewFile; if(!f) return -1;
    return list.findIndex(x=>x.group===f.group&&x.path===f.path);
  },

  // 대상이 목록에서 사라졌으면 마지막 위치를 경계로 클램프한다 (§3.3).
  _diffMove(delta){
    const list=this._fileList(); if(!list.length) return;
    const cur=this._diffIndex(list);
    let i=cur<0?this._diffPos:cur+delta;
    i=Math.max(0,Math.min(list.length-1,i));
    this._diffPos=i;
    const t=list[i];
    this._select(t.group,{path:t.path,origPath:t.origPath,untracked:t.untracked});
  },

  // 대상이 그대로면 다시 부르지 않는다 — status 폴링마다 diff 를 재요청하면
  // 스크롤과 접힘이 매초 초기화된다.
  /**
   * `force` 는 **같은 대상을 다시 받으라**는 뜻이다 (UX_BATCH6_SRS FR-GLV-1·2).
   *
   * 관측이 파일의 변화를 알렸을 때 지나는 길이며, 대상을 바꾸지 않으므로 목록
   * 위치·side-by-side·공백무시는 그대로다. 편집 중 보호(FR-RTU-56)는 그 앞에
   * 있으므로 `force` 도 그것을 넘지 못한다 — 폴링이 사용자의 편집을 덮는 일은
   * 이 인자가 생겨도 없다.
   */
  _showTarget(view,f,slot,force){
    // 식별자는 (리포, 축, 경로, 리비전) 이다 (FR-GIT-54·145) — 리비전이 빠지면
    // 머지 커밋에서 부모를 바꿔도 같은 대상으로 보여 다시 받지 않는다.
    const key=f?[f.repo,f.axis,f.path,f.origPath,f.oid||'',f.parentOid||''].join(RPT_SEP):'';
    if(this[slot]===key&&!force) return;
    /**
     * REPO_FIX 05 §3A-3 (F-2.4): dirty 문서에서 다른 대상으로 옮길 때 — 이 뷰가 그
     * 문서의 마지막 뷰면 저장/버리기/취소를 묻고, 다른 뷰가 들고 있으면 그냥 옮긴다
     * (편집은 문서에 남는다). 같은 대상을 다시 받는 것은 원본 쪽만 바꾸므로 dirty 여도
     * 된다(작업 트리 쪽은 문서 모델이다).
     *
     *   이전 동작: dirty 면 전환을 조용히 무시했다 — 머리·목록은 새 대상, 본문과 hunk
     *             는 옛 대상이었다(#2)
     *   새  동작: 묻고 옮기거나, 취소면 선택을 원래 행으로 되돌린다
     */
    if(view&&this[slot]&&this[slot]!==key&&view.dirtyLast){this._diffLeaveAsk(view);return}
    if(this._diffAsking) return;
    this[slot]=key;
    this._diffShown=f;
    if(!f){view.clear(this.repo?GIT_PREVIEW_HINT:GIT_NO_REPO_HINT);return}
    // GIT_DIR_ENTRY_SRS FR-DIR-21: 디렉터리 항목에는 diff 를 부르지 않는다.
    // 서버가 줄 것이 없고(실측), 사용자가 알아야 할 것은 사유와 갈 길이다.
    if(f.dir){
      view.clear(this._dirEntryNote(f),[f.path],this._dirEntryActs(f));
      return;
    }
    view.show(f,this.token());
  },

  // F-2.4: 저장('save')·버리기(true)·취소(false). 취소와 저장 실패는 화면에 보이던
  // 대상으로 선택을 되돌린다 — 머리·본문·hunk 목록이 같은 대상을 가리킨다.
  async _diffLeaveAsk(view){
    if(this._diffAsking) return;
    this._diffAsking=true;
    const r=await this.app.edDocLeaveConfirm();
    const ok=r==='save'?await view.save():r===true;
    this._diffAsking=false;
    if(ok&&r===true){view.clear('');this._diffKey=null}
    if(!ok) this._diffRestore(this._diffShown);
    this._paint();
  },

  _diffRestore(f){
    if(!f||!f.path) return;
    this.commitFile=null;
    this.previewFile=f;
    this._sel.clear();
    this._sel.add(this._selKey(f.group,f.path));
    this._anchor={group:f.group,path:f.path};
  },

  // 두 인스턴스는 같은 클래스다 (§3.2). 미리보기는 좁은 자리이므로 inline 을
  // 기본으로 둔다 (§3.4).
  /**
   * UX_BATCH6_SRS FR-GLV-1·2: 관측 회차마다 **지금 보고 있는 diff 를 다시 받는다.**
   *
   *   이전 동작: Diff 는 `_reloadViews` 의 목록에 없었고, `_diffKey` 가 같은 한
   *             다시 받지 않았다 — 터미널에서 파일을 고쳐도 화면이 그대로였다
   *   새  동작: 관측이 돌 때마다 같은 대상을 다시 받고, 내용이 같으면 그리지
   *             않는다 (FR-GLV-3 이 `GitDiffView._draw` 에서 그것을 판정한다)
   *   이유:     파일 **내용**의 변화는 관측으로 알 수 없다. `git status` 는 이미
   *             수정된 파일이 또 수정돼도 같은 줄을 내고, `signature` 도
   *             `_viewFp` 도 작업 트리의 내용을 보지 않는다 (SRS §2.4) — 알 수
   *             없는 것을 기다리는 대신 열려 있는 하나를 다시 묻는다
   *
   * 한 번도 열지 않은 Diff 는 대상이 아니다 (FR-GVR-4) — `_diffView` 가 없으면
   * 볼 사람도 없다. 편집 중이면 받지 않는다 (FR-RTU-56).
   */
  reloadDiff(user){
    // REPO_FIX 05 §3A-3: 편집 중이어도 받는다 — 작업 트리 쪽은 문서 모델이고 다시 받는
    // 것은 원본 쪽과 hunk 목록뿐이다. 이전: dirty 면 받지 않아 원본이 낡았다.
    if(!this._diffView) return;
    // FR-GLV-6: 서버가 거부한 대상은 **폴링이** 다시 묻지 않는다 — 바이너리·상한
    // 초과·사라진 경로가 그렇고, 매 회차 다시 물으면 콘솔과 서버 로그가 그 실패로
    // 채워진다 (실측으로 확인했다).
    //
    // **사용자가 누른 새로고침은 예외다** (D-8: 새로고침은 백업이다). 자동 경로가
    // 멈춘 자리에서 손으로 다시 시도할 길이 없으면 그 화면은 사유에 갇힌다.
    if(!user&&this._diffView.refused) return;
    const el=this._els.get('diff'); if(!el||el.dataset.built!=='1') return;
    this._diffStale=true;
    this._renderDiff(el);
  },

  _diff(){
    if(!this._diffView) this._diffView=new GitDiffView({
      inlineBreakpoint:GIT_DIFF_OPTIONS.renderSideBySideInlineBreakpoint,
      sideBySide:this._sideBySidePref(),
      ignoreWhitespace:this._ignoreWsPref(),
      hideUnchanged:this._foldPref(),
      isStale:tok=>this.isStale(tok),
      // §3A-4: 작업 트리 쪽 문서의 경로는 패널이 안다(어휘적 저장소 최상위 기준).
      absPath:t=>this.absPath(t),
      // FR-RTU-53: 저장되지 않은 변경은 탭 이름에 `●` 로 선다 — 편집기 탭과
      // 같은 표시이며, 렌더가 공유 문서의 dirty 에서 파생한다 (`app.tabDirty`, F-2.5).
      onDirty:v=>this._setDiffDirty(v),
      // FR-RTU-55: 저장 뒤에는 관측을 즉시 갱신한다. 방금 고친 것이 목록과
      // 색에 곧바로 서야 한다.
      onSaved:()=>this._gitSaved(),
      // DIFF_HUNK_BAR_SRS D-4 / FR-DHB-10: 에디터가 서면 hover 툴바를 배선하고
      // 사라지면 걷는다. `GitDiffView` 는 관측을 모르므로 그 배선을 여기서 한다.
      onEditor:ed=>this._hunkBarWire(ed),
      // UX_BATCH6_SRS FR-GLV-1: 본문이 실제로 바뀐 회차다. 조각 관측은 이
      // 본문에서 파생되므로 그때만 낡는다 — 폴링마다 다시 받으면 요청이 배로 는다.
      onChanged:()=>this._diffChanged(),
    });
    return this._diffView;
  },

  // diff 탭 하나의 dirty 를 탭 레코드에 옮긴다 (FR-RTU-53).
  _setDiffDirty(v){
    // §3A-3 hunk 와 dirty: 사유 줄과 툴바가 dirty 를 따른다.
    const el=this._els.get('diff');
    if(el&&el.dataset.built==='1') this._hunkNote(el.querySelector('.git-diff-hunk-note'),this._hunkText());
    this._hunkBarPaint();
    if(!this.root) return;
    const w=this.app.edWindowFor(this.root); if(!w) return;
    const found=this.app.findGitViewTab(w,'diff'); if(!found) return;
    // REPO_FIX 03 §3A-7: 탭 레코드에 쓰지 않는다 — 라벨은 렌더가 Diff 뷰에서
    // 파생한다(`app.tabDirty`). 바뀐 때만 다시 그린다.
    if(this._diffDirtyShown===!!v) return;
    this._diffDirtyShown=!!v;
    this.app.render();
  },

  _gitSaved(){
    this.signal('write');
    this.blameStale();
    // 탐색기의 색도 같은 사실을 딛는다 (FR-EDT-78).
    const t=this.app.edActiveTree&&this.app.edActiveTree();
    if(t&&t.pollGit) t.pollGit({now:true});
  },

  _destroyViews(){
    if(!this._diffView) return;
    // `destroy()` 가 `clear()` 를 지나며 `onEditor(null)` 을 부르므로 위젯과
    // 리스너는 그 길에서 걷힌다 (FR-DHB-22). 여기서 한 번 더 부르는 것은 뷰가
    // 에디터를 세운 적 없는 경우의 몫이다 — 그때는 아무 일도 하지 않는다.
    this._diffView.destroy(); this._diffView=null;
    this._hunkBarDispose();
    this._diffKey=null;
    this._hunkKey=null; this._hunks=null;
    // 골격이 버린 뷰의 DOM 을 들고 있다 — 다시 열릴 때 새 뷰로 세운다.
    const el=this._els.get('diff'); if(el) el.dataset.built='';
  },

});
