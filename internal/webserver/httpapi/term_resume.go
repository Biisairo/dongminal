package httpapi

import (
	"bytes"
	"encoding/binary"
	"net/http"
	"strconv"

	"dongminal/internal/shared/outbuf"
)

// 재접속은 이어 붙이는 것이지 다시 뿌리는 것이 아니다 (TERMINAL_RESUME_SRS).
//
// 붙는 쪽의 xterm 인스턴스는 재접속 너머로 **살아남는다** (SOFT_RELOAD_SRS D-3).
// 그러므로 스크롤백을 매번 되뿌리면 화면에 이미 있는 것 위에 같은 것이 한 번 더
// 그려진다 — 접수한 증상 "이전 글자가 보이고 글자가 중복으로 출력된다" 가 그것이다
// (SRS §2.2). 이 파일은 그 되뿌리기를 두 갈래로 가른다:
//
//	델타 재개 — 클라이언트가 마지막으로 본 오프셋 뒤만 보낸다. 화면을 지우지 않는다
//	전량 재생 — 재개할 수 없을 때만. **반드시 화면과 스크롤백을 지우고** 보낸다
//
// 전량 재생에 클리어가 앞서는 것이 요점이다 (FR-TRS-11). 그래야 재생이 멱등이
// 되고, 무엇이 그려져 있었든 결과가 같아진다.

// termReset 은 이전 연결이 켜 둔 터미널 모드를 끈다 — 마우스 보고(?9·?1000~?1006·?1015),
// 괄호 붙여넣기(?2004), 대체 화면(?1049·?47·?1047), 커서 감춤·깜빡임(?25h·?12l),
// 자동 개행(?20l). direct 모드와 daemon 모드가 **같은 값을 보내야** 하므로 한 곳에 둔다.
var termReset = []byte("\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1049l\x1b[?47l\x1b[?1047l\x1b[?25h\x1b[?12l\x1b[20l")

// termHardClear 는 전량 재생이 멱등이 되게 하는 네 시퀀스다 (FR-TRS-10 ②).
//
//	?1049l — 대체 화면에서 나온다. 여기서 지워야 주 화면이 대상이 된다
//	H      — 커서를 홈으로. 재생은 좌상단에서 시작해야 한다
//	2J     — 보이는 화면
//	3J     — **스크롤백.** 이것이 없으면 위로 밀린 이전 내용이 그대로 남는다
var termHardClear = []byte("\x1b[?1049l\x1b[H\x1b[2J\x1b[3J")

// trsAlignScan 은 앞머리 정렬이 개행을 찾는 상한이다 (FR-TRS-13).
const trsAlignScan = 4 << 10

// alignHead 는 바이트 tail 의 잘린 앞머리를 안전한 경계까지 민다 (FR-TRS-13).
//
// `outbuf.Stream` 은 tail 을 바이트로 자른다 — 시퀀스 경계도 UTF-8 경계도 보지
// 않으므로, 보유량이 상한을 채운 도구의 스냅샷은 **항상** 반쪽 CSI 로 시작한다
// (SRS §2.3). 그 상태로 재생하면 파서가 어긋나 뒤의 몇 바이트를 제어로 먹는다.
//
// 판정은 첫 `\n` 이다. 그 바이트는 UTF-8 연속 바이트(0x80~0xBF)로 나타날 수 없고
// CSI 의 파라미터·중간·최종 바이트 범위에도 없으므로, **바로 뒤가 문자 경계이자
// 시퀀스 경계임이 보장된다.**
//
// 상한 안에 없으면 밀지 않는다 — 미는 것보다 두는 것이 낫다. 개행 없이 4 KiB 를
// 넘기는 출력은 대개 TUI 의 전체 재그리기이고, 그것은 앞을 잃으면 통째로 깨진다.
func alignHead(b []byte) []byte {
	scan := len(b)
	if scan > trsAlignScan {
		scan = trsAlignScan
	}
	if i := bytes.IndexByte(b[:scan], '\n'); i >= 0 {
		return b[i+1:]
	}
	return b
}

