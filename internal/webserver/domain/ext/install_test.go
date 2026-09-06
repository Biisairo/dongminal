package ext

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type call struct {
	name string
	args []string
	env  []string
	dir  string
}

type recorder struct {
	calls []call
	// onExec 는 실행을 흉내 낸다. 실제 조달이 놓았을 파일을 여기서 놓는다.
	onExec func(c call) error
}

func (r *recorder) exec(_ context.Context, name string, args, env []string, dir string) ([]byte, error) {
	c := call{name: name, args: args, env: env, dir: dir}
	r.calls = append(r.calls, c)
	if r.onExec != nil {
		if err := r.onExec(c); err != nil {
			return []byte("실패 출력"), err
		}
	}
	return []byte("완료"), nil
}

func testInstaller(root string, rec *recorder, onPath map[string]string, fetch Fetch) *Installer {
	return &Installer{
		Root:  root,
		Fetch: fetch,
		Exec:  rec.exec,
		LookPath: func(name string) (string, error) {
			if p, ok := onPath[name]; ok {
				return p, nil
			}
			return "", errors.New("not found")
		},
	}
}

// TC-EXT-50 (FR-EXT-14·17·19 / V-EXT-9): toolchain 조달은 호스트 도구를 셸 없이 부른다.
func TestInstall_ToolchainRunsHostTool(t *testing.T) {
	root := t.TempDir()
	m := mustParse(t, goPack)
	rec := &recorder{onExec: func(c call) error {
		// `go install` 이 GOBIN 에 놓았을 것을 흉내 낸다.
		return putExe(ManagedExe(root, m, m.Servers[0]))
	}}
	out := testInstaller(root, rec, map[string]string{"go": "/usr/bin/go"}, nil).
		Install(context.Background(), m, nil)

	if !out.OK {
		t.Fatalf("조달이 실패했다: %+v", out)
	}
	if len(rec.calls) != 1 {
		t.Fatalf("한 번 불러야 한다: %+v", rec.calls)
	}
	c := rec.calls[0]
	if c.name != "go" {
		t.Fatalf("호스트 도구를 부르지 않았다: %s", c.name)
	}
	// FR-EXT-17: 이름과 인자가 **분리된 채** 간다 — 셸이 끼면 선언의 값이 명령이 된다.
	if len(c.args) < 2 || c.args[0] != "install" {
		t.Fatalf("인자가 분리되지 않았다: %+v", c.args)
	}
	for _, a := range c.args {
		if strings.ContainsAny(a, "|;&$`") {
			t.Fatalf("셸 메타문자가 인자에 있다: %q", a)
		}
	}
	// V-EXT-4: 환경이 격리돼 있다.
	env := envMap(c.env)
	if !underRoot(root, env["GOMODCACHE"]) || !underRoot(root, env["GOCACHE"]) {
		t.Fatalf("빌드 캐시가 격리되지 않았다: %+v", env)
	}
}

// TC-EXT-51 (FR-EXT-14 / V-EXT-9): 호스트 도구가 없으면 **이름으로** 말하고 멈춘다.
//
// gopls 가 이 갈래다 — prebuilt 가 어디에도 없으므로(§2.3) 받을 URL 이 없다.
func TestInstall_ToolchainWithoutTool(t *testing.T) {
	root := t.TempDir()
	rec := &recorder{}
	out := testInstaller(root, rec, nil, nil).Install(context.Background(), mustParse(t, goPack), nil)

	if out.OK {
		t.Fatal("도구가 없는데 성공했다")
	}
	if !strings.Contains(out.Reason, "go") {
		t.Fatalf("사유가 도구 이름을 말하지 않는다: %q", out.Reason)
	}
	if len(rec.calls) != 0 {
		t.Fatalf("도구 없이 무언가를 실행했다: %+v", rec.calls)
	}
}

// TC-EXT-52 (FR-EXT-23 / V-EXT-10): **빌드가 끝나면 캐시를 즉시 지운다.**
//
// §2.1 의 889 MB 는 산출물이 아니라 부산물이다. 남겨 두면 39 MB 를 얻자고 1 GB 를
// 쓴 채로 있게 된다.
func TestInstall_ToolchainClearsBuildCache(t *testing.T) {
	root := t.TempDir()
	m := mustParse(t, goPack)
	rec := &recorder{onExec: func(c call) error {
		// 도구가 캐시를 채웠다고 하자.
		env := envMap(c.env)
		for _, k := range []string{"GOMODCACHE", "GOCACHE"} {
			if err := os.MkdirAll(env[k], 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(filepath.Join(env[k], "big"), make([]byte, 1024), 0o644); err != nil {
				return err
			}
		}
		return putExe(ManagedExe(root, m, m.Servers[0]))
	}}
	out := testInstaller(root, rec, map[string]string{"go": "/usr/bin/go"}, nil).
		Install(context.Background(), m, nil)
	if !out.OK {
		t.Fatalf("조달이 실패했다: %+v", out)
	}
	env := envMap(rec.calls[0].env)
	for _, k := range []string{"GOMODCACHE", "GOCACHE"} {
		if _, err := os.Stat(env[k]); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s 가 남았다 (FR-EXT-23): %s", k, env[k])
		}
	}
	// 산출물은 남아야 한다 — 캐시와 함께 지우면 조달이 무의미해진다.
	if !isExecutable(ManagedExe(root, m, m.Servers[0])) {
		t.Fatal("산출물까지 지웠다")
	}
}

