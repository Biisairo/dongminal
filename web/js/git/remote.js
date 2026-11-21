/**
 * Dongminal — 원격 작업 (GIT_SRS §3B.1 / FR-GIT-98~112)
 *
 * Changes 탭 헤더의 Fetch / Pull / Push 를 살리고, 작업 하나의 수명을 화면에
 * 옮긴다. 뷰가 아니라 Changes 탭에 얹힌 조각이므로 자기 루트를 갖지 않는다 —
 * 골격은 GitPanel._buildChanges 가 세우고 `GitRemoteView`(remote-view.js)가 칠하며 동작을 붙인다.
 *
 * 원격 작업은 다른 쓰기와 성질이 다르다: 분 단위이고, 출력이 진행 상황이며,
 * 취소할 수 있고, **끝난 뒤에야 실패 사유를 알 수 있다**. 그래서 즉시 응답은
 * 작업 식별자만 주고(FR-GIT-102) 사유·선택지·인증 안내는 SSE 의 `done` 이벤트로
 * 온다 (계약 §2.3.1 ②).
 *
 * 조용히 넘기지 않는 것 넷:
 *
 * - **자격증명을 받는 입력을 만들지 않는다** (FR-GIT-104, 검증 V43). 인증이
 *   필요하면 터미널에서 수행하도록 복사 가능한 명령을 안내한다. 만들지 않는 것이
 *   유일한 보장이므로 이 파일에는 입력 요소가 옵션 다이얼로그의 체크박스·라디오
 *   말고는 없다.
 * - **거부 선택지의 순서를 바꾸지 않는다** (FR-GIT-105). 순서가 곧 우선순위이고
 *   force 가 마지막인 것이 "force 를 기본 제안하지 않는다" 다. 강조도 하지 않는다.
 * - **취소는 부분 적용 가능성을 알린다** (FR-GIT-102). 원격에 절반이 올라간 뒤
 *   끊길 수 있다.
 * - **진행 중에는 같은 리포의 다른 원격 버튼도 막는다** (FR-GIT-101). 판정은 서버의
 *   `/api/git/jobs` 를 딛는다 — 다른 브라우저 창이 띄운 작업도 같은 리포를 막는다.
 *
 * REPO_FIX 01 §6.4: 이 클래스는 **잡 칸 하나**의 표시기다 — kind 무관하다. 저장소마다
 * index·common 두 칸이 있고 `GitJobs`(jobs.js)가 둘을 묶어 패널에 하나의 표면으로
 * 준다. 시작(`run`)은 그 묶음이 칸을 골라 여기 `_launch` 로 넘긴다.
 */
class GitRemote {
  constructor(panel,slot,router){
    this.panel=panel;
    this.app=panel.app;
    this.slot=slot;
    this.router=router||null;
    this._busyKey='';     // 시작 요청이 오가는 동안 그 키 — 칸 판정에 쓴다
    this._job=null;       // 진행 중 작업. 내가 띄운 것이거나 /api/git/jobs 로 주워 온 것
    this._jobRepo=null;   // 그 작업의 저장소 (서버가 정규화한 루트)
    this._done=null;      // 끝난 작업. 실패 사유·선택지·인증 안내를 여기서 읽는다
    // FR-GIT-221: 끝난 작업의 로그를 펼쳐 둘지. null 이면 결과가 정한다 —
    // 성공은 접고 실패는 편다. 사용자가 바를 누르면 그 뜻이 이 값에 남는다.
    this._logOpen=null;
    this._busy=false;     // 시작 요청이 오가는 중 — 이때도 버튼을 막는다
    this._canceling=false;
    this._err=null;       // 시작 자체가 실패한 사유
    this._conflict=false; // FR-GIT-111
    this._lines=[];       // 보존 줄. 앞에서 버린다
    this._total=0;        // 이 작업에서 받은 줄 수 누계 (DOM 이 어디까지 그렸는지의 기준)
    this._seq=0;          // 마지막으로 받은 seq — 재연결 지점이다
    this._stream=null;
    this._streamErr=false;
    this._retries=0;
    // 충돌 판정을 기다리는 작업. 값은 그때의 status 객체다 — 그것이 바뀌어야
    // 판정할 값이 온 것이다 (FR-GIT-111).
    this._pending=null;
    // REFACTOR3_FE_REST3_SRS FR-FR3-13·14 (FU-12): 칠하기는 뷰가 한다. 상태와 잡의 수명은 여기 남는다.
    this.view=new GitRemoteView(this);
  }

