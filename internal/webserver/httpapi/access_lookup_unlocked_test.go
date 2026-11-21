package httpapi

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-4 (GH-18): 접근 목록 저장의 DNS 조회는 설정 PUT 잠금
// **밖에서** 돈다. 해석이 느려도 다른 설정 PUT 이 그동안 기다리지 않는다.
//
//	이전: 조회 중 설정 잠금이 잡혀 있었다 — TryLock 실패
//	새:   조회 중 TryLock 성공
func TestAccessPut_LookupOutsideSettingsLock(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	looked, held := 0, 0
	srv.Access.lookupHost = func(string) ([]string, error) {
		looked++
		if !srv.settingsMu.TryLock() {
			held++
		} else {
			srv.settingsMu.Unlock()
		}
		return []string{"10.0.0.9"}, nil
	}
	body := `{"enabled":false,"entries":[{"id":"a","value":"office-box","enabled":true}]}`
	req := apiTestRequest(http.MethodPut, "/api/access", strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:5000"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status=%d body=%s", rec.Code, rec.Body.String())
	}
	if looked == 0 {
		t.Fatal("저장 뒤 해석이 돌지 않았다 — 화면이 '해석 안 됨' 으로 보인다")
	}
	if held != 0 {
		t.Fatalf("DNS 조회 중 설정 잠금이 잡혀 있었다 (%d/%d회)", held, looked)
	}
	// 저장 직후의 답에 해석 결과가 실린다 — 종전과 같다.
	if v := srv.Access.view(); len(v.Entries) != 1 || len(v.Entries[0].Resolved) != 1 {
		t.Fatalf("해석 결과가 응답 전에 반영되지 않았다: %+v", v.Entries)
	}
}

// FR-RGS-4 (GH-18): 기본 조회는 시한을 둔다. 답하지 않는 리졸버에 묶여 갱신이 무기한
// 서지 않는다.
func TestTimedLookup_Bounded(t *testing.T) {
	hang := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	start := time.Now()
	_, err := timedLookup(hang, 50*time.Millisecond)("office-box.example")
	if err == nil {
		t.Fatal("답하지 않는 리졸버인데 성공했다")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("시한 50ms 인데 %v 걸렸다", d)
	}
}
