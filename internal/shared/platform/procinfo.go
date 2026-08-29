package platform

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// ProcInfo 는 프로세스·포트에 대한 읽기 전용 조회다 (FR-XPI-1).
//
// 조회는 모두 실패할 수 있고, 실패는 오류가 아니라 **모름**이다. 호출자는
// 추측으로 채우지 않고 해당 기능만 비운다 (NFR-XP-6).
type ProcInfo interface {
	// HasChildren 은 pid 에 직계 자식이 있는지다. 도구 busy 판정의 근거다.
	HasChildren(pid int) bool

	// CWD 는 프로세스의 현재 작업 디렉터리다.
	CWD(pid int) (string, bool)

	// Names 는 pid 들의 프로세스 이름을 **한 번에** 읽는다. 도구마다 외부
	// 프로세스를 띄우면 도구 100개에서 갱신 주기를 넘긴다 (NFR-XP-4).
	Names(pids []int) map[int]string

	// ListenerPIDs 는 TCP 포트를 LISTEN 으로 점유한 pid 들이다. 접속만 한
	// 클라이언트는 포함하지 않는다 — 포함하면 서버를 내리는 자리에서 사용자의
	// 브라우저 탭을 함께 죽인다 (종전 cli/proc.go 주석).
	ListenerPIDs(port string) []int

	// ParentPID 는 pid 의 부모다 (FR-XPI-7).
	ParentPID(pid int) (int, bool)

	// ConnectionOwnerPID 는 이 서버에 붙은 로컬 TCP 연결의 **반대쪽 끝**을
	// 소유한 프로세스다. remoteAddr 는 "host:port" 이고, 그 port 를 로컬
	// 포트로 갖는 소켓의 주인이 곧 클라이언트다. 서버 자신은 제외한다.
	ConnectionOwnerPID(remoteAddr string) (int, bool)
}

// remotePort 는 "host:port" 에서 포트를 뽑는다.
func remotePort(remoteAddr string) (uint16, bool) {
	_, port, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return 0, false
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return 0, false
	}
	return uint16(n), true
}

// runFn 은 외부 명령 실행의 주입점이다. darwin 어댑터가 무는 자리다.
type runFn = func(name string, args ...string) ([]byte, error)

func execRun(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).Output()
}

// dedupPositive 는 0 이하와 중복을 걷어낸 pid 목록이다. 조회 대상을 줄이는
// 것이 목적이며, 원래 순서를 지킨다.
func dedupPositive(pids []int) []int {
	out := make([]int, 0, len(pids))
	seen := make(map[int]struct{}, len(pids))
	for _, pid := range pids {
		if pid <= 0 {
			continue
		}
		if _, dup := seen[pid]; dup {
			continue
		}
		seen[pid] = struct{}{}
		out = append(out, pid)
	}
	return out
}

// ── darwin ───────────────────────────────────────────

// darwinProcInfo 는 외부 CLI 로 조회한다. darwin 에는 /proc 이 없고 대체 경로는
// libproc cgo 뿐인데, cgo 를 늘리지 않는다는 기존 결정을 따른다 (FR-XPI-3,
// SYSTEM_STATS_SRS D-5). 동작은 종전과 같다.
type darwinProcInfo struct{ run runFn }

func (d darwinProcInfo) HasChildren(pid int) bool {
	if pid <= 0 {
		return false
	}
	out, err := d.run("pgrep", "-P", strconv.Itoa(pid))
	return err == nil && len(strings.TrimSpace(string(out))) > 0
}

func (d darwinProcInfo) CWD(pid int) (string, bool) {
	if pid <= 0 {
		return "", false
	}
	out, err := d.run("lsof", "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn")
	if err != nil {
		return "", false
	}
	return parseLsofCwd(string(out))
}

func (d darwinProcInfo) Names(pids []int) map[int]string {
	pids = dedupPositive(pids)
	if len(pids) == 0 {
		return map[int]string{}
	}
	list := make([]string, len(pids))
	for i, pid := range pids {
		list[i] = strconv.Itoa(pid)
	}
	// ps 는 요청한 pid 가 하나도 없으면 비정상 종료한다. 일부만 사라진 경우의
	// 부분 출력은 유효하므로 err 로 버리지 않고 나온 만큼 읽는다.
	out, _ := d.run("ps", "-o", "pid=,comm=", "-p", strings.Join(list, ","))
	return parsePsCommOutput(string(out))
}

func (d darwinProcInfo) ListenerPIDs(port string) []int {
	out, err := d.run("lsof", "-ti", ":"+port, "-sTCP:LISTEN")
	if err != nil {
		return nil
	}
	return parsePIDLines(string(out))
}

func (d darwinProcInfo) ParentPID(pid int) (int, bool) {
	if pid <= 0 {
		return 0, false
	}
	out, err := d.run("ps", "-o", "ppid=", "-p", strconv.Itoa(pid))
	if err != nil {
		return 0, false
	}
	ppid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	return ppid, err == nil && ppid > 0
}

