package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// 파일 종단 — 업로드·다운로드·읽기·쓰기와 그 기준 경로(cwd). 경로를 사용자 입력에서
// 받는 것은 이 파일뿐이므로 safeResolve·uniquePath 도 여기 둔다. 경로 가드를 손볼 때
// 봐야 할 면이 한 파일에 모인다.

func uniquePath(dir, name string) string {
	p := filepath.Join(dir, name)
	if _, err := os.Stat(p); err != nil {
		return p
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 1; ; i++ {
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
		if _, err := os.Stat(p); err != nil {
			return p
		}
	}
}

// safeResolve verifies that userPath resolves within baseDir, preventing
// path-traversal attacks.
func safeResolve(baseDir, userPath string) (string, error) {
	cleaned := filepath.Clean(userPath)
	if !filepath.IsAbs(cleaned) {
		var err error
		cleaned, err = filepath.Abs(cleaned)
		if err != nil {
			return "", err
		}
	}
	// 베이스가 파일시스템 루트면 **제한이 없다는 뜻**이다 — 전송 종단은
	// safeResolve("/", …) 로 부르며, 그 "/" 는 "POSIX 루트 아래" 가 아니라
	// "어디든" 을 적은 것이다 (handlers_fs.go:21 의 대비 설명 참조).
	//
	// 이 갈래가 없으면 Windows 에서 전송이 통째로 막힌다 (FR-WTP-7).
	// filepath.Rel("/", `C:\Users\x`) 는 볼륨이 달라 오류이고, 그 오류가
	// 그대로 403 forbidden 이 된다. 업로드도 다운로드도 한 건도 되지 않는다.
	//
	// POSIX 에서는 동작이 같다 — 루트를 베이스로 한 Rel 은 절대경로에 대해
	// 언제나 성공하고 ".." 로 시작하지 않는다.
	if isFilesystemRoot(baseDir) {
		return cleaned, nil
	}
	rel, err := filepath.Rel(baseDir, cleaned)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("path escapes base directory")
	}
	return cleaned, nil
}

// isFilesystemRoot 은 그 경로가 파일시스템의 꼭대기인지 본다. POSIX 는 "/",
// Windows 는 `\` 와 `C:\` 류다. 호출부가 적는 "/" 는 Windows 에서
// filepath.Clean 을 거치면 `\` 가 되므로 둘 다 받는다.
func isFilesystemRoot(p string) bool {
	c := filepath.Clean(p)
	sep := string(filepath.Separator)
	return c == sep || c == filepath.VolumeName(c)+sep
}

// failFn 은 전송 종단의 실패 형식이다. 두 표면이 다른 것은 이것뿐이라
// (터미널은 text/plain, 탐색기는 JSON 코드) 나머지를 전부 공유할 수 있다.
type failFn func(status int, code, msg string)

// textFail 은 터미널 표면의 형식이다 — 브라우저가 직접 내비게이션하는 종단이라
// JSON 을 읽을 사람이 없다. 본문에 서버 경로를 싣지 않는다 (FR-FTR-3).
func textFail(w http.ResponseWriter) failFn {
	return func(status int, _, msg string) { http.Error(w, msg, status) }
}

// jsonFail 은 탐색기 표면의 형식이다 — /api/fs/* 의 코드 규약을 그대로 쓴다
// (FR-EDT-117).
func jsonFail(w http.ResponseWriter) failFn {
	return func(status int, code, msg string) {
		fsJSON(w, status, map[string]any{"code": code, "message": msg})
	}
}

// uploadMaxBytes 는 업로드 본문의 상한이다 (FR-FTR-5, D-6). const 가 아닌 것은
// 테스트가 상한을 낮춰 잡기 위해서다 — 실제 값으로 픽스처를 만들면 테스트가
// 디스크를 512MiB 쓴다 (fsListMax 와 같은 관례).
var uploadMaxBytes int64 = 512 << 20

