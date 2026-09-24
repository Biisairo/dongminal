package gitapi

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
)

// gitLockRemoveReq 는 남은 index.lock 삭제의 본문이다 (REPO_FIX 01 §7.2).
//
// **경로 필드가 없다** — 지울 경로는 서버가 git 에 물어 정한다. 경로를 받으면 임의
// 파일 삭제 표면이 된다. mtime 은 사용자가 확인한 그 lock 인지의 대조 근거다.
type gitLockRemoveReq struct {
	Repo        string `json:"repo"`
	Confirm     bool   `json:"confirm"`
	MtimeUnixMs int64  `json:"mtimeUnixMs"`
}

// indexLockName 은 이 종단이 지울 수 있는 유일한 파일 이름이다. 다른 `.lock` 은
// 범위 밖이다 (§7.2).
const indexLockName = "index.lock"

// POST /api/git/lock/remove — 남은 index.lock 을 지운다. **파괴적이다** (FR-GIT-89).
//
// 자동 삭제는 없다(사용자 결정) — index_locked 응답을 본 사용자가 확인한 뒤에만
// 온다. 잡이 돌고 있으면 그 잡이 lock 의 주인일 수 있으므로 거절하고, dongminal 의
// 동기 쓰기가 뮤텍스를 쥐고 있어도 기다리지 않고 거절한다 — 기다렸다 지우면 방금
// 끝난 쓰기가 아니라 다음 쓰기의 lock 을 지울 수 있다.
func (s *GitServer) apiGitLockRemove(w http.ResponseWriter, r *http.Request) {
	var req gitLockRemoveReq
	t := s.beginWrite(w, r, &req)
	t.requireConfirm(true, req.Confirm, "index.lock 삭제는 confirm:true 를 요구한다 (FR-GIT-89)")
	t.resolve(req.Repo)
	if t.stop() {
		return
	}
	keys, err := s.gitKeys(t.ctx(), t.root)
	if err != nil {
		t.reject(err)
		return
	}
	x := s.exclusion()
	if id, busy := x.IndexBusy(keys.Top); busy {
		t.rejectWith(http.StatusConflict, gitErrJobBusy, "이 저장소에서 작업("+id+")이 진행 중이다 — 그 작업이 lock 의 주인일 수 있다")
		return
	}
	if id, busy := x.CommonBusy(keys.Common); busy {
		t.rejectWith(http.StatusConflict, gitErrJobBusy, "이 저장소에서 작업("+id+")이 진행 중이다 — 그 작업이 lock 의 주인일 수 있다")
		return
	}
	release, ok := x.TryLockTop(keys.Top)
	if !ok {
		t.rejectWith(http.StatusConflict, apierr.CodeRepoBusy, "이 저장소에서 쓰기가 진행 중이다 — 끝난 뒤 다시 확인하라")
		return
	}
	defer release()

	lockPath, ok := s.gitIndexLockTarget(t)
	if !ok {
		return
	}
	st, err := os.Lstat(lockPath)
	if errors.Is(err, fs.ErrNotExist) {
		t.okPlain(map[string]any{"removed": false, "lockPath": lockPath})
		return
	}
	if err != nil {
		t.rejectWith(http.StatusInternalServerError, gitErrFailed, err.Error())
		return
	}
	if !st.Mode().IsRegular() {
		t.rejectWith(http.StatusBadRequest, apierr.CodeBadRequest, lockPath+" 는 일반 파일이 아니다")
		return
	}
	if st.ModTime().UnixMilli() != req.MtimeUnixMs {
		t.rejectBody(http.StatusConflict, apierr.CodeStaleObservation,
			"확인한 뒤 lock 이 바뀌었다 — 다른 git 이 만든 새 lock 일 수 있다",
			map[string]any{"lock": map[string]any{"path": lockPath, "mtimeUnixMs": st.ModTime().UnixMilli()}})
		return
	}
	if err := os.Remove(lockPath); err != nil {
		t.rejectWith(http.StatusInternalServerError, gitErrFailed, err.Error())
		return
	}
	dmlog.Infof(r.Context(), "[git] 남은 index.lock 삭제: %s (mtime %d)", lockPath, req.MtimeUnixMs)
	s.Git.Invalidate(t.root)
	t.okPlain(map[string]any{"removed": true, "lockPath": lockPath})
}

// gitIndexLockTarget 은 지울 경로를 **다시** 계산하고 검사한다. 이름이 정확히
// index.lock 이고 gitdir 또는 common-dir 바로 아래여야 한다 — rev-parse 가 무엇을
// 주든 그 밖의 파일은 지우지 않는다.
func (s *GitServer) gitIndexLockTarget(t *gitWrite) (string, bool) {
	svc := s.Git.Service()
	lockPath, err := svc.IndexLockPath(t.ctx(), t.root)
	if err != nil {
		t.reject(err)
		return "", false
	}
	gitDir, commonDir, err := svc.GitDirs(t.ctx(), t.root)
	if err != nil {
		t.reject(err)
		return "", false
	}
	parent := core.ExclusionKey(filepath.Dir(lockPath))
	under := parent == core.ExclusionKey(gitDir) || parent == core.ExclusionKey(commonDir)
	if filepath.Base(lockPath) != indexLockName || !under {
		t.rejectWith(http.StatusBadRequest, apierr.CodeBadRequest, lockPath+" 는 이 저장소의 index.lock 이 아니다")
		return "", false
	}
	return lockPath, true
}
