/**
 * Remote Terminal — git 동작 상수 (GIT_ACTIONS_SRS)
 *
 * `constants-git.js` 에서 갈라 나왔다 (DRIFT_RECLAIM_SRS FR-DRC-13). 경계는
 * SRS 하나다 — 여기 있는 것은 전부 `GIT_ACTIONS_SRS` 가 정의한 동작들의 라벨·
 * 툴팁·확인 문구이고, 그쪽 파일에 남은 것은 탭과 목록의 것이다.
 *
 * **`GIT_WRITE_ERR` 가 함께 왔다.** 그 표를 채우는 세 문장이 전부 이 파일에
 * 있기 때문이다 — 선언과 채움이 갈라지면 어느 코드가 어떤 사유를 아는지 읽을 수
 * 없다. 종전에는 선언만 1,200줄 앞에 있었다.
 *
 * `constants-git.js` **뒤**에 로드된다 — 이 파일의 값 몇이 그쪽 상수를 참조한다.
 */

const GIT_WRITE_ERR={
  bad_request:t('git.write_err.bad_request'),
  confirmation_required:t('git.write_err.confirmation_required'),
  not_a_git_repo:GIT_ERR_NOT_REPO,
  // FR-RMS-17: 사이드바 핀 행의 title 도 이 표를 지난다 — 사유 코드를 날것으로
  // 보이면 사용자는 그것이 무엇인지 모른다.
  repo_missing:GIT_RMS_PIN_REASON,
  git_missing:GIT_ERR_GIT_MISSING,
  git_timeout:t('git.write_err.git_timeout'),
  git_failed:t('git.write_err.git_failed'),
  git_unavailable:t('git.write_err.git_unavailable'),
  // 원격 작업 고유의 거부 (FR-GIT-101). 라벨을 한 자리에 둔다.
  job_busy:t('git.write_err.job_busy'),
  job_not_found:t('git.write_err.job_not_found'),
  no_remote:t('git.write_err.no_remote'),
};

// ── 진행 중 작업 (GIT_ACTIONS_SRS §3.1 / FR-GIT-251·252) ──
//
// merge·rebase·cherry-pick·revert 가 충돌로 멈추면 중간 상태가 남는다. 그 사실과
// **나갈 길**이 함께 보이지 않으면 사용자는 GUI 안에 갇힌다.
const GIT_OP_MERGE='merge';
const GIT_OP_REBASE='rebase';
const GIT_OP_CHERRY='cherry-pick';
const GIT_OP_REVERT='revert';
// GIT_DETECT_TIER_SRS FR-GDT-18·19: 서버가 새로 가르는 둘.
const GIT_OP_AM='am';
const GIT_OP_BISECT='bisect';
const GIT_OP_LABEL={
  [GIT_OP_MERGE]:t('git.op_label.merge'),
  [GIT_OP_REBASE]:t('git.op_label.rebase'),
  [GIT_OP_CHERRY]:t('git.op_label.cherry'),
  [GIT_OP_REVERT]:t('git.op_label.revert'),
  // FR-GDT-19: 종전에는 이것이 "리베이스가 진행 중입니다" 로 보였고, 출구
  // 버튼이 `git rebase --continue/--abort` 를 냈다 — 맞지 않는 명령이다.
  [GIT_OP_AM]:t('git.op_label.am'),
  // FR-GDT-18: 종전에는 감지도 표시도 출구도 없었다 — detached HEAD 로만 보였다.
  [GIT_OP_BISECT]:t('git.op_label.bisect'),
};
// 리베이스의 "몇 번째 중". 보이지 않으면 사용자는 끝났는지 알 수 없다.
const GIT_OP_AT='%n/%t';
const GIT_OP_CONTINUE='continue';
const GIT_OP_SKIP='skip';
const GIT_OP_ABORT='abort';
// 순서는 서버가 준다 (`/api/git/policy` 의 operations) — 목록을 여기 복제하면
// merge 에 없는 Skip 이 생기고, 눌리면 exit 128 로만 실패한다. 이 표는 **라벨**뿐이다.
const GIT_OP_ACT_LABEL={
  [GIT_OP_CONTINUE]:'Continue',
  [GIT_OP_SKIP]:'Skip',
  [GIT_OP_ABORT]:'Abort',
};
const GIT_OP_ACT_TITLE={
  [GIT_OP_CONTINUE]:'Continue with what you resolved',
  [GIT_OP_SKIP]:'Skip this commit',
  [GIT_OP_ABORT]:'Abort and go back to the state before this operation',
};
const GIT_ACT_OP_ABORT='operation_abort';
const GIT_OP_ABORT_TITLE=t('git.op_abort_title');
const GIT_OP_ABORT_NOTE=t('git.op_abort_note');
// 진행 중 작업 때문에 막힌 메뉴 항목의 사유 (FR-GIT-252).
const GIT_MENU_OP_BUSY=t('git.menu_op_busy');

