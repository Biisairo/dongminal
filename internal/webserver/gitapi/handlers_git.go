package gitapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// /api/git/* — 리포 해석·핀·상태·시그니처 (GIT_SRS §3.8 FR-GIT-60~63).
//
// 모든 실패는 JSON 본문이며 **클라이언트가 종류를 구분할 수 있어야 한다.** 상태
// 코드만으로는 프록시가 만든 500 과 git 실패를 가릴 수 없다.
const (
	gitErrBadRequest = "bad_request"
	gitErrNotRepo    = "not_a_git_repo"
	// GIT_REPO_MISSING_SRS FR-RMS-4: 폴더 자체가 사라졌다. 저장소가 아닌 것과
	// 갈라 두어야 클라이언트가 "사라졌습니다" 를 확정으로 말할 수 있다.
	gitErrRepoMissing = "repo_missing"
	gitErrMissing     = "git_missing"
	gitErrTimeout     = "git_timeout"
	gitErrCanceled    = "git_canceled"
	gitErrUnavailable = "git_unavailable"
	gitErrFailed      = "git_failed"
)

// gitMessageMax 는 오류 본문에 실을 메시지 길이 상한이다. git 의 stderr 는 1MiB
// 까지 보존되므로(FR-GIT-6) 그대로 실으면 응답이 로그가 된다.
const gitMessageMax = 2048

func gitJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(body)
}

func gitFail(w http.ResponseWriter, code int, name, msg string) {
	gitJSON(w, code, map[string]any{"error": name, "message": msg})
}

// gitUnavailable 은 git 표면만 닫는다. 다른 엔드포인트에는 영향이 없다.
func gitUnavailable(w http.ResponseWriter) {
	gitFail(w, http.StatusServiceUnavailable, gitErrUnavailable, "git 서비스가 구성되지 않았다")
}

// gitErrorCode 는 실패를 클라이언트가 분기할 수 있는 코드로 옮긴다. 분류되지 않은
// 실패는 500 이며, 사유는 stderr tail 로 남는다 (FR-GIT-96 의 정신).
// 499 는 표준 코드가 아니라 nginx 관례라 Go 에 상수가 없다. 이름을 여기 한 번만
// 두고 그것만 쓴다 (FR-GIT-217).
const statusClientClosed = 499

func gitErrorCode(err error) (int, string) {
	switch {
	case errors.Is(err, core.ErrNotRepo):
		return http.StatusNotFound, gitErrNotRepo
	// 저장소 아님과 같은 404 다 — 둘 다 "네가 지목한 것이 거기 없다" 이고, 갈리는
	// 것은 상태 코드가 아니라 `error` 필드다 (FR-RMS-4).
	case errors.Is(err, core.ErrRepoMissing):
		return http.StatusNotFound, gitErrRepoMissing
	case errors.Is(err, core.ErrGitMissing):
		return http.StatusServiceUnavailable, gitErrMissing
	case errors.Is(err, core.ErrTimeout):
		return http.StatusGatewayTimeout, gitErrTimeout
	case errors.Is(err, core.ErrCanceled):
		// 서버가 실패한 것이 아니라 요청이 사라진 것이다 (FR-GIT-217). 500 으로
		// 적으면 진짜 장애와 로그에서 구분되지 않는다.
		return statusClientClosed, gitErrCanceled
	}
	return http.StatusInternalServerError, gitErrFailed
}

func gitError(w http.ResponseWriter, err error) {
	code, name := gitErrorCode(err)
	gitFail(w, code, name, gitTail(err.Error()))
}

// gitTail 은 뒤쪽을 남긴다 — git 의 실패 이유는 stderr 끝에 있다.
func gitTail(msg string) string {
	if len(msg) <= gitMessageMax {
		return msg
	}
	return strings.ToValidUTF8(msg[len(msg)-gitMessageMax:], "")
}

// GET /api/git/repos — 핀 목록과 각 배지 (FR-FLW-2).
//
// **follow 는 없다.** 그 조회는 `+ Add` 가 여는 순간에만 도는 /api/git/repo-at 로
// 옮겼다 — 목록에 실으면 아무도 읽지 않는 값을 위해 3초마다 rev-parse 가 한 번 더
// 돈다 (D-FLW-2).
func (s *GitServer) apiGitRepos(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"pinned": s.gitPinnedEntries(r.Context()),
	})
}