  // 끝난 잡의 화면을 걷는다. 도는 잡은 건드리지 않는다.
  dismiss(){
    if(this._job||this._busy) return;
    this._done=null; this._err=null; this._conflict=false;
    this._lines=[]; this._total=0;
    this._paint();
  }

  // 이 칸의 표시기가 쥔 잡이 slot 칸을 차지하는가 — pull 은 index 표시기에 붙지만
  // common 칸도 쥔다. 칸은 서버가 준 `slots` 로만 안다 (GR-1e).
  holds(slot){
    if(this._job) return (this._job.slots||[this.slot]).includes(slot);
    return false;
  }


  // 리포가 바뀌면 붙어 있던 작업을 놓는다 (FR-GIT-16). 작업은 서버에서 계속 돌고
  // `/api/git/jobs` 가 그것을 계속 나른다 (FR-GIT-101a) — 화면만 새 리포의 것으로
  // 되돌린다.
  detachRepo(){
    this._closeStream();
    // 기다리던 쪽(`panel.post`)을 답 없이 끝낸다 — 매달리면 그 입력이 잠긴 채로 남는다.
    this._settleWaits(null);
    this._job=null; this._jobRepo=null; this._done=null; this._err=null;
    this._logOpen=null;
    this._conflict=false; this._busy=false; this._busyKey=''; this._canceling=false;
    this._lines=[]; this._total=0; this._seq=0;
    this._pending=null;
  }

  // ── 칠하기 ──

  /**
   * FR-RPT-8: 충돌 판정은 **관측 경로**에 있다 (`notifyStatus`) — 다시 그리기에
   * 업히면 안 된다. 관측이 같으면 그리지 않으므로(FR-RPT-1) 판정도 멈춘다.
   *
   * 여기에도 남겨 둔 것은 다른 계기의 다시 그리기에서도 뜻이 같기 때문이다 —
   * 판정 자체가 멱등이다.
   */
  paint(el){
    if(!el) return;
    // 충돌 판정은 새 status 가 도착한 뒤에만 뜻이 있다 (FR-GIT-111).
    if(this._pending) this._checkConflict();
    this.view.paintJob(el);
  }

  // 진행 중이면 **같은 리포의 원격 버튼 전부**가 막힌다 (FR-GIT-101).
  busy(){return !!(this._job||this._busy)}

  _paint(){
    const el=this.panel._els.get('changes');
    if(el&&el.dataset.built==='1') this.paint(el);
    // FR-GHM-6: 막힘은 리포의 사실이지 탭의 사실이 아니다 — Changes 만 고치면
    // History 에서 두 번째 push 를 띄울 수 있다.
    this.panel.paintHeads();
  }

  // ── 버튼 (FR-GIT-98·99) ──

  // 버튼은 기본 동작만 한다. 변형은 `▾` 에서만 온다.
  _click(kind){
    if(!GIT_REMOTE_KINDS.includes(kind)) return;
    if(kind==='push'){this._push('');return}
    this.run(kind,{});
  }

  _opts(kind){
    if(this.router.why(kind)||!GIT_REMOTE_DIALOGS[kind]) return;
    new GitRemoteOpts(this,kind)._show();
  }

  // ── 실행 ──

  /**
   * 작업 하나를 띄운다. 응답은 작업 식별자이고 그것으로 SSE 에 붙는다.
   *
   * 실패 사유는 여기에 없다 — 작업이 아직 끝나지 않았으므로 즉시 응답에 담길
   * 값이 없고, `done` 이벤트가 그것을 가져온다 (계약 §2.3.1 ②).
   */
  run(kind,body,opts){return this.router.run(kind,body,opts)}