// ── Console 의 검색·replay (GIT_ACTIONS_SRS §3.8 / FR-GIT-281) ──
const GIT_CON_SEARCH_PH=t('git.con_search_ph');
const GIT_CON_REPLAY='Replay';
// 확인창의 제목이다 — 사용자가 **읽는** 글자이므로 한국어다 (FR-TIP-3).
// 버튼의 툴팁은 `GIT_TIP_CON_REPLAY` 가 따로 든다 (FR-TIP-2).
const GIT_CON_REPLAY_TITLE=t('git.con_replay_title');
// 다시 도는 것도 같은 문을 지난다 — 그래서 이 실행도 기록에 남고, 원래 것이
// 파괴적이었으면 확인도 파괴적 확인이다.
const GIT_CON_REPLAY_NOTE=t('git.con_replay_note');
const GIT_ACT_REPLAY='replay';
const GIT_CON_SEARCH_NONE=t('git.con_search_none');
// ── 태그 동작 (GIT_ACTIONS_SRS §3.3 / FR-GIT-260~262) ──

// 안내문은 한국어, 버튼은 영어다 (FR-GIT-202).
const GIT_TAG_NEW=t('git.tag_new');
const GIT_TAG_CREATE_AT=t('git.tag_create_at');
const GIT_TAG_CREATE_TITLE=t('git.tag_create_title');
const GIT_TAG_CREATE_RUN='Create Tag';
const GIT_TAG_NAME_PH=t('git.tag_name_ph');
const GIT_TAG_REF_PH=t('git.tag_ref_ph');
const GIT_TAG_MSG_PH=t('git.tag_msg_ph');
// 종류 (FR-GIT-260). **첫 선택지가 기본이고 그것이 안전한 쪽이다** (FR-GIT-173) —
// lightweight 는 객체를 만들지 않으므로 메시지도 서명 키도 필요 없다. 값은 서버의
// `write.TagKinds` 와 같은 문자열이다.
const GIT_TAG_KIND_LIGHT='';
const GIT_TAG_KIND_ANNOTATED='annotated';
const GIT_TAG_KIND_SIGNED='signed';
const GIT_TAG_KIND_LABEL=t('git.tag_kind_label');
const GIT_TAG_KIND_OPTS=[
  {v:GIT_TAG_KIND_LIGHT,    label:t('git.tag_kind_opts.light')},
  {v:GIT_TAG_KIND_ANNOTATED,label:t('git.tag_kind_opts.annotated')},
  {v:GIT_TAG_KIND_SIGNED,   label:t('git.tag_kind_opts.signed')},
];
// 입력 중 판정 (FR-GIT-260). 브랜치 생성과 같은 어휘를 쓴다 — 사유가 달라야
// 사용자가 무엇을 할지 안다.
const GIT_TAG_WHY_EMPTY=t('git.tag_why_empty');
const GIT_TAG_WHY_EXISTS=t('git.tag_why_exists');
const GIT_TAG_WHY_NEED_MSG=t('git.tag_why_need_msg');
const GIT_TAG_VALIDATE_FAIL=t('git.tag_validate_fail');
// 메뉴 항목 (FR-GIT-261·262). 로컬과 원격은 **다른 항목**이다 — 하나가 다른 하나를
// 자동으로 하지 않는다.
const GIT_TAG_PUSH='Push to remote';
const GIT_TAG_PUSH_ALL='Push all tags';
const GIT_TAG_DELETE='Delete (local)';
const GIT_TAG_DELETE_REMOTE='Delete (remote)';
// 확인 (FR-GIT-89·92). 이름은 서버의 파괴적 목록(/api/git/policy)의 키이며 목록을
// 복제하지 않는다.
const GIT_ACT_TAG_DELETE='tag_delete';
const GIT_ACT_REMOTE_REF_DELETE='remote_ref_delete';
const GIT_TAG_DELETE_TITLE=t('git.tag_delete_title');
const GIT_TAG_DELETE_NOTE=t('git.tag_delete_note');
const GIT_TAG_DELETE_REMOTE_TITLE=t('git.tag_delete_remote_title');
const GIT_TAG_DELETE_REMOTE_NOTE=t('git.tag_delete_remote_note');
// 되살릴 oid 를 화면에서 얻지 못한 경우의 자리. 서버는 실행 **전에** 진짜 oid 로
// hint 를 남기므로(FR-GIT-92) 복구 수단 자체가 사라지는 것은 아니다.
const GIT_TAG_OID_UNKNOWN=t('git.tag_oid_unknown');
// 원격 이름을 클라이언트가 정하지 않는다 (FR-GIT-100 과 같은 규약) — 요청은 빈
// 값으로 보내고 서버가 정한다. 이 값은 **확인 문구에 보일 명령**의 자리를 채울
// 뿐이며, 저장소의 upstream 에서 뽑지 못했을 때만 쓰인다.
const GIT_TAG_REMOTE_FALLBACK='origin';
// 원격을 지나는 태그 동작의 라우트. `GitRemote.run` 은 kind 로 URL 을 만들므로
// 기본 규칙(`/api/git/<kind>`)과 다른 것만 여기 둔다 (FR-GIT-262).
const GIT_TAG_KIND_PUSH='tag-push';
const GIT_TAG_KIND_DELETE_REMOTE='tag-delete-remote';
const GIT_REMOTE_URL={
  [GIT_TAG_KIND_PUSH]:'/api/git/tag/push',
  [GIT_TAG_KIND_DELETE_REMOTE]:'/api/git/tag/delete-remote',
};
// ── stash·파일·미커밋 동작 (FR-GIT-272~277) ──
// 안내문은 한국어, 버튼은 영어다 (FR-GIT-202). 확인은 항목이 쓰지 않는다 —
// `warn`/`destructive` 선언만 하면 GitMenu 가 GitDialog/GitConfirm 을 거친다.

