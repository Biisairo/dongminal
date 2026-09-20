package httpapi

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"dongminal/internal/shared/outbuf"
	"dongminal/internal/shared/toolhub"
)

// ── FR-TRS-13·14: 앞머리 정렬 ──────────────────────────────────────────────

// V-TRS-11: 잘린 앞머리는 첫 \n **다음** 바이트부터다.
func TestAlignHead_SkipsToFirstNewline(t *testing.T) {
	// 반쪽 CSI 로 시작하는 tail — 보유량이 상한을 채운 도구의 실제 모양이다.
	in := []byte("2;34m깨진앞머리\nOK부터\n뒤")
	got := alignHead(in)
	if string(got) != "OK부터\n뒤" {
		t.Errorf("alignHead=%q want %q", got, "OK부터\n뒤")
	}
}

// V-TRS-11: 상한 안에 \n 이 없으면 밀지 않는다 — 미는 것보다 두는 것이 낫다.
func TestAlignHead_NoNewlineWithinScan(t *testing.T) {
	in := bytes.Repeat([]byte("x"), trsAlignScan+100)
	got := alignHead(in)
	if len(got) != len(in) {
		t.Errorf("len=%d want %d (밀면 안 된다)", len(got), len(in))
	}
}

// V-TRS-11: \n 이 상한 **밖**에 있으면 역시 밀지 않는다.
func TestAlignHead_NewlineBeyondScan(t *testing.T) {
	in := append(bytes.Repeat([]byte("x"), trsAlignScan+10), '\n', 'a')
	got := alignHead(in)
	if len(got) != len(in) {
		t.Errorf("len=%d want %d", len(got), len(in))
	}
}

// V-TRS-11: 첫 바이트가 \n 이면 그 다음부터다.
func TestAlignHead_LeadingNewline(t *testing.T) {
	if got := alignHead([]byte("\nabc")); string(got) != "abc" {
		t.Errorf("alignHead=%q want %q", got, "abc")
	}
}

func TestAlignHead_Empty(t *testing.T) {
	if got := alignHead(nil); len(got) != 0 {
		t.Errorf("alignHead=%q want empty", got)
	}
}

// ── FR-TRS-5·10·11·12·14: 재생 바이트 조립 ────────────────────────────────

// V-TRS-7: 전량 재생은 termReset → 하드 클리어 → 스냅샷 순서다.
func TestBuildReplay_FullOrder(t *testing.T) {
	got := buildReplay([]byte("\nBODY"), true)
	iReset := bytes.Index(got, termReset)
	iClear := bytes.Index(got, termHardClear)
	iBody := bytes.Index(got, []byte("BODY"))
	if iReset != 0 {
		t.Errorf("termReset 가 맨 앞이 아니다: %d", iReset)
	}
	if !(iReset < iClear && iClear < iBody) {
		t.Errorf("순서가 틀렸다: reset=%d clear=%d body=%d", iReset, iClear, iBody)
	}
}

// V-TRS-7: 화면과 스크롤백을 모두 지운다. ED 2 만으로는 위로 밀린 것이 남는다.
func TestBuildReplay_FullClearsScreenAndScrollback(t *testing.T) {
	got := buildReplay([]byte("\nx"), true)
	for _, want := range []string{"\x1b[2J", "\x1b[3J", "\x1b[?1049l", "\x1b[H"} {
		if !bytes.Contains(got, []byte(want)) {
			t.Errorf("전량 재생에 %q 가 없다", want)
		}
	}
}

// V-TRS-8: 델타 재개는 **지우지 않는다.** 지우면 사용자가 보던 것이 사라진다.
func TestBuildReplay_DeltaHasNoClear(t *testing.T) {
	got := buildReplay([]byte("delta"), false)
	if bytes.Contains(got, termHardClear) || bytes.Contains(got, termReset) {
		t.Errorf("델타에 클리어가 섞였다: %q", got)
	}
	if string(got) != "delta" {
		t.Errorf("got=%q want %q", got, "delta")
	}
}

// V-TRS-12: 델타에는 앞머리 정렬이 걸리지 않는다 — 밀면 바이트를 잃는다.
func TestBuildReplay_DeltaNotAligned(t *testing.T) {
	got := buildReplay([]byte("앞\n뒤"), false)
	if string(got) != "앞\n뒤" {
		t.Errorf("got=%q want %q (정렬하면 안 된다)", got, "앞\n뒤")
	}
}

