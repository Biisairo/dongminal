package claudeacct

import (
	"context"
	"errors"
	"testing"
	"time"
)

// TC-CAC-13·14 (FR-CAC-60·62·63·65): 엔진의 초기화 상태 조회와 사용.

const (
	juniperBody = `{"juniper_tide":{"eligible":true,"available":true}}`
	cedarBody   = `{"cedar_ember":{"eligible":true,"grants":[{"id":"g_1","resets_left":2,"resets_total":3,"usable_now":true,"clears":["five_hour"]}]}}`
)

func withResets(api *fakeUsageAPI) {
	api.byQuery[queryJuniper] = juniperBody
	api.byQuery[queryCedar] = cedarBody
}

// clockAt 은 엔진과 서비스의 시계를 함께 옮길 수 있는 시계다.
func clockAt(e *env, eng *Engine) func(int64) {
	now := int64(nowUnix)
	f := func() time.Time { return time.Unix(now, 0) }
	e.svc.Now, eng.Now = f, f
	return func(d int64) { now += d }
}

func TestEngineFetchesResetsEveryThirdSuccess(t *testing.T) {
	e, eng, api := newEngineEnv(t)
	withResets(api)
	advance := clockAt(e, eng)
	eng.Tick(context.Background())
	if n := api.count("status:at-a?"); n != 2 {
		t.Fatalf("첫 성공에서 두 상태를 조회한다: %v", api.calls)
	}
	rs := eng.Rows()["id1"].Resets
	if rs == nil || rs.Juniper == nil || !rs.Juniper.Available || rs.Cedar == nil || len(rs.Cedar.Grants) != 1 || rs.FetchedAt != nowUnix {
		t.Fatalf("%+v", rs)
	}
	for i, want := range []int{2, 2, 4} {
		advance(61)
		if err := eng.FetchNow(context.Background(), "id1"); err != nil {
			t.Fatal(err)
		}
		if n := api.count("status:at-a?"); n != want {
			t.Fatalf("성공 %d 번째: 상태 조회 %d, 기대 %d", i+2, n, want)
		}
	}
}

func TestEngineResetsMissingKeepsNil(t *testing.T) {
	_, eng, api := newEngineEnv(t)
	eng.Tick(context.Background())
	if api.count("status:") != 4 || eng.Rows()["id1"].Resets == nil || eng.Rows()["id1"].Resets.Juniper != nil || eng.Rows()["id1"].Resets.Cedar != nil {
		t.Fatalf("필드가 없으면 없음이다 (FR-CAC-61): %+v", eng.Rows()["id1"].Resets)
	}
}

