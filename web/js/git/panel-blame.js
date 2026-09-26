/**
 * GitPanel — Blame (FR-GIT-276 · F-5.2). `panel-diff.js` 의 증강 분할이다
 * (OPTIMIZE_REFACTOR_SRS FR-OPT-12-4 · FEU-22) — 계약은 `GitPanel` 한 클래스에 남고 주제만 옮겼다.
 */
Object.assign(GitPanel.prototype, {
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
    const target=this._blameTarget();
    box.classList.toggle('vis',!!target);
    // FR-LAY-3: `.off` 를 `[hidden]` 으로 옮겼다.
    el.querySelector('.git-diff-body').hidden=!!target;
    if(!target){
      this._blameKey=null; this._blameData=null; this._blameErr=null;
      this._blameAll=false;
      box.dataset.sig=''; return;
    }
    // 대상이 그대로면 다시 부르지 않는다 — 폴링마다 재요청하면 스크롤이 매초
    // 초기화된다 (_paintHunks 와 같은 규약).
    const key=[this.repo||'',target.rev,target.path].join(RPT_SEP);
    if(this._blameKey!==key){
      this._blameKey=key; this._blameData=null; this._blameErr=null;
      // FR-PRF-18: "전체 보기" 는 **그 파일에 대한 선택**이다 — 다른 파일로 옮기면
      // 다시 상한이 선다. 남겨 두면 파일을 옮겨 다니는 동안 상한이 조용히 사라진다.
      this._blameAll=false;
      this._loadBlame(target,key);
    }
    this._drawBlame(box);
  },

  async _loadBlame(target,key){
    const tok=this.token();
    // FR-GRF-6: 조회에는 시한이 있다 (gitFetch 의 기본).
    const r=await gitFetch(GIT_API.blame,{repo:this.repo||'',rev:target.rev,path:target.path});
    const d=r.data;
    if(this.isStale(tok)||this._blameKey!==key) return;
    // 서버가 되돌려준 요청값도 확인한다 — 같은 세대 안에서도 응답 순서가 뒤바뀔 수
    // 있다 (FR-GIT-54).
    const q=(d&&d.requested)||{};
    if(!r.ok||!d||q.path!==target.path||q.rev!==target.rev){
      // 거부 사유는 **누른 자리**에 보인다 — 서버가 준 문구가 있으면 그것을 쓴다.
      this._blameErr=(d&&d.message)||GIT_BLAME_FAIL;
      this._paint(); return;
    }
    this._blameData={lines:d.lines||[],commits:d.commits||{}};
    this._paint();
  },

  /**
   * FR-PRF-18: 행 수에 **상한**이 있다.
   *
   *   이전 동작: 줄 수만큼 전부 그렸다 — 행마다 6노드라 5,000줄이면 30,000노드
   *   새  동작: `GIT_BLAME_MAX_ROWS` 까지만 그리고, 잘랐다는 사실과 **전체 보기**를
   *             안내줄이 말한다
   *   이유:     `refactor/README.md` §4.1 항목 4. 같은 저장소의 `doc-render` 가
   *             큰 표를 같은 방법으로 이미 다룬다 (`DOC_RENDER_TABLE_MAX_ROWS`)
   *
   * 자르는 것은 **사실을 숨기는 것이 아니다** — 숨기면 사용자는 파일이 그만큼인
   * 줄 안다. 그래서 전체 줄 수와 보인 줄 수를 둘 다 적는다 (FR-DRV-29 와 같은 규약).
   */
  _drawBlame(box){
    const d=this._blameData;
    const all=d?d.lines.length:0;
    const cut=!this._blameAll&&all>GIT_BLAME_MAX_ROWS;
    const shown=cut?GIT_BLAME_MAX_ROWS:all;
    // 판정 근거는 이 렌더러가 읽는 값 전부다 (FR-RPT-2) — 보인 줄 수가 여기 있어야
    // "전체 보기" 가 실제로 다시 그린다.
    const sig=[this._blameKey,this._blameErr||'',d?all:-1,shown].join(RPT_SEP);
    if(box.dataset.sig===sig) return;
    box.dataset.sig=sig;
    const note=box.querySelector('.git-blame-note');
    const rows=box.querySelector('.git-blame-rows');
    const msg=this._blameErr||(!d?GIT_BLAME_LOADING:(all?'':GIT_BLAME_EMPTY));
    note.textContent=msg; note.classList.toggle('vis',!!msg||cut);
    // F-5.2: 조회 실패는 다시 시도할 수 있다 — 사유 옆에 길을 둔다.
    if(this._blameErr){
      note.appendChild(UIKit.button({label:GIT_BLAME_RETRY,size:'sm',cls:'git-blame-retry',
        onClick:()=>{this._blameKey=null;this._paint()}}));
    }
    rows.innerHTML='';
    if(!d||!all) return;
    if(cut){
      note.textContent=GIT_BLAME_CUT.replace('%r',String(all)).replace('%n',String(shown));
      note.appendChild(UIKit.button({label:GIT_BLAME_SHOW_ALL,size:'sm',cls:'git-blame-all',
        onClick:()=>{this._blameAll=true;this._paint()}}));
    }
    const frag=document.createDocumentFragment();
    for(let i=0;i<shown;i++){
      const ln=d.lines[i];
      frag.appendChild(this._blameRow(ln,d.commits[ln.oid]||{}));
    }
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
  openBlame(target){
    if(!target||!target.path) return;
    this._blameOn=true;
    this._openDiff(target.group,{path:target.path,origPath:target.origPath||''});
  },

  // F-5.2: 작업 트리 파일의 Blame 을 다시 받게 한다 — 저장·git_changed·새로고침이 부른다.
  // 커밋 축(rev 있음)의 blame 은 낡지 않는다.
  blameStale(){
    const target=this._blameTarget();
    if(!target||target.rev) return;
    this._blameKey=null;
    this._paint();
  },
});
