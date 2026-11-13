package claudeacct

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// TC-CAC-30: 보관 목록·삭제·이름 검증 (FR-CAC-34a), 링크 경고의 기록·지움 (FR-CAC-88b).

func TestUnclaimedListAndRemove(t *testing.T) {
	e := twoAccounts(t)
	// 폴더가 없으면 빈 목록이다.
	got, err := e.svc.Unclaimed()
	if err != nil || len(got) != 0 {
		t.Fatalf("empty: %v %v", got, err)
	}
	dir := filepath.Join(e.svc.Dir, "unclaimed")
	if err := os.MkdirAll(dir, dirMode); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"100-aaaaaaaaaaaa.json", "300-bbbbbbbbbbbb.json", "200-cccccccccccc.json", "junk.txt", "1-XYZ.json"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte(`{"claudeAiOauth":{"accessToken":"sk-secret"}}`), fileMode); err != nil {
			t.Fatal(err)
		}
	}
	got, err = e.svc.Unclaimed()
	if err != nil {
		t.Fatal(err)
	}
	want := []UnclaimedEntry{
		{Name: "300-bbbbbbbbbbbb.json", At: 300, Fingerprint: "bbbbbbbbbbbb"},
		{Name: "200-cccccccccccc.json", At: 200, Fingerprint: "cccccccccccc"},
		{Name: "100-aaaaaaaaaaaa.json", At: 100, Fingerprint: "aaaaaaaaaaaa"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("list: %+v", got)
	}
	if err := e.svc.RemoveUnclaimed("200-cccccccccccc.json"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "200-cccccccccccc.json")); !os.IsNotExist(err) {
		t.Fatalf("not removed: %v", err)
	}
	// 이미 없으면 그대로 성공이다.
	if err := e.svc.RemoveUnclaimed("200-cccccccccccc.json"); err != nil {
		t.Fatalf("again: %v", err)
	}
	for _, bad := range []string{"", "junk.txt", "../accounts.json", "1-XYZ.json", "100-aaaaaaaaaaaa.json/..", "100-aaaaaaaaaaa.json"} {
		if err := e.svc.RemoveUnclaimed(bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func TestProfileWarningsRecordAndClear(t *testing.T) {
	e := twoAccounts(t)
	fail := true
	e.svc.LinkShared = func(home, dir string) []string {
		if fail {
			return []string{"skills", "settings.json"}
		}
		return nil
	}
	if _, warn, err := e.svc.PrepareProfile("id1"); err != nil || len(warn) != 2 {
		t.Fatalf("prepare: %v %v", warn, err)
	}
	if w := e.svc.ProfileWarnings("id1"); !reflect.DeepEqual(w, []string{"skills", "settings.json"}) {
		t.Fatalf("recorded: %v", w)
	}
	if w := e.svc.ProfileWarnings("id2"); len(w) != 0 {
		t.Fatalf("other account: %v", w)
	}
	// 다음 준비가 모두 이으면 지운다.
	fail = false
	if _, _, err := e.svc.PrepareProfile("id1"); err != nil {
		t.Fatal(err)
	}
	if w := e.svc.ProfileWarnings("id1"); len(w) != 0 {
		t.Fatalf("cleared: %v", w)
	}
}

func TestRemoveDropsProfileWarnings(t *testing.T) {
	e := twoAccounts(t)
	e.svc.LinkShared = func(string, string) []string { return []string{"skills"} }
	if _, _, err := e.svc.PrepareProfile("id1"); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Remove("id1"); err != nil {
		t.Fatal(err)
	}
	if w := e.svc.ProfileWarnings("id1"); len(w) != 0 {
		t.Fatalf("after remove: %v", w)
	}
}
