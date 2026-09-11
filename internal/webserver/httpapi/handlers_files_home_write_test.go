package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// FILE_API_BOUNDARY_SRS §4.3a — 홈 안의 쓰기 (TC-FAB-21~26, `SEC-16`).
//
// `fileRoots` 는 `$DONGMINAL_HOME` 전체를 루트로 넣는다 (FR-FAB-2). 그 아래에는
// **읽히기만 하는 값이 아니라 집행되는 선언**이 산다 — `ext` 매니페스트의 설치
// 명령은 실제로 실행되고(FR-EXT-17), `access.json` 은 경계 자체이며,
// `settings.json` 에는 그 경계를 끄는 스위치가 있다.
//
// 즉 쓰기 요청 **하나**로 임의 명령 실행과 ACL 무력화에 닿았다. 그것이 이 문서가
// 막으려던 브라우저 매개 공격의 정의다.

func TestFileWrite_HomeStateIsForbidden(t *testing.T) {
	e := newFileBoundaryEnv(t)
	cases := []struct {
		name string
		path string
	}{
		{"settings.json", filepath.Join(e.data, "settings.json")},
		{"access.json", filepath.Join(e.data, "access.json")},
		{"ext 매니페스트", filepath.Join(e.data, "ext", "plugins", "x", "dongminal-ext.json")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.MkdirAll(filepath.Dir(tc.path), 0o755); err != nil {
				t.Fatal(err)
			}
			code, body := e.write(t, tc.path, "{}\n")
			if code != http.StatusForbidden {
				t.Fatalf("status=%d want 403 body=%q", code, body)
			}
			if _, err := os.Stat(tc.path); err == nil {
				t.Fatalf("거절했는데 파일이 생겼다: %s", tc.path)
			}
		})
	}
}

// TC-FAB-24: 예외는 노트뿐이다. 노트는 제품이 웹에서 쓰라고 만든 자리다.
func TestFileWrite_NotesIsAllowed(t *testing.T) {
	e := newFileBoundaryEnv(t)
	notes := filepath.Join(e.data, "notes")
	if err := os.MkdirAll(notes, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(notes, "memo.md")
	code, body := e.write(t, target, "# memo\n")
	if code != http.StatusOK {
		t.Fatalf("status=%d want 200 body=%q — 노트는 예외다", code, body)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "# memo\n" {
		t.Fatalf("내용=%q err=%v", got, err)
	}
}

// TC-FAB-25: **읽기는 막지 않는다.** 설정을 확인하려고 여는 흐름이 있고, 그 자리에
// 비밀이 있지 않다.
func TestFileRead_HomeStateStillReadable(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.data, "settings.json")
	if err := os.WriteFile(target, []byte("{\"a\":1}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	resp, err := http.Get(e.ts.URL + "/api/file/read?path=" + target)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d want 200 — 읽기까지 막혔다", resp.StatusCode)
	}
}

// TC-FAB-26: 경계를 끄는 설정이 참이어도 홈 쓰기는 막힌다.
//
// `fileApiUnrestricted` 는 "내 작업 파일을 어디서든 열겠다" 는 뜻이지 "내 서버의
// 집행 선언을 웹으로 덮겠다" 는 뜻이 아니다 — 노출 모드가 그 설정을 무시하는 것과
// 같은 논리다 (FR-FAB-7).
func TestFileWrite_HomeStateForbiddenEvenWhenUnrestricted(t *testing.T) {
	e := newFileBoundaryEnvWith(t, func(data string) {
		p := filepath.Join(data, "settings.json")
		if err := os.WriteFile(p, []byte(`{"fileApiUnrestricted":true}`), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	target := filepath.Join(e.data, "access.json")
	code, body := e.write(t, target, "{}\n")
	if code != http.StatusForbidden {
		t.Fatalf("status=%d want 403 body=%q", code, body)
	}
}
