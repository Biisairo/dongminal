package toolhub

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// TOOL_HISTORY_ISOLATION_SRS 의 검사들.
//
// 이 파일의 검사는 셸을 띄우지 않는다 — 경로 계산과 시드는 순수한 파일 작업이며,
// 진짜 셸을 태우면 셸 버전에 검사가 매인다. 실제 셸까지의 확인은 TC-THI-20~23
// (통합)의 몫이다.

// histEnv 는 검사가 읽기 쉬운 map 으로 바꾼다.
func histEnv(t *testing.T, id, shell string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, e := range toolHistEnv(id, shell) {
		k, v, ok := strings.Cut(e, "=")
		if !ok {
			t.Fatalf("환경 항목에 = 가 없다: %q", e)
		}
		out[k] = v
	}
	return out
}

// setHomes 는 인스턴스 홈과 도구 홈을 검사용 임시 자리로 돌린다.
func setHomes(t *testing.T) (instHome, toolHome string) {
	t.Helper()
	instHome, toolHome = t.TempDir(), t.TempDir()
	t.Setenv(dmenv.EnvHome, instHome)
	t.Setenv(dmenv.EnvToolHome, toolHome)
	return
}

// TC-THI-1: 도구 둘의 HISTFILE 이 서로 다르고 규칙에 맞는다 (FR-THI-1·2).
func TestHistFile_PerTool(t *testing.T) {
	home, _ := setHomes(t)
	a := histEnv(t, "tool-a", "/bin/zsh")
	b := histEnv(t, "tool-b", "/bin/zsh")

	if a["HISTFILE"] == "" || b["HISTFILE"] == "" {
		t.Fatalf("HISTFILE 이 비었다: a=%v b=%v", a, b)
	}
	if a["HISTFILE"] == b["HISTFILE"] {
		t.Fatalf("두 도구가 같은 파일을 쓴다: %s", a["HISTFILE"])
	}
	want := filepath.Join(home, toolHistDir, "tool-a.zsh")
	if a["HISTFILE"] != want {
		t.Fatalf("HISTFILE=%s want %s", a["HISTFILE"], want)
	}
}

// TC-THI-2: 같은 ID 는 같은 경로다 — 재기동을 넘어 자기 히스토리로 돌아온다
// (FR-THI-3).
func TestHistFile_StableAcrossRestart(t *testing.T) {
	setHomes(t)
	first := histEnv(t, "tool-a", "/bin/zsh")["HISTFILE"]
	second := histEnv(t, "tool-a", "/bin/zsh")["HISTFILE"]
	if first != second {
		t.Fatalf("같은 ID 인데 경로가 다르다: %s vs %s", first, second)
	}
}

