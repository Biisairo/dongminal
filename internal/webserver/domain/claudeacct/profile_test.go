package claudeacct

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// TC-CAC-19: 프로필 준비, 토큰 회수, 고정 실행 판정, 자동 전환 후보 제외, pinnedRunning.

func readJSONMap(t *testing.T, path string) map[string]json.RawMessage {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestPrepareProfileCredentials(t *testing.T) {
	e := twoAccounts(t)
	dir, _, err := e.svc.PrepareProfile("id1")
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(e.data, "profiles", "id1") {
		t.Fatalf("dir %q", dir)
	}
	if st, err := os.Stat(dir); err != nil || st.Mode().Perm() != dirMode {
		t.Fatalf("profile dir mode %v %v", st, err)
	}
	pl := e.svc.ProfileLive("id1")
	c, ok, err := pl.Read()
	if err != nil || !ok || c.AccessToken() != "at-a" {
		t.Fatalf("profile cred %v %v %q", ok, err, c.AccessToken())
	}
	if pl.Paths.KeychainService != keychainServiceBase+"-"+profileHash(dir) {
		t.Fatalf("keychain service %q", pl.Paths.KeychainService)
	}
	// 프로필 쪽이 더 새것이면 덮지 않는다.
	newer := `{"claudeAiOauth":{"accessToken":"at-a2","refreshToken":"rt-a2","expiresAt":1900000000000}}`
	nc, _ := ParseCredential([]byte(newer))
	if err := pl.Write(nc); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.PrepareProfile("id1"); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := pl.Read(); c.AccessToken() != "at-a2" {
		t.Fatalf("newer profile overwritten: %q", c.AccessToken())
	}
	// 더 새 프로필 토큰은 그때 백업으로 회수됐다(FR-CAC-86). 프로필 쪽이 낡았으면 백업으로 덮는다.
	if b, _, _ := e.svc.Backup.Read("id1"); b.AccessToken() != "at-a2" {
		t.Fatalf("reclaimed on prepare: %q", b.AccessToken())
	}
	older := `{"claudeAiOauth":{"accessToken":"old","refreshToken":"old","expiresAt":1}}`
	oc, _ := ParseCredential([]byte(older))
	_ = pl.Write(oc)
	if _, _, err := e.svc.PrepareProfile("id1"); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := pl.Read(); c.AccessToken() != "at-a2" {
		t.Fatalf("stale profile kept: %q", c.AccessToken())
	}
	if _, _, err := e.svc.PrepareProfile("nope"); err == nil {
		t.Fatal("unknown account")
	}
}

// FR-CAC-82, D-CAC-26: 기본 설정에서 계정 항목만 빼고 가져온다.
func TestPrepareProfileClaudeJSON(t *testing.T) {
	e := twoAccounts(t)
	def := `{"theme":"dark","mcpServers":{"m":{"command":"x"}},"projects":{"/p":{"hasTrustDialogAccepted":true}},` +
		`"oauthAccount":{"emailAddress":"b@x.com"},"userID":"u-default","s1Cache":{"a":1},"cachedGrowthBookFeatures":{},` +
		`"claudeCodeFirstTokenDate":"d","passesLastSeenRemaining":3,"penguinModeOrgEnabled":true,"managedSettingsNoticeSeenOrg":"o"}`
	if err := os.WriteFile(e.paths.GlobalConfig, []byte(def), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := e.svc.ProfileDir("id1")
	if err := os.MkdirAll(dir, dirMode); err != nil {
		t.Fatal(err)
	}
	prev := `{"userID":"u-profile","s1Cache":{"p":1},"theme":"light","localOnly":1}`
	if err := os.WriteFile(filepath.Join(dir, globalConfigName), []byte(prev), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.PrepareProfile("id1"); err != nil {
		t.Fatal(err)
	}
	m := readJSONMap(t, filepath.Join(dir, globalConfigName))
	for k, want := range map[string]string{
		"theme":                  `"dark"`,
		"userID":                 `"u-profile"`,
		"s1Cache":                `{"p":1}`,
		"localOnly":              `1`,
		"hasCompletedOnboarding": `true`,
	} {
		if string(m[k]) != want {
			t.Errorf("%s = %s, want %s", k, m[k], want)
		}
	}
	for _, k := range []string{"mcpServers", "projects"} {
		if _, ok := m[k]; !ok {
			t.Errorf("%s not copied", k)
		}
	}
	for _, k := range []string{"cachedGrowthBookFeatures", "claudeCodeFirstTokenDate", "passesLastSeenRemaining", "penguinModeOrgEnabled", "managedSettingsNoticeSeenOrg"} {
		if _, ok := m[k]; ok {
			t.Errorf("account key %s copied", k)
		}
	}
	oa, ok, err := ReadOAuthAccount(filepath.Join(dir, globalConfigName))
	if err != nil || !ok || oa.EmailAddress != "a@x.com" {
		t.Fatalf("oauthAccount %+v %v %v", oa, ok, err)
	}
	if st, _ := os.Stat(filepath.Join(dir, globalConfigName)); st.Mode().Perm() != fileMode {
		t.Fatalf("mode %v", st.Mode())
	}
	// 기본 설정을 읽지 못하면 계정 항목만 맞춘다.
	if err := os.WriteFile(e.paths.GlobalConfig, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.PrepareProfile("id1"); err != nil {
		t.Fatal(err)
	}
	m = readJSONMap(t, filepath.Join(dir, globalConfigName))
	if string(m["theme"]) != `"dark"` || string(m["localOnly"]) != `1` {
		t.Fatalf("kept: %v", m)
	}
}

func TestPrepareProfileLinksSharedItems(t *testing.T) {
	e := twoAccounts(t)
	ch := e.paths.ConfigHome
	if err := os.MkdirAll(filepath.Join(ch, "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ch, "settings.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := e.svc.ProfileDir("id1")
	if err := os.MkdirAll(dir, dirMode); err != nil {
		t.Fatal(err)
	}
	// 다른 곳을 가리키는 링크는 고친다.
	if err := os.Symlink(t.TempDir(), filepath.Join(dir, "skills")); err != nil {
		t.Skip("symlink 를 만들 수 없다")
	}
	_, warn, err := e.svc.PrepareProfile("id1")
	if err != nil {
		t.Fatal(err)
	}
	if len(warn) != 0 {
		t.Fatalf("warnings %v", warn)
	}
	for _, name := range []string{"skills", "settings.json"} {
		got, err := os.Readlink(filepath.Join(dir, name))
		if err != nil || got != filepath.Join(ch, name) {
			t.Errorf("%s → %q %v", name, got, err)
		}
	}
	// 원본이 없는 항목은 잇지 않는다.
	if _, err := os.Lstat(filepath.Join(dir, "commands")); !os.IsNotExist(err) {
		t.Errorf("commands linked without source: %v", err)
	}
}

// FR-CAC-82: 링크를 만들 수 없으면 파일은 복사하고 폴더는 정션, 그것도 실패하면 경고.
func TestLinkSharedFallback(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "settings.json"), []byte(`{"a":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(src, "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	noLink := func(string, string) error { return os.ErrPermission }
	junctions := 0
	l := sharedLinker{symlink: noLink, junction: func(string, string) error { junctions++; return os.ErrPermission }}
	warn := l.link(src, dst)
	if b, err := os.ReadFile(filepath.Join(dst, "settings.json")); err != nil || string(b) != `{"a":1}` {
		t.Fatalf("copy %q %v", b, err)
	}
	if junctions != 1 || len(warn) != 1 || warn[0] != "skills" {
		t.Fatalf("junction %d warn %v", junctions, warn)
	}
	// 복사본은 다음 실행 때 다시 복사한다.
	if err := os.WriteFile(filepath.Join(src, "settings.json"), []byte(`{"a":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	l.link(src, dst)
	if b, _ := os.ReadFile(filepath.Join(dst, "settings.json")); string(b) != `{"a":2}` {
		t.Fatalf("recopy %q", b)
	}
}

func writeSession(t *testing.T, dir string, pid int) {
	t.Helper()
	sd := filepath.Join(dir, "sessions")
	if err := os.MkdirAll(sd, 0o700); err != nil {
		t.Fatal(err)
	}
	body := `{"pid":` + strconv.Itoa(pid) + `,"sessionId":"s"}`
	if err := os.WriteFile(filepath.Join(sd, strconv.Itoa(pid)+".json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// FR-CAC-87.
func TestPinnedRunning(t *testing.T) {
	e := twoAccounts(t)
	e.svc.Alive = func(pid int) bool { return pid == 42 }
	if e.svc.PinnedRunning("id1") {
		t.Fatal("no profile")
	}
	dir := e.svc.ProfileDir("id1")
	writeSession(t, dir, 7)
	if e.svc.PinnedRunning("id1") {
		t.Fatal("dead pid")
	}
	writeSession(t, dir, 42)
	if !e.svc.PinnedRunning("id1") {
		t.Fatal("live pid")
	}
	if err := os.WriteFile(filepath.Join(dir, "sessions", "bad.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !e.svc.PinnedRunning("id1") {
		t.Fatal("broken file is skipped")
	}
}

// FR-CAC-86: 프로필 토큰이 더 새것이고 같은 계정이면 백업에 쓴다.
func TestReclaimProfileToken(t *testing.T) {
	e := twoAccounts(t)
	if _, _, err := e.svc.PrepareProfile("id1"); err != nil {
		t.Fatal(err)
	}
	pl := e.svc.ProfileLive("id1")
	nc, _ := ParseCredential([]byte(`{"claudeAiOauth":{"accessToken":"at-a2","refreshToken":"rt-a2","expiresAt":1900000000000}}`))
	if err := pl.Write(nc); err != nil {
		t.Fatal(err)
	}
	st, _ := e.svc.Store.Load()
	acc := st.Accounts[st.Find("id1")]
	e.svc.ReclaimProfile(acc)
	if c, _, _ := e.svc.Backup.Read("id1"); c.AccessToken() != "at-a2" {
		t.Fatalf("reclaimed %q", c.AccessToken())
	}
	// 프로필에서 다른 계정으로 로그인했으면 회수하지 않는다.
	other, _ := ParseCredential([]byte(`{"claudeAiOauth":{"accessToken":"at-x","refreshToken":"rt-x","expiresAt":1950000000000}}`))
	_ = pl.Write(other)
	cfg := filepath.Join(e.svc.ProfileDir("id1"), globalConfigName)
	if _, err := SpliceOAuthAccount(cfg, json.RawMessage(`{"emailAddress":"x@x.com","organizationUuid":"org-x"}`)); err != nil {
		t.Fatal(err)
	}
	e.svc.ReclaimProfile(acc)
	if c, _, _ := e.svc.Backup.Read("id1"); c.AccessToken() != "at-a2" {
		t.Fatalf("foreign reclaimed %q", c.AccessToken())
	}
}

// FR-CAC-36, D-CAC-28: 고정 실행 중인 활성 계정에서 전환하면 막지 않고 알린다.
func TestSwitchReportsPinnedRunning(t *testing.T) {
	e := twoAccounts(t) // 활성은 id2
	e.svc.Alive = func(pid int) bool { return pid == 42 }
	if _, _, err := e.svc.PrepareProfile("id2"); err != nil {
		t.Fatal(err)
	}
	writeSession(t, e.svc.ProfileDir("id2"), 42)
	nc, _ := ParseCredential([]byte(`{"claudeAiOauth":{"accessToken":"at-b2","refreshToken":"rt-b2","expiresAt":1900000000000}}`))
	_ = e.svc.ProfileLive("id2").Write(nc)
	res, err := e.svc.Switch(context.Background(), "id1")
	if err != nil {
		t.Fatal(err)
	}
	if !res.PinnedRunning || res.To != "id1" {
		t.Fatalf("%+v", res)
	}
	if c, _, _ := e.svc.Backup.Read("id2"); c.AccessToken() != "at-b2" {
		t.Fatalf("reclaimed before switch: %q", c.AccessToken())
	}
	res, _ = e.svc.Switch(context.Background(), "id2")
	if res.PinnedRunning {
		t.Fatal("id1 is not pinned")
	}
}

// FR-CAC-72 5, FR-CAC-87: 고정 실행 중인 계정은 자동 전환 후보가 아니다.
func TestAutoCandidatesSkipPinned(t *testing.T) {
	e, eng, _ := newEngineEnv(t) // 활성은 id2
	e.svc.Alive = func(pid int) bool { return pid == 42 }
	a := &Auto{Eng: eng, Now: e.svc.Now}
	st, _ := e.svc.Store.Load()
	if got := a.candidates(st, AutoSettings{}, nil); len(got) != 1 {
		t.Fatalf("before %d", len(got))
	}
	writeSession(t, e.svc.ProfileDir("id1"), 42)
	if got := a.candidates(st, AutoSettings{}, nil); len(got) != 0 {
		t.Fatalf("after %d", len(got))
	}
}

// FR-CAC-43 셋째 갈래: 고정 실행 중인 계정은 프로필 저장소와 백업 둘 다에 쓴다.
func TestRefreshPinnedWritesProfileAndBackup(t *testing.T) {
	e, eng, api := newEngineEnv(t) // 활성은 id2
	e.svc.Alive = func(pid int) bool { return pid == 42 }
	exp := expiredCred("at-a", "rt-a")
	c, _ := ParseCredential([]byte(exp))
	if err := e.svc.Backup.Write("id1", c); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.PrepareProfile("id1"); err != nil {
		t.Fatal(err)
	}
	writeSession(t, e.svc.ProfileDir("id1"), 42)
	api.refresh["rt-a"] = TokenResult{AccessToken: "at-a9", RefreshToken: "rt-a9", ExpiresIn: 3600}
	api.usage["at-a9"] = api.usage["at-a"]
	if err := eng.FetchNow(context.Background(), "id1"); err != nil {
		t.Fatal(err)
	}
	if b, _, _ := e.svc.Backup.Read("id1"); b.AccessToken() != "at-a9" {
		t.Fatalf("backup %q", b.AccessToken())
	}
	if p, _, _ := e.svc.ProfileLive("id1").Read(); p.AccessToken() != "at-a9" {
		t.Fatalf("profile %q", p.AccessToken())
	}
	if l := e.live(); l.AccessToken() != "at-b" {
		t.Fatalf("live touched %q", l.AccessToken())
	}
}
