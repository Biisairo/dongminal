package hub

import "testing"

// V1: 뷰어가 서버와 같은 컴퓨터인지 판정하려면 구독의 원격 주소가 필요하다
// (VIEWER_URL_OPEN_SRS FR-VUO-1). Executor 선출과 주소 조회는 같은 락 안에서
// 끝나야 한다 — 둘로 나누면 그 사이에 뽑힌 뷰어가 떠날 수 있다.
func TestExecutorAddr_ReturnsAddrOfElectedViewer(t *testing.T) {
	f := NewFocusRegistry()
	f.AttachFrom("c-local", "127.0.0.1:51000")
	f.AttachFrom("c-remote", "100.64.0.5:51001")
	// 포커스를 주장한 쪽이 뷰어다 (FR-SXE-4).
	f.Claim("c-remote", "w1")

	cid, addr := f.ExecutorAddr()
	if cid != "c-remote" {
		t.Fatalf("뷰어 = %q, 기대 c-remote", cid)
	}
	if addr != "100.64.0.5:51001" {
		t.Fatalf("주소 = %q, 기대 100.64.0.5:51001", addr)
	}
}

// 아무도 포커스를 주장하지 않으면 Executor 는 가장 오래된 구독을 뽑는다. 그
// 경로에서도 주소가 따라와야 한다.
func TestExecutorAddr_UnclaimedFallsBackToOldest(t *testing.T) {
	f := NewFocusRegistry()
	f.AttachFrom("c1", "127.0.0.1:52000")
	f.AttachFrom("c2", "192.168.0.9:52001")

	cid, addr := f.ExecutorAddr()
	if cid != "c1" || addr != "127.0.0.1:52000" {
		t.Fatalf("ExecutorAddr = (%q,%q), 기대 (c1,127.0.0.1:52000)", cid, addr)
	}
}

// 구독이 하나도 없으면 뷰어가 없다 — FR-VUO-4 의 로컬 폴백이 이 값을 본다.
func TestExecutorAddr_NoSubscribers(t *testing.T) {
	f := NewFocusRegistry()
	if cid, addr := f.ExecutorAddr(); cid != "" || addr != "" {
		t.Fatalf("ExecutorAddr = (%q,%q), 기대 빈 값", cid, addr)
	}
}

// Attach 는 AttachFrom 의 주소 없는 형태다. 기존 호출자가 그대로 살아 있어야
// 한다 — 주소를 모르는 구독은 판정에서 원격으로 취급된다(빈 주소).
func TestAttach_StillWorksWithoutAddr(t *testing.T) {
	f := NewFocusRegistry()
	if ep := f.Attach("c1"); ep == 0 {
		t.Fatal("Attach 가 epoch 를 주지 않았다")
	}
	cid, addr := f.ExecutorAddr()
	if cid != "c1" {
		t.Fatalf("뷰어 = %q, 기대 c1", cid)
	}
	if addr != "" {
		t.Fatalf("주소 = %q, 기대 빈 값", addr)
	}
}

// 구독이 끊기면 주소도 함께 사라진다. 남으면 죽은 클라이언트의 주소로 판정한다.
func TestExecutorAddr_DetachClearsAddr(t *testing.T) {
	f := NewFocusRegistry()
	ep := f.AttachFrom("c1", "127.0.0.1:53000")
	f.AttachFrom("c2", "10.0.0.2:53001")
	f.Detach("c1", ep)

	cid, addr := f.ExecutorAddr()
	if cid != "c2" || addr != "10.0.0.2:53001" {
		t.Fatalf("ExecutorAddr = (%q,%q), 기대 (c2,10.0.0.2:53001)", cid, addr)
	}
}

// V2: openUrl 은 화이트리스트에 있고 한 클라이언트만 실행한다. 엔티티를 만들지
// 않으므로 reqId 에코(creatingActions)에는 들지 않는다 (FR-VUO-16).
func TestOpenUrlAction_Registration(t *testing.T) {
	if !AllowedCmdActions["openUrl"] {
		t.Error("openUrl 이 AllowedCmdActions 에 없다 — POST /api/commands 가 400 으로 거절한다")
	}
	if !IsSingleExecutorAction("openUrl") {
		t.Error("openUrl 이 단일 실행자 액션이 아니다 — 붙어 있는 모든 기기에서 창이 열린다")
	}
	if IsCreatingAction("openUrl") {
		t.Error("openUrl 은 엔티티를 만들지 않는다 — 에코를 기다리면 3초 멈춘다")
	}
}
