package runtime

import (
	"os"
	"path/filepath"
	"testing"
)

// PERFORMANCE_HARDENING_SRS FR-PRF-78·79 · TC-PRF-24 (`AUDIT-go-infra.md` 항목 8).
//
// **재는 것은 벽시계가 아니라 진입 수다** (FR-PRF-3). 두 번째 설치는 darwin 에서
// 2ms 이고 그 차이는 기계 소음에 묻힌다 — 이 항목의 근거는 시간이 아니라
// **두 번 도는 것 자체**다.
//
// 진입했는가는 `Install` 이 남기는 흔적으로 본다. 설치는 헬퍼만 놓는 것이 아니라
// 셸 훅과 에이전트 플러그인도 편다 — 헬퍼만 손으로 놓아 두고 그 나머지가
// 생겼는지 보면 "돌았는가" 가 갈린다.
func TestEnsureInstalled_SkipsWhenHelpersAreHealthy(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	// 설치가 다시 돌면 되살아날 자리를 지운다 — 남아 있으면 건너뛴 것이다.
	//
	// **헬퍼가 아닌 것**을 고른다. 헬퍼를 지우면 `InspectHelpers` 가 깨졌다고
	// 답해 설치가 정당하게 돈다 — 그러면 이 검사가 재려는 것과 다른 것을 잰다.
	// 이름을 손으로 적지 않고 설치 산출물에서 **파생한다** (규약 9).
	marker := nonHelperArtifact(t, dir)
	if err := os.RemoveAll(marker); err != nil {
		t.Fatal(err)
	}

	if err := EnsureInstalled(dir); err != nil {
		t.Fatalf("EnsureInstalled: %v", err)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("헬퍼가 멀쩡한데 설치가 다시 돌았다 (FR-PRF-79)")
	}
}

// 데몬이 **단독으로** 뜬 경우다 — 그때는 깔아야 한다. 이것이 없으면 위 검사는
// "아무것도 안 하는 함수" 로도 통과한다.
func TestEnsureInstalled_InstallsWhenMissing(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureInstalled(dir); err != nil {
		t.Fatalf("EnsureInstalled: %v", err)
	}
	if st := InspectHelpers(dir); !st.Installed || len(st.Problems) > 0 {
		t.Fatalf("빈 자리에서 설치가 돌지 않았다: %+v", st)
	}
}

// 깨진 자리도 고친다 — `InspectHelpers` 가 "있다" 와 "멀쩡하다" 를 가르는 이유다.
func TestEnsureInstalled_RepairsBrokenHelper(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	names := helperNames()
	if len(names) == 0 {
		t.Fatal("헬퍼 이름이 없다 — 검사가 공회전한다")
	}
	victim := filepath.Join(dir, helperFile(names[0]))
	if err := os.RemoveAll(victim); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(dir); err != nil {
		t.Fatalf("EnsureInstalled: %v", err)
	}
	if _, err := os.Lstat(victim); err != nil {
		t.Fatalf("깨진 헬퍼를 고치지 않았다: %v", err)
	}
}

// nonHelperArtifact 는 설치가 놓은 것 중 **헬퍼가 아닌** 첫 항목이다.
func nonHelperArtifact(t *testing.T, dir string) string {
	t.Helper()
	helpers := map[string]bool{}
	for _, n := range helperNames() {
		helpers[helperFile(n)] = true
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		if !helpers[e.Name()] {
			return filepath.Join(dir, e.Name())
		}
	}
	t.Fatal("설치가 헬퍼 말고는 아무것도 놓지 않았다 — 검사가 공회전한다")
	return ""
}
