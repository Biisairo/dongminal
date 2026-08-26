package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 묶음 J — preflight (GIT_SRS §3A.3 FR-GIT-86~88·76·85, 검증 V36).

// preflightFake 은 config 값과 gitdir 을 들고 있는 Runner 다. 진행 중 상태는
// gitdir 안의 파일이 결정하므로 테스트도 파일로 만든다.
type preflightFake struct {
	gitDir string
	config map[string]string
}

func newPreflightFake(t *testing.T) *preflightFake {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, headFile), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &preflightFake{gitDir: dir, config: map[string]string{
		configUserName:  "tester",
		configUserEmail: "t@example.com",
	}}
}

func (f *preflightFake) runner(_ context.Context, _ string, args []string) (Output, error) {
	switch args[0] {
	case "rev-parse":
		return Output{Stdout: f.gitDir + "\n" + f.gitDir + "\n"}, nil
	case "config":
		v, ok := f.config[args[len(args)-1]]
		if !ok {
			// git 2.50.1 실측: 없는 키는 exit 1 이고 stderr 가 비어 있다.
			return Output{ExitCode: configUnsetExit}, nil
		}
		return Output{Stdout: v + "\n"}, nil
	}
	return Output{}, nil
}

func (f *preflightFake) touch(t *testing.T, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(f.gitDir, name), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (f *preflightFake) mkdir(t *testing.T, name string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(f.gitDir, name), 0o755); err != nil {
		t.Fatal(err)
	}
}

func (f *preflightFake) preflight(t *testing.T) Preflight {
	t.Helper()
	pf, err := New(WithRunner(f.runner)).Preflight(context.Background(), "/tmp/repo")
	if err != nil {
		t.Fatalf("Preflight: %v", err)
	}
	return pf
}

func blockCodes(pf Preflight) []string {
	out := make([]string, 0, len(pf.Blocks))
	for _, b := range pf.Blocks {
		out = append(out, b.Code)
	}
	return out
}

func hasCode(codes []string, want string) bool {
	for _, c := range codes {
		if c == want {
			return true
		}
	}
	return false
}

// W7 (V36, FR-GIT-86): identity 미설정과 진행 중인 머지·리베이스·체리픽·리버트를
// 각각 차단한다.
func TestPreflight_Blocks(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, f *preflightFake)
		want  string
	}{
		{"user.name 미설정", func(t *testing.T, f *preflightFake) {
			delete(f.config, configUserName)
		}, BlockIdentityMissing},
		{"user.email 미설정", func(t *testing.T, f *preflightFake) {
			delete(f.config, configUserEmail)
		}, BlockIdentityMissing},
		{"user.name 이 빈 문자열", func(t *testing.T, f *preflightFake) {
			f.config[configUserName] = ""
		}, BlockIdentityMissing},
		{"머지 진행 중", func(t *testing.T, f *preflightFake) {
			f.touch(t, mergeHeadFile)
		}, BlockMergeInProgress},
		{"리베이스 진행 중 (rebase-merge)", func(t *testing.T, f *preflightFake) {
			f.mkdir(t, rebaseMergeDir)
		}, BlockRebaseInProgress},
		{"리베이스 진행 중 (rebase-apply)", func(t *testing.T, f *preflightFake) {
			f.mkdir(t, rebaseApplyDir)
		}, BlockRebaseInProgress},
		{"체리픽 진행 중", func(t *testing.T, f *preflightFake) {
			f.touch(t, cherryPickHeadFile)
		}, BlockCherryPickInProgress},
		{"리버트 진행 중", func(t *testing.T, f *preflightFake) {
			f.touch(t, revertHeadFile)
		}, BlockRevertInProgress},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newPreflightFake(t)
			tc.setup(t, f)
			codes := blockCodes(f.preflight(t))
			if !hasCode(codes, tc.want) {
				t.Fatalf("blocks = %v, want %q 포함", codes, tc.want)
			}
		})
	}

	// 깨끗한 저장소는 아무것도 막지 않는다 — 항상 무언가 막으면 차단이 뜻을 잃는다.
	f := newPreflightFake(t)
	pf := f.preflight(t)
	if len(pf.Blocks) != 0 || len(pf.Warnings) != 0 {
		t.Fatalf("깨끗한 저장소인데 blocks=%v warnings=%+v", blockCodes(pf), pf.Warnings)
	}
}

// W8 (V36, FR-GIT-88): 모든 Block 은 무엇이 왜 막혔고(Reason) 어떻게 푸는지(Fix)를
// 함께 준다. 단순 실패 메시지로 끝내면 사용자가 갈 곳이 없다.
func TestPreflight_EveryBlockHasReasonAndFix(t *testing.T) {
	f := newPreflightFake(t)
	delete(f.config, configUserName)
	f.touch(t, mergeHeadFile)
	f.mkdir(t, rebaseMergeDir)
	f.touch(t, cherryPickHeadFile)
	f.touch(t, revertHeadFile)

	pf := f.preflight(t)
	want := []string{
		BlockIdentityMissing, BlockMergeInProgress, BlockRebaseInProgress,
		BlockCherryPickInProgress, BlockRevertInProgress,
	}
	if len(pf.Blocks) != len(want) {
		t.Fatalf("blocks = %v, want %v", blockCodes(pf), want)
	}
	for _, b := range pf.Blocks {
		if strings.TrimSpace(b.Reason) == "" || strings.TrimSpace(b.Fix) == "" {
			t.Fatalf("%s 에 Reason·Fix 가 모두 없다: %+v", b.Code, b)
		}
	}
}

