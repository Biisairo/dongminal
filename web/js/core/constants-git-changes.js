/**
 * Dongminal — git **Changes 탭**의 상수 (FE_MODULE_BOUNDARY_SRS FR-FMB-1).
 *
 * 변경 목록이 쓰는 어휘 전부 — 그룹·상태 글자·스테이징·discard·서브모듈 행의
 * 알림, 그리고 그 표면들의 툴팁. `constants-git.js` 뒤에 로드된다.
 *
 * 절과 그 앵커: Changes(GIT_SRS §3.3 / FR-GIT-32~42) · 소실(GIT_REPO_MISSING_SRS
 * FR-RMS-8·17) · 스테이징(§3A.1 / FR-GIT-64~73) · 서브모듈 알림(SUBMODULE_DIRTY_NOTICE_SRS
 * 묶음 SDN) · 툴팁(UX_BATCH5_SRS FR-TIP-1·2).
 */
// 그룹 순서. 충돌이 맨 위인 이유는 그것이 먼저 해결돼야 하는 상태이기 때문이다.
const GIT_GROUPS=[
  /**
   * `hideEmpty` — **비어 있으면 아예 서지 않는다** (사용자 지시 2026-09-08:
   * "conflicts 그룹은 컨플릭트 있을때만 나타나게 하자").
   *
   * 빈 그룹도 개수를 보이는 것이 이 목록의 기본이다 — 숨기면 "없다" 와 "모른다" 가
   * 같아지기 때문이다. 충돌만 예외인 근거는 그것이 **예외 상태**라는 것이다:
   * 스테이지와 워킹은 저장소가 언제나 갖는 두 자리라 "0개" 가 사실을 말하지만,
   * 충돌은 머지가 멈춰 있는 동안에만 존재하고 그 밖의 시간에는 물음 자체가 없다.
   * 늘 서 있는 `Conflicts (0)` 은 답이 아니라 소음이다.
   */
  {key:'conflicts',name:'Conflicts',hideEmpty:true},
  {key:'staged',   name:'Staged'},
  // PANEL_SURFACE_SRS FR-CMG-1 / D-8: `changes` 와 `untracked` 는 **한 그룹**이다.
  // 둘은 diff 축도 행 동작도 그룹 일괄도 같았고(§2.3), 갈리는 것은 상태 문자와
  // 폐기의 명령뿐이다 — 앞의 것은 행이 보이고(FR-CMG-3), 뒤의 것은 확인창이
  // 나눠 보인다 (FR-CMG-7).
  {key:'working',  name:'Changes'},
];
/**
 * 화면의 그룹 하나가 서버 응답의 어느 배열들인가 (D-7·D-8).
 *
 * 서버는 네 배열을 그대로 보낸다 — 각 행이 자기 출신을 알아야 폐기가 옳은 명령으로
 * 가고(FR-CMG-4), 응답 모양은 e2e·다른 뷰·다이얼로그가 함께 딛는 공개 계약이다.
 * 여기 없는 키는 서버 배열 이름이 곧 그룹 이름이다.
 */
const GIT_GROUP_SRC={working:['changes','untracked']};
/**
 * GIT_DETECT_TIER_SRS FR-GDT-24 (`11 GP-15`): 서버가 그룹을 잘랐다는 안내.
 *
 * 조용히 자르면 사용자는 파일이 없어진 것으로 읽는다. `%n` 은 실제 개수다.
 */
const GIT_GROUP_TRUNCATED='%n개 중 일부만 보입니다 — .gitignore 로 줄이세요';
// 그룹이 diff 축을 결정한다 (FR-GIT-52). 값은 /api/git/diff-content 의 axis 인자다.
// commit-parent 는 다른 셋과 달리 리비전을 인자로 받는다 (FR-GIT-138·139) —
// worktree·index·HEAD 는 암묵적 리비전이지만 커밋 축은 두 커밋을 명시해야 한다.
const GIT_AXIS={STAGED:'index-head',UNSTAGED:'worktree-index',CONFLICT:'worktree-head',
  COMMIT:'commit-parent'};
