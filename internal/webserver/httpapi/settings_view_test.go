package httpapi

import (
	"path/filepath"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-2 (HTTP-26) — 서버가 읽는 가지(렌더 환경·컨텍스트
// 정책)는 blob 이 바뀔 때만 다시 해석한다. 도구 생성·컨텍스트 훅마다 전체를 풀지 않는다.
func TestSettingsView_MemoizedUntilSet(t *testing.T) {
	st := newSettingsStore(filepath.Join(t.TempDir(), "settings.json"))
	st.Set([]byte(`{"claudeFullscreen":false,"orchestration":{"contextWarnRatio":0.4}}`))
	v1 := st.view()
	if v1 != st.view() {
		t.Fatal("바뀌지 않은 blob 을 다시 해석했다")
	}
	if v1.policy.WarnRatio != 0.4 {
		t.Fatalf("policy = %+v", v1.policy)
	}
	for _, e := range v1.renderEnv {
		if e == claudeNoFlickerEnv {
			t.Fatal("claudeFullscreen:false 인데 fullscreen 변수가 있다")
		}
	}
	// 무효화 조건: Set.
	st.Set([]byte(`{"orchestration":{"contextWarnRatio":0.5}}`))
	v2 := st.view()
	if v2 == v1 || v2.policy.WarnRatio != 0.5 {
		t.Fatalf("Set 뒤에도 옛 해석이다: %+v", v2.policy)
	}
	if len(v2.renderEnv) == 0 || v2.renderEnv[0] != claudeNoFlickerEnv {
		t.Fatalf("renderEnv = %v", v2.renderEnv)
	}
	// 받은 쪽이 고쳐도 캐시가 오염되지 않는다.
	env := st.RenderEnv()
	env[0] = "X=1"
	if st.view().renderEnv[0] != claudeNoFlickerEnv {
		t.Fatal("renderEnv 가 캐시를 그대로 내준다")
	}
}
