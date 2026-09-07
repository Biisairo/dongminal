package query

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/git/core"
)

// 묶음 C — signature (GIT_SRS §3.3 FR-GIT-19, 검증 V5).
//
// signature 는 status 재조회를 생략할 근거다. 값이 변화를 놓치면 UI 가 조용히
// 낡은 상태를 보여주므로, 실제 저장소에서 확인한다.

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command(gitPath(t), args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_SYSTEM="+os.DevNull)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

// P8 (V5): index 를 건드리면 값이 바뀌고, 안 건드리면 같다.
func TestSignature_TracksIndex(t *testing.T) {
	repo := tempRepo(t)
	s := core.New()
	ctx := context.Background()

	first, err := SignatureOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if first.Head == "" || first.RefName != "refs/heads/main" {
		t.Fatalf("signature = %+v", first)
	}
	if first.IndexMtimeNs == 0 || first.IndexSize == 0 {
		t.Fatalf("index stat 이 비었다: %+v", first)
	}
	if first.RefMtimeNs == 0 {
		t.Fatalf("ref mtime 이 비었다: %+v", first)
	}
	if first.Value == "" {
		t.Fatal("Value 가 비었다")
	}

	same, err := SignatureOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if same.Value != first.Value {
		t.Fatalf("건드리지 않았는데 값이 바뀌었다: %q → %q", first.Value, same.Value)
	}

	if err := os.WriteFile(filepath.Join(repo, "new.txt"), []byte("y\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repo, "add", "new.txt")

	after, err := SignatureOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if after.Value == first.Value {
		t.Fatalf("index 를 건드렸는데 값이 그대로다: %q", after.Value)
	}
}

// P9 (V5): ref 가 packed 상태면 개별 파일이 없다. 오류가 아니라 packed-refs 의
// mtime 을 쓴다.
func TestSignature_PackedRefsOnly(t *testing.T) {
	repo := tempRepo(t)
	gitIn(t, repo, "pack-refs", "--all")

	s := core.New()
	gitDir, commonDir, err := s.GitDirs(context.Background(), repo)
	if err != nil {
		t.Fatalf("GitDirs: %v", err)
	}
	if _, err := os.Stat(filepath.Join(gitDir, "refs", "heads", "main")); err == nil {
		t.Skip("pack-refs 가 loose ref 를 남겼다 — 이 git 에서는 확인할 수 없다")
	}
	if _, err := os.Stat(filepath.Join(commonDir, "packed-refs")); err != nil {
		t.Skipf("packed-refs 가 없다: %v", err)
	}

	sig, err := SignatureOf(s, context.Background(), repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if sig.RefName != "refs/heads/main" {
		t.Fatalf("RefName = %q", sig.RefName)
	}
	if sig.RefMtimeNs == 0 {
		t.Fatalf("packed-refs 의 mtime 을 쓰지 않았다: %+v", sig)
	}
}

// 없는 파일의 mtime·size 는 0 이며 오류가 아니다 — 초기 저장소에는 index 가
// 없을 수 있다.
func TestSignature_MissingIndexIsNotError(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := core.New(core.WithRunner(func(_ context.Context, _ string, _ []string) (core.Output, error) {
		return core.Output{Stdout: dir + "\n" + dir + "\n"}, nil
	}))
	sig, err := SignatureOf(s, context.Background(), absR)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if sig.IndexMtimeNs != 0 || sig.IndexSize != 0 || sig.RefMtimeNs != 0 {
		t.Fatalf("없는 파일이 0 이 아니다: %+v", sig)
	}
	if sig.Head != "ref: refs/heads/main" || sig.RefName != "refs/heads/main" {
		t.Fatalf("signature = %+v", sig)
	}
}

// detached HEAD 는 심볼릭이 아니다 — RefName 이 비고 ref stat 은 건너뛴다.
func TestSignature_DetachedHead(t *testing.T) {
	dir := t.TempDir()
	oid := "1111111111111111111111111111111111111111"
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte(oid+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := core.New(core.WithRunner(func(_ context.Context, _ string, _ []string) (core.Output, error) {
		return core.Output{Stdout: dir + "\n" + dir + "\n"}, nil
	}))
	sig, err := SignatureOf(s, context.Background(), absR)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if sig.Head != oid || sig.RefName != "" {
		t.Fatalf("signature = %+v", sig)
	}
}

// V-GVR-22~25 (GIT_VIEW_REFRESH_SRS FR-GVR-21·22·23): **ref 의 추가·삭제도 변화다.**
//
// 종전 signature 는 HEAD·index·현재 브랜치 ref 만 봤다. 그래서 터미널에서 만든
// **다른** 브랜치는 한 톨도 값을 움직이지 못했고, History 의 커밋 배지가 낡은 채로
// 남았다 (SRS §3.2 의 접수). refs 아래 **디렉터리의 mtime** 을 근거에 더해 그것을
// 잡는다 — 파일이 생기거나 사라지면 부모 디렉터리의 mtime 이 바뀐다.
func TestSignature_TracksRefAddRemove(t *testing.T) {
	repo := tempRepo(t)
	s := core.New()
	ctx := context.Background()

	first, err := SignatureOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}

	// V-GVR-25: 아무것도 바뀌지 않으면 같다. 근거가 매번 달라지면 폴링이 늘 다시 받는다.
	same, err := SignatureOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if same.Value != first.Value {
		t.Fatalf("건드리지 않았는데 값이 바뀌었다: %q → %q", first.Value, same.Value)
	}

	// V-GVR-22: 현재 브랜치가 아닌 **다른** 브랜치를 만든다. HEAD 도 index 도
	// 현재 브랜치 ref 도 움직이지 않는다 — 종전 근거로는 감지할 수 없던 변화다.
	gitIn(t, repo, "branch", "sig-probe")
	added, err := SignatureOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if added.Value == first.Value {
		t.Fatalf("브랜치를 만들었는데 값이 그대로다: %q", added.Value)
	}

	// V-GVR-23: 지워도 달라진다.
	gitIn(t, repo, "branch", "-D", "sig-probe")
	removed, err := SignatureOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if removed.Value == added.Value {
		t.Fatalf("브랜치를 지웠는데 값이 그대로다: %q", removed.Value)
	}
}

// V-GVR-22a: 디렉터리 mtime 이 갱신되지 않아도 ref 의 추가·삭제가 잡힌다 (FR-GVR-21a).
//
// Windows 러너의 작업 디스크가 그랬다 — `git branch` 뒤 45초 동안 `refs/heads` 의
// mtime 이 그대로였다 (CI_E2E_MATRIX_SRS FR-CEM-32, V-GVR-26 의 trace 실측). 여기서는
// 그 상태를 `Chtimes` 로 만든다: 파일을 만든 뒤 디렉터리 시각을 이전 값으로 되돌린다.
// mtime 근거가 실제로 같음을 함께 단정한다 — 그것이 다르면 이 검사는 재려는 것을
// 재지 않는다.
func TestSignature_RefAddSurvivesStaleDirMtime(t *testing.T) {
	repo := tempRepo(t)
	s := core.New()
	ctx := context.Background()
	dirs := []string{
		filepath.Join(repo, ".git", refsDir),
		filepath.Join(repo, ".git", refsDir, "heads"),
	}
	// 지금 시각을 기억해 두고, 되돌릴 수 있는 함수를 준다.
	pin := func() func() {
		t.Helper()
		var mts []time.Time
		for _, d := range dirs {
			fi, err := os.Stat(d)
			if err != nil {
				t.Fatalf("stat %s: %v", d, err)
			}
			mts = append(mts, fi.ModTime())
		}
		return func() {
			for i, d := range dirs {
				if err := os.Chtimes(d, mts[i], mts[i]); err != nil {
					t.Fatalf("chtimes %s: %v", d, err)
				}
			}
		}
	}

	first, err := SignatureOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}

	restore := pin()
	gitIn(t, repo, "branch", "sig-probe")
	restore()
	added, err := SignatureOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if added.RefsMtimeNs != first.RefsMtimeNs {
		t.Fatalf("전제가 깨졌다 — 디렉터리 mtime 을 되돌렸는데 근거가 다르다: %d → %d",
			first.RefsMtimeNs, added.RefsMtimeNs)
	}
	if added.RefsShape == first.RefsShape {
		t.Fatalf("브랜치를 만들었는데 이름 근거가 그대로다: %d", added.RefsShape)
	}
	if added.Value == first.Value {
		t.Fatalf("디렉터리 mtime 이 낡아 있으면 브랜치 추가를 놓친다: %q", added.Value)
	}

	restore = pin()
	gitIn(t, repo, "branch", "-D", "sig-probe")
	restore()
	removed, err := SignatureOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if removed.RefsMtimeNs != added.RefsMtimeNs {
		t.Fatalf("전제가 깨졌다 — 디렉터리 mtime 을 되돌렸는데 근거가 다르다: %d → %d",
			added.RefsMtimeNs, removed.RefsMtimeNs)
	}
	if removed.Value == added.Value {
		t.Fatalf("디렉터리 mtime 이 낡아 있으면 브랜치 삭제를 놓친다: %q", removed.Value)
	}
	// 같은 이름들로 돌아왔으므로 이름 근거도 처음으로 돌아온다 — 근거가 상태의
	// 함수라는 뜻이다 (V-GVR-25 와 같은 요구).
	if removed.RefsShape != first.RefsShape {
		t.Fatalf("같은 ref 목록인데 이름 근거가 다르다: %d ≠ %d", removed.RefsShape, first.RefsShape)
	}
}

// V-GVR-24 (FR-GVR-23): ref 가 packed 되면 개별 파일이 사라지고 그 파일 하나가
// 전부를 담는다 — 그것도 근거에 있어야 한다.
func TestSignature_TracksPackedRefs(t *testing.T) {
	repo := tempRepo(t)
	s := core.New()
	ctx := context.Background()

	gitIn(t, repo, "branch", "packed-probe")
	before, err := SignatureOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}

	gitIn(t, repo, "pack-refs", "--all")
	after, err := SignatureOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if after.Value == before.Value {
		t.Fatalf("pack-refs 뒤에도 값이 그대로다: %q", after.Value)
	}
}