func TestEngineFetchResetsNow(t *testing.T) {
	e, eng, api := newEngineEnv(t)
	withResets(api)
	advance := clockAt(e, eng)
	eng.Tick(context.Background())
	if err := eng.FetchResetsNow(context.Background(), "id1"); !errors.Is(err, ErrTooSoon) {
		t.Fatalf("60초 안이면 거절한다: %v", err)
	}
	advance(61)
	if err := eng.FetchResetsNow(context.Background(), "id1"); err != nil {
		t.Fatal(err)
	}
	if api.count("status:at-a?") != 4 || api.count("usage:at-a") != 1 {
		t.Fatalf("상태만 조회한다: %v", api.calls)
	}
	if eng.Rows()["id1"].Resets.FetchedAt != nowUnix+61 {
		t.Fatalf("%+v", eng.Rows()["id1"].Resets)
	}
	if err := eng.FetchResetsNow(context.Background(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestEngineClaimJuniperRefetches(t *testing.T) {
	e, eng, api := newEngineEnv(t)
	withResets(api)
	clockAt(e, eng)
	changed := 0
	eng.OnChange = func() { changed++ }
	api.claims = []fakeClaim{{body: `{"result":"reset","next_available_at":"2027-02-01T00:00:00Z"}`}}
	res, err := eng.Claim(context.Background(), "id1", ProgramJuniper, "")
	if err != nil || res.Result != "reset" || res.NextAvailableAt == 0 {
		t.Fatalf("%+v %v", res, err)
	}
	if api.count("claim:at-a:org-a") != 1 || api.claimBody[0]["program"] != ProgramJuniper || len(api.claimBody[0]) != 1 {
		t.Fatalf("백업 토큰과 계정의 조직으로 보낸다: %v %v", api.calls, api.claimBody)
	}
	if api.count("usage:at-a") != 1 || api.count("status:at-a?") != 2 || changed == 0 {
		t.Fatalf("성공하면 바로 다시 조회한다: %v", api.calls)
	}
}

func TestEngineClaimValidation(t *testing.T) {
	_, eng, api := newEngineEnv(t)
	for _, c := range []struct{ id, program, grant string }{
		{"id1", "other", ""}, {"id1", ProgramCedar, ""}, {"id1", ProgramCedar, "BAD ID"}, {"id1", ProgramJuniper, "g_1"},
	} {
		if _, err := eng.Claim(context.Background(), c.id, c.program, c.grant); !errors.Is(err, ErrInvalid) {
			t.Errorf("%+v: %v", c, err)
		}
	}
	if _, err := eng.Claim(context.Background(), "nope", ProgramJuniper, ""); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if api.count("claim:") != 0 {
		t.Fatalf("보내지 않는다: %v", api.calls)
	}
}

func TestEngineClaimUnconfirmedReusesRequestID(t *testing.T) {
	_, eng, api := newEngineEnv(t)
	api.claims = []fakeClaim{{err: errors.New("timeout")}, {body: `{"result":"reset","resets_left":1}`}, {body: `{"result":"already_used"}`}}
	ctx := context.Background()
	r1, _ := eng.Claim(ctx, "id1", ProgramCedar, "g_1")
	r2, _ := eng.Claim(ctx, "id1", ProgramCedar, "g_1")
	r3, _ := eng.Claim(ctx, "id1", ProgramCedar, "g_1")
	if r1.Result != "unconfirmed" || r2.Result != "reset" || r2.ResetsLeft == nil || *r2.ResetsLeft != 1 || r3.Result != "already_used" {
		t.Fatalf("%+v %+v %+v", r1, r2, r3)
	}
	b := api.claimBody
	if b[0]["program"] != ProgramCedar || b[0]["grant_id"] != "g_1" || b[0]["request_id"] == "" {
		t.Fatalf("%v", b[0])
	}
	if b[1]["request_id"] != b[0]["request_id"] {
		t.Fatal("확인하지 못한 요청은 같은 request_id 로 다시 보낸다")
	}
	if b[2]["request_id"] == b[1]["request_id"] {
		t.Fatal("결과를 받은 뒤에는 새 request_id 다")
	}
}

func TestEngineClaim401RefreshesOnce(t *testing.T) {
	_, eng, api := newEngineEnv(t)
	api.status["claim:at-a"] = 401
	api.refresh["rt-a"] = TokenResult{AccessToken: "at-a2", RefreshToken: "rt-a2", ExpiresIn: 3600}
	api.usage["at-a2"] = api.usage["at-a"]
	res, err := eng.Claim(context.Background(), "id1", ProgramJuniper, "")
	if err != nil || res.Result != "reset" || api.count("claim:at-a2:org-a") != 1 || api.count("refresh:rt-a") != 1 {
		t.Fatalf("%+v %v %v", res, err, api.calls)
	}
	api.status["claim:at-a2"] = 401
	api.refresh["rt-a2"] = TokenResult{AccessToken: "at-a3", RefreshToken: "rt-a3", ExpiresIn: 3600}
	api.status["claim:at-a3"] = 401
	res, _ = eng.Claim(context.Background(), "id1", ProgramJuniper, "")
	if res.Result != "auth_error" {
		t.Fatalf("두 번째 401 은 auth_error: %+v", res)
	}
}