  // 칸이 찼는지는 서버가 판정한다 (GR-1e). `opts.silent` 면 실행 전 거부를
  // 이 박스에 적지 않는다 — 시작 자리(다이얼로그 등)가 적는다 (§6.4).
  async _launch(kind,body,opts){
    const repo=this.panel.repo;
    if(!repo) return {ok:false,code:0,data:{}};
    this._busy=true; this._busyKey=kind; this._err=null; this._done=null; this._conflict=false;
    this._logOpen=null;
    this._paint();
    // 라우트는 kind 에서 파생한다. 기본 규칙(`/api/git/<kind>`)과 다른 것만
    // GIT_REMOTE_URL 에 있다 — 태그 push·원격 삭제가 그것이며(FR-GIT-262), 그것들도
    // **같은 job 경로**를 타야 하므로 새 실행 경로를 만들지 않는다.
    const res=await this._post(GIT_REMOTE_URL[kind]||(GIT_API_PREFIX+kind),
      Object.assign({repo},body||{}));
    this._busy=false; this._busyKey='';
    const job=res.data&&res.data.job;
    if(res.ok&&job&&job.id){this.router.track(job,this);return res}
    // Publish 는 서버가 실행 **전에** 되묻는다 (FR-GIT-100, 계약 §2.3.1 ①).
    if(kind==='push'&&res.data&&res.data.error==='publish_required'){
      this._paint();
      this._publish(res.data.plan||{},body);
      return res;
    }
    if(!(opts&&opts.silent)) this._err=this._reason(res);
    this._paint();
    return res;
  }

  /**
   * Push 는 세 갈래다: 기본 / Publish / force.
   *
   * force 는 `--force-with-lease` 가 기본이고 `--force` 도 같은 파괴적 확인을
   * 거친다 (FR-GIT-106) — 이름이 서버의 파괴적 목록에 있으므로 단계 수를 이쪽에서
   * 정하지 않는다.
   */
  _push(force){
    if(!force){this.run('push',{});return}
    this._forcePush(force);
  }

  /**
   * force 는 대상을 함께 받을 수 있다 (FR-GIT-271) — `▾` 다이얼로그가 고른
   * remote/branch 다. 확인 절차는 **바뀌지 않는다**: 이름이 서버의 파괴적 목록에
   * 있으므로 단계 수를 이쪽에서 정하지 않는다 (FR-GIT-106).
   */
  async _forcePush(force,body){
    const s=this.panel.statusOf()||{};
    const b=body||{};
    const target=(b.remote&&b.branch)?(b.remote+'/'+b.branch)
      :(s.upstream||(s.branch||''));
    const repo=this.panel.repo||'';
    await GitDialog.confirm({
      action:GIT_ACT_FORCE_PUSH,title:GIT_FORCE_PUSH_TITLE,targets:[target],
      hint:{note:GIT_FORCE_PUSH_NOTE,
        command:'git -C '+gitShQuote(repo)+' rev-parse '+(target||'HEAD')},
      run:async()=>{
        // `--force` 는 서버도 confirm 을 요구한다 — 확인을 거쳤음을 함께 보낸다.
        const res=await this.run('push',Object.assign({},b,{force,confirm:true}));
        if(res.ok) return {ok:true};
        return {ok:false,reason:this._reason(res),
          stderrTail:(res.data&&res.data.message)||''};
      },
    });
  }

  /**
   * FR-GIT-100: upstream 을 설정한다는 사실을 실행 전에 알린다. 파괴적이 아니므로
   * 1단계이며, 무엇이 설정되는지는 서버가 준 계획으로 보인다.
   *
   * `again` 이 있으면 확인 뒤 그것을 부른다 — 되물음을 받는 경로가 둘이므로
   * (FR-GIT-270) 확인 화면을 두 벌 만들지 않는다.
   */
  async _publish(plan,body,again){
    const target=(plan.remote||'')+'/'+(plan.branch||'');
    const ok=await GitDialog.confirm({
      action:GIT_ACT_PUBLISH,title:GIT_PUBLISH_TITLE,targets:[target],stages:1,
    });
    if(!ok) return;
    if(typeof again==='function'){again();return}
    this.run('push',Object.assign({},body||{},{publish:true}));
  }

