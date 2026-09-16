package fakeagent

import (
	"bufio"
	"bytes"
	"io"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/agentadapter"
)

// V-12 — 가짜 에이전트의 프레임을 **실제 어댑터의 Decode** 가 읽는다. 픽스처와
// 어댑터가 어긋나면 여기서 잡힌다 (V-1 의 "형태" 를 CI 에서).

type run struct {
	in     *io.PipeWriter
	lines  chan []byte
	proto  *agentadapter.Proto
	st     *agentadapter.ProtoState
	exited chan int
}

func start(t *testing.T, args ...string) *run {
	t.Helper()
	return startAs(t, "claude", args...)
}

// startAs 는 어댑터 id 의 Decode 로 읽는다 — 가짜가 어느 프로토콜을 말할지는 args 의
// 모양이 고른다 (fakeagent.Main).
func startAs(t *testing.T, id string, args ...string) *run {
	t.Helper()
	ad, err := agentadapter.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	r := &run{in: inW, lines: make(chan []byte, 256), proto: ad.Proto, st: agentadapter.NewProtoState(), exited: make(chan int, 1)}
	go func() {
		code := Main(args, inR, outW)
		outW.Close()
		r.exited <- code
	}()
	// 읽기 고루틴은 하나다 — 부를 때마다 새로 띄우면 앞의 것이 줄을 삼킨다.
	go func() {
		br := bufio.NewReader(outR)
		for {
			line, err := br.ReadBytes('\n')
			if len(line) > 0 {
				r.lines <- bytes.TrimRight(line, "\n")
			}
			if err != nil {
				close(r.lines)
				return
			}
		}
	}()
	t.Cleanup(func() { inW.Close() })
	return r
}

func (r *run) send(frames ...[]byte) {
	for _, f := range frames {
		r.in.Write(append(f, '\n'))
	}
}

// until 은 want 종류의 이벤트가 나올 때까지 읽고 지나온 종류들을 돌려준다.
func (r *run) until(t *testing.T, want agentadapter.EventKind) (kinds []string, last agentadapter.Event) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case line, ok := <-r.lines:
			if !ok {
				t.Fatalf("%s 를 보기 전에 출력이 끝났다: %v", want, kinds)
			}
			evs, ok := r.proto.Decode(line, r.st)
			if !ok {
				t.Fatalf("어댑터가 픽스처의 프레임을 모른다: %s", line)
			}
			for _, e := range evs {
				kinds = append(kinds, string(e.Kind))
				if e.Kind == want {
					return kinds, e
				}
			}
		case <-deadline:
			t.Fatalf("%s 를 기다리다 시한: %v", want, kinds)
		}
	}
}

func TestFake_PongTurn(t *testing.T) {
	r := start(t, "-p", "--output-format", "stream-json", "--model", "fake-x")
	// D-C-16: 기동 즉시 오는 것은 없다 — initialize 응답이 첫 이벤트(session, 신원 없음)다.
	r.send(r.proto.Handshake(agentadapter.LaunchOpts{}, r.st)...)
	kinds, ev := r.until(t, agentadapter.EvSession)
	if ev.SessionID != "" || len(ev.Status.Models) != 2 || len(ev.Status.Commands) == 0 {
		t.Fatalf("initialize 응답: %v %+v", kinds, ev)
	}
	/**
	 * **계약이 바뀌었다** (M12_SRS FR-M12-4, 2026-09-16): 종전에는 명령 **수**(3)를
	 * 박았고, `config` 를 흉내에 더하자 떨어졌다.
	 *
	 * 수를 박으면 흉내가 원본에 가까워질 때마다 검사가 떨어진다. 재려던 것은 수가
	 * 아니라 **고르는 화면이 서는 명령에 선언이 달리는가**이므로 그것을 잰다.
	 */
	forms := map[string]*agentadapter.CommandForm{}
	for _, c := range ev.Status.Commands {
		forms[c.Name] = c.Form
	}
	for _, name := range []string{"model", "config"} {
		if forms[name] == nil {
			t.Fatalf("%q 에 고르는 화면 선언이 없다: %+v", name, ev.Status.Commands)
		}
	}
	if forms["compact"] != nil {
		t.Fatalf("평범한 명령에 선언이 달렸다: %+v", forms["compact"])
	}
	r.send(r.proto.Prompt("say PONG", nil, r.st)...)
	// `system:init` 은 첫 프롬프트 뒤 — 신원과 모델이 그때 온다 (§2-28).
	// 여기서 재는 것은 그 **한 이벤트**이지 거기까지의 종류들이 아니다 — 종류는
	// 아래 턴 종료까지 모아 한 번에 본다.
	_, ev = r.until(t, agentadapter.EvSession)
	if ev.SessionID == "" || ev.Status.Model != "fake-x" {
		t.Fatalf("init: %+v", ev)
	}
	kinds, ev = r.until(t, agentadapter.EvTurnEnd)
	joined := strings.Join(kinds, ",")
	for _, want := range []string{"turn_start", "usage", "text_delta", "message", "turn_end"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("PONG 턴에 %s 가 없다: %s", want, joined)
		}
	}
	if ev.IsError {
		t.Fatal("성공 턴이 오류로 읽혔다")
	}
}