func (d darwinProcInfo) ConnectionOwnerPID(remoteAddr string) (int, bool) {
	port, ok := remotePort(remoteAddr)
	if !ok {
		return 0, false
	}
	// 정확한 종단으로 먼저 묻고, 그것을 지원하지 않는 lsof 를 위해 포트로
	// 물러선다. 종전 clientpid.FromRemoteAddr 와 같은 순서다.
	out, err := d.run("lsof", "-i", "tcp@"+remoteAddr, "-n", "-P", "-Fp")
	if err != nil {
		out, err = d.run("lsof", "-i", "tcp:"+strconv.Itoa(int(port)), "-n", "-P", "-Fp")
		if err != nil {
			return 0, false
		}
	}
	return firstForeignPID(parseLsofPIDFields(string(out)), os.Getpid())
}

// parseLsofPIDFields 는 `lsof -Fp` 의 p 필드들을 pid 목록으로 만든다.
func parseLsofPIDFields(out string) []int {
	var pids []int
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "p") {
			continue
		}
		if n, err := strconv.Atoi(line[1:]); err == nil && n > 0 {
			pids = append(pids, n)
		}
	}
	return pids
}

// firstForeignPID 는 self 가 아닌 첫 pid 다. 서버 자신도 그 소켓의 한쪽 끝을
// 쥐고 있으므로 걸러야 한다.
func firstForeignPID(pids []int, self int) (int, bool) {
	for _, pid := range pids {
		if pid > 0 && pid != self {
			return pid, true
		}
	}
	return 0, false
}

// parseLsofCwd 는 `lsof -Fn` 의 필드 출력에서 경로를 뽑는다. 각 줄의 첫 글자가
// 필드 종류이고 'n' 이 이름이다.
func parseLsofCwd(out string) (string, bool) {
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "n") && len(line) > 1 {
			return strings.TrimSpace(line[1:]), true
		}
	}
	return "", false
}

// parsePsCommOutput 는 `ps -o pid=,comm=` 의 출력을 pid→이름 표로 만든다.
// 이름에 공백이 있을 수 있으므로 첫 공백에서만 자른다.
func parsePsCommOutput(out string) map[int]string {
	res := map[int]string{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		sp := strings.IndexByte(line, ' ')
		if sp <= 0 {
			continue
		}
		pid, err := strconv.Atoi(line[:sp])
		if err != nil {
			continue
		}
		if name := strings.TrimSpace(line[sp+1:]); name != "" {
			res[pid] = name
		}
	}
	return res
}

// parsePIDLines 는 공백으로 나뉜 숫자들을 pid 목록으로 만든다.
func parsePIDLines(out string) []int {
	var pids []int
	for _, f := range strings.Fields(out) {
		if n, err := strconv.Atoi(f); err == nil && n > 0 {
			pids = append(pids, n)
		}
	}
	return pids
}

// ── linux ────────────────────────────────────────────

// linuxProcInfo 는 전량 /proc 으로 읽는다. 외부 프로세스를 하나도 띄우지 않으며,
// 그래서 lsof·pgrep 이 없는 최소 배포판에서도 동작한다 (FR-XPI-2).
//
// 읽기 함수를 주입받는 이유는 검증이다 — 가짜 /proc 트리로 이 어댑터 전량을
// darwin 호스트에서 테스트한다 (§4.2).
type linuxProcInfo struct {
	read     func(string) ([]byte, error)
	readLink func(string) (string, error)
	glob     func(string) ([]string, error)
}

func newLinuxProcInfo() linuxProcInfo {
	return linuxProcInfo{read: os.ReadFile, readLink: os.Readlink, glob: filepath.Glob}
}

const procRoot = "/proc"

func procPath(elem ...string) string {
	return filepath.Join(append([]string{procRoot}, elem...)...)
}

// HasChildren 은 스레드마다 있는 children 목록을 훑는다. 자식은 어느 스레드가
// 낳았든 자식이므로 하나라도 비어 있지 않으면 참이다.
func (l linuxProcInfo) HasChildren(pid int) bool {
	if pid <= 0 {
		return false
	}
	tasks, err := l.glob(procPath(strconv.Itoa(pid), "task", "*", "children"))
	if err != nil {
		return false
	}
	for _, t := range tasks {
		if blob, err := l.read(t); err == nil && len(strings.Fields(string(blob))) > 0 {
			return true
		}
	}
	return false
}

func (l linuxProcInfo) CWD(pid int) (string, bool) {
	if pid <= 0 {
		return "", false
	}
	cwd, err := l.readLink(procPath(strconv.Itoa(pid), "cwd"))
	if err != nil || cwd == "" {
		return "", false
	}
	return cwd, true
}

