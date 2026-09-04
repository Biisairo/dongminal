package gitapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/wsentry"
)

// /api/git/* — 리포 해석·핀·상태·시그니처 (GIT_SRS §3.8 FR-GIT-60~63).
//
// 모든 실패는 JSON 본문이며 **클라이언트가 종류를 구분할 수 있어야 한다.** 상태
// 코드만으로는 프록시가 만든 500 과 git 실패를 가릴 수 없다.
const (
	gitErrBadRequest = apierr.CodeBadRequest
	gitErrNotRepo    = apierr.CodeNotRepo
	// GIT_REPO_MISSING_SRS FR-RMS-4: 폴더 자체가 사라졌다. 저장소가 아닌 것과
	// 갈라 두어야 클라이언트가 "사라졌습니다" 를 확정으로 말할 수 있다.
	gitErrRepoMissing = apierr.CodeRepoMissing
	gitErrMissing     = apierr.CodeGitMissing
	gitErrTimeout     = apierr.CodeTimeout
	gitErrCanceled    = apierr.CodeCanceled
	gitErrUnavailable = apierr.CodeUnavailable
	gitErrFailed      = apierr.CodeFailed
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

// gitErrorCode 는 실패를 클라이언트가 분기할 수 있는 코드로 옮긴다.
//
// **판정은 여기 없다.** sentinel → (status, code) 는 `apierr.Git` 테이블이
// 소유한다 (DEEPENING_REFACTOR_SRS FR-DPN-2). 이전에는 그 판정이 번역기 13개에
// 복제돼 있었고 복제본은 이미 갈라져 있었다 — `core.ErrRefName` 하나가
// `ref_name_invalid` 와 `bad_request` 두 코드로 나갔다 (FR-DPN-10).
//
// 남는 것은 **미분류 실패의 기본값** 하나다. 등록부가 그것을 대신 정하지 않는
// 이유는 표면마다 다르기 때문이다 (`git_failed` · `io_failed` · sentinel 문자열).
// 사유는 stderr tail 로 남는다 (FR-GIT-96 의 정신).
func gitErrorCode(err error) (int, string) {
	if status, code, ok := apierr.Git.Lookup(err); ok {
		return status, code
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

// GET /api/git/repos[?observe=1] — 핀 목록과 각 배지 (FR-FLW-2, FR-GOB-1).
//
// **follow 는 없다.** 그 조회는 `+ Add` 가 여는 순간에만 도는 /api/git/repo-at 로
// 옮겼다 — 목록에 실으면 아무도 읽지 않는 값을 위해 3초마다 rev-parse 가 한 번 더
// 돈다 (D-FLW-2).
//
// `observe=1` 은 응답을 만들기 전에 **핀 전부를 관측**한다. 그것이 없던 동안
// 배지를 채우는 사람은 활성 리포의 폴링 하나뿐이었고(FR-GIT-22), 그래서 클릭해
// 연 적 없는 핀은 영원히 배지가 없었다. 기본값은 그대로다 — 관측은 Git 탭을
// 보고 있는 동안으로 묶인다 (D-1, FR-GOB-5).
func (s *GitServer) apiGitRepos(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	if r.URL.Query().Get("observe") == "1" {
		s.gitObservePins(r.Context())
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"pinned": s.gitPinnedEntries(r.Context()),
	})
}

// gitObserveMax 는 동시에 도는 관측 수의 상한이다 (FR-GOB-3). 핀이 늘어도 git
// 프로세스가 핀 수만큼 한꺼번에 뜨지 않게 한다.
const gitObserveMax = 4

// gitObservePins 는 핀된 저장소 전부를 관측해 배지의 근거를 새로 만든다
// (FR-GOB-1~4). 관측값을 여기서 읽지 않는다 — 쓰는 곳은 Store 의 캐시이며
// `gitPinnedEntries` 가 그것을 읽는다. 두 단계로 나눈 덕에 응답을 만드는 코드는
// 관측을 하든 안 하든 **같다**.
//
// 실패는 삼킨다. 한 핀이 저장소가 아니게 됐다고 목록 전체가 실패하면, 사용자는
// 고칠 수 있는 한 줄 때문에 나머지를 전부 잃는다 (FR-GOB-4) — 그 핀은
// `gitPinnedEntries` 가 `isRepo:false` 로 답한다.
func (s *GitServer) gitObservePins(ctx context.Context) {
	pins, err := s.gitPinsRead()
	if err != nil || len(pins) == 0 {
		return
	}
	sem := make(chan struct{}, gitObserveMax)
	var wg sync.WaitGroup
	for _, p := range pins {
		// FR-GOB-6: 요청이 사라졌으면 남은 관측을 시작하지 않는다.
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(repo string) {
			defer wg.Done()
			defer func() { <-sem }()
			root, err := s.Git.RepoRoot(ctx, repo)
			if err != nil {
				return
			}
			// FR-GOB-2: Store 를 지난다 — single-flight 와 TTL 이 그대로 걸리므로
			// 브라우저가 여럿이어도 git 실행 횟수가 창 수에 비례하지 않는다.
			s.Git.Status(ctx, root)
		}(p)
	}
	wg.Wait()
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
	cwd, source := s.gitToolCwd(r)
	e := s.gitRepoAtEntry(r.Context(), cwd)
	// FR-ETR-31: 이 값이 **누구의 것인지** 함께 싣는다. 폴백은 유지하되(D-10),
	// 그것이 서버 자신의 cwd 라는 사실이 응답에서 보여야 한다 — 보이지 않으면
	// 호출자는 남의 경로를 사용자의 것으로 채운다 (§2.4).
	e["source"] = source
	gitJSON(w, http.StatusOK, e)
}

// gitToolCwd 는 /api/cwd 와 같은 규약이다 — tool 이 비면 서버의 cwd 다.
// 두 번째 값은 그 근거이며, `/api/cwd` 의 source 와 같은 어휘를 쓴다
// (FR-FTR-7 · FR-ETR-31).
func (s *GitServer) gitToolCwd(r *http.Request) (string, string) {
	if id := r.URL.Query().Get("tool"); id != "" && s.Tools != nil {
		if cwd := s.Tools.Cwd(id); cwd != "" {
			return cwd, gitCwdSourceTool
		}
	}
	cwd, _ := os.Getwd()
	return cwd, gitCwdSourceServer
}

// /api/cwd 가 쓰는 것과 같은 두 값이다. 문자열을 두 곳에 흩뿌리면 한쪽만
// 바뀐다 (FR-FTR-4 와 같은 근거).
const (
	gitCwdSourceTool   = "tool"
	gitCwdSourceServer = "server"
)

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
	// PinAdd 가 멱등이며(정렬하지 않는다 — 사용자가 추가한 순서가 목록 순서다)
	// 같은 경로의 Editor 행을 같은 저장 안에서 함께 만든다 (FR-EDT-31·35).
	// 응답의 root 는 wsentry 가 정규화해 실제로 저장한 값이다 (FR-EDT-24).
	stored, lists, err := s.entries().PinAdd(root)
	if err != nil {
		gitFail(w, http.StatusInternalServerError, gitErrFailed, gitTail(err.Error()))
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{"root": stored, "pinned": lists.Pinned, "editors": lists.Editors})
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
	// 같은 경로의 Editor 행도 함께 사라진다 (FR-EDT-32). 홈은 예외다 —
	// root 행은 연동으로 사라지지 않는다 (FR-EDT-38).
	lists, err := s.entries().PinRemove(path)
	if err != nil {
		gitFail(w, http.StatusInternalServerError, gitErrFailed, gitTail(err.Error()))
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{"pinned": lists.Pinned, "editors": lists.Editors})
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
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	obs, cached, err := s.Git.Status(r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	// GIT_DIR_ENTRY_SRS FR-DIR-5·42 / D-DIR-6: **비교는 정규화를 아는 쪽이 한다.**
	//
	// `requested` 는 클라이언트가 보낸 값 그대로이고 `root` 는 git 이 심볼릭
	// 링크를 푼 값이다 (실측: `/tmp/…` 로 물으면 `/private/tmp/…` 가 돌아온다).
	// 클라이언트가 이 둘을 문자열로 비교하던 동안 macOS 의 `/tmp` 아래 Editor 는
	// 색이 영구히 꺼졌다 (§2.5).
	resolved := wsentry.NormalizePath(requested)
	gitJSON(w, http.StatusOK, map[string]any{
		"repo":      root,
		"requested": requested,
		// 요청 경로가 이 저장소의 **루트**인가. 탐색기가 색의 기준을 정하는 값이다.
		"rootMatch": resolved == root,
		// 루트가 아닐 때 저장소 루트로부터의 접두를 계산할 근거다 (FR-DIR-41).
		// 클라이언트는 심볼릭 링크를 풀 수 없으므로 정규화된 값을 함께 준다.
		"requestedResolved": resolved,
		"cached":            cached,
		"observedAtUnixMs":  obs.ObservedAtUnixMs,
		"signature":         obs.Signature,
		"status":            obs.Status,
	})
}

// GET /api/git/signature?repo=<abs> — 감지용 경량 시그니처 (FR-GIT-19).
func (s *GitServer) apiGitSignature(w http.ResponseWriter, r *http.Request) {
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
const gitErrNotFound = apierr.CodeNotFound

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
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, gitDiffResponse{Requested: req, DiffContent: dc})
}