func TestFake_ApproveRoundTrip(t *testing.T) {
	r := start(t)
	r.send(r.proto.Prompt("APPROVE please", nil, r.st)...)
	_, ev := r.until(t, agentadapter.EvApprovalOpen)
	req := ev.Approval
	if req.Kind != agentadapter.ApprovalPermission || req.Tool != "Bash" || len(req.Options) != 3 {
		t.Fatalf("승인 요청: %+v", req)
	}
	frame, err := r.proto.Approve(*req, agentadapter.Decision{Choice: "suggestion:0"}, r.st)
	if err != nil {
		t.Fatal(err)
	}
	r.send(frame)
	kinds, _ := r.until(t, agentadapter.EvTurnEnd)
	joined := strings.Join(kinds, ",")
	if !strings.Contains(joined, "status") || !strings.Contains(joined, "tool_end") || !strings.Contains(joined, "text_delta") {
		t.Fatalf("제안 적용(status) · 도구 결과 · 본문이 있어야 한다: %s", joined)
	}
}

// V-M12-32 (FR-M12-23): **도구를 거절하면 턴은 `aborted_tools` 로 끝난다.**
//
// 실측 2026-09-16 의 일곱 거짓 오류 중 하나가 이것이다. 종전 흉내는 거절 뒤에도
// `completed` 를 내어 그 갈래가 아예 재어지지 않았다 — **흉내가 원본보다 적으면
// 검사가 헛돈다** (M12_PROGRESS §2-6).
func TestFake_DenyEndsTurnStopped(t *testing.T) {
	r := start(t)
	r.send(r.proto.Prompt("APPROVE please", nil, r.st)...)
	_, ev := r.until(t, agentadapter.EvApprovalOpen)
	frame, err := r.proto.Approve(*ev.Approval, agentadapter.Decision{Choice: agentadapter.ChoiceDeny}, r.st)
	if err != nil {
		t.Fatal(err)
	}
	r.send(frame)
	_, ev = r.until(t, agentadapter.EvTurnEnd)
	if ev.Outcome != agentadapter.OutcomeStopped || ev.Text != "aborted_tools" {
		t.Fatalf("거절된 턴: %+v", ev)
	}
}

func TestFake_Question(t *testing.T) {
	r := start(t)
	r.send(r.proto.Prompt("QUESTION", nil, r.st)...)
	_, ev := r.until(t, agentadapter.EvApprovalOpen)
	if ev.Approval.Kind != agentadapter.ApprovalQuestion || len(ev.Approval.Questions) != 1 {
		t.Fatalf("질문: %+v", ev.Approval)
	}
	frame, err := r.proto.Approve(*ev.Approval, agentadapter.Decision{Answers: map[string]string{"Pick a color": "Blue"}}, r.st)
	if err != nil {
		t.Fatal(err)
	}
	r.send(frame)
	_, ev = r.until(t, agentadapter.EvTextDelta)
	if ev.Text != "Blue" {
		t.Fatalf("답한 라벨을 되읊어야 한다: %q", ev.Text)
	}
}

