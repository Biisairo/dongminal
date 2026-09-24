/**
 * Dongminal — 잡 표시기 묶음 (REPO_FIX 01 §6.4)
 *
 * 저장소마다 잡 칸이 둘이다 — index(작업 트리·HEAD 를 바꾸는 잡)와 common(원격 ref·
 * worktree 들이 공유하는 것을 바꾸는 잡). push 중에도 commit 을 할 수 있어야 하므로
 * 칸마다 표시기(`GitRemote`) 하나를 두고, 이 클래스가 둘을 **하나의 표면**으로 묶는다:
 * 패널과 메뉴는 `panel._remote()` 하나만 안다.
 *
 * 칸 판정의 출처는 둘이다 — 도는 잡은 서버가 준 `slots`, 아직 응답이 오지 않은 시작은
 * `gitJobSlotsOf(key)`(서버 jobs.SlotsOf 와 같은 규칙).
 */
class GitJobs {
  constructor(panel){
    this.panel=panel;
    this.views={};
    this.views[GIT_JOB_SLOT_INDEX]=new GitRemote(panel,GIT_JOB_SLOT_INDEX,this);
    this.views[GIT_JOB_SLOT_COMMON]=new GitRemote(panel,GIT_JOB_SLOT_COMMON,this);
    // 이 탭의 `panel.post` 가 띄워 결과를 기다리는 잡 — 뒷정리는 기다리는 쪽이 한다.
    this._owned=new Set();
  }

  // 칸 하나의 박스. 두 칸이 같은 골격이다 — 한 벌을 두 번 찍는다.
  static boxHTML(slot){
    return '<div class="git-job" data-slot="'+slot+'">'+
      '<div class="git-job-bar">'+
        // REPO_TAB_UNIFY_SRS FR-RTU-100: 접기·펴기는 **전용 토글**이 갖는다.
        '<button class="ui-btn ui-btn-icon ui-btn-lg git-job-fold"></button>'+
        '<span class="git-job-kind"></span>'+
        '<code class="git-job-argv"></code>'+
        '<span class="git-job-state"></span>'+
        '<span class="git-job-spacer"></span>'+
        '<button class="ui-btn ui-btn-sm git-job-cancel"></button>'+
        '<button class="ui-btn ui-btn-sm git-job-copy"></button>'+
        '<button class="ui-btn ui-btn-sm git-job-close"></button>'+
      '</div>'+
      '<div class="ui-notice ui-notice-attn git-job-note"></div>'+
      '<div class="git-job-fail">'+
        '<div class="git-job-reason"></div>'+
        '<pre class="git-job-tail ui-scroll"></pre>'+
        // 자격증명을 받는 자리가 아니다 — 안내와 복사 가능한 명령뿐이다 (FR-GIT-104).
        '<div class="git-job-auth">'+
          '<div class="git-job-auth-note"></div>'+
          '<code class="git-job-auth-cmd"></code>'+
          '<button class="ui-btn ui-btn-sm git-job-auth-copy"></button>'+
        '</div>'+
        '<button class="ui-btn ui-btn-sm git-job-lock"></button>'+
        '<div class="git-job-opts"></div>'+
      '</div>'+
      '<pre class="git-job-log ui-scroll"></pre>'+
    '</div>';
  }

  _each(f){for(const v of Object.values(this.views)) f(v)}

  // ── 칸 ──

  busy(slot){return Object.values(this.views).some(v=>v.holds(slot))}

  // 그 키의 시작을 막는 사유. 버튼의 title 이 이것을 보인다 (FR-GIT-101).
  why(key){
    if(!this.panel.repo||!this.panel.statusOf()) return GIT_REMOTE_WHY_NO_STATUS;
    return gitJobSlotsOf(key).some(s=>this.busy(s))?GIT_REMOTE_WHY_BUSY:'';
  }

  // §6.4: index 칸이 돌면 그 저장소의 동기 쓰기를 보내지 않는다. 서버도 409 다 —
  // 보내지 않는 쪽이 사유를 먼저, 같은 문구로 보인다.
  blocks(url){
    if(GIT_JOB_INDEX_EXEMPT.has(url)) return '';
    return this.busy(GIT_JOB_SLOT_INDEX)?GIT_JOB_BUSY_NOTE:'';
  }

  // ── 시작·추적 ──

  run(key,body,opts){
    if(this.why(key))
      return Promise.resolve({ok:false,code:409,data:{error:'job_busy',message:GIT_JOB_BUSY_NOTE}});
    const slot=gitJobSlotsOf(key)[0];
    this._dismissOthers(slot);
    return this.views[slot]._launch(key,body,opts);
  }

  // 시작 응답의 잡을 그 첫 칸의 표시기에 붙인다.
  //
  // 다른 칸의 **끝난** 결과는 걷는다 — 종전의 박스 하나처럼 새 잡이 앞의 결과를
  // 대신한다. 다른 칸에서 도는 잡은 그대로 두 줄로 선다.
  track(job,view){
    const slot=(job.slots&&job.slots[0])||(view&&view.slot)||GIT_JOB_SLOT_INDEX;
    this._dismissOthers(slot);
    this.views[slot]._attach(job);
  }

  _dismissOthers(slot){
    for(const [s,v] of Object.entries(this.views)) if(s!==slot) v.dismiss();
  }

  // `panel.post` 가 받은 {job} 을 붙이고 끝을 기다린다. 뒷정리는 기다리는 쪽이 한다.
  follow(job){
    this._owned.add(job.id);
    this.track(job);
    return this.awaitJob(job.id);
  }

  awaitJob(id){
    for(const v of Object.values(this.views)){
      if((v._job&&v._job.id===id)||(v._done&&v._done.id===id)) return v.awaitJob(id);
    }
    return Promise.resolve(null);
  }

  /**
   * 잡 하나가 끝났다. 이 탭이 기다리는 잡이 아니면(다른 탭·새로고침 뒤 재부착)
   * 여기서 결과를 들인다 — 쓰기 이후 status 를 받고, 커밋이 이겼으면 그 저장소의
   * 초안을 비우고 undo 를 보인다 (§6.4 재부착).
   */
  finished(jb){
    if(!jb||!jb.id) return;
    if(this._owned.delete(jb.id)) return;
    const r=jb.result||{};
    if(r.status) this.panel.adopt({requested:this.panel.repo,repo:jb.repo,status:r.status});
    if(jb.kind==='commit'&&!jb.err&&!jb.exitCode) this.panel._commit().adoptJobDone(jb);
  }

  adoptJobs(jobs){this._each(v=>v.adoptJobs(jobs))}

  // ── 패널이 부르는 나머지 — 두 칸에 그대로 넘긴다 ──

  // 머리의 원격 버튼은 common 칸 표시기가 받는다 — pull 은 run 이 index 로 보낸다.
  bindHead(head){this.views[GIT_JOB_SLOT_COMMON].bindHead(head)}
  paintHead(head){this.views[GIT_JOB_SLOT_COMMON].paintHead(head)}
  bind(el){this._each(v=>v.bind(el))}
  paint(el){this._each(v=>v.paint(el))}
  detachRepo(){this._owned.clear(); this._each(v=>v.detachRepo())}
  notifyStatus(){this._each(v=>v.notifyStatus())}
}

window.GitJobs=GitJobs;
