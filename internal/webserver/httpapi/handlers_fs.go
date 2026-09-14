package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"dongminal/internal/webserver/httpreq"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/wsentry"
)

// /api/fs/* · /api/editors/* — 탐색기의 조회·조작과 Editor 목록
// (EDITOR_TAB_SRS §3.11 FR-EDT-108~119).
//
// 경로 가드가 /api/file/{read,write} 와 **다르다** — 다만 이제 다른 것은 상한의
// 유무가 아니라 **루트를 고르는 방법**이다 (FILE_API_BOUNDARY_SRS §6).
//
//	이쪽(/api/fs/*)   클라이언트가 보낸 `root` 를 Editor 목록과 대조한다
//	저쪽(/api/file/*)  서버가 루트 목록을 만든다 (Editor·도구 cwd·Notes·홈)
//
// 저쪽에 상한이 없던 시절의 근거는 "사용자가 경로를 이미 알고 지목한 읽기·쓰기"
// 였고, 그것은 대화형 사용자에게만 참이었다. 이쪽은 트리 탐색에서 파생된 경로를
// 지우고 옮긴다 — 상한이 없으면 버그 하나가 홈 밖을 지운다 (D-16, FR-EDT-112).
//
// **대조 함수는 한 벌이다.** `fsResolveExisting`·`fsResolveTarget` 을 저쪽이
// 그대로 쓴다.

// 오류 코드는 Git API 와 같은 규약이다 — 상태 코드만으로는 프록시가 만든 500 과
// 조작 실패를 가릴 수 없다 (FR-EDT-117).
const (
	fsErrBadRequest  = apierr.CodeBadRequest
	fsErrNotFound    = apierr.CodeNotFound
	fsErrExists      = apierr.CodeExists
	fsErrOutsideRoot = apierr.CodeOutsideRoot
	fsErrPermission  = apierr.CodePermission
	fsErrIO          = apierr.CodeIO
	// 전송에만 있는 코드다 (FR-FTR-5). fsStatus 의 표에 넣지 않는 것은 조작이
	// 이것을 낼 자리가 없기 때문이다 — 413 은 부르는 쪽이 직접 준다.
	fsErrTooLarge = apierr.CodeTooLarge
	// FR-ETR-45: 지금은 자리가 없다 — 재시도가 유효하다.
	fsErrBusy = apierr.CodeBusy
)

// fsError 는 코드와 사유를 묶는다. 헬퍼의 실패를 호출자가 그대로 응답으로 옮길 수
// 있어야 코드 판정이 한 자리에 남는다.
type fsError struct {
	code string
	msg  string
}

func (e fsError) Error() string { return e.msg }

// fsStatus 는 코드를 상태로 옮긴다. 표는 `apierr.FSStatus` 가 소유한다
// (FR-DPN-6) — 코드 문자열과 그 상태가 서로 다른 파일에 있으면 한쪽만 바뀐다.
func fsStatus(code string) int { return apierr.FSStatus(code) }

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

// fsFromOS 는 시스템 콜의 실패를 코드로 옮긴다. 판정은 `apierr.FS` 가 소유한다
// (FR-DPN-6). 분류되지 않은 실패는 io_failed 다 — 그 기본값은 이 표면의 것이므로
// 등록부가 대신 정하지 않는다.
func fsFromOS(err error) error {
	if _, code, ok := apierr.FS.Lookup(err); ok {
		return fsError{code, err.Error()}
	}
	return fsError{fsErrIO, err.Error()}
}

