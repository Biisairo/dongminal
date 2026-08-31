package apierr

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"testing"
)

// tables는 표면별 정책 테이블 전부다. 새 표면이 생기면 여기에 더한다 — 더하지
// 않으면 전수성 검사가 그 표면을 보지 못한다.
var tables = map[string]Table{"Git": Git, "Runs": Runs, "FS": FS}

// V4: 인벤토리의 모든 sentinel 이 어느 테이블에든 규칙을 갖거나, 사유와 함께
// 면제돼야 한다. **빠뜨림이 침묵으로 지나가는 경로를 없앤다.**
func TestEverySentinelIsMappedOrExempt(t *testing.T) {
	mapped := map[error]bool{}
	for _, tb := range tables {
		for _, e := range tb.Sentinels() {
			mapped[e] = true
		}
	}
	exempt := map[error]bool{}
	for _, x := range Unmapped {
		exempt[x.Err] = true
	}
	for _, s := range Inventory {
		if mapped[s] {
			if exempt[s] {
				t.Errorf("%q 가 매핑과 면제에 **동시에** 있다 — 둘 중 하나만이어야 한다", s)
			}
			continue
		}
		if !exempt[s] {
			t.Errorf("sentinel %q 에 규칙도 면제 사유도 없다.\n"+
				"  테이블에 규칙을 주거나 Unmapped 에 사유를 적어라 (FR-DPN-8)", s)
		}
	}
}

// V5: 테이블의 모든 규칙이 인벤토리에 있어야 한다. 지워진 sentinel 의 규칙이
// 남아 있으면 아무도 그것을 모른다.
func TestEveryRuleIsInInventory(t *testing.T) {
	known := map[error]bool{}
	for _, s := range Inventory {
		known[s] = true
	}
	// io/fs 의 표준 sentinel 은 domain 이 아니므로 인벤토리 대상이 아니다.
	stdlib := map[error]bool{fs.ErrNotExist: true, fs.ErrExist: true, fs.ErrPermission: true}

	for name, tb := range tables {
		for _, r := range tb {
			if known[r.Err] || stdlib[r.Err] {
				continue
			}
			t.Errorf("%s 테이블의 규칙 %q 가 Inventory 에 없다 — 지워진 sentinel 인가?",
				name, r.Err)
		}
	}
}

// V5b: 한 테이블 안에서 같은 sentinel 이 두 번 나오면 뒤쪽은 영원히 죽은 규칙이다.
func TestNoDuplicateRuleWithinTable(t *testing.T) {
	for name, tb := range tables {
		seen := map[error]int{}
		for i, r := range tb {
			if j, dup := seen[r.Err]; dup {
				t.Errorf("%s 테이블: %q 가 %d 번째와 %d 번째에 중복 — 뒤쪽은 도달하지 않는다",
					name, r.Err, j, i)
				continue
			}
			seen[r.Err] = i
		}
	}
}

// V6: 같은 와이어 문자열이 두 이름으로 선언되면 실패한다. 코드 어휘의 단일
// 소유를 강제하는 검사다 (FR-DPN-3).
func TestNoDuplicateCodeValue(t *testing.T) {
	// codes.go 의 상수 전부. 새 코드를 더하면 여기에도 더한다.
	all := map[string][]string{}
	add := func(name, val string) { all[val] = append(all[val], name) }

	add("CodeBadRequest", CodeBadRequest)
	add("CodeNotFound", CodeNotFound)
	add("CodeNotRepo", CodeNotRepo)
	add("CodeRepoMissing", CodeRepoMissing)
	add("CodeGitMissing", CodeGitMissing)
	add("CodeTimeout", CodeTimeout)
	add("CodeCanceled", CodeCanceled)
	add("CodeUnavailable", CodeUnavailable)
	add("CodeFailed", CodeFailed)
	add("CodeRefName", CodeRefName)
	add("CodeBranchExists", CodeBranchExists)
	add("CodeBranchNotMerged", CodeBranchNotMerged)
	add("CodeBranchCurrent", CodeBranchCurrent)
	add("CodeTagExists", CodeTagExists)
	add("CodeMergeParent", CodeMergeParent)
	add("CodeResetMode", CodeResetMode)
	add("CodeNoRemote", CodeNoRemote)
	add("CodeRemoteExists", CodeRemoteExists)
	add("CodeRemoteMissing", CodeRemoteMissing)
	add("CodePublishRequired", CodePublishRequired)
	add("CodeSyncNotFound", CodeSyncNotFound)
	add("CodeJobBusy", CodeJobBusy)
	add("CodeJobNotFound", CodeJobNotFound)
	add("CodeNothingToStash", CodeNothingToStash)
	add("CodeStashKept", CodeStashKept)
	add("CodeStaleObservation", CodeStaleObservation)
	add("CodePatchEmpty", CodePatchEmpty)
	add("CodeOperationMismatch", CodeOperationMismatch)
	add("CodeNoOperation", CodeNoOperation)
	add("CodeNoHead", CodeNoHead)
	add("CodeNothingToClean", CodeNothingToClean)
	add("CodeConfirmRequired", CodeConfirmRequired)
	add("CodePreflightBlocked", CodePreflightBlocked)
	add("CodeUndoExpired", CodeUndoExpired)
	add("CodeEmptyMessage", CodeEmptyMessage)
	add("CodeNothingStaged", CodeNothingStaged)
	add("CodeRecordMissing", CodeRecordMissing)
	add("CodeNotText", CodeNotText)
	add("CodeIgnorePath", CodeIgnorePath)
	add("CodeWorktreeExists", CodeWorktreeExists)
	add("CodeExists", CodeExists)
	add("CodeOutsideRoot", CodeOutsideRoot)
	add("CodePermission", CodePermission)
	add("CodeIO", CodeIO)
	add("CodeTooLarge", CodeTooLarge)
	add("CodeFSNotRepo", CodeFSNotRepo)

	for val, names := range all {
		if len(names) > 1 {
			t.Errorf("와이어 코드 %q 가 이름 %v 로 중복 선언됐다 — 상수 하나를 공유하라",
				val, names)
		}
	}
}

