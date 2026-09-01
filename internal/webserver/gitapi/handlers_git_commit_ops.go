package gitapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/write"
)

// /api/git/{cherry-pick,revert,reset,drop} + /api/git/commit-range — 커밋 동작
// (GIT_ACTIONS_SRS §3.4 / FR-GIT-263~267).
//
// **서버가 마지막 방어선이다** (FR-GIT-250.3). 머지 커밋의 부모 선택과 `--hard` 의
// 2단계 확인을 클라이언트만 막으면 API 직접 호출이 그대로 우회한다.
//
// **진행 중 상태를 실패로 뭉개지 않는다.** cherry-pick·revert·drop 이 충돌로
// 멈추면 저장소에 중간 상태가 남고, 그 출구는 `/api/git/operation` 이 이미 준다
// (FR-GIT-251·252) — 여기서 새 출구를 만들지 않는다.

// 커밋 동작 고유의 거부 코드. 상태 코드만으로는 무엇이 왜 막혔는지 구분할 수 없다.
const (
	// gitErrMergeParent 는 머지 커밋인데 부모 번호가 없다는 것이다 (FR-GIT-263).
	gitErrMergeParent = apierr.CodeMergeParent
)

// gitPickReq 는 cherry-pick·revert 의 본문이다.
//
// **merge 를 요청이 정하지 않는다** — 그것은 저장소가 답하는 사실이며 서버가
// 실행 전에 다시 묻는다.
type gitPickReq struct {
	Repo     string `json:"repo"`
	Oid      string `json:"oid"`
	Mainline int    `json:"mainline"` // 머지 커밋의 부모 번호 (1-based)
	NoCommit bool   `json:"noCommit"` // revert 만 (FR-GIT-264)
}

// gitResetReq 는 "Reset to here" 의 본문이다 (FR-GIT-265). Confirm 은 `--hard`
// 하나를 위한 것이다 — 파괴 여부가 옵션에서 파생하므로 확인 요구도 그렇다.
type gitResetReq struct {
	Repo    string `json:"repo"`
	Oid     string `json:"oid"`
	Mode    string `json:"mode"` // soft | mixed | hard. 비면 mixed
	Confirm bool   `json:"confirm"`
}

// gitDropReq 는 커밋 하나를 빼는 본문이다 (FR-GIT-266).
type gitDropReq struct {
	Repo    string `json:"repo"`
	Oid     string `json:"oid"`
	Confirm bool   `json:"confirm"`
}

// POST /api/git/cherry-pick — 지목한 커밋을 현재 브랜치에 얹는다 (FR-GIT-263).
func (s *GitServer) apiGitCherryPick(w http.ResponseWriter, r *http.Request) {
	s.gitPick(w, r, write.PickCherry)
}

// POST /api/git/revert — 지목한 커밋을 되돌리는 커밋을 만든다 (FR-GIT-264).
func (s *GitServer) apiGitRevert(w http.ResponseWriter, r *http.Request) {
	s.gitPick(w, r, write.PickRevert)
}

// gitPick 은 cherry-pick·revert 의 공통 경로다. 둘은 부모 선택 규약이 같으므로
// 방어를 두 벌로 두지 않는다 — 한쪽만 고쳐지면 다른 쪽이 틀린 부모를 집는다.
func (s *GitServer) gitPick(w http.ResponseWriter, r *http.Request, verb string) {
	var req gitPickReq
	t := s.beginWrite(w, r, &req)
	t.resolve(req.Repo)
	if t.stop() {
		return
	}
	// 머지 여부는 **저장소에** 묻는다 (FR-GIT-263). 요청이 정하게 두면 화면이 낡은
	// 순간에 부모 없는 머지가 그대로 지나간다.
	parents, ok := s.gitCommitParents(w, r, t.root, req.Oid)
	if !ok {
		return
	}
	opts := write.PickOpts{
		Oid: req.Oid, Merge: len(parents) > 1, Mainline: req.Mainline, NoCommit: req.NoCommit,
	}
	// 잘못된 요청은 실행 **전에** 답한다. apply 를 지나면 코드가 500 이 되고,
	// 클라이언트는 자기 요청이 틀렸다는 것을 알 수 없다. 부모 목록을 함께
	// 실어야 하므로 파이프라인의 공용 거부가 아니라 전용 렌더러다.
	if _, err := write.PickArgs(verb, opts); err != nil {
		gitCommitOpError(w, err, parents)
		return
	}
	t.apply(func(ctx context.Context) error {
		_, err := write.Pick(s.Git.Service(), ctx, t.root, verb, opts)
		return err
	})
	t.ok(nil)
}