  // FR-GIT-105: 거부 뒤의 후속 동작. force 는 확인 절차를 그대로 탄다.
  // K-f: 할 일은 서버가 준다 — 파괴적 확인(`confirm`)이 있으면 그 흐름을 거치고, 없으면
  // 그 잡을 시작한다. 모르는 확인은 실행하지 않는다 — 확인 없이 지나보내지 않는다.
  _fix(fix){
    if(this.router.why(fix.kind)) return;
    const body=Object.assign({},fix.body||{});
    if(fix.confirm){
      if(fix.confirm===GIT_ACT_FORCE_PUSH) this._forcePush(body.force);
      return;
    }
    this.run(fix.kind,body);
  }

  // FR-GIT-102: 취소는 부분 적용 가능성을 확인 문구에 명시한다.
  async cancel(){
    const job=this._job;
    if(!job||this._canceling) return;
    const ok=await GitDialog.confirm({
      action:GIT_ACT_JOB_CANCEL,title:GIT_JOB_CANCEL_TITLE,stages:1,
      targets:[job.kind?gitJobKindLabel(job.kind):''],
      // §6.3: 원격이 아닌 잡은 "원격에" 가 아니라 이 저장소에 일부가 남는다.
      hint:{note:(this.router&&this.router.touchesRemote(job))
        ?GIT_JOB_CANCEL_NOTE:GIT_JOB_CANCEL_NOTE_LOCAL,command:''},
    });
    if(!ok||!this._job||this._job.id!==job.id) return;
    this._canceling=true; this._paint();
    const res=await this._post(GIT_API.jobCancel,{id:job.id});
    if(res.ok) return;
    this._canceling=false;
    this._err=this._reason(res);
    this._paint();
  }

  // ── 작업 하나의 수명 ──

  _attach(job){
    if(!job||!job.id) return;
    this._closeStream();
    // 앞 job 을 기다리던 쪽이 있으면 **답 없이** 끝낸다 (`null`). 새 job 이
    // 붙었다는 것은 그 결과가 오지 않는다는 뜻이고, 매달린 채로 두면 호출자가
    // 영원히 판정하지 못한다.
    this._settleWaits(null);
    this._job=job;
    this._jobRepo=job.repo||this.panel.repo;
    // REPO_FIX 05 §3A-5: 잡 시작은 쓰기 세대 경계다.
    this.panel.bumpWrite();
    this._done=null; this._err=null; this._conflict=false;
    this._lines=[]; this._total=0; this._seq=0;
    this._logOpen=null;
    this._canceling=!!job.canceled; this._streamErr=false; this._retries=0;
    this._openStream();
    this._paint();
    // FR-SDA-22: 잡이 칸을 쥐었다 — 1층 답과 행 답이 바뀌었으므로 다시 받는다.
    this.panel.collect();
    this.panel.afterJobSlots();
  }

  /**
   * 출력 스트림 (FR-GIT-103). 끊기면 **마지막 seq 부터** 다시 잇는다 — 처음부터
   * 다시 받으면 이미 본 줄이 겹치고, 이어 받지 않으면 끊긴 구간이 빈다.
   */
  _openStream(){
    const job=this._job;
    if(!job||typeof EventSource==='undefined') return;
    const id=job.id;
    // 채널은 버스가 연다 (FR-BUS-7 · INV-2). 재시도는 이 클래스의 것이다 —
    // `_retries`·`GIT_JOB_RETRY_MS` 가 job 의 수명에 매여 있기 때문이다.
    const es=this.app.bus.openChannel('git-job',
      apiUrl(GIT_API.jobEvents,{id,after:this._seq}),
      {owner:this});
    if(!es) return;
    this._stream=es;
    es.addEventListener('line',ev=>{
      if(this._stream!==es) return;
      let ln=null; try{ln=JSON.parse(ev.data)}catch{ln=null}
      if(!ln) return;
      this._streamErr=false; this._retries=0;
      this._line(ln);
    });
    es.addEventListener('done',ev=>{
      if(this._stream!==es) return;
      let jb=null; try{jb=JSON.parse(ev.data)}catch{jb=null}
      this._closeStream();
      this._finish(jb||{id,done:true});
    });
    es.onerror=()=>{
      if(this._stream!==es) return;
      this._closeStream();
      if(this._retries>=GIT_JOB_RETRY_MAX){
        // 더 이을 수 없으면 끝난 것으로 다룬다 — 완료를 못 보고 영원히 "진행 중"
        // 으로 남는 것이 더 나쁘다.
        this._finish(Object.assign({},job,{done:true,err:GIT_JOB_STREAM_FAIL}));
        return;
      }
      this._retries++;
      this._streamErr=true; this._paint();
      TIMERS.after(GIT_JOB_RETRY_MS,()=>{
        if(this._job&&this._job.id===id&&!this._stream) this._openStream();
      },{owner:this,label:'job-retry'});
    };
  }

