package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/apierr"
)

// TELEGRAM_BRIDGE_SRS FR-TGB-1~5·10 — 설정 API `/api/telegram`.

var (
	tgGoodToken     = "111:" + strings.Repeat("a", 32)
	tgNoTopicsToken = "222:" + strings.Repeat("b", 32)
	tgBadToken      = "333:" + strings.Repeat("c", 32)
)

// tgFakeAPI 는 getMe 만 아는 가짜 Bot API 다.
func tgFakeAPI(t *testing.T) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch r.URL.Path {
		case "/bot" + tgGoodToken + "/getMe":
			_, _ = w.Write([]byte(`{"ok":true,"result":{"id":9,"is_bot":true,"username":"good_bot","has_topics_enabled":true}}`))
		case "/bot" + tgNoTopicsToken + "/getMe":
			_, _ = w.Write([]byte(`{"ok":true,"result":{"id":9,"is_bot":true,"username":"plain_bot","has_topics_enabled":false}}`))
		default:
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"ok":false,"error_code":401,"description":"Unauthorized"}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func tgAPIServer(t *testing.T, base string) *Server {
	t.Helper()
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	srv, err := New(Config{DataDir: t.TempDir(), TelegramAPI: base}, Deps{Tools: m})
	if err != nil {
		t.Fatal(err)
	}
	return srv
}

func tgDo(t *testing.T, s *Server, method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, apiTestRequest(method, path, strings.NewReader(body)))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func tgWantErr(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status || rec.Header().Get(apierr.CodeHeader) != code {
		t.Fatalf("status=%d code=%q body=%s, want %d %q", rec.Code, rec.Header().Get(apierr.CodeHeader), rec.Body.String(), status, code)
	}
}

func TestTelegramAPI_GetDefault(t *testing.T) {
	fake, _ := tgFakeAPI(t)
	s := tgAPIServer(t, fake.URL)
	rec, v := tgDo(t, s, http.MethodGet, "/api/telegram", "")
	if rec.Code != http.StatusOK || v["enabled"] != false || v["tokenSet"] != false || v["paired"] != false ||
		v["silenceMin"] != float64(5) || v["pair"] != nil {
		t.Fatalf("status=%d view=%v", rec.Code, v)
	}
}

// FR-TGB-3·4: getMe 로 확인한다. 실패·토픽 꺼짐은 거절하고, 응답에 token 이 없다.
func TestTelegramAPI_Token(t *testing.T) {
	fake, hits := tgFakeAPI(t)
	s := tgAPIServer(t, fake.URL)

	rec, _ := tgDo(t, s, http.MethodPut, "/api/telegram/token", `{"token":"12/../x"}`)
	tgWantErr(t, rec, http.StatusBadRequest, apierr.CodeTelegramTokenInvalid)
	if hits.Load() != 0 {
		t.Fatal("모양이 틀린 token 으로 Telegram 을 불렀다")
	}
	rec, _ = tgDo(t, s, http.MethodPut, "/api/telegram/token", `{"token":"`+tgBadToken+`"}`)
	tgWantErr(t, rec, http.StatusBadRequest, apierr.CodeTelegramTokenInvalid)
	if strings.Contains(rec.Body.String(), tgBadToken) {
		t.Fatal("오류 응답에 token 이 실렸다")
	}
	rec, _ = tgDo(t, s, http.MethodPut, "/api/telegram/token", `{"token":"`+tgNoTopicsToken+`"}`)
	tgWantErr(t, rec, http.StatusBadRequest, apierr.CodeTelegramTopicsDisabled)

	rec, v := tgDo(t, s, http.MethodPut, "/api/telegram/token", `{"token":"`+tgGoodToken+`"}`)
	if rec.Code != http.StatusOK || v["tokenSet"] != true || v["botName"] != "good_bot" {
		t.Fatalf("status=%d view=%v", rec.Code, v)
	}
	if strings.Contains(rec.Body.String(), tgGoodToken) {
		t.Fatal("응답에 token 이 실렸다")
	}
	_, v = tgDo(t, s, http.MethodGet, "/api/telegram", "")
	if v["tokenSet"] != true {
		t.Fatalf("저장되지 않았다: %v", v)
	}
}

// Telegram 에 닿지 않으면 502 다.
func TestTelegramAPI_TokenUnreachable(t *testing.T) {
	fake, _ := tgFakeAPI(t)
	s := tgAPIServer(t, fake.URL)
	fake.Close()
	rec, _ := tgDo(t, s, http.MethodPut, "/api/telegram/token", `{"token":"`+tgGoodToken+`"}`)
	tgWantErr(t, rec, http.StatusBadGateway, apierr.CodeTelegramUnreachable)
}

