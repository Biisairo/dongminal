package lsp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type recordedCmd struct {
	name string
	args []string
	env  []string
	dir  string
}

func testRunner(t *testing.T, onPath map[string]string, rec *[]recordedCmd,
	out []byte, err error) (*InstallRunner, string) {
	t.Helper()
	managed := t.TempDir()
	return &InstallRunner{
		ManagedDir: managed,
		LookPath: func(name string) (string, error) {
			if p, ok := onPath[name]; ok {
				return p, nil
			}
			return "", errors.New("not found")
		},
		Exec: func(_ context.Context, name string, args, env []string, dir string) ([]byte, error) {
			*rec = append(*rec, recordedCmd{name: name, args: args, env: env, dir: dir})
			return out, err
		},
	}, managed
}

// TC-LSP-10 (FR-LSP-11 / V-LSP-4): 패키지 매니저가 없으면 **그 이름으로** 알린다.
// "설치 실패" 는 사용자가 다음에 할 일을 알려주지 않지만 "go 가 없다" 는 알려준다.
func TestInstall_MissingToolNamesIt(t *testing.T) {
	var rec []recordedCmd
	r, _ := testRunner(t, nil, &rec, nil, nil)
	d, _ := DescriptorForExt(".go")

	got := r.Install(context.Background(), d)
	if got.OK {
		t.Fatal("도구가 없는데 설치가 성공했다고 했다")
	}
	if !strings.Contains(got.Reason, "go") {
		t.Fatalf("사유에 없는 도구의 이름이 없다: %q", got.Reason)
	}
	if len(rec) != 0 {
		t.Fatalf("도구가 없는데 명령을 돌렸다: %+v", rec)
	}
}

// TC-LSP-11 (FR-LSP-7·7b / V-LSP-5): 격리 인자가 실린다 — go 는 GOBIN 을 env 로,
// npm 은 --prefix 를 인자로 받는다. 이것이 "전용 디렉터리 밖에 쓰지 않는다" 의
// 실효적 검증이다.
func TestInstall_IsolatesToManagedDir(t *testing.T) {
	// go 경로
	var rec []recordedCmd
	r, managed := testRunner(t, map[string]string{"go": "/usr/bin/go"}, &rec, nil, nil)
	g, _ := DescriptorForExt(".go")
	// 도구가 성공했다고 하면 실행 파일이 놓였는지 본다 — 미리 놓아 둔다.
	putManaged(t, managed, g)
	if got := r.Install(context.Background(), g); !got.OK {
		t.Fatalf("설치가 실패했다: %+v", got)
	}
	if len(rec) != 1 {
		t.Fatalf("명령이 한 번 돌지 않았다: %d", len(rec))
	}
	wantGobin := "GOBIN=" + filepath.Join(managed, "bin")
	if !hasEnv(rec[0].env, wantGobin) {
		t.Fatalf("GOBIN 이 전용 디렉터리를 가리키지 않는다: %v (기대 %s)", rec[0].env, wantGobin)
	}

	// npm 경로
	var rec2 []recordedCmd
	r2, managed2 := testRunner(t, map[string]string{"npm": "/usr/bin/npm"}, &rec2, nil, nil)
	ts, _ := DescriptorForExt(".ts")
	putManaged(t, managed2, ts)
	if got := r2.Install(context.Background(), ts); !got.OK {
		t.Fatalf("설치가 실패했다: %+v", got)
	}
	if !hasArgPair(rec2[0].args, "--prefix", managed2) {
		t.Fatalf("--prefix 가 전용 디렉터리를 가리키지 않는다: %v", rec2[0].args)
	}
}

// TC-LSP-12 (FR-LSP-9·51 / V-LSP-6): 설치 명령은 **셸을 거치지 않는다.** 도구
// 이름과 인자가 분리된 채로 가며, 어느 인자도 셸 메타문자로 이어붙지 않는다.
func TestInstall_NoShell(t *testing.T) {
	var rec []recordedCmd
	r, managed := testRunner(t, map[string]string{"go": "/usr/bin/go"}, &rec, nil, nil)
	g, _ := DescriptorForExt(".go")
	putManaged(t, managed, g)
	r.Install(context.Background(), g)

	if len(rec) != 1 {
		t.Fatalf("명령이 한 번 돌지 않았다: %d", len(rec))
	}
	c := rec[0]
	// 셸을 거쳤다면 이름이 sh·bash 이고 인자가 한 줄로 뭉쳐 온다.
	for _, shell := range []string{"sh", "bash", "zsh", "cmd", "cmd.exe", "powershell"} {
		if filepath.Base(c.name) == shell {
			t.Fatalf("셸을 거쳤다: %s", c.name)
		}
	}
	for _, a := range c.args {
		if strings.ContainsAny(a, ";|&><`$") {
			t.Fatalf("인자에 셸 메타문자가 있다: %q", a)
		}
	}
	if len(c.args) < 2 {
		t.Fatalf("인자가 뭉쳐 왔다: %v", c.args)
	}
}

