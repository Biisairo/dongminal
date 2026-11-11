/**
 * Dongminal — **커밋과 파괴적 동작 확인**의 상수 (FE_MODULE_BOUNDARY_SRS FR-FMB-1).
 *
 * 커밋 입력·amend·서명, 되돌릴 수 없는 동작의 확인 문구, 그리고 그 확인들이
 * 함께 쓰는 다이얼로그 골격. 확인이 커밋과 한 파일인 이유는 **되돌릴 수 없음**을
 * 말하는 자리가 둘 다이기 때문이다.
 *
 * 절과 그 앵커: 커밋(GIT_SRS §3A.2 / FR-GIT-74~85) · 파괴적 동작 확인(§3A.3 /
 * FR-GIT-90~97·174~178) · 다이얼로그 공통 골격(§3D.3 / FR-GIT-171~178).
 */
// UI_POLISH_SRS FR-UIP-20: 커밋 키를 입력 자리에서 알린다.
const GIT_COMMIT_PLACEHOLDER=t('git.commit_placeholder',{key:IS_MAC?'\u2318Enter':'Ctrl+Enter'});
// FR-GIT-74: 기본 2줄에서 시작해 입력만큼 자라고, 이 줄 수를 넘으면 내부
// 스크롤로 넘긴다. 경계 드래그 결과는 기기별이라 localStorage 에 남는다.
const GIT_COMMIT_ROWS=2;
const GIT_COMMIT_MAX_ROWS=12;
const GIT_COMMIT_LINE_PX=17;   // lineHeight 를 읽지 못하는 환경의 대체값
const GIT_COMMIT_HEIGHT_KEY='gitCommitHeight';
// FR-GIT-75 · O6: draft 는 ws.git.drafts[<repo>] 다. 입력이 멈춘 뒤 저장한다 —
// 키 하나마다 PUT 을 보내지 않는다.
const GIT_COMMIT_DRAFT_DEBOUNCE_MS=300;
const GIT_COMMIT_BTN=t('git.act.commit_btn');
const GIT_COMMIT_MORE='▾';
// FR-TIP-1: `▾` 만으로는 무엇이 열리는지 보이지 않는다.
const GIT_COMMIT_MORE_TITLE='More commit options';
const GIT_COMMIT_AMEND='amend';
// FR-GIT-79: VSCode 의 조합 명령 20개를 이 체크박스 3개가 대체한다. **선택을
// localStorage 에 남기지 않는다** — no-verify 가 기억되면 훅이 조용히 계속 꺼진다.
const GIT_COMMIT_OPTS=[
  {key:'signoff', label:'sign-off (--signoff)'},
  {key:'noVerify',label:'no-verify (--no-verify)'},
  {key:'all',     label:'commit all (-a)'},
];
const GIT_COMMIT_GPG=t('git.commit_gpg'); // FR-GIT-85
/**
 * UX_BATCH5_SRS FR-TIP-2·3: **같은 사유가 두 자리에 다른 말로 산다.**
 *
 * 버튼 옆 한 줄은 서버 사유 코드의 카탈로그 문구(`why.<code>`)이고, 툴팁만 영어다
 * (FR-TIP-2). 그래서 툴팁 표는 **서버의 사유 코드**를 키로 한다 (SERVER_DRIVEN_ACTIONS_SRS
 * GR-3f). `no-repo` 만 화면의 것이다 — 저장소가 없으면 물을 대상이 없다.
 */
const GIT_COMMIT_WHY_NO_REPO='no-repo';
const GIT_COMMIT_WHY_TITLE={
  [GIT_COMMIT_WHY_NO_REPO]:'Select a repository first',
  loading:'Checking whether this can be committed',
  empty_message:'Enter a commit message',
  nothing_staged:'Nothing is staged — stage a file or turn on commit all',
  job_busy:'A job is running in this repository',
  preflight_blocked:'Pre-commit checks block this commit',
};
// GR-3c: 입력이 멈춘 뒤 서버에 커밋 가능 여부를 묻는다.
const GIT_COMMIT_ASK_DEBOUNCE_MS=250;
const GIT_COMMIT_RUNNING=t('git.commit_running');
// FR-GIT-81·83 · O7: 5초 고정. 만료는 서버 토큰이 함께 강제한다.
const GIT_UNDO_MS=5000;
const GIT_UNDO_TEXT=t('git.undo_text');
const GIT_UNDO_LABEL=t('git.act.undo_label');
const GIT_UNDO_FAIL=t('git.undo_fail');
// FR-GIT-88: 무엇이 왜 막혔고 어떻게 푸는지를 함께 보인다. Fix 는 복사 가능하다.
const GIT_PREFLIGHT_TITLE=t('git.preflight_title');
const GIT_PREFLIGHT_FIX=t('git.preflight_fix');
const GIT_PREFLIGHT_COPY=t('git.act.preflight_copy');
// FR-GIT-87: 막지 않고 알린다. 파괴적이 아니므로 1단계 확인이다.
const GIT_ACT_DETACHED='commit_detached';
const GIT_DETACHED_TITLE=t('git.detached_title');
const GIT_DETACHED_NOTE=t('git.detached_note');
// preflight 의 코드값. 서버(internal/git/preflight.go)와 같은 문자열이다.
const GIT_WARN_DETACHED='detached_head';
const GIT_ERR_PREFLIGHT='preflight_blocked';
const GIT_ERR_UNDO_EXPIRED='undo_expired';

