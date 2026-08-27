package gitapi

import (
	"net/http"
	"strings"
	"testing"
)

// 묶음 H 서버측 — Console 의 replay (GIT_ACTIONS_SRS §3.8 FR-GIT-281, 검증 V207).
//
// **핵심은 argv 를 클라이언트가 주지 않는다는 것이다.** 요청 구조체에 명령을 담을
// 자리가 없어야 하고, 서버는 자기 기록에서만 꺼낸다.

// RP1 (D6 와 같은 근거): 요청에 **명령을 담는 필드가 없다.** 있으면 그것이 곧 임의
// 실행 표면이고, 두 진입점(FR-GIT-95)을 우회하는 세 번째 길이 된다.
func TestGitReplayReq_HasNoCommandField(t *testing.T) {
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)
	// 기록을 하나 남긴다 — 준비 과정의 읽기가 그대로 기록이 된다 (FR-GIT-5).
	if code, _ := gitReq(t, s, http.MethodPost, "/api/git/checkout",
		`{"repo":"/work/repo","ref":"main"}`); code != http.StatusOK {
		t.Fatalf("준비 실패")
	}
	seq := lastReadSeq(t, s)

	// 요청에 명령을 함께 실어 보낸다. 모르는 키는 조용히 버려지고, 실행되는 것은
	// **기록의 argv** 뿐이어야 한다 — 필드가 생기는 순간 임의 실행 표면이 된다.
	body := `{"repo":"/work/repo","seq":` + itoa(seq) +
		`,"confirm":true,"argv":["push","--force"],"command":"rm -rf /"}`
	if code, _ := gitReq(t, s, http.MethodPost, "/api/git/records/replay", body); code != http.StatusOK {
		t.Fatalf("읽기 기록의 replay 가 %d 다", code)
	}
	// 기록은 읽기·쓰기 **전부**를 담는다 (FR-GIT-5) — 실행된 것이 있었다면 여기 남는다.
	for _, rec := range s.Git.Service().Records(0) {
		if strings.Contains(strings.Join(rec.Argv, " "), "--force") {
			t.Fatalf("클라이언트가 보낸 argv 가 실행됐다: %v", rec.Argv)
		}
	}
	_ = f
}

// RP2: 없는 기록은 404 다. 버퍼는 유한하므로 오래된 기록은 실제로 사라진다 —
// 실패가 아니라 사실이며, 사용자는 왜 안 되는지 알아야 한다.
func TestAPIGitReplay_MissingRecord(t *testing.T) {
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/records/replay",
		`{"repo":"/work/repo","seq":9999,"confirm":true}`)
	if code != http.StatusNotFound || out["error"] != gitErrRecordMissing {
		t.Fatalf("→ %d %v, want 404 %s", code, out["error"], gitErrRecordMissing)
	}
}

// RP3 (FR-GIT-89): 쓰기 기록은 `confirm:true` 없이 다시 돌지 않는다.
func TestAPIGitReplay_WriteRequiresConfirm(t *testing.T) {
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)
	// 먼저 쓰기를 하나 만들어 기록을 남긴다 — 기록의 출처는 실행 경로다.
	if code, _ := gitReq(t, s, http.MethodPost, "/api/git/checkout",
		`{"repo":"/work/repo","ref":"main"}`); code != http.StatusOK {
		t.Fatalf("준비 실패: checkout → %d", code)
	}
	seq := lastWriteSeq(t, s)

	before := len(f.wrote())
	code, out := gitReq(t, s, http.MethodPost, "/api/git/records/replay",
		`{"repo":"/work/repo","seq":`+itoa(seq)+`}`)
	if code != http.StatusBadRequest || out["error"] != gitErrConfirmRequired {
		t.Fatalf("→ %d %v, want 400 %s", code, out["error"], gitErrConfirmRequired)
	}
	if len(f.wrote()) != before {
		t.Fatal("확인 없이 다시 실행됐다")
	}
}

// RP4: 확인이 있으면 **기록의 argv 그대로** 다시 돈다.
func TestAPIGitReplay_RunsRecordedArgv(t *testing.T) {
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)
	if code, _ := gitReq(t, s, http.MethodPost, "/api/git/checkout",
		`{"repo":"/work/repo","ref":"main"}`); code != http.StatusOK {
		t.Fatalf("준비 실패")
	}
	seq := lastWriteSeq(t, s)
	before := f.wrote()

	code, out := gitReq(t, s, http.MethodPost, "/api/git/records/replay",
		`{"repo":"/work/repo","seq":`+itoa(seq)+`,"confirm":true}`)
	if code != http.StatusOK || out["ok"] != true {
		t.Fatalf("→ %d %v", code, out)
	}
	after := f.wrote()
	if len(after) != len(before)+1 {
		t.Fatalf("쓰기가 %d→%d 회다", len(before), len(after))
	}
	got := strings.Join(after[len(after)-1], " ")
	want := strings.Join(before[len(before)-1], " ")
	if got != want {
		t.Fatalf("argv = %q, want %q (기록 그대로여야 한다)", got, want)
	}
}

// RP5: 라우트가 등록돼 있고 Git 이 없으면 503 이다.
func TestAPIGitReplay_RouteRegisteredAndUnavailable(t *testing.T) {
	found := false
	for _, rt := range routes {
		if rt.method == http.MethodPost && rt.match("/api/git/records/replay") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("/api/git/records/replay 가 gitapi.routes 에 없다")
	}
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	code, out := gitReq(t, s, http.MethodPost, "/api/git/records/replay",
		`{"repo":"/work/repo","seq":1,"confirm":true}`)
	if code != http.StatusServiceUnavailable || out["error"] != gitErrUnavailable {
		t.Fatalf("→ %d %v, want 503", code, out["error"])
	}
}

// lastReadSeq 는 마지막 읽기 기록의 seq 다 — 읽기는 confirm 없이 다시 돈다.
func lastReadSeq(t *testing.T, s *GitServer) uint64 {
	t.Helper()
	recs := s.Git.Service().Records(0)
	for i := len(recs) - 1; i >= 0; i-- {
		if !recs[i].Write {
			return recs[i].Seq
		}
	}
	t.Fatal("읽기 기록이 없다")
	return 0
}

// lastWriteSeq 는 방금 남은 쓰기 기록의 seq 다.
func lastWriteSeq(t *testing.T, s *GitServer) uint64 {
	t.Helper()
	recs := s.Git.Service().Records(0)
	for i := len(recs) - 1; i >= 0; i-- {
		if recs[i].Write {
			return recs[i].Seq
		}
	}
	t.Fatal("쓰기 기록이 없다")
	return 0
}

func itoa(n uint64) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
