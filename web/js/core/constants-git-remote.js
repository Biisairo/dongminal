/**
 * Dongminal — **원격 · Worktrees · Submodules** 의 상수 (FE_MODULE_BOUNDARY_SRS FR-FMB-1).
 *
 * 이 저장소 **바깥**을 가리키는 셋 — 다른 호스트의 ref, 다른 작업 트리, 다른
 * 저장소. 셋 다 "여기 없는 것을 여기서 다룬다" 는 성질을 공유한다.
 *
 * 절과 그 앵커: 원격 작업(GIT_SRS §3B.1 / FR-GIT-98~112) · Worktrees(GIT_REVIEW4_SRS
 * §3.6.5 / FR-GIT-240~244) · Submodules(UX_BATCH5_SRS 묶음 D / FR-SUB-1~11).
 */
// FR-GIT-98·99: 버튼은 **기본 동작만** 한다. 변형(--prune·--rebase·force)은 `▾`
// 다이얼로그에서만 온다 — 여기서 라벨과 사유를 붙인다.
const GIT_REMOTE_KINDS=['fetch','pull','push'];
// **글자다.** 작업 진행 표시(상태바·작업 로그의 이름)가 이것을 쓴다 — 버튼을
// 아이콘으로 바꾸면서 이 값을 함께 바꾸면 "⤓ 중" 이 된다 (GIT_CHANGES_CONTROLS_SRS D-6).
const GIT_REMOTE_LABEL={fetch:'Fetch',pull:'Pull',push:'Push'};
// FR-GCC-5: **버튼의 얼굴**. 좁은 사이드에서 글자 셋과 `▾` 셋은 두 줄을 먹었고
// `Push` 의 `▾` 는 줄을 넘겼다(실측). 무엇인지는 툴팁(GIT_REMOTE_TITLE)이 말한다.
const GIT_REMOTE_ICON={fetch:'download',pull:'arrow-down',push:'arrow-up'};
const GIT_REMOTE_TITLE={
  fetch:'Fetch from the remote (git fetch)',
  pull:'Fetch and merge into the current branch (git pull)',
  push:'Push the current branch to the remote (git push)',
};
const GIT_REMOTE_MORE='chevron-down';
const GIT_REMOTE_MORE_TITLE='More options';
// FR-TIP-2: 이 둘은 **툴팁 전용**이다 — 꺼진 버튼의 사유를 title 로만 알린다
// (FR-GIT-101). 화면에 글자로 서는 자리가 없으므로 영어로 옮긴다.
const GIT_REMOTE_WHY_NO_STATUS='Repository status has not been read yet';
// FR-GIT-101: 진행 중에는 같은 리포의 다른 원격 버튼도 막는다. 사유 없이 꺼진
// 버튼은 사용자가 해소할 수 없다.
const GIT_REMOTE_WHY_BUSY='A remote operation is already running for this repository';
// argv 는 그대로 보인다 — 무엇이 실행됐는지 모르면 다이얼로그의 선택이 반영됐는지
// 사용자가 확인할 수 없다 (FR-GIT-109·110).
const GIT_PROGRESS_FLAG='--progress';
// 보존 줄 수 상한. 서버의 JobLineCap 과 같은 값이다 — 더 들고 있어도 서버가 주지
// 않는다.
const GIT_JOB_LINE_CAP=2000;
// SSE 가 끊기면 마지막 seq 부터 다시 잇는다 (계약 §2.3.1).
const GIT_JOB_RETRY_MS=1000;
const GIT_JOB_RETRY_MAX=5;
const GIT_JOB_RUNNING=t('git.job_running');
const GIT_JOB_OK=t('git.job_ok');
const GIT_JOB_FAIL=t('git.job_fail');
const GIT_JOB_CANCELED=t('git.job_canceled');
const GIT_JOB_CANCELING=t('git.job_canceling');
const GIT_JOB_CLOSE=t('git.act.job_close');
// REPO_TAB_UNIFY_SRS FR-RTU-100: 로그 접기 토글. 폭이 줄어도 자리가 고정인 유일한
// 계기이므로 라벨도 한 글자여야 한다 — 글자가 길면 그것이 다시 폭을 다툰다.
const GIT_JOB_FOLD_OPEN='\u25be';
const GIT_JOB_FOLD_CLOSED='\u25b8';