// stash 우클릭 (FR-GIT-272)
const GIT_STASH_BRANCH='Branch from stash…';
const GIT_STASH_COPY_NAME=t('git.stash_copy_name');
const GIT_STASH_COPY_HASH=t('git.stash_copy_hash');
const GIT_STASH_BRANCH_TITLE=t('git.stash_branch_title');
const GIT_STASH_BRANCH_RUN='Create';
const GIT_STASH_BRANCH_NAME_PH=t('git.stash_branch_name_ph');
const GIT_STASH_BRANCH_NEED_NAME=t('git.stash_branch_need_name');
// stash 목록 필터 (FR-GIT-272). 메시지와 기준 브랜치를 함께 본다.
const GIT_STASH_FILTER_PH=t('git.stash_filter_ph');
const GIT_STASH_FILTER_NONE=t('git.stash_filter_none');

// 파일 우클릭 (FR-GIT-273·274·275)
const GIT_FILE_IGNORE='Add to .gitignore';
const GIT_FILE_OPEN_HEAD='Open File (HEAD)';
const GIT_FILE_HISTORY='File history';

// Blame (FR-GIT-276). 고정 탭을 늘리지 않고 Diff 탭의 **모드**로 둔다 (D8) —
// Diff 탭이 Monaco·파일 선택·큰 파일 잘림 규약을 이미 들고 있다.
const GIT_FILE_BLAME='Blame';
const GIT_BLAME_TOGGLE='Blame';
const GIT_BLAME_TOGGLE_TITLE='Show which commit each line came from';
const GIT_BLAME_LOADING=t('git.blame_loading');
const GIT_BLAME_FAIL=t('git.blame_fail');
// 아직 커밋되지 않은 줄. git 은 author 를 "Not Committed Yet" 으로 답하지만 그것을
// 사람 이름 자리에 그대로 두면 작성자로 읽힌다.
const GIT_BLAME_UNCOMMITTED=t('git.blame_uncommitted');
const GIT_BLAME_EMPTY=t('git.blame_empty');
const GIT_IGNORE_FAIL=t('git.ignore_fail');
const GIT_IGNORE_DUP=t('git.ignore_dup');
const GIT_HEAD_OPEN_FAIL=t('git.head_open_fail');
// 워킹 트리의 파일과 구분되지 않으면 사용자는 그 자리의 편집이 저장소에 반영된다고
// 오해한다 — 탭 이름이 그것을 말한다.
const GIT_HEAD_TAB_SUFFIX=' (HEAD)';