// uploadInto 는 multipart 의 `file` 하나를 dir 에 받는다. 두 표면이 공유한다 —
// 상한과 대상 검사가 두 벌이 되면 한쪽만 고쳐진다 (FR-FTR-4 와 같은 근거).
//
// name 을 정하는 것은 호출자다: 터미널 표면은 자동 개명하고(api.md 의 공개 계약),
// 탐색기 표면은 거부한다 (FR-FTR-16, D-3).
func uploadInto(w http.ResponseWriter, r *http.Request, dir string,
	pick func(dir, name string) (string, error), fail failFn) (string, int64, bool) {
	// MaxBytesReader 가 ParseMultipartForm 보다 앞에 선다 — 뒤에 서면 상한을 넘는
	// 본문이 이미 임시 파일로 디스크에 떨어진 뒤다 (FR-FTR-5).
	r.Body = http.MaxBytesReader(w, r.Body, uploadMaxBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) || strings.Contains(err.Error(), "request body too large") {
			fail(http.StatusRequestEntityTooLarge, fsErrTooLarge, "upload too large")
			return "", 0, false
		}
		fail(http.StatusBadRequest, fsErrBadRequest, "no file in request")
		return "", 0, false
	}
	defer file.Close()
	// ParseMultipartForm 은 메모리 상한을 넘은 부분을 임시 파일로 흘린다. 서버는
	// 그것을 자동으로 거두지 않으므로 여기서 거둔다 — 큰 업로드마다 임시 파일이
	// 쌓인다.
	defer func() {
		if r.MultipartForm != nil {
			r.MultipartForm.RemoveAll()
		}
	}()
	// FR-FTR-6: 대상은 실재하는 디렉터리여야 한다. 만들지 않는다 — 업로드는
	// 폴더를 만드는 조작이 아니다.
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		fail(http.StatusBadRequest, fsErrBadRequest, "upload directory not found")
		return "", 0, false
	}
	// header.Filename 은 Go 의 multipart 가 이미 filepath.Base 를 적용한 것이다
	// (mime/multipart: Part.FileName). 그래도 한 번 더 base 를 취한다 — 그 사실이
	// 이 파일 안에서 보이지 않으면 다음 사람이 탈출을 의심한다.
	outPath, err := pick(dir, filepath.Base(header.Filename))
	if err != nil {
		var fe fsError
		if errors.As(err, &fe) {
			fail(fsStatus(fe.code), fe.code, fe.msg)
		} else {
			fail(http.StatusInternalServerError, fsErrIO, "cannot place file")
		}
		return "", 0, false
	}
	// O_EXCL 로 이름을 원자적으로 잡는다 — Stat 후 Create 사이의 창이 없다
	// (fsRenameNoReplace 와 같은 근거).
	out, err := os.OpenFile(outPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		if os.IsExist(err) {
			fail(http.StatusConflict, fsErrExists, "대상에 같은 이름이 이미 있다")
			return "", 0, false
		}
		fail(http.StatusInternalServerError, fsErrIO, "cannot create file")
		return "", 0, false
	}
	defer out.Close()
	written, err := io.Copy(out, file)
	if err != nil {
		os.Remove(outPath) // 반쯤 받은 파일을 남기지 않는다
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			fail(http.StatusRequestEntityTooLarge, fsErrTooLarge, "upload too large")
			return "", 0, false
		}
		fail(http.StatusInternalServerError, fsErrIO, "write failed")
		return "", 0, false
	}
	return outPath, written, true
}

func (s *Server) apiUpload(w http.ResponseWriter, r *http.Request) {
	dir := r.URL.Query().Get("dir")
	if dir == "" {
		dir = "."
	}
	safeDir, err := safeResolve("/", dir)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	// 터미널 표면은 자동 개명한다 — `(1)`·`(2)` 는 api.md 의 공개 계약이다.
	outPath, written, ok := uploadInto(w, r, safeDir, func(d, n string) (string, error) {
		return uniquePath(d, n), nil
	}, textFail(w))
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"name": filepath.Base(outPath), "size": written, "path": outPath})
}

// ── 다운로드 (FILE_TRANSFER_SRS §3.1) ───────────────

// attachmentDisposition 은 이름을 두 벌로 싣는다 (FR-FTR-1).
//
//	attachment; filename="<ASCII 폴백>"; filename*=UTF-8\'\'<퍼센트 인코딩>
//
// 한 벌만 실으면 둘 중 하나가 깨진다 — RFC 6266 의 `filename` 은 토큰이거나
// quoted-string 이라 non-ASCII 를 담을 수 없고, `filename*` 만 두면 그것을 모르는
// 오래된 클라이언트가 이름을 통째로 잃는다.
func attachmentDisposition(name string) string {
	return `attachment; filename="` + asciiFallbackName(name) + `"; filename*=UTF-8''` + rfc5987Escape(name)
}

