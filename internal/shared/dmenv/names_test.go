package dmenv

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// REFACTOR3_DEDUP_GO_SRS FR-RDG-45: DONGMINAL_* 이름은 이 패키지에만 선언한다. 밖의 자리는 상수를 쓴다.
func TestEnvNamesLiveHere(t *testing.T) {
	name := regexp.MustCompile(`"DONGMINAL_[A-Z_]+[="]`)
	for _, f := range []string{
		"../serverconf/conf.go",
		"../updatecheck/checker.go",
		"../sandbox/sandbox.go",
		"../../ctl/cli/options.go",
	} {
		body, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(body), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "//") {
				continue
			}
			if name.MatchString(line) {
				t.Errorf("%s:%d: %s", f, i+1, strings.TrimSpace(line))
			}
		}
	}
}