// buildReplay 는 한 번의 접속이 `OpOutput` 으로 보낼 바이트를 조립한다.
//
// **direct 모드와 daemon 모드가 이 함수 하나를 함께 쓴다** (FR-TRS-12). 두 벌로
// 두었던 것이 "한쪽만 고쳐지는" 자리였다 — 종전에 daemon 은 termReset 을 스냅샷
// 앞에, direct 는 뒤에, 그것도 `Restored` 일 때만 보냈다 (SRS §2.4).
func buildReplay(data []byte, full bool) []byte {
	// 델타도 **기록**이지 라이브가 아니다. 그 구간의 질의에 지금 답하면
	// architecture.md 가 적은 `56;9R` 폭주가 그대로 돌아온다 (FR-TRS-5).
	body := stripSnapshotQueries(stripOSC777(data))
	if !full {
		// 델타의 시작은 이전 연결이 정확히 끊은 자리이므로 이미 경계다.
		// 밀면 바이트를 잃는다 (FR-TRS-14).
		return body
	}
	body = alignHead(body)
	out := make([]byte, 0, len(termReset)+len(termHardClear)+len(body))
	out = append(out, termReset...)
	out = append(out, termHardClear...)
	return append(out, body...)
}

// seqPayload 는 `OpSeq` 의 9 바이트다 (FR-TRS-6): 오프셋 8(빅엔디언) + 플래그 1.
//
// 플래그가 필요한 이유는 클라이언트가 **전량 재생 뒤에만** 재그리기 넛지를 보내야
// 하기 때문이다 (FR-TRS-18). 델타 재개에는 넛지가 필요 없고 리플로우만 만든다.
func seqPayload(offset int64, full bool) []byte {
	p := make([]byte, 9)
	binary.BigEndian.PutUint64(p[:8], uint64(offset))
	if full {
		p[8] = 1
	}
	return p
}

// trimOverlap 은 이미 보낸 구간과 겹치는 라이브 청크의 앞부분을 잘라낸다
// (FR-TRS-16).
//
// 구독은 스냅샷 **앞에** 선다 — 그래야 RPC 왕복(실측 38 ms) 동안의 출력이 사라지지
// 않는다. 그 대가가 겹침이고, 종전 주석은 그것을 "harmless" 라 적었다. TUI 에는
// harmless 가 아니다 (SRS §2.5). 좌표가 있으므로 이제 정확히 잘라낼 수 있다.
//
// end 는 청크의 **끝** 오프셋이므로 청크가 덮는 구간은 `[end-len, end)` 다.
// end<=0(옛 데몬의 이벤트) 이거나 offset<0(통보 전) 이면 판정할 근거가 없다 —
// 손대지 않는다. 지금 동작과 같아질 뿐 나빠지지 않는다 (FR-TRS-15).
func trimOverlap(chunk []byte, end, offset int64) []byte {
	if end <= 0 || offset < 0 {
		return chunk
	}
	start := end - int64(len(chunk))
	if offset <= start {
		return chunk
	}
	if offset >= end {
		return nil
	}
	return chunk[offset-start:]
}

// parseSince 는 `/ws?since=` 를 읽는다 (FR-TRS-3).
//
// 값이 없거나 해석되지 않으면 **전량 재생**이다. 오류가 아니다 — 배포가 닿지 않은
// 옛 탭은 이 인자를 보내지 않으며, 그 탭의 동작은 지금과 같아야 한다.
func parseSince(r *http.Request) (int64, bool) {
	raw := r.URL.Query().Get("since")
	if raw == "" {
		return 0, false
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || v < 0 {
		return 0, false
	}
	return v, true
}

// directReplay 는 direct 모드가 재생할 바이트와 그 갈래를 정한다 (FR-TRS-17).
//
// **재생은 등록 오프셋에서 멈춘다.** 그 자리부터는 `readPTY` 의 broadcast 가 이
// 소켓에 직접 나르므로, 넘긴 만큼이 그대로 두 번 보인다. daemon 모드에는 이
// 경계가 없다 — 거기서는 릴레이가 `trimOverlap` 으로 같은 일을 한다.
func directReplay(st *outbuf.Stream, since, regOff int64) (data []byte, full bool) {
	if st == nil {
		return nil, true
	}
	if since >= 0 && since <= regOff {
		if d, _, ok := st.Since(since); ok {
			return clampReplay(d, since, regOff), false
		}
	}
	d, stats := st.Snapshot()
	return clampReplay(d, stats.TotalBytesIn-int64(len(d)), regOff), true
}

// clampReplay 는 `[start, …)` 를 덮는 재생분을 regOff 에서 자른다.
func clampReplay(d []byte, start, regOff int64) []byte {
	keep := regOff - start
	if keep <= 0 {
		return nil
	}
	if keep >= int64(len(d)) {
		return d
	}
	return d[:keep]
}
