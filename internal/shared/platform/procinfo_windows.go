//go:build windows

package platform

import (
	"fmt"
	"os"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

// windowsProcInfo 는 외부 프로세스를 하나도 띄우지 않는다 (FR-XPI-4).
// 프로세스 조회는 toolhelp 스냅샷 한 번, 포트 조회는 iphlpapi 표 한 번이다.
type windowsProcInfo struct{}

var (
	modIPHlpAPI             = windows.NewLazySystemDLL("iphlpapi.dll")
	procGetExtendedTCPTable = modIPHlpAPI.NewProc("GetExtendedTcpTable")
)

const (
	// TCP_TABLE_OWNER_PID_LISTENER — LISTEN 중인 소켓만 담긴 표다.
	tcpTableOwnerPIDListener = 3
	// TCP_TABLE_OWNER_PID_ALL — 접속 중인 소켓까지 담긴 표다.
	tcpTableOwnerPIDAll = 5
	afInet              = 2
	afInet6             = 23
)

// procEntry 는 스냅샷 한 줄이다.
type procEntry struct {
	pid, ppid int
	name      string
}

// processSnapshot 은 전체 프로세스 목록을 한 번에 읽는다. pid 마다 조회하지
// 않는 이유는 NFR-XP-4 다.
func processSnapshot() ([]procEntry, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, fmt.Errorf("process snapshot: %w", err)
	}
	defer windows.CloseHandle(snap)

	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	var out []procEntry
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		out = append(out, procEntry{
			pid:  int(e.ProcessID),
			ppid: int(e.ParentProcessID),
			name: windows.UTF16ToString(e.ExeFile[:]),
		})
	}
	return out, nil
}

func (windowsProcInfo) HasChildren(pid int) bool {
	if pid <= 0 {
		return false
	}
	entries, err := processSnapshot()
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.ppid == pid && e.pid != pid {
			return true
		}
	}
	return false
}

// CWD 는 조회하지 않는다 (FR-XPI-6). 다른 프로세스의 작업 디렉터리를 읽으려면
// 그 프로세스의 PEB 를 원격으로 읽어야 하는데, 32/64비트 조합마다 배치가
// 다르고 권한도 필요하다. 도구의 cwd 는 셸 훅의 OSC 777 로 이미 들어온다 —
// 없는 것은 폴백뿐이다.
func (windowsProcInfo) CWD(int) (string, bool) { return "", false }

func (windowsProcInfo) Names(pids []int) map[int]string {
	want := map[int]struct{}{}
	for _, pid := range dedupPositive(pids) {
		want[pid] = struct{}{}
	}
	res := map[int]string{}
	if len(want) == 0 {
		return res
	}
	entries, err := processSnapshot()
	if err != nil {
		return res
	}
	for _, e := range entries {
		if _, ok := want[e.pid]; ok && e.name != "" {
			res[e.pid] = e.name
		}
	}
	return res
}

func (windowsProcInfo) ListenerPIDs(port string) []int {
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return nil
	}
	return dedupPositive(windowsPIDsOnLocalPort(uint16(n), tcpTableOwnerPIDListener))
}

func (windowsProcInfo) ParentPID(pid int) (int, bool) {
	if pid <= 0 {
		return 0, false
	}
	entries, err := processSnapshot()
	if err != nil {
		return 0, false
	}
	for _, e := range entries {
		if e.pid == pid && e.ppid > 0 {
			return e.ppid, true
		}
	}
	return 0, false
}

func (windowsProcInfo) ConnectionOwnerPID(remoteAddr string) (int, bool) {
	port, ok := remotePort(remoteAddr)
	if !ok {
		return 0, false
	}
	// 클라이언트 소켓은 접속 중이므로 LISTENER 표에 없다. 전체 표를 본다.
	return firstForeignPID(windowsPIDsOnLocalPort(port, tcpTableOwnerPIDAll), os.Getpid())
}

// windowsPIDsOnLocalPort 는 그 로컬 포트를 가진 소켓의 주인들이다. v4·v6 를
// 모두 훑는다 — 어느 쪽으로 붙었는지는 알 수 없다.
func windowsPIDsOnLocalPort(port uint16, class uintptr) []int {
	var pids []int
	if buf, err := extendedTCPTable(afInet, class); err == nil {
		pids = append(pids, parseTCPTableV4(buf, port)...)
	}
	if buf, err := extendedTCPTable(afInet6, class); err == nil {
		pids = append(pids, parseTCPTableV6(buf, port)...)
	}
	return pids
}

// extendedTCPTable 은 표를 통째로 받아온다. 크기를 먼저 묻고(첫 호출은 반드시
// 버퍼 부족으로 실패한다) 그 크기로 다시 부르는 것이 이 API 의 규약이다.
func extendedTCPTable(family uint32, class uintptr) ([]byte, error) {
	var size uint32
	_, _, _ = procGetExtendedTCPTable.Call(0, uintptr(unsafe.Pointer(&size)), 0,
		uintptr(family), class, 0)
	if size == 0 {
		return nil, fmt.Errorf("tcp table: 크기를 얻지 못했다")
	}
	buf := make([]byte, size)
	ret, _, _ := procGetExtendedTCPTable.Call(uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&size)), 0,
		uintptr(family), class, 0)
	if ret != 0 {
		return nil, fmt.Errorf("tcp table: %w", windows.Errno(ret))
	}
	return buf, nil
}
