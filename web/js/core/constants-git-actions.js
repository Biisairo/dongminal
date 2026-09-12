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
  bad_request:'잘못된 요청입니다',
  confirmation_required:'확인이 필요합니다',
  not_a_git_repo:GIT_ERR_NOT_REPO,
  // FR-RMS-17: 사이드바 핀 행의 title 도 이 표를 지난다 — 사유 코드를 날것으로
  // 보이면 사용자는 그것이 무엇인지 모른다.
  repo_missing:GIT_RMS_PIN_REASON,
  git_missing:GIT_ERR_GIT_MISSING,
  git_timeout:'git 실행이 시간을 초과했습니다',
  git_failed:'git 이 실패했습니다',
  git_unavailable:'git 을 쓸 수 없습니다',
  // 원격 작업 고유의 거부 (FR-GIT-101). 라벨을 한 자리에 둔다.
  job_busy:'이 저장소의 원격 작업이 이미 진행 중입니다',
  job_not_found:'그 작업을 찾을 수 없습니다',
  no_remote:'밀 원격을 정할 수 없습니다',
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
  [GIT_OP_MERGE]:'머지가 진행 중입니다',
  [GIT_OP_REBASE]:'리베이스가 진행 중입니다',
  [GIT_OP_CHERRY]:'체리픽이 진행 중입니다',
  [GIT_OP_REVERT]:'리버트가 진행 중입니다',
  // FR-GDT-19: 종전에는 이것이 "리베이스가 진행 중입니다" 로 보였고, 출구
  // 버튼이 `git rebase --continue/--abort` 를 냈다 — 맞지 않는 명령이다.
  [GIT_OP_AM]:'패치 적용(git am)이 진행 중입니다',
  // FR-GDT-18: 종전에는 감지도 표시도 출구도 없었다 — detached HEAD 로만 보였다.
  [GIT_OP_BISECT]:'bisect 탐색이 진행 중입니다',
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
const GIT_OP_ABORT_TITLE='진행 중인 작업을 중단합니다';
const GIT_OP_ABORT_NOTE='이 작업 중 해결한 내용이 사라집니다 — 저장소가 시작 전 상태로 돌아갑니다.';
// 진행 중 작업 때문에 막힌 메뉴 항목의 사유 (FR-GIT-252).
const GIT_MENU_OP_BUSY='%s — 먼저 그 작업을 끝내거나 중단하세요';

// ── Console 의 검색·replay (GIT_ACTIONS_SRS §3.8 / FR-GIT-281) ──
const GIT_CON_SEARCH_PH='명령·경로·오류 검색';
const GIT_CON_REPLAY='Replay';
// 확인창의 제목이다 — 사용자가 **읽는** 글자이므로 한국어다 (FR-TIP-3).
// 버튼의 툴팁은 `GIT_TIP_CON_REPLAY` 가 따로 든다 (FR-TIP-2).
const GIT_CON_REPLAY_TITLE='이 명령을 다시 실행합니다';
// 다시 도는 것도 같은 문을 지난다 — 그래서 이 실행도 기록에 남고, 원래 것이
// 파괴적이었으면 확인도 파괴적 확인이다.
const GIT_CON_REPLAY_NOTE='서버가 자기 기록에서 꺼낸 명령을 그대로 다시 실행합니다. 저장소 상태가 그때와 다르면 결과도 다릅니다.';
const GIT_ACT_REPLAY='replay';
const GIT_CON_SEARCH_NONE='검색과 일치하는 기록이 없습니다';
// ── 태그 동작 (GIT_ACTIONS_SRS §3.3 / FR-GIT-260~262) ──