// 미커밋 행 (FR-GIT-277). Clean 만 파괴적이다.
const GIT_UNC_STASH='Stash…';
const GIT_UNC_RESET='Reset (mixed)';
const GIT_UNC_CLEAN='Clean';
const GIT_ACT_CLEAN_UNTRACKED='clean_untracked';
const GIT_UNC_CLEAN_TITLE=t('git.unc_clean_title');
// 되살릴 수 없으므로 hint 는 되돌리는 명령이 아니라 **먼저 담아 두는** 명령이다
// (discard 의 선례, FR-GIT-92).
const GIT_UNC_CLEAN_NOTE=t('git.unc_clean_note');
const GIT_UNC_CLEAN_CMD='git stash push -u';
const GIT_UNC_NOTHING=t('git.unc_nothing');
// ── 부분 스테이징 (FR-GIT-278·279) ──
//
// 패치는 **서버가 만든다** (GIT_ACTIONS_SRS D6). 클라이언트는 좌표만 보낸다 —
// (경로, 축, hunk 번호, 줄 범위, 관측 식별자). 패치 문자열을 만드는 코드가 이쪽에
// 없어야 하고, 그래서 여기에는 라벨과 축 표만 있다.
const GIT_PATCH_STAGE='stage';
const GIT_PATCH_UNSTAGE='unstage';
const GIT_PATCH_REVERT='revert';
// 부분 스테이징이 있는 축은 둘뿐이다 — 서버가 그 둘만 받는다. 충돌·커밋 축에는
// 방향이 정해지지 않아 조각을 넣을 수 없다.
const GIT_HUNK_AXES=new Set([GIT_AXIS.UNSTAGED,GIT_AXIS.STAGED]);
// 축마다 붙는 동작. **방향이 축에서 갈린다** — worktree↔index 는 올리고 버리는
// 축이고, index↔HEAD 는 내리는 축이다.
const GIT_HUNK_ACTS={
  [GIT_AXIS.UNSTAGED]:[GIT_PATCH_STAGE,GIT_PATCH_REVERT],
  [GIT_AXIS.STAGED]:[GIT_PATCH_UNSTAGE],
};
// 버튼은 영어다 (FR-GIT-202). 줄 범위를 골랐을 때는 라벨이 바뀐다 — 무엇에 걸리는
// 동작인지 누르기 전에 보여야 한다.
const GIT_HUNK_LABEL={stage:'Stage hunk',unstage:'Unstage hunk',revert:'Revert hunk'};
const GIT_HUNK_LINE_LABEL={stage:'Stage lines',unstage:'Unstage lines',revert:'Revert lines'};
// DIFF_HUNK_BAR_SRS FR-DHB-10·21: 커서 툴바는 Monaco content widget 하나다.
// id 는 그 위젯을 다시 찾는 열쇠이므로 문자열을 한 자리에만 둔다.
const GIT_HUNK_BAR_ID='git.hunk.bar';
const GIT_HUNK_TITLE={
  stage:'Stage only this hunk',
  unstage:'Unstage only this hunk',
  revert:'Discard this hunk from the working tree — this cannot be undone',
};
// DIFF_HUNK_BAR_SRS FR-DHB-2: `GIT_HUNK_LINE_CLASS` 는 폐기됐다 — 하단 목록이
// unified diff 를 한 줄씩 다시 그리던 시절의 색표다. 그 diff 는 이제 Monaco 가
// 그리고 색도 그쪽 테마에서 온다.
const GIT_HUNK_LOADING=t('git.hunk_loading');
const GIT_HUNK_LOAD_FAIL=t('git.hunk_load_fail');
const GIT_HUNK_NONE=t('git.hunk_none');
// FR-DHB-2: `GIT_HUNK_HINT`·`GIT_HUNK_CLEAR`·`GIT_HUNK_CLEAR_TITLE` 는 폐기됐다 —
// 커스텀 줄 선택의 조작법을 설명하던 말들이고, 그 조작이 Monaco 의 텍스트 선택으로
// 바뀌면서 설명할 것이 없어졌다 (I-2).
//
// 아래 둘은 **남는다** (FR-DHB-3): 고른 범위를 화면이 말해야 하는 자리가 하나 남아
// 있다 — revert 확인 대화의 대상 라벨이다. 무엇을 되돌리는지 밝히지 않는 파괴적
// 확인은 확인이 아니다.
const GIT_HUNK_SEL_LABEL=t('git.hunk_sel_label');
const GIT_HUNK_SEL_SEP='~';
const GIT_HUNK_TARGET_SEP=' · ';
// revert 는 파괴적이다 (FR-GIT-279) — discard 와 같은 뜻이므로 그 이름을 쓴다.
const GIT_HUNK_REVERT_TITLE=t('git.hunk_revert_title');
// O8 의 선례: stash 를 자동 생성하지 않는다 — 실행할 명령을 보여 준다.
const GIT_HUNK_REVERT_NOTE=t('git.hunk_revert_note');
// 부분 스테이징 고유의 거부. 목록을 두 벌 두지 않으려고 기존 표에 얹는다 —
// 쓰기 실패의 사유를 읽는 자리는 GIT_WRITE_ERR 하나뿐이어야 한다.
Object.assign(GIT_WRITE_ERR,{
  stale_observation:t('git.hunk_revert_note.stale_observation'),
  patch_empty:t('git.hunk_revert_note.patch_empty'),
});
// ── 원격 동작 (FR-GIT-269~271) ──

