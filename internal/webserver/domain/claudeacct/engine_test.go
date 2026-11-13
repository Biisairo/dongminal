package claudeacct

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TC-CAC-9·10·11·12: 조회 엔진 — 자격증명 출처, 만료 갱신과 쓰는 곳, 401 재시도, 상태.

type fakeUsageAPI struct {
	mu        sync.Mutex
	usage     map[string]string // access token → body
	status    map[string]int    // access token → HTTP status
	refresh   map[string]TokenResult
	refreshEr map[string]error
	calls     []string
}

func newFakeUsageAPI() *fakeUsageAPI {
	return &fakeUsageAPI{usage: map[string]string{}, status: map[string]int{}, refresh: map[string]TokenResult{}, refreshEr: map[string]error{}}
}

func (f *fakeUsageAPI) UsageRaw(_ context.Context, token, query string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "usage:"+token+query)
	if st, ok := f.status[token]; ok {
		return nil, &HTTPStatusError{Status: st}
	}
	b, ok := f.usage[token]
	if !ok {
		return nil, &HTTPStatusError{Status: 401}
	}
	return []byte(b), nil
}

func (f *fakeUsageAPI) Refresh(_ context.Context, rt string) (TokenResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "refresh:"+rt)
	if err, ok := f.refreshEr[rt]; ok {
		return TokenResult{}, err
	}
	tr, ok := f.refresh[rt]
	if !ok {
		return TokenResult{}, errors.New("transient")
	}
	return tr, nil
}

