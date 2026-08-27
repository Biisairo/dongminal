package gitapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"

	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
)

// /api/git/{ignore,file-head} — 파일 대상 동작
// (GIT_ACTIONS_SRS §3.6 FR-GIT-273·274, 검증 V200·V201).
//
// 둘 다 **git 을 실행하지 않는 쪽에 가깝다**:
//
//   - ignore 는 파일 쓰기다 (FR-GIT-273). ExecWrite 를 지나지 않으며, 지나갈 argv
//     자체가 없다. 그 대신 경로를 저장소 안으로 가두는 것을 서버가 한다 —
//     클라이언트만 막으면 API 직접 호출이 그대로 우회한다.
//   - file-head 는 읽기다 (FR-GIT-274). **새 조회를 만들지 않는다** — diff 의
//     original 쪽이 이미 `HEAD:<path>` 를 `cat-file` 로 읽고 있다.

// 이 표면 고유의 거부 코드. 상태 코드만으로는 무엇이 왜 막혔는지 구분할 수 없다.
const (
	gitErrIgnorePath = "unsafe_ignore_path"
	// gitErrNotText 는 HEAD 의 내용이 편집기로 열 수 있는 텍스트가 아니라는 것이다
	// (바이너리·LFS 포인터·상한 초과). 500 으로 뭉개면 클라이언트가 사유를 보일 수
	// 없다.
	gitErrNotText = "not_text"
)

// gitHeadTempDir 는 HEAD 의 내용을 편집기 탭이 열 수 있는 파일로 놓는 자리다.
//
// **워킹 트리에는 쓰지 않는다.** HEAD 의 내용을 저장소 안에 쓰면 그것이 곧
// 사용자의 파일을 덮는 것이 되어 FR-GIT-274 가 "본다"가 아니라 "되돌린다"가 된다.
const gitHeadTempDir = "dongminal-git-head"

const (
	gitHeadDirPerm      = 0o700
	gitHeadReadOnlyPerm = 0o444
	gitHeadFilePerm     = 0o600
	gitHeadHashLen      = 12
)

// gitIgnoreReq 는 `.gitignore` 추가의 본문이다 (FR-GIT-273).
type gitIgnoreReq struct {
	Repo  string   `json:"repo"`
	Paths []string `json:"paths"`
}

// gitHeadFileRequested 의 식별자는 (리포, 경로) 다 — stale 가드의 서버측 절반이며,
// 경로가 빠지면 뒤늦게 온 다른 파일의 응답을 자기 것으로 읽는다.
type gitHeadFileRequested struct {
	Repo string `json:"repo"`
	Path string `json:"path"`
}

type gitHeadFileResponse struct {
	Requested gitHeadFileRequested `json:"requested"`
	Repo      string               `json:"repo"`
	Path      string               `json:"path"`
	Kind      string               `json:"kind"`
	Size      int64                `json:"size"`
	// OpenPath 는 편집기 탭이 열 절대경로다. Kind=="text" 일 때만 채운다.
	OpenPath string `json:"openPath,omitempty"`
}

// POST /api/git/ignore — 경로를 저장소 루트의 `.gitignore` 에 덧붙인다
// (FR-GIT-273, 검증 V200).
//
// 쓰기 규약을 그대로 쓴다 (FR-GIT-250 ③): `gitResolveRepo` 로 루트를 재확인하고,
// `gitStatusBefore` → `gitApply` → `gitWriteOK` 를 지난다. git 을 돌리지 않아도
// **status 는 바뀐다** — 무시된 파일이 untracked 목록에서 사라지므로, 실행 후
// status 를 함께 주지 않으면 화면이 폴링 주기만큼 거짓말을 한다 (FR-GIT-71).
func (s *GitServer) apiGitIgnoreAdd(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitIgnoreReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	// 경로 판정은 쓰기 **전에** 끝낸다 — 순수 함수가 이미 답한다 (FR-GIT-250 ①).
	// 하나라도 이탈이면 아무것도 쓰지 않는다.
	for _, p := range req.Paths {
		if _, err := write.IgnorePattern(root, p); err != nil {
			gitFail(w, http.StatusBadRequest, gitErrIgnorePath, gitTail(err.Error()))
			return
		}
	}
	before, ok := s.gitStatusBefore(w, r, root)
	if !ok {
		return
	}
	var res write.IgnoreResult
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(context.Context) error {
		var err error
		res, err = write.IgnoreAdd(root, req.Paths)
		return err
	})
	if !ok {
		return
	}
	// added 와 skipped 를 나눠 싣는다 — 뭉개면 화면이 "추가했습니다" 라고 말한 것이
	// 실제로는 아무 일도 아니었을 수 있다.
	gitWriteOK(w, req.Repo, root, after, map[string]any{
		"file": res.File, "added": res.Added, "skipped": res.Skipped,
	})
}