const GIT_JOB_COPY=t('git.act.job_copy');
const GIT_JOB_STREAM_FAIL=t('git.job_stream_fail');
const GIT_JOB_START_FAIL=t('git.job_start_fail');
// FR-GIT-102: 취소는 **부분 적용 가능성을 알린다** — 원격에 절반이 올라간 뒤
// 끊길 수 있다. 그 사실을 확인 문구에 명시한다.
const GIT_ACT_JOB_CANCEL='job_cancel';
const GIT_JOB_CANCEL=t('git.act.job_cancel');
const GIT_JOB_CANCEL_TITLE=t('git.job_cancel_title');
const GIT_JOB_CANCEL_NOTE=t('git.job_cancel_note');
// FR-GIT-104: **자격증명을 받지 않는다.** 입력을 만들지 않고 터미널에서 수행하도록
// 안내만 한다 — 만들지 않는 것이 유일한 보장이다.
const GIT_JOB_AUTH_NOTE=t('git.job_auth_note');
const GIT_JOB_AUTH_COPY=t('git.act.job_auth_copy');
// FR-GIT-105: 선택지는 **서버가 준 순서 그대로** 그린다. 순서가 곧 우선순위이고
// force 는 마지막이며 강조하지 않는다.
const GIT_JOB_REJECT_NOTE=t('git.job_reject_note');
// 이름은 서버(internal/git/job.go)와 같은 문자열이다. 목록과 순서는 서버가 준다.
const GIT_JOB_FIX_REBASE='fetch_rebase';
const GIT_JOB_FIX_MERGE='fetch_merge';
const GIT_JOB_FIX_LEASE='force_with_lease';
const GIT_JOB_FIX_LABEL={
  fetch_rebase:t('git.job_fix_label.fetch_rebase'),
  fetch_merge:t('git.job_fix_label.fetch_merge'),
  force_with_lease:t('git.job_fix_label.force_with_lease'),
};
// FR-GIT-111: pull 이 충돌을 남기면 Changes 탭으로 보낸다. 해결 UI 는 M3 범위 밖이다.
const GIT_JOB_CONFLICT_NOTE=t('git.job_conflict_note');
// FR-GIT-100: upstream 이 없으면 Push 는 Publish 다. 서버가 실행 전에 되묻는다
// (계약 §2.3.1 ①) — 그 확인을 이 문구가 맡는다. 파괴적이 아니므로 1단계다.
const GIT_ACT_PUBLISH='publish';
const GIT_PUBLISH_TITLE=t('git.publish_title');
// FR-GIT-106: force 는 `--force-with-lease` 가 기본이고 `--force` 는 파괴적 확인을
// 거친다. 이름은 서버의 파괴적 목록(/api/git/policy)의 키이며 목록을 복제하지 않는다.
const GIT_ACT_FORCE_PUSH='force_push';
const GIT_FORCE_PUSH_TITLE=t('git.force_push_title');
const GIT_FORCE_PUSH_NOTE=t('git.force_push_note');
// `▾` 다이얼로그 (FR-GIT-109·110). **첫 선택지가 기본이고 그것이 안전한 쪽이다**
// (FR-GIT-97·173).
const GIT_REMOTE_DIALOGS={
  fetch:{title:t('git.remote_dialogs.fetch.title'),run:'Fetch',fields:[
    {key:'prune',type:'check',label:t('git.remote_dialogs.fetch.prune')},
    {key:'tags',type:'radio',label:t('git.remote_dialogs.fetch.tags'),opts:[
      {v:'',label:t('git.remote_dialogs.fetch.tags_default')},
      {v:'yes',label:t('git.remote_dialogs.fetch.tags_yes')},
      {v:'no',label:t('git.remote_dialogs.fetch.tags_no')},
    ]},
  ]},
  pull:{title:t('git.remote_dialogs.pull.title'),run:'Pull',fields:[
    {key:'mode',type:'radio',label:t('git.remote_dialogs.pull.mode'),opts:[
      {v:'',label:t('git.remote_dialogs.pull.mode_default')},
      {v:'rebase',label:'rebase (--rebase)'},
      {v:'ff-only',label:t('git.remote_dialogs.pull.mode_ff_only')},
      {v:'no-ff',label:t('git.remote_dialogs.pull.mode_no_ff')},
    ]},
  ]},
  push:{title:t('git.remote_dialogs.push.title'),run:'Push',fields:[
    {key:'force',type:'radio',label:t('git.remote_dialogs.push.force'),opts:[
      {v:'',label:t('git.remote_dialogs.push.force_none')},
      {v:'lease',label:'--force-with-lease'},
      {v:'force',label:'--force'},
    ]},
  ]},
};

