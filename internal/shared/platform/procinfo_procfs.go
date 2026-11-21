package platform

import (
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// 이 파일은 linux 의 ProcInfo 어댑터다 — /proc 으로 읽는다. 이름에 `_linux` 를 붙이지
// 않는 것은 빌드 태그가 되기 때문이다: 가짜 /proc 트리로 어느 OS 에서나 시험한다
// (CROSS_PLATFORM_SRS §4.2). 연결은 platform_linux.go 가 한다.

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

// procPath 는 `path.Join` 을 쓴다 — `filepath.Join` 이 아니다 (FR-WTP-40).
//
// `/proc` 은 **리눅스 커널의 경로**이지 이 프로그램이 도는 호스트의 경로가
// 아니다. 리눅스에서는 둘이 같지만, 이 어댑터의 판정 로직은 표 기반 fake 로
// 어느 OS 에서나 검증된다(CROSS_PLATFORM_SRS §4.2) — 그 자리에서
// `filepath.Join` 은 Windows 에서 `\proc\100\...` 을 만들어 fake 의 키와
// 어긋난다. 그래서 그 보증이 Windows 에서만 조용히 사라져 있었다.
func procPath(elem ...string) string {
	return path.Join(append([]string{procRoot}, elem...)...)
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

// ChildrenOf 는 pid 마다 HasChildren 이다. /proc 을 읽을 뿐 fork 가 없다 (CWDs 와
// 같은 근거).
func (l linuxProcInfo) ChildrenOf(pids []int) map[int]bool {
	out := map[int]bool{}
	for _, pid := range dedupPositive(pids) {
		out[pid] = l.HasChildren(pid)
	}
	return out
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

// CWDs 는 pid 마다 readlink 다. **프로세스를 띄우지 않으므로 루프로 족하다** —
// 일괄의 값은 fork 를 줄이는 데 있고 여기에는 fork 가 없다.
func (l linuxProcInfo) CWDs(pids []int) map[int]string {
	out := map[int]string{}
	for _, pid := range dedupPositive(pids) {
		if cwd, ok := l.CWD(pid); ok {
			out[pid] = cwd
		}
	}
	return out
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

// Parents 는 /proc/<pid>/stat 을 훑는다. 그 사이 끝난 프로세스는 표에 없다.
func (l linuxProcInfo) Parents() (map[int]int, bool) {
	stats, err := l.glob(procPath("[0-9]*", "stat"))
	if err != nil {
		return nil, false
	}
	out := map[int]int{}
	for _, st := range stats {
		pid, err := strconv.Atoi(path.Base(path.Dir(st)))
		if err != nil {
			continue
		}
		blob, err := l.read(st)
		if err != nil {
			continue
		}
		if ppid, ok := parseStatPPID(string(blob)); ok {
			out[pid] = ppid
		}
	}
	return out, true
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
