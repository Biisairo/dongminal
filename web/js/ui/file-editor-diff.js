/**
 * Remote Terminal — 편집기의 변경 표시 (EDITOR_DIRTY_DIFF_SRS)
 *
 * 파일을 여는 화면(`FileEditor`)의 좌측 여백·스크롤 눈금·미니맵에 "기준과 무엇이
 * 다른가" 를 세우고, 그 조각 하나를 되돌리거나 스테이지한다.
 *
 * 셋을 여기 함께 두는 이유는 셋이 **같은 좌표**를 딛기 때문이다 — 계산이 낸 조각의
 * 줄 범위가 그대로 데코레이션의 자리이고, 팝업이 보이는 이전 줄이며, 서버에 보낼
 * hunk 좌표의 근거다. 갈라 두면 그 좌표 규약이 세 곳에서 각자 흘러간다.
 *
 * 그 마지막 하나(서버 좌표 사상)만은 **밖에 산다** — `core/hunk-coords.js` 다.
 * Diff 탭의 hover 툴바가 같은 사상을 쓰므로 공용 자리가 됐다 (DIFF_HUNK_BAR_SRS D-2).
 *
 *   edDiffLines        기준 ↔ 현재 버퍼의 줄 단위 diff (순수, FR-EDD-10~13)
 *   EdDirtyDiff        문서 하나의 기준·조각·데코레이션 (FR-EDD-1~9·15)
 *   FileEditor.prototype._dd*  칸 하나의 클릭·팝업 (FR-EDD-30~37)
 *
 * **기준은 index 다** (D-2). HEAD 가 아닌 이유는 서버의 부분 스테이징이 op 마다
 * 축을 못박기 때문이며(`write/patch.go:105`), VSCode 도 그 축이다.
 */

// ── 묶음 C: diff 계산 ──

/**
 * FR-EDD-10~13: 기준 줄 배열과 현재 줄 배열의 조각 목록.
 *
 * 반환은 `{ok,changes}` 다. `ok:false` 는 **상한을 넘어 계산하지 않았다** 는 뜻이며
 * "변경이 없다" 와 다르다 — 부르는 쪽이 그 둘을 같게 다루면 큰 파일에서 표시가
 * 없는 것이 사실인지 포기인지 알 수 없다.
 *
 * 조각의 좌표는 둘 다 1-기반이다:
 *   line·count            현재 버퍼 쪽. `del` 은 남은 줄이 없으므로 count 가 0 이고
 *                         line 은 지워진 자리에 **오게 된** 줄이다
 *   baseStart·baseCount   기준 쪽. `add` 는 기준에 없던 자리이므로 count 가 0 이다
 */
function edDiffLines(base,cur){
  const a=base||[],b=cur||[];
  if(a.length>ED_DD_MAX_LINES||b.length>ED_DD_MAX_LINES) return {ok:false,changes:[]};
  // 공통 접두·접미를 걷어낸다. 편집 중의 흔한 경우(한 곳만 고친다)가 이 두 줄에서
  // 거의 끝나므로, Myers 가 보는 구간이 파일이 아니라 고친 자리만 남는다.
  const n=a.length,m=b.length;
  let lo=0;
  while(lo<n&&lo<m&&a[lo]===b[lo]) lo++;
  let hiA=n,hiB=m;
  while(hiA>lo&&hiB>lo&&a[hiA-1]===b[hiB-1]){hiA--;hiB--}
  if(hiA===lo&&hiB===lo) return {ok:true,changes:[]};
  const matches=edDdMyers(a.slice(lo,hiA),b.slice(lo,hiB),ED_DD_MAX_EDITS);
  if(!matches) return {ok:false,changes:[]};

  const changes=[];
  const push=(aStart,aCount,bStart,bCount)=>{
    if(!aCount&&!bCount) return;
    const type=(aCount&&bCount)?ED_DD_MOD:(bCount?ED_DD_ADD:ED_DD_DEL);
    changes.push({type,line:lo+bStart+1,count:bCount,
      baseStart:lo+aStart+1,baseCount:aCount});
  };
  // 매칭된 대각선 **사이의 빈틈**이 곧 조각이다. 한쪽만 빈틈이면 추가·삭제이고
  // 양쪽이면 수정이다 — 세 종류를 따로 찾지 않는다.
  let ax=0,bx=0;
  for(const mt of matches){
    push(ax,mt[0]-ax,bx,mt[1]-bx);
    ax=mt[0]+1; bx=mt[1]+1;
  }
  push(ax,(hiA-lo)-ax,bx,(hiB-lo)-bx);
  return {ok:true,changes};
}

