/**
 * Otterminal — 원격 잡 표시기의 칠하기 (REFACTOR3_FE_REST3_SRS FR-FR3-13, FU-12)
 *
 * `GitRemote`(remote.js)가 잡 칸 하나의 상태·실행·스트림·수명을 갖고, 이 클래스는 그 상태를 **화면에 옮긴다** —
 * 머리의 원격 버튼, Changes 의 잡 박스(상태 글자·argv·취소·닫기·접기·실패 사유·인증 안내·후속 선택지·출력).
 * 상태는 `this.r` 에서 읽고, 누른 동작과 다시 그리기는 `this.r.X()` 로 넘긴다. 자기 필드는 없다.
 *
 * 자격증명을 받는 입력을 만들지 않는다 (FR-GIT-104) · 거부 선택지의 순서를 바꾸지 않는다 (FR-GIT-105) —
 * 두 약속의 근거는 remote.js 머리에 있다.
 */
class GitRemoteView {
  constructor(remote){
    this.r=remote;
    this.panel=remote.panel;
  }

  /**
   * 머리 한 벌의 동작 (FR-GHM-3). 머리는 Changes 밖에도 서므로 이 경로는 머리마다
   * 한 번씩 지난다 — 어느 머리에서 눌러도 같은 `GitRemote` 하나가 받는다.
   */
  bindHead(head){
    if(!head) return;
    for(const b of head.querySelectorAll('.git-remote-btn'))
      b.addEventListener('click',()=>this.r._click(b.dataset.remote));
    for(const b of head.querySelectorAll('.git-remote-more'))
      b.addEventListener('click',()=>this.r._opts(b.dataset.remote));
  }

  /**
   * 작업 화면의 동작. Changes 탭 골격이 세워진 직후 한 번이며, 리포가 사라져
   * 골격을 버리면 다시 불린다.
   *
   * FR-GHM-7: 작업 화면은 **Changes 에만** 있다 — 하나의 작업에 화면이 둘이면
   * 접기·취소 같은 사용자의 뜻이 두 벌이 된다. 머리의 배선은 `bindHead` 다.
   */
  bind(el){
    if(!el) return;
    const box=this._box(el); if(!box) return;
    box.querySelector('.git-job-cancel').addEventListener('click',()=>this.r.cancel());
    box.querySelector('.git-job-copy').addEventListener('click',()=>this._copyLog());
    // FR-GIT-221 (REPO_TAB_UNIFY_SRS FR-RTU-100 개정): 접힌 로그는 사라진 것이
    // 아니다 — 다시 펼칠 수 있다. 계기는 둘이고 하는 일은 같다.
    //
    //   이전 동작: 바를 누르면 펴진다. 바 안의 버튼은 자기 일을 한다
    //   새  동작: **전용 토글**이 편다. 바를 누르는 것도 그대로 남는다
    //   이유:     220px 사이드에서 `kind·state·cancel·copy·close` 가
    //             `flex-shrink:0` 이라 argv 만 0 으로 눌린다 — 바에 버튼 아닌
    //             자리가 남지 않아 펴려는 클릭이 `copy`·`close` 에 떨어졌다
    //             (D-RTU-33). 토글은 폭과 무관하게 자리가 고정이다
    const fold=()=>{this.r._logOpen=this._logCollapsed(); this.r._paint()};
    box.querySelector('.git-job-fold').addEventListener('click',fold);
    box.querySelector('.git-job-bar').addEventListener('click',ev=>{
      if(ev.target.closest('button')) return;
      fold();
    });
    box.querySelector('.git-job-close').addEventListener('click',()=>this.r.dismiss());
    box.querySelector('.git-job-auth-copy').addEventListener('click',()=>
      this.panel.poll.copyText(this._termCmd(this.r._done||{})));
    // REPO_FIX 01 §7.2: index.lock 에 막혀 끝난 잡의 출구 — 확인 뒤에만 지운다.
    box.querySelector('.git-job-lock').addEventListener('click',()=>
      this.panel.write.removeIndexLock((this.r._done||{}).lock));
  }

  _box(el){return el.querySelector('.git-job[data-slot="'+this.r.slot+'"]')}

