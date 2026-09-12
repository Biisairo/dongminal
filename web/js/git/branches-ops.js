/**
 * Dongminal — Branches 의 **쓰기 동작** (FE_MODULE_BOUNDARY_SRS FR-FMB-30·31).
 *
 * checkout(FR-GIT-155·156·157) · 생성 · 이름 변경 · 삭제 · 병합 · 리베이스 ·
 * 업스트림 · 푸시 (GIT_ACTIONS_SRS §3.2 FR-GIT-253~259 · §3.5 FR-GIT-268).
 *
 * **전부 `static` 이다.** 우클릭 메뉴는 History 탭의 refs 사이드바에서도 열리므로
 * checkout 이 Branches 탭의 인스턴스에 묶여 있으면 그쪽에서 쓸 수 없다. 그래서
 * 클래스 **객체 자신**에 얹는다 — 프로토타입이 아니다 (정적 증강).
 *
 * 기본은 항상 안전한 쪽이다 (FR-GIT-97, O14).
 */
Object.assign(GitBranches, {
  // ── checkout (FR-GIT-155·156·157) ──

  /**
   * ref 하나로 옮겨 간다. dirty 면 무엇을 할지 먼저 고르게 한다 (FR-GIT-157).
   *
   * **기본은 취소다** (O14) — stash 도 사용자의 작업 상태를 옮기는 행위이므로
   * 기본이 아니고, 강제는 파괴적이므로 `GitConfirm` 의 확인을 거친다.
   */
  async checkout(panel,ref,o){
    if(!panel||!panel.repo) return;
    const opts=Object.assign({repo:panel.repo,ref:ref||''},o||{});
    if(!panel.isDirty()) return GitBranches._send(panel,opts);
    const pick=await GitDialog.open({
      id:'git-choice',ns:'gch',action:'checkout_dirty',
      title:GIT_DIRTY_TITLE,body:GIT_DIRTY_NOTE,
      choices:GIT_DIRTY_OPTS,def:GIT_DIRTY_OPT_CANCEL,
    });
    if(pick===GIT_DIRTY_OPT_FORCE) return GitBranches._force(panel,opts);
    // 취소와 모르는 값은 아무것도 하지 않는다 — 기본은 항상 안전한 쪽이다 (O14).
    if(pick!==GIT_DIRTY_OPT_STASH) return;
    // stash 후 진행. untracked 까지 담는다 — 담지 않으면 untracked 뿐인 저장소에서
    // 서버가 `nothing_to_stash` 로 막고 사용자는 갈 곳이 없다 (FR-GIT-167).
    const res=await panel.post('/api/git/stash/push',
      {repo:panel.repo,message:GIT_STASH_BEFORE_MSG,includeUntracked:true});
    panel.afterStashWrite(res);
    if(!res.ok) return;
    return GitBranches._send(panel,opts);
  },

  // 원격 ref 는 같은 이름의 로컬을 만들며 추적을 설정한다 (FR-GIT-156) —
  // `origin/feat` 로 그냥 옮겨 가면 detached 가 된다.
  checkoutRemote(panel,short){
    const s=short||'';
    const i=s.indexOf(GIT_BR_PREFIX_SEP);
    const name=i<0?s:s.slice(i+1);
    return GitBranches.checkout(panel,'',{create:name,track:s});
  },

  // 강제는 워킹 트리의 변경을 버린다. 서버의 파괴적 목록에 없는 이름이므로 확인
  // 단계를 **명시적으로 2** 로 요구한다 (계약 §1.1).
  _force(panel,opts){
    return GitDialog.confirm({
      action:GIT_ACT_CHECKOUT_FORCE,title:GIT_FORCE_TITLE,
      targets:[opts.create||opts.ref||''],
      hint:{note:GIT_FORCE_NOTE,command:'git stash push -u'},
      stages:2,
      run:async()=>{
        const res=await GitBranches._post(panel,
          Object.assign({},opts,{force:true,confirm:true}));
        if(res.ok) return {ok:true};
        return {ok:false,reason:panel.writeReason(res),
          stderrTail:(res.data&&res.data.message)||''};
      },
    });
  },

  async _send(panel,opts){
    const res=await GitBranches._post(panel,opts);
    if(res.ok) return res;
    // 로컬 이름 충돌은 실패가 아니라 **선택**이다 (FR-GIT-156).
    const d=res.data||{};
    if(res.code===409&&d.error==='branch_exists'){
      await GitBranches._conflict(panel,opts,d);
      return res;
    }
    panel.applyWriteFail(res);
    return res;
  },

  async _post(panel,opts){
    const res=await panel.post('/api/git/checkout',opts);
    // 조작 후 목록·상태를 갱신한다 (FR-GIT-160).
    if(res.ok) panel.afterRefWrite(res.data);
    return res;
  },

  /**
   * 이름 충돌의 선택지는 **서버가 준 순서 그대로**다 (계약 §1.2.1) — 목록을 프론트가
   * 복제하면 서버가 선택지를 늘려도 그것을 보이지 못한다. 기본은 취소다 (O14).
   */
  async _conflict(panel,opts,d){
    const ids=Array.isArray(d.options)?d.options:[];
    const options=ids.map(id=>({id,label:GIT_BR_CONFLICT_LABEL[id]||id,
      danger:id==='checkout_existing'}));
    const pick=await GitDialog.open({
      id:'git-choice',ns:'gch',action:'branch_exists',
      title:GIT_BR_CONFLICT_TITLE,body:d.message||'',
      choices:options,def:'cancel',
    });
    if(pick==='checkout_existing')
      return GitBranches._send(panel,{repo:opts.repo,ref:d.branch||''});
    if(pick==='create_other_name')
      return GitBranches.create(panel,
        {name:(d.branch||'')+GIT_BR_RENAME_SUFFIX,track:d.track||opts.track||''});
  },

  // 브랜치 생성 다이얼로그 (FR-GIT-158·159).
  create(panel,o){
    if(!panel||!panel.repo) return;
    return new GitBranchCreate(panel,o||{})._show();
  },

  // ── 묶음 B — 브랜치 동작 (GIT_ACTIONS_SRS §3.2 FR-GIT-253~259 · §3.5 FR-GIT-268) ──
  //
  // 접수한 말의 본체다: "branch 삭제, 이름변경 등 기본적인 기능들이 없다."
  //
  // 실행이 **static** 인 것은 checkout 과 같은 이유다 — 우클릭 메뉴는 History 탭의
  // refs 사이드바에서도 열리므로 Branches 탭 인스턴스에 묶여 있으면 그쪽에서 쓸 수
  // 없다. 다중 선택만 인스턴스의 것이며, 없으면 우클릭한 행 하나가 대상이다.
  //
  // 확인은 여기서 쓰지 않는다 — `GIT_MENUS.branch` 의 `destructive` 선언을
  // 프레임워크가 이미 거쳤다 (FR-GIT-146·172). 여기서는 그것을 거쳤음을 `confirm`
  // 으로 실어 보낸다. 서버도 같은 것을 요구한다.

  // 원격 ref 의 `origin/feat` 를 원격과 브랜치로 나눈다. 첫 `/` 만 보는 것은 브랜치
  // 이름에 `/` 가 흔하기 때문이다 (`origin/feature/a`) — checkoutRemote 와 같은 규칙이다.
  _split(short){
    const s=short||'';
    const i=s.indexOf(GIT_BR_PREFIX_SEP);
    return i<0?{remote:s,branch:''}:{remote:s.slice(0,i),branch:s.slice(i+1)};
  },

  /**
   * 쓰기 하나의 공통 뒷정리. 성공이면 목록·상태를 갱신하고 (FR-GIT-160), 충돌이면
   * **실패가 아니라 진행 중 상태**로 다룬다 (FR-GIT-251·255).
   */
  async _run(panel,url,body){
    const res=await panel.post(url,Object.assign({repo:panel.repo},body||{}));
    if(res.ok){panel.afterRefWrite(res.data);return res}
    if(GitBranches._conflicted(panel,res)) return res;
    panel.applyWriteFail(res);
    return res;
  },

  /**
   * FR-GIT-255: merge·rebase 가 충돌로 멈춘 것은 실패가 아니다 — 저장소에 중간
   * 상태가 남았고 출구는 묶음 A 가 준다 (FR-GIT-252).
   *
   * pull 이 쓰는 경로 그대로 Changes 탭으로 보내고 충돌 그룹을 펼친다 (FR-GIT-111).
   */
  _conflicted(panel,res){
    const d=(res&&res.data)||{};
    const st=d.status;
    if(!st) return false;
    if(!((st.operation&&st.operation.kind)||(st.conflicts||[]).length)) return false;
    panel.adopt(d);
    panel.branchNote(GIT_BR_MERGE_CONFLICT_NOTE);
    panel.expandGroup('conflicts');
    panel.openView('changes');
    return true;
  },

  // FR-GIT-253: 이름 변경. 이름 검사는 생성과 **같은 자리**를 쓴다.
  rename(panel,target){
    if(!panel||!panel.repo||!target) return;
    return new GitBranchRename(panel,target.short||'')._show();
  },

  /**
   * FR-GIT-254: 삭제. 기본은 `-d` 이고 대상은 다중 선택이 있으면 그것이다.
   *
   * **일괄 삭제는 `-d` 로만** 한다 — 확인 하나가 여러 개를 강제 삭제하는 자리를
   * 만들지 않는다. 서버도 같은 것을 막는다.
   */
  del(panel,target){
    if(!panel||!panel.repo||!target) return;
    return GitBranches._delete(panel,GitBranches.targetsOf(panel,target),false);
  },

  /**
   * 삭제 대상. 다중 선택 안의 행을 눌렀으면 선택 전체이고, 밖의 행이면 그 행
   * 하나다 — 보이는 것과 지워지는 것이 어긋나면 사용자는 무엇을 잃는지 알 수 없다.
   */
  targetsOf(panel,target){
    const one=[(target&&target.short)||''];
    const v=panel&&panel._branchesView;
    if(!v||typeof v.selection!=='function') return one;
    const sel=v.selection();
    return sel.indexOf(target.short)<0?one:sel;
  },

  async _delete(panel,names,force){
    const res=await panel.post('/api/git/branch/delete',
      {repo:panel.repo,names,force:!!force,confirm:true});
    if(res.ok){
      if(panel._branchesView) panel._branchesView.clearSelection();
      panel.afterRefWrite(res.data);
      return res;
    }
    const d=res.data||{};
    // 미머지는 실패가 아니라 **선택**이다 (FR-GIT-254) — 이름 충돌의 3선택과 같은 규약.
    // FR-BMU-14: 선택지의 **결과**를 돌려준다. 옛 코드는 언제나 원래의 실패 응답을
    // 돌려주어, 강제 삭제가 실제로 성공했는지 호출자가 알 수 없었다 — `delBoth` 는
    // 그것을 알아야 원격을 이을지 판단한다. 기존 호출자(`del`)는 반환값을 쓰지
    // 않으므로 동작은 바뀌지 않는다.
    if(res.code===409&&d.error==='branch_not_merged'){
      const forced=await GitBranches._unmerged(panel,d);
      return forced||res;
    }
    panel.applyWriteFail(res);
    return res;
  },

  /**
   * 미머지 거부 뒤의 선택지는 **서버가 준 순서 그대로**다 — 목록을 프론트가
   * 복제하면 서버가 선택지를 줄여도(다중 삭제에는 `-D` 가 없다) 그것을 따르지
   * 못한다. 기본은 취소다 (O14).
   */
  async _unmerged(panel,d){
    const ids=Array.isArray(d.options)?d.options:[];
    const options=ids.map(id=>({id,label:GIT_BR_UNMERGED_LABEL[id]||id,
      danger:id==='force_delete'}));
    const pick=await GitDialog.open({
      id:'git-choice',ns:'gch',action:'branch_not_merged',
      title:GIT_BR_UNMERGED_TITLE,body:d.message||'',
      choices:options,def:'cancel',
    });
    if(pick!=='force_delete') return;
    return GitBranches._delete(panel,[d.branch||''],true);
  },

  /**
   * FR-GIT-255: merge. 다이얼로그가 **영향 범위를 실행 전에 보인다** (G11) —
   * ff 로 끝나는지와 들어올 커밋 수다. 원격 ref 의 `Pull/Merge` 도 이 자리다.
   */
  async merge(panel,ref){
    if(!panel||!panel.repo||!ref) return;
    const pv=await GitBranches._preview(panel,ref);
    return GitDialog.open({
      id:'git-br-merge',ns:'gbm',action:'branch_merge',
      title:GIT_BR_MERGE_TITLE,runLabel:GIT_BR_MERGE_RUN,
      body:GitBranches._impact(ref,pv),
      fields:GIT_BR_MERGE_FIELDS,
      run:async v=>{
        const res=await GitBranches._run(panel,'/api/git/branch/merge',
          {ref,mode:v.mode||''});
        if(res.ok) return {ok:true};
        // 충돌이면 화면은 이미 Changes 탭으로 옮겨 갔다 — 다이얼로그가 실패를
        // 되풀이해 보일 자리가 아니다 (FR-GIT-251).
        const st=(res.data&&res.data.status)||{};
        if((st.operation&&st.operation.kind)||'') return {ok:true};
        return {ok:false,reason:panel.writeReason(res),
          stderrTail:(res.data&&res.data.message)||''};
      },
    });
  },

  // 영향 범위 조회. 실패해도 머지를 막지 않는다 — 그 사실을 문구로 알린다.
  async _preview(panel,ref){
    const q=new URLSearchParams({repo:panel.repo,ref});
    const res=await gitFetch('/api/git/branch/merge-preview',Object.fromEntries(q),
      {echo:{repo:panel.repo,ref}});
    return res.ok?(res.data.preview||null):null;
  },

  // 사람이 읽는 영향 범위. 개수만 보이면 머지 커밋이 생기는지 알 수 없고, ff 여부만
  // 보이면 무엇이 들어오는지 알 수 없다 — 둘 다 적는다 (G11).
  _impact(ref,pv){
    if(!pv) return ref+' · '+GIT_BR_MERGE_PREVIEW_FAIL;
    const parts=[ref];
    if(pv.upToDate) parts.push(GIT_BR_MERGE_UPTODATE);
    else parts.push(pv.ff?GIT_BR_MERGE_FF:GIT_BR_MERGE_NOFF);
    parts.push(GIT_BR_MERGE_INCOMING.replace('%n',String(pv.incoming||0)));
    if(pv.diverged>0) parts.push(GIT_BR_MERGE_DIVERGED.replace('%n',String(pv.diverged)));
    return parts.join(' · ');
  },

  // FR-GIT-256: rebase. 파괴적 확인과 hint 는 메뉴 프레임워크가 이미 거쳤으므로
  // 여기서는 `confirm` 을 실어 보낸다 — 서버도 그것을 요구한다.
  rebase(panel,ref){
    if(!panel||!panel.repo||!ref) return;
    return GitBranches._run(panel,'/api/git/branch/rebase',{ref,confirm:true});
  },

  // FR-GIT-257: upstream 설정. 후보는 **이미 받아 둔 원격 ref 목록**에서 온다.
  setUpstream(panel,target){
    if(!panel||!panel.repo||!target) return;
    return new GitBranchUpstream(panel,target)._show();
  },

  unsetUpstream(panel,target){
    if(!panel||!panel.repo||!target) return;
    return GitBranches._run(panel,'/api/git/branch/upstream',
      {branch:target.short||'',unset:true});
  },

  /**
   * FR-GIT-258: 브랜치 push. upstream 이 없으면 publish 이며 **그 사실을 실행 전에**
   * 알린다 — 대상이 현재 브랜치가 아니어도 같다 (FR-GIT-100 의 규약을 넓힌 것).
   *
   * 목록의 upstream 이 낡았을 수 있으므로 서버의 거부(409)도 같은 자리로 받는다.
   */
  async push(panel,target){
    if(!panel||!panel.repo||!target) return;
    const branch=target.short||'';
    if(!target.upstream) return GitBranches._publish(panel,branch,{});
    const res=await panel._remote().run('branch/push',{branch});
    const d=(res&&res.data)||{};
    if(!res.ok&&res.code===409&&d.error==='publish_required')
      return GitBranches._publish(panel,branch,d.plan||{});
    return res;
  },

  // 파괴적이 아니므로 1단계다 (FR-GIT-100). 무엇이 설정되는지는 계획이 있으면
  // 그것을 보인다 — 없어도 "publish 다" 라는 사실은 전해진다.
  async _publish(panel,branch,plan){
    const target=(plan&&plan.remote)
      ?(plan.remote+GIT_BR_PREFIX_SEP+(plan.branch||branch)):branch;
    const ok=await GitDialog.confirm({
      action:GIT_ACT_PUBLISH,title:GIT_PUBLISH_TITLE,targets:[target],stages:1,
    });
    if(!ok) return;
    return panel._remote().run('branch/push',{branch,publish:true});
  },

  // FR-GIT-268: 원격 ref 를 같은 이름의 로컬 ref 로 갱신한다. 원격 작업이므로 기존
  // job 경로를 탄다 — 진행·취소·실패 사유가 그 자리에 있다.
  fetchInto(panel,short){
    if(!panel||!panel.repo) return;
    const p=GitBranches._split(short);
    if(!p.branch) return;
    return panel._remote().run('branch/fetch',{remote:p.remote,branch:p.branch});
  },

  // FR-GIT-268: 원격 ref 삭제. 파괴적 확인은 메뉴 프레임워크가 거쳤다 (파괴적 목록에
  // `remote_ref_delete` 가 있다) — 여기서는 `confirm` 을 실어 보낸다.
  /**
   * FR-BMU-10~15: 로컬과 그 원격을 한 번에 지운다.
   *
   * 순서는 **로컬 먼저**다 (D-4). 로컬 삭제는 미머지면 거부되고 그때 사용자에게
   * 선택지가 뜨는데(FR-GIT-254), 원격을 먼저 지우면 그 거부를 만나기 전에 되돌리기
   * 어려운 쪽을 이미 잃는다.
   *
   * 원격 이름은 **지우기 전에** 확보한다 — 로컬이 사라지면 upstream 을 읽을 수 없다.
   */
  async delBoth(panel,t){
    if(!panel||!panel.repo||!t) return;
    const up=((t.upstream||'')+'').trim();
    if(!up) return;
    const res=await GitBranches._delete(panel,GitBranches.targetsOf(panel,t),false);
    // FR-BMU-14: 로컬이 실패하면 원격은 건드리지 않는다.
    if(!res||!res.ok) return res;
    const rr=await GitBranches.deleteRemote(panel,up);
    // FR-BMU-15: 반쪽만 지워진 것을 조용히 성공으로 보이지 않는다.
    if(rr&&rr.ok===false) panel.branchNote(GIT_BR_DELETE_BOTH_FAIL);
    return rr;
  },

  deleteRemote(panel,short){
    if(!panel||!panel.repo) return;
    const p=GitBranches._split(short);
    if(!p.branch) return;
    return panel._remote().run('branch/delete-remote',
      {remote:p.remote,branch:p.branch,confirm:true});
  },

  /**
   * 원격 ref 를 되살리는 push (FR-GIT-250.2). **지우기 전 oid** 를 싣는다 — 목록이
   * 그 값을 이미 준다 (/api/git/refs). 값이 없으면 명령을 만들지 않는다: 되살리지
   * 못하는 명령을 보이는 것이 빈 안내문보다 나쁘다.
   */
  restoreRemoteCmd(t){
    const p=GitBranches._split((t&&t.short)||'');
    if(!p.branch||!t.oid) return '';
    return 'git push '+p.remote+' '+t.oid+':refs/heads/'+p.branch;
  },
});