/**
 * Myers greedy. 돌려주는 것은 **매칭된 대각선의 좌표쌍**이며 편집 스크립트가
 * 아니다 — 부르는 쪽이 원하는 것이 "무엇이 같은가" 이고, 빈틈은 그것에서
 * 파생한다.
 *
 * `null` 은 편집 거리가 상한을 넘었다는 뜻이다 (FR-EDD-13). 잘라 맞춘 답을
 * 돌려주지 않는다 — 반쯤 맞는 표시는 없는 표시보다 나쁘다.
 *
 * trace 는 라운드마다 `[-d..d]` 구간만 담는다. 전체 폭(`2(N+M)+1`)을 라운드마다
 * 복사하면 큰 파일에서 그 자체가 수십 MB 다.
 */
function edDdMyers(a,b,maxD){
  const n=a.length,m=b.length;
  if(!n||!m) return [];
  const max=n+m,off=max;
  const v=new Int32Array(2*max+1);
  const trace=[];
  const cap=Math.min(max,maxD);
  for(let d=0;d<=cap;d++){
    trace.push(v.slice(off-d,off+d+1));
    for(let k=-d;k<=d;k+=2){
      let x;
      if(k===-d||(k!==d&&v[off+k-1]<v[off+k+1])) x=v[off+k+1];
      else x=v[off+k-1]+1;
      let y=x-k;
      while(x<n&&y<m&&a[x]===b[y]){x++;y++}
      v[off+k]=x;
      if(x>=n&&y>=m) return edDdBacktrack(trace,d,n,m);
    }
  }
  return null;
}

// trace[d] 는 라운드 d **시작 시점**의 v 이므로 그 안의 유효 범위는 `[-(d-1)..d-1]`
// 이다. 인덱스는 `k+d` 다.
function edDdBacktrack(trace,d,n,m){
  const out=[];
  // 도달점은 (n,m) 이다 — 그 좌표에 닿았기 때문에 루프가 끝났다.
  let x=n,y=m;
  for(let dd=d;dd>0;dd--){
    const w=trace[dd];
    const k=x-y;
    let pk;
    if(k===-dd||(k!==dd&&w[k-1+dd]<w[k+1+dd])) pk=k+1; else pk=k-1;
    const px=w[pk+dd],py=px-pk;
    while(x>px&&y>py){x--;y--;out.push([x,y])}
    if(x>px) x--; else y--;
  }
  while(x>0&&y>0){x--;y--;out.push([x,y])}
  out.reverse();
  return out;
}

/**
 * FR-EDD-46 의 좌표 사상은 **`core/hunk-coords.js` 에 있다.**
 *
 * DIFF_HUNK_BAR_SRS D-2: Diff 탭의 hover 툴바가 같은 사상을 필요로 하게 되면서
 * 공용 자리로 옮겼다 — `gitHunkCoordsForChange` 가 옛 `edDdStageCoords` 이고
 * `gitHunkRangeForChange` 가 옛 `edDdLineRange` 다. 뜻은 한 글자도 바뀌지 않았다:
 * 조각의 새 줄 범위 **와** 옛 줄 범위를 함께 아는 이 경로가 그 함수의 첫 호출자다.
 */

// ── 데코레이션의 색 (FR-EDD-23·23b) ──
//
// 값을 박지 않고 CSS 변수에서 읽는다. 테마가 바뀌면 이 캐시를 놓는 것이 곧
// 재칠이며, 그 계기는 `FileEditor.applyTheme` 하나다.
let edDdOpts=null;
function edDdReset(){ edDdOpts=null }
function edDdDecoOptions(type){
  if(!edDdOpts){
    edDdOpts={};
    const st=getComputedStyle(document.documentElement);
    for(const t of [ED_DD_ADD,ED_DD_MOD,ED_DD_DEL]){
      const color=st.getPropertyValue(ED_DD_COLOR_VAR[t]).trim();
      edDdOpts[t]={
        linesDecorationsClassName:'fe-dd-'+t,
        // 조각의 자리는 **계산이 정한다.** 편집 중에 데코레이션이 스스로 자라면
        // 다음 계산이 오기 전까지 화면이 실제와 어긋난다.
        stickiness:monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        overviewRuler:color?{color,position:monaco.editor.OverviewRulerLane.Left}:null,
        minimap:color?{color,position:monaco.editor.MinimapPosition.Gutter}:null,
      };
    }
  }
  return edDdOpts[type];
}

