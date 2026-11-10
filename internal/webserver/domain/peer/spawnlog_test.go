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
