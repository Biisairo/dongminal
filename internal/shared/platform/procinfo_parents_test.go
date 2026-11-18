package platform

import (
	"errors"
	"reflect"
	"testing"
)

// RUN_RECOVERY_SRS TC-RRC-3: 프로세스 목록(pid → 부모 pid)을 한 번에 읽는다. 읽지 못하면
// ok 가 거짓이다 — "목록이 비었다" 와 "모른다" 를 가른다.
func TestDarwinParents(t *testing.T) {
	calls := 0
	run := func(name string, args ...string) ([]byte, error) {
		calls++
		return []byte("  1     0\n 200   100\n garbage\n 300   200\n"), nil
	}
	got, ok := darwinProcInfo{run: run}.Parents()
	if !ok || !reflect.DeepEqual(got, map[int]int{1: 0, 200: 100, 300: 200}) || calls != 1 {
		t.Fatalf("Parents = %v %v (호출 %d)", got, ok, calls)
	}
	fail := func(string, ...string) ([]byte, error) { return nil, errors.New("ps 없음") }
	if _, ok := (darwinProcInfo{run: fail}).Parents(); ok {
		t.Fatal("ps 가 실패했는데 ok 다")
	}
}

func TestLinuxParents(t *testing.T) {
	f := fakeProc{files: map[string]string{
		"/proc/100/stat":   "100 (zsh) S 1 100 100 0",
		"/proc/101/stat":   "101 (my (odd) name) S 100 101 100 0",
		"/proc/self/stat":  "7 (x) S 1",
		"/proc/102/status": "Name: x",
	}}
	got, ok := f.info().Parents()
	if !ok || !reflect.DeepEqual(got, map[int]int{100: 1, 101: 100}) {
		t.Fatalf("Parents = %v %v", got, ok)
	}
	broken := f.info()
	broken.glob = func(string) ([]string, error) { return nil, errors.New("bad pattern") }
	if _, ok := broken.Parents(); ok {
		t.Fatal("glob 이 실패했는데 ok 다")
	}
}
