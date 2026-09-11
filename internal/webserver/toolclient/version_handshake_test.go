package toolclient

import (
	"strings"
	"testing"

	"dongminal/internal/shared/toolipc"
)

// VERSION_HEALTH_SRS 묶음 V — 판 핸드셰이크 (V-VHL-2·3·4).
//
// 지금은 `connect()` 가 hello 의 **응답을 통째로 버린다**(`client.go:137` 의 `_`).
// 그래서 판이 무엇이든 연결이 성립하고, 낡은 데몬 위에 새 서버가 붙어도 아무도
// 모른다 — 그 조합이 가장 오래 산다(서버만 재시작하는 것이 흔한 조작이다).

// helloDaemon 은 hello 에 주어진 결과를 그대로 답하는 가짜 데몬이다. 다른 메서드는
// 빈 결과를 준다 — 이 검사가 재는 것은 핸드셰이크뿐이다.
//
// **검사 이름을 짧게 두어라.** `startFakePaned` 는 `t.TempDir()` 아래에 소켓을
// 만들고 그 경로에 **테스트 이름이 들어간다**. darwin 의 `sun_path` 는 104바이트라
// 이름이 길면 `Listen` 이 조용히 실패하고(그 오류는 버려진다) 가짜 데몬의
// 고루틴이 nil 리스너에서 패닉한다 — 증상이 원인과 멀다 (2026-09-11 실측).
func helloDaemon(t *testing.T, result map[string]interface{}) string {
	t.Helper()
	return startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		if req.Method == "hello" {
			return toolipc.PanedResponse{ID: req.ID, Result: result}
		}
		return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{}}
	})
}

// V-VHL-2: **프로토콜 판이 다르면 연결을 거부한다** (FR-VHL-3).
//
// 문법이 다른 상대와 말을 이어 가면 실패가 엉뚱한 자리에서 난다 — 도구 생성이나
// 리사이즈에서 터지고, 그때 원인은 핸드셰이크에 있다.
func TestHelloProtoMismatch(t *testing.T) {
	sock := helloDaemon(t, map[string]interface{}{
		"version": toolipc.ProtocolVersion + 1,
		"build":   "9.9.9",
	})
	pc, err := DialToolClient(sock)
	if err == nil {
		pc.Close()
		t.Fatal("프로토콜 판이 다른데 연결이 성립했다 (FR-VHL-3)")
	}
	if !strings.Contains(err.Error(), "protocol") {
		t.Fatalf("사유가 프로토콜 불일치임이 드러나지 않는다: %v", err)
	}
}

// V-VHL-3: **빌드 판이 다르면 연결은 유지한다** (FR-VHL-4).
//
// 프로토콜이 같으면 통신은 성립하므로 끊을 이유가 없다 — 끊는 비용이 사용자의
// PTY 다. 대신 그 사실을 기억해 헬스에 싣는다.
func TestHelloBuildMismatch(t *testing.T) {
	sock := helloDaemon(t, map[string]interface{}{
		"version": toolipc.ProtocolVersion,
		"build":   "0.0.1-old",
	})
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("빌드 판이 다르다고 연결을 끊었다 — PTY 가 죽는다 (FR-VHL-4): %v", err)
	}
	defer pc.Close()

	info := pc.DaemonInfo()
	if info.Protocol != toolipc.ProtocolVersion {
		t.Fatalf("protocol=%d want %d", info.Protocol, toolipc.ProtocolVersion)
	}
	if info.Build != "0.0.1-old" {
		t.Fatalf("build=%q — 데몬이 말한 판을 기억하지 않는다", info.Build)
	}
}

// V-VHL-4: **판 키가 없는 옛 데몬**은 프로토콜 1 로 읽고 빌드는 비운다 (FR-VHL-5).
//
// 비운 것과 다른 것은 구별된다 (FR-CBG-5) — 빈 빌드는 불일치가 아니다. 여기서
// 거부하면 갱신 중인 인스턴스가 통째로 멈춘다.
func TestHelloLegacyDaemon(t *testing.T) {
	sock := helloDaemon(t, map[string]interface{}{
		"tool_ids": []interface{}{},
	})
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("판을 말하지 않는 옛 데몬을 거부했다 (FR-VHL-5): %v", err)
	}
	defer pc.Close()

	info := pc.DaemonInfo()
	if info.Protocol != toolipc.ProtocolVersion {
		t.Fatalf("protocol=%d — 말하지 않은 판은 현재 판으로 읽는다", info.Protocol)
	}
	if info.Build != "" {
		t.Fatalf("build=%q — 모르는 것을 지어냈다", info.Build)
	}
}
