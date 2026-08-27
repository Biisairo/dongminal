/**
 * Dongminal — 원격 작업 (GIT_SRS §3B.1 / FR-GIT-98~112)
 *
 * Changes 탭 헤더의 Fetch / Pull / Push 를 살리고, 작업 하나의 수명을 화면에
 * 옮긴다. 뷰가 아니라 Changes 탭에 얹힌 조각이므로 자기 루트를 갖지 않는다 —
 * 골격은 GitPanel._buildChanges 가 세우고 여기서 칠하며 동작을 붙인다.
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
 */
class GitRemote {
  constructor(panel){
    this.panel=panel;
    this.app=panel.app;
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
    // FR-GIT-270: 진행 중인 sync. `{id, step, stopped}` 이며 두 단계가 끝난 뒤에도
    // 남는다 — 라벨과 "돌리지 않았다" 는 사실이 결과 화면에서도 읽혀야 한다.
    this._sync=null;
  }

  // ── 골격 ──

  // Changes 탭 골격이 세워진 직후 한 번. 리포가 사라져 골격을 버리면 다시 불린다.
  bind(el){
    if(!el) return;
    this._addButtons(el);
    for(const b of el.querySelectorAll('.git-remote-btn'))
      b.addEventListener('click',()=>this._click(b.dataset.remote));
    for(const b of el.querySelectorAll('.git-remote-more'))
      b.addEventListener('click',()=>this._opts(b.dataset.remote));
    const sync=el.querySelector('.git-remote-sync');
    if(sync) sync.addEventListener('click',()=>this.sync());
    const prev=el.querySelector('.git-push-preview');
    if(prev) prev.addEventListener('click',()=>this.preview());
    const box=el.querySelector('.git-job'); if(!box) return;
    box.querySelector('.git-job-cancel').addEventListener('click',()=>this.cancel());
    box.querySelector('.git-job-copy').addEventListener('click',()=>this._copyLog());
    // FR-GIT-221: 접힌 로그는 사라진 것이 아니다 — 바를 누르면 다시 펼쳐진다.
    // 바 안의 버튼은 자기 일을 한다.
    box.querySelector('.git-job-bar').addEventListener('click',ev=>{
      if(ev.target.closest('button')) return;
      this._logOpen=this._logCollapsed();
      this._paint();
    });
    box.querySelector('.git-job-close').addEventListener('click',()=>{
      this._done=null; this._err=null; this._conflict=false;
      this._lines=[]; this._total=0; this._sync=null;
      this._paint();
    });
    box.querySelector('.git-job-auth-copy').addEventListener('click',()=>
      this.panel.copyText(this._termCmd(this._done||{})));
  }

  /**
   * Sync 와 Push preview 의 버튼 (FR-GIT-270·271).
   *
   * **`.git-head-remote` 밖에 둔다** — 안에 넣으면 "원격 버튼 한 벌은 세 쌍" 이라는
   * 기존 단정이 깨진다 (FR-GIT-238 의 새로고침과 같은 이유). 골격을 세우는 것은
   * `GitPanel._buildChanges` 지만 이 둘은 이 파일의 동작이므로 여기서 붙인다.
   */
  _addButtons(el){
    const head=el.querySelector('.git-head');
    const host=head&&head.querySelector('.git-head-remote');
    if(!host||head.querySelector('.git-remote-sync')) return;
    for(const d of [
      {cls:'git-remote-sync',label:GIT_SYNC_LABEL,title:GIT_SYNC_TITLE},
      {cls:'git-push-preview',label:GIT_PP_LABEL,title:GIT_PP_BTN_TITLE},
    ]){
      const b=document.createElement('button');
      b.type='button'; b.className=d.cls; b.textContent=d.label; b.title=d.title;
      b.disabled=true;
      head.insertBefore(b,host);
    }
  }

  // 리포가 바뀌면 붙어 있던 작업을 놓는다 (FR-GIT-16). 작업은 서버에서 계속 돌고
  // 상태바가 그것을 계속 보인다 (FR-GIT-112) — 화면만 새 리포의 것으로 되돌린다.
  detachRepo(){
    this._closeStream();
    this._job=null; this._jobRepo=null; this._done=null; this._err=null;
    this._logOpen=null;
    this._conflict=false; this._busy=false; this._canceling=false;
    this._lines=[]; this._total=0; this._seq=0;
    this._pending=null;
    this._sync=null;
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
    this._paintButtons(el);
    this._paintJob(el);
  }

  // 진행 중이면 **같은 리포의 원격 버튼 전부**가 막힌다 (FR-GIT-101).
  busy(){return !!(this._job||this._busy)}

  _paint(){
    const el=this.panel._els.get('changes');
    if(el&&el.dataset.built==='1') this.paint(el);
  }

  _why(){
    if(!this.panel.repo||!this.panel.statusOf()) return GIT_REMOTE_WHY_NO_STATUS;
    return this.busy()?GIT_REMOTE_WHY_BUSY:'';
  }

