package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/webserver/domain/wsentry"

	"dongminal/internal/shared/testpath"
)

// EXPLORER_ROOT_KEYS_SRS §5 — 묶음 D 의 서버측 (V-EXR-60~62).
//
// `FR-EXR-33`: 메모 루트에서는 **폴더 생성만** 거부한다. 클라이언트에서만 막으면
// API 직접 호출로는 만들어지고, 그것이 이 저장소가 반복해 겪은 "한족만 고쳐지는"
// 형태다 (D-4·D-5).
//
// 메모 루트는 `Roots()` 가 이미 보장한다 — `fsRoot` 가 그것을 부르므로 여기서
// 따로 만들 필요가 없다 (SRS §2.7).

func notesRootFor(t *testing.T, s *Server) string {
	t.Helper()
	_, ed := fsReq(t, s, http.MethodGet, "/api/editors", "")
	notes, _ := ed["notes"].(string)
	if notes == "" {
		t.Fatalf("notes 가 없다: %v", ed)
	}
	return notes
}

// V-EXR-60 (FR-EXR-33): 메모 루트에 dir:true 로 만들면 400 이고 아무것도 안 생긴다.
func TestFSCreate_RejectsDirInNotesRoot(t *testing.T) {
	s, _, _ := fsTestServer(t)
	notes := notesRootFor(t, s)

	target := filepath.Join(notes, "folder")
	code, out := fsReq(t, s, http.MethodPost, "/api/fs/create",
		`{"root":`+testpath.JSONQuote(notes)+`,"path":`+testpath.JSONQuote(target)+`,"dir":true}`)
	if code != http.StatusBadRequest || out["code"] != fsErrBadRequest {
		t.Fatalf("code=%d body=%v — 400 bad_request 여야 한다", code, out)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("거부했는데 폴더가 생겼다: err=%v", err)
	}
}

// V-EXR-61 (FR-EXR-34): 같은 루트의 **파일** 생성은 그대로 된다. 막은 것은 dir 하나다.
func TestFSCreate_AllowsFileInNotesRoot(t *testing.T) {
	s, _, _ := fsTestServer(t)
	notes := notesRootFor(t, s)

	target := filepath.Join(notes, "memo.md")
	if code, out := fsReq(t, s, http.MethodPost, "/api/fs/create",
		`{"root":`+testpath.JSONQuote(notes)+`,"path":`+testpath.JSONQuote(target)+`}`); code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if st, err := os.Stat(target); err != nil || st.IsDir() {
		t.Fatalf("파일이 안 생겼다: err=%v", err)
	}
}

// V-EXR-62 (FR-EXR-33): 메모 루트가 **아닌** 루트의 폴더 생성은 종전대로다.
func TestFSCreate_AllowsDirOutsideNotesRoot(t *testing.T) {
	s, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)

	target := filepath.Join(root, "folder")
	if code, out := fsReq(t, s, http.MethodPost, "/api/fs/create",
		`{"root":`+testpath.JSONQuote(root)+`,"path":`+testpath.JSONQuote(target)+`,"dir":true}`); code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if st, err := os.Stat(target); err != nil || !st.IsDir() {
		t.Fatalf("폴더가 안 생겼다: err=%v", err)
	}
}