// FR-GIT-269: Branches 탭의 원격 목록. **URL 은 서버가 자격증명을 지운 값이다**
// (FR-GIT-104) — 화면이 다시 가리지 않는다. 가리는 자리가 둘이면 한쪽만 고쳐진다.
const GIT_RM_TITLE='Remotes';
const GIT_RM_ADD='+ Add Remote';
const GIT_RM_ADD_TITLE='Add a new remote (git remote add)';
const GIT_RM_EMPTY=t('git.rm_empty');
const GIT_RM_LOAD_FAIL=t('git.rm_load_fail');
const GIT_RM_REMOVE='Remove';

const GIT_RM_PUSH_PREFIX='push → ';
// 자격증명이 박힌 URL 은 그 자리가 가려져 온다. 가려졌다는 사실을 말하지 않으면
// 사용자는 URL 이 그렇게 저장돼 있다고 읽는다.
const GIT_RM_MASK='***';
const GIT_RM_MASK_TITLE=t('git.rm_mask_title');
// 생성 다이얼로그 (FR-GIT-171 의 골격을 그대로 쓴다).
const GIT_RM_CREATE_TITLE=t('git.rm_create_title');
const GIT_RM_CREATE_RUN='Add';
const GIT_RM_NAME_PH=t('git.rm_name_ph');
const GIT_RM_URL_PH=t('git.rm_url_ph');
const GIT_RM_WHY_NAME=t('git.rm_why_name');
const GIT_RM_WHY_URL=t('git.rm_why_url');
const GIT_RM_ADD_FAIL=t('git.rm_add_fail');
// remove 는 **파괴적이 아니다** — 저장소의 객체는 그대로이고 설정만 사라진다.
// 그래서 1단계이며, 그럼에도 되살릴 명령을 보인다 (FR-GIT-92·269).
const GIT_ACT_REMOTE_REMOVE='remote_remove';
const GIT_RM_REMOVE_CONFIRM_TITLE=t('git.rm_remove_confirm_title');
const GIT_RM_REMOVE_NOTE=t('git.rm_remove_note');
const GIT_RM_REMOVE_FAIL=t('git.rm_remove_fail');

// ── 커밋 동작 (GIT_ACTIONS_SRS §3.4 / FR-GIT-263~267) ──
//
// History 의 커밋 행이 줄 수 있는 것들이다. 안내문은 한국어, 버튼은 영어다
// (FR-GIT-202). 파괴 여부는 **옵션에서 파생한다** — `reset --soft` 는 안전하고
// `--hard` 는 아니므로 항목 하나가 두 성질을 갖는다 (FR-GIT-250.1).