  _paintButtons(el){
    const why=this._why();
    for(const b of el.querySelectorAll('.git-remote-btn')){
      b.disabled=!!why;
      b.title=why||(GIT_REMOTE_TITLE[b.dataset.remote]||'');
    }
    for(const b of el.querySelectorAll('.git-remote-more')){
      b.disabled=!!why;
      b.title=why||GIT_REMOTE_MORE_TITLE;
    }
    // Sync·Preview 도 같은 사유로 막힌다 (FR-GIT-101) — 진행 중에는 같은 리포의
    // 원격 동작 전부가 막힌다.
    for(const d of [
      {cls:'.git-remote-sync',title:GIT_SYNC_TITLE},
      {cls:'.git-push-preview',title:GIT_PP_BTN_TITLE},
    ]){
      const b=el.querySelector(d.cls);
      if(!b) continue;
      b.disabled=!!why;
      b.title=why||d.title;
    }
  }

  _paintJob(el){
    const box=el.querySelector('.git-job'); if(!box) return;
    const cur=this._job||this._done;
    const vis=!!(cur||this._busy||this._err);
    box.classList.toggle('vis',vis);
    if(!vis){box.dataset.kind='';return}
    const j=cur||{};
    box.dataset.kind=j.kind||'';
    box.dataset.job=j.id||'';
    // Sync 중이면 단계를 라벨이 말한다 (FR-GIT-270) — 무엇이 도는지 모르면
    // 사용자는 두 단계가 묶였다는 것을 알 수 없다.
    box.querySelector('.git-job-kind').textContent=
      (this._sync&&GIT_SYNC_STEP_LABEL[j.kind])||GIT_REMOTE_LABEL[j.kind]||'';
    // argv 를 그대로 보인다 — 다이얼로그의 선택이 반영됐는지 여기서 확인된다.
    const argv=(j.argv||[]).join(' ');
    const cmd=box.querySelector('.git-job-argv');
    cmd.textContent=argv?('git '+argv):'';
    cmd.title=cmd.textContent;
    box.querySelector('.git-job-state').textContent=this._state();
    const cancel=box.querySelector('.git-job-cancel');
    cancel.classList.toggle('vis',!!this._job);
    cancel.disabled=this._canceling;
    const close=box.querySelector('.git-job-close');
    close.classList.toggle('vis',!this._job&&!this._busy);
    // FR-GIT-270: **뒤를 돌리지 않았다**는 사실은 사유와 함께 이 자리에 남는다.
    // 조용히 끝내면 사용자는 push 가 돈 줄 안다.
    const note=box.querySelector('.git-job-note');
    const msg=this._conflict?GIT_JOB_CONFLICT_NOTE:((this._sync&&this._sync.stopped)||'');
    note.textContent=msg;
    note.classList.toggle('vis',!!msg);
    box.classList.toggle('log-collapsed',this._logCollapsed());
    this._paintFail(box);
    this._paintLog(box);
  }

  /**
   * FR-GIT-221: 성공으로 끝난 작업만 접는다.
   *
   * 진행 중이면 접지 않는다 — 출력이 진행 상황이다 (FR-GIT-103). 실패·취소·충돌도
   * 접지 않는다 — 사유·stderr tail·후속 선택지가 사용자가 그 화면을 보는 이유다.
   * 사용자가 바를 눌렀으면 그 뜻이 결과보다 앞선다.
   */
  _logCollapsed(){
    if(this._logOpen!=null) return !this._logOpen;
    if(this._job||this._busy) return false;
    const d=this._done;
    if(!d||this._err||this._conflict) return false;
    // Sync 가 뒤를 돌리지 않았으면 사유가 사용자가 이 화면을 보는 이유다.
    if(this._sync&&this._sync.stopped) return false;
    return !d.canceled&&!d.exitCode&&!d.err;
  }

  _state(){
    if(this._job)
      return this._canceling?GIT_JOB_CANCELING
        :(this._streamErr?GIT_JOB_STREAM_FAIL:GIT_JOB_RUNNING);
    if(this._busy) return GIT_JOB_RUNNING;
    const d=this._done;
    if(!d) return this._err?GIT_JOB_FAIL:'';
    if(d.canceled) return GIT_JOB_CANCELED;
    return (d.exitCode||d.err)?GIT_JOB_FAIL:GIT_JOB_OK;
  }