const GIT_GROUP_AXIS={
  staged:GIT_AXIS.STAGED, working:GIT_AXIS.UNSTAGED, conflicts:GIT_AXIS.CONFLICT,
};
/**
 * REPO_TAB_UNIFY_SRS FR-RTU-50 / D-RTU-7: **오른쪽이 디스크의 파일인 축.**
 *
 * 판정 기준은 하나다 — 고친 것을 저장할 자리가 실재하는가. `worktree-*` 축의
 * 오른쪽은 워킹 트리의 파일이므로 편집기 탭에서 여는 것과 같은 것이고, 저장도
 * 같은 경로(`/api/file/write`)를 지난다 (FR-RTU-52).
 *
 * `index-head` 는 오른쪽이 **index** 다 — 파일이 아니라 git 내부 스냅샷이라
 * 되돌려 쓸 자리가 없다. 그것을 고치는 일은 hunk 단위 스테이징의 몫이며
 * (FR-GIT-278), 두 길을 다 열면 무엇이 스테이지를 정하는지 말할 수 없게 된다.
 * VSCode 도 Index diff 를 읽기 전용으로 둔다.
 */
const GIT_AXIS_EDITABLE=new Set([GIT_AXIS.UNSTAGED,GIT_AXIS.CONFLICT]);
// FR-RTU-54: 읽기 전용인 이유를 축마다 말한다. 조용히 무시하면 "타이핑이 먹지
// 않는다" 가 된다.
const GIT_AXIS_READONLY_WHY={
  [GIT_AXIS.STAGED]:'스테이지된 내용은 파일이 아니라 git 의 스냅샷입니다 — 고치려면 워킹 트리 쪽에서 고치고 다시 스테이지하세요.',
  [GIT_AXIS.COMMIT]:'커밋은 지나간 것입니다 — 여기서 고칠 수 없습니다.',
};

const GIT_AXIS_LABEL={
  'index-head':'index ↔ HEAD','worktree-index':'worktree ↔ index','worktree-head':'worktree ↔ HEAD',
  'commit-parent':'commit ↔ parent',
};
// 원격 버튼은 M3 가 살렸다 — 라벨·title·다이얼로그는 아래 원격 작업 절에 있다.
const GIT_PREVIEW_HINT='파일을 선택하세요';
const GIT_LOADING_HINT='불러오는 중…';
const GIT_STALE_NOTE='갱신 실패';
// FR-RTU-52: 저장 실패는 그 자리에 남는다 — 알림창은 닫는 순간 사유가 사라진다.
const GIT_DIFF_SAVE_FAIL='저장하지 못했습니다';
// FR-GIT-238: 새로고침. 이모지를 쓰지 않는다 (FR-GIT-187·192 와 같은 어휘).
const GIT_REFRESH_LABEL='refresh-cw';
// FR-GCC-8: 파일 목록의 보기 방식. 같은 패널의 언어를 하나로 모은다 — 글자
// 버튼 둘만 남으면 그 줄에서 눈이 한 번 더 멎는다. 툴팁은 이미 있는
// `GIT_FILE_VIEW_TITLE` 이 말한다 — 같은 것을 두 벌로 두지 않는다.
const GIT_FILES_MODE_ICON={tree:'folder',flat:'list'};
const GIT_REFRESH_TITLE='Refresh everything — status, History, Branches and Console';
const GIT_ERR_NOT_REPO='저장소가 아닙니다';
const GIT_ERR_GIT_MISSING='git 을 찾을 수 없습니다';
//
// 사유 코드를 화면에 함께 싣는다. "사라졌다" 는 표시가 참인지 사용자가 판정할 수
// 있어야 하고, 그 판정의 근거가 코드다 (접수한 말의 뒤 문장).
const GIT_ERR_REPO_MISSING='이 폴더가 사라졌습니다';
const GIT_RMS_PIN_REASON='폴더가 없습니다';
const GIT_RMS_REASON_PREFIX='사유: ';
const GIT_RMS_CODE='repo_missing';
const GIT_RMS_UNPIN='핀 제거';
const GIT_RMS_RECHECK='다시 확인';
const GIT_TIP_MISSING_UNPIN='Remove this repository from the GIT section';
const GIT_TIP_MISSING_RECHECK='Check again whether this folder is back';
// 파일 목록은 한 번에 다 그리지 않는다 (FR-GIT-42). 스크롤이 끝에 닿을 때마다
// 이만큼 늘린다.
const GIT_FILE_ROW_CHUNK=200;
const GIT_FILE_VIEW_KEY='gitFileView'; // 플랫/트리 선택은 기기별 취향이다
// FR-TIP-1·2: 두 보기가 무엇을 다르게 하는지는 라벨(`Tree`·`Flat`)만으로는
// 보이지 않는다 — 툴팁이 그 차이를 말한다.
const GIT_FILE_VIEW_TITLE={
  tree:'Group changed files by folder',
  flat:'List changed files with their full paths',
};
// FR-GIT-211: 트리의 들여쓰기 단위. 행의 padding 과 깊이 세로선이 **같은 값**을
// 딛는다 — 두 곳에 적으면 한쪽만 고쳐져 선이 글자와 어긋난다. CSS 는 이 값을
// `--git-indent` 로 받는다.
const GIT_TREE_INDENT=12;
const GIT_TREE_PAD0=6;
// 우클릭 메뉴는 GIT_MENUS.file 이다 (FR-GIT-41·146, git-menu.js).