const GIT_WT_ADD='+ New Worktree';
// FR-TIP-1: worktree 가 무엇인지 모르는 사용자에게 라벨은 아무 말도 하지 않는다.
const GIT_WT_ADD_TITLE='Create a worktree — a second checkout of this repository in its own folder';
const GIT_WT_EMPTY=t('git.wt_empty');
const GIT_WT_LOAD_FAIL=t('git.wt_load_fail');
const GIT_WT_DETACHED='detached';
const GIT_WT_MAIN='main';
// 소유 표식 (FR-GIT-240). **사용자 것은 표식이 없다** — 그것이 기본이기 때문이다.
// 이모지를 쓰지 않는다 (FR-GIT-187·192).
const GIT_WT_OWN_LABEL={run:t('git.wt_own_label.run'),outside:t('git.wt_own_label.outside')};
const GIT_WT_OWN_TITLE={
  run:t('git.wt_own_title.run'),
  outside:t('git.wt_own_title.outside'),
};
// 행 동작 (FR-GIT-244). 제거는 사용자 것에만 붙고, 열기는 활성 리포 행에 붙지
// 않는다 — 눌리지만 아무 일도 하지 않는 버튼은 고장으로 읽힌다 (FR-GIT-180).
// FR-GIT-249: 핀은 **상태의 토글**이다 — 이미 핀된 것에 Pin 을 다시 보이면 눌러도
// 아무 일이 없고(서버 pin 은 멱등이다) 사용자는 그것을 고장으로 읽는다.
const GIT_WT_ACT_LABEL={open:'Open',pin:'Pin',unpin:'Unpin',term:'Shell',remove:'Remove'};
/**
  * UX_BATCH5_SRS FR-WTG-2: `open` 의 문구가 **하는 일과 어긋나 있었다.**
  *
  *   이전 문구: "이 worktree 를 활성 리포로 엽니다"
  *   새  문구: 그 워크트리의 **저장소 창**을 연다
  *   이유:     REPO_TAB_UNIFY_SRS FR-RTU-72 로 리포 전환이 창 전환이 됐다 —
  *             갈아 끼울 "활성 리포" 라는 것이 더 이상 없다. 옛 표현이 그대로
  *             남아 있었다 (묶음 E 실측에서 확인)
  */
const GIT_WT_ACT_TITLE={
  open:'Open this worktree as its own repository window',
  pin:'Pin it to the GIT section',
  unpin:'Remove it from the GIT section',
  term:'Open a terminal tab in this worktree (in a non-Git window)',
  remove:'Delete this worktree',
};
//
// 골격과 규약은 **Worktrees 탭과 같다** (FR-SUB-7) — 머리의 일괄, 안내 줄, 목록.
// 새 규약을 만들지 않는다: 같은 모양의 목록이 둘이면 규칙도 하나여야 한다.