  // 실패 사유·stderr tail·인증 안내·후속 선택지 (FR-GIT-104·105·108).
  _paintFail(box){
    const d=this._done||{};
    const failed=!!(d.exitCode||d.err||d.canceled||this._err);
    const fail=box.querySelector('.git-job-fail');
    fail.classList.toggle('vis',failed);
    fail.querySelector('.git-job-reason').textContent=this._err||d.err||'';
    fail.querySelector('.git-job-tail').textContent=d.stderrTail||'';
    // FR-GIT-104: 안내만 한다. 받는 자리를 만들지 않는다.
    const auth=fail.querySelector('.git-job-auth');
    auth.classList.toggle('vis',!!d.authRequired);
    auth.querySelector('.git-job-auth-note').textContent=GIT_JOB_AUTH_NOTE;
    auth.querySelector('.git-job-auth-cmd').textContent=this._termCmd(d);
    // FR-GIT-105: 서버가 준 순서 그대로다. 다시 그리는 것은 목록이 바뀔 때뿐이다.
    const opts=fail.querySelector('.git-job-opts');
    const list=(d.rejected&&Array.isArray(d.options))?d.options:[];
    const key=list.join(' ');
    if(opts.dataset.opts===key) return;
    opts.dataset.opts=key;
    opts.innerHTML='';
    opts.classList.toggle('vis',!!list.length);
    if(!list.length) return;
    const n=document.createElement('div');
    n.className='git-job-opts-note'; n.textContent=GIT_JOB_REJECT_NOTE;
    opts.appendChild(n);
    for(const fix of list){
      const b=document.createElement('button');
      // 클래스가 하나뿐인 것이 요구사항이다 — force 를 눈에 띄게 만들지 않는다.
      b.className='git-job-opt'; b.dataset.fix=fix; b.type='button';
      b.textContent=GIT_JOB_FIX_LABEL[fix]||fix;
      b.addEventListener('click',()=>this._fix(fix));
      opts.appendChild(b);
    }
  }

  /**
   * 출력은 줄 단위로 붙인다 (FR-GIT-103).
   *
   * 이미 그린 줄을 다시 만들지 않는다 — 진행 표시는 초당 수십 줄이 오고, 매번
   * 목록을 다시 그리면 그것만으로 프레임을 잃는다. `data-total` 이 어디까지
   * 그렸는지의 기준이며 보존 상한을 넘겨 앞에서 버린 줄과 어긋나지 않는다.
   *
   * 진행 표시는 stderr 로 오지만 그것은 오류가 아니다 — 스트림을 속성으로만
   * 남기고 색으로 구분하지 않는다.
   */
  _paintLog(box){
    const log=box.querySelector('.git-job-log');
    const key=((this._job||this._done||{}).id)||'';
    if(log.dataset.job!==key){
      log.dataset.job=key; log.dataset.total='0'; log.innerHTML='';
    }
    const drawn=parseInt(log.dataset.total||'0',10)||0;
    let pending=this._total-drawn;
    if(pending<=0) return;
    if(pending>this._lines.length) pending=this._lines.length;
    const frag=document.createDocumentFragment();
    for(let i=this._lines.length-pending;i<this._lines.length;i++){
      const ln=this._lines[i];
      const d=document.createElement('div');
      d.className='git-job-line';
      d.dataset.seq=String(ln.seq||0);
      d.dataset.stream=ln.stream||'';
      d.textContent=ln.text||'';
      frag.appendChild(d);
    }
    log.appendChild(frag);
    log.dataset.total=String(this._total);
    while(log.childElementCount>GIT_JOB_LINE_CAP) log.removeChild(log.firstElementChild);
    log.scrollTop=log.scrollHeight;
  }

  // ── 버튼 (FR-GIT-98·99) ──

  // 버튼은 기본 동작만 한다. 변형은 `▾` 에서만 온다.
  _click(kind){
    if(!GIT_REMOTE_LABEL[kind]) return;
    if(kind==='push'){this._push('');return}
    this.run(kind,{});
  }

  _opts(kind){
    if(this.busy()||!GIT_REMOTE_DIALOGS[kind]) return;
    new GitRemoteOpts(this,kind)._show();
  }

  // ── 실행 ──

  /**
   * 작업 하나를 띄운다. 응답은 작업 식별자이고 그것으로 SSE 에 붙는다.
   *
   * 실패 사유는 여기에 없다 — 작업이 아직 끝나지 않았으므로 즉시 응답에 담길
   * 값이 없고, `done` 이벤트가 그것을 가져온다 (계약 §2.3.1 ②).
   */
  async run(kind,body){
    if(this.busy()) return {ok:false,code:0,data:{}};
    const repo=this.panel.repo;
    if(!repo) return {ok:false,code:0,data:{}};
    this._busy=true; this._err=null; this._done=null; this._conflict=false;
    this._logOpen=null; this._sync=null;
    this._paint();
    // 라우트는 kind 에서 파생한다. 기본 규칙(`/api/git/<kind>`)과 다른 것만
    // GIT_REMOTE_URL 에 있다 — 태그 push·원격 삭제가 그것이며(FR-GIT-262), 그것들도
    // **같은 job 경로**를 타야 하므로 새 실행 경로를 만들지 않는다.
    const res=await this._post(GIT_REMOTE_URL[kind]||('/api/git/'+kind),
      Object.assign({repo},body||{}));
    this._busy=false;
    const job=res.data&&res.data.job;
    if(res.ok&&job&&job.id){this._attach(job);return res}
    // Publish 는 서버가 실행 **전에** 되묻는다 (FR-GIT-100, 계약 §2.3.1 ①).
    if(kind==='push'&&res.data&&res.data.error==='publish_required'){
      this._paint();
      this._publish(res.data.plan||{},body);
      return res;
    }
    this._err=this._reason(res);
    this._paint();
    return res;
  }