// 안내문은 한국어, 버튼은 영어다 (FR-GIT-202).
const GIT_TAG_NEW='새 태그 생성…';
const GIT_TAG_CREATE_AT='여기에 태그 생성…';
const GIT_TAG_CREATE_TITLE='새 태그를 만듭니다';
const GIT_TAG_CREATE_RUN='Create Tag';
const GIT_TAG_NAME_PH='태그 이름 — v1.0.0';
const GIT_TAG_REF_PH='대상 — 비우면 HEAD';
const GIT_TAG_MSG_PH='태그 메시지 — annotated·signed 에만 쓰입니다';
// 종류 (FR-GIT-260). **첫 선택지가 기본이고 그것이 안전한 쪽이다** (FR-GIT-173) —
// lightweight 는 객체를 만들지 않으므로 메시지도 서명 키도 필요 없다. 값은 서버의
// `write.TagKinds` 와 같은 문자열이다.
const GIT_TAG_KIND_LIGHT='';
const GIT_TAG_KIND_ANNOTATED='annotated';
const GIT_TAG_KIND_SIGNED='signed';
const GIT_TAG_KIND_LABEL='종류';
const GIT_TAG_KIND_OPTS=[
  {v:GIT_TAG_KIND_LIGHT,    label:'lightweight (ref 만 만든다)'},
  {v:GIT_TAG_KIND_ANNOTATED,label:'annotated (-a · 메시지가 남는다)'},
  {v:GIT_TAG_KIND_SIGNED,   label:'signed (-s · 서명 키가 필요하다)'},
];
// 입력 중 판정 (FR-GIT-260). 브랜치 생성과 같은 어휘를 쓴다 — 사유가 달라야
// 사용자가 무엇을 할지 안다.
const GIT_TAG_WHY_EMPTY='태그 이름이 필요합니다';
const GIT_TAG_WHY_EXISTS='같은 이름의 태그가 이미 있습니다 — 다른 이름을 쓰세요';
const GIT_TAG_WHY_NEED_MSG='annotated·signed 태그에는 메시지가 필요합니다';
const GIT_TAG_VALIDATE_FAIL='태그 이름을 검사하지 못했습니다';
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
const GIT_TAG_DELETE_TITLE='로컬 태그를 지웁니다';
const GIT_TAG_DELETE_NOTE='로컬에서만 지웁니다 — 원격의 같은 태그는 그대로 남습니다. 아래 명령으로 되살릴 수 있습니다';
const GIT_TAG_DELETE_REMOTE_TITLE='원격의 태그를 지웁니다';
const GIT_TAG_DELETE_REMOTE_NOTE='원격에서만 지웁니다 — 로컬의 같은 태그는 그대로 남습니다. 아래 명령으로 되살릴 수 있습니다';
// 되살릴 oid 를 화면에서 얻지 못한 경우의 자리. 서버는 실행 **전에** 진짜 oid 로
// hint 를 남기므로(FR-GIT-92) 복구 수단 자체가 사라지는 것은 아니다.
const GIT_TAG_OID_UNKNOWN='<oid — /api/git/recovery 에 기록된 값>';
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
const GIT_STASH_COPY_NAME='stash 이름 복사';
const GIT_STASH_COPY_HASH='stash 해시 복사';
const GIT_STASH_BRANCH_TITLE='stash 에서 브랜치를 만듭니다';
const GIT_STASH_BRANCH_RUN='Create';
const GIT_STASH_BRANCH_NAME_PH='브랜치 이름';
const GIT_STASH_BRANCH_NEED_NAME='브랜치 이름이 필요합니다';
// stash 목록 필터 (FR-GIT-272). 메시지와 기준 브랜치를 함께 본다.
const GIT_STASH_FILTER_PH='메시지·브랜치 필터';
const GIT_STASH_FILTER_NONE='필터에 맞는 stash 가 없습니다';

// 파일 우클릭 (FR-GIT-273·274·275)
const GIT_FILE_IGNORE='Add to .gitignore';
const GIT_FILE_OPEN_HEAD='Open File (HEAD)';
const GIT_FILE_HISTORY='File history';

