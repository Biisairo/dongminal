package ext

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// InstallTimeout 은 조달 하나의 시간 상한이다 (FR-EXT-18).
//
// 넉넉한 이유는 toolchain 조달이 의존을 다 받아 컴파일하기 때문이다 — 찬 캐시에서
// 분 단위가 정상이다 (§2.1 은 24.6초였지만 그것은 빠른 기계다). 그래도 상한이
// 있어야 한다: 없으면 답하지 않는 네트워크에서 조달이 끝나지 않고 사용자는 버튼이
// 죽은 것으로 읽는다.
const InstallTimeout = 10 * time.Minute

// OutputTail 은 도구의 출력을 결과에 실을 때의 상한이다. 사용자가 읽을 부분은 대개
// 마지막 오류 줄이다.
const OutputTail = 4000

// ExecFunc 는 명령 하나를 돌린다. name 과 args 가 **분리된 채** 오므로 셸이 끼지
// 않는다 (FR-EXT-17·38).
type ExecFunc func(ctx context.Context, name string, args, env []string, dir string) ([]byte, error)

// Outcome 은 조달의 결과다 (FR-EXT-18).
//
// **사유가 있는 것이 규칙이다.** 이 기능은 "안 되는 경우" 가 많고(D-9), 그 전부가
// 아무 말 없이 끝나면 사용자는 모두 우리 버그로 읽는다.
type Outcome struct {
	OK bool `json:"ok"`
	// Reason 은 사람의 말로 적은 사유다.
	Reason string `json:"reason,omitempty"`
	// Detail 은 도구가 낸 출력의 끝쪽이다 — 실제 원인이 거기 있다.
	Detail string `json:"detail,omitempty"`
	// Exe 는 성공했을 때 선 실행 파일 하나다.
	Exe string `json:"exe,omitempty"`
}

func fail(format string, a ...any) Outcome {
	return Outcome{Reason: fmt.Sprintf(format, a...)}
}

// Installer 는 선언대로 조달한다 (FR-EXT-10~19).
//
// **우리는 집행기다** (D-P2). 무엇을 어디서 받을지는 매니페스트가 정하고, 이 타입은
// 그것을 격리 칸 안에서 수행할 뿐이다.
//
// 네트워크와 실행을 **주입받는다** — 검사가 남의 기계에 네트워크를 쓰거나 파일을
// 쓰지 않고 "무엇을 어떻게 부르려 했는지" 를 잴 수 있어야 한다 (§2.5 ③).
type Installer struct {
	// Root 는 격리 칸이다.
	Root string
	// Fetch 는 아카이브를 받는다. 비면 실제 네트워크를 쓴다.
	Fetch Fetch
	// Exec 은 명령을 돌린다. 비면 실제 프로세스를 쓴다.
	Exec ExecFunc
	// LookPath 는 보통 exec.LookPath 다.
	LookPath func(string) (string, error)
	// Timeout 이 0 이면 InstallTimeout 이다.
	Timeout time.Duration
}

// NewInstaller 는 실제 네트워크·프로세스를 쓰는 Installer 다.
func NewInstaller(root string) *Installer {
	return &Installer{Root: root, Fetch: HTTPFetch, Exec: execCombined, LookPath: exec.LookPath}
}

// execCombined 은 실제 실행이다. **셸을 거치지 않는다** — `exec.CommandContext` 에
// 이름과 인자를 그대로 넘긴다 (FR-EXT-17).
func execCombined(ctx context.Context, name string, args, env []string, dir string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	return cmd.CombinedOutput()
}

func (r *Installer) lookPath() func(string) (string, error) {
	if r.LookPath != nil {
		return r.LookPath
	}
	return exec.LookPath
}

func (r *Installer) fetch() Fetch {
	if r.Fetch != nil {
		return r.Fetch
	}
	return HTTPFetch
}

func (r *Installer) exec() ExecFunc {
	if r.Exec != nil {
		return r.Exec
	}
	return execCombined
}