/**
 * 저장소 루트에서 이 Editor 루트까지의 접두. 탐색기의 `_prefixOf` 와 **같은
 * 규약**이다 (FR-EDD-3) — 클라이언트가 심볼릭 링크를 풀려 하지 않고 서버가 준
 * 정규화 값을 쓴다.
 */
function edDdPrefix(repo,resolved){
  if(!resolved) return null;
  if(resolved===repo) return '';
  const base=repo.endsWith('/')?repo:repo+'/';
  if(!resolved.startsWith(base)) return null;
  return resolved.slice(base.length)+'/';
}

/**
 * 문서 하나의 변경 표시. **모델에 걸린다** (D-4) — 같은 파일을 두 칸에서 열어도
 * 기준 취득과 계산은 한 번이고, 결과는 그 모델을 붙인 모든 편집기에 함께 뜬다.
 */
class EdDirtyDiff{
  constructor(app,filePath){
    this.app=app;
    this.filePath=filePath;
    this.base=null;      // 기준 줄 배열. null 이면 표시하지 않는다 (FR-EDD-6·7)
    this.changes=[];
    this.repo='';
    this.rel='';
    // 첫 취득이 끝났는가. "아직 오지 않았다" 와 "변경이 없다" 는 다른 사실이다.
    this.settled=false;
    this.views=new Set();
    this._model=null;
    this._ids=[];
    this._timer=null;
    this._seq=0;
    // FR-EDD-8: 503 은 굳히고 4xx 는 늦춘다 — 탐색기와 같은 관례다.
    this._off=false;
    this._retryAt=0;
  }

  attach(model){
    if(!model||this._model===model) return;
    this._model=model;
    this.refresh();
  }

  // FR-EDD-50: 기준을 다시 받는다. 늦게 도착한 응답이 새 것을 덮지 않도록
  // 세대를 센다.
  async refresh(){
    const seq=++this._seq;
    const got=await this._load();
    if(seq!==this._seq) return;
    if(!got) this.base=null;
    this.settled=true;
    this.recompute();
  }

  async _load(){
    if(this._off) return false;
    if(this._retryAt&&Date.now()<this._retryAt) return false;
    const root=this._root();
    if(!root) return false;
    const st=await gitFetch(GIT_STATUS_API,{repo:root});
    if(!st.ok){
      if(st.status===503) this._off=true;
      else if(st.status>=400&&st.status<500) this._back();
      return false;
    }
    const d=st.data||{};
    if(!d.repo){this._back();return false}
    const prefix=d.rootMatch?'':edDdPrefix(d.repo,d.requestedResolved||'');
    if(prefix===null){this._back();return false}
    const tail=this.filePath.slice(root.endsWith('/')?root.length:root.length+1);
    if(!tail) return false;
    this._retryAt=0;
    const rel=prefix+tail;
    const dc=await gitFetch('/api/git/diff-content',
      {repo:d.repo,axis:ED_DD_AXIS,path:rel});
    if(!dc.ok) return false;
    const side=(dc.data||{}).original;
    // FR-EDD-6: absent(untracked)·binary·LFS·상한은 **표시하지 않는다.** 빈 기준과
    // 비교하면 새 파일이 통째로 초록이 되는데, 그것은 사실이지만 쓸모가 없다.
    if(!side||side.kind!==ED_DD_KIND_TEXT) return false;
    this.repo=d.repo;
    this.rel=(dc.data||{}).path||rel;
    this.base=String(side.content||'').split('\n');
    return true;
  }

  _back(){ this._retryAt=Date.now()+EDITOR_GIT_BACKOFF_MS }

  // 이 파일을 담는 Editor 루트. 가장 **긴** 것을 고른다 — 루트가 겹치면 안쪽이
  // 그 파일의 창이고, 그 창의 루트가 status 의 대상이다 (FR-EDD-3).
  _root(){
    const app=this.app;
    if(!app||!app._edRoots) return '';
    let best='';
    for(const r of app._edRoots()){
      if(!r) continue;
      const base=r.endsWith('/')?r:r+'/';
      if(this.filePath.startsWith(base)&&r.length>best.length) best=r;
    }
    return best;
  }

