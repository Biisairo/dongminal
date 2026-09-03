// Package sandbox 는 Window 하나에 대응하는 컨테이너의 생명주기와, 그 안에
// 도구를 띄우는 명세를 만든다 (SANDBOX_WINDOW_SRS).
//
// 컨테이너 런타임 호출은 runFn 하나로 모아 주입한다. platform 패키지가 OS 능력에
// 쓰는 것과 같은 방식이며, 이유도 같다 — 런타임이 없는 호스트에서도 판단 로직
// 전량을 검증할 수 있어야 한다 (SRS §4.1).
//
// 이 패키지는 게스트가 항상 리눅스라는 전제 위에 있다. 그래서 호스트 OS 별
// 분기가 없다 (NFR-SBX-1).
package sandbox

import (
	"fmt"
	"os/exec"
	"strings"

	"dongminal/internal/shared/platform"
)

// runFn 은 컨테이너 런타임 한 번의 실행이다. args 는 `docker` 뒤에 오는 인자다.
type runFn = func(args []string) (stdout string, err error)

const (
	// namePrefix 는 대응 컨테이너 이름의 앞머리다 (FR-SBX-5).
	namePrefix = "dongminal-sbx-"

	// LabelHome·LabelWindow 는 회수의 키다 (FR-SBX-9). 이름이 아니라 라벨로
	// 찾는 이유는 한 호스트에서 여러 인스턴스가 돌기 때문이다 — 이름만으로는
	// 어느 홈의 것인지 알 수 없다.
	LabelHome   = "dongminal.home"
	LabelWindow = "dongminal.window"

	// 프로파일 이름. workspace.json 의 `sandbox` 필드에 이 값이 들어간다.
	ProfileScratch = "scratch"
	ProfileDev     = "dev"

	// ScratchImage 는 scratch 프로파일의 기본 이미지다. dev·agent 는 기본값을
	// 두지 않는다 — 그 둘의 유용성은 전적으로 이미지 내용물에 달려 있어 임의의
	// 기본값이 언제나 틀린다 (FR-SBX-3).
	ScratchImage = "debian:stable-slim"
)

// keepAlive 는 컨테이너를 살려 두는 유지 프로세스다. 도구는 여기에 exec 로
// 붙는다 — 컨테이너의 주 프로세스를 셸로 두면 그 셸이 끝날 때 컨테이너가 함께
// 죽어, 탭 하나를 닫은 것이 Window 전체를 무너뜨린다 (FR-SBX-7).
var keepAlive = []string{"sleep", "infinity"}

// Profile 은 샌드박스 창의 정책이다 (FR-SBX-1).
//
// 정의 파일에서 오는 것은 Image 와 Ports 뿐이다. 나머지 — 네트워크·마운트·헬퍼 —
// 는 프로파일 **종류**가 정한다. 사용자가 그것들을 개별로 켜고 끌 수 있으면
// §3.3 의 격리 등급이 설정 조합만큼 늘어나 아무 의미가 없어진다.
type Profile struct {
	Name    string
	Image   string
	Network string // "none" | "bridge"
	// Ports 는 호스트와 같은 번호로 열 포트다. "3000" 또는 "5173-5180".
	Ports []string
	// Workspace 는 동적 마운트를 받는가다 — 창을 열 때 정해진 작업 폴더가
	// 컨테이너 안 ContainerWorkdir 로 붙는다 (FR-SBX-40).
	Workspace bool
	// BaseMounts 는 이 프로파일이면 언제나 붙는 마운트다 (FR-SBX-39).
	BaseMounts []Mount
	// Helper 는 컨테이너 안에서 dmctl 을 쓸 수 있게 하는가다. 켜면 그 창은
	// 격리 경계가 아니다 (FR-SBX-23).
	Helper bool
}

// Scratch 는 신뢰하지 않는 코드를 돌리는 프로파일이다. 마운트도 네트워크도
// 헬퍼도 없어, 세 프로파일 중 유일하게 격리 경계다 (FR-SBX-23).
func Scratch() Profile {
	return Profile{Name: ProfileScratch, Image: ScratchImage, Network: "none"}
}

// HostGateway 는 컨테이너에서 호스트를 부르는 이름이다. 컨테이너 안 dmctl 이
// 서버에 붙을 때 쓴다 (FR-SBX-16).
//
// 전송 계층은 바뀌지 않는다 — dmctl 은 이미 HTTP 로 붙고(§2.4), 여기서 다른
// 것은 주소뿐이다.
const HostGateway = "host.docker.internal"

