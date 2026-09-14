package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/webserver/domain/wsentry"

	"dongminal/internal/shared/testpath"
)

// M9_SRS FR-M9-23 / D-M9-15 — 메모 루트의 서버측.
//
// **`FR-EXR-33` 은 폐기됐다** (2026-09-14, 사용자 결정). 여기 있던
// `TestFSCreate_RejectsDirInNotesRoot`(V-EXR-60)는 메모 루트의 `dir:true` 가
// **400 이고 아무것도 생기지 않는다**를 쟀다. 지금은 그 반대가 요구다 — 메모장은
// 다른 루트와 같다. 검사의 이름과 단정을 뒤집어 그 자리에 둔다: 조항이 폐기됐다고
// 검사까지 지우면, 서버가 조용히 다시 거부하기 시작해도 아무도 모른다.
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

// V-M9-23e (FR-M9-23): 메모 루트에 dir:true 로 만들면 **만들어진다.**
//
//	이전 동작: 400 `bad_request` 이고 아무것도 생기지 않았다 (FR-EXR-33, 폐기)
//	새  동작: 다른 루트와 같다 — 폴더가 선다
//	이유:     사용자 결정 (D-M9-15). `U-16` 을 되돌렸다
func TestFSCreate_AllowsDirInNotesRoot(t *testing.T) {
	s, _, _ := fsTestServer(t)
	notes := notesRootFor(t, s)

	target := filepath.Join(notes, "folder")
	code, out := fsReq(t, s, http.MethodPost, "/api/fs/create",
		`{"root":`+testpath.JSONQuote(notes)+`,"path":`+testpath.JSONQuote(target)+`,"dir":true}`)
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v — 200 이어야 한다", code, out)
	}
	st, err := os.Stat(target)
	if err != nil || !st.IsDir() {
		t.Fatalf("받아들였는데 폴더가 없다: err=%v", err)
	}
}

// V-M9-23f:  같은 루트의 **파일** 생성은 그대로 된다. 막은 것은 dir 하나다.
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

// V-M9-23g:  메모 루트가 **아닌** 루트의 폴더 생성은 종전대로다.
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
