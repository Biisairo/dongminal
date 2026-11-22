/**
 * GitDiffPane — Git 패널의 Diff 부품 (SPLIT_REFACTOR_SRS 묶음 B · REFACTOR3_FE_GITPANEL_SRS 7c).
 *
 * Diff 탭·Changes 미리보기의 `GitDiffView`, Diff 탭 전용 패널의 몫(옛 `panel-diff-tab.js`), 보기 설정
 * (side-by-side·공백 무시, 옛 `panel-poll.js` 앞쪽)이 여기 산다. 행 선택에서 diff 로 가는 길(`_select`·
 * `_openDiff`·`openView`)은 `git-selection.js` 로 갔다. blame 은 `git-blame.js`, 부분 스테이징
 * (`_paintHunks`·`_hunkBar*`·`_hunkAct`, FR-GIT-278·279)은 `git-hunks.js`, 디렉터리 항목의 사유·진입점
 * (`_dirEntryNote`·`_dirEntryActs`)은 `git-selection.js` 다 (FR-OPT-12-4).
 *
 * 조각은 서버가 만든 diff 에서 온다 — 이 파일이 만들지 않는다. **화면에 그리지도
 * 않는다** (DIFF_HUNK_BAR_SRS): diff 를 그리는 것은 편집기(CodeMirror merge) 하나이고, 여기가 얹는
 * 것은 그 위에 hover 로 뜨는 동작 툴바뿐이다.
 *
 * 대상(`previewFile`·`commitFile`)·`_diffView`·`_diffKey`·`_diffPos` 는 여러 파일이 보므로 패널에 있다.
 */
