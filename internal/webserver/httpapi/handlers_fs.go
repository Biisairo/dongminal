package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"dongminal/internal/webserver/domain/wsentry"
)

// /api/fs/* · /api/editors/* — 탐색기의 조회·조작과 Editor 목록
// (EDITOR_TAB_SRS §3.11 FR-EDT-108~119).
//
// 경로 가드가 /api/file/{read,write} 와 **다르다.** 저쪽은 절대경로인지만 보고
// 그 위의 상한이 없는데, 그것은 사용자가 경로를 이미 알고 지목한 읽기·쓰기이기
// 때문이다. 이쪽은 트리 탐색에서 파생된 경로를 지우고 옮긴다 — 상한이 없으면
// 버그 하나가 홈 밖을 지운다 (D-16, FR-EDT-112).

// 오류 코드는 Git API 와 같은 규약이다 — 상태 코드만으로는 프록시가 만든 500 과
// 조작 실패를 가릴 수 없다 (FR-EDT-117).
const (
	fsErrBadRequest  = "bad_request"
	fsErrNotFound    = "not_found"
	fsErrExists      = "exists"
	fsErrOutsideRoot = "outside_root"
	fsErrPermission  = "permission_denied"
	fsErrIO          = "io_failed"
	// 전송에만 있는 코드다 (FR-FTR-5). fsStatus 의 표에 넣지 않는 것은 조작이
	// 이것을 낼 자리가 없기 때문이다 — 413 은 부르는 쪽이 직접 준다.
	fsErrTooLarge = "too_large"
)

// FS_LIST_MAX·FS_DELETE_MAX (FR-EDT-65·118). const 가 아닌 이유는 테스트가 상한을
// 낮춰 잡기 위해서다 — 실제 값으로 픽스처를 만들면 테스트가 파일시스템을 만든다.
var (
	fsListMax   = 10000
	fsDeleteMax = 10000
)

// fsError 는 코드와 사유를 묶는다. 헬퍼의 실패를 호출자가 그대로 응답으로 옮길 수
// 있어야 코드 판정이 한 자리에 남는다.
type fsError struct {
	code string
	msg  string
}

func (e fsError) Error() string { return e.msg }

func fsStatus(code string) int {
	switch code {
	case fsErrBadRequest:
		return http.StatusBadRequest
	case fsErrNotFound:
		return http.StatusNotFound
	case fsErrExists:
		return http.StatusConflict
	case fsErrOutsideRoot, fsErrPermission:
		return http.StatusForbidden
	}
	return http.StatusInternalServerError
}

func fsJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func fsFail(w http.ResponseWriter, code, msg string) {
	fsJSON(w, fsStatus(code), map[string]any{"code": code, "message": msg})
}

func fsFailErr(w http.ResponseWriter, err error) {
	var fe fsError
	if errors.As(err, &fe) {
		fsFail(w, fe.code, fe.msg)
		return
	}
	fsFail(w, fsErrIO, err.Error())
}

// fsFromOS 는 시스템 콜의 실패를 코드로 옮긴다. 분류되지 않은 실패는 io_failed 다.
func fsFromOS(err error) error {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return fsError{fsErrNotFound, err.Error()}
	case errors.Is(err, fs.ErrExist):
		return fsError{fsErrExists, err.Error()}
	case errors.Is(err, fs.ErrPermission):
		return fsError{fsErrPermission, err.Error()}
	}
	return fsError{fsErrIO, err.Error()}
}

func fsDecode(w http.ResponseWriter, r *http.Request, into any) bool {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		fsFail(w, fsErrBadRequest, "본문을 읽지 못했다: "+err.Error())
		return false
	}
	if err := json.Unmarshal(body, into); err != nil {
		fsFail(w, fsErrBadRequest, "본문이 JSON 이 아니다: "+err.Error())
		return false
	}
	return true
}

// ── 루트 가드 ────────────────────────────────────────

