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
  }

  // ── 골격 ──

  // Changes 탭 골격이 세워진 직후 한 번. 리포가 사라져 골격을 버리면 다시 불린다.
  bind(el){
    if(!el) return;
    for(const b of el.querySelectorAll('.git-remote-btn'))
      b.addEventListener('click',()=>this._click(b.dataset.remote));
    for(const b of el.querySelectorAll('.git-remote-more'))
      b.addEventListener('click',()=>this._opts(b.dataset.remote));
    const box=el.querySelector('.git-job'); if(!box) return;
    box.querySelector('.git-job-cancel').addEventListener('click',()=>this.cancel());
    box.querySelector('.git-job-copy').addEventListener('click',()=>this._copyLog());
    box.querySelector('.git-job-close').addEventListener('click',()=>{
      this._done=null; this._err=null; this._conflict=false;
      this._lines=[]; this._total=0;
      this._paint();
    });
    box.querySelector('.git-job-auth-copy').addEventListener('click',()=>
      this.panel.copyText(this._termCmd(this._done||{})));
  }

  // 리포가 바뀌면 붙어 있던 작업을 놓는다 (FR-GIT-16). 작업은 서버에서 계속 돌고
  // 상태바가 그것을 계속 보인다 (FR-GIT-112) — 화면만 새 리포의 것으로 되돌린다.
  detachRepo(){
    this._closeStream();
    this._job=null; this._jobRepo=null; this._done=null; this._err=null;
    this._conflict=false; this._busy=false; this._canceling=false;
    this._lines=[]; this._total=0; this._seq=0;
    this._pending=null;
  }

  // ── 칠하기 ──

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
    box.querySelector('.git-job-kind').textContent=GIT_REMOTE_LABEL[j.kind]||'';
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
    const note=box.querySelector('.git-job-note');
    note.textContent=this._conflict?GIT_JOB_CONFLICT_NOTE:'';
    note.classList.toggle('vis',this._conflict);
    this._paintFail(box);
    this._paintLog(box);
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
    this._paint();
    const res=await this._post('/api/git/'+kind,Object.assign({repo},body||{}));
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

  async _forcePush(force){
    const s=this.panel.statusOf()||{};
    const target=s.upstream||(s.branch||'');
    const repo=this.panel.repo||'';
    await GitConfirm.open({
      action:GIT_ACT_FORCE_PUSH,title:GIT_FORCE_PUSH_TITLE,targets:[target],
      hint:{note:GIT_FORCE_PUSH_NOTE,
        command:'git -C '+gitShQuote(repo)+' rev-parse '+(target||'HEAD')},
      run:async()=>{
        // `--force` 는 서버도 confirm 을 요구한다 — 확인을 거쳤음을 함께 보낸다.
        const res=await this.run('push',{force,confirm:true});
        if(res.ok) return {ok:true};
        return {ok:false,reason:this._reason(res),
          stderrTail:(res.data&&res.data.message)||''};
      },
    });
  }

  // FR-GIT-100: upstream 을 설정한다는 사실을 실행 전에 알린다. 파괴적이 아니므로
  // 1단계이며, 무엇이 설정되는지는 서버가 준 계획으로 보인다.
  async _publish(plan,body){
    const target=(plan.remote||'')+'/'+(plan.branch||'');
    const ok=await GitConfirm.open({
      action:GIT_ACT_PUBLISH,title:GIT_PUBLISH_TITLE,targets:[target],stages:1,
    });
    if(!ok) return;
    this.run('push',Object.assign({},body||{},{publish:true}));
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
    const ok=await GitConfirm.open({
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
 * 필드 정의는 GIT_REMOTE_DIALOGS 에 있다 — fetch·pull·push 가 같은 골격을 쓰고
 * 다이얼로그마다 코드를 복제하지 않는다. **첫 선택지가 기본이고 그것이 안전한
 * 쪽이다** (FR-GIT-97·173).
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
    const ov=document.createElement('div');
    ov.id='git-remote-opts'; ov.className='gro-modal'; ov.dataset.kind=this.kind;
    ov.innerHTML=
      '<div class="gro-box" role="dialog" aria-modal="true">'+
        '<div class="gro-head"></div>'+
        '<div class="gro-fields"></div>'+
        '<div class="gro-actions">'+
          '<button type="button" class="gro-cancel"></button>'+
          '<button type="button" class="gro-go"></button>'+
        '</div>'+
      '</div>';
    document.body.appendChild(ov);
    this.ov=ov;
    const b=ov.querySelector('.gro-box');
    this.box=b;
    b.querySelector('.gro-head').textContent=this.def.title;
    b.querySelector('.gro-cancel').textContent=GIT_CONFIRM_CANCEL;
    b.querySelector('.gro-go').textContent=this.def.run;
    this._fields(b.querySelector('.gro-fields'));
    b.querySelector('.gro-cancel').addEventListener('click',()=>this._close());
    b.querySelector('.gro-go').addEventListener('click',()=>this._run());
    this._key=e=>{
      if(e.key!=='Escape') return;
      e.preventDefault(); e.stopPropagation();
      this._close();
    };
    document.addEventListener('keydown',this._key,true);
    b.querySelector('.gro-cancel').focus();
  }

  _fields(host){
    for(const f of this.def.fields){
      const box=document.createElement('div');
      box.className='gro-field'; box.dataset.key=f.key;
      if(f.type==='check'){
        box.appendChild(this._row(f.key,'checkbox','',f.label,false));
        host.appendChild(box);
        continue;
      }
      const lab=document.createElement('div');
      lab.className='gro-label'; lab.textContent=f.label;
      box.appendChild(lab);
      // 첫 선택지가 기본이다 (FR-GIT-97).
      for(let i=0;i<f.opts.length;i++){
        const o=f.opts[i];
        box.appendChild(this._row(f.key,'radio',o.v,o.label,i===0));
      }
      host.appendChild(box);
    }
  }

  _row(key,type,value,label,on){
    const l=document.createElement('label');
    l.className='gro-row';
    const i=document.createElement('input');
    i.type=type; i.dataset.key=key; i.value=value; i.checked=!!on;
    if(type==='radio') i.name='gro-'+key;
    const s=document.createElement('span');
    s.textContent=label;
    l.appendChild(i); l.appendChild(s);
    return l;
  }

  // 값의 이름은 API 그대로다 (계약 §2.2). tags 는 3상태이므로 null|true|false 로
  // 옮긴다 — null 이면 저장소의 tagOpt 설정을 우리가 덮지 않는다.
  _body(){
    const v={};
    for(const i of this.box.querySelectorAll('.gro-row input')){
      if(i.type==='checkbox') v[i.dataset.key]=i.checked;
      else if(i.checked) v[i.dataset.key]=i.value;
    }
    if(this.kind==='fetch')
      return {prune:!!v.prune,tags:v.tags===''?null:v.tags==='yes'};
    if(this.kind==='pull') return {mode:v.mode||''};
    return {force:v.force||''};
  }

  _run(){
    const body=this._body();
    this._close();
    if(this.kind==='push'){this.remote._push(body.force);return}
    this.remote.run(this.kind,body);
  }

  _close(){
    document.removeEventListener('keydown',this._key,true);
    if(this.ov) this.ov.remove();
    this.ov=null; this.box=null;
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitRemote=GitRemote;
window.GitRemoteOpts=GitRemoteOpts;
