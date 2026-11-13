package claudeacct

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoreUpdatePersists(t *testing.T) {
	dir := t.TempDir()
	s := OpenStore(dir)
	err := s.Update(func(st *State) error {
		st.Accounts = append(st.Accounts, Account{ID: "a", Email: "a@x.com", Color: "acct-1"})
		st.ActiveID = "a"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	st, err := OpenStore(dir).Load()
	if err != nil || st.ActiveID != "a" || len(st.Accounts) != 1 || st.SchemaVersion != schemaVersion {
		t.Fatalf("%+v %v", st, err)
	}
	fi, _ := os.Stat(filepath.Join(dir, accountsFile))
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("perm %v", fi.Mode())
	}
	di, _ := os.Stat(dir)
	if di.Mode().Perm() != 0o700 {
		t.Fatalf("dir perm %v", di.Mode())
	}
}

func TestStoreUpdateErrorKeepsFile(t *testing.T) {
	dir := t.TempDir()
	s := OpenStore(dir)
	_ = s.Update(func(st *State) error { st.ActiveID = "keep"; return nil })
	boom := errors.New("boom")
	if err := s.Update(func(st *State) error { st.ActiveID = "lost"; return boom }); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	st, _ := s.Load()
	if st.ActiveID != "keep" {
		t.Fatal("failed update must not persist")
	}
}

func TestStoreLoadEmptyAndCorrupt(t *testing.T) {
	dir := t.TempDir()
	st, err := OpenStore(dir).Load()
	if err != nil || len(st.Accounts) != 0 {
		t.Fatal("missing file is empty state")
	}
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(filepath.Join(dir, accountsFile), []byte("{bad"), 0o600)
	if _, err := OpenStore(dir).Load(); err == nil {
		t.Fatal("corrupt file must be an error, not silently empty")
	}
}

func TestValidatePatch(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	s := func(v string) *string { return &v }
	i := func(v int) *int { return &v }
	bad := []Patch{
		{Alias: s(strings.Repeat("가", 25))},
		{Threshold: f(49.9)},
		{Threshold: f(100)},
		{Priority: i(-1)},
		{Priority: i(1001)},
		{Color: s("red")},
	}
	for n, p := range bad {
		if err := p.Validate(); !errors.Is(err, ErrInvalid) {
			t.Fatalf("case %d must be invalid: %v", n, err)
		}
	}
	good := Patch{Alias: s(strings.Repeat("가", 24)), Threshold: f(99.9), Priority: i(1000), Color: s("acct-8")}
	if err := good.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (Patch{Threshold: f(50)}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestPickColor(t *testing.T) {
	used := []Account{{Color: "acct-1"}, {Color: "acct-2"}}
	if c := pickColor(used); c != "acct-3" {
		t.Fatalf("got %s", c)
	}
	var all []Account
	for _, c := range palette {
		all = append(all, Account{Color: c})
	}
	if c := pickColor(all); c != "acct-1" {
		t.Fatalf("all used → wraps: %s", c)
	}
}