func (l linuxProcInfo) ParentPID(pid int) (int, bool) {
	if pid <= 0 {
		return 0, false
	}
	blob, err := l.read(procPath(strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0, false
	}
	return parseStatPPID(string(blob))
}

func (l linuxProcInfo) ConnectionOwnerPID(remoteAddr string) (int, bool) {
	port, ok := remotePort(remoteAddr)
	if !ok {
		return 0, false
	}
	// 클라이언트 소켓은 그 포트를 **로컬** 포트로 갖는다. 상태는 가리지 않는다.
	return firstForeignPID(l.pidsOwningLocalPort(port, ""), os.Getpid())
}

// parseStatPPID 는 /proc/<pid>/stat 에서 부모 pid 를 뽑는다. comm 필드는 괄호로
// 싸여 있고 그 안에 공백과 괄호가 올 수 있으므로 **마지막** ')' 뒤부터 읽는다.
// 앞에서부터 세면 이름에 공백이 든 프로세스에서 어긋난다.
func parseStatPPID(content string) (int, bool) {
	i := strings.LastIndexByte(content, ')')
	if i < 0 {
		return 0, false
	}
	f := strings.Fields(content[i+1:])
	if len(f) < 2 {
		return 0, false
	}
	ppid, err := strconv.Atoi(f[1])
	return ppid, err == nil && ppid > 0
}

func (l linuxProcInfo) Names(pids []int) map[int]string {
	res := map[int]string{}
	for _, pid := range dedupPositive(pids) {
		blob, err := l.read(procPath(strconv.Itoa(pid), "comm"))
		if err != nil {
			continue
		}
		if name := strings.TrimSpace(string(blob)); name != "" {
			res[pid] = name
		}
	}
	return res
}

// ListenerPIDs 는 두 단계다. /proc/net/tcp{,6} 에서 그 포트를 LISTEN 하는 소켓의
// inode 를 모으고, /proc/*/fd/* 의 socket:[inode] 링크로 주인을 역추적한다.
// 커널이 소켓과 프로세스를 잇는 표를 따로 내주지 않아 이 우회가 필요하다.
func (l linuxProcInfo) ListenerPIDs(port string) []int {
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return nil
	}
	return l.pidsOwningLocalPort(uint16(n), tcpListenState)
}

// pidsOwningLocalPort 는 그 로컬 포트를 가진 소켓의 주인들을 찾는다. state 가
// 빈 문자열이면 상태를 가리지 않는다.
func (l linuxProcInfo) pidsOwningLocalPort(port uint16, state string) []int {
	inodes := map[string]struct{}{}
	for _, name := range []string{"tcp", "tcp6"} {
		blob, err := l.read(procPath("net", name))
		if err != nil {
			continue
		}
		for _, ino := range parseTCPInodes(string(blob), port, state) {
			inodes[ino] = struct{}{}
		}
	}
	if len(inodes) == 0 {
		return nil
	}

	fds, err := l.glob(procPath("*", "fd", "*"))
	if err != nil {
		return nil
	}
	seen := map[int]struct{}{}
	var pids []int
	for _, fd := range fds {
		target, err := l.readLink(fd)
		if err != nil {
			continue
		}
		ino, ok := socketInode(target)
		if !ok {
			continue
		}
		if _, want := inodes[ino]; !want {
			continue
		}
		pid, ok := pidFromFDPath(fd)
		if !ok {
			continue
		}
		if _, dup := seen[pid]; dup {
			continue
		}
		seen[pid] = struct{}{}
		pids = append(pids, pid)
	}
	return pids
}

// tcpListenState 는 /proc/net/tcp 의 st 열이 LISTEN 임을 나타내는 값이다.
const tcpListenState = "0A"

// parseTCPInodes 는 /proc/net/tcp{,6} 에서 로컬 포트가 port 인 줄의 inode 를
// 낸다. state 가 비어 있지 않으면 그 상태인 줄만 고른다.
//
// 주소 열은 `<16진 주소>:<16진 포트>` 이고 inode 는 열 9다. 이 두 가지를
// 틀리면 엉뚱한 프로세스를 죽인다.
func parseTCPInodes(content string, port uint16, state string) []string {
	var out []string
	for i, line := range strings.Split(content, "\n") {
		if i == 0 {
			continue // 머리글
		}
		f := strings.Fields(line)
		if len(f) < 10 {
			continue
		}
		if state != "" && f[3] != state {
			continue
		}
		colon := strings.LastIndexByte(f[1], ':')
		if colon < 0 {
			continue
		}
		p, err := strconv.ParseUint(f[1][colon+1:], 16, 16)
		if err != nil || uint16(p) != port {
			continue
		}
		out = append(out, f[9])
	}
	return out
}

// socketInode 는 `socket:[12345]` 링크 대상에서 inode 를 뽑는다.
func socketInode(target string) (string, bool) {
	const prefix = "socket:["
	if !strings.HasPrefix(target, prefix) || !strings.HasSuffix(target, "]") {
		return "", false
	}
	ino := target[len(prefix) : len(target)-1]
	if ino == "" {
		return "", false
	}
	return ino, true
}

// pidFromFDPath 는 /proc/<pid>/fd/<n> 경로에서 pid 를 뽑는다.
func pidFromFDPath(p string) (int, bool) {
	parts := strings.Split(filepath.ToSlash(p), "/")
	for i, seg := range parts {
		if seg == "proc" && i+1 < len(parts) {
			pid, err := strconv.Atoi(parts[i+1])
			return pid, err == nil && pid > 0
		}
	}
	return 0, false
}
