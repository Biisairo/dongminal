package runtimebin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// CLAUDE_ACCOUNTS_SRS TC-CAC-24 (5단계): dmctl account pin · map · unmap · maps, 전환의 고정 안내.

const mappingsFakeJSON = `{"folders":{"/repo":{"accountId":"id-a"}},"tabs":{"tool-9":{"accountId":"id-b"}}}`

func TestDmctlAccountPin(t *testing.T) {
	t.Setenv(dmenv.EnvToolID, "tool-self")
	calls, cleanup := withAccountServer(t, map[string]string{
		"GET /api/claude-accounts":          accountsFakeJSON,
		"PUT /api/claude-accounts/mappings": mappingsFakeJSON,
	})
	defer cleanup()
	if rc, _, e := dmctlRun("account", "pin", "work"); rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	last := (*calls)[len(*calls)-1]
	if last.method != "PUT" || last.body["toolId"] != "tool-self" || last.body["accountId"] != "id-a" {
		t.Fatalf("%+v", last)
	}
	if rc, _, e := dmctlRun("account", "pin", "--tab", "tool-9", "b@x.com"); rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	last = (*calls)[len(*calls)-1]
	if last.body["toolId"] != "tool-9" || last.body["accountId"] != "id-b" {
		t.Fatalf("%+v", last)
	}
	rc, out, e := dmctlRun("account", "pin", "--clear")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	last = (*calls)[len(*calls)-1]
	if last.body["toolId"] != "tool-self" || last.body["accountId"] != "" {
		t.Fatalf("%+v", last)
	}
	if !strings.Contains(out, "다음 실행부터") {
		t.Fatalf("notice missing: %q", out)
	}
}

func TestDmctlAccountPinErrors(t *testing.T) {
	t.Setenv(dmenv.EnvToolID, "")
	_, cleanup := withAccountServer(t, map[string]string{"GET /api/claude-accounts": accountsFakeJSON})
	defer cleanup()
	for _, args := range [][]string{
		{"account", "pin", "work"},                          // 자기 탭을 모른다
		{"account", "pin", "--tab", "t"},                    // 계정도 --clear 도 없다
		{"account", "pin", "--tab", "t", "nope"},            // 없는 계정
		{"account", "pin", "--clear", "--tab", "t", "work"}, // 둘 다
	} {
		if rc, _, _ := dmctlRun(args...); rc == 0 {
			t.Errorf("%v: rc 0", args)
		}
	}
}

func TestDmctlAccountMapUnmap(t *testing.T) {
	calls, cleanup := withAccountServer(t, map[string]string{
		"GET /api/claude-accounts":          accountsFakeJSON,
		"PUT /api/claude-accounts/mappings": mappingsFakeJSON,
	})
	defer cleanup()
	dir := t.TempDir()
	if rc, _, e := dmctlRun("account", "map", "work", dir); rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	last := (*calls)[len(*calls)-1]
	if last.body["folder"] != dir || last.body["accountId"] != "id-a" {
		t.Fatalf("%+v", last)
	}
	// 경로를 주지 않으면 현재 폴더, 상대 경로는 절대 경로로 바꾼다.
	wd, _ := os.Getwd()
	if rc, _, e := dmctlRun("account", "map", "work"); rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	if last = (*calls)[len(*calls)-1]; last.body["folder"] != wd {
		t.Fatalf("%+v", last)
	}
	if rc, _, e := dmctlRun("account", "unmap", "sub"); rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	last = (*calls)[len(*calls)-1]
	if last.body["folder"] != filepath.Join(wd, "sub") || last.body["accountId"] != "" {
		t.Fatalf("%+v", last)
	}
	if rc, _, _ := dmctlRun("account", "map", "nope", dir); rc == 0 {
		t.Fatal("unknown account")
	}
}

func TestDmctlAccountMaps(t *testing.T) {
	_, cleanup := withAccountServer(t, map[string]string{
		"GET /api/claude-accounts":          accountsFakeJSON,
		"GET /api/claude-accounts/mappings": `{"folders":{"/repo":{"accountId":"id-a"},"/gone":{"accountId":"id-x"}},"tabs":{"tool-9":{"accountId":"id-b"}}}`,
	})
	defer cleanup()
	rc, out, e := dmctlRun("account", "maps")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	for _, want := range []string{"/repo", "work", "tool-9", "b@x.com", "/gone", "삭제된 계정"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in %q", want, out)
		}
	}
}

// FR-CAC-36, D-CAC-28: 전환은 막지 않고 한 줄로 알린다.
func TestDmctlAccountSwitchPinnedNotice(t *testing.T) {
	_, cleanup := withAccountServer(t, map[string]string{
		"GET /api/claude-accounts":         accountsFakeJSON,
		"POST /api/claude-accounts/switch": `{"from":"id-b","to":"id-a","pinnedRunning":true}`,
	})
	defer cleanup()
	rc, out, e := dmctlRun("account", "switch", "work")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	if !strings.Contains(out, "고정 실행 중인 탭이 있습니다") {
		t.Fatalf("%q", out)
	}
}
