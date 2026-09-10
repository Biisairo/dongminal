package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
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
func probeFile(f *os.File) (kind, mime string, head []byte, err error) {
	head = make([]byte, binaryProbeLen)
	n, rerr := io.ReadFull(f, head)
	if rerr != nil && rerr != io.EOF && rerr != io.ErrUnexpectedEOF {
		return "", "", nil, rerr
	}
	head = head[:n]

	sniff := head
	if len(sniff) > sniffLen {
		sniff = sniff[:sniffLen]
	}
	mime = http.DetectContentType(sniff)

	switch {
	case strings.HasPrefix(mime, "image/"):
		return fileKindImage, mime, head, nil
	case bytes.IndexByte(head, 0) >= 0:
		return fileKindBinary, mime, head, nil
	default:
		// **SVG 는 여기 남는다** — 그것이 편집할 수 있는 문서이기 때문이다
		// (DOC_RENDER_VIEW_SRS FR-DRV-14). 그리는 일은 렌더 뷰의 것이고, 이
		// 판정이 이미지로 갈리면 그 파일을 고칠 길이 사라진다.
		return fileKindText, mime, head, nil
	}
}

// looksLikeSVG 는 **내용으로** SVG 를 판정한다 (FR-DRV-24 ①).
//
// 확장자를 믿지 않는 근거는 FR-EVW-2 와 같고, 여기서는 더 무겁다 — 이 판정이
// 참이면 그 바이트가 `image/svg+xml` 로 우리 출처에서 나간다. `.svg` 로 이름만
// 바꾼 HTML 이 통과하면 확장자 하나가 저장형 XSS 의 길이 된다.
//
// XML 선언·주석·DOCTYPE 을 건너뛰고 **루트 요소가 `<svg`인지**를 본다. 대문자를
// 받지 않는 것은 XML 이 대소문자를 가리기 때문이다 — `<SVG` 는 SVG 가 아니며,
// 그것을 받아 주는 쪽은 HTML 파서다.
func looksLikeSVG(head []byte) bool {
	b := bytes.TrimLeft(head, "\xef\xbb\xbf \t\r\n")
	for len(b) > 0 {
		switch {
		case bytes.HasPrefix(b, []byte("<?")):
			i := bytes.Index(b, []byte("?>"))
			if i < 0 {
				return false
			}
			b = b[i+2:]
		case bytes.HasPrefix(b, []byte("<!--")):
			i := bytes.Index(b, []byte("-->"))
			if i < 0 {
				return false
			}
			b = b[i+3:]
		case bytes.HasPrefix(b, []byte("<!")):
			i := bytes.IndexByte(b, '>')
			if i < 0 {
				return false
			}
			b = b[i+1:]
		default:
			if !bytes.HasPrefix(b, []byte("<svg")) {
				return false
			}
			// `<svgfoo` 를 배제한다 — 요소 이름은 여기서 끝나야 한다.
			if len(b) == 4 {
				return true
			}
			switch b[4] {
			case ' ', '\t', '\r', '\n', '>', '/':
				return true
			}
			return false
		}
		b = bytes.TrimLeft(b, " \t\r\n")
	}
	return false
}

// openRegularFile 은 절대경로의 **일반 파일**을 연다. 두 종단이 같은 가드를
// 딛는다 — 경로 검사가 갈리면 한쪽만 디렉터리를 읽으려 든다.
// FILE_API_BOUNDARY_SRS FR-FAB-11: `probe`·`raw` 도 `read`·`write` 와 같은 경계다.
// 넷 중 하나만 열려 있으면 그것이 곧 우회 경로다.
func (s *Server) openRegularFile(w http.ResponseWriter, r *http.Request) (*os.File, os.FileInfo, bool) {
	fp, ok := s.fileGuard(w, r, r.URL.Query().Get("path"), false)
	if !ok {
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
	f, st, ok := s.openRegularFile(w, r)
	if !ok {
		return
	}
	defer f.Close()

	kind, mime, _, err := probeFile(f)
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
// **이미지와 SVG 만 내보낸다.** 임의의 파일을 추론된 MIME 으로 같은 출처에서
// 인라인 제공하면 저장형 XSS 가 된다 — HTML 하나면 족하다. 기존 종단 둘은 이
// 함정을 각자 피하고 있다: `/api/file/read` 는 언제나 text/plain, `/api/download`
// 는 octet-stream + attachment 다. 새 종단만 예외일 수 없다.
//
// SVG 가 뒤에 더해졌다 (FR-DRV-24). 그것은 **이미지이면서 문서인** 유일한
// 형식이며, 그래서 다른 것들에는 없는 잠금장치가 함께 간다 — 내용 판정과
// `Content-Security-Policy: sandbox` 다. 아래 분기의 주석이 그 값을 적고 있다.
func (s *Server) apiFileRaw(w http.ResponseWriter, r *http.Request) {
	f, st, ok := s.openRegularFile(w, r)
	if !ok {
		return
	}
	defer f.Close()

	kind, mime, head, err := probeFile(f)
	if err != nil {
		http.Error(w, "cannot read file", http.StatusForbidden)
		return
	}
	// DOC_RENDER_VIEW_SRS FR-DRV-24: **SVG 에 문을 내되 잠금장치를 함께 단다.**
	//
	// Markdown 문서 안에서 참조된 `.svg` 이미지가 이 길로 온다. 판정은 내용이고
	// (`looksLikeSVG`), 나갈 때는 `nosniff` 와 `sandbox` 를 함께 보낸다 — 사용자가
	// 이 URL 을 주소창에 직접 열었을 때 문서의 스크립트가 우리 출처에서 도는 것을
	// 막는 것은 그 헤더뿐이다. `<img>` 안에서 안전한 것과 그것은 다른 이야기다.
	svg := kind == fileKindText && looksLikeSVG(head)
	if kind != fileKindImage && !svg {
		http.Error(w, "not an image", http.StatusUnsupportedMediaType)
		return
	}
	if svg {
		mime = "image/svg+xml"
		w.Header().Set("Content-Security-Policy", "sandbox")
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
