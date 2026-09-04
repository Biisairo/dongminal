package lsp

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/platform"
)

// 시험용 Locator. PATH 와 파일시스템을 대신 주입한다 — 실제 PATH 에 의존하면
// 검사가 기계마다 다른 답을 낸다.
func testLocator(onPath map[string]string, managedDir string, overrides map[string]string) *Locator {
	return &Locator{
		LookPath: func(name string) (string, error) {
			if p, ok := onPath[name]; ok {
				return p, nil
			}
			return "", errors.New("not found")
		},
		ManagedDir: managedDir,
		Overrides:  overrides,
	}
}

// 전용 디렉터리에 그 서술자의 실행 파일을 놓는다 — 자리는 구현과 **같은 함수**로
// 얻는다 (FR-LSP-7b). 시험이 자리를 따로 적으면 배치가 바뀔 때 검사가 먼저 통과하고
// 실제로는 못 찾는 상태가 된다.
func putManaged(t *testing.T, managedDir string, d Descriptor) string {
	t.Helper()
	p := ManagedExe(managedDir, d)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	mustExec(t, p)
	return p
}

// TC-LSP-1 (FR-LSP-1·13 / V-LSP-1b): 확장자가 서술자로 풀린다. `.ts` 와 `.js` 는
// **같은** 서술자여야 한다 — 언어를 단위로 삼으면 한 프로세스가 둘로 세어진다.
func TestDescriptorForExt(t *testing.T) {
	ts, ok := DescriptorForExt(".ts")
	if !ok {
		t.Fatal(".ts 가 어느 서술자로도 풀리지 않았다")
	}
	js, ok := DescriptorForExt(".js")
	if !ok {
		t.Fatal(".js 가 어느 서술자로도 풀리지 않았다")
	}
	if ts.ID != js.ID {
		t.Fatalf(".ts 와 .js 가 다른 서술자로 풀렸다: %s vs %s — 같은 서버가 두 번 기동된다", ts.ID, js.ID)
	}
	if g, ok := DescriptorForExt(".go"); !ok || g.Exe != "gopls" {
		t.Fatalf(".go → gopls 가 아니다: %+v ok=%v", g, ok)
	}
}

// TC-LSP-2 (FR-LSP-1 / V-LSP-1): 서술자에 없는 확장자는 풀리지 않는다.
func TestDescriptorForExt_Unknown(t *testing.T) {
	for _, ext := range []string{".txt", ".md", "", ".unknownlang"} {
		if d, ok := DescriptorForExt(ext); ok {
			t.Fatalf("%q 가 %s 로 풀렸다 — 서술자에 없는 확장자는 세션을 세우지 않아야 한다", ext, d.ID)
		}
	}
}

// TC-LSP-3 (FR-LSP-2): 기본 서술자 셋이 셋이며 각자 설치 방법을 갖는다.
func TestDefaultDescriptors(t *testing.T) {
	seen := map[string]bool{}
	for _, d := range Descriptors() {
		if d.ID == "" || d.Exe == "" {
			t.Fatalf("서술자에 식별자나 실행 파일이 없다: %+v", d)
		}
		if len(d.Exts) == 0 || len(d.Langs) == 0 {
			t.Fatalf("%s 에 확장자나 언어가 없다", d.ID)
		}
		if d.Installer.Tool == "" || len(d.Installer.Args) == 0 {
			t.Fatalf("%s 에 설치 방법이 없다 — 없으면 설치를 제안할 수 없다", d.ID)
		}
		seen[d.Exe] = true
	}
	for _, exe := range []string{"gopls", "typescript-language-server", "pyright-langserver"} {
		if !seen[exe] {
			t.Fatalf("기본 서술자에 %s 가 없다 (I-3)", exe)
		}
	}
}

// TC-LSP-4 (FR-LSP-4·5 / V-LSP-2·3): 탐색 순서는 ①설정 ②PATH ③전용 디렉터리다.
// 그리고 **어디서 찾았는지가 실린다** — 사용자가 "왜 저 서버가 쓰이는가" 를
// 설명할 수 있어야 한다.
func TestLocate_Order(t *testing.T) {
	dir := t.TempDir()
	managed := filepath.Join(dir, "managed")
	d0, _ := DescriptorForExt(".go")
	managedExe := putManaged(t, managed, d0)
	// FR-LWP-9: 검사가 놓는 파일도 **그 OS 가 실행 가능하다고 볼 이름**이어야
	// 한다. 확장자 없이 놓으면 Windows 는 실행 파일이 아니라고 보고(FR-LWP-3),
	// 그러면 검사가 제품의 옳은 판정을 실패로 읽는다.
	cfgExe := filepath.Join(dir, "mine", "gopls"+platform.Current().Paths.ExeSuffix())
	if err := os.MkdirAll(filepath.Dir(cfgExe), 0o755); err != nil {
		t.Fatal(err)
	}
	mustExec(t, cfgExe)

	d, _ := DescriptorForExt(".go")
	onPath := map[string]string{"gopls": "/usr/bin/gopls", "go": "/usr/bin/go"}

	// ① 설정이 이긴다.
	st := testLocator(onPath, managed, map[string]string{d.ID: cfgExe}).Locate(d)
	if !st.Found || st.Origin != OriginConfig || st.Exe != cfgExe {
		t.Fatalf("설정 경로가 이기지 않았다: %+v", st)
	}
	// ② 설정이 없으면 PATH.
	st = testLocator(onPath, managed, nil).Locate(d)
	if !st.Found || st.Origin != OriginPath || st.Exe != "/usr/bin/gopls" {
		t.Fatalf("PATH 가 두 번째가 아니다: %+v", st)
	}
	// ③ PATH 에도 없으면 전용 디렉터리.
	st = testLocator(map[string]string{"go": "/usr/bin/go"}, managed, nil).Locate(d)
	if !st.Found || st.Origin != OriginManaged {
		t.Fatalf("전용 디렉터리가 세 번째가 아니다: %+v", st)
	}
	if st.Exe != managedExe {
		t.Fatalf("전용 디렉터리의 실행 파일이 아니다: %s (기대 %s)", st.Exe, managedExe)
	}
}