// RunSpec 은 컨테이너를 만들 때 필요한 **창별** 값이다. 프로파일이 정책이라면
// 이쪽은 그 창의 사정이다.
type RunSpec struct {
	// HostDir 은 마운트할 호스트 경로다. 비면 마운트하지 않는다.
	HostDir string
	// HelperPath 는 컨테이너에 넣을 리눅스 dmctl 이다. 프로파일이 헬퍼를
	// 원하지 않으면 무시된다.
	HelperPath string
}

// ExecEnv 는 컨테이너 안 도구에 심을 값이다.
type ExecEnv struct {
	ToolID string
	Port   string
}

// Manager 는 한 인스턴스(home)의 대응 컨테이너들을 다룬다.
type Manager struct {
	run  runFn
	home string
}

func New(run runFn, home string) *Manager { return &Manager{run: run, home: home} }

// ContainerName 은 Window 에 대응하는 컨테이너 이름이다 (FR-SBX-5).
func (m *Manager) ContainerName(windowUUID string) string {
	return namePrefix + windowUUID
}

// Ensure 는 대응 컨테이너를 **쓸 수 있는 상태로** 만든다 (FR-SBX-6/26).
//
// 세 갈래다. 없으면 만들고, 돌고 있으면 그대로 두고, 정지돼 있으면 시작한다.
// 정지된 것을 새로 만들지 않는 것이 요점이다 — 그 컨테이너의 파일시스템에
// 사용자가 설치한 것과 만든 것이 들어 있다.
func (m *Manager) Ensure(windowUUID string, p Profile, rs RunSpec) error {
	name := m.ContainerName(windowUUID)

	state, err := m.run([]string{"inspect", "-f", "{{.State.Status}}", name})
	if err != nil {
		// 조회 실패에는 두 뜻이 겹쳐 있다 — 컨테이너가 없거나, 런타임에 닿지
		// 못했거나. 둘을 섞으면 데몬이 꺼진 상태에서 생성으로 넘어가 다시
		// 실패하고, 사용자는 원인과 무관한 사유를 보게 된다 (FR-SBX-20).
		if runtimeDown(state) {
			return fmt.Errorf("컨테이너 런타임에 연결할 수 없습니다(실행 중인지 확인하세요): %s",
				strings.TrimSpace(state))
		}
		return m.create(name, windowUUID, p, rs)
	}
	if strings.TrimSpace(state) == "running" {
		return nil
	}
	if out, err := m.run([]string{"start", name}); err != nil {
		return fmt.Errorf("샌드박스 컨테이너를 시작하지 못했습니다: %w: %s", err, strings.TrimSpace(out))
	}
	return nil
}

// create 는 대응 컨테이너를 만든다.
//
// **`--rm` 을 붙이지 않는다.** 붙이면 컨테이너가 멈추는 순간 파일시스템이
// 사라져, 호스트를 재부팅한 사용자가 설치해 둔 것을 전부 잃는다. 제거는
// Window 폐기라는 명시적 사건에서만 일어난다 (FR-SBX-7/8).
func (m *Manager) create(name, windowUUID string, p Profile, rs RunSpec) error {
	if p.Image == "" {
		return fmt.Errorf("샌드박스 프로파일 %q 에 이미지가 지정되지 않았습니다", p.Name)
	}
	args := []string{
		// --init 은 신호를 전달하고 좀비를 수확하는 PID 1 을 넣는다.
		//
		// 없으면 유지 프로세스가 PID 1 이 되는데, PID 1 에는 신호의 기본 동작이
		// 적용되지 않아 SIGTERM 이 무시된다 — 정지 한 번에 런타임의 강제 종료
		// 대기(기본 10초)를 그대로 치른다(실측). 샌드박스 창은 사용자가 프로세스를
		// 여럿 띄우는 자리이므로 좀비 수확도 여기서 필요하다.
		"run", "-d", "--init", "--name", name,
		"--label", LabelHome + "=" + m.home,
		"--label", LabelWindow + "=" + windowUUID,
	}
	if p.Network != "" {
		args = append(args, "--network", p.Network)
	}
	// 창의 작업 디렉터리를 컨테이너 안 한 자리로 잇는다 (FR-SBX-1). 호스트
	// 경로가 없으면 붙이지 않는다 — 빈 원본은 런타임이 거부한다.
	if p.Workspace && rs.HostDir != "" {
		args = append(args, "-v", rs.HostDir+":"+ContainerWorkdir)
	}
	// 기본 마운트는 창이 달라도 같다 — 설정과 자격증명의 자리다 (FR-SBX-39).
	for _, mt := range p.BaseMounts {
		args = append(args, "-v", mt.Arg())
	}
	// 헬퍼는 **읽기 전용**이다. 컨테이너 안에서 고쳐 쓸 수 있으면 그 자체가
	// 호스트로 나가는 통로가 된다.
	//
	// 헬퍼가 들어간 창은 격리 경계가 아니다 (FR-SBX-23) — dmctl 로 워크스페이스
	// 전체를 조작할 수 있기 때문이며, 그래서 scratch 에는 넣지 않는다.
	if p.Helper && rs.HelperPath != "" {
		args = append(args, "-v", rs.HelperPath+":"+HelperMountPath+":ro")
		// 리눅스 호스트에서도 같은 이름이 서도록 게이트웨이를 명시한다. macOS·
		// Windows 는 런타임이 이미 이 이름을 풀지만, 한 자리에서 세워 두면
		// 호스트별 분기가 생기지 않는다 (NFR-SBX-1).
		args = append(args, "--add-host", HostGateway+":host-gateway")
	}
	// FR-SBX-30: 호스트와 **같은 번호**로 연다. 번호가 달라지면 컨테이너 안
	// 서버가 찍는 `localhost:3000` 이 그대로 틀린 안내가 된다.
	//
	// 매핑은 생성 시점에 확정된다 — 런타임이 실행 중인 컨테이너에 포트를 더할
	// 수 없기 때문이며, 그래서 포트가 프로파일에 미리 적힌다.
	for _, port := range p.Ports {
		args = append(args, "-p", port+":"+port)
	}
	args = append(args, p.Image)
	args = append(args, keepAlive...)

	if out, err := m.run(args); err != nil {
		// 같은 창의 두 도구가 동시에 기동하면 둘 다 "컨테이너 없음" 을 보고
		// 만들려 든다. 뒤늦은 쪽은 이름 충돌로 실패하지만 그 시점에 컨테이너는
		// 이미 있으므로 목적은 달성됐다 — 여기서 오류를 올리면 탭 하나가 이유
		// 없이 열리지 않는다.
		if nameTaken(out) {
			return nil
		}
		return fmt.Errorf("샌드박스 컨테이너를 만들지 못했습니다(이미지 %s): %w: %s",
			p.Image, err, strings.TrimSpace(out))
	}
	return nil
}