const GIT_CO_CHERRY_LABEL='Cherry-pick';
const GIT_CO_REVERT_LABEL='Revert…';
const GIT_CO_RESET_LABEL='Reset to here…';
const GIT_CO_DROP_LABEL='Drop';
const GIT_CO_MARK_LABEL=t('git.co_mark_label');
const GIT_CO_COMPARE_LABEL='Compare with…';

// 항목이 막히는 사유. `gitOpBusy()` 다음에 오는 그 항목만의 사유다 (FR-GIT-252).
const GIT_CO_WHY_IS_HEAD=t('git.co_why_is_head');
const GIT_CO_WHY_ROOT=t('git.co_why_root');
const GIT_CO_WHY_MERGE_DROP=t('git.co_why_merge_drop');

// 머지 커밋의 기준 부모 (FR-GIT-263·264). **묻지 않고 고르면 틀린 부모를 집는다.**
const GIT_CO_MAINLINE_LABEL=t('git.co_mainline_label');
const GIT_CO_MAINLINE_OPT=t('git.co_mainline_opt');
// 충돌은 실패가 아니라 진행 중 상태다 (FR-GIT-251·252) — 출구는 Changes 탭에 있다.
const GIT_CO_CONFLICT_NOTE=t('git.co_conflict_note');

const GIT_CO_CHERRY_TITLE=t('git.co_cherry_title');
const GIT_CO_CHERRY_RUN='Cherry-pick';
const GIT_CO_REVERT_TITLE=t('git.co_revert_title');
const GIT_CO_REVERT_RUN='Revert';
const GIT_CO_REVERT_NOCOMMIT=t('git.co_revert_nocommit');

// Reset to here (FR-GIT-265). 첫 선택지가 기본이고 파괴적인 것이 마지막이다 (O14).
const GIT_CO_RESET_TITLE=t('git.co_reset_title');
const GIT_CO_RESET_RUN='Reset';
const GIT_CO_RESET_MODE_LABEL=t('git.co_reset_mode_label');
// 값은 서버의 `write.ResetModes` 와 같은 문자열이어야 한다. 순서가 제시 순서이고
// **첫 값이 기본**이다 (FR-GIT-173) — 파괴적인 것이 마지막이다.
const GIT_CO_RESET_MODE_HARD='hard';
const GIT_CO_RESET_MODES=['mixed','soft',GIT_CO_RESET_MODE_HARD];
const GIT_CO_RESET_MODE_LABELS={
  mixed:t('git.co_reset_mode_labels.mixed'),
  soft:t('git.co_reset_mode_labels.soft'),
  hard:t('git.co_reset_mode_labels.hard'),
};
const GIT_CO_RESET_COUNT=t('git.co_reset_count');
const GIT_CO_RESET_COUNT_FAIL=t('git.co_reset_count_fail');
const GIT_ACT_RESET_HARD='reset_hard';
const GIT_CO_RESET_HARD_TITLE=t('git.co_reset_hard_title');
const GIT_CO_RESET_HARD_NOTE=t('git.co_reset_hard_note');

// Drop (FR-GIT-266). 이름은 서버의 파괴적 목록과 같아야 한다 (FR-GIT-89).
const GIT_ACT_COMMIT_DROP='commit_drop';
const GIT_CO_DROP_TITLE=t('git.co_drop_title');
const GIT_CO_DROP_NOTE=t('git.co_drop_note');

// Compare with (FR-GIT-267). **새 축을 만들지 않는다** — 두 리비전은 이미 있는
// commit ↔ parent 축(FR-GIT-138)의 두 끝으로 그대로 들어간다.
const GIT_CO_COMPARE_TITLE=t('git.co_compare_title');
const GIT_CO_COMPARE_RUN='Compare';
const GIT_CO_COMPARE_THIS=t('git.co_compare_this');
const GIT_CO_COMPARE_MARKED=t('git.co_compare_marked');
const GIT_CO_COMPARE_REV_PH=t('git.co_compare_rev_ph');
const GIT_CO_COMPARE_PATH_PH=t('git.co_compare_path_ph');
const GIT_CO_WHY_NO_REV=t('git.co_why_no_rev');
const GIT_CO_WHY_NO_PATH=t('git.co_why_no_path');
const GIT_CO_COMPARE_FAIL=t('git.co_compare_fail');
// 범위 표현. `...` 는 merge-base 를 왼쪽으로 잡으므로 `..` 와 뜻이 다르다.
const GIT_CO_RANGE_SYM='...';
const GIT_CO_RANGE_TWO='..';

