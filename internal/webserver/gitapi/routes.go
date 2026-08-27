package gitapi

import (
	"net/http"
	"strings"
)

// route는 method+path 매처와 핸들러를 묶는다. httpapi 의 apiRoute 와 같은 형태다
// — /api/git/* 만 이 테이블이 소유하고, 나머지는 httpapi 가 갖는다.
type route struct {
	method string // "" 이면 아무 method 나 매칭
	match  func(path string) bool
	handle func(g *GitServer, w http.ResponseWriter, r *http.Request)
}

func exactPath(p string) func(string) bool {
	return func(s string) bool { return s == p }
}

var routes = []route{
	{http.MethodGet, exactPath("/api/git/repos"), (*GitServer).apiGitRepos},
	{http.MethodPost, exactPath("/api/git/repos/pin"), (*GitServer).apiGitPin},
	{http.MethodPost, exactPath("/api/git/repos/unpin"), (*GitServer).apiGitUnpin},
	{http.MethodPost, exactPath("/api/git/repos/reorder"), (*GitServer).apiGitReorder},
	{http.MethodGet, exactPath("/api/git/status"), (*GitServer).apiGitStatus},
	{http.MethodGet, exactPath("/api/git/signature"), (*GitServer).apiGitSignature},
	{http.MethodGet, exactPath("/api/git/diff-content"), (*GitServer).apiGitDiffContent},
	{http.MethodGet, exactPath("/api/git/preflight"), (*GitServer).apiGitPreflight},
	{http.MethodGet, exactPath("/api/git/policy"), (*GitServer).apiGitPolicy},
	{http.MethodGet, exactPath("/api/git/recovery"), (*GitServer).apiGitRecovery},
	{http.MethodPost, exactPath("/api/git/stage"), (*GitServer).apiGitStage},
	{http.MethodPost, exactPath("/api/git/unstage"), (*GitServer).apiGitUnstage},
	{http.MethodPost, exactPath("/api/git/discard"), (*GitServer).apiGitDiscard},
	{http.MethodPost, exactPath("/api/git/resolve"), (*GitServer).apiGitResolve},
	{http.MethodPost, exactPath("/api/git/commit"), (*GitServer).apiGitCommitCreate},
	{http.MethodPost, exactPath("/api/git/undo-last"), (*GitServer).apiGitUndoLast},
	{http.MethodGet, exactPath("/api/git/log"), (*GitServer).apiGitLog},
	{http.MethodGet, exactPath("/api/git/commit"), (*GitServer).apiGitCommit},
	{http.MethodGet, exactPath("/api/git/refs"), (*GitServer).apiGitRefs},
	{http.MethodGet, exactPath("/api/git/records"), (*GitServer).apiGitRecords},
	// FR-GIT-281: 기록 하나를 다시 실행한다. 클라이언트는 seq 만 보내고 argv 는
	// 서버가 자기 기록에서 꺼낸다 — 문자열을 받아 실행하면 임의 명령 표면이 된다.
	{http.MethodPost, exactPath("/api/git/records/replay"), (*GitServer).apiGitReplay},
	{http.MethodPost, exactPath("/api/git/fetch"), (*GitServer).apiGitFetch},
	{http.MethodPost, exactPath("/api/git/pull"), (*GitServer).apiGitPull},
	{http.MethodPost, exactPath("/api/git/push"), (*GitServer).apiGitPush},
	{http.MethodPost, exactPath("/api/git/job/cancel"), (*GitServer).apiGitJobCancel},
	{http.MethodGet, exactPath("/api/git/job/events"), (*GitServer).apiGitJobEvents},
	{http.MethodGet, exactPath("/api/git/jobs"), (*GitServer).apiGitJobs},
	// 묶음 N — 브랜치 (GIT_SRS FR-GIT-155~160). 목록은 /api/git/refs 가 이미
	{http.MethodPost, exactPath("/api/git/checkout"), (*GitServer).apiGitCheckout},
	// FR-GIT-252: 진행 중 작업의 출구(계속·건너뛰기·중단). 종류는 본문이 정한다 —
	// 경로를 종류마다 두면 새 작업이 늘 때 라우트가 함께 늘어난다.
	{http.MethodPost, exactPath("/api/git/operation"), (*GitServer).apiGitOperation},
	{http.MethodPost, exactPath("/api/git/branch"), (*GitServer).apiGitBranchCreate},
	{http.MethodGet, exactPath("/api/git/branch/validate"), (*GitServer).apiGitBranchValidate},
	{http.MethodGet, exactPath("/api/git/stash"), (*GitServer).apiGitStashList},
	{http.MethodGet, exactPath("/api/git/stash/show"), (*GitServer).apiGitStashShow},
	{http.MethodPost, exactPath("/api/git/stash/push"), (*GitServer).apiGitStashPush},
	{http.MethodPost, exactPath("/api/git/stash/apply"), (*GitServer).apiGitStashApply},
	{http.MethodPost, exactPath("/api/git/stash/pop"), (*GitServer).apiGitStashPop},
	{http.MethodPost, exactPath("/api/git/stash/drop"), (*GitServer).apiGitStashDrop},
	// 묶음 C — 태그 (GIT_ACTIONS_SRS §3.3, FR-GIT-260~262). 목록은 /api/git/refs 가
	// 이미 준다. 삭제가 둘인 것은 로컬과 원격이 다른 항목이기 때문이다 (FR-GIT-261).
	{http.MethodPost, exactPath("/api/git/tag"), (*GitServer).apiGitTagCreate},
	{http.MethodGet, exactPath("/api/git/tag/validate"), (*GitServer).apiGitTagValidate},
	{http.MethodPost, exactPath("/api/git/tag/delete"), (*GitServer).apiGitTagDelete},
	{http.MethodPost, exactPath("/api/git/tag/push"), (*GitServer).apiGitTagPush},
	{http.MethodPost, exactPath("/api/git/tag/delete-remote"), (*GitServer).apiGitTagDeleteRemote},
	// 묶음 F — stash·파일·미커밋 행 (GIT_ACTIONS_SRS §3.6 FR-GIT-272~275·277).
	{http.MethodPost, exactPath("/api/git/stash/branch"), (*GitServer).apiGitStashBranch},
	{http.MethodPost, exactPath("/api/git/ignore"), (*GitServer).apiGitIgnoreAdd},
	{http.MethodGet, exactPath("/api/git/file-head"), (*GitServer).apiGitFileHead},
	{http.MethodPost, exactPath("/api/git/uncommitted/reset"), (*GitServer).apiGitUncommittedReset},
	{http.MethodPost, exactPath("/api/git/uncommitted/clean"), (*GitServer).apiGitUncommittedClean},
	// 묶음 G — 부분 스테이징 (GIT_ACTIONS_SRS §3.7, FR-GIT-278·279). 패치는 서버가
	// 만든다 — hunks 로 경계를 받고, patch 로는 좌표만 보낸다 (D6).
	{http.MethodGet, exactPath("/api/git/hunks"), (*GitServer).apiGitHunks},
	{http.MethodPost, exactPath("/api/git/patch"), (*GitServer).apiGitPatch},
	// 묶음 W7 — Worktrees 탭 (GIT_REVIEW4_SRS §3.6.5, FR-GIT-240~243).
	{http.MethodGet, exactPath("/api/git/worktrees"), (*GitServer).apiGitWorktrees},
	{http.MethodPost, exactPath("/api/git/worktrees/create"), (*GitServer).apiGitWorktreeCreate},
	{http.MethodPost, exactPath("/api/git/worktrees/remove"), (*GitServer).apiGitWorktreeRemove},
}

// Handle은 /api/git/* 요청을 처리하고 처리 여부를 돌려준다. false 면 호출자가
// 404 를 낸다 — 라우팅 실패를 이 패키지가 삼키지 않는다.
func (g *GitServer) Handle(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/api/git/") {
		return false
	}
	for _, rt := range routes {
		if rt.method != "" && rt.method != r.Method {
			continue
		}
		if rt.match(r.URL.Path) {
			rt.handle(g, w, r)
			return true
		}
	}
	return false
}