// asciiFallbackName 은 quoted-string 에 그대로 들어갈 수 있는 이름을 만든다.
// 바꾸는 단위는 **rune** 이다 — 바이트로 세면 한글 한 글자가 밑줄 셋이 된다.
func asciiFallbackName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			b.WriteByte('_')
			continue
		}
		b.WriteRune(r)
	}
	out := b.String()
	if strings.TrimSpace(out) == "" {
		return "download"
	}
	return out
}

// rfc5987Escape 는 RFC 5987 §3.2 의 attr-char 만 남기고 나머지 바이트를 퍼센트
// 인코딩한다. url.PathEscape 를 쓰지 않는 것은 그쪽이 attr-char 가 아닌 문자
// 여럿을 그대로 두기 때문이다.
func rfc5987Escape(name string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
			b.WriteByte(c)
		case strings.IndexByte("!#$&+-.^_`|~", c) >= 0:
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}

// serveDownload 는 파일 하나를 첨부로 흘려보낸다. 두 표면이 공유한다 (FR-FTR-4).
//
// **헤더를 쓰기 전에 판정을 끝낸다.** 디렉터리를 열어 놓고 io.Copy 에서 실패하면
// 이미 200 과 Content-Length 가 나간 뒤라 본문 0바이트의 성공 응답이 된다 —
// 고치기 전의 동작이 그랬다 (§2.1).
//
// 실패는 fail 이 응답한다: 두 표면의 오류 형식이 다르다 (한쪽은 text/plain,
// 다른 쪽은 JSON 코드) — 그것만이 다르다.
func serveDownload(w http.ResponseWriter, fp string, fail failFn) {
	st, err := os.Stat(fp)
	if err != nil {
		if os.IsPermission(err) {
			fail(http.StatusForbidden, fsErrPermission, "cannot read file")
			return
		}
		fail(http.StatusNotFound, fsErrNotFound, "not found")
		return
	}
	if st.IsDir() {
		fail(http.StatusBadRequest, fsErrBadRequest, "not a file")
		return
	}
	f, err := os.Open(fp)
	if err != nil {
		fail(http.StatusForbidden, fsErrPermission, "cannot read file")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Disposition", attachmentDisposition(filepath.Base(fp)))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", st.Size()))
	if _, err := io.Copy(w, f); err != nil {
		// 헤더는 이미 나갔다 — 남길 수 있는 것은 로그뿐이다.
		log.Printf("download %s: %v", filepath.Base(fp), err)
	}
}

func (s *Server) apiDownload(w http.ResponseWriter, r *http.Request) {
	fp := r.URL.Query().Get("path")
	if fp == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(fp) {
		abs, err := filepath.Abs(fp)
		if err != nil {
			http.Error(w, "invalid path", http.StatusBadRequest)
			return
		}
		fp = abs
	}
	if _, err := safeResolve("/", fp); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	serveDownload(w, fp, textFail(w))
}

// apiCwd 는 근거를 함께 싣는다 (FR-FTR-7). 폴백 자체는 없애지 않는다 —
// 상태바·도구·git 이 그것을 딛고 있다 (D-4). 서버의 cwd 를 도구의 것으로 착각해
// 엉뚱한 폴더에 파일을 떨어뜨리는 것은 `source` 를 보는 호출자가 막는다.
func (s *Server) apiCwd(w http.ResponseWriter, r *http.Request) {
	toolID := r.URL.Query().Get("tool")
	var cwd string
	if toolID != "" && s.Tools != nil {
		cwd = s.Tools.Cwd(toolID)
	}
	source := "tool"
	if cwd == "" {
		cwd, _ = os.Getwd()
		source = "server"
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"cwd": cwd, "source": source})
}

func (s *Server) apiFileRead(w http.ResponseWriter, r *http.Request) {
	fp := r.URL.Query().Get("path")
	if fp == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(fp) {
		http.Error(w, "path must be absolute", http.StatusBadRequest)
		return
	}
	if _, err := safeResolve("/", fp); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	f, err := os.Open(fp)
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	stat, _ := f.Stat()
	if stat.IsDir() {
		http.Error(w, "not a file", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.Copy(w, f)
}

type fileWriteReq struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (s *Server) apiFileWrite(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	var req fileWriteReq
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Path == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(req.Path) {
		http.Error(w, "path must be absolute", http.StatusBadRequest)
		return
	}
	if _, err := safeResolve("/", req.Path); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if err := os.WriteFile(req.Path, []byte(req.Content), 0o644); err != nil {
		log.Printf("file write error: %v", err)
		http.Error(w, "write failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}
