package edge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
)

const legacyJSON = `{"enabled":true,"port":58147,"bind":"0.0.0.0","name":"old","peers":[` +
	`{"name":"b","addr":"10.0.0.2","port":58147,"fp":"` +
	"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + `","state":""}]}`

// PEER_DAEMON_SRS FR-PDM-71 (TC-PDM-26): peers.json 만 있으면 edges.json 으로 옮긴다.
func TestMigrateLegacyConfigMoves(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, dmenv.LegacyPeersFile), []byte(legacyJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := MigrateLegacyConfig(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, dmenv.LegacyPeersFile)); !os.IsNotExist(err) {
		t.Errorf("peers.json 이 남았다: %v", err)
	}
	c := OpenStore(filepath.Join(dir, dmenv.EdgesFile), "h").Config()
	if c.Name != "old" || len(c.Edges) != 1 || c.Edges[0].Name != "b" {
		t.Errorf("옮긴 설정이 다르다: %+v", c)
	}
}

// FR-PDM-71: 둘 다 있으면 edges.json 을 쓰고 peers.json 은 그대로 둔다.
func TestMigrateLegacyConfigKeepsBoth(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, dmenv.LegacyPeersFile)
	if err := os.WriteFile(legacy, []byte(legacyJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, dmenv.EdgesFile), []byte(`{"name":"new","edges":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := MigrateLegacyConfig(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacy); err != nil {
		t.Errorf("peers.json 이 사라졌다: %v", err)
	}
	if c := OpenStore(filepath.Join(dir, dmenv.EdgesFile), "h").Config(); c.Name != "new" || len(c.Edges) != 0 {
		t.Errorf("edges.json 을 쓰지 않았다: %+v", c)
	}
}

// FR-PDM-71: 둘 다 없으면 아무 파일도 만들지 않고 빈 설정이다.
func TestMigrateLegacyConfigNone(t *testing.T) {
	dir := t.TempDir()
	if err := MigrateLegacyConfig(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, dmenv.EdgesFile)); !os.IsNotExist(err) {
		t.Errorf("edges.json 이 생겼다: %v", err)
	}
	if c := OpenStore(filepath.Join(dir, dmenv.EdgesFile), "h").Config(); len(c.Edges) != 0 {
		t.Errorf("빈 설정이 아니다: %+v", c)
	}
}

// §3.4a: json 키 edges 가 없고 peers 가 있으면 그 값을 쓰고, 저장은 edges 로만 한다.
func TestOpenStoreReadsLegacyKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), dmenv.EdgesFile)
	if err := os.WriteFile(path, []byte(legacyJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	s := OpenStore(path, "h")
	if c := s.Config(); len(c.Edges) != 1 {
		t.Fatalf("옛 키 peers 를 읽지 않았다: %+v", c)
	}
	if err := s.Save(s.Config()); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !jsonHasKey(t, raw, "edges") || jsonHasKey(t, raw, "peers") {
		t.Errorf("저장 키가 edges 하나가 아니다: %s", raw)
	}
}

func jsonHasKey(t *testing.T, raw []byte, key string) bool {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	_, ok := m[key]
	return ok
}
