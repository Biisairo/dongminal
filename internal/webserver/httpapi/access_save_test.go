package httpapi

import (
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

// SAFETY_CORRECTNESS_SRS 묶음 A (TC-SAF-1·2).
//
// 접근 허용 목록의 저장이 실패하면 **그 사실이 돌아가야 한다.** 200 을 답하면
// 사용자는 목록을 켰다고 믿고, 메모리에는 반영되므로 그 세션에서는 동작하며,
// 다음 기동에서 **조용히 열린 서버**를 만난다.
//
// 같은 저장소의 `settingsStore.Save()` 는 *"실패를 돌려준다 (M3 DoD)"* 라고
// 적고 실제로 돌려준다. 두 설정 저장소가 반대로 동작하고 있었다.

// unwritablePath 는 쓰기가 반드시 실패하는 경로를 만든다. 부모를 **파일**로
// 두면 그 아래에 무엇도 만들 수 없다 — 권한 모드보다 이식성이 좋다 (root 로
// 도는 CI 에서 0o500 은 막지 못한다).
func unwritablePath(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("blocker 생성: %v", err)
	}
	return filepath.Join(blocker, "access.json")
}

func newAccessStoreAt(t *testing.T, path string) *accessStore {
	t.Helper()
	st := newAccessStore(path)
	st.lookupHost = func(string) ([]string, error) { return nil, nil }
	st.interfaceAddrs = func() ([]netip.Addr, error) { return nil, nil }
	return st
}

// TC-SAF-1 — 디스크 쓰기가 실패하면 setConfig 가 실패를 돌려준다.
func TestAccessStore_SaveFailureIsReported(t *testing.T) {
	st := newAccessStoreAt(t, unwritablePath(t))

	err := st.setConfig(accessConfig{
		Enabled: true,
		Entries: []accessEntry{{Value: "10.0.0.1"}},
	})
	if err == nil {
		t.Fatal("쓸 수 없는 경로인데 setConfig 가 성공을 답했다")
	}
	if err != errAccessSaveFailed {
		t.Errorf("사유가 errAccessSaveFailed 가 아니다: %v", err)
	}
}

// TC-SAF-1b — 저장에 실패하면 메모리도 되돌린다 (FR-SAF-2 · D-SAF-1).
//
// 디스크와 메모리가 갈리면 다음 기동의 동작을 아무도 예측할 수 없다. 접근
// 목록은 그 불확실성을 감당할 수 있는 대상이 아니다.
func TestAccessStore_SaveFailureRollsBackMemory(t *testing.T) {
	st := newAccessStoreAt(t, unwritablePath(t))

	before := st.config()
	if before.Enabled {
		t.Fatal("새 저장소가 이미 켜져 있다 — 검사의 전제가 깨졌다")
	}

	_ = st.setConfig(accessConfig{
		Enabled: true,
		Entries: []accessEntry{{Value: "10.0.0.1"}},
	})

	after := st.config()
	if after.Enabled {
		t.Error("저장에 실패했는데 메모리는 켜진 채로 남았다 — 다음 기동에 열린 서버가 된다")
	}
	if len(after.Entries) != len(before.Entries) {
		t.Errorf("저장에 실패했는데 목록이 바뀌었다: %d개 (want %d개)", len(after.Entries), len(before.Entries))
	}
}

// TC-SAF-2 — 정상 경로는 그대로다 (회귀 방지).
func TestAccessStore_SaveSuccessUnchanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.json")
	st := newAccessStoreAt(t, path)

	if err := st.setConfig(accessConfig{
		Enabled: true,
		Entries: []accessEntry{{Value: "10.0.0.1", Label: "노트북"}},
	}); err != nil {
		t.Fatalf("정상 경로가 실패했다: %v", err)
	}
	got := st.config()
	if !got.Enabled || len(got.Entries) != 1 || got.Entries[0].Value != "10.0.0.1" {
		t.Fatalf("메모리에 반영되지 않았다: %+v", got)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("디스크에 적히지 않았다: %v", err)
	}
	// 다시 읽어도 같아야 한다 — 저장의 뜻이 그것이다.
	again := newAccessStoreAt(t, path)
	if re := again.config(); !re.Enabled || len(re.Entries) != 1 {
		t.Fatalf("재로드 결과가 다르다: %+v", re)
	}
}
