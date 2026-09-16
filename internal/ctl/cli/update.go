package cli

import (
	"fmt"
	"io"

	"dongminal/internal/shared/release"
)

// `dongminal update --check` — 사람이 직접 묻는 자리다.
//
// **자동 확인은 이제 서버가 한다** (UPDATE_NOTICE_SRS). 종전에 이 명령이 졌던
// 원칙("묻지 않으면 나가지 않는다")은 옵트아웃으로 바뀌었다 — 끌 수 있고, 끈
// 것이 실제로 멎으며, 처음 한 번은 그 사실을 고지한다. 이 명령이 남는 이유는
// 따로다: **사람이 직접 친 것은 언제나 사용자의 의사**이므로, 자동 확인을 꺼
// 두었어도 여기서는 즉시 확인할 수 있어야 한다 (FR-UPD-17).
//
// 내려받지 않는 판단은 그대로다 (D-UPD-5). 설치 형태가 여럿이라(직접 빌드 ·
// 릴리스 산출물 · 앞으로 패키지 매니저) 스스로 자기 바이너리를 덮으면 그중
// 어느 형태에서는 패키지 관리자와 싸운다. **무엇을 받을지 알려 주고 거기서 멈춘다.**

// UpdateOpts 는 `dongminal update` 의 옵션이다.
type UpdateOpts struct {
	Check bool
	// endpoint 는 검사가 바꿔 끼우는 자리다. 비면 기본값이다.
	endpoint string
}

// ParseUpdate 는 `update [--check]` 다.
func ParseUpdate(args []string) (UpdateOpts, error) {
	var o UpdateOpts
	for _, a := range args {
		switch a {
		case "-h", "--help":
			return UpdateOpts{}, ErrHelp
		case "--check":
			o.Check = true
		default:
			return UpdateOpts{}, unknownFlag("update", a)
		}
	}
	return o, nil
}

// RunUpdate 는 `dongminal update` 다.
func RunUpdate(o UpdateOpts, stdout, stderr io.Writer) int {
	return runUpdateWith(o, Version, stdout, stderr)
}

// runUpdateWith 는 판을 인자로 받는다 — 검사가 `dev` 갈래까지 밟기 위해서다.
func runUpdateWith(o UpdateOpts, cur string, stdout, stderr io.Writer) int {
	if !o.Check {
		fmt.Fprintln(stdout, "지금 확인하려면: dongminal update --check")
		fmt.Fprintln(stdout, "  (확인만 합니다 — 내려받거나 덮어쓰지 않습니다.)")
		fmt.Fprintln(stdout, "서버의 자동 확인은 설정 화면에서 켜고 끕니다.")
		return 0
	}
	latest, link, err := release.Latest(o.endpoint)
	if err != nil {
		fmt.Fprintf(stderr, "최신 판을 확인하지 못했습니다: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "지금 판: %s\n최신 판: %s\n", cur, latest)

	if !release.Comparable(cur) {
		// 견줄 기준이 없다. 이것을 "뒤졌다" 로 말하면 거짓이다.
		fmt.Fprintln(stdout, "\n개발 빌드입니다 — 릴리스 판과 견줄 기준이 없습니다.")
		if link != "" {
			fmt.Fprintf(stdout, "최신 릴리스: %s\n", link)
		}
		return 0
	}
	if release.Newer(latest, cur) {
		fmt.Fprintln(stdout, "\n새 판이 있습니다.")
		if link != "" {
			fmt.Fprintf(stdout, "  %s\n", link)
		}
		fmt.Fprintln(stdout, "  내려받은 뒤 dongminal stop --all 하고 바꿔 넣으세요.")
		fmt.Fprintln(stdout, "  바꾸기 전에: dongminal backup --out <파일.zip>")
		return 0
	}
	fmt.Fprintln(stdout, "\n최신입니다.")
	return 0
}
