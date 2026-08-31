// Package dmenv 는 dongminal 프로세스들이 공유하는 실행 환경 계약이다 — 서버가
// 자식 프로세스(도구 셸·dmctl)에 심는 환경변수 **이름**과, 그 변수가 비었을 때의
// 기본 엔드포인트.
//
// 이름과 기본값이 여기 있는 이유는 **쓰는 쪽이 서로를 import 할 수 없기**
// 때문이다. internal/ctl/cli 가 internal/helper/runtimebin 과
// internal/shared/toolhub 를 import 하므로, 그 둘은 ctl/cli 를 되받아 import 할
// 수 없다. 의존이 하나도 없는 이 패키지가 셋이 함께 딛을 수 있는 유일한 자리다.
//
// 값을 복제하면 한쪽만 바뀐다 — 포트를 옮겼는데 dmctl 이 옛 포트로 붙거나, 심는
// 이름과 읽는 이름이 갈라지면 도구가 자기 자신을 식별하지 못한다.
package dmenv

const (
	// EnvToolID 는 도구의 셸에 심기는 도구 식별자다 (toolhub.StartTool 이
	// 심고, dmctl 이 읽어 자신이 어느 도구 안인지 안다).
	EnvToolID = "DONGMINAL_TOOL_ID"

	// EnvHome 은 인스턴스의 홈이다. serve 가 심고 helper 가 읽는다.
	EnvHome = "DONGMINAL_HOME"

	// EnvToolHome 은 도구 셸에 심을 HOME 을 덮어쓴다. 비면 사용자 홈이다.
	//
	// 도구 셸은 로그인 셸이라 사용자의 rc 를 읽고 히스토리 파일을 쓴다. 검사가
	// 그 셸에 명령을 주입하면 그 명령이 **사용자의 히스토리에 남는다** — 새 탭의
	// 위 화살표에 검사용 프로브가 떠오른 것이 그 결과다. 이 변수가 검사·격리
	// 기동에서 도구 셸을 사용자 홈에서 떼어내는 자리다.
	//
	// EnvHome 으로는 대신할 수 없다. 그쪽은 인스턴스의 자산(bin·데이터)이 있는
	// 곳이고, 이쪽은 셸이 자기 홈으로 여길 곳이다 — 검사는 앞의 것만 격리하고
	// 뒤의 것을 사용자 홈에 둔 채였다.
	EnvToolHome = "DONGMINAL_TOOL_HOME"

	// EnvHost·EnvPort 는 서버가 자식에게 알려 주는 자기 주소다. dmctl 은 이
	// 값으로 서버에 되붙는다.
	EnvHost = "DONGMINAL_HOST"
	EnvPort = "DONGMINAL_PORT"

	// DefaultHomeDir 은 EnvHome 이 비었을 때 사용자 홈 아래에 잡는 이름이다.
	// cli 의 기본값 계산과 데몬 진입점이 같은 값을 딛어야 한다 — 갈라지면 한쪽이
	// 다른 인스턴스를 본다.
	DefaultHomeDir = ".dongminal"

	// DefaultHost·DefaultPort 는 위 변수가 비었을 때만 쓰이는 안전망이다.
	// 정상 경로에서는 서버가 항상 주입한다.
	DefaultHost = "127.0.0.1"
	DefaultPort = "58146"
)
