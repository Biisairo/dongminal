package claudeacct

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// TC-CAC-5·6·7·8.

type env struct {
	t     *testing.T
	home  string
	data  string
	sec   *memSecrets
	prof  *fakeProfile
	svc   *Service
	paths ClaudePaths
	n     int
}

func newEnv(t *testing.T) *env {
	t.Helper()
	home := t.TempDir()
	data := filepath.Join(t.TempDir(), "claude-accounts")
	sec := newMemSecrets()
	prof := &fakeProfile{byToken: map[string]Identity{}}
	paths := DefaultClaudePaths(home)
	e := &env{t: t, home: home, data: data, sec: sec, prof: prof, paths: paths}
	e.svc = &Service{
		Store:  OpenStore(data),
		Backup: BackupStore{Dir: data, Sec: sec},
		Live:   LiveStore{Paths: paths, Sec: sec, RetryDelay: time.Millisecond},
		Claude: paths,
		Dir:    data,
		API:    prof,
		Now:    func() time.Time { return time.Unix(1700000000, 0) },
		NewID: func() string {
			e.n++
			return "id" + strconv.Itoa(e.n)
		},
		LockTimeout: time.Second,
	}
	return e
}

// login 은 사용자가 Claude Code 에서 그 계정으로 로그인한 상태를 만든다.
func (e *env) login(email, org, acc, access, refresh string) {
	e.t.Helper()
	_ = e.sec.Set(e.paths.KeychainService, e.sec.Account(), credJSON(access, refresh, ""))
	cfg := `{"theme":"dark","oauthAccount":{"emailAddress":"` + email + `","organizationUuid":"` + org + `","accountUuid":"` + acc + `","organizationName":"` + org + `-name"}}`
	if err := os.WriteFile(e.paths.GlobalConfig, []byte(cfg), 0o600); err != nil {
		e.t.Fatal(err)
	}
	e.prof.byToken[access] = Identity{AccountUUID: acc, Email: email, OrgUUID: org}
}

func (e *env) live() Credential {
	e.t.Helper()
	c, ok, err := e.svc.Live.Read()
	if err != nil || !ok {
		e.t.Fatalf("live %v %v", ok, err)
	}
	return c
}

func (e *env) liveEmail() string {
	a, _, _ := ReadOAuthAccount(e.paths.GlobalConfig)
	return a.EmailAddress
}

func TestAddCurrentNew(t *testing.T) {
	e := newEnv(t)
	e.login("a@x.com", "org-a", "acc-a", "at-a", "rt-a")
	a, created, err := e.svc.AddCurrent(context.Background())
	if err != nil || !created {
		t.Fatal(err, created)
	}
	if a.ID != "id1" || a.Email != "a@x.com" || a.OrgUUID != "org-a" || a.AccountUUID != "acc-a" || a.OrgName != "org-a-name" || a.Color != "acct-1" {
		t.Fatalf("%+v", a)
	}
	st, _ := e.svc.Store.Load()
	if st.ActiveID != "id1" {
		t.Fatal("added account becomes active")
	}
	b, ok, _ := e.svc.Backup.Read("id1")
	if !ok || b.AccessToken() != "at-a" {
		t.Fatal("backup written")
	}
	raw, err := os.ReadFile(filepath.Join(e.data, "configs", "id1.json"))
	if err != nil || !json.Valid(raw) {
		t.Fatalf("config copy %v", err)
	}
}

func TestAddCurrentExistingRefreshes(t *testing.T) {
	e := newEnv(t)
	e.login("a@x.com", "org-a", "acc-a", "at-a", "rt-a")
	_, _, _ = e.svc.AddCurrent(context.Background())
	e.login("a@x.com", "org-a", "acc-a", "at-a2", "rt-a2")
	a, created, err := e.svc.AddCurrent(context.Background())
	if err != nil || created || a.ID != "id1" {
		t.Fatal(err, created, a.ID)
	}
	st, _ := e.svc.Store.Load()
	if len(st.Accounts) != 1 {
		t.Fatal("no duplicate")
	}
	b, _, _ := e.svc.Backup.Read("id1")
	if b.AccessToken() != "at-a2" {
		t.Fatal("backup refreshed")
	}
}