  /**
   * Push 는 세 갈래다: 기본 / Publish / force.
   *
   * force 는 `--force-with-lease` 가 기본이고 `--force` 도 같은 2단계 확인을
   * 거친다 (FR-GIT-106) — 이름이 서버의 파괴적 목록에 있으므로 단계 수를 이쪽에서
   * 정하지 않는다.
   */
  _push(force){
    if(!force){this.run('push',{});return}
    this._forcePush(force);
  }

  /**
   * force 는 대상을 함께 받을 수 있다 (FR-GIT-271) — Push preview 가 고른
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
   * `again` 이 있으면 확인 뒤 그것을 부른다 — Sync 도 같은 되물음을 받으므로
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

  // ── Sync (FR-GIT-270) ──

  /**
   * pull 후 push 를 한 진입점으로 묶는다.
   *
   * **순서를 지키는 것은 서버다** — 두 단계를 클라이언트가 이어 붙이면 창을 닫는
   * 순간 순서가 사라지고, API 직접 호출은 애초에 그 순서를 모른다. 여기서는 첫
   * 단계에 붙고, 두 번째 단계의 식별자를 서버에게 물어 다시 붙을 뿐이다.
   */
  sync(){return this._syncStart({})}

  async _syncStart(body){
    if(this.busy()) return {ok:false,code:0,data:{}};
    const repo=this.panel.repo;
    if(!repo) return {ok:false,code:0,data:{}};
    this._busy=true; this._err=null; this._done=null; this._conflict=false;
    this._logOpen=null; this._sync=null;
    this._paint();
    const res=await this._post('/api/git/sync',Object.assign({repo},body||{}));
    this._busy=false;
    const d=res.data||{};
    const job=d.job, sync=d.sync;
    if(res.ok&&job&&job.id&&sync&&sync.id){
      this._attach(job);
      this._sync={id:sync.id,step:sync.step||'pull',stopped:''};
      this._paint();
      return res;
    }
    // Publish 는 서버가 **첫 단계를 돌리기 전에** 되묻는다 (FR-GIT-100).
    if(d.error==='publish_required'){
      this._paint();
      this._publish(d.plan||{},null,()=>this._syncStart(Object.assign({},body||{},{publish:true})));
      return res;
    }
    this._err=this._reason(res)||GIT_SYNC_START_FAIL;
    this._paint();
    return res;
  }

  /**
   * 첫 단계가 끝났다. 두 번째 단계의 식별자를 서버에게 묻는다.
   *
   * **돌릴지 말지를 여기서 정하지 않는다** (V197) — 서버가 이미 정했고, 우리는 그
   * 결과(두 번째 작업이 있는가, 없다면 왜)를 읽어 보일 뿐이다.
   */
  async _syncNext(){
    const sync=this._sync;
    if(!sync||!sync.id||sync.step!=='pull'||sync.stopped) return;
    for(let i=0;i<GIT_SYNC_POLL_MAX;i++){
      const r=await this._get('/api/git/sync?id='+encodeURIComponent(sync.id));
      if(this._sync!==sync) return;
      const d=r.data||{};
      if(!r.ok){sync.stopped=this._reason(r);this._paint();return}
      if(d.pushJob){
        sync.step='push';
        // 상태바 폴링(adoptJobs)이 먼저 붙였을 수 있다 — 그때 다시 붙이면 이미 받은
        // 줄을 버리고 처음부터 다시 잇는다.
        if(!this._job||this._job.id!==d.pushJob)
          this._attach({id:d.pushJob,kind:'push',repo:d.repo||this._jobRepo,argv:d.pushArgv||[]});
        this._sync=sync;
        this._paint();
        return;
      }
      if(d.done){
        sync.stopped=d.reason||GIT_SYNC_STOPPED;
        this._paint();
        return;
      }
      await gitWait(GIT_SYNC_POLL_MS);
    }
    sync.stopped=GIT_SYNC_STOPPED;
    this._paint();
  }

  // ── Push preview (FR-GIT-271) ──

  /**
   * 밀기 전에 올라갈 커밋을 보인다.
   *
   * 목록은 서버가 `log <upstream>..<branch>` 로 준다 — **새 조회를 만들지
   * 않았다**. 다이얼로그는 그것을 보이고 대상과 force 를 받을 뿐이다.
   */
  async preview(){
    if(this.busy()) return;
    const repo=this.panel.repo;
    if(!repo) return;
    const r=await this._get('/api/git/push/preview?repo='+encodeURIComponent(repo));
    if(!r.ok){
      this._err=this._reason(r)||GIT_PP_FAIL;
      this._paint();
      return;
    }
    new GitPushPreview(this,r.data||{})._show();
  }

  // FR-GIT-105: 거부 뒤의 후속 동작. force 는 확인 절차를 그대로 탄다.
  _fix(fix){
    if(this.busy()) return;
    if(fix===GIT_JOB_FIX_REBASE){this.run('pull',{mode:'rebase'});return}
    if(fix===GIT_JOB_FIX_MERGE){this.run('pull',{mode:''});return}
    if(fix===GIT_JOB_FIX_LEASE){this._forcePush('lease');return}
  }