// TC-EXT-53 (FR-EXT-19): 성공의 판정은 **종료 코드가 아니라 실행 파일의 존재**다.
//
// 종료 코드만 보면 "받았습니다" 라고 말한 뒤 상태가 여전히 "없음" 이 되고, 그 모순은
// 우리 버그로 읽힌다.
func TestInstall_SuccessRequiresTheExe(t *testing.T) {
	root := t.TempDir()
	rec := &recorder{} // 0 을 내지만 아무것도 놓지 않는다
	out := testInstaller(root, rec, map[string]string{"go": "/usr/bin/go"}, nil).
		Install(context.Background(), mustParse(t, goPack), nil)
	if out.OK {
		t.Fatal("아무것도 놓이지 않았는데 성공이라 했다 (FR-EXT-19)")
	}
}

// TC-EXT-54 (FR-EXT-5): 팩의 서버가 **전부** 서야 성공이다.
func TestInstall_PackNeedsEveryServer(t *testing.T) {
	root := t.TempDir()
	m := mustParse(t, packJSON)
	node := runtimeWithHostNpm(t)

	// 둘 중 하나만 놓는다.
	rec := &recorder{onExec: func(call) error { return putExe(ManagedExe(root, m, m.Servers[0])) }}
	out := testInstaller(root, rec, map[string]string{"node": "/usr/bin/node", "npm": "/usr/bin/npm"}, nil).
		Install(context.Background(), m, []Manifest{node})
	if out.OK {
		t.Fatalf("서버 하나가 빠졌는데 성공이라 했다: %+v", out)
	}
	if !strings.Contains(out.Reason, m.Servers[1].Exe) {
		t.Fatalf("사유가 빠진 서버를 말하지 않는다: %q", out.Reason)
	}
}

// TC-EXT-55 (FR-EXT-12): npm 조달은 **그 런타임의 npm** 으로 한다.
//
// 호스트 npm 을 찾아 쓰면 우리가 고정한 판이 아닌 것으로 설치되고, 그 차이는
// 기계마다 다른 결과가 된다.
func TestInstall_NPMUsesRuntimeNpm(t *testing.T) {
	root := t.TempDir()
	m := mustParse(t, npmPack)
	node := mustParse(t, nodeRuntime)
	putRuntimeFiles(t, root, node)

	rec := &recorder{onExec: func(call) error { return putExe(ManagedExe(root, m, m.Servers[0])) }}
	// 호스트에도 npm 이 있지만 우리 것을 써야 한다.
	out := testInstaller(root, rec, map[string]string{"npm": "/usr/bin/npm"}, nil).
		Install(context.Background(), m, []Manifest{node})
	if !out.OK {
		t.Fatalf("조달이 실패했다: %+v", out)
	}
	c := rec.calls[0]
	if !underRoot(root, c.name) {
		t.Fatalf("우리 런타임이 아니라 %q 를 불렀다 (FR-EXT-12)", c.name)
	}
	joined := strings.Join(c.args, " ")
	if !strings.Contains(joined, m.Source.Packages[0]) {
		t.Fatalf("선언의 패키지를 넘기지 않았다: %+v", c.args)
	}
	if !strings.Contains(joined, PluginDir(root, m.ID)) {
		t.Fatalf("팩 디렉터리로 격리되지 않았다: %+v", c.args)
	}
}