func TestAddCurrentSameEmailOtherOrgIsNew(t *testing.T) {
	e := newEnv(t)
	e.login("a@x.com", "org-a", "acc-a", "at-a", "rt-a")
	_, _, _ = e.svc.AddCurrent(context.Background())
	e.login("a@x.com", "org-b", "acc-a", "at-b", "rt-b")
	_, created, _ := e.svc.AddCurrent(context.Background())
	if !created {
		t.Fatal("identity is (email, org)")
	}
}

func TestAddCurrentRejects(t *testing.T) {
	e := newEnv(t)
	if _, _, err := e.svc.AddCurrent(context.Background()); !errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("no config: %v", err)
	}
	_ = os.WriteFile(e.paths.GlobalConfig, []byte(`{"oauthAccount":{"emailAddress":"a@x.com","organizationUuid":"o"}}`), 0o600)
	if _, _, err := e.svc.AddCurrent(context.Background()); !errors.Is(err, ErrLiveEmpty) {
		t.Fatalf("no creds: %v", err)
	}
	_ = os.WriteFile(e.paths.GlobalConfig, []byte(`{"oauthAccount":{"organizationUuid":"o"}}`), 0o600)
	if _, _, err := e.svc.AddCurrent(context.Background()); !errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("no email: %v", err)
	}
}

func twoAccounts(t *testing.T) *env {
	e := newEnv(t)
	e.login("a@x.com", "org-a", "acc-a", "at-a", "rt-a")
	if _, _, err := e.svc.AddCurrent(context.Background()); err != nil {
		t.Fatal(err)
	}
	e.login("b@x.com", "org-b", "acc-b", "at-b", "rt-b")
	if _, _, err := e.svc.AddCurrent(context.Background()); err != nil {
		t.Fatal(err)
	}
	return e
}

func TestSwitchHappyPath(t *testing.T) {
	e := twoAccounts(t)
	e.prof.calls = 0
	res, err := e.svc.Switch(context.Background(), "id1")
	if err != nil {
		t.Fatal(err)
	}
	if res.From != "id2" || res.To != "id1" || res.Outgoing != OutgoingSame {
		t.Fatalf("%+v", res)
	}
	if e.live().AccessToken() != "at-a" || e.liveEmail() != "a@x.com" {
		t.Fatal("live store switched")
	}
	b, _ := os.ReadFile(e.paths.GlobalConfig)
	var m map[string]json.RawMessage
	_ = json.Unmarshal(b, &m)
	if string(m["theme"]) != `"dark"` {
		t.Fatal("other config keys kept")
	}
	st, _ := e.svc.Store.Load()
	if st.ActiveID != "id1" {
		t.Fatal("active id")
	}
	if e.prof.calls != 0 {
		t.Fatal("same bytes needs no profile lookup")
	}
}

func TestSwitchRotatedOutgoingIsBackedUp(t *testing.T) {
	e := twoAccounts(t)
	// Claude Code 가 B 의 토큰을 돌렸다.
	_ = e.sec.Set(e.paths.KeychainService, e.sec.Account(), credJSON("at-b2", "rt-b2", ""))
	e.prof.byToken["at-b2"] = Identity{AccountUUID: "acc-b", Email: "b@x.com", OrgUUID: "org-b"}
	res, err := e.svc.Switch(context.Background(), "id1")
	if err != nil || res.Outgoing != OutgoingRotated {
		t.Fatal(err, res.Outgoing)
	}
	b, _, _ := e.svc.Backup.Read("id2")
	if b.AccessToken() != "at-b2" {
		t.Fatal("rotated token must be saved to outgoing backup")
	}
}

