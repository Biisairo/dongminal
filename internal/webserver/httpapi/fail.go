package httpapi

import (
	"dongminal/internal/shared/dmlog"
	"errors"
	"net/http"

	"dongminal/internal/webserver/httpreq"
)

// 오류를 응답으로 옮기는 한 자리 (04-secops `SEC-17` · 01-go-arch `GO-11`).
//
// **오류 문구는 두 종류다.** 사용자가 방금 보낸 것에 대해 우리가 쓴 말과, 아래
// 계층이 자기 사정으로 만든 말. 뒤엣것에는 절대경로·명령줄·git 인자·내부 상태가
// 들어 있고, 그것이 응답 본문으로 나가면 곧 정찰 정보다. 종전에는 아홉 자리가
// 오류의 전문을 그 구분 없이 응답 본문에 그대로 실었다.
//
// **가르는 기준은 상태 코드가 아니라 누가 그 말을 썼는가다.** 400 이라고 안전한
// 것이 아니다 — 파일을 여는 400 은 경로를 담는다. 반대로 500 이어도 우리가 쓴
// 문구면 보여도 된다.
//
// 그래서 판정을 호출자에게 둔다. 호출자가 "이 오류는 사용자에게 할 말이다" 라고
// 판정했으면 그 문구를 `msg` 로 넘기고 `err` 를 nil 로 둔다. 판정하지 못했으면
// 자기가 쓴 문구를 `msg` 로 주고 오류를 `err` 로 넘긴다 — 그때 전문은 **로그로만**
// 간다.

// fail 은 상태 코드와 사용자에게 보일 문구로 응답한다. `err` 가 있으면 그것은
// 로그로 가고 본문에는 실리지 않는다.
func fail(w http.ResponseWriter, code int, msg string, err error) {
	if err != nil {
		dmlog.Infof(nil, "응답 %d (%s): %v", code, msg, err)
	}
	// ERROR_CONTRACT_SRS FR-ERR-1: 코드는 **상태에서 파생한다.**
	//
	// 이 함수의 호출자들은 상태만 들고 있고, 그것이 이 이음매의 설계다 —
	// 판정(무엇을 보일지)은 호출자에게 있고 모양은 여기 있다. 더 좁은 코드가
	// 필요한 자리는 `httpErr` 을 직접 부르면 된다.
	httpErr(w, msg, code, "")
}

// failRead 는 `httpreq.Read` 의 실패를 옮긴다.
//
// 상한 초과는 사용자가 고칠 수 있는 것이므로 사유가 보인다. 그 밖의 읽기 실패는
// 연결의 사정이며 사용자가 할 수 있는 일이 없다 — 감춘다.
func failRead(w http.ResponseWriter, err error) {
	if errors.Is(err, httpreq.ErrTooLarge) {
		fail(w, http.StatusRequestEntityTooLarge, httpreq.ErrTooLarge.Error(), nil)
		return
	}
	fail(w, httpreq.Status(err), "본문을 읽지 못했습니다", err)
}
