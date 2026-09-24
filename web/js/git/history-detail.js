/**
 * Dongminal — History 의 **인라인 커밋 상세** (FE_MODULE_BOUNDARY_SRS FR-FMB-32).
 *
 * 행을 펼치면 그 자리에서 열리는 상세 (FR-GIT-135~139) — 부모 선택 · 파일 목록 ·
 * 그 파일의 diff 로 가는 길. 별창이 아니라 **행의 일부**라서 행 높이 계산이
 * 이것을 안다 (`history-rows.js` 의 `_paintRows`).
 */
Object.assign(GitHistory.prototype, {
  // ── 인라인 상세 (FR-GIT-135~139) ──

  _buildDetail(){
    const el=document.createElement('div');
    el.className='git-hist-detail ui-scroll';
    el.innerHTML=
      '<div class="git-hist-d-head">'+
        '<code class="git-hist-d-oid"></code>'+
        '<span class="git-hist-d-parents"></span>'+
      '</div>'+
      '<div class="git-hist-d-who"></div>'+
      '<pre class="git-hist-d-body ui-scroll"></pre>'+
      '<div class="git-hist-d-filehead">'+
        '<span class="git-hist-d-filelabel"></span>'+
        '<label class="git-hist-d-pick">'+
          '<span></span><select class="git-hist-d-parentpick"></select>'+
        '</label>'+
      '</div>'+
      '<div class="git-hist-d-files"></div>';
    el.querySelector('.git-hist-d-pick span').textContent=GIT_DETAIL_PARENT_PICK;
    el.querySelector('.git-hist-d-parentpick').addEventListener('change',ev=>{
      this._parentIdx=Number(ev.target.value)||0;
      this._loadDetail();
    });
    // 상세 안의 클릭이 행 클릭(접기)으로 새지 않게 막는다.
    el.addEventListener('click',ev=>ev.stopPropagation());
    return el;
  },

  _paintDetail(){
    const el=this._detailEl; if(!el) return;
    const d=this._detail;
    el.dataset.oid=this._open||'';
    el.classList.toggle('loading',!d&&!this._detailErr);
    el.querySelector('.git-hist-d-oid').textContent=(d&&d.oid)||this._open||'';
    const ps=el.querySelector('.git-hist-d-parents');
    const parents=(d&&d.parents)||[];
    // FR-PRF-10 — 이전: 회차마다 비우고 다시 만들었다. 새: 값이 그대로면 그리지
    // 않는다. 이유: 상세는 열려 있는 동안 `_paintRows` 를 타고 매 관측 회차에
    // 다시 칠해지는데, 부모는 커밋이 바뀌지 않으면 바뀌지 않는다.
    paintIfChanged(ps,parents.join(','),()=>{
      ps.innerHTML='';
      const lab=document.createElement('span');
      lab.className='git-hist-d-plabel';
      lab.textContent=parents.length?GIT_DETAIL_PARENTS:GIT_DETAIL_ROOT;
      ps.appendChild(lab);
      for(const p of parents){
        const a=document.createElement('code');
        a.className='git-hist-d-parent'; a.dataset.oid=p;
        a.textContent=p.slice(0,8); a.title=p;
        // F-8.4: 로드 범위 밖의 부모도 찾아간다 — `_goto` 는 받은 목록 안에서만 움직인다.
        a.addEventListener('click',()=>this._jumpTo(p));
        ps.appendChild(a);
      }
    });
    const who=el.querySelector('.git-hist-d-who');
    if(d){
      who.textContent=
        'author '+d.authorName+' <'+d.authorMail+'> '+GitHistory.absTime(d.authorAtUnixMs)+
        ' · committer '+d.committerName+' <'+d.committerMail+'> '+
        GitHistory.absTime(d.commitAtUnixMs);
    }else who.textContent=this._detailErr||GIT_HIST_LOADING;
    el.querySelector('.git-hist-d-body').textContent=(d&&d.body)||'';
    // FR-GIT-139: 머지 커밋만 부모를 고른다. 기본은 첫 부모다.
    const pick=el.querySelector('.git-hist-d-pick');
    pick.classList.toggle('vis',parents.length>1);
    const sel=el.querySelector('.git-hist-d-parentpick');
    if(sel.dataset.for!==(el.dataset.oid+':'+parents.length)){
      sel.dataset.for=el.dataset.oid+':'+parents.length;
      sel.innerHTML='';
      for(let i=0;i<parents.length;i++){
        const op=document.createElement('option');
        op.value=String(i); op.textContent='#'+(i+1)+' '+parents[i].slice(0,8);
        sel.appendChild(op);
      }
    }
    sel.value=String(this._parentIdx);
    const files=(d&&d.files)||[];
    el.querySelector('.git-hist-d-filelabel').textContent=
      d?(files.length?GIT_DETAIL_FILES+' ('+files.length+')':GIT_DETAIL_NO_FILES):'';
    // FR-PRF-10 — 이전: 회차마다 비우고 다시 만들었다. 새: 바뀐 행만 다시 만든다.
    // `reconcileList` 는 키 없는 자식을 지우므로 첫 회차에 옛 방식으로 그려 둔
    // 것이 있으면 함께 거둬진다.
    const box=el.querySelector('.git-hist-d-files');
    reconcileList(box,files,{
      key:f=>f.path,
      sig:f=>[f.status,f.path,f.origPath||'',f.score||''].join('\u0001'),
      build:f=>this._fileEl(d,f),
    });
  },

  _fileEl(d,f){
    const row=document.createElement('div');
    row.className='git-hist-file'; row.dataset.path=f.path;
    const st=document.createElement('span'); st.className='git-hist-file-st';
    st.textContent=f.status;
    const p=document.createElement('span'); p.className='git-hist-file-path';
    p.textContent=f.origPath?f.origPath+' → '+f.path:f.path;
    row.title=p.textContent+(f.score?' ('+f.score+'%)':'');
    row.appendChild(st); row.appendChild(p);
    row.addEventListener('click',()=>this.panel.showCommitDiff({
      repo:this._repo,axis:GIT_AXIS.COMMIT,oid:d.oid,
      parentOid:(d.parents||[])[d.parentIndex]||'',
      path:f.path,origPath:f.origPath||'',
    }));
    return row;
  },

  // 펼침은 한 번에 하나만이다 (§3.1) — 여러 개를 허용하면 가변 높이 문제가
  // 되돌아온다.
  _toggle(c){
    if(this._open===c.oid){this._open=null;this._detail=null;this._detailErr=null}
    else{this._open=c.oid;this._detail=null;this._detailErr=null;this._parentIdx=0;this._loadDetail()}
    this._ver++;
    this._paintRows();
  },
});
