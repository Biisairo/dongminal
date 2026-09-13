package httpapi

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"

	"dongminal/internal/webserver/domain/wsentry"
)

type fsRenameReq struct {
	Root string `json:"root"`
	From string `json:"from"`
	To   string `json:"to"`
	// SrcRoot·DstRoot 는 **루트를 건너는 이동**이다
	// (`12-func-ui.md FUI-11`). 주지 않으면 `Root` 하나가 둘 다를 맡는다 —
	// 기존 호출은 한 글자도 바뀌지 않는다.
	//
	//	이전 동작: `from`·`to` 를 **같은 root** 로 검사했다. 그래서 홈 트리와
	//	          저장소 트리 사이를 **복사는 되고 옮기기는 되지 않았다**
	//	          (`/api/fs/copy` 만 두 루트를 받는다) — 탐색기에 "잘라내기"
	//	          항목이 없던 이유가 그것이다
	//	새  동작: 복사와 **같은 모양**으로 두 루트를 받는다
	//	이유:     경계는 그대로 단단하다 — 둘 다 Editor 목록에 있는지 `fsRoot`
	//	          가 각각 검사한다. 달라지는 것은 "한 루트 안" 이라는 불필요한
	//	          제약뿐이다
	SrcRoot string `json:"srcRoot"`
	DstRoot string `json:"dstRoot"`
}

// POST /api/fs/rename (FR-EDT-109·115 · `FUI-11`).
//
// 이름 변경과 이동은 같은 연산이므로 종단을 나누지 않는다. from 과 to 를 각자의
// 루트 아래로 검사한다. to 가 이미 있으면 거부한다 — os.Rename 은 조용히
// 덮어쓴다 (FR-EDT-86).
//
// **개명하지 않는다.** 복사(`/api/fs/copy`)는 충돌하면 `name copy 2` 로 올라가지만
// (FR-WBR-63) 이동은 그러지 않는다 — "복제" 는 개명이 본질이고 "옮기기" 는
// 아니다. 옮기려던 자리에 다른 것이 있으면 그것은 사용자가 알아야 할 사실이다.
func (s *Server) apiFSRename(w http.ResponseWriter, r *http.Request) {
	// **여기서 `fsOps` 를 잡지 않는다** — `fsRenameNoReplace` 가 잡는다.
	// `sync.Mutex` 는 재진입하지 않으므로 둘 다 잡으면 교착이다.
	var req fsRenameReq
	if !fsDecode(w, r, &req) {
		return
	}
	// 루트를 주지 않으면 `Root` 가 둘 다를 맡는다 (기존 계약).
	srcRoot, dstRoot := req.SrcRoot, req.DstRoot
	if srcRoot == "" {
		srcRoot = req.Root
	}
	if dstRoot == "" {
		dstRoot = req.Root
	}
	_, from, ok := s.fsRootTarget(w, srcRoot, req.From)
	if !ok {
		return
	}
	_, to, ok := s.fsRootTarget(w, dstRoot, req.To)
	if !ok {
		return
	}
	st, err := os.Lstat(from)
	if err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	// 자기 하위로 옮기지 않는다 — 복사와 같은 판정이고 같은 이유다 (FR-EDT-85).
	// 루트를 건너게 되면서 이 검사가 **필요해졌다**: 한 루트 안에서는 클라이언트의
	// 드래그 규칙이 그것을 막고 있었다.
	if err := fsCopyGuardSelf(from, filepath.Dir(to), st); err != nil {
		fsFailErr(w, err)
		return
	}
	if err := s.fsRenameNoReplace(from, to); err != nil {
		fsFailErr(w, err)
		return
	}
	fsOK(w)
}