// V-TRS-9: 델타도 **기록**이다. OSC777·질의 필터가 걸려야 한다.
func TestBuildReplay_DeltaIsFiltered(t *testing.T) {
	got := buildReplay([]byte("a\x1b]777;Cwd;/tmp\x07b\x1b[?6nc"), false)
	if string(got) != "abc" {
		t.Errorf("got=%q want %q", got, "abc")
	}
}

// V-TRS-9a: 접수된 증상 그대로의 재료다 (2026-09-20). 앱이 기동할 때 낸 질의
// 한 벌이 스냅샷에 남아 있으면, 다시 붙은 xterm 이 그것들에 답해
// `11;rgb:…2026;0$y2048;0$y…` 가 셸의 입력으로 꽂힌다.
func TestBuildReplay_StripsStartupProbes(t *testing.T) {
	probes := "\x1b]11;?\x07" +
		"\x1b[?2026$p" + "\x1b[?2048$p" + "\x1b[?2031$p" +
		"\x1b[?1010$p" + "\x1b[?1011$p" +
		"\x1bP$q q\x1b\\"
	got := buildReplay([]byte("$ claude"+probes+"\nready"), false)
	if string(got) != "$ claude\nready" {
		t.Fatalf("질의가 남았다: %q", got)
	}
}

// V-TRS-9: 전량 재생도 같은 필터를 지난다.
func TestBuildReplay_FullIsFiltered(t *testing.T) {
	got := buildReplay([]byte("\na\x1b]777;Cwd;/tmp\x07b"), true)
	if bytes.Contains(got, []byte("777")) {
		t.Errorf("OSC777 이 남았다: %q", got)
	}
}

// 보낼 것이 없는 델타는 빈 바이트다 — 호출자는 프레임 자체를 보내지 않는다.
func TestBuildReplay_EmptyDelta(t *testing.T) {
	if got := buildReplay(nil, false); len(got) != 0 {
		t.Errorf("got=%q want empty", got)
	}
}

// ── FR-TRS-6: OpSeq 프레임 ────────────────────────────────────────────────

// V-TRS-10: 9 바이트, 빅엔디언 오프셋 + 플래그.
func TestSeqPayload(t *testing.T) {
	p := seqPayload(0x0102030405060708, true, false)
	if len(p) != 9 {
		t.Fatalf("len=%d want 9", len(p))
	}
	if got := int64(binary.BigEndian.Uint64(p[:8])); got != 0x0102030405060708 {
		t.Errorf("offset=%#x want %#x", got, 0x0102030405060708)
	}
	// 전량만이면 종전과 **같은 바이트**다 — 비트로 넓혔을 뿐 뜻을 바꾸지 않았다.
	if p[8] != 1 {
		t.Errorf("flag=%d want 1", p[8])
	}
	if p2 := seqPayload(0, false, false); p2[8] != 0 {
		t.Errorf("flag=%d want 0", p2[8])
	}
}

// V-TRS-17c (FR-TRS-18b): alt screen 은 **비트 하나**로 실린다. 넛지를 걸지 말지를
// 브라우저가 가르려면 그 사실이 건너가야 하고, 브라우저는 PTY 출력을 보지 않는다.
func TestSeqPayload_AltScreenBit(t *testing.T) {
	cases := []struct {
		full, alt bool
		want      byte
	}{
		{false, false, 0},
		{true, false, 1},
		{false, true, 2},
		{true, true, 3},
	}
	for _, c := range cases {
		if got := seqPayload(0, c.full, c.alt)[8]; got != c.want {
			t.Errorf("full=%v alt=%v → flag=%d want %d", c.full, c.alt, got, c.want)
		}
	}
}

// op 코드가 기존 것과 겹치면 옛 클라이언트가 다른 뜻으로 읽는다.
func TestOpSeq_DoesNotCollide(t *testing.T) {
	for _, op := range []byte{toolhub.OpOutput, toolhub.OpError, toolhub.OpExit, toolhub.OpToolID} {
		if toolhub.OpSeq == op {
			t.Fatalf("OpSeq=%#x 가 기존 op 와 겹친다", toolhub.OpSeq)
		}
	}
}

// ── FR-TRS-16: 겹침 제거 ──────────────────────────────────────────────────

