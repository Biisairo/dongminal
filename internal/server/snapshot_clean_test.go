package server

import "testing"

// 스냅샷 재생이 클라이언트 터미널의 자동응답을 유발하면 그 응답은 셸의 **입력**이
// 된다. 질의를 남긴 프로그램은 이미 사라졌으므로 재생분은 전부 제거 대상이다.
func TestStripSnapshotQueries_RemovesReplyInducingSequences(t *testing.T) {
	cases := []struct{ name, in string }{
		{"DA 무인자 ESC[c", "\x1b[c"},
		{"DA ESC[0c", "\x1b[0c"},
		{"DA2 질의 ESC[>c", "\x1b[>c"},
		{"DA2 질의 ESC[>0c", "\x1b[>0c"},
		{"DA 응답 ESC[?62;4;6;22c", "\x1b[?62;4;6;22c"},
		{"DSR ESC[5n", "\x1b[5n"},
		{"CPR 질의 ESC[6n", "\x1b[6n"},
		// 실측(2026-08-25): 실행 중인 TUI 가 이 질의를 계속 내보내 스냅샷
		// 400KB 에 1400여 건이 쌓였고, 새로고침마다 그만큼의 응답이 셸에
		// 입력으로 꽂혔다. 옛 패턴은 `?` 접두를 잡지 못했다.
		{"DECXCPR 질의 ESC[?6n", "\x1b[?6n"},
		{"DECXCPR 응답 ESC[?56;9R", "\x1b[?56;9R"},
		{"CPR 응답 ESC[24;80R", "\x1b[24;80R"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := string(stripSnapshotQueries([]byte("전" + c.in + "후")))
			if got != "전후" {
				t.Fatalf("남았다: %q", got)
			}
		})
	}
}

// 반증: 질의가 아닌 일반 출력까지 지우면 화면이 깨진다.
func TestStripSnapshotQueries_KeepsOrdinaryOutput(t *testing.T) {
	keep := []struct{ name, in string }{
		{"색상 SGR", "\x1b[1;32m초록\x1b[0m"},
		{"화면 지우기", "\x1b[2J\x1b[H"},
		{"커서 이동", "\x1b[3A\x1b[10;20H"},
		{"커서 표시", "\x1b[?25h\x1b[?25l"},
		{"대체 화면", "\x1b[?1049h\x1b[?1049l"},
		{"bracketed paste", "\x1b[?2004h\x1b[?2004l"},
		{"커서 모양", "\x1b[5 q"},
		{"평문 n·c·R", "concurrent R"},
	}
	for _, c := range keep {
		t.Run(c.name, func(t *testing.T) {
			if got := string(stripSnapshotQueries([]byte(c.in))); got != c.in {
				t.Fatalf("지워졌다: %q → %q", c.in, got)
			}
		})
	}
}

// OSC 777 제거는 기존 계약이다 (FR-A1). 질의 제거를 넓히며 깨지지 않았는지 함께 본다.
func TestStripOSC777_UnaffectedByQueryStripping(t *testing.T) {
	in := []byte("앞\x1b]777;notify;done\x07뒤\x1b[1;32m색\x1b[0m")
	got := string(stripSnapshotQueries(stripOSC777(in)))
	if got != "앞뒤\x1b[1;32m색\x1b[0m" {
		t.Fatalf("예상 밖: %q", got)
	}
}
