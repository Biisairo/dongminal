package agentadapter

import "testing"

// M8_UNIFIED_SRS R-8 — 두 표면이 **같은 표**에서 돈다. 어댑터마다 프로토콜 표면의
// 유무를 여기 선언하고 실제와 대조한다 — 한쪽만 고쳐진 채 지나가지 않게.
//
// P3 가 claude, P4 가 codex·omp 를 채웠다 (§4). 어댑터를 더하면 여기 한 줄이 는다.
var protoSurface = map[string]bool{
	"claude": true,
	"codex":  true,
	"omp":    true,
}

func TestProto_SurfaceTable(t *testing.T) {
	for _, id := range IDs() {
		want, listed := protoSurface[id]
		if !listed {
			t.Fatalf("%s: 이 표에 없다 — 어댑터를 더했으면 프로토콜 표면의 유무를 여기 적어라", id)
		}
		ad, _ := Get(id)
		if ad.HasProto() != want {
			t.Fatalf("%s: Proto 유무가 표(%v)와 다르다", id, want)
		}
		if !ad.HasProto() {
			continue
		}
		// 프로토콜 표면이 있으면 넷은 반드시 있다 — 없으면 에이전트 도구가 서지
		// 않는다. 그 밖(Handshake·Cancel·Interrupt·Control·TUIResume)은 부재가 뜻이다.
		p := ad.Proto
		if p.Launch == nil || p.Decode == nil || p.Prompt == nil || p.Approve == nil {
			t.Fatalf("%s: Launch·Decode·Prompt·Approve 는 비어 있을 수 없다", id)
		}
		if argv := p.Launch(LaunchOpts{Bin: "/x/bin"}); len(argv) == 0 || argv[0] != "/x/bin" {
			t.Fatalf("%s: Launch 는 Bin 을 argv[0] 에 둔다: %v", id, argv)
		}
	}
	for id := range protoSurface {
		if _, err := Get(id); err != nil {
			t.Fatalf("표의 %s 가 등록부에 없다", id)
		}
	}
}
