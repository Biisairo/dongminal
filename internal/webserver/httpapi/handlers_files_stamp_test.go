package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// EDITOR_EXTERNAL_CHANGE_SRS §3.3·3.6 — 저장의 경합 (V-EXC-4~8).
//
// 표식은 **불투명하다** (FR-EXC-11). 이 파일이 그 값을 만들어 보지 않는 것이
// 그 증거다 — 읽기가 준 것을 그대로 되돌려 보낸다. 내부가 mtime+크기에서 해시로
// 바뀌어도 이 테스트는 한 줄도 바뀌지 않는다.

// readStamped 는 `GET /api/file/read` 한 번이고 본문과 표식을 함께 준다.
func readStamped(t *testing.T, e *fileBoundaryEnv, path string) (int, string, string) {
	t.Helper()
	resp, err := http.Get(e.ts.URL + "/api/file/read?path=" + path)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	return resp.StatusCode, string(buf[:n]), resp.Header.Get("X-File-Stamp")
}

// writeStamped 는 `POST /api/file/write` 한 번이다. stamp 가 빈 문자열이면 필드를
// 아예 싣지 않는다 — 옛 클라이언트의 모양이 그것이다 (FR-EXC-6a).
func writeStamped(t *testing.T, e *fileBoundaryEnv, path, content, stamp string) (int, string) {
	t.Helper()
	m := map[string]string{"path": path, "content": content}
	if stamp != "" {
		m["stamp"] = stamp
	}
	body, _ := json.Marshal(m)
	req, _ := http.NewRequest(http.MethodPost, e.ts.URL+"/api/file/write", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	return resp.StatusCode, string(buf[:n])
}

// stampOf 는 성공 응답이 준 **새 표식**을 꺼낸다 (FR-EXC-11).
func stampOf(t *testing.T, body string) string {
	t.Helper()
	var d struct {
		OK    bool   `json:"ok"`
		Stamp string `json:"stamp"`
	}
	if err := json.Unmarshal([]byte(body), &d); err != nil {
		t.Fatalf("응답이 JSON 이 아니다: %q (%v)", body, err)
	}
	return d.Stamp
}

func seed(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// V-EXC-7(앞절): 읽기가 표식을 준다. 이것이 없으면 나머지가 전부 성립하지 않는다.
func TestFileRead_GivesStamp(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "note.txt")
	seed(t, target, "hello\n")

	code, body, stamp := readStamped(t, e, target)
	if code != http.StatusOK {
		t.Fatalf("status=%d want 200 body=%q", code, body)
	}
	if stamp == "" {
		t.Fatal("X-File-Stamp 가 없다 — 저장이 견줄 재료가 생기지 않는다 (FR-EXC-11)")
	}
}

// V-EXC-5: 바뀌지 않았으면 저장이 그대로 된다. 경합 검사가 정상 경로를 막지
// 않는다는 회귀다.
func TestFileWrite_StampMatchWrites(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "note.txt")
	seed(t, target, "hello\n")

	_, _, stamp := readStamped(t, e, target)
	code, body := writeStamped(t, e, target, "edited\n", stamp)
	if code != http.StatusOK {
		t.Fatalf("status=%d want 200 body=%q", code, body)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "edited\n" {
		t.Fatalf("내용=%q err=%v", got, err)
	}
}

// V-EXC-4: 읽은 뒤 밖에서 바뀐 파일에 저장하면 **409 이고 디스크는 그대로다.**
// 디스크를 함께 재는 것이 이 검사의 핵심이다 — 상태 코드만 보면 "거절했다고
// 말하고 쓰는" 구현을 통과시킨다.
func TestFileWrite_StampMismatchIs409(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "note.txt")
	seed(t, target, "hello\n")

	_, _, stamp := readStamped(t, e, target)
	// 밖에서 바뀌었다. 길이를 다르게 두어 표식의 내부 구성과 무관하게 갈리도록 한다.
	seed(t, target, "changed by someone else\n")

	code, body := writeStamped(t, e, target, "edited\n", stamp)
	if code != http.StatusConflict {
		t.Fatalf("status=%d want 409 body=%q", code, body)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "changed by someone else\n" {
		t.Fatalf("거절했는데 디스크가 바뀌었다: 내용=%q err=%v", got, err)
	}
}

// V-EXC-6: 표식이 없는 요청은 종전대로 통과한다 (FR-EXC-6a). 경합 상황에서도
// 그렇다 — 확인창의 `덮어쓰기` 가 정확히 이 길로 온다 (FR-EXC-9).
func TestFileWrite_NoStampWritesEvenWhenChanged(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "note.txt")
	seed(t, target, "hello\n")

	_, _, _ = readStamped(t, e, target)
	seed(t, target, "changed by someone else\n")

	code, body := writeStamped(t, e, target, "edited\n", "")
	if code != http.StatusOK {
		t.Fatalf("status=%d want 200 body=%q — 표식 없는 저장을 막으면 옛 호출자가 끊긴다", code, body)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "edited\n" {
		t.Fatalf("내용=%q err=%v", got, err)
	}
}

// V-EXC-7: 성공 응답이 **새 표식**을 준다. 없으면 연속 저장의 두 번째가 스스로
// 경합이 된다 — 한 번 저장하면 그 뒤로는 아무것도 저장되지 않는다는 뜻이다.
func TestFileWrite_ResponseCarriesNextStamp(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "note.txt")
	seed(t, target, "hello\n")

	_, _, stamp := readStamped(t, e, target)
	code, body := writeStamped(t, e, target, "first\n", stamp)
	if code != http.StatusOK {
		t.Fatalf("첫 저장 status=%d body=%q", code, body)
	}
	next := stampOf(t, body)
	if next == "" {
		t.Fatal("성공 응답에 stamp 가 없다 — 두 번째 저장이 제 발에 걸린다 (FR-EXC-11)")
	}

	code, body = writeStamped(t, e, target, "second\n", next)
	if code != http.StatusOK {
		t.Fatalf("두 번째 저장 status=%d want 200 body=%q", code, body)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "second\n" {
		t.Fatalf("내용=%q err=%v", got, err)
	}
}

// V-EXC-8: 밖에서 **지워진** 파일에 저장하면 경합이 아니다 — 새로 만든다
// (FR-EXC-10a). 덮어쓸 상대가 없으므로 표식이 달라졌는지 물을 것이 없다.
func TestFileWrite_StampOnDeletedFileCreates(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "note.txt")
	seed(t, target, "hello\n")

	_, _, stamp := readStamped(t, e, target)
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}

	code, body := writeStamped(t, e, target, "edited\n", stamp)
	if code != http.StatusOK {
		t.Fatalf("status=%d want 200 body=%q — 삭제는 경합이 아니다 (FR-EXC-10a)", code, body)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "edited\n" {
		t.Fatalf("내용=%q err=%v", got, err)
	}
}