// GET /api/git/repo-at?tool=<toolId> — 그 도구의 cwd 가 속한 리포 (FR-FLW-6).
//
// 화면에 상주하지 않는다. `+ Add` 다이얼로그가 열릴 때 한 번 부르는 것이 전부이며,
// 상주시키면 그것이 곧 follow 의 부활이다 (D-FLW-3).
func (s *GitServer) apiGitRepoAt(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	gitJSON(w, http.StatusOK, s.gitRepoAtEntry(r.Context(), s.gitToolCwd(r)))
}

// gitToolCwd 는 /api/cwd 와 같은 규약이다 — tool 이 비면 서버의 cwd 다.
func (s *GitServer) gitToolCwd(r *http.Request) string {
	if id := r.URL.Query().Get("tool"); id != "" && s.Tools != nil {
		if cwd := s.Tools.Cwd(id); cwd != "" {
			return cwd
		}
	}
	cwd, _ := os.Getwd()
	return cwd
}

// gitRepoAtEntry 는 cwd 가 속한 리포를 확정한다. 저장소가 아니면 path 는 비고
// 사유만 실린다 — **마지막 유효 리포를 유지하지 않는다.**
//
// 배지를 싣지 않는다 — 이 값은 목록이 아니라 `+ Add` 의 기본값이며, 아직 핀되지
// 않은 리포의 변경 개수는 어차피 관측된 적이 없다 (FR-GIT-24).
func (s *GitServer) gitRepoAtEntry(ctx context.Context, cwd string) map[string]any {
	e := map[string]any{"cwd": cwd, "isRepo": false, "path": "", "name": "", "reason": ""}
	root, err := s.Git.RepoRoot(ctx, cwd)
	if err != nil {
		_, name := gitErrorCode(err)
		e["reason"] = name
		return e
	}
	e["isRepo"] = true
	e["path"] = root
	e["name"] = filepath.Base(root)
	return e
}

// gitPinnedEntries 는 핀 목록을 순서 그대로 준다. 저장소가 아니게 된 핀은
// **목록에서 지우지 않고** isRepo:false 로 보인다 — 지울지는 사용자가 정한다.
func (s *GitServer) gitPinnedEntries(ctx context.Context) []map[string]any {
	pins, err := s.gitPinsRead()
	if err != nil {
		return []map[string]any{}
	}
	out := make([]map[string]any, 0, len(pins))
	for _, p := range pins {
		e := map[string]any{"path": p, "name": filepath.Base(p), "isRepo": false, "reason": "", "badge": nil}
		if _, err := s.Git.RepoRoot(ctx, p); err != nil {
			_, name := gitErrorCode(err)
			e["reason"] = name
		} else {
			e["isRepo"] = true
			e["badge"] = s.gitBadge(p)
		}
		out = append(out, e)
	}
	return out
}

// gitBadge 는 Store.Observed 만 읽는다. **이 경로는 git status 를 실행하지 않는다**
// (FR-GIT-24) — 배지 때문에 핀 전부를 폴링하면 비용이 항목 수에 비례한다.
// 관측 이력이 없으면 null 이고, 최신 여부는 observedAtUnixMs 로 판정한다 (O4).
func (s *GitServer) gitBadge(root string) map[string]any {
	obs, ok := s.Git.Observed(root)
	if !ok {
		return nil
	}
	return map[string]any{
		"total":            obs.Status.Total,
		"branch":           obs.Status.Branch,
		"detached":         obs.Status.Detached,
		"observedAtUnixMs": obs.ObservedAtUnixMs,
	}
}

type gitPathReq struct {
	Path string `json:"path"`
}

func gitDecodePath(w http.ResponseWriter, r *http.Request) (string, bool) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "본문을 읽지 못했다: "+err.Error())
		return "", false
	}
	var req gitPathReq
	if err := json.Unmarshal(body, &req); err != nil {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "본문이 JSON 이 아니다: "+err.Error())
		return "", false
	}
	if req.Path == "" {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "path 가 없다")
		return "", false
	}
	return req.Path, true
}

