package platform

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// 이 파일은 darwin 의 ProcInfo 어댑터다 — 외부 CLI(lsof·ps·pgrep)로 읽는다. 이름에
// `_darwin` 을 붙이지 않는 것은 빌드 태그가 되기 때문이다: 파서와 어댑터를 가짜
// 실행기로 어느 OS 에서나 시험한다 (CROSS_PLATFORM_SRS §4.2). 연결은 platform_darwin.go 가 한다.

// runFn 은 외부 명령 실행의 주입점이다. darwin 어댑터가 무는 자리다.
type runFn = func(name string, args ...string) ([]byte, error)

func execRun(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).Output()
}

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

// ChildrenOf 는 `ps` 를 **한 번** 띄워 모든 프로세스의 부모를 읽는다.
func (d darwinProcInfo) ChildrenOf(pids []int) map[int]bool {
	pids = dedupPositive(pids)
	out := make(map[int]bool, len(pids))
	if len(pids) == 0 {
		return out
	}
	raw, err := d.run("ps", "-A", "-o", "pid=,ppid=")
	if err != nil {
		return out
	}
	return childrenFromPairs(parsePidPpid(string(raw)), pids)
}

// Parents 는 `ps` 한 번이다.
func (d darwinProcInfo) Parents() (map[int]int, bool) {
	raw, err := d.run("ps", "-A", "-o", "pid=,ppid=")
	if err != nil {
		return nil, false
	}
	out := map[int]int{}
	for _, pp := range parsePidPpid(string(raw)) {
		out[pp[0]] = pp[1]
	}
	return out, true
}

// parsePidPpid 는 `ps -o pid=,ppid=` 의 줄들을 (pid, ppid) 쌍으로 읽는다.
func parsePidPpid(out string) [][2]int {
	var pairs [][2]int
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		if err1 == nil && err2 == nil {
			pairs = append(pairs, [2]int{pid, ppid})
		}
	}
	return pairs
}

// childrenFromPairs 는 (pid, ppid) 표에서 want 각각에 자식이 있는지 판정한다.
// 자기 자신을 부모로 적은 항목은 자식으로 세지 않는다 (windows HasChildren 과 같다).
func childrenFromPairs(pairs [][2]int, want []int) map[int]bool {
	out := make(map[int]bool, len(want))
	for _, pid := range want {
		out[pid] = false
	}
	for _, pp := range pairs {
		if _, asked := out[pp[1]]; asked && pp[0] != pp[1] {
			out[pp[1]] = true
		}
	}
	return out
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

// CWDs 는 `lsof` 를 **한 번** 띄운다. `-Fpn` 이 pid 와 이름을 필드로 내므로
// 그 둘을 짝지어 읽는다 — `p` 줄이 나오면 그 뒤의 `n` 줄이 그 pid 의 것이다.
func (d darwinProcInfo) CWDs(pids []int) map[int]string {
	pids = dedupPositive(pids)
	if len(pids) == 0 {
		return map[int]string{}
	}
	list := make([]string, len(pids))
	for i, pid := range pids {
		list[i] = strconv.Itoa(pid)
	}
	// `lsof` 는 요청한 pid 가 하나도 없으면 비정상 종료한다. 일부만 사라진 경우의
	// 부분 출력은 유효하므로 err 로 버리지 않고 나온 만큼 읽는다 (`Names` 와 같다).
	out, _ := d.run("lsof", "-a", "-p", strings.Join(list, ","), "-d", "cwd", "-Fpn")
	return parseLsofCwds(string(out))
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

// parseLsofCwds 는 `lsof -Fpn` 의 필드 출력을 pid → 경로 표로 읽는다.
//
// 필드 출력은 **줄마다 첫 글자가 종류**이고, `p` 가 프로세스를 열면 그 뒤의 줄들이
// 그 프로세스의 것이다. `-d cwd` 로 좁혔으므로 프로세스당 `n` 은 하나다.
//
// 짝이 맞지 않는 `n`(앞에 `p` 가 없다)은 버린다 — 어느 프로세스의 것인지 모르는
// 경로를 아무 pid 에나 붙이는 것이 이 함수가 낼 수 있는 가장 나쁜 답이다.
func parseLsofCwds(out string) map[int]string {
	res := map[int]string{}
	cur := 0
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case 'p':
			n, err := strconv.Atoi(strings.TrimSpace(line[1:]))
			if err != nil || n <= 0 {
				cur = 0
				continue
			}
			cur = n
		case 'n':
			if cur > 0 {
				res[cur] = strings.TrimSpace(line[1:])
			}
		}
	}
	return res
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
