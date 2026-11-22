/**
 * GitSelection — Git 패널의 선택 부품: 행 선택 · 선택 → diff · 뷰 열기 · 디렉터리 항목의 사유와 진입점
 * (FR-GIT-52·69·188 · GIT_DIR_ENTRY_SRS FR-DIR-21·22 · REFACTOR3_FE_GITPANEL_SRS 7f). 선택(`_sel`·`_anchor`)과
 * 대상(`previewFile`·`commitFile`)은 여러 부품이 함께 쓰므로 패널의 것이고, 이 부품은 소유 필드가 없다.
 * 디렉터리 항목의 둘(`_dirEntryNote`·`_dirEntryActs`)은 옛 `panel-dir-entry.js` 다 (OPTIMIZE_REFACTOR_SRS
 * FR-OPT-12-4) — `_showTarget` 이 diff 대신 그것을 그린다.
 */
class GitSelection extends GitPart {

  // Diff 탭이 보일 대상. 커밋 축이 있으면 그것이 먼저다 — Changes 탭의 미리보기는
  // previewFile 만 본다 (§3.2).
  _diffTarget(){return this.p.commitFile||this.p.previewFile}

  _selKey(group,path){return group+'\x00'+path}

  // Shift 는 화면에 보이는 순서대로 범위를 고른다 (FR-GIT-69) — 그룹 경계를
  // 넘어도 목록의 순서가 그대로 기준이다.
  _range(group,path){
    const el=this.p._els.get('changes'); if(!el) return;
    const rows=Array.from(el.querySelectorAll('.git-file'));
    const at=r=>rows.findIndex(x=>x.dataset.group===r.group&&x.dataset.path===r.path);
    const a=at(this.p._anchor),b=at({group,path});
    if(a<0||b<0){this.p._sel.add(this._selKey(group,path));return}
    const lo=Math.min(a,b),hi=Math.max(a,b);
    for(let i=lo;i<=hi;i++)
      this.p._sel.add(this._selKey(rows[i].dataset.group,rows[i].dataset.path));
  }