// 커밋 동작 고유의 거부 코드. 목록 리터럴을 건드리지 않고 더한다 — 같은 표에
// 여럿이 손대면 한쪽의 추가가 다른 쪽을 지운다.
GIT_WRITE_ERR.merge_parent_required=t('git.write_err.merge_parent_required');
GIT_WRITE_ERR.reset_mode_invalid=t('git.write_err.reset_mode_invalid');
// ── 브랜치 동작 (GIT_ACTIONS_SRS §3.2 / FR-GIT-253~259 · §3.5 FR-GIT-268) ──
//
// 접수한 말의 본체다: "branch 삭제, 이름변경 등 기본적인 기능들이 없다."
// 안내문은 한국어이고 메뉴 항목·버튼은 영어다 (FR-GIT-202).

// 메뉴 항목의 라벨. 로컬과 원격은 **뜻이 다른 항목**이라 같은 메뉴에 함께 서고,
// 어느 쪽이 왜 막혔는지는 사유로 알린다 (checkout·checkout-local 과 같은 규약).
const GIT_BR_RENAME='Rename…';
const GIT_BR_DELETE='Delete';
const GIT_BR_MERGE='Merge into current';
const GIT_BR_REBASE='Rebase onto…';
const GIT_BR_SET_UPSTREAM='Set upstream…';
const GIT_BR_UNSET_UPSTREAM='Unset upstream';
const GIT_BR_PUSH='Push';
const GIT_BR_CREATE_FROM='Create Branch from…';
const GIT_BR_REMOTE_FETCH='Fetch into local';
const GIT_BR_REMOTE_DELETE='Delete remote branch';

// 비활성 사유. 왜 못 누르는지 보이지 않으면 사용자는 고장으로 읽는다 (FR-GIT-180).
const GIT_BR_LOCAL_ONLY=t('git.br_local_only');
const GIT_BR_WHY_SELF=t('git.br_why_self');
const GIT_BR_WHY_NO_UPSTREAM=t('git.br_why_no_upstream');

// Rename (FR-GIT-253). 이름 검사는 생성 다이얼로그와 **같은 자리**를 쓴다.
const GIT_BR_RENAME_TITLE=t('git.br_rename_title');
const GIT_BR_RENAME_RUN='Rename';
const GIT_BR_RENAME_PLACEHOLDER=t('git.br_rename_placeholder');

// Delete (FR-GIT-254). action 은 서버의 파괴적 목록(/api/git/policy)의 키다 —
// 목록을 프론트에 복제하지 않는다.
const GIT_ACT_BRANCH_DELETE='branch_delete';
const GIT_BR_DELETE_TITLE=t('git.br_delete_title');
// BRANCH_MENU_UNIFY_SRS FR-BMU-10: 로컬과 원격을 한 번에. 별도 항목인 것이 요점이다
// — FR-GIT-261 의 "하나가 다른 하나를 자동으로 하지 않는다" 는 그대로 지켜진다.
const GIT_BR_DELETE_BOTH='Delete (local + remote)';
const GIT_BR_DELETE_BOTH_TITLE=t('git.br_delete_both_title');
const GIT_BR_DELETE_BOTH_NOTE=t('git.br_delete_both_note');
const GIT_BR_DELETE_BOTH_FAIL=t('git.br_delete_both_fail');
const GIT_BR_DELETE_NOTE=t('git.br_delete_note');
// 미머지 거부는 **실패가 아니라 선택지다.** 목록과 순서는 서버가 주고 라벨만 여기 있다.
const GIT_BR_UNMERGED_TITLE=t('git.br_unmerged_title');
const GIT_BR_UNMERGED_LABEL={
  force_delete:'Delete anyway (-D)',
  cancel:'Cancel',
};
// 다중 선택은 Cmd/Ctrl + 클릭이고, 일괄 삭제는 `-d` 로만 한다 (FR-GIT-254).
const GIT_BR_SEL_TITLE=t('git.br_sel_title');