// Blame (FR-GIT-276). 고정 탭을 늘리지 않고 Diff 탭의 **모드**로 둔다 (D8) —
// Diff 탭이 Monaco·파일 선택·큰 파일 잘림 규약을 이미 들고 있다.
const GIT_FILE_BLAME='Blame';
const GIT_BLAME_TOGGLE='Blame';
const GIT_BLAME_TOGGLE_TITLE='Show which commit each line came from';
const GIT_BLAME_LOADING='blame 을 읽는 중…';
const GIT_BLAME_FAIL='blame 을 읽지 못했습니다';
// 아직 커밋되지 않은 줄. git 은 author 를 "Not Committed Yet" 으로 답하지만 그것을
// 사람 이름 자리에 그대로 두면 작성자로 읽힌다.
const GIT_BLAME_UNCOMMITTED='아직 커밋되지 않음';
const GIT_BLAME_EMPTY='blame 할 내용이 없습니다';
const GIT_IGNORE_FAIL='.gitignore 에 추가하지 못했습니다';
const GIT_IGNORE_DUP='이미 .gitignore 에 있습니다';
const GIT_HEAD_OPEN_FAIL='HEAD 의 내용을 열지 못했습니다';
// 워킹 트리의 파일과 구분되지 않으면 사용자는 그 자리의 편집이 저장소에 반영된다고
// 오해한다 — 탭 이름이 그것을 말한다.
const GIT_HEAD_TAB_SUFFIX=' (HEAD)';

// 미커밋 행 (FR-GIT-277). Clean 만 파괴적이다.
const GIT_UNC_STASH='Stash…';
const GIT_UNC_RESET='Reset (mixed)';
const GIT_UNC_CLEAN='Clean';
const GIT_ACT_CLEAN_UNTRACKED='clean_untracked';
const GIT_UNC_CLEAN_TITLE='추적되지 않는 파일을 지웁니다';
// 되살릴 수 없으므로 hint 는 되돌리는 명령이 아니라 **먼저 담아 두는** 명령이다
// (discard 의 선례, FR-GIT-92).
const GIT_UNC_CLEAN_NOTE='추적되지 않는 파일은 git 에 저장된 적이 없어 지운 뒤에는 되살릴 수 없습니다. 지우기 전에 아래 명령으로 담아 둘 수 있습니다.';
const GIT_UNC_CLEAN_CMD='git stash push -u';
const GIT_UNC_NOTHING='대상이 없습니다';
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
const GIT_HUNK_LOADING='조각을 불러오는 중…';
const GIT_HUNK_LOAD_FAIL='조각을 불러오지 못했습니다';
const GIT_HUNK_NONE='이 파일에는 나눌 조각이 없습니다';
// FR-DHB-2: `GIT_HUNK_HINT`·`GIT_HUNK_CLEAR`·`GIT_HUNK_CLEAR_TITLE` 는 폐기됐다 —
// 커스텀 줄 선택의 조작법을 설명하던 말들이고, 그 조작이 Monaco 의 텍스트 선택으로
// 바뀌면서 설명할 것이 없어졌다 (I-2).
//
// 아래 둘은 **남는다** (FR-DHB-3): 고른 범위를 화면이 말해야 하는 자리가 하나 남아
// 있다 — revert 확인 대화의 대상 라벨이다. 무엇을 되돌리는지 밝히지 않는 파괴적
// 확인은 확인이 아니다.
const GIT_HUNK_SEL_LABEL='선택 ';
const GIT_HUNK_SEL_SEP='~';
const GIT_HUNK_TARGET_SEP=' · ';
// revert 는 파괴적이다 (FR-GIT-279) — discard 와 같은 뜻이므로 그 이름을 쓴다.
const GIT_HUNK_REVERT_TITLE='고른 줄을 워킹 트리에서 버립니다';
// O8 의 선례: stash 를 자동 생성하지 않는다 — 실행할 명령을 보여 준다.
const GIT_HUNK_REVERT_NOTE='버리기 전에 아래를 실행하면 파일 전체가 stash 로 남습니다 (자동 실행하지 않습니다)';
// 부분 스테이징 고유의 거부. 목록을 두 벌 두지 않으려고 기존 표에 얹는다 —
// 쓰기 실패의 사유를 읽는 자리는 GIT_WRITE_ERR 하나뿐이어야 한다.
Object.assign(GIT_WRITE_ERR,{
  stale_observation:'그 사이 파일이 바뀌었습니다 — 조각을 다시 받아 고르세요',
  patch_empty:'고른 범위에 바뀐 줄이 없습니다',
});
// ── 원격 동작 (FR-GIT-269~271) ──

