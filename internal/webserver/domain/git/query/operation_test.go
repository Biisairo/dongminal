package query

import (
	"os"
	"path/filepath"
	"testing"
)

// 묶음 A — 진행 중 작업 (GIT_ACTIONS_SRS §3.1 FR-GIT-251, 검증 V175).

func opTouch(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
}

func opWrite(t *testing.T, dir, rel, body string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A1 (V175): 표식마다 작업 종류가 정확히 판정된다. **git 을 실행하지 않는다** —
// 존재 여부가 그대로 답이다.
func TestDetectOperation_ByMarker(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, dir string)
		want  string
	}{
		{"없음", func(*testing.T, string) {}, OpNone},
		{"머지", func(t *testing.T, d string) { opTouch(t, d, mergeHeadFile) }, OpMerge},
		{"리베이스 (rebase-merge)", func(t *testing.T, d string) {
			if err := os.Mkdir(filepath.Join(d, rebaseMergeDir), 0o755); err != nil {
				t.Fatal(err)
			}
		}, OpRebase},
		{"리베이스 (rebase-apply)", func(t *testing.T, d string) {
			if err := os.Mkdir(filepath.Join(d, rebaseApplyDir), 0o755); err != nil {
				t.Fatal(err)
			}
		}, OpRebase},
		{"체리픽", func(t *testing.T, d string) { opTouch(t, d, cherryPickHeadFile) }, OpCherryPick},
		{"리버트", func(t *testing.T, d string) { opTouch(t, d, revertHeadFile) }, OpRevert},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			tc.setup(t, dir)
			if got := DetectOperation(dir).Kind; got != tc.want {
				t.Fatalf("Kind = %q, want %q", got, tc.want)
			}
		})
	}
}

// A2 (V175): **리베이스가 우선이다.** git 은 리베이스를 sequencer 로 돌리므로 그
// 중의 충돌은 CHERRY_PICK_HEAD 를 함께 남긴다 — 순서를 뒤집으면 "리베이스 중"이
// "체리픽 중"으로 보이고, 사용자는 `cherry-pick --abort` 를 눌러 리베이스를 깬다.
func TestDetectOperation_RebaseWinsOverSequencerMarker(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, rebaseMergeDir), 0o755); err != nil {
		t.Fatal(err)
	}
	opTouch(t, dir, cherryPickHeadFile)
	if got := DetectOperation(dir).Kind; got != OpRebase {
		t.Fatalf("Kind = %q, want %q", got, OpRebase)
	}
}

// A3 (V175): 리베이스는 **진행 위치**를 함께 준다. 보이지 않으면 사용자는 끝났는지
// 알 수 없다. 백엔드가 둘이라 파일 이름도 둘이다.
func TestDetectOperation_RebaseProgress(t *testing.T) {
	cases := []struct {
		name              string
		atRel, totalRel   string
		atBody, endBody   string
		wantAt, wantTotal int
	}{
		{"rebase-merge", rebaseMergeDir + "/" + rebaseMergeMsgNum, rebaseMergeDir + "/" + rebaseMergeEnd, "2\n", "5\n", 2, 5},
		{"rebase-apply", rebaseApplyDir + "/" + rebaseApplyNext, rebaseApplyDir + "/" + rebaseApplyLast, "3\n", "7\n", 3, 7},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			opWrite(t, dir, tc.atRel, tc.atBody)
			opWrite(t, dir, tc.totalRel, tc.endBody)
			op := DetectOperation(dir)
			if op.Kind != OpRebase || op.At != tc.wantAt || op.Total != tc.wantTotal {
				t.Fatalf("op = %+v, want rebase %d/%d", op, tc.wantAt, tc.wantTotal)
			}
		})
	}
}

// A4: 위치 파일이 없어도 리베이스는 리베이스다 — 없는 것은 오류가 아니다.
func TestDetectOperation_RebaseWithoutProgressFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, rebaseMergeDir), 0o755); err != nil {
		t.Fatal(err)
	}
	op := DetectOperation(dir)
	if op.Kind != OpRebase || op.At != 0 || op.Total != 0 {
		t.Fatalf("op = %+v, want rebase 0/0", op)
	}
}

// A5 (FR-GIT-251·86): preflight 와 **같은 표를 본다.** 판정 근거가 두 벌이면 한쪽만
// 고쳐진다 — 진행 중인데 커밋이 막히지 않거나, 막혔는데 출구가 안 보인다.
func TestOperationMarkers_CoverPreflightChecks(t *testing.T) {
	for _, c := range inProgressChecks {
		dir := t.TempDir()
		for _, n := range markersOf(c.kind) {
			opTouch(t, dir, n)
		}
		if len(markersOf(c.kind)) == 0 {
			t.Fatalf("preflight 의 %q 에 대응하는 표식이 없다", c.kind)
		}
		if got := DetectOperation(dir).Kind; got != c.kind {
			t.Fatalf("%q 의 표식으로 판정하면 %q 가 나온다", c.kind, got)
		}
	}
}
