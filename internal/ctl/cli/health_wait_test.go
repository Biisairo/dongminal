package cli

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// VERSION_HEALTH_SRS 묶음 S — 기동의 대기 (V-VHL-10).
//
// 종전 `waitReady` 는 `/api/ping` 만 봤다. 그래서 "준비됨" 직후의 도구 생성이
// 실패할 수 있었다 — 서버는 떴지만 데몬 소켓에 아직 붙지 않은 창이 있다.

func healthServer(t *testing.T, body string) string {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(body))
	}))
	t.Cleanup(ts.Close)
	return ts.URL
}

// 데몬이 붙으면 그 사실과 판을 받아 온다.
func TestWaitDaemonConnected(t *testing.T) {
	url := healthServer(t, `{"version":"1.0.0","daemon":{"connected":true,"protocol":1,"build":"1.0.0","mismatch":false}}`)
	st, ok := waitDaemonConnected(url, 5, 10*time.Millisecond)
	if !ok {
		t.Fatal("데몬이 붙었다고 답하는데 기다림이 실패로 끝났다 (FR-VHL-20)")
	}
	if st.Mismatch {
		t.Errorf("mismatch=%v want false", st.Mismatch)
	}
}

// **데몬을 쓰지 않는 구성에서 매달리지 않는다** (FR-VHL-20a).
//
// 직접 모드는 `connected` 가 영원히 거짓이다. 그것을 실패로 읽어 기동을 막으면
// 그 구성이 통째로 못 뜬다 — 호출자는 이 거짓을 "기다릴 것이 없었다" 로 읽는다.
func TestWaitDaemonNeverConnectsIsBounded(t *testing.T) {
	url := healthServer(t, `{"version":"1.0.0","daemon":{"connected":false}}`)
	start := time.Now()
	_, ok := waitDaemonConnected(url, 3, 10*time.Millisecond)
	if ok {
		t.Fatal("붙지 않았는데 붙었다고 한다")
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("유한 대기가 아니다: %v", el)
	}
}

// 빌드 불일치를 읽어 온다 — `start` 가 그것으로 안내를 낸다 (FR-VHL-21).
func TestWaitDaemonReportsMismatch(t *testing.T) {
	url := healthServer(t, `{"version":"2.0.0","daemon":{"connected":true,"protocol":1,"build":"1.0.0","mismatch":true}}`)
	st, ok := waitDaemonConnected(url, 5, 10*time.Millisecond)
	if !ok {
		t.Fatal("연결은 되어야 한다 — 빌드 불일치로 끊지 않는다 (FR-VHL-4)")
	}
	if !st.Mismatch {
		t.Fatal("불일치를 읽어 오지 못했다 (FR-VHL-21)")
	}
	if st.DaemonBuild != "1.0.0" || st.ServerVersion != "2.0.0" {
		t.Fatalf("판을 함께 가져오지 않았다: %+v", st)
	}
}

// 헬스가 없는 옛 서버에 붙어도 기동이 깨지지 않는다 — 404 는 "모른다" 다.
func TestWaitDaemonToleratesMissingHealth(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	t.Cleanup(ts.Close)
	if _, ok := waitDaemonConnected(ts.URL, 2, 10*time.Millisecond); ok {
		t.Fatal("헬스가 없는데 붙었다고 한다")
	}
}