// POST /api/git/reset — 현재 브랜치를 그 커밋으로 옮긴다 (FR-GIT-265).
//
// **`--hard` 만 확인을 요구한다.** 파괴 여부가 옵션에서 파생하므로(FR-GIT-250.1)
// 확인의 조건도 하위 명령이 아니라 옵션에서 나온다.
func (s *GitServer) apiGitReset(w http.ResponseWriter, r *http.Request) {
	var req gitResetReq
	t := s.beginWrite(w, r, &req)
	t.requireConfirm(req.Mode == write.ResetHard, req.Confirm,
		"reset --hard 는 워킹 트리와 index 의 변경을 버린다: confirm:true 를 요구한다 (FR-GIT-89·265)")
	opts := write.ResetOpts{Oid: req.Oid, Mode: req.Mode}
	// 인자 검증이 repo 해석보다 **앞이다** — 순서를 바꾸면 잘못된 mode 와 잘못된
	// repo 가 함께 온 요청에서 답이 달라진다.
	if _, err := write.ResetArgs(opts); err != nil {
		t.reject(err)
	}
	t.resolve(req.Repo)
	// hint 는 **옮기기 전** HEAD 를 실어야 되살릴 수 있다 (FR-GIT-250.2). 실행 후에
	// 읽으면 이미 옮겨간 자리를 가리킨다.
	headOid := t.snapshot().Oid
	t.apply(func(ctx context.Context) error {
		_, err := write.Reset(s.Git.Service(), ctx, t.root, opts, headOid)
		return err
	})
	t.ok(nil)
}

// POST /api/git/drop — 커밋 하나를 히스토리에서 뺀다 (FR-GIT-266).
//
// **파괴적이다** (`commit_drop`) — 뒤따르는 커밋의 해시가 전부 바뀐다.
func (s *GitServer) apiGitDrop(w http.ResponseWriter, r *http.Request) {
	var req gitDropReq
	t := s.beginWrite(w, r, &req)
	t.requireConfirm(true, req.Confirm,
		"커밋을 빼면 뒤따르는 커밋의 해시가 전부 바뀐다: confirm:true 를 요구한다 (FR-GIT-89·266)")
	if _, err := write.DropArgs(req.Oid); err != nil {
		t.reject(err)
	}
	t.resolve(req.Repo)
	if t.stop() {
		return
	}
	// 머지 커밋은 `<oid>^` 로 뺄 수 없다 — 첫 부모만 남고 나머지 갈래가 조용히
	// 사라진다. 루트 커밋은 `^` 가 가리킬 것이 없다.
	parents, ok := s.gitCommitParents(w, r, t.root, req.Oid)
	if !ok {
		return
	}
	if len(parents) != 1 {
		t.rejectWith(http.StatusBadRequest, gitErrBadRequest,
			"부모가 하나인 커밋만 뺄 수 있다 (부모 "+strconv.Itoa(len(parents))+"개)")
		return
	}
	headOid := t.snapshot().Oid
	t.apply(func(ctx context.Context) error {
		_, err := write.Drop(s.Git.Service(), ctx, t.root, req.Oid, headOid)
		return err
	})
	t.ok(nil)
}

// GET /api/git/commit-range?repo=&from=&to=&symmetric= — 두 리비전 사이의 범위.
//
// 두 자리가 이것을 쓴다:
//
//   - reset 다이얼로그의 **영향 커밋 수** (FR-GIT-265, G11) — `from=<oid>&to=HEAD`.
//   - Compare with 의 **왼쪽 리비전** (FR-GIT-267) — `A...B` 는 merge-base 를
//     왼쪽으로 잡는다. `A..B` 와 같게 다루면 사용자가 고른 것과 다른 비교를 본다.
//
// **새 diff 축을 만들지 않는다.** 여기서 정한 두 oid 는 이미 있는 `commit-parent`
// 축(FR-GIT-138)의 두 끝으로 그대로 들어간다.
func (s *GitServer) apiGitCommitRange(w http.ResponseWriter, r *http.Request) {
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	from, to := q.Get("from"), q.Get("to")
	for _, f := range []struct{ name, val string }{{"from", from}, {"to", to}} {
		if err := core.CheckRefArg(f.name, f.val); err != nil {
			gitFail(w, http.StatusBadRequest, gitErrRefName, gitTail(err.Error()))
			return
		}
	}
	if q.Get("symmetric") != "" {
		base, err := s.gitMergeBase(r.Context(), root, from, to)
		if err != nil {
			gitError(w, err)
			return
		}
		from = base
	}
	n, err := s.gitRangeCount(r.Context(), root, from, to)
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"requested": requested, "repo": root,
		"from": from, "to": to, "count": n,
	})
}