func fsDecode(w http.ResponseWriter, r *http.Request, into any) bool {
	body, err := httpreq.Read(w, r, 0)
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
//
// FS_LIST_PAGING_SRS FR-FSP-1·2·4: `offset` 이 뜻을 갖는 것은 **순서가 서버의
// 것이기 때문**이다. 잘림의 경계가 요청마다 달라지지 않으므로 같은 `offset` 은
// 같은 자리를 가리킨다. `total` 은 정렬 전 전체 수이며 `os.ReadDir` 이 이미
// 전부 읽으므로 세는 비용이 없다.
func fsListDir(dir string, offset, max int) ([]fsEntry, int, bool, error) {
	des, err := os.ReadDir(dir)
	if err != nil {
		return nil, 0, false, fsFromOS(err)
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
	total := len(out)
	// FR-FSP-3: 넘어선 `offset` 은 오류가 아니라 **빈 쪽**이다. 폴더가 줄어든
	// 뒤의 요청이 그 꼴이고, 그때 사용자가 볼 것은 오류가 아니라 "더는 없다" 다.
	if offset >= total {
		return []fsEntry{}, total, false, nil
	}
	out = out[offset:]
	if len(out) > max {
		return out[:max], total, true, nil
	}
	return out, total, false, nil
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
	// FR-FSP-1: 음수·정수 아님은 `0` 으로 떨어진다 — 손으로 고친 URL 하나가
	// 오류 화면이 되지 않아야 한다 (`pollValue` 와 같은 규약).
	offset := 0
	if v, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && v > 0 {
		offset = v
	}
	entries, total, truncated, err := fsListDir(target, offset, s.limits.fsList)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{
		"path": target, "entries": entries, "truncated": truncated,
		// FR-FSP-2: 어디부터 받았고 전부가 몇인가. 잘림 행이 "보이는 수 / 전체 수"
		// 를 말하려면 둘 다 필요하다.
		"offset": offset, "total": total,
		// NOTES_LIVE_EXPLORER_SRS FR-FSL-10: 이 목록과 **같은 관측**의 스탬프.
		// 폴링에서만 채우면 목록을 읽은 뒤 스탬프를 처음 보기까지의 변경이
		// "처음 본 겹" 으로 삼켜져 영영 재조회되지 않는다. 위에서 이미 Stat
		// 했으므로 값을 싣는 비용이 없다.
		"stamp": fsStampOf(st),
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
// fsRootTarget 은 요청의 root 와 경로를 실제 자리 하나로 옮긴다
// (DRIFT_RECLAIM_SRS FR-DRC-11).
//
// 쓰기 세 종단(create·rename·delete)이 이 두 단계를 각각 적고 있었다. 순서가
// 요점이다 — **root 를 먼저 확정한 뒤에만 경로를 푼다.** 뒤집으면 클라이언트가
// 보낸 경로가 root 밖을 가리키는지 판정할 기준이 아직 없다.
func (s *Server) fsRootTarget(w http.ResponseWriter, reqRoot, reqPath string) (root, target string, ok bool) {
	root, ok = s.fsRoot(w, reqRoot)
	if !ok {
		return "", "", false
	}
	target, ok = fsTargetIn(w, root, reqPath)
	if !ok {
		return "", "", false
	}
	return root, target, true
}

// fsTargetIn 은 이미 확정된 root 아래의 또 다른 경로다 (rename 의 `to`).
func fsTargetIn(w http.ResponseWriter, root, p string) (string, bool) {
	target, err := fsResolveTarget(root, p)
	if err != nil {
		fsFailErr(w, err)
		return "", false
	}
	return target, true
}

// os.OpenFile(O_EXCL) 의 원자성으로 막는다 — 편집기의 저장과 겹칠 수 있다
// (FR-EDT-93).
func (s *Server) apiFSCreate(w http.ResponseWriter, r *http.Request) {
	var req fsCreateReq
	if !fsDecode(w, r, &req) {
		return
	}
	_, target, ok := s.fsRootTarget(w, req.Root, req.Path)
	if !ok {
		return
	}
	if req.Dir {
		// **메모 루트의 거부는 폐기됐다** (M9_SRS FR-M9-23 / D-M9-15, 사용자 결정
		// 2026-09-14). 여기 `s.Entries.Notes()` 와 견주어 `fsErrBadRequest` 를
		// 내던 자리가 있었다 — `EXPLORER_ROOT_KEYS_SRS` FR-EXR-33. 메모장은 다른
		// 루트와 같다.
		s.fsOps.Lock()
		err := os.Mkdir(target, 0o755)
		s.fsOps.Unlock()
		if err != nil {
			fsFailErr(w, fsFromOS(err))
			return
		}
		fsOK(w)
		return
	}
	s.fsOps.Lock()
	f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	s.fsOps.Unlock()
	if err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	f.Close()
	fsOK(w)
}

// `Server.fsOps` 는 파일 조작을 직렬화한다 (FR-EDT-115).
//
// `os.Rename` 은 대상이 있으면 **조용히 덮어쓴다.** Go 에 이식 가능한
// 무덮어쓰기 rename(`RENAME_NOREPLACE`)이 없어 "검사 → 콜" 사이의 창을 시스템
// 콜 하나로 닫을 수 없으므로, **우리 자신끼리의 경합**만이라도 이 자물쇠로
// 없앤다 — 탐색기에서 두 조작을 잇달아 일으키는 것이 실제로 일어나는 경합이다.
//
// 닫지 못하는 것은 **dongminal 밖의 프로세스**가 같은 순간에 그 이름을 만드는
// 경우다. 그것까지 막으려면 플랫폼별 시스템 콜을 들여야 하고, 그것은 §6 비목표의
// cross-platform 보류와 충돌한다 (D-26).

// ── 전송: GET /api/fs/download · POST /api/fs/upload ─
//
// 조회·조작과 같은 루트 가드를 받는다 (FR-EDT-112·113). 터미널 표면의
// `/api/upload`·`/api/download` 와 다른 것은 그 가드뿐이며, 헤더와 상한은 같은
// 함수가 만든다 (FR-FTR-4).

// errFSCountOver 는 세기를 멈추는 신호다 — 상한을 넘은 것이 확정된 순간 남은
// 트리를 계속 걸을 이유가 없다.
var errFSCountOver = errors.New("항목 수 상한 초과")

func fsOK(w http.ResponseWriter) {
	fsJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