// 그룹별 일괄 동작. tracked / untracked 구분은 그룹이 이미 하고 있으므로 그룹별
// 일괄이 곧 FR-GIT-68 이다. conflicts 는 일괄이 없다: 충돌 stage 는 "해결됨 표시"
// 라 한 번에 밀어 넣을 동작이 아니다 (FR-GIT-72).
//
// FR-WBR-50·51: 그룹당 **여럿**이다. 값이 배열인 이유가 그것이고, **순서가 곧
// 손에서의 거리**다 — 파괴적인 것이 오른쪽에 온다. 행 동작의 원칙(FR-GIT-236)을
// 그룹 머리로 옮긴 것이다.
// FR-CMG-6: 워킹 그룹의 일괄은 `stage` 하나와 `discard` 하나다 — 두 출신이 같은
// 버튼을 지나고, 되돌림과 삭제를 가르는 것은 확인창이다 (FR-CMG-7).
const GIT_GROUP_BULK={staged:['unstage'],working:['stage','discard']};
// 행 hover 버튼. 그룹이 할 수 있는 동작만 보인다 — staged 행의 `+` 는 뜻이 없다.
// FR-GIT-236: Open File 이 먼저다 — 읽는 동작을 쓰는 동작 앞에 둔다. 되돌리기가
// 늘 끝에 오므로 파괴적인 것이 손에서 가장 멀다.
const GIT_ROW_ACTS={
  staged:['openFile','unstage'], working:['openFile','stage','discard'],
  conflicts:['openFile','ours','theirs','stage'],
};
// UX_REVISION_SRS FR-STC-2: 상태문자 → CSS 클래스. 색은 style.css 한 자리에서
// 정한다 (FR-STC-3). 여기 없는 문자는 `other` 로 떨어져 기존 색을 유지한다.
/**
 * 트리 보기의 **폴더 행** 동작 (FR-WBR-80·82·83 / UX_BATCH5_SRS FR-DBA-1·2).
 *
 *   이전 동작: `{staged:['unstage'],changes:['stage'],untracked:['stage']}` 를
 *              **손으로 적었고**, 폐기가 없었다 (FR-WBR-84)
 *   새  동작: `GIT_ROW_ACTS` 에서 `openFile` 만 뺀 것이다 — 폐기가 함께 온다
 *   이유:     접수한 말이 "디스카드, 리버트도 하면 좋겠어" 다. 그리고 두 표를
 *             따로 적으면 파일 행에 동작이 하나 늘 때 폴더 행이 조용히 뒤처진다 —
 *             지금이 바로 그 상태였다 (D-1)
 *
 * 폴더는 편집기로 여는 대상이 아니므로 `openFile` 만 빠진다. 트리가 그룹마다 따로
 * 서므로(FR-WBR-82) 폴더 행은 한 그룹에만 속하고, 그래서 그룹 하나가 곧 답이다.
 * 플랫 보기에는 폴더 행이 없으므로 이 표가 닿지 않는다 (FR-WBR-83).
 */
