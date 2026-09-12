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
  {key:GIT_BR_GROUP_FAV,   name:'★ 즐겨찾기'},
  {key:GIT_REF_KIND_LOCAL, name:'로컬'},
  {key:GIT_REF_KIND_REMOTE,name:'원격'},
  {key:GIT_REF_KIND_TAG,   name:'태그'},
];
const GIT_BR_SEARCH_PLACEHOLDER='이름 검색';
const GIT_BR_NEW='+ New Branch';
// FR-TIP-1: 어디에서 갈라지는지가 라벨에 없다 — 그것이 이 버튼의 유일한 물음이다.
const GIT_BR_NEW_TITLE='Create a new branch from the current HEAD';
const GIT_BR_EMPTY='이름이 일치하는 ref 가 없습니다';
const GIT_BR_LOAD_FAIL='브랜치 목록을 불러오지 못했습니다';
const GIT_BR_RETRY='Retry';
// 즐겨찾기는 workspace.json 최상위 git.favorites[<repo>] 다 (O13). 접힘 상태는
// 기기별 취향이라 localStorage 다 (FR-GIT-150) — 실제 키는 <이것>:<repo>.
const GIT_BR_FAV_FIELD='favorites';
const GIT_BR_COLLAPSE_KEY='gitBrCollapsed';
const GIT_BR_FAV_MARK='★';
const GIT_BR_FAV_ON_TITLE='즐겨찾기에서 빼기';
const GIT_BR_FAV_OFF_TITLE='즐겨찾기에 넣기';
const GIT_BR_CURRENT_MARK='✓';
// 접두사 그룹핑은 이름의 첫 조각이다 (FR-GIT-150).
const GIT_BR_PREFIX_SEP='/';

// FR-GIT-155·156: checkout. 원격 ref 는 같은 이름의 로컬을 만들며 추적을 설정한다 —
// 그러므로 두 항목은 뜻이 다르고, 어느 쪽이 왜 막혔는지 사유로 알린다.
const GIT_BR_CHECKOUT_LOCAL='Checkout as local';
const GIT_MENU_CURRENT='현재 브랜치입니다';
const GIT_MENU_REMOTE_REF='원격 브랜치입니다 — Checkout as local 을 쓰세요';
const GIT_MENU_LOCAL_ONLY='원격 브랜치에서만 쓸 수 있습니다';

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
const GIT_DIRTY_TITLE='미커밋 변경이 있는 상태의 checkout';
const GIT_DIRTY_NOTE='워킹 트리에 변경이 남아 있습니다 — 무엇을 할지 고르세요';
// 강제 checkout 은 워킹 트리의 변경을 버린다. **서버의 파괴적 목록에는 없는 이름**
// 이므로 확인 단계를 명시적으로 2로 요구한다 (계약 §1.1).
const GIT_ACT_CHECKOUT_FORCE='checkout_force';
const GIT_FORCE_TITLE='워킹 트리의 변경을 버리고 checkout 합니다';
const GIT_FORCE_NOTE='버리기 전에 아래를 실행하면 stash 로 남습니다 (자동 실행하지 않습니다)';
const GIT_STASH_BEFORE_MSG='checkout 전 자동 stash';

// FR-GIT-156: 이름 충돌의 선택지는 **서버가 준다** — 목록을 프론트가 복제하면
// 서버가 선택지를 늘려도 그것을 보이지 못한다. 라벨만 여기서 붙인다.
const GIT_BR_CONFLICT_TITLE='같은 이름의 로컬 브랜치가 이미 있습니다';
const GIT_BR_CONFLICT_LABEL={
  checkout_existing:'Checkout existing branch',
  create_other_name:'Create with another name',
  cancel:'Cancel',
};
const GIT_BR_RENAME_SUFFIX='-2'; // 다른 이름을 권할 때의 기본 후보

// 생성 다이얼로그 (FR-GIT-158·159, 검증 V68)
const GIT_BR_CREATE_TITLE='새 브랜치';
const GIT_BR_NAME_PLACEHOLDER='브랜치 이름';
const GIT_BR_START_PLACEHOLDER='시작점 (비우면 현재 HEAD)';
const GIT_BR_CREATE_CHECKOUT='만든 뒤 checkout';
const GIT_BR_CREATE_RUN='Create';
const GIT_BR_WHY_EMPTY='이름을 입력하세요';
const GIT_BR_WHY_EXISTS='같은 이름이 이미 있습니다 — 다른 이름을 쓰세요';
const GIT_BR_VALIDATE_FAIL='이름을 검사하지 못했습니다';
const GIT_BR_VALIDATE_DEBOUNCE_MS=200;

const GIT_STASH_NEW='+ New Stash';
// FR-TIP-1: 무엇이 담기는지가 라벨에 없다.
const GIT_STASH_NEW_TITLE='Stash the current working tree changes';
// 막혔을 때. 사유의 한국어 원문은 버튼 옆 한 줄이 말한다 (FR-TIP-3).
const GIT_STASH_BLOCKED_TITLE='Nothing to stash right now';
const GIT_STASH_EMPTY='stash 가 없습니다';
const GIT_STASH_LOAD_FAIL='stash 목록을 불러오지 못했습니다';
const GIT_STASH_PREVIEW_FAIL='stash 미리보기를 불러오지 못했습니다';
const GIT_STASH_PICK='stash 를 선택하세요';
const GIT_STASH_FILES='변경 파일';
const GIT_STASH_NO_FILES='변경 파일이 없습니다';
// FR-GIT-165 (검증 V57): pop 이 충돌로 끝나면 git 이 stash 를 남긴다. **조용히
// 넘기면 사용자가 작업을 잃었다고 오해한다.**
const GIT_STASH_KEPT='충돌로 stash 를 남겨 두었습니다 — 작업은 사라지지 않았습니다';
// FR-GIT-167: 변경이 없으면 생성을 비활성화하고 사유를 보인다. 사유 없이 꺼진
// 버튼은 사용자가 해소할 수 없다.
const GIT_STASH_NOTHING='저장할 변경이 없습니다';
const GIT_STASH_UNTRACKED_ONLY='추적되지 않는 파일뿐입니다 — untracked 포함을 켜세요';
// 생성 다이얼로그 (FR-GIT-166, 검증 V58)
const GIT_STASH_CREATE_TITLE='stash 생성';
const GIT_STASH_MSG_PLACEHOLDER='메시지 (선택)';
const GIT_STASH_OPT_UNTRACKED='추적되지 않는 파일 포함 (--include-untracked)';
const GIT_STASH_OPT_KEEPINDEX='index 는 그대로 남김 (--keep-index)';
const GIT_STASH_CREATE_RUN='Create';
// 우클릭 항목 (FR-GIT-162~164·168)
const GIT_STASH_APPLY='Apply';
const GIT_STASH_APPLY_INDEX='Apply (--index)';
const GIT_STASH_POP='Pop';
const GIT_STASH_DROP='Drop';
// FR-GIT-168: drop 은 파괴적이다. 이름은 서버의 파괴적 목록(/api/git/policy)의
// 키이며, 목록을 프론트에 복제하지 않는다.
const GIT_ACT_STASH_DROP='stash_drop';
const GIT_STASH_DROP_TITLE='stash 를 지웁니다';
const GIT_STASH_DROP_NOTE='gc 전이면 아래 명령으로 되살릴 수 있습니다';
