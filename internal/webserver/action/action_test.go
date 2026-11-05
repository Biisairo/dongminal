package action

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"dongminal/internal/webserver/apierr"
)

// FR-SDA-1: 참이면 why·args 를 싣지 않는다. 거절 상태는 와이어에 나가지 않는다.
func TestAnswerJSONShape(t *testing.T) {
	cases := []struct {
		name string
		a    Answer
		want string
	}{
		{"허용", Allow(), `{"ok":true}`},
		{"거절 · 값 없음", Deny(http.StatusConflict, apierr.CodeNothingToStash, nil), `{"ok":false,"why":"nothing_to_stash"}`},
		{"거절 · 값 있음", Deny(http.StatusConflict, apierr.CodeUntrackedOnly, map[string]any{"count": 2}),
			`{"ok":false,"why":"untracked_only","args":{"count":2}}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw, err := json.Marshal(c.a)
			if err != nil {
				t.Fatal(err)
			}
			if string(raw) != c.want {
				t.Fatalf("json = %s, want %s", raw, c.want)
			}
		})
	}
}

// M-2: 거절 상태는 생성자가 정한 값이고, 허용에는 상태가 없다.
func TestDenyKeepsStatus(t *testing.T) {
	if got := Deny(http.StatusBadRequest, apierr.CodeBadRequest, nil).Status; got != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", got)
	}
	if got := Allow().Status; got != 0 {
		t.Fatalf("허용의 status = %d, want 0", got)
	}
}

// M-3: 목록에 없는 동작·사유는 허용되지 않는다 — 판정 시험이 이것으로 사유를 묶는다.
func TestCatalogMayGive(t *testing.T) {
	if !Catalog.MayGive(GitStashCreate, apierr.CodeUntrackedOnly) {
		t.Fatal("git.stash.create 는 untracked_only 를 낼 수 있어야 한다")
	}
	if Catalog.MayGive(GitStashCreate, apierr.CodeJobBusy) {
		t.Fatal("목록에 없는 사유를 허용했다")
	}
	if Catalog.MayGive("no.such.action", apierr.CodeNothingToStash) {
		t.Fatal("목록에 없는 동작을 허용했다")
	}
}

// M-3: 목록의 사유는 apierr 의 와이어 코드다 — 실행 거절의 error 와 같은 값이어야 한다.
func TestCatalogReasonsAreWireCodes(t *testing.T) {
	known := map[string]bool{}
	for _, c := range apierr.AllCodes() {
		known[c] = true
	}
	for id, whys := range Catalog {
		for _, w := range whys {
			if !known[w] {
				t.Errorf("%s 의 사유 %q 가 apierr 코드가 아니다", id, w)
			}
		}
	}
}

// TC-SDA-3 의 탐침: 문구가 빠지면 잡고, 다 있으면 지난다.
func TestMissingPhrases(t *testing.T) {
	cat := Table{"x.do": {"busy_now", "too_big"}}
	full := `'why.loading': 'a', 'why.busy_now': 'b', 'why.too_big': 'c',`
	cases := []struct {
		name   string
		ko, en string
		want   []string
	}{
		{"다 있음", full, full, nil},
		{"en 에 하나 빠짐", full, `'why.loading': 'a', 'why.busy_now': 'b',`, []string{"en: why.too_big"}},
		{"ko 에 loading 빠짐", `'why.busy_now': 'b', 'why.too_big': 'c',`, full, []string{"ko: why.loading"}},
		{"접두만 같은 키는 없음으로 본다", `'why.loading_x': 'a', 'why.busy_now': 'b', 'why.too_big': 'c',`, full,
			[]string{"ko: why.loading"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := MissingPhrases(cat, map[string]string{"ko": c.ko, "en": c.en})
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("missing = %v, want %v", got, c.want)
			}
		})
	}
}
