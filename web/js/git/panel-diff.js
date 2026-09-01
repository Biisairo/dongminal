/**
 * GitPanel — 고른 것을 보여 주는 일 (SPLIT_REFACTOR_SRS 묶음 B).
 *
 * 행 선택에서 diff 로 가는 길(`_select`·`_openDiff`·`_showTarget`), Diff 탭과 Changes
 * 미리보기의 두 `GitDiffView`, blame, 그리고 부분 스테이징의 조각
 * (`_paintHunks`·`_hunkPick`·`_hunkAct`, FR-GIT-278·279)이 여기 산다.
 *
 * 조각은 서버가 만든 diff 에서 온다 — 이 파일이 만들지 않는다.
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
    };
    const i=this._diffIndex(this._fileList());
    if(i>=0) this._diffPos=i;
    this._paint();
  },

  _openDiff(group,e){
    this._select(group,e);
    this.openView('diff');
  },

  // 고정 탭 하나를 활성화한다 (FR-GIT-28). History 의 미커밋 변경 행이 Changes 를
  // 여는 것과 파일 클릭이 Diff 를 여는 것이 같은 경로다.
  openView(view){
    const w=this.app._gitWindow(); if(!w||!w.layout) return;
    for(const pn of this.app._flattenPanes(w.layout)){
      const t=(pn.tabs||[]).find(x=>x.type===TAB_TYPE_GIT&&x.gitView===view);
      if(t){this.app.switchTab(pn.id,t.id);return}
    }
  },

  // 미리보기는 Diff 탭과 같은 뷰를 좁은 자리에 둔 것이다 (§3.2·§3.4). 골격은 한 번만
  // 세운다 — 폴링마다 다시 만들면 Monaco 인스턴스가 매초 버려진다.
  _paintPreview(el){
    const p=el.querySelector('.git-preview'); if(!p) return;
    if(p.dataset.built!=='1'){
      p.innerHTML='<div class="git-preview-target">'+
        '<div class="git-preview-path"></div><div class="git-preview-axis"></div></div>'+
        '<div class="git-preview-body"></div>';
      p.querySelector('.git-preview-body').appendChild(this._preview().el);
      p.dataset.built='1';
    }
    const f=this.previewFile;
    const t=p.querySelector('.git-preview-target');
    t.classList.toggle('vis',!!f);
    t.querySelector('.git-preview-path').textContent=
      f?(f.origPath?f.origPath+' → '+f.path:f.path):'';
    t.querySelector('.git-preview-axis').textContent=f?(GIT_AXIS_LABEL[f.axis]||f.axis):'';
    this._showTarget(this._preview(),f,'_prevKey');
  },

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
        '<span class="git-diff-pos"></span>'+
        '<span class="git-diff-gone"></span>'+
        '<span class="git-diff-rev"></span>'+
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
      '<div class="git-diff-body"></div>'+
      // 부분 스테이징의 자리다 (FR-GIT-278). Monaco 는 두 모델을 그릴 뿐이고
      // hunk 의 경계를 모른다 — 조각과 그 동작은 서버가 준 경계 위에 선다.
      '<div class="git-hunks"></div>';
    el.querySelector('.git-diff-ws').appendChild(document.createTextNode(GIT_DIFF_WS_LABEL));
    el.querySelector('.git-diff-fold').appendChild(document.createTextNode(GIT_DIFF_FOLD_LABEL));
    el.querySelector('.git-diff-body').appendChild(this._diff().el);
    el.querySelector('.git-hunks').addEventListener('click',ev=>this._hunkClick(ev));
    for(const b of el.querySelectorAll('.git-diff-nav'))
      b.addEventListener('click',()=>this._diffMove(b.dataset.nav==='next'?1:-1));
    const bl=el.querySelector('.git-diff-blame');
    bl.textContent=GIT_BLAME_TOGGLE; bl.title=GIT_BLAME_TOGGLE_TITLE;
    bl.addEventListener('click',()=>{this._blameOn=!this._blameOn; this._paint()});
    el.querySelector('.git-diff-mode').addEventListener('click',()=>this._toggleSideBySide());
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

  // ── 부분 스테이징 (FR-GIT-278·279) ──
  //
  // 패치는 **서버가 만든다** (D6). 여기서 만드는 것은 좌표뿐이다 —
  // (경로, 축, hunk 번호, 줄 범위, 관측 식별자). 패치 문자열을 조립하는 코드가
  // 이 파일에 없어야 하고, 있으면 그것이 임의 쓰기 표면이 된다.

  _paintHunks(el,f){
    const box=el.querySelector('.git-hunks'); if(!box) return;
    const on=!!(f&&f.repo&&GIT_HUNK_AXES.has(f.axis));
    box.classList.toggle('vis',on);
    if(!on){
      this._hunkKey=null; this._hunks=null; this._hunkSel=null;
      box.dataset.sig=''; box.innerHTML=''; return;
    }
    // 대상이 그대로면 다시 부르지 않는다 — 폴링마다 재요청하면 스크롤과 줄 선택이
    // 매초 초기화된다 (_showTarget 과 같은 규약).
    const key=[f.repo,f.axis,f.path].join('\u0000');
    if(this._hunkKey!==key){
      this._hunkKey=key; this._hunks=null; this._hunkSel=null;
      // 다른 대상으로 옮겨 갔을 때만 사유를 지운다 — 같은 대상을 다시 받는 것은
      // 방금 그 거부가 일으킨 일이다.
      if(this._hunkErrKey!==key){this._hunkErr=null; this._hunkErrKey=null}
      this._loadHunks(f,key);
    }
    this._drawHunks(box,f);
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

  _drawHunks(box,f){
    const h=this._hunks,sel=this._hunkSel;
    // 같은 관측·같은 선택이면 다시 그리지 않는다 — 폴링마다 다시 그리면 스크롤이
    // 매초 맨 위로 돌아간다.
    const sig=[this._hunkKey,h?(h.err||h.diffId||'-'):'',
      sel?[sel.hunk,sel.from,sel.to].join(','):'',this._hunkErr||'',
      // 쓰기 중에는 버튼이 비활성이다 — 그 상태도 그림의 일부이므로 식별자에 든다.
      this._writing?'w':''].join('\u0000');
    if(box.dataset.sig===sig) return;
    box.dataset.sig=sig;
    box.innerHTML='';
    const note=document.createElement('div');
    note.className='git-hunk-note';
    if(!h){note.textContent=GIT_HUNK_LOADING;box.appendChild(note);return}
    if(h.err){note.textContent=h.err;box.appendChild(note);return}
    if(!h.list.length){note.textContent=h.note||GIT_HUNK_NONE;box.appendChild(note);return}
    note.textContent=this._hunkErr||GIT_HUNK_HINT;
    note.classList.toggle('fail',!!this._hunkErr);
    box.appendChild(note);
    for(const hunk of h.list) box.appendChild(this._hunkEl(hunk,f,sel));
  },

  _hunkEl(hunk,f,sel){
    const has=!!(sel&&sel.hunk===hunk.index);
    const el=document.createElement('div');
    el.className='git-hunk'+(has?' sel':'');
    el.dataset.hunk=String(hunk.index);
    const head=document.createElement('div');
    head.className='git-hunk-head';
    head.appendChild(gitHunkSpan('git-hunk-header',hunk.header||''));
    if(has){
      head.appendChild(gitHunkSpan('git-hunk-range',
        GIT_HUNK_SEL_LABEL+sel.from+GIT_HUNK_SEL_SEP+sel.to));
      const c=document.createElement('button');
      c.className='git-hunk-clear'; c.textContent=GIT_HUNK_CLEAR; c.title=GIT_HUNK_CLEAR_TITLE;
      head.appendChild(c);
    }
    head.appendChild(gitHunkSpan('git-hunk-spacer',''));
    // 붙는 동작은 축이 정한다 — 방향이 축에서 갈린다 (FR-GIT-278).
    for(const act of (GIT_HUNK_ACTS[f.axis]||[])){
      const b=document.createElement('button');
      b.className='git-hunk-act'; b.dataset.act=act;
      b.textContent=has?GIT_HUNK_LINE_LABEL[act]:GIT_HUNK_LABEL[act];
      b.title=GIT_HUNK_TITLE[act];
      b.disabled=this._writing;
      head.appendChild(b);
    }
    el.appendChild(head);
    const body=document.createElement('div');
    body.className='git-hunk-body';
    const lines=hunk.lines||[];
    for(let i=0;i<lines.length;i++){
      const n=i+1,l=lines[i];
      const row=document.createElement('div');
      row.className='git-hunk-line'+(GIT_HUNK_LINE_CLASS[l[0]]||'')+
        ((has&&n>=sel.from&&n<=sel.to)?' sel':'');
      row.dataset.i=String(n);
      row.textContent=l;
      body.appendChild(row);
    }
    el.appendChild(body);
    return el;
  },

  _hunkClick(ev){
    const btn=ev.target.closest('.git-hunk-act');
    if(btn){
      const h=btn.closest('.git-hunk');
      if(h) this._hunkAct(btn.dataset.act,Number(h.dataset.hunk));
      return;
    }
    if(ev.target.closest('.git-hunk-clear')){this._hunkSel=null;this._paint();return}
    const line=ev.target.closest('.git-hunk-line');
    if(!line) return;
    const h=line.closest('.git-hunk'); if(!h) return;
    this._hunkPick(Number(h.dataset.hunk),Number(line.dataset.i),!!ev.shiftKey);
  },

  /**
   * 줄 선택은 **한 덩어리 안에서만** 잡힌다 — 덩어리를 넘는 범위는 패치가 되지
   * 않는다. 다른 덩어리를 누르면 선택이 그쪽으로 옮겨간다.
   *
   * 같은 한 줄을 다시 누르면 놓는다 — 선택을 지울 길이 Clear 뿐이면 한 줄을 잘못
   * 고른 사용자가 갇힌다.
   */
  _hunkPick(hunk,i,extend){
    const s=this._hunkSel;
    if(extend&&s&&s.hunk===hunk){
      this._hunkSel={hunk,from:Math.min(s.anchor,i),to:Math.max(s.anchor,i),anchor:s.anchor};
    }else if(s&&s.hunk===hunk&&s.from===i&&s.to===i){
      this._hunkSel=null;
    }else{
      this._hunkSel={hunk,from:i,to:i,anchor:i};
    }
    this._paint();
  },

  /**
   * 조각 하나의 동작. 보내는 것은 좌표뿐이다 — 패치는 서버가 자기가 만든 diff 에서
   * 잘라 짓는다 (D6).
   *
   * `diffId` 는 화면이 본 관측의 식별자다. 서버가 다시 만든 diff 와 다르면 409 로
   * 거부되고, 그때 화면은 조각을 다시 받는다 — 낡은 번호로 다른 곳을 고치지 않는다.
   */
  async _hunkAct(op,idx){
    const f=this.commitFile?null:this._diffTarget();
    const h=this._hunks;
    if(!f||!h||!h.list||!h.list[idx]||this._writing) return;
    const sel=(this._hunkSel&&this._hunkSel.hunk===idx)?this._hunkSel:null;
    const body={repo:f.repo,axis:f.axis,path:f.path,op,hunk:idx,
      from:sel?sel.from:0,to:sel?sel.to:0,diffId:h.diffId};
    if(op===GIT_PATCH_REVERT){this._hunkRevert(body,f,h.list[idx],sel);return}
    this._afterHunk(await this.post('/api/git/patch',body));
  },

  /**
   * revert 는 **파괴적이다** (FR-GIT-279) — 워킹 트리의 그 줄을 버린다. discard 와
   * 같은 규약을 지난다: 판정은 서버의 목록이 하고(GitConfirm), 확인을 거치며,
   * 실행 요청에 confirm 을 함께 보낸다 — 서버도 그것을 요구한다.
   */
  async _hunkRevert(body,f,hunk,sel){
    const label=sel?(GIT_HUNK_SEL_LABEL+sel.from+GIT_HUNK_SEL_SEP+sel.to):(hunk.header||'');
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
    // **거부 사유는 누른 자리에 보인다.** `applyWriteFail` 의 안내 줄은 Changes 탭
    // 골격에만 있어(`.git-partial-note`) Diff 탭에서 낸 실패는 화면에 자국을 남기지
    // 않는다 — 조각을 누른 사람은 Diff 탭에 있다 (FR-GIT-278 의 stale 거부가 이
    // 자리를 실제로 필요로 한다).
    this._hunkErr=res.ok?null:this.writeError(res);
    // 사유는 **그 대상의 것**이다. 아래에서 목록을 다시 받으려고 키를 비우므로,
    // 어느 대상의 사유인지 따로 들고 있어야 다시 받는 그 회차에 지워지지 않는다.
    this._hunkErrKey=res.ok?null:this._hunkKey;
    this._hunkKey=null; this._hunks=null; this._hunkSel=null;
    // Monaco 의 두 모델도 낡았다 — 같은 대상이라도 내용이 바뀌었다 (FR-GIT-71).
    this._diffKey=null; this._prevKey=null;
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
    // 식별자는 (리포, 축, 경로, 리비전) 이다 (FR-GIT-54·145) — 리비전이 빠지면
    // 머지 커밋에서 부모를 바꿔도 같은 대상으로 보여 다시 받지 않는다.
    const key=f?[f.repo,f.axis,f.path,f.origPath,f.oid||'',f.parentOid||''].join('\u0000'):'';
    if(this[slot]===key) return;
    this[slot]=key;
    if(!f){view.clear(this.repo?GIT_PREVIEW_HINT:GIT_NO_REPO_HINT);return}
    view.show(f,this.token());
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
    });
    return this._diffView;
  },

  _preview(){
    if(!this._previewView) this._previewView=new GitDiffView({
      inlineBreakpoint:GIT_PREVIEW_INLINE_BREAKPOINT,
      sideBySide:false,
      ignoreWhitespace:this._ignoreWsPref(),
      // FR-DOR-5: 미리보기와 Diff 탭은 같은 상태다. 갈리면 사용자가 어느 쪽을
      // 보는지 모른다 (`_setIgnoreWs` 가 이미 그렇게 한다).
      hideUnchanged:this._foldPref(),
      isStale:tok=>this.isStale(tok),
    });
    return this._previewView;
  },

  _destroyViews(){
    if(!this._diffView&&!this._previewView) return;
    if(this._diffView){this._diffView.destroy();this._diffView=null}
    if(this._previewView){this._previewView.destroy();this._previewView=null}
    this._diffKey=null; this._prevKey=null;
    this._hunkKey=null; this._hunks=null; this._hunkSel=null;
    // 골격이 버린 뷰의 DOM 을 들고 있다 — 다시 열릴 때 새 뷰로 세운다.
    for(const [k,el] of this._els) if(k==='changes'||k==='diff') el.dataset.built='';
  },

  // ── Changes 두 칸의 경계 (EDITOR_GIT_UX_SRS 묶음 D) ──

});
