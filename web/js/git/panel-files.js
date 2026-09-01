/**
 * GitPanel — 파일에 하는 일 (SPLIT_REFACTOR_SRS 묶음 B).
 *
 * 선택(`_sel`·`_range`·`_bulk`)과 그 선택에 가하는 동작 — 스테이지·언스테이지·
 * discard(`_discard`)·충돌 해결(`_resolveSide`)·ignore·되돌리기가 여기 산다.
 * `_run` 이 그 전부의 단일 통로이며, `_op` 가 무엇을 보낼지 정한다.
 *
 * 무엇이 보이는지는 panel-changes.js, 응답을 어떻게 읽는지는 panel-write.js 다.
 */
Object.assign(GitPanel.prototype, {
  // FR-GIT-277: untracked 경로들. Clean 의 대상 목록과 비활성 판정이 같은 값을
  // 딛는다 — 두 벌로 두면 한쪽만 고쳐진다.
  untrackedPaths(){
    const s=this.statusOf();
    return ((s&&s.untracked)||[]).map(e=>e.path);
  },

  // mixed 다 — index 만 HEAD 로 되돌리고 워킹 트리는 그대로 둔다.
  async uncommittedReset(){
    if(this._writing) return;
    const res=await this.post('/api/git/uncommitted/reset',{repo:this.repo});
    this._after(res,[]);
  },

  // **파괴적이다** (FR-GIT-277). 파괴적 확인과 recovery hint 는 GitMenu 가 이미
  // 거쳤으므로 여기서는 `confirm` 을 실어 보낸다 — 서버도 그것을 요구한다.
  async uncommittedClean(){
    if(this._writing) return;
    const res=await this.post('/api/git/uncommitted/clean',
      {repo:this.repo,confirm:true});
    this._after(res,[]);
  },

  /**
   * FR-GIT-273: 경로를 `.gitignore` 에 덧붙인다. **git 실행이 아니라 파일 쓰기다.**
   *
   * 이미 있던 줄은 서버가 `skipped` 로 답한다 — "추가했습니다" 로 뭉개면 사용자는
   * 아무 일도 아니었던 것을 성공으로 읽는다 (V200).
   */
  async ignorePath(t){
    if(!t||!t.path||this._writing) return;
    const res=await this.post('/api/git/ignore',{repo:this.repo,paths:[t.path]});
    if(!res.ok){
      this._note={msg:GIT_IGNORE_FAIL+': '+this.writeError(res)};
      this._paint();
      return;
    }
    const d=res.data||{};
    this._after(res,[]);
    // 이미 있던 줄은 `skipped` 로 온다 — 그 사실을 보이지 않으면 사용자는 아무 일도
    // 아니었던 것을 성공으로 읽는다 (V200).
    if(!(d.added||[]).length){this._note={msg:GIT_IGNORE_DUP+': '+t.path};this._paint()}
  },

  // FR-GIT-275: path 필터를 채워 History 탭을 연다. **새 조회를 만들지 않는다** —
  // 필터는 FR-GIT-129 로 이미 있다.
  openFileHistory(t){
    if(!t||!t.path) return;
    // **탭을 먼저 연다.** 아직 마운트되지 않은 History 는 mount 가 `_repo` 를 비우고,
    // 그 뒤 첫 paint 의 `_adopt` → `reset` 이 방금 채운 필터를 지운다. 열어 둔 뒤에
    // 채우면 두 경우 모두 성립한다 — 이미 받아들였으면 그대로, 아니면 filterPath 가
    // 스스로 받아들인다.
    this.openView('history');
    this._history().filterPath(t.path);
  },

  /**
   * FR-GIT-274: 워킹 트리가 아니라 `HEAD:<path>` 의 내용을 연다.
   *
   * 여는 자리는 Open File 과 같은 규약이다 — Git 창이 아닌 창이다
   * (FR-GIT-179·185). 조회는 서버가 diff 의 `cat-file` 경로를 그대로 쓴다.
   */
  async openFileAtHead(t){
    if(!t||!t.path||!this.repo) return;
    const q=new URLSearchParams({repo:this.repo,path:t.path});
    const res=await gitFetch('/api/git/file-head',Object.fromEntries(q));
    const d=res.data;
    if(!res.ok||!d||!d.openPath){
      // 사유를 그 자리에 보인다 — 빈 편집기를 열면 사용자는 파일이 비었다고 읽는다.
      this._note={msg:GIT_HEAD_OPEN_FAIL+((d&&d.message)?': '+d.message:'')};
      this._paint();
      return;
    }
    this._note=null;
    this.app._gitOpenFileHead(d.openPath,t.path);
  },

  // 워킹 트리에 남은 변경의 개수. History 의 미커밋 변경 행(FR-GIT-127)과
  // checkout 의 dirty 판정(FR-GIT-157)이 같은 값을 딛는다.
  dirtyCount(){
    const s=this._status&&this._status.status; if(!s) return 0;
    let n=0;
    for(const g of GIT_GROUPS) n+=(s[g.key]||[]).length;
    return n;
  },

  isDirty(){return this.dirtyCount()>0},

  /**
   * FR-GIT-138: 커밋 상세의 파일을 Diff 탭에 `commit-parent` 축으로 보인다.
   *
   * f 는 {repo,axis,path,origPath,oid,parentOid} 다 — 그대로 질의 인자가 된다.
   * `parentOid` 가 비면 루트 커밋이고 original 쪽이 absent 로 온다 (오류가 아니다).
   * 머지 커밋에서는 고른 부모의 oid 가 들어온다 (FR-GIT-139).
   */
  showCommitDiff(f){
    if(!f||!f.oid) return;
    this.commitFile=f;
    this.openView('diff');
    this._paint();
  },

  // Diff 탭이 보일 대상. 커밋 축이 있으면 그것이 먼저다 — Changes 탭의 미리보기는
  // previewFile 만 본다 (§3.2).
  _diffTarget(){return this.commitFile||this.previewFile},

  _selKey(group,path){return group+'\x00'+path},

  _group(key){
    const s=this._status&&this._status.status;
    return (s&&s[key])||[];
  },

  // 선택은 status 에 남아 있는 것만 뜻한다 — 사라진 경로의 선택은 저절로 잊힌다.
  _selected(){
    const out=[];
    for(const g of GIT_GROUPS)
      for(const e of this._group(g.key))
        if(this._sel.has(this._selKey(g.key,e.path)))
          out.push({group:g.key,path:e.path,origPath:e.origPath||''});
    return out;
  },

  // rename 은 index 에서 (원본 삭제 + 대상 추가) 두 경로다 (FR-GIT-36). 대상만
  // 되돌리면 원본의 삭제가 index 에 남아 **반쪽만 언스테이지된다** — 짝을 함께
  // 보낸다. stage 는 원본이 워킹 트리에 없으므로 대상만 보낸다.
  _paths(act,items){
    const out=[];
    for(const i of items){
      out.push(i.path);
      if(act==='unstage'&&i.origPath) out.push(i.origPath);
    }
    return out;
  },

  // 동작이 뜻을 갖는 대상만 남긴다 — staged 행을 stage 하거나 untracked 행을
  // unstage 하는 것은 아무 일도 하지 않는다.
  _fit(act,items){
    if(act==='unstage') return items.filter(i=>i.group!=='untracked');
    return items.filter(i=>i.group!=='staged');
  },

  /**
   * FR-GIT-208: 행 인라인 버튼의 대상.
   *
   * 누른 행이 **선택 안에 있으면 선택 전체**가, 밖이면 그 행 하나가 대상이다 —
   * 여러 개를 골라 두고 그 중 아무 행에서나 누르면 골라 둔 것에 걸린다.
   * 선택 밖의 행을 누르는 것은 "이 행만" 이라는 뜻이므로 선택을 끌어오지 않는다.
   */
  _rowTargets(act,group,path,origPath){
    const one=[{group,path,origPath:origPath||''}];
    if(!this._sel.has(this._selKey(group,path))) return this._fit(act,one);
    const all=this._fit(act,this._selected());
    return all.length?all:this._fit(act,one);
  },

  // Shift 는 화면에 보이는 순서대로 범위를 고른다 (FR-GIT-69) — 그룹 경계를
  // 넘어도 목록의 순서가 그대로 기준이다.
  _range(group,path){
    const el=this._els.get('changes'); if(!el) return;
    const rows=Array.from(el.querySelectorAll('.git-file'));
    const at=r=>rows.findIndex(x=>x.dataset.group===r.group&&x.dataset.path===r.path);
    const a=at(this._anchor),b=at({group,path});
    if(a<0||b<0){this._sel.add(this._selKey(group,path));return}
    const lo=Math.min(a,b),hi=Math.max(a,b);
    for(let i=lo;i<=hi;i++)
      this._sel.add(this._selKey(rows[i].dataset.group,rows[i].dataset.path));
  },

  // 그룹 일괄은 그려진 행이 아니라 그룹 **전체**다 (FR-GIT-66·67) — 목록이
  // 잘려 보이는 것과 대상 범위는 별개다.
  _bulk(group,act){
    this._run(act,this._group(group).map(e=>({group,path:e.path,origPath:e.origPath||''})));
  },

  // 쓰기 한 번의 단일 경로다. 충돌 stage 의 뜻 알림과 discard 의 파괴적 확인이
  // 여기서 갈린다.
  async _run(act,items){
    if(!items.length||!this.repo) return;
    // FR-GIT-236: Open File 은 쓰기가 아니므로 진행 중인 쓰기에 막히지 않는다.
    // 우클릭 메뉴도 이 자리를 지난다 — 두 벌로 두면 한쪽만 고쳐진다.
    if(act==='openFile'){
      for(const i of items) this.app._gitOpenFile(this.absPath(i));
      return;
    }
    if(this._writing) return;
    if(act==='discard'){this._discard(items);return}
    if(act==='ours'||act==='theirs'){this._resolveSide(act,items);return}
    // FR-GIT-72: 충돌 파일의 stage 는 "해결됨 표시" 다. 실행 **전에** 그 뜻을
    // 알린다. 파괴적이 아니므로 1단계 확인이다.
    const conflicts=items.filter(i=>i.group==='conflicts').map(i=>i.path);
    if(act==='stage'&&conflicts.length){
      const ok=await GitDialog.confirm({
        action:GIT_ACT_RESOLVE,title:GIT_RESOLVE_TITLE,targets:conflicts,
        hint:{note:GIT_RESOLVE_NOTE,command:'git reset -q HEAD -- '+conflicts.map(gitShQuote).join(' ')},
        stages:1,
      });
      if(!ok) return;
    }
    const url=act==='stage'?'/api/git/stage':'/api/git/unstage';
    const res=await this.post(url,{repo:this.repo,paths:this._paths(act,items)});
    this._after(res,items);
  },

  /**
   * 진행 중인 조작. preflight 가 이미 안다 — 두 번 묻지 않는다.
   * 모르면 빈 문자열이고, 그때 툴팁은 양쪽을 다 밝힌다 (FR-GIT-224).
   */
  _op(){
    const pf=this._commit()._pf;
    for(const b of (pf&&pf.blocks)||[]){
      const op=GIT_OP_BY_BLOCK[b.code];
      if(op) return op;
    }
    return '';
  },

  /**
   * 충돌 파일을 한쪽으로 받아 해결한다 (FR-GIT-224).
   *
   * **파괴적이다** — 워킹 트리의 충돌 표식과 손대던 내용이 사라지고 git 에 저장된
   * 적이 없어 되살릴 값이 없다. discard 와 같은 규약을 지난다: 판정은 서버의
   * 목록이 하고(GitConfirm), 확인을 거치며, 요청에 confirm 을 함께 보낸다.
   */
  async _resolveSide(side,items){
    const paths=items.filter(i=>i.group==='conflicts').map(i=>i.path);
    if(!paths.length) return;
    const repo=this.repo;
    const label=(GIT_SIDE_TITLE[this._op()]||GIT_SIDE_TITLE[''])[side];
    await GitDialog.confirm({
      action:GIT_ACT_RESOLVE_SIDE,
      title:GIT_RESOLVE_SIDE_TITLE,
      targets:paths,
      hint:{note:label+'. '+GIT_RESOLVE_SIDE_NOTE,
        command:'git checkout -m -- '+paths.map(gitShQuote).join(' ')},
      run:async()=>{
        const res=await this.post('/api/git/resolve',{repo,side,paths,confirm:true});
        this._after(res,items);
        if(res.ok) return {ok:true};
        return {ok:false,reason:this.writeReason(res),stderrTail:(res.data&&res.data.message)||''};
      },
    });
  },

  // discard 는 파괴적이다 (FR-GIT-89). 판정은 서버의 목록이 하고(GitConfirm),
  // 확인을 거치며, 실행 요청에는 confirm 을 함께 보낸다 — 서버도 그것을
  // 요구한다.
  async _discard(items){
    const tracked=items.filter(i=>i.group!=='untracked').map(i=>i.path);
    const untracked=items.filter(i=>i.group==='untracked').map(i=>i.path);
    const targets=tracked.concat(untracked);
    if(!targets.length) return;
    const repo=this.repo;
    await GitDialog.confirm({
      action:GIT_ACT_DISCARD,title:GIT_DISCARD_TITLE,targets,
      // O8: stash 를 자동 생성하지 않는다 — 실행할 명령을 보여 준다.
      hint:{note:GIT_DISCARD_NOTE,command:'git stash push -- '+targets.map(gitShQuote).join(' ')},
      run:async()=>{
        const res=await this.post('/api/git/discard',{repo,tracked,untracked,confirm:true});
        this._after(res,items);
        if(res.ok) return {ok:true};
        // 사유와 stderr tail 은 다이얼로그 안에서 보인다 (FR-GIT-96·175).
        return {ok:false,reason:this.writeReason(res),stderrTail:(res.data&&res.data.message)||''};
      },
    });
  },

  // 쓰기 응답 하나의 처리. 성공이면 안내를 지우고 처리한 대상을 선택에서 뺀다.
  _after(res,items){
    if(res.ok){
      this._note=null;
      for(const i of items) this._sel.delete(this._selKey(i.group,i.path));
      this.adopt(res.data);
      return;
    }
    this.applyWriteFail(res);
  },

});
