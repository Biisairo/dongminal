package server

import "dongminal/internal/webserver/hub"

import "testing"

// WORKSPACE_IDENTITY_SRS §4 TC-UNI-15 — reqId 는 canonical uuid 다 (FR-UNI-14).
//
// 이전: 16바이트 hex(32자, 구분자·버전 비트 없음). 엔트로피는 동등하므로 echo 상관
// 동작(FR-RCR-*)은 불변이고 표현만 통일된다.
func TestNewReqId_IsUUID(t *testing.T) {
	seen := make(map[string]struct{}, 64)
	for i := 0; i < 64; i++ {
		id := hub.NewReqId()
		if !uuidRe.MatchString(id) {
			t.Fatalf("reqId=%q 가 uuid 형식이 아니다", id)
		}
		if _, dup := seen[id]; dup {
			t.Fatalf("reqId 중복: %q", id)
		}
		seen[id] = struct{}{}
	}
}