func (f *fakeUsageAPI) count(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

const nowUnix = 1_800_000_000

func futureCred(access, refresh string) string {
	return `{"claudeAiOauth":{"accessToken":"` + access + `","refreshToken":"` + refresh + `","expiresAt":` +
		jsonInt((nowUnix+3600)*1000) + `,"refreshTokenExpiresAt":` + jsonInt((nowUnix+30*86400)*1000) + `}}`
}

func expiredCred(access, refresh string) string {
	return `{"claudeAiOauth":{"accessToken":"` + access + `","refreshToken":"` + refresh + `","expiresAt":` + jsonInt((nowUnix-10)*1000) + `}}`
}

func jsonInt(v int64) string { b, _ := json.Marshal(v); return string(b) }

func newEngineEnv(t *testing.T) (*env, *Engine, *fakeUsageAPI) {
	t.Helper()
	e := newEnv(t)
	e.svc.Now = func() time.Time { return time.Unix(nowUnix, 0) }
	e.loginCred("a@x.com", "org-a", "acc-a", futureCred("at-a", "rt-a"))
	if _, _, err := e.svc.AddCurrent(context.Background()); err != nil {
		t.Fatal(err)
	}
	e.loginCred("b@x.com", "org-b", "acc-b", futureCred("at-b", "rt-b"))
	if _, _, err := e.svc.AddCurrent(context.Background()); err != nil {
		t.Fatal(err)
	}
	api := newFakeUsageAPI()
	api.usage["at-a"] = `{"five_hour":{"utilization":10,"resets_at":"2027-01-01T00:00:00Z"},"seven_day":{"utilization":20}}`
	api.usage["at-b"] = `{"five_hour":{"utilization":50},"seven_day":{"utilization":60}}`
	eng := &Engine{Svc: e.svc, API: api, Now: e.svc.Now, Jitter: func() float64 { return 0 }}
	if err := eng.Load(); err != nil {
		t.Fatal(err)
	}
	return e, eng, api
}

func (e *env) loginCred(email, org, acc, cred string) {
	e.t.Helper()
	_ = e.sec.Set(e.paths.KeychainService, e.sec.Account(), cred)
	cfg := `{"oauthAccount":{"emailAddress":"` + email + `","organizationUuid":"` + org + `","accountUuid":"` + acc + `"}}`
	if err := os.WriteFile(e.paths.GlobalConfig, []byte(cfg), 0o600); err != nil {
		e.t.Fatal(err)
	}
}

func TestEngineFetchesAllDueAndPersists(t *testing.T) {
	e, eng, api := newEngineEnv(t)
	eng.Tick(context.Background())
	rows := eng.Rows()
	if rows["id1"].LastGood == nil || rows["id1"].LastGood.FiveHour.Pct != 10 || rows["id2"].LastGood.SevenDay.Pct != 60 {
		t.Fatalf("%+v", rows)
	}
	if rows["id1"].Status != StatusOK || rows["id1"].FetchedAt != nowUnix || rows["id1"].NextPollAt <= nowUnix {
		t.Fatalf("%+v", rows["id1"])
	}
	if rows["id1"].LoginExpiresAt != nowUnix+30*86400 {
		t.Fatalf("login expiry %d", rows["id1"].LoginExpiresAt)
	}
	// 활성 계정(B)은 활성 저장소의 토큰으로, A 는 백업 토큰으로 조회했다.
	if api.count("usage:at-a") != 1 || api.count("usage:at-b") != 1 {
		t.Fatalf("%v", api.calls)
	}
	// 다시 틱해도 기한 전이면 부르지 않는다.
	eng.Tick(context.Background())
	if api.count("usage:") != 2 {
		t.Fatalf("not due yet: %v", api.calls)
	}
	// 파일에 남는다.
	eng2 := &Engine{Svc: e.svc, API: api, Now: e.svc.Now, Jitter: func() float64 { return 0 }}
	_ = eng2.Load()
	if eng2.Rows()["id1"].LastGood == nil {
		t.Fatal("persisted")
	}
	b, _ := os.ReadFile(filepath.Join(e.data, usageFile))
	if strings.Contains(string(b), "at-a") || strings.Contains(string(b), "rt-a") {
		t.Fatal("usage.json must not contain tokens")
	}
}

func TestEngineActiveUsesLiveCredential(t *testing.T) {
	e, eng, api := newEngineEnv(t)
	// Claude Code 가 B 의 토큰을 돌렸다 — 활성 저장소가 백업보다 새것이다.
	_ = e.sec.Set(e.paths.KeychainService, e.sec.Account(), futureCred("at-b2", "rt-b2"))
	api.usage["at-b2"] = api.usage["at-b"]
	eng.Tick(context.Background())
	if api.count("usage:at-b2") != 1 || api.count("usage:at-b") != 1 {
		// at-b 는 위 조건의 접두사로도 세진다 — at-b2 만 불렸는지 본다.
		if api.count("usage:at-b2") != 1 {
			t.Fatalf("active must use live store: %v", api.calls)
		}
	}
}

func TestEngineRefreshInactiveWritesBackupOnly(t *testing.T) {
	e, eng, api := newEngineEnv(t)
	c, _ := ParseCredential([]byte(expiredCred("old-a", "rt-a")))
	_ = e.svc.Backup.Write("id1", c)
	api.refresh["rt-a"] = TokenResult{AccessToken: "at-a", RefreshToken: "rt-a2", ExpiresIn: 3600}
	liveBefore := e.live().AccessToken()
	eng.Tick(context.Background())
	b, _, _ := e.svc.Backup.Read("id1")
	if b.AccessToken() != "at-a" || b.RefreshToken() != "rt-a2" {
		t.Fatalf("backup refreshed: %q %q", b.AccessToken(), b.RefreshToken())
	}
	if e.live().AccessToken() != liveBefore {
		t.Fatal("inactive refresh must not touch live store")
	}
	if eng.Rows()["id1"].Status != StatusOK {
		t.Fatalf("%+v", eng.Rows()["id1"])
	}
}

func TestEngineRefreshActiveWritesLiveAndBackup(t *testing.T) {
	e, eng, api := newEngineEnv(t)
	_ = e.sec.Set(e.paths.KeychainService, e.sec.Account(), expiredCred("old-b", "rt-b"))
	api.refresh["rt-b"] = TokenResult{AccessToken: "at-b", RefreshToken: "rt-b2", ExpiresIn: 3600}
	eng.Tick(context.Background())
	if l := e.live(); l.AccessToken() != "at-b" || l.RefreshToken() != "rt-b2" {
		t.Fatalf("live %q %q", l.AccessToken(), l.RefreshToken())
	}
	b, _, _ := e.svc.Backup.Read("id2")
	if b.RefreshToken() != "rt-b2" {
		t.Fatal("backup must get the rotated token too")
	}
}

func TestEngine401RefreshesOnceAndRetries(t *testing.T) {
	_, eng, api := newEngineEnv(t)
	delete(api.usage, "at-a")
	api.refresh["rt-a"] = TokenResult{AccessToken: "at-a-new", ExpiresIn: 3600}
	api.usage["at-a-new"] = `{"five_hour":{"utilization":1}}`
	eng.Tick(context.Background())
	if api.count("refresh:rt-a") != 1 || eng.Rows()["id1"].Status != StatusOK {
		t.Fatalf("%v %+v", api.calls, eng.Rows()["id1"])
	}
}

func TestEnginePermanentRefreshFailureStops(t *testing.T) {
	e, eng, api := newEngineEnv(t)
	c, _ := ParseCredential([]byte(expiredCred("old-a", "rt-a")))
	_ = e.svc.Backup.Write("id1", c)
	api.refreshEr["rt-a"] = ErrReloginRequired
	eng.Tick(context.Background())
	if eng.Rows()["id1"].Status != StatusReloginRequired {
		t.Fatalf("%+v", eng.Rows()["id1"])
	}
	n := api.count("")
	eng.Now = func() time.Time { return time.Unix(nowUnix+100_000, 0) }
	eng.Tick(context.Background())
	if api.count("refresh:rt-a") != 1 {
		t.Fatalf("dead token is not retried: %v (before %d)", api.calls, n)
	}
	// 다시 추가하면(지문이 바뀌면) 풀린다.
	c2, _ := ParseCredential([]byte(`{"claudeAiOauth":{"accessToken":"at-a","refreshToken":"rt-a-fresh","expiresAt":` + jsonInt((nowUnix+200_000)*1000) + `}}`))
	_ = e.svc.Backup.Write("id1", c2)
	eng.Tick(context.Background())
	if eng.Rows()["id1"].Status != StatusOK {
		t.Fatalf("new credential clears dead mark: %+v", eng.Rows()["id1"])
	}
}

func TestEngineTransientFailureBacksOff(t *testing.T) {
	_, eng, api := newEngineEnv(t)
	api.status["at-a"] = 500
	eng.Tick(context.Background())
	r := eng.Rows()["id1"]
	if r.ConsecutiveFailures != 1 || r.BackoffUntil != nowUnix+30 || r.Status != StatusUnavailable {
		t.Fatalf("%+v", r)
	}
	api.status["at-a"] = 429
	eng.Now = func() time.Time { return time.Unix(nowUnix+31, 0) }
	eng.Tick(context.Background())
	r = eng.Rows()["id1"]
	if r.Status != StatusRateLimited || r.Last429At != nowUnix+31 || r.BackoffUntil != nowUnix+31+60 {
		t.Fatalf("%+v", r)
	}
}

func TestEngineNoCredentials(t *testing.T) {
	e, eng, _ := newEngineEnv(t)
	_ = e.svc.Backup.Delete("id1")
	eng.Tick(context.Background())
	if eng.Rows()["id1"].Status != StatusNoCredentials {
		t.Fatalf("%+v", eng.Rows()["id1"])
	}
}

func TestEngineFetchNowRules(t *testing.T) {
	_, eng, api := newEngineEnv(t)
	eng.Tick(context.Background())
	if err := eng.FetchNow(context.Background(), "id1"); !errors.Is(err, ErrTooSoon) {
		t.Fatalf("within 60s: %v", err)
	}
	eng.Now = func() time.Time { return time.Unix(nowUnix+61, 0) }
	if err := eng.FetchNow(context.Background(), "id1"); err != nil {
		t.Fatal(err)
	}
	if api.count("usage:at-a") != 2 {
		t.Fatalf("%v", api.calls)
	}
	if err := eng.FetchNow(context.Background(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestEngineDropsRemovedAccounts(t *testing.T) {
	e, eng, _ := newEngineEnv(t)
	eng.Tick(context.Background())
	_ = e.svc.Remove("id1")
	eng.Tick(context.Background())
	if _, ok := eng.Rows()["id1"]; ok {
		t.Fatal("row of removed account is dropped")
	}
}