func TestFake_InterruptAndDie(t *testing.T) {
	r := start(t)
	r.send(r.proto.Prompt("SLOW", nil, r.st)...)
	r.until(t, agentadapter.EvTextDelta)
	r.send(r.proto.Interrupt(r.st))
	_, ev := r.until(t, agentadapter.EvTurnEnd)
	// FR-M12-23: 사용자가 끊은 턴은 **멈춘 것**이다 — 오류가 아니다.
	if ev.Outcome != agentadapter.OutcomeStopped || ev.Text != "aborted_streaming" {
		t.Fatalf("인터럽트된 턴: %+v", ev)
	}
	r.send(r.proto.Prompt("DIE", nil, r.st)...)
	select {
	case code := <-r.exited:
		if code != 1 {
			t.Fatalf("exit=%d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("DIE 가 끝나지 않았다")
	}
}

func TestFake_ResumeAndClear(t *testing.T) {
	r := start(t, "--resume", "sess-fixed")
	// U-4: 재개도 이력을 주지 않는다 — 신원만, 그리고 그것도 첫 프롬프트 뒤에 (§2-28).
	r.send(r.proto.Prompt("say PONG", nil, r.st)...)
	_, ev := r.until(t, agentadapter.EvSession)
	if ev.SessionID != "sess-fixed" {
		t.Fatalf("resume 신원: %q", ev.SessionID)
	}
	r.until(t, agentadapter.EvTurnEnd)
	r.send(r.proto.Prompt("/clear", nil, r.st)...)
	_, ev = r.until(t, agentadapter.EvReset)
	if ev.SessionID == "" || ev.SessionID == "sess-fixed" || r.st.SessionID != ev.SessionID {
		t.Fatalf("reset 은 신원을 바꾼다: %+v st=%s", ev, r.st.SessionID)
	}
}

// 세 프로토콜 판이 같은 시나리오를 돈다 (§9.2 R-a). 기동 argv 는 그 어댑터의 Launch 가
// 만든 것 그대로 — 가짜는 그 모양으로 판을 고른다.
func launchOf(t *testing.T, id string, o agentadapter.LaunchOpts) (*agentadapter.Proto, []string) {
	t.Helper()
	ad, err := agentadapter.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	o.Bin = "fake"
	return ad.Proto, ad.Proto.Launch(o)[1:]
}

func TestFake_AllProtocols(t *testing.T) {
	for _, id := range []string{"codex", "omp"} {
		t.Run(id, func(t *testing.T) {
			p, argv := launchOf(t, id, agentadapter.LaunchOpts{Model: "fake/fake-x"})
			r := startAs(t, id, argv...)
			r.send(p.Handshake(agentadapter.LaunchOpts{Cwd: "/w", Model: "fake/fake-x"}, r.st)...)
			_, ev := r.until(t, agentadapter.EvSession)
			if ev.SessionID == "" || ev.Status == nil || ev.Status.Model == "" {
				t.Fatalf("session: %+v", ev)
			}
			_, ev = r.until(t, agentadapter.EvStatus)
			for ev.Status == nil || len(ev.Status.Models) == 0 {
				_, ev = r.until(t, agentadapter.EvStatus)
			}
			if len(ev.Status.Models) != 2 {
				t.Fatalf("models: %+v", ev.Status)
			}
			r.send(p.Prompt("say PONG", nil, r.st)...)
			kinds, ev := r.until(t, agentadapter.EvTurnEnd)
			joined := strings.Join(kinds, ",")
			for _, want := range []string{"turn_start", "text_delta", "message", "usage", "turn_end"} {
				if !strings.Contains(joined, want) {
					t.Fatalf("PONG 턴에 %s 가 없다: %s", want, joined)
				}
			}
			if ev.IsError {
				t.Fatalf("성공 턴이 오류로 읽혔다: %+v", ev)
			}
			// 승인 왕복 (V-2).
			r.send(p.Prompt("APPROVE please", nil, r.st)...)
			_, ev = r.until(t, agentadapter.EvApprovalOpen)
			req := ev.Approval
			if req.Kind != agentadapter.ApprovalPermission || req.Tool == "" || len(req.Options) < 2 || req.Options[0].ID != agentadapter.ChoiceAllow {
				t.Fatalf("승인 요청: %+v", req)
			}
			frame, err := p.Approve(*req, agentadapter.Decision{Choice: agentadapter.ChoiceAllow}, r.st)
			if err != nil {
				t.Fatal(err)
			}
			r.send(frame)
			kinds, _ = r.until(t, agentadapter.EvTurnEnd)
			joined = strings.Join(kinds, ",")
			if !strings.Contains(joined, "tool_end") || !strings.Contains(joined, "text_delta") {
				t.Fatalf("도구 결과 · 본문이 있어야 한다: %s", joined)
			}
			if len(r.st.Open) != 0 {
				t.Fatalf("열린 요청이 남았다: %d", len(r.st.Open))
			}
			// 질문 (FR-AGT-4).
			r.send(p.Prompt("QUESTION", nil, r.st)...)
			_, ev = r.until(t, agentadapter.EvApprovalOpen)
			if ev.Approval.Kind != agentadapter.ApprovalQuestion || len(ev.Approval.Questions) != 1 || len(ev.Approval.Questions[0].Options) != 2 {
				t.Fatalf("질문: %+v", ev.Approval)
			}
			frame, err = p.Approve(*ev.Approval, agentadapter.Decision{Answers: map[string]string{"Pick a color": "Blue"}}, r.st)
			if err != nil {
				t.Fatal(err)
			}
			r.send(frame)
			_, ev = r.until(t, agentadapter.EvTextDelta)
			if ev.Text != "Blue" {
				t.Fatalf("답한 라벨을 되읊어야 한다: %q", ev.Text)
			}
			r.until(t, agentadapter.EvTurnEnd)
			// 인터럽트 (FR-AGT-4a) 와 죽음 (V-8).
			r.send(p.Prompt("SLOW", nil, r.st)...)
			r.until(t, agentadapter.EvTextDelta)
			r.send(p.Interrupt(r.st))
			kinds, ev = r.until(t, agentadapter.EvTurnEnd)
			joined = strings.Join(kinds, ",")
			if strings.Contains(joined, "slow done") || strings.Count(joined, "text_delta") >= 50 {
				t.Fatalf("인터럽트가 끊지 못했다: %s", joined)
			}
			r.send(p.Prompt("DIE", nil, r.st)...)
			select {
			case code := <-r.exited:
				if code != 1 {
					t.Fatalf("exit=%d", code)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("DIE 가 끝나지 않았다")
			}
		})
	}
}