const GIT_DIR_ACTS=Object.fromEntries(Object.entries(GIT_ROW_ACTS)
  .map(([k,v])=>[k,v.filter(a=>a!=='openFile')]));
// conflicts 만 예외다. `ours`·`theirs` 는 폴더 단위로 뜻이 서지 않고, 충돌 stage 는
// "해결됨 표시" 라 한 번에 밀어 넣을 동작이 아니다 (FR-GIT-72) — 그룹 일괄이 없는
// 것과 같은 근거다. 예외가 하나뿐이므로 예외만 적는다.
GIT_DIR_ACTS.conflicts=[];
const GIT_DIR_ACT_TITLE={stage:'Stage this whole folder',unstage:'Unstage this whole folder',
  discard:'Discard every change in this folder'};
// FR-DBA-4: 두 그룹의 폐기는 같은 명령이 아니다 — tracked 는 index 로 되돌리고,
// untracked 는 **파일을 지운다**. `GIT_BULK_TITLE_GROUP` 과 같은 규약이며 갈리는
// 것이 이 하나뿐이라 예외만 적는다.
// FR-CMG-9: 한 폴더 아래에 두 출신이 섞일 수 있다. 정확한 내역은 확인창이
// 보이므로(FR-CMG-7) 툴팁은 **지우는 것이 섞여 있을 수 있다**는 사실만 말한다.
const GIT_DIR_ACT_TITLE_GROUP={working:{discard:'Discard everything in this folder — new files here are deleted and cannot be undone'}};
const GIT_ST_CLASS={M:'mod',A:'add',D:'del',R:'ren',C:'cpy','?':'new',U:'conf'};
// porcelain 의 상태 문자 중 **판정에 쓰는 것**. 문자열을 코드에 흩뿌리면 어느
// 규칙의 문자인지 알 수 없게 된다 (FR-RTU-51 의 "왼쪽이 없다" 가 이 하나다).
const GIT_ST_ADDED='A';
/**
 * 아이콘이 **없는** 동작의 글자 라벨. `GIT_ACT_ICON` 이 있는 것은 이 표를 지나지
 * 않는다 (`panel-changes.js` 의 갈래) — `ours`·`theirs` 는 어휘이지 아이콘이
 * 아니므로 그 둘만 남는다 (FR-GLY-8).
 *
 * 종전에는 `openFile:'↗' stage:'+' unstage:'−' discard:'↺'` 도 여기 있었다.
 * 아이콘으로 옮긴 뒤 값이 죽었는데 표에 남아, 다음 사람이 그것이 아직 쓰인다고
 * 읽을 자리였다.
 */
const GIT_ACT_LABEL={ours:'Ours',theirs:'Theirs'};
/**
 * UI_KIT_SRS §7.1 / FR-GLY-4: 문자 라벨의 **아이콘 이름**. 여기 없는 동작
 * (`ours`·`theirs`)은 글자로 남는다 — 어휘이지 아이콘이 아니다 (FR-GLY-8).
 *
 * 크기는 여기서 정하지 않는다. `.ui-icon` 이 버튼 높이에서 파생시킨다 (FR-GLY-5) —
 * 그래서 요구 ⑤("아이콘이 버튼을 꽉 채운다")가 자리마다 다시 적히지 않는다.
 */
