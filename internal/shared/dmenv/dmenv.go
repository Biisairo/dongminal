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

	// EnvHost·EnvPort 는 서버가 자식에게 알려 주는 자기 주소다. dmctl 은 이
	// 값으로 서버에 되붙는다.
	EnvHost = "DONGMINAL_HOST"
	EnvPort = "DONGMINAL_PORT"

	// DefaultHost·DefaultPort 는 위 변수가 비었을 때만 쓰이는 안전망이다.
	// 정상 경로에서는 서버가 항상 주입한다.
	DefaultHost = "127.0.0.1"
	DefaultPort = "58146"
)