func TestSwitchForeignOutgoingIsStashed(t *testing.T) {
	e := twoAccounts(t)
	_ = e.sec.Set(e.paths.KeychainService, e.sec.Account(), credJSON("at-z", "rt-z", ""))
	e.prof.byToken["at-z"] = Identity{AccountUUID: "acc-z", Email: "z@x.com", OrgUUID: "org-z"}
	res, err := e.svc.Switch(context.Background(), "id1")
	if err != nil || res.Outgoing != OutgoingForeign {
		t.Fatal(err, res.Outgoing)
	}
	b, _, _ := e.svc.Backup.Read("id2")
	if b.AccessToken() != "at-b" {
		t.Fatal("foreign token must not overwrite backup")
	}
	ents, _ := os.ReadDir(filepath.Join(e.data, "unclaimed"))
	if len(ents) != 1 {
		t.Fatalf("stashed %d", len(ents))
	}
	if fi, _ := ents[0].Info(); fi.Mode().Perm() != 0o600 {
		t.Fatal("stash perm")
	}
}

func TestSwitchUnresolvedOutgoingIsStashed(t *testing.T) {
	e := twoAccounts(t)
	_ = e.sec.Set(e.paths.KeychainService, e.sec.Account(), credJSON("at-q", "rt-q", ""))
	e.prof.err = errors.New("network")
	res, err := e.svc.Switch(context.Background(), "id1")
	if err != nil || res.Outgoing != OutgoingUnresolved {
		t.Fatal(err, res.Outgoing)
	}
	b, _, _ := e.svc.Backup.Read("id2")
	if b.AccessToken() != "at-b" {
		t.Fatal("unresolved must not overwrite backup")
	}
}

func TestSwitchEmptyLiveDoesNotTouchBackup(t *testing.T) {
	e := twoAccounts(t)
	_ = e.sec.Delete(e.paths.KeychainService, e.sec.Account())
	res, err := e.svc.Switch(context.Background(), "id1")
	if err != nil || res.Outgoing != OutgoingEmpty {
		t.Fatal(err, res.Outgoing)
	}
	b, _, _ := e.svc.Backup.Read("id2")
	if b.AccessToken() != "at-b" {
		t.Fatal("backup untouched")
	}
	if e.live().AccessToken() != "at-a" {
		t.Fatal("switched")
	}
}

func TestSwitchKnownOtherAccountTokenNeedsNoBackup(t *testing.T) {
	e := twoAccounts(t)
	// 활성 저장소에 A 의 토큰 그대로가 있다(바깥에서 바꿨다). 활성 기록은 B.
	_ = e.sec.Set(e.paths.KeychainService, e.sec.Account(), credJSON("at-a", "rt-a", ""))
	res, err := e.svc.Switch(context.Background(), "id1")
	if err != nil || res.Outgoing != OutgoingKnown {
		t.Fatal(err, res.Outgoing)
	}
}

func TestSwitchEmptyTargetBackupAborts(t *testing.T) {
	e := twoAccounts(t)
	_ = e.svc.Backup.Delete("id1")
	if _, err := e.svc.Switch(context.Background(), "id1"); !errors.Is(err, ErrEmptyBackup) {
		t.Fatalf("want ErrEmptyBackup, got %v", err)
	}
	if e.live().AccessToken() != "at-b" || e.liveEmail() != "b@x.com" {
		t.Fatal("nothing changed")
	}
}

func TestSwitchRollsBackOnConfigFailure(t *testing.T) {
	e := twoAccounts(t)
	_ = os.WriteFile(e.paths.GlobalConfig, []byte("{bad"), 0o600)
	if _, err := e.svc.Switch(context.Background(), "id1"); err == nil {
		t.Fatal("want error")
	}
	if e.live().AccessToken() != "at-b" {
		t.Fatal("live credential must be rolled back")
	}
	st, _ := e.svc.Store.Load()
	if st.ActiveID != "id2" {
		t.Fatal("active id unchanged")
	}
}

func TestSwitchMergesSharedFields(t *testing.T) {
	e := twoAccounts(t)
	_ = e.sec.Set(e.paths.KeychainService, e.sec.Account(), credJSON("at-b", "rt-b", `"mcpOAuth":{"m":1}`))
	if _, err := e.svc.Switch(context.Background(), "id1"); err != nil {
		t.Fatal(err)
	}
	b, _ := e.live().Marshal()
	var m map[string]json.RawMessage
	_ = json.Unmarshal(b, &m)
	if string(m["mcpOAuth"]) != `{"m":1}` {
		t.Fatalf("shared field must carry over: %s", b)
	}
}