// TC-THI-3: 원본이 있고 대상이 없으면 복사된다 (FR-THI-10·11).
func TestHistFile_SeedsFromUserHistory(t *testing.T) {
	_, th := setHomes(t)
	seed := filepath.Join(th, ".zsh_history")
	if err := os.WriteFile(seed, []byte("cmd_from_user\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := histEnv(t, "tool-a", "/bin/zsh")["HISTFILE"]
	data, err := os.ReadFile(got)
	if err != nil {
		t.Fatalf("도구 히스토리를 읽지 못했다: %v", err)
	}
	if string(data) != "cmd_from_user\n" {
		t.Fatalf("시드 내용=%q want %q", data, "cmd_from_user\n")
	}
}

// TC-THI-4: 대상이 이미 있으면 덮지 않는다 (FR-THI-10, D-6).
func TestHistFile_NeverOverwrites(t *testing.T) {
	_, th := setHomes(t)
	if err := os.WriteFile(filepath.Join(th, ".zsh_history"), []byte("user\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := histEnv(t, "tool-a", "/bin/zsh")["HISTFILE"]
	if err := os.WriteFile(path, []byte("tool_own\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 두 번째 기동. 시드가 다시 돌면 도구가 쌓은 것이 사라진다.
	histEnv(t, "tool-a", "/bin/zsh")

	data, _ := os.ReadFile(path)
	if string(data) != "tool_own\n" {
		t.Fatalf("두 번째 기동이 히스토리를 덮었다: %q", data)
	}
}

// TC-THI-5: 원본이 없어도 오류 없이 진행하며 대상은 비어 있다 (FR-THI-12).
func TestHistFile_NoSeedSource(t *testing.T) {
	setHomes(t)
	path := histEnv(t, "tool-a", "/bin/zsh")["HISTFILE"]
	if path == "" {
		t.Fatal("원본이 없다고 주입을 포기했다")
	}
	if data, err := os.ReadFile(path); err == nil && len(data) != 0 {
		t.Fatalf("빈 히스토리여야 한다: %q", data)
	}
}

// TC-THI-6: 격리 기동에서는 사용자 홈의 히스토리가 새어 들어오지 않는다
// (FR-THI-11, D-5). 도구 홈이 사용자 홈이 아니면 그 자리에 원본이 없으므로
// 복사가 저절로 일어나지 않는다.
func TestHistFile_IsolatedHomeDoesNotSeed(t *testing.T) {
	_, th := setHomes(t)
	// 사용자 홈에는 히스토리가 있으나 도구 홈(th)에는 없다.
	if home, err := os.UserHomeDir(); err == nil && home == th {
		t.Skip("도구 홈이 사용자 홈과 같다 — 이 검사가 뜻을 갖지 않는다")
	}
	path := histEnv(t, "tool-a", "/bin/zsh")["HISTFILE"]
	if data, err := os.ReadFile(path); err == nil && len(data) != 0 {
		t.Fatalf("격리 홈인데 시드가 들어왔다: %q", data)
	}
}

// TC-THI-7: 도구 ID 가 비면 주입하지 않는다 (FR-THI-5).
func TestHistFile_NoToolID(t *testing.T) {
	setHomes(t)
	if env := toolHistEnv("", "/bin/zsh"); env != nil {
		t.Fatalf("ID 가 없는데 주입했다: %v", env)
	}
}

// TC-THI-7b: 인스턴스 홈을 모르면 주입하지 않는다 (FR-THI-5).
func TestHistFile_NoInstanceHome(t *testing.T) {
	setHomes(t)
	t.Setenv(dmenv.EnvHome, "")
	if env := toolHistEnv("tool-a", "/bin/zsh"); env != nil {
		t.Fatalf("인스턴스 홈이 없는데 주입했다: %v", env)
	}
}

// TC-THI-7c: 파일명이 될 수 없는 ID 는 주입하지 않는다. tools.json 은 사람이
// 고칠 수 있는 파일이므로 id 가 언제나 uuid 라고 믿지 않는다 (FR-THI-5).
func TestHistFile_RejectsUnsafeID(t *testing.T) {
	setHomes(t)
	for _, id := range []string{"../escape", "a/b", ".", "..", "a\x00b"} {
		if env := toolHistEnv(id, "/bin/zsh"); env != nil {
			t.Fatalf("안전하지 않은 id=%q 를 받아들였다: %v", id, env)
		}
	}
}

// TC-THI-8: 디렉터리를 만들 수 없으면 주입하지 않고 종전 동작으로 열화한다
// (FR-THI-5, NFR-THI-3).
func TestHistFile_UnwritableHomeDegrades(t *testing.T) {
	_, th := setHomes(t)
	// 인스턴스 홈 자리를 **파일**로 만든다 — 그 아래에 디렉터리를 만들 수 없다.
	blocked := filepath.Join(th, "blocked")
	if err := os.WriteFile(blocked, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(dmenv.EnvHome, blocked)
	if env := toolHistEnv("tool-a", "/bin/zsh"); env != nil {
		t.Fatalf("만들 수 없는 자리인데 주입했다: %v", env)
	}
}

// TC-THI-10: 다른 히스토리 설정은 건드리지 않는다 (FR-THI-25).
func TestHistFile_TouchesNothingElse(t *testing.T) {
	setHomes(t)
	env := histEnv(t, "tool-a", "/bin/zsh")
	for _, k := range []string{"HISTSIZE", "SAVEHIST", "HISTFILESIZE", "HISTCONTROL"} {
		if _, ok := env[k]; ok {
			t.Fatalf("%s 를 주입했다: %v", k, env)
		}
	}
	// 심는 것은 둘뿐이다 — 셸이 쓰는 값과, rc 가 덮인 뒤 되살릴 원본.
	if len(env) != 2 || env[dmenv.EnvHistFile] != env["HISTFILE"] {
		t.Fatalf("환경이 규약과 다르다: %v", env)
	}
}

// FR-THI-2: 셸이 다르면 파일도 다르다 — 히스토리 형식이 셸마다 다르다.
func TestHistFile_PerShell(t *testing.T) {
	setHomes(t)
	z := histEnv(t, "tool-a", "/bin/zsh")["HISTFILE"]
	b := histEnv(t, "tool-a", "/bin/bash")["HISTFILE"]
	if z == b {
		t.Fatalf("zsh 와 bash 가 같은 파일을 쓴다: %s", z)
	}
	if !strings.HasSuffix(b, ".bash") {
		t.Fatalf("bash 파일 이름=%s", b)
	}
}

// FR-THI-11: bash 의 시드 원본은 .bash_history 다.
func TestHistFile_SeedsBashFromBashHistory(t *testing.T) {
	_, th := setHomes(t)
	if err := os.WriteFile(filepath.Join(th, ".bash_history"), []byte("bash_cmd\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(th, ".zsh_history"), []byte("zsh_cmd\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := histEnv(t, "tool-a", "/bin/bash")["HISTFILE"]
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "bash_cmd\n" {
		t.Fatalf("bash 시드=%q want bash_cmd", data)
	}
}
