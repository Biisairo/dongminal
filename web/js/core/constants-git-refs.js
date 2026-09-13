/**
 * Dongminal — **Branches · Stash 탭**의 상수 (FE_MODULE_BOUNDARY_SRS FR-FMB-1).
 *
 * 이름 붙은 자리를 다루는 두 탭 — 브랜치와 stash. 둘 다 목록을 그리고, 고르고,
 * 되돌릴 수 없는 동작을 확인받는다.
 *
 * 절과 그 앵커: Branches(GIT_SRS §3D.1 / FR-GIT-147~160) · Stash(§3D.2 /
 * FR-GIT-161~170).
 */
// 목록은 /api/git/refs 다 (FR-GIT-147) — 14단계가 이름·대상·upstream·ahead/behind 를
// 이미 준다. 여기서 새 조회를 만들지 않는다.
const GIT_REF_KIND_LOCAL='local';
const GIT_REF_KIND_REMOTE='remote';
const GIT_REF_KIND_TAG='tag';

// 트리의 최상위 그룹 (FR-GIT-148·149). 즐겨찾기가 가장 위다 — 사용자가 고정한
// 것이 먼저 보이지 않으면 고정의 뜻이 없다.
// 즐겨찾기를 뺀 세 그룹의 key 는 **ref 의 kind 그대로**다 — 두 벌의 이름을 두면
// 한쪽만 고쳐진다.
const GIT_BR_GROUP_FAV='fav';
const GIT_BR_GROUPS=[
  {key:GIT_BR_GROUP_FAV,   name:t('git.br_groups.fav')},
  {key:GIT_REF_KIND_LOCAL, name:t('git.br_groups.local')},
  {key:GIT_REF_KIND_REMOTE,name:t('git.br_groups.remote')},
  {key:GIT_REF_KIND_TAG,   name:t('git.br_groups.tag')},
];
const GIT_BR_SEARCH_PLACEHOLDER=t('git.br_search_placeholder');
const GIT_BR_NEW='+ New Branch';
// FR-TIP-1: 어디에서 갈라지는지가 라벨에 없다 — 그것이 이 버튼의 유일한 물음이다.
const GIT_BR_NEW_TITLE='Create a new branch from the current HEAD';
const GIT_BR_EMPTY=t('git.br_empty');
const GIT_BR_LOAD_FAIL=t('git.br_load_fail');
const GIT_BR_RETRY='Retry';
// 즐겨찾기는 workspace.json 최상위 git.favorites[<repo>] 다 (O13). 접힘 상태는
// 기기별 취향이라 localStorage 다 (FR-GIT-150) — 실제 키는 <이것>:<repo>.
const GIT_BR_FAV_FIELD='favorites';
const GIT_BR_COLLAPSE_KEY='gitBrCollapsed';
const GIT_BR_FAV_MARK='★';
const GIT_BR_FAV_ON_TITLE=t('git.br_fav_on_title');
const GIT_BR_FAV_OFF_TITLE=t('git.br_fav_off_title');
const GIT_BR_CURRENT_MARK='✓';
// 접두사 그룹핑은 이름의 첫 조각이다 (FR-GIT-150).
const GIT_BR_PREFIX_SEP='/';

// FR-GIT-155·156: checkout. 원격 ref 는 같은 이름의 로컬을 만들며 추적을 설정한다 —
// 그러므로 두 항목은 뜻이 다르고, 어느 쪽이 왜 막혔는지 사유로 알린다.
const GIT_BR_CHECKOUT_LOCAL='Checkout as local';
const GIT_MENU_CURRENT=t('git.menu_current');
const GIT_MENU_REMOTE_REF=t('git.menu_remote_ref');
const GIT_MENU_LOCAL_ONLY=t('git.menu_local_only');

// FR-GIT-157 · O14: dirty checkout 의 선택지. **순서가 제시 순서이고 첫 항목이
// 기본**이다 — 기본은 항상 안전한 쪽이다 (FR-GIT-97). 강제는 파괴적이므로
// GitConfirm 의 파괴적 확인을 거친다.
const GIT_DIRTY_OPT_CANCEL='cancel';
const GIT_DIRTY_OPT_STASH='stash';
const GIT_DIRTY_OPT_FORCE='force';
const GIT_DIRTY_OPTS=[
  {id:GIT_DIRTY_OPT_CANCEL,label:'Cancel'},
  {id:GIT_DIRTY_OPT_STASH, label:'Stash and continue'},
  {id:GIT_DIRTY_OPT_FORCE, label:'Force (discard changes)',danger:true},
];
const GIT_DIRTY_TITLE=t('git.dirty_title');
const GIT_DIRTY_NOTE=t('git.dirty_note');
// 강제 checkout 은 워킹 트리의 변경을 버린다. **서버의 파괴적 목록에는 없는 이름**
// 이므로 확인 단계를 명시적으로 2로 요구한다 (계약 §1.1).
const GIT_ACT_CHECKOUT_FORCE='checkout_force';
const GIT_FORCE_TITLE=t('git.force_title');
const GIT_FORCE_NOTE=t('git.force_note');
const GIT_STASH_BEFORE_MSG=t('git.stash_before_msg');

