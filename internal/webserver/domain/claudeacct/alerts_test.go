package claudeacct

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TC-CAC-23: 알림 사건·억제 키·문구 (FR-CAC-100·100a·101).

func (x *autoEnv) kinds() []string {
	var out []string
	for _, a := range x.alerts {
		out = append(out, a.Kind)
	}
	return out
}

func TestDisplayName(t *testing.T) {
	if displayName(Account{Email: "abcdef@x.com"}) != "ab***@" || displayName(Account{Email: "a@x.com"}) != "a***@" {
		t.Fatal("email prefix")
	}
	if displayName(Account{Email: "abcdef@x.com", Alias: "work"}) != "work" {
		t.Fatal("alias")
	}
}

func TestAlertNearLimitOnceEvenAfterRestart(t *testing.T) {
	x := newAutoEnv(t)
	// 꺼진 자동 전환: 활성(id3 80%)이 라인 75 를 넘고 후보(id1 30, id2 50)는 히스테리시스 50 을 못 넘는다.
	x.put(t, `{"threshold":75,"hysteresisPct":50}`)
	resets := time.Unix(nowUnix+3600, 0).UTC().Format(time.RFC3339)
	x.usage(t, "id3", "at-c", `{"five_hour":{"utilization":80,"resets_at":"`+resets+`"}}`)
	x.usage(t, "id1", "at-a", `{"five_hour":{"utilization":45}}`)
	x.tick()
	if len(x.alerts) != 1 || x.alerts[0].Kind != AlertNearLimit {
		t.Fatalf("%v", x.kinds())
	}
	a := x.alerts[0]
	if a.Name != "c***@" || a.Window != "five_hour" || a.ResetsAt != nowUnix+3600 {
		t.Fatalf("%+v", a)
	}
	x.tick()
	if len(x.alerts) != 1 {
		t.Fatalf("suppressed: %v", x.kinds())
	}
	y := x.newAuto()
	if err := y.Load(); err != nil {
		t.Fatal(err)
	}
	x.auto = y
	x.tick()
	if len(x.alerts) != 1 {
		t.Fatalf("suppressed after restart: %v", x.kinds())
	}
}

