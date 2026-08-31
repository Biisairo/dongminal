package gitapi

import (
	"context"
	"net/http"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/write"
)

// /api/git/records/replay — Console 의 replay (GIT_ACTIONS_SRS §3.8 / FR-GIT-281).
//
// **클라이언트는 `seq` 만 보낸다.** argv 는 서버가 자기 기록에서 꺼낸다 — 문자열을
// 받아 실행하면 그것이 임의 명령 표면이 되고, git 실행의 두 진입점(FR-GIT-95)을
// 우회하는 세 번째 길이 생긴다.

const (
	// gitErrRecordMissing 은 그 seq 의 기록이 이 저장소에 없다는 것이다. 버퍼는
	// 유한하므로(FR-GIT-5) 오래된 기록은 실제로 사라진다 — 실패가 아니라 사실이다.
	gitErrRecordMissing = apierr.CodeRecordMissing
)

type gitReplayReq struct {
	Repo    string `json:"repo"`
	Seq     uint64 `json:"seq"`
	Confirm bool   `json:"confirm"`
}

// POST /api/git/records/replay — 기록 하나를 다시 실행한다.
//
// **쓰기 기록은 `confirm:true` 없이 다시 돌리지 않는다.** 읽기는 저장소를 바꾸지
// 않으므로 그대로 돈다. 파괴적이었던 기록은 클라이언트가 2단계 확인을 거치지만,
// 서버는 그것과 무관하게 쓰기 전부에 confirm 을 요구한다 — 마지막 방어선은 여기다.
func (s *GitServer) apiGitReplay(w http.ResponseWriter, r *http.Request) {
	var req gitReplayReq
	t := s.beginWrite(w, r, &req)
	t.resolve(req.Repo)
	if t.stop() {
		return
	}
	// argv 는 **서버의 기록에서** 꺼낸다 (FR-GIT-281) — 문자열을 받아 실행하면
	// 임의 명령 표면이 된다.
	rec, found := s.gitRecordOf(t.root, req.Seq)
	if !found {
		t.rejectWith(http.StatusNotFound, gitErrRecordMissing,
			"그 기록이 이 저장소에 없다 — 버퍼에서 밀려났을 수 있다")
		return
	}
	t.requireConfirm(rec.Write, req.Confirm,
		"쓰기 기록을 다시 실행한다: confirm:true 를 요구한다 (FR-GIT-89)")
	t.apply(func(ctx context.Context) error {
		_, err := write.Replay(s.Git.Service(), ctx, t.root, rec)
		return err
	})
	t.ok(map[string]any{"argv": rec.Argv})
}

// gitRecordOf 는 그 저장소의 기록 하나를 찾는다. **cwd 가 같은 것만** 본다 — 다른
// 저장소의 기록을 이 요청으로 끌어오면 화면에 보이지 않던 저장소가 바뀐다.
func (s *GitServer) gitRecordOf(root string, seq uint64) (core.Record, bool) {
	for _, rec := range s.Git.Service().Records(0) {
		if rec.Seq == seq && rec.Cwd == root {
			return rec, true
		}
	}
	return core.Record{}, false
}
