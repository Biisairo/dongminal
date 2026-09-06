package ext

import (
	"os"
	"path/filepath"
	"testing"
)

func writePlugin(t *testing.T, root, id, js string) {
	t.Helper()
	dir := PluginDir(root, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte(js), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TC-EXT-20 (FR-EXT-1·2): 목록은 디렉터리에서 온다. 코드에 없다.
func TestLoad_ReadsAll(t *testing.T) {
	root := t.TempDir()
	writePlugin(t, root, "yaml", npmPack)
	writePlugin(t, root, "gopls", goPack)
	writePlugin(t, root, "node", nodeRuntime)

	got, errs := Load(root)
	if len(errs) != 0 {
		t.Fatalf("온전한 것들에서 오류가 났다: %v", errs)
	}
	if len(got) != 3 {
		t.Fatalf("셋을 읽어야 한다: %d", len(got))
	}
	var servers, runtimes int
	for _, m := range got {
		switch m.Kind {
		case KindServer:
			servers++
		case KindRuntime:
			runtimes++
		}
	}
	if servers != 2 || runtimes != 1 {
		t.Fatalf("종류가 갈리지 않았다: server=%d runtime=%d", servers, runtimes)
	}
}

// TC-EXT-21 (FR-EXT-8): 깨진 매니페스트는 **그 팩만** 죽인다.
//
// 하나가 전체를 멈추면, 사용자가 손으로 고친 파일 한 줄에 편집기의 코드 탐색이
// 통째로 사라진다.
func TestLoad_BrokenOneDoesNotKillOthers(t *testing.T) {
	root := t.TempDir()
	writePlugin(t, root, "yaml", npmPack)
	writePlugin(t, root, "broken", `{ this is not json`)
	writePlugin(t, root, "escaping", `{"id":"escaping","kind":"server",
	  "source":{"kind":"toolchain","tool":"go","args":["install","x"],"bin":"../../out"},
	  "servers":[{"id":"a","exe":"a","langs":["go"],"exts":[".go"]}]}`)
	writePlugin(t, root, "gopls", goPack)

	got, errs := Load(root)
	if len(got) != 2 {
		t.Fatalf("온전한 둘이 살아남아야 한다: %d", len(got))
	}
	if len(errs) != 2 {
		t.Fatalf("깨진 둘이 사유와 함께 보고돼야 한다: %v", errs)
	}
	// 사유에 어느 팩인지가 있어야 한다 — 없으면 사용자가 어느 파일을 고칠지 모른다.
	joined := ""
	for _, e := range errs {
		joined += e.Error()
	}
	for _, want := range []string{"broken", "escaping"} {
		if !contains(joined, want) {
			t.Fatalf("사유에 팩 이름 %q 가 없다: %s", want, joined)
		}
	}
}

// TC-EXT-22 (FR-EXT-2): plugin.json 이 없는 디렉터리는 팩이 아니다 — 조용히 지난다.
func TestLoad_IgnoresDirsWithoutManifest(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(PluginDir(root, "leftover"), "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	writePlugin(t, root, "gopls", goPack)

	got, errs := Load(root)
	if len(got) != 1 || len(errs) != 0 {
		t.Fatalf("매니페스트 없는 디렉터리가 오류가 됐다: got=%d errs=%v", len(got), errs)
	}
}

// TC-EXT-23 (FR-EXT-2): 플러그인 디렉터리 자체가 없는 것은 오류가 아니다.
// 아무 플러그인도 없는 상태가 정상이며(FR-EXT-16), 그때 편집기는 그냥 종전의 편집기다.
func TestLoad_MissingDirIsNotAnError(t *testing.T) {
	got, errs := Load(filepath.Join(t.TempDir(), "nope"))
	if len(got) != 0 || len(errs) != 0 {
		t.Fatalf("빈 상태가 오류가 됐다: got=%d errs=%v", len(got), errs)
	}
}

// TC-EXT-24 (FR-EXT-2·39): 디렉터리 이름과 매니페스트의 id 가 어긋나면 거절한다.
//
// 자리를 정하는 것은 id 이므로(PluginDir), 둘이 다르면 조달이 이 디렉터리가 아닌
// 곳에 쓰고 탐색은 여기를 본다.
func TestLoad_RejectsIDMismatch(t *testing.T) {
	root := t.TempDir()
	writePlugin(t, root, "elsewhere", goPack) // 안의 id 는 "gopls"
	got, errs := Load(root)
	if len(got) != 0 || len(errs) != 1 {
		t.Fatalf("id 가 어긋난 팩이 통과했다: got=%d errs=%v", len(got), errs)
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
