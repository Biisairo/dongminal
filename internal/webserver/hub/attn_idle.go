package hub

import (
	"time"

	"dongminal/internal/shared/toolhub"
)

// L2 유휴 스위퍼 — 출력이 멎은 도구 중 전경 프로세스가 있는 것에 "idle" 알람을 올린다.

// BusyManyProbe 는 ids 의 전경 프로세스 여부를 한 번에 묻는다 (OPTIMIZE_REFACTOR_SRS
// FR-OPT-2-4). ok=false 는 "모른다" 이며 호출자는 판정을 보류한다 (IPC-M2).
type BusyManyProbe func(ids []string) (busy map[string]bool, ok bool)

// SetBusyProbe installs the foreground-process check used by the L2 idle
// sweeper. In daemon mode this is wired to toolclient.ToolClient.BusyMany (one busymany
// RPC to dongminald). Without it, idle never fires (matching toolhub.Tool, where a
// bare prompt must not raise an alarm — DAEMON_SPLIT_SRS FR-15).
func (t *AttnTracker) SetBusyProbe(f BusyManyProbe) {
	t.mu.Lock()
	t.busyProbe = f
	t.mu.Unlock()
}

// StartSweeper launches the L2 idle sweeper goroutine. stopCh closes on
// server shutdown.
//
// 멈추는 길은 stopCh 하나다 (FR-CAF-15). 종전에는 `Stop()` 과 `t.stop` 채널이
// 두 번째 길로 있었으나 아무도 부르지 않았고(그래서 `t.stop` 은 영영 닫히지
// 않는 갈래였다), 두 번 부르면 close 가 패닉하는 상태였다. 티커도 이 고루틴
// 밖에서 쓰이지 않으므로 구조체 필드로 둘 이유가 없다 — 필드로 두면 잠금 없이
// 공유되는 값이 하나 더 생긴다.
//
// 틱은 **주입한다** (M8 TEST-8). 배선(main.go)은 1초 티커의 채널을 주고, 테스트는
// 자기 채널로 틱을 보낸다 — 그래야 "다음 틱까지" 를 자지 않고도 sweep 을
// 결정적으로 일으킬 수 있다.
func (t *AttnTracker) StartSweeper(stopCh <-chan struct{}, tick <-chan time.Time) {
	if t.idleThreshold <= 0 {
		return
	}
	go func() {
		for {
			select {
			case <-tick:
				t.sweepIdle()
			case <-stopCh:
				return
			}
		}
	}()
}

// SweeperInterval 은 배선이 스위퍼에 주는 틱의 주기다.
const SweeperInterval = 1 * time.Second

// sweepIdle runs one L2 idle pass at the tracker's clock.
func (t *AttnTracker) sweepIdle() { t.SweepIdleAt(t.now()) }

// SweepIdleAt runs one L2 idle pass at the given time. 공개인 이유는 결정적
// 테스트가 이 자리를 시계 없이 재야 하고, 그 테스트가 다른 패키지에 살기 때문이다 (NFR-5).
//
// 판정의 순서와 뜻은 데몬의 `Tool.maybeIdle` 과 **글자 그대로 같다**
// (FR-ATF-12): ① 에이전트가 도는 도구인가 ② 턴이 진행 중인가 ③ 지금 일하는 중은
// 아닌가(굳은 `working` 은 억제하지 못한다) ④ 전경 프로세스가 있는가. ④ 만 데몬
// RPC 라 마지막에, 남은 후보 전부를 한 번에 묻는다 (FR-OPT-2-4). 답을 모르면 울지
// 않고 무장을 되돌려 다음 패스에 다시 판정한다 (IPC-M2).
func (t *AttnTracker) SweepIdleAt(now int64) {
	t.mu.Lock()
	snap := make([]*attnPaneState, 0, len(t.tools))
	for _, ps := range t.tools {
		snap = append(snap, ps)
	}
	threshold := t.idleThreshold
	probe := t.busyProbe
	onAttn := t.onAttention
	t.mu.Unlock()

	if threshold <= 0 || t.mirroring() {
		return
	}
	// 무장을 내린 도구는 판정이 끝난 뒤의 상태로 알린다 (FR-ARD-11).
	var disarmed []*attnPaneState
	defer func() {
		for _, ps := range disarmed {
			t.changed(ps)
		}
	}()
	var cands []*attnPaneState
	for _, ps := range snap {
		if !ps.attnArmed.Load() {
			continue
		}
		if now-ps.lastOutputAt.Load() < threshold {
			continue
		}
		ps.attnArmed.Store(false)
		disarmed = append(disarmed, ps)
		if !ps.agentSeen.Load() || probe == nil {
			continue
		}
		// FR-ATN-10: 턴이 진행 중이 아니면 알릴 것이 없다.
		if !ps.turn.InProgress() {
			continue
		}
		if toolhub.ActivityStillWorking(ps.activity.Load(), now) {
			continue
		}
		cands = append(cands, ps)
	}
	if len(cands) == 0 {
		return
	}
	ids := make([]string, len(cands))
	for i, ps := range cands {
		ids[i] = ps.id
	}
	busy, ok := probe(ids)
	for _, ps := range cands {
		if !ok {
			ps.attnArmed.Store(true)
			continue
		}
		if !busy[ps.id] {
			continue
		}
		if ps.attention.CompareAndSwap(false, true) && onAttn != nil {
			onAttn(ps.id, "idle")
		}
	}
}
