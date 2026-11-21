package toolclient

import (
	"dongminal/internal/shared/toolhub"
)

// 재접속 뒤의 재동기 — 끊긴 동안 놓친 exit·출력·전경 이름을 메운다 (OPTIMIZE_REFACTOR_SRS
// FR-OPT-1-2·FR-OPT-2-1). 기록·간선·채팅의 재동기는 각자의 파일에 있다.

// resyncAfterReconnect 는 끊긴 동안 놓친 push 를 메운다 (OPTIMIZE_REFACTOR_SRS
// FR-OPT-1-2). 공백 중 끝난 도구의 exit 는 오지 않았고, 살아 있는 도구의 출력에는
// 구멍이 났다.
//
// 재접속 뒤의 목록과 대조해 사라진 도구(구독한 것과 직전 목록에 있던 것)는 exitCh 를
// 닫고 onExit 를 합성한다. 살아 있는 구독은 출력 채널을 닫아 끊는다 — 릴레이가 exit
// 없이 소켓을 닫고 브라우저가 since 로 재동기한다. 목록을 모르면(list 실패) 죽었다고
// 판정하지 않고 전부 재동기로 돌린다 — 재접속한 브라우저의 snapshot 이 판정한다.
func (pc *ToolClient) resyncAfterReconnect() {
	pc.listMu.Lock()
	known := map[string]struct{}{}
	for _, t := range pc.listCache {
		known[t.ID] = struct{}{}
	}
	pc.listMu.Unlock()
	pc.invalidateList()
	pc.fgMu.Lock()
	fgFrom := pc.fgSeq
	pc.fgMu.Unlock()
	tools, ok := pc.ListOK()
	alive := make(map[string]struct{}, len(tools))
	for _, t := range tools {
		alive[t.ID] = struct{}{}
	}

	pc.subMu.Lock()
	subs := pc.subbers
	pc.subbers = map[string]map[chan OutChunk]chan struct{}{}
	pc.subMu.Unlock()
	for id, m := range subs {
		_, live := alive[id]
		for ch, exitCh := range m {
			if ok && !live {
				close(exitCh)
			} else {
				close(ch)
			}
		}
		known[id] = struct{}{}
	}
	if !ok {
		return
	}
	pc.resyncForeground(tools, fgFrom)
	pc.mu.Lock()
	onExit := pc.onExit
	pc.mu.Unlock()
	if onExit == nil {
		return
	}
	for id := range known {
		if _, live := alive[id]; !live {
			onExit(id, toolhub.ExitInfo{})
		}
	}
}

// resyncForeground 는 끊긴 동안 바뀐 전경 이름을 알린다. 데몬은 그 사이의 변화를
// 받을 연결이 없어 버렸고, 다음 변화 전에는 다시 밀지 않는다 (FR-OPT-2-1). 목록을
// 묻기 시작한 뒤(fgFrom 이후) push 로 온 도구는 그 값이 더 새것이므로 건너뛴다.
func (pc *ToolClient) resyncForeground(tools []toolhub.ToolInfo, fgFrom uint64) {
	pc.mu.Lock()
	cb := pc.onForeground
	pc.mu.Unlock()
	pc.fgMu.Lock()
	defer pc.fgMu.Unlock()
	seen := make(map[string]fgSeen, len(tools))
	for _, t := range tools {
		e := pc.fgSeen[t.ID]
		if e.seq <= fgFrom && e.name != t.FgName {
			e.name = t.FgName
			if cb != nil {
				cb(t.ID, t.FgName)
			}
		}
		seen[t.ID] = e
	}
	pc.fgSeen = seen
}