func TestTelegramAPI_EnabledAndSilence(t *testing.T) {
	fake, _ := tgFakeAPI(t)
	s := tgAPIServer(t, fake.URL)
	rec, v := tgDo(t, s, http.MethodPut, "/api/telegram/enabled", `{"enabled":true}`)
	if rec.Code != http.StatusOK || v["enabled"] != true {
		t.Fatalf("status=%d view=%v", rec.Code, v)
	}
	rec, _ = tgDo(t, s, http.MethodPut, "/api/telegram/silence", `{"minutes":-1}`)
	tgWantErr(t, rec, http.StatusBadRequest, apierr.CodeTelegramConfigInvalid)
	rec, v = tgDo(t, s, http.MethodPut, "/api/telegram/silence", `{"minutes":0}`)
	if rec.Code != http.StatusOK || v["silenceMin"] != float64(0) {
		t.Fatalf("status=%d view=%v", rec.Code, v)
	}
	rec, _ = tgDo(t, s, http.MethodPut, "/api/telegram/silence", `{bad`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("깨진 본문 status=%d", rec.Code)
	}
}

// FR-TGB-10·11: 코드는 만든 응답에만 있고, GET 은 만료만 보인다. 해제는 계정과 코드를 지운다.
func TestTelegramAPI_Pair(t *testing.T) {
	fake, _ := tgFakeAPI(t)
	s := tgAPIServer(t, fake.URL)
	rec, _ := tgDo(t, s, http.MethodPost, "/api/telegram/pair", "")
	tgWantErr(t, rec, http.StatusConflict, apierr.CodeTelegramNoToken)

	tgDo(t, s, http.MethodPut, "/api/telegram/token", `{"token":"`+tgGoodToken+`"}`)
	rec, v := tgDo(t, s, http.MethodPost, "/api/telegram/pair", "")
	code, _ := v["code"].(string)
	if rec.Code != http.StatusOK || !regexp.MustCompile(`^[0-9]{6}$`).MatchString(code) || v["expires"] == nil {
		t.Fatalf("status=%d body=%v", rec.Code, v)
	}
	rec, v = tgDo(t, s, http.MethodGet, "/api/telegram", "")
	pair, _ := v["pair"].(map[string]any)
	if pair == nil || pair["expires"] == nil || strings.Contains(rec.Body.String(), code) {
		t.Fatalf("GET 의 짝맞춤=%v body=%s", pair, rec.Body.String())
	}
	_ = s.tg.st.SetUser(42)
	rec, v = tgDo(t, s, http.MethodDelete, "/api/telegram/pair", "")
	if rec.Code != http.StatusOK || v["paired"] != false || v["pair"] != nil {
		t.Fatalf("status=%d view=%v", rec.Code, v)
	}
	if s.tg.bridge.Pairing().Redeem(code) {
		t.Fatal("해제 뒤에도 코드가 살아 있다")
	}
}

func TestTelegramAPI_Unavailable(t *testing.T) {
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	s, err := New(Config{}, Deps{Tools: m})
	if err != nil {
		t.Fatal(err)
	}
	rec, _ := tgDo(t, s, http.MethodGet, "/api/telegram", "")
	tgWantErr(t, rec, http.StatusServiceUnavailable, apierr.CodeTelegramUnavailable)
}

// FR-TGB-5: token 을 바꾸면 허용 계정과 함께, 바꾸기 전에 만든 등록 코드도 버린다.
// 그러지 않으면 새 봇에서 옛 코드로 등록할 수 있다 (보안 리뷰 2026-11-12).
func TestTelegramAPI_TokenChangeCancelsPairing(t *testing.T) {
	fake, _ := tgFakeAPI(t)
	s := tgAPIServer(t, fake.URL)
	tgDo(t, s, http.MethodPut, "/api/telegram/token", `{"token":"`+tgGoodToken+`"}`)
	_, v := tgDo(t, s, http.MethodPost, "/api/telegram/pair", "")
	code, _ := v["code"].(string)
	rec, v := tgDo(t, s, http.MethodPut, "/api/telegram/token", `{"token":"`+tgGoodToken+`"}`)
	if rec.Code != http.StatusOK || v["pair"] != nil {
		t.Fatalf("status=%d view=%v", rec.Code, v)
	}
	if s.tg.bridge.Pairing().Redeem(code) {
		t.Fatal("token 저장 뒤에도 옛 등록 코드가 살아 있다")
	}
}