// fsRoot 는 클라이언트가 보낸 root 를 **대조한 뒤에만** 기준으로 쓴다 (FR-EDT-113).
// 서버가 신뢰하지 않는 값이므로 editors.list 또는 홈에 실재하는 루트여야 한다.
func (s *Server) fsRoot(w http.ResponseWriter, raw string) (string, bool) {
	if raw == "" {
		fsFail(w, fsErrBadRequest, "root 가 없다")
		return "", false
	}
	if !filepath.IsAbs(raw) {
		fsFail(w, fsErrBadRequest, "root 는 절대경로여야 한다")
		return "", false
	}
	if s.Entries == nil {
		fsFail(w, fsErrIO, "workspace 를 쓸 수 없다")
		return "", false
	}
	roots, err := s.Entries.Roots()
	if err != nil {
		fsFail(w, fsErrIO, err.Error())
		return "", false
	}
	norm := wsentry.NormalizePath(raw)
	for _, r := range roots {
		if wsentry.NormalizePath(r) == norm {
			return norm, true
		}
	}
	fsFail(w, fsErrOutsideRoot, "root 가 Editor 목록에 없다")
	return "", false
}

// fsResolveExisting 은 **실재하는** 경로를 전부 풀어 루트 아래인지 본다. 조회는
// 그 디렉터리 안으로 들어가므로 디렉터리 자신이 루트 안에 있어야 한다.
func fsResolveExisting(root, p string) (string, error) {
	if !filepath.IsAbs(p) {
		return "", fsError{fsErrBadRequest, "path 는 절대경로여야 한다"}
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(p))
	if err != nil {
		return "", fsResolveErr(err)
	}
	return fsUnderRoot(root, resolved)
}

// fsResolveTarget 은 **이름**을 가리키는 경로를 푼다 — 아직 없을 수도 있으므로
// 부모만 풀고 마지막 조각은 그대로 붙인다. 마지막 조각을 따라가지 않는 덕에
// 링크 자체를 지우거나 옮기는 것이 가능하고(os.RemoveAll·os.Rename 은 링크를
// 따라가지 않는다), 중간 디렉터리가 링크여서 루트를 벗어나는 경우는 걸린다
// (FR-EDT-112).
func fsResolveTarget(root, p string) (string, error) {
	if !filepath.IsAbs(p) {
		return "", fsError{fsErrBadRequest, "path 는 절대경로여야 한다"}
	}
	cleaned := filepath.Clean(p)
	parent, err := filepath.EvalSymlinks(filepath.Dir(cleaned))
	if err != nil {
		return "", fsResolveErr(err)
	}
	return fsUnderRoot(root, filepath.Join(parent, filepath.Base(cleaned)))
}

// fsUnderRoot 은 safeResolve 를 쓰지 않는다. 그쪽의 경계 검사는
// `strings.HasPrefix(rel, "..")` 라 `..b` · `...` 처럼 **점 둘로 시작하는 정상
// 이름**까지 거부한다 (실측: rel="..b" → 거부). 탐색기는 모든 파일·폴더를 보여야
// 하므로(FR-EDT-58) 그 오탐을 물려받을 수 없다. 경계는 경로 **조각**으로 판정한다.
// fsResolveErr 는 경로 해석 실패를 가른다. 전부 not_found 로 접으면 "권한이
// 없어서 못 본 것"과 "없는 것"이 같은 답을 받아, 사용자가 무엇을 고쳐야 할지
// 알 수 없다 (FR-EDT-117).
func fsResolveErr(err error) error {
	if os.IsPermission(err) {
		return fsError{fsErrPermission, err.Error()}
	}
	return fsError{fsErrNotFound, err.Error()}
}

func fsUnderRoot(root, resolved string) (string, error) {
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fsError{fsErrOutsideRoot, "루트 밖의 경로다"}
	}
	return resolved, nil
}

// ── GET /api/fs/list ────────────────────────────────

// fsEntry 는 탐색기 행 하나다. 크기·수정시각은 주지 않는다 — 소비하는 요구가
// 없다 (FR-EDT-108).
type fsEntry struct {
	Name string `json:"name"`
	// Dir 는 os.Lstat 기준이다. 심볼릭 링크는 언제나 false 이며, 대상이
	// 디렉터리인지는 LinkDir 이 알린다 (FR-EDT-60).
	Dir  bool `json:"dir"`
	Link bool `json:"link"`
	// LinkDir 은 아이콘을 가르기 위한 값이다. 대상을 열거나 따라가지는 않는다.
	LinkDir bool `json:"linkDir"`
}