// POST /api/git/repos/pin — 저장소를 재확인한 뒤 그 루트를 핀한다 (FR-GIT-12·62).
func (s *GitServer) apiGitPin(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	path, ok := gitDecodePath(w, r)
	if !ok {
		return
	}
	if !filepath.IsAbs(path) {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "path 는 절대경로여야 한다")
		return
	}
	// 클라이언트가 보낸 경로를 그대로 저장하지 않는다. 하위 디렉터리를 핀하면
	// 같은 리포가 여러 항목으로 갈라진다.
	root, err := s.Git.RepoRoot(r.Context(), path)
	if err != nil {
		gitError(w, err)
		return
	}
	pins, err := s.gitPinsMutate(func(cur []string) []string {
		for _, p := range cur {
			if p == root {
				return cur // 멱등
			}
		}
		// 정렬하지 않는다 — 사용자가 추가한 순서가 목록 순서다.
		return append(cur, root)
	})
	if err != nil {
		gitFail(w, http.StatusInternalServerError, gitErrFailed, gitTail(err.Error()))
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{"root": root, "pinned": pins})
}

// POST /api/git/repos/unpin — 저장된 값과 문자열이 정확히 같은 항목을 지운다.
// rev-parse 를 하지 않는다 — 저장소가 아니게 된 핀도 지울 수 있어야 한다.
func (s *GitServer) apiGitUnpin(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	path, ok := gitDecodePath(w, r)
	if !ok {
		return
	}
	pins, err := s.gitPinsMutate(func(cur []string) []string {
		out := make([]string, 0, len(cur))
		for _, p := range cur {
			if p != path {
				out = append(out, p)
			}
		}
		return out
	})
	if err != nil {
		gitFail(w, http.StatusInternalServerError, gitErrFailed, gitTail(err.Error()))
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{"pinned": pins})
}

// gitReorderReq 는 핀 하나의 이동이다 (FR-GIT-223).
//
// **목록 전체를 받지 않는다.** 전체를 받으면 그 사이에 다른 브라우저 창이 핀을
// 더했을 때 그것을 조용히 지운다. (src, target, before) 는 그때도 뜻이 유지된다.
type gitReorderReq struct {
	Src    string `json:"src"`
	Target string `json:"target"`
	Before bool   `json:"before"`
}

// POST /api/git/repos/reorder — 핀 순서를 바꾼다 (FR-GIT-223).
//
// rev-parse 를 하지 않는다 — unpin 과 같은 이유다. 저장된 문자열 그대로를 옮기는
// 것이고, 저장소가 아니게 된 핀도 자리를 옮길 수 있어야 한다.
func (s *GitServer) apiGitReorder(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "본문을 읽지 못했다: "+err.Error())
		return
	}
	var req gitReorderReq
	if err := json.Unmarshal(body, &req); err != nil {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "본문이 JSON 이 아니다: "+err.Error())
		return
	}
	if req.Src == "" {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "src 가 없다")
		return
	}
	pins, err := s.gitPinsMutate(func(cur []string) []string {
		return gitReorderPins(cur, req.Src, req.Target, req.Before)
	})
	if err != nil {
		gitFail(w, http.StatusInternalServerError, gitErrFailed, gitTail(err.Error()))
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{"pinned": pins})
}

// gitReorderPins 는 src 를 빼서 target 앞/뒤에 넣는다.
//
// src 가 없으면 **아무것도 바꾸지 않는다** — 목록에 없는 것을 옮기려는 요청은
// 이미 화면이 낡았다는 뜻이고, 그때 순서를 흔들면 사용자가 보지 않은 변경이 남는다.
// target 이 없으면 맨 끝이다 — 끌어다 놓은 곳이 사라졌다고 조작을 통째로 잃지 않는다.
func gitReorderPins(cur []string, src, target string, before bool) []string {
	si := -1
	for i, p := range cur {
		if p == src {
			si = i
			break
		}
	}
	if si < 0 || src == target {
		return cur
	}
	out := make([]string, 0, len(cur))
	out = append(out, cur[:si]...)
	out = append(out, cur[si+1:]...)

	ti := -1
	for i, p := range out {
		if p == target {
			ti = i
			break
		}
	}
	if ti < 0 {
		return append(out, src)
	}
	if !before {
		ti++
	}
	out = append(out, "")
	copy(out[ti+1:], out[ti:])
	out[ti] = src
	return out
}