  // FR-EDD-14: 타이핑 한 글자마다 돌리지 않는다.
  schedule(ms){
    clearTimeout(this._timer);
    this._timer=setTimeout(()=>this.recompute(),ms===undefined?ED_DD_DEBOUNCE_MS:ms);
  }

  recompute(){
    clearTimeout(this._timer);
    const m=this._model;
    if(!m||(m.isDisposed&&m.isDisposed())) return;
    if(!this.base){this.changes=[];this._paint([]);this._sync();return}
    const r=edDiffLines(this.base,m.getLinesContent());
    this.changes=r.changes;
    this._paint(r.changes);
    this._sync();
  }

  _paint(changes){
    const m=this._model;
    if(!m) return;
    const total=m.getLineCount();
    const out=[];
    for(const c of changes){
      // 삭제 조각의 자리는 문서의 끝을 넘을 수 있다 — 지워진 줄이 마지막이었다면
      // 그 자리에 오는 줄이 없다. 마지막 줄에 붙인다.
      const s=Math.min(Math.max(1,c.line),total);
      const e=c.count?Math.min(s+c.count-1,total):s;
      out.push({range:new monaco.Range(s,1,e,1),options:edDdDecoOptions(c.type)});
    }
    this._ids=m.deltaDecorations(this._ids,out);
  }

  _sync(){ for(const v of this.views) if(v._ddSync) v._ddSync() }

  // 그 줄을 덮는 조각. 좌측 막대를 누른 자리가 곧 이 물음이다.
  changeAt(line){
    for(const c of this.changes){
      const s=c.line,e=c.count?c.line+c.count-1:c.line;
      if(line>=s&&line<=e) return c;
    }
    return null;
  }

  // 이 조각의 기준 쪽 줄들. 팝업이 보이는 것이며 서버를 다시 부르지 않는다
  // (FR-EDD-31).
  baseLines(ch){
    if(!this.base||!ch||!ch.baseCount) return [];
    return this.base.slice(ch.baseStart-1,ch.baseStart-1+ch.baseCount);
  }

  /**
   * FR-EDD-40: 되돌리기는 **모델 편집**이다. `executeEdits` 로 넣으므로 undo 가
   * 듣고, 저장 전까지 디스크는 그대로다 (FR-EDD-41).
   *
   * 서버의 `patch{op:'revert'}` 를 쓰지 않는다 — 그것은 파괴적이고 되돌릴 길이
   * 없다 (D-3).
   */
  revert(ch,editor){
    const m=this._model;
    if(!m||!this.base||!ch||!editor) return false;
    const total=m.getLineCount();
    const text=this.baseLines(ch);
    let range,str;
    if(!ch.count){
      // 지워졌던 줄을 되돌려 넣는다.
      const at=Math.min(Math.max(1,ch.line),total+1);
      if(at>total){
        const col=m.getLineMaxColumn(total);
        range=new monaco.Range(total,col,total,col);
        str='\n'+text.join('\n');
      }else{
        range=new monaco.Range(at,1,at,1);
        str=text.join('\n')+'\n';
      }
    }else if(!ch.baseCount){
      // 더해진 줄을 걷는다. 줄 자체를 없애야 하므로 범위가 **줄 경계**를 넘는다.
      const s=Math.min(ch.line,total),e=Math.min(ch.line+ch.count-1,total);
      if(e<total){range=new monaco.Range(s,1,e+1,1)}
      else if(s>1){range=new monaco.Range(s-1,m.getLineMaxColumn(s-1),e,m.getLineMaxColumn(e))}
      else{range=new monaco.Range(s,1,e,m.getLineMaxColumn(e))}
      str='';
    }else{
      const s=Math.min(ch.line,total),e=Math.min(ch.line+ch.count-1,total);
      range=new monaco.Range(s,1,e,m.getLineMaxColumn(e));
      str=text.join('\n');
    }
    editor.executeEdits('dirty-diff',[{range,text:str,forceMoveMarkers:true}]);
    this.schedule(0);
    return true;
  }