// FR-GIT-269: Branches 탭의 원격 목록. **URL 은 서버가 자격증명을 지운 값이다**
// (FR-GIT-104) — 화면이 다시 가리지 않는다. 가리는 자리가 둘이면 한쪽만 고쳐진다.
const GIT_RM_TITLE='Remotes';
const GIT_RM_ADD='+ Add Remote';
const GIT_RM_ADD_TITLE='Add a new remote (git remote add)';
const GIT_RM_EMPTY='원격이 없습니다';
const GIT_RM_LOAD_FAIL='원격 목록을 불러오지 못했습니다';
const GIT_RM_REMOVE='Remove';

const GIT_RM_PUSH_PREFIX='push → ';
// 자격증명이 박힌 URL 은 그 자리가 가려져 온다. 가려졌다는 사실을 말하지 않으면
// 사용자는 URL 이 그렇게 저장돼 있다고 읽는다.
const GIT_RM_MASK='***';
const GIT_RM_MASK_TITLE='URL 에 자격증명이 박혀 있어 그 자리를 가렸습니다';
// 생성 다이얼로그 (FR-GIT-171 의 골격을 그대로 쓴다).
const GIT_RM_CREATE_TITLE='새 원격을 더합니다';
const GIT_RM_CREATE_RUN='Add';
const GIT_RM_NAME_PH='이름 — origin, upstream 처럼';
const GIT_RM_URL_PH='URL — https://… 또는 git@host:path.git';
const GIT_RM_WHY_NAME='이름이 필요합니다';
const GIT_RM_WHY_URL='URL 이 필요합니다';
const GIT_RM_ADD_FAIL='원격을 더하지 못했습니다';
// remove 는 **파괴적이 아니다** — 저장소의 객체는 그대로이고 설정만 사라진다.
// 그래서 1단계이며, 그럼에도 되살릴 명령을 보인다 (FR-GIT-92·269).
const GIT_ACT_REMOTE_REMOVE='remote_remove';
const GIT_RM_REMOVE_CONFIRM_TITLE='원격 설정을 지웁니다';
const GIT_RM_REMOVE_NOTE='가져온 객체와 refs/remotes 는 남습니다. 아래로 되살릴 수 있습니다';
const GIT_RM_REMOVE_FAIL='원격을 지우지 못했습니다';

// ── 커밋 동작 (GIT_ACTIONS_SRS §3.4 / FR-GIT-263~267) ──
//
// History 의 커밋 행이 줄 수 있는 것들이다. 안내문은 한국어, 버튼은 영어다
// (FR-GIT-202). 파괴 여부는 **옵션에서 파생한다** — `reset --soft` 는 안전하고
// `--hard` 는 아니므로 항목 하나가 두 성질을 갖는다 (FR-GIT-250.1).

const GIT_CO_CHERRY_LABEL='Cherry-pick';
const GIT_CO_REVERT_LABEL='Revert…';
const GIT_CO_RESET_LABEL='Reset to here…';
const GIT_CO_DROP_LABEL='Drop';
const GIT_CO_MARK_LABEL='비교 기준으로 표시';
const GIT_CO_COMPARE_LABEL='Compare with…';

// 항목이 막히는 사유. `gitOpBusy()` 다음에 오는 그 항목만의 사유다 (FR-GIT-252).
const GIT_CO_WHY_IS_HEAD='현재 HEAD 커밋입니다';
const GIT_CO_WHY_ROOT='첫 커밋에는 부모가 없습니다';
const GIT_CO_WHY_MERGE_DROP='머지 커밋은 이 방법으로 뺄 수 없습니다';

