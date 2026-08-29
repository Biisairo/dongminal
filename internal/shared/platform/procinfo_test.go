package platform

import (
	"encoding/binary"
	"fmt"
	"os"
	"path"
	"reflect"
	"strings"
	"testing"
)

// ── 가짜 /proc ───────────────────────────────────────

// fakeProc 는 경로→내용/링크 표로 리눅스 어댑터 전량을 검증한다. 실제 /proc 이
// 없는 호스트에서도 이 어댑터의 판단을 전부 확인할 수 있다 (§4.2).
type fakeProc struct {
	files map[string]string
	links map[string]string
}

func (f fakeProc) info() linuxProcInfo {
	return linuxProcInfo{
		read: func(p string) ([]byte, error) {
			if s, ok := f.files[p]; ok {
				return []byte(s), nil
			}
			return nil, os.ErrNotExist
		},
		readLink: func(p string) (string, error) {
			if s, ok := f.links[p]; ok {
				return s, nil
			}
			return "", os.ErrNotExist
		},
		glob: func(pattern string) ([]string, error) {
			var out []string
			for _, set := range []map[string]string{f.files, f.links} {
				for p := range set {
					if ok, _ := path.Match(pattern, p); ok {
						out = append(out, p)
					}
				}
			}
			return out, nil
		},
	}
}

// ── 순수 파서 ────────────────────────────────────────

func TestParseLsofCwd(t *testing.T) {
	out := "p1234\nfcwd\nn/Users/dykim/personal/dongminal\n"
	got, ok := parseLsofCwd(out)
	if !ok || got != "/Users/dykim/personal/dongminal" {
		t.Fatalf("parseLsofCwd = %q, %v", got, ok)
	}
	if _, ok := parseLsofCwd("p1234\nfcwd\n"); ok {
		t.Fatal("n 필드가 없는데 성공했다")
	}
}

func TestParsePsCommOutput(t *testing.T) {
	// 이름에 공백이 있어도 첫 공백에서만 잘라야 한다 (macOS 는 실행 경로를 낸다).
	out := " 100 vim\n 200 /Applications/My App.app/Contents/MacOS/My App\nrubbish\n"
	got := parsePsCommOutput(out)
	want := map[int]string{100: "vim", 200: "/Applications/My App.app/Contents/MacOS/My App"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsePsCommOutput = %v, want %v", got, want)
	}
}

func TestParsePIDLines(t *testing.T) {
	got := parsePIDLines("111\n222\n\nxyz\n-5\n")
	if !reflect.DeepEqual(got, []int{111, 222}) {
		t.Fatalf("parsePIDLines = %v", got)
	}
}

func TestDedupPositive(t *testing.T) {
	got := dedupPositive([]int{5, 0, 5, -1, 7})
	if !reflect.DeepEqual(got, []int{5, 7}) {
		t.Fatalf("dedupPositive = %v", got)
	}
}