  // 머리 하나의 동작부 (FR-GHM-6). 막힘 사유는 리포의 것이므로 머리가 몇이든 같다.
  // §6.4: 버튼마다 자기 kind 가 차지할 칸으로 판정한다 — push 중에도 pull 이 아닌
  // 것은 막히지 않는다.
  paintHead(head){
    if(!head) return;
    for(const b of head.querySelectorAll('.git-remote-btn')){
      b.disabled=!this.r.router.state(b.dataset.remote).enabled;
      b.title=this.r.router.why(b.dataset.remote)||(GIT_REMOTE_TITLE[b.dataset.remote]||'');
    }
    for(const b of head.querySelectorAll('.git-remote-more')){
      b.disabled=!this.r.router.state(b.dataset.remote).enabled;
      b.title=this.r.router.why(b.dataset.remote)||GIT_REMOTE_MORE_TITLE;
    }
  }

  paintJob(el){
    const box=this._box(el); if(!box) return;
    const cur=this.r._job||this.r._done;
    const vis=!!(cur||this.r._busy||this.r._err);
    box.classList.toggle('vis',vis);
    if(!vis){box.dataset.kind='';return}
    const j=cur||{};
    box.dataset.kind=j.kind||'';
    box.dataset.job=j.id||'';
    box.querySelector('.git-job-kind').textContent=j.kind?gitJobKindLabel(j.kind):'';
    // argv 를 그대로 보인다 — 다이얼로그의 선택이 반영됐는지 여기서 확인된다.
    const argv=(j.argv||[]).join(' ');
    const cmd=box.querySelector('.git-job-argv');
    cmd.textContent=argv?('git '+argv):'';
    cmd.title=cmd.textContent;
    box.querySelector('.git-job-state').textContent=this._state();
    const cancel=box.querySelector('.git-job-cancel');
    cancel.classList.toggle('vis',!!this.r._job);
    cancel.disabled=this.r._canceling;
    const close=box.querySelector('.git-job-close');
    close.classList.toggle('vis',!this.r._job&&!this.r._busy);
    const note=box.querySelector('.git-job-note');
    // F-9.4: 결과 미상은 성공도 실패도 아니다 — 중립 문구로 상태를 확인하라고 말한다.
    const unknown=!this.r._job&&!!this.r._done&&gitJobOutcome(this.r._done)==='unknown';
    const msg=this.r._conflict?GIT_JOB_CONFLICT_NOTE:(unknown?GIT_JOB_UNKNOWN_NOTE:'');
    note.textContent=msg;
    note.classList.toggle('vis',!!msg);
    const collapsed=this._logCollapsed();
    box.classList.toggle('log-collapsed',collapsed);
    // FR-RTU-100: 토글은 지금 상태를 말한다 — 눌러서 무엇이 되는지가 아니라.
    UIKit.caret(box.querySelector('.git-job-fold'),!collapsed);  // UX_AUDIT_FIX_SRS FR-UXF-100
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
    if(this.r._logOpen!=null) return !this.r._logOpen;
    if(this.r._job||this.r._busy) return false;
    const d=this.r._done;
    if(!d||this.r._err||this.r._conflict) return false;
    return gitJobOutcome(d)==='ok';
  }

  _state(){
    if(this.r._job)
      return this.r._canceling?GIT_JOB_CANCELING
        :(this.r._streamErr?GIT_JOB_STREAM_FAIL:GIT_JOB_RUNNING);
    if(this.r._busy) return GIT_JOB_RUNNING;
    const d=this.r._done;
    if(!d) return this.r._err?GIT_JOB_FAIL:'';
    const o=gitJobOutcome(d);
    if(o==='canceled') return GIT_JOB_CANCELED;
    if(o==='unknown') return GIT_JOB_UNKNOWN;
    return o==='ok'?GIT_JOB_OK:GIT_JOB_FAIL;
  }