// Merge (FR-GIT-255). 다이얼로그는 **영향 범위를 먼저 보인다** (G11).
const GIT_BR_MERGE_TITLE=t('git.br_merge_title');
const GIT_BR_MERGE_RUN='Merge';
// 첫 선택지가 기본이고 그것이 안전한 쪽이다 (FR-GIT-97·173).
const GIT_BR_MERGE_FIELDS=[
  {key:'mode',type:GIT_DIALOG_RADIO,label:t('git.br_merge_fields.mode_label'),opts:[
    {v:'',label:t('git.br_merge_fields.default_label')},
    {v:'ff-only',label:t('git.br_merge_fields.ff_only_label')},
    {v:'no-ff',label:t('git.br_merge_fields.no_ff_label')},
    {v:'squash',label:t('git.br_merge_fields.squash_label')},
  ]},
];
const GIT_BR_MERGE_FF=t('git.br_merge_ff');
const GIT_BR_MERGE_NOFF=t('git.br_merge_noff');
const GIT_BR_MERGE_UPTODATE=t('git.br_merge_uptodate');
const GIT_BR_MERGE_INCOMING=t('git.br_merge_incoming');
const GIT_BR_MERGE_DIVERGED=t('git.br_merge_diverged');
const GIT_BR_MERGE_PREVIEW_FAIL=t('git.br_merge_preview_fail');
// FR-GIT-255: 충돌은 실패가 아니라 **진행 중 상태다** (FR-GIT-251) — pull 이 쓰는
// 경로 그대로 Changes 탭으로 보내고 충돌 그룹을 펼친다 (FR-GIT-111).
const GIT_BR_MERGE_CONFLICT_NOTE=t('git.br_merge_conflict_note');

// Rebase (FR-GIT-256). **파괴적이다** — action 이 서버 목록의 키이므로 단계 수를
// 이쪽에서 정하지 않는다.
const GIT_ACT_REBASE='rebase';
const GIT_BR_REBASE_TITLE=t('git.br_rebase_title');
const GIT_BR_REBASE_NOTE=t('git.br_rebase_note');

// Set / Unset upstream (FR-GIT-257). 대상 목록은 **이미 받아 둔 원격 ref 목록**에서
// 온다 — 새 조회를 만들지 않는다.
const GIT_BR_UPSTREAM_TITLE=t('git.br_upstream_title');
const GIT_BR_UPSTREAM_RUN='Set';
const GIT_BR_UPSTREAM_PLACEHOLDER=t('git.br_upstream_placeholder');
const GIT_BR_UPSTREAM_WHY_EMPTY=t('git.br_upstream_why_empty');
const GIT_BR_UPSTREAM_WHY_UNKNOWN=t('git.br_upstream_why_unknown');

// 원격 브랜치 (FR-GIT-268). 삭제는 파괴적이며 hint 는 **되살리는 push** 다.
// GIT_ACT_REMOTE_REF_DELETE 는 태그 원격 삭제(FR-GIT-261)가 이미 선언했다 —
// 원격에서 ref 를 지우는 것은 대상이 브랜치든 태그든 같은 동작이므로 이름도 하나다.
const GIT_BR_REMOTE_DELETE_TITLE=t('git.br_remote_delete_title');
const GIT_BR_REMOTE_DELETE_NOTE=t('git.br_remote_delete_note');

// 서버가 새로 주는 거부 코드의 라벨. 표를 옮기지 않고 **덧붙인다** — 기존 목록은
// 그대로 두고 이 블록이 자기 몫만 더한다.
Object.assign(GIT_WRITE_ERR,{
  branch_not_merged:t('git.br_remote_delete_note.branch_not_merged'),
  branch_is_current:t('git.br_remote_delete_note.branch_is_current'),
  publish_required:t('git.br_remote_delete_note.publish_required'),
});
// FR-EDT-71: 색의 근거는 status **하나**다 — 펼침마다 중첩 저장소를 찾으면
// 펼침 수만큼 rev-parse 가 붙는다 (D-6).
const GIT_STATUS_API='/api/git/status';