// V-TRS-13: 통보한 오프셋보다 완전히 앞선 청크는 버린다.
func TestTrimOverlap_WhollyBefore(t *testing.T) {
	// 청크가 [10,15) 를 덮고 클라이언트는 이미 20 까지 봤다.
	if got := trimOverlap([]byte("abcde"), 15, 20); got != nil {
		t.Errorf("got=%q want nil", got)
	}
}

// V-TRS-13: 걸친 청크는 앞부분만 잘린다.
func TestTrimOverlap_Straddles(t *testing.T) {
	// 청크가 [10,15) 를 덮고 클라이언트는 12 까지 봤다 → "cde" 만 남는다.
	if got := trimOverlap([]byte("abcde"), 15, 12); string(got) != "cde" {
		t.Errorf("got=%q want %q", got, "cde")
	}
}

// V-TRS-13: 완전히 뒤선 청크는 그대로 간다.
func TestTrimOverlap_WhollyAfter(t *testing.T) {
	if got := trimOverlap([]byte("abcde"), 15, 10); string(got) != "abcde" {
		t.Errorf("got=%q want %q", got, "abcde")
	}
}

// V-TRS-14: end 를 모르는 이벤트(옛 데몬)는 손대지 않는다 — 지금 동작 그대로다.
func TestTrimOverlap_UnknownEnd(t *testing.T) {
	if got := trimOverlap([]byte("abcde"), 0, 999); string(got) != "abcde" {
		t.Errorf("got=%q want %q (end=0 이면 건너뛴다)", got, "abcde")
	}
}

// 오프셋을 모르면(전량 재생 직후 통보 전) 손대지 않는다.
func TestTrimOverlap_UnknownOffset(t *testing.T) {
	if got := trimOverlap([]byte("abcde"), 15, -1); string(got) != "abcde" {
		t.Errorf("got=%q want %q", got, "abcde")
	}
}

// ── FR-TRS-3: since 파싱 ──────────────────────────────────────────────────

// V-TRS-6: since 가 없거나 해석되지 않으면 전량 재생이다. 오류가 아니다.
func TestParseSince(t *testing.T) {
	cases := []struct {
		q    string
		want int64
		ok   bool
	}{
		{"", 0, false},
		{"?since=", 0, false},
		{"?since=abc", 0, false},
		{"?since=-1", 0, false},
		{"?since=0", 0, true},
		{"?since=1048576", 1048576, true},
		{"?since=9007199254740991", 9007199254740991, true}, // JS Number.MAX_SAFE_INTEGER
		{"?since=99999999999999999999", 0, false},           // overflow
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/ws"+c.q, nil)
		got, ok := parseSince(r)
		if got != c.want || ok != c.ok {
			t.Errorf("parseSince(%q)=(%d,%v) want (%d,%v)", c.q, got, ok, c.want, c.ok)
		}
	}
}

// ── 회귀 방벽 ─────────────────────────────────────────────────────────────

// FR-TRS-12: direct 모드와 daemon 모드가 **같은 바이트**를 보낸다. 두 경로가
// 따로 조립하면 한쪽만 고쳐지는 자리가 다시 생긴다 (§2.4).
func TestBuildReplay_IsTheOnlyAssembler(t *testing.T) {
	raw, err := os.ReadFile("handlers_ws.go")
	if err != nil {
		t.Fatalf("read handlers_ws.go: %v", err)
	}
	src := string(raw)
	if strings.Count(src, "buildReplay(") < 2 {
		t.Error("두 모드가 buildReplay 를 함께 쓰지 않는다")
	}
	if strings.Contains(src, "tool.Restored") || strings.Contains(src, "Restored =") {
		t.Error("FR-TRS-12·D-6: Restored 조건부 termReset 이 남아 있다")
	}
}

// ── FR-TRS-17: direct 모드의 재생 경계 ────────────────────────────────────

func newStream(t *testing.T, max int) *outbuf.Stream {
	t.Helper()
	s := outbuf.NewStream(context.Background(), max)
	t.Cleanup(s.Close)
	return s
}

// V-TRS-15: 재생은 **등록 오프셋에서 멈춘다.** 그 뒤는 broadcast 가 나르므로
// 넘긴 만큼이 그대로 두 번 보인다.
func TestDirectReplay_StopsAtRegistrationOffset(t *testing.T) {
	s := newStream(t, 1000)
	s.Feed([]byte("AAAAA")) // [0,5)  — 등록 전
	regOff := s.Offset()
	s.Feed([]byte("BBBBB")) // [5,10) — 등록 후, broadcast 가 나른다
	data, full := directReplay(s, -1, regOff)
	if !full {
		t.Error("since 가 없으면 전량 재생이다")
	}
	if string(data) != "AAAAA" {
		t.Errorf("data=%q want %q (등록 오프셋을 넘었다)", data, "AAAAA")
	}
}