// gitRepoParam 은 repo 인자를 정규 루트로 옮긴다. 클라이언트가 보낸 경로를 그대로
// 신뢰해 파일을 읽지 않는다 (FR-GIT-62).
//
// requested 는 클라이언트가 보낸 값 그대로다 — stale 가드(FR-GIT-16)의 서버측
// 절반이며, 클라이언트가 응답만 보고 자기 요청과 짝을 맞출 수 있어야 한다.
func (s *GitServer) gitRepoParam(w http.ResponseWriter, r *http.Request) (root, requested string, ok bool) {
	requested = r.URL.Query().Get("repo")
	root, ok = s.gitResolveRepo(w, r, requested)
	return root, requested, ok
}

// GET /api/git/status?repo=<abs> — single-flight + TTL 캐시를 거친 관측 (FR-GIT-63).
func (s *GitServer) apiGitStatus(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	obs, cached, err := s.Git.Status(r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"repo":             root,
		"requested":        requested,
		"cached":           cached,
		"observedAtUnixMs": obs.ObservedAtUnixMs,
		"signature":        obs.Signature,
		"status":           obs.Status,
	})
}

// GET /api/git/signature?repo=<abs> — 감지용 경량 시그니처 (FR-GIT-19).
func (s *GitServer) apiGitSignature(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	sig, err := s.Git.Signature(r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"repo":      root,
		"requested": requested,
		"signature": sig,
	})
}

// gitErrNotFound 는 "요청한 것이 없다"다. 리포는 있으나 그 축의 양쪽에 파일이 없는
// 경우이며, 저장소가 아닌 것(not_a_git_repo)과 구분되어야 한다.
const gitErrNotFound = "not_found"

// gitDiffRequested 는 클라이언트가 보낸 값 그대로다 — stale 가드(FR-GIT-54)의
// 서버측 절반이며, 식별자는 (리포, 축, 경로) 다. 해석된 루트가 이 자리를 대신하면
// 클라이언트는 응답과 자기 요청의 짝을 맞출 수 없다.
type gitDiffRequested struct {
	Repo     string `json:"repo"`
	Axis     string `json:"axis"`
	Path     string `json:"path"`
	OrigPath string `json:"origPath"`
	// commit-parent 축만 쓴다 (FR-GIT-138·139). stale 가드의 식별자가
	// (리포, 축, 경로, 리비전) 이므로 리비전도 되돌려준다 (FR-GIT-54·145).
	Oid       string `json:"oid"`
	ParentOid string `json:"parentOid"`
}

type gitDiffResponse struct {
	Requested gitDiffRequested `json:"requested"`
	query.DiffContent
}

// GET /api/git/diff-content?repo=&axis=&path=&origPath= — 한 축의 양쪽 전체 내용
// (FR-GIT-44~48). **unified diff 텍스트를 주지 않는다** — Monaco DiffEditor 가 두
// 모델을 요구하고, diff 계산은 그쪽의 일이다 (FR-GIT-43).
func (s *GitServer) apiGitDiffContent(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	req := gitDiffRequested{
		Repo: requested, Axis: q.Get("axis"), Path: q.Get("path"), OrigPath: q.Get("origPath"),
		Oid: q.Get("oid"), ParentOid: q.Get("parentOid"),
	}
	// 커밋 축은 리비전을 인자로 받으므로 진입점이 다르다 (query.DiffCommit 주석 참고).
	var dc query.DiffContent
	var err error
	if req.Axis == query.AxisCommitParent {
		dc, err = query.DiffCommit(s.Git.Service(), r.Context(), root, req.Oid, req.ParentOid, req.Path, req.OrigPath)
	} else {
		dc, err = query.DiffContentOf(s.Git.Service(), r.Context(), root, req.Axis, req.Path, req.OrigPath)
	}
	if err != nil {
		gitDiffError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, gitDiffResponse{Requested: req, DiffContent: dc})
}

// gitDiffError 는 diff 고유의 거부를 코드로 옮긴 뒤 나머지를 공용 규약에 넘긴다.
// 잘못된 요청을 500 으로 뭉개면 클라이언트는 자기 요청이 틀렸다는 것을 알 수 없다.
func gitDiffError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, query.ErrDiffAxis), errors.Is(err, query.ErrDiffPath), errors.Is(err, query.ErrUnsafeRev):
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
	case errors.Is(err, query.ErrDiffBothAbsent), errors.Is(err, query.ErrRevNotFound):
		gitFail(w, http.StatusNotFound, gitErrNotFound, gitTail(err.Error()))
	default:
		gitError(w, err)
	}
}
