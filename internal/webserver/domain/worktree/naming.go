package worktree

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
)

// RepoBucket 은 사용자 worktree 영역의 저장소별 버킷 이름이다 (FR-WKT-13, V159):
//
//	<베이스이름>-<정규화된 루트의 해시 앞자리>
//
// 베이스이름을 남기는 이유는 FR-GIT-242 가 "만들어진 경로를 보인다"고 요구하기
// 때문이다 — 해시만 쓰면 사람이 그 경로가 어느 저장소인지 알 수 없다. 해시를
// 더하는 이유는 베이스이름만으로는 서로 다른 저장소(동명의 리포)를 가르지 못하기
// 때문이다 — Run 영역이 uuid 파생으로 경로를 절대 재사용하지 않는 것과 같은
// 이유다(FR-WKT-4). safeSegment 를 그대로 쓴다 — 새 정규화 규칙을 만들지 않는다.
func RepoBucket(root string) string {
	clean := filepath.Clean(root)
	sum := sha256.Sum256([]byte(clean))
	return safeSegment(filepath.Base(clean), "repo") + "-" + hex.EncodeToString(sum[:])[:8]
}

// Path 는 worktree 경로를 식별자에서 파생한다 (FR-WKT-3).
//
//	$DONGMINAL_HOME/worktrees/<run.short>/<member.short>
//
// **경로를 재사용하지 않는다** (FR-WKT-4). uuid 파생이 이를 자동으로 보장한다 —
// 에이전트 CLI 는 대화 이력을 cwd 로 키잉하므로, 지워진 worktree 의 경로를 다시
// 쓰면 새 멤버가 남의 이력을 물려받는다.
func (m *Manager) Path(runShort, leaf string) string {
	return filepath.Join(m.root, safeSegment(runShort, "run"), safeSegment(leaf, "member"))
}

// Branch 는 브랜치 이름을 파생한다 (FR-WKT-3): dmn/<run.short>/<role>.
// role 을 ASCII 로 환원할 수 없으면(한글 역할명 등) fallback 으로 떨어진다.
func Branch(runShort, role, fallback string) string {
	name := slug(role)
	if name == "" {
		name = slug(fallback)
	}
	if name == "" {
		name = "member"
	}
	return "dmn/" + safeSegment(runShort, "run") + "/" + name
}

func safeSegment(s, fallback string) string {
	if out := slug(s); out != "" {
		return out
	}
	return fallback
}

// slug 는 경로·ref 에 안전한 ASCII 만 남긴다. 앞의 - 를 떼는 것이 FR-WKT-6 과
// 같은 이유이며(git 플래그 오인), 빈 문자열은 호출자가 대체한다.
func slug(s string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_':
			b.WriteRune(r)
			prevDash = false
		case r == '-' && b.Len() > 0 && !prevDash:
			b.WriteRune('-')
			prevDash = true
		default:
			if b.Len() > 0 && !prevDash {
				b.WriteRune('-')
				prevDash = true
			}
		}
	}
	out := strings.Trim(b.String(), "-.")
	if len(out) > 40 {
		out = strings.Trim(out[:40], "-.")
	}
	return out
}

// validRef 는 브랜치·base 인자를 검사한다 (FR-WKT-6). - 로 시작하는 값이 git
// 플래그로 오인되는 것이 이 검사의 출발점이다.
func validRef(name string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("%w: 빈 ref", ErrUnsafeArgument)
	}
	if strings.HasPrefix(name, "-") {
		return fmt.Errorf("%w: - 로 시작하는 ref 는 git 플래그로 오인된다: %q", ErrUnsafeArgument, name)
	}
	if strings.Contains(name, "..") || strings.HasSuffix(name, ".lock") {
		return fmt.Errorf("%w: 잘못된 ref: %q", ErrUnsafeArgument, name)
	}
	if strings.HasPrefix(name, "/") || strings.HasSuffix(name, "/") || strings.Contains(name, "//") {
		return fmt.Errorf("%w: 잘못된 ref: %q", ErrUnsafeArgument, name)
	}
	for _, r := range name {
		if r <= ' ' || r == 0x7f || strings.ContainsRune("~^:?*[\\\"'`$;|&<>", r) {
			return fmt.Errorf("%w: ref 에 쓸 수 없는 문자: %q", ErrUnsafeArgument, name)
		}
	}
	return nil
}

// CheckName 은 사용자 worktree 의 이름·브랜치를 검사한다 (FR-GIT-242) — "-" 로
// 시작하는 값을 거부하는 것은 FR-WKT-6 과 같은 근거(git 플래그 오인)다. validRef
// 를 그대로 드러낸다 — 이름·ref·브랜치가 결국 같은 git 인자 자리로 가므로 규칙을
// 두 벌 두지 않는다.
func CheckName(name string) error { return validRef(name) }
