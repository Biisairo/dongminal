package apierr

import "testing"

// TC-ERR-5: **모든 코드에 안내문이 있다** (FR-ERR-10 / D-ERR-4).
//
// 코드만 늘고 안내가 없는 문서는 없는 것보다 나쁘다 — 있다고 믿게 만든다.
func TestEveryCodeIsDocumented(t *testing.T) {
	for _, c := range AllCodes() {
		d, ok := CodeDoc[c]
		if !ok {
			t.Errorf("코드 %q 에 안내가 없다 — codes_doc.go 의 CodeDoc 에 더하세요", c)
			continue
		}
		if d.Meaning == "" {
			t.Errorf("코드 %q 의 의미가 비었다", c)
		}
		// FR-ERR-9: "무엇이 잘못됐는가" 만으로는 부족하다. 사용자가 **다음에 할
		// 일**이 적혀 있어야 한다.
		if d.Recover == "" {
			t.Errorf("코드 %q 에 복구 안내가 없다", c)
		}
	}
}

// TC-ERR-7 의 짝: 안내만 있고 코드가 없는 것도 결함이다 — 지워진 코드의 안내가
// 남아 있으면 아무도 그것을 모른다.
func TestEveryDocHasACode(t *testing.T) {
	known := map[string]bool{}
	for _, c := range AllCodes() {
		known[c] = true
	}
	for c := range CodeDoc {
		if !known[c] {
			t.Errorf("안내에 있는 %q 가 코드 목록에 없다 — 지워진 코드인가?", c)
		}
	}
}

// TC-ERR-8: 코드 문자열이 겹치지 않는다 (기존 V6 의 확장).
func TestAllCodesUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range AllCodes() {
		if seen[c] {
			t.Errorf("코드가 두 번 나온다: %q", c)
		}
		seen[c] = true
	}
}