func TestAlertNearLimitNotWhenCandidateExists(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"threshold":75}`) // id1(30) 이 히스테리시스 10 을 넘는다.
	x.tick()
	if len(x.alerts) != 0 {
		t.Fatalf("%v", x.kinds())
	}
}

func TestAlertAllExhaustedWithResetAvailable(t *testing.T) {
	x := newAutoEnv(t)
	for _, a := range [][2]string{{"id1", "at-a"}, {"id2", "at-b"}, {"id3", "at-c"}} {
		x.usage(t, a[0], a[1], `{"five_hour":{"utilization":100}}`)
	}
	r := x.eng.row("id2")
	r.Resets = &Resets{Juniper: &JuniperStatus{Eligible: true, Available: true}}
	x.eng.setRow("id2", r)
	x.tick()
	var got *Alert
	for i := range x.alerts {
		if x.alerts[i].Kind == AlertAllExhausted {
			got = &x.alerts[i]
		}
	}
	if got == nil || !got.ResetAvailable {
		t.Fatalf("%+v", x.alerts)
	}
	n := len(x.alerts)
	x.tick()
	if len(x.alerts) != n {
		t.Fatalf("suppressed: %v", x.kinds())
	}
}

func TestAlertAllExhaustedNeedsEveryValueKnown(t *testing.T) {
	x := newAutoEnv(t)
	x.usage(t, "id1", "at-a", `{"five_hour":{"utilization":100}}`)
	x.usage(t, "id3", "at-c", `{"five_hour":{"utilization":100}}`)
	r := x.eng.row("id2")
	r.FetchedAt = nowUnix - 3600 // id2 는 값을 모른다
	x.eng.setRow("id2", r)
	x.tick()
	for _, k := range x.kinds() {
		if k == AlertAllExhausted {
			t.Fatal("unknown account → not all exhausted")
		}
	}
}

func TestResetsUsable(t *testing.T) {
	cases := []struct {
		r    *Resets
		want bool
	}{
		{nil, false},
		{&Resets{Juniper: &JuniperStatus{Eligible: true, Available: true}}, true},
		{&Resets{Juniper: &JuniperStatus{Eligible: true}}, false},
		{&Resets{Cedar: &CedarStatus{Eligible: true, Grants: []CedarGrant{{ResetsLeft: 1, UsableNow: true}}}}, true},
		{&Resets{Cedar: &CedarStatus{Eligible: true, Grants: []CedarGrant{{ResetsLeft: 0, UsableNow: true}}}}, false},
		{&Resets{Cedar: &CedarStatus{Grants: []CedarGrant{{ResetsLeft: 1, UsableNow: true}}}}, false},
	}
	for i, c := range cases {
		if c.r.Usable() != c.want {
			t.Fatalf("case %d", i)
		}
	}
}

func TestAlertReloginOncePerFingerprint(t *testing.T) {
	x := newAutoEnv(t)
	r := x.eng.row("id1")
	r.Status, r.AuthDeadFP = StatusReloginRequired, "fp1"
	x.eng.setRow("id1", r)
	x.tick()
	x.tick()
	if len(x.alerts) != 1 || x.alerts[0].Kind != AlertRelogin || x.alerts[0].Name != "a***@" {
		t.Fatalf("%+v", x.alerts)
	}
	r.AuthDeadFP = "fp2"
	x.eng.setRow("id1", r)
	x.tick()
	if len(x.alerts) != 2 {
		t.Fatalf("new fingerprint: %v", x.kinds())
	}
}

func TestAlertLoginExpiringDaily(t *testing.T) {
	x := newAutoEnv(t)
	r := x.eng.row("id2")
	r.LoginExpiresAt = nowUnix + 6*86400
	x.eng.setRow("id2", r)
	x.tick()
	x.tick()
	if len(x.alerts) != 1 || x.alerts[0].Kind != AlertLoginExpiring || x.alerts[0].ExpiresAt != nowUnix+6*86400 {
		t.Fatalf("%+v", x.alerts)
	}
	*x.clock = x.clock.Add(24 * time.Hour)
	x.tick()
	n := 0
	for _, k := range x.kinds() {
		if k == AlertLoginExpiring {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("next day: %v", x.kinds())
	}
	r.LoginExpiresAt = nowUnix + 30*86400
	x.eng.setRow("id2", r)
	*x.clock = x.clock.Add(24 * time.Hour)
	x.tick()
	if len(x.alerts) != n {
		t.Fatalf("far expiry: %v", x.kinds())
	}
}

func TestAlertNotifiedKeysPrunedAfterEightDays(t *testing.T) {
	x := newAutoEnv(t)
	x.auto.mu.Lock()
	x.auto.file.State.Notified = map[string]int64{"old": nowUnix - 9*86400, "new": nowUnix - 86400}
	x.auto.mu.Unlock()
	x.tick()
	x.auto.mu.Lock()
	defer x.auto.mu.Unlock()
	if _, ok := x.auto.file.State.Notified["old"]; ok {
		t.Fatal("pruned")
	}
	if _, ok := x.auto.file.State.Notified["new"]; !ok {
		t.Fatal("kept")
	}
}

func TestAlertBodiesCarryNoEmailOrID(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"enabled":true,"threshold":75}`)
	r := x.eng.row("id2")
	r.Status, r.AuthDeadFP, r.LoginExpiresAt = StatusReloginRequired, "fp", nowUnix+86400
	x.eng.setRow("id2", r)
	x.tick()
	if len(x.alerts) < 2 {
		t.Fatalf("%v", x.kinds())
	}
	b, _ := json.Marshal(x.alerts)
	for _, bad := range []string{"@x.com", "id1", "id2", "id3", "at-", "rt-"} {
		if strings.Contains(string(b), bad) {
			t.Fatalf("%s in %s", bad, b)
		}
	}
}