// 머지 커밋의 기준 부모 (FR-GIT-263·264). **묻지 않고 고르면 틀린 부모를 집는다.**
const GIT_CO_MAINLINE_LABEL='기준으로 삼을 부모를 고르세요 (머지 커밋)';
const GIT_CO_MAINLINE_OPT='부모 %n — %s';
// 충돌은 실패가 아니라 진행 중 상태다 (FR-GIT-251·252) — 출구는 Changes 탭에 있다.
const GIT_CO_CONFLICT_NOTE='충돌로 멈추면 Changes 탭 머리에 출구(Continue·Skip·Abort)가 보입니다.';

const GIT_CO_CHERRY_TITLE='이 커밋을 현재 브랜치에 얹습니다';
const GIT_CO_CHERRY_RUN='Cherry-pick';
const GIT_CO_REVERT_TITLE='이 커밋을 되돌리는 커밋을 만듭니다';
const GIT_CO_REVERT_RUN='Revert';
const GIT_CO_REVERT_NOCOMMIT='커밋하지 않고 워킹 트리·index 에만 적용 (--no-commit)';

// Reset to here (FR-GIT-265). 첫 선택지가 기본이고 파괴적인 것이 마지막이다 (O14).
const GIT_CO_RESET_TITLE='현재 브랜치를 이 커밋으로 옮깁니다';
const GIT_CO_RESET_RUN='Reset';
const GIT_CO_RESET_MODE_LABEL='어디까지 되돌릴지';
// 값은 서버의 `write.ResetModes` 와 같은 문자열이어야 한다. 순서가 제시 순서이고
// **첫 값이 기본**이다 (FR-GIT-173) — 파괴적인 것이 마지막이다.
const GIT_CO_RESET_MODE_HARD='hard';
const GIT_CO_RESET_MODES=['mixed','soft',GIT_CO_RESET_MODE_HARD];
const GIT_CO_RESET_MODE_LABELS={
  mixed:'Mixed — index 를 되돌리고 워킹 트리는 남깁니다 (기본)',
  soft:'Soft — 커밋만 되돌리고 index·워킹 트리는 그대로 둡니다',
  hard:'Hard — 워킹 트리까지 되돌립니다 (저장하지 않은 변경을 잃습니다)',
};
const GIT_CO_RESET_COUNT='이 커밋 뒤의 %n개 커밋이 영향을 받습니다';
const GIT_CO_RESET_COUNT_FAIL='영향 커밋 수를 세지 못했습니다';
const GIT_ACT_RESET_HARD='reset_hard';
const GIT_CO_RESET_HARD_TITLE='워킹 트리까지 이 커밋으로 되돌립니다';
const GIT_CO_RESET_HARD_NOTE='저장하지 않은 변경은 git 에 남은 적이 없어 되살릴 값이 없습니다. 아래 명령이 원래 HEAD 로 되돌립니다.';

// Drop (FR-GIT-266). 이름은 서버의 파괴적 목록과 같아야 한다 (FR-GIT-89).
const GIT_ACT_COMMIT_DROP='commit_drop';
const GIT_CO_DROP_TITLE='이 커밋을 히스토리에서 뺍니다';
const GIT_CO_DROP_NOTE='뒤따르는 커밋의 해시가 전부 바뀝니다. 아래 명령이 원래 HEAD 로 되돌립니다.';

// Compare with (FR-GIT-267). **새 축을 만들지 않는다** — 두 리비전은 이미 있는
// commit ↔ parent 축(FR-GIT-138)의 두 끝으로 그대로 들어간다.
const GIT_CO_COMPARE_TITLE='두 리비전을 비교합니다';
const GIT_CO_COMPARE_RUN='Compare';
const GIT_CO_COMPARE_THIS='이 커밋: %s';
const GIT_CO_COMPARE_MARKED='비교 기준: %s';
const GIT_CO_COMPARE_REV_PH='비교할 리비전, 또는 범위 A..B / A...B';
const GIT_CO_COMPARE_PATH_PH='비교할 파일 경로 (리포 기준 상대경로)';
const GIT_CO_WHY_NO_REV='리비전을 입력하세요';
const GIT_CO_WHY_NO_PATH='비교할 파일 경로를 입력하세요';
const GIT_CO_COMPARE_FAIL='리비전을 확인하지 못했습니다';
// 범위 표현. `...` 는 merge-base 를 왼쪽으로 잡으므로 `..` 와 뜻이 다르다.
const GIT_CO_RANGE_SYM='...';
const GIT_CO_RANGE_TWO='..';