const GIT_ACT_ICON={openFile:'external-link',stage:'plus',unstage:'minus',discard:'undo'};
/**
 * 행·폴더·그룹 머리가 함께 서는 **열**. 셋이며 순서가 곧 손에서의 거리다 —
 * 읽는 것이 앞, 되돌릴 수 없는 것이 끝이다.
 *
 * 접수한 말이 "conflicts/staged/changes 에 있는 버튼들과 파일 및 폴더에 있는
 * 버튼들이 정렬이 안되었다" 다. 열을 그룹마다 세면 그룹이 가진 동작 수만큼
 * 오른쪽 정렬이 밀린다 — 열을 **문서 하나**로 두고 없는 자리는 자리지킴이 메운다
 * (FR-DBA-3 을 모든 자리로 넓힌 것이다).
 *
 * 한 열에 두 이름이 있는 것은 `stage`/`unstage` 뿐이다 — 같은 자리의 반대 동작이다.
 * 그 밖의 동작(`ours`·`theirs`)은 글자 버튼이라 폭이 다르므로 세 열 **앞**에 선다.
 */
const GIT_ACT_COLS=[['openFile'],['stage','unstage'],['discard']];
/**
 * 그룹 머리·폴더가 쓰는 열. 열기는 그 자리의 동작이 아니므로 빠진다.
 *
 * 뺄 수 있는 근거는 **오른쪽 정렬**이다 — 뒤에서부터 맞으므로 앞 열이 몇 개든
 * 폐기와 스테이지는 파일 행의 같은 자리에 선다. 열을 셋으로 두면 머리에서
 * 30px 이 자리지킴으로 죽고, 220px 사이드에서 그만큼 그룹 이름이 잘린다 (실측).
 */
const GIT_BULK_COLS=GIT_ACT_COLS.slice(1);
// ours·theirs 의 툴팁은 **진행 중인 조작에 따라 달라지므로** 여기 두지 않는다 —
// 행이 GIT_SIDE_TITLE 에서 그때 고른다 (FR-GIT-224).
const GIT_ACT_TITLE={openFile:'Open this file',stage:'Stage',unstage:'Unstage',discard:'Discard changes'};
// FR-WBR-52 (D-WBR-18): 일괄은 **행 동작과 같은 어휘의 아이콘**이다 — 그래서
// 라벨 표를 따로 두지 않고 `GIT_ACT_LABEL` 을 그대로 쓴다. "같은 어휘" 를 주석이
// 아니라 코드가 보장하게 하는 자리다.
//
// 글자 라벨(`Stage All`·`Discard All`)을 버린 이유는 **실측**이다: 기본 폭 220px
// 에서 머리 안쪽 203px 중 이름·개수·caret 이 쓰고 남는 자리가 80px 인데 두 라벨은
// 136px 이 필요했다. 줄을 늘리면 머리가 36→71px 이 되어 FR-GIT-220 이 깨진다.
//
// FR-WBR-52a: 갈리는 것은 라벨이 아니라 **툴팁**이다. 두 그룹의 폐기는 같은
// 명령이 아니다 — tracked 는 index 로 되돌리고(`checkout -q`), untracked 는
// **파일을 지운다**(`clean -q -f`). 그룹별로 다른 것이 이 하나뿐이라 예외만 적는다.
const GIT_BULK_TITLE={stage:'Stage all',unstage:'Unstage all',discard:'Discard all changes'};
const GIT_BULK_TITLE_GROUP={working:{discard:'Discard everything here — new files are deleted and cannot be undone'}};
// FR-CMG-5: **행**의 폐기는 그 행의 출신에 따라 갈린다 — 새 파일의 폐기는 삭제다.
// 그룹이 아니라 항목이 답을 주는 자리이므로 표가 따로 있다.
const GIT_ACT_TITLE_UNTRACKED={discard:'Delete this file — this cannot be undone'};
// FR-CMG-11: 머리의 개수는 합계다. 합계만으로는 지울 것이 있는지 보이지 않으므로
// 내역을 툴팁에 적는다.
const GIT_GROUP_COUNT_TITLE=(n,m)=>'추적 '+n+' · 새 파일 '+m;
// FR-GIT-70: staged 와 unstaged 를 동시에 가진 파일. 체크박스의 indeterminate 와
// 행 클래스 둘로 구분한다 — 색만으로는 무엇이 다른지 알 수 없다.
const GIT_PARTIAL_TITLE='일부만 스테이지됨';