// nameTaken 은 이름이 이미 쓰이고 있다는 응답인지 본다. 다른 실패 — 이미지
// 부재나 런타임 거부 — 까지 삼키면 도구가 뜨지 않는 이유를 알 수 없게 된다.
func nameTaken(out string) bool {
	return strings.Contains(strings.ToLower(out), "is already in use")
}

// ExecSpec 은 대응 컨테이너 안에 도구를 띄우는 명세다 (FR-SBX-12).
//
// `-it` 가 핵심이다. 그것이 있어야 docker 가 이 PTY 의 크기 변경(SIGWINCH)을
// 컨테이너 안 프로세스까지 전달한다 — 없으면 터미널이 80x24 에 고정된다.
//
// TERM 을 실어 보내는 것도 같은 이유다 — docker 는 호스트의 TERM 을 컨테이너로
// 전파하지 않아서, 넘기지 않으면 컨테이너 안이 dumb 터미널이 되어 TUI 와 색이
// 깨진다. 컨테이너 이름보다 **앞에** 와야 한다. 뒤에 두면 docker 가 그것을
// 컨테이너 안에서 실행할 명령으로 읽는다.
func (m *Manager) ExecSpec(windowUUID, dockerPath string, p Profile, env ExecEnv) platform.ProcSpec {
	name := m.ContainerName(windowUUID)
	args := []string{dockerPath, "exec", "-it", "-e", "TERM=xterm-256color"}
	// 헬퍼가 있는 프로파일에만 서버 접속 정보를 심는다. scratch 에 넣으면 그
	// 안의 코드가 워크스페이스를 조작할 길이 열려 격리가 무너진다 (FR-SBX-17).
	if p.Helper {
		args = append(args,
			"-e", "DONGMINAL_HOST="+HostGateway,
			"-e", "DONGMINAL_PORT="+env.Port,
			"-e", "DONGMINAL_TOOL_ID="+env.ToolID)
	}
	// 마운트가 있을 때만 작업 디렉터리를 지정한다. 없으면 이미지의 기본 자리이며,
	// 호스트 경로를 넘기면 컨테이너 안에 없는 경로라 기동 자체가 실패한다
	// (FR-SBX-13).
	if p.Workspace {
		args = append(args, "-w", ContainerWorkdir)
	}
	args = append(args, name, "bash", "-l")
	return platform.ProcSpec{Path: dockerPath, Args: args}
}

// Remove 는 대응 컨테이너를 제거한다 (FR-SBX-8).
//
// 이미 없는 것은 오류가 아니다. 이 함수는 Window 폐기 경로에서 불리며, 거기서
// 실패를 올리면 컨테이너가 없다는 이유로 창이 닫히지 않는다.
func (m *Manager) Remove(windowUUID string) error {
	m.run([]string{"rm", "-f", m.ContainerName(windowUUID)})
	return nil
}

