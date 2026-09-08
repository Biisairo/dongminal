//go:build !windows

// posix 셸 훅의 검증이다. Windows 의 도구 셸은 PowerShell 이고 그쪽에는 이 훅이
// 주입되지 않으므로(VIEWER_URL_OPEN_SRS 비목표), 러너에 Git Bash 가 있더라도
// 검증 대상이 아니다. OS 를 묻는 대신 파일을 가른다 — 이 저장소가 OS 를 가르는
// 유일한 방식이다 (CROSS_PLATFORM_SRS FR-XPL-5, scripts/check-seams.sh).

package runtime

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// V10 (VIEWER_URL_OPEN_SRS FR-VUO-14): 쉘 훅의 `open`/`xdg-open` 은 URL 만
// 가로채고 나머지는 원래 명령에 위임한다.
//
// **실제 쉘로 잰다.** 문자열 검사로는 함수가 도는지 알 수 없고, 이 함수가
// 잘못되면 `open .` 같은 일상 명령이 깨진다.

// hookFixture 는 훅을 source 할 수 있는 임시 환경을 만든다. 가짜 open-url 과
// 가짜 open 이 각자 자기가 불렸음을 파일에 남긴다.
func hookFixture(t *testing.T) (home, binDir, log string) {
	t.Helper()
	home = t.TempDir()
	binDir = filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	log = filepath.Join(home, "calls.log")

	// 가짜 open-url 헬퍼 (가로챈 경로).
	script := "#!/bin/sh\necho \"open-url $*\" >> " + log + "\n"
	if err := os.WriteFile(filepath.Join(binDir, "open-url"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	// PATH 앞에 놓일 가짜 open / xdg-open (위임 경로).
	fake := filepath.Join(home, "fakebin")
	if err := os.MkdirAll(fake, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"open", "xdg-open"} {
		s := "#!/bin/sh\necho \"real-" + n + " $*\" >> " + log + "\n"
		if err := os.WriteFile(filepath.Join(fake, n), []byte(s), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return home, binDir, log
}

// runHook 은 훅을 푼 뒤 source 하고 cmd 를 실행한다. 로그 내용을 낸다.
func runHook(t *testing.T, shell, hookRel, cmd string) string {
	t.Helper()
	if _, err := exec.LookPath(shell); err != nil {
		t.Skipf("%s 없음", shell)
	}
	home, binDir, log := hookFixture(t)
	unpacked := t.TempDir()
	if err := unpackEmbedded(shellhookFS, "shellhooks/posix", unpacked); err != nil {
		t.Fatalf("unpack: %v", err)
	}
	hook := filepath.Join(unpacked, hookRel)

	script := ". " + hook + "\n" + cmd + "\n"
	c := exec.Command(shell, "-c", script)
	c.Env = append(os.Environ(),
		"HOME="+home,
		"DONGMINAL_HOME="+home,
		"PATH="+filepath.Join(home, "fakebin")+string(os.PathListSeparator)+os.Getenv("PATH"),
		"ZDOTDIR="+filepath.Join(unpacked, "zdotdir"),
	)
	if out, err := c.CombinedOutput(); err != nil {
		t.Fatalf("%s: %v\n%s", shell, err, out)
	}
	b, err := os.ReadFile(log)
	if err != nil {
		return ""
	}
	_ = binDir
	return string(b)
}

func TestOpenHook_InterceptsHTTPURL(t *testing.T) {
	for _, tc := range []struct{ shell, hook string }{
		{"zsh", filepath.Join("zdotdir", ".zshrc")},
		{"bash", "bash-hook.sh"},
	} {
		t.Run(tc.shell, func(t *testing.T) {
			got := runHook(t, tc.shell, tc.hook, `open 'https://example.com/a?b=1'`)
			if !strings.Contains(got, "open-url https://example.com/a?b=1") {
				t.Fatalf("가로채지 못했다: %q", got)
			}
			if strings.Contains(got, "real-open") {
				t.Fatalf("원래 open 까지 불렸다: %q", got)
			}
		})
	}
}

func TestOpenHook_DelegatesNonURL(t *testing.T) {
	// 일상 사용을 깨뜨리면 안 된다 — 이것이 이 함수의 가장 큰 위험이다.
	cases := []string{
		`open .`,
		`open a.pdf`,
		`open -a Xcode f.swift`,
		`open https://a.dev https://b.dev`,
		`open mailto:x@y.z`,
		`open vscode://file/tmp/a`,
	}
	for _, tc := range []struct{ shell, hook string }{
		{"zsh", filepath.Join("zdotdir", ".zshrc")},
		{"bash", "bash-hook.sh"},
	} {
		for _, cmd := range cases {
			t.Run(tc.shell+" "+cmd, func(t *testing.T) {
				got := runHook(t, tc.shell, tc.hook, cmd)
				if !strings.Contains(got, "real-open") {
					t.Fatalf("%q 가 원래 open 으로 가지 않았다: %q", cmd, got)
				}
				if strings.Contains(got, "open-url") {
					t.Fatalf("%q 를 가로챘다: %q", cmd, got)
				}
			})
		}
	}
}

func TestXdgOpenHook_InterceptsHTTPURL(t *testing.T) {
	for _, tc := range []struct{ shell, hook string }{
		{"zsh", filepath.Join("zdotdir", ".zshrc")},
		{"bash", "bash-hook.sh"},
	} {
		t.Run(tc.shell, func(t *testing.T) {
			got := runHook(t, tc.shell, tc.hook, `xdg-open http://localhost:3000/`)
			if !strings.Contains(got, "open-url http://localhost:3000/") {
				t.Fatalf("가로채지 못했다: %q", got)
			}
		})
	}
}

// 헬퍼가 없는 환경(설치 전, 다른 홈)에서는 위임한다 — 훅이 명령을 삼키면 안 된다.
func TestOpenHook_NoHelperDelegates(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash 없음")
	}
	home, _, log := hookFixture(t)
	if err := os.Remove(filepath.Join(home, "bin", "open-url")); err != nil {
		t.Fatal(err)
	}
	unpacked := t.TempDir()
	if err := unpackEmbedded(shellhookFS, "shellhooks/posix", unpacked); err != nil {
		t.Fatal(err)
	}
	c := exec.Command("bash", "-c", ". "+filepath.Join(unpacked, "bash-hook.sh")+"\nopen https://x.dev\n")
	c.Env = append(os.Environ(), "HOME="+home, "DONGMINAL_HOME="+home,
		"PATH="+filepath.Join(home, "fakebin")+string(os.PathListSeparator)+os.Getenv("PATH"))
	if out, err := c.CombinedOutput(); err != nil {
		t.Fatalf("bash: %v\n%s", err, out)
	}
	b, _ := os.ReadFile(log)
	if !strings.Contains(string(b), "real-open") {
		t.Fatalf("헬퍼가 없는데 위임하지 않았다: %q", b)
	}
}