const GIT_SUB_EMPTY=t('git.sub_empty');
const GIT_SUB_LOAD_FAIL=t('git.sub_load_fail');
// 상태 라벨. 서버의 `State*` 와 짝이며, 그 판정은 `git submodule status` 의 접두
// 문자에서 온다 (FR-SUB-2) — 우리가 다시 계산하지 않는다.
const GIT_SUB_STATE_OK='ok';
const GIT_SUB_STATE_UNINIT='uninitialized';
const GIT_SUB_STATE_MODIFIED='modified';
const GIT_SUB_STATE_CONFLICT='conflict';
const GIT_SUB_STATE_LABEL={
  [GIT_SUB_STATE_OK]:'ok',
  [GIT_SUB_STATE_UNINIT]:'uninit',
  [GIT_SUB_STATE_MODIFIED]:'modified',
  [GIT_SUB_STATE_CONFLICT]:'conflict',
};
// 상태 배지는 `<span>` 이라 FR-TIP-1 의 대상이 아니지만, 같은 표면의 툴팁이
// 언어를 섞으면 그것이 더 읽기 어렵다 — 이 탭의 툴팁은 전부 영어다.
const GIT_SUB_STATE_TITLE={
  [GIT_SUB_STATE_OK]:'Checked out at the recorded commit',
  [GIT_SUB_STATE_UNINIT]:'Not initialized — the folder is empty',
  [GIT_SUB_STATE_MODIFIED]:'Checked out at a different commit than recorded',
  [GIT_SUB_STATE_CONFLICT]:'Has a merge conflict',
};
// 행 동작 (FR-SUB-8). 초기화되지 않은 서브모듈에는 `open`·`term` 이 붙지 않는다 —
// 열 저장소가 없고, 눌리지만 아무 일도 하지 않는 버튼은 고장으로 읽힌다
// (FR-GIT-180). 그 자리에는 `init` 이 대신 선다.
const GIT_SUB_ACT_LABEL={open:'Open',init:'Init',update:'Update',sync:'Sync',term:'Shell'};
const GIT_SUB_ACT_TITLE={
  open:'Open this submodule as its own repository window',
  init:'Initialize this submodule and check out its recorded commit',
  update:'Move this submodule to its recorded commit — may overwrite changes inside it',
  sync:'Copy the URL from .gitmodules into this repository config',
  term:'Open a terminal tab in this submodule (in a non-Git window)',
};
// 머리의 일괄 (FR-SUB-9). 대상이 **전부**이므로 라벨이 그것을 말한다.
const GIT_SUB_BULK_LABEL={update:'Update all',sync:'Sync all'};
const GIT_SUB_BULK_TITLE={
  update:'Initialize and update every submodule to its recorded commit',
  sync:'Copy every submodule URL from .gitmodules into this repository config',
};
// FR-SUB-5: `update` 는 파괴적이다 — 서브모듈 안의 커밋되지 않은 변경을 덮을 수
// 있다. `sync` 는 설정만 옮기므로 그렇지 않다.
const GIT_SUB_UPDATE_ACTION='submodule_update';
const GIT_SUB_SYNC_ACTION='submodule_sync';
const GIT_SUB_UPDATE_TITLE=t('git.sub_update_title');
const GIT_SUB_UPDATE_NOTE=t('git.sub_update_note');
const GIT_SUB_SYNC_TITLE=t('git.sub_sync_title');
const GIT_SUB_SYNC_NOTE=t('git.sub_sync_note');
const GIT_SUB_UPDATE_FAIL=t('git.sub_update_fail');
const GIT_SUB_SYNC_FAIL=t('git.sub_sync_fail');
const GIT_SUB_UPDATED=t('git.sub_updated');
const GIT_SUB_SYNCED=t('git.sub_synced');
const GIT_SUB_ALL=t('git.sub_all');
// M8 D-A-27: update 는 작업이다 — 도는 동안의 문구와 취소.
const GIT_SUB_UPDATING=t('git.sub_updating');
const GIT_SUB_UPDATE_CANCELED=t('git.sub_update_canceled');
const GIT_SUB_CANCEL_TITLE=t('git.sub_cancel_title');
const GIT_SUB_CANCEL_NOTE=t('git.sub_cancel_note');

const GIT_WT_CREATE_TITLE=t('git.wt_create_title');
const GIT_WT_CREATE_RUN=t('git.act.wt_create_run');
const GIT_WT_NAME_PH=t('git.wt_name_ph');
const GIT_WT_REF_PH=t('git.wt_ref_ph');
const GIT_WT_OPT_NEWBRANCH=t('git.wt_opt_newbranch');
const GIT_WT_NEED_NAME=t('git.wt_need_name');
const GIT_WT_NEED_REF=t('git.wt_need_ref');
const GIT_WT_CREATED=t('git.wt_created');
const GIT_WT_PINNED=t('git.wt_pinned');
const GIT_WT_PIN_FAIL=t('git.wt_pin_fail');
const GIT_WT_UNPINNED=t('git.wt_unpinned');
const GIT_WT_UNPIN_FAIL=t('git.wt_unpin_fail');
const GIT_WT_REMOVE_TITLE=t('git.wt_remove_title');
const GIT_WT_REMOVE_NOTE=t('git.wt_remove_note');
// 제거는 200 으로 오면서 `removed:false` 일 수 있다 — 사유를 그 자리에 보인다
// (FR-GIT-243: 사용자의 작업을 지우지 않는다).
const GIT_WT_RESIDUE={
  'dirty':t('git.wt_residue.dirty'),
  'unsafe-path':t('git.wt_residue.unsafe_path'),
  'remove-failed':t('git.wt_residue.remove_failed'),
  'branch-retained':t('git.wt_residue.branch_retained'),
};
const GIT_WT_REMOVE_FAIL=t('git.wt_remove_fail');
