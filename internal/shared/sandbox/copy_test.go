package sandbox

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// SANDBOX_PICK_COPY_SRS 묶음 C — scratch 의 작업 폴더는 **복사**다 (D-SPK-2).
//
// 마운트는 컨테이너 안 코드에 호스트 파일을 내주므로 scratch 가 더 이상 격리
// 경계가 아니게 된다 (FR-SBX-39b). 복사는 돌아오는 통로가 없어 그 근거에 걸리지
// 않는다 — 그래서 scratch 에 작업 폴더를 줄 수 있는 유일한 방식이다.

func copyProfile() Profile {
	p := Scratch()
	if p.Work != WorkCopy {
		// 이 파일의 나머지가 전부 이 전제 위에 선다.
		panic("scratch 의 작업 방식이 copy 가 아니다: " + string(p.Work))
	}
	return p
}

// V-SPK-10·11: 복사는 `docker cp <host>/. <name>:/work` 다.
//
// 끝의 `.` 이 요점이다 — 그것이 "폴더 자체" 가 아니라 "폴더의 **내용**" 을
// 뜻하며, 그래야 `/work` 아래에 원본 폴더 이름의 한 겹이 더 생기지 않는다.
func TestEnsure_CopiesWorkdirForCopyProfile(t *testing.T) {
	f := &fakeDocker{reply: stateReply("")}
	if err := newMgr(f).Ensure("w1", copyProfile(), RunSpec{HostDir: "/Users/me/app"}); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	cp := f.call("cp")
	if cp == nil {
		t.Fatalf("cp 를 부르지 않았다: %v", f.calls)
	}
	got := joined(cp)
	want := "cp /Users/me/app/. " + newMgr(&fakeDocker{}).ContainerName("w1") + ":" + ContainerWorkdir
	if got != want {
		t.Fatalf("cp argv = %q, want %q", got, want)
	}
	// **마운트는 붙지 않는다.** 붙으면 격리 경계가 깨진다 (FR-SPK-20 의 전제).
	for _, a := range f.call("run") {
		if a == "-v" {
			t.Fatal("copy 프로파일에 -v 가 붙었다")
		}
	}
}

// V-SPK-12: 이미 있는 컨테이너에는 복사하지 않는다.
//
// 컨테이너는 창을 닫아도 남고(FR-SBX-7) 사용자는 그 안에서 계속 작업한다.
// 붙을 때마다 복사하면 **컨테이너 안의 작업을 호스트의 옛 내용이 덮는다.**
func TestEnsure_DoesNotCopyIntoExistingContainer(t *testing.T) {
	for _, state := range []string{"running", "exited"} {
		t.Run(state, func(t *testing.T) {
			f := &fakeDocker{reply: stateReply(state)}
			if err := newMgr(f).Ensure("w1", copyProfile(), RunSpec{HostDir: "/Users/me/app"}); err != nil {
				t.Fatalf("Ensure: %v", err)
			}
			if f.sawSub("cp") {
				t.Fatalf("이미 있는 컨테이너에 복사했다: %v", f.calls)
			}
		})
	}
}

// 작업 폴더를 고르지 않았으면 복사할 것이 없다.
func TestEnsure_NoCopyWithoutHostDir(t *testing.T) {
	f := &fakeDocker{reply: stateReply("")}
	if err := newMgr(f).Ensure("w1", copyProfile(), RunSpec{}); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if f.sawSub("cp") {
		t.Fatalf("호스트 경로가 없는데 복사했다: %v", f.calls)
	}
}

// 마운트 프로파일은 복사하지 않는다 — 두 방식이 함께 걸리면 같은 자리에 두 뜻이
// 겹친다 (D-SPK-8 이 불리언 둘을 거부한 이유).
func TestEnsure_MountProfileNeverCopies(t *testing.T) {
	f := &fakeDocker{reply: stateReply("")}
	if err := newMgr(f).Ensure("w1", devProfile(), RunSpec{HostDir: "/Users/me/app"}); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if f.sawSub("cp") {
		t.Fatalf("마운트 프로파일이 복사했다: %v", f.calls)
	}
}

// V-SPK-18: 복사가 실패하면 컨테이너를 되돌린다.
//
// 반쯤 채워진 컨테이너를 남기면 다음 열기가 FR-SPK-12 에 따라 복사를 건너뛰어
// **그 상태가 굳는다.**
func TestEnsure_RemovesContainerWhenCopyFails(t *testing.T) {
	f := &fakeDocker{}
	f.reply = func(args []string) (string, error) {
		switch args[0] {
		case "cp":
			return "no such directory", errors.New("exit 1")
		default:
			return stateReply("")(args)
		}
	}
	err := newMgr(f).Ensure("w1", copyProfile(), RunSpec{HostDir: "/Users/me/app"})
	if err == nil {
		t.Fatal("복사 실패가 오류로 올라오지 않았다")
	}
	rm := f.call("rm")
	if rm == nil {
		t.Fatalf("컨테이너를 되돌리지 않았다: %v", f.calls)
	}
	if !strings.Contains(joined(rm), newMgr(&fakeDocker{}).ContainerName("w1")) {
		t.Fatalf("되돌린 대상이 다르다: %v", rm)
	}
}

