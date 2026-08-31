package gitapi

import (
	"context"
	"net/http"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
)

// /api/git/{hunks,patch} — 부분 스테이징 (GIT_ACTIONS_SRS §3.7 FR-GIT-278·279).
//
// **패치는 서버가 만든다** (D6). 이 파일에 클라이언트의 패치 문자열이 들어올 자리가
// 없다 — 요청 구조체에 그런 필드가 없고, 본문에 실려 와도 decode 에서 버려진다.
// 클라이언트가 보내는 것은 좌표뿐이다: (경로, 축, hunk 번호, 줄 범위, 관측 식별자).
//
// 읽기(hunks)와 쓰기(patch)를 한 파일에 두는 이유는 둘이 **같은 관측 식별자**로
// 묶이기 때문이다. 식별자를 만드는 쪽과 검사하는 쪽이 갈라지면 규약이 두 벌이 된다.

// 부분 스테이징 고유의 거부 코드. 상태 코드만으로는 무엇이 왜 막혔는지 구분할 수
// 없다 — 특히 stale 은 "다시 받아서 다시 고르라"는 뜻이라 사용자가 알아야 한다.
//
// `patch_empty` 는 여기 없다. 그 판정이 `apierr.Git` 테이블로 옮겨 가면서
// (FR-DPN-4) 이 패키지에서 그 이름을 쓰는 자리가 없어졌다 — 값은
// `apierr.CodePatchEmpty` 하나로 남는다.
const gitErrStaleObservation = apierr.CodeStaleObservation

// gitHunksRequested 는 hunks 응답이 되돌려주는 요청값이다 (FR-GIT-16·54) — 같은
// 세대 안에서도 응답 순서가 뒤바뀔 수 있으므로 클라이언트가 짝을 확인한다.
type gitHunksRequested struct {
	Repo string `json:"repo"`
	Axis string `json:"axis"`
	Path string `json:"path"`
}

type gitHunksResponse struct {
	Requested gitHunksRequested `json:"requested"`
	query.FileDiff
}

// gitPatchReq 는 조각 하나를 적용하는 요청이다.
//
// **패치·본문을 담는 필드가 없다** (D6, 검증 V204). 필드 하나가 늘어나는 순간
// `git apply` 가 임의 쓰기 표면이 되므로 구조를 테스트로 고정한다.
type gitPatchReq struct {
	Repo string `json:"repo"`
	Axis string `json:"axis"`
	Path string `json:"path"`
	Op   string `json:"op"`
	// Hunk 는 0-기반 덩어리 번호, From·To 는 그 덩어리 본문 안의 1-기반 줄 번호다.
	// 둘 다 0 이면 덩어리 전체다 (FR-GIT-279).
	Hunk int `json:"hunk"`
	From int `json:"from"`
	To   int `json:"to"`
	// DiffID 는 클라이언트가 보고 고른 관측의 식별자다 (/api/git/hunks 가 준다).
	DiffID  string `json:"diffId"`
	Confirm bool   `json:"confirm"`
}

// GET /api/git/hunks?repo=<abs>&axis=<axis>&path=<rel> — 서버가 만든 diff 의 경계
// (FR-GIT-278). 읽기이며 저장소를 바꾸지 않는다.
func (s *GitServer) apiGitHunks(w http.ResponseWriter, r *http.Request) {
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	req := gitHunksRequested{Repo: requested, Axis: q.Get("axis"), Path: q.Get("path")}
	fd, err := query.HunksOf(s.Git.Service(), r.Context(), root, req.Axis, req.Path)
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, gitHunksResponse{Requested: req, FileDiff: fd})
}

// POST /api/git/patch — 조각 하나를 적용한다 (FR-GIT-278·279).
//
// revert 는 **파괴적이다** — 워킹 트리의 그 줄을 버린다. `confirm:true` 가 없으면
// 실행하지 않는다: 클라이언트만 막으면 API 직접 호출이 그대로 우회한다.
func (s *GitServer) apiGitPatch(w http.ResponseWriter, r *http.Request) {
	var req gitPatchReq
	t := s.beginWrite(w, r, &req)
	// 파괴적 여부는 **동작에서 파생한다** — 목록을 여기에 복제하지 않는다.
	_, destructive, err := write.PatchArgs(req.Op)
	if err != nil {
		t.rejectWith(http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
	}
	t.requireConfirm(destructive, req.Confirm,
		"파괴적 동작은 confirm:true 를 요구한다 (FR-GIT-89)")
	t.resolve(req.Repo)
	t.apply(func(ctx context.Context) error {
		_, err := write.Patch(s.Git.Service(), ctx, t.root, write.PatchOpts{
			Op: req.Op, Axis: req.Axis, Path: req.Path,
			Hunk: req.Hunk, From: req.From, To: req.To, DiffID: req.DiffID,
		})
		return err
	})
	// 요청값을 되돌려준다 — 어느 조각이 적용됐는지 클라이언트가 짝을 확인한다.
	t.ok(map[string]any{
		"op": req.Op, "axis": req.Axis, "path": req.Path,
		"hunk": req.Hunk, "from": req.From, "to": req.To,
	})
}