// 커밋 동작 고유의 거부 코드. 목록 리터럴을 건드리지 않고 더한다 — 같은 표에
// 여럿이 손대면 한쪽의 추가가 다른 쪽을 지운다.
GIT_WRITE_ERR.merge_parent_required='머지 커밋은 기준 부모를 골라야 합니다';
GIT_WRITE_ERR.reset_mode_invalid='모르는 reset 모드입니다';
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
const GIT_BR_LOCAL_ONLY='로컬 브랜치에서만 쓸 수 있습니다';
const GIT_BR_WHY_SELF='현재 브랜치입니다 — 자기 자신에는 합칠 수 없습니다';
const GIT_BR_WHY_NO_UPSTREAM='upstream 이 설정돼 있지 않습니다';

// Rename (FR-GIT-253). 이름 검사는 생성 다이얼로그와 **같은 자리**를 쓴다.
const GIT_BR_RENAME_TITLE='브랜치 이름 변경';
const GIT_BR_RENAME_RUN='Rename';
const GIT_BR_RENAME_PLACEHOLDER='새 브랜치 이름';

// Delete (FR-GIT-254). action 은 서버의 파괴적 목록(/api/git/policy)의 키다 —
// 목록을 프론트에 복제하지 않는다.
const GIT_ACT_BRANCH_DELETE='branch_delete';
const GIT_BR_DELETE_TITLE='브랜치를 지웁니다';
// BRANCH_MENU_UNIFY_SRS FR-BMU-10: 로컬과 원격을 한 번에. 별도 항목인 것이 요점이다
// — FR-GIT-261 의 "하나가 다른 하나를 자동으로 하지 않는다" 는 그대로 지켜진다.
const GIT_BR_DELETE_BOTH='Delete (local + remote)';
const GIT_BR_DELETE_BOTH_TITLE='로컬 브랜치와 그 원격 브랜치를 함께 지웁니다';
const GIT_BR_DELETE_BOTH_NOTE='로컬과 원격을 되살리려면 아래를 차례로 실행하세요 (자동 실행하지 않습니다)';
const GIT_BR_DELETE_BOTH_FAIL='로컬은 지웠지만 원격을 지우지 못했습니다';
const GIT_BR_DELETE_NOTE='지우기 전 커밋으로 되돌리려면 아래를 실행하세요 (자동 실행하지 않습니다)';
// 미머지 거부는 **실패가 아니라 선택지다.** 목록과 순서는 서버가 주고 라벨만 여기 있다.
const GIT_BR_UNMERGED_TITLE='아직 합쳐지지 않은 브랜치입니다';
const GIT_BR_UNMERGED_LABEL={
  force_delete:'Delete anyway (-D)',
  cancel:'Cancel',
};
// 다중 선택은 Cmd/Ctrl + 클릭이고, 일괄 삭제는 `-d` 로만 한다 (FR-GIT-254).
const GIT_BR_SEL_TITLE='Cmd/Ctrl + 클릭으로 여러 개를 고를 수 있습니다';

