/**
 * API 경로 표 (OPTIMIZE_REFACTOR_SRS FR-OPT-12-5 · FEU-32).
 *
 * `/api/git/…` 경로는 이 표 하나가 적는다 — 종전에는 ui/git 에 리터럴 68종이 흩어져 있었고,
 * status 경로 상수가 있는데도 손으로 조립하는 자리가 남았다. FR-EDT-71: 탐색기 색의 근거는
 * status **하나**다 — 펼침마다 중첩 저장소를 찾으면 펼침 수만큼 rev-parse 가 붙는다 (D-6). 의존이 없는 파일이라 단위
 * 검사가 홀로 싣는다. 조회(GET)는 `gitFetch(GIT_API.x, params, opts)` 한 길을 지난다
 * (`scripts/check-fetch.sh` 가 잰다).
 */
const GIT_API=Object.freeze({
  blob:'/api/git/blob',
  blame:'/api/git/blame',
  branch:'/api/git/branch',
  branchDelete:'/api/git/branch/delete',
  branchMerge:'/api/git/branch/merge',
  branchMergePreview:'/api/git/branch/merge-preview',
  branchRebase:'/api/git/branch/rebase',
  branchRename:'/api/git/branch/rename',
  branchUpstream:'/api/git/branch/upstream',
  branchValidate:'/api/git/branch/validate',
  checkout:'/api/git/checkout',
  cherryPick:'/api/git/cherry-pick',
  commit:'/api/git/commit',
  commitRange:'/api/git/commit-range',
  diffContent:'/api/git/diff-content',
  discard:'/api/git/discard',
  drop:'/api/git/drop',
  fileHead:'/api/git/file-head',
  hunks:'/api/git/hunks',
  ignore:'/api/git/ignore',
  init:'/api/git/init',
  jobCancel:'/api/git/job/cancel',
  jobEvents:'/api/git/job/events',
  jobs:'/api/git/jobs',
  lockRemove:'/api/git/lock/remove',
  log:'/api/git/log',
  operation:'/api/git/operation',
  patch:'/api/git/patch',
  policy:'/api/git/policy',
  preflight:'/api/git/preflight',
  records:'/api/git/records',
  recordsReplay:'/api/git/records/replay',
  refs:'/api/git/refs',
  remoteAdd:'/api/git/remote/add',
  remoteRemove:'/api/git/remote/remove',
  remotes:'/api/git/remotes',
  repoAt:'/api/git/repo-at',
  repos:'/api/git/repos',
  reposPin:'/api/git/repos/pin',
  reposReorder:'/api/git/repos/reorder',
  reposUnpin:'/api/git/repos/unpin',
  reset:'/api/git/reset',
  resolve:'/api/git/resolve',
  revert:'/api/git/revert',
  stage:'/api/git/stage',
  stash:'/api/git/stash',
  stashApply:'/api/git/stash/apply',
  stashBranch:'/api/git/stash/branch',
  stashDrop:'/api/git/stash/drop',
  stashPop:'/api/git/stash/pop',
  stashPush:'/api/git/stash/push',
  stashShow:'/api/git/stash/show',
  status:'/api/git/status',
  submodules:'/api/git/submodules',
  submodulesSync:'/api/git/submodules/sync',
  submodulesUpdate:'/api/git/submodules/update',
  tag:'/api/git/tag',
  tagDelete:'/api/git/tag/delete',
  tagDeleteRemote:'/api/git/tag/delete-remote',
  tagPush:'/api/git/tag/push',
  tagValidate:'/api/git/tag/validate',
  uncommittedClean:'/api/git/uncommitted/clean',
  uncommittedReset:'/api/git/uncommitted/reset',
  undoLast:'/api/git/undo-last',
  unstage:'/api/git/unstage',
  worktrees:'/api/git/worktrees',
  worktreesCreate:'/api/git/worktrees/create',
  worktreesRemove:'/api/git/worktrees/remove',
});
// 원격 동작의 기본 규칙 `/api/git/<kind>` (FR-GIT-262) — 표에 없는 kind 는 이 접두로 선다.
const GIT_API_PREFIX='/api/git/';

// Run·터미널이 쓰는 종단 (ui/). 도구 생성·파일·편집기·LSP 의 것은 제 상수 파일에 있다.
const RUNS_API='/api/runs';
const RUNS_CLOSE_API='/api/runs/close';
const RUNS_ATTACH_API='/api/runs/attach';
const RUNS_DETACH_API='/api/runs/detach';
const CWD_API='/api/cwd';
const UPLOAD_API='/api/upload';