// fsListDir 는 한 겹만 읽는다 (FR-EDT-59). 정렬은 폴더 먼저, 그 다음 파일·링크이며
// 각각 이름 오름차순(대소문자 무시)이다 (FR-EDT-61) — 잘림의 경계가 요청마다
// 달라지지 않으려면 순서가 서버에서 결정돼야 한다.
func fsListDir(dir string, max int) ([]fsEntry, bool, error) {
	des, err := os.ReadDir(dir)
	if err != nil {
		return nil, false, fsFromOS(err)
	}
	out := make([]fsEntry, 0, len(des))
	for _, de := range des {
		e := fsEntry{Name: de.Name(), Dir: de.IsDir(), Link: de.Type()&os.ModeSymlink != 0}
		if e.Link {
			if st, err := os.Stat(filepath.Join(dir, e.Name)); err == nil {
				e.LinkDir = st.IsDir()
			}
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		li, lj := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if li != lj {
			return li < lj
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > max {
		return out[:max], true, nil
	}
	return out, false, nil
}

// GET /api/fs/list?root=<abs>&path=<abs> (FR-EDT-108).
func (s *Server) apiFSList(w http.ResponseWriter, r *http.Request) {
	root, ok := s.fsRoot(w, r.URL.Query().Get("root"))
	if !ok {
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		fsFail(w, fsErrBadRequest, "path 가 없다")
		return
	}
	target, err := fsResolveExisting(root, p)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	st, err := os.Stat(target)
	if err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	if !st.IsDir() {
		fsFail(w, fsErrBadRequest, "디렉터리가 아니다")
		return
	}
	entries, truncated, err := fsListDir(target, fsListMax)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{
		"path": target, "entries": entries, "truncated": truncated,
	})
}

// ── POST /api/fs/{create,rename,delete} ─────────────

type fsCreateReq struct {
	Root string `json:"root"`
	Path string `json:"path"`
	Dir  bool   `json:"dir"`
}

// POST /api/fs/create (FR-EDT-109·115).
//
// **Stat 후 생성하지 않는다.** 검사와 생성 사이의 경합은 os.Mkdir 와
// os.OpenFile(O_EXCL) 의 원자성으로 막는다 — 편집기의 저장과 겹칠 수 있다
// (FR-EDT-93).
func (s *Server) apiFSCreate(w http.ResponseWriter, r *http.Request) {
	fsOpMu.Lock()
	defer fsOpMu.Unlock()
	var req fsCreateReq
	if !fsDecode(w, r, &req) {
		return
	}
	root, ok := s.fsRoot(w, req.Root)
	if !ok {
		return
	}
	target, err := fsResolveTarget(root, req.Path)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	if req.Dir {
		if err := os.Mkdir(target, 0o755); err != nil {
			fsFailErr(w, fsFromOS(err))
			return
		}
		fsOK(w)
		return
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	f.Close()
	fsOK(w)
}

type fsRenameReq struct {
	Root string `json:"root"`
	From string `json:"from"`
	To   string `json:"to"`
}

// POST /api/fs/rename (FR-EDT-109·115).
//
// 이름 변경과 이동은 같은 연산이므로 종단을 나누지 않는다. from 과 to **둘 다**
// 루트 아래로 검사한다. to 가 이미 있으면 거부한다 — os.Rename 은 조용히
// 덮어쓴다 (FR-EDT-86).
func (s *Server) apiFSRename(w http.ResponseWriter, r *http.Request) {
	var req fsRenameReq
	if !fsDecode(w, r, &req) {
		return
	}
	root, ok := s.fsRoot(w, req.Root)
	if !ok {
		return
	}
	from, err := fsResolveTarget(root, req.From)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	to, err := fsResolveTarget(root, req.To)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	if _, err := os.Lstat(from); err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	if err := fsRenameNoReplace(from, to); err != nil {
		fsFailErr(w, err)
		return
	}
	fsOK(w)
}

// fsOpMu 는 파일 조작을 직렬화한다 (FR-EDT-115).
//
// `os.Rename` 은 대상이 있으면 **조용히 덮어쓴다.** Go 에 이식 가능한
// 무덮어쓰기 rename(`RENAME_NOREPLACE`)이 없어 "검사 → 콜" 사이의 창을 시스템
// 콜 하나로 닫을 수 없으므로, **우리 자신끼리의 경합**만이라도 이 자물쇠로
// 없앤다 — 탐색기에서 두 조작을 잇달아 일으키는 것이 실제로 일어나는 경합이다.
//
// 닫지 못하는 것은 **dongminal 밖의 프로세스**가 같은 순간에 그 이름을 만드는
// 경우다. 그것까지 막으려면 플랫폼별 시스템 콜을 들여야 하고, 그것은 §6 비목표의
// cross-platform 보류와 충돌한다 (D-26).
var fsOpMu sync.Mutex

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
// 폴백에 남는 창은 `fsOpMu` 가 우리 자신끼리의 경합에 한해 없앤다. 바깥
// 프로세스와의 경합은 남으며, 그것까지 닫으려면 플랫폼별 시스템 콜이 필요하다
// (D-26, §6 비목표의 cross-platform 보류).
func fsRenameNoReplace(from, to string) error {
	fsOpMu.Lock()
	defer fsOpMu.Unlock()

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
	fsOpMu.Lock()
	defer fsOpMu.Unlock()
	var req fsDeleteReq
	if !fsDecode(w, r, &req) {
		return
	}
	root, ok := s.fsRoot(w, req.Root)
	if !ok {
		return
	}
	target, err := fsResolveTarget(root, req.Path)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	if err := s.fsDeletable(root, target); err != nil {
		fsFailErr(w, err)
		return
	}
	// 먼저 세고 나서 지운다. 세다가 중간에 멈추면 절반만 지워진 트리가 남는다
	// (FR-EDT-118).
	n, err := fsCountEntries(target, fsDeleteMax)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	if n > fsDeleteMax {
		fsFail(w, fsErrBadRequest, "삭제 항목 수가 상한을 넘었다")
		return
	}
	if err := os.RemoveAll(target); err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	fsOK(w)
}

// ── 전송: GET /api/fs/download · POST /api/fs/upload ─
//
// 조회·조작과 같은 루트 가드를 받는다 (FR-EDT-112·113). 터미널 표면의
// `/api/upload`·`/api/download` 와 다른 것은 그 가드뿐이며, 헤더와 상한은 같은
// 함수가 만든다 (FR-FTR-4).

// GET /api/fs/download?root=<abs>&path=<abs> (FR-FTR-12).
func (s *Server) apiFSDownload(w http.ResponseWriter, r *http.Request) {
	root, ok := s.fsRoot(w, r.URL.Query().Get("root"))
	if !ok {
		return
	}
	// 다운로드는 **실재하는** 파일을 읽는다 — 링크는 따라간다. 조작(rename·delete)이
	// 링크 자신을 다루려고 fsResolveTarget 을 쓰는 것과 다른 자리다.
	target, err := fsResolveExisting(root, r.URL.Query().Get("path"))
	if err != nil {
		fsFailErr(w, err)
		return
	}
	serveDownload(w, target, jsonFail(w))
}

// POST /api/fs/upload?root=<abs>&dir=<abs> (FR-FTR-15·16).
//
// 같은 이름이 있으면 **거부한다.** 탐색기의 다른 조작이 전부 그렇다
// (FR-EDT-86·115) — 터미널 업로드의 자동 개명과 다른 것은 의도다 (D-3).
func (s *Server) apiFSUpload(w http.ResponseWriter, r *http.Request) {
	root, ok := s.fsRoot(w, r.URL.Query().Get("root"))
	if !ok {
		return
	}
	dir, err := fsResolveExisting(root, r.URL.Query().Get("dir"))
	if err != nil {
		fsFailErr(w, err)
		return
	}
	outPath, written, ok := uploadInto(w, r, dir, func(d, n string) (string, error) {
		if n == "" || n == "." || n == string(filepath.Separator) {
			return "", fsError{fsErrBadRequest, "파일 이름이 없다"}
		}
		// 이름이 루트 밖을 가리키지 않는지 한 번 더 본다 — d 는 이미 루트 아래이고
		// n 은 Base 를 지났지만, 경계 판정을 이 자리에서 되풀이하는 비용이
		// 잘못 놓인 파일 하나보다 싸다.
		return fsUnderRoot(root, filepath.Join(d, n))
	}, jsonFail(w))
	if !ok {
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{
		"ok": true, "name": filepath.Base(outPath), "size": written, "path": outPath,
	})
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

// errFSCountOver 는 세기를 멈추는 신호다 — 상한을 넘은 것이 확정된 순간 남은
// 트리를 계속 걸을 이유가 없다.
var errFSCountOver = errors.New("항목 수 상한 초과")

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

func fsOK(w http.ResponseWriter) {
	fsJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── /api/editors/* ──────────────────────────────────

// fsEntriesErr 는 wsentry 의 거부를 코드로 옮긴다.
func fsEntriesErr(err error) error {
	switch {
	case errors.Is(err, wsentry.ErrNotAbsolute):
		return fsError{fsErrBadRequest, err.Error()}
	case errors.Is(err, wsentry.ErrNotDir):
		return fsError{fsErrBadRequest, err.Error()}
	case errors.Is(err, wsentry.ErrNotFound):
		return fsError{fsErrNotFound, err.Error()}
	}
	return fsError{fsErrIO, err.Error()}
}

func (s *Server) fsEntries(w http.ResponseWriter) bool {
	if s.Entries == nil {
		fsFail(w, fsErrIO, "workspace 를 쓸 수 없다")
		return false
	}
	return true
}

// GET /api/editors — {home, list}. home 은 list 에 없다 (FR-EDT-29·110).
func (s *Server) apiEditorsGet(w http.ResponseWriter, r *http.Request) {
	if !s.fsEntries(w) {
		return
	}
	home, list, err := s.Entries.List()
	if err != nil {
		fsFailErr(w, fsEntriesErr(err))
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{"home": home, "list": list})
}

type fsPathReq struct {
	Path string `json:"path"`
}

// POST /api/editors/add — 추가는 멱등이고, 응답은 두 목록을 함께 준다
// (FR-EDT-25·39·110).
func (s *Server) apiEditorsAdd(w http.ResponseWriter, r *http.Request) {
	var req fsPathReq
	if !fsDecode(w, r, &req) {
		return
	}
	if !s.fsEntries(w) {
		return
	}
	l, err := s.Entries.EditorAdd(r.Context(), req.Path)
	if err != nil {
		fsFailErr(w, fsEntriesErr(err))
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{"list": l.Editors, "pinned": l.Pinned})
}

// POST /api/editors/remove — 문자열 완전 일치다. 경로를 다시 정규화하지 않는다
// (FR-EDT-26).
func (s *Server) apiEditorsRemove(w http.ResponseWriter, r *http.Request) {
	var req fsPathReq
	if !fsDecode(w, r, &req) {
		return
	}
	if !s.fsEntries(w) {
		return
	}
	if !filepath.IsAbs(req.Path) {
		fsFail(w, fsErrBadRequest, "path 는 절대경로여야 한다")
		return
	}
	l, err := s.Entries.EditorRemove(req.Path)
	if err != nil {
		fsFailErr(w, fsEntriesErr(err))
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{"list": l.Editors, "pinned": l.Pinned})
}

type fsReorderReq struct {
	Src    string `json:"src"`
	Target string `json:"target"`
	Before bool   `json:"before"`
}

// POST /api/editors/reorder — 전체 배열이 아니라 델타다 (FR-EDT-27·110).
func (s *Server) apiEditorsReorder(w http.ResponseWriter, r *http.Request) {
	var req fsReorderReq
	if !fsDecode(w, r, &req) {
		return
	}
	if !s.fsEntries(w) {
		return
	}
	if req.Src == "" {
		fsFail(w, fsErrBadRequest, "src 가 없다")
		return
	}
	// FR-EDT-111: 경로 인자는 절대경로여야 한다. target 은 비어 있을 수 있다 —
	// 끌어다 놓은 곳이 사라지면 맨 끝이다.
	if !filepath.IsAbs(req.Src) || (req.Target != "" && !filepath.IsAbs(req.Target)) {
		fsFail(w, fsErrBadRequest, "src·target 은 절대경로여야 한다")
		return
	}
	list, err := s.Entries.EditorReorder(req.Src, req.Target, req.Before)
	if err != nil {
		fsFailErr(w, fsEntriesErr(err))
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{"list": list})
}
