package httpapi

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// POST /api/fs/copy — 탐색기의 복사·복제 (WORKBENCH_REVIEW_SRS 묶음 P,
// FR-WBR-60~68).
//
// **서버가 자기 파일시스템 안에서 복사한다.** 원본도 대상도 여기 있고 브라우저는
// 경로만 나르므로, 브라우저가 어느 기기에 있든 결과가 같다 (NFR-WBR-12).
//
// 기존 조작과 다른 것이 둘이다.
//
//   - **루트를 둘 받는다** (FR-WBR-61). `rename` 은 `from`·`to` 를 같은 root 로
//     검사해 홈 트리와 저장소 트리 사이를 오갈 길이 없다. 복사만 그 길을 연다 —
//     둘 다 Editor 목록에 있는지 검사하므로 경계는 그대로 단단하다.
//   - **충돌하면 거부가 아니라 개명한다** (FR-WBR-63, D-WBR-15). "복제" 는 개명이
//     본질이라 거부하면 그 항목이 아무 일도 못 한다. FR-EDT-86 이 금하는 둘 중
//     **덮어쓰기는 그대로 금지다** — 이름을 잡으며 올라갈 뿐 있는 것을 건드리지
//     않는다.

type fsCopyReq struct {
	SrcRoot string `json:"srcRoot"`
	Src     string `json:"src"`
	DstRoot string `json:"dstRoot"`
	DstDir  string `json:"dstDir"`
}

// fsCopyNameMax 는 `name copy N` 을 올려 볼 횟수의 상한이다. 상한이 **있다**는
// 것이 값보다 중요하다 — 없으면 이름이 꽉 찬 폴더에서 요청 하나가 영원히 돈다.
const fsCopyNameMax = 1000

// errFSCopySkip 은 복사할 수 없는 종류(fifo·소켓·장치)다. 트리 안에서는 건너뛰고
// 맨 위에서는 거부한다 — 폴더 하나 때문에 나머지를 다 버릴 이유가 없다.
var errFSCopySkip = errors.New("fs: 복사할 수 없는 종류다")

func (s *Server) apiFSCopy(w http.ResponseWriter, r *http.Request) {
	fsOpMu.Lock()
	defer fsOpMu.Unlock()
	var req fsCopyReq
	if !fsDecode(w, r, &req) {
		return
	}
	srcRoot, ok := s.fsRoot(w, req.SrcRoot)
	if !ok {
		return
	}
	dstRoot, ok := s.fsRoot(w, req.DstRoot)
	if !ok {
		return
	}
	// 원본은 **링크를 풀지 않고** 잡는다 — 링크 자체를 복사하기 때문이다
	// (FR-WBR-65). `fsResolveTarget` 은 부모만 풀고 마지막 조각을 남긴다.
	src, err := fsResolveTarget(srcRoot, req.Src)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	st, err := os.Lstat(src)
	if err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	// 대상은 **실재하는 디렉터리**다. 최종 이름은 서버가 정하므로(FR-WBR-62)
	// 호출자가 줄 수 있는 것은 자리뿐이다.
	dstDir, err := fsResolveExisting(dstRoot, req.DstDir)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	if di, err := os.Stat(dstDir); err != nil || !di.IsDir() {
		fsFail(w, fsErrBadRequest, "대상이 디렉터리가 아니다")
		return
	}
	if err := fsCopyGuardSelf(src, dstDir, st); err != nil {
		fsFailErr(w, err)
		return
	}
	// **먼저 세고** 나서 복사한다 (FR-WBR-66) — 세다 멈추면 절반만 복사된 트리가
	// 남는다. 삭제와 같은 규약이다 (FR-EDT-118).
	n, err := fsCountEntries(src, fsCopyMax)
	if err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	if n > fsCopyMax {
		fsFail(w, fsErrBadRequest, "복사 항목 수가 상한을 넘었다")
		return
	}

	target, err := fsCopyCreate(dstDir, filepath.Base(src), src, st)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	if st.IsDir() {
		if err := fsCopyDirInto(src, target, st); err != nil {
			// FR-WBR-67: 만들다 만 것을 거둔다. 이 이름은 **서버가 방금 만든
			// 것**이므로 지워도 사용자의 것을 잃지 않는다.
			os.RemoveAll(target)
			fsFailErr(w, fsFromOS(err))
			return
		}
	}
	fsJSON(w, http.StatusOK, map[string]any{"ok": true, "path": target})
}

