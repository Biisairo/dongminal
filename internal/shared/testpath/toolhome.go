package testpath

import (
	"os"

	"dongminal/internal/shared/dmenv"
)

// IsolateToolHome 은 이 테스트 바이너리가 띄우는 **도구 셸**의 홈을 임시
// 디렉터리로 돌린다. 돌려주는 함수는 그 자리를 되돌리고 지운다.
//
// 왜 필요한가: 도구 셸은 로그인 셸이다. 사용자의 rc 를 읽고 히스토리 파일을
// 쓴다. 검사가 그 셸에 명령을 주입하면 그 명령이 사용자의 히스토리에 남는다 —
// `echo reconnect_test`·`concurrency_probe` 가 실제로 사용자의 `.zsh_history`
// 를 채웠고, SAVEHIST 한도 안에서 진짜 히스토리를 밀어냈다.
//
// 왜 TestMain 인가: 셸을 띄우는 검사는 한 패키지 안에 흩어져 있고 앞으로 는다.
// 검사마다 격리를 심으면 하나 빠뜨리는 순간 오염이 돌아온다. 바이너리 전체에
// 한 번 거는 것이 빠뜨릴 수 없는 자리다.
//
// DONGMINAL_HOME 격리로는 대신할 수 없다 — 그것은 인스턴스 자산의 자리이고,
// 도구 셸의 HOME 은 별개로 사용자 홈을 가리키고 있었다.
func IsolateToolHome() func() {
	dir, err := os.MkdirTemp("", "dongminal-toolhome-")
	if err != nil {
		// 임시 자리를 못 얻으면 격리를 포기하는 대신 검사를 세운다 — 조용히
		// 사용자 홈으로 흘러드는 것이 이 함수가 막으려는 바로 그 일이다.
		panic("도구 홈 격리용 임시 디렉터리를 만들지 못했습니다: " + err.Error())
	}
	prev, had := os.LookupEnv(dmenv.EnvToolHome)
	os.Setenv(dmenv.EnvToolHome, dir)
	return func() {
		if had {
			os.Setenv(dmenv.EnvToolHome, prev)
		} else {
			os.Unsetenv(dmenv.EnvToolHome)
		}
		os.RemoveAll(dir)
	}
}