// V-TRS-15: 델타 재개도 같은 경계를 지킨다.
func TestDirectReplay_DeltaStopsAtRegistrationOffset(t *testing.T) {
	s := newStream(t, 1000)
	s.Feed([]byte("0123456789")) // 클라이언트는 3 까지 봤다
	regOff := s.Offset()         // 10
	s.Feed([]byte("XYZ"))        // [10,13) — broadcast 몫
	data, full := directReplay(s, 3, regOff)
	if full {
		t.Error("full=true, want false (창 안이다)")
	}
	if string(data) != "3456789" {
		t.Errorf("data=%q want %q", data, "3456789")
	}
}

// V-TRS-15: 겹침도 빈틈도 없다 — 재생 + broadcast 가 원본과 정확히 같다.
func TestDirectReplay_NoGapNoOverlap(t *testing.T) {
	s := newStream(t, 1000)
	s.Feed([]byte("hello "))
	regOff := s.Offset()
	s.Feed([]byte("world"))
	replay, _ := directReplay(s, 0, regOff)
	// broadcast 가 등록 오프셋 뒤의 청크를 그대로 나른다.
	if got := string(replay) + "world"; got != "hello world" {
		t.Errorf("이어 붙인 결과=%q want %q", got, "hello world")
	}
}

// V-TRS-15: 창 밖 since 는 전량 재생으로 조용히 강등된다.
func TestDirectReplay_OutsideWindowFallsBack(t *testing.T) {
	s := newStream(t, 100)
	s.Feed(bytes.Repeat([]byte("x"), 250)) // 보유 창은 [150,250)
	regOff := s.Offset()
	data, full := directReplay(s, 0, regOff)
	if !full {
		t.Error("full=false, want true (창 밖이면 전량)")
	}
	if len(data) != 100 {
		t.Errorf("len=%d want 100", len(data))
	}
}

// 완전 동기 상태로 붙으면 보낼 것이 없다 — 화면을 건드리지 않는다.
func TestDirectReplay_AlreadyInSync(t *testing.T) {
	s := newStream(t, 1000)
	s.Feed([]byte("abc"))
	regOff := s.Offset()
	data, full := directReplay(s, regOff, regOff)
	if full {
		t.Error("full=true, want false")
	}
	if len(data) != 0 {
		t.Errorf("data=%q want empty", data)
	}
}

func TestDirectReplay_NilStream(t *testing.T) {
	if data, full := directReplay(nil, 0, 0); data != nil || !full {
		t.Errorf("data=%q full=%v want nil true", data, full)
	}
}

// ── FR-TRS-3·4·6·10: 실제 소켓 왕복 ──────────────────────────────────────

// readFrames 는 op 가 나올 때까지 프레임을 읽어 모은다.
func readUntilOp(t *testing.T, ws *websocket.Conn, op byte) (before [][]byte, frame []byte) {
	t.Helper()
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < 64; i++ {
		_, msg, err := ws.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if len(msg) > 0 && msg[0] == op {
			return before, msg
		}
		before = append(before, msg)
	}
	t.Fatalf("op %#x 가 오지 않았다", op)
	return nil, nil
}

func outputBytes(frames [][]byte) []byte {
	var out []byte
	for _, f := range frames {
		if len(f) > 0 && f[0] == toolhub.OpOutput {
			out = append(out, f[1:]...)
		}
	}
	return out
}

// V-TRS-6: since 없이 붙으면 전량 재생이고, 클리어가 스냅샷 앞에 온다.
// V-TRS-10: 좌표가 OpSeq 로 통보되고 플래그가 전량 재생을 가리킨다.
func TestHandleWS_FirstConnectIsFullReplay(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	p, err := pm.Create("", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatalf("create tool: %v", err)
	}
	defer pm.Delete(p.ID)
	waitForShellReady(t, func() int { blob, _ := p.Stream().Snapshot(); return len(blob) })

	ws := mustWS(t, ts, "/ws?cols=80&rows=24&tool="+p.ID)
	defer ws.Close()

	before, seq := readUntilOp(t, ws, toolhub.OpSeq)
	if len(seq) != 10 {
		t.Fatalf("OpSeq 길이=%d want 10", len(seq))
	}
	if seq[9] != 1 {
		t.Errorf("full 플래그=%d want 1 (since 가 없었다)", seq[9])
	}
	body := outputBytes(before)
	iClear := bytes.Index(body, termHardClear)
	if iClear < 0 {
		t.Fatal("전량 재생에 하드 클리어가 없다")
	}
	if i := bytes.Index(body, termReset); i < 0 || i > iClear {
		t.Errorf("termReset 가 클리어 앞에 있지 않다: reset=%d clear=%d", i, iClear)
	}
	off := int64(binary.BigEndian.Uint64(seq[1:9]))
	if off <= 0 {
		t.Errorf("통보된 오프셋=%d want >0", off)
	}
}