  // FR-GIT-102: 취소는 부분 적용 가능성을 확인 문구에 명시한다.
  async cancel(){
    const job=this._job;
    if(!job||this._canceling) return;
    const ok=await GitDialog.confirm({
      action:GIT_ACT_JOB_CANCEL,title:GIT_JOB_CANCEL_TITLE,stages:1,
      targets:[(GIT_REMOTE_LABEL[job.kind]||job.kind||'')],
      hint:{note:GIT_JOB_CANCEL_NOTE,command:''},
    });
    if(!ok||!this._job||this._job.id!==job.id) return;
    this._canceling=true; this._paint();
    const res=await this._post('/api/git/job/cancel',{id:job.id});
    if(res.ok) return;
    this._canceling=false;
    this._err=this._reason(res);
    this._paint();
  }

  // ── 작업 하나의 수명 ──

  _attach(job){
    if(!job||!job.id) return;
    this._closeStream();
    this._job=job;
    this._jobRepo=job.repo||this.panel.repo;
    this._done=null; this._err=null; this._conflict=false;
    this._lines=[]; this._total=0; this._seq=0;
    this._logOpen=null;
    this._canceling=!!job.canceled; this._streamErr=false; this._retries=0;
    this._openStream();
    // 상태바는 폴링 주기를 기다리지 않는다 (FR-GIT-112).
    this.app._gitJobSeen(job);
    this._paint();
  }

  /**
   * 출력 스트림 (FR-GIT-103). 끊기면 **마지막 seq 부터** 다시 잇는다 — 처음부터
   * 다시 받으면 이미 본 줄이 겹치고, 이어 받지 않으면 끊긴 구간이 빈다.
   */
  _openStream(){
    const job=this._job;
    if(!job||typeof EventSource==='undefined') return;
    const id=job.id;
    const es=new EventSource('/api/git/job/events?id='+encodeURIComponent(id)+
      '&after='+this._seq);
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
      setTimeout(()=>{
        if(this._job&&this._job.id===id&&!this._stream) this._openStream();
      },GIT_JOB_RETRY_MS);
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
    if(this._lines.length>GIT_JOB_LINE_CAP)
      this._lines.splice(0,this._lines.length-GIT_JOB_LINE_CAP);
    this._paint();
  }

  _finish(job){
    const jb=job||this._job||{};
    this._done=jb;
    this._job=null;
    this._canceling=false;
    this._streamErr=false;
    // pull 의 결과는 status 를 봐야 안다. **collect 의 완료를 기다리지 않는다** —
    // single-flight 라 진행 중인 요청이 있으면 기다리지 않고 돌아오고, 그때의
    // status 는 아직 작업 전의 것이다.
    this._pending=(jb.kind==='pull')?{status:this.panel._status}:null;
    this._paint();
    this.app._gitJobEnded(jb.id);
    // FR-GIT-107: 작업이 끝나면 ahead/behind 와 상태를 갱신한다 — 폴링 주기를
    // 기다리면 화면이 그만큼 거짓말을 한다.
    this.panel.collect();
    // FR-GIT-270: 첫 단계가 끝났다면 두 번째 단계를 서버에게 묻는다.
    this._syncNext();
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
   * 상태바 폴링이 받은 진행 중 목록을 딛는다 (FR-GIT-101·112).
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
    let r=null,d=null;
    try{
      r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body)});
    }catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    return {ok:!!(r&&r.ok),code:r?r.status:0,data:d||{}};
  }

  // 읽기 쪽도 같은 모양으로 답한다 — 두 왕복의 결과 해석이 갈리면 실패 사유가
  // 두 벌이 된다.
  async _get(url){
    let r=null,d=null;
    try{r=await fetch(url)}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    return {ok:!!(r&&r.ok),code:r?r.status:0,data:d||{}};
  }

  _reason(res){
    const d=res.data||{};
    const base=GIT_WRITE_ERR[d.error]||GIT_JOB_START_FAIL;
    return d.message?(base+': '+d.message):base;
  }

  /**
   * 터미널에 붙여 그대로 실행할 명령 (FR-GIT-104).
   *
   * 실제로 실행된 argv 를 쓴다 — 우리가 새로 조립하면 사용자가 터미널에서 하는
   * 것이 화면이 말한 것과 달라진다. `--progress` 만 뺀다: tty 에서는 필요 없다.
   */
  _termCmd(d){
    const repo=this._jobRepo||this.panel.repo||'';
    const argv=(d.argv||[]).filter(a=>a!==GIT_PROGRESS_FLAG);
    return 'git -C '+gitShQuote(repo)+(argv.length?(' '+argv.join(' ')):'');
  }

  // FR-GIT-108·96: 실패 사유를 복사할 수 있어야 한다. 출력 전체가 그 사유다.
  _copyLog(){
    const text=this._lines.map(l=>l.text||'').join('\n');
    const tail=(this._done&&this._done.stderrTail)||'';
    this.panel.copyText(text||tail);
  }
}