class GitDiffPane extends GitPart {
  constructor(panel){
    super(panel);
    this._sideBy=null;            // FR-GIT-51 의 보기 모드
    this._ignWs=null;             // FR-GIT-50 의 공백무시 토글
  }

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
  }

  _buildDiff(el){
    el.innerHTML=
      '<div class="git-diff-bar">'+
        '<button class="ui-btn ui-btn-sm ui-btn-ghost ui-btn-icon git-diff-nav" data-nav="prev"></button>'+
        '<button class="ui-btn ui-btn-sm ui-btn-ghost ui-btn-icon git-diff-nav" data-nav="next"></button>'+
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
        // UI_POLISH_SRS FR-UIP-17: 동작(Blame)과 보기 상태(방식·공백·접기)를 가른다.
        // 방식은 둘 중 하나를 고르는 묶음이라 지금 방식이 선택돼 보인다.
        '<button class="ui-btn ui-btn-sm ui-btn-ghost git-diff-blame"></button>'+
        '<span class="git-diff-sep" aria-hidden="true"></span>'+
        '<span class="ui-segment git-diff-mode">'+
          '<button class="ui-btn ui-btn-sm" data-mode="side"></button>'+
          '<button class="ui-btn ui-btn-sm" data-mode="inline"></button>'+
        '</span>'+
        // FR-UXF-80: 라벨만 고스트 단추 모양이다 — 안의 체크박스는 남긴다(시험·키보드 경로가 그 위에 선다).
        '<label class="ui-btn ui-btn-sm ui-btn-ghost git-diff-ws"><input type="checkbox"></label>'+
        // FR-DOR-3: 접기 토글. 공백무시와 같은 규약·같은 자리다 — 둘 다
        // "무엇을 보여 줄 것인가"를 정하는 기기별 취향이다.
        '<label class="ui-btn ui-btn-sm ui-btn-ghost git-diff-fold"><input type="checkbox"></label>'+
        // FR-UXF-81 (D-29): 모바일 한 줄의 `⋯` — Blame·공백 무시·접기가 여기로 간다.
        '<button class="ui-btn ui-btn-sm ui-btn-ghost ui-btn-icon git-diff-more"></button>'+
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
      b.appendChild(UIKit.icon(b.dataset.nav==='next'?'chevron-right':'chevron-left'));
      b.title=GIT_DIFF_NAV_TITLE[b.dataset.nav]||'';
      b.setAttribute('aria-label',b.title);
      b.addEventListener('click',()=>this._diffMove(b.dataset.nav==='next'?1:-1));
    }
    const bl=el.querySelector('.git-diff-blame');
    bl.textContent=GIT_BLAME_TOGGLE; bl.title=GIT_BLAME_TOGGLE_TITLE;
    bl.addEventListener('click',()=>{this.p._blameOn=!this.p._blameOn; this.p._paint()});
    for(const b of el.querySelectorAll('.git-diff-mode>button')){
      b.textContent=GIT_DIFF_MODE_LABEL[b.dataset.mode]; b.title=GIT_DIFF_MODE_TITLE;
      b.addEventListener('click',()=>{
        if((b.dataset.mode==='side')!==this._sideBySidePref()) this._toggleSideBySide();
      });
    }
    el.querySelector('.git-diff-ws input')
      .addEventListener('change',ev=>this._setIgnoreWs(ev.target.checked));
    el.querySelector('.git-diff-fold input')
      .addEventListener('change',ev=>this.p._setFold(ev.target.checked));
    const more=el.querySelector('.git-diff-more'); more.appendChild(UIKit.icon('more-horizontal'));
    more.title=GIT_DIFF_MORE_TITLE; more.setAttribute('aria-label',GIT_DIFF_MORE_TITLE); more.addEventListener('click',()=>this._diffMoreMenu(more));
    el.dataset.built='1';
  }

  // FR-UXF-81: 메뉴 항목은 데스크톱 단추와 같은 동작을 부른다. 켜진 것은 체크 표시다.
  _diffMoreMenu(btn){
    const ws=this._ignoreWsPref(), fold=this.p._foldPref(), bl=!!this.p._blameOn, r=btn.getBoundingClientRect();
    const it=(id,label,on,fn)=>({id,label,cur:on,icon:on?'check':undefined,onClick:fn});
    UIKit.menu([
      it('blame',GIT_BLAME_TOGGLE,bl,()=>{this.p._blameOn=!bl; this.p._paint()}),
      it('ws',GIT_DIFF_WS_LABEL,ws,()=>this._setIgnoreWs(!ws)),
      it('fold',GIT_DIFF_FOLD_LABEL,fold,()=>this.p._setFold(!fold)),
    ],{at:{x:r.right,y:r.bottom},align:'right',flipGap:r.height,cls:'git-diff-more-menu'});
  }

  _paintDiff(el){
    const list=this._fileList();
    // 커밋 축의 대상은 워킹 트리 목록에 없다 — ‹ › 와 n/m 과 "사라졌습니다" 는
    // 그 목록의 것이므로 커밋 축에서는 뜻이 없다 (FR-GIT-53).
    const cf=this.p.commitFile;
    const f=this.p._diffTarget();
    const i=cf?-1:this._diffIndex(list);
    if(i>=0) this.p._diffPos=i;
    // 목록이 비면 0/0 이고 ‹ › 는 disabled 다.
    for(const b of el.querySelectorAll('.git-diff-nav')) b.disabled=!list.length||!!cf;
    const pathEl=el.querySelector('.git-diff-path');
    pathEl.textContent=f?(f.origPath&&f.origPath!==f.path?f.origPath+' \u2192 '+f.path:f.path):'';
    const axis=f?(GIT_AXIS_LABEL[f.axis]||f.axis||''):'';
    el.querySelector('.git-diff-axis').textContent=axis;
    // UI_POLISH_SRS FR-UIP-24: 수만으로는 무엇의 위치인지 말하지 않는다.
    const pos=cf?'':t('git.diff_pos',{pos:list.length?(i>=0?(i+1)+'/'+list.length:'\u2013/'+list.length):'0/0'});
    el.querySelector('.git-diff-pos').textContent=pos;
    // FR-UXF-81: 모바일은 축·위치를 숨기고 파일명의 툴팁이 말한다.
    pathEl.title=f?[axis,pos].filter(Boolean).join(' \u00b7 '):'';
    // 대상이 목록에서 사라졌으면(커밋·discard) 그 사실만 알린다 — 아무 파일이나
    // 임의로 보이지 않는다 (§3.3). UX_BATCH12_SRS FR-DNC-1: 목록이 비어도 같은 규칙이다 —
    // 변경을 전부 커밋하면 목록이 비고, 그때 안내가 빠졌다. 관측이 오기 전은 모르는 것이다.
    const gone=el.querySelector('.git-diff-gone');
    const known=!!(this.p._status&&this.p._status.status);
    const lost=!cf&&known&&!!(f&&i<0);
    gone.textContent=lost?GIT_DIFF_GONE_NOTE:'';
    gone.classList.toggle('vis',lost);
    // 커밋 축은 어느 두 리비전을 비교하는지 함께 보인다 (FR-GIT-139).
    const rev=el.querySelector('.git-diff-rev');
    rev.textContent=cf?this._revLabel(cf):'';
    rev.classList.toggle('vis',!!cf);
    const side=this._sideBySidePref();
    for(const b of el.querySelectorAll('.git-diff-mode>button')){
      const on=(b.dataset.mode==='side')===side;
      b.classList.toggle('active',on); b.setAttribute('aria-pressed',String(on));
    }
    el.querySelector('.git-diff-ws input').checked=this._ignoreWsPref();
    el.querySelector('.git-diff-fold input').checked=this.p._foldPref();
    const bl=el.querySelector('.git-diff-blame');
    bl.classList.toggle('on',!!this.p._blameOn); bl.setAttribute('aria-pressed',String(!!this.p._blameOn));
    // UX_BATCH6_SRS FR-GLV-1: 관측이 나른 재적재는 **같은 대상을 다시 받는
    // 것**이므로 키 비교를 지나야 한다. 플래그를 여기서 소비하는 이유는 한 번의
    // 계기가 한 번만 받아야 하기 때문이다 — 남겨 두면 이후 모든 회차가 다시 받는다.
    const force=!!this._diffStale; this._diffStale=false;
    this._showTarget(this._diff(),f,'_diffKey',force);
    // blame 모드에서는 hunk 조각이 뜻을 잃는다 — 부분 스테이징의 대상은 diff 다.
    // **force 를 넘기지 않는다** — 조각이 낡는 계기는 본문이 바뀐 것이고, 그것은
    // `onChanged` 가 `_hunkKey` 를 지워 알린다 (FR-GLV-1).
    this.p.hunks._paintHunks(el,(cf||this.p._blameOn)?null:f);
    this.p.blame._paintBlame(el);
  }

  // 쓰기 뒤 Diff 를 다시 받게 한다 — 조각 관측과 본문 둘 다 낡았다. hunk 쓰기와 파일
  // 단위 쓰기(F-4.3)가 이 한 함수를 쓴다.
  _diffInvalidate(){
    this.p._hunkKey=null; this.p._hunks=null;
    // FR-DHB-44: 사라진 조각 위에 툴바가 남지 않는다 — 다시 hover 로만 뜬다.
    this.p.hunks._hunkBarHide();
    // Diff 편집기의 두 문서도 낡았다 — 같은 대상이라도 내용이 바뀌었다 (FR-GIT-71).
    this.p._diffKey=null;
  }

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
  }

  // FR-GIT-53: ‹ › 가 도는 순서는 Changes 탭의 목록과 같다 — 그룹 순서를 이어
  // 평탄화한 것이다.
  _fileList(){
    const s=this.p._status&&this.p._status.status;
    if(!s||!this.p.repo) return [];
    const out=[];
    for(const g of GIT_GROUPS)
      for(const e of gitGroupEntries(s,g.key))
        out.push({repo:this.p.repo,group:g.key,axis:GIT_GROUP_AXIS[g.key],
          path:e.path,origPath:e.origPath||'',untracked:!!e.untracked});
    return out;
  }

  _diffIndex(list){
    const f=this.p.previewFile; if(!f) return -1;
    return list.findIndex(x=>x.group===f.group&&x.path===f.path);
  }

  // 대상이 목록에서 사라졌으면 마지막 위치를 경계로 클램프한다 (§3.3).
  _diffMove(delta){
    const list=this._fileList(); if(!list.length) return;
    const cur=this._diffIndex(list);
    let i=cur<0?this.p._diffPos:cur+delta;
    i=Math.max(0,Math.min(list.length-1,i));
    this.p._diffPos=i;
    const target=list[i];
    // FR-RTB-9: Diff 탭의 ‹ › 는 그 탭이 있는 칸의 미리보기로 연다 (`gitDiffStep`).
    if(this.p.diffTabId){this.app.gitDiffStep(this.p,target);return}
    this.p._select(target.group,{path:target.path,origPath:target.origPath,untracked:target.untracked});
  }

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
    if(this.p[slot]===key&&!force) return;
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
    if(view&&this.p[slot]&&this.p[slot]!==key&&view.dirtyLast){this._diffLeaveAsk(view);return}
    if(this._diffAsking) return;
    this.p[slot]=key;
    this._diffShown=f;
    if(!f){view.clear(this.p.repo?GIT_PREVIEW_HINT:GIT_NO_REPO_HINT);return}
    // GIT_DIR_ENTRY_SRS FR-DIR-21: 디렉터리 항목에는 diff 를 부르지 않는다.
    // 서버가 줄 것이 없고(실측), 사용자가 알아야 할 것은 사유와 갈 길이다.
    if(f.dir){
      view.clear(this.p._dirEntryNote(f),[f.path],this.p._dirEntryActs(f));
      return;
    }
    view.show(f,this.p.token());
  }

  // F-2.4: 저장('save')·버리기(true)·취소(false). 취소와 저장 실패는 화면에 보이던
  // 대상으로 선택을 되돌린다 — 머리·본문·hunk 목록이 같은 대상을 가리킨다.
  async _diffLeaveAsk(view){
    if(this._diffAsking) return;
    this._diffAsking=true;
    const r=await this.app.edDocLeaveConfirm();
    const ok=r==='save'?await view.save():r===true;
    this._diffAsking=false;
    if(ok&&r===true){view.clear('');this.p._diffKey=null}
    if(!ok) this._diffRestore(this._diffShown);
    this.p._paint();
  }

  _diffRestore(f){
    if(!f||!f.path) return;
    this.p.commitFile=null;
    this.p.previewFile=f;
    this.p._sel.clear();
    this.p._sel.add(this.p._selKey(f.group,f.path));
    this.p._anchor={group:f.group,path:f.path};
  }

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
    if(!this.p._diffView) return;
    // FR-GLV-6: 서버가 거부한 대상은 **폴링이** 다시 묻지 않는다 — 바이너리·상한
    // 초과·사라진 경로가 그렇고, 매 회차 다시 물으면 콘솔과 서버 로그가 그 실패로
    // 채워진다 (실측으로 확인했다).
    //
    // **사용자가 누른 새로고침은 예외다** (D-8: 새로고침은 백업이다). 자동 경로가
    // 멈춘 자리에서 손으로 다시 시도할 길이 없으면 그 화면은 사유에 갇힌다.
    if(!user&&this.p._diffView.refused) return;
    const el=this.p._els.get('diff'); if(!el||el.dataset.built!=='1') return;
    this._diffStale=true;
    this._renderDiff(el);
  }

  _diff(){
    if(!this.p._diffView) this.p._diffView=new GitDiffView({
      inlineBreakpoint:GIT_DIFF_INLINE_BREAKPOINT,
      sideBySide:this._sideBySidePref(),
      ignoreWhitespace:this._ignoreWsPref(),
      hideUnchanged:this.p._foldPref(),
      isStale:tok=>this.p.isStale(tok),
      // §3A-4: 작업 트리 쪽 문서의 경로는 패널이 안다(어휘적 저장소 최상위 기준).
      absPath:target=>this.p.absPath(target),
      // FR-RTU-53: 저장되지 않은 변경은 탭 이름에 `●` 로 선다 — 편집기 탭과
      // 같은 표시이며, 렌더가 공유 문서의 dirty 에서 파생한다 (`app.tabDirty`, F-2.5).
      onDirty:v=>this._setDiffDirty(v),
      // FR-RTU-55: 저장 뒤에는 관측을 즉시 갱신한다. 방금 고친 것이 목록과
      // 색에 곧바로 서야 한다.
      onSaved:()=>this._gitSaved(),
      // FR-RTB-6 ⑤: 미리보기 Diff 에서 저장하면 고정된다.
      onSaveIntent:()=>{if(this.p.diffTabId) this.app.gitDiffTabPin(this.p.diffTabId)},
      // DIFF_HUNK_BAR_SRS D-4 / FR-DHB-10: 에디터가 서면 hover 툴바를 배선하고
      // 사라지면 걷는다. `GitDiffView` 는 관측을 모르므로 그 배선을 여기서 한다.
      onEditor:ed=>{ this.p.hunks._hunkBarWire(ed); if(ed) this._diffTabViewPending() },
      // UX_BATCH6_SRS FR-GLV-1: 본문이 실제로 바뀐 회차다. 조각 관측은 이
      // 본문에서 파생되므로 그때만 낡는다 — 폴링마다 다시 받으면 요청이 배로 는다.
      onChanged:()=>this.p.hunks._diffChanged(),
    });
    return this.p._diffView;
  }

  // diff 탭 하나의 dirty 를 탭 레코드에 옮긴다 (FR-RTU-53).
  _setDiffDirty(v){
    // §3A-3 hunk 와 dirty: 사유 줄과 툴바가 dirty 를 따른다.
    const el=this.p._els.get('diff');
    if(el&&el.dataset.built==='1') this.p.hunks._hunkNote(el.querySelector('.git-diff-hunk-note'),this.p.hunks._hunkText());
    this.p.hunks._hunkBarPaint();
    if(!this.p.root) return;
    if(this.p.diffTabId) this._diffTabEdited(v);
    else{
      const w=this.app.edWindowFor(this.p.root); if(!w) return;
      if(!this.app.findGitViewTab(w,'diff')) return;
    }
    // REPO_FIX 03 §3A-7: 탭 레코드에 쓰지 않는다 — 라벨은 렌더가 Diff 뷰에서
    // 파생한다(`app.tabDirty`). 바뀐 때만 다시 그린다.
    if(this._diffDirtyShown===!!v) return;
    this._diffDirtyShown=!!v;
    this.app.render();
  }

  _gitSaved(){
    this.p.signal('write');
    this.p.blame.blameStale();
    // 탐색기의 색도 같은 사실을 딛는다 (FR-EDT-78).
    const tree=this.app.edActiveTree&&this.app.edActiveTree();
    if(tree&&tree.pollGit) tree.pollGit({now:true});
  }

  _destroyViews(){
    if(!this.p._diffView) return;
    // `destroy()` 가 `clear()` 를 지나며 `onEditor(null)` 을 부르므로 위젯과
    // 리스너는 그 길에서 걷힌다 (FR-DHB-22). 여기서 한 번 더 부르는 것은 뷰가
    // 에디터를 세운 적 없는 경우의 몫이다 — 그때는 아무 일도 하지 않는다.
    this.p._diffView.destroy(); this.p._diffView=null;
    this.p.hunks._hunkBarDispose();
    this.p._diffKey=null;
    this.p._hunkKey=null; this.p._hunks=null;
    // 골격이 버린 뷰의 DOM 을 들고 있다 — 다시 열릴 때 새 뷰로 세운다.
    const el=this.p._els.get('diff'); if(el) el.dataset.built='';
  }

  // ── Diff 탭 전용 패널의 몫 (옛 panel-diff-tab.js · UX_BATCH12_SRS §3.5f FR-RTB-7·9·13) ──
  //
  // Diff 탭은 탭마다 패널을 하나 갖는다(`app.gitDiffPanelFor`). 그 패널은 `diffTabId`
  // 를 들고, 대상은 탭 레코드(`tab.diffTarget`)가 정한다 — 아래는 그 대상을 패널의
  // 자리(`previewFile`·`commitFile`)로 옮기는 일과 편집 계기를 탭에 알리는 일이다.

  // 탭의 대상을 패널에 싣는다. 같은 대상이면 아무것도 하지 않는다 — 렌더마다 불린다.
  diffTabApply(dt){
    const key=dt?this.app.diffTabKey(dt):'';
    if(this._dtKey===key) return;
    this._dtKey=key;
    const f=dt?{...dt,repo:this.p.repo}:null;
    this.p.commitFile=(f&&f.commit)?f:null;
    this.p.previewFile=(f&&!f.commit)?f:null;
    const i=this._diffIndex(this._fileList());
    if(i>=0) this.p._diffPos=i;
    if(this.p._els.get('diff')) this.p._paint();
  }

  // UX_BATCH12_SRS FR-RTR-6: 닫는 Diff 탭의 커서·스크롤과, 다시 연 탭에 그것을 돌려 놓는 일.
  // 다시 연 탭의 Diff 는 내용을 받아 온 뒤에 서므로, 그 전이면 담아 두었다 칸이 서면 쓴다.
  // FR-RTR-10: 창을 오가며 떼였다 붙는 Diff 의 자리 (렌더의 머리 `_keepScrollAll` · 붙은 뒤 `_mountTabBody`).
  diffViewKeep(){ if(this.p._diffView) this.p._diffView.keepView() }
  diffViewRestore(){ if(this.p._diffView) this.p._diffView.restoreView() }

  diffTabViewState(){ return this.p._diffView?this.p._diffView.viewState():null }

  diffTabViewApply(vs){
    if(vs&&!(this.p._diffView&&this.p._diffView.viewApply(vs))) this._dtPendingView=vs;
  }

  _diffTabViewPending(){
    const vs=this._dtPendingView;
    if(!vs||!this.p._diffView) return;
    this._dtPendingView=null;
    this.p._diffView.viewApply(vs);
  }

  // FR-RTB-6 ④: 이 Diff 에서 친 수정이면 탭을 고정한다. 문서의 dirty 는 같은 파일의
  // 편집기 탭에서 쳐도 오므로, 포커스가 이 Diff 안에 있을 때만 이 탭의 계기로 센다.
  _diffTabEdited(v){
    const el=this.p._diffView&&this.p._diffView.el;
    if(v&&el&&el.contains(document.activeElement)) this.app.gitDiffTabPin(this.p.diffTabId);
  }

  // ── 보기 설정 (옛 panel-poll.js) ──

  // 보기 모드와 공백무시는 기기별 취향이라 localStorage 에 남는다 (§3.3).
  _sideBySidePref(){
    // UX_AUDIT_FIX_SRS FR-UXF-8 (D-2): 저장값이 없으면 모바일은 통합, 데스크톱은 나란히로 시작한다.
    //   이전: 기기와 상관없이 나란히 — 좁은 폭에서 한 쪽만 보여 선택과 화면이 어긋났다 (진단 M7).
    if(this._sideBy==null) this._sideBy=PrefStore.local.bool(GIT_DIFF_SIDE_KEY,!this.app.isMobile);
    return this._sideBy;
  }

  _ignoreWsPref(){
    // 기본은 공백을 무시하지 않는다 — git 과 같은 판정이다 (FR-GIT-50).
    if(this._ignWs==null) this._ignWs=PrefStore.local.bool(GIT_DIFF_WS_KEY,false);
    return this._ignWs;
  }

  _toggleSideBySide(){
    this._sideBy=!this._sideBySidePref();
    PrefStore.local.setBool(GIT_DIFF_SIDE_KEY,this._sideBy);
    this._diff().setSideBySide(this._sideBy);
    this.p._paint();
  }

  _setIgnoreWs(on){
    this._ignWs=!!on;
    PrefStore.local.setBool(GIT_DIFF_WS_KEY,this._ignWs);
    if(this.p._diffView) this.p._diffView.setIgnoreWhitespace(this._ignWs);
    this.p._paint();
  }
}