// TC-LSP-13 (FR-LSP-10): 실패는 **사유와 함께** 온다. 조용히 실패하지 않는다.
func TestInstall_FailureCarriesReason(t *testing.T) {
	var rec []recordedCmd
	r, _ := testRunner(t, map[string]string{"go": "/usr/bin/go"}, &rec,
		[]byte("go: module lookup disabled by GOFLAGS=-mod=vendor"), errors.New("exit status 1"))
	g, _ := DescriptorForExt(".go")

	got := r.Install(context.Background(), g)
	if got.OK {
		t.Fatal("도구가 실패했는데 성공이라고 했다")
	}
	if got.Reason == "" {
		t.Fatal("실패에 사유가 없다 — 조용한 실패다")
	}
	if !strings.Contains(got.Detail, "module lookup disabled") {
		t.Fatalf("도구의 출력이 실리지 않았다: %q", got.Detail)
	}
}

// TC-LSP-14 (FR-LSP-10): 도구가 0 을 내도 **실행 파일이 놓이지 않았으면** 실패다.
// 성공을 도구의 종료 코드만으로 판정하면, 설치했다고 말한 뒤 여전히 "없음" 이 된다.
func TestInstall_SuccessRequiresTheExe(t *testing.T) {
	var rec []recordedCmd
	r, _ := testRunner(t, map[string]string{"go": "/usr/bin/go"}, &rec, nil, nil)
	g, _ := DescriptorForExt(".go")
	// 실행 파일을 놓지 않는다.
	got := r.Install(context.Background(), g)
	if got.OK {
		t.Fatal("실행 파일이 없는데 설치가 성공했다고 했다")
	}
	if got.Reason == "" {
		t.Fatal("사유가 없다")
	}
}

// TC-LSP-15 (FR-LSP-12): 시간 상한을 넘으면 중단하고 그 사실을 알린다.
func TestInstall_Timeout(t *testing.T) {
	managed := t.TempDir()
	r := &InstallRunner{
		ManagedDir: managed,
		LookPath:   func(string) (string, error) { return "/usr/bin/go", nil },
		Timeout:    30 * time.Millisecond,
		Exec: func(ctx context.Context, _ string, _, _ []string, _ string) ([]byte, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	g, _ := DescriptorForExt(".go")
	start := time.Now()
	got := r.Install(context.Background(), g)
	if got.OK {
		t.Fatal("시간을 넘겼는데 성공이라고 했다")
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("상한이 걸리지 않았다: %v", el)
	}
	if got.Reason == "" {
		t.Fatal("시간 초과에 사유가 없다")
	}
}

// TC-LSP-16 (FR-LSP-7): 전용 디렉터리는 설치가 **만든다.** 없다고 실패하지 않는다.
func TestInstall_CreatesManagedDir(t *testing.T) {
	var rec []recordedCmd
	base := t.TempDir()
	managed := filepath.Join(base, "lsp")
	r := &InstallRunner{
		ManagedDir: managed,
		LookPath:   func(string) (string, error) { return "/usr/bin/go", nil },
		Exec: func(_ context.Context, name string, args, env []string, dir string) ([]byte, error) {
			rec = append(rec, recordedCmd{name: name, args: args, env: env, dir: dir})
			return nil, nil
		},
	}
	g, _ := DescriptorForExt(".go")
	r.Install(context.Background(), g)
	if _, err := os.Stat(managed); err != nil {
		t.Fatalf("전용 디렉터리를 만들지 않았다: %v", err)
	}
}

func hasEnv(env []string, want string) bool {
	for _, e := range env {
		if e == want {
			return true
		}
	}
	return false
}

func hasArgPair(args []string, flag, val string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == val {
			return true
		}
	}
	return false
}
