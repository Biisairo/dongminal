package cli

import (
	"fmt"
	"io"

	"dongminal/internal/shared/serverconf"
	"dongminal/internal/shared/updatecheck"
)

// announceUpdateCheck 는 **기본 켜짐을 정직하게 만드는 한 줄**이다
// (UPDATE_NOTICE_SRS FR-UPD-10).
//
// 종전 원칙은 "묻지 않으면 나가지 않는다" 였고 이제 옵트아웃이다(§2.2). 그
// 거래가 성립하려면 세 가지가 필요하다 — 끌 수 있을 것, 끈 것이 실제로 멎을 것,
// 그리고 **처음 한 번은 말할 것**. 이것이 셋째다. 몰래 나가면 기본 켜짐은
// 편의가 아니라 배신이 된다.
//
// **표식을 따로 두지 않는다** (D-UPD-6). `server.json` 에 `updateCheck` 키가
// 적혀 있다는 것이 곧 "이미 알렸다" 이다 — 별도 파일을 두면 그 둘이 어긋날 수
// 있고, 어긋났을 때 어느 쪽이 진실인지 말할 수 없다.
//
// 매번 띄우면 소음이 되어 읽히지 않고, 한 번도 안 띄우면 몰래 나간 것이 된다.
func announceUpdateCheck(home string, getenv func(string) string, stdout io.Writer) {
	if home == "" {
		return
	}
	if getenv != nil && getenv(updatecheck.EnvNoCheck) == "1" {
		// 이미 막혀 있다. 하지도 않을 일을 알리는 것은 거짓이다.
		return
	}
	conf := serverconf.Resolve(serverconf.Inputs{Home: home, Getenv: getenv})
	if conf.UpdateCheckSet {
		return
	}
	// 먼저 적고 나서 알린다. 적지 못하면 알리지 않는다 — 알렸다는 사실이
	// 남지 않으면 다음 기동이 또 알리고, 그때부터 이 줄은 소음이다.
	if err := serverconf.SetUpdateCheck(home, serverconf.DefaultUpdateCheck); err != nil {
		return
	}
	fmt.Fprintln(stdout, "ℹ️  새 판이 나오면 화면에 알려 드립니다 — 서버가 GitHub 릴리스를 하루 한 번 확인합니다.")
	fmt.Fprintln(stdout, "   끄려면: 설정 ▸ 업데이트 알림 (또는 server.json 의 updateCheck 를 false 로)")
}