// GIT_DIR_ENTRY_SRS 묶음 G — **디렉터리 항목**. git 이 파일이 아니라 디렉터리
// 하나를 상태의 단위로 보고한 행이다 (FR-DIR-20~22).
//
// 이 행에 파일 diff 를 보이는 것은 사용자를 돕지 않는다 — 서브모듈의 diff 는
// `Subproject commit …` 두 줄뿐이고 중첩 저장소는 아예 내용이 없다(실측).
// 사용자가 알아야 하는 것은 **여기가 다른 저장소라는 사실**과 그리로 가는 길이다.
const GIT_DIR_ENTRY_SUFFIX='/';
const GIT_DIR_ENTRY_TITLE_SUB='서브모듈 — 이 저장소는 커밋 하나로만 추적합니다';
const GIT_DIR_ENTRY_TITLE_NESTED='다른 저장소 — 이 저장소는 안을 들여다보지 않습니다';
const GIT_DIR_ENTRY_NOTE_SUB=
  '서브모듈입니다 — 이 저장소는 커밋 하나로만 이 폴더를 추적합니다. '+
  '안의 변경은 여기서 보이지 않습니다.';
const GIT_DIR_ENTRY_NOTE_NESTED=
  '다른 저장소입니다 — 이 저장소는 안을 들여다보지 않습니다.';

//
// porcelain v2 `sub` 필드(`S<c><m><u>`)의 자리값. 파싱은 `gitSubParts` 한 곳이
// 하고(FR-SDN-2), 그 함수가 읽는 글자를 여기서 정한다 — 값을 함수 안에 박으면
// 형식이 어디서 왔는지 알 수 없게 된다.
const GIT_SUB_IS_SUB='S';
const GIT_SUB_COMMIT='C';
const GIT_SUB_MODIFIED='M';
const GIT_SUB_UNTRACKED='U';

// FR-SDN-8: 툴팁의 문장. 성분을 알면 `GIT_DIR_ENTRY_TITLE_SUB` 을 **대체한다** —
// 뒤에 덧붙이면 "서브모듈" 이 한 툴팁에 두 번 나오고, 종전 문장이 말하던 것을
// 이 문장들이 더 정확히 말한다. 툴팁은 짧아야 하므로 사실 하나씩만 싣는다.
const GIT_SUB_TITLE_COMMIT='서브모듈 — 기록된 커밋이 바뀌었습니다, 스테이지하면 담깁니다';
const GIT_SUB_TITLE_INNER='서브모듈 안의 변경 — 여기서는 스테이지해도 사라지지 않습니다';
const GIT_SUB_TITLE_BOTH='서브모듈 — 기록된 커밋은 담기고, 안의 변경은 남습니다';
// FR-SDN-12·13 (D-2a): 담을 몫이 없는 행의 `Stage` 는 꺼지고, 그 사유를 말한다.
// 사유 없이 꺼진 버튼은 사용자가 해소할 수 없다 (FR-GIT-101 과 같은 규약).

// FR-SDN-9: 미리보기의 안내문. 자리가 넓으므로 무엇을 해야 하는지까지 싣는다.
//
// FR-SDN-6: 안쪽만인 경우(B)는 **사라지지 않는다는 사실을 먼저** 말한다. 순서가
// 뒤집히면 "먼저 커밋하라" 가 조언으로 읽히고 지금 눈앞의 행은 설명되지 않는다.
const GIT_SUB_NOTE_COMMIT=
  '서브모듈입니다 — 기록된 커밋이 바뀌었습니다. '+
  '스테이지하면 이 저장소에 그 커밋이 담깁니다. 안의 변경은 여기서 보이지 않습니다.';