  _closeStream(){
    if(!this._stream) return;
    this._stream.close();
    this._stream=null;
  }

  _line(ln){
    // 재연결이 겹쳐 보낸 줄을 두 번 그리지 않는다.
    if(ln.seq!=null&&ln.seq<=this._seq) return;
    if(ln.seq!=null) this._seq=ln.seq;
    this._lines.push(ln);
    this._total++;
    const cap=gitJobLineCap();
    if(cap>0&&this._lines.length>cap) this._lines.splice(0,this._lines.length-cap);
    this._paint();
  }

  _finish(job){
    const jb=job||this._job||{};
    this._done=jb;
    this._job=null;
    // §3A-5: 잡 완료(성공·실패·취소·결과 미상)도 쓰기 세대 경계다.
    this.panel.bumpWrite();
    // BRANCH_MENU_UNIFY_SRS FR-BMU-15a: 결과를 기다리는 쪽에 넘긴다. `run()` 의
    // `ok` 는 "띄웠다" 까지이고 **끝났는가와 이겼는가는 여기서 정해진다.**
    this._settleWaits(jb);
    this._canceling=false;
    this._streamErr=false;
    // pull 의 결과는 status 를 봐야 안다. **collect 의 완료를 기다리지 않는다** —
    // single-flight 라 진행 중인 요청이 있으면 기다리지 않고 돌아오고, 그때의
    // status 는 아직 작업 전의 것이다.
    this._pending=(jb.kind==='pull')?{status:this.panel._status}:null;
    // §6.3: 충돌로 멈춘 잡은 실패로 끝나되 쓰기 이후 status 가 진행 중 작업을
    // 말한다 — "충돌 — 해결 후 계속" 이고 출구는 Changes 의 진행 중 노트다.
    const rs=jb.result&&jb.result.status;
    if((jb.exitCode||jb.err)&&rs&&rs.operation&&rs.operation.kind){
      this._conflict=true;
      this.panel.expandGroup('conflicts');
    }
    this.router.finished(jb);
    this._paint();
    // FR-GIT-107: 작업이 끝나면 ahead/behind 와 상태를 갱신한다 — 폴링 주기를
    // 기다리면 화면이 그만큼 거짓말을 한다.
    this.panel.collect();
    // FR-GVR-1: 원격 작업이 낡게 만드는 것은 status 만이 아니다 — History 의 refs,
    // Branches 의 ahead/behind, Console 의 기록이 함께 낡는다. **어느 뷰가 무엇에
    // 걸리는지는 패널이 안다** (D-1). collect 를 기다리지 않는다 (FR-GVR-5) —
    // 서로 독립이며 기다리면 화면이 그만큼 늦는다.
    this.panel.afterRemoteJob(jb.kind);
    this.panel.afterJobSlots();
    // F-9.4: 결과를 모르면 status 뿐 아니라 목록들(stash·refs)도 다시 받는다 — 무엇이
    // 일어났는지는 관측이 말한다. 성공 후처리(undo·draft 비우기)는 하지 않는다.
    if(gitJobOutcome(jb)==='unknown') this.panel._reloadViews();
  }