// 와이어 코드는 클라이언트가 파싱하는 식별자다. 공백·대문자가 섞이면 그것이
// 사람이 읽을 문구인지 식별자인지 갈리지 않는다.
func TestCodesAreIdentifiers(t *testing.T) {
	for _, tb := range tables {
		for _, r := range tb {
			if r.Code == "" {
				t.Errorf("%q 의 코드가 비었다", r.Err)
			}
			if strings.TrimSpace(r.Code) != r.Code || strings.ContainsAny(r.Code, " \t\n") {
				t.Errorf("코드 %q (%v) 에 공백이 있다", r.Code, r.Err)
			}
			if r.Code != strings.ToLower(r.Code) {
				t.Errorf("코드 %q (%v) 에 대문자가 있다", r.Code, r.Err)
			}
		}
	}
}

// 상태 코드가 실제 HTTP 코드여야 한다. 499 는 nginx 관례라 표준 범위 밖이 아니다.
func TestStatusesArePlausible(t *testing.T) {
	for name, tb := range tables {
		for _, r := range tb {
			if r.Status < 400 || r.Status > 599 {
				t.Errorf("%s: %q 의 상태 %d 가 오류 범위 밖이다", name, r.Err, r.Status)
			}
		}
	}
}

// Lookup 은 감싼 오류를 찾아야 한다 — 실제 코드는 언제나 감싸서 돌려준다.
func TestLookupUnwraps(t *testing.T) {
	base := errors.New("bottom")
	tb := Table{{base, http.StatusTeapot, "teapot"}}

	wrapped := fmt.Errorf("겉: %w", fmt.Errorf("속: %w", base))
	status, code, ok := tb.Lookup(wrapped)
	if !ok || status != http.StatusTeapot || code != "teapot" {
		t.Fatalf("두 겹 감싼 오류를 못 찾았다: %d %q %v", status, code, ok)
	}

	if _, _, ok := tb.Lookup(errors.New("남")); ok {
		t.Fatal("모르는 오류에 ok=true 를 냈다")
	}
}

// Lookup 은 기본값을 정하지 않는다 (FR-DPN-2) — 미분류 실패의 코드가 표면마다
// 다르므로, 등록부가 대신 고르면 그중 하나가 틀린다.
func TestLookupPicksNoDefault(t *testing.T) {
	status, code, ok := Git.Lookup(errors.New("분류되지 않은 실패"))
	if ok || status != 0 || code != "" {
		t.Fatalf("미분류 실패에 기본값을 냈다: %d %q %v", status, code, ok)
	}
}

// 첫 일치가 이긴다 — errors.Join 으로 두 sentinel 이 함께 오는 자리
// (write/stash.go:226) 의 판정을 순서가 결정한다.
func TestLookupFirstMatchWins(t *testing.T) {
	a, b := errors.New("a"), errors.New("b")
	tb := Table{{a, 400, "a"}, {b, 409, "b"}}
	joined := errors.Join(b, a)
	if _, code, _ := tb.Lookup(joined); code != "a" {
		t.Fatalf("첫 규칙이 이기지 않았다: %q", code)
	}
}

// FSStatus 는 fs 표면의 코드→상태다. 표에 없는 코드는 500 이다.
func TestFSStatus(t *testing.T) {
	want := map[string]int{
		CodeBadRequest:  http.StatusBadRequest,
		CodeNotFound:    http.StatusNotFound,
		CodeExists:      http.StatusConflict,
		CodeOutsideRoot: http.StatusForbidden,
		CodePermission:  http.StatusForbidden,
		CodeFSNotRepo:   http.StatusNotFound,
		CodeIO:          http.StatusInternalServerError,
		"모르는 코드":        http.StatusInternalServerError,
	}
	for code, w := range want {
		if got := FSStatus(code); got != w {
			t.Errorf("FSStatus(%q) = %d, want %d", code, got, w)
		}
	}
}

// 면제 사유는 비어 있으면 안 된다 — 사유 없는 면제는 그냥 빠뜨림이다.
func TestExemptionsHaveReasons(t *testing.T) {
	for _, x := range Unmapped {
		if strings.TrimSpace(x.Reason) == "" {
			t.Errorf("%q 의 면제 사유가 비었다", x.Err)
		}
	}
}

// 인벤토리에 같은 sentinel 이 두 번 들어가면 전수성 계산이 흐려진다.
func TestInventoryHasNoDuplicates(t *testing.T) {
	seen := map[error]bool{}
	for _, s := range Inventory {
		if seen[s] {
			t.Errorf("Inventory 에 %q 가 중복", s)
		}
		seen[s] = true
	}
}
