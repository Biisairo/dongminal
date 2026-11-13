package claudeacct

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const oauthAcctA = `{"emailAddress":"a@x.com","organizationUuid":"org-a","accountUuid":"acc-a","organizationName":"Org A","extra":1}`

func TestReadOAuthAccount(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".claude.json")
	_ = os.WriteFile(p, []byte(`{"theme":"dark","oauthAccount":`+oauthAcctA+`}`), 0o600)
	a, ok, err := ReadOAuthAccount(p)
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	if a.EmailAddress != "a@x.com" || a.OrganizationUUID != "org-a" || a.AccountUUID != "acc-a" || a.OrganizationName != "Org A" {
		t.Fatalf("%+v", a)
	}
	if string(a.Raw) == "" {
		t.Fatal("raw kept")
	}
}

func TestReadOAuthAccountMissing(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".claude.json")
	if _, ok, err := ReadOAuthAccount(p); ok || err != nil {
		t.Fatal("missing file is (false,nil)")
	}
	_ = os.WriteFile(p, []byte(`{"theme":"dark"}`), 0o600)
	if _, ok, err := ReadOAuthAccount(p); ok || err != nil {
		t.Fatal("no oauthAccount is (false,nil)")
	}
	_ = os.WriteFile(p, []byte(`{bad`), 0o600)
	if _, _, err := ReadOAuthAccount(p); err == nil {
		t.Fatal("corrupt file is an error")
	}
}

func TestSpliceOAuthAccountOnlyChangesThatKey(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".claude.json")
	_ = os.WriteFile(p, []byte(`{"theme":"dark","projects":{"/x":{"a":1}},"oauthAccount":{"emailAddress":"old@x.com"}}`), 0o600)
	prev, err := SpliceOAuthAccount(p, json.RawMessage(oauthAcctA))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	b, _ := os.ReadFile(p)
	_ = json.Unmarshal(b, &m)
	if string(m["theme"]) != `"dark"` || string(m["projects"]) == "" {
		t.Fatalf("other keys lost: %s", b)
	}
	a, _, _ := ReadOAuthAccount(p)
	if a.EmailAddress != "a@x.com" {
		t.Fatalf("not spliced: %s", b)
	}
	if string(prev) != `{"emailAddress":"old@x.com"}` {
		t.Fatalf("prev %s", prev)
	}
	if st, _ := os.Stat(p); st.Mode().Perm() != 0o600 {
		t.Fatalf("perm %v", st.Mode())
	}
}

func TestSpliceOAuthAccountCorruptFails(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".claude.json")
	_ = os.WriteFile(p, []byte(`{bad`), 0o600)
	if _, err := SpliceOAuthAccount(p, json.RawMessage(oauthAcctA)); err == nil {
		t.Fatal("must not overwrite a file it cannot read")
	}
	b, _ := os.ReadFile(p)
	if string(b) != `{bad` {
		t.Fatal("file must be untouched")
	}
}
