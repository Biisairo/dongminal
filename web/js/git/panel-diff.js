/**
 * GitPanel — 고른 것을 보여 주는 일 (SPLIT_REFACTOR_SRS 묶음 B).
 *
 * 행 선택에서 diff 로 가는 길(`_select`·`_openDiff`·`_showTarget`), Diff 탭과 Changes
 * 미리보기의 두 `GitDiffView`, blame, 그리고 부분 스테이징
 * (`_paintHunks`·`_hunkBar*`·`_hunkAct`, FR-GIT-278·279)이 여기 산다.
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
   * REPO_TAB_UNIFY_SRS FR-RTU-51 / D-RTU-8: **untracked 는 diff 가 아니다.**
   *
   * 비교할 왼쪽이 없으므로 diff 는 빈 쪽과의 비교가 되고, 그 화면은 자리를 절반
   * 쓰면서 알려 주는 것이 없다. VSCode 도 새 파일을 그냥 편집기로 연다.
   *
   * 디렉터리 항목(중첩 저장소·서브모듈)은 열 파일이 없으므로 여기 오지 않는다 —
   * 그쪽은 사유와 진입점을 보인다 (GIT_DIR_ENTRY_SRS FR-DIR-21).
   */
  _openUntracked(e){
    if(!this.repo||!e||!e.path||e.dir) return false;
    const abs=String(this.repo).replace(/\/+$/,'')+'/'+e.path;
    // 한 번 클릭이므로 미리보기다 (FR-RTU-40) — 목록을 훑어도 탭이 쌓이지 않는다.
    this.app._edOpenFile(abs,{preview:true});
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
      const w=app._edWindowFor(this.root); if(!w) return;
      if(view===REPO_SIDE_CHANGES){ app._edSetSide(w,REPO_SIDE_CHANGES); return }
      const rid=app._edEnsurePane(w); if(!rid) return;
      app.addTab(rid,TAB_TYPE_GIT,{gitView:view,windowId:w.id});
      return;
    }
    const w=app._gitWindow(); if(!w||!w.layout) return;
    for(const pn of app._flattenPanes(w.layout)){
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
        '<button class="git-diff-nav" data-nav="prev">\u2039</button>'+
        '<button class="git-diff-nav" data-nav="next">\u203a</button>'+
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
        '<button class="git-diff-blame"></button>'+
        '<button class="git-diff-mode"></button>'+
        '<label class="git-diff-ws"><input type="checkbox"></label>'+
        // FR-DOR-3: 접기 토글. 공백무시와 같은 규약·같은 자리다 — 둘 다
        // "무엇을 보여 줄 것인가"를 정하는 기기별 취향이다.
        '<label class="git-diff-fold"><input type="checkbox"></label>'+
      '</div>'+
      // FR-GIT-276: blame 은 Diff 탭의 **모드**다 (D8). 두 본문이 함께 보이면
      // 사용자는 무엇을 보고 있는지 모른다 — 켜진 쪽만 보인다.
      '<div class="git-blame">'+
        '<div class="git-blame-note"></div>'+
        '<div class="git-blame-rows"></div>'+
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
    this._showTarget(this._diff(),f,'_diffKey');
    // blame 모드에서는 hunk 조각이 뜻을 잃는다 — 부분 스테이징의 대상은 diff 다.
    this._paintHunks(el,(cf||this._blameOn)?null:f);
    this._paintBlame(el);
  },

  // ── Blame (FR-GIT-276) ──
  //
  // Diff 탭의 모드다 (D8). 대상은 **지금 diff 가 보는 파일**을 따른다 — 별도
  // 대상을 들면 ‹ › 로 파일을 옮겼을 때 blame 만 앞 파일에 남는다.

  _blameTarget(){
    if(!this._blameOn) return null;
    const cf=this.commitFile;
    if(cf&&cf.path) return {path:cf.path,rev:cf.oid||''};
    const f=this._diffTarget();
    return f&&f.path?{path:f.path,rev:''}:null;
  },

  _paintBlame(el){
    const box=el.querySelector('.git-blame'); if(!box) return;
    const t=this._blameTarget();
    box.classList.toggle('vis',!!t);
    el.querySelector('.git-diff-body').classList.toggle('off',!!t);
    if(!t){
      this._blameKey=null; this._blameData=null; this._blameErr=null;
      box.dataset.sig=''; return;
    }
    // 대상이 그대로면 다시 부르지 않는다 — 폴링마다 재요청하면 스크롤이 매초
    // 초기화된다 (_paintHunks 와 같은 규약).
    const key=[this.repo||'',t.rev,t.path].join('\u0000');
    if(this._blameKey!==key){
      this._blameKey=key; this._blameData=null; this._blameErr=null;
      this._loadBlame(t,key);
    }
    this._drawBlame(box);
  },

  async _loadBlame(t,key){
    const tok=this.token();
    const u='/api/git/blame?repo='+encodeURIComponent(this.repo||'')+
      '&rev='+encodeURIComponent(t.rev)+'&path='+encodeURIComponent(t.path);
    let r=null,d=null;
    try{r=await fetch(u)}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    if(this.isStale(tok)||this._blameKey!==key) return;
    // 서버가 되돌려준 요청값도 확인한다 — 같은 세대 안에서도 응답 순서가 뒤바뀔 수
    // 있다 (FR-GIT-54).
    const q=(d&&d.requested)||{};
    if(!r||!r.ok||!d||q.path!==t.path||q.rev!==t.rev){
      // 거부 사유는 **누른 자리**에 보인다 — 서버가 준 문구가 있으면 그것을 쓴다.
      this._blameErr=(d&&d.message)||GIT_BLAME_FAIL;
      this._paint(); return;
    }
    this._blameData={lines:d.lines||[],commits:d.commits||{}};
    this._paint();
  },

  _drawBlame(box){
    const d=this._blameData;
    // 판정 근거는 이 렌더러가 읽는 값 전부다 (FR-RPT-2).
    const sig=[this._blameKey,this._blameErr||'',d?d.lines.length:-1].join('\u0000');
    if(box.dataset.sig===sig) return;
    box.dataset.sig=sig;
    const note=box.querySelector('.git-blame-note');
    const rows=box.querySelector('.git-blame-rows');
    const msg=this._blameErr||(!d?GIT_BLAME_LOADING:(d.lines.length?'':GIT_BLAME_EMPTY));
    note.textContent=msg; note.classList.toggle('vis',!!msg);
    rows.innerHTML='';
    if(!d||!d.lines.length) return;
    const frag=document.createDocumentFragment();
    for(const ln of d.lines) frag.appendChild(this._blameRow(ln,d.commits[ln.oid]||{}));
    rows.appendChild(frag);
  },

  _blameRow(ln,c){
    const el=document.createElement('div');
    el.className='git-blame-row'+(c.uncommitted?' uncommitted':'');
    el.dataset.line=String(ln.line);
    el.dataset.oid=ln.oid;
    const mk=(cls,text,title)=>{
      const s=document.createElement('span'); s.className=cls; s.textContent=text;
      if(title) s.title=title;
      el.appendChild(s);
    };
    // 미커밋 줄은 커밋 자리를 비운다 — 해시를 그리면 사용자는 없는 커밋을 열려고 한다.
    mk('git-blame-oid',c.uncommitted?'\u2013':ln.oid.slice(0,7),
       c.uncommitted?GIT_BLAME_UNCOMMITTED:(c.summary||ln.oid));
    mk('git-blame-author',c.uncommitted?GIT_BLAME_UNCOMMITTED:(c.authorName||''),
       c.authorMail?c.authorName+' <'+c.authorMail+'>':'');
    // 상대시간이 기본이고 절대시간은 title 로 항상 닿는다 (History 의 O12 규약).
    const abs=c.authorAt?GitHistory.absTime(c.authorAt):'';
    mk('git-blame-date',c.uncommitted||!c.authorAt?'':GitHistory.relTime(c.authorAt),abs);
    mk('git-blame-num',String(ln.line),'');
    mk('git-blame-text',ln.text,'');
    return el;
  },

  // FR-GIT-276: 파일 메뉴의 진입점. Diff 탭을 열고 그 파일을 blame 으로 본다.
  openBlame(t){
    if(!t||!t.path) return;
    this._blameOn=true;
    this._openDiff(t.group,{path:t.path,origPath:t.origPath||''});
  },

  // ── 부분 스테이징 (FR-GIT-278·279 · DIFF_HUNK_BAR_SRS) ──
  //
  // 패치는 **서버가 만든다** (D6). 여기서 만드는 것은 좌표뿐이다 —
  // (경로, 축, hunk 번호, 줄 범위, 관측 식별자). 패치 문자열을 조립하는 코드가
  // 이 파일에 없어야 하고, 있으면 그것이 임의 쓰기 표면이 된다.
  //
  // 좌표 **사상**도 이 파일의 것이 아니다 — `core/hunk-coords.js` 가 서버 규약을
  // 딛고 그것을 편집기 쪽과 나눠 쓴다 (D-2).

  /**
   * 조각 관측을 관리하고 머리의 한 줄을 갱신한다 (FR-DHB-4·5·50).
   *
   * **화면에 조각을 그리지 않는다.** 그리는 것은 Monaco 이고, 동작은 hover 로
   * 뜨는 툴바가 갖는다 — 이 함수가 만지는 DOM 은 안내 한 줄뿐이다.
   */
  _paintHunks(el,f){
    const note=el.querySelector('.git-diff-hunk-note');
    const on=!!(f&&f.repo&&GIT_HUNK_AXES.has(f.axis));
    if(!on){
      // FR-DHB-19: 부분 스테이징이 없는 자리다 (blame 모드·커밋 축·untracked).
      this._hunkKey=null; this._hunks=null;
      this._hunkBarHide();
      this._hunkNote(note,'');
      return;
    }
    // 대상이 그대로면 다시 부르지 않는다 — 폴링마다 재요청하면 관측이 매초
    // 바뀌고 그때마다 툴바의 좌표가 흔들린다 (_showTarget 과 같은 규약).
    const key=[f.repo,f.axis,f.path].join('\u0000');
    if(this._hunkKey!==key){
      this._hunkKey=key; this._hunks=null;
      // 대상이 바뀌면 툴바가 가리키던 조각은 없는 것이다.
      this._hunkBarHide();
      // 다른 대상으로 옮겨 갔을 때만 사유를 지운다 — 같은 대상을 다시 받는 것은
      // 방금 그 거부가 일으킨 일이다.
      if(this._hunkErrKey!==key){this._hunkErr=null; this._hunkErrKey=null}
      this._loadHunks(f,key);
    }
    this._hunkNote(note,this._hunkText());
    // 쓰기 중 버튼 비활성(FR-DHB-18)도 이 회차에 따라온다.
    this._hunkBarPaint();
  },

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
  },

  // FR-DHB-5: 머리의 한 줄이 말하는 넷. 아무 문제가 없으면 빈 문자열이고, 그때
  // 그 자리는 아무것도 차지하지 않는다.
  _hunkText(){
    if(this._hunkErr) return this._hunkErr;
    const h=this._hunks;
    if(!h) return GIT_HUNK_LOADING;
    if(h.err) return h.err;
    if(!h.list.length) return h.note||GIT_HUNK_NONE;
    return '';
  },

  // FR-DHB-53: 내용이 같으면 다시 쓰지 않는다 — 폴링이 3초마다 같은 글자를 넣으면
  // 그 자리가 매초 깜빡인다 (옛 `box.dataset.sig` 와 같은 근거).
  _hunkNote(el,text){
    if(!el) return;
    const fail=!!text&&text===this._hunkErr;
    const sig=text+'\u0000'+(fail?'1':'');
    if(el.dataset.sig===sig) return;
    el.dataset.sig=sig;
    // 서버가 보낸 사유가 이 자리에 닿는다 — 텍스트 노드로만 넣는다 (NFR-DHB-3).
    el.textContent=text;
    el.classList.toggle('vis',!!text);
    el.classList.toggle('fail',fail);
  },

  /**
   * FR-DHB-10~13: 모디파이드 에디터에 hover 툴바를 배선한다.
   *
   * `GitDiffView` 가 에디터를 세울 때·버릴 때 이 함수를 부른다 (D-4) — 그 클래스는
   * 관측을 모르고, 관측을 아는 쪽이 여기다. `ed` 가 `null` 이면 정리다.
   */
  _hunkBarWire(ed){
    this._hunkBarDispose();
    if(!ed) return;
    this._hunkBarEd=ed;
    const node=this._hunkBarNode();
    // FR-DHB-12: 자리는 조각의 첫 줄이다. `getPosition` 이 null 이면 Monaco 가
    // 그리지 않으므로, 숨김이 곧 위치를 놓는 일이다 (위젯을 붙였다 뗐다 하지
    // 않는다 — FR-DHB-21).
    this._hunkBarWidget={
      getId:()=>GIT_HUNK_BAR_ID,
      getDomNode:()=>node,
      getPosition:()=>this._hunkBarPos||null,
      // 첫 줄의 조각에서 위쪽으로 뜰 자리가 없으면 에디터 경계를 넘어야 한다.
      allowEditorOverflow:true,
    };
    ed.addContentWidget(this._hunkBarWidget);
    this._hunkBarSubs=[
      ed.onMouseMove(ev=>this._hunkBarMove(ev)),
      ed.onMouseLeave(()=>this._hunkBarLeave()),
      // FR-DHB-37: 선택이 바뀌면 라벨이 곧바로 따라온다 — 무엇에 걸리는 동작인지
      // 누르기 전에 보인다.
      ed.onDidChangeCursorSelection(()=>this._hunkBarPaint()),
    ];
  },

  _hunkBarDispose(){
    clearTimeout(this._hunkBarT);
    for(const d of this._hunkBarSubs||[]) if(d&&d.dispose) d.dispose();
    this._hunkBarSubs=null;
    // FR-GIT-56 / FR-DHB-22: 에디터가 버려지기 **전에** 뗀다. 뒤에 떼려 하면 뗄
    // 대상이 이미 없다.
    if(this._hunkBarEd&&this._hunkBarWidget) this._hunkBarEd.removeContentWidget(this._hunkBarWidget);
    this._hunkBarEd=null; this._hunkBarWidget=null;
    this._hunkBarPos=null; this._hunkBarHunk=-1;
  },

  // 툴바의 DOM 은 하나다 (FR-DHB-21) — 조각을 옮겨 다닐 때 자리와 라벨만 바뀐다.
  _hunkBarNode(){
    if(this._hunkBarEl) return this._hunkBarEl;
    const el=document.createElement('div');
    el.className='git-hunk-bar';
    // FR-DHB-13: 툴바 자신에 올라가 있는 동안은 사라지지 않는다 — 그러지 않으면
    // 버튼까지 마우스를 옮기는 사이에 없어져 누를 수 없다.
    el.addEventListener('mouseenter',()=>clearTimeout(this._hunkBarT));
    el.addEventListener('mouseleave',()=>this._hunkBarLeave());
    el.addEventListener('click',ev=>{
      const b=ev.target.closest('.git-hunk-act');
      if(b&&!b.disabled) this._hunkAct(b.dataset.act);
    });
    this._hunkBarEl=el;
    return el;
  },

  // FR-DHB-11·14·20: 마우스가 어느 조각 위에 있는가. 관측이 오기 전에는 뜨지
  // 않는다 — 경계를 모르는 동안 뜨는 버튼은 무엇에 걸리는지 말할 수 없다.
  _hunkBarMove(ev){
    const h=this._hunks;
    if(!h||h.err||!h.list||!h.list.length){this._hunkBarHide();return}
    const pos=ev&&ev.target&&ev.target.position;
    const hunk=pos?gitHunkAt(h.list,pos.lineNumber):null;
    if(!hunk){this._hunkBarHide();return}
    clearTimeout(this._hunkBarT);
    if(this._hunkBarHunk!==hunk.index||!this._hunkBarPos){
      this._hunkBarHunk=hunk.index;
      this._hunkBarPos={
        position:{lineNumber:Math.max(1,hunk.newStart),column:1},
        preference:[
          monaco.editor.ContentWidgetPositionPreference.ABOVE,
          monaco.editor.ContentWidgetPositionPreference.BELOW,
        ],
      };
    }
    this._hunkBarPaint();
  },

  _hunkBarLeave(){
    clearTimeout(this._hunkBarT);
    this._hunkBarT=setTimeout(()=>this._hunkBarHide(),GIT_HUNK_BAR_HIDE_MS);
  },

  _hunkBarHide(){
    clearTimeout(this._hunkBarT);
    if(!this._hunkBarPos) return;
    this._hunkBarPos=null; this._hunkBarHunk=-1;
    if(this._hunkBarEd&&this._hunkBarWidget){
      this._hunkBarEd.layoutContentWidget(this._hunkBarWidget);
    }
  },

  /**
   * FR-DHB-15·16·18: 붙는 동작은 축이 정하고, 라벨은 선택이 정한다.
   *
   * 버튼을 매번 다시 만들지 않는다 — 축과 라벨과 쓰기 상태가 같으면 그림도 같다.
   */
  _hunkBarPaint(){
    const ed=this._hunkBarEd,el=this._hunkBarEl,w=this._hunkBarWidget;
    if(!ed||!el||!w) return;
    if(this._hunkBarPos){
      const f=this.commitFile?null:this._diffTarget();
      const acts=(f&&GIT_HUNK_ACTS[f.axis])||[];
      // 붙을 동작이 없으면 뜨지 않는다 — 빈 상자는 무엇을 할 수 있는지 말하지
      // 않으면서 diff 를 가린다 (FR-DHB-15).
      if(!acts.length){this._hunkBarHide();return}
      const co=this._hunkBarCoords();
      // 좌표가 조각 전체면(선택이 없거나 바뀐 줄에 걸리지 않았다) 라벨도 조각의
      // 것이다 (FR-DHB-31·34).
      const lines=!!(co&&co.from);
      const sig=[acts.join(','),lines?'l':'h',this._writing?'w':''].join('|');
      if(el.dataset.sig!==sig){
        el.dataset.sig=sig;
        el.innerHTML='';
        for(const act of acts){
          const b=document.createElement('button');
          b.className='git-hunk-act'; b.dataset.act=act;
          b.textContent=lines?GIT_HUNK_LINE_LABEL[act]:GIT_HUNK_LABEL[act];
          b.title=GIT_HUNK_TITLE[act];
          b.disabled=!!this._writing;
          el.appendChild(b);
        }
      }
    }
    ed.layoutContentWidget(w);
  },

  /**
   * FR-DHB-30~35·38: 지금 무엇에 걸리는 동작인가 — `{hunk,from,to}`.
   *
   * **누를 때 다시 읽는다** (D-5). 라벨을 그린 시점과 누르는 시점 사이에 선택이
   * 바뀔 수 있고, 그 사이의 값을 들고 있으면 화면이 말한 것과 보내는 것이 달라진다.
   */
  _hunkBarCoords(){
    const h=this._hunks;
    if(!h||!h.list) return null;
    const hunk=h.list.find(x=>x.index===this._hunkBarHunk);
    if(!hunk) return null;
    const whole={hunk:hunk.index,from:0,to:0};
    const ed=this._hunkBarEd;
    const sel=ed&&ed.getSelection();
    // 커서만 있으면 조각 전체다 (FR-DHB-31).
    if(!sel||sel.isEmpty()) return whole;
    let s=sel.startLineNumber,e=sel.endLineNumber;
    // 줄 끝에서 시작해 다음 줄 1열에서 끝나는 선택은 그 다음 줄을 **포함하지
    // 않는다** — 드래그로 줄을 고르면 흔히 그런 범위가 된다.
    if(sel.endColumn===1&&e>s) e--;
    // FR-DHB-32: 선택이 여러 조각을 걸쳐도 적용되는 것은 이 조각 안의 범위뿐이다.
    // 서버 `patch` 가 hunk 번호를 하나만 받으므로 그것이 규약의 한계다 (D-3).
    s=Math.max(s,hunk.newStart);
    e=Math.min(e,hunk.newStart+Math.max(hunk.newLines,1)-1);
    if(s>e) return whole;
    const r=gitHunkRangeForLines(hunk,s,e);
    return r?{hunk:hunk.index,from:r[0],to:r[1]}:whole;
  },

  /**
   * 조각 하나에 동작을 적용한다 (FR-GIT-278·279).
   *
   * `diffId` 는 화면이 본 관측의 식별자다. 서버가 다시 만든 diff 와 다르면 409 로
   * 거부되고, 그때 화면은 조각을 다시 받는다 — 낡은 번호로 다른 곳을 고치지 않는다.
   */
  async _hunkAct(op){
    const f=this.commitFile?null:this._diffTarget();
    const h=this._hunks;
    const co=this._hunkBarCoords();
    if(!f||!h||!co||this._writing) return;
    const hunk=(h.list||[]).find(x=>x.index===co.hunk);
    const body={repo:f.repo,axis:f.axis,path:f.path,op,
      hunk:co.hunk,from:co.from,to:co.to,diffId:h.diffId};
    if(op===GIT_PATCH_REVERT){this._hunkRevert(body,f,hunk,co);return}
    this._afterHunk(await this.post('/api/git/patch',body));
  },

  /**
   * revert 는 **파괴적이다** (FR-GIT-279) — 워킹 트리의 그 줄을 버린다. discard 와
   * 같은 규약을 지난다: 판정은 서버의 목록이 하고(GitConfirm), 확인을 거치며,
   * 실행 요청에 confirm 을 함께 보낸다 — 서버도 그것을 요구한다.
   */
  async _hunkRevert(body,f,hunk,co){
    // FR-DHB-42: 무엇을 되돌리는지 밝힌다. 줄 범위를 골랐으면 그 범위이고,
    // 아니면 조각의 머리다.
    const label=co.from
      ?(GIT_HUNK_SEL_LABEL+co.from+GIT_HUNK_SEL_SEP+co.to)
      :((hunk&&hunk.header)||'');
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
  },

  /**
   * 조각 쓰기 한 번의 처리.
   *
   * 성공이든 실패든 **관측을 놓는다** — 조각을 적용하면 남은 덩어리의 번호가 밀리고,
   * 실패가 stale 이었다면 화면이 보던 것이 이미 낡은 것이다. 어느 쪽이든 다음
   * 그리기에서 다시 받는다.
   */
  _afterHunk(res){
    // **거부 사유는 누른 자리에 보인다** (FR-DHB-6). 그 자리가 이제 Diff 탭의
    // 머리다 — `applyWriteFail` 의 안내 줄은 Changes 사이드의 골격에만 있어
    // 조각을 누른 사람에게 닿지 않는다.
    this._hunkErr=res.ok?null:this.writeError(res);
    // 사유는 **그 대상의 것**이다. 아래에서 목록을 다시 받으려고 키를 비우므로,
    // 어느 대상의 사유인지 따로 들고 있어야 다시 받는 그 회차에 지워지지 않는다.
    this._hunkErrKey=res.ok?null:this._hunkKey;
    this._hunkKey=null; this._hunks=null;
    // FR-DHB-44: 사라진 조각 위에 툴바가 남지 않는다 — 다시 hover 로만 뜬다.
    this._hunkBarHide();
    // Monaco 의 두 모델도 낡았다 — 같은 대상이라도 내용이 바뀌었다 (FR-GIT-71).
    this._diffKey=null;
    if(res.ok){this._note=null; this.adopt(res.data); return}
    this.applyWriteFail(res);
  },

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
  },

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
    this._select(t.group,{path:t.path,origPath:t.origPath});
  },

  // 대상이 그대로면 다시 부르지 않는다 — status 폴링마다 diff 를 재요청하면
  // 스크롤과 접힘이 매초 초기화된다.
  _showTarget(view,f,slot){
    // FR-RTU-56: **편집 중인 diff 는 다시 읽지 않는다.** 폴링이 사용자의 편집을
    // 덮으면 그 화면은 편집기가 아니다. 대상이 바뀌는 것은 사용자의 조작이므로
    // 그때는 새로 읽는다 — 아래 key 비교가 그것을 가른다.
    if(view&&view.dirty&&this[slot]) return;
    // 식별자는 (리포, 축, 경로, 리비전) 이다 (FR-GIT-54·145) — 리비전이 빠지면
    // 머지 커밋에서 부모를 바꿔도 같은 대상으로 보여 다시 받지 않는다.
    const key=f?[f.repo,f.axis,f.path,f.origPath,f.oid||'',f.parentOid||''].join('\u0000'):'';
    if(this[slot]===key) return;
    this[slot]=key;
    if(!f){view.clear(this.repo?GIT_PREVIEW_HINT:GIT_NO_REPO_HINT);return}
    // GIT_DIR_ENTRY_SRS FR-DIR-21: 디렉터리 항목에는 diff 를 부르지 않는다.
    // 서버가 줄 것이 없고(실측), 사용자가 알아야 할 것은 사유와 갈 길이다.
    if(f.dir){
      view.clear(this._dirEntryNote(f),[f.path],this._dirEntryActs(f));
      return;
    }
    view.show(f,this.token());
  },

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
  },

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
    const abs=f.repo.replace(/\/+$/,'')+'/'+f.path;
    const has=(app._edEntries?app._edEntries():[]).some(e=>e&&e.path===abs);
    const go=()=>{
      const w=app._edWindowFor&&app._edWindowFor(abs);
      if(w) app.switchWindow(w.id);
    };
    const acts=has
      ? [{label:GIT_DIR_ENTRY_GO,title:GIT_DIR_ENTRY_GO_TITLE,run:go}]
      : [{label:GIT_DIR_ENTRY_ADD,title:GIT_DIR_ENTRY_ADD_TITLE,run:async()=>{
          // 추가가 실패하면 창도 없다 — 성공했을 때만 옮긴다.
          if(await app._edMutate('/add',{path:abs})) go();
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
  },

  // 두 인스턴스는 같은 클래스다 (§3.2). 미리보기는 좁은 자리이므로 inline 을
  // 기본으로 둔다 (§3.4).
  _diff(){
    if(!this._diffView) this._diffView=new GitDiffView({
      inlineBreakpoint:GIT_DIFF_OPTIONS.renderSideBySideInlineBreakpoint,
      sideBySide:this._sideBySidePref(),
      ignoreWhitespace:this._ignoreWsPref(),
      hideUnchanged:this._foldPref(),
      isStale:tok=>this.isStale(tok),
      // FR-RTU-53: 저장되지 않은 변경은 탭 이름에 `●` 로 선다 — 편집기 탭과
      // 같은 표시이며, 그 표시를 만드는 자리도 같다 (`tab.dirty`).
      onDirty:v=>this._setDiffDirty(v),
      // FR-RTU-55: 저장 뒤에는 관측을 즉시 갱신한다. 방금 고친 것이 목록과
      // 색에 곧바로 서야 한다.
      onSaved:()=>this._gitSaved(),
      // DIFF_HUNK_BAR_SRS D-4 / FR-DHB-10: 에디터가 서면 hover 툴바를 배선하고
      // 사라지면 걷는다. `GitDiffView` 는 관측을 모르므로 그 배선을 여기서 한다.
      onEditor:ed=>this._hunkBarWire(ed),
    });
    return this._diffView;
  },

  // diff 탭 하나의 dirty 를 탭 레코드에 옮긴다 (FR-RTU-53).
  _setDiffDirty(v){
    if(!this.root) return;
    const w=this.app._edWindowFor(this.root); if(!w) return;
    const found=this.app._findGitViewTab(w,'diff'); if(!found) return;
    if(!!found.tab.dirty===!!v) return;
    found.tab.dirty=!!v;
    this.app.render();
  },

  _gitSaved(){
    this.signal('write');
    // 탐색기의 색도 같은 사실을 딛는다 (FR-EDT-78).
    const t=this.app._edActiveTree&&this.app._edActiveTree();
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