// V-TRS-8: 통보받은 좌표로 다시 붙으면 **클리어가 없고**, 그 좌표까지의 내용이
// 다시 오지 않는다. 이것이 접수한 증상이 사라지는 자리다 (SRS §2.2).
func TestHandleWS_ResumeSendsNoClearAndNoDuplicate(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	p, err := pm.Create("", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatalf("create tool: %v", err)
	}
	defer pm.Delete(p.ID)
	waitForShellReady(t, func() int { blob, _ := p.Stream().Snapshot(); return len(blob) })

	ws1 := mustWS(t, ts, "/ws?cols=80&rows=24&tool="+p.ID)
	first, seq := readUntilOp(t, ws1, toolhub.OpSeq)
	off := int64(binary.BigEndian.Uint64(seq[1:9]))
	ws1.Close()
	seen := outputBytes(first)

	// 그 좌표에서 이어 붙인다. 사이에 새 출력은 없다.
	ws2 := mustWS(t, ts, "/ws?cols=80&rows=24&tool="+p.ID+"&since="+strconv.FormatInt(off, 10))
	defer ws2.Close()
	before, seq2 := readUntilOp(t, ws2, toolhub.OpSeq)
	if seq2[9] != 0 {
		t.Errorf("full 플래그=%d want 0 (이어 붙였어야 한다)", seq2[9])
	}
	body := outputBytes(before)
	if bytes.Contains(body, termHardClear) {
		t.Error("델타 재개가 화면을 지웠다")
	}
	if bytes.Contains(body, termReset) {
		t.Error("델타 재개가 터미널 모드를 초기화했다")
	}
	/**
	 * **재는 것은 중복이지 침묵이 아니다** (검사 이름 그대로).
	 *
	 * 종전에는 `len(body) != 0` 으로 *"아무것도 오지 않았다"* 를 요구했다. 그것은
	 * 셸이 두 접속 사이에 **한 글자도 내지 않는다**는 전제인데, 살아 있는 셸은
	 * 언제든 낼 수 있다 — Windows 러너에서 pwsh 가 늦게 낸 오류 한 줄에 이 검사가
	 * 졌다 (2026-09-16: `.: The module 'bin' could not be loaded.` 98 바이트).
	 * 그것은 **새 출력**이지 중복이 아니다.
	 *
	 * 그러므로 *이미 본 바이트가 다시 왔는가* 를 묻는다. 좌표까지의 내용이 다시
	 * 오는 것이 접수한 증상이고(SRS §2.2), 이 단언이 그것을 그대로 잡는다.
	 */
	if len(seen) > 0 && bytes.Contains(body, seen) {
		t.Errorf("좌표까지의 내용이 다시 왔다: %d 바이트", len(seen))
	}
}

// V-TRS-6: 창 밖 좌표는 조용히 전량 재생으로 강등된다. 오류가 아니다.
func TestHandleWS_StaleSinceFallsBackToFull(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	p, err := pm.Create("", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatalf("create tool: %v", err)
	}
	defer pm.Delete(p.ID)
	waitForShellReady(t, func() int { blob, _ := p.Stream().Snapshot(); return len(blob) })

	// 도구가 낸 것보다 훨씬 뒤의 좌표 — 좌표계가 다르다는 뜻이다.
	ws := mustWS(t, ts, "/ws?cols=80&rows=24&tool="+p.ID+"&since=999999999")
	defer ws.Close()
	before, seq := readUntilOp(t, ws, toolhub.OpSeq)
	if seq[9] != 1 {
		t.Errorf("full 플래그=%d want 1", seq[9])
	}
	if !bytes.Contains(outputBytes(before), termHardClear) {
		t.Error("강등된 전량 재생에 클리어가 없다")
	}
}
