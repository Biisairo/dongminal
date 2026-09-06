package ext

import (
	"path/filepath"
	"strings"
	"testing"
)

func envMap(pairs []string) map[string]string {
	m := map[string]string{}
	for _, p := range pairs {
		k, v, ok := strings.Cut(p, "=")
		if ok {
			m[k] = v
		}
	}
	return m
}

// TC-EXT-30 (FR-EXT-21·22 / V-EXT-4): **조달이 남의 홈에 쓰지 않는다.**
//
// §2.1 이 이 검사의 이유다 — 종전 구현은 산출물의 자리만 격리하고 캐시를 사용자
// 홈에 쌓았으며, 그것을 격리라고 적어 두었다. 문장이 아니라 이 검사가 판정한다
// (D-P8).
func TestIsolatedEnv_NothingEscapesTheRoot(t *testing.T) {
	root := t.TempDir()
	env := envMap(IsolatedEnv(root, mustParse(t, npmPack)))

	// 홈과 캐시를 정하는 변수들. 하나라도 빠지면 그만큼이 사용자 홈에 남는다.
	for _, k := range []string{
		"HOME", "USERPROFILE",
		"npm_config_cache", "npm_config_prefix",
		"GOMODCACHE", "GOCACHE", "GOBIN",
		"XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
	} {
		v, ok := env[k]
		if !ok || v == "" {
			t.Errorf("%s 가 격리되지 않았다 — 그만큼이 사용자 홈에 쌓인다 (FR-EXT-21)", k)
			continue
		}
		if !underRoot(root, v) {
			t.Errorf("%s=%s 가 격리 칸 밖을 가리킨다 (FR-EXT-22)", k, v)
		}
	}
}

// TC-EXT-31 (FR-EXT-21): 사용자의 전역 플래그가 우리 조달을 망가뜨리지 않는다.
//
// 종전 구현이 `GOFLAGS` 를 비운 이유가 그것이다 — 사용자의 `-mod=vendor` 가
// `go install` 을 막으면 그 실패는 우리가 설명할 수 없는 실패로 보인다.
func TestIsolatedEnv_ClearsHostileGlobals(t *testing.T) {
	env := envMap(IsolatedEnv(t.TempDir(), mustParse(t, goPack)))
	for _, k := range []string{"GOFLAGS", "NODE_OPTIONS", "NPM_CONFIG_PREFIX"} {
		if v, ok := env[k]; !ok || v != "" {
			t.Errorf("%s 가 비워지지 않았다: %q (ok=%v)", k, v, ok)
		}
	}
}

// TC-EXT-32 (FR-EXT-21): npm 이 사용자 전역에 쓰지 않는다.
func TestIsolatedEnv_NpmIsNeverGlobal(t *testing.T) {
	env := envMap(IsolatedEnv(t.TempDir(), mustParse(t, npmPack)))
	if env["npm_config_global"] != "false" {
		t.Fatalf("npm 이 전역으로 설치될 수 있다: %q", env["npm_config_global"])
	}
	// 사용자 `.npmrc` 가 우리 조달의 자리를 바꾸지 못해야 한다.
	if env["npm_config_userconfig"] == "" || !underRoot(root(env), env["npm_config_userconfig"]) {
		t.Fatalf("사용자 .npmrc 가 격리되지 않았다: %q", env["npm_config_userconfig"])
	}
}

// TC-EXT-33 (FR-EXT-21): GOBIN 은 **그 팩의** 자리다. 팩마다 갈려야 한 팩의
// 산출물이 다른 팩을 덮지 않는다.
func TestIsolatedEnv_GOBINIsPerPack(t *testing.T) {
	r := t.TempDir()
	a := envMap(IsolatedEnv(r, mustParse(t, goPack)))["GOBIN"]
	b := envMap(IsolatedEnv(r, mustParse(t, npmPack)))["GOBIN"]
	if a == b {
		t.Fatalf("두 팩이 같은 GOBIN 을 쓴다: %s", a)
	}
	// 탐색이 보는 자리와 같아야 한다 — 두 벌이면 받아 두고도 못 찾는다
	// (FR-EXT-19).
	m := mustParse(t, goPack)
	if want := filepath.Dir(ManagedExe(r, m, m.Servers[0])); a != want {
		t.Fatalf("GOBIN 이 탐색의 자리와 다르다: %s (기대 %s)", a, want)
	}
}

// TC-EXT-34 (FR-EXT-21): PATH 앞에 격리 칸이 선다 — 조달이 부르는 하위 도구가
// 사용자의 것이 아니라 우리 것을 잡아야 한다.
func TestIsolatedEnv_PrependsPath(t *testing.T) {
	root := t.TempDir()
	env := envMap(IsolatedEnvWithPath(root, mustParse(t, npmPack), []string{filepath.Join(root, "runtimes", "node-x", "bin")}, "/usr/bin"))
	got := env["PATH"]
	first, _, _ := strings.Cut(got, string(filepath.ListSeparator))
	if !underRoot(root, first) {
		t.Fatalf("PATH 의 첫 자리가 우리 것이 아니다: %s", got)
	}
	if !strings.Contains(got, "/usr/bin") {
		t.Fatalf("기존 PATH 가 사라졌다 — 조달이 호스트 도구를 못 찾는다: %s", got)
	}
}

func root(env map[string]string) string {
	// 검사 편의: 캐시 경로에서 칸의 뿌리를 되짚는다.
	return filepath.Dir(filepath.Dir(env["npm_config_cache"]))
}

func underRoot(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
