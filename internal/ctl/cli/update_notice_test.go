package cli

import (
	"bytes"
	"strings"
	"testing"

	"dongminal/internal/shared/serverconf"
	"dongminal/internal/shared/updatecheck"
)

func noEnv(string) string { return "" }

// TC-UPD-11: 고지는 한 번뿐이다.
func TestUpdateNoticeShowsOnceThenNever(t *testing.T) {
	home := t.TempDir()

	var first bytes.Buffer
	announceUpdateCheck(home, noEnv, &first)
	if !strings.Contains(first.String(), "GitHub") {
		t.Errorf("무엇을 하는지 말하지 않았다:\n%s", first.String())
	}
	if !strings.Contains(first.String(), "끄려면") {
		t.Errorf("끄는 법을 말하지 않았다:\n%s", first.String())
	}

	var second bytes.Buffer
	announceUpdateCheck(home, noEnv, &second)
	if second.Len() != 0 {
		t.Errorf("두 번째에도 알렸다:\n%s", second.String())
	}
}

// 고지는 표식을 남기고, 그 표식이 곧 server.json 의 키다 (D-UPD-6).
func TestUpdateNoticeLeavesTheKey(t *testing.T) {
	home := t.TempDir()
	announceUpdateCheck(home, noEnv, &bytes.Buffer{})
	conf := serverconf.Resolve(serverconf.Inputs{Home: home, Getenv: noEnv})
	if !conf.UpdateCheckSet {
		t.Error("표식이 남지 않았다")
	}
	if !conf.UpdateCheck {
		t.Error("기본이 켜짐으로 남지 않았다")
	}
}

// 사용자가 이미 껐으면 알리지 않는다 — 그 결정은 이미 내려졌다.
func TestUpdateNoticeSilentWhenAlreadyDecided(t *testing.T) {
	home := t.TempDir()
	if err := serverconf.SetUpdateCheck(home, false); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	announceUpdateCheck(home, noEnv, &out)
	if out.Len() != 0 {
		t.Errorf("이미 정한 사람에게 알렸다:\n%s", out.String())
	}
}

// 킬스위치가 걸려 있으면 하지도 않을 일을 알리지 않는다 (FR-UPD-11).
func TestUpdateNoticeSilentUnderKillSwitch(t *testing.T) {
	home := t.TempDir()
	env := func(k string) string {
		if k == updatecheck.EnvNoCheck {
			return "1"
		}
		return ""
	}
	var out bytes.Buffer
	announceUpdateCheck(home, env, &out)
	if out.Len() != 0 {
		t.Errorf("막혀 있는데 알렸다:\n%s", out.String())
	}
	conf := serverconf.Resolve(serverconf.Inputs{Home: home, Getenv: noEnv})
	if conf.UpdateCheckSet {
		t.Error("알리지도 않고 표식만 남겼다")
	}
}

func TestUpdateNoticeNeedsHome(t *testing.T) {
	var out bytes.Buffer
	announceUpdateCheck("", noEnv, &out)
	if out.Len() != 0 {
		t.Error("홈 없이 알렸다")
	}
}
