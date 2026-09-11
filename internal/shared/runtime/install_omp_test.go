package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/helper/runtimebin"
	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/testpath"
)

// OMP_AGENT_SUPPORT_SRS §5.2 — 설치와 래퍼의 검증 V-OMP-10·13·14.
//
// 래퍼 ↔ 선언 대조(V-OMP-11·12)는 기존 `TestPolicyInjectionDeclarationMatchesShellWrappers`
// 가 이미 전 에이전트에 대해 잰다 — 두 벌로 두지 않는다.

// jsonString 은 shim 안의 JS 문자열 리터럴 모양이다. 프로덕션 헬퍼를 검증만을
// 위해 밖으로 열지 않는다 — 한 줄이므로 여기서 같은 규칙을 적는다.
func jsonString(v string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(v) + `"`
}

// V-OMP-10
func TestInstallOmpAssets_ShimAndOverlay(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	hooks := runtimebin.AgentHooksDirIn(dir)

	shim, err := os.ReadFile(filepath.Join(hooks, agentadapter.OmpShimFile))
	if err != nil {
		t.Fatalf("shim 이 없다: %v", err)
	}
	s := string(shim)
	// FR-OMP-11: dmctl 은 절대 경로다 — PATH 앞의 낡은 dmctl 은 activity 를 모른다.
	if !strings.Contains(s, jsonString(dmctlPath(dir))) {
		t.Fatalf("shim 이 dmctl 절대 경로를 담지 않았다:\n%s", s)
	}
	if !strings.Contains(s, `"activity", "omp"`) {
		t.Fatalf("shim 이 dmctl activity omp 를 부르지 않는다:\n%s", s)
	}
	// FR-OMP-12: 형식은 parseOmpHook 이 읽는 것과 같은 문서를 근거로 한다.
	// 여기서는 **이벤트 이름의 짝**을 잰다 — 한쪽만 고쳐지면 조용히 무시된다.
	for _, ev := range []string{
		"session_start", "session_shutdown", "agent_start", "agent_end",
		"turn_start", "turn_end", "tool_call", "tool_result", "compaction",
	} {
		if !strings.Contains(s, `event: "`+ev+`"`) {
			t.Errorf("shim 이 %q 를 보고하지 않는다 — 파서는 그것을 안다", ev)
		}
	}
	// omp 쪽 계기 이름도 실제로 구독해야 한다.
	for _, on := range []string{
		"session_start", "session_shutdown", "agent_start", "agent_end",
		"turn_start", "turn_end", "tool_call", "tool_result",
		"auto_compaction_start", "session_compact",
	} {
		if !strings.Contains(s, `pi.on("`+on+`"`) {
			t.Errorf("shim 이 omp 이벤트 %q 를 구독하지 않는다", on)
		}
	}
	// FR-OMP-13: 실패를 삼킨다 — 관측이 도구 사용을 막으면 그것은 관측이 아니다.
	if !strings.Contains(s, "catch") || !strings.Contains(s, `p.on("error"`) {
		t.Fatalf("shim 이 실패를 삼키지 않는다 (FR-OMP-13):\n%s", s)
	}

	overlay, err := os.ReadFile(filepath.Join(hooks, agentadapter.OmpMemberConfigFile))
	if err != nil {
		t.Fatalf("멤버 오버레이가 없다: %v", err)
	}
	o := string(overlay)
	// V-OMP-13 / FR-OMP-20·23
	if !strings.Contains(o, "patterns") || !strings.Contains(o, "dmctl") || !strings.Contains(o, "allow") {
		t.Fatalf("오버레이가 dmctl 을 허용하지 않는다:\n%s", o)
	}
	for _, banned := range []string{"approvalMode", "yolo", "auto-approve"} {
		if strings.Contains(o, banned) {
			t.Fatalf("오버레이가 전면 우회(%s)를 담았다 (FR-OMP-23):\n%s", banned, o)
		}
	}
}