// /proc/net/tcp 는 포트가 16진이고 LISTEN 은 st=0A 다. 이 두 가지를 틀리면
// 엉뚱한 프로세스를 죽인다.
func TestParseTCPInodes(t *testing.T) {
	const content = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:E322 00000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 55501 1 ffff 100 0 0 10 0
   1: 0100007F:E322 0100007F:C1B2 01 00000000:00000000 00:00000000  00000000  1000        0 55502 1 ffff 100 0 0 10 0
   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 55503 1 ffff 100 0 0 10 0
`
	// 0xE322 = 58146 (기본 포트)
	if got := parseTCPInodes(content, 58146, tcpListenState); !reflect.DeepEqual(got, []string{"55501"}) {
		t.Fatalf("58146 inode = %v, want [55501] — ESTABLISHED(01) 를 함께 잡았을 수 있다", got)
	}
	// 0x1F90 = 8080
	if got := parseTCPInodes(content, 8080, tcpListenState); !reflect.DeepEqual(got, []string{"55503"}) {
		t.Fatalf("8080 inode = %v", got)
	}
	if got := parseTCPInodes(content, 9999, tcpListenState); got != nil {
		t.Fatalf("없는 포트 = %v", got)
	}
}

func TestSocketInodeAndPIDFromFD(t *testing.T) {
	if ino, ok := socketInode("socket:[55501]"); !ok || ino != "55501" {
		t.Fatalf("socketInode = %q %v", ino, ok)
	}
	if _, ok := socketInode("/dev/null"); ok {
		t.Fatal("소켓이 아닌 링크를 소켓으로 봤다")
	}
	if pid, ok := pidFromFDPath("/proc/4321/fd/7"); !ok || pid != 4321 {
		t.Fatalf("pidFromFDPath = %d %v", pid, ok)
	}
	if _, ok := pidFromFDPath("/tmp/x"); ok {
		t.Fatal("/proc 밖 경로에서 pid 를 얻었다")
	}
}

// ── 리눅스 어댑터 ────────────────────────────────────

func TestLinuxHasChildren(t *testing.T) {
	f := fakeProc{files: map[string]string{
		"/proc/100/task/100/children": "101 102\n",
		"/proc/200/task/200/children": "\n",
	}}
	li := f.info()
	if !li.HasChildren(100) {
		t.Fatal("자식이 있는데 없다고 한다")
	}
	if li.HasChildren(200) {
		t.Fatal("자식이 없는데 있다고 한다")
	}
	if li.HasChildren(999) {
		t.Fatal("없는 프로세스에 자식이 있다고 한다")
	}
}

// 자식은 어느 스레드가 낳았든 자식이다. 첫 스레드만 보면 놓친다.
func TestLinuxHasChildrenAcrossThreads(t *testing.T) {
	f := fakeProc{files: map[string]string{
		"/proc/100/task/100/children": "\n",
		"/proc/100/task/113/children": "150\n",
	}}
	if !f.info().HasChildren(100) {
		t.Fatal("두 번째 스레드의 자식을 놓쳤다")
	}
}

func TestLinuxCWDAndNames(t *testing.T) {
	f := fakeProc{
		files: map[string]string{
			"/proc/100/comm": "zsh\n",
			"/proc/101/comm": "  \n", // 공백뿐인 이름은 결과에 담지 않는다
		},
		links: map[string]string{"/proc/100/cwd": "/home/u/work"},
	}
	li := f.info()
	if cwd, ok := li.CWD(100); !ok || cwd != "/home/u/work" {
		t.Fatalf("CWD = %q %v", cwd, ok)
	}
	if _, ok := li.CWD(999); ok {
		t.Fatal("없는 프로세스의 cwd 를 얻었다")
	}
	got := li.Names([]int{100, 101, 999, 100})
	if !reflect.DeepEqual(got, map[int]string{100: "zsh"}) {
		t.Fatalf("Names = %v", got)
	}
}

// 포트 → inode → fd → pid 의 두 단계를 통째로 확인한다.
func TestLinuxListenerPIDs(t *testing.T) {
	f := fakeProc{
		files: map[string]string{
			// 열 배치는 실제 /proc/net/tcp 그대로여야 한다 — inode 는 열 9다.
			"/proc/net/tcp": "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
				"   0: 0100007F:E322 00000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 55501 1 ffff\n",
			"/proc/net/tcp6": "sl local rem st q q tr tm re uid to inode\n",
		},
		links: map[string]string{
			"/proc/4321/fd/7":  "socket:[55501]",
			"/proc/4321/fd/8":  "socket:[55501]", // 같은 pid 는 한 번만
			"/proc/9999/fd/3":  "socket:[70000]", // 다른 소켓
			"/proc/9999/fd/4":  "/dev/null",
			"/proc/1/task/1/x": "noise",
		},
	}
	got := f.info().ListenerPIDs("58146")
	if !reflect.DeepEqual(got, []int{4321}) {
		t.Fatalf("ListenerPIDs = %v, want [4321]", got)
	}
	if got := f.info().ListenerPIDs("1"); got != nil {
		t.Fatalf("점유되지 않은 포트 = %v", got)
	}
	if got := f.info().ListenerPIDs("포트아님"); got != nil {
		t.Fatalf("잘못된 포트 문자열 = %v", got)
	}
}

// ── darwin 어댑터 ────────────────────────────────────

func TestDarwinProcInfo(t *testing.T) {
	var calls []string
	run := func(name string, args ...string) ([]byte, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		switch name {
		case "pgrep":
			return []byte("501\n"), nil
		case "lsof":
			if len(args) > 0 && args[0] == "-ti" {
				return []byte("39009\n"), nil
			}
			return []byte("p100\nfcwd\nn/tmp/work\n"), nil
		case "ps":
			return []byte(" 100 zsh\n"), nil
		}
		return nil, os.ErrNotExist
	}
	d := darwinProcInfo{run: run}
	if !d.HasChildren(100) {
		t.Fatal("HasChildren")
	}
	if cwd, ok := d.CWD(100); !ok || cwd != "/tmp/work" {
		t.Fatalf("CWD = %q %v", cwd, ok)
	}
	if got := d.Names([]int{100}); !reflect.DeepEqual(got, map[int]string{100: "zsh"}) {
		t.Fatalf("Names = %v", got)
	}
	if got := d.ListenerPIDs("58146"); !reflect.DeepEqual(got, []int{39009}) {
		t.Fatalf("ListenerPIDs = %v", got)
	}
}

// pid 100개를 물어도 ps 는 한 번만 떠야 한다 (NFR-XP-4).
func TestDarwinNamesIsSingleCall(t *testing.T) {
	calls := 0
	run := func(string, ...string) ([]byte, error) { calls++; return []byte(""), nil }
	pids := make([]int, 100)
	for i := range pids {
		pids[i] = i + 1
	}
	darwinProcInfo{run: run}.Names(pids)
	if calls != 1 {
		t.Fatalf("ps 호출 = %d회, want 1", calls)
	}
}

// pid 가 하나도 없으면 외부 명령을 아예 띄우지 않는다.
func TestDarwinNamesSkipsEmpty(t *testing.T) {
	calls := 0
	run := func(string, ...string) ([]byte, error) { calls++; return nil, nil }
	darwinProcInfo{run: run}.Names([]int{0, -1})
	if calls != 0 {
		t.Fatalf("빈 목록에 명령을 띄웠다 (%d회)", calls)
	}
}

// ── Windows TCP 표 파서 ──────────────────────────────

// buildTCPTable 은 GetExtendedTcpTable 이 채우는 버퍼를 흉내낸다.
func buildTCPTable(rowSize, portOff, pidOff int, rows [][2]uint32) []byte {
	buf := make([]byte, tcpTableHeaderSize+len(rows)*rowSize)
	binary.LittleEndian.PutUint32(buf, uint32(len(rows)))
	for i, r := range rows {
		off := tcpTableHeaderSize + i*rowSize
		// 포트는 하위 2바이트에 네트워크 바이트 순서로 들어간다.
		binary.LittleEndian.PutUint32(buf[off+portOff:], uint32(netPort(r[0])))
		binary.LittleEndian.PutUint32(buf[off+pidOff:], r[1])
	}
	return buf
}

func TestNetPortSwapsBytes(t *testing.T) {
	// 58146 = 0xE322 → 네트워크 순서로 실리면 0x22E3 로 읽힌다. 되돌려야 한다.
	if got := netPort(0x22E3); got != 58146 {
		t.Fatalf("netPort = %d, want 58146", got)
	}
}

func TestParseTCPTableV4(t *testing.T) {
	buf := buildTCPTable(tcpRowV4Size, tcpV4PortOff, tcpV4PIDOff,
		[][2]uint32{{58146, 4321}, {8080, 999}, {58146, 4321}})
	if got := parseTCPTableV4(buf, 58146); !reflect.DeepEqual(got, []int{4321}) {
		t.Fatalf("v4 = %v, want [4321]", got)
	}
	if got := parseTCPTableV4(buf, 8080); !reflect.DeepEqual(got, []int{999}) {
		t.Fatalf("v4 8080 = %v", got)
	}
	if got := parseTCPTableV4(buf, 1); got != nil {
		t.Fatalf("없는 포트 = %v", got)
	}
}

func TestParseTCPTableV6(t *testing.T) {
	buf := buildTCPTable(tcpRowV6Size, tcpV6PortOff, tcpV6PIDOff,
		[][2]uint32{{58146, 777}})
	if got := parseTCPTableV6(buf, 58146); !reflect.DeepEqual(got, []int{777}) {
		t.Fatalf("v6 = %v, want [777]", got)
	}
}

// 항목 수가 실제 버퍼보다 크다고 적혀 있어도 넘겨 읽으면 안 된다.
func TestParseTCPTableTruncated(t *testing.T) {
	buf := make([]byte, tcpTableHeaderSize+tcpRowV4Size)
	binary.LittleEndian.PutUint32(buf, 99)
	if got := parseTCPTableV4(buf, 58146); got != nil {
		t.Fatalf("잘린 표에서 = %v", got)
	}
	if got := parseTCPTableV4(nil, 58146); got != nil {
		t.Fatalf("빈 버퍼에서 = %v", got)
	}
}

// ── 부모 추적 · 연결 주인 ────────────────────────────

// /proc/<pid>/stat 의 comm 은 괄호 안에 공백과 괄호를 담을 수 있다. 앞에서부터
// 열을 세면 그런 프로세스에서 부모를 잘못 읽는다.
func TestParseStatPPID(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    int
		ok      bool
	}{
		{"평범", "4321 (zsh) S 1234 4321 4321 34816 ...", 1234, true},
		{"이름에 공백", "10 (Web Content) S 7 10 10 0 ...", 7, true},
		{"이름에 괄호", "11 (a (b) c) S 9 11 11 0 ...", 9, true},
		{"쓰레기", "no parens here", 0, false},
		{"열 부족", "1 (init) S", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseStatPPID(tc.content)
			if ok != tc.ok || (tc.ok && got != tc.want) {
				t.Fatalf("parseStatPPID = %d %v, want %d %v", got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestFirstForeignPIDSkipsSelf(t *testing.T) {
	if pid, ok := firstForeignPID([]int{42, 77}, 42); !ok || pid != 77 {
		t.Fatalf("firstForeignPID = %d %v, want 77", pid, ok)
	}
	if _, ok := firstForeignPID([]int{42}, 42); ok {
		t.Fatal("자기 자신만 있는데 성공했다")
	}
}

func TestParseLsofPIDFields(t *testing.T) {
	got := parseLsofPIDFields("p1234\nf5\np5678\nrubbish\n")
	if !reflect.DeepEqual(got, []int{1234, 5678}) {
		t.Fatalf("parseLsofPIDFields = %v", got)
	}
}

func TestLinuxParentPID(t *testing.T) {
	f := fakeProc{files: map[string]string{
		"/proc/4321/stat": "4321 (zsh) S 1234 4321 4321 34816 4321 0 0",
	}}
	if ppid, ok := f.info().ParentPID(4321); !ok || ppid != 1234 {
		t.Fatalf("ParentPID = %d %v", ppid, ok)
	}
	if _, ok := f.info().ParentPID(999); ok {
		t.Fatal("없는 프로세스의 부모를 얻었다")
	}
}

// 클라이언트 소켓은 LISTEN 이 아니다 — 상태를 가리면 못 찾는다.
func TestLinuxConnectionOwnerPID(t *testing.T) {
	f := fakeProc{
		files: map[string]string{
			// 0xD431 = 54321 (클라이언트의 로컬 포트), st=01 ESTABLISHED
			"/proc/net/tcp": "  sl  local_address rem_address   st ...\n" +
				"   0: 0100007F:D431 0100007F:E322 01 00000000:00000000 00:00000000  00000000  1000        0 66601 1 ffff\n",
		},
		links: map[string]string{"/proc/7777/fd/9": "socket:[66601]"},
	}
	pid, ok := f.info().ConnectionOwnerPID("127.0.0.1:54321")
	if !ok || pid != 7777 {
		t.Fatalf("ConnectionOwnerPID = %d %v, want 7777", pid, ok)
	}
	if _, ok := f.info().ConnectionOwnerPID("주소아님"); ok {
		t.Fatal("잘못된 주소로 성공했다")
	}
}

func TestDarwinParentAndConnectionOwner(t *testing.T) {
	self := os.Getpid()
	run := func(name string, args ...string) ([]byte, error) {
		switch {
		case name == "ps":
			return []byte("  1234\n"), nil
		case name == "lsof" && len(args) > 1 && args[1] == "tcp@127.0.0.1:54321":
			return fmt.Appendf(nil, "p%d\np7777\n", self), nil
		}
		return nil, os.ErrNotExist
	}
	d := darwinProcInfo{run: run}
	if ppid, ok := d.ParentPID(4321); !ok || ppid != 1234 {
		t.Fatalf("ParentPID = %d %v", ppid, ok)
	}
	pid, ok := d.ConnectionOwnerPID("127.0.0.1:54321")
	if !ok || pid != 7777 {
		t.Fatalf("ConnectionOwnerPID = %d %v, want 7777 (자기 자신을 걸러야 한다)", pid, ok)
	}
}