  /**
   * BRANCH_MENU_UNIFY_SRS FR-BMU-15a: **job 하나의 끝을 기다린다.**
   *
   * `run()` 이 돌려주는 `ok:true` 는 *"작업을 띄웠다"* 이고 실패 사유는 `done`
   * 이벤트가 가져온다 (이 파일 `run` 의 주석). 그 사이를 이어 주는 것이 이
   * 메서드다 — 띄운 쪽이 결과로 판정해야 하는 자리에서 쓴다.
   *
   * 이미 끝난 job 이면 곧바로 답한다. 다른 job 이 붙어 있으면 그 결과는 오지
   * 않으므로 `null` 이다 — 기다림이 끝나지 않는 것보다 모른다고 답하는 편이 낫다.
   *
   * **화면을 막지 않는다** (FR-BMU-15c). 진행은 job 표면이 이미 보이고 있고,
   * 이 기다림은 판정을 위한 것이다.
   */
  awaitJob(id){
    if(!id) return Promise.resolve(null);
    if(this._done&&this._done.id===id) return Promise.resolve(this._done);
    if(!this._job||this._job.id!==id) return Promise.resolve(null);
    if(!this._waits) this._waits=new Map();
    let w=this._waits.get(id);
    if(!w){
      let res=null;
      const p=new Promise(r=>{res=r});
      w={p,res};
      this._waits.set(id,w);
    }
    return w.p;
  }

  _settleWaits(jb){
    if(!this._waits||!this._waits.size) return;
    const ws=this._waits; this._waits=new Map();
    for(const [id,w] of ws) w.res(jb&&jb.id===id?jb:null);
  }

  // 관측이 하나 올 때마다 `GitPanel._applyStatus` 가 부른다 (FR-RPT-8). 화면을
  // 그리는지와 무관하게 판정이 돌아야 한다.
  notifyStatus(){
    if(this._pending) this._checkConflict();
  }

  // FR-GIT-111: 충돌이 남았으면 Changes 탭으로 보내고 충돌 그룹을 펼친다.
  // 해결 UI 는 제공하지 않는다.
  _checkConflict(){
    const p=this._pending;
    if(!p||this.panel._status===p.status) return;
    this._pending=null;
    const s=this.panel.statusOf();
    if(!s||!(s.conflicts||[]).length) return;
    this._conflict=true;
    this.panel.expandGroup('conflicts');
    this.panel.openView('changes');
  }

  /**
   * 작업 목록 폴링이 받은 진행 중 목록을 딛는다 (FR-GIT-101·101a).
   *
   * 작업은 서버에 있다 — 다른 브라우저 창이 띄운 것도 같은 리포를 막아야 하고,
   * 그것의 출력도 볼 수 있어야 한다.
   */
  adoptJobs(jobs){
    const mine=(jobs||[]).find(j=>this._isMine(j));
    if(mine){
      if(!this._job||this._job.id!==mine.id) this._attach(mine);
      return;
    }
    // 진행 중이 아닌데 스트림도 없으면 끝난 것이다 — 이유를 모른 채 "진행 중" 으로
    // 남겨 두지 않는다.
    if(this._job&&!this._stream&&!this._busy) this._finish(this._job);
  }

  _isMine(j){
    if(!j||!j.repo) return false;
    // M8 D-A-27: 서브모듈 갱신도 작업이지만 이 표면의 것이 아니다 — 그쪽 탭이 든다.
    // 어느 잡이 표시기의 것인지는 서버가 정한다(`indicator`, K-h).
    if(!j.indicator) return false;
    // §6.4: 잡은 첫 칸의 표시기에 붙는다 — pull(index·common)은 index 에.
    if(!j.slots||j.slots[0]!==this.slot) return false;
    if(j.repo===this.panel.repo) return true;
    const st=this.panel._status;
    return !!(st&&j.repo===st.repo);
  }

  // ── 거들기 ──

  /**
   * 원격 라우트는 `ok:true` 를 주지 않는다 — 작업 식별자가 곧 성공이다 (계약 §2.2).
   * GitPanel.post 의 ok 판정과 다르므로 여기서 따로 보낸다.
   */
  async _post(url,body){
    const r=await apiPost(url,body);
    return {ok:r.ok,code:r.status,data:r.data||{}};
  }

  _reason(res){
    const d=res.data||{};
    const base=GIT_WRITE_ERR[d.error]||GIT_JOB_START_FAIL;
    return d.message?(base+': '+d.message):base;
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitRemote=GitRemote;