/**
 * `▾` 옵션 다이얼로그 (FR-GIT-109·110, 검증 V62).
 *
 * 골격은 20단계의 `GitDialog` 다 (FR-GIT-171) — 필드 정의는 GIT_REMOTE_DIALOGS 에
 * 있고 fetch·pull·push 가 같은 골격을 쓰므로 다이얼로그마다 코드를 복제하지 않는다.
 * **첫 선택지가 기본이고 그것이 안전한 쪽이다** (FR-GIT-97·173).
 *
 * 여기 만드는 입력은 체크박스와 라디오뿐이다 — 자격증명을 받는 자리는 없다
 * (FR-GIT-104).
 */
class GitRemoteOpts {
  constructor(remote,kind){
    this.remote=remote;
    this.kind=kind;
    this.def=GIT_REMOTE_DIALOGS[kind];
  }

  _show(){
    return GitDialog.open({
      id:'git-remote-opts',ns:'gro',action:this.kind,
      title:this.def.title,runLabel:this.def.run,fields:this.def.fields,
      // 작업 하나의 수명은 패널의 `.git-job` 이 보인다 (FR-GIT-102·103) — 진행
      // 출력·취소·실패 사유가 거기 있으므로 다이얼로그는 시작만 하고 물러난다.
      run:v=>{this._start(this._body(v));return {ok:true}},
    });
  }

  // 값의 이름은 API 그대로다 (계약 §2.2). tags 는 3상태이므로 null|true|false 로
  // 옮긴다 — null 이면 저장소의 tagOpt 설정을 우리가 덮지 않는다.
  _body(v){
    if(this.kind==='fetch')
      return {prune:!!v.prune,tags:v.tags===''?null:v.tags==='yes'};
    if(this.kind==='pull') return {mode:v.mode||''};
    return {force:v.force||''};
  }

  _start(body){
    if(this.kind==='push'){this.remote._push(body.force);return}
    this.remote.run(this.kind,body);
  }
}

// gitWait 은 폴링 사이의 쉼이다. 간격을 호출 지점마다 적으면 상한이 상한이
// 아니게 된다 (GIT_SYNC_POLL_MS).
function gitWait(ms){return new Promise(r=>setTimeout(r,ms))}

/**
 * Push 미리보기 다이얼로그 (FR-GIT-271, 검증 V198).
 *
 * 골격은 `GitDialog` 다 (FR-GIT-171). 이 클래스가 아는 것은 셋뿐이다:
 * 올라갈 커밋을 본문으로 보이는 것, 대상 remote/branch 를 받는 것,
 * force-with-lease 를 그 자리에서 켜는 것.
 *
 * **force 의 확인 절차를 여기서 구현하지 않는다** — `force_push` 는 서버의 파괴적
 * 목록에 있고 `GitRemote._forcePush` 가 그 규약을 이미 탄다 (FR-GIT-106·172).
 *
 * 원격 목록은 라디오다 — 첫 선택지가 기본이고 그것은 **지금의 대상**이다
 * (FR-GIT-173). 자유 입력으로 두면 오타가 새 원격을 만드는 것처럼 보인다.
 */
class GitPushPreview {
  constructor(remote,d){
    this.remote=remote;
    this.d=d||{};
  }

  _show(){
    const d=this.d;
    return GitDialog.open({
      id:'git-push-preview',ns:'gpp',action:'push_preview',
      title:GIT_PP_TITLE,runLabel:GIT_PP_RUN,body:this._body(),
      fields:[
        {key:'remote',type:GIT_DIALOG_RADIO,label:GIT_PP_REMOTE_LABEL,opts:this._remoteOpts()},
        {key:'branch',type:GIT_DIALOG_TEXT,cls:'gpp-branch',label:GIT_PP_BRANCH_LABEL,
         value:d.branch||''},
        // 기본은 꺼짐이고 그것이 안전한 쪽이다 (FR-GIT-97·173).
        {key:'lease',type:GIT_DIALOG_CHECK,label:GIT_PP_LEASE},
        // upstream 이 이미 있으면 설정할 것이 없다 — 뜻 없는 옵션을 보이지 않는다.
        {key:'publish',type:GIT_DIALOG_CHECK,label:GIT_PP_UPSTREAM,hidden:!d.publish},
      ],
      validate:v=>((v.branch||'').trim()?'':GIT_PP_WHY_BRANCH),
      run:v=>this._run(v),
    });
  }

  // 지금의 대상이 첫 선택지다. 목록에 없으면(설정만 있고 이름이 다른 경우) 그것을
  // 앞에 세운다 — 고를 수 없는 대상으로 다이얼로그를 열면 아무것도 못 한다.
  _remoteOpts(){
    const cur=this.d.remote||'';
    const list=Array.isArray(this.d.remotes)?this.d.remotes.slice():[];
    const opts=list.map(r=>({v:r.name,label:r.name+(r.url?' — '+r.url:'')}));
    const i=opts.findIndex(o=>o.v===cur);
    if(i>0) opts.unshift(opts.splice(i,1)[0]);
    if(i<0&&cur) opts.unshift({v:cur,label:cur});
    return opts;
  }

