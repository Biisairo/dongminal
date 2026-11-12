package telegram

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
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

func TestStoreFileMode600AndRoundTrip(t *testing.T) {
	s, p := openTemp(t)
	if err := s.SetToken(testToken, "office_bot"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o600 {
			t.Fatalf("파일 권한 %v, 기대 0600", st.Mode().Perm())
		}
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

// token 을 바꾸면 허용 계정과 토픽 대응표를 지운다 (FR-TGB-5).
func TestSetTokenResetsPairingAndTopics(t *testing.T) {
	s, _ := openTemp(t)
	_ = s.SetToken(testToken, "a")
	_ = s.SetUser(42)
	_ = s.PutTopic("sess-1", Topic{ThreadID: 7, Name: "x"})
	if err := s.SetToken("999:other", "b"); err != nil {
		t.Fatal(err)
	}
	c := s.Config()
	if c.UserID != 0 || len(c.Topics) != 0 {
		t.Fatalf("token 교체 뒤 초기화되지 않았다: %+v", c)
	}
	// 같은 token 을 다시 저장하면 지우지 않는다.
	_ = s.SetUser(43)
	_ = s.PutTopic("sess-2", Topic{ThreadID: 8})
	_ = s.SetToken("999:other", "b")
	if c := s.Config(); c.UserID != 43 || len(c.Topics) != 1 {
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

func TestTopicPutDelete(t *testing.T) {
	s, p := openTemp(t)
	_ = s.PutTopic("sess-1", Topic{ThreadID: 7, Name: "n", ToolID: "t1"})
	if tp, ok := OpenStore(p).Topic("sess-1"); !ok || tp.ThreadID != 7 || tp.ToolID != "t1" {
		t.Fatalf("토픽이 저장되지 않았다: %+v %v", tp, ok)
	}
	_ = s.DeleteTopic("sess-1")
	if _, ok := s.Topic("sess-1"); ok {
		t.Fatal("지운 토픽이 남았다")
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