// ── 파괴적 동작 확인 (GIT_SRS §3A.3 / FR-GIT-90~97·174~178,
//    CONFIRM_ONE_STAGE_SRS 묶음 N) ──
//
// `GIT_CONFIRM_CONTINUE`('계속')가 여기 있었다. 확인이 한 걸음이 되면서 넘어갈
// 다음 걸음이 없어졌다 (FR-COS-4).

const GIT_CONFIRM_TITLE=t('git.confirm_title');
const GIT_CONFIRM_RUN=t('git.act.confirm_run');
// UI_POLISH_SRS FR-UIP-12: 일반 동작 라벨은 카탈로그를 거친다.
const GIT_CONFIRM_CANCEL=t('core.cancel');
const GIT_CONFIRM_COPY=t('git.act.confirm_copy');
const GIT_CONFIRM_HINT_LABEL=t('git.confirm_hint_label');
// UX_BATCH5_SRS FR-TIP-1: 확인창·다이얼로그의 버튼. 라벨(`Run`·`Cancel`·
// `Copy`)은 한 낱말이라 **무엇이** 실행·취소·복사되는지 말하지 않는다.
const GIT_CONFIRM_RUN_TITLE='Run the command shown above';
const GIT_CONFIRM_CANCEL_TITLE='Close without running anything';
// UI_POLISH_SRS FR-UIP-11: 다이얼로그의 실행 라벨이 한국어가 되어도 툴팁은 영어다 (FR-TIP-2).
const GIT_DIALOG_RUN_TITLE='Run this action';
const GIT_CONFIRM_COPY_TITLE='Copy this command to the clipboard';
const GIT_CONFIRM_RUNNING=t('git.act.confirm_running');
const GIT_CONFIRM_FAIL=t('git.confirm_fail');
// FR-GIT-92: 값을 얻지 못한 hint 를 조용히 빈 칸으로 두지 않는다.
const GIT_CONFIRM_NO_HINT=t('git.confirm_no_hint');
// FR-GIT-178: 알리기만 한다. 다시 열게 강제하지도, 실행을 막지도 않는다.
const GIT_CONFIRM_CHANGED=t('git.confirm_changed');
// FR-GIT-91: 개수는 목록과 함께 보이는 것이다 — 개수만 보이면 요구사항 실패다.
const GIT_CONFIRM_COUNT_LABEL=t('git.confirm_count_label');
// FR-CMG-7: 일괄 폐기의 확인창은 두 무리를 **나눠** 보인다. 되돌릴 수 없는 삭제가
// 되돌림과 같은 목록에 섞여 있으면 사용자는 그 차이를 볼 자리가 없다.
const GIT_DISCARD_SECT_REVERT=t('git.discard_sect_revert');
const GIT_DISCARD_SECT_DELETE=t('git.discard_sect_delete');

// 골격의 기본 이름. 흡수한 다이얼로그는 자기 id·클래스 접두를 그대로 유지한다 —
// 공유하는 것은 골격이고 이름은 각자의 것이다.
const GIT_DIALOG_ID='git-dialog';
const GIT_DIALOG_NS='gd';
// 필드 종류. **자격증명을 받는 종류는 없다** (FR-GIT-104).
const GIT_DIALOG_TEXT='text';
const GIT_DIALOG_CHECK='check';
const GIT_DIALOG_RADIO='radio';
// 실행을 막는 사유의 종류. `pending` 은 사유를 보이지 않고 실행만 막는다 —
// 판정을 모르는 동안 열어 두면 위반이 그대로 지나간다 (FR-GIT-159).
const GIT_DIALOG_WHY='why';
const GIT_DIALOG_WHY_PENDING='pending';
// FR-GIT-178 의 상태 지문에 넣는 그룹. 대상 파일들의 `xy` 조합이다.
// FR-CMG-13: 화면과 **같은 묶음**을 딛는다 — 한쪽만 합치면 같은 파일 집합이
// 자리마다 다르게 묶인다.
const GIT_DIALOG_FP_GROUPS=['staged','working','conflicts'];
