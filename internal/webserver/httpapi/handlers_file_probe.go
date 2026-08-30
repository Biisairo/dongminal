package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// /api/file/{probe,raw} — 편집기가 "이 파일을 열 수 있는가"를 묻는 자리
// (EDITOR_GIT_UX_SRS 묶음 V).
//
// 이것이 없던 동안 `FileEditor` 는 응답을 무조건 `r.text()` 로 읽어 Monaco 에
// 넣었다. 이진 파일이면 대체 문자로 뒤덮인 화면이 뜨고, 그것을 저장하면
// **원본이 파괴된다** — 알림이 없는 것보다 나쁘다.

const (
	fileKindText   = "text"
	fileKindImage  = "image"
	fileKindBinary = "binary"

	// http.DetectContentType 이 보는 만큼. 그보다 더 읽어도 판정이 달라지지 않는다.
	sniffLen = 512
	// NUL 검사 범위. git 의 판정과 같은 폭이다.
	binaryProbeLen = 8000
)

// probeFile 은 파일의 종류와 MIME 을 판정한다.
//
// **내용이 우선이다** (FR-EVW-2). 확장자는 근거가 아니다 — `.txt` 로 저장된
// PNG 도, 확장자 없는 스크립트도 흔하고, 확장자를 믿으면 전자는 깨진 글자로
// 열리고 후자는 열리지 않는다.
func probeFile(f *os.File) (kind, mime string, err error) {
	head := make([]byte, binaryProbeLen)
	n, rerr := io.ReadFull(f, head)
	if rerr != nil && rerr != io.EOF && rerr != io.ErrUnexpectedEOF {
		return "", "", rerr
	}
	head = head[:n]

	sniff := head
	if len(sniff) > sniffLen {
		sniff = sniff[:sniffLen]
	}
	mime = http.DetectContentType(sniff)

	switch {
	case strings.HasPrefix(mime, "image/"):
		return fileKindImage, mime, nil
	case bytes.IndexByte(head, 0) >= 0:
		return fileKindBinary, mime, nil
	default:
		return fileKindText, mime, nil
	}
}

// openRegularFile 은 절대경로의 **일반 파일**을 연다. 두 종단이 같은 가드를
// 딛는다 — 경로 검사가 갈리면 한쪽만 디렉터리를 읽으려 든다.
func openRegularFile(w http.ResponseWriter, r *http.Request) (*os.File, os.FileInfo, bool) {
	fp := r.URL.Query().Get("path")
	if fp == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return nil, nil, false
	}
	if !filepath.IsAbs(fp) {
		http.Error(w, "path must be absolute", http.StatusBadRequest)
		return nil, nil, false
	}
	f, err := os.Open(fp)
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return nil, nil, false
	}
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		f.Close()
		http.Error(w, "not a file", http.StatusBadRequest)
		return nil, nil, false
	}
	return f, st, true
}

// GET /api/file/probe?path=<abs> — {kind, mime, size} (FR-EVW-1).
func (s *Server) apiFileProbe(w http.ResponseWriter, r *http.Request) {
	f, st, ok := openRegularFile(w, r)
	if !ok {
		return
	}
	defer f.Close()

	kind, mime, err := probeFile(f)
	if err != nil {
		http.Error(w, "cannot read file", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"kind": kind, "mime": mime, "size": st.Size(),
	})
}

// GET /api/file/raw?path=<abs> — 이미지 바이트를 인라인으로 (FR-EVW-5).
//
// **이미지만 내보낸다.** 임의의 파일을 추론된 MIME 으로 같은 출처에서 인라인
// 제공하면 저장형 XSS 가 된다 — HTML 하나면 족하다. 기존 종단 둘은 이 함정을
// 각자 피하고 있다: `/api/file/read` 는 언제나 text/plain, `/api/download` 는
// octet-stream + attachment 다. 새 종단만 예외일 수 없다.
func (s *Server) apiFileRaw(w http.ResponseWriter, r *http.Request) {
	f, st, ok := openRegularFile(w, r)
	if !ok {
		return
	}
	defer f.Close()

	kind, mime, err := probeFile(f)
	if err != nil {
		http.Error(w, "cannot read file", http.StatusForbidden)
		return
	}
	if kind != fileKindImage {
		http.Error(w, "not an image", http.StatusUnsupportedMediaType)
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		http.Error(w, "cannot read file", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", mime)
	// FR-EVW-6: 브라우저가 우리가 정한 형식을 다시 추론하지 않게 한다.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	io.Copy(w, f)
}