  /**
   * 본문은 올라갈 커밋이다. 개수를 먼저 말한다 — 목록만 보이면 사용자가 세야 한다.
   *
   * publish 면 범위가 없다 (원격에 그 브랜치가 없다). 그 사실을 먼저 말하지 않으면
   * 사용자는 목록을 "밀리지 않은 것"으로 읽는다.
   */
  _body(){
    const c=Array.isArray(this.d.commits)?this.d.commits:[];
    const head=[];
    if(this.d.publish) head.push(GIT_PP_PUBLISH_NOTE);
    head.push(c.length?(GIT_PP_COUNT_PREFIX+c.length+GIT_PP_COUNT_SUFFIX):GIT_PP_NONE);
    for(const x of c) head.push((x.abbrev||'')+' '+(x.subject||''));
    return head.join('\n');
  }

  _run(v){
    const body={
      remote:(v.remote||'').trim(),
      branch:(v.branch||'').trim(),
      publish:!!v.publish,
    };
    // 작업 하나의 수명은 패널의 `.git-job` 이 보인다 — 다이얼로그는 시작만 하고
    // 물러난다 (GitRemoteOpts 와 같은 규약).
    if(v.lease) this.remote._forcePush(GIT_PUSH_FORCE_LEASE,body);
    else this.remote.run('push',body);
    return {ok:true};
  }
}

/**
 * Branches 탭의 원격 목록 (FR-GIT-269, 검증 V196).
 *
 * **Branches 탭에 얹힌 조각이므로 자기 루트를 갖지 않는다** — 골격 자리는
 * `GitBranches.mount` 가 내주고 여기서 채운다 (GitRemote 와 같은 규약).
 *
 * 목록은 `/api/git/remotes` 이고 URL 은 **서버가 자격증명을 지운 값**이다
 * (FR-GIT-104) — 여기서 다시 가리지 않는다.
 *
 * remove 는 파괴적이 아니다. 그래서 1단계 확인이고, 그럼에도 되살릴
 * `git remote add <name> <url>` 을 확인 화면에 보인다 (FR-GIT-92).
 */
class GitRemoteList {
  constructor(panel){
    this.panel=panel;
    this._el=null;
    this._repo=undefined;
    this._items=[];
    this._err=null;
    this._loading=false;
  }

  mount(el){
    if(!el) return;
    this._el=el;
    el.innerHTML=
      '<div class="git-rm-head">'+
        '<span class="git-rm-title"></span>'+
        '<span class="git-rm-count"></span>'+
        '<span class="git-rm-spacer"></span>'+
        '<button class="git-rm-add" type="button"></button>'+
      '</div>'+
      '<div class="git-rm-note"></div>'+
      '<div class="git-rm-rows"></div>';
    el.querySelector('.git-rm-title').textContent=GIT_RM_TITLE;
    const add=el.querySelector('.git-rm-add');
    add.textContent=GIT_RM_ADD; add.title=GIT_RM_ADD_TITLE;
    add.addEventListener('click',()=>this.add());
    this._repo=undefined;
  }

  unmount(){this._el=null;this._repo=undefined}

  paint(){
    if(!this._el) return;
    if(this.panel.repo!==this._repo) this._adopt();
    if(!this._el) return;
    const note=this._el.querySelector('.git-rm-note');
    note.textContent=this._err||'';
    note.classList.toggle('vis',!!this._err);
    this._el.querySelector('.git-rm-count').textContent='('+this._items.length+')';
    this._el.querySelector('.git-rm-add').disabled=!this._repo;
    this._paintRows();
  }

  reload(){return this._load()}

  _adopt(){
    this._repo=this.panel.repo;
    this._items=[]; this._err=null;
    if(this._repo) this._load();
  }

  _paintRows(){
    const box=this._el.querySelector('.git-rm-rows');
    box.innerHTML='';
    if(!this._items.length){
      // 빈 목록은 사실을 알린다 — 빈 화면은 실패와 구분되지 않는다.
      const d=document.createElement('div');
      d.className='git-rm-empty';
      d.textContent=(this._loading&&this._repo)?GIT_HIST_LOADING:GIT_RM_EMPTY;
      box.appendChild(d);
      return;
    }
    for(const r of this._items) box.appendChild(this._rowEl(r));
  }

  _rowEl(r){
    const d=document.createElement('div');
    d.className='git-rm-row'; d.dataset.remote=r.name||'';
    const nm=document.createElement('span');
    nm.className='git-rm-name'; nm.textContent=r.name||'';
    d.appendChild(nm);
    const url=document.createElement('span');
    url.className='git-rm-url';
    url.textContent=(r.url||'')+(r.pushUrl?(' '+GIT_RM_PUSH_PREFIX+r.pushUrl):'');
    // 가려진 자리가 있으면 그 사실을 말한다 — 없으면 URL 이 그렇게 저장돼
    // 있다고 읽힌다.
    url.title=url.textContent.includes(GIT_RM_MASK)?GIT_RM_MASK_TITLE:url.textContent;
    d.appendChild(url);
    const rm=document.createElement('button');
    rm.type='button'; rm.className='git-rm-del';
    rm.textContent=GIT_RM_REMOVE; rm.title=GIT_RM_REMOVE_TITLE;
    rm.addEventListener('click',()=>this.remove(r));
    d.appendChild(rm);
    return d;
  }