  // 실패 사유·stderr tail·인증 안내·후속 선택지 (FR-GIT-104·105·108).
  _paintFail(box){
    const d=this.r._done||{};
    const o=this.r._done?gitJobOutcome(d):'';
    const failed=!!(this.r._err||o==='fail'||o==='canceled');
    const fail=box.querySelector('.git-job-fail');
    fail.classList.toggle('vis',failed);
    fail.querySelector('.git-job-reason').textContent=this.r._err||d.err||'';
    fail.querySelector('.git-job-tail').textContent=d.stderrTail||'';
    // §7.2: 지울 lock 이 실제로 있을 때만 버튼이 선다(mtime 이 없으면 이미 없다).
    const lock=d.errorCode==='index_locked'&&d.lock&&d.lock.mtimeUnixMs!=null;
    const lockBtn=fail.querySelector('.git-job-lock');
    lockBtn.textContent=GIT_LOCK_REMOVE;
    lockBtn.classList.toggle('vis',!!lock);
    lockBtn.disabled=!actionState(this.panel.views.actionOf(GIT_ACTION.lockRemove),false).enabled;
    // FR-GIT-104: 안내만 한다. 받는 자리를 만들지 않는다.
    const auth=fail.querySelector('.git-job-auth');
    auth.classList.toggle('vis',!!d.authRequired);
    auth.querySelector('.git-job-auth-note').textContent=GIT_JOB_AUTH_NOTE;
    auth.querySelector('.git-job-auth-cmd').textContent=this._termCmd(d);
    // FR-GIT-105: 서버가 준 순서 그대로다. 다시 그리는 것은 목록이 바뀔 때뿐이다.
    const opts=fail.querySelector('.git-job-opts');
    // K-f: 선택지마다 할 일(`fixes`)이 함께 온다 — 화면은 이름과 견주지 않는다.
    const list=(d.rejected&&Array.isArray(d.fixes))?d.fixes.filter(f=>f&&f.id&&f.kind):[];
    const key=list.map(f=>f.id).join(' ');
    if(opts.dataset.opts===key) return;
    opts.dataset.opts=key;
    opts.innerHTML='';
    opts.classList.toggle('vis',!!list.length);
    if(!list.length) return;
    const n=document.createElement('div');
    n.className='ui-notice git-job-opts-note'; n.textContent=GIT_JOB_REJECT_NOTE;
    opts.appendChild(n);
    for(const fix of list){
      // 클래스가 하나뿐인 것이 요구사항이다 — force 를 눈에 띄게 만들지 않는다.
      opts.appendChild(UIKit.button({label:gitJobFixLabel(fix.id),title:GIT_TIP_JOB_FIX,size:'sm',
        cls:'git-job-opt',dataset:{fix:fix.id},onClick:()=>this.r._fix(fix)}));
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
    const key=((this.r._job||this.r._done||{}).id)||'';
    if(log.dataset.job!==key){
      log.dataset.job=key; log.dataset.total='0'; log.innerHTML='';
    }
    const drawn=parseInt(log.dataset.total||'0',10)||0;
    let pending=this.r._total-drawn;
    if(pending<=0) return;
    if(pending>this.r._lines.length) pending=this.r._lines.length;
    const frag=document.createDocumentFragment();
    for(let i=this.r._lines.length-pending;i<this.r._lines.length;i++){
      const ln=this.r._lines[i];
      const d=document.createElement('div');
      d.className='git-job-line';
      d.dataset.seq=String(ln.seq||0);
      d.dataset.stream=ln.stream||'';
      d.textContent=ln.text||'';
      frag.appendChild(d);
    }
    log.appendChild(frag);
    log.dataset.total=String(this.r._total);
    const cap=gitJobLineCap();
    while(cap>0&&log.childElementCount>cap) log.removeChild(log.firstElementChild);
    log.scrollTop=log.scrollHeight;
  }

  /**
   * 터미널에 붙여 그대로 실행할 명령 (FR-GIT-104).
   *
   * 실제로 실행된 argv 를 쓴다 — 우리가 새로 조립하면 사용자가 터미널에서 하는
   * 것이 화면이 말한 것과 달라진다. `--progress` 만 뺀다: tty 에서는 필요 없다.
   */
  _termCmd(d){
    const repo=this.r._jobRepo||this.panel.repo||'';
    const argv=(d.argv||[]).filter(a=>a!==GIT_PROGRESS_FLAG);
    return 'git -C '+gitShQuote(repo)+(argv.length?(' '+argv.join(' ')):'');
  }

  // FR-GIT-108·96: 실패 사유를 복사할 수 있어야 한다. 출력 전체가 그 사유다.
  _copyLog(){
    const text=this.r._lines.map(l=>l.text||'').join('\n');
    const tail=(this.r._done&&this.r._done.stderrTail)||'';
    this.panel.poll.copyText(text||tail);
  }
}

window.GitRemoteView=GitRemoteView;
