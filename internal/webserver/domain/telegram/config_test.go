package telegram

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TELEGRAM_BRIDGE_SRS TC-TGB-1·2 — 전용 설정 파일과 token 의 쓰기 전용 (FR-TGB-2·3·5).

const testToken = "123456:SECRET-token-value"

func openTemp(t *testing.T) (*Store, string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "telegram.json")
	return OpenStore(p), p
}

func TestStoreDefaults(t *testing.T) {
	s, _ := openTemp(t)
	c := s.Config()
	if c.Enabled || c.Token != "" || c.UserID != 0 || c.SilenceMin != DefaultSilenceMin {
		t.Fatalf("기본값이 틀렸다: %+v", c)
	}
}

func TestStoreRoundTrip(t *testing.T) {
	s, p := openTemp(t)
	if err := s.SetToken(testToken, "office_bot"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	c := OpenStore(p).Config()
	if !c.Enabled || c.Token != testToken || c.BotName != "office_bot" {
		t.Fatalf("다시 연 값이 틀렸다: %+v", c)
	}
}

// 화면으로 가는 값에는 token 이 없다 (FR-TGB-3).
func TestViewHidesToken(t *testing.T) {
	s, _ := openTemp(t)
	_ = s.SetToken(testToken, "office_bot")
	_ = s.SetUser(42)
	v := s.View()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "SECRET") {
		t.Fatalf("view 에 token 이 실렸다: %s", raw)
	}
	if !v.TokenSet || !v.Paired || v.BotName != "office_bot" {
		t.Fatalf("view 값이 틀렸다: %+v", v)
	}
}

// token 을 바꾸면 허용 계정을 지운다 (FR-TGB-5).
func TestSetTokenResetsPairing(t *testing.T) {
	s, _ := openTemp(t)
	_ = s.SetToken(testToken, "a")
	_ = s.SetUser(42)
	if err := s.SetToken("999:other", "b"); err != nil {
		t.Fatal(err)
	}
	if c := s.Config(); c.UserID != 0 {
		t.Fatalf("token 교체 뒤 초기화되지 않았다: %+v", c)
	}
	// 같은 token 을 다시 저장하면 지우지 않는다.
	_ = s.SetUser(43)
	_ = s.SetToken("999:other", "b")
	if c := s.Config(); c.UserID != 43 {
		t.Fatalf("같은 token 인데 초기화했다: %+v", c)
	}
}

func TestSilenceBounds(t *testing.T) {
	s, _ := openTemp(t)
	if err := s.SetSilence(0); err != nil {
		t.Fatalf("0 은 받아야 한다: %v", err)
	}
	if err := s.SetSilence(-1); err == nil {
		t.Fatal("음수를 받았다")
	}
	if err := s.SetSilence(MaxSilenceMin + 1); err == nil {
		t.Fatal("상한을 넘는 값을 받았다")
	}
}

// 개정 1 의 파일(토픽 대응표가 있음)도 그대로 읽는다. 대응표는 다음 저장 때 사라진다.
func TestStoreReadsRevision1File(t *testing.T) {
	p := filepath.Join(t.TempDir(), "telegram.json")
	old := `{"enabled":true,"token":"` + testToken + `","userId":42,"silenceMin":3,"topics":{"s":{"threadId":7}}}`
	if err := os.WriteFile(p, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	s := OpenStore(p)
	if c := s.Config(); !c.Enabled || c.UserID != 42 || c.SilenceMin != 3 {
		t.Fatalf("개정 1 파일을 읽지 못했다: %+v", c)
	}
	_ = s.SetSilence(4)
	raw, _ := os.ReadFile(p)
	if strings.Contains(string(raw), "topics") {
		t.Fatalf("토픽 대응표가 남았다: %s", raw)
	}
}

// 깨진 파일이면 꺼진 채로 시작한다.
func TestStoreBrokenFileStartsDisabled(t *testing.T) {
	p := filepath.Join(t.TempDir(), "telegram.json")
	if err := os.WriteFile(p, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if c := OpenStore(p).Config(); c.Enabled {
		t.Fatal("깨진 파일인데 켜졌다")
	}
}
