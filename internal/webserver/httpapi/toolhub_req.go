package httpapi

import (
	"context"
	"net/http"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
)

// 요청에 매인 도구 손잡이 (OBSERVABILITY_SRS FR-OBS-10).
//
// **데몬 RPC 를 그 호출 자리에서 기록한다.** 그래야 한 요청이 남긴 줄 셋이 —
// 접근 로그 · 핸들러 로그 · 이 줄 — 같은 ID 로 묶인다 (FR-OBS-9).
//
// ── 왜 `ToolClient` 안이 아니라 여기인가 (D-OBS-3a) ──────────────
//
// 처음 설계는 `ToolClient` 가 요청 ID 를 들게 하는 것이었다. 그 손잡이를
// 요청마다 복사하려면 구조체를 얕게 베껴야 하는데, 그 안에는 `sync.Mutex`·
// `sync.Once` 와 **연결·대기 표가 함께 있다** — 베끼면 복사본이 제 뮤텍스를 갖고
// 같은 map 을 만지는 경합이 된다. 공유 상태를 포인터 뒤로 옮기는 재구성은
// 700줄짜리 연결 관리 파일 전체를 흔들고, **이 마일스톤이 사려는 것보다 비싸다.**
//
// 그래서 기록을 경계로 올렸다. 얻는 것은 같다 — RPC 가 자기를 부른 요청을
// 가리킨다. **얻지 못하는 것은 데몬 쪽 로그의 상관관계**이고, 그것은 비목표로
// 적는다(§6-7): 데몬은 여러 호출자의 RPC 를 한 스트림에 섞어 쓰므로 그쪽을
// 묶으려면 와이어 판을 올려야 한다.
//
// 임베딩이라 **기록하지 않는 메서드는 손대지 않고 그대로 지나간다.**

// reqHub 는 요청 하나에 매인 `ToolHub` 다.
type reqHub struct {
	toolhub.ToolHub
	ctx context.Context
}

// withReq 는 요청 컨텍스트에 매인 손잡이를 준다. ID 가 없으면 원본을 그대로
// 돌려준다 — 감싸기만 하고 아무것도 더하지 않는 겹을 만들지 않는다.
func withReq(h toolhub.ToolHub, ctx context.Context) toolhub.ToolHub {
	if h == nil || dmlog.ReqID(ctx) == "" {
		return h
	}
	return reqHub{ToolHub: h, ctx: ctx}
}

// rpc 는 한 줄을 남긴다. `debug` 인 것은 RPC 가 요청당 여러 번 나기 때문이다 —
// 상관관계를 쫓을 때만 켠다.
func (h reqHub) rpc(method string, args ...any) {
	dmlog.Debug(h.ctx, "daemon rpc", append([]any{"method", method}, args...)...)
}

// 기록하는 것은 **상태를 바꾸는 호출**이다. 읽기(List·Get·Busy)는 요청당 수십
// 번 나고, 그것까지 남기면 이 줄이 로그를 덮어 정작 쫓으려던 것을 가린다.

func (h reqHub) Create(cwd string, cols, rows uint16, place toolhub.Placement) (*toolhub.Tool, error) {
	h.rpc("create", "cwd", cwd)
	return h.ToolHub.Create(cwd, cols, rows, place)
}

func (h reqHub) Delete(id string) error {
	h.rpc("delete", "tool", id)
	return h.ToolHub.Delete(id)
}

func (h reqHub) Resize(id string, cols, rows uint16) error {
	h.rpc("resize", "tool", id, "cols", cols, "rows", rows)
	return h.ToolHub.Resize(id, cols, rows)
}

func (h reqHub) SendPaste(id string, text []byte, submit bool) error {
	h.rpc("paste", "tool", id, "bytes", len(text), "submit", submit)
	return h.ToolHub.SendPaste(id, text, submit)
}

func (h reqHub) SetBackground(id string, bg bool) bool {
	h.rpc("background", "tool", id, "bg", bg)
	return h.ToolHub.SetBackground(id, bg)
}

// tools 는 요청에 매인 도구 손잡이다. 핸들러는 `s.Tools` 대신 이것을 쓴다 —
// 그러면 그 요청이 부른 RPC 가 로그에서 요청과 묶인다.
//
// `r` 이 없는 자리(주기 작업·복원·정리)는 `s.Tools` 를 그대로 쓴다. 그곳의
// 호출은 어느 요청의 것도 아니며, 없는 상관관계를 지어내지 않는다.
func (s *Server) tools(r *http.Request) toolhub.ToolHub {
	if r == nil {
		return s.Tools
	}
	return withReq(s.Tools, r.Context())
}