// fsCopyGuardSelf 는 디렉터리를 자기 자신이나 자기 하위로 복사하는 것을 막는다
// (FR-WBR-64).
//
// **서버가 막아야 하는 자리다.** 이동(FR-EDT-85)은 클라이언트만 막고 있어도
// 최악이 트리를 잃는 것이지만, 복사는 막지 않으면 자기가 만든 것을 다시 복사하며
// **무한 재귀**로 디스크를 채운다.
//
// 링크는 대상이 아니다 — 링크 자체를 복사하므로 재귀가 없다.
func fsCopyGuardSelf(src, dstDir string, st os.FileInfo) error {
	if !st.IsDir() {
		return nil
	}
	real, err := filepath.EvalSymlinks(src)
	if err != nil {
		return fsResolveErr(err)
	}
	rel, err := filepath.Rel(real, dstDir)
	if err != nil {
		// 볼륨이 다르면 하위일 수 없다.
		return nil
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil
	}
	return fsError{fsErrBadRequest, "자기 자신이나 자기 하위로는 복사할 수 없다"}
}

// fsCopyCreate 는 빈 이름을 찾아 **그 자리에서 만든다** (FR-WBR-63).
//
// 검사하고 만들지 않는다 — `Mkdir`·`O_EXCL`·`Symlink` 가 전부 이미 있으면
// EEXIST 로 실패하므로 "검사 → 콜" 사이의 창이 아예 없다 (`apiFSCreate` 와 같은
// 판단). 이름을 서버가 정하는 이유가 이것이다.
func fsCopyCreate(dir, base, src string, st os.FileInfo) (string, error) {
	for i := 0; i <= fsCopyNameMax; i++ {
		name := base
		if i > 0 {
			name = fsCopyName(base, i)
		}
		p := filepath.Join(dir, name)
		switch err := fsCopyNode(src, p, st); {
		case err == nil:
			return p, nil
		case errors.Is(err, errFSCopySkip):
			return "", fsError{fsErrBadRequest, "복사할 수 없는 종류다"}
		case os.IsExist(err):
			continue
		default:
			return "", fsFromOS(err)
		}
	}
	return "", fsError{fsErrExists, "쓸 수 있는 이름을 찾지 못했다"}
}

// fsCopyName 은 `name` → `name copy` → `name copy 2` … 를 만든다 (FR-WBR-63).
//
// 확장자는 **마지막 점 뒤**이고 그 앞에 넣는다. 다만 **점으로 시작하는 이름은
// 확장자가 없는 것으로 본다** — `filepath.Ext(".gitignore")` 는 `".gitignore"` 를
// 돌려주므로(실측) 그대로 믿으면 `" copy.gitignore"` 라는, 공백으로 시작하는
// 이름이 된다.
func fsCopyName(base string, n int) string {
	stem, ext := base, ""
	if i := strings.LastIndexByte(base, '.'); i > 0 {
		stem, ext = base[:i], base[i:]
	}
	if n == 1 {
		return stem + " copy" + ext
	}
	return fmt.Sprintf("%s copy %d%s", stem, n, ext)
}

// fsCopyNode 는 항목 **하나**를 만든다. 셋 다 대상이 이미 있으면 EEXIST 다 —
// 그래서 이름 찾기가 원자적일 수 있다.
//
// 링크는 **따라가지 않고 링크 자체**를 만든다 (FR-WBR-65) — 따라가면 순환과 뿌리
// 이탈이 함께 열린다 (FR-EDT-85 의 근거).
func fsCopyNode(src, dst string, st os.FileInfo) error {
	switch {
	case st.Mode()&os.ModeSymlink != 0:
		t, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(t, dst)
	case st.IsDir():
		// 쓸 수 있어야 안을 채운다 — 원본의 모드는 다 채운 뒤에 입힌다.
		return os.Mkdir(dst, st.Mode().Perm()|0o700)
	case st.Mode().IsRegular():
		return fsCopyFile(src, dst, st)
	default:
		return errFSCopySkip
	}
}

// fsCopyFile 은 내용과 **모드**를 함께 옮긴다 (FR-WBR-68). 실행 비트가 사라지면
// 복사한 스크립트가 돌지 않는다. 만들기와 `Chmod` 를 나누는 것은 umask 가
// `OpenFile` 의 perm 을 깎기 때문이다.
func fsCopyFile(src, dst string, st os.FileInfo) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, st.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chmod(dst, st.Mode().Perm())
}

// fsCopyDirInto 는 이미 만들어진 `dst` 를 채운다.
//
// 안쪽에서는 이름 찾기가 없다 — 방금 만든 트리라 EEXIST 가 날 수 없고, 나면 그것은
// 우리가 모르는 일이 벌어진 것이므로 감추지 않고 실패한다.
//
// 모드는 **다 채운 뒤에** 입힌다. 읽기 전용 폴더를 먼저 만들면 그 안에 쓰지 못한다.
func fsCopyDirInto(src, dst string, st os.FileInfo) error {
	ents, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range ents {
		ci, err := e.Info()
		if err != nil {
			return err
		}
		s2, d2 := filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())
		if err := fsCopyNode(s2, d2, ci); err != nil {
			if errors.Is(err, errFSCopySkip) {
				continue
			}
			return err
		}
		if ci.IsDir() {
			if err := fsCopyDirInto(s2, d2, ci); err != nil {
				return err
			}
		}
	}
	return os.Chmod(dst, st.Mode().Perm())
}