// W9 (FR-GIT-87): detached 는 막지 않는다. 커밋이 어느 브랜치에도 속하지 않음을
// 경고로만 알린다.
func TestPreflight_DetachedIsWarningNotBlock(t *testing.T) {
	f := newPreflightFake(t)
	if err := os.WriteFile(filepath.Join(f.gitDir, headFile),
		[]byte("1111111111111111111111111111111111111111\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pf := f.preflight(t)
	if len(pf.Blocks) != 0 {
		t.Fatalf("detached 를 차단했다: %v", blockCodes(pf))
	}
	if len(pf.Warnings) != 1 || pf.Warnings[0].Code != WarnDetachedHead {
		t.Fatalf("warnings = %+v", pf.Warnings)
	}
	if !strings.Contains(pf.Warnings[0].Reason, "브랜치") {
		t.Fatalf("경고가 결과를 설명하지 않는다: %q", pf.Warnings[0].Reason)
	}
}

// W10: `config` 는 읽기 목록에 있으나 읽기 인자만 통과한다.
// `git config user.name x` 는 쓰기이므로 읽기 경로로 흘러선 안 된다.
func TestGuardArgs_ConfigReadOnly(t *testing.T) {
	ok := [][]string{
		{"config", "--get", configUserName},
		{"config", "--get-all", "remote.origin.url"},
		{"config", "--list"},
		{"config", "--type=bool", "--get", configGPGSign},
	}
	for _, args := range ok {
		if err := guardArgs(args); err != nil {
			t.Fatalf("guardArgs(%q) = %v, want nil", args, err)
		}
	}
	bad := [][]string{
		{"config", configUserName, "x"},
		{"config", "--unset", configUserName},
		{"config", "--add", "remote.origin.url", "git@example.com"},
		{"config", "--global", "--get", configUserName},
		{"config", "--file=/etc/passwd", "--list"},
		{"config", "--get", configUserName, "extra"},
	}
	for _, args := range bad {
		if err := guardArgs(args); !errors.Is(err, ErrUnsafeArgument) {
			t.Fatalf("guardArgs(%q) = %v, want ErrUnsafeArgument", args, err)
		}
	}
}

// W11 (FR-GIT-76): commit.template 은 경로다 — 그 파일의 내용을 담는다.
// 설정이 없거나 파일이 없으면 빈 문자열이며 그것은 실패가 아니다.
func TestPreflight_CommitTemplateAndGPGSign(t *testing.T) {
	body := "# 제목\n\n# 본문\n"
	tmpl := filepath.Join(t.TempDir(), "gitmessage")
	if err := os.WriteFile(tmpl, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	f := newPreflightFake(t)
	f.config[configCommitTemplate] = tmpl
	f.config[configGPGSign] = "true"
	pf := f.preflight(t)
	if pf.Template != body {
		t.Fatalf("Template = %q, want %q", pf.Template, body)
	}
	if !pf.GPGSign {
		t.Fatal("commit.gpgsign=true 인데 GPGSign 이 false 다")
	}

	f = newPreflightFake(t)
	f.config[configCommitTemplate] = filepath.Join(t.TempDir(), "없는파일")
	f.config[configGPGSign] = "false"
	pf = f.preflight(t)
	if pf.Template != "" {
		t.Fatalf("없는 템플릿 = %q, want \"\"", pf.Template)
	}
	if pf.GPGSign {
		t.Fatal("commit.gpgsign=false 인데 GPGSign 이 true 다")
	}

	// 설정 자체가 없는 저장소.
	pf = newPreflightFake(t).preflight(t)
	if pf.Template != "" || pf.GPGSign {
		t.Fatalf("미설정인데 Template=%q GPGSign=%v", pf.Template, pf.GPGSign)
	}
}

// W7 (V36): 실제 git 으로 "미설정 키는 exit 1" 가정을 고정한다. 이 가정이 깨지면
// identity 가 없는 저장소에서 preflight 자체가 실패한다.
func TestPreflight_RealGit(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	repo := tempRepo(t)
	s := New()
	ctx := context.Background()

	pf, err := s.Preflight(ctx, repo)
	if err != nil {
		t.Fatalf("Preflight: %v", err)
	}
	if len(pf.Blocks) != 0 || len(pf.Warnings) != 0 {
		t.Fatalf("깨끗한 저장소인데 blocks=%v warnings=%+v", blockCodes(pf), pf.Warnings)
	}

	gitIn(t, repo, "config", "--unset", configUserName)
	pf, err = s.Preflight(ctx, repo)
	if err != nil {
		t.Fatalf("identity 미설정에서 Preflight 가 실패했다: %v", err)
	}
	if !hasCode(blockCodes(pf), BlockIdentityMissing) {
		t.Fatalf("blocks = %v, want identity_missing", blockCodes(pf))
	}

	// detached 는 경고다 (FR-GIT-87).
	gitIn(t, repo, "checkout", "--detach")
	pf, err = s.Preflight(ctx, repo)
	if err != nil {
		t.Fatalf("Preflight: %v", err)
	}
	if len(pf.Warnings) != 1 || pf.Warnings[0].Code != WarnDetachedHead {
		t.Fatalf("warnings = %+v", pf.Warnings)
	}
}
