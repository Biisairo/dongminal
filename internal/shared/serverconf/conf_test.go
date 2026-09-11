package serverconf_test

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/serverconf"
)

func write(t *testing.T, home, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(home, "server.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

// TC-CFG-6: 넷 다 있으면 **플래그가 이긴다** (FR-CFG-13).
func TestPriorityFlagWins(t *testing.T) {
	home := t.TempDir()
	write(t, home, `{"host":"10.0.0.1","port":"3333","logLevel":"debug"}`)
	got := serverconf.Resolve(serverconf.Inputs{
		Home: home, FlagHost: "1.1.1.1", FlagPort: "1111", FlagLogLevel: "error",
		Getenv: envOf(map[string]string{"DONGMINAL_HOST": "2.2.2.2", "PORT": "2222", "DONGMINAL_LOG_LEVEL": "warn"}),
	})
	if got.Host.Value != "1.1.1.1" || got.Host.Source != serverconf.SourceFlag {
		t.Errorf("host = %+v", got.Host)
	}
	if got.Port.Value != "1111" || got.Port.Source != serverconf.SourceFlag {
		t.Errorf("port = %+v", got.Port)
	}
	if got.LogLevel.Value != "error" || got.LogLevel.Source != serverconf.SourceFlag {
		t.Errorf("logLevel = %+v", got.LogLevel)
	}
}

// TC-CFG-7: 계층을 하나씩 걷으면 그다음이 이긴다.
func TestPriorityFallsThroughLayers(t *testing.T) {
	home := t.TempDir()
	write(t, home, `{"host":"10.0.0.1","port":"3333"}`)
	env := envOf(map[string]string{"DONGMINAL_HOST": "2.2.2.2", "PORT": "2222"})

	got := serverconf.Resolve(serverconf.Inputs{Home: home, Getenv: env})
	if got.Host.Value != "2.2.2.2" || got.Host.Source != serverconf.SourceEnv {
		t.Errorf("환경변수가 이겨야 한다: %+v", got.Host)
	}

	got = serverconf.Resolve(serverconf.Inputs{Home: home, Getenv: envOf(nil)})
	if got.Host.Value != "10.0.0.1" || got.Host.Source != serverconf.SourceFile {
		t.Errorf("파일이 이겨야 한다: %+v", got.Host)
	}
	if got.Port.Value != "3333" || got.Port.Source != serverconf.SourceFile {
		t.Errorf("파일 포트: %+v", got.Port)
	}

	got = serverconf.Resolve(serverconf.Inputs{Home: t.TempDir(), Getenv: envOf(nil)})
	if got.Host.Source != serverconf.SourceDefault || got.Port.Source != serverconf.SourceDefault {
		t.Errorf("기본값이어야 한다: %+v %+v", got.Host, got.Port)
	}
	if got.LogLevel.Value != "info" {
		t.Errorf("기본 로그 수준 = %q", got.LogLevel.Value)
	}
}

// TC-CFG-8: 빈 문자열은 "정하지 않음" 이다 — 다음 계층으로 간다.
func TestEmptyMeansUnset(t *testing.T) {
	home := t.TempDir()
	write(t, home, `{"host":"","port":"3333"}`)
	got := serverconf.Resolve(serverconf.Inputs{
		Home: home, FlagHost: "", Getenv: envOf(map[string]string{"DONGMINAL_HOST": ""}),
	})
	if got.Host.Source != serverconf.SourceDefault {
		t.Errorf("빈 값이 계층을 멈춰 세웠다: %+v", got.Host)
	}
	if got.Port.Source != serverconf.SourceFile {
		t.Errorf("port = %+v", got.Port)
	}
}

// TC-CFG-9: 파일이 없으면 **조용히** 넘어간다. 없는 것이 정상이다 (FR-CFG-14).
func TestMissingFileIsSilent(t *testing.T) {
	got := serverconf.Resolve(serverconf.Inputs{Home: t.TempDir(), Getenv: envOf(nil)})
	if len(got.Warnings) != 0 {
		t.Fatalf("없는 파일에 경고가 났다: %v", got.Warnings)
	}
}

// TC-CFG-10: 깨진 파일은 **기동을 막지 않는다** (FR-CFG-15 / D-CFG-3).
// 설정 파일 하나가 서버를 못 뜨게 만들면 고칠 화면에 닿을 수 없다.
func TestCorruptFileWarnsAndContinues(t *testing.T) {
	home := t.TempDir()
	write(t, home, `{nope`)
	got := serverconf.Resolve(serverconf.Inputs{
		Home: home, Getenv: envOf(map[string]string{"DONGMINAL_HOST": "2.2.2.2"}),
	})
	if len(got.Warnings) == 0 {
		t.Fatal("깨진 파일에 경고가 없다")
	}
	if got.Host.Value != "2.2.2.2" {
		t.Errorf("다음 계층으로 가지 않았다: %+v", got.Host)
	}
	if got.Port.Source != serverconf.SourceDefault {
		t.Errorf("기동을 막았다: %+v", got.Port)
	}
}

// 알 수 없는 키는 경고이지 실패가 아니다 (D-CFG-4).
func TestUnknownKeyWarnsOnly(t *testing.T) {
	home := t.TempDir()
	write(t, home, `{"host":"10.0.0.1","futureKey":1}`)
	got := serverconf.Resolve(serverconf.Inputs{Home: home, Getenv: envOf(nil)})
	if got.Host.Value != "10.0.0.1" {
		t.Errorf("host = %+v", got.Host)
	}
	if len(got.Warnings) != 1 {
		t.Errorf("경고 = %v", got.Warnings)
	}
}

// TC-CFG-16: `PORT=abc` 는 `net.Listen` 전에 거부되고, 문구에 **어느 변수의 어떤
// 값인지**가 실린다 (FR-CFG-19).
func TestNonNumericPortRejected(t *testing.T) {
	got := serverconf.Resolve(serverconf.Inputs{
		Home: t.TempDir(), Getenv: envOf(map[string]string{"PORT": "abc"}),
	})
	err := got.Err()
	if err == nil {
		t.Fatal("비숫자 포트가 통과했다")
	}
	msg := err.Error()
	for _, want := range []string{"PORT", "abc"} {
		if !contains(msg, want) {
			t.Errorf("문구에 %q 가 없다: %s", want, msg)
		}
	}
	// 파일의 비숫자도 같다.
	home := t.TempDir()
	write(t, home, `{"port":"zzz"}`)
	if e := serverconf.Resolve(serverconf.Inputs{Home: home, Getenv: envOf(nil)}).Err(); e == nil {
		t.Error("파일의 비숫자 포트가 통과했다")
	}
	// 범위 밖도 거부한다.
	if e := serverconf.Resolve(serverconf.Inputs{
		Home: t.TempDir(), Getenv: envOf(map[string]string{"PORT": "99999"}),
	}).Err(); e == nil {
		t.Error("범위 밖 포트가 통과했다")
	}
}

// 정상 포트는 통과한다 — 게이트가 자기 발을 밟지 않는지 본다.
func TestValidPortPasses(t *testing.T) {
	if e := serverconf.Resolve(serverconf.Inputs{
		Home: t.TempDir(), Getenv: envOf(map[string]string{"PORT": "8080"}),
	}).Err(); e != nil {
		t.Fatalf("정상 포트가 막혔다: %v", e)
	}
}

// DONGMINAL_PORT 도 같은 계층이다 — PORT 가 먼저다.
func TestDongminalPortEnv(t *testing.T) {
	got := serverconf.Resolve(serverconf.Inputs{
		Home: t.TempDir(), Getenv: envOf(map[string]string{"DONGMINAL_PORT": "4444"}),
	})
	if got.Port.Value != "4444" || got.Port.Source != serverconf.SourceEnv {
		t.Errorf("port = %+v", got.Port)
	}
	got = serverconf.Resolve(serverconf.Inputs{
		Home: t.TempDir(), Getenv: envOf(map[string]string{"PORT": "5555", "DONGMINAL_PORT": "4444"}),
	})
	if got.Port.Value != "5555" {
		t.Errorf("PORT 가 먼저여야 한다: %+v", got.Port)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
