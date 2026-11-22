package ext

import (
	"strings"
	"testing"
)

// TC-ATF-22 (FR-ATF-22 / AT-EXT-3): 팩 id 는 `.new` 로 끝날 수 없다 — 조달의 옆 자리
// (`<id>.new`)와 이름이 겹치면 `X` 의 조달이 팩 `X.new` 를 지운다.
func TestParseManifest_RejectsStagingSuffixID(t *testing.T) {
	for _, id := range []string{"x.new", "vscode.new"} {
		js := strings.Replace(packJSON, `"id": "vscode-langservers-extracted"`, `"id": "`+id+`"`, 1)
		if _, err := ParseManifest([]byte(js)); err == nil {
			t.Fatalf("id=%q 가 통과했다", id)
		}
	}
	js := strings.Replace(packJSON, `"id": "vscode-langservers-extracted"`, `"id": "x.newer"`, 1)
	if _, err := ParseManifest([]byte(js)); err != nil {
		t.Fatalf("id=x.newer 가 거절됐다: %v", err)
	}
}
