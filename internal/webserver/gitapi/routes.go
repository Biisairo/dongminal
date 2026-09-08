package gitapi

import (
	"net/http"
	"strings"

	"dongminal/internal/webserver/httproute"
)

// /api/git/* 만 이 표가 소유하고, 나머지는 httpapi 가 갖는다.
// route 의 모양과 디스패치는 `httproute` 가 소유한다 (FR-DRC-10) — `httpapi` 가
// 같은 표를 따로 들고 있었다. 여기 남는 것은 **이 표면의 종단 목록**뿐이다.
type route = httproute.Route[*GitServer]

var routes = []route{
	httproute.Get("/api/git/repos", (*GitServer).apiGitRepos),
	httproute.Get("/api/git/repo-at", (*GitServer).apiGitRepoAt),
	// REPO_TAB_UNIFY_SRS FR-RTU-29: 저장소가 아닌 자리를 저장소로 만든다. 핀
	// 추가와 같은 묶음에 두는 이유는 성공의 결과가 곧 핀이기 때문이다.
	httproute.Post("/api/git/init", (*GitServer).apiGitInit),
	httproute.Post("/api/git/repos/pin", (*GitServer).apiGitPin),
	httproute.Post("/api/git/repos/unpin", (*GitServer).apiGitUnpin),
	httproute.Post("/api/git/repos/reorder", (*GitServer).apiGitReorder),
	httproute.Get("/api/git/status", (*GitServer).apiGitStatus),
	httproute.Get("/api/git/signature", (*GitServer).apiGitSignature),
	httproute.Get("/api/git/diff-content", (*GitServer).apiGitDiffContent),
	httproute.Get("/api/git/preflight", (*GitServer).apiGitPreflight),
	httproute.Get("/api/git/policy", (*GitServer).apiGitPolicy),
	httproute.Get("/api/git/recovery", (*GitServer).apiGitRecovery),
	httproute.Post("/api/git/stage", (*GitServer).apiGitStage),
	httproute.Post("/api/git/unstage", (*GitServer).apiGitUnstage),
	httproute.Post("/api/git/discard", (*GitServer).apiGitDiscard),
	httproute.Post("/api/git/resolve", (*GitServer).apiGitResolve),
	httproute.Post("/api/git/commit", (*GitServer).apiGitCommitCreate),
	httproute.Post("/api/git/undo-last", (*GitServer).apiGitUndoLast),
	httproute.Get("/api/git/log", (*GitServer).apiGitLog),
	httproute.Get("/api/git/blame", (*GitServer).apiGitBlame),
	httproute.Get("/api/git/commit", (*GitServer).apiGitCommit),
	httproute.Get("/api/git/refs", (*GitServer).apiGitRefs),
	httproute.Get("/api/git/records", (*GitServer).apiGitRecords),
	// FR-GIT-281: 기록 하나를 다시 실행한다. 클라이언트는 seq 만 보내고 argv 는
	// 서버가 자기 기록에서 꺼낸다 — 문자열을 받아 실행하면 임의 명령 표면이 된다.
	httproute.Post("/api/git/records/replay", (*GitServer).apiGitReplay),
	httproute.Post("/api/git/fetch", (*GitServer).apiGitFetch),
	httproute.Post("/api/git/pull", (*GitServer).apiGitPull),
	httproute.Post("/api/git/push", (*GitServer).apiGitPush),
	httproute.Post("/api/git/job/cancel", (*GitServer).apiGitJobCancel),
	httproute.Get("/api/git/job/events", (*GitServer).apiGitJobEvents),
	httproute.Get("/api/git/jobs", (*GitServer).apiGitJobs),
	// 묶음 E — 원격 목록·Sync·Push preview (GIT_ACTIONS_SRS FR-GIT-269~271).
	httproute.Get("/api/git/remotes", (*GitServer).apiGitRemotes),
	httproute.Post("/api/git/remote/add", (*GitServer).apiGitRemoteAdd),
	httproute.Post("/api/git/remote/remove", (*GitServer).apiGitRemoteRemove),
	// 묶음 N — 브랜치 (GIT_SRS FR-GIT-155~160). 목록은 /api/git/refs 가 이미
	httproute.Post("/api/git/checkout", (*GitServer).apiGitCheckout),
	// FR-GIT-252: 진행 중 작업의 출구(계속·건너뛰기·중단). 종류는 본문이 정한다 —
	// 경로를 종류마다 두면 새 작업이 늘 때 라우트가 함께 늘어난다.
	httproute.Post("/api/git/operation", (*GitServer).apiGitOperation),
	httproute.Post("/api/git/branch", (*GitServer).apiGitBranchCreate),
	httproute.Get("/api/git/branch/validate", (*GitServer).apiGitBranchValidate),
	// 묶음 B — 브랜치 동작 (GIT_ACTIONS_SRS §3.2 FR-GIT-253~259 · §3.5 FR-GIT-268).
	// 원격으로 나가는 셋(push · fetch into local · 원격 ref 삭제)만 job 경로다.
	httproute.Post("/api/git/branch/rename", (*GitServer).apiGitBranchRename),
	httproute.Post("/api/git/branch/delete", (*GitServer).apiGitBranchDelete),
	httproute.Post("/api/git/branch/merge", (*GitServer).apiGitBranchMerge),
	httproute.Post("/api/git/branch/rebase", (*GitServer).apiGitBranchRebase),
	httproute.Post("/api/git/branch/upstream", (*GitServer).apiGitBranchUpstream),
	httproute.Get("/api/git/branch/merge-preview", (*GitServer).apiGitBranchMergePreview),
	httproute.Post("/api/git/branch/push", (*GitServer).apiGitBranchPush),
	httproute.Post("/api/git/branch/fetch", (*GitServer).apiGitBranchFetchInto),
	httproute.Post("/api/git/branch/delete-remote", (*GitServer).apiGitBranchDeleteRemote),
	httproute.Get("/api/git/stash", (*GitServer).apiGitStashList),
	httproute.Get("/api/git/stash/show", (*GitServer).apiGitStashShow),
	httproute.Post("/api/git/stash/push", (*GitServer).apiGitStashPush),
	httproute.Post("/api/git/stash/apply", (*GitServer).apiGitStashApply),
	httproute.Post("/api/git/stash/pop", (*GitServer).apiGitStashPop),
	httproute.Post("/api/git/stash/drop", (*GitServer).apiGitStashDrop),
	// 묶음 C — 태그 (GIT_ACTIONS_SRS §3.3, FR-GIT-260~262). 목록은 /api/git/refs 가
	// 이미 준다. 삭제가 둘인 것은 로컬과 원격이 다른 항목이기 때문이다 (FR-GIT-261).
	httproute.Post("/api/git/tag", (*GitServer).apiGitTagCreate),
	httproute.Get("/api/git/tag/validate", (*GitServer).apiGitTagValidate),
	httproute.Post("/api/git/tag/delete", (*GitServer).apiGitTagDelete),
	httproute.Post("/api/git/tag/push", (*GitServer).apiGitTagPush),
	httproute.Post("/api/git/tag/delete-remote", (*GitServer).apiGitTagDeleteRemote),
	// 묶음 F — stash·파일·미커밋 행 (GIT_ACTIONS_SRS §3.6 FR-GIT-272~275·277).
	httproute.Post("/api/git/stash/branch", (*GitServer).apiGitStashBranch),
	httproute.Post("/api/git/ignore", (*GitServer).apiGitIgnoreAdd),
	httproute.Get("/api/git/file-head", (*GitServer).apiGitFileHead),
	httproute.Post("/api/git/uncommitted/reset", (*GitServer).apiGitUncommittedReset),
	httproute.Post("/api/git/uncommitted/clean", (*GitServer).apiGitUncommittedClean),
	// 묶음 G — 부분 스테이징 (GIT_ACTIONS_SRS §3.7, FR-GIT-278·279). 패치는 서버가
	// 만든다 — hunks 로 경계를 받고, patch 로는 좌표만 보낸다 (D6).
	httproute.Get("/api/git/hunks", (*GitServer).apiGitHunks),
	httproute.Post("/api/git/patch", (*GitServer).apiGitPatch),
	// 묶음 D — 커밋 동작 (GIT_ACTIONS_SRS §3.4, FR-GIT-263~267). cherry-pick 과
	// revert 는 부모 선택 규약이 같지만 뜻이 다른 두 동작이므로 경로도 둘이다 —
	// 하나에 몰면 화면이 무엇을 실행했는지 기록에서 갈라 볼 수 없다.
	httproute.Post("/api/git/cherry-pick", (*GitServer).apiGitCherryPick),
	httproute.Post("/api/git/revert", (*GitServer).apiGitRevert),
	httproute.Post("/api/git/reset", (*GitServer).apiGitReset),
	httproute.Post("/api/git/drop", (*GitServer).apiGitDrop),
	httproute.Get("/api/git/commit-range", (*GitServer).apiGitCommitRange),
	// 묶음 W7 — Worktrees 탭 (GIT_REVIEW4_SRS §3.6.5, FR-GIT-240~243).
	// UX_BATCH5_SRS FR-SUB-1·4 — 서브모듈의 목록과 조작. worktree 와 같은 자리에
	// 두는 이유는 같은 성질이기 때문이다: 둘 다 domain/git 밖의 Manager 를 지난다.
	httproute.Get("/api/git/submodules", (*GitServer).apiGitSubmodules),
	httproute.Post("/api/git/submodules/update", (*GitServer).apiGitSubmoduleUpdate),
	httproute.Post("/api/git/submodules/sync", (*GitServer).apiGitSubmoduleSync),
	httproute.Get("/api/git/worktrees", (*GitServer).apiGitWorktrees),
	httproute.Post("/api/git/worktrees/create", (*GitServer).apiGitWorktreeCreate),
	httproute.Post("/api/git/worktrees/remove", (*GitServer).apiGitWorktreeRemove),
}

// Handle은 /api/git/* 요청을 처리하고 처리 여부를 돌려준다. false 면 호출자가
// 404 를 낸다 — 라우팅 실패를 이 패키지가 삼키지 않는다.
func (g *GitServer) Handle(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/api/git/") {
		return false
	}
	return httproute.Dispatch(routes, g, w, r)
}