// FR-GIT-156: 이름 충돌의 선택지는 **서버가 준다** — 목록을 프론트가 복제하면
// 서버가 선택지를 늘려도 그것을 보이지 못한다. 라벨만 여기서 붙인다.
const GIT_BR_CONFLICT_TITLE=t('git.br_conflict_title');
const GIT_BR_CONFLICT_LABEL={
  checkout_existing:'Checkout existing branch',
  create_other_name:'Create with another name',
  cancel:'Cancel',
};
const GIT_BR_RENAME_SUFFIX='-2'; // 다른 이름을 권할 때의 기본 후보

// 생성 다이얼로그 (FR-GIT-158·159, 검증 V68)
const GIT_BR_CREATE_TITLE=t('git.br_create_title');
const GIT_BR_NAME_PLACEHOLDER=t('git.br_name_placeholder');
const GIT_BR_START_PLACEHOLDER=t('git.br_start_placeholder');
const GIT_BR_CREATE_CHECKOUT=t('git.br_create_checkout');
const GIT_BR_CREATE_RUN='Create';
const GIT_BR_WHY_EMPTY=t('git.br_why_empty');
const GIT_BR_WHY_EXISTS=t('git.br_why_exists');
const GIT_BR_VALIDATE_FAIL=t('git.br_validate_fail');
const GIT_BR_VALIDATE_DEBOUNCE_MS=200;

const GIT_STASH_NEW='+ New Stash';
// FR-TIP-1: 무엇이 담기는지가 라벨에 없다.
const GIT_STASH_NEW_TITLE='Stash the current working tree changes';
// 막혔을 때. 사유의 한국어 원문은 버튼 옆 한 줄이 말한다 (FR-TIP-3).
const GIT_STASH_BLOCKED_TITLE='Nothing to stash right now';
const GIT_STASH_EMPTY=t('git.stash_empty');
const GIT_STASH_LOAD_FAIL=t('git.stash_load_fail');
const GIT_STASH_PREVIEW_FAIL=t('git.stash_preview_fail');
const GIT_STASH_PICK=t('git.stash_pick');
const GIT_STASH_FILES=t('git.stash_files');
const GIT_STASH_NO_FILES=t('git.stash_no_files');
// FR-GIT-165 (검증 V57): pop 이 충돌로 끝나면 git 이 stash 를 남긴다. **조용히
// 넘기면 사용자가 작업을 잃었다고 오해한다.**
const GIT_STASH_KEPT=t('git.stash_kept');
// FR-GIT-167: 변경이 없으면 생성을 비활성화하고 사유를 보인다. 사유 없이 꺼진
// 버튼은 사용자가 해소할 수 없다.
const GIT_STASH_NOTHING=t('git.stash_nothing');
const GIT_STASH_UNTRACKED_ONLY=t('git.stash_untracked_only');
// 생성 다이얼로그 (FR-GIT-166, 검증 V58)
const GIT_STASH_CREATE_TITLE=t('git.stash_create_title');
const GIT_STASH_MSG_PLACEHOLDER=t('git.stash_msg_placeholder');
const GIT_STASH_OPT_UNTRACKED=t('git.stash_opt_untracked');
const GIT_STASH_OPT_KEEPINDEX=t('git.stash_opt_keepindex');
const GIT_STASH_CREATE_RUN='Create';
// 우클릭 항목 (FR-GIT-162~164·168)
const GIT_STASH_APPLY='Apply';
const GIT_STASH_APPLY_INDEX='Apply (--index)';
const GIT_STASH_POP='Pop';
const GIT_STASH_DROP='Drop';
// FR-GIT-168: drop 은 파괴적이다. 이름은 서버의 파괴적 목록(/api/git/policy)의
// 키이며, 목록을 프론트에 복제하지 않는다.
const GIT_ACT_STASH_DROP='stash_drop';
const GIT_STASH_DROP_TITLE=t('git.stash_drop_title');
const GIT_STASH_DROP_NOTE=t('git.stash_drop_note');