// V-OMP-14 / NFR-OMP-1: 사용자의 omp 영구 설정을 한 바이트도 건드리지 않는다.
// claude 쪽의 같은 검사(TestInstallWritesNothingOutsideItsBinDir)와 같은 자리다.
func TestInstallDoesNotTouchOmpHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv(testpath.HomeEnv(), home)
	ompDir := filepath.Join(home, ".omp")
	if err := os.MkdirAll(filepath.Join(ompDir, "agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(ompDir, "config.yml")
	if err := os.WriteFile(cfg, []byte("tools:\n  approvalMode: always-ask\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := Install(t.TempDir()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	got, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatalf("사용자 설정이 사라졌다: %v", err)
	}
	if string(got) != "tools:\n  approvalMode: always-ask\n" {
		t.Fatalf("사용자의 영구 설정이 수정됐다 (FR-ADP-5): %s", got)
	}
	entries, err := os.ReadDir(ompDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 { // agent/ 와 config.yml — 우리가 더한 것이 없다
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("~/.omp 에 파일이 생겼다: %v", names)
	}
}

// FR-OMP-21·22: 멤버 기동줄의 오버레이 경로가 **설치가 쓴 자리**와 같아야 한다.
// 선언·설치·기동줄 셋이 같은 파일을 가리키는지 여기서 만난다.
func TestOmpMemberLaunchLinePointsAtInstalledOverlay(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	hooks := runtimebin.AgentHooksDirIn(dir)
	omp, err := agentadapter.Get("omp")
	if err != nil {
		t.Fatal(err)
	}
	line, err := omp.LaunchLine(hooks, "", "프리앰블")
	if err != nil {
		t.Fatalf("LaunchLine: %v", err)
	}
	want := filepath.Join(hooks, agentadapter.OmpMemberConfigFile)
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("기동줄이 가리키는 파일이 설치되지 않았다: %v", err)
	}
	if !strings.Contains(line, want) {
		t.Fatalf("기동줄이 설치된 오버레이를 가리키지 않는다:\nline=%s\nwant=%s", line, want)
	}
}

// NFR-OMP-1 (2026-09-11 사용자 요구): **omp 도 claude 처럼 "파일을 교체하거나
// 추가하지 않는다."** 주입은 전부 per-invocation 플래그이며, 우리가 쓰는 파일은
// 하나도 남김없이 dongminal 자신의 bin 아래에 있다.
//
// 재는 것이 둘이다:
//
//	① 설치가 만드는 omp 관련 산출물이 `binDir` 밖에 없다
//	② omp 의 **자동 탐색** 경로(`~/.omp/agent/hooks/`)를 쓰지 않는다 — 그 자리에
//	   두면 우리 파일이 사용자의 모든 omp 세션에 얹힌다. 그것이 곧 "추가" 다.
func TestOmpInjectionIsRuntimeOnly(t *testing.T) {
	home := t.TempDir()
	t.Setenv(testpath.HomeEnv(), home)
	binDir := t.TempDir()
	if err := Install(binDir); err != nil {
		t.Fatalf("Install: %v", err)
	}

	// ① 홈에는 omp 관련 자리가 서지 않는다.
	if _, err := os.Stat(filepath.Join(home, ".omp")); err == nil {
		t.Fatal("설치가 ~/.omp 를 만들었다 — 런타임 주입이 아니다")
	}

	// ② 우리 산출물은 binDir 아래다.
	hooks := runtimebin.AgentHooksDirIn(binDir)
	for _, f := range []string{agentadapter.OmpShimFile, agentadapter.OmpMemberConfigFile} {
		p := filepath.Join(hooks, f)
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s 가 없다: %v", f, err)
		}
		if !strings.HasPrefix(p, binDir) {
			t.Fatalf("%s 가 bin 밖에 있다: %s", f, p)
		}
	}

	// ③ shim 도 오버레이도 사용자의 omp 자리를 **언급조차** 하지 않는다.
	for _, f := range []string{agentadapter.OmpShimFile, agentadapter.OmpMemberConfigFile} {
		blob, err := os.ReadFile(filepath.Join(hooks, f))
		if err != nil {
			t.Fatal(err)
		}
		for _, banned := range []string{".omp/agent", "~/.omp", "node_modules", "pi-coding-agent"} {
			if strings.Contains(string(blob), banned) {
				t.Fatalf("%s 가 사용자의 omp 설치를 가리킨다: %q", f, banned)
			}
		}
	}
}