  /**
   * FR-EDD-43~48: 스테이지는 서버가 한다 — 클라이언트는 좌표만 보낸다.
   *
   * dirty 면 **먼저 저장한다** (I-2). `diffId` 는 디스크의 diff 해시이므로
   * (SRS §2.5) 저장하지 않고 올리면 화면이 고른 조각과 서버가 올리는 조각이
   * 다를 수 있고, 그것이 stale 로도 걸리지 않는다.
   */
  async stage(ch,view){
    if(!ch) return {ok:false,msg:ED_DD_STAGE_FAIL};
    if(view&&view._dirty){
      await view.save();
      if(view._dirty) return {ok:false,msg:ED_DD_SAVE_FAIL};
    }
    // 저장이 기준을 바꿀 수 있으므로(방금 쓴 내용이 워킹 트리다) 좌표는 저장
    // **뒤에** 받는다.
    if(!this.repo||!this.rel) return {ok:false,msg:ED_DD_STAGE_FAIL};
    const hu=await gitFetch('/api/git/hunks',
      {repo:this.repo,axis:ED_DD_AXIS,path:this.rel});
    if(!hu.ok) return {ok:false,msg:ED_DD_STAGE_FAIL};
    const co=gitHunkCoordsForChange((hu.data||{}).hunks,ch);
    if(!co) return {ok:false,msg:ED_DD_STAGE_STALE};
    const res=await gitPost('/api/git/patch',{
      repo:this.repo,axis:ED_DD_AXIS,path:this.rel,op:GIT_PATCH_STAGE,
      hunk:co.hunk,from:co.from,to:co.to,diffId:(hu.data||{}).diffId||'',
    });
    if(!res.ok){
      // 사유를 사람의 말로 옮기는 자리는 `GIT_WRITE_ERR` 하나다 — 두 벌을 두면
      // 한쪽만 고쳐진다 (constants-git.js:1330 의 근거와 같다).
      const code=(res.data||{}).error;
      return {ok:false,msg:GIT_WRITE_ERR[code]||ED_DD_STAGE_FAIL};
    }
    // FR-EDD-48: 방금 index 가 바뀌었다 — 화면과 기준이 함께 따라와야 한다.
    if(this.app&&this.app._gitSignal) this.app._gitSignal('patch');
    this.refresh();
    return {ok:true,wide:co.wide};
  }

  dispose(){
    clearTimeout(this._timer);
    this._seq++;
    // FR-EDD-16: 모델이 살아 있으면 데코레이션을 걷는다. 남기면 다시 열었을 때
    // 낡은 막대가 먼저 보인다.
    const m=this._model;
    if(m&&!(m.isDisposed&&m.isDisposed())&&this._ids.length){
      try{m.deltaDecorations(this._ids,[])}catch{ /* 이미 버려진 모델 */ }
    }
    this._ids=[];
    this._model=null;
    this.base=null;
    this.changes=[];
    this.views.clear();
  }
}

