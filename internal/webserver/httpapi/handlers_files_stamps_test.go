package httpapi

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// EDITOR_LIVE_RELOAD_SRS 묶음 E — 열어 둔 파일들이 바뀌었는지 한 번에 묻는다
// (V-ELR-1~4).
//
// 표식은 여기서도 **불투명하다** (FR-EXC-11). 이 파일이 재는 것은 값의 내부가
// 아니라 둘이다 — ① 읽기가 준 것과 **같은가** (FR-ELR-2) ② 바뀌면 달라지는가.

// fileStampsReq 는 `POST /api/file/stamps` 한 번이다.
func fileStampsOf(t *testing.T, e *fileBoundaryEnv, paths []string) (int, map[string]string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"paths": paths})
	req, _ := http.NewRequest(http.MethodPost, e.ts.URL+"/api/file/stamps", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, nil
	}
	var d struct {
		Stamps map[string]string `json:"stamps"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		t.Fatalf("응답이 JSON 이 아니다: %v", err)
	}
	return resp.StatusCode, d.Stamps
}

// V-ELR-1 (FR-ELR-1·2): 경로마다 표식을 주고, 그 값이 읽기가 준 것과 **같다.**
//
// 이 한 줄이 이 종단의 전부다. 갈리면 클라이언트가 읽을 때 기억한 값과 폴링으로
// 견주는 값이 어긋나 매 회차가 변경으로 읽히고, 편집기가 같은 파일을 3초마다 다시
// 읽는다 (FR-FSL-10 이 겹에서 치른 값이다).
func TestFileStamps_MatchesReadHeader(t *testing.T) {
	e := newFileBoundaryEnv(t)
	a := filepath.Join(e.root, "a.txt")
	b := filepath.Join(e.root, "b.txt")
	seed(t, a, "alpha\n")
	seed(t, b, "beta\n")

	_, _, wantA := readStamped(t, e, a)
	_, _, wantB := readStamped(t, e, b)
	if wantA == "" || wantB == "" {
		t.Fatalf("읽기가 표식을 주지 않았다: %q %q", wantA, wantB)
	}

	code, got := fileStampsOf(t, e, []string{a, b})
	if code != http.StatusOK {
		t.Fatalf("status=%d want 200", code)
	}
	if got[a] != wantA {
		t.Errorf("a: stamps=%q read=%q — 같아야 한다", got[a], wantA)
	}
	if got[b] != wantB {
		t.Errorf("b: stamps=%q read=%q — 같아야 한다", got[b], wantB)
	}
}

// V-ELR-2: 파일을 고치면 표식이 달라진다. 이것이 곧 감지다.
func TestFileStamps_ChangesAfterWrite(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "note.txt")
	seed(t, target, "before\n")

	_, first := fileStampsOf(t, e, []string{target})
	// 밖에서 바뀐 것과 같다 — 이 종단은 누가 썼는지 묻지 않는다.
	seed(t, target, "after — 길이가 달라졌으므로 mtime 정밀도와 무관하다\n")
	_, second := fileStampsOf(t, e, []string{target})

	if first[target] == "" {
		t.Fatalf("첫 표식이 비었다")
	}
	if first[target] == second[target] {
		t.Errorf("표식이 그대로다: %q — 바뀌면 달라져야 한다", first[target])
	}
}

// V-ELR-3 (FR-ELR-5): 볼 수 없는 경로는 **빠지고**, 같은 요청의 나머지는 답을 받는다.
//
// 한 경로의 사정이 나머지의 답을 막지 않는다. 막으면 루트 밖의 파일 하나를 열어
// 둔 것만으로 열린 파일 전부의 관측이 멎는다.
func TestFileStamps_SkipsUnreadableAndMissing(t *testing.T) {
	e := newFileBoundaryEnv(t)
	ok := filepath.Join(e.root, "ok.txt")
	seed(t, ok, "ok\n")
	outside := filepath.Join(e.outside, "secret.txt")
	seed(t, outside, "secret\n")
	missing := filepath.Join(e.root, "gone.txt")

	code, got := fileStampsOf(t, e, []string{outside, missing, e.root, ok})
	if code != http.StatusOK {
		t.Fatalf("status=%d want 200 — 한 경로의 사정이 요청을 무르게 하지 않는다", code)
	}
	if got[ok] == "" {
		t.Errorf("볼 수 있는 파일의 표식이 없다")
	}
	for name, p := range map[string]string{"루트 밖": outside, "없는 파일": missing, "디렉터리": e.root} {
		if _, has := got[p]; has {
			t.Errorf("%s 가 응답에 들었다: %q", name, p)
		}
	}
}

// V-ELR-4 (FR-ELR-6): 상한을 넘으면 400 이다. 없으면 한 요청이 서버에서 무한정
// stat 한다.
func TestFileStamps_TooManyPaths(t *testing.T) {
	e := newFileBoundaryEnv(t)
	paths := make([]string, fileStampsMax+1)
	for i := range paths {
		paths[i] = filepath.Join(e.root, "f.txt")
	}
	code, _ := fileStampsOf(t, e, paths)
	if code != http.StatusBadRequest {
		t.Fatalf("status=%d want 400", code)
	}
}
