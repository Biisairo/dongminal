package gitapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/webserver/domain/git/query"
)

// SERVER_DRIVEN_ACTIONS_SRS K-j ⑤ (K6): 화면의 `GitHistory._digest` 와 같은 표본을 읽는다
// (`web/js/test/shared-vectors.test.mjs`). 한쪽 계산만 바뀌면 둘 중 하나가 실패한다.
func TestGitOidDigest_SharedVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "oid_digest_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vs []struct {
		Oids   []string `json:"oids"`
		Digest string   `json:"digest"`
	}
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	if len(vs) < 3 {
		t.Fatalf("표본이 %d 개뿐이다", len(vs))
	}
	for _, v := range vs {
		cs := make([]query.Commit, 0, len(v.Oids))
		for _, o := range v.Oids {
			cs = append(cs, query.Commit{Oid: o})
		}
		if got := gitOidDigest(cs); got != v.Digest {
			t.Errorf("%v: digest = %s, want %s", v.Oids, got, v.Digest)
		}
	}
}