// fsRenameNoReplace 는 대상이 이미 있으면 덮어쓰지 않고 거절한다.
//
// 종류마다 닫는 수단이 다르다.
//
//   - **일반 파일** — `os.Link` 로 이름을 원자적으로 잡는다. 이미 있으면 그
//     자리에서 EEXIST 이므로 "검사 → 콜" 의 창이 아예 없다. 성공하면 원래
//     이름을 지운다(같은 inode 의 두 이름 중 하나를 없애는 것이라 rename 과
//     결과가 같다). 파일시스템이 다르거나(EXDEV) 하드링크를 못 걸면 아래
//     폴백으로 내려간다.
//   - **디렉터리** — `os.Rename` 이 **이미 막는다.** Go 는 대상이 디렉터리면
//     시스템 콜에 가기 전에 EEXIST 를 돌려준다(`os/file_unix.go` 의 `rename`).
//     대상이 파일이면 ENOTDIR 로 실패한다. 그래서 따로 할 일이 없다.
//   - **심볼릭 링크와 폴백** — `Lstat` 검사 뒤 `os.Rename`. 링크에 `os.Link` 를
//     쓰지 않는 이유는 플랫폼마다 링크를 따라가는지가 갈리기 때문이다 —
//     따라가면 링크가 아니라 그 대상이 옮겨져 뜻이 달라진다.
//
// 폴백에 남는 창은 `fsOps` 가 우리 자신끼리의 경합에 한해 없앤다. 바깥
// 프로세스와의 경합은 남으며, 그것까지 닫으려면 플랫폼별 시스템 콜이 필요하다
// (D-26, §6 비목표의 cross-platform 보류).
func (s *Server) fsRenameNoReplace(from, to string) error {
	s.fsOps.Lock()
	defer s.fsOps.Unlock()

	st, err := os.Lstat(from)
	if err != nil {
		return fsFromOS(err)
	}
	if _, err := os.Lstat(to); err == nil {
		return fsError{fsErrExists, "대상에 같은 이름이 이미 있다"}
	}
	if st.Mode().IsRegular() {
		switch err := os.Link(from, to); {
		case err == nil:
			if rmErr := os.Remove(from); rmErr != nil {
				os.Remove(to) // 되돌리기 — 이름 둘이 남는 것이 최악이다
				return fsFromOS(rmErr)
			}
			return nil
		case os.IsExist(err):
			return fsError{fsErrExists, "대상에 같은 이름이 이미 있다"}
		}
		// EXDEV·EPERM·미지원 — 폴백으로 내려간다.
	}
	if err := os.Rename(from, to); err != nil {
		if os.IsExist(err) {
			return fsError{fsErrExists, "대상에 같은 이름이 이미 있다"}
		}
		return fsFromOS(err)
	}
	return nil
}

type fsDeleteReq struct {
	Root string `json:"root"`
	Path string `json:"path"`
}

// POST /api/fs/delete (FR-EDT-109·114·118). 영구 삭제다 — 휴지통은 없다 (D-7).
func (s *Server) apiFSDelete(w http.ResponseWriter, r *http.Request) {
	var req fsDeleteReq
	if !fsDecode(w, r, &req) {
		return
	}
	root, target, ok := s.fsRootTarget(w, req.Root, req.Path)
	if !ok {
		return
	}
	if err := s.fsDeletable(root, target); err != nil {
		fsFailErr(w, err)
		return
	}
	// 먼저 세고 나서 지운다. 세다가 중간에 멈추면 절반만 지워진 트리가 남는다
	// (FR-EDT-118). 세는 것부터 지우는 것까지가 한 조작이다 — 그 구간만 잠근다.
	s.fsOps.Lock()
	defer s.fsOps.Unlock()
	n, err := fsCountEntries(target, s.limits.fsDelete)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	if n > s.limits.fsDelete {
		fsFail(w, fsErrBadRequest, "삭제 항목 수가 상한을 넘었다")
		return
	}
	if err := os.RemoveAll(target); err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	fsOK(w)
}

// fsDeletable 은 루트 자신·홈·파일시스템 루트를 거부한다 (FR-EDT-114). 셋 다
// 지워지면 되돌릴 수 없는 자리다.
func (s *Server) fsDeletable(root, target string) error {
	if target == root {
		return fsError{fsErrBadRequest, "Editor 루트 자신은 지울 수 없다"}
	}
	if filepath.Dir(target) == target {
		return fsError{fsErrBadRequest, "파일시스템 루트는 지울 수 없다"}
	}
	if s.Entries != nil {
		if home, err := s.Entries.Home(); err == nil && target == home {
			return fsError{fsErrBadRequest, "홈은 지울 수 없다"}
		}
		// **다른** Editor 루트도 지울 수 없다. 중첩된 행(`/a` 와 `/a/b`)이 있을
		// 때 `root=/a` 로 `/a/b` 를 지우면, 사용자가 지운 적 없는 행의 창과
		// 그 아래 전부가 사라진다 (FR-EDT-114).
		if roots, err := s.Entries.Roots(); err == nil {
			for _, r := range roots {
				if wsentry.NormalizePath(r) == target {
					return fsError{fsErrBadRequest, "다른 Editor 루트는 지울 수 없다"}
				}
			}
		}
	}
	return nil
}

// fsCountEntries 는 target 자신을 포함해 재귀로 센다. 상한을 넘으면 max+1 에서
// 멈추고 그 값을 준다 — 호출자는 "넘었다"만 알면 된다.
func fsCountEntries(target string, max int) (int, error) {
	n := 0
	err := filepath.WalkDir(target, func(_ string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		n++
		if n > max {
			return errFSCountOver
		}
		return nil
	})
	if errors.Is(err, errFSCountOver) {
		return n, nil
	}
	if err != nil {
		return 0, fsFromOS(err)
	}
	return n, nil
}