// Install 은 팩 하나를 조달한다.
//
// 단위가 팩인 것은 조달물이 하나이기 때문이다 (FR-EXT-5) — 서버 다섯을 내는 npm
// 패키지를 서버마다 받으면 같은 것을 다섯 번 받는다.
func (r *Installer) Install(ctx context.Context, m Manifest, runtimes []Manifest) Outcome {
	if r.Root == "" {
		return fail("격리 칸이 정해지지 않았습니다")
	}
	if m.Kind != KindServer {
		return fail("%s 는 서버를 내는 팩이 아닙니다", m.ID)
	}

	to := r.Timeout
	if to <= 0 {
		to = InstallTimeout
	}
	cctx, cancel := context.WithTimeout(ctx, to)
	defer cancel()

	// FR-EXT-7·7b: 런타임이 먼저다. 없을 때만 받는다 (lazy).
	for _, need := range m.Needs {
		if out := r.ensureRuntime(cctx, need, runtimes); !out.OK {
			return out
		}
	}

	var detail string
	switch m.Source.Kind {
	case SourceArchive:
		t, ok := m.Source.Targets[CurrentTarget()]
		if !ok {
			return fail("%s: 이 플랫폼(%s)의 조달처가 선언에 없습니다", m.ID, CurrentTarget())
		}
		if err := FetchArchive(cctx, r.fetch(), t, PluginDir(r.Root, m.ID)); err != nil {
			return Outcome{Reason: fmt.Sprintf("%s 를 받지 못했습니다", m.ID), Detail: err.Error()}
		}
	case SourceNPM:
		out, d := r.installNPM(cctx, m, runtimes)
		detail = d
		if !out.OK {
			return out
		}
	case SourceToolchain:
		out, d := r.installToolchain(cctx, m)
		detail = d
		if !out.OK {
			return out
		}
	default:
		return fail("%s: 모르는 조달 방법입니다: %q", m.ID, m.Source.Kind)
	}

	if cctx.Err() == context.DeadlineExceeded {
		return Outcome{Reason: fmt.Sprintf("%s 조달이 %s 안에 끝나지 않아 중단했습니다", m.ID, to), Detail: detail}
	}

	// FR-EXT-19: 성공의 판정은 **실행 파일의 존재**다. 도구가 0 을 냈어도 우리가
	// 쓸 것이 놓이지 않았으면 성공이 아니다 — 그 모순이 우리 버그로 읽힌다.
	//
	// 팩의 **모든** 서버를 본다 (FR-EXT-5). 하나만 보면 다섯 중 넷이 빠진 조달이
	// 성공으로 보고된다.
	var first string
	for _, s := range m.Servers {
		p := ManagedExeFound(r.Root, m, s)
		if p == "" {
			return Outcome{
				Reason: fmt.Sprintf("%s 는 끝났는데 %s 가 놓이지 않았습니다", m.ID, s.Exe),
				Detail: detail,
			}
		}
		if first == "" {
			first = p
		}
	}
	return Outcome{OK: true, Exe: first, Detail: detail}
}

// ensureRuntime 은 런타임 하나를 확보한다 (FR-EXT-7·7b).
//
// **있으면 아무것도 하지 않는다.** 호스트의 것도 인정하며(§2.5 ④ 와 같은 근거),
// 그것이 대개의 개발 기계에서 우리가 아무것도 받지 않는 이유다.
func (r *Installer) ensureRuntime(ctx context.Context, id string, runtimes []Manifest) Outcome {
	if runtimeReadyIn(r.Root, r.lookPath(), runtimes, id, CurrentTarget()) {
		return Outcome{OK: true}
	}
	var rt Manifest
	found := false
	for _, c := range runtimes {
		if c.ID == id && c.Kind == KindRuntime {
			rt, found = c, true
			break
		}
	}
	if !found {
		// FR-EXT-29: 없는 것을 이름으로 말한다.
		return fail("%s 가 없고 받는 방법도 선언돼 있지 않습니다", id)
	}
	t, ok := rt.Source.Targets[CurrentTarget()]
	if !ok {
		return fail("%s: 이 플랫폼(%s)의 조달처가 선언에 없습니다", id, CurrentTarget())
	}
	if err := FetchArchive(ctx, r.fetch(), t, RuntimeDir(r.Root, rt)); err != nil {
		return Outcome{Reason: fmt.Sprintf("%s 를 받지 못했습니다", id), Detail: err.Error()}
	}
	return Outcome{OK: true}
}