// ── 칸 하나의 클릭과 팝업 (FR-EDD-30~37) ──
//
// 팝업은 **편집기의 것**이다 — view zone 이 에디터마다 있고, 두 칸이 같은 파일을
// 볼 때 한쪽에서 연 팝업이 다른 칸의 화면을 밀어야 할 이유가 없다. 조각과 기준은
// 문서의 것이므로(`EdDirtyDiff`) 여기서 다시 계산하지 않는다.
Object.assign(FileEditor.prototype,{
  _ddInit(){
    const app=window.app;
    if(!app||!app._edDirtyDiff||!this._editor) return;
    this._dd=app._edDirtyDiff(this.filePath);
    this._dd.views.add(this);
    this._dd.attach(this._editor.getModel());
    this._editor.onMouseDown((e)=>{
      const t=e&&e.target;
      if(!t||t.type!==monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
      const ln=t.position&&t.position.lineNumber;
      const ch=ln&&this._dd?this._dd.changeAt(ln):null;
      if(!ch){this._ddClose();return}
      this._ddOpen(ch);
    });
    // 이미 계산이 끝난 문서를 두 번째 칸이 붙였을 수 있다 — 그때는 attach 가
    // 아무것도 하지 않으므로 여기서 한 번 칠한다.
    if(this._dd.settled) this._dd.recompute();
  },

  _ddOpen(ch){
    this._ddClose();
    const dd=this._dd;
    if(!dd||!this._editor) return;
    const old=dd.baseLines(ch);
    const node=document.createElement('div');
    node.className='fe-dd-peek';
    node.innerHTML=
      '<div class="fe-dd-peek-bar">'+
        '<button type="button" class="fe-dd-peek-act" data-act="revert" title="'+
          escHtml(ED_DD_REVERT_TITLE)+'">'+escHtml(ED_DD_REVERT)+'</button>'+
        '<button type="button" class="fe-dd-peek-act" data-act="stage" title="'+
          escHtml(ED_DD_STAGE_TITLE)+'">'+escHtml(ED_DD_STAGE)+'</button>'+
        '<span class="fe-dd-peek-note"></span>'+
        '<button type="button" class="fe-dd-peek-close" title="'+
          escHtml(ED_DD_PEEK_CLOSE_TITLE)+'">✕</button>'+
      '</div>'+
      '<pre class="fe-dd-peek-old"></pre>';
    // FR-EDD-32: 파일의 내용은 **텍스트 노드**로 넣는다. 마크업으로 넣으면 파일이
    // 화면을 고친다.
    const pre=node.querySelector('.fe-dd-peek-old');
    if(old.length) pre.textContent=old.join('\n');
    else{ pre.textContent=ED_DD_PEEK_ADDED; pre.classList.add('none') }

    node.querySelector('.fe-dd-peek-close').addEventListener('click',()=>this._ddClose());
    for(const b of node.querySelectorAll('.fe-dd-peek-act')){
      b.addEventListener('click',()=>this._ddAct(b.dataset.act,b));
    }
    // 조각 위에 뜬다. 삭제 조각의 자리도 같다 — 지워진 줄이 있던 자리가 그 위다.
    const after=Math.max(0,ch.line-1);
    const rows=Math.min(Math.max(old.length,1),ED_DD_PEEK_MAX_LINES);
    this._editor.changeViewZones((acc)=>{
      this._ddZone=acc.addZone({afterLineNumber:after,heightInLines:rows+1,domNode:node});
    });
    this._ddNode=node;
    this._ddChange=ch;
  },

  async _ddAct(act,btn){
    const dd=this._dd,ch=this._ddChange;
    if(!dd||!ch) return;
    if(act==='revert'){
      dd.revert(ch,this._editor);
      this._ddClose();
      return;
    }
    // FR-EDD-44: 저장이 앞설 수 있으므로 시간이 걸린다 — 침묵은 고장과 구별되지
    // 않는다.
    this._ddNote(ED_DD_STAGING);
    for(const b of (this._ddNode?this._ddNode.querySelectorAll('.fe-dd-peek-act'):[])) b.disabled=true;
    const res=await dd.stage(ch,this);
    if(!res.ok){
      this._ddNote(res.msg);
      for(const b of (this._ddNode?this._ddNode.querySelectorAll('.fe-dd-peek-act'):[])) b.disabled=false;
      return;
    }
    // 넓게 올렸으면 그 사실을 말한다 (FR-EDD-46 ③). 조각은 곧 사라지므로
    // 팝업은 그 다음 계산이 닫는다 (FR-EDD-36).
    if(res.wide) this._ddNote(ED_DD_STAGE_WIDE);
    else this._ddClose();
  },

  _ddNote(text){
    const el=this._ddNode&&this._ddNode.querySelector('.fe-dd-peek-note');
    if(el) el.textContent=text||'';
  },

  // FR-EDD-36: 조각이 사라지면 팝업도 닫힌다. 없는 조각에 대한 동작 버튼을
  // 남기지 않는다.
  _ddSync(){
    const ch=this._ddChange;
    if(!ch) return;
    const live=(this._dd&&this._dd.changes||[]).some(c=>
      c.type===ch.type&&c.line===ch.line&&c.count===ch.count&&c.baseStart===ch.baseStart);
    if(!live) this._ddClose();
  },

  _ddClose(){
    if(this._ddZone&&this._editor){
      const id=this._ddZone;
      this._editor.changeViewZones((acc)=>acc.removeZone(id));
    }
    this._ddZone=null;
    this._ddNode=null;
    this._ddChange=null;
  },

  _ddDrop(){
    this._ddClose();
    if(this._dd) this._dd.views.delete(this);
    this._dd=null;
  },
});
