package claudeacct

import (
	"strings"
	"testing"
)

// TC-CAC-23: Telegram 으로 보낼 알림 글 (FR-CAC-100a·101).

func TestAlertText(t *testing.T) {
	cases := []struct {
		a    Alert
		want []string
	}{
		{Alert{Kind: AlertAutoswitch, From: "ab***@", To: "work", Trigger: TriggerProactive}, []string{"자동 전환", "ab***@", "work", "proactive"}},
		{Alert{Kind: AlertNearLimit, Name: "work", Window: "five_hour"}, []string{"한도 임박", "work", "five_hour"}},
		{Alert{Kind: AlertAllExhausted}, []string{"모든 계정"}},
		{Alert{Kind: AlertAllExhausted, ResetAvailable: true}, []string{"모든 계정", "제한 초기화"}},
		{Alert{Kind: AlertRelogin, Name: "work"}, []string{"다시 로그인", "work"}},
		{Alert{Kind: AlertLoginExpiring, Name: "work", ExpiresAt: 1_800_000_000}, []string{"로그인 만료", "work"}},
		{Alert{Kind: AlertAutoswitchStopped}, []string{"cswap"}},
	}
	for _, c := range cases {
		got := c.a.Text()
		if !strings.HasPrefix(got, "Claude 계정") {
			t.Fatalf("prefix: %q", got)
		}
		for _, w := range c.want {
			if !strings.Contains(got, w) {
				t.Fatalf("%s: %q lacks %q", c.a.Kind, got, w)
			}
		}
	}
	if (Alert{Kind: "unknown"}).Text() != "" {
		t.Fatal("unknown kind → no text")
	}
}