// installNPM 은 **그 런타임의 npm** 으로 받는다 (FR-EXT-12).
//
// 호스트 npm 을 먼저 찾지 않는 이유는 판이다 — 우리가 고정한 런타임이 있는데 남의
// npm 을 쓰면 기계마다 다른 결과가 된다. 호스트의 것은 우리 런타임이 없을 때만
// 쓰이며, 그때는 그 node 가 이미 `needs` 를 채운 것이다.
func (r *Installer) installNPM(ctx context.Context, m Manifest, runtimes []Manifest) (Outcome, string) {
	name, pre, prepend, err := r.npmCommand(runtimes)
	if err != nil {
		return Outcome{Reason: err.Error()}, ""
	}
	dir := PluginDir(r.Root, m.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Outcome{Reason: "팩의 자리를 만들지 못했습니다", Detail: err.Error()}, ""
	}

	args := append(append([]string{}, pre...), "install")
	args = append(args, m.Source.Packages...)
	args = append(args, "--prefix", dir)
	env := IsolatedEnvWithPath(r.Root, m, prepend, os.Getenv("PATH"))
	out, err := r.exec()(ctx, name, args, env, dir)
	detail := tailOf(string(out), OutputTail)
	if err != nil {
		return Outcome{Reason: fmt.Sprintf("%s 를 받지 못했습니다", m.ID), Detail: detail}, detail
	}
	return Outcome{OK: true}, detail
}

// npmCommand 는 npm 을 부를 방법을 정한다.
//
// 우리 런타임이 있으면 `node <npm-cli>` 로 부른다. npm 의 자리가 OS 마다 다른데,
// 그 차이는 코드가 아니라 **선언의 타깃별 값**에 있다 (FR-EXT-13 / §2.8).
func (r *Installer) npmCommand(runtimes []Manifest) (name string, pre []string, prepend []string, err error) {
	for _, rt := range runtimes {
		if rt.Kind != KindRuntime {
			continue
		}
		node := RuntimeExe(r.Root, rt, "node", CurrentTarget())
		npm := RuntimeExe(r.Root, rt, "npm", CurrentTarget())
		if node == "" || npm == "" {
			continue
		}
		// PATH 앞에 우리 런타임의 bin 을 세운다 — npm 이 자기 하위 프로세스로
		// node 를 부를 때 사용자의 것이 아니라 우리 것을 잡아야 한다.
		return node, []string{npm}, []string{filepath.Dir(node)}, nil
	}
	// 우리 런타임이 없다 — 호스트의 npm 이 `needs` 를 채운 갈래다.
	if p, e := r.lookPath()("npm"); e == nil && p != "" {
		return p, nil, nil, nil
	}
	return "", nil, nil, fmt.Errorf("npm 을 찾지 못했습니다")
}

// installToolchain 은 호스트 도구로 만든다 (FR-EXT-14).
//
// gopls 가 이 갈래이며, prebuilt 가 어디에도 없기 때문이다 (§2.3 / D-P4). VS Code 의
// Go 확장도 같은 자리에 있다.
func (r *Installer) installToolchain(ctx context.Context, m Manifest) (Outcome, string) {
	tool := m.Source.Tool
	// FR-EXT-14·29: 없는 것을 **이름으로** 알린다. "설치 실패" 는 사용자가 다음에
	// 할 일을 알려주지 않지만 "go 가 없다" 는 알려준다.
	if _, err := r.lookPath()(tool); err != nil {
		return Outcome{Reason: fmt.Sprintf(
			"%s 가 이 기계에 없어 %s 를 받을 수 없습니다 — %s 를 먼저 설치하세요",
			tool, m.ID, tool)}, ""
	}
	dir := PluginDir(r.Root, m.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Outcome{Reason: "팩의 자리를 만들지 못했습니다", Detail: err.Error()}, ""
	}

	env := IsolatedEnv(r.Root, m)
	out, err := r.exec()(ctx, tool, m.Source.Args, env, dir)
	detail := tailOf(string(out), OutputTail)

	// FR-EXT-23: 부산물은 즉시 버린다. 실패했어도 버린다 — 실패한 빌드가 남긴
	// 캐시도 §2.1 의 889 MB 와 같은 것이다.
	r.pruneBuildCache()

	if err != nil {
		return Outcome{Reason: fmt.Sprintf("%s 가 %s 를 만들지 못했습니다", tool, m.ID), Detail: detail}, detail
	}
	return Outcome{OK: true}, detail
}

// pruneBuildCache 는 빌드의 부산물을 지운다 (FR-EXT-23).
//
// 실패는 삼킨다 (§2.5 ⑤) — 정리는 곁다리이므로 그 실패가 조달의 결과를 뒤집지
// 않는다.
func (r *Installer) pruneBuildCache() {
	cache := CacheDir(r.Root)
	for _, sub := range []string{cacheGoMod, cacheGoBld} {
		_ = os.RemoveAll(filepath.Join(cache, sub))
	}
}

// tailOf 는 문자열의 끝쪽 n 바이트다. 도구의 출력에서 사용자가 읽을 부분은 대개
// 마지막 오류 줄이다.
func tailOf(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}
