/**
 * GitPanel — 쓰기 한 번의 전과 후 (SPLIT_REFACTOR_SRS 묶음 B).
 *
 * 두 구간이 한 파일에 있다. 원본에서 이 둘은 떨어져 있었지만 **같은 한 번의 쓰기**를
 * 말한다:
 *
 *   · `after*Write` 훅 — 쓰기가 끝난 뒤 무엇을 다시 받고 무엇을 알릴지 (원본 1203~1320)
 *   · `applyWriteFail`·`writeReason`·`post`·`adopt` — 그 응답을 읽는 법 (원본 1599~1738)
 *   · 진행 중 오퍼레이션(merge·rebase·cherry-pick)의 화면과 출구 (FR-GIT-251)
 *
 * 서버는 실패 응답에도 status 를 싣는다 — 충돌로 멈춘 쓰기의 진행 중 상태가
 * 화면에 도달하는 것이 이 파일의 책임이다.
 */
// 원본 panel.js 1203~1320
Object.assign(GitPanel.prototype, {
  /**
   * 커밋 동작 하나의 뒷정리 (묶음 D, FR-GIT-263~266).
   *
   * **실패 응답도 status 를 싣고 온다** — cherry-pick·revert·drop 이 충돌로 멈추면
   * 실패 코드로 오지만 저장소에는 진행 중 상태가 남는다 (FR-GIT-251). 그것을
   * 반영하지 않으면 Changes 탭 머리의 출구가 보이지 않는다.
   *
   * 커밋 목록 자체가 바뀌므로 refs 만이 아니라 History 를 다시 받는다.
   */
  afterCommitOp(res){
    if(res&&res.ok){this._note=null; this.adopt(res.data)}
    // 실패도 status 를 싣고 온다 — `applyWriteFail` 이 그것을 반영하므로 충돌로
    // 멈춘 cherry-pick 의 진행 중 상태가 Changes 탭에 그대로 나타난다.
    else this.applyWriteFail(res||{});
    if(this._historyView) this._historyView.reload();
    if(this._branchesView) this._branchesView.reload();
  },

  // FR-GIT-267: 비교 기준의 표시. History 가 그것을 보이는 자리를 안다.
  noteCompareMark(label){
    if(this._historyView) this._historyView.noteCompareMark(label);
  },

  /**
   * ref 를 바꾼 쓰기 하나의 뒷정리 (FR-GIT-160·170).
   *
   * 응답에 실린 실행 후 status 로 화면을 갱신하고 **refs 를 다시 받는다** — status
   * 만으로는 새 브랜치가 생겼는지, 어느 것이 사라졌는지 알 수 없다.
   *
   * GIT_VIEW_REFRESH_SRS FR-GVR-20: History 는 **목록까지** 다시 받는다. 커밋 행에
   * 붙는 배지도 ref 에서 나오는데 그것은 `git log` 의 decoration 이라 사이드바만
   * 다시 받아서는 갱신되지 않는다 — 왼쪽은 바뀌는데 그래프는 낡은 채로 남는 것이
   * 그 자리였다 (접수한 말 그대로다).
   */
  afterRefWrite(d){
    this.adopt(d);
    if(this._branchesView) this._branchesView.reload();
    if(this._historyView) this._historyView.reload();
  },

  /**
   * 원격 작업 하나의 뒷정리 (GIT_VIEW_REFRESH_SRS FR-GVR-1~4).
   *
   * 로컬 쓰기에는 위의 `after*Write` 가 있었는데 원격 경로에만 그 대응물이 없었다 —
   * 그래서 push 뒤 History 가 옛 refs 를 보였다. 갱신 지식은 `remote.js` 가 아니라
   * **여기**에 둔다 (D-1): 뷰를 아는 자리가 둘로 갈리면 한쪽만 고쳐진다.
   *
   * **실패해도 갱신한다** (D-3) — 실패한 push 도 Console 에 남고, 여러 ref 를 밀던
   * 중 일부만 움직였을 수 있다.
   */
  /**
   * FR-GVR-3: 원격 작업이 끝나면 **Console 만** 다시 받는다.
   *
   * 잡은 `post()` 를 지나지 않으므로 Console 이 스스로 알 길이 없다. 서버는 그것도
   * 기록에 남기므로(jobs/job.go 의 RecordWrite) 읽으러 가기만 하면 된다. **실패한
   * 작업도 남아야 하므로** 성공 여부를 가리지 않는다 — 그리고 실패는 저장소를
   * 바꾸지 않으니 이 경로 말고는 알릴 길이 없다.
   *
   * History·Branches 는 여기서 받지 않는다. 성공한 push·fetch 는 `ahead`·`behind`
   * 를 움직이고 그것이 `_viewFp` 에 들어 있어 **폴링이 같은 회차에 잡는다** —
   * 여기서 또 받으면 한 조작에 두 번 받는다 (D-2 철회).
   */
  afterRemoteJob(){
    if(this._consoleView) this._consoleView.reload();
  },

  // ── stash 쓰기 (GIT_MENUS stash 가 부른다) ──

  async stashApply(index,withIndex){
    const res=await this.post('/api/git/stash/apply',
      {repo:this.repo,index,withIndex:!!withIndex});
    this.afterStashWrite(res);
  },

  async stashPop(index){
    const res=await this.post('/api/git/stash/pop',{repo:this.repo,index});
    this.afterStashWrite(res);
  },

  // drop 은 파괴적이다 (FR-GIT-89·168). 파괴적 확인과 recovery hint 는 GitMenu 가
  // 이미 거쳤으므로 여기서는 `confirm` 을 실어 보낸다 — 서버도 그것을 요구한다.
  async stashDrop(index){
    const res=await this.post('/api/git/stash/drop',
      {repo:this.repo,index,confirm:true});
    this.afterStashWrite(res);
  },

  /**
   * stash 쓰기 하나의 뒷정리 (FR-GIT-165·170).
   *
   * **실패 응답도 status 와 목록을 싣고 온다** — pop 이 충돌로 끝나면 stash 가
   * 남으므로 그 사실을 Stash 탭이 그 자리에서 알려야 한다.
   */
  afterStashWrite(res){
    const d=(res&&res.data)||{};
    if(d.status) this.adopt(d);
    // 실패 사유는 Stash 탭이 보인다 — Changes 탭의 안내로 보내면 사용자가 조작한
    // 자리에서 결과를 읽을 수 없다.
    this._stash().adoptWrite(res);
  },

  // ── 묶음 F — stash·파일·미커밋 행 (FR-GIT-272~275·277) ──
  // 실행은 도메인별 클래스에 있다 — 여기 있는 것은 메뉴가 부르는 한 줄뿐이다.

  // FR-GIT-272: Branch from stash. 다이얼로그는 git-stash.js 가 안다.
  stashBranch(s){return new GitStashBranch(this,s)._show()},

  // FR-GIT-277: 미커밋 행의 Stash. 생성 다이얼로그를 그대로 다시 쓴다.
  stashCreate(){return new GitStashCreate(this)._show()},

  /**
   * stash 쓰기이면서 **ref 도 바꾸는** 것의 뒷정리 (FR-GIT-160·170).
   *
   * Branch from stash 하나가 그것이다 — stash 목록과 refs 가 함께 바뀌므로 둘 다
   * 다시 받는다. status 만으로는 새 브랜치가 생겼는지 알 수 없다.
   */
  afterStashRefWrite(res){
    this.afterStashWrite(res);
    if(!res||!res.ok) return;
    if(this._branchesView) this._branchesView.reload();
    // FR-GVR-20: `afterRefWrite` 와 같은 근거 — 새 브랜치는 커밋 행의 배지에도
    // 나타나야 하고, 그 배지는 목록을 다시 받아야 갱신된다.
    if(this._historyView) this._historyView.reload();
  },

});