// TC-LSP-5 (FR-LSP-6·11 / V-LSP-4): 못 찾았을 때, 설치할 수 있는지와 **무엇이
// 없는지**를 함께 알린다. "설치 실패" 는 사용자가 다음에 할 일을 알려주지 않는다.
func TestLocate_NotFoundReportsInstaller(t *testing.T) {
	d, _ := DescriptorForExt(".go")

	// go 가 PATH 에 있으면 받을 수 있다.
	st := testLocator(map[string]string{"go": "/usr/bin/go"}, t.TempDir(), nil).Locate(d)
	if st.Found {
		t.Fatal("없는 서버를 찾았다고 했다")
	}
	if st.Installer != "go" || !st.CanInstall {
		t.Fatalf("go 가 있는데 설치 가능으로 보고하지 않았다: %+v", st)
	}

	// go 가 없으면 받을 수 없다는 사실과 **그 도구 이름**이 함께 온다.
	st = testLocator(nil, t.TempDir(), nil).Locate(d)
	if st.CanInstall {
		t.Fatal("go 가 없는데 설치 가능이라고 했다")
	}
	if st.Installer != "go" {
		t.Fatalf("무엇이 없는지를 알리지 않았다: Installer=%q", st.Installer)
	}
}

// TC-LSP-6 (FR-LSP-47): 상태는 캐시가 아니라 관측이다 — 전용 디렉터리의 실행
// 파일을 지우면 다시 "없음" 이 된다.
func TestLocate_IsObservationNotCache(t *testing.T) {
	managed := t.TempDir()
	d, _ := DescriptorForExt(".go")
	exe := putManaged(t, managed, d)
	l := testLocator(nil, managed, nil)

	if st := l.Locate(d); !st.Found {
		t.Fatalf("설치된 서버를 못 찾았다: %+v", st)
	}
	if err := os.Remove(exe); err != nil {
		t.Fatal(err)
	}
	if st := l.Locate(d); st.Found {
		t.Fatalf("지운 서버를 여전히 있다고 했다: %+v", st)
	}
}

// TC-LSP-7 (FR-LSP-4): 전용 디렉터리에 **실행 권한 없는** 같은 이름의 파일이
// 있으면 그것을 서버로 삼지 않는다.
func TestLocate_ManagedNeedsExecBit(t *testing.T) {
	// FR-LWP-2·3: 이것은 **POSIX 의 규약**이다. Windows 에는 실행 비트가 없고
	// 판정이 확장자이므로, 같은 이름으로 놓은 파일은 거기서 실행 가능이 맞다 —
	// 그 사실을 여기서 실패로 적으면 검사가 OS 를 착각하게 된다.
	if platform.Current().OS == platform.Windows {
		t.Skip("Windows 는 권한 비트를 갖지 않는다 (FR-LWP-3)")
	}
	managed := t.TempDir()
	d, _ := DescriptorForExt(".go")
	p := ManagedExe(managed, d)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("not exec"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := testLocator(nil, managed, nil).Locate(d); st.Found {
		t.Fatalf("실행할 수 없는 파일을 서버로 삼았다: %+v", st)
	}
}

func mustExec(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

// TC-LSP-8 (FR-LSP-7b / V-LSP-5b): npm 으로 받는 서술자는 `node_modules/.bin` 에서
// 발견된다. 한 자리만 보면 우리가 받아 두고도 못 찾는다.
func TestLocate_ManagedLayoutPerTool(t *testing.T) {
	managed := t.TempDir()
	ts, _ := DescriptorForExt(".ts")
	if ts.Installer.Tool != "npm" {
		t.Fatalf("이 검사는 npm 서술자를 전제한다: %s", ts.Installer.Tool)
	}
	// 재는 것은 **디렉터리**다 (FR-LSP-7b). 파일 이름은 OS 마다 다르며
	// (Windows 는 `.cmd` shim, FR-LWP-5) 그 이름을 검사가 따로 적으면 제품과
	// 두 벌이 되어 배치가 바뀔 때 먼저 통과한다.
	wantDir := filepath.Join(managed, "node_modules", ".bin")
	want := ManagedExe(managed, ts)
	if filepath.Dir(want) != wantDir {
		t.Fatalf("npm 서술자의 자리가 다르다: %s (기대 %s 아래)", want, wantDir)
	}
	if !strings.HasPrefix(filepath.Base(want), ts.Exe) {
		t.Fatalf("npm 서술자의 이름이 실행 파일에서 나오지 않았다: %s", want)
	}
	putManaged(t, managed, ts)
	st := testLocator(nil, managed, nil).Locate(ts)
	if !st.Found || st.Origin != OriginManaged || st.Exe != want {
		t.Fatalf("node_modules/.bin 의 서버를 못 찾았다: %+v", st)
	}

	// go 서술자는 그 자리에 있지 않다 — 둘이 섞이면 한쪽이 다른 쪽을 가린다.
	g, _ := DescriptorForExt(".go")
	if ManagedExe(managed, g) == want {
		t.Fatal("go 와 npm 서술자가 같은 자리를 쓴다")
	}
	if st := testLocator(nil, managed, nil).Locate(g); st.Found {
		t.Fatalf("npm 자리의 파일을 go 서버로 삼았다: %+v", st)
	}
}