// V-SPK-19·20: 도구의 시작 자리.
func TestExecSpec_WorkdirFollowsWorkKindAndHostDir(t *testing.T) {
	for _, tc := range []struct {
		name string
		prof Profile
		rs   RunSpec
		want bool
	}{
		{"복사 + 폴더", copyProfile(), RunSpec{HostDir: "/Users/me/app"}, true},
		{"마운트 + 폴더", devProfile(), RunSpec{HostDir: "/Users/me/app"}, true},
		// 폴더가 없으면 `/work` 자체가 없다 — 없는 자리를 시작 디렉터리로 주면
		// 런타임이 그 자리를 만들어 빈 폴더에서 시작한 것처럼 보인다.
		{"복사 + 폴더 없음", copyProfile(), RunSpec{}, false},
		{"마운트 + 폴더 없음", devProfile(), RunSpec{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec := newMgr(&fakeDocker{}).ExecSpec("w1", "docker", tc.prof, tc.rs, ExecEnv{})
			got := strings.Contains(joined(spec.Args), "-w "+ContainerWorkdir)
			if got != tc.want {
				t.Fatalf("-w 존재 = %v, want %v: %s", got, tc.want, joined(spec.Args))
			}
		})
	}
}

// ── 상한 (FR-SPK-14·15) ──

func writeTree(t *testing.T, root string, files int, size int) {
	t.Helper()
	blob := strings.Repeat("x", size)
	for i := 0; i < files; i++ {
		if err := os.WriteFile(filepath.Join(root, "f"+string(rune('a'+i))+".txt"), []byte(blob), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
}

// V-SPK-14: 상한을 넘으면 거부한다. 사유가 무엇을 넘었는지 밝힌다.
func TestVerifyCopySource_RejectsOverLimits(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, 4, 100)

	if err := VerifyCopySource(copyProfile(), dir, 10_000, 100); err != nil {
		t.Fatalf("상한 안인데 거부했다: %v", err)
	}
	err := VerifyCopySource(copyProfile(), dir, 10, 100)
	if err == nil || !strings.Contains(err.Error(), "큽니다") {
		t.Fatalf("용량 상한을 알리지 않았다: %v", err)
	}
	err = VerifyCopySource(copyProfile(), dir, 10_000, 2)
	if err == nil || !strings.Contains(err.Error(), "많습니다") {
		t.Fatalf("항목 수 상한을 알리지 않았다: %v", err)
	}
}

// 마운트 프로파일과 빈 경로는 잴 것이 없다 — 상한은 복사에만 걸린다.
func TestVerifyCopySource_OnlyAppliesToCopy(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, 4, 100)
	if err := VerifyCopySource(devProfile(), dir, 1, 1); err != nil {
		t.Fatalf("마운트 프로파일에 상한을 걸었다: %v", err)
	}
	if err := VerifyCopySource(copyProfile(), "", 1, 1); err != nil {
		t.Fatalf("빈 경로에 상한을 걸었다: %v", err)
	}
}

// V-SPK-16: 제외 규칙을 두지 않는다. `.git` 도 센다.
//
// 무엇이 빠졌는지 사용자가 알 수 없는 복사는 "복사했다" 를 거짓으로 만든다.
// 큰 폴더는 조용히 줄이는 것이 아니라 거부로 다룬다 (D-SPK-6).
func TestVerifyCopySource_CountsDotGit(t *testing.T) {
	dir := t.TempDir()
	git := filepath.Join(dir, ".git")
	if err := os.Mkdir(git, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	writeTree(t, git, 3, 10)
	if err := VerifyCopySource(copyProfile(), dir, 10_000, 2); err == nil {
		t.Fatal(".git 안의 파일을 세지 않았다")
	}
}

// V-SPK-15: 셀 수 없으면 거부한다 — 없는 경로는 그 자체로 사유다 (FR-SBX-41).
func TestVerifyCopySource_MissingSourceIsAnError(t *testing.T) {
	if err := VerifyCopySource(copyProfile(), filepath.Join(t.TempDir(), "nope"), 1<<30, 1000); err == nil {
		t.Fatal("없는 경로를 통과시켰다")
	}
}