// Merge (FR-GIT-255). 다이얼로그는 **영향 범위를 먼저 보인다** (G11).
const GIT_BR_MERGE_TITLE='현재 브랜치에 합칩니다';
const GIT_BR_MERGE_RUN='Merge';
// 첫 선택지가 기본이고 그것이 안전한 쪽이다 (FR-GIT-97·173).
const GIT_BR_MERGE_FIELDS=[
  {key:'mode',type:GIT_DIALOG_RADIO,label:'합치는 방식',opts:[
    {v:'',label:'기본 (git 에 맡김)'},
    {v:'ff-only',label:'fast-forward 만 (--ff-only)'},
    {v:'no-ff',label:'항상 머지 커밋 (--no-ff)'},
    {v:'squash',label:'한 커밋으로 (--squash)'},
  ]},
];
const GIT_BR_MERGE_FF='fast-forward 로 끝납니다 — 머지 커밋이 생기지 않습니다';
const GIT_BR_MERGE_NOFF='갈라져 있습니다 — 머지 커밋이 생깁니다';
const GIT_BR_MERGE_UPTODATE='이미 합쳐져 있습니다 — 들어올 커밋이 없습니다';
const GIT_BR_MERGE_INCOMING='들어올 커밋 %n개';
const GIT_BR_MERGE_DIVERGED='이쪽에만 있는 커밋 %n개';
const GIT_BR_MERGE_PREVIEW_FAIL='영향 범위를 확인하지 못했습니다';
// FR-GIT-255: 충돌은 실패가 아니라 **진행 중 상태다** (FR-GIT-251) — pull 이 쓰는
// 경로 그대로 Changes 탭으로 보내고 충돌 그룹을 펼친다 (FR-GIT-111).
const GIT_BR_MERGE_CONFLICT_NOTE='충돌이 남았습니다 — Changes 탭의 충돌 그룹에서 해결한 뒤 Continue 를 누르세요';

// Rebase (FR-GIT-256). **파괴적이다** — action 이 서버 목록의 키이므로 단계 수를
// 이쪽에서 정하지 않는다.
const GIT_ACT_REBASE='rebase';
const GIT_BR_REBASE_TITLE='현재 브랜치를 이 ref 위로 다시 얹습니다';
const GIT_BR_REBASE_NOTE='커밋 해시가 바뀝니다 — 되돌리려면 아래로 원래 자리로 돌아가세요';

// Set / Unset upstream (FR-GIT-257). 대상 목록은 **이미 받아 둔 원격 ref 목록**에서
// 온다 — 새 조회를 만들지 않는다.
const GIT_BR_UPSTREAM_TITLE='upstream 설정';
const GIT_BR_UPSTREAM_RUN='Set';
const GIT_BR_UPSTREAM_PLACEHOLDER='원격 ref (예: origin/main)';
const GIT_BR_UPSTREAM_WHY_EMPTY='원격 ref 를 적으세요';
const GIT_BR_UPSTREAM_WHY_UNKNOWN='그 이름의 원격 ref 가 목록에 없습니다';

// 원격 브랜치 (FR-GIT-268). 삭제는 파괴적이며 hint 는 **되살리는 push** 다.
// GIT_ACT_REMOTE_REF_DELETE 는 태그 원격 삭제(FR-GIT-261)가 이미 선언했다 —
// 원격에서 ref 를 지우는 것은 대상이 브랜치든 태그든 같은 동작이므로 이름도 하나다.
const GIT_BR_REMOTE_DELETE_TITLE='원격의 브랜치를 지웁니다';
const GIT_BR_REMOTE_DELETE_NOTE='되살리려면 아래를 실행하세요 — 지운 뒤에는 원격의 reflog 에만 남습니다';

// 서버가 새로 주는 거부 코드의 라벨. 표를 옮기지 않고 **덧붙인다** — 기존 목록은
// 그대로 두고 이 블록이 자기 몫만 더한다.
Object.assign(GIT_WRITE_ERR,{
  branch_not_merged:'아직 합쳐지지 않은 브랜치입니다',
  branch_is_current:'현재 브랜치는 지울 수 없습니다',
  publish_required:'upstream 설정 확인이 필요합니다',
});
// FR-EDT-71: 색의 근거는 status **하나**다 — 펼침마다 중첩 저장소를 찾으면
// 펼침 수만큼 rev-parse 가 붙는다 (D-6).
const GIT_STATUS_API='/api/git/status';
