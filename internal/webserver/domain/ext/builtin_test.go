package ext

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TC-EXT-60 (FR-EXT-34): **동봉 선언은 전부 유효하다.**
//
// 여기서 실패하면 그것은 사용자의 파일이 아니라 우리가 넣은 것이므로 우리 잘못이다.
// 검증이 조달 시점까지 미뤄지면 첫 사용자가 그것을 발견하게 된다.
func TestBuiltins_AllParse(t *testing.T) {
	ms, err := Builtins()
	if err != nil {
		t.Fatalf("동봉 선언이 유효하지 않다: %v", err)
	}
	if len(ms) == 0 {
		t.Fatal("동봉된 선언이 하나도 없다")
	}
	var runtimes, servers int
	for _, m := range ms {
		switch m.Kind {
		case KindRuntime:
			runtimes++
		case KindServer:
			servers++
			if len(m.Servers) == 0 {
				t.Errorf("%s 가 서버를 내지 않는다", m.ID)
			}
		}
	}
	if runtimes == 0 {
		t.Error("런타임 선언이 없다 — npm 팩들이 설 수 없다")
	}
	if servers == 0 {
		t.Error("서버 팩이 없다")
	}
}

// TC-EXT-61 (FR-EXT-37 / D-P7): **판이 박혀 있다.**
//
// `@latest` 는 sha256 을 적을 수 없고, 같은 선언이 기계마다 다른 것을 받게 한다.
func TestBuiltins_VersionsArePinned(t *testing.T) {
	ms, err := Builtins()
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range ms {
		for _, p := range m.Source.Packages {
			if !strings.Contains(p, "@") || strings.HasSuffix(p, "@latest") {
				t.Errorf("%s: 패키지의 판이 박히지 않았다: %q", m.ID, p)
			}
		}
		for _, a := range m.Source.Args {
			if strings.HasSuffix(a, "@latest") {
				t.Errorf("%s: 조달 인자의 판이 박히지 않았다: %q", m.ID, a)
			}
		}
		if m.Version == "" {
			t.Errorf("%s: version 이 없다", m.ID)
		}
	}
}

// TC-EXT-62 (FR-EXT-11): 런타임 선언이 **이 빌드의 타깃**을 덮는다.
//
// 덮지 못하면 이 플랫폼에서는 npm 팩이 하나도 설 수 없다. 그것이 사실이라면
// 그 사실을 여기서 알아야 하고, 사용자가 버튼을 눌러 알게 되어서는 안 된다.
func TestBuiltins_RuntimeCoversThisTarget(t *testing.T) {
	if CurrentTarget() == "" {
		t.Skipf("이 빌드의 타깃 이름을 모른다 (%s)", CurrentTarget())
	}
	ms, err := Builtins()
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range Runtimes(ms) {
		tg, ok := m.Source.Targets[CurrentTarget()]
		if !ok {
			t.Fatalf("%s 가 이 타깃(%s)을 덮지 않는다", m.ID, CurrentTarget())
		}
		// 런타임은 자기 이름과 npm 을 내야 한다 — 그 둘로 npm 팩을 조달한다.
		for _, want := range []string{m.ID, "npm"} {
			if tg.Provides[want] == "" {
				t.Errorf("%s[%s] 가 %q 를 내지 않는다", m.ID, CurrentTarget(), want)
			}
		}
	}
}

// TC-EXT-63 (FR-EXT-4): 한 확장자를 두 팩이 주장하지 않는다.
//
// `ServerForExt` 는 먼저 만난 것을 쓰므로, 겹치면 어느 서버가 뜰지가 팩의 이름
// 순서로 정해진다 — 사용자가 설명할 수 없는 동작이 된다.
func TestBuiltins_NoExtCollision(t *testing.T) {
	ms, err := Builtins()
	if err != nil {
		t.Fatal(err)
	}
	owner := map[string]string{}
	for _, m := range ms {
		for _, s := range m.Servers {
			for _, e := range s.Exts {
				if prev, ok := owner[e]; ok {
					t.Errorf("%s 를 %s 와 %s 가 함께 주장한다", e, prev, m.ID+"/"+s.ID)
					continue
				}
				owner[e] = m.ID + "/" + s.ID
			}
		}
	}
}

// TC-EXT-64 (FR-EXT-34·35): 전개는 **선언만** 놓고, 놓은 것은 다시 읽힌다.
func TestDeploy_WritesManifestsOnly(t *testing.T) {
	root := t.TempDir()
	if errs := Deploy(root); len(errs) != 0 {
		t.Fatalf("전개가 실패했다: %v", errs)
	}
	got, errs := Load(root)
	if len(errs) != 0 {
		t.Fatalf("전개한 것을 다시 읽지 못했다: %v", errs)
	}
	want, _ := Builtins()
	if len(got) != len(want) {
		t.Fatalf("전개한 수가 다르다: %d (기대 %d)", len(got), len(want))
	}
	// FR-EXT-35: 선언 말고는 아무것도 놓지 않는다.
	for _, m := range got {
		entries, err := os.ReadDir(PluginDir(root, m.ID))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 || entries[0].Name() != ManifestName {
			t.Errorf("%s 의 자리에 선언 말고 다른 것이 있다: %d개", m.ID, len(entries))
		}
	}
	// 런타임도 받아 두지 않는다 (FR-EXT-7b: lazy).
	if _, err := os.Stat(RuntimesDir(root)); err == nil {
		t.Error("전개가 런타임을 받았다 — 눌러야 받는다 (FR-EXT-16)")
	}
}

// TC-EXT-65 (FR-EXT-36 / V-EXT-13): 사용자가 고친 선언을 전개가 덮지 않는다.
func TestDeploy_DoesNotOverwriteUserEdits(t *testing.T) {
	root := t.TempDir()
	if errs := Deploy(root); len(errs) != 0 {
		t.Fatal(errs)
	}
	ms, _ := Builtins()
	target := ms[0]
	p := filepath.Join(PluginDir(root, target.ID), ManifestName)

	edited, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	mine := append(edited, ' ') // 손댄 흔적
	if err := os.WriteFile(p, mine, 0o644); err != nil {
		t.Fatal(err)
	}

	if errs := Deploy(root); len(errs) != 0 {
		t.Fatal(errs)
	}
	after, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(mine) {
		t.Fatal("전개가 사용자의 편집을 덮었다 (FR-EXT-36)")
	}
}

// TC-EXT-66 (FR-EXT-36): 사용자가 지운 팩을 되살리지 않는다. **지움은 의사표시다.**
func TestDeploy_DoesNotResurrectDeleted(t *testing.T) {
	root := t.TempDir()
	if errs := Deploy(root); len(errs) != 0 {
		t.Fatal(errs)
	}
	ms, _ := Builtins()
	gone := ms[0].ID
	if err := os.RemoveAll(PluginDir(root, gone)); err != nil {
		t.Fatal(err)
	}

	if errs := Deploy(root); len(errs) != 0 {
		t.Fatal(errs)
	}
	if _, err := os.Stat(PluginDir(root, gone)); err == nil {
		t.Fatalf("%s 가 되살아났다 — 재기동마다 지운 것이 돌아온다 (FR-EXT-36)", gone)
	}
}
