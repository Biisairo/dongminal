/**
 * Remote Terminal — git 배지 낡음·상태 그룹 헬퍼
 *
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-6 (FEC-24): 옛 helpers.js 에서 주제별로 갈라 왔다. 본문은
 * 바꾸지 않았다. index.html 이 옛 helpers.js 자리에 같은 순서로 싣는다.
 */

/**
 * 배지가 낡았는가 (FR-GOB-14).
 *
 * 관측 시각만 본다. 옛 규칙은 "활성 리포가 아니면 낡음" 이었는데, 그때는 관측을
 * 활성 리포만 만들었으므로 그 둘이 같은 말이었다. 이제 Git 탭 안에서는 핀 전부가
 * 매 주기 관측되므로(FR-GOB-10) 활성 여부는 낡음과 무관하다.
 */
function gitBadgeStale(badge){
  const at=badge&&badge.observedAtUnixMs;
  if(!at) return true;
  return (Date.now()-at)>gitBadgeStaleMs();
}

/**
 * POLL_INTERVAL_SETTINGS_SRS FR-PIS-12 / D-7: 낡음의 기준은 **주기에서 파생한다.**
 *
 * 종전에는 `const GIT_BADGE_STALE_MS=GIT_REPOS_POLL_MS*4` 로 로드 시점에 굳었고,
 * 주기가 설정이 되면 그 상수만 옛 값에 남는다. 계수를 남기고 곱셈을 여기로
 * 옮기면 기준이 주기를 따라간다 — 둘은 같은 사실의 앞뒤이기 때문이다 (FR-GOB-14).
 */
//
// OPTIMIZE_REFACTOR_SRS FR-OPT-4-3: 목록의 주기가 안전망(`gitStatusInterval`)으로 옮겼으므로
// 기준도 그것을 딛는다. 배지의 갱신은 `git_changed` 가 본줄이고, 안전망이 꺼져 있으면(0)
// 그 기본값으로 잰다.
function gitBadgeStaleMs(){ return (gitStatusInterval||GIT_STATUS_POLL_MS)*GIT_BADGE_STALE_FACTOR }

// 같은 근거의 편집기 쪽 백오프 (FR-DIR-31). 소비 지점은 트리의 `_gitBack` 과
// dirty diff 의 `_back` 둘이다.
function editorGitBackoffMs(){ return gitReposInterval*EDITOR_GIT_BACKOFF_FACTOR }

/**
 * PANEL_SURFACE_SRS FR-CMG-2 / D-7·D-8: **화면 그룹 하나의 항목들.**
 *
 * 서버 응답은 건드리지 않고(D-7) 여기서만 합친다. 합친 뒤의 순서는 **경로**다 —
 * 출신에 따라 뭉치면 같은 폴더의 파일이 목록의 두 자리로 갈린다.
 *
 * 판정이 한 자리인 것이 이 함수의 전부다: 그리는 쪽(`_paintGroup`)과 대상을 모으는
 * 쪽(`_group`)과 다이얼로그의 지문이 같은 묶음을 보아야 한다 (FR-CMG-13).
 */
/**
 * GIT_DETECT_TIER_SRS FR-GDT-23·24: 이 그룹이 서버 상한에서 잘렸는가.
 *
 * 돌려주는 값은 **자르기 전의 개수**이며 잘리지 않았으면 0 이다. 두 출신이
 * 섞이는 그룹(`working`)에서는 원본 중 하나만 잘려도 목록이 잘린 것이므로 합을
 * 낸다 — `gitGroupEntries` 가 합치는 그 키들이다.
 */
function gitGroupTruncated(status,key){
  const t=status&&status.truncated;
  if(!t) return 0;
  const src=GIT_GROUP_SRC[key]||[key];
  let n=0;
  for(const k of src) n+=t[k]||0;
  return n;
}

function gitGroupEntries(status,key){
  if(!status) return [];
  const src=GIT_GROUP_SRC[key];
  if(!src) return status[key]||[];
  const out=[];
  for(const k of src) for(const e of status[k]||[]) out.push(e);
  return out.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}

/**
 * 변경 항목의 **상태문자** (REFACTOR_STABILIZATION_SRS FR-RST-22).
 *
 * 그룹이 어느 축을 보는지가 곧 X/Y 선택이다 — staged 는 X, 나머지는 Y 이고,
 * untracked·conflicts 는 축이 아니라 그룹 자체가 답이다.
 *
 * **두 화면이 이 규칙을 따로 갖고 있었다** — Git 패널의 `_stateChar` 와 탐색기의
 * `_setStatus` 다. 둘 다 "같아야 한다" 고 주석이 밝히면서도 같은 자리에서 나오지
 * 않았고, 그래서 한쪽만 고쳐질 수 있었다. 색표(`GIT_ST_CLASS`)는 이미 공유하고
 * 있었으므로 문자를 뽑는 규칙도 여기로 모은다.
 */
function gitStateChar(group, entry){
  // PANEL_SURFACE_SRS FR-CMG-3: 출신은 **항목**이 안다 (`untracked`) — 워킹 그룹은
  // 두 출신을 함께 담으므로 그룹만으로는 답이 나오지 않는다. 그룹으로 묻는 자리
  // (항목 없이 부르는 탐색기)는 그대로 남는다.
  if(entry&&entry.untracked) return '?';
  if(group==='untracked') return '?';
  if(group==='conflicts') return 'U';
  const xy=(entry&&entry.xy)||'..';
  return group==='staged'?xy[0]:xy[1];
}

/**
 * SUBMODULE_DIRTY_NOTICE_SRS FR-SDN-1~4: porcelain v2 의 `sub` 필드를 두 성분으로
 * 가른다.
 *
 *   S<c><m><u>   c='C' 기록된 커밋(gitlink)이 바뀌었다
 *                m='M' 서브모듈 안에 추적 중인 변경이 있다
 *                u='U' 서브모듈 안에 추적되지 않는 파일이 있다
 *
 * 가르는 이유는 **부모 저장소가 커밋할 수 있는 것이 gitlink 하나**이기 때문이다.
 * `commit` 이 거짓인데 `inner` 만 참인 행은 여기서 스테이지·커밋해도 사라지지
 * 않는다 — `git add` 가 index 에 올릴 변화가 없다 (SRS §1.1 실측).
 *
 * FR-SDN-2: **판정은 이 함수 하나다.** 툴팁과 안내문이 각자 문자열을 뜯으면 두
 * 자리가 서로 다른 답을 낼 수 있고, 그 어긋남은 둘을 나란히 놓기 전까지 아무도
 * 모른다.
 *
 * FR-SDN-4: 자리 수가 모자란 문자열도 오류가 아니다 — 없는 자리는 `.` 로 읽는다.
 * git 이 형식을 늘려도 화면이 깨져서는 안 된다.
 */
function gitSubParts(sub){
  const s=typeof sub==='string'?sub:'';
  // FR-SDN-3: 서브모듈이 아닌 것에 서브모듈의 사정을 말하지 않는다.
  if(s.charAt(0)!==GIT_SUB_IS_SUB) return {commit:false,inner:false};
  return {
    commit:s.charAt(1)===GIT_SUB_COMMIT,
    inner:s.charAt(2)===GIT_SUB_MODIFIED||s.charAt(3)===GIT_SUB_UNTRACKED,
  };
}