// 안내문은 `textContent` 로 들어간다 (diff-view.js `_setNote`) — 마크다운 강조가
// 렌더링되지 않으므로 별표를 쓰지 않는다. 무게는 문장 순서가 진다 (FR-SDN-6).
const GIT_SUB_NOTE_INNER=
  '서브모듈입니다 — 여기서는 스테이지·커밋해도 이 행이 사라지지 않습니다. '+
  '기록된 커밋은 그대로이고 바뀐 것은 서브모듈 안이기 때문입니다: '+
  '이 저장소가 커밋할 수 있는 것은 서브모듈의 커밋 해시 하나뿐입니다. '+
  '서브모듈을 자기 저장소로 열어 그 안에서 먼저 커밋하세요.';
const GIT_SUB_NOTE_BOTH=
  '서브모듈입니다 — 기록된 커밋이 바뀌었고, 서브모듈 안에도 커밋하지 않은 변경이 있습니다. '+
  '스테이지하면 커밋 몫은 담기지만 안쪽 몫은 이 행에 남습니다 — '+
  '그것은 서브모듈을 자기 저장소로 열어 그 안에서 커밋해야 합니다.';
const GIT_DIR_ENTRY_ADD='저장소로 추가';
const GIT_DIR_ENTRY_ADD_TITLE='이 폴더를 Repo 목록에 더하고 그 창으로 갑니다';
const GIT_DIR_ENTRY_GO='저장소로 이동';
const GIT_DIR_ENTRY_GO_TITLE='이미 목록에 있습니다 — 그 창으로 갑니다';
// UX_BATCH5_SRS FR-SUB-11: 서브모듈 항목에서 **그것을 관리하는 자리**로 가는 길.
//
// `저장소로 이동`(위)과 다른 것이다 — 그쪽은 서브모듈 **자신의** 창으로 가고,
// 이쪽은 **부모 저장소의** Submodules 탭으로 간다: init·update·sync 가 사는 자리다.
// 중첩 저장소에는 붙지 않는다 (`.gitmodules` 에 없으므로 그 목록에 서지 않는다).
const GIT_DIR_ENTRY_SUBTAB='Submodules 탭';
const GIT_DIR_ENTRY_SUBTAB_TITLE='이 저장소의 Submodules 탭으로 갑니다 — init·update·sync 가 그 자리에 있습니다';
// FR-GIT-72: 충돌 파일의 stage 는 "해결됨 표시" 다. 파괴적이 아니므로 1단계 확인이다.
const GIT_ACT_RESOLVE='resolve_mark';
const GIT_RESOLVE_TITLE='충돌을 해결됨으로 표시합니다';
const GIT_RESOLVE_NOTE='스테이지한 뒤에도 언스테이지로 되돌릴 수 있습니다';
// FR-GIT-224: 충돌 파일 하나를 한쪽으로 받아 해결한다. **파괴적이다** — 워킹
// 트리의 충돌 표식과 손대던 내용이 사라지고 되살릴 값이 없다.
//
// **`ours`/`theirs` 의 뜻은 진행 중인 조작에 따라 뒤집힌다.** merge 중에는 ours 가
// 현재 브랜치이지만 rebase 중에는 ours 가 올려놓는 대상이고 내 커밋이 theirs 다.
// 라벨은 git 의 낱말 그대로 두고(FR-GIT-200) 툴팁이 어느 쪽인지 밝힌다.
const GIT_ACT_RESOLVE_SIDE='resolve_side';
const GIT_RESOLVE_SIDE_TITLE='한쪽 내용으로 덮고 해결됨으로 표시합니다';
const GIT_RESOLVE_SIDE_NOTE='충돌 표식과 손대던 내용은 되살릴 값이 없습니다. 충돌 상태로 되돌리려면 아래를 실행합니다';
// 진행 중인 조작별 설명. 모르면 둘 다 밝힌다 — 틀린 한쪽을 단정하지 않는다.
const GIT_SIDE_TITLE={
  merge:{ours:'Take the current branch (ours) side',
         theirs:'Take the incoming (theirs) side'},
  rebase:{ours:'Take the branch being replayed onto (ours) — not your commits',
          theirs:'Take your commits (theirs) side'},
  '':{ours:'Take the ours side (during a rebase this is the branch replayed onto)',
      theirs:'Take the theirs side (during a rebase this is your commits)'},
};
// preflight 의 코드값 → 조작 이름.
const GIT_OP_BY_BLOCK={merge_in_progress:'merge',rebase_in_progress:'rebase',
  cherry_pick_in_progress:'rebase',revert_in_progress:'rebase',
  // GIT_DETECT_TIER_SRS FR-GDT-18·19: 서버가 새로 가르는 둘.
  am_in_progress:'am',bisect_in_progress:'bisect'};