func TestSwitchUnknownAndActive(t *testing.T) {
	e := twoAccounts(t)
	if _, err := e.svc.Switch(context.Background(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	res, err := e.svc.Switch(context.Background(), "id2")
	if err != nil || !res.NoOp {
		t.Fatal("switching to the active account is a no-op", err)
	}
}

func TestSwitchHonoursClaudeLocks(t *testing.T) {
	e := twoAccounts(t)
	e.svc.LockTimeout = 300 * time.Millisecond
	lock := e.paths.CredLockDirs()[0]
	_ = os.MkdirAll(lock, 0o700)
	defer os.Remove(lock)
	if _, err := e.svc.Switch(context.Background(), "id1"); !errors.Is(err, ErrClaudeLockTimeout) {
		t.Fatalf("held Claude Code lock must block: %v", err)
	}
	if e.live().AccessToken() != "at-b" {
		t.Fatal("unchanged")
	}
}

func TestSwitchNextSkipsDisabled(t *testing.T) {
	e := twoAccounts(t)
	e.login("c@x.com", "org-c", "acc-c", "at-c", "rt-c")
	_, _, _ = e.svc.AddCurrent(context.Background())
	// 순서 id1,id2,id3 · 활성 id3 → 다음은 id1. id1 을 제외하면 id2.
	dis := true
	if _, err := e.svc.Update("id1", Patch{Disabled: &dis}); err != nil {
		t.Fatal(err)
	}
	st, _ := e.svc.Store.Load()
	all := func(Account) bool { return true }
	if id, ok := st.nextAfter(all); !ok || id != "id2" {
		t.Fatal(ok, id)
	}
	if _, ok := st.nextAfter(func(a Account) bool { return a.ID != "id2" }); ok {
		t.Fatal("no candidate")
	}
}

func TestRemove(t *testing.T) {
	e := twoAccounts(t)
	if err := e.svc.Remove("id1"); err != nil {
		t.Fatal(err)
	}
	st, _ := e.svc.Store.Load()
	if len(st.Accounts) != 1 || st.Accounts[0].ID != "id2" {
		t.Fatalf("%+v", st)
	}
	if _, ok, _ := e.svc.Backup.Read("id1"); ok {
		t.Fatal("backup removed")
	}
	if _, err := os.Stat(filepath.Join(e.data, "configs", "id1.json")); !os.IsNotExist(err) {
		t.Fatal("config copy removed")
	}
	// 활성 계정 삭제: 활성 저장소는 건드리지 않는다.
	if err := e.svc.Remove("id2"); err != nil {
		t.Fatal(err)
	}
	if e.live().AccessToken() != "at-b" {
		t.Fatal("live untouched")
	}
	st, _ = e.svc.Store.Load()
	if st.ActiveID != "" {
		t.Fatal("active cleared")
	}
	if err := e.svc.Remove("id9"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestUpdateAndReorder(t *testing.T) {
	e := twoAccounts(t)
	alias := "work"
	a, err := e.svc.Update("id1", Patch{Alias: &alias})
	if err != nil || a.Alias != "work" {
		t.Fatal(err, a)
	}
	empty := ""
	a, _ = e.svc.Update("id1", Patch{Alias: &empty})
	if a.Alias != "" {
		t.Fatal("empty alias clears")
	}
	clear := -1.0
	thr := 80.0
	a, _ = e.svc.Update("id1", Patch{Threshold: &thr})
	if a.Threshold == nil || *a.Threshold != 80 {
		t.Fatal("threshold")
	}
	a, _ = e.svc.Update("id1", Patch{Threshold: &clear, ClearThreshold: true})
	if a.Threshold != nil {
		t.Fatal("threshold cleared")
	}
	if err := e.svc.Reorder([]string{"id2", "id1"}); err != nil {
		t.Fatal(err)
	}
	st, _ := e.svc.Store.Load()
	if st.Accounts[0].ID != "id2" {
		t.Fatal("reordered")
	}
	if err := e.svc.Reorder([]string{"id2"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("reorder must name every account exactly once")
	}
	if err := e.svc.Reorder([]string{"id2", "id2"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("duplicates")
	}
}
