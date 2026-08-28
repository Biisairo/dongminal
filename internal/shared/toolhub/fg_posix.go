//go:build darwin || linux

package toolhub

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// POSIX 전용 전경 프로세스 조회 (FR-TAN-24). cross-platform 후속 트랙은 이
// 파일의 짝(fg_other.go)을 채우면 되고, 이름 규칙·캐시는 foreground.go 에
// 남으므로 다시 만들 필요가 없다 (NFR-CNV-5).
//
// 새 의존을 더하지 않는다 — TIOCGPGRP 은 표준 syscall 로 부른다 (C-2).

// foregroundName 은 도구 하나의 전경 프로세스 이름을 낸다. 전경 프로그램이
// 없거나(셸이 프롬프트에서 대기) 알아낼 수 없으면 빈 문자열이다 (FR-TAN-23).
func foregroundName(ptmx *os.File, shellPid int) string {
	return foregroundNames([]fgRequest{{PTMX: ptmx, ShellPID: shellPid}})[""]
}

// foregroundNames 는 여러 도구를 한 번에 조회한다. 이름 읽기를 한 번의 ps 로
// 묶는 것이 이 함수가 존재하는 이유다 (NFR-CNV-1).
func foregroundNames(reqs []fgRequest) map[string]string {
	type hit struct {
		id  string
		pid int
	}
	hits := make([]hit, 0, len(reqs))
	pids := make([]int, 0, len(reqs))
	for _, r := range reqs {
		if r.PTMX == nil || r.ShellPID <= 0 {
			continue
		}
		pgid, ok := fgPGID(r.PTMX)
		if !ok || pgid <= 0 {
			continue
		}
		// 전경 pgid 가 셸 자신의 pgid 면 전경 프로그램이 없는 것이다
		// (FR-TAN-6). 셸의 pgid 를 못 읽으면 추측하지 않고 건너뛴다.
		shellPgid, err := syscall.Getpgid(r.ShellPID)
		if err != nil || pgid == shellPgid {
			continue
		}
		hits = append(hits, hit{r.ID, pgid})
		pids = append(pids, pgid)
	}
	names := procNames(pids)
	out := make(map[string]string, len(hits))
	for _, h := range hits {
		if n := derivedName(names[h.pid]); n != "" {
			out[h.id] = n
		}
	}
	return out
}

// fgPGID 는 PTY 마스터의 전경 프로세스 그룹 id 를 읽는다 (tcgetpgrp).
// os.File.Fd() 는 fd 를 블로킹 모드로 되돌리므로 SyscallConn 으로 부른다 —
// readPTY 가 같은 fd 를 읽고 있다.
func fgPGID(ptmx *os.File) (int, bool) {
	rc, err := ptmx.SyscallConn()
	if err != nil {
		return 0, false
	}
	var pgrp int32
	var errno syscall.Errno
	cerr := rc.Control(func(fd uintptr) {
		_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, fd,
			uintptr(syscall.TIOCGPGRP), uintptr(unsafe.Pointer(&pgrp)))
	})
	if cerr != nil || errno != 0 {
		return 0, false
	}
	return int(pgrp), true
}

// procNames 는 pid 들의 프로세스 이름을 읽는다. Linux 는 /proc/<pid>/comm 으로
// 즉시 끝나고, 그것이 없는 플랫폼(macOS)만 ps 로 넘어간다 — 그때도 호출은
// **한 번**이다 (FR-TAN-5, NFR-CNV-1). 읽지 못한 pid 는 결과에 담기지 않는다;
// 추측하지 않는다.
func procNames(pids []int) map[int]string {
	out := make(map[int]string, len(pids))
	miss := make([]string, 0, len(pids))
	seen := make(map[int]struct{}, len(pids))
	for _, pid := range pids {
		if pid <= 0 {
			continue
		}
		if _, dup := seen[pid]; dup {
			continue
		}
		seen[pid] = struct{}{}
		if b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/comm"); err == nil {
			if n := strings.TrimSpace(string(b)); n != "" {
				out[pid] = n
				continue
			}
		}
		miss = append(miss, strconv.Itoa(pid))
	}
	if len(miss) == 0 {
		return out
	}
	// ps 는 요청한 pid 가 하나도 없으면 비정상 종료한다. 일부만 사라진 경우의
	// 부분 출력은 유효하므로 err 로 버리지 않고 나온 만큼 읽는다.
	raw, _ := exec.Command("ps", "-o", "pid=,comm=", "-p", strings.Join(miss, ",")).Output()
	for _, line := range strings.Split(string(raw), "\n") {
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
			out[pid] = name
		}
	}
	return out
}