// GET /api/git/file-head?repo=&path= — `HEAD:<path>` 의 내용을 편집기가 열 수 있는
// 파일로 놓고 그 경로를 준다 (FR-GIT-274, 검증 V201).
//
// **조회를 새로 만들지 않는다.** `worktree-head` 축의 original 쪽이 곧 `HEAD:<path>`
// 이고, 그것은 이미 `cat-file` 로 읽힌다 — 판정(바이너리·LFS·상한)까지 diff 의
// 규약을 그대로 물려받는다.
//
// 워킹 트리의 파일을 그대로 열면 FR-GIT-274 가 뜻을 잃으므로, HEAD 의 내용을
// **저장소 밖**에 놓고 그것을 연다. 저장소 안에 쓰면 그 순간 사용자의 파일을
// 덮는 것이 된다.
func (s *GitServer) apiGitFileHead(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	p := r.URL.Query().Get("path")
	req := gitHeadFileRequested{Repo: requested, Path: p}

	dc, err := query.DiffContentOf(s.Git.Service(), r.Context(), root, query.AxisWorktreeHead, p, "")
	if err != nil {
		gitDiffError(w, err)
		return
	}
	side := dc.Original
	res := gitHeadFileResponse{Requested: req, Repo: root, Path: dc.Path, Kind: side.Kind, Size: side.Size}
	if side.Kind != query.DiffKindText {
		// 사유를 코드로 준다 — 빈 편집기를 열면 사용자는 파일이 비었다고 읽는다.
		gitJSON(w, http.StatusConflict, map[string]any{
			"error": gitErrNotText, "message": gitHeadNotTextMessage(side.Kind),
			"requested": req, "repo": root, "path": dc.Path, "kind": side.Kind, "size": side.Size,
		})
		return
	}
	abs, err := gitWriteHeadTemp(root, dc.Path, side.Content)
	if err != nil {
		gitError(w, err)
		return
	}
	res.OpenPath = abs
	gitJSON(w, http.StatusOK, res)
}

// gitHeadNotTextMessage 는 왜 열 수 없는지다. diff 뷰어가 같은 사유로 본문 대신
// 안내를 보이는 것과 같은 판정이다.
func gitHeadNotTextMessage(kind string) string {
	switch kind {
	case query.DiffKindAbsent:
		return "HEAD 에 그 경로가 없다"
	case query.DiffKindBinary:
		return "바이너리 파일이다"
	case query.DiffKindLFS:
		return "LFS 포인터다 — 내용은 원격에 있다"
	case query.DiffKindTooLarge:
		return "상한을 넘는 파일이다"
	}
	return "텍스트가 아니다"
}

// gitWriteHeadTemp 는 HEAD 의 내용을 저장소 밖의 정해진 자리에 놓는다.
//
// 경로가 **결정적이다** — 같은 파일을 다시 열면 같은 경로가 되고, 편집기가 이미
// 열린 탭을 찾아 준다 (`_findEditorTab`). 리포마다 자리를 나누는 것은 이름이 같은
// 파일이 서로를 덮지 않게 하기 위한 것이다.
//
// rel 은 `query.DiffContentOf` 가 이미 검증한 저장소 상대경로다 — 부모 참조가
// 없으므로 Join 이 임시 디렉터리 밖으로 나가지 않는다.
func gitWriteHeadTemp(root, rel, content string) (string, error) {
	sum := sha256.Sum256([]byte(root))
	base := filepath.Join(os.TempDir(), gitHeadTempDir, hex.EncodeToString(sum[:])[:gitHeadHashLen])
	abs := filepath.Join(base, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), gitHeadDirPerm); err != nil {
		return "", err
	}
	// 이미 있으면 쓰기 권한을 먼저 되돌린다 — 아래에서 읽기 전용으로 두므로 두 번째
	// 열기가 권한 없음으로 실패한다.
	if err := os.Chmod(abs, gitHeadFilePerm); err != nil && !os.IsNotExist(err) {
		return "", err
	}
	if err := os.WriteFile(abs, []byte(content), gitHeadFilePerm); err != nil {
		return "", err
	}
	// **읽기 전용으로 둔다.** 이 파일은 저장소 밖의 사본이므로, 여기서 저장하면
	// 사용자의 편집이 임시 파일로 조용히 사라진다. 권한으로 막으면 저장이 **실패로
	// 보이고**, 사용자는 이것이 읽는 자리임을 그 자리에서 안다 (FR-GIT-274).
	if err := os.Chmod(abs, gitHeadReadOnlyPerm); err != nil {
		return "", err
	}
	return abs, nil
}