// 원본 panel.js 1599~1738
Object.assign(GitPanel.prototype, {
  // FR-GIT-73 · §7.1 I2: 실패를 조용히 넘기지 않는다. 부분 적용이면 무엇이
  // 바뀌었는지까지 보인다 — git 이 주지 않는 원자성을 흉내 내지 않는다.
  applyWriteFail(res){
    const d=res.data||{};
    this._note={msg:this.writeError(res),partial:!!d.partial,changed:d.changed||[]};
    if(d.status) this.adopt(d); else this._paint();
  },

  // POST 한 번. ok 는 **서버가 ok:true 를 준 것**이다 — 200 이지만 본문이 없는
  // 응답을 성공으로 읽지 않는다.
  async post(url,body){
    this._writing=true;
    // 망 실패·파싱 실패를 접는 일은 `gitPost` 가 한다 (api.js) — 두 벌로 두면
    // 한쪽만 고쳐진다. 여기 남는 것은 **패널 고유의 관심사** 둘이다.
    const res=await gitPost(url,body);
    this._writing=false;
    // 모든 쓰기가 이 한 곳을 지난다 — 방금 실행한 명령이 Console 의 맨 위에
    // 있어야 한다 (FR-GIT-218).
    if(this._consoleView) this._consoleView.reload();
    // **이 표면의 성공 판정은 `d.ok` 다** — HTTP 200 만으로는 성공이 아니다.
    // 부분 적용도 200 으로 오기 때문이다 (FR-GIT-73).
    return {ok:!!(res.ok&&res.data&&res.data.ok),code:res.status,data:res.data};
  },

  writeReason(res){
    const d=res.data||{};
    return GIT_WRITE_ERR[d.error]||GIT_WRITE_FAIL;
  },

  writeError(res){
    const m=(res.data&&res.data.message)||'';
    return this.writeReason(res)+(m?': '+m:'');
  },

  // 응답에 실린 **실행 후** status 로 화면을 즉시 갱신한다 (FR-GIT-71) — 폴링
  // 주기를 기다리지 않는다.
  //
  // signature 는 쓰기 응답에 없으므로 _lastSig 를 그대로 둔다. 다음 signature
  // 폴링이 차이를 보고 한 번 더 재조회하는 것은 해롭지 않다.
  adopt(d){
    if(!d||!d.status||d.requested!==this.repo) return;
    this._status=Object.assign({},this._status||{},
      {requested:d.requested,repo:d.repo,status:d.status});
    this._errMsg=null; this._staleNote=false;
    // 사용자가 부른 쓰기의 응답이다 — 화면은 반드시 바뀐다 (FR-RPT-5). 다만 근거는
    // 갱신해 둔다: 곧 오는 폴링이 같은 관측으로 한 번 더 그리지 않게 한다.
    this._obsSig=JSON.stringify(d.status||null);
    // FR-SVS-44: 쓰기의 **결과는 관측**이다 — 조작이 어느 칸에서 시작됐는지는
    // 결과에 영향을 주지 않으므로 모든 칸이 함께 바뀐다.
    this.obs.paintAll();
    this.app._gitReposRefresh();
    this.app._updateStatusBar();
  },

  /**
   * 진행 중 작업 줄 (FR-GIT-252).
   *
   * **출구 목록은 서버가 준다** (`/api/git/policy` 의 operations) — 여기서 복제하면
   * merge 에 없는 Skip 이 생기고, 눌리면 exit 128 로만 실패한다. 아직 못 받았으면
   * 버튼을 그리지 않는다: 없는 버튼을 그리는 것보다 안 그리는 쪽이 안전하다.
   */
  _paintOp(el,s){
    const box=el.querySelector('.git-op-bar'); if(!box) return;
    const op=(s&&s.operation)||null;
    const kind=(op&&op.kind)||'';
    box.classList.toggle('vis',!!kind);
    box.dataset.kind=kind;
    if(!kind) return;
    box.querySelector('.git-op-kind').textContent=GIT_OP_LABEL[kind]||kind;
    // 리베이스의 "몇 번째 중". 알 수 없으면 비운다 — 반쪽짜리 진행 표시는 없는
    // 것보다 나쁘다.
    box.querySelector('.git-op-at').textContent=(op.total>0)
      ? GIT_OP_AT.replace('%n',String(op.at||0)).replace('%t',String(op.total)) : '';
    const acts=this._opActions(kind);
    for(const b of box.querySelectorAll('.git-op-act'))
      b.classList.toggle('vis',acts.indexOf(b.dataset.act)>=0);
  },

  // 정책은 한 번만 받아 들고 있는다. 받으면 그때 다시 그린다 — 판정을 그리기에
  // 업지 않는다 (FR-RPT-8).
  _opActions(kind){
    if(this._opActs) return this._opActs[kind]||[];
    if(!this._opActsP){
      this._opActsP=GitConfirm.policy().then(p=>{
        this._opActs=(p&&p.operations)||{};
        this._opActsP=null;
        this._paint();
      });
    }
    return [];
  },

  /**
   * 출구 하나를 실행한다 (FR-GIT-252).
   *
   * **중단만 파괴적 확인이다** — 그 작업 중 해결한 내용이 사라지고 되살릴 값이 없다.
   * 계속·건너뛰기는 되돌릴 것이 없다. 서버도 같은 것을 요구한다(confirm) —
   * 클라이언트만 막으면 API 직접 호출이 우회한다.
   */
  runOperation(action){
    const op=(this.statusOf()||{}).operation||{};
    const kind=op.kind||''; if(!kind) return;
    if(action!==GIT_OP_ABORT) return this._runOp(kind,action,false);
    return GitDialog.confirm({
      action:GIT_ACT_OP_ABORT,title:GIT_OP_ABORT_TITLE,
      targets:[GIT_OP_LABEL[kind]||kind],
      hint:{note:GIT_OP_ABORT_NOTE,command:'git '+kind+' --abort'},
      stages:2,
      run:async()=>{
        const res=await this._runOp(kind,action,true);
        if(res.ok) return {ok:true};
        return {ok:false,reason:this.writeReason(res),
          stderrTail:(res.data&&res.data.message)||''};
      },
    });
  },

  async _runOp(kind,action,confirm){
    const res=await this.post('/api/git/operation',
      {repo:this.repo,kind,action,confirm:!!confirm});
    if(res.ok){this._note=null; this.adopt(res.data)}
    else this.applyWriteFail(res);
    return res;
  },

  _paintNote(el){
    const box=el.querySelector('.git-partial-note'); if(!box) return;
    const n=this._note;
    box.classList.toggle('vis',!!n);
    box.querySelector('.git-partial-msg').textContent=
      n?(n.partial?n.msg+' — '+GIT_PARTIAL_NOTE:n.msg):'';
    const ul=box.querySelector('.git-partial-list'); ul.innerHTML='';
    for(const p of (n&&n.changed)||[]){
      const li=document.createElement('li'); li.className='git-partial-path';
      li.textContent=p; ul.appendChild(li);
    }
  },

  // ── 선택과 이동 (FR-GIT-52) ──

});

