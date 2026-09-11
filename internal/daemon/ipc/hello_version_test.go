package ipc

import (
	"testing"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// VERSION_HEALTH_SRS V-VHL-1 — `hello` 는 판 **둘**을 따로 싣는다 (FR-VHL-1).
//
// 합치면 안 되는 이유가 이 검사의 뜻이다: 프로토콜은 거의 안 바뀌고 빌드는
// 릴리스마다 바뀐다. 한 값이면 **모든 릴리스가 프로토콜 불일치로 읽힌다** (D-1).
func TestHelloCarriesProtocolAndBuild(t *testing.T) {
	pm := toolhub.NewToolManager("", nil)
	t.Cleanup(pm.StopSaving)
	ps := NewPanedServer(pm, "", "")
	ps.SetBuildVersion("1.2.3")

	pc := newPanedConn(nil, pm)
	pc.build = ps.buildVersion
	res, ok := pc.hello(&toolipc.PanedRequest{ID: 1}).(toolipc.PanedResponse)
	if !ok {
		t.Fatal("hello 가 PanedResponse 를 내지 않았다")
	}
	m, ok := res.Result.(map[string]interface{})
	if !ok {
		t.Fatalf("Result 형식이 다르다: %T", res.Result)
	}
	if m["version"] != toolipc.ProtocolVersion {
		t.Errorf("version=%v want %d — 프로토콜 판", m["version"], toolipc.ProtocolVersion)
	}
	if m["build"] != "1.2.3" {
		t.Errorf("build=%v want 1.2.3 — 빌드 판이 실리지 않는다 (FR-VHL-1)", m["build"])
	}
}

// 판을 새기지 않은 빌드에서도 `hello` 는 성립한다. 빈 빌드는 **모른다**이지
// 불일치가 아니다 (FR-VHL-5).
func TestHelloWithoutBuildStamp(t *testing.T) {
	pm := toolhub.NewToolManager("", nil)
	t.Cleanup(pm.StopSaving)
	pc := newPanedConn(nil, pm)
	res := pc.hello(&toolipc.PanedRequest{ID: 1}).(toolipc.PanedResponse)
	m := res.Result.(map[string]interface{})
	if m["build"] != "" {
		t.Errorf("build=%v — 새기지 않은 판을 지어냈다", m["build"])
	}
}
