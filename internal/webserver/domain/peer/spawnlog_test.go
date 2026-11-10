package peer

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// FR-PNW-62: agent.spawn 으로 만든 도구는 띄운 짝의 지문과 함께 남고, 서버를 다시
// 시작해도(다시 열어도) 남는다.
func TestSpawnLogPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), dmenv.PeerSpawnsFile)
	l := OpenSpawnLog(path)
	if _, ok := l.Owner("t1"); ok {
		t.Fatal("빈 기록에 주인이 있다")
	}
	if err := l.Record("t1", fpOf("aa")); err != nil {
		t.Fatal(err)
	}
	if fp, ok := OpenSpawnLog(path).Owner("t1"); !ok || fp != fpOf("aa") {
		t.Fatalf("다시 연 기록 = %q %v", fp, ok)
	}
	if err := l.Forget("t1"); err != nil {
		t.Fatal(err)
	}
	if _, ok := OpenSpawnLog(path).Owner("t1"); ok {
		t.Fatal("지운 기록이 남았다")
	}
}

// 망가진 파일은 빈 기록으로 선다 — 서버 기동을 막지 않는다.
func TestSpawnLogCorrupt(t *testing.T) {
	path := filepath.Join(t.TempDir(), dmenv.PeerSpawnsFile)
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := OpenSpawnLog(path).Owner("t1"); ok {
		t.Fatal("망가진 파일에서 주인을 읽었다")
	}
}

// I-31: 만드는 중인 것도 센다. release 는 한 번만 효과가 있다. 죽은 기록은 셀 때 지운다.
func TestSpawnLogReserve(t *testing.T) {
	l := OpenSpawnLog(filepath.Join(t.TempDir(), "s.json"))
	alive := map[string]bool{"t1": true}
	live := func(id string) bool { return alive[id] }
	if err := l.Record("t1", "fpA"); err != nil {
		t.Fatal(err)
	}
	if err := l.Record("dead", "fpB"); err != nil {
		t.Fatal(err)
	}
	r1, ok := l.Reserve("fpA", 2, live)
	if !ok {
		t.Fatal("첫 자리")
	}
	if _, ok := l.Reserve("fpA", 2, live); ok {
		t.Fatal("기록 1 + 만드는 중 1 = 2 인데 잡혔다")
	}
	if _, ok := l.Reserve("fpB", 2, live); !ok {
		t.Fatal("다른 짝은 따로 센다")
	}
	if _, ok := l.Owner("dead"); ok {
		t.Fatal("죽은 기록이 남았다")
	}
	r1()
	r1()
	if _, ok := l.Reserve("fpA", 2, live); !ok {
		t.Fatal("release 뒤 자리가 돌아와야 한다")
	}
	if _, ok := l.Reserve("fpA", 2, live); ok {
		t.Fatal("release 를 두 번 불러 자리가 둘 늘었다")
	}
}