// FR-GIT-89~92: discard. 파괴적 판정은 /api/git/policy 가 한다 — 이 이름은 그
// 목록의 키이고, 목록을 프론트에 복제하지 않는다.
const GIT_ACT_DISCARD='discard';
const GIT_DISCARD_TITLE='워킹 트리의 변경을 폐기합니다';
// O8: stash 를 자동 생성하지 않는다 — 안내만 한다.
const GIT_DISCARD_NOTE='폐기 전에 아래를 실행하면 stash 로 남습니다 (자동 실행하지 않습니다)';
// FR-WBR-55: untracked 가 섞이면 되돌리기가 아니라 **삭제**다. 서버의
// `discardHint` 가 실행 **뒤에** 적는 것과 같은 뜻을, 실행 **전에** 화면이 말한다
// — 그 hint 는 기록이라 확인창에 닿지 않는다.
const GIT_DISCARD_NOTE_DEL='파일 자체가 삭제되며 되살릴 값이 없습니다. ';
// FR-GIT-73 · §7.1 I2: git 은 경로별로 처리해 진짜 롤백이 없다. 부분 적용을
// 조용히 넘기지 않는 것이 요구사항이고, 그것을 이 안내가 맡는다.
const GIT_PARTIAL_NOTE='일부만 적용됐습니다 — 아래 경로가 바뀌었습니다';
const GIT_WRITE_FAIL='동작이 실패했습니다';
const GIT_NOTE_CLOSE='Close';
//
// 아래는 라벨이 한두 낱말이라 **무엇을** 하는지 말하지 않는 버튼들이다. 각 상수는
// 그 라벨 옆이 아니라 여기 모여 산다 (FR-TIP-4).
const GIT_TIP_NOTE_CLOSE='Dismiss this message';
const GIT_TIP_JOB_CANCEL='Cancel the running remote operation';
const GIT_TIP_JOB_COPY='Copy the full output of this operation';
const GIT_TIP_JOB_CLOSE='Dismiss this operation panel';
const GIT_TIP_JOB_AUTH_COPY='Copy this command so you can run it in a terminal';
const GIT_TIP_JOB_FIX='Retry the push with this option';
const GIT_TIP_PREFLIGHT_COPY='Copy this fix command to the clipboard';
const GIT_TIP_UNDO='Undo the commit you just made (keeps your changes staged)';
const GIT_TIP_RETRY='Try loading this list again';
const GIT_TIP_SEARCH_REPO='Search the whole repository, not just the commits already loaded';
// UX_BATCH5_SRS FR-TIP-2 가 미달이던 자리 (CI 전량 실행이 찾았다). 이 넷은 버튼의
// 툴팁이므로 **영어**이고, 같은 사실을 말하는 화면의 글자는 한국어 그대로다
// (FR-TIP-3) — 그래서 replay 는 상수를 둘로 가른다: 확인창의 제목은 사용자가 읽는
// 글자이고, 이것은 툴팁이다.
const GIT_TIP_CON_REPLAY='Run this git command again';
const GIT_TIP_RM_REMOVE='Remove this remote (git remote remove)';
const GIT_TIP_JOB_FOLD='Expand or collapse the operation log';
const GIT_TIP_SUB_STAGE_OFF='Nothing here for this repository to stage — commit inside the submodule first';
// `GIT_WRITE_ERR` 는 `constants-git-actions.js` 로 옮겼다 — 그 표를 채우는
// 세 문장이 전부 그 파일에 있고, 선언과 채움은 같은 파일이어야 한다.