// ReapOrphans 는 살아 있는 Window 에 매이지 않은 대응 컨테이너를 치운다
// (FR-SBX-9). live 는 현재 workspace 에 있는 Window UUID 들이다.
//
// 조회를 자기 홈 라벨로 좁히는 것이 안전장치다. 좁히지 않으면 한 호스트에서
// 함께 도는 다른 인스턴스의 컨테이너를 고아로 오인해 지운다.
func (m *Manager) ReapOrphans(live map[string]struct{}) error {
	out, err := m.run([]string{
		"ps", "-a",
		"--filter", "label=" + LabelHome + "=" + m.home,
		"--format", "{{.Names}} {{.Label \"" + LabelWindow + "\"}}",
	})
	if err != nil {
		return fmt.Errorf("샌드박스 컨테이너를 조회하지 못했습니다: %w", err)
	}
	for _, line := range strings.Split(out, "\n") {
		name, window, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok || name == "" || window == "" {
			continue
		}
		if _, alive := live[window]; alive {
			continue
		}
		// 이름은 조회 결과의 것을 그대로 쓴다. 라벨로 찾아 놓고 이름을 다시
		// 계산하면 규칙이 두 벌이 되고, 어긋나는 순간 고아가 영영 남는다.
		m.run([]string{"rm", "-f", name})
	}
	return nil
}

// runtimeDown 은 런타임 자체에 닿지 못한 출력인지 본다. 컨테이너가 없다는
// 답("No such object")과 구별하는 것이 이 함수의 전부다.
func runtimeDown(out string) bool {
	low := strings.ToLower(out)
	return strings.Contains(low, "cannot connect") ||
		strings.Contains(low, "is the docker daemon running") ||
		strings.Contains(low, "docker daemon is not running")
}

// FindRuntime 은 컨테이너 런타임 실행 파일을 찾는다 (FR-SBX-20).
//
// look 을 주입받는 것은 런타임이 설치되지 않은 호스트에서도 이 판정을 시험할 수
// 있어야 하기 때문이다.
func FindRuntime(look func(string) (string, error)) (string, error) {
	path, err := look("docker")
	if err != nil {
		return "", fmt.Errorf("컨테이너 런타임(docker)을 찾을 수 없습니다: %w", err)
	}
	return path, nil
}

// LookPath 는 FindRuntime 의 실제 인자다.
func LookPath(name string) (string, error) { return exec.LookPath(name) }

// CLIRunner 는 실제 런타임을 부르는 runFn 이다.
//
// CombinedOutput 인 것이 중요하다 — 런타임의 진단은 대부분 stderr 로 나오며,
// 그것을 버리면 "왜 실패했는가" 가 통째로 사라진다.
func CLIRunner(dockerPath string) func(args []string) (string, error) {
	return func(args []string) (string, error) {
		out, err := exec.Command(dockerPath, args...).CombinedOutput()
		return string(out), err
	}
}

// StopOwned 는 이 홈의 대응 컨테이너를 모두 정지한다 (FR-SBX-44).
//
// **지우지 않는 것이 요점이다.** 서버가 내려가는 것은 Window 가 사라진 것과
// 다르다 — 창은 workspace 에 그대로 있고, 다음 기동에서 그 창을 열면 하던
// 자리로 돌아가야 한다. 정지는 자원만 놓고 파일시스템은 남긴다.
//
// 강제 종료(SIGKILL·크래시·전원)에는 이 자리가 실행되지 않는다. 그때 컨테이너는
// 돌던 채로 남지만, 다음 기동은 running 이든 exited 든 재사용하므로(FR-SBX-26)
// 동작에는 차이가 없다.
func (m *Manager) StopOwned() error {
	names, err := m.ownedNames()
	if err != nil {
		return err
	}
	for _, name := range names {
		m.run([]string{"stop", name})
	}
	return nil
}

// ownedNames 는 이 홈 라벨이 붙은 컨테이너 이름들이다.
func (m *Manager) ownedNames() ([]string, error) {
	out, err := m.run([]string{
		"ps", "-a",
		"--filter", "label=" + LabelHome + "=" + m.home,
		"--format", "{{.Names}}",
	})
	if err != nil {
		return nil, fmt.Errorf("샌드박스 컨테이너를 조회하지 못했습니다: %w", err)
	}
	var names []string
	for _, line := range strings.Split(out, "\n") {
		if n := strings.TrimSpace(line); n != "" {
			names = append(names, n)
		}
	}
	return names, nil
}
