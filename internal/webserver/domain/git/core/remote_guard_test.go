package core

import "testing"

// 원격 목록의 쓰기 가드 (GIT_ACTIONS_SRS §3.5 FR-GIT-269, 검증 V196).
//
// `git remote` 는 하위 명령 하나 안에 목록(읽기)과 add/remove(쓰기)가 함께 있다.
// 목록은 `config --list` 로 이미 얻으므로(query/remote.go) **쓰기 목록에만** 두고,
// 지나갈 수 있는 하위 명령을 add·remove 둘로 못박는다 — 열어 두면 화면에 없는
// 변경(set-url·prune·update)이 API 직접 호출로 들어온다.

func TestGuardWriteArgs_RemoteLimitedToAddAndRemove(t *testing.T) {
	ok := [][]string{
		{"remote", "add", "origin", "/tmp/remote.git"},
		{"remote", "remove", "origin"},
	}
	for _, argv := range ok {
		if err := GuardWriteArgs(argv); err != nil {
			t.Errorf("GuardWriteArgs(%q) = %v, want nil", argv, err)
		}
	}
	bad := [][]string{
		{"remote"},
		{"remote", "set-url", "origin", "/tmp/x.git"},
		{"remote", "prune", "origin"},
		{"remote", "update"},
		{"remote", "add", "origin"},
		{"remote", "add", "origin", "/tmp/x.git", "extra"},
		{"remote", "remove"},
		{"remote", "remove", "origin", "x"},
		{"remote", "add", "-x", "/tmp/x.git"},
		{"remote", "add", "origin", "--upload-pack=evil"},
	}
	for _, argv := range bad {
		if err := GuardWriteArgs(argv); err == nil {
			t.Errorf("GuardWriteArgs(%q) = nil, want error", argv)
		}
	}
	// 읽기 경로로는 여전히 갈 수 없다 (FR-GIT-95).
	if err := guardArgs([]string{"remote", "add", "origin", "/tmp/x.git"}); err == nil {
		t.Fatal("remote 가 읽기 경로를 지났다")
	}
	if readCommands["remote"] {
		t.Fatal("remote 가 readCommands 에 있다 — 교집합이 생겼다 (FR-GIT-95)")
	}
}