// gitCommitParents 는 그 커밋의 부모 oid 들이다. 실패하면 응답이 이미 쓰였다.
//
// **머지 판정이 여기 한 자리다** — cherry-pick·revert 의 부모 선택과 drop 의 거부가
// 같은 값을 딛는다. 두 벌이면 한쪽만 고쳐진다.
func (s *GitServer) gitCommitParents(w http.ResponseWriter, r *http.Request, root, oid string) ([]string, bool) {
	if err := core.CheckRefArg("oid", oid); err != nil {
		gitFail(w, http.StatusBadRequest, gitErrRefName, gitTail(err.Error()))
		return nil, false
	}
	out, err := s.Git.Service().Exec(r.Context(), root, "log", "-n", "1", "--format=%P", oid)
	if err != nil {
		gitError(w, err)
		return nil, false
	}
	return strings.Fields(out.Stdout), true
}

// gitMergeBase 는 `A...B` 의 왼쪽이다. `git rev-parse A...B` 가 A·B 와 `^merge-base`
// 를 주므로 `^` 로 시작하는 줄이 답이다 — merge-base 하위 명령은 읽기 허용 목록에
// 없고, 목록을 넓히는 것보다 이미 있는 것으로 답하는 쪽이 좁다.
func (s *GitServer) gitMergeBase(ctx context.Context, root, a, b string) (string, error) {
	out, err := s.Git.Service().Exec(ctx, root, "rev-parse", a+"..."+b)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(out.Stdout, "\n") {
		if v := strings.TrimSpace(line); strings.HasPrefix(v, "^") {
			return strings.TrimPrefix(v, "^"), nil
		}
	}
	// 공통 조상이 없는 두 갈래다. 지어내지 않고 왼쪽을 그대로 쓴다.
	return a, nil
}

// gitRangeCount 는 `from..to` 의 커밋 수다 (FR-GIT-265 의 G11).
func (s *GitServer) gitRangeCount(ctx context.Context, root, from, to string) (int, error) {
	out, err := s.Git.Service().Exec(ctx, root, "rev-list", "--count", from+".."+to)
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(out.Stdout))
	if err != nil {
		return 0, nil
	}
	return n, nil
}

// gitCommitOpError 는 커밋 동작의 거부를 응답으로 옮긴다.
//
// **여기 남은 것은 오류값만으로 응답이 결정되지 않는 하나뿐이다** — 부모 번호가
// 빠졌을 때는 부모 목록을 함께 줘야 하고(FR-GIT-263), 그 목록은 오류가 들고 있지
// 않다. 무엇을 고를 수 있는지 모르면 화면은 물을 수도 없다.
//
// 나머지 판정(reset 모드·pick 동사·ref 이름)은 `apierr.Git` 이 소유한다
// (FR-DPN-5). ref 이름이 여기서 `bad_request` 였던 것은 branch·tag 와 갈린
// 드리프트였고, 지금은 표면 전체가 `ref_name_invalid` 다 (FR-DPN-10).
func gitCommitOpError(w http.ResponseWriter, err error, parents []string) {
	if errors.Is(err, write.ErrMergeParent) {
		gitJSON(w, http.StatusBadRequest, map[string]any{
			"error":   gitErrMergeParent,
			"message": gitTail(err.Error()),
			"parents": gitParentList(parents),
		})
		return
	}
	gitError(w, err)
}

// gitParentList 는 JSON 에서 null 이 되지 않는 목록이다 — null 이면 클라이언트가
// "부모를 못 읽었다"와 "부모가 없다"를 구분할 수 없다.
func gitParentList(parents []string) []string {
	if parents == nil {
		return []string{}
	}
	return parents
}
