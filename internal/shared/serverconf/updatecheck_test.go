package serverconf

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConf(t *testing.T, body string) string {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, FileName), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func resolve(home string) Resolved {
	return Resolve(Inputs{Home: home, Getenv: func(string) string { return "" }})
}

// FR-UPD-12: 기본은 켜짐이고, 키가 없었다는 사실도 함께 나온다 — 최초 고지가
// 그 사실을 표식으로 쓴다 (FR-UPD-10).
func TestUpdateCheckDefaultsOnAndUnset(t *testing.T) {
	r := resolve(t.TempDir())
	if !r.UpdateCheck {
		t.Error("기본이 꺼져 있다")
	}
	if r.UpdateCheckSet {
		t.Error("적은 적 없는 키가 설정됨으로 나왔다")
	}
}

func TestUpdateCheckReadsFalse(t *testing.T) {
	r := resolve(writeConf(t, `{"updateCheck":false}`))
	if r.UpdateCheck {
		t.Error("false 를 읽지 못했다")
	}
	if !r.UpdateCheckSet {
		t.Error("적힌 키가 설정됨으로 나오지 않았다")
	}
}

// FR-UPD-16 / C-4: bool 이 아니면 기본값으로 떨어지고 경고만 낸다.
// **다른 키를 함께 잃지 않는다** — 한 키의 오타가 포트를 날리면 안 된다.
func TestUpdateCheckBadTypeWarnsAndKeepsOtherKeys(t *testing.T) {
	r := resolve(writeConf(t, `{"updateCheck":"yes","port":"9999"}`))
	if !r.UpdateCheck {
		t.Error("기본값으로 떨어지지 않았다")
	}
	if r.Port.Value != "9999" {
		t.Errorf("다른 키를 잃었다: port=%q", r.Port.Value)
	}
	if !strings.Contains(strings.Join(r.Warnings, "\n"), "updateCheck") {
		t.Errorf("경고가 없다: %v", r.Warnings)
	}
	if r.Err() != nil {
		t.Errorf("기동을 막았다: %v", r.Err())
	}
}

// 알 수 없는 키 경고가 updateCheck 에는 붙지 않아야 한다.
func TestUpdateCheckIsAKnownKey(t *testing.T) {
	r := resolve(writeConf(t, `{"updateCheck":true}`))
	if strings.Contains(strings.Join(r.Warnings, "\n"), "알 수 없는 키") {
		t.Errorf("아는 키인데 경고했다: %v", r.Warnings)
	}
}

// FR-UPD-13: 토글은 server.json 에 기록된다. **다른 키를 보존한다.**
func TestSetUpdateCheckPreservesOtherKeys(t *testing.T) {
	home := writeConf(t, `{"port":"7777","logLevel":"debug"}`)
	if err := SetUpdateCheck(home, false); err != nil {
		t.Fatal(err)
	}
	r := resolve(home)
	if r.UpdateCheck {
		t.Error("false 가 기록되지 않았다")
	}
	if r.Port.Value != "7777" || r.LogLevel.Value != "debug" {
		t.Errorf("다른 키를 잃었다: port=%q logLevel=%q", r.Port.Value, r.LogLevel.Value)
	}
}

func TestSetUpdateCheckCreatesFile(t *testing.T) {
	home := t.TempDir()
	if err := SetUpdateCheck(home, true); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(home, FileName))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("쓴 것이 JSON 이 아니다: %v", err)
	}
	if m["updateCheck"] != true {
		t.Errorf("updateCheck=%v", m["updateCheck"])
	}
}

// 깨진 파일 위에 써도 기동을 막지 않아야 한다 — 쓰기는 실패를 돌려주되
// 남은 파일은 읽을 수 있는 상태여야 한다.
func TestSetUpdateCheckOnBrokenFile(t *testing.T) {
	home := writeConf(t, `{not json`)
	if err := SetUpdateCheck(home, false); err != nil {
		t.Fatalf("깨진 파일 때문에 실패했다: %v", err)
	}
	r := resolve(home)
	if r.UpdateCheck {
		t.Error("false 가 기록되지 않았다")
	}
}

func TestSetUpdateCheckNeedsHome(t *testing.T) {
	if err := SetUpdateCheck("", true); err == nil {
		t.Error("홈 없이 성공했다")
	}
}