  // ── 선택 → diff (`_select`·`_openDiff`·`openView`, 옛 panel-diff.js · REFACTOR3_FE_GITPANEL_SRS 7c) ──

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
  }

  /**
   * 그 행을 편집기로 연다. 디렉터리 항목(중첩 저장소·서브모듈)은 열 파일이 없어
   * 여기 오지 않는다 — 그쪽은 사유와 진입점을 보인다 (GIT_DIR_ENTRY_SRS FR-DIR-21).
   */
  _openInEditor(e){
    if(!this.p.repo||!e||!e.path||e.dir) return false;
    const abs=this.p.poll.absPath(e);
    // 한 번 클릭이므로 미리보기다 (FR-RTU-40) — 목록을 훑어도 탭이 쌓이지 않는다.
    this.app.edOpenFile(abs,{preview:true});
    return true;
  }

  _select(group,e,ev){
    const key=this._selKey(group,e.path);
    const multi=!!(ev&&(ev.metaKey||ev.ctrlKey));
    const range=!!(ev&&ev.shiftKey&&this.p._anchor);
    if(range){
      this.p._sel.clear();
      this._range(group,e.path);
    }else if(multi){
      if(this.p._sel.has(key)) this.p._sel.delete(key); else this.p._sel.add(key);
      this.p._anchor={group,path:e.path};
    }else{
      this.p._sel.clear(); this.p._sel.add(key);
      this.p._anchor={group,path:e.path};
    }
    // 워킹 트리 파일을 골랐다 — 커밋 축의 대상은 놓는다.
    this.p.commitFile=null;
    this.p.previewFile={
      repo:this.p.repo,group,axis:GIT_GROUP_AXIS[group],
      path:e.path,origPath:e.origPath||'',
      // GIT_DIR_ENTRY_SRS FR-DIR-21: 이 대상이 디렉터리인가, 그리고 어느
      // 종류인가. diff 를 부르는 대신 사유를 보이는 판단이 이 둘에 걸린다.
      dir:!!e.dir,sub:e.sub||'',
      // FR-CMG-3: 출신은 그룹이 아니라 항목이 안다 — 워킹 그룹에는 둘이 함께 있다.
      untracked:!!e.untracked,
    };
    const i=this.p.diffPane._diffIndex(this.p.diffPane._fileList());
    if(i>=0) this.p._diffPos=i;
    this.p.changes._paint();
    // UX_BATCH12 FR-FHL-4: Diff 탭이 포커스면 대상이 바뀐 것이다 — 하이라이트를 맞춘다.
    this.app.focusHighlightSync();
  }

  _openDiff(group,e){
    this._select(group,e);
    this.openView('diff');
  }

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
    if(this.p.root){
      const w=app.edWindowFor(this.p.root); if(!w) return;
      if(view===REPO_SIDE_CHANGES){ app.edSetSide(w,REPO_SIDE_CHANGES); return }
      // UX_BATCH12_SRS FR-RTB-2·3·7: Diff 는 대상을 든 탭이다 — 지금 칸에 미리보기로 연다.
      // 대상이 없으면(진입점 아이콘) 아래 옛 길이 창의 Diff 탭으로 간다.
      const f=view==='diff'&&this._diffTarget();
      if(f){app.gitDiffOpen(this.p.root,f,{preview:true,commit:!!this.p.commitFile});return}
      const rid=app.edEnsurePane(w); if(!rid) return;
      app.addTab(rid,TAB_TYPE_GIT,{gitView:view,windowId:w.id});
      // FR-RTU-83: 모바일은 사이드(Changes)에 서서 이 부름을 낸다. 본문의 칸을
      // 가리키지 않으면 diff 탭은 생기고 화면은 Changes 그대로다.
      app.mobileShowPane(rid,{render:true});
      return;
    }
    const w=app.gitWindow(); if(!w||!w.layout) return;
    for(const pn of app.flattenPanes(w.layout)){
      const target=(pn.tabs||[]).find(x=>x.type===TAB_TYPE_GIT&&x.gitView===view);
      if(target){app.switchTab(pn.id,target.id);return}
    }
  }

  /**
   * SUBMODULE_DIRTY_NOTICE_SRS FR-SDN-5·9: 디렉터리 항목의 사유.
   *
   * 서브모듈은 세 상태로 갈린다 — 여기서 커밋할 수 있는 몫(gitlink)이 있는가,
   * 서브모듈 **안**에만 있는 몫이 있는가. 종전에는 `f.sub` 를 참/거짓으로만 보아
   * "스테이지하면 담기는 행" 과 "아무리 눌러도 사라지지 않는 행" 이 같은 문장을
   * 받았다 (SRS §2.2).
   *
   * 성분이 하나도 없으면 종전 문구 그대로다 (FR-SDN-7). 중첩 저장소도 그대로다
   * (FR-SDN-11) — `sub` 가 비어 있어 가를 것이 없다.
   */
  _dirEntryNote(f){
    if(!f||!f.sub) return GIT_DIR_ENTRY_NOTE_NESTED;
    const p=gitSubParts(f.sub);
    if(p.commit&&p.inner) return GIT_SUB_NOTE_BOTH;
    if(p.commit) return GIT_SUB_NOTE_COMMIT;
    if(p.inner) return GIT_SUB_NOTE_INNER;
    return GIT_DIR_ENTRY_NOTE_SUB;
  }

  /**
   * FR-DIR-22: 디렉터리 항목 자리의 진입점 하나.
   *
   * 이미 Repo 목록에 있으면 **이동**이고, 없으면 **추가**다. 추가는
   * `/api/editors/add` 한 번이며 연동이 Git 핀까지 함께 만든다 (FR-EDT-33·39) —
   * 여기서 두 목록을 각각 건드리지 않는다.
   */
  _dirEntryActs(f){
    const app=this.app;
    if(!app||!f||!f.repo||!f.path) return [];
    // §3A-4: 어휘적 저장소 최상위 기준 — 창 루트가 하위 폴더여도 같은 항목을 가리킨다.
    const abs=this.p.poll.absPath(f);
    const has=(app.edEntries?app.edEntries():[]).some(e=>e&&e.path===abs);
    const go=()=>{
      const w=app.edWindowFor&&app.edWindowFor(abs);
      if(w) app.switchWindow(w.id);
    };
    const acts=has
      ? [{label:GIT_DIR_ENTRY_GO,title:GIT_DIR_ENTRY_GO_TITLE,run:go}]
      : [{label:GIT_DIR_ENTRY_ADD,title:GIT_DIR_ENTRY_ADD_TITLE,run:async()=>{
          // 추가가 실패하면 창도 없다 — 성공했을 때만 옮긴다.
          if(await app.edMutate('/add',{path:abs})) go();
        }}];
    /**
     * UX_BATCH5_SRS FR-SUB-11: **서브모듈에만** 관리 자리로 가는 길을 더한다.
     *
     * 위의 둘과 목적이 다르다 — 그쪽은 서브모듈 **자신의** 창으로 가고, 이쪽은
     * 지금 저장소의 Submodules 탭이다 (init·update·sync 가 사는 자리).
     *
     * 중첩 저장소(`f.sub` 가 거짓)에는 붙이지 않는다: `.gitmodules` 에 없으므로
     * 그 목록에 서지 않고, 눌러도 자기 행이 없는 탭이 열린다 (FR-GIT-180).
     */
    if(f.sub) acts.push({
      label:GIT_DIR_ENTRY_SUBTAB,title:GIT_DIR_ENTRY_SUBTAB_TITLE,
      run:()=>this.openView('submodules'),
    });
    return acts;
  }
}