  add(){
    if(!this.panel.repo) return;
    return new GitRemoteAdd(this)._show();
  }

  async remove(r){
    const repo=this.panel.repo;
    if(!repo||!r||!r.name) return;
    const ok=await GitDialog.confirm({
      action:GIT_ACT_REMOTE_REMOVE,title:GIT_RM_REMOVE_CONFIRM_TITLE,
      targets:[r.name],stages:1,
      hint:{note:GIT_RM_REMOVE_NOTE,
        command:'git -C '+gitShQuote(repo)+' remote add '+r.name+' '+(r.url||'')},
    });
    if(!ok) return;
    const res=await this.panel.post('/api/git/remote/remove',{repo,name:r.name});
    if(!this.adoptWrite(res)) this._fail(GIT_RM_REMOVE_FAIL,res);
  }

  /**
   * 쓰기 하나의 뒷정리. **응답이 실은 목록을 그대로 쓴다** — 폴링 주기를 기다리면
   * 화면이 그만큼 거짓말을 한다 (FR-GIT-71).
   */
  adoptWrite(res){
    const d=(res&&res.data)||{};
    if(!res||!res.ok) return false;
    if(d.status) this.panel.adopt(d);
    if(Array.isArray(d.remotes)) this._items=d.remotes;
    this._err=null;
    this.paint();
    return true;
  }

  // 사유를 보이고 **이미 받은 목록을 지우지 않는다** (FR-GIT-132 과 같은 규약).
  _fail(base,res){
    this._err=base+': '+this.panel.writeReason(res);
    this.paint();
  }

  async _load(){
    const repo=this._repo;
    if(!repo) return;
    const tok=this.panel.token();
    this._loading=true;
    let r=null,d=null;
    try{r=await fetch('/api/git/remotes?repo='+encodeURIComponent(repo))}catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    if(this.panel.isStale(tok)) return;
    this._loading=false;
    if(!d||!d.requested||d.requested.repo!==repo){
      this._err=GIT_RM_LOAD_FAIL;
      this.paint();
      return;
    }
    this._err=null;
    this._items=Array.isArray(d.remotes)?d.remotes:[];
    this.paint();
  }
}

/**
 * 원격 생성 다이얼로그 (FR-GIT-269).
 *
 * **URL 을 받는 자리는 자격증명을 받는 자리가 아니다** (FR-GIT-104). 여기서 받는
 * 것은 `git remote add` 의 두 번째 인자이며 git 이 저장소 설정에 그대로 적는 값이다
 * — dongminal 은 그것을 보관하지도, 인증에 쓰지도 않고, 밖으로 나갈 때는 서버가
 * 자격증명 자리를 지운다. 비밀을 따로 묻는 입력은 만들지 않는다.
 */
class GitRemoteAdd {
  constructor(list){
    this.list=list;
    this.panel=list.panel;
    this.repo=list.panel.repo;
  }

  _show(){
    return GitDialog.open({
      id:'git-remote-add',ns:'gra',action:'remote_add',
      title:GIT_RM_CREATE_TITLE,runLabel:GIT_RM_CREATE_RUN,focus:'name',
      fields:[
        {key:'name',type:GIT_DIALOG_TEXT,cls:'gra-name',placeholder:GIT_RM_NAME_PH},
        {key:'url',type:GIT_DIALOG_TEXT,cls:'gra-url',placeholder:GIT_RM_URL_PH},
      ],
      validate:v=>this._why(v),
      run:v=>this._run(v),
    });
  }

  // 규칙 전체를 여기서 판정하지 않는다 — 그것은 서버의 일이다 (FR-GIT-250.3).
  // 여기서 막는 것은 "아직 채우지 않았다" 뿐이다.
  _why(v){
    if(!(v.name||'').trim()) return GIT_RM_WHY_NAME;
    if(!(v.url||'').trim()) return GIT_RM_WHY_URL;
    return '';
  }

  async _run(v){
    const res=await this.panel.post('/api/git/remote/add',{
      repo:this.repo,name:(v.name||'').trim(),url:(v.url||'').trim(),
    });
    if(this.list.adoptWrite(res)) return {ok:true};
    // 실패 사유는 다이얼로그 안에 남는다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175).
    return {ok:false,reason:this.panel.writeReason(res)||GIT_RM_ADD_FAIL,
      stderrTail:(res.data&&res.data.message)||''};
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitRemote=GitRemote;
window.GitRemoteOpts=GitRemoteOpts;
window.GitPushPreview=GitPushPreview;
window.GitRemoteList=GitRemoteList;
window.GitRemoteAdd=GitRemoteAdd;