// TC-EXT-56 (FR-EXT-7 / V-EXT-8): 런타임이 없으면 **먼저 받는다** — 그리고 그것이
// lazy 의 내용이다 (FR-EXT-7b).
func TestInstall_FetchesRuntimeFirst(t *testing.T) {
	root := t.TempDir()
	m := mustParse(t, npmPack)
	node := mustParse(t, nodeRuntime)
	tg, ok := node.Source.Targets[CurrentTarget()]
	if !ok {
		t.Skipf("이 타깃(%s)의 선언이 검사 매니페스트에 없다", CurrentTarget())
	}

	blob := makeTarGz(t, []tarEntry{
		{name: "pkg/" + tg.Provides["node"], body: "#!/bin/sh\n", mode: 0o755},
		{name: "pkg/" + tg.Provides["npm"], body: "#!/bin/sh\n", mode: 0o755},
	})
	node.Source.Targets[CurrentTarget()] = Target{
		URL: tg.URL, SHA256: sum(blob), Strip: 1, Provides: tg.Provides,
	}

	var fetched int
	rec := &recorder{onExec: func(call) error { return putExe(ManagedExe(root, m, m.Servers[0])) }}
	inst := testInstaller(root, rec, nil, func(_ context.Context, _ string, w io.Writer) error {
		fetched++
		_, err := w.Write(blob)
		return err
	})
	out := inst.Install(context.Background(), m, []Manifest{node})
	if !out.OK {
		t.Fatalf("조달이 실패했다: %+v", out)
	}
	if fetched != 1 {
		t.Fatalf("런타임을 정확히 한 번 받아야 한다: %d", fetched)
	}
	if !isExecutable(filepath.Join(RuntimeDir(root, node), filepath.FromSlash(tg.Provides["node"]))) {
		t.Fatal("런타임이 격리 칸에 서지 않았다")
	}
}

// TC-EXT-57 (FR-EXT-7b): 호스트에 런타임이 있으면 **받지 않는다.**
//
// 있는 것을 두고 또 받으면 그것이 곧 "컴퓨터를 건드리는" 일이 된다.
func TestInstall_SkipsRuntimeWhenHostHasIt(t *testing.T) {
	root := t.TempDir()
	m := mustParse(t, npmPack)
	node := mustParse(t, nodeRuntime)

	var fetched int
	rec := &recorder{onExec: func(call) error { return putExe(ManagedExe(root, m, m.Servers[0])) }}
	inst := testInstaller(root, rec, map[string]string{"node": "/usr/bin/node", "npm": "/usr/bin/npm"},
		func(_ context.Context, _ string, _ io.Writer) error { fetched++; return nil })
	out := inst.Install(context.Background(), m, []Manifest{node})
	if !out.OK {
		t.Fatalf("조달이 실패했다: %+v", out)
	}
	if fetched != 0 {
		t.Fatalf("호스트에 있는데 런타임을 받았다 (FR-EXT-7b): %d", fetched)
	}
}

// TC-EXT-58 (FR-EXT-11): archive 팩의 서버는 선언이 정한 자리에서 선다.
func TestInstall_ArchiveServer(t *testing.T) {
	root := t.TempDir()
	blob := makeTarGz(t, []tarEntry{{name: "wrap/bin/thing", body: "#!/bin/sh\n", mode: 0o755}})
	js := `{"id":"thing","kind":"server","source":{"kind":"archive","targets":{"` +
		CurrentTarget() + `":{"url":"https://e.test/a.tar.gz","sha256":"` + sum(blob) +
		`","strip":1,"bin":"bin/thing"}}},
		"servers":[{"id":"thing","exe":"thing","langs":["x"],"exts":[".x"]}]}`
	if CurrentTarget() == "" {
		t.Skip("이 빌드의 타깃 이름을 모른다")
	}
	m := mustParse(t, js)
	rec := &recorder{}
	inst := testInstaller(root, rec, nil, func(_ context.Context, _ string, w io.Writer) error {
		_, err := w.Write(blob)
		return err
	})
	out := inst.Install(context.Background(), m, nil)
	if !out.OK {
		t.Fatalf("조달이 실패했다: %+v", out)
	}
	if len(rec.calls) != 0 {
		t.Fatalf("archive 조달이 명령을 실행했다: %+v", rec.calls)
	}
	if !isExecutable(filepath.Join(PluginDir(root, "thing"), "bin", "thing")) {
		t.Fatal("아카이브의 실행 파일이 서지 않았다")
	}
}

func putExe(p string) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755)
}

// runtimeWithHostNpm 은 호스트 node 로 채워질 런타임 선언이다.
func runtimeWithHostNpm(t *testing.T) Manifest {
	t.Helper()
	return mustParse(t, nodeRuntime)
}

// putRuntimeFiles 는 런타임이 이미 받아져 있는 상태를 만든다.
func putRuntimeFiles(t *testing.T, root string, m Manifest) {
	t.Helper()
	tg, ok := m.Source.Targets[CurrentTarget()]
	if !ok {
		t.Skipf("이 타깃(%s)의 선언이 검사 매니페스트에 없다", CurrentTarget())
	}
	for _, rel := range tg.Provides {
		if err := putExe(filepath.Join(RuntimeDir(root, m), filepath.FromSlash(rel))); err != nil {
			t.Fatal(err)
		}
	}
}
