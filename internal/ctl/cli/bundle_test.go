package cli

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// `G2-3`(PRODUCTION_ROADMAP §M3) — **신고에 붙일 것이 있다.**
//
// 사용자가 문제를 신고할 때 우리가 묻는 것은 언제나 같다: 판·OS·홈에 무엇이
// 있는지·로그의 끝·설정. 그것을 매번 손으로 모으게 하면 신고가 오지 않는다.
//
// **비밀이 새면 번들 자체가 위험이다.** 그래서 마스킹은 이 저장소의 **유일한**
// 규칙(`git/core.SanitizeRemote`)을 재사용하고, 카나리아가 그것을 지킨다.

func zipNames(t *testing.T, p string) map[string]string {
	t.Helper()
	r, err := zip.OpenReader(p)
	if err != nil {
		t.Fatalf("번들을 열 수 없다: %v", err)
	}
	defer r.Close()
	out := map[string]string{}
	for _, f := range r.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		var b bytes.Buffer
		b.ReadFrom(rc)
		rc.Close()
		out[f.Name] = b.String()
	}
	return out
}

func bundleHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv(EnvHome, home)
	os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{"themeName":"dark"}`), 0o644)
	os.WriteFile(filepath.Join(home, "access.json"), []byte(`{"enabled":true}`), 0o644)
	os.WriteFile(filepath.Join(home, "server.log"), []byte("line1\nline2\n"), 0o644)
	return home
}

// 번들에 물어야 할 것들이 들어 있다.
func TestBundleHasWhatWeAlwaysAsk(t *testing.T) {
	home := bundleHome(t)
	out := filepath.Join(t.TempDir(), "b.zip")

	var buf bytes.Buffer
	if code := RunDoctorBundle(DoctorOpts{Bundle: out}, &buf, &buf); code != 0 {
		t.Fatalf("code=%d out=%s", code, buf.String())
	}
	names := zipNames(t, out)
	for _, want := range []string{"about.txt", "home-files.txt", "settings.json", "access.json"} {
		if _, ok := names[want]; !ok {
			t.Errorf("번들에 %q 가 없다 (keys=%v)", want, keysOf(names))
		}
	}
	if !strings.Contains(names["about.txt"], "version") {
		t.Errorf("about.txt 에 판이 없다:\n%s", names["about.txt"])
	}
	_ = home
}

// **자격증명이 새지 않는다** — 카나리아.
func TestBundleMasksCredentials(t *testing.T) {
	home := bundleHome(t)
	const canary = "SUPERSECRET"
	os.WriteFile(filepath.Join(home, "server.log"),
		[]byte("remote https://user:"+canary+"@github.com/x/y.git\n"), 0o644)
	out := filepath.Join(t.TempDir(), "b.zip")

	var buf bytes.Buffer
	if code := RunDoctorBundle(DoctorOpts{Bundle: out}, &buf, &buf); code != 0 {
		t.Fatalf("code=%d", code)
	}
	for name, body := range zipNames(t, out) {
		if strings.Contains(body, canary) {
			t.Fatalf("%s 에 자격증명이 남았다:\n%s", name, body)
		}
	}
}

// 홈 파일 목록은 **이름과 크기**이지 내용이 아니다.
func TestBundleHomeListingIsNamesOnly(t *testing.T) {
	home := bundleHome(t)
	os.WriteFile(filepath.Join(home, "workspace.json"), []byte(`{"secret-layout":1}`), 0o644)
	out := filepath.Join(t.TempDir(), "b.zip")

	var buf bytes.Buffer
	RunDoctorBundle(DoctorOpts{Bundle: out}, &buf, &buf)
	listing := zipNames(t, out)["home-files.txt"]
	if !strings.Contains(listing, "workspace.json") {
		t.Errorf("목록에 workspace.json 이 없다:\n%s", listing)
	}
	if strings.Contains(listing, "secret-layout") {
		t.Errorf("목록에 내용이 실렸다:\n%s", listing)
	}
}

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
